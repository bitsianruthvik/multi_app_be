/**
 * cf_shop_import.mjs — the shop floor: the machine types, and the machines on them.
 *
 * Source: `fab_shop_extract.tsv`, a read-only extract of fab_erp's resource
 * types and resources — 11 types, 14 machines.
 *
 * CF has no machine-type table. A machine type IS a classification node: the
 * deepest level (Variant) of a Family whose scope is 'machine', which is
 * exactly what `requireMachineType` insists on before a machine may sit on it.
 * So importing the shop is importing a three-level tree and then 14 rows that
 * point into its leaves.
 *
 * WHY A SUBFAMILY LAYER AT ALL
 * fab_erp's 11 types are flat. CF's tree is three levels and a machine must sit
 * on the third, so a middle level is not optional — the only question is what
 * it means. It is grouped here by WHAT THE MACHINE DOES TO THE STEEL, because
 * that is the level the rest of cf_erp will want to reach:
 *   - a specification rule ("everything under Welding carries WIRE_DIAMETER",
 *     "everything under Cutting carries MAX_THICKNESS") hangs on a node and
 *     flows down, so the grouping decides how few rules are needed;
 *   - a coding rule condition tests `classification` with `under`, so a
 *     subfamily is the natural scope for "all welding machines are W-…";
 *   - `listMachines({ classificationId })` filters by subtree, so "show me the
 *     welders" is a subfamily click.
 * Grouping by anything else — vendor, year, cost centre — is an attribute of a
 * single machine, and attributes belong in specification values, not in a tree
 * that only has one middle level to spend.
 *
 * Three subfamilies hold one type each (Cutting, Drilling, Assembly). That is
 * deliberate and not a sign the grouping is too fine: they are the three places
 * this shop will grow next — an oxy-fuel table or a shear under Cutting, a
 * radial drill or a punch under Drilling, a fit-up bed under Assembly — and
 * each already wants its own specification rules, which is what a subfamily is
 * for. Merging them into a "Preparation" bucket would put a plasma table's cut
 * speed and a drill's spindle rating on one node, which is the thing the rule
 * engine then has to work around.
 *
 * Handling (the two cranes) is kept apart from the process machines on purpose:
 * no operation is ever timed on a crane, so a search for "what can make this
 * part" must never wander into one.
 *
 * FIVE TYPES THAT ARE NOT IN THE EXTRACT
 * StartHub's shop had no edge miller, no metallising booth and nothing at all
 * for inspection, so three of the fourteen operations the flows use had no
 * machine type to point at and were left unwired. They are added here, marked
 * `fromExtract: false`, and the verify counts them separately so the extract
 * stays the record of what fab_erp had:
 *   EDGEMILL  under Cutting    — edge/bevel preparation is metal removal along
 *                                an edge; thickness and feed speed are what it
 *                                carries, which is what Cutting already means.
 *   METALIZE  under Finishing  — thermal spray sits between the blast chamber
 *                                and the paint booth in the flow and in the
 *                                shop; same batch-by-what-fits-in-the-booth.
 *   QC-PART   under Inspection — three stations, not one, and not equipment.
 *   QC-WELD                      See below.
 *   QC-FINAL
 *
 * WHY QC HAS STATIONS AT ALL, AND WHY THREE
 * No QC operation runs on a machine. It is given one anyway because planning is
 * built on machines: a stage with no machine has no capacity and no shift, so
 * it is invisible to the planner and to the shift calendar, and a flow appears
 * to jump from weld straight to blast with the inspection in between costing
 * nothing and waiting for nobody.
 *
 * Three rather than one, because the reason for having them at all is capacity:
 *   - a single station would put dimensional checks on loose parts, NDT on
 *     welded assemblies and final sign-off on painted members into one queue,
 *     and the plan would show the shop inspection-bound when it is only
 *     NDT-bound;
 *   - they are rostered differently. Weld QC/NDT is a certified, often
 *     single-shift or visiting resource — the one inspection that really does
 *     constrain a girder shop — and it has to be schedulable on its own
 *     calendar, not averaged into a bench that also runs tape measures;
 *   - eligibility is set per machine type, so one shared type would say the
 *     part bench can do NDT. Three types let each QC operation resolve to
 *     exactly one, the same as every mechanical operation does.
 * Their codes keep a QC- prefix, against the rule below, precisely so the code
 * the generator mints reads QC-WELD-01 — a station, not a machine. The name and
 * the description say so as well, and so do the machines' own notes.
 *
 * Inspection is its own subfamily for the same reason Handling is: nothing
 * under it changes the steel, and "what can make this part" must not wander in.
 *
 * CODES
 * Machine codes are NOT taken from the source. They are minted by the code
 * generator, from a rule this script adds if it is missing (CFMC-ANY), which is
 * the pattern the machine provider itself documents: {classification.code}-{00},
 * numbered per type. Classification node codes are typed, because nothing
 * generates those — a node is created with the code it is given.
 *
 *   cd multi_app_be && node scripts/cf_kepl/cf_shop_import.mjs
 *   cd multi_app_be && node scripts/cf_kepl/cf_shop_import.mjs --verify-only
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const BE = process.cwd();
const HERE = path.dirname(fileURLToPath(import.meta.url));
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
await imp('apps/cf_erp/services/codegenProvider.js');           // registers the 'machine' codegen entity
const cls = await imp('apps/cf_erp/services/classificationService.js');
const mach = await imp('apps/cf_erp/services/machineService.js');
const codegen = await imp('apps/cf_erp/modules/codegen/service.js');
const { attachNodeCache, detachNodeCache } = await imp('apps/cf_erp/lib/db.js');

const COMPANY = Number(process.env.CF_BRIDGE_COMPANY ?? 2);
const c = { companyId: COMPANY, userId: Number(process.env.CF_BRIDGE_USER ?? 22) };
const VERIFY_ONLY = process.argv.includes('--verify-only');
const SOURCE = path.join(HERE, 'fab_shop_extract.tsv');

const say = (...a) => console.log(...a);
const tally = { created: {}, reused: {} };
const notes = [];
const bump = (bag, k) => { bag[k] = (bag[k] ?? 0) + 1; };

let conn;

// ---------------------------------------------------------------------------
// The tree this import builds. Names come from the source; only the shape and
// the codes are decided here.
// ---------------------------------------------------------------------------

const FAMILY = {
  code: 'MACHINES',
  name: 'Machines',
  description: 'The shop floor. Everything below is a machine type; machines sit on the deepest level.',
};

/** Subfamily codes are prefixed MC- because "Cutting" and "Welding" are words an
 *  item family may want later; a classification code is unique across the whole
 *  company. Type codes are left bare because they are read out loud in every
 *  machine code the generator mints (SAW-01, not MC-SAW-01). */
