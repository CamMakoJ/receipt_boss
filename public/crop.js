// Full-screen crop step shown right after a photo is taken/chosen.
// openCropper(file) -> Promise<{ canvas, dataUrl } | null>   (null = user cancelled)

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

/** Best-guess rectangle around the paper: bright region bounding box. Falls back to (almost) the full frame. */
export function autoCropRect(canvas) {
  const W = canvas.width, H = canvas.height;
  const full = { x0: Math.round(W * 0.02), y0: Math.round(H * 0.02), x1: Math.round(W * 0.98), y1: Math.round(H * 0.98) };
  try {
    const k = 160 / Math.max(W, H);
    const w = Math.max(8, Math.round(W * k)), h = Math.max(8, Math.round(H * k));
    const s = document.createElement('canvas'); s.width = w; s.height = h;
    const sctx = s.getContext('2d', { willReadFrequently: true });
    sctx.drawImage(canvas, 0, 0, w, h);
    const px = sctx.getImageData(0, 0, w, h).data;
    const lum = new Uint8Array(w * h), hist = new Array(256).fill(0);
    for (let i = 0; i < w * h; i++) { const v = (px[i * 4] * 77 + px[i * 4 + 1] * 150 + px[i * 4 + 2] * 29) >> 8; lum[i] = v; hist[v]++; }
    // Otsu threshold
    let sum = 0; for (let t = 0; t < 256; t++) sum += t * hist[t];
    let wB = 0, sB = 0, best = 0, thr = 128;
    for (let t = 0; t < 256; t++) {
      wB += hist[t]; if (!wB) continue; const wF = w * h - wB; if (!wF) break;
      sB += t * hist[t]; const mB = sB / wB, mF = (sum - sB) / wF, v = wB * wF * (mB - mF) ** 2;
      if (v > best) { best = v; thr = t; }
    }
    const bright = (x, y) => lum[y * w + x] > thr;
    // if the border is mostly bright, the paper is not the bright thing -> don't guess
    let border = 0, nb = 0;
    for (let x = 0; x < w; x++) { border += bright(x, 0) + bright(x, h - 1); nb += 2; }
    for (let y = 0; y < h; y++) { border += bright(0, y) + bright(w - 1, y); nb += 2; }
    if (border / nb > 0.6) return full;

    const rows = new Array(h).fill(0), cols = new Array(w).fill(0);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (bright(x, y)) { rows[y]++; cols[x]++; }
    const rMax = Math.max(...rows), cMax = Math.max(...cols);
    const ys = rows.map((v, i) => (v >= rMax * 0.5 ? i : -1)).filter((i) => i >= 0);
    const xs = cols.map((v, i) => (v >= cMax * 0.5 ? i : -1)).filter((i) => i >= 0);
    if (!ys.length || !xs.length) return full;
    const padX = w * 0.015, padY = h * 0.015;
    const r = {
      x0: Math.max(0, (xs[0] - padX) / w) * W, x1: Math.min(1, (xs[xs.length - 1] + 1 + padX) / w) * W,
      y0: Math.max(0, (ys[0] - padY) / h) * H, y1: Math.min(1, (ys[ys.length - 1] + 1 + padY) / h) * H,
    };
    if ((r.x1 - r.x0) * (r.y1 - r.y0) < W * H * 0.2) return full;
    return { x0: Math.round(r.x0), y0: Math.round(r.y0), x1: Math.round(r.x1), y1: Math.round(r.y1) };
  } catch { return full; }
}

const rotateCanvas = (src, cw) => {
  const c = document.createElement('canvas');
  c.width = src.height; c.height = src.width;
  const ctx = c.getContext('2d');
  if (cw) { ctx.translate(c.width, 0); ctx.rotate(Math.PI / 2); } else { ctx.translate(0, c.height); ctx.rotate(-Math.PI / 2); }
  ctx.drawImage(src, 0, 0);
  return c;
};

