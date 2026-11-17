import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyFilters, filterRecords, sortRecords, activeChips, clearFilter, warrantyState, hasFilters } from '../public/filters.js';

const TODAY = '2026-06-15';
const items = [
  { id: 1, name: 'Samsung 65" TV', vendor: 'Best Buy', category: 'Electronics', purchase_date: '2025-06-30', price: 129999, warranty_expires: '2027-06-30', serial: 'QN90D-123', notes: '', ocr_text: 'BEST BUY\nSAMSUNG QN65' },
  { id: 2, name: 'LG fridge', vendor: 'Home Depot', category: 'Appliance', purchase_date: '2024-03-01', price: 179900, warranty_expires: '2026-03-01', serial: '', notes: 'water dispenser', ocr_text: '' },
  { id: 3, name: 'Dyson vacuum', vendor: 'Costco', category: 'Appliance', purchase_date: '2025-11-20', price: 59900, warranty_expires: '2026-08-20', serial: '', notes: '', ocr_text: 'COSTCO WHOLESALE' },
  { id: 4, name: 'Toaster', vendor: 'Canadian Tire', category: 'Appliance', purchase_date: '2023-01-10', price: 3999, warranty_expires: null, serial: '', notes: '', ocr_text: '' },
];
const F = (o) => ({ ...emptyFilters(), ...o });
const ids = (list) => list.map((r) => r.id);
const run = (o, sort = 'newest') => ids(sortRecords(filterRecords(items, F(o), 'items', TODAY), sort, 'items', TODAY));

test('warranty states', () => {
  assert.deepEqual(items.map((i) => warrantyState(i, TODAY).key), ['active', 'expired', 'expiring', 'unknown']);
  assert.equal(warrantyState(items[2], TODAY).days, 66);
});

test('typed words are ANDed across name, vendor, category, serial, notes and scanned text', () => {
  assert.deepEqual(run({ q: 'samsung' }), [1]);
  assert.deepEqual(run({ q: 'best buy' }), [1]);                 // vendor + OCR text
  assert.deepEqual(run({ q: 'water' }), [2]);                    // notes
  assert.deepEqual(run({ q: 'qn90d' }), [1]);                    // serial
  assert.deepEqual(run({ q: 'wholesale' }), [3]);                // text read from the receipt photo only
  assert.deepEqual(run({ q: 'appliance dyson' }), [3]);          // both words must match
  assert.deepEqual(run({ q: 'appliance nothing' }), []);
  assert.deepEqual(run({ q: '  ' }), [3, 1, 2, 4]);
});

test('AI synonyms are ORed', () => {
  assert.deepEqual(run({ any: ['refrigerator', 'fridge'] }), [2]);
  assert.deepEqual(run({ any: ['tv', 'television'], q: 'samsung' }), [1]);
});

test('category, vendor, dates, price', () => {
  assert.deepEqual(run({ category: 'appliance' }), [3, 2, 4]);
  assert.deepEqual(run({ vendor: 'depot' }), [2]);
  assert.deepEqual(run({ from: '2025-01-01', to: '2025-12-31' }), [3, 1]);
  assert.deepEqual(run({ from: '2025-11-20', to: '2025-11-20' }), [3]);          // inclusive bounds
  assert.deepEqual(run({ min: 100000 }), [1, 2]);
  assert.deepEqual(run({ max: 59900 }), [3, 4]);
  assert.deepEqual(run({ min: 50000, max: 130000 }), [3, 1]);
});

test('warranty filter: active includes ending-soon; expiring, expired, unknown', () => {
  assert.deepEqual(run({ warranty: 'active' }), [3, 1]);
  assert.deepEqual(run({ warranty: 'expiring' }), [3]);
  assert.deepEqual(run({ warranty: 'expired' }), [2]);
  assert.deepEqual(run({ warranty: 'unknown' }), [4]);
});

test('sorting: warranty order puts covered (soonest end) before unknown before expired', () => {
  assert.deepEqual(run({}, 'warranty'), [3, 1, 4, 2]);
  assert.deepEqual(run({}, 'oldest'), [4, 2, 1, 3]);
  assert.deepEqual(run({}, 'price_desc'), [2, 1, 3, 4]);
  assert.deepEqual(run({}, 'price_asc'), [4, 3, 1, 2]);
  assert.deepEqual(run({}, 'name'), [1, 3, 2, 4].sort((a, b) => items[a - 1].name.localeCompare(items[b - 1].name)));
});

test('receipt scope: billable / billing status / project name / receipt number', () => {
  const rs = [
    { id: 1, number: 1, description: 'Lumber', vendor: 'Home Depot', category: 'Materials', date: '2026-03-01', total: 9492, billable: true, billing_status: 'invoiced', project_name: 'Deck', invoice_ref: 'INV-1' },
    { id: 2, number: 2, description: 'Lunch', vendor: 'Pub', category: 'Meals', date: '2026-03-02', total: 5000, billable: false, billing_status: 'unbilled', project_name: 'Deck', invoice_ref: '' },
    { id: 3, number: 3, description: 'Screws', vendor: 'Home Depot', category: 'Materials', date: '2026-03-03', total: 2240, billable: true, billing_status: 'unbilled', project_name: 'Shed', invoice_ref: '' },
  ];
  const r = (o) => filterRecords(rs, F(o), 'receipts', TODAY).map((x) => x.id);
  assert.deepEqual(r({ billable: 'yes' }), [1, 3]);
  assert.deepEqual(r({ billable: 'no' }), [2]);
  assert.deepEqual(r({ billing: 'unbilled' }), [3]);          // non-billable receipts never count as "unbilled"
  assert.deepEqual(r({ q: 'shed' }), [3]);                    // project name is searchable
  assert.deepEqual(r({ q: 'inv-1' }), [1]);
  assert.deepEqual(r({ q: '#002' }), [2]);
  assert.deepEqual(sortRecords(rs, 'amount_desc', 'receipts').map((x) => x.id), [1, 2, 3]);
});

test('chips describe filters and can be cleared one by one', () => {
  const f = F({ q: 'tv', any: ['tv', 'television'], category: 'Electronics', from: '2025-01-01', to: '2025-12-31', max: 200000, warranty: 'active' });
  assert.deepEqual(activeChips(f).map((c) => c.key), ['any', 'category', 'date', 'price', 'warranty']);
  assert.deepEqual(activeChips(f).map((c) => c.label), ['Matching: tv, television', 'Category: Electronics', '2025-01-01 → 2025-12-31', 'Under $2,000', 'Under warranty']);
  const g = clearFilter(clearFilter(f, 'date'), 'price');
  assert.deepEqual([g.from, g.to, g.max, g.category], ['', '', null, 'Electronics']);
  assert.equal(hasFilters(emptyFilters()), false);
  assert.equal(hasFilters(F({ q: 'x' })), true);
  assert.equal(hasFilters(F({ billing: 'paid' })), true);
});
