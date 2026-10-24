/**
 * attendance.js — HR's attendance (TM/CF_HRMS_HIRING_SPEC.md §28; services/attendance/).
 *
 * Rights: the `attendance` area — view / edit / remove / upload — in the login's department scope.
 *
 *   GET  /attendance/today?date=&departmentId=          the board: present, late, absent, on leave, off, not punched
 *   GET  /attendance/month?month=&departmentId=&q=      the muster: person × day
 *   GET  /attendance/month/workbook?month=              the muster roll (.xlsx, base64)
 *   GET  /attendance/summary?month=                     attendanceMonth() — what payroll reads
 *   GET  /attendance/people/:id?month=                  one person's month
 *   PUT  /attendance/days                               set a day by hand (source MANUAL) · status null gives it back
 *   POST /attendance/process { from, to, employeeIds? } process a range now (re-runnable)
 *   GET  /attendance/requests · GET /attendance/requests/:id · POST /attendance/requests (on behalf)
 *   POST /attendance/requests/:id/approve | /reject
 *   GET  /attendance/penalties?month=&status=           POST /attendance/penalties/:id/waive { note }
 *   GET  /attendance/policies · /:id · POST · PUT /:id · DELETE /:id · POST /attendance/policies/sentences
 *   PUT  /attendance/policy-assignments { scope, targetId, policyId | null }
 *   GET  /attendance/devices · POST · PUT /:id · DELETE /:id
 *   GET  /attendance/device-users?deviceId= · PUT /attendance/device-users · POST /attendance/device-users/auto
 *   GET  /attendance/unmapped                            punches waiting for a mapping
 *   GET  /attendance/api-keys · POST (the Owner) · POST /attendance/api-keys/:id/revoke (the Owner)
 *   GET  /attendance/imports/template?kind=punches|days · POST /attendance/imports/:kind/preview | /apply
 *   GET  /attendance/settings · PUT /attendance/settings
 *   GET  /attendance/months?year= · POST /attendance/months/:month/close · POST /attendance/months/:month/reopen (the Owner)
 *
 * The device push (/iclock/*) and the integration API (/api/integrations/attendance/punches) are
 * outside this router: routes/iclock.js and routes/integrations.js, mounted by the server's index.js.
 */
import { Router } from 'express';
import { pool, withTransaction } from '../lib/db.js';
import { PERM, guard, handle, ctx, intParam, need, can } from '../lib/http.js';
import { HrmsError } from '../lib/errors.js';
import { companyWide, inEmployee } from '../lib/gates.js';
import { peopleFilter, scopeOf } from '../services/accessScope.js';
import { employeeIdOfLogin } from '../services/leave/requestService.js';
import { todayBoard, monthGrid, musterWorkbook, personMonth, peopleIn } from '../services/attendance/reads.js';
import { attendanceMonth, listMonths, closeMonth, reopenMonth } from '../services/attendance/month.js';
import { processRange } from '../services/attendance/process.js';
import { listRequests, readRequest, submitFor, decide, setDayByHand } from '../services/attendance/requests.js';
import { listPenalties, waivePenalty } from '../services/attendance/penalties.js';
import { listPolicies, readPolicy, createPolicy, updatePolicy, removePolicy, putAssignment, previewSentences } from '../services/attendance/policy.js';
import { listDevices, createDevice, updateDevice, removeDevice, listKeys, createKey, revokeKey } from '../services/attendance/devices.js';
import { listMappings, putMapping, autoMap, unmappedQueue, processAfterCommit } from '../services/attendance/punches.js';
import { template, previewImport, applyImport } from '../services/attendance/imports.js';
import { settingsOf, putSettings } from '../services/attendance/settings.js';
import { serverToday as localToday } from '../services/attendance/time.js';

