/**
 * flow-specs-migrate.mjs — values follow the flow (init.sql §50, user 2026-10-08).
 *
 * "Not every part needs holes, piercings, hole transfers, metallising coats … while selecting a
 * default flow to an item, it should check if the item has all the required specifications."
 * Run AFTER §50 (the origin column). Three moves, one transaction:
 *
 *   1. RETIRE  — classification rules for values nothing reads (no formula, no time, no code
 *                scheme). The specifications and any typed values stay; they are just not asked.
 *   2. MOVE    — classification rules that ask for an operation's input (entered values a time
 *                formula reads, e.g. HOLES on every Plate part) come off the classification...
 *   3. SYNC    — ...and every definition / item whose flow reads them gets them as REQUIRED
 *                (flowSpecService.syncFlowSpecs — the same code that runs on every save).
 *      Then a safety pass: any record holding a typed value for a moved code that would no longer
 *      be asked keeps an optional rule of its own — no value disappears from a time formula.
 *
 *   node scripts/cf_kepl/flow-specs-migrate.mjs --company 30005            (dry run: rolled back)
 *   node scripts/cf_kepl/flow-specs-migrate.mjs --company 30005 --apply    (commits)
 * Re-running changes nothing.
 */
const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const COMPANY = Number(arg('company'));
const APPLY = process.argv.includes('--apply');
if (!Number.isInteger(COMPANY)) throw new Error('Usage: --company <id> [--apply]');

/** Read by nothing on Placebo (checked 2026-10-08); each is checked again below before it goes. */
const RETIRE = ['ARC_WELD_SIZE', 'MIG_WELD_SIZE', 'SAW_WELD_SIZE', 'WELD_LENGTH', 'WELD_SIZE', 'COATS', 'JOINTS', 'STIFFENERS',
  'STIFFENERS_AFTER_FLIP', 'GIRDER_TYPE', 'HOLE_DIA', 'HOLED', 'GIRDER_SPACING', 'SKEW_ANGLE'];
/** What an item IS — stays on its classification whoever reads it. */
const UNIVERSAL = new Set(['THICKNESS', 'LENGTH', 'WIDTH', 'DEPTH', 'GRADE', 'IMPACT_CLASS', 'MATERIAL', 'DENSITY', 'SECTION_AREA', 'WEIGHT',
  'SURFACE_AREA', 'CUT_FROM', 'SHIP_UNIT', 'PLATE_KIND', 'NESTING', 'NEST_MANUAL', 'DRAWING_MARK', 'PART_FUNCTION', 'SPAN_LENGTH']);

const { pool } = await import('../../db.js');
const { parseFormula } = await import('../../apps/cf_erp/services/formulaEngine.js');
const { syncFlowSpecs } = await import('../../apps/cf_erp/services/flowSpecService.js');
const { readMasters, resolveCodes } = await import('../../apps/cf_erp/lib/cutFrom.js');
const { insertRows } = await import('../../apps/cf_erp/lib/db.js');

