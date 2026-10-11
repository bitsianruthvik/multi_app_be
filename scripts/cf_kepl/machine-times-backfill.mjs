/**
 * machine-times-backfill.mjs — init.sql §58 (TM/s58.sql). Production steps that already carry a
 * machine (cf_production_steps.machine_id — the floor wrote it when the step started) get the
 * MACHINE time they would have been given had §58 existed: the step's rule worked out with that
 * machine's own values over its type's (timeEstimateService.estimateOnMachine — the one writer).
 * The standard time (est_*) is never touched.
 *
 *   node scripts/cf_kepl/machine-times-backfill.mjs --company 30005            (dry run: rolled back)
 *   node scripts/cf_kepl/machine-times-backfill.mjs --company 30005 --apply    (commits)
 *
 * Re-running changes nothing. A step its machine has no answer for is LEFT on the standard time and
 * listed — it is history (the work was done there), so it is not taken off the machine.
 * One order line at a time: about 15 round trips a line, whatever its size.
 */
import { pathToFileURL } from 'url';

/**
 * The work, on any connection (the test suite runs it inside its own rolled-back transaction).
 * → { lines, steps, written, changed, minutesBefore, minutesAfter, cannot: [sentence] }
 */
export async function backfill(db, companyId, { apply = false, log = () => {} } = {}) {
  const { estimateOnMachine } = await import('../../apps/cf_erp/services/timeEstimateService.js');
  const [rows] = await db.query(
    `SELECT s.id, r.order_line_id, o.code AS order_code, ol.line_no
       FROM cf_production_steps s
       JOIN cf_production_items pi ON pi.company_id = s.company_id AND pi.id = s.production_item_id AND pi.deleted_at IS NULL
       JOIN cf_production_releases r ON r.company_id = pi.company_id AND r.id = pi.release_id AND r.deleted_at IS NULL
       JOIN cf_sales_order_lines ol ON ol.id = r.order_line_id
       JOIN cf_sales_orders o ON o.id = r.order_id
      WHERE s.company_id = ? AND s.deleted_at IS NULL AND s.machine_id IS NOT NULL
        AND (s.mach_machine_id IS NULL OR s.mach_machine_id <> s.machine_id)
      ORDER BY r.order_line_id, s.id`,
    [companyId],
  );
  const byLine = new Map();
  for (const r of rows) {
    if (!byLine.has(r.order_line_id)) byLine.set(r.order_line_id, { label: `${r.order_code} line ${r.line_no}`, ids: [] });
    byLine.get(r.order_line_id).ids.push(r.id);
  }
  const out = { lines: byLine.size, steps: rows.length, written: 0, changed: 0, minutesBefore: 0, minutesAfter: 0, cannot: [] };
  for (const line of byLine.values()) {
    // machineId undefined = "the machine each step already has"; refuse false = report, never throw.
    const r = await estimateOnMachine(db, { companyId }, line.ids, undefined, { apply, refuse: false });
    out.written += apply ? r.written : r.steps.filter((x) => x.machine && !x.skipped).length;
    out.changed += r.changed;
    out.minutesBefore += r.minutesBefore;
    out.minutesAfter += r.minutesAfter;
    out.cannot.push(...r.cannot);
    log(`  ${line.label}: ${line.ids.length} steps with a machine, ${r.changed} change their time (${r.minutesBefore} → ${r.minutesAfter} min)${r.cannot.length ? `, ${r.cannot.length} the machine has no answer for` : ''}`);
  }
  out.minutesBefore = Math.round(out.minutesBefore * 1000) / 1000;
  out.minutesAfter = Math.round(out.minutesAfter * 1000) / 1000;
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
  const COMPANY = Number(arg('company'));
  const APPLY = process.argv.includes('--apply');
  if (!Number.isInteger(COMPANY) || COMPANY <= 0) throw new Error('Usage: --company <id> [--apply]');
  const { pool } = await import('../../db.js');
  const db = await pool.getConnection();
  try {
    await db.beginTransaction();
    const r = await backfill(db, COMPANY, { apply: APPLY, log: console.log });
    console.log(`${r.lines} lines · ${r.steps} steps with a machine and no machine time · ${r.changed} change their time · ${r.minutesBefore} → ${r.minutesAfter} min`);
    for (const s of r.cannot.slice(0, 30)) console.log(`  no answer: ${s}`);
    if (r.cannot.length > 30) console.log(`  … and ${r.cannot.length - 30} more`);
    if (APPLY) { await db.commit(); console.log(`COMMITTED — ${r.written} steps written`); } else { await db.rollback(); console.log('DRY RUN — nothing written. Add --apply to keep it.'); }
  } catch (err) {
    await db.rollback().catch(() => {});
    console.error('ERROR', err.message);
    process.exitCode = 1;
  } finally {
    db.release();
    await pool.end();
  }
}