const router = Router();
const A = PERM.attendance;
const tx = (req, fn) => withTransaction((db) => fn(db, ctx(req)));
const id = (req) => intParam(req.params.id);
const reqId = (req) => req.id ?? req.headers['x-request-id'] ?? null;
const WHOLE = companyWide('This belongs to the whole company. Your access covers your org unit and everything under it.');
const inRequest = inEmployee('attendanceRequest');
const inPenalty = inEmployee('attendancePenalty');
const inBodyPerson = inEmployee('employee', (req) => req.body?.employeeId);
const ownerOnly = (req, what) => { if (!ctx(req).owner) throw new HrmsError(403, 'OWNER_ONLY', `Only the Owner ${what}.`); };
const monthParam = (v) => { const s = String(v ?? ''); if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(s)) throw new HrmsError(422, 'INVALID', 'The month is written like 2026-10.'); return s; };

/** Who is deciding: their own employee (nobody decides their own) and HR's reach (attendance edit, in scope). */
async function viewerOf(req) {
  const c = ctx(req);
  let hr = null;
  if (can(req, A.edit)) { const scope = await scopeOf(req); hr = scope.all ? { all: true } : { departmentIds: scope.departmentIds }; }
  return { userId: c.userId, employeeId: await employeeIdOfLogin(pool, c), hr };
}

// ── the day, the month ───────────────────────────────────────────────────────
router.get('/attendance/today', guard(A.view, { note: 'narrowed to the login’s org unit' }), handle(async (req) => (
  todayBoard(pool, ctx(req), { date: req.query.date, departmentId: req.query.departmentId, scopeDeptIds: await peopleFilter(req) }))));
router.get('/attendance/month', guard(A.view, { note: 'narrowed to the login’s org unit' }), handle(async (req) => (
  monthGrid(pool, ctx(req), { month: req.query.month, departmentId: req.query.departmentId, q: req.query.q, scopeDeptIds: await peopleFilter(req) }))));
router.get('/attendance/month/workbook', guard(A.view, { note: 'narrowed to the login’s org unit' }), handle(async (req) => (
  musterWorkbook(pool, ctx(req), { month: req.query.month, departmentId: req.query.departmentId, q: req.query.q }, await peopleFilter(req)))));
router.get('/attendance/summary', guard(A.view, { note: 'narrowed to the login’s org unit' }), handle(async (req) => {
  const c = ctx(req);
  const scope = await peopleFilter(req);
  const employeeIds = scope ? await peopleIn(pool, c.companyId, { scopeDeptIds: scope, on: localToday() }) : null;
  return attendanceMonth(c.companyId, monthParam(req.query.month), { db: pool, employeeIds });
}));
router.get('/attendance/people/:id', guard(A.view), inEmployee(), handle((req) => personMonth(pool, ctx(req), id(req), { month: req.query.month })));
router.put('/attendance/days', guard(A.edit, { note: 'never the login’s own day' }), inBodyPerson, handle(async (req) => {
  const employeeId = await employeeIdOfLogin(pool, ctx(req));
  return tx(req, (db, c) => setDayByHand(db, { ...c, employeeId }, req.body ?? {}, reqId(req)));
}));
router.post('/attendance/process', guard(A.edit, { note: 'an org-unit-scoped login processes its own people only' }), handle(async (req) => {
  const b = req.body ?? {};
  const from = String(b.from ?? '').slice(0, 10);
  const to = String(b.to ?? b.from ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || to < from) throw new HrmsError(422, 'INVALID', 'Give the dates to process: from and to (YYYY-MM-DD).');
  if ((Date.parse(to) - Date.parse(from)) / 86400000 > 92) throw new HrmsError(422, 'INVALID', 'Process at most three months at once.');
  const scope = await peopleFilter(req);
  let employeeIds = Array.isArray(b.employeeIds) ? b.employeeIds.map(Number).filter((x) => Number.isInteger(x) && x > 0) : null;
  if (scope) {
    const mine = await peopleIn(pool, ctx(req).companyId, { scopeDeptIds: scope, on: localToday() });
    employeeIds = employeeIds ? employeeIds.filter((x) => mine.includes(x)) : mine;
  }
  return tx(req, (db, c) => processRange(db, c, { from, to, employeeIds, kind: 'MANUAL', note: 'by hand' }));
}));

