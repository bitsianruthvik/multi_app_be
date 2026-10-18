/**
 * machineResourceService.js — each machine's resource list (init.sql §81): which tools, spares and
 * consumables it needs, with a typical quantity and a kind. It is the template maintenance orders
 * prefill their material requests from, through machineResources().
 *
 * Tools, spares and consumables are catalog items (families flagged by cf_classification_nodes
 * .resource_kind). A list row may name ANY active catalog item and choose its kind; the kind
 * defaults to the item's family.
 */
import { invalid, notFound, assertNoProblems } from '../lib/errors.js';
import { requireMachine } from './records.js';

export const RESOURCE_KINDS = ['tool', 'spare', 'consumable'];
const KIND_ORDER = "FIELD(mr.kind, 'tool', 'spare', 'consumable')";
const blank = (v) => v == null || String(v).trim() === '';
const round3 = (n) => Math.round(Number(n) * 1000) / 1000;

const KIND_SQL = `COALESCE(v.resource_kind, s.resource_kind, f.resource_kind)`;
const KIND_JOINS = `JOIN cf_classification_nodes v ON v.company_id = r.company_id AND v.id = r.classification_id
       LEFT JOIN cf_classification_nodes s ON s.company_id = v.company_id AND s.id = v.parent_id
       LEFT JOIN cf_classification_nodes f ON f.company_id = s.company_id AND f.id = s.parent_id`;

/**
 * THE READ FUNCTION the maintenance orders call: [{ itemId, code, name, kind, qty, uom }] — tools first,
 * then spares, then consumables, in the order the list was kept. One query.
 */
export async function machineResources(db, companyId, machineId) {
  const [rows] = await db.query(
    `SELECT mr.item_id, r.code, r.name, mr.kind, mr.qty, d.uom
       FROM cf_machine_resources mr
       JOIN cf_master_records r ON r.company_id = mr.company_id AND r.id = mr.item_id AND r.deleted_at IS NULL
       JOIN cf_item_details d ON d.company_id = mr.company_id AND d.master_id = mr.item_id
      WHERE mr.company_id = ? AND mr.machine_id = ? AND mr.deleted_at IS NULL
      ORDER BY ${KIND_ORDER}, mr.sort_order, r.code`, [companyId, machineId]);
  return rows.map((r) => ({ itemId: r.item_id, code: r.code, name: r.name, kind: r.kind, qty: Number(r.qty), uom: r.uom }));
}

function shape(r) {
  return {
    id: r.id, machineId: r.machine_id, itemId: r.item_id, code: r.code, name: r.name, kind: r.kind, qty: Number(r.qty), uom: r.uom,
    notes: r.notes ?? null, itemKind: r.item_kind ?? null,
    lifeUnit: r.life_unit ?? null, lifeLimit: r.life_limit == null ? null : Number(r.life_limit),
  };
}

const LIST_SELECT = `SELECT mr.id, mr.machine_id, mr.item_id, r.code, r.name, mr.kind, mr.qty, mr.notes, d.uom, d.life_unit, d.life_limit, ${KIND_SQL} AS item_kind
       FROM cf_machine_resources mr
       JOIN cf_master_records r ON r.company_id = mr.company_id AND r.id = mr.item_id AND r.deleted_at IS NULL
       JOIN cf_item_details d ON d.company_id = mr.company_id AND d.master_id = mr.item_id
       ${KIND_JOINS}`;

/** GET /machines/:id/resources — the list with ids and notes (machineResources() is its lean form). */
export async function listMachineResources(db, companyId, machineId) {
  await requireMachine(db, companyId, machineId);
  const [rows] = await db.query(
    `${LIST_SELECT} WHERE mr.company_id = ? AND mr.machine_id = ? AND mr.deleted_at IS NULL ORDER BY ${KIND_ORDER}, mr.sort_order, r.code`, [companyId, machineId]);
  return rows.map(shape);
}

