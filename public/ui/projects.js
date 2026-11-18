// Projects list and the project page (tabs: Receipts · Export · Settings).
import { $, $$, state, hooks, esc, money, today, pad, api, toast, icon, mount, emptyState, plural, isNetworkError, guard, refreshInbox } from './core.js';
import { provOptions, field } from './forms.js';
import { thumb, billPill, draftRow } from './rows.js';
import { queueAll, queuePut, queueDel, flushQueue, renderBanner, dupText } from './queue.js';
import { confirmDialog, promptDialog, formDialog } from './dialogs.js';

// ---------------------------------------------------------------- projects list
export async function viewProjects() {
  const [projects, inbox, health] = await Promise.all([
    api('GET', '/projects'), refreshInbox(), state.me.role === 'admin' ? api('GET', '/backup/health').catch(() => null) : null,
  ]);
  const isInvoiced = (p) => !p.archived && p.billing.unbilled.count === 0 && (p.billing.invoiced.count + p.billing.paid.count) > 0;
  const active = projects.filter((p) => !p.archived && !isInvoiced(p));
  const invoiced = projects.filter(isInvoiced);
  const archived = projects.filter((p) => p.archived);
  const showInvoiced = localStorage.getItem('show-invoiced-projects') === '1';
  const row = (p) => `<a class="item" href="#/p/${p.id}"><div class="iconsq">${icon('folder')}</div>
    <div class="body"><div class="name">${esc(p.name)}</div>
      <div class="meta">${esc(p.client)}${p.client ? ' · ' : ''}${plural(p.all.count, 'receipt')} · ${esc(p.province)}</div>
      <div class="tags">${p.billing.unbilled.total ? `<span class="pill warn">Unbilled ${money(p.billing.unbilled.total)}</span>` : ''}${p.billing.invoiced.total ? `<span class="pill accent">Invoiced ${money(p.billing.invoiced.total)}</span>` : ''}${p.billing.paid.total ? `<span class="pill ok">Paid ${money(p.billing.paid.total)}</span>` : ''}${p.non_billable.total ? `<span class="pill">Non-billable ${money(p.non_billable.total)}</span>` : ''}</div></div>
    <div class="end money">${money(p.all.total)}</div></a>`;
  const backupBanner = health && ['warning', 'error'].includes(health.state)
    ? `<a class="banner ${health.state === 'error' ? 'bad' : ''}" href="#/settings/backup">${icon('alert')}<span class="grow">${esc(health.message)}</span><span class="small">Fix →</span></a>` : '';

  mount(`<div class="page">
    <div class="title"><h1>Projects</h1><button class="btn primary" id="newbtn">${icon('plus')} New project</button></div>
    ${backupBanner}
    ${inbox ? `<a class="banner info" href="#/inbox">${icon('inbox')}<span class="grow">${plural(inbox, 'capture')} waiting in your Inbox</span><span class="small">Review →</span></a>` : ''}
    <div class="row nowrap"><a class="btn big primary grow" href="#/capture">${icon('zap')} Quick capture</a><a class="btn big grow" href="#/search">${icon('search')} Search</a></div>
    ${active.length ? `<div class="card list">${active.map(row).join('')}</div>` : `<div class="card pad">${emptyState('folder', invoiced.length ? 'No active projects' : 'No projects yet', invoiced.length ? 'All active projects have been invoiced.' : 'Create one to start adding receipts.')}</div>`}
    ${invoiced.length ? `<div class="section-title"><h2>Invoiced (${invoiced.length})</h2><label class="check"><input type="checkbox" id="show-inv" ${showInvoiced ? 'checked' : ''}><span>Show invoiced</span></label></div><div id="inv-list" class="card list" ${showInvoiced ? '' : 'hidden'}>${invoiced.map(row).join('')}</div>` : ''}
    ${archived.length ? `<div class="section-title"><h2>Archived</h2></div><div class="card list">${archived.map(row).join('')}</div>` : ''}
  </div>`);

  if ($('#show-inv')) $('#show-inv').onchange = (ev) => {
    const on = ev.target.checked;
    localStorage.setItem('show-invoiced-projects', on ? '1' : '0');
    $('#inv-list').hidden = !on;
  };

  $('#newbtn').onclick = guard(async () => {
    const fd = await formDialog({
      title: 'New project', ok: 'Create',
      body: `${field('Name', '<input id="np-name" name="name" required placeholder="e.g. Kitchen reno" autocomplete="off">', { id: 'np-name' })}
        ${field('Client', '<input id="np-client" name="client" autocomplete="off">', { id: 'np-client', hint: '(optional)' })}
        ${field('Default province', `<select id="np-prov" name="province">${provOptions(state.meta.default_province)}</select>`, { id: 'np-prov', hint: '(each receipt can override)' })}`,
    });
    if (!fd) return;
    try { const p = await api('POST', '/projects', Object.fromEntries(fd)); location.hash = `#/p/${p.id}`; }
    catch (e) { toast(isNetworkError(e) ? 'Creating projects needs a connection' : e.message, true); }
  });
}

