/**
 * toolLifeService.js — tools are catalog items with stock (init.sql §81). An item may carry a LIFE
 * (uses | hours | metres, and how many). When such a tool is issued from stock, each whole piece
 * issued gets a cf_tool_life row; use is recorded against it until it is worn out or retired.
 *
 * "Used for" is NOT checked here: every issue already needs it (stockService.postMovement, §74), a
 * tool's included. The issue's order and line are copied onto the pieces.
 */
import { invalid, notFound, assertNoProblems } from '../lib/errors.js';
import { loadMaster } from './records.js';

export const LIFE_UNITS = ['uses', 'hours', 'metres'];
export const TOOL_STATUSES = ['in_use', 'worn_out', 'retired', 'void'];
const MAX_PIECES_PER_LINE = 200;
const blank = (v) => v == null || String(v).trim() === '';
const round3 = (n) => Math.round(Number(n) * 1000) / 1000;

/** The tool tables or columns are not there yet (a database before §81): nothing to track. */
export function missingToolLife(e) {
  return !!e && (e.errno === 1054 || e.errno === 1146) && /cf_tool_life|cf_tool_usage|life_unit|life_limit/.test(String(e.message ?? e.sqlMessage ?? ''));
}

function shape(r) {
  const limit = r.life_limit == null ? null : Number(r.life_limit);
  const used = Number(r.life_used);
  return {
    id: r.id,
    itemId: r.item_id,
    itemCode: r.item_code ?? null,
    itemName: r.item_name ?? null,
    uom: r.uom ?? null,
    movementId: r.movement_id,
    movementCode: r.movement_code ?? null,
    unitNo: r.unit_no,
    issuedOn: r.issued_on ? String(r.issued_on).slice(0, 10) : null,
    orderId: r.order_id,
    orderCode: r.order_code ?? null,
    orderLineId: r.order_line_id,
    usedFor: r.order_id ? 'order' : 'general',
    machineId: r.machine_id,
    machineCode: r.machine_code ?? null,
    lifeUnit: r.life_unit,
    lifeLimit: limit,
    lifeUsed: used,
    remaining: limit == null ? null : round3(Math.max(0, limit - used)),
    percentUsed: limit ? Math.min(100, Math.round((used / limit) * 1000) / 10) : null,
    status: r.status,
    closedAt: r.closed_at,
    notes: r.notes,
  };
}

const SELECT = `SELECT t.*, i.code AS item_code, i.name AS item_name, d.uom, mv.code AS movement_code, o.code AS order_code, mc.code AS machine_code
    FROM cf_tool_life t
    JOIN cf_master_records i ON i.company_id = t.company_id AND i.id = t.item_id
    JOIN cf_item_details d ON d.company_id = t.company_id AND d.master_id = t.item_id
    LEFT JOIN cf_stock_movements mv ON mv.id = t.movement_id
    LEFT JOIN cf_sales_orders o ON o.id = t.order_id
    LEFT JOIN cf_machines mc ON mc.company_id = t.company_id AND mc.id = t.machine_id`;

/**
 * Called by stockService.postMovement for an ISSUE, after its lines are written. `moving` = the plans
 * ({ item, quantity }). One query finds which items carry a life; one INSERT makes every piece row.
 */
export async function trackIssuedTools(db, c, movementId, moving) {
  try {
    const ids = [...new Set(moving.map((p) => p.item?.id).filter((x) => x != null))];
    if (!ids.length) return 0;
    const [lives] = await db.query(
      'SELECT master_id, life_unit, life_limit FROM cf_item_details WHERE company_id = ? AND master_id IN (?) AND life_unit IS NOT NULL', [c.companyId, ids]);
    if (!lives.length) return 0;
    const life = new Map(lives.map((l) => [l.master_id, l]));
    const [[mv]] = await db.query('SELECT order_id, order_line_id, movement_date FROM cf_stock_movements WHERE id = ?', [movementId]);
    const rows = [];
    for (const p of moving) {
      const l = life.get(p.item.id);
      if (!l) continue;
      const pieces = Math.min(MAX_PIECES_PER_LINE, Math.floor(Math.abs(Number(p.quantity)) + 1e-9));
      for (let n = 1; n <= pieces; n++) {
        rows.push([c.companyId, p.item.id, movementId, n, mv?.movement_date ?? null, mv?.order_id ?? null, mv?.order_line_id ?? null, l.life_unit, l.life_limit, c.userId]);
      }
    }
    if (!rows.length) return 0;
    await db.query(
      'INSERT INTO cf_tool_life (company_id, item_id, movement_id, unit_no, issued_on, order_id, order_line_id, life_unit, life_limit, created_by) VALUES ?', [rows]);
    return rows.length;
  } catch (e) {
    if (missingToolLife(e)) return 0;
    throw e;
  }
}

