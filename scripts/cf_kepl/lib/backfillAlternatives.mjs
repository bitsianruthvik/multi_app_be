/**
 * backfillAlternatives.mjs — the engine of scripts/cf_kepl/backfill_ai_alternatives.mjs (§87, 2026-10-18): AI's
 * nesting of the uploaded pieces, stored as each line's alternative, for nestings uploaded before §87. The CLI hands in
 * the pool; scripts/cf_kepl/nest_alternative_test.mjs hands in its own connection (a rolled-back transaction).
 *
 *   mode 'dry'     the lines it would do; nothing nested, nothing written
 *   mode 'try'     nested here, the result said; nothing written
 *   mode 'commit'  nested and STORED (one INSERT of the run, one upsert of the line's alternative row)
 *
 * → [{ lineId, orderId, orderCode, lineNo, companyId, status: 'would' | 'has' | 'busy' | 'skipped' | 'tried' | 'stored' | 'failed', text, runId? }]
 */
import { linesToBackfill, readAlternative, runAlternative } from '../../../apps/cf_erp/services/nestAlternativeService.js';

export async function backfill({ db, companyId = null, orderIds = null, mode = 'dry', minutes = null, workers = null, say = () => {}, pack = null }) {
  const commit = mode === 'commit';
  const nest = commit || mode === 'try';
  const out = [];
  for (const l of await linesToBackfill(db, { companyId, orderIds })) {
    const base = { lineId: l.lineId, orderId: l.orderId, orderCode: l.orderCode, lineNo: l.lineNo, companyId: l.companyId };
    const head = `${l.orderCode} line ${l.lineNo} (company ${l.companyId}, order ${l.orderId}, line ${l.lineId}${l.title ? `, "${String(l.title).slice(0, 40)}"` : ''})`;
    const c = { companyId: l.companyId, userId: null, userName: 'backfill of AI alternatives' };
    const done = (status, text, extra = {}) => { out.push({ ...base, status, text: `${head}: ${text}`, ...extra }); say(`- ${head}: ${text}`); };
    try {
      // A run the SERVER is working on this line now: not here (two answers to one question; and the comparison's read
      // would pick a run it thinks lost up again in this process).
      const [live] = await db.query(
        "SELECT run_uid, purpose FROM cf_nest_runs WHERE company_id = ? AND order_line_id = ? AND kind = 'auto' AND status = 'running' AND deleted_at IS NULL LIMIT 1",
        [l.companyId, l.lineId],
      );
      if (live.length) { done('busy', `skipped — a nesting run (${live[0].purpose}) is working on it; run this again when it is done.`); continue; }
      if (!nest) {
        const alt = await readAlternative(db, l.companyId, l.lineId);
        done(alt?.runUid ? 'has' : 'would', alt?.runUid ? `has an alternative row (run ${alt.runUid}, main ${alt.main}) — checked again with --try / --commit.` : 'no AI alternative stored — would be nested.');
        continue;
      }
      const t0 = Date.now();
      const r = await runAlternative(db, c, l.lineId, { commit, workers, budgetMs: minutes ? minutes * 60_000 : null, say: (t) => say(`  ${t}`), pack });
      if (r.skipped) { done('skipped', `${r.reason}${r.runId ? ` (run ${r.runId}${commit ? ', the alternative row points at it' : ''})` : ''}`, { runId: r.runId ?? null }); continue; }
      done(commit ? 'stored' : 'tried', `AI nested ${r.pieces} pieces on ${r.plates} plates${r.unplaced ? `, ${r.unplaced} not placed` : ''} in ${Math.round((Date.now() - t0) / 1000)} s${commit ? ` — STORED as run ${r.runId}` : ' — not written'}.`, { runId: r.runId ?? null, plates: r.plates, pieces: r.pieces });
    } catch (e) {
      done('failed', `NOT DONE — ${e?.message ?? e}${e?.problems?.length ? ` (${e.problems.slice(0, 3).join('; ')})` : ''}`);
    }
  }
  return out;
}
