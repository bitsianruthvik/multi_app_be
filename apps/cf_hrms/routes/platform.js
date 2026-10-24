/**
 * platform.js — the PRODUCT TEAM's compliance console (TM/CF_HRMS_HIRING_SPEC.md §36.4), outside any
 * company. Mounted by app.js at /api/platform (core/middleware/appContext.js passes /api/platform/*
 * through without a company). Every route: services/compliance/platformAdmin.js — a valid login that
 * is in platform_admins with the same email; a company's Owner is refused (403 NOT_PLATFORM_ADMIN).
 *
 *   GET    /compliance/me                         who is signed in; the law layer's state
 *   GET    /compliance/sources                    the registry, with each source's last check and error
 *   POST   /compliance/sources                    { code, name, url, kind, frequencyHours, domains, jurisdictions, linkPattern?, watchText?, alsoSites?, note? }
 *   PUT    /compliance/sources/:id                any of them; { active: false } stops it
 *   POST   /compliance/sources/:id/check          check now (outside its schedule)
 *   GET    /compliance/notices                    ?status=WAITING|NEW|OPEN|LINKED|PUBLISHED|DISMISSED|ALL
 *   POST   /compliance/notices/:id/open           a reviewer opens it
 *   POST   /compliance/notices/:id/link           { domain, jurisdiction, ruleKey }
 *   POST   /compliance/notices/:id/draft          the law layer's draft flow (value, effectiveFrom …)
 *   POST   /compliance/notices/:id/publish        { title, summary, effectiveFrom, value?, versionLabel? }
 *   POST   /compliance/notices/:id/dismiss        { reason }
 *   GET    /compliance/rules                      rules to link a notice to (the law layer's list)
 *   GET    /compliance/publications               published history, with companies told and acknowledged
 */
import { Router } from 'express';
import { pool } from '../lib/db.js';
import { HrmsError, translateDbError } from '../lib/errors.js';
import { fail } from '../../../core/middleware/requirePerm.js';
import { platformGuard } from '../services/compliance/platformAdmin.js';
import * as SRC from '../services/compliance/sources.js';
import * as NOT from '../services/compliance/notices.js';
import { checkSource } from '../services/compliance/watcher.js';
import { listRules, lawStatus } from '../services/compliance/lawAdapter.js';

const router = Router();
router.use(platformGuard);
const handle = (fn) => async (req, res) => {
  try {
    const out = await fn(req, res);
    if (!res.headersSent) res.json(out ?? { ok: true });
  } catch (err) {
    fail(res, translateDbError(err));
  }
};
const idOf = (req) => {
  const n = Number(req.params.id);
  if (!Number.isInteger(n) || n <= 0) throw new HrmsError(422, 'INVALID', 'id must be a positive whole number.');
  return n;
};
/** Tests point the watcher at a local fake site; the real server never reads a private address. */
const fetchOptions = () => (process.env.CF_HRMS_COMPLIANCE_ALLOW_LOCAL === '1' ? { allowLocal: true, retries: 0, pauseMs: 10 } : {});

router.get('/compliance/me', handle(async (req) => ({ admin: req.platformAdmin, lawLayer: await lawStatus() })));

router.get('/compliance/sources', handle(async () => ({ sources: await SRC.listSources(pool), kinds: SRC.KINDS, domains: SRC.DOMAINS })));
router.post('/compliance/sources', handle(async (req) => ({ source: await SRC.createSource(pool, req.body ?? {}, fetchOptions()) })));
router.put('/compliance/sources/:id', handle(async (req) => ({ source: await SRC.updateSource(pool, idOf(req), req.body ?? {}, fetchOptions()) })));
router.post('/compliance/sources/:id/check', handle(async (req) => {
  const id = idOf(req);
  await SRC.sourceRow(pool, id);
  const result = await checkSource(id, { manual: true, fetchOptions: fetchOptions() });
  return { result, source: SRC.shapeSource(await SRC.sourceRow(pool, id)) };
}));

router.get('/compliance/notices', handle(async (req) => NOT.listNotices(pool, { status: String(req.query.status ?? 'WAITING').toUpperCase() })));
router.post('/compliance/notices/:id/open', handle(async (req) => ({ notice: await NOT.openNotice(pool, req.platformAdmin, idOf(req)) })));
router.post('/compliance/notices/:id/link', handle(async (req) => ({ notice: await NOT.linkNotice(pool, req.platformAdmin, idOf(req), req.body ?? {}) })));
router.post('/compliance/notices/:id/draft', handle(async (req) => NOT.draftForNotice(pool, req.platformAdmin, idOf(req), req.body ?? {})));
router.post('/compliance/notices/:id/publish', handle(async (req) => NOT.publishNotice(pool, req.platformAdmin, idOf(req), req.body ?? {})));
router.post('/compliance/notices/:id/dismiss', handle(async (req) => ({ notice: await NOT.dismissNotice(pool, req.platformAdmin, idOf(req), req.body ?? {}) })));

router.get('/compliance/rules', handle(async () => ({ rules: await listRules(pool), lawLayer: await lawStatus() })));
router.get('/compliance/publications', handle(async () => ({ publications: await NOT.listPublications(pool) })));

export default router;
