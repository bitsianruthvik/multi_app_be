/**
 * demo-scorecard.mjs — LOCAL demo data for the org chart's KPI scorecard (draft v1).
 *
 *   node apps/cf_hrms/scripts/demo-scorecard.mjs                     make the demo (run from multi_app_be)
 *   node apps/cf_hrms/scripts/demo-scorecard.mjs --clean             remove exactly what it made
 *   options: --company=karni (default)  --department=Cylinder (default; by name)
 *
 * LOCAL ONLY: --target=prod (or --prod) is refused.
 *
 * WHAT IT MAKES, through the app's own services (never raw SQL for the data itself):
 *   1. performance settings, if the company has none (April year, quarterly, the 1–5 scale);
 *   2. the current period of the department's frequency (Q3 2026-27 on 16 Oct 2026), if not made;
 *   3. a plan for every person of the department who would get one (planService.createPlans);
 *   4. the person with the most KPIs — one of every state the card draws:
 *      their number KPIs entered MONTHLY (so the card says "average of 1 of 3 months");
 *      three KPIs ADDED for the period (planService.addKpi, under their 1st, 4th and 5th
 *      KRA): a count added up monthly (a SUM part-way through: "on pace"), a ₹ amount
 *      added up monthly ("behind pace", at risk) and a % entered once (left missing);
 *      then activated, and actuals for every open slot: the first number KPI met
 *      (~104%), the second behind (~60% — at Karni a lower-is-better time), the third
 *      missing, the count ~112% of pace, the amount ~80% of pace; a words KPI "met";
 *   5. the person with the second most KPIs: the plan left a DRAFT (the "Draft" badge);
 *   6. everybody else: activated, with actuals near target (a words KPI "not met").
 * One transaction. A marker row in hrms_audit_log (entity_type 'demo_scorecard',
 * request_id 'demo-scorecard') lists what was made, so --clean removes exactly that —
 * plans, KRAs, KPIs, actuals, reviews, actions, their audit rows; the period and the
 * settings only when the demo made them. A second run while the demo exists does nothing.
 */
import mysql from 'mysql2/promise';
import { resolveTarget, announce } from './dbTarget.mjs';
import { readSettings, saveSettings, DEFAULTS } from '../services/performance/settingsService.js';
import { previewPlans, createPlans, changeKpi, addKpi, activatePlan } from '../services/performance/planService.js';
import { enterActuals } from '../services/performance/actualsService.js';
import { periodFor } from '../services/performance/periods.js';
import { slotsOf } from '../services/performance/slots.js';
import { today } from '../services/positionService.js';

const args = process.argv.slice(2);
const arg = (n, d = null) => { const hit = args.find((a) => a.startsWith(`--${n}=`)); return hit ? hit.slice(hit.indexOf('=') + 1) : d; };
const CLEAN = args.includes('--clean');
const MARK = 'demo-scorecard';

if (args.some((a) => a === '--target=prod' || a === '--prod')) {
  console.error('demo-scorecard is LOCAL ONLY. Refusing --target=prod.');
  process.exit(2);
}

async function marker(db, companyId) {
  const [[m]] = await db.query(
    "SELECT id, after_json FROM hrms_audit_log WHERE company_id = ? AND entity_type = 'demo_scorecard' AND request_id = ? ORDER BY id DESC LIMIT 1",
    [companyId, MARK],
  );
  if (!m) return null;
  return { id: m.id, ...(typeof m.after_json === 'string' ? JSON.parse(m.after_json) : m.after_json) };
}

