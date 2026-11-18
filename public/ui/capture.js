// Quick capture (many receipts, no forms) and the Inbox where the resulting drafts wait for review.
import { $, $$, state, esc, money, today, uuid, api, toast, icon, mount, emptyState, refreshInbox } from './core.js';
import { draftRow } from './rows.js';
import { queueAll, queuePut, flushQueue } from './queue.js';
import { ocrOn, setOcrOn } from './photos.js';
import { openCropper, autoCropFile, canvasToJpeg } from '../crop.js';
import { scanCanvas, warmOcr } from '../ocr.js';
import { fieldsFromScan } from '../ocr-parse.js';
import { indexByKey, suggestFor } from '../vendor.js';

export async function viewInbox() {
  const drafts = await api('GET', '/inbox');
  state.inbox = drafts.length;
  mount(`<div class="page">
    <div class="stack tight"><a class="crumb" href="#/">${icon('chevron-left')} Projects</a><h1>Inbox</h1>
      <p class="muted small">Quick captures waiting for review. They are <b>not</b> in totals or reports until you file them.</p></div>
    <div class="row"><a class="btn primary" href="#/capture">${icon('zap')} Capture more</a>${drafts.length ? `<a class="btn" href="#/r/${drafts[0].id}">Review them one by one ${icon('chevron-right')}</a>` : ''}</div>
    ${drafts.length ? `<div class="card list">${drafts.map(draftRow).join('')}</div>` : `<div class="card pad">${emptyState('inbox', 'The Inbox is empty', 'Captured receipts show up here.')}</div>`}
  </div>`);
}

