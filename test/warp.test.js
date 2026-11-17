import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orderQuad, isConvexQuad, isReasonableQuad, isAxisAligned, quadArea, outputSize, solveHomography, applyH, warpQuad, findPaperQuad, expandQuad } from '../public/warp.js';

const P = (x, y) => ({ x, y });
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

test('orderQuad: TL, TR, BR, BL regardless of input order or tilt', () => {
  const q = [P(150, 35), P(60, 215), P(50, 20), P(140, 230)];       // shuffled, slightly rotated page
  assert.deepEqual(orderQuad(q), [P(50, 20), P(150, 35), P(140, 230), P(60, 215)]);
});

test('convexity / area / axis alignment', () => {
  assert.equal(isConvexQuad([P(0, 0), P(10, 0), P(10, 10), P(0, 10)]), true);
  assert.equal(isConvexQuad([P(0, 0), P(10, 10), P(10, 0), P(0, 10)]), false);   // bow-tie (crossed corners)
  assert.equal(isConvexQuad([P(0, 0), P(10, 0), P(5, 1), P(0, 10)]), false);     // dented
  assert.equal(quadArea([P(0, 0), P(10, 0), P(10, 5), P(0, 5)]), 50);
  assert.equal(isAxisAligned([P(5, 5), P(95, 5.4), P(95, 80), P(5.3, 80)]), true);
  assert.equal(isAxisAligned([P(5, 5), P(95, 12), P(95, 80), P(5, 80)]), false);
});

test('outputSize uses the longer opposite edges and respects the cap', () => {
  assert.deepEqual(outputSize([P(0, 0), P(100, 0), P(120, 300), P(-20, 300)]), { w: 140, h: 301 });
  const big = outputSize([P(0, 0), P(6000, 0), P(6000, 3000), P(0, 3000)], 3000);
  assert.deepEqual(big, { w: 3000, h: 1500 });
});

test('homography maps the 4 corners exactly, and the centre to the diagonals\' intersection', () => {
  const quad = [P(30, 10), P(90, 25), P(80, 120), P(5, 100)];
  const rect = [P(0, 0), P(100, 0), P(100, 200), P(0, 200)];
  const H = solveHomography(rect, quad);
  rect.forEach((r, i) => { const m = applyH(H, r.x, r.y); assert.ok(near(m.x, quad[i].x, 1e-6) && near(m.y, quad[i].y, 1e-6)); });
  // a projective map sends the rectangle's centre to the intersection of the quad's diagonals
  const [a, b, c, d] = quad;
  const t = ((d.x - a.x) * (b.y - d.y) - (d.y - a.y) * (b.x - d.x)) / ((c.x - a.x) * (b.y - d.y) - (c.y - a.y) * (b.x - d.x));
  const diag = P(a.x + t * (c.x - a.x), a.y + t * (c.y - a.y));
  const mid = applyH(H, 50, 100);
  assert.ok(near(mid.x, diag.x, 1e-6) && near(mid.y, diag.y, 1e-6), `${JSON.stringify(mid)} vs ${JSON.stringify(diag)}`);
  assert.throws(() => solveHomography(rect, [P(0, 0), P(0, 0), P(0, 0), P(0, 0)]), /degenerate/);
});

function image(w, h, fn) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const [r, g, b] = fn(x, y); const o = (y * w + x) * 4; data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = 255; }
  return { data, width: w, height: h };
}

