/**
 * cf_bridge_defs.mjs — the reusable design, as definitions.
 *
 * Nothing here is specific to KEPL. A definition says WHAT a girder segment is
 * made of; it does not say how long. Sizes and counts belong to an order, so
 * every definition below is generic and carries no dimensions — only
 * PART_FUNCTION, which is true of the design itself.
 *
 * That works because activation only checks required values for ITEMS:
 * masterRecordService.setStatus tests `m.record_kind === 'item'` before it
 * looks at missingRequired. A definition may sit active with its dimensions
 * empty; the temporary item minted from it may not.
 *
 * The chain that makes it hang together is in resolutionService: a temporary
 * item resolves classification -> its definition -> itself, so a value set here
 * is inherited live by every instance, never copied.
 *
 *   cd multi_app_be && node scripts/cf_kepl/cf_bridge_defs.mjs
 */
import path from 'path';
import { pathToFileURL } from 'url';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
await imp('apps/cf_erp/services/codegenProvider.js');
const recs = await imp('apps/cf_erp/services/masterRecordService.js');
const sel = await imp('apps/cf_erp/services/selectionService.js');
const bom = await imp('apps/cf_erp/services/bomService.js');
const codegen = await imp('apps/cf_erp/modules/codegen/service.js');
const { attachNodeCache, detachNodeCache } = await imp('apps/cf_erp/lib/db.js');

const COMPANY = Number(process.env.CF_BRIDGE_COMPANY ?? 2);
const c = { companyId: COMPANY, userId: Number(process.env.CF_BRIDGE_USER ?? 22) };
const say = (...a) => console.log(...a);
const tally = { created: {}, reused: {} };
const bump = (bag, k) => { bag[k] = (bag[k] ?? 0) + 1; };

let conn;
const node = {}; const spec = {}; const def = {};

async function nodeId(code) {
  const [[r]] = await conn.query(
    'SELECT id FROM cf_classification_nodes WHERE company_id = ? AND code = ? AND deleted_at IS NULL', [COMPANY, code]);
  if (!r) throw new Error(`classification node ${code} is missing — run cf_bridge_setup.mjs first`);
  return r.id;
}
async function specId(code) {
  const [[r]] = await conn.query(
    'SELECT id FROM cf_specifications WHERE company_id = ? AND code = ? AND deleted_at IS NULL', [COMPANY, code]);
  if (!r) throw new Error(`specification ${code} is missing — run cf_bridge_setup.mjs first`);
  return r.id;
}
async function byName(name) {
  const [[r]] = await conn.query(
    'SELECT id, code, status FROM cf_master_records WHERE company_id = ? AND name = ? AND deleted_at IS NULL', [COMPANY, name]);
  return r ?? null;
}

/** Create-or-reuse a definition, keyed on its NAME (the code is generated). */
async function ensureDef(key, body) {
  const have = await byName(body.name);
  if (have) { bump(tally.reused, 'definition'); def[key] = have.id; return have.id; }
  const d = await recs.createDefinition(conn, c, body);
  bump(tally.created, 'definition');
  def[key] = d.id;
  return d.id;
}

async function activate(id) {
  const [[m]] = await conn.query('SELECT status, code, name FROM cf_master_records WHERE id = ?', [id]);
  if (m.status === 'active') { bump(tally.reused, 'already active'); return; }
  try { await recs.setStatus(conn, c, id, 'active'); bump(tally.created, 'activated'); }
  catch (e) { throw new Error(`could not activate ${m.code ?? m.name}: ${e.code} ${e.message} ${(e.problems ?? []).join(' | ')}`); }
}

/** Add a BOM line only if that role is not already on the parent. */
async function ensureLine(parentId, childId, { quantity = 1, role = null, lineNo = null } = {}) {
  const [[have]] = await conn.query(
    `SELECT l.id FROM cf_bom_lines l JOIN cf_boms b ON b.id = l.bom_id
      WHERE b.company_id = ? AND b.parent_id = ? AND b.deleted_at IS NULL AND l.deleted_at IS NULL
        AND l.child_id = ? AND (l.role <=> ?)`,
    [COMPANY, parentId, childId, role]);
  if (have) { bump(tally.reused, 'BOM line'); return have.id; }
  const l = await bom.addLine(conn, c, parentId, { childId, quantity, role, lineNo });
  bump(tally.created, 'BOM line');
  return l?.id ?? null;
}

