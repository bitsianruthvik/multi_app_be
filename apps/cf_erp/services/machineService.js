/**
 * machineService.js — machines: their own master (decided 2026-09-22), each on
 * a machine type — a leaf of the shared classification tree.
 *
 * A machine is described by the same specification engine as items: rules on
 * its machine type say what it must carry (CUTTING_SPEED, MAX_THICKNESS), fixed
 * and default values flow down from the type, and the machine holds its own
 * where it differs. Timing formulas read those values as machine.<SPEC>, so one
 * operation rule gives every machine its own time.
 *
 * The code is typed, or comes from a coding rule for machines.
 */
import { invalid, notFound, assertNoProblems } from '../lib/errors.js';
import { ancestors, levelName, subtreeIds } from './tree.js';
import { loadMaster, requireMachine } from './records.js';
import { requireMachineType } from './classificationService.js';
import { resolve, publicResolution } from './resolutionService.js';
import { materializeMachine, setValues, deleteAllForSubject as deleteValues, getHistory } from './valueService.js';
import { deleteAllForSubject as deleteRules } from './assignmentService.js';
import { generate } from '../modules/codegen/index.js';
import { operationsForMachine } from './operationService.js';

const CODE_RE = /^[A-Za-z0-9][A-Za-z0-9_\-./]*$/;
const blank = (v) => v == null || String(v).trim() === '';

function shape(m) {
  return {
    id: m.id,
    code: m.code,
    name: m.name,
    classificationId: m.classification_id,
    classificationCode: m.classification_code ?? undefined,
    classificationName: m.classification_name ?? undefined,
    catalogItem: m.catalog_item_id ? { id: m.catalog_item_id, code: m.catalog_code ?? null, name: m.catalog_name ?? null } : null,
    serialNumber: m.serial_number,
    status: m.status,
    notes: m.notes,
    createdAt: m.created_at,
    updatedAt: m.updated_at,
  };
}

const SELECT = `SELECT mc.*, n.code AS classification_code, n.name AS classification_name, ci.code AS catalog_code, ci.name AS catalog_name
    FROM cf_machines mc
    JOIN cf_classification_nodes n ON n.id = mc.classification_id
    LEFT JOIN cf_master_records ci ON ci.id = mc.catalog_item_id`;

export async function listMachines(db, companyId, q = {}) {
  const where = ['mc.company_id = ?', 'mc.deleted_at IS NULL'];
  const params = [companyId];
  if (!blank(q.status)) { where.push('mc.status = ?'); params.push(q.status); }
  if (!blank(q.classificationId)) { where.push('mc.classification_id IN (?)'); params.push(await subtreeIds(db, companyId, Number(q.classificationId))); }
  if (!blank(q.search)) {
    const like = `%${String(q.search).trim().replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    where.push('(mc.code LIKE ? OR mc.name LIKE ? OR mc.serial_number LIKE ?)');
    params.push(like, like, like);
  }
  const [rows] = await db.query(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY mc.code LIMIT 500`, params);
  return rows.map(shape);
}

async function loadShaped(db, companyId, id) {
  const [[row]] = await db.query(`${SELECT} WHERE mc.company_id = ? AND mc.id = ? AND mc.deleted_at IS NULL`, [companyId, id]);
  if (!row) throw notFound('Machine');
  return row;
}

export async function getMachine(db, companyId, id) {
  const m = await loadShaped(db, companyId, id);
  const out = shape(m);
  const path = await ancestors(db, companyId, m.classification_id);
  out.classificationPath = path.map((n) => ({ id: n.id, code: n.code, name: n.name, level: levelName(n.depth) }));
  out.operations = await operationsForMachine(db, companyId, m);
  return out;
}

async function readCatalogItem(db, companyId, raw, problems) {
  if (blank(raw)) return null;
  const item = await loadMaster(db, companyId, Number(raw));
  if (!item || item.record_kind !== 'item' || item.item_type !== 'catalog') { problems.push('What it was bought as must be a catalog item.'); return null; }
  return item.id;
}

function readText(value, label, max, problems) {
  if (blank(value)) return null;
  const s = String(value).trim();
  if (s.length > max) problems.push(`${label} is up to ${max} characters.`);
  return s;
}

