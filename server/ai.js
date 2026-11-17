// Optional local-AI features, via any OpenAI-compatible endpoint (Ollama, LM Studio, llama.cpp, vLLM, ...).
//   1. Double-check receipt entry: the model BLIND-reads the receipt (it never sees what you typed) and this
//      code compares its reading with your entry. The model only reads; arithmetic and matching are plain code.
//   2. Smart search: turns a sentence ("the fridge from Home Depot last year") into the filters the UI already has.
// Everything runs against the server you configure; nothing is sent anywhere else.
import fs from 'node:fs';
import { db, getSetting, setSetting } from './db.js';
import { err, wrap, str, imageFile } from './http.js';
import { photosOf } from './photos.js';
import { requireAdmin } from './auth.js';
import { calcTax, PROVINCES, ITEM_CATEGORIES, RECEIPT_CATEGORIES } from './tax.js';
import { total } from './util.js';

export const aiConfig = () => ({
  enabled: getSetting('ai.enabled', '0') === '1',
  base_url: getSetting('ai.base_url', 'http://localhost:11434/v1'),
  model: getSetting('ai.model', ''),
  api_key: getSetting('ai.api_key', ''),            // never sent to the browser
  vision: getSetting('ai.vision', '0') === '1',      // can the model look at the photo itself?
  auto_check: getSetting('ai.auto_check', '1') === '1',
  timeout_s: Number(getSetting('ai.timeout_s', '120')),
});
export const aiReady = () => { const c = aiConfig(); return c.enabled && !!c.base_url && !!c.model; };

// ---------------------------------------------------------------- talking to the model
export async function chat(messages, { maxTokens = 700, timeoutMs } = {}) {
  const c = aiConfig();
  const url = c.base_url.replace(/\/+$/, '') + '/chat/completions';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs ?? c.timeout_s * 1000);
  try {
    const res = await fetch(url, {
      method: 'POST', signal: ctrl.signal,
      headers: { 'content-type': 'application/json', ...(c.api_key ? { authorization: `Bearer ${c.api_key}` } : {}) },
      body: JSON.stringify({ model: c.model, messages, temperature: 0, max_tokens: maxTokens, stream: false }),
    });
    if (!res.ok) throw new Error(`AI server answered ${res.status}: ${(await res.text()).slice(0, 160)}`);
    const data = await res.json();
    return data.choices?.[0]?.message?.content ?? '';
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`AI server did not answer within ${Math.round((timeoutMs ?? c.timeout_s * 1000) / 1000)}s`);
    if (e instanceof TypeError) throw new Error(`Can't reach the AI server at ${c.base_url} (${e.cause?.code || e.message})`);
    throw e;
  } finally { clearTimeout(timer); }
}

