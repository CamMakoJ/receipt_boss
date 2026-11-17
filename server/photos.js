// Several photos per receipt / household item. receipts.image / items.image always mirror the first photo ("cover").
import { db } from './db.js';
import { err, decodeImage, saveImage, rmImage, imageFile } from './http.js';

export const MAX_PHOTOS = 12;
const KINDS = {
  receipt: { table: 'receipt_photos', fk: 'receipt_id', parent: 'receipts' },
  item: { table: 'item_photos', fk: 'item_id', parent: 'items' },
};

export const photosOf = (kind, id) => {
  const k = KINDS[kind];
  return db.prepare(`SELECT id, file, position FROM ${k.table} WHERE ${k.fk} = ? ORDER BY position, id`).all(id);
};

/** { [recordId]: [{id, file}] } for many records at once. */
export function photosMap(kind, ids) {
  const k = KINDS[kind], map = {};
  if (!ids.length) return map;
  const rows = db.prepare(`SELECT id, ${k.fk} AS owner, file FROM ${k.table} WHERE ${k.fk} IN (${ids.map(() => '?').join(',')}) ORDER BY position, id`).all(...ids);
  for (const r of rows) (map[r.owner] ||= []).push({ id: r.id, file: r.file });
  return map;
}

/** Files that belong to every record matched by `where` (used before cascading deletes). */
export function photoFiles(kind, where, ...args) {
  const k = KINDS[kind];
  return db.prepare(`SELECT file FROM ${k.table} WHERE ${k.fk} IN (SELECT id FROM ${k.parent} WHERE ${where})`).all(...args).map((r) => r.file);
}

export const ownsPhoto = (kind, id, photoId) => {
  const k = KINDS[kind];
  return db.prepare(`SELECT file FROM ${k.table} WHERE id = ? AND ${k.fk} = ?`).get(photoId, id)?.file ?? null;
};

function syncCover(kind, id) {
  const k = KINDS[kind], first = photosOf(kind, id)[0];
  db.prepare(`UPDATE ${k.parent} SET image = ? WHERE id = ?`).run(first?.file ?? null, id);
}

/**
 * Apply the photo parts of a request body to one record. Returns true when anything changed.
 *   create: images[] (and legacy image)
 *   update: add_images[], remove_photo_ids[], photo_order[] (existing ids, first = cover);
 *           legacy `image` replaces ALL photos, legacy `remove_image` removes all.
 * Every new image is decoded before anything is written, so one bad image never leaves half a batch saved.
 */
export function applyPhotoChanges(kind, id, body, { create = false } = {}) {
  const k = KINDS[kind];
  const legacyReplace = !create && (!!body.image || !!body.remove_image);
  const adds = [...(Array.isArray(body.add_images) ? body.add_images : []), ...(Array.isArray(body.images) ? body.images : []), ...(body.image ? [body.image] : [])];
  const decoded = adds.map(decodeImage);

  const existing = photosOf(kind, id);
  let removeIds = new Set(legacyReplace ? existing.map((p) => p.id) : (Array.isArray(body.remove_photo_ids) ? body.remove_photo_ids.map(Number) : []));
  removeIds = new Set(existing.filter((p) => removeIds.has(p.id)).map((p) => p.id));
  const keep = existing.filter((p) => !removeIds.has(p.id));
  if (keep.length + decoded.length > MAX_PHOTOS) throw err(400, `at most ${MAX_PHOTOS} photos per ${kind}`);

  let ordered = keep;
  if (Array.isArray(body.photo_order)) {
    const want = body.photo_order.map(Number), byId = new Map(keep.map((p) => [p.id, p]));
    ordered = [...want.filter((x) => byId.has(x)).map((x) => byId.get(x)), ...keep.filter((p) => !want.includes(p.id))];
  }
  const orderChanged = ordered.some((p, i) => keep[i]?.id !== p.id);
  if (!decoded.length && !removeIds.size && !orderChanged) return false;

  const savedFiles = [];
  try {
    for (const buf of decoded) savedFiles.push(saveImage(buf));
    for (const pid of removeIds) db.prepare(`DELETE FROM ${k.table} WHERE id = ?`).run(pid);
    let pos = 0;
    for (const p of ordered) db.prepare(`UPDATE ${k.table} SET position = ? WHERE id = ?`).run(pos++, p.id);
    for (const f of savedFiles) db.prepare(`INSERT INTO ${k.table} (${k.fk}, file, position) VALUES (?, ?, ?)`).run(id, f, pos++);
    syncCover(kind, id);
  } catch (e) { savedFiles.forEach(rmImage); throw e; }
  existing.filter((p) => removeIds.has(p.id)).forEach((p) => rmImage(p.file));   // files go only after the DB is updated
  return true;
}

export const photoPath = (file) => imageFile(file);
