/**
 * freeze-flows-backfill.mjs — gives every order line that was frozen (locked) BEFORE init.sql §60
 * its own copy of each flow it uses (frozenFlowService.ensureLineFlowCopies).
 *
 * From §60 on, locking a line copies its flows and the line reads the copies. A line locked before
 * that has none, so until it is released it would still follow the catalog. This makes the copies
 * for it — of the flows AS THEY ARE TODAY: what the flow looked like on the day the line was locked
 * was never kept, so today is the earliest moment it can be frozen at.
 *
 *   node scripts/cf_kepl/freeze-flows-backfill.mjs --company 30005            (dry run: rolled back)
 *   node scripts/cf_kepl/freeze-flows-backfill.mjs --company 30005 --apply    (commits)
 *
 * WHICH LINES: every live line with locked_at set, of a live order — released ones too (a release
 * taken back returns the line to frozen-and-unreleased, and it must find its copies then).
 * WHAT IT PRINTS, per line: how many flows it uses, how many were copied now, how many it had.
 *
 * SAFE TO RE-RUN: a flow that already has its copy is never copied again — a second run copies
 * nothing. Release is the safety net for a line this missed (it makes the missing copies itself).
 * Round trips per line: the line's structure (one read per level) + ONE when nothing is missing,
 * eleven at most when something is — never one per flow or per step.
 *
 * NEEDS TM/s60.sql on the database first (it writes owner_order_line_id / source_flow_id).
 */
import { pathToFileURL } from 'url';

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The whole pass on a connection the caller owns (its transaction).
 * → { lines: [{ lineId, orderCode, lineNo, released, flows, copied, had }], totals: { lines, copied } }
 */
export async function backfillFrozenFlows(db, { companyId, log = console.log }) {
  const { ensureLineFlowCopies } = await import('../../apps/cf_erp/services/frozenFlowService.js');
  const c = { companyId, userId: null };
  const [lines] = await db.query(
    `SELECT l.id, l.line_no, o.code AS order_code, o.revision, o.status,
            EXISTS (SELECT 1 FROM cf_production_releases r WHERE r.company_id = l.company_id AND r.order_line_id = l.id AND r.deleted_at IS NULL) AS released
       FROM cf_sales_order_lines l
       JOIN cf_sales_orders o ON o.company_id = l.company_id AND o.id = l.order_id AND o.deleted_at IS NULL
      WHERE l.company_id = ? AND l.deleted_at IS NULL AND l.locked_at IS NOT NULL AND l.item_id IS NOT NULL
      ORDER BY o.code, o.revision, l.line_no, l.id`,
    [companyId],
  );
  log(`Company ${companyId}: ${plural(lines.length, 'frozen line')}.`);
  const out = { lines: [], totals: { lines: lines.length, copied: 0 } };
  for (const line of lines) {
    const r = await ensureLineFlowCopies(db, c, line.id);
    const rep = {
      lineId: line.id, orderCode: line.order_code, lineNo: line.line_no, released: !!Number(line.released),
      flows: r.flows.size, copied: r.copied, had: r.flows.size - r.copied,
    };
    out.lines.push(rep);
    out.totals.copied += r.copied;
    const label = `${line.order_code}${Number(line.revision) > 1 ? ` rev ${line.revision}` : ''} line ${line.line_no}`;
    const state = `${line.status}${rep.released ? ', released' : ''}`;
    log(`  ${label} (${state}): ${rep.copied ? `${plural(rep.copied, 'flow')} copied` : 'nothing to copy'}${rep.had ? ` — it already had ${rep.had}` : ''}${rep.flows ? '' : ' (no row of it names a flow)'}`);
  }
  log(`${plural(out.totals.copied, 'flow')} copied over ${plural(out.lines.filter((l) => l.copied).length, 'line')}.`);
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > -1 ? process.argv[i + 1] : undefined; };
  const COMPANY = Number(arg('company'));
  const APPLY = process.argv.includes('--apply');
  if (!Number.isInteger(COMPANY)) throw new Error('Usage: --company <id> [--apply]');
  const { pool } = await import('../../db.js');
  const db = await pool.getConnection();
  try {
    await db.beginTransaction();
    await backfillFrozenFlows(db, { companyId: COMPANY });
    if (APPLY) { await db.commit(); console.log('COMMITTED'); } else { await db.rollback(); console.log('DRY RUN — rolled back. Add --apply to keep it.'); }
  } catch (err) {
    await db.rollback().catch(() => {});
    console.error('ERROR', err.message);
    process.exitCode = 1;
  } finally {
    db.release();
    await pool.end();
  }
}
