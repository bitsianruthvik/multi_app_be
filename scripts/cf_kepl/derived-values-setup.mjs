/**
 * derived-values-setup.mjs — values that come from the drawing and from the parts
 * (user, 2026-10-12: "Use the true shape wherever possible for plates — fill all the things that
 * you suggested. But give an option to override manually (and show it somewhere that manual value
 * was filled)").
 *
 * WHAT IT SETS UP — tenant DATA, nothing in code: three specifications the drawing writes, the
 * formulas, and which value is worked out by which formula on which classification node. Every
 * one of these values can be typed over by hand (a Defaulted rule that names a formula —
 * resolutionService); taking the typed number away brings the calculated one back.
 *
 *   on a PLATE PART
 *     WEIGHT                the TRUE area of its drawing × thickness × density; the rectangle where it has no drawing
 *     SURFACE_AREA          the true area (one face, unless --faces 2), else the rectangle
 *     HOLES, HOLE_DIA       from its drawing (the holes it shows, and their diameter)
 *     HOLE_DRILL_THICKNESS  its own THICKNESS
 *   on a GIRDER SEGMENT
 *     HOLES / HOLES_TOP / HOLES_BOTTOM   the holes of its web / top flange / bottom flange children
 *     SAW_WELD_LENGTH       2 fillet runs along the long edge of every flange child (4 × its length for a top and a bottom flange)
 *     MIG_WELD_LENGTH       per stiffener child: 2 runs along its long edge (both sides, to the web) + 4 along its short edge (both sides, at each flange end)
 *     STIFFENERS            its stiffener children, less the ones fitted after the flip when it has that value
 *     STIFFENERS_AFTER_FLIP the stiffener rows whose description or name says "far side", "after flip" or "other side" — where no row says, half of them, rounded down
 *     STUDS                 its shear stud children
 *   on a DIAPHRAGM           SAW_WELD_LENGTH, the same rule
 *   on a GIRDER LINE         STUDS (its shear stud children) · LINEMATCH_JOINTS (its girder segments − 1: one joint between two segments)
 *   on every ASSEMBLY that already rolls SURFACE_AREA up: the same roll-up, now typeable over
 *
 * A count that finds nothing to count is "the structure does not say", not zero (NONZERO): the
 * value is then asked for and a person fills it — 0 where 0 is meant.
 *
 * HOW A VALUE REACHES A ROW. WEIGHT and SURFACE_AREA are ordinary rules on the node (they are on
 * every row today). The rest are RECIPES (flowSpecService): a rule on the node with origin 'flow'
 * that reaches no row by itself — a row gets the value when ITS FLOW reads it, exactly as before
 * ("the field list follows the row's flow"), now worked out instead of typed. Frozen (locked or
 * released) rows are not touched: they keep the values and the rules they were frozen with.
 *
 * NOTHING A PERSON TYPED IS CHANGED. A number typed before today stays as it is: where it differs
 * from the calculated one it is shown as "typed over a calculated value", where it equals it it
 * is simply shown as calculated. The script checks this itself (count and checksum of every typed
 * value, before and after) and stops if one moved.
 *
 *   node scripts/cf_kepl/derived-values-setup.mjs --company 30005                      dry run — everything is rolled back
 *   node scripts/cf_kepl/derived-values-setup.mjs --company 30005 --apply              commits
 *   node scripts/cf_kepl/derived-values-setup.mjs --company 30005 --compare --order SO260002 [--out file.csv]
 *                                                                                       typed against calculated, one order — writes nothing
 *   --faces 2      SURFACE_AREA of a part = both faces (default: as the formula it replaces — one face)
 *
 * Re-running after an apply changes nothing. --compare works before or after an apply: it lays the
 * setup on inside a transaction that is ALWAYS rolled back, and reads a frozen line as if it were
 * open (the line itself keeps showing what it was frozen with).
 *
 * ROUND TRIPS: a fixed number for the setup, then a fixed number per open order line (never per
 * row): its drawing facts, one pass of its values, one read for the report.
 */
import { pathToFileURL } from 'url';
import fs from 'node:fs';

/* ===========================================================================
 * The setup, as data
 * ======================================================================== */

/** What the drawing writes on a plate part (records.DRAWING_FACT_SPECS) — created where missing. */
export const FACT_SPECS = [
  { code: 'TRUE_AREA', name: 'True area (from the drawing)', dataType: 'number', defaultUom: 'mm2', measurementType: 'AREA', decimals: 1, description: 'The part’s outline less its cut-outs and holes, read from its DXF. Written by the system; formulas read it.' },
  { code: 'DRAWN_HOLES', name: 'Holes on the drawing', dataType: 'number', measurementType: 'COUNT', decimals: 0, description: 'The drilled holes the part’s DXF shows. Written by the system; formulas read it.' },
  { code: 'DRAWN_HOLE_DIA', name: 'Hole diameter on the drawing', dataType: 'number', defaultUom: 'mm', measurementType: 'LENGTH', decimals: 1, description: 'The diameter of the holes the part’s DXF shows — the commonest when they differ. Written by the system; formulas read it.' },
];

