/**
 * pin.js — which law versions a calculation uses (spec §36.1 "every payroll run stores the rule
 * versions it used").
 *
 * A calculation runs inside a law context (AsyncLocalStorage, so nothing has to be passed through
 * the payroll code): every law rule and tax rule it reads is noted in `used`. A reproduction runs
 * with `pins` — the ids a run stored — and then the readers return exactly those versions instead
 * of what is PUBLISHED today.
 *
 *   withLawContext(pins | null, fn, { legacy? })   runs fn(store) in a fresh context
 *   currentLaw()                      the context, or null outside one
 *   noteLaw(ids) / noteTax(ids)       what a reader returned
 *   usedOf(store)                     { law: [ids], tax: [ids] } sorted
 */
import { AsyncLocalStorage } from 'async_hooks';

const als = new AsyncLocalStorage();

export function withLawContext(pins, fn, { legacy = false } = {}) {
  const store = {
    // legacy: read PF/ESI/PT/LWF from the OLD per-company table instead (law_test runs a month both ways — the proof that the move kept every amount).
    legacy: Boolean(legacy),
    pins: pins ? { law: new Set((pins.law ?? []).map(Number)), tax: new Set((pins.tax ?? []).map(Number)) } : null,
    used: { law: new Set(), tax: new Set() },
  };
  return als.run(store, () => fn(store));
}

export const currentLaw = () => als.getStore() ?? null;

export function noteLaw(ids) {
  const s = als.getStore();
  if (s) for (const id of ids) if (id != null) s.used.law.add(Number(id));
}
export function noteTax(ids) {
  const s = als.getStore();
  if (s) for (const id of ids) if (id != null) s.used.tax.add(Number(id));
}

export const usedOf = (store) => ({
  law: [...(store?.used.law ?? [])].sort((a, b) => a - b),
  tax: [...(store?.used.tax ?? [])].sort((a, b) => a - b),
});

export default { withLawContext, currentLaw, noteLaw, noteTax, usedOf };
