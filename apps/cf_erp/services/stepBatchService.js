/**
 * stepBatchService.js — CF_ERP. Finishing many floor steps at once (2026-10-31: "a 9 m girder releases ~615 steps
 * and the Tracker records them one by one"). For catching up and go-live data entry by a production manager; the
 * floor's own Machine log (floorService) stays as it is.
 *
 *   POST /production-steps/finish   { stepIds: [..], note?, at? }   finishSteps
 *
 * EVERY STEP GOES THROUGH THE TRACKER'S OWN SERVICE FUNCTIONS — releaseService.startStep (when it is not started yet)
 * and recordProgress with its remaining quantity good — so every rule a step started and finished by hand meets is
 * met here too: the order open, the step ready (its waits done, its material reserved, its production order
 * released), not on hold, never more good than is left, the plan flag, the production ledger, the finished piece
 * into stock. Nothing is forked.
 *
 * ONE TRANSACTION PER STEP: one refusal does not undo the rest. The answer lists what was done and what was
 * refused, with the reason in the tracker's own words.
 *
 * IN THE ORDER THE WAITS ALLOW, IN WAVES. The releases of the steps are evaluated (one tracker read per wave, on the
 * shared pool and its cache); every selected step that is ready (or already in progress) is finished; then the
 * releases are evaluated again, and a selected step that became ready because an earlier one finished is taken in
 * the next wave. It ends when a wave finds nothing to do. A selected step still waiting then is refused with what it
 * waits for.
 *
 * ROUND TRIPS (TiDB ~49 ms each). Per wave: the tracker read (~8, run side by side). Once: the plan check of every
 * selected step (unplannedOf, ~4). Per step: BEGIN, the step locked, the start (UPDATE + event), the progress (step
 * locked, UPDATE + event), the ledger (posted once, after both — the floor's set-based path does the same), the
 * stock check, COMMIT. The release's evaluation is handed to startStep (`batch.evaluated`), which uses it only while
 * it agrees with the row it has just locked — otherwise it reads it again, as a single start does.
 */
import { invalid } from '../lib/errors.js';
import { pool, withTransaction } from '../lib/db.js';
import { evaluatedTracker, startStep, recordProgress } from './releaseService.js';
import { unplannedOf } from './planCheckService.js';

/** One request finishes at most this many steps. */
export const MAX_BATCH_STEPS = 200;
/** A safety net: a release's waits are never deeper than this many waves. */
const MAX_WAVES = 200;
const EPS = 1e-9;

const round6 = (n) => Math.round(Number(n) * 1e6) / 1e6;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const reasonOf = (e) => [e?.message ?? String(e), ...(Array.isArray(e?.problems) ? e.problems : [])].filter(Boolean).join(' ');

/**
 * POST /production-steps/finish — starts (when not started) and finishes each step with its remaining quantity good.
 *
 *   input.stepIds  the steps, any order (at most MAX_BATCH_STEPS; a repeat counts once)
 *   input.note     said on every event written (optional)
 *   input.at       when it was done (readAt: with its zone, not in the future, not before the release)
 *
 * → { done: [{ stepId, label, good, wave }], refused: [{ stepId, label, reason }], waves, message }
 *   `opts.db` / `opts.tx` replace the pool and withTransaction (a test runs everything in its own transaction).
 */