// How a child is told apart: by its own name or the name of the template it was made from.
const NOT_OTHER = 'NOT(CONTAINS(children.name, "stiffener")), NOT(CONTAINS(children.name, "cover")), NOT(CONTAINS(children.name, "splice"))';
const IS = {
  web: `AND(CONTAINS(children.name, "web"), ${NOT_OTHER}, NOT(CONTAINS(children.name, "deduct")))`,
  flange: `AND(CONTAINS(children.name, "flange"), ${NOT_OTHER})`,
  top: `AND(CONTAINS(children.name, "top flange"), ${NOT_OTHER})`,
  bottom: `AND(CONTAINS(children.name, "bottom flange"), ${NOT_OTHER})`,
  stiffener: 'AND(CONTAINS(children.name, "stiffener"), NOT(CONTAINS(children.name, "cover")))',
  stud: 'children.variant = "Shear stud"',
  segment: 'children.variant = "Girder segment"',
};
const FAR = 'OR(CONTAINS(children.role, "far side"), CONTAINS(children.role, "after flip"), CONTAINS(children.role, "other side"), CONTAINS(children.name, "far side"), CONTAINS(children.name, "after flip"))';
const holesOf = (which, what) => `NONZERO(SUM(IF(${IS[which]}, FIRST(children.HOLES, children.DRAWN_HOLES), 0)), "${what}")`;
const STIFFENER_COUNT = `NONZERO(SUM(IF(${IS.stiffener}, 1, 0)), "stiffeners below this row")`;

/** The area a plate part's formulas use: the drawing's where there is one, else the rectangle. */
export const TRUE_OR_RECTANGLE = 'FIRST(TRUE_AREA, LENGTH * WIDTH)';

/** code -> { name, description, expression | (units) => expression }. `units` = { length: 1000 | 1 } (m or mm). */
export const FORMULAS = {
  PART_PLATE_WEIGHT: { name: 'Plate part weight — true shape', description: 'The drawing’s true area × thickness × density; the rectangle where the part has no drawing.', expression: `${TRUE_OR_RECTANGLE} * THICKNESS * DENSITY / 1e9` },
  PART_PLATE_AREA: { name: 'Plate part surface area — true shape', description: 'The drawing’s true area (one face); the rectangle where the part has no drawing.', expression: `${TRUE_OR_RECTANGLE} / 1e6` },
  PART_HOLES: { name: 'Holes — from the drawing', description: 'The holes the part’s drawing shows.', expression: 'DRAWN_HOLES' },
  PART_HOLE_DIA: { name: 'Hole diameter — from the drawing', description: 'The diameter of the holes the part’s drawing shows.', expression: 'DRAWN_HOLE_DIA' },
  PART_DRILL_THICKNESS: { name: 'Hole drilling thickness — the part’s own', description: 'The part’s own thickness, until somebody says it is drilled together with another plate.', expression: 'THICKNESS' },
  SEG_HOLES_WEB: { name: 'Holes — the web', description: 'The holes of the web children (each one’s own HOLES, else what its drawing shows).', expression: holesOf('web', 'holes on the web') },
  SEG_HOLES_TOP: { name: 'Holes — the top flange', description: 'The holes of the top flange children.', expression: holesOf('top', 'holes on the top flange') },
  SEG_HOLES_BOTTOM: { name: 'Holes — the bottom flange', description: 'The holes of the bottom flange children.', expression: holesOf('bottom', 'holes on the bottom flange') },
  ASSY_SAW_WELD_LENGTH: { name: 'SAW weld length — web to flanges', description: 'Two fillet runs along the long edge of every flange child: 4 × the length for a top and a bottom flange.', expression: (u) => `NONZERO(SUM(IF(${IS.flange}, 2 * MAX(children.LENGTH, children.WIDTH), 0)), "flanges below this row") / ${u.length}` },
  ASSY_MIG_WELD_LENGTH: { name: 'MIG weld length — stiffeners', description: 'Per stiffener child: 2 runs along its long edge (both sides, to the web) and 4 along its short edge (both sides, at each flange end).', expression: (u) => `NONZERO(SUM(IF(${IS.stiffener}, 2 * MAX(children.LENGTH, children.WIDTH) + 4 * MIN(children.LENGTH, children.WIDTH), 0)), "stiffeners below this row") / ${u.length}` },
  ASSY_STIFFENERS: { name: 'Stiffeners — fitted before the flip', description: 'The stiffener children, less the ones fitted after the flip where the row has that value (all of them where it has not).', expression: `${STIFFENER_COUNT} - FIRST(STIFFENERS_AFTER_FLIP, 0)` },
  ASSY_STIFFENERS_AFTER_FLIP: { name: 'Stiffeners — fitted after the flip', description: 'The stiffener rows whose description or name says "far side", "after flip" or "other side"; where no row says, half of the stiffeners, rounded down.', expression: `IF(SUM(IF(AND(${IS.stiffener}, ${FAR}), 1, 0)) > 0, SUM(IF(AND(${IS.stiffener}, ${FAR}), 1, 0)), FLOOR(${STIFFENER_COUNT} / 2))` },
  ASSY_STUDS: { name: 'Studs — the shear studs below', description: 'The shear stud children.', expression: `NONZERO(SUM(IF(${IS.stud}, 1, 0)), "shear studs below this row")` },
  LINE_MATCH_JOINTS: { name: 'Line matching joints', description: 'One joint between two girder segments: the segments below, less one.', expression: `NONZERO(SUM(IF(${IS.segment}, 1, 0)), "girder segments below this row") - 1` },
};

/**
 * Which value is worked out by which formula, on which node (by classification code).
 *   as 'rule'    an ordinary rule on the node — the value shows on every row there (it does today)
 *   as 'recipe'  a row gets it when its flow reads it (flowSpecService) — the field list stays the flow's
 *   from         'own' = keep the rule's own formula, only make it typeable over
 *   area         the formula is the existing one with LENGTH * WIDTH replaced by the true area
 */
