/**
 * cf_default_shifts.mjs — gives every ACTIVE machine that has no shift a default
 * day shift, through shiftService.createShift (same validation as the screen).
 * Machines that already have a shift are left alone, so a second run changes nothing.
 *
 * Default: "Day", Mon–Sat, 08:00–17:00, 60 min break (8 working hours a day).
 *
 *   CF_BRIDGE_COMPANY=30005 node scripts/cf_kepl/cf_default_shifts.mjs            # dry run: counts, writes nothing
 *   CF_BRIDGE_COMPANY=30005 node scripts/cf_kepl/cf_default_shifts.mjs --commit   # does it, in one transaction
 */
import path from 'path';
import { pathToFileURL } from 'url';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
const { createShift } = await imp('apps/cf_erp/services/shiftService.js');

const COMMIT = process.argv.includes('--commit');
const COMPANY = Number(process.env.CF_BRIDGE_COMPANY ?? 2);
const c = { companyId: COMPANY, userId: null };
const SHIFT = { name: 'Day', weekdays: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat'], startTime: '08:00', endTime: '17:00', breakMinutes: 60 };

const conn = await pool.getConnection();
try {
  await conn.beginTransaction();
  const [[all]] = await conn.query("SELECT COUNT(*) AS n FROM cf_machines WHERE company_id = ? AND status = 'active' AND deleted_at IS NULL", [COMPANY]);
  const [bare] = await conn.query(
    `SELECT m.id FROM cf_machines m
      WHERE m.company_id = ? AND m.status = 'active' AND m.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM cf_machine_shifts s WHERE s.machine_id = m.id AND s.company_id = m.company_id AND s.deleted_at IS NULL)
      ORDER BY m.id`, [COMPANY]);
  console.log(`company ${COMPANY}: ${all.n} active machines, ${bare.length} without a shift — ${COMMIT ? 'adding' : 'would add'} "${SHIFT.name}" ${SHIFT.weekdays.join('/')} ${SHIFT.startTime}–${SHIFT.endTime}, ${SHIFT.breakMinutes} min break`);
  if (COMMIT) {
    let done = 0;
    for (const m of bare) {
      await createShift(conn, c, m.id, SHIFT);
      if (++done % 100 === 0) console.log(`  ${done} / ${bare.length}`);
    }
    await conn.commit();
    console.log(`Committed: ${done} machines got the day shift.`);
  } else {
    await conn.rollback();
    console.log('Dry run — nothing written. Add --commit to mean it.');
  }
} catch (e) {
  await conn.rollback();
  console.error('FAILED, rolled back:', e.message);
  process.exitCode = 1;
} finally {
  conn.release();
  await pool.end();
}
