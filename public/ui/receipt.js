// The receipt form: new receipt, edit, and reviewing a quick-capture draft. Includes OCR fill, vendor memory and the AI check card.
import { $, $$, state, esc, money, toCents, fromCents, today, pad, api, toast, icon, mount, getAi, isNetworkError, skeleton } from './core.js';
import { provOptions, catOptions, calcTax, field } from './forms.js';
import { photoField, wirePhoto, showScanMsg, scanFill } from './photos.js';
import { createRecord, dupText } from './queue.js';
import { confirmDialog } from './dialogs.js';
import { parseReceiptText, resolveAmounts } from '../ocr-parse.js';
import { indexByKey, suggestFor } from '../vendor.js';

export async function viewReceiptForm({ projectId, receiptId }) {
  mount(skeleton(3));
  let r = null, project;
  if (receiptId) {
    r = await api('GET', `/receipts/${receiptId}`);
    project = await api('GET', `/projects/${r.project_id}`);
    projectId = r.project_id;
  } else {
    try { project = await api('GET', `/projects/${projectId}`); }
    catch (e) {                                                        // offline: the project page cached what we need
      const cached = localStorage.getItem('project-' + projectId);
      if (!isNetworkError(e) || !cached) throw e;
      project = JSON.parse(cached);
    }
  }
  const meta = state.meta;
  const allProjects = receiptId ? await api('GET', '/projects').catch(() => []) : [];
  let billable = r ? r.billable : true;
  const v = r || { date: today(), vendor: '', category: '', description: '', province: project.province, subtotal: 0, gst: 0, pst: 0, tip: 0, notes: '' };
  const isDraft = !!r?.draft;
  const ai = r && !isDraft ? await getAi() : { enabled: false };
  const vendorList = await api('GET', '/vendors').catch(() => []);
  const vmap = indexByKey(vendorList);
  const num = (id, name, val, ph = '0.00') => `<input id="${id}" name="${name}" inputmode="decimal" value="${fromCents(val)}" placeholder="${ph}" autocomplete="off">`;

  mount(`<div class="page">
    <div class="stack tight"><a class="crumb" href="${isDraft ? '#/inbox' : `#/p/${projectId}`}">${icon('chevron-left')} ${isDraft ? 'Inbox' : esc(project.name)}</a>
      <h1>${r ? (isDraft ? 'Review capture' : `Receipt #${pad(r.number)}`) : 'New receipt'}</h1></div>
    ${isDraft ? `<div class="banner info">${icon('inbox')}<span class="grow">Not filed yet — it isn't counted in totals or reports. Check the details, then press <b>File receipt</b>.</span></div>` : ''}
    ${r && !isDraft ? '<div id="checkcard" class="card pad stack" hidden></div>' : ''}
    <form id="f" class="stack" autocomplete="off">
      <div class="card pad">${photoField()}</div>

      <div class="card pad stack">
        <h2>Details</h2>
        <div class="grid2">
          ${field('Date', `<input id="f-date" type="date" name="date" value="${esc(v.date)}" required>`, { id: 'f-date' })}
          ${field('Vendor', `<input id="f-vendor" name="vendor" list="vendors" value="${esc(v.vendor)}" autocomplete="off" placeholder="Store name"><datalist id="vendors">${vendorList.slice(0, 200).map((x) => `<option value="${esc(x.name)}">`).join('')}</datalist>`, { id: 'f-vendor' })}
        </div>
        ${field('Province of purchase', `<select id="f-prov" name="province">${provOptions(v.province)}</select>`, { id: 'f-prov' })}
        ${field('Category', `<input id="f-cat" name="category" list="cats" value="${esc(v.category)}" autocomplete="off" placeholder="Pick or type your own"><datalist id="cats">${catOptions(meta.receipt_categories, meta.used_categories)}</datalist><div id="vmsg" class="hint" hidden></div>`, { id: 'f-cat' })}
        ${field('Description', `<input id="f-desc" name="description" value="${esc(v.description)}" autocomplete="off">`, { id: 'f-desc', hint: '(fills from the category; also names the photo file)' })}
        <div class="field"><span class="lbl">Type</span><div class="seg full" role="group" aria-label="Billable or not"><button type="button" data-b="1" class="${billable ? 'on' : ''}">Billable</button><button type="button" data-b="0" class="${billable ? '' : 'on'}">Non-billable</button></div></div>
      </div>

      <div class="card pad stack">
        <h2>Amounts</h2>
        <div class="grid4">
          ${field('Subtotal', num('f-sub', 'subtotal', v.subtotal), { id: 'f-sub' })}
          ${field('GST/HST', num('f-gst', 'gst', v.gst), { id: 'f-gst' })}
          ${field('PST/QST', num('f-pst', 'pst', v.pst), { id: 'f-pst' })}
          ${field('Tip', num('f-tip', 'tip', v.tip), { id: 'f-tip' })}
        </div>
        <label class="check"><input type="checkbox" id="taxauto" ${(r ? r.tax_auto : true) ? 'checked' : ''}><span>Calculate taxes from the subtotal and province <span class="hint" id="rates"></span></span></label>
        <div class="totalline"><span>Total</span><span class="money" id="tot">$0.00</span></div>
      </div>

      <details class="panel"><summary>More</summary><div class="panel-body">
        ${field('Notes', `<textarea id="f-notes" name="notes" rows="2">${esc(v.notes)}</textarea>`, { id: 'f-notes' })}
        ${receiptId && allProjects.length > 1 ? field('Project', `<select id="f-proj" name="project_id">${allProjects.map((p) => `<option value="${p.id}" ${p.id === projectId ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>`, { id: 'f-proj' }) : ''}
        ${r ? `<div><button type="button" class="btn danger sm" id="del">${icon('trash')} Delete ${isDraft ? 'capture' : 'receipt'}</button></div>` : ''}
      </div></details>

      <div class="actionbar"><button class="btn primary" id="save">${isDraft ? 'File receipt' : 'Save receipt'}</button>${isDraft ? '<button type="button" class="btn" id="savedraft">Save draft</button>' : ''}</div>
    </form></div>`);

  const form = $('#f');
  const g = (n) => toCents(form[n].value);
  const recalc = () => { $('#tot').textContent = money(g('subtotal') + g('gst') + g('pst') + g('tip')); };
  const applyAuto = () => {
    const p = meta.provinces[form.province.value];
    $('#rates').textContent = p ? `(${p.note}: ${p.gst / 1000}%${p.pst ? ` + ${p.pst / 1000}%` : ''})` : '';
    if (!$('#taxauto').checked) return recalc();
    const t = calcTax(g('subtotal'), form.province.value);
    form.gst.value = fromCents(t.gst); form.pst.value = fromCents(t.pst); recalc();
  };
  form.subtotal.addEventListener('input', applyAuto);
  form.province.addEventListener('change', applyAuto);
  $('#taxauto').addEventListener('change', applyAuto);
  for (const n of ['gst', 'pst']) form[n].addEventListener('input', () => { $('#taxauto').checked = false; applyAuto(); });   // typing a tax = manual
  form.tip.addEventListener('input', recalc);
  applyAuto();

  // description follows the category until the user writes their own
  let autoDesc = v.category, descCustom = !!v.description && v.description !== v.category;
  form.category.addEventListener('input', () => { if (!descCustom) { form.description.value = form.category.value; autoDesc = form.category.value; } });
  form.description.addEventListener('input', () => { descCustom = form.description.value !== '' && form.description.value !== autoDesc; });

  // ---- vendor memory: a familiar store pre-fills its usual category / billable setting (never on an already-filed receipt)
  let billableTouched = !!r && !isDraft;
  const syncToggle = () => $$('[data-b]', form).forEach((x) => x.classList.toggle('on', (x.dataset.b === '1') === billable));
  const applyVendor = () => {
    if (r && !isDraft) return;
    const sug = suggestFor(vmap, form.vendor.value);
    if (!sug) return;
    const bits = [];
    if (sug.category && !form.category.value) {
      form.category.value = sug.category; form.category.dispatchEvent(new Event('input'));        // (the description follows the category)
      form.category.classList.add('remembered'); form.category.addEventListener('input', () => form.category.classList.remove('remembered'), { once: true });
      bits.push(`category ${sug.category}`);
    }
    if (sug.billable !== null && !billableTouched && billable !== !!sug.billable) { billable = !!sug.billable; syncToggle(); bits.push(billable ? 'billable' : 'non-billable'); }
    if (bits.length) { $('#vmsg').textContent = `From your ${sug.entry.count} earlier ${sug.entry.name} receipts: ${bits.join(' and ')}.`; $('#vmsg').hidden = false; }
  };
  form.vendor.addEventListener('change', applyVendor);
  $$('[data-b]', form).forEach((b) => (b.onclick = () => { billable = b.dataset.b === '1'; billableTouched = true; syncToggle(); }));

  // ---- OCR result -> form fields
  const applyScan = (text) => {
    const p = parseReceiptText(text);
    if (p.province && meta.provinces[p.province]) form.province.value = p.province;
    const a = resolveAmounts(p, meta.provinces[form.province.value]);
    const filled = [];
    const set = (label, ok) => { if (ok) filled.push(label); };
    set('vendor', scanFill(form.vendor, p.vendor));
    applyVendor();                                           // history beats the keyword guess below
    set('date', scanFill(form.date, p.date, form.date.value === today()));
    if (p.category && !form.category.value) { form.category.value = p.category; form.category.classList.add('scanned'); form.category.dispatchEvent(new Event('input')); filled.push('category'); }
    const readTax = p.gst !== null || p.pst !== null || p.tax !== null;
    if (a.subtotal !== null && (!form.subtotal.value || form.subtotal.classList.contains('scanned'))) {
      scanFill(form.subtotal, fromCents(a.subtotal));
      $('#taxauto').checked = !readTax;                      // taxes read from the receipt are kept exactly as printed
      scanFill(form.gst, fromCents(a.gst)); scanFill(form.pst, fromCents(a.pst));
      filled.push('amounts', ...(readTax ? ['taxes'] : []));
    }
    if (a.tip !== null) set('tip', scanFill(form.tip, fromCents(a.tip)));
    applyAuto();
    if (!filled.length) return showScanMsg('Couldn’t pick out any details. Try cropping closer to the text, or use “Read text again”.', true);
    const names = { subtotal: 'subtotal', gst: 'GST/HST', pst: 'PST/QST' };
    showScanMsg(`Filled from the photo: <b>${filled.join(', ')}</b>. Please check the highlighted fields${a.estimated
      ? ` — <b>${a.inferred.map((k) => names[k]).join(' and ')}</b> couldn’t be read clearly and ${a.inferred.length > 1 ? 'were' : 'was'} worked out from the total, so double-check ${a.inferred.length > 1 ? 'them' : 'it'}` : ''}.${p.total !== null ? ` Receipt total read: <b>${money(p.total)}</b>.` : ''}`, a.estimated);
  };
  const photo = wirePhoto(applyScan, { kind: 'receipt', rec: r });

  if (r && !isDraft) wireCheckCard(r, ai, form, applyAuto);

  // ---- saving
  let keepDraft = false;
  if ($('#savedraft')) $('#savedraft').onclick = () => { keepDraft = true; form.requestSubmit(); };
  /** After filing a draft, go straight to the next one waiting in the Inbox. */
  const goNext = async () => {
    const inbox = await api('GET', '/inbox').catch(() => []);
    state.inbox = inbox.length > 0 ? inbox.length - 1 : 0;
    const next = inbox.find((d) => d.id > r.id) || inbox.find((d) => d.id !== r.id);
    if (next) { toast(`Filed — ${inbox.length - 1} more in the Inbox`, 'ok'); location.hash = `#/r/${next.id}`; }
    else { toast('Filed — the Inbox is empty', 'ok'); location.hash = `#/p/${projectId}`; }
  };

  form.onsubmit = async (ev) => {
    ev.preventDefault();
    const data = { date: form.date.value, vendor: form.vendor.value, province: form.province.value, category: form.category.value.trim(),
      description: form.description.value, billable, tax_auto: $('#taxauto').checked,
      subtotal: g('subtotal'), gst: g('gst'), pst: g('pst'), tip: g('tip'), notes: form.notes.value };
    const filing = isDraft && !keepDraft; keepDraft = false;
    const save = $('#save'); save.disabled = true;
    try {
      if (r) {
        Object.assign(data, photo.payload(false));
        if (form.project_id) data.project_id = Number(form.project_id.value);
        if (filing) data.draft = false;
        try { await api('PATCH', `/receipts/${r.id}`, data); }
        catch (e) {
          if (e.status === 409 && e.data?.duplicates) {
            const go = await confirmDialog(`This looks like a duplicate of:\n\n${e.data.duplicates.map(dupText).join('\n')}`, { title: 'Possible duplicate', ok: 'File it anyway' });
            if (!go) { save.disabled = false; return; }
            await api('PATCH', `/receipts/${r.id}`, { ...data, allow_duplicate: true });
          } else throw e;
        }
        if (filing) return await goNext();
        location.hash = isDraft ? '#/inbox' : `#/p/${data.project_id || projectId}`;
        return;
      }
      Object.assign(data, photo.payload(true));
      const out = await createRecord(`/projects/${projectId}/receipts`, data, { project_id: projectId, label: data.description || data.category || data.vendor || 'Receipt' });
      if (out === 'cancelled') { save.disabled = false; return; }
      location.hash = `#/p/${projectId}`;
    } catch (e) { toast(isNetworkError(e) ? 'Editing needs a connection' : e.message, true); save.disabled = false; }
  };
  if ($('#del')) $('#del').onclick = async () => {
    if (!(await confirmDialog(isDraft ? 'Delete this capture?' : 'Delete this receipt and its photos?', { title: 'Delete?', ok: 'Delete', danger: true }))) return;
    try { await api('DELETE', `/receipts/${r.id}`); location.hash = isDraft ? '#/inbox' : `#/p/${projectId}`; }
    catch (e) { toast(e.message, true); }
  };
}

/** Second opinion from the local AI: shows what it read, with one-tap fixes. It checks the SAVED version of the receipt. */
function wireCheckCard(r, ai, form, applyAuto) {
  const USE = { subtotal: 'subtotal', gst: 'gst', pst: 'pst', tip: 'tip', date: 'date', vendor: 'vendor' };
  const card = $('#checkcard');
  const render = () => {
    const c = r.check || { status: 'none', issues: [] };
    const warns = c.issues.filter((i) => i.severity === 'warn').length;
    if (c.status === 'none' && !ai.enabled) { card.hidden = true; return; }
    const head = { none: 'Not checked yet', pending: 'Checking against the receipt…', ok: 'Matches the receipt', reviewed: 'Reviewed',
      review: `${warns} thing${warns === 1 ? '' : 's'} to review`, error: 'Couldn’t be checked' }[c.status] || '';
    const ic = { ok: 'check', reviewed: 'check', pending: 'sparkles', review: 'alert', error: 'alert', none: 'sparkles' }[c.status];
    card.hidden = false;
    card.className = 'card pad stack ' + ({ ok: 'goodc', reviewed: 'goodc', review: 'warn', error: 'warn' }[c.status] || '');
    card.innerHTML = `<div class="row between"><b>${icon(ic)} ${head}</b>${ai.enabled && navigator.onLine && c.status !== 'pending' ? `<button type="button" class="btn sm" id="recheck">${icon('sparkles')} Check now</button>` : ''}</div>
      ${c.error ? `<div class="small">${esc(c.error)}</div>` : ''}
      ${c.issues.map((i, n) => `<div class="issue ${i.severity}"><span>${esc(i.message)}</span>${i.value !== null && i.value !== undefined && USE[i.field] ? `<button type="button" class="btn sm" data-use="${n}">Use ${esc(i.read)}</button>` : ''}</div>`).join('')}
      ${c.note ? `<div class="small">Model note: ${esc(c.note)}</div>` : ''}
      ${c.model ? `<div class="tiny">${c.status === 'pending' ? '' : `Checked by ${esc(c.model)} (${c.mode === 'image' ? 'looked at the photo' : 'read the scanned text'}). `}Compares with the saved receipt, not unsaved edits.</div>` : ''}
      ${c.status === 'review' ? '<div><button type="button" class="btn sm" id="dismiss">Looks fine — dismiss</button></div>' : ''}`;
  };
  const poll = async () => {
    for (let n = 0; n < 60; n++) {
      await new Promise((res) => setTimeout(res, 2000));
      if (!document.body.contains(card)) return;                       // navigated away
      const cur = await api('GET', `/receipts/${r.id}`).catch(() => null);
      if (!cur) continue;
      r.check = cur.check; render();
      if (cur.check.status !== 'pending') return;
    }
  };
  card.addEventListener('click', async (ev) => {
    const use = ev.target.closest('[data-use]'), t = ev.target.closest('button');
    if (use) {
      const i = r.check.issues[Number(use.dataset.use)], el = form[USE[i.field]];
      el.value = ['date', 'vendor'].includes(i.field) ? i.value : fromCents(i.value);
      el.classList.add('scanned'); el.addEventListener('input', () => el.classList.remove('scanned'), { once: true });
      if (i.field === 'gst' || i.field === 'pst') $('#taxauto').checked = false;
      applyAuto(); toast('Filled in — press Save to keep it');
    } else if (t?.id === 'recheck') {
      try { await api('POST', `/receipts/${r.id}/check`, {}); r.check = { status: 'pending', issues: [] }; render(); poll(); }
      catch (e) { toast(e.message, true); }
    } else if (t?.id === 'dismiss') {
      await api('POST', `/receipts/${r.id}/check/dismiss`, {}); r.check = { ...r.check, status: 'reviewed' }; render();
    }
  });
  render();
  if (r.check?.status === 'pending') poll();
}