export const RULES = [
  { spec: 'WEIGHT', node: 'PLATE_PART', as: 'rule', formula: 'PART_PLATE_WEIGHT', area: true },
  { spec: 'SURFACE_AREA', node: 'PLATE_PART', as: 'rule', formula: 'PART_PLATE_AREA', area: true, faces: true },
  { spec: 'HOLES', node: 'PLATE_PART', as: 'recipe', formula: 'PART_HOLES' },
  { spec: 'HOLE_DIA', node: 'PLATE_PART', as: 'recipe', formula: 'PART_HOLE_DIA' },
  { spec: 'HOLE_DRILL_THICKNESS', node: 'PLATE_PART', as: 'recipe', formula: 'PART_DRILL_THICKNESS' },
  { spec: 'HOLES', node: 'GIRDER_SEGMENT', as: 'recipe', formula: 'SEG_HOLES_WEB' },
  { spec: 'HOLES_TOP', node: 'GIRDER_SEGMENT', as: 'recipe', formula: 'SEG_HOLES_TOP' },
  { spec: 'HOLES_BOTTOM', node: 'GIRDER_SEGMENT', as: 'recipe', formula: 'SEG_HOLES_BOTTOM' },
  { spec: 'SAW_WELD_LENGTH', node: 'GIRDER_SEGMENT', as: 'recipe', formula: 'ASSY_SAW_WELD_LENGTH', length: true },
  { spec: 'SAW_WELD_LENGTH', node: 'DIAPHRAGM', as: 'recipe', formula: 'ASSY_SAW_WELD_LENGTH', length: true },
  { spec: 'MIG_WELD_LENGTH', node: 'GIRDER_SEGMENT', as: 'recipe', formula: 'ASSY_MIG_WELD_LENGTH', length: true },
  { spec: 'STIFFENERS', node: 'GIRDER_SEGMENT', as: 'recipe', formula: 'ASSY_STIFFENERS' },
  { spec: 'STIFFENERS_AFTER_FLIP', node: 'GIRDER_SEGMENT', as: 'recipe', formula: 'ASSY_STIFFENERS_AFTER_FLIP' },
  { spec: 'STUDS', node: 'GIRDER_SEGMENT', as: 'recipe', formula: 'ASSY_STUDS' },
  { spec: 'STUDS', node: 'GIRDER_LINE', as: 'recipe', formula: 'ASSY_STUDS' },
  { spec: 'LINEMATCH_JOINTS', node: 'GIRDER_LINE', as: 'recipe', formula: 'LINE_MATCH_JOINTS' },
  // Every node that rolls SURFACE_AREA up from its BOM today: the same roll-up, typeable over.
  { spec: 'SURFACE_AREA', node: '*rollup', as: 'rule', from: 'own' },
];

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const AREA_RE = /\bLENGTH\s*\*\s*WIDTH\b|\bWIDTH\s*\*\s*LENGTH\b/;

/* ===========================================================================
 * The setup
 * ======================================================================== */

/**
 * Lays the setup on, on a connection the caller owns (its transaction). Idempotent.
 * → { specs: [...], rules: [...], sync, lines: [...], typed: { before, after }, changed: n }
 *   opts.lines === false: only the setup, no pass over the open order lines.
 *   opts.orderCode: the pass over open lines keeps to that order (the compare report).
 */
