/**
 * planner_v3_test.mjs — STEP 5: the planner per production order at step level (init.sql §84,
 * services/plannerV3Engine.js + plannerV3Service.js, routes/planner3.js; contract TM/CF_ERP_ORDER_FLOW_PLAN.md
 * "2026-10-18 — Step 5: the planner"). Local DB only.
 *
 *   cd multi_app_be && node scripts/cf_kepl/planner_v3_test.mjs
 *   CF_PLAN3_COMPANY (2)
 *
 *   A. the engine, pure: a machine's day minutes on the clock, a step over two days, waits, a busy machine (lower rank
 *      stretches into the gaps), material waiting / dated, started steps keep planned − elapsed (≤ 0 = now), contractor
 *   B. the fixture: own machine types (Cut ×2 machines, Weld ×1), shifts 08–16 every day, two orders with production
 *      orders, steps and waits — inside ONE transaction that is rolled back, then every cf_ table is re-counted
 *   C. precedence and capacity: weld after cut; a step over days; the second production order waits behind the first
 *      ("busy with …"); a second machine with shifts takes it
 *   D. auto vs manual: committed date first (by AI); manual rank flips it; earliest start; pinning in auto
 *   E. material: free stock first come first served, then the PO line's own date (over the PO's), a receipt overrides;
 *      waiting with no date = not planned
 *   F. capacity minus planned downtime and an open fault (the calendar reader's)
 *   G. re-plan with started steps: planned − elapsed (work sessions), ≤ 0 ends now; done steps keep real dates
 *   H. the order's time override (§76) — 0.1 s a piece plans in seconds
 *   I. save, baseline at the first save, re-baseline through Management's approval, plan health
 *   J. round trips: GET fixed and within planner_test's budget; routes
 */
import path from 'path';
import { pathToFileURL } from 'url';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
await imp('apps/cf_erp/services/codegenProvider.js');
const { attachNodeCache, detachNodeCache } = await imp('apps/cf_erp/lib/db.js');
const ENG = await imp('apps/cf_erp/services/plannerV3Engine.js');
const P3 = await imp('apps/cf_erp/services/plannerV3Service.js');
const SHIFT = await imp('apps/cf_erp/services/shiftService.js');
const OPS = await imp('apps/cf_erp/services/operationService.js');
const MR = await imp('apps/cf_erp/services/materialReadyService.js');
const APPROVAL = await imp('apps/cf_erp/services/approvalService.js');
const AREA = await imp('apps/cf_erp/services/stockingAreaService.js');
const STOCK = await imp('apps/cf_erp/services/stockService.js');
const routes = (await imp('apps/cf_erp/routes/planner3.js')).default;

if (!/^(localhost|127\.0\.0\.1|::1)$/.test(process.env.DB_HOST ?? 'localhost')) throw new Error('This suite is local only.');
const COMPANY = Number(process.env.CF_PLAN3_COMPANY ?? 2);
const RUN = `TPL3-${Date.now().toString(36).toUpperCase()}`;
const GET_BUDGET = 64;      // planner_test's "GET round trips ≤ 64"

