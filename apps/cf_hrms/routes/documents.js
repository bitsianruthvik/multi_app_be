/**
 * documents.js — Role JD and Employee Responsibility Profile generation,
 * snapshot retrieval and DOCX / PDF download. (Plan §7, §17. Phase 7.)
 *
 *   GET    /documents/meta                     types, formats, template version
 *   GET    /documents                          ?type=&roleId=&positionId=&employeeId=&currentOnly=1&search=&limit=
 *   GET    /documents/preview                  ?type=&roleId=&positionId=&employeeId=&on=
 *                                              resolves and returns the JSON, PERSISTS NOTHING
 *   POST   /documents/generate                 { type, roleId?, positionId?, employeeId?, on? }
 *   GET    /documents/:id                      the stored snapshot — what the app previews from
 *   GET    /documents/:id/download?format=docx|pdf[&transport=base64|binary]
 *   GET    /documents/status                   kept from the Phase 1 stub so an early-wired screen still answers
 *
 * THE SNAPSHOT IS WRITTEN BEFORE THE FILE IS RENDERED, in one transaction
 * (plan §2 rule 7) — `documentService.generate` is the only writer and the
 * ordering lives there, not here. A historical document re-renders from its own
 * snapshot and never from today's role definition; the renderers are not given a
 * database handle at all, which is what makes that true rather than intended.
 *
 * PERMISSIONS (plan §6). Generating is `cf_hrms_documents_generate`. Reading is
 * `cf_hrms_org_view` OR `cf_hrms_people_view`: a role JD is org-side and a
 * responsibility profile is people-side, and someone who can see one should not
 * be blocked from the list that holds both. `guard()` takes a single tag, so the
 * either-or is checked here, in one helper, and admins bypass as everywhere else.
 *
 * TRANSPORT. Download returns base64 JSON by default — the same `FileTransport`
 * shape `/people/documents/:id/file` returns, because the frontend's only
 * sanctioned HTTP path (@core/api/client) JSON-encodes everything and has no
 * blob mode; it rebuilds the file with `toBlobUrl`. `?transport=binary` streams
 * the real bytes with Content-Type and Content-Disposition for a direct link or
 * a curl.
 */
import { Router } from 'express';
import { protect } from '../../../core/middleware/authmiddleware.js';
import { isPermitted } from '../../../core/middleware/requirePerm.js';
import { pool, withTransaction } from '../lib/db.js';
import { PERM, guard, handle, ctx, intParam } from '../lib/http.js';
import { HrmsError } from '../lib/errors.js';
import {
  listDocuments, getDocument, generate, previewDocument, readDocumentFile,
  DOCUMENT_TYPES, FORMATS, TEMPLATE_VERSION, SNAPSHOT_VERSION,
} from '../services/documentService.js';

const router = Router();

/**
 * Reading a generated document needs either side's view permission. Written once
 * so the five read routes cannot disagree about who may see a JD.
 */
const READ_TAGS = [PERM.orgView, PERM.peopleView, PERM.documentsGenerate];
const canRead = (req, res, next) => {
  if (READ_TAGS.some((tag) => isPermitted(req.user, tag))) return next();
  return res.status(403).json({
    error: 'FORBIDDEN',
    message: `Permission required: ${PERM.orgView} or ${PERM.peopleView}`,
  });
};
const readGuard = [protect, canRead];

const tx = (req, fn) => withTransaction((db) => fn(db, ctx(req)));

/** The vocabulary a Documents screen builds its pickers from. */
router.get('/documents/meta', readGuard, handle(async () => ({
  documentTypes: DOCUMENT_TYPES,
  formats: FORMATS,
  templateVersion: TEMPLATE_VERSION,
  snapshotVersion: SNAPSHOT_VERSION,
  generatePermission: PERM.documentsGenerate,
  readPermissions: [PERM.orgView, PERM.peopleView],
  transports: ['base64', 'binary'],
})));

/**
 * The preview. Same builder as `generate`, nothing written — so a person can
 * look at a JD before committing one, and what they looked at is exactly what
 * gets frozen if they do.
 *
 * Declared before `/documents/:id` or Express reads "preview" as an id.
 */
router.get('/documents/preview', readGuard, handle((req) => (
  previewDocument(pool, ctx(req), {
    type: req.query.type,
    roleId: req.query.roleId,
    positionId: req.query.positionId,
    employeeId: req.query.employeeId,
    on: req.query.on,
  })
)));

/** Kept from the Phase 1 stub so a screen wired early still gets an answer. */
router.get('/documents/status', readGuard, handle(async (req) => ({
  section: 'documents',
  implemented: true,
  phase: 7,
  viewPermission: PERM.orgView,
  managePermission: PERM.documentsGenerate,
  templateVersion: TEMPLATE_VERSION,
  ...(await listDocuments(pool, ctx(req).companyId, { limit: 25 })),
})));

router.get('/documents', readGuard, handle((req) => listDocuments(pool, ctx(req).companyId, req.query)));

/**
 * Generate. One transaction: snapshot row, then the two renders, then the audit
 * row. The response carries the snapshot so a screen can show the document it
 * just made without a second request.
 */
router.post('/documents/generate', guard(PERM.documentsGenerate), handle((req) => (
  tx(req, (db, c) => generate(db, c, req.body ?? {}, req.id ?? null))
)));

/** The stored snapshot. This is what a preview of an EXISTING document reads. */
router.get('/documents/:id', readGuard, handle((req) => getDocument(pool, ctx(req).companyId, intParam(req.params.id))));

/**
 * The stored bytes. `transport=binary` for a real file response; the default
 * base64 JSON is what the frontend client can actually consume.
 */
router.get('/documents/:id/download', readGuard, handle(async (req, res) => {
  const format = String(req.query.format ?? 'docx').toLowerCase();
  const transport = String(req.query.transport ?? 'base64').toLowerCase();
  if (!['base64', 'binary'].includes(transport)) {
    throw new HrmsError(422, 'INVALID', 'transport must be base64 or binary.');
  }
  const file = await readDocumentFile(pool, ctx(req).companyId, intParam(req.params.id), format);

  if (transport === 'base64') return file;

  const buffer = Buffer.from(file.dataBase64, 'base64');
  res.setHeader('Content-Type', file.mimeType);
  res.setHeader('Content-Length', String(buffer.length));
  // `filename*` as well as `filename`, because these names carry the role title
  // and a tenant may well have a non-ASCII one.
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${file.fileName.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, '')}"; `
    + `filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
  );
  res.send(buffer);
  return undefined;
}));

export default router;
