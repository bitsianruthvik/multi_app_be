/**
 * operation_list_test.mjs — GET /operations (listOperations) carries each operation's MAIN rule for the simple list:
 * a rule on a machine type before one on a machine, a rule valid today before a dated-out one, ruleCount for "+N more rules",
 * null for an operation with none; and it costs a fixed number of reads however many operations there are.
 *
 *   cd multi_app_be && node scripts/cf_kepl/operation_list_test.mjs      (CF_OL_COMPANY=2 default)
 *
 * Everything happens inside one transaction that is rolled back, and every cf_ table is re-counted at the end.
 */
import { pool } from '../../db.js';
import { listOperations, mainRuleOf } from '../../apps/cf_erp/services/operationService.js';

if (!/^(localhost|127\.0\.0\.1|::1)$/.test(process.env.DB_HOST ?? 'localhost')) throw new Error('This suite is local only.');
const COMPANY = Number(process.env.CF_OL_COMPANY ?? 2);
const T = `OL${Date.now().toString(36).toUpperCase()}_`;
let passed = 0; let failed = 0;
function ok(label, condition, detail = '') {
  if (typeof label !== 'string' || typeof condition !== 'boolean') throw new Error('ok(label, condition) takes a string and then a boolean');
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${!condition && detail ? ` — ${detail}` : ''}`);
  condition ? passed++ : failed++;
}
const [tables] = await pool.query("SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME LIKE 'cf\_%' ORDER BY TABLE_NAME");
const counts = async () => (await pool.query(tables.map((t) => `SELECT '${t.name}' AS name,COUNT(*) AS n FROM \`${t.name}\``).join(' UNION ALL ')))[0];
const before = await counts();
const conn = await pool.getConnection();
const log = [];
const db = new Proxy(conn, { get: (t, p) => (p === 'query' ? (...a) => { log.push(String(typeof a[0] === 'string' ? a[0] : a[0]?.sql ?? '')); return t.query(...a); } : Reflect.get(t, p)) });
try {
  await conn.beginTransaction();
  const ins = async (table, body) => { const [r] = await conn.query(`INSERT INTO ${table} SET ?`, { company_id: COMPANY, ...body }); return r.insertId; };
  const node = (code, name, parent_id = null, depth = 0) => ins('cf_classification_nodes', { code: `${T}${code}`, name: `${T}${name}`, scope: 'machine', parent_id, depth });
  const fam = await node('F', 'Family');
  const sub = await node('S', 'Sub', fam, 1);
  const mc = await ins('cf_machines', { code: `${T}M1`, name: `${T}M1`, classification_id: sub });
  const formula = await ins('cf_formulas', { code: `${T}RATE`, name: `${T} rate`, expression: 'item.CUT_LENGTH / 1000 * 2.8' });
  const op = (c) => ins('cf_operations', { code: `${T}${c}`, name: `${T} ${c}` });
  const [none, one, many, dated] = [await op('NONE'), await op('ONE'), await op('MANY'), await op('DATED')];
  const rule = (operation_id, subject_type, subject_id, body = {}) => ins('cf_operation_machine_rules', { operation_id, subject_type, subject_id, eligible: 1, ...body });
  await rule(one, 'classification', sub, { setup_minutes: 12, work_formula_id: formula });
  await rule(many, 'machine', mc, { work_minutes: 0.4 });                        // inserted FIRST, still not the main rule
  await rule(many, 'classification', sub, { setup_minutes: 5, work_minutes: 0.5 });
  await rule(many, 'classification', fam, { work_minutes: 9, eligible: 0 });
  await rule(dated, 'classification', sub, { work_minutes: 1, effective_to: '2001-01-01' });
  await rule(dated, 'classification', fam, { work_minutes: 2 });

  const rows = await listOperations(db, COMPANY, { search: T });
  const by = Object.fromEntries(rows.map((r) => [r.code.slice(T.length), r]));
  ok('four operations listed', rows.length === 4, String(rows.length));
  ok('no rule: mainRule null, ruleCount 0', by.NONE.mainRule === null && by.NONE.ruleCount === 0);
  ok('one rule: its machine type, setup minutes and work formula (code + expression)',
    by.ONE.mainRule?.subject.type === 'classification' && by.ONE.mainRule.subject.name === `${T}Sub` && by.ONE.mainRule.setup?.minutes === 12
    && by.ONE.mainRule.work?.formula?.code === `${T}RATE` && by.ONE.mainRule.work.formula.expression === 'item.CUT_LENGTH / 1000 * 2.8' && by.ONE.ruleCount === 1);
  ok('several rules: ruleCount says how many, the main one is on a machine type (not the machine), eligible, shallowest',
    by.MANY.ruleCount === 3 && by.MANY.mainRule?.subject.type === 'classification' && by.MANY.mainRule.subject.id !== fam && by.MANY.mainRule.work?.minutes === 0.5,
    JSON.stringify(by.MANY.mainRule));
  ok('a rule valid today beats a dated-out one', by.DATED.mainRule?.work?.minutes === 2 && by.DATED.ruleCount === 2, JSON.stringify(by.DATED.mainRule));
  ok('mainRuleOf of nothing is null', mainRuleOf([]) === null);

  log.length = 0;
  await listOperations(db, COMPANY, { search: T });
  ok('the list costs two reads however many operations (no per-row call)', log.length === 2, String(log.length));
  log.length = 0;
  await listOperations(db, COMPANY, {});
  ok('...also unfiltered', log.length === 2, String(log.length));
} catch (e) {
  failed++;
  console.error('\nFAILED with an exception:', e.message, e.stack?.split('\n').slice(1, 4).join(' | '));
} finally {
  await conn.rollback(); conn.release();
  const after = await counts();
  const changed = after.filter((a) => before.find((b) => b.name === a.name)?.n !== a.n);
  ok('every cf_ table count is back to where it was', changed.length === 0, changed.map((x) => x.name).join(', '));
  await pool.end();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
}
