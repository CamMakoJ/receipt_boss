// Receipt Boss front-end: vanilla JS, no build step.
const $ = (s, el = document) => el.querySelector(s);
const app = $('#app');

// ------------------------------------------------------------------ helpers
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (c) => (c < 0 ? '-' : '') + '$' + (Math.abs(c) / 100).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const toCents = (v) => { const n = parseFloat(String(v).replace(/[^0-9.\-]/g, '')); return Number.isFinite(n) ? Math.max(0, Math.round(n * 100)) : 0; };
const fromCents = (c) => (c ? (c / 100).toFixed(2) : '');
const today = () => { const d = new Date(); return new Date(d - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10); };
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now() + '-' + Math.random().toString(16).slice(2));

function toast(msg, bad = false) {
  const t = $('#toast');
  t.textContent = msg; t.className = 'toast' + (bad ? ' bad' : ''); t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 3500);
}

async function api(method, url, body) {
  const res = await fetch('/api' + url, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body && JSON.stringify(body) });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { status: res.status, offline: res.status === 503 });
  return data;
}
const isNetworkError = (e) => e.offline || e instanceof TypeError;

// ------------------------------------------------------------------ offline queue (IndexedDB)
const idb = new Promise((resolve, reject) => {
  const open = indexedDB.open('receipt-boss', 1);
  open.onupgradeneeded = () => open.result.createObjectStore('queue', { keyPath: 'client_id' });
  open.onsuccess = () => resolve(open.result);
  open.onerror = () => reject(open.error);
});
async function store(mode, fn) {
  const db = await idb;
  return new Promise((resolve, reject) => {
    const t = db.transaction('queue', mode);
    const req = fn(t.objectStore('queue'));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
  });
}
const queueAll = () => store('readonly', (s) => s.getAll());
const queuePut = (item) => store('readwrite', (s) => s.put(item));
const queueDel = (id) => store('readwrite', (s) => s.delete(id));

let flushing = false;
async function flushQueue() {
  if (flushing || !navigator.onLine) return;
  flushing = true;
  let sent = 0;
  try {
    for (const item of await queueAll()) {
      try {
        await api('POST', `/projects/${item.project_id}/receipts`, { ...item.data, client_id: item.client_id });
        await queueDel(item.client_id); sent++;
      } catch (e) {
        if (isNetworkError(e)) break;                      // still offline: try again later
        if (e.status === 404 || e.status === 400) {        // can never succeed: keep it flagged
          await queuePut({ ...item, error: e.message });
        } else break;
      }
    }
  } finally { flushing = false; }
  if (sent) { toast(`Synced ${sent} receipt${sent > 1 ? 's' : ''}`); route(); }
  await renderBanner();
}

async function renderBanner() {
  const q = await queueAll();
  const el = $('#sync');
  el.hidden = !q.length;
  if (q.length) {
    const failed = q.filter((i) => i.error).length;
    el.innerHTML = `<span>${q.length} receipt${q.length > 1 ? 's' : ''} waiting to sync${failed ? ` (${failed} need attention)` : ''}</span><button id="syncnow">Sync now</button>`;
    $('#syncnow').onclick = flushQueue;
  }
}
function renderNet() { $('#net').textContent = navigator.onLine ? '' : '● offline'; }
addEventListener('online', () => { renderNet(); flushQueue(); });
addEventListener('offline', renderNet);

