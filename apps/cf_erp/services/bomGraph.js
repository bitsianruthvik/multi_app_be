/**
 * bomGraph.js — low-level BOM structure: who contains whom, and the few writes
 * other services need. It imports no other service, so values, resolution, the
 * code generator and the BOM service can all walk BOMs without an import cycle.
 *
 * A BOM belongs to one parent and lists that parent's immediate children
 * (models/init.sql §8). The kind of the parent fixes the BOM's type.
 */
import { kindOf } from './records.js';

export const BOM_TYPE_BY_KIND = { catalog: 'standard', template: 'template', temporary: 'custom' };
export const bomTypeOf = (master) => BOM_TYPE_BY_KIND[kindOf(master)] ?? null;

/** The live BOM of a parent, or null. */
export async function bomOfParent(db, companyId, parentId) {
  const [[bom]] = await db.query(
    'SELECT * FROM cf_boms WHERE company_id = ? AND parent_id = ? AND deleted_at IS NULL',
    [companyId, parentId],
  );
  return bom || null;
}

/** Live BOM headers for many parents, keyed by parent id. */
export async function bomsOfParents(db, companyId, parentIds) {
  if (!parentIds.length) return new Map();
  const [rows] = await db.query(
    'SELECT * FROM cf_boms WHERE company_id = ? AND parent_id IN (?) AND deleted_at IS NULL',
    [companyId, parentIds],
  );
  return new Map(rows.map((b) => [b.parent_id, b]));
}

const LINE_COLUMNS = `
  l.id, l.bom_id, l.line_no, l.child_id, l.design_id, l.position, l.role, l.quantity,
  l.selection_definition_id, l.source_line_id, l.notes, l.operation_flow_id,
  ch.code AS child_code, ch.name AS child_name, ch.record_kind AS child_record_kind, ch.status AS child_status,
  ci.item_type AS child_item_type, ci.uom AS child_uom, ci.tracked_by AS child_tracked_by,
  cd.definition_type AS child_definition_type,
  dz.code AS design_code, dz.name AS design_name,
  sd.code AS selection_code, sd.name AS selection_name,
  lf.code AS line_flow_code, lf.name AS line_flow_name,
  ch.default_flow_id AS child_flow_id, cf.code AS child_flow_code, cf.name AS child_flow_name,
  sdef.default_flow_id AS def_flow_id, df.code AS def_flow_code, df.name AS def_flow_name`;

const LINE_JOINS = `
  JOIN cf_master_records ch ON ch.id = l.child_id
  LEFT JOIN cf_item_details ci       ON ci.master_id = l.child_id AND ci.deleted_at IS NULL
  LEFT JOIN cf_definition_details cd ON cd.master_id = l.child_id AND cd.deleted_at IS NULL
  JOIN cf_master_records dz ON dz.id = l.design_id
  LEFT JOIN cf_master_records sd ON sd.id = l.selection_definition_id
  LEFT JOIN cf_operation_flows lf ON lf.id = l.operation_flow_id
  LEFT JOIN cf_operation_flows cf ON cf.id = ch.default_flow_id
  LEFT JOIN cf_master_records sdef ON sdef.id = ci.source_definition_id
  LEFT JOIN cf_operation_flows df ON df.id = sdef.default_flow_id`;

/** Live lines of one BOM, in line order, with what each child is. */
export async function linesOfBom(db, companyId, bomId) {
  const [rows] = await db.query(
    `SELECT ${LINE_COLUMNS} FROM cf_bom_lines l ${LINE_JOINS}
      WHERE l.company_id = ? AND l.bom_id = ? AND l.deleted_at IS NULL
      ORDER BY l.line_no, l.id`,
    [companyId, bomId],
  );
  return rows;
}

/** Live lines of many BOMs (one query per level of an explosion). */
export async function linesOfBoms(db, companyId, bomIds) {
  if (!bomIds.length) return [];
  const [rows] = await db.query(
    `SELECT ${LINE_COLUMNS} FROM cf_bom_lines l ${LINE_JOINS}
      WHERE l.company_id = ? AND l.bom_id IN (?) AND l.deleted_at IS NULL
      ORDER BY l.bom_id, l.line_no, l.id`,
    [companyId, bomIds],
  );
  return rows;
}

