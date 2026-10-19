/**
 * profiles.js — a person's tax year: regime, age band, city / metro, PAN status
 * (TM/CF_HRMS_HIRING_SPEC.md §25.4).
 *
 *   regime     NEW unless chosen. The person may change it until the company's cut-off (default
 *              31 July); after it HR may change it ONCE more, with a reason. Every choice is audited.
 *   age band   from the date of birth (services/tax ageBandFor); no date of birth = below 60, said.
 *   metro      from the city: the location's address city, else a 50% city named in the company's
 *              place of posting; HR may set it either way (metro 0 / 1).
 *   PAN        the person's PAN identifier: VALID, INVALID (not ten characters of the shape) or NONE —
 *              no valid PAN means TDS at the higher rate (rule tds_no_pan), flagged on the run.
 */
import { notFound } from '../../lib/errors.js';
import { ageBandFor, isMetro } from '../tax/index.js';
import { audit, bad, refuse, text, today, dateText, stamp, isDate, panStatus, pansOf, employeeRow, loadRules } from './common.js';
import { yearSettings, review } from './settings.js';

const defaultProfile = (employeeId, year) => ({
  id: null, employeeId, year, regime: 'NEW', regimeSetHow: 'DEFAULT', regimeSetAt: null, changesAfterCutoff: 0, city: null, metro: null, declarationOpenUntil: null, note: null,
});
const shapeProfile = (r) => ({
  id: r.id, employeeId: r.employee_id, year: r.tax_year, regime: r.regime, regimeSetHow: r.regime_set_how, regimeSetAt: stamp(r.regime_set_at),
  changesAfterCutoff: Number(r.changes_after_cutoff) || 0, city: r.city ?? null, metro: r.metro == null ? null : Boolean(r.metro),
  declarationOpenUntil: dateText(r.declaration_open_until), note: r.note ?? null,
});

export async function profilesOf(db, companyId, employeeIds, year) {
  const out = new Map(employeeIds.map((id) => [id, defaultProfile(id, year)]));
  if (!employeeIds.length) return out;
  const [rows] = await db.query(`SELECT * FROM hrms_tax_profiles WHERE company_id = ? AND tax_year = ? AND deleted_at IS NULL AND employee_id IN (${employeeIds.map(() => '?').join(',')})`,
    [companyId, year, ...employeeIds]);
  for (const r of rows) out.set(r.employee_id, shapeProfile(r));
  return out;
}
export const profileOf = async (db, companyId, employeeId, year) => (await profilesOf(db, companyId, [employeeId], year)).get(employeeId);

/** The city of each person: their seat's location (address city), else the company's place of posting. */
export async function citiesOf(db, companyId, employeeIds) {
  const out = new Map();
  if (!employeeIds.length) return out;
  const [rows] = await db.query(
    `SELECT wa.employee_id, COALESCE(JSON_UNQUOTE(JSON_EXTRACT(l1.address_json, '$.city')), JSON_UNQUOTE(JSON_EXTRACT(l2.address_json, '$.city'))) AS city
       FROM hrms_work_assignments wa
       LEFT JOIN hrms_positions p ON p.company_id = wa.company_id AND p.id = wa.position_id
       LEFT JOIN hrms_locations l1 ON l1.company_id = wa.company_id AND l1.id = wa.location_id
       LEFT JOIN hrms_locations l2 ON l2.company_id = wa.company_id AND l2.id = p.location_id
      WHERE wa.company_id = ? AND wa.deleted_at IS NULL AND wa.status <> 'ENDED' AND wa.employee_id IN (${employeeIds.map(() => '?').join(',')})
      ORDER BY wa.is_primary DESC, wa.id`, [companyId, ...employeeIds]);
  for (const r of rows) if (!out.has(r.employee_id) && r.city && r.city !== 'null') out.set(r.employee_id, r.city);
  return out;
}
export async function placeOfPosting(db, companyId) {
  const [[hs]] = await db.query('SELECT place_of_posting FROM hrms_hiring_settings WHERE company_id = ? AND deleted_at IS NULL', [companyId]);
  return hs?.place_of_posting ?? null;
}
/** A 50% city named in a free text ("Unit-2, Bibi Nagar, Hyderabad" → Hyderabad), or null. */
export function cityInText(textValue, metros) {
  const t = String(textValue ?? '').toLowerCase();
  const all = [...metros, 'Bangalore', 'Bombay', 'Calcutta', 'Madras', 'New Delhi'];
  const hit = all.find((m) => new RegExp(`\\b${m.toLowerCase()}\\b`).test(t));
  return hit ?? null;
}