/** Pull the JSON object out of a reply that may include prose, code fences or <think> blocks. */
export function extractJson(text) {
  const t = String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/```(?:json)?/gi, '');
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b < a) throw new Error('the AI did not return JSON');
  try { return JSON.parse(t.slice(a, b + 1)); } catch { throw new Error('the AI returned malformed JSON'); }
}

const dollarsToCents = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) && n >= 0 && n < 1e7 ? Math.round(n * 100) : null;
};
const cents$ = (c) => '$' + (c / 100).toFixed(2);

// ---------------------------------------------------------------- 1. receipt check
const READ_SYSTEM = 'You are a careful bookkeeping assistant that reads store receipts. Reply with ONLY a JSON object, no other text.';
const READ_PROMPT = `Read this receipt and return a JSON object with exactly these keys:
"vendor" (store name), "date" (purchase date as YYYY-MM-DD, or null), "subtotal" (before tax), "gst_hst" (GST or HST amount, or null),
"pst_qst" (PST, RST or QST amount, or null), "tip" (or null), "total" (final amount charged), "notes" (one short sentence about anything unusual, or "").
Amounts are plain numbers in dollars, e.g. 12.5. Use null for anything not printed on the receipt. Never guess or calculate missing values.`;

export function normalizeRead(o) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(o.date ?? '')) && !Number.isNaN(Date.parse(o.date)) ? o.date : null;
  return {
    vendor: str(o.vendor, 120), date,
    subtotal: dollarsToCents(o.subtotal), gst: dollarsToCents(o.gst_hst ?? o.gst), pst: dollarsToCents(o.pst_qst ?? o.pst),
    tip: dollarsToCents(o.tip), total: dollarsToCents(o.total), notes: str(o.notes, 300),
  };
}

async function readReceipt(r) {
  const cfg = aiConfig();
  const files = photosOf('receipt', r.id).map((p) => imageFile(p.file)).filter(Boolean).slice(0, 4);   // all pages of a multi-photo receipt
  let mode, content;
  if (cfg.vision && files.length) {
    mode = 'image';
    const parts = files.map((f) => {
      const bytes = fs.readFileSync(f), mime = bytes[0] === 0x89 ? 'image/png' : 'image/jpeg';
      return { type: 'image_url', image_url: { url: `data:${mime};base64,${bytes.toString('base64')}` } };
    });
    content = [{ type: 'text', text: READ_PROMPT + (files.length > 1 ? `\nThe receipt is shown as ${files.length} photos, in order; read them together as one receipt.` : '') }, ...parts];
  } else if (r.ocr_text) {
    mode = 'text';
    content = `${READ_PROMPT}\n\nReceipt text (read by OCR, so it may contain mistakes):\n"""\n${r.ocr_text.slice(0, 6000)}\n"""`;
  } else {
    throw new Error(files.length
      ? 'No receipt text to check. Turn on “model can read images” in the AI settings, or keep automatic receipt reading on when adding photos.'
      : 'This receipt has no photo or text to check.');
  }
  const reply = await chat([{ role: 'system', content: READ_SYSTEM }, { role: 'user', content }], { maxTokens: 600 });
  return { mode, read: normalizeRead(extractJson(reply)) };
}

const words = (s) => String(s).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length >= 2);

/** Compare the model's blind reading with what was entered. Pure + deterministic. */
export function compareReceipt(r, read) {
  const issues = [];
  const near = (a, b) => Math.abs(a - b) <= 2; // 2 cents of slack for rounding
  const amount = (field, label, entered, seen) => {
    if (seen === null || near(entered, seen)) return;
    issues.push({ field, label, severity: 'warn', source: 'ai', entered: cents$(entered), read: cents$(seen), value: field === 'total' ? null : seen,
      message: entered === 0 ? `${label} wasn't entered but the receipt shows ${cents$(seen)}` : `${label}: you entered ${cents$(entered)}, the receipt looks like ${cents$(seen)}` });
  };
  amount('subtotal', 'Subtotal', r.subtotal, read.subtotal);
  amount('gst', 'GST/HST', r.gst, read.gst);
  amount('pst', 'PST/QST', r.pst, read.pst);
  amount('tip', 'Tip', r.tip, read.tip);
  amount('total', 'Total', total(r), read.total);

  if (read.date && read.date !== r.date) {
    const [y, m, d] = read.date.split('-'), swapped = `${y}-${d}-${m}`;
    issues.push({ field: 'date', label: 'Date', severity: 'warn', source: 'ai', entered: r.date, read: read.date, value: read.date,
      message: `Date: you entered ${r.date}, the receipt looks like ${read.date}${swapped === r.date ? ' (day and month may be swapped)' : ''}` });
  }
  if (read.vendor && r.vendor) {
    const a = words(read.vendor), b = words(r.vendor);
    const overlap = a.filter((w) => b.includes(w)).length / Math.max(1, Math.min(a.length, b.length));
    const contains = r.vendor.toLowerCase().includes(read.vendor.toLowerCase()) || read.vendor.toLowerCase().includes(r.vendor.toLowerCase());
    if (a.length && b.length && overlap < 0.5 && !contains) {
      issues.push({ field: 'vendor', label: 'Vendor', severity: 'info', source: 'ai', entered: r.vendor, read: read.vendor, value: read.vendor,
        message: `Vendor: you entered “${r.vendor}”, the receipt looks like “${read.vendor}”` });
    }
  }
  return issues;
}

/** Cheap sanity checks that need no AI. */
export function rulesCheck(r, today = new Date().toISOString().slice(0, 10)) {
  const issues = [];
  const add = (severity, field, message) => issues.push({ field, label: field, severity, source: 'rules', message });
  if (r.date > today) add('warn', 'date', `The date ${r.date} is in the future`);
  else if (r.date < new Date(Date.now() - 3 * 365 * 864e5).toISOString().slice(0, 10)) add('info', 'date', `The date ${r.date} is more than 3 years ago`);
  if (total(r) === 0) add('warn', 'total', 'No amounts were entered');
  if (!r.tax_auto && r.subtotal > 0) {
    const exp = calcTax(r.subtotal, r.province), name = PROVINCES[r.province]?.name || r.province;
    if (r.gst > 0 && Math.abs(r.gst - exp.gst) > Math.max(6, exp.gst * 0.02)) add('info', 'gst', `GST/HST ${cents$(r.gst)} differs from the standard ${cents$(exp.gst)} for ${name} (fine if some items are exempt)`);
    if (r.pst > 0 && exp.pst && Math.abs(r.pst - exp.pst) > Math.max(6, exp.pst * 0.02)) add('info', 'pst', `PST/QST ${cents$(r.pst)} differs from the standard ${cents$(exp.pst)} for ${name} (fine if some items are exempt)`);
  }
  return issues;
}

