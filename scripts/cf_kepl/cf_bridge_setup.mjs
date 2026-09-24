/**
 * cf_bridge_setup.mjs — the cf_erp setup the KEPL ROB bridge job needs:
 * classification, specifications, one formula, the rules that hang on the
 * tree, and the coding rules that name the records.
 *
 * It creates nothing that the raw-material import (cf_rm_import.mjs) already
 * made: the eleven steel specifications, PLATE_WEIGHT and SECTION_WEIGHT and
 * the STEEL tree are reused by code, never duplicated.
 *
 * Everything goes through the cf_erp services, so the rules are enforced and
 * cf_spec_value_history is written. No raw INSERT into any cf_ table.
 *
 * Re-runnable: every object is looked up by its code first and only created
 * when missing. A second run must create nothing.
 *
 *   cd multi_app_be && node <this file>              # setup + verify + probe
 *   CF_BRIDGE_COMPANY=2 node <this file>
 *   node <this file> --verify-only                   # no writes
 */
import path from 'path';
import { pathToFileURL } from 'url';
// Relative to THIS file, not the working directory (which must be multi_app_be).
import * as DATA from './cf_bridge_data.mjs';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);

const { pool } = await imp('db.js');
await imp('apps/cf_erp/services/codegenProvider.js');          // registers the 'item' / 'definition' entities
const cls = await imp('apps/cf_erp/services/classificationService.js');
const specs = await imp('apps/cf_erp/services/specificationService.js');
const formulas = await imp('apps/cf_erp/services/formulaService.js');
const rules = await imp('apps/cf_erp/services/assignmentService.js');
const values = await imp('apps/cf_erp/services/valueService.js');
const recs = await imp('apps/cf_erp/services/masterRecordService.js');
const bomService = await imp('apps/cf_erp/services/bomService.js');
const codegen = await imp('apps/cf_erp/modules/codegen/service.js');
const codegenEngine = await imp('apps/cf_erp/modules/codegen/index.js');
const resolution = await imp('apps/cf_erp/services/resolutionService.js');

const VERIFY_ONLY = process.argv.includes('--verify-only');
const COMPANY = Number(process.env.CF_BRIDGE_COMPANY ?? 2);

const tally = { created: {}, reused: {} };
const bump = (bag, k, n = 1) => { bag[k] = (bag[k] ?? 0) + n; };
const made = (k, n = 1) => bump(tally.created, k, n);
const kept = (k, n = 1) => bump(tally.reused, k, n);
const say = (...a) => console.log(...a);

// ---------------------------------------------------------------------------
// Reuse-by-code helpers — the same shapes cf_rm_import.mjs proved
// ---------------------------------------------------------------------------

async function ensureNode(db, c, { code, name, parentId = null, description = null, scope = 'both' }) {
  const [[row]] = await db.query(
    'SELECT id FROM cf_classification_nodes WHERE company_id = ? AND code = ? AND deleted_at IS NULL', [c.companyId, code],
  );
  if (row) { kept('classification node'); return row.id; }
  const node = await cls.createNode(db, c, { code, name, parentId, description, scope });
  made('classification node');
  return node.id;
}

async function ensureSpec(db, c, def) {
  const [[row]] = await db.query(
    'SELECT id FROM cf_specifications WHERE company_id = ? AND code = ? AND deleted_at IS NULL', [c.companyId, def.code],
  );
  if (!row) {
    const s = await specs.createSpec(db, c, def);
    made('specification');
    made('spec option', (def.options ?? []).length);
    return s.id;
  }
  kept('specification');
  for (const o of def.options ?? []) {
    const [[have]] = await db.query(
      'SELECT id FROM cf_spec_options WHERE company_id = ? AND specification_id = ? AND LOWER(value) = ? AND deleted_at IS NULL',
      [c.companyId, row.id, String(o.value).toLowerCase()],
    );
    if (have) kept('spec option');
    else { await specs.addOption(db, c, row.id, o); made('spec option'); }
  }
  return row.id;
}

async function ensureFormula(db, c, def) {
  const [[row]] = await db.query(
    'SELECT id FROM cf_formulas WHERE company_id = ? AND code = ? AND deleted_at IS NULL', [c.companyId, def.code],
  );
  if (row) { kept('formula'); return row.id; }
  const f = await formulas.createFormula(db, c, def);
  made('formula');
  return f.id;
}

async function ensureRule(db, c, subjectId, specId, body) {
  const existing = await rules.listRules(db, c.companyId, 'classification', subjectId);
  const have = existing.find((r) => r.specificationId === specId && r.captureAt === (body.captureAt ?? 'item'));
  if (have) { kept('assignment'); return have.id; }
  const r = await rules.createRule(db, c, { subjectType: 'classification', subjectId, specificationId: specId, ...body });
  made('assignment');
  return r.id;
}

/** A fixed/default value on a classification node — written only when it differs. */
async function ensureNodeValue(db, c, nodeId, specCode, value) {
  const [[row]] = await db.query(
    `SELECT v.value_number, v.value_bool, v.value_text, o.value AS option_value
       FROM cf_spec_values v
       JOIN cf_specifications s ON s.id = v.specification_id
       LEFT JOIN cf_spec_options o ON o.id = v.option_id
      WHERE v.company_id = ? AND s.code = ? AND v.subject_type = 'classification' AND v.subject_id = ? AND v.deleted_at IS NULL`,
    [c.companyId, specCode, nodeId],
  );
  if (row) {
    const same = typeof value === 'boolean'
      ? Number(row.value_bool) === (value ? 1 : 0)
      : typeof value === 'number'
        ? Math.abs(Number(row.value_number) - value) < 1e-9
        : String(row.option_value ?? row.value_text ?? '').toLowerCase() === String(value).toLowerCase();
    if (same) { kept('classification value'); return; }
  }
  await values.setValues(db, c, 'classification', nodeId, [{ specCode, value }]);
  made('classification value');
}

