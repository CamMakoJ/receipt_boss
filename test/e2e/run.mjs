// Browser regression suite: drives the real app in headless Chromium against a real server process.
//   npm run test:e2e
// Needs Playwright with Chromium (not an npm dependency — it is large):  npm i -g playwright && npx playwright install chromium
// Set E2E_SHOTS=/some/dir to also save light/dark, phone/desktop screenshots of the main screens.
import { spawn, execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FX = (n) => path.join(ROOT, 'test', 'fixtures', n);
const SHOTS = process.env.E2E_SHOTS;

let chromium;
try { ({ chromium } = await import('playwright')); }
catch {
  try { ({ chromium } = createRequire(execSync('npm root -g').toString().trim() + '/')('playwright')); }
  catch { console.log('Playwright is not installed — skipping the browser suite.\n  npm i -g playwright && npx playwright install chromium'); process.exit(0); }
}

// ------------------------------------------------------------ server + stand-in AI
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-e2e-'));
const port = await freePort(), llmPort = await freePort();
const BASE = `http://127.0.0.1:${port}`;
const llm = http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'fake' }] }));
    const filters = { any: ['fridge', 'refrigerator'], category: 'Appliance', vendor: '', from: '', to: '', min: 1000, max: null, warranty: 'any' };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(filters) } }] }));
  });
}).listen(llmPort, '127.0.0.1');
const server = spawn('node', ['--no-warnings', 'server/index.js'], { cwd: ROOT, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir }, stdio: 'ignore' });
for (let i = 0; i < 60; i++) { try { if ((await fetch(`${BASE}/api/auth/status`)).ok) break; } catch { /* not up yet */ } await new Promise((r) => setTimeout(r, 150)); }

// ------------------------------------------------------------ tiny harness
const results = [];
async function step(name, fn) {
  const t = Date.now();
  try { await fn(); results.push([true, name]); console.log(`  ✓ ${name}  (${((Date.now() - t) / 1000).toFixed(1)}s)`); }
  catch (e) { results.push([false, name, e]); console.log(`  ✗ ${name}\n      ${String(e.message).split('\n').slice(0, 12).join('\n      ')}`); }
}
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
const problems = [];
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
// ("Estimating resolution" is the OCR engine's own progress chatter; a 409 is the expected duplicate warning)
page.on('console', (m) => { if (m.type() === 'error' && !/importScripts|net::ERR|Estimating resolution|status of 409/.test(m.text())) problems.push(`console: ${m.text()}`); });
await page.addInitScript(() => document.addEventListener('securitypolicyviolation', (e) => { (window.__csp = window.__csp || []).push(`${e.violatedDirective} ${e.blockedURI}`); }));
const api = (method, url, body) => page.evaluate(async ([m, u, b]) => {
  const r = await fetch('/api' + u, { method: m, headers: { 'x-rb': '1', 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return r.status === 204 ? null : r.json();
}, [method, url, body]);
const go = async (hash) => { await page.goto(`${BASE}/#${hash}`); await page.waitForLoadState('domcontentloaded'); };
const dialogOk = async () => { await page.waitForSelector('dialog.modal[open]'); await page.click('dialog.modal button[value=ok]'); await page.waitForSelector('dialog.modal', { state: 'detached' }); };
const shot = async (name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true }); } };
const money = (v) => page.textContent(v);
const waitScan = async () => { await page.waitForSelector('.scan-overlay'); await page.waitForSelector('.scan-overlay', { state: 'detached', timeout: 120000 }); };
let deck;

console.log(`Receipt Boss browser suite  (${BASE})`);

await step('first run: create the admin account, land on an empty Projects page', async () => {
  await page.goto(BASE);
  await page.waitForSelector('text=Welcome to Receipt Boss');
  await page.fill('#a-user', 'cam'); await page.fill('#a-pass', 'correct-horse-battery'); await page.click('#auth button');
  await page.waitForSelector('text=No projects yet');
  assert.equal(await page.locator('#nav a').count(), 4);
  await shot('light-phone-projects-empty');
});

