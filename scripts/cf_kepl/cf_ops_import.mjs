/**
 * cf_ops_import.mjs — the fab_erp steel-fabrication operations and flows, as
 * CF operations, flows and machine rules.
 *
 * Source: fab_ops_extract.tsv (18 rows, 4 of them leftovers with placeholder
 * OP-000n codes) and fab_flows_extract.tsv (47 steps over 7 flows, two of them
 * scratch). Both sit next to this file. The junk is named below rather than
 * guessed at, so re-extracting the source cannot quietly widen the import.
 *
 * WHERE A STEP'S RESOURCE TYPE GOES
 * ---------------------------------
 * cf_operation_flow_steps carries flow, sequence, operation, name, notes — and
 * nothing about machines. Who can do an operation, and how fast, lives in
 * cf_operation_machine_rules, one row per (operation × machine type | machine):
 * "this machine type can do this operation, setup X, work Y per piece", with
 * the deepest subject winning (operationService.resolveTiming). So the fab
 * resource type on a STEP is, in CF, a fact about the OPERATION, and the same
 * rule serves the operation everywhere it appears. That is what this script
 * writes: one eligibility rule per operation × machine type, no times yet.
 *
 * A FLOW MAY REPEAT AN OPERATION
 * ------------------------------
 * Since 2026-09-24 a step is identified inside its flow by its SEQUENCE, not by
 * its operation: uq_cofs_operation_seq keys on (flow, operation, sequence), so
 * a flow can weld, crane-turn the piece and weld again. Every fab step becomes
 * a real step at its own position — all 43 of them — and the fab order is the
 * CF order. The only repeat still refused is two passes at the SAME sequence,
 * which would run in parallel instead of one after the other.
 *
 * Re-runnable. Operations and flows are keyed on their code, machine rules on
 * the pair they are a rule for, and a STEP on (operation, sequence) inside its
 * flow — the same key the unique index uses, so "is it already there" and
 * "would the insert be refused" are one question, and a repeated operation has
 * one key per pass. A second run creates nothing. A description this script
 * wrote is brought back in line if the source changed; one someone has edited
 * (the marker gone) is left alone.
 *
 * Machine types are matched by NAME, and one that is not there is skipped with
 * a line in the report rather than guessed at — see MACHINE_TYPE_ALIASES, which
 * is where a decided mapping goes and is read on the next run.
 *
 *   cd multi_app_be && node scripts/cf_kepl/cf_ops_import.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const BE = process.cwd();
const HERE = path.dirname(fileURLToPath(import.meta.url));
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
const opsSvc = await imp('apps/cf_erp/services/operationService.js');
const flowSvc = await imp('apps/cf_erp/services/flowService.js');
const { attachNodeCache, detachNodeCache } = await imp('apps/cf_erp/lib/db.js');

const COMPANY = Number(process.env.CF_BRIDGE_COMPANY ?? 2);
const c = { companyId: COMPANY, userId: Number(process.env.CF_BRIDGE_USER ?? 22) };
const say = (...a) => console.log(...a);
const tally = { created: {}, updated: {}, reused: {} };
/** The mark that says a row came from here, so an edited one is left alone. */
const MARK = 'Imported from fab_erp';
const bump = (bag, k, n = 1) => { bag[k] = (bag[k] ?? 0) + n; };
const refusals = [];
const pending = [];
const extras = [];
let machineTypes = [];

let conn;

// --- what is real in the source ----------------------------------------------

/** Leftovers: placeholder codes, no time formula, not part of the shop. */
const JUNK_OPS = new Set(['OP-0001', 'OP-0002', 'OP-0004', 'OP-0005']);
const JUNK_FLOWS = new Set(['New Flow 1', 'Test Flow']);

/** A flow needs a code; fab only gave it a name. Explicit, because the code is
 *  the re-run key — deriving it would make a rename create a second flow. */
const FLOW_CODES = new Map([
  ['Cutting Flow', 'CUTTING'],
  ['Part Fabrication — Plain (no holes)', 'PARTFAB-PLAIN'],
  ['Part Fabrication — Drilled', 'PARTFAB-DRILLED'],
  ['Line Segment — Assembly, Welding & Finishing', 'LINESEG-FAB'],
  ['PEB Built-up Member — Weld & Prime', 'PEB-BUILTUP'],
]);

