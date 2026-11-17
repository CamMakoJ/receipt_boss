// Receipt Boss front-end: vanilla JS, no build step.
import { openCropper } from './crop.js';
import { scanCanvas, cancelScan, warmOcr } from './ocr.js';
import { parseReceiptText, resolveAmounts } from './ocr-parse.js';
import { emptyFilters, filterRecords, sortRecords, activeChips, clearFilter, hasFilters, warrantyState, SORTS } from './filters.js';
const $ = (s, el = document) => el.querySelector(s);
const app = $('#app');

// ------------------------------------------------------------------ helpers
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (c) => (c < 0 ? '-' : '') + '$' + (Math.abs(c) / 100).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const toCents = (v) => { const n = parseFloat(String(v).replace(/[^0-9.\-]/g, '')); return Number.isFinite(n) ? Math.max(0, Math.round(n * 100)) : 0; };
const fromCents = (c) => (c ? (c / 100).toFixed(2) : '');
const today = () => { const d = new Date(); return new Date(d - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10); };
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now() + '-' + Math.random().toString(16).slice(2));
const pad = (n) => String(n).padStart(3, '0');

let me = null;   // signed-in user
let meta = null; // provinces + categories

function toast(msg, bad = false) {
  const t = $('#toast');
  t.textContent = msg; t.className = 'toast' + (bad ? ' bad' : ''); t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 3500);
}

