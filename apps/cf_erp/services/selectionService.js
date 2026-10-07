/**
 * selectionService.js — how a Selection Definition finds its catalog items.
 *
 * WHAT IT PICKS FROM (init.sql §42, 2026-10-02): a list of ENTRIES, each one
 *   a classification node at any level — its whole subtree — or
 *   one catalog item (the starred one is the default; at most one).
 * Candidates are the UNION of the entries, then narrowed by the spec filters
 * (cf_selection_criteria): criteria on the SAME specification are OR'ed
 * (GRADE = 8.8 or 10.9); criteria on DIFFERENT specifications are AND'ed
 * (... and DIAMETER = 20). Matching reads stored values, which is why derived
 * values are materialised (Q18). No entry = nothing to pick from.
 *
 * The old mode switch (allowed_list | spec_match | both) is gone from the
 * screens. Its columns are still written — derived — by syncLegacy, so code
 * that reads candidate_classification_id (a cut plate finding "the selection
 * that searches PLATE") keeps working, and the migration in §42 stays
 * idempotent.
 *
 * A ROW OF AN ORDER (autofillLineSelections): a selection row the system can
 * answer on its own — the default when it is a valid candidate, else the only
 * candidate — is chosen automatically and marked auto_chosen = 1 ("default ·
 * change" on the row) until a person chooses. A cut plate's raw plate (a
 * selection under a row filed where cut plates are filed) is never filled
 * here: nesting chooses it.
 */
import { invalid, notFound, conflict, assertNoProblems } from '../lib/errors.js';
import { likeOf } from '../lib/listing.js';
import { loadMaster, requireMaster, LOCKED_ORDER_STATUSES } from './records.js';
import { ancestors, levelName } from './tree.js';
import { coerce } from './valueService.js';
import { rawOf } from './resolutionService.js';

const OPERATORS = {
  number: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between'],
  date: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte'],
  text: ['eq', 'neq'],
  option: ['eq', 'neq'],
  boolean: ['eq'],
};
const SQL_OP = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' };

/**
 * Where cut plates are filed is a company setting (Setup › Cutting, init.sql
 * §48 cf_cut_places), never a classification code. The SQL below asks the
 * setting itself, so no caller needs to read it first.
 *
 * SQL that keeps only selection rows a PERSON (or the system) chooses — not a
 * cut plate's raw plate. `pm` must be the row's parent master record. The
 * JOIN is kept for callers that splice it in; the test is a subquery in WHERE
 * (TiDB takes that; it does not take one in ON). Use with NOT_UNDER_CUT_PLATE_WHERE.
 */
export const PARENT_CLASS_JOIN = 'LEFT JOIN cf_classification_nodes pcls ON pcls.id = pm.classification_id';
export const NOT_UNDER_CUT_PLATE_WHERE = `(pm.classification_id NOT IN (SELECT cpl.blanks_node_id FROM cf_cut_places cpl
    WHERE cpl.company_id = pm.company_id AND cpl.kind = 'plate' AND cpl.blanks_node_id IS NOT NULL))`;

async function requireSelection(db, companyId, id) {
  const d = await requireMaster(db, companyId, id, 'Selection definition');
  if (d.record_kind !== 'definition' || d.definition_type !== 'selection') {
    throw invalid('NOT_SELECTION', `${d.code ?? d.name} is not a selection definition.`);
  }
  return d;
}

/** The old mode, derived from the entries — written for compatibility, never asked for. */
export function derivedMode(entries) {
  const nodes = entries.some((e) => e.node_id != null);
  const items = entries.some((e) => e.item_id != null);
  if (nodes && items) return 'both';
  return nodes ? 'spec_match' : 'allowed_list';
}

async function rawEntries(db, companyId, definitionIds) {
  if (!definitionIds.length) return [];
  const [rows] = await db.query(
    `SELECT s.id, s.definition_id, s.node_id, s.item_id, s.is_default, s.sort_order
       FROM cf_selection_scope s
      WHERE s.company_id = ? AND s.definition_id IN (?)
      ORDER BY s.sort_order, s.id`,
    [companyId, definitionIds],
  );
  return rows;
}

/**
 * A selection with NO entry yet reads its old columns, translated exactly as the
 * §42 migration translates them (rows written straight into the old tables by a
 * script or a test after the migration ran, or by an older backend). Rows come
 * back without an id (`legacy: true`); adoptLegacy writes them as entries the
 * first time anything changes the selection. Because syncLegacy keeps the old
 * columns equal to the entries, a selection emptied on purpose reads empty here.
 */
