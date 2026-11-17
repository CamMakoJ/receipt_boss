// Copies the Tesseract OCR engine + English model from node_modules into public/vendor/tesseract so the
// app serves everything itself: no CDN, receipts never leave your network, and OCR works offline.
// Runs automatically after `npm install`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const nm = (...p) => path.join(root, 'node_modules', ...p);
const out = path.join(root, 'public', 'vendor', 'tesseract');

const files = [
  [nm('tesseract.js', 'dist', 'tesseract.min.js'), 'tesseract.min.js'],
  [nm('tesseract.js', 'dist', 'worker.min.js'), 'worker.min.js'],
  // LSTM-only cores (the browser fetches just the one its CPU supports; ~3.9 MB each)
  ...['tesseract-core-lstm', 'tesseract-core-simd-lstm', 'tesseract-core-relaxedsimd-lstm']
    .map((n) => [nm('tesseract.js-core', `${n}.wasm.js`), `core/${n}.wasm.js`]),
  [nm('@tesseract.js-data', 'eng', '4.0.0_best_int', 'eng.traineddata.gz'), 'lang/eng.traineddata.gz'],
];

try {
  for (const [src, rel] of files) {
    fs.mkdirSync(path.dirname(path.join(out, rel)), { recursive: true });
    fs.copyFileSync(src, path.join(out, rel));
  }
  console.log(`OCR assets installed in ${path.relative(root, out)}`);
} catch (e) {
  // never break `npm install`; the app just falls back to crop-only without OCR
  console.warn(`OCR assets not installed (${e.message}). Receipt reading will be unavailable.`);
}