export async function setup(db, { companyId, faces = null, log = console.log, lines: withLines = true, orderCode = null }) {
  const { createSpec } = await import('../../apps/cf_erp/services/specificationService.js');
  const { createFormula } = await import('../../apps/cf_erp/services/formulaService.js');
  const { syncFlowSpecs } = await import('../../apps/cf_erp/services/flowSpecService.js');
  const { refreshDrawingValues } = await import('../../apps/cf_erp/services/drawingValueService.js');
  const { materializeLine, compareLineValues } = await import('../../apps/cf_erp/services/orderValuesService.js');
  const { parseFormula } = await import('../../apps/cf_erp/services/formulaEngine.js');
  const { LOCKED_ORDER_STATUSES } = await import('../../apps/cf_erp/services/records.js');
  const c = { companyId, userId: null };
  const out = { specs: [], rules: [], sync: null, lines: [], typed: null, changed: 0 };

  // ---- 1. the three specifications the drawing writes ------------------------
  log('1. What the drawing writes on a plate part');
  const [haveFacts] = await db.query('SELECT UPPER(code) AS code FROM cf_specifications WHERE company_id = ? AND deleted_at IS NULL AND code IN (?)', [companyId, FACT_SPECS.map((s) => s.code)]);
  const factThere = new Set(haveFacts.map((s) => s.code));
  for (const s of FACT_SPECS) {
    if (factThere.has(s.code)) { log(`   ${s.code} — already there`); out.specs.push({ code: s.code, action: 'kept' }); continue; }
    await createSpec(db, c, s);
    out.changed += 1;
    out.specs.push({ code: s.code, action: 'added' });
    log(`   ${s.code} — ADDED (${s.name}${s.defaultUom ? `, ${s.defaultUom}` : ''})`);
  }

  // What is typed today, to prove at the end that none of it moved (the facts are the system's own).
  const typedState = async () => {
    const [[r]] = await db.query(
      `SELECT COUNT(*) AS n, COALESCE(SUM(CRC32(CONCAT_WS('|', v.id, IFNULL(v.value_number, ''), IFNULL(v.value_text, ''), IFNULL(v.option_id, ''), IFNULL(v.value_bool, ''), IFNULL(v.value_date, '')))), 0) AS sum
         FROM cf_spec_values v JOIN cf_specifications s ON s.id = v.specification_id
        WHERE v.company_id = ? AND v.deleted_at IS NULL AND v.source = 'entered' AND s.code NOT IN (?)`,
      [companyId, FACT_SPECS.map((s) => s.code)],
    );
    return { n: Number(r.n), sum: String(r.sum) };
  };
  const typedBefore = await typedState();

  // ---- 2. what the company has ------------------------------------------------
  const wantedSpecs = [...new Set([...RULES.map((r) => r.spec), 'LENGTH', 'WIDTH', 'THICKNESS', 'DENSITY', ...FACT_SPECS.map((s) => s.code)])];
  const [specRows] = await db.query('SELECT id, UPPER(code) AS code, name, data_type, default_uom, decimals FROM cf_specifications WHERE company_id = ? AND deleted_at IS NULL', [companyId]);
  const specOf = new Map(specRows.map((s) => [s.code, s]));
  const [nodeRows] = await db.query("SELECT id, UPPER(code) AS code, name FROM cf_classification_nodes WHERE company_id = ? AND deleted_at IS NULL AND scope <> 'machine'", [companyId]);
  const nodeOf = new Map(nodeRows.map((n) => [n.code, n]));
  const nodeById = new Map(nodeRows.map((n) => [Number(n.id), n]));
  const [formulaRows] = await db.query('SELECT id, UPPER(code) AS code, expression, status FROM cf_formulas WHERE company_id = ? AND deleted_at IS NULL', [companyId]);
  const formulaOf = new Map(formulaRows.map((f) => [f.code, f]));
  const formulaById = new Map(formulaRows.map((f) => [Number(f.id), f]));
  const ruleSpecIds = wantedSpecs.map((code) => specOf.get(code)?.id).filter(Boolean);
  const [ruleRows] = ruleSpecIds.length ? await db.query(
    `SELECT a.id, a.specification_id, a.subject_id, a.value_rule, a.formula_id, a.is_required, a.is_applicable, a.origin, a.sort_order
       FROM cf_spec_assignments a
      WHERE a.company_id = ? AND a.subject_type = 'classification' AND a.capture_at = 'item' AND a.deleted_at IS NULL AND a.specification_id IN (?)`,
    [companyId, ruleSpecIds]) : [[]];
  const ruleAt = new Map(ruleRows.map((r) => [`${r.specification_id}:${r.subject_id}`, r]));

  // ---- 3. the surface a paint or metallising time is given: one face or both? --
  const [timings] = await db.query(
    `SELECT o.code, COALESCE(r.work_expression, wf.expression) AS work
       FROM cf_operation_machine_rules r JOIN cf_operations o ON o.id = r.operation_id AND o.deleted_at IS NULL
       LEFT JOIN cf_formulas wf ON wf.id = r.work_formula_id AND wf.deleted_at IS NULL
      WHERE r.company_id = ? AND r.deleted_at IS NULL AND COALESCE(r.work_expression, wf.expression) LIKE '%SURFACE_AREA%'`,
    [companyId],
  );
  const doubled = (t) => /SURFACE_AREA\s*\*\s*2\b|\b2\s*\*\s*item\.SURFACE_AREA/i.test(String(t ?? ''));
  const readers = [...new Map(timings.map((t) => [`${t.code}|${t.work}`, t])).values()];

  // ---- 4. the rules -----------------------------------------------------------
  log('\n2. Which value is worked out by which formula');
  const formulaWrites = new Map();   // code -> { name, description, expression }
  const inserts = [];                // new rule rows
  const updates = [];                // { id, valueRule, formulaCode | formulaId }
  const skip = (r, node, why) => { out.rules.push({ spec: r.spec, node, action: 'skipped', why }); log(`   ${node} · ${r.spec} — SKIPPED: ${why}`); };
  const targets = [];
  for (const r of RULES) {
    if (r.node === '*rollup') {
      // Every node that already rolls this value up from its BOM.
      const spec = specOf.get(r.spec);
      for (const row of ruleRows) {
        if (!spec || Number(row.specification_id) !== Number(spec.id) || row.origin !== 'manual' || !Number(row.is_applicable) || row.formula_id == null) continue;
        if (!['rollup', 'defaulted'].includes(row.value_rule)) continue;
        let usesRollup = false;
        try { usesRollup = parseFormula(formulaById.get(Number(row.formula_id))?.expression ?? '').usesRollup; } catch { /* a broken formula is left alone */ }
        if (usesRollup) targets.push({ ...r, node: nodeById.get(Number(row.subject_id))?.code ?? `#${row.subject_id}`, nodeId: Number(row.subject_id) });
      }
      continue;
    }
    targets.push({ ...r, nodeId: nodeOf.get(r.node)?.id ?? null });
  }
  for (const r of targets) {
    const spec = specOf.get(r.spec);
    if (!spec) { skip(r, r.node, `this company has no specification ${r.spec}`); continue; }
    if (r.nodeId == null) { skip(r, r.node, `this company has no classification ${r.node}`); continue; }
    if (spec.data_type !== 'number') { skip(r, r.node, `${r.spec} is a ${spec.data_type}, not a number`); continue; }
    const have = ruleAt.get(`${spec.id}:${r.nodeId}`) ?? null;
    const haveFormula = have?.formula_id != null ? formulaById.get(Number(have.formula_id)) ?? null : null;

    // Keep the rule's own formula, only make it typeable over.
    if (r.from === 'own') {
      if (have.value_rule === 'defaulted') { out.rules.push({ spec: r.spec, node: r.node, action: 'kept' }); log(`   ${r.node} · ${r.spec} — already typeable over (${haveFormula?.code ?? 'its formula'})`); continue; }
      updates.push({ id: have.id, valueRule: 'defaulted', formulaId: Number(have.formula_id) });
      out.rules.push({ spec: r.spec, node: r.node, action: 'made typeable', formula: haveFormula?.code ?? null });
      log(`   ${r.node} · ${r.spec} — roll-up ${haveFormula?.code ?? ''} kept, now TYPEABLE OVER`);
      continue;
    }

    // The expression: fixed, by unit, or the existing one with the rectangle replaced by the true area.
    let expression = FORMULAS[r.formula].expression;
    if (r.length) {
      const uom = String(spec.default_uom ?? '').toLowerCase();
      if (!['m', 'mm'].includes(uom)) { skip(r, r.node, `${r.spec} is in "${spec.default_uom ?? 'no unit'}" — a length in m or mm is needed to work it out from the parts (mm)`); continue; }
      expression = expression({ length: uom === 'm' ? 1000 : 1 });
    }
    if (r.area) {
      if (haveFormula && have.origin === 'manual' && Number(have.is_applicable)) {
        // Today's formula, with its rectangle replaced by the true area — so its units and its faces stay exactly as they are.
        if (haveFormula.expression.includes('TRUE_AREA')) expression = haveFormula.expression;
        else if (AREA_RE.test(haveFormula.expression)) expression = haveFormula.expression.replace(AREA_RE, TRUE_OR_RECTANGLE);
        else { skip(r, r.node, `its formula ${haveFormula.code} = ${haveFormula.expression} does not multiply LENGTH by WIDTH, so the true area cannot be put in its place — change it by hand`); continue; }
      } else if (r.spec === 'WEIGHT' && String(spec.default_uom ?? '').toLowerCase() !== 'kg') { skip(r, r.node, `WEIGHT is in "${spec.default_uom ?? 'no unit'}", not kg`); continue; }
      else if (r.spec === 'SURFACE_AREA' && String(spec.default_uom ?? '').toLowerCase() !== 'm2') { skip(r, r.node, `SURFACE_AREA is in "${spec.default_uom ?? 'no unit'}", not m2`); continue; }
      if (r.faces && Number(faces) === 2 && !/\*\s*2\b/.test(expression)) expression = `${expression} * 2`;
    }
    // Every specification the formula reads must exist here.
    let parsed;
    try { parsed = parseFormula(expression); } catch (e) { skip(r, r.node, `the formula does not read: ${e.message}`); continue; }
    const unknown = [...new Set([...parsed.references, ...parsed.rollupTerms])].filter((code) => !specOf.has(code) && !FACT_SPECS.some((f) => f.code === code));
    if (unknown.length) { skip(r, r.node, `this company has no specification ${unknown.join(', ')}, which the formula reads`); continue; }

    // The formula as it is here already (somebody may have edited it — it is kept), else the one to add WHEN a rule uses it.
    const existing = formulaOf.get(r.formula) ?? null;
    const f = { id: existing ? Number(existing.id) : null, expression: existing?.expression ?? expression, kept: !!existing && existing.expression.trim() !== expression.trim() };
    const useFormula = () => { if (!existing) formulaWrites.set(r.formula, { ...FORMULAS[r.formula], expression }); };
    const sameFormula = have && f.id != null && Number(have.formula_id) === f.id;
    const said = `${r.formula} = ${f.expression}`;
    const editedNote = f.kept ? ` (formula ${r.formula} was edited here and is KEPT as it is: ${f.expression})` : '';
    // A recipe where the node has a rule of its own that asks every row: that rule is what is changed.
    const asRule = r.as === 'rule' || (have && have.origin === 'manual');
    if (have && have.origin === 'manual' && r.as === 'recipe' && !(Number(have.is_applicable) && have.formula_id != null)) {
      skip(r, r.node, `${r.node} has its own rule for ${r.spec} (${Number(have.is_applicable) ? have.value_rule : 'switched off'}) — left as it is; remove it, or make it Defaulted with the formula, by hand`);
      continue;
    }
    if (have && have.value_rule === 'defaulted' && sameFormula) {
      out.rules.push({ spec: r.spec, node: r.node, action: 'kept', formula: r.formula });
      log(`   ${r.node} · ${r.spec} — already set (${r.formula})${editedNote}`);
      continue;
    }
    // Typeable over already, by a formula somebody chose here: theirs stays.
    if (have && have.value_rule === 'defaulted' && have.formula_id != null) {
      out.rules.push({ spec: r.spec, node: r.node, action: 'kept', formula: haveFormula?.code ?? null });
      log(`   ${r.node} · ${r.spec} — already typeable over, by ${haveFormula?.code ?? 'another formula'} = ${haveFormula?.expression ?? '?'} — left as it is`);
      continue;
    }
    // A value this node already works out for every row, by a formula of its own (not one of the area formulas above): that formula stays, it only becomes typeable over.
    if (have && have.origin === 'manual' && !r.area && have.formula_id != null) {
      updates.push({ id: have.id, valueRule: 'defaulted', formulaId: Number(have.formula_id) });
      out.rules.push({ spec: r.spec, node: r.node, action: 'made typeable', formula: haveFormula?.code ?? null });
      log(`   ${r.node} · ${r.spec} — ${have.value_rule} by ${haveFormula?.code ?? 'its formula'} = ${haveFormula?.expression ?? '?'} is kept, now TYPEABLE OVER`);
      continue;
    }
    useFormula();
    if (have) {
      updates.push({ id: have.id, valueRule: 'defaulted', formulaCode: r.formula, formulaId: f.id });
      out.rules.push({ spec: r.spec, node: r.node, action: 'changed', formula: r.formula, expression: f.expression, was: `${have.value_rule}${haveFormula ? ` (${haveFormula.code} = ${haveFormula.expression})` : ''}` });
      log(`   ${r.node} · ${r.spec} — CHANGED: ${have.value_rule}${haveFormula ? ` (${haveFormula.code} = ${haveFormula.expression})` : ''}  →  typeable over, ${said}${editedNote}`);
    } else {
      inserts.push({ specId: Number(spec.id), nodeId: Number(r.nodeId), formulaCode: r.formula, formulaId: f.id, origin: asRule ? 'manual' : 'flow' });
      out.rules.push({ spec: r.spec, node: r.node, action: 'added', as: asRule ? 'rule' : 'recipe', formula: r.formula, expression: f.expression });
      log(`   ${r.node} · ${r.spec} — ADDED ${asRule ? 'on every row' : 'for the rows whose flow reads it'}: typeable over, ${said}${editedNote}`);
    }
  }
  if (readers.length) {
    log('\n   SURFACE_AREA is read by these operation times:');
    for (const t of readers) log(`     ${t.code}: ${t.work}   ${doubled(t.work) ? '(× 2 in the time — the value is ONE face)' : '(no × 2 in the time)'}`);
    const none = readers.every((t) => !doubled(t.work));
    log(Number(faces) === 2 ? '   --faces 2: a part’s SURFACE_AREA is BOTH faces from now on.'
      : `   A part’s SURFACE_AREA stays as its formula has it today (one face).${none ? ' NOTE: no time multiplies it by 2, so those times cover one face — run with --faces 2 to make the value both faces.' : ''}`);
  }

  // ---- 5. write the setup -----------------------------------------------------
  for (const [code, f] of formulaWrites) {
    const made = await createFormula(db, c, { code, name: f.name, expression: f.expression, description: f.description });
    formulaOf.set(code, { id: made.id, code, expression: f.expression });
    out.changed += 1;
  }
  const idOf = (x) => x.formulaId ?? Number(formulaOf.get(x.formulaCode).id);
  if (inserts.length) {
    await db.query(
      `INSERT INTO cf_spec_assignments (company_id, specification_id, subject_type, subject_id, capture_at, is_required, is_applicable, value_rule, formula_id, sort_order, origin)
       VALUES ${inserts.map(() => "(?, ?, 'classification', ?, 'item', 0, 1, 'defaulted', ?, 80, ?)").join(', ')}`,
      inserts.flatMap((x) => [companyId, x.specId, x.nodeId, idOf(x), x.origin]),
    );
    out.changed += inserts.length;
  }
  // As many shapes as formulas — a handful of statements, never one per row of the order.
  for (const u of updates) {
    await db.query("UPDATE cf_spec_assignments SET value_rule = ?, formula_id = ? WHERE company_id = ? AND id = ?", [u.valueRule, idOf(u), companyId, u.id]);
    out.changed += 1;
  }
  if (formulaWrites.size) log(`\n   ${plural(formulaWrites.size, 'formula')} added: ${[...formulaWrites.keys()].join(', ')}`);

  // ---- 6. the rows whose flow asks for one of these values ---------------------
  log('\n3. Rows whose flow asks for one of these values (open lines only — a frozen row keeps what it was frozen with)');
  const recipeSpecIds = [...new Set(RULES.filter((r) => r.as === 'recipe').map((r) => specOf.get(r.spec)?.id).filter(Boolean))];
  const [asked] = recipeSpecIds.length ? await db.query(
    `SELECT DISTINCT a.subject_id FROM cf_spec_assignments a
      WHERE a.company_id = ? AND a.subject_type = 'master' AND a.origin = 'flow' AND a.deleted_at IS NULL AND a.specification_id IN (?)`,
    [companyId, recipeSpecIds]) : [[]];
  const sync = asked.length ? await syncFlowSpecs(db, c, asked.map((a) => Number(a.subject_id))) : { changed: [], added: [], removed: [] };
  const byCode = new Map();
  for (const x of sync.changed) byCode.set(x.code, (byCode.get(x.code) ?? 0) + 1);
  out.sync = { rows: new Set(sync.changed.map((x) => x.recordId)).size, rules: sync.changed.length, byCode: Object.fromEntries(byCode) };
  out.changed += sync.changed.length;
  log(sync.changed.length
    ? `   ${plural(sync.changed.length, 'typed rule')} on ${plural(out.sync.rows, 'row')} now worked out (a number already typed there stays, over the calculated one): ${[...byCode].map(([code, n]) => `${code} ${n}`).join(', ')}`
    : '   none to change');

  // ---- 7. every open order line: drawing facts, values, and the report ----------
  if (withLines) {
    log('\n4. Open order lines');
    const [lines] = await db.query(
      `SELECT l.id, l.line_no, o.code AS order_code,
              (SELECT COUNT(*) FROM cf_part_drawings d WHERE d.company_id = l.company_id AND d.order_line_id = l.id AND d.deleted_at IS NULL AND d.file_kind = 'dxf') AS dxf
         FROM cf_sales_order_lines l
         JOIN cf_sales_orders o ON o.id = l.order_id AND o.deleted_at IS NULL
        WHERE l.company_id = ? AND l.deleted_at IS NULL AND l.item_id IS NOT NULL AND l.line_type = 'custom' AND l.locked_at IS NULL
          AND o.status NOT IN (?)${orderCode ? ' AND o.code = ?' : ''}
          AND NOT EXISTS (SELECT 1 FROM cf_production_releases r WHERE r.company_id = l.company_id AND r.order_line_id = l.id AND r.deleted_at IS NULL)
        ORDER BY o.code, l.line_no`,
      orderCode ? [companyId, [...LOCKED_ORDER_STATUSES], orderCode] : [companyId, [...LOCKED_ORDER_STATUSES]],
    );
    if (!lines.length) log('   none');
    for (const l of lines) {
      const facts = Number(l.dxf) ? await refreshDrawingValues(db, c, l.id, { force: true }) : { written: 0, cleared: 0 };
      const settled = await materializeLine(db, c, l.id);
      const cmp = await compareLineValues(db, companyId, l.id);
      const k = cmp.counts;
      out.changed += (facts.written ?? 0) + (facts.cleared ?? 0) + settled.values;
      out.lines.push({ lineId: l.id, order: l.order_code, lineNo: l.line_no, drawings: Number(l.dxf), facts: facts.written ?? 0, valuesWritten: settled.values, ...k });
      log(`   ${l.order_code} line ${l.line_no}: ${plural(Number(l.dxf), 'DXF drawing')}, ${plural(facts.written ?? 0, 'drawing fact')} written, ${plural(settled.values, 'worked-out value')} stored`);
      log(`      values a formula now gives: ${k.typed + k.same + k.calculated + k.typed_only + k.empty}`
        + ` — ${k.typed} typed by hand and DIFFERENT from the calculated value (kept as typed; shown as "typed over a calculated value")`
        + `, ${k.same} typed and EQUAL to it (shown as calculated; nothing is deleted)`
        + `, ${k.calculated} filled by the formula`
        + `, ${k.typed_only} typed where the formula has no answer yet`
        + `, ${k.empty} still empty`);
    }
  }

  // ---- 8. nothing a person typed has moved --------------------------------------
  const typedAfter = await typedState();
  out.typed = { before: typedBefore, after: typedAfter };
  if (typedBefore.n !== typedAfter.n || typedBefore.sum !== typedAfter.sum) {
    throw new Error(`A typed value changed (${typedBefore.n} typed values before, ${typedAfter.n} after; checksum ${typedBefore.sum} → ${typedAfter.sum}). Nothing is kept — this must never happen.`);
  }
  log(`\n   Typed values: ${typedBefore.n} before, ${typedAfter.n} after — none changed.`);
  return out;
}

