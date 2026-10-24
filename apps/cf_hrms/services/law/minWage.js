/**
 * minWage.js — minimum wages by state × scheduled employment × zone × skill (spec §36.1).
 *
 * A MIN_WAGE rule (hrms_law_rules, domain MIN_WAGE, jurisdiction = the state) holds one
 * notification: rule_key = the employment key, or ALL_EMPLOYMENTS where the state fixes one set of
 * rates for every employment (Telangana since G.O.Ms.No.6 of 30-05-2026). Its value:
 *   {
 *     unit: 'MONTH', dailyDivisor: 26,
 *     employments: [{ key, name, schedule }],     the scheduled employments it covers (pickers)
 *     zones: { I: 'Municipal corporations', … },
 *     rates: [{ zone, skill, basic, vda }],        vda null while not notified
 *     vda: { basePoint, perPoint, series, revised, current }   how the VDA moves (words and numbers)
 *   }
 * A VDA revision is a new version of the rule from its date (effective_from).
 *
 *   minimumWageFrom(value, { zone, skill })            pure
 *   minimumWageOn(db, { state, employment, zone, skill, on })   reads the rule in force
 *   employmentsOf(db, state, on)                       [{ key, name, schedule, ruleKey }] for pickers
 */
import { lawInForce } from './store.js';

const money = (v) => Math.round((Number(v) || 0) * 100) / 100;

export function minimumWageFrom(value, { zone, skill }) {
  const z = String(zone ?? '').trim().toUpperCase();
  const s = String(skill ?? '').trim().toUpperCase();
  const r = (value?.rates ?? []).find((x) => String(x.zone).toUpperCase() === z && String(x.skill).toUpperCase() === s);
  if (!r) return null;
  const basic = money(r.basic);
  const vda = r.vda == null ? null : money(r.vda);
  return { zone: z, skill: s, basic, vda, total: money(basic + (vda ?? 0)), vdaPending: vda == null, unit: value?.unit ?? 'MONTH', daily: money((basic + (vda ?? 0)) / (Number(value?.dailyDivisor) || 26)) };
}

/** The MIN_WAGE rule of a state for an employment on a day: its own notification, else the one for all. */
async function ruleFor(db, state, employment, on) {
  const rules = await lawInForce(db, { domains: ['MIN_WAGE'], jurisdictions: [String(state).toUpperCase()], on });
  const key = employment ? String(employment).toUpperCase() : null;
  return rules.find((r) => key && r.ruleKey.toUpperCase() === key)
    ?? rules.find((r) => key && (r.value?.employments ?? []).some((e) => String(e.key).toUpperCase() === key))
    ?? rules.find((r) => r.ruleKey === 'ALL_EMPLOYMENTS')
    ?? null;
}

/**
 * The minimum wage that applies, with the rule it came from (or the reason there is none).
 * @returns {{ found, reason?, wage?, rule? }}
 */
export async function minimumWageOn(db, { state, employment = null, zone, skill, on }) {
  if (!state) return { found: false, reason: 'The person’s state is not known.' };
  if (!zone) return { found: false, reason: 'The location has no minimum-wage zone.' };
  if (!skill) return { found: false, reason: 'The role has no skill category.' };
  const rule = await ruleFor(db, state, employment, on);
  if (!rule) return { found: false, reason: `No minimum-wage notification for ${state} on ${on} in the law layer.` };
  const wage = minimumWageFrom(rule.value, { zone, skill });
  if (!wage) return { found: false, reason: `The ${state} notification has no rate for zone ${zone}, ${skill.toLowerCase().replace('_', '-')}.`, rule };
  return { found: true, wage, rule: { id: rule.id, ruleKey: rule.ruleKey, title: rule.title, effectiveFrom: rule.effectiveFrom, version: rule.version, sourceUrl: rule.sourceUrl, verified: rule.verified } };
}

/** The scheduled employments a state's notifications name (for the role's picker). */
export async function employmentsOf(db, state, on) {
  const rules = await lawInForce(db, { domains: ['MIN_WAGE'], jurisdictions: [String(state).toUpperCase()], on });
  const out = [];
  for (const r of rules) {
    out.push({ key: r.ruleKey, name: r.title ?? r.ruleKey, schedule: null, ruleKey: r.ruleKey });
    for (const e of r.value?.employments ?? []) out.push({ key: e.key, name: e.name, schedule: e.schedule ?? null, ruleKey: r.ruleKey });
  }
  return { employments: out, zones: Object.entries(rules[0]?.value?.zones ?? {}).map(([code, name]) => ({ code, name })) };
}

export default { minimumWageFrom, minimumWageOn, employmentsOf };
