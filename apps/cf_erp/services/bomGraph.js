/**
 * bomGraph.js — low-level BOM structure: who contains whom, and the few writes
 * other services need. It imports no other service, so values, resolution, the
 * code generator and the BOM service can all walk BOMs without an import cycle.
 *
 * A BOM belongs to one parent and lists that parent's immediate children
 * (models/init.sql §8). The kind of the parent fixes the BOM's type.
 */
import { kindOf } from './records.js';
import { levelName } from './tree.js';

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
  l.selection_definition_id, l.source_line_id, l.notes, l.operation_flow_id, l.auto_chosen,
  ch.code AS child_code, ch.short_name AS child_short_name, ch.name AS child_name, ch.record_kind AS child_record_kind, ch.status AS child_status,
  ci.item_type AS child_item_type, ci.uom AS child_uom, ci.tracked_by AS child_tracked_by,
  cd.definition_type AS child_definition_type,
  dz.code AS design_code, dz.short_name AS design_short_name, dz.name AS design_name,
  sd.code AS selection_code, sd.short_name AS selection_short_name, sd.name AS selection_name,
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

/**
 * linesOfBoms with each child's own live BOM header beside it (cb_id …; NULL
 * when it has none) — one query per level of an explosion instead of two. A
 * parent has at most ONE live BOM (uq_cbm_parent), so the join never repeats a line.
 */
export async function linesOfBomsWithChildBom(db, companyId, bomIds) {
  if (!bomIds.length) return [];
  const [rows] = await db.query(
    `SELECT ${LINE_COLUMNS}, cb.id AS cb_id, cb.bom_type AS cb_bom_type, cb.status AS cb_status, cb.revision AS cb_revision
       FROM cf_bom_lines l ${LINE_JOINS}
       LEFT JOIN cf_boms cb ON cb.company_id = l.company_id AND cb.parent_id = l.child_id AND cb.deleted_at IS NULL
      WHERE l.company_id = ? AND l.bom_id IN (?) AND l.deleted_at IS NULL
      ORDER BY l.bom_id, l.line_no, l.id`,
    [companyId, bomIds],
  );
  return rows;
}

/**
 * linesOfBomsWithChildBom for EVERY level under a parent at once (speed, 2026-10-19):
 * the parent's live BOM, and below it every BOM a line's child has, down to
 * `maxDepth` levels — one round trip where a level-by-level walk took one per
 * level (KEPL: 5). Same columns and order (bom_id, line_no, id) as the
 * per-level read, so a walk over its rows level by level sees what that read
 * would have given it. The recursion follows the same live rows and inner
 * joins (child and design records) as the line read itself; a BOM reached at
 * several depths is listed once.
 */
