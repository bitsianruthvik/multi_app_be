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
import { invalidateNodeCache } from '../lib/nodeCache.js';
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
  invalidateNodeCache(db);
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
  invalidateNodeCache(db);
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

/**
 * What the level below this one is called, for a sentence a person reads. The
 * Machines screen shows these refusals verbatim, and "1 node(s) below it" tells
 * somebody looking at a list of machine types nothing about what is in the way.
 */
function childLevelWord(node, n) {
  if (node.depth === 0) return n === 1 ? 'Subfamily' : 'Subfamilies';
  if (isMachineScope(node)) return n === 1 ? 'machine type' : 'machine types';
  return n === 1 ? 'Variant' : 'Variants';
}

export async function deleteNode(db, c, id) {
  const node = await requireNode(db, c.companyId, id);
  const reasons = [];
  const count = async (sql, params) => Number((await db.query(sql, params))[0][0].n);
  const children = await count('SELECT COUNT(*) AS n FROM cf_classification_nodes WHERE company_id = ? AND parent_id = ? AND deleted_at IS NULL', [c.companyId, id]);
  if (children) reasons.push(`${children} ${childLevelWord(node, children)} below it`);
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
  invalidateNodeCache(db);
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

// ---------------------------------------------------------------------------
// The machine side of the same tree, through its own door.
//
// A machine type IS a classification node — the deepest level of a Family with
// scope Machine, exactly what requireMachineType above insists on. Nothing here
// invents a second tree or a second set of rules: every write goes through
// createNode / updateNode / deleteNode, so depth, scope, uniqueness and the
// in-use checks stay in one place.
//
// The door is the point. Setup › Classification is guarded by the setup grant
// while the Machines screen is guarded by the production grant, so somebody who
// may add a machine could not add the type it needs. These functions give the
// Machines screen the narrow slice it needs — machine families only, never an
// item Variant — without handing it the whole tree.
// ---------------------------------------------------------------------------

/** The machine tree, three levels deep, with how many machines sit on each type. */
export async function listMachineTypes(db, companyId) {
  const [nodes] = await db.query(
    `SELECT n.id, n.parent_id, n.depth, n.code, n.name, n.status,
            (SELECT COUNT(*) FROM cf_machines mc
              WHERE mc.company_id = n.company_id AND mc.classification_id = n.id AND mc.deleted_at IS NULL) AS machine_count
       FROM cf_classification_nodes n
      WHERE n.company_id = ? AND n.deleted_at IS NULL AND n.scope = 'machine'
      ORDER BY n.depth, n.sort_order, n.name`,
    [companyId],
  );
  const families = [];
  const byId = new Map();
  // Ordered by depth, so a parent is always in the map before its children.
  for (const n of nodes) {
    const node = { id: n.id, code: n.code, name: n.name, status: n.status };
    if (n.depth === 0) { node.subfamilies = []; families.push(node); }
    else if (n.depth === 1) { node.types = []; byId.get(n.parent_id)?.subfamilies.push(node); }
    else { node.machineCount = Number(n.machine_count); byId.get(n.parent_id)?.types.push(node); }
    byId.set(n.id, node);
  }
  return { families };
}

/** { id } to use an existing node, or { code, name } to make one. */
function readNodeSpec(raw, label, problems) {
  const spec = raw && typeof raw === 'object' ? raw : {};
  const hasId = spec.id !== undefined && spec.id !== null && String(spec.id).trim() !== '';
  if (hasId) {
    const n = Number(spec.id);
    if (!Number.isInteger(n) || n <= 0) { problems.push(`${label}: pick one from the list, or give a code and a name to make a new one.`); return {}; }
    return { id: n };
  }
  const code = String(spec.code ?? '').trim();
  const name = String(spec.name ?? '').trim();
  if (!code && !name) { problems.push(`Choose a ${label}, or give a code and a name to make a new one.`); return {}; }
  if (!code || !CODE_RE.test(code) || code.length > 50) problems.push(`${label} code: up to 50 letters, digits, "_", "-" or ".", no spaces.`);
  if (!name || name.length > 255) problems.push(`${label} name is required (up to 255 characters).`);
  return { code, name };
}

/**
 * Any level of a machine family — the Family, one of its Subfamilies, or a
 * machine type. The Machines screen owns all three, because a screen that can
 * make a Family inline and then never rename or retire it is the dead end this
 * was built to remove.
 *
 * Inactive is fine: a retired level must still be renameable and removable.
 * NOT_A_MACHINE_TYPE keeps its narrower meaning over in requireMachineType —
 * "this is not something a MACHINE can sit on" — which is a different question
 * with a different caller (machineService, placing a machine).
 */
async function requireMachineNode(db, companyId, id) {
  const node = await requireNode(db, companyId, id, 'Machine family, subfamily or type');
  if (!isMachineScope(node)) {
    throw invalid('NOT_A_MACHINE_NODE',
      `${node.name} is an item ${levelName(node.depth)} — the Machines screen manages machine families, their subfamilies and their types.`);
  }
  return node;
}

/**
 * input: { family: { id } | { code, name }, subfamily: { id } | { code, name }, code, name, description? }
 *
 * The whole chain is checked before a single row is written, so a refusal never
 * leaves a half-made Family behind — the route runs this in one transaction as
 * well, but the order is what decides the message a person gets back.
 */
export async function createMachineType(db, c, input = {}) {
  const problems = [];
  const fields = validateFields(input, problems);
  const famSpec = readNodeSpec(input.family, 'Family', problems);
  const subSpec = readNodeSpec(input.subfamily, 'Subfamily', problems);
  assertNoProblems(problems);

  let family = null;
  if (famSpec.id) {
    const row = await requireNode(db, c.companyId, famSpec.id, 'Machine family');
    if (row.depth !== 0 || !isMachineScope(row)) {
      const why = row.depth !== 0 ? `a ${levelName(row.depth)}` : 'an item family';
      throw invalid('NOT_A_MACHINE_FAMILY', `${row.name} is ${why} — a machine type sits under a Family with scope Machine.`);
    }
    family = { id: row.id, name: row.name };
  }
  let subfamily = null;
  if (subSpec.id) {
    const row = await requireNode(db, c.companyId, subSpec.id, 'Subfamily');
    // No family given: take the one it already sits under.
    if (!family && row.depth === 1 && row.parent_id) {
      const up = await requireNode(db, c.companyId, row.parent_id, 'Machine family');
      if (up.depth !== 0 || !isMachineScope(up)) {
        throw invalid('NOT_A_MACHINE_FAMILY', `${up.name} is not a machine family — a machine type sits under a Family with scope Machine.`);
      }
      family = { id: up.id, name: up.name };
    }
    if (row.depth !== 1 || !family || row.parent_id !== family.id) {
      const under = family ? family.name : 'the family given';
      throw invalid('WRONG_PARENT', `${row.name} is not a Subfamily of ${under} — pick one under it, or give a code and a name to make one.`);
    }
    subfamily = { id: row.id, name: row.name };
  }

  const created = { family: false, subfamily: false };
  if (!family) {
    const made = await createNode(db, c, { code: famSpec.code, name: famSpec.name, scope: 'machine' });
    family = { id: made.id, name: made.name };
    created.family = true;
  }
  if (!subfamily) {
    const made = await createNode(db, c, { parentId: family.id, code: subSpec.code, name: subSpec.name, scope: 'machine' });
    subfamily = { id: made.id, name: made.name };
    created.subfamily = true;
  }
  const type = await createNode(db, c, {
    parentId: subfamily.id,
    scope: 'machine',
    code: fields.code,
    name: fields.name,
    description: input.description,
    sortOrder: input.sortOrder,
    status: input.status,
  });
  return { id: type.id, code: type.code, name: type.name, familyId: family.id, subfamilyId: subfamily.id, created };
}

/**
 * input: { name?, code?, description?, status? } on any level of a machine
 * family. The node stays where it is — moving one between parents is still a
 * Setup job, because it rewrites what reaches everything below.
 *
 * Retiring a Family does not retire the levels under it: a status is the node's
 * own, here exactly as in Setup.
 */
export async function updateMachineNode(db, c, id, input = {}) {
  await requireMachineNode(db, c.companyId, id);
  const patch = {};
  for (const key of ['name', 'code', 'description', 'status']) if (input[key] !== undefined) patch[key] = input[key];
  if (Object.keys(patch).length) await updateNode(db, c, id, patch);
  return { id };
}

/**
 * Soft delete of any level of a machine family. deleteNode does the refusing:
 * a Family or Subfamily with anything live below it, a type machines still sit
 * on, timing rules, coding rules — each named, with its count, in one sentence.
 */
export async function deleteMachineNode(db, c, id) {
  await requireMachineNode(db, c.companyId, id);
  await deleteNode(db, c, id);
  return { id };
}

/**
 * A classification node made from the catalog screens instead of Setup, so a
 * catalog editor who needs a Variant mid-flow is not stuck behind the setup
 * grant. Narrowed to the item side: this door never makes a machine level.
 */
export async function createCatalogNode(db, c, input = {}) {
  if (input.scope === 'machine') {
    throw invalid('NOT_ALLOWED', 'Scope Machine is not set from here — machine types are managed on the Machines screen.');
  }
  if (input.parentId != null) {
    const parent = await requireNode(db, c.companyId, input.parentId, 'Parent node');
    if (isMachineScope(parent)) {
      const what = parent.depth === 0 ? 'is a machine family' : 'is inside a machine family';
      throw invalid('NOT_ALLOWED', `${parent.name} ${what} — machine types are managed on the Machines screen.`);
    }
  }
  const node = await createNode(db, c, {
    parentId: input.parentId ?? null,
    code: input.code,
    name: input.name,
    description: input.description,
    scope: input.scope,
    sortOrder: input.sortOrder,
  });
  return { id: node.id, code: node.code, name: node.name, depth: node.depth, scope: node.scope };
}
