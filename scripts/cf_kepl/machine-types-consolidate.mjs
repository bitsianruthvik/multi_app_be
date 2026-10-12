/**
 * machine-types-consolidate.mjs — Placebo's machine types, from the equipment register's headings
 * (Major equipment / Welding machines / Material handling / Other / Electrical / Vehicles, plus the
 * 24 Sep demo branch "Machines") to two groups split by one question: can an operation be planned on it?
 *
 *   Production          Cutting · Drilling · Fit-up & assembly · Welding · Finishing · Handling · Inspection
 *   Plant & utilities   Electrical · Utilities · Tools
 *
 *   node scripts/cf_kepl/machine-types-consolidate.mjs --company 30005            (dry run: rolled back)
 *   node scripts/cf_kepl/machine-types-consolidate.mjs --company 30005 --apply    (commits)
 *
 * HOW. Real machine types are MOVED (parent_id) and groups RENAMED — never recreated — so every chart,
 * time rule, field and machine stays on the id it was on. What is left empty is deleted the app's own
 * way (classificationService.deleteNode, machineService.deleteMachine: soft, and each refuses when
 * something still hangs on it). The six register roots carry the SAME 19 fields (checked), so a type
 * moved from one to another keeps every field.
 *
 * GONE: the demo branch but for its Inspection types (two operations run on those QC stations) —
 * 21 types and their 16 demo machines, none of which has ever had a step. "Manual blasting
 * accessories" merges into "Blasting accessories".
 *
 * THE CHECK, before anything is kept: the times of two whole order lines and every type's charts are
 * read before and after and must be the same to the last digit; a difference rolls everything back.
 */
import { pathToFileURL } from 'url';

const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : null; };

/** [root id, new name, new code, [[group id, name, code, [type ids it ends up holding]], …]] */
const PLAN = [
  [90001, 'Production', 'PRODUCTION', [
    [90002, 'Cutting', 'PROD-CUTTING', [90003, 90004, 90029, 90044, 90055]],
    [90007, 'Drilling', 'PROD-DRILLING', [90008, 90033]],
    [90005, 'Fit-up & assembly', 'PROD-FITUP', [90006, 90048]],
    [90013, 'Welding', 'PROD-WELDING', [90014, 90015, 90016, 90017, 90018, 90057]],
    [90009, 'Finishing', 'PROD-FINISHING', [90010, 90011, 90037, 90039, 90031]],
    [90020, 'Handling', 'PROD-HANDLING', [90021, 90022, 90024, 90026, 90070]],
    [30022, 'Inspection', 'PROD-INSPECTION', [30023, 30024, 30025]],
  ]],
  [90027, 'Plant & utilities', 'PLANT', [
    [90061, 'Electrical', 'PLANT-ELECTRICAL', [90062, 90063, 90065, 90067, 90050, 90056]],
    [90045, 'Utilities', 'PLANT-UTILITIES', [90046, 90043, 90041, 90052, 90059, 90071]],
    [90053, 'Tools', 'PLANT-TOOLS', [90054]],
  ]],
];
/** A type folded into another: its machines move, then it goes. */
const MERGE = [[90035, 90011, 'Blasting accessories']];
/** The lines whose times must not move: [orderId, lineId]. */
const WATCH = [[330001, 390001], [120001, 210001]];

