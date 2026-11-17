// Shared receipt/project rules and queries, used by the route modules.
import { db } from './db.js';
import { total } from './util.js';
import { err, str, cents, dateStr } from './http.js';
import { photosOf, photosMap } from './photos.js';
import { isProvince, calcTax } from './tax.js';
import { aiReady, aiConfig, parseCheck } from './ai.js';

export const BILLING = ['unbilled', 'invoiced', 'paid'];
export const province = (v) => { if (!isProvince(v)) throw err(400, 'invalid province code'); return v; };

// ---------------------------------------------------------------- lookups (always scoped to the signed-in user)
export function getProject(id, user) {
  const p = db.prepare('SELECT * FROM projects WHERE id = ? AND user_id = ?').get(id, user.id);
  if (!p) throw err(404, 'project not found');
  return p;
}
export function getReceipt(id, user) {
  const r = db.prepare('SELECT r.* FROM receipts r JOIN projects p ON p.id = r.project_id WHERE r.id = ? AND p.user_id = ?').get(id, user.id);
  if (!r) throw err(404, 'receipt not found');
  return r;
}
/** Filed receipts of a project (drafts are excluded everywhere that counts or reports). */
export function projectReceipts(id, from, to) {
  let sql = 'SELECT * FROM receipts WHERE project_id = ? AND draft = 0';
  const args = [id];
  if (from) { sql += ' AND date >= ?'; args.push(from); }
  if (to) { sql += ' AND date <= ?'; args.push(to); }
  return db.prepare(sql + ' ORDER BY number').all(...args);
}

// ---------------------------------------------------------------- shaping rows for the API
export function publicReceipt({ ocr_text, check_json, check_status, photos, ...r }) {
  return {
    ...r, billable: !!r.billable, tax_auto: !!r.tax_auto, draft: !!r.draft, total: total(r), has_image: !!r.image, has_text: !!ocr_text, image: undefined,
    photos: (photos || []).map((x) => x.id),                       // ids in order; the first is the cover
    check: parseCheck({ check_status, check_json }),
  };
}
export const withPhotos = (rows) => { const m = photosMap('receipt', rows.map((r) => r.id)); return rows.map((r) => ({ ...r, photos: m[r.id] || [] })); };
export const full = (row) => publicReceipt({ ...row, photos: photosOf('receipt', row.id) });

/**
 * Totals for many projects in ONE grouped query (instead of loading every receipt of every project).
 * Returns the project rows with billable / non_billable / all / billing{unbilled,invoiced,paid} = {count, subtotal, gst, pst, tip, total}.
 */
export function withTotals(projects) {
  if (!projects.length) return [];
  const ids = projects.map((p) => p.id);
  const rows = db.prepare(`SELECT project_id, billable, billing_status, COUNT(*) AS count, SUM(subtotal) AS subtotal, SUM(gst) AS gst, SUM(pst) AS pst, SUM(tip) AS tip
    FROM receipts WHERE draft = 0 AND project_id IN (${ids.map(() => '?').join(',')}) GROUP BY project_id, billable, billing_status`).all(...ids);
  const zero = () => ({ count: 0, subtotal: 0, gst: 0, pst: 0, tip: 0, total: 0 });
  const add = (t, r) => { t.count += r.count; t.subtotal += r.subtotal; t.gst += r.gst; t.pst += r.pst; t.tip += r.tip; t.total += r.subtotal + r.gst + r.pst + r.tip; };
  const by = new Map(ids.map((id) => [id, { billable: zero(), non_billable: zero(), all: zero(), billing: Object.fromEntries(BILLING.map((b) => [b, zero()])) }]));
  for (const r of rows) {
    const t = by.get(r.project_id);
    add(t.all, r);
    if (r.billable) { add(t.billable, r); add(t.billing[r.billing_status], r); } else add(t.non_billable, r);
  }
  return projects.map((p) => ({ ...p, user_id: undefined, archived: !!p.archived, ...by.get(p.id) }));
}
export const projectSummary = (p) => withTotals([p])[0];

// ---------------------------------------------------------------- receipt rules
/** Validates body fields, falling back to `existing`; applies province tax + category->description rules. */
export function receiptFields(b, existing, project) {
  const pick = (k, f) => (b[k] !== undefined ? f(b[k]) : existing?.[k]);
  const f = {
    date: pick('date', dateStr) ?? new Date().toISOString().slice(0, 10),
    vendor: pick('vendor', (v) => str(v, 200)) ?? '',
    category: pick('category', (v) => str(v, 60)) ?? '',
    description: pick('description', (v) => str(v, 300)) ?? '',
    province: pick('province', province) ?? project.province,
    subtotal: pick('subtotal', (v) => cents(v, 'subtotal')) ?? 0,
    gst: pick('gst', (v) => cents(v, 'gst')) ?? 0,
    pst: pick('pst', (v) => cents(v, 'pst')) ?? 0,
    tip: pick('tip', (v) => cents(v, 'tip')) ?? 0,
    billable: pick('billable', (v) => (v ? 1 : 0)) ?? 1,
    tax_auto: pick('tax_auto', (v) => (v ? 1 : 0)) ?? 0,
    notes: pick('notes', (v) => str(v, 2000)) ?? '',
    ocr_text: pick('ocr_text', (v) => str(v, 8000)) ?? '',
    billing_status: pick('billing_status', (v) => { if (!BILLING.includes(v)) throw err(400, 'invalid billing status'); return v; }) ?? 'unbilled',
    invoice_ref: pick('invoice_ref', (v) => str(v, 60)) ?? '',
  };
  if (b.ocr_append) f.ocr_text = `${f.ocr_text}\n\n${str(b.ocr_append, 8000)}`.trim().slice(0, 8000);   // another page was scanned: keep the earlier text too
  if (f.tax_auto) Object.assign(f, calcTax(f.subtotal, f.province));                                     // server is the authority on auto taxes
  if (!f.description) f.description = f.category;                                                        // description defaults to the category
  return f;
}

/** Same day, same vendor (or description), same total, anywhere in this user's filed receipts. */
export function findDuplicates(user, f, excludeId = 0) {
  const t = f.subtotal + f.gst + f.pst + f.tip, label = (f.vendor || f.description || '').trim().toLowerCase();
  if (!t || !label) return [];
  return db.prepare(`SELECT r.id, r.number, r.description, r.vendor, r.date, p.id AS project_id, p.name AS project_name, (r.subtotal + r.gst + r.pst + r.tip) AS total
    FROM receipts r JOIN projects p ON p.id = r.project_id
    WHERE r.date = ? AND r.draft = 0 AND p.user_id = ? AND r.id != ? AND (r.subtotal + r.gst + r.pst + r.tip) = ?
      AND lower(trim(CASE WHEN r.vendor != '' THEN r.vendor ELSE r.description END)) = ?`).all(f.date, user.id, excludeId, t, label);
}
export const duplicateError = (duplicates) => err(409, 'This looks like a receipt you already entered', { duplicates });

export const needsCheck = (image, text) => aiReady() && aiConfig().auto_check && !!(image || text);
