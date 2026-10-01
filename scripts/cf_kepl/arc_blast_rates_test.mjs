/**
 * arc_blast_rates_test.mjs — scripts/cf_kepl/cf_arc_blast_rates.mjs on the local
 * KEPL copy (line 923, company 2, scratch schema sqldb_optimes): unit handling,
 * the dry run writes nothing, rules written (old arc formula kept), a started
 * release is refused before anything is written, the commit re-releases only
 * when the line's arc / blast times change, a re-run changes nothing, and a
 * stale release with rules already right is re-released on its own.
 *
 *   cd multi_app_be && node scripts/cf_kepl/arc_blast_rates_test.mjs
 *   CF_AB_DB=sqldb_optimes CF_AB_COMPANY=2 CF_AB_LINE=923 (the defaults)
 *
 * EVERYTHING HAPPENS INSIDE ONE TRANSACTION THAT IS ROLLED BACK — the KEPL
 * quantities, SURFACE_AREA values (the local copy holds none), the confirm, the
 * release, the rules — and the last thing it does is re-count every cf_ table.
 * Line 923 is never left released.
 */
process.env.DB_NAME = process.env.CF_AB_DB ?? 'sqldb_optimes';
const { pool } = await import('../../db.js');
await import('../../apps/cf_erp/services/codegenProvider.js');
const { attachNodeCache, detachNodeCache } = await import('../../apps/cf_erp/lib/db.js');
const { releaseLine, releaseCheck, liveReleaseOfLine, unrelease } = await import('../../apps/cf_erp/services/releaseService.js');
const { setOrderStatus } = await import('../../apps/cf_erp/services/salesOrderService.js');
const { createArea } = await import('../../apps/cf_erp/services/stockingAreaService.js');
const valueSvc = await import('../../apps/cf_erp/services/valueService.js');
const kq = await import('./cf_kepl_quantities.mjs');
const { run, metresOf, squareMetresOf, arcExpression, blastExpression } = await import('./cf_arc_blast_rates.mjs');

if (!/^(localhost|127\.0\.0\.1|::1)$/.test(process.env.DB_HOST ?? 'localhost')) throw new Error('This suite is local only.');
const COMPANY = Number(process.env.CF_AB_COMPANY ?? 2);
const LINE = Number(process.env.CF_AB_LINE ?? 923);
const tag = `AB${Date.now().toString(36).toUpperCase()}`;

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

