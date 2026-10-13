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
import { PERM, guard } from '../lib/http.js';
import { companyWide } from '../lib/gates.js';

const router = Router();
const on = (req, res, next) => next();
const whole = companyWide('Code formats belong to the whole company. Your access covers your own department only.');

router.get('/codegen/entities', guard(PERM.setup.view), on);
router.get('/codegen/schemes', guard(PERM.setup.view), on);
router.get('/codegen/schemes/:id', guard(PERM.setup.view), on);
router.post('/codegen/preview', guard(PERM.setup.view), on);
router.post('/codegen/explain', guard(PERM.setup.view), on);
router.post('/codegen/schemes', guard(PERM.setup.edit), whole, on);
router.put('/codegen/schemes/:id', guard(PERM.setup.edit), whole, on);
router.delete('/codegen/schemes/:id', guard(PERM.setup.remove, { also: [PERM.setup.edit] }), whole, on);

export default router;
