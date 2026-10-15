/**
 * codegen.js — the rights of the Code formats screen. (TM/CF_HRMS_HIRING_SPEC.md §12.1.)
 *
 * The routes themselves belong to the code generator (apps/cf_erp/modules/codegen),
 * mounted in app.js right AFTER this router. That module takes two tags, one to
 * read and one to write. This router stands in front of it and asks for what
 * the rights table says, route by route — so a rule is DELETED with
 * cf_hrms_setup_remove, which the module alone could not ask for, and the Owner
 * is the Owner by the role this app's access row points at now.
 *
 * Every handler here only lets the request through to the module, which then
 * applies its own check as well (cf_hrms_setup_view to read, cf_hrms_setup_edit
 * to write): deleting a rule therefore needs both edit and remove.
 *
 * A rule is the whole company's: none of it is for a login scoped to a department.
 */
import { Router } from 'express';
import { PERM, guard, ctx } from '../lib/http.js';
import { companyWide } from '../lib/gates.js';
import { pool } from '../lib/db.js';
import { DEPARTMENT_ENTITY, labelConditionsFor } from '../services/codegenOrgProvider.js';
import { readModel } from '../services/labelGroupService.js';

const router = Router();
const on = (req, res, next) => next();

/**
 * LABELS IN GROUPS (spec §15.3). A department rule may test the label of any of
 * the company's groups (`label.<groupId>`). The module's list of what can be
 * tested is the same for every company, so the company's own groups are added
 * to its answer here; and before a rule is checked, this company's groups are
 * read, so the module's check knows their keys (codegenOrgProvider.js).
 */
const withLabelGroups = Object.assign((req, res, next) => {
  const send = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode >= 400 || !body) return send(body);
    const list = Array.isArray(body) ? body : (Array.isArray(body.entities) ? body.entities : null);
    const dept = list?.find((e) => e.entityType === DEPARTMENT_ENTITY);
    if (!dept) return send(body);
    labelConditionsFor(pool, ctx(req).companyId).then((extra) => {
      dept.conditionTokens = [...dept.conditionTokens, ...extra];
      send(body);
    }, () => send(body));
    return res;
  };
  next();
}, { hrmsStep: 'adds the company’s label groups to what a department rule can test' });
const knowsLabelGroups = Object.assign((req, res, next) => {
  readModel(pool, ctx(req).companyId).then(() => next(), next);
}, { hrmsStep: 'reads the company’s label groups first' });
const whole = companyWide('Code formats belong to the whole company. Your access covers your own department only.');

router.get('/codegen/entities', guard(PERM.setup.view), withLabelGroups, on);
router.get('/codegen/schemes', guard(PERM.setup.view), on);
router.get('/codegen/schemes/:id', guard(PERM.setup.view), on);
router.post('/codegen/preview', guard(PERM.setup.view), knowsLabelGroups, on);
router.post('/codegen/explain', guard(PERM.setup.view), knowsLabelGroups, on);
router.post('/codegen/schemes', guard(PERM.setup.edit), whole, knowsLabelGroups, on);
router.put('/codegen/schemes/:id', guard(PERM.setup.edit), whole, knowsLabelGroups, on);
router.delete('/codegen/schemes/:id', guard(PERM.setup.remove, { also: [PERM.setup.edit] }), whole, on);

export default router;