// ------------------------------------------------------------------ image handling
/** Resize + re-encode as JPEG in the browser (also converts HEIC where the browser can decode it). */
async function toJpegDataUrl(file, maxDim = 2200, quality = 0.85) {
  let bmp;
  try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch {
    bmp = await new Promise((resolve, reject) => {
      const img = new Image(); const url = URL.createObjectURL(file);
      img.onload = () => resolve(img); img.onerror = () => reject(new Error('Could not read that image'));
      img.src = url;
    });
  }
  const w = bmp.width || bmp.naturalWidth, h = bmp.height || bmp.naturalHeight;
  const k = Math.min(1, maxDim / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.round(w * k); c.height = Math.round(h * k);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', quality);
}

// ------------------------------------------------------------------ router
async function route() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  try {
    if (!parts.length) return await viewProjects();
    if (parts[0] === 'p' && parts[2] === 'new') return await viewReceiptForm({ projectId: parts[1] });
    if (parts[0] === 'p') return await viewProject(parts[1]);
    if (parts[0] === 'r') return await viewReceiptForm({ receiptId: parts[1] });
    return await viewProjects();
  } catch (e) {
    app.innerHTML = `<div class="card"><b>${isNetworkError(e) ? 'You are offline and this page was not cached yet.' : esc(e.message)}</b><p><a href="#/">Back to projects</a></p></div>`;
  }
}
addEventListener('hashchange', route);

// ------------------------------------------------------------------ views
async function viewProjects() {
  const projects = await api('GET', '/projects');
  const active = projects.filter((p) => !p.archived), archived = projects.filter((p) => p.archived);
  const card = (p) => `<a class="card" href="#/p/${p.id}">
      <div class="spread"><b>${esc(p.name)}</b><span class="money"><b>${money(p.all.total)}</b></span></div>
      <div class="muted">${esc(p.client)}${p.client ? ' · ' : ''}${p.all.count} receipt${p.all.count === 1 ? '' : 's'}</div>
      <div class="row small"><span class="pill">Billable ${money(p.billable.total)}</span><span class="pill nb">Non-billable ${money(p.non_billable.total)}</span></div></a>`;
  app.innerHTML = `<h1>Projects</h1>
    ${active.map(card).join('') || '<p class="muted">No projects yet. Create one to start adding receipts.</p>'}
    <div class="card"><h2 style="margin-top:0">New project</h2>
      <form id="newp">
        <label>Name</label><input name="name" required placeholder="e.g. Kitchen reno">
        <label>Client (optional)</label><input name="client">
        <div class="grid"><div><label>GST %</label><input name="gst_rate" inputmode="decimal" value="5"></div>
        <div><label>PST %</label><input name="pst_rate" inputmode="decimal" value="7"></div></div>
        <p><button class="pri">Create project</button></p>
      </form></div>
    ${archived.length ? `<h2>Archived</h2>${archived.map(card).join('')}` : ''}`;
  $('#newp').onsubmit = async (ev) => {
    ev.preventDefault();
    const f = Object.fromEntries(new FormData(ev.target));
    try {
      const p = await api('POST', '/projects', { ...f, gst_rate: parseFloat(f.gst_rate) || 0, pst_rate: parseFloat(f.pst_rate) || 0 });
      location.hash = `#/p/${p.id}`;
    } catch (e) { toast(isNetworkError(e) ? 'Creating projects needs a connection' : e.message, true); }
  };
}

