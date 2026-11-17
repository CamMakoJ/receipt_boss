import { db } from '../db.js';
import { err, str, rmImage } from '../http.js';
import { photoFiles } from '../photos.js';
import { DEFAULT_PROVINCE } from '../tax.js';
import { getProject, projectReceipts, withPhotos, publicReceipt, withTotals, projectSummary, province } from '../domain.js';

export function registerProjects(app) {
  app.get('/api/projects', (req, res) => {
    res.json(withTotals(db.prepare('SELECT * FROM projects WHERE user_id = ? ORDER BY archived, name COLLATE NOCASE').all(req.user.id)));
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
    const drafts = db.prepare('SELECT * FROM receipts WHERE project_id = ? AND draft = 1 ORDER BY id').all(p.id);
    res.json({ ...projectSummary(p), receipts: withPhotos(projectReceipts(p.id)).map(publicReceipt), drafts: withPhotos(drafts).map(publicReceipt) });
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
    const files = photoFiles('receipt', 'project_id = ?', p.id);   // collect before the rows cascade away
    db.prepare('DELETE FROM projects WHERE id = ?').run(p.id);
    files.forEach(rmImage);
    res.status(204).end();
  });
}