test('warpQuad: axis-aligned quad is a plain crop; keystone quad is straightened', () => {
  const src = image(100, 100, (x, y) => [x * 2, y * 2, 0]);               // R encodes x, G encodes y
  const crop = warpQuad(src, [P(20, 20), P(80, 20), P(80, 80), P(20, 80)], 60, 60);
  const at = (img, w, x, y) => [img[(y * w + x) * 4], img[(y * w + x) * 4 + 1]];
  assert.deepEqual(at(crop, 60, 0, 0).map(Math.round), [40, 40]);        // output pixel centre lands exactly on source pixel (20,20)
  assert.deepEqual(at(crop, 60, 59, 59).map(Math.round), [158, 158]);

  // Photograph of a rectangle drawn as a trapezoid (top narrower than bottom): after warping, the
  // vertical stripe that was slanted in the photo must be vertical (constant R in a column).
  const stripes = image(200, 200, (x, y) => {
    const left = 60 - y * 0.3, right = 140 + y * 0.3;                     // trapezoid sides widen downwards
    const u = (x - left) / (right - left);                                 // 0..1 across the page at this row
    return [Math.round(Math.max(0, Math.min(1, u)) * 255), 0, 0];
  });
  const quad = [P(60, 0), P(140, 0), P(200, 200), P(0, 200)];
  const out = warpQuad(stripes, quad, 100, 100);
  for (const x of [10, 50, 90]) {
    const top = out[(5 * 100 + x) * 4], bottom = out[(95 * 100 + x) * 4];
    assert.ok(Math.abs(top - bottom) <= 6, `column ${x} should be straight: top ${top} bottom ${bottom}`);
  }
  assert.ok(Math.abs(out[(50 * 100 + 50) * 4] - 127) <= 8);               // middle of the page is mid-gradient
});

test('findPaperQuad: finds the four corners of a tilted white page on a dark table', () => {
  const W = 200, H = 260;
  const poly = [P(50, 20), P(150, 35), P(140, 230), P(60, 215)];          // TL TR BR BL
  const inside = (x, y) => {
    let sign = 0;
    for (let i = 0; i < 4; i++) {
      const a = poly[i], b = poly[(i + 1) % 4];
      const s = Math.sign((b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x));
      if (!sign) sign = s; else if (s !== sign) return false;
    }
    return true;
  };
  const lum = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) lum[y * W + x] = inside(x, y) ? ((x * 7 + y * 3) % 23 === 0 ? 40 : 235) : 45; // some dark "text" specks
  const q = findPaperQuad(lum, W, H);
  assert.ok(q, 'quad found');
  q.forEach((p, i) => assert.ok(Math.hypot(p.x - poly[i].x, p.y - poly[i].y) < 4, `corner ${i}: ${JSON.stringify(p)} vs ${JSON.stringify(poly[i])}`));

  const exp = expandQuad(q, 1.02, W, H);
  assert.ok(quadArea(exp) > quadArea(q));
});

test('findPaperQuad gives up (null) when there is nothing to find', () => {
  const flat = new Uint8Array(100 * 100).fill(200);
  assert.equal(findPaperQuad(flat, 100, 100), null);                        // all one brightness
  const full = new Uint8Array(100 * 100).fill(230);                         // paper fills the frame: bright border
  for (let i = 0; i < 100 * 100; i += 37) full[i] = 40;
  assert.equal(findPaperQuad(full, 100, 100), null);
});

test('isReasonableQuad: accepts a tilted page, rejects slivers, folded and squashed outlines', () => {
  assert.equal(isReasonableQuad([P(50, 20), P(150, 35), P(140, 230), P(60, 215)]), true);       // tilted receipt
  assert.equal(isReasonableQuad([P(0, 0), P(1800, 0), P(1800, 2400), P(0, 2400)]), true);       // whole frame
  assert.equal(isReasonableQuad([P(1795, 3), P(1800, 0), P(1800, 2400), P(0, 2400)]), false);   // two corners dragged together
  assert.equal(isReasonableQuad([P(0, 0), P(100, 100), P(100, 0), P(0, 100)]), false);          // bow-tie
  assert.equal(isReasonableQuad([P(0, 0), P(300, 10), P(300, 30), P(0, 20)]), false);           // flat sliver
  assert.equal(isReasonableQuad([P(0, 0), P(300, 0), P(330, 200), P(-30, 200)]), true);         // keystone is fine
});