async function activateBom(parentId) {
  const [[b]] = await conn.query(
    'SELECT id, status FROM cf_boms WHERE company_id = ? AND parent_id = ? AND deleted_at IS NULL', [COMPANY, parentId]);
  if (!b) return;
  if (b.status === 'active') { bump(tally.reused, 'BOM already active'); return; }
  await bom.setBomStatus(conn, c, parentId, 'active');
  bump(tally.created, 'BOM activated');
}

// --- the parts ---------------------------------------------------------------
/** One definition per thing a part can BE. Sizes are an order's business. */
const PARTS = [
  ['TF',  'Top flange',               'TOP_FLANGE'],
  ['WB',  'Web',                      'WEB'],
  ['BF',  'Bottom flange',            'BOTTOM_FLANGE'],
  ['BS',  'Bearing stiffener',        'BEARING_STIFFENER'],
  ['ES',  'End stiffener',            'END_STIFFENER'],
  ['IS',  'Intermediate stiffener',   'INTERMEDIATE_STIFFENER'],
  ['DTF', 'Diaphragm top flange',     'DIAPHRAGM_TOP_FLANGE'],
  ['DWB', 'Diaphragm web',            'DIAPHRAGM_WEB'],
  ['DBF', 'Diaphragm bottom flange',  'DIAPHRAGM_BOTTOM_FLANGE'],
  ['JS',  'Jacking stiffener',        'JACKING_STIFFENER'],
  ['PP',  'Pad plate',                'PAD_PLATE'],
  ['CP',  'Cover plate',              'COVER_PLATE'],
  ['SP',  'Splice plate',             'SPLICE_PLATE'],
];

/** An assembly's BOM: one line per POSITION, not one line per kind. Two
 *  intermediate stiffener lines because a segment carries a plain run and a
 *  drilled run at different sizes — and a size belongs to a line, so they
 *  cannot share one. The quantities here are placeholders the order overrides. */
const ASSEMBLIES = [
  { key: 'GS', name: 'Girder segment', short: 'GS', node: 'GIRDER_SEGMENT',
    description: 'A plate girder segment: flanges, web and its stiffeners. Lengths and stiffener counts come from the order.',
    lines: [
      ['TF', 1, 'Top flange'], ['WB', 1, 'Web'], ['BF', 1, 'Bottom flange'],
      ['BS', 1, 'Bearing stiffener'], ['ES', 1, 'End stiffener'],
      ['IS', 1, 'Intermediate stiffener — plain'], ['IS', 1, 'Intermediate stiffener — drilled'],
    ] },
  { key: 'EDIA', name: 'End diaphragm', short: 'EDIA', node: 'DIAPHRAGM',
    description: 'The diaphragm at a span end, with its jacking stiffener and pad plate.',
    lines: [['DTF', 1, 'Top flange'], ['DWB', 1, 'Web'], ['DBF', 1, 'Bottom flange'],
      ['JS', 1, 'Jacking stiffener'], ['PP', 1, 'Pad plate']] },
  { key: 'IDIA', name: 'Intermediate diaphragm', short: 'IDIA', node: 'DIAPHRAGM',
    description: 'A diaphragm between girders away from the ends. Two web plates: the panel and its diagonal.',
    lines: [['DTF', 1, 'Top flange'], ['DWB', 1, 'Web — panel'], ['DWB', 1, 'Web — diagonal'],
      ['DBF', 1, 'Bottom flange'], ['SP', 1, 'Inner side plate'], ['SP', 1, 'Inner flange plate'],
      ['SP', 1, 'Inner corner plate']] },
  { key: 'SPLC', name: 'Splice set', short: 'SPLC', node: 'SPLICE_SET',
    description: 'The cover plates that join two girder segments at a site joint.',
    lines: [['CP', 1, 'Web cover plate'], ['CP', 1, 'Top flange inner'], ['CP', 1, 'Top flange outer'],
      ['CP', 1, 'Bottom flange outer'], ['CP', 1, 'Bottom flange inner']] },
];

