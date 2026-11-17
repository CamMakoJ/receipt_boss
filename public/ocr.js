// On-device receipt OCR (Tesseract compiled to WebAssembly). Everything is served from /vendor/tesseract,
// so no image ever leaves your network and it keeps working offline once loaded.
// scanCanvas(canvas, { onProgress }) -> Promise<string>      cancelScan() aborts the one in flight.

const BASE = `${location.origin}/vendor/tesseract`; // absolute: the worker runs from a blob: URL
const IDLE_MS = 2 * 60e3;                            // free ~100 MB of wasm memory when not scanning

let workerPromise = null, idleTimer = null, onProgressCb = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (window.Tesseract) return resolve();
    const s = document.createElement('script');
    s.src = src; s.onload = resolve; s.onerror = () => reject(new Error('OCR engine is not installed on the server'));
    document.head.appendChild(s);
  });
}

function getWorker() {
  clearTimeout(idleTimer);
  workerPromise ||= (async () => {
    await loadScript(`${BASE}/tesseract.min.js`);
    const w = await window.Tesseract.createWorker('eng', 1, {
      workerPath: `${BASE}/worker.min.js`, corePath: `${BASE}/core`, langPath: `${BASE}/lang`,
      logger: (m) => onProgressCb?.(m),
    });
    await w.setParameters({ tessedit_pageseg_mode: window.Tesseract.PSM.SINGLE_COLUMN, preserve_interword_spaces: '1' });
    return w;
  })().catch((e) => { workerPromise = null; throw e; });
  return workerPromise;
}

function stopWorker() {
  const p = workerPromise; workerPromise = null; clearTimeout(idleTimer);
  p?.then((w) => w.terminate()).catch(() => {});
}
const scheduleIdle = () => { clearTimeout(idleTimer); idleTimer = setTimeout(stopWorker, IDLE_MS); };

/** Download + initialise the engine once while online so scanning works offline later. */
export async function warmOcr() {
  if (!navigator.onLine || localStorage.getItem('ocr-warm') === '1') return;
  try { await getWorker(); localStorage.setItem('ocr-warm', '1'); scheduleIdle(); } catch { /* optional feature */ }
}

let cancelled = false;
export function cancelScan() { cancelled = true; stopWorker(); }

export async function scanCanvas(canvas, { onProgress } = {}) {
  cancelled = false;
  onProgressCb = onProgress;
  try {
    const w = await getWorker();
    if (cancelled) throw Object.assign(new Error('cancelled'), { cancelled: true });
    const { data } = await w.recognize(canvas);
    return data.text || '';
  } catch (e) {
    if (cancelled) throw Object.assign(new Error('cancelled'), { cancelled: true });
    throw e;
  } finally { onProgressCb = null; scheduleIdle(); }
}