function readTsv(file) {
  const text = fs.readFileSync(path.join(HERE, file), 'utf8').replace(/^﻿/, '');
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  const head = lines.shift().split('\t').map((h) => h.trim());
  return lines.map((l) => {
    const cells = l.split('\t');
    return Object.fromEntries(head.map((h, i) => [h, (cells[i] ?? '').trim()]));
  });
}

function loadSource() {
  const opRows = readTsv('fab_ops_extract.tsv').filter((r) => r.code && !JUNK_OPS.has(r.code));
  const stepRows = readTsv('fab_flows_extract.tsv').filter((r) => r.flow_name && !JUNK_FLOWS.has(r.flow_name));
  const known = new Set(opRows.map((r) => r.code));
  const flows = new Map();
  for (const r of stepRows) {
    if (!known.has(r.op_code)) {
      refusals.push(`flow ${r.flow_name} step ${r.seq_no} names operation ${r.op_code}, which is not one of the real operations — step skipped`);
      continue;
    }
    if (!flows.has(r.flow_name)) flows.set(r.flow_name, []);
    flows.get(r.flow_name).push({ seq: Number(r.seq_no), opCode: r.op_code, resourceType: r.resource_type || null });
  }
  for (const steps of flows.values()) steps.sort((a, b) => a.seq - b.seq);
  for (const name of flows.keys()) {
    if (!FLOW_CODES.has(name)) refusals.push(`flow "${name}" has no code in FLOW_CODES — not imported`);
  }
  // One resource type per operation, taken from the steps that use it.
  const resourceTypes = new Map();
  for (const [name, steps] of flows) {
    if (!FLOW_CODES.has(name)) continue;
    for (const s of steps) {
      if (!s.resourceType) continue;
      if (!resourceTypes.has(s.opCode)) resourceTypes.set(s.opCode, new Set());
      resourceTypes.get(s.opCode).add(s.resourceType);
    }
  }
  return { opRows, flows, resourceTypes };
}

// --- operations ----------------------------------------------------------------

/** The fab time formula reads fab item fields, which have no CF specification
 *  yet, so it cannot become a cf_formula. It is kept in the description so a
 *  later timing pass has the arithmetic rather than having to re-derive it. */
function describeOperation(row) {
  const bits = [`${row.name}.`];
  if (row.time_formula) bits.push(`Time (${row.time_unit || 'min'} per piece, from fab_erp): ${row.time_formula}`);
  if (String(row.is_subcontract) === '1') bits.push('Subcontracted.');
  bits.push(`${MARK}.`);
  return bits.join(' ');
}

async function ensureOperation(row) {
  const [[have]] = await conn.query(
    'SELECT id, code, name, status, description FROM cf_operations WHERE company_id = ? AND code = ? AND deleted_at IS NULL',
    [COMPANY, row.code],
  );
  if (have) {
    bump(tally.reused, 'operation');
    if (have.status !== 'active') {
      await opsSvc.updateOperation(conn, c, have.id, { status: 'active' });
      bump(tally.updated, 'operation reactivated');
    }
    const want = describeOperation(row);
    if (String(have.description ?? '').includes(MARK) && have.description !== want) {
      await opsSvc.updateOperation(conn, c, have.id, { description: want });
      bump(tally.updated, 'operation description');
    }
    return have.id;
  }
  const o = await opsSvc.createOperation(conn, c, {
    code: row.code, name: row.name, description: describeOperation(row), status: 'active',
  });
  bump(tally.created, 'operation');
  return o.id;
}

async function buildOperations(opRows) {
  say('\n-- operations --');
  const byCode = new Map();
  for (const row of opRows) {
    try {
      byCode.set(row.code, await ensureOperation(row));
    } catch (e) {
      refusals.push(`operation ${row.code}: ${e.code ?? ''} ${e.message} ${(e.problems ?? []).join(' | ')}`.trim());
    }
  }
  say(`   ${byCode.size} of ${opRows.length} operations in place`);
  return byCode;
}