await step('dark mode: toggle, persists across reload, Auto follows the system, tokens meet contrast', async () => {
  await page.click('#themebtn');
  assert.equal(await page.getAttribute('html', 'data-theme'), 'dark');
  const bgDark = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await page.reload(); await page.waitForSelector('#nav a');
  assert.equal(await page.getAttribute('html', 'data-theme'), 'dark');                  // set before first paint, no flash
  await page.click('#nav a:has-text("Settings")'); await page.click('[data-set-theme="light"]');
  assert.equal(await page.getAttribute('html', 'data-theme'), 'light');
  assert.notEqual(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), bgDark);
  await page.click('[data-set-theme="auto"]');
  assert.equal(await page.getAttribute('html', 'data-theme'), null);
  await page.emulateMedia({ colorScheme: 'dark' });                                      // "Auto" follows the OS
  assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), bgDark);
  await page.emulateMedia({ colorScheme: 'light' });

  const lum = (hex) => { const [r, g, b] = hex.match(/#(..)(..)(..)/).slice(1).map((h) => { const c = parseInt(h, 16) / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const PAIRS = [['--text', '--bg'], ['--text', '--surface'], ['--muted', '--surface'], ['--muted', '--bg'], ['--primary-text', '--surface'], ['--primary-text', '--primary-soft'], ['--on-primary', '--primary'],
    ['--ok-fg', '--ok-bg'], ['--warn-fg', '--warn-bg'], ['--bad-fg', '--bad-bg'], ['--danger', '--surface']];
  for (const theme of ['light', 'dark']) {
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
    const tok = await page.evaluate((pairs) => Object.fromEntries([...new Set(pairs.flat())].map((k) => [k, getComputedStyle(document.documentElement).getPropertyValue(k).trim()])), PAIRS);
    for (const [fg, bg] of PAIRS) assert.ok(ratio(tok[fg], tok[bg]) >= 4.5, `${theme}: ${fg} on ${bg} is ${ratio(tok[fg], tok[bg]).toFixed(2)}:1 (needs 4.5)`);
  }
  await page.evaluate(() => document.documentElement.removeAttribute('data-theme'));
});

await step('new project via the dialog; manual receipt: province taxes, category -> description', async () => {
  await go('/'); await page.waitForSelector('#newbtn');
  await page.click('#newbtn'); await page.fill('#np-name', 'Deck build'); await page.selectOption('#np-prov', 'ON'); await dialogOk();
  await page.waitForSelector('text=Add receipt');
  deck = (await api('GET', '/projects'))[0];
  await page.click('a:has-text("Add receipt")'); await page.waitForSelector('#f-vendor');
  await page.fill('#f-vendor', 'Hardware Hank'); await page.fill('#f-cat', 'Materials');
  assert.equal(await page.inputValue('#f-desc'), 'Materials');
  await page.fill('#f-sub', '100');
  assert.equal(await page.inputValue('#f-gst'), '13.00'); assert.equal(await page.inputValue('#f-pst'), '');       // Ontario HST
  assert.equal(await money('#tot'), '$113.00');
  await page.fill('#f-desc', 'Deck screws');                                             // custom description sticks
  await page.fill('#f-cat', 'Tools & equipment'); assert.equal(await page.inputValue('#f-desc'), 'Deck screws');
  await page.click('#save'); await page.waitForSelector('text=Deck screws');
  assert.match(await page.textContent('.stat.big'), /\$113\.00/);
});

