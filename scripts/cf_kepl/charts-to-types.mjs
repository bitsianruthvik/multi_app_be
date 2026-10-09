/**
 * charts-to-types.mjs — charts live on machine types (user, 2026-10-09: "can you actually move all
 * the current charts from machines to machine types? And redo all the formulas removing the
 * lookups").
 *
 *   1. RELINK  a column that lost the piece's value it is read by (the specification editor used to
 *              drop it — fixed the same day) is tied again by its label (Thickness → THICKNESS).
 *   2. MOVE    for each chart set up on a machine type: when the type holds no chart of its own, the
 *              chart most of its machines share becomes the type's; a machine whose own chart is the
 *              same as the type's drops it (it reads the type's); a machine whose chart DIFFERS keeps
 *              it as its own and is listed. The chart's rule on the type becomes 'defaulted', so every
 *              machine of the type reads the type's chart unless it has its own.
 *   3. TIMES   every operation time is shown as people will see it: a chart by its name. Times are
 *              STORED as LOOKUP(…) and SHOWN by name (lib/chartFormula.js) — nothing to rewrite; any
 *              time that still shows a LOOKUP is listed with why.
 *
 *   node scripts/cf_kepl/charts-to-types.mjs --company 30005            (dry run: rolled back)
 *   node scripts/cf_kepl/charts-to-types.mjs --company 30005 --apply    (commits)
 * Re-running changes nothing.
 */
const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const COMPANY = Number(arg('company'));
const APPLY = process.argv.includes('--apply');
if (!Number.isInteger(COMPANY)) throw new Error('Usage: --company <id> [--apply]');

const ALIAS = { HOLE_DIAMETER: 'HOLE_DIA', PLATE_THICKNESS: 'THICKNESS', WELD: 'WELD_SIZE' };
const snake = (s) => String(s ?? '').normalize('NFKD').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase();
const parseJson = (v) => { if (v == null) return null; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return null; } };
const same = (a, b) => JSON.stringify(parseJson(a)?.rows ?? parseJson(a)) === JSON.stringify(parseJson(b)?.rows ?? parseJson(b));

const { pool } = await import('../../db.js');
const { materializeMachine } = await import('../../apps/cf_erp/services/valueService.js');
const { chartBindings } = await import('../../apps/cf_erp/services/chartService.js');
const { contractCharts } = await import('../../apps/cf_erp/lib/chartFormula.js');