// --- machine types --------------------------------------------------------------

const norm = (s) => String(s).toLowerCase().replace(/\s+/g, ' ').trim();
const tight = (s) => String(s).toLowerCase().replace(/\s+/g, '');

/**
 * The fab flow steps and the fab shop use two different vocabularies: a step
 * says "CNC Plate Cutting", the shop has a machine type called "CNC Plasma
 * Cutting". Nothing derives one from the other, so this script matches on the
 * name and nothing else, and anything unmatched is reported rather than guessed.
 *
 * The decided mapping is below — fab resource type -> machine type code or
 * name, at ANY level of the tree, because a rule set on a subfamily covers
 * every machine under it. Decided 2026-09-24:
 *
 *   CNC Plate Cutting    -> PLASMA        the only machine that cuts plate
 *   CNC Drilling         -> DRILL         CNC Drilling Machine
 *   SAW Welding          -> SAW           Submerged Arc Welding
 *   Shot Blasting        -> BLAST         Shot Blasting Chamber
 *   Painting             -> PAINT         Painting Booth
 *   Edge Preparation     -> EDGEMILL      added by cf_shop_import
 *   Metalizing           -> METALIZE      added by cf_shop_import
 *   Crane / EOT Crane    -> MC-HANDLING   the SUBFAMILY, not a type: both the
 *                                         10 t and the 20 t crane can make the
 *                                         move, so one rule on the level above
 *                                         says so once and keeps saying it when
 *                                         a third crane arrives.
 *
 * A NAME IS NOT ALWAYS ENOUGH
 * Two fab resource types mean different machines depending on which operation
 * is standing on them, so a map keyed on the name alone cannot say it. Those go
 * in OPERATION_MACHINE_TYPE, keyed `OPCODE|resource type`, which wins:
 *
 *   Quality Control  -> QC-PART for PQC, QC-WELD for WQC, QC-FINAL for FQC.
 *     One fab name covering three inspections that happen at three points in
 *     the flow, on three different things, done by three differently rostered
 *     people. cf_shop_import gives each its own station so they can be planned
 *     apart; sending all three to one station would undo that here.
 *
 *   CNC I/H-Beam Welding -> JIG for ASSY, MIG for TUG.   <- confirm this one
 *     The fab name describes an automatic I/H-beam line that does fit-up, tack
 *     and submerged-arc in one pass. This shop does not have one — the same
 *     flows run SAW as a separate step on a separate resource type right after
 *     the tack, which an all-in-one line would never need. So the name is a
 *     label, not a machine, and each operation is mapped to what it physically
 *     is: ASSY is "Fit-up & I/H-Beam Assembly", flanges and web held square,
 *     which is the girder assembly jig; TUG is "Tug Weld", the short tacks that
 *     hold that fit-up until the SAW runs, which is the MIG station the shop
 *     already describes as "everything the SAW cannot reach".
 *     If the shop does own an automatic I/H-beam welding line, both belong on
 *     that one type instead and it has to be added to the shop first.
 */
const MACHINE_TYPE_ALIASES = new Map([
  ['CNC Plate Cutting', 'PLASMA'],
  ['CNC Drilling', 'DRILL'],
  ['SAW Welding', 'SAW'],
  ['Shot Blasting', 'BLAST'],
  ['Painting', 'PAINT'],
  ['Edge Preparation', 'EDGEMILL'],
  ['Metalizing', 'METALIZE'],
  ['Crane / EOT Crane', 'MC-HANDLING'],
]);

/** `OPCODE|resource type` -> machine type, for a fab name that means a
 *  different machine depending on the operation standing on it. */
const OPERATION_MACHINE_TYPE = new Map([
  ['PQC|Quality Control', 'QC-PART'],
  ['WQC|Quality Control', 'QC-WELD'],
  ['FQC|Quality Control', 'QC-FINAL'],
  ['ASSY|CNC I/H-Beam Welding', 'JIG'],
  ['TUG|CNC I/H-Beam Welding', 'MIG'],
]);