const GROUPS = [
  { code: 'MC-CUTTING', name: 'Cutting', sortOrder: 10,
    description: 'Cuts plate and section to shape. Thickness and cut speed are what these carry.',
    types: ['RT-PLASMA', 'X-EDGEMILL'] },
  { code: 'MC-FORMING', name: 'Forming', sortOrder: 20,
    description: 'Bends and rolls plate without removing metal. Limited by thickness and by the length of the bed.',
    types: ['RT-ROLL', 'RT-BRAKE'] },
  { code: 'MC-DRILLING', name: 'Drilling', sortOrder: 30,
    description: 'Puts holes in flanges, webs and splice plates. Limited by hole size, pitch and gantry reach.',
    types: ['RT-DRILL'] },
  { code: 'MC-ASSEMBLY', name: 'Assembly', sortOrder: 40,
    description: 'Holds parts in position for fit-up before any weld is run. Limited by the size of the piece it can take, not by power.',
    types: ['RT-JIG'] },
  { code: 'MC-WELDING', name: 'Welding', sortOrder: 50,
    description: 'Joins the fitted parts. Process, wire and deposition rate are what these carry.',
    types: ['RT-SAW', 'RT-MIG'] },
  { code: 'MC-FINISHING', name: 'Finishing', sortOrder: 60,
    description: 'Surface treatment after fabrication: blast, metallise, then paint. Batch-sized by what fits in the chamber or booth.',
    types: ['RT-BLAST', 'X-METALIZE', 'RT-PAINT'] },
  { code: 'MC-HANDLING', name: 'Handling', sortOrder: 70,
    description: 'Lifts and moves work between the machines above. No operation is timed on one; they gate what the shop can move, by capacity.',
    types: ['RT-CRANE1', 'RT-CRANE2'] },
  { code: 'MC-INSPECTION', name: 'Inspection', sortOrder: 80,
    description: 'Where work is checked, not worked on. Nothing under here changes the steel and none of it is equipment: '
      + 'each is a station that exists so an inspection has capacity, a queue and a shift calendar the planner can see.',
    types: ['X-QC-PART', 'X-QC-WELD', 'X-QC-FINAL'] },
];