await step('photo -> crop screen -> on-device OCR fills the form and highlights what it read', async () => {
  await page.click('a:has-text("Add receipt")'); await page.waitForSelector('#cam', { state: 'attached' });
  await page.setInputFiles('#cam', FX('receipt-flat.jpg'));
  await page.waitForSelector('.crop canvas'); await page.waitForTimeout(300); await page.click('[data-a=done]'); await waitScan();
  assert.equal(await page.inputValue('#f-sub'), '84.75'); assert.equal(await page.inputValue('#f-gst'), '4.24'); assert.equal(await page.inputValue('#f-pst'), '5.93');
  assert.match(await page.inputValue('#f-vendor'), /home depot/i); assert.equal(await page.inputValue('#f-date'), '2026-03-14');
  assert.ok(await page.locator('input.scanned').count() >= 4);
  assert.match(await page.textContent('#scanmsg'), /Filled from the photo/);
  await shot('light-phone-receipt-form');
  await page.fill('#f-desc', 'Lumber'); await page.click('#save'); await page.waitForSelector('text=Lumber');
});

await step('several photos per receipt: add pages, make another the cover, remove one', async () => {
  await page.click('.item:has-text("Lumber")'); await page.waitForSelector('#strip .tile');
  await page.uncheck('#ocrtoggle');
  await page.setInputFiles('#pick', [FX('r1.jpg'), FX('r2.jpg')]);
  for (const n of [2, 3]) { await page.waitForSelector('.crop canvas'); await page.click('[data-a=done]'); await page.waitForFunction((k) => document.querySelectorAll('#strip .tile').length === k, n); }
  await page.click('#save'); await page.waitForSelector('text=Lumber');
  const before = (await api('GET', '/receipts')).find((x) => x.description === 'Lumber');
  assert.equal(before.photos.length, 3);
  assert.equal(await page.textContent('.item:has-text("Lumber") .count'), '3');

  await page.click('.item:has-text("Lumber")'); await page.waitForSelector('#strip [data-cover]');
  await page.click('#strip [data-cover] >> nth=0');                                      // make the 2nd photo the cover
  await page.click('#strip .x >> nth=2');                                                // drop the last one
  assert.equal(await page.locator('#strip .tile').count(), 2);
  await page.click('#save'); await page.waitForSelector('text=Lumber');
  const after = (await api('GET', '/receipts')).find((x) => x.description === 'Lumber');
  assert.equal(after.photos.length, 2);
  assert.equal(after.photos[0], before.photos[1]);                                       // the chosen photo is the cover now
  assert.equal(await page.textContent('.item:has-text("Lumber") .count'), '2');
});

await step('invoicing: select receipts, mark invoiced with a number, summary updates', async () => {
  await go(`/p/${deck.id}`); await page.waitForSelector('#selbtn');
  await page.click('#selbtn'); await page.click('.item:has-text("Lumber")'); await page.click('.item:has-text("Deck screws")');
  assert.match(await page.textContent('.bulkbar'), /2 receipts selected/);
  await page.click('[data-bulk=invoiced]'); await page.fill('#dlg-in', 'INV-77'); await dialogOk();
  await page.waitForSelector('.pill:has-text("invoiced INV-77")');
  await page.click('.tabs a:has-text("Export")');
  const csv = await page.evaluate(async (id) => (await fetch(`/api/projects/${id}/report.csv?billing=invoiced&only=billable`)).text(), deck.id);
  assert.match(csv, /Home Depot/); assert.match(csv, /INV-77/);
  await shot('light-phone-project-export');
});

await step('quick capture (auto-crop + perspective + OCR) -> Inbox -> "File receipt" walks through the drafts', async () => {
  await go('/capture'); await page.waitForSelector('#qc-pick', { state: 'attached' });
  await page.check('#qc-ocr');
  await page.setInputFiles('#qc-pick', [FX('receipt-skewed.jpg'), FX('receipt-flat.jpg')]);
  await page.waitForFunction(() => document.querySelectorAll('#qc-list .pill').length === 2 && [...document.querySelectorAll('#qc-list .pill')].every((p) => /in Inbox/.test(p.textContent)), null, { timeout: 120000 });
  assert.equal((await api('GET', '/inbox')).length, 2);
  assert.equal((await api('GET', `/projects/${deck.id}`)).all.count, 2);                  // drafts are not counted yet
  await shot('light-phone-capture');
  await page.click('#qc-inbox'); await page.click('text=Review them one by one'); await page.waitForSelector('text=Review capture');
  for (let n = 0; n < 2; n++) {                                                           // two drafts; wait for each hand-off before filing the next
    const from = await page.evaluate(() => location.hash);
    await page.click('#save');
    try { await page.waitForSelector('dialog.modal[open]', { timeout: 4000 }); await dialogOk(); } catch { /* no duplicate warning this time */ }   // identical receipt -> "file anyway"
    await page.waitForFunction((h) => location.hash !== h, from, { timeout: 15000 });
  }
  assert.equal((await api('GET', '/inbox')).length, 0);
  assert.equal((await api('GET', `/projects/${deck.id}`)).all.count, 4);                  // both drafts are real receipts now
});