const [[{ db: schema }]] = await pool.query('SELECT DATABASE() AS db');
const [[hasOp]] = await pool.query("SELECT COUNT(*) AS n FROM cf_operations WHERE company_id = ? AND code = 'CG-ARCWELD' AND deleted_at IS NULL", [COMPANY]);
if (!Number(hasOp.n)) throw new Error(`${schema} has no CG-ARCWELD for company ${COMPANY} — run against the scratch schema (CF_AB_DB=sqldb_optimes).`);
console.log(`schema ${schema}, company ${COMPANY}, line ${LINE}`);

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
  const formulaRows = async () => Number((await q1('SELECT COUNT(*) AS n FROM cf_formulas WHERE company_id = ? AND deleted_at IS NULL', [COMPANY])).n);
  const ruleOf = (op) => q1(`SELECT r.id, r.work_formula_id, r.work_minutes, r.notes, f.code FROM cf_operation_machine_rules r JOIN cf_operations o ON o.id = r.operation_id
                              LEFT JOIN cf_formulas f ON f.id = r.work_formula_id WHERE r.company_id = ? AND o.code = ? AND r.deleted_at IS NULL AND r.eligible = 1 ORDER BY r.id LIMIT 1`, [COMPANY, op]);

  /* ------------------------------------------------------------------------ */
  section('0. Units (pure)');
  ok('length in m -> as is', metresOf('ARC_WELD_LENGTH', 'm') === 'item.ARC_WELD_LENGTH');
  ok('length in mm -> / 1000', metresOf('ARC_WELD_LENGTH', 'mm') === 'item.ARC_WELD_LENGTH / 1000');
  ok('area in m2 / m² -> as is', squareMetresOf('SURFACE_AREA', 'm2') === 'item.SURFACE_AREA' && squareMetresOf('SURFACE_AREA', 'm²') === 'item.SURFACE_AREA');
  ok('area in mm2 -> / 1000000', squareMetresOf('SURFACE_AREA', 'mm2') === 'item.SURFACE_AREA / 1000000');
  ok('unknown unit (kg, none) -> null', metresOf('X', 'kg') === null && squareMetresOf('X', null) === null);
  ok('arc = length (m) x 2.8', arcExpression('m') === 'item.ARC_WELD_LENGTH * 2.8');
  ok('blast = area (m²) x 2 x 2.5 + 15', blastExpression('m2') === 'item.SURFACE_AREA * 2 * 2.5 + 15');

  /* ------------------------------------------------------------------------ */
  section('1. Setup inside the transaction: KEPL quantities, SURFACE_AREA, confirm, release');
  const line = await q1(`SELECT l.id, l.locked_at, l.order_id, o.status FROM cf_sales_order_lines l JOIN cf_sales_orders o ON o.id = l.order_id WHERE l.company_id = ? AND l.id = ?`, [COMPANY, LINE]);
  if (!line?.locked_at) throw new Error(`Line ${LINE} is not the locked KEPL copy.`);
  if (await liveReleaseOfLine(conn, COMPANY, LINE)) throw new Error(`Line ${LINE} is already released — this suite releases it itself.`);
  const kOut = await kq.run(db, COMPANY, { lineId: LINE, commit: true, userId: c.userId, times: false });
  ok('KEPL quantities written onto the copy (ARC_WELD_LENGTH among them)', kOut.written > 0 && kOut.changes.some((w) => w.code === 'ARC_WELD_LENGTH'), `${kOut.written}`);

  // SURFACE_AREA on every piece a blasting flow makes — except the end diaphragm, left empty on purpose.
  const pre = await run(db, COMPANY, { lineId: LINE });
  const blastNodes = pre.data.nodes.filter((n) => [...(pre.data.flowOps.get(n.flow?.id)?.values() ?? [])].some((o) => o.code === 'CG-BLAST'));
  const endDia = blastNodes.find((n) => n.cls === 'DIAPHRAGM' && /end/i.test(n.name));
  const { byCode } = await valueSvc.loadSpecs(conn, COMPANY, [{ specCode: 'SURFACE_AREA' }]);
  const saSpec = byCode.get('SURFACE_AREA');
  const saOf = new Map();
  for (const n of blastNodes) {
    if (n.id === endDia?.id || saOf.has(n.id)) continue;
    const v = 10 + (n.id % 7) / 4; // m², distinct per item
    const { typed } = await valueSvc.coerce(conn, COMPANY, saSpec, v);
    await valueSvc.upsertValues(conn, c, 'master', n.id, [{ spec: saSpec, typed, source: 'entered' }]);
    saOf.set(n.id, v);
  }
  ok('SURFACE_AREA written on the blast pieces but the end diaphragm', saOf.size > 0 && !!endDia, `${saOf.size}`);

  // Rules on an UNRELEASED line: written, nothing released.
  await conn.query('SAVEPOINT unreleased');
  const u = await run(db, COMPANY, { lineId: LINE, commit: true, userId: c.userId });
  ok('unreleased line: 4 formula/rule changes written, nothing taken back or released', u.applied === 4 && !u.tookBack && !u.released && !(await liveReleaseOfLine(conn, COMPANY, LINE)), `${u.applied}`);
  await conn.query('ROLLBACK TO SAVEPOINT unreleased');

  if (line.status !== 'confirmed') {
    await conn.query("UPDATE cf_sales_orders SET committed_date = COALESCE(committed_date, '2026-12-31') WHERE company_id = ? AND id = ?", [COMPANY, line.order_id]);
    await setOrderStatus(conn, c, line.order_id, 'confirmed');
  }
  let check = await releaseCheck(conn, COMPANY, LINE);
  if (check.needsFinishedArea && !check.areas.some((a) => a.purpose === 'dispatch')) {
    await createArea(conn, c, { code: `${tag}-DSP`, name: `${tag} dispatch`, purpose: 'dispatch' });
    check = await releaseCheck(conn, COMPANY, LINE);
  }
  if (!check.ok) throw new Error(`The line cannot be released: ${check.problems.slice(0, 5).join(' | ')}`);
  const area = check.areas.find((a) => a.purpose === 'dispatch');
  const rel0 = await releaseLine(conn, c, LINE, area ? { finishedAreaId: area.id, notes: `${tag} first release` } : { notes: `${tag} first release` });
  ok('line 923 released inside the transaction (old rules: arc and blast untimed)', !!rel0?.id);

  /* ------------------------------------------------------------------------ */
  section('2. Dry run: plan, projection, coverage — nothing written');
  const f0 = await formulaRows();
  const dry = await run(db, COMPANY, { lineId: LINE });
  ok('dry run wrote no formula, kept the release', (await formulaRows()) === f0 && (await liveReleaseOfLine(conn, COMPANY, LINE))?.id === rel0.id);
  ok('4 changes planned: 2 formulas + 2 rules', dry.ruleChanges.length === 4 && dry.ruleChanges.filter((a) => a.area === 'Formula').length === 2, dry.ruleChanges.map((a) => a.what).join(', '));
  ok('expressions: arc in m, blast in m²', dry.exprOf.get('CG-ARCWELD')?.expression === 'item.ARC_WELD_LENGTH * 2.8' && dry.exprOf.get('CG-BLAST')?.expression === 'item.SURFACE_AREA * 2 * 2.5 + 15');
  const dias = dry.data.nodes.filter((n) => n.cls === 'DIAPHRAGM');
  const arcWant = dias.reduce((s, n) => s + Number(n.total) * (/end/i.test(n.name) ? 41.52 : 13.776) * 2.8, 0);
  ok(`projected arc = Σ ARC_WELD_LENGTH x 2.8 x pieces = ${(arcWant / 60).toFixed(1)} h`, near(dry.projected.byCode.get('CG-ARCWELD')?.minutes, arcWant, 0.05), `${dry.projected.byCode.get('CG-ARCWELD')?.minutes}`);
  const blastWant = blastNodes.filter((n) => saOf.has(n.id)).reduce((s, n) => s + Number(n.total) * (saOf.get(n.id) * 2 * 2.5 + 15), 0);
  ok(`projected blast = Σ (SA x 2 x 2.5 + 15) x pieces = ${(blastWant / 60).toFixed(1)} h`, near(dry.projected.byCode.get('CG-BLAST')?.minutes, blastWant, 0.05), `${dry.projected.byCode.get('CG-BLAST')?.minutes}`);
  const cvB = dry.coverageOf['CG-BLAST'];
  ok('blast coverage: the end diaphragm pieces are the untimed ones, reason SURFACE_AREA', cvB.untimed === Number(endDia.total) && cvB.timed === cvB.total - cvB.untimed && cvB.reasons.some((r) => /SURFACE_AREA/.test(r)) && dry.untimedBlast.get(endDia.name) === Number(endDia.total), JSON.stringify(cvB));
  ok('arc coverage: every diaphragm timed', dry.coverageOf['CG-ARCWELD'].untimed === 0 && dry.coverageOf['CG-ARCWELD'].total > 0);
  ok('one blast pass per flow', dry.coverageOf['CG-BLAST'].passes.every((p) => p === 1));
  ok('both operations differ from the release', ['CG-ARCWELD', 'CG-BLAST'].every((op) => dry.diffs.some((d) => d.op === op)));

  // Units off the specifications.
  await conn.query('SAVEPOINT units');
  await conn.query("UPDATE cf_specifications SET default_uom = 'mm' WHERE company_id = ? AND code = 'ARC_WELD_LENGTH'", [COMPANY]);
  await conn.query("UPDATE cf_specifications SET default_uom = 'mm2' WHERE company_id = ? AND code = 'SURFACE_AREA'", [COMPANY]);
  const mm = await run(db, COMPANY, { lineId: LINE });
  ok('ARC_WELD_LENGTH held in mm -> / 1000', mm.exprOf.get('CG-ARCWELD')?.expression === 'item.ARC_WELD_LENGTH / 1000 * 2.8');
  ok('SURFACE_AREA held in mm2 -> / 1000000', mm.exprOf.get('CG-BLAST')?.expression === 'item.SURFACE_AREA / 1000000 * 2 * 2.5 + 15');
  await conn.query("UPDATE cf_specifications SET default_uom = 'kg' WHERE company_id = ? AND code = 'SURFACE_AREA'", [COMPANY]);
  const kg = await run(db, COMPANY, { lineId: LINE });
  ok('an unknown unit blocks that rate (and only it)', kg.actions.some((a) => a.status === 'blocked' && /SURFACE_AREA/.test(a.why)) && !kg.exprOf.has('CG-BLAST') && kg.exprOf.has('CG-ARCWELD'));
  await conn.query('ROLLBACK TO SAVEPOINT units');

  /* ------------------------------------------------------------------------ */
  section('3. Refusal: a started step -> nothing written');
  await conn.query('SAVEPOINT started');
  const [[step]] = await conn.query(`SELECT s.id FROM cf_production_steps s JOIN cf_production_items pi ON pi.id = s.production_item_id
                                       WHERE pi.release_id = ? AND s.deleted_at IS NULL ORDER BY s.id LIMIT 1`, [rel0.id]);
  await conn.query("UPDATE cf_production_steps SET state = 'in_progress', started_at = NOW() WHERE id = ?", [step.id]);
  const fS = await formulaRows();
  const eS = await refusal(() => run(db, COMPANY, { lineId: LINE, commit: true }));
  ok('--commit refuses (STARTED)', eS?.code === 'STARTED' && /started/i.test(eS.message), eS?.message);
  ok('…no formula written, rule unchanged, release kept', (await formulaRows()) === fS && (await ruleOf('CG-ARCWELD')).code === 'CG_ARC_WELD_TIME' && (await liveReleaseOfLine(conn, COMPANY, LINE))?.id === rel0.id);
  await conn.query('ROLLBACK TO SAVEPOINT started');

  /* ------------------------------------------------------------------------ */
  section('4. --commit: rules, take back, release again');
  const oldArc = await q1("SELECT id, expression FROM cf_formulas WHERE company_id = ? AND code = 'CG_ARC_WELD_TIME' AND deleted_at IS NULL", [COMPANY]);
  const out = await run(db, COMPANY, { lineId: LINE, commit: true, userId: c.userId });
  ok('4 formula/rule changes applied', out.applied === 4, `${out.applied}`);
  const arcRule = await ruleOf('CG-ARCWELD');
  const blastRule = await ruleOf('CG-BLAST');
  ok('arc rule -> CG_ARC_WELD_FLAT_TIME, notes name the source', arcRule.code === 'CG_ARC_WELD_FLAT_TIME' && arcRule.work_minutes == null && /Process_Flow_v5 Master_Formulae worked example, flat 2\.8 min\/m, user OK 2026-10-01/.test(arcRule.notes ?? ''));
  ok('blast rule -> CG_BLAST_TIME', blastRule.code === 'CG_BLAST_TIME' && blastRule.work_minutes == null);
  const oldArcNow = await q1('SELECT expression, deleted_at FROM cf_formulas WHERE id = ?', [oldArc.id]);
  ok('old CG_ARC_WELD_TIME kept as it was', !oldArcNow.deleted_at && oldArcNow.expression === oldArc.expression);
  const live = await liveReleaseOfLine(conn, COMPANY, LINE);
  ok('took back release 1, released again with the same finished area and notes', out.tookBack?.id === rel0.id && live && live.id !== rel0.id && live.id === out.released?.id && live.finished_area_id === (area?.id ?? live.finished_area_id) && live.notes === `${tag} first release`);
  ok('same steps, more timed', out.released.steps === out.tookBack.steps && out.released.timed > out.tookBack.timed, `${out.tookBack.timed}->${out.released.timed}`);
  ok('new release: arc and blast minutes = the projection', near(out.newRelOps.get('CG-ARCWELD')?.minutes, dry.projected.byCode.get('CG-ARCWELD').minutes, 1) && near(out.newRelOps.get('CG-BLAST')?.minutes, dry.projected.byCode.get('CG-BLAST').minutes, 1),
    `${out.newRelOps.get('CG-ARCWELD')?.minutes} / ${out.newRelOps.get('CG-BLAST')?.minutes}`);
  ok('new release gained exactly arc + blast', near(out.released.minutes - out.tookBack.minutes, arcWant + blastWant, 1), `${(out.released.minutes - out.tookBack.minutes).toFixed(1)}`);
  ok('Times grid after = projection', near(out.after.all, dry.projected.all, 0.5));

  /* ------------------------------------------------------------------------ */
  section('5. Idempotent: a second run changes nothing and leaves the release alone');
  const again = await run(db, COMPANY, { lineId: LINE, commit: true, userId: c.userId });
  ok('second run: 0 rule changes, 0 time differences', again.ruleChanges.length === 0 && again.diffs.length === 0, `${again.ruleChanges.length}/${again.diffs.map((d) => d.op).join(',')}`);
  ok('second run: nothing taken back or released', !again.tookBack && !again.released && (await liveReleaseOfLine(conn, COMPANY, LINE))?.id === live.id);

  /* ------------------------------------------------------------------------ */
  section('6. Rules already right, release stale -> re-released on its own');
  await conn.query('SAVEPOINT stale');
  await unrelease(conn, c, live.id);
  await conn.query('UPDATE cf_operation_machine_rules SET work_formula_id = NULL WHERE id = ?', [blastRule.id]);
  const stale = await releaseLine(conn, c, LINE, { finishedAreaId: live.finished_area_id, notes: 'stale' });
  await conn.query('UPDATE cf_operation_machine_rules SET work_formula_id = (SELECT id FROM cf_formulas WHERE company_id = ? AND code = ? AND deleted_at IS NULL) WHERE id = ?', [COMPANY, 'CG_BLAST_TIME', blastRule.id]);
  const s = await run(db, COMPANY, { lineId: LINE, commit: true, userId: c.userId });
  ok('no rule change, blast differs, release taken back and released again', s.ruleChanges.length === 0 && s.diffs.length === 1 && s.diffs[0].op === 'CG-BLAST' && s.tookBack?.id === stale.id && !!s.released && s.released.id !== stale.id);
  ok('…the new release carries the blast time, notes kept', near(s.newRelOps.get('CG-BLAST')?.minutes, blastWant, 1) && (await liveReleaseOfLine(conn, COMPANY, LINE))?.notes === 'stale');
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
