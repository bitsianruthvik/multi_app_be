/**
 * treeCopyService.js — an order's own temporary items, copied and deleted in
 * bulk. Two callers, one machine:
 *
 *   bomChangeService   a paste into a Custom BOM: one subtree copied under a
 *                      row of the same line (edit mode)
 *   revisionService    a revision: every line of an order copied whole into
 *                      the next revision of the order (init.sql §27)
 *
 * Both are the same deep copy — the rows, their details, their Custom BOMs and
 * lines, their specification values with the history row every value write
 * leaves, and the rules the rows carry themselves — so there is one of it,
 * here, and neither caller copies a record on its own.
 *
 * ROUND TRIPS (TiDB is ~49 ms a hop away). A copy costs a fixed number of
 * statements whatever its size: the reads a level at a time, then one
 * multi-row INSERT per kind of row (one more per `chunk` rows), each set of new
 * ids read back by a NATURAL key — TiDB does not hand AUTO_INCREMENT ids out
 * contiguously, so they are never counted forward from insertId.
 *
 * WHAT IS COPIED AND WHAT IS REFERENCED. `copies(line)` decides, per BOM line,
 * whether its child is made afresh (a row of the order) or pointed at as it is
 * (a catalog item, a template, a selection). A CUT PLATE is never copied: it
 * belongs to a rectangle on its line, not to one part. A paste keeps the copy's
 * line pointing at the same cut plate; a revision drops that line and lets
 * cutPlateService.refreshCutPieces derive the new line's own (`keepLine`).
 */
import { invalid } from '../lib/errors.js';
import { insertRows } from '../lib/db.js';
import { subtreeIds } from './tree.js';
import { dateText, parseJsonCol } from './resolutionService.js';

export const MAX_COPY_DEPTH = 25;
const ID_CHUNK = 500;   // ids per IN list
export const LINE_COLUMNS = ['company_id', 'bom_id', 'line_no', 'child_id', 'design_id', 'position', 'role', 'quantity',
  'selection_definition_id', 'source_line_id', 'operation_flow_id', 'notes', 'created_by'];

const chunk = (xs, n) => { const out = []; for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n)); return out; };

/** Classification nodes whose temporary items are cut plates: the CUT_PLATE variant and anything under it. */
export async function cutPlateNodes(db, companyId, code) {
  const [[n]] = await db.query('SELECT id FROM cf_classification_nodes WHERE company_id = ? AND code = ? AND deleted_at IS NULL', [companyId, code]);
  return n ? new Set(await subtreeIds(db, companyId, n.id)) : new Set();
}

/**
 * Everything a deep copy needs about the temporary items below some items,
 * read before anything is written. Level by level: one query for the items
 * and their BOMs, one for those BOMs' lines; then one for all their values,
 * one for their own rules and one for those rules' option lists.
 * `copies(line)` says whether a line's child is made afresh (it is then read
 * too) or referenced, like a catalog item or a shared cut plate.
 */