await step('household: add an item with a warranty, filter it, and "Ask" turns a sentence into chips (local AI)', async () => {
  await go('/household'); await page.waitForSelector('a:has-text("Add item")');
  await page.click('a:has-text("Add item")'); await page.waitForSelector('#i-name');
  await page.fill('#i-name', 'LG fridge'); await page.fill('#i-date', '2026-01-10'); await page.fill('#i-price', '1799'); await page.fill('#i-vendor', 'Home Depot'); await page.fill('#i-cat', 'Appliance'); await page.fill('#i-wnum', '2');
  assert.match(await page.textContent('#wends'), /ends 2028-01-10/);
  await page.click('#save'); await page.waitForSelector('text=LG fridge');
  for (const [n, c, v, d, p, w] of [['Samsung TV', 'Electronics', 'Best Buy', '2025-06-30', 129999, 24], ['Toaster', 'Appliance', 'Costco', '2023-01-10', 3999, null]]) await api('POST', '/items', { name: n, category: c, vendor: v, purchase_date: d, price: p, warranty_months: w });
  await page.reload(); await page.waitForSelector('text=Samsung TV');
  assert.equal(await page.textContent('#count'), '3 items');
  await page.fill('#q', 'costco'); await page.waitForFunction(() => document.querySelector('#count').textContent === '1 of 3 items');
  await page.fill('#q', ''); await page.click('#ftoggle'); await page.selectOption('#f-warranty', 'unknown');
  await page.waitForFunction(() => document.querySelector('#count').textContent === '1 of 3 items');
  await page.selectOption('#f-warranty', 'any');
  await api('PUT', '/ai', { enabled: true, base_url: `http://127.0.0.1:${llmPort}/v1`, model: 'fake', vision: false, auto_check: false, timeout_s: 20 });
  await page.reload(); await page.waitForSelector('#ask');
  await page.fill('#q', 'the fridge from Home Depot over $1000'); await page.click('#ask');
  await page.waitForSelector('.chip');
  assert.match(await page.textContent('#chips'), /Matching: fridge, refrigerator/); assert.match(await page.textContent('#chips'), /Category: Appliance/);
  assert.equal(await page.textContent('#count'), '1 of 3 items');
  await shot('light-phone-household');
});

await step('offline: a receipt made without a connection is queued, then synced', async () => {
  await go(`/p/${deck.id}`); await page.waitForSelector('text=Add receipt');
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.click('a:has-text("Add receipt")'); await page.waitForSelector('#f-vendor');
  await ctx.setOffline(true); await page.waitForSelector('#net:not([hidden])');
  await page.fill('#f-vendor', 'Offline Shop'); await page.fill('#f-desc', 'Offline purchase'); await page.fill('#f-sub', '12.34'); await page.click('#save');
  await page.waitForSelector('#sync:not([hidden])');
  await ctx.setOffline(false);
  await page.waitForSelector('#sync', { state: 'hidden', timeout: 20000 });
  await page.waitForSelector('text=Offline purchase');
});

