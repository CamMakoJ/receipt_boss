// Passphrase encryption for backup files: AES-256-GCM, key from scrypt(passphrase, random salt).
// Streams (a multi-GB backup never has to fit in memory). File layout:
//   "RBENC1\0\0" (8) | salt (16) | iv (12) | ciphertext ... | GCM tag (16)
// The header is authenticated too (as AAD), and the tag is checked at the end, so a wrong passphrase, a flipped bit
// or a truncated file is always detected -- and the half-written output is deleted.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { Writable } from 'node:stream';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);
const MAGIC = Buffer.from('RBENC1\0\0');
const SALT = 16, IV = 12, TAG = 16, HEADER = MAGIC.length + SALT + IV;
const KDF = { N: 2 ** 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };
export const ENC_EXT = '.enc';

const deriveKey = (passphrase, salt) => scrypt(String(passphrase), salt, 32, KDF);

export async function encryptFile(src, dest, passphrase) {
  if (!passphrase) throw new Error('a passphrase is required');
  const salt = crypto.randomBytes(SALT), iv = crypto.randomBytes(IV), header = Buffer.concat([MAGIC, salt, iv]);
  const cipher = crypto.createCipheriv('aes-256-gcm', await deriveKey(passphrase, salt), iv);
  cipher.setAAD(header);
  try {
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(dest), input = fs.createReadStream(src);
      for (const s of [out, input, cipher]) s.on('error', reject);
      out.write(header);
      cipher.on('end', () => { out.write(cipher.getAuthTag()); out.end(resolve); });   // tag goes last, after all ciphertext
      input.pipe(cipher).pipe(out, { end: false });
    });
  } catch (e) { fs.rmSync(dest, { force: true }); throw e; }
}

export const looksEncrypted = (file) => {
  try {
    const fd = fs.openSync(file, 'r'), buf = Buffer.alloc(MAGIC.length);
    fs.readSync(fd, buf, 0, MAGIC.length, 0); fs.closeSync(fd);
    return buf.equals(MAGIC);
  } catch { return false; }
};

/** Decrypt to `dest` (or just verify when dest is null). Throws a friendly error on wrong passphrase / damage. */
export async function decryptFile(src, dest, passphrase) {
  const size = fs.statSync(src).size;
  if (size < HEADER + TAG) throw new Error('that file is too small to be an encrypted backup');
  const fd = fs.openSync(src, 'r'), head = Buffer.alloc(HEADER), tag = Buffer.alloc(TAG);
  fs.readSync(fd, head, 0, HEADER, 0); fs.readSync(fd, tag, 0, TAG, size - TAG); fs.closeSync(fd);
  if (!head.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('not an encrypted Receipt Boss backup');
  const salt = head.subarray(MAGIC.length, MAGIC.length + SALT), iv = head.subarray(MAGIC.length + SALT);
  const decipher = crypto.createDecipheriv('aes-256-gcm', await deriveKey(passphrase, salt), iv);
  decipher.setAAD(head); decipher.setAuthTag(tag);
  const bad = () => new Error('wrong passphrase, or the backup file is damaged');
  try {
    await new Promise((resolve, reject) => {
      const sink = dest ? fs.createWriteStream(dest) : new Writable({ write(_c, _e, cb) { cb(); } });
      const done = () => resolve();
      sink.on('error', reject); decipher.on('error', () => reject(bad()));
      sink.on('finish', done);
      if (size === HEADER + TAG) { decipher.pipe(sink); decipher.end(); return; }          // empty payload
      const input = fs.createReadStream(src, { start: HEADER, end: size - TAG - 1 });
      input.on('error', reject);
      input.pipe(decipher).pipe(sink);
    });
  } catch (e) { if (dest) fs.rmSync(dest, { force: true }); throw e; }
}
