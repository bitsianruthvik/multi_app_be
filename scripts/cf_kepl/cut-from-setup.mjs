/**
 * cut-from-setup.mjs — puts a tenant on "Cut from" (init.sql §48, CF_ERP_CUT_FROM_PLAN.md §8).
 *
 *   node scripts/cf_kepl/cut-from-setup.mjs --company 30005            (dry run: rolled back)
 *   node scripts/cf_kepl/cut-from-setup.mjs --company 30005 --apply    (commits)
 *
 * Idempotent; each step says what it found and what it did:
 *   1. CUT_FROM (Plate / Section / Not cut) and its defaulted rule on the Fabricated family
 *      (init.sql §48 seeds both; created here only if missing).
 *   2. The section places: Steel › "Cut sections" for section cut pieces and Steel › "Section
 *      offcuts" for leftover bar lengths, set in cf_cut_places (Setup › Cutting from then on).
 *   3. Classification defaults: Parts › Plate part = Plate, Parts › Profile part = Section,
 *      Assemblies and Structures = Not cut — for definitions made later.
 *   4. EVERY template definition gets its own explicit answer (user, 2026-10-08: "all the current
 *      definitions need to be rewritten"), so none depends on where it is filed any more: under
 *      Plate part → Plate, under Profile part → Section, everything else → Not cut. Printed one by one.
 * Classification codes are read here ONCE, to migrate; nothing at run time reads them.
 */
import { pool } from '../../db.js';
import '../../apps/cf_erp/services/codegenProvider.js';
import { createSpec } from '../../apps/cf_erp/services/specificationService.js';
import { createRule } from '../../apps/cf_erp/services/assignmentService.js';
import { setValues } from '../../apps/cf_erp/services/valueService.js';
import { createNode } from '../../apps/cf_erp/services/classificationService.js';

const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const COMPANY = Number(arg('company'));
const APPLY = process.argv.includes('--apply');
if (!Number.isInteger(COMPANY)) throw new Error('Usage: --company <id> [--apply]');
const CODE = 'CUT_FROM';
const WORD = { PLATE: 'Plate', SECTION: 'Section', NONE: 'Not cut' };