await step('backup: run now -> verified, health says healthy', async () => {
  await go('/settings/backup'); await page.waitForSelector('#bkrun');
  await page.click('#bkrun'); await page.waitForSelector('.pill:has-text("verified")', { timeout: 30000 });
  assert.match(await page.textContent('#sec-backup'), /Last attempt/);
  const h = await api('GET', '/backup/health');
  assert.ok(['ok', 'warning'].includes(h.state));
  await shot('light-phone-settings-backup');
});

await step('security: hostile text is shown as text, never run', async () => {
  const evil = '<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>';
  const p = await api('POST', '/projects', { name: evil, client: evil });
  await api('POST', `/projects/${p.id}/receipts`, { date: '2026-02-02', vendor: evil, category: evil, description: evil, subtotal: 999, notes: evil });
  await api('POST', '/items', { name: evil, vendor: evil, category: evil, serial: evil, notes: evil, purchase_date: '2025-05-05', price: 5 });
  for (const hash of ['/', `/p/${p.id}`, `/p/${p.id}/export`, `/p/${p.id}/settings`, '/search', '/household', '/settings', '/inbox']) {
    await go(hash); await page.waitForTimeout(250);
    assert.equal(await page.evaluate(() => window.__xss), undefined, `script ran on ${hash}`);
  }
  await go('/'); await page.waitForSelector('.item:has-text("<img src=x")');
  assert.match(await page.textContent('#app'), /<img src=x onerror/);                    // visible as literal text
  await api('DELETE', `/projects/${p.id}`);
});

await step('accessibility basics: every control has a name and every field a label (all main screens)', async () => {
  const audit = () => page.evaluate(() => {
    const bad = [];
    for (const el of document.querySelectorAll('button, a[href], input:not([type=hidden]):not([type=file]), select, textarea')) {
      if (el.closest('[hidden]') || el.hidden) continue;
      const name = (el.textContent || '').trim() || el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || (el.labels && el.labels.length) || el.getAttribute('value');
      if (!name) bad.push(`${el.tagName.toLowerCase()}#${el.id || ''}.${el.className}`);
    }
    return bad;
  });
  for (const hash of ['/', `/p/${deck.id}`, `/p/${deck.id}/new`, `/r/${(await api('GET', '/receipts'))[0].id}`, '/household', '/household/new', '/capture', '/search', '/settings']) {
    await go(hash); await page.waitForTimeout(350);
    const bad = await audit(); assert.equal(bad.length, 0, `unlabelled controls on ${hash}: ${JSON.stringify(bad)}`);
  }
});

await step('desktop layout + dark theme screenshots; no horizontal scrolling on a phone', async () => {
  await go('/'); await page.waitForSelector('.item');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'phone: horizontal scroll');
  await page.setViewportSize({ width: 1280, height: 860 });
  await go(`/p/${deck.id}`); await page.waitForSelector('.stats');
  assert.ok(await page.evaluate(() => document.querySelector('#nav').getBoundingClientRect().top < 100), 'tab bar moves to the top on desktop');
  await shot('light-desktop-project');
  await page.click('#themebtn'); await shot('dark-desktop-project');
  await go('/household'); await shot('dark-desktop-household');
  await page.setViewportSize({ width: 390, height: 844 });
  await go('/'); await shot('dark-phone-projects');
  await go(`/p/${deck.id}`); await shot('dark-phone-project');
  await go(`/r/${(await api('GET', '/receipts'))[0].id}`); await shot('dark-phone-receipt');
  await go('/settings'); await shot('dark-phone-settings');
});

await step('no console errors and no Content-Security-Policy violations during the whole run', async () => {
  assert.deepEqual(await page.evaluate(() => window.__csp || []), []);
  assert.deepEqual(problems, []);
});

await browser.close(); llm.close(); server.kill('SIGTERM');
await new Promise((r) => setTimeout(r, 400));
fs.rmSync(dataDir, { recursive: true, force: true });
const failed = results.filter((r) => !r[0]);
console.log(`\n${results.length - failed.length}/${results.length} steps passed`);
process.exit(failed.length ? 1 : 0);