const db = await pool.getConnection();
const c = { companyId: COMPANY, userId: null };
const reads = (text, into, { itemOnly = false } = {}) => {
  if (text == null || String(text).trim() === '') return;
  let p; try { p = parseFormula(String(text)); } catch { return; }
  for (const x of p.itemRefs ?? []) into.add(String(x).toUpperCase());
  for (const l of p.lookupRefs ?? []) if (l.role === 'item') into.add(String(l.code).toUpperCase());
  if (!itemOnly) for (const x of [...(p.references ?? []), ...(p.rollupTerms ?? [])]) into.add(String(x).toUpperCase());
};
try {
  const [[col]] = await db.query("SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_spec_assignments' AND COLUMN_NAME = 'origin'");
  if (!Number(col.n)) throw new Error('Run s50.sql first — cf_spec_assignments.origin is missing.');
  await db.beginTransaction();

  // What reads what. Value formulas (and the codes they reference), code schemes, operation times.
  const valueReads = new Set();
  const [formulas] = await db.query('SELECT expression FROM cf_formulas WHERE company_id = ? AND deleted_at IS NULL', [COMPANY]);
  for (const f of formulas) reads(f.expression, valueReads);
  const [tokens] = await db.query(
    `SELECT token_key FROM cf_code_scheme_segments WHERE company_id = ? AND deleted_at IS NULL AND token_key LIKE 'spec:%'
     UNION SELECT token_key FROM cf_code_scheme_conditions WHERE company_id = ? AND deleted_at IS NULL AND token_key LIKE 'spec:%'`, [COMPANY, COMPANY]);
  for (const t of tokens) valueReads.add(t.token_key.slice(5).toUpperCase());
  const opReads = new Set();
  const [rules] = await db.query(
    `SELECT r.work_expression, r.setup_expression, wf.expression AS wexpr, sf.expression AS sexpr
       FROM cf_operation_machine_rules r
       LEFT JOIN cf_formulas wf ON wf.id = r.work_formula_id AND wf.deleted_at IS NULL
       LEFT JOIN cf_formulas sf ON sf.id = r.setup_formula_id AND sf.deleted_at IS NULL
      WHERE r.company_id = ? AND r.deleted_at IS NULL`, [COMPANY]);
  for (const r of rules) { reads(r.work_expression ?? r.wexpr, opReads, { itemOnly: true }); reads(r.setup_expression ?? r.sexpr, opReads, { itemOnly: true }); }

  const classRules = async (codes, extra = '') => codes.length ? (await db.query(
    `SELECT a.id, UPPER(s.code) AS code, n.code AS node, a.value_rule FROM cf_spec_assignments a
       JOIN cf_specifications s ON s.id = a.specification_id
       JOIN cf_classification_nodes n ON n.id = a.subject_id
      WHERE a.company_id = ? AND a.subject_type = 'classification' AND a.deleted_at IS NULL AND s.code IN (?) ${extra}
      ORDER BY n.code, s.code`, [COMPANY, codes]))[0] : [];
  const drop = async (rows) => { if (rows.length) await db.query('UPDATE cf_spec_assignments SET deleted_at = NOW() WHERE company_id = ? AND id IN (?)', [COMPANY, rows.map((r) => r.id)]); };

  // 1. RETIRE
  const retire = RETIRE.filter((code) => {
    if (valueReads.has(code) || opReads.has(code)) { console.log(`  keep ${code}: something reads it`); return false; }
    return true;
  });
  const retired = await classRules(retire);
  await drop(retired);
  console.log(`\n1. RETIRED ${retired.length} classification rules (${retire.length} values nothing reads):`);
  for (const r of retired) console.log(`   ${r.node.padEnd(22)} ${r.code}`);

  // 2. MOVE
  const moving = [...opReads].filter((code) => !UNIVERSAL.has(code) && !valueReads.has(code));
  const moved = await classRules(moving, "AND a.value_rule = 'entered'");
  await drop(moved);
  console.log(`\n2. MOVED OFF classifications: ${moved.length} rules for operation inputs (${moving.sort().join(', ')}):`);
  for (const r of moved) console.log(`   ${r.node.padEnd(22)} ${r.code}`);

  // 3. SYNC every record that runs by a flow.
  const [recs] = await db.query(
    `SELECT id FROM cf_master_records WHERE company_id = ? AND deleted_at IS NULL AND default_flow_id IS NOT NULL
     UNION SELECT bl.child_id FROM cf_bom_lines bl WHERE bl.company_id = ? AND bl.deleted_at IS NULL AND bl.operation_flow_id IS NOT NULL`, [COMPANY, COMPANY]);
  const result = await syncFlowSpecs(db, c, recs.map((r) => Number(r.id)));
  const names = new Map();
  if (result.added.length || result.removed.length) {
    const [rows] = await db.query('SELECT id, code, name, record_kind FROM cf_master_records WHERE company_id = ? AND id IN (?)', [COMPANY, [...new Set([...result.added, ...result.removed].map((a) => a.recordId))]]);
    for (const r of rows) names.set(Number(r.id), `${r.record_kind === 'definition' ? 'def' : 'item'} ${r.code ?? ''} ${r.name}`.trim());
  }
  const byRec = new Map();
  for (const a of result.added) { if (!byRec.has(a.recordId)) byRec.set(a.recordId, []); byRec.get(a.recordId).push(a.madeRequired ? `${a.code} (made required)` : a.code); }
  console.log(`\n3. SYNCED ${recs.length} records with a flow — ${result.added.length} values now required on ${byRec.size} records:`);
  for (const [id, codes] of [...byRec].sort((x, y) => String(names.get(x[0])).localeCompare(String(names.get(y[0]))))) console.log(`   ${String(names.get(id)).padEnd(48)} ${codes.join(', ')}`);
  if (result.removed.length) console.log(`   removed ${result.removed.length} stale flow rules`);
  if (result.unknown.length) console.log(`   ! flows read codes with no specification: ${result.unknown.join(', ')}`);
  for (const k of result.kept) console.log(`   kept ${names.get(k.recordId) ?? k.recordId} ${k.code}: ${k.why}`);

  // Safety: a typed value for a moved code that is no longer asked keeps an optional rule of its own.
  const movedCodes = [...new Set(moved.map((r) => r.code))];
  let kept = 0;
  if (movedCodes.length) {
    const [held] = await db.query(
      `SELECT DISTINCT v.subject_id FROM cf_spec_values v JOIN cf_specifications s ON s.id = v.specification_id
        WHERE v.company_id = ? AND v.subject_type = 'master' AND v.deleted_at IS NULL AND s.code IN (?)
          AND (v.value_number IS NOT NULL OR v.value_text IS NOT NULL OR v.value_bool IS NOT NULL OR v.value_date IS NOT NULL OR v.option_id IS NOT NULL)`,
      [COMPANY, movedCodes]);
    const masters = await readMasters(db, COMPANY, held.map((h) => Number(h.subject_id)));
    const resolved = await resolveCodes(db, COMPANY, masters, movedCodes);
    const [specs] = await db.query('SELECT id, UPPER(code) AS code FROM cf_specifications WHERE company_id = ? AND deleted_at IS NULL AND code IN (?)', [COMPANY, movedCodes]);
    const specOf = new Map(specs.map((s) => [s.code, Number(s.id)]));
    const adds = [];
    const perCode = new Map();
    for (const m of masters) {
      for (const code of movedCodes) {
        const e = resolved.get(Number(m.id))?.get(code);
        const own = e?.own;
        const hasOwn = own && [own.value_number, own.value_text, own.value_bool, own.value_date, own.option_id].some((x) => x != null);
        if (!hasOwn || e.rule) continue;
        adds.push([COMPANY, specOf.get(code), 'master', Number(m.id), 'item', 0, 1, 'entered', 'manual', null]);
        perCode.set(code, (perCode.get(code) ?? 0) + 1);
      }
    }
    if (adds.length) await insertRows(db, 'cf_spec_assignments', ['company_id', 'specification_id', 'subject_type', 'subject_id', 'capture_at', 'is_required', 'is_applicable', 'value_rule', 'origin', 'created_by'], adds);
    kept = adds.length;
    console.log(`\n   ${kept} typed values kept visible with an optional rule of their own${kept ? ': ' + [...perCode].map(([k, n]) => `${k} ×${n}`).join(', ') : ''}`);
  }

  console.log(`\nSUMMARY  retired ${retired.length} · moved ${moved.length} · now required ${result.added.length} on ${byRec.size} records · kept visible ${kept}`);
  if (APPLY) { await db.commit(); console.log('COMMITTED'); } else { await db.rollback(); console.log('DRY RUN — rolled back. Add --apply to keep it.'); }
} catch (err) {
  await db.rollback().catch(() => {});
  console.error('ERROR', err.message);
  process.exitCode = 1;
} finally {
  db.release();
  await pool.end();
}
