/**
 * access.js — logins and access roles. (TM/CF_HRMS_HIRING_SPEC.md §12.5.)
 *
 *   GET    /access/me                             any login: { role: { id, label, scope }, tags, scope: { all, departmentNames } }
 *
 *   GET    /access/catalog                        { areas, named, templates } — the tick-box table
 *   GET    /access/roles                          { roles: AccessRole[] }
 *   POST   /access/roles                          { label, description?, scope, copyFrom?: roleId | templateKey }   -> { role }
 *   PUT    /access/roles/:roleId                  { label?, description?, scope?, tags? } — `tags` REPLACES the rights
 *                                                 -> { role, loginsAffected }; 422 INVALID, 409 LOCKED (the Owner)
 *   DELETE /access/roles/:roleId                  409 IN_USE (detail.logins), 409 LOCKED (Owner, Employee)
 *
 *   GET    /access/logins                         ?q=&roleId=&state=ACTIVE|DISABLED  -> { logins, withoutLogin }
 *   POST   /access/logins                         { employeeId, email, roleId }  -> { login, password } — the password ONCE
 *   PUT    /access/logins/:userId                 { roleId?, email? }            -> { login }; 409 LAST_OWNER, 409 SELF
 *   POST   /access/logins/:userId/disable         -> { login }; 409 SELF, 409 LAST_OWNER
 *   POST   /access/logins/:userId/enable          -> { login }
 *   POST   /access/logins/:userId/reset-password  -> { password } — a new one, ONCE
 *
 * Everything but /access/me needs `cf_hrms_access_manage`; the Owner holds it.
 * On top of that, services/accessService.js keeps its own rules: only an Owner
 * touches an Owner, and nobody gives a right they do not hold (403 OWNER_ONLY,
 * 403 CANNOT_GRANT).
 *
 * A password is in the answer of the request that made it and nowhere else.
 * Nothing here logs a request or a response body.
 */
import { Router } from 'express';
import { pool, withTransaction } from '../lib/db.js';
import { PERM, guard, handle, ctx, intParam } from '../lib/http.js';
import { forgetAccess } from '../lib/accessContext.js';
import {
  getCatalog, listRoles, createRole, updateRole, deleteRole,
  listLogins, createLogin, updateLogin, disableLogin, enableLogin, resetPassword, me,
} from '../services/accessService.js';

const router = Router();
// Forgotten again once the transaction is over: a request that read the old role while this one was
// still open must not leave it remembered.
const tx = (req, fn) => withTransaction((db) => fn(db, ctx(req))).finally(forgetAccess);
const reqId = (req) => req.id ?? req.headers['x-request-id'] ?? null;
const manage = guard(PERM.accessManage);
const roleId = (req) => intParam(req.params.roleId, 'roleId');
const userId = (req) => intParam(req.params.userId, 'userId');

router.get('/access/me', guard(PERM.signedIn), handle((req) => me(pool, ctx(req), req.hrmsAccess)));

router.get('/access/catalog', manage, handle(async () => getCatalog()));

router.get('/access/roles', manage, handle((req) => listRoles(pool, ctx(req).companyId)));
router.post('/access/roles', manage, handle((req) => tx(req, (db, c) => createRole(db, c, req.body ?? {}, reqId(req)))));
router.put('/access/roles/:roleId', manage, handle((req) => tx(req, (db, c) => updateRole(db, c, roleId(req), req.body ?? {}, reqId(req)))));
router.delete('/access/roles/:roleId', manage, handle((req) => tx(req, (db, c) => deleteRole(db, c, roleId(req), reqId(req)))));

router.get('/access/logins', manage, handle((req) => listLogins(pool, ctx(req), req.query)));
router.post('/access/logins', manage, handle((req) => tx(req, (db, c) => createLogin(db, c, req.body ?? {}, reqId(req)))));
router.put('/access/logins/:userId', manage, handle((req) => tx(req, (db, c) => updateLogin(db, c, userId(req), req.body ?? {}, reqId(req)))));
router.post('/access/logins/:userId/disable', manage, handle((req) => tx(req, (db, c) => disableLogin(db, c, userId(req), reqId(req)))));
router.post('/access/logins/:userId/enable', manage, handle((req) => tx(req, (db, c) => enableLogin(db, c, userId(req), reqId(req)))));
router.post('/access/logins/:userId/reset-password', manage, handle((req) => tx(req, (db, c) => resetPassword(db, c, userId(req), reqId(req)))));

export default router;
