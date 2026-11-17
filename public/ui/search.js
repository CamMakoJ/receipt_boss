// Search box + filter panel + removable chips over a list of records. Everything is filtered on the device (instant, works offline).
// With a local AI configured, "Ask" turns a sentence into the same filters, shown as chips you can edit.
import { $, esc, toCents, today, api, toast, icon, getAi, isNetworkError, debounce, emptyState } from './core.js';
import { emptyFilters, filterRecords, sortRecords, activeChips, clearFilter, hasFilters, warrantyState, SORTS } from '../filters.js';

const GROUPS = [['expiring', 'Warranty ending soon'], ['active', 'Under warranty'], ['unknown', 'Warranty unknown'], ['expired', 'Expired']];
const opts = (list, sel) => list.map(([v, l]) => `<option value="${v}" ${v === sel ? 'selected' : ''}>${esc(l)}</option>`).join('');

export async function mountSearch({ el, scope, records, renderRow, categories, placeholder }) {
  const ai = await getAi();
  let f = emptyFilters(), sort = scope === 'items' ? 'warranty' : 'newest';
  const cats = [...new Set([...categories, ...records.map((r) => r.category).filter(Boolean)])].sort((a, b) => a.localeCompare(b));
  const extra = scope === 'items'
    ? `<div class="field"><label for="f-warranty">Warranty</label><select id="f-warranty">${opts([['any', 'Any'], ['active', 'Under warranty'], ['expiring', 'Ending within 90 days'], ['expired', 'Expired'], ['unknown', 'Unknown']], 'any')}</select></div>`
    : `<div class="field"><label for="f-billable">Type</label><select id="f-billable">${opts([['any', 'Any'], ['yes', 'Billable'], ['no', 'Non-billable']], 'any')}</select></div>
       <div class="field"><label for="f-billing">Billing status</label><select id="f-billing">${opts([['any', 'Any'], ['unbilled', 'Unbilled'], ['invoiced', 'Invoiced'], ['paid', 'Paid']], 'any')}</select></div>`;
  el.innerHTML = `<div class="stack">
    <div class="searchbar">
      <div class="grow">${icon('search')}<input id="q" type="search" placeholder="${esc(placeholder)}" autocomplete="off" aria-label="Search"></div>
      ${ai.enabled ? `<button type="button" class="btn" id="ask" title="Turn a sentence into filters">${icon('sparkles')}<span>Ask</span></button>` : ''}
      <button type="button" class="btn" id="ftoggle" aria-expanded="false">${icon('filter')}<span>Filters</span></button>
    </div>
    ${ai.enabled ? '<div class="hint">Describe it in your own words — e.g. “the fridge from Home Depot last year” — then tap Ask.</div>' : ''}
    <div id="filters" class="card pad stack" hidden>
      <div class="grid2">
        <div class="field"><label for="f-category">Category</label><select id="f-category"><option value="">Any</option>${cats.map((c) => `<option>${esc(c)}</option>`).join('')}</select></div>
        ${extra}
        <div class="field"><label for="f-vendor">Store / vendor</label><input id="f-vendor" autocomplete="off"></div>
        <div class="field"><label for="f-sort">Sort by</label><select id="f-sort">${opts(SORTS[scope], sort)}</select></div>
        <div class="field"><label for="f-from">${scope === 'items' ? 'Bought' : 'Dated'} from</label><input type="date" id="f-from"></div>
        <div class="field"><label for="f-to">to</label><input type="date" id="f-to"></div>
        <div class="field"><label for="f-min">Price from ($)</label><input id="f-min" inputmode="decimal" placeholder="0"></div>
        <div class="field"><label for="f-max">to ($)</label><input id="f-max" inputmode="decimal" placeholder="any"></div>
      </div>
      <div><button type="button" class="btn sm" id="fclear">Clear all filters</button></div>
    </div>
    <div id="chips" class="chips"></div><div id="count" class="muted small"></div><div id="list" class="stack"></div></div>`;

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
  const card = (rows) => `<div class="card list">${rows}</div>`;

  function refresh() {
    const t = today(), list = sortRecords(filterRecords(records, f, scope, t), sort, scope, t), chips = activeChips(f);
    $('#chips').innerHTML = chips.map((c) => `<button type="button" class="chip on" data-chip="${c.key}">${esc(c.label)} ${icon('x')}</button>`).join('');
    $('#count').textContent = records.length ? (hasFilters(f) ? `${list.length} of ${records.length}` : `${records.length}`) + (scope === 'items' ? ' items' : ' receipts') : '';
    $('#ftoggle').classList.toggle('primary', chips.length > 0);
    if (!records.length) $('#list').innerHTML = emptyState(scope === 'items' ? 'home' : 'receipt', 'Nothing here yet');
    else if (!list.length) $('#list').innerHTML = `<div class="card pad stack center">${emptyState('search', 'No matches', 'Try fewer words or clear a filter.')}<div><button type="button" class="btn" id="fclear2">Clear everything</button></div></div>`;
    else if (scope === 'items' && sort === 'warranty') {
      $('#list').innerHTML = GROUPS.map(([k, title]) => { const g = list.filter((i) => warrantyState(i, t).key === k); return g.length ? `<div class="section-title"><h2>${title} (${g.length})</h2></div>${card(g.map(renderRow).join(''))}` : ''; }).join('');
    } else $('#list').innerHTML = card(list.map(renderRow).join(''));
    if ($('#fclear2')) $('#fclear2').onclick = clearAll;
  }
  const clearAll = () => { f = emptyFilters(); sort = scope === 'items' ? 'warranty' : 'newest'; write(); refresh(); };

  const onInput = debounce(() => { read(); refresh(); }, 90);
  el.addEventListener('input', (ev) => { if (ev.target.closest('#filters, #q')) onInput(); });
  el.addEventListener('change', (ev) => { if (ev.target.closest('#filters')) { read(); refresh(); } });
  $('#ftoggle').onclick = () => { const p = $('#filters'); p.hidden = !p.hidden; $('#ftoggle').setAttribute('aria-expanded', String(!p.hidden)); };
  $('#fclear').onclick = clearAll;
  $('#chips').onclick = (ev) => { const c = ev.target.closest('[data-chip]'); if (c) { f = clearFilter(f, c.dataset.chip); write(); refresh(); } };
  if ($('#ask')) $('#ask').onclick = async () => {
    const text = $('#q').value.trim();
    if (!text) return toast('Type what you are looking for, then tap Ask');
    const btn = $('#ask'); btn.disabled = true; btn.lastElementChild.textContent = 'Thinking…';
    try {
      const { filters } = await api('POST', '/ai/search', { query: text, scope });
      f = { ...emptyFilters(), ...filters, q: '' }; $('#q').value = ''; write();
      if (activeChips(f).length) { $('#filters').hidden = false; $('#ftoggle').setAttribute('aria-expanded', 'true'); }
      refresh(); toast(activeChips(f).length ? 'Here is what I understood — tap a chip to remove it' : 'I could not turn that into filters — try plain words', !activeChips(f).length);
    } catch (e) { toast(isNetworkError(e) ? 'Smart search needs a connection to the server' : e.message, true); }
    finally { btn.disabled = false; btn.lastElementChild.textContent = 'Ask'; }
  };
  refresh();
}
