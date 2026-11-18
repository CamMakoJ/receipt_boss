// Turns raw OCR text from a receipt into form fields. Pure functions (no DOM) so they run in the
// browser and in node tests. Everything money-related is integer cents.

const MONEY = /(?:\$\s?)?(\d{1,3}(?:,\d{3})+|\d+)[.,](\d{2})(?!\d)/g;

/** Last (right-most) money amount on a line, in cents, or null. Right-most because prices are right-aligned. */
export function lineAmount(line) {
  let last = null;
  for (const m of line.matchAll(MONEY)) last = Math.round(parseFloat(m[1].replace(/,/g, '') + '.' + m[2]) * 100);
  return last;
}

const POSTAL_PROVINCE = { A: 'NL', B: 'NS', C: 'PE', E: 'NB', G: 'QC', H: 'QC', J: 'QC', K: 'ON', L: 'ON', M: 'ON', N: 'ON', P: 'ON', R: 'MB', S: 'SK', T: 'AB', V: 'BC', Y: 'YT' };
const PROVINCE_NAMES = [
  [/british\s+columbia/i, 'BC'], [/alberta/i, 'AB'], [/saskatchewan/i, 'SK'], [/manitoba/i, 'MB'], [/ontario/i, 'ON'],
  [/qu[eé]bec/i, 'QC'], [/new\s+brunswick/i, 'NB'], [/nova\s+scotia/i, 'NS'], [/prince\s+edward/i, 'PE'], [/newfoundland/i, 'NL'], [/yukon/i, 'YT'],
];

export function detectProvince(text) {
  const m = text.match(/\b([ABCEGHJKLMNPRSTVY]\d[A-Z])\s?(\d[A-Z]\d)\b/);
  if (m) return POSTAL_PROVINCE[m[1][0]] || null;
  for (const [re, code] of PROVINCE_NAMES) if (re.test(text)) return code;
  return null;
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
function validDate(y, m, d, today) {
  if (y < 100) y += 2000;
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 2000) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return null;
  const s = iso(y, m, d);
  return s > today ? null : s; // receipts are never from the future
}

/** First plausible purchase date in the text, as YYYY-MM-DD. */
export function findDate(text, today = new Date().toISOString().slice(0, 10)) {
  let m;
  if ((m = text.match(/\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/))) { const r = validDate(+m[1], +m[2], +m[3], today); if (r) return r; }
  const named = text.match(/\b(\d{1,2})[\s-]+([A-Za-z]{3,4})[a-z]*\.?,?[\s-]+(20\d{2}|\d{2})\b/) ;
  if (named && MONTHS[named[2].toLowerCase()]) { const r = validDate(+named[3], MONTHS[named[2].toLowerCase()], +named[1], today); if (r) return r; }
  const named2 = text.match(/\b([A-Za-z]{3,4})[a-z]*\.?\s+(\d{1,2}),?\s+(20\d{2})\b/);
  if (named2 && MONTHS[named2[1].toLowerCase()]) { const r = validDate(+named2[3], MONTHS[named2[1].toLowerCase()], +named2[2], today); if (r) return r; }
  for (const x of text.matchAll(/\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})\b/g)) {
    const a = +x[1], b = +x[2], y = +x[3];
    // unambiguous cases first, then assume North-American month/day, falling back to day/month
    const order = a > 12 ? [[b, a]] : b > 12 ? [[a, b]] : [[a, b], [b, a]];
    for (const [mo, da] of order) { const r = validDate(y, mo, da, today); if (r) return r; }
  }
  return null;
}

const NOT_VENDOR = /receipt|invoice|welcome|thank|customer\s+copy|merchant\s+copy|duplicate|\btel\b|phone|www\.|\.com|\b(gst|hst|pst)\b|^\s*#|order\s*#|\b(cashier|clerk|server|table|date|time|printed|sale|approved|terminal|merchant|guest)\b/i;
const titleCase = (s) => (s === s.toUpperCase() ? s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()) : s);

