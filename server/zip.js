// Small streaming zip helpers on yazl (write) and yauzl (read). Neither expands globs, follows symlinks, or trusts entry names:
// yauzl rejects "../" and absolute names, and every entry we read is checked against its CRC-32 and declared size.
import fs from 'node:fs';
import zlib from 'node:zlib';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';
import yazl from 'yazl';

/**
 * entries: [{ name, file } | { name, buffer }], optional compress:false for already-compressed data (JPEGs).
 * Returns a Readable of the zip bytes; nothing is loaded into memory except `buffer` entries.
 */
export function buildZip(entries) {
  const zip = new yazl.ZipFile();
  for (const e of entries) {
    const opts = { compress: e.compress !== false, mtime: e.mtime || new Date() };
    if (e.buffer) zip.addBuffer(e.buffer, e.name, opts); else zip.addFile(e.file, e.name, opts);
  }
  zip.end();
  return zip.outputStream;
}

const openZip = (file) => new Promise((resolve, reject) =>
  yauzl.open(file, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true, decodeStrings: true }, (e, z) => (e ? reject(e) : resolve(z))));

/**
 * Walk every file entry of a zip, one at a time. `open()` gives a Readable for the current entry
 * (call it at most once). Resolves after the last entry; rejects on the first error.
 */
export async function eachEntry(file, onEntry) {
  const zip = await openZip(file);
  try {
    await new Promise((resolve, reject) => {
      zip.on('error', reject);
      zip.on('end', resolve);
      zip.on('entry', async (entry) => {
        try {
          if (!entry.fileName.endsWith('/')) {
            await onEntry(entry, () => new Promise((res, rej) => zip.openReadStream(entry, (e, s) => (e ? rej(e) : res(s)))));
          }
          zip.readEntry();
        } catch (e) { reject(e); }
      });
      zip.readEntry();
    });
  } finally { zip.close(); }
}

/**
 * Read an entry's stream to the end, enforcing a size cap and verifying size + CRC-32 against the zip's directory.
 * Writes to `dest` (a file path, mode 0600), or collects into a Buffer when `toBuffer`, or just checks and discards.
 */
export async function consume(entry, stream, { dest = null, toBuffer = false, maxBytes = Infinity } = {}) {
  let bytes = 0, crc = 0;
  const chunks = [];
  const meter = new Transform({
    transform(chunk, _enc, cb) {
      bytes += chunk.length;
      if (bytes > maxBytes) return cb(new Error(`${entry.fileName} is larger than allowed`));
      crc = zlib.crc32(chunk, crc);
      cb(null, chunk);
    },
  });
  const sink = dest ? fs.createWriteStream(dest, { mode: 0o600 })
    : new Writable({ write(chunk, _enc, cb) { if (toBuffer) chunks.push(chunk); cb(); } });
  await pipeline(stream, meter, sink);
  if (bytes !== entry.uncompressedSize) throw new Error(`${entry.fileName}: size does not match the zip directory`);
  if ((crc >>> 0) !== entry.crc32) throw new Error(`${entry.fileName}: checksum mismatch — the backup is damaged`);
  return toBuffer ? Buffer.concat(chunks) : bytes;
}

/** Convenience for tests and tools: [{ name, size }] for every file entry. */
export async function listEntries(file) {
  const out = [];
  await eachEntry(file, async (entry) => { out.push({ name: entry.fileName, size: entry.uncompressedSize }); });
  return out;
}

/** Read one small entry fully (manifest, ...). Returns null when absent. */
export async function readEntry(file, name, maxBytes = 1024 * 1024) {
  let found = null;
  await eachEntry(file, async (entry, open) => { if (entry.fileName === name) found = await consume(entry, await open(), { toBuffer: true, maxBytes }); });
  return found;
}