export async function snapshotSubtrees(db, companyId, rootIds, copies) {
  const snap = { items: new Map(), linesByBom: new Map(), values: new Map(), rules: new Map(), ruleOptions: new Map() };
  let frontier = [...new Set(rootIds)];
  for (let depth = 0; frontier.length; depth++) {
    if (depth > MAX_COPY_DEPTH) throw invalid('TOO_DEEP', `The structure being copied is more than ${MAX_COPY_DEPTH} levels deep — check for a temporary item that contains itself.`);
    const level = frontier.filter((id) => !snap.items.has(id));
    if (!level.length) break;
    for (const part of chunk(level, ID_CHUNK)) {
      const [rows] = await db.query(
        `SELECT m.id, m.code, m.name, m.short_name, m.description, m.classification_id, m.default_flow_id, m.status,
                i.tracked_by, i.uom, i.source_definition_id,
                b.id AS bom_id, b.status AS bom_status, b.source_bom_id, b.revision AS bom_revision, b.notes AS bom_notes
           FROM cf_master_records m
           JOIN cf_item_details i ON i.master_id = m.id AND i.deleted_at IS NULL AND i.item_type = 'temporary'
           LEFT JOIN cf_boms b ON b.company_id = m.company_id AND b.parent_id = m.id AND b.deleted_at IS NULL
          WHERE m.company_id = ? AND m.id IN (?) AND m.deleted_at IS NULL`,
        [companyId, part],
      );
      for (const r of rows) snap.items.set(r.id, r);
    }
    const bomIds = level.map((id) => snap.items.get(id)?.bom_id).filter(Boolean);
    const next = [];
    for (const part of chunk(bomIds, ID_CHUNK)) {
      const [ls] = await db.query(
        `SELECT l.id, l.bom_id, l.line_no, l.child_id, l.design_id, l.position, l.role, l.quantity,
                l.selection_definition_id, l.source_line_id, l.operation_flow_id, l.notes,
                ci.item_type AS child_item_type, cm.classification_id AS child_classification_id,
                cm.code AS child_code, cm.name AS child_name
           FROM cf_bom_lines l
           JOIN cf_master_records cm ON cm.id = l.child_id
           LEFT JOIN cf_item_details ci ON ci.master_id = l.child_id AND ci.deleted_at IS NULL
          WHERE l.company_id = ? AND l.bom_id IN (?) AND l.deleted_at IS NULL
          ORDER BY l.bom_id, l.line_no, l.id`,
        [companyId, part],
      );
      for (const l of ls) {
        l.copy = copies(l);
        if (!snap.linesByBom.has(l.bom_id)) snap.linesByBom.set(l.bom_id, []);
        snap.linesByBom.get(l.bom_id).push(l);
        if (l.copy) next.push(l.child_id);
      }
    }
    frontier = next;
  }
  const ids = [...snap.items.keys()];
  for (const part of chunk(ids, ID_CHUNK)) {
    const [vals] = await db.query(
      `SELECT id, specification_id, subject_id, value_number, value_text, value_bool, value_date, option_id, value_json, uom, source
         FROM cf_spec_values
        WHERE company_id = ? AND subject_type = 'master' AND subject_id IN (?) AND deleted_at IS NULL
        ORDER BY subject_id, id`,
      [companyId, part],
    );
    for (const v of vals) {
      if (!snap.values.has(v.subject_id)) snap.values.set(v.subject_id, []);
      snap.values.get(v.subject_id).push(v);
    }
    const [rules] = await db.query(
      `SELECT id, specification_id, subject_id, capture_at, is_required, is_applicable, value_rule, formula_id, sort_order
         FROM cf_spec_assignments
        WHERE company_id = ? AND subject_type = 'master' AND subject_id IN (?) AND deleted_at IS NULL`,
      [companyId, part],
    );
    for (const r of rules) {
      if (!snap.rules.has(r.subject_id)) snap.rules.set(r.subject_id, []);
      snap.rules.get(r.subject_id).push(r);
    }
    if (rules.length) {
      const [opts] = await db.query(
        'SELECT assignment_id, option_id FROM cf_spec_assignment_options WHERE company_id = ? AND assignment_id IN (?) AND deleted_at IS NULL',
        [companyId, rules.map((r) => r.id)],
      );
      for (const o of opts) {
        if (!snap.ruleOptions.has(o.assignment_id)) snap.ruleOptions.set(o.assignment_id, []);
        snap.ruleOptions.get(o.assignment_id).push(o.option_id);
      }
    }
  }
  return snap;
}

/** The snapshot `valueService` writes to a history row (its `snapshot()`), for a copied or deleted value row. */
export function valueSnapshot(v) {
  return {
    number: v.value_number == null ? null : Number(v.value_number),
    text: v.value_text ?? null,
    bool: v.value_bool == null ? null : !!Number(v.value_bool),
    date: dateText(v.value_date),
    option_id: v.option_id ?? null,
    json: parseJsonCol(v.value_json),
    uom: v.uom ?? null,
    source: v.source,
  };
}

const markerToken = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/**
 * Writes fresh copies of the snapshot's temporary items under `roots`, each
 * root with everything below it that `copies` said is made afresh:
 *
 *   INSERT every item (placeholder codes), read their ids back            2
 *   INSERT their detail rows, their BOMs, read the BOM ids back           3
 *   INSERT every line inside the copies                                   1
 *   INSERT every value, read the ids back, INSERT the history rows        3
 *   INSERT their own rules, read them back, INSERT the option lists       0-3
 *   clear the placeholder codes                                           1
 *
 * (one more of each per `chunk` rows, or per 500 ids for a read.)
 *
 *   roots     [{ srcId, ownerLineId }] — the owner is the order line every
 *             copy below that root belongs to (a paste: the target's line; a
 *             revision: the new revision's line)
 *   keepLine  (line) => whether a line inside the copies is written at all. A
 *             line to a temporary item that is not copied is written pointing
 *             at the same item (the shared cut plate of a paste) unless this
 *             says no (a revision derives the new line's own).
 *
 * The TOP line of each root is the caller's to write — a paste puts it into the
 * target's BOM, a revision hangs the root on its new sales line.
 *
 * WHY PLACEHOLDER CODES. A new temporary item has no natural key of its own —
 * its code is empty and its name repeats — so each is born with a placeholder
 * code unique to this copy, read back by it, and emptied before this returns.
 * A row of an order has no code (user, 2026-09-26): its pieces get theirs at
 * LOCK. The placeholder never leaves the transaction.
 *
 * Returns { idMap: Map(source id -> copy id), levels: [[source id]] (parents
 * before children), shared: Set(labels of temporary items pointed at, not copied) }.
 */