/** input: { code?, name, classificationId, catalogItemId?, serialNumber?, notes?, status? } */
export async function createMachine(db, c, input = {}) {
  const problems = [];
  const name = readText(input.name, 'Name', 255, problems);
  if (!name) problems.push('Give the machine a name.');
  let classificationId = null;
  try { classificationId = (await requireMachineType(db, c.companyId, input.classificationId)).id; } catch (e) { problems.push(e.message); }
  const catalogItemId = await readCatalogItem(db, c.companyId, input.catalogItemId, problems);
  const serialNumber = readText(input.serialNumber, 'Serial number', 100, problems);
  const status = input.status ?? 'active';
  if (!['active', 'inactive'].includes(status)) problems.push('Status is active or inactive.');
  let code = blank(input.code) ? null : String(input.code).trim();
  if (code && (!CODE_RE.test(code) || code.length > 50)) problems.push('Code: up to 50 letters, digits and - _ . /, no spaces.');
  assertNoProblems(problems);
  if (!code) {
    const g = await generate(db, c.companyId, 'machine', 'code', { draft: { classificationId } }, { consume: true });
    code = g?.text ?? null;
    if (!code) throw invalid('CODE_REQUIRED', 'Type a machine code, or add a coding rule for machines under Coding rules.');
  }
  const [r] = await db.query(
    `INSERT INTO cf_machines (company_id, code, name, classification_id, catalog_item_id, serial_number, status, notes, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [c.companyId, code, name, classificationId, catalogItemId, serialNumber, status, blank(input.notes) ? null : String(input.notes), c.userId],
  );
  // Fixed and default values from its machine type land on it straight away.
  await materializeMachine(db, c, r.insertId);
  if (Array.isArray(input.values) && input.values.length) await setValues(db, c, 'machine', r.insertId, input.values);
  return getMachine(db, c.companyId, r.insertId);
}

export async function updateMachine(db, c, id, input = {}) {
  const m = await requireMachine(db, c.companyId, id);
  const problems = [];
  const sets = {};
  if (input.name !== undefined) { sets.name = readText(input.name, 'Name', 255, problems); if (!sets.name) problems.push('Give the machine a name.'); }
  if (input.code !== undefined) {
    const code = String(input.code ?? '').trim();
    if (!code || !CODE_RE.test(code) || code.length > 50) problems.push('Code: up to 50 letters, digits and - _ . /, no spaces.');
    sets.code = code;
  }
  let moved = false;
  if (input.classificationId !== undefined && Number(input.classificationId) !== m.classification_id) {
    try { sets.classification_id = (await requireMachineType(db, c.companyId, input.classificationId)).id; moved = true; } catch (e) { problems.push(e.message); }
  }
  if (input.catalogItemId !== undefined) sets.catalog_item_id = await readCatalogItem(db, c.companyId, input.catalogItemId, problems);
  if (input.serialNumber !== undefined) sets.serial_number = readText(input.serialNumber, 'Serial number', 100, problems);
  if (input.notes !== undefined) sets.notes = blank(input.notes) ? null : String(input.notes);
  if (input.status !== undefined) {
    if (!['active', 'inactive'].includes(input.status)) problems.push('Status is active or inactive.');
    sets.status = input.status;
  }
  assertNoProblems(problems);
  if (Object.keys(sets).length) {
    await db.query(`UPDATE cf_machines SET ${Object.keys(sets).map((k) => `${k} = ?`).join(', ')} WHERE company_id = ? AND id = ?`,
      [...Object.values(sets), c.companyId, id]);
  }
  // A new machine type brings new rules and defaults.
  if (moved) await materializeMachine(db, c, id);
  return getMachine(db, c.companyId, id);
}

/**
 * Deletes a machine with its own settings: values (with history), spec rules,
 * operation rules made for it alone, and its shifts. Once production records name
 * machines, a machine that has worked will be refused and marked inactive.
 */
export async function deleteMachine(db, c, id) {
  await requireMachine(db, c.companyId, id);
  await deleteValues(db, c, 'machine', id);
  await deleteRules(db, c, 'machine', id);
  await db.query(
    "UPDATE cf_operation_machine_rules SET deleted_at = NOW() WHERE company_id = ? AND subject_type = 'machine' AND subject_id = ? AND deleted_at IS NULL",
    [c.companyId, id],
  );
  // Its shifts and day exceptions go with it; a WIP area beside it stays, no longer tied to it.
  await db.query('UPDATE cf_machine_calendar_exceptions SET deleted_at = NOW() WHERE company_id = ? AND machine_id = ? AND deleted_at IS NULL', [c.companyId, id]);
  await db.query('UPDATE cf_machine_shifts SET deleted_at = NOW() WHERE company_id = ? AND machine_id = ? AND deleted_at IS NULL', [c.companyId, id]);
  await db.query('UPDATE cf_stocking_areas SET machine_id = NULL WHERE company_id = ? AND machine_id = ?', [c.companyId, id]);
  await db.query('UPDATE cf_machines SET deleted_at = NOW() WHERE company_id = ? AND id = ?', [c.companyId, id]);
  return { ok: true };
}

export async function getMachineSpecs(db, companyId, id) {
  const machine = await requireMachine(db, companyId, id);
  return publicResolution(await resolve(db, companyId, { machine }));
}

export async function setMachineValues(db, c, id, values) {
  const result = await setValues(db, c, 'machine', id, values);
  return { ...result, specs: await getMachineSpecs(db, c.companyId, id) };
}

export const getMachineHistory = (db, companyId, id, limit) => getHistory(db, companyId, 'machine', id, limit);