// ── requests ─────────────────────────────────────────────────────────────────
router.get('/attendance/requests', guard(A.view, { note: 'narrowed to the login’s org unit' }), handle(async (req) => (
  listRequests(pool, ctx(req), req.query ?? {}, await peopleFilter(req), await viewerOf(req)))));
router.post('/attendance/requests', guard(A.edit), inBodyPerson, handle((req) => tx(req, (db, c) => submitFor(db, c, Number(req.body?.employeeId), req.body ?? {}, { raisedByHr: true, requestId: reqId(req) }))));
router.get('/attendance/requests/:id', guard(A.view), inRequest, handle(async (req) => readRequest(pool, ctx(req), await viewerOf(req), id(req))));
for (const [path, verdict] of [['approve', 'APPROVE'], ['reject', 'REJECT']]) {
  router.post(`/attendance/requests/:id/${path}`, guard(A.edit), inRequest, handle(async (req) => {
    const viewer = await viewerOf(req);
    return tx(req, (db, c) => decide(db, c, viewer, id(req), verdict, req.body ?? {}, reqId(req)));
  }));
}

// ── penalties ────────────────────────────────────────────────────────────────
router.get('/attendance/penalties', guard(A.view, { note: 'narrowed to the login’s org unit' }), handle(async (req) => listPenalties(pool, ctx(req), req.query ?? {}, await peopleFilter(req))));
router.post('/attendance/penalties/:id/waive', guard(A.edit), inPenalty, handle(async (req) => {
  const employeeId = await employeeIdOfLogin(pool, ctx(req));
  return tx(req, (db, c) => waivePenalty(db, { ...c, employeeId }, id(req), req.body ?? {}, reqId(req)));
}));

// ── policies and where they apply ────────────────────────────────────────────
router.get('/attendance/policies', guard(A.view), handle((req) => listPolicies(pool, ctx(req))));
// Before /attendance/policies/:id, or "sentences" would be read as an id.
router.post('/attendance/policies/sentences', guard(A.view), handle((req) => previewSentences(pool, ctx(req), req.body ?? {})));
router.get('/attendance/policies/:id', guard(A.view), handle((req) => readPolicy(pool, ctx(req), id(req))));
router.post('/attendance/policies', guard(A.edit), WHOLE, handle((req) => tx(req, (db, c) => createPolicy(db, c, req.body ?? {}, reqId(req)))));
router.put('/attendance/policies/:id', guard(A.edit, { note: 'archiving it also needs cf_hrms_attendance_remove' }), WHOLE, handle((req) => {
  if (String(req.body?.status ?? '').toUpperCase() === 'ARCHIVED') need(req, A.remove);
  return tx(req, (db, c) => updatePolicy(db, c, id(req), req.body ?? {}, reqId(req)));
}));
router.delete('/attendance/policies/:id', guard(A.remove), WHOLE, handle((req) => tx(req, (db, c) => removePolicy(db, c, id(req), reqId(req)))));
router.put('/attendance/policy-assignments', guard(A.edit, { note: 'clearing one (policyId: null) also needs cf_hrms_attendance_remove' }), WHOLE, handle((req) => {
  if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'policyId') && (req.body.policyId === null || req.body.policyId === '')) need(req, A.remove);
  return tx(req, (db, c) => putAssignment(db, c, req.body ?? {}, reqId(req)));
}));

