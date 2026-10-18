/**
 * nestAlternativeService.js — CF_ERP. AI'S NESTING STORED BESIDE THE MANUAL ONE (init.sql §87, 2026-10-18).
 *
 * The user: "whenever a manual nesting (ProNest .nif / DXF upload) is saved on a line/order, an AI nesting run is
 * started in the background for the same pieces and plates … and its result is STORED as the line's alternative —
 * never replacing the main (uploaded) nesting automatically. The Nesting screen shows Compare with both side by side
 * … and lets the user make the AI one the main nesting (and switch back), until the nesting is locked."
 *
 * WHAT ALREADY DID HALF OF IT (2026-10-16, nestCompareService): saving an upload queues a Standard run of exactly the
 * pieces the uploaded plates hold (scope 'subset'); its row in cf_nest_runs is kept and found again by its demand
 * fingerprint. That row IS the alternative. This service adds what was missing:
 *
 *   cf_nest_alternatives (§87)  one row per line: which run is the alternative, for which upload, and which side is
 *                               the MAIN one now ('uploaded' | 'ai'), with the plates of both sides.
 *   swapAlternative             "Make AI's nesting the main one" / "Switch back to the customer's nesting".
 *   runAlternative              the same Standard run, made HERE (a script: the backfill of lines uploaded before this).
 *
 * MAKE AI'S THE MAIN ONE (to 'ai'). AI's plates of the uploaded pieces take the customer's plates' place; plates WE
 * nested for what the upload left over stay as they are. It is written by acceptNesting (replaceImported, the plan =
 * AI's plates + our other plates as they are saved), which checks every plate against the database and works the
 * plate quantities, offcuts, cut length and piercings out again. The customer's plates are soft-deleted with their
 * placements, offcuts and files — KEPT: their ids are on the alternative row. AI's plates never wear a customer plate's
 * number (a switch back brings those numbers back). Pieces held back from automatic nesting (NEST_MANUAL, left out) that
 * the customer nested are nested by AI too (its run nests exactly the upload's pieces) and stay on AI's plates; any piece
 * AI could not place is left over afterwards, and the screen says how many before the swap.
 *
 * SWITCH BACK (to 'uploaded'). AI's plates go (soft-deleted, kept); the customer's plates come back EXACTLY as they
 * were — the same rows, placements, offcuts and files (a fixed 4 UPDATEs) — and the plate quantities and cut lengths
 * are worked out again. A later "Make AI's the main one" writes AI's plates again from the run.
 *
 * LOCKED. Neither, once the line has a production order (step 4's freeze), is released, or its order is closed —
 * nestingService.assertNestable, the rule every nesting write keeps.
 *
 * PLATES ON A PR / PO. Both go through plateChangeGate (kind 'swap_alternative') like every plate write: with the
 * gate on and a PO covering the line it is a change request with its impact sheet; otherwise it saves and the sheet
 * says what changed — plates, steel, waste, cost and what is on order. Nothing on a PO is changed by a swap.
 *
 * STALE. The alternative answers ONE upload (its key) and ONE demand (the pieces, cut settings, plate choices,
 * drawings). A new upload, a re-nest, a plate taken off, a changed demand: the stored sides no longer match the line —
 * readAlternative says `valid: false`, nothing is swapped, and the upload's own automatic run makes a new one.
 *
 * ROUND TRIPS (fixed, whatever the plates): readAlternative 1 (+1 when AI's is the main one: the plates' state);
 * a switch back ~16; a swap to AI = acceptNesting's own + the comparison's reads.
 */
import { invalid } from '../lib/errors.js';
import {
  requireLine, assertNestable, acceptNesting, savedLotsOf, clearLots, replaceAreaFractions, candidatePlates, surveyLine,
  supersedeProposals, planNesting, effortOf, runBudgetMs,
} from './nestingService.js';
import { isUploadedPiece } from './nestDxfImportService.js';
import { writePlateCuts } from './plateCutsService.js';
import { drawingFactsOfLine } from './partDrawingService.js';
import { compareState, plansOf, AUTO_COMPARE_EFFORT } from './nestCompareService.js';
import { insertFinishedRun } from './nestRunService.js';