/* ===========================================================================
 * Typed against calculated, one order
 * ======================================================================== */

const fmt = (n, decimals) => (n == null ? '' : decimals == null ? String(Number(Number(n).toFixed(6))) : Number(n).toFixed(decimals));
const csvCell = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

/**
 * Every row / value of one order where a number was typed by hand over a calculated one, with the
 * two numbers and the difference — a check of the typing AND of the formulas. Call it inside a
 * transaction that is rolled back: the setup is laid on first so the report is the same before
 * and after an --apply.
 * → { orders: [{ code, revision, lines: [{ lineNo, frozen, counts, rows }] }], totals }
 */
export async function compareOrder(db, { companyId, orderCode, log = console.log, out: outFile = null }) {
  const { compareLineValues } = await import('../../apps/cf_erp/services/orderValuesService.js');
  const { readFactInputs, planFacts } = await import('../../apps/cf_erp/services/drawingValueService.js');
  const quiet = () => {};
  const done = await setup(db, { companyId, log: quiet, lines: true, orderCode });
  log(done.changed ? 'The setup is not applied yet in this company (or not completely): it is laid on for this report only — NOTHING IS KEPT.' : 'The setup is applied in this company; this report writes nothing.');
  const skipped = done.rules.filter((r) => r.action === 'skipped');
  if (skipped.length) { log('Not worked out here (so not compared):'); for (const s of skipped) log(`   ${s.node} · ${s.spec}: ${s.why}`); }

  const [lines] = await db.query(
    `SELECT l.id, l.line_no, o.id AS order_id, o.code, o.revision, o.status
       FROM cf_sales_orders o JOIN cf_sales_order_lines l ON l.order_id = o.id AND l.deleted_at IS NULL AND l.item_id IS NOT NULL
      WHERE o.company_id = ? AND o.deleted_at IS NULL AND o.code = ? ORDER BY o.revision, o.id, l.line_no`,
    [companyId, orderCode],
  );
  if (!lines.length) throw new Error(`No order ${orderCode} with a structure in company ${companyId}.`);
  const result = { orders: [], totals: { typed: 0, same: 0, calculated: 0, typed_only: 0, empty: 0 } };
  const csv = [['order', 'revision', 'line', 'row', 'value', 'code', 'unit', 'typed', 'calculated', 'difference', 'difference %', 'calculated from', 'formula', 'state'].join(',')];
  for (const l of lines) {
    // A frozen line's rows hold no drawing facts: what its drawings say is laid over them, in memory.
    const input = await readFactInputs(db, companyId, l.id);
    const facts = planFacts(input.rows, input.drawings);
    const cmp = await compareLineValues(db, companyId, l.id, { thaw: true, facts });
    let order = result.orders.find((o) => o.id === l.order_id);
    if (!order) { order = { id: l.order_id, code: l.code, revision: l.revision ?? 1, status: l.status, lines: [] }; result.orders.push(order); }
    order.lines.push({ lineNo: l.line_no, frozen: cmp.frozen, counts: cmp.counts, rows: cmp.rows });
    for (const k of Object.keys(result.totals)) result.totals[k] += cmp.counts[k];

    const k = cmp.counts;
    log(`\n${l.code}${(l.revision ?? 1) > 1 ? ` rev ${l.revision}` : ''} · line ${l.line_no}${cmp.frozen ? ` (${cmp.frozen} — read as if it were open; the line itself is unchanged)` : ''} — ${plural(input.drawings.length, 'drawing')} with a shape`);
    log(`   ${k.typed} typed and DIFFERENT · ${k.same} typed and equal · ${k.calculated} calculated, nothing typed · ${k.typed_only} typed, no calculated value yet · ${k.empty} empty`);
    const differ = cmp.rows.filter((r) => r.state === 'typed')
      .sort((a, b) => Math.abs(b.calculated ? b.difference / b.calculated : Infinity) - Math.abs(a.calculated ? a.difference / a.calculated : Infinity));
    if (differ.length) {
      log('   typed ≠ calculated (largest difference first):');
      const w = Math.min(46, Math.max(...differ.map((r) => r.row.length)));
      for (const r of differ) {
        const pct = r.calculated ? `${(100 * r.difference / r.calculated).toFixed(1)} %` : '—';
        log(`     ${r.row.slice(0, w).padEnd(w)}  ${r.code.padEnd(22)} typed ${fmt(r.typed, r.decimals).padStart(12)}   calculated ${fmt(r.calculated, r.decimals).padStart(12)}   ${r.difference > 0 ? '+' : ''}${fmt(r.difference, r.decimals)} ${r.unit ?? ''} (${pct})${r.from === 'drawing' ? '  [from the drawing]' : ''}`);
      }
    }
    const noAnswer = cmp.rows.filter((r) => r.state === 'typed_only');
    if (noAnswer.length) {
      log('   typed, and the formula has no answer:');
      for (const r of noAnswer.slice(0, 40)) log(`     ${r.row} · ${r.code}: typed ${fmt(r.typed, r.decimals)}${r.waiting?.length ? ` — waiting for ${r.waiting.slice(0, 4).join(', ')}` : ''}`);
      if (noAnswer.length > 40) log(`     … and ${noAnswer.length - 40} more`);
    }
    for (const r of cmp.rows) {
      csv.push([l.code, l.revision ?? 1, l.line_no, r.row, r.spec, r.code, r.unit ?? '', fmt(r.typed, null), fmt(r.calculated, null), fmt(r.difference, null),
        r.difference != null && r.calculated ? (100 * r.difference / r.calculated).toFixed(2) : '', r.from ?? '', r.formula ?? '', r.state].map(csvCell).join(','));
    }
  }
  const t = result.totals;
  log(`\nORDER ${orderCode}: ${t.typed} typed and DIFFERENT, ${t.same} typed and equal, ${t.calculated} calculated with nothing typed, ${t.typed_only} typed where nothing is calculated, ${t.empty} empty.`);
  if (outFile) { fs.writeFileSync(outFile, `﻿${csv.join('\r\n')}\r\n`); log(`Every value, typed and calculated, is in ${outFile}`); }
  return result;
}

