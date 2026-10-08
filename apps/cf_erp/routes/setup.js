/**
 * setup.js — the configuration side: classification, specifications and their
 * options, formulas, spec rules, and default values on classification nodes.
 *
 * The tree has two other doors, both narrowed and each with its own grant, so
 * that needing a new node mid-flow is not a reason to hand out the setup grant:
 * POST /catalog/classification (records.js, catalog grant, item side only) and
 * POST /machine-types (production.js, production grant, machine side only).
 * Since 2026-10-02 the writes below take the grant of the SIDE they touch (the
 * screens manage their own branches); rules and defaults on a node stay setup.
 *
 *   GET    /classification                     the tree with counts
 *   GET    /classification?screen=items|definitions|machines(&all=1)   one screen's DERIVED tree, subtree counts, visibleBecause
 *   GET    /classification/:id                 one node with its path
 *   GET    /classification/:id/resolved        rules and defaults reaching the node
 *   POST   /classification                     { parentId?, code, name, scope?, description?, sortOrder?, createdIn? }  (catalog, production or setup grant by side)
 *   PUT    /classification/:id                 same fields, and parentId to move within a level
 *   DELETE /classification/:id
 *   PUT    /classification/:id/values          { values: [{ specCode | specificationId, value }] }  defaults
 *   GET    /classification/:id/history         value history of the node's defaults
 *
 *   GET    /specifications                     library with options and usage
 *   POST   /specifications                     { code, name, dataType, measurementType?, defaultUom?, decimals?, options?, tableConfig? }
 *                                              tableConfig (dataType 'table'): { axes: [{ label, unit? }, { label, unit? }?], mode? }
 *   PUT    /specifications/:id                 code is permanent
 *   DELETE /specifications/:id
 *   POST   /specifications/:id/options         { value, label? }
 *   PUT    /spec-options/:id                   { value?, label?, sortOrder?, status? }
 *   DELETE /spec-options/:id
 *
 *   GET    /formulas
 *   POST   /formulas/check                     { expression, sample?, itemId?, machineId? } -> parse result, names, sample result (on a real piece / machine when given, + inputs)
 *   POST   /formulas                           { code, name, expression, description? }
 *   PUT    /formulas/:id
 *   DELETE /formulas/:id
 *
 *   GET    /rules?subjectType=&subjectId=      rules attached to one subject
 *   POST   /rules                              { specificationId, subjectType, subjectId, captureAt, valueRule, isRequired, isApplicable, formulaId?, optionIds? }
 *   PUT    /rules/:id
 *   DELETE /rules/:id
 */
import { Router } from 'express';
import { pool, withTransaction } from '../lib/db.js';
import { PERM, guard, guardAny, assertAnyPerm, handle, ctx, intParam } from '../lib/http.js';
import { requireNode } from '../services/tree.js';
import { screenTree } from '../services/classificationScreenService.js';
import { listTree, getNode, createNode, updateNode, deleteNode } from '../services/classificationService.js';
import { resolve, publicResolution } from '../services/resolutionService.js';
import { setValues, getHistory } from '../services/valueService.js';
import { listSpecs, createSpec, updateSpec, deleteSpec, addOption, updateOption, deleteOption } from '../services/specificationService.js';
import { listFormulas, checkFormula, createFormula, updateFormula, deleteFormula } from '../services/formulaService.js';
import { chartBindings } from '../services/chartService.js';
import { expandCharts } from '../lib/chartFormula.js';
import { checkForBuilder } from '../services/formulaBuilderService.js';
import { listRules, createRule, updateRule, deleteRule } from '../services/assignmentService.js';

const router = Router();
const tx = (req, fn) => withTransaction((db) => fn(db, ctx(req)));

// ----- classification ------------------------------------------------------
// ?screen=items|definitions|machines → the part of the tree that screen shows,
// derived (classificationScreenService), with per-node subtree counts and why
// each node is there; &all=1 → the whole side, hidden nodes flagged (pickers).
// Without ?screen it is the whole tree, as before. Machines is readable with
// the production grant, because that is what the Machines screen holds.
router.get('/classification', guardAny(PERM.view, PERM.productionView), handle((req) => {
  const screen = req.query.screen;
  if (!screen) {
    assertAnyPerm(req, PERM.view);
    return listTree(pool, ctx(req).companyId);
  }
  if (screen === 'machines') assertAnyPerm(req, PERM.view, PERM.productionView);
  else assertAnyPerm(req, PERM.view);
  return screenTree(pool, ctx(req).companyId, String(screen), { all: ['1', 'true'].includes(String(req.query.all ?? '')) });
}));
router.get('/classification/:id', guard(PERM.view), handle((req) => getNode(pool, ctx(req).companyId, intParam(req.params.id))));
router.get('/classification/:id/resolved', guard(PERM.view), handle(async (req) => {
  const r = await resolve(pool, ctx(req).companyId, { nodeId: intParam(req.params.id) });
  return publicResolution(r);
}));

/**
 * The tree is managed from the screens that use it (2026-10-02), so the write
 * doors follow the side of the tree a write touches: an item/definition branch
 * takes the catalog grant (or setup), a machine branch the production grant (or
 * setup), and flipping a Family across the machine line takes setup itself.
 * Spec rules and default values on a node stay setup-only (below).
 */
