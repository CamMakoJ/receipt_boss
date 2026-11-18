import path from 'node:path';
import { db, tx } from '../db.js';
import { err, str, rmImage, imageFile } from '../http.js';
import { photosOf, ownsPhoto, applyPhotoChanges } from '../photos.js';
import { enqueueCheck } from '../ai.js';
import { BILLING, getProject, getReceipt, withPhotos, publicReceipt, full, receiptFields, findDuplicates, duplicateError, needsCheck } from '../domain.js';
import { todayStr } from '../tz.js';

export function registerReceipts(app) {
  app.post('/api/projects/:id/receipts', (req, res) => {
    const p = getProject(req.params.id, req.user);
    const b = req.body || {};
    const clientId = b.client_id ? str(b.client_id, 80) : null;
    if (clientId) { // idempotent: a retried offline sync returns the existing receipt
      const dup = db.prepare('SELECT r.* FROM receipts r JOIN projects pr ON pr.id = r.project_id WHERE r.client_id = ? AND pr.user_id = ?').get(clientId, req.user.id);
      if (dup) return res.status(200).json(full(dup));
    }
    const isDraft = !!b.draft;                                   // quick-capture: stays out of totals/reports until reviewed
    const f = receiptFields(b, null, p);
    if (!b.allow_duplicate && !isDraft) {
      const duplicates = findDuplicates(req.user, f);
      if (duplicates.length) throw duplicateError(duplicates);
    }
    const row = tx(() => {
      let number;
      if (isDraft) number = -db.prepare('SELECT COALESCE(MAX(id), 0) + 1 AS n FROM receipts').get().n; // unique placeholder (-id); real number on review
      else {
        number = db.prepare('SELECT next_number FROM projects WHERE id = ?').get(p.id).next_number;
        db.prepare('UPDATE projects SET next_number = next_number + 1 WHERE id = ?').run(p.id);
      }
      const r = db.prepare(`INSERT INTO receipts
        (project_id, client_id, number, date, vendor, category, description, province, subtotal, gst, pst, tip, billable, tax_auto, notes, ocr_text, draft)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(p.id, clientId, number, f.date, f.vendor, f.category, f.description,
        f.province, f.subtotal, f.gst, f.pst, f.tip, f.billable, f.tax_auto, f.notes, f.ocr_text, isDraft ? 1 : 0);
      applyPhotoChanges('receipt', r.lastInsertRowid, b, { create: true });   // throws on a bad image -> whole insert rolls back
      return db.prepare('SELECT * FROM receipts WHERE id = ?').get(r.lastInsertRowid);
    });
    if (!isDraft && needsCheck(row.image, row.ocr_text)) enqueueCheck(row.id); // second opinion runs in the background
    res.status(201).json(full(db.prepare('SELECT * FROM receipts WHERE id = ?').get(row.id)));
  });

  // every filed receipt of this user, for the cross-project search page (OCR text trimmed to keep the payload small)
  app.get('/api/receipts', (req, res) => {
    const rows = db.prepare(`SELECT r.*, p.name AS project_name FROM receipts r JOIN projects p ON p.id = r.project_id
      WHERE p.user_id = ? AND r.draft = 0 ORDER BY r.date DESC, r.id DESC`).all(req.user.id);
    res.json(withPhotos(rows).map((r) => ({ ...publicReceipt(r), ocr_text: r.ocr_text.slice(0, 1500) })));
  });

  // quick-capture drafts waiting for review, oldest first
  app.get('/api/inbox', (req, res) => {
    res.json(withPhotos(db.prepare(`SELECT r.*, p.name AS project_name FROM receipts r JOIN projects p ON p.id = r.project_id
      WHERE p.user_id = ? AND r.draft = 1 ORDER BY r.id`).all(req.user.id)).map((r) => ({ ...publicReceipt(r), ocr_text: undefined })));
  });

  // bulk invoiced / paid tracking for billable receipts
  app.post('/api/projects/:id/billing', (req, res) => {
    const p = getProject(req.params.id, req.user);
    const { ids, status } = req.body || {};
    if (!BILLING.includes(status)) throw err(400, 'status must be unbilled, invoiced or paid');
    if (!Array.isArray(ids) || !ids.length || ids.length > 5000) throw err(400, 'ids are required');
    const ref = str(req.body.invoice_ref, 60), today = todayStr();
    const updated = tx(() => {
      let n = 0;
      for (const id of ids) {
        const r = db.prepare('SELECT * FROM receipts WHERE id = ? AND project_id = ? AND billable = 1 AND draft = 0').get(Number(id), p.id);
        if (!r) continue;
        if (status === 'unbilled') db.prepare("UPDATE receipts SET billing_status = 'unbilled', invoice_ref = '', invoiced_at = NULL WHERE id = ?").run(r.id);
        else db.prepare('UPDATE receipts SET billing_status = ?, invoice_ref = ?, invoiced_at = ? WHERE id = ?').run(status, ref || r.invoice_ref, r.invoiced_at || today, r.id);
        n++;
      }
      return n;
    });
    res.json({ updated });
  });

  app.get('/api/receipts/:id', (req, res) => res.json(full(getReceipt(req.params.id, req.user))));

  app.patch('/api/receipts/:id', (req, res) => {
    const r = getReceipt(req.params.id, req.user);
    const b = req.body || {};
    const f = receiptFields(b, r, getProject(r.project_id, req.user));
    const finalizing = !!r.draft && b.draft === false;           // reviewed a quick-capture draft: it becomes a real receipt now
    if (finalizing && !b.allow_duplicate) {
      const duplicates = findDuplicates(req.user, f, r.id);
      if (duplicates.length) throw duplicateError(duplicates);
    }
    const target = b.project_id !== undefined && Number(b.project_id) !== r.project_id ? getProject(b.project_id, req.user) : null; // another of your projects
    const projectId = target ? target.id : r.project_id;
    const invoicedAt = f.billing_status === 'unbilled' ? null : (r.invoiced_at || todayStr());
    const photosChanged = tx(() => {
      let number = r.number;
      if (finalizing || (target && !r.draft)) {                  // real receipts are numbered per project
        const proj = target || getProject(r.project_id, req.user);
        number = db.prepare('SELECT next_number FROM projects WHERE id = ?').get(proj.id).next_number;
        db.prepare('UPDATE projects SET next_number = next_number + 1 WHERE id = ?').run(proj.id);
      }
      const changedPhotos = applyPhotoChanges('receipt', r.id, b);
      db.prepare(`UPDATE receipts SET project_id=?, number=?, date=?, vendor=?, category=?, description=?, province=?, subtotal=?, gst=?, pst=?,
        tip=?, billable=?, tax_auto=?, notes=?, ocr_text=?, billing_status=?, invoice_ref=?, invoiced_at=?, draft=? WHERE id=?`).run(projectId, number, f.date, f.vendor, f.category, f.description,
        f.province, f.subtotal, f.gst, f.pst, f.tip, f.billable, f.tax_auto, f.notes, f.ocr_text, f.billing_status,
        f.billing_status === 'unbilled' ? '' : f.invoice_ref, invoicedAt, finalizing ? 0 : r.draft, r.id);
      return changedPhotos;
    });
    // an earlier check no longer describes this entry once the checked fields (or the photos/text) change
    const changed = f.date !== r.date || f.vendor !== r.vendor || f.subtotal !== r.subtotal || f.gst !== r.gst || f.pst !== r.pst || f.tip !== r.tip
      || photosChanged || f.ocr_text !== r.ocr_text;
    if (finalizing || changed) {
      const now = db.prepare('SELECT image, ocr_text, draft FROM receipts WHERE id = ?').get(r.id);
      if (!now.draft && needsCheck(now.image, now.ocr_text)) enqueueCheck(r.id);
      else db.prepare("UPDATE receipts SET check_status = 'none', check_json = '' WHERE id = ?").run(r.id);
    }
    res.json(full(getReceipt(r.id, req.user)));
  });

  app.delete('/api/receipts/:id', (req, res) => {
    const r = getReceipt(req.params.id, req.user);
    const files = photosOf('receipt', r.id).map((x) => x.file);
    db.prepare('DELETE FROM receipts WHERE id = ?').run(r.id);
    files.forEach(rmImage);
    res.status(204).end();
  });

  const sendPhoto = (res, file, immutable = true) => {
    const f = imageFile(file);
    if (!f) throw err(404, 'no image');
    // /photos/:id never changes (ids are never reused); the "cover" URL does, so it must always revalidate
    res.setHeader('Cache-Control', immutable ? 'private, max-age=31536000, immutable' : 'private, no-cache');
    res.type('image/jpeg').sendFile(path.resolve(f));
  };
  app.get('/api/receipts/:id/image', (req, res) => sendPhoto(res, getReceipt(req.params.id, req.user).image, false));   // the cover
  app.get('/api/receipts/:id/photos/:pid', (req, res) => {
    const r = getReceipt(req.params.id, req.user);
    sendPhoto(res, ownsPhoto('receipt', r.id, Number(req.params.pid)));
  });
}
