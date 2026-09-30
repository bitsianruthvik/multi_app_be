/**
 * taxService.js — GST: the company's tax identity, HSN / rates on items, and the
 * ONE function that works tax out (CF_ERP_GST_PLAN §1–2, init.sql §37).
 *
 * RATES ARE DATA. The allowed rates are the company's list (cf_company_settings
 * .gst_rates; NULL = SEED_GST_RATES, the list as the plan seeded it) and each
 * item's own rate. No rule below names a rate — the Sept-2025 slab change proved
 * rates move.
 *
 * WHO PAYS WHICH TAX (taxLines / supplyOf):
 *   supplier state = the company's state_code; place of supply (goods) = the
 *   ship-to's state, else the customer's. Same state → CGST + SGST at half the
 *   rate each; different → IGST at the rate. A supply to an SEZ or abroad is
 *   inter-state whatever the states (IGST) and ZERO-RATED under a LUT (company
 *   lut_number set → tax 0, "Supply meant for export/SEZ under LUT"). An
 *   unregistered customer follows the same rule by state.
 *   Per line: taxable = the amount (priceService — rate × billed quantity; no
 *   discounts yet); each tax rounded to 2 dp on the line (CGST and SGST each at
 *   half the rate, so they are always equal); invoice total = Σ taxable + Σ tax,
 *   rounded to the rupee with the difference shown as its own round-off line.
 *
 * Every price in the ERP stays NET of tax; tax is computed on top, on read, for
 * sales orders and purchase orders, in bulk (a fixed number of round trips —
 * production is ~49 ms a round trip).
 */
import { invalid, assertNoProblems } from '../lib/errors.js';
import { round2 } from './priceService.js';
import {
  GST_STATES, FOREIGN_STATE, stateName, readStateCode, validateGstin,
} from '../modules/parties/gstin.js';

export { GST_STATES, FOREIGN_STATE, stateName, validateGstin };

/** The list a company starts with (the plan's seed). The company edits its own copy. */
export const SEED_GST_RATES = [0, 0.25, 3, 5, 12, 18, 28, 40];
/** Invoice numbers: <prefix>/<yy-yy>/<0001>, at most 16 characters (GST portal limit). */
export const INVOICE_NO_MAX = 16;
const PREFIX_RE = /^[A-Z0-9][A-Z0-9-]{0,4}$/;
const PIN_RE = /^[1-9]\d{5}$/;
export const LUT_NOTE = 'Supply meant for export/SEZ under LUT';

const blank = (v) => v === undefined || v === null || String(v).trim() === '';
const numOrNull = (v) => (v == null ? null : Number(v));

// --- the company's tax identity ------------------------------------------------

function parseRates(json) {
  if (json == null) return [...SEED_GST_RATES];
  const arr = typeof json === 'string' ? JSON.parse(json) : json;
  return Array.isArray(arr) ? arr.map(Number).filter(Number.isFinite).sort((a, b) => a - b) : [...SEED_GST_RATES];
}

/** The settings row shaped (no row = everything blank, the seed rates). One round trip. */
export async function companyTax(db, companyId) {
  const [[s]] = await db.query('SELECT * FROM cf_company_settings WHERE company_id = ?', [companyId]);
  return shapeCompanyTax(s ?? {});
}

function shapeCompanyTax(s) {
  return {
    legalName: s.legal_name ?? null,
    tradeName: s.trade_name ?? null,
    gstin: s.gstin ?? null,
    stateCode: s.state_code ?? null,
    stateName: stateName(s.state_code),
    address1: s.address_line1 ?? null,
    address2: s.address_line2 ?? null,
    city: s.city ?? null,
    pincode: s.pincode ?? null,
    lutNumber: s.lut_number ?? null,
    invoicePrefix: s.invoice_prefix ?? 'INV',
    einvoiceRequired: s.einvoice_required == null ? true : !!Number(s.einvoice_required),
    gstRates: parseRates(s.gst_rates),
  };
}

/** GET /settings/tax */
export const getTaxSettings = companyTax;

/**
 * PUT /settings/tax — any subset of the fields. The GSTIN is checked (mod-36)
 * and sets the state; a typed state must agree with it. gstRates replaces the
 * list (items keep a rate taken off it — the list says what may be CHOSEN).
 */
