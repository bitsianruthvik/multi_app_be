/**
 * section-cutting-setup.mjs — cutting moves onto the cut section, its cut length from the section
 * and the nest (user, 2026-10-08: "the flow for cutting should sit on the cut piece equivalent …
 * number of cuts … should come from nesting"; before nesting, 1 cut per piece).
 *
 *   1. Specs CUT_ACROSS (length of one cut across a section) and CUTS (cuts per piece).
 *   2. Each steel family works out CUT_ACROSS: angles W + D − T; beams and channels D + 2W − 2T
 *      (calculated rules, and the value written onto every stock bar already in the catalog).
 *   3. Cut sections: CUT_ACROSS and CUTS taken, CUT_LENGTH = CUTS × CUT_ACROSS, THICKNESS required.
 *   4. Flow CG-CUTSECTION (Gas cutting) becomes the cut-section flow; cut sections of lines not yet
 *      released move to it. Flow CG-SECTIONPART (Part QC) for section parts: every definition on
 *      CG-BRACEANGLE moves to it (its CUT_LENGTH / THICKNESS asks go away by themselves).
 *   5. Every line not yet released: its cut sections get their cuts (from its nest, else 1 per piece).
 *
 *   node scripts/cf_kepl/section-cutting-setup.mjs --company 30005            (dry run: rolled back)
 *   node scripts/cf_kepl/section-cutting-setup.mjs --company 30005 --apply    (commits)
 * Re-running changes nothing.
 */
const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const COMPANY = Number(arg('company'));
const APPLY = process.argv.includes('--apply');
if (!Number.isInteger(COMPANY)) throw new Error('Usage: --company <id> [--apply]');

const { pool } = await import('../../db.js');
const { cutPlaces } = await import('../../apps/cf_erp/lib/cutPlaces.js');
const { insertRows } = await import('../../apps/cf_erp/lib/db.js');
const { createFlow, addStep, setFlowStatus, setCutSectionFlow, cutSectionFlowId } = await import('../../apps/cf_erp/services/flowService.js');
const { createOperation } = await import('../../apps/cf_erp/services/operationService.js');
const { updateRecord } = await import('../../apps/cf_erp/services/masterRecordService.js');
const { syncSectionCuts } = await import('../../apps/cf_erp/services/sectionNestingService.js');

const FAMILIES = [
  { node: 'ANGLES', formula: 'CG_ANGLE_CUT_ACROSS', expr: 'WIDTH + DEPTH - THICKNESS', calc: (v) => v.WIDTH + v.DEPTH - v.THICKNESS },
  { node: 'BEAMS', formula: 'CG_BEAM_CUT_ACROSS', expr: 'DEPTH + 2 * WIDTH - 2 * THICKNESS', calc: (v) => v.DEPTH + 2 * v.WIDTH - 2 * v.THICKNESS },
  { node: 'CHANNELS', formula: 'CG_BEAM_CUT_ACROSS', expr: 'DEPTH + 2 * WIDTH - 2 * THICKNESS', calc: (v) => v.DEPTH + 2 * v.WIDTH - 2 * v.THICKNESS },
];
const r3 = (n) => Math.round(n * 1000) / 1000;

