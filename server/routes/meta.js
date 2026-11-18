import { db } from '../db.js';
import { requireAdmin } from '../auth.js';
import { err } from '../http.js';
import { getTz, setTz, isValidTz, timezones, todayStr } from '../tz.js';
import { buildVendorIndex } from '../../public/vendor.js';
import { PROVINCES, DEFAULT_PROVINCE, RECEIPT_CATEGORIES, ITEM_CATEGORIES } from '../tax.js';

export function registerMeta(app) {
  app.get('/api/general', requireAdmin, (req, res) => res.json({ timezone: getTz(), today: todayStr(), timezones: timezones() }));
  app.put('/api/general', requireAdmin, (req, res) => {
    const tz = String(req.body?.timezone || '').trim();
    if (!isValidTz(tz)) throw err(400, 'unknown time zone (use a name like America/Vancouver)');
    setTz(tz);
    res.json({ timezone: getTz(), today: todayStr(), timezones: timezones() });
  });

  app.get('/api/meta', (req, res) => res.json({
    provinces: Object.fromEntries(Object.entries(PROVINCES).map(([k, v]) => [k, { name: v.name, gst: v.gst, pst: v.pst, note: v.note }])),
    default_province: DEFAULT_PROVINCE,
    receipt_categories: RECEIPT_CATEGORIES,
    item_categories: ITEM_CATEGORIES,
    // categories this user has already typed, so custom ones show up in the picker
    used_categories: db.prepare(`SELECT DISTINCT r.category FROM receipts r JOIN projects p ON p.id = r.project_id
      WHERE p.user_id = ? AND r.category != '' ORDER BY r.category COLLATE NOCASE`).all(req.user.id).map((r) => r.category),
  }));

  // vendor memory: which category / billable setting each store usually gets (receipts: yours; items: the household's)
  app.get('/api/vendors', (req, res) => {
    const rows = req.query.scope === 'items'
      ? db.prepare("SELECT vendor, category, purchase_date AS date FROM items WHERE vendor != ''").all()
      : db.prepare(`SELECT r.vendor, r.category, r.billable, r.date FROM receipts r JOIN projects p ON p.id = r.project_id
          WHERE p.user_id = ? AND r.draft = 0 AND r.vendor != ''`).all(req.user.id);
    res.json(buildVendorIndex(rows).slice(0, 500));
  });
}
