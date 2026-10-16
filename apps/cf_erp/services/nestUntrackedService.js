/**
 * nestUntrackedService.js — CF_ERP. "Mark the rest as cut from untracked offcuts" (init.sql §61, 2026-10-14).
 *
 *   GET    /orders/:o/lines/:l/nesting/untracked   getUntracked     what is left over, what is marked, kg and cost
 *   POST   /orders/:o/lines/:l/nesting/untracked   markUntracked    { pieces?: [{ cutPlateId, quantity? }], all?, dryRun? }
 *   DELETE /orders/:o/lines/:l/nesting/untracked   unmarkUntracked  { cutPlateIds? } (none = every mark) — Undo
 *
 * The shop nests in ProNest; what the jobs leave over is mostly packings and small plates it cuts
 * from loose offcuts in the yard that are NOT in the system. Marking them closes the line: a marked
 * piece is not left over, is never nested by our packer, asks release for no plate (no lot, no
 * heat number, nothing reserved or issued) and adds no plate and no waste anywhere. Its steel is
 * charged at the PLATE RATE per kg (user, 2026-10-14) — of the catalog plate of its steel the line
 * would buy, chosen when it is marked and kept on the mark (rate_plate_item_id):
 *   1. a plate of that steel the line's saved nest already uses (most plates first),
 *   2. else a plate of that steel with a price (valuationService.plateRatesPerKg's ladder),
 *   3. else the largest plate of that steel; none = no rate ("not costed", never zero).
 *
 * WHAT A MARK COUNTS is min(marked, needed − nested) everywhere (lib/nestUntracked.js): a later
 * upload that nests a marked piece covers it, and the mark shrinks (the upload writes it and says so).
 *
 * ROUND TRIPS — a fixed number whatever the line holds: the line, its survey (the structure and the
 * cut pieces' values), the catalog plates, the pieces on plates, the plates used, the marks, the
 * line's nesting choices, the rows cut from each cut piece, and the plate rates. A write adds the
 * line lock and ONE statement.
 */
import { invalid } from '../lib/errors.js';
import { untrackedOfLine, effectiveUntracked, UNTRACKED_WORDS } from '../lib/nestUntracked.js';
import {
  requireLine, surveyLine, candidatePlates, sheetsFor, kgOf, lineHead, exclusionsOfLine, assertNestable, importBlocker,
} from './nestingService.js';
import { rowsCutFrom } from './nestDxfImportService.js';
import { plateRatesPerKg } from './valuationService.js';
import { memoryRun, blocksLineWrites } from './nestRunService.js';

const round2 = (n) => Math.round(Number(n) * 100) / 100;
const round3 = (n) => Math.round(Number(n) * 1000) / 1000;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const kgText = (n) => `${Math.round(Number(n) || 0).toLocaleString('en-IN')} kg`;

/** The pieces of each cut plate on the line's saved plates, and the plates those lots are. Two reads. */
async function onPlates(db, companyId, lineId) {
  const [[pieces], [plates]] = await Promise.all([
    db.query(
      `SELECT np.cut_plate_id, COUNT(*) AS n
         FROM cf_plate_lots pl
         JOIN cf_nest_placements np ON np.company_id = pl.company_id AND np.plate_lot_id = pl.id AND np.deleted_at IS NULL
        WHERE pl.company_id = ? AND pl.order_line_id = ? AND pl.deleted_at IS NULL AND pl.kind = 'plate'
        GROUP BY np.cut_plate_id`,
      [companyId, lineId],
    ),
    db.query(
      `SELECT plate_item_id, COUNT(*) AS n FROM cf_plate_lots
        WHERE company_id = ? AND order_line_id = ? AND deleted_at IS NULL AND kind = 'plate' GROUP BY plate_item_id`,
      [companyId, lineId],
    ),
  ]);
  return {
    nested: new Map(pieces.map((r) => [Number(r.cut_plate_id), Number(r.n)])),
    lotsOfPlate: new Map(plates.map((r) => [Number(r.plate_item_id), Number(r.n)])),
  };
}

