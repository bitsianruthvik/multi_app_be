/**
 * cut_piece_steel_gap_test.mjs — a cut piece whose size did not change still
 * gets the steel its part was given later (cutPlateService.fillBlankGaps).
 *
 *   cd multi_app_be && node scripts/cf_kepl/cut_piece_steel_gap_test.mjs
 *   CF_GAP_LINE=923 (default; company 2)
 *
 * The bug (prod Z-Code1, 2026-10-03): a blank made before its part's
 * IMPACT_CLASS was filled kept it empty for ever — every later derive found
 * the same four sizes and left the blank alone — so the Freeze checklist
 * counted one value missing while the Structure grid said all filled.
 *
 * Inside ONE rolled-back transaction: the line is unfrozen, one blank's
 * IMPACT_CLASS is removed, refreshCutPieces runs, and the value is back —
 * copied from its part, nothing else touched. Then a blank that HAS a value is
 * never overwritten. Last, every cf_ table has the rows it had.
 */
import { pool } from '../../db.js';
import '../../apps/cf_erp/services/codegenProvider.js';
import { refreshCutPieces } from '../../apps/cf_erp/services/cutPlateService.js';

if (!/^(localhost|127\.0\.0\.1|::1)$/.test(process.env.DB_HOST ?? 'localhost')) throw new Error('This suite is local only.');
const COMPANY = 2;
const LINE = Number(process.env.CF_GAP_LINE ?? 923);

let passed = 0;
let failed = 0;
function ok(label, condition, detail = '') {
  if (typeof label !== 'string' || typeof condition !== 'boolean') throw new Error('ok(label, condition) takes a string and then a boolean');
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${!condition && detail ? ` — ${detail}` : ''}`);
  condition ? passed++ : failed++;
}

const [tables] = await pool.query("SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME LIKE 'cf\\_%' ORDER BY TABLE_NAME");
const counts = async () => (await pool.query(tables.map((t) => `SELECT '${t.name}' AS name,COUNT(*) AS n FROM \`${t.name}\``).join(' UNION ALL ')))[0];
const before = await counts();
const db = await pool.getConnection();

try {
  await db.beginTransaction();
  const [[user]] = await db.query('SELECT id FROM users WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [COMPANY]);
  const c = { companyId: COMPANY, userId: user.id, canManage: true, isAdmin: false };
  await db.query('UPDATE cf_sales_order_lines SET locked_at = NULL, locked_by = NULL WHERE company_id = ? AND id = ?', [COMPANY, LINE]);
  const [[spec]] = await db.query("SELECT id FROM cf_specifications WHERE company_id = ? AND code = 'IMPACT_CLASS' AND deleted_at IS NULL", [COMPANY]);
  const impactOf = async (id) => (await db.query(
    "SELECT option_id, value_text FROM cf_spec_values WHERE company_id = ? AND subject_type = 'master' AND subject_id = ? AND specification_id = ? AND deleted_at IS NULL",
    [COMPANY, id, spec.id]))[0];
  const [blanks] = await db.query(
    "SELECT m.id, m.code FROM cf_master_records m JOIN cf_item_details i ON i.master_id = m.id WHERE m.company_id = ? AND i.owner_order_line_id = ? AND m.short_name = 'CUTPL' AND m.deleted_at IS NULL ORDER BY m.id",
    [COMPANY, LINE],
  );
  ok(`line ${LINE} has cut pieces`, blanks.length > 0);
  const victim = blanks[0];
  const was = await impactOf(victim.id);
  ok('the first one has an IMPACT_CLASS to start with', was.length === 1);

  const first = await refreshCutPieces(db, c, LINE);
  ok('a refresh with nothing missing fills nothing', first.reason === 'up_to_date' && (first.summary?.filled ?? 0) === 0, JSON.stringify(first));

  await db.query("UPDATE cf_spec_values SET deleted_at = NOW() WHERE company_id = ? AND subject_type = 'master' AND subject_id = ? AND specification_id = ? AND deleted_at IS NULL", [COMPANY, victim.id, spec.id]);
  ok('IMPACT_CLASS removed from one cut piece (the prod state)', (await impactOf(victim.id)).length === 0);

  const out = await refreshCutPieces(db, c, LINE);
  const now = await impactOf(victim.id);
  ok('refresh says the pieces were up to date and filled 1 value', out.reason === 'up_to_date' && out.summary?.filled === 1, JSON.stringify(out));
  ok('the cut piece has its IMPACT_CLASS back — the same option as before', now.length === 1 && now[0].option_id === was[0].option_id, JSON.stringify({ was, now }));

  const again = await refreshCutPieces(db, c, LINE);
  ok('a second refresh fills nothing (and writes no second row)', (again.summary?.filled ?? 0) === 0 && (await impactOf(victim.id)).length === 1);

  // A blank's own value is never overwritten, even when it differs from the part's.
  const [[other]] = await db.query('SELECT id FROM cf_spec_options WHERE company_id = ? AND specification_id = ? AND id <> ? AND deleted_at IS NULL LIMIT 1', [COMPANY, spec.id, was[0].option_id ?? 0]);
  if (other) {
    await db.query("UPDATE cf_spec_values SET option_id = ? WHERE company_id = ? AND subject_type = 'master' AND subject_id = ? AND specification_id = ? AND deleted_at IS NULL", [other.id, COMPANY, victim.id, spec.id]);
    await refreshCutPieces(db, c, LINE);
    ok('a value the cut piece already holds is left as it is', (await impactOf(victim.id))[0]?.option_id === other.id);
  }
} catch (err) {
  failed++;
  console.error('\nERROR', err);
} finally {
  await db.rollback();
  db.release();
}

const after = await counts();
const drift = after.filter((a) => Number(a.n) !== Number(before.find((b) => b.name === a.name)?.n));
console.log('\nRolled back');
ok('every cf_ table has the rows it had', drift.length === 0, drift.map((d) => d.name).join(', '));
const [[l]] = await pool.query('SELECT locked_at FROM cf_sales_order_lines WHERE id = ?', [LINE]);
ok(`line ${LINE} is frozen again (as it was)`, l.locked_at != null);
console.log(`\n${passed} passed, ${failed} failed`);
await pool.end();
process.exit(failed ? 1 : 0);