export async function linesUnderParent(db, companyId, parentId, maxDepth = 15) {
  const [rows] = await db.query(
    `WITH RECURSIVE walk (bom_id, depth) AS (
       SELECT b.id, CAST(1 AS SIGNED) FROM cf_boms b WHERE b.company_id = ? AND b.parent_id = ? AND b.deleted_at IS NULL
       UNION
       SELECT cb.id, w.depth + 1 FROM walk w
         JOIN cf_bom_lines wl ON wl.company_id = ? AND wl.bom_id = w.bom_id AND wl.deleted_at IS NULL
         JOIN cf_master_records wc ON wc.id = wl.child_id
         JOIN cf_master_records wd ON wd.id = wl.design_id
         JOIN cf_boms cb ON cb.company_id = wl.company_id AND cb.parent_id = wl.child_id AND cb.deleted_at IS NULL
        WHERE w.depth < ?
     )
     SELECT ${LINE_COLUMNS}, cb.id AS cb_id, cb.bom_type AS cb_bom_type, cb.status AS cb_status, cb.revision AS cb_revision
       FROM cf_bom_lines l ${LINE_JOINS}
       LEFT JOIN cf_boms cb ON cb.company_id = l.company_id AND cb.parent_id = l.child_id AND cb.deleted_at IS NULL
      WHERE l.company_id = ? AND l.bom_id IN (SELECT DISTINCT bom_id FROM walk) AND l.deleted_at IS NULL
      ORDER BY l.bom_id, l.line_no, l.id`,
    [companyId, parentId, companyId, Math.max(1, Number(maxDepth) || 1), companyId],
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
 * parent), else the child's own. A selection line never names one: once its
 * catalog item is chosen, that item's default applies. Null for things with no flow.
 *
 * AN ORDER ROW'S FLOW IS ITS OWN (user, 2026-10-10): a temporary item takes its
 * definition's flow WHEN IT IS MADE (instantiationService stamps default_flow_id)
 * and never follows the definition afterwards — "change the flow on definition, it
 * shouldn't change the flow on the order". So there is no fall-back to the template
 * here any more; `definition` only says what the definition's flow is today, for
 * a screen that offers to take it again.
 */
export function effectiveFlowOf(line) {
  const definition = line.def_flow_id ? { id: line.def_flow_id, code: line.def_flow_code, name: line.def_flow_name } : null;
  if (line.operation_flow_id) {
    // `usual`: what applies once this line's own choice is taken away ("reset to default"); null = none.
    const usual = line.child_flow_id ? { id: line.child_flow_id, code: line.child_flow_code, name: line.child_flow_name, from: 'item' } : null;
    return { id: line.operation_flow_id, code: line.line_flow_code, name: line.line_flow_name, from: 'line', usual, definition };
  }
  if (line.child_flow_id) return { id: line.child_flow_id, code: line.child_flow_code, name: line.child_flow_name, from: 'item', definition };
  return null;
}

/**
 * What the row's DEFINITION is made by today — { id, code, name } or null (no definition, or it has
 * no flow). Said for EVERY row, also one with no flow at all, where effectiveFlowOf is null and its
 * `definition` is lost: the screen offers "take the definition's flow again" from it.
 */
export function definitionFlowOf(line) {
  return line?.def_flow_id ? { id: line.def_flow_id, code: line.def_flow_code, name: line.def_flow_name } : null;
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
  const childIds = [...new Set(lines.map((l) => l.child_id))];
  const values = new Map(itemIds.map((id) => [id, new Map()]));
  const words = new Map(itemIds.map((id) => [id, new Map()]));
  if (itemIds.length && specCodes.length) {
    const [rows] = await db.query(
      `SELECT v.subject_id, s.code, v.value_number, v.value_text, o.value AS option_value, o.label AS option_label
         FROM cf_spec_values v
         JOIN cf_specifications s ON s.id = v.specification_id AND s.deleted_at IS NULL
         LEFT JOIN cf_spec_options o ON o.id = v.option_id
        WHERE v.company_id = ? AND v.subject_type = 'master' AND v.subject_id IN (?) AND v.deleted_at IS NULL
          AND s.code IN (?)`,
      [companyId, itemIds, specCodes],
    );
    for (const r of rows) {
      const code = r.code.toUpperCase();
      if (r.value_number != null) values.get(r.subject_id).set(code, Number(r.value_number));
      const w = valueWord({ optionValue: r.option_value, optionLabel: r.option_label, text: r.value_text });
      if (w != null) words.get(r.subject_id).set(code, w);
    }
  }
  // What each child IS, for a formula that tells children apart (formulaEngine: children.name / .variant …).
  const [kin] = await db.query(
    `SELECT m.id, d.code AS def_code, d.short_name AS def_short_name, d.name AS def_name,
            n1.depth AS d1, n1.code AS c1, n1.name AS n1, n2.depth AS d2, n2.code AS c2, n2.name AS n2, n3.depth AS d3, n3.code AS c3, n3.name AS n3
       FROM cf_master_records m
       LEFT JOIN cf_item_details i ON i.master_id = m.id AND i.deleted_at IS NULL
       LEFT JOIN cf_master_records d ON d.company_id = m.company_id AND d.id = i.source_definition_id AND d.deleted_at IS NULL
       LEFT JOIN cf_classification_nodes n1 ON n1.company_id = m.company_id AND n1.id = m.classification_id AND n1.deleted_at IS NULL
       LEFT JOIN cf_classification_nodes n2 ON n2.company_id = m.company_id AND n2.id = n1.parent_id AND n2.deleted_at IS NULL
       LEFT JOIN cf_classification_nodes n3 ON n3.company_id = m.company_id AND n3.id = n2.parent_id AND n3.deleted_at IS NULL
      WHERE m.company_id = ? AND m.id IN (?)`,
    [companyId, childIds],
  );
  const kinOf = new Map(kin.map((k) => [k.id, k]));
  return lines.map((l) => {
    const isItem = l.child_record_kind === 'item';
    const own = values.get(l.child_id);
    const k = kinOf.get(l.child_id) ?? {};
    const levels = {};
    for (const i of [1, 2, 3]) if (k[`d${i}`] != null) levels[levelName(Number(k[`d${i}`])).toUpperCase()] = { code: k[`c${i}`], name: k[`n${i}`] };
    return {
      lineId: l.id,
      label: isItem ? (l.child_code ?? l.child_name) : `${l.child_code ?? l.child_name} (not chosen yet)`,
      quantity: Number(l.quantity),
      get: (code) => (isItem ? own.get(code) ?? null : null),
      word: childWordReader({
        names: [l.child_name, l.child_short_name, l.child_code, k.def_name, k.def_short_name, k.def_code],
        role: l.role, levels, valueWord: (code) => (isItem ? words.get(l.child_id)?.get(code) ?? null : null),
      }),
    };
  });
}

/** A pick-list or text value as a word a formula can compare: an option by its value or its label. */
export function valueWord({ optionValue = null, optionLabel = null, text = null }) {
  if (optionValue != null || optionLabel != null) return { names: [optionValue, optionLabel] };
  return text != null && String(text).trim() !== '' ? String(text) : null;
}

/**
 * How a roll-up formula reads what a BOM child IS (formulaEngine CHILD_WORDS), the same for
 * resolve() and for orderValuesService's mirror:
 *   NAME     the row's own name, short name or code — or those of the template it was made from
 *   ROLE     the description on its BOM line
 *   VARIANT / SUBFAMILY / FAMILY   its place in the tree, by name or code
 *   <CODE>   a pick-list or text value of the child's own
 */
export function childWordReader({ names, role, levels, valueWord: valueOf }) {
  const named = { names: names.filter((x) => x != null && String(x).trim() !== '') };
  return (code) => {
    if (code === 'NAME') return named;
    if (code === 'ROLE') return role ?? null;
    if (code === 'VARIANT' || code === 'SUBFAMILY' || code === 'FAMILY') return levels?.[code] ?? null;
    return valueOf(code);
  };
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
       (company_id, bom_id, line_no, child_id, design_id, position, role, quantity, selection_definition_id, source_line_id, operation_flow_id, notes, created_by, auto_chosen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [c.companyId, l.bomId, l.lineNo, l.childId, l.designId, l.position, l.role ?? null, l.quantity,
      l.selectionDefinitionId ?? null, l.sourceLineId ?? null, l.operationFlowId ?? null, l.notes ?? null, c.userId, l.autoChosen ?? null],
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
