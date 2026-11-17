import PDFDocument from 'pdfkit';
import archiver from 'archiver';
import { imageFile } from './http.js';
import { calcTax } from './tax.js';
import { total, sumReceipts, money, plain, csvCell, imageName, slug } from './util.js';

const hasImage = (r) => !!imageFile(r.image);

/**
 * Report-time tax fill-in: receipts saved with no GST/PST at all get taxes estimated from their own
 * province. Returns copies (the database is never changed) flagged with `est`.
 */
export function applyAutoTax(receipts) {
  return receipts.map((r) => {
    if (r.tax_auto || r.gst || r.pst || !r.subtotal) return r;
    const t = calcTax(r.subtotal, r.province);
    return t.gst || t.pst ? { ...r, gst: t.gst, pst: t.pst, est: true } : r;
  });
}

export function buildCsv(project, receipts) {
  const head = ['Number', 'Date', 'Project', 'Province', 'Category', 'Vendor', 'Description', 'Billable',
    'Subtotal', 'GST/HST', 'PST/QST', 'Tip', 'Total', 'Tax estimated', 'Notes', 'Image file'];
  const rows = receipts.map((r) => [
    r.number, r.date, project.name, r.province, r.category, r.vendor, r.description, r.billable ? 'Billable' : 'Non-billable',
    plain(r.subtotal), plain(r.gst), plain(r.pst), plain(r.tip), plain(total(r)), r.est ? 'Yes' : '', r.notes,
    hasImage(r) ? `receipts/${imageName(r)}` : '',
  ]);
  return '﻿' + [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n'; // BOM: Excel reads UTF-8
}

// ---------------------------------------------------------------- PDF
const COLS = [
  { key: 'number', label: '#', w: 28, align: 'left' },
  { key: 'date', label: 'Date', w: 54, align: 'left' },
  { key: 'vendor', label: 'Vendor', w: 90, align: 'left' },
  { key: 'category', label: 'Category', w: 66, align: 'left' },
  { key: 'description', label: 'Description', w: 182, align: 'left' },
  { key: 'province', label: 'Prov', w: 26, align: 'left' },
  { key: 'subtotal', label: 'Subtotal', w: 62, align: 'right' },
  { key: 'gst', label: 'GST/HST', w: 50, align: 'right' },
  { key: 'pst', label: 'PST/QST', w: 50, align: 'right' },
  { key: 'tip', label: 'Tip', w: 46, align: 'right' },
  { key: 'total', label: 'Total', w: 66, align: 'right' },
];
const NUM_KEYS = ['subtotal', 'gst', 'pst', 'tip', 'total'];
const LABEL_W = COLS.filter((c) => !NUM_KEYS.includes(c.key)).reduce((a, c) => a + c.w, 0);
const MARGIN = 36;
const INK = '#1f2937', MUTED = '#6b7280', RULE = '#d1d5db', HEAD_BG = '#eef2f7';

export function buildPdf(project, receipts, { from, to } = {}) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', layout: 'landscape', margin: MARGIN, bufferPages: true,
      info: { Title: `Receipt report - ${project.name}`, Creator: 'Receipt Boss' } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const left = MARGIN;
    const tableW = COLS.reduce((a, c) => a + c.w, 0);
    const bottom = () => doc.page.height - MARGIN - 14;
    const cellVal = (r, k) => {
      if (k === 'number') return String(r.number).padStart(3, '0');
      if (k === 'total') return money(total(r));
      if (k === 'gst' || k === 'pst') return money(r[k]) + (r.est ? '*' : '');
      if (NUM_KEYS.includes(k)) return money(r[k]);
      return r[k] || '';
    };

    function header(blankLabels = false) {
      const y = doc.y;
      doc.rect(left, y, tableW, 18).fill(HEAD_BG);
      doc.fillColor(INK).font('Helvetica-Bold').fontSize(8.5);
      let x = left;
      for (const c of COLS) {
        if (!blankLabels || NUM_KEYS.includes(c.key)) doc.text(c.label, x + 4, y + 5, { width: c.w - 8, align: c.align, lineBreak: false });
        x += c.w;
      }
      doc.y = y + 18;
    }

    function row(r) {
      doc.font('Helvetica').fontSize(8.5);
      const h = Math.max(16, ...COLS.filter((c) => c.align === 'left').map((c) =>
        doc.heightOfString(cellVal(r, c.key), { width: c.w - 8 }) + 8));
      if (doc.y + h > bottom()) { doc.addPage(); header(); }
      const y = doc.y;
      doc.fillColor(INK);
      let x = left;
      for (const c of COLS) {
        doc.text(cellVal(r, c.key), x + 4, y + 4, { width: c.w - 8, align: c.align });
        x += c.w;
      }
      doc.moveTo(left, y + h).lineTo(left + tableW, y + h).strokeColor(RULE).lineWidth(0.5).stroke();
      doc.y = y + h;
    }

    function totalsRow(label, t, bold = true) {
      if (doc.y + 20 > bottom()) doc.addPage();
      const y = doc.y;
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5).fillColor(INK);
      doc.text(label, left + 4, y + 5, { width: LABEL_W - 8, lineBreak: false });
      let x = left + LABEL_W;
      for (const k of NUM_KEYS) {
        const c = COLS.find((c) => c.key === k);
        doc.text(money(t[k]), x + 4, y + 5, { width: c.w - 8, align: 'right', lineBreak: false });
        x += c.w;
      }
      doc.moveTo(left, y + 19).lineTo(left + tableW, y + 19).strokeColor(INK).lineWidth(0.8).stroke();
      doc.y = y + 19;
    }

    function section(title, list) {
      if (doc.y + 70 > bottom()) doc.addPage();
      doc.font('Helvetica-Bold').fontSize(12).fillColor(INK).text(`${title} (${list.length})`, left, doc.y);
      doc.moveDown(0.4);
      if (!list.length) {
        doc.font('Helvetica-Oblique').fontSize(9).fillColor(MUTED).text('No receipts.');
        doc.moveDown(0.8);
        return;
      }
      header();
      list.forEach(row);
      totalsRow(`${title} total`, sumReceipts(list));
      doc.moveDown(1);
    }

    // ---- title block
    const billable = receipts.filter((r) => r.billable);
    const nonBillable = receipts.filter((r) => !r.billable);
    doc.font('Helvetica-Bold').fontSize(20).fillColor(INK).text(project.name, left, MARGIN);
    doc.font('Helvetica').fontSize(10).fillColor(MUTED);
    if (project.client) doc.text(`Client: ${project.client}`);
    const range = from || to ? `${from || 'start'} to ${to || 'present'}` : 'All dates';
    doc.text(`Period: ${range}   •   Generated ${new Date().toISOString().slice(0, 10)}   •   ${receipts.length} receipt(s)`);
    if (receipts.some((r) => r.est)) doc.text('* GST/PST estimated from the receipt province\'s standard rates (none was entered).');
    doc.moveDown(1);

    // ---- summary
    doc.font('Helvetica-Bold').fontSize(12).fillColor(INK).text('Summary', left, doc.y);
    doc.moveDown(0.4);
    header(true);
    totalsRow('Billable', sumReceipts(billable), false);
    totalsRow('Non-billable', sumReceipts(nonBillable), false);
    totalsRow('All receipts', sumReceipts(receipts), true);
    doc.moveDown(1.2);

    section('Billable', billable);
    section('Non-billable', nonBillable);

    // ---- receipt images, one per page
    for (const r of receipts) {
      doc.addPage();
      doc.font('Helvetica-Bold').fontSize(13).fillColor(INK)
        .text(`#${String(r.number).padStart(3, '0')}  ${r.description || r.vendor || ''}`, left, MARGIN);
      doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(
        [r.vendor, r.date, r.category, r.province, r.billable ? 'Billable' : 'Non-billable',
          `Subtotal ${money(r.subtotal)}`, `GST/HST ${money(r.gst)}${r.est ? '*' : ''}`, `PST/QST ${money(r.pst)}${r.est ? '*' : ''}`,
          `Tip ${money(r.tip)}`, `Total ${money(total(r))}`].filter(Boolean).join('   •   '));
      if (r.notes) doc.text(`Notes: ${r.notes}`);
      doc.moveDown(0.5);
      const top = doc.y;
      const box = { w: doc.page.width - MARGIN * 2, h: bottom() - top };
      const file = imageFile(r.image);
      if (file) {
        try { doc.image(file, left, top, { fit: [box.w, box.h], align: 'center', valign: 'top' }); }
        catch { doc.fillColor(MUTED).text('(image could not be embedded)'); }
      } else {
        doc.fillColor(MUTED).font('Helvetica-Oblique').text('(no image attached)');
      }
    }

    // ---- footer page numbers
    const pages = doc.bufferedPageRange();
    for (let i = 0; i < pages.count; i++) {
      doc.switchToPage(i);
      doc.page.margins.bottom = 0; // footer sits inside the bottom margin; avoid auto page-break
      doc.font('Helvetica').fontSize(8).fillColor(MUTED)
        .text(`${project.name}  —  page ${i + 1} of ${pages.count}`, MARGIN, doc.page.height - MARGIN - 4,
          { width: doc.page.width - MARGIN * 2, align: 'center', lineBreak: false });
    }
    doc.end();
  });
}

// ---------------------------------------------------------------- ZIP
export async function streamZip(res, project, receipts, opts) {
  const base = `${slug(project.name) || 'project'}_receipts`;
  const pdf = await buildPdf(project, receipts, opts);
  const zip = archiver('zip', { zlib: { level: 6 } });
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${base}.zip"`);
  zip.on('error', (e) => res.destroy(e));
  zip.pipe(res);
  zip.append(pdf, { name: `${base}/report.pdf` });
  zip.append(buildCsv(project, receipts), { name: `${base}/report.csv` });
  for (const r of receipts) {
    const file = imageFile(r.image);
    if (file) zip.file(file, { name: `${base}/receipts/${imageName(r)}` });
  }
  await zip.finalize();
}
