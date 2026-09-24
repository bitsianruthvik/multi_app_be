/**
 * cf_assembly_flows.mjs — the two flows the bridge order still had no answer
 * for: the DIAPHRAGM, and the three things that are only SETS of other things.
 *
 * cf_ops_import.mjs brought in the five fab_erp flows, which cover a cut plate,
 * a part and a girder segment. Four kinds of thing on this order were left with
 * no way of being made, and they are not one question but two.
 *
 * 1. THE DIAPHRAGM — a real flow, a short one
 * -------------------------------------------
 * A diaphragm is a small welded assembly: flanges and a web fitted up, tacked,
 * welded, inspected, blasted and painted. It is built here out of the SAME
 * operations as the girder segment, because it is the same shop doing the same
 * joints on a smaller piece — but it is NOT the 17-step girder treatment. A
 * girder segment is welded, craned over and welded again; a diaphragm is small
 * enough to weld in one pass, so there is no crane TURN, no second SAW and no
 * metalizing. The crane MOVES stay: the piece really does travel between the
 * fit-up bay, the welder, the blast chamber and the paint booth, and the moves
 * are what make the tracker match the shop floor.
 *
 * 2. THE SETS — a splice set, a girder line, a bridge span
 * --------------------------------------------------------
 * None of the three is built in the shop. A splice set is five cover plates, a
 * kit; a girder line is segments bolted together at SITE; a span is the
 * deliverable. The honest description is "no flow" — but a temporary item is
 * always `sourcing = 'make'` (masterRecordService refuses a temporary any other
 * sourcing), and release will not make a thing with no flow. Three reasons say
 * that release is RIGHT and the flow is what was missing:
 *
 *   a. The root of a sales line must finish. stockFinished() in
 *      releaseService.js waits for the LAST STEP of the top piece to be done,
 *      and only then receives the span into the dispatch area, moves the line's
 *      made_qty and earmarks it for the customer. A span with no step is a span
 *      that can never be delivered — `if (!steps.length ... ) return null`.
 *
 *   b. A set can hold MATERIAL. A girder line carries 1,803 shear studs; a
 *      material requirement is gated on `nodes[r.nodeK].stepKs[0]`, the piece's
 *      first step. With no step there is nothing for the studs to gate, so
 *      nobody is ever told they have to be there.
 *
 *   c. expand() drops the whole subtree of a flowless node — its children AND
 *      the material under them. That is the shape of the defect the "made out
 *      of nothing" guard was added for. Making release walk past a flowless
 *      node is surgery on the one function that must never quietly lose steel.
 *
 * So the three sets get a flow of ONE step, and that step is a real operation
 * the shop already has — FQC, Final QC, at the QC station: the check that every
 * piece of the set is there, correct and free to move on. Nothing is invented,
 * nothing pretends the shop welds a bridge span together, and the tracker gets
 * the one line to tick that release needs. It is deliberately the same flow for
 * all three: they are the same act at three heights of the tree.
 *
 * Re-runnable. A flow is keyed on its CODE and a step on (operation, sequence)
 * — the same key uq_cofs_operation_seq uses — so a second run creates nothing.
 * A description this script wrote is brought back in line if it changed here;
 * one somebody has edited (the marker gone) is left alone.
 *
 *   cd multi_app_be && node scripts/cf_kepl/cf_assembly_flows.mjs
 */
import path from 'path';
import { pathToFileURL } from 'url';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
const flowSvc = await imp('apps/cf_erp/services/flowService.js');
const { attachNodeCache, detachNodeCache } = await imp('apps/cf_erp/lib/db.js');

const COMPANY = Number(process.env.CF_BRIDGE_COMPANY ?? 2);
const c = { companyId: COMPANY, userId: Number(process.env.CF_BRIDGE_USER ?? 22) };
const say = (...a) => console.log(...a);
const tally = { created: {}, reused: {}, updated: {} };
const bump = (bag, k, n = 1) => { bag[k] = (bag[k] ?? 0) + n; };
const refusals = [];

/** The mark that says a description came from here, so an edited one is left alone. */
const MARK = 'Written by cf_assembly_flows';