/* ===========================================================================
 * CLI
 * ======================================================================== */

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
  const COMPANY = Number(arg('company'));
  const APPLY = process.argv.includes('--apply');
  const COMPARE = process.argv.includes('--compare');
  if (!Number.isInteger(COMPANY) || (COMPARE && !arg('order')) || (COMPARE && APPLY)) {
    console.error('Usage: --company <id> [--apply] [--faces 1|2]   |   --company <id> --compare --order <code> [--out file.csv]');
    process.exit(1);
  }
  const { pool } = await import('../../db.js');
  await import('../../apps/cf_erp/services/codegenProvider.js');
  const db = await pool.getConnection();
  try {
    await db.beginTransaction();
    if (COMPARE) {
      await compareOrder(db, { companyId: COMPANY, orderCode: arg('order'), out: arg('out') });
      await db.rollback();
      console.log('\nNothing was written.');
    } else {
      const out = await setup(db, { companyId: COMPANY, faces: arg('faces') });
      if (APPLY) { await db.commit(); console.log(`\nAPPLIED — ${plural(out.changed, 'change')} committed.`); }
      else { await db.rollback(); console.log(`\nDRY RUN — ${plural(out.changed, 'change')} would be made; everything was rolled back. Run again with --apply to keep it.`); }
    }
  } catch (e) {
    try { await db.rollback(); } catch { /* the original error is the one that matters */ }
    console.error(`\nSTOPPED, nothing kept: ${e.message}`);
    if (e.problems) console.error(e.problems.join('\n'));
    process.exitCode = 1;
  } finally {
    db.release();
    await pool.end();
  }
}
