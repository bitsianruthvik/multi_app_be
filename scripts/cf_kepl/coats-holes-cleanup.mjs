/**
 * coats-holes-cleanup.mjs — three decisions of the user's, 2026-11-01, laid on a tenant's setup (DATA, through the
 * services, so every flow-made column and every open row follows):
 *
 *   1. WHOLE SURFACE AT EVERY LEVEL ("when they do any coat, they will need entire surface area, not one side")
 *      plate part     (2 × area + edge × thickness) / 1e6 — area and edge from the drawing (TRUE_AREA,
 *                     DRAWN_EDGE_LENGTH: outline + cut-outs + hole walls), else the rectangle and its perimeter
 *      profile part   girth × length + the two cut ends; girth 2 × SECTION_AREA / THICKNESS (a thin-walled section),
 *                     else 2 × (DEPTH + WIDTH)
 *      assembly       the sum of its parts' — bought items (bolts, studs) are not ours to coat
 *      structure      the same sum (it had none; SPAN-001's own rule goes)
 *   2. HOLE SETS ("a linked array store") — HOLE_SET, a LIST on every plate part: one row per kind of hole
 *      { DIA, COUNT, KIND, DEPTH }, defaulted from the drawing (DRAWN_HOLE_SET), typeable over. HOLES is its count;
 *      CNC drilling times each row at its own diameter and depth.
 *   3. COLUMNS NOTHING READS (docs/spec_usage_inventory.md) — COATS (BLAST no longer reads it; off the New order
 *      dialog), PART_FUNCTION, SPAN_LENGTH and LENGTH where they mean nothing, SHIP_UNIT on parts, CUT_FROM fixed on
 *      assemblies, CG_LINE_LEN on the girder line, and 12 specifications attached to nothing.
 *
 * Frozen (locked / released / closed) rows are never touched — they keep what they were frozen with.
 * Values of a removed column are taken off OPEN rows and definitions (a frozen row keeps its own).
 *
 *   node scripts/cf_kepl/coats-holes-cleanup.mjs --company 30005 [--prod]            dry run, rolled back
 *   node scripts/cf_kepl/coats-holes-cleanup.mjs --company 30005 [--prod] --apply    commits
 * Re-running after an apply changes nothing. Needs init.sql §99 (the 'list' data type).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

/* ===========================================================================
 * The setup, as data
 * ======================================================================== */

export const NEW_SPECS = (HOLE_SET_CONFIG) => [
  { code: 'DRAWN_EDGE_LENGTH', name: 'Edge length (from the drawing)', dataType: 'number', defaultUom: 'mm', measurementType: 'LENGTH', decimals: 1,
    description: 'Every edge of the part a coat covers: its outline, cut-outs and the walls of its holes, read from its DXF. Written by the system; formulas read it.' },
  { code: 'DRAWN_HOLE_SET', name: 'Holes on the drawing (by size)', dataType: 'list', tableConfig: HOLE_SET_CONFIG,
    description: 'The holes the part’s DXF shows, one row per diameter. Written by the system; HOLE_SET takes it.' },
  { code: 'HOLE_SET', name: 'Holes (by size)', dataType: 'list', tableConfig: HOLE_SET_CONFIG,
    description: 'One row per kind of hole: diameter, how many, kind, and how deep (blank = the part’s thickness). Comes from the drawing; type over it to add kinds or depths.' },
];

export const FORMULAS = {
  // Edited in place — every rule and row that names them follows.
  PART_PLATE_AREA: { name: 'Plate part surface area — whole surface', description: 'Both faces and every edge (outline, cut-outs, hole walls) of the drawing; the rectangle and its perimeter where the part has no drawing.',
    expression: '(2 * FIRST(TRUE_AREA, LENGTH * WIDTH) + FIRST(DRAWN_EDGE_LENGTH, 2 * (LENGTH + WIDTH)) * THICKNESS) / 1e6' },
  PART_HOLES: { name: 'Holes — the hole set', description: 'The holes of the part’s hole set (all its rows); what its drawing shows where it has none.',
    expression: 'FIRST(EACH(HOLE_SET, row.COUNT), DRAWN_HOLES)' },
  CG_ASSY_SURFACE_AREA: { name: 'Assembly surface area — its parts', description: 'The whole surface of every part below; bought items (bolts, studs) are not ours to coat.',
    expression: 'SUM(IF(children.family = "BOUGHT", 0, children.SURFACE_AREA))' },
  // New.
  PART_HOLE_SET: { name: 'Hole set — from the drawing', description: 'The holes the part’s drawing shows, one row per diameter.', expression: 'DRAWN_HOLE_SET' },
  PART_SECTION_AREA: { name: 'Profile part surface area — whole surface', description: 'Girth × length plus the two cut ends; the girth of a thin-walled section is 2 × its area ÷ its thickness, else 2 × (depth + width).',
    expression: '(FIRST(2 * SECTION_AREA / THICKNESS, 2 * (DEPTH + WIDTH)) * LENGTH + 2 * FIRST(SECTION_AREA, 0)) / 1e6' },
};

