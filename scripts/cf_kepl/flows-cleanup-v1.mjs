/**
 * flows-cleanup-v1.mjs — operations and flows tidied, flows per BOM level with cross-level waits,
 * definitions' default flows, and the released KEPL lines re-released onto them (user, 2026-10-10:
 * "remove all those CG and all in operations and flows. And redo the flow to match what's
 * meaningful at every level … change the default flows in the definitions"; answers: finishing per
 * segment after the span's dismantling, line matching at line level with the segments waiting for
 * it, trial assembly at span level, bracings and seismic stoppers not trial-assembled, re-release).
 *
 *   OPERATIONS  "CG-" dropped from every code (CG-STIFFFIT-2 → STIFFFIT-FLIP, CG-BRACEFIT → XFRAMEFIT
 *               with a 240 min rule on Arc welding); CG-WELDTBD and the unused generic ones deleted;
 *               CRNMV, EDGEP, PQC (only in the old released steps) made inactive.
 *   FLOWS       SPAN, GIRDER-LINE, GIRDER-SEGMENT, DIAPHRAGM, SPLICE-OUTER, SPLICE-INNER, HOLED-PART,
 *               BRACING, SEISMIC-STOPPER, CUT-PLATE, CUT-SECTION, with their waits (see FLOWS below);
 *               every old flow deleted (soft — released items keep their row).
 *   DEFAULTS    template definitions point at the new flows (plain parts and sets: none); the BOM
 *               lines that named an old flow are re-pointed; cut plates and the cut-plate / cut-section
 *               settings follow.
 *   RE-RELEASE  each released line is taken back and released again on the new flows; the one
 *               started step (a stiffener fit-up) is carried to its new step with its start, machine,
 *               events and work session.
 *
 *   node scripts/cf_kepl/flows-cleanup-v1.mjs --company 30005            (dry run: rolled back)
 *   node scripts/cf_kepl/flows-cleanup-v1.mjs --company 30005 --apply    (commits)
 */
const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const COMPANY = Number(arg('company'));
const APPLY = process.argv.includes('--apply');
if (!Number.isInteger(COMPANY)) throw new Error('Usage: --company <id> [--apply]');

const { pool } = await import('../../db.js');
await import('../../apps/cf_erp/services/codegenProvider.js');
const flowSvc = await import('../../apps/cf_erp/services/flowService.js');
const { createTimingRule } = await import('../../apps/cf_erp/services/operationService.js');
const { syncRecordsUsingFlows } = await import('../../apps/cf_erp/services/flowSpecService.js');
const { releaseLine, unrelease } = await import('../../apps/cf_erp/services/releaseService.js');

const db = await pool.getConnection();
const c = { companyId: COMPANY, userId: null };
const say = (...a) => console.log(...a);
const rows = async (sql, p = []) => (await db.query(sql, [COMPANY, ...p]))[0];
const one = async (sql, p = []) => (await rows(sql, p))[0] ?? null;
const t0 = Date.now();
const lap = () => `${((Date.now() - t0) / 1000).toFixed(0)}s`;

