// Search + filter logic shared by the Household page and the receipt search page. Pure (no DOM) so it is unit-tested.
// A filter object looks the same whether it was typed into the controls or produced by the AI "smart search".

export const emptyFilters = () => ({ q: '', any: [], category: '', vendor: '', from: '', to: '', min: null, max: null, warranty: 'any', billable: 'any', billing: 'any' });

const SCOPES = {
  items:    { text: ['name', 'vendor', 'category', 'serial', 'notes', 'ocr_text'], date: 'purchase_date', amount: 'price' },
  receipts: { text: ['description', 'vendor', 'category', 'notes', 'ocr_text', 'project_name', 'invoice_ref'], date: 'date', amount: 'total' },
};

/** Where an item's warranty stands. "expiring" = ends within 90 days; "active" also covers those. */
export function warrantyState(item, today) {
  if (!item.warranty_expires) return { key: 'unknown', days: null };
  const days = Math.round((Date.parse(item.warranty_expires) - Date.parse(today)) / 864e5);
  return { key: days < 0 ? 'expired' : days <= 90 ? 'expiring' : 'active', days };
}

const hay = (rec, scope) => SCOPES[scope].text.map((k) => rec[k] ?? '').join(' \n ').toLowerCase()
  + (scope === 'receipts' ? ` #${String(rec.number ?? '').padStart(3, '0')}` : '');

export function matches(rec, f, scope, today) {
  const cfg = SCOPES[scope], text = hay(rec, scope);
  for (const w of f.q.toLowerCase().split(/\s+/).filter(Boolean)) if (!text.includes(w)) return false;       // typed words: ALL must match
  if (f.any.length && !f.any.some((w) => text.includes(w.toLowerCase()))) return false;                       // AI synonyms: ANY may match
  if (f.category && (rec.category || '').toLowerCase() !== f.category.toLowerCase()) return false;
  if (f.vendor && !(rec.vendor || '').toLowerCase().includes(f.vendor.toLowerCase())) return false;
  const d = rec[cfg.date] || '';
  if (f.from && d < f.from) return false;
  if (f.to && d > f.to) return false;
  const amt = rec[cfg.amount] ?? 0;
  if (f.min !== null && amt < f.min) return false;
  if (f.max !== null && amt > f.max) return false;
  if (scope === 'items' && f.warranty !== 'any') {
    const k = warrantyState(rec, today).key;
    if (f.warranty === 'active' ? !(k === 'active' || k === 'expiring') : k !== f.warranty) return false;
  }
  if (scope === 'receipts') {
    if (f.billable === 'yes' && !rec.billable) return false;
    if (f.billable === 'no' && rec.billable) return false;
    if (f.billing !== 'any' && !(rec.billable && rec.billing_status === f.billing)) return false;
  }
  return true;
}

export const filterRecords = (list, f, scope, today) => list.filter((r) => matches(r, f, scope, today));

export const SORTS = {
  items: [['warranty', 'Warranty (soonest end first)'], ['newest', 'Newest purchase'], ['oldest', 'Oldest purchase'], ['price_desc', 'Price: high to low'], ['price_asc', 'Price: low to high'], ['name', 'Name A–Z']],
  receipts: [['newest', 'Newest'], ['oldest', 'Oldest'], ['amount_desc', 'Amount: high to low'], ['amount_asc', 'Amount: low to high']],
};

export function sortRecords(list, sort, scope, today) {
  const cfg = SCOPES[scope], out = [...list];
  const date = (r) => r[cfg.date] || '', amt = (r) => r[cfg.amount] ?? 0;
  const by = {
    newest: (a, b) => date(b).localeCompare(date(a)), oldest: (a, b) => date(a).localeCompare(date(b)),
    price_desc: (a, b) => amt(b) - amt(a), price_asc: (a, b) => amt(a) - amt(b), amount_desc: (a, b) => amt(b) - amt(a), amount_asc: (a, b) => amt(a) - amt(b),
    name: (a, b) => (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' }),
    warranty: (a, b) => {                      // covered ones by soonest end, then unknown, then expired (most recent first)
      const A = warrantyState(a, today), B = warrantyState(b, today), rank = (s) => (s.key === 'expired' ? 2 : s.key === 'unknown' ? 1 : 0);
      return rank(A) - rank(B) || (A.key === 'expired' ? B.days - A.days : (A.days ?? 0) - (B.days ?? 0)) || date(b).localeCompare(date(a));
    },
  };
  return out.sort(by[sort] || by.newest);
}

const $ = (c) => '$' + (c / 100).toLocaleString('en-CA', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const LABELS = { active: 'Under warranty', expiring: 'Ending within 90 days', expired: 'Expired', unknown: 'Warranty unknown' };

/** Removable "chips" describing the active (non-text) filters, so you can see what the AI understood. */
export function activeChips(f) {
  const chips = [];
  if (f.any.length) chips.push({ key: 'any', label: `Matching: ${f.any.join(', ')}` });
  if (f.category) chips.push({ key: 'category', label: `Category: ${f.category}` });
  if (f.vendor) chips.push({ key: 'vendor', label: `Vendor: ${f.vendor}` });
  if (f.from || f.to) chips.push({ key: 'date', label: f.from && f.to ? `${f.from} → ${f.to}` : f.from ? `From ${f.from}` : `Until ${f.to}` });
  if (f.min !== null || f.max !== null) chips.push({ key: 'price', label: f.min !== null && f.max !== null ? `${$(f.min)} – ${$(f.max)}` : f.min !== null ? `Over ${$(f.min)}` : `Under ${$(f.max)}` });
  if (f.warranty !== 'any') chips.push({ key: 'warranty', label: LABELS[f.warranty] });
  if (f.billable !== 'any') chips.push({ key: 'billable', label: f.billable === 'yes' ? 'Billable' : 'Non-billable' });
  if (f.billing !== 'any') chips.push({ key: 'billing', label: `Status: ${f.billing}` });
  return chips;
}

export function clearFilter(f, key) {
  const e = emptyFilters();
  const reset = { any: ['any'], category: ['category'], vendor: ['vendor'], date: ['from', 'to'], price: ['min', 'max'], warranty: ['warranty'], billable: ['billable'], billing: ['billing'] }[key] || [];
  return { ...f, ...Object.fromEntries(reset.map((k) => [k, e[k]])) };
}

export const hasFilters = (f) => !!f.q.trim() || activeChips(f).length > 0;
