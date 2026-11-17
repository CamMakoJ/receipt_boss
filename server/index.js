import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { db, tx, IMAGE_DIR, DATA_DIR } from './db.js';
import { sumReceipts, total, slug } from './util.js';
import { buildPdf, buildCsv, streamZip } from './export.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '30mb' }));

  // ---------- helpers
  const err = (status, message) => Object.assign(new Error(message), { status });
  const cents = (v, name) => {
    const n = Number(v ?? 0);
    if (!Number.isInteger(n) || n < 0 || n > 1e10) throw err(400, `${name} must be a non-negative integer (cents)`);
    return n;
  };
  const str = (v, max = 500) => String(v ?? '').trim().slice(0, max);
  const rate = (v, d) => { const n = Number(v ?? d); if (!(n >= 0 && n <= 100)) throw err(400, 'tax rate must be 0-100'); return n; };
  const dateStr = (v) => {
    const s = str(v, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) throw err(400, 'date must be YYYY-MM-DD');
    return s;
  };

  /** Accepts a data: URL or bare base64 JPEG/PNG and returns a Buffer. */
  function decodeImage(b64) {
    const buf = Buffer.from(String(b64).replace(/^data:[^,]*,/, ''), 'base64');
    const jpeg = buf[0] === 0xff && buf[1] === 0xd8;
    const png = buf.subarray(0, 4).toString('hex') === '89504e47';
    if (!jpeg && !png) throw err(400, 'image must be JPEG or PNG');
    return buf;
  }
  function saveImage(buf) {
    const name = crypto.randomUUID() + '.jpg';
    fs.writeFileSync(path.join(IMAGE_DIR, name), buf);
    return name;
  }
  const rmImage = (name) => { if (name) fs.rmSync(path.join(IMAGE_DIR, name), { force: true }); };

  const publicReceipt = (r) => ({ ...r, billable: !!r.billable, total: total(r), has_image: !!r.image, image: undefined });
  const getProject = (id) => {
    const p = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
    if (!p) throw err(404, 'project not found');
    return p;
  };
  const projectReceipts = (id, from, to) => {
    let sql = 'SELECT * FROM receipts WHERE project_id = ?';
    const args = [id];
    if (from) { sql += ' AND date >= ?'; args.push(from); }
    if (to) { sql += ' AND date <= ?'; args.push(to); }
    return db.prepare(sql + ' ORDER BY number').all(...args);
  };
  const projectSummary = (p) => {
    const all = projectReceipts(p.id);
    return {
      ...p, archived: !!p.archived,
      billable: sumReceipts(all.filter((r) => r.billable)),
      non_billable: sumReceipts(all.filter((r) => !r.billable)),
      all: sumReceipts(all),
    };
  };
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

  // ---------- projects
  app.get('/api/projects', (req, res) => {
    res.json(db.prepare('SELECT * FROM projects ORDER BY archived, name COLLATE NOCASE').all().map(projectSummary));
  });

  app.post('/api/projects', (req, res) => {
    const b = req.body || {};
    const name = str(b.name, 120);
    if (!name) throw err(400, 'name is required');
    const r = db.prepare('INSERT INTO projects (name, client, notes, gst_rate, pst_rate) VALUES (?,?,?,?,?)')
      .run(name, str(b.client, 120), str(b.notes, 2000), rate(b.gst_rate, 5), rate(b.pst_rate, 7));
    res.status(201).json(projectSummary(getProject(r.lastInsertRowid)));
  });

  app.get('/api/projects/:id', (req, res) => {
    const p = getProject(req.params.id);
    res.json({ ...projectSummary(p), receipts: projectReceipts(p.id).map(publicReceipt) });
  });

  app.patch('/api/projects/:id', (req, res) => {
    const p = getProject(req.params.id);
    const b = req.body || {};
    db.prepare('UPDATE projects SET name=?, client=?, notes=?, gst_rate=?, pst_rate=?, archived=? WHERE id=?').run(
      b.name !== undefined ? str(b.name, 120) || p.name : p.name,
      b.client !== undefined ? str(b.client, 120) : p.client,
      b.notes !== undefined ? str(b.notes, 2000) : p.notes,
      b.gst_rate !== undefined ? rate(b.gst_rate) : p.gst_rate,
      b.pst_rate !== undefined ? rate(b.pst_rate) : p.pst_rate,
      b.archived !== undefined ? (b.archived ? 1 : 0) : p.archived, p.id);
    res.json(projectSummary(getProject(p.id)));
  });

  app.delete('/api/projects/:id', (req, res) => {
    const p = getProject(req.params.id);
    const imgs = projectReceipts(p.id).map((r) => r.image);
    db.prepare('DELETE FROM projects WHERE id = ?').run(p.id);
    imgs.forEach(rmImage);
    res.status(204).end();
  });

  // ---------- receipts
  function receiptFields(b, existing = {}) {
    const pick = (k, f) => (b[k] !== undefined ? f(b[k]) : existing[k]);
    return {
      date: pick('date', dateStr) ?? new Date().toISOString().slice(0, 10),
      vendor: pick('vendor', (v) => str(v, 200)) ?? '',
      description: pick('description', (v) => str(v, 300)) ?? '',
      subtotal: pick('subtotal', (v) => cents(v, 'subtotal')) ?? 0,
      gst: pick('gst', (v) => cents(v, 'gst')) ?? 0,
      pst: pick('pst', (v) => cents(v, 'pst')) ?? 0,
      tip: pick('tip', (v) => cents(v, 'tip')) ?? 0,
      billable: pick('billable', (v) => (v ? 1 : 0)) ?? 1,
      notes: pick('notes', (v) => str(v, 2000)) ?? '',
    };
  }

  app.post('/api/projects/:id/receipts', (req, res) => {
    const p = getProject(req.params.id);
    const b = req.body || {};
    const clientId = b.client_id ? str(b.client_id, 80) : null;
    if (clientId) { // idempotent: a retried offline sync returns the existing receipt
      const dup = db.prepare('SELECT * FROM receipts WHERE client_id = ?').get(clientId);
      if (dup) return res.status(200).json(publicReceipt(dup));
    }
    const f = receiptFields(b);
    const image = b.image ? saveImage(decodeImage(b.image)) : null;
    try {
      const row = tx(() => {
        const cur = db.prepare('SELECT next_number FROM projects WHERE id = ?').get(p.id);
        db.prepare('UPDATE projects SET next_number = next_number + 1 WHERE id = ?').run(p.id);
        const r = db.prepare(`INSERT INTO receipts
          (project_id, client_id, number, date, vendor, description, subtotal, gst, pst, tip, billable, notes, image)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(p.id, clientId, cur.next_number, f.date, f.vendor, f.description,
          f.subtotal, f.gst, f.pst, f.tip, f.billable, f.notes, image);
        return db.prepare('SELECT * FROM receipts WHERE id = ?').get(r.lastInsertRowid);
      });
      res.status(201).json(publicReceipt(row));
    } catch (e) { rmImage(image); throw e; }
  });

  const getReceipt = (id) => {
    const r = db.prepare('SELECT * FROM receipts WHERE id = ?').get(id);
    if (!r) throw err(404, 'receipt not found');
    return r;
  };

  app.get('/api/receipts/:id', (req, res) => res.json(publicReceipt(getReceipt(req.params.id))));

  app.patch('/api/receipts/:id', (req, res) => {
    const r = getReceipt(req.params.id);
    const b = req.body || {};
    const f = receiptFields(b, r);
    let image = r.image;
    if (b.image) image = saveImage(decodeImage(b.image));
    else if (b.remove_image) image = null;
    let projectId = r.project_id, number = r.number;
    if (b.project_id !== undefined && Number(b.project_id) !== r.project_id) { // move to another project
      const target = getProject(b.project_id);
      projectId = target.id;
      number = target.next_number;
      db.prepare('UPDATE projects SET next_number = next_number + 1 WHERE id = ?').run(target.id);
    }
    db.prepare(`UPDATE receipts SET project_id=?, number=?, date=?, vendor=?, description=?, subtotal=?, gst=?, pst=?,
      tip=?, billable=?, notes=?, image=? WHERE id=?`).run(projectId, number, f.date, f.vendor, f.description,
      f.subtotal, f.gst, f.pst, f.tip, f.billable, f.notes, image, r.id);
    if (image !== r.image) rmImage(r.image);
    res.json(publicReceipt(getReceipt(r.id)));
  });

  app.delete('/api/receipts/:id', (req, res) => {
    const r = getReceipt(req.params.id);
    db.prepare('DELETE FROM receipts WHERE id = ?').run(r.id);
    rmImage(r.image);
    res.status(204).end();
  });

  app.get('/api/receipts/:id/image', (req, res) => {
    const r = getReceipt(req.params.id);
    const file = r.image && path.join(IMAGE_DIR, r.image);
    if (!file || !fs.existsSync(file)) throw err(404, 'no image');
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.type('image/jpeg').sendFile(file);
  });

  // ---------- exports
  const exportData = (req) => {
    const p = getProject(req.params.id);
    const from = req.query.from && dateStr(req.query.from);
    const to = req.query.to && dateStr(req.query.to);
    return { p, from, to, receipts: projectReceipts(p.id, from, to) };
  };
  app.get('/api/projects/:id/export.zip', wrap(async (req, res) => {
    const { p, from, to, receipts } = exportData(req);
    await streamZip(res, p, receipts, { from, to });
  }));
  app.get('/api/projects/:id/report.pdf', wrap(async (req, res) => {
    const { p, from, to, receipts } = exportData(req);
    const pdf = await buildPdf(p, receipts, { from, to });
    res.setHeader('Content-Disposition', `attachment; filename="${slug(p.name) || 'project'}_report.pdf"`);
    res.type('application/pdf').send(pdf);
  }));
  app.get('/api/projects/:id/report.csv', (req, res) => {
    const { p, receipts } = exportData(req);
    res.setHeader('Content-Disposition', `attachment; filename="${slug(p.name) || 'project'}_report.csv"`);
    res.type('text/csv; charset=utf-8').send(buildCsv(p, receipts));
  });

  // ---------- static PWA
  app.use(express.static(PUBLIC_DIR, { setHeaders: (res, f) => { if (f.endsWith('sw.js')) res.setHeader('Cache-Control', 'no-cache'); } }));

  app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }));
  // eslint-disable-next-line no-unused-vars
  app.use((e, req, res, next) => {
    if (!e.status) console.error(e);
    res.status(e.status || 500).json({ error: e.status ? e.message : 'internal error' });
  });
  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '127.0.0.1';
  createApp().listen(port, host, () => {
    console.log(`Receipt Boss on http://${host}:${port}  (data: ${DATA_DIR})`);
  });
}
