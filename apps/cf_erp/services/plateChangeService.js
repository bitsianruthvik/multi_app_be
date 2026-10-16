/**
 * plateChangeService.js — CF_ERP. PLATE CHANGES AFTER A PURCHASE ORDER, approved by the MD (init.sql §62,
 * 2026-10-16; contract TM/CF_ERP_NESTING_V2.md "Plate changes after a PO").
 *
 * THE RULE (user, not to reopen). Once ANY purchase-order share covers a line — a cf_purchase_line_orders row
 * for one of the line's requisition lines, on a PO that is not cancelled — every change to the line's plates is
 * a CHANGE REQUEST instead of a save. Before a PO exists a change goes through as it always did (the screen
 * may still ask for the before / after: `impact: true`). The changes covered, by `kind`:
 *   accept         POST …/nesting/accept              our nesting saved (a re-nest)
 *   compare        POST …/nesting/compare/accept      side "auto" only — "uploaded" keeps the plates
 *   upload         POST …/nesting/files               a save (not the preview)
 *   sheet          POST …/nesting/sheet               a save (the retired Excel sheet; still an API)
 *   delete_lot     DELETE …/nesting/lots/:lotId       one plate off the line
 *   choices        PUT …/nesting/choices              pieces left out / plates excluded ("can't get this plate")
 *   nest_plates    PUT …/nesting/plates               standard plates only / any
 *   untracked      POST …/nesting/untracked           marking pieces as cut from untracked offcuts — a request
 *   untracked_undo DELETE …/nesting/untracked         ONLY when it changes what plates the line needs (it seldom does)
 *
 * HOW A REQUEST IS MADE. The action is run for real inside a SAVEPOINT, the line is measured before and after,
 * and the savepoint is rolled back: the impact sheet is exactly what the save would do, worked out by the code
 * that will do it. What replays the action (the body, its files kept in cf_plate_change_files) is stored with
 * the hash of the line's plates and buying at that moment (`base_hash`).
 *
 * WHILE A REQUEST IS PENDING the line is HELD: every other plate write on it is refused, in a sentence that
 * names the request. If the line's saved plates or its buying change underneath anyway (a receipt, a PO edit, a
 * release), the hash moves and the request is STALE: it cannot be approved, only withdrawn and asked again.
 *
 * APPROVAL (cf_erp_plate_change_approve; not one's own request unless admin, as §39) runs in ONE transaction:
 * the hash is checked, the action is replayed exactly as it was asked, the line's requisition is brought up to
 * the new need (requisitionService.syncRequisitionOfLine), and a BUYER CHECKLIST is written: per material, what
 * is on which PO (ordered / received), held, the new need, and the purchase-order changes to make by hand.
 * No purchase order is edited here (that is a later step).
 *
 * ROUND TRIPS. The gate on a line with no PO: 2 reads (a request holding it? a PO covering it?) on top of the
 * action. A request: + the measures (savedLotsOf, drawings, rates, need — fixed) twice and 3–5 writes.
 * Lists read a fixed number of statements for any number of lines.
 */
import crypto from 'node:crypto';
import { CfError, invalid, notFound, conflict } from '../lib/errors.js';
import { insertRows } from '../lib/db.js';
import { requireLine, lineHead, kgOf, acceptNesting, saveNestingChoices, setNestPlates } from './nestingService.js';
import { measureSavedLine, acceptCompare } from './nestCompareService.js';
import { uploadNestFiles, deleteNestLot } from './nestDxfImportService.js';
import { importSheet } from './nestingSheetService.js';
import { markUntracked, unmarkUntracked } from './nestUntrackedService.js';
import { plateRatesPerKg } from './valuationService.js';
import { openLines, lineNeeds } from './materialReadyService.js';
import { syncRequisitionOfLine } from './requisitionService.js';

const EPS = 1e-6;
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const r3 = (n) => Math.round((Number(n) + Number.EPSILON) * 1000) / 1000;
const r6 = (n) => Math.round((Number(n) + Number.EPSILON) * 1e6) / 1e6;
const fmt = (n) => String(Number(Number(n).toFixed(3)));
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const blank = (v) => v === undefined || v === null || String(v).trim() === '';
const truthy = (v) => v === true || v === 'true' || v === 1 || v === '1';
const parseJson = (v) => { if (v == null) return null; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return null; } };
const forbidden = (message) => new CfError(403, 'FORBIDDEN', message);
const money = (v) => `₹${Math.round(Math.abs(Number(v))).toLocaleString('en-IN')}`;
const MAX_REASON = 1000;

export const PLATE_CHANGE_APPROVE = 'cf_erp_plate_change_approve';

/** The kinds of change, in the words the screens use. */
export const KINDS = Object.freeze({
  accept: { label: 'Save a new nesting' },
  compare: { label: 'Take our automatic nesting' },
  upload: { label: 'Save nesting files' },
  sheet: { label: 'Save the nesting sheet' },
  delete_lot: { label: 'Take a plate off' },
  choices: { label: 'Change what nesting may use' },
  nest_plates: { label: 'Change which plates nesting may use' },
  untracked: { label: 'Mark pieces as cut from offcuts' },
  untracked_undo: { label: 'Undo pieces cut from offcuts' },
});

export const STATUS_LABEL = Object.freeze({
  pending: 'Waiting for approval',
  stale: 'Out of date',
  approved: 'Approved — buyer to act',
  applied: 'Done',
  rejected: 'Rejected',
  withdrawn: 'Withdrawn',
});
const HOLDING = ['pending', 'stale'];

/** The action each kind replays — the very function the route calls. */
const RUNNERS = {
  accept: (db, c, lineId, body) => acceptNesting(db, c, lineId, body),
  compare: (db, c, lineId, body) => acceptCompare(db, c, lineId, body),
  upload: (db, c, lineId, body) => uploadNestFiles(db, c, lineId, body),
  sheet: (db, c, lineId, body) => importSheet(db, c, lineId, body),
  delete_lot: (db, c, lineId, body) => deleteNestLot(db, c, lineId, Number(body.lotId)),
  choices: (db, c, lineId, body) => saveNestingChoices(db, c, lineId, body),
  nest_plates: (db, c, lineId, body) => setNestPlates(db, c, lineId, body),
  untracked: (db, c, lineId, body) => markUntracked(db, c, lineId, body),
  untracked_undo: (db, c, lineId, body) => unmarkUntracked(db, c, lineId, body),
};

/** True when the call writes nothing (a preview) — it is never held and never becomes a request. */
export function isPreview(kind, body = {}) {
  if (kind === 'upload') return body.dryRun === undefined ? true : truthy(body.dryRun);
  if (kind === 'sheet') return truthy(body.dryRun);
  if (kind === 'untracked') return body.dryRun === true;
  // "uploaded" keeps the plates that are saved: no plate changes.
  if (kind === 'compare') return String(body.side ?? '').toLowerCase() !== 'auto';
  return false;
}

/* ───────────────────────────── the line's state, set-based ───────────────────────────── */

/**
 * For each line: its saved plates (lot, plate, pieces), nesting choices, plate setting, untracked marks and
 * its buying (PO shares and holds of its requisition lines), and the SHA-256 of all of it. 6 reads in
 * parallel for any number of lines.
 */