/** Everything the three routes need, read once. */
async function state(db, companyId, lineId, { lock = false } = {}) {
  const line = await requireLine(db, companyId, lineId, { lock });
  const { where, cutPlates } = await surveyLine(db, companyId, line);
  const [plates, { nested, lotsOfPlate }, marks, excl, rows] = await Promise.all([
    candidatePlates(db, companyId, where.plateIds),
    onPlates(db, companyId, lineId),
    untrackedOfLine(db, companyId, lineId),
    exclusionsOfLine(db, companyId, lineId),
    rowsCutFrom(db, companyId, cutPlates.map((cp) => cp.id)),
  ]);
  const need = new Map(cutPlates.map((cp) => [cp.id, cp.pieces]));
  const marked = effectiveUntracked(marks, need, nested);
  // The parts each cut piece is cut for (name + drawing mark, once each): how the screen names it.
  const partsOf = new Map();
  for (const r of rows) {
    if (!r.name && !r.mark) continue;
    if (!partsOf.has(r.cutPlateId)) partsOf.set(r.cutPlateId, new Map());
    partsOf.get(r.cutPlateId).set(`${r.name ?? ''}|${r.mark ?? ''}`, { name: r.name ?? null, mark: r.mark ?? null });
  }
  // The plate whose rate prices each cut piece's steel (the header's ladder, step 1 and 3 here; 2 below).
  const candidatesOf = new Map();
  for (const cp of cutPlates) {
    const s = cp.steel ?? {};
    if (!(s.thickness > 0)) { candidatesOf.set(cp.id, []); continue; }
    const list = sheetsFor(plates, { thickness: s.thickness, grade: s.grade, material: s.material })
      .slice().sort((a, b) => (lotsOfPlate.get(b.id) ?? 0) - (lotsOfPlate.get(a.id) ?? 0)
        || (b.steel.length * b.steel.width) - (a.steel.length * a.steel.width) || a.id - b.id);
    candidatesOf.set(cp.id, list);
  }
  const plateIds = [...new Set([...candidatesOf.values()].flat().map((p) => p.id).concat([...marks.values()].map((m) => m.ratePlateId).filter((x) => x != null)))];
  const rates = await plateRatesPerKg(db, companyId, plateIds);
  const plateById = new Map(plates.map((p) => [p.id, p]));
  const rateFor = (cp) => {
    const list = candidatesOf.get(cp.id) ?? [];
    const used = list.find((p) => (lotsOfPlate.get(p.id) ?? 0) > 0 && rates.has(p.id));
    return used ?? list.find((p) => rates.has(p.id)) ?? list[0] ?? null;
  };
  return { line, cutPlates, need, nested, marks, marked, excl, partsOf, rates, rateFor, plateById };
}

/** One cut piece of the answer: what it is, how many, its steel and its cost at the plate rate. */
function rowOf(st, cp, qty, plate) {
  const s = cp.steel ?? {};
  const kgEach = s.length > 0 && s.width > 0 && s.thickness > 0 ? kgOf(s.length * s.width, s.thickness, s.density) : null;
  const kg = kgEach == null ? null : round3(kgEach * qty);
  const rate = plate ? st.rates.get(plate.id) ?? null : null;
  return {
    cutPlateId: cp.id, code: cp.code ?? null, name: cp.name ?? null,
    thickness: s.thickness ?? null, length: s.length ?? null, width: s.width ?? null, grade: s.grade ?? null,
    parts: [...(st.partsOf.get(cp.id)?.values() ?? [])].sort((a, b) => String(a.name ?? a.mark).localeCompare(String(b.name ?? b.mark))),
    needed: cp.pieces, nested: st.nested.get(cp.id) ?? 0, untracked: st.marked.get(cp.id) ?? 0,
    qty, kgEach, kg,
    // The catalog plate whose rate prices it, and the rate per kg (null = not costed).
    ratePlate: plate ? { id: plate.id, code: plate.code ?? null, name: plate.name ?? null } : null,
    rate: rate ? { perKg: rate.perKg, basis: rate.basis } : null,
    cost: rate && kg != null ? round2(kg * rate.perKg) : null,
    // Held back from our automatic nesting (NEST_MANUAL, or unticked under Nesting › Pieces).
    heldBack: !!cp.manual || !!st.excl.cutPlates.has(cp.id),
  };
}

const totalOf = (rows) => ({
  pieces: rows.reduce((a, r) => a + r.qty, 0),
  kg: round3(rows.reduce((a, r) => a + (r.kg ?? 0), 0)),
  cost: round2(rows.reduce((a, r) => a + (r.cost ?? 0), 0)),
  uncostedPieces: rows.reduce((a, r) => a + (r.cost == null ? r.qty : 0), 0),
});