async function viewProject(id) {
  const p = await api('GET', `/projects/${id}`);
  localStorage.setItem('project-' + id, JSON.stringify({ id: p.id, name: p.name, gst_rate: p.gst_rate, pst_rate: p.pst_rate }));
  const pending = (await queueAll()).filter((i) => String(i.project_id) === String(id));
  const bill = p.receipts.filter((r) => r.billable), non = p.receipts.filter((r) => !r.billable);

  const sumTable = `<table class="t"><tr><th></th><th>Subtotal</th><th>GST</th><th>PST</th><th>Tip</th><th>Total</th></tr>
    ${[['Billable', p.billable], ['Non-billable', p.non_billable], ['All', p.all]].map(([n, t]) =>
      `<tr><td>${n}</td><td>${money(t.subtotal)}</td><td>${money(t.gst)}</td><td>${money(t.pst)}</td><td>${money(t.tip)}</td><td><b>${money(t.total)}</b></td></tr>`).join('')}</table>`;

  const rcpt = (r) => `<a class="card row" href="#/r/${r.id}" style="flex-wrap:nowrap">
      ${r.has_image ? `<img class="thumb" loading="lazy" src="/api/receipts/${r.id}/image" alt="">` : '<div class="thumb"></div>'}
      <div class="grow"><div class="spread"><b>#${String(r.number).padStart(3, '0')} ${esc(r.description || r.vendor || 'Receipt')}</b><span class="money"><b>${money(r.total)}</b></span></div>
      <div class="muted small">${esc(r.date)}${r.vendor ? ' · ' + esc(r.vendor) : ''}</div>
      <div class="muted small">Sub ${money(r.subtotal)} · GST ${money(r.gst)} · PST ${money(r.pst)} · Tip ${money(r.tip)}</div></div></a>`;
  const pend = (i) => `<div class="card row" style="flex-wrap:nowrap"><div class="thumb"></div><div class="grow">
      <div class="spread"><b>${esc(i.data.description || i.data.vendor || 'Receipt')}</b><span class="money">${money((i.data.subtotal || 0) + (i.data.gst || 0) + (i.data.pst || 0) + (i.data.tip || 0))}</span></div>
      <span class="pill pending">${i.error ? 'Needs attention: ' + esc(i.error) : 'Waiting to sync'}</span> <span class="pill ${i.data.billable ? '' : 'nb'}">${i.data.billable ? 'Billable' : 'Non-billable'}</span></div>
      <button class="danger" data-discard="${esc(i.client_id)}">✕</button></div>`;

  app.innerHTML = `<p><a href="#/">← Projects</a></p>
    <h1>${esc(p.name)}</h1><div class="muted">${esc(p.client)}</div>
    <div class="actions"><a class="btn pri" href="#/p/${p.id}/new">＋ Add receipt</a></div>
    <div class="card">${sumTable}</div>
    ${pending.length ? `<h2>Pending sync (${pending.length})</h2>${pending.map(pend).join('')}` : ''}
    <h2>Billable (${bill.length})</h2>${bill.map(rcpt).join('') || '<p class="muted">None</p>'}
    <h2>Non-billable (${non.length})</h2>${non.map(rcpt).join('') || '<p class="muted">None</p>'}
    <div class="card"><h2 style="margin-top:0">Export</h2>
      <div class="grid"><div><label>From</label><input type="date" id="from"></div><div><label>To</label><input type="date" id="to"></div></div>
      <div class="actions"><a class="btn pri" id="zip">⬇ Report bundle (.zip)</a><a class="btn" id="pdf">PDF</a><a class="btn" id="csv">CSV</a></div>
      <div class="muted small">Bundle = PDF report with receipt images + CSV + <code>receipts/</code> folder of JPGs named <code>001_description.jpg</code>.</div></div>
    <div class="card"><h2 style="margin-top:0">Project settings</h2>
      <form id="edit"><label>Name</label><input name="name" value="${esc(p.name)}"><label>Client</label><input name="client" value="${esc(p.client)}">
      <div class="grid"><div><label>GST %</label><input name="gst_rate" inputmode="decimal" value="${p.gst_rate}"></div><div><label>PST %</label><input name="pst_rate" inputmode="decimal" value="${p.pst_rate}"></div></div>
      <div class="actions"><button class="pri">Save</button><button type="button" id="arch">${p.archived ? 'Unarchive' : 'Archive'}</button><button type="button" class="danger" id="del">Delete project</button></div></form></div>`;

  const link = (ext) => () => {
    const q = new URLSearchParams(); if ($('#from').value) q.set('from', $('#from').value); if ($('#to').value) q.set('to', $('#to').value);
    return `/api/projects/${p.id}/${ext}?${q}`;
  };
  for (const [elId, path] of [['zip', 'export.zip'], ['pdf', 'report.pdf'], ['csv', 'report.csv']]) {
    $('#' + elId).onclick = (ev) => { ev.preventDefault(); if (!navigator.onLine) return toast('Exports need a connection to the server', true); location.href = link(path)(); };
  }
  $('#edit').onsubmit = async (ev) => {
    ev.preventDefault();
    const f = Object.fromEntries(new FormData(ev.target));
    try { await api('PATCH', `/projects/${p.id}`, { ...f, gst_rate: parseFloat(f.gst_rate) || 0, pst_rate: parseFloat(f.pst_rate) || 0 }); toast('Saved'); route(); }
    catch (e) { toast(e.message, true); }
  };
  $('#arch').onclick = async () => { await api('PATCH', `/projects/${p.id}`, { archived: !p.archived }); location.hash = '#/'; };
  $('#del').onclick = async () => {
    if (!confirm(`Delete "${p.name}" and its ${p.all.count} receipts? This cannot be undone.`)) return;
    await api('DELETE', `/projects/${p.id}`); location.hash = '#/';
  };
  app.querySelectorAll('[data-discard]').forEach((b) => (b.onclick = async (ev) => {
    ev.preventDefault(); if (confirm('Discard this unsynced receipt?')) { await queueDel(b.dataset.discard); await renderBanner(); route(); }
  }));
}