export async function loadLine(db, companyId, lineId) {
  const [[row]] = await db.query(
    `SELECT ${LINE_COLUMNS}, b.parent_id, b.bom_type, b.status AS bom_status
       FROM cf_bom_lines l ${LINE_JOINS}
       JOIN cf_boms b ON b.id = l.bom_id AND b.deleted_at IS NULL
      WHERE l.company_id = ? AND l.id = ? AND l.deleted_at IS NULL`,
    [companyId, lineId],
  );
  return row || null;
}

/**
 * How the child of a line is made: the flow the line names (the child in THIS
 * parent), else the child's own default, else — for a temporary item — its
 * template's. A selection line never names one: once its catalog item is
 * chosen, that item's default applies. Null for things with no flow.
 */
export function effectiveFlowOf(line) {
  if (line.operation_flow_id) return { id: line.operation_flow_id, code: line.line_flow_code, name: line.line_flow_name, from: 'line' };
  if (line.child_flow_id) return { id: line.child_flow_id, code: line.child_flow_code, name: line.child_flow_name, from: 'item' };
  if (line.def_flow_id) return { id: line.def_flow_id, code: line.def_flow_code, name: line.def_flow_name, from: 'template' };
  return null;
}

/** catalog | temporary | template | selection for a line's child. */
export const childKindOf = (line) => (line.child_record_kind === 'item' ? line.child_item_type : line.child_definition_type);

/** Parents whose live BOMs contain any of these children. */
export async function parentsOf(db, companyId, childIds) {
  if (!childIds.length) return [];
  const [rows] = await db.query(
    `SELECT DISTINCT b.parent_id FROM cf_bom_lines l
       JOIN cf_boms b ON b.id = l.bom_id AND b.deleted_at IS NULL
      WHERE l.company_id = ? AND l.child_id IN (?) AND l.deleted_at IS NULL`,
    [companyId, childIds],
  );
  return rows.map((r) => r.parent_id);
}

/** Temporary items directly under these parents — the ones that can inherit from them. */
export async function tempChildrenOf(db, companyId, parentIds) {
  if (!parentIds.length) return [];
  const [rows] = await db.query(
    `SELECT DISTINCT l.child_id FROM cf_boms b
       JOIN cf_bom_lines l ON l.bom_id = b.id AND l.deleted_at IS NULL
       JOIN cf_item_details i ON i.master_id = l.child_id AND i.item_type = 'temporary' AND i.deleted_at IS NULL
      WHERE b.company_id = ? AND b.parent_id IN (?) AND b.deleted_at IS NULL`,
    [companyId, parentIds],
  );
  return rows.map((r) => r.child_id);
}

/**
 * Where a temporary item sits: the Custom BOM line that holds it and its parent.
 * Null for the item a sales order line sells (it has no BOM parent).
 */
export async function placementOf(db, companyId, itemId) {
  const [[row]] = await db.query(
    `SELECT l.id AS line_id, l.bom_id, l.line_no, l.position, l.quantity, l.role, b.parent_id,
            p.code AS parent_code, p.name AS parent_name
       FROM cf_bom_lines l
       JOIN cf_boms b ON b.id = l.bom_id AND b.deleted_at IS NULL AND b.bom_type = 'custom'
       JOIN cf_master_records p ON p.id = b.parent_id AND p.deleted_at IS NULL
      WHERE l.company_id = ? AND l.child_id = ? AND l.deleted_at IS NULL
      LIMIT 1`,
    [companyId, itemId],
  );
  return row || null;
}

/**
 * Everything below a record, following BOMs down. Used to refuse loops: a
 * parent may not become its own descendant. Depth-capped as a guard against
 * data written before the check existed.
 */
export async function descendantIds(db, companyId, rootId, maxDepth = 25) {
  const seen = new Set();
  let frontier = [rootId];
  for (let depth = 0; frontier.length && depth < maxDepth; depth++) {
    const [rows] = await db.query(
      `SELECT DISTINCT l.child_id FROM cf_boms b
         JOIN cf_bom_lines l ON l.bom_id = b.id AND l.deleted_at IS NULL
        WHERE b.company_id = ? AND b.parent_id IN (?) AND b.deleted_at IS NULL`,
      [companyId, frontier],
    );
    frontier = rows.map((r) => r.child_id).filter((id) => !seen.has(id));
    frontier.forEach((id) => seen.add(id));
  }
  return seen;
}

/**
 * The BOM children a roll-up reads: one entry per line, with the child's own
 * stored values for the given spec codes. A line whose child is still a
 * selection (no catalog item chosen) has no values — the roll-up waits for it.
 */