async function build() {
  for (const code of ['PLATE', 'CUT_PLATE', 'SHEAR_STUD', 'PLATE_PART', 'GIRDER_SEGMENT',
    'DIAPHRAGM', 'SPLICE_SET', 'GIRDER_LINE', 'BRIDGE_SPAN', 'FABRICATED']) node[code] = await nodeId(code);
  for (const code of ['PART_FUNCTION', 'NESTING', 'SPAN_LENGTH', 'SKEW_ANGLE']) spec[code] = await specId(code);

  // --- a coding rule for definitions OUTSIDE Fabricated ----------------------
  // CFFB-DEF only fires under Fabricated, so the two selections below would be
  // born codeless and could not be activated. No conditions, so it loses on
  // weight to any rule that has one.
  const [[haveScheme]] = await conn.query(
    "SELECT id FROM cf_code_schemes WHERE company_id = ? AND code = 'CFDEF-ANY' AND deleted_at IS NULL", [COMPANY]);
  if (haveScheme) bump(tally.reused, 'coding rule');
  else {
    await codegen.createScheme(conn, COMPANY, c.userId, {
      code: 'CFDEF-ANY', name: 'Definition code (fallback)', entityType: 'definition', targetField: 'code',
      seqScope: 'prefix', priority: 0,
      description: 'For a definition that no more specific rule reaches. Short name, then a number.',
      conditions: [],
      segments: [
        { segmentType: 'token', tokenKey: 'record.shortName', transform: 'upper', isRequired: true },
        { segmentType: 'literal', literalText: '-' },
        { segmentType: 'sequence', format: '000' },
      ],
    });
    bump(tally.created, 'coding rule');
  }

  // --- selections: what you may buy ----------------------------------------
  say('\n-- selections --');
  const platesId = await ensureDef('SEL_PLATE', {
    definitionType: 'selection', classificationId: node.PLATE, name: 'Plate (cut to size)', shortName: 'SELPL',
    selectionMode: 'spec_match', candidateClassificationId: node.PLATE,
    description: 'Any bought plate that is cut to size. The criterion is NESTING, so a plate added to the catalog tomorrow is a candidate without touching this.',
  });
  const [crit] = await conn.query(
    'SELECT id FROM cf_selection_criteria WHERE company_id = ? AND definition_id = ? AND deleted_at IS NULL', [COMPANY, platesId]);
  if (crit.length) bump(tally.reused, 'criterion');
  else { await sel.addCriterion(conn, c, platesId, { specificationId: spec.NESTING, operator: 'eq', value: true }); bump(tally.created, 'criterion'); }
  await activate(platesId);

  const studsId = await ensureDef('SEL_STUD', {
    definitionType: 'selection', classificationId: node.SHEAR_STUD, name: 'Shear stud', shortName: 'SELST',
    selectionMode: 'allowed_list', description: 'Which stud this job uses.',
  });
  const [[stud]] = await conn.query(
    `SELECT m.id FROM cf_master_records m WHERE m.company_id = ? AND m.classification_id = ?
       AND m.record_kind = 'item' AND m.deleted_at IS NULL LIMIT 1`, [COMPANY, node.SHEAR_STUD]);
  if (!stud) throw new Error('no shear stud catalog item — run cf_bridge_catalog.mjs first');
  const [allowed] = await conn.query(
    'SELECT id FROM cf_definition_allowed_items WHERE company_id = ? AND definition_id = ? AND deleted_at IS NULL', [COMPANY, studsId]);
  if (allowed.length) bump(tally.reused, 'allowed item');
  else { await sel.addAllowedItem(conn, c, studsId, { itemId: stud.id, isDefault: true }); bump(tally.created, 'allowed item'); }
  await activate(studsId);
  say(`   ${Object.keys(def).length} selection definitions`);
}

async function buildParts() {
  say('\n-- parts --');
  for (const [short, name, fn] of PARTS) {
    const id = await ensureDef(`P_${short}`, {
      definitionType: 'template', classificationId: node.PLATE_PART, name, shortName: short,
      description: `${name}. Thickness, length and width are set on the order.`,
      values: [{ specCode: 'PART_FUNCTION', value: fn }],
    });
    await activate(id);
  }
  say(`   ${PARTS.length} part definitions`);
}

async function buildAssemblies() {
  say('\n-- assemblies --');
  for (const a of ASSEMBLIES) {
    const id = await ensureDef(a.key, {
      definitionType: 'template', classificationId: node[a.node], name: a.name, shortName: a.short,
      description: a.description,
    });
    await activate(id);
    let lineNo = 0;
    for (const [part, qty, role] of a.lines) {
      lineNo += 10;
      await ensureLine(id, def[`P_${part}`], { quantity: qty, role, lineNo });
    }
    await activateBom(id);
    say(`   ${a.name}: ${a.lines.length} lines`);
  }
}

