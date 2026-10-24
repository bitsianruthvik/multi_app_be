/**
 * settings.js — a company's tax YEAR (windows, regime cut-off, the CA tick, Forms released) and its
 * deductor details (TAN …). TM/CF_HRMS_HIRING_SPEC.md §25.4.
 *
 * A year with no row has the defaults: declarations 1–30 April, proofs 1–31 January, regime
 * cut-off 31 July. The first save writes the row.
 *
 * The windows:
 *   declarations  a person adds and changes their own declarations while it is open (today), or until
 *                 the day HR re-opened it for them (profile.declarationOpenUntil). HR may always.
 *   proofs        a person uploads proofs while it is open (or re-opened for them). For the TDS of a
 *                 month, once the window has CLOSED before the month ends, only VERIFIED amounts
 *                 count (proofsStatusFor).
 *   regime        a person chooses until the cut-off; after it, HR may change it once more, with a reason.
 *
 * The "Reviewed by our CA for <year>" tick is the Owner's; until it is set every tax screen shows
 * the banner (review(year) is in every tax answer).
 */
import { yearBounds } from '../tax/index.js';
import { audit, bad, refuse, text, isDate, dateText, today, stamp, json, PAN_RE, TAN_RE, loadRules, formsOf } from './common.js';

export function defaultsFor(year) {
  const { startYear, endYear } = yearBounds(year);
  return {
    declarationFrom: `${startYear}-04-01`, declarationTo: `${startYear}-04-30`,
    proofFrom: `${endYear}-01-01`, proofTo: `${endYear}-01-31`,
    regimeCutoff: `${startYear}-07-31`,
  };
}

const windowState = (from, to, on) => (on < from ? 'NOT_YET' : on > to ? 'CLOSED' : 'OPEN');

/** The settings of a year, with today's state of each window. */
export async function yearSettings(db, companyId, year, { on = today() } = {}) {
  yearBounds(year);
  const [[r]] = await db.query('SELECT * FROM hrms_tax_settings WHERE company_id = ? AND tax_year = ? AND deleted_at IS NULL', [companyId, year]);
  const d = defaultsFor(year);
  const s = r ? {
    declarationFrom: dateText(r.declaration_from), declarationTo: dateText(r.declaration_to), proofFrom: dateText(r.proof_from), proofTo: dateText(r.proof_to), regimeCutoff: dateText(r.regime_cutoff),
  } : d;
  return {
    year, saved: Boolean(r), ...s,
    declarationWindow: windowState(s.declarationFrom, s.declarationTo, on),
    proofWindow: windowState(s.proofFrom, s.proofTo, on),
    regimeOpen: on <= s.regimeCutoff,
    caReviewed: Boolean(r?.ca_reviewed), caReviewedAt: stamp(r?.ca_reviewed_at), caNote: r?.ca_note ?? null,
    formsReleased: Boolean(r?.forms_released_at), formsReleasedAt: stamp(r?.forms_released_at),
    updatedAt: stamp(r?.updated_at),
  };
}

/** For the TDS of `month`: 'CLOSED' when the proof window ended before the month did. */
export const proofsStatusFor = (settings, monthEnd) => (settings.proofTo < monthEnd ? 'CLOSED' : 'OPEN');

/** The banner every tax screen shows until the Owner ticks the year. */
export function review(settings) {
  return {
    year: settings.year, caReviewed: settings.caReviewed,
    banner: settings.caReviewed ? null
      : `Not yet reviewed by our CA for ${settings.year}. The tax figures follow the rules as read from the law; check them with your CA before relying on them.`,
  };
}