export async function putTaxSettings(db, c, input = {}) {
  const problems = [];
  const sets = {};
  const text = (key, col, max) => {
    if (input[key] === undefined) return;
    const v = blank(input[key]) ? null : String(input[key]).trim();
    if (v && v.length > max) problems.push(`${key} is up to ${max} characters.`);
    sets[col] = v;
  };
  text('legalName', 'legal_name', 255);
  text('tradeName', 'trade_name', 255);
  text('address1', 'address_line1', 255);
  text('address2', 'address_line2', 255);
  text('city', 'city', 100);
  text('lutNumber', 'lut_number', 50);
  if (input.pincode !== undefined) {
    const pin = blank(input.pincode) ? null : String(input.pincode).replace(/\s+/g, '');
    if (pin && !PIN_RE.test(pin)) problems.push('A PIN code is 6 digits.');
    sets.pincode = pin;
  }
  let typedState;
  if (input.stateCode !== undefined) {
    typedState = readStateCode(input.stateCode);
    if (typedState === undefined) problems.push(`${input.stateCode} is not a GST state code.`);
    else if (typedState === FOREIGN_STATE) problems.push('The company\'s own state is an Indian state.');
    else sets.state_code = typedState;
  }
  if (input.gstin !== undefined) {
    if (blank(input.gstin)) sets.gstin = null;
    else {
      const v = validateGstin(input.gstin);
      if (!v.valid) problems.push(`GSTIN: ${v.message}`);
      else {
        sets.gstin = v.gstin;
        if (typedState && typedState !== v.stateCode) problems.push(`The GSTIN is registered in ${v.stateName} (${v.stateCode}), not ${stateName(typedState)} — the state comes from the GSTIN.`);
        sets.state_code = v.stateCode;
      }
    }
  }
  if (input.invoicePrefix !== undefined) {
    const p = blank(input.invoicePrefix) ? 'INV' : String(input.invoicePrefix).trim().toUpperCase();
    if (!PREFIX_RE.test(p)) problems.push('Invoice prefix: 1 to 5 letters, digits or -, so the number stays within 16 characters (INV/26-27/0001).');
    sets.invoice_prefix = p;
  }
  if (input.einvoiceRequired !== undefined) sets.einvoice_required = input.einvoiceRequired ? 1 : 0;
  if (input.gstRates !== undefined) {
    const arr = Array.isArray(input.gstRates) ? input.gstRates : null;
    if (!arr) problems.push('GST rates are a list of numbers.');
    else {
      const rates = [...new Set(arr.map((r) => Number(r)))];
      if (rates.some((r) => !Number.isFinite(r) || r < 0 || r > 100 || Math.round(r * 100) !== r * 100)) problems.push('A GST rate is a percentage from 0 to 100, up to 2 decimals.');
      else if (!rates.length) problems.push('Keep at least one GST rate.');
      else sets.gst_rates = JSON.stringify(rates.sort((a, b) => a - b));
    }
  }
  assertNoProblems(problems, 'The company tax details need attention.');
  if (Object.keys(sets).length) {
    const cols = Object.keys(sets);
    await db.query(
      `INSERT INTO cf_company_settings (company_id, ${cols.join(', ')}, updated_by) VALUES (?, ${cols.map(() => '?').join(', ')}, ?)
       ON DUPLICATE KEY UPDATE ${cols.map((k) => `${k} = VALUES(${k})`).join(', ')}, updated_by = VALUES(updated_by)`,
      [c.companyId, ...Object.values(sets), c.userId ?? null],
    );
  }
  return companyTax(db, c.companyId);
}

// --- HSN / SAC and rate on an item ---------------------------------------------

/**
 * An HSN (goods: 4, 6 or 8 digits) or SAC (services: 6 digits starting 99).
 * Blank is "none yet" (null).
 */
export function readHsn(v, isService, problems) {
  if (blank(v)) return null;
  const s = String(v).replace(/\s+/g, '');
  if (!/^\d{4}(\d{2}){0,2}$/.test(s)) { problems.push('HSN code: 4, 6 or 8 digits.'); return null; }
  if (isService && !/^99\d{4}$/.test(s)) problems.push('A service takes a SAC code: 6 digits starting 99.');
  if (!isService && s.startsWith('99')) problems.push(`${s} is a service code (SAC) — tick "service" or use the goods' HSN code.`);
  return s;
}

