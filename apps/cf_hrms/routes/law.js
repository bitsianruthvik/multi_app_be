/**
 * routes/law.js — what a COMPANY sees of the law layer (TM/CF_HRMS_HIRING_SPEC.md §36.1).
 *
 * The law itself is READ-ONLY here: no route of a company writes hrms_law_rules or hrms_tax_rules.
 * The product team publishes it (services/law publishVersion, from the platform console and the
 * seed scripts). A company writes only its choices and what places a person in the law (a
 * location's state and zone, a role's skill, scheduled employment and default structure).
 *
 *   GET  /law/rules-in-force?on=YYYY-MM-DD   { on, states, domains: [{ domain, name, rules: [version + history + companyNote] }], unverified }
 *   GET  /law/tax-rules?year=2026-27         { year, years, rules: [version + history], unverified }
 *   GET  /law/rules/:id                      { rule, history }  (a law version; 'tax:<id>' for a tax rule)
 *   GET  /law/choices                        { choices, law: { bonus } }
 *   PUT  /law/choices                        { pfWageBasis?, pfEstablishmentCode?, esiEmployerCode?, ptRegistrationNo?, ptEnrolmentNo?, lwfRegistrationNo?, bonusRate?, note? }
 *   GET  /law/locations                      { locations: [{ locationId, name, stateCode, zone }], states, zones }
 *   PUT  /law/locations/:id                  { stateCode, zone }    (organisation edit)
 *   GET  /law/roles/:id                      { skillCategory, scheduledEmployment, defaultStructure, options }  (the CTC band with pay access)
 *   PUT  /law/roles/:id                      { skillCategory?, scheduledEmployment?, defaultStructureId?, ctcMin?, ctcMax? }  (roles edit; the band also pay access)
 *   GET  /law/people/:employeeId/salary-default   { structure, pfWageBasis, place, minimumWage }  (payroll view + pay view)
 *   GET  /law/minimum-wage?state=&zone=&skill=&employment=&on=   { found, wage, rule, reason }
 *   GET  /payroll/runs/:id/law-versions      { snapshot }   the versions a calculation used
 *   POST /payroll/runs/:id/reproduce         { same, differences, … } recomputed with exactly those versions; writes nothing
 */
import { Router } from 'express';
import { pool, withTransaction } from '../lib/db.js';
import { PERM, guard, handle, ctx, intParam, can } from '../lib/http.js';
import { companyWide } from '../lib/gates.js';
import { HrmsError } from '../lib/errors.js';
import * as LAW from '../services/law/index.js';
import * as CO from '../services/law/company.js';

const router = Router();
const whole = companyWide('The law and the company’s choices belong to the whole company. Your access covers your org unit and everything under it.');
const read = [...guard([PERM.payroll.view, PERM.complianceReview]), whole];
const choose = [...guard(PERM.payroll.edit), whole];
const viewPay = [...guard(PERM.payroll.view, { also: [PERM.payView] }), whole];
const editPay = [...guard(PERM.payroll.edit, { also: [PERM.payView] }), whole];
const tx = (req, fn) => withTransaction((db) => fn(db, ctx(req)));
const reqId = (req) => req.id ?? req.headers['x-request-id'] ?? null;
const day = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v ?? '')) ? String(v) : null);
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

router.get('/law/rules-in-force', ...read, handle((req) => CO.rulesInForcePage(pool, ctx(req).companyId, day(req.query.on) ?? today())));
router.get('/law/tax-rules', ...read, handle((req) => CO.taxRulesPage(pool, /^\d{4}-\d{2}$/.test(String(req.query.year ?? '')) ? String(req.query.year) : LAW.taxYearOf(today()))));
router.get('/law/rules/:id', ...read, handle(async (req) => {
  const rule = await LAW.getVersion(pool, req.params.id);
  if (!rule || rule.status === 'DRAFT') throw new HrmsError(404, 'NOT_FOUND', 'That rule was not found.');
  const all = await LAW.listRules(pool, rule.kind === 'TAX' ? { domain: 'TAX', taxYear: rule.taxYear, ruleKey: rule.ruleKey } : { domain: rule.domain, jurisdiction: rule.jurisdiction, ruleKey: rule.ruleKey });
  return { rule, history: all.filter((r) => r.status !== 'DRAFT' && (rule.kind !== 'TAX' || r.regime === rule.regime)) };
}));