/** Catalog items by id, with their family's kind — one query. */
async function loadItems(db, companyId, ids) {
  if (!ids.length) return new Map();
  const [rows] = await db.query(
    `SELECT r.id, r.code, r.name, r.status, d.item_type, d.uom, ${KIND_SQL} AS item_kind
       FROM cf_master_records r JOIN cf_item_details d ON d.company_id = r.company_id AND d.master_id = r.id
       ${KIND_JOINS}
      WHERE r.company_id = ? AND r.record_kind = 'item' AND r.deleted_at IS NULL AND r.id IN (?)`, [companyId, ids]);
  return new Map(rows.map((r) => [r.id, r]));
}

function readRows(input, items, problems) {
  const out = [];
  const seen = new Set();
  (Array.isArray(input) ? input : []).forEach((raw, i) => {
    const at = `Row ${i + 1}`;
    const itemId = Number(raw?.itemId);
    const item = items.get(itemId);
    if (!item) { problems.push(`${at}: choose an item.`); return; }
    if (item.item_type !== 'catalog') { problems.push(`${at}: ${item.code ?? item.name} is a temporary item — choose a catalog item.`); return; }
    if (seen.has(itemId)) { problems.push(`${at}: ${item.code ?? item.name} is already on the list.`); return; }
    seen.add(itemId);
    const kind = blank(raw.kind) ? (item.item_kind ?? 'consumable') : String(raw.kind);
    if (!RESOURCE_KINDS.includes(kind)) problems.push(`${at}: kind is tool, spare or consumable.`);
    const qty = blank(raw.qty) ? 1 : Number(raw.qty);
    if (!(qty > 0)) problems.push(`${at}: quantity is a number above zero.`);
    out.push({ itemId, kind, qty: round3(qty), notes: blank(raw.notes) ? null : String(raw.notes).trim().slice(0, 255) });
  });
  return out;
}

/**
 * PUT /machines/:id/resources { rows: [{ itemId, kind?, qty?, notes? }] } — the WHOLE list in one save:
 * rows not sent are removed, the rest are added or updated, in the order sent. Three statements.
 */
export async function setMachineResources(db, c, machineId, input = {}) {
  await requireMachine(db, c.companyId, machineId);
  if (!Array.isArray(input.rows)) throw invalid('INVALID', 'Send the whole list as rows.');
  const items = await loadItems(db, c.companyId, [...new Set(input.rows.map((r) => Number(r?.itemId)).filter((n) => n > 0))]);
  const problems = [];
  const rows = readRows(input.rows, items, problems);
  assertNoProblems(problems);
  if (rows.length) {
    await db.query(
      `UPDATE cf_machine_resources SET deleted_at = NOW() WHERE company_id = ? AND machine_id = ? AND deleted_at IS NULL AND item_id NOT IN (?)`,
      [c.companyId, machineId, rows.map((r) => r.itemId)]);
    await db.query(
      `INSERT INTO cf_machine_resources (company_id, machine_id, item_id, kind, qty, notes, sort_order, created_by) VALUES ?
       ON DUPLICATE KEY UPDATE kind = VALUES(kind), qty = VALUES(qty), notes = VALUES(notes), sort_order = VALUES(sort_order)`,
      [rows.map((r, i) => [c.companyId, machineId, r.itemId, r.kind, r.qty, r.notes, (i + 1) * 10, c.userId])]);
  } else {
    await db.query('UPDATE cf_machine_resources SET deleted_at = NOW() WHERE company_id = ? AND machine_id = ? AND deleted_at IS NULL', [c.companyId, machineId]);
  }
  return listMachineResources(db, c.companyId, machineId);
}

