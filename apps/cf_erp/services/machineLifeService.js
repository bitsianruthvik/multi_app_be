/**
 * machineLifeService.js — THE MACHINE LIFECYCLE (init.sql §104, user 2026-11-12):
 *
 *   "Machine once procured should go to the set up stage. There should be an automatic ticket raised with the
 *    maintenance team for setting it up. When they close the ticket, it should go to live status. When in setup, they can
 *    raise MR for that machine … move locations from store to maintenance to store back. Store should be able to check in
 *    and check out the machines and tools to various people and projects. There is a final phase for a machine which is
 *    condemned. To condemn the maintenance team should raise, MD approval should be given. … a log of everyone or every
 *    area or every order it was used for. Tools should also be used as machines. Machines should have a depreciation
 *    period. And usage per order should take in the portion of time it is on that order as one of the overhead costs."
 *
 * Decided with the user the same day:
 *   REGISTER   a GRN line of a machine model (catalog under CAPEX) or a DURABLE TOOL (an item of a tool family with no tool
 *              life — wear parts keep toolLifeService) waits for Stores to register each unit (name, type, serial, code).
 *              Registering takes the units out of stock (an issue used for 'asset' — not a consumable of anything) and
 *              makes register entries at the area they arrived in. A machine goes to SETUP with a setup ticket (a
 *              maintenance order, source 'setup'); a tool goes LIVE at once unless Stores asks for a setup.
 *   STAGES     setup → live → condemn_requested → condemned. status (the planner's switch) follows: only live is active.
 *              Closing the setup ticket makes it live (the live date starts its depreciation).
 *   PLACE      cf_machines.area_id — a stocking area (purpose 'maintenance' for a maintenance bay). Moved by Stores or
 *              Maintenance; not while checked out.
 *   CUSTODY    cf_machine_checkouts — out to a login user, an HRMS employee, a contractor, an order or an area, with the
 *              person who took it; back in (to an area). Live only.
 *   CONDEMN    Maintenance asks (a reason) → the MD (approval 'machine_condemn') → condemned; then the disposal is recorded
 *              (scrapped / sold, date, amount realised; the book value left is written off).
 *   COST       straight line: (cost + capitalised setup − salvage) ÷ (life in years × 365) a day, from the live date.
 *              Setup-ticket issues are Installation (capitalised) by default, Consumable (expense) for consumable families;
 *              Maintenance can flip each item (cf_machine_setup_items).
 *   ORDER USE  by DAYS: a day's rate is shared by the orders whose work ran on the machine that day, by run hours
 *              (cf_work_sessions); a day with no run hours goes to the order it was checked out to; else it is idle.
 *   LOG        cf_machine_events (stages, tickets, moves, check-outs, cost) + its maintenance orders + its run sessions.
 */
import { invalid, notFound, conflict, assertNoProblems } from '../lib/errors.js';
import { requestApproval } from './approvalService.js';

export const STAGES = ['setup', 'live', 'condemn_requested', 'condemned'];
export const STAGE_LABEL = { setup: 'Setup', live: 'Live', condemn_requested: 'Condemn asked', condemned: 'Condemned' };
export const KINDS = ['machine', 'tool'];
export const CHECKOUT_KINDS = ['user', 'employee', 'contractor', 'order', 'area'];
export const CHECKOUT_KIND_LABEL = { user: 'Person', employee: 'Employee', contractor: 'Contractor', order: 'Order', area: 'Area' };
export const DISPOSALS = ['scrapped', 'sold'];
export const TREATMENTS = ['capital', 'expense'];
export const EVENT_LABEL = {
  received: 'Received', registered: 'Registered', ticket: 'Setup ticket raised', moved: 'Moved', checked_out: 'Checked out', checked_in: 'Checked in',
  live: 'Went live', condemn_asked: 'Condemn asked', condemn_refused: 'Condemn sent back', condemned: 'Condemned', disposed: 'Disposed', cost: 'Cost and life set',
};

const blank = (v) => v == null || String(v).trim() === '';
const round2 = (n) => Math.round(Number(n) * 100) / 100;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const dayMs = (s) => Date.parse(`${s}T00:00:00Z`);
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const addDays = (s, n) => dayOf(dayMs(s) + n * 86400000);
const daysBetween = (a, b) => Math.round((dayMs(b) - dayMs(a)) / 86400000);
const wallText = (d) => (d == null ? null : d instanceof Date ? d.toISOString().slice(0, 19).replace('T', ' ') : String(d).replace('T', ' ').slice(0, 19));
const wallMs = (w) => Date.parse(`${String(w).replace(' ', 'T')}Z`);
const missing = (e) => !!e && (e.errno === 1146 || e.errno === 1054);

async function today(db, companyId) {
  const { plantZone, wallOf } = await import('./floorService.js');
  const wall = wallOf(Date.now(), await plantZone(db, companyId));
  return { wall, today: wall.slice(0, 10) };
}

export async function logEvent(db, c, machineId, event, { areaId = null, fromAreaId = null, checkoutId = null, refCode = null, note = null } = {}) {
  const { wall } = await today(db, c.companyId);
  await db.query(
    'INSERT INTO cf_machine_events (company_id, machine_id, at, event, area_id, from_area_id, checkout_id, ref_code, note, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [c.companyId, machineId, wall, event, areaId, fromAreaId, checkoutId, refCode ? String(refCode).slice(0, 60) : null, note ? String(note).slice(0, 1000) : null, c.userId ?? null],
  );
}

async function requireMachineRow(db, companyId, id, { lock = false } = {}) {
  const [[m]] = await db.query(`SELECT * FROM cf_machines WHERE company_id = ? AND id = ? AND deleted_at IS NULL${lock ? ' FOR UPDATE' : ''}`, [companyId, Number(id)]);
  if (!m) throw notFound('Machine');
  return m;
}

async function requireArea(db, companyId, raw, label = 'Area') {
  if (blank(raw)) throw invalid('INVALID', `Choose the ${label.toLowerCase()}.`);
  const [[a]] = await db.query("SELECT id, code, name, purpose, status FROM cf_stocking_areas WHERE company_id = ? AND id = ? AND deleted_at IS NULL", [companyId, Number(raw)]);
  if (!a) throw notFound(label);
  if (a.status !== 'active') throw invalid('INACTIVE', `${a.code} is inactive.`);
  return a;
}

/* ── What a GRN brings that goes on the register ───────────────────────────────────────────────────────── */

/** The family (depth-0 node) of an item's classification, with its code and resource kind — as SQL joins. */
const FAMILY_JOINS = `JOIN cf_classification_nodes v ON v.company_id = mr.company_id AND v.id = mr.classification_id
       LEFT JOIN cf_classification_nodes s ON s.company_id = v.company_id AND s.id = v.parent_id
       LEFT JOIN cf_classification_nodes f ON f.company_id = s.company_id AND f.id = s.parent_id`;
const FAMILY_CODE = 'COALESCE(f.code, s.code, v.code)';
const KIND_SQL = 'COALESCE(v.resource_kind, s.resource_kind, f.resource_kind)';
/** 'machine' for a machine model (Capital equipment), 'tool' for a durable tool (a tool family, no tool life), else NULL. */
const ASSET_KIND_SQL = `CASE WHEN ${FAMILY_CODE} = 'CAPEX' THEN 'machine' WHEN ${KIND_SQL} = 'tool' AND d.life_unit IS NULL THEN 'tool' ELSE NULL END`;

/**
 * GET /machines/to-register?billId= — GRN lines whose units are still to be registered (all of them when no bill is
 * named — Stores' "To register" list). 2 reads.
 */