/** A GST rate from the company's list; blank is "no rate" (null). */
export function readGstRate(v, rates, problems) {
  if (blank(v)) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) { problems.push('GST rate is a number.'); return null; }
  if (!rates.some((r) => Math.abs(r - n) < 1e-9)) { problems.push(`GST rate ${n}% is not on the company's list (${rates.join(', ')}). Add it in Setup › Company tax details first.`); return null; }
  return n;
}

/**
 * Reads hsnCode / gstRate / isService into `detail` (column names). The rate
 * list costs one round trip, only when a rate is sent.
 */
export async function readItemTax(db, companyId, input, current, detail, problems) {
  if (input.hsnCode === undefined && input.gstRate === undefined && input.isService === undefined) return;
  const isService = input.isService !== undefined ? !!input.isService : !!Number(current?.is_service ?? 0);
  if (input.isService !== undefined) detail.is_service = isService ? 1 : 0;
  if (input.hsnCode !== undefined) detail.hsn_code = readHsn(input.hsnCode, isService, problems);
  else if (input.isService !== undefined && current?.hsn_code) readHsn(current.hsn_code, isService, problems);
  if (input.gstRate !== undefined) {
    const { gstRates } = blank(input.gstRate) ? { gstRates: [] } : await companyTax(db, companyId);
    detail.gst_rate = readGstRate(input.gstRate, gstRates, problems);
  }
}

/**
 * HSN, rate and service flag per item: its own values, else its template's
 * (a custom line's root is a temporary item made from a template). ONE query.
 * Map itemId → { hsnCode, gstRate, isService }.
 */
export async function itemTaxOf(db, companyId, itemIds) {
  const ids = [...new Set(itemIds.filter((x) => x != null).map(Number))];
  const out = new Map();
  if (!ids.length) return out;
  const [rows] = await db.query(
    `SELECT i.master_id, COALESCE(i.hsn_code, d.hsn_code) AS hsn_code, COALESCE(i.gst_rate, d.gst_rate) AS gst_rate,
            GREATEST(COALESCE(i.is_service, 0), COALESCE(d.is_service, 0)) AS is_service
       FROM cf_item_details i
       LEFT JOIN cf_definition_details d ON d.master_id = i.source_definition_id AND d.deleted_at IS NULL
      WHERE i.company_id = ? AND i.master_id IN (?)`,
    [companyId, ids],
  );
  for (const r of rows) out.set(Number(r.master_id), { hsnCode: r.hsn_code ?? null, gstRate: numOrNull(r.gst_rate), isService: !!Number(r.is_service) });
  return out;
}

/**
 * Parties with their GST facts and default ship-to address — ONE query.
 * Map partyId → { id, code, name, gstin, registration, stateCode, address, city, pincode, defaultShip | null }.
 */
export async function partyTaxOf(db, companyId, partyIds) {
  const ids = [...new Set(partyIds.filter((x) => x != null).map(Number))];
  const out = new Map();
  if (!ids.length) return out;
  const [rows] = await db.query(
    `SELECT p.id, p.code, p.name, p.tax_number, p.gst_registration, p.state_code, p.address, p.city, p.pincode,
            a.id AS ship_id, a.label AS ship_label, a.address AS ship_address, a.city AS ship_city, a.pincode AS ship_pincode,
            a.state_code AS ship_state, a.gstin AS ship_gstin
       FROM cf_parties p
       LEFT JOIN cf_party_addresses a ON a.company_id = p.company_id AND a.party_id = p.id AND a.is_default_ship = 1 AND a.deleted_at IS NULL
      WHERE p.company_id = ? AND p.id IN (?)`,
    [companyId, ids],
  );
  for (const r of rows) {
    if (out.has(r.id)) continue;
    out.set(r.id, {
      id: r.id, code: r.code, name: r.name, gstin: r.tax_number ?? null, registration: r.gst_registration ?? 'regular',
      stateCode: r.state_code ?? null, address: r.address ?? null, city: r.city ?? null, pincode: r.pincode ?? null,
      defaultShip: r.ship_id ? {
        id: r.ship_id, label: r.ship_label, address: r.ship_address, city: r.ship_city, pincode: r.ship_pincode, stateCode: r.ship_state, gstin: r.ship_gstin,
      } : null,
    });
  }
  return out;
}

// --- the one tax function ------------------------------------------------------

/**
 * How a supply is taxed. input: { supplierState, placeOfSupply, registration
 * (the OTHER party's), lutNumber, direction: 'out' (we sell) | 'in' (we buy) }.
 * Returns { isIgst, zeroRated, supplyType, note, problem } — problem (a sentence)
 * when the tax cannot be worked out.
 */