async function runCheck(id) {
  const r = db.prepare('SELECT * FROM receipts WHERE id = ?').get(id);
  if (!r) return;
  const cfg = aiConfig();
  let status, result;
  try {
    const { mode, read } = await readReceipt(r);
    const issues = [...compareReceipt(r, read), ...rulesCheck(r)];
    status = issues.some((i) => i.severity === 'warn') ? 'review' : 'ok';
    result = { issues, mode, model: cfg.model, note: read.notes, at: new Date().toISOString() };
  } catch (e) {
    status = 'error';
    result = { error: e.message, issues: rulesCheck(r), model: cfg.model, at: new Date().toISOString() };
  }
  // only store the result if the receipt wasn't re-queued by an edit while the model was thinking
  const cur = db.prepare('SELECT check_status FROM receipts WHERE id = ?').get(id);
  if (cur && cur.check_status === 'pending') db.prepare('UPDATE receipts SET check_status = ?, check_json = ? WHERE id = ?').run(status, JSON.stringify(result), id);
}

// one check at a time: local models are usually single-GPU
const queue = [];
let busy = false;
async function pump() {
  if (busy) return;
  busy = true;
  while (queue.length) {
    const id = queue.shift();
    try { await runCheck(id); } catch (e) { console.error('[ai] check failed:', e.message); }
  }
  busy = false;
}
export function enqueueCheck(id) {
  db.prepare("UPDATE receipts SET check_status = 'pending', check_json = '' WHERE id = ?").run(id);
  if (!queue.includes(id)) queue.push(id);
  pump();
}
export function resumePendingChecks() {
  for (const { id } of db.prepare("SELECT id FROM receipts WHERE check_status = 'pending'").all()) { if (aiReady()) queue.push(id); else db.prepare("UPDATE receipts SET check_status = 'none' WHERE id = ?").run(id); }
  pump();
}
export const checkIdle = () => new Promise((resolve) => { const t = setInterval(() => { if (!busy && !queue.length) { clearInterval(t); resolve(); } }, 20); });

export function parseCheck(row) {
  let extra = {};
  try { extra = row.check_json ? JSON.parse(row.check_json) : {}; } catch { /* ignore */ }
  return { status: row.check_status, issues: extra.issues || [], error: extra.error || '', mode: extra.mode || '', model: extra.model || '', note: extra.note || '', at: extra.at || '' };
}

// ---------------------------------------------------------------- 2. smart search -> filters
const BILLABLE = ['any', 'yes', 'no'], BILLING = ['any', 'unbilled', 'invoiced', 'paid'], WARRANTY = ['any', 'active', 'expiring', 'expired', 'unknown'];

/** Validate whatever the model produced into the exact filter shape the UI uses. Unknown values are dropped. */
export function sanitizeFilters(o, scope, knownCategories = []) {
  const date = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v ?? '')) && !Number.isNaN(Date.parse(v)) ? v : '');
  const cat = String(o.category ?? '').trim().toLowerCase();
  const f = {
    any: (Array.isArray(o.any) ? o.any : []).map((w) => String(w).trim().toLowerCase().slice(0, 40)).filter(Boolean).slice(0, 12),
    category: knownCategories.find((c) => c.toLowerCase() === cat) || '',
    vendor: str(o.vendor, 60),
    from: date(o.from), to: date(o.to),
    min: dollarsToCents(o.min), max: dollarsToCents(o.max),
  };
  if (f.from && f.to && f.from > f.to) [f.from, f.to] = [f.to, f.from];
  if (scope === 'items') f.warranty = WARRANTY.includes(o.warranty) ? o.warranty : 'any';
  else { f.billable = BILLABLE.includes(o.billable) ? o.billable : 'any'; f.billing = BILLING.includes(o.billing) ? o.billing : 'any'; }
  return f;
}