const db = await pool.getConnection();
const c = { companyId: COMPANY, userId: null };
try {
  await db.beginTransaction();
  // 1. RELINK
  const [fields] = await db.query("SELECT UPPER(code) AS code, name, data_type, default_uom AS unit FROM cf_specifications WHERE company_id = ? AND deleted_at IS NULL AND data_type IN ('number', 'option', 'text')", [COMPANY]);
  const byCode = new Map(fields.map((f) => [f.code, f]));
  const byName = new Map(fields.map((f) => [snake(f.name), f]));
  const find = (label) => { const k = snake(label); return byCode.get(ALIAS[k] ?? k) ?? byName.get(k) ?? null; };
  const [charts] = await db.query("SELECT id, code, name, table_config FROM cf_specifications WHERE company_id = ? AND deleted_at IS NULL AND data_type = 'table' ORDER BY code", [COMPANY]);
  console.log('1. Columns tied to the piece\'s values');
  for (const ch of charts) {
    const cfg = parseJson(ch.table_config) ?? {};
    let fixed = 0;
    cfg.axes = (cfg.axes ?? []).map((a) => {
      if (a.kind === 'level' || a.field) return a;
      const f = find(a.label);
      if (!f) { console.log(`   ! ${ch.code}: column "${a.label}" matches no value of a piece — tie it on the chart`); return a; }
      fixed++;
      return { ...a, kind: 'spec', field: f.code, dataType: a.dataType ?? f.data_type, unit: a.unit ?? f.unit ?? null };
    });
    if (fixed) { await db.query('UPDATE cf_specifications SET table_config = ? WHERE id = ?', [JSON.stringify(cfg), ch.id]); console.log(`   ${ch.code}: ${fixed} column(s) tied again (${cfg.axes.map((a) => a.field ?? a.level).join(', ')})`); }
  }

  // 2. MOVE
  console.log('\n2. Charts onto machine types');
  const touched = new Set();
  const [rules] = await db.query(
    `SELECT a.id AS rule_id, a.value_rule, a.subject_id AS type_id, s.id AS spec_id, s.code, n.name AS type_name
       FROM cf_spec_assignments a JOIN cf_specifications s ON s.id = a.specification_id AND s.data_type = 'table' AND s.deleted_at IS NULL
       JOIN cf_classification_nodes n ON n.id = a.subject_id
      WHERE a.company_id = ? AND a.deleted_at IS NULL AND a.subject_type = 'classification' ORDER BY s.code`, [COMPANY]);
  for (const r of rules) {
    const [machines] = await db.query(
      `WITH RECURSIVE sub AS (SELECT id FROM cf_classification_nodes WHERE id = ? UNION ALL SELECT n.id FROM cf_classification_nodes n JOIN sub ON n.parent_id = sub.id WHERE n.deleted_at IS NULL)
       SELECT m.id, m.code FROM cf_machines m WHERE m.company_id = ? AND m.deleted_at IS NULL AND m.classification_id IN (SELECT id FROM sub) ORDER BY m.id`, [r.type_id, COMPANY]);
    const [vals] = await db.query(
      `SELECT id, subject_type, subject_id, value_json FROM cf_spec_values WHERE company_id = ? AND specification_id = ? AND deleted_at IS NULL AND source = 'entered'
         AND ((subject_type = 'classification' AND subject_id = ?) OR (subject_type = 'machine' AND subject_id IN (?)))`,
      [COMPANY, r.spec_id, r.type_id, [0, ...machines.map((m) => m.id)]]);
    let typeVal = vals.find((v) => v.subject_type === 'classification');
    const own = vals.filter((v) => v.subject_type === 'machine');
    const name = (id) => machines.find((m) => m.id === Number(id))?.code ?? id;
    const words = [];
    if (r.value_rule !== 'defaulted') { await db.query("UPDATE cf_spec_assignments SET value_rule = 'defaulted' WHERE id = ?", [r.rule_id]); words.push(`rule ${r.value_rule} → defaulted`); }
    if (!typeVal && own.length) {
      const groups = [];
      for (const v of own) { const g = groups.find((x) => same(x.json, v.value_json)); if (g) g.list.push(v); else groups.push({ json: v.value_json, list: [v] }); }
      groups.sort((a, b) => b.list.length - a.list.length || a.list[0].subject_id - b.list[0].subject_id);
      const pick = groups[0];
      const [ins] = await db.query("INSERT INTO cf_spec_values (company_id, specification_id, subject_type, subject_id, value_json, source) VALUES (?, ?, 'classification', ?, ?, 'entered')",
        [COMPANY, r.spec_id, r.type_id, typeof pick.json === 'string' ? pick.json : JSON.stringify(pick.json)]);
      typeVal = { id: ins.insertId, value_json: pick.json };
      words.push(`the type now holds ${name(pick.list[0].subject_id)}'s chart (shared by ${pick.list.length} of ${own.length} machine${own.length === 1 ? '' : 's'} that had one)`);
    }
    const drop = own.filter((v) => typeVal && same(v.value_json, typeVal.value_json));
    const keep = own.filter((v) => !drop.includes(v));
    if (drop.length) { await db.query('UPDATE cf_spec_values SET deleted_at = NOW() WHERE company_id = ? AND id IN (?)', [COMPANY, drop.map((v) => v.id)]); words.push(`${drop.map((v) => name(v.subject_id)).join(', ')} read the type's now`); }
    if (keep.length) words.push(`kept as their own (different from the type's): ${keep.map((v) => name(v.subject_id)).join(', ')}`);
    for (const m of machines) touched.add(m.id);
    console.log(`   ${r.code.padEnd(14)} on ${r.type_name}: ${words.length ? words.join('; ') : 'already on the type, nothing on machines'}`);
  }
  // Each machine's copy of its type's chart follows.
  for (const id of touched) await materializeMachine(db, c, id);

  // 3. TIMES
  console.log('\n3. Times as people see them');
  const bindings = await chartBindings(db, COMPANY);
  const [times] = await db.query(
    `SELECT o.code, r.work_expression AS w, r.setup_expression AS s FROM cf_operation_machine_rules r JOIN cf_operations o ON o.id = r.operation_id AND o.deleted_at IS NULL
      WHERE r.company_id = ? AND r.deleted_at IS NULL AND (r.work_expression LIKE '%LOOKUP%' OR r.setup_expression LIKE '%LOOKUP%') ORDER BY o.code`, [COMPANY]);
  let stillLong = 0;
  for (const t of times) {
    for (const [what, expr] of [['work', t.w], ['setup', t.s]]) {
      if (!expr || !/LOOKUP/i.test(expr)) continue;
      const shown = contractCharts(expr, bindings);
      if (/LOOKUP/i.test(shown)) { stillLong++; console.log(`   ! ${t.code} ${what}: ${shown} — the LOOKUP reads other values than the chart's columns`); }
      else console.log(`   ${t.code} ${what}: ${shown}`);
    }
  }
  console.log(`\nSUMMARY  ${times.length} time(s) read a chart · ${stillLong} still written as LOOKUP`);
  if (APPLY) { await db.commit(); console.log('COMMITTED'); } else { await db.rollback(); console.log('DRY RUN — rolled back. Add --apply to keep it.'); }
} catch (err) {
  await db.rollback().catch(() => {});
  console.error('ERROR', err.message);
  process.exitCode = 1;
} finally {
  db.release();
  await pool.end();
}