let passed = 0;
let failed = 0;
const fails = [];
function ok(label, cond, detail = '') {
  if (typeof label !== 'string' || typeof cond !== 'boolean') throw new Error(`ok(label, cond) takes a string and then a boolean — got ok(${typeof label}, ${typeof cond})`);
  if (cond) { passed += 1; console.log(`  PASS  ${label}`); } else { failed += 1; fails.push(label); console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
}
const section = (s) => console.log(`\n${s}`);
async function refusal(fn) { try { await fn(); return null; } catch (e) { return e; } }
async function census(db) {
  const [rows] = await db.query("SHOW TABLES LIKE 'cf\\_%'");
  const out = {};
  for (const t of rows.map((r) => Object.values(r)[0]).sort()) { const [[r]] = await db.query(`SELECT COUNT(*) AS n FROM \`${t}\``); out[t] = Number(r.n); }
  return out;
}
function counting(db) {
  const tally = { n: 0 };
  const proxy = new Proxy(db, { get: (t, p) => (p === 'query' ? (...a) => { tally.n += 1; return t.query(...a); } : Reflect.get(t, p)) });
  return { db: proxy, tally };
}
const pad = (n) => String(n).padStart(2, '0');
const dText = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (s, n) => { const [y, m, d] = s.split('-').map(Number); return dText(new Date(y, m - 1, d + n)); };
const DAY = 1440;

/* ===================================================================================================== */
section('A. The engine, pure');
{
  const L = new ENG.Lane({ id: 1, typeKey: 'T', days: [480, 0, 480] }, 0);
  ok('a lane: 480 minutes a day spread over the day — noon is 240 work minutes', L.W(720) === 240);
  ok('work minute 480 ends day 0 and the next one starts on day 2 (day 1 has no shift)', L.C(480, true) === DAY && L.C(480) === 2 * DAY);
  const base = { now: 0, horizonDays: 5, machines: [{ id: 1, typeKey: 'T', days: [480, 480, 480, 480, 480] }] };
  const r1 = ENG.planAll({
    ...base, orders: [{ id: 10 }, { id: 20 }],
    steps: [
      { id: 1, poId: 10, typeKey: 'T', minutes: 600, state: 'pending', order: 1 },
      { id: 2, poId: 10, typeKey: 'T', minutes: 120, state: 'pending', order: 2 },
      { id: 3, poId: 20, typeKey: 'T', minutes: 240, state: 'pending', order: 1 },
    ],
    waits: [{ stepId: 2, onStepId: 1, required: 'done' }],
  });
  const s = (id) => r1.steps.get(id);
  ok('a 600-minute step on 480 a day runs into the next day (ends 06:00 day 1)', s(1).start === 0 && s(1).end === DAY + 360, `${s(1).start} ${s(1).end}`);
  ok('the second step starts when its predecessor finishes', s(2).start === s(1).end && s(2).binding.kind === 'predecessor');
  ok('the lower rank waits behind the first on the one machine ("busy with" the first)', s(3).start >= s(2).end - 1e-6 && s(3).binding.kind === 'capacity' && s(3).binding.behindPo === 10, JSON.stringify(s(3).binding));
  // A lower rank fills a gap the higher rank leaves (its step waits for material): "lower stretches", never pushes.
  const r2 = ENG.planAll({
    ...base, orders: [{ id: 10 }, { id: 20 }],
    steps: [
      { id: 1, poId: 10, typeKey: 'T', minutes: 480, state: 'pending', order: 1 },
      { id: 3, poId: 20, typeKey: 'T', minutes: 240, state: 'pending', order: 1 },
    ],
    waits: [], materialStepIds: [1],
  }, () => new Map([[1, { at: 2 * DAY, text: 'due day 2' }]]));
  ok('rank 2 uses day 0 while rank 1 waits for its material to day 2', r2.steps.get(3).start === 0 && r2.steps.get(1).start === 2 * DAY && r2.steps.get(1).binding.kind === 'material');
  const r3 = ENG.planAll({ ...base, orders: [{ id: 10 }], steps: [{ id: 1, poId: 10, typeKey: 'T', minutes: 60, state: 'pending' }, { id: 2, poId: 10, typeKey: 'T', minutes: 60, state: 'pending' }], waits: [{ stepId: 2, onStepId: 1, required: 'done' }], materialStepIds: [1] },
    () => new Map([[1, { at: null, text: 'no date' }]]));
  ok('material with no date: the step is not planned, and neither is what waits for it', r3.steps.get(1).unplanned === true && r3.steps.get(2).unplanned === true && r3.steps.get(2).binding.kind === 'after');
  const r4 = ENG.planAll({
    ...base, now: 600, orders: [{ id: 10 }],
    steps: [
      { id: 1, poId: 10, typeKey: 'T', minutes: 90, state: 'in_progress', startedAt: 300, order: 1 },
      { id: 2, poId: 10, typeKey: 'T', minutes: 0, state: 'in_progress', startedAt: 100, order: 2 },
      { id: 3, poId: 10, typeKey: 'T', minutes: 0, state: 'done', startedAt: 50, finishedAt: 200, order: 0 },
      { id: 4, poId: 10, contractor: true, typeKey: null, minutes: 300, state: 'pending', order: 3 },
    ],
    waits: [],
  });
  ok('a started step keeps its real start and runs what is left from now', r4.steps.get(1).start === 300 && r4.steps.get(1).end > 600);
  ok('a started step with nothing left ends now', r4.steps.get(2).end === 600);
  ok('a done step keeps its real dates', r4.steps.get(3).start === 50 && r4.steps.get(3).end === 200 && r4.steps.get(3).real === true);
  ok('a contractor\'s step takes calendar time with no machine limit', r4.steps.get(4).start === 600 && r4.steps.get(4).end === 900 && r4.steps.get(4).unlimited === true);
  const r5 = ENG.planAll({ ...base, orders: [{ id: 10, earliestStart: 3 * DAY }], steps: [{ id: 1, poId: 10, typeKey: 'T', minutes: 60, state: 'pending' }], waits: [] });
  ok('an earliest start holds the production order back', r5.steps.get(1).start === 3 * DAY && r5.steps.get(1).binding.kind === 'start');
  const r6 = ENG.planAll({ ...base, machines: [{ id: 1, typeKey: 'T', days: [0, 0, 0, 0, 0] }], orders: [{ id: 10 }], steps: [{ id: 1, poId: 10, typeKey: 'T', minutes: 60, state: 'pending' }], waits: [] });
  ok('a machine type with no shift time: not planned, "no capacity"', r6.steps.get(1).unplanned === true && r6.steps.get(1).binding.kind === 'no_capacity');
}

/* ===================================================================================================== */
const conn = await pool.getConnection();
let before = null;
let exitCode = 0;
const realToday = dText(new Date());
const D0 = addDays(realToday, 1);            // the planner's "today" in this suite: tomorrow, midnight
const at = (n, hhmm = '00:00') => `${addDays(D0, n)} ${hhmm}`;
try {
  before = await census(conn);
  await conn.beginTransaction();
  attachNodeCache(conn);
  const [[user]] = await conn.query('SELECT id FROM users WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [COMPANY]);
  const c = { companyId: COMPANY, userId: user?.id ?? null };
  const ins = async (sql, args) => (await conn.query(sql, args))[0].insertId;
  P3.setPlannerNow(`${D0} 00:00`);
  MR.setToday(D0);
  console.log(`\nCompany ${COMPANY} — run ${RUN} — planner today ${D0}`);

  section('B. Fixture');
  // Machine types of our own (Cut, Weld), their machines production machines through their own operations' rules.
  const [[parent]] = await conn.query("SELECT id, depth FROM cf_classification_nodes WHERE company_id = ? AND scope = 'machine' AND deleted_at IS NULL AND depth = 1 ORDER BY id LIMIT 1", [COMPANY]);
  const node = (k) => ins("INSERT INTO cf_classification_nodes (company_id, parent_id, depth, scope, code, name) VALUES (?, ?, ?, 'machine', ?, ?)", [COMPANY, parent.id, parent.depth + 1, `${RUN}-${k}`, `${RUN} ${k}`]);
  const TCUT = await node('Cut');
  const TWELD = await node('Weld');
  const machine = (k, type) => ins("INSERT INTO cf_machines (company_id, code, name, classification_id, status) VALUES (?, ?, ?, ?, 'active')", [COMPANY, `${RUN}-${k}`, `${RUN} ${k}`, type]);
  const CUT1 = await machine('CUT1', TCUT);
  const CUT2 = await machine('CUT2', TCUT);
  const WELD1 = await machine('WELD1', TWELD);
  const op = (k) => ins("INSERT INTO cf_operations (company_id, code, name, status) VALUES (?, ?, ?, 'active')", [COMPANY, `${RUN}-${k}`, `${RUN} ${k}`]);
  const OPC = await op('CUT');
  const OPW = await op('WELD');
  for (const [o, m] of [[OPC, CUT1], [OPC, CUT2], [OPW, WELD1]]) {
    await conn.query("INSERT INTO cf_operation_machine_rules (company_id, operation_id, subject_type, subject_id, eligible, setup_minutes, work_minutes) VALUES (?, ?, 'machine', ?, 1, 0, 5)", [COMPANY, o, m]);
  }
  OPS.clearProductionMachines(COMPANY);
  const allDays = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  await SHIFT.createShift(conn, c, CUT1, { name: `${RUN} Day`, weekdays: allDays, startTime: '08:00', endTime: '16:00', breakMinutes: 0 });
  await SHIFT.createShift(conn, c, WELD1, { name: `${RUN} Day`, weekdays: allDays, startTime: '08:00', endTime: '16:00', breakMinutes: 0 });
  // CUT2 has no shift yet: only CUT1 cuts.

  const [[inode]] = await conn.query("SELECT id FROM cf_classification_nodes WHERE company_id = ? AND scope IN ('item','both') AND deleted_at IS NULL ORDER BY depth DESC, id LIMIT 1", [COMPANY]);
  const [[flow]] = await conn.query('SELECT id FROM cf_operation_flows WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [COMPANY]);
  const master = async (key, tracked = 'quantity') => {
    const id = await ins("INSERT INTO cf_master_records (company_id, record_kind, code, name, classification_id, status) VALUES (?, 'item', ?, ?, ?, 'active')", [COMPANY, `${RUN}-${key}`, `${RUN} ${key}`, inode.id]);
    await conn.query("INSERT INTO cf_item_details (master_id, company_id, item_type, tracked_by, uom, sourcing) VALUES (?, ?, 'catalog', ?, 'nos', 'make')", [id, COMPANY, tracked]);
    return id;
  };
  const ITEM = await master('GIRDER');
  const RM = await master('PLATE');
  const CUST = await ins("INSERT INTO cf_parties (company_id, code, name, is_customer, status) VALUES (?, ?, ?, 1, 'active')", [COMPANY, `${RUN}-CUST`, `${RUN} customer`]);
  const order = (key, committed) => ins("INSERT INTO cf_sales_orders (company_id, code, order_type, title, status, customer_id, committed_date) VALUES (?, ?, 'customer', ?, 'confirmed', ?, ?)",
    [COMPANY, `${RUN}-${key}`, `Planner test ${key}`, CUST, committed]);
  const line = (orderId) => ins("INSERT INTO cf_sales_order_lines (company_id, order_id, line_no, line_type, item_id, design_id, position, quantity) VALUES (?, ?, 1, 'standard', ?, ?, 1, 1)", [COMPANY, orderId, ITEM, ITEM]);
  const SOA = await order('A', addDays(D0, 3));
  const SOB = await order('B', addDays(D0, 30));
  const LA = await line(SOA);
  const LB = await line(SOB);
  const prodOrder = (orderId, lineId, seq, key) => ins(
    "INSERT INTO cf_production_orders (company_id, order_id, seq, code, label, level, order_line_id, scope_key, lines_json, status) VALUES (?, ?, ?, ?, ?, 'line', ?, ?, ?, 'planned')",
    [COMPANY, orderId, seq, `${RUN}-${key}-P0${seq}`, `${RUN}-${key} · Span ${seq} of 1`, lineId, `L${lineId}`, JSON.stringify([lineId])]);
  const POA = await prodOrder(SOA, LA, 1, 'A');
  const POB = await prodOrder(SOB, LB, 1, 'B');
  const release = (orderId, lineId) => ins('INSERT INTO cf_production_releases (company_id, order_id, order_line_id, item_id, quantity) VALUES (?, ?, ?, ?, 1)', [COMPANY, orderId, lineId, ITEM]);
  const RA = await release(SOA, LA);
  const RB = await release(SOB, LB);
  let sort = 0;
  const piece = (rel, po, code) => ins(
    'INSERT INTO cf_production_items (company_id, release_id, item_id, quantity, piece_no, code, flow_id, depth, sort_order, production_order_id) VALUES (?, ?, ?, 1, 1, ?, ?, 0, ?, ?)',
    [COMPANY, rel, ITEM, code, flow.id, ++sort, po]);
  const step = (itemRow, po, opId, seq, minutes, qty = 1) => ins(
    "INSERT INTO cf_production_steps (company_id, production_item_id, operation_id, sequence, quantity, state, est_setup_minutes, est_work_minutes, est_minutes, production_order_id) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)",
    [COMPANY, itemRow, opId, seq, qty, minutes / qty, minutes, po]);
  const IA = await piece(RA, POA, `${RUN}-A1`);
  const IB = await piece(RB, POB, `${RUN}-B1`);
  const SA1 = await step(IA, POA, OPC, 10, 600);       // cut 600 min (480 a day: over two days)
  const SA2 = await step(IA, POA, OPW, 20, 300);       // weld 300 min
  const SB1 = await step(IB, POB, OPC, 10, 240);
  const SB2 = await step(IB, POB, OPW, 20, 120);
  const wait = (s, on) => conn.query("INSERT INTO cf_step_dependencies (company_id, step_id, target_step_id, required, origin) VALUES (?, ?, ?, 'done', 'flow')", [COMPANY, s, on]);
  await wait(SA2, SA1);
  await wait(SB2, SB1);
  ok('fixture: 2 orders, 2 production orders, 4 steps, 2 waits', !!(SOA && SOB && POA && POB && SA1 && SB2));

  const plan = async (q = {}) => P3.getPlanner3(conn, COMPANY, { steps: '1', ...q });
  const stepOf = (p, id) => p.steps.find((s) => s.id === id);
  const poOf = (p, id) => p.productionOrders.find((o) => o.id === id);

  /* ------------------------------------------------------------------------------------------- */
  section('C. Precedence and capacity');
  let p = await plan();
  ok('mode auto by default — made "by AI"', p.mode === 'auto' && p.madeBy === 'AI');
  ok('both production orders are on the plan with their steps', !!poOf(p, POA) && !!poOf(p, POB) && poOf(p, POA).steps === 2);
  ok('the label reads simply ("… · Span 1 of 1")', /· Span 1 of 1$/.test(poOf(p, POA).label));
  ok('A\'s cut starts today and runs into the next day (600 min on 480 a day)', stepOf(p, SA1).start.startsWith(D0) && stepOf(p, SA1).end.startsWith(addDays(D0, 1)), `${stepOf(p, SA1).start} → ${stepOf(p, SA1).end}`);
  ok('A\'s weld waits for its cut to finish', stepOf(p, SA2).start >= stepOf(p, SA1).end, `${stepOf(p, SA2).start} vs ${stepOf(p, SA1).end}`);
  ok('auto: A (committed sooner) goes first; B\'s cut waits behind it on the one cutting machine', stepOf(p, SB1).start >= stepOf(p, SA1).end && poOf(p, POA).rank === 1);
  ok('B is "slowed by" the cutting machine busy with A', poOf(p, POB).slowedBy.some((r) => r.kind === 'capacity' && r.text.includes(poOf(p, POA).label)), JSON.stringify(poOf(p, POB).slowedBy));
  ok('per machine type: capacity per day from the shifts (480) and the planned load', (() => {
    const t = p.machineTypes.find((x) => x.key === String(TCUT));
    return !!t && t.capacity[0] === 480 && t.load[0] > 470 && t.machines.length === 2;
  })());
  await SHIFT.createShift(conn, c, CUT2, { name: `${RUN} Day`, weekdays: allDays, startTime: '08:00', endTime: '16:00', breakMinutes: 0 });
  p = await plan();
  ok('a second cutting machine with shifts takes B at once', stepOf(p, SB1).start.startsWith(D0) && stepOf(p, SB1).machineId !== stepOf(p, SA1).machineId);
  // Back to one cutting machine for the rest (CUT2's shift goes).
  await conn.query('UPDATE cf_machine_shifts SET deleted_at = NOW() WHERE company_id = ? AND machine_id = ?', [COMPANY, CUT2]);

  /* ------------------------------------------------------------------------------------------- */
  section('D. Auto vs manual');
  await P3.putOrderInputs(conn, c, { rows: [{ id: POB, rank: 1 }, { id: POA, rank: 2 }] });
  p = await plan();
  ok('auto still puts the committed date first (B ranked 1 by hand does not jump it)', poOf(p, POA).rank === 1);
  p = await plan({ mode: 'manual' });
  ok('manual: B (rank 1) cuts first, A stretches behind it — made by Management', p.madeBy === 'Management' && stepOf(p, SB1).start.startsWith(D0) && stepOf(p, SA1).start >= stepOf(p, SB1).end);
  ok('manual shows end dates and money unlocked (no acceptance = 0)', !!poOf(p, POA).end && poOf(p, POA).money === 0);
  ok('A is late against its committed date in manual', poOf(p, POA).late === true || poOf(p, POA).end.slice(0, 10) <= addDays(D0, 3));
  await P3.putOrderInputs(conn, c, { rows: [{ id: POB, earliestStart: addDays(D0, 5) }] });
  p = await plan({ mode: 'manual' });
  ok('manual: an earliest start holds B back; A takes the machine meanwhile', stepOf(p, SB1).start >= `${addDays(D0, 5)} 00:00:00` && stepOf(p, SA1).start.startsWith(D0)
    && poOf(p, POB).slowedBy.some((r) => r.kind === 'start'), JSON.stringify(poOf(p, POB).slowedBy));
  const kept = (await conn.query('SELECT priority_rank, earliest_start FROM cf_plan3_order_inputs WHERE company_id = ? AND production_order_id = ?', [COMPANY, POB]))[0][0];
  ok('only the fields sent change: B kept rank 1 when its earliest start was set', Number(kept.priority_rank) === 1 && kept.earliest_start != null);
  p = await plan({ mode: 'auto' });
  ok('auto ignores an earliest start that is not pinned', stepOf(p, SB1).start < `${addDays(D0, 5)} 00:00:00` || stepOf(p, SB1).start >= stepOf(p, SA1).end);
  await P3.putOrderInputs(conn, c, { rows: [{ id: POB, pinned: true, earliestStart: null }] });
  p = await plan({ mode: 'auto' });
  ok('auto: a PINNED production order keeps its rank (B first)', poOf(p, POB).rank === 1 && stepOf(p, SB1).start.startsWith(D0));
  await P3.putOrderInputs(conn, c, { rows: [{ id: POB, pinned: false, rank: null }, { id: POA, rank: null }] });
  const badIn = await refusal(() => P3.putOrderInputs(conn, c, { rows: [{ id: POA, earliestStart: '2026-02-30' }] }));
  ok('a bad earliest start is refused (422)', badIn?.status === 422);
  const badMode = await refusal(() => P3.putSettings(conn, c, { mode: 'fast' }));
  ok('a mode that is not auto/manual is refused', badMode?.status === 422);
  await P3.putSettings(conn, c, { mode: 'manual' });
  p = await plan();
  ok('the stored mode is used when none is asked', p.mode === 'manual' && p.storedMode === 'manual');
  await P3.putSettings(conn, c, { mode: 'auto' });

  /* ------------------------------------------------------------------------------------------- */
  section('E. Material — first come, first served by planned start');
  const qReq = (rel, item, stepId, qty) => ins('INSERT INTO cf_material_requirements (company_id, release_id, production_item_id, step_id, item_id, quantity) VALUES (?, ?, ?, ?, ?, ?)', [COMPANY, rel, null, stepId, item, qty]);
  await qReq(RA, RM, SA1, 4);
  await qReq(RB, RM, SB1, 6);
  p = await plan();
  ok('no stock, nothing ordered: both cuts wait with no date — not planned', stepOf(p, SA1).start == null && stepOf(p, SB1).start == null && poOf(p, POA).unplanned >= 2 && !!stepOf(p, SA1).why, stepOf(p, SA1).why);
  ok('…and the production order says what it waits for', poOf(p, POA).end == null && poOf(p, POA).slowedBy.some((r) => r.kind === 'material'));
  const area = await AREA.createArea(conn, c, { code: `${RUN}-STO`, name: `${RUN} storage`, purpose: 'storage' });
  await STOCK.postMovement(conn, c, { movementType: 'receipt', movementDate: realToday, toAreaId: area.id, reference: RUN, lines: [{ itemId: RM, quantity: 4 }] });
  const poHead = await ins("INSERT INTO cf_purchase_orders (company_id, code, status, expected_date) VALUES (?, ?, 'ordered', ?)", [COMPANY, `${RUN}-PO`, addDays(D0, 20)]);
  const poLine = await ins("INSERT INTO cf_purchase_order_lines (company_id, purchase_order_id, line_no, item_id, quantity, qty_received, uom, expected_date) VALUES (?, ?, 1, ?, 6, 0, 'nos', ?)", [COMPANY, poHead, RM, addDays(D0, 4)]);
  p = await plan();
  ok('A (first) takes the free stock (4) and cuts today', stepOf(p, SA1).start.startsWith(D0), stepOf(p, SA1).start);
  ok('B gets the PO line\'s OWN date (day 4), not the PO\'s (day 20)', stepOf(p, SB1).start.startsWith(addDays(D0, 4)), stepOf(p, SB1).start);
  ok('B is "slowed by" material, in words with the PO', poOf(p, POB).slowedBy.some((r) => r.kind === 'material' && r.text.includes(`${RUN}-PO`)), JSON.stringify(poOf(p, POB).slowedBy));
  p = await plan({ mode: 'manual' });
  await P3.putOrderInputs(conn, c, { rows: [{ id: POB, rank: 1 }, { id: POA, rank: 2 }] });
  p = await plan({ mode: 'manual' });
  ok('manual with B first: B claims the stock first (4 of 6) and still waits for the PO (day 4); A then waits for the PO too', stepOf(p, SB1).start.startsWith(addDays(D0, 4)) && stepOf(p, SA1).start >= `${addDays(D0, 4)} 00:00:00`, `${stepOf(p, SB1).start} ${stepOf(p, SA1).start}`);
  await P3.putOrderInputs(conn, c, { rows: [{ id: POB, rank: null }, { id: POA, rank: null }] });
  // A receipt overrides the date.
  await STOCK.postMovement(conn, c, { movementType: 'receipt', movementDate: realToday, toAreaId: area.id, reference: `${RUN}-GRN`, lines: [{ itemId: RM, quantity: 6 }] });
  await conn.query('UPDATE cf_purchase_order_lines SET qty_received = 6 WHERE id = ?', [poLine]);
  await conn.query("UPDATE cf_purchase_orders SET status = 'received' WHERE id = ?", [poHead]);
  p = await plan();
  ok('once received, B\'s material is here: no material wait', !poOf(p, POB).slowedBy.some((r) => r.kind === 'material') && stepOf(p, SB1).start < `${addDays(D0, 4)} 00:00:00`, stepOf(p, SB1).start);

  /* ------------------------------------------------------------------------------------------- */
  section('F. Capacity minus planned downtime and an open fault');
  p = await plan();
  const endBefore = stepOf(p, SA1).end;
  // A whole day off on the cutting machine tomorrow, as Maintenance writes it (a closed exception with its rule id).
  await conn.query("INSERT INTO cf_machine_calendar_exceptions (company_id, machine_id, exception_date, kind, reason) VALUES (?, ?, ?, 'closed', ?)", [COMPANY, CUT1, addDays(D0, 1), `${RUN} planned`]);
  p = await plan();
  ok('a day off on the cutting machine moves A\'s cut end a day later', stepOf(p, SA1).end.startsWith(addDays(D0, 2)), `${endBefore} → ${stepOf(p, SA1).end}`);
  const [[reason]] = await conn.query('SELECT id FROM cf_stop_reasons WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [COMPANY]);
  const stopId = await ins("INSERT INTO cf_machine_stops (company_id, machine_id, started_at, reason_id, source) VALUES (?, ?, ?, ?, 'live')", [COMPANY, CUT1, `${D0} 00:00:00`, reason.id]);
  await ins("INSERT INTO cf_maintenance_orders (company_id, code, machine_id, source, stop_id, reason_id, title, status, raised_at) VALUES (?, ?, ?, 'fault', ?, ?, 'TPL3 fault', 'open', NOW())", [COMPANY, `${RUN}-MO`, CUT1, stopId, reason.id]);
  p = await plan();
  ok('an open fault: the only cutting machine has no capacity — the cuts cannot be planned', stepOf(p, SA1).start == null && stepOf(p, SB1).start == null);
  ok('…and the plan says why: "… is down — fault …"', poOf(p, POA).slowedBy.some((r) => r.kind === 'down' && r.text.includes(`${RUN}-MO`)), JSON.stringify(poOf(p, POA).slowedBy));
  ok('the machine type shows the machine down', p.machineTypes.find((t) => t.key === String(TCUT)).machines.some((m) => m.id === CUT1 && m.down));
  await conn.query("UPDATE cf_maintenance_orders SET status = 'done' WHERE company_id = ? AND code = ?", [COMPANY, `${RUN}-MO`]);
  await conn.query('UPDATE cf_machine_stops SET ended_at = ? WHERE id = ?', [`${D0} 00:00:00`, stopId]);
  await conn.query('DELETE FROM cf_machine_calendar_exceptions WHERE company_id = ? AND machine_id = ? AND reason = ?', [COMPANY, CUT1, `${RUN} planned`]);
  p = await plan();
  ok('fault closed, day off gone: back as before', stepOf(p, SA1).end === endBefore);

  /* ------------------------------------------------------------------------------------------- */
  section('G. Re-plan with started steps (no frozen window)');
  P3.setPlannerNow(`${D0} 12:00`);
  await conn.query("UPDATE cf_production_steps SET state = 'in_progress', started_at = ?, machine_id = ? WHERE id = ?", [`${D0} 02:00:00`, CUT1, SA1]);
  await conn.query("INSERT INTO cf_work_sessions (company_id, machine_id, step_id, started_at, ended_at, end_kind, source) VALUES (?, ?, ?, ?, ?, 'pause', 'live')", [COMPANY, CUT1, SA1, `${D0} 02:00:00`, `${D0} 05:20:00`]);
  p = await plan();
  const a1 = stepOf(p, SA1);
  ok('a started step keeps its real start', a1.start === `${D0} 02:00:00` && a1.state === 'in_progress');
  ok('…and plans planned − elapsed: 600 − 200 = 400 minutes left', Math.abs(a1.minutes - 400) < 0.01, String(a1.minutes));
  ok('the unstarted steps all move from now (no frozen window)', stepOf(p, SB1).start >= `${D0} 12:00:00` && stepOf(p, SA2).start >= a1.end);
  await conn.query("INSERT INTO cf_work_sessions (company_id, machine_id, step_id, started_at, ended_at, end_kind, source) VALUES (?, ?, ?, ?, ?, 'pause', 'live')", [COMPANY, CUT1, SA1, `${D0} 05:30:00`, `${D0} 11:00:00`]);
  p = await plan();
  ok('elapsed (530) ≥ planned (600)? not yet: 70 left', Math.abs(stepOf(p, SA1).minutes - 70) < 0.01, String(stepOf(p, SA1).minutes));
  await conn.query("INSERT INTO cf_work_sessions (company_id, machine_id, step_id, started_at, ended_at, end_kind, source) VALUES (?, ?, ?, ?, ?, 'pause', 'live')", [COMPANY, CUT1, SA1, `${D0} 11:00:00`, `${D0} 12:00:00`]);
  await conn.query("INSERT INTO cf_work_sessions (company_id, machine_id, step_id, started_at, ended_at, end_kind, source) VALUES (?, ?, ?, ?, ?, 'pause', 'live')", [COMPANY, CUT1, SA1, `${D0} 01:00:00`, `${D0} 02:00:00`]);
  p = await plan();
  ok('planned − elapsed ≤ 0: it is assumed to finish now, and the weld can start now', stepOf(p, SA1).minutes === 0 && stepOf(p, SA1).end === `${D0} 12:00:00` && stepOf(p, SA2).start === `${D0} 12:00:00`, `${stepOf(p, SA1).end} ${stepOf(p, SA2).start}`);
  await conn.query("UPDATE cf_production_steps SET state = 'done', finished_at = ? WHERE id = ?", [`${D0} 11:30:00`, SA1]);
  p = await plan();
  ok('a done step keeps its real dates', stepOf(p, SA1).start === `${D0} 02:00:00` && stepOf(p, SA1).end === `${D0} 11:30:00` && stepOf(p, SA1).real === true);
  await conn.query("UPDATE cf_production_steps SET state = 'pending', started_at = NULL, finished_at = NULL, machine_id = NULL WHERE id = ?", [SA1]);
  await conn.query('DELETE FROM cf_work_sessions WHERE company_id = ? AND step_id = ?', [COMPANY, SA1]);
  P3.setPlannerNow(`${D0} 00:00`);

  /* ------------------------------------------------------------------------------------------- */
  section('H. The order\'s time override (§76) plans in seconds');
  await conn.query('UPDATE cf_sales_orders SET time_override_seconds = 0.1 WHERE id = ?', [SOA]);
  p = await plan();
  const sec = (a, b) => (new Date(b.replace(' ', 'T')) - new Date(a.replace(' ', 'T'))) / 1000;
  ok('A\'s steps are (0.1 s + 0.1 s) × 1 each — A ends within seconds of now', poOf(p, POA).minutesLeft < 0.01 && sec(`${D0} 00:00:00`, poOf(p, POA).end) < 60, `${poOf(p, POA).minutesLeft} min, ends ${poOf(p, POA).end}`);
  ok('…through the one formula (timeEstimateService.stepMinutes)', Math.abs(stepOf(p, SA1).minutes - 0.003) < 0.0006, String(stepOf(p, SA1).minutes));
  await conn.query('UPDATE cf_sales_orders SET time_override_seconds = NULL WHERE id = ?', [SOA]);

  /* ------------------------------------------------------------------------------------------- */
  section('I. Save, baseline, re-baseline (Management), plan health');
  // Clean tables of this company first (inside the transaction): the suite owns the whole plan.
  for (const t of ['cf_plan3_steps', 'cf_plan3_orders', 'cf_plan3_baseline_orders', 'cf_plan3_baselines']) await conn.query(`DELETE FROM ${t} WHERE company_id = ?`, [COMPANY]);
  await conn.query("UPDATE cf_approvals SET status = 'withdrawn' WHERE company_id = ? AND approval_type = 'rebaseline' AND status = 'pending'", [COMPANY]);
  const noPlan = await refusal(() => P3.askRebaseline(conn, c, { note: 'x' }));
  ok('re-baseline before any saved plan is refused', noPlan?.code === 'NO_PLAN', noPlan?.message);
  const s1 = await P3.savePlan(conn, c, {});
  ok('the first save stores the plan and makes baseline v1 (no approval)', s1.baseline?.version === 1 && s1.saved.steps >= 4 && s1.saved.madeBy === 'AI');
  const [[cnt]] = await conn.query('SELECT (SELECT COUNT(*) FROM cf_plan3_steps WHERE company_id = ?) AS s, (SELECT COUNT(*) FROM cf_plan3_orders WHERE company_id = ?) AS o', [COMPANY, COMPANY]);
  ok('every step and production order has its planned dates', Number(cnt.s) >= 4 && Number(cnt.o) >= 2);
  const s2 = await P3.savePlan(conn, c, {});
  ok('saving again replaces the plan and keeps the baseline', s2.baseline === null);
  let h = await P3.planHealth(conn, COMPANY);
  ok('plan health: everything on time against v1', h.baseline?.version === 1 && h.compared >= 2 && h.late === 0 && h.onTimePct === 100);
  // A day off pushes A's work: re-save → late against the baseline, with its reason.
  await conn.query("INSERT INTO cf_machine_calendar_exceptions (company_id, machine_id, exception_date, kind, reason) VALUES (?, ?, ?, 'closed', ?), (?, ?, ?, 'closed', ?)",
    [COMPANY, CUT1, D0, `${RUN} off`, COMPANY, CUT1, addDays(D0, 1), `${RUN} off`]);
  await P3.savePlan(conn, c, {});
  h = await P3.planHealth(conn, COMPANY);
  ok('plan health: late against the baseline, slip in days, by reason', h.late >= 1 && h.slipDays >= 1 && h.byReason.length >= 1 && h.worst.length >= 1, JSON.stringify(h));
  p = await plan();
  ok('the planner shows the baseline end and the slip per production order', poOf(p, POA).baseline?.end != null && (poOf(p, POA).slipDays ?? 0) >= 1 && p.health.late >= 1);
  const noNote = await refusal(() => P3.askRebaseline(conn, c, {}));
  ok('re-baseline needs a reason', noNote?.code === 'REASON');
  const ask = await P3.askRebaseline(conn, c, { note: `${RUN} the cutting machine is out two days` });
  ok('re-baseline asks Management (approval type rebaseline, v2 pending)', ask.baseline.version === 2 && ask.baseline.status === 'pending' && !!ask.approvalId);
  const again = await refusal(() => P3.askRebaseline(conn, c, { note: 'again' }));
  ok('one re-baseline waits at a time', again?.code === 'PENDING');
  const list = await APPROVAL.listApprovals(conn, COMPANY, () => true, { type: 'rebaseline' });
  const row = list.rows.find((r) => r.id === ask.approvalId);
  ok('it is in the Management inbox with what moves (live context)', !!row && row.context?.kind === 'rebaseline' && row.context.later >= 1, JSON.stringify(row?.context));
  p = await plan();
  ok('the planner shows the re-baseline waiting', p.pendingRebaseline?.version === 2);
  const rej = await APPROVAL.decide(conn, c, ask.approvalId, { decision: 'reject', note: 'not yet' }, { can: () => true, isAdmin: true });
  ok('rejected: v2 is rejected, v1 stays the baseline', rej.approval.status === 'rejected' && (await P3.planHealth(conn, COMPANY)).baseline.version === 1);
  const ask3 = await P3.askRebaseline(conn, c, { note: `${RUN} accept the new dates` });
  const ap = await APPROVAL.decide(conn, c, ask3.approvalId, { decision: 'approve' }, { can: () => true, isAdmin: true });
  h = await P3.planHealth(conn, COMPANY);
  ok('approved: the saved plan is the new baseline (v3) and v1 is superseded', ap.approval.status === 'approved' && h.baseline.version === 3 && h.late === 0, JSON.stringify(h.baseline));
  const [[v1]] = await conn.query("SELECT status FROM cf_plan3_baselines WHERE company_id = ? AND version = 1", [COMPANY]);
  ok('…v1 superseded', v1?.status === 'superseded');
  await conn.query('DELETE FROM cf_machine_calendar_exceptions WHERE company_id = ? AND machine_id = ? AND reason = ?', [COMPANY, CUT1, `${RUN} off`]);

  /* ------------------------------------------------------------------------------------------- */
  section('J. Round trips and routes');
  const cnt1 = counting(conn);
  await P3.getPlanner3(cnt1.db, COMPANY, {});
  // Twice the steps: the round trips must not grow.
  const IA2 = await piece(RA, POA, `${RUN}-A2`);
  for (let i = 0; i < 20; i++) await step(IA2, POA, i % 2 ? OPW : OPC, 10 + i, 30);
  const cnt2 = counting(conn);
  const big = await P3.getPlanner3(cnt2.db, COMPANY, {});
  ok(`GET round trips are fixed (${cnt1.tally.n} → ${cnt2.tally.n} with 20 more steps)`, cnt2.tally.n === cnt1.tally.n, `${cnt1.tally.n} ${cnt2.tally.n}`);
  ok(`GET stays within planner_test's budget (${cnt2.tally.n} ≤ ${GET_BUDGET})`, cnt2.tally.n <= GET_BUDGET);
  ok('without steps=1 the answer carries no step list (it stays small)', big.steps === undefined && big.productionOrders.length >= 2);
  const cnt3 = counting(conn);
  await P3.putOrderInputs(cnt3.db, c, { rows: [{ id: POA, rank: 3 }, { id: POB, rank: 4 }] });
  ok(`PUT orders is 2 round trips for any number (${cnt3.tally.n})`, cnt3.tally.n === 2);
  const routeList = routes.stack.filter((l) => l.route).map((l) => `${Object.keys(l.route.methods)[0]} ${l.route.path}`);
  ok('routes: GET /planner3, health, settings, orders, run, rebaseline', ['get /planner3', 'get /planner3/health', 'put /planner3/settings', 'put /planner3/orders', 'post /planner3/run', 'post /planner3/rebaseline'].every((r) => routeList.includes(r)), routeList.join(', '));
  const [[hnd]] = [[APPROVAL.APPROVAL_TYPES.rebaseline]];
  ok('the approval type rebaseline exists with its tag', hnd?.perm === 'cf_erp_approve_rebaseline');
} catch (e) {
  console.error(e);
  failed += 1;
  fails.push(`crashed: ${e.message}`);
  exitCode = 1;
} finally {
  P3.setPlannerNow(null);
  MR.setToday(null);
  OPS.clearProductionMachines(COMPANY);
  await conn.rollback();
  detachNodeCache(conn);
  const after = await census(conn).catch(() => null);
  if (before && after) {
    const moved = Object.keys(before).filter((t) => before[t] !== after[t]);
    section('Clean-up');
    ok(`every cf_ table is back where it started (${Object.keys(before).length} tables)`, moved.length === 0, moved.slice(0, 8).join(', '));
  }
  conn.release();
  await pool.end();
}
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log(fails.map((f) => `  - ${f}`).join('\n')); exitCode = 1; }
process.exit(exitCode);