async function assertDoor(req, db, { parentId, nodeId, scope }) {
  const { companyId } = ctx(req);
  let machine = scope === 'machine';
  let crosses = false;
  if (nodeId) {
    const node = await requireNode(db, companyId, nodeId);
    if (scope !== undefined && (scope === 'machine') !== (node.scope === 'machine')) crosses = true;
    machine = machine || node.scope === 'machine';
  }
  if (parentId != null) {
    const parent = await requireNode(db, companyId, parentId, 'Parent node');
    machine = machine || parent.scope === 'machine';
  }
  if (crosses) assertAnyPerm(req, PERM.setup);
  else if (machine) assertAnyPerm(req, PERM.setup, PERM.production);
  else assertAnyPerm(req, PERM.setup, PERM.catalog);
}
const writeDoor = guardAny(PERM.setup, PERM.catalog, PERM.production);
router.post('/classification', writeDoor, handle((req) => tx(req, async (db, c) => {
  const body = req.body ?? {};
  await assertDoor(req, db, { parentId: body.parentId ?? null, scope: body.scope });
  // Setup's own callers never said where they were; 'setup' shows on both catalog screens.
  return createNode(db, c, { ...body, createdIn: body.createdIn ?? 'setup' });
})));
router.put('/classification/:id', writeDoor, handle((req) => tx(req, async (db, c) => {
  const body = req.body ?? {};
  const nodeId = intParam(req.params.id);
  await assertDoor(req, db, { nodeId, parentId: body.parentId ?? null, scope: body.scope });
  // created_in is stamped once, at creation — never edited.
  const { createdIn, ...patch } = body; // eslint-disable-line no-unused-vars
  return updateNode(db, c, nodeId, patch);
})));
router.delete('/classification/:id', writeDoor, handle((req) => tx(req, async (db, c) => {
  const nodeId = intParam(req.params.id);
  await assertDoor(req, db, { nodeId });
  return deleteNode(db, c, nodeId);
})));
router.put('/classification/:id/values', guard(PERM.setup), handle((req) => tx(req, (db, c) => setValues(db, c, 'classification', intParam(req.params.id), req.body?.values))));
router.get('/classification/:id/history', guard(PERM.view), handle((req) => getHistory(pool, ctx(req).companyId, 'classification', intParam(req.params.id), req.query.limit)));

// ----- specifications ------------------------------------------------------
router.get('/specifications', guard(PERM.view), handle((req) => listSpecs(pool, ctx(req).companyId)));
router.post('/specifications', guard(PERM.setup), handle((req) => tx(req, (db, c) => createSpec(db, c, req.body))));
router.put('/specifications/:id', guard(PERM.setup), handle((req) => tx(req, (db, c) => updateSpec(db, c, intParam(req.params.id), req.body))));
router.delete('/specifications/:id', guard(PERM.setup), handle((req) => tx(req, (db, c) => deleteSpec(db, c, intParam(req.params.id)))));
router.post('/specifications/:id/options', guard(PERM.setup), handle((req) => tx(req, (db, c) => addOption(db, c, intParam(req.params.id), req.body))));
router.put('/spec-options/:id', guard(PERM.setup), handle((req) => tx(req, (db, c) => updateOption(db, c, intParam(req.params.id), req.body))));
router.delete('/spec-options/:id', guard(PERM.setup), handle((req) => tx(req, (db, c) => deleteOption(db, c, intParam(req.params.id)))));

// ----- formulas ------------------------------------------------------------
router.get('/formulas', guard(PERM.view), handle((req) => listFormulas(pool, ctx(req).companyId)));
router.post('/formulas/check', guard(PERM.view), handle(async (req) => {
  const raw = req.body ?? {};
  // A chart written by its name is checked as the LOOKUP it stands for (lib/chartFormula), and the answer says so.
  const expanded = typeof raw.expression === 'string' ? expandCharts(raw.expression, await chartBindings(pool, ctx(req).companyId)) : raw.expression;
  const body = { ...raw, expression: expanded };
  const { parsed, ...rest } = body.itemId || body.machineId
    ? await checkForBuilder(pool, ctx(req).companyId, body)
    : await checkFormula(pool, ctx(req).companyId, body.expression, body.sample ?? null);
  return { ok: !!parsed && !rest.problems.length, ...rest, expanded: expanded !== raw.expression ? expanded : null };
}));
router.post('/formulas', guard(PERM.setup), handle((req) => tx(req, (db, c) => createFormula(db, c, req.body))));
router.put('/formulas/:id', guard(PERM.setup), handle((req) => tx(req, (db, c) => updateFormula(db, c, intParam(req.params.id), req.body))));
router.delete('/formulas/:id', guard(PERM.setup), handle((req) => tx(req, (db, c) => deleteFormula(db, c, intParam(req.params.id)))));

// ----- spec rules ----------------------------------------------------------
router.get('/rules', guard(PERM.view), handle((req) => listRules(pool, ctx(req).companyId, req.query.subjectType, intParam(req.query.subjectId, 'subjectId'))));
router.post('/rules', guard(PERM.setup), handle((req) => tx(req, (db, c) => createRule(db, c, req.body))));
router.put('/rules/:id', guard(PERM.setup), handle((req) => tx(req, (db, c) => updateRule(db, c, intParam(req.params.id), req.body))));
router.delete('/rules/:id', guard(PERM.setup), handle((req) => tx(req, (db, c) => deleteRule(db, c, intParam(req.params.id)))));

export default router;
