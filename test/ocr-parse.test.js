import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseReceiptText, resolveAmounts, lineAmount, findDate, detectProvince } from '../public/ocr-parse.js';

const TODAY = '2026-11-17';
const BC = { gst: 5000, pst: 7000 }, ON = { gst: 13000, pst: 0 }, AB = { gst: 5000, pst: 0 };

test('lineAmount takes the right-most money value', () => {
  assert.equal(lineAmount('SUBTOTAL            $1,234.56'), 123456);
  assert.equal(lineAmount('GST 5%   GST# 123456789RT0001   4.76'), 476);
  assert.equal(lineAmount('no money here 12'), null);
});

test('dates: ISO, named months, ambiguous slashes, never in the future', () => {
  assert.equal(findDate('2026-03-04 14:22', TODAY), '2026-03-04');
  assert.equal(findDate('MAR 5, 2026', TODAY), '2026-03-05');
  assert.equal(findDate('5 Mar 2026', TODAY), '2026-03-05');
  assert.equal(findDate('25/03/2026', TODAY), '2026-03-25');      // day first is unambiguous
  assert.equal(findDate('03/25/2026', TODAY), '2026-03-25');
  assert.equal(findDate('03/04/2026', TODAY), '2026-03-04');      // ambiguous -> month/day
  assert.equal(findDate('12/11/2026', TODAY), '2026-12-11' > TODAY ? '2026-11-12' : '2026-12-11'); // future reading rejected
  assert.equal(findDate('11/17/26', TODAY), '2026-11-17');
  assert.equal(findDate('nothing', TODAY), null);
});

test('province from postal code or name', () => {
  assert.equal(detectProvince('123 Main St, Victoria BC V8W 1N6'), 'BC');
  assert.equal(detectProvince('Toronto, ON M5V 2T6'), 'ON');
  assert.equal(detectProvince('Calgary T2P 1J9'), 'AB');
  assert.equal(detectProvince('Montréal QC H2Y 1C6'), 'QC');
  assert.equal(detectProvince('Tel 250-555-0100'), null);
});

const HOME_DEPOT = `HOME DEPOT #7011
1234 Douglas St, Victoria BC V8W 2E9
Tel 250-555-0199

03/14/2026 10:42  REG 04 TRN 1182
2x4x8 SPF STUD           12 @ 4.98     59.76
DECK SCREWS 3IN                        24.99
SUBTOTAL                               84.75
GST 5%                                  4.24
PST 7%                                  5.93
TOTAL                                  94.92
VISA                                   94.92
Thank you for shopping`;

test('hardware-store receipt: vendor, date, province, category, all amounts read', () => {
  const p = parseReceiptText(HOME_DEPOT, { today: TODAY });
  assert.equal(p.vendor, 'Home Depot');
  assert.equal(p.date, '2026-03-14');
  assert.equal(p.province, 'BC');
  assert.equal(p.category, 'Materials');
  assert.deepEqual([p.subtotal, p.gst, p.pst, p.total], [8475, 424, 593, 9492]);
  const r = resolveAmounts(p, BC);
  assert.deepEqual(r, { subtotal: 8475, gst: 424, pst: 593, tip: null, estimated: false, inferred: [] });
});

test('restaurant: tip suggestions are ignored, tip line is read', () => {
  const p = parseReceiptText(`THE KINGS PUB
Subtotal  48.00
GST       2.40
Total     50.40
Tip 15%   7.56
Tip 18%   9.07
Gratuity  8.00
Balance Due 58.40`, { today: TODAY });
  assert.equal(p.category, 'Meals');
  assert.equal(p.tip, 800);
  assert.equal(p.total, 5840);
  assert.deepEqual(resolveAmounts(p, BC), { subtotal: 4800, gst: 240, pst: 0, tip: 800, estimated: false, inferred: [] });
});

test('only a TOTAL is printed: back out subtotal and taxes from the province rates (flagged estimated)', () => {
  const p = parseReceiptText('Some Shop\nWidget 20.00\nTOTAL $22.40', { today: TODAY });
  const r = resolveAmounts(p, BC);
  assert.equal(r.estimated, true);
  assert.equal(r.subtotal, 2000);
  assert.equal(r.gst, 100);
  assert.equal(r.pst, 140);
  const on = resolveAmounts(parseReceiptText('Shop\nTOTAL 11.30', { today: TODAY }), ON);
  assert.deepEqual([on.subtotal, on.gst, on.pst], [1000, 130, 0]);
});

test('generic TAX line is split across GST/PST using the province rates', () => {
  const p = parseReceiptText('SHELL\nUnleaded 40.00 L   60.00\nTAX      7.20\nTOTAL   67.20', { today: TODAY });
  assert.equal(p.category, 'Fuel');
  const r = resolveAmounts(p, BC);
  assert.deepEqual([r.subtotal, r.gst + r.pst, r.gst], [6000, 720, 300]);
  assert.equal(r.estimated, true);
  const ab = resolveAmounts(p, AB);   // single-tax province: it is all GST
  assert.deepEqual([ab.gst, ab.pst], [720, 0]);
});

test('amount on the line below its label (OCR line breaks)', () => {
  const p = parseReceiptText('Cafe Mocha\nSUBTOTAL\n10.00\nGST\n0.50\nTOTAL\n10.50', { today: TODAY });
  assert.deepEqual([p.subtotal, p.gst, p.total], [1000, 50, 1050]);
});

test('subtotal only: taxes derived from province; missing PST inferred from the total gap', () => {
  const only = resolveAmounts(parseReceiptText('Shop\nSUBTOTAL 100.00', { today: TODAY }), BC);
  assert.deepEqual([only.gst, only.pst, only.estimated], [500, 700, true]);
  const gap = resolveAmounts(parseReceiptText('Shop\nSUBTOTAL 100.00\nGST 5.00\nTOTAL 112.00', { today: TODAY }), BC);
  assert.deepEqual([gap.gst, gap.pst, gap.estimated], [500, 700, true]);
});

test('vendor skips addresses, phones and boilerplate; empty text is safe', () => {
  assert.equal(parseReceiptText('*** RECEIPT ***\n250-555-0100\nbig bob\'s HARDWARE\nTOTAL 5.00').vendor, "big bob's HARDWARE");
  const none = parseReceiptText('');
  assert.deepEqual([none.vendor, none.date, none.total], ['', null, null]);
});

test('a garbled amount (OCR read "5M98") is recovered from the total and flagged as inferred', () => {
  const text = fs.readFileSync(new URL('./fixtures/ocr-garbled.txt', import.meta.url), 'utf8');
  const p = parseReceiptText(text, { today: TODAY });
  assert.equal(p.pst, null);                                   // the garbled line yields no amount
  const r = resolveAmounts(p, BC);
  assert.deepEqual([r.subtotal, r.gst, r.pst], [8475, 424, 593]);
  assert.deepEqual(r.inferred, ['pst']);
  assert.equal(r.estimated, true);
});