export const CNC_DRILL = 'EACH(item.HOLE_SET, row.COUNT * LOOKUP(machine.CNC_DRILL_TIME, row.DIA, FIRST(row.DEPTH, item.THICKNESS))) / 60';
export const UNATTACHED = ['HOLED', 'SKEW_ANGLE', 'GIRDER_SPACING', 'WELD_LENGTH', 'WELD_SIZE', 'HOLE_TRANSFERS', 'JOINTS', 'ARC_WELD_SIZE',
  'HBFIT_JOINTS', 'STIFFENER_FIT_TONNES', 'STIFFENER_FIT_TONNES_AFTER_FLIP', 'CG_LINE_LENGTH'];   // HOLES_INNER kept: MANDRILL-INNER may come back

/* ===========================================================================
 * The setup
 * ======================================================================== */

export async function setup(db, { companyId, userId = null, log = console.log, dryRun = false }) {
  const svc = (p) => import(pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'apps', 'cf_erp', p)).href);
  const { createSpec, updateSpec } = await svc('services/specificationService.js');
  const { createFormula, updateFormula } = await svc('services/formulaService.js');
  const { createRule, updateRule, deleteRule } = await svc('services/assignmentService.js');
  const { updateTimingRule } = await svc('services/operationService.js');
  const { updateChart } = await svc('services/chartService.js');
  const { LOCKED_ORDER_STATUSES } = await svc('services/records.js');
  const { HOLE_SET_CONFIG } = await svc('lib/listSpec.js');
  // Rule and formula changes put their company-wide re-working off: step 7 works every open line out, a line at a time.
  const c = { companyId, userId, deferRematerialize: true };
  const out = { changed: 0, removedValues: {}, lines: [] };
  const did = (what) => { out.changed += 1; log(`   ${what}`); };
  const t0 = Date.now();
  const at = () => `(${Math.round((Date.now() - t0) / 1000)} s)`;

  const [[enumOk]] = await db.query("SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_specifications' AND COLUMN_NAME = 'data_type' AND COLUMN_TYPE LIKE '%''list''%'");
  // Without §99 a DRY RUN still tries everything else (the hole sets are left out and said so); an apply needs it.
  const lists = !!Number(enumOk.n);
  if (!lists && !dryRun) throw new Error("This database has no 'list' data type yet — run cf_erp init.sql §99 first.");
  if (!lists) log("   (no 'list' data type here yet — init.sql §99 — so this dry run leaves the hole sets out)");

  const specs = async () => new Map((await db.query('SELECT id, UPPER(code) AS code, data_type, status, order_level FROM cf_specifications WHERE company_id = ? AND deleted_at IS NULL', [companyId]))[0].map((s) => [s.code, s]));
  const [nodeRows] = await db.query("SELECT id, code FROM cf_classification_nodes WHERE company_id = ? AND deleted_at IS NULL AND scope <> 'machine'", [companyId]);
  const node = new Map(nodeRows.map((n) => [String(n.code).toUpperCase(), Number(n.id)]));
  for (const k of ['FABRICATED', 'FAB_PARTS', 'PLATE_PART', 'PROFILE_PART', 'FAB_ASSY', 'GIRDER_SEGMENT', 'FAB_STRUCT', 'COMPOSITE_GIRDER', 'GIRDER_LINE']) {
    if (!node.has(k)) throw new Error(`Classification ${k} is not in company ${companyId}.`);
  }
  const formulas = async () => new Map((await db.query('SELECT id, UPPER(code) AS code, expression FROM cf_formulas WHERE company_id = ? AND deleted_at IS NULL', [companyId]))[0].map((f) => [f.code, f]));
  /** The live rule of spec `code` on a subject, or null. */
  const ruleOn = async (code, subjectType, subjectId) => {
    const [[r]] = await db.query(
      `SELECT a.* FROM cf_spec_assignments a JOIN cf_specifications s ON s.id = a.specification_id
        WHERE a.company_id = ? AND s.code = ? AND a.subject_type = ? AND a.subject_id = ? AND a.capture_at = 'item' AND a.origin = 'manual' AND a.deleted_at IS NULL`,
      [companyId, code, subjectType, subjectId]);
    return r ?? null;
  };
  const defOf = async (code) => { const [[m]] = await db.query("SELECT id FROM cf_master_records WHERE company_id = ? AND code = ? AND record_kind = 'definition' AND deleted_at IS NULL", [companyId, code]); return m ? Number(m.id) : null; };

  // ---- 1. specifications ------------------------------------------------------
  log('1. Specifications');
  let spec = await specs();
  for (const s of NEW_SPECS(HOLE_SET_CONFIG).filter((x) => lists || x.dataType !== 'list')) {
    if (spec.has(s.code)) { log(`   ${s.code} — already there`); continue; }
    await createSpec(db, c, s);
    did(`${s.code} — ADDED`);
  }
  spec = await specs();

  // ---- 2. formulas --------------------------------------------------------------
  log(at(), '2. Formulas');
  let form = await formulas();
  for (const [code, f] of Object.entries(FORMULAS)) {
    if (!lists && /HOLE_SET/.test(f.expression)) { log(`   ${code} — left out (no lists yet)`); continue; }
    const have = form.get(code);
    if (!have) { await createFormula(db, c, { code, name: f.name, description: f.description, expression: f.expression }); did(`${code} — ADDED: ${f.expression}`); continue; }
    if (have.expression.trim() === f.expression) { log(`   ${code} — already ${f.expression}`); continue; }
    await updateFormula(db, c, have.id, { name: f.name, description: f.description, expression: f.expression });
    did(`${code}: ${have.expression}  →  ${f.expression}`);
  }
  form = await formulas();

  // ---- 3. rules -----------------------------------------------------------------
  log(at(), '3. Rules');
  const add = async (code, at, body, why) => {
    const subjectType = at.def ? 'master' : 'classification';
    const subjectId = at.def ?? node.get(at.node);
    const have = await ruleOn(code, subjectType, subjectId);
    if (have) {
      const same = have.value_rule === (body.valueRule ?? 'entered') && Number(have.formula_id ?? 0) === Number(body.formulaId ?? 0)
        && !!Number(have.is_applicable) === (body.isApplicable ?? true) && !!Number(have.is_required) === !!body.isRequired;
      if (same) { log(`   ${code} on ${at.node ?? at.code} — already so`); return; }
      await updateRule(db, c, have.id, body);
      did(`${code} on ${at.node ?? at.code} — CHANGED (${why})`);
      return;
    }
    await createRule(db, c, { specificationId: spec.get(code).id, subjectType, subjectId, captureAt: 'item', ...body });
    did(`${code} on ${at.node ?? at.code} — ADDED (${why})`);
  };
  const drop = async (code, at, why) => {
    const subjectId = at.def ?? node.get(at.node);
    if (subjectId == null) { log(`   ${code} on ${at.node ?? at.code} — no such subject`); return; }
    const have = await ruleOn(code, at.def ? 'master' : 'classification', subjectId);
    if (!have) { log(`   ${code} on ${at.node ?? at.code} — already gone`); return; }
    await deleteRule(db, c, have.id);
    did(`${code} on ${at.node ?? at.code} — REMOVED (${why})`);
  };
  // Surface area
  await add('SURFACE_AREA', { node: 'PROFILE_PART' }, { valueRule: 'defaulted', formulaId: form.get('PART_SECTION_AREA').id }, 'whole surface of a section');
  await add('SURFACE_AREA', { node: 'FAB_STRUCT' }, { valueRule: 'defaulted', formulaId: form.get('CG_ASSY_SURFACE_AREA').id }, 'a structure rolls its parts up too');
  await drop('SURFACE_AREA', { def: await defOf('SPAN-001'), code: 'SPAN-001' }, 'the structures rule replaces it');
  // Hole sets
  if (lists) await add('HOLE_SET', { node: 'PLATE_PART' }, { valueRule: 'defaulted', formulaId: form.get('PART_HOLE_SET').id }, 'from the drawing, typeable over');
  // Columns nothing reads
  await drop('PART_FUNCTION', { node: 'FAB_PARTS' }, 'nothing reads it');
  await drop('SPAN_LENGTH', { node: 'FAB_ASSY' }, 'only a span reads it');
  await add('SPAN_LENGTH', { node: 'COMPOSITE_GIRDER' }, { valueRule: 'entered' }, 'the span keeps it');
  await drop('SPAN_LENGTH', { node: 'FAB_STRUCT' }, 'moved to the span');
  await add('LENGTH', { node: 'GIRDER_SEGMENT' }, { valueRule: 'entered' }, 'a segment’s length is read by HB fitting');
  await drop('LENGTH', { node: 'FAB_ASSY' }, 'moved to the girder segment; no line is priced per metre');
  await add('SHIP_UNIT', { node: 'FAB_PARTS' }, { valueRule: 'entered', isApplicable: false }, 'a part does not ship on its own');
  await add('CUT_FROM', { node: 'FAB_ASSY' }, { valueRule: 'fixed' }, 'NONE, not asked');
  await add('CUT_FROM', { node: 'FAB_STRUCT' }, { valueRule: 'fixed' }, 'NONE, not asked');
  await drop('CG_LINE_LEN', { def: await defOf('GLINE-001'), code: 'GLINE-001' }, 'JACKBEND reads the machine’s');

  // ---- 4. times -----------------------------------------------------------------
  log(at(), '4. Times');
  const [[cnc]] = await db.query(
    `SELECT r.id, r.work_expression FROM cf_operation_machine_rules r JOIN cf_operations o ON o.id = r.operation_id AND o.deleted_at IS NULL
      WHERE r.company_id = ? AND o.code = 'CNCDRILL' AND r.subject_type = 'classification' AND r.deleted_at IS NULL ORDER BY r.id LIMIT 1`, [companyId]);
  if (!lists) log('   CNCDRILL — left out (no lists yet)');
  else if (!cnc) log('   CNCDRILL — no rule');
  else if (String(cnc.work_expression ?? '').trim() === CNC_DRILL) log('   CNCDRILL — already by the hole set');
  else { await updateTimingRule(db, c, cnc.id, { workExpression: CNC_DRILL }); did(`CNCDRILL: ${cnc.work_expression}  →  ${CNC_DRILL}`); }
  // BLAST: blasting is done once, whatever coats follow — the chart keeps its 1-coat minutes, by variant only.
  const [[blast]] = await db.query("SELECT id, table_config FROM cf_specifications WHERE company_id = ? AND code = 'BLAST_TIME' AND data_type = 'table' AND deleted_at IS NULL", [companyId]);
  const blastAxes = blast ? (typeof blast.table_config === 'string' ? JSON.parse(blast.table_config) : blast.table_config)?.axes ?? [] : [];
  const coatsAt = blastAxes.findIndex((a) => String(a.field ?? '').toUpperCase() === 'COATS');
  if (!blast) log('   BLAST_TIME — no chart');
  else if (coatsAt < 0) log('   BLAST_TIME — already without coats');
  else {
    const [vals] = await db.query('SELECT id, value_json FROM cf_spec_values WHERE company_id = ? AND specification_id = ? AND deleted_at IS NULL AND value_json IS NOT NULL', [companyId, blast.id]);
    for (const v of vals) {
      const j = typeof v.value_json === 'string' ? JSON.parse(v.value_json) : v.value_json;
      if (!Array.isArray(j?.rows)) continue;
      const one = j.rows.filter((r) => Number(r[coatsAt]) === 1);
      await db.query('UPDATE cf_spec_values SET value_json = ? WHERE company_id = ? AND id = ?', [JSON.stringify({ rows: one }), companyId, v.id]);
    }
    await updateChart(db, c, blast.id, { inputs: blastAxes.map((a, i) => ({ ...(a.kind === 'level' ? { level: a.level } : { field: a.field, unit: a.unit }), from: i })).filter((_, i) => i !== coatsAt) });
    did(`BLAST_TIME — by ${blastAxes.filter((_, i) => i !== coatsAt).map((a) => a.label).join(', ')} only (the 1-coat minutes); BLAST reads no COATS`);
  }

  // ---- 5. specifications retired --------------------------------------------------
  log(at(), '5. Specifications retired');
  spec = await specs();
  const retire = async (code, why) => {
    const s = spec.get(code);
    if (!s) { log(`   ${code} — not in this company`); return; }
    if (s.status === 'inactive' && !Number(s.order_level)) { log(`   ${code} — already retired`); return; }
    if (Number(s.order_level)) await updateSpec(db, c, s.id, { orderLevel: false });
    await db.query("UPDATE cf_specifications SET status = 'inactive' WHERE company_id = ? AND id = ?", [companyId, s.id]);
    did(`${code} — retired (${why})`);
  };
  await retire('COATS', 'BLAST no longer reads it; off the New order dialog');
  await retire('PART_FUNCTION', 'nothing reads it');
  for (const code of UNATTACHED) await retire(code, 'attached to nothing');

  // ---- 6. values of removed columns on open rows and definitions -------------------
  log(at(), '6. Values of removed columns (open rows and definitions; frozen rows keep theirs)');
  const statuses = [...LOCKED_ORDER_STATUSES];
  const openRecords = `
    SELECT m.id FROM cf_master_records m
      LEFT JOIN cf_item_details i ON i.master_id = m.id AND i.deleted_at IS NULL
      LEFT JOIN cf_sales_order_lines l ON l.id = i.owner_order_line_id
      LEFT JOIN cf_sales_orders o ON o.id = l.order_id
     WHERE m.company_id = ? AND m.deleted_at IS NULL
       AND (m.record_kind = 'definition'
         OR (i.item_type = 'temporary' AND l.deleted_at IS NULL AND o.deleted_at IS NULL AND l.locked_at IS NULL AND o.status NOT IN (?)
             AND NOT EXISTS (SELECT 1 FROM cf_production_releases r WHERE r.company_id = m.company_id AND r.order_line_id = l.id AND r.deleted_at IS NULL)))`;
  const under = (codes) => `m.classification_id IN (SELECT n.id FROM cf_classification_nodes n WHERE n.company_id = m.company_id AND n.deleted_at IS NULL AND (UPPER(n.code) IN (${codes.map(() => '?').join(', ')}) OR n.parent_id IN (SELECT p.id FROM cf_classification_nodes p WHERE p.company_id = m.company_id AND UPPER(p.code) IN (${codes.map(() => '?').join(', ')}))))`;
  const clear = async (code, where, params, why) => {
    const s = spec.get(code);
    if (!s) return;
    const [r] = await db.query(
      `UPDATE cf_spec_values v SET v.deleted_at = NOW()
        WHERE v.company_id = ? AND v.specification_id = ? AND v.subject_type = 'master' AND v.deleted_at IS NULL
          AND v.subject_id IN (SELECT id FROM (${openRecords}) open_rows)
          AND v.subject_id IN (SELECT m.id FROM cf_master_records m WHERE m.company_id = ? ${where ? `AND ${where}` : ''})`,
      [companyId, s.id, companyId, statuses, companyId, ...params]);
    out.removedValues[code] = (out.removedValues[code] ?? 0) + Number(r.affectedRows);
    if (r.affectedRows) did(`${code}: ${r.affectedRows} value(s) taken off (${why})`);
  };
  await clear('COATS', '', [], 'retired');
  await clear('PART_FUNCTION', '', [], 'retired');
  await clear('SPAN_LENGTH', `(${under(['FAB_ASSY', 'GIRDER_LINE'])})`, ['FAB_ASSY', 'GIRDER_LINE', 'FAB_ASSY', 'GIRDER_LINE'], 'not a span');
  await clear('LENGTH', `${under(['FAB_ASSY'])} AND m.classification_id <> ${Number(node.get('GIRDER_SEGMENT'))}`, ['FAB_ASSY', 'FAB_ASSY'], 'an assembly that is not a girder segment');
  await clear('CG_LINE_LEN', `m.classification_id = ${Number(node.get('GIRDER_LINE'))}`, [], 'the machine’s is read');
  await clear('SURFACE_AREA', `m.id = ${Number(await defOf('SPAN-001') ?? 0)} AND m.record_kind = 'definition'`, [], 'the structures roll-up gives it');

  out.deferred = (c.deferred ?? []).length;
  log(at(), 'setup done');
  return out;
}

