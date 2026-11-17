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
import { registerAi, aiReady, aiConfig, enqueueCheck, resumePendingChecks, parseCheck } from './ai.js';

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
  const BILLING = ['unbilled', 'invoiced', 'paid'];
  const province = (v) => { if (!isProvince(v)) throw err(400, 'invalid province code'); return v; };

  const publicReceipt = ({ ocr_text, check_json, check_status, ...r }) => ({
    ...r, billable: !!r.billable, tax_auto: !!r.tax_auto, total: total(r), has_image: !!r.image, has_text: !!ocr_text, image: undefined,
    check: parseCheck({ check_status, check_json }),
  });
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
      billing: Object.fromEntries(BILLING.map((st) => [st, sumReceipts(all.filter((r) => r.billable && r.billing_status === st))])),
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
      ocr_text: pick('ocr_text', (v) => str(v, 8000)) ?? '',
      billing_status: pick('billing_status', (v) => { if (!BILLING.includes(v)) throw err(400, 'invalid billing status'); return v; }) ?? 'unbilled',
      invoice_ref: pick('invoice_ref', (v) => str(v, 60)) ?? '',
    };
    if (f.tax_auto) Object.assign(f, calcTax(f.subtotal, f.province)); // server is the authority on auto taxes
    if (!f.description) f.description = f.category;                      // description defaults to the category
    return f;
  }

  /** Same day, same vendor (or description), same total, anywhere in this user's projects. */
  const findDuplicates = (user, f, excludeId = 0) => {
    const t = f.subtotal + f.gst + f.pst + f.tip, label = (f.vendor || f.description || '').trim().toLowerCase();
    if (!t || !label) return [];
    return db.prepare(`SELECT r.id, r.number, r.description, r.vendor, r.date, p.id AS project_id, p.name AS project_name, (r.subtotal + r.gst + r.pst + r.tip) AS total
      FROM receipts r JOIN projects p ON p.id = r.project_id
      WHERE p.user_id = ? AND r.id != ? AND r.date = ? AND (r.subtotal + r.gst + r.pst + r.tip) = ?
        AND lower(trim(CASE WHEN r.vendor != '' THEN r.vendor ELSE r.description END)) = ?`).all(user.id, excludeId, f.date, t, label);
  };
  const needsCheck = (image, text) => aiReady() && aiConfig().auto_check && !!(image || text);

  app.post('/api/projects/:id/receipts', (req, res) => {
    const p = getProject(req.params.id, req.user);
    const b = req.body || {};
    const clientId = b.client_id ? str(b.client_id, 80) : null;
    if (clientId) { // idempotent: a retried offline sync returns the existing receipt
      const dup = db.prepare(`SELECT r.* FROM receipts r JOIN projects pr ON pr.id = r.project_id WHERE r.client_id = ? AND pr.user_id = ?`).get(clientId, req.user.id);
      if (dup) return res.status(200).json(publicReceipt(dup));
    }
    const f = receiptFields(b, null, p);
    if (!b.allow_duplicate) {
      const duplicates = findDuplicates(req.user, f);
      if (duplicates.length) throw err(409, 'This looks like a receipt you already entered', { duplicates });
    }
    const image = b.image ? saveImage(decodeImage(b.image)) : null;
    try {
      const row = tx(() => {
        const cur = db.prepare('SELECT next_number FROM projects WHERE id = ?').get(p.id);
        db.prepare('UPDATE projects SET next_number = next_number + 1 WHERE id = ?').run(p.id);
        const r = db.prepare(`INSERT INTO receipts
          (project_id, client_id, number, date, vendor, category, description, province, subtotal, gst, pst, tip, billable, tax_auto, notes, image, ocr_text)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(p.id, clientId, cur.next_number, f.date, f.vendor, f.category, f.description,
          f.province, f.subtotal, f.gst, f.pst, f.tip, f.billable, f.tax_auto, f.notes, image, f.ocr_text);
        return db.prepare('SELECT * FROM receipts WHERE id = ?').get(r.lastInsertRowid);
      });
      if (needsCheck(row.image, row.ocr_text)) enqueueCheck(row.id); // second opinion runs in the background
      res.status(201).json(publicReceipt(db.prepare('SELECT * FROM receipts WHERE id = ?').get(row.id)));
    } catch (e) { rmImage(image); throw e; }
  });

  // every receipt of this user, for the cross-project search page (OCR text trimmed to keep the payload small)
  app.get('/api/receipts', (req, res) => {
    res.json(db.prepare(`SELECT r.*, p.name AS project_name FROM receipts r JOIN projects p ON p.id = r.project_id
      WHERE p.user_id = ? ORDER BY r.date DESC, r.id DESC`).all(req.user.id)
      .map((r) => ({ ...publicReceipt(r), ocr_text: r.ocr_text.slice(0, 1500) })));
  });

  // bulk invoiced / paid tracking for billable receipts
  app.post('/api/projects/:id/billing', (req, res) => {
    const p = getProject(req.params.id, req.user);
    const { ids, status } = req.body || {};
    if (!BILLING.includes(status)) throw err(400, 'status must be unbilled, invoiced or paid');
    if (!Array.isArray(ids) || !ids.length || ids.length > 5000) throw err(400, 'ids are required');
    const ref = str(req.body.invoice_ref, 60), today = new Date().toISOString().slice(0, 10);
    const updated = tx(() => {
      let n = 0;
      for (const id of ids) {
        const r = db.prepare('SELECT * FROM receipts WHERE id = ? AND project_id = ? AND billable = 1').get(Number(id), p.id);
        if (!r) continue;
        if (status === 'unbilled') db.prepare("UPDATE receipts SET billing_status = 'unbilled', invoice_ref = '', invoiced_at = NULL WHERE id = ?").run(r.id);
        else db.prepare('UPDATE receipts SET billing_status = ?, invoice_ref = ?, invoiced_at = ? WHERE id = ?').run(status, ref || r.invoice_ref, r.invoiced_at || today, r.id);
        n++;
      }
      return n;
    });
    res.json({ updated });
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
    const invoicedAt = f.billing_status === 'unbilled' ? null : (r.invoiced_at || new Date().toISOString().slice(0, 10));
    db.prepare(`UPDATE receipts SET project_id=?, number=?, date=?, vendor=?, category=?, description=?, province=?, subtotal=?, gst=?, pst=?,
      tip=?, billable=?, tax_auto=?, notes=?, image=?, ocr_text=?, billing_status=?, invoice_ref=?, invoiced_at=? WHERE id=?`).run(projectId, number, f.date, f.vendor, f.category, f.description,
      f.province, f.subtotal, f.gst, f.pst, f.tip, f.billable, f.tax_auto, f.notes, image, f.ocr_text, f.billing_status,
      f.billing_status === 'unbilled' ? '' : f.invoice_ref, invoicedAt, r.id);
    if (image !== r.image) rmImage(r.image);
    // an earlier check no longer describes this entry once the checked fields (or the photo/text) change
    const changed = f.date !== r.date || f.vendor !== r.vendor || f.subtotal !== r.subtotal || f.gst !== r.gst || f.pst !== r.pst || f.tip !== r.tip
      || image !== r.image || f.ocr_text !== r.ocr_text;
    if (changed) { if (needsCheck(image, f.ocr_text)) enqueueCheck(r.id); else db.prepare("UPDATE receipts SET check_status = 'none', check_json = '' WHERE id = ?").run(r.id); }
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
    // ?only=billable drops non-billable receipts; ?billing=unbilled|invoiced|paid and ?invoice=REF narrow the billable ones
    const only = req.query.only === 'billable', billing = BILLING.includes(req.query.billing) ? req.query.billing : 'all', invoice = str(req.query.invoice, 60);
    receipts = receipts.filter((r) => (r.billable ? (billing === 'all' || r.billing_status === billing) && (!invoice || r.invoice_ref === invoice) : !only));
    if (req.query.autotax !== '0') receipts = applyAutoTax(receipts);
    return { p, from, to, invoice, receipts };
  };
  app.get('/api/projects/:id/export.zip', wrap(async (req, res) => {
    const { p, from, to, invoice, receipts } = exportData(req);
    await streamZip(res, p, receipts, { from, to, invoice });
  }));
  app.get('/api/projects/:id/report.pdf', wrap(async (req, res) => {
    const { p, from, to, invoice, receipts } = exportData(req);
    const pdf = await buildPdf(p, receipts, { from, to, invoice });
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
  registerAi(app, { getReceipt });

  app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }));

  // ---------- static PWA
  app.use(express.static(PUBLIC_DIR, { setHeaders: (res, f) => { if (f.endsWith('sw.js')) res.setHeader('Cache-Control', 'no-cache'); } }));

  // eslint-disable-next-line no-unused-vars
  app.use((e, req, res, next) => {
    if (!e.status) console.error(e);
    res.status(e.status || 500).json({ error: e.status ? e.message : 'internal error', ...(e.status && e.extra ? e.extra : {}) });
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
  resumePendingChecks();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) startServer();