export async function run(db, companyId, { log = console.log } = {}) {
  const { deleteNode } = await import('../../apps/cf_erp/services/classificationService.js');
  const { deleteMachine } = await import('../../apps/cf_erp/services/machineService.js');
  const { listCharts } = await import('../../apps/cf_erp/services/chartService.js');
  const { getLineTimes } = await import('../../apps/cf_erp/services/timeEstimateService.js');
  const { invalidateNodeCache } = await import('../../apps/cf_erp/lib/nodeCache.js');
  const c = { companyId, userId: null };
  const live = async () => (await db.query("SELECT id, parent_id, depth, code, name FROM cf_classification_nodes WHERE company_id = ? AND deleted_at IS NULL AND scope = 'machine'", [companyId]))[0];
  const machinesBy = async () => new Map((await db.query('SELECT classification_id AS t, COUNT(*) AS n FROM cf_machines WHERE company_id = ? AND deleted_at IS NULL GROUP BY classification_id', [companyId]))[0].map((r) => [Number(r.t), Number(r.n)]));

  const keepTypes = PLAN.flatMap(([, , , groups]) => groups.flatMap((g) => g[3]));
  const keepGroups = PLAN.flatMap(([, , , groups]) => groups.map((g) => g[0]));
  const keepRoots = PLAN.map((p) => p[0]);
  const before = await live();
  const byId = new Map(before.map((n) => [n.id, n]));
  for (const id of [...keepTypes, ...keepGroups, ...keepRoots, ...MERGE.map((m) => m[0])]) if (!byId.has(id)) throw new Error(`node ${id} is not a live machine type of this company — the tree is not the one this was written for`);

  // The roots' field lists must agree, or a moved type would lose (or gain) a field.
  const [fields] = await db.query(
    `SELECT subject_id, GROUP_CONCAT(CONCAT_WS(':', specification_id, capture_at, value_rule, is_required, is_applicable) ORDER BY specification_id) AS sig
       FROM cf_spec_assignments WHERE company_id = ? AND deleted_at IS NULL AND subject_type = 'classification' AND subject_id IN (?) GROUP BY subject_id`,
    [companyId, before.filter((n) => n.depth === 0 && n.id !== 30001).map((n) => n.id)]);
  if (new Set(fields.map((f) => f.sig)).size > 1) throw new Error('the register groups do not carry the same fields — stopping');

  const snapshot = async () => {
    const times = [];
    for (const [orderId, lineId] of WATCH) times.push(JSON.stringify(await getLineTimes(db, companyId, orderId, lineId)));
    const charts = [];
    for (const id of keepTypes) charts.push(`${id}:${(await listCharts(db, companyId, { type: 'classification', id })).map((x) => `${x.code}/${x.own ? 'own' : 'up'}/${x.rows?.length ?? 0}`).join(',')}`);
    return { times, charts };
  };
  const was = await snapshot();
  const wasMachines = await machinesBy();

  // 1. the demo machines (none has a step: deleteMachine re-times nothing).
  const demoTypes = before.filter((n) => n.id >= 30001 && n.id <= 30021).map((n) => n.id);
  const [demo] = await db.query('SELECT id, code FROM cf_machines WHERE company_id = ? AND deleted_at IS NULL AND classification_id IN (?)', [companyId, demoTypes]);
  const [[used]] = await db.query('SELECT COUNT(*) AS n FROM cf_production_steps WHERE company_id = ? AND machine_id IN (?)', [companyId, demo.map((m) => m.id)]);
  if (Number(used.n)) throw new Error(`${used.n} production steps are on the demo machines — stopping`);
  for (const m of demo) await deleteMachine(db, c, m.id);
  await db.query('UPDATE cf_operator_machines SET deleted_at = NOW() WHERE company_id = ? AND machine_id IN (?) AND deleted_at IS NULL', [companyId, demo.map((m) => m.id)]);
  log(`demo machines removed: ${demo.length} (${demo.map((m) => m.code).join(', ')})`);

  // 2. merges: the machines move, the emptied type is deleted below with the rest.
  for (const [from, to, name] of MERGE) {
    const [r] = await db.query('UPDATE cf_machines SET classification_id = ? WHERE company_id = ? AND classification_id = ? AND deleted_at IS NULL', [to, companyId, from]);
    await db.query('UPDATE cf_classification_nodes SET name = ? WHERE company_id = ? AND id = ?', [name, companyId, to]);
    log(`merged ${byId.get(from).name} into ${name}: ${r.affectedRows} machines moved`);
  }

  // 3. moves and renames. Groups first (a group may change root), then the types under them.
  for (const [rootId, , , groups] of PLAN) {
    for (const [gid, , , types] of groups) {
      await db.query('UPDATE cf_classification_nodes SET parent_id = ?, depth = 1 WHERE company_id = ? AND id = ?', [rootId, companyId, gid]);
      await db.query('UPDATE cf_classification_nodes SET parent_id = ?, depth = 2 WHERE company_id = ? AND id IN (?)', [gid, companyId, types]);
    }
  }
  invalidateNodeCache(db);

  // 4. what is left over goes, leaves first — deleteNode refuses anything that still holds something.
  const keep = new Set([...keepTypes, ...keepGroups, ...keepRoots]);
  const gone = (await live()).filter((n) => !keep.has(n.id)).sort((a, b) => b.depth - a.depth);
  for (const n of gone) await deleteNode(db, c, n.id);
  log(`removed ${gone.length} groups and types: ${gone.filter((n) => n.depth === 2).length} types, ${gone.filter((n) => n.depth === 1).length} sub-groups, ${gone.filter((n) => n.depth === 0).length} top groups`);

  // 5. names and codes, once the old holders of a name are gone (uq_ccn_sibling, uq_ccn_code are over live rows).
  let sort = 0;
  for (const [rootId, name, code, groups] of PLAN) {
    await db.query('UPDATE cf_classification_nodes SET name = ?, code = ?, sort_order = ? WHERE company_id = ? AND id = ?', [name, code, ++sort, companyId, rootId]);
    for (const [gid, gname, gcode] of groups) await db.query('UPDATE cf_classification_nodes SET name = ?, code = ?, sort_order = ? WHERE company_id = ? AND id = ?', [gname, gcode, ++sort, companyId, gid]);
  }
  invalidateNodeCache(db);

  // 6. the check.
  const now = await snapshot();
  const problems = [];
  was.times.forEach((t, i) => { if (t !== now.times[i]) problems.push(`the times of order line ${WATCH[i][1]} changed`); });
  was.charts.forEach((t, i) => { if (t !== now.charts[i]) problems.push(`charts changed: ${t} → ${now.charts[i]}`); });
  const after = await live();
  const nowMachines = await machinesBy();
  const total = (m) => [...m.values()].reduce((a, b) => a + b, 0);
  if (total(nowMachines) !== total(wasMachines) - demo.length) problems.push(`machines: ${total(wasMachines)} − ${demo.length} demo ≠ ${total(nowMachines)}`);
  for (const id of keepTypes) {
    const expect = (wasMachines.get(id) ?? 0) + MERGE.filter((m) => m[1] === id).reduce((a, m) => a + (wasMachines.get(m[0]) ?? 0), 0);
    if ((nowMachines.get(id) ?? 0) !== expect) problems.push(`${byId.get(id).name}: ${expect} machines before, ${nowMachines.get(id) ?? 0} after`);
  }
  for (const n of after) if (n.depth > 0 && !after.some((p) => p.id === n.parent_id && p.depth === n.depth - 1)) problems.push(`${n.name} hangs under nothing`);
  const [[rulesLost]] = await db.query(
    `SELECT COUNT(*) AS n FROM cf_operation_machine_rules r WHERE r.company_id = ? AND r.deleted_at IS NULL AND r.subject_type = 'classification'
        AND r.subject_id NOT IN (SELECT id FROM cf_classification_nodes WHERE company_id = ? AND deleted_at IS NULL)`, [companyId, companyId]);
  if (Number(rulesLost.n)) problems.push(`${rulesLost.n} time rules point at a type that is gone`);

  log(`\nbefore: ${before.filter((n) => n.depth === 0).length} top groups · ${before.filter((n) => n.depth === 1).length} sub-groups · ${before.filter((n) => n.depth === 2).length} types · ${total(wasMachines)} machines`);
  log(`after:  ${after.filter((n) => n.depth === 0).length} top groups · ${after.filter((n) => n.depth === 1).length} sub-groups · ${after.filter((n) => n.depth === 2).length} types · ${total(nowMachines)} machines\n`);
  for (const r of after.filter((n) => n.depth === 0).sort((a, b) => a.id - b.id)) {
    log(r.name);
    for (const g of after.filter((n) => n.parent_id === r.id)) {
      log(`  ${g.name}: ${after.filter((n) => n.parent_id === g.id).map((t) => `${t.name} (${nowMachines.get(t.id) ?? 0})`).join(', ')}`);
    }
  }
  log(`\ntimes of ${WATCH.length} order lines: ${was.times.every((t, i) => t === now.times[i]) ? 'the same' : 'CHANGED'} · charts on ${keepTypes.length} types: ${was.charts.every((t, i) => t === now.charts[i]) ? 'the same' : 'CHANGED'}`);
  return { problems };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const companyId = Number(arg('company'));
  const apply = process.argv.includes('--apply');
  if (!companyId) { console.log('--company <id> is needed'); process.exit(1); }
  const { pool } = await import('../../db.js');
  const { attachNodeCache } = await import('../../apps/cf_erp/lib/nodeCache.js');
  const db = await pool.getConnection();
  try {
    await db.beginTransaction();
    attachNodeCache?.(db);
    const { problems } = await run(db, companyId);
    if (problems.length) { await db.rollback(); console.log(`NOT KEPT — rolled back:\n  ${problems.join('\n  ')}`); }
    else if (apply) { await db.commit(); console.log('COMMITTED'); }
    else { await db.rollback(); console.log('DRY RUN — rolled back. Add --apply to keep it.'); }
  } catch (e) {
    await db.rollback().catch(() => {});
    console.log(`ERROR — rolled back: ${e.message}`);
  } finally { db.release(); await pool.end(); }
}