/**
 * Step 7, apart so an apply commits it a line at a time (a TiDB transaction lives an hour at most): every open line's
 * drawing facts (the new edge length and hole set), then all its values worked out again. The work the rule changes put
 * off (c.deferred) is all here: no catalog item sits under FABRICATED, and frozen rows do not change.
 */
export async function openLines(db, companyId) {
  const { LOCKED_ORDER_STATUSES } = await import('../../apps/cf_erp/services/records.js');
  const [lines] = await db.query(
    `SELECT l.id, o.code AS order_number FROM cf_sales_order_lines l JOIN cf_sales_orders o ON o.id = l.order_id AND o.deleted_at IS NULL
      WHERE l.company_id = ? AND l.deleted_at IS NULL AND l.locked_at IS NULL AND o.status NOT IN (?)
        AND NOT EXISTS (SELECT 1 FROM cf_production_releases r WHERE r.company_id = l.company_id AND r.order_line_id = l.id AND r.deleted_at IS NULL)`,
    [companyId, [...LOCKED_ORDER_STATUSES]]);
  return lines;
}

export async function workOutLine(db, { companyId, userId = null, line, log = console.log }) {
  const { refreshDrawingValues } = await import('../../apps/cf_erp/services/drawingValueService.js');
  const { materializeLine } = await import('../../apps/cf_erp/services/orderValuesService.js');
  const c = { companyId, userId };
  const t0 = Date.now();
  const facts = await refreshDrawingValues(db, c, line.id, { force: true });
  const mat = await materializeLine(db, c, line.id);
  log(`   ${line.order_number} line ${line.id}: ${facts.written ?? 0} drawing fact(s) written · ${JSON.stringify(mat ?? {}).slice(0, 120)} · ${Math.round((Date.now() - t0) / 1000)} s`);
}

