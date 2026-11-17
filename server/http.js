import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { IMAGE_DIR } from './db.js';

export const err = (status, message) => Object.assign(new Error(message), { status });
export const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
export const str = (v, max = 500) => String(v ?? '').trim().slice(0, max);

export const cents = (v, name) => {
  const n = Number(v ?? 0);
  if (!Number.isInteger(n) || n < 0 || n > 1e10) throw err(400, `${name} must be a non-negative integer (cents)`);
  return n;
};
export const dateStr = (v) => {
  const s = str(v, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) throw err(400, 'date must be YYYY-MM-DD');
  return s;
};

/** Accepts a data: URL or bare base64 JPEG/PNG and returns a Buffer. */
export function decodeImage(b64) {
  const buf = Buffer.from(String(b64).replace(/^data:[^,]*,/, ''), 'base64');
  const jpeg = buf[0] === 0xff && buf[1] === 0xd8;
  const png = buf.subarray(0, 4).toString('hex') === '89504e47';
  if (!jpeg && !png) throw err(400, 'image must be JPEG or PNG');
  return buf;
}
export function saveImage(buf) {
  const name = crypto.randomUUID() + '.jpg';
  fs.writeFileSync(path.join(IMAGE_DIR, name), buf);
  return name;
}
export const rmImage = (name) => { if (name) fs.rmSync(path.join(IMAGE_DIR, name), { force: true }); };
export const imageFile = (name) => {
  const f = name && path.join(IMAGE_DIR, name);
  return f && fs.existsSync(f) ? f : null;
};
