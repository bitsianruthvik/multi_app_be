/**
 * table_rates_test.mjs — scripts/cf_kepl/cf_table_rates.mjs on the local KEPL
 * copy (line 923, company 2, scratch schema sqldb_optimes): the formulas in the
 * system reproduce every sample of the user's Master_Formulae table, units are
 * read off the specs, the dry run writes nothing, the projection equals hand
 * sums, a started release is refused before anything is written, the commit
 * writes formulas/rules/specs + the KEPL inputs (with history) and re-releases
 * once, a re-run changes nothing, a stale release with everything else right is
 * re-released on its own, and an unreleased line gets its inputs without a
 * release.
 *
 *   cd multi_app_be && node scripts/cf_kepl/table_rates_test.mjs
 *   CF_TR_DB=sqldb_optimes CF_TR_COMPANY=2 CF_TR_LINE=923 (the defaults)
 *
 * EVERYTHING HAPPENS INSIDE ONE TRANSACTION THAT IS ROLLED BACK, and the last
 * thing it does is re-count every cf_ table. Line 923 is never left released.
 */
process.env.DB_NAME = process.env.CF_TR_DB ?? 'sqldb_optimes';
const { pool } = await import('../../db.js');
await import('../../apps/cf_erp/services/codegenProvider.js');
const { attachNodeCache, detachNodeCache } = await import('../../apps/cf_erp/lib/db.js');
const { releaseLine, releaseCheck, liveReleaseOfLine, unrelease } = await import('../../apps/cf_erp/services/releaseService.js');
const { setOrderStatus } = await import('../../apps/cf_erp/services/salesOrderService.js');
const { createArea } = await import('../../apps/cf_erp/services/stockingAreaService.js');
const valueSvc = await import('../../apps/cf_erp/services/valueService.js');
const opsSvc = await import('../../apps/cf_erp/services/operationService.js');
const { effectiveByCode } = await import('../../apps/cf_erp/services/resolutionService.js');
const kq = await import('./cf_kepl_quantities.mjs');
const { run, sample, tableEntries, metresOf, squareMetresOf, kilogramsOf, trialFactor, R } = await import('./cf_table_rates.mjs');

if (!/^(localhost|127\.0\.0\.1|::1)$/.test(process.env.DB_HOST ?? 'localhost')) throw new Error('This suite is local only.');
const COMPANY = Number(process.env.CF_TR_COMPANY ?? 2);
const LINE = Number(process.env.CF_TR_LINE ?? 923);
const tag = `TR${Date.now().toString(36).toUpperCase()}`;