async function ensureScheme(db, c, body) {
  const [[row]] = await db.query(
    'SELECT id FROM cf_code_schemes WHERE company_id = ? AND code = ? AND deleted_at IS NULL', [c.companyId, body.code],
  );
  if (row) { kept('coding rule'); return row.id; }
  const s = await codegen.createScheme(db, c.companyId, c.userId, body);
  made('coding rule');
  return s.id;
}

const tok = (key, extra = {}) => ({ segmentType: 'token', tokenKey: key, transform: 'upper', isRequired: true, ...extra });
const lit = (text) => ({ segmentType: 'literal', literalText: text });
const seq = (format = '000') => ({ segmentType: 'sequence', format, isRequired: true });

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

/**
 * The eleven the raw-material import already made. Repeated here only so this
 * script also works against a company that has never seen cf_rm_import.mjs —
 * ensureSpec reuses by code, so on company 2 every one of these is a no-op.
 */
const BASE_SPECS = [
  { code: 'THICKNESS', name: 'Thickness', dataType: 'number', measurementType: 'LENGTH', defaultUom: 'mm', decimals: 2 },
  { code: 'WIDTH', name: 'Width', dataType: 'number', measurementType: 'LENGTH', defaultUom: 'mm', decimals: 2 },
  { code: 'LENGTH', name: 'Length', dataType: 'number', measurementType: 'LENGTH', defaultUom: 'mm', decimals: 2 },
  { code: 'DEPTH', name: 'Depth', dataType: 'number', measurementType: 'LENGTH', defaultUom: 'mm', decimals: 2 },
  { code: 'SECTION_AREA', name: 'Section area', dataType: 'number', measurementType: 'AREA', defaultUom: 'mm2', decimals: 3 },
  { code: 'DENSITY', name: 'Density', dataType: 'number', measurementType: 'DENSITY', defaultUom: 'kg/m3', decimals: 1 },
  { code: 'WEIGHT', name: 'Weight', dataType: 'number', measurementType: 'MASS', defaultUom: 'kg', decimals: 3 },
  { code: 'MATERIAL', name: 'Material', dataType: 'option', options: [{ value: 'MS', label: 'Mild steel' }] },
  { code: 'GRADE', name: 'Grade', dataType: 'option', options: [{ value: 'E250' }, { value: 'E350' }] },
  { code: 'IMPACT_CLASS', name: 'Impact class', dataType: 'option',
    options: [{ value: 'BO', label: 'BO — no impact test' }, { value: 'BR', label: 'BR — room-temperature impact test' }] },
  { code: 'NESTING', name: 'Cut to size', dataType: 'boolean' },
];

const NEW_SPECS = [
  { code: 'PART_FUNCTION', name: 'Part function', dataType: 'option', options: DATA.PART_FUNCTION_OPTIONS,
    description: 'What the part does in the assembly it belongs to — flange, web, stiffener, cover plate. This is half of a part’s identity; its drawing mark is not, because that changes with where it sits.' },
  { code: 'HOLED', name: 'Holed', dataType: 'boolean',
    description: 'Whether the part is drilled. A drilled part is a different part: it is usually made wider to keep edge distance, and it takes a drilling operation the plain one does not.' },
  { code: 'DRAWING_MARK', name: 'Drawing mark', dataType: 'text',
    description: 'The mark this part carries on the fabrication drawing. It is positional, so the same part can be IS1 on one girder and IS2 on the next — never use it to tell two parts apart.' },
  { code: 'SPAN_LENGTH', name: 'Span length', dataType: 'number', measurementType: 'LENGTH', defaultUom: 'mm', decimals: 0,
    description: 'Length of the span, bearing centre to bearing centre.' },
  { code: 'SKEW_ANGLE', name: 'Skew angle', dataType: 'number', measurementType: 'ANGLE', defaultUom: 'deg', decimals: 2,
    description: 'How far the supports lean away from square to the girder lines. Zero is a square span.' },
  { code: 'GIRDER_SPACING', name: 'Girder spacing', dataType: 'number', measurementType: 'LENGTH', defaultUom: 'mm', decimals: 2,
    description: 'Centre-to-centre distance between neighbouring girder lines.' },
];

const NODES = [
  { code: 'FABRICATED', name: 'Fabricated', parent: null,
    description: 'Everything the shop makes out of bought steel — cut parts, the assemblies welded from them, and the structures those build up into.' },
  { code: 'FAB_PARTS', name: 'Parts', parent: 'FABRICATED',
    description: 'A single piece cut from one plate or one section: it has no BOM, and it is the bottom of every fabricated structure.' },
  { code: 'PLATE_PART', name: 'Plate part', parent: 'FAB_PARTS',
    description: 'A part cut from plate, so it is a rectangle and its weight is thickness x length x width x density.' },
  { code: 'PROFILE_PART', name: 'Profile part', parent: 'FAB_PARTS',
    description: 'A part cut from a rolled section (angle, beam, channel), so its weight comes from the section area — a rectangle would be wrong.' },
  { code: 'FAB_ASSY', name: 'Assemblies', parent: 'FABRICATED',
    description: 'Parts welded into one unit that is handled, lifted and weighed as one: a girder segment, a diaphragm, a splice set.' },
  { code: 'GIRDER_SEGMENT', name: 'Girder segment', parent: 'FAB_ASSY',
    description: 'One shop-length piece of a girder line: top flange, web, bottom flange and its stiffeners welded together.' },
  { code: 'DIAPHRAGM', name: 'Diaphragm', parent: 'FAB_ASSY',
    description: 'A cross-frame welded up to brace one girder line against the next, at an end or in between.' },
  { code: 'SPLICE_SET', name: 'Splice set', parent: 'FAB_ASSY',
    description: 'The cover plates that bolt or weld two girder segments together at one site joint.' },
  { code: 'FAB_STRUCT', name: 'Structures', parent: 'FABRICATED',
    description: 'An assembly of assemblies that only comes together on site — nothing here leaves the shop in one piece.' },
  { code: 'GIRDER_LINE', name: 'Girder line', parent: 'FAB_STRUCT',
    description: 'One complete girder from support to support: its segments end to end plus the splices that join them.' },
  { code: 'BRIDGE_SPAN', name: 'Bridge span', parent: 'FAB_STRUCT',
    description: 'One span of the bridge: its girder lines, the diaphragms braced between them and the shear studs on top.' },
  { code: 'BOUGHT', name: 'Bought out', parent: null,
    description: 'Items bought finished and fitted as they arrive — nothing here is cut, welded or otherwise made by the shop.' },
  { code: 'FASTENERS', name: 'Fasteners', parent: 'BOUGHT',
    description: 'Bought fixings that join steel to steel or steel to concrete: studs, bolts, nuts and washers.' },
  { code: 'SHEAR_STUD', name: 'Shear stud', parent: 'FASTENERS',
    description: 'A headed stud welded to a girder top flange to tie the steel to the concrete deck.' },
];