async function legacyEntries(db, companyId, definitionId) {
  const [[[d]], [allowed]] = await Promise.all([
    db.query('SELECT selection_mode, candidate_classification_id FROM cf_definition_details WHERE company_id = ? AND master_id = ? AND deleted_at IS NULL', [companyId, definitionId]),
    db.query(
      `SELECT a.item_id, a.is_default, a.sort_order, i.classification_id
         FROM cf_definition_allowed_items a JOIN cf_master_records i ON i.id = a.item_id AND i.deleted_at IS NULL
        WHERE a.company_id = ? AND a.definition_id = ? AND a.deleted_at IS NULL ORDER BY a.sort_order, a.id`,
      [companyId, definitionId],
    ),
  ]);
  if (!d) return [];
  const mode = d.selection_mode;
  const node = d.candidate_classification_id;
  const asItem = (a) => ({ id: null, legacy: true, definition_id: Number(definitionId), node_id: null, item_id: a.item_id, is_default: a.is_default, sort_order: a.sort_order });
  if (mode === 'spec_match') {
    if (node != null) return [{ id: null, legacy: true, definition_id: Number(definitionId), node_id: node, item_id: null, is_default: 0, sort_order: 0 }];
    const [roots] = await db.query("SELECT id, sort_order FROM cf_classification_nodes WHERE company_id = ? AND parent_id IS NULL AND deleted_at IS NULL AND scope <> 'machine' ORDER BY sort_order, id", [companyId]);
    return roots.map((r) => ({ id: null, legacy: true, definition_id: Number(definitionId), node_id: r.id, item_id: null, is_default: 0, sort_order: r.sort_order }));
  }
  if (mode === 'both' && node != null) {
    const inside = new Set(await subtreesOf(db, companyId, [node]));
    return allowed.filter((a) => inside.has(Number(a.classification_id))).map(asItem);
  }
  return allowed.map(asItem);
}

/** What a selection picks from: its entries, or — with none yet — its old columns (legacyEntries). */
export async function entriesOf(db, companyId, definitionId) {
  const rows = await rawEntries(db, companyId, [definitionId]);
  return rows.length ? rows : legacyEntries(db, companyId, definitionId);
}

/** Writes a selection's old-column entries as real entries, once (see legacyEntries). */
export async function adoptLegacy(db, c, definitionId) {
  if ((await rawEntries(db, c.companyId, [definitionId])).length) return false;
  const legacy = await legacyEntries(db, c.companyId, definitionId);
  if (!legacy.length) return false;
  await db.query(
    'INSERT INTO cf_selection_scope (company_id, definition_id, node_id, item_id, is_default, sort_order, created_by) VALUES ?',
    [legacy.map((e) => [c.companyId, definitionId, e.node_id, e.item_id, e.is_default ? 1 : 0, e.sort_order ?? 0, c.userId])],
  );
  await syncLegacy(db, c.companyId, definitionId);
  return true;
}

/** Every node under the given ones (the given ones included) — one read per level. */
export async function subtreesOf(db, companyId, nodeIds) {
  const ids = new Set(nodeIds.map(Number));
  let frontier = [...ids];
  while (frontier.length) {
    const [rows] = await db.query(
      'SELECT id FROM cf_classification_nodes WHERE company_id = ? AND parent_id IN (?) AND deleted_at IS NULL',
      [companyId, frontier],
    );
    frontier = rows.map((r) => Number(r.id)).filter((id) => !ids.has(id));
    for (const id of frontier) ids.add(id);
  }
  return [...ids];
}

/**
 * Keeps the old columns in step with the entries (see the top of the file):
 * candidate_classification_id = the first node entry, selection_mode derived,
 * cf_definition_allowed_items = the item entries. Set-based, four statements.
 *
 * With no node entry the candidate column is LEFT as it is — an older caller
 * (allowed list + "search area", e.g. the plate selection made by scripts and
 * tests) still uses it to say what the selection is for — unless the node that
 * was in it has just been removed (`removedNodeId`).
 */