export function supplyOf({ supplierState, placeOfSupply, registration = 'regular', lutNumber = null, direction = 'out' }) {
  const reg = registration ?? 'regular';
  if (direction === 'in' && (reg === 'unregistered' || reg === 'composition')) {
    return { isIgst: false, zeroRated: true, supplyType: null, note: reg === 'composition' ? 'The supplier is a composition dealer — no GST on its bill.' : 'The supplier is not registered for GST — no GST on its bill.', problem: null };
  }
  if (direction === 'in' && reg === 'overseas') {
    return { isIgst: true, zeroRated: true, supplyType: null, note: 'An import — IGST is paid at customs, not on the supplier\'s bill.', problem: null };
  }
  const ourState = direction === 'out' ? supplierState : placeOfSupply;
  if (!ourState) return { isIgst: null, zeroRated: false, supplyType: null, note: null, problem: 'The company\'s GST state is not set (Setup › Company tax details).' };
  if (direction === 'out' && (reg === 'sez' || reg === 'overseas')) {
    const lut = !blank(lutNumber);
    const base = reg === 'sez' ? 'SEZ' : 'EXP';
    return { isIgst: true, zeroRated: lut, supplyType: `${base}${lut ? 'WOP' : 'WP'}`, note: lut ? LUT_NOTE : null, problem: null };
  }
  const theirState = direction === 'out' ? placeOfSupply : supplierState;
  if (!theirState) {
    return { isIgst: null, zeroRated: false, supplyType: null, note: null, problem: direction === 'out' ? 'The customer\'s state is not known — set it on the customer or the ship-to address.' : 'The supplier\'s state is not known — set it on the supplier.' };
  }
  const supplyType = direction === 'out' ? (reg === 'unregistered' ? 'B2C' : 'B2B') : null;
  return { isIgst: String(ourState) !== String(theirState), zeroRated: false, supplyType, note: null, problem: null };
}

/** Tax on one taxable amount at a rate. CGST = SGST = round2(taxable × rate / 200) — always equal. */
export function taxOn(taxable, gstRate, supply) {
  if (taxable == null || gstRate == null || supply == null || supply.isIgst == null) return { cgst: null, sgst: null, igst: null, taxTotal: null };
  if (supply.zeroRated) return { cgst: 0, sgst: 0, igst: 0, taxTotal: 0 };
  const t = Number(taxable);
  const r = Number(gstRate);
  if (supply.isIgst) { const igst = round2((t * r) / 100); return { cgst: 0, sgst: 0, igst, taxTotal: igst }; }
  const half = round2((t * r) / 200);
  return { cgst: half, sgst: half, igst: 0, taxTotal: round2(half * 2) };
}

/**
 * taxService.taxLines — THE tax function (plan §2). lines: [{ taxable, gstRate, ... }]
 * (taxable null = no amount; gstRate null = no rate). Returns { lines (each with
 * cgst, sgst, igst, taxTotal, total), totals: { taxable, cgst, sgst, igst, tax,
 * beforeRounding, roundOff, grandTotal }, complete }.
 */
export function taxLines(lines, supply) {
  let taxable = 0; let cgst = 0; let sgst = 0; let igst = 0;
  let complete = !!supply && supply.isIgst != null;
  const out = lines.map((l) => {
    const t = taxOn(l.taxable, l.gstRate, supply);
    if (l.taxable == null || t.taxTotal == null) complete = false;
    if (l.taxable != null) taxable += Number(l.taxable);
    if (t.taxTotal != null) { cgst += t.cgst; sgst += t.sgst; igst += t.igst; }
    return { ...l, ...t, total: l.taxable == null ? null : round2(Number(l.taxable) + (t.taxTotal ?? 0)) };
  });
  const tax = round2(cgst + sgst + igst);
  const beforeRounding = round2(taxable + tax);
  const grandTotal = Math.round(beforeRounding);
  return {
    lines: out,
    totals: { taxable: round2(taxable), cgst: round2(cgst), sgst: round2(sgst), igst: round2(igst), tax, beforeRounding, roundOff: round2(grandTotal - beforeRounding), grandTotal: round2(grandTotal) },
    complete,
  };
}

