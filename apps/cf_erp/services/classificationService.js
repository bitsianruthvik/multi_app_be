/**
 * classificationService.js — the Family > Subfamily > Variant tree.
 *
 * Rules the database cannot hold on its own (TiDB ignores CHECK):
 *   - a node's depth is its parent's depth + 1, and no deeper than the Variant;
 *   - a node moves only to a new parent on the same level, so depths below it
 *     never need rewriting;
 *   - a node is deleted only when nothing lives under it — no child nodes, no
 *     items, definitions or machines, no selection definition searching it, no
 *     coding rule testing it, no operation timing set on it. Its own spec rules
 *     and default values go with it;
 *   - scope 'machine' belongs to a whole Family: every level below a machine
 *     Family is a machine level, machines sit only on its deepest level (their
 *     machine type), and items and definitions never do.
 */
import { invalid, conflict, assertNoProblems } from '../lib/errors.js';
import { LEAF_DEPTH, LEVELS, levelName, requireNode, ancestors } from './tree.js';
import { deleteAllForSubject as deleteValues, rematerialize } from './valueService.js';
import { deleteAllForSubject as deleteRules } from './assignmentService.js';
import { findConditionsReferencing } from '../modules/codegen/index.js';

const CODE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const SCOPES = ['item', 'definition', 'both', 'machine'];
const isMachineScope = (node) => node?.scope === 'machine';

export async function listTree(db, companyId) {
  const [nodes] = await db.query(
    `SELECT n.id, n.parent_id, n.depth, n.scope, n.code, n.name, n.description, n.sort_order, n.status,
            (SELECT COUNT(*) FROM cf_master_records m WHERE m.company_id = n.company_id AND m.classification_id = n.id AND m.deleted_at IS NULL AND m.record_kind = 'item') AS item_count,
            (SELECT COUNT(*) FROM cf_master_records m WHERE m.company_id = n.company_id AND m.classification_id = n.id AND m.deleted_at IS NULL AND m.record_kind = 'definition') AS definition_count,
            (SELECT COUNT(*) FROM cf_spec_assignments a WHERE a.company_id = n.company_id AND a.subject_type = 'classification' AND a.subject_id = n.id AND a.deleted_at IS NULL) AS rule_count,
            (SELECT COUNT(*) FROM cf_machines mc WHERE mc.company_id = n.company_id AND mc.classification_id = n.id AND mc.deleted_at IS NULL) AS machine_count
       FROM cf_classification_nodes n
      WHERE n.company_id = ? AND n.deleted_at IS NULL
      ORDER BY n.depth, n.sort_order, n.name`,
    [companyId],
  );
  const byId = new Map(nodes.map((n) => [n.id, {
    id: n.id, parentId: n.parent_id, depth: n.depth, level: levelName(n.depth), scope: n.scope,
    code: n.code, name: n.name, description: n.description, sortOrder: n.sort_order, status: n.status,
    itemCount: Number(n.item_count), definitionCount: Number(n.definition_count), ruleCount: Number(n.rule_count),
    machineCount: Number(n.machine_count),
    children: [],
  }]));
  const roots = [];
  for (const node of byId.values()) {
    if (node.parentId && byId.has(node.parentId)) byId.get(node.parentId).children.push(node);
    else roots.push(node);
  }
  return { levels: LEVELS, leafDepth: LEAF_DEPTH, roots };
}

function validateFields(input, problems, { partial = false } = {}) {
  const out = {};
  if (!partial || input.code !== undefined) {
    const code = String(input.code ?? '').trim();
    if (!code || !CODE_RE.test(code) || code.length > 50) problems.push('Code: up to 50 letters, digits, "_", "-" or ".", no spaces.');
    out.code = code;
  }
  if (!partial || input.name !== undefined) {
    const name = String(input.name ?? '').trim();
    if (!name || name.length > 255) problems.push('Name is required (up to 255 characters).');
    out.name = name;
  }
  if (input.scope !== undefined) {
    if (!SCOPES.includes(input.scope)) problems.push('Scope is item, definition, both or machine.');
    out.scope = input.scope;
  }
  if (input.description !== undefined) out.description = input.description ? String(input.description) : null;
  if (input.sortOrder !== undefined) out.sort_order = Number(input.sortOrder) || 0;
  if (input.status !== undefined) {
    if (!['active', 'inactive'].includes(input.status)) problems.push('Status is active or inactive.');
    out.status = input.status;
  }
  return out;
}

