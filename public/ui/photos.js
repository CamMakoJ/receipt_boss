// Photo strip for receipts and household items: choose/take (several) -> crop screen -> optional on-device OCR -> onScan(text).
import { $, toast, icon } from './core.js';
import { openCropper } from '../crop.js';
import { scanCanvas, cancelScan, warmOcr } from '../ocr.js';

export const ocrOn = () => localStorage.getItem('ocr-on') !== '0';
export const setOcrOn = (on) => localStorage.setItem('ocr-on', on ? '1' : '0');

export function photoField() {
  return `<div class="stack tight">
    <div class="row between"><span class="lbl">Photos</span><span class="hint">up to 12 — long receipts, warranty card, serial number…</span></div>
    <div class="row">
      <label class="btn primary">${icon('camera')} Take photo<input id="cam" type="file" accept="image/*" capture="environment" hidden></label>
      <label class="btn">${icon('image')} Choose files<input id="pick" type="file" accept="image/*" multiple hidden></label>
      <button type="button" class="btn ghost" id="rescan" hidden>${icon('scan')} Read text again</button>
    </div>
    <div id="strip" class="strip"></div>
    <label class="check"><input type="checkbox" id="ocrtoggle" ${ocrOn() ? 'checked' : ''}><span>Read each photo automatically after cropping <span class="hint">(on this device — nothing is uploaded for reading)</span></span></label>
    <div id="scanmsg" class="scanmsg" hidden></div>
  </div>`;
}

/** Tap a thumbnail to look at the photo full screen. */
export function openViewer(src) {
  const box = document.createElement('div');
  box.className = 'viewer';
  box.innerHTML = `<img src="${src}" alt=""><button class="iconbtn" type="button" aria-label="Close">${icon('x')}</button>`;
  box.onclick = () => box.remove();
  document.body.appendChild(box);
}

/** Full-screen "Reading receipt…" overlay with a skip button. */
export async function runScan(canvas, onText) {
  const box = document.createElement('div');
  box.className = 'scan-overlay';
  box.innerHTML = '<div class="card" role="status"><div class="spinner"></div><b id="scanstat">Starting…</b><div class="bar"><i id="scanbar"></i></div><button type="button" class="btn sm" id="scanskip">Skip</button></div>';
  document.body.appendChild(box);
  $('#scanskip', box).onclick = () => cancelScan();
  const onProgress = (m) => {
    const pct = Math.round((m.progress || 0) * 100), reading = m.status === 'recognizing text';
    $('#scanstat', box).textContent = reading ? `Reading receipt… ${pct}%` : /language|traineddata|loading/.test(m.status) ? 'Loading reader (first time only)…' : 'Preparing…';
    $('#scanbar', box).style.width = (reading ? pct : 5) + '%';
  };
  try { onText(await scanCanvas(canvas, { onProgress })); return true; }
  catch (e) { if (!e.cancelled) toast('Could not read the text on this photo — fill it in by hand', true); return false; }
  finally { box.remove(); }
}

/**
 * Wires the photo strip. Returns the state the form reads on save: st.payload(create) = the photo fields of the request body.
 * @param {(text:string)=>void} onScan  called with the OCR text of each newly added photo
 */
