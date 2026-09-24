import { Router } from 'express';
import { PERM, guard, handle } from '../lib/http.js';

import organisationRoutes from './organisation.js';
import roleRoutes from './roles.js';
import positionRoutes from './positions.js';
import peopleRoutes from './people.js';
import assignmentRoutes from './assignments.js';
import workforceRoutes from './workforce.js';
import leaveRoutes from './leave.js';
import documentRoutes from './documents.js';
import orgChartRoutes from './orgchart.js';
import importRoutes from './imports.js';
import overviewRoutes from './overview.js';

const router = Router();

/**
 * cf_hrms route root. Mounted at /api/:companySlug/cf_hrms by app.js.
 *
 * One file per service boundary (plan §7 / spec §10). Every one of them is a
 * STUB in Phase 1 — the schema is the deliverable and these exist so the server
 * boots with every mount point already in place and later phases only fill in
 * handlers, never re-plumb.
 *
 * WHAT GOES WHERE. Reads that are plain lists go through the generic query API
 * (the 46 resources in resourceDef.json), which injects the tenant filter and
 * the soft-delete filter for free. Everything with a rule behind it comes
 * through these routers and never through the generic write path:
 *   - effective-dated rows — they are ENDED and replaced, which is two writes
 *     in one transaction, not an UPDATE;
 *   - role / position / assignment content — the three-layer resolution has
 *     exactly one implementation (services/contentResolver.js);
 *   - content overrides — exactly one of three definition FKs must be set, and
 *     TiDB will not check it;
 *   - position reporting — no self-link, no cycle on formal types;
 *   - attendance — one row per person per day per shift, whatever their roles;
 *   - leave and regularisation approvals — they write attendance and balances;
 *   - document generation — the snapshot is written before the file;
 *   - the org-chart import — nothing is written until the report is accepted.
 */

/** Liveness. No auth, like every other app's /health. */
router.get('/health', (req, res) => res.json({ ok: true, app: 'cf_hrms' }));

/**
 * The vocabulary the screens build their pickers from. These lists are the
 * ENUM values in models/init.sql; keeping them in one endpoint means a screen
 * never hard-codes a status string that a later migration renames.
 */
router.get('/meta', guard(PERM.orgView), handle(async () => ({
  locationTypes: ['PLANT', 'OFFICE', 'UNIT', 'BRANCH', 'SITE', 'OTHER'],
  contextTypes: ['MACHINE', 'LINE', 'AREA', 'PROJECT', 'CELL', 'OTHER'],
  activeStatuses: ['ACTIVE', 'INACTIVE'],

  responsibilityClasses: ['OWNER', 'JOINT_OWNER', 'SUPPORT', 'BACKUP', 'APPROVER', 'REVIEWER', 'GENERIC'],
  measurementTypes: ['NUMBER', 'PERCENTAGE', 'CURRENCY', 'DURATION', 'BOOLEAN', 'RATING', 'TEXT'],
  kpiDirections: ['HIGHER_BETTER', 'LOWER_BETTER', 'TARGET_RANGE', 'NEUTRAL'],
  frequencies: ['DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY', 'ON_EVENT'],
  targetOperators: ['GTE', 'LTE', 'EQ', 'BETWEEN', 'INFO'],
  skillTypes: ['TECHNICAL', 'BEHAVIOURAL', 'SYSTEM', 'MACHINE', 'OTHER'],
  qualificationTypes: ['EDUCATION', 'CERTIFICATION', 'LICENCE', 'OTHER'],
  authorityTypes: ['APPROVE', 'DECIDE', 'STOP', 'ISSUE', 'ESCALATE', 'FINANCIAL', 'OTHER'],
  requirementLevels: ['REQUIRED', 'PREFERRED'],
  relationshipScopes: ['INTERNAL', 'EXTERNAL'],
  workingConditionTypes: ['SHIFT', 'PHYSICAL', 'ENVIRONMENT', 'PPE', 'TRAVEL', 'OTHER'],

  roleStatuses: ['DRAFT', 'ACTIVE', 'RETIRED'],
  positionStatuses: ['DRAFT', 'ACTIVE', 'FROZEN', 'CLOSED'],
  assignmentStatuses: ['PLANNED', 'ACTIVE', 'SUSPENDED', 'ENDED'],

  contentTypes: ['KRA', 'RESPONSIBILITY', 'KPI'],
  // SUPPRESS, then OVERRIDE, then ADD — the order contentResolver.js applies,
  // and the order this list is in on purpose.
  overrideActions: ['SUPPRESS', 'OVERRIDE', 'ADD'],

  employmentTypes: ['EMPLOYEE', 'CONTRACT', 'TRAINEE', 'CONSULTANT', 'OTHER'],
  employmentStatuses: ['ACTIVE', 'NOTICE', 'INACTIVE', 'EXITED'],
  employmentEventTypes: ['JOIN', 'TRANSFER', 'ASSIGNMENT_CHANGE', 'DEPARTMENT_CHANGE', 'CONTRACTOR_CHANGE', 'EXIT', 'OTHER'],
  documentVerificationStatuses: ['UNVERIFIED', 'VERIFIED', 'REJECTED'],

  rosterSources: ['DEFAULT', 'MANUAL', 'IMPORT', 'PLANNING'],
  attendanceStatuses: ['PRESENT', 'ABSENT', 'LEAVE', 'WEEKLY_OFF', 'HOLIDAY', 'HALF_DAY', 'UNKNOWN'],
  attendanceSources: ['BIOMETRIC', 'MANUAL', 'IMPORT', 'SYSTEM'],
  regularizationStatuses: ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'],

  leaveUnits: ['DAY', 'HALF_DAY', 'HOUR'],
  leaveRequestStatuses: ['DRAFT', 'PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'],

  documentTypes: ['ROLE_JD', 'EMPLOYEE_RESPONSIBILITY_PROFILE'],
  openPointEntityTypes: ['ORGANIZATION', 'ROLE', 'POSITION', 'WORK_ASSIGNMENT', 'WORK_CONTEXT'],
  auditActions: ['CREATE', 'UPDATE', 'DELETE', 'APPROVE', 'GENERATE', 'IMPORT'],
  importSourceKinds: ['ORG_CHART_HTML', 'EXCEL', 'OTHER'],
  importStatuses: ['PARSED', 'VALIDATED', 'COMMITTED', 'DISCARDED', 'FAILED'],
})));

router.use(organisationRoutes);
router.use(roleRoutes);
router.use(positionRoutes);
router.use(peopleRoutes);
router.use(assignmentRoutes);
router.use(workforceRoutes);
router.use(leaveRoutes);
router.use(documentRoutes);
router.use(orgChartRoutes);
router.use(importRoutes);
router.use(overviewRoutes);

export default router;