export async function interpretSearch(query, scope, userId) {
  const today = new Date().toISOString().slice(0, 10);
  const rows = scope === 'items'
    ? db.prepare("SELECT category, vendor FROM items").all()
    : db.prepare("SELECT r.category, r.vendor FROM receipts r JOIN projects p ON p.id = r.project_id WHERE p.user_id = ?").all(userId);
  const base = scope === 'items' ? ITEM_CATEGORIES : RECEIPT_CATEGORIES;
  const cats = [...new Set([...base, ...rows.map((r) => r.category).filter(Boolean)])].slice(0, 60);
  const vendors = [...new Set(rows.map((r) => r.vendor).filter(Boolean))].slice(0, 60);
  const kind = scope === 'items' ? 'household purchases (appliances, electronics, furniture...) kept for warranty' : 'work expense receipts';
  const extra = scope === 'items'
    ? '"warranty": one of any|active|expiring|expired|unknown (active = still covered, expiring = ends within 90 days)'
    : '"billable": any|yes|no, "billing": any|unbilled|invoiced|paid';
  const prompt = `Today is ${today}. Convert the search request into JSON filters over ${kind}.
Keys: "any": 1-8 lowercase keywords or synonyms where ANY may match the item name/vendor/notes (e.g. for "washing machine": ["washer","washing machine","laundry"]);
"category": exactly one of [${cats.join(', ')}] or ""; "vendor": a store name or "" (known stores: ${vendors.join(', ') || 'none'});
"from"/"to": YYYY-MM-DD purchase date bounds or "" (resolve phrases like "last year" from today's date); "min"/"max": price in dollars or null; ${extra}.
Leave a key empty/"any"/null when the request does not mention it. Do not invent constraints.
Request: ${JSON.stringify(query)}`;
  const reply = await chat([{ role: 'system', content: 'You convert search requests into JSON filters. Reply with ONLY a JSON object.' }, { role: 'user', content: prompt }], { maxTokens: 400, timeoutMs: 60000 });
  return sanitizeFilters(extractJson(reply), scope, cats);
}

// ---------------------------------------------------------------- routes
export function registerAi(app, { getReceipt }) {
  app.get('/api/ai/status', (req, res) => { const c = aiConfig(); res.json({ enabled: aiReady(), vision: c.vision, auto_check: c.auto_check }); });

  const view = () => { const { api_key, ...c } = aiConfig(); return { ...c, has_key: !!api_key }; };
  app.get('/api/ai', requireAdmin, (req, res) => res.json(view()));
  app.put('/api/ai', requireAdmin, (req, res) => {
    const b = req.body || {};
    const base = String(b.base_url ?? '').trim();
    if (base && !/^https?:\/\/[^\s]+$/i.test(base)) throw err(400, 'AI server address must start with http:// or https://');
    const timeout = Number(b.timeout_s ?? 120);
    if (!(timeout >= 5 && timeout <= 1800)) throw err(400, 'timeout must be 5-1800 seconds');
    setSetting('ai.enabled', b.enabled ? '1' : '0');
    setSetting('ai.base_url', base);
    setSetting('ai.model', str(b.model, 120));
    setSetting('ai.vision', b.vision ? '1' : '0');
    setSetting('ai.auto_check', b.auto_check ? '1' : '0');
    setSetting('ai.timeout_s', timeout);
    if (b.clear_key) setSetting('ai.api_key', '');
    else if (typeof b.api_key === 'string' && b.api_key.trim()) setSetting('ai.api_key', b.api_key.trim());
    res.json(view());
  });

  app.post('/api/ai/test', requireAdmin, wrap(async (req, res) => {
    const c = aiConfig();
    if (!c.base_url || !c.model) throw err(400, 'Set the server address and model name first');
    const started = Date.now();
    let models = [];
    try {
      const r = await fetch(c.base_url.replace(/\/+$/, '') + '/models', { headers: c.api_key ? { authorization: `Bearer ${c.api_key}` } : {}, signal: AbortSignal.timeout(8000) });
      if (r.ok) models = ((await r.json()).data || []).map((m) => m.id).filter(Boolean).slice(0, 50);
    } catch { /* /models is optional */ }
    try {
      const reply = await chat([{ role: 'user', content: 'Reply with the single word OK.' }], { maxTokens: 20, timeoutMs: 60000 });
      res.json({ ok: true, reply: reply.replace(/<think>[\s\S]*?<\/think>/gi, '').trim().slice(0, 80), models, ms: Date.now() - started, model_listed: !models.length || models.includes(c.model) });
    } catch (e) { res.status(502).json({ error: e.message, models }); }
  }));

  app.post('/api/ai/search', wrap(async (req, res) => {
    if (!aiReady()) throw err(400, 'AI is not set up');
    const query = str(req.body?.query, 300), scope = req.body?.scope === 'receipts' ? 'receipts' : 'items';
    if (!query) throw err(400, 'type something to search for');
    try { res.json({ filters: await interpretSearch(query, scope, req.user.id) }); }
    catch (e) { throw err(502, e.message); }
  }));

  app.post('/api/receipts/:id/check', (req, res) => {
    const r = getReceipt(req.params.id, req.user);
    if (!aiReady()) throw err(400, 'AI is not set up');
    enqueueCheck(r.id);
    res.status(202).json({ status: 'pending' });
  });
  app.post('/api/receipts/:id/check/dismiss', (req, res) => {
    const r = getReceipt(req.params.id, req.user);
    if (r.check_status !== 'pending') db.prepare("UPDATE receipts SET check_status = 'reviewed' WHERE id = ?").run(r.id);
    res.status(204).end();
  });
}
