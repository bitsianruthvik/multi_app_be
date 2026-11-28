/**
 * openingPositionService.js — THE OPENING POSITION of a released line (init.sql §121; user, 2026-11-28: "I want to
 * get the sales orders to the levels of completion they are in production. Most of the orders move by girders. And
 * they all move to the same phase more or less. So give a way to easily set everything to a particular stage.")
 *
 * Work done before the system is marked on the line's tracker steps: "done up to stage X" for the whole line, or for
 * the pieces ticked (a span, a girder, a segment — each with everything under it, cut plates included).
 *
 *   GET  /order-lines/:id/opening-position   the stages (settings production_stages), the line's top two levels of
 *                                            pieces to tick, how many steps are opening already
 *   POST /order-lines/:id/opening-position   { stage, pieceIds?, units?, asOf?, dryRun? }
 *
 * WHAT AN OPENING STEP IS. state done, qty_good = its quantity, opening = 1, started/finished at the as-of time (or
 * now), and a cf_step_events row event = source = 'opening' that says who set it and to which stage. It is HISTORY:
 *   - readiness is not asked (no waits, no material, no production order release) — it was done, not started here;
 *   - nothing is posted: no plate consumed, no WIP lot joined or split, no offcut, no finished stock, no made_qty
 *     (productionLedgerService.ledgerOnSteps leaves opening steps out; stockFinished is never called);
 *   - no billing milestone (billingService counts it as not done) and it is not "done today" on the MD's pages.
 * The next real step treats it as done (evaluate() reads state), so the floor carries on from there. A real step
 * after it that joins children (a parent's first step) finds no WIP lot for an opening child and starts with what is
 * there (joinStep's rule for a child not made yet); only material on the real step itself must be reserved.
 * Reservations held by requirements on opening steps (a cut plate's plate) are NOT let go here — the answer counts
 * them, and Stores lets them go on the Material tab when the stock is really free.
 *
 * THE STAGE RULE. A stage is a list of operation codes; a step's stage is its operation's, and an operation in no
 * stage takes the stage of the step before it in its piece's flow (a leading one, of the first step after it that has
 * one; a flow with none at all counts as the first stage). A flow can visit an operation twice (GIRDER-SEGMENT:
 * … JACKBEND > MANDRILL > STIFFFIT … MANDRILL > STUDWELD > BLAST …), so "done up to stage X" means EVERY step of the
 * flow up to and including the LAST step whose stage is X or earlier, in flow order (sequence, then id) — a girder at
 * "Drill" has every fit/weld pass before its last drill done too, and its blasting not. Same flow, same cut: the rule
 * is decided per piece from its own steps, which are its flow's. ONE MORE RULE ON TOP: a parent assembled means
 * everything under it is done — once any step of a piece is in the opening position, every piece under it is done
 * through its whole flow (a plate's own drilling or QC never stays pending inside an assembled girder).
 *
 * WHAT IS LEFT ALONE. A step the floor has started or finished stays as it is (counted in the answer); a step put on
 * hold before it started is left on hold and counted on its own (leftHeld).
 * GOING BACK (a lower stage, or stage 0 = none) re-opens only steps an opening position set, and only while nothing
 * real has started after them — a later step of the same piece, or any step that waits for them (the next level's
 * join, a rule); otherwise it is refused in words and nothing changes.
 *
 * Set-based: one read of the release's pieces and steps, UPDATEs and INSERTs of up to 2,000 ids a statement, one
 * transaction (the route's withTransaction, which also clears the tracker cache).
 */
import { invalid, notFound } from '../lib/errors.js';
import { LOCKED_ORDER_STATUSES, revisedOrderMessage, latestRevisionSql } from './records.js';
import { getSettings } from './settingsService.js';

const CHUNK = 2000;
/** The pieces offered for ticking: the line's top pieces and the level under them (girders, segments). */
const PICK_LEVELS = 2;
/** Rows named in a dry run's answer. */
const ROWS_MAX = 500;

const chunks = (arr, n = CHUNK) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };
const pad = (n) => String(n).padStart(2, '0');

/**
 * Each step's stage index (0-based), for one piece's steps in flow order. `stageOf` maps an operation code to its
 * stage; an unknown code takes the previous step's stage, leading unknowns the first known stage after them, and a
 * flow with no known code at all is the first stage (0).
 */
