/**
 * leavePolicyTemplates.js — the ready-made starting points for a leave policy.
 * (TM/CF_HRMS_HIRING_SPEC.md §8.2.) DATA ONLY: one file, nothing computed.
 *
 * THESE ARE STARTING POINTS, NOT ADVICE. What the law requires differs by state
 * and by the kind of establishment, and a company's own standing orders may say
 * more. Every answer that carries these carries TEMPLATE_NOTE with them, and the
 * screen shows it.
 *
 * A template names leave types by CODE. Creating a policy from one creates the
 * leave types the company does not have yet (LEAVE_TYPES_OFFERED), and nothing
 * else: no policy, no assignment exists until somebody makes it.
 *
 * A rule here lists only what differs from a plain rule (leavePolicyRead.js
 * RULE_DEFAULTS): 7 days a year given upfront that lapse is { days: 7 }.
 */

export const TEMPLATE_NOTE = 'These are starting points. Check them against your state’s rules and your standing orders before you use them — they are not legal advice.';

/** The leave types a template may need, created on demand, by code. */
export const LEAVE_TYPES_OFFERED = [
  { code: 'CL', name: 'Casual leave', isPaid: true },
  { code: 'SL', name: 'Sick leave', isPaid: true },
  { code: 'EL', name: 'Earned leave', isPaid: true },
  { code: 'ML', name: 'Maternity leave', isPaid: true },
  { code: 'PL', name: 'Paternity leave', isPaid: true },
  { code: 'CO', name: 'Compensatory off', isPaid: true },
  { code: 'BL', name: 'Bereavement leave', isPaid: true },
  { code: 'MRL', name: 'Marriage leave', isPaid: true },
  { code: 'LWP', name: 'Leave without pay', isPaid: false },
];

const bereavement = { type: 'BL', basis: 'PER_EVENT', days: 3, accrual: 'ON_REQUEST' };
const withoutPay = { type: 'LWP', basis: 'UNLIMITED_UNPAID', accrual: 'ON_REQUEST' };
const maternity = { type: 'ML', basis: 'PER_EVENT', days: 182, accrual: 'ON_REQUEST', appliesTo: 'WOMEN' };
const paternity = { type: 'PL', basis: 'PER_EVENT', days: 5, accrual: 'ON_REQUEST', appliesTo: 'MEN' };
const marriage = { type: 'MRL', basis: 'PER_EVENT', days: 5, accrual: 'ON_REQUEST', maxTimesInService: 1 };

/** Office staff, with the earned leave the template varies. */
const office = (earnedDays, carryCap) => [
  { type: 'CL', days: 12, accrual: 'MONTHLY', halfDayAllowed: true },
  { type: 'SL', days: 12, accrual: 'MONTHLY', proofAfterDays: 2 },
  { type: 'EL', days: earnedDays, accrual: 'MONTHLY', allowedInProbation: false, carryForward: 'CAPPED', carryForwardCapDays: carryCap, encashable: true },
  maternity, paternity, bereavement, marriage, withoutPay,
];

export const TEMPLATES = [
  {
    key: 'SHOP_FLOOR',
    name: 'Shop floor',
    description: 'Earned leave by days worked, a week each of casual and sick leave, compensatory off for working a holiday.',
    rules: [
      { type: 'EL', accrual: 'PER_DAYS_WORKED', daysWorkedPerLeaveDay: 20, carryForward: 'CAPPED', carryForwardCapDays: 30, encashable: true },
      { type: 'CL', days: 7 },
      { type: 'SL', days: 7, proofAfterDays: 2 },
      { type: 'CO', accrual: 'EARNED_BY_WORK', expiresAfterDays: 60 },
      bereavement, withoutPay,
    ],
  },
  {
    key: 'OFFICE_STAFF',
    name: 'Office staff',
    description: 'Twelve casual and twelve sick days earned monthly, fifteen earned-leave days that carry forward, maternity, paternity and marriage leave.',
    rules: office(15, 45),
  },
  {
    key: 'MANAGEMENT',
    name: 'Management',
    description: 'As office staff, with twenty-one earned-leave days and a larger carry forward.',
    rules: office(21, 60),
  },
  {
    key: 'TRAINEE',
    name: 'Trainee / probationer',
    description: 'Six casual and six sick days a year, and leave without pay.',
    rules: [
      { type: 'CL', days: 6, accrual: 'MONTHLY' },
      { type: 'SL', days: 6 },
      withoutPay,
    ],
  },
  { key: 'BLANK', name: 'Blank', description: 'No leave types yet. Add your own.', rules: [] },
];

export default { TEMPLATE_NOTE, LEAVE_TYPES_OFFERED, TEMPLATES };
