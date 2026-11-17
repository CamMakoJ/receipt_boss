// List-row renderers shared by several screens.
import { esc, money, icon, today, pad } from './core.js';
import { warrantyState } from '../filters.js';

/** Cover thumbnail (by photo id, so it can be cached forever) with a count badge when there are several photos. */
export const thumb = (kind, rec) => (rec.photos?.length
  ? `<div class="thumbwrap"><img class="thumb" loading="lazy" src="/api/${kind === 'item' ? 'items' : 'receipts'}/${rec.id}/photos/${rec.photos[0]}" alt="">${rec.photos.length > 1 ? `<span class="count">${rec.photos.length}</span>` : ''}</div>`
  : `<div class="thumb ph">${icon('image')}</div>`);

export function warrantyPill(item) {
  const w = warrantyState(item, today());
  if (w.key === 'unknown') return { text: 'Warranty unknown', cls: '' };
  if (w.key === 'expired') return { text: `Expired ${item.warranty_expires}`, cls: 'bad' };
  if (w.key === 'expiring') return { text: `Ends ${item.warranty_expires} · ${w.days} day${w.days === 1 ? '' : 's'}`, cls: 'warn' };
  return { text: `Covered until ${item.warranty_expires}`, cls: 'ok' };
}

export const itemRow = (i) => {
  const w = warrantyPill(i);
  return `<a class="item" href="#/household/${i.id}">${thumb('item', i)}
    <div class="body"><div class="name">${esc(i.name)}</div>
      <div class="meta">${esc(i.purchase_date)}${i.vendor ? ' · ' + esc(i.vendor) : ''}${i.category ? ' · ' + esc(i.category) : ''}</div>
      <div class="tags"><span class="pill ${w.cls}">${esc(w.text)}</span></div></div>
    <div class="end money">${i.price ? money(i.price) : ''}</div></a>`;
};

export const billPill = (r) => (r.billable
  ? `<span class="pill ${r.billing_status === 'paid' ? 'ok' : r.billing_status === 'invoiced' ? 'warn' : ''}">${esc(r.billing_status)}${r.invoice_ref ? ' ' + esc(r.invoice_ref) : ''}</span>`
  : '<span class="pill">non-billable</span>');

/** Row for the cross-project receipt search. */
export const receiptRow = (r) => `<a class="item" href="#/r/${r.id}">${thumb('receipt', r)}
  <div class="body"><div class="name">#${pad(r.number)} ${esc(r.description || r.vendor || 'Receipt')}</div>
    <div class="meta">${esc(r.project_name)} · ${esc(r.date)}${r.vendor ? ' · ' + esc(r.vendor) : ''}${r.category ? ' · ' + esc(r.category) : ''}</div>
    <div class="tags">${billPill(r)}</div></div>
  <div class="end money">${money(r.total)}</div></a>`;

/** Quick-capture draft waiting for review. */
export const draftRow = (d) => `<a class="item" href="#/r/${d.id}">${thumb('receipt', d)}
  <div class="body"><div class="name">${esc(d.vendor || 'Not read yet')}</div>
    <div class="meta">${esc(d.project_name || '')}${d.project_name ? ' · ' : ''}${esc(d.date)}${d.category ? ' · ' + esc(d.category) : ''}</div>
    <div class="tags"><span class="pill warn">${icon('inbox')} Draft — tap to review</span></div></div>
  <div class="end money">${d.total ? money(d.total) : ''}</div></a>`;
