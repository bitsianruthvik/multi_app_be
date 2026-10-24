/**
 * statutory.js (law) — PF, ESI, PT and LWF in force on a day for a state, from the law layer, in the
 * shape services/payroll/statutory.js has always been handed:
 *   { PF, ESI, PT, LWF }   each the settings object + meta { id, effectiveFrom, stateCode, verification, version }
 * PF and ESI are national (jurisdiction IN); PT and LWF are the state's. A kind with no rule is null.
 *
 * The rows are hrms_law_rules with rule_key 'settings' (migrate-statutory-to-law.mjs moved them from
 * the per-company hrms_pay_statutory_settings, values unchanged). In a reproduction the pinned
 * versions are read instead (pin.js).
 */
import { lawInForce } from './store.js';

export async function statutoryFromLaw(db, on, stateCode) {
  const state = String(stateCode || 'TG').toUpperCase();
  const rows = await lawInForce(db, { domains: ['PF', 'ESI', 'PT', 'LWF'], jurisdictions: [...new Set(['IN', state])], on });
  const out = {};
  for (const [kind, j] of [['PF', 'IN'], ['ESI', 'IN'], ['PT', state], ['LWF', state]]) {
    const r = rows.find((x) => x.domain === kind && x.jurisdiction === j && x.ruleKey === 'settings') ?? null;
    out[kind] = r ? { ...r.value, meta: { id: r.id, effectiveFrom: r.effectiveFrom, stateCode: r.jurisdiction, verification: r.verified ? 'VERIFIED' : 'UNVERIFIED', version: r.version } } : null;
  }
  return out;
}

export default { statutoryFromLaw };