/** POST /machines/:id/resources { itemId, kind?, qty?, notes? } — one row added (or the item's row updated). */
export async function addMachineResource(db, c, machineId, input = {}) {
  await requireMachine(db, c.companyId, machineId);
  const items = await loadItems(db, c.companyId, [Number(input.itemId)].filter((n) => n > 0));
  const problems = [];
  const [row] = readRows([input], items, problems);
  assertNoProblems(problems);
  const [[{ top }]] = await db.query('SELECT COALESCE(MAX(sort_order), 0) AS top FROM cf_machine_resources WHERE company_id = ? AND machine_id = ? AND deleted_at IS NULL', [c.companyId, machineId]);
  await db.query(
    `INSERT INTO cf_machine_resources (company_id, machine_id, item_id, kind, qty, notes, sort_order, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE kind = VALUES(kind), qty = VALUES(qty), notes = VALUES(notes)`,
    [c.companyId, machineId, row.itemId, row.kind, row.qty, row.notes, Number(top) + 10, c.userId]);
  const all = await listMachineResources(db, c.companyId, machineId);
  return all.find((r) => r.itemId === row.itemId);
}

async function requireRow(db, companyId, id) {
  const [[r]] = await db.query('SELECT * FROM cf_machine_resources WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, id]);
  if (!r) throw notFound('Resource row');
  return r;
}

/** PUT /machine-resources/:id { kind?, qty?, notes? } */
export async function updateMachineResource(db, c, id, input = {}) {
  const r = await requireRow(db, c.companyId, id);
  const problems = [];
  const sets = []; const params = [];
  if (input.kind !== undefined) { if (!RESOURCE_KINDS.includes(input.kind)) problems.push('Kind is tool, spare or consumable.'); else { sets.push('kind = ?'); params.push(input.kind); } }
  if (input.qty !== undefined) { if (!(Number(input.qty) > 0)) problems.push('Quantity is a number above zero.'); else { sets.push('qty = ?'); params.push(round3(input.qty)); } }
  if (input.notes !== undefined) { sets.push('notes = ?'); params.push(blank(input.notes) ? null : String(input.notes).trim().slice(0, 255)); }
  assertNoProblems(problems);
  if (sets.length) await db.query(`UPDATE cf_machine_resources SET ${sets.join(', ')} WHERE company_id = ? AND id = ?`, [...params, c.companyId, id]);
  const all = await listMachineResources(db, c.companyId, r.machine_id);
  return all.find((x) => x.id === id);
}

/** DELETE /machine-resources/:id */
export async function removeMachineResource(db, c, id) {
  await requireRow(db, c.companyId, id);
  await db.query('UPDATE cf_machine_resources SET deleted_at = NOW() WHERE company_id = ? AND id = ?', [c.companyId, id]);
  return { id, removed: true };
}

/**
 * GET /resource-items?kind=&search=&all=&limit= — catalog items to pick from. By default the three resource
 * families (or the one named by kind); all=1 searches the whole catalog (a bearing kept under Bought out).
 */
export async function searchResourceItems(db, companyId, q = {}) {
  const where = ['r.company_id = ?', "r.record_kind = 'item'", 'r.deleted_at IS NULL', "d.item_type = 'catalog'", "r.status <> 'obsolete'"];
  const params = [companyId];
  const kind = RESOURCE_KINDS.includes(q.kind) ? q.kind : null;
  if (kind) { where.push(`${KIND_SQL} = ?`); params.push(kind); }
  else if (!(q.all === '1' || q.all === 1 || q.all === true)) where.push(`${KIND_SQL} IS NOT NULL`);
  if (!blank(q.search)) {
    const like = `%${String(q.search).trim().replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    where.push('(r.code LIKE ? OR r.name LIKE ?)');
    params.push(like, like);
  }
  const limit = Math.min(100, Math.max(1, Number(q.limit) || 30));
  const [rows] = await db.query(
    `SELECT r.id, r.code, r.name, d.uom, d.life_unit, d.life_limit, ${KIND_SQL} AS item_kind
       FROM cf_master_records r JOIN cf_item_details d ON d.company_id = r.company_id AND d.master_id = r.id
       ${KIND_JOINS}
      WHERE ${where.join(' AND ')} ORDER BY r.code LIMIT ?`, [...params, limit]);
  return rows.map((r) => ({ id: r.id, code: r.code, name: r.name, uom: r.uom, kind: r.item_kind ?? null, lifeUnit: r.life_unit ?? null, lifeLimit: r.life_limit == null ? null : Number(r.life_limit) }));
}