function answer(st) {
  const leftOver = []; const marked = [];
  for (const cp of st.cutPlates) {
    if (!cp.pieces) continue;
    const m = st.marked.get(cp.id) ?? 0;
    const left = Math.max(0, cp.pieces - (st.nested.get(cp.id) ?? 0) - m);
    if (left > 0) leftOver.push(rowOf(st, cp, left, st.rateFor(cp)));
    if (m > 0) {
      const kept = st.marks.get(cp.id)?.ratePlateId;
      marked.push(rowOf(st, cp, m, kept != null ? st.plateById.get(kept) ?? { id: kept } : st.rateFor(cp)));
    }
  }
  const byCode = (a, b) => String(a.code ?? '').localeCompare(String(b.code ?? '')) || a.cutPlateId - b.cutPlateId;
  leftOver.sort(byCode); marked.sort(byCode);
  const blocker = importBlocker(st.line);
  const t = { leftOver: totalOf(leftOver), marked: totalOf(marked) };
  return {
    line: lineHead(st.line),
    canMark: !blocker, readOnlyReason: blocker?.message ?? null,
    leftOver, marked, totals: t,
    // "n pieces · x kg cut from untracked offcuts" — the line the plan shows, or null.
    summary: t.marked.pieces ? `${plural(t.marked.pieces, 'piece', 'pieces')} · ${kgText(t.marked.kg)} ${UNTRACKED_WORDS}` : null,
  };
}

/** GET …/nesting/untracked — what is left over (and what each would cost at the plate rate), and what is marked. */
export async function getUntracked(db, companyId, lineId) {
  return answer(await state(db, companyId, lineId));
}

/** A nesting run working on the line (in this process): its answer would be for a line that changed under it. */
function assertNoRun(companyId, lineId, what) {
  const run = memoryRun(companyId, lineId);
  // The automatic comparison after an upload nests a fixed set of pieces and reads no mark: not held (2026-10-16).
  if (blocksLineWrites(run)) throw invalid('RUN_BUSY', `A nesting run is working on this line — wait for it to finish, then ${what}.`);
}

/**
 * POST …/nesting/untracked — mark left-over pieces as cut from untracked offcuts.
 *   { all: true }                                    every piece left over (also when `pieces` is left out)
 *   { pieces: [{ cutPlateId, quantity? }] }          these; quantity left out = all of it that is left over
 *   dryRun: true                                     the same answer, nothing written
 * Refused in words, nothing written (422 UNTRACKED_INVALID): a cut piece that is not the line's, a
 * quantity that is not a whole number above 0 or is more than is left over of it. 422 NOTHING_LEFT
 * when nothing is left over. The line must be open to nesting (frozen, open order, not released).
 */
