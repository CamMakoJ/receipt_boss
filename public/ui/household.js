// Household items & warranties (list + form) and the cross-project receipt search.
import { $, state, esc, toCents, fromCents, today, api, toast, icon, mount, skeleton, isNetworkError } from './core.js';
import { catOptions, field } from './forms.js';
import { itemRow, receiptRow } from './rows.js';
import { mountSearch } from './search.js';
import { photoField, wirePhoto, showScanMsg, scanFill } from './photos.js';
import { createRecord } from './queue.js';
import { confirmDialog } from './dialogs.js';
import { parseReceiptText } from '../ocr-parse.js';
import { indexByKey, suggestFor } from '../vendor.js';

export async function viewItems() {
  mount(skeleton(5));
  const items = await api('GET', '/items');
  mount(`<div class="page">
    <div class="title"><h1>Household</h1><div class="row"><a class="btn" href="/api/items.csv" download>CSV</a><a class="btn primary" href="#/household/new">${icon('plus')} Add item</a></div></div>
    <p class="muted small">Big purchases you may need proof of later — shared with everyone on this server.</p>
    <div id="search"></div></div>`);
  await mountSearch({ el: $('#search'), scope: 'items', records: items, renderRow: itemRow, categories: state.meta.item_categories, placeholder: 'Search name, store, serial, notes, receipt text…' });
}

export async function viewSearch() {
  mount(skeleton(5));
  const receipts = await api('GET', '/receipts');
  mount(`<div class="page"><div class="stack tight"><a class="crumb" href="#/">${icon('chevron-left')} Projects</a><h1>Search receipts</h1></div><div id="search"></div></div>`);
  await mountSearch({ el: $('#search'), scope: 'receipts', records: receipts, renderRow: receiptRow, categories: state.meta.receipt_categories, placeholder: 'Vendor, description, project, invoice #, receipt text…' });
}