async function setup(db, c) {
  // --- 1. Classification ---------------------------------------------------
  const node = {};
  for (const n of NODES) {
    node[n.code] = await ensureNode(db, c, {
      code: n.code, name: n.name, description: n.description, scope: 'both',
      parentId: n.parent ? node[n.parent] : null,
    });
  }

  // --- 2. Specifications ---------------------------------------------------
  const spec = {};
  for (const d of [...BASE_SPECS, ...NEW_SPECS]) spec[d.code] = await ensureSpec(db, c, d);

  // --- 3. Formulas ---------------------------------------------------------
  // PLATE_WEIGHT and SECTION_WEIGHT already exist (cf_rm_import); look them up.
  const formulaId = {};
  for (const code of ['PLATE_WEIGHT', 'SECTION_WEIGHT']) {
    const [[row]] = await db.query('SELECT id FROM cf_formulas WHERE company_id = ? AND code = ? AND deleted_at IS NULL', [c.companyId, code]);
    if (!row) throw new Error(`Formula ${code} is missing — run cf_rm_import.mjs on company ${c.companyId} first.`);
    formulaId[code] = row.id;
    kept('formula');
  }
  // Check before creating: a roll-up rule refuses a formula that is not a roll-up,
  // so the kind is worth knowing before it is written.
  const check = await formulas.checkFormula(db, c.companyId, 'SUM(children.WEIGHT)');
  say(`  ASSEMBLY_WEIGHT check: kind=${check.kind}  usesRollup=${check.usesRollup}  rollupTerms=[${check.rollupTerms}]  problems=${JSON.stringify(check.problems)}`);
  if (check.kind !== 'rollup') throw new Error(`SUM(children.WEIGHT) parsed as "${check.kind}", not rollup.`);
  formulaId.ASSEMBLY_WEIGHT = await ensureFormula(db, c, {
    code: 'ASSEMBLY_WEIGHT', name: 'Assembly weight', expression: 'SUM(children.WEIGHT)',
    description: 'An assembly weighs the sum of what is in it — each child times the quantity its BOM line asks for. It is the gross weight of the steel, before any weld metal or paint.',
  });

  // --- 4. Values the fixed rules read -------------------------------------
  // Written before the rules, so a Fixed rule never exists without its value.
  await ensureNodeValue(db, c, node.FAB_PARTS, 'DENSITY', 7850);
  await ensureNodeValue(db, c, node.FAB_PARTS, 'MATERIAL', 'MS');

  // --- 5. Rules — each one as high in the tree as it is true ---------------
  // Every fabricated part, whatever it is cut from.
  await ensureRule(db, c, node.FAB_PARTS, spec.DENSITY, { valueRule: 'fixed', sortOrder: 90 });
  await ensureRule(db, c, node.FAB_PARTS, spec.MATERIAL, { valueRule: 'fixed', sortOrder: 91 });
  await ensureRule(db, c, node.FAB_PARTS, spec.GRADE, { valueRule: 'entered', isRequired: true, sortOrder: 10 });
  await ensureRule(db, c, node.FAB_PARTS, spec.IMPACT_CLASS, { valueRule: 'entered', isRequired: true, sortOrder: 11 });
  await ensureRule(db, c, node.FAB_PARTS, spec.PART_FUNCTION, { valueRule: 'entered', isRequired: true, sortOrder: 5 });
  await ensureRule(db, c, node.FAB_PARTS, spec.HOLED, { valueRule: 'entered', sortOrder: 12 });
  await ensureRule(db, c, node.FAB_PARTS, spec.DRAWING_MARK, { valueRule: 'entered', sortOrder: 13 });
  await ensureRule(db, c, node.FAB_PARTS, spec.LENGTH, { valueRule: 'entered', isRequired: true, sortOrder: 22 });
  // Cut from plate: a rectangle.
  await ensureRule(db, c, node.PLATE_PART, spec.THICKNESS, { valueRule: 'entered', isRequired: true, sortOrder: 20 });
  await ensureRule(db, c, node.PLATE_PART, spec.WIDTH, { valueRule: 'entered', isRequired: true, sortOrder: 21 });
  await ensureRule(db, c, node.PLATE_PART, spec.WEIGHT, { valueRule: 'calculated', formulaId: formulaId.PLATE_WEIGHT, sortOrder: 80 });
  // Cut from a rolled section: the section area carries the shape.
  await ensureRule(db, c, node.PROFILE_PART, spec.THICKNESS, { valueRule: 'entered', sortOrder: 20 });
  await ensureRule(db, c, node.PROFILE_PART, spec.WIDTH, { valueRule: 'entered', sortOrder: 21 });
  await ensureRule(db, c, node.PROFILE_PART, spec.DEPTH, { valueRule: 'entered', sortOrder: 23 });
  await ensureRule(db, c, node.PROFILE_PART, spec.SECTION_AREA, { valueRule: 'entered', sortOrder: 24 });
  await ensureRule(db, c, node.PROFILE_PART, spec.WEIGHT, { valueRule: 'calculated', formulaId: formulaId.SECTION_WEIGHT, sortOrder: 80 });
  // An assembly weighs what is in it, and carries a mark on the drawing.
  await ensureRule(db, c, node.FAB_ASSY, spec.WEIGHT, { valueRule: 'rollup', formulaId: formulaId.ASSEMBLY_WEIGHT, sortOrder: 80 });
  await ensureRule(db, c, node.FAB_ASSY, spec.DRAWING_MARK, { valueRule: 'entered', sortOrder: 13 });
  // A structure weighs what is in it, and has a geometry of its own.
  await ensureRule(db, c, node.FAB_STRUCT, spec.WEIGHT, { valueRule: 'rollup', formulaId: formulaId.ASSEMBLY_WEIGHT, sortOrder: 80 });
  await ensureRule(db, c, node.FAB_STRUCT, spec.SPAN_LENGTH, { valueRule: 'entered', sortOrder: 30 });
  await ensureRule(db, c, node.FAB_STRUCT, spec.SKEW_ANGLE, { valueRule: 'entered', sortOrder: 31 });
  await ensureRule(db, c, node.FAB_STRUCT, spec.GIRDER_SPACING, { valueRule: 'entered', sortOrder: 32 });
  // A bought fastener is weighed from its catalogue, not calculated.
  await ensureRule(db, c, node.FASTENERS, spec.WEIGHT, { valueRule: 'entered', sortOrder: 80 });

  // --- 6. Coding rules -----------------------------------------------------
  // A plate part's code is what it does, how big it is and what it is made of:
  // TF-25X11650X500-E350. Thickness first, then length, then width — the order
  // the BOQ reads. IMPACT_CLASS is not in the code: every part on this job is
  // the same impact class, and a code carries what tells two parts apart.
  await ensureScheme(db, c, {
    code: 'CFFB-PLATEPART', name: 'Fabricated plate part code', entityType: 'item', targetField: 'code',
    seqScope: 'prefix', priority: 0,
    description: 'Short name, thickness x length x width, grade.',
    conditions: [{ tokenKey: 'classification', operator: 'under', value: String(node.PLATE_PART) }],
    segments: [
      tok('record.shortName'), lit('-'),
      tok('spec:THICKNESS'), lit('X'), tok('spec:LENGTH'), lit('X'), tok('spec:WIDTH'),
      lit('-'), tok('spec:GRADE'),
    ],
  });
  // A part cut from a rolled section reads depth x width x thickness x length —
  // the order CFRM-STEEL already uses for the stock it is cut from, so the cut
  // part and its parent bar read alike: ISA-200X200X25X2400-E350 out of
  // ISA-200X200X25X6000-E350BO.
  //
  // Priority 1, against the plate rule's 0. The two conditions are disjoint
  // subtrees, so no item can satisfy both and the engine never has to choose.
  // The numbers differ on purpose all the same: if the tree is ever rearranged
  // so both could match, the engine picks one instead of refusing with
  // SCHEME_TIE and leaving the item with no code and no way to be activated.
  await ensureScheme(db, c, {
    code: 'CFFB-PROFILEPART', name: 'Fabricated profile part code', entityType: 'item', targetField: 'code',
    seqScope: 'prefix', priority: 1,
    description: 'Short name, depth x width x thickness x length, grade — the same size order as the raw-material profile code, so a cut part reads like the stock it came from.',
    conditions: [{ tokenKey: 'classification', operator: 'under', value: String(node.PROFILE_PART) }],
    segments: [
      tok('record.shortName'), lit('-'),
      tok('spec:DEPTH'), lit('X'), tok('spec:WIDTH'), lit('X'), tok('spec:THICKNESS'), lit('X'), tok('spec:LENGTH'),
      lit('-'), tok('spec:GRADE'),
    ],
  });
  // An assembly has no size of its own to code — it is counted: GS-001, EDIA-001.
  await ensureScheme(db, c, {
    code: 'CFFB-ASSY', name: 'Fabricated assembly code', entityType: 'item', targetField: 'code',
    seqScope: 'prefix', priority: 0,
    description: 'Short name and a running number, restarting for each short name.',
    conditions: [{ tokenKey: 'classification', operator: 'under', value: String(node.FAB_ASSY) }],
    segments: [tok('record.shortName'), lit('-'), seq('000')],
  });
  await ensureScheme(db, c, {
    code: 'CFBO-FASTENER', name: 'Bought fastener code', entityType: 'item', targetField: 'code',
    seqScope: 'prefix', priority: 0,
    description: 'Short name and a running number, restarting for each short name.',
    conditions: [{ tokenKey: 'classification', operator: 'under', value: String(node.FASTENERS) }],
    segments: [tok('record.shortName'), lit('-'), seq('000')],
  });
  await ensureScheme(db, c, {
    code: 'CFFB-DEF', name: 'Fabricated definition code', entityType: 'definition', targetField: 'code',
    seqScope: 'prefix', priority: 0,
    description: 'Short name and a running number, for template and selection definitions in the fabricated tree.',
    conditions: [{ tokenKey: 'classification', operator: 'under', value: String(node.FABRICATED) }],
    segments: [tok('record.shortName'), lit('-'), seq('000')],
  });
  // Temporary items — the ones an order mints from a template definition. They
  // key off WHERE the item sits, not what it is, so they cover every structure
  // an order ever builds and not just bridges. The short name falls back to the
  // template's (shortOf in codegenProvider.js), so SPAN and GLINE come from
  // TPL-BRIDGE-SPAN and TPL-GIRDER-LINE without anything being typed on the
  // temporary item itself.
  //
  // On precedence: the engine sorts by the total WEIGHT of the conditions that
  // held, and only uses priority to break a tie (engine.js selectScheme). A
  // placement condition weighs 1; "classification under" weighs 1 + the node's
  // depth, so 3 at a Variant and 2 at a Subfamily. CFFB-PLATEPART (3),
  // CFFB-ASSY (2) and CFBO-FASTENER (2) therefore already beat these two on
  // weight alone, whatever the priority. Priority -10 only decides the one case
  // weight leaves open: a rule conditioned on a whole Family also weighs 1, and
  // there the classification rule now wins.
  const tmpSegments = (parentToken) => [
    tok(parentToken), lit('-'), tok('record.shortName'), lit('-'),
    tok('position', { format: '00' }),
  ];
  await ensureScheme(db, c, {
    code: 'CFTMP-LINE', name: 'Temporary item on an order line', entityType: 'item', targetField: 'code',
    seqScope: 'prefix', priority: -10,
    description: 'The order number, the template short name and the line position: SO-KEPL-ROB60-SPAN-01.',
    conditions: [{ tokenKey: 'placement', operator: 'eq', value: 'line' }],
    segments: tmpSegments('order.code'),
  });
  await ensureScheme(db, c, {
    code: 'CFTMP-PART', name: 'Temporary item inside another', entityType: 'item', targetField: 'code',
    seqScope: 'prefix', priority: -10,
    description: 'The parent temporary item code, the template short name and the BOM position: SO-KEPL-ROB60-SPAN-01-GLINE-01.',
    conditions: [{ tokenKey: 'placement', operator: 'eq', value: 'component' }],
    segments: tmpSegments('parent.code'),
  });
  // The house order number: SO-20260924-0001. No conditions, so it is the
  // default for every sales order, customer or stock. Without it createOrder
  // throws CODE_REQUIRED and someone has to type the number in by hand.
  //
  // seqScope 'prefix' keys the sequence on everything rendered before it —
  // 'SO-20260924-' — so the count restarts each day instead of running forever.
  await ensureScheme(db, c, {
    code: 'CFSO-ORDER', name: 'Sales order number', entityType: 'sales_order', targetField: 'code',
    seqScope: 'prefix', priority: 0,
    description: 'SO, the date the order is taken, and a number that restarts each day.',
    conditions: [],
    segments: [lit('SO'), lit('-'), { segmentType: 'date', format: 'YYYYMMDD' }, lit('-'), seq('0000')],
  });

  return { node, spec, formulaId };
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

const fmt = (v) => (v === null || v === undefined ? 'NULL' : String(v));

async function verify(conn, c) {
  say('\n================ VERIFY ================');
  const [nodes] = await conn.query(
    `SELECT n.id, n.depth, n.code, n.name, n.scope, p.code AS parent
       FROM cf_classification_nodes n LEFT JOIN cf_classification_nodes p ON p.id = n.parent_id
      WHERE n.company_id = ? AND n.deleted_at IS NULL ORDER BY n.id`, [c.companyId],
  );
  say('  classification (whole company):');
  for (const n of nodes) say(`    ${'  '.repeat(n.depth)}${n.code.padEnd(16)} #${n.id}  ${['Family', 'Subfamily', 'Variant'][n.depth]}  scope=${n.scope}  parent=${n.parent ?? '-'}`);

  const [sp] = await conn.query(
    `SELECT code, name, data_type, measurement_type, default_uom, decimals,
            (SELECT COUNT(*) FROM cf_spec_options o WHERE o.specification_id = s.id AND o.deleted_at IS NULL) AS opts
       FROM cf_specifications s WHERE company_id = ? AND deleted_at IS NULL ORDER BY code`, [c.companyId],
  );
  say(`\n  specifications (${sp.length}): ` + sp.map((s) => `${s.code}${s.opts ? `(${s.opts})` : ''}`).join(' '));

  const [fm] = await conn.query('SELECT code, expression FROM cf_formulas WHERE company_id = ? AND deleted_at IS NULL ORDER BY code', [c.companyId]);
  say(`  formulas (${fm.length}): ` + fm.map((f) => `${f.code} = ${f.expression}`).join('   |   '));

  const [as] = await conn.query(
    `SELECT n.code AS node, s.code AS spec, a.value_rule, a.is_required, f.code AS formula
       FROM cf_spec_assignments a
       JOIN cf_classification_nodes n ON n.id = a.subject_id
       JOIN cf_specifications s ON s.id = a.specification_id
       LEFT JOIN cf_formulas f ON f.id = a.formula_id
      WHERE a.company_id = ? AND a.subject_type = 'classification' AND a.deleted_at IS NULL
        AND n.code IN ('FABRICATED','FAB_PARTS','PLATE_PART','PROFILE_PART','FAB_ASSY','FAB_STRUCT','FASTENERS')
      ORDER BY FIELD(n.code,'FAB_PARTS','PLATE_PART','PROFILE_PART','FAB_ASSY','FAB_STRUCT','FASTENERS'), s.code`, [c.companyId],
  );
  say(`\n  rules on the new tree (${as.length}):`);
  for (const a of as) say(`    ${a.node.padEnd(14)} ${a.spec.padEnd(15)} ${a.value_rule.padEnd(11)}${a.is_required ? 'required ' : '         '}${a.formula ?? ''}`);

  const [vals] = await conn.query(
    `SELECT n.code AS node, s.code AS spec, v.value_number, o.value AS option_value
       FROM cf_spec_values v JOIN cf_specifications s ON s.id = v.specification_id
       JOIN cf_classification_nodes n ON n.id = v.subject_id
       LEFT JOIN cf_spec_options o ON o.id = v.option_id
      WHERE v.company_id = ? AND v.subject_type = 'classification' AND v.deleted_at IS NULL
        AND n.code IN ('FAB_PARTS') ORDER BY s.code`, [c.companyId],
  );
  say(`  values on FAB_PARTS: ` + vals.map((v) => `${v.spec}=${v.option_value ?? Number(v.value_number)}`).join('  '));

  const [sc] = await conn.query(
    `SELECT s.code, s.entity_type, s.target_field, s.seq_scope,
            (SELECT GROUP_CONCAT(CONCAT(g.segment_type, ':', COALESCE(g.literal_text, g.token_key, g.format, '')) ORDER BY g.sort_order SEPARATOR ' ')
               FROM cf_code_scheme_segments g WHERE g.scheme_id = s.id AND g.deleted_at IS NULL) AS pattern,
            -- COALESCE, or a condition whose value is not a classification id
            -- (placement eq line) would CONCAT to NULL and read as "no condition".
            (SELECT GROUP_CONCAT(CONCAT(cd.token_key, ' ', cd.operator, ' ', COALESCE(n.code, cd.value)) SEPARATOR ', ')
               FROM cf_code_scheme_conditions cd LEFT JOIN cf_classification_nodes n ON n.id = cd.value
              WHERE cd.scheme_id = s.id AND cd.deleted_at IS NULL) AS cond
       FROM cf_code_schemes s WHERE s.company_id = ? AND s.deleted_at IS NULL ORDER BY s.code`, [c.companyId],
  );
  say(`\n  coding rules (${sc.length}):`);
  for (const s of sc) say(`    ${s.code.padEnd(16)} ${s.entity_type}/${s.target_field} seq=${s.seq_scope}  when ${s.cond}\n        ${s.pattern}`);
  return { nodes, specs: sp, schemes: sc };
}

/** Reports an item's resolved specs, and checks its code and its weight. */
async function checkItem(conn, c, master, { label, wantCode, wantWeight, tol }) {
  const r = await resolution.resolve(conn, c.companyId, { master });
  say(`  code    = ${master.code}   (want ${wantCode})   ${master.code === wantCode ? 'OK' : 'MISMATCH'}`);
  for (const s of r.specs) {
    if (s.captureAt !== 'item' || !s.applicable) continue;
    const v = s.value ? (s.value.display ?? s.value.raw) : null;
    say(`      ${s.spec.code.padEnd(14)} = ${fmt(v).padEnd(14)} rule=${s.rule.valueRule.padEnd(10)} from ${s.definedAt.code}`);
  }
  const w = r.specs.find((s) => s.spec.code === 'WEIGHT');
  const got = w?.value ? Number(w.value.raw) : null;
  const weightOk = got !== null && Math.abs(got - wantWeight) <= tol;
  say(`  WEIGHT  = ${got} kg   (want ${wantWeight} +/- ${tol})   ${weightOk ? 'OK' : 'MISMATCH'}`);
  if (master.code !== wantCode || !weightOk) throw new Error(`${label}: probe failed — see above.`);
}

/**
 * Proof that a branch of the tree works end to end: one throwaway item, created
 * for real through the services and then rolled back. Its code must come out of
 * the coding rule and its weight out of the formula on its Variant.
 *
 * If the catalog already holds the item this would create, that one is checked
 * where it stands instead. It proves the same thing, and creating a second is
 * not possible anyway: cf_master_records is uniquely indexed on
 * (company_id, code_active), which a rolled-back transaction does not get past.
 * Without this, running the setup again after cf_bridge_catalog.mjs would fail.
 */
async function probeOne(conn, c, { label, classificationId, name, shortName, values, wantCode, wantWeight, tol }) {
  say(`\n-- ${label}`);
  const [[existing]] = await conn.query(
    `SELECT * FROM cf_master_records WHERE company_id = ? AND code = ? AND record_kind = 'item' AND deleted_at IS NULL`,
    [c.companyId, wantCode],
  );
  if (existing) {
    say(`  the catalog already holds ${wantCode} (#${existing.id}) — checked in place, nothing created.`);
    await checkItem(conn, c, existing, { label, wantCode, wantWeight, tol });
    return;
  }
  await conn.beginTransaction();
  try {
    const item = await recs.createItem(conn, c, {
      classificationId, name, shortName,
      uom: 'nos', trackedBy: 'batch', sourcing: 'make', status: 'draft', values,
    });
    await recs.setStatus(conn, c, item.id, 'active');
    const [[m]] = await conn.query('SELECT * FROM cf_master_records WHERE id = ?', [item.id]);
    await checkItem(conn, c, m, { label, wantCode, wantWeight, tol });
    say('  passed; rolling back so nothing is left behind.');
  } finally {
    await conn.rollback();
  }
}

async function probe(conn, c, node) {
  say('\n================ PROBES (each rolled back) ================');

  // A plate: weight is the rectangle, code is thickness x length x width.
  // Grade and impact class come from the data module, never typed here: the
  // code is built from the grade, so the two must not be able to drift apart.
  await probeOne(conn, c, {
    label: `plate part, CFFB-PLATEPART + PLATE_WEIGHT`,
    classificationId: node.PLATE_PART,
    name: `__probe Top flange 25 x 11650 x 500 ${DATA.GRADE}`,
    shortName: 'TF',
    values: [
      { specCode: 'THICKNESS', value: 25 }, { specCode: 'LENGTH', value: 11650 }, { specCode: 'WIDTH', value: 500 },
      { specCode: 'GRADE', value: DATA.GRADE }, { specCode: 'IMPACT_CLASS', value: DATA.IMPACT_CLASS },
      { specCode: 'PART_FUNCTION', value: 'TOP_FLANGE' },
    ],
    wantCode: `TF-25X11650X500-${DATA.GRADE}`,
    wantWeight: 1143.16,
    tol: 0.01,
  });

  // A rolled section: weight is section area x length x density, NOT a
  // rectangle. The size is a real ISA 200x200x25 out of the raw-material
  // catalog (section area 9375 mm2), cut to 2400 — so the answer can be checked
  // by hand: 9375 x 2400 x 7850 / 1e9 = 176.625 kg.
  const isa = { depth: 200, width: 200, thk: 25, len: 2400, area: 9375 };
  const isaKg = Number((isa.area * isa.len * DATA.DENSITY / 1e9).toFixed(6));
  // PART_FUNCTION is required on every fabricated part. This job has no profile
  // parts at all, so the probe takes the first option on the list; the row is
  // rolled back either way.
  const anyFunction = DATA.PART_FUNCTION_OPTIONS[0].value;
  await probeOne(conn, c, {
    label: `profile part, CFFB-PROFILEPART + SECTION_WEIGHT  (${isa.area} x ${isa.len} x ${DATA.DENSITY} / 1e9 = ${isaKg} kg)`,
    classificationId: node.PROFILE_PART,
    name: `__probe Angle ISA 200 x 200 x 25 x ${isa.len} ${DATA.GRADE}`,
    shortName: 'ISA',
    values: [
      { specCode: 'DEPTH', value: isa.depth }, { specCode: 'WIDTH', value: isa.width },
      { specCode: 'THICKNESS', value: isa.thk }, { specCode: 'LENGTH', value: isa.len },
      { specCode: 'SECTION_AREA', value: isa.area },
      { specCode: 'GRADE', value: DATA.GRADE }, { specCode: 'IMPACT_CLASS', value: DATA.IMPACT_CLASS },
      { specCode: 'PART_FUNCTION', value: anyFunction },
    ],
    wantCode: `ISA-${isa.depth}X${isa.width}X${isa.thk}X${isa.len}-${DATA.GRADE}`,
    wantWeight: isaKg,
    tol: 0.001,
  });

  const [[left]] = await conn.query(
    `SELECT COUNT(*) AS n FROM cf_master_records WHERE company_id = ? AND name LIKE '\\_\\_probe%'`, [c.companyId],
  );
  say(`\n  throwaway rows still in the database after rollback: ${left.n}`);

  await probeOrderCode(conn, c);
  await probeInstantiation(conn, c);
}

/**
 * The question the backfill does not answer: is the parent already coded when
 * its child is born? The backfill codes parents first by construction, but at
 * instantiation the child is created by the same call that created the parent.
 *
 * instantiateTemplate creates the parent, and createItem generates its code
 * before returning (masterRecordService.finishCreate); only then is the Custom
 * BOM built and the children instantiated into it. So parent.code is there.
 * This proves it rather than reading it: add a template definition to a real
 * Custom BOM, which mints a temporary item exactly as an order does, and look
 * at the code it is born with. Rolled back.
 */
async function probeInstantiation(conn, c) {
  say('\n-- a NEW temporary item, minted the way an order mints one (rolled back)');
  const [[parent]] = await conn.query(
    `SELECT m.id, m.code FROM cf_master_records m
       JOIN cf_item_details i ON i.master_id = m.id AND i.deleted_at IS NULL
      WHERE m.company_id = ? AND i.item_type = 'temporary' AND m.code IS NOT NULL AND m.deleted_at IS NULL
      ORDER BY m.id LIMIT 1`, [c.companyId],
  );
  const [[tpl]] = await conn.query(
    `SELECT m.id, m.code, m.short_name, m.status FROM cf_master_records m
       JOIN cf_definition_details d ON d.master_id = m.id AND d.deleted_at IS NULL AND d.definition_type = 'template'
      WHERE m.company_id = ? AND m.status = 'active' AND m.deleted_at IS NULL ORDER BY m.id LIMIT 1`, [c.companyId],
  );
  if (!parent || !tpl) { say('  no coded temporary item and active template to try this on — skipped.'); return; }

  await conn.beginTransaction();
  try {
    const before = new Set((await bomService.getBom(conn, c.companyId, parent.id)).lines.map((l) => l.child.id));
    await bomService.addLine(conn, c, parent.id, { childId: tpl.id, quantity: 1 });
    const after = (await bomService.getBom(conn, c.companyId, parent.id)).lines.filter((l) => !before.has(l.child.id));
    if (!after.length) throw new Error('Adding the template made no new line.');
    for (const l of after) {
      say(`  ${tpl.code} added under ${parent.code} -> new temporary item #${l.child.id} code ${l.child.code ?? '(none)'} at position ${l.position}`);
      if (!l.child.code) throw new Error(`A temporary item was born without a code — parent.code did not resolve at instantiation time.`);
      if (!l.child.code.startsWith(`${parent.code}-`)) throw new Error(`${l.child.code} does not read from its parent ${parent.code}.`);
    }
    say('  parent.code and position both resolved at birth. Rolling back.');
  } catch (e) {
    say(`  could not mint one: ${e.message}`);
    throw e;
  } finally {
    await conn.rollback();
  }
}

/**
 * Temporary items an order already minted before a rule existed for them: they
 * carry no code at all. Nothing hand-written here — the code comes from the
 * generator, exactly as it would at instantiation, and goes on through
 * masterRecordService.updateRecord, which allows a code only while the record
 * is still a draft.
 *
 * Parents first: a component's code reads its parent's, so an uncoded parent
 * would leave a hole. Rather than assume a depth, this keeps passing over the
 * list until a pass codes nothing new — which also settles any nesting deeper
 * than this job's two levels.
 */
async function backfillTemporaryCodes(conn, c) {
  say('\n================ TEMPORARY ITEM CODES ================');
  const uncoded = async () => {
    const [rows] = await conn.query(
      `SELECT m.id, m.name, m.status, i.owner_order_line_id, o.code AS order_code
         FROM cf_master_records m
         JOIN cf_item_details i ON i.master_id = m.id AND i.deleted_at IS NULL
         LEFT JOIN cf_sales_order_lines ol ON ol.id = i.owner_order_line_id
         LEFT JOIN cf_sales_orders o ON o.id = ol.order_id
        WHERE m.company_id = ? AND m.record_kind = 'item' AND i.item_type = 'temporary'
          AND m.code IS NULL AND m.deleted_at IS NULL
        ORDER BY m.id`, [c.companyId],
    );
    return rows;
  };
  let todo = await uncoded();
  if (!todo.length) { say('  every temporary item already has a code — nothing to backfill.'); }

  let pass = 0;
  while (todo.length) {
    pass += 1;
    say(`  pass ${pass}: ${todo.length} without a code`);
    let progress = 0;
    for (const t of todo) {
      // Preview first: it never takes a running number and never writes.
      const peek = await codegenEngine.generate(conn, c.companyId, 'item', 'code', { entityId: t.id }, { consume: false });
      if (!peek) { say(`    #${t.id} ${t.name}: no coding rule applies.`); continue; }
      if (!peek.text) {
        say(`    #${t.id} ${t.name}: rule ${peek.schemeCode} cannot render yet — missing ${peek.missing.join(', ')}`);
        continue;
      }
      if (t.status !== 'draft') { say(`    #${t.id} would be ${peek.text} but it is ${t.status}; a code is fixed once a record leaves draft.`); continue; }
      const real = await codegenEngine.generate(conn, c.companyId, 'item', 'code', { entityId: t.id }, { consume: true });
      await recs.updateRecord(conn, c, t.id, { code: real.text });
      say(`    #${t.id} -> ${real.text}   by rule ${real.schemeCode}`);
      made('temporary item code');
      progress += 1;
    }
    todo = await uncoded();
    if (!progress) { say(`  ${todo.length} still without a code and this pass changed nothing — stopping.`); break; }
  }

  const [all] = await conn.query(
    `SELECT m.id, m.code, m.name, m.status, n.code AS variant, l.position AS bom_position, pm.code AS parent_code
       FROM cf_master_records m
       JOIN cf_item_details i ON i.master_id = m.id AND i.deleted_at IS NULL
       JOIN cf_classification_nodes n ON n.id = m.classification_id
       LEFT JOIN cf_bom_lines l ON l.child_id = m.id AND l.deleted_at IS NULL
       LEFT JOIN cf_boms b ON b.id = l.bom_id AND b.bom_type = 'custom'
       LEFT JOIN cf_master_records pm ON pm.id = b.parent_id
      WHERE m.company_id = ? AND m.record_kind = 'item' AND i.item_type = 'temporary' AND m.deleted_at IS NULL
      ORDER BY m.id`, [c.companyId],
  );
  say(`\n  every temporary item in company ${c.companyId} (${all.length}):`);
  for (const t of all) {
    say(`    #${t.id}  ${String(t.code ?? '(none)').padEnd(34)} ${t.variant.padEnd(14)} [${t.status}]  in ${t.parent_code ?? '(on the order line)'} at position ${t.bom_position ?? '-'}   ${t.name}`);
  }
  const still = all.filter((t) => !t.code);
  if (still.length) throw new Error(`${still.length} temporary item(s) still have no code: ${still.map((t) => `#${t.id}`).join(', ')}`);
}

/**
 * The order number, through the preview path: `consume: false` peeks at the
 * running number instead of taking it, so nothing is written and no number is
 * burned. Nothing to roll back either — this creates no order.
 */
async function probeOrderCode(conn, c) {
  say('\n-- sales order number, CFSO-ORDER (preview only — no order, no number taken)');
  const [[scheme]] = await conn.query(
    `SELECT id FROM cf_code_schemes WHERE company_id = ? AND code = 'CFSO-ORDER' AND deleted_at IS NULL`, [c.companyId],
  );
  const seqRows = async () => {
    const [rows] = await conn.query(
      'SELECT seq_key, next_value FROM cf_code_sequences WHERE company_id = ? AND scheme_id = ?', [c.companyId, scheme?.id ?? 0],
    );
    return rows;
  };
  const before = await seqRows();

  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const today = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;

  for (const orderType of ['customer', 'stock']) {
    const g = await codegenEngine.generate(conn, c.companyId, 'sales_order', 'code',
      { draft: { orderType, customerId: null } }, { consume: false });
    const want = `SO-${today}-${String(g?.number ?? 1).padStart(4, '0')}`;
    say(`  ${orderType.padEnd(8)} -> ${g?.text}   by rule ${g?.schemeCode}   (want ${want})   ${g?.text === want ? 'OK' : 'MISMATCH'}`);
    if (g?.text !== want) throw new Error(`Order number preview gave ${g?.text}, expected ${want}.`);
    if (!/^SO-\d{8}-\d{4}$/.test(g.text)) throw new Error(`Order number ${g.text} is not SO-YYYYMMDD-NNNN.`);
  }
  const after = await seqRows();
  say(`  sequence rows before ${JSON.stringify(before)} / after ${JSON.stringify(after)} — a preview takes no number.`);
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('The preview moved the running number.');

  // The KEPL order keeps the number it was given by hand; the rule is for new ones.
  const [orders] = await conn.query(
    `SELECT code, status FROM cf_sales_orders WHERE company_id = ? AND deleted_at IS NULL ORDER BY id`, [c.companyId],
  );
  say(`  sales orders already here (untouched): ${orders.length ? orders.map((o) => `${o.code} [${o.status}]`).join(', ') : 'none'}`);
}

// ---------------------------------------------------------------------------

const conn = await pool.getConnection();
try {
  const [[company]] = await conn.query('SELECT id, name FROM companies WHERE id = ?', [COMPANY]);
  if (!company) throw new Error(`No company ${COMPANY}.`);
  const [[user]] = await conn.query('SELECT id FROM users WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [COMPANY]);
  const c = { companyId: COMPANY, userId: user?.id ?? null };
  say(`cf_erp bridge setup -> company ${COMPANY} (${company.name}), acting as user ${c.userId}`);

  let built = null;
  if (!VERIFY_ONLY) {
    say('\n== setup ==');
    await conn.beginTransaction();
    try { built = await setup(conn, c); await conn.commit(); } catch (e) { await conn.rollback(); throw e; }
    say('  created:', JSON.stringify(tally.created));
    say('  reused :', JSON.stringify(tally.reused));

    // Separate transaction: the schemes above must be committed before the
    // generator can select them, and a backfill that fails must not take the
    // setup down with it.
    await conn.beginTransaction();
    try { await backfillTemporaryCodes(conn, c); await conn.commit(); } catch (e) { await conn.rollback(); throw e; }
  }

  const seen = await verify(conn, c);
  const nodeId = Object.fromEntries(seen.nodes.map((n) => [n.code, n.id]));
  await probe(conn, c, built?.node ?? nodeId);
  say('\ndone.');
} finally {
  conn.release();
  await pool.end();
}
