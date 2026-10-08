/**
 * rule_expression_test.mjs — operation times live on the rule (init.sql §49, 2026-10-08).
 * A machine rule carries its own work / setup expression (a number for a fixed time); saving one
 * replaces minutes or a linked formula; the old ways still work and clear the own expression; a
 * time that reads a record's own values (not item. / machine.) is refused in words.
 * Local only, one rolled-back transaction, every cf_ table re-counted.
 *
 *   cd multi_app_be && node scripts/cf_kepl/rule_expression_test.mjs
 */
import { pool } from '../../db.js';
import { createTimingRule, updateTimingRule, listTimingRules, evaluateRuleTimes } from '../../apps/cf_erp/services/operationService.js';

if (!/^(localhost|127\.0\.0\.1|::1)$/.test(process.env.DB_HOST ?? 'localhost')) throw new Error('Local only.');
const COMPANY = 2;
let passed = 0, failed = 0;
const ok = (label, cond, detail = '') => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && detail ? ` — ${detail}` : ''}`); cond ? passed++ : failed++; };
const refused = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
const [tables] = await pool.query("SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME LIKE 'cf\\_%' ORDER BY TABLE_NAME");
const counts = async () => (await pool.query(tables.map((t) => `SELECT '${t.name}' AS name,COUNT(*) AS n FROM \`${t.name}\``).join(' UNION ALL ')))[0];
const before = await counts();
const db = await pool.getConnection();
try {
  await db.beginTransaction();
  const c = { companyId: COMPANY, userId: null };
  const [[op]] = await db.query("SELECT id, code FROM cf_operations WHERE company_id = ? AND deleted_at IS NULL AND status = 'active' ORDER BY id LIMIT 1", [COMPANY]);
  const [[mc]] = await db.query("SELECT id FROM cf_machines WHERE company_id = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 1", [COMPANY]);
  const rule = await createTimingRule(db, c, op.id, { subjectType: 'machine', subjectId: mc.id, workExpression: 'item.HOLES * 0.35', setupExpression: '15', effectiveFrom: '2099-01-01' });
  ok('a new rule carries its own work expression', rule.work?.expression === 'item.HOLES * 0.35' && rule.work.formula?.id === null, JSON.stringify(rule.work));
  ok('…and a fixed setup as a number', rule.setup?.expression === '15', JSON.stringify(rule.setup));
  const [[row]] = await db.query('SELECT work_expression, setup_expression, work_formula_id, work_minutes FROM cf_operation_machine_rules WHERE id = ?', [rule.id]);
  ok('stored on the rule, no formula linked', row.work_expression === 'item.HOLES * 0.35' && row.work_formula_id === null && row.work_minutes === null, JSON.stringify(row));
  const reader = { number: (code) => (code === 'HOLES' ? 20 : null), table: () => null };
  const t = evaluateRuleTimes(rule, { item: reader, machine: { number: () => null, table: () => null } });
  ok('it is worked out: 20 holes × 0.35 = 7 min, setup 15', Math.abs(t.work.minutes - 7) < 1e-9 && t.setup.minutes === 15, JSON.stringify(t));
  let r2 = await updateTimingRule(db, c, rule.id, { workExpression: '12' });
  ok('changing it to a number', r2.work.expression === '12' && r2.setup.expression === '15', JSON.stringify([r2.work, r2.setup]));
  const bad = await refused(() => updateTimingRule(db, c, rule.id, { workExpression: 'LENGTH * 2' }));
  ok('a time reading a record\'s own value is refused in words', !!bad && /item\.X/.test(JSON.stringify(bad.problems ?? bad.message)), JSON.stringify(bad?.problems ?? bad?.message));
  const broken = await refused(() => updateTimingRule(db, c, rule.id, { workExpression: 'item.HOLES * (' }));
  ok('a formula that does not parse is refused', !!broken);
  r2 = await updateTimingRule(db, c, rule.id, { workMinutes: 4 });
  ok('the older minutes field still works and clears the own expression', r2.work.minutes === 4 && r2.work.expression === '4', JSON.stringify(r2.work));
  r2 = await updateTimingRule(db, c, rule.id, { setupExpression: '' });
  ok('an empty setup clears it (no setup)', r2.setup === null, JSON.stringify(r2.setup));
  const listed = (await listTimingRules(db, COMPANY, op.id)).find((x) => x.id === rule.id);
  ok('the rule list shows the same', listed?.work?.minutes === 4 && listed.setup === null);
} catch (e) {
  failed++;
  console.error('  ERROR', e.message, e.problems ? JSON.stringify(e.problems) : '');
} finally {
  await db.rollback();
  db.release();
  const after = await counts();
  const changed = after.filter((a) => before.find((b) => b.name === a.name)?.n !== a.n);
  ok('every cf_ table count is back', changed.length === 0, changed.map((x) => x.name).join(', '));
  await pool.end();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
}