let passed = 0;
let failed = 0;
function ok(label, condition, detail = '') {
  if (typeof label !== 'string' || typeof condition !== 'boolean') throw new Error('ok(label, condition) takes a string and then a boolean');
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${!condition && detail ? ` — ${detail}` : ''}`);
  condition ? passed++ : failed++;
}
const near = (a, b, eps = 1e-6) => a != null && b != null && Math.abs(Number(a) - Number(b)) < eps;
const section = (s) => console.log(`\n${s}`);
async function refusal(fn) { try { await fn(); return null; } catch (e) { return e; } }

/* ------------------------------------------------------------------------ */
section('0. The table\'s samples, pure (Master_Formulae column "Sample Calculation")');
ok('1 CNC cutting: 6 m x 1.8 + 8 x 0.2 = 12.4', near(sample.cncCut(6, 1.8, 8), 12.4));
ok('2 gas cutting: 4 m x 4.5 = 18', near(sample.gasCut(4, 4.5), 18));
ok('3 H-beam: N 4, Wt 2500 kg -> 4 x 25 x 2.5 = 250', near(sample.hbeam(4, 2500), 250));
ok('4 SAW: 20 m x 1.0 = 20', near(sample.saw(20), 20));
ok('5 line matching: 6 x 10 x 1.5 = 90', near(sample.lineMatch(6, 1500), 90));
ok('6 CNC drilling: 50 x 0.35 = 17.5', near(sample.cncDrill(50), 17.5));
ok('7 manual drilling: 20 x 1.1 + 20 x 1.5 = 52', near(sample.manDrill(20, 20), 52));
ok('8 stiffener fit-up (table sample): 30 x 8 x 1.2 = 288', near(sample.stiffFitTableSample(30, 1200), 288));
ok('8 user decision: 30 stiffeners of 1.2 t each -> 30 x max(8, 8 x 1.2) = 288 (the sample still reproduces)', near(sample.stiffFit(Array(30).fill(1200)), 288));
ok('8 user decision: floor 8 min a stiffener — 50 kg + 158 kg -> 8 + 8 = 16', near(sample.stiffFit([50, 158]), 16));
ok('8 user decision: a 2.5 t stiffener -> 8 x 2.5 = 20; mixed [500, 2500] -> 8 + 20 = 28', near(sample.stiffFit([2500]), 20) && near(sample.stiffFit([500, 2500]), 28));
ok('8 per-face tonnes = sum of max(1 t, own weight): [50, 158, 2500] kg -> 1 + 1 + 2.5 = 4.5', near(sample.stiffFitTonnes([50, 158, 2500]), 4.5));
ok('9 MIG: 15 m x 1.6 = 24', near(sample.mig(15), 24));
ok('10 arc: 8 m x 2.8 = 22.4', near(sample.arc(8), 22.4));
ok('11 trial assembly (table formula with the table\'s 60 min): 36 m -> 60; 18 m -> 60 x 0.5 x 0.8', near(sample.trial(36000, 60), 60) && near(sample.trial(18000, 60), 60 * 0.5 * 0.8) && trialFactor(36000) === 1);
ok('11 user decision: T_36_ref = 6.5 days x 1440 = 9,360 min at 36 m', near(sample.trial(36000), 9360) && R.TA_36_REF_DAYS === 6.5 && R.DAY_MIN === 1440);
ok('11 user decision: 59.3 m -> 9,360 x 59.3/36 x 1.2 = 18,501.6 min (308.4 h) a span', near(sample.trial(59300), 9360 * 59300 / 36000 * 1.2) && near(sample.trial(59300) / 60, 308.36, 0.01));
ok('12 studs: 100 x 0.4 = 40', near(sample.stud(100), 40));
ok('13 blasting: 200 m² x 2.5 = 500 (1 coat, no manual)', near(sample.blast(200, 1, 0), 500));
ok('14 metallising: 150 m² x 4.7 = 705', near(sample.metallise(150, 1), 705));
ok('15 painting: 150 m² x 1.5 x 2 = 450', near(sample.paint(150, 2, 0), 450));

section('0b. The formulas the script writes reproduce the samples (evaluated by the engine)');
const units = { SAW_WELD_LENGTH: 'm', MIG_WELD_LENGTH: 'm', MIG_WELD_LENGTH_AFTER_FLIP: 'm', ARC_WELD_LENGTH: 'm', SURFACE_AREA: 'm2', WEIGHT: 'kg' };
const trial36 = { spanKg: 1000, spanMm: 36000, factor: 1 };
const E = new Map(tableEntries(units, trial36).map((e) => [e.op, e]));
const evalOp = (op, item, machine = {}) => {
  const expr = E.get(op).build().expression;
  const map = (o) => new Map(Object.entries(o).map(([k, v]) => [k, typeof v === 'object' ? { raw: v, dataType: 'table', tableConfig: { mode: 'step_up', axes: [{}] } } : { raw: v, dataType: 'number' }]));
  const r = opsSvc.evaluateRuleTimes({ work: { minutes: null, formula: { code: 'T', expression: expr } }, setup: null }, { item: opsSvc.valueReaders(map(item)), machine: opsSvc.valueReaders(map(machine)) });
  return r.work.minutes;
};
// CNC cutting: R_cut 1.8 min/m = a speed of 1000/1.8 mm/min at 12 mm; L 6 m = 6000 mm.
ok('CNC cutting formula: 6,000 mm at 1,000/1.8 mm/min (12 mm) + 8 pierces = 12.4', near(evalOp('CG-CNCCUT', { CUT_LENGTH: 6000, THICKNESS: 12, PIERCINGS: 8 }, { CUT_SPEED: { x: [12], v: [1000 / 1.8] } }), 12.4, 1e-6));
ok('gas cutting formula: 4,000 mm at 1,000/4.5 mm/min = 18', near(evalOp('CG-GASCUT', { CUT_LENGTH: 4000, THICKNESS: 20 }, { GAS_CUT_SPEED: { x: [20], v: [1000 / 4.5] } }), 18, 1e-6));
ok('H-beam formula: N 4, Wt 2500 -> 250 + setup 60', near(evalOp('CG-HBFIT', { HBFIT_JOINTS: 4, WEIGHT: 2500 }), 250 + R.HFIT_SETUP_MIN));
ok('SAW formula: 20 m -> 20', near(evalOp('CG-SAWWELD', { SAW_WELD_LENGTH: 20 }), 20));
ok('line matching formula: N 6, Wt 1500 -> 90', near(evalOp('CG-LINEMATCH', { LINEMATCH_JOINTS: 6, WEIGHT: 1500 }), 90));
ok('CNC drilling formula: 50 holes -> 17.5', near(evalOp('CG-CNCDRILL', { HOLES: 50 }), 17.5));
ok('manual drilling formula: 20 holes + 20 transfers -> 52', near(evalOp('CG-MANDRILL', { HOLES: 20, HOLE_TRANSFERS: 20 }), 52));
ok('manual drilling passes: 20 top / bottom / inner holes -> 22 each', ['CG-MANDRILL-TOP', 'CG-MANDRILL-BOTTOM', 'CG-MANDRILL-INNER'].every((op, i) => near(evalOp(op, { [['HOLES_TOP', 'HOLES_BOTTOM', 'HOLES_INNER'][i]]: 20 }), 22)));
ok('stiffener fit-up formulas: 30 stiffeners of 1.2 t (36 fit tonnes) -> 288 (both passes)', near(evalOp('CG-STIFFFIT', { STIFFENER_FIT_TONNES: sample.stiffFitTonnes(Array(30).fill(1200)) }), 288) && near(evalOp('CG-STIFFFIT-2', { STIFFENER_FIT_TONNES_AFTER_FLIP: 36 }), 288));
ok('stiffener fit-up formula: 15 light stiffeners (15 fit tonnes, floor) -> 120 = 15 x 8', near(evalOp('CG-STIFFFIT', { STIFFENER_FIT_TONNES: sample.stiffFitTonnes(Array(15).fill(150)) }), 120));
ok('MIG formulas: 15 m -> 24 (both passes)', near(evalOp('CG-MIGWELD', { MIG_WELD_LENGTH: 15 }), 24) && near(evalOp('CG-MIGWELD-2', { MIG_WELD_LENGTH_AFTER_FLIP: 15 }), 24));
ok('arc formula: 8 m -> 22.4', near(evalOp('CG-ARCWELD', { ARC_WELD_LENGTH: 8 }), 22.4));
ok('trial assembly formula: a 36 m span\'s whole weight -> 6.5 d = 9,360 min; dismantling 4,680', near(evalOp('CG-TRIALASM', { WEIGHT: 1000 }), 9360) && near(evalOp('CG-DISMANTLE', { WEIGHT: 1000 }), 4680));
ok('trial assembly formula: half the span\'s weight carries half its time', near(evalOp('CG-TRIALASM', { WEIGHT: 500 }), 4680));
ok('stud formula: 100 -> 40', near(evalOp('CG-STUDWELD', { STUDS: 100 }), 40));
ok('blasting formula: 100 m² a face (200 m² both) -> 500 + 15 manual', near(evalOp('CG-BLAST', { SURFACE_AREA: 100 }), 515));
ok('metallising formula: 75 m² a face, 1 coat -> 705', near(evalOp('CG-METALLIZE', { SURFACE_AREA: 75, METALLISE_COATS: 1 }), 705));
ok('painting formula: 75 m² a face, 2 coats -> 450 (+ drying 0)', near(evalOp('CG-PAINT', { SURFACE_AREA: 75, PAINT_COATS: 2 }), 450));
ok('no rate formula reads a machine chart but CNC / gas cutting', [...E.values()].filter((e) => /machine\./.test(e.build().expression ?? '')).map((e) => e.op).sort().join(',') === 'CG-CNCCUT,CG-GASCUT');
ok('units: mm -> /1000, mm2 -> /1e6, t -> x1000, unknown -> null', metresOf('X', 'mm') === 'item.X / 1000' && squareMetresOf('X', 'mm²') === 'item.X / 1000000' && kilogramsOf('W', 't') === 'item.W * 1000' && metresOf('X', 'kg') === null);
const mmE = new Map(tableEntries({ ...units, SAW_WELD_LENGTH: 'mm', SURFACE_AREA: 'kg' }, trial36).map((e) => [e.op, e]));
ok('SAW held in mm -> / 1000; SURFACE_AREA in kg blocks blast/metallise/paint only', mmE.get('CG-SAWWELD').build().expression === 'item.SAW_WELD_LENGTH / 1000 * 1.0' && !!mmE.get('CG-BLAST').build().why && !!mmE.get('CG-PAINT').build().why && !mmE.get('CG-ARCWELD').build().why);

/* ------------------------------------------------------------------------ */
const [[{ db: schema }]] = await pool.query('SELECT DATABASE() AS db');
const [[hasOp]] = await pool.query("SELECT COUNT(*) AS n FROM cf_operations WHERE company_id = ? AND code = 'CG-STIFFFIT-2' AND deleted_at IS NULL", [COMPANY]);
if (!Number(hasOp.n)) throw new Error(`${schema} has no CG-STIFFFIT-2 for company ${COMPANY} — run against the scratch schema (CF_TR_DB=sqldb_optimes).`);
console.log(`\nschema ${schema}, company ${COMPANY}, line ${LINE}`);

const [tables] = await pool.query("SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME LIKE 'cf\\_%' ORDER BY TABLE_NAME");
const counts = async () => (await pool.query(tables.map((t) => `SELECT '${t.name}' AS name,COUNT(*) AS n FROM \`${t.name}\``).join(' UNION ALL ')))[0];
const before = await counts();
const conn = await pool.getConnection();
const db = conn;