async function make(db, c, deptName) {
  const [[dept]] = await db.query('SELECT id, name FROM hrms_departments WHERE company_id = ? AND name = ? AND deleted_at IS NULL LIMIT 1', [c.companyId, deptName]);
  if (!dept) throw new Error(`No department named "${deptName}".`);

  // 1. settings
  let settings = await readSettings(db, c.companyId);
  const settingsCreated = !settings.saved;
  if (settingsCreated) {
    await saveSettings(db, c, { yearStartMonth: DEFAULTS.yearStartMonth, defaultFrequency: DEFAULTS.defaultFrequency, ratingScale: DEFAULTS.ratingScale });
    settings = await readSettings(db, c.companyId);
  }

  // 2. the period of the department's frequency that holds today
  const [[freq]] = await db.query(
    `SELECT COALESCE(r.performance_frequency, ?) AS f, COUNT(*) AS n FROM hrms_positions p JOIN hrms_roles r ON r.company_id = p.company_id AND r.id = p.role_id
      WHERE p.company_id = ? AND p.department_id = ? AND p.deleted_at IS NULL GROUP BY f ORDER BY n DESC LIMIT 1`,
    [settings.defaultFrequency, c.companyId, dept.id],
  );
  const frequency = freq?.f ?? settings.defaultFrequency;
  const on = today();
  const period = periodFor(frequency, settings.yearStartMonth, on);
  const [[had]] = await db.query('SELECT id FROM hrms_performance_periods WHERE company_id = ? AND frequency = ? AND start_date = ?', [c.companyId, frequency, period.start]);

  // 3. plans for the department
  const preview = await previewPlans(db, c.companyId, { frequency, start: period.start }, [dept.id]);
  if (!preview.willGet.length) throw new Error(`Nobody in ${dept.name} would get a ${frequency.toLowerCase()} plan for ${period.name} (${preview.skipped.length} skipped: ${preview.skipped.map((s) => s.line).join('; ')}).`);
  const made = await createPlans(db, c, { frequency, start: period.start, employeeIds: preview.willGet.map((p) => p.employeeId) }, [dept.id]);
  const plans = [...made.plans].sort((a, b) => b.kpiCount - a.kpiCount || a.name.localeCompare(b.name));
  const periodRow = { ...made.period };

  const kpisOf = async (planId) => (await db.query('SELECT * FROM hrms_performance_plan_kpis WHERE company_id = ? AND plan_id = ? AND deleted_at IS NULL ORDER BY sort_order, id', [c.companyId, planId]))[0];
  const report = [];
  const entries = [];
  const openSlots = (k) => slotsOf(periodRow, k.entry_frequency).filter((s) => s.start <= on);
  /** A value that lands at about `pct` % achievement. */
  const valueAt = (k, pct) => {
    const n = slotsOf(periodRow, k.entry_frequency).length;
    // A SUM target is for the whole period: one slot's share of it.
    const t = Number(k.target_number) / (k.combine_rule === 'SUM' && n > 1 ? n : 1);
    if (k.direction === 'LOWER_BETTER') return Math.round((t * 100 / pct) * 10) / 10;
    if (k.direction === 'EXACT') return pct >= 100 ? t : t + 1;
    return Math.round(t * pct / 100);
  };

  for (const [i, p] of plans.entries()) {
    if (i === 1 && plans.length > 2) { report.push(`${p.name}: DRAFT, ${p.kpiCount} KPIs`); continue; }
    if (i === 0) {
      const [kras] = await db.query('SELECT id FROM hrms_performance_plan_kras WHERE company_id = ? AND plan_id = ? AND deleted_at IS NULL ORDER BY sort_order, id', [c.companyId, p.id]);
      const kraAt = (n) => kras[n]?.id ?? kras[0]?.id ?? null;
      await addKpi(db, c, p.id, { planKraId: kraAt(0), name: 'Cylinders received from vendors', direction: 'HIGHER_BETTER', targetNumber: 300, unit: 'cylinders', frequency: 'MONTHLY', combine: 'SUM' });
      await addKpi(db, c, p.id, { planKraId: kraAt(3), name: 'Cylinder cost recovered from customers', direction: 'HIGHER_BETTER', targetNumber: 1200000, unit: '₹', frequency: 'MONTHLY', combine: 'SUM' });
      await addKpi(db, c, p.id, { planKraId: kraAt(4), name: 'Rubber rollers ready before job start', direction: 'HIGHER_BETTER', targetNumber: 98, unit: '%' });
    }
    const kpis = await kpisOf(p.id);
    const numbers = kpis.filter((k) => k.direction !== 'TEXT' && k.target_number != null);
    const words = kpis.filter((k) => k.direction === 'TEXT');
    if (i === 0) {
      // Entered monthly, so the card says how the months are combined.
      for (const k of numbers) if (!k.added_on_plan) await changeKpi(db, c, p.id, k.id, { frequency: 'MONTHLY' });
    }
    await activatePlan(db, c, p.id);
    const fresh = await kpisOf(p.id);
    const byId = new Map(fresh.map((k) => [Number(k.id), k]));
    const lines = [];
    numbers.forEach((k0, j) => {
      const k = byId.get(Number(k0.id));
      let pct;
      if (i === 0) { const plan0 = [104, 60, null, 112, 80, null]; pct = j < plan0.length ? plan0[j] : 95; } // met · behind · missing · on pace · behind pace · missing
      else pct = j % 2 === 0 ? 100 : 88;
      if (pct == null) { lines.push(`${k.name}: missing`); return; }
      openSlots(k).forEach((s, n) => entries.push({ planId: p.id, kpiId: k.id, slotStart: s.start, value: valueAt(k, pct + (n % 2 ? 3 : 0)) }));
      lines.push(`${k.name}: ~${pct}%`);
    });
    words.forEach((k, j) => {
      if (i !== 0 && j > 0) return;
      const met = i === 0 ? 'YES' : 'NO';
      openSlots(k).forEach((s) => entries.push({ planId: p.id, kpiId: k.id, slotStart: s.start, met }));
      lines.push(`${k.name}: ${met === 'YES' ? 'met' : 'not met'}`);
    });
    report.push(`${p.name}: ACTIVE${lines.length ? ` — ${lines.join(', ')}` : ' (no KPIs on the plan)'}`);
  }
  if (entries.length) await enterActuals(db, c, entries, { source: 'MANUAL' });

  await db.query(
    `INSERT INTO hrms_audit_log (company_id, actor_user_id, entity_type, entity_id, action, before_json, after_json, request_id, created_by)
     VALUES (?, ?, 'demo_scorecard', ?, 'CREATE', NULL, ?, ?, ?)`,
    [c.companyId, c.userId, c.companyId, JSON.stringify({
      department: dept.name, periodId: made.period.id, periodName: made.period.name, periodCreated: !had, settingsCreated,
      planIds: plans.map((p) => p.id), people: plans.map((p) => ({ employeeId: p.employeeId, name: p.name, planId: p.id })),
    }), MARK, c.userId],
  );
  return { dept, period: made.period, report };
}

