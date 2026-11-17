import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { fileURLToPath } from 'node:url';
import { db, tx, DATA_DIR } from './db.js';
import { sumReceipts, total, slug } from './util.js';
import { err, wrap, str, cents, dateStr, decodeImage, saveImage, rmImage, imageFile } from './http.js';
import { PROVINCES, DEFAULT_PROVINCE, RECEIPT_CATEGORIES, ITEM_CATEGORIES, isProvince, calcTax } from './tax.js';
import { registerAuth, sessionMiddleware } from './auth.js';
import { registerItems } from './items.js';
import { registerBackup, startBackupScheduler } from './backup.js';
import { buildPdf, buildCsv, streamZip, applyAutoTax } from './export.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY === '1' ? 1 : process.env.TRUST_PROXY);

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
  });
  app.use(express.json({ limit: '30mb' }));
  app.use(sessionMiddleware);

  // CSRF defence in depth (cookies are also SameSite=Lax): state-changing calls must carry a custom header,
  // which a cross-site page cannot send without a CORS preflight that this server never grants.
  app.use('/api', (req, res, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.get('x-rb') !== '1') return next(err(403, 'missing X-RB header'));
    next();
  });

  registerAuth(app); // public /api/auth/*; everything registered after this requires a session

  app.get('/api/meta', (req, res) => res.json({
    provinces: Object.fromEntries(Object.entries(PROVINCES).map(([k, v]) => [k, { name: v.name, gst: v.gst, pst: v.pst, note: v.note }])),
    default_province: DEFAULT_PROVINCE,
    receipt_categories: RECEIPT_CATEGORIES,
    item_categories: ITEM_CATEGORIES,
    // categories this user has already typed, so custom ones show up in the picker
    used_categories: db.prepare(`SELECT DISTINCT r.category FROM receipts r JOIN projects p ON p.id = r.project_id
      WHERE p.user_id = ? AND r.category != '' ORDER BY r.category COLLATE NOCASE`).all(req.user.id).map((r) => r.category),
  }));

  // ---------- helpers
  const province = (v) => { if (!isProvince(v)) throw err(400, 'invalid province code'); return v; };

  const publicReceipt = (r) => ({ ...r, billable: !!r.billable, tax_auto: !!r.tax_auto, total: total(r), has_image: !!r.image, image: undefined });
  const getProject = (id, user) => {
    const p = db.prepare('SELECT * FROM projects WHERE id = ? AND user_id = ?').get(id, user.id);
    if (!p) throw err(404, 'project not found');
    return p;
  };
  const getReceipt = (id, user) => {
    const r = db.prepare(`SELECT r.* FROM receipts r JOIN projects p ON p.id = r.project_id WHERE r.id = ? AND p.user_id = ?`).get(id, user.id);
    if (!r) throw err(404, 'receipt not found');
    return r;
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
      ...p, user_id: undefined, archived: !!p.archived,
      billable: sumReceipts(all.filter((r) => r.billable)),
      non_billable: sumReceipts(all.filter((r) => !r.billable)),
      all: sumReceipts(all),
    };
  };

  // ---------- projects
  app.get('/api/projects', (req, res) => {
    res.json(db.prepare('SELECT * FROM projects WHERE user_id = ? ORDER BY archived, name COLLATE NOCASE').all(req.user.id).map(projectSummary));
  });

  app.post('/api/projects', (req, res) => {
    const b = req.body || {};
    const name = str(b.name, 120);
    if (!name) throw err(400, 'name is required');
    const r = db.prepare('INSERT INTO projects (user_id, name, client, notes, province) VALUES (?,?,?,?,?)')
      .run(req.user.id, name, str(b.client, 120), str(b.notes, 2000), province(b.province ?? DEFAULT_PROVINCE));
    res.status(201).json(projectSummary(getProject(r.lastInsertRowid, req.user)));
  });

  app.get('/api/projects/:id', (req, res) => {
    const p = getProject(req.params.id, req.user);
    res.json({ ...projectSummary(p), receipts: projectReceipts(p.id).map(publicReceipt) });
  });

  app.patch('/api/projects/:id', (req, res) => {
    const p = getProject(req.params.id, req.user);
    const b = req.body || {};
    db.prepare('UPDATE projects SET name=?, client=?, notes=?, province=?, archived=? WHERE id=?').run(
      b.name !== undefined ? str(b.name, 120) || p.name : p.name,
      b.client !== undefined ? str(b.client, 120) : p.client,
      b.notes !== undefined ? str(b.notes, 2000) : p.notes,
      b.province !== undefined ? province(b.province) : p.province,
      b.archived !== undefined ? (b.archived ? 1 : 0) : p.archived, p.id);
    res.json(projectSummary(getProject(p.id, req.user)));
  });

  app.delete('/api/projects/:id', (req, res) => {
    const p = getProject(req.params.id, req.user);
    const imgs = projectReceipts(p.id).map((r) => r.image);
    db.prepare('DELETE FROM projects WHERE id = ?').run(p.id);
    imgs.forEach(rmImage);
    res.status(204).end();
  });

  // ---------- receipts
  /** Validates body fields, falling back to `existing`; applies province tax + category->description rules. */
  function receiptFields(b, existing, project) {
    const pick = (k, f) => (b[k] !== undefined ? f(b[k]) : existing?.[k]);
    const f = {
      date: pick('date', dateStr) ?? new Date().toISOString().slice(0, 10),
      vendor: pick('vendor', (v) => str(v, 200)) ?? '',
      category: pick('category', (v) => str(v, 60)) ?? '',
      description: pick('description', (v) => str(v, 300)) ?? '',
      province: pick('province', province) ?? project.province,
      subtotal: pick('subtotal', (v) => cents(v, 'subtotal')) ?? 0,
      gst: pick('gst', (v) => cents(v, 'gst')) ?? 0,
      pst: pick('pst', (v) => cents(v, 'pst')) ?? 0,
      tip: pick('tip', (v) => cents(v, 'tip')) ?? 0,
      billable: pick('billable', (v) => (v ? 1 : 0)) ?? 1,
      tax_auto: pick('tax_auto', (v) => (v ? 1 : 0)) ?? 0,
      notes: pick('notes', (v) => str(v, 2000)) ?? '',
    };
    if (f.tax_auto) Object.assign(f, calcTax(f.subtotal, f.province)); // server is the authority on auto taxes
    if (!f.description) f.description = f.category;                      // description defaults to the category
    return f;
  }

  app.post('/api/projects/:id/receipts', (req, res) => {
    const p = getProject(req.params.id, req.user);
    const b = req.body || {};
    const clientId = b.client_id ? str(b.client_id, 80) : null;
    if (clientId) { // idempotent: a retried offline sync returns the existing receipt
      const dup = db.prepare(`SELECT r.* FROM receipts r JOIN projects pr ON pr.id = r.project_id WHERE r.client_id = ? AND pr.user_id = ?`).get(clientId, req.user.id);
      if (dup) return res.status(200).json(publicReceipt(dup));
    }
    const f = receiptFields(b, null, p);
    const image = b.image ? saveImage(decodeImage(b.image)) : null;
    try {
      const row = tx(() => {
        const cur = db.prepare('SELECT next_number FROM projects WHERE id = ?').get(p.id);
        db.prepare('UPDATE projects SET next_number = next_number + 1 WHERE id = ?').run(p.id);
        const r = db.prepare(`INSERT INTO receipts
          (project_id, client_id, number, date, vendor, category, description, province, subtotal, gst, pst, tip, billable, tax_auto, notes, image)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(p.id, clientId, cur.next_number, f.date, f.vendor, f.category, f.description,
          f.province, f.subtotal, f.gst, f.pst, f.tip, f.billable, f.tax_auto, f.notes, image);
        return db.prepare('SELECT * FROM receipts WHERE id = ?').get(r.lastInsertRowid);
      });
      res.status(201).json(publicReceipt(row));
    } catch (e) { rmImage(image); throw e; }
  });

  app.get('/api/receipts/:id', (req, res) => res.json(publicReceipt(getReceipt(req.params.id, req.user))));

  app.patch('/api/receipts/:id', (req, res) => {
    const r = getReceipt(req.params.id, req.user);
    const b = req.body || {};
    const f = receiptFields(b, r, getProject(r.project_id, req.user));
    let image = r.image;
    if (b.image) image = saveImage(decodeImage(b.image));
    else if (b.remove_image) image = null;
    let projectId = r.project_id, number = r.number;
    if (b.project_id !== undefined && Number(b.project_id) !== r.project_id) { // move to another of your projects
      const target = getProject(b.project_id, req.user);
      projectId = target.id;
      number = target.next_number;
      db.prepare('UPDATE projects SET next_number = next_number + 1 WHERE id = ?').run(target.id);
    }
    db.prepare(`UPDATE receipts SET project_id=?, number=?, date=?, vendor=?, category=?, description=?, province=?, subtotal=?, gst=?, pst=?,
      tip=?, billable=?, tax_auto=?, notes=?, image=? WHERE id=?`).run(projectId, number, f.date, f.vendor, f.category, f.description,
      f.province, f.subtotal, f.gst, f.pst, f.tip, f.billable, f.tax_auto, f.notes, image, r.id);
    if (image !== r.image) rmImage(r.image);
    res.json(publicReceipt(getReceipt(r.id, req.user)));
  });

  app.delete('/api/receipts/:id', (req, res) => {
    const r = getReceipt(req.params.id, req.user);
    db.prepare('DELETE FROM receipts WHERE id = ?').run(r.id);
    rmImage(r.image);
    res.status(204).end();
  });

  app.get('/api/receipts/:id/image', (req, res) => {
    const r = getReceipt(req.params.id, req.user);
    const file = imageFile(r.image);
    if (!file) throw err(404, 'no image');
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.type('image/jpeg').sendFile(path.resolve(file));
  });

  // ---------- exports (?autotax=0 turns off report-time GST/PST estimation)
  const exportData = (req) => {
    const p = getProject(req.params.id, req.user);
    const from = req.query.from ? dateStr(req.query.from) : undefined;
    const to = req.query.to ? dateStr(req.query.to) : undefined;
    let receipts = projectReceipts(p.id, from, to);
    if (req.query.autotax !== '0') receipts = applyAutoTax(receipts);
    return { p, from, to, receipts };
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

  registerItems(app);
  registerBackup(app);

  app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }));

  // ---------- static PWA
  app.use(express.static(PUBLIC_DIR, { setHeaders: (res, f) => { if (f.endsWith('sw.js')) res.setHeader('Cache-Control', 'no-cache'); } }));

  // eslint-disable-next-line no-unused-vars
  app.use((e, req, res, next) => {
    if (!e.status) console.error(e);
    res.status(e.status || 500).json({ error: e.status ? e.message : 'internal error' });
  });
  return app;
}

// ---------------------------------------------------------------- server start (HTTPS-capable)
function startServer() {
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '0.0.0.0';
  const { TLS_CERT, TLS_KEY } = process.env;
  const app = createApp();
  let server, scheme = 'http';

  if (TLS_CERT && TLS_KEY) {
    const load = () => ({ cert: fs.readFileSync(TLS_CERT), key: fs.readFileSync(TLS_KEY) });
    server = https.createServer(load(), app);
    scheme = 'https';
    // pick up renewed certificates (e.g. `tailscale cert`, Let's Encrypt) without a restart
    setInterval(() => { try { server.setSecureContext(load()); } catch (e) { console.error('TLS reload failed:', e.message); } }, 12 * 3600e3).unref();
  } else {
    server = http.createServer(app);
  }
  server.listen(port, host, () => {
    console.log(`Receipt Boss on ${scheme}://${host}:${port}   (data: ${DATA_DIR})`);
    if (scheme === 'http' && !['127.0.0.1', 'localhost', '::1'].includes(host)) {
      console.warn('WARNING: serving plain HTTP on the network. Phone camera, offline mode and "install app" need HTTPS,');
      console.warn('and passwords/sessions travel unencrypted. Set TLS_CERT and TLS_KEY (see README).');
    }
  });
  startBackupScheduler();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) startServer();
