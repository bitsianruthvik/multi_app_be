/**
 * remedies.js — the standard fixes the product ships (TM/CF_HRMS_HIRING_SPEC.md §36.3, C2), as code:
 *
 *   RESPLIT        cost-neutral re-split within the CTC.
 *                    MIN_WAGE / MIN_WAGE_BASIC: per person, Basic is set (an override on the salary) so that
 *                    basic + DA reaches the minimum; the balance line (Special) gives way. Feasible only
 *                    while the CTC still covers every line.
 *                    WAGES_50: per structure, Basic's formula rises (the smallest % of CTC, in 0.5 steps) until
 *                    wages are at least half of remuneration for everybody on it; a NEW structure version is
 *                    made and everybody moves to it by a dated salary row.
 *   RAISE_CTC      raise to the minimum wage by increasing the CTC (same structure): the smallest CTC (to
 *                    ₹100 a month) whose wages meet the minimum; the extra cost is shown.
 *   ADD_STATUTORY  add the missing statutory line: make the component active (or create it), and put a
 *                    person left out of PF back on PF (a dated salary row with PF on the ceiling).
 *
 * Every option previews BEFORE and AFTER, per person and per structure: take-home, company cost, PF and
 * ESI (employee and employer) and who loses take-home. Applying is applyOption (todos.js calls it after
 * the Owner approves): dated changes from the law's effective date through the payroll services
 * (createStructure / createSalary / updateComponent), so arrears follow in the next run. A change that
 * LOWERS someone's take-home is never dated back over a month already paid: it starts with the first
 * month not yet locked (said on the preview).
 */
import { pool } from '../../lib/db.js';
import { loadComponents, loadStructures, shapeSalary, SALARY_COLUMNS, overrideMap } from '../payroll/common.js';
import { breakdown } from '../payroll/structure.js';
import { READY_MADE_COMPONENTS } from '../payroll/seed.js';
import * as K from './checks.js';
import { REMEDIES } from './constants.js';
import { lawCache, monthlyPay, today, dateText } from './context.js';

const money = (x) => Math.round((Number(x) || 0) * 100) / 100;
const addDay = (iso, n = 1) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const PCT_FORMULA = /^\s*(\d+(?:\.\d+)?)\s*%\s*of\s*CTC\s*$/i;

