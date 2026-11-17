import PDFDocument from 'pdfkit';
import archiver from 'archiver';
import fs from 'node:fs';
import path from 'node:path';
import { IMAGE_DIR } from './db.js';
import { total, sumReceipts, money, plain, csvCell, imageName, slug } from './util.js';

const imagePath = (r) => (r.image ? path.join(IMAGE_DIR, r.image) : null);
const hasImage = (r) => { const p = imagePath(r); return p && fs.existsSync(p); };

export function buildCsv(project, receipts) {
  const head = ['Number', 'Date', 'Project', 'Vendor', 'Description', 'Billable',
    'Subtotal', 'GST', 'PST', 'Tip', 'Total', 'Notes', 'Image file'];
  const rows = receipts.map((r) => [
    r.number, r.date, project.name, r.vendor, r.description, r.billable ? 'Billable' : 'Non-billable',
    plain(r.subtotal), plain(r.gst), plain(r.pst), plain(r.tip), plain(total(r)), r.notes,
    hasImage(r) ? `receipts/${imageName(r)}` : '',
  ]);
  // BOM so Excel opens it as UTF-8
  return '﻿' + [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

// ---------------------------------------------------------------- PDF

const COLS = [
  { key: 'number', label: '#', w: 30, align: 'left' },
  { key: 'date', label: 'Date', w: 58, align: 'left' },
  { key: 'vendor', label: 'Vendor', w: 110, align: 'left' },
  { key: 'description', label: 'Description', w: 216, align: 'left' },
  { key: 'subtotal', label: 'Subtotal', w: 64, align: 'right' },
  { key: 'gst', label: 'GST', w: 54, align: 'right' },
  { key: 'pst', label: 'PST', w: 54, align: 'right' },
  { key: 'tip', label: 'Tip', w: 54, align: 'right' },
  { key: 'total', label: 'Total', w: 70, align: 'right' },
];
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
      if (['subtotal', 'gst', 'pst', 'tip'].includes(k)) return money(r[k]);
      return r[k] || '';
    };

    function header(cols) {
      const y = doc.y;
      doc.rect(left, y, tableW, 18).fill(HEAD_BG);
      doc.fillColor(INK).font('Helvetica-Bold').fontSize(8.5);
      let x = left;
      for (const c of cols) {
        doc.text(c.label, x + 4, y + 5, { width: c.w - 8, align: c.align, lineBreak: false });
        x += c.w;
      }
      doc.y = y + 18;
    }

    function row(r, cols) {
      doc.font('Helvetica').fontSize(8.5);
      const h = Math.max(16, ...cols.filter((c) => c.align === 'left').map((c) =>
        doc.heightOfString(cellVal(r, c.key), { width: c.w - 8 }) + 8));
      if (doc.y + h > bottom()) { doc.addPage(); header(cols); }
      const y = doc.y;
      doc.fillColor(INK);
      let x = left;
      for (const c of cols) {
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
      const labelW = COLS.slice(0, 4).reduce((a, c) => a + c.w, 0);
      doc.text(label, left + 4, y + 5, { width: labelW - 8, lineBreak: false });
      let x = left + labelW;
      for (const k of ['subtotal', 'gst', 'pst', 'tip', 'total']) {
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
      header(COLS);
      list.forEach((r) => row(r, COLS));
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
    doc.moveDown(1);

    // ---- summary
    doc.font('Helvetica-Bold').fontSize(12).fillColor(INK).text('Summary', left, doc.y);
    doc.moveDown(0.4);
    header(COLS.map((c, i) => (i < 4 ? { ...c, label: '' } : c)));
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
        [r.vendor, r.date, r.billable ? 'Billable' : 'Non-billable',
          `Subtotal ${money(r.subtotal)}`, `GST ${money(r.gst)}`, `PST ${money(r.pst)}`,
          `Tip ${money(r.tip)}`, `Total ${money(total(r))}`].filter(Boolean).join('   •   '));
      if (r.notes) doc.text(`Notes: ${r.notes}`);
      doc.moveDown(0.5);
      const top = doc.y;
      const box = { w: doc.page.width - MARGIN * 2, h: bottom() - top };
      if (hasImage(r)) {
        try {
          doc.image(imagePath(r), left, top, { fit: [box.w, box.h], align: 'center', valign: 'top' });
        } catch {
          doc.fillColor(MUTED).text('(image could not be embedded)');
        }
      } else {
        doc.fillColor(MUTED).font('Helvetica-Oblique').text('(no image attached)');
      }
    }

    // ---- footer page numbers
    const range2 = doc.bufferedPageRange();
    for (let i = 0; i < range2.count; i++) {
      doc.switchToPage(i);
      doc.page.margins.bottom = 0; // footer sits inside the bottom margin; avoid auto page-break
      doc.font('Helvetica').fontSize(8).fillColor(MUTED)
        .text(`${project.name}  —  page ${i + 1} of ${range2.count}`, MARGIN, doc.page.height - MARGIN - 4,
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
    if (hasImage(r)) zip.file(imagePath(r), { name: `${base}/receipts/${imageName(r)}` });
  }
  await zip.finalize();
}