export async function rollupChildren(db, companyId, parentId, specCodes) {
  const bom = await bomOfParent(db, companyId, parentId);
  if (!bom) return null;
  const lines = await linesOfBom(db, companyId, bom.id);
  if (!lines.length) return [];
  const itemIds = lines.filter((l) => l.child_record_kind === 'item').map((l) => l.child_id);
  const values = new Map(itemIds.map((id) => [id, new Map()]));
  if (itemIds.length && specCodes.length) {
    const [rows] = await db.query(
      `SELECT v.subject_id, s.code, v.value_number FROM cf_spec_values v
         JOIN cf_specifications s ON s.id = v.specification_id AND s.deleted_at IS NULL
        WHERE v.company_id = ? AND v.subject_type = 'master' AND v.subject_id IN (?) AND v.deleted_at IS NULL
          AND s.code IN (?)`,
      [companyId, itemIds, specCodes],
    );
    for (const r of rows) if (r.value_number != null) values.get(r.subject_id).set(r.code.toUpperCase(), Number(r.value_number));
  }
  return lines.map((l) => {
    const isItem = l.child_record_kind === 'item';
    const own = values.get(l.child_id);
    return {
      lineId: l.id,
      label: isItem ? (l.child_code ?? l.child_name) : `${l.child_code ?? l.child_name} (not chosen yet)`,
      quantity: Number(l.quantity),
      get: (code) => (isItem ? own.get(code) ?? null : null),
    };
  });
}

/** A record's own stored value rows for some specifications, keyed by spec id. */
export async function storedValues(db, companyId, masterId, specIds) {
  if (!specIds.length) return new Map();
  const [rows] = await db.query(
    `SELECT * FROM cf_spec_values
      WHERE company_id = ? AND subject_type = 'master' AND subject_id = ? AND specification_id IN (?) AND deleted_at IS NULL`,
    [companyId, masterId, specIds],
  );
  return new Map(rows.map((r) => [r.specification_id, r]));
}

// --- writes other services need ----------------------------------------------

/** Creates the BOM header for a parent. The caller has checked the parent may have one. */
export async function createBom(db, c, { parentId, bomType, sourceBomId = null, status = 'draft' }) {
  const [r] = await db.query(
    `INSERT INTO cf_boms (company_id, parent_id, bom_type, status, source_bom_id, created_by)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [c.companyId, parentId, bomType, status, sourceBomId, c.userId],
  );
  const [[bom]] = await db.query('SELECT * FROM cf_boms WHERE id = ?', [r.insertId]);
  return bom;
}

export async function insertLine(db, c, l) {
  const [r] = await db.query(
    `INSERT INTO cf_bom_lines
       (company_id, bom_id, line_no, child_id, design_id, position, role, quantity, selection_definition_id, source_line_id, operation_flow_id, notes, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [c.companyId, l.bomId, l.lineNo, l.childId, l.designId, l.position, l.role ?? null, l.quantity,
      l.selectionDefinitionId ?? null, l.sourceLineId ?? null, l.operationFlowId ?? null, l.notes ?? null, c.userId],
  );
  return r.insertId;
}

/** Next line number: 10 past the highest live one. */
export async function nextLineNo(db, companyId, bomId) {
  const [[{ top }]] = await db.query(
    'SELECT MAX(line_no) AS top FROM cf_bom_lines WHERE company_id = ? AND bom_id = ? AND deleted_at IS NULL',
    [companyId, bomId],
  );
  return (Number(top) || 0) + 10;
}

/** Next position for a design within a BOM — counts deleted lines too, so a number is never reused. */
export async function nextPosition(db, companyId, bomId, designId) {
  const [[{ top }]] = await db.query(
    'SELECT MAX(position) AS top FROM cf_bom_lines WHERE company_id = ? AND bom_id = ? AND design_id = ?',
    [companyId, bomId, designId],
  );
  return (Number(top) || 0) + 1;
}

/** Soft-deletes a BOM and its lines (a catalog item or template being deleted). */
export async function deleteBomOf(db, c, parentId) {
  const bom = await bomOfParent(db, c.companyId, parentId);
  if (!bom) return 0;
  await db.query('UPDATE cf_bom_lines SET deleted_at = NOW() WHERE company_id = ? AND bom_id = ? AND deleted_at IS NULL', [c.companyId, bom.id]);
  await db.query('UPDATE cf_boms SET deleted_at = NOW() WHERE company_id = ? AND id = ?', [c.companyId, bom.id]);
  return 1;
}