/** Everything a fix needs about the company, read once. */
async function worldOf(db, companyId, breach) {
  const [comps, structs] = await Promise.all([loadComponents(db, companyId), loadStructures(db, companyId)]);
  const ids = [...new Set((breach.people ?? []).map((p) => Number(p.employeeId)))];
  const salaries = new Map();
  const latest = new Map();
  if (ids.length) {
    const [rows] = await db.query(`SELECT ${SALARY_COLUMNS} FROM hrms_pay_salaries WHERE company_id = ? AND deleted_at IS NULL AND employee_id IN (?) ORDER BY effective_from, id`, [companyId, ids]);
    for (const r of rows) {
      const s = shapeSalary(r);
      latest.set(s.employeeId, s);
      if ((breach.people ?? []).some((p) => Number(p.salaryId) === s.id)) salaries.set(s.employeeId, s);
    }
  }
  const [[locked]] = await db.query("SELECT MAX(period_month) AS m FROM hrms_pay_runs WHERE company_id = ? AND deleted_at IS NULL AND status IN ('LOCKED','RELEASED','PAID')", [companyId]);
  const firstOpen = locked?.m ? (() => { const [y, m] = locked.m.split('-').map(Number); return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`; })() : null;
  return { comps, structs, salaries, latest, firstOpen, cache: lawCache(db) };
}

async function settingsFor(w, place, on) { return w.cache.statutory(place?.state ?? 'TG', on); }
const varsOf = (st) => ({ PF_CEILING: st.PF?.wageCeiling ?? null, ESI_CEILING: st.ESI?.wageCeiling ?? null });
const noNegative = (b) => b.ok && b.lines.every((l) => l.monthly >= 0);

function change(before, after) {
  const d = (k) => money((after?.[k] ?? 0) - (before?.[k] ?? 0));
  return { takeHome: d('takeHome'), cost: d('cost'), gross: d('gross'), pfEe: d('pfEe'), pfEr: d('pfEr'), esiEe: d('esiEe'), esiEr: d('esiEr') };
}

/** The date a person's change starts: the law's date, after their latest salary row; not back over paid months if pay falls. */
function startOf(w, employeeId, deadline, lowers) {
  let d = deadline ?? today();
  const last = w.latest.get(Number(employeeId));
  if (last && d <= last.effectiveFrom) d = addDay(last.effectiveFrom);
  let note = d !== (deadline ?? d) ? `From ${d}: a later salary row starts after the law's date.` : null;
  if (lowers && w.firstOpen && d < w.firstOpen) { d = w.firstOpen; note = `From ${d}, the first month not yet locked: this change lowers take-home, so it is not dated back over paid months.`; }
  return { effectiveFrom: d, note };
}

function totalsOf(perPerson) {
  const ok = perPerson.filter((p) => p.feasible);
  const sum = (f) => money(ok.reduce((s, p) => s + f(p), 0));
  return {
    people: perPerson.length, feasible: ok.length, losers: ok.filter((p) => p.losesTakeHome).length,
    extraCostMonthly: sum((p) => p.change.cost), extraCostAnnual: money(sum((p) => p.change.cost) * 12), takeHomeChangeMonthly: sum((p) => p.change.takeHome),
  };
}

function perStructureOf(perPerson, structs) {
  const map = new Map();
  for (const p of perPerson) {
    const id = p.toStructureId ?? p.structureId;
    const k = p.structureId;
    if (!map.has(k)) map.set(k, { structureId: k, name: structs.get(k)?.name ?? null, newStructure: p.newStructureName ?? null, people: 0, losers: 0, before: { takeHome: 0, cost: 0, pfEe: 0, pfEr: 0, esiEe: 0, esiEr: 0 }, after: { takeHome: 0, cost: 0, pfEe: 0, pfEr: 0, esiEe: 0, esiEr: 0 } });
    const s = map.get(k);
    void id;
    s.people += 1;
    if (p.losesTakeHome) s.losers += 1;
    for (const f of Object.keys(s.before)) { s.before[f] = money(s.before[f] + (p.before?.[f] ?? 0)); s.after[f] = money(s.after[f] + (p.after?.[f] ?? (p.before?.[f] ?? 0))); }
  }
  return [...map.values()];
}

/* ── per-person fixes (minimum wage) ─────────────────────────────────── */

async function personBase(w, p, on) {
  const s = w.salaries.get(Number(p.employeeId));
  const st = s ? w.structs.get(s.structureId) : null;
  if (!s || !st) return null;
  const settings = await settingsFor(w, p.place, on);
  const b0 = breakdown(st.lines, w.comps.byId, s.annualCtc, overrideMap(s), { pfMode: s.pfMode, vars: varsOf(settings) });
  return { s, st, settings, b0, before: monthlyPay(b0.lines, w.comps.byCode, settings, s.pfMode) };
}

async function resplitPerson(w, p, breach) {
  const on = breach.deadline ?? breach.on ?? today();
  const base = await personBase(w, p, on);
  const need = Number(p.monthlyMinimum ?? p.numbers?.minimum) || 0;
  const row = { employeeId: p.employeeId, code: p.code, name: p.name, structureId: p.structureId, feasible: false, before: base?.before ?? null };
  if (!base || !need) return { ...row, note: 'The salary or the minimum is not known.' };
  const basic = base.st.lines.find((l) => w.comps.byId.get(l.componentId)?.code === 'BASIC');
  if (!basic) return { ...row, note: 'The structure has no Basic line to raise.' };
  const da = base.b0.lines.find((l) => l.code === 'DA')?.monthly ?? 0;
  const target = Math.ceil(need - da);
  const current = base.b0.lines.find((l) => l.code === 'BASIC')?.monthly ?? 0;
  if (current >= target) return { ...row, feasible: true, after: base.before, change: change(base.before, base.before), note: 'Basic already meets it.' };
  const overrides = { ...overrideMap(base.s), [basic.componentId]: target };
  const b1 = breakdown(base.st.lines, w.comps.byId, base.s.annualCtc, overrides, { pfMode: base.s.pfMode, vars: varsOf(base.settings) });
  if (!noNegative(b1)) return { ...row, note: `Not within the CTC: Basic of ₹${target.toLocaleString('en-IN')} leaves the other lines short. Raise the CTC instead.` };
  const after = monthlyPay(b1.lines, w.comps.byCode, base.settings, base.s.pfMode);
  const ch = change(base.before, after);
  const start = startOf(w, p.employeeId, breach.deadline, ch.takeHome < -0.5);
  return {
    ...row, feasible: true, after, change: ch, losesTakeHome: ch.takeHome < -0.5, ...start,
    salary: { annualCtc: base.s.annualCtc, structureId: base.s.structureId, pfMode: base.s.pfMode, stateCode: base.s.stateCode, overrides: Object.entries(overrides).map(([componentId, amount]) => ({ componentId: Number(componentId), amount: Number(amount) })) },
    detail: `Basic ₹${current.toLocaleString('en-IN')} → ₹${target.toLocaleString('en-IN')} a month, within the same CTC.`,
  };
}

async function raisePerson(w, p, breach) {
  const on = breach.deadline ?? breach.on ?? today();
  const base = await personBase(w, p, on);
  const need = Number(p.monthlyMinimum ?? p.numbers?.minimum) || 0;
  const row = { employeeId: p.employeeId, code: p.code, name: p.name, structureId: p.structureId, feasible: false, before: base?.before ?? null };
  if (!base || !need) return { ...row, note: 'The salary or the minimum is not known.' };
  const meets = (ctc) => {
    const b = breakdown(base.st.lines, w.comps.byId, ctc, overrideMap(base.s), { pfMode: base.s.pfMode, vars: varsOf(base.settings) });
    return noNegative(b) && K.wagesOf(b.lines.filter((l) => l.frequency === 'MONTHLY')).codeWages + 0.005 >= need ? b : null;
  };
  let lo = base.s.annualCtc;
  let hi = Math.max(lo * 2, need * 12 * 4);
  if (!meets(hi)) return { ...row, note: 'No CTC up to four times the minimum meets it with this structure (fixed overrides?). Re-split instead.' };
  for (let i = 0; i < 60 && hi - lo > 1; i += 1) { const mid = (lo + hi) / 2; if (meets(mid)) hi = mid; else lo = mid; }
  let ctc = Math.max(Math.ceil(lo / 1200) * 1200, 1200);
  while (!meets(ctc)) ctc += 1200;
  const b1 = meets(ctc);
  const after = monthlyPay(b1.lines, w.comps.byCode, base.settings, base.s.pfMode);
  const ch = change(base.before, after);
  const start = startOf(w, p.employeeId, breach.deadline, ch.takeHome < -0.5);
  return {
    ...row, feasible: true, after, change: ch, losesTakeHome: ch.takeHome < -0.5, ...start, newCtc: ctc,
    salary: { annualCtc: ctc, structureId: base.s.structureId, pfMode: base.s.pfMode, stateCode: base.s.stateCode, overrides: base.s.overrides },
    detail: `CTC ₹${base.s.annualCtc.toLocaleString('en-IN')} → ₹${ctc.toLocaleString('en-IN')} a year (+₹${money(ctc - base.s.annualCtc).toLocaleString('en-IN')}).`,
  };
}

/* ── per-structure fix (the 50% rule) ────────────────────────────────── */

async function resplitStructures(w, breach) {
  const on = breach.deadline ?? breach.on ?? today();
  const perPerson = [];
  const structures = [];
  const byStruct = new Map();
  for (const p of breach.people) { if (!byStruct.has(p.structureId)) byStruct.set(p.structureId, []); byStruct.get(p.structureId).push(p); }
  for (const [sid, people] of byStruct) {
    const st = w.structs.get(sid);
    const basicLine = st?.lines.find((l) => w.comps.byId.get(l.componentId)?.code === 'BASIC');
    if (!st || !basicLine) {
      for (const p of people) perPerson.push({ employeeId: p.employeeId, code: p.code, name: p.name, structureId: sid, feasible: false, note: 'The structure has no Basic line.' });
      continue;
    }
    const m = PCT_FORMULA.exec(basicLine.formula);
    const formulaAt = (pct) => (m ? `${pct}% of CTC` : `max(${basicLine.formula}, ${pct}% of CTC)`);
    const linesAt = (pct) => st.lines.map((l) => (l.componentId === basicLine.componentId ? { ...l, formula: formulaAt(pct) } : l));
    const cases = [];
    for (const p of people) {
      const s = w.salaries.get(Number(p.employeeId));
      if (!s) continue;
      const settings = await settingsFor(w, p.place, on);
      cases.push({ p, s, settings, b0: breakdown(st.lines, w.comps.byId, s.annualCtc, overrideMap(s), { pfMode: s.pfMode, vars: varsOf(settings) }) });
    }
    const ok = (pct, c) => {
      const b = breakdown(linesAt(pct), w.comps.byId, c.s.annualCtc, overrideMap(c.s), { pfMode: c.s.pfMode, vars: varsOf(c.settings) });
      return noNegative(b) && K.wagesOf(b.lines).ratio >= 0.5 - 1e-9 ? b : null;
    };
    const start = m ? Number(m[1]) : 30;
    let chosen = null;
    for (let pct = start; pct <= 90; pct += 0.5) {
      if (cases.every((c) => ok(pct, c))) { chosen = pct; break; }
    }
    // When nobody reaches it at any %, take the % that fixes the most.
    if (chosen == null) {
      let best = start; let bestN = -1;
      for (let pct = start; pct <= 90; pct += 0.5) { const n = cases.filter((c) => ok(pct, c)).length; if (n > bestN) { bestN = n; best = pct; } }
      chosen = best;
    }
    const code = `${st.code}`.slice(0, 20).replace(/_+$/, '');
    const stamp = String(on).replace(/-/g, '').slice(2);
    const newCode = `${code}_LC${stamp}`.slice(0, 30);
    structures.push({ fromId: st.id, fromCode: st.code, fromName: st.name, code: newCode, name: `${st.name} (Labour Code, from ${on})`.slice(0, 120), basicFormula: formulaAt(chosen), basicPct: chosen, lines: linesAt(chosen).map((l) => ({ componentId: l.componentId, formula: l.formula })) });
    for (const c of cases) {
      const b1 = ok(chosen, c);
      const before = monthlyPay(c.b0.lines, w.comps.byCode, c.settings, c.s.pfMode);
      if (!b1) { perPerson.push({ employeeId: c.p.employeeId, code: c.p.code, name: c.p.name, structureId: st.id, feasible: false, before, note: `At ${chosen}% Basic the CTC of ₹${c.s.annualCtc.toLocaleString('en-IN')} does not reach 50% wages (fixed lines take too much).` }); continue; }
      const after = monthlyPay(b1.lines, w.comps.byCode, c.settings, c.s.pfMode);
      const ch = change(before, after);
      const st0 = startOf(w, c.p.employeeId, breach.deadline, ch.takeHome < -0.5);
      perPerson.push({
        employeeId: c.p.employeeId, code: c.p.code, name: c.p.name, structureId: st.id, newStructureName: structures[structures.length - 1].name, feasible: true, before, after, change: ch, losesTakeHome: ch.takeHome < -0.5, ...st0,
        salary: { annualCtc: c.s.annualCtc, structureCode: newCode, pfMode: c.s.pfMode, stateCode: c.s.stateCode, overrides: c.s.overrides },
        detail: `Basic ${basicLine.formula} → ${formulaAt(chosen)} (wages ${(K.wagesOf(c.b0.lines).ratio * 100).toFixed(1)}% → ${(K.wagesOf(b1.lines).ratio * 100).toFixed(1)}%).`,
      });
    }
  }
  return { perPerson, structures };
}

/* ── statutory ───────────────────────────────────────────────────────── */

async function addStatutory(w, breach) {
  const on = breach.deadline ?? breach.on ?? today();
  const components = [];
  const perPerson = [];
  if (breach.check === 'STATUTORY_MISSING') {
    const keys = [...new Set(breach.people.map((p) => p.numbers?.key).filter(Boolean))];
    for (const key of keys) {
      const have = w.comps.list.find((c) => c.statutoryKey === key);
      const ready = READY_MADE_COMPONENTS.find((c) => c.statutoryKey === key);
      components.push(have ? { action: 'ACTIVATE', id: have.id, code: have.code, name: have.name, key } : { action: 'CREATE', code: ready?.code ?? key, name: ready?.name ?? key, key });
    }
    for (const p of breach.people) {
      const base = await personBase(w, p, on);
      perPerson.push({ employeeId: p.employeeId, code: p.code, name: p.name, structureId: p.structureId, feasible: Boolean(base), before: base?.before ?? null, after: null, change: null, detail: `${p.numbers?.key ?? 'The component'} is deducted again by the run from the next calculation.` });
    }
  } else {
    for (const p of breach.people) {
      const base = await personBase(w, p, on);
      if (!base) { perPerson.push({ employeeId: p.employeeId, code: p.code, name: p.name, structureId: p.structureId, feasible: false, note: 'The salary is not known.' }); continue; }
      const b1 = breakdown(base.st.lines, w.comps.byId, base.s.annualCtc, overrideMap(base.s), { pfMode: 'CEILING', vars: varsOf(base.settings) });
      const after = monthlyPay(b1.lines, w.comps.byCode, base.settings, 'CEILING');
      const ch = change(base.before, after);
      const st0 = startOf(w, p.employeeId, breach.deadline, ch.takeHome < -0.5);
      perPerson.push({ employeeId: p.employeeId, code: p.code, name: p.name, structureId: p.structureId, feasible: true, before: base.before, after, change: ch, losesTakeHome: ch.takeHome < -0.5, ...st0, salary: { annualCtc: base.s.annualCtc, structureId: base.s.structureId, pfMode: 'CEILING', stateCode: base.s.stateCode, overrides: base.s.overrides }, detail: 'PF on the wage up to the ceiling.' });
    }
  }
  return { perPerson, components };
}

/**
 * The fixes for a breach (from findBreaches), each with its before / after.
 * @returns { breachKey, check, options: [{ key, label, description, feasible, totals, perStructure, perPerson, structures?, components? }] }
 */
export async function proposeFixes(breach, db = pool) {
  const keys = breach?.remedies ?? [];
  if (!keys.length || !breach.companyId) return { breachKey: breach?.key ?? null, check: breach?.check ?? null, options: [] };
  const w = await worldOf(db, breach.companyId, breach);
  const options = [];
  for (const key of keys) {
    let perPerson = [];
    let extra = {};
    let description = '';
    if (key === 'RESPLIT' && (breach.check === 'MIN_WAGE' || breach.check === 'MIN_WAGE_BASIC')) {
      for (const p of breach.people) perPerson.push(await resplitPerson(w, p, breach));
      description = 'Basic rises to the minimum (less DA) within the same CTC; Special allowance (the balance) gives way. No extra cost except employer PF/ESI on the higher wage, which the CTC absorbs.';
    } else if (key === 'RESPLIT' && breach.check === 'WAGES_50') {
      const r = await resplitStructures(w, breach);
      perPerson = r.perPerson;
      extra = { structures: r.structures };
      description = `A new version of each structure with Basic at ${r.structures.map((s) => `${s.basicPct}%`).join(' / ')} of CTC, so wages are at least half of remuneration; everybody moves to it by a dated salary row. The CTC stays; the balance line gives way.`;
    } else if (key === 'RAISE_CTC') {
      for (const p of breach.people) perPerson.push(await raisePerson(w, p, breach));
      description = 'The CTC rises (same structure) to the smallest amount, to ₹100 a month, whose wages meet the minimum. Extra cost shown.';
    } else if (key === 'ADD_STATUTORY') {
      const r = await addStatutory(w, breach);
      perPerson = r.perPerson;
      extra = { components: r.components };
      description = breach.check === 'STATUTORY_MISSING' ? 'The statutory component is made active (or created) so that each run deducts it again.' : 'PF on the wage up to the ceiling again, by a dated salary row.';
    } else continue;
    options.push({
      key, label: REMEDIES[key], description, feasible: perPerson.length > 0 && perPerson.every((p) => p.feasible),
      infeasible: perPerson.filter((p) => !p.feasible).map((p) => ({ employeeId: p.employeeId, name: p.name, note: p.note })),
      totals: totalsOf(perPerson), perStructure: perStructureOf(perPerson, w.structs), perPerson, ...extra,
    });
  }
  return { breachKey: breach.key, check: breach.check, deadline: breach.deadline, options };
}

/**
 * Applies a chosen option: dated changes through the payroll services. Called in the caller's transaction.
 * @returns { structures: [{ id, code }], salaries: [{ employeeId, salaryId, effectiveFrom, arrearsFor }], components: [...] }
 */
export async function applyOption(db, c, option, { todoId, requestId = null } = {}) {
  const PAY = await import('../payroll/payrollService.js');
  const done = { structures: [], salaries: [], components: [], skipped: [] };
  const reason = `Compliance to-do #${todoId}: ${option.label}`;
  for (const comp of option.components ?? []) {
    if (comp.action === 'ACTIVATE') { await PAY.updateComponent(db, c, comp.id, { status: 'ACTIVE' }, requestId); done.components.push({ id: comp.id, code: comp.code, action: 'ACTIVATE' }); }
    else {
      const ready = READY_MADE_COMPONENTS.find((k) => k.statutoryKey === comp.key);
      // A statutory component is a ready-made one (createComponent refuses a statutory key): written as the setup writes it.
      if (ready) {
        const [ins] = await db.query(
          `INSERT INTO hrms_pay_components (company_id, code, name, kind, taxable, exemption_rule, in_pf_wage, in_esi_wage, in_gratuity_wage, frequency, prorate_on_lop,
             statutory_key, sort_order, status, is_ready_made, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', 1, ?)`,
          [c.companyId, ready.code, ready.name, ready.kind, ready.taxable, ready.exemptionRule, ready.inPfWage, ready.inEsiWage, ready.inGratuityWage, ready.frequency, ready.prorateOnLop, ready.statutoryKey, ready.sortOrder, c.userId]);
        done.components.push({ id: ins.insertId, code: ready.code, action: 'CREATE' });
      }
    }
  }
  const codeToId = new Map();
  for (const s of option.structures ?? []) {
    const [[exists]] = await db.query('SELECT id FROM hrms_pay_structures WHERE company_id = ? AND UPPER(code) = ? AND deleted_at IS NULL', [c.companyId, s.code]);
    let id = exists?.id;
    if (!id) {
      const r = await PAY.createStructure(db, c, { code: s.code, name: s.name, description: `Made by compliance to-do #${todoId} from ${s.fromName}: Basic ${s.basicFormula}.`, lines: s.lines }, requestId);
      id = r.structure.id;
    }
    await PAY.updateStructure(db, c, s.fromId, { status: 'INACTIVE' }, requestId);
    codeToId.set(s.code, id);
    done.structures.push({ id, code: s.code, from: s.fromId });
  }
  for (const p of option.perPerson ?? []) {
    if (!p.feasible || !p.salary) { if (!p.salary && p.feasible) continue; done.skipped.push({ employeeId: p.employeeId, note: p.note }); continue; }
    const structureId = p.salary.structureId ?? codeToId.get(p.salary.structureCode);
    const body = {
      employeeId: p.employeeId, annualCtc: p.salary.annualCtc, structureId, effectiveFrom: p.effectiveFrom, pfMode: p.salary.pfMode,
      stateCode: p.salary.stateCode ?? undefined, overrides: p.salary.overrides ?? [], reason, complianceReason: reason,
    };
    const r = await PAY.createSalary(db, c, body, requestId, { warn: 'record', reason });
    done.salaries.push({ employeeId: p.employeeId, salaryId: r.salary.id, effectiveFrom: r.salary.effectiveFrom, arrearsFor: r.arrearsFor ?? [] });
  }
  return done;
}

export default { proposeFixes, applyOption };
export { dateText };
