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
const pad = (n) => String(n).padStart(3, '0');

let me = null;   // signed-in user
let meta = null; // provinces + categories

function toast(msg, bad = false) {
  const t = $('#toast');
  t.textContent = msg; t.className = 'toast' + (bad ? ' bad' : ''); t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 3500);
}

async function api(method, url, body) {
  const res = await fetch('/api' + url, {
    method, headers: { 'x-rb': '1', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body && JSON.stringify(body),
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { status: res.status, offline: res.status === 503 });
  return data;
}
const isNetworkError = (e) => e.offline || e instanceof TypeError;
const getMeta = async () => (meta ||= await api('GET', '/meta'));

// ------------------------------------------------------------------ offline queue (IndexedDB)
// Each entry: { client_id, user_id, url, data, label, project_id?, error? } -> POSTed to /api{url} when online.
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
const queueAll = async () => ((await store('readonly', (s) => s.getAll())) || []).filter((i) => i.user_id === me?.id && i.url);
const queuePut = (item) => store('readwrite', (s) => s.put({ ...item, user_id: me.id }));
const queueDel = (id) => store('readwrite', (s) => s.delete(id));

let flushing = false;
async function flushQueue() {
  if (flushing || !navigator.onLine || !me) return;
  flushing = true;
  let sent = 0;
  try {
    for (const item of await queueAll()) {
      try {
        await api('POST', item.url, { ...item.data, client_id: item.client_id });
        await queueDel(item.client_id); sent++;
      } catch (e) {
        if (isNetworkError(e)) break;                       // still offline: try again later
        if (e.status === 401) { await showAuth(); break; }  // session expired: sign in again, queue is kept
        if (e.status === 404 || e.status === 400) await queuePut({ ...item, error: e.message }); // can never succeed: flag it
        else break;
      }
    }
  } finally { flushing = false; }
  if (sent) { toast(`Synced ${sent} item${sent > 1 ? 's' : ''}`); route(); }
  await renderBanner();
}

async function renderBanner() {
  const q = me ? await queueAll() : [];
  const el = $('#sync');
  el.hidden = !q.length;
  if (q.length) {
    const failed = q.filter((i) => i.error).length;
    el.innerHTML = `<span>${q.length} item${q.length > 1 ? 's' : ''} waiting to sync${failed ? ` (${failed} need attention)` : ''}</span><button id="syncnow">Sync now</button>`;
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
      const img = new Image();
      img.onload = () => resolve(img); img.onerror = () => reject(new Error('Could not read that image'));
      img.src = URL.createObjectURL(file);
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
/** Photo picker markup + wiring shared by receipt and item forms. Returns getters for the chosen image state. */
function photoField(existingSrc) {
  return `<label>Photo</label>
    <div class="row"><label class="btn pri" style="margin:0">📷 Take photo<input id="cam" type="file" accept="image/*" capture="environment" hidden></label>
      <label class="btn" style="margin:0">🖼 Choose file<input id="pick" type="file" accept="image/*" hidden></label>
      ${existingSrc ? '<button type="button" id="rmimg" class="danger">Remove</button>' : ''}</div>
    <img id="prev" class="preview" ${existingSrc ? `src="${existingSrc}"` : 'hidden'} alt="">`;
}
function wirePhoto() {
  const st = { data: null, remove: false };
  const onFile = async (ev) => {
    const file = ev.target.files[0]; if (!file) return;
    try { st.data = await toJpegDataUrl(file); st.remove = false; $('#prev').src = st.data; $('#prev').hidden = false; }
    catch (e) { toast(e.message, true); }
    ev.target.value = '';
  };
  $('#cam').onchange = onFile; $('#pick').onchange = onFile;
  if ($('#rmimg')) $('#rmimg').onclick = () => { st.remove = true; st.data = null; $('#prev').hidden = true; };
  return st;
}

// ------------------------------------------------------------------ auth screens
async function showAuth() {
  me = null; $('#nav').hidden = true; $('#sync').hidden = true;
  let st;
  try { st = await api('GET', '/auth/status'); }
  catch (e) {
    app.innerHTML = `<div class="card"><b>${isNetworkError(e) ? 'The server is not reachable and you are signed out.' : esc(e.message)}</b><p class="muted">Reconnect to sign in.</p><button onclick="location.reload()">Retry</button></div>`;
    return;
  }
  if (st.user) { me = st.user; return start(); }
  const setup = st.needsSetup;
  app.innerHTML = `<div class="card auth"><h1>${setup ? 'Welcome — create the admin account' : 'Sign in'}</h1>
    ${setup ? '<p class="muted">This first account is the administrator. You can add family members afterwards in Settings.</p>' : ''}
    <form id="auth"><label>Username</label><input name="username" autocomplete="username" autocapitalize="none" required>
    <label>Password ${setup ? '(8+ characters)' : ''}</label><input name="password" type="password" autocomplete="${setup ? 'new-password' : 'current-password'}" required>
    <p><button class="pri" style="width:100%">${setup ? 'Create account' : 'Sign in'}</button></p></form></div>`;
  $('#auth').onsubmit = async (ev) => {
    ev.preventDefault();
    try {
      const r = await api('POST', setup ? '/auth/setup' : '/auth/login', Object.fromEntries(new FormData(ev.target)));
      me = r.user; start();
    } catch (e) { toast(isNetworkError(e) ? 'Cannot reach the server' : e.message, true); }
  };
}

async function logout() {
  try { await api('POST', '/auth/logout', {}); } catch { /* offline: cookie stays, but local caches are still cleared below */ }
  try { for (const k of await caches.keys()) if (k.startsWith('data-')) await caches.delete(k); } catch { /* ignore */ }
  Object.keys(localStorage).filter((k) => k.startsWith('project-')).forEach((k) => localStorage.removeItem(k));
  meta = null; location.hash = '#/'; location.reload();
}

// ------------------------------------------------------------------ router
function renderNav(active) {
  const nav = $('#nav'); nav.hidden = !me;
  if (!me) return;
  nav.innerHTML = [['projects', '#/', 'Projects'], ['household', '#/household', 'Household'], ['settings', '#/settings', `⚙ ${esc(me.username)}`]]
    .map(([k, href, label]) => `<a href="${href}" class="${k === active ? 'on' : ''}">${label}</a>`).join('');
}

async function route() {
  if (!me) return;
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  try {
    await getMeta();
    if (parts[0] === 'household') { renderNav('household'); return parts[1] === 'new' ? await viewItemForm({}) : parts[1] ? await viewItemForm({ itemId: parts[1] }) : await viewItems(); }
    if (parts[0] === 'settings') { renderNav('settings'); return await viewSettings(); }
    renderNav('projects');
    if (!parts.length) return await viewProjects();
    if (parts[0] === 'p' && parts[2] === 'new') return await viewReceiptForm({ projectId: parts[1] });
    if (parts[0] === 'p') return await viewProject(parts[1]);
    if (parts[0] === 'r') return await viewReceiptForm({ receiptId: parts[1] });
    return await viewProjects();
  } catch (e) {
    if (e.status === 401) return showAuth();
    app.innerHTML = `<div class="card"><b>${isNetworkError(e) ? 'You are offline and this page was not cached yet.' : esc(e.message)}</b><p><a href="#/">Back to projects</a></p></div>`;
  }
}
addEventListener('hashchange', route);

const provLabel = (code) => `${code} — ${meta.provinces[code].name}`;
const provOptions = (sel) => Object.keys(meta.provinces).map((c) => `<option value="${c}" ${c === sel ? 'selected' : ''}>${esc(provLabel(c))} (${esc(meta.provinces[c].note)})</option>`).join('');
const catOptions = (list, used = []) => [...new Set([...list, ...used])].map((c) => `<option value="${esc(c)}">`).join('');
const calcTax = (sub, prov) => {
  const p = meta.provinces[prov] || meta.provinces[meta.default_province];
  return { gst: Math.round((sub * p.gst) / 100000), pst: Math.round((sub * p.pst) / 100000) };
};

// ------------------------------------------------------------------ projects
async function viewProjects() {
  const projects = await api('GET', '/projects');
  const active = projects.filter((p) => !p.archived), archived = projects.filter((p) => p.archived);
  const card = (p) => `<a class="card" href="#/p/${p.id}">
      <div class="spread"><b>${esc(p.name)}</b><span class="money"><b>${money(p.all.total)}</b></span></div>
      <div class="muted">${esc(p.client)}${p.client ? ' · ' : ''}${p.all.count} receipt${p.all.count === 1 ? '' : 's'} · ${esc(p.province)}</div>
      <div class="row small"><span class="pill">Billable ${money(p.billable.total)}</span><span class="pill nb">Non-billable ${money(p.non_billable.total)}</span></div></a>`;
  app.innerHTML = `<h1>Projects</h1>
    ${active.map(card).join('') || '<p class="muted">No projects yet. Create one to start adding receipts.</p>'}
    <div class="card"><h2 style="margin-top:0">New project</h2>
      <form id="newp">
        <label>Name</label><input name="name" required placeholder="e.g. Kitchen reno">
        <label>Client (optional)</label><input name="client">
        <label>Default province (receipts can override)</label><select name="province">${provOptions(meta.default_province)}</select>
        <p><button class="pri">Create project</button></p>
      </form></div>
    ${archived.length ? `<h2>Archived</h2>${archived.map(card).join('')}` : ''}`;
  $('#newp').onsubmit = async (ev) => {
    ev.preventDefault();
    try { const p = await api('POST', '/projects', Object.fromEntries(new FormData(ev.target))); location.hash = `#/p/${p.id}`; }
    catch (e) { toast(isNetworkError(e) ? 'Creating projects needs a connection' : e.message, true); }
  };
}

async function viewProject(id) {
  const p = await api('GET', `/projects/${id}`);
  localStorage.setItem('project-' + id, JSON.stringify({ id: p.id, name: p.name, province: p.province }));
  const pending = (await queueAll()).filter((i) => String(i.project_id) === String(id));
  const bill = p.receipts.filter((r) => r.billable), non = p.receipts.filter((r) => !r.billable);

  const sumTable = `<table class="t"><tr><th></th><th>Subtotal</th><th>GST/HST</th><th>PST/QST</th><th>Tip</th><th>Total</th></tr>
    ${[['Billable', p.billable], ['Non-billable', p.non_billable], ['All', p.all]].map(([n, t]) =>
      `<tr><td>${n}</td><td>${money(t.subtotal)}</td><td>${money(t.gst)}</td><td>${money(t.pst)}</td><td>${money(t.tip)}</td><td><b>${money(t.total)}</b></td></tr>`).join('')}</table>`;

  const rcpt = (r) => `<a class="card row" href="#/r/${r.id}" style="flex-wrap:nowrap">
      ${r.has_image ? `<img class="thumb" loading="lazy" src="/api/receipts/${r.id}/image" alt="">` : '<div class="thumb"></div>'}
      <div class="grow"><div class="spread"><b>#${pad(r.number)} ${esc(r.description || r.vendor || 'Receipt')}</b><span class="money"><b>${money(r.total)}</b></span></div>
      <div class="muted small">${esc(r.date)}${r.vendor ? ' · ' + esc(r.vendor) : ''} · ${esc(r.province)}${r.category ? ' · ' + esc(r.category) : ''}</div>
      <div class="muted small">Sub ${money(r.subtotal)} · GST ${money(r.gst)} · PST ${money(r.pst)} · Tip ${money(r.tip)}</div></div></a>`;
  const pend = (i) => `<div class="card row" style="flex-wrap:nowrap"><div class="thumb"></div><div class="grow">
      <div class="spread"><b>${esc(i.label)}</b></div>
      <span class="pill pending">${i.error ? 'Needs attention: ' + esc(i.error) : 'Waiting to sync'}</span> <span class="pill ${i.data.billable ? '' : 'nb'}">${i.data.billable ? 'Billable' : 'Non-billable'}</span></div>
      <button class="danger" data-discard="${esc(i.client_id)}">✕</button></div>`;

  app.innerHTML = `<p><a href="#/">← Projects</a></p>
    <h1>${esc(p.name)}</h1><div class="muted">${esc(p.client)}${p.client ? ' · ' : ''}${esc(meta.provinces[p.province]?.name || p.province)}</div>
    <div class="actions"><a class="btn pri" href="#/p/${p.id}/new">＋ Add receipt</a></div>
    <div class="card">${sumTable}</div>
    ${pending.length ? `<h2>Pending sync (${pending.length})</h2>${pending.map(pend).join('')}` : ''}
    <h2>Billable (${bill.length})</h2>${bill.map(rcpt).join('') || '<p class="muted">None</p>'}
    <h2>Non-billable (${non.length})</h2>${non.map(rcpt).join('') || '<p class="muted">None</p>'}
    <div class="card"><h2 style="margin-top:0">Export report</h2>
      <div class="grid"><div><label>From</label><input type="date" id="from"></div><div><label>To</label><input type="date" id="to"></div></div>
      <label class="check"><input type="checkbox" id="autotax" checked> Auto-calculate GST/PST for receipts with no tax entered (from each receipt's province; marked * in the report)</label>
      <div class="actions"><a class="btn pri" id="zip">⬇ Report bundle (.zip)</a><a class="btn" id="pdf">PDF</a><a class="btn" id="csv">CSV</a></div>
      <div class="muted small">Bundle = PDF report with receipt images + CSV + <code>receipts/</code> folder of JPGs named <code>001_description.jpg</code>.</div></div>
    <div class="card"><h2 style="margin-top:0">Project settings</h2>
      <form id="edit"><label>Name</label><input name="name" value="${esc(p.name)}"><label>Client</label><input name="client" value="${esc(p.client)}">
      <label>Default province for new receipts</label><select name="province">${provOptions(p.province)}</select>
      <div class="actions"><button class="pri">Save</button><button type="button" id="arch">${p.archived ? 'Unarchive' : 'Archive'}</button><button type="button" class="danger" id="del">Delete project</button></div></form></div>`;

  const link = (path) => {
    const q = new URLSearchParams();
    if ($('#from').value) q.set('from', $('#from').value);
    if ($('#to').value) q.set('to', $('#to').value);
    if (!$('#autotax').checked) q.set('autotax', '0');
    return `/api/projects/${p.id}/${path}?${q}`;
  };
  for (const [elId, path] of [['zip', 'export.zip'], ['pdf', 'report.pdf'], ['csv', 'report.csv']]) {
    $('#' + elId).onclick = (ev) => { ev.preventDefault(); if (!navigator.onLine) return toast('Exports need a connection to the server', true); location.href = link(path); };
  }
  $('#edit').onsubmit = async (ev) => {
    ev.preventDefault();
    try { await api('PATCH', `/projects/${p.id}`, Object.fromEntries(new FormData(ev.target))); toast('Saved'); route(); }
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

// ------------------------------------------------------------------ receipt form
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
  const v = r || { date: today(), vendor: '', category: '', description: '', province: project.province, subtotal: 0, gst: 0, pst: 0, tip: 0, notes: '' };
  const autoTax = r ? r.tax_auto : true;

  app.innerHTML = `<p><a href="#/p/${projectId}">← ${esc(project.name)}</a></p>
    <h1>${r ? `Receipt #${pad(r.number)}` : 'New receipt'}</h1>
    <form id="f" class="card">
      ${photoField(r?.has_image ? `/api/receipts/${r.id}/image` : '')}
      <div class="grid"><div><label>Date</label><input type="date" name="date" value="${esc(v.date)}" required></div>
        <div><label>Vendor</label><input name="vendor" value="${esc(v.vendor)}" autocomplete="off"></div></div>
      <label>Province of purchase</label><select name="province">${provOptions(v.province)}</select>
      <label>Category</label><input name="category" list="cats" value="${esc(v.category)}" autocomplete="off" placeholder="pick from the list or type your own">
      <datalist id="cats">${catOptions(meta.receipt_categories, meta.used_categories)}</datalist>
      <label>Description <span class="muted small">(fills from category; edit freely — used in the picture file name)</span></label>
      <input name="description" value="${esc(v.description)}" autocomplete="off">
      <label>Type</label><div class="toggle"><button type="button" data-b="1" class="${billable ? 'on' : ''}">Billable</button><button type="button" data-b="0" class="${billable ? '' : 'on'}">Non-billable</button></div>
      <div class="grid g4">
        <div><label>Subtotal</label><input name="subtotal" inputmode="decimal" value="${fromCents(v.subtotal)}" placeholder="0.00"></div>
        <div><label>GST/HST</label><input name="gst" inputmode="decimal" value="${fromCents(v.gst)}" placeholder="0.00"></div>
        <div><label>PST/QST</label><input name="pst" inputmode="decimal" value="${fromCents(v.pst)}" placeholder="0.00"></div>
        <div><label>Tip</label><input name="tip" inputmode="decimal" value="${fromCents(v.tip)}" placeholder="0.00"></div></div>
      <label class="check"><input type="checkbox" id="taxauto" ${autoTax ? 'checked' : ''}> Auto-calculate taxes from subtotal &amp; province <span class="muted small" id="rates"></span></label>
      <div class="totalbar">Total <span id="tot">$0.00</span></div>
      <label>Notes</label><textarea name="notes" rows="2">${esc(v.notes)}</textarea>
      ${receiptId && allProjects.length > 1 ? `<label>Project</label><select name="project_id">${allProjects.map((p) => `<option value="${p.id}" ${p.id === projectId ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>` : ''}
      <div class="actions"><button class="pri" id="save">Save receipt</button>${r ? '<button type="button" class="danger" id="del">Delete</button>' : ''}</div>
    </form>`;

  const form = $('#f');
  const photo = wirePhoto();
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
  for (const n of ['gst', 'pst']) form[n].addEventListener('input', () => { $('#taxauto').checked = false; applyAuto(); }); // typing a tax = manual
  form.tip.addEventListener('input', recalc);
  applyAuto();

  // description follows category until the user writes their own
  let autoDesc = v.category, descCustom = !!v.description && v.description !== v.category;
  form.category.addEventListener('input', () => { if (!descCustom) { form.description.value = form.category.value; autoDesc = form.category.value; } });
  form.description.addEventListener('input', () => { descCustom = form.description.value !== '' && form.description.value !== autoDesc; });

  form.querySelectorAll('[data-b]').forEach((b) => (b.onclick = () => {
    billable = b.dataset.b === '1';
    form.querySelectorAll('[data-b]').forEach((x) => x.classList.toggle('on', x === b));
  }));

  form.onsubmit = async (ev) => {
    ev.preventDefault();
    const data = { date: form.date.value, vendor: form.vendor.value, province: form.province.value, category: form.category.value.trim(),
      description: form.description.value, billable, tax_auto: $('#taxauto').checked,
      subtotal: g('subtotal'), gst: g('gst'), pst: g('pst'), tip: g('tip'), notes: form.notes.value };
    $('#save').disabled = true;
    try {
      if (r) {
        if (photo.data) data.image = photo.data; else if (photo.remove) data.remove_image = true;
        if (form.project_id) data.project_id = Number(form.project_id.value);
        await api('PATCH', `/receipts/${r.id}`, data);
      } else {
        if (photo.data) data.image = photo.data;
        const client_id = uuid();
        try { await api('POST', `/projects/${projectId}/receipts`, { ...data, client_id }); }
        catch (e) {
          if (!isNetworkError(e)) throw e;
          await queuePut({ client_id, url: `/projects/${projectId}/receipts`, project_id: projectId, data,
            label: data.description || data.category || data.vendor || 'Receipt' });   // save locally, sync later
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

// ------------------------------------------------------------------ household items / warranty
function warrantyInfo(i) {
  if (!i.warranty_expires) return { key: 'unknown', text: 'Warranty unknown', cls: 'nb' };
  const days = Math.round((Date.parse(i.warranty_expires) - Date.parse(today())) / 864e5);
  if (days < 0) return { key: 'expired', text: `Expired ${i.warranty_expires}`, cls: 'bad', days };
  if (days <= 90) return { key: 'expiring', text: `Ends ${i.warranty_expires} (${days} day${days === 1 ? '' : 's'})`, cls: 'pending', days };
  return { key: 'active', text: `Covered until ${i.warranty_expires}`, cls: '', days };
}

async function viewItems() {
  const items = await api('GET', '/items');
  const groups = [['expiring', 'Warranty ending soon'], ['active', 'Under warranty'], ['unknown', 'Warranty unknown'], ['expired', 'Expired']];
  const row = (i) => { const w = warrantyInfo(i); return `<a class="card row" href="#/household/${i.id}" style="flex-wrap:nowrap" data-q="${esc((i.name + ' ' + i.vendor + ' ' + i.category + ' ' + i.serial).toLowerCase())}">
      ${i.has_image ? `<img class="thumb" loading="lazy" src="/api/items/${i.id}/image" alt="">` : '<div class="thumb"></div>'}
      <div class="grow"><div class="spread"><b>${esc(i.name)}</b><span class="money">${i.price ? money(i.price) : ''}</span></div>
      <div class="muted small">Bought ${esc(i.purchase_date)}${i.vendor ? ' · ' + esc(i.vendor) : ''}${i.category ? ' · ' + esc(i.category) : ''}</div>
      <span class="pill ${w.cls}">${esc(w.text)}</span></div></a>`; };
  app.innerHTML = `<h1>Household items &amp; warranties</h1>
    <p class="muted">Big purchases you may need proof of later — shared with everyone on this server.</p>
    <div class="actions"><a class="btn pri" href="#/household/new">＋ Add item</a><a class="btn" href="/api/items.csv">CSV</a></div>
    ${items.length ? '<input id="q" type="search" placeholder="Search items…" style="margin-bottom:12px">' : '<p class="muted">Nothing here yet.</p>'}
    <div id="list">${groups.map(([k, title]) => { const list = items.filter((i) => warrantyInfo(i).key === k)
      .sort((a, b) => (warrantyInfo(a).days ?? 0) - (warrantyInfo(b).days ?? 0) || b.purchase_date.localeCompare(a.purchase_date));
      return list.length ? `<h2>${title} (${list.length})</h2>${list.map(row).join('')}` : ''; }).join('')}</div>`;
  if ($('#q')) $('#q').oninput = (ev) => { const q = ev.target.value.toLowerCase(); app.querySelectorAll('#list [data-q]').forEach((el) => (el.hidden = !el.dataset.q.includes(q))); };
}

async function viewItemForm({ itemId }) {
  const i = itemId ? await api('GET', `/items/${itemId}`) : null;
  const v = i || { name: '', category: '', purchase_date: today(), vendor: '', price: 0, warranty_months: null, serial: '', notes: '' };
  const yrs = v.warranty_months && v.warranty_months % 12 === 0;
  const wval = v.warranty_months ? (yrs ? v.warranty_months / 12 : v.warranty_months) : '';

  app.innerHTML = `<p><a href="#/household">← Household</a></p><h1>${i ? esc(i.name) : 'New item'}</h1>
    <form id="f" class="card">
      ${photoField(i?.has_image ? `/api/items/${i.id}/image` : '')}
      <label>Item</label><input name="name" value="${esc(v.name)}" required placeholder="e.g. Samsung 65&quot; TV">
      <div class="grid"><div><label>Purchase date</label><input type="date" name="purchase_date" value="${esc(v.purchase_date)}" required></div>
        <div><label>Price</label><input name="price" inputmode="decimal" value="${fromCents(v.price)}" placeholder="0.00"></div></div>
      <div class="grid"><div><label>Vendor</label><input name="vendor" value="${esc(v.vendor)}"></div>
        <div><label>Category</label><input name="category" list="icats" value="${esc(v.category)}"><datalist id="icats">${catOptions(meta.item_categories)}</datalist></div></div>
      <label>Warranty length <span class="muted small">(leave blank if unknown)</span></label>
      <div class="grid"><input name="wnum" inputmode="numeric" value="${wval}" placeholder="e.g. 2">
        <select name="wunit"><option value="12" ${yrs || !v.warranty_months ? 'selected' : ''}>years</option><option value="1" ${v.warranty_months && !yrs ? 'selected' : ''}>months</option></select></div>
      <div class="muted" id="wends" style="margin-top:6px"></div>
      <label>Serial / model number</label><input name="serial" value="${esc(v.serial)}">
      <label>Notes</label><textarea name="notes" rows="2">${esc(v.notes)}</textarea>
      <div class="actions"><button class="pri" id="save">Save</button>${i ? '<button type="button" class="danger" id="del">Delete</button>' : ''}</div>
    </form>`;
  const form = $('#f');
  const photo = wirePhoto();
  const months = () => { const n = parseInt(form.wnum.value, 10); return n > 0 ? n * Number(form.wunit.value) : null; };
  const showEnds = () => {
    const m = months();
    if (!m || !form.purchase_date.value) return ($('#wends').textContent = '');
    const d = new Date(form.purchase_date.value + 'T00:00:00Z'), day = d.getUTCDate();
    d.setUTCMonth(d.getUTCMonth() + m); if (d.getUTCDate() !== day) d.setUTCDate(0);
    $('#wends').textContent = `Warranty ends ${d.toISOString().slice(0, 10)}`;
  };
  ['wnum', 'wunit', 'purchase_date'].forEach((n) => form[n].addEventListener('input', showEnds)); showEnds();

  form.onsubmit = async (ev) => {
    ev.preventDefault();
    const data = { name: form.name.value, purchase_date: form.purchase_date.value, vendor: form.vendor.value, category: form.category.value.trim(),
      price: toCents(form.price.value), warranty_months: months(), serial: form.serial.value, notes: form.notes.value };
    $('#save').disabled = true;
    try {
      if (i) {
        if (photo.data) data.image = photo.data; else if (photo.remove) data.remove_image = true;
        await api('PATCH', `/items/${i.id}`, data);
      } else {
        if (photo.data) data.image = photo.data;
        const client_id = uuid();
        try { await api('POST', '/items', { ...data, client_id }); }
        catch (e) {
          if (!isNetworkError(e)) throw e;
          await queuePut({ client_id, url: '/items', data, label: data.name });
          await renderBanner(); toast('Offline — saved on this device, will sync automatically');
        }
      }
      location.hash = '#/household';
    } catch (e) { toast(isNetworkError(e) ? 'Editing needs a connection' : e.message, true); $('#save').disabled = false; }
  };
  if ($('#del')) $('#del').onclick = async () => { if (confirm('Delete this item?')) { await api('DELETE', `/items/${i.id}`); location.hash = '#/household'; } };
}

// ------------------------------------------------------------------ settings (account, users, backup)
async function viewSettings() {
  const admin = me.role === 'admin';
  const [users, bk] = admin ? await Promise.all([api('GET', '/users'), api('GET', '/backup')]) : [[], null];
  const when = (s) => (s ? new Date(s).toLocaleString() : 'never');

  app.innerHTML = `<h1>Settings</h1>
    <div class="card"><h2 style="margin-top:0">Account — ${esc(me.username)}${admin ? ' <span class="pill">admin</span>' : ''}</h2>
      <form id="pw"><label>Current password</label><input type="password" name="current" autocomplete="current-password" required>
      <label>New password (8+ characters)</label><input type="password" name="password" autocomplete="new-password" required>
      <div class="actions"><button class="pri">Change password</button><button type="button" id="out">Sign out</button></div></form></div>
    ${admin ? `
    <div class="card"><h2 style="margin-top:0">Users</h2>
      ${users.map((u) => `<div class="row" style="padding:6px 0;border-bottom:1px solid var(--line)">
        <div class="grow"><b>${esc(u.username)}</b> <span class="pill ${u.role === 'admin' ? '' : 'nb'}">${u.role}</span> <span class="muted small">${u.projects} project${u.projects === 1 ? '' : 's'}</span></div>
        <button data-reset="${u.id}" data-name="${esc(u.username)}">Reset password</button>
        ${u.id === me.id ? '' : `<button data-role="${u.id}" data-to="${u.role === 'admin' ? 'user' : 'admin'}">Make ${u.role === 'admin' ? 'user' : 'admin'}</button><button class="danger" data-rm="${u.id}" data-name="${esc(u.username)}">Delete</button>`}</div>`).join('')}
      <form id="newu" style="margin-top:12px"><h2>Add user</h2><div class="grid"><div><label>Username</label><input name="username" required autocapitalize="none"></div>
        <div><label>Temporary password</label><input name="password" type="password" required autocomplete="new-password"></div></div>
        <label class="check"><input type="checkbox" name="admin"> Administrator</label><p><button class="pri">Add user</button></p></form></div>

    <div class="card"><h2 style="margin-top:0">Backup</h2>
      <p class="muted small">Backs up the whole app (all users' receipts, household items, accounts and images). Last attempt: ${esc(when(bk.status.last_at))}
        · last success: ${esc(when(bk.status.last_ok))}</p>
      ${bk.status.last_message ? `<p class="small ${/FAILED/.test(bk.status.last_message) ? 'errtext' : 'muted'}">${esc(bk.status.last_message)}</p>` : ''}
      <form id="bk">
        <label class="check"><input type="checkbox" name="enabled" ${bk.config.enabled ? 'checked' : ''}> Back up automatically</label>
        <div class="grid"><div><label>Every (hours)</label><input name="interval_hours" inputmode="numeric" value="${bk.config.interval_hours}"></div>
          <div><label>Copies to keep</label><input name="keep" inputmode="numeric" value="${bk.config.keep}"></div></div>
        <label>Google Drive (or any rclone remote) <span class="muted small">e.g. <code>gdrive:ReceiptBoss</code> — set up once with <code>rclone config</code>, see README</span></label>
        <input name="remote" value="${esc(bk.config.remote)}" placeholder="gdrive:ReceiptBoss" autocapitalize="none">
        <label>Also copy to folder on the server <span class="muted small">(optional; e.g. a NAS or Drive-for-desktop folder)</span></label>
        <input name="copy_dir" value="${esc(bk.config.copy_dir)}" placeholder="/mnt/nas/receipt-boss-backups" autocapitalize="none">
        <div class="actions"><button class="pri">Save backup settings</button><button type="button" id="bkrun">Back up now</button><a class="btn" href="/api/backup/download">⬇ Download backup</a></div></form>
      ${bk.files.length ? `<div class="muted small">On this server: ${bk.files.map((f) => `<a href="/api/backup/files/${f.name}">${esc(f.name.replace('receipt-boss-backup-', '').replace('.zip', ''))}</a> (${(f.size / 1048576).toFixed(1)} MB)`).join(' · ')}</div>` : ''}
    </div>` : ''}`;

  $('#out').onclick = logout;
  $('#pw').onsubmit = async (ev) => {
    ev.preventDefault();
    try { await api('POST', '/auth/password', Object.fromEntries(new FormData(ev.target))); ev.target.reset(); toast('Password changed; other devices were signed out'); }
    catch (e) { toast(e.message, true); }
  };
  if (!admin) return;
  const guard = (fn) => async (...a) => { try { await fn(...a); await viewSettings(); } catch (e) { toast(e.message, true); } };
  $('#newu').onsubmit = guard(async (ev) => {
    ev.preventDefault(); const f = new FormData(ev.target);
    await api('POST', '/users', { username: f.get('username'), password: f.get('password'), role: f.get('admin') ? 'admin' : 'user' }); toast('User added');
  });
  app.querySelectorAll('[data-reset]').forEach((b) => (b.onclick = guard(async () => {
    const pw = prompt(`New password for ${b.dataset.name} (8+ characters). They will be signed out everywhere.`);
    if (pw) { await api('PATCH', `/users/${b.dataset.reset}`, { password: pw }); toast('Password reset'); }
  })));
  app.querySelectorAll('[data-role]').forEach((b) => (b.onclick = guard(() => api('PATCH', `/users/${b.dataset.role}`, { role: b.dataset.to }))));
  app.querySelectorAll('[data-rm]').forEach((b) => (b.onclick = guard(async () => {
    if (confirm(`Delete ${b.dataset.name} and ALL of their projects and receipts? This cannot be undone.`)) await api('DELETE', `/users/${b.dataset.rm}`);
  })));
  $('#bk').onsubmit = guard(async (ev) => {
    ev.preventDefault(); const f = new FormData(ev.target);
    await api('PUT', '/backup', { enabled: !!f.get('enabled'), interval_hours: Number(f.get('interval_hours')), keep: Number(f.get('keep')), remote: f.get('remote'), copy_dir: f.get('copy_dir') });
    toast('Backup settings saved');
  });
  $('#bkrun').onclick = guard(async () => {
    $('#bkrun').disabled = true; toast('Backing up…');
    try { const r = await api('POST', '/backup/run', {}); toast(r.message); }
    catch (e) { toast(e.message, true); }
  });
}

// ------------------------------------------------------------------ boot
async function start() {
  renderNav('projects');
  await renderBanner();
  route();
  flushQueue();
}
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
renderNet();
(async () => {
  try {
    const st = await api('GET', '/auth/status');   // served from cache when offline
    if (st.user) { me = st.user; return start(); }
  } catch (e) { if (!isNetworkError(e)) console.error(e); }
  showAuth();
})();