export async function viewCapture() {
  const projects = (await api('GET', '/projects')).filter((p) => !p.archived);
  if (!projects.length) {
    mount(`<div class="page"><h1>Quick capture</h1><div class="card pad">${emptyState('folder', 'Create a project first', 'Captures are filed into a project.')}<div class="center"><a class="btn primary" href="#/">Go to Projects</a></div></div></div>`);
    return;
  }
  const meta = state.meta;
  const vmap = indexByKey(await api('GET', '/vendors').catch(() => []));
  const last = Number(localStorage.getItem('qc-project')), pick = projects.find((p) => p.id === last) || projects[0];
  let billable = localStorage.getItem('qc-billable') !== '0';
  const session = [];                                              // this visit: { id, thumb, state, info }
  let ocrChain = Promise.resolve(), inboxCount = await refreshInbox();

  mount(`<div class="page">
    <div class="stack tight"><h1>Quick capture</h1>
      <p class="muted small">Snap receipts one after another — no forms. Each is cropped automatically, read in the background and saved to your Inbox to review later.</p></div>
    <div class="card pad stack">
      <div class="field"><label for="qc-project">Add to project</label><select id="qc-project">${projects.map((p) => `<option value="${p.id}" ${p.id === pick.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div>
      <div class="field"><span class="lbl">Usually <span class="hint">(stores you've used before keep their usual setting)</span></span>
        <div class="seg full"><button type="button" data-b="1" class="${billable ? 'on' : ''}">Billable</button><button type="button" data-b="0" class="${billable ? '' : 'on'}">Non-billable</button></div></div>
      <label class="check"><input type="checkbox" id="qc-ocr" ${ocrOn() ? 'checked' : ''}><span>Read the text in the background <span class="hint">(on this device)</span></span></label>
      <label class="check"><input type="checkbox" id="qc-review" ${localStorage.getItem('qc-review') === '1' ? 'checked' : ''}><span>Let me adjust the crop for each photo <span class="hint">(slower — originals are not kept)</span></span></label>
    </div>
    <div class="row nowrap"><label class="btn big primary grow">${icon('camera')} Capture<input id="qc-cam" type="file" accept="image/*" capture="environment" hidden></label>
      <label class="btn big grow">${icon('image')} From gallery<input id="qc-pick" type="file" accept="image/*" multiple hidden></label></div>
    <div id="qc-list" class="stack tight"></div>
    <div><a class="btn" href="#/inbox" id="qc-inbox"></a></div>
  </div>`);

  const STATE = { reading: ['reading…', 'warn'], saving: ['saving…', 'warn'], waiting: ['waiting to sync', 'warn'], saved: ['in Inbox', 'ok'], attention: ['needs attention', 'bad'] };
  const render = () => {
    if (!$('#qc-list')) return;                                    // navigated away while a photo was still being processed
    $('#qc-list').innerHTML = session.length ? `<div class="card list">${session.map((e) => `<div class="item"><img class="thumb" src="${e.thumb}" alt="">
      <div class="body"><div class="name">${esc(e.info || 'Capture')}</div><div class="tags"><span class="pill ${STATE[e.state][1]}">${e.state === 'saved' ? icon('check') : ''}${STATE[e.state][0]}</span></div></div></div>`).join('')}</div>` : '';
    $('#qc-inbox').innerHTML = `${icon('inbox')} Open Inbox${inboxCount ? ` (${inboxCount})` : ''}`;
  };
  const refreshStates = async () => {
    const q = await queueAll();
    for (const e of session) {
      const item = q.find((x) => x.client_id === e.id);
      if (!item) { if (e.state !== 'saved') { e.state = 'saved'; inboxCount++; state.inbox = inboxCount; } }
      else e.state = item.hold ? 'reading' : item.error ? 'attention' : 'waiting';
    }
    render();
  };
  const onQueueChanged = () => { if (!$('#qc-list')) removeEventListener('queue-changed', onQueueChanged); else refreshStates(); };
  addEventListener('queue-changed', onQueueChanged);               // e.g. the connection came back and the queue synced by itself

  const processCapture = async (entry, canvas, project, base, ocr) => {
    let data = base;
    if (ocr) {
      try {
        const text = await scanCanvas(canvas);                     // the same on-device reader as the forms
        const f = fieldsFromScan(text, meta.provinces, project.province, today(), [...vmap.values()].map((e) => e.name));
        data = { ...base, ...f.data, ocr_text: text };
        const sug = suggestFor(vmap, data.vendor);                 // history beats the keyword guess
        if (sug?.category) data.category = sug.category;
        if (sug && sug.billable !== null) data.billable = !!sug.billable;
        const sum = (data.subtotal || 0) + (data.gst || 0) + (data.pst || 0) + (data.tip || 0);
        entry.info = [data.vendor, sum ? money(sum) : ''].filter(Boolean).join(' · ');
      } catch { entry.info = 'could not read the text'; }
    }
    const item = (await queueAll()).find((x) => x.client_id === entry.id);
    if (item) await queuePut({ ...item, data, hold: false });      // release: now it may sync
    entry.state = 'saving'; render();
    await flushQueue(); await refreshStates();
  };

  const capture = async (file) => {
    const project = projects.find((p) => String(p.id) === $('#qc-project').value);
    const ocr = $('#qc-ocr').checked;
    let res;
    try { res = $('#qc-review').checked ? await openCropper(file) : await autoCropFile(file); }
    catch (e) { toast(e.message, true); return; }
    if (!res) return;
    const client_id = uuid();
    const base = { draft: true, date: today(), province: project.province, billable, images: [res.dataUrl] };
    const entry = { id: client_id, thumb: canvasToJpeg(res.canvas, 160, 0.6), state: ocr ? 'reading' : 'saving', info: '' };
    session.unshift(entry); render();
    // persisted on the device immediately (held while it is being read), so nothing is lost if the page is closed or the network drops
    await queuePut({ client_id, url: `/projects/${project.id}/receipts`, project_id: project.id, data: base, label: 'Capture', hold: true, created: Date.now() });
    ocrChain = ocrChain.then(() => processCapture(entry, res.canvas, project, base, ocr));   // one read at a time; you can keep shooting
  };
  const onFiles = async (ev) => { const files = [...ev.target.files]; ev.target.value = ''; for (const f of files) await capture(f); };
  $('#qc-cam').onchange = onFiles; $('#qc-pick').onchange = onFiles;
  $('#qc-project').onchange = (ev) => localStorage.setItem('qc-project', ev.target.value);
  $('#qc-review').onchange = (ev) => localStorage.setItem('qc-review', ev.target.checked ? '1' : '0');
  $('#qc-ocr').onchange = (ev) => { setOcrOn(ev.target.checked); if (ev.target.checked) warmOcr(); };
  $$('[data-b]').forEach((b) => (b.onclick = () => {
    billable = b.dataset.b === '1'; localStorage.setItem('qc-billable', billable ? '1' : '0');
    $$('[data-b]').forEach((x) => x.classList.toggle('on', x === b));
  }));
  if ($('#qc-ocr').checked) warmOcr();
  render();
}