export async function writeCopies(db, c, snap, roots, { keepLine = () => true, chunk: rows = 200 } = {}) {
  const companyId = c.companyId;

  // ---- which items, parents before children, and whose line each belongs to --
  const ownerOf = new Map();
  const levels = [];
  let frontier = roots.map((r) => ({ id: r.srcId, owner: r.ownerLineId }));
  while (frontier.length) {
    const level = [];
    for (const f of frontier) {
      if (ownerOf.has(f.id) || !snap.items.has(f.id)) continue;
      ownerOf.set(f.id, f.owner);
      level.push(f.id);
    }
    if (!level.length) break;
    levels.push(level);
    frontier = level.flatMap((id) => {
      const bomId = snap.items.get(id).bom_id;
      return (bomId ? snap.linesByBom.get(bomId) ?? [] : []).filter((l) => l.copy).map((l) => ({ id: l.child_id, owner: ownerOf.get(id) }));
    });
  }
  const srcIds = levels.flat();
  const idMap = new Map();
  const shared = new Set();
  if (!srcIds.length) return { idMap, levels, shared };

  // ---- the items ------------------------------------------------------------
  const token = markerToken();
  const marker = (srcId) => `~copy~${token}~${srcId}`;
  await insertRows(db, 'cf_master_records',
    ['company_id', 'record_kind', 'code', 'name', 'short_name', 'description', 'classification_id', 'status', 'revision', 'default_flow_id', 'created_by'],
    srcIds.map((id) => {
      const s = snap.items.get(id);
      return [companyId, 'item', marker(id), s.name, s.short_name, s.description, s.classification_id, 'draft', null, s.default_flow_id, c.userId];
    }), rows);
  const [born] = await db.query(
    'SELECT id, code FROM cf_master_records WHERE company_id = ? AND code_active LIKE ? AND deleted_at IS NULL',
    [companyId, `~copy~${token}~%`],
  );
  for (const b of born) idMap.set(Number(String(b.code).split('~').pop()), b.id);
  if (idMap.size !== srcIds.length) throw new Error(`cf_erp: ${srcIds.length} copies written, ${idMap.size} read back.`);

  await insertRows(db, 'cf_item_details',
    ['master_id', 'company_id', 'item_type', 'tracked_by', 'uom', 'sourcing', 'source_definition_id', 'owner_order_line_id'],
    srcIds.map((id) => {
      const s = snap.items.get(id);
      return [idMap.get(id), companyId, 'temporary', s.tracked_by, s.uom, 'make', s.source_definition_id, ownerOf.get(id)];
    }), rows);

  // ---- their BOMs -------------------------------------------------------------
  const withBom = srcIds.filter((id) => snap.items.get(id).bom_id);
  const bomMap = new Map();
  if (withBom.length) {
    await insertRows(db, 'cf_boms',
      ['company_id', 'parent_id', 'bom_type', 'revision', 'status', 'source_bom_id', 'notes', 'created_by'],
      withBom.map((id) => {
        const s = snap.items.get(id);
        return [companyId, idMap.get(id), 'custom', s.bom_revision, s.bom_status, s.source_bom_id, s.bom_notes, c.userId];
      }), rows);
    const back = new Map([...idMap].map(([src, fresh]) => [fresh, src]));
    for (const part of chunk(withBom.map((id) => idMap.get(id)), ID_CHUNK)) {
      const [bs] = await db.query('SELECT id, parent_id FROM cf_boms WHERE company_id = ? AND parent_id IN (?) AND deleted_at IS NULL', [companyId, part]);
      for (const b of bs) bomMap.set(snap.items.get(back.get(b.parent_id)).bom_id, b.id);
    }
  }

  // ---- every line inside the copies ------------------------------------------
  const inner = [];
  for (const id of withBom) {
    const srcBom = snap.items.get(id).bom_id;
    for (const l of snap.linesByBom.get(srcBom) ?? []) {
      if (!keepLine(l)) continue;
      const child = l.copy ? idMap.get(l.child_id) : l.child_id;
      if (l.child_item_type === 'temporary' && !l.copy) shared.add(l.child_code ?? l.child_name);
      if (child == null) {
        throw invalid('BROKEN_LINE', `${snap.items.get(id).code ?? snap.items.get(id).name} has a line to a temporary item that no longer exists — remove that line, then copy it.`);
      }
      inner.push([companyId, bomMap.get(srcBom), l.line_no, child, l.design_id, l.position, l.role, l.quantity,
        l.selection_definition_id, l.source_line_id, l.operation_flow_id, l.notes, c.userId]);
    }
  }
  if (inner.length) await insertRows(db, 'cf_bom_lines', LINE_COLUMNS, inner, rows);

  // ---- values, with the history every value write leaves (Q19) ---------------
  const vals = srcIds.flatMap((id) => (snap.values.get(id) ?? []).map((v) => ({ ...v, subject_id: idMap.get(id) })));
  if (vals.length) {
    await insertRows(db, 'cf_spec_values',
      ['company_id', 'specification_id', 'subject_type', 'subject_id', 'value_number', 'value_text', 'value_bool', 'value_date', 'option_id', 'value_json', 'uom', 'source', 'created_by'],
      vals.map((v) => [companyId, v.specification_id, 'master', v.subject_id, v.value_number, v.value_text, v.value_bool,
        dateText(v.value_date), v.option_id, v.value_json == null ? null : JSON.stringify(parseJsonCol(v.value_json)), v.uom, v.source, c.userId]), rows);
    // (company, spec, subject) is uq_csv_value among live rows, so each key is
    // exactly the row just written, whatever id the engine gave it.
    const valueId = new Map();
    for (const part of chunk([...new Set(vals.map((v) => v.subject_id))], ID_CHUNK)) {
      const [back] = await db.query(
        "SELECT id, subject_id, specification_id FROM cf_spec_values WHERE company_id = ? AND subject_type = 'master' AND subject_id IN (?) AND deleted_at IS NULL",
        [companyId, part],
      );
      for (const r of back) valueId.set(`${r.subject_id}:${r.specification_id}`, r.id);
    }
    await insertRows(db, 'cf_spec_value_history',
      ['company_id', 'value_id', 'specification_id', 'subject_type', 'subject_id', 'change_type', 'old_value', 'new_value', 'changed_by'],
      vals.map((v) => [companyId, valueId.get(`${v.subject_id}:${v.specification_id}`), v.specification_id, 'master', v.subject_id,
        'create', null, JSON.stringify(valueSnapshot(v)), c.userId]), rows);
  }

  // ---- rules the items carry themselves -----------------------------------------
  const rules = srcIds.flatMap((id) => (snap.rules.get(id) ?? []).map((r) => ({ ...r, subject_id: idMap.get(id) })));
  if (rules.length) {
    await insertRows(db, 'cf_spec_assignments',
      ['company_id', 'specification_id', 'subject_type', 'subject_id', 'capture_at', 'is_required', 'is_applicable', 'value_rule', 'formula_id', 'sort_order', 'created_by'],
      rules.map((r) => [companyId, r.specification_id, 'master', r.subject_id, r.capture_at, r.is_required, r.is_applicable, r.value_rule, r.formula_id, r.sort_order, c.userId]), rows);
    const withOptions = rules.filter((r) => snap.ruleOptions.has(r.id));
    if (withOptions.length) {
      const ruleId = new Map();
      for (const part of chunk([...new Set(withOptions.map((r) => r.subject_id))], ID_CHUNK)) {
        const [back] = await db.query(
          "SELECT id, subject_id, specification_id, capture_at FROM cf_spec_assignments WHERE company_id = ? AND subject_type = 'master' AND subject_id IN (?) AND deleted_at IS NULL",
          [companyId, part],
        );
        for (const r of back) ruleId.set(`${r.subject_id}:${r.specification_id}:${r.capture_at}`, r.id);
      }
      await insertRows(db, 'cf_spec_assignment_options', ['company_id', 'assignment_id', 'option_id', 'created_by'],
        withOptions.flatMap((r) => snap.ruleOptions.get(r.id).map((optionId) => [companyId, ruleId.get(`${r.subject_id}:${r.specification_id}:${r.capture_at}`), optionId, c.userId])), rows);
    }
  }

  // ---- no codes: a row is a design, its pieces get their codes at LOCK ----------
  for (const part of chunk([...idMap.values()], ID_CHUNK)) {
    await db.query('UPDATE cf_master_records SET code = NULL WHERE company_id = ? AND id IN (?)', [companyId, part]);
  }
  return { idMap, levels, shared };
}