const parseJson = (v) => { if (v == null) return null; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return null; } };
const idList = (v) => (parseJson(v) ?? []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
const missingTable = (e) => e?.errno === 1146 || e?.code === 'ER_NO_SUCH_TABLE';
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
export const SIDES = Object.freeze(['uploaded', 'ai']);

/* ───────────────────────────── the row ───────────────────────────── */

/**
 * The line's alternative, or null (none, or a database without §87). With AI's nesting the main one, `valid` says
 * whether the plates are still exactly as the swap left them (AI's live, the customer's soft-deleted) — one more read.
 * → { id, runUid, uploadKey, main, uploadLotIds, uploadFileIds, aiLotIds, swapCount, swappedAt, swappedBy, valid }
 */
export async function readAlternative(db, companyId, lineId, { lock = false } = {}) {
  let row;
  try {
    [[row]] = await db.query(
      `SELECT * FROM cf_nest_alternatives WHERE company_id = ? AND order_line_id = ? AND deleted_at IS NULL${lock ? ' FOR UPDATE' : ''}`,
      [companyId, Number(lineId)],
    );
  } catch (e) { if (missingTable(e)) return null; throw e; }
  if (!row) return null;
  const alt = {
    id: Number(row.id), runUid: row.run_uid ?? null, uploadKey: row.upload_key ?? null, main: row.main_side === 'ai' ? 'ai' : 'uploaded',
    uploadLotIds: idList(row.upload_lot_ids), uploadFileIds: idList(row.upload_file_ids), aiLotIds: idList(row.ai_lot_ids),
    swapCount: Number(row.swap_count ?? 0), swappedAt: row.swapped_at ?? null, swappedBy: row.swapped_by ?? null, valid: true,
  };
  if (alt.main === 'ai') {
    const all = [...alt.uploadLotIds, ...alt.aiLotIds];
    const [lots] = all.length
      ? await db.query("SELECT id, deleted_at IS NULL AS live FROM cf_plate_lots WHERE company_id = ? AND order_line_id = ? AND kind = 'plate' AND id IN (?)", [companyId, Number(lineId), all])
      : [[]];
    const live = new Map(lots.map((l) => [Number(l.id), Number(l.live) === 1]));
    alt.valid = alt.uploadLotIds.length > 0 && alt.aiLotIds.length > 0
      && alt.uploadLotIds.every((id) => live.get(id) === false) && alt.aiLotIds.every((id) => live.get(id) === true);
  }
  return alt;
}

/** Writes the line's row (one upsert). `fields` = the columns to set; a new row starts at main 'uploaded'. */
async function writeAlternative(db, c, lineId, fields) {
  const cols = ['run_uid', 'upload_key', 'main_side', 'upload_lot_ids', 'upload_file_ids', 'ai_lot_ids', 'swap_count', 'swapped_at', 'swapped_by'];
  const v = (k) => (k in fields ? fields[k] : null);
  const vals = cols.map((k) => (k === 'main_side' ? (v(k) ?? 'uploaded') : k === 'swap_count' ? (v(k) ?? 0) : (Array.isArray(v(k)) ? JSON.stringify(v(k)) : v(k))));
  const set = cols.filter((k) => k in fields).map((k) => `${k} = VALUES(${k})`).join(', ');
  await db.query(
    `INSERT INTO cf_nest_alternatives (company_id, order_line_id, ${cols.join(', ')}, created_by) VALUES (?, ?, ${cols.map(() => '?').join(', ')}, ?)
     ON DUPLICATE KEY UPDATE ${set || 'run_uid = run_uid'}, deleted_at = NULL`,
    [c.companyId, Number(lineId), ...vals, c.userId ?? null],
  );
}

/**
 * THE RUN THAT IS THE ALTERNATIVE (nestCompareService.startAutoCompare, the backfill): the line's row points at it.
 * A new upload resets the row to "the customer's nesting is the main one"; the SAME upload, swapped to AI's, only
 * gets the newer run. A database without §87: nothing (the comparison still finds the run by its demand).
 */
export async function recordAlternativeRun(db, c, lineId, { runUid, uploadKey }) {
  try {
    const alt = await readAlternative(db, c.companyId, lineId);
    if (alt && alt.main === 'ai' && alt.valid && alt.uploadKey === uploadKey) { await writeAlternative(db, c, lineId, { run_uid: runUid }); return { kept: 'ai' }; }
    await writeAlternative(db, c, lineId, {
      run_uid: runUid, upload_key: uploadKey, main_side: 'uploaded', upload_lot_ids: null, upload_file_ids: null, ai_lot_ids: null,
    });
    return { kept: 'uploaded' };
  } catch (e) { if (missingTable(e)) return null; throw e; }
}

/* ───────────────────────────── the state the screen reads ───────────────────────────── */

/**
 * What the Compare tab says about the swap, from the comparison's own state (getCompare hands it in):
 * { main, runId, swapCount, swappedAt, locked, lockReason, canSwap: { to, ok, reason }, leftOverAfter } .
 * `leftOverAfter`: pieces the customer nested that AI's nesting does not hold (they are left over after the swap).
 */
export function alternativeView({ alt, swapped, autoSide, blocker, differ = [], additions = 0 }) {
  const main = swapped ? 'ai' : 'uploaded';
  const to = swapped ? 'uploaded' : 'ai';
  const leftOverAfter = differ.filter((d) => d.uploaded > d.auto).reduce((a, d) => a + (d.uploaded - d.auto), 0);
  let reason = null;
  if (blocker) reason = blocker.message;
  else if (to === 'ai' && (!autoSide || !['ready', 'accepted', 'discarded'].includes(autoSide.status))) reason = "AI's nesting of these pieces is not ready yet.";
  else if (to === 'ai' && additions > 0) reason = `${plural(additions, 'piece', 'pieces')} that AI added onto the customer's plates would lose their plate. Take them off (nest the rest again) first.`;
  return {
    main, runId: autoSide?.runId ?? alt?.runUid ?? null, swapCount: alt?.swapCount ?? 0, swappedAt: alt?.swappedAt ?? null,
    locked: !!blocker, lockReason: blocker?.message ?? null,
    canSwap: { to, ok: !reason, reason },
    leftOverAfter,
  };
}

/**
 * GET …/nesting/alternative — the light read the Nesting screen makes to know whether to show the Compare tab when
 * no customer's plate is saved (AI's nesting is the main one): { main, valid, runId, swapCount, swappedAt, locked,
 * lockReason } | { main: null } when the line has no alternative. 2–3 reads.
 */
export async function alternativeOf(db, companyId, lineId) {
  const line = await requireLine(db, companyId, lineId);
  const alt = await readAlternative(db, companyId, lineId);
  let lockReason = null;
  try { assertNestable(line); } catch (e) { lockReason = e?.message ?? String(e); }
  if (!alt) return { main: null, valid: false, runId: null, swapCount: 0, swappedAt: null, locked: !!lockReason, lockReason };
  return { main: alt.main, valid: alt.valid, runId: alt.runUid, swapCount: alt.swapCount, swappedAt: alt.swappedAt, locked: !!lockReason, lockReason };
}

/* ───────────────────────────── the swap ───────────────────────────── */

/**
 * POST …/nesting/alternative/swap { to: 'ai' | 'uploaded', runId? } — through plateChangeGate (kind 'swap_alternative').
 * → { main, plates, pieces, replacedPlates, leftOver, message }
 */
export async function swapAlternative(db, c, lineId, body = {}) {
  const to = String(body.to ?? '').toLowerCase();
  if (!SIDES.includes(to)) throw invalid('INVALID', 'Say which nesting becomes the main one: "ai" or "uploaded".');
  const companyId = c.companyId;
  const line = await requireLine(db, companyId, lineId, { lock: true });
  assertNestable(line);
  const alt = await readAlternative(db, companyId, lineId, { lock: true });
  const swapped = !!alt && alt.main === 'ai' && alt.valid;
  if (to === 'uploaded') return switchBack(db, c, line, alt, swapped);
  if (swapped) throw invalid('ALREADY_MAIN', "AI's nesting is already the main one.");
  return makeAiMain(db, c, line, alt, body);
}

async function makeAiMain(db, c, line, alt, body) {
  const companyId = c.companyId;
  const st = await compareState(db, companyId, line.id, { alt });
  if (!st.uploadedLots.length) throw invalid('NOTHING_UPLOADED', "No customer's nesting is saved on this line, so there is nothing to swap with AI's.");
  if (st.demandError) throw invalid(st.demandError.code, st.demandError.message);
  const row = st.rowSubset;
  if (!row) throw invalid('NO_ALTERNATIVE', "AI's nesting of these pieces is not ready yet (or the line changed since it ran). Wait for it, or run it again on the Compare tab.");
  if (body.runId && String(body.runId) !== String(row.run_uid)) throw invalid('STALE_RUN', "The comparison on your screen is out of date — AI's nesting was run again since. Look again, then swap.");
  const added = st.uploadedLots.reduce((a, l) => a + l.pieces.filter((p) => !isUploadedPiece(l, p)).length, 0);
  if (added) throw invalid('ADDED_PIECES', `${plural(added, 'piece', 'pieces')} that AI added onto the customer's plates would lose their plate. Take them off (nest the rest again) first.`);
  const plan = (await plansOf(db, companyId, [row.id])).get(row.id);
  if (!plan) throw invalid('NO_ALTERNATIVE', "AI's nesting of these pieces has no layout stored. Run it again on the Compare tab.");
  const aiNests = (plan.groups ?? []).flatMap((g) => g.nests ?? []);
  if (!aiNests.length) throw invalid('NO_ALTERNATIVE', "AI's nesting of these pieces placed nothing. Run it again on the Compare tab.");
  // Our own plates for what the upload left over stay exactly as they are saved.
  const rest = st.saved.filter((l) => l.origin !== 'imported').map(asPlanNest);
  const uploadLotIds = st.uploadedLots.map((l) => Number(l.id));
  const uploadFileIds = [...new Set(st.uploadedLots.map((l) => l.nestFileId).filter((x) => x != null).map(Number))];
  const accepted = await acceptNesting(db, c, line.id, { nests: [...aiNests, ...rest], replaceImported: true }, {
    allowLeftOver: true, heldBack: true, reserveLotNos: new Set(st.uploadedLots.map((l) => l.lotNo)),
  });
  const aiLotIds = accepted.lotIds.slice(0, aiNests.length);
  await writeAlternative(db, c, line.id, {
    run_uid: row.run_uid, upload_key: st.uploadKey, main_side: 'ai', upload_lot_ids: uploadLotIds, upload_file_ids: uploadFileIds, ai_lot_ids: aiLotIds,
    swap_count: (alt?.swapCount ?? 0) + 1, swapped_at: new Date(), swapped_by: c.userId ?? null,
  });
  // What the line needs that no plate holds now: worked out from the plates just written (no read).
  const leftOver = leftOverOfNests(st.ctx.cutPlates, [...aiNests, ...rest]);
  return {
    main: 'ai', runId: row.run_uid, plates: aiLotIds.length, pieces: accepted.pieces, replacedPlates: uploadLotIds.length, keptPlates: rest.length, leftOver,
    quantities: accepted.quantities,
    message: `AI's nesting is now the main one: ${plural(aiLotIds.length, 'plate', 'plates')} in place of the customer's ${plural(uploadLotIds.length, 'plate', 'plates')}.${leftOver ? ` ${plural(leftOver, 'piece is', 'pieces are')} left over.` : ''} The customer's nesting is kept — switch back any time before production.`,
  };
}

async function switchBack(db, c, line, alt, swapped) {
  const companyId = c.companyId;
  if (!alt || alt.main !== 'ai') throw invalid('ALREADY_MAIN', "The customer's nesting is already the main one.");
  if (!swapped) throw invalid('ALTERNATIVE_STALE', "The line's nesting changed since AI's was made the main one, so the customer's plates cannot be brought back as they were. Upload the customer's nesting again.");
  // AI's plates go (kept as rows); the customer's come back exactly as they were.
  await clearLots(db, c, line.id, { ids: alt.aiLotIds });
  await db.query('UPDATE cf_plate_lots SET deleted_at = NULL WHERE company_id = ? AND order_line_id = ? AND id IN (?)', [companyId, line.id, alt.uploadLotIds]);
  await db.query('UPDATE cf_nest_placements SET deleted_at = NULL WHERE company_id = ? AND plate_lot_id IN (?)', [companyId, alt.uploadLotIds]);
  await db.query('UPDATE cf_offcuts SET deleted_at = NULL WHERE company_id = ? AND plate_lot_id IN (?)', [companyId, alt.uploadLotIds]);
  if (alt.uploadFileIds.length) await db.query('UPDATE cf_nest_files SET deleted_at = NULL WHERE company_id = ? AND id IN (?)', [companyId, alt.uploadFileIds]);
  // Everything derived, over every live plate: the plate quantity of each cut plate (a cut plate on no plate goes
  // back to its area fraction), then cut length and piercings.
  const { where, cutPlates } = await surveyLine(db, companyId, line);
  const plates = await candidatePlates(db, companyId, where.plateIds);
  const plateById = new Map(plates.map((p) => [p.id, p]));
  const lots = await savedLotsOf(db, companyId, line.id);
  const charged = lots.map((l) => {
    const plate = plateById.get(l.plateItemId) ?? { id: l.plateItemId, code: l.plateCode, steel: { thickness: l.thickness, length: l.length, width: l.width } };
    return { plate: { id: plate.id, code: plate.code, steel: { ...plate.steel, length: l.length, width: l.width } }, pieces: l.pieces.map((p) => ({ cutPlateId: p.cutPlateId, area: p.area ?? p.length * p.width })) };
  });
  const blanks = new Map(cutPlates.filter((cp) => cp.pieces).map((cp) => [cp.id, cp.pieces]));
  const quantities = await replaceAreaFractions(db, c, where, charged, blanks, { restore: { cutPlates, plateById } });
  await writePlateCuts(db, c, line.id, cutPlates, { facts: await drawingFactsOfLine(db, companyId, line.id) });
  await supersedeProposals(db, companyId, line.id);
  await writeAlternative(db, c, line.id, { main_side: 'uploaded', swap_count: alt.swapCount + 1, swapped_at: new Date(), swapped_by: c.userId ?? null });
  const leftOver = leftOverOfNests(cutPlates, lots);
  return {
    main: 'uploaded', runId: alt.runUid, plates: alt.uploadLotIds.length, replacedPlates: alt.aiLotIds.length, leftOver, quantities,
    message: `The customer's nesting is the main one again: ${plural(alt.uploadLotIds.length, 'plate', 'plates')} back in place of AI's ${plural(alt.aiLotIds.length, 'plate', 'plates')}. AI's nesting stays beside it.`,
  };
}

/** A saved plate as a plan's plate (acceptNesting reads only the plate, whose it is and where each piece sits). */
const asPlanNest = (l) => ({
  plateItemId: l.plateItemId, ownerPartyId: l.ownerPartyId ?? null, source: l.source ?? 'catalog', isManual: !!l.isManual,
  ...(l.sourceKind === 'shape' || l.waste?.layout === 'free' ? { layout: 'free' } : {}),
  pieces: l.pieces.map((p) => ({ cutPlateId: p.cutPlateId, x: p.x, y: p.y, length: p.length, width: p.width, rotated: p.rotated, rotationDeg: p.rotationDeg, mirrored: p.mirrored, seqNo: p.seqNo, rowNo: p.rowNo, posNo: p.posNo })),
});

/** Pieces the line needs that no plate holds (held back and left out included), from the plates (saved or a plan's). */
function leftOverOfNests(cutPlates, lots) {
  const on = new Map();
  for (const l of lots) for (const p of l.pieces) on.set(p.cutPlateId, (on.get(p.cutPlateId) ?? 0) + 1);
  return cutPlates.reduce((a, cp) => a + Math.max(0, (cp.pieces ?? 0) - (on.get(cp.id) ?? 0)), 0);
}

/* ───────────────────────────── made here (the backfill) ───────────────────────────── */

/**
 * AI's nesting of the uploaded pieces, made in THIS process (scripts/cf_kepl/backfill_ai_alternatives.mjs) exactly as
 * the server's automatic run after an upload makes it: Standard, scope 'subset', the upload's pieces (`only`). With
 * `commit` it is stored as a finished run (purpose 'compare' — the comparison finds it by its demand) and the line's
 * alternative row points at it. Without, nothing is written.
 *   → { lineId, skipped?, reason?, plates, pieces, unplaced, runId?, demandHash, uploadKey, elapsedMs }
 */
export async function runAlternative(db, c, lineId, { effort = AUTO_COMPARE_EFFORT, budgetMs = null, commit = false, workers = null, say = () => {}, pack = null } = {}) {
  const companyId = c.companyId;
  const st = await compareState(db, companyId, lineId);
  const out = { lineId: Number(lineId), uploadKey: st.uploadKey, demandHash: st.demandSubset?.hash ?? null };
  if (!st.uploadedLots.length) return { ...out, skipped: true, reason: 'Nothing is uploaded on this line.' };
  if (st.demandError) return { ...out, skipped: true, reason: st.demandError.message };
  if (!st.demandSubset) return { ...out, skipped: true, reason: 'The uploaded plates hold no piece the line still needs.' };
  if (st.rowSubset) {
    if (commit) await recordAlternativeRun(db, c, lineId, { runUid: st.rowSubset.run_uid, uploadKey: st.uploadKey });
    return { ...out, skipped: true, reason: 'AI\'s nesting of these pieces is already stored.', runId: st.rowSubset.run_uid };
  }
  const level = effortOf(effort);
  const budget = Number(budgetMs) > 0 ? Number(budgetMs) : runBudgetMs(level);
  const pieces = Object.values(st.only).reduce((a, q) => a + q, 0);
  const upload = { key: st.uploadKey, plates: st.uploadedLots.length, pieces };
  const input = { effort: level, trigger: 'backfill', only: st.only, upload };
  const startedAt = Date.now();
  let demand = null;
  say(`line ${lineId}: AI nests the ${pieces} pieces of ${plural(st.uploadedLots.length, 'uploaded plate', 'uploaded plates')} (${level}, up to ${Math.round(budget / 1000)} s)`);
  const plan = await planNesting(db, companyId, lineId, {
    effort: level, only: st.only, background: true, budgetMs: budget, workers, ...(pack ? { pack } : {}),
    onDemand: (d) => { demand = d; },
  });
  const finishedAt = Date.now();
  const t = plan.totals ?? {};
  const res = { ...out, plates: t.plates ?? 0, pieces: t.pieces ?? 0, unplaced: t.unplaced ?? 0, elapsedMs: finishedAt - startedAt };
  if (!demand?.hash) throw invalid('NO_DEMAND', 'The plan did not say what it was asked (no demand fingerprint).');
  if (demand.hash !== st.demandSubset.hash) throw invalid('DEMAND_CHANGED', 'The line changed while AI was nesting it. Run it again.');
  if (!commit) return res;
  const row = await insertFinishedRun(db, {
    companyId, lineId: Number(lineId), plan, demand, input, scope: 'subset', purpose: 'compare', startedAt, finishedAt,
    startedBy: 'automatic, backfill of an earlier upload', budgetMs: budget, userId: c.userId ?? null,
    log: [{ at: new Date(startedAt).toISOString(), text: `Started by the backfill (${level})` }, { at: new Date(finishedAt).toISOString(), text: `Finished: ${t.plates ?? 0} plates, ${t.pieces ?? 0} pieces` }],
  });
  await recordAlternativeRun(db, c, lineId, { runUid: row.runId, uploadKey: st.uploadKey });
  return { ...res, runId: row.runId };
}

/** Lines that have an uploaded nesting and no stored AI alternative of it — the backfill's default. */
export async function linesToBackfill(db, { companyId = null, orderIds = null } = {}) {
  const where = ["pl.deleted_at IS NULL", "pl.kind = 'plate'", "pl.origin = 'imported'", 'o.deleted_at IS NULL', 'l.deleted_at IS NULL'];
  const args = [];
  if (companyId != null) { where.push('pl.company_id = ?'); args.push(Number(companyId)); }
  if (orderIds?.length) { where.push('l.order_id IN (?)'); args.push(orderIds.map(Number)); }
  const [rows] = await db.query(
    `SELECT DISTINCT pl.company_id, pl.order_line_id, l.order_id, l.line_no, o.code AS order_code, o.title
       FROM cf_plate_lots pl
       JOIN cf_sales_order_lines l ON l.id = pl.order_line_id AND l.company_id = pl.company_id
       JOIN cf_sales_orders o ON o.id = l.order_id AND o.company_id = l.company_id
      WHERE ${where.join(' AND ')}
      ORDER BY pl.company_id, l.order_id, l.line_no`,
    args,
  );
  return rows.map((r) => ({ companyId: Number(r.company_id), lineId: Number(r.order_line_id), orderId: Number(r.order_id), lineNo: Number(r.line_no), orderCode: r.order_code, title: r.title }));
}

export const _test = { asPlanNest, writeAlternative, leftOverOfNests };
