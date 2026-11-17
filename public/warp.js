// Perspective-correction maths, deliberately DOM-free so it can be unit-tested in node.
// Quads are arrays of 4 points {x, y}; "ordered" means [top-left, top-right, bottom-right, bottom-left].

export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/** Order 4 arbitrary points as TL, TR, BR, BL (works for tilts up to ~45 degrees). */
export function orderQuad(pts) {
  const by = (f, pick) => pts.reduce((best, p) => (pick(f(p), f(best)) ? p : best));
  return [
    by((p) => p.x + p.y, (a, b) => a < b),   // TL: smallest x+y
    by((p) => p.x - p.y, (a, b) => a > b),   // TR: largest x-y
    by((p) => p.x + p.y, (a, b) => a > b),   // BR: largest x+y
    by((p) => p.x - p.y, (a, b) => a < b),   // BL: smallest x-y
  ];
}

export function quadArea(q) {
  let a = 0;
  for (let i = 0; i < 4; i++) { const p = q[i], n = q[(i + 1) % 4]; a += p.x * n.y - n.x * p.y; }
  return Math.abs(a) / 2;
}

/** Convex and not self-intersecting (all turns the same direction). */
export function isConvexQuad(q) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4], c = q[(i + 2) % 4];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) < 1e-6) return false;
    if (!sign) sign = Math.sign(cross); else if (Math.sign(cross) !== sign) return false;
  }
  return true;
}

/**
 * A shape worth flattening: convex, no tiny edges, and every corner between 35 and 145 degrees.
 * Rejects dragging two corners on top of each other, slivers and folded outlines.
 */
export function isReasonableQuad(q, minEdge = 40) {
  if (!isConvexQuad(q)) return false;
  for (let i = 0; i < 4; i++) {
    const a = q[(i + 3) % 4], b = q[i], c = q[(i + 1) % 4];
    if (dist(a, b) < minEdge) return false;
    const v1 = { x: a.x - b.x, y: a.y - b.y }, v2 = { x: c.x - b.x, y: c.y - b.y };
    const ang = Math.acos((v1.x * v2.x + v1.y * v2.y) / (Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y))) * (180 / Math.PI);
    if (ang < 35 || ang > 145) return false;
  }
  return true;
}

/** True when the quad is (nearly) an axis-aligned rectangle, so a plain crop is lossless and exact. */
export function isAxisAligned(q, tol = 1.5) {
  const [tl, tr, br, bl] = q;
  return Math.abs(tl.y - tr.y) < tol && Math.abs(bl.y - br.y) < tol && Math.abs(tl.x - bl.x) < tol && Math.abs(tr.x - br.x) < tol;
}

/** Output rectangle size: the longer of each pair of opposite edges (keeps all the source resolution). */
export function outputSize(q, maxDim = 3000) {
  const [tl, tr, br, bl] = q;
  let w = Math.max(dist(tl, tr), dist(bl, br)), h = Math.max(dist(tl, bl), dist(tr, br));
  const k = Math.min(1, maxDim / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

/** Solve the 3x3 projective transform H (h33 = 1) that maps each `from[i]` to `to[i]`. Returns 9 numbers, row-major. */
export function solveHomography(from, to) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = from[i], { x: u, y: v } = to[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  // Gaussian elimination with partial pivoting
  const n = 8;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    if (Math.abs(A[p][c]) < 1e-12) throw new Error('degenerate quadrilateral');
    [A[c], A[p]] = [A[p], A[c]]; [b[c], b[p]] = [b[p], b[c]];
    for (let r = c + 1; r < n; r++) {
      const f = A[r][c] / A[c][c];
      for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  const h = new Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let k = r + 1; k < n; k++) s -= A[r][k] * h[k];
    h[r] = s / A[r][r];
  }
  return [...h, 1];
}

export const applyH = (H, x, y) => {
  const d = H[6] * x + H[7] * y + H[8];
  return { x: (H[0] * x + H[1] * y + H[2]) / d, y: (H[3] * x + H[4] * y + H[5]) / d };
};

/**
 * Warp the quad region of an RGBA image to an upright w x h rectangle (inverse mapping, bilinear sampling).
 * `src` = { data: Uint8ClampedArray, width, height }. Pixels outside the source come out white.
 */
export function warpQuad(src, quad, w, h) {
  const H = solveHomography([{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }], quad); // output -> source
  const out = new Uint8ClampedArray(w * h * 4);
  const { data: s, width: sw, height: sh } = src;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const px = x + 0.5, py = y + 0.5;
      const d = H[6] * px + H[7] * py + 1;
      const fx = (H[0] * px + H[1] * py + H[2]) / d - 0.5, fy = (H[3] * px + H[4] * py + H[5]) / d - 0.5;
      const o = (y * w + x) * 4;
      if (fx < -1 || fy < -1 || fx > sw || fy > sh) { out[o] = out[o + 1] = out[o + 2] = 255; out[o + 3] = 255; continue; }
      const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
      const xa = Math.min(sw - 1, Math.max(0, x0)), xb = Math.min(sw - 1, Math.max(0, x0 + 1));
      const ya = Math.min(sh - 1, Math.max(0, y0)), yb = Math.min(sh - 1, Math.max(0, y0 + 1));
      const i00 = (ya * sw + xa) * 4, i10 = (ya * sw + xb) * 4, i01 = (yb * sw + xa) * 4, i11 = (yb * sw + xb) * 4;
      for (let c = 0; c < 3; c++) {
        out[o + c] = (s[i00 + c] * (1 - tx) + s[i10 + c] * tx) * (1 - ty) + (s[i01 + c] * (1 - tx) + s[i11 + c] * tx) * ty;
      }
      out[o + 3] = 255;
    }
  }
  return out;
}