/**
 * Where the person lives for HRA, and whether it is a 50% city in the year:
 * { city, metro, metroFrom: 'HR' | 'CITY' | 'NONE' } and the engine's hra keys ({ metro } or { city }).
 */
export function metroOf(profile, locationCity, posting, metros) {
  const city = profile.city ?? locationCity ?? cityInText(posting, metros) ?? null;
  if (profile.metro != null) return { city, metro: profile.metro, metroFrom: 'HR', engine: { metro: profile.metro } };
  if (city) return { city, metro: isMetro(city, metros), metroFrom: 'CITY', engine: { city } };
  return { city: null, metro: false, metroFrom: 'NONE', engine: { metro: false } };
}

/** GET /tax/:year/profiles — everybody of the year: regime, PAN, age band, city; the counts. */
export async function listProfiles(db, c, year, query = {}) {
  const { start, end } = { start: `${year.slice(0, 4)}-04-01`, end: `${Number(year.slice(0, 4)) + 1}-03-31` };
  const where = ['company_id = ?', 'deleted_at IS NULL', 'date_of_joining <= ?', '(exit_date IS NULL OR exit_date >= ?)'];
  const params = [c.companyId, end, start];
  if (query.q) { where.push('(full_name LIKE ? OR employee_code LIKE ?)'); const like = `%${String(query.q).trim().slice(0, 100)}%`; params.push(like, like); }
  const [emps] = await db.query(`SELECT id, employee_code, full_name, date_of_birth, date_of_joining, exit_date FROM hrms_employees WHERE ${where.join(' AND ')} ORDER BY full_name, id LIMIT 5000`, params);
  const ids = emps.map((e) => e.id);
  const [profiles, pans, cities, posting, settings, { rules }] = await Promise.all([
    profilesOf(db, c.companyId, ids, year), pansOf(db, c.companyId, ids), citiesOf(db, c.companyId, ids), placeOfPosting(db, c.companyId), yearSettings(db, c.companyId, year), loadRules(db, year)]);
  const metros = rules ? rules.OLD.get('exempt_hra').metros : [];
  const [decl] = ids.length ? await db.query(
    `SELECT employee_id, COUNT(*) AS k, SUM(status = 'SUBMITTED') AS waiting FROM hrms_tax_declaration_lines WHERE company_id = ? AND tax_year = ? AND deleted_at IS NULL GROUP BY employee_id`, [c.companyId, year]) : [[]];
  const dmap = new Map(decl.map((d) => [d.employee_id, d]));
  let people = emps.map((e) => {
    const p = profiles.get(e.id);
    const pan = pans.get(e.id);
    const m = metroOf(p, cities.get(e.id), posting, metros);
    return {
      employee: { id: e.id, code: e.employee_code, name: e.full_name },
      regime: p.regime, regimeSetHow: p.regimeSetHow, changesAfterCutoff: p.changesAfterCutoff,
      panStatus: panStatus(pan), ageBand: ageBandFor({ dateOfBirth: dateText(e.date_of_birth) }, year), dateOfBirth: Boolean(e.date_of_birth),
      city: m.city, metro: m.metro, metroFrom: m.metroFrom, declarationOpenUntil: p.declarationOpenUntil,
      declarations: Number(dmap.get(e.id)?.k ?? 0), proofsWaiting: Number(dmap.get(e.id)?.waiting ?? 0),
    };
  });
  if (query.regime) people = people.filter((x) => x.regime === String(query.regime).toUpperCase());
  if (query.pan === 'missing') people = people.filter((x) => x.panStatus !== 'VALID');
  const counts = {
    people: people.length, NEW: people.filter((x) => x.regime === 'NEW').length, OLD: people.filter((x) => x.regime === 'OLD').length,
    noPan: people.filter((x) => x.panStatus !== 'VALID').length, noDateOfBirth: people.filter((x) => !x.dateOfBirth).length,
  };
  return { year, people, counts, settings, review: review(settings) };
}

