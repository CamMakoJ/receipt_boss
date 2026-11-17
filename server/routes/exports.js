import { str, dateStr, wrap } from '../http.js';
import { slug } from '../util.js';
import { photosMap } from '../photos.js';
import { buildPdf, buildCsv, streamZip, applyAutoTax } from '../export.js';
import { BILLING, getProject, projectReceipts } from '../domain.js';

export function registerExports(app) {
  // ?autotax=0 turns off report-time GST/PST estimation; ?only=billable drops non-billable receipts;
  // ?billing=unbilled|invoiced|paid and ?invoice=REF narrow the billable ones; ?from= / ?to= bound the dates.
  const exportData = (req) => {
    const p = getProject(req.params.id, req.user);
    const q = (k) => (typeof req.query[k] === 'string' ? req.query[k] : '');
    const from = q('from') ? dateStr(q('from')) : undefined, to = q('to') ? dateStr(q('to')) : undefined;
    const only = q('only') === 'billable', billing = BILLING.includes(q('billing')) ? q('billing') : 'all', invoice = str(q('invoice'), 60);
    let receipts = projectReceipts(p.id, from, to)
      .filter((r) => (r.billable ? (billing === 'all' || r.billing_status === billing) && (!invoice || r.invoice_ref === invoice) : !only));
    const fm = photosMap('receipt', receipts.map((r) => r.id));
    receipts = receipts.map((r) => ({ ...r, files: (fm[r.id] || []).map((x) => x.file) }));
    if (q('autotax') !== '0') receipts = applyAutoTax(receipts);
    return { p, from, to, invoice, receipts };
  };
  const fileName = (p, ext) => `${slug(p.name) || 'project'}_report.${ext}`;

  app.get('/api/projects/:id/export.zip', wrap(async (req, res) => {
    const { p, from, to, invoice, receipts } = exportData(req);
    await streamZip(res, p, receipts, { from, to, invoice });
  }));
  app.get('/api/projects/:id/report.pdf', wrap(async (req, res) => {
    const { p, from, to, invoice, receipts } = exportData(req);
    const pdf = await buildPdf(p, receipts, { from, to, invoice });
    res.setHeader('Content-Disposition', `attachment; filename="${fileName(p, 'pdf')}"`);
    res.type('application/pdf').send(pdf);
  }));
  app.get('/api/projects/:id/report.csv', (req, res) => {
    const { p, receipts } = exportData(req);
    res.setHeader('Content-Disposition', `attachment; filename="${fileName(p, 'csv')}"`);
    res.type('text/csv; charset=utf-8').send(buildCsv(p, receipts));
  });
}
