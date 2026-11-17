import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-test-'));
process.env.DATA_DIR = DATA_DIR;
const { createApp } = await import('../server/index.js');

let server, base;
export async function start() {
  server = createApp().listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
}
export const stop = () => server.close();

export const img = (n = 1) => 'data:image/jpeg;base64,' + fs.readFileSync(new URL(`./fixtures/r${n}.jpg`, import.meta.url)).toString('base64');

/** A tiny HTTP client with its own cookie jar (one per simulated user/device). */
export function client() {
  let cookie = '';
  const call = async (method, url, body, headers = {}) => {
    const r = await fetch(base + url, {
      method,
      headers: { 'content-type': 'application/json', 'x-rb': '1', ...(cookie ? { cookie } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const sc of r.headers.getSetCookie?.() ?? []) {
      const [pair] = sc.split(';');
      cookie = pair.endsWith('=') ? '' : pair;
    }
    const ct = r.headers.get('content-type') || '';
    return { status: r.status, headers: r.headers, body: ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
  };
  return {
    get: (u, h) => call('GET', u, undefined, h), post: (u, b, h) => call('POST', u, b ?? {}, h), patch: (u, b) => call('PATCH', u, b),
    put: (u, b) => call('PUT', u, b), del: (u) => call('DELETE', u),
    raw: call,
  };
}

export async function adminClient(name = 'admin', pw = 'correct-horse-battery') {
  const c = client();
  const s = await c.get('/api/auth/status');
  if (s.body.needsSetup) await c.post('/api/auth/setup', { username: name, password: pw });
  else await c.post('/api/auth/login', { username: name, password: pw });
  return c;
}