export async function toRegister(db, companyId, q = {}) {
  const where = ['bl.company_id = ?', 'b.deleted_at IS NULL'];
  const args = [companyId];
  if (!blank(q.billId)) { where.push('bl.bill_id = ?'); args.push(Number(q.billId)); }
  let rows;
  try {
    [rows] = await db.query(
      `SELECT bl.id, bl.bill_id, bl.item_id, bl.quantity, bl.landed_unit_cost, bl.movement_id, b.grn_date, po.code AS po_code, sup.name AS supplier_name,
              mr.code AS item_code, mr.name AS item_name, ${ASSET_KIND_SQL} AS asset_kind,
              (SELECT COUNT(*) FROM cf_machines x WHERE x.company_id = bl.company_id AND x.grn_bill_line_id = bl.id AND x.deleted_at IS NULL) AS registered,
              (SELECT l.stocking_area_id FROM cf_stock_ledger l WHERE l.company_id = bl.company_id AND l.movement_id = bl.movement_id AND l.quantity > 0 ORDER BY l.id LIMIT 1) AS area_id
         FROM cf_grn_bill_lines bl
         JOIN cf_grn_bills b ON b.id = bl.bill_id
         LEFT JOIN cf_purchase_orders po ON po.id = b.purchase_order_id
         LEFT JOIN cf_parties sup ON sup.id = b.supplier_id
         JOIN cf_master_records mr ON mr.company_id = bl.company_id AND mr.id = bl.item_id
         JOIN cf_item_details d ON d.company_id = bl.company_id AND d.master_id = bl.item_id
         ${FAMILY_JOINS}
        WHERE ${where.join(' AND ')} AND bl.movement_id IS NOT NULL
        HAVING asset_kind IS NOT NULL AND registered < FLOOR(quantity)
        ORDER BY bl.id DESC LIMIT 200`,
      args,
    );
  } catch (e) { if (missing(e)) return []; throw e; }
  const areaIds = [...new Set(rows.map((r) => r.area_id).filter(Boolean))];
  const [areas] = areaIds.length ? await db.query('SELECT id, code, name FROM cf_stocking_areas WHERE company_id = ? AND id IN (?)', [companyId, areaIds]) : [[]];
  const areaById = new Map(areas.map((a) => [Number(a.id), a]));
  return rows.map((r) => {
    const a = r.area_id ? areaById.get(Number(r.area_id)) : null;
    return {
      billLineId: r.id, billId: r.bill_id, grnDate: r.grn_date, purchaseOrder: r.po_code ?? null, supplier: r.supplier_name ?? null,
      item: { id: r.item_id, code: r.item_code, name: r.item_name }, kind: r.asset_kind,
      quantity: Number(r.quantity), registered: Number(r.registered), left: Math.floor(Number(r.quantity)) - Number(r.registered),
      unitCost: r.landed_unit_cost == null ? null : Number(r.landed_unit_cost),
      area: a ? { id: a.id, code: a.code, name: a.name } : null,
    };
  });
}

/** A machine-scope type for tools (Durable tools › General › Hand and power tools), made once per company. */
async function defaultToolType(db, c) {
  const PLACE = [{ code: 'DTOOLS', name: 'Durable tools' }, { code: 'DTOOLS-GEN', name: 'General' }, { code: 'DTOOLS-GEN-HT', name: 'Hand and power tools' }];
  let parent = null;
  for (let depth = 0; depth < PLACE.length; depth += 1) {
    const p = PLACE[depth];
    const [[have]] = await db.query("SELECT id FROM cf_classification_nodes WHERE company_id = ? AND code = ? AND deleted_at IS NULL LIMIT 1", [c.companyId, p.code]);
    if (have) { parent = Number(have.id); continue; }
    const [ins] = await db.query(
      `INSERT INTO cf_classification_nodes (company_id, parent_id, depth, scope, code, name, description, sort_order, status, created_by)
       VALUES (?, ?, ?, 'machine', ?, ?, 'Durable tools on the register.', 0, 'active', ?)`,
      [c.companyId, parent, depth, p.code, p.name, c.userId ?? null],
    );
    parent = Number(ins.insertId);
  }
  return parent;
}

/** The cost and life another machine of the same model was given — a new one starts from it. */
async function modelDefaults(db, companyId, itemId) {
  const [[m]] = await db.query(
    'SELECT salvage_value, life_years, cost FROM cf_machines WHERE company_id = ? AND catalog_item_id = ? AND life_years IS NOT NULL AND deleted_at IS NULL ORDER BY id DESC LIMIT 1',
    [companyId, itemId],
  );
  if (!m) return { salvagePct: null, lifeYears: null };
  return { salvagePct: m.cost && m.salvage_value != null ? Number(m.salvage_value) / Number(m.cost) : null, lifeYears: Number(m.life_years) };
}

/**
 * POST /machines/register-received { billLineId, needsSetup?, lifeYears?, salvageValue?, units: [{ name, code?,
 * classificationId?, serialNumber?, notes? }] } — Stores registers units of a received machine / durable tool.
 * Each unit: a register entry at the area it arrived in, at the GRN's landed unit cost, out of stock (an 'asset' issue),
 * then SETUP with a setup ticket (machines; tools only when needsSetup) or LIVE.
 */
export async function registerReceived(db, c, input = {}) {
  const lines = await toRegister(db, c.companyId, {});
  const L = lines.find((l) => l.billLineId === Number(input.billLineId));
  if (!L) throw invalid('NOTHING_TO_REGISTER', 'That GRN line has nothing left to register.');
  const units = Array.isArray(input.units) ? input.units : [];
  const problems = [];
  if (!units.length) problems.push('Register at least one unit.');
  if (units.length > L.left) problems.push(`Only ${L.left} of ${L.item.code} ${L.left === 1 ? 'is' : 'are'} left to register.`);
  if (!L.area) problems.push(`The GRN of ${L.item.code} has no area — it cannot be taken out of stock.`);
  const lifeYears = blank(input.lifeYears) ? null : Number(input.lifeYears);
  if (lifeYears != null && !(lifeYears > 0 && lifeYears <= 100)) problems.push('Life: years, above zero.');
  const serials = units.map((u) => (blank(u.serialNumber) ? null : String(u.serialNumber).trim().toLowerCase())).filter(Boolean);
  if (new Set(serials).size !== serials.length) problems.push('Two units have the same serial number.');
  assertNoProblems(problems, 'The units cannot be registered.');
  const needsSetup = input.needsSetup == null ? L.kind === 'machine' : !!input.needsSetup;
  const toolType = L.kind === 'tool' && units.some((u) => blank(u.classificationId)) ? await defaultToolType(db, c) : null;
  const defaults = await modelDefaults(db, c.companyId, L.item.id);
  const life = lifeYears ?? defaults.lifeYears;
  const salvage = !blank(input.salvageValue) ? round2(Number(input.salvageValue)) : defaults.salvagePct != null && L.unitCost != null ? round2(L.unitCost * defaults.salvagePct) : null;
  const { createMachine } = await import('./machineService.js');
  const { today: on } = await today(db, c.companyId);
  const made = [];
  for (const [i, u] of units.entries()) {
    const m = await createMachine(db, c, {
      name: blank(u.name) ? `${L.item.name}${units.length > 1 ? ` #${i + 1}` : ''}` : u.name,
      code: u.code, classificationId: blank(u.classificationId) ? toolType : u.classificationId,
      catalogItemId: L.item.id, serialNumber: u.serialNumber, notes: u.notes, status: needsSetup ? 'inactive' : 'active',
    });
    await db.query(
      `UPDATE cf_machines SET kind = ?, stage = ?, area_id = ?, received_on = ?, live_on = ?, cost = ?, salvage_value = ?, life_years = ?, grn_bill_line_id = ?
        WHERE company_id = ? AND id = ?`,
      [L.kind, needsSetup ? 'setup' : 'live', L.area.id, String(L.grnDate ?? on).slice(0, 10), needsSetup ? null : on, L.unitCost, salvage, life, L.billLineId, c.companyId, m.id],
    );
    await logEvent(db, c, m.id, 'received', { areaId: L.area.id, refCode: L.purchaseOrder, note: `${L.item.code} from ${L.supplier ?? 'the supplier'}${L.unitCost != null ? ` at ₹${Number(L.unitCost).toLocaleString('en-IN')}` : ''}` });
    made.push(m);
  }
  // Out of stock: the units are on the register now (an issue used for 'asset' — not a consumable of any order).
  const { postMovement } = await import('./stockService.js');
  await postMovement(db, c, {
    movementType: 'issue', reference: L.purchaseOrder, notes: `Registered: ${made.map((m) => m.code).join(', ')}`.slice(0, 500),
    lines: [{ itemId: L.item.id, quantity: made.length, fromAreaId: L.area.id }],
  }, { asset: true });
  if (needsSetup) {
    const { openSetupTicket } = await import('./maintenanceService.js');
    for (const m of made) {
      const mo = await openSetupTicket(db, c, m);
      await logEvent(db, c, m.id, 'ticket', { refCode: mo.code, note: 'Set it up, then close the ticket — it goes live.' });
    }
  } else {
    for (const m of made) await logEvent(db, c, m.id, 'live', { note: 'Registered straight to live (no setup).' });
  }
  return { machines: made.map((m) => ({ id: m.id, code: m.code, name: m.name })), stage: needsSetup ? 'setup' : 'live', left: L.left - made.length };
}

