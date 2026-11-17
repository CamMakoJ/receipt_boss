// "Vendor memory": learn from past receipts which category / billable setting a store usually gets.
// Pure functions (no DOM) shared by the server (builds the index) and the browser (looks things up); unit-tested.

/** "HOME DEPOT #7011", "Home Depot Canada Inc." and "home depot 7011" are all the same store: "home depot". */
export function normVendor(s) {
  return String(s || '').toLowerCase()
    .replace(/#\s*\d+/g, ' ')                                    // store numbers
    .replace(/\b(inc|ltd|llc|corp|corporation|co|canada|ulc)\b\.?/g, ' ')
    .replace(/[^a-z0-9& ]+/g, ' ')
    .replace(/\s+\d+\s*$/, ' ')                                  // trailing store number
    .replace(/\s+/g, ' ').trim();
}

const MIN_COUNT = 2, CATEGORY_SHARE = 0.6, BILLABLE_SHARE = 0.7;

/**
 * rows: [{ vendor, category, billable (0/1/undefined), date }] -> compact list, most-used first:
 * [{ key, name, count, category, cshare, billable, bshare }]   (name = the most recent spelling, without a trailing store number)
 */
export function buildVendorIndex(rows) {
  const by = new Map();
  for (const r of rows) {
    const key = normVendor(r.vendor);
    if (!key) continue;
    const e = by.get(key) || { key, name: r.vendor, last: '', count: 0, cats: new Map(), bill: { yes: 0, no: 0 } };
    e.count++;
    if ((r.date || '') >= e.last) { e.last = r.date || ''; e.name = String(r.vendor).replace(/\s*#\s*\d+\s*$/, '').trim() || String(r.vendor).trim(); }   // shown without the store number
    if (r.category) e.cats.set(r.category, (e.cats.get(r.category) || 0) + 1);
    if (r.billable === 1 || r.billable === true) e.bill.yes++; else if (r.billable === 0 || r.billable === false) e.bill.no++;
    by.set(key, e);
  }
  return [...by.values()].map((e) => {
    const catTotal = [...e.cats.values()].reduce((a, b) => a + b, 0);
    const [category, cn] = [...e.cats.entries()].sort((a, b) => b[1] - a[1])[0] || ['', 0];
    const billTotal = e.bill.yes + e.bill.no, billable = e.bill.yes >= e.bill.no ? 1 : 0;
    return { key: e.key, name: e.name, count: e.count, category, cshare: catTotal ? cn / catTotal : 0,
      billable: billTotal ? billable : null, bshare: billTotal ? Math.max(e.bill.yes, e.bill.no) / billTotal : 0 };
  }).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

export const indexByKey = (list) => new Map(list.map((e) => [e.key, e]));

/**
 * What to pre-fill for this vendor text, or null. Only once the pattern is clear: seen at least twice, and the
 * category / billable choice is the clear majority. { entry, category: '' | 'Materials', billable: null | 0 | 1 }
 */
export function suggestFor(map, text) {
  const e = map.get(normVendor(text));
  if (!e || e.count < MIN_COUNT) return null;
  const category = e.category && e.cshare >= CATEGORY_SHARE ? e.category : '';
  const billable = e.billable !== null && e.bshare >= BILLABLE_SHARE ? e.billable : null;
  return category || billable !== null ? { entry: e, category, billable } : null;
}
