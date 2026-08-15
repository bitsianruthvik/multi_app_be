/**
 * assetService.js — what a machine is worth today.
 *
 * DEPRECIATION IS COMPUTED, NEVER STORED. It is a pure function of cost,
 * salvage, method, life and elapsed time, so a stored `accumulated_depreciation`
 * column is wrong the day after it is written and can disagree with the four
 * inputs sitting on the same row. Nobody would know which to believe. The one
 * legitimate reason to store it — a posted figure that accounting has closed a
 * period on — is a ledger entry, not an attribute of the machine, and this
 * system has no such ledger.
 *
 * WHERE THE CLOCK STARTS. `commissioned_date` if set, else `purchase_date`.
 * A machine bought in March and commissioned in June did not lose value sitting
 * in a crate, and every convention starts depreciation when the asset is put to
 * use. Falling back to purchase date means the common case — nobody recorded a
 * commissioning date — still produces a number rather than nothing.
 */

export const DEPRECIATION_METHODS = ['straight_line', 'wdv', 'none'];

const MS_PER_DAY = 86_400_000;
const DAYS_PER_YEAR = 365.25;

const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const asDate = (v) => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * Years elapsed since the asset started depreciating, as of `asOf`.
 * Negative (a future purchase date) clamps to zero — an asset cannot have
 * depreciated before it existed, and a typo in a date should not produce a
 * book value above cost.
 */
export function ageYears(resource, asOf = new Date()) {
  const start = asDate(resource?.commissioned_date ?? resource?.commissionedDate)
    ?? asDate(resource?.purchase_date ?? resource?.purchaseDate);
  if (!start) return null;
  const end = asDate(asOf) ?? new Date();
  return Math.max(0, (end.getTime() - start.getTime()) / MS_PER_DAY / DAYS_PER_YEAR);
}

/**
 * Book value and accumulated depreciation for one machine.
 *
 * Returns `{ applicable: false }` rather than zeros when the inputs are not
 * there: "we have not recorded what this cost" and "this machine is fully
 * depreciated" are opposite facts, and a screen that renders 0 for both is
 * lying about the first.
 *
 * @param {object} r  a fab_resources row (snake_case or camelCase)
 * @param {Date}   asOf
 */
export function depreciationFor(r, asOf = new Date()) {
  const cost = num(r?.asset_cost ?? r?.assetCost);
  const method = String(r?.depreciation_method ?? r?.depreciationMethod ?? '').trim() || null;
  const years = ageYears(r, asOf);

  if (cost == null || cost <= 0 || !method || method === 'none' || years == null) {
    return {
      applicable: false,
      reason: cost == null || cost <= 0 ? 'no asset cost recorded'
        : !method || method === 'none' ? 'no depreciation method set'
        : 'no purchase or commissioning date',
      cost, method, ageYears: years,
      accumulated: null, bookValue: null, annualCharge: null,
    };
  }

  const salvage = Math.max(0, num(r?.salvage_value ?? r?.salvageValue) ?? 0);
  let accumulated = 0;
  let annualCharge = null;

  if (method === 'straight_line') {
    const life = num(r?.useful_life_years ?? r?.usefulLifeYears);
    if (life == null || life <= 0) {
      return {
        applicable: false, reason: 'straight line needs a useful life in years',
        cost, method, ageYears: years,
        accumulated: null, bookValue: null, annualCharge: null,
      };
    }
    annualCharge = (cost - salvage) / life;
    // Never below salvage: an asset held past its useful life is worth its
    // residual, not a negative number.
    accumulated = Math.min(cost - salvage, annualCharge * years);
  } else if (method === 'wdv') {
    const rate = num(r?.depreciation_rate_pct ?? r?.depreciationRatePct);
    if (rate == null || rate <= 0 || rate >= 100) {
      return {
        applicable: false, reason: 'reducing balance needs a rate between 0 and 100%',
        cost, method, ageYears: years,
        accumulated: null, bookValue: null, annualCharge: null,
      };
    }
    // Reducing balance: value decays by `rate` of the REMAINING value each
    // year, so it approaches salvage asymptotically rather than by a fixed
    // amount. Fractional years are handled by the exponent, not by prorating a
    // year's charge, which is what makes it continuous across a part year.
    const remaining = (cost - salvage) * ((1 - rate / 100) ** years);
    accumulated = (cost - salvage) - remaining;
    annualCharge = (cost - salvage - accumulated) * (rate / 100);
  } else {
    return {
      applicable: false, reason: `unknown depreciation method "${method}"`,
      cost, method, ageYears: years,
      accumulated: null, bookValue: null, annualCharge: null,
    };
  }

  const round2 = (n) => Math.round(n * 100) / 100;
  return {
    applicable: true,
    reason: null,
    cost,
    method,
    salvage,
    ageYears: round2(years),
    accumulated: round2(accumulated),
    bookValue: round2(cost - accumulated),
    /** Charge for the NEXT year at the current book value. */
    annualCharge: round2(annualCharge),
  };
}

/** The same, for a list — used by the machine list so it costs no extra query. */
export function depreciationForAll(resources, asOf = new Date()) {
  const out = new Map();
  for (const r of resources || []) out.set(Number(r.id), depreciationFor(r, asOf));
  return out;
}