/**
 * Find the paper in a small luminance grid: Otsu threshold -> largest bright blob -> its four extreme corners.
 * Returns an ordered quad in grid coordinates, or null when it can't tell (paper filling the frame, no contrast...).
 */
export function findPaperQuad(lum, w, h) {
  const hist = new Array(256).fill(0);
  for (let i = 0; i < w * h; i++) hist[lum[i]]++;
  let sum = 0; for (let t = 0; t < 256; t++) sum += t * hist[t];
  let wB = 0, sB = 0, best = 0, thr = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]; if (!wB) continue;
    const wF = w * h - wB; if (!wF) break;
    sB += t * hist[t];
    const mB = sB / wB, mF = (sum - sB) / wF, v = wB * wF * (mB - mF) ** 2;
    if (v > best) { best = v; thr = t; }
  }
  const bright = (i) => lum[i] > thr;

  // bright border => the bright thing is the background (or the paper fills the frame): don't guess
  let border = 0, nb = 0;
  for (let x = 0; x < w; x++) { border += bright(x) + bright((h - 1) * w + x); nb += 2; }
  for (let y = 0; y < h; y++) { border += bright(y * w) + bright(y * w + w - 1); nb += 2; }
  if (border / nb > 0.5) return null;

  // largest 4-connected bright component (iterative flood fill)
  const label = new Int32Array(w * h);
  let bestLabel = 0, bestSize = 0, next = 0;
  const stack = new Int32Array(w * h);
  for (let start = 0; start < w * h; start++) {
    if (label[start] || !bright(start)) continue;
    next++; let size = 0, sp = 0; stack[sp++] = start; label[start] = next;
    while (sp) {
      const i = stack[--sp]; size++;
      const x = i % w, y = (i / w) | 0;
      if (x > 0 && !label[i - 1] && bright(i - 1)) { label[i - 1] = next; stack[sp++] = i - 1; }
      if (x < w - 1 && !label[i + 1] && bright(i + 1)) { label[i + 1] = next; stack[sp++] = i + 1; }
      if (y > 0 && !label[i - w] && bright(i - w)) { label[i - w] = next; stack[sp++] = i - w; }
      if (y < h - 1 && !label[i + w] && bright(i + w)) { label[i + w] = next; stack[sp++] = i + w; }
    }
    if (size > bestSize) { bestSize = size; bestLabel = next; }
  }
  if (bestSize < w * h * 0.12) return null;

  // extreme points of the blob = its corners (for a tilted rectangle: min/max of x+y and x-y)
  const ext = { tl: null, tr: null, br: null, bl: null }, score = { tl: Infinity, tr: -Infinity, br: -Infinity, bl: Infinity };
  for (let i = 0; i < w * h; i++) {
    if (label[i] !== bestLabel) continue;
    const x = i % w, y = (i / w) | 0, s = x + y, d = x - y;
    if (s < score.tl) { score.tl = s; ext.tl = { x, y }; }
    if (d > score.tr) { score.tr = d; ext.tr = { x, y }; }
    if (s > score.br) { score.br = s; ext.br = { x, y }; }
    if (d < score.bl) { score.bl = d; ext.bl = { x, y }; }
  }
  const q = [ext.tl, ext.tr, ext.br, ext.bl].map((p) => ({ x: p.x + 0.5, y: p.y + 0.5 }));
  if (!isConvexQuad(q) || quadArea(q) < w * h * 0.12) return null;
  return q;
}

/** Push each corner slightly away from the centre so text right at the paper edge isn't clipped. */
export function expandQuad(q, factor, maxX, maxY) {
  const cx = q.reduce((a, p) => a + p.x, 0) / 4, cy = q.reduce((a, p) => a + p.y, 0) / 4;
  return q.map((p) => ({ x: Math.min(maxX, Math.max(0, cx + (p.x - cx) * factor)), y: Math.min(maxY, Math.max(0, cy + (p.y - cy) * factor)) }));
}