export async function createNode(db, c, input = {}) {
  const problems = [];
  const fields = validateFields(input, problems);
  let depth = 0;
  let parentId = null;
  if (input.parentId != null) {
    const parent = await requireNode(db, c.companyId, input.parentId, 'Parent node');
    if (parent.depth >= LEAF_DEPTH) problems.push(`A ${levelName(parent.depth)} cannot have children.`);
    depth = parent.depth + 1;
    parentId = parent.id;
    if (isMachineScope(parent)) {
      if (fields.scope && fields.scope !== 'machine') problems.push(`${parent.name} is a machine family — every level under it is for machines.`);
      fields.scope = 'machine';
    } else if (fields.scope === 'machine') {
      problems.push('Machines start at the Family: make a Family with scope Machine and build its levels under it.');
    }
  }
  assertNoProblems(problems);
  const [r] = await db.query(
    `INSERT INTO cf_classification_nodes (company_id, parent_id, depth, scope, code, name, description, sort_order, status, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [c.companyId, parentId, depth, fields.scope ?? 'both', fields.code, fields.name, fields.description ?? null,
      fields.sort_order ?? 0, fields.status ?? 'active', c.userId],
  );
  return getNode(db, c.companyId, r.insertId);
}

export async function updateNode(db, c, id, input = {}) {
  const node = await requireNode(db, c.companyId, id);
  const problems = [];
  const fields = validateFields(input, problems, { partial: true });
  if (fields.scope !== undefined && (fields.scope === 'machine') !== isMachineScope(node)) {
    if (node.depth > 0) problems.push('Scope Machine is set on the Family — the levels under it follow it.');
    else if (await hasAnythingBelow(db, c.companyId, node.id)) problems.push(`${node.name} already has levels or records under it — scope Machine can only be switched on an empty Family.`);
  }
  let movedTo = null;
  if (input.parentId !== undefined && (input.parentId ?? null) !== node.parent_id) {
    if (node.depth === 0 || input.parentId == null) problems.push('A Family stays a Family; only lower levels move between parents.');
    else {
      const parent = await requireNode(db, c.companyId, input.parentId, 'New parent');
      if (parent.depth !== node.depth - 1) problems.push(`A ${levelName(node.depth)} moves under a ${levelName(node.depth - 1)}.`);
      if (isMachineScope(parent) !== isMachineScope(node)) problems.push('Machine levels stay under machine families, and item levels under item families.');
      movedTo = parent.id;
    }
  }
  assertNoProblems(problems);
  const sets = Object.keys(fields).map((k) => `${k} = ?`);
  const params = Object.values(fields);
  if (movedTo) { sets.push('parent_id = ?'); params.push(movedTo); }
  if (sets.length) {
    await db.query(`UPDATE cf_classification_nodes SET ${sets.join(', ')} WHERE company_id = ? AND id = ?`, [...params, c.companyId, id]);
  }
  // A move changes which rules and defaults reach everything below.
  if (movedTo) await rematerialize(db, c, { classificationId: id });
  return getNode(db, c.companyId, id);
}

async function hasAnythingBelow(db, companyId, id) {
  const [[r]] = await db.query(
    `SELECT (SELECT COUNT(*) FROM cf_classification_nodes WHERE company_id = ? AND parent_id = ? AND deleted_at IS NULL)
          + (SELECT COUNT(*) FROM cf_master_records WHERE company_id = ? AND classification_id = ? AND deleted_at IS NULL)
          + (SELECT COUNT(*) FROM cf_machines WHERE company_id = ? AND classification_id = ? AND deleted_at IS NULL) AS n`,
    [companyId, id, companyId, id, companyId, id],
  );
  return Number(r.n) > 0;
}

export async function deleteNode(db, c, id) {
  const node = await requireNode(db, c.companyId, id);
  const reasons = [];
  const count = async (sql, params) => Number((await db.query(sql, params))[0][0].n);
  const children = await count('SELECT COUNT(*) AS n FROM cf_classification_nodes WHERE company_id = ? AND parent_id = ? AND deleted_at IS NULL', [c.companyId, id]);
  if (children) reasons.push(`${children} node(s) below it`);
  const records = await count('SELECT COUNT(*) AS n FROM cf_master_records WHERE company_id = ? AND classification_id = ? AND deleted_at IS NULL', [c.companyId, id]);
  if (records) reasons.push(`${records} item(s) or definition(s) classified here`);
  const machines = await count('SELECT COUNT(*) AS n FROM cf_machines WHERE company_id = ? AND classification_id = ? AND deleted_at IS NULL', [c.companyId, id]);
  if (machines) reasons.push(`${machines} machine(s) of this type`);
  const timings = await count(
    `SELECT COUNT(*) AS n FROM cf_operation_machine_rules WHERE company_id = ? AND subject_type = 'classification' AND subject_id = ? AND deleted_at IS NULL`,
    [c.companyId, id],
  );
  if (timings) reasons.push(`${timings} operation timing rule(s) set on it`);
  const searchers = await count('SELECT COUNT(*) AS n FROM cf_definition_details WHERE company_id = ? AND candidate_classification_id = ? AND deleted_at IS NULL', [c.companyId, id]);
  if (searchers) reasons.push(`${searchers} selection definition(s) searching it`);
  const rules = await findConditionsReferencing(db, c.companyId, 'classification', id);
  if (rules.length) reasons.push(`coding rule(s) ${rules.map((r) => r.code).join(', ')}`);
  if (reasons.length) {
    throw conflict('IN_USE', `${node.name} still has ${reasons.join('; ')}.`, { problems: reasons });
  }
  await deleteValues(db, c, 'classification', id);
  await deleteRules(db, c, 'classification', id);
  await db.query('UPDATE cf_classification_nodes SET deleted_at = NOW() WHERE company_id = ? AND id = ?', [c.companyId, id]);
  return { ok: true };
}

export async function getNode(db, companyId, id) {
  const node = await requireNode(db, companyId, id);
  const path = await ancestors(db, companyId, id);
  return {
    id: node.id, parentId: node.parent_id, depth: node.depth, level: levelName(node.depth), scope: node.scope,
    code: node.code, name: node.name, description: node.description, sortOrder: node.sort_order, status: node.status,
    isLeaf: node.depth === LEAF_DEPTH,
    path: path.map((n) => ({ id: n.id, code: n.code, name: n.name, level: levelName(n.depth) })),
  };
}

/** A node items and definitions may sit on: live, active, deepest level, not a machine type. */
export async function requireLeaf(db, companyId, id) {
  if (id == null) throw invalid('INVALID', 'Choose a Variant.');
  const node = await requireNode(db, companyId, id, 'Classification');
  if (node.depth !== LEAF_DEPTH) throw invalid('NOT_A_VARIANT', `${node.name} is a ${levelName(node.depth)} — items and definitions sit on a Variant.`);
  if (isMachineScope(node)) throw invalid('MACHINE_TYPE', `${node.name} is a machine type — items and definitions sit on a Variant of an item family.`);
  if (node.status !== 'active') throw invalid('INACTIVE', `${node.name} is inactive.`);
  return node;
}

/** The machine type a machine sits on: the deepest level of a machine family, live and active. */
export async function requireMachineType(db, companyId, id) {
  if (id == null) throw invalid('INVALID', 'Choose a machine type.');
  const node = await requireNode(db, companyId, id, 'Machine type');
  if (!isMachineScope(node)) throw invalid('NOT_A_MACHINE_TYPE', `${node.name} is not in a machine family — machines sit on the deepest level of a Family with scope Machine.`);
  if (node.depth !== LEAF_DEPTH) throw invalid('NOT_A_MACHINE_TYPE', `${node.name} is a ${levelName(node.depth)} — a machine sits on the deepest level (its machine type).`);
  if (node.status !== 'active') throw invalid('INACTIVE', `${node.name} is inactive.`);
  return node;
}