async function api(method, url, body) {
  const res = await fetch('/api' + url, {
    method, headers: { 'x-rb': '1', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body && JSON.stringify(body),
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { status: res.status, offline: res.status === 503, data });
  return data;
}
const isNetworkError = (e) => e.offline || e instanceof TypeError;
const getMeta = async () => (meta ||= await api('GET', '/meta'));
let aiState = null; // { enabled, vision, auto_check } — is a local AI model configured?
const getAi = async () => { try { return (aiState ||= await api('GET', '/ai/status')); } catch { return { enabled: false, vision: false, auto_check: false }; } };

/** Create a record; duplicate warnings ask first; offline saves to the device queue. -> 'saved' | 'queued' | 'cancelled' */
const dupText = (d) => (d.project_name ? `#${pad(d.number)} ${d.description || d.vendor || 'receipt'} — ${d.date}, ${money(d.total)} in “${d.project_name}”`
  : `${d.name} — ${d.purchase_date}${d.price ? ', ' + money(d.price) : ''}`);
async function createRecord(url, data, queueExtra = {}) {
  const client_id = uuid();
  const attempt = (allow) => api('POST', url, { ...data, client_id, ...(allow ? { allow_duplicate: true } : {}) });
  try { await attempt(false); return 'saved'; }
  catch (e) {
    if (e.status === 409 && e.data?.duplicates) {
      if (!confirm(`This looks like a duplicate of:\n\n${e.data.duplicates.map(dupText).join('\n')}\n\nSave it anyway?`)) return 'cancelled';
      await attempt(true); return 'saved';
    }
    if (!isNetworkError(e)) throw e;
    await queuePut({ client_id, url, data, ...queueExtra });   // save locally, sync later
    await renderBanner(); toast('Offline — saved on this device, will sync automatically');
    return 'queued';
  }
}

// ------------------------------------------------------------------ offline queue (IndexedDB)
// Each entry: { client_id, user_id, url, data, label, project_id?, error? } -> POSTed to /api{url} when online.
const idb = new Promise((resolve, reject) => {
  const open = indexedDB.open('receipt-boss', 1);
  open.onupgradeneeded = () => open.result.createObjectStore('queue', { keyPath: 'client_id' });
  open.onsuccess = () => resolve(open.result);
  open.onerror = () => reject(open.error);
});
async function store(mode, fn) {
  const db = await idb;
  return new Promise((resolve, reject) => {
    const t = db.transaction('queue', mode);
    const req = fn(t.objectStore('queue'));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
  });
}
const queueAll = async () => ((await store('readonly', (s) => s.getAll())) || []).filter((i) => i.user_id === me?.id && i.url);
const queuePut = (item) => store('readwrite', (s) => s.put({ ...item, user_id: me.id }));
const queueDel = (id) => store('readwrite', (s) => s.delete(id));

let flushing = false;
async function flushQueue(force = false) {
  if (flushing || !navigator.onLine || !me) return;
  flushing = true;
  let sent = 0, flagged = 0;
  try {
    for (const item of await queueAll()) {
      if (item.error && force !== true) continue;           // waits for the user: duplicate / rejected
      try {
        await api('POST', item.url, { ...item.data, client_id: item.client_id });
        await queueDel(item.client_id); sent++;
      } catch (e) {
        if (isNetworkError(e)) break;                       // still offline: try again later
        if (e.status === 401) { await showAuth(); break; }  // session expired: sign in again, queue is kept
        if (e.status === 409) { await queuePut({ ...item, error: 'Possible duplicate', duplicate: e.data?.duplicates?.[0] || null }); flagged++; } // needs a human decision
        else if (e.status === 404 || e.status === 400) { await queuePut({ ...item, error: e.message }); flagged++; } // can never succeed: flag it
        else break;
      }
    }
  } finally { flushing = false; }
  if (sent) toast(`Synced ${sent} item${sent > 1 ? 's' : ''}`);
  if (sent || flagged) route();                                 // show what changed (synced, or needs a decision)
  await renderBanner();
}

async function renderBanner() {
  const q = me ? await queueAll() : [];
  const el = $('#sync');
  el.hidden = !q.length;
  if (q.length) {
    const failed = q.filter((i) => i.error).length;
    el.innerHTML = `<span>${q.length} item${q.length > 1 ? 's' : ''} waiting to sync${failed ? ` (${failed} need attention)` : ''}</span><button id="syncnow">Sync now</button>`;
    $('#syncnow').onclick = () => flushQueue(true);
  }
}
function renderNet() { $('#net').textContent = navigator.onLine ? '' : '● offline'; }
addEventListener('online', () => { renderNet(); flushQueue(); });
addEventListener('offline', renderNet);

// ------------------------------------------------------------------ photo -> crop -> OCR
const ocrOn = () => localStorage.getItem('ocr-on') !== '0';

/** Photo picker markup shared by receipt and item forms. */
function photoField(existingSrc) {
  return `<label>Photo</label>
    <div class="row"><label class="btn pri" style="margin:0">📷 Take photo<input id="cam" type="file" accept="image/*" capture="environment" hidden></label>
      <label class="btn" style="margin:0">🖼 Choose file<input id="pick" type="file" accept="image/*" hidden></label>
      <button type="button" id="rescan" hidden>🔍 Read text</button>
      ${existingSrc ? '<button type="button" id="rmimg" class="danger">Remove</button>' : ''}</div>
    <label class="check"><input type="checkbox" id="ocrtoggle" ${ocrOn() ? 'checked' : ''}> Read the receipt automatically after cropping (on this device; nothing is uploaded for reading)</label>
    <div id="scanmsg" class="scanmsg" hidden></div>
    <img id="prev" class="preview" ${existingSrc ? `src="${existingSrc}"` : 'hidden'} alt="">`;
}

/** Full-screen "Reading receipt…" overlay with a skip button. */
async function runScan(canvas, onText) {
  const box = document.createElement('div');
  box.className = 'scan-overlay';
  box.innerHTML = '<div class="card"><div class="spinner"></div><b id="scanstat">Starting…</b><div class="bar"><i id="scanbar"></i></div><button type="button" id="scanskip">Skip</button></div>';
  document.body.appendChild(box);
  $('#scanskip', box).onclick = () => cancelScan();
  const onProgress = (m) => {
    const pct = Math.round((m.progress || 0) * 100);
    $('#scanstat', box).textContent = m.status === 'recognizing text' ? `Reading receipt… ${pct}%` : /language|traineddata|loading/.test(m.status) ? 'Loading reader (first time only)…' : 'Preparing…';
    $('#scanbar', box).style.width = (m.status === 'recognizing text' ? pct : 5) + '%';
  };
  try { onText(await scanCanvas(canvas, { onProgress })); return true; }
  catch (e) { if (!e.cancelled) toast('Could not read the text on this photo — fill it in by hand', true); return false; }
  finally { box.remove(); }
}

/**
 * Wires the photo buttons: choose/take -> crop screen -> (optional) OCR -> onScan(text).
 * Returns the state the form reads on save: { data (jpeg data URL | null), remove }.
 */
function wirePhoto(onScan) {
  const st = { data: null, remove: false, canvas: null, text: '' };   // text = what OCR read; saved for search and the AI check
  const scan = async () => { if (st.canvas && onScan) await runScan(st.canvas, (text) => { st.text = text; onScan(text); }); };
  const onFile = async (ev) => {
    const file = ev.target.files[0]; ev.target.value = '';
    if (!file) return;
    try {
      const res = await openCropper(file);          // straight to the crop screen
      if (!res) return;                              // cancelled: keep whatever photo was there before
      Object.assign(st, { data: res.dataUrl, canvas: res.canvas, remove: false, text: '' });
      $('#prev').src = res.dataUrl; $('#prev').hidden = false;
      if (onScan) $('#rescan').hidden = false;
      if (onScan && ocrOn()) await scan();
    } catch (e) { toast(e.message, true); }
  };
  $('#cam').onchange = onFile; $('#pick').onchange = onFile;
  $('#rescan').onclick = scan;
  $('#ocrtoggle').onchange = (ev) => localStorage.setItem('ocr-on', ev.target.checked ? '1' : '0');
  if ($('#rmimg')) $('#rmimg').onclick = () => { st.remove = true; st.data = null; st.canvas = null; st.text = ''; $('#prev').hidden = true; $('#rescan').hidden = true; };
  if (onScan && ocrOn()) warmOcr();                  // fetch the OCR engine in the background while online
  return st;
}

const showScanMsg = (html, warn = false) => { const el = $('#scanmsg'); el.innerHTML = html; el.className = 'scanmsg' + (warn ? ' warn' : ''); el.hidden = false; };
/** Put a value in a field only if the user hasn't typed there (empty, a default, or an earlier scan). Marks it for review. */
function scanFill(el, value, isDefault = false) {
  if (value === null || value === undefined || value === '') return false;
  if (el.value && !el.classList.contains('scanned') && !isDefault) return false;
  el.value = value; el.classList.add('scanned');
  el.addEventListener('input', () => el.classList.remove('scanned'), { once: true });
  return true;
}

// ------------------------------------------------------------------ auth screens
async function showAuth() {
  me = null; $('#nav').hidden = true; $('#sync').hidden = true;
  let st;
  try { st = await api('GET', '/auth/status'); }
  catch (e) {
    app.innerHTML = `<div class="card"><b>${isNetworkError(e) ? 'The server is not reachable and you are signed out.' : esc(e.message)}</b><p class="muted">Reconnect to sign in.</p><button onclick="location.reload()">Retry</button></div>`;
    return;
  }
  if (st.user) { me = st.user; return start(); }
  const setup = st.needsSetup;
  app.innerHTML = `<div class="card auth"><h1>${setup ? 'Welcome — create the admin account' : 'Sign in'}</h1>
    ${setup ? '<p class="muted">This first account is the administrator. You can add family members afterwards in Settings.</p>' : ''}
    <form id="auth"><label>Username</label><input name="username" autocomplete="username" autocapitalize="none" required>
    <label>Password ${setup ? '(8+ characters)' : ''}</label><input name="password" type="password" autocomplete="${setup ? 'new-password' : 'current-password'}" required>
    <p><button class="pri" style="width:100%">${setup ? 'Create account' : 'Sign in'}</button></p></form></div>`;
  $('#auth').onsubmit = async (ev) => {
    ev.preventDefault();
    try {
      const r = await api('POST', setup ? '/auth/setup' : '/auth/login', Object.fromEntries(new FormData(ev.target)));
      me = r.user; start();
    } catch (e) { toast(isNetworkError(e) ? 'Cannot reach the server' : e.message, true); }
  };
}

async function logout() {
  try { await api('POST', '/auth/logout', {}); } catch { /* offline: cookie stays, but local caches are still cleared below */ }
  try { for (const k of await caches.keys()) if (k.startsWith('data-')) await caches.delete(k); } catch { /* ignore */ }
  Object.keys(localStorage).filter((k) => k.startsWith('project-')).forEach((k) => localStorage.removeItem(k));
  meta = null; location.hash = '#/'; location.reload();
}

// ------------------------------------------------------------------ router
function renderNav(active) {
  const nav = $('#nav'); nav.hidden = !me;
  if (!me) return;
  nav.innerHTML = [['projects', '#/', 'Projects'], ['household', '#/household', 'Household'], ['settings', '#/settings', `⚙ ${esc(me.username)}`]]
    .map(([k, href, label]) => `<a href="${href}" class="${k === active ? 'on' : ''}">${label}</a>`).join('');
}

async function route() {
  if (!me) return;
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  try {
    await getMeta();
    if (parts[0] === 'household') { renderNav('household'); return parts[1] === 'new' ? await viewItemForm({}) : parts[1] ? await viewItemForm({ itemId: parts[1] }) : await viewItems(); }
    if (parts[0] === 'settings') { renderNav('settings'); return await viewSettings(); }
    renderNav('projects');
    if (parts[0] === 'search') return await viewSearch();
    if (!parts.length) return await viewProjects();
    if (parts[0] === 'p' && parts[2] === 'new') return await viewReceiptForm({ projectId: parts[1] });
    if (parts[0] === 'p') return await viewProject(parts[1]);
    if (parts[0] === 'r') return await viewReceiptForm({ receiptId: parts[1] });
    return await viewProjects();
  } catch (e) {
    if (e.status === 401) return showAuth();
    app.innerHTML = `<div class="card"><b>${isNetworkError(e) ? 'You are offline and this page was not cached yet.' : esc(e.message)}</b><p><a href="#/">Back to projects</a></p></div>`;
  }
}
let pollTries = 0;
addEventListener('hashchange', () => { pollTries = 0; route(); });

const provLabel = (code) => `${code} — ${meta.provinces[code].name}`;
const provOptions = (sel) => Object.keys(meta.provinces).map((c) => `<option value="${c}" ${c === sel ? 'selected' : ''}>${esc(provLabel(c))} (${esc(meta.provinces[c].note)})</option>`).join('');
const catOptions = (list, used = []) => [...new Set([...list, ...used])].map((c) => `<option value="${esc(c)}">`).join('');
const calcTax = (sub, prov) => {
  const p = meta.provinces[prov] || meta.provinces[meta.default_province];
  return { gst: Math.round((sub * p.gst) / 100000), pst: Math.round((sub * p.pst) / 100000) };
};

// ------------------------------------------------------------------ projects
async function viewProjects() {
  const projects = await api('GET', '/projects');
  const active = projects.filter((p) => !p.archived), archived = projects.filter((p) => p.archived);
  const card = (p) => `<a class="card" href="#/p/${p.id}">
      <div class="spread"><b>${esc(p.name)}</b><span class="money"><b>${money(p.all.total)}</b></span></div>
      <div class="muted">${esc(p.client)}${p.client ? ' · ' : ''}${p.all.count} receipt${p.all.count === 1 ? '' : 's'} · ${esc(p.province)}</div>
      <div class="row small"><span class="pill">Billable ${money(p.billable.total)}</span><span class="pill nb">Non-billable ${money(p.non_billable.total)}</span></div></a>`;
  app.innerHTML = `<h1>Projects</h1>
    <div class="actions" style="margin-top:0"><a class="btn" href="#/search">🔍 Search all receipts</a></div>
    ${active.map(card).join('') || '<p class="muted">No projects yet. Create one to start adding receipts.</p>'}
    <div class="card"><h2 style="margin-top:0">New project</h2>
      <form id="newp">
        <label>Name</label><input name="name" required placeholder="e.g. Kitchen reno">
        <label>Client (optional)</label><input name="client">
        <label>Default province (receipts can override)</label><select name="province">${provOptions(meta.default_province)}</select>
        <p><button class="pri">Create project</button></p>
      </form></div>
    ${archived.length ? `<h2>Archived</h2>${archived.map(card).join('')}` : ''}`;
  $('#newp').onsubmit = async (ev) => {
    ev.preventDefault();
    try { const p = await api('POST', '/projects', Object.fromEntries(new FormData(ev.target))); location.hash = `#/p/${p.id}`; }
    catch (e) { toast(isNetworkError(e) ? 'Creating projects needs a connection' : e.message, true); }
  };
}

async function viewProject(id) {
  const p = await api('GET', `/projects/${id}`);
  localStorage.setItem('project-' + id, JSON.stringify({ id: p.id, name: p.name, province: p.province }));
  const pending = (await queueAll()).filter((i) => String(i.project_id) === String(id));
  const bill = p.receipts.filter((r) => r.billable), non = p.receipts.filter((r) => !r.billable);

  const sumTable = `<table class="t"><tr><th></th><th>Subtotal</th><th>GST/HST</th><th>PST/QST</th><th>Tip</th><th>Total</th></tr>
    ${[['Billable', p.billable], ['Non-billable', p.non_billable], ['All', p.all]].map(([n, t]) =>
      `<tr><td>${n}</td><td>${money(t.subtotal)}</td><td>${money(t.gst)}</td><td>${money(t.pst)}</td><td>${money(t.tip)}</td><td><b>${money(t.total)}</b></td></tr>`).join('')}</table>`;

  const CHECK = { pending: ['⏳ checking…', 'pending'], ok: ['✓ checked', ''], reviewed: ['✓ reviewed', ''], error: ['check failed', 'nb'] };
  const checkPill = (r) => {
    const c = r.check; if (!c || c.status === 'none') return '';
    if (c.status === 'review') return `<span class="pill bad">⚠ ${c.issues.filter((i) => i.severity === 'warn').length} to review</span>`;
    const [t, cls] = CHECK[c.status] || []; return t ? `<span class="pill ${cls}">${t}</span>` : '';
  };
  const billPill = (r) => (r.billable ? `<span class="pill ${r.billing_status === 'unbilled' ? 'nb' : r.billing_status === 'paid' ? '' : 'pending'}">${r.billing_status}${r.invoice_ref ? ' ' + esc(r.invoice_ref) : ''}</span>` : '');
  const rcpt = (r) => `<a class="card row selectable" href="#/r/${r.id}" data-id="${r.id}" style="flex-wrap:nowrap">
      ${r.billable ? `<input type="checkbox" class="sel" data-sel="${r.id}" aria-label="Select receipt">` : ''}
      ${r.has_image ? `<img class="thumb" loading="lazy" src="/api/receipts/${r.id}/image" alt="">` : '<div class="thumb"></div>'}
      <div class="grow"><div class="spread"><b>#${pad(r.number)} ${esc(r.description || r.vendor || 'Receipt')}</b><span class="money"><b>${money(r.total)}</b></span></div>
      <div class="muted small">${esc(r.date)}${r.vendor ? ' · ' + esc(r.vendor) : ''} · ${esc(r.province)}${r.category ? ' · ' + esc(r.category) : ''}</div>
      <div class="muted small">Sub ${money(r.subtotal)} · GST ${money(r.gst)} · PST ${money(r.pst)} · Tip ${money(r.tip)}</div>
      <div class="row small">${billPill(r)}${checkPill(r)}</div></div></a>`;
  const pend = (i) => `<div class="card row" style="flex-wrap:nowrap"><div class="thumb"></div><div class="grow">
      <div class="spread"><b>${esc(i.label)}</b></div>
      <span class="pill pending">${i.error ? 'Needs attention: ' + esc(i.error) : 'Waiting to sync'}</span> <span class="pill ${i.data.billable ? '' : 'nb'}">${i.data.billable ? 'Billable' : 'Non-billable'}</span>
      ${i.duplicate ? `<div class="muted small">Looks like: ${esc(dupText(i.duplicate))}</div>` : ''}</div>
      ${i.error === 'Possible duplicate' ? `<button data-force="${esc(i.client_id)}">Save anyway</button>` : ''}
      <button class="danger" data-discard="${esc(i.client_id)}">✕</button></div>`;

  const bl = p.billing, billLine = p.billable.count
    ? `<div class="row small" style="margin-top:10px"><span class="pill nb">Unbilled ${money(bl.unbilled.total)} (${bl.unbilled.count})</span><span class="pill pending">Invoiced ${money(bl.invoiced.total)} (${bl.invoiced.count})</span><span class="pill">Paid ${money(bl.paid.total)} (${bl.paid.count})</span></div>` : '';

  app.innerHTML = `<p><a href="#/">← Projects</a></p>
    <h1>${esc(p.name)}</h1><div class="muted">${esc(p.client)}${p.client ? ' · ' : ''}${esc(meta.provinces[p.province]?.name || p.province)}</div>
    <div class="actions"><a class="btn pri" href="#/p/${p.id}/new">＋ Add receipt</a></div>
    <div class="card">${sumTable}${billLine}</div>
    ${pending.length ? `<h2>Pending sync (${pending.length})</h2>${pending.map(pend).join('')}` : ''}
    <div class="spread"><h2>Billable (${bill.length})</h2>${bill.length ? '<button type="button" id="selbtn">Select</button>' : ''}</div>
    <div id="billlist">${bill.map(rcpt).join('') || '<p class="muted">None</p>'}</div>
    <h2>Non-billable (${non.length})</h2>${non.map(rcpt).join('') || '<p class="muted">None</p>'}
    <div class="card"><h2 style="margin-top:0">Export report</h2>
      <div class="grid"><div><label>From</label><input type="date" id="from"></div><div><label>To</label><input type="date" id="to"></div></div>
      <div class="grid"><div><label>Include</label><select id="only"><option value="">All receipts</option><option value="billable">Billable only</option></select></div>
        <div><label>Billing status</label><select id="bstatus"><option value="all">Any</option><option value="unbilled">Unbilled</option><option value="invoiced">Invoiced</option><option value="paid">Paid</option></select></div></div>
      <label>Only invoice # <span class="muted small">(optional)</span></label><input id="invfilter" placeholder="e.g. INV-2026-014" autocapitalize="characters">
      <label class="check"><input type="checkbox" id="autotax" checked> Auto-calculate GST/PST for receipts with no tax entered (from each receipt's province; marked * in the report)</label>
      <div class="actions"><a class="btn pri" id="zip">⬇ Report bundle (.zip)</a><a class="btn" id="pdf">PDF</a><a class="btn" id="csv">CSV</a></div>
      <div class="card" style="background:#f8fafc;margin:10px 0 0"><b>Invoicing</b>
        <div class="muted small">Marks the <b>unbilled billable</b> receipts in the date range as invoiced under an invoice number, then downloads a bundle of just those, so nothing gets billed twice.</div>
        <div class="actions"><button type="button" id="mkinv" class="pri">🧾 Create invoice bundle…</button></div></div>
      <div class="muted small">Bundle = PDF report with receipt images + CSV + <code>receipts/</code> folder of JPGs named <code>001_description.jpg</code>.</div></div>
    <div class="card"><h2 style="margin-top:0">Project settings</h2>
      <form id="edit"><label>Name</label><input name="name" value="${esc(p.name)}"><label>Client</label><input name="client" value="${esc(p.client)}">
      <label>Default province for new receipts</label><select name="province">${provOptions(p.province)}</select>
      <div class="actions"><button class="pri">Save</button><button type="button" id="arch">${p.archived ? 'Unarchive' : 'Archive'}</button><button type="button" class="danger" id="del">Delete project</button></div></form></div>`;

  const link = (path) => {
    const q = new URLSearchParams();
    if ($('#from').value) q.set('from', $('#from').value);
    if ($('#to').value) q.set('to', $('#to').value);
    if (!$('#autotax').checked) q.set('autotax', '0');
    if ($('#only').value) q.set('only', $('#only').value);
    if ($('#bstatus').value !== 'all') q.set('billing', $('#bstatus').value);
    if ($('#invfilter').value.trim()) q.set('invoice', $('#invfilter').value.trim());
    return `/api/projects/${p.id}/${path}?${q}`;
  };
  for (const [elId, path] of [['zip', 'export.zip'], ['pdf', 'report.pdf'], ['csv', 'report.csv']]) {
    $('#' + elId).onclick = (ev) => { ev.preventDefault(); if (!navigator.onLine) return toast('Exports need a connection to the server', true); location.href = link(path); };
  }
  $('#edit').onsubmit = async (ev) => {
    ev.preventDefault();
    try { await api('PATCH', `/projects/${p.id}`, Object.fromEntries(new FormData(ev.target))); toast('Saved'); route(); }
    catch (e) { toast(e.message, true); }
  };
  $('#arch').onclick = async () => { await api('PATCH', `/projects/${p.id}`, { archived: !p.archived }); location.hash = '#/'; };
  $('#del').onclick = async () => {
    if (!confirm(`Delete "${p.name}" and its ${p.all.count} receipts? This cannot be undone.`)) return;
    await api('DELETE', `/projects/${p.id}`); location.hash = '#/';
  };
  app.querySelectorAll('[data-discard]').forEach((b) => (b.onclick = async (ev) => {
    ev.preventDefault(); if (confirm('Discard this unsynced receipt?')) { await queueDel(b.dataset.discard); await renderBanner(); route(); }
  }));
  app.querySelectorAll('[data-force]').forEach((b) => (b.onclick = async (ev) => {
    ev.preventDefault();
    const item = (await queueAll()).find((x) => x.client_id === b.dataset.force); if (!item) return;
    await queuePut({ ...item, data: { ...item.data, allow_duplicate: true }, error: undefined, duplicate: undefined });
    await flushQueue(); route();
  }));

  // ---- select billable receipts -> mark invoiced / paid / unbilled
  let selecting = false;
  const bar = document.createElement('div'); bar.className = 'bulkbar'; bar.hidden = true; document.body.appendChild(bar);
  const cleanupBar = () => { if (!document.body.contains($('#billlist'))) { bar.remove(); removeEventListener('hashchange', cleanupBar); } };
  addEventListener('hashchange', cleanupBar);
  const picked = () => [...app.querySelectorAll('.sel:checked')].map((c) => Number(c.dataset.sel));
  const updateBar = () => {
    const ids = picked(); bar.hidden = !selecting || !ids.length;
    const sum = p.receipts.filter((r) => ids.includes(r.id)).reduce((a, r) => a + r.total, 0);
    bar.innerHTML = `<b>${ids.length} selected · ${money(sum)}</b><div class="row"><button type="button" data-bulk="invoiced" class="pri">Mark invoiced…</button><button type="button" data-bulk="paid">Mark paid</button><button type="button" data-bulk="unbilled">Unbilled</button></div>`;
  };
  if ($('#selbtn')) $('#selbtn').onclick = () => {
    selecting = !selecting; $('#billlist').classList.toggle('selecting', selecting); $('#selbtn').textContent = selecting ? 'Done' : 'Select';
    if (!selecting) app.querySelectorAll('.sel').forEach((c) => (c.checked = false)); updateBar();
  };
  $('#billlist').addEventListener('click', (ev) => {
    if (!selecting) return;
    const card = ev.target.closest('.card[data-id]'); if (!card) return;
    if (!ev.target.classList.contains('sel')) { ev.preventDefault(); const cb = card.querySelector('.sel'); cb.checked = !cb.checked; }
    updateBar();
  });
  bar.onclick = async (ev) => {
    const status = ev.target.closest('[data-bulk]')?.dataset.bulk; if (!status) return;
    let ref = '';
    if (status === 'invoiced') { ref = prompt('Invoice number for the selected receipts?', 'INV-' + today().replace(/-/g, '')); if (!ref) return; }
    try { const r = await api('POST', `/projects/${p.id}/billing`, { ids: picked(), status, invoice_ref: ref.trim() }); toast(`${r.updated} receipt${r.updated === 1 ? '' : 's'} marked ${status}`); bar.remove(); route(); }
    catch (e) { toast(isNetworkError(e) ? 'This needs a connection to the server' : e.message, true); }
  };
  $('#mkinv').onclick = async () => {
    if (!navigator.onLine) return toast('This needs a connection to the server', true);
    const from = $('#from').value, to = $('#to').value;
    const todo = p.receipts.filter((r) => r.billable && r.billing_status === 'unbilled' && (!from || r.date >= from) && (!to || r.date <= to));
    if (!todo.length) return toast('No unbilled billable receipts in that date range');
    const ref = prompt(`Invoice number for these ${todo.length} receipts (${money(todo.reduce((a, r) => a + r.total, 0))})?`, 'INV-' + today().replace(/-/g, ''));
    if (!ref || !ref.trim()) return;
    try {
      await api('POST', `/projects/${p.id}/billing`, { ids: todo.map((r) => r.id), status: 'invoiced', invoice_ref: ref.trim() });
      const q = new URLSearchParams({ only: 'billable', invoice: ref.trim() });
      if (from) q.set('from', from); if (to) q.set('to', to); if (!$('#autotax').checked) q.set('autotax', '0');
      location.href = `/api/projects/${p.id}/export.zip?${q}`;
      toast(`${todo.length} receipts marked as ${ref.trim()}`); setTimeout(route, 1500);
    } catch (e) { toast(e.message, true); }
  };

  // while the AI is still checking some receipts, refresh quietly so the badges update
  if (p.receipts.some((r) => r.check?.status === 'pending') && pollTries < 45) {
    const mine = location.hash;
    setTimeout(async () => { if (location.hash !== mine) return; pollTries++; const y = scrollY; await route(); scrollTo(0, y); }, 3000);
  }
}

// ------------------------------------------------------------------ receipt form
async function viewReceiptForm({ projectId, receiptId }) {
  let r = null, project;
  if (receiptId) {
    r = await api('GET', `/receipts/${receiptId}`);
    project = await api('GET', `/projects/${r.project_id}`);
    projectId = r.project_id;
  } else {
    try { project = await api('GET', `/projects/${projectId}`); }
    catch (e) {
      const cached = localStorage.getItem('project-' + projectId);
      if (!isNetworkError(e) || !cached) throw e;
      project = JSON.parse(cached);
    }
  }
  const allProjects = receiptId ? await api('GET', '/projects').catch(() => []) : [];
  let billable = r ? r.billable : true;
  const v = r || { date: today(), vendor: '', category: '', description: '', province: project.province, subtotal: 0, gst: 0, pst: 0, tip: 0, notes: '' };
  const autoTax = r ? r.tax_auto : true;
  const ai = r ? await getAi() : { enabled: false };

  app.innerHTML = `<p><a href="#/p/${projectId}">← ${esc(project.name)}</a></p>
    <h1>${r ? `Receipt #${pad(r.number)}` : 'New receipt'}</h1>
    ${r ? '<div id="checkcard" class="card checkcard" hidden></div>' : ''}
    <form id="f" class="card">
      ${photoField(r?.has_image ? `/api/receipts/${r.id}/image` : '')}
      <div class="grid"><div><label>Date</label><input type="date" name="date" value="${esc(v.date)}" required></div>
        <div><label>Vendor</label><input name="vendor" value="${esc(v.vendor)}" autocomplete="off"></div></div>
      <label>Province of purchase</label><select name="province">${provOptions(v.province)}</select>
      <label>Category</label><input name="category" list="cats" value="${esc(v.category)}" autocomplete="off" placeholder="pick from the list or type your own">
      <datalist id="cats">${catOptions(meta.receipt_categories, meta.used_categories)}</datalist>
      <label>Description <span class="muted small">(fills from category; edit freely — used in the picture file name)</span></label>
      <input name="description" value="${esc(v.description)}" autocomplete="off">
      <label>Type</label><div class="toggle"><button type="button" data-b="1" class="${billable ? 'on' : ''}">Billable</button><button type="button" data-b="0" class="${billable ? '' : 'on'}">Non-billable</button></div>
      <div class="grid g4">
        <div><label>Subtotal</label><input name="subtotal" inputmode="decimal" value="${fromCents(v.subtotal)}" placeholder="0.00"></div>
        <div><label>GST/HST</label><input name="gst" inputmode="decimal" value="${fromCents(v.gst)}" placeholder="0.00"></div>
        <div><label>PST/QST</label><input name="pst" inputmode="decimal" value="${fromCents(v.pst)}" placeholder="0.00"></div>
        <div><label>Tip</label><input name="tip" inputmode="decimal" value="${fromCents(v.tip)}" placeholder="0.00"></div></div>
      <label class="check"><input type="checkbox" id="taxauto" ${autoTax ? 'checked' : ''}> Auto-calculate taxes from subtotal &amp; province <span class="muted small" id="rates"></span></label>
      <div class="totalbar">Total <span id="tot">$0.00</span></div>
      <label>Notes</label><textarea name="notes" rows="2">${esc(v.notes)}</textarea>
      ${receiptId && allProjects.length > 1 ? `<label>Project</label><select name="project_id">${allProjects.map((p) => `<option value="${p.id}" ${p.id === projectId ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>` : ''}
      <div class="actions"><button class="pri" id="save">Save receipt</button>${r ? '<button type="button" class="danger" id="del">Delete</button>' : ''}</div>
    </form>`;

  const form = $('#f');
  const g = (n) => toCents(form[n].value);
  const recalc = () => { $('#tot').textContent = money(g('subtotal') + g('gst') + g('pst') + g('tip')); };
  const applyAuto = () => {
    const p = meta.provinces[form.province.value];
    $('#rates').textContent = p ? `(${p.note}: ${p.gst / 1000}%${p.pst ? ` + ${p.pst / 1000}%` : ''})` : '';
    if (!$('#taxauto').checked) return recalc();
    const t = calcTax(g('subtotal'), form.province.value);
    form.gst.value = fromCents(t.gst); form.pst.value = fromCents(t.pst); recalc();
  };
  form.subtotal.addEventListener('input', applyAuto);
  form.province.addEventListener('change', applyAuto);
  $('#taxauto').addEventListener('change', applyAuto);
  for (const n of ['gst', 'pst']) form[n].addEventListener('input', () => { $('#taxauto').checked = false; applyAuto(); }); // typing a tax = manual
  form.tip.addEventListener('input', recalc);
  applyAuto();

  // description follows category until the user writes their own
  let autoDesc = v.category, descCustom = !!v.description && v.description !== v.category;
  form.category.addEventListener('input', () => { if (!descCustom) { form.description.value = form.category.value; autoDesc = form.category.value; } });
  form.description.addEventListener('input', () => { descCustom = form.description.value !== '' && form.description.value !== autoDesc; });

  // ---- OCR result -> form fields
  const applyScan = (text) => {
    const p = parseReceiptText(text);
    if (p.province && meta.provinces[p.province]) form.province.value = p.province;
    const a = resolveAmounts(p, meta.provinces[form.province.value]);
    const filled = [];
    const set = (label, ok) => { if (ok) filled.push(label); };
    set('vendor', scanFill(form.vendor, p.vendor));
    set('date', scanFill(form.date, p.date, form.date.value === today()));
    if (p.category && !form.category.value) { form.category.value = p.category; form.category.classList.add('scanned'); form.category.dispatchEvent(new Event('input')); filled.push('category'); }
    const readTax = p.gst !== null || p.pst !== null || p.tax !== null;
    if (a.subtotal !== null && (!form.subtotal.value || form.subtotal.classList.contains('scanned'))) {
      scanFill(form.subtotal, fromCents(a.subtotal));
      $('#taxauto').checked = !readTax;                      // taxes read from the receipt are kept exactly as printed
      scanFill(form.gst, fromCents(a.gst)); scanFill(form.pst, fromCents(a.pst));
      filled.push('amounts', ...(readTax ? ['taxes'] : []));
    }
    if (a.tip !== null) set('tip', scanFill(form.tip, fromCents(a.tip)));
    applyAuto();
    if (!filled.length) return showScanMsg('Couldn’t pick out any details. Try cropping closer to the text, or use 🔍 Read text again.', true);
    showScanMsg(`Filled from the photo: <b>${filled.join(', ')}</b>. Please check the highlighted fields${a.estimated ? ` — <b>${a.inferred.map((k) => ({ subtotal: 'subtotal', gst: 'GST/HST', pst: 'PST/QST' }[k])).join(' and ')}</b> couldn’t be read clearly and ${a.inferred.length > 1 ? 'were' : 'was'} worked out from the total, so double-check ${a.inferred.length > 1 ? 'them' : 'it'}` : ''}.${p.total !== null ? ` Receipt total read: <b>${money(p.total)}</b>.` : ''}`, a.estimated);
  };
  const photo = wirePhoto(applyScan);

  // ---- second opinion from the local AI (existing receipts only; it checks the SAVED version)
  if (r) {
    const USE = { subtotal: 'subtotal', gst: 'gst', pst: 'pst', tip: 'tip', date: 'date', vendor: 'vendor' };
    const card = $('#checkcard');
    const renderCheck = () => {
      const c = r.check || { status: 'none', issues: [] };
      const warns = c.issues.filter((i) => i.severity === 'warn').length;
      if (c.status === 'none' && !ai.enabled) { card.hidden = true; return; }
      const head = { none: 'Not checked yet', pending: '⏳ Checking against the receipt…', ok: '✓ Matches the receipt', reviewed: '✓ Reviewed',
        review: `⚠ ${warns} thing${warns === 1 ? '' : 's'} to review`, error: '⚠ Couldn’t be checked' }[c.status] || '';
      card.hidden = false;
      card.className = 'card checkcard ' + ({ ok: 'good', reviewed: 'good', review: 'warn', error: 'warn' }[c.status] || '');
      card.innerHTML = `<div class="spread"><b>${head}</b>${ai.enabled && navigator.onLine && c.status !== 'pending' ? '<button type="button" id="recheck">✨ Check now</button>' : ''}</div>
        ${c.error ? `<div class="muted small">${esc(c.error)}</div>` : ''}
        ${c.issues.map((i, n) => `<div class="issue ${i.severity}"><span>${esc(i.message)}</span>${i.value !== null && i.value !== undefined && USE[i.field] ? `<button type="button" data-use="${n}">Use ${esc(i.read)}</button>` : ''}</div>`).join('')}
        ${c.note ? `<div class="muted small">Model note: ${esc(c.note)}</div>` : ''}
        ${c.model ? `<div class="muted small">${c.status === 'pending' ? '' : `Checked by ${esc(c.model)} (${c.mode === 'image' ? 'looked at the photo' : 'read the scanned text'}). `}It compares with the saved receipt, not unsaved edits.</div>` : ''}
        ${c.status === 'review' ? '<div class="actions"><button type="button" id="dismiss">Looks fine — dismiss</button></div>' : ''}`;
    };
    const poll = async () => {
      for (let n = 0; n < 60; n++) {
        await new Promise((res) => setTimeout(res, 2000));
        if (!document.body.contains(card)) return;                       // navigated away
        const cur = await api('GET', `/receipts/${r.id}`).catch(() => null);
        if (!cur) continue;
        r.check = cur.check; renderCheck();
        if (cur.check.status !== 'pending') return;
      }
    };
    card.addEventListener('click', async (ev) => {
      const use = ev.target.closest('[data-use]'), t = ev.target.closest('button');
      if (use) {
        const i = r.check.issues[Number(use.dataset.use)], el = form[USE[i.field]];
        el.value = ['date', 'vendor'].includes(i.field) ? i.value : fromCents(i.value);
        el.classList.add('scanned'); el.addEventListener('input', () => el.classList.remove('scanned'), { once: true });
        if (i.field === 'gst' || i.field === 'pst') $('#taxauto').checked = false;
        applyAuto(); toast('Filled in — press Save to keep it');
      } else if (t?.id === 'recheck') {
        try { await api('POST', `/receipts/${r.id}/check`, {}); r.check = { status: 'pending', issues: [] }; renderCheck(); poll(); }
        catch (e) { toast(e.message, true); }
      } else if (t?.id === 'dismiss') {
        await api('POST', `/receipts/${r.id}/check/dismiss`, {}); r.check = { ...r.check, status: 'reviewed' }; renderCheck();
      }
    });
    renderCheck();
    if (r.check?.status === 'pending') poll();
  }

  form.querySelectorAll('[data-b]').forEach((b) => (b.onclick = () => {
    billable = b.dataset.b === '1';
    form.querySelectorAll('[data-b]').forEach((x) => x.classList.toggle('on', x === b));
  }));

  form.onsubmit = async (ev) => {
    ev.preventDefault();
    const data = { date: form.date.value, vendor: form.vendor.value, province: form.province.value, category: form.category.value.trim(),
      description: form.description.value, billable, tax_auto: $('#taxauto').checked,
      subtotal: g('subtotal'), gst: g('gst'), pst: g('pst'), tip: g('tip'), notes: form.notes.value };
    $('#save').disabled = true;
    try {
      if (photo.text) data.ocr_text = photo.text;          // kept for search and the AI check
      if (r) {
        if (photo.data) data.image = photo.data; else if (photo.remove) data.remove_image = true;
        if (form.project_id) data.project_id = Number(form.project_id.value);
        await api('PATCH', `/receipts/${r.id}`, data);
      } else {
        if (photo.data) data.image = photo.data;
        const out = await createRecord(`/projects/${projectId}/receipts`, data,
          { project_id: projectId, label: data.description || data.category || data.vendor || 'Receipt' });
        if (out === 'cancelled') { $('#save').disabled = false; return; }
      }
      location.hash = `#/p/${projectId}`;
    } catch (e) { toast(isNetworkError(e) ? 'Editing needs a connection' : e.message, true); $('#save').disabled = false; }
  };
  if ($('#del')) $('#del').onclick = async () => {
    if (!confirm('Delete this receipt?')) return;
    await api('DELETE', `/receipts/${r.id}`); location.hash = `#/p/${projectId}`;
  };
}

// ------------------------------------------------------------------ search + filters (household items and receipts)
/**
 * Search box + filter panel + removable chips over a list of records. Everything is filtered on the device (instant, works
 * offline). With a local AI configured, "✨ Ask" turns a sentence into the same filters, shown as chips you can edit.
 */
async function mountSearch({ el, scope, records, renderRow, categories, placeholder }) {
  const ai = await getAi();
  let f = emptyFilters(), sort = scope === 'items' ? 'warranty' : 'newest';
  const cats = [...new Set([...categories, ...records.map((r) => r.category).filter(Boolean)])].sort((a, b) => a.localeCompare(b));
  const opts = (list, sel) => list.map(([v, l]) => `<option value="${v}" ${v === sel ? 'selected' : ''}>${esc(l)}</option>`).join('');
  const extra = scope === 'items'
    ? `<div><label>Warranty</label><select id="f-warranty">${opts([['any', 'Any'], ['active', 'Under warranty'], ['expiring', 'Ending within 90 days'], ['expired', 'Expired'], ['unknown', 'Unknown']], 'any')}</select></div>`
    : `<div><label>Type</label><select id="f-billable">${opts([['any', 'Any'], ['yes', 'Billable'], ['no', 'Non-billable']], 'any')}</select></div>
       <div><label>Billing status</label><select id="f-billing">${opts([['any', 'Any'], ['unbilled', 'Unbilled'], ['invoiced', 'Invoiced'], ['paid', 'Paid']], 'any')}</select></div>`;
  el.innerHTML = `
    <div class="searchbar"><input id="q" type="search" placeholder="${esc(placeholder)}" autocomplete="off">
      ${ai.enabled ? '<button type="button" id="ask" title="Turn a sentence into filters">✨ Ask</button>' : ''}<button type="button" id="ftoggle">Filters</button></div>
    ${ai.enabled ? '<div class="muted small" style="margin:-4px 0 10px">Describe it in your own words — e.g. “the fridge from Home Depot last year” — and tap ✨ Ask.</div>' : ''}
    <div id="filters" class="card" hidden>
      <div class="grid">
        <div><label>Category</label><select id="f-category"><option value="">Any</option>${cats.map((c) => `<option>${esc(c)}</option>`).join('')}</select></div>
        ${extra}
        <div><label>Store / vendor</label><input id="f-vendor" autocomplete="off"></div>
        <div><label>${scope === 'items' ? 'Bought' : 'Dated'} from</label><input type="date" id="f-from"></div>
        <div><label>…to</label><input type="date" id="f-to"></div>
        <div><label>Price from ($)</label><input id="f-min" inputmode="decimal" placeholder="0"></div>
        <div><label>…to ($)</label><input id="f-max" inputmode="decimal" placeholder="any"></div>
        <div><label>Sort by</label><select id="f-sort">${opts(SORTS[scope], sort)}</select></div>
      </div>
      <div class="actions"><button type="button" id="fclear">Clear all filters</button></div>
    </div>
    <div id="chips" class="chips"></div><div id="count" class="muted small"></div><div id="list"></div>`;

  const num = (id) => { const v = $(id).value.trim(); return v === '' ? null : toCents(v); };
  const read = () => {
    f = { ...f, q: $('#q').value, category: $('#f-category').value, vendor: $('#f-vendor').value.trim(), from: $('#f-from').value, to: $('#f-to').value, min: num('#f-min'), max: num('#f-max') };
    if (scope === 'items') f.warranty = $('#f-warranty').value; else { f.billable = $('#f-billable').value; f.billing = $('#f-billing').value; }
    sort = $('#f-sort').value;
  };
  const write = () => {
    $('#q').value = f.q; $('#f-category').value = f.category; $('#f-vendor').value = f.vendor; $('#f-from').value = f.from; $('#f-to').value = f.to;
    $('#f-min').value = f.min === null ? '' : (f.min / 100).toString(); $('#f-max').value = f.max === null ? '' : (f.max / 100).toString();
    if (scope === 'items') $('#f-warranty').value = f.warranty; else { $('#f-billable').value = f.billable; $('#f-billing').value = f.billing; }
    $('#f-sort').value = sort;
  };
  const GROUPS = [['expiring', 'Warranty ending soon'], ['active', 'Under warranty'], ['unknown', 'Warranty unknown'], ['expired', 'Expired']];

  function refresh() {
    const t = today(), list = sortRecords(filterRecords(records, f, scope, t), sort, scope, t), chips = activeChips(f);
    $('#chips').innerHTML = chips.map((c) => `<button type="button" class="chip" data-chip="${c.key}">${esc(c.label)} ✕</button>`).join('');
    $('#count').textContent = records.length ? (hasFilters(f) ? `${list.length} of ${records.length}` : `${records.length}`) + (scope === 'items' ? ' items' : ' receipts') : '';
    $('#ftoggle').classList.toggle('on', chips.length > 0);
    if (!records.length) $('#list').innerHTML = '<p class="muted">Nothing here yet.</p>';
    else if (!list.length) $('#list').innerHTML = '<div class="card"><b>No matches</b><p class="muted">Try fewer words or clear a filter.</p><button type="button" id="fclear2">Clear everything</button></div>';
    else if (scope === 'items' && sort === 'warranty') {
      $('#list').innerHTML = GROUPS.map(([k, title]) => { const g = list.filter((i) => warrantyState(i, t).key === k); return g.length ? `<h2>${title} (${g.length})</h2>${g.map(renderRow).join('')}` : ''; }).join('');
    } else $('#list').innerHTML = list.map(renderRow).join('');
    if ($('#fclear2')) $('#fclear2').onclick = clearAll;
  }
  const clearAll = () => { f = emptyFilters(); sort = scope === 'items' ? 'warranty' : 'newest'; write(); refresh(); };

  el.addEventListener('input', (ev) => { if (ev.target.closest('#filters, #q')) { read(); refresh(); } });
  el.addEventListener('change', (ev) => { if (ev.target.closest('#filters')) { read(); refresh(); } });
  $('#ftoggle').onclick = () => { $('#filters').hidden = !$('#filters').hidden; };
  $('#fclear').onclick = clearAll;
  $('#chips').onclick = (ev) => { const c = ev.target.closest('[data-chip]'); if (c) { f = clearFilter(f, c.dataset.chip); write(); refresh(); } };
  if ($('#ask')) $('#ask').onclick = async () => {
    const text = $('#q').value.trim();
    if (!text) return toast('Type what you are looking for, then tap ✨ Ask');
    $('#ask').disabled = true; $('#ask').textContent = '✨ Thinking…';
    try {
      const { filters } = await api('POST', '/ai/search', { query: text, scope });
      f = { ...emptyFilters(), ...filters, q: '' }; $('#q').value = ''; write();
      if (activeChips(f).length) $('#filters').hidden = false;
      refresh(); toast(activeChips(f).length ? 'Here is what I understood — tap a chip to remove it' : 'I could not turn that into filters — try plain words', !activeChips(f).length);
    } catch (e) { toast(isNetworkError(e) ? 'Smart search needs a connection to the server' : e.message, true); }
    finally { $('#ask').disabled = false; $('#ask').textContent = '✨ Ask'; }
  };
  refresh();
}

// ------------------------------------------------------------------ household items / warranty
function warrantyPill(i) {
  const w = warrantyState(i, today());
  if (w.key === 'unknown') return { text: 'Warranty unknown', cls: 'nb' };
  if (w.key === 'expired') return { text: `Expired ${i.warranty_expires}`, cls: 'bad' };
  if (w.key === 'expiring') return { text: `Ends ${i.warranty_expires} (${w.days} day${w.days === 1 ? '' : 's'})`, cls: 'pending' };
  return { text: `Covered until ${i.warranty_expires}`, cls: '' };
}
const itemRow = (i) => { const w = warrantyPill(i); return `<a class="card row" href="#/household/${i.id}" style="flex-wrap:nowrap">
    ${i.has_image ? `<img class="thumb" loading="lazy" src="/api/items/${i.id}/image" alt="">` : '<div class="thumb"></div>'}
    <div class="grow"><div class="spread"><b>${esc(i.name)}</b><span class="money">${i.price ? money(i.price) : ''}</span></div>
    <div class="muted small">Bought ${esc(i.purchase_date)}${i.vendor ? ' · ' + esc(i.vendor) : ''}${i.category ? ' · ' + esc(i.category) : ''}</div>
    <span class="pill ${w.cls}">${esc(w.text)}</span></div></a>`; };

async function viewItems() {
  const items = await api('GET', '/items');
  app.innerHTML = `<h1>Household items &amp; warranties</h1>
    <p class="muted">Big purchases you may need proof of later — shared with everyone on this server.</p>
    <div class="actions"><a class="btn pri" href="#/household/new">＋ Add item</a><a class="btn" href="/api/items.csv">CSV</a></div>
    <div id="search"></div>`;
  await mountSearch({ el: $('#search'), scope: 'items', records: items, renderRow: itemRow, categories: meta.item_categories, placeholder: 'Search name, store, serial, notes, receipt text…' });
}

const receiptRow = (r) => `<a class="card row" href="#/r/${r.id}" style="flex-wrap:nowrap">
    ${r.has_image ? `<img class="thumb" loading="lazy" src="/api/receipts/${r.id}/image" alt="">` : '<div class="thumb"></div>'}
    <div class="grow"><div class="spread"><b>#${pad(r.number)} ${esc(r.description || r.vendor || 'Receipt')}</b><span class="money"><b>${money(r.total)}</b></span></div>
    <div class="muted small">${esc(r.project_name)} · ${esc(r.date)}${r.vendor ? ' · ' + esc(r.vendor) : ''}${r.category ? ' · ' + esc(r.category) : ''}</div>
    <div class="row small"><span class="pill ${r.billable ? '' : 'nb'}">${r.billable ? 'Billable' : 'Non-billable'}</span>${r.billable && r.billing_status !== 'unbilled' ? `<span class="pill pending">${esc(r.billing_status)}${r.invoice_ref ? ' ' + esc(r.invoice_ref) : ''}</span>` : ''}</div></div></a>`;

async function viewSearch() {
  const receipts = await api('GET', '/receipts');
  app.innerHTML = '<p><a href="#/">← Projects</a></p><h1>Search receipts</h1><div id="search"></div>';
  await mountSearch({ el: $('#search'), scope: 'receipts', records: receipts, renderRow: receiptRow, categories: meta.receipt_categories, placeholder: 'Search vendor, description, project, invoice #, receipt text…' });
}

async function viewItemForm({ itemId }) {
  const i = itemId ? await api('GET', `/items/${itemId}`) : null;
  const v = i || { name: '', category: '', purchase_date: today(), vendor: '', price: 0, warranty_months: null, serial: '', notes: '' };
  const yrs = v.warranty_months && v.warranty_months % 12 === 0;
  const wval = v.warranty_months ? (yrs ? v.warranty_months / 12 : v.warranty_months) : '';

  app.innerHTML = `<p><a href="#/household">← Household</a></p><h1>${i ? esc(i.name) : 'New item'}</h1>
    <form id="f" class="card">
      ${photoField(i?.has_image ? `/api/items/${i.id}/image` : '')}
      <label>Item</label><input name="name" value="${esc(v.name)}" required placeholder="e.g. Samsung 65&quot; TV">
      <div class="grid"><div><label>Purchase date</label><input type="date" name="purchase_date" value="${esc(v.purchase_date)}" required></div>
        <div><label>Price</label><input name="price" inputmode="decimal" value="${fromCents(v.price)}" placeholder="0.00"></div></div>
      <div class="grid"><div><label>Vendor</label><input name="vendor" value="${esc(v.vendor)}"></div>
        <div><label>Category</label><input name="category" list="icats" value="${esc(v.category)}"><datalist id="icats">${catOptions(meta.item_categories)}</datalist></div></div>
      <label>Warranty length <span class="muted small">(leave blank if unknown)</span></label>
      <div class="grid"><input name="wnum" inputmode="numeric" value="${wval}" placeholder="e.g. 2">
        <select name="wunit"><option value="12" ${yrs || !v.warranty_months ? 'selected' : ''}>years</option><option value="1" ${v.warranty_months && !yrs ? 'selected' : ''}>months</option></select></div>
      <div class="muted" id="wends" style="margin-top:6px"></div>
      <label>Serial / model number</label><input name="serial" value="${esc(v.serial)}">
      <label>Notes</label><textarea name="notes" rows="2">${esc(v.notes)}</textarea>
      <div class="actions"><button class="pri" id="save">Save</button>${i ? '<button type="button" class="danger" id="del">Delete</button>' : ''}</div>
    </form>`;
  const form = $('#f');
  const months = () => { const n = parseInt(form.wnum.value, 10); return n > 0 ? n * Number(form.wunit.value) : null; };
  const showEnds = () => {
    const m = months();
    if (!m || !form.purchase_date.value) return ($('#wends').textContent = '');
    const d = new Date(form.purchase_date.value + 'T00:00:00Z'), day = d.getUTCDate();
    d.setUTCMonth(d.getUTCMonth() + m); if (d.getUTCDate() !== day) d.setUTCDate(0);
    $('#wends').textContent = `Warranty ends ${d.toISOString().slice(0, 10)}`;
  };
  ['wnum', 'wunit', 'purchase_date'].forEach((n) => form[n].addEventListener('input', showEnds)); showEnds();

  const photo = wirePhoto((text) => {                      // OCR: purchase date, vendor and price (the receipt total)
    const p = parseReceiptText(text);
    const price = p.total ?? (p.subtotal !== null ? p.subtotal + (p.gst ?? 0) + (p.pst ?? 0) + (p.tip ?? 0) : null);
    const filled = [];
    if (scanFill(form.vendor, p.vendor)) filled.push('vendor');
    if (scanFill(form.purchase_date, p.date, form.purchase_date.value === today())) { filled.push('date'); showEnds(); }
    if (price !== null && scanFill(form.price, fromCents(price))) filled.push('price');
    showScanMsg(filled.length ? `Filled from the photo: <b>${filled.join(', ')}</b>. Check the highlighted fields, then add the item name.` : 'Couldn’t pick out any details from that photo.', !filled.length);
  });

  form.onsubmit = async (ev) => {
    ev.preventDefault();
    const data = { name: form.name.value, purchase_date: form.purchase_date.value, vendor: form.vendor.value, category: form.category.value.trim(),
      price: toCents(form.price.value), warranty_months: months(), serial: form.serial.value, notes: form.notes.value };
    $('#save').disabled = true;
    try {
      if (photo.text) data.ocr_text = photo.text;
      if (i) {
        if (photo.data) data.image = photo.data; else if (photo.remove) data.remove_image = true;
        await api('PATCH', `/items/${i.id}`, data);
      } else {
        if (photo.data) data.image = photo.data;
        const out = await createRecord('/items', data, { label: data.name });
        if (out === 'cancelled') { $('#save').disabled = false; return; }
      }
      location.hash = '#/household';
    } catch (e) { toast(isNetworkError(e) ? 'Editing needs a connection' : e.message, true); $('#save').disabled = false; }
  };
  if ($('#del')) $('#del').onclick = async () => { if (confirm('Delete this item?')) { await api('DELETE', `/items/${i.id}`); location.hash = '#/household'; } };
}

// ------------------------------------------------------------------ settings (account, users, backup)
async function viewSettings() {
  const admin = me.role === 'admin';
  const [users, bk, aiCfg] = admin ? await Promise.all([api('GET', '/users'), api('GET', '/backup'), api('GET', '/ai')]) : [[], null, null];
  const when = (s) => (s ? new Date(s).toLocaleString() : 'never');

  app.innerHTML = `<h1>Settings</h1>
    <div class="card"><h2 style="margin-top:0">Account — ${esc(me.username)}${admin ? ' <span class="pill">admin</span>' : ''}</h2>
      <form id="pw"><label>Current password</label><input type="password" name="current" autocomplete="current-password" required>
      <label>New password (8+ characters)</label><input type="password" name="password" autocomplete="new-password" required>
      <div class="actions"><button class="pri">Change password</button><button type="button" id="out">Sign out</button></div></form></div>
    ${admin ? `
    <div class="card"><h2 style="margin-top:0">Users</h2>
      ${users.map((u) => `<div class="row" style="padding:6px 0;border-bottom:1px solid var(--line)">
        <div class="grow"><b>${esc(u.username)}</b> <span class="pill ${u.role === 'admin' ? '' : 'nb'}">${u.role}</span> <span class="muted small">${u.projects} project${u.projects === 1 ? '' : 's'}</span></div>
        <button data-reset="${u.id}" data-name="${esc(u.username)}">Reset password</button>
        ${u.id === me.id ? '' : `<button data-role="${u.id}" data-to="${u.role === 'admin' ? 'user' : 'admin'}">Make ${u.role === 'admin' ? 'user' : 'admin'}</button><button class="danger" data-rm="${u.id}" data-name="${esc(u.username)}">Delete</button>`}</div>`).join('')}
      <form id="newu" style="margin-top:12px"><h2>Add user</h2><div class="grid"><div><label>Username</label><input name="username" required autocapitalize="none"></div>
        <div><label>Temporary password</label><input name="password" type="password" required autocomplete="new-password"></div></div>
        <label class="check"><input type="checkbox" name="admin"> Administrator</label><p><button class="pri">Add user</button></p></form></div>

    <div class="card"><h2 style="margin-top:0">Local AI <span class="muted small">(optional)</span></h2>
      <p class="muted small">Connect any OpenAI-compatible server on your network (Ollama, LM Studio, llama.cpp, vLLM…). It double-checks new work receipts against the receipt and powers “✨ Ask” search. Requests go only to the address below.</p>
      <form id="aiform">
        <label class="check"><input type="checkbox" name="enabled" ${aiCfg.enabled ? 'checked' : ''}> Turn on AI features</label>
        <label>Server address <span class="muted small">Ollama: <code>http://localhost:11434/v1</code> · LM Studio: <code>http://localhost:1234/v1</code></span></label>
        <input name="base_url" value="${esc(aiCfg.base_url)}" autocapitalize="none">
        <label>Model name</label><input name="model" list="aimodels" value="${esc(aiCfg.model)}" autocapitalize="none" placeholder="e.g. qwen2.5vl:7b"><datalist id="aimodels"></datalist>
        <label>API key <span class="muted small">(only if your server needs one)</span></label>
        <input name="api_key" type="password" autocomplete="off" placeholder="${aiCfg.has_key ? 'saved — leave blank to keep it' : ''}">
        ${aiCfg.has_key ? '<label class="check"><input type="checkbox" name="clear_key"> Remove the saved key</label>' : ''}
        <label class="check"><input type="checkbox" name="vision" ${aiCfg.vision ? 'checked' : ''}> This model can look at images (a vision model such as llava, qwen2.5-vl, gemma3). Off = it reads the text scanned from the photo instead.</label>
        <label class="check"><input type="checkbox" name="auto_check" ${aiCfg.auto_check ? 'checked' : ''}> Check new work receipts automatically after they are saved</label>
        <label>Wait up to (seconds) <span class="muted small">— local models can be slow</span></label><input name="timeout_s" inputmode="numeric" value="${aiCfg.timeout_s}">
        <div class="actions"><button class="pri">Save AI settings</button><button type="button" id="aitest">Test connection</button></div>
        <div id="aiout" class="small"></div></form></div>

    <div class="card"><h2 style="margin-top:0">Backup</h2>
      <p class="muted small">Backs up the whole app (all users' receipts, household items, accounts and images). Last attempt: ${esc(when(bk.status.last_at))}
        · last success: ${esc(when(bk.status.last_ok))}</p>
      ${bk.status.last_message ? `<p class="small ${/FAILED/.test(bk.status.last_message) ? 'errtext' : 'muted'}">${esc(bk.status.last_message)}</p>` : ''}
      <form id="bk">
        <label class="check"><input type="checkbox" name="enabled" ${bk.config.enabled ? 'checked' : ''}> Back up automatically</label>
        <div class="grid"><div><label>Every (hours)</label><input name="interval_hours" inputmode="numeric" value="${bk.config.interval_hours}"></div>
          <div><label>Copies to keep</label><input name="keep" inputmode="numeric" value="${bk.config.keep}"></div></div>
        <label>Google Drive (or any rclone remote) <span class="muted small">e.g. <code>gdrive:ReceiptBoss</code> — set up once with <code>rclone config</code>, see README</span></label>
        <input name="remote" value="${esc(bk.config.remote)}" placeholder="gdrive:ReceiptBoss" autocapitalize="none">
        <label>Also copy to folder on the server <span class="muted small">(optional; e.g. a NAS or Drive-for-desktop folder)</span></label>
        <input name="copy_dir" value="${esc(bk.config.copy_dir)}" placeholder="/mnt/nas/receipt-boss-backups" autocapitalize="none">
        <div class="actions"><button class="pri">Save backup settings</button><button type="button" id="bkrun">Back up now</button><a class="btn" href="/api/backup/download">⬇ Download backup</a></div></form>
      ${bk.files.length ? `<div class="muted small">On this server: ${bk.files.map((f) => `<a href="/api/backup/files/${f.name}">${esc(f.name.replace('receipt-boss-backup-', '').replace('.zip', ''))}</a> (${(f.size / 1048576).toFixed(1)} MB)`).join(' · ')}</div>` : ''}
    </div>` : ''}`;

  $('#out').onclick = logout;
  $('#pw').onsubmit = async (ev) => {
    ev.preventDefault();
    try { await api('POST', '/auth/password', Object.fromEntries(new FormData(ev.target))); ev.target.reset(); toast('Password changed; other devices were signed out'); }
    catch (e) { toast(e.message, true); }
  };
  if (!admin) return;
  const guard = (fn) => async (...a) => { try { await fn(...a); await viewSettings(); } catch (e) { toast(e.message, true); } };
  $('#newu').onsubmit = guard(async (ev) => {
    ev.preventDefault(); const f = new FormData(ev.target);
    await api('POST', '/users', { username: f.get('username'), password: f.get('password'), role: f.get('admin') ? 'admin' : 'user' }); toast('User added');
  });
  app.querySelectorAll('[data-reset]').forEach((b) => (b.onclick = guard(async () => {
    const pw = prompt(`New password for ${b.dataset.name} (8+ characters). They will be signed out everywhere.`);
    if (pw) { await api('PATCH', `/users/${b.dataset.reset}`, { password: pw }); toast('Password reset'); }
  })));
  app.querySelectorAll('[data-role]').forEach((b) => (b.onclick = guard(() => api('PATCH', `/users/${b.dataset.role}`, { role: b.dataset.to }))));
  app.querySelectorAll('[data-rm]').forEach((b) => (b.onclick = guard(async () => {
    if (confirm(`Delete ${b.dataset.name} and ALL of their projects and receipts? This cannot be undone.`)) await api('DELETE', `/users/${b.dataset.rm}`);
  })));
  const aiBody = () => {
    const f = new FormData($('#aiform'));
    return { enabled: !!f.get('enabled'), base_url: f.get('base_url'), model: f.get('model'), api_key: f.get('api_key'), clear_key: !!f.get('clear_key'),
      vision: !!f.get('vision'), auto_check: !!f.get('auto_check'), timeout_s: Number(f.get('timeout_s')) };
  };
  $('#aiform').onsubmit = guard(async (ev) => { ev.preventDefault(); await api('PUT', '/ai', aiBody()); aiState = null; toast('AI settings saved'); });
  $('#aitest').onclick = async () => {
    const out = $('#aiout'); out.className = 'small muted'; out.textContent = 'Testing…';
    try {
      await api('PUT', '/ai', aiBody()); aiState = null;                    // test what is on screen
      const r = await api('POST', '/ai/test', {});
      out.className = 'small'; out.style.color = 'var(--pri-d)';
      out.textContent = `✓ Connected in ${(r.ms / 1000).toFixed(1)}s — the model replied “${r.reply}”.` + (r.model_listed ? '' : ' (That model name is not in the server’s list — check the spelling.)') + (r.models.length ? ` Models available: ${r.models.join(', ')}` : '');
      $('#aimodels').innerHTML = r.models.map((m) => `<option value="${esc(m)}">`).join('');
    } catch (e) { out.className = 'small errtext'; out.style.color = ''; out.textContent = '✗ ' + e.message; }
  };
  $('#bk').onsubmit = guard(async (ev) => {
    ev.preventDefault(); const f = new FormData(ev.target);
    await api('PUT', '/backup', { enabled: !!f.get('enabled'), interval_hours: Number(f.get('interval_hours')), keep: Number(f.get('keep')), remote: f.get('remote'), copy_dir: f.get('copy_dir') });
    toast('Backup settings saved');
  });
  $('#bkrun').onclick = guard(async () => {
    $('#bkrun').disabled = true; toast('Backing up…');
    try { const r = await api('POST', '/backup/run', {}); toast(r.message); }
    catch (e) { toast(e.message, true); }
  });
}

// ------------------------------------------------------------------ boot
async function start() {
  renderNav('projects');
  await renderBanner();
  route();
  flushQueue();
}
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
renderNet();
(async () => {
  try {
    const st = await api('GET', '/auth/status');   // served from cache when offline
    if (st.user) { me = st.user; return start(); }
  } catch (e) { if (!isNetworkError(e)) console.error(e); }
  showAuth();
})();
