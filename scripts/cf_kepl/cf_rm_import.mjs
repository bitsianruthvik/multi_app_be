/**
 * cf_rm_import.mjs — brings fab_erp's raw materials into cf_erp as SPECIFICATIONS.
 *
 * Source: fab_rm_extract.tsv (1,427 rows pulled read-only from fab_erp prod, company 30005).
 * Target: cf_erp on LOCAL MySQL, company CF_IMPORT_COMPANY (default 2).
 *
 * Everything is written through the cf_erp services, so the rules are enforced
 * and cf_spec_value_history is written. No raw INSERTs into cf_* tables.
 *
 * Re-runnable. The natural key is the master record's NAME — the source name
 * kept verbatim. It is unique across all 1,427 source rows (checked), it is the
 * one field the import copies rather than derives, and unlike the generated code
 * it exists even for a row too incomplete to be coded. Matching on the generated
 * code would re-create those rows on every run.
 *
 *   cd multi_app_be && node <this file>            # import + verify
 *   CF_IMPORT_COMPANY=2 node <this file>
 *   node <this file> --verify-only                 # no writes, just the checks
 */
import path from 'path';
import fs from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const TSV = path.join(HERE, 'fab_rm_extract.tsv');

const { pool } = await imp('db.js');
// These scripts hand-roll their transactions, so they do not get withTransaction's
// per-transaction memo for classification reads. Attaching it here cuts the same three
// tree rows from 8 reads per item to 2 — worth ~0.3 s an item over a remote link.
const { attachNodeCache, detachNodeCache } = await imp('apps/cf_erp/lib/db.js');
await imp('apps/cf_erp/services/codegenProvider.js');          // registers the 'item' entity
const cls = await imp('apps/cf_erp/services/classificationService.js');
const specs = await imp('apps/cf_erp/services/specificationService.js');
const formulas = await imp('apps/cf_erp/services/formulaService.js');
const rules = await imp('apps/cf_erp/services/assignmentService.js');
const values = await imp('apps/cf_erp/services/valueService.js');
const recs = await imp('apps/cf_erp/services/masterRecordService.js');
const codegen = await imp('apps/cf_erp/modules/codegen/service.js');
const resolution = await imp('apps/cf_erp/services/resolutionService.js');

const VERIFY_ONLY = process.argv.includes('--verify-only');
const COMPANY = Number(process.env.CF_IMPORT_COMPANY ?? 2);
const CHUNK = 100;
// Smoke-testing only: import just the first N source rows.
const LIMIT = process.env.CF_IMPORT_LIMIT ? Number(process.env.CF_IMPORT_LIMIT) : null;

const tally = { created: {}, reused: {} };
const bump = (bag, k, n = 1) => { bag[k] = (bag[k] ?? 0) + n; };
const made = (k, n = 1) => bump(tally.created, k, n);
const kept = (k, n = 1) => bump(tally.reused, k, n);
const say = (...a) => console.log(...a);

// ---------------------------------------------------------------------------
// Source
// ---------------------------------------------------------------------------

function readSource() {
  const lines = fs.readFileSync(TSV, 'utf8').split(/\r?\n/).filter((l) => l.length);
  const head = lines[0].split('\t');
  return lines.slice(1).map((l) => {
    const cells = l.split('\t');
    return Object.fromEntries(head.map((h, i) => [h, cells[i] === 'NULL' || cells[i] === undefined ? null : cells[i]]));
  });
}

/**
 * The short name comes from the first word of the source name — the profile
 * designation. Anything else is reported, never guessed: giving "Wide Flange"
 * or "ISMC" a short name of our own invention would put a made-up designation
 * into every code built from it.
 */