async function ensureProfile(db, c, employeeId, year) {
  const [[r]] = await db.query('SELECT * FROM hrms_tax_profiles WHERE company_id = ? AND employee_id = ? AND tax_year = ? AND deleted_at IS NULL FOR UPDATE', [c.companyId, employeeId, year]);
  if (r) return r;
  await employeeRow(db, c.companyId, employeeId);
  const [ins] = await db.query("INSERT INTO hrms_tax_profiles (company_id, employee_id, tax_year, regime, regime_set_how, created_by) VALUES (?, ?, ?, 'NEW', 'DEFAULT', ?)", [c.companyId, employeeId, year, c.userId]);
  const [[n]] = await db.query('SELECT * FROM hrms_tax_profiles WHERE id = ?', [ins.insertId]);
  return n;
}

/**
 * The regime. by 'SELF': until the cut-off. by 'HR': until the cut-off freely; after it once, with a reason.
 */
export async function chooseRegime(db, c, employeeId, year, body = {}, { by = 'SELF', requestId = null } = {}) {
  const regime = String(body.regime ?? '').toUpperCase();
  if (!['OLD', 'NEW'].includes(regime)) throw bad('Choose the regime: OLD or NEW.');
  const settings = await yearSettings(db, c.companyId, year);
  const r = await ensureProfile(db, c, employeeId, year);
  if (r.regime === regime && r.regime_set_how !== 'DEFAULT') return { profile: shapeProfile(r), changed: false };
  const past = !settings.regimeOpen;
  const reason = text(body.reason, 500);
  if (past) {
    if (by === 'SELF') throw refuse('PAST_CUTOFF', `The regime for ${year} could be changed until ${settings.regimeCutoff}. HR can change it once more for you.`);
    if (Number(r.changes_after_cutoff) >= 1) throw refuse('NO_MORE_CHANGES', `The regime for ${year} has already been changed once after the cut-off (${settings.regimeCutoff}). It stays as it is for the payroll; the person can still choose on their return.`);
    if (!reason || reason.length < 5) throw bad('Say why the regime is changed after the cut-off. The reason is kept with it.');
  }
  await db.query('UPDATE hrms_tax_profiles SET regime = ?, regime_set_at = NOW(), regime_set_by = ?, regime_set_how = ?, changes_after_cutoff = changes_after_cutoff + ?, note = COALESCE(?, note) WHERE id = ?',
    [regime, c.userId, by === 'HR' ? 'HR' : 'SELF', past ? 1 : 0, reason, r.id]);
  await audit(db, c, 'hrms_tax_profiles', r.id, 'UPDATE', { regime: r.regime, how: r.regime_set_how }, { regime, by, afterCutoff: past, reason, year, employeeId }, requestId);
  const [[after]] = await db.query('SELECT * FROM hrms_tax_profiles WHERE id = ?', [r.id]);
  return { profile: shapeProfile(after), changed: true };
}

/** PUT /tax/:year/profiles/:employeeId { city?, metro? (true|false|null), declarationOpenUntil?, note? } — HR. */
export async function putProfile(db, c, employeeId, year, body = {}, requestId = null) {
  const r = await ensureProfile(db, c, employeeId, year);
  const problems = [];
  const city = body.city === undefined ? r.city : text(body.city, 100);
  const metro = body.metro === undefined ? r.metro : body.metro === null ? null : body.metro ? 1 : 0;
  let until = body.declarationOpenUntil === undefined ? dateText(r.declaration_open_until) : body.declarationOpenUntil;
  if (until === '') until = null;
  if (until && !isDate(until)) problems.push('Re-opened until: a date as YYYY-MM-DD.');
  if (until && until < today()) problems.push('Re-opened until: today or later.');
  if (problems.length) throw bad('The tax profile cannot be saved yet.', problems);
  const note = body.note === undefined ? r.note : text(body.note, 500);
  await db.query('UPDATE hrms_tax_profiles SET city = ?, metro = ?, declaration_open_until = ?, note = ? WHERE id = ?', [city, metro, until, note, r.id]);
  await audit(db, c, 'hrms_tax_profiles', r.id, 'UPDATE', { city: r.city, metro: r.metro, declarationOpenUntil: dateText(r.declaration_open_until) }, { city, metro, declarationOpenUntil: until, note }, requestId);
  const [[after]] = await db.query('SELECT * FROM hrms_tax_profiles WHERE id = ?', [r.id]);
  return { profile: shapeProfile(after) };
}

export { notFound };
