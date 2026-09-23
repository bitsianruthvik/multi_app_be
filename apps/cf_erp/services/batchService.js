/**
 * batchService.js — batches of batch-tracked items: one delivery lot (a heat
 * of plate). A batch carries batch-level specifications (HEAT_NO) as values on
 * itself; required ones are entered before its receipt can post. Its code is
 * typed, or comes from a coding rule for batches, or falls back to B000123.
 *
 * Status is a quality state: available, on hold (not issued until released),
 * rejected (only scrapped or moved).
 */
import { invalid, notFound, assertNoProblems } from '../lib/errors.js';
import { loadMaster } from './records.js';
import { resolveBatch, publicResolution } from './resolutionService.js';
import { loadSpecs, coerce, upsertValue, getHistory } from './valueService.js';
import { draftValueMap } from './drafts.js';
import { generate } from '../modules/codegen/index.js';

export const BATCH_STATUSES = ['available', 'on_hold', 'rejected'];
const CODE_RE = /^[A-Za-z0-9][A-Za-z0-9_\-./]*$/;
const blank = (v) => v == null || String(v).trim() === '';
const dateOnly = (d) => (d instanceof Date ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : d ?? null);

const SELECT = `SELECT b.*, m.code AS item_code, m.name AS item_name, i.uom AS item_uom, p.code AS supplier_code, p.name AS supplier_name,
       (SELECT COALESCE(SUM(k.quantity), 0) FROM cf_stock_balances k WHERE k.company_id = b.company_id AND k.batch_id = b.id) AS on_hand
  FROM cf_stock_batches b
  JOIN cf_master_records m ON m.id = b.item_id
  JOIN cf_item_details i ON i.master_id = b.item_id
  LEFT JOIN cf_parties p ON p.id = b.supplier_id`;

export function shapeBatch(b) {
  return {
    id: b.id,
    code: b.code,
    item: { id: b.item_id, code: b.item_code, name: b.item_name, uom: b.item_uom },
    status: b.status,
    statusNote: b.status_note,
    receivedOn: dateOnly(b.received_on),
    supplier: b.supplier_id ? { id: b.supplier_id, code: b.supplier_code, name: b.supplier_name } : null,
    supplierRef: b.supplier_ref,
    notes: b.notes,
    onHand: b.on_hand == null ? undefined : Number(b.on_hand),
    createdAt: b.created_at,
  };
}

export async function requireBatch(db, companyId, id) {
  const [[row]] = await db.query(`${SELECT} WHERE b.company_id = ? AND b.id = ? AND b.deleted_at IS NULL`, [companyId, Number(id)]);
  if (!row) throw notFound('Batch');
  return row;
}