const ADDRESS = /^\d{1,6}\s+[A-Za-z]|\b[A-Z]\d[A-Z]\s?\d[A-Z]\d\b|,\s*[A-Z]{2}\b/i;
const STREET = /\b(street|st|avenue|ave|road|rd|drive|dr|blvd|boulevard|highway|hwy|way|crescent|cres|lane|ln|court|ct|trail|place|pl|suite|unit)\.?$/i;
const CITY_PROV = new RegExp(`,\\s*(${PROVINCE_NAMES.map(([re]) => re.source).join('|')})`, 'i');
const BUSINESS = /\b(diner|cafe|caf[eé]|restaurant|grill|pub|bar|bistro|kitchen|bakery|deli|pizza|market|mart|store|shop|pharmacy|drugs?|hardware|lumber|supply|supplies|depot|centre|center|motel|hotel|inn|lodge|garage|auto|service|ltd|inc|corp|co\b|company|enterprises?|mechanical|electric|plumbing|rentals?)\b/i;
const knownKey = (s) => String(s || '').toLowerCase().replace(/#\s*\d+/g, ' ').replace(/[^a-z0-9& ]+/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * The store name. Looks at the first dozen lines and scores them rather than taking the first plausible one:
 * logos and slogans often OCR to junk, and the street address can come before the name.
 * `known` = store names already filed by this user (checked first — a line that contains one wins).
 */
export function findVendor(lines, known = []) {
  const cands = [];
  lines.slice(0, 12).forEach((raw, idx) => {
    // drop store numbers ("#7011") and decoration before judging the line
    const line = raw.replace(/#\s*\d+/g, ' ').replace(/[|_~=*]+/g, ' ').replace(/\s+/g, ' ').trim();
    const letters = (line.match(/[A-Za-z]/g) || []).length;
    if (line.length < 3 || letters < 3 || letters / line.length < 0.6) return; // phones/prices are digit-heavy
    if (NOT_VENDOR.test(line) || ADDRESS.test(line) || CITY_PROV.test(line)) return;
    const business = BUSINESS.test(line), brand = guessCategory(line) !== '';
    if (STREET.test(line) && !business) return;
    const garbled = /[^A-Za-z0-9'’&.,\- ]/.test(line) || /(^|\s)[A-Za-z]{1,2}(\s|$)/.test(line) && !business;
    cands.push({ line, idx, business, brand, garbled });
  });

  const keys = known.map((n) => [n, knownKey(n)]).filter(([, k]) => k.length >= 4).sort((a, b) => b[1].length - a[1].length);
  for (const c of cands) {
    const k = knownKey(c.line);
    const hit = keys.find(([, nk]) => k === nk || k.includes(nk));
    if (hit) return hit[0].replace(/\s*#\s*\d+\s*$/, '').trim();
  }

  const words = (s) => (s.toLowerCase().match(/[a-z]{4,}/g) || []);
  let best = null;
  for (const c of cands) {
    const mine = words(c.line);
    const repeated = mine.some((w) => cands.some((o) => o !== c && words(o.line).includes(w)));   // a name printed twice (logo + text) is the name
    const mixed = /[a-z]/.test(c.line) && /[A-Z]/.test(c.line);
    const score = 10 - c.idx * 0.7 + (c.business ? 4 : 0) + (c.brand ? 4 : 0) + (repeated ? 2 : 0) + (mixed ? 2 : 0) - (c.garbled ? 6 : 0);
    if (!best || score > best.score) best = { ...c, score };
  }
  return best ? titleCase(best.line.slice(0, 60)) : '';
}

const CATEGORY_HINTS = [
  ['Fuel', /\b(shell|esso|petro[- ]?canada|chevron|husky|co-?op gas|mobil|pioneer|ultramar|fas gas|gas bar|fuel|diesel|unleaded|regular\s+\d)/i],
  ['Meals', /\b(restaurant|cafe|caf[eé]|coffee|pub|grill|bistro|pizza|burger|sushi|tim hortons|starbucks|mcdonald|subway|a&w|wendy|diner|kitchen|bar\s*&|brew|bakery|deli|eatery|catering)\b/i],
  ['Lodging', /\b(hotel|motel|inn\b|suites|lodge|resort|airbnb|hostel)\b/i],
  ['Parking', /\b(parking|parkade|impark|easypark|park\s*&\s*go)\b/i],
  ['Travel', /\b(airline|air canada|westjet|taxi|uber|lyft|rental car|via rail|ferry|bc ferries|greyhound)\b/i],
  ['Materials', /\b(home depot|rona|lowe'?s|home hardware|lumber|building suppl|canadian tire|hardware|timber|concrete|plumbing|electrical suppl|windsor plywood)\b/i],
  ['Tools & equipment', /\b(tool|equipment rental|princess auto|snap-?on|milwaukee|dewalt)\b/i],
  ['Office supplies', /\b(staples|office\s*(depot|max)|paper|stationery|grand\s*&\s*toy)\b/i],
  ['Phone & internet', /\b(telus|rogers|bell\b|shaw|fido|koodo|freedom mobile|virgin plus|wireless)\b/i],
];
export function guessCategory(text) {
  for (const [cat, re] of CATEGORY_HINTS) if (re.test(text)) return cat;
  return '';
}

/**
 * Pull labelled amounts out of OCR text. A label with no amount on its own line picks up an amount-only next line.
 * `tax` is a bare "TAX" line (we don't know if it is GST, PST or both).
 */
export function parseReceiptText(text, { today, known } = {}) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const out = { vendor: findVendor(lines, known), date: findDate(text || '', today), province: detectProvince(text || ''), category: '',
    subtotal: null, gst: null, pst: null, tax: null, tip: null, total: null };
  out.category = guessCategory(`${out.vendor}\n${text}`);

  const totals = [];
  lines.forEach((line, i) => {
    const l = line.toLowerCase();
    let amt = lineAmount(line);
    if (amt === null && lines[i + 1] && /^[\s$]*[\d.,]+\s*$/.test(lines[i + 1])) amt = lineAmount(lines[i + 1]);
    if (amt === null) return;
    const set = (k) => { if (out[k] === null) out[k] = amt; };

    if (/sub[\s-]?total|merchandise|items?\s+total|net\s+(amount|sales)/.test(l)) set('subtotal');
    else if (/\b(gst|hst|tps|g\.s\.t|h\.s\.t|federal\s+tax)\b/.test(l)) set('gst');
    else if (/\b(pst|qst|rst|tvq|p\.s\.t|provincial\s+tax)\b/.test(l)) set('pst');
    else if (/\b(tip|gratuity|pourboire)\b/.test(l) && !/%|suggest/.test(l)) set('tip');
    else if (/\b(sales\s+)?tax\b/.test(l) && !/total/.test(l)) set('tax');
    else if (/\b(grand\s+)?total\b|amount\s+due|balance\s+due|amt\s+due|total\s+due|amount\s+paid|\bto\s+pay\b/.test(l) && !/saving|discount|point|tax|rewards?/.test(l)) totals.push(amt);
  });
  if (totals.length) out.total = Math.max(...totals);
  return out;
}

/**
 * Combine what was read into subtotal / GST / PST / tip, deriving whatever is missing.
 * `rates` = { gst, pst } in thousandths of a percent for the receipt's province.
 * `estimated` is true when any amount was inferred rather than read, so the UI can ask the user to double-check.
 */
export function resolveAmounts(p, rates) {
  const taxOn = (sub) => ({ gst: Math.round((sub * rates.gst) / 100000), pst: Math.round((sub * rates.pst) / 100000) });
  const splitTax = (t) => {
    const den = rates.gst + rates.pst;
    const gst = den ? Math.round((t * rates.gst) / den) : t;
    return { gst, pst: t - gst };
  };
  let { subtotal, gst, pst, tip } = p;
  const inferred = new Set(); // fields worked out rather than read, so the UI can say exactly what to double-check

  if (p.tax !== null && gst === null && pst === null) { ({ gst, pst } = splitTax(p.tax)); if (rates.pst > 0) inferred.add('gst').add('pst'); }
  const haveTax = gst !== null || pst !== null;
  const tipAmt = tip ?? 0;

  if (subtotal === null && p.total !== null) {
    if (haveTax) subtotal = p.total - (gst ?? 0) - (pst ?? 0) - tipAmt;
    else { subtotal = Math.round((p.total - tipAmt) / (1 + (rates.gst + rates.pst) / 100000)); inferred.add('gst').add('pst'); }
    inferred.add('subtotal');
    if (subtotal < 0) { subtotal = null; inferred.delete('subtotal'); }
  }
  if (subtotal !== null && !haveTax) {
    if (p.total !== null && p.total - tipAmt > subtotal) ({ gst, pst } = splitTax(p.total - tipAmt - subtotal));
    else ({ gst, pst } = taxOn(subtotal));
    inferred.add('gst').add('pst');
  } else if (subtotal !== null && haveTax) {
    gst ??= 0; pst ??= 0;
    // a tax line was found but its amount was unreadable/missing and the total says there is more tax: fill the gap
    if (p.total !== null && rates.gst && rates.pst && (gst === 0 || pst === 0)) {
      const gap = p.total - tipAmt - subtotal - gst - pst;
      if (gap > 0 && gap <= subtotal * 0.2) { if (gst === 0) { gst = gap; inferred.add('gst'); } else { pst = gap; inferred.add('pst'); } }
    }
  }
  return { subtotal, gst, pst, tip, estimated: inferred.size > 0, inferred: [...inferred] };
}

/**
 * OCR text -> receipt fields for saving without a form (quick capture). Only fields that were actually found are set.
 * `provinces` is the /api/meta table ({ BC: { gst, pst, ... } }). Returns { data, estimated, inferred, total }.
 */
export function fieldsFromScan(text, provinces, defaultProvince, today, known) {
  const p = parseReceiptText(text, { today, known });
  const province = p.province && provinces[p.province] ? p.province : defaultProvince;
  const a = resolveAmounts(p, provinces[province]);
  const readTax = p.gst !== null || p.pst !== null || p.tax !== null;
  const data = { province };
  if (p.vendor) data.vendor = p.vendor;
  if (p.date) data.date = p.date;
  if (p.category) data.category = p.category;
  if (a.subtotal !== null) { data.subtotal = a.subtotal; data.gst = a.gst ?? 0; data.pst = a.pst ?? 0; data.tax_auto = !readTax; }   // taxes printed on the receipt are kept exactly
  if (a.tip !== null) data.tip = a.tip;
  return { data, estimated: a.estimated, inferred: a.inferred, total: p.total };
}