// --- what is built ------------------------------------------------------------
//
// Sequence in tens, as everywhere else, so a step can be put between two.
// A step NAME is given only where its operation repeats in the flow: planSteps()
// uses it instead of "(pass 2 of 4)", and four identical crane moves are exactly
// the case it was added for.

const FLOWS = [
  {
    code: 'DIAPH-FAB',
    name: 'Diaphragm — Assembly, Welding & Finishing',
    what: 'The short welded-assembly sequence for a diaphragm: fit up, tack, weld once, inspect, blast, paint. '
      + 'Same operations as the girder segment, without the crane turn, the second weld pass or the metalizing — '
      + 'a diaphragm is small enough to weld in one pass.',
    steps: [
      { seq: 10, op: 'CRNMV', name: 'to the fit-up bay' },
      { seq: 20, op: 'ASSY' },
      { seq: 30, op: 'TUG' },
      { seq: 40, op: 'CRNMV', name: 'to the welding bay' },
      { seq: 50, op: 'SAW' },
      { seq: 60, op: 'WQC' },
      { seq: 70, op: 'CRNMV', name: 'to the blast chamber' },
      { seq: 80, op: 'BLAST' },
      { seq: 90, op: 'CRNMV', name: 'to the paint booth' },
      { seq: 100, op: 'PAINT' },
      // Both girder flows end with a final check and a diaphragm is no different:
      // it is a finished sub-assembly that goes to store and later into a bridge,
      // so somebody signs it off before it leaves the paint booth.
      { seq: 110, op: 'FQC' },
    ],
  },
  {
    code: 'SET-CHECK',
    name: 'Set — Completion Check',
    what: 'One step, for a thing that is a SET of other things rather than a thing the shop builds: a splice set '
      + '(a kit of cover plates), a girder line (segments bolted together at site) and a bridge span (the '
      + 'deliverable). Its pieces are each made by their own flow; this is the check that they are all there, '
      + 'correct, and free to move on — and for the piece a line sells it is the step that finishes it into the '
      + 'dispatch area. Anything that is really WELDED belongs on a fabrication flow, not here.',
    steps: [
      { seq: 10, op: 'FQC', name: 'set complete' },
    ],
  },
];

const describe = (f) => `${f.what} ${MARK}.`;

let conn;

async function operationIndex() {
  const [rows] = await conn.query(
    "SELECT id, code, name, status FROM cf_operations WHERE company_id = ? AND deleted_at IS NULL", [COMPANY]);
  return new Map(rows.map((o) => [o.code, o]));
}

async function ensureFlow(f) {
  const want = describe(f);
  const [[have]] = await conn.query(
    'SELECT id, code, name, status, description FROM cf_operation_flows WHERE company_id = ? AND code = ? AND deleted_at IS NULL',
    [COMPANY, f.code],
  );
  if (have) {
    bump(tally.reused, 'flow');
    if (String(have.description ?? '').includes(MARK) && have.description !== want) {
      await flowSvc.updateFlow(conn, c, have.id, { description: want });
      bump(tally.updated, 'flow description');
    }
    return have.id;
  }
  const made = await flowSvc.createFlow(conn, c, { code: f.code, name: f.name, description: want });
  bump(tally.created, 'flow');
  return made.id;
}

/** The re-run key for a step: what uq_cofs_operation_seq keys on once the flow is fixed. */
const stepKey = (operationId, sequence) => `${operationId}@${sequence}`;

