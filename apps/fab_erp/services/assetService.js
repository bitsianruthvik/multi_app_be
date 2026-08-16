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

/**
 * The methods a manufacturer actually uses.
 *
 *   straight_line      equal charge per year. The default nearly everywhere.
 *   wdv                reducing balance at a rate somebody states. The Indian
 *                      Income Tax Act's written-down-value method.
 *   double_declining   reducing balance at 2/life, derived rather than stated.
 *   sum_of_years       accelerated by an arithmetic series — heavier early
 *                      charges than straight line, lighter than declining.
 *   units_of_production by USE, not by time: cycles, hours or tonnes.
 *   none               held at cost.
 *
 * `wdv` and `double_declining` are both reducing balance and differ in two ways
 * that matter: where the rate comes from, and what it applies to. WDV takes a
 * stated rate and decays (cost − salvage); DDB derives 2/life and decays the
 * FULL cost, ignoring salvage until book value reaches it. Offering only one
 * would force somebody to fake the other.
 */
export const DEPRECIATION_METHODS = [
  'straight_line', 'wdv', 'double_declining', 'sum_of_years', 'units_of_production', 'none',
];

const MS_PER_DAY = 86_400_000;
const DAYS_PER_YEAR = 365.25;

const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * A stored date, read in LOCAL time.
 *
 * `new Date('2021-08-17')` parses a date-only string as UTC midnight, while a
 * DATE column read through mysql2 comes back as a JS Date at LOCAL midnight.
 * Mixing the two makes an asset look a timezone-offset older or younger than it
 * is — 0.06% on a multi-year figure, immaterial to a book value but enough to
 * make it impossible to reconcile against a schedule computed by hand, and it
 * is the same trap that shifted maintenance due dates by a whole day.
 *
 * Both are read as the calendar day they name, in the shop's own time.
 */
const asDate = (v) => {
  if (!v) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  const s = String(v);
  const ymd = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (ymd) return new Date(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3]));
  const d = new Date(s);
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
  // Only units-of-production sets these; they are reported so a screen can say
  // "X per hour, 1200 of 10000 used" instead of a bare book value.
  let perUnit = null;
  let unitsUsed = null;
  let unitsTotal = null;

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
  } else if (method === 'double_declining') {
    const life = num(r?.useful_life_years ?? r?.usefulLifeYears);
    if (life == null || life <= 0) {
      return {
        applicable: false, reason: 'double declining needs a useful life in years',
        cost, method, ageYears: years,
        accumulated: null, bookValue: null, annualCharge: null,
      };
    }
    /**
     * Twice the straight-line rate, applied to the FULL cost — not to
     * (cost − salvage), which is what separates this from WDV above. Salvage
     * enters only as a floor.
     *
     * A pure declining balance never actually reaches salvage, which is why
     * real practice switches to straight line once that would charge more. The
     * floor is the honest simplification: it stops the asset depreciating past
     * its residual without pretending a switch happened, and the annual charge
     * goes to zero there rather than trickling forever.
     */
    const rate = Math.min(0.9999, 2 / life);
    const book = Math.max(salvage, cost * ((1 - rate) ** years));
    accumulated = cost - book;
    annualCharge = book > salvage ? book * rate : 0;
  } else if (method === 'sum_of_years') {
    const life = num(r?.useful_life_years ?? r?.usefulLifeYears);
    if (life == null || life <= 0) {
      return {
        applicable: false, reason: "sum of years' digits needs a useful life in years",
        cost, method, ageYears: years,
        accumulated: null, bookValue: null, annualCharge: null,
      };
    }
    /**
     * Year k of n charges (n−k+1)/(n(n+1)/2) of the depreciable amount: heavy
     * early, light late, and it lands exactly on salvage at the end — unlike
     * declining balance, which only approaches it.
     *
     * Whole years are summed and the part year is prorated within the year it
     * falls in, rather than integrating the series. Prorating is what the
     * charge actually is inside a period, and integrating would produce a
     * number no schedule anybody prints would agree with.
     */
    const n = life;
    const syd = (n * (n + 1)) / 2;
    const D = cost - salvage;
    const full = Math.min(Math.floor(years), Math.floor(n));
    let acc = 0;
    for (let k = 1; k <= full; k++) acc += D * ((n - k + 1) / syd);
    const partial = Math.min(years, n) - full;
    if (partial > 0) acc += partial * D * ((n - full) / syd);
    accumulated = Math.min(D, acc);
    const nextYear = Math.min(Math.floor(years) + 1, Math.ceil(n));
    annualCharge = accumulated >= D ? 0 : D * ((n - nextYear + 1) / syd);
  } else if (method === 'units_of_production') {
    const total = num(r?.useful_life_units ?? r?.usefulLifeUnits);
    const used = num(r?.units_used ?? r?.unitsUsed) ?? 0;
    if (total == null || total <= 0) {
      return {
        applicable: false,
        reason: 'units of production needs a total expected output (hours, cycles or tonnes)',
        cost, method, ageYears: years,
        accumulated: null, bookValue: null, annualCharge: null,
      };
    }
    /**
     * By USE, so elapsed time does not enter the arithmetic at all.
     *
     * A machine that has stood idle for three years has depreciated nothing
     * under this method, which is the point of choosing it — and is exactly why
     * it is wrong for anything that also deteriorates while standing.
     *
     * There is no meaningful "charge for next year" without knowing how hard it
     * will be worked, so `annualCharge` is null rather than a guess. A rate per
     * unit is the useful figure and is given instead.
     */
    const D = cost - salvage;
    accumulated = Math.min(D, D * (Math.max(0, used) / total));
    annualCharge = null;
    perUnit = D / total;
    unitsUsed = used;
    unitsTotal = total;
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
    perUnit: perUnit == null ? null : round2(perUnit),
    unitsUsed, unitsTotal,
    /**
     * Charge for the NEXT year at the current book value.
     *
     * NULL is preserved rather than rounded. `round2(null)` is 0, and a zero
     * here reads as "this machine will depreciate nothing next year" — which is
     * a claim. Units-of-production genuinely cannot answer without knowing how
     * hard the machine will be worked, and saying so is not the same as saying
     * nothing will happen.
     */
    annualCharge: annualCharge == null ? null : round2(annualCharge),
  };
}

/** The same, for a list — used by the machine list so it costs no extra query. */
export function depreciationForAll(resources, asOf = new Date()) {
  const out = new Map();
  for (const r of resources || []) out.set(Number(r.id), depreciationFor(r, asOf));
  return out;
}