/** An issue was reversed: its tool pieces go back to stock and are no longer tracked. */
export async function voidIssuedTools(db, c, movementId) {
  try {
    await db.query(
      `UPDATE cf_tool_life SET status = 'void', deleted_at = NOW(), closed_at = NOW()
        WHERE company_id = ? AND movement_id = ? AND deleted_at IS NULL`, [c.companyId, movementId]);
  } catch (e) {
    if (!missingToolLife(e)) throw e;
  }
}

/** GET /tools/life?itemId=&status=&machineId=&orderId=&search=&limit= — tool pieces issued, newest first. */
export async function listToolLife(db, companyId, q = {}) {
  const where = ['t.company_id = ?', 't.deleted_at IS NULL'];
  const params = [companyId];
  if (!blank(q.itemId)) { where.push('t.item_id = ?'); params.push(Number(q.itemId)); }
  if (!blank(q.machineId)) { where.push('t.machine_id = ?'); params.push(Number(q.machineId)); }
  if (!blank(q.orderId)) { where.push('t.order_id = ?'); params.push(Number(q.orderId)); }
  if (!blank(q.status) && q.status !== 'all') {
    const st = String(q.status).split(',').filter((s) => TOOL_STATUSES.includes(s));
    if (st.length) { where.push('t.status IN (?)'); params.push(st); }
  }
  if (!blank(q.search)) {
    const like = `%${String(q.search).trim().replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    where.push('(i.code LIKE ? OR i.name LIKE ?)');
    params.push(like, like);
  }
  const limit = Math.min(500, Math.max(1, Number(q.limit) || 200));
  const [rows] = await db.query(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY t.id DESC LIMIT ?`, [...params, limit]);
  return rows.map(shape);
}

async function requireTool(db, companyId, id) {
  const [[row]] = await db.query(`${SELECT} WHERE t.company_id = ? AND t.id = ? AND t.deleted_at IS NULL`, [companyId, id]);
  if (!row) throw notFound('Tool piece');
  return row;
}

export async function getToolLife(db, companyId, id) {
  const t = shape(await requireTool(db, companyId, id));
  const [usage] = await db.query(
    `SELECT u.id, u.amount, u.used_on, u.note, u.created_at, mc.code AS machine_code
       FROM cf_tool_usage u LEFT JOIN cf_machines mc ON mc.company_id = u.company_id AND mc.id = u.machine_id
      WHERE u.company_id = ? AND u.tool_life_id = ? ORDER BY u.id DESC LIMIT 100`, [companyId, id]);
  return { ...t, usage: usage.map((u) => ({ id: u.id, amount: Number(u.amount), usedOn: u.used_on ? String(u.used_on).slice(0, 10) : null, machineCode: u.machine_code, note: u.note, at: u.created_at })) };
}

/**
 * POST /tools/life/:id/use { amount, usedOn?, machineId?, orderId?, note? } — adds use to a piece in use;
 * at or above its limit it is worn out. Returns the piece.
 */
export async function recordToolUse(db, c, id, input = {}) {
  const t = await requireTool(db, c.companyId, id);
  const problems = [];
  const amount = Number(input.amount);
  if (!(amount > 0)) problems.push('Use is a number above zero.');
  if (t.status !== 'in_use') problems.push(`This piece is ${t.status === 'worn_out' ? 'worn out' : t.status === 'retired' ? 'retired' : 'void'} — use cannot be added.`);
  let machineId = null;
  if (!blank(input.machineId)) {
    const [[m]] = await db.query('SELECT id FROM cf_machines WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [c.companyId, Number(input.machineId)]);
    if (!m) problems.push('That machine was not found.'); else machineId = m.id;
  }
  const usedOn = blank(input.usedOn) ? null : String(input.usedOn).slice(0, 10);
  if (usedOn && !/^\d{4}-\d{2}-\d{2}$/.test(usedOn)) problems.push('Date is YYYY-MM-DD.');
  assertNoProblems(problems);
  const used = round3(Number(t.life_used) + amount);
  const worn = t.life_limit != null && used >= Number(t.life_limit);
  await db.query(
    'INSERT INTO cf_tool_usage (company_id, tool_life_id, amount, used_on, machine_id, order_id, note, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [c.companyId, id, amount, usedOn, machineId, blank(input.orderId) ? null : Number(input.orderId),
      blank(input.note) ? null : String(input.note).trim().slice(0, 255), c.userId]);
  await db.query(
    `UPDATE cf_tool_life SET life_used = ?, status = ?, closed_at = ${worn ? 'NOW()' : 'NULL'}, machine_id = COALESCE(?, machine_id)
      WHERE company_id = ? AND id = ?`, [used, worn ? 'worn_out' : 'in_use', machineId, c.companyId, id]);
  return shape(await requireTool(db, c.companyId, id));
}

