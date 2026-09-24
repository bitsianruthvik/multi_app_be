/**
 * roles.js — roles, the six reusable content masters, and the ten tables that
 * attach content to a role (plan §7, §5.2, §5.3). Phase 3.
 *
 * The rules all live in services/roleContentService.js; this file is the door.
 *
 * Permissions: `cf_hrms_org_view` reads, `cf_hrms_roles_manage` writes. Reading
 * a role is reading the organisation — anyone who may see the org chart may see
 * what a job is for. Changing the definition of work is a narrower grant.
 *
 *   GET    /roles                              list + readiness (no purpose / no KRAs)
 *   GET    /roles/overview                     the counts the list's StatStrip shows
 *   GET    /roles/departments                  picker source for the role form
 *   POST   /roles                              { roleCode?, title, rolePurpose?, roleSummary?, defaultDepartmentId?, status?, effectiveFrom?, effectiveTo? }
 *   GET    /roles/:id
 *   PUT    /roles/:id                          same fields
 *   DELETE /roles/:id                          soft delete; refused while a position or assignment uses it
 *   GET    /roles/:id/content?on=&scope=       THE grouped read: KRAs with their
 *                                              responsibilities and KPIs nested, then "Additional"
 *
 *   POST   /roles/:id/content/:kind            assign a definition to the role
 *   PUT    /role-content/:kind/:id             edit it — or supersede it, when effectiveFrom moves
 *   DELETE /role-content/:kind/:id?endOn=      end it (closed and retired, never erased)
 *   PUT    /role-content/:kind/:id/group       { roleKraAssignmentId } regroup under a KRA, or null
 *   PUT    /roles/:id/content/:kind/order      { ids: [] } one atomic renumber
 *
 *   GET    /role-masters/:kind                 the catalogue + "used by N roles"
 *   POST   /role-masters/:kind
 *   GET    /role-masters/:kind/:id
 *   PUT    /role-masters/:kind/:id
 *   DELETE /role-masters/:kind/:id             refused while in use, naming the roles
 *   GET    /role-masters/:kind/:id/usage       the roles that use it, for the cross-link
 *
 * `:kind` is a name from the model, not a table: kras · responsibilities · kpis ·
 * skills · qualifications · authorities (masters) and additionally experience ·
 * relationships · conditions (role content). KRA, Responsibility and KPI are
 * three separate kinds here and on every screen, deliberately — plan §2 rule 4.
 */
import { Router } from 'express';
import { pool, withTransaction } from '../lib/db.js';
import { PERM, guard, handle, ctx, intParam, dateParam } from '../lib/http.js';
import {
  listRoles, getRole, createRole, updateRole, deleteRole, rolesOverview, listDepartments,
  getRoleContent, addContent, updateContent, removeContent, reorderContent, regroupContent,
  listMaster, getMaster, masterUsage, createMasterItem, updateMasterItem, deleteMasterItem,
} from '../services/roleContentService.js';

const router = Router();
const tx = (req, fn) => withTransaction((db) => fn(db, ctx(req)));

// ----- the content masters -------------------------------------------------
router.get('/role-masters/:kind', guard(PERM.orgView), handle((req) => listMaster(pool, ctx(req).companyId, req.params.kind)));
router.get('/role-masters/:kind/:id', guard(PERM.orgView), handle((req) => getMaster(pool, ctx(req).companyId, req.params.kind, intParam(req.params.id))));
router.get('/role-masters/:kind/:id/usage', guard(PERM.orgView), handle((req) => masterUsage(pool, ctx(req).companyId, req.params.kind, intParam(req.params.id))));
router.post('/role-masters/:kind', guard(PERM.rolesManage), handle((req) => tx(req, (db, c) => createMasterItem(db, c, req.params.kind, req.body))));
router.put('/role-masters/:kind/:id', guard(PERM.rolesManage), handle((req) => tx(req, (db, c) => updateMasterItem(db, c, req.params.kind, intParam(req.params.id), req.body))));
router.delete('/role-masters/:kind/:id', guard(PERM.rolesManage), handle((req) => tx(req, (db, c) => deleteMasterItem(db, c, req.params.kind, intParam(req.params.id)))));

// ----- roles ---------------------------------------------------------------
// `/roles/overview` and `/roles/departments` sit above `/roles/:id` on purpose:
// Express matches in order and a literal path after a param never runs.
router.get('/roles/overview', guard(PERM.orgView), handle((req) => rolesOverview(pool, ctx(req).companyId)));
router.get('/roles/departments', guard(PERM.orgView), handle((req) => listDepartments(pool, ctx(req).companyId)));
router.get('/roles', guard(PERM.orgView), handle((req) => listRoles(pool, ctx(req).companyId)));
router.post('/roles', guard(PERM.rolesManage), handle((req) => tx(req, (db, c) => createRole(db, c, req.body))));
router.get('/roles/:id', guard(PERM.orgView), handle((req) => getRole(pool, ctx(req).companyId, intParam(req.params.id))));
router.put('/roles/:id', guard(PERM.rolesManage), handle((req) => tx(req, (db, c) => updateRole(db, c, intParam(req.params.id), req.body))));
router.delete('/roles/:id', guard(PERM.rolesManage), handle((req) => tx(req, (db, c) => deleteRole(db, c, intParam(req.params.id)))));

/**
 * The role layer of the content, grouped. Overlays are NOT applied here — that
 * is contentResolver.js in a later phase (plan §2 rule 6). Every row carries
 * `layer: 'ROLE'` and its definition id so the resolver can lay position and
 * assignment overrides on top without asking for this again.
 *
 * `?on=YYYY-MM-DD` reads the content in force on a date (default today).
 * `?scope=all` ignores the dates and returns every live row — what the editor
 * needs, so a future-dated assignment does not disappear while it is being set up.
 */
router.get('/roles/:id/content', guard(PERM.orgView), handle((req) => getRoleContent(
  pool,
  ctx(req).companyId,
  intParam(req.params.id),
  { on: dateParam(req.query.on), scope: req.query.scope === 'all' ? 'all' : 'effective' },
)));

// ----- role content --------------------------------------------------------
router.post('/roles/:id/content/:kind', guard(PERM.rolesManage), handle((req) => tx(req, (db, c) => addContent(db, c, intParam(req.params.id), req.params.kind, req.body))));
router.put('/roles/:id/content/:kind/order', guard(PERM.rolesManage), handle((req) => tx(req, (db, c) => reorderContent(db, c, intParam(req.params.id), req.params.kind, req.body?.ids))));
router.put('/role-content/:kind/:id/group', guard(PERM.rolesManage), handle((req) => tx(req, (db, c) => regroupContent(db, c, req.params.kind, intParam(req.params.id), req.body?.roleKraAssignmentId ?? null))));
router.put('/role-content/:kind/:id', guard(PERM.rolesManage), handle((req) => tx(req, (db, c) => updateContent(db, c, req.params.kind, intParam(req.params.id), req.body))));
router.delete('/role-content/:kind/:id', guard(PERM.rolesManage), handle((req) => tx(req, (db, c) => removeContent(db, c, req.params.kind, intParam(req.params.id), { endOn: req.query.endOn }))));

export default router;