export async function listBatches(db, companyId, q = {}) {
  const where = ['b.company_id = ?', 'b.deleted_at IS NULL'];
  const params = [companyId];
  if (!blank(q.itemId)) { where.push('b.item_id = ?'); params.push(Number(q.itemId)); }
  if (!blank(q.status)) { where.push('b.status = ?'); params.push(q.status); }
  if (!blank(q.search)) {
    const like = `%${String(q.search).trim().replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    where.push('(b.code LIKE ? OR b.supplier_ref LIKE ? OR m.code LIKE ? OR m.name LIKE ?)');
    params.push(like, like, like, like);
  }
  const having = String(q.inStock) === '1' ? 'HAVING on_hand <> 0' : '';
  const [rows] = await db.query(`${SELECT} WHERE ${where.join(' AND ')} ${having} ORDER BY b.id DESC LIMIT 500`, params);
  return rows.map(shapeBatch);
}

/** The batch-level rules of an item, as a receipt form needs them (no batch yet). */
export async function batchTemplate(db, companyId, itemId) {
  const item = await loadMaster(db, companyId, Number(itemId));
  if (!item || item.record_kind !== 'item') throw notFound('Item');
  return publicResolution(await resolveBatch(db, companyId, { item }));
}

/**
 * What a new batch would record, checked without writing anything: required
 * values missing, a value of the wrong type, a spec not recorded per batch.
 */
export async function checkBatchValues(db, companyId, item, entries = []) {
  const draft = await draftValueMap(db, companyId, entries);
  const r = await resolveBatch(db, companyId, { item, draftValues: draft });
  const problems = [];
  const allowed = new Set(r.specs.filter((s) => s.applicable && s.rule.valueRule === 'entered').map((s) => s.spec.id));
  const { byId, byCode } = await loadSpecs(db, companyId, entries);
  for (const e of entries) {
    const spec = e.specificationId != null ? byId.get(Number(e.specificationId)) : byCode.get(String(e.specCode ?? '').toUpperCase());
    if (!spec) { problems.push(`Unknown specification ${e.specCode ?? e.specificationId}.`); continue; }
    if (blank(e.value)) continue;
    if (!allowed.has(spec.id)) { problems.push(`${spec.code} is not recorded per batch of ${item.code ?? item.name}.`); continue; }
    const out = await coerce(db, companyId, spec, e.value);
    if (out.problem) problems.push(out.problem);
  }
  for (const m of r.missingRequired) problems.push(`${m.name} (${m.code}) is required for every batch of ${item.code ?? item.name}.`);
  return problems;
}

/** Writes a batch's entered values (with history) and stores its calculated ones. */
async function writeBatchValues(db, c, batchId, item, entries) {
  const r = await resolveBatch(db, c.companyId, { item, batchId });
  const rules = new Map(r.specs.filter((s) => s.applicable).map((s) => [s.spec.id, s]));
  const { byId, byCode } = await loadSpecs(db, c.companyId, entries);
  const problems = [];
  const writes = [];
  for (const e of entries) {
    const spec = e.specificationId != null ? byId.get(Number(e.specificationId)) : byCode.get(String(e.specCode ?? '').toUpperCase());
    if (!spec) { problems.push(`Unknown specification ${e.specCode ?? e.specificationId}.`); continue; }
    const rule = rules.get(spec.id);
    if (!rule) { problems.push(`${spec.code} is not recorded per batch of ${item.code ?? item.name}.`); continue; }
    if (rule.rule.valueRule !== 'entered') { problems.push(`${spec.code} is calculated — it cannot be typed in.`); continue; }
    const out = await coerce(db, c.companyId, spec, e.value, rule.options ? new Set(rule.options.map((o) => o.id)) : null);
    if (out.problem) problems.push(out.problem);
    else writes.push({ spec, typed: out.typed });
  }
  if (problems.length) throw invalid('INVALID_VALUES', 'Some batch values could not be saved.', { problems });
  for (const w of writes) await upsertValue(db, c, w.spec, 'batch', batchId, w.typed, 'entered');
  // Calculated batch values are stored too, so reports can read them.
  const after = await resolveBatch(db, c.companyId, { item, batchId });
  const calculated = after.specs.filter((s) => s.rule.valueRule === 'calculated' && s.value);
  if (calculated.length) {
    const { byId: specs } = await loadSpecs(db, c.companyId, calculated.map((s) => ({ specificationId: s.spec.id })));
    for (const s of calculated) {
      await upsertValue(db, c, specs.get(s.spec.id), 'batch', batchId,
        { value_number: s.value.raw, value_text: null, value_bool: null, value_date: null, option_id: null }, 'calculated');
    }
  }
}

/**
 * Creates a batch inside a receipt. input: { code?, supplierId?, supplierRef?, receivedOn?, values? }.
 * The caller has already checked the values (checkBatchValues).
 */
export async function createBatch(db, c, item, input = {}) {
  const problems = [];
  let code = blank(input.code) ? null : String(input.code).trim();
  if (code && (!CODE_RE.test(code) || code.length > 60)) problems.push('Batch code: up to 60 letters, digits and - _ . /, no spaces.');
  const supplierRef = blank(input.supplierRef) ? null : String(input.supplierRef).trim().slice(0, 100);
  assertNoProblems(problems);
  if (!code) {
    const g = await generate(db, c.companyId, 'stock_batch', 'code',
      { draft: { itemId: item.id, supplierId: input.supplierId ?? null, values: input.values ?? [] } }, { consume: true });
    code = g?.text ?? null;
  }
  const [r] = await db.query(
    `INSERT INTO cf_stock_batches (company_id, item_id, code, received_on, supplier_id, supplier_ref, production_item_id, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [c.companyId, item.id, code, input.receivedOn ?? null, input.supplierId ?? null, supplierRef, input.productionItemId ?? null, c.userId],
  );
  if (!code) await db.query('UPDATE cf_stock_batches SET code = ? WHERE id = ?', [`B${String(r.insertId).padStart(6, '0')}`, r.insertId]);
  const values = (input.values ?? []).filter((v) => !blank(v.value));
  if (values.length) await writeBatchValues(db, c, r.insertId, item, values);
  return r.insertId;
}

export async function getBatch(db, companyId, id) {
  const b = await requireBatch(db, companyId, id);
  const item = await loadMaster(db, companyId, b.item_id);
  const out = shapeBatch(b);
  out.specs = publicResolution(await resolveBatch(db, companyId, { item, batchId: b.id }));
  const [where] = await db.query(
    `SELECT k.stocking_area_id, k.quantity, a.code AS area_code, a.name AS area_name, a.purpose
       FROM cf_stock_balances k JOIN cf_stocking_areas a ON a.id = k.stocking_area_id
      WHERE k.company_id = ? AND k.batch_id = ? AND k.quantity <> 0 ORDER BY a.code`,
    [companyId, b.id],
  );
  out.locations = where.map((w) => ({ area: { id: w.stocking_area_id, code: w.area_code, name: w.area_name, purpose: w.purpose }, quantity: Number(w.quantity) }));
  return out;
}

export async function updateBatch(db, c, id, input = {}) {
  await requireBatch(db, c.companyId, id);
  if (input.code !== undefined) throw invalid('IDENTITY', 'A batch code is permanent — documents and labels carry it.');
  const sets = {};
  if (input.supplierRef !== undefined) sets.supplier_ref = blank(input.supplierRef) ? null : String(input.supplierRef).trim().slice(0, 100);
  if (input.notes !== undefined) sets.notes = blank(input.notes) ? null : String(input.notes);
  if (Object.keys(sets).length) {
    await db.query(`UPDATE cf_stock_batches SET ${Object.keys(sets).map((k) => `${k} = ?`).join(', ')} WHERE company_id = ? AND id = ?`,
      [...Object.values(sets), c.companyId, id]);
  }
  return getBatch(db, c.companyId, id);
}

/** Puts a batch on hold, releases it, or rejects it — with a note saying why. */
export async function setBatchStatus(db, c, id, { status, note } = {}) {
  const b = await requireBatch(db, c.companyId, id);
  if (!BATCH_STATUSES.includes(status)) throw invalid('INVALID', 'Status is available, on_hold or rejected.');
  if (status !== 'available' && blank(note)) throw invalid('INVALID', 'Say why — the note travels with the batch.');
  if (b.status !== status) {
    await db.query('UPDATE cf_stock_batches SET status = ?, status_note = ? WHERE company_id = ? AND id = ?',
      [status, blank(note) ? null : String(note).trim().slice(0, 255), c.companyId, id]);
  }
  return getBatch(db, c.companyId, id);
}

export async function setBatchValues(db, c, id, entries = []) {
  const b = await requireBatch(db, c.companyId, id);
  const item = await loadMaster(db, c.companyId, b.item_id);
  await writeBatchValues(db, c, b.id, item, entries);
  return getBatch(db, c.companyId, id);
}

export const getBatchHistory = (db, companyId, id, limit) => getHistory(db, companyId, 'batch', id, limit);
