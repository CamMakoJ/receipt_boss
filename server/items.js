// Household purchases tracked for warranty (TV, fridge, laptop...). Shared by every account in the house.
import path from 'node:path';
import { db } from './db.js';
import { err, str, cents, dateStr, decodeImage, saveImage, rmImage, imageFile } from './http.js';
import { warrantyExpiry } from './tax.js';
import { csvCell, plain, slug } from './util.js';

const pub = (i) => ({
  ...i, has_image: !!i.image, image: undefined,
  warranty_expires: warrantyExpiry(i.purchase_date, i.warranty_months),
});

export function registerItems(app) {
  const get = (id) => {
    const i = db.prepare('SELECT * FROM items WHERE id = ?').get(id);
    if (!i) throw err(404, 'item not found');
    return i;
  };
  const months = (v) => {
    if (v === null || v === '' || v === undefined) return null;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0 || n > 1200) throw err(400, 'warranty_months must be 0-1200');
    return n || null;
  };

  app.get('/api/items', (req, res) => {
    res.json(db.prepare('SELECT * FROM items ORDER BY purchase_date DESC, id DESC').all().map(pub));
  });

  app.get('/api/items.csv', (req, res) => {
    const head = ['Item', 'Category', 'Purchase date', 'Vendor', 'Price', 'Warranty (months)', 'Warranty ends', 'Serial / model', 'Notes'];
    const rows = db.prepare('SELECT * FROM items ORDER BY purchase_date').all().map(pub).map((i) =>
      [i.name, i.category, i.purchase_date, i.vendor, plain(i.price), i.warranty_months ?? '', i.warranty_expires ?? '', i.serial, i.notes]);
    res.setHeader('Content-Disposition', 'attachment; filename="household-items.csv"');
    res.type('text/csv; charset=utf-8').send('﻿' + [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n');
  });

  app.post('/api/items', (req, res) => {
    const b = req.body || {};
    const clientId = b.client_id ? str(b.client_id, 80) : null;
    if (clientId) {
      const dup = db.prepare('SELECT * FROM items WHERE client_id = ?').get(clientId);
      if (dup) return res.json(pub(dup));
    }
    const name = str(b.name, 200);
    if (!name) throw err(400, 'name is required');
    const image = b.image ? saveImage(decodeImage(b.image)) : null;
    try {
      const r = db.prepare(`INSERT INTO items (created_by, client_id, name, category, purchase_date, vendor, price, warranty_months, serial, notes, image)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(req.user.id, clientId, name, str(b.category, 60), dateStr(b.purchase_date), str(b.vendor, 200),
        cents(b.price, 'price'), months(b.warranty_months), str(b.serial, 200), str(b.notes, 2000), image);
      res.status(201).json(pub(get(r.lastInsertRowid)));
    } catch (e) { rmImage(image); throw e; }
  });

  app.get('/api/items/:id', (req, res) => res.json(pub(get(req.params.id))));

  app.patch('/api/items/:id', (req, res) => {
    const i = get(req.params.id);
    const b = req.body || {};
    let image = i.image;
    if (b.image) image = saveImage(decodeImage(b.image));
    else if (b.remove_image) image = null;
    const name = b.name !== undefined ? str(b.name, 200) : i.name;
    if (!name) throw err(400, 'name is required');
    db.prepare(`UPDATE items SET name=?, category=?, purchase_date=?, vendor=?, price=?, warranty_months=?, serial=?, notes=?, image=? WHERE id=?`).run(
      name,
      b.category !== undefined ? str(b.category, 60) : i.category,
      b.purchase_date !== undefined ? dateStr(b.purchase_date) : i.purchase_date,
      b.vendor !== undefined ? str(b.vendor, 200) : i.vendor,
      b.price !== undefined ? cents(b.price, 'price') : i.price,
      b.warranty_months !== undefined ? months(b.warranty_months) : i.warranty_months,
      b.serial !== undefined ? str(b.serial, 200) : i.serial,
      b.notes !== undefined ? str(b.notes, 2000) : i.notes,
      image, i.id);
    if (image !== i.image) rmImage(i.image);
    res.json(pub(get(i.id)));
  });

  app.delete('/api/items/:id', (req, res) => {
    const i = get(req.params.id);
    db.prepare('DELETE FROM items WHERE id = ?').run(i.id);
    rmImage(i.image);
    res.status(204).end();
  });

  app.get('/api/items/:id/image', (req, res) => {
    const i = get(req.params.id);
    const file = imageFile(i.image);
    if (!file) throw err(404, 'no image');
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.setHeader('Content-Disposition', `inline; filename="${slug(i.name) || 'item'}.jpg"`);
    res.type('image/jpeg').sendFile(path.resolve(file));
  });
}