async function machineTypeIndex() {
  const [rows] = await conn.query(
    "SELECT id, code, name, depth, scope FROM cf_classification_nodes WHERE company_id = ? AND deleted_at IS NULL AND status = 'active'",
    [COMPANY],
  );
  const machine = new Map();
  const other = new Map();
  const byCode = new Map();
  for (const r of rows) {
    const bag = r.scope === 'machine' ? machine : other;
    if (r.scope === 'machine') byCode.set(norm(r.code), r);
    for (const key of [norm(r.name), tight(r.name)]) {
      if (!bag.has(key)) bag.set(key, []);
      if (!bag.get(key).some((x) => x.id === r.id)) bag.get(key).push(r);
    }
  }
  return { machine, other, byCode, all: rows.filter((r) => r.scope === 'machine') };
}

function findMachineType(index, name, opCode) {
  // Per-operation first: the same fab name can mean two machines.
  const alias = OPERATION_MACHINE_TYPE.get(`${opCode}|${name}`) ?? MACHINE_TYPE_ALIASES.get(name);
  if (alias) {
    const byCode = index.byCode.get(norm(alias));
    if (byCode) return { node: byCode, alias };
    const byName = index.machine.get(norm(alias));
    if (byName?.length === 1) return { node: byName[0], alias };
    return { badAlias: alias };
  }
  for (const key of [norm(name), tight(name)]) {
    const hit = index.machine.get(key);
    if (hit?.length === 1) return { node: hit[0] };
    if (hit?.length > 1) return { ambiguous: hit };
  }
  for (const key of [norm(name), tight(name)]) {
    const hit = index.other.get(key);
    if (hit?.length) return { wrongScope: hit[0] };
  }
  return {};
}

/**
 * One rule per operation × machine type: eligible, no times. The times are the
 * fab formulas, which need CF specifications that do not exist yet; a rule with
 * no work time still says who may do the work, which is the whole content of
 * the resource type on a fab step.
 */
async function buildMachineRules(opByCode, resourceTypes) {
  say('\n-- machine rules (operation x machine type) --');
  const index = await machineTypeIndex();
  machineTypes = index.all;
  // index.all is every machine-scope node, not only the leaves: a rule may be
  // set on a subfamily (the cranes are), so the whole tree is what can be named.
  const leaves = index.all.filter((n) => n.depth === 2).length;
  say(`   ${leaves} machine types, under ${index.all.length - leaves} levels above them, can be named by a rule`);
  for (const [opCode, types] of [...resourceTypes].sort()) {
    const operationId = opByCode.get(opCode);
    if (!operationId) continue;
    for (const typeName of [...types].sort()) {
      const found = findMachineType(index, typeName, opCode);
      if (found.badAlias) {
        refusals.push(`${opCode}: the alias maps send "${typeName}" to "${found.badAlias}", which is not one machine type — no rule written`);
        continue;
      }
      if (found.ambiguous) {
        refusals.push(`${opCode}: "${typeName}" matches ${found.ambiguous.length} machine types (${found.ambiguous.map((n) => n.code).join(', ')}) — no rule written`);
        continue;
      }
      if (found.wrongScope) {
        refusals.push(`${opCode}: "${typeName}" exists as node ${found.wrongScope.code} but its scope is '${found.wrongScope.scope}', not 'machine' — a timing rule refuses it`);
        continue;
      }
      if (!found.node) {
        pending.push(`${opCode} -> "${typeName}"`);
        continue;
      }
      const [[have]] = await conn.query(
        `SELECT id FROM cf_operation_machine_rules
          WHERE company_id = ? AND operation_id = ? AND subject_type = 'classification' AND subject_id = ? AND deleted_at IS NULL`,
        [COMPANY, operationId, found.node.id],
      );
      if (have) { bump(tally.reused, 'machine rule'); continue; }
      try {
        await opsSvc.createTimingRule(conn, c, operationId, {
          subjectType: 'classification',
          subjectId: found.node.id,
          eligible: true,
          notes: `${opCode} runs on ${typeName} (fab_erp resource type)`
            + `${found.alias && norm(found.alias) !== norm(typeName) ? `, read here as ${found.node.code}` : ''}`
            + `${found.node.depth < 2 ? ' — set on the level above the machine types, so every machine under it is covered' : ''}`
            + '. Setup and work times still to be set.',
        });
        bump(tally.created, 'machine rule');
        say(`   ${opCode.padEnd(6)} -> ${String(found.node.code).padEnd(12)} ${found.node.name}${found.node.depth < 2 ? '   (whole subtree)' : ''}`);
      } catch (e) {
        refusals.push(`machine rule ${opCode} -> ${typeName}: ${e.code ?? ''} ${e.message} ${(e.problems ?? []).join(' | ')}`.trim());
      }
    }
  }
  if (pending.length) say(`   ${pending.length} have no machine type of that name — see the end of the report`);
}