async function buildFlow(f, ops) {
  const flowId = await ensureFlow(f);
  const [existing] = await conn.query(
    'SELECT id, operation_id, sequence FROM cf_operation_flow_steps WHERE company_id = ? AND flow_id = ? AND deleted_at IS NULL',
    [COMPANY, flowId],
  );
  const onFlow = new Map(existing.map((r) => [stepKey(r.operation_id, r.sequence), r]));
  const wanted = new Set();

  for (const s of f.steps) {
    const op = ops.get(s.op);
    if (!op) { refusals.push(`${f.code} step ${s.seq}: there is no operation ${s.op} — run cf_ops_import.mjs first`); continue; }
    if (op.status !== 'active') { refusals.push(`${f.code} step ${s.seq}: operation ${s.op} is ${op.status}`); continue; }
    const key = stepKey(op.id, s.seq);
    wanted.add(key);
    if (onFlow.has(key)) { bump(tally.reused, 'flow step'); continue; }
    try {
      await flowSvc.addStep(conn, c, flowId, { operationId: op.id, sequence: s.seq, stepName: s.name ?? null });
      onFlow.set(key, { operation_id: op.id, sequence: s.seq });
      bump(tally.created, 'flow step');
    } catch (e) {
      refusals.push(`${f.code} step ${s.seq} (${s.op}): ${e.code ?? ''} ${e.message} ${(e.problems ?? []).join(' | ')}`.trim());
    }
  }
  // A step on the flow this script does not know about. Reported, never deleted
  // — somebody may have put it there on purpose.
  for (const [key, row] of onFlow) {
    if (!wanted.has(key)) refusals.push(`${f.code} also has a step at sequence ${row.sequence} that this script does not write — left alone`);
  }

  const [[state]] = await conn.query('SELECT status FROM cf_operation_flows WHERE company_id = ? AND id = ?', [COMPANY, flowId]);
  if (state.status === 'active') bump(tally.reused, 'flow already active');
  else {
    try {
      await flowSvc.setFlowStatus(conn, c, flowId, 'active');
      bump(tally.created, 'flow activated');
    } catch (e) {
      refusals.push(`${f.code} could not be activated: ${e.code ?? ''} ${e.message} ${(e.problems ?? []).join(' | ')}`.trim());
    }
  }
  say(`   ${f.code.padEnd(12)} ${String(f.steps.length).padStart(2)} step(s) -> ${String(onFlow.size).padStart(2)} on the flow`);
}

/** Every flow in the company, step by step, so a run says what the shop now has. */
async function verify() {
  say('\n-- every flow, step by step --');
  const [rows] = await conn.query(
    `SELECT f.code AS flow, f.name AS flow_name, f.status, s.sequence, s.step_name, o.code AS op, o.name AS op_name,
            (SELECT COUNT(*) FROM cf_master_records m WHERE m.company_id = f.company_id AND m.default_flow_id = f.id AND m.deleted_at IS NULL) AS used_by
       FROM cf_operation_flows f
       LEFT JOIN cf_operation_flow_steps s ON s.flow_id = f.id AND s.deleted_at IS NULL
       LEFT JOIN cf_operations o ON o.id = s.operation_id
      WHERE f.company_id = ? AND f.deleted_at IS NULL ORDER BY f.code, s.sequence, s.id`,
    [COMPANY],
  );
  let flow = null;
  for (const r of rows) {
    if (r.flow !== flow) {
      flow = r.flow;
      say(`\n   ${r.flow}  (${r.status}, named by ${r.used_by} record(s))  ${r.flow_name}`);
    }
    if (r.sequence == null) { say('      no steps'); continue; }
    say(`      ${String(r.sequence).padStart(4)}  ${String(r.op).padEnd(7)} ${r.op_name}${r.step_name ? `  — ${r.step_name}` : ''}`);
  }
}

conn = await pool.getConnection();
try {
  await conn.beginTransaction();
  attachNodeCache(conn);
  const ops = await operationIndex();
  say(`-- flows (company ${COMPANY}) --`);
  for (const f of FLOWS) {
    try { await buildFlow(f, ops); }
    catch (e) { refusals.push(`flow ${f.code}: ${e.code ?? ''} ${e.message} ${(e.problems ?? []).join(' | ')}`.trim()); }
  }
  detachNodeCache(conn);
  await conn.commit();

  attachNodeCache(conn);
  await verify();
  const line = (bag) => Object.entries(bag).map(([k, n]) => `${n} ${k}`).join(', ') || 'nothing';
  say(`\ncreated: ${line(tally.created)}`);
  say(`updated: ${line(tally.updated)}`);
  say(`already there: ${line(tally.reused)}`);
  if (refusals.length) { say(`\n${refusals.length} thing(s) this run would not do:`); for (const r of refusals) say(`   ${r}`); }
  say('\nNow run cf_wire_flows.mjs to say which records are made by them.');
} catch (e) {
  await conn.rollback();
  console.error('FAILED:', e.code ?? '', e.message, e.problems ?? '');
  process.exitCode = 1;
} finally {
  detachNodeCache(conn);
  conn.release();
  await pool.end();
}
