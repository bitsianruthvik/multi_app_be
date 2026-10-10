/**
 * flow_specs_test.mjs — a record's flow decides which values it needs (init.sql §50, 2026-10-08).
 * Choosing a flow makes every item.X its operations' times read REQUIRED on the record, unless the
 * chain gives it some other way; an optional rule of its own is made required (never a second rule);
 * a flow's steps or an operation's time changing re-syncs; a rule no longer read GOES (its value stays
 * stored — the smallest set to fill, user 2026-10-10); a frozen line's rows are left alone; a flow-made
 * rule is its own record's and does not reach the rows made from a definition.
 * Local only, one rolled-back transaction, every cf_ table re-counted.
 *
 *   cd multi_app_be && node scripts/cf_kepl/flow_specs_test.mjs
 */
import { pool } from '../../db.js';
import { createTimingRule, updateTimingRule } from '../../apps/cf_erp/services/operationService.js';
import { addStep, removeStep } from '../../apps/cf_erp/services/flowService.js';
import { updateRecord } from '../../apps/cf_erp/services/masterRecordService.js';
import { syncFlowSpecs, neededCodesOfFlows } from '../../apps/cf_erp/services/flowSpecService.js';

if (!/^(localhost|127\.0\.0\.1|::1)$/.test(process.env.DB_HOST ?? 'localhost')) throw new Error('Local only.');
const COMPANY = 2;
let passed = 0, failed = 0;
const ok = (label, cond, detail = '') => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && detail ? ` — ${detail}` : ''}`); cond ? passed++ : failed++; };
const [tables] = await pool.query("SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME LIKE 'cf\\_%' ORDER BY TABLE_NAME");
const counts = async () => (await pool.query(tables.map((t) => `SELECT '${t.name}' AS name,COUNT(*) AS n FROM \`${t.name}\``).join(' UNION ALL ')))[0];
const before = await counts();
const db = await pool.getConnection();
const T = `FST${Date.now() % 100000}`;
try {
  await db.beginTransaction();
  const c = { companyId: COMPANY, userId: null };
  const spec = async (suffix) => {
    const [r] = await db.query("INSERT INTO cf_specifications (company_id, code, name, data_type, status) VALUES (?, ?, ?, 'number', 'active')", [COMPANY, `${T}_${suffix}`, `Test ${suffix}`]);
    return { id: r.insertId, code: `${T}_${suffix}` };
  };
  const X = await spec('X'), Y = await spec('Y'), Z = await spec('Z'), W = await spec('W');
  const [o] = await db.query("INSERT INTO cf_operations (company_id, code, name, status) VALUES (?, ?, 'Test op', 'active')", [COMPANY, `${T}-OP`]);
  const opId = o.insertId;
  const [[mc]] = await db.query('SELECT id FROM cf_machines WHERE company_id = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 1', [COMPANY]);
  const rule = await createTimingRule(db, c, opId, { subjectType: 'machine', subjectId: mc.id, workExpression: `item.${X.code} * 2 + item.${Y.code} + item.${Z.code}`, setupExpression: '5' });
  const [f] = await db.query("INSERT INTO cf_operation_flows (company_id, code, name, status) VALUES (?, ?, 'Test flow', 'active')", [COMPANY, `${T}-FL`]);
  const flowId = f.insertId;
  const need = await neededCodesOfFlows(db, COMPANY, [flowId]);
  ok('a flow with no steps reads nothing', need.get(flowId).size === 0);
  await addStep(db, c, flowId, { operationId: opId });
  const need2 = (await neededCodesOfFlows(db, COMPANY, [flowId])).get(flowId);
  ok('with the step it reads X, Y, Z', [X, Y, Z].every((s) => need2.has(s.code)), [...need2].join(','));

  const [[def]] = await db.query(
    `SELECT m.id, m.classification_id FROM cf_master_records m JOIN cf_definition_details d ON d.master_id = m.id
      WHERE m.company_id = ? AND m.record_kind = 'definition' AND d.definition_type = 'template' AND m.deleted_at IS NULL AND m.default_flow_id IS NULL
      ORDER BY m.id LIMIT 1`, [COMPANY]);
  // Y: the definition already asks for it, optional (its own manual rule). Z: its classification gives it (defaulted).
  await db.query("INSERT INTO cf_spec_assignments (company_id, specification_id, subject_type, subject_id, capture_at, is_required, is_applicable, value_rule) VALUES (?, ?, 'master', ?, 'item', 0, 1, 'entered')", [COMPANY, Y.id, def.id]);
  await db.query("INSERT INTO cf_spec_assignments (company_id, specification_id, subject_type, subject_id, capture_at, is_required, is_applicable, value_rule) VALUES (?, ?, 'classification', ?, 'item', 0, 1, 'defaulted')", [COMPANY, Z.id, def.classification_id]);

  const rec = await updateRecord(db, c, def.id, { defaultFlowId: flowId });
  const rulesOf = async (id) => (await db.query(
    `SELECT UPPER(s.code) AS code, a.is_required, a.origin, a.value_rule FROM cf_spec_assignments a JOIN cf_specifications s ON s.id = a.specification_id
      WHERE a.company_id = ? AND a.subject_type = 'master' AND a.subject_id = ? AND a.deleted_at IS NULL AND s.code LIKE ?`, [COMPANY, id, `${T}%`]))[0];
  let rs = await rulesOf(def.id);
  const by = (code) => rs.filter((r) => r.code === code);
  ok('choosing the flow adds X as a required entered rule, origin flow', by(X.code).length === 1 && by(X.code)[0].is_required === 1 && by(X.code)[0].origin === 'flow', JSON.stringify(rs));
  ok('Y: its own optional rule is made required — no second rule', by(Y.code).length === 1 && by(Y.code)[0].is_required === 1 && by(Y.code)[0].origin === 'manual', JSON.stringify(by(Y.code)));
  ok('Z: given by the classification (defaulted) — nothing added', by(Z.code).length === 0);
  ok('the save says what it added, in words', /Test X/.test(rec.flowSpecs?.words ?? '') && /Test Y/.test(rec.flowSpecs.words), rec.flowSpecs?.words);
  const again = await syncFlowSpecs(db, c, [def.id]);
  ok('running it again changes nothing', again.added.length === 0 && again.removed.length === 0, JSON.stringify(again));

  // The operation's time changes: reads W instead of X.
  await updateTimingRule(db, c, rule.id, { workExpression: `item.${W.code} + item.${Y.code}` });
  rs = await rulesOf(def.id);
  ok('an operation\'s time changing re-syncs: W added', by(W.code).length === 1 && by(W.code)[0].is_required === 1);
  ok('…and X, no longer read and never filled in, goes', by(X.code).length === 0, JSON.stringify(rs));

  // A flow rule goes when its flow stops reading it, filled in or not — the value stays stored.
  await db.query("INSERT INTO cf_spec_values (company_id, specification_id, subject_type, subject_id, value_number) VALUES (?, ?, 'master', ?, 7)", [COMPANY, W.id, def.id]);
  const [[step]] = await db.query('SELECT id FROM cf_operation_flow_steps WHERE company_id = ? AND flow_id = ? AND deleted_at IS NULL', [COMPANY, flowId]);
  await removeStep(db, c, step.id);
  rs = await rulesOf(def.id);
  ok('removing the step: W is no longer read, so its rule goes although it holds a value', by(W.code).length === 0, JSON.stringify(rs));
  ok('…and the value is still stored', Number((await db.query("SELECT value_number FROM cf_spec_values WHERE company_id = ? AND specification_id = ? AND subject_type = 'master' AND subject_id = ? AND deleted_at IS NULL", [COMPANY, W.id, def.id]))[0][0]?.value_number) === 7);
  ok('a manual rule is never removed by the sync (Y stays)', by(Y.code).length === 1);

  // A frozen line's rows are left alone.
  const [[tmp]] = await db.query(
    `SELECT i.master_id AS id FROM cf_item_details i JOIN cf_sales_order_lines ol ON ol.id = i.owner_order_line_id
      WHERE i.company_id = ? AND i.item_type = 'temporary' AND i.deleted_at IS NULL AND ol.locked_at IS NOT NULL LIMIT 1`, [COMPANY]);
  if (tmp) {
    await addStep(db, c, flowId, { operationId: opId });
    await db.query('UPDATE cf_master_records SET default_flow_id = ? WHERE id = ?', [flowId, tmp.id]);
    const r = await syncFlowSpecs(db, c, [tmp.id]);
    ok('a row of a frozen line gets nothing added', r.added.length === 0 && (await rulesOf(tmp.id)).length === 0, JSON.stringify(r));
  } else ok('a frozen line exists locally to test with', false);

  // Clearing the flow takes away the unfilled flow rules.
  await db.query('UPDATE cf_spec_values SET deleted_at = NOW() WHERE company_id = ? AND specification_id = ? AND subject_id = ?', [COMPANY, W.id, def.id]);
  await updateRecord(db, c, def.id, { defaultFlowId: null });
  rs = await rulesOf(def.id);
  ok('no flow: the flow-made rules go, the manual one stays', rs.length === 1 && rs[0].code === Y.code, JSON.stringify(rs));
} catch (e) {
  failed++;
  console.error('  ERROR', e.message, e.problems ? JSON.stringify(e.problems) : '', e.stack?.split('\n').slice(1, 3).join(' '));
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
