/**
 * duty.js — Sunday and festival duty of one day (TM/CF_HRMS_HIRING_SPEC.md §42.4). PURE, no imports:
 * month.js (the month summary), leave/requestService.js (comp-off into the balance) and reads.js (the
 * day's mark) all read it, so none of them imports another for it.
 */
const r2 = (n) => Math.round(Number(n) * 100) / 100;
const day = (v) => (v == null ? null : (v instanceof Date ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}` : String(v).slice(0, 10)));

/* ── Sunday and festival duty (spec §42.4) ──────────────────────────────────
 * A WEEKLY_OFF or HOLIDAY day with hours worked, under its policy's weeklyOffDuty / holidayDuty
 * (policy.js), counts when the hours reach the rule's minHours. It gives:
 *   amount     PER_DAY / FIXED: the rule's ₹; PER_HOUR: ₹ × hours (to the paisa)
 *   wageDays   DAY_WAGE: the multiple — payroll pays it at the day's wage ((BASIC + DA) ÷ 26 by default)
 *   compOff    the rule's comp-off days (leave/balance.js credits them to an EARNED_BY_WORK leave type)
 * Unless the rule says alsoOvertime, the day's overtime minutes are NOT also counted as overtime.
 */
export const emptyDuty = () => ({
  sunday: { days: 0, hours: 0, amount: 0 },
  festival: { days: 0, hours: 0, amount: 0, wageDays: 0 },
  compOffDays: 0,
  days: [],
});

/** One day's duty, or null. `r`: a record row (status, worked_minutes, attendance_date); `rules`: its policy's rules. */
export function dutyOfDay(r, rules) {
  const worked = Number(r.worked_minutes ?? r.workedMinutes) || 0;
  if (worked <= 0 || !rules) return null;
  const kind = r.status === 'WEEKLY_OFF' ? 'SUNDAY' : (r.status === 'HOLIDAY' ? 'FESTIVAL' : null);
  const rule = kind === 'SUNDAY' ? rules.weeklyOffDuty : (kind === 'FESTIVAL' ? rules.holidayDuty : null);
  if (!rule) return null;
  const hours = r2(worked / 60);
  if (rule.minHours && hours < Number(rule.minHours)) return null;
  let amount = 0;
  let wageDays = 0;
  if (rule.pay === 'PER_DAY' || rule.pay === 'FIXED') amount = Number(rule.amount) || 0;
  else if (rule.pay === 'PER_HOUR') amount = (Number(rule.amount) || 0) * hours;
  else if (rule.pay === 'DAY_WAGE') wageDays = Number(rule.wageMultiple) || 0;
  return { date: day(r.attendance_date ?? r.date), kind, hours, amount: r2(amount), wageDays, compOff: Number(rule.compOffDays) || 0, alsoOvertime: Boolean(rule.alsoOvertime) };
}

export function addDuty(duty, d) {
  const k = d.kind === 'SUNDAY' ? duty.sunday : duty.festival;
  k.days += 1;
  k.hours = r2(k.hours + d.hours);
  k.amount = r2(k.amount + d.amount);
  if (d.kind === 'FESTIVAL') k.wageDays = r2(k.wageDays + d.wageDays);
  duty.compOffDays = r2(duty.compOffDays + d.compOff);
  duty.days.push({ date: d.date, kind: d.kind, hours: d.hours, amount: d.amount, wageDays: d.wageDays, compOff: d.compOff });
}

export default { emptyDuty, dutyOfDay, addDuty };