// --- flows -----------------------------------------------------------------------

/** What the flow IS. The sequence itself is the steps' job, not the prose's. */
function describeFlow(name, steps) {
  return `${name}. The ${steps.length}-step sequence the fab_erp shop runs for this, step for step. ${MARK}.`;
}

async function ensureFlow(name, steps) {
  const code = FLOW_CODES.get(name);
  const want = describeFlow(name, steps);
  const [[have]] = await conn.query(
    'SELECT id, code, name, status, description FROM cf_operation_flows WHERE company_id = ? AND code = ? AND deleted_at IS NULL',
    [COMPANY, code],
  );
  let flowId = have?.id ?? null;
  if (flowId) {
    bump(tally.reused, 'flow');
    if (String(have.description ?? '').includes(MARK) && have.description !== want) {
      await flowSvc.updateFlow(conn, c, flowId, { description: want });
      bump(tally.updated, 'flow description');
    }
  } else {
    const f = await flowSvc.createFlow(conn, c, { code, name, description: want });
    flowId = f.id;
    bump(tally.created, 'flow');
  }
  return { flowId, code };
}

/** The re-run key for a step, and exactly what uq_cofs_operation_seq keys on
 *  once flow and company are fixed by the query that read it. */
const stepKey = (operationId, sequence) => `${operationId}@${sequence}`;

/** The fab position, spaced out: 10, 20, 30 …, so a step can be put between two. */
const cfSequence = (fabSeq) => fabSeq * 10;

/** Notes this script used to write when it could only keep one pass of an
 *  operation. The data holds every pass now, so they are cleared on sight —
 *  anything else in a step's notes is somebody's and is left alone. */
const isStalePassNote = (notes) => /^Runs \d+ times in the fab sequence/.test(String(notes ?? ''));

async function buildFlow(name, steps, opByCode) {
  const { flowId, code } = await ensureFlow(name, steps);
  const [existing] = await conn.query(
    'SELECT id, operation_id, sequence, notes FROM cf_operation_flow_steps WHERE company_id = ? AND flow_id = ? AND deleted_at IS NULL',
    [COMPANY, flowId],
  );
  // Keyed on (operation, sequence): an operation on its own is no longer unique
  // within a flow, so it cannot say whether THIS pass is already a step.
  const onFlow = new Map(existing.map((r) => [stepKey(r.operation_id, r.sequence), r]));
  const wanted = new Set();

  for (const s of steps) {
    const operationId = opByCode.get(s.opCode);
    if (!operationId) {
      refusals.push(`${code} step ${s.seq}: operation ${s.opCode} was not created — step missing`);
      continue;
    }
    const sequence = cfSequence(s.seq);
    const key = stepKey(operationId, sequence);
    wanted.add(key);
    const here = onFlow.get(key);
    if (here) {
      bump(tally.reused, 'flow step');
      if (isStalePassNote(here.notes)) {
        await flowSvc.updateStep(conn, c, here.id, { notes: null });
        bump(tally.updated, 'flow step note cleared');
      }
      continue;
    }
    try {
      await flowSvc.addStep(conn, c, flowId, { operationId, sequence });
      onFlow.set(key, { operation_id: operationId, sequence });
      bump(tally.created, 'flow step');
    } catch (e) {
      refusals.push(`${code} step ${s.seq} (${s.opCode}): ${e.code ?? ''} ${e.message} ${(e.problems ?? []).join(' | ')}`.trim());
    }
  }

  // A step on the flow that the source no longer has. Reported, not deleted —
  // somebody may have added it on purpose.
  for (const [key, row] of onFlow) {
    if (!wanted.has(key)) extras.push({ flow: code, sequence: row.sequence, operationId: row.operation_id });
  }

  const [[state]] = await conn.query('SELECT status FROM cf_operation_flows WHERE company_id = ? AND id = ?', [COMPANY, flowId]);
  if (state.status === 'active') bump(tally.reused, 'flow already active');
  else {
    try {
      await flowSvc.setFlowStatus(conn, c, flowId, 'active');
      bump(tally.created, 'flow activated');
    } catch (e) {
      refusals.push(`${code} could not be activated: ${e.code ?? ''} ${e.message} ${(e.problems ?? []).join(' | ')}`.trim());
    }
  }
  const passes = steps.length - new Set(steps.map((s) => s.opCode)).size;
  say(`   ${code.padEnd(16)} ${String(steps.length).padStart(2)} fab steps -> ${String(onFlow.size).padStart(2)} CF steps`
    + `${passes ? `  (${passes} of them a repeat pass)` : ''}`);
}

