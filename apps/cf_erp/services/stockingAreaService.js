/**
 * stockingAreaService.js — stocking areas, each holding an inventory (decided
 * 2026-09-22). An area's purpose decides what its stock counts as: storage is
 * available to use, wip is in process, quarantine is held, dispatch is
 * finished and waiting to leave.
 */
import { conflict, notFound, assertNoProblems } from '../lib/errors.js';
import { loadMachine } from './records.js';

export const PURPOSES = ['storage', 'wip', 'quarantine', 'dispatch'];
const CODE_RE = /^[A-Za-z0-9][A-Za-z0-9_\-./]*$/;
const blank = (v) => v == null || String(v).trim() === '';

const SELECT = `SELECT a.*, mc.code AS machine_code, mc.name AS machine_name,
       (SELECT COUNT(DISTINCT b.item_id) FROM cf_stock_balances b WHERE b.company_id = a.company_id AND b.stocking_area_id = a.id AND b.quantity <> 0) AS item_count,
       (SELECT COUNT(*) FROM cf_stock_balances b WHERE b.company_id = a.company_id AND b.stocking_area_id = a.id AND b.quantity <> 0) AS line_count
  FROM cf_stocking_areas a
  LEFT JOIN cf_machines mc ON mc.id = a.machine_id AND mc.deleted_at IS NULL`;

export function shapeArea(a) {
  return {
    id: a.id,
    code: a.code,
    name: a.name,
    purpose: a.purpose,
    machine: a.machine_id && a.machine_code ? { id: a.machine_id, code: a.machine_code, name: a.machine_name } : null,
    status: a.status,
    notes: a.notes,
    itemCount: a.item_count == null ? undefined : Number(a.item_count),
    lineCount: a.line_count == null ? undefined : Number(a.line_count),
    createdAt: a.created_at,
    updatedAt: a.updated_at,
  };
}

export async function listAreas(db, companyId, q = {}) {
  const where = ['a.company_id = ?', 'a.deleted_at IS NULL'];
  const params = [companyId];
  if (!blank(q.status)) { where.push('a.status = ?'); params.push(q.status); }
  if (!blank(q.purpose)) { where.push('a.purpose = ?'); params.push(q.purpose); }
  const [rows] = await db.query(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY a.code`, params);
  return rows.map(shapeArea);
}

export async function requireArea(db, companyId, id, what = 'Stocking area') {
  const [[row]] = await db.query(`${SELECT} WHERE a.company_id = ? AND a.id = ? AND a.deleted_at IS NULL`, [companyId, Number(id)]);
  if (!row) throw notFound(what);
  return row;
}

async function readArea(db, companyId, input, problems, partial) {
  const out = {};
  if (!partial || input.code !== undefined) {
    const code = String(input.code ?? '').trim();
    if (!code || !CODE_RE.test(code) || code.length > 50) problems.push('Code: up to 50 letters, digits and - _ . /, no spaces.');
    out.code = code;
  }
  if (!partial || input.name !== undefined) {
    const name = String(input.name ?? '').trim();
    if (!name || name.length > 255) problems.push('Name is required (up to 255 characters).');
    out.name = name;
  }
  if (input.purpose !== undefined || !partial) {
    const purpose = input.purpose ?? 'storage';
    if (!PURPOSES.includes(purpose)) problems.push('Purpose is storage, wip, quarantine or dispatch.');
    out.purpose = purpose;
  }
  if (input.machineId !== undefined) {
    if (blank(input.machineId)) out.machine_id = null;
    else {
      const m = await loadMachine(db, companyId, Number(input.machineId));
      if (!m) problems.push('That machine does not exist.');
      else out.machine_id = m.id;
    }
  }
  if (input.status !== undefined) {
    if (!['active', 'inactive'].includes(input.status)) problems.push('Status is active or inactive.');
    out.status = input.status;
  }
  if (input.notes !== undefined) out.notes = blank(input.notes) ? null : String(input.notes);
  return out;
}

/** input: { code, name, purpose?, machineId?, notes? } */
export async function createArea(db, c, input = {}) {
  const problems = [];
  const f = await readArea(db, c.companyId, input, problems, false);
  assertNoProblems(problems);
  const [r] = await db.query(
    'INSERT INTO cf_stocking_areas (company_id, code, name, purpose, machine_id, notes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [c.companyId, f.code, f.name, f.purpose, f.machine_id ?? null, f.notes ?? null, c.userId],
  );
  return shapeArea(await requireArea(db, c.companyId, r.insertId));
}

export async function updateArea(db, c, id, input = {}) {
  await requireArea(db, c.companyId, id);
  const problems = [];
  const f = await readArea(db, c.companyId, input, problems, true);
  assertNoProblems(problems);
  if (Object.keys(f).length) {
    await db.query(`UPDATE cf_stocking_areas SET ${Object.keys(f).map((k) => `${k} = ?`).join(', ')} WHERE company_id = ? AND id = ?`,
      [...Object.values(f), c.companyId, id]);
  }
  return shapeArea(await requireArea(db, c.companyId, id));
}

/** Only an area that never held stock can go; one with history is made inactive instead. */
export async function deleteArea(db, c, id) {
  const a = await requireArea(db, c.companyId, id);
  const [[{ n }]] = await db.query('SELECT COUNT(*) AS n FROM cf_stock_ledger WHERE company_id = ? AND stocking_area_id = ?', [c.companyId, id]);
  if (Number(n)) throw conflict('IN_USE', `${a.code} has stock history (${n} ledger row${Number(n) === 1 ? '' : 's'}) — mark it inactive instead.`);
  await db.query('UPDATE cf_stocking_areas SET deleted_at = NOW() WHERE company_id = ? AND id = ?', [c.companyId, id]);
  return { ok: true };
}