// ── devices, mapping, unmapped punches, API keys ─────────────────────────────
router.get('/attendance/devices', guard(A.view, { note: 'serials masked without cf_hrms_attendance_edit' }), handle((req) => listDevices(pool, ctx(req), { canEdit: can(req, A.edit) })));
router.post('/attendance/devices', guard(A.edit), WHOLE, handle((req) => tx(req, (db, c) => createDevice(db, c, req.body ?? {}, reqId(req)))));
router.put('/attendance/devices/:id', guard(A.edit), WHOLE, handle((req) => tx(req, (db, c) => updateDevice(db, c, id(req), req.body ?? {}, reqId(req)))));
router.delete('/attendance/devices/:id', guard(A.remove), WHOLE, handle((req) => tx(req, (db, c) => removeDevice(db, c, id(req), reqId(req)))));
router.get('/attendance/device-users', guard(A.view), handle((req) => listMappings(pool, ctx(req), { deviceId: req.query.deviceId ? Number(req.query.deviceId) : null })));
router.put('/attendance/device-users', guard(A.edit, { note: 'taking one off (employeeId: null) also needs cf_hrms_attendance_remove' }), WHOLE, handle((req) => {
  if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'employeeId') && (req.body.employeeId === null || req.body.employeeId === '')) need(req, A.remove);
  return tx(req, (db, c) => putMapping(db, c, req.body ?? {}, reqId(req)));
}));
router.post('/attendance/device-users/auto', guard(A.edit), WHOLE, handle((req) => tx(req, (db, c) => autoMap(db, c, reqId(req)))));
router.get('/attendance/unmapped', guard(A.view, { note: 'serials masked without cf_hrms_attendance_edit' }), handle((req) => unmappedQueue(pool, ctx(req), { canEdit: can(req, A.edit) })));
router.get('/attendance/api-keys', guard(A.view), handle((req) => listKeys(pool, ctx(req))));
router.post('/attendance/api-keys', guard(A.edit, { note: 'the Owner only' }), handle((req) => { ownerOnly(req, 'makes an API key'); return tx(req, (db, c) => createKey(db, c, req.body ?? {}, reqId(req))); }));
router.post('/attendance/api-keys/:id/revoke', guard(A.edit, { note: 'the Owner only' }), handle((req) => { ownerOnly(req, 'revokes an API key'); return tx(req, (db, c) => revokeKey(db, c, id(req), reqId(req))); }));

// ── imports ──────────────────────────────────────────────────────────────────
router.get('/attendance/imports/template', guard(A.upload, { also: [A.view] }), handle((req) => template(String(req.query.kind ?? 'punches'))));
router.post('/attendance/imports/:kind/preview', guard(A.upload, { also: [A.view] }), WHOLE, handle(async (req) => {
  const employeeId = await employeeIdOfLogin(pool, ctx(req));
  return previewImport(pool, { ...ctx(req), employeeId }, String(req.params.kind), req.body ?? {});
}));
router.post('/attendance/imports/:kind/apply', guard(A.upload, { also: [A.view], note: 'a days file never sets the login’s own days' }), WHOLE, handle(async (req) => {
  const employeeId = await employeeIdOfLogin(pool, ctx(req));
  const out = await tx(req, (db, c) => applyImport(db, { ...c, employeeId }, String(req.params.kind), req.body ?? {}, reqId(req)));
  // A punch file: its punches are committed; their days are processed now (an error is logged and retried, never lost).
  if (out.toProcess?.length) out.processed = await processAfterCommit(ctx(req), out.toProcess, { what: 'IMPORT' });
  return out;
}));

// ── settings and months ──────────────────────────────────────────────────────
router.get('/attendance/settings', guard(A.view), handle(async (req) => ({ settings: await settingsOf(pool, ctx(req).companyId) })));
router.put('/attendance/settings', guard(A.edit), WHOLE, handle((req) => tx(req, (db, c) => putSettings(db, c, req.body ?? {}, reqId(req)))));
router.get('/attendance/months', guard(A.view), handle((req) => listMonths(pool, ctx(req), { year: req.query.year })));
router.post('/attendance/months/:month/close', guard(A.edit), WHOLE, handle((req) => tx(req, (db, c) => closeMonth(db, c, monthParam(req.params.month), reqId(req)))));
router.post('/attendance/months/:month/reopen', guard(A.edit, { note: 'the Owner only, with a reason' }), WHOLE, handle((req) => tx(req, (db, c) => reopenMonth(db, c, monthParam(req.params.month), req.body ?? {}, reqId(req)))));

export default router;
