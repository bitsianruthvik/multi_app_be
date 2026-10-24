/**
 * commands.js — "Do it in words" (TM/CF_HRMS_HIRING_SPEC.md §14).
 *
 *   GET  /commands/actions               the action catalogue, for "Add a step"
 *   GET  /commands/options               the records a step's drop-downs offer (people: the login's scope)
 *   POST /commands/read   { text }       -> { plan: { steps }, notUnderstood, notice, stats }   changes nothing
 *   POST /commands/check  { steps }      -> { steps (each with problems), preview, clean }      changes nothing
 *   POST /commands/apply  { steps, text } -> { created, requestId }   all steps in ONE transaction, or none
 *
 * THE GUARD lets in a login holding any right one of the actions needs
 * (org / roles / positions edit). It is not the real check: every STEP needs the
 * right its own action needs, and a department-scoped login can only act inside
 * its departments — services/commands/plan.js checks both per step and reports a
 * step the login may not do as a problem on that step, never a silent skip.
 *
 * The reader (services/commands/reader.js) runs on this server; nothing typed
 * here leaves it.
 */
import { Router } from 'express';
import { pool } from '../lib/db.js';
import { PERM, guard, handle, ctx, can } from '../lib/http.js';
import { invalid } from '../lib/errors.js';
import { scopeOf } from '../services/accessScope.js';
import { catalogue } from '../services/commands/actions/index.js';
import { readCommand } from '../services/commands/reader.js';
import { checkPlan, applyPlan, actorOf } from '../services/commands/plan.js';
import { loadRecords, labelOf } from '../services/commands/records.js';

const router = Router();
const ANY_ACTION = [PERM.org.edit, PERM.roles.edit, PERM.positions.edit];
const NOTE = 'each step also needs its own action\'s right (org edit / roles edit / positions edit) and the login\'s org unit scope — checked per step';
const actor = (req) => actorOf(req, { can, scopeOf, ctx });

router.get('/commands/actions', guard(ANY_ACTION, { note: NOTE }), handle(() => ({ actions: catalogue() })));

/**
 * What a step's drop-downs offer when the person corrects a field: the same
 * records the reader matches against, people limited to the login's scope.
 */
router.get('/commands/options', guard(ANY_ACTION, { note: NOTE }), handle(async (req) => {
  const a = await actor(req);
  const r = await loadRecords(pool, a.companyId, { scope: a.scope });
  return {
    departments: r.departments.map((d) => ({ id: d.id, label: labelOf('department', d, r), parentId: d.parentId })),
    labels: r.labels,
    roles: r.roles.map((x) => ({ id: x.id, label: x.name })),
    positions: r.positions.map((p) => ({ id: p.id, label: labelOf('position', p, r), roleId: p.roleId, departmentId: p.departmentId, vacant: p.occupantId == null })),
    employees: r.employees.map((e) => ({ id: e.id, label: labelOf('employee', e, r) })),
    shifts: r.shifts.map((s) => ({ id: s.id, label: s.name })),
    roleKras: Object.fromEntries([...r.roleKras.entries()].map(([roleId, list]) => [roleId, list.map((k) => ({ id: k.id, label: k.name }))])),
  };
}));

router.post('/commands/read', guard(ANY_ACTION, { note: NOTE }), handle(async (req) => {
  const text = String(req.body?.text ?? '').trim();
  if (!text) throw invalid('INVALID', 'Write what should be done.');
  if (text.length > 4000) throw invalid('INVALID', 'That is too long to read at once — up to 4,000 characters.');
  const a = await actor(req);
  const recs = await loadRecords(pool, a.companyId, { scope: a.scope });
  return readCommand(text, recs);
}));

router.post('/commands/check', guard(ANY_ACTION, { note: NOTE }), handle(async (req) => (
  checkPlan(pool, await actor(req), req.body?.steps)
)));

router.post('/commands/apply', guard(ANY_ACTION, { note: NOTE }), handle(async (req) => (
  applyPlan(pool, await actor(req), req.body?.steps, { text: req.body?.text ?? null })
)));

export default router;
