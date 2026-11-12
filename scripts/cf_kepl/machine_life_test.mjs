/**
 * machine_life_test.mjs — §104, THE MACHINE LIFECYCLE (user, 2026-11-12): a received machine waits on Stores' "To
 * register" → registered (serial, type) → out of stock as an asset → SETUP with a setup ticket → moved Stores ↔
 * Maintenance → the ticket's issues (Installation capitalised, Consumable expensed) → ticket closed → LIVE (depreciation
 * from that day) → checked out / in → order use by days (shared by run hours; a booked day goes to its order) → condemn
 * asked → the MD sends it back → asked again → approved → disposal recorded (the rest written off). Durable tools too.
 *
 *   cd multi_app_be && node scripts/cf_kepl/machine_life_test.mjs        (CF_LIFE_COMPANY, default 2)
 * One transaction, rolled back; the cf_ tables are counted before and after.
 */
import path from 'path';
import { pathToFileURL } from 'url';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
await imp('apps/cf_erp/services/codegenProvider.js');
const { attachNodeCache, detachNodeCache } = await imp('apps/cf_erp/lib/db.js');
const L = await imp('apps/cf_erp/services/machineLifeService.js');
const MO = await imp('apps/cf_erp/services/maintenanceService.js');
const AP = await imp('apps/cf_erp/services/approvalService.js');
const ST = await imp('apps/cf_erp/services/stockService.js');
const MS = await imp('apps/cf_erp/services/machineService.js');
const REQ = await imp('apps/cf_erp/services/machineRequestService.js');
const routes = (await imp('apps/cf_erp/routes/machineLife.js')).default;