/* ── Stages ────────────────────────────────────────────────────────────────────────────────────────────── */

/** Setup → live. Called when the setup ticket is closed (maintenanceService.closeOrder), or by Maintenance directly. */
export async function goLive(db, c, id, { refCode = null, note = null, direct = false } = {}) {
  const m = await requireMachineRow(db, c.companyId, id, { lock: true });
  if (m.stage !== 'setup') {
    if (direct) throw invalid('NOT_IN_SETUP', `${m.code} is ${STAGE_LABEL[m.stage].toLowerCase()}.`);
    return { already: true };
  }
  if (direct) {
    const [[open]] = await db.query("SELECT code FROM cf_maintenance_orders WHERE company_id = ? AND machine_id = ? AND source = 'setup' AND status IN ('open','in_progress','waiting_parts') AND deleted_at IS NULL", [c.companyId, m.id]);
    if (open) throw invalid('HAS_TICKET', `${m.code} has a setup ticket — close ${open.code} and it goes live.`);
  }
  const { today: on } = await today(db, c.companyId);
  await db.query("UPDATE cf_machines SET stage = 'live', status = 'active', live_on = COALESCE(live_on, ?) WHERE company_id = ? AND id = ?", [on, c.companyId, m.id]);
  await logEvent(db, c, m.id, 'live', { refCode, note: note ?? 'Setup done.' });
  const { clearProductionMachines } = await import('./operationService.js');
  clearProductionMachines(c.companyId);
  return { live: true };
}

/** POST /machines/:id/setup-ticket — a setup machine with no open ticket gets one again (the last was cancelled). */
export async function raiseSetupTicketAgain(db, c, id) {
  const m = await requireMachineRow(db, c.companyId, id, { lock: true });
  if (m.stage !== 'setup') throw invalid('NOT_IN_SETUP', `${m.code} is ${STAGE_LABEL[m.stage].toLowerCase()} — it needs no setup ticket.`);
  const [[open]] = await db.query("SELECT code FROM cf_maintenance_orders WHERE company_id = ? AND machine_id = ? AND source = 'setup' AND status IN ('open','in_progress','waiting_parts') AND deleted_at IS NULL", [c.companyId, m.id]);
  if (open) throw conflict('HAS_TICKET', `${m.code} already has a setup ticket — ${open.code}.`);
  const { openSetupTicket } = await import('./maintenanceService.js');
  const mo = await openSetupTicket(db, c, m);
  await logEvent(db, c, m.id, 'ticket', { refCode: mo.code });
  return getMachineLife(db, c.companyId, m.id);
}

/* ── Place ─────────────────────────────────────────────────────────────────────────────────────────────── */

/** POST /machines/:id/move { areaId, note? } — Stores or Maintenance; not while it is checked out, not once condemned. */
export async function moveMachine(db, c, id, input = {}) {
  const m = await requireMachineRow(db, c.companyId, id, { lock: true });
  if (m.stage === 'condemned') throw invalid('CONDEMNED', `${m.code} is condemned — it does not move any more.`);
  const area = await requireArea(db, c.companyId, input.areaId, 'Place');
  if (Number(m.area_id) === Number(area.id)) throw invalid('SAME_PLACE', `${m.code} is already at ${area.code}.`);
  const out = await openCheckout(db, c.companyId, m.id);
  if (out) throw invalid('CHECKED_OUT', `${m.code} is checked out — check it in first.`);
  await db.query('UPDATE cf_machines SET area_id = ? WHERE company_id = ? AND id = ?', [area.id, c.companyId, m.id]);
  await logEvent(db, c, m.id, 'moved', { areaId: area.id, fromAreaId: m.area_id, note: input.note });
  return getMachineLife(db, c.companyId, m.id);
}

/* ── Custody ───────────────────────────────────────────────────────────────────────────────────────────── */

async function openCheckout(db, companyId, machineId) {
  const [[o]] = await db.query('SELECT * FROM cf_machine_checkouts WHERE company_id = ? AND machine_id = ? AND in_at IS NULL', [companyId, machineId]);
  return o ?? null;
}

/** The name of whom / what it is out to: one read per kind present. */
async function nameCheckouts(db, companyId, rows) {
  const ids = (k, col) => [...new Set(rows.filter((r) => r.to_kind === k).map((r) => r[col]).filter(Boolean))];
  const pick = async (list, sql) => (list.length ? (await db.query(sql, [companyId, list]))[0] : []);
  const [users, emps, parties, orders, areas] = await Promise.all([
    ids('user', 'user_id').length ? db.query('SELECT id, name, email FROM users WHERE company_id = ? AND id IN (?)', [companyId, ids('user', 'user_id')]).then(([r]) => r) : [],
    pick(ids('employee', 'employee_id'), 'SELECT id, employee_code AS code, full_name AS name FROM hrms_employees WHERE company_id = ? AND id IN (?)').catch((e) => { if (missing(e)) return []; throw e; }),
    pick(ids('contractor', 'party_id'), 'SELECT id, code, name FROM cf_parties WHERE company_id = ? AND id IN (?)'),
    pick(ids('order', 'order_id'), 'SELECT id, code, title AS name FROM cf_sales_orders WHERE company_id = ? AND id IN (?)'),
    pick([...new Set(rows.filter((r) => r.to_kind === 'area').map((r) => r.area_id).filter(Boolean))], 'SELECT id, code, name FROM cf_stocking_areas WHERE company_id = ? AND id IN (?)'),
  ]);
  const map = { user: new Map(users.map((x) => [Number(x.id), x])), employee: new Map(emps.map((x) => [Number(x.id), x])), contractor: new Map(parties.map((x) => [Number(x.id), x])), order: new Map(orders.map((x) => [Number(x.id), x])), area: new Map(areas.map((x) => [Number(x.id), x])) };
  const COL = { user: 'user_id', employee: 'employee_id', contractor: 'party_id', order: 'order_id', area: 'area_id' };
  return (r) => {
    const x = map[r.to_kind]?.get(Number(r[COL[r.to_kind]]));
    return { kind: r.to_kind, kindLabel: CHECKOUT_KIND_LABEL[r.to_kind], id: Number(r[COL[r.to_kind]]), code: x?.code ?? null, name: x?.name ?? x?.email ?? null };
  };
}

function shapeCheckout(r, namer, today0) {
  return {
    id: r.id, machineId: r.machine_id, to: namer(r), takenBy: r.taken_by ?? null, outAt: wallText(r.out_at), dueOn: r.due_on ?? null,
    overdue: !r.in_at && !!r.due_on && today0 && r.due_on < today0, note: r.note ?? null,
    inAt: wallText(r.in_at), inNote: r.in_note ?? null,
  };
}

