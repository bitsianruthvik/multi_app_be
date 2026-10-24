/**
 * constants.js — what the compliance checks name (no database, no imports): the check keys, the
 * statutory top-up component, the remedy keys. Read by the schema script too.
 */

/** Every check the module runs, and what it is called on a screen. */
export const CHECKS = {
  MIN_WAGE: 'Minimum wage',
  MIN_WAGE_BASIC: 'Minimum wage on basic + DA alone',
  MIN_WAGE_UNKNOWN: 'Minimum wage cannot be checked',
  WAGES_50: 'Labour Code wages under 50%',
  PF_LEFT_OUT: 'PF left out',
  STATUTORY_MISSING: 'A statutory deduction left out',
  OT_RATE: 'Overtime rate below the legal rate',
  OT_RATE_BASE: 'Overtime hourly rate below wages',
  OT_HOURS: 'Overtime hours above the limit',
  LEAVE_MIN: 'Leave below the minimum',
  ALLOWANCE_SHARE: 'Allowance outside its usual share',
};

/** Checks about the structure itself (any CTC): one acknowledgement on the structure covers its salaries. */
export const STRUCTURE_CHECKS = new Set(['WAGES_50', 'ALLOWANCE_SHARE']);

/**
 * The ready-made component that pays a statutory top-up (spec §36.3): past a minimum-wage to-do's
 * deadline, each run adds the shortfall as this line until HR decides. Counts as wages (PF, ESI,
 * gratuity) — it stands in for the basic pay that is short. Paid as a one-time item by the run.
 */
export const TOPUP_COMPONENT = {
  code: 'STAT_TOPUP', name: 'Statutory top-up (minimum wage)', kind: 'EARNING', taxable: 'YES', exemptionRule: null,
  inPfWage: 1, inEsiWage: 1, inGratuityWage: 1, frequency: 'MONTHLY', prorateOnLop: 0, statutoryKey: null, sortOrder: 15,
  description: 'Paid by the run while a minimum-wage compliance to-do is past its deadline and not yet fixed: the shortfall to the legal minimum for the days paid. Stops when the fix is applied.',
};

/** Components counted as WAGES (Code on Wages s.2(y): basic pay, dearness allowance, retaining allowance). */
export const WAGE_CODES = new Set(['BASIC', 'DA', 'VDA', 'RETAINING', 'RETAINING_ALLOWANCE', 'STAT_TOPUP']);
/** Earnings that are termination / retirement benefits (s.2(y)(j), (k)): not counted in the 50% test. */
export const NOT_COUNTED_EARNINGS = new Set(['GRATUITY', 'LEAVE_ENC', 'NOTICE_PAY', 'RETRENCHMENT']);
/** Employer contributions counted in total remuneration (MoLE FAQs 16-03-2026: employer PF / pension). */
export const COUNTED_EMPLOYER = new Set(['PF_ER', 'NPS_ER']);

export const REMEDIES = {
  RESPLIT: 'Re-split within the CTC',
  RAISE_CTC: 'Raise the CTC',
  ADD_STATUTORY: 'Add the missing statutory line',
};

export const TODO_OPEN = ['OPEN', 'CHOSEN'];

export default { CHECKS, STRUCTURE_CHECKS, TOPUP_COMPONENT, WAGE_CODES, NOT_COUNTED_EARNINGS, COUNTED_EMPLOYER, REMEDIES, TODO_OPEN };