/** source resource-type code -> the classification code it becomes. The RT-
 *  prefix is fab_erp's word for "resource type", which CF does not have, so it
 *  is dropped. The two cranes are renamed to their capacity because CRANE1 and
 *  CRANE2 read as "the first crane" rather than "the 10-tonne one". */
const TYPE_CODE = {
  'RT-PLASMA': 'PLASMA',
  'RT-ROLL': 'ROLL',
  'RT-BRAKE': 'BRAKE',
  'RT-DRILL': 'DRILL',
  'RT-JIG': 'JIG',
  'RT-SAW': 'SAW',
  'RT-MIG': 'MIG',
  'RT-BLAST': 'BLAST',
  'RT-PAINT': 'PAINT',
  'RT-CRANE1': 'CRANE10',
  'RT-CRANE2': 'CRANE20',
};

const TYPE_NOTE = {
  'RT-PLASMA': 'CNC plasma table. The first cut every plate part sees.',
  'RT-ROLL': 'Rolls plate to a radius.',
  'RT-BRAKE': 'Press brake: folds plate along a line.',
  'RT-DRILL': 'CNC drill line for flange, web and splice holes.',
  'RT-JIG': 'Girder assembly jig: flanges and web held square for fit-up.',
  'RT-SAW': 'Submerged arc: the long web-to-flange fillets.',
  'RT-MIG': 'MIG station: stiffeners, cleats and everything the SAW cannot reach.',
  'RT-BLAST': 'Shot blast chamber: surface prepared before paint.',
  'RT-PAINT': 'Paint booth: primer and finish coats.',
  'RT-CRANE1': 'Overhead travelling crane, 10 tonne.',
  'RT-CRANE2': 'Overhead travelling crane, 20 tonne.',
};

/** What goes on a QC machine's own notes, so the answer is there on the machine
 *  and not only on its type. */
const stationNote = (what) =>
  `${what} This is not a machine and there is no equipment to look for: it is a capacity and a shift calendar, `
  + 'so that inspection can be planned and queued like any other stage. Give it the shift pattern of the people who do the checking.';

/**
 * The machine types this script adds that fab_erp never had, keyed X-… so a
 * reader can see at a glance which of a subfamily's types came from the extract
 * and which were decided here. Same shape as a source type: a code, a name, and
 * the machines that sit on it.
 *
 * Every one of these exists because an operation in the flows had nowhere to
 * point. `sortOrder` is given rather than derived so a new type can be slotted
 * between two that are already numbered (metallising belongs between blasting
 * and painting, which are 10 and 20).
 */
const EXTRA_TYPES = {
  'X-EDGEMILL': {
    code: 'EDGEMILL',
    name: 'Edge Milling & Bevelling Machine',
    sortOrder: 20,
    description: 'Mills the weld prep along a plate edge — the single or double bevel a full-penetration '
      + 'butt needs before fit-up. Limited by plate thickness, bevel angle and the length of the bed.',
    machines: [{ name: 'Edge Milling Machine #1' }],
  },
  'X-METALIZE': {
    code: 'METALIZE',
    name: 'Metallising Booth',
    sortOrder: 15,
    description: 'Thermal-spray booth: zinc or zinc-aluminium sprayed onto blasted steel before paint. '
      + 'Runs between the blast chamber and the paint booth and is batch-sized the same way.',
    machines: [{ name: 'Metallising Booth #1' }],
  },
  // The three QC stations. Not equipment — see the header. The note goes on the
  // machine as well as the type, because the machine is what a planner picks.
  'X-QC-PART': {
    code: 'QC-PART',
    name: 'Part QC Station (not a machine)',
    sortOrder: 10,
    description: 'A place, a person and a shift — no equipment. Dimensional check of loose parts after cutting, '
      + 'drilling and edge prep. It exists so part inspection has capacity and a shift calendar of its own.',
    machines: [{ name: 'Part QC Station #1', notes: stationNote('Dimensional inspection of loose parts.') }],
  },
  'X-QC-WELD': {
    code: 'QC-WELD',
    name: 'Weld QC / NDT Station (not a machine)',
    sortOrder: 20,
    description: 'A place, a person and a shift — no equipment. Visual, UT and MPI inspection of welded assemblies. '
      + 'Kept apart from the other two because NDT is a certified, separately rostered resource and is usually the '
      + 'inspection that actually constrains the shop; averaged into a shared bench it would disappear from the plan.',
    machines: [{ name: 'Weld QC / NDT Station #1', notes: stationNote('Weld inspection and NDT, by a certified inspector.') }],
  },
  'X-QC-FINAL': {
    code: 'QC-FINAL',
    name: 'Final QC Station (not a machine)',
    sortOrder: 30,
    description: 'A place, a person and a shift — no equipment. The last check on a finished, coated member before it '
      + 'is released for dispatch.',
    machines: [{ name: 'Final QC Station #1', notes: stationNote('Final check before release for dispatch.') }],
  },
};

