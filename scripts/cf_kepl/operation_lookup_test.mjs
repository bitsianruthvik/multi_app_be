/** Bulk operation/machine lookups against the unchanged serial resolver.
 * Owned fixtures, local only, one rolled-back transaction; every CF table recounted.
 * Run from multi_app_be: node scripts/cf_kepl/operation_lookup_test.mjs
 */
import { pool } from '../../db.js';
import { insertRows } from '../../apps/cf_erp/lib/db.js';
import { machinesForOperation, operationsForMachine, resolveTiming } from '../../apps/cf_erp/services/operationService.js';

if (!/^(localhost|127\.0\.0\.1|::1)$/.test(process.env.DB_HOST ?? 'localhost')) throw new Error('This suite is local only.');
const company = Number(process.env.CF_LOOKUP_COMPANY ?? 2);
const tag = `OL${Date.now().toString(36).toUpperCase()}`;
const [tables] = await pool.query("SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME LIKE 'cf\\_%' ORDER BY TABLE_NAME");
const counts = async () => (await pool.query(tables.map((t) => `SELECT '${t.name}' AS name,COUNT(*) AS n FROM \`${t.name}\``).join(' UNION ALL ')))[0];
const before = await counts();
const db = await pool.getConnection();
let passed = 0, failed = 0;
function ok(label, condition) {
  if (typeof label !== 'string' || typeof condition !== 'boolean') throw new Error('ok needs label, boolean');
  console.log(`${condition ? 'PASS' : 'FAIL'} ${label}`);
  condition ? passed++ : failed++;
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const measured = async (fn) => {
  let queries = 0;
  const meter = { query: (...args) => { queries++; return db.query(...args); } };
  const result = await fn(meter);
  return { result, queries };
};
try {
  await db.beginTransaction();
  const [[other]] = await db.query('SELECT id FROM companies WHERE id <> ? ORDER BY id LIMIT 1', [company]);
  if (!other) throw new Error('A second local tenant is required.');
  const insert = async (table, body) => {
    const [r] = await db.query(`INSERT INTO ${table} SET ?`, body);
    return r.insertId;
  };
  const node = (suffix, parent_id = null, depth = 0, extra = {}) => insert('cf_classification_nodes', {
    company_id: company, code: `${tag}-${suffix}`, name: `${tag} ${suffix}`, scope: 'machine', parent_id, depth, ...extra,
  });
  const family = await node('F');
  const sub = await node('S', family, 1);
  const variant = await node('V', sub, 2);
  const otherLeaf = await node('OTHER');
  const deadParent = await node('DEADP');
  const orphan = await node('ORPHAN', deadParent, 1);
  const foreign = await node('FOREIGN', null, 0, { company_id: other.id });
  await db.query('UPDATE cf_classification_nodes SET deleted_at=NOW() WHERE id=?', [deadParent]);
  const formula = await insert('cf_formulas', { company_id: company, code: `${tag}-FORMULA`, name: `${tag} formula`, expression: 'item.LENGTH / 10' });
  const operation = (suffix, extra = {}) => insert('cf_operations', { company_id: company, code: `${tag}-${suffix}`, name: `${tag} ${suffix}`, ...extra });
  const main = await operation('MAIN');
  const empty = await operation('EMPTY');
  const inactive = await operation('INACTIVE', { status: 'inactive' });
  const deleted = await operation('DELETED', { deleted_at: new Date() });
  const foreignOp = await operation('FOREIGN', { company_id: other.id });
  const extraOps = [];
  for (let i = 0; i < 24; i++) extraOps.push(await operation(`EXTRA${String(i).padStart(2, '0')}`));
  await insertRows(db, 'cf_machines', ['company_id', 'code', 'name', 'classification_id'],
    Array.from({ length: 505 }, (_, i) => [company, `${tag}-M${String(i).padStart(3, '0')}`, `${tag} machine ${i}`, [family, sub, variant, otherLeaf, orphan][i % 5]]));
  const machine = (suffix, classification_id, extra = {}) => insert('cf_machines', { company_id: company, code: `${tag}-${suffix}`, name: `${tag} ${suffix}`, classification_id, ...extra });
  const excludedId = await machine('EXCLUDED', variant);
  const overrideId = await machine('OVERRIDE', variant);
  const inactiveId = await machine('MINACTIVE', variant, { status: 'inactive' });
  const deletedId = await machine('MDELETED', variant, { deleted_at: new Date() });
  const foreignId = await machine('MFOREIGN', foreign, { company_id: other.id });
  const rule = (operation_id, subject_id, extra = {}) => insert('cf_operation_machine_rules', {
    company_id: company, operation_id, subject_type: 'classification', subject_id, work_minutes: 10, ...extra,
  });
  await rule(main, family);
  await rule(main, sub, { work_minutes: 20 });
  await rule(main, variant, { work_minutes: 30 });
  await rule(main, variant, { work_minutes: 40, effective_from: '2026-09-01', effective_to: '2026-09-30' });
  await rule(main, variant, { work_minutes: 80, effective_from: '2026-10-01' });
  await rule(main, variant, { work_minutes: 90, effective_from: '2026-08-01', effective_to: '2026-08-31' });
  await rule(main, variant, { work_minutes: 99, effective_from: '2026-09-20', deleted_at: new Date() });
  await rule(main, excludedId, { subject_type: 'machine', eligible: 0, work_minutes: null });
  await rule(main, overrideId, { subject_type: 'machine', work_minutes: null, work_formula_id: formula, setup_formula_id: formula });
  await rule(main, deadParent, { work_minutes: 999 });
  // Same subject number under another tenant must never enter the result.
  await rule(foreignOp, variant, { company_id: other.id, work_minutes: 999 });
  await rule(inactive, family);
  await rule(deleted, family);
  for (const op of extraOps) await rule(op, family, { setup_minutes: 2 });

  const [machines] = await db.query("SELECT * FROM cf_machines WHERE company_id=? AND deleted_at IS NULL AND status='active' ORDER BY code", [company]);
  const [operations] = await db.query("SELECT * FROM cf_operations WHERE company_id=? AND deleted_at IS NULL AND status='active' ORDER BY code", [company]);
  // These are the original serial loops. Capture their complete shaped output
  // before invoking either replacement, including exclusions and sort order.
  const serialMachines = async (date) => {
    const out = [];
    for (const m of machines) {
      const r = await resolveTiming(db, company, main, m, date);
      if (r) out.push({ machine: { id: m.id, code: m.code, name: m.name }, eligible: r.eligible, from: r.subject, setup: r.setup, work: r.work });
    }
    return out.sort((a, b) => Number(b.eligible) - Number(a.eligible));
  };
  for (const date of ['2026-09-01', '2026-09-30', '2026-10-01']) {
    const golden = await serialMachines(date);
    const actual = await measured((meter) => machinesForOperation(meter, company, main, date));
    ok(`machines match serial resolver on ${date}`, same(actual.result, golden));
    ok(`machines use three queries on ${date}`, actual.queries === 3);
  }
  const result = await machinesForOperation(db, company, main, '2026-09-28');
  ok('family / subfamily / latest variant rules win', [10, 20, 40].every((n) => result.some((r) => r.work?.minutes === n)));
  ok('machine exclusion sorts last', result.at(-1).machine.id === excludedId && result.at(-1).eligible === false);
  ok('machine formulas preserved', result.find((r) => r.machine.id === overrideId)?.work?.formula?.id === formula);
  ok('inactive, deleted and foreign machines absent', !result.some((r) => [inactiveId, deletedId, foreignId].includes(r.machine.id)));
  ok('unrelated and deleted-parent classifications do not match', result.length === 305 && !result.some((r) => r.work?.minutes === 999));
  for (const m of machines.filter((m) => m.code.startsWith(tag)).slice(0, 8)) {
    const golden = [];
    for (const op of operations) {
      const r = await resolveTiming(db, company, op.id, m, '2026-09-28');
      if (r) golden.push({ operation: { id: op.id, code: op.code, name: op.name }, eligible: r.eligible, from: r.subject, setup: r.setup, work: r.work });
    }
    const actual = await measured((meter) => operationsForMachine(meter, company, m, '2026-09-28'));
    ok(`operations match serial for ${m.code}`, same(actual.result, golden));
    ok(`operations use three queries for ${m.code}`, actual.queries === 3);
    ok(`inactive/deleted/foreign operations absent for ${m.code}`, !actual.result.some((r) => [inactive, deleted, foreignOp].includes(r.operation.id)));
  }
  const noRule = await measured((meter) => machinesForOperation(meter, company, empty));
  ok('operation without rules returns in one query', noRule.queries === 1 && noRule.result.length === 0);
} catch (e) { failed++; console.error('FAIL', e.stack); }
finally { await db.rollback(); db.release(); }
ok('every CF table count restored', same(before, await counts()));
await pool.end();
console.log(`${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