// ---------------------------------------------------------------- project page
const CHECK = { pending: ['checking…', 'warn'], ok: ['checked', 'ok'], reviewed: ['reviewed', 'ok'], error: ['check failed', ''] };
const checkPill = (r) => {
  const c = r.check;
  if (!c || c.status === 'none') return '';
  if (c.status === 'review') return `<span class="pill bad">${icon('alert')} ${c.issues.filter((i) => i.severity === 'warn').length} to review</span>`;
  const [t, cls] = CHECK[c.status] || [];
  return t ? `<span class="pill ${cls}">${c.status === 'pending' ? '' : icon('check')}${t}</span>` : '';
};
let receiptFilter = 'all';                                   // all | billable | non  (remembered while you move around)

export async function viewProject(id, tab = 'receipts') {
  const p = await api('GET', `/projects/${id}`);
  localStorage.setItem('project-' + id, JSON.stringify({ id: p.id, name: p.name, province: p.province }));   // lets the receipt form work offline
  const base = `#/p/${p.id}`;
  const bl = p.billing;

  const header = `<div class="stack tight"><a class="crumb" href="#/">${icon('chevron-left')} Projects</a>
      <div class="title"><div><h1>${esc(p.name)}</h1><div class="muted small">${esc(p.client)}${p.client ? ' · ' : ''}${esc(state.meta.provinces[p.province]?.name || p.province)}</div></div>
        <a class="btn primary" href="${base}/new">${icon('plus')} Add receipt</a></div></div>
    <div class="stats">
      <div class="stat big"><div class="label">Total</div><div class="value">${money(p.all.total)}</div></div>
      <div class="stat"><div class="label">Billable</div><div class="value">${money(p.billable.total)}</div></div>
      <div class="stat"><div class="label">Non-billable</div><div class="value">${money(p.non_billable.total)}</div></div>
    </div>
    <nav class="tabs" aria-label="Project sections"><a href="${base}" class="${tab === 'receipts' ? 'on' : ''}">Receipts</a><a href="${base}/export" class="${tab === 'export' ? 'on' : ''}">Export</a><a href="${base}/settings" class="${tab === 'settings' ? 'on' : ''}">Settings</a></nav>`;

  mount(`<div class="page">${header}<div id="tab" class="stack"></div></div>`, { keepScroll: true });
  const box = $('#tab');
  if (tab === 'export') exportTab(p, box); else if (tab === 'settings') settingsTab(p, box); else await receiptsTab(p, box, bl);
}