async function buildFlows(flows, opByCode) {
  say('\n-- flows --');
  for (const [name, steps] of flows) {
    if (!FLOW_CODES.has(name)) continue;
    try {
      await buildFlow(name, steps, opByCode);
    } catch (e) {
      refusals.push(`flow ${name}: ${e.code ?? ''} ${e.message} ${(e.problems ?? []).join(' | ')}`.trim());
    }
  }
}

// --- read it back ----------------------------------------------------------------

async function verify() {
  say('\n-- what is in the database --');
  const [ops] = await conn.query(
    `SELECT o.id, o.code, o.name, o.status,
            (SELECT COUNT(DISTINCT s.flow_id) FROM cf_operation_flow_steps s WHERE s.company_id = o.company_id AND s.operation_id = o.id AND s.deleted_at IS NULL) AS flows,
            (SELECT COUNT(*) FROM cf_operation_machine_rules r WHERE r.company_id = o.company_id AND r.operation_id = o.id AND r.deleted_at IS NULL) AS rules,
            (SELECT GROUP_CONCAT(n.name ORDER BY n.name SEPARATOR ', ') FROM cf_operation_machine_rules r
               JOIN cf_classification_nodes n ON n.id = r.subject_id
              WHERE r.company_id = o.company_id AND r.operation_id = o.id AND r.subject_type = 'classification' AND r.deleted_at IS NULL) AS types
       FROM cf_operations o WHERE o.company_id = ? AND o.deleted_at IS NULL ORDER BY o.code`,
    [COMPANY],
  );
  for (const o of ops) {
    say(`   ${String(o.code).padEnd(7)} ${String(o.name).padEnd(32)} ${String(o.status).padEnd(8)} ${o.flows} flow(s)  ${o.rules} rule(s)${o.types ? `  -> ${o.types}` : ''}`);
  }

  const [flows] = await conn.query(
    'SELECT id, code, name, status FROM cf_operation_flows WHERE company_id = ? AND deleted_at IS NULL ORDER BY code', [COMPANY],
  );
  say('');
  for (const f of flows) {
    const [steps] = await conn.query(
      `SELECT s.sequence, o.code FROM cf_operation_flow_steps s JOIN cf_operations o ON o.id = s.operation_id
        WHERE s.company_id = ? AND s.flow_id = ? AND s.deleted_at IS NULL ORDER BY s.sequence, s.id`,
      [COMPANY, f.id],
    );
    say(`   ${String(f.code).padEnd(16)} ${String(f.status).padEnd(7)} ${String(steps.length).padStart(2)} steps  ${steps.map((s) => s.code).join(' > ')}`);
  }

  const [[counts]] = await conn.query(
    `SELECT (SELECT COUNT(*) FROM cf_operations WHERE company_id = ? AND deleted_at IS NULL) AS operations,
            (SELECT COUNT(*) FROM cf_operation_flows WHERE company_id = ? AND deleted_at IS NULL) AS flows,
            (SELECT COUNT(*) FROM cf_operation_flow_steps WHERE company_id = ? AND deleted_at IS NULL) AS steps,
            (SELECT COUNT(*) FROM cf_operation_machine_rules WHERE company_id = ? AND deleted_at IS NULL) AS rules`,
    [COMPANY, COMPANY, COMPANY, COMPANY],
  );
  const [[{ carried }]] = await conn.query(
    `SELECT COUNT(*) AS carried FROM cf_operation_flow_steps s
      WHERE s.company_id = ? AND s.deleted_at IS NULL
        AND EXISTS (SELECT 1 FROM cf_operation_machine_rules r
                     WHERE r.company_id = s.company_id AND r.operation_id = s.operation_id
                       AND r.subject_type = 'classification' AND r.deleted_at IS NULL)`,
    [COMPANY],
  );
  say(`\n   ${counts.operations} operations · ${counts.flows} flows · ${counts.steps} steps `
    + `(${carried} of them reach a machine type through their operation) · ${counts.rules} machine rules`);

  const notActive = flows.filter((f) => f.status !== 'active');
  if (notActive.length) refusals.push(`not active: ${notActive.map((f) => `${f.code} (${f.status})`).join(', ')}`);
  return { notActive };
}

