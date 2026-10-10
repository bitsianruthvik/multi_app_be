/**
 * nestLineRunner.mjs — nest ONE order line here, on this machine, against whatever database the
 * connection points at, and (only when asked) leave the result as a finished run the server shows.
 * The engine behind scripts/cf_kepl/nest-line.mjs; a test drives it with its own connection.
 *
 * WHY. Production is a small instance (512 MB, a tenth of a CPU). An hour there buys what a few
 * minutes of a laptop's cores buy. The line is read from the SAME database, nested by the SAME
 * code (nestingService.planNesting → the worker pool), and — with `apply` — written as ONE row of
 * cf_nest_runs exactly as the server writes its own (nestRunService.insertFinishedRun): status
 * `ready`, the same demand fingerprint. So the screen shows it, a comparison finds it, and
 * accepting it is the server's own /accept, which verifies every plate against the database.
 *
 * NOTHING IS WRITTEN WITHOUT `apply`. With it, exactly one INSERT. The reads are planNesting's own
 * (a fixed number, whatever the size of the line) plus four: the line, its state, a live run, and
 * the state once more before the write.
 *
 * REFUSED, in words: an order or line that is not there; a line that is not frozen, is released,
 * or whose order is locked (nestingService.assertNestable — the server would refuse the accept);
 * a nesting run that is live on the line (its heartbeat is fresh): two answers to one question.
 */
import { invalid, notFound } from '../../../apps/cf_erp/lib/errors.js';
import { planNesting, requireLine, assertNestable, runBudgetMs, effortOf } from '../../../apps/cf_erp/services/nestingService.js';
import { planSectionNesting } from '../../../apps/cf_erp/services/sectionNestingService.js';
import { insertFinishedRun, STALE_MS } from '../../../apps/cf_erp/services/nestRunService.js';

export async function nestLine({ db, companyId, orderCode, lineNo = null, effort = 'standard', workers = null, apply = false, whole = false, budgetMs = null, startedBy = 'offline runner', say = () => {} }) {
  const level = effortOf(effort);
  const [lines] = await db.query(
    `SELECT l.id, l.line_no, o.id AS order_id, o.code
       FROM cf_sales_orders o JOIN cf_sales_order_lines l ON l.order_id = o.id AND l.company_id = o.company_id AND l.deleted_at IS NULL
      WHERE o.company_id = ? AND o.code = ? AND o.deleted_at IS NULL ORDER BY l.line_no`,
    [companyId, String(orderCode)],
  );
  if (!lines.length) throw notFound(`Order ${orderCode} (company ${companyId})`);
  const picked = lineNo == null ? (lines.length === 1 ? lines[0] : null) : lines.find((l) => Number(l.line_no) === Number(lineNo));
  if (!picked) {
    throw invalid('WHICH_LINE', lineNo == null
      ? `Order ${orderCode} has ${lines.length} lines (${lines.map((l) => l.line_no).join(', ')}) — say which one (--line).`
      : `Order ${orderCode} has no line ${lineNo}; its lines are ${lines.map((l) => l.line_no).join(', ')}.`);
  }
  const lineId = Number(picked.id);
  assertNestable(await requireLine(db, companyId, lineId));
  const [live] = await db.query(
    `SELECT run_uid, purpose FROM cf_nest_runs
      WHERE company_id = ? AND order_line_id = ? AND kind = 'auto' AND status = 'running' AND deleted_at IS NULL
        AND heartbeat_at IS NOT NULL AND heartbeat_at >= NOW(3) - INTERVAL ? SECOND LIMIT 1`,
    [companyId, lineId, STALE_MS / 1000],
  ).catch((e) => { if (e?.errno === 1146 || e?.errno === 1054) return [[]]; throw e; });
  if (live.length) throw invalid('RUN_BUSY', `A nesting run is working on line ${picked.line_no} of ${orderCode} on the server right now (${live[0].purpose}). Wait for it, or stop it there, before nesting the line here.`);

  const input = { effort: level, seed: 1, ...(whole ? { replaceImported: true } : {}) };
  const budget = Number(budgetMs) > 0 ? Number(budgetMs) : runBudgetMs(level);
  const startedAt = Date.now();
  const log = [];
  const note = (text) => { log.push({ at: new Date().toISOString(), text }); say(text); };
  const curve = [];
  let demand = null;
  note(`Started here (${level} effort, up to ${budget >= 60_000 ? `${Math.round(budget / 60_000)} min` : `${Math.round(budget / 1000)} s`}${workers ? `, ${workers} workers` : ''})`);
  const plan = await planNesting(db, companyId, lineId, {
    ...input, background: true, budgetMs: budget, workers: workers ?? null,
    onDemand: (d) => { demand = d; },
    onProgress: (e) => {
      if (e.text) note(e.text);
      if (e.best) {
        const last = curve.at(-1);
        if (!last || e.best.unplaced < last.unplaced || e.best.plates < last.plates || e.best.areaBoughtM2 < last.areaBoughtM2 - 1e-9) {
          curve.push({ atMs: Date.now() - startedAt, plates: e.best.plates, areaBoughtM2: e.best.areaBoughtM2, wastePct: e.best.wastePct, unplaced: e.best.unplaced });
          say(`  best so far: ${e.best.plates} plates, ${e.best.areaBoughtM2} m² bought, waste ${e.best.wastePct}%${e.best.unplaced ? `, ${e.best.unplaced} pieces not placed` : ''}  (${Math.round((Date.now() - startedAt) / 1000)} s)`);
        }
      }
    },
  });
  let sections = null;
  try { const sec = await planSectionNesting(db, companyId, lineId); if (sec.profiles.length) sections = sec; } catch (e) { note(`Sections not planned: ${e?.message ?? e}`); }
  const finishedAt = Date.now();
  const t = plan.totals ?? {};
  note(`Finished: ${t.plates ?? 0} plate${t.plates === 1 ? '' : 's'}, ${t.pieces ?? 0} pieces placed${t.wastePct != null ? `, ${t.wastePct}% waste` : ''}`);

  const out = {
    line: { id: lineId, lineNo: Number(picked.line_no), orderId: Number(picked.order_id), orderCode: picked.code },
    effort: level, budgetMs: budget, elapsedMs: finishedAt - startedAt, scope: whole ? 'line' : 'rest',
    plan, demand, curve, sections, applied: false, runId: null,
    totals: { plates: t.plates ?? 0, pieces: t.pieces ?? 0, unplaced: t.unplaced ?? 0, areaBoughtM2: Math.round((t.areaBought ?? 0) / 1000) / 1000, wastePct: t.wastePct ?? null, weightKg: t.weightKg ?? null, partsKg: t.partsKg ?? null },
    problems: plan.problems ?? [],
  };
  if (!apply) return out;
  if (!demand?.hash) throw invalid('NO_DEMAND', 'The plan did not say what it was asked (no demand fingerprint), so it cannot be kept as a run.');
  // The line as it is NOW: an hour may have gone by.
  assertNestable(await requireLine(db, companyId, lineId));
  const row = await insertFinishedRun(db, { companyId, lineId, plan, demand, input, scope: out.scope, startedAt, finishedAt, startedBy, log, sections, budgetMs: budget });
  return { ...out, applied: true, runId: row.runId, rowId: row.rowId, rowBytes: row.bytes };
}