async function viewReceiptForm({ projectId, receiptId }) {
  let r = null, project;
  if (receiptId) {
    r = await api('GET', `/receipts/${receiptId}`);
    project = await api('GET', `/projects/${r.project_id}`);
    projectId = r.project_id;
  } else {
    try { project = await api('GET', `/projects/${projectId}`); }
    catch (e) {
      const cached = localStorage.getItem('project-' + projectId);
      if (!isNetworkError(e) || !cached) throw e;
      project = JSON.parse(cached);
    }
  }
  const allProjects = receiptId ? await api('GET', '/projects').catch(() => []) : [];
  let billable = r ? r.billable : true;
  let imageData = null, removeImage = false;
  const v = r || { date: today(), vendor: '', description: '', subtotal: 0, gst: 0, pst: 0, tip: 0, notes: '' };
  const existingImg = r?.has_image ? `/api/receipts/${r.id}/image` : '';

  app.innerHTML = `<p><a href="#/p/${projectId}">← ${esc(project.name)}</a></p>
    <h1>${r ? `Receipt #${String(r.number).padStart(3, '0')}` : 'New receipt'}</h1>
    <form id="f" class="card">
      <label>Photo</label>
      <div class="row"><label class="btn pri" style="margin:0">📷 Take photo<input id="cam" type="file" accept="image/*" capture="environment" hidden></label>
        <label class="btn" style="margin:0">🖼 Choose file<input id="pick" type="file" accept="image/*" hidden></label>
        ${r?.has_image ? '<button type="button" id="rmimg" class="danger">Remove</button>' : ''}</div>
      <img id="prev" class="preview" ${existingImg ? `src="${existingImg}"` : 'hidden'} alt="">
      <div class="grid"><div><label>Date</label><input type="date" name="date" value="${esc(v.date)}" required></div>
        <div><label>Vendor</label><input name="vendor" value="${esc(v.vendor)}" autocomplete="off"></div></div>
      <label>Description</label><input name="description" value="${esc(v.description)}" placeholder="Used for the picture file name" autocomplete="off">
      <label>Type</label><div class="toggle"><button type="button" data-b="1" class="${billable ? 'on' : ''}">Billable</button><button type="button" data-b="0" class="${billable ? '' : 'on'}">Non-billable</button></div>
      <div class="grid g4">
        <div><label>Subtotal</label><input name="subtotal" inputmode="decimal" value="${fromCents(v.subtotal)}" placeholder="0.00"></div>
        <div><label>GST</label><input name="gst" inputmode="decimal" value="${fromCents(v.gst)}" placeholder="0.00"></div>
        <div><label>PST</label><input name="pst" inputmode="decimal" value="${fromCents(v.pst)}" placeholder="0.00"></div>
        <div><label>Tip</label><input name="tip" inputmode="decimal" value="${fromCents(v.tip)}" placeholder="0.00"></div></div>
      <div class="row" style="margin-top:8px"><button type="button" id="auto">Auto GST/PST (${project.gst_rate}% / ${project.pst_rate}%)</button><span class="muted small">fills from subtotal; edit freely</span></div>
      <div class="totalbar">Total <span id="tot">$0.00</span></div>
      <label>Notes</label><textarea name="notes" rows="2">${esc(v.notes)}</textarea>
      ${receiptId && allProjects.length > 1 ? `<label>Project</label><select name="project_id">${allProjects.map((p) => `<option value="${p.id}" ${p.id === projectId ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>` : ''}
      <div class="actions"><button class="pri" id="save">Save receipt</button>${r ? '<button type="button" class="danger" id="del">Delete</button>' : ''}</div>
    </form>`;

  const form = $('#f');
  const recalc = () => { const g = (n) => toCents(form[n].value); $('#tot').textContent = money(g('subtotal') + g('gst') + g('pst') + g('tip')); };
  form.addEventListener('input', recalc); recalc();
  form.querySelectorAll('[data-b]').forEach((b) => (b.onclick = () => {
    billable = b.dataset.b === '1';
    form.querySelectorAll('[data-b]').forEach((x) => x.classList.toggle('on', x === b));
  }));
  $('#auto').onclick = () => {
    const s = toCents(form.subtotal.value);
    form.gst.value = fromCents(Math.round(s * project.gst_rate / 100));
    form.pst.value = fromCents(Math.round(s * project.pst_rate / 100)); recalc();
  };
  const onFile = async (ev) => {
    const file = ev.target.files[0]; if (!file) return;
    try { imageData = await toJpegDataUrl(file); removeImage = false; $('#prev').src = imageData; $('#prev').hidden = false; }
    catch (e) { toast(e.message, true); }
    ev.target.value = '';
  };
  $('#cam').onchange = onFile; $('#pick').onchange = onFile;
  if ($('#rmimg')) $('#rmimg').onclick = () => { removeImage = true; imageData = null; $('#prev').hidden = true; };

  form.onsubmit = async (ev) => {
    ev.preventDefault();
    const g = (n) => toCents(form[n].value);
    const data = { date: form.date.value, vendor: form.vendor.value, description: form.description.value, billable,
      subtotal: g('subtotal'), gst: g('gst'), pst: g('pst'), tip: g('tip'), notes: form.notes.value };
    $('#save').disabled = true;
    try {
      if (r) {
        if (imageData) data.image = imageData; else if (removeImage) data.remove_image = true;
        if (form.project_id) data.project_id = Number(form.project_id.value);
        await api('PATCH', `/receipts/${r.id}`, data);
      } else {
        if (imageData) data.image = imageData;
        const client_id = uuid();
        try { await api('POST', `/projects/${projectId}/receipts`, { ...data, client_id }); }
        catch (e) {
          if (!isNetworkError(e)) throw e;
          await queuePut({ client_id, project_id: projectId, data, created: Date.now() });   // save locally, sync later
          await renderBanner();
          toast('Offline — saved on this device, will sync automatically');
        }
      }
      location.hash = `#/p/${projectId}`;
    } catch (e) { toast(isNetworkError(e) ? 'Editing needs a connection' : e.message, true); $('#save').disabled = false; }
  };
  if ($('#del')) $('#del').onclick = async () => {
    if (!confirm('Delete this receipt?')) return;
    await api('DELETE', `/receipts/${r.id}`); location.hash = `#/p/${projectId}`;
  };
}

// ------------------------------------------------------------------ boot
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
renderNet();
route();
renderBanner();
flushQueue();