async function ensureRow(db, c, year) {
  const [[r]] = await db.query('SELECT id FROM hrms_tax_settings WHERE company_id = ? AND tax_year = ? AND deleted_at IS NULL FOR UPDATE', [c.companyId, year]);
  if (r) return r.id;
  const d = defaultsFor(year);
  const [ins] = await db.query(
    'INSERT INTO hrms_tax_settings (company_id, tax_year, declaration_from, declaration_to, proof_from, proof_to, regime_cutoff, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [c.companyId, year, d.declarationFrom, d.declarationTo, d.proofFrom, d.proofTo, d.regimeCutoff, c.userId]);
  return ins.insertId;
}

/** PUT /tax/years/:year { declarationFrom, declarationTo, proofFrom, proofTo, regimeCutoff } */
export async function putYearSettings(db, c, year, body = {}, requestId = null) {
  const before = await yearSettings(db, c.companyId, year);
  const { start, end } = yearBounds(year);
  const next = {};
  const problems = [];
  const words = { declarationFrom: 'Declarations from', declarationTo: 'Declarations to', proofFrom: 'Proofs from', proofTo: 'Proofs to', regimeCutoff: 'Regime cut-off' };
  for (const k of Object.keys(words)) {
    const v = body[k] === undefined ? before[k] : body[k];
    if (!isDate(v)) { problems.push(`${words[k]}: a date as YYYY-MM-DD.`); continue; }
    // A window may run a little past the year (proofs for March), never before it starts.
    if (v < start || v > `${Number(end.slice(0, 4)) + 1}-06-30`) problems.push(`${words[k]}: within the tax year ${year} (from ${start}).`);
    next[k] = v;
  }
  if (!problems.length) {
    if (next.declarationFrom > next.declarationTo) problems.push('The declaration window ends before it starts.');
    if (next.proofFrom > next.proofTo) problems.push('The proof window ends before it starts.');
  }
  if (problems.length) throw bad('The tax year settings cannot be saved yet.', problems);
  const id = await ensureRow(db, c, year);
  await db.query('UPDATE hrms_tax_settings SET declaration_from = ?, declaration_to = ?, proof_from = ?, proof_to = ?, regime_cutoff = ? WHERE company_id = ? AND id = ?',
    [next.declarationFrom, next.declarationTo, next.proofFrom, next.proofTo, next.regimeCutoff, c.companyId, id]);
  const pick = (s) => Object.fromEntries(Object.keys(words).map((k) => [k, s[k]]));
  await audit(db, c, 'hrms_tax_settings', id, 'UPDATE', pick(before), next, requestId);
  return readYear(db, c, year);
}

/** POST /tax/years/:year/ca-review { reviewed: true|false, note? } — the Owner only. */
export async function setCaReviewed(db, c, year, body = {}, requestId = null) {
  if (!c.owner) throw refuse('OWNER_ONLY', 'Only the Owner ticks “Reviewed by our CA” for a year.');
  const reviewed = body.reviewed !== false;
  const note = text(body.note, 500);
  const id = await ensureRow(db, c, year);
  await db.query('UPDATE hrms_tax_settings SET ca_reviewed = ?, ca_reviewed_at = ?, ca_reviewed_by = ?, ca_note = ? WHERE company_id = ? AND id = ?',
    [reviewed ? 1 : 0, reviewed ? new Date() : null, reviewed ? c.userId : null, note, c.companyId, id]);
  await audit(db, c, 'hrms_tax_settings', id, 'APPROVE', null, { caReviewed: reviewed, year, note }, requestId);
  return readYear(db, c, year);
}

/** POST /tax/:year/forms/release { release: true|false } — Forms 16 / 130 show in My tax › Forms. */
export async function releaseForms(db, c, year, body = {}, requestId = null) {
  const release = body.release !== false;
  const id = await ensureRow(db, c, year);
  await db.query('UPDATE hrms_tax_settings SET forms_released_at = ?, forms_released_by = ? WHERE company_id = ? AND id = ?',
    [release ? new Date() : null, release ? c.userId : null, c.companyId, id]);
  await audit(db, c, 'hrms_tax_settings', id, 'UPDATE', null, { formsReleased: release, year }, requestId);
  return readYear(db, c, year);
}

/* ── the deductor ─────────────────────────────────────────────────────── */

export async function deductorOf(db, companyId) {
  const [[r]] = await db.query('SELECT * FROM hrms_tax_company WHERE company_id = ? AND deleted_at IS NULL', [companyId]);
  const [[hs]] = await db.query('SELECT company_legal_name, place_of_posting FROM hrms_hiring_settings WHERE company_id = ? AND deleted_at IS NULL', [companyId]);
  const [[co]] = await db.query('SELECT name FROM companies WHERE id = ?', [companyId]);
  return {
    saved: Boolean(r),
    tan: r?.tan ?? null, pan: r?.pan ?? null,
    name: r?.deductor_name ?? hs?.company_legal_name ?? co?.name ?? '',
    branch: r?.branch ?? null,
    address: json(r?.address_json, null) ?? (hs?.place_of_posting ? { line1: hs.place_of_posting } : {}),
    responsible: json(r?.responsible_json, {}) ?? {},
    category: r?.deductor_category ?? 'K',
    placeOfPosting: hs?.place_of_posting ?? null,
  };
}

/** PUT /tax/deductor { tan, pan, name, branch, address: {...}, responsible: { name, designation, ... } } */
export async function putDeductor(db, c, body = {}, requestId = null) {
  const before = await deductorOf(db, c.companyId);
  const problems = [];
  const tan = body.tan === undefined ? before.tan : text(body.tan, 10)?.toUpperCase() ?? null;
  const pan = body.pan === undefined ? before.pan : text(body.pan, 10)?.toUpperCase() ?? null;
  if (tan && !TAN_RE.test(tan)) problems.push('TAN: ten characters, like ABCD12345E.');
  if (pan && !PAN_RE.test(pan)) problems.push('PAN: ten characters, like ABCDE1234F.');
  if (problems.length) throw bad('The deductor details cannot be saved yet.', problems);
  const name = body.name === undefined ? before.name : text(body.name, 200);
  const branch = body.branch === undefined ? before.branch : text(body.branch, 100);
  const clean = (o, keys) => Object.fromEntries(keys.map((k) => [k, text(o?.[k], 200)]).filter(([, v]) => v));
  const address = body.address === undefined ? before.address : clean(body.address, ['line1', 'line2', 'city', 'state', 'pin', 'email', 'phone']);
  const responsible = body.responsible === undefined ? before.responsible : clean(body.responsible, ['name', 'designation', 'fatherName', 'pan', 'email', 'phone']);
  const [[r]] = await db.query('SELECT id FROM hrms_tax_company WHERE company_id = ? AND deleted_at IS NULL FOR UPDATE', [c.companyId]);
  let id = r?.id;
  if (id) {
    await db.query('UPDATE hrms_tax_company SET tan = ?, pan = ?, deductor_name = ?, branch = ?, address_json = ?, responsible_json = ? WHERE id = ?',
      [tan, pan, name, branch, JSON.stringify(address), JSON.stringify(responsible), id]);
  } else {
    const [ins] = await db.query('INSERT INTO hrms_tax_company (company_id, tan, pan, deductor_name, branch, address_json, responsible_json, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [c.companyId, tan, pan, name, branch, JSON.stringify(address), JSON.stringify(responsible), c.userId]);
    id = ins.insertId;
  }
  await audit(db, c, 'hrms_tax_company', id, r ? 'UPDATE' : 'CREATE', r ? { tan: before.tan, pan: before.pan, name: before.name } : null, { tan, pan, name, branch, address, responsible }, requestId);
  return { deductor: await deductorOf(db, c.companyId) };
}

/** GET /tax/years/:year — settings, deductor, the forms of the year, the banner. */
export async function readYear(db, c, year) {
  const settings = await yearSettings(db, c.companyId, year);
  const { rules, reason } = await loadRules(db, year);
  return {
    settings, defaults: defaultsFor(year), deductor: await deductorOf(db, c.companyId), forms: formsOf(rules), rulesMissing: rules ? null : reason,
    review: review(settings), canTickReview: Boolean(c.owner),
  };
}

/** The tax years a company can work in: those with rules, the current one first. */
export async function taxYears(db) {
  const [rows] = await db.query("SELECT DISTINCT tax_year FROM hrms_tax_rules WHERE deleted_at IS NULL AND status = 'PUBLISHED' AND rule_key = 'slabs' ORDER BY tax_year DESC");
  return rows.map((r) => r.tax_year);
}