async function receiptsTab(p, box, bl) {
  const pending = (await queueAll()).filter((i) => String(i.project_id) === String(p.id) && !i.data.draft);
  const shown = (list) => list.filter((r) => receiptFilter === 'all' || (receiptFilter === 'billable' ? r.billable : !r.billable));
  const row = (r) => `<a class="item" href="#/r/${r.id}" data-id="${r.id}">
      ${r.billable ? `<input type="checkbox" class="sel" data-sel="${r.id}" aria-label="Select receipt #${pad(r.number)}">` : ''}${thumb('receipt', r)}
      <div class="body"><div class="name">#${pad(r.number)} ${esc(r.description || r.vendor || 'Receipt')}</div>
        <div class="meta">${esc(r.date)}${r.vendor ? ' · ' + esc(r.vendor) : ''} · ${esc(r.province)}${r.category ? ' · ' + esc(r.category) : ''}</div>
        <div class="tags">${billPill(r)}${checkPill(r)}</div></div>
      <div class="end"><span class="money">${money(r.total)}</span><span class="tiny muted">tax ${money(r.gst + r.pst)}${r.tip ? ' · tip ' + money(r.tip) : ''}</span></div></a>`;
  const pend = (i) => `<div class="item"><div class="thumb ph">${icon('image')}</div>
      <div class="body"><div class="name">${esc(i.label)}</div>
        <div class="tags"><span class="pill warn">${i.error ? 'Needs attention: ' + esc(i.error) : 'Waiting to sync'}</span></div>
        ${i.duplicate ? `<div class="meta">Looks like: ${esc(dupText(i.duplicate))}</div>` : ''}</div>
      ${i.error === 'Possible duplicate' ? `<button class="btn sm" data-force="${esc(i.client_id)}">Save anyway</button>` : ''}
      <button class="iconbtn" data-discard="${esc(i.client_id)}" aria-label="Discard">${icon('trash')}</button></div>`;

  const list = shown(p.receipts);
  box.innerHTML = `
    ${p.billable.count ? `<div class="row"><span class="pill warn">Unbilled ${money(bl.unbilled.total)} · ${bl.unbilled.count}</span><span class="pill accent">Invoiced ${money(bl.invoiced.total)} · ${bl.invoiced.count}</span><span class="pill ok">Paid ${money(bl.paid.total)} · ${bl.paid.count}</span></div>` : ''}
    ${pending.length ? `<div class="section-title"><h2>Waiting to sync (${pending.length})</h2></div><div class="card list pending">${pending.map(pend).join('')}</div>` : ''}
    ${p.drafts?.length ? `<div class="section-title"><h2>Inbox (${p.drafts.length})</h2></div><div class="card list">${p.drafts.map((d) => draftRow({ ...d, project_name: '' })).join('')}</div>
      <div class="hint">Quick captures — not counted in totals until you file them.</div>` : ''}
    <div class="row between"><div class="chips" role="group" aria-label="Filter receipts">
        ${[['all', 'All'], ['billable', 'Billable'], ['non', 'Non-billable']].map(([k, l]) => `<button class="chip ${receiptFilter === k ? 'on' : ''}" data-filter="${k}">${l}</button>`).join('')}</div>
      ${p.billable.count ? '<button type="button" class="btn sm" id="selbtn">Select</button>' : ''}</div>
    <div id="rlist">${list.length ? `<div class="card list">${list.map(row).join('')}</div>` : `<div class="card pad">${emptyState('receipt', p.receipts.length ? 'Nothing in this view' : 'No receipts yet', p.receipts.length ? '' : 'Tap “Add receipt”, or use Quick capture for a stack.')}</div>`}</div>`;

  $$('[data-filter]', box).forEach((b) => (b.onclick = () => { receiptFilter = b.dataset.filter; hooks.route(); }));
  $$('[data-discard]', box).forEach((b) => (b.onclick = guard(async () => {
    if (await confirmDialog('This receipt has not reached the server yet. It will be lost.', { title: 'Discard unsynced receipt?', ok: 'Discard', danger: true })) { await queueDel(b.dataset.discard); await renderBanner(); hooks.route(); }
  })));
  $$('[data-force]', box).forEach((b) => (b.onclick = guard(async () => {
    const item = (await queueAll()).find((x) => x.client_id === b.dataset.force); if (!item) return;
    await queuePut({ ...item, data: { ...item.data, allow_duplicate: true }, error: undefined, duplicate: undefined });
    await flushQueue(); hooks.route();
  })));
  wireSelection(p, box);

  // while the AI is still checking some receipts, refresh quietly so the badges update
  if (p.receipts.some((r) => r.check?.status === 'pending') && state.pollTries < 45) {
    const mine = location.hash;
    setTimeout(() => { if (location.hash === mine) { state.pollTries++; hooks.route(); } }, 3000);
  }
}