export async function markUntracked(db, c, lineId, input = {}) {
  const st = await state(db, c.companyId, lineId, { lock: input.dryRun !== true });
  assertNestable(st.line);
  assertNoRun(c.companyId, lineId, 'mark the pieces');
  const leftOf = (cp) => Math.max(0, cp.pieces - (st.nested.get(cp.id) ?? 0) - (st.marked.get(cp.id) ?? 0));
  const byId = new Map(st.cutPlates.map((cp) => [cp.id, cp]));
  const asked = new Map();
  const problems = [];
  const everyThing = input.all === true || input.pieces == null;
  if (everyThing) {
    for (const cp of st.cutPlates) if (leftOf(cp) > 0) asked.set(cp.id, leftOf(cp));
  } else if (!Array.isArray(input.pieces)) {
    problems.push('`pieces` is a list: [{ cutPlateId, quantity }].');
  } else {
    for (const p of input.pieces) {
      const id = Number(p?.cutPlateId);
      const cp = byId.get(id);
      if (!Number.isInteger(id) || !cp) { problems.push(`Cut piece ${p?.cutPlateId ?? '(none)'} is not one of line ${st.line.line_no}'s cut pieces.`); continue; }
      const left = leftOf(cp);
      const q = p.quantity == null || p.quantity === '' ? left : Number(p.quantity);
      if (!Number.isInteger(q) || q <= 0) { problems.push(`${cp.code ?? `Cut piece ${id}`}: "${p.quantity}" is not a number of pieces (a whole number above 0).`); continue; }
      if (q > left) { problems.push(`${cp.code ?? `Cut piece ${id}`}: ${left === 0 ? 'nothing of it is left over' : `only ${plural(left, 'piece is', 'pieces are')} left over`}, so ${q} cannot be marked.`); continue; }
      asked.set(id, (asked.get(id) ?? 0) + q);
      if (asked.get(id) > left) problems.push(`${cp.code ?? `Cut piece ${id}`} is named twice for more than is left over (${left}).`);
    }
  }
  if (problems.length) throw invalid('UNTRACKED_INVALID', 'Those pieces cannot be marked as cut from untracked offcuts.', { problems });
  if (!asked.size) throw invalid('NOTHING_LEFT', 'Nothing is left over on this line, so there is nothing to mark.');

  const rows = [...asked].map(([id, q]) => {
    const cp = byId.get(id);
    const keep = st.marks.get(id)?.ratePlateId;
    const plate = keep != null && (st.marked.get(id) ?? 0) > 0 ? { id: keep } : st.rateFor(cp);
    return { cp, q, total: (st.marked.get(id) ?? 0) + q, plateId: plate?.id ?? null };
  });
  const added = rows.map((r) => rowOf(st, r.cp, r.q, r.plateId != null ? st.plateById.get(r.plateId) ?? { id: r.plateId } : null));
  const t = totalOf(added);
  const said = `${input.dryRun === true ? 'Would mark' : 'Marked'} ${plural(t.pieces, 'piece', 'pieces')} (${kgText(t.kg)}${t.uncostedPieces < t.pieces ? `, ₹${Math.round(t.cost).toLocaleString('en-IN')} at the plate rate` : ''}) as ${UNTRACKED_WORDS}.${t.uncostedPieces ? ` ${plural(t.uncostedPieces, 'piece has', 'pieces have')} no plate rate yet, so ${t.uncostedPieces === 1 ? 'it is' : 'they are'} not costed.` : ''}`;
  if (input.dryRun === true) return { ...answer(st), dryRun: true, applied: false, adding: { pieces: added, totals: t }, message: said };

  await db.query(
    `INSERT INTO cf_nest_untracked (company_id, order_line_id, cut_plate_id, quantity, rate_plate_item_id, created_by, updated_by)
     VALUES ${rows.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(', ')}
     ON DUPLICATE KEY UPDATE quantity = VALUES(quantity), rate_plate_item_id = VALUES(rate_plate_item_id), deleted_at = NULL, updated_by = VALUES(updated_by)`,
    rows.flatMap((r) => [c.companyId, st.line.id, r.cp.id, r.total, r.plateId, c.userId ?? null, c.userId ?? null]),
  );
  // The answer from what was read and what was written — no second read.
  for (const r of rows) { st.marks.set(r.cp.id, { qty: r.total, ratePlateId: r.plateId }); st.marked.set(r.cp.id, r.total); }
  return { ...answer(st), dryRun: false, applied: true, adding: { pieces: added, totals: t }, message: said };
}

/**
 * DELETE …/nesting/untracked — Undo: the marks go (soft delete) and their pieces are left over again.
 * `cutPlateIds` names some; none = every mark of the line.
 */
export async function unmarkUntracked(db, c, lineId, input = {}) {
  const st = await state(db, c.companyId, lineId, { lock: true });
  assertNestable(st.line);
  assertNoRun(c.companyId, lineId, 'undo the mark');
  const raw = input.cutPlateIds;
  const ids = raw == null || raw === '' ? [...st.marks.keys()]
    : (Array.isArray(raw) ? raw : String(raw).split(',')).map(Number).filter((x) => Number.isInteger(x) && x > 0);
  const problems = ids.filter((id) => !st.marks.has(id)).map((id) => `Cut piece ${id} is not marked as ${UNTRACKED_WORDS} on this line.`);
  if (problems.length) throw invalid('UNTRACKED_INVALID', 'Those marks cannot be undone.', { problems });
  if (!ids.length) throw invalid('NOTHING_MARKED', `Nothing on this line is marked as ${UNTRACKED_WORDS}.`);
  const pieces = ids.reduce((a, id) => a + (st.marked.get(id) ?? 0), 0);
  await db.query(
    'UPDATE cf_nest_untracked SET deleted_at = NOW(), updated_by = ? WHERE company_id = ? AND order_line_id = ? AND deleted_at IS NULL AND cut_plate_id IN (?)',
    [c.userId ?? null, c.companyId, st.line.id, ids],
  );
  for (const id of ids) { st.marks.delete(id); st.marked.delete(id); }
  return {
    ...answer(st), applied: true, undone: { cutPieces: ids.length, pieces },
    message: `Undone: ${plural(pieces, 'piece is', 'pieces are')} left over again.`,
  };
}