export function stagesOfSteps(steps, stageOf) {
  const out = steps.map((s) => (stageOf.has(String(s.op_code ?? '').toUpperCase()) ? stageOf.get(String(s.op_code).toUpperCase()) : null));
  const firstKnown = out.find((x) => x != null) ?? 0;
  let prev = firstKnown;
  for (let i = 0; i < out.length; i += 1) { if (out[i] == null) out[i] = prev; else prev = out[i]; }
  return out;
}

/** How many of a piece's steps (from the start of its flow) are "up to stage X": through the last step whose stage ≤ X. */
export function cutOf(stageIdx, x) {
  let last = -1;
  for (let i = 0; i < stageIdx.length; i += 1) if (stageIdx[i] <= x) last = i;
  return last + 1;
}

/** The company's stages, numbered from 1 as the screen shows them. */
export async function stagesOf(db, companyId) {
  const s = await getSettings(db, companyId);
  return (s.production_stages ?? []).map((x, i) => ({ number: i + 1, name: x.name, ops: x.ops }));
}

/** input.stage → index 0-based, or -1 for "none" (0 / 'none'): a name (any case) or its number from 1. */
function stageIndex(stages, raw) {
  if (raw == null || raw === '') throw invalid('INVALID', 'Choose the stage the work has reached.');
  const t = String(raw).trim();
  if (/^\d+$/.test(t)) {
    const n = Number(t);
    if (n === 0) return -1;
    if (n > stages.length) throw invalid('INVALID', `There are ${stages.length} stages — choose one of them.`);
    return n - 1;
  }
  if (t.toLowerCase() === 'none') return -1;
  const i = stages.findIndex((s) => s.name.toLowerCase() === t.toLowerCase());
  if (i < 0) throw invalid('INVALID', `"${t}" is not a stage. The stages are: ${stages.map((s) => s.name).join(', ')}.`);
  return i;
}

/** asOf → { sql, params, text } for the steps' times; none = now. A date or a time with its zone; never in the future. */
export function asOfOf(raw, now = new Date()) {
  if (raw == null || String(raw).trim() === '') return { sql: 'NOW()', params: [], eventSql: 'NULL', eventParams: [], text: null };
  const t = String(raw).trim();
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) {
    if (Number.isNaN(Date.parse(`${t}T00:00:00Z`))) throw invalid('INVALID', 'That is not a date.');
    if (t > today) throw invalid('IN_FUTURE', 'The opening position cannot be as of a day still to come.');
    const v = `${t} 00:00:00`;
    return { sql: '?', params: [v], eventSql: '?', eventParams: [v], text: t };
  }
  if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(t)) throw invalid('INVALID', 'The as-of time needs its zone (for example 2026-09-29T10:30:00+05:30), or give a date.');
  const ms = Date.parse(t);
  if (!Number.isFinite(ms)) throw invalid('INVALID', 'That is not a date and time.');
  if (ms > now.getTime() + 60_000) throw invalid('IN_FUTURE', 'The opening position cannot be as of a time still to come.');
  const sec = Math.floor(ms / 1000);
  return { sql: 'FROM_UNIXTIME(?)', params: [sec], eventSql: 'FROM_UNIXTIME(?)', eventParams: [sec], text: new Date(ms).toISOString() };
}