// --- amount in words (Indian system) -------------------------------------------

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve',
  'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function belowHundred(n) {
  if (n < 20) return ONES[n];
  return `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ''}`;
}
function belowThousand(n) {
  const h = Math.floor(n / 100);
  const r = n % 100;
  return [h ? `${ONES[h]} Hundred` : '', r ? belowHundred(r) : ''].filter(Boolean).join(' ');
}
/** 5,68,89,502 → "Five Crore Sixty Eight Lakh Eighty Nine Thousand Five Hundred Two". */
export function indianWords(n) {
  let x = Math.floor(Math.abs(Number(n)));
  if (x === 0) return 'Zero';
  const parts = [];
  const crore = Math.floor(x / 1e7); x %= 1e7;
  const lakh = Math.floor(x / 1e5); x %= 1e5;
  const thousand = Math.floor(x / 1e3); x %= 1e3;
  if (crore) parts.push(`${indianWords(crore)} Crore`);   // above 99 crore it reads "One Hundred Crore"
  if (lakh) parts.push(`${belowHundred(lakh)} Lakh`);
  if (thousand) parts.push(`${belowHundred(thousand)} Thousand`);
  if (x) parts.push(belowThousand(x));
  return parts.join(' ');
}
/** 56889502.40 → "Rupees Five Crore Sixty Eight Lakh Eighty Nine Thousand Five Hundred Two and Forty Paise Only". */
export function amountInWords(amount) {
  const paiseTotal = Math.round(Math.abs(Number(amount)) * 100);
  const rupees = Math.floor(paiseTotal / 100);
  const paise = paiseTotal % 100;
  const sign = Number(amount) < 0 ? 'Minus ' : '';
  return `${sign}Rupees ${indianWords(rupees)}${paise ? ` and ${belowHundred(paise)} Paise` : ''} Only`;
}

// --- tax on sales orders and purchase orders (read-only, in bulk) --------------

const PROBLEM_NOTE = (p) => p.replace(/ \(Setup › Company tax details\)\.$/, '.');

/**
 * Estimated GST on sales order lines and totals. orders: rows with id,
 * customer_id, order_type; lines: rows with id, order_id, item_id; amounts:
 * Map lineId → { amount }. Three round trips whatever the size (company, items,
 * customers). Returns { lineTax: Map lineId → {...}, orderTax: Map orderId → {...} }.
 */
export async function salesOrderTax(db, companyId, orders, lines, amounts) {
  const lineTax = new Map();
  const orderTax = new Map();
  if (!orders.length) return { lineTax, orderTax };
  const [company, items, parties] = await Promise.all([
    companyTax(db, companyId),
    itemTaxOf(db, companyId, lines.map((l) => l.item_id)),
    partyTaxOf(db, companyId, orders.map((o) => o.customer_id)),
  ]);
  const byOrder = new Map(orders.map((o) => [o.id, []]));
  for (const l of lines) byOrder.get(l.order_id)?.push(l);
  for (const o of orders) {
    const cust = o.customer_id ? parties.get(o.customer_id) : null;
    const pos = cust?.registration === 'overseas' ? FOREIGN_STATE : (cust?.defaultShip?.stateCode ?? cust?.stateCode ?? null);
    const supply = o.order_type === 'stock' || !cust ? null
      : supplyOf({ supplierState: company.stateCode, placeOfSupply: pos, registration: cust.registration, lutNumber: company.lutNumber });
    const orderLines = byOrder.get(o.id) ?? [];
    const priced = orderLines.map((l) => {
      const tax = items.get(l.item_id) ?? { gstRate: null, hsnCode: null };
      return { id: l.id, taxable: amounts.get(l.id)?.amount ?? null, gstRate: tax.gstRate, hsnCode: tax.hsnCode };
    });
    const res = taxLines(priced, supply);
    for (const l of res.lines) {
      let taxNote = null;
      if (o.order_type === 'stock') taxNote = 'A stock order is not sold — no GST.';
      else if (!cust) taxNote = 'No customer on the order yet.';
      else if (supply?.problem) taxNote = PROBLEM_NOTE(supply.problem);
      else if (l.gstRate == null) taxNote = 'No GST rate on the item.';
      else if (!l.hsnCode) taxNote = 'No HSN code on the item.';
      else if (supply?.note) taxNote = supply.note;
      const t = {
        taxable: l.taxable,
        gstRate: l.gstRate,
        cgst: l.cgst, sgst: l.sgst, igst: l.igst,
        taxTotal: l.taxTotal,
        gross: l.taxable == null || l.taxTotal == null ? null : l.total,
        taxNote,
      };
      lineTax.set(l.id, t);
    }
    orderTax.set(o.id, {
      taxable: res.totals.taxable,
      cgst: res.totals.cgst, sgst: res.totals.sgst, igst: res.totals.igst,
      tax: res.totals.tax,
      gross: round2(res.totals.taxable + res.totals.tax),
      isIgst: supply?.isIgst ?? null,
      placeOfSupply: pos ? { code: pos, name: stateName(pos) } : null,
      taxComplete: res.complete,
      taxNote: supply?.problem ? PROBLEM_NOTE(supply.problem) : (supply?.note ?? null),
    });
  }
  return { lineTax, orderTax };
}