const db = await pool.getConnection();
try {
  await db.beginTransaction();
  const [[user]] = await db.query('SELECT id FROM users WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [COMPANY]);
  const c = { companyId: COMPANY, userId: user?.id ?? null, canManage: true, isAdmin: true };
  // The schema first: this script needs init.sql §48 / §48b (s48.sql) on the database.
  const [[schema]] = await db.query(
    `SELECT (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('cf_cut_places','cf_cut_place_stock','cf_section_settings')) AS t,
            (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_company_settings' AND COLUMN_NAME = 'cut_section_flow_id') AS c`,
  );
  if (Number(schema.t) < 3 || Number(schema.c) < 1) {
    throw new Error('The Cut from schema is not on this database yet — run s48.sql first (it should print SCHEMA-OK), then this script.');
  }
  const [nodes] = await db.query('SELECT id, code, name, parent_id, depth FROM cf_classification_nodes WHERE company_id = ? AND deleted_at IS NULL', [COMPANY]);
  const byCode = (code) => nodes.find((n) => String(n.code).toUpperCase() === code) ?? null;

  // 1. the specification and its rule
  let [[spec]] = await db.query('SELECT id FROM cf_specifications WHERE company_id = ? AND code = ? AND deleted_at IS NULL', [COMPANY, CODE]);
  if (spec) console.log(`1. ${CODE} exists (#${spec.id})`);
  else {
    spec = await createSpec(db, c, {
      code: CODE, name: 'Cut from', dataType: 'option',
      description: 'How pieces of this kind are cut: from a plate, from a section (a stock bar cut to length), or not cut.',
      options: [{ value: 'PLATE', label: 'Plate' }, { value: 'SECTION', label: 'Section (cut to length)' }, { value: 'NONE', label: 'Not cut' }],
    });
    console.log(`1. ${CODE} created (#${spec.id})`);
  }
  const fab = byCode('FABRICATED');
  if (fab) {
    const [[rule]] = await db.query("SELECT id FROM cf_spec_assignments WHERE company_id = ? AND subject_type = 'classification' AND subject_id = ? AND specification_id = ? AND deleted_at IS NULL", [COMPANY, fab.id, spec.id]);
    if (rule) console.log(`   rule on ${fab.name} exists (#${rule.id})`);
    else { const r = await createRule(db, c, { subjectType: 'classification', subjectId: fab.id, specificationId: spec.id, captureAt: 'item', valueRule: 'defaulted' }); console.log(`   rule on ${fab.name} created (#${r.id})`); }
  }

  // 2. section places
  const [places] = await db.query('SELECT id, kind, blanks_node_id, offcut_node_id FROM cf_cut_places WHERE company_id = ?', [COMPANY]);
  let section = places.find((p) => p.kind === 'section');
  if (!section) {
    const [r] = await db.query("INSERT INTO cf_cut_places (company_id, kind) VALUES (?, 'section')", [COMPANY]);
    section = { id: r.insertId, kind: 'section', blanks_node_id: null, offcut_node_id: null };
  }
  const angles = byCode('ANGLES');
  const steel = angles ? nodes.find((n) => n.id === angles.parent_id) : byCode('STEEL');
  if (!steel) throw new Error('No Steel family to file section cut pieces under.');
  const ensureNode = async (code, name, description) => {
    const have = byCode(code);
    if (have) return have.id;
    const made = await createNode(db, c, { parentId: steel.id, code, name, description, scope: 'both' });
    console.log(`   + node ${steel.name} › ${name} (${code})`);
    return made.id;
  };
  const blanks = section.blanks_node_id ?? await ensureNode('CUT_SECTION', 'Cut sections', 'Section cut pieces: a length of a stock bar, cut for one part design.');
  const offcut = section.offcut_node_id ?? await ensureNode('SECTION_OFFCUT', 'Section offcuts', 'Leftover lengths of stock bars, kept for reuse.');
  await db.query('UPDATE cf_cut_places SET blanks_node_id = ?, offcut_node_id = ?, updated_by = ? WHERE company_id = ? AND id = ?', [blanks, offcut, c.userId, COMPANY, section.id]);
  const [stock] = await db.query('SELECT node_id FROM cf_cut_place_stock WHERE company_id = ? AND place_id = ?', [COMPANY, section.id]);
  if (!stock.length) {
    for (const code of ['ANGLES', 'BEAMS', 'CHANNELS']) {
      const n = byCode(code);
      if (n) await db.query('INSERT INTO cf_cut_place_stock (company_id, place_id, node_id) VALUES (?, ?, ?)', [COMPANY, section.id, n.id]);
    }
  }
  const [stockNow] = await db.query('SELECT n.name FROM cf_cut_place_stock s JOIN cf_classification_nodes n ON n.id = s.node_id WHERE s.company_id = ? AND s.place_id = ?', [COMPANY, section.id]);
  console.log(`2. section places: cut pieces → #${blanks}, offcuts → #${offcut}, stock → ${stockNow.map((s) => s.name).join(', ') || 'none'}`);

  // 3. classification defaults
  const defaults = { PLATE_PART: 'PLATE', PROFILE_PART: 'SECTION', FAB_ASSY: 'NONE', FAB_STRUCT: 'NONE' };
  for (const [code, value] of Object.entries(defaults)) {
    const n = byCode(code);
    if (!n) { console.log(`3. no ${code} node — skipped`); continue; }
    await setValues(db, c, 'classification', n.id, [{ specCode: CODE, value }]);
    console.log(`3. ${n.name} = ${WORD[value]}`);
  }

  // 4. every template definition, explicitly
  const plateNode = byCode('PLATE_PART'), profileNode = byCode('PROFILE_PART');
  const under = (nodeId, root) => { for (let n = nodes.find((x) => x.id === nodeId); n; n = nodes.find((x) => x.id === n.parent_id)) if (root && n.id === root.id) return true; return false; };
  const [defs] = await db.query(
    `SELECT m.id, m.code, m.name, m.classification_id, n.name AS node, o.value AS current
       FROM cf_master_records m
       JOIN cf_definition_details d ON d.master_id = m.id AND d.definition_type = 'template' AND d.deleted_at IS NULL
       LEFT JOIN cf_classification_nodes n ON n.id = m.classification_id
       LEFT JOIN cf_spec_values v ON v.company_id = m.company_id AND v.subject_type = 'master' AND v.subject_id = m.id AND v.specification_id = ? AND v.deleted_at IS NULL
       LEFT JOIN cf_spec_options o ON o.id = v.option_id
      WHERE m.company_id = ? AND m.deleted_at IS NULL
      ORDER BY n.name, m.code`,
    [spec.id, COMPANY],
  );
  const counts = { PLATE: 0, SECTION: 0, NONE: 0 };
  let changed = 0;
  for (const d of defs) {
    const value = under(d.classification_id, plateNode) ? 'PLATE' : under(d.classification_id, profileNode) ? 'SECTION' : 'NONE';
    counts[value]++;
    if (d.current === value) { console.log(`   = ${d.code.padEnd(12)} ${d.name} (${d.node}): ${WORD[value]}`); continue; }
    await setValues(db, c, 'master', d.id, [{ specCode: CODE, value }]);
    changed++;
    console.log(`   ~ ${d.code.padEnd(12)} ${d.name} (${d.node}): ${d.current ? WORD[d.current] : '—'} → ${WORD[value]}`);
  }
  console.log(`4. ${defs.length} template definitions: ${counts.PLATE} Plate, ${counts.SECTION} Section, ${counts.NONE} Not cut (${changed} written)`);

  // 4b. a cut section carries its section's size: the steel rules the section stock has (its
  //     sub-family: thickness, width, depth, section area, the calculated weight) are given to the
  //     Cut sections node too. Grade, impact class, length, density and material come from Steel.
  const stockNodeIds = (await db.query('SELECT node_id FROM cf_cut_place_stock WHERE company_id = ? AND place_id = ?', [COMPANY, section.id]))[0].map((r) => r.node_id);
  const [stockRules] = stockNodeIds.length ? await db.query(
    `SELECT a.*, s.code FROM cf_spec_assignments a JOIN cf_specifications s ON s.id = a.specification_id
      WHERE a.company_id = ? AND a.subject_type = 'classification' AND a.subject_id IN (?) AND a.deleted_at IS NULL
        AND s.code IN ('THICKNESS','WIDTH','DEPTH','SECTION_AREA','WEIGHT') ORDER BY a.subject_id, a.id`,
    [COMPANY, stockNodeIds],
  ) : [[]];
  const [haveRules] = await db.query("SELECT specification_id FROM cf_spec_assignments WHERE company_id = ? AND subject_type = 'classification' AND subject_id = ? AND deleted_at IS NULL", [COMPANY, blanks]);
  const have = new Set(haveRules.map((r) => r.specification_id));
  const copied = [];
  for (const r of stockRules) {
    if (have.has(r.specification_id)) continue;
    await db.query(
      `INSERT INTO cf_spec_assignments (company_id, specification_id, subject_type, subject_id, capture_at, is_required, is_applicable, value_rule, formula_id, sort_order, created_by)
       VALUES (?, ?, 'classification', ?, ?, 0, ?, ?, ?, ?, ?)`,
      [COMPANY, r.specification_id, blanks, r.capture_at, r.is_applicable, r.value_rule, r.formula_id, r.sort_order, c.userId],
    );
    have.add(r.specification_id);
    copied.push(`${r.code} (${r.value_rule})`);
  }
  console.log(`4b. Cut sections carry: ${copied.length ? copied.join(', ') : 'already set'}`);

  // 4c. a code for every cut section, like the cut plates' rule: <order>-<line>-CUTSC-<D>X<W>X<T>-<length>-<grade>.
  const [[haveScheme]] = await db.query(
    `SELECT s.id FROM cf_code_schemes s JOIN cf_code_scheme_conditions k ON k.scheme_id = s.id AND k.deleted_at IS NULL
      WHERE s.company_id = ? AND s.deleted_at IS NULL AND k.token_key = 'classification' AND k.value = ?`, [COMPANY, String(blanks)]);
  if (haveScheme) console.log(`4c. cut sections already have a coding rule (#${haveScheme.id})`);
  else {
    const { createScheme } = await import('../../apps/cf_erp/modules/codegen/service.js');
    const seg = (tokenKey) => ({ segmentType: 'token', tokenKey });
    const lit = (literalText) => ({ segmentType: 'literal', literalText });
    const made = await createScheme(db, COMPANY, c.userId, {
      code: 'CFTMP-SECTION', name: 'Cut section', entityType: 'item', targetField: 'code', seqScope: 'prefix', priority: -10, status: 'active',
      description: 'A cut section: a length of a stock bar cut for one part design, named by its section, length and grade.',
      conditions: [{ tokenKey: 'kind', operator: 'eq', value: 'temporary' }, { tokenKey: 'classification', operator: 'under', value: String(blanks) }],
      segments: [seg('order.code'), lit('-'), seg('line.no'), lit('-'), seg('record.shortName'), lit('-'),
        seg('spec:DEPTH'), lit('X'), seg('spec:WIDTH'), lit('X'), seg('spec:THICKNESS'), lit('-'), seg('spec:LENGTH'), lit('-'), seg('spec:GRADE')],
    });
    console.log(`4c. coding rule CFTMP-SECTION created (#${made.id})`);
  }

  // 5. the flow a new cut section takes (release refuses cut sections without one). There is no
  //    saw operation yet, so the general cutting flow (code CUTTING) — changeable in Setup › Cutting.
  const [[settings]] = await db.query('SELECT cut_section_flow_id FROM cf_company_settings WHERE company_id = ?', [COMPANY]);
  if (settings?.cut_section_flow_id) console.log(`5. cut sections already follow flow #${settings.cut_section_flow_id}`);
  else {
    const [[flow]] = await db.query("SELECT id, code, name FROM cf_operation_flows WHERE company_id = ? AND code = 'CUTTING' AND status = 'active' AND deleted_at IS NULL", [COMPANY]);
    if (!flow) console.log('5. no active CUTTING flow — choose the cut-section flow in Setup › Cutting before releasing cut sections');
    else {
      await db.query('INSERT INTO cf_company_settings (company_id, cut_section_flow_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE cut_section_flow_id = VALUES(cut_section_flow_id)', [COMPANY, flow.id]);
      console.log(`5. cut sections follow ${flow.code} · ${flow.name}`);
    }
  }
  // 6. bracing flows (user, 2026-10-08: "add the bracing flows — if required, we will modify them"):
  //    every Section definition with no flow of its own gets the Bracing angle flow (CG-BRACEANGLE).
  const [[brace]] = await db.query("SELECT id, code, name FROM cf_operation_flows WHERE company_id = ? AND code = 'CG-BRACEANGLE' AND status = 'active' AND deleted_at IS NULL", [COMPANY]);
  const sectionDefs = defs.filter((d) => under(d.classification_id, profileNode));
  const [noFlow] = sectionDefs.length ? await db.query('SELECT id, code, name FROM cf_master_records WHERE company_id = ? AND id IN (?) AND default_flow_id IS NULL', [COMPANY, sectionDefs.map((d) => d.id)]) : [[]];
  if (!brace) console.log(`6. no active CG-BRACEANGLE flow — ${noFlow.length} section definition(s) still have no flow: ${noFlow.map((d) => d.code).join(', ') || 'none'}`);
  else if (!noFlow.length) console.log('6. every section definition already has a flow');
  else {
    await db.query('UPDATE cf_master_records SET default_flow_id = ? WHERE company_id = ? AND id IN (?)', [brace.id, COMPANY, noFlow.map((d) => d.id)]);
    console.log(`6. ${brace.code} · ${brace.name} set on ${noFlow.length}: ${noFlow.map((d) => d.code).join(', ')}`);
  }
  if (APPLY) { await db.commit(); console.log('COMMITTED'); } else { await db.rollback(); console.log('DRY RUN — rolled back. Add --apply to keep it.'); }
} catch (err) {
  await db.rollback();
  console.error('ERROR', err.message, err.problems ? JSON.stringify(err.problems) : '');
  process.exitCode = 1;
} finally {
  db.release();
  await pool.end();
}