export async function lineStates(db, companyId, lineIds) {
  const ids = [...new Set((lineIds ?? []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  const out = new Map();
  if (!ids.length) return out;
  const [[lots], [excl], [marks], [lines], [shares], [holds]] = await Promise.all([
    db.query(
      `SELECT l.order_line_id, l.id, l.plate_item_id, l.lot_no, COUNT(p.id) AS pieces
         FROM cf_plate_lots l
         LEFT JOIN cf_nest_placements p ON p.company_id = l.company_id AND p.plate_lot_id = l.id AND p.deleted_at IS NULL
        WHERE l.company_id = ? AND l.order_line_id IN (?) AND l.deleted_at IS NULL AND l.kind = 'plate'
        GROUP BY l.order_line_id, l.id, l.plate_item_id, l.lot_no
        ORDER BY l.id`,
      [companyId, ids],
    ),
    db.query('SELECT order_line_id, kind, item_id FROM cf_nest_exclusions WHERE company_id = ? AND order_line_id IN (?) ORDER BY order_line_id, kind, item_id', [companyId, ids]),
    db.query('SELECT order_line_id, cut_plate_id, quantity FROM cf_nest_untracked WHERE company_id = ? AND order_line_id IN (?) AND deleted_at IS NULL AND quantity > 0 ORDER BY order_line_id, cut_plate_id', [companyId, ids]),
    db.query('SELECT id, nest_plates FROM cf_sales_order_lines WHERE company_id = ? AND id IN (?)', [companyId, ids]),
    db.query(
      `SELECT pl.order_line_id, a.id, a.pr_line_id, a.quantity, a.qty_received, pl.item_id, m.code AS item_code, m.name AS item_name,
              COALESCE(pl.uom, l2.uom) AS uom, l2.id AS po_line_id, l2.quantity AS po_line_qty, l2.qty_received AS po_line_received,
              p.id AS po_id, p.code AS po_code, p.status AS po_status
         FROM cf_purchase_line_orders a
         JOIN cf_requisition_lines pl ON pl.company_id = a.company_id AND pl.id = a.pr_line_id AND pl.deleted_at IS NULL
         JOIN cf_purchase_order_lines l2 ON l2.id = a.purchase_line_id AND l2.deleted_at IS NULL
         JOIN cf_purchase_orders p ON p.id = l2.purchase_order_id AND p.deleted_at IS NULL
         JOIN cf_master_records m ON m.id = pl.item_id
        WHERE a.company_id = ? AND pl.order_line_id IN (?) AND a.deleted_at IS NULL
        ORDER BY a.id`,
      [companyId, ids],
    ),
    db.query(
      `SELECT pl.order_line_id, v.id, v.pr_line_id, v.quantity, pl.item_id
         FROM cf_stock_reservations v
         JOIN cf_requisition_lines pl ON pl.company_id = v.company_id AND pl.id = v.pr_line_id AND pl.deleted_at IS NULL
        WHERE v.company_id = ? AND pl.order_line_id IN (?) AND v.status = 'active' AND v.deleted_at IS NULL
        ORDER BY v.id`,
      [companyId, ids],
    ),
  ]);
  for (const id of ids) out.set(id, { lots: [], excluded: { plates: [], cutPlates: [] }, marks: [], nestPlates: null, shares: [], holds: [] });
  for (const r of lots) out.get(Number(r.order_line_id))?.lots.push({ id: Number(r.id), plateItemId: Number(r.plate_item_id), lotNo: r.lot_no, pieces: Number(r.pieces) });
  for (const r of excl) out.get(Number(r.order_line_id))?.excluded[r.kind === 'plate' ? 'plates' : 'cutPlates'].push(Number(r.item_id));
  for (const r of marks) out.get(Number(r.order_line_id))?.marks.push({ cutPlateId: Number(r.cut_plate_id), qty: Number(r.quantity) });
  for (const r of lines) { const s = out.get(Number(r.id)); if (s) s.nestPlates = r.nest_plates ?? null; }
  for (const r of shares) {
    out.get(Number(r.order_line_id))?.shares.push({
      id: Number(r.id), prLineId: Number(r.pr_line_id), itemId: Number(r.item_id), itemCode: r.item_code, itemName: r.item_name, uom: r.uom ?? null,
      quantity: Number(r.quantity), received: Number(r.qty_received), purchaseLineId: Number(r.po_line_id),
      lineQuantity: Number(r.po_line_qty), lineReceived: Number(r.po_line_received),
      po: { id: Number(r.po_id), code: r.po_code, status: r.po_status },
    });
  }
  for (const r of holds) out.get(Number(r.order_line_id))?.holds.push({ id: Number(r.id), prLineId: Number(r.pr_line_id), itemId: Number(r.item_id), quantity: Number(r.quantity) });
  for (const [, s] of out) {
    s.covering = s.shares.filter((x) => x.po.status !== 'cancelled');
    s.hash = crypto.createHash('sha256').update(JSON.stringify([
      s.lots.map((l) => [l.id, l.plateItemId, l.lotNo, l.pieces]),
      [s.excluded.plates, s.excluded.cutPlates], s.marks.map((m) => [m.cutPlateId, m.qty]), s.nestPlates,
      s.shares.map((x) => [x.id, x.quantity, x.received, x.purchaseLineId, x.lineQuantity, x.lineReceived, x.po.status]),
      s.holds.map((h) => [h.id, h.quantity]),
    ])).digest('hex');
  }
  return out;
}

/** The purchase orders covering ONE line (not cancelled), once each — the gate's question, in one read. */
async function coveringPos(db, companyId, lineId) {
  const [rows] = await db.query(
    `SELECT DISTINCT p.id, p.code, p.status
       FROM cf_purchase_line_orders a
       JOIN cf_requisition_lines pl ON pl.company_id = a.company_id AND pl.id = a.pr_line_id AND pl.deleted_at IS NULL
       JOIN cf_purchase_order_lines l2 ON l2.id = a.purchase_line_id AND l2.deleted_at IS NULL
       JOIN cf_purchase_orders p ON p.id = l2.purchase_order_id AND p.deleted_at IS NULL
      WHERE a.company_id = ? AND pl.order_line_id = ? AND a.deleted_at IS NULL AND p.status <> 'cancelled'
      ORDER BY p.id`,
    [companyId, Number(lineId)],
  );
  return rows.map((x) => ({ id: Number(x.id), code: x.code, status: x.status }));
}

/** The purchase orders covering a line, once each. */
const posOf = (state) => {
  const m = new Map();
  for (const s of state?.covering ?? []) if (!m.has(s.po.id)) m.set(s.po.id, { id: s.po.id, code: s.po.code, status: s.po.status });
  return [...m.values()];
};

/* ───────────────────────────── measuring ───────────────────────────── */

/**
 * What one plate of each size costs, by the order's own plate rule: valuationService.plateRatesPerKg (average
 * cost, else last receipt, else the last price paid, else the list price — per kg) × the plate's kg. A plate
 * with none has NO price (unit null): the total is then "not costed", never 0.
 */
async function platePrices(db, companyId, nests) {
  const out = new Map();
  const ids = [...new Set(nests.map((n) => Number(n.plateItemId)))];
  if (!ids.length) return out;
  const rates = await plateRatesPerKg(db, companyId, ids);
  for (const id of ids) {
    const r = rates.get(id);
    const n = nests.find((x) => Number(x.plateItemId) === id);
    const kgEach = n ? kgOf(n.length * n.width, n.thickness, n.density) : 0;
    out.set(id, r && kgEach > 0 ? { unit: r2(r.perKg * kgEach), basis: r.basis, perKg: r.perKg } : { unit: null });
  }
  return out;
}

/** The line's need per material (lineNeeds: a frozen line's planned material, one plate per lot). */
async function needOf(db, companyId, line) {
  const lines = (await openLines(db, companyId, { orderIds: [line.order_id] })).filter((l) => Number(l.id) === Number(line.id));
  if (!lines.length) return { known: false, items: new Map() };
  const n = (await lineNeeds(db, companyId, lines)).get(Number(line.id));
  return { known: !!n?.known, items: n?.items ?? new Map() };
}

/** The plates saved, per catalog plate: code, size, how many and their kg. */
function platesOf(saved) {
  const m = new Map();
  for (const l of saved) {
    const k = Number(l.plateItemId);
    const e = m.get(k) ?? { plateItemId: k, code: l.plateCode ?? `#${k}`, name: l.plateName ?? null, thickness: l.thickness, length: l.length, width: l.width, grade: l.grade ?? null, count: 0, kg: 0, customer: 0 };
    e.count += 1;
    e.kg = r3(e.kg + kgOf(l.length * l.width, l.thickness, l.density));
    if (l.ownerPartyId) e.customer += 1;
    m.set(k, e);
  }
  return [...m.values()].sort((a, b) => a.thickness - b.thickness || String(a.code).localeCompare(String(b.code)));
}

/** Everything the impact sheet and the checklist read about a line at one moment. */
async function snapshot(db, companyId, lineId, { state = null } = {}) {
  const st = state ?? (await lineStates(db, companyId, [lineId])).get(Number(lineId));
  const m = await measureSavedLine(db, companyId, lineId, { costsOf: (nests) => platePrices(db, companyId, nests) });
  const need = await needOf(db, companyId, m.ctx.line);
  const mt = m.metrics;
  return {
    hash: st.hash, state: st, line: m.ctx.line, cutPlates: m.ctx.cutPlates, saved: m.saved,
    plates: platesOf(m.saved),
    metrics: {
      plates: mt.plates, pieces: mt.pieces, tonnesBought: mt.tonnesBought, partsTonnes: mt.partsTonnes,
      // Offcuts count as waste (the user, 2026-10-14): everything bought that is not a part.
      wasteKg: mt.wasteKgTotal, wastePct: mt.wastePct, offcutKg: mt.offcuts.kg, offcuts: mt.offcuts.count,
      cost: { value: mt.cost.value, basis: mt.cost.basis ?? null, reason: mt.cost.reason ?? null },
    },
    need,
  };
}

/** Item names for the plates a choice names (one read). */
async function codesOf(db, companyId, ids) {
  const m = new Map();
  if (!ids.length) return m;
  const [rows] = await db.query('SELECT id, code, name FROM cf_master_records WHERE company_id = ? AND id IN (?)', [companyId, ids]);
  for (const r of rows) m.set(Number(r.id), r.code ?? r.name ?? `#${r.id}`);
  return m;
}

/* ───────────────────────────── the impact sheet ───────────────────────────── */

const sizeWords = (p) => `${fmt(p.thickness)} mm × ${fmt(p.length)} × ${fmt(p.width)}`;

function platesDiff(before, after) {
  const b = new Map(before.map((p) => [p.plateItemId, p]));
  const a = new Map(after.map((p) => [p.plateItemId, p]));
  const added = []; const removed = []; const changed = [];
  for (const [id, p] of a) {
    const was = b.get(id);
    if (!was) added.push({ ...p, from: 0, to: p.count });
    else if (was.count !== p.count) changed.push({ ...p, from: was.count, to: p.count });
  }
  for (const [id, p] of b) if (!a.has(id)) removed.push({ ...p, from: p.count, to: 0 });
  return { added, removed, changed, same: !added.length && !removed.length && !changed.length };
}

function deltaOf(b, a) {
  const d = (x, y) => (x == null || y == null ? null : r3(y - x));
  const costReason = a.cost.value == null ? a.cost.reason : b.cost.value == null ? b.cost.reason : null;
  return {
    plates: a.plates - b.plates, pieces: a.pieces - b.pieces,
    tonnesBought: d(b.tonnesBought, a.tonnesBought), partsTonnes: d(b.partsTonnes, a.partsTonnes),
    wasteKg: d(b.wasteKg, a.wasteKg), wastePct: d(b.wastePct, a.wastePct), offcutKg: d(b.offcutKg, a.offcutKg),
    cost: a.cost.value == null || b.cost.value == null ? null : r2(a.cost.value - b.cost.value),
    ...(costReason ? { costReason } : {}),
  };
}

/** Per material: the need before and after, and what is ordered / received / held for the line. */
function buyingOf(state, needBefore, needAfter, plateIds) {
  const ids = new Set([...needBefore.items.keys(), ...needAfter.items.keys(), ...state.covering.map((s) => s.itemId), ...state.holds.map((h) => h.itemId)]);
  const items = [];
  for (const id of ids) {
    const b = needBefore.items.get(id); const a = needAfter.items.get(id);
    const shares = state.covering.filter((s) => s.itemId === id);
    const held = r6(state.holds.filter((h) => h.itemId === id).reduce((t, h) => t + h.quantity, 0));
    const nb = r6(b?.need ?? 0); const na = r6(a?.need ?? 0);
    if (!shares.length && !held && Math.abs(nb - na) <= EPS) continue;
    const item = a?.item ?? b?.item ?? { id, code: shares[0]?.itemCode ?? null, name: shares[0]?.itemName ?? null, uom: shares[0]?.uom ?? null };
    items.push({
      itemId: id, code: item.code ?? null, name: item.name ?? null, uom: item.uom ?? shares[0]?.uom ?? null, plate: plateIds.has(id),
      needBefore: nb, needAfter: na, change: r6(na - nb),
      ordered: r6(shares.reduce((t, s) => t + s.quantity, 0)), received: r6(shares.reduce((t, s) => t + s.received, 0)), held,
      onOrder: shares.map((s) => ({ poId: s.po.id, poCode: s.po.code, status: s.po.status, purchaseLineId: s.purchaseLineId, quantity: s.quantity, received: s.received })),
    });
  }
  return items.sort((x, y) => Number(y.plate) - Number(x.plate) || String(x.code).localeCompare(String(y.code)));
}

/** "2 plates more · 1.240 t more steel · ₹96,800 more · waste 18.2% → 21.0%". */
function sentenceOf(kind, before, after, plates, delta, extra) {
  const bits = [];
  if (plates.same) bits.push('The saved plates do not change.');
  else {
    const say = [];
    if (delta.plates) say.push(`${plural(Math.abs(delta.plates), 'plate')} ${delta.plates > 0 ? 'more' : 'fewer'}`);
    else say.push('the same number of plates');
    if (delta.tonnesBought && Math.abs(delta.tonnesBought) >= 0.0005) say.push(`${Math.abs(delta.tonnesBought).toFixed(3)} t ${delta.tonnesBought > 0 ? 'more' : 'less'} steel`);
    if (delta.cost != null && Math.abs(delta.cost) >= 0.5) say.push(`${money(delta.cost)} ${delta.cost > 0 ? 'more' : 'less'}`);
    else if (delta.cost == null) say.push('not costed');
    bits.push(`${say.join(' · ')}.`.replace(/^./, (ch) => ch.toUpperCase()));
    if (before.wastePct != null && after.wastePct != null && Math.abs(after.wastePct - before.wastePct) >= 0.05) bits.push(`Waste ${before.wastePct.toFixed(1)}% → ${after.wastePct.toFixed(1)}%.`);
  }
  if (extra) bits.push(extra);
  return bits.join(' ');
}

/** What a choices / plate-setting change changes, in words (the saved plates do not move with it). */
async function choiceWords(db, companyId, kind, before, after) {
  if (kind === 'nest_plates') {
    const w = (v) => (v === 'standard' ? 'standard plates only' : 'standard and custom plates');
    return { from: before.state.nestPlates, to: after.state.nestPlates, text: `Nesting may use ${w(after.state.nestPlates)} (it was ${w(before.state.nestPlates)}). The saved plates stay as they are until a new nesting is saved — that is its own request.` };
  }
  if (kind !== 'choices') return null;
  const bp = new Set(before.state.excluded.plates); const ap = new Set(after.state.excluded.plates);
  const bc = new Set(before.state.excluded.cutPlates); const ac = new Set(after.state.excluded.cutPlates);
  const out = [...ap].filter((x) => !bp.has(x)); const back = [...bp].filter((x) => !ap.has(x));
  const leftOut = [...ac].filter((x) => !bc.has(x)); const tickedIn = [...bc].filter((x) => !ac.has(x));
  const names = await codesOf(db, companyId, [...out, ...back]);
  const said = [];
  if (out.length) said.push(`Not to be used: ${out.map((id) => names.get(id)).join(', ')}.`);
  if (back.length) said.push(`May be used again: ${back.map((id) => names.get(id)).join(', ')}.`);
  if (leftOut.length) said.push(`${plural(leftOut.length, 'cut piece')} left out of nesting.`);
  if (tickedIn.length) said.push(`${plural(tickedIn.length, 'cut piece')} back in nesting.`);
  said.push('The saved plates stay as they are until a new nesting is saved — that is its own request.');
  return {
    platesExcluded: out.map((id) => ({ id, code: names.get(id) })), platesBack: back.map((id) => ({ id, code: names.get(id) })),
    cutPiecesLeftOut: leftOut.length, cutPiecesBack: tickedIn.length, text: said.join(' '),
  };
}

/** The impact sheet: stored on the request as it was worked out, and shown to the requester and the MD. */
async function impactOf(db, companyId, kind, before, after, { reason = null, requestedBy = null, direct = false } = {}) {
  const plates = platesDiff(before.plates, after.plates);
  const delta = deltaOf(before.metrics, after.metrics);
  const choice = await choiceWords(db, companyId, kind, before, after);
  const plateIds = new Set([...before.plates, ...after.plates].map((p) => p.plateItemId));
  const items = buyingOf(before.state, before.need, after.need, plateIds);
  const pos = posOf(before.state);
  const ordered = items.reduce((t, x) => t + (x.plate ? x.ordered : 0), 0);
  const received = items.reduce((t, x) => t + (x.plate ? x.received : 0), 0);
  const held = items.reduce((t, x) => t + (x.plate ? x.held : 0), 0);
  return {
    kind, kindLabel: KINDS[kind]?.label ?? kind, direct,
    reason, requestedBy,
    line: lineHead(after.line),
    plates: {
      before: before.plates, after: after.plates,
      added: plates.added, removed: plates.removed, changed: plates.changed, same: plates.same,
      words: [
        ...plates.added.map((p) => `+${p.count} × ${p.code} (${sizeWords(p)})`),
        ...plates.removed.map((p) => `−${p.count} × ${p.code} (${sizeWords(p)})`),
        ...plates.changed.map((p) => `${p.code} (${sizeWords(p)}): ${p.from} → ${p.to}`),
      ],
    },
    before: before.metrics, after: after.metrics, delta,
    choice,
    buying: {
      purchaseOrders: pos, items,
      plates: { ordered: r6(ordered), received: r6(received), held: r6(held) },
      text: pos.length
        ? `On order for this line: ${pos.map((p) => p.code).join(', ')}. Plates ordered ${fmt(ordered)}, received ${fmt(received)}, held ${fmt(held)}.`
        : 'No purchase order covers this line yet.',
    },
    sentence: sentenceOf(kind, before.metrics, after.metrics, plates, delta, choice?.text ?? null),
  };
}

/* ───────────────────────────── the buyer's checklist ───────────────────────────── */

const LIVE_FOR_ADD = new Set(['requested', 'quoting', 'draft', 'ordered', 'partially_received']);

/**
 * Per material whose need changed, the purchase-order work it makes — sized by the CHANGE, never more than
 * the cover allows: more needed → add to the newest PO line still open for it (else "order"); less needed →
 * reduce what is still coming (newest first), then let received plates go back to stock (Release excess on
 * the requisition: releaseExcess). Each action is ticked by the buyer.
 */
export function checklistOf(state, needBefore, needAfter, plateIds = new Set()) {
  const items = buyingOf(state, needBefore, needAfter, plateIds).filter((x) => Math.abs(x.change) > EPS || x.plate);
  const out = [];
  for (const it of items) {
    const name = it.code ?? it.name ?? `item ${it.itemId}`;
    const unit = it.uom ? ` ${it.uom}` : '';
    const shares = state.covering.filter((s) => s.itemId === it.itemId);
    const outstanding = (s) => r6(Math.max(0, s.quantity - s.received));
    const coming = r6(shares.filter((s) => LIVE_FOR_ADD.has(s.po.status)).reduce((t, s) => t + outstanding(s), 0));
    const cover = r6(it.held + coming);
    const actions = [];
    let k = 0;
    const act = (a) => { k += 1; actions.push({ key: `i${it.itemId}-${k}`, ...a, done: false, doneBy: null, doneAt: null }); };
    let note = null;
    if (it.change > EPS) {
      const short = r6(Math.min(it.change, Math.max(0, it.needAfter - cover)));
      if (short <= EPS) note = `Already covered: ${fmt(cover)}${unit} held or coming for ${fmt(it.needAfter)}${unit} needed.`;
      else {
        const target = [...shares].reverse().find((s) => LIVE_FOR_ADD.has(s.po.status));
        if (target) act({ kind: 'add', quantity: short, poId: target.po.id, poCode: target.po.code, purchaseLineId: target.purchaseLineId, prLineId: target.prLineId, text: `Add ${fmt(short)}${unit} to ${target.po.code} (${name}).` });
        else act({ kind: 'order', quantity: short, prLineId: shares[0]?.prLineId ?? null, text: `Order ${fmt(short)}${unit} ${name} — no open purchase order has it for this line.` });
      }
    } else if (it.change < -EPS) {
      let excess = r6(Math.min(-it.change, Math.max(0, cover - it.needAfter)));
      if (excess <= EPS) note = `Nothing to take back: ${fmt(cover)}${unit} is held or coming for ${fmt(it.needAfter)}${unit} needed.`;
      for (const s of [...shares].reverse()) {
        if (excess <= EPS) break;
        if (!LIVE_FOR_ADD.has(s.po.status)) continue;
        const q = r6(Math.min(excess, outstanding(s)));
        if (q <= EPS) continue;
        act({ kind: 'reduce', quantity: q, poId: s.po.id, poCode: s.po.code, purchaseLineId: s.purchaseLineId, prLineId: s.prLineId, text: `Reduce ${s.po.code}'s ${name} line by ${fmt(q)}${unit}.` });
        excess = r6(excess - q);
      }
      if (excess > EPS && it.held > EPS) {
        const q = r6(Math.min(excess, it.held));
        const prLineId = state.holds.find((h) => h.itemId === it.itemId)?.prLineId ?? null;
        act({ kind: 'keep', quantity: q, prLineId, text: `Keep ${fmt(q)}${unit} received ${name} for stock — Release excess on the requisition.` });
      }
    } else note = 'The need does not change.';
    out.push({
      itemId: it.itemId, code: it.code, name: it.name, uom: it.uom, plate: it.plate,
      needBefore: it.needBefore, needAfter: it.needAfter, change: it.change,
      ordered: it.ordered, received: it.received, held: it.held, onOrder: it.onOrder,
      actions, note: actions.length ? null : note,
    });
  }
  return { items: out, open: out.reduce((t, x) => t + x.actions.filter((a) => !a.done).length, 0) };
}

/* ───────────────────────────── the gate ───────────────────────────── */

async function holdingRequest(db, companyId, lineId, { lock = false } = {}) {
  // A database without §62 yet holds no request: nesting keeps working until the schema is applied.
  const [[r]] = await db.query(
    `SELECT r.id, r.code, r.kind, r.reason, r.status, r.requested_at, r.requested_by, u.name AS requested_by_name
       FROM cf_plate_change_requests r LEFT JOIN users u ON u.id = r.requested_by
      WHERE r.company_id = ? AND r.order_line_id = ? AND r.deleted_at IS NULL AND r.status IN (?)
      ORDER BY r.id DESC LIMIT 1${lock ? ' FOR UPDATE' : ''}`,
    [companyId, Number(lineId), HOLDING],
  ).catch((e) => { if (e?.code === 'ER_NO_SUCH_TABLE' || e?.errno === 1146) return [[]]; throw e; });
  return r ?? null;
}

const heldSentence = (r, line) => `Plate change ${r.code} is waiting for approval on line ${line.line_no} of ${line.order_code}${r.requested_by_name ? ` (asked by ${r.requested_by_name}: "${String(r.reason).slice(0, 120)}")` : ''}. Nesting is held until it is approved, rejected or withdrawn.`;
const coveredSentence = (pos) => `A purchase order covers this line (${pos.map((p) => p.code).join(', ')}). A change to its plates goes to the MD for approval.`;

/** The body the action reads: the request's own fields taken out. */
function actionBody(body) {
  const { reason, impact, ...rest } = body ?? {};
  void reason; void impact;
  return rest;
}

/**
 * THE GATE every plate write of the nesting routes goes through (routes/nesting.js).
 *   no PO covers the line   → the action, as today (`impact: true` adds plateChange.impact: before / after)
 *   a request holds it      → 409 PLATE_CHANGE_PENDING, in words
 *   a PO covers it          → no reason: 422 PLATE_CHANGE_REASON; with one: a request, nothing saved
 * A preview (upload / sheet dryRun, …) is never held and never a request.
 */
export async function plateChangeGate(db, c, lineId, kind, rawBody = {}, run = null) {
  if (!RUNNERS[kind]) throw new Error(`plateChangeGate: unknown kind ${kind}`);
  const body = actionBody(rawBody);
  const doIt = (b) => (run ? run(b) : RUNNERS[kind](db, c, lineId, b));
  if (isPreview(kind, body)) return doIt(body);
  const companyId = c.companyId;
  // Two reads on a line with no PO: is a request holding it, and does any PO cover it.
  const held = await holdingRequest(db, companyId, lineId, { lock: true });
  if (held) throw conflict('PLATE_CHANGE_PENDING', heldSentence(held, await requireLine(db, companyId, lineId)), { detail: { requestId: held.id, code: held.code } });
  const pos = await coveringPos(db, companyId, lineId);
  const wantImpact = truthy(rawBody?.impact);

  if (!pos.length) {
    if (!wantImpact) return doIt(body);
    const before = await snapshot(db, companyId, lineId);
    const out = await doIt(body);
    if (out && out.applied === false) return out;
    const after = await snapshot(db, companyId, lineId);
    const impact = await impactOf(db, companyId, kind, before, after, { direct: true });
    return { ...(out ?? {}), plateChange: { direct: true, impact } };
  }

  const reason = blank(rawBody?.reason) ? null : String(rawBody.reason).trim().slice(0, MAX_REASON);
  const untrackedKind = kind === 'untracked' || kind === 'untracked_undo';
  if (!reason && !untrackedKind) throw reasonNeeded(pos);

  // The action for real, measured, then rolled back: the impact is what the save would do.
  const line = await requireLine(db, companyId, lineId);
  const before = await snapshot(db, companyId, lineId);
  await db.query('SAVEPOINT cf_plate_change');
  let out; let after;
  try {
    out = await doIt(body);
    if (out && out.applied === false) { await db.query('ROLLBACK TO SAVEPOINT cf_plate_change'); return out; }
    after = await snapshot(db, companyId, lineId);
  } catch (e) {
    await db.query('ROLLBACK TO SAVEPOINT cf_plate_change');
    throw e;
  }
  // Pieces cut from offcuts touch the plates bought only when they change the need: otherwise they go through.
  if (untrackedKind && sameNeed(before.need, after.need) && platesDiff(before.plates, after.plates).same) {
    await db.query('RELEASE SAVEPOINT cf_plate_change');
    return out;
  }
  await db.query('ROLLBACK TO SAVEPOINT cf_plate_change');
  if (!reason) throw reasonNeeded(pos);

  const requester = { id: c.userId ?? null, name: c.userName ?? null };
  const impact = await impactOf(db, companyId, kind, before, after, { reason, requestedBy: requester });
  const request = await createRequest(db, c, line, kind, rawBody, body, reason, before.hash, impact);
  return {
    requested: true, applied: false, plateChange: request,
    message: `Sent for approval as ${request.code}. Nothing is saved until it is approved.`,
  };
}

const reasonNeeded = (pos) => invalid('PLATE_CHANGE_REASON', `${coveredSentence(pos)} Say why the change is needed.`, { detail: { purchaseOrders: pos } });

function sameNeed(a, b) {
  const ids = new Set([...a.items.keys(), ...b.items.keys()]);
  for (const id of ids) if (Math.abs((a.items.get(id)?.need ?? 0) - (b.items.get(id)?.need ?? 0)) > EPS) return false;
  return true;
}

/** Files of an upload / a sheet, kept apart (a row each); the stored body names them by number. */
function splitFiles(kind, body) {
  const files = [];
  const toBuffer = (v) => (Buffer.isBuffer(v) ? v : Buffer.from(String(v).replace(/^data:[^,]*,/, ''), 'base64'));
  if (kind === 'upload' && Array.isArray(body.files)) {
    const list = body.files.map((f, i) => {
      const { file, content, fileBase64, text, ...rest } = f ?? {};
      const raw = file ?? content ?? fileBase64;
      const buffer = raw != null && raw !== '' ? toBuffer(raw) : text != null ? Buffer.from(String(text), 'latin1') : Buffer.alloc(0);
      files.push({ no: i, filename: rest.filename ?? rest.name ?? null, buffer });
      return { ...rest, fileRef: i };
    });
    return { body: { ...body, files: list }, files };
  }
  if (kind === 'sheet') {
    const { file, fileBase64, content, ...rest } = body;
    const raw = file ?? fileBase64 ?? content;
    if (raw != null && raw !== '') { files.push({ no: 0, filename: rest.filename ?? null, buffer: toBuffer(raw) }); return { body: { ...rest, fileRef: 0 }, files }; }
  }
  return { body, files };
}

async function createRequest(db, c, line, kind, rawBody, body, reason, hash, impact) {
  const companyId = c.companyId;
  const split = splitFiles(kind, body);
  const [ins] = await db.query(
    `INSERT INTO cf_plate_change_requests (company_id, order_id, order_line_id, kind, reason, status, base_hash, proposal_json, impact_json, requested_by, created_by)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
    [companyId, line.order_id, line.id, kind, reason, hash, JSON.stringify({ kind, body: split.body }), JSON.stringify(impact), c.userId ?? null, c.userId ?? null],
  );
  const id = ins.insertId;
  await db.query("UPDATE cf_plate_change_requests SET code = CONCAT('PC-', LPAD(id, 6, '0')) WHERE company_id = ? AND id = ?", [companyId, id]);
  // The files in statements of at most ~8 MB (each file ≤ 4 MB: a row stays under TiDB's 6 MB entry limit).
  let batch = []; let size = 0;
  const flush = async () => { if (batch.length) await insertRows(db, 'cf_plate_change_files', ['company_id', 'request_id', 'file_no', 'filename', 'bytes', 'content', 'created_by'], batch, batch.length); batch = []; size = 0; };
  for (const f of split.files) {
    if (size + f.buffer.length > 8 * 1048576) await flush();
    batch.push([companyId, id, f.no, f.filename ? String(f.filename).slice(0, 255) : null, f.buffer.length, f.buffer, c.userId ?? null]);
    size += f.buffer.length;
  }
  await flush();
  await event(db, c, id, 'requested', reason);
  const [r] = await readRows(db, companyId, { id });
  return shapeRequest(r, { viewer: { userId: c.userId ?? null }, live: null });
}

async function event(db, c, requestId, action, note = null) {
  await db.query('INSERT INTO cf_plate_change_events (company_id, request_id, action, note, user_id) VALUES (?, ?, ?, ?, ?)',
    [c.companyId, requestId, action, note == null ? null : String(note).slice(0, MAX_REASON), c.userId ?? null]);
}

/** The body the action is replayed with: the stored one, its files put back. */
async function replayBody(db, companyId, r) {
  const p = parseJson(r.proposal_json) ?? {};
  const body = p.body ?? {};
  const [files] = await db.query('SELECT file_no, content FROM cf_plate_change_files WHERE company_id = ? AND request_id = ? AND deleted_at IS NULL', [companyId, r.id]);
  const byNo = new Map(files.map((f) => [Number(f.file_no), Buffer.isBuffer(f.content) ? f.content : Buffer.from(f.content ?? '')]));
  if (r.kind === 'upload' && Array.isArray(body.files)) {
    return { ...body, files: body.files.map(({ fileRef, ...rest }) => ({ ...rest, file: byNo.get(Number(fileRef)) ?? Buffer.alloc(0) })) };
  }
  if (r.kind === 'sheet' && body.fileRef != null) {
    const { fileRef, ...rest } = body;
    return { ...rest, file: byNo.get(Number(fileRef)) ?? Buffer.alloc(0) };
  }
  return body;
}

/* ───────────────────────────── reading ───────────────────────────── */

async function readRows(db, companyId, { id = null, ids = null, lineId = null, statuses = null, limit = 200 } = {}) {
  const where = ['r.company_id = ?', 'r.deleted_at IS NULL'];
  const args = [companyId];
  if (id != null) { where.push('r.id = ?'); args.push(Number(id)); }
  if (ids) { if (!ids.length) return []; where.push('r.id IN (?)'); args.push(ids); }
  if (lineId != null) { where.push('r.order_line_id = ?'); args.push(Number(lineId)); }
  if (statuses) { where.push('r.status IN (?)'); args.push(statuses); }
  const [rows] = await db.query(
    `SELECT r.*, o.code AS order_code, l.line_no, m.code AS item_code, m.name AS item_name, l.description AS line_description,
            ru.name AS requested_by_name, du.name AS decided_by_name
       FROM cf_plate_change_requests r
       JOIN cf_sales_orders o ON o.id = r.order_id
       JOIN cf_sales_order_lines l ON l.id = r.order_line_id
       LEFT JOIN cf_master_records m ON m.id = l.item_id
       LEFT JOIN users ru ON ru.id = r.requested_by
       LEFT JOIN users du ON du.id = r.decided_by
      WHERE ${where.join(' AND ')}
      ORDER BY r.id DESC
      LIMIT ${Math.max(1, Math.min(500, Number(limit) || 200))}`,
    args,
  );
  return rows;
}

/**
 * One request for the screens. `live` = the line's hash now (null = not checked): a pending request whose line
 * moved is said to be out of date. `viewer` = { userId, canApprove, isAdmin, canTick, canManage }.
 */
export function shapeRequest(r, { viewer = {}, live = null } = {}) {
  if (!r) return null;
  const stale = r.status === 'stale' || (r.status === 'pending' && live != null && live !== r.base_hash);
  const status = stale && r.status === 'pending' ? 'pending' : r.status;
  const own = r.requested_by != null && Number(r.requested_by) === Number(viewer.userId);
  const holding = HOLDING.includes(r.status);
  let whyNotApprove = null;
  if (!viewer.canApprove) whyNotApprove = 'Approving a plate change needs the "Approve plate changes" permission.';
  else if (r.status !== 'pending') whyNotApprove = `It is ${STATUS_LABEL[r.status]?.toLowerCase() ?? r.status}.`;
  else if (stale) whyNotApprove = 'The line\'s plates or its buying changed after it was asked. Withdraw it and ask again.';
  else if (own && !viewer.isAdmin) whyNotApprove = 'You asked for this change — somebody else has to approve it.';
  const checklist = parseJson(r.checklist_json);
  return {
    id: r.id, code: r.code ?? `PC-${String(r.id).padStart(6, '0')}`, kind: r.kind, kindLabel: KINDS[r.kind]?.label ?? r.kind,
    status, statusLabel: stale ? STATUS_LABEL.stale : (STATUS_LABEL[r.status] ?? r.status), stale,
    reason: r.reason,
    order: { id: r.order_id, code: r.order_code ?? null },
    line: { id: r.order_line_id, lineNo: r.line_no ?? null, name: r.item_name ?? r.line_description ?? (r.line_no != null ? `Line ${r.line_no}` : null) },
    requestedBy: r.requested_by ? { id: r.requested_by, name: r.requested_by_name ?? null } : null,
    requestedAt: r.requested_at ?? r.created_at ?? null,
    decidedBy: r.decided_by ? { id: r.decided_by, name: r.decided_by_name ?? null } : null,
    decidedAt: r.decided_at ?? null, decisionNote: r.decision_note ?? null, appliedAt: r.applied_at ?? null,
    impact: parseJson(r.impact_json),
    checklist,
    canApprove: whyNotApprove == null,
    whyNotApprove,
    canReject: !!viewer.canApprove && holding,
    canWithdraw: holding && (own || !!viewer.isAdmin || !!viewer.canApprove),
    canTick: !!viewer.canTick && ['approved', 'applied'].includes(r.status) && (checklist?.items ?? []).some((x) => x.actions.length),
  };
}

/**
 * GET …/orders/:orderId/lines/:lineId/nesting/plate-changes — the line's gate and its requests (newest first).
 * gate: { covered, purchaseOrders, needsApproval, held, pending, message }.
 */
export async function lineChanges(db, viewer, lineId) {
  const companyId = viewer.companyId;
  const line = await requireLine(db, companyId, lineId);
  const [states, rows] = await Promise.all([lineStates(db, companyId, [line.id]), readRows(db, companyId, { lineId: line.id, limit: 50 })]);
  const st = states.get(Number(line.id));
  const requests = rows.map((r) => shapeRequest(r, { viewer, live: st.hash }));
  const pending = requests.find((r) => HOLDING.includes(r.status) || r.status === 'pending') ?? null;
  const pos = posOf(st);
  return {
    line: lineHead(line),
    gate: {
      covered: pos.length > 0, purchaseOrders: pos, needsApproval: pos.length > 0, held: !!pending,
      pending: pending ? { id: pending.id, code: pending.code, kindLabel: pending.kindLabel, reason: pending.reason, requestedBy: pending.requestedBy, stale: pending.stale } : null,
      message: pending ? heldSentence({ code: pending.code, reason: pending.reason, requested_by_name: pending.requestedBy?.name ?? null }, line)
        : pos.length ? coveredSentence(pos) : null,
    },
    canApprove: !!viewer.canApprove,
    requests,
  };
}

/**
 * GET /plate-changes?status=pending|open|done|all — across orders. pending = waiting for approval (out of date
 * ones too); open = pending + approved with buyer work left; done = applied, rejected, withdrawn.
 */
export async function listChanges(db, viewer, q = {}) {
  const want = String(q.status ?? 'open').toLowerCase();
  const statuses = want === 'pending' ? HOLDING : want === 'open' ? [...HOLDING, 'approved'] : want === 'done' ? ['applied', 'rejected', 'withdrawn'] : null;
  const rows = await readRows(db, viewer.companyId, { statuses, limit: q.limit ?? 200 });
  const pendingLines = [...new Set(rows.filter((r) => r.status === 'pending').map((r) => Number(r.order_line_id)))];
  const states = await lineStates(db, viewer.companyId, pendingLines);
  const requests = rows.map((r) => shapeRequest(r, { viewer, live: states.get(Number(r.order_line_id))?.hash ?? null }));
  return {
    status: statuses ? want : 'all',
    counts: { pending: requests.filter((r) => r.status === 'pending' && !r.stale).length, stale: requests.filter((r) => r.stale).length, approved: requests.filter((r) => r.status === 'approved').length },
    canApprove: !!viewer.canApprove,
    requests,
  };
}

export async function getChange(db, viewer, id) {
  const [r] = await readRows(db, viewer.companyId, { id });
  if (!r) throw notFound('Plate change');
  const live = r.status === 'pending' ? (await lineStates(db, viewer.companyId, [r.order_line_id])).get(Number(r.order_line_id))?.hash ?? null : null;
  const [events] = await db.query(
    `SELECT e.action, e.note, e.created_at, e.user_id, u.name AS user_name FROM cf_plate_change_events e LEFT JOIN users u ON u.id = e.user_id
      WHERE e.company_id = ? AND e.request_id = ? ORDER BY e.id`,
    [viewer.companyId, r.id],
  );
  return { ...shapeRequest(r, { viewer, live }), events: events.map((e) => ({ action: e.action, note: e.note, at: e.created_at, by: e.user_id ? { id: e.user_id, name: e.user_name } : null })) };
}

async function requireRequest(db, companyId, id, { lock = false } = {}) {
  const [[r]] = await db.query(`SELECT * FROM cf_plate_change_requests WHERE company_id = ? AND id = ? AND deleted_at IS NULL${lock ? ' FOR UPDATE' : ''}`, [companyId, Number(id)]);
  if (!r) throw notFound('Plate change');
  r.code = r.code ?? `PC-${String(r.id).padStart(6, '0')}`;
  return r;
}

/* ───────────────────────────── deciding ───────────────────────────── */

/**
 * POST /plate-changes/:id/approve { note? } — inside the caller's transaction. Returns
 *   { request, kind, lineId }                      saved, requisition synced, checklist written
 *   { refusal }                                    the request was found STALE: its status is written (commit
 *                                                  it), then the refusal is thrown by the caller
 */
export async function approveChange(db, c, id, input = {}) {
  if (!c.canApprove) throw forbidden('Approving a plate change needs the "Approve plate changes" permission (cf_erp_plate_change_approve).');
  const companyId = c.companyId;
  const r = await requireRequest(db, companyId, id, { lock: true });
  if (r.status === 'stale') throw conflict('PLATE_CHANGE_STALE', `${r.code} is out of date — the line's plates or its buying changed after it was asked. Withdraw it and ask again.`);
  if (r.status !== 'pending') throw invalid('NOT_PENDING', `${r.code} is ${STATUS_LABEL[r.status]?.toLowerCase() ?? r.status} — only a change waiting for approval can be approved.`);
  if (r.requested_by != null && Number(r.requested_by) === Number(c.userId) && !c.isAdmin) throw forbidden(`You asked for ${r.code} — somebody else has to approve it.`);
  const note = blank(input.note) ? null : String(input.note).trim().slice(0, MAX_REASON);
  const line = await requireLine(db, companyId, r.order_line_id, { lock: true });
  const state = (await lineStates(db, companyId, [line.id])).get(Number(line.id));
  if (state.hash !== r.base_hash) {
    await db.query("UPDATE cf_plate_change_requests SET status = 'stale', updated_by = ? WHERE company_id = ? AND id = ?", [c.userId ?? null, companyId, r.id]);
    await event(db, c, r.id, 'stale', 'Found out of date when it was approved.');
    return { refusal: conflict('PLATE_CHANGE_STALE', `${r.code} is out of date — the line's plates or its buying changed after it was asked, so it cannot be approved. Withdraw it and ask again.`) };
  }
  const needBefore = await needOf(db, companyId, line);
  const platesBefore = await platesNow(db, companyId, line.id);
  const body = await replayBody(db, companyId, r);
  // Saved as the requester's own action would have saved it.
  const out = await RUNNERS[r.kind](db, { companyId, userId: r.requested_by ?? c.userId ?? null }, line.id, body);
  if (out && out.applied === false) throw invalid('NOT_SAVED', `${r.code} no longer saves: ${out.message ?? 'the change is refused now.'} Withdraw it and ask again.`);
  const synced = await syncRequisitionOfLine(db, c, line.id);
  const needAfter = await needOf(db, companyId, line);
  const platesAfter = await platesNow(db, companyId, line.id);
  const checklist = { ...checklistOf(state, needBefore, needAfter, new Set([...platesBefore, ...platesAfter])), requisition: synced ?? null };
  const status = checklist.open ? 'approved' : 'applied';
  await db.query(
    `UPDATE cf_plate_change_requests SET status = ?, decided_by = ?, decided_at = NOW(), decision_note = ?, applied_at = NOW(), checklist_json = ?, updated_by = ?
      WHERE company_id = ? AND id = ?`,
    [status, c.userId ?? null, note, JSON.stringify(checklist), c.userId ?? null, companyId, r.id],
  );
  await event(db, c, r.id, 'approved', note);
  if (status === 'applied') await event(db, c, r.id, 'applied', 'Nothing for the buyer to change.');
  return { request: await getChange(db, viewerOf(c), r.id), kind: r.kind, lineId: line.id, result: out };
}

/** The catalog plates on the line's saved lots (for telling a plate from another material in the checklist). */
async function platesNow(db, companyId, lineId) {
  const [rows] = await db.query("SELECT DISTINCT plate_item_id FROM cf_plate_lots WHERE company_id = ? AND order_line_id = ? AND deleted_at IS NULL AND kind = 'plate'", [companyId, lineId]);
  return rows.map((x) => Number(x.plate_item_id));
}

const viewerOf = (c) => ({ companyId: c.companyId, userId: c.userId ?? null, canApprove: !!c.canApprove, isAdmin: !!c.isAdmin, canTick: !!c.canTick });

/** POST /plate-changes/:id/reject { note } — the note is required; the line is free again. */
export async function rejectChange(db, c, id, input = {}) {
  if (!c.canApprove) throw forbidden('Rejecting a plate change needs the "Approve plate changes" permission (cf_erp_plate_change_approve).');
  const r = await requireRequest(db, c.companyId, id, { lock: true });
  if (!HOLDING.includes(r.status)) throw invalid('NOT_PENDING', `${r.code} is ${STATUS_LABEL[r.status]?.toLowerCase() ?? r.status} — only a change waiting for approval can be rejected.`);
  const note = blank(input.note) ? null : String(input.note).trim().slice(0, MAX_REASON);
  if (!note) throw invalid('NOTE_REQUIRED', 'Say why it is rejected — the person who asked sees the note.');
  await db.query("UPDATE cf_plate_change_requests SET status = 'rejected', decided_by = ?, decided_at = NOW(), decision_note = ?, updated_by = ? WHERE company_id = ? AND id = ?",
    [c.userId ?? null, note, c.userId ?? null, c.companyId, r.id]);
  await event(db, c, r.id, 'rejected', note);
  return getChange(db, viewerOf(c), r.id);
}

/** POST /plate-changes/:id/withdraw { note? } — by the person who asked (or an approver / admin). */
export async function withdrawChange(db, c, id, input = {}) {
  const r = await requireRequest(db, c.companyId, id, { lock: true });
  if (!HOLDING.includes(r.status)) throw invalid('NOT_PENDING', `${r.code} is ${STATUS_LABEL[r.status]?.toLowerCase() ?? r.status} — there is nothing to withdraw.`);
  const own = r.requested_by != null && Number(r.requested_by) === Number(c.userId);
  if (!own && !c.isAdmin && !c.canApprove) throw forbidden(`Only the person who asked for ${r.code} can withdraw it.`);
  const note = blank(input.note) ? null : String(input.note).trim().slice(0, MAX_REASON);
  await db.query("UPDATE cf_plate_change_requests SET status = 'withdrawn', updated_by = ? WHERE company_id = ? AND id = ?", [c.userId ?? null, c.companyId, r.id]);
  await event(db, c, r.id, 'withdrawn', note);
  return getChange(db, viewerOf(c), r.id);
}

/**
 * POST /plate-changes/:id/checklist { key, done } — the buyer ticks one action. When every action is done the
 * request is DONE (applied); unticking one takes it back to approved.
 */
export async function tickChecklist(db, c, id, input = {}) {
  if (!c.canTick) throw forbidden('Ticking the buyer checklist needs the stock and buying permission (cf_erp_inventory_manage).');
  const r = await requireRequest(db, c.companyId, id, { lock: true });
  if (!['approved', 'applied'].includes(r.status)) throw invalid('NOT_APPROVED', `${r.code} is ${STATUS_LABEL[r.status]?.toLowerCase() ?? r.status} — only an approved change has a checklist.`);
  const list = parseJson(r.checklist_json) ?? { items: [], open: 0 };
  const key = String(input.key ?? '');
  const done = input.done === undefined ? true : truthy(input.done);
  const action = list.items.flatMap((x) => x.actions).find((a) => a.key === key);
  if (!action) throw invalid('NOT_FOUND', `${r.code} has no checklist action "${key}".`);
  if (action.done === done) return getChange(db, viewerOf(c), r.id);
  Object.assign(action, done ? { done: true, doneBy: { id: c.userId ?? null, name: c.userName ?? null }, doneAt: new Date().toISOString() } : { done: false, doneBy: null, doneAt: null });
  list.open = list.items.reduce((t, x) => t + x.actions.filter((a) => !a.done).length, 0);
  const status = list.open ? 'approved' : 'applied';
  await db.query('UPDATE cf_plate_change_requests SET checklist_json = ?, status = ?, updated_by = ? WHERE company_id = ? AND id = ?', [JSON.stringify(list), status, c.userId ?? null, c.companyId, r.id]);
  await event(db, c, r.id, done ? 'ticked' : 'unticked', action.text);
  if (status !== r.status) await event(db, c, r.id, status === 'applied' ? 'applied' : 'reopened', status === 'applied' ? 'Every purchase-order change is done.' : null);
  return getChange(db, viewerOf(c), r.id);
}

export const _test = { platesDiff, deltaOf, buyingOf, sentenceOf, splitFiles, replayBody, snapshot, needOf };