const PERSON_KINDS = ['order', 'area'];

/**
 * POST /machines/:id/check-out { toKind, toId, takenBy?, dueOn?, note? } — Stores; live machines and tools only.
 * An order or an area needs the person who takes it.
 */
export async function checkOut(db, c, id, input = {}) {
  const m = await requireMachineRow(db, c.companyId, id, { lock: true });
  if (m.stage !== 'live') throw invalid('NOT_LIVE', `${m.code} is ${STAGE_LABEL[m.stage].toLowerCase()} — only a live machine or tool is checked out.`);
  const have = await openCheckout(db, c.companyId, m.id);
  if (have) throw conflict('ALREADY_OUT', `${m.code} is already checked out — check it in first.`);
  const kind = String(input.toKind ?? '');
  const problems = [];
  if (!CHECKOUT_KINDS.includes(kind)) problems.push('Check it out to a person, an employee, a contractor, an order or an area.');
  const toId = blank(input.toId) ? null : Number(input.toId);
  if (!toId) problems.push('Choose whom or what it goes to.');
  const takenBy = blank(input.takenBy) ? null : String(input.takenBy).trim().slice(0, 120);
  if (PERSON_KINDS.includes(kind) && !takenBy) problems.push('Say who takes it.');
  const dueOn = blank(input.dueOn) ? null : String(input.dueOn).slice(0, 10);
  if (dueOn && !DATE_RE.test(dueOn)) problems.push('Due back: a date.');
  assertNoProblems(problems, 'It cannot be checked out.');
  const exists = {
    user: ['SELECT id FROM users WHERE company_id = ? AND id = ? AND deleted_at IS NULL', 'That person'],
    employee: ["SELECT id FROM hrms_employees WHERE company_id = ? AND id = ? AND deleted_at IS NULL AND employment_status <> 'EXITED'", 'That employee'],
    contractor: ['SELECT id FROM cf_parties WHERE company_id = ? AND id = ? AND deleted_at IS NULL', 'That contractor'],
    order: ["SELECT id FROM cf_sales_orders WHERE company_id = ? AND id = ? AND deleted_at IS NULL AND status NOT IN ('closed','cancelled','lost')", 'That open order'],
    area: ["SELECT id FROM cf_stocking_areas WHERE company_id = ? AND id = ? AND deleted_at IS NULL AND status = 'active'", 'That area'],
  }[kind];
  let found = null;
  try { [[found]] = await db.query(exists[0], [c.companyId, toId]); } catch (e) { if (!missing(e)) throw e; }
  if (!found) throw notFound(exists[1]);
  const { wall } = await today(db, c.companyId);
  const col = { user: 'user_id', employee: 'employee_id', contractor: 'party_id', order: 'order_id', area: 'area_id' }[kind];
  const [ins] = await db.query(
    `INSERT INTO cf_machine_checkouts (company_id, machine_id, to_kind, ${col}, taken_by, out_at, due_on, note, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [c.companyId, m.id, kind, toId, takenBy, wall, dueOn, blank(input.note) ? null : String(input.note).slice(0, 500), c.userId ?? null],
  );
  const [[row]] = await db.query('SELECT * FROM cf_machine_checkouts WHERE id = ?', [ins.insertId]);
  const namer = await nameCheckouts(db, c.companyId, [row]);
  const to = namer(row);
  await logEvent(db, c, m.id, 'checked_out', { checkoutId: ins.insertId, refCode: to.code, note: `To ${to.kindLabel.toLowerCase()} ${to.name ?? to.code ?? ''}${takenBy ? ` — taken by ${takenBy}` : ''}${dueOn ? `, due back ${dueOn}` : ''}` });
  return getMachineLife(db, c.companyId, m.id);
}

/** POST /machines/:id/check-in { areaId?, note? } — back to Stores (to the area named, else where it was). */
export async function checkIn(db, c, id, input = {}) {
  const m = await requireMachineRow(db, c.companyId, id, { lock: true });
  const o = await openCheckout(db, c.companyId, m.id);
  if (!o) throw invalid('NOT_OUT', `${m.code} is not checked out.`);
  const area = blank(input.areaId) ? null : await requireArea(db, c.companyId, input.areaId, 'Place');
  const { wall } = await today(db, c.companyId);
  await db.query('UPDATE cf_machine_checkouts SET in_at = ?, in_note = ?, in_by = ? WHERE company_id = ? AND id = ?',
    [wall, blank(input.note) ? null : String(input.note).slice(0, 500), c.userId ?? null, c.companyId, o.id]);
  if (area && Number(area.id) !== Number(m.area_id)) await db.query('UPDATE cf_machines SET area_id = ? WHERE company_id = ? AND id = ?', [area.id, c.companyId, m.id]);
  await logEvent(db, c, m.id, 'checked_in', { checkoutId: o.id, areaId: area?.id ?? m.area_id, fromAreaId: area && Number(area.id) !== Number(m.area_id) ? m.area_id : null, note: input.note });
  return getMachineLife(db, c.companyId, m.id);
}

/** GET /machine-checkouts?open=1&search= — Stores' check-in / out screen: what is out (or the last 300 movements). */
export async function listCheckouts(db, companyId, q = {}) {
  const open = q.open !== '0' && q.open !== false && q.open !== 'false';
  const where = ['k.company_id = ?'];
  const args = [companyId];
  if (open) where.push('k.in_at IS NULL');
  if (!blank(q.machineId)) { where.push('k.machine_id = ?'); args.push(Number(q.machineId)); }
  const [rows] = await db.query(
    `SELECT k.*, m.code AS machine_code, m.name AS machine_name, m.kind AS machine_kind FROM cf_machine_checkouts k JOIN cf_machines m ON m.id = k.machine_id
      WHERE ${where.join(' AND ')} ORDER BY k.in_at IS NULL DESC, k.out_at DESC LIMIT 300`, args);
  const namer = await nameCheckouts(db, companyId, rows);
  const { today: t } = await today(db, companyId);
  let out = rows.map((r) => ({ ...shapeCheckout(r, namer, t), machine: { id: r.machine_id, code: r.machine_code, name: r.machine_name, kind: r.machine_kind } }));
  if (!blank(q.search)) {
    const s = String(q.search).trim().toLowerCase();
    out = out.filter((r) => [r.machine.code, r.machine.name, r.to.name, r.to.code, r.takenBy].some((x) => x && String(x).toLowerCase().includes(s)));
  }
  return { rows: out, today: t };
}

/** GET /machine-custodians?kind=&search= — whom a machine can be checked out to, of one kind (20 at most). */
export async function listCustodians(db, companyId, q = {}) {
  const kind = String(q.kind ?? '');
  if (!CHECKOUT_KINDS.includes(kind)) throw invalid('INVALID', 'kind is user, employee, contractor, order or area.');
  const like = blank(q.search) ? '%' : `%${String(q.search).trim().replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
  const SQL = {
    user: ['SELECT id, NULL AS code, name, email AS sub FROM users WHERE company_id = ? AND deleted_at IS NULL AND (name LIKE ? OR email LIKE ?) ORDER BY name LIMIT 20', 2],
    employee: ["SELECT id, employee_code AS code, full_name AS name, NULL AS sub FROM hrms_employees WHERE company_id = ? AND deleted_at IS NULL AND employment_status <> 'EXITED' AND (full_name LIKE ? OR employee_code LIKE ?) ORDER BY full_name LIMIT 20", 2],
    contractor: ['SELECT id, code, name, NULL AS sub FROM cf_parties WHERE company_id = ? AND deleted_at IS NULL AND is_supplier = 1 AND (name LIKE ? OR code LIKE ?) ORDER BY name LIMIT 20', 2],
    order: ["SELECT o.id, o.code, COALESCE(o.title, p.name) AS name, p.name AS sub FROM cf_sales_orders o LEFT JOIN cf_parties p ON p.id = o.customer_id WHERE o.company_id = ? AND o.deleted_at IS NULL AND o.status NOT IN ('closed','cancelled','lost','revised') AND (o.code LIKE ? OR o.title LIKE ?) ORDER BY o.id DESC LIMIT 20", 2],
    area: ["SELECT id, code, name, purpose AS sub FROM cf_stocking_areas WHERE company_id = ? AND deleted_at IS NULL AND status = 'active' AND (code LIKE ? OR name LIKE ?) ORDER BY code LIMIT 20", 2],
  }[kind];
  try {
    const [rows] = await db.query(SQL[0], [companyId, ...Array(SQL[1]).fill(like)]);
    return rows.map((r) => ({ id: Number(r.id), code: r.code ?? null, name: r.name ?? r.code ?? '', sub: r.sub ?? null }));
  } catch (e) { if (missing(e)) return []; throw e; }
}

/* ── Condemn ───────────────────────────────────────────────────────────────────────────────────────────── */

/** POST /machines/:id/condemn { reason } — Maintenance asks; the MD decides (approval 'machine_condemn'). */
export async function askCondemn(db, c, id, input = {}) {
  const m = await requireMachineRow(db, c.companyId, id, { lock: true });
  if (!['setup', 'live'].includes(m.stage)) throw invalid('NOT_POSSIBLE', `${m.code} is ${STAGE_LABEL[m.stage].toLowerCase()}.`);
  if (blank(input.reason)) throw invalid('INVALID', 'Say why it should be condemned.');
  if (await openCheckout(db, c.companyId, m.id)) throw invalid('CHECKED_OUT', `${m.code} is checked out — check it in first.`);
  const life = await getMachineLife(db, c.companyId, m.id);
  await db.query("UPDATE cf_machines SET stage_before = stage, stage = 'condemn_requested' WHERE company_id = ? AND id = ?", [c.companyId, m.id]);
  const reason = String(input.reason).trim().slice(0, 450);
  const dep = life.cost?.depreciation;
  const approvalId = await requestApproval(db, c, {
    type: 'machine_condemn', subjectId: m.id, subjectCode: m.code, title: `Condemn ${m.code} — ${m.name}`,
    summary: `${reason}${dep ? ` · book value ₹${dep.bookValue}` : ''}`.slice(0, 500), amount: dep?.bookValue ?? null, note: reason,
    context: {
      kind: 'machine_condemn', machine: { id: m.id, code: m.code, name: m.name, kind: m.kind }, reason,
      liveOn: life.liveOn, ageYears: life.liveOn ? round2(daysBetween(life.liveOn, life.today) / 365) : null,
      cost: dep ? { base: dep.base, accumulated: dep.accumulated, bookValue: dep.bookValue, salvage: dep.salvage } : null,
      lastMaintenance: life.lastMaintenance, maintenanceCost: life.maintenanceCost,
    },
  });
  await logEvent(db, c, m.id, 'condemn_asked', { refCode: `AP-${approvalId}`, note: reason });
  return getMachineLife(db, c.companyId, m.id);
}

export const condemnApprovalHandler = {
  async onApprove(db, c, row, note) {
    const m = await requireMachineRow(db, c.companyId, row.subject_id, { lock: true });
    if (m.stage !== 'condemn_requested') throw invalid('NOT_PENDING', `${m.code} is not waiting to be condemned.`);
    const { today: on } = await today(db, c.companyId);
    await db.query("UPDATE cf_machines SET stage = 'condemned', status = 'inactive', condemned_on = ?, stage_before = NULL WHERE company_id = ? AND id = ?", [on, c.companyId, m.id]);
    await logEvent(db, c, m.id, 'condemned', { refCode: `AP-${row.id}`, note: note ?? 'The MD approved.' });
    const { clearProductionMachines } = await import('./operationService.js');
    clearProductionMachines(c.companyId);
    const { reestimateMachine } = await import('./timeEstimateService.js');
    await reestimateMachine(db, c, m.id);
    return { condemned: true };
  },
  async onReject(db, c, row, note) {
    await db.query("UPDATE cf_machines SET stage = COALESCE(stage_before, 'live'), stage_before = NULL WHERE company_id = ? AND id = ? AND stage = 'condemn_requested'", [c.companyId, row.subject_id]);
    await logEvent(db, c, row.subject_id, 'condemn_refused', { refCode: `AP-${row.id}`, note });
    return { rejected: true };
  },
  async onWithdraw(db, c, row) {
    await db.query("UPDATE cf_machines SET stage = COALESCE(stage_before, 'live'), stage_before = NULL WHERE company_id = ? AND id = ? AND stage = 'condemn_requested'", [c.companyId, row.subject_id]);
  },
};

/** POST /machines/:id/disposal { disposal: scrapped | sold, on, amount?, note? } — once, after it is condemned. */
export async function recordDisposal(db, c, id, input = {}) {
  const m = await requireMachineRow(db, c.companyId, id, { lock: true });
  if (m.stage !== 'condemned') throw invalid('NOT_CONDEMNED', `${m.code} is not condemned — the MD approves that first.`);
  if (m.disposal) throw conflict('DONE', `${m.code}'s disposal is already recorded.`);
  const problems = [];
  if (!DISPOSALS.includes(input.disposal)) problems.push('Scrapped or sold?');
  const on = blank(input.on) ? null : String(input.on).slice(0, 10);
  if (!on || !DATE_RE.test(on)) problems.push('The date it went.');
  const amount = blank(input.amount) ? 0 : Number(input.amount);
  if (!Number.isFinite(amount) || amount < 0) problems.push('Amount realised: zero or more.');
  if (input.disposal === 'sold' && !(amount > 0)) problems.push('Sold — for how much?');
  assertNoProblems(problems, 'The disposal cannot be recorded.');
  await db.query('UPDATE cf_machines SET disposal = ?, disposal_on = ?, disposal_amount = ?, disposal_note = ? WHERE company_id = ? AND id = ?',
    [input.disposal, on, round2(amount), blank(input.note) ? null : String(input.note).slice(0, 500), c.companyId, m.id]);
  await logEvent(db, c, m.id, 'disposed', { note: `${input.disposal === 'sold' ? 'Sold' : 'Scrapped'} on ${on}${amount ? ` for ₹${round2(amount).toLocaleString('en-IN')}` : ''}${blank(input.note) ? '' : ` — ${input.note}`}` });
  return getMachineLife(db, c.companyId, m.id);
}

/* ── Cost ──────────────────────────────────────────────────────────────────────────────────────────────── */

/** PUT /machines/:id/cost { cost?, salvageValue?, lifeYears?, liveOn? } — Maintenance or Accounts. */
export async function setCost(db, c, id, input = {}) {
  const m = await requireMachineRow(db, c.companyId, id, { lock: true });
  const problems = [];
  const sets = {};
  const money = (raw, label, key) => {
    if (raw === undefined) return;
    if (blank(raw)) { sets[key] = null; return; }
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) problems.push(`${label}: an amount, zero or more.`); else sets[key] = round2(n);
  };
  money(input.cost, 'Cost', 'cost');
  money(input.salvageValue, 'Salvage value', 'salvage_value');
  if (input.lifeYears !== undefined) {
    if (blank(input.lifeYears)) sets.life_years = null;
    else { const n = Number(input.lifeYears); if (!(n > 0 && n <= 100)) problems.push('Life: years, above zero.'); else sets.life_years = n; }
  }
  if (input.liveOn !== undefined) {
    if (m.stage === 'setup') problems.push('The live date is set when it goes live.');
    else if (blank(input.liveOn) || !DATE_RE.test(String(input.liveOn))) problems.push('Live since: a date.');
    else sets.live_on = String(input.liveOn).slice(0, 10);
  }
  const cost = sets.cost !== undefined ? sets.cost : m.cost;
  const salvage = sets.salvage_value !== undefined ? sets.salvage_value : m.salvage_value;
  if (cost != null && salvage != null && Number(salvage) > Number(cost)) problems.push('The salvage value is more than the cost.');
  assertNoProblems(problems, 'The cost cannot be saved.');
  if (Object.keys(sets).length) {
    await db.query(`UPDATE cf_machines SET ${Object.keys(sets).map((k) => `${k} = ?`).join(', ')} WHERE company_id = ? AND id = ?`, [...Object.values(sets), c.companyId, m.id]);
    const parts = [sets.cost !== undefined && `cost ${sets.cost ?? '—'}`, sets.salvage_value !== undefined && `salvage ${sets.salvage_value ?? '—'}`,
      sets.life_years !== undefined && `life ${sets.life_years ?? '—'} y`, sets.live_on && `live since ${sets.live_on}`].filter(Boolean);
    await logEvent(db, c, m.id, 'cost', { note: parts.join(', ') });
  }
  return getMachineLife(db, c.companyId, m.id);
}

/** What was issued to the machine's setup tickets, per item, with its treatment (capital / expense). 2 reads. */
export async function setupItems(db, companyId, machineId) {
  let rows;
  try {
    [rows] = await db.query(
      `SELECT l.item_id, mr.code, mr.name, ${KIND_SQL} AS resource_kind, -SUM(l.quantity) AS qty, -SUM(l.value) AS value, d.uom,
              GROUP_CONCAT(DISTINCT mo.code ORDER BY mo.id) AS tickets
         FROM cf_stock_ledger l
         JOIN cf_stock_movements sm ON sm.id = l.movement_id AND sm.reversal_of_id IS NULL AND sm.reversed_by_id IS NULL
         JOIN cf_maintenance_orders mo ON mo.id = sm.maintenance_order_id AND mo.source = 'setup' AND mo.machine_id = ?
         JOIN cf_master_records mr ON mr.company_id = l.company_id AND mr.id = l.item_id
         JOIN cf_item_details d ON d.company_id = l.company_id AND d.master_id = l.item_id
         ${FAMILY_JOINS}
        WHERE l.company_id = ? AND l.deleted_at IS NULL
        GROUP BY l.item_id, mr.code, mr.name, resource_kind, d.uom`,
      [machineId, companyId],
    );
  } catch (e) { if (missing(e)) return []; throw e; }
  const [over] = await db.query('SELECT item_id, treatment FROM cf_machine_setup_items WHERE company_id = ? AND machine_id = ?', [companyId, machineId]);
  const set = new Map(over.map((o) => [Number(o.item_id), o.treatment]));
  return rows.filter((r) => Math.abs(Number(r.qty)) > 1e-9).map((r) => {
    const def = r.resource_kind === 'consumable' ? 'expense' : 'capital';
    return {
      itemId: Number(r.item_id), code: r.code, name: r.name, qty: Number(r.qty), uom: r.uom, value: r.value == null ? null : round2(r.value),
      tickets: r.tickets ? String(r.tickets).split(',') : [], treatment: set.get(Number(r.item_id)) ?? def, defaultTreatment: def,
    };
  });
}

/** PUT /machines/:id/setup-items/:itemId { treatment: capital | expense } — Maintenance. */
export async function setSetupTreatment(db, c, id, itemId, input = {}) {
  const m = await requireMachineRow(db, c.companyId, id);
  if (!TREATMENTS.includes(input.treatment)) throw invalid('INVALID', 'Installation (capital) or Consumable (expense).');
  await db.query(
    `INSERT INTO cf_machine_setup_items (company_id, machine_id, item_id, treatment, created_by) VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE treatment = VALUES(treatment)`,
    [c.companyId, m.id, Number(itemId), input.treatment, c.userId ?? null],
  );
  return getMachineLife(db, c.companyId, m.id);
}

/**
 * Straight line from the live date. base = cost + capitalised setup. Until condemned (or today); never below salvage.
 * null when the cost, the life or the live date is not known.
 */
export function depreciationOf(m, setupCapital, onDate) {
  if (m.cost == null || m.life_years == null || !m.live_on) return null;
  const base = round2(Number(m.cost) + Number(setupCapital ?? 0));
  const salvage = round2(Math.min(Number(m.salvage_value ?? 0), base));
  const lifeDays = Math.round(Number(m.life_years) * 365);
  const perDay = lifeDays > 0 ? (base - salvage) / lifeDays : 0;
  const end = m.condemned_on && m.condemned_on < onDate ? m.condemned_on : onDate;
  const days = Math.max(0, Math.min(lifeDays, daysBetween(String(m.live_on).slice(0, 10), end)));
  const accumulated = round2(perDay * days);
  return {
    base, salvage, lifeYears: Number(m.life_years), perDay: round2(perDay), perYear: round2(perDay * 365),
    accumulated, bookValue: round2(base - accumulated), endsOn: addDays(String(m.live_on).slice(0, 10), lifeDays),
  };
}

/* ── Order use: days shared by run hours ──────────────────────────────────────────────────────────────── */

/** Splits [start, end) (plant wall clock) into hours per day. */
export function hoursByDay(start, end) {
  const out = [];
  let a = wallMs(start);
  const b = wallMs(end);
  while (a < b) {
    const dayEnd = dayMs(dayOf(a)) + 86400000;
    const stop = Math.min(b, dayEnd);
    out.push([dayOf(a), (stop - a) / 3600000]);
    a = stop;
  }
  return out;
}

/**
 * For machines and a date range: every (machine, day) the machine was used, with each order's share of that day.
 * Run hours decide (work sessions of production steps, by the step's order); a day with none goes to the order it was
 * checked out to. Returns Map machineId → Map day → Map orderId → share (shares of a day sum to 1). 2 reads.
 */
export async function dayShares(db, companyId, machineIds, from, to, nowWall) {
  const out = new Map();
  if (!machineIds.length) return out;
  const [sessions] = await db.query(
    `SELECT ws.machine_id, ws.started_at, ws.ended_at, rel.order_id
       FROM cf_work_sessions ws
       JOIN cf_production_steps st ON st.id = ws.step_id
       JOIN cf_production_items pi ON pi.id = st.production_item_id
       JOIN cf_production_releases rel ON rel.id = pi.release_id
      WHERE ws.company_id = ? AND ws.machine_id IN (?) AND ws.deleted_at IS NULL
        AND ws.started_at < ? AND COALESCE(ws.ended_at, ?) >= ?`,
    [companyId, machineIds, `${addDays(to, 1)} 00:00:00`, nowWall, `${from} 00:00:00`],
  );
  const [booked] = await db.query(
    `SELECT machine_id, order_id, DATE(out_at) AS d1, DATE(COALESCE(in_at, ?)) AS d2 FROM cf_machine_checkouts
      WHERE company_id = ? AND machine_id IN (?) AND to_kind = 'order' AND out_at < ? AND COALESCE(in_at, ?) >= ? ORDER BY out_at`,
    [nowWall, companyId, machineIds, `${addDays(to, 1)} 00:00:00`, nowWall, `${from} 00:00:00`],
  );
  return sharesFrom(sessions, booked, from, to, nowWall);
}

/**
 * The pure part of dayShares: sessions [{ machine_id, order_id, started_at, ended_at }] and order check-outs
 * [{ machine_id, order_id, d1, d2 }] → Map machine → Map day → Map order → share.
 */
export function sharesFrom(sessions, booked, from, to, nowWall) {
  const out = new Map();
  const hours = new Map(); // m → day → order → h
  for (const s of sessions) {
    const end = wallText(s.ended_at) ?? nowWall;
    for (const [day, h] of hoursByDay(wallText(s.started_at), end)) {
      if (day < from || day > to || h <= 0) continue;
      const m = Number(s.machine_id);
      if (!hours.has(m)) hours.set(m, new Map());
      const byDay = hours.get(m);
      if (!byDay.has(day)) byDay.set(day, new Map());
      const o = byDay.get(day);
      o.set(Number(s.order_id), (o.get(Number(s.order_id)) ?? 0) + h);
    }
  }
  for (const [m, byDay] of hours) {
    const res = new Map();
    for (const [day, o] of byDay) {
      const total = [...o.values()].reduce((t, h) => t + h, 0);
      res.set(day, new Map([...o].map(([k, h]) => [k, h / total])));
    }
    out.set(m, res);
  }
  for (const k of booked) {
    const m = Number(k.machine_id);
    if (!out.has(m)) out.set(m, new Map());
    const res = out.get(m);
    const d1 = String(k.d1 instanceof Date ? k.d1.toISOString() : k.d1).slice(0, 10);
    const d2 = String(k.d2 instanceof Date ? k.d2.toISOString() : k.d2).slice(0, 10);
    for (let d = d1 > from ? d1 : from; d <= d2 && d <= to; d = addDays(d, 1)) {
      if (!res.has(d)) res.set(d, new Map([[Number(k.order_id), 1]]));
    }
  }
  return out;
}

/** The machines (with depreciation) and the rupees a day each costs, by id. 2 reads. */
async function ratesOf(db, companyId, machineIds, onDate) {
  if (!machineIds.length) return new Map();
  const [ms] = await db.query('SELECT * FROM cf_machines WHERE company_id = ? AND id IN (?)', [companyId, machineIds]);
  const capital = await setupCapitalOf(db, companyId, machineIds);
  const out = new Map();
  for (const m of ms) {
    const dep = depreciationOf(m, capital.get(Number(m.id)) ?? 0, onDate);
    if (dep) out.set(Number(m.id), { m, dep, from: String(m.live_on).slice(0, 10), until: m.condemned_on && m.condemned_on < dep.endsOn ? m.condemned_on : dep.endsOn });
  }
  return out;
}

/** Capitalised setup value per machine (the setup items treated as capital). */
async function setupCapitalOf(db, companyId, machineIds) {
  const out = new Map();
  for (const id of machineIds) {
    const items = await setupItems(db, companyId, id);
    const cap = items.filter((i) => i.treatment === 'capital').reduce((t, i) => t + Number(i.value ?? 0), 0);
    if (cap) out.set(Number(id), round2(cap));
  }
  return out;
}

/**
 * The orders' MACHINE USE: Map orderId → { total, machines: [{ id, code, name, kind, days, amount }] }. A day is charged
 * at the machine's rate a day, shared by run hours; only days between its live date and the end of its life (or its
 * condemning). Fixed reads.
 */
export async function machineUseOf(db, companyId, orderIds) {
  const out = new Map();
  const ids = [...new Set(orderIds.map(Number).filter(Boolean))];
  if (!ids.length) return out;
  let used;
  try {
    [used] = await db.query(
      `SELECT DISTINCT ws.machine_id FROM cf_work_sessions ws
         JOIN cf_production_steps st ON st.id = ws.step_id JOIN cf_production_items pi ON pi.id = st.production_item_id
         JOIN cf_production_releases rel ON rel.id = pi.release_id
        WHERE ws.company_id = ? AND rel.order_id IN (?) AND ws.deleted_at IS NULL
       UNION SELECT DISTINCT machine_id FROM cf_machine_checkouts WHERE company_id = ? AND to_kind = 'order' AND order_id IN (?)`,
      [companyId, ids, companyId, ids],
    );
  } catch (e) { if (missing(e)) return out; throw e; }
  const { wall, today: t } = await today(db, companyId);
  const rates = await ratesOf(db, companyId, used.map((r) => Number(r.machine_id)), t);
  if (!rates.size) return out;
  const from = [...rates.values()].reduce((a, r) => (r.from < a ? r.from : a), t);
  const shares = await dayShares(db, companyId, [...rates.keys()], from, t, wall);
  const want = new Set(ids);
  for (const [mid, byDay] of shares) {
    const r = rates.get(mid);
    if (!r) continue;
    for (const [day, o] of byDay) {
      if (day < r.from || day >= r.until) continue;
      for (const [oid, share] of o) {
        if (!want.has(oid)) continue;
        if (!out.has(oid)) out.set(oid, { total: 0, machines: new Map() });
        const e = out.get(oid);
        const mm = e.machines.get(mid) ?? { id: mid, code: r.m.code, name: r.m.name, kind: r.m.kind, days: 0, amount: 0, ratePerDay: r.dep.perDay };
        mm.days += share;
        mm.amount += share * (r.dep.base - r.dep.salvage) / Math.round(r.dep.lifeYears * 365);
        e.machines.set(mid, mm);
      }
    }
  }
  for (const [oid, e] of out) {
    const machines = [...e.machines.values()].map((m) => ({ ...m, days: round2(m.days), amount: round2(m.amount) })).sort((a, b) => b.amount - a.amount);
    out.set(oid, { total: round2(machines.reduce((s, m) => s + m.amount, 0)), machines });
  }
  return out;
}

/** One machine's use: per order (days, rupees) and idle days, from its live date to today. */
async function useOfMachine(db, companyId, m, dep) {
  if (!dep || !m.live_on) return null;
  const { wall, today: t } = await today(db, companyId);
  const from = String(m.live_on).slice(0, 10);
  const until = m.condemned_on && m.condemned_on < t ? m.condemned_on : t;
  if (until < from) return { orders: [], usedDays: 0, idleDays: 0, charged: 0, unrecovered: 0 };
  const shares = (await dayShares(db, companyId, [m.id], from, until, wall)).get(Number(m.id)) ?? new Map();
  const perDay = (dep.base - dep.salvage) / Math.round(dep.lifeYears * 365);
  const byOrder = new Map();
  let used = 0;
  for (const [day, o] of shares) {
    if (day >= dep.endsOn) continue;
    used += 1;
    for (const [oid, share] of o) byOrder.set(oid, (byOrder.get(oid) ?? 0) + share);
  }
  const span = Math.max(0, Math.min(daysBetween(from, until) + 1, Math.round(dep.lifeYears * 365)));
  const ids = [...byOrder.keys()];
  const [orders] = ids.length ? await db.query('SELECT id, code, title FROM cf_sales_orders WHERE company_id = ? AND id IN (?)', [companyId, ids]) : [[]];
  const byId = new Map(orders.map((o) => [Number(o.id), o]));
  const rows = ids.map((id) => ({ id, code: byId.get(id)?.code ?? null, title: byId.get(id)?.title ?? null, days: round2(byOrder.get(id)), amount: round2(byOrder.get(id) * perDay) }))
    .sort((a, b) => b.amount - a.amount);
  const charged = round2(rows.reduce((s, r) => s + r.amount, 0));
  return { orders: rows, usedDays: used, idleDays: Math.max(0, span - used), charged, unrecovered: round2(Math.max(0, span * perDay - charged)) };
}

/* ── The machine's life, read ──────────────────────────────────────────────────────────────────────────── */

/** GET /machines/:id/life — stage, place, custody, tickets, condemning, cost and its use. */
export async function getMachineLife(db, companyId, id) {
  const m = await requireMachineRow(db, companyId, id);
  const { today: t } = await today(db, companyId);
  const [[area], out, [tickets], [[approval]], [[maint]], items] = await Promise.all([
    m.area_id ? db.query('SELECT id, code, name, purpose FROM cf_stocking_areas WHERE company_id = ? AND id = ?', [companyId, m.area_id]).then(([r]) => r) : [null],
    openCheckout(db, companyId, m.id),
    db.query("SELECT id, code, status, title, raised_at, done_at FROM cf_maintenance_orders WHERE company_id = ? AND machine_id = ? AND source = 'setup' AND deleted_at IS NULL ORDER BY id DESC LIMIT 5", [companyId, m.id]),
    db.query("SELECT id, status, decision_note, requested_at FROM cf_approvals WHERE company_id = ? AND approval_type = 'machine_condemn' AND subject_id = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 1", [companyId, m.id]),
    db.query("SELECT MAX(done_at) AS last, COALESCE(SUM(parts_cost), 0) + COALESCE(SUM(other_cost), 0) AS cost FROM cf_maintenance_orders WHERE company_id = ? AND machine_id = ? AND status = 'done' AND source <> 'setup' AND deleted_at IS NULL", [companyId, m.id]),
    setupItems(db, companyId, m.id),
  ]);
  let checkout = null;
  if (out) checkout = shapeCheckout(out, await nameCheckouts(db, companyId, [out]), t);
  const capital = round2(items.filter((i) => i.treatment === 'capital').reduce((s, i) => s + Number(i.value ?? 0), 0));
  const expense = round2(items.filter((i) => i.treatment === 'expense').reduce((s, i) => s + Number(i.value ?? 0), 0));
  const dep = depreciationOf(m, capital, t);
  const use = await useOfMachine(db, companyId, m, dep);
  const openTicket = tickets.find((x) => ['open', 'in_progress', 'waiting_parts'].includes(x.status)) ?? null;
  return {
    id: m.id, code: m.code, name: m.name, kind: m.kind, stage: m.stage, stageLabel: STAGE_LABEL[m.stage] ?? m.stage, today: t,
    area: area ? { id: area.id, code: area.code, name: area.name, purpose: area.purpose } : null,
    checkout, receivedOn: m.received_on ?? null, liveOn: m.live_on ?? null, condemnedOn: m.condemned_on ?? null,
    setupTicket: openTicket ? { id: openTicket.id, code: openTicket.code, status: openTicket.status, title: openTicket.title } : null,
    setupTickets: tickets.map((x) => ({ id: x.id, code: x.code, status: x.status })),
    condemn: approval ? { approvalId: approval.id, status: approval.status, note: approval.decision_note ?? null, askedAt: approval.requested_at } : null,
    disposal: m.disposal ? { kind: m.disposal, on: m.disposal_on, amount: Number(m.disposal_amount ?? 0), note: m.disposal_note ?? null, writtenOff: dep ? round2(Math.max(0, dep.bookValue - Number(m.disposal_amount ?? 0))) : null } : null,
    cost: {
      cost: m.cost == null ? null : Number(m.cost), salvageValue: m.salvage_value == null ? null : Number(m.salvage_value), lifeYears: m.life_years == null ? null : Number(m.life_years),
      setupCapital: capital, setupExpense: expense, setupItems: items, depreciation: dep, use,
    },
    lastMaintenance: maint?.last ? wallText(maint.last) : null, maintenanceCost: round2(Number(maint?.cost ?? 0)),
  };
}

/**
 * GET /machines/:id/log?limit= — everything that happened to it, newest first: its events, maintenance orders and the
 * work it ran (one row per order and day, with hours and who ran it). 4 reads.
 */
export async function machineLog(db, companyId, id, q = {}) {
  const m = await requireMachineRow(db, companyId, id);
  const limit = Math.min(500, Math.max(20, Number(q.limit) || 200));
  const [[events], [mos], [runs]] = await Promise.all([
    db.query(
      `SELECT e.*, u.name AS user_name, a.code AS area_code, fa.code AS from_area_code FROM cf_machine_events e
         LEFT JOIN users u ON u.id = e.created_by LEFT JOIN cf_stocking_areas a ON a.id = e.area_id LEFT JOIN cf_stocking_areas fa ON fa.id = e.from_area_id
        WHERE e.company_id = ? AND e.machine_id = ? ORDER BY e.id DESC LIMIT ?`, [companyId, m.id, limit]),
    db.query("SELECT id, code, source, status, title, raised_at, done_at FROM cf_maintenance_orders WHERE company_id = ? AND machine_id = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT ?", [companyId, m.id, limit]),
    db.query(
      `SELECT DATE(ws.started_at) AS day, rel.order_id, o.code AS order_code, SUM(TIMESTAMPDIFF(MINUTE, ws.started_at, COALESCE(ws.ended_at, ws.started_at))) AS minutes,
              GROUP_CONCAT(DISTINCT u.name ORDER BY u.name SEPARATOR ', ') AS operators, MAX(COALESCE(ws.ended_at, ws.started_at)) AS last_at
         FROM cf_work_sessions ws
         JOIN cf_production_steps st ON st.id = ws.step_id JOIN cf_production_items pi ON pi.id = st.production_item_id
         JOIN cf_production_releases rel ON rel.id = pi.release_id JOIN cf_sales_orders o ON o.id = rel.order_id
         LEFT JOIN users u ON u.id = ws.operator_id
        WHERE ws.company_id = ? AND ws.machine_id = ? AND ws.deleted_at IS NULL
        GROUP BY DATE(ws.started_at), rel.order_id, o.code ORDER BY day DESC LIMIT ?`, [companyId, m.id, limit]),
  ]).catch((e) => { if (missing(e)) return [[[]], [[]], [[]]]; throw e; });
  // Events carry the plant clock (at), like maintenance and work — the database clock may be UTC (TiDB).
  const rows = [
    ...events.map((e) => ({
      at: wallText(e.at ?? e.created_at), kind: 'event', event: e.event, label: EVENT_LABEL[e.event] ?? e.event, by: e.user_name ?? null,
      area: e.area_code ?? null, fromArea: e.from_area_code ?? null, ref: e.ref_code ?? null, note: e.note ?? null,
    })),
    ...mos.map((x) => ({
      at: wallText(x.raised_at), kind: 'maintenance', event: x.source, label: x.source === 'setup' ? 'Setup ticket' : x.source === 'fault' ? 'Fault' : x.source === 'preventive' ? 'Preventive maintenance' : 'Maintenance job',
      ref: x.code, refId: x.id, note: x.title, status: x.status, doneAt: wallText(x.done_at),
    })),
    ...runs.map((r) => ({
      at: wallText(r.last_at), day: String(r.day instanceof Date ? r.day.toISOString() : r.day).slice(0, 10), kind: 'work', event: 'work', label: 'Worked on',
      ref: r.order_code, refId: r.order_id, hours: round2(Number(r.minutes) / 60), by: r.operators ?? null,
    })),
  ].sort((a, b) => (String(b.at) > String(a.at) ? 1 : String(b.at) < String(a.at) ? -1 : (KIND_RANK[a.kind] ?? 0) - (KIND_RANK[b.kind] ?? 0)));
  return { rows: rows.slice(0, limit) };
}

/** Newest first; on the same second a maintenance row follows the event that raised it. */
const KIND_RANK = { event: 0, work: 1, maintenance: 2 };

/** Register columns: stage, kind, place and who has it, for a list of machines (2 reads). */
export async function lifeColumns(db, companyId, machineIds) {
  const out = new Map();
  if (!machineIds.length) return out;
  let ms;
  try {
    [ms] = await db.query(
      `SELECT m.id, m.kind, m.stage, a.id AS area_id, a.code AS area_code, a.name AS area_name FROM cf_machines m LEFT JOIN cf_stocking_areas a ON a.id = m.area_id
        WHERE m.company_id = ? AND m.id IN (?)`, [companyId, machineIds]);
  } catch (e) { if (missing(e)) return out; throw e; }
  const [outs] = await db.query('SELECT * FROM cf_machine_checkouts WHERE company_id = ? AND machine_id IN (?) AND in_at IS NULL', [companyId, machineIds]);
  const namer = await nameCheckouts(db, companyId, outs);
  const byM = new Map(outs.map((o) => [Number(o.machine_id), o]));
  for (const m of ms) {
    const o = byM.get(Number(m.id));
    out.set(Number(m.id), {
      kind: m.kind, stage: m.stage, stageLabel: STAGE_LABEL[m.stage] ?? m.stage,
      area: m.area_id ? { id: m.area_id, code: m.area_code, name: m.area_name } : null,
      withWhom: o ? { ...namer(o), takenBy: o.taken_by ?? null, dueOn: o.due_on ?? null } : null,
    });
  }
  return out;
}