if (!/^(localhost|127\.0\.0\.1|::1)$/.test(process.env.DB_HOST ?? 'localhost')) throw new Error('This suite is local only.');
const COMPANY = Number(process.env.CF_LIFE_COMPANY ?? 2);
const RUN = `TEST-LIFE-${Date.now().toString(36).toUpperCase()}`;
let passed = 0; let failed = 0; const fails = [];
function ok(label, cond, detail = '') {
  if (typeof label !== 'string' || typeof cond !== 'boolean') throw new Error('ok(label, cond)');
  if (cond) { passed += 1; console.log(`  PASS  ${label}`); } else { failed += 1; fails.push(label); console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
}
const refusal = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.02;
async function census(db) {
  const [rows] = await db.query("SHOW TABLES LIKE 'cf\\_%'");
  const out = {};
  for (const t of rows.map((r) => Object.values(r)[0]).sort()) { const [[r]] = await db.query(`SELECT COUNT(*) AS n FROM \`${t}\``); out[t] = Number(r.n); }
  return out;
}
const dayOff = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

const routeList = routes.stack.filter((l) => l.route).map((l) => `${Object.keys(l.route.methods)[0]} ${l.route.path}`);
ok('routes: register, life, log, move, check-out / in, condemn, disposal, cost', ['get /machines-to-register', 'post /machines-to-register', 'get /machines/:id/life', 'get /machines/:id/log',
  'post /machines/:id/move', 'post /machines/:id/check-out', 'post /machines/:id/check-in', 'post /machines/:id/condemn', 'post /machines/:id/disposal', 'put /machines/:id/cost',
  'get /machine-checkouts', 'get /machine-custodians'].every((r) => routeList.includes(r)), routeList.join(', '));
ok('approval type: Condemn a machine (its own tag)', AP.APPROVAL_TYPES.machine_condemn?.perm === 'cf_erp_approve_machine_condemn');

console.log('\nThe pure day-sharing');
{
  const sessions = [
    { machine_id: 1, order_id: 10, started_at: '2026-11-01 09:00:00', ended_at: '2026-11-01 12:00:00' },
    { machine_id: 1, order_id: 20, started_at: '2026-11-01 13:00:00', ended_at: '2026-11-01 14:00:00' },
    { machine_id: 1, order_id: 20, started_at: '2026-11-02 22:00:00', ended_at: '2026-11-03 02:00:00' },
  ];
  const booked = [{ machine_id: 1, order_id: 10, d1: '2026-11-03', d2: '2026-11-04' }];
  const s = L.sharesFrom(sessions, booked, '2026-11-01', '2026-11-05', '2026-11-05 10:00:00').get(1);
  ok('a day is split by run hours (3 h : 1 h)', near(s.get('2026-11-01').get(10), 0.75) && near(s.get('2026-11-01').get(20), 0.25));
  ok('a session over midnight counts on both days', near(s.get('2026-11-02').get(20), 1) && near(s.get('2026-11-03').get(20), 1));
  ok('run hours win over a check-out; a booked day with none goes to its order', !s.get('2026-11-03').has(10) && near(s.get('2026-11-04').get(10), 1));
  ok('a day with neither is idle (not charged)', !s.has('2026-11-05'));
  ok('hoursByDay splits at midnight', JSON.stringify(L.hoursByDay('2026-11-02 22:00:00', '2026-11-03 02:00:00')) === JSON.stringify([['2026-11-02', 2], ['2026-11-03', 2]]));
}
{
  const dep = L.depreciationOf({ cost: 365000, salvage_value: 36500, life_years: 1, live_on: '2026-01-01', condemned_on: null }, 0, '2026-01-11');
  ok('straight line: (cost − salvage) ÷ days of life, 10 days used', dep.perDay === 900 && dep.accumulated === 9000 && dep.bookValue === 356000, JSON.stringify(dep));
  const capped = L.depreciationOf({ cost: 1000, salvage_value: 100, life_years: 1, live_on: '2020-01-01', condemned_on: null }, 0, '2026-01-01');
  ok('never below salvage', capped.bookValue === 100);
  ok('no cost or life: no depreciation', L.depreciationOf({ cost: null, life_years: 5, live_on: '2026-01-01' }, 0, '2026-02-01') === null);
}

const conn = await pool.getConnection();
let before = null;
let exitCode = 0;
try {
  before = await census(conn);
  await conn.beginTransaction();
  attachNodeCache(conn);
  const [[user]] = await conn.query('SELECT id FROM users WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [COMPANY]);
  const c = { companyId: COMPANY, userId: user?.id ?? null };
  const md = { can: () => true, isAdmin: true };
  const [[store]] = await conn.query("SELECT id, code FROM cf_stocking_areas WHERE company_id = ? AND purpose = 'storage' AND status = 'active' AND deleted_at IS NULL LIMIT 1", [COMPANY]);
  const [ins] = await conn.query("INSERT INTO cf_stocking_areas (company_id, code, name, purpose, status, created_by) VALUES (?, ?, 'Maintenance bay (test)', 'maintenance', 'active', ?)", [COMPANY, `${RUN}-MB`, c.userId]);
  const bay = { id: ins.insertId };
  const [[po]] = await conn.query('SELECT id FROM cf_purchase_orders WHERE company_id = ? LIMIT 1', [COMPANY]);
  const [[mtype]] = await conn.query("SELECT id FROM cf_classification_nodes WHERE company_id = ? AND scope = 'machine' AND depth = 2 AND status = 'active' AND deleted_at IS NULL LIMIT 1", [COMPANY]);

  // A received machine: a machine model (Capital equipment), 2 units in stock, on a GRN bill line.
  const variant = await REQ.machineModelVariant(conn, c);
  const { createItem } = await imp('apps/cf_erp/services/masterRecordService.js');
  const model = await createItem(conn, c, { itemType: 'catalog', classificationId: variant, name: `${RUN} CNC router`, trackedBy: 'quantity', sourcing: 'stock', uom: 'nos' }, { fallbackName: `${RUN} CNC router` });
  await conn.query("UPDATE cf_master_records SET status = 'active' WHERE id = ?", [model.id]);
  const rcpt = await ST.postMovement(conn, c, { movementType: 'receipt', lines: [{ itemId: model.id, quantity: 2, toAreaId: store.id, unitCost: 365000 }] });
  const [bill] = await conn.query("INSERT INTO cf_grn_bills (company_id, purchase_order_id, grn_date, created_by) VALUES (?, ?, ?, ?)", [COMPANY, po?.id ?? 0, dayOff(-20), c.userId]);
  const [bl] = await conn.query('INSERT INTO cf_grn_bill_lines (company_id, bill_id, line_no, movement_id, item_id, quantity, landed_unit_cost) VALUES (?, ?, 1, ?, ?, 2, 365000)', [COMPANY, bill.insertId, rcpt.id, model.id]);

  console.log('\nA. Register what arrived');
  let todo = await L.toRegister(conn, COMPANY, { billId: bill.insertId });
  ok('the GRN line waits on "To register": a machine, 2 left, at the store', todo.length === 1 && todo[0].kind === 'machine' && todo[0].left === 2 && todo[0].area?.id === store.id, JSON.stringify(todo));
  const dupSerial = await refusal(() => L.registerReceived(conn, c, { billLineId: bl.insertId, units: [{ classificationId: mtype.id, serialNumber: 'S-1' }, { classificationId: mtype.id, serialNumber: 's-1' }] }));
  ok('two units may not share a serial', dupSerial?.code === 'VALIDATION' || /same serial/.test(dupSerial?.message ?? '') || dupSerial?.problems?.some((p) => /same serial/.test(p)), dupSerial?.message);
  const reg = await L.registerReceived(conn, c, { billLineId: bl.insertId, lifeYears: 1, salvageValue: 0, units: [{ name: `${RUN} Router A`, classificationId: mtype.id, serialNumber: `${RUN}-SN1` }] });
  const mid = reg.machines[0].id;
  ok('one unit registered: Setup, one left to register', reg.stage === 'setup' && reg.left === 1);
  const [[m1]] = await conn.query('SELECT stage, status, kind, area_id, cost, life_years, grn_bill_line_id FROM cf_machines WHERE id = ?', [mid]);
  ok('…in Setup (not planned), at the store, at the GRN cost', m1.stage === 'setup' && m1.status === 'inactive' && m1.kind === 'machine' && Number(m1.area_id) === store.id && Number(m1.cost) === 365000, JSON.stringify(m1));
  const [[bal]] = await conn.query('SELECT COALESCE(SUM(quantity), 0) AS q FROM cf_stock_ledger WHERE company_id = ? AND item_id = ?', [COMPANY, model.id]);
  ok('…and out of stock (an asset issue, not a consumable)', Number(bal.q) === 1);
  const [[asset]] = await conn.query("SELECT used_for FROM cf_stock_movements WHERE company_id = ? AND movement_type = 'issue' ORDER BY id DESC LIMIT 1", [COMPANY]);
  ok('…the issue is used for "asset"', asset.used_for === 'asset');
  let life = await L.getMachineLife(conn, COMPANY, mid);
  ok('a setup ticket is raised for Maintenance', !!life.setupTicket && /^Set up/.test(life.setupTicket.title));

  console.log('\nB. Setup: move, issue, treatment');
  const notOut = await refusal(() => L.checkOut(conn, c, mid, { toKind: 'user', toId: c.userId }));
  ok('a setup machine is not checked out', notOut?.code === 'NOT_LIVE');
  life = await L.moveMachine(conn, c, mid, { areaId: bay.id, note: 'To the bay for wiring' });
  ok('moved to the maintenance bay', life.area?.id === bay.id);
  const [[cable]] = await conn.query("SELECT m.id FROM cf_master_records m JOIN cf_item_details d ON d.master_id = m.id WHERE m.company_id = ? AND d.item_type = 'catalog' AND d.tracked_by = 'quantity' AND m.status = 'active' AND m.deleted_at IS NULL AND m.id <> ? LIMIT 1", [COMPANY, model.id]);
  await ST.postMovement(conn, c, { movementType: 'receipt', lines: [{ itemId: cable.id, quantity: 10, toAreaId: store.id, unitCost: 500 }] });
  await ST.postMovement(conn, c, { movementType: 'issue', usedFor: 'general', maintenanceOrderId: life.setupTicket.id, lines: [{ itemId: cable.id, quantity: 4, fromAreaId: store.id }] });
  life = await L.getMachineLife(conn, COMPANY, mid);
  const item = life.cost.setupItems.find((i) => i.itemId === Number(cable.id));
  ok('the ticket\'s issue is listed with its value', !!item && near(item.qty, 4) && item.value > 0, JSON.stringify(life.cost.setupItems));
  const capBefore = life.cost.setupCapital + life.cost.setupExpense;
  life = await L.setSetupTreatment(conn, c, mid, cable.id, { treatment: 'expense' });
  ok('flipped to Consumable: expensed, not capitalised', life.cost.setupExpense > 0 && near(life.cost.setupCapital + life.cost.setupExpense, capBefore) && life.cost.setupItems.find((i) => i.itemId === Number(cable.id)).treatment === 'expense');
  life = await L.setSetupTreatment(conn, c, mid, cable.id, { treatment: 'capital' });
  life = await L.moveMachine(conn, c, mid, { areaId: store.id });
  const sameAgain = await refusal(() => L.moveMachine(conn, c, mid, { areaId: store.id }));
  ok('back to the store; moving to where it is is refused', life.area?.id === store.id && sameAgain?.code === 'SAME_PLACE');
  const direct = await refusal(() => L.goLive(conn, c, mid, { direct: true }));
  ok('it cannot go live past its open ticket', direct?.code === 'HAS_TICKET');

  console.log('\nC. Closing the ticket makes it live');
  const closed = await MO.closeOrder(conn, c, life.setupTicket.id, { workDone: 'Installed, earthed, test cut OK.' });
  life = await L.getMachineLife(conn, COMPANY, mid);
  const [[m2]] = await conn.query('SELECT stage, status, live_on FROM cf_machines WHERE id = ?', [mid]);
  ok('the ticket closed → Live, planned again, live date today', closed.live === true && m2.stage === 'live' && m2.status === 'active' && String(m2.live_on) === life.today, JSON.stringify(m2));
  ok('the capitalised setup is in its depreciation base', near(life.cost.depreciation.base, 365000 + life.cost.setupCapital) && life.cost.setupCapital > 0);
  life = await L.setCost(conn, c, mid, { liveOn: dayOff(-10), salvageValue: 0 });
  ok('cost and life: about 1000 a day, 10 days down', life.cost.depreciation.perDay > 1000 && life.cost.depreciation.accumulated > 10000);

  console.log('\nD. Check out and in');
  const noPerson = await refusal(() => L.checkOut(conn, c, mid, { toKind: 'area', toId: bay.id }));
  ok('to an area: who takes it is required', noPerson?.problems?.some((p) => /who takes it/.test(p)) ?? false, noPerson?.message);
  life = await L.checkOut(conn, c, mid, { toKind: 'user', toId: c.userId, dueOn: dayOff(-1), note: 'Site work' });
  ok('checked out to a person (overdue: due yesterday)', life.checkout?.to.kind === 'user' && life.checkout.overdue === true);
  const twice = await refusal(() => L.checkOut(conn, c, mid, { toKind: 'user', toId: c.userId }));
  const moveOut = await refusal(() => L.moveMachine(conn, c, mid, { areaId: bay.id }));
  ok('not twice; not moved while out', twice?.code === 'ALREADY_OUT' && moveOut?.code === 'CHECKED_OUT');
  const list = await L.listCheckouts(conn, COMPANY, { open: '1' });
  ok('Stores\' list shows it out', list.rows.some((r) => r.machine.id === mid));
  life = await L.checkIn(conn, c, mid, { areaId: bay.id, note: 'Back, cleaned' });
  ok('checked in, to the bay', !life.checkout && life.area?.id === bay.id);
  const custodians = await L.listCustodians(conn, COMPANY, { kind: 'area', search: RUN });
  ok('whom it can go to: areas found by search', custodians.some((x) => x.id === bay.id));

  console.log('\nE. Order use by days');
  const [orders] = await conn.query("SELECT id FROM cf_sales_orders WHERE company_id = ? AND deleted_at IS NULL AND status NOT IN ('closed','cancelled','lost','revised') ORDER BY id DESC LIMIT 1", [COMPANY]);
  if (orders.length) {
    const oid = orders[0].id;
    await conn.query("INSERT INTO cf_machine_checkouts (company_id, machine_id, to_kind, order_id, taken_by, out_at, in_at, created_by) VALUES (?, ?, 'order', ?, 'Test', ?, ?, ?)",
      [COMPANY, mid, oid, `${dayOff(-5)} 09:00:00`, `${dayOff(-4)} 17:00:00`, c.userId]);
    const use = (await L.machineUseOf(conn, COMPANY, [oid])).get(Number(oid));
    const rate = life.cost.depreciation.perDay;
    const mine = use?.machines.find((x) => x.id === mid);
    ok('two booked days on the order: 2 × the rate a day', !!mine && near(mine.days, 2) && Math.abs(mine.amount - 2 * rate) < 1, JSON.stringify(use));
    const { costSheet } = await imp('apps/cf_erp/services/costingService.js');
    const sheet = await costSheet(conn, COMPANY, oid);
    ok('the cost sheet carries Machine use, in the margin', Math.abs(sheet.machineUse - use.total) < 0.01 && sheet.machineUseDetail.some((x) => x.id === mid));
    life = await L.getMachineLife(conn, COMPANY, mid);
    ok('the machine shows its use: the order, its days, and idle days', life.cost.use.orders.some((o) => o.id === Number(oid) && near(o.days, 2)) && life.cost.use.idleDays >= 8, JSON.stringify(life.cost.use));
  } else ok('(no open order in this company — order use skipped)', true);

  console.log('\nF. Condemn: Maintenance asks, the MD decides');
  const noReason = await refusal(() => L.askCondemn(conn, c, mid, {}));
  ok('a reason is required', noReason?.code === 'INVALID');
  life = await L.askCondemn(conn, c, mid, { reason: 'Spindle cracked, repair costs more than a new one.' });
  const [[ap1]] = await conn.query("SELECT id, amount, context_json FROM cf_approvals WHERE company_id = ? AND approval_type = 'machine_condemn' AND subject_id = ? AND status = 'pending'", [COMPANY, mid]);
  ok('Condemn asked; the MD\'s card has the book value', life.stage === 'condemn_requested' && !!ap1 && Number(ap1.amount) > 0);
  await AP.decide(conn, c, ap1.id, { decision: 'reject', note: 'Get a repair quote first.' }, md);
  life = await L.getMachineLife(conn, COMPANY, mid);
  ok('sent back: Live again', life.stage === 'live');
  await L.askCondemn(conn, c, mid, { reason: 'Repair quote is 3 lakh.' });
  const [[ap2]] = await conn.query("SELECT id FROM cf_approvals WHERE company_id = ? AND approval_type = 'machine_condemn' AND subject_id = ? AND status = 'pending'", [COMPANY, mid]);
  await AP.decide(conn, c, ap2.id, { decision: 'approve' }, md);
  const [[m3]] = await conn.query('SELECT stage, status, condemned_on FROM cf_machines WHERE id = ?', [mid]);
  ok('approved: Condemned, out of planning', m3.stage === 'condemned' && m3.status === 'inactive' && !!m3.condemned_on);
  const noOut = await refusal(() => L.checkOut(conn, c, mid, { toKind: 'user', toId: c.userId }));
  ok('a condemned machine is not checked out', noOut?.code === 'NOT_LIVE');
  const soldFree = await refusal(() => L.recordDisposal(conn, c, mid, { disposal: 'sold', on: life.today }));
  ok('sold needs an amount', !!soldFree);
  life = await L.recordDisposal(conn, c, mid, { disposal: 'sold', on: life.today, amount: 50000, note: 'To a scrap dealer' });
  ok('disposal: sold for 50,000, the rest written off', life.disposal?.kind === 'sold' && life.disposal.amount === 50000 && life.disposal.writtenOff > 0);
  const again = await refusal(() => L.recordDisposal(conn, c, mid, { disposal: 'scrapped', on: life.today }));
  ok('only once', again?.code === 'DONE');

  console.log('\nG. The log, and the register');
  const log = await L.machineLog(conn, COMPANY, mid, {});
  const evs = new Set(log.rows.map((r) => r.event));
  ok('the log has every step', ['received', 'ticket', 'moved', 'live', 'cost', 'checked_out', 'checked_in', 'condemn_asked', 'condemn_refused', 'condemned', 'disposed', 'setup'].every((e) => evs.has(e)), [...evs].join(','));
  const reg2 = await MS.listMachines(conn, COMPANY, { stage: 'condemned', search: RUN });
  ok('the register filters by stage and carries stage and place', reg2.length === 1 && reg2[0].stage === 'condemned' && reg2[0].area?.id === bay.id);

  console.log('\nH. A durable tool');
  const toolFamily = await conn.query("SELECT id FROM cf_classification_nodes WHERE company_id = ? AND depth = 0 AND resource_kind = 'tool' AND deleted_at IS NULL LIMIT 1", [COMPANY]).then(([r]) => r[0]);
  if (toolFamily) {
    const [[leaf]] = await conn.query('SELECT v.id FROM cf_classification_nodes v JOIN cf_classification_nodes s ON s.id = v.parent_id WHERE s.parent_id = ? AND v.deleted_at IS NULL LIMIT 1', [toolFamily.id]);
    const grinder = await createItem(conn, c, { itemType: 'catalog', classificationId: leaf.id, name: `${RUN} Angle grinder`, trackedBy: 'quantity', sourcing: 'stock', uom: 'nos' }, { fallbackName: `${RUN} Angle grinder` });
    await conn.query("UPDATE cf_master_records SET status = 'active' WHERE id = ?", [grinder.id]);
    const r2 = await ST.postMovement(conn, c, { movementType: 'receipt', lines: [{ itemId: grinder.id, quantity: 1, toAreaId: store.id, unitCost: 6000 }] });
    const [bl2] = await conn.query('INSERT INTO cf_grn_bill_lines (company_id, bill_id, line_no, movement_id, item_id, quantity, landed_unit_cost) VALUES (?, ?, 2, ?, ?, 1, 6000)', [COMPANY, bill.insertId, r2.id, grinder.id]);
    todo = await L.toRegister(conn, COMPANY, { billId: bill.insertId });
    ok('a tool with no tool life is a durable tool to register', todo.some((t) => t.billLineId === bl2.insertId && t.kind === 'tool'));
    const t = await L.registerReceived(conn, c, { billLineId: bl2.insertId, units: [{ serialNumber: `${RUN}-G1` }] });
    const [[tm]] = await conn.query('SELECT kind, stage, status FROM cf_machines WHERE id = ?', [t.machines[0].id]);
    ok('…registered straight to Live (no setup), on the default tool type', tm.kind === 'tool' && tm.stage === 'live' && tm.status === 'active');
  } else ok('(no tool family in this company — durable tool skipped)', true);
} catch (e) {
  exitCode = 1;
  console.error(e);
} finally {
  try { detachNodeCache(conn); } catch { /* none */ }
  await conn.rollback();
  const after = await census(conn);
  const moved = Object.keys(after).filter((t) => after[t] !== before?.[t]);
  ok('rolled back: every cf_ table has the count it had', moved.length === 0, moved.join(', '));
  conn.release();
  await pool.end();
}
console.log(`\n${passed} passed, ${failed} failed`);
if (fails.length) console.log(`Failed:\n  ${fails.join('\n  ')}`);
process.exit(failed || exitCode ? 1 : 0);