/* ===========================================================================
 * CLI
 * ======================================================================== */

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv;
  const COMPANY = Number(argv[argv.indexOf('--company') + 1]);
  const APPLY = argv.includes('--apply');
  if (!COMPANY) { console.error('Usage: --company <id> [--prod] [--apply]'); process.exit(2); }
  const here = path.dirname(fileURLToPath(import.meta.url));
  if (argv.includes('--prod')) {
    const env = {}; fs.readFileSync(path.join(here, '..', '..', '..', '.env.tidb'), 'utf8').split('\n').forEach((l) => { l = l.trim(); if (!l || l.startsWith('#')) return; const [k, ...r] = l.split('='); env[k.trim()] = r.join('=').trim(); });
    Object.assign(process.env, { DB_HOST: env.DB_HOST, DB_PORT: env.DB_PORT ?? '4000', DB_USER: env.DB_USER, DB_PASSWORD: env.DB_PASSWORD, DB_NAME: env.DB_NAME, DB_SSL: 'true' });
  }
  const { pool } = await import(pathToFileURL(path.join(here, '..', '..', 'db.js')).href);
  await import(pathToFileURL(path.join(here, '..', '..', 'apps', 'cf_erp', 'services', 'codegenProvider.js')).href);
  const db = await pool.getConnection();
  try {
    const [[admin]] = await db.query("SELECT id FROM users WHERE company_id = ? AND email LIKE 'admin@%' ORDER BY id LIMIT 1", [COMPANY]);
    await db.beginTransaction();
    const out = await setup(db, { companyId: COMPANY, userId: admin?.id ?? null, dryRun: !APPLY });
    console.log(`\n${out.changed} setup change(s); values taken off: ${JSON.stringify(out.removedValues)}; ${out.deferred} re-working(s) put off to the lines.`);
    if (APPLY) { await db.commit(); console.log('Setup SAVED.'); }
    console.log('7. Open order lines');
    const lines = await openLines(db, COMPANY);
    for (const line of lines) {
      if (APPLY) await db.beginTransaction();
      await workOutLine(db, { companyId: COMPANY, userId: admin?.id ?? null, line });
      if (APPLY) await db.commit();
    }
    if (APPLY) console.log(`SAVED: ${lines.length} open line(s) worked out again.`);
    else { await db.rollback(); console.log('DRY RUN — rolled back. Add --apply to save.'); }
  } catch (e) {
    try { await db.rollback(); } catch { /* none */ }
    console.error('FAILED (rolled back):', e.stack ?? e.message); process.exitCode = 1;
  } finally { db.release(); await pool.end(); process.exit(process.exitCode ?? 0); }
}