try {
  await conn.beginTransaction();
  attachNodeCache(db);
  const [[user]] = await conn.query('SELECT id FROM users WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [COMPANY]);
  const c = { companyId: COMPANY, userId: user?.id ?? null };
  const q1 = async (sql, args) => (await conn.query(sql, args))[0][0];
  const n1 = async (sql, args) => Number((await q1(sql, args)).n);
  const formulaRows = () => n1('SELECT COUNT(*) AS n FROM cf_formulas WHERE company_id = ? AND deleted_at IS NULL', [COMPANY]);
  const ruleOf = (op) => q1(`SELECT r.id, r.work_formula_id, r.work_minutes, r.notes, f.code, f.expression FROM cf_operation_machine_rules r JOIN cf_operations o ON o.id = r.operation_id
                              LEFT JOIN cf_formulas f ON f.id = r.work_formula_id WHERE r.company_id = ? AND o.code = ? AND r.deleted_at IS NULL AND r.eligible = 1 ORDER BY r.id LIMIT 1`, [COMPANY, op]);

  /* ------------------------------------------------------------------------ */
  section('1. Setup inside the transaction: KEPL quantities, SURFACE_AREA, confirm');
  const line = await q1('SELECT l.id, l.locked_at, l.order_id, o.status FROM cf_sales_order_lines l JOIN cf_sales_orders o ON o.id = l.order_id WHERE l.company_id = ? AND l.id = ?', [COMPANY, LINE]);
  if (!line?.locked_at) throw new Error(`Line ${LINE} is not the locked KEPL copy.`);
  if (await liveReleaseOfLine(conn, COMPANY, LINE)) throw new Error(`Line ${LINE} is already released — this suite releases it itself.`);
  const kOut = await kq.run(db, COMPANY, { lineId: LINE, commit: true, userId: c.userId, times: false });
  ok('KEPL quantities written onto the copy', kOut.written > 0, `${kOut.written}`);
  const pre = await run(db, COMPANY, { lineId: LINE });
  const pieceOps = (n) => [...(pre.data.flowOps.get(n.flow?.id)?.values() ?? [])];
  const blastNodes = pre.data.nodes.filter((n) => pieceOps(n).some((o) => o.code === 'CG-BLAST'));
  const { byCode } = await valueSvc.loadSpecs(conn, COMPANY, [{ specCode: 'SURFACE_AREA' }]);
  const saSpec = byCode.get('SURFACE_AREA');
  const saOf = new Map();
  for (const n of blastNodes) {
    if (saOf.has(n.id)) continue;
    const v = 10 + (n.id % 7) / 4;
    const { typed } = await valueSvc.coerce(conn, COMPANY, saSpec, v);
    await valueSvc.upsertValues(conn, c, 'master', n.id, [{ spec: saSpec, typed, source: 'entered' }]);
    saOf.set(n.id, v);
  }
  ok('SURFACE_AREA written on every blast piece', saOf.size > 0, `${saOf.size}`);
  if (line.status !== 'confirmed') {
    await conn.query("UPDATE cf_sales_orders SET committed_date = COALESCE(committed_date, '2026-12-31') WHERE company_id = ? AND id = ?", [COMPANY, line.order_id]);
    await setOrderStatus(conn, c, line.order_id, 'confirmed');
  }

  // An UNRELEASED line: everything written, the inputs too, nothing released.
  await conn.query('SAVEPOINT unreleased');
  const u = await run(db, COMPANY, { lineId: LINE, commit: true, userId: c.userId });
  ok('unreleased line: setup + 80 inputs written, nothing released', u.applied > 0 && u.written === 80 && !u.tookBack && !u.released && !(await liveReleaseOfLine(conn, COMPANY, LINE)), `${u.applied}/${u.written}`);
  await conn.query('ROLLBACK TO SAVEPOINT unreleased');

  let check = await releaseCheck(conn, COMPANY, LINE);
  if (check.needsFinishedArea && !check.areas.some((a) => a.purpose === 'dispatch')) {
    await createArea(conn, c, { code: `${tag}-DSP`, name: `${tag} dispatch`, purpose: 'dispatch' });
    check = await releaseCheck(conn, COMPANY, LINE);
  }
  if (!check.ok) throw new Error(`The line cannot be released: ${check.problems.slice(0, 5).join(' | ')}`);
  const area = check.areas.find((a) => a.purpose === 'dispatch');
  const rel0 = await releaseLine(conn, c, LINE, area ? { finishedAreaId: area.id, notes: `${tag} first release` } : { notes: `${tag} first release` });
  ok('line 923 released inside the transaction (old rules)', !!rel0?.id);

  /* ------------------------------------------------------------------------ */
  section('2. Dry run: plan and projection — nothing written');
  const f0 = await formulaRows();
  const dry = await run(db, COMPANY, { lineId: LINE });
  ok('dry run wrote nothing, kept the release', (await formulaRows()) === f0 && (await liveReleaseOfLine(conn, COMPANY, LINE))?.id === rel0.id);
  ok('every operation of the table has a formula planned (21 ops: 15 rows + 3 drilling passes + 2 after-flip passes + dismantling)', dry.exprOf.size === 21, `${dry.exprOf.size}`);
  ok('no blocked action', dry.actions.every((a) => a.status !== 'blocked'), dry.actions.filter((a) => a.status === 'blocked').map((a) => a.why).join(' | '));
  ok('KEPL inputs: HBFIT_JOINTS 2, LINEMATCH_JOINTS 0.8, fit tonnes on every segment row (80)', dry.values.writes.length === 80 && dry.values.writes.filter((w) => w.code === 'HBFIT_JOINTS').every((w) => w.value === 2) && dry.values.writes.filter((w) => w.code === 'LINEMATCH_JOINTS').every((w) => w.value === 0.8));

  // Hand sums over the tree.
  const res = (n) => { const r = pre.data.resolutions.get(n.id); return r ? effectiveByCode(r) : new Map(); };
  const qty = new Map(kOut.changes.map((w) => [`${w.itemId}:${w.code}`, w.value]));
  const val = (n, code) => qty.get(`${n.id}:${code}`) ?? (res(n).get(code)?.raw == null ? null : Number(res(n).get(code).raw));
  const segs = pre.data.nodes.filter((n) => n.cls === 'GIRDER_SEGMENT');
  const sum = (nodes, f) => nodes.reduce((s, n) => s + Number(n.total) * f(n), 0);
  const want = {
    'CG-HBFIT': sum(segs, (n) => 2 * 25 * val(n, 'WEIGHT') / 1000 + 60),
    'CG-LINEMATCH': sum(segs, (n) => 0.8 * 10 * val(n, 'WEIGHT') / 1000),
    // KEPL's stiffeners all weigh < 1 t, so the floor gives 8 min each: STIFFENERS x 8 on each face.
    'CG-STIFFFIT': sum(segs, (n) => val(n, 'STIFFENERS') * 8),
    'CG-STIFFFIT-2': sum(segs, (n) => val(n, 'STIFFENERS_AFTER_FLIP') * 8),
    'CG-SAWWELD': sum(pre.data.nodes.filter((n) => pieceOps(n).some((o) => o.code === 'CG-SAWWELD')), (n) => val(n, 'SAW_WELD_LENGTH') * 1.0),
    'CG-MIGWELD-2': sum(segs, (n) => val(n, 'MIG_WELD_LENGTH_AFTER_FLIP') * 1.6),
    'CG-ARCWELD': sum(pre.data.nodes.filter((n) => n.cls === 'DIAPHRAGM'), (n) => val(n, 'ARC_WELD_LENGTH') * 2.8),
    'CG-STUDWELD': sum(segs, (n) => val(n, 'STUDS') * 0.4),
    'CG-BLAST': sum(blastNodes, (n) => saOf.get(n.id) * 2 * 2.5 * 1 + 15),
    'CG-METALLIZE': sum(pre.data.nodes.filter((n) => pieceOps(n).some((o) => o.code === 'CG-METALLIZE')), (n) => (saOf.get(n.id) ?? 0) * 2 * 4.7 * (val(n, 'METALLISE_COATS') ?? 0)),
  };
  for (const [op, m] of Object.entries(want)) ok(`projected ${op} = hand sum ${(m / 60).toFixed(1)} h`, near(dry.projected.byCode.get(op)?.minutes, m, 0.5), `${dry.projected.byCode.get(op)?.minutes} vs ${m}`);
  const span = dry.trial;
  const tw = dry.values.writes.filter((w) => w.code.startsWith('STIFFENER_FIT_TONNES'));
  ok('fit tonnes = the face\'s stiffener count (every KEPL stiffener < 1 t -> floor 1 t)', tw.length === 40 && tw.every((w) => w.value === val(segs.find((n) => n.id === w.itemId), w.code === 'STIFFENER_FIT_TONNES' ? 'STIFFENERS' : 'STIFFENERS_AFTER_FLIP')), JSON.stringify(tw.slice(0, 2)));
  const trialRate = sum(pre.data.nodes.filter((n) => pieceOps(n).some((o) => o.code === 'CG-TRIALASM')), (n) => val(n, 'WEIGHT') * sample.trial(span.spanMm) / span.spanKg);
  ok(`trial assembly = Σ piece weight / span weight x 6.5 d x 1440 x span/36 x 1.2 = ${(trialRate / 60).toFixed(1)} h`, near(dry.projected.byCode.get('CG-TRIALASM').minutes, trialRate, 0.5), `${dry.projected.byCode.get('CG-TRIALASM').minutes}`);
  ok(`trial assembly: the span's T = 6.5 d x ${(span.spanMm / 36000).toFixed(3)} x ${span.factor} spread by weight; dismantling = half`, span.factor === 1.2 && near(dry.projected.byCode.get('CG-DISMANTLE').minutes * 2, dry.projected.byCode.get('CG-TRIALASM').minutes, 0.05) && dry.projected.byCode.get('CG-TRIALASM').minutes <= 2 * sample.trial(span.spanMm) + 0.5);
  ok('painting stays untimed (PAINT_COATS empty)', !dry.projected.byCode.get('CG-PAINT')?.minutes && (dry.projected.untimed.get('CG-PAINT')?.pieces ?? 0) > 0);
  const cutNodes = pre.data.nodes.filter((n) => pieceOps(n).some((o) => o.code === 'CG-CNCCUT') && val(n, 'CUT_LENGTH') != null && val(n, 'PIERCINGS') != null);
  const pierceGain = sum(cutNodes, (n) => val(n, 'PIERCINGS') * (0.2 - 3 / 60));
  ok(`CNC cutting: only the pierce changes, 0.2 min instead of 3 s (+${(pierceGain / 60).toFixed(1)} h)`, cutNodes.length > 0 && near(dry.projected.byCode.get('CG-CNCCUT').minutes - dry.before.byCode.get('CG-CNCCUT').minutes, pierceGain, 1), `${dry.projected.byCode.get('CG-CNCCUT').minutes - dry.before.byCode.get('CG-CNCCUT').minutes} vs ${pierceGain}`);
  ok('the release differs (diffs found)', dry.diffs.length > 5 && dry.needRelease, `${dry.diffs.length}`);

  /* ------------------------------------------------------------------------ */
  section('3. Refusal: a started step -> nothing written');
  await conn.query('SAVEPOINT started');
  const [[step]] = await conn.query(`SELECT s.id FROM cf_production_steps s JOIN cf_production_items pi ON pi.id = s.production_item_id
                                       WHERE pi.release_id = ? AND s.deleted_at IS NULL ORDER BY s.id LIMIT 1`, [rel0.id]);
  await conn.query("UPDATE cf_production_steps SET state = 'in_progress', started_at = NOW() WHERE id = ?", [step.id]);
  const fS = await formulaRows();
  const hbS = (await ruleOf('CG-HBFIT')).expression;
  const eS = await refusal(() => run(db, COMPANY, { lineId: LINE, commit: true }));
  ok('--commit refuses (STARTED)', eS?.code === 'STARTED' && /started/i.test(eS.message), eS?.message);
  ok('…no formula written or changed, release kept', (await formulaRows()) === fS && (await ruleOf('CG-HBFIT')).expression === hbS && (await liveReleaseOfLine(conn, COMPANY, LINE))?.id === rel0.id);
  await conn.query('ROLLBACK TO SAVEPOINT started');

  /* ------------------------------------------------------------------------ */
  section('4. --commit: formulas, rules, specs, inputs, take back, release again');
  const hist0 = await n1("SELECT COUNT(*) AS n FROM cf_spec_value_history WHERE company_id = ? AND subject_type = 'master'", [COMPANY]);
  const out = await run(db, COMPANY, { lineId: LINE, commit: true, userId: c.userId });
  ok('setup changes applied (4 spec + 21 formulas + 21 rules ~ all planned)', out.applied === dry.setupChanges.length, `${out.applied}/${dry.setupChanges.length}`);
  for (const e of out.entries.filter((x) => x.expression)) {
    const r = await ruleOf(e.op);
    if (!(r.code === e.formula && r.work_minutes == null && r.expression === e.expression)) ok(`rule ${e.op} -> ${e.formula}`, false, JSON.stringify(r));
  }
  ok('every rule points at its table formula, no constant left', (await Promise.all(out.entries.filter((x) => x.expression).map((e) => ruleOf(e.op)))).every((r, i) => r.code === out.entries.filter((x) => x.expression)[i].formula && r.work_minutes == null));
  ok('line matching is a formula now (was 576 constant)', (await ruleOf('CG-LINEMATCH')).expression === 'item.LINEMATCH_JOINTS * 10 * item.WEIGHT / 1000');
  ok('80 KEPL inputs written with history', out.written === 80 && (await n1("SELECT COUNT(*) AS n FROM cf_spec_value_history WHERE company_id = ? AND subject_type = 'master'", [COMPANY])) - hist0 === 80, `${out.written}`);
  const live = await liveReleaseOfLine(conn, COMPANY, LINE);
  ok('took back release 1, released again with the same area and notes', out.tookBack?.id === rel0.id && live && live.id !== rel0.id && live.id === out.released?.id && live.notes === `${tag} first release`);
  ok('same steps', out.released.steps === out.tookBack.steps, `${out.tookBack.steps}/${out.released.steps}`);
  const badOps = [...dry.exprOf.keys()].filter((op) => dry.projected.byCode.has(op) && !near(out.newRelOps.get(op)?.timed ? out.newRelOps.get(op).minutes : null, dry.projected.byCode.get(op).minutes ?? null, 1) && !(dry.projected.byCode.get(op).minutes == null && !out.newRelOps.get(op)?.timed));
  ok('new release = projection, operation by operation', badOps.length === 0, badOps.map((op) => `${op} ${out.newRelOps.get(op)?.minutes} vs ${dry.projected.byCode.get(op).minutes}`).join(', '));
  const gain = [...dry.exprOf.keys()].reduce((s, op) => s + (dry.projected.byCode.get(op)?.minutes ?? 0) - (dry.relOps.get(op)?.minutes ?? 0), 0);
  ok('new release gained exactly the table operations\' change (others untouched)', near(out.released.minutes - out.tookBack.minutes, gain, 2), `${out.released.minutes - out.tookBack.minutes} vs ${gain}`);
  ok('Times grid after = projection', near(out.after.all, dry.projected.all, 0.5), `${out.after.all} vs ${dry.projected.all}`);

  /* ------------------------------------------------------------------------ */
  section('5. Idempotent: a second run changes nothing and leaves the release alone');
  const again = await run(db, COMPANY, { lineId: LINE, commit: true, userId: c.userId });
  ok('second run: 0 setup changes, 0 inputs, 0 time differences', again.setupChanges.length === 0 && again.valueChanges.length === 0 && again.diffs.length === 0, `${again.setupChanges.map((a) => a.what).join(',')}/${again.valueChanges.length}/${again.diffs.map((d) => d.op).join(',')}`);
  ok('second run: nothing taken back or released', !again.tookBack && !again.released && (await liveReleaseOfLine(conn, COMPANY, LINE))?.id === live.id);

  /* ------------------------------------------------------------------------ */
  section('6. Everything right but the release stale -> re-released on its own');
  await conn.query('SAVEPOINT stale');
  const hb = await ruleOf('CG-HBFIT');
  await unrelease(conn, c, live.id);
  await conn.query('UPDATE cf_operation_machine_rules SET work_formula_id = NULL, work_minutes = 5 WHERE id = ?', [hb.id]);
  const stale = await releaseLine(conn, c, LINE, { finishedAreaId: live.finished_area_id, notes: 'stale' });
  await conn.query('UPDATE cf_operation_machine_rules SET work_formula_id = ?, work_minutes = NULL WHERE id = ?', [hb.work_formula_id, hb.id]);
  const s = await run(db, COMPANY, { lineId: LINE, commit: true, userId: c.userId });
  ok('no setup change, H-beam differs, release taken back and released again', s.setupChanges.length === 0 && s.diffs.length === 1 && s.diffs[0].op === 'CG-HBFIT' && s.tookBack?.id === stale.id && !!s.released && s.released.id !== stale.id, JSON.stringify(s.diffs));
  ok('…the new release carries the H-beam time, notes kept', near(s.newRelOps.get('CG-HBFIT')?.minutes, want['CG-HBFIT'], 1) && (await liveReleaseOfLine(conn, COMPANY, LINE))?.notes === 'stale');
  await conn.query('ROLLBACK TO SAVEPOINT stale');

  detachNodeCache(db);
} catch (e) {
  failed++;
  console.error('\nUNEXPECTED ERROR:', e.code ?? '', e.message, e.problems ? JSON.stringify(e.problems) : '', e.stack?.split('\n').slice(1, 4).join('\n'));
} finally {
  await conn.query('ROLLBACK');
  conn.release();
}

section('7. Rolled back');
const after = await counts();
const changed = after.filter((r, i) => Number(r.n) !== Number(before[i].n)).map((r) => `${r.name} ${before.find((b) => b.name === r.name)?.n}->${r.n}`);
ok('every cf_ table has the row count it started with', changed.length === 0, changed.slice(0, 5).join(', '));
ok('line 923 is not left released', !(await liveReleaseOfLine(pool, COMPANY, LINE)));
await pool.end();
console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