/** Select billable receipts -> mark invoiced / paid / unbilled. */
function wireSelection(p, box) {
  const btn = $('#selbtn', box);
  if (!btn) return;
  let selecting = false, bar = null;
  const closeBar = () => { bar?.remove(); bar = null; };
  addEventListener('hashchange', closeBar, { once: true });
  const picked = () => $$('.sel:checked', box).map((c) => Number(c.dataset.sel));
  const update = () => {
    const ids = picked();
    if (!selecting || !ids.length) return closeBar();
    if (!bar) { bar = document.createElement('div'); bar.className = 'bulkbar'; document.body.appendChild(bar); bar.onclick = onBar; }
    const sum = p.receipts.filter((r) => ids.includes(r.id)).reduce((a, r) => a + r.total, 0);
    bar.innerHTML = `<b>${plural(ids.length, 'receipt')} selected · ${money(sum)}</b><div class="row"><button type="button" class="btn primary sm" data-bulk="invoiced">Mark invoiced…</button><button type="button" class="btn sm" data-bulk="paid">Mark paid</button><button type="button" class="btn sm" data-bulk="unbilled">Back to unbilled</button></div>`;
  };
  const onBar = guard(async (ev) => {
    const status = ev.target.closest('[data-bulk]')?.dataset.bulk;
    if (!status) return;
    let ref = '';
    if (status === 'invoiced') { ref = await promptDialog('Invoice number for the selected receipts', { title: 'Mark as invoiced', value: 'INV-' + today().replace(/-/g, ''), ok: 'Mark invoiced' }); if (!ref) return; }
    const r = await api('POST', `/projects/${p.id}/billing`, { ids: picked(), status, invoice_ref: ref });
    toast(`${plural(r.updated, 'receipt')} marked ${status}`, 'ok'); closeBar(); hooks.route();
  });
  btn.onclick = () => {
    selecting = !selecting; $('#rlist', box).classList.toggle('selecting', selecting); btn.textContent = selecting ? 'Done' : 'Select';
    if (!selecting) $$('.sel', box).forEach((c) => (c.checked = false));
    update();
  };
  $('#rlist', box).addEventListener('click', (ev) => {
    if (!selecting) return;
    const item = ev.target.closest('.item[data-id]');
    if (!item) return;
    if (!ev.target.classList.contains('sel')) { ev.preventDefault(); const cb = $('.sel', item); if (cb) cb.checked = !cb.checked; }
    update();
  });
}