async function buildStructures() {
  say('\n-- structures --');
  // A girder line: five segment positions, each its own line because each
  // resolves to its own lengths. The splices and studs are identical, so they
  // are one line with a quantity.
  const lineId = await ensureDef('GLINE', {
    definitionType: 'template', classificationId: node.GIRDER_LINE, name: 'Girder line', shortName: 'GLINE',
    description: 'One girder end to end: its segments, the splices that join them, and the studs along its top flange.',
  });
  await activate(lineId);
  let n = 0;
  for (let i = 1; i <= 5; i += 1) { n += 10; await ensureLine(lineId, def.GS, { quantity: 1, role: `Segment ${i}`, lineNo: n }); }
  n += 10; await ensureLine(lineId, def.SPLC, { quantity: 4, role: 'Splice joints', lineNo: n });
  n += 10; await ensureLine(lineId, def.SEL_STUD, { quantity: 1, role: 'Shear studs', lineNo: n });
  await activateBom(lineId);
  say('   Girder line: 5 segment positions + splices + studs');

  const spanId = await ensureDef('SPAN', {
    definitionType: 'template', classificationId: node.BRIDGE_SPAN, name: 'Bridge span', shortName: 'SPAN',
    description: 'A span: its girder lines and the diaphragms between them. Span length, skew and girder count come from the order.',
  });
  await activate(spanId);
  n = 0;
  for (let i = 1; i <= 4; i += 1) { n += 10; await ensureLine(spanId, def.GLINE, { quantity: 1, role: `Girder G${i}`, lineNo: n }); }
  n += 10; await ensureLine(spanId, def.EDIA, { quantity: 1, role: 'End diaphragms', lineNo: n });
  n += 10; await ensureLine(spanId, def.IDIA, { quantity: 1, role: 'Intermediate diaphragms', lineNo: n });
  await activateBom(spanId);
  say('   Bridge span: 4 girder positions + both diaphragms');
}

async function verify() {
  say('\n-- what is there --');
  const [rows] = await conn.query(
    `SELECT m.code, m.name, m.status, d.definition_type AS kind, n.code AS node,
            (SELECT COUNT(*) FROM cf_bom_lines l JOIN cf_boms b ON b.id = l.bom_id
              WHERE b.parent_id = m.id AND b.deleted_at IS NULL AND l.deleted_at IS NULL) AS line_count,
            (SELECT b.status FROM cf_boms b WHERE b.parent_id = m.id AND b.deleted_at IS NULL LIMIT 1) AS bom_status
       FROM cf_master_records m
       JOIN cf_definition_details d ON d.master_id = m.id AND d.deleted_at IS NULL
       JOIN cf_classification_nodes n ON n.id = m.classification_id
      WHERE m.company_id = ? AND m.deleted_at IS NULL ORDER BY n.depth, n.code, m.code`, [COMPANY]);
  for (const r of rows) {
    say(`   ${String(r.code).padEnd(12)} ${String(r.kind).padEnd(10)} ${String(r.name).padEnd(26)} ${r.status}`
      + (Number(r.line_count) ? `  BOM ${r.line_count} lines, ${r.bom_status}` : ''));
  }
  const bad = rows.filter((r) => r.status !== 'active');
  const badBom = rows.filter((r) => Number(r.line_count) && r.bom_status !== 'active');
  say(`\n   ${rows.length} definitions · ${bad.length} not active · ${badBom.length} with a BOM that is not active`);
  if (bad.length || badBom.length) throw new Error('some definitions are not usable on an order yet');
}

try {
  conn = await pool.getConnection();
  await conn.beginTransaction();
  attachNodeCache(conn);
  say(`cf_erp bridge definitions -> company ${COMPANY}`);
  await build();
  await buildParts();
  await buildAssemblies();
  await buildStructures();
  detachNodeCache(conn);
  await conn.commit();
  attachNodeCache(conn);
  await verify();
  say(`\n  created: ${JSON.stringify(tally.created)}`);
  say(`  reused : ${JSON.stringify(tally.reused)}`);
  say('\ndone.');
} catch (e) {
  if (conn) await conn.rollback();
  console.error('\nFAILED:', e.code ?? '', e.message, e.problems ?? '');
  process.exitCode = 1;
} finally { if (conn) { detachNodeCache(conn); conn.release(); } await pool.end(); }
