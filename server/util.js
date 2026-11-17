export const total = (r) => r.subtotal + r.gst + r.pst + r.tip;

export function sumReceipts(list) {
  const t = { count: 0, subtotal: 0, gst: 0, pst: 0, tip: 0, total: 0 };
  for (const r of list) {
    t.count++;
    t.subtotal += r.subtotal;
    t.gst += r.gst;
    t.pst += r.pst;
    t.tip += r.tip;
    t.total += total(r);
  }
  return t;
}

export const money = (cents) =>
  (cents < 0 ? '-' : '') + '$' + (Math.abs(cents) / 100).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const plain = (cents) => (cents / 100).toFixed(2);

/** Safe, readable file-name fragment. */
export function slug(s, max = 50) {
  const out = String(s || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/, '');
  return out;
}

/** "001_Lumber-for-deck.jpg" — receipt number + description (falls back to vendor). */
export function imageName(r) {
  const label = slug(r.description) || slug(r.vendor) || 'receipt';
  return `${String(r.number).padStart(3, '0')}_${label}.jpg`;
}

export function csvCell(v) {
  const s = String(v ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