async function clean(db, companyId, m) {
  const ids = m.planIds?.length ? m.planIds : [0];
  const pick = async (sql) => (await db.query(sql, [companyId, ids]))[0].map((r) => Number(r.id));
  const kras = await pick('SELECT id FROM hrms_performance_plan_kras WHERE company_id = ? AND plan_id IN (?)');
  const kpis = await pick('SELECT id FROM hrms_performance_plan_kpis WHERE company_id = ? AND plan_id IN (?)');
  const actuals = await pick('SELECT id FROM hrms_performance_actuals WHERE company_id = ? AND plan_id IN (?)');
  const reviews = await pick('SELECT id FROM hrms_performance_reviews WHERE company_id = ? AND plan_id IN (?)');
  const actions = await pick('SELECT id FROM hrms_performance_actions WHERE company_id = ? AND plan_id IN (?)');
  const changes = await pick('SELECT id FROM hrms_performance_target_changes WHERE company_id = ? AND plan_id IN (?)');
  const dropAudit = async (type, list) => { if (list.length) await db.query('DELETE FROM hrms_audit_log WHERE company_id = ? AND entity_type = ? AND entity_id IN (?)', [companyId, type, list]); };
  await dropAudit('hrms_performance_actions', actions);
  await dropAudit('hrms_performance_reviews', reviews);
  await dropAudit('hrms_performance_actuals', actuals);
  await dropAudit('hrms_performance_target_changes', changes);
  await dropAudit('hrms_performance_plan_kpis', kpis);
  await dropAudit('hrms_performance_plan_kras', kras);
  await dropAudit('hrms_performance_plans', m.planIds ?? []);
  await db.query('DELETE FROM hrms_performance_actions WHERE company_id = ? AND plan_id IN (?)', [companyId, ids]);
  await db.query('DELETE FROM hrms_performance_reviews WHERE company_id = ? AND plan_id IN (?)', [companyId, ids]);
  await db.query('UPDATE hrms_performance_actuals SET corrects_id = NULL WHERE company_id = ? AND plan_id IN (?)', [companyId, ids]);
  await db.query('DELETE FROM hrms_performance_actuals WHERE company_id = ? AND plan_id IN (?)', [companyId, ids]);
  await db.query('DELETE FROM hrms_performance_target_changes WHERE company_id = ? AND plan_id IN (?)', [companyId, ids]);
  await db.query('DELETE FROM hrms_performance_plan_kpis WHERE company_id = ? AND plan_id IN (?)', [companyId, ids]);
  await db.query('DELETE FROM hrms_performance_plan_kras WHERE company_id = ? AND plan_id IN (?)', [companyId, ids]);
  await db.query('DELETE FROM hrms_performance_plans WHERE company_id = ? AND id IN (?)', [companyId, ids]);
  let periodGone = false;
  if (m.periodCreated && m.periodId) {
    const [[left]] = await db.query('SELECT COUNT(*) AS n FROM hrms_performance_plans WHERE company_id = ? AND period_id = ?', [companyId, m.periodId]);
    if (Number(left.n) === 0) {
      await dropAudit('hrms_performance_periods', [Number(m.periodId)]);
      await db.query('DELETE FROM hrms_performance_periods WHERE company_id = ? AND id = ?', [companyId, m.periodId]);
      periodGone = true;
    }
  }
  if (m.settingsCreated) {
    await db.query("DELETE FROM hrms_audit_log WHERE company_id = ? AND entity_type = 'hrms_performance_settings'", [companyId]);
    await db.query('DELETE FROM hrms_performance_settings WHERE company_id = ?', [companyId]);
  }
  await db.query("DELETE FROM hrms_audit_log WHERE company_id = ? AND entity_type = 'demo_scorecard' AND request_id = ?", [companyId, MARK]);
  return { plans: m.planIds?.length ?? 0, kpis: kpis.length, actuals: actuals.length, reviews: reviews.length, actions: actions.length, periodGone, settingsGone: Boolean(m.settingsCreated) };
}