/**
 * instantiationService.deleteTemporaryTree for a whole set of temporary items
 * at once — every one of them goes, nothing is kept for another holder, so the
 * caller must hand over a set that nothing outside it still points at (a
 * discarded revision: every row of every line it has). Values go with a
 * 'delete' history row each, as valueService.deleteAllForSubject writes; then
 * item-level rules and their option lists, the links to the drawings the rows
 * were built to (a drawing's coverage must not list a deleted row — the
 * drawings themselves stay), the Custom BOMs and their lines, the detail and
 * master rows. Soft deletes, like everywhere. A fixed number of statements
 * whatever the size (one more per 500 ids, or per `chunk` history rows).
 */
export async function deleteTemporaryItems(db, c, itemIds, { chunk: rows = 500 } = {}) {
  const companyId = c.companyId;
  const ids = [...new Set(itemIds.map(Number))];
  if (!ids.length) return 0;
  const parts = chunk(ids, ID_CHUNK);

  // Values, each with its history row (Q19): read, retire, then say so.
  const vals = [];
  for (const part of parts) {
    const [vs] = await db.query(
      `SELECT id, specification_id, subject_id, value_number, value_text, value_bool, value_date, option_id, value_json, uom, source
         FROM cf_spec_values WHERE company_id = ? AND subject_type = 'master' AND subject_id IN (?) AND deleted_at IS NULL`,
      [companyId, part],
    );
    vals.push(...vs);
  }
  for (const part of chunk(vals.map((v) => v.id), ID_CHUNK)) {
    await db.query('UPDATE cf_spec_values SET deleted_at = NOW() WHERE company_id = ? AND id IN (?)', [companyId, part]);
  }
  if (vals.length) {
    await insertRows(db, 'cf_spec_value_history',
      ['company_id', 'value_id', 'specification_id', 'subject_type', 'subject_id', 'change_type', 'old_value', 'new_value', 'changed_by'],
      vals.map((v) => [companyId, v.id, v.specification_id, 'master', v.subject_id, 'delete', JSON.stringify(valueSnapshot(v)), null, c.userId]), rows);
  }

  for (const part of parts) {
    await db.query(
      `UPDATE cf_spec_assignment_options ao JOIN cf_spec_assignments a ON a.id = ao.assignment_id
          SET ao.deleted_at = NOW()
        WHERE a.company_id = ? AND a.subject_type = 'master' AND a.subject_id IN (?) AND ao.deleted_at IS NULL`,
      [companyId, part],
    );
    await db.query(
      "UPDATE cf_spec_assignments SET deleted_at = NOW() WHERE company_id = ? AND subject_type = 'master' AND subject_id IN (?) AND deleted_at IS NULL",
      [companyId, part],
    );
    await db.query(
      "UPDATE cf_drawing_links SET deleted_at = NOW() WHERE company_id = ? AND subject_type = 'master_record' AND subject_id IN (?) AND deleted_at IS NULL",
      [companyId, part],
    );
    await db.query(
      `UPDATE cf_bom_lines l JOIN cf_boms b ON b.id = l.bom_id
          SET l.deleted_at = NOW()
        WHERE b.company_id = ? AND b.parent_id IN (?) AND l.deleted_at IS NULL`,
      [companyId, part],
    );
    await db.query('UPDATE cf_boms SET deleted_at = NOW() WHERE company_id = ? AND parent_id IN (?) AND deleted_at IS NULL', [companyId, part]);
    await db.query('UPDATE cf_item_details SET deleted_at = NOW() WHERE company_id = ? AND master_id IN (?) AND deleted_at IS NULL', [companyId, part]);
    await db.query('UPDATE cf_master_records SET deleted_at = NOW() WHERE company_id = ? AND id IN (?) AND deleted_at IS NULL', [companyId, part]);
  }
  return ids.length;
}
