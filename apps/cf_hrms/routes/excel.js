/**
 * excel.js — download and upload by Excel, one engine for every entity.
 * (TM/CF_HRMS_HIRING_SPEC.md §13.2–§13.4; services/excel/.)
 *
 *   GET  /excel/entities                 [{ entity, label, area, canDownload, canUpload }]
 *   GET  /excel/<entity>/workbook        ?<the list's filters>  |  ?blank=1
 *                                        -> { fileName, mimeType, contentBase64, rows }
 *   POST /excel/<entity>/preview         { fileName, contentBase64 }  -> reads, changes nothing:
 *                                        { entity, fileName, summary: { add, change, same, problems },
 *                                          rows: [{ row, action, label, changes: [{ column, from, to }], problems }], fileProblems }
 *   POST /excel/<entity>/apply           { fileName, contentBase64, expect: { add, change }, skipProblemRows? }
 *                                        -> { added, changed, skipped, issuedCodes: [{ row, code }] }
 *                                        409 PREVIEW_STALE · 422 HAS_PROBLEMS · 422 FILE_PROBLEM · 4xx APPLY_FAILED
 *
 * <entity> is one of: departments, locations, roles, positions, employees, holidays, shifts,
 * library-kras, library-responsibilities, library-kpis, library-skills, library-qualifications,
 * library-authorities, actuals (spec §19.3: one row per person × KPI × slot of `?periodId=`;
 * the upload needs performance upload), leave-balances (spec §22.5: HR's opening balances, one
 * row per person for the leave year of `?year=`; the upload needs leave edit — leave has no upload right). Each is its own route, so each carries its own right (ACCESS.md):
 * the download needs the area's `view`, the upload the area's `upload` (and `view`).
 *
 * EMPLOYEES: a file with NEW rows also needs `cf_hrms_employee_bulk_add`; without
 * it the file is refused whole (fileProblems), saying who can do it. Contact
 * columns are in the file only with `cf_hrms_contact_view`.
 *
 * SCOPE: a login limited to its department downloads only what is inside it, and
 * an upload row outside it is a problem. What belongs to no department
 * (locations, roles, holidays, shifts, the libraries) it may download but not upload.
 *
 * The apply is ONE transaction. An upload never removes a record.
 */
import { Router } from 'express';
import { pool, withTransaction } from '../lib/db.js';
import { PERM, guard, handle, ctx, can } from '../lib/http.js';
import { companyWide } from '../lib/gates.js';
import { scopeOf } from '../services/accessScope.js';
import { ENTITIES } from '../services/excel/entities/index.js';
import { downloadWorkbook, previewUpload, applyUpload, listEntities } from '../services/excel/engine.js';

const router = Router();

/** What the engine needs to know about who is asking. */
async function envOf(req) {
  const scope = await scopeOf(req);
  return {
    can: (tag) => can(req, tag),
    scope: scope.all ? { all: true, departmentIds: new Set(), rootIds: [] } : scope,
    userName: req.user?.name ?? req.user?.email ?? '',
    company: { id: ctx(req).companyId, name: req.company?.name ?? 'Company' },
    query: req.query ?? {},
  };
}

router.get('/excel/entities', guard(PERM.signedIn), handle(async (req) => listEntities(await envOf(req))));

for (const def of ENTITIES) {
  const whole = def.wholeCompany ? [companyWide(`${def.label} belong to the whole company. Your access covers your own department only — you can download this file, not upload it.`)] : [];
  const upload = guard(def.uploadRight, {
    also: [def.viewRight],
    ...(def.entity === 'employees' ? { note: 'a file with NEW rows also needs cf_hrms_employee_bulk_add; contact columns only with cf_hrms_contact_view' } : {}),
  });
  router.get(`/excel/${def.entity}/workbook`, guard(def.viewRight), handle(async (req) => downloadWorkbook(pool, ctx(req), def, await envOf(req))));
  router.post(`/excel/${def.entity}/preview`, upload, ...whole, handle(async (req) => previewUpload(pool, ctx(req), def, req.body ?? {}, await envOf(req))));
  router.post(`/excel/${def.entity}/apply`, upload, ...whole, handle(async (req) => {
    const env = await envOf(req);
    return withTransaction((db) => applyUpload(db, ctx(req), def, req.body ?? {}, env));
  }));
}

export default router;