export async function openCropper(file) {
  let src = await fileToCanvas(file);
  let rect = autoCropRect(src);

  const root = document.createElement('div');
  root.className = 'crop';
  root.innerHTML = `
    <div class="crop-bar"><b>Crop receipt</b><span class="muted">drag the corners or edges</span></div>
    <div class="crop-stage"><canvas></canvas></div>
    <div class="crop-bar crop-actions">
      <button type="button" data-a="cancel">Cancel</button>
      <button type="button" data-a="ccw" title="Rotate left">⟲</button>
      <button type="button" data-a="cw" title="Rotate right">⟳</button>
      <button type="button" data-a="auto">Auto</button>
      <button type="button" data-a="full">Reset</button>
      <button type="button" data-a="done" class="pri">Done ✓</button>
    </div>`;
  document.body.appendChild(root);
  document.body.classList.add('no-scroll');
  const stage = root.querySelector('.crop-stage');
  const cv = root.querySelector('canvas');
  const ctx = cv.getContext('2d');

  let view = { scale: 1, ox: 0, oy: 0, base: null }, dpr = 1;
  const PAD = 18, GRAB = 30, MIN = 60;

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
  const toView = (r) => ({ x0: view.ox + r.x0 * view.scale, y0: view.oy + r.y0 * view.scale, x1: view.ox + r.x1 * view.scale, y1: view.oy + r.y1 * view.scale });

  function draw() {
    const W = cv.width / dpr, H = cv.height / dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const iw = src.width * view.scale, ih = src.height * view.scale;
    ctx.drawImage(view.base, view.ox, view.oy, iw, ih);
    const r = toView(rect);
    ctx.fillStyle = 'rgba(0,0,0,.55)';
    ctx.fillRect(view.ox, view.oy, iw, r.y0 - view.oy);
    ctx.fillRect(view.ox, r.y1, iw, view.oy + ih - r.y1);
    ctx.fillRect(view.ox, r.y0, r.x0 - view.ox, r.y1 - r.y0);
    ctx.fillRect(r.x1, r.y0, view.ox + iw - r.x1, r.y1 - r.y0);
    ctx.strokeStyle = 'rgba(255,255,255,.35)'; ctx.lineWidth = 1; ctx.beginPath();
    for (const f of [1 / 3, 2 / 3]) {
      ctx.moveTo(r.x0 + (r.x1 - r.x0) * f, r.y0); ctx.lineTo(r.x0 + (r.x1 - r.x0) * f, r.y1);
      ctx.moveTo(r.x0, r.y0 + (r.y1 - r.y0) * f); ctx.lineTo(r.x1, r.y0 + (r.y1 - r.y0) * f);
    }
    ctx.stroke();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.strokeRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
    ctx.fillStyle = '#fff'; ctx.strokeStyle = 'rgba(0,0,0,.5)'; ctx.lineWidth = 1;
    const mx = (r.x0 + r.x1) / 2, my = (r.y0 + r.y1) / 2;
    for (const [x, y] of [[r.x0, r.y0], [r.x1, r.y0], [r.x0, r.y1], [r.x1, r.y1], [mx, r.y0], [mx, r.y1], [r.x0, my], [r.x1, my]]) {
      ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
  }

  function hit(px, py) {
    const r = toView(rect);
    if (px < r.x0 - GRAB || px > r.x1 + GRAB || py < r.y0 - GRAB || py > r.y1 + GRAB) return null;
    const dL = Math.abs(px - r.x0), dR = Math.abs(px - r.x1), dT = Math.abs(py - r.y0), dB = Math.abs(py - r.y1);
    let h = '';
    if (dT < GRAB && dT <= dB) h += 'n'; else if (dB < GRAB) h += 's';
    if (dL < GRAB && dL <= dR) h += 'w'; else if (dR < GRAB) h += 'e';
    if (h) return h;
    return px > r.x0 && px < r.x1 && py > r.y0 && py < r.y1 ? 'move' : null;
  }

  let drag = null;
  cv.addEventListener('pointerdown', (ev) => {
    const b = cv.getBoundingClientRect();
    const px = ev.clientX - b.left, py = ev.clientY - b.top, h = hit(px, py);
    if (!h) return;
    cv.setPointerCapture(ev.pointerId);
    drag = { h, px, py, start: { ...rect } };
  });
  cv.addEventListener('pointermove', (ev) => {
    if (!drag) return;
    const b = cv.getBoundingClientRect();
    const dx = (ev.clientX - b.left - drag.px) / view.scale, dy = (ev.clientY - b.top - drag.py) / view.scale;
    const s = drag.start, min = MIN / view.scale, clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const r = { ...s };
    if (drag.h === 'move') {
      const w = s.x1 - s.x0, h = s.y1 - s.y0;
      r.x0 = clamp(s.x0 + dx, 0, src.width - w); r.x1 = r.x0 + w;
      r.y0 = clamp(s.y0 + dy, 0, src.height - h); r.y1 = r.y0 + h;
    } else {
      if (drag.h.includes('w')) r.x0 = clamp(s.x0 + dx, 0, s.x1 - min);
      if (drag.h.includes('e')) r.x1 = clamp(s.x1 + dx, s.x0 + min, src.width);
      if (drag.h.includes('n')) r.y0 = clamp(s.y0 + dy, 0, s.y1 - min);
      if (drag.h.includes('s')) r.y1 = clamp(s.y1 + dy, s.y0 + min, src.height);
    }
    rect = r; draw();
  });
  const end = () => { drag = null; };
  cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end);

  const ro = new ResizeObserver(layout); ro.observe(stage);
  layout();

  return new Promise((resolve) => {
    const close = (result) => { ro.disconnect(); root.remove(); document.body.classList.remove('no-scroll'); document.removeEventListener('keydown', onKey); resolve(result); };
    const crop = (r) => {
      const x = Math.round(r.x0), y = Math.round(r.y0), w = Math.max(1, Math.round(r.x1 - r.x0)), h = Math.max(1, Math.round(r.y1 - r.y0));
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      c.getContext('2d').drawImage(src, x, y, w, h, 0, 0, w, h);
      return c;
    };
    const rot = (cw) => {
      const { x0, y0, x1, y1 } = rect;
      rect = cw ? { x0: src.height - y1, x1: src.height - y0, y0: x0, y1: x1 } : { x0: y0, x1: y1, y0: src.width - x1, y1: src.width - x0 };
      src = rotateCanvas(src, cw); layout();
    };
    const onKey = (e) => { if (e.key === 'Escape') close(null); };
    document.addEventListener('keydown', onKey);
    root.addEventListener('click', (ev) => {
      const a = ev.target.closest('[data-a]')?.dataset.a;
      if (!a) return;
      if (a === 'cancel') close(null);
      else if (a === 'cw') rot(true);
      else if (a === 'ccw') rot(false);
      else if (a === 'auto') { rect = autoCropRect(src); draw(); }
      else if (a === 'full') { rect = { x0: 0, y0: 0, x1: src.width, y1: src.height }; draw(); }
      else if (a === 'done') { const canvas = crop(rect); close({ canvas, dataUrl: canvasToJpeg(canvas) }); }
    });
  });
}
