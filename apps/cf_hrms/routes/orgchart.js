/**
 * orgchart.js — the org-chart read model and open points. (Plan §7;
 * `CF_HRMS_ORG_CHART_SPEC.md` §9, which is the fixed API contract.)
 *
 *   GET /orgchart                          ?on=&root=   the WHOLE graph in one payload
 *   GET /orgchart/positions/:id/card       ?on=         everything the card modal shows
 *   GET /orgchart/search                   ?q=&on=      KRA / responsibility / KPI / qualification text
 *   GET /orgchart/open-points              ?status=&entityType=&entityId=   grouped by entity
 *   PUT /orgchart/open-points/:id          { status, resolution|answer }    resolve / dismiss / reopen
 *
 * `/orgchart/search` answers with a BARE ARRAY of hits, exactly as spec §9
 * writes it, and `/orgchart/open-points` with a bare array of entity groups —
 * neither needs an envelope over a list the screen renders straight through.
 *
 * ONE PAYLOAD, DELIBERATELY. Karni is 114 positions and 8 levels deep. Paging a
 * graph that size would cost more in round trips and client state than it could
 * ever save, so `/orgchart` returns every node and EVERY EDGE and the client
 * decides what to draw. The server never picks which edge is "the" edge — it
 * does not flatten reporting to one manager anywhere (plan §2 rule 9).
 *
 * WORK CONTEXTS ARE CHIPS, NEVER NODES. A machine is not a manager (plan §2
 * rule 3); the import already re-pointed machine-parented positions at their
 * nearest human ancestor, so `nodes[].contexts` is the only place a machine
 * appears in this response.
 *
 * Reads: `cf_hrms_org_view`. Resolving an open point: `cf_hrms_org_manage`.
 * The company always comes from the token (`ctx`), never from the URL.
 */
import { Router } from 'express';
import { pool, withTransaction } from '../lib/db.js';
import { PERM, guard, handle, ctx, intParam, dateParam } from '../lib/http.js';
import {
  buildOrgChart, getPositionCard, searchOrgChart, listOpenPoints, updateOpenPoint,
} from '../services/orgChartService.js';

const router = Router();

/**
 * The graph. `on` drives every effective-date filter in it — positions, edges,
 * assignments, context links, manpower requirements and attendance all read as
 * of the same day, so nothing in the payload can disagree with anything else.
 * `root` re-roots at one position and returns its subtree down the
 * PRIMARY_MANAGER tree.
 */
router.get('/orgchart', guard(PERM.orgView), handle((req) => buildOrgChart(
  pool,
  ctx(req).companyId,
  {
    on: dateParam(req.query.on),
    root: req.query.root == null || req.query.root === '' ? null : intParam(req.query.root, 'root'),
  },
)));

/**
 * The card. Role purpose, the full content lists, occupants with their
 * assignments and attendance, contexts, open points, and the RESOLVED reporting
 * set from `reportingResolver.resolvePositionReporting` — every row with its
 * type, its scope sentence, who is in that seat now and whether it is vacant.
 */
router.get('/orgchart/positions/:id/card', guard(PERM.orgView), handle((req) => getPositionCard(
  pool,
  ctx(req).companyId,
  intParam(req.params.id),
  { on: dateParam(req.query.on) },
)));

/** Multi-word AND across the four content kinds, answering with positions. */
router.get('/orgchart/search', guard(PERM.orgView), handle((req) => searchOrgChart(
  pool,
  ctx(req).companyId,
  { q: req.query.q, on: dateParam(req.query.on), limit: req.query.limit },
)));

router.get('/orgchart/open-points', guard(PERM.orgView), handle((req) => listOpenPoints(
  pool,
  ctx(req).companyId,
  req.query,
)));

/**
 * Resolving one is a write with a rule behind it — it records who decided and
 * when, and it writes its audit row in the same transaction, because TiDB has
 * no triggers and an audit row written afterwards is one that can go missing.
 */
router.put('/orgchart/open-points/:id', guard(PERM.orgManage), handle((req) => withTransaction(
  (db) => updateOpenPoint(db, ctx(req), intParam(req.params.id), req.body ?? {}),
)));

export default router;