async function main() {
  const target = resolveTarget();
  if (target.isProd) throw new Error('LOCAL ONLY.');
  announce(target);
  const db = await mysql.createConnection({ ...target.cfg, dateStrings: true });
  try {
    const [[company]] = await db.query('SELECT id, name FROM companies WHERE slug = ? AND deleted_at IS NULL', [arg('company', 'karni')]);
    if (!company) throw new Error('No such company.');
    const [[actor]] = await db.query("SELECT id FROM users WHERE email = 'test@karni.com' LIMIT 1");
    const c = { companyId: Number(company.id), userId: actor ? Number(actor.id) : null, owner: true };
    const existing = await marker(db, c.companyId);
    await db.beginTransaction();
    if (CLEAN) {
      if (!existing) { console.log('  No demo scorecard data to remove.'); await db.rollback(); return; }
      const out = await clean(db, c.companyId, existing);
      await db.commit();
      console.log(`  Removed the demo (${existing.department}, ${existing.periodName}):`, out);
      return;
    }
    if (existing) {
      await db.rollback();
      console.log(`  The demo is already there: ${existing.department}, ${existing.periodName}, plans ${existing.planIds.join(', ')}. Run with --clean to remove it.`);
      return;
    }
    const out = await make(db, c, arg('department', 'Cylinder'));
    await db.commit();
    console.log(`  Made the demo: ${out.dept.name}, ${out.period.name} (${out.period.start} – ${out.period.end})`);
    for (const line of out.report) console.log(`    ${line}`);
  } catch (e) {
    try { await db.rollback(); } catch { /* nothing open */ }
    throw e;
  } finally {
    await db.end();
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e.message ?? e); process.exit(1); });
