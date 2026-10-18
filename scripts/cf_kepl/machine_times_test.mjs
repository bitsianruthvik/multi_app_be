/**
 * machine_times_test.mjs — init.sql §58: a machine's own chart COUNTS.
 * (services/timeEstimateService.estimateOnMachine — the one writer of a step's machine and its
 * machine time; releaseService, floorService, plannerService, chartService, machineService hooks.)
 *
 *   cd multi_app_be && node scripts/cf_kepl/machine_times_test.mjs
 *
 * EVERYTHING HAPPENS INSIDE ONE TRANSACTION THAT IS ROLLED BACK, on fixtures this run owns
 * (lib/buyingFixture.girder + a machine family of its own); the last thing it does is re-count
 * every cf_ table. Nothing of the tenant is borrowed; line 923 is never touched.
 *
 * THE FIXTURE. One machine type with two machines, FAST and SLOW. The rule of the fixture's one
 * operation:   setup 5 min a run · work = 60 / machine.RATE + machine.HANDLING   (min a piece)
 *   RATE      a number: the type's is 60 a hour; SLOW has its OWN 30 (later 20)
 *   HANDLING  a chart read by the piece's Variant (cleat, bracket, segment, girder): the type's
 *             gives 1 min for every one; SLOW later gets its own, with no answer for a girder
 * So the standard is 2 min a piece and SLOW takes 3 (60/30 + 1).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool } from '../../db.js';
import '../../apps/cf_erp/services/codegenProvider.js';
import { attachNodeCache, detachNodeCache } from '../../apps/cf_erp/lib/db.js';
import { harness, girder, quietCodes } from './lib/buyingFixture.mjs';
import * as T from '../../apps/cf_erp/services/timeEstimateService.js';
import * as REL from '../../apps/cf_erp/services/releaseService.js';
import * as PL from '../../apps/cf_erp/services/plannerService.js';
import * as F from '../../apps/cf_erp/services/floorService.js';
import * as WO from '../../apps/cf_erp/services/workOrderService.js';
import * as OPS from '../../apps/cf_erp/services/operationService.js';
import * as CH from '../../apps/cf_erp/services/chartService.js';
import * as MC from '../../apps/cf_erp/services/machineService.js';
import { checkForBuilder, builderContext } from '../../apps/cf_erp/services/formulaBuilderService.js';
import { backfill } from './machine-times-backfill.mjs';

if (!/^(localhost|127\.0\.0\.1|::1)$/.test(process.env.DB_HOST ?? 'localhost')) throw new Error('This suite is local only.');
const COMPANY = Number(process.env.CF_MT_COMPANY ?? 2);
const tag = `MT${Date.now().toString(36).toUpperCase()}`;
const H = harness(pool);
const { ok, section, refusal, j } = H;
const near = (a, b) => a != null && b != null && Math.abs(Number(a) - Number(b)) < 1e-6;
const said = (e, re) => !!e && (re.test(e.message) || (e.problems ?? []).some((p) => re.test(p)));
const before = await H.counts();
const db = await pool.getConnection();

try {
  await db.beginTransaction();
  attachNodeCache(db);
  const [[user]] = await db.query('SELECT id FROM users WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [COMPANY]);
  const c = { companyId: COMPANY, userId: user?.id ?? null, canManage: true, canApprove: true, isAdmin: true };
  const insert = async (table, body) => (await db.query(`INSERT INTO ${table} SET ?`, body))[0].insertId;
  await quietCodes(db, COMPANY);
  await db.query('INSERT INTO cf_floor_settings (company_id, timezone) VALUES (?, ?) ON DUPLICATE KEY UPDATE timezone = VALUES(timezone)', [COMPANY, 'Asia/Kolkata']);

  /* ------------------------------------------------------------------------ */
  section('0. Fixture: a girder order, one machine type, two machines, a rate and a chart');
  const G = await girder(db, c, tag);
  const node = (suffix, parent_id = null, depth = 0) => insert('cf_classification_nodes', { company_id: COMPANY, code: `${tag}-${suffix}`, name: `${tag} ${suffix}`, scope: 'machine', parent_id, depth });
  const fam = await node('MF');
  const sub = await node('MS', fam, 1);
  const TYPE = await node('MT', sub, 2);
  const machine = (suffix) => insert('cf_machines', { company_id: COMPANY, code: `${tag}-${suffix}`, name: `${tag} ${suffix}`, classification_id: TYPE });
  const FAST = await machine('FAST');
  const SLOW = await machine('SLOW');
  const RATE = `${tag}_RATE`;
  const rateSpec = await insert('cf_specifications', { company_id: COMPANY, code: RATE, name: `${tag} rate`, data_type: 'number' });
  await insert('cf_spec_assignments', { company_id: COMPANY, specification_id: rateSpec, subject_type: 'classification', subject_id: fam, value_rule: 'defaulted' });
  await insert('cf_spec_values', { company_id: COMPANY, specification_id: rateSpec, subject_type: 'classification', subject_id: TYPE, value_number: 60, source: 'defaulted' });
  OPS.clearProductionMachines(COMPANY);

  // The variants of the fixture's pieces (the chart is read by them).
  const [tpl] = await db.query(
    `SELECT m.id, n.id AS node_id, n.name AS node_name FROM cf_master_records m JOIN cf_classification_nodes n ON n.id = m.classification_id WHERE m.id IN (?)`,
    [[G.CL.id, G.BK.id, G.SG.id, G.GR.id]]);
  const nodeOf = (id) => tpl.find((t) => t.id === id);
  const V = { part: nodeOf(G.CL.id), seg: nodeOf(G.SG.id), assy: nodeOf(G.GR.id) };
  ok('the fixture\'s parts, segments and girders sit in three variants', new Set([V.part.node_id, V.seg.node_id, V.assy.node_id]).size === 3 && nodeOf(G.BK.id).node_id === V.part.node_id);
  const kindOfNode = new Map([[V.part.node_id, 'part'], [V.seg.node_id, 'seg'], [V.assy.node_id, 'assy']]);
  const chartRows = (o) => [[V.part.node_name, o.part], [V.seg.node_name, o.seg], [V.assy.node_name, o.assy]];
  const made = await CH.createChart(db, c, { type: 'classification', id: TYPE }, { name: `${tag} handling`, resultUnit: 'min', inputs: [{ level: 'VARIANT' }], rows: chartRows({ part: 1, seg: 1, assy: 1 }) });
  const CHART = made.chartId;
  const rule = await OPS.createTimingRule(db, c, G.op.id, { subjectType: 'classification', subjectId: TYPE, setupMinutes: 5, workExpression: `60 / machine.${RATE} + machine.${made.code}` });
  ok('the rule: setup 5, work = 60 / RATE + the handling chart by its name', !!rule && rule.eligible === true, j(rule?.work));
  // What the numbers must be, worked out by hand from the fixture.
  const SETUP = 5;
  let typeChart = { part: 1, seg: 1, assy: 1 };
  let slowChart = null;                         // SLOW's own chart, once it has one
  let slowRate = 30;
  const std = (kind) => 60 / 60 + typeChart[kind];
  const onSlow = (kind) => 60 / slowRate + (slowChart ? slowChart[kind] : typeChart[kind]);
  // §76: setup is per quantity — a step's minutes = (setup + work) × quantity.
  const total = (work, qty) => (SETUP + work) * Number(qty);

  const stepsOf = async (lineId) => {
    const [rows] = await db.query(
      `SELECT s.id, s.state, s.quantity, s.machine_id, s.work_order_id, s.operation_id,
              s.est_setup_minutes AS es, s.est_work_minutes AS ew, s.est_minutes AS em,
              s.mach_setup_minutes AS ms, s.mach_work_minutes AS mw, s.mach_minutes AS mm, s.mach_machine_id AS mmid, s.eff_minutes AS eff,
              pi.order_piece_id, pi.item_id, pi.bom_line_id, pi.code, m.classification_id AS node_id
         FROM cf_production_steps s
         JOIN cf_production_items pi ON pi.id = s.production_item_id
         JOIN cf_production_releases r ON r.id = pi.release_id AND r.deleted_at IS NULL
         JOIN cf_master_records m ON m.id = pi.item_id
        WHERE r.order_line_id = ? AND s.deleted_at IS NULL ORDER BY s.id`, [lineId]);
    for (const r of rows) r.kind = kindOfNode.get(r.node_id) ?? null;
    return rows;
  };
  const stepRow = async (id) => (await db.query(
    `SELECT s.*, m.classification_id AS node_id FROM cf_production_steps s JOIN cf_production_items pi ON pi.id = s.production_item_id JOIN cf_master_records m ON m.id = pi.item_id WHERE s.id = ?`, [id]))[0][0];
  const release = async (o) => {
    const rel = await REL.releaseLine(db, c, o.lineId, { finishedAreaId: G.dispatch, view: 'none' });
    await db.query("UPDATE cf_production_releases SET created_at = '2026-09-01 00:00:00' WHERE company_id = ? AND id = ?", [COMPANY, rel.id]);
    // The production ledger takes a step's material when it starts: it is in stock and reserved.
    for (const it of [G.A, G.B, G.C]) await G.receive(it, 100);
    await REL.reserveRelease(db, c, rel.id);
    return rel;
  };
  const SLOW_CODE = `${tag}-SLOW`;

  // SLOW runs at its own rate — entered on the machine, through the machine screen's save.
  const own = await MC.setMachineValues(db, c, SLOW, [{ specCode: RATE, value: 30 }]);
  ok('SLOW has its own rate (30); nothing is planned on it yet, so nothing is re-timed', own.timeImpact?.steps === 0, j(own.timeImpact));

  /* ------------------------------------------------------------------------ */
  section('1. Release: the STANDARD on every step, no machine yet (two machines can do it)');
  const O1 = await G.girderOrder('O1', 1);
  await release(O1);
  let steps = await stepsOf(O1.lineId);
  ok('the released line has steps of every kind', steps.length >= 4 && ['part', 'seg', 'assy'].every((k) => steps.some((s) => s.kind === k)), j(steps.map((s) => [s.kind, Number(s.quantity)])));
  ok('standard = the TYPE\'s values: 60/60 + 1 = 2 min a piece, setup 5', steps.every((s) => near(s.ew, std(s.kind)) && near(s.es, SETUP) && near(s.em, total(std(s.kind), s.quantity))), j(steps.map((s) => [s.ew, s.em])));
  ok('no machine is on any step, and no machine time', steps.every((s) => s.machine_id == null && s.mm == null && s.mmid == null));
  ok('effective = standard while no machine is known', steps.every((s) => near(s.eff, s.em)));

  /* ------------------------------------------------------------------------ */
  section('2. The planner puts a unit on a machine: old → new minutes, and back');
  const UNIT = O1.units[0];
  const fnKey = String(TYPE);
  const snapWork = async (key) => { const s = await PL.getPlanner(db, COMPANY, { from: '2026-10-01' }); return s.units.find((u) => u.key === key)?.work?.[fnKey] ?? null; };
  const sumStd = steps.reduce((t, s) => t + Number(s.em), 0);
  const sumQty = steps.reduce((t, s) => t + Number(s.quantity), 0);
  let view = await PL.getUnitMachines(db, COMPANY, UNIT);
  const fnOf = (v) => v.functions.find((f) => f.key === fnKey);
  ok('the card has one machine type with its two machines', view.released && view.functions.length === 1 && fnOf(view).machines.length === 2, j(view.functions.map((f) => [f.name, f.machines.length])));
  const mOf = (v, id) => fnOf(v).machines.find((m) => m.id === id);
  ok('minutes now = the standard, and no machine is picked', near(fnOf(view).minutesNow, sumStd) && near(fnOf(view).standardMinutes, sumStd) && fnOf(view).machineId == null);
  ok('FAST would take the same (no own chart)', mOf(view, FAST).available && near(mOf(view, FAST).change, 0) && mOf(view, FAST).ownChart === false, j(mOf(view, FAST)));
  ok('SLOW would take 1 min a piece more, and is marked "own chart"', mOf(view, SLOW).available && near(mOf(view, SLOW).change, sumQty) && mOf(view, SLOW).ownChart === true, j(mOf(view, SLOW)));
  const w0 = await snapWork(UNIT);
  ok('planner load before = the standard', near(w0, sumStd), `${w0} vs ${sumStd}`);
  let put = await PL.putUnitMachine(db, c, UNIT, { functionKey: fnKey, machineId: SLOW });
  ok('put on SLOW: the answer says old → new', near(put.before, sumStd) && near(put.after, sumStd + sumQty) && near(put.change, sumQty) && put.changed === steps.length, j([put.before, put.after, put.change]));
  steps = await stepsOf(O1.lineId);
  ok('every step is on SLOW with the machine time 60/30 + 1 = 3 (hand calculation)', steps.every((s) => s.machine_id === SLOW && s.mmid === SLOW && near(s.mw, onSlow(s.kind)) && near(s.ms, SETUP) && near(s.mm, total(3, s.quantity))), j(steps.map((s) => [s.mw, s.mm])));
  ok('the standard is untouched', steps.every((s) => near(s.ew, 2) && near(s.em, total(2, s.quantity))));
  ok('effective = the machine time now', steps.every((s) => near(s.eff, s.mm)));
  ok('the planner\'s load followed: the unit takes longer', near(await snapWork(UNIT), sumStd + sumQty), String(await snapWork(UNIT)));
  const relView = await REL.getRelease(db, COMPANY, (await REL.liveReleaseOfLine(db, COMPANY, O1.lineId)).id);
  const anyStep = relView.items.flatMap((i) => i.steps ?? [])[0];
  ok('the tracker\'s step carries ONE field to use (effMinutes) and says its basis', !!anyStep && near(anyStep.effMinutes, anyStep.machMinutes) && anyStep.timeBasis === 'machine' && anyStep.estMinutes < anyStep.effMinutes, j(anyStep && [anyStep.estMinutes, anyStep.machMinutes, anyStep.effMinutes, anyStep.timeBasis]));
  view = await PL.getUnitMachines(db, COMPANY, UNIT);
  ok('the card now says it is on SLOW', fnOf(view).machineId === SLOW && mOf(view, SLOW).stepsHere === steps.length && near(mOf(view, FAST).change, -sumQty));
  put = await PL.putUnitMachine(db, c, UNIT, { functionKey: fnKey, machineId: FAST });
  steps = await stepsOf(O1.lineId);
  ok('moved to FAST: recomputed with FAST\'s chain (= the type\'s: 2 min)', near(put.change, -sumQty) && steps.every((s) => s.machine_id === FAST && s.mmid === FAST && near(s.mw, 2) && near(s.eff, s.em)));
  put = await PL.putUnitMachine(db, c, UNIT, { functionKey: fnKey, machineId: null });
  steps = await stepsOf(O1.lineId);
  ok('cleared: no machine, no machine time, back to the standard', steps.every((s) => s.machine_id == null && s.mm == null && s.mmid == null && near(s.eff, s.em)));
  ok('…and the planner\'s load is the standard again', near(await snapWork(UNIT), sumStd));
  const notMine = await refusal(() => PL.putUnitMachine(db, c, UNIT, { functionKey: fnKey, machineId: 999999999 }));
  ok('a machine that is not one of the type\'s is refused', said(notMine, /not one of/), notMine?.message);

  /* ------------------------------------------------------------------------ */
  section('3. A work order names a CONTRACTOR, never a machine');
  await PL.putUnitMachine(db, c, UNIT, { functionKey: fnKey, machineId: SLOW });
  const party = await insert('cf_parties', { company_id: COMPANY, code: `${tag}-SUB`, name: `${tag} Sub`, is_subcontractor: 1 });
  const leaf = (await stepsOf(O1.lineId)).find((s) => s.kind === 'part');
  await WO.assignCells(db, c, O1.id, O1.lineId, { cells: [{ pieceId: leaf.order_piece_id, operationId: G.op.id }], contractorId: party });
  let leafNow = (await stepsOf(O1.lineId)).find((s) => s.id === leaf.id);
  ok('the step is on the work order — and its machine and both times are exactly as they were', leafNow.work_order_id != null && leafNow.machine_id === SLOW && near(leafNow.mm, leaf.mm) && near(leafNow.em, leaf.em) && near(leafNow.eff, leaf.eff), j(leafNow));
  view = await PL.getUnitMachines(db, COMPANY, UNIT);
  ok('a contractor\'s step is not offered a machine by the planner', !fnOf(view).stepIds.includes(leaf.id));
  await WO.assignCells(db, c, O1.id, O1.lineId, { cells: [{ pieceId: leaf.order_piece_id, operationId: G.op.id }], contractorId: null });
  leafNow = (await stepsOf(O1.lineId)).find((s) => s.id === leaf.id);
  ok('back in-house: still on SLOW with its machine time', leafNow.work_order_id == null && leafNow.machine_id === SLOW && near(leafNow.eff, leaf.mm));
  await PL.putUnitMachine(db, c, UNIT, { functionKey: fnKey, machineId: null });

  /* ------------------------------------------------------------------------ */
  section('4. The floor: live start, the tracker\'s start, the day from paper');
  steps = await stepsOf(O1.lineId);
  const parts = steps.filter((s) => s.kind === 'part');
  const [A, B, C] = parts;
  ok('three part steps to start', parts.length >= 3, String(parts.length));
  await F.startWork(db, c, { machineId: SLOW, stepIds: [A.id] });
  let a = await stepRow(A.id);
  ok('live start on SLOW: in progress, on SLOW, machine time = (5 + 3) × quantity', a.state === 'in_progress' && a.machine_id === SLOW && near(a.mach_work_minutes, 3) && near(a.mach_minutes, total(3, a.quantity)) && near(a.eff_minutes, a.mach_minutes), j([a.mach_work_minutes, a.mach_minutes]));
  await REL.startStep(db, c, B.id, { machineId: SLOW, allowNotReady: true, view: 'none' });
  let b = await stepRow(B.id);
  ok('the tracker\'s own start on SLOW: the same machine time', b.state === 'in_progress' && b.machine_id === SLOW && near(b.mach_minutes, total(3, b.quantity)) && near(b.eff_minutes, b.mach_minutes));
  const D = '2026-09-29';
  await F.putDay(db, c, SLOW, { date: D, rows: [{ kind: 'work', stepId: C.id, start: `${D}T08:00`, end: `${D}T09:00`, good: 0 }] });
  let cRow = await stepRow(C.id);
  ok('a paper entry on SLOW: the same machine time', cRow.state === 'in_progress' && cRow.machine_id === SLOW && near(cRow.mach_minutes, total(3, cRow.quantity)));
  // A step planned on a machine and started from the tracker WITHOUT naming one keeps its planned machine.
  const Dd = parts[3] ?? steps.find((s) => s.kind === 'seg');
  await T.estimateOnMachine(db, c, [Dd.id], SLOW);
  await REL.startStep(db, c, Dd.id, { allowNotReady: true, view: 'none' });
  const d = await stepRow(Dd.id);
  ok('started with no machine named: the planned machine and its time stay', d.state === 'in_progress' && d.machine_id === SLOW && near(d.mach_minutes, total(onSlow(kindOfNode.get(d.node_id)), d.quantity)));
  const started = new Set([A.id, B.id, C.id, Dd.id]);
  // The planner now moves the rest; what has started is not moved.
  put = await PL.putUnitMachine(db, c, UNIT, { functionKey: fnKey, machineId: FAST });
  steps = await stepsOf(O1.lineId);
  ok('a planner move leaves STARTED steps on the machine that started them', steps.filter((s) => started.has(s.id)).every((s) => s.machine_id === SLOW) && steps.filter((s) => !started.has(s.id)).every((s) => s.machine_id === FAST));
  await PL.putUnitMachine(db, c, UNIT, { functionKey: fnKey, machineId: SLOW });

  /* ------------------------------------------------------------------------ */
  section('5. The machine\'s own value is edited: not-started steps follow, started ones do not');
  steps = await stepsOf(O1.lineId);
  const open = steps.filter((s) => !started.has(s.id));
  const openQty = open.reduce((t, s) => t + Number(s.quantity), 0);
  const edited = await MC.setMachineValues(db, c, SLOW, [{ specCode: RATE, value: 20 }]);
  slowRate = 20;
  ok('saving says how many steps were re-timed and by how much', edited.timeImpact.steps === open.length && edited.timeImpact.changed === open.length && near(edited.timeImpact.minutesChange, openQty), j(edited.timeImpact));
  steps = await stepsOf(O1.lineId);
  ok('not-started steps on SLOW: 60/20 + 1 = 4 min a piece', steps.filter((s) => !started.has(s.id)).every((s) => near(s.mw, 4) && near(s.mm, total(4, s.quantity)) && near(s.eff, s.mm)), j(steps.filter((s) => !started.has(s.id)).map((s) => s.mw)));
  ok('started steps keep the numbers they started with (3 min)', steps.filter((s) => started.has(s.id) && s.kind === 'part').every((s) => near(s.mw, 3)));
  ok('the standard never moved', steps.every((s) => near(s.ew, 2)));

  /* ------------------------------------------------------------------------ */
  section('6. SLOW gets its OWN chart — with no answer for a girder');
  const impactNow = await MC.machineTimeImpact(db, COMPANY, SLOW);
  ok('the Charts tab\'s count: the steps planned on SLOW that have not started', impactNow.steps === open.length && impactNow.changed === 0, j(impactNow));
  const ownRows = { rows: [[V.part.node_name, 5], [V.seg.node_name, 1], [V.assy.node_name, null]] };
  await db.query('SAVEPOINT dry');
  const dry = await CH.chartValueImpact(db, c, SLOW, CHART, ownRows);
  await db.query('ROLLBACK TO SAVEPOINT dry');
  const openParts = open.filter((s) => s.kind === 'part');
  const openAssy = open.filter((s) => s.kind === 'assy');
  // parts: 4 → 3 + 5 = 8 (+4 a piece); the girder comes off SLOW: 4 → the standard 2 (−2 a piece).
  const expectChange = openParts.reduce((t, s) => t + 4 * Number(s.quantity), 0) + openAssy.reduce((t, s) => t - 2 * Number(s.quantity), 0);
  ok('the DRY RUN says what saving would do: steps changed, total minutes, and the girder taken off', dry.steps === open.length && dry.dropped === openAssy.length && near(dry.minutesChange, expectChange) && dry.changed === openParts.length + openAssy.length, j([dry, expectChange]));
  ok('…and names why, in words', dry.cannot.length === openAssy.length && dry.cannot.every((s) => s.includes(SLOW_CODE) && s.includes(`${tag} handling`) && s.includes(V.assy.node_name)), j(dry.cannot));
  ok('the dry run wrote nothing', (await stepsOf(O1.lineId)).filter((s) => !started.has(s.id)).every((s) => s.machine_id === SLOW && near(s.mw, 4)));
  await CH.setChartValue(db, c, { type: 'machine', id: SLOW }, CHART, ownRows);
  slowChart = { part: 5, seg: 1, assy: null };
  steps = await stepsOf(O1.lineId);
  ok('saved: the not-started parts read SLOW\'s own chart (60/20 + 5 = 8)', steps.filter((s) => !started.has(s.id) && s.kind === 'part').every((s) => near(s.mw, 8) && s.machine_id === SLOW));
  ok('…the girder step came OFF SLOW and is on the standard — not silently on the type\'s chart', steps.filter((s) => s.kind === 'assy').every((s) => s.machine_id == null && s.mm == null && near(s.eff, s.em)));
  ok('…started steps still carry what they started with', steps.filter((s) => started.has(s.id) && s.kind === 'part').every((s) => near(s.mw, 3)));
  const cannot = await refusal(() => PL.putUnitMachine(db, c, UNIT, { functionKey: fnKey, machineId: SLOW }));
  ok('putting the girder on SLOW is REFUSED, naming machine, chart and the piece\'s value', cannot?.code === T.MACHINE_CANNOT && said(cannot, new RegExp(SLOW_CODE)) && said(cannot, new RegExp(`${tag} handling`)) && said(cannot, new RegExp(V.assy.node_name)), j([cannot?.message, cannot?.problems]));
  console.log(`        says: ${cannot?.message} ${cannot?.problems?.[0] ?? ''}`);
  view = await PL.getUnitMachines(db, COMPANY, UNIT);
  ok('the planner shows SLOW as NOT AVAILABLE for this card, with the sentence; FAST stays available', mOf(view, SLOW).available === false && mOf(view, SLOW).minutes == null && /cannot do/.test(mOf(view, SLOW).reason ?? '') && mOf(view, FAST).available === true, j(mOf(view, SLOW)));
  const girderStep = steps.find((s) => s.kind === 'assy');
  const floorNo = await refusal(() => F.startWork(db, c, { machineId: SLOW, stepIds: [girderStep.id] }));
  ok('the floor cannot start the girder on SLOW either — the same sentence, nothing written', floorNo?.code === T.MACHINE_CANNOT && (await stepRow(girderStep.id)).state === 'pending' && (await stepRow(girderStep.id)).machine_id == null, floorNo?.message);
  const trackerNo = await refusal(() => REL.startStep(db, c, girderStep.id, { machineId: SLOW, allowNotReady: true, view: 'none' }));
  ok('…nor the tracker\'s start', trackerNo?.code === T.MACHINE_CANNOT && (await stepRow(girderStep.id)).state === 'pending');

  /* ------------------------------------------------------------------------ */
  section('7. The TYPE\'s chart changes: released lines keep their times (today\'s rule)');
  const frozen = j((await stepsOf(O1.lineId)).map((s) => [s.id, s.ew, s.em, s.mw, s.mm, s.machine_id]));
  await CH.setChartValue(db, c, { type: 'classification', id: TYPE }, CHART, { rows: chartRows({ part: 2, seg: 2, assy: 2 }) });
  typeChart = { part: 2, seg: 2, assy: 2 };
  ok('nothing on the released line moved — neither standard nor machine time', j((await stepsOf(O1.lineId)).map((s) => [s.id, s.ew, s.em, s.mw, s.mm, s.machine_id])) === frozen);

  /* ------------------------------------------------------------------------ */
  section('8. A typed time still wins over both');
  const O2 = await G.girderOrder('O2', 1);
  const [o2rows] = await db.query('SELECT DISTINCT bom_line_id, item_id FROM cf_order_pieces WHERE company_id = ? AND order_line_id = ? AND deleted_at IS NULL', [COMPANY, O2.lineId]);
  const times = await T.getLineTimes(db, COMPANY, O2.id, O2.lineId);
  const cleatRow = times.rows.find((r) => r.name?.startsWith('Cleat'));
  ok('a line released AFTER the type\'s chart changed takes the new standard (60/60 + 2 = 3)', !!cleatRow && near(cleatRow.cells[G.op.id].work, 3), j(cleatRow?.cells));
  await T.setLineTimes(db, c, O2.id, O2.lineId, { cells: [{ bomLineId: cleatRow.bomLineId, operationId: G.op.id, work: 9 }] });
  await release(O2);
  let s2 = await stepsOf(O2.lineId);
  const typed = s2.filter((s) => s.bom_line_id === cleatRow.bomLineId);
  ok('the typed row is released at 9 min a piece; the rest at the standard 3', typed.length > 0 && typed.every((s) => near(s.ew, 9)) && s2.filter((s) => s.bom_line_id !== cleatRow.bomLineId).every((s) => near(s.ew, 3)), j(s2.map((s) => s.ew)));
  const [[segPiece]] = await db.query('SELECT id FROM cf_order_pieces WHERE company_id = ? AND order_line_id = ? AND item_id IN (SELECT pi.item_id FROM cf_production_items pi JOIN cf_master_records m ON m.id = pi.item_id WHERE m.classification_id = ?) AND deleted_at IS NULL ORDER BY id LIMIT 1', [COMPANY, O2.lineId, V.seg.node_id]);
  const SEG_UNIT = `p${segPiece.id}`;
  const segView = await PL.getUnitMachines(db, COMPANY, SEG_UNIT);
  ok('a segment and its parts can go on SLOW (no girder among them)', fnOf(segView)?.machines.find((m) => m.id === SLOW)?.available === true, j(fnOf(segView)?.machines));
  await PL.putUnitMachine(db, c, SEG_UNIT, { functionKey: fnKey, machineId: SLOW });
  s2 = await stepsOf(O2.lineId);
  const onS = s2.filter((s) => s.machine_id === SLOW);
  ok('on SLOW the typed row is STILL 9 (not SLOW\'s 8)', onS.some((s) => s.bom_line_id === cleatRow.bomLineId) && onS.filter((s) => s.bom_line_id === cleatRow.bomLineId).every((s) => near(s.mw, 9) && near(s.mm, total(9, s.quantity))), j(onS.map((s) => [s.kind, s.mw])));
  ok('…while the rows nobody typed read SLOW\'s chart (bracket 60/20 + 5 = 8, segment 60/20 + 1 = 4)', onS.filter((s) => s.bom_line_id !== cleatRow.bomLineId).every((s) => near(s.mw, onSlow(s.kind))) && onS.some((s) => s.kind === 'seg'), j(onS.map((s) => [s.kind, s.mw])));
  ok('only that segment\'s steps moved', s2.some((s) => s.machine_id == null) && o2rows.length > 0);

  /* ------------------------------------------------------------------------ */
  section('9. Round trips are the same for 1 step and for a whole line');
  const all1 = (await stepsOf(O1.lineId)).map((s) => s.id);
  const one = await H.measured(db, (q) => T.estimateOnMachine(q, c, [all1[0]], FAST, { apply: false, refuse: false }));
  const many = await H.measured(db, (q) => T.estimateOnMachine(q, c, all1, FAST, { apply: false, refuse: false }));
  ok(`estimateOnMachine: ${one.queries} round trips for 1 step, ${many.queries} for ${all1.length}`, one.queries === many.queries && one.queries <= 20, `${one.queries} vs ${many.queries}`);
  const v1 = await H.measured(db, (q) => PL.getUnitMachines(q, COMPANY, SEG_UNIT));
  const v2 = await H.measured(db, (q) => PL.getUnitMachines(q, COMPANY, O2.units[0]));
  ok(`the card's machines: ${v1.queries} round trips for a segment, ${v2.queries} for the whole girder`, v1.queries === v2.queries && v1.queries <= 30, `${v1.queries} vs ${v2.queries}`);
  const w1 = await H.measured(db, (q) => T.estimateOnMachine(q, c, all1, undefined));
  ok(`…and bringing a whole line "in line" when it already is writes nothing — started steps keep their numbers whoever calls (${w1.queries} round trips)`, w1.result.written === 0 && w1.result.changed === 0, j([w1.result.written, w1.result.changed]));

  /* ------------------------------------------------------------------------ */
  section('10. The backfill: steps that already have a machine and no machine time');
  const victim = s2.find((s) => s.machine_id == null && s.kind === 'seg') ?? s2.find((s) => s.machine_id == null && s.kind === 'part');
  await db.query('UPDATE cf_production_steps SET machine_id = ? WHERE id = ?', [SLOW, victim.id]);   // a writer that went round the function
  let vr = await stepRow(victim.id);
  ok('a step whose machine was written round the function shows the STANDARD, never another machine\'s number', vr.machine_id === SLOW && vr.mach_minutes == null && near(vr.eff_minutes, vr.est_minutes));
  const bDry = await backfill(db, COMPANY, { apply: false });
  vr = await stepRow(victim.id);
  ok('dry run: it is found, and nothing is written', bDry.steps >= 1 && vr.mach_minutes == null && vr.mach_machine_id == null, j(bDry));
  const bApply = await backfill(db, COMPANY, { apply: true });
  vr = await stepRow(victim.id);
  ok('apply: it gets SLOW\'s machine time', bApply.written >= 1 && vr.mach_machine_id === SLOW && near(vr.mach_work_minutes, onSlow(kindOfNode.get(vr.node_id))) && near(vr.eff_minutes, vr.mach_minutes), j([bApply, vr.mach_work_minutes]));
  const bAgain = await backfill(db, COMPANY, { apply: true });
  ok('apply again: nothing left to do', bAgain.written === 0 && bAgain.changed === 0, j(bAgain));

  /* ------------------------------------------------------------------------ */
  section('11. ONE machine can do it: it is the machine from the start (release and the plan before it)');
  await MC.updateMachine(db, c, FAST, { status: 'inactive' });
  OPS.clearProductionMachines(COMPANY);
  const fastLeft = (await stepsOf(O1.lineId)).filter((s) => s.machine_id === FAST && s.state === 'pending');
  ok('FAST switched off: nothing that has not started stays planned on it', fastLeft.length === 0, String(fastLeft.length));
  const O4 = await G.girderOrder('O4', 1);
  const planBefore = (await PL.getPlanner(db, COMPANY, { from: '2026-10-01' })).units.find((u) => u.key === O4.lineKey)?.work?.[fnKey];
  await release(O4);
  const s4 = await stepsOf(O4.lineId);
  ok('released with SLOW as the only machine: every step SLOW can take is on it, with SLOW\'s time', s4.filter((s) => s.kind !== 'assy').every((s) => s.machine_id === SLOW && s.mmid === SLOW && near(s.mw, onSlow(s.kind)) && near(s.mm, total(onSlow(s.kind), s.quantity))), j(s4.map((s) => [s.kind, s.machine_id, s.mw])));
  ok('…the standard is still the type\'s (3 min)', s4.every((s) => near(s.ew, 3)));
  ok('…and the girder, which SLOW cannot answer for, is on no machine and on the standard', s4.filter((s) => s.kind === 'assy').every((s) => s.machine_id == null && s.mm == null && near(s.eff, s.em)));
  const effSum = s4.reduce((t, s) => t + Number(s.eff), 0);
  // Before release a ROW's setup is counted once for the row (the Times tab's total, as always);
  // a released step carries its own. So: the same work minutes, and one setup a row.
  const rowsOf4 = new Set(s4.map((s) => s.bom_line_id ?? 0)).size;
  void rowsOf4;
  const planExpect = s4.reduce((t, s) => t + ((s.machine_id === SLOW ? onSlow(s.kind) : std(s.kind)) + SETUP) * Number(s.quantity), 0);
  ok('the plan BEFORE release already used the own times of the only machine for what SLOW alone can do', near(planBefore, planExpect), `${planBefore} vs ${planExpect}`);
  ok('…and the planner reads the released steps\' effective minutes', near((await PL.getPlanner(db, COMPANY, { from: '2026-10-01' })).units.find((u) => u.key === O4.lineKey)?.work?.[fnKey], effSum));

  /* ------------------------------------------------------------------------ */
  section('12. The time dialog\'s preview: standard vs a machine');
  const ctx = await builderContext(db, COMPANY, G.op.id, { subjectType: 'classification', subjectId: TYPE });
  ok('the builder names the standard (the rule\'s machine type) and marks machines with their own chart', ctx.standard?.typeId === TYPE && ctx.machines.find((m) => m.id === SLOW)?.ownChart === true, j([ctx.standard, ctx.machines.map((m) => [m.code, m.ownChart])]));
  const expr = `60 / machine.${RATE}`;
  const chkStd = await checkForBuilder(db, COMPANY, { expression: expr, machineTypeId: TYPE });
  const chkSlow = await checkForBuilder(db, COMPANY, { expression: expr, machineId: SLOW });
  ok('the standard check reads the TYPE (1 min); SLOW reads its own rate (3 min)', near(chkStd.result?.value, 1) && near(chkSlow.result?.value, 3), j([chkStd.result, chkSlow.result]));

  /* ------------------------------------------------------------------------ */
  section('13. No writer of a step\'s machine goes round the function (source scan)');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../apps/cf_erp');
  const files = [];
  const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith('.js')) files.push(p); } };
  walk(root);
  const writers = [];
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    let writes = false;
    // an UPDATE of the steps that assigns machine_id (not mach_machine_id) …
    for (const m of src.matchAll(/UPDATE\s+cf_production_steps[\s\S]{0,900}?WHERE/gi)) if (/(^|[^_a-z])machine_id\s*=/i.test(m[0])) writes = true;
    // … or an INSERT column list of the steps that carries it.
    if (/STEP_COLUMNS\s*=\s*\[[^\]]*'machine_id'/.test(src) || /INSERT\s+INTO\s+cf_production_steps\s*\([^)]*\bmachine_id\b/i.test(src)) writes = true;
    if (writes) writers.push({ file: path.relative(root, file).replace(/\\/g, '/'), calls: /estimateOnMachine\s*\(/.test(src) });
  }
  const expected = ['services/floorService.js', 'services/releaseService.js', 'services/timeEstimateService.js'];
  ok(`the files that write a step's machine are exactly ${expected.join(', ')}`, j(writers.map((w) => w.file).sort()) === j(expected), j(writers));
  ok('…and every one of them goes through estimateOnMachine', writers.every((w) => w.calls), j(writers));
} catch (err) {
  H.state.failed += 1;
  console.error('\nERROR', err);
} finally {
  await db.rollback();
  detachNodeCache(db);
  db.release();
}

const after = await H.counts();
const drift = after.filter((a) => Number(a.n) !== Number(before.find((b) => b.name === a.name)?.n));
section('Rolled back');
ok('every cf_ table has the rows it had', drift.length === 0, drift.map((d) => d.name).join(', '));
console.log(`\n${H.state.passed} passed, ${H.state.failed} failed${H.state.fails.length ? `\n  failed: ${H.state.fails.join('\n          ')}` : ''}`);
await pool.end();
process.exit(H.state.failed ? 1 : 0);