const SHORT_BY_TOKEN = {
  ISA: 'ISA', ISMB: 'ISMB', ISLB: 'ISLB', ISHB: 'ISHB', ISJB: 'ISJB', UB: 'UB', MS: 'PL', Channel: 'CHAN',
  // "Wide Flange 300 x 200 x 7.4 x 12000" — a wide-flange beam, WB in Indian
  // practice. Every one of these rows has all four dimensions; only the name
  // for it was missing.
  Wide: 'WB',
};
const GROUP_BY_SHORT = {
  PL: 'PLATE', ISA: 'ANGLE', ISMB: 'BEAM', ISLB: 'BEAM', ISHB: 'BEAM', ISJB: 'BEAM', UB: 'BEAM', WB: 'BEAM', CHAN: 'CHANNEL',
};
const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

/** "E350 BO" -> { grade: 'E350', impact: 'BO' }. */
function splitGrade(raw) {
  if (!raw) return { grade: null, impact: null };
  const parts = String(raw).trim().split(/\s+/);
  return { grade: parts[0] ?? null, impact: parts[1] ?? null };
}

function classifyRow(r) {
  const token = String(r.name ?? '').trim().split(/[\s/,-]+/)[0];
  const shortName = SHORT_BY_TOKEN[token] ?? null;
  if (!shortName) return { ok: false, reason: `first word "${token}" is not a profile we know` };
  const { grade, impact } = splitGrade(r.grade);
  const problems = [];
  if (!grade) problems.push('no grade');
  if (!impact) problems.push('no impact class');
  const uomRaw = String(r.unit ?? 'nos').trim().toLowerCase();
  const uom = ['nos', 'pcs', 'pc'].includes(uomRaw) ? 'nos' : uomRaw;
  return {
    ok: true,
    shortName,
    group: GROUP_BY_SHORT[shortName],
    grade,
    impact,
    uom,
    problems,
    dims: {
      THICKNESS: num(r.thickness), WIDTH: num(r.width), LENGTH: num(r.len),
      DEPTH: num(r.depth), SECTION_AREA: num(r.section_area_mm2),
    },
  };
}

// ---------------------------------------------------------------------------
// Setup — reuse by code, create only what is missing
// ---------------------------------------------------------------------------

async function ensureNode(db, c, { code, name, parentId = null, description = null }) {
  const [[row]] = await db.query(
    'SELECT id, depth FROM cf_classification_nodes WHERE company_id = ? AND code = ? AND deleted_at IS NULL', [c.companyId, code],
  );
  if (row) { kept('classification node'); return row.id; }
  const node = await cls.createNode(db, c, { code, name, parentId, description });
  made('classification node');
  return node.id;
}