const db = await pool.getConnection();
const c = { companyId: COMPANY, userId: null };
try {
  await db.beginTransaction();
  const one = async (sql, p) => (await db.query(sql, p))[0][0] ?? null;

  // 1. Specs.
  const spec = async (code, name, uom, mtype, description) => {
    const s = await one('SELECT id FROM cf_specifications WHERE company_id = ? AND code = ? AND deleted_at IS NULL', [COMPANY, code]);
    if (s) return s.id;
    const [r] = await db.query("INSERT INTO cf_specifications (company_id, code, name, data_type, measurement_type, default_uom, decimals, description, status) VALUES (?, ?, ?, 'number', ?, ?, ?, ?, 'active')",
      [COMPANY, code, name, mtype, uom, 1, description]);
    console.log(`  + specification ${code} (${name})`);
    return r.insertId;
  };
  const sAcross = await spec('CUT_ACROSS', 'Length of one cut', 'mm', 'LENGTH', 'How far the torch travels to cut once across a section. Worked out by its steel family.');
  const sCuts = await spec('CUTS', 'Cuts per piece', null, 'COUNT', 'Cuts a cut section needs per piece: 1 until it is nested, then what the nest says.');
  const sLen = (await one("SELECT id FROM cf_specifications WHERE company_id = ? AND code = 'CUT_LENGTH' AND deleted_at IS NULL", [COMPANY]))?.id;
  const sThk = (await one("SELECT id FROM cf_specifications WHERE company_id = ? AND code = 'THICKNESS' AND deleted_at IS NULL", [COMPANY]))?.id;
  if (!sLen || !sThk) throw new Error('CUT_LENGTH or THICKNESS is missing in this company.');

  const formula = async (code, name, expr) => {
    const f = await one('SELECT id, expression FROM cf_formulas WHERE company_id = ? AND code = ? AND deleted_at IS NULL', [COMPANY, code]);
    if (f) return f.id;
    const [r] = await db.query("INSERT INTO cf_formulas (company_id, code, name, expression, status) VALUES (?, ?, ?, ?, 'active')", [COMPANY, code, name, expr]);
    console.log(`  + formula ${code}: ${expr}`);
    return r.insertId;
  };
  /** One live rule per node × spec: insert, or bring the existing one to this. */
  const rule = async (nodeId, specId, valueRule, { required = 0, formulaId = null } = {}) => {
    const a = await one("SELECT id, value_rule, is_required, formula_id, is_applicable FROM cf_spec_assignments WHERE company_id = ? AND subject_type = 'classification' AND subject_id = ? AND specification_id = ? AND capture_at = 'item' AND deleted_at IS NULL", [COMPANY, nodeId, specId]);
    if (!a) {
      await db.query("INSERT INTO cf_spec_assignments (company_id, specification_id, subject_type, subject_id, capture_at, is_required, is_applicable, value_rule, formula_id) VALUES (?, ?, 'classification', ?, 'item', ?, 1, ?, ?)",
        [COMPANY, specId, nodeId, required, valueRule, formulaId]);
      return 'added';
    }
    if (a.value_rule === valueRule && Number(a.is_required) === required && (a.formula_id ?? null) === formulaId && a.is_applicable) return 'kept';
    await db.query('UPDATE cf_spec_assignments SET value_rule = ?, is_required = ?, formula_id = ?, is_applicable = 1 WHERE id = ?', [valueRule, required, formulaId, a.id]);
    return 'changed';
  };

  // 2. Steel families.
  for (const fam of FAMILIES) {
    const node = await one('SELECT id FROM cf_classification_nodes WHERE company_id = ? AND code = ? AND deleted_at IS NULL', [COMPANY, fam.node]);
    if (!node) { console.log(`  ! no ${fam.node} family — skipped`); continue; }
    const fid = await formula(fam.formula, `Length of one cut (${fam.node.toLowerCase()})`, fam.expr);
    console.log(`  ${fam.node}: CUT_ACROSS rule ${await rule(node.id, sAcross, 'calculated', { formulaId: fid })}`);
    const [items] = await db.query(
      `WITH RECURSIVE sub AS (SELECT id FROM cf_classification_nodes WHERE id = ? UNION ALL SELECT n.id FROM cf_classification_nodes n JOIN sub ON n.parent_id = sub.id WHERE n.deleted_at IS NULL)
       SELECT m.id, UPPER(s.code) AS code, v.value_number FROM cf_master_records m
         JOIN cf_item_details i ON i.master_id = m.id AND i.item_type = 'catalog' AND i.deleted_at IS NULL
         LEFT JOIN cf_spec_values v ON v.company_id = m.company_id AND v.subject_type = 'master' AND v.subject_id = m.id AND v.deleted_at IS NULL
         LEFT JOIN cf_specifications s ON s.id = v.specification_id AND s.code IN ('WIDTH', 'DEPTH', 'THICKNESS', 'CUT_ACROSS')
        WHERE m.company_id = ? AND m.deleted_at IS NULL AND m.classification_id IN (SELECT id FROM sub)`,
      [node.id, COMPANY]);
    const vals = new Map();
    for (const r of items) { if (!vals.has(r.id)) vals.set(r.id, {}); if (r.code) vals.get(r.id)[r.code] = r.value_number == null ? null : Number(r.value_number); }
    const writes = [];
    let noSize = 0;
    for (const [id, v] of vals) {
      if (![v.WIDTH, v.DEPTH, v.THICKNESS].every((x) => x > 0)) { noSize++; continue; }
      const across = r3(fam.calc(v));
      if (v.CUT_ACROSS != null && Math.abs(v.CUT_ACROSS - across) < 1e-6) continue;
      writes.push({ id, across });
    }
    if (writes.length) {
      await db.query(`UPDATE cf_spec_values SET deleted_at = NOW() WHERE company_id = ? AND subject_type = 'master' AND specification_id = ? AND subject_id IN (?) AND deleted_at IS NULL`, [COMPANY, sAcross, writes.map((w) => w.id)]);
      await insertRows(db, 'cf_spec_values', ['company_id', 'specification_id', 'subject_type', 'subject_id', 'value_number', 'uom', 'source'], writes.map((w) => [COMPANY, sAcross, 'master', w.id, w.across, 'mm', 'calculated']), 500);
    }
    console.log(`     ${vals.size} stock bars: ${writes.length} given a length of one cut${noSize ? `, ${noSize} without width/depth/thickness` : ''}`);
  }

  // 3. Cut sections.
  const places = await cutPlaces(db, COMPANY);
  const secNode = places.section?.blanksNodeId;
  if (!secNode) throw new Error('No place is set for cut sections (Setup › Cutting).');
  const fLen = await formula('CG_CUT_SECTION_LENGTH', 'Cut length of a cut section', 'CUTS * CUT_ACROSS');
  console.log(`  cut sections: CUT_ACROSS ${await rule(secNode, sAcross, 'entered')}, CUTS ${await rule(secNode, sCuts, 'entered')}, CUT_LENGTH ${await rule(secNode, sLen, 'calculated', { formulaId: fLen })}, THICKNESS required ${await rule(secNode, sThk, 'entered', { required: 1 })}`);

  // 4. Flows.
  const flowByCode = async (code, name, opCode, opName) => {
    let f = await one('SELECT id, status FROM cf_operation_flows WHERE company_id = ? AND code = ? AND deleted_at IS NULL', [COMPANY, code]);
    if (f) return f.id;
    let op = await one('SELECT id FROM cf_operations WHERE company_id = ? AND code = ? AND deleted_at IS NULL', [COMPANY, opCode]);
    if (!op) { op = await createOperation(db, c, { code: opCode, name: opName }); console.log(`  + operation ${opCode} (no time rule yet — add one on Setup › Operations)`); }
    const nf = await createFlow(db, c, { code, name });
    await addStep(db, c, nf.id, { operationId: op.id });
    await setFlowStatus(db, c, nf.id, 'active');
    console.log(`  + flow ${code} (${opCode})`);
    return nf.id;
  };
  const cutFlow = await flowByCode('CG-CUTSECTION', 'Cut section — gas cutting', 'CG-GASCUT', 'Gas Cutting');
  const partFlow = await flowByCode('CG-SECTIONPART', 'Section part — QC', 'PQC', 'Part QC (Dimensional)');
  const oldCut = await cutSectionFlowId(db, COMPANY);
  if (oldCut !== cutFlow) { await setCutSectionFlow(db, c, { flowId: cutFlow }); console.log('  cut-section flow is now CG-CUTSECTION'); }
  const [moved] = await db.query(
    `UPDATE cf_master_records m
       JOIN cf_item_details i ON i.master_id = m.id AND i.item_type = 'temporary' AND i.deleted_at IS NULL
       LEFT JOIN cf_production_releases r ON r.order_line_id = i.owner_order_line_id AND r.deleted_at IS NULL
        SET m.default_flow_id = ?
      WHERE m.company_id = ? AND m.deleted_at IS NULL AND m.classification_id IN (?) AND r.id IS NULL AND (m.default_flow_id IS NULL OR m.default_flow_id <> ?)`,
    [cutFlow, COMPANY, [...places.section.blanksIds], cutFlow]);
  console.log(`  ${moved.affectedRows} cut sections of unreleased lines moved to CG-CUTSECTION`);
  const [defs] = await db.query(
    `SELECT m.id, m.code, m.name FROM cf_master_records m JOIN cf_operation_flows f ON f.id = m.default_flow_id
      WHERE m.company_id = ? AND m.deleted_at IS NULL AND m.record_kind = 'definition' AND f.code = 'CG-BRACEANGLE'`, [COMPANY]);
  for (const d of defs) {
    const r = await updateRecord(db, c, d.id, { defaultFlowId: partFlow });
    const gone = (r.flowSpecs?.removed ?? []).map((x) => x.code);
    console.log(`  ${d.code} ${d.name} → CG-SECTIONPART${gone.length ? ` (no longer asks ${gone.join(', ')})` : ''}`);
  }

  // 5. Cuts on every unreleased line with cut sections.
  const [lines] = await db.query(
    `SELECT DISTINCT i.owner_order_line_id AS id FROM cf_item_details i
       JOIN cf_master_records m ON m.id = i.master_id AND m.deleted_at IS NULL AND m.classification_id IN (?)
       LEFT JOIN cf_production_releases r ON r.order_line_id = i.owner_order_line_id AND r.deleted_at IS NULL
      WHERE i.company_id = ? AND i.item_type = 'temporary' AND i.deleted_at IS NULL AND i.owner_order_line_id IS NOT NULL AND r.id IS NULL`,
    [[...places.section.blanksIds], COMPANY]);
  let written = 0;
  for (const l of lines) {
    const [[line]] = await db.query('SELECT * FROM cf_sales_order_lines WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [COMPANY, l.id]);
    if (line) written += await syncSectionCuts(db, c, line);
  }
  console.log(`  ${lines.length} unreleased lines with cut sections: ${written} cut values written`);

  if (APPLY) { await db.commit(); console.log('COMMITTED'); } else { await db.rollback(); console.log('DRY RUN — rolled back. Add --apply to keep it.'); }
} catch (err) {
  await db.rollback().catch(() => {});
  console.error('ERROR', err.message, err.problems ? JSON.stringify(err.problems) : '');
  process.exitCode = 1;
} finally {
  db.release();
  await pool.end();
}