/** The live release of a line of this company — the line itself checked first, so another company's line is "not found". */
async function releaseOfLine(db, companyId, lineId, { lock }) {
  const [[line]] = await db.query('SELECT id, line_no FROM cf_sales_order_lines WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, lineId]);
  if (!line) throw notFound('Order line');
  const [[r]] = await db.query(
    `SELECT r.id, r.order_id, r.order_line_id, r.quantity, UNIX_TIMESTAMP(r.created_at) AS release_epoch, o.code AS order_code, o.status AS order_status,
            o.revision AS order_revision, ${latestRevisionSql('o')} AS order_latest_revision, l.line_no
       FROM cf_production_releases r
       JOIN cf_sales_orders o ON o.id = r.order_id AND o.company_id = r.company_id
       JOIN cf_sales_order_lines l ON l.id = r.order_line_id AND l.company_id = r.company_id
      WHERE r.company_id = ? AND r.order_line_id = ? AND r.deleted_at IS NULL${lock ? ' FOR UPDATE' : ''}`,
    [companyId, lineId],
  );
  if (!r) throw invalid('NOT_RELEASED', `Line ${line.line_no} is not released to production — release it before setting where its work stands.`);
  if (LOCKED_ORDER_STATUSES.has(r.order_status)) {
    throw invalid('ORDER_LOCKED', r.order_status === 'revised' ? revisedOrderMessage(r.order_code, r.order_revision, r.order_latest_revision)
      : `Order ${r.order_code} is ${r.order_status} — nothing more is recorded on it.`);
  }
  return r;
}

/** The release's pieces and steps (steps in flow order per piece), in two reads. */
async function readRelease(db, companyId, releaseId, { lock }) {
  const [[items], [steps]] = await Promise.all([
    db.query(
      `SELECT pi.id, pi.parent_id, pi.piece_no, pi.quantity, pi.code, pi.depth, pi.sort_order, m.code AS item_code, m.name AS item_name
         FROM cf_production_items pi JOIN cf_master_records m ON m.id = pi.item_id AND m.company_id = pi.company_id
        WHERE pi.company_id = ? AND pi.release_id = ? AND pi.deleted_at IS NULL ORDER BY pi.sort_order, pi.id`,
      [companyId, releaseId],
    ),
    db.query(
      `SELECT s.id, s.production_item_id, s.sequence, s.state, s.held_from, s.quantity, s.qty_good, s.opening, o.code AS op_code
         FROM cf_production_steps s
         JOIN cf_production_items pi ON pi.id = s.production_item_id AND pi.company_id = s.company_id AND pi.deleted_at IS NULL
         JOIN cf_operations o ON o.id = s.operation_id AND o.company_id = s.company_id
        WHERE s.company_id = ? AND pi.release_id = ? AND s.deleted_at IS NULL
        ORDER BY s.production_item_id, s.sequence, s.id${lock ? ' FOR UPDATE' : ''}`,
      [companyId, releaseId],
    ),
  ]);
  return { items, steps };
}

/** Each piece's level (its top piece 1) and top piece, by walking up its parents (memoised). */
function shapeOf(items) {
  const byId = new Map(items.map((it) => [it.id, it]));
  const level = new Map();
  const topOf = new Map();
  const walk = (it) => {
    if (level.has(it.id)) return;
    const p = it.parent_id != null ? byId.get(it.parent_id) : null;
    if (!p) { level.set(it.id, 1); topOf.set(it.id, it.id); return; }
    walk(p);
    level.set(it.id, level.get(p.id) + 1);
    topOf.set(it.id, topOf.get(p.id));
  };
  for (const it of items) walk(it);
  return { level, topOf };
}

const nameOf = (it) => it.code ?? it.item_code ?? it.item_name ?? `piece ${it.id}`;

/** GET /order-lines/:id/opening-position — what the dialog needs. */
export async function openingPositionView(db, companyId, lineId) {
  const rel = await releaseOfLine(db, companyId, Number(lineId), { lock: false });
  const [stages, { items, steps }] = await Promise.all([stagesOf(db, companyId), readRelease(db, companyId, rel.id, { lock: false })]);
  const { level } = shapeOf(items);
  const childCount = new Map();
  for (const it of items) if (it.parent_id != null) childCount.set(it.parent_id, (childCount.get(it.parent_id) ?? 0) + 1);
  const tops = items.filter((it) => it.parent_id == null);
  return {
    lineId: rel.order_line_id,
    lineNo: rel.line_no,
    releaseId: rel.id,
    order: { id: rel.order_id, code: rel.order_code },
    quantity: Number(rel.quantity),
    units: tops.length > 1 ? tops.map((t, i) => ({ number: i + 1, id: t.id, code: nameOf(t) })) : [],
    stages,
    pieces: items.filter((it) => level.get(it.id) <= PICK_LEVELS).map((it) => ({
      id: it.id, parentId: it.parent_id, level: level.get(it.id), code: nameOf(it), name: it.item_name, qty: Number(it.quantity), children: childCount.get(it.id) ?? 0,
    })),
    steps: steps.length,
    openingSteps: steps.filter((s) => Number(s.opening) === 1).length,
    doneSteps: steps.filter((s) => s.state === 'done').length,
  };
}

/**
 * POST /order-lines/:id/opening-position — set (or, with dryRun, say what would be set) the line's opening position.
 * input { stage, pieceIds?: (id | 'p<id>')[], units?: number[] (1…), asOf?: 'YYYY-MM-DD' | ISO time with zone, dryRun? }
 */
export async function setOpeningPosition(db, c, lineId, input = {}) {
  const dryRun = input.dryRun === true || input.dryRun === 1 || input.dryRun === '1' || input.dryRun === 'true';
  const rel = await releaseOfLine(db, c.companyId, Number(lineId), { lock: !dryRun });
  const stages = await stagesOf(db, c.companyId);
  const x = stageIndex(stages, input.stage);
  const at = asOfOf(input.asOf);
  const { items, steps } = await readRelease(db, c.companyId, rel.id, { lock: !dryRun });

  // --- the pieces in scope: each one asked for and everything under it ------------------------------------------
  const byId = new Map(items.map((it) => [it.id, it]));
  const kids = new Map();
  for (const it of items) if (it.parent_id != null) { if (!kids.has(it.parent_id)) kids.set(it.parent_id, []); kids.get(it.parent_id).push(it.id); }
  const tops = items.filter((it) => it.parent_id == null);
  const { level, topOf } = shapeOf(items);
  const under = (ids) => {
    const out = new Set();
    const stack = [...ids];
    while (stack.length) { const id = stack.pop(); if (out.has(id)) continue; out.add(id); stack.push(...(kids.get(id) ?? [])); }
    return out;
  };
  const asked = Array.isArray(input.pieceIds) ? input.pieceIds.map((v) => Number(String(v).replace(/^p/, ''))) : [];
  if (asked.some((id) => !Number.isInteger(id) || id <= 0)) throw invalid('INVALID', 'Pieces are named by their tracker ids.');
  for (const id of asked) if (!byId.has(id)) throw notFound('Tracker piece');
  let scope = asked.length ? under(asked) : new Set(items.map((it) => it.id));
  // A line of several units: which ones (its top pieces, numbered in order). One grouped top piece is set as a whole.
  const units = Array.isArray(input.units) ? [...new Set(input.units.map(Number))] : [];
  if (units.length) {
    if (units.some((n) => !Number.isInteger(n) || n < 1)) throw invalid('INVALID', 'Units are numbered from 1.');
    if (tops.length === 1) {
      if (units.length !== 1 || units[0] !== 1) {
        throw invalid('GROUPED', `Line ${rel.line_no}'s ${Number(tops[0].quantity)} units are one row on the tracker, counted together — they are set as a whole.`);
      }
    } else {
      const bad = units.filter((n) => n > tops.length);
      if (bad.length) throw invalid('INVALID', `Line ${rel.line_no} has ${tops.length} units — there is no unit ${bad.join(', ')}.`);
      const unitIds = under(units.map((n) => tops[n - 1].id));
      scope = new Set([...scope].filter((id) => unitIds.has(id)));
    }
  }

  // --- what each step should be ------------------------------------------------------------------------------
  const stageOf = new Map();
  stages.forEach((s, i) => { for (const code of s.ops) stageOf.set(code.toUpperCase(), i); });
  const stepsOf = new Map();
  for (const s of steps) { if (!stepsOf.has(s.production_item_id)) stepsOf.set(s.production_item_id, []); stepsOf.get(s.production_item_id).push(s); }
  // Real work = the floor has started it (a hold of a step never started is not work).
  const real = (s) => Number(s.opening) !== 1
    && (s.state === 'in_progress' || s.state === 'done' || (s.state === 'on_hold' && s.held_from === 'in_progress'));
  const toMark = [];
  const toReopen = [];
  const counts = { steps: 0, mark: 0, markedUnderAssembled: 0, alreadyOpening: 0, alreadyDone: 0, leftStarted: 0, leftHeld: 0, reopen: 0 };
  const stageCount = stages.map(() => ({ mark: 0, reopen: 0 }));
  const refusedPieces = [];
  // A PARENT ASSEMBLED ⇒ EVERYTHING UNDER IT DONE (review, 2026-11-28): the cut is per piece's own flow, so a part
  // with a later-stage operation of its own (a plate's drilling, a part's QC) would stay pending under a girder whose
  // joining is now opening — a job the floor could start on a piece already inside an assembly (and the ledger would
  // then make its WIP lot from nothing). So once any step of a piece is in the opening position, every piece under it
  // is done through its WHOLE flow. Parents first (by level), so the rule runs down the tree.
  const fullUnder = new Set();
  const ordered = [...scope].sort((a, b) => (level.get(a) ?? 0) - (level.get(b) ?? 0) || a - b);
  for (const id of ordered) {
    const own = stepsOf.get(id) ?? [];
    const idx = stagesOfSteps(own, stageOf);
    const ownCut = x < 0 ? 0 : cutOf(idx, x);
    const full = fullUnder.has(id);
    const cut = full ? own.length : ownCut;
    if (full || cut > 0) for (const k of kids.get(id) ?? []) if (scope.has(k)) fullUnder.add(k);
    if (!own.length) continue;
    counts.steps += own.length;
    own.forEach((s, i) => {
      if (i < cut) {
        if (s.state === 'pending') {
          toMark.push({ s, stage: idx[i], item: id });
          stageCount[idx[i]].mark += 1;
          if (i >= ownCut) counts.markedUnderAssembled += 1;
        } else if (Number(s.opening) === 1) counts.alreadyOpening += 1;
        else if (s.state === 'done') counts.alreadyDone += 1;
        else if (s.state === 'on_hold' && s.held_from !== 'in_progress') counts.leftHeld += 1;
        else counts.leftStarted += 1;
      } else if (Number(s.opening) === 1) {
        toReopen.push({ s, stage: idx[i], item: id, i });
        stageCount[idx[i]].reopen += 1;
      }
    });
    // Going back on this piece: nothing real after the first step re-opened.
    const first = toReopen.find((r) => r.item === id);
    if (first && own.slice(first.i + 1).some(real)) refusedPieces.push(byId.get(id));
  }
  counts.mark = toMark.length;
  counts.reopen = toReopen.length;

  // Going back must not pull a step from under real work that waits for it (the next level's join, a rule).
  const problems = refusedPieces.slice(0, 8).map((it) => `${nameOf(it)}: a later step has real work recorded on it.`);
  if (refusedPieces.length > 8) problems.push(`… and ${refusedPieces.length - 8} more pieces.`);
  if (toReopen.length) {
    const stepById = new Map(steps.map((s) => [s.id, s]));
    const reopenIds = toReopen.map((r) => r.s.id);
    const reopenItems = [...new Set(toReopen.map((r) => r.item))];
    const waiting = [];
    for (const part of chunks(reopenIds)) {
      const [rows] = await db.query(
        'SELECT step_id FROM cf_step_dependencies WHERE company_id = ? AND deleted_at IS NULL AND target_step_id IN (?)', [c.companyId, part]);
      waiting.push(...rows);
    }
    for (const part of chunks(reopenItems)) {
      const [rows] = await db.query(
        'SELECT step_id FROM cf_step_dependencies WHERE company_id = ? AND deleted_at IS NULL AND target_item_id IN (?)', [c.companyId, part]);
      waiting.push(...rows);
    }
    // The waiting step may be in another release (another line's piece waits for this one): read those too.
    const elsewhere = [...new Set(waiting.map((w) => w.step_id).filter((sid) => !stepById.has(sid)))];
    for (const part of chunks(elsewhere)) {
      const [rows] = await db.query(
        `SELECT s.id, s.production_item_id, s.state, s.held_from, s.opening, pi.code, m.code AS item_code, m.name AS item_name
           FROM cf_production_steps s
           JOIN cf_production_items pi ON pi.id = s.production_item_id AND pi.company_id = s.company_id
           JOIN cf_master_records m ON m.id = pi.item_id AND m.company_id = pi.company_id
          WHERE s.company_id = ? AND s.id IN (?) AND s.deleted_at IS NULL`, [c.companyId, part]);
      for (const r of rows) { stepById.set(r.id, r); if (!byId.has(r.production_item_id)) byId.set(r.production_item_id, { id: r.production_item_id, code: r.code, item_code: r.item_code, item_name: r.item_name }); }
    }
    const blockedBy = new Set();
    for (const w of waiting) { const s = stepById.get(w.step_id); if (s && real(s)) blockedBy.add(s.production_item_id); }
    const named = [...blockedBy].map((id) => byId.get(id)).filter(Boolean);
    for (const it of named.slice(0, 8)) problems.push(`${nameOf(it)} has real work recorded that waits for these steps.`);
    if (named.length > 8) problems.push(`… and ${named.length - 8} more pieces.`);
  }
  const target = x < 0 ? 'before the first stage' : `"${stages[x].name}"`;
  if (problems.length) {
    throw invalid('REAL_WORK_AFTER', `The line cannot go back to ${target}: real work has been recorded after the opening position. Correct that work on the floor first.`, { problems });
  }

  // --- the answer: per stage and per row ---------------------------------------------------------------------
  const rowCount = new Map();
  const bump = (id, key) => {
    let it = byId.get(id);
    while (it) {
      if (level.get(it.id) <= PICK_LEVELS) { const r = rowCount.get(it.id) ?? { mark: 0, reopen: 0 }; r[key] += 1; rowCount.set(it.id, r); }
      it = it.parent_id != null ? byId.get(it.parent_id) : null;
    }
  };
  for (const m of toMark) bump(m.item, 'mark');
  for (const r of toReopen) bump(r.item, 'reopen');
  const rows = items.filter((it) => rowCount.has(it.id)).slice(0, ROWS_MAX).map((it) => ({
    id: `p${it.id}`, code: nameOf(it), level: level.get(it.id), top: `p${topOf.get(it.id)}`, ...rowCount.get(it.id),
  }));
  const deepest = Math.max(0, ...rows.map((r) => r.level));
  const named = rows.filter((r) => r.level === deepest && (r.mark || r.reopen)).map((r) => r.code);
  const namedText = named.length ? ` on ${named.slice(0, 8).join(', ')}${named.length > 8 ? ` and ${named.length - 8} more` : ''}` : '';
  const parts = [];
  if (toMark.length) parts.push(`${dryRun ? 'mark' : 'Marked'} ${toMark.length} step${toMark.length === 1 ? '' : 's'} done`);
  if (toReopen.length) parts.push(`${dryRun ? 're-open' : (toMark.length ? 're-opened' : 'Re-opened')} ${toReopen.length} opening step${toReopen.length === 1 ? '' : 's'}`);
  const left = (counts.leftStarted ? ` ${counts.leftStarted} step${counts.leftStarted === 1 ? '' : 's'} the floor has started are left as they are.` : '')
    + (counts.leftHeld ? ` ${counts.leftHeld} step${counts.leftHeld === 1 ? ' is' : 's are'} on hold before starting — left on hold; resume ${counts.leftHeld === 1 ? 'it' : 'them'} and set the position again to include ${counts.leftHeld === 1 ? 'it' : 'them'}.` : '');

  // Reservations held by requirements on the steps being marked (a cut plate's plate): counted, not touched.
  let held = 0;
  if (toMark.length) {
    for (const part of chunks(toMark.map((m) => m.s.id))) {
      const [[r]] = await db.query(
        `SELECT COUNT(DISTINCT q.id) AS n FROM cf_material_requirements q
           JOIN cf_stock_reservations v ON v.requirement_id = q.id AND v.company_id = q.company_id AND v.status = 'active' AND v.deleted_at IS NULL
          WHERE q.company_id = ? AND q.release_id = ? AND q.deleted_at IS NULL AND q.step_id IN (?)`,
        [c.companyId, rel.id, part],
      );
      held += Number(r?.n ?? 0);
    }
  }
  // A NEST shared across the scope (review item 4): pieces cut from one plate wait on its cut (origin 'nest'). Ticking
  // some of them and not the others marks the plate's cut done for one side only — said, not refused.
  const warnings = [];
  if ((asked.length || units.length) && toMark.length) {
    const markIds = toMark.map((m) => m.s.id);
    const itemOfStep = new Map(steps.map((s) => [s.id, s.production_item_id]));
    const outside = new Set();
    for (const part of chunks(markIds)) {
      const [rows] = await db.query(
        `SELECT step_id, target_step_id FROM cf_step_dependencies
          WHERE company_id = ? AND deleted_at IS NULL AND origin = 'nest' AND (step_id IN (?) OR target_step_id IN (?))`, [c.companyId, part, part]);
      for (const r of rows) for (const sid of [r.step_id, r.target_step_id]) {
        const it = itemOfStep.get(sid);
        if (it != null && !scope.has(it)) outside.add(it);
      }
    }
    if (outside.size) {
      const names = [...outside].slice(0, 6).map((id) => nameOf(byId.get(id)));
      warnings.push(`Some pieces chosen are cut from the same nested plate as ${outside.size} piece${outside.size === 1 ? '' : 's'} not chosen (${names.join(', ')}${outside.size > 6 ? ', …' : ''}). Their plate's cut is marked for the chosen ones only — choose those too if the whole plate was cut.`);
    }
  }
  const heldText = held ? ` ${held} material requirement${held === 1 ? '' : 's'} of those steps still hold reserved stock — let it go on the Material tab if that stock is really free.` : '';
  const answer = {
    dryRun,
    lineId: rel.order_line_id,
    releaseId: rel.id,
    stage: x < 0 ? { number: 0, name: null } : { number: x + 1, name: stages[x].name },
    asOf: at.text,
    beforeRelease: at.params.length > 0 && at.text != null && Date.parse(at.text.length === 10 ? `${at.text}T23:59:59` : at.text) / 1000 < Number(rel.release_epoch),
    counts: { ...counts, heldReservations: held },
    warnings,
    byStage: stages.map((s, i) => ({ number: i + 1, name: s.name, ...stageCount[i] })).filter((s) => s.mark || s.reopen),
    rows,
    message: parts.length
      ? `${dryRun ? 'Would ' : ''}${parts.join(' and ')}${namedText} (${x < 0 ? 'no stage' : `up to ${stages[x].name}`}).${left}${heldText}`
      : `Nothing to change — the ${asked.length ? 'pieces chosen are' : 'line is'} already at ${x < 0 ? 'no stage' : stages[x].name}.${left}`,
  };
  if (dryRun || (!toMark.length && !toReopen.length)) return answer;

  // --- write: a few statements, whatever the size of the line -------------------------------------------------
  const note = (text) => String(text).slice(0, 500);
  const markIds = toMark.map((m) => m.s.id);
  for (const part of chunks(markIds)) {
    await db.query(
      `UPDATE cf_production_steps SET state = 'done', qty_good = quantity, opening = 1, held_from = NULL,
              started_at = COALESCE(started_at, ${at.sql}), finished_at = ${at.sql}
        WHERE company_id = ? AND id IN (?) AND state = 'pending'`,
      [...at.params, ...at.params, c.companyId, part],
    );
  }
  const reopenIds = toReopen.map((r) => r.s.id);
  for (const part of chunks(reopenIds)) {
    await db.query(
      `UPDATE cf_production_steps SET state = 'pending', qty_good = 0, opening = 0, started_at = NULL, finished_at = NULL
        WHERE company_id = ? AND id IN (?) AND opening = 1`,
      [c.companyId, part],
    );
  }
  // The history: one 'opening' event a step, with the stage it was set to (or taken back to). `at` = the as-of
  // (in the frame NOW() writes, as the tracker's back-dated events); a take-back happens now (NULL = created_at).
  const stageName = x < 0 ? 'no stage' : stages[x].name;
  const events = async (list, qty, text, atSql, atParams) => {
    for (const part of chunks(list, 500)) {
      await db.query(
        `INSERT INTO cf_step_events (company_id, step_id, event, qty_good, note, created_by, at, source)
         VALUES ${part.map(() => `(?, ?, 'opening', ?, ?, ?, ${atSql}, 'opening')`).join(', ')}`,
        part.flatMap((r) => [c.companyId, r.s.id, qty(r.s), note(text), c.userId ?? null, ...atParams]),
      );
    }
  };
  await events(toMark, (s) => Number(s.quantity), `Opening position: done up to ${stageName}${at.text ? ` as of ${at.text}` : ''}.`, at.eventSql, at.eventParams);
  await events(toReopen, (s) => -Number(s.quantity), `Opening position taken back to ${stageName}.`, 'NULL', []);
  return answer;
}