// ---------------------------------------------------------------------------- the plan
const RENAME = { 'CG-STIFFFIT-2': 'STIFFFIT-FLIP', 'CG-BRACEFIT': 'XFRAMEFIT', PQC: 'PARTQC', FQC: 'SETCHECK' };
// Every made piece needs a flow (release refuses one without): plain parts get a QC step, sets a completion check.
const RENAME_NAME = { PARTQC: 'Part QC (dimensional)', SETCHECK: 'Set completion check', XFRAMEFIT: 'X-frame / bracing fit-up' };
const DELETE_OPS = ['CG-WELDTBD', 'ASSY', 'BLAST', 'CRNTN', 'Cut', 'DRILL', 'METAL', 'PAINT', 'SAW', 'TUG', 'WQC'];
const INACTIVE_OPS = ['CRNMV', 'EDGEP'];
const SPLICE_OUTER = ['CP', 'WCP', 'TIC', 'BIC', 'BOP', 'TOS', 'BOS', 'WSP'];
const SPLICE_INNER = ['TIS', 'BIS'];
// steps: [operation, waits[]]; a wait: { rel, def?: short name(s), op?, status? }
const FLOWS = [
  { code: 'SPAN', name: 'Span — trial assembly, dismantling, dispatch', steps: [
    ['TRIALASM', [
      { rel: 'descendants', def: ['GS'], op: 'STUDWELD' },
      { rel: 'children', def: ['EDP', 'IDP'], op: 'MIGWELD' },
      { rel: 'descendants', def: SPLICE_OUTER, op: 'CNCDRILL' },
      { rel: 'descendants', def: SPLICE_INNER, op: 'MANDRILL-INNER' },
    ]],
    ['DISMANTLE', []],
    ['DISPATCH', [
      { rel: 'descendants', def: ['GS'], op: 'PAINT' },
      { rel: 'children', def: ['EDP', 'IDP'], op: 'PAINT' },
      { rel: 'descendants', def: [...SPLICE_OUTER, ...SPLICE_INNER], op: 'METALLIZE' },
    ]],
  ] },
  { code: 'GIRDER-LINE', name: 'Girder line — line matching', steps: [
    ['LINEMATCH', [{ rel: 'children', def: ['GS'], op: 'JACKBEND' }]],
  ] },
  { code: 'GIRDER-SEGMENT', name: 'Girder segment', steps: [
    ['HBFIT', []], ['SAWWELD', []], ['JACKBEND', []],
    ['MANDRILL', [{ rel: 'parent', op: 'LINEMATCH' }]],
    ['STIFFFIT', []], ['MIGWELD', []], ['FLIPGIRDER', []], ['STIFFFIT-FLIP', []], ['MIGWELD', []],
    ['MANDRILL-TOP', []], ['MANDRILL-BOTTOM', []], ['STUDWELD', []],
    ['BLAST', [{ rel: 'ancestor', def: ['CG'], op: 'DISMANTLE' }]], ['METALLIZE', []], ['PAINT', []],
  ] },
  { code: 'DIAPHRAGM', name: 'Diaphragm', steps: [
    ['IDEDFIT', []], ['SAWWELD', []], ['ARCWELD', []], ['MIGWELD', []],
    ['BLAST', [{ rel: 'ancestor', def: ['CG'], op: 'DISMANTLE' }]], ['METALLIZE', []], ['PAINT', []],
  ] },
  { code: 'SPLICE-OUTER', name: 'Outer splice / cover plate', steps: [
    ['CNCDRILL', []], ['BLAST', [{ rel: 'ancestor', def: ['CG'], op: 'DISMANTLE' }]], ['METALLIZE', []],
  ] },
  { code: 'SPLICE-INNER', name: 'Inner splice plate', steps: [
    ['MANDRILL', []], ['MANDRILL-INNER', []], ['BLAST', [{ rel: 'ancestor', def: ['CG'], op: 'DISMANTLE' }]], ['METALLIZE', []],
  ] },
  { code: 'HOLED-PART', name: 'Holed part — manual drilling', steps: [['MANDRILL', []]] },
  { code: 'BRACING', name: 'Bracing — fit-up, welding, finishing', steps: [['XFRAMEFIT', []], ['MIGWELD', []], ['BLAST', []], ['METALLIZE', []], ['PAINT', []]] },
  { code: 'SEISMIC-STOPPER', name: 'Seismic stopper — finishing', steps: [['BLAST', []], ['METALLIZE', []], ['PAINT', []]] },
  { code: 'PLAIN-PART', name: 'Plain part — dimensional QC (its cutting is on the cut piece)', steps: [['PARTQC', []]] },
  { code: 'SPLICE-SET', name: 'Splice set — completion check', steps: [['SETCHECK', []]] },
  { code: 'CUT-PLATE', name: 'Cut piece from a plate nest — CNC plasma', steps: [['CNCP-CUT', []]] },
  { code: 'CUT-SECTION', name: 'Cut piece from a section — gas cutting', steps: [['GASCUT', []]] },
];
const DEF_FLOW = {
  CG: 'SPAN', L: 'GIRDER-LINE', GS: 'GIRDER-SEGMENT', EDP: 'DIAPHRAGM', IDP: 'DIAPHRAGM',
  ...Object.fromEntries(SPLICE_OUTER.map((s) => [s, 'SPLICE-OUTER'])), ...Object.fromEntries(SPLICE_INNER.map((s) => [s, 'SPLICE-INNER'])),
  IDW: 'HOLED-PART', ISH: 'HOLED-PART', ESH: 'HOLED-PART', BSH: 'HOLED-PART', SP: 'HOLED-PART', GSP: 'HOLED-PART',
  BLB: 'BRACING', STP: 'SEISMIC-STOPPER',
  SPLC: 'SPLICE-SET', STO: 'SPLICE-SET', STI: 'SPLICE-SET', SBO: 'SPLICE-SET', SBI: 'SPLICE-SET', SWB: 'SPLICE-SET',
};
/** Any other plate or profile part definition: a plain part. */
const PART_NODES = ['Plate part', 'Profile part'];
// BOM lines that named an old flow → the new one (null = take the child's own).
const LINE_FLOW = { 'CG-HOLEDPART': 'HOLED-PART', 'CG-BRACEGUSSET': 'HOLED-PART', 'CG-BLB': 'BRACING', 'CG-PLATEPART': null, 'CG-BRACEANGLE': null };
const LINE_FLOW_STP = (childName) => (/SEISMIC STOPPER/i.test(childName) ? 'SEISMIC-STOPPER' : null);