export async function viewItemForm({ itemId }) {
  mount(skeleton(3));
  const i = itemId ? await api('GET', `/items/${itemId}`) : null;
  const vendorList = await api('GET', '/vendors?scope=items').catch(() => []), vmap = indexByKey(vendorList);
  const v = i || { name: '', category: '', purchase_date: today(), vendor: '', price: 0, warranty_months: null, serial: '', notes: '' };
  const yrs = v.warranty_months && v.warranty_months % 12 === 0;
  const wval = v.warranty_months ? (yrs ? v.warranty_months / 12 : v.warranty_months) : '';

  mount(`<div class="page">
    <div class="stack tight"><a class="crumb" href="#/household">${icon('chevron-left')} Household</a><h1>${i ? esc(i.name) : 'New item'}</h1></div>
    <form id="f" class="stack" autocomplete="off">
      <div class="card pad">${photoField()}</div>
      <div class="card pad stack">
        <h2>Item</h2>
        ${field('Name', `<input id="i-name" name="name" value="${esc(v.name)}" required placeholder="e.g. Samsung 65&quot; TV">`, { id: 'i-name' })}
        <div class="grid2">
          ${field('Purchase date', `<input id="i-date" type="date" name="purchase_date" value="${esc(v.purchase_date)}" required>`, { id: 'i-date' })}
          ${field('Price', `<input id="i-price" name="price" inputmode="decimal" value="${fromCents(v.price)}" placeholder="0.00">`, { id: 'i-price' })}
          ${field('Vendor', `<input id="i-vendor" name="vendor" list="ivendors" value="${esc(v.vendor)}" autocomplete="off"><datalist id="ivendors">${vendorList.slice(0, 200).map((x) => `<option value="${esc(x.name)}">`).join('')}</datalist>`, { id: 'i-vendor' })}
          ${field('Category', `<input id="i-cat" name="category" list="icats" value="${esc(v.category)}"><datalist id="icats">${catOptions(state.meta.item_categories)}</datalist>`, { id: 'i-cat' })}
        </div>
      </div>
      <div class="card pad stack">
        <h2>Warranty</h2>
        <div class="grid2">
          ${field('Length', `<input id="i-wnum" name="wnum" inputmode="numeric" value="${wval}" placeholder="e.g. 2">`, { id: 'i-wnum', hint: '(blank if unknown)' })}
          ${field('Unit', `<select id="i-wunit" name="wunit"><option value="12" ${yrs || !v.warranty_months ? 'selected' : ''}>years</option><option value="1" ${v.warranty_months && !yrs ? 'selected' : ''}>months</option></select>`, { id: 'i-wunit' })}
        </div>
        <div class="pill accent" id="wends" hidden></div>
        ${field('Serial / model number', `<input id="i-serial" name="serial" value="${esc(v.serial)}">`, { id: 'i-serial' })}
        ${field('Notes', `<textarea id="i-notes" name="notes" rows="2">${esc(v.notes)}</textarea>`, { id: 'i-notes' })}
      </div>
      ${i ? `<div><button type="button" class="btn danger sm" id="del">${icon('trash')} Delete item</button></div>` : ''}
      <div class="actionbar"><button class="btn primary" id="save">${i ? 'Save changes' : 'Add item'}</button></div>
    </form></div>`);

  const form = $('#f');
  const months = () => { const n = parseInt(form.wnum.value, 10); return n > 0 ? n * Number(form.wunit.value) : null; };
  const showEnds = () => {
    const m = months(), el = $('#wends');
    if (!m || !form.purchase_date.value) { el.hidden = true; return; }
    const d = new Date(form.purchase_date.value + 'T00:00:00Z'), day = d.getUTCDate();
    d.setUTCMonth(d.getUTCMonth() + m); if (d.getUTCDate() !== day) d.setUTCDate(0);
    el.textContent = `Warranty ends ${d.toISOString().slice(0, 10)}`; el.hidden = false;
  };
  ['wnum', 'wunit', 'purchase_date'].forEach((n) => form[n].addEventListener('input', showEnds)); showEnds();

  // vendor memory: a store you have bought from before suggests its usual category (new items only)
  const applyVendor = () => {
    if (i || form.category.value) return;
    const sug = suggestFor(vmap, form.vendor.value);
    if (sug?.category) { form.category.value = sug.category; form.category.classList.add('remembered'); form.category.addEventListener('input', () => form.category.classList.remove('remembered'), { once: true }); }
  };
  form.vendor.addEventListener('change', applyVendor);

  const photo = wirePhoto((text) => {                      // OCR: purchase date, vendor and price (the receipt total)
    const p = parseReceiptText(text, { known: vendorList.map((e) => e.name) });
    const price = p.total ?? (p.subtotal !== null ? p.subtotal + (p.gst ?? 0) + (p.pst ?? 0) + (p.tip ?? 0) : null);
    const filled = [];
    if (scanFill(form.vendor, p.vendor)) { filled.push('vendor'); applyVendor(); }
    if (scanFill(form.purchase_date, p.date, form.purchase_date.value === today())) { filled.push('date'); showEnds(); }
    if (price !== null && scanFill(form.price, fromCents(price))) filled.push('price');
    showScanMsg(filled.length ? `Filled from the photo: <b>${filled.join(', ')}</b>. Check the highlighted fields, then add the item name.` : 'Couldn’t pick out any details from that photo.', !filled.length);
  }, { kind: 'item', rec: i });

  form.onsubmit = async (ev) => {
    ev.preventDefault();
    const data = { name: form.name.value, purchase_date: form.purchase_date.value, vendor: form.vendor.value, category: form.category.value.trim(),
      price: toCents(form.price.value), warranty_months: months(), serial: form.serial.value, notes: form.notes.value };
    const save = $('#save'); save.disabled = true;
    try {
      Object.assign(data, photo.payload(!i));
      if (i) await api('PATCH', `/items/${i.id}`, data);
      else if ((await createRecord('/items', data, { label: data.name })) === 'cancelled') { save.disabled = false; return; }
      location.hash = '#/household';
    } catch (e) { toast(isNetworkError(e) ? 'Editing needs a connection' : e.message, true); save.disabled = false; }
  };
  if ($('#del')) $('#del').onclick = async () => {
    if (!(await confirmDialog(`Delete “${i.name}” and its photos?`, { title: 'Delete item?', ok: 'Delete', danger: true }))) return;
    try { await api('DELETE', `/items/${i.id}`); location.hash = '#/household'; } catch (e) { toast(e.message, true); }
  };
}
