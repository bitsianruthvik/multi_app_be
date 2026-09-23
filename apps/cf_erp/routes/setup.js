/**
 * setup.js — the configuration side: classification, specifications and their
 * options, formulas, spec rules, and default values on classification nodes.
 *
 *   GET    /classification                     the tree with counts
 *   GET    /classification/:id                 one node with its path
 *   GET    /classification/:id/resolved        rules and defaults reaching the node
 *   POST   /classification                     { parentId?, code, name, scope?, description?, sortOrder? }
 *   PUT    /classification/:id                 same fields, and parentId to move within a level
 *   DELETE /classification/:id
 *   PUT    /classification/:id/values          { values: [{ specCode | specificationId, value }] }  defaults
 *   GET    /classification/:id/history         value history of the node's defaults
 *
 *   GET    /specifications                     library with options and usage
 *   POST   /specifications                     { code, name, dataType, measurementType?, defaultUom?, decimals?, options? }
 *   PUT    /specifications/:id                 code is permanent
 *   DELETE /specifications/:id
 *   POST   /specifications/:id/options         { value, label? }
 *   PUT    /spec-options/:id                   { value?, label?, sortOrder?, status? }
 *   DELETE /spec-options/:id
 *
 *   GET    /formulas
 *   POST   /formulas/check                     { expression, sample? } -> parse result, names, sample result
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
import { PERM, guard, handle, ctx, intParam } from '../lib/http.js';
import { listTree, getNode, createNode, updateNode, deleteNode } from '../services/classificationService.js';
import { resolve, publicResolution } from '../services/resolutionService.js';
import { setValues, getHistory } from '../services/valueService.js';
import { listSpecs, createSpec, updateSpec, deleteSpec, addOption, updateOption, deleteOption } from '../services/specificationService.js';
import { listFormulas, checkFormula, createFormula, updateFormula, deleteFormula } from '../services/formulaService.js';
import { listRules, createRule, updateRule, deleteRule } from '../services/assignmentService.js';

const router = Router();
const tx = (req, fn) => withTransaction((db) => fn(db, ctx(req)));

// ----- classification ------------------------------------------------------
router.get('/classification', guard(PERM.view), handle((req) => listTree(pool, ctx(req).companyId)));
router.get('/classification/:id', guard(PERM.view), handle((req) => getNode(pool, ctx(req).companyId, intParam(req.params.id))));
router.get('/classification/:id/resolved', guard(PERM.view), handle(async (req) => {
  const r = await resolve(pool, ctx(req).companyId, { nodeId: intParam(req.params.id) });
  return publicResolution(r);
}));
router.post('/classification', guard(PERM.setup), handle((req) => tx(req, (db, c) => createNode(db, c, req.body))));
router.put('/classification/:id', guard(PERM.setup), handle((req) => tx(req, (db, c) => updateNode(db, c, intParam(req.params.id), req.body))));
router.delete('/classification/:id', guard(PERM.setup), handle((req) => tx(req, (db, c) => deleteNode(db, c, intParam(req.params.id)))));
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
  const { parsed, ...rest } = await checkFormula(pool, ctx(req).companyId, req.body?.expression, req.body?.sample ?? null);
  return { ok: !!parsed && !rest.problems.length, ...rest };
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