export function wirePhoto(onScan, { kind, rec } = {}) {
  const base = kind === 'item' ? '/api/items' : '/api/receipts';
  const st = {
    existing: (rec?.photos || []).map((id) => ({ id, src: `${base}/${rec.id}/photos/${id}` })),   // already on the server, in order (first = cover)
    removed: [], added: [], orderChanged: false, last: null, lastEntry: null,                      // added: [{ dataUrl, text }]
  };
  st.text = () => st.added.map((a) => a.text).filter(Boolean).join('\n\n');                      // what OCR read from the newly added photos
  st.payload = (create) => {
    const o = {}, adds = st.added.map((a) => a.dataUrl), text = st.text();
    if (create) { if (adds.length) o.images = adds; if (text) o.ocr_text = text; }
    else {
      if (adds.length) o.add_images = adds;
      if (st.removed.length) o.remove_photo_ids = st.removed;
      if (st.orderChanged) o.photo_order = st.existing.map((p) => p.id);
      if (text) o.ocr_append = text;                                                              // keep the text of earlier pages
    }
    return o;
  };
  const total = () => st.existing.length + st.added.length;
  const render = () => {
    const tiles = [
      ...st.existing.map((p, i) => ({ src: p.src, old: true, id: p.id, cover: i === 0 })),
      ...st.added.map((a, n) => ({ src: a.dataUrl, old: false, n, cover: !st.existing.length && n === 0 })),
    ];
    $('#strip').innerHTML = tiles.map((t) => `<div class="tile"><img src="${t.src}" data-view="${t.src}" alt="Receipt photo">${t.cover && tiles.length > 1 ? '<span class="cover">cover</span>' : ''}
      <button type="button" class="x" data-rm="${t.old ? 'old:' + t.id : 'new:' + t.n}" aria-label="Remove photo">${icon('x')}</button>
      ${t.old && !t.cover ? `<button type="button" class="star" data-cover="${t.id}" title="Make this the cover photo" aria-label="Make this the cover photo">${icon('star')}</button>` : ''}</div>`).join('');
    $('#rescan').hidden = !(onScan && st.last);
  };
  const scan = async (entry) => {
    if (!st.last || !onScan || !entry) return;
    await runScan(st.last, (text) => { entry.text = text; onScan(text); });
  };
  const onFiles = async (ev) => {
    const files = [...ev.target.files]; ev.target.value = '';
    for (const file of files) {
      if (total() >= 12) { toast('Up to 12 photos each', true); break; }
      try {
        const res = await openCropper(file);          // straight to the crop screen
        if (!res) continue;                            // cancelled: skip this photo
        const entry = { dataUrl: res.dataUrl, text: '' };
        st.added.push(entry); st.last = res.canvas; st.lastEntry = entry; render();
        if (onScan && ocrOn()) await scan(entry);
      } catch (e) { toast(e.message, true); }
    }
  };
  $('#cam').onchange = onFiles; $('#pick').onchange = onFiles;
  $('#rescan').onclick = () => scan(st.lastEntry);
  $('#ocrtoggle').onchange = (ev) => setOcrOn(ev.target.checked);
  $('#strip').onclick = (ev) => {
    const rm = ev.target.closest('[data-rm]'), cv = ev.target.closest('[data-cover]'), view = ev.target.closest('[data-view]');
    if (rm) {
      const [k, x] = rm.dataset.rm.split(':'), n = Number(x);
      if (k === 'old') { st.removed.push(n); st.existing = st.existing.filter((p) => p.id !== n); }
      else { if (st.added[n] === st.lastEntry) { st.last = null; st.lastEntry = null; } st.added.splice(n, 1); }
      render();
    } else if (cv) {
      const i = st.existing.findIndex((p) => p.id === Number(cv.dataset.cover));
      st.existing.unshift(...st.existing.splice(i, 1)); st.orderChanged = true; render();
    } else if (view) openViewer(view.dataset.view);
  };
  if (onScan && ocrOn()) warmOcr();                  // fetch the OCR engine in the background while online
  render();
  return st;
}

export const showScanMsg = (html, warn = false) => { const el = $('#scanmsg'); el.innerHTML = html; el.className = 'scanmsg' + (warn ? ' warn' : ''); el.hidden = false; };

/** Put a value in a field only if the user hasn't typed there (empty, a default, or an earlier scan). Marks it for review. */
export function scanFill(el, value, isDefault = false) {
  if (value === null || value === undefined || value === '') return false;
  if (el.value && !el.classList.contains('scanned') && !isDefault) return false;
  el.value = value; el.classList.add('scanned');
  el.addEventListener('input', () => el.classList.remove('scanned'), { once: true });
  return true;
}