/**
 * Input GST on purchase order lines and totals. pos: rows with id, supplier_id,
 * reverse_charge; lines: rows with id, purchase_order_id, item_id, amount (net).
 * Reverse charge: the tax is shown as payable by us and left out of the
 * supplier's total (gross). Three round trips.
 */
export async function purchaseOrderTax(db, companyId, pos, lines) {
  const lineTax = new Map();
  const poTax = new Map();
  if (!pos.length) return { lineTax, poTax };
  const [company, items, parties] = await Promise.all([
    companyTax(db, companyId),
    itemTaxOf(db, companyId, lines.map((l) => l.item_id)),
    partyTaxOf(db, companyId, pos.map((p) => p.supplier_id)),
  ]);
  const byPo = new Map(pos.map((p) => [p.id, []]));
  for (const l of lines) byPo.get(l.purchase_order_id)?.push(l);
  for (const p of pos) {
    const sup = p.supplier_id ? parties.get(p.supplier_id) : null;
    const rc = !!Number(p.reverse_charge ?? 0);
    const supply = sup ? supplyOf({ supplierState: sup.stateCode, placeOfSupply: company.stateCode, registration: sup.registration, direction: 'in' }) : null;
    const res = taxLines((byPo.get(p.id) ?? []).map((l) => ({ id: l.id, taxable: l.amount, gstRate: (items.get(l.item_id) ?? {}).gstRate ?? null })), supply);
    for (const l of res.lines) {
      let taxNote = null;
      if (!sup) taxNote = 'No supplier named yet.';
      else if (supply?.problem) taxNote = PROBLEM_NOTE(supply.problem);
      else if (l.gstRate == null) taxNote = 'No GST rate on the item.';
      else if (supply?.note) taxNote = supply.note;
      else if (rc) taxNote = 'Reverse charge — the GST is paid by us, not to the supplier.';
      lineTax.set(l.id, {
        gstRate: l.gstRate,
        cgst: l.cgst, sgst: l.sgst, igst: l.igst,
        taxTotal: l.taxTotal,
        // no gross for a line whose tax could not be worked out — it would read as tax-inclusive
        gross: l.taxable == null || (!rc && l.taxTotal == null) ? null : round2(Number(l.taxable) + (rc ? 0 : l.taxTotal)),
        taxNote,
      });
    }
    poTax.set(p.id, {
      tax: res.totals.tax,
      cgst: res.totals.cgst, sgst: res.totals.sgst, igst: res.totals.igst,
      gross: res.complete ? round2(res.totals.taxable + (rc ? 0 : res.totals.tax)) : null,   // partial tax is not a total
      reverseCharge: rc,
      taxPayableByUs: rc ? res.totals.tax : 0,
      isIgst: supply?.isIgst ?? null,
      taxComplete: res.complete,
    });
  }
  return { lineTax, poTax };
}

/** The financial year (Apr–Mar) of a date 'YYYY-MM-DD': '2026-04-01' → '2026-27'. */
export function financialYear(dateText) {
  const [y, m] = String(dateText).slice(0, 10).split('-').map(Number);
  const start = m >= 4 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/** '2026-27' → '26-27' — the year as it sits inside an invoice number. */
export const fyShort = (fy) => `${fy.slice(2, 4)}-${fy.slice(5, 7)}`;

/** The invoice number for a series position; refuses one that would exceed 16 characters. */
export function invoiceNumber(prefix, fy, n) {
  const no = `${prefix}/${fyShort(fy)}/${String(n).padStart(4, '0')}`;
  if (no.length > INVOICE_NO_MAX) throw invalid('NUMBER_TOO_LONG', `Invoice number ${no} is longer than ${INVOICE_NO_MAX} characters — shorten the invoice prefix.`);
  return no;
}
