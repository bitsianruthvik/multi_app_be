/**
 * settingsService.js — a company's performance settings and each role's
 * frequency. (TM/CF_HRMS_HIRING_SPEC.md §18.1, §18.3 Setup › Performance settings.)
 *
 *   year start month   1..12 (India: 4, April)
 *   default frequency  for a role that has none (QUARTERLY)
 *   rating scale       an ordered list of labels, low to high (used in step 6, stored now)
 *   bands              the achievement a plan or KPI needs to be "on track" (90) and
 *                      "at risk" (70); below that it is "behind" (spec §19.1)
 *   role frequency     hrms_roles.performance_frequency, NULL = the default
 *
 * A company with no row reads the defaults; the first save writes the row.
 * The year start cannot move once periods exist: a period is computed from it,
 * and a moved start would make new periods overlap the old ones.
 */
import { invalid, conflict, notFound } from '../../lib/errors.js';
import { audit } from '../peopleService.js';
import { FREQUENCIES, FREQUENCY_LABEL, isFrequency } from './periods.js';
import { DEFAULT_BANDS, BAND_WORDS } from './scoring.js';

export const DEFAULT_SCALE = [
  { value: 1, label: 'Needs improvement' },
  { value: 2, label: 'Partly meets expectations' },
  { value: 3, label: 'Meets expectations' },
  { value: 4, label: 'Exceeds expectations' },
  { value: 5, label: 'Outstanding' },
];
export const DEFAULTS = Object.freeze({ yearStartMonth: 4, defaultFrequency: 'QUARTERLY', ratingScale: DEFAULT_SCALE, bands: DEFAULT_BANDS });
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const readJson = (v) => { if (v == null || typeof v === 'object') return v ?? null; try { return JSON.parse(v); } catch { return null; } };

/** The settings of a company: its row, or the defaults. One query. */
export async function readSettings(db, companyId) {
  const [[row]] = await db.query('SELECT * FROM hrms_performance_settings WHERE company_id = ?', [companyId]);
  const scale = readJson(row?.rating_scale);
  return {
    saved: Boolean(row),
    yearStartMonth: Number(row?.year_start_month ?? DEFAULTS.yearStartMonth),
    defaultFrequency: row?.default_frequency ?? DEFAULTS.defaultFrequency,
    ratingScale: Array.isArray(scale) && scale.length ? scale : DEFAULT_SCALE,
    // A database before apply-actuals-schema.mjs has no band columns: the defaults.
    bands: {
      onTrack: row?.band_on_track != null ? Number(row.band_on_track) : DEFAULT_BANDS.onTrack,
      atRisk: row?.band_at_risk != null ? Number(row.band_at_risk) : DEFAULT_BANDS.atRisk,
    },
  };
}

/** The scale as sent: a list of labels (strings or { label }), low to high. Values are 1..n in that order. */
function readScale(input, problems) {
  if (!Array.isArray(input)) { problems.push('Send the rating scale as a list of labels, lowest first.'); return null; }
  const labels = input.map((x) => String(typeof x === 'object' && x ? x.label ?? '' : x ?? '').trim()).filter(Boolean);
  if (labels.length < 2) problems.push('A rating scale needs at least two steps.');
  if (labels.length > 10) problems.push('A rating scale has at most ten steps.');
  if (labels.some((l) => l.length > 60)) problems.push('Keep each step of the rating scale under 60 characters.');
  const seen = new Set();
  for (const l of labels) { const k = l.toLowerCase(); if (seen.has(k)) problems.push(`"${l}" is in the rating scale twice.`); seen.add(k); }
  return labels.map((label, i) => ({ value: i + 1, label }));
}