export async function finishSteps(c, input = {}, opts = {}) {
  const readDb = opts.db ?? pool;
  const tx = opts.tx ?? withTransaction;
  const raw = Array.isArray(input.stepIds) ? input.stepIds : [];
  const ids = [...new Set(raw.map(Number))];
  if (!ids.length) throw invalid('NO_STEPS', 'Say which steps to finish (stepIds).');
  if (ids.some((x) => !Number.isInteger(x) || x <= 0)) throw invalid('INVALID', 'Every step is named by its id, a whole number.');
  if (ids.length > MAX_BATCH_STEPS) throw invalid('TOO_MANY', `One request finishes at most ${MAX_BATCH_STEPS} steps, and this one names ${ids.length}. Finish them in parts.`);

  // The releases the steps belong to (one read): a step of another company or deleted is refused by name.
  const [rows] = await readDb.query(
    `SELECT s.id, pi.release_id FROM cf_production_steps s
       JOIN cf_production_items pi ON pi.id = s.production_item_id AND pi.deleted_at IS NULL
      WHERE s.company_id = ? AND s.id IN (?) AND s.deleted_at IS NULL`,
    [c.companyId, ids],
  );
  const releaseOf = new Map(rows.map((r) => [Number(r.id), Number(r.release_id)]));
  const done = [];
  const refused = [];
  const labelOf = new Map();
  for (const id of ids) if (!releaseOf.has(id)) refused.push({ stepId: id, label: null, reason: 'Step not found.' });
  const open = new Set(ids.filter((id) => releaseOf.has(id)));
  const releaseIds = [...new Set(releaseOf.values())];
  // The plan check of every step at once (startStep would ask it per step).
  const unplanned = open.size ? new Set((await unplannedOf(readDb, c.companyId, [...open])).keys()) : new Set();
  const note = input.note == null || String(input.note).trim() === '' ? undefined : String(input.note);
  const at = input.at == null || input.at === '' ? undefined : input.at;

  let waves = 0;
  while (open.size && waves < MAX_WAVES) {
    const data = await evaluatedTracker(readDb, c.companyId, releaseIds);
    if (!data) break;
    const label = (s) => `${data.itemById.get(s.production_item_id)?._label ?? ''} · ${s._opLabel ?? s.op_name}`;
    // In the release's own order: piece, then sequence (the order the tracker reads them in).
    const mine = data.steps.filter((s) => open.has(s.id));
    for (const s of mine) labelOf.set(s.id, label(s));
    const now = mine.filter((s) => s._status === 'ready' || s._status === 'in_progress');
    // A step already done is not work: it is said, not counted as done here.
    for (const s of mine.filter((x) => x._status === 'done')) {
      open.delete(s.id);
      refused.push({ stepId: s.id, label: label(s), reason: 'It is already done.' });
    }
    if (!now.length) break;
    waves += 1;
    for (const s of now) {
      open.delete(s.id);
      const left = round6(Number(s.quantity) - Number(s.qty_good));
      try {
        const good = await tx(async (db) => {
          if (s.state === 'pending') {
            await startStep(db, c, s.id, { view: 'none', note, at }, { evaluated: data, unplanned, ledger: left <= EPS });
          }
          if (left <= EPS) return 0;
          await recordProgress(db, c, s.id, { view: 'none', good: left, note, at });
          return left;
        });
        done.push({ stepId: s.id, label: label(s), good, wave: waves });
      } catch (e) {
        refused.push({ stepId: s.id, label: label(s), reason: reasonOf(e) });
      }
    }
  }

  // What is still open waits for something no step of this batch finished: said with what it waits for.
  if (open.size) {
    const data = await evaluatedTracker(readDb, c.companyId, releaseIds);
    const byId = new Map((data?.steps ?? []).map((s) => [s.id, s]));
    for (const id of open) {
      const s = byId.get(id);
      if (!s) { refused.push({ stepId: id, label: labelOf.get(id) ?? null, reason: 'Step not found.' }); continue; }
      const why = s._status === 'not_ready' ? (s._blockers ?? []).map((b) => b.text).join(' ')
        : s._status === 'on_hold' ? 'It is on hold — resume it first.' : `It is ${String(s._status).replace('_', ' ')}.`;
      refused.push({ stepId: id, label: labelOf.get(id) ?? `${data.itemById.get(s.production_item_id)?._label ?? ''} · ${s._opLabel ?? s.op_name}`, reason: `It cannot start yet. ${why}`.trim() });
    }
  }

  const order = new Map(ids.map((id, i) => [id, i]));
  refused.sort((a, b) => order.get(a.stepId) - order.get(b.stepId));
  const message = [
    done.length ? `Finished ${plural(done.length, 'step', 'steps')}${waves > 1 ? ` in ${waves} rounds (steps that waited for others in the selection went after them)` : ''}.` : 'No step was finished.',
    refused.length ? `${plural(refused.length, 'step was', 'steps were')} not: ${refused.length === 1 ? refused[0].reason : 'each says why.'}` : '',
  ].filter(Boolean).join(' ');
  return { done, refused, waves, message };
}