function exportTab(p, box) {
  box.innerHTML = `
    <div class="card pad stack">
      <h2>Report</h2>
      <div class="grid2">${field('From', '<input type="date" id="from">', { id: 'from' })}${field('To', '<input type="date" id="to">', { id: 'to' })}
        ${field('Include', '<select id="only"><option value="">All receipts</option><option value="billable">Billable only</option></select>', { id: 'only' })}
        ${field('Billing status', '<select id="bstatus"><option value="all">Any</option><option value="unbilled">Unbilled</option><option value="invoiced">Invoiced</option><option value="paid">Paid</option></select>', { id: 'bstatus' })}</div>
      ${field('Only invoice #', '<input id="invfilter" placeholder="e.g. INV-2026-014" autocapitalize="characters">', { id: 'invfilter', hint: '(optional)' })}
      <label class="check"><input type="checkbox" id="autotax" checked><span>Auto-calculate GST/PST for receipts with no tax entered <span class="hint">(from each receipt's province; marked * in the report)</span></span></label>
      <div class="row"><a class="btn primary" id="zip" href="#">${icon('download')} Report bundle (.zip)</a><a class="btn" id="pdf" href="#">${icon('file')} PDF</a><a class="btn" id="csv" href="#">CSV</a></div>
      <div class="hint">The bundle has the PDF (summary + a page per receipt photo), the CSV, and a <code>receipts/</code> folder of JPGs named <code>001_description.jpg</code>.</div>
    </div>
    <div class="card pad stack">
      <h2>Invoicing</h2>
      <p class="muted small">Marks the <b>unbilled billable</b> receipts in the date range as invoiced under an invoice number, then downloads a bundle of just those — so nothing gets billed twice.</p>
      <div><button type="button" id="mkinv" class="btn primary">${icon('receipt')} Create invoice bundle…</button></div>
    </div>`;

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
  $('#mkinv').onclick = guard(async () => {
    if (!navigator.onLine) return toast('This needs a connection to the server', true);
    const from = $('#from').value, to = $('#to').value;
    const todo = p.receipts.filter((r) => r.billable && r.billing_status === 'unbilled' && (!from || r.date >= from) && (!to || r.date <= to));
    if (!todo.length) return toast('No unbilled billable receipts in that date range');
    const ref = await promptDialog(`Invoice number for these ${plural(todo.length, 'receipt')} (${money(todo.reduce((a, r) => a + r.total, 0))})`, { title: 'Create invoice bundle', value: 'INV-' + today().replace(/-/g, ''), ok: 'Mark invoiced & download' });
    if (!ref) return;
    await api('POST', `/projects/${p.id}/billing`, { ids: todo.map((r) => r.id), status: 'invoiced', invoice_ref: ref });
    const q = new URLSearchParams({ only: 'billable', invoice: ref });
    if (from) q.set('from', from); if (to) q.set('to', to); if (!$('#autotax').checked) q.set('autotax', '0');
    location.href = `/api/projects/${p.id}/export.zip?${q}`;
    toast(`${plural(todo.length, 'receipt')} marked as ${ref}`, 'ok');
  });
}

function settingsTab(p, box) {
  box.innerHTML = `<form id="edit" class="card pad stack">
      <h2>Project details</h2>
      ${field('Name', `<input id="pe-name" name="name" value="${esc(p.name)}" required>`, { id: 'pe-name' })}
      ${field('Client', `<input id="pe-client" name="client" value="${esc(p.client)}">`, { id: 'pe-client' })}
      ${field('Default province for new receipts', `<select id="pe-prov" name="province">${provOptions(p.province)}</select>`, { id: 'pe-prov' })}
      <div class="row"><button class="btn primary">Save</button><button type="button" class="btn" id="arch">${p.archived ? 'Unarchive' : 'Archive'}</button><span class="grow"></span><button type="button" class="btn danger" id="del">${icon('trash')} Delete project</button></div>
    </form>`;
  $('#edit').onsubmit = guard(async (ev) => { ev.preventDefault(); await api('PATCH', `/projects/${p.id}`, Object.fromEntries(new FormData(ev.target))); toast('Saved', 'ok'); hooks.route(); });
  $('#arch').onclick = guard(async () => { await api('PATCH', `/projects/${p.id}`, { archived: !p.archived }); location.hash = '#/'; });
  $('#del').onclick = guard(async () => {
    if (!(await confirmDialog(`Delete “${p.name}” and its ${plural(p.all.count, 'receipt')}? This cannot be undone.`, { title: 'Delete project?', ok: 'Delete', danger: true }))) return;
    await api('DELETE', `/projects/${p.id}`); location.hash = '#/';
  });
}