/** PUT /performance/settings { yearStartMonth?, defaultFrequency?, ratingScale?, bands?: { onTrack, atRisk } } */
export async function saveSettings(db, c, input = {}) {
  const before = await readSettings(db, c.companyId);
  const problems = [];
  const next = { ...before };
  if (input.yearStartMonth !== undefined) {
    const m = Number(input.yearStartMonth);
    if (!Number.isInteger(m) || m < 1 || m > 12) problems.push('The year starts in a month: choose one from January to December.');
    else next.yearStartMonth = m;
  }
  if (input.defaultFrequency !== undefined) {
    const f = String(input.defaultFrequency ?? '').toUpperCase();
    if (!isFrequency(f)) problems.push(`The default frequency must be one of: ${FREQUENCIES.map((x) => FREQUENCY_LABEL[x].toLowerCase()).join(', ')}.`);
    else next.defaultFrequency = f;
  }
  if (input.ratingScale !== undefined) next.ratingScale = readScale(input.ratingScale, problems) ?? before.ratingScale;
  if (input.bands !== undefined) {
    const b = input.bands ?? {};
    const onTrack = b.onTrack === undefined ? before.bands.onTrack : Number(b.onTrack);
    const atRisk = b.atRisk === undefined ? before.bands.atRisk : Number(b.atRisk);
    if (![onTrack, atRisk].every((n) => Number.isFinite(n) && n > 0 && n <= 120)) problems.push('A band starts at a percentage above 0 and up to 120.');
    else if (!(atRisk < onTrack)) problems.push(`"${BAND_WORDS.AT_RISK}" must start below "${BAND_WORDS.ON_TRACK}".`);
    else next.bands = { onTrack: Math.round(onTrack * 100) / 100, atRisk: Math.round(atRisk * 100) / 100 };
  }
  if (problems.length) throw invalid('INVALID', problems[0], { problems });

  if (next.yearStartMonth !== before.yearStartMonth) {
    const [[p]] = await db.query('SELECT COUNT(*) AS n FROM hrms_performance_periods WHERE company_id = ?', [c.companyId]);
    if (Number(p.n) > 0) {
      throw conflict('PERIODS_EXIST', `Periods have already been made from a year that starts in ${MONTH_NAMES[before.yearStartMonth - 1]}. Moving the start now would make new periods overlap them, so it stays.`);
    }
  }
  await db.query(
    `INSERT INTO hrms_performance_settings (company_id, year_start_month, default_frequency, rating_scale, created_by, updated_by)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE year_start_month = VALUES(year_start_month), default_frequency = VALUES(default_frequency),
                             rating_scale = VALUES(rating_scale), updated_by = VALUES(updated_by)`,
    [c.companyId, next.yearStartMonth, next.defaultFrequency, JSON.stringify(next.ratingScale), c.userId, c.userId],
  );
  // The bands only when they change: a database before apply-actuals-schema.mjs has no such columns.
  if (next.bands.onTrack !== before.bands.onTrack || next.bands.atRisk !== before.bands.atRisk) {
    await db.query('UPDATE hrms_performance_settings SET band_on_track = ?, band_at_risk = ? WHERE company_id = ?', [next.bands.onTrack, next.bands.atRisk, c.companyId]);
  }
  const { saved, ...was } = before;
  await audit(db, c, 'hrms_performance_settings', c.companyId, before.saved ? 'UPDATE' : 'CREATE', was, {
    yearStartMonth: next.yearStartMonth, defaultFrequency: next.defaultFrequency, ratingScale: next.ratingScale, bands: next.bands,
  });
  return getSettingsPage(db, c.companyId);
}

/**
 * GET /performance/settings — the settings and the table of roles with their
 * frequency. Two queries.
 */
export async function getSettingsPage(db, companyId) {
  const [settings, [roles]] = await Promise.all([
    readSettings(db, companyId),
    db.query(
      `SELECT r.id, r.role_code, r.title, r.status, r.performance_frequency,
              (SELECT COUNT(*) FROM hrms_positions p WHERE p.company_id = r.company_id AND p.role_id = r.id AND p.deleted_at IS NULL AND p.status <> 'CLOSED') AS position_count
         FROM hrms_roles r
        WHERE r.company_id = ? AND r.deleted_at IS NULL
        ORDER BY r.title`,
      [companyId],
    ),
  ]);
  return {
    yearStartMonth: settings.yearStartMonth,
    yearStartMonthName: MONTH_NAMES[settings.yearStartMonth - 1],
    defaultFrequency: settings.defaultFrequency,
    ratingScale: settings.ratingScale,
    bands: settings.bands,
    bandWords: BAND_WORDS,
    saved: settings.saved,
    frequencies: FREQUENCIES.map((f) => ({ value: f, label: FREQUENCY_LABEL[f] })),
    roles: roles.map((r) => ({
      id: r.id,
      roleCode: r.role_code ?? null,
      title: r.title,
      status: r.status,
      positionCount: Number(r.position_count ?? 0),
      frequency: r.performance_frequency ?? null,
      effectiveFrequency: r.performance_frequency ?? settings.defaultFrequency,
    })),
  };
}

/** PUT /performance/role-frequencies { roleIds: number[], frequency: 'MONTHLY'… | null } — null = back to the default. */
export async function setRoleFrequencies(db, c, input = {}) {
  const ids = [...new Set((Array.isArray(input.roleIds) ? input.roleIds : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!ids.length) throw invalid('INVALID', 'Choose at least one role.', { problems: ['Choose at least one role.'] });
  const raw = input.frequency;
  const frequency = raw === null || raw === '' || raw === undefined ? null : String(raw).toUpperCase();
  if (frequency !== null && !isFrequency(frequency)) {
    throw invalid('INVALID', `Choose a frequency: ${FREQUENCIES.map((x) => FREQUENCY_LABEL[x].toLowerCase()).join(', ')}, or the company default.`);
  }
  const [rows] = await db.query('SELECT id, title, performance_frequency FROM hrms_roles WHERE company_id = ? AND id IN (?) AND deleted_at IS NULL', [c.companyId, ids]);
  if (rows.length !== ids.length) throw notFound('Role');
  const changing = rows.filter((r) => (r.performance_frequency ?? null) !== frequency);
  if (changing.length) {
    await db.query('UPDATE hrms_roles SET performance_frequency = ? WHERE company_id = ? AND id IN (?)', [frequency, c.companyId, changing.map((r) => r.id)]);
    await db.query(
      `INSERT INTO hrms_audit_log (company_id, actor_user_id, entity_type, entity_id, action, before_json, after_json, created_by) VALUES ${changing.map(() => '(?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
      changing.flatMap((r) => [c.companyId, c.userId, 'hrms_roles', r.id, 'UPDATE',
        JSON.stringify({ performanceFrequency: r.performance_frequency ?? null }), JSON.stringify({ performanceFrequency: frequency }), c.userId]),
    );
  }
  return { changed: changing.length, ...(await getSettingsPage(db, c.companyId)) };
}

export default { DEFAULTS, DEFAULT_SCALE, readSettings, saveSettings, getSettingsPage, setRoleFrequencies };