export async function syncLegacy(db, companyId, definitionId, { removedNodeId = null } = {}) {
  const entries = await rawEntries(db, companyId, [definitionId]);
  const firstNode = entries.find((e) => e.node_id != null)?.node_id ?? null;
  if (firstNode != null) {
    await db.query('UPDATE cf_definition_details SET candidate_classification_id = ?, selection_mode = ? WHERE company_id = ? AND master_id = ?',
      [firstNode, derivedMode(entries), companyId, definitionId]);
  } else {
    await db.query(
      `UPDATE cf_definition_details SET selection_mode = ?,
              candidate_classification_id = IF(candidate_classification_id <=> ?, NULL, candidate_classification_id)
        WHERE company_id = ? AND master_id = ?`,
      [derivedMode(entries), removedNodeId, companyId, definitionId]);
  }
  const items = entries.filter((e) => e.item_id != null);
  // Off the old list: what is no longer an item entry.
  await db.query(
    `UPDATE cf_definition_allowed_items SET deleted_at = NOW()
      WHERE company_id = ? AND definition_id = ? AND deleted_at IS NULL${items.length ? ' AND item_id NOT IN (?)' : ''}`,
    items.length ? [companyId, definitionId, items.map((e) => e.item_id)] : [companyId, definitionId],
  );
  if (!items.length) return;
  // Onto it: what is missing; then the star and the order of every one.
  await db.query(
    `INSERT INTO cf_definition_allowed_items (company_id, definition_id, item_id, is_default, sort_order)
     SELECT s.company_id, s.definition_id, s.item_id, s.is_default, s.sort_order
       FROM cf_selection_scope s
      WHERE s.company_id = ? AND s.definition_id = ? AND s.item_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM cf_definition_allowed_items a
                         WHERE a.company_id = s.company_id AND a.definition_id = s.definition_id AND a.item_id = s.item_id AND a.deleted_at IS NULL)`,
    [companyId, definitionId],
  );
  await db.query(
    `UPDATE cf_definition_allowed_items a
       JOIN cf_selection_scope s ON s.company_id = a.company_id AND s.definition_id = a.definition_id AND s.item_id = a.item_id
        SET a.is_default = s.is_default, a.sort_order = s.sort_order
      WHERE a.company_id = ? AND a.definition_id = ? AND a.deleted_at IS NULL`,
    [companyId, definitionId],
  );
}

/** The entries as a screen shows them: what each one is, where it is filed. */
async function shapeEntries(db, companyId, entries) {
  const nodeIds = entries.filter((e) => e.node_id != null).map((e) => e.node_id);
  const itemIds = entries.filter((e) => e.item_id != null).map((e) => e.item_id);
  const [[nodes], [items]] = await Promise.all([
    nodeIds.length ? db.query('SELECT id, code, name, depth, status, scope FROM cf_classification_nodes WHERE company_id = ? AND id IN (?)', [companyId, nodeIds]) : [[]],
    itemIds.length ? db.query(
      `SELECT m.id, m.code, m.name, m.status, c.name AS classification_name
         FROM cf_master_records m LEFT JOIN cf_classification_nodes c ON c.id = m.classification_id
        WHERE m.company_id = ? AND m.id IN (?)`, [companyId, itemIds]) : [[]],
  ]);
  const nodeBy = new Map(nodes.map((n) => [n.id, n]));
  const itemBy = new Map(items.map((m) => [m.id, m]));
  const paths = new Map();
  for (const id of nodeIds) paths.set(id, (await ancestors(db, companyId, id)).map((n) => n.name).join(' › '));
  return entries.map((e) => {
    if (e.node_id != null) {
      const n = nodeBy.get(e.node_id);
      return { id: e.id, kind: 'node', nodeId: e.node_id, itemId: null, code: n?.code ?? null, name: n?.name ?? null,
        level: n ? levelName(n.depth) : null, path: paths.get(e.node_id) ?? null, status: n?.status ?? null, isDefault: false, sortOrder: e.sort_order };
    }
    const m = itemBy.get(e.item_id);
    return { id: e.id, kind: 'item', nodeId: null, itemId: e.item_id, code: m?.code ?? null, name: m?.name ?? null,
      level: null, path: m?.classification_name ?? null, status: m?.status ?? null, isDefault: !!e.is_default, sortOrder: e.sort_order };
  });
}

/**
 * What it picks from and its spec filters. Given `c` (a transaction), a
 * selection still on its old columns has them written as entries first
 * (adoptLegacy), so every entry on the screen has an id to act on.
 */
