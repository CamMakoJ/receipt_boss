// Full-screen crop + perspective-correction step shown right after a photo is taken/chosen.
// The receipt is outlined with four free corners; Done flattens whatever is inside into an upright rectangle.
// openCropper(file) -> Promise<{ canvas, dataUrl } | null>   (null = user cancelled)
import { orderQuad, isReasonableQuad, isAxisAligned, outputSize, warpQuad, findPaperQuad, expandQuad } from './warp.js';

const MAX_SRC = 3000; // working resolution; keeps memory sane on phones

/** Decode a File into a canvas with EXIF rotation applied and a bounded size. */
export async function fileToCanvas(file) {
  let bmp;
  try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch {
    bmp = await new Promise((resolve, reject) => { // e.g. HEIC on Safari
      const img = new Image();
      img.onload = () => resolve(img); img.onerror = () => reject(new Error('Could not read that image'));
      img.src = URL.createObjectURL(file);
    });
  }
  const w = bmp.width || bmp.naturalWidth, h = bmp.height || bmp.naturalHeight;
  const k = Math.min(1, MAX_SRC / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.round(w * k); c.height = Math.round(h * k);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  return c;
}

export function canvasToJpeg(canvas, maxDim = 2200, quality = 0.85) {
  const k = Math.min(1, maxDim / Math.max(canvas.width, canvas.height));
  if (k === 1) return canvas.toDataURL('image/jpeg', quality);
  const c = document.createElement('canvas');
  c.width = Math.round(canvas.width * k); c.height = Math.round(canvas.height * k);
  c.getContext('2d').drawImage(canvas, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', quality);
}

const fullQuad = (W, H, inset = 0) => [
  { x: W * inset, y: H * inset }, { x: W * (1 - inset), y: H * inset }, { x: W * (1 - inset), y: H * (1 - inset) }, { x: W * inset, y: H * (1 - inset) },
];

/** Best-guess outline of the paper (a quad, possibly tilted); falls back to almost the full frame. */
export function autoQuad(canvas) {
  const W = canvas.width, H = canvas.height, fallback = fullQuad(W, H, 0.02);
  try {
    const k = 200 / Math.max(W, H);
    const w = Math.max(8, Math.round(W * k)), h = Math.max(8, Math.round(H * k));
    const s = document.createElement('canvas'); s.width = w; s.height = h;
    const sctx = s.getContext('2d', { willReadFrequently: true });
    sctx.drawImage(canvas, 0, 0, w, h);
    const px = sctx.getImageData(0, 0, w, h).data, lum = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) lum[i] = (px[i * 4] * 77 + px[i * 4 + 1] * 150 + px[i * 4 + 2] * 29) >> 8;
    const q = findPaperQuad(lum, w, h);
    if (!q) return fallback;
    return expandQuad(q.map((p) => ({ x: (p.x / w) * W, y: (p.y / h) * H })), 1.015, W, H); // small margin so edge text isn't clipped
  } catch { return fallback; }
}

const rotateCanvas = (src, cw) => {
  const c = document.createElement('canvas');
  c.width = src.height; c.height = src.width;
  const ctx = c.getContext('2d');
  if (cw) { ctx.translate(c.width, 0); ctx.rotate(Math.PI / 2); } else { ctx.translate(0, c.height); ctx.rotate(-Math.PI / 2); }
  ctx.drawImage(src, 0, 0);
  return c;
};

/** Flatten the quad region of `src` into an upright canvas. Plain crop when the quad is already a rectangle. */
export function extractQuad(src, quad) {
  const q = orderQuad(quad);
  const xs = q.map((p) => p.x), ys = q.map((p) => p.y);
  const bx = Math.max(0, Math.floor(Math.min(...xs))), by = Math.max(0, Math.floor(Math.min(...ys)));
  const bw = Math.min(src.width, Math.ceil(Math.max(...xs))) - bx, bh = Math.min(src.height, Math.ceil(Math.max(...ys))) - by;
  const out = document.createElement('canvas');
  if (isAxisAligned(q)) {
    out.width = Math.max(1, bw); out.height = Math.max(1, bh);
    out.getContext('2d').drawImage(src, bx, by, bw, bh, 0, 0, out.width, out.height);
    return out;
  }
  const { w, h } = outputSize(q, MAX_SRC);
  const img = src.getContext('2d').getImageData(bx, by, bw, bh);      // only the part of the photo the quad touches
  const flat = warpQuad(img, q.map((p) => ({ x: p.x - bx, y: p.y - by })), w, h);
  out.width = w; out.height = h;
  out.getContext('2d').putImageData(new ImageData(flat, w, h), 0, 0);
  return out;
}

/** No-UI crop for quick capture: decode, outline the paper automatically, flatten. Falls back to the whole frame. */
export async function autoCropFile(file) {
  const src = await fileToCanvas(file);
  let quad = autoQuad(src);
  if (!isReasonableQuad(quad)) quad = fullQuad(src.width, src.height);
  let canvas;
  try { canvas = extractQuad(src, quad); } catch { canvas = src; }
  return { canvas, dataUrl: canvasToJpeg(canvas) };
}

export async function openCropper(file) {
  let src = await fileToCanvas(file);
  let quad = autoQuad(src);

  const root = document.createElement('div');
  root.className = 'crop';
  root.innerHTML = `
    <div class="crop-bar"><b>Outline the receipt</b><span class="muted" id="crophint">drag the 4 corners onto the receipt's corners</span></div>
    <div class="crop-stage"><canvas></canvas></div>
    <div class="crop-bar crop-actions">
      <button type="button" class="btn" data-a="cancel">Cancel</button>
      <button type="button" class="btn" data-a="ccw" title="Rotate left" aria-label="Rotate left">⟲</button>
      <button type="button" class="btn" data-a="cw" title="Rotate right" aria-label="Rotate right">⟳</button>
      <button type="button" class="btn" data-a="auto">Auto</button>
      <button type="button" class="btn" data-a="full">Reset</button>
      <button type="button" class="btn primary" data-a="done">Done</button>
    </div>`;
  document.body.appendChild(root);
  document.body.classList.add('no-scroll');
  const stage = root.querySelector('.crop-stage');
  const cv = root.querySelector('canvas');
  const ctx = cv.getContext('2d');
  const hint = root.querySelector('#crophint');
  const setHint = (t, bad = false) => { hint.textContent = t; hint.style.color = bad ? '#fca5a5' : ''; };

  let view = { scale: 1, ox: 0, oy: 0, base: null }, dpr = 1;
  const PAD = 22, GRAB = 38;

  function layout() {
    dpr = window.devicePixelRatio || 1;
    const sw = stage.clientWidth, sh = stage.clientHeight;
    cv.style.width = sw + 'px'; cv.style.height = sh + 'px';
    cv.width = Math.round(sw * dpr); cv.height = Math.round(sh * dpr);
    const scale = Math.min((sw - PAD * 2) / src.width, (sh - PAD * 2) / src.height);
    view = { scale, ox: (sw - src.width * scale) / 2, oy: (sh - src.height * scale) / 2, base: document.createElement('canvas') };
    view.base.width = Math.max(1, Math.round(src.width * scale * dpr)); view.base.height = Math.max(1, Math.round(src.height * scale * dpr));
    view.base.getContext('2d').drawImage(src, 0, 0, view.base.width, view.base.height);
    draw();
  }
  const toView = (p) => ({ x: view.ox + p.x * view.scale, y: view.oy + p.y * view.scale });
  const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

  function drawLoupe(pt, finger) {
    const R = 56, zoom = 3;
    const lx = Math.max(R + 6, Math.min(cv.width / dpr - R - 6, finger.x));
    const ly = finger.y > R * 2 + 70 ? finger.y - R - 62 : finger.y + R + 62;      // keep it clear of the finger
    const half = R / zoom / view.scale;                                             // region of the photo shown, in photo px
    ctx.save();
    ctx.beginPath(); ctx.arc(lx, ly, R, 0, Math.PI * 2); ctx.clip();
    ctx.fillStyle = '#000'; ctx.fillRect(lx - R, ly - R, R * 2, R * 2);
    ctx.drawImage(src, pt.x - half, pt.y - half, half * 2, half * 2, lx - R, ly - R, R * 2, R * 2);
    ctx.strokeStyle = '#22d3ee'; ctx.lineWidth = 1.5; ctx.beginPath();
    ctx.moveTo(lx - 14, ly); ctx.lineTo(lx + 14, ly); ctx.moveTo(lx, ly - 14); ctx.lineTo(lx, ly + 14); ctx.stroke();
    ctx.restore();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(lx, ly, R, 0, Math.PI * 2); ctx.stroke();
  }

  function draw(finger) {
    const W = cv.width / dpr, H = cv.height / dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const iw = src.width * view.scale, ih = src.height * view.scale;
    ctx.drawImage(view.base, view.ox, view.oy, iw, ih);
    const v = quad.map(toView);
    ctx.fillStyle = 'rgba(0,0,0,.55)';                                   // dim everything outside the outline
    ctx.beginPath(); ctx.rect(view.ox, view.oy, iw, ih);
    ctx.moveTo(v[0].x, v[0].y); for (let i = 1; i < 4; i++) ctx.lineTo(v[i].x, v[i].y); ctx.closePath();
    ctx.fill('evenodd');
    ctx.strokeStyle = 'rgba(255,255,255,.35)'; ctx.lineWidth = 1; ctx.beginPath(); // perspective-aware thirds grid
    for (const f of [1 / 3, 2 / 3]) {
      const a = lerp(v[0], v[1], f), b = lerp(v[3], v[2], f), c = lerp(v[0], v[3], f), d = lerp(v[1], v[2], f);
      ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.moveTo(c.x, c.y); ctx.lineTo(d.x, d.y);
    }
    ctx.stroke();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.beginPath();
    ctx.moveTo(v[0].x, v[0].y); for (let i = 1; i < 4; i++) ctx.lineTo(v[i].x, v[i].y); ctx.closePath(); ctx.stroke();
    ctx.strokeStyle = 'rgba(0,0,0,.55)'; ctx.lineWidth = 1;
    for (let i = 0; i < 4; i++) {                                         // edge handles (small) then corner handles (large)
      const m = lerp(v[i], v[(i + 1) % 4], 0.5);
      ctx.fillStyle = 'rgba(255,255,255,.9)'; ctx.beginPath(); ctx.arc(m.x, m.y, 7, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
    for (const p of v) { ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(p.x, p.y, 11, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); }
    if (finger && drag?.kind === 'corner') drawLoupe(quad[drag.i], finger);
  }

  const inPoly = (pt, poly) => {
    let inside = false;
    for (let i = 0, j = 3; i < 4; j = i++) {
      const a = poly[i], b = poly[j];
      if ((a.y > pt.y) !== (b.y > pt.y) && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
  };
  function hit(px, py) {
    const v = quad.map(toView), d = (p) => Math.hypot(p.x - px, p.y - py);
    let best = null;
    v.forEach((p, i) => { if (d(p) < GRAB && (!best || d(p) < best.d)) best = { kind: 'corner', i, d: d(p) }; });
    if (best) return best;
    for (let i = 0; i < 4; i++) { const m = lerp(v[i], v[(i + 1) % 4], 0.5); if (d(m) < GRAB * 0.8 && (!best || d(m) < best.d)) best = { kind: 'edge', i, d: d(m) }; }
    if (best) return best;
    return inPoly({ x: px, y: py }, v) ? { kind: 'move' } : null;
  }

  let drag = null;
  const clampPt = (p) => ({ x: Math.max(0, Math.min(src.width, p.x)), y: Math.max(0, Math.min(src.height, p.y)) });
  cv.addEventListener('pointerdown', (ev) => {
    const b = cv.getBoundingClientRect(), px = ev.clientX - b.left, py = ev.clientY - b.top, h = hit(px, py);
    if (!h) return;
    cv.setPointerCapture(ev.pointerId);
    drag = { ...h, px, py, start: quad.map((p) => ({ ...p })) };
    setHint("drag the 4 corners onto the receipt's corners");
    draw({ x: px, y: py });
  });
  cv.addEventListener('pointermove', (ev) => {
    if (!drag) return;
    const b = cv.getBoundingClientRect(), px = ev.clientX - b.left, py = ev.clientY - b.top;
    const dx = (px - drag.px) / view.scale, dy = (py - drag.py) / view.scale, s = drag.start;
    if (drag.kind === 'corner') {
      quad = s.map((p, i) => (i === drag.i ? clampPt({ x: p.x + dx, y: p.y + dy }) : p));
    } else if (drag.kind === 'edge') {                                  // slide the edge along its normal, keeping its direction
      const a = s[drag.i], c = s[(drag.i + 1) % 4], ex = c.x - a.x, ey = c.y - a.y, len = Math.hypot(ex, ey) || 1;
      const nx = -ey / len, ny = ex / len, t = dx * nx + dy * ny;
      quad = s.map((p, i) => (i === drag.i || i === (drag.i + 1) % 4 ? clampPt({ x: p.x + nx * t, y: p.y + ny * t }) : p));
    } else {
      const minX = Math.min(...s.map((p) => p.x)), maxX = Math.max(...s.map((p) => p.x));
      const minY = Math.min(...s.map((p) => p.y)), maxY = Math.max(...s.map((p) => p.y));
      const mx = Math.max(-minX, Math.min(src.width - maxX, dx)), my = Math.max(-minY, Math.min(src.height - maxY, dy));
      quad = s.map((p) => ({ x: p.x + mx, y: p.y + my }));
    }
    draw({ x: px, y: py });
  });
  const end = () => { drag = null; draw(); };
  cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end);

  const ro = new ResizeObserver(layout); ro.observe(stage);
  layout();

  return new Promise((resolve) => {
    const close = (result) => { ro.disconnect(); root.remove(); document.body.classList.remove('no-scroll'); document.removeEventListener('keydown', onKey); resolve(result); };
    const rot = (cw) => {
      const sw = src.width, sh = src.height;
      quad = quad.map((p) => (cw ? { x: sh - p.y, y: p.x } : { x: p.y, y: sw - p.x }));
      src = rotateCanvas(src, cw); layout();
    };
    const onKey = (e) => { if (e.key === 'Escape') close(null); };
    document.addEventListener('keydown', onKey);
    root.addEventListener('click', async (ev) => {
      const btn = ev.target.closest('[data-a]'), a = btn?.dataset.a;
      if (!a) return;
      if (a === 'cancel') close(null);
      else if (a === 'cw') rot(true);
      else if (a === 'ccw') rot(false);
      else if (a === 'auto') { quad = autoQuad(src); draw(); }
      else if (a === 'full') { quad = fullQuad(src.width, src.height); draw(); }
      else if (a === 'done') {
        const q = orderQuad(quad);
        if (!isReasonableQuad(quad)) { setHint("those corners don't outline a receipt — drag each one onto a corner of the paper", true); return; }
        root.querySelectorAll('button').forEach((b) => (b.disabled = true));
        setHint('Straightening…');
        await new Promise((r) => setTimeout(r, 30));                    // let the hint paint before the (synchronous) warp
        try { const canvas = extractQuad(src, q); close({ canvas, dataUrl: canvasToJpeg(canvas) }); }
        catch (e) { root.querySelectorAll('button').forEach((b) => (b.disabled = false)); setHint('could not straighten that outline: ' + e.message, true); }
      }
    });
  });
}