try {
  await db.beginTransaction();

  // ---------------------------------------------------------------- 1. take the releases back
  say('1. Releases taken back');
  const releases = await rows("SELECT r.id, r.order_line_id, r.finished_area_id, o.code, l.line_no FROM cf_production_releases r JOIN cf_sales_order_lines l ON l.id = r.order_line_id JOIN cf_sales_orders o ON o.id = r.order_id WHERE r.company_id = ? AND r.deleted_at IS NULL ORDER BY r.id");
  const started = await rows(
    `SELECT s.id, s.operation_id, s.machine_id, s.started_at, s.state, pi.code AS piece, pi.release_id, o.code AS op
       FROM cf_production_steps s JOIN cf_production_items pi ON pi.id = s.production_item_id JOIN cf_operations o ON o.id = s.operation_id
      WHERE s.company_id = ? AND s.deleted_at IS NULL AND (s.state <> 'pending' OR s.started_at IS NOT NULL OR s.qty_good > 0 OR s.qty_scrap > 0)`);
  for (const s of started) {
    if (s.state !== 'in_progress') throw new Error(`Step ${s.id} (${s.piece} ${s.op}) is ${s.state} — only an in-progress step with nothing reported is carried over.`);
    await db.query("UPDATE cf_production_steps SET state = 'pending', started_at = NULL WHERE id = ?", [s.id]);
  }
  for (const r of releases) { await unrelease(db, c, r.id); say(`   ${r.code} line ${r.line_no}: release ${r.id} taken back`); }
  say(`   ${started.length} started step(s) to carry over: ${started.map((s) => `${s.piece} ${s.op}`).join(', ') || 'none'}  (${lap()})`);

  // ---------------------------------------------------------------- 2. operations
  say('\n2. Operations');
  const ops = await rows('SELECT id, code, name, status FROM cf_operations WHERE company_id = ? AND deleted_at IS NULL');
  const byCode = new Map(ops.map((o) => [o.code, o]));
  // Old flows go first, so nothing names the operations being deleted.
  const oldFlows = await rows('SELECT id, code FROM cf_operation_flows WHERE company_id = ? AND deleted_at IS NULL');
  const oldFlowIds = oldFlows.map((f) => Number(f.id));
  const oldFlowCode = new Map(oldFlows.map((f) => [Number(f.id), f.code]));
  if (oldFlowIds.length) {
    await db.query('UPDATE cf_step_wait_rules w JOIN cf_operation_flow_steps s ON s.id = w.flow_step_id SET w.deleted_at = NOW() WHERE s.company_id = ? AND s.flow_id IN (?) AND w.deleted_at IS NULL', [COMPANY, oldFlowIds]);
  }
  for (const code of DELETE_OPS) {
    const o = byCode.get(code);
    if (!o) continue;
    const [[u]] = await db.query('SELECT COUNT(*) n FROM cf_production_steps WHERE company_id = ? AND operation_id = ? AND deleted_at IS NULL', [COMPANY, o.id]);
    if (Number(u.n)) throw new Error(`${code} is used by ${u.n} live production step(s) — not deleted.`);
    await db.query('UPDATE cf_operation_flow_steps SET deleted_at = NOW() WHERE company_id = ? AND operation_id = ? AND deleted_at IS NULL', [COMPANY, o.id]);
    await db.query('UPDATE cf_operation_machine_rules SET deleted_at = NOW() WHERE company_id = ? AND operation_id = ? AND deleted_at IS NULL', [COMPANY, o.id]);
    await db.query('UPDATE cf_operations SET deleted_at = NOW() WHERE company_id = ? AND id = ?', [COMPANY, o.id]);
    byCode.delete(code);
  }
  say(`   deleted: ${DELETE_OPS.filter((x) => ops.some((o) => o.code === x)).join(', ')}`);
  for (const code of INACTIVE_OPS) if (byCode.get(code)) await db.query("UPDATE cf_operations SET status = 'inactive' WHERE company_id = ? AND id = ?", [COMPANY, byCode.get(code).id]);
  say(`   inactive (only the old released steps used them): ${INACTIVE_OPS.join(', ')}`);
  const renamed = [];
  for (const o of [...byCode.values()]) {
    if (!o.code.startsWith('CG-') && !RENAME[o.code]) continue;
    const to = RENAME[o.code] ?? o.code.slice(3);
    if (byCode.has(to)) throw new Error(`Cannot rename ${o.code}: ${to} already exists.`);
    await db.query('UPDATE cf_operations SET code = ? WHERE company_id = ? AND id = ?', [to, COMPANY, o.id]);
    byCode.delete(o.code); byCode.set(to, { ...o, code: to });
    renamed.push(`${o.code}→${to}`);
  }
  say(`   renamed: ${renamed.join(', ')}`);
  for (const [code, name] of Object.entries(RENAME_NAME)) await db.query("UPDATE cf_operations SET name = ?, status = 'active' WHERE company_id = ? AND id = ?", [name, COMPANY, byCode.get(code).id]);
  const xf = byCode.get('XFRAMEFIT');
  const arc = await one("SELECT id FROM cf_classification_nodes WHERE company_id = ? AND scope = 'machine' AND deleted_at IS NULL AND name = 'Arc welding'");
  if (!(await one('SELECT id FROM cf_operation_machine_rules WHERE company_id = ? AND operation_id = ? AND deleted_at IS NULL', [xf.id]))) {
    await createTimingRule(db, c, xf.id, { subjectType: 'classification', subjectId: arc.id, workExpression: '240' });
  }
  say('   XFRAMEFIT runs on Arc welding, 240 min (12 h = 3 fit-ups)');

  // ---------------------------------------------------------------- 3. flows
  say('\n3. Flows');
  const defs = new Map((await rows(
    `SELECT m.id, m.short_name FROM cf_master_records m JOIN cf_definition_details dd ON dd.master_id = m.id AND dd.deleted_at IS NULL AND dd.definition_type = 'template'
      WHERE m.company_id = ? AND m.deleted_at IS NULL AND m.short_name IS NOT NULL`)).map((d) => [d.short_name, Number(d.id)]));
  const defId = (s) => { const id = defs.get(s); if (!id) throw new Error(`No template definition ${s}`); return id; };
  const opId = (code) => { const o = byCode.get(code); if (!o) throw new Error(`No operation ${code}`); return o.id; };
  const newFlow = new Map();
  for (const f of FLOWS) {
    const made = await flowSvc.createFlow(db, c, { code: f.code, name: f.name });
    newFlow.set(f.code, made.id);
    let seq = 0;
    for (const [op, waits] of f.steps) {
      seq += 10;
      const flow = await flowSvc.addStep(db, c, made.id, { operationId: opId(op), sequence: seq });
      const step = flow.steps.find((s) => s.sequence === seq);
      for (const w of waits) {
        for (const d of (w.def ?? [null])) {
          if (d && !defs.has(d)) { say(`   ! ${f.code} ${op}: no definition ${d} — that wait is left out`); continue; }
          await flowSvc.addWaitRule(db, c, step.id, { relation: w.rel, targetDefinitionId: d ? defId(d) : null, targetOperationId: opId(w.op), requiredStatus: w.status ?? 'done' });
        }
      }
    }
    await flowSvc.setFlowStatus(db, c, made.id, 'active');
    const shown = await flowSvc.getFlow(db, COMPANY, made.id);
    say(`   ${f.code}: ${shown.steps.map((s) => s.operation.code + (s.waits.length ? `⏳${s.waits.length}` : '')).join(' → ')}`);
    for (const s of shown.steps) for (const w of s.waits) say(`        ${s.operation.code}: ${w.text.replace(/ Where a flow does it more than once.*$/, '')}`);
  }

  // ---------------------------------------------------------------- 4. defaults
  say('\n4. Default flows and BOM lines');
  const tmpl = await rows(
    `SELECT m.id, m.short_name, m.default_flow_id, n.name AS node FROM cf_master_records m JOIN cf_definition_details dd ON dd.master_id = m.id AND dd.deleted_at IS NULL AND dd.definition_type = 'template'
       LEFT JOIN cf_classification_nodes n ON n.id = m.classification_id
      WHERE m.company_id = ? AND m.deleted_at IS NULL`);
  let set = 0; let cleared = 0;
  for (const d of tmpl) {
    const code = DEF_FLOW[d.short_name] ?? (PART_NODES.includes(d.node) ? 'PLAIN-PART' : null);
    const to = code ? newFlow.get(code) : null;
    if (Number(d.default_flow_id ?? 0) === Number(to ?? 0)) continue;
    await db.query('UPDATE cf_master_records SET default_flow_id = ? WHERE id = ?', [to, d.id]);
    if (to) set++; else cleared++;
  }
  say(`   definitions: ${set} set to a new flow, ${cleared} cleared (the bowstring assemblies, which had none)`);
  const lines = await rows(
    `SELECT bl.id, bl.operation_flow_id, cm.name AS child FROM cf_bom_lines bl JOIN cf_master_records cm ON cm.id = bl.child_id
      WHERE bl.company_id = ? AND bl.deleted_at IS NULL AND bl.operation_flow_id IN (?)`, [oldFlowIds.length ? oldFlowIds : [0]]);
  const lineTally = {};
  for (const l of lines) {
    const old = oldFlowCode.get(Number(l.operation_flow_id));
    const toCode = old === 'CG-STP' ? LINE_FLOW_STP(l.child) : (LINE_FLOW[old] ?? null);
    await db.query('UPDATE cf_bom_lines SET operation_flow_id = ? WHERE id = ?', [toCode ? newFlow.get(toCode) : null, l.id]);
    const k = `${old} → ${toCode ?? 'its own'}`; lineTally[k] = (lineTally[k] ?? 0) + 1;
  }
  for (const [k, n] of Object.entries(lineTally)) say(`   BOM lines ${k}: ${n}`);
  const [cp] = await db.query('UPDATE cf_master_records SET default_flow_id = ? WHERE company_id = ? AND deleted_at IS NULL AND default_flow_id IN (?)', [newFlow.get('CUT-PLATE'), COMPANY, oldFlowIds.length ? oldFlowIds : [0]]);
  say(`   cut plates and other items on an old flow → CUT-PLATE: ${cp.affectedRows}`);
  await flowSvc.setCutPlateFlow(db, c, { flowId: newFlow.get('CUT-PLATE') });
  await flowSvc.setCutSectionFlow(db, c, { flowId: newFlow.get('CUT-SECTION') });
  say('   settings: new cut plates → CUT-PLATE, cut sections → CUT-SECTION');
  for (const id of oldFlowIds) await flowSvc.deleteFlow(db, c, id);
  say(`   old flows deleted: ${oldFlows.map((f) => f.code).join(', ')}`);
  await syncRecordsUsingFlows(db, c, [...newFlow.values()]);
  say(`   values the new flows read: synced  (${lap()})`);

  // ---------------------------------------------------------------- 5. release again
  say('\n5. Released again');
  for (const r of releases) {
    const out = await releaseLine(db, c, r.order_line_id, { finishedAreaId: r.finished_area_id });
    const rel = await one('SELECT id FROM cf_production_releases WHERE company_id = ? AND order_line_id = ? AND deleted_at IS NULL', [r.order_line_id]);
    const [[n]] = await db.query('SELECT COUNT(DISTINCT pi.id) items, COUNT(s.id) steps FROM cf_production_items pi LEFT JOIN cf_production_steps s ON s.production_item_id = pi.id AND s.deleted_at IS NULL WHERE pi.release_id = ? AND pi.deleted_at IS NULL', [rel.id]);
    const [byOp] = await db.query('SELECT o.code, COUNT(*) n FROM cf_production_steps s JOIN cf_production_items pi ON pi.id = s.production_item_id JOIN cf_operations o ON o.id = s.operation_id WHERE pi.release_id = ? AND s.deleted_at IS NULL GROUP BY o.code ORDER BY o.code', [rel.id]);
    say(`   ${r.code} line ${r.line_no}: release ${rel.id}, ${n.items} pieces, ${n.steps} steps  (${lap()})`);
    say(`      ${byOp.map((x) => `${x.code} ${x.n}`).join(', ')}`);
    void out;
  }
  for (const s of started) {
    const ns = await one(
      `SELECT s.id FROM cf_production_steps s JOIN cf_production_items pi ON pi.id = s.production_item_id AND pi.deleted_at IS NULL
         JOIN cf_production_releases r ON r.id = pi.release_id AND r.deleted_at IS NULL
        WHERE s.company_id = ? AND s.deleted_at IS NULL AND pi.code = ? AND s.operation_id = ? ORDER BY s.sequence LIMIT 1`, [s.piece, s.operation_id]);
    if (!ns) { say(`   ! ${s.piece} ${s.op}: no such step after re-release — its start is NOT carried over`); continue; }
    await db.query("UPDATE cf_production_steps SET state = 'in_progress', started_at = ?, machine_id = ? WHERE id = ?", [s.started_at, s.machine_id, ns.id]);
    await db.query('UPDATE cf_step_events SET step_id = ? WHERE company_id = ? AND step_id = ?', [ns.id, COMPANY, s.id]);
    await db.query('UPDATE cf_work_sessions SET step_id = ? WHERE company_id = ? AND step_id = ?', [ns.id, COMPANY, s.id]);
    say(`   carried over: ${s.piece} ${s.op} started ${s.started_at.toISOString?.() ?? s.started_at} → step ${ns.id}`);
  }

  if (APPLY) { await db.commit(); say(`\nCOMMITTED  (${lap()})`); } else { await db.rollback(); say(`\nDRY RUN — rolled back. Add --apply to keep it.  (${lap()})`); }
} catch (err) {
  await db.rollback().catch(() => {});
  console.error('ERROR', err.message, err.problems ? JSON.stringify(err.problems).slice(0, 3000) : '', err.stack?.split('\n').slice(1, 4).join(' | '));
  process.exitCode = 1;
} finally {
  db.release();
  await pool.end();
}