async function ensureSpec(db, c, def) {
  const [[row]] = await db.query(
    'SELECT id, data_type FROM cf_specifications WHERE company_id = ? AND code = ? AND deleted_at IS NULL', [c.companyId, def.code],
  );
  let id;
  if (row) { kept('specification'); id = row.id; } else {
    const s = await specs.createSpec(db, c, def);
    made('specification');
    made('spec option', (def.options ?? []).length);
    return s.id;
  }
  // Reused spec: add only the options it is missing.
  for (const o of def.options ?? []) {
    const [[have]] = await db.query(
      'SELECT id FROM cf_spec_options WHERE company_id = ? AND specification_id = ? AND LOWER(value) = ? AND deleted_at IS NULL',
      [c.companyId, id, String(o.value).toLowerCase()],
    );
    if (have) kept('spec option');
    else { await specs.addOption(db, c, id, o); made('spec option'); }
  }
  return id;
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

/** A default/fixed value on a classification node — written only when it differs. */
async function ensureNodeValue(db, c, nodeId, specCode, value) {
  const [[row]] = await db.query(
    `SELECT v.value_number, v.value_bool, o.value AS option_value
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
        : String(row.option_value ?? '').toLowerCase() === String(value).toLowerCase();
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

async function setup(db, c) {
  // --- 1. Classification -------------------------------------------------
  const steel = await ensureNode(db, c, { code: 'STEEL', name: 'Steel', description: 'Structural steel bought as stock lengths and plates.' });
  const node = { steel };
  node.plates = await ensureNode(db, c, { code: 'PLATES', name: 'Plates', parentId: steel });
  node.angles = await ensureNode(db, c, { code: 'ANGLES', name: 'Angles', parentId: steel });
  node.beams = await ensureNode(db, c, { code: 'BEAMS', name: 'Beams', parentId: steel });
  node.channels = await ensureNode(db, c, { code: 'CHANNELS', name: 'Channels', parentId: steel });
  // One Variant per subfamily for what is bought, plus Cut plate for what nesting makes.
  const variant = {
    PLATE: await ensureNode(db, c, { code: 'PLATE', name: 'Plate', parentId: node.plates, description: 'A plate bought whole, to be cut.' }),
    CUT_PLATE: await ensureNode(db, c, { code: 'CUT_PLATE', name: 'Cut plate', parentId: node.plates, description: 'A blank nesting cuts out of a plate.' }),
    ANGLE: await ensureNode(db, c, { code: 'ANGLE', name: 'Angle', parentId: node.angles }),
    BEAM: await ensureNode(db, c, { code: 'BEAM', name: 'Beam', parentId: node.beams }),
    CHANNEL: await ensureNode(db, c, { code: 'CHANNEL', name: 'Channel', parentId: node.channels }),
  };

  // --- 2. Specifications --------------------------------------------------
  const spec = {};
  const defs = [
    { code: 'THICKNESS', name: 'Thickness', dataType: 'number', measurementType: 'LENGTH', defaultUom: 'mm', decimals: 2 },
    { code: 'WIDTH', name: 'Width', dataType: 'number', measurementType: 'LENGTH', defaultUom: 'mm', decimals: 2 },
    { code: 'LENGTH', name: 'Length', dataType: 'number', measurementType: 'LENGTH', defaultUom: 'mm', decimals: 2 },
    { code: 'DEPTH', name: 'Depth', dataType: 'number', measurementType: 'LENGTH', defaultUom: 'mm', decimals: 2 },
    { code: 'SECTION_AREA', name: 'Section area', dataType: 'number', measurementType: 'AREA', defaultUom: 'mm2', decimals: 3,
      description: 'Area of the rolled cross-section. Weight of a profile is this times length times density — thickness x width is wrong for an L, I or C section.' },
    { code: 'DENSITY', name: 'Density', dataType: 'number', measurementType: 'DENSITY', defaultUom: 'kg/m3', decimals: 1 },
    { code: 'WEIGHT', name: 'Weight', dataType: 'number', measurementType: 'MASS', defaultUom: 'kg', decimals: 3 },
    { code: 'MATERIAL', name: 'Material', dataType: 'option', options: [{ value: 'MS', label: 'Mild steel' }] },
    { code: 'GRADE', name: 'Grade', dataType: 'option', options: [{ value: 'E250' }, { value: 'E350' }] },
    { code: 'IMPACT_CLASS', name: 'Impact class', dataType: 'option',
      options: [{ value: 'BO', label: 'BO — no impact test' }, { value: 'BR', label: 'BR — room-temperature impact test' }] },
    { code: 'NESTING', name: 'Cut to size', dataType: 'boolean',
      description: 'Whether this material is cut to size (nested) rather than used whole.' },
  ];
  for (const d of defs) spec[d.code] = await ensureSpec(db, c, d);

  // --- 3. Formulas --------------------------------------------------------
  const plateWeight = await ensureFormula(db, c, {
    code: 'PLATE_WEIGHT', name: 'Plate weight', expression: 'LENGTH * WIDTH * THICKNESS * DENSITY / 1e9',
  });
  const sectionWeight = await ensureFormula(db, c, {
    code: 'SECTION_WEIGHT', name: 'Section weight', expression: 'SECTION_AREA * LENGTH * DENSITY / 1e9',
    description: 'Weight of a rolled profile. Thickness x width would be wrong: an L-section is not a rectangle.',
  });

  // --- 4. Values the fixed rules read ------------------------------------
  // Set before the rules, so a Fixed rule never exists without its value.
  await ensureNodeValue(db, c, steel, 'DENSITY', 7850);
  await ensureNodeValue(db, c, steel, 'MATERIAL', 'MS');
  await ensureNodeValue(db, c, node.plates, 'NESTING', true);
  for (const n of [node.angles, node.beams, node.channels]) await ensureNodeValue(db, c, n, 'NESTING', false);
  // A cut plate is what nesting PRODUCES. Inheriting "cut to size" from Plates
  // would send the output back round for cutting again.
  await ensureNodeValue(db, c, variant.CUT_PLATE, 'NESTING', false);

  // --- 5. Assignments — each rule as high in the tree as it is true -------
  // Steel: true of every piece of steel, whatever its shape.
  await ensureRule(db, c, steel, spec.DENSITY, { valueRule: 'fixed', sortOrder: 90 });
  await ensureRule(db, c, steel, spec.MATERIAL, { valueRule: 'fixed', sortOrder: 91 });
  await ensureRule(db, c, steel, spec.GRADE, { valueRule: 'entered', isRequired: true, sortOrder: 10 });
  await ensureRule(db, c, steel, spec.IMPACT_CLASS, { valueRule: 'entered', isRequired: true, sortOrder: 11 });
  await ensureRule(db, c, steel, spec.LENGTH, { valueRule: 'entered', sortOrder: 22 });
  // Plates: a rectangle, so weight is the plate formula and nesting is what happens to it.
  await ensureRule(db, c, node.plates, spec.THICKNESS, { valueRule: 'entered', isRequired: true, sortOrder: 20 });
  await ensureRule(db, c, node.plates, spec.WIDTH, { valueRule: 'entered', isRequired: true, sortOrder: 21 });
  await ensureRule(db, c, node.plates, spec.WEIGHT, { valueRule: 'calculated', formulaId: plateWeight, sortOrder: 80 });
  await ensureRule(db, c, node.plates, spec.NESTING, { valueRule: 'fixed', sortOrder: 95 });
  // Profiles: a rolled cross-section, so weight comes from the section area.
  for (const n of [node.angles, node.beams, node.channels]) {
    await ensureRule(db, c, n, spec.THICKNESS, { valueRule: 'entered', sortOrder: 20 });
    await ensureRule(db, c, n, spec.WIDTH, { valueRule: 'entered', sortOrder: 21 });
    await ensureRule(db, c, n, spec.DEPTH, { valueRule: 'entered', sortOrder: 23 });
    await ensureRule(db, c, n, spec.SECTION_AREA, { valueRule: 'entered', sortOrder: 24 });
    await ensureRule(db, c, n, spec.WEIGHT, { valueRule: 'calculated', formulaId: sectionWeight, sortOrder: 80 });
    await ensureRule(db, c, n, spec.NESTING, { valueRule: 'fixed', sortOrder: 95 });
  }

  // --- 6. Coding rules ----------------------------------------------------
  // A steel item's code is its designation, its size and its grade:
  // ISA-200X200X25X6000-E350BO. Two rules, because a plate's size reads
  // thickness first and has no depth, while a profile's reads depth x width x
  // thickness. The Plates rule is deeper in the tree, so it wins for plates.
  await ensureScheme(db, c, {
    code: 'CFRM-STEEL', name: 'Steel profile code', entityType: 'item', targetField: 'code', seqScope: 'prefix', priority: 0,
    description: 'Short name, depth x width x thickness x length, grade and impact class.',
    conditions: [{ tokenKey: 'classification', operator: 'under', value: String(steel) }],
    segments: [
      tok('record.shortName'), lit('-'),
      tok('spec:DEPTH'), lit('X'), tok('spec:WIDTH'), lit('X'), tok('spec:THICKNESS'), lit('X'), tok('spec:LENGTH'),
      lit('-'), tok('spec:GRADE'), tok('spec:IMPACT_CLASS'),
    ],
  });
  await ensureScheme(db, c, {
    code: 'CFRM-PLATE', name: 'Steel plate code', entityType: 'item', targetField: 'code', seqScope: 'prefix', priority: 0,
    description: 'Short name, thickness x width x length, grade and impact class.',
    conditions: [{ tokenKey: 'classification', operator: 'under', value: String(node.plates) }],
    segments: [
      tok('record.shortName'), lit('-'),
      tok('spec:THICKNESS'), lit('X'), tok('spec:WIDTH'), lit('X'), tok('spec:LENGTH'),
      lit('-'), tok('spec:GRADE'), tok('spec:IMPACT_CLASS'),
    ],
  });

  return { node, variant, spec };
}

// ---------------------------------------------------------------------------
// The items
// ---------------------------------------------------------------------------

/** Only the values this item's classification actually has a rule for. */
function valuesFor(group, row) {
  const out = [
    { specCode: 'GRADE', value: row.grade },
    { specCode: 'IMPACT_CLASS', value: row.impact },
  ];
  const wanted = group === 'PLATE'
    ? ['THICKNESS', 'WIDTH', 'LENGTH']
    : ['THICKNESS', 'WIDTH', 'DEPTH', 'LENGTH', 'SECTION_AREA'];
  for (const code of wanted) {
    const v = row.dims[code];
    if (v !== null && Number.isFinite(v)) out.push({ specCode: code, value: v });
  }
  return out.filter((e) => e.value !== null && e.value !== undefined);
}

async function importItems(conn, c, variant, source) {
  const [existing] = await conn.query(
    `SELECT m.id, m.name, m.code, m.status FROM cf_master_records m
       JOIN cf_item_details i ON i.master_id = m.id AND i.deleted_at IS NULL
      WHERE m.company_id = ? AND m.record_kind = 'item' AND m.deleted_at IS NULL`,
    [c.companyId],
  );
  const byName = new Map(existing.map((r) => [r.name, r]));

  const report = { unclassified: [], noCode: [], failed: [], created: 0, skipped: 0, activated: 0, leftDraft: 0 };
  const work = [];
  for (const r of source) {
    const cl = classifyRow(r);
    if (!cl.ok) { report.unclassified.push({ src: r.code, name: r.name, why: cl.reason }); continue; }
    if (byName.has(r.name)) { report.skipped++; continue; }
    work.push({ src: r, cl });
  }

  for (let i = 0; i < work.length; i += CHUNK) {
    const slice = work.slice(i, i + CHUNK);
    await conn.beginTransaction();
    attachNodeCache(conn);
    try {
      for (const { src, cl } of slice) {
        let item;
        try {
          item = await recs.createItem(conn, c, {
            classificationId: variant[cl.group],
            name: src.name,
            shortName: cl.shortName,
            trackedBy: 'batch',
            sourcing: 'stock',
            uom: cl.uom,
            status: 'draft',
            values: valuesFor(cl.group, cl),
          });
        } catch (e) {
          report.failed.push({ src: src.code, name: src.name, why: [e.message, ...(e.problems ?? [])].join(' | ') });
          continue;
        }
        report.created++;
        try {
          await recs.setStatus(conn, c, item.id, 'active');
          report.activated++;
        } catch (e) {
          report.leftDraft++;
          report.noCode.push({ src: src.code, name: src.name, why: [e.message, ...(e.problems ?? [])].join(' | ') });
        }
      }
      detachNodeCache(conn); await conn.commit();
    } catch (e) {
      detachNodeCache(conn); await conn.rollback();
      throw e;
    }
    process.stdout.write(`\r  items ${Math.min(i + CHUNK, work.length)}/${work.length}   `);
  }
  if (work.length) process.stdout.write('\n');
  return report;
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

const fmt = (v) => (v === null || v === undefined ? 'NULL' : String(v));

async function showItem(conn, c, label, name) {
  const [[m]] = await conn.query(
    `SELECT m.*, i.item_type, i.tracked_by, i.uom, i.sourcing, i.source_definition_id, i.owner_order_line_id
       FROM cf_master_records m JOIN cf_item_details i ON i.master_id = m.id
      WHERE m.company_id = ? AND m.name = ? AND m.deleted_at IS NULL`, [c.companyId, name],
  );
  if (!m) { say(`  ${label}: NOT FOUND (${name})`); return null; }
  const r = await resolution.resolve(conn, c.companyId, { master: m });
  say(`  ${label}: ${m.code}   [${m.status}]  ${m.name}`);
  for (const s of r.specs) {
    if (s.captureAt !== 'item' || !s.applicable) continue;
    const v = s.value ? (s.value.display ?? s.value.raw) : null;
    say(`      ${s.spec.code.padEnd(13)} = ${fmt(v).padEnd(14)} rule=${s.rule.valueRule.padEnd(10)} defined at ${s.definedAt.level} (${s.definedAt.code})  from=${s.value?.from ?? '-'}  status=${s.status}`);
  }
  return { m, r };
}

async function verify(conn, c) {
  say('\n================ VERIFY ================');
  const [[counts]] = await conn.query(
    `SELECT
       (SELECT COUNT(*) FROM cf_classification_nodes WHERE company_id = ? AND deleted_at IS NULL) AS nodes,
       (SELECT COUNT(*) FROM cf_specifications      WHERE company_id = ? AND deleted_at IS NULL) AS specs,
       (SELECT COUNT(*) FROM cf_spec_options        WHERE company_id = ? AND deleted_at IS NULL) AS options,
       (SELECT COUNT(*) FROM cf_formulas            WHERE company_id = ? AND deleted_at IS NULL) AS formulas,
       (SELECT COUNT(*) FROM cf_spec_assignments    WHERE company_id = ? AND deleted_at IS NULL) AS assignments,
       (SELECT COUNT(*) FROM cf_code_schemes        WHERE company_id = ? AND deleted_at IS NULL) AS schemes,
       (SELECT COUNT(*) FROM cf_master_records      WHERE company_id = ? AND record_kind = 'item' AND deleted_at IS NULL) AS items,
       (SELECT COUNT(*) FROM cf_master_records      WHERE company_id = ? AND record_kind = 'item' AND status = 'active' AND deleted_at IS NULL) AS active_items,
       (SELECT COUNT(*) FROM cf_master_records      WHERE company_id = ? AND record_kind = 'item' AND status = 'draft' AND deleted_at IS NULL) AS draft_items,
       (SELECT COUNT(*) FROM cf_spec_values         WHERE company_id = ? AND deleted_at IS NULL) AS spec_values,
       (SELECT COUNT(*) FROM cf_spec_value_history  WHERE company_id = ?) AS history`,
    Array(11).fill(c.companyId),
  );
  say('  row counts now:', JSON.stringify(counts));

  const [byNode] = await conn.query(
    `SELECT n.code, COUNT(*) AS n FROM cf_master_records m
       JOIN cf_classification_nodes n ON n.id = m.classification_id
      WHERE m.company_id = ? AND m.record_kind = 'item' AND m.deleted_at IS NULL GROUP BY n.code ORDER BY n.code`,
    [c.companyId],
  );
  say('  items per Variant:', byNode.map((r) => `${r.code}=${r.n}`).join('  '));

  say('\n-- a plate: own values vs the family rule --');
  await showItem(conn, c, 'plate ', 'MS Plate 12 x 2500 x 12000 E350 BO');
  say('\n-- an angle: WEIGHT from SECTION_WEIGHT --');
  await showItem(conn, c, 'angle ', 'ISA 200 x 200 x 25 x 6000 E350 BO');
  say('\n-- a beam with no section area: WEIGHT must be NULL, not zero --');
  const beam = await showItem(conn, c, 'beam  ', 'ISMB 300 x 140 x 6.7 x 12000 E250 BO');

  if (beam) {
    const w = beam.r.specs.find((s) => s.spec.code === 'WEIGHT');
    const [[stored]] = await conn.query(
      `SELECT v.value_number FROM cf_spec_values v JOIN cf_specifications s ON s.id = v.specification_id
        WHERE v.company_id = ? AND s.code = 'WEIGHT' AND v.subject_type = 'master' AND v.subject_id = ? AND v.deleted_at IS NULL`,
      [c.companyId, beam.m.id],
    );
    say(`      resolved WEIGHT value = ${w?.value ? w.value.raw : 'null'} (status ${w?.status}); stored row = ${stored ? stored.value_number : 'none (NULL, not 0)'}`);
  }

  const [[zeroW]] = await conn.query(
    `SELECT COUNT(*) AS n FROM cf_spec_values v JOIN cf_specifications s ON s.id = v.specification_id
      WHERE v.company_id = ? AND s.code = 'WEIGHT' AND v.subject_type = 'master' AND v.value_number = 0 AND v.deleted_at IS NULL`,
    [c.companyId],
  );
  const [weighed] = await conn.query(
    `SELECT n.code, COUNT(*) AS n FROM cf_spec_values v
       JOIN cf_specifications s ON s.id = v.specification_id
       JOIN cf_master_records m ON m.id = v.subject_id AND m.company_id = v.company_id
       JOIN cf_classification_nodes n ON n.id = m.classification_id
      WHERE v.company_id = ? AND s.code = 'WEIGHT' AND v.subject_type = 'master' AND v.deleted_at IS NULL
      GROUP BY n.code ORDER BY n.code`, [c.companyId],
  );
  say(`\n  WEIGHT stored on: ${weighed.map((r) => `${r.code}=${r.n}`).join('  ') || '(none)'};  weights equal to zero: ${zeroW.n}`);

  const [dupes] = await conn.query(
    `SELECT code, COUNT(*) n FROM cf_master_records WHERE company_id = ? AND record_kind = 'item' AND code IS NOT NULL AND deleted_at IS NULL
      GROUP BY code HAVING n > 1`, [c.companyId],
  );
  say(`  duplicate item codes: ${dupes.length}`);
}

// ---------------------------------------------------------------------------

const conn = await pool.getConnection();
try {
  const [[company]] = await conn.query('SELECT id, name FROM companies WHERE id = ?', [COMPANY]);
  if (!company) throw new Error(`No company ${COMPANY}.`);
  const [[user]] = await conn.query(
    'SELECT id FROM users WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [COMPANY],
  );
  const c = { companyId: COMPANY, userId: user?.id ?? null };
  say(`cf_erp raw-material import -> company ${COMPANY} (${company.name}), acting as user ${c.userId}`);
  say(`source: ${TSV}`);

  if (!VERIFY_ONLY) {
    const source = LIMIT ? readSource().slice(0, LIMIT) : readSource();
    say(`\n== setup ==`);
    await conn.beginTransaction();
    attachNodeCache(conn);
    let built;
    try { built = await setup(conn, c); detachNodeCache(conn); await conn.commit(); } catch (e) { detachNodeCache(conn); await conn.rollback(); throw e; }
    say('  created:', JSON.stringify(tally.created), '\n  reused :', JSON.stringify(tally.reused));

    say(`\n== items (${source.length} source rows) ==`);
    const rep = await importItems(conn, c, built.variant, source);
    say(`  created ${rep.created}   activated ${rep.activated}   left draft ${rep.leftDraft}   already there ${rep.skipped}   not imported ${rep.unclassified.length}   failed ${rep.failed.length}`);

    if (rep.unclassified.length) {
      say(`\n-- ${rep.unclassified.length} rows NOT imported: no short name could be derived --`);
      const groups = new Map();
      for (const u of rep.unclassified) {
        const k = String(u.name).trim().split(/\s+/)[0];
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(u);
      }
      for (const [k, list] of groups) {
        say(`   "${k}" x${list.length}  (${list[0].why})`);
        for (const u of list) say(`      ${u.src.padEnd(12)} ${u.name}`);
      }
    }
    if (rep.noCode.length) {
      say(`\n-- ${rep.noCode.length} rows imported but LEFT DRAFT (the source has no value for something the rule needs) --`);
      for (const u of rep.noCode) say(`   ${u.src.padEnd(12)} ${u.name}\n        ${u.why}`);
    }
    if (rep.failed.length) {
      say(`\n-- ${rep.failed.length} rows FAILED outright --`);
      for (const u of rep.failed) say(`   ${u.src.padEnd(12)} ${u.name}\n        ${u.why}`);
    }
  }

  await verify(conn, c);
  say('\ndone.');
} finally {
  conn.release();
  await pool.end();
}
