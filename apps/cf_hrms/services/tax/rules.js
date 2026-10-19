/**
 * rules.js — the rules of one tax year and regime, as the engine reads them.
 *
 *   loadTaxRules(db, year, regime)   reads hrms_tax_rules (the only DB access of services/tax)
 *   rulesFromRows(rows, year, regime) the same from plain rows (tests, the seed)
 *   rulesFromSeed(year, regime)       straight from ruleData.js (tests, before the table is seeded)
 *
 * A rules object: { year, regime, get(key), source(key), has(key), unverified[] }.
 * `get` throws a plain error when a rule is missing — the engine never falls back to a
 * number of its own.
 */
import { TAX_RULE_ROWS } from './ruleData.js';

export const REGIMES = ['OLD', 'NEW'];
export const AGE_BANDS = ['BELOW_60', 'AGE_60_TO_80', 'AGE_80_PLUS'];

const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);

export function rulesFromRows(rows, year, regime) {
  const R = String(regime || '').toUpperCase();
  const map = new Map();
  for (const r of rows) {
    if (r.tax_year !== year || String(r.regime).toUpperCase() !== R) continue;
    map.set(r.rule_key, {
      value: parse(r.value ?? r.value_json),
      sourceNote: r.source_note ?? '',
      sourceUrl: r.source_url ?? '',
      verified: Number(r.verified) === 1,
    });
  }
  if (!map.size) throw new Error(`No tax rules for ${year} (${R} regime). Seed them with apps/cf_hrms/scripts/seed-tax-rules.mjs.`);
  return {
    year,
    regime: R,
    has: (key) => map.has(key),
    get(key) {
      const row = map.get(key);
      if (!row) throw new Error(`The tax rule "${key}" is missing for ${year} (${R} regime).`);
      return row.value;
    },
    source(key) {
      const row = map.get(key);
      return row ? { note: row.sourceNote, url: row.sourceUrl, verified: row.verified } : { note: '', url: '', verified: false };
    },
    unverified: [...map.entries()].filter(([, r]) => !r.verified).map(([k]) => k).sort(), // sorted: the DB and the seed list rows in different orders
  };
}

export const rulesFromSeed = (year, regime) => rulesFromRows(TAX_RULE_ROWS, year, regime);

/** Reads one year and regime from hrms_tax_rules. `db` is a mysql2 pool or connection. */
export async function loadTaxRules(db, year, regime) {
  const [rows] = await db.query(
    `SELECT tax_year, regime, rule_key, value_json, source_note, source_url, verified
       FROM hrms_tax_rules WHERE tax_year = ? AND regime = ? AND deleted_at IS NULL`,
    [year, String(regime).toUpperCase()],
  );
  return rulesFromRows(rows, year, regime);
}

/** Both regimes of a year: { OLD, NEW }. */
export async function loadTaxYear(db, year) {
  return { OLD: await loadTaxRules(db, year, 'OLD'), NEW: await loadTaxRules(db, year, 'NEW') };
}

/** '2025-26' → { start: '2025-04-01', end: '2026-03-31', startYear: 2025, endYear: 2026 }. */
export function yearBounds(year) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(year));
  if (!m) throw new Error(`A tax year is written like 2025-26 (got "${year}").`);
  const startYear = Number(m[1]);
  if ((startYear + 1) % 100 !== Number(m[2])) throw new Error(`"${year}" is not a tax year (the second part must be the next year).`);
  return { start: `${startYear}-04-01`, end: `${startYear + 1}-03-31`, startYear, endYear: startYear + 1 };
}

/**
 * The age band for the old-regime slabs. The law counts the age "at any time during the
 * year", and a person attains an age on the day before the birthday, so someone born on
 * 1 April 1966 is 60 on 31 March 2026 — a senior for 2025-26. The CBDT validation rules
 * for AY 2026-27 use exactly that date ("date of birth on or before 01.04.1966").
 * Takes { ageBand } as given, or { dateOfBirth: 'YYYY-MM-DD' }, or { age } (age at the
 * year end, a plain fallback).
 */
export function ageBandFor({ ageBand, dateOfBirth, age } = {}, year) {
  if (ageBand) {
    const b = String(ageBand).toUpperCase();
    if (!AGE_BANDS.includes(b)) throw new Error(`Age band "${ageBand}" is not one of ${AGE_BANDS.join(', ')}.`);
    return b;
  }
  if (dateOfBirth) {
    const { endYear } = yearBounds(year);
    const dob = String(dateOfBirth).slice(0, 10);
    if (dob <= `${endYear - 80}-04-01`) return 'AGE_80_PLUS';
    if (dob <= `${endYear - 60}-04-01`) return 'AGE_60_TO_80';
    return 'BELOW_60';
  }
  if (age != null) return age >= 80 ? 'AGE_80_PLUS' : age >= 60 ? 'AGE_60_TO_80' : 'BELOW_60';
  return 'BELOW_60';
}

const CITY_ALIASES = {
  bombay: 'mumbai', 'navi mumbai': null, calcutta: 'kolkata', madras: 'chennai', 'new delhi': 'delhi',
  bangalore: 'bengaluru', 'bengaluru urban': 'bengaluru', poona: 'pune', secunderabad: null,
};
/** Is `city` one of the rule's 50% cities? Exact names (with the old names), nothing guessed. */
export function isMetro(city, metros) {
  if (!city) return false;
  let c = String(city).trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(CITY_ALIASES, c)) { if (CITY_ALIASES[c] === null) return false; c = CITY_ALIASES[c]; }
  return metros.some((m) => m.toLowerCase() === c);
}