/** A machine type, whether it came from the extract or was decided here. */
function typeSpec(source, key, index) {
  const extra = EXTRA_TYPES[key];
  if (extra) {
    return { key, code: extra.code, name: extra.name, description: extra.description, sortOrder: extra.sortOrder,
      machines: extra.machines.map((m) => ({ name: m.name, notes: m.notes ?? null, sourceCode: null })), fromExtract: false };
  }
  const src = source.get(key);
  if (!src) throw new Error(`the extract has no type ${key}, which this script expects`);
  return { key, code: TYPE_CODE[key], name: src.name, description: TYPE_NOTE[key] ?? null, sortOrder: (index + 1) * 10,
    machines: src.machines.map((m) => ({ name: m.name, notes: null, sourceCode: m.sourceCode })), fromExtract: true };
}

/** Every machine type this script is responsible for, in tree order. */
const planTypes = (source) => GROUPS.flatMap((g) => g.types.map((key, i) => ({ group: g, ...typeSpec(source, key, i) })));

// ---------------------------------------------------------------------------
// Source
// ---------------------------------------------------------------------------

/** { typeCode -> { name, machines: [name] } }, in the order the file gives them. */
function readSource() {
  if (!fs.existsSync(SOURCE)) throw new Error(`${SOURCE} is missing — copy the fab_erp extract there first.`);
  const lines = fs.readFileSync(SOURCE, 'utf8').split(/\r?\n/).filter((l) => l.trim() !== '');
  const header = lines.shift().split('\t').map((h) => h.trim());
  const want = ['type_name', 'type_code', 'machine_name', 'machine_code'];
  if (want.some((w, i) => header[i] !== w)) throw new Error(`unexpected columns in the extract: ${header.join(', ')}`);
  const types = new Map();
  for (const line of lines) {
    const [typeName, typeCode, machineName, machineCode] = line.split('\t').map((f) => f.trim());
    if (!types.has(typeCode)) types.set(typeCode, { code: typeCode, name: typeName, machines: [] });
    const t = types.get(typeCode);
    if (t.name !== typeName) throw new Error(`${typeCode} is called both "${t.name}" and "${typeName}" in the extract`);
    t.machines.push({ name: machineName, sourceCode: machineCode });
  }
  return types;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

async function nodeByCode(code) {
  const [[r]] = await conn.query(
    `SELECT id, parent_id, depth, scope, code, name, status, sort_order, description
       FROM cf_classification_nodes WHERE company_id = ? AND code = ? AND deleted_at IS NULL`,
    [COMPANY, code]);
  return r ?? null;
}

async function machineByName(name) {
  const [[r]] = await conn.query(
    `SELECT id, code, name, classification_id FROM cf_machines
      WHERE company_id = ? AND name = ? AND deleted_at IS NULL`,
    [COMPANY, name]);
  return r ?? null;
}

// ---------------------------------------------------------------------------
// The machine coding rule
//
// Without one, createMachine refuses every machine with CODE_REQUIRED, because
// no code was typed. The pattern is the one the machine provider documents for
// itself: the machine type's code, then a number that restarts per type
// (seqScope 'prefix' keys the counter on everything rendered before the
// number). No conditions, so it applies to every machine and loses on weight to
// any later rule that names a subfamily.
// ---------------------------------------------------------------------------

const MACHINE_RULE = {
  code: 'CFMC-ANY',
  name: 'Machine code',
  entityType: 'machine',
  targetField: 'code',
  seqScope: 'prefix',
  priority: 0,
  description: 'Machine type code, then a number that restarts for each type: SAW-01, SAW-02, PLASMA-01.',
  conditions: [],
  segments: [
    { segmentType: 'token', tokenKey: 'classification.code', transform: 'upper', isRequired: true },
    { segmentType: 'literal', literalText: '-' },
    { segmentType: 'sequence', format: '00' },
  ],
};

async function ensureCodingRule() {
  const [[have]] = await conn.query(
    `SELECT id, code FROM cf_code_schemes
      WHERE company_id = ? AND entity_type = 'machine' AND target_field = 'code'
        AND status = 'active' AND deleted_at IS NULL`,
    [COMPANY]);
  if (have) { bump(tally.reused, 'coding rule'); say(`   coding rule ${have.code} already mints machine codes`); return; }
  await codegen.createScheme(conn, COMPANY, c.userId, MACHINE_RULE);
  bump(tally.created, 'coding rule');
  notes.push('No coding rule for machines existed, so every machine would have been refused with CODE_REQUIRED. '
    + `Added ${MACHINE_RULE.code}: {classification.code}-{00}, numbered per machine type.`);
  say(`   added coding rule ${MACHINE_RULE.code}  {classification.code}-{00}`);
}

// ---------------------------------------------------------------------------
// The tree
// ---------------------------------------------------------------------------

function checkMachineNode(row, depth, label) {
  if (row.scope !== 'machine') throw new Error(`${row.code} already exists as an item ${label} — machines need a Family with scope Machine. Rename one of them.`);
  if (row.depth !== depth) throw new Error(`${row.code} already exists at depth ${row.depth}, not ${depth} (${label}).`);
  if (row.status !== 'active') throw new Error(`${row.code} is inactive — a machine cannot sit under an inactive ${label}.`);
}

/** Family and subfamilies are born inside createMachineType, which gives them a
 *  code, a name and scope only. Their description and sort order are set after,
 *  through the services that own each field. */
async function dressNode(id, { description, sortOrder }) {
  const [[row]] = await conn.query('SELECT description, sort_order FROM cf_classification_nodes WHERE id = ?', [id]);
  if (description !== undefined && (row.description ?? null) !== description) {
    await cls.updateMachineNode(conn, c, id, { description });
    bump(tally.created, 'node description');
  }
  if (sortOrder !== undefined && Number(row.sort_order) !== Number(sortOrder)) {
    // updateMachineNode forwards only name/code/description/status, so the sort
    // order goes through the Setup door. Same table, same validation.
    await cls.updateNode(conn, c, id, { sortOrder });
    bump(tally.created, 'node sort order');
  }
}

async function buildTree(source) {
  say('\n-- machine types --');
  let familyId = null;
  const fam = await nodeByCode(FAMILY.code);
  if (fam) { checkMachineNode(fam, 0, 'Family'); familyId = fam.id; bump(tally.reused, 'family'); }

  const typeIdBySource = new Map();

  for (const group of GROUPS) {
    let subId = null;
    const sub = await nodeByCode(group.code);
    if (sub) {
      checkMachineNode(sub, 1, 'Subfamily');
      if (familyId && sub.parent_id !== familyId) throw new Error(`${group.code} sits under node ${sub.parent_id}, not ${FAMILY.code}.`);
      subId = sub.id;
      bump(tally.reused, 'subfamily');
    }

    for (const [i, key] of group.types.entries()) {
      const spec = typeSpec(source, key, i);
      const code = spec.code;
      const existing = await nodeByCode(code);
      if (existing) {
        checkMachineNode(existing, 2, 'machine type');
        if (subId && existing.parent_id !== subId) throw new Error(`machine type ${code} sits under node ${existing.parent_id}, not ${group.code}.`);
        if (existing.name !== spec.name) {
          notes.push(`machine type ${code} is named "${existing.name}" here and "${spec.name}" in this script — left as it is.`);
        }
        typeIdBySource.set(key, existing.id);
        bump(tally.reused, 'machine type');
        continue;
      }
      // One call find-or-creates the whole chain: Family, Subfamily, then the type.
      const made = await cls.createMachineType(conn, c, {
        family: familyId ? { id: familyId } : { code: FAMILY.code, name: FAMILY.name },
        subfamily: subId ? { id: subId } : { code: group.code, name: group.name },
        code,
        name: spec.name,
        description: spec.description,
        sortOrder: spec.sortOrder,
      });
      familyId = made.familyId;
      subId = made.subfamilyId;
      if (made.created.family) bump(tally.created, 'family');
      if (made.created.subfamily) bump(tally.created, 'subfamily');
      bump(tally.created, spec.fromExtract ? 'machine type' : 'machine type (added here)');
      say(`   ${spec.fromExtract ? '     ' : ' new '}${code.padEnd(10)} ${spec.name.padEnd(36)} under ${group.code}`);
      typeIdBySource.set(key, made.id);
    }

    if (!subId) throw new Error(`${group.code} has no types, so it was never created`);
    await dressNode(subId, { description: group.description, sortOrder: group.sortOrder });
  }

  if (!familyId) throw new Error('no machine family — the extract produced no types at all');
  await dressNode(familyId, { description: FAMILY.description });
  say(`   ${GROUPS.length} subfamilies · ${typeIdBySource.size} machine types under ${FAMILY.code}`);
  return typeIdBySource;
}

// ---------------------------------------------------------------------------
// The machines
//
// Keyed on NAME, not code: the name is what the shop calls the machine and is
// carried across verbatim, while the code is minted here and so cannot be used
// to recognise a machine that already exists.
// ---------------------------------------------------------------------------

async function buildMachines(source, typeIdBySource) {
  say('\n-- machines --');
  for (const spec of planTypes(source)) {
    const classificationId = typeIdBySource.get(spec.key);
    for (const m of spec.machines) {
      const have = await machineByName(m.name);
      if (have) {
        if (have.classification_id !== classificationId) {
          notes.push(`machine "${m.name}" is on classification ${have.classification_id}, not ${spec.code} — left where it is.`);
        }
        bump(tally.reused, 'machine');
        continue;
      }
      let made;
      try {
        made = await mach.createMachine(conn, c, { name: m.name, classificationId, notes: m.notes ?? undefined });
      } catch (e) {
        throw new Error(`could not create "${m.name}": ${e.code ?? ''} ${e.message} ${(e.problems ?? []).join(' | ')}`);
      }
      bump(tally.created, spec.fromExtract ? 'machine' : 'machine (added here)');
      say(`   ${String(made.code).padEnd(14)} ${made.name.padEnd(28)} ${spec.code.padEnd(10)}`
        + `   ${m.sourceCode ? `(source code ${m.sourceCode})` : '(not in the extract — added here)'}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Read it back
// ---------------------------------------------------------------------------

async function verify(source) {
  say('\n-- what is there --');
  const { families } = await cls.listMachineTypes(conn, COMPANY);
  const all = await mach.listMachines(conn, COMPANY, {});
  const byType = new Map();
  for (const m of all) {
    if (!byType.has(m.classificationId)) byType.set(m.classificationId, []);
    byType.get(m.classificationId).push(m);
  }

  let typeCount = 0;
  let machineCount = 0;
  for (const f of families) {
    say(`   ${f.code}  ${f.name}`);
    for (const s of f.subfamilies) {
      say(`      ${s.code.padEnd(14)} ${s.name}`);
      for (const t of s.types) {
        typeCount += 1;
        say(`         ${t.code.padEnd(10)} ${t.name.padEnd(24)} ${t.machineCount} machine${t.machineCount === 1 ? '' : 's'}`);
        for (const m of (byType.get(t.id) ?? []).sort((a, b) => a.code.localeCompare(b.code))) {
          machineCount += 1;
          say(`            ${m.code.padEnd(12)} ${m.name}`);
        }
      }
    }
  }

  // Against the plan — the extract plus the types this script adds — and never
  // against a number typed here. The two are counted apart so a future re-run
  // of the extract cannot quietly absorb a decision made in this file.
  const problems = [];
  const plan = planTypes(source);
  const fromExtract = plan.filter((t) => t.fromExtract);
  const addedHere = plan.filter((t) => !t.fromExtract);
  const wantMachines = plan.reduce((n, t) => n + t.machines.length, 0);
  if (source.size !== fromExtract.length) problems.push(`the extract has ${source.size} types but ${fromExtract.length} are placed in GROUPS`);
  if (families.length !== 1) problems.push(`${families.length} machine families, expected 1`);
  if (typeCount !== plan.length) problems.push(`${typeCount} machine types, this script defines ${plan.length}`);
  if (machineCount !== wantMachines) problems.push(`${machineCount} machines placed, this script defines ${wantMachines}`);

  const [[depths]] = await conn.query(
    `SELECT COUNT(*) AS n FROM cf_classification_nodes
      WHERE company_id = ? AND deleted_at IS NULL AND scope = 'machine' AND depth = 2 AND status = 'active'`, [COMPANY]);
  if (Number(depths.n) !== plan.length) problems.push(`${depths.n} active depth-2 machine-scope nodes, expected ${plan.length}`);

  const [[stray]] = await conn.query(
    `SELECT COUNT(*) AS n FROM cf_machines mc
       JOIN cf_classification_nodes n ON n.id = mc.classification_id
      WHERE mc.company_id = ? AND mc.deleted_at IS NULL AND (n.scope <> 'machine' OR n.depth <> 2)`, [COMPANY]);
  if (Number(stray.n)) problems.push(`${stray.n} machines are not on a depth-2 machine-scope node`);

  // Every machine the plan names, on the type the plan gives it.
  for (const t of plan) {
    for (const m of t.machines) {
      const row = all.find((x) => x.name === m.name);
      if (!row) { problems.push(`"${m.name}" is not there`); continue; }
      if (row.classificationCode !== t.code) problems.push(`"${m.name}" is on ${row.classificationCode}, expected ${t.code}`);
      if (!row.code) problems.push(`"${m.name}" has no code`);
    }
  }

  // Every machine type reachable by at least one operation. A type nothing can
  // be timed on is not wrong — it is idle capacity — but it should be said out
  // loud, because the usual cause is a missing machine rule.
  const [unreached] = await conn.query(
    `SELECT n.code, n.name FROM cf_classification_nodes n
      WHERE n.company_id = ? AND n.deleted_at IS NULL AND n.scope = 'machine' AND n.depth = 2
        AND NOT EXISTS (
          SELECT 1 FROM cf_operation_machine_rules r
            JOIN cf_classification_nodes s ON s.id = r.subject_id AND s.company_id = r.company_id
           WHERE r.company_id = n.company_id AND r.deleted_at IS NULL AND r.subject_type = 'classification'
             AND (s.id = n.id OR s.id = n.parent_id OR s.id = (SELECT p.parent_id FROM cf_classification_nodes p WHERE p.id = n.parent_id)))
      ORDER BY n.code`, [COMPANY]);

  say(`\n   ${typeCount} machine types (${fromExtract.length} from the extract, ${addedHere.length} added here) `
    + `· ${machineCount} machines · ${problems.length} problems`);
  if (addedHere.length) say(`   added here: ${addedHere.map((t) => t.code).join(', ')}`);
  if (unreached.length) {
    say(`   ${unreached.length} machine type(s) no operation can run on: ${unreached.map((u) => u.code).join(', ')}`);
  }
  for (const p of problems) say(`   ! ${p}`);
  if (problems.length) throw new Error('the shop floor does not match what this script defines');
}

// ---------------------------------------------------------------------------

try {
  const source = readSource();
  conn = await pool.getConnection();
  await conn.beginTransaction();
  attachNodeCache(conn);
  say(`cf_erp shop floor -> company ${COMPANY}${VERIFY_ONLY ? '  (verify only)' : ''}`);
  say(`   source: ${path.relative(BE, SOURCE)} — ${source.size} types, `
    + `${[...source.values()].reduce((n, t) => n + t.machines.length, 0)} machines`);
  {
    const extra = planTypes(source).filter((t) => !t.fromExtract);
    say(`   plus ${extra.length} types the extract does not have, decided in this file: `
      + `${extra.map((t) => t.code).join(', ')} (${extra.reduce((n, t) => n + t.machines.length, 0)} machines)`);
  }

  if (!VERIFY_ONLY) {
    say('\n-- coding rule --');
    await ensureCodingRule();
    const typeIds = await buildTree(source);
    await buildMachines(source, typeIds);
  }

  detachNodeCache(conn);
  if (VERIFY_ONLY) await conn.rollback(); else await conn.commit();
  attachNodeCache(conn);
  await verify(source);

  say(`\n  created: ${JSON.stringify(tally.created)}`);
  say(`  reused : ${JSON.stringify(tally.reused)}`);
  for (const n of notes) say(`  note   : ${n}`);
  say('\ndone.');
} catch (e) {
  if (conn) await conn.rollback();
  console.error('\nFAILED:', e.code ?? '', e.message, e.problems ?? '');
  process.exitCode = 1;
} finally { if (conn) { detachNodeCache(conn); conn.release(); } await pool.end(); }