export async function getSelection(db, companyId, definitionId, { c = null } = {}) {
  await requireSelection(db, companyId, definitionId);
  if (c) await adoptLegacy(db, c, definitionId);
  const [raw, [criteria], [legacyIds]] = await Promise.all([
    entriesOf(db, companyId, definitionId),
    db.query(
      `SELECT c.*, s.code AS spec_code, s.name AS spec_name, s.data_type, s.default_uom, o.value AS option_value
         FROM cf_selection_criteria c
         JOIN cf_specifications s ON s.id = c.specification_id
         LEFT JOIN cf_spec_options o ON o.id = c.option_id
        WHERE c.company_id = ? AND c.definition_id = ? AND c.deleted_at IS NULL
        ORDER BY c.sort_order, c.id`,
      [companyId, definitionId],
    ),
    db.query('SELECT id, item_id FROM cf_definition_allowed_items WHERE company_id = ? AND definition_id = ? AND deleted_at IS NULL', [companyId, definitionId]),
  ]);
  const entries = await shapeEntries(db, companyId, raw);
  const legacyIdOf = new Map(legacyIds.map((r) => [r.item_id, r.id]));
  return {
    definitionId: Number(definitionId),
    // Derived from the entries (kept for older screens).
    selectionMode: derivedMode(raw),
    candidateClassificationId: raw.find((e) => e.node_id != null)?.node_id ?? null,
    entries,
    // The item entries in the old shape, for older screens and callers: the id is
    // the old allowed-list row's (kept in step), which /allowed-items/:id takes.
    allowedItems: entries.filter((e) => e.kind === 'item')
      .map((e) => ({ id: legacyIdOf.get(e.itemId) ?? null, itemId: e.itemId, code: e.code, name: e.name, status: e.status, isDefault: e.isDefault, sortOrder: e.sortOrder })),
    criteria: criteria.map((c) => ({
      id: c.id, specificationId: c.specification_id, specCode: c.spec_code, specName: c.spec_name, dataType: c.data_type, unit: c.default_uom,
      operator: c.operator,
      value: c.data_type === 'option' ? c.option_value : rawOf(c, c.data_type),
      valueTo: c.value_number_to == null ? null : Number(c.value_number_to),
      optionId: c.option_id,
    })),
  };
}

