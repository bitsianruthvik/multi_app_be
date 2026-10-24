/**
 * company.js — what a COMPANY holds around the law (spec §36.1): its choices, its own notes against
 * a law version, a location's state and minimum-wage zone, a role's skill category, scheduled
 * employment and default salary structure. Every write is audited (hrms_audit_log, same transaction).
 * The law itself is read-only here.
 */
import { HrmsError, notFound } from '../../lib/errors.js';
import { audit as auditRow } from '../peopleService.js';
import { lawInForce, listRules, getVersion, DOMAIN_WORDS } from './store.js';
import { companyStates, lawPlacesOf } from './personLaw.js';
import { employmentsOf, minimumWageOn } from './minWage.js';
import { SKILLS } from './validate.js';

const audit = (db, c, t, id, action, before, after, requestId) => auditRow(db, c, t, id, action, before, after, requestId);
const bad = (message, problems = [message]) => new HrmsError(422, 'INVALID', message, { problems });
const text = (v, max) => (v == null || String(v).trim() === '' ? null : String(v).trim().slice(0, max));
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const money = (v) => (v == null || v === '' ? null : Math.round(Number(v) * 100) / 100);

export const STATES = [
  ['AN', 'Andaman and Nicobar Islands'], ['AP', 'Andhra Pradesh'], ['AR', 'Arunachal Pradesh'], ['AS', 'Assam'], ['BR', 'Bihar'], ['CH', 'Chandigarh'],
  ['CT', 'Chhattisgarh'], ['DH', 'Dadra and Nagar Haveli and Daman and Diu'], ['DL', 'Delhi'], ['GA', 'Goa'], ['GJ', 'Gujarat'], ['HR', 'Haryana'],
  ['HP', 'Himachal Pradesh'], ['JK', 'Jammu and Kashmir'], ['JH', 'Jharkhand'], ['KA', 'Karnataka'], ['KL', 'Kerala'], ['LA', 'Ladakh'], ['LD', 'Lakshadweep'],
  ['MP', 'Madhya Pradesh'], ['MH', 'Maharashtra'], ['MN', 'Manipur'], ['ML', 'Meghalaya'], ['MZ', 'Mizoram'], ['NL', 'Nagaland'], ['OR', 'Odisha'],
  ['PY', 'Puducherry'], ['PB', 'Punjab'], ['RJ', 'Rajasthan'], ['SK', 'Sikkim'], ['TN', 'Tamil Nadu'], ['TG', 'Telangana'], ['TR', 'Tripura'],
  ['UP', 'Uttar Pradesh'], ['UT', 'Uttarakhand'], ['WB', 'West Bengal'],
].map(([code, name]) => ({ code, name }));
const STATE_CODES = new Set(STATES.map((s) => s.code));
export const SKILL_WORDS = { UNSKILLED: 'Unskilled', SEMI_SKILLED: 'Semi-skilled', SKILLED: 'Skilled', HIGHLY_SKILLED: 'Highly skilled' };

/* ── choices ───────────────────────────────────────────────────────────── */

const CHOICE_FIELDS = [
  ['pfWageBasis', 'pf_wage_basis'], ['pfEstablishmentCode', 'pf_establishment_code'], ['esiEmployerCode', 'esi_employer_code'],
  ['ptRegistrationNo', 'pt_registration_no'], ['ptEnrolmentNo', 'pt_enrolment_no'], ['lwfRegistrationNo', 'lwf_registration_no'],
  ['bonusRate', 'bonus_rate'], ['note', 'note'],
];
const shapeChoices = (r) => ({
  pfWageBasis: r?.pf_wage_basis ?? 'CEILING', pfEstablishmentCode: r?.pf_establishment_code ?? null, esiEmployerCode: r?.esi_employer_code ?? null,
  ptRegistrationNo: r?.pt_registration_no ?? null, ptEnrolmentNo: r?.pt_enrolment_no ?? null, lwfRegistrationNo: r?.lwf_registration_no ?? null,
  bonusRate: r?.bonus_rate == null ? null : Number(r.bonus_rate), note: r?.note ?? null, exists: Boolean(r),
});

export async function getChoices(db, companyId) {
  const [[r]] = await db.query('SELECT * FROM hrms_law_company_choices WHERE company_id = ? AND deleted_at IS NULL', [companyId]);
  return shapeChoices(r);
}