router.get('/law/choices', ...read, handle(async (req) => {
  const rules = await LAW.lawInForce(pool, { domains: ['BONUS'], jurisdictions: ['IN'], on: today() });
  return { choices: await CO.getChoices(pool, ctx(req).companyId), law: { bonus: rules.find((r) => r.ruleKey === 'rates') ?? null } };
}));
router.put('/law/choices', ...choose, handle((req) => tx(req, (db, c) => CO.putChoices(db, c, req.body ?? {}, reqId(req)))));

router.get('/law/locations', ...guard([PERM.org.view, PERM.payroll.view]), handle(async (req) => ({
  locations: await CO.listLocationLaw(pool, ctx(req).companyId), states: CO.STATES,
  zones: (await LAW.employmentsOf(pool, 'TG', today())).zones,
})));
router.put('/law/locations/:id', ...guard(PERM.org.edit), whole, handle((req) => tx(req, (db, c) => CO.putLocationLaw(db, c, intParam(req.params.id), req.body ?? {}, reqId(req)))));

router.get('/law/roles/:id', ...guard([PERM.roles.view, PERM.payroll.view]), handle((req) => CO.getRoleLaw(pool, ctx(req).companyId, intParam(req.params.id), { withPay: can(req, PERM.payView) })));
router.put('/law/roles/:id', ...guard(PERM.roles.edit, { note: 'the CTC band also needs cf_hrms_pay_view' }), whole,
  handle((req) => tx(req, (db, c) => CO.putRoleLaw(db, c, intParam(req.params.id), req.body ?? {}, reqId(req), { withPay: can(req, PERM.payView) }))));

router.get('/law/people/:employeeId/salary-default', ...viewPay, handle(async (req) => {
  const c = ctx(req);
  const employeeId = intParam(req.params.employeeId, 'employeeId');
  const on = day(req.query.on) ?? today();
  const [[e]] = await pool.query('SELECT id FROM hrms_employees WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [c.companyId, employeeId]);
  if (!e) throw new HrmsError(404, 'NOT_FOUND', 'That person was not found.');
  const [structure, choices, place] = await Promise.all([CO.defaultStructureFor(pool, c.companyId, employeeId, on), CO.getChoices(pool, c.companyId), CO.personLaw(pool, c.companyId, employeeId, on)]);
  const { minimumWage, ...rest } = place;
  return { structure, pfWageBasis: choices.pfWageBasis, place: rest, minimumWage };
}));

router.get('/law/minimum-wage', ...read, handle((req) => LAW.minimumWageOn(pool, {
  state: String(req.query.state ?? '').toUpperCase() || null, zone: req.query.zone ?? null, skill: req.query.skill ? String(req.query.skill).toUpperCase() : null,
  employment: req.query.employment ?? null, on: day(req.query.on) ?? today(),
})));

router.get('/payroll/runs/:id/law-versions', ...viewPay, handle(async (req) => ({ snapshot: await LAW.runSnapshot(pool, ctx(req).companyId, intParam(req.params.id)) })));
// Recomputes in a transaction that is always rolled back (reproduceRun also uses a savepoint): nothing is written.
router.post('/payroll/runs/:id/reproduce', ...editPay, handle(async (req) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    return await LAW.reproduceRun(conn, ctx(req), intParam(req.params.id));
  } finally {
    try { await conn.rollback(); } catch { /* nothing open */ }
    conn.release();
  }
}));

export default router;