function report() {
  if (extras.length) {
    say(`\n-- ${extras.length} steps on a flow that the source does not have --`);
    say('   Left alone, not deleted: the source may have shrunk, or somebody added them.');
    for (const x of extras) say(`   ${String(x.flow).padEnd(16)} sequence ${String(x.sequence).padStart(4)}  operation id ${x.operationId}`);
  }
  if (pending.length) {
    say(`\n-- ${pending.length} machine rules waiting on a machine type --`);
    say('   No machine type of this company carries these names.');
    for (const p of pending) say(`   ${p}`);
    if (machineTypes.length) {
      say(`\n   The ${machineTypes.length} machine types that DO exist:`);
      for (const n of [...machineTypes].sort((a, b) => a.depth - b.depth || a.code.localeCompare(b.code))) {
        say(`   ${'  '.repeat(n.depth)}${String(n.code).padEnd(14 - n.depth * 2)} ${n.name}`);
      }
      say('\n   These are two different vocabularies, so running this script again changes nothing');
      say('   on its own: decide the mapping, write it into MACHINE_TYPE_ALIASES, then re-run.');
    } else {
      say('\n   No machine types exist yet. Run this script again once they do and only these');
      say('   rules are added — nothing else is touched.');
    }
  }
  if (refusals.length) {
    say(`\n-- ${refusals.length} refusals --`);
    for (const r of refusals) say(`   ${r}`);
  }
  say(`\n  created: ${JSON.stringify(tally.created)}`);
  say(`  updated: ${JSON.stringify(tally.updated)}`);
  say(`  reused : ${JSON.stringify(tally.reused)}`);
}

// --- run -------------------------------------------------------------------------

try {
  const { opRows, flows, resourceTypes } = loadSource();
  conn = await pool.getConnection();
  await conn.beginTransaction();
  attachNodeCache(conn);
  say(`cf_erp operations and flows -> company ${COMPANY}`);
  say(`   source: ${opRows.length} operations, ${[...flows.values()].reduce((n, s) => n + s.length, 0)} steps over ${flows.size} flows`);
  const opByCode = await buildOperations(opRows);
  await buildMachineRules(opByCode, resourceTypes);
  await buildFlows(flows, opByCode);
  detachNodeCache(conn);
  await conn.commit();
  attachNodeCache(conn);
  const { notActive } = await verify();
  report();
  say(`\ndone${notActive.length ? ' — with flows that are not active' : ''}.`);
  if (notActive.length) process.exitCode = 1;
} catch (e) {
  if (conn) await conn.rollback();
  console.error('\nFAILED:', e.code ?? '', e.message, e.problems ?? '');
  process.exitCode = 1;
} finally { if (conn) { detachNodeCache(conn); conn.release(); } await pool.end(); }