/** The company's choices; a bonus rate is checked against the law's minimum and maximum. */
export async function putChoices(db, c, body = {}, requestId = null) {
  const before = await getChoices(db, c.companyId);
  const next = { ...before };
  const problems = [];
  for (const [k] of CHOICE_FIELDS) if (body[k] !== undefined) next[k] = body[k];
  next.pfWageBasis = String(next.pfWageBasis ?? 'CEILING').toUpperCase();
  if (!['CEILING', 'FULL'].includes(next.pfWageBasis)) problems.push('PF wage: on the ceiling, or on the full wage.');
  for (const k of ['pfEstablishmentCode', 'esiEmployerCode', 'ptRegistrationNo', 'ptEnrolmentNo', 'lwfRegistrationNo']) next[k] = text(next[k], 40);
  next.note = text(next.note, 1000);
  if (next.bonusRate != null && next.bonusRate !== '') {
    const rate = Number(next.bonusRate);
    const [rates] = await lawInForce(db, { domains: ['BONUS'], jurisdictions: ['IN'], on: today() }).then((rs) => [rs.find((r) => r.ruleKey === 'rates')]);
    const min = Number(rates?.value?.minRatePct ?? 8.33);
    const max = Number(rates?.value?.maxRatePct ?? 20);
    if (!Number.isFinite(rate) || rate < min || rate > max) problems.push(`Bonus rate: between ${min}% and ${max}% (the law${rates ? `, version ${rates.version} from ${rates.effectiveFrom}` : ''}).`);
    next.bonusRate = Math.round(rate * 100) / 100;
  } else next.bonusRate = null;
  if (problems.length) throw bad('These choices cannot be saved yet.', problems);
  const vals = [next.pfWageBasis, next.pfEstablishmentCode, next.esiEmployerCode, next.ptRegistrationNo, next.ptEnrolmentNo, next.lwfRegistrationNo, next.bonusRate, next.note];
  const [[row]] = await db.query('SELECT id FROM hrms_law_company_choices WHERE company_id = ? AND deleted_at IS NULL', [c.companyId]);
  let id = row?.id;
  if (row) {
    await db.query('UPDATE hrms_law_company_choices SET pf_wage_basis = ?, pf_establishment_code = ?, esi_employer_code = ?, pt_registration_no = ?, pt_enrolment_no = ?, lwf_registration_no = ?, bonus_rate = ?, note = ? WHERE id = ?', [...vals, row.id]);
  } else {
    const [ins] = await db.query('INSERT INTO hrms_law_company_choices (pf_wage_basis, pf_establishment_code, esi_employer_code, pt_registration_no, pt_enrolment_no, lwf_registration_no, bonus_rate, note, company_id, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [...vals, c.companyId, c.userId]);
    id = ins.insertId;
  }
  const after = await getChoices(db, c.companyId);
  await audit(db, c, 'hrms_law_company_choices', id, row ? 'UPDATE' : 'CREATE', before, after, requestId);
  return { choices: after };
}

/** Makes the row if a company has none (payroll setup). */
export async function ensureChoices(db, c, requestId = null) {
  const [[row]] = await db.query('SELECT id FROM hrms_law_company_choices WHERE company_id = ? AND deleted_at IS NULL', [c.companyId]);
  if (row) return false;
  const [ins] = await db.query("INSERT INTO hrms_law_company_choices (company_id, pf_wage_basis, created_by) VALUES (?, 'CEILING', ?)", [c.companyId, c.userId]);
  await audit(db, c, 'hrms_law_company_choices', ins.insertId, 'CREATE', null, { pfWageBasis: 'CEILING' }, requestId);
  return true;
}

/* ── the company's own note against a law version ─────────────────────── */

export async function notesOf(db, companyId) {
  const [rows] = await db.query('SELECT rule_id, verification, note, updated_at FROM hrms_law_company_notes WHERE company_id = ? AND deleted_at IS NULL', [companyId]);
  return new Map(rows.map((r) => [r.rule_id, { verification: r.verification ?? null, note: r.note ?? null, updatedAt: r.updated_at }]));
}

export async function setNote(db, c, ruleId, body = {}, requestId = null) {
  const v = await getVersion(db, ruleId);
  if (!v || v.kind !== 'LAW' || v.status === 'DRAFT') throw notFound('That rule');
  const verification = body.verification == null ? null : String(body.verification).toUpperCase();
  if (verification && !['VERIFIED', 'UNVERIFIED'].includes(verification)) throw bad('Checked: verified or unverified.');
  const note = text(body.note, 500);
  const [[row]] = await db.query('SELECT id, verification, note FROM hrms_law_company_notes WHERE company_id = ? AND rule_id = ? AND deleted_at IS NULL', [c.companyId, v.id]);
  if (row) await db.query('UPDATE hrms_law_company_notes SET verification = COALESCE(?, verification), note = COALESCE(?, note) WHERE id = ?', [verification, note, row.id]);
  else await db.query('INSERT INTO hrms_law_company_notes (company_id, rule_id, verification, note, created_by) VALUES (?, ?, ?, ?, ?)', [c.companyId, v.id, verification, note, c.userId]);
  await audit(db, c, 'hrms_law_company_notes', row?.id ?? v.id, row ? 'UPDATE' : 'CREATE', row ? { verification: row.verification, note: row.note } : null, { ruleId: v.id, verification, note }, requestId);
  return { ok: true };
}

/* ── locations: state and zone ─────────────────────────────────────────── */

export async function listLocationLaw(db, companyId) {
  const [rows] = await db.query(
    `SELECT l.id, l.name, l.code, l.status, ll.state_code, ll.min_wage_zone, ll.note
       FROM hrms_locations l LEFT JOIN hrms_location_law ll ON ll.company_id = l.company_id AND ll.location_id = l.id AND ll.deleted_at IS NULL
      WHERE l.company_id = ? AND l.deleted_at IS NULL ORDER BY l.name`, [companyId]);
  return rows.map((r) => ({ locationId: r.id, name: r.name, code: r.code ?? null, status: r.status, stateCode: r.state_code ?? null, zone: r.min_wage_zone ?? null, note: r.note ?? null }));
}

export async function putLocationLaw(db, c, locationId, body = {}, requestId = null) {
  const [[loc]] = await db.query('SELECT id, name FROM hrms_locations WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [c.companyId, locationId]);
  if (!loc) throw notFound('That location');
  const problems = [];
  const stateCode = body.stateCode == null || body.stateCode === '' ? null : String(body.stateCode).trim().toUpperCase();
  if (stateCode && !STATE_CODES.has(stateCode)) problems.push('State: a state of India (TG for Telangana …).');
  const zone = text(body.zone, 20);
  if (zone && !/^[A-Za-z0-9 -]{1,20}$/.test(zone)) problems.push('Zone: as the state\'s notification names it (I, II, III …).');
  if (problems.length) throw bad('This location cannot be saved yet.', problems);
  const [[row]] = await db.query('SELECT id, state_code, min_wage_zone FROM hrms_location_law WHERE company_id = ? AND location_id = ? AND deleted_at IS NULL', [c.companyId, loc.id]);
  if (row) await db.query('UPDATE hrms_location_law SET state_code = ?, min_wage_zone = ?, note = ? WHERE id = ?', [stateCode, zone, text(body.note, 500), row.id]);
  else await db.query('INSERT INTO hrms_location_law (company_id, location_id, state_code, min_wage_zone, note, created_by) VALUES (?, ?, ?, ?, ?, ?)', [c.companyId, loc.id, stateCode, zone, text(body.note, 500), c.userId]);
  await audit(db, c, 'hrms_location_law', row?.id ?? loc.id, row ? 'UPDATE' : 'CREATE', row ? { stateCode: row.state_code, zone: row.min_wage_zone } : null, { locationId: loc.id, stateCode, zone }, requestId);
  return { location: (await listLocationLaw(db, c.companyId)).find((l) => l.locationId === loc.id) };
}

/* ── roles: skill, scheduled employment, default structure ─────────────── */

async function roleRow(db, companyId, roleId) {
  const [[r]] = await db.query('SELECT id, title FROM hrms_roles WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, roleId]);
  if (!r) throw notFound('That role');
  return r;
}

export async function getRoleLaw(db, companyId, roleId, { withPay = false } = {}) {
  const role = await roleRow(db, companyId, roleId);
  const [[law]] = await db.query('SELECT skill_category, scheduled_employment FROM hrms_role_law WHERE company_id = ? AND role_id = ? AND deleted_at IS NULL', [companyId, role.id]);
  const [[st]] = await db.query(
    `SELECT rs.structure_id, rs.ctc_min, rs.ctc_max, s.name AS structure_name FROM hrms_pay_role_structures rs
       LEFT JOIN hrms_pay_structures s ON s.company_id = rs.company_id AND s.id = rs.structure_id
      WHERE rs.company_id = ? AND rs.role_id = ? AND rs.deleted_at IS NULL`, [companyId, role.id]);
  const states = await companyStates(db, companyId);
  const options = [];
  for (const s of states) { const e = await employmentsOf(db, s, today()); options.push(...e.employments.map((x) => ({ ...x, state: s }))); }
  const [structures] = await db.query("SELECT id, name, code FROM hrms_pay_structures WHERE company_id = ? AND deleted_at IS NULL AND status = 'ACTIVE' ORDER BY name", [companyId]);
  return {
    roleId: role.id, title: role.title,
    skillCategory: law?.skill_category ?? null, scheduledEmployment: law?.scheduled_employment ?? null,
    defaultStructure: st ? { structureId: st.structure_id, name: st.structure_name ?? null, ...(withPay ? { ctcMin: money(st.ctc_min), ctcMax: money(st.ctc_max) } : {}) } : null,
    options: { skills: SKILLS.map((k) => ({ key: k, name: SKILL_WORDS[k] })), employments: options, structures: structures.map((s) => ({ id: s.id, name: s.name, code: s.code })) },
  };
}

/** { skillCategory?, scheduledEmployment?, defaultStructureId? (null = none), ctcMin?, ctcMax? } — the CTC band only with pay access. */
export async function putRoleLaw(db, c, roleId, body = {}, requestId = null, { withPay = false } = {}) {
  const role = await roleRow(db, c.companyId, roleId);
  const before = await getRoleLaw(db, c.companyId, role.id, { withPay: true });
  const problems = [];
  const skill = body.skillCategory === undefined ? before.skillCategory : (body.skillCategory ? String(body.skillCategory).toUpperCase() : null);
  if (skill && !SKILLS.includes(skill)) problems.push(`Skill: ${SKILLS.map((k) => SKILL_WORDS[k].toLowerCase()).join(', ')}.`);
  const employment = body.scheduledEmployment === undefined ? before.scheduledEmployment : text(body.scheduledEmployment, 64);
  if (employment && !before.options.employments.some((e) => e.key === employment)) problems.push('Scheduled employment: one the minimum-wage notifications of your states name.');
  const structChange = body.defaultStructureId !== undefined || body.ctcMin !== undefined || body.ctcMax !== undefined;
  if ((body.ctcMin !== undefined || body.ctcMax !== undefined) && !withPay) throw new HrmsError(403, 'PAY_HIDDEN', 'You do not have access to pay, so the CTC band cannot be set here.');
  const structureId = body.defaultStructureId === undefined ? before.defaultStructure?.structureId ?? null : (body.defaultStructureId ? Number(body.defaultStructureId) : null);
  if (structureId && !before.options.structures.some((s) => s.id === structureId)) problems.push('Default salary structure: an active structure of the company.');
  const ctcMin = body.ctcMin === undefined ? before.defaultStructure?.ctcMin ?? null : money(body.ctcMin);
  const ctcMax = body.ctcMax === undefined ? before.defaultStructure?.ctcMax ?? null : money(body.ctcMax);
  if ((ctcMin != null && !(ctcMin >= 0)) || (ctcMax != null && !(ctcMax >= 0))) problems.push('CTC band: amounts a year, zero or more.');
  if (ctcMin != null && ctcMax != null && ctcMin > ctcMax) problems.push('CTC band: the lower end is not above the upper end.');
  if (!structureId && (ctcMin != null || ctcMax != null) && body.defaultStructureId !== null) problems.push('CTC band: choose the default structure it goes with.');
  if (problems.length) throw bad('These cannot be saved yet.', problems);

  const [[law]] = await db.query('SELECT id FROM hrms_role_law WHERE company_id = ? AND role_id = ? AND deleted_at IS NULL', [c.companyId, role.id]);
  if (law) await db.query('UPDATE hrms_role_law SET skill_category = ?, scheduled_employment = ? WHERE id = ?', [skill, employment, law.id]);
  else if (skill || employment) await db.query('INSERT INTO hrms_role_law (company_id, role_id, skill_category, scheduled_employment, created_by) VALUES (?, ?, ?, ?, ?)', [c.companyId, role.id, skill, employment, c.userId]);
  if (structChange) {
    const [[rs]] = await db.query('SELECT id FROM hrms_pay_role_structures WHERE company_id = ? AND role_id = ? AND deleted_at IS NULL', [c.companyId, role.id]);
    if (!structureId) { if (rs) await db.query('UPDATE hrms_pay_role_structures SET deleted_at = NOW() WHERE id = ?', [rs.id]); } else if (rs) await db.query('UPDATE hrms_pay_role_structures SET structure_id = ?, ctc_min = ?, ctc_max = ? WHERE id = ?', [structureId, ctcMin, ctcMax, rs.id]);
    else await db.query('INSERT INTO hrms_pay_role_structures (company_id, role_id, structure_id, ctc_min, ctc_max, created_by) VALUES (?, ?, ?, ?, ?, ?)', [c.companyId, role.id, structureId, ctcMin, ctcMax, c.userId]);
  }
  const after = await getRoleLaw(db, c.companyId, role.id, { withPay: true });
  const strip = (x) => ({ skillCategory: x.skillCategory, scheduledEmployment: x.scheduledEmployment, defaultStructure: x.defaultStructure });
  await audit(db, c, 'hrms_role_law', role.id, 'UPDATE', strip(before), strip(after), requestId);
  return getRoleLaw(db, c.companyId, role.id, { withPay });
}

/**
 * The default salary structure for a person (their main role's), for a new salary to preselect:
 * { structureId, name, ctcMin, ctcMax, roleId, roleTitle } or null.
 */
export async function defaultStructureFor(db, companyId, employeeId, on = today()) {
  const place = (await lawPlacesOf(db, companyId, [employeeId], on)).get(Number(employeeId));
  if (!place?.roleId) return null;
  const [[st]] = await db.query(
    `SELECT rs.structure_id, rs.ctc_min, rs.ctc_max, s.name FROM hrms_pay_role_structures rs
       JOIN hrms_pay_structures s ON s.company_id = rs.company_id AND s.id = rs.structure_id AND s.deleted_at IS NULL
      WHERE rs.company_id = ? AND rs.role_id = ? AND rs.deleted_at IS NULL`, [companyId, place.roleId]);
  if (!st) return null;
  return { structureId: st.structure_id, name: st.name, ctcMin: money(st.ctc_min), ctcMax: money(st.ctc_max), roleId: place.roleId, roleTitle: place.roleTitle };
}

/** A person's law facts on a day: state, zone, skill, employment, and the minimum wage that applies. */
export async function personLaw(db, companyId, employeeId, on = today()) {
  const place = (await lawPlacesOf(db, companyId, [employeeId], on)).get(Number(employeeId));
  const mw = await minimumWageOn(db, { state: place.state, employment: place.employment, zone: place.zone, skill: place.skill, on });
  return { ...place, minimumWage: mw };
}

/* ── rules in force (the company's read-only page) ─────────────────────── */

/**
 * Every rule that applies to the company on a day, grouped by domain, each with its version history.
 * Tax rules: the tax year's, both regimes.
 */
export async function rulesInForcePage(db, companyId, on = today()) {
  const states = await companyStates(db, companyId);
  const inForce = await lawInForce(db, { jurisdictions: ['IN', ...states], on });
  const all = await listRules(db, { includeTax: false });
  const notes = await notesOf(db, companyId);
  const history = (r) => all.filter((x) => x.status !== 'DRAFT' && x.domain === r.domain && x.jurisdiction === r.jurisdiction && x.ruleKey === r.ruleKey)
    .map((x) => ({ id: x.id, effectiveFrom: x.effectiveFrom, effectiveTo: x.effectiveTo, version: x.version, status: x.status, verified: x.verified, publishedAt: x.publishedAt, reviewedBy: x.reviewedBy, value: x.value, sourceUrl: x.sourceUrl, sourceNote: x.sourceNote }));
  const rules = inForce.map((r) => ({ ...r, domainName: DOMAIN_WORDS[r.domain] ?? r.domain, companyNote: notes.get(r.id) ?? null, history: history(r) }));
  const domains = [...new Set(rules.map((r) => r.domain))].map((d) => ({ domain: d, name: DOMAIN_WORDS[d] ?? d, rules: rules.filter((r) => r.domain === d) }));
  return { on, states: states.map((s) => ({ code: s, name: STATES.find((x) => x.code === s)?.name ?? s })), domains, unverified: rules.filter((r) => !r.verified).length };
}

/** The tax rules of a year, both regimes, with versions (read-only page). */
export async function taxRulesPage(db, year) {
  const rows = await listRules(db, { domain: 'TAX', taxYear: year });
  const live = rows.filter((r) => r.status === 'PUBLISHED');
  const [years] = await db.query("SELECT DISTINCT tax_year FROM hrms_tax_rules WHERE deleted_at IS NULL AND status = 'PUBLISHED' ORDER BY tax_year DESC");
  return {
    year, years: years.map((y) => y.tax_year),
    rules: live.map((r) => ({ ...r, history: rows.filter((x) => x.status !== 'DRAFT' && x.ruleKey === r.ruleKey && x.regime === r.regime).map((x) => ({ id: x.id, version: x.version, status: x.status, publishedAt: x.publishedAt, verified: x.verified })) })),
    unverified: live.filter((r) => !r.verified).length,
  };
}

export default { getChoices, putChoices, ensureChoices, notesOf, setNote, listLocationLaw, putLocationLaw, getRoleLaw, putRoleLaw, defaultStructureFor, personLaw, rulesInForcePage, taxRulesPage, STATES, SKILL_WORDS };