/** POST /tools/life/:id/retire { note? } — taken out of service before its life is up (or broken). */
export async function retireTool(db, c, id, input = {}) {
  const t = await requireTool(db, c.companyId, id);
  if (t.status !== 'in_use') throw invalid('NOT_IN_USE', 'Only a piece in use can be retired.');
  await db.query(
    "UPDATE cf_tool_life SET status = 'retired', closed_at = NOW(), notes = ? WHERE company_id = ? AND id = ?",
    [blank(input.note) ? null : String(input.note).trim().slice(0, 255), c.companyId, id]);
  return shape(await requireTool(db, c.companyId, id));
}

/** GET /items/:id/tool-life — the item's life setting and its pieces by state. */
export async function getItemLife(db, companyId, itemId) {
  const m = await loadMaster(db, companyId, itemId);
  if (!m || m.record_kind !== 'item') throw notFound('Item');
  const [[d]] = await db.query('SELECT life_unit, life_limit FROM cf_item_details WHERE company_id = ? AND master_id = ?', [companyId, itemId]);
  const [counts] = await db.query(
    `SELECT status, COUNT(*) AS n FROM cf_tool_life WHERE company_id = ? AND item_id = ? AND deleted_at IS NULL GROUP BY status`, [companyId, itemId]);
  const by = Object.fromEntries(counts.map((r) => [r.status, Number(r.n)]));
  return { itemId, lifeUnit: d?.life_unit ?? null, lifeLimit: d?.life_limit == null ? null : Number(d.life_limit), inUse: by.in_use ?? 0, wornOut: by.worn_out ?? 0, retired: by.retired ?? 0 };
}

/**
 * PUT /items/:id/tool-life { lifeUnit | null, lifeLimit | null } — the life a piece of this item gets when issued.
 * lifeUnit null clears tracking. Pieces already issued keep the limit they were given.
 */
export async function setItemLife(db, c, itemId, input = {}) {
  const m = await loadMaster(db, c.companyId, itemId);
  if (!m || m.record_kind !== 'item') throw notFound('Item');
  const problems = [];
  const unit = blank(input.lifeUnit) ? null : String(input.lifeUnit);
  if (unit && !LIFE_UNITS.includes(unit)) problems.push(`Life is counted in ${LIFE_UNITS.join(', ')}.`);
  let limit = null;
  if (!blank(input.lifeLimit)) {
    limit = Number(input.lifeLimit);
    if (!(limit > 0)) problems.push('The life limit is a number above zero.');
  }
  if (!unit && limit != null) problems.push('Choose what the life is counted in.');
  assertNoProblems(problems);
  await db.query('UPDATE cf_item_details SET life_unit = ?, life_limit = ? WHERE company_id = ? AND master_id = ?', [unit, unit ? limit : null, c.companyId, itemId]);
  return getItemLife(db, c.companyId, itemId);
}

/** GET /tools/items?search= — the catalog items of the Tools family: life setting, pieces in use / worn out. */
export async function listToolItems(db, companyId, q = {}) {
  const where = ["r.company_id = ?", "r.record_kind = 'item'", 'r.deleted_at IS NULL', "COALESCE(v.resource_kind, s.resource_kind, f.resource_kind) = 'tool'"];
  const params = [companyId];
  if (!blank(q.search)) {
    const like = `%${String(q.search).trim().replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    where.push('(r.code LIKE ? OR r.name LIKE ?)');
    params.push(like, like);
  }
  const [rows] = await db.query(
    `SELECT r.id, r.code, r.name, d.uom, d.life_unit, d.life_limit,
            (SELECT COUNT(*) FROM cf_tool_life t WHERE t.company_id = r.company_id AND t.item_id = r.id AND t.deleted_at IS NULL AND t.status = 'in_use') AS in_use,
            (SELECT COUNT(*) FROM cf_tool_life t WHERE t.company_id = r.company_id AND t.item_id = r.id AND t.deleted_at IS NULL AND t.status = 'worn_out') AS worn_out
       FROM cf_master_records r
       JOIN cf_item_details d ON d.company_id = r.company_id AND d.master_id = r.id
       JOIN cf_classification_nodes v ON v.company_id = r.company_id AND v.id = r.classification_id
       LEFT JOIN cf_classification_nodes s ON s.company_id = v.company_id AND s.id = v.parent_id
       LEFT JOIN cf_classification_nodes f ON f.company_id = s.company_id AND f.id = s.parent_id
      WHERE ${where.join(' AND ')} ORDER BY r.code LIMIT 500`, params);
  return rows.map((r) => ({
    id: r.id, code: r.code, name: r.name, uom: r.uom, lifeUnit: r.life_unit, lifeLimit: r.life_limit == null ? null : Number(r.life_limit),
    inUse: Number(r.in_use), wornOut: Number(r.worn_out),
  }));
}