/** Checks one entry before it is written; returns the row's node_id / item_id. */
async function readEntry(db, companyId, input, existing) {
  const hasNode = input.nodeId != null && input.nodeId !== '';
  const hasItem = input.itemId != null && input.itemId !== '';
  if (hasNode === hasItem) throw invalid('ENTRY_KIND', 'An entry is a branch of the classification or one catalog item — give one of them.');
  if (hasNode) {
    const nodeId = Number(input.nodeId);
    const [[n]] = await db.query('SELECT * FROM cf_classification_nodes WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, nodeId]);
    if (!n) throw notFound('Classification node');
    if (n.scope === 'machine') throw invalid('MACHINE_BRANCH', `${n.name} is a machine family — a selection picks catalog items.`);
    if (existing.some((e) => Number(e.node_id) === nodeId)) throw conflict('DUPLICATE_ENTRY', `It already picks from ${n.name}.`);
    return { nodeId, itemId: null };
  }
  const item = await loadMaster(db, companyId, Number(input.itemId));
  if (!item || item.record_kind !== 'item') throw notFound('Item');
  if (item.item_type !== 'catalog') throw invalid('NOT_CATALOG', 'A selection chooses from catalog items — temporary items belong to one order.');
  if (item.status === 'obsolete') throw invalid('OBSOLETE', `${item.code} is obsolete.`);
  if (existing.some((e) => Number(e.item_id) === item.id)) throw conflict('DUPLICATE_ENTRY', `${item.code ?? item.name} is already on the list.`);
  return { nodeId: null, itemId: item.id };
}

/**
 * Adds an entry: { nodeId } — a branch at any level — or { itemId, isDefault? }.
 * The first item added to a selection that has no default becomes it (as the
 * old allowed list did) unless isDefault is false; a branch never carries the star.
 */
export async function addEntry(db, c, definitionId, input = {}, { adopt = true } = {}) {
  await requireSelection(db, c.companyId, definitionId);
  if (adopt) await adoptLegacy(db, c, definitionId);
  const existing = await rawEntries(db, c.companyId, [definitionId]);
  const e = await readEntry(db, c.companyId, input, existing);
  const isDefault = e.itemId != null && (input.isDefault === true || (input.isDefault == null && !existing.some((x) => x.is_default)));
  if (isDefault) await db.query('UPDATE cf_selection_scope SET is_default = 0 WHERE company_id = ? AND definition_id = ?', [c.companyId, definitionId]);
  const sort = existing.reduce((n, x) => Math.max(n, Number(x.sort_order)), 0) + 1;
  await db.query(
    'INSERT INTO cf_selection_scope (company_id, definition_id, node_id, item_id, is_default, sort_order, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [c.companyId, definitionId, e.nodeId, e.itemId, isDefault ? 1 : 0, sort, c.userId],
  );
  await syncLegacy(db, c.companyId, definitionId);
  return getSelection(db, c.companyId, definitionId);
}

async function requireEntry(db, companyId, id) {
  const [[row]] = await db.query('SELECT * FROM cf_selection_scope WHERE company_id = ? AND id = ?', [companyId, id]);
  if (!row) throw notFound('Entry');
  return row;
}

/** Stars an item entry as the default (input.isDefault false takes the star off). */
export async function setDefaultEntry(db, c, id, input = {}) {
  const row = await requireEntry(db, c.companyId, id);
  if (row.item_id == null) throw invalid('NODE_NOT_DEFAULT', 'Only an item can be the default — a branch holds many.');
  const on = input?.isDefault !== false;
  await db.query('UPDATE cf_selection_scope SET is_default = IF(id = ?, ?, 0) WHERE company_id = ? AND definition_id = ?', [id, on ? 1 : 0, c.companyId, row.definition_id]);
  await syncLegacy(db, c.companyId, row.definition_id);
  return getSelection(db, c.companyId, row.definition_id);
}

export async function removeEntry(db, c, id) {
  const row = await requireEntry(db, c.companyId, id);
  await db.query('DELETE FROM cf_selection_scope WHERE company_id = ? AND id = ?', [c.companyId, id]);
  await syncLegacy(db, c.companyId, row.definition_id, { removedNodeId: row.node_id });
  return getSelection(db, c.companyId, row.definition_id);
}

// The old allowed-list calls, on the entries. An allowed item IS an item entry;
// the id these take is the old allowed-list row's, as it always was. The old
// add never starred an item unless asked to.
export const addAllowedItem = (db, c, definitionId, input = {}) => addEntry(db, c, definitionId, { itemId: input.itemId, isDefault: !!input.isDefault });
async function entryOfAllowed(db, c, allowedId) {
  const [[a]] = await db.query('SELECT definition_id, item_id FROM cf_definition_allowed_items WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [c.companyId, allowedId]);
  if (!a) throw notFound('Allowed item');
  await adoptLegacy(db, c, a.definition_id);
  const [[e]] = await db.query('SELECT id FROM cf_selection_scope WHERE company_id = ? AND definition_id = ? AND item_id = ?', [c.companyId, a.definition_id, a.item_id]);
  if (!e) throw notFound('Allowed item');
  return e.id;
}
export const setDefaultAllowed = async (db, c, id) => setDefaultEntry(db, c, await entryOfAllowed(db, c, id));
export const removeAllowedItem = async (db, c, id) => removeEntry(db, c, await entryOfAllowed(db, c, id));

/** A new selection's entries in one go (masterRecordService.createRecord): [{ nodeId } | { itemId, isDefault? }]. */
export async function writeEntries(db, c, definitionId, list = []) {
  // A new record has no old columns worth adopting: what it was given IS its list.
  for (const input of list) await addEntry(db, c, definitionId, input ?? {}, { adopt: false });
}

/** Removes every entry and criterion of a definition being deleted. */
export async function deleteSelectionRules(db, c, definitionId) {
  await db.query('DELETE FROM cf_selection_scope WHERE company_id = ? AND definition_id = ?', [c.companyId, definitionId]);
  await db.query('UPDATE cf_definition_allowed_items SET deleted_at = NOW() WHERE company_id = ? AND definition_id = ? AND deleted_at IS NULL', [c.companyId, definitionId]);
  await db.query('UPDATE cf_selection_criteria SET deleted_at = NOW() WHERE company_id = ? AND definition_id = ? AND deleted_at IS NULL', [c.companyId, definitionId]);
}

/** How many entries a selection has (its old columns' translation while it has none) — what activation asks. */
export async function entryCount(db, companyId, definitionId) {
  return (await entriesOf(db, companyId, definitionId)).length;
}

async function readCriterion(db, companyId, input, problems) {
  const [[spec]] = await db.query('SELECT * FROM cf_specifications WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, input.specificationId]);
  if (!spec) { problems.push('Choose a specification.'); return null; }
  const operator = input.operator ?? 'eq';
  const allowed = OPERATORS[spec.data_type] ?? [];
  if (!allowed.includes(operator)) problems.push(`${spec.code} (${spec.data_type}) can be compared with ${allowed.join(', ')}.`);
  const out = await coerce(db, companyId, spec, input.value);
  if (out.problem) problems.push(out.problem);
  else if (!out.typed) problems.push(`${spec.code} needs a value to compare with.`);
  let valueTo = null;
  if (operator === 'between') {
    if (spec.data_type !== 'number') problems.push('Between works on numbers.');
    valueTo = Number(input.valueTo);
    if (!Number.isFinite(valueTo)) problems.push('Between needs an upper bound.');
    else if (out.typed && valueTo < out.typed.value_number) problems.push('The upper bound is below the lower bound.');
  }
  return { spec, operator, typed: out.typed, valueTo };
}

export async function addCriterion(db, c, definitionId, input = {}) {
  await requireSelection(db, c.companyId, definitionId);
  const problems = [];
  const crit = await readCriterion(db, c.companyId, input, problems);
  assertNoProblems(problems, 'The criterion has problems.');
  const t = crit.typed;
  await db.query(
    `INSERT INTO cf_selection_criteria
       (company_id, definition_id, specification_id, operator, value_number, value_number_to, value_text, value_bool, value_date, option_id, sort_order, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [c.companyId, definitionId, crit.spec.id, crit.operator, t.value_number, crit.valueTo, t.value_text, t.value_bool, t.value_date,
      t.option_id, Number(input.sortOrder) || 0, c.userId],
  );
  return getSelection(db, c.companyId, definitionId);
}

export async function updateCriterion(db, c, id, input = {}) {
  const [[row]] = await db.query('SELECT * FROM cf_selection_criteria WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [c.companyId, id]);
  if (!row) throw notFound('Criterion');
  const problems = [];
  const crit = await readCriterion(db, c.companyId, { specificationId: row.specification_id, ...input }, problems);
  assertNoProblems(problems, 'The criterion has problems.');
  const t = crit.typed;
  await db.query(
    `UPDATE cf_selection_criteria
        SET specification_id = ?, operator = ?, value_number = ?, value_number_to = ?, value_text = ?, value_bool = ?, value_date = ?, option_id = ?
      WHERE company_id = ? AND id = ?`,
    [crit.spec.id, crit.operator, t.value_number, crit.valueTo, t.value_text, t.value_bool, t.value_date, t.option_id, c.companyId, id],
  );
  return getSelection(db, c.companyId, row.definition_id);
}

export async function removeCriterion(db, c, id) {
  const [[row]] = await db.query('SELECT * FROM cf_selection_criteria WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [c.companyId, id]);
  if (!row) throw notFound('Criterion');
  await db.query('UPDATE cf_selection_criteria SET deleted_at = NOW() WHERE company_id = ? AND id = ?', [c.companyId, id]);
  return getSelection(db, c.companyId, row.definition_id);
}

/** One SQL condition for one criterion, against the value alias `v`. */
function criterionSql(c) {
  switch (c.data_type) {
    case 'number':
      if (c.operator === 'between') return { sql: 'v.value_number BETWEEN ? AND ?', params: [c.value_number, c.value_number_to] };
      return { sql: `v.value_number ${SQL_OP[c.operator]} ?`, params: [c.value_number] };
    case 'date':
      return { sql: `v.value_date ${SQL_OP[c.operator]} ?`, params: [c.value_date] };
    case 'text': return { sql: `LOWER(v.value_text) ${SQL_OP[c.operator]} LOWER(?)`, params: [c.value_text] };
    case 'option': return { sql: `v.option_id ${SQL_OP[c.operator]} ?`, params: [c.option_id] };
    case 'boolean': return { sql: 'v.value_bool = ?', params: [c.value_bool] };
    default: return { sql: '0 = 1', params: [] };
  }
}

/**
 * The catalog items a selection resolves to right now: active, catalog, inside
 * the UNION of its entries (a branch's whole subtree, or the item itself), and
 * meeting every spec filter. Each comes with the values the criteria looked at,
 * so a person can see why it matched. The default (a starred item entry) comes
 * first — only when it is itself a candidate.
 */
export async function findCandidates(db, companyId, definitionId, { limit = 200, itemId = null, search = null } = {}) {
  await requireSelection(db, companyId, definitionId);
  const [entries, [criteria]] = await Promise.all([
    entriesOf(db, companyId, definitionId),
    db.query(
      `SELECT c.*, s.data_type, s.code AS spec_code FROM cf_selection_criteria c JOIN cf_specifications s ON s.id = c.specification_id
        WHERE c.company_id = ? AND c.definition_id = ? AND c.deleted_at IS NULL`,
      [companyId, definitionId],
    ),
  ]);
  const mode = derivedMode(entries);
  if (!entries.length) {
    return { mode, candidates: [], total: 0, truncated: false, note: 'It picks from nothing yet — add a branch of the classification or a catalog item.' };
  }
  const nodeIds = await subtreesOf(db, companyId, entries.filter((e) => e.node_id != null).map((e) => e.node_id));
  const itemIds = entries.filter((e) => e.item_id != null).map((e) => Number(e.item_id));
  const defaultId = Number(entries.find((e) => e.item_id != null && e.is_default)?.item_id ?? 0);

  const where = ['m.company_id = ?', 'm.deleted_at IS NULL', "m.status = 'active'", "i.item_type = 'catalog'"];
  const params = [companyId];
  const scope = [];
  if (nodeIds.length) { scope.push('m.classification_id IN (?)'); params.push(nodeIds); }
  if (itemIds.length) { scope.push('m.id IN (?)'); params.push(itemIds); }
  where.push(`(${scope.join(' OR ')})`);

  const bySpec = new Map();
  for (const c of criteria) {
    if (!bySpec.has(c.specification_id)) bySpec.set(c.specification_id, []);
    bySpec.get(c.specification_id).push(c);
  }
  for (const [specId, group] of bySpec) {
    const parts = group.map(criterionSql);
    where.push(`EXISTS (SELECT 1 FROM cf_spec_values v
                         WHERE v.company_id = m.company_id AND v.subject_type = 'master' AND v.subject_id = m.id
                           AND v.specification_id = ? AND v.deleted_at IS NULL AND (${parts.map((p) => p.sql).join(' OR ')}))`);
    params.push(specId, ...parts.flatMap((p) => p.params));
  }

  // One item only (a pick being checked) — the check must not depend on how many candidates come before it.
  if (itemId !== null && itemId !== undefined && itemId !== '') { where.push('m.id = ?'); params.push(Number(itemId)); }
  const like = likeOf(search);
  if (like) { where.push('(m.code LIKE ? OR m.name LIKE ?)'); params.push(like, like); }
  const cap = Math.min(Number(limit) || 200, 1000);

  // The rows and the true count (same WHERE) together, so the screen can say "showing N of M".
  const FROM = `FROM cf_master_records m
       JOIN cf_item_details i ON i.master_id = m.id AND i.deleted_at IS NULL
       LEFT JOIN cf_classification_nodes c ON c.id = m.classification_id
      WHERE ${where.join(' AND ')}`;
  const [[rows], [[counted]]] = await Promise.all([
    db.query(`SELECT m.id, m.code, m.name, m.revision, c.name AS classification_name ${FROM} ORDER BY (m.id = ?) DESC, m.code LIMIT ?`, [...params, defaultId, cap]),
    db.query(`SELECT COUNT(*) AS n ${FROM}`, params),
  ]);
  const total = Number(counted.n);

  const specIds = [...bySpec.keys()];
  const shown = new Map();
  if (rows.length && specIds.length) {
    const [vals] = await db.query(
      `SELECT v.*, s.code AS spec_code, s.data_type, s.default_uom, o.value AS option_value
         FROM cf_spec_values v JOIN cf_specifications s ON s.id = v.specification_id LEFT JOIN cf_spec_options o ON o.id = v.option_id
        WHERE v.company_id = ? AND v.subject_type = 'master' AND v.subject_id IN (?) AND v.specification_id IN (?) AND v.deleted_at IS NULL`,
      [companyId, rows.map((r) => r.id), specIds],
    );
    for (const v of vals) {
      if (!shown.has(v.subject_id)) shown.set(v.subject_id, []);
      const raw = v.data_type === 'option' ? v.option_value : rawOf(v, v.data_type);
      shown.get(v.subject_id).push({ specCode: v.spec_code, value: raw, unit: v.default_uom, source: v.source });
    }
  }
  return {
    mode,
    total,
    truncated: total > rows.length,
    candidates: rows.map((r) => ({
      id: r.id, code: r.code, name: r.name, revision: r.revision, classificationName: r.classification_name,
      isDefault: r.id === defaultId, matchedValues: shown.get(r.id) ?? [],
    })),
  };
}

/** The catalog item the system may choose on its own: the default when it is a candidate, else the only candidate. */
export async function automaticPick(db, companyId, selectionId) {
  const { candidates } = await findCandidates(db, companyId, selectionId, { limit: 2 });
  if (!candidates.length) return null;
  if (candidates[0].isDefault) return candidates[0];
  return candidates.length === 1 ? candidates[0] : null;
}

/** Whether a record is filed as a cut plate (Setup › Cutting) — a selection under it is the raw plate nesting chooses. */
export async function isCutPlateRecord(db, companyId, masterId) {
  const [[r]] = await db.query(
    `SELECT pm.id FROM cf_master_records pm
      WHERE pm.company_id = ? AND pm.id = ? AND NOT ${NOT_UNDER_CUT_PLATE_WHERE}`,
    [companyId, masterId],
  );
  return !!r;
}

/**
 * Chooses, on its own, every selection row of an editable order line that the
 * system can answer (automaticPick) and nobody has touched: auto_chosen IS NULL
 * (a person's choice — or a person clearing one — writes 0, so it is never
 * overruled). Never a cut plate's raw plate. Set-based: one read of the rows,
 * one candidate read per DISTINCT selection, one UPDATE per pick.
 * Returns { filled, parents } — the caller refreshes values when filled.
 */
export async function autofillLineSelections(db, c, lineId, { refresh } = {}) {
  const [[line]] = await db.query(
    `SELECT l.id, l.locked_at, o.status,
            (SELECT COUNT(*) FROM cf_production_releases r WHERE r.company_id = l.company_id AND r.order_line_id = l.id AND r.deleted_at IS NULL) AS released
       FROM cf_sales_order_lines l JOIN cf_sales_orders o ON o.id = l.order_id AND o.deleted_at IS NULL
      WHERE l.company_id = ? AND l.id = ? AND l.deleted_at IS NULL`,
    [c.companyId, lineId],
  );
  if (!line || line.locked_at || Number(line.released) || LOCKED_ORDER_STATUSES.has(line.status)) return { filled: 0, parents: [] };
  const [rows] = await db.query(
    `SELECT l.id, l.selection_definition_id, b.parent_id
       FROM cf_bom_lines l
       JOIN cf_boms b ON b.id = l.bom_id AND b.deleted_at IS NULL
       JOIN cf_item_details pi ON pi.master_id = b.parent_id AND pi.deleted_at IS NULL
       JOIN cf_master_records pm ON pm.id = b.parent_id AND pm.deleted_at IS NULL
       JOIN cf_master_records ch ON ch.id = l.child_id AND ch.record_kind = 'definition'
       ${PARENT_CLASS_JOIN}
      WHERE l.company_id = ? AND l.deleted_at IS NULL AND l.selection_definition_id IS NOT NULL AND l.auto_chosen IS NULL
        AND pi.owner_order_line_id = ? AND ${NOT_UNDER_CUT_PLATE_WHERE}`,
    [c.companyId, lineId],
  );
  if (!rows.length) return { filled: 0, parents: [] };
  const bySel = new Map();
  for (const r of rows) {
    if (!bySel.has(r.selection_definition_id)) bySel.set(r.selection_definition_id, []);
    bySel.get(r.selection_definition_id).push(r);
  }
  let filled = 0;
  const parents = new Set();
  for (const [selId, list] of bySel) {
    const pick = await automaticPick(db, c.companyId, selId);
    if (!pick) continue;
    await db.query('UPDATE cf_bom_lines SET child_id = ?, auto_chosen = 1 WHERE company_id = ? AND id IN (?)', [pick.id, c.companyId, list.map((r) => r.id)]);
    filled += list.length;
    for (const r of list) parents.add(r.parent_id);
  }
  if (filled && refresh) await refresh([...parents]);
  return { filled, parents: [...parents] };
}
