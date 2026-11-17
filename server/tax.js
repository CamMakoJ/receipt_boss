// Canadian sales-tax table. Rates are in thousandths of a percent (5000 = 5%) so maths stays in integers.
// `gst` is the federal GST, or the whole HST in HST provinces (stored in the receipt's GST/HST field).
// `pst` is the separate provincial tax (PST / RST / QST). Verify rates when governments change them.
export const PROVINCES = {
  AB: { name: 'Alberta',               gst: 5000,  pst: 0,    note: 'GST' },
  BC: { name: 'British Columbia',      gst: 5000,  pst: 7000, note: 'GST + PST' },
  MB: { name: 'Manitoba',              gst: 5000,  pst: 7000, note: 'GST + RST' },
  NB: { name: 'New Brunswick',         gst: 15000, pst: 0,    note: 'HST' },
  NL: { name: 'Newfoundland & Labrador', gst: 15000, pst: 0,  note: 'HST' },
  NS: { name: 'Nova Scotia',           gst: 14000, pst: 0,    note: 'HST' },
  NT: { name: 'Northwest Territories', gst: 5000,  pst: 0,    note: 'GST' },
  NU: { name: 'Nunavut',               gst: 5000,  pst: 0,    note: 'GST' },
  ON: { name: 'Ontario',               gst: 13000, pst: 0,    note: 'HST' },
  PE: { name: 'Prince Edward Island',  gst: 15000, pst: 0,    note: 'HST' },
  QC: { name: 'Quebec',                gst: 5000,  pst: 9975, note: 'GST + QST' },
  SK: { name: 'Saskatchewan',          gst: 5000,  pst: 6000, note: 'GST + PST' },
  YT: { name: 'Yukon',                 gst: 5000,  pst: 0,    note: 'GST' },
};
export const DEFAULT_PROVINCE = 'BC';
export const isProvince = (p) => Object.prototype.hasOwnProperty.call(PROVINCES, p);

/** Taxes (in cents) on a subtotal (in cents). Tips are never taxed. */
export function calcTax(subtotal, province) {
  const p = PROVINCES[province] || PROVINCES[DEFAULT_PROVINCE];
  return {
    gst: Math.round((subtotal * p.gst) / 100000),
    pst: Math.round((subtotal * p.pst) / 100000),
  };
}

export const RECEIPT_CATEGORIES = ['Meals', 'Fuel', 'Lodging', 'Travel', 'Parking', 'Materials', 'Tools & equipment',
  'Office supplies', 'Software & subscriptions', 'Phone & internet', 'Professional fees', 'Other'];
export const ITEM_CATEGORIES = ['Appliance', 'Electronics', 'Computer & tech', 'Furniture', 'Tools', 'Vehicle', 'Outdoor', 'Other'];

/** Last day of warranty: purchase date + N months (clamped to month end). */
export function warrantyExpiry(purchaseDate, months) {
  if (!months || months <= 0) return null;
  const d = new Date(purchaseDate + 'T00:00:00Z');
  const day = d.getUTCDate();
  d.setUTCMonth(d.getUTCMonth() + months);
  if (d.getUTCDate() !== day) d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
}
