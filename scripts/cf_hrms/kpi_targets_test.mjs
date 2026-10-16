/**
 * kpi_targets_test.mjs — structured KPI targets (TM/CF_HRMS_HIRING_SPEC.md §24 step 2, 2026-10-16).
 *
 *   0. the schema (apply-kpi-targets-schema.mjs): a second run plans nothing;
 *   1. every measured-in and every which-way: the input read, the text written from the
 *      structure, the live sentence — and the written text reads back to the same structure;
 *   2. free text still parsed (kept as typed; structure filled when it reads cleanly; the
 *      definition's direction wins over a guess; what cannot be read stays words);
 *   3. range and date scoring (scoring.js: rangeAchievement, kpiResult, the gap in words);
 *   4. role lines: structured targets write their text; the JD / resolver read it; bad input refused;
 *   5. plans copy the structure (range, date, done, words, the definition's direction), and score it;
 *      a dated target change on an active plan keeps the range;
 *   6. inheritance: a change to the library KPI reaches role, position and person lines;
 *   7. the dated rules are unchanged (takes effect later; a past day only for the Owner, with a reason);
 *   8. the move script: dry run = apply, idempotent, conflicts set nothing, text never changes, audit rows;
 *   9. rights over HTTP (Employee refused; Owner allowed; /meta carries the vocabulary);
 *   and nothing is left behind.
 *
 *   node scripts/cf_hrms/kpi_targets_test.mjs [--company=karni] [--verbose]
 *
 * NOTHING IS LEFT BEHIND: the whole run is ONE connection inside ONE transaction (pool.query /
 * getConnection point at it; a route's own transaction is a savepoint), rolled back at the end. Local only.
 */
import express from 'express';
import cookieParser from 'cookie-parser';
import mysql from 'mysql2/promise';
import { pool } from '../../db.js';
import { signToken } from '../../core/utils/jwt.js';
import { appContext } from '../../core/middleware/appContext.js';
import hrmsApp from '../../apps/cf_hrms/app.js';
import { forgetAccess } from '../../apps/cf_hrms/lib/accessContext.js';
import { hrmsAppOf } from '../../apps/cf_hrms/services/accessGrants.js';
import { setupAccess } from '../../apps/cf_hrms/services/accessSetup.js';
import * as POS from '../../apps/cf_hrms/services/positionService.js';
import * as RC from '../../apps/cf_hrms/services/roleContentService.js';
import * as J from '../../apps/cf_hrms/services/jobContentService.js';
import { roleJobHistory } from '../../apps/cf_hrms/services/jobHistoryService.js';
import { resolveContent } from '../../apps/cf_hrms/services/contentResolver.js';
import K from '../../apps/cf_hrms/services/kpiTarget.js';
import { planTargetOf } from '../../apps/cf_hrms/services/performance/targets.js';
import { kpiResult, rangeAchievement, gapOf } from '../../apps/cf_hrms/services/performance/scoring.js';
import { periodFor } from '../../apps/cf_hrms/services/performance/periods.js';
import * as PLAN from '../../apps/cf_hrms/services/performance/planService.js';
import * as ACT from '../../apps/cf_hrms/services/performance/actualsService.js';
import { readSettings } from '../../apps/cf_hrms/services/performance/settingsService.js';
import { schemaSteps } from '../../apps/cf_hrms/scripts/apply-kpi-targets-schema.mjs';
import { planMove, applyMove } from '../../apps/cf_hrms/scripts/structure-kpi-targets.mjs';

const slug = (process.argv.find((a) => a.startsWith('--company=')) || '--company=karni').split('=')[1];
const VERBOSE = process.argv.includes('--verbose');
if (!['localhost', '127.0.0.1', '::1'].includes(String(process.env.DB_HOST ?? 'localhost'))) {
  console.error(`Refusing to run against DB_HOST=${process.env.DB_HOST}. This test is local only.`);
  process.exit(2);
}

let passed = 0;
const failed = [];
const ok = (cond, name, detail = '') => {
  if (cond) { passed += 1; if (VERBOSE) console.log(`  ok    ${name}`); } else { failed.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
  return Boolean(cond);
};
const note = (line) => console.log(`  note  ${line}`);
const section = (title) => console.log(`\n${title}`);
const caught = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
const shift = (iso, days) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
const J_ = (v) => JSON.stringify(v);
const readJson = (v) => { if (v == null || typeof v === 'object') return v; try { return JSON.parse(v); } catch { return v; } };

const TABLES = ['hrms_kpi_definitions', 'hrms_role_kpi_assignments', 'hrms_role_kra_assignments', 'hrms_position_content_overrides', 'hrms_work_assignment_content_overrides',
  'hrms_roles', 'hrms_positions', 'hrms_employees', 'hrms_work_assignments', 'hrms_performance_plans', 'hrms_performance_plan_kpis', 'hrms_performance_actuals',
  'hrms_performance_target_changes', 'hrms_audit_log', 'users', 'app_user_access'];
const dbCfg = { host: process.env.DB_HOST ?? 'localhost', user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME, port: Number(process.env.DB_PORT) || 3306 };
async function worldCount() {
  const conn = await mysql.createConnection(dbCfg);
  try {
    const out = {};
    for (const t of TABLES) {
      const [[r]] = await conn.query(`SELECT COUNT(*) AS n, COALESCE(SUM(deleted_at IS NULL), 0) AS live FROM ${t}`);
      out[t] = `${r.n}/${r.live}`;
    }
    const [[d]] = await conn.query("SELECT MD5(GROUP_CONCAT(CONCAT(id, measurement_type, COALESCE(unit, '-'), COALESCE(direction, '-')) ORDER BY id)) AS s FROM hrms_kpi_definitions");
    const [[a]] = await conn.query("SELECT MD5(GROUP_CONCAT(CONCAT(id, COALESCE(CAST(target_json AS CHAR), '-')) ORDER BY id)) AS s FROM hrms_role_kpi_assignments");
    out.definitions = d.s;
    out.lineSpecs = a.s;
    return out;
  } finally { await conn.end(); }
}
const before = await worldCount();

const real = { query: pool.query.bind(pool), execute: pool.execute.bind(pool), getConnection: pool.getConnection.bind(pool) };
const db = await real.getConnection();
await db.beginTransaction();
let depth = 0;
const inside = {
  query: (...a) => db.query(...a),
  execute: (...a) => db.execute(...a),
  beginTransaction: async () => { depth += 1; await db.query(`SAVEPOINT zz_kt_${depth}`); },
  commit: async () => { if (depth > 0) { await db.query(`RELEASE SAVEPOINT zz_kt_${depth}`); depth -= 1; } },
  rollback: async () => { if (depth > 0) { await db.query(`ROLLBACK TO SAVEPOINT zz_kt_${depth}`); depth -= 1; } },
  release: () => {},
};
pool.query = inside.query;
pool.execute = inside.execute;
pool.getConnection = async () => inside;

const TAG = `ZZKT${Date.now().toString(36).toUpperCase().slice(-5)}`;
const q = async (sql, params) => (await db.query(sql, params))[0];
const one = async (sql, params) => (await q(sql, params))[0] ?? null;
const ins = async (sql, params) => (await db.query(sql, params))[0].insertId;
const kpisOf = (jc) => [...(jc.kras ?? []).flatMap((k) => k.kpis ?? []), ...(jc.ungrouped?.kpis ?? jc.additional?.kpis ?? [])];

let server;
try {
  const company = await one('SELECT id, name, slug FROM companies WHERE slug = ? AND deleted_at IS NULL', [slug]);
  if (!company) throw new Error(`No company "${slug}".`);
  const COMPANY = company.id;
  const app = await hrmsAppOf(db, COMPANY);
  const owner = await one(
    `SELECT u.id, u.email, u.name FROM users u JOIN app_user_access aua ON aua.user_id = u.id AND aua.app_id = ? AND aua.deleted_at IS NULL JOIN roles r ON r.id = aua.role_id
      WHERE u.company_id = ? AND u.deleted_at IS NULL AND LOWER(r.name) = 'admin' ORDER BY u.id LIMIT 1`, [app.id, COMPANY]);
  if (!owner) throw new Error('This company has no Owner login.');
  const hr = { companyId: COMPANY, userId: owner.id, owner: false };
  const OWNERC = { companyId: COMPANY, userId: owner.id, owner: true };
  const T = POS.today();
  console.log(`kpi_targets_test — ${company.name} (${COMPANY}), run tag ${TAG}, today ${T}`);

  /* ══ 0. schema ════════════════════════════════════════════════════════════ */
  section('[0] The schema');
  {
    ok((await schemaSteps(db)).length === 0, 'apply-kpi-targets-schema: nothing left to do on this database (idempotent)');
    const types = await q(`SELECT COLUMN_NAME AS c, COLUMN_TYPE AS t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_kpi_definitions' AND COLUMN_NAME IN ('measurement_type', 'direction')`);
    const typeOf = Object.fromEntries(types.map((r) => [r.c, r.t]));
    ok(['WEIGHT', 'LENGTH', 'DATE', 'TEXT', 'RATING'].every((v) => typeOf.measurement_type.includes(`'${v}'`)) && ['EXACT', 'NEUTRAL', 'TARGET_RANGE'].every((v) => typeOf.direction.includes(`'${v}'`)),
      'measured in takes WEIGHT, LENGTH, DATE; which way takes EXACT — and every older value stays');
  }

  /* ══ 1. every measured-in and every which-way ═════════════════════════════ */
  section('[1] Every measured-in and which-way: input, text, sentence, read back');
  {
    const cases = [
      [{ measurementType: 'PERCENTAGE', direction: 'HIGHER_BETTER' }, { value: 95 }, 'at least 95%', 'At least 95% — higher is better'],
      [{ measurementType: 'PERCENTAGE', direction: 'LOWER_BETTER' }, { value: 1.5 }, 'at most 1.5%', 'At most 1.5% — lower is better'],
      [{ measurementType: 'NUMBER', unit: 'cylinders', direction: 'HIGHER_BETTER' }, { value: 2400 }, 'at least 2,400 cylinders', 'At least 2,400 cylinders — higher is better'],
      [{ measurementType: 'NUMBER', direction: 'EXACT' }, { value: 0 }, 'exactly 0', 'Exactly 0 — no more, no less'],
      [{ measurementType: 'CURRENCY', direction: 'HIGHER_BETTER' }, { value: 1200000 }, 'at least ₹12 L', 'At least ₹12 L — higher is better'],
      [{ measurementType: 'CURRENCY', direction: 'TARGET_RANGE' }, { min: 1000000, max: 1200000 }, 'between ₹10 L and ₹12 L', 'Between ₹10 L and ₹12 L — inside the range is met'],
      [{ measurementType: 'CURRENCY', direction: 'LOWER_BETTER' }, { value: 25000000 }, 'at most ₹2.5 Cr', 'At most ₹2.5 Cr — lower is better'],
      [{ measurementType: 'DURATION', unit: 'minutes', direction: 'LOWER_BETTER' }, { value: 30 }, 'at most 30 minutes', 'At most 30 minutes — lower is better'],
      [{ measurementType: 'DURATION', unit: 'hours', direction: 'TARGET_RANGE' }, { min: 2, max: 4 }, 'between 2 and 4 hours', 'Between 2 and 4 hours — inside the range is met'],
      [{ measurementType: 'DURATION', unit: 'days', direction: 'EXACT' }, { value: 7 }, 'exactly 7 days', 'Exactly 7 days — no more, no less'],
      [{ measurementType: 'WEIGHT', unit: 'MT', direction: 'HIGHER_BETTER' }, { value: 2400 }, 'at least 2,400 MT', 'At least 2,400 MT — higher is better'],
      [{ measurementType: 'WEIGHT', unit: 'kg', direction: 'LOWER_BETTER' }, { value: 50 }, 'at most 50 kg', 'At most 50 kg — lower is better'],
      [{ measurementType: 'LENGTH', direction: 'HIGHER_BETTER' }, { value: 150000 }, 'at least 1,50,000 m', 'At least 1,50,000 m — higher is better'],
      [{ measurementType: 'LENGTH', direction: 'LOWER_BETTER' }, { value: 200 }, 'at most 200 m', 'At most 200 m — lower is better'],
      [{ measurementType: 'BOOLEAN' }, { done: true }, 'done', 'Done or not — met when it is done'],
      [{ measurementType: 'DATE' }, { date: '2026-11-30' }, 'done by 30 Nov 2026', 'Done by 30 Nov 2026'],
    ];
    const wrong = [];
    for (const [def, input, text, sentence] of cases) {
      const problems = [];
      const r = K.readTargetInput(input, def, problems);
      const eff = K.effectiveTarget(def, { spec: r.spec });
      const back = K.effectiveTarget(def, { operator: 'EQ', value: r.text });
      if (problems.length || r.text !== text || eff?.sentence !== sentence || J_(K.normaliseSpec(back)) !== J_(K.normaliseSpec(eff))) {
        wrong.push(`${def.measurementType}/${def.direction ?? '-'} ${J_(input)} -> ${r.text} | ${eff?.sentence} | back ${J_(K.normaliseSpec(back))} ${problems.join(';')}`);
      }
    }
    ok(wrong.length === 0, `${cases.length} cases — every measured-in × which-way: the text is written from the structure, the live sentence says it, and the text reads back to the same structure`, wrong.join(' || '));
    const vocab = K.targetVocabulary();
    ok(vocab.measures.map((m) => m.label).join('|') === 'Percentage|Number|Rupees|Time|Weight|Length|Done or not|Date / milestone'
      && vocab.directions.map((d) => `${d.mark} ${d.label}`).join('|') === '▲ Higher is better|▼ Lower is better|= Exactly|↔ Within a range',
    'the vocabulary: eight measured-in, four which-ways with their marks');
    const bad = [
      [{ measurementType: 'PERCENTAGE', direction: 'HIGHER_BETTER' }, { value: 'abc' }, /number/],
      [{ measurementType: 'PERCENTAGE', direction: 'HIGHER_BETTER' }, { value: 1500 }, /between 0 and 1000/],
      [{ measurementType: 'CURRENCY', direction: 'TARGET_RANGE' }, { min: 12, max: 10 }, /above the lowest/],
      [{ measurementType: 'CURRENCY', direction: 'TARGET_RANGE' }, { min: 12 }, /lowest and its highest/],
      [{ measurementType: 'DATE' }, { date: '2026-02-30' }, /date it is due/],
      [null, { value: 5 }, /which way is better/],
    ];
    const notRefused = bad.filter(([def, input, re]) => { const p = []; K.readTargetInput(input, def, p); return !re.test(p.join(' ')); });
    ok(notRefused.length === 0, `${bad.length} bad targets are refused in words (not a number, a percentage over 1000, a range upside down or half given, no such day, no which-way)`, notRefused.map((b) => J_(b[1])).join(' '));
    ok(K.readTargetInput({ value: 5, direction: 'LOWER_BETTER', unit: 'hours' }, null, []).text === 'at most 5 hours', 'a KPI that does not say: the which-way and the unit come with the input');
  }

  /* ══ 2. free text ═════════════════════════════════════════════════════════ */
  section('[2] Free text still works');
  {
    const read = (text, def = null, name = '') => K.normaliseSpec(K.readTargetText(text, { def, name }));
    ok(J_(read('Max 30 minutes')) === J_({ measure: 'DURATION', unit: 'minutes', direction: 'LOWER_BETTER', value: 30 }), '"Max 30 minutes" reads as Time, lower, 30 minutes');
    ok(read('10-12%')?.direction === 'TARGET_RANGE' && read('10-12%').min === 10 && read('between ₹10 L and ₹12 L')?.min === 1000000 && read('₹10-12 Cr')?.max === 120000000,
      'ranges read: "10-12%", "between ₹10 L and ₹12 L", "₹10-12 Cr"');
    ok(read('by 30 Nov 2026')?.date === '2026-11-30' && read("Achieve by Nov'26")?.date === '2026-11-30' && read('30/11/2026')?.date === '2026-11-30', 'dates read: "by 30 Nov 2026", "Achieve by Nov\'26" (the month\'s last day), "30/11/2026"');
    ok(read('1.5%', null, 'Trim Wastage %')?.direction === 'LOWER_BETTER' && read('1.5%', { measurementType: 'PERCENTAGE', direction: 'HIGHER_BETTER' }, 'Trim Wastage %')?.direction === 'HIGHER_BETTER',
      'the definition\'s which-way wins over the guess from the KPI\'s name');
    ok(read('Max 30 minutes', { measurementType: 'DURATION', unit: 'minutes', direction: 'HIGHER_BETTER' }) === null && read('30 minutes', { measurementType: 'PERCENTAGE' }) === null && read('95%', { measurementType: 'DURATION', unit: 'minutes' }) === null,
      'text that contradicts its KPI (an explicit "max" on a higher-is-better KPI, minutes for a percentage) stays words — never bent to fit');
    ok(read('2400 cylinders', { measurementType: 'NUMBER', unit: 'cylinders' })?.value === 2400 && read('anything at all', { measurementType: 'BOOLEAN' })?.measure === 'BOOLEAN', 'a Number KPI\'s own label reads; a Done-or-not KPI takes its words as what is to be done');
    const words = ['100% adoption by end of Nov\'26', '1) 100% compliance by Dec\'26 2) One full internal audit', 'Max 3 instances allowed in a month', '90% compliance against all the sales order', 'Roll out by Nov\'26', ''];
    ok(words.every((w) => read(w) === null), `${words.length} targets that are words stay words`, words.filter((w) => read(w) !== null).join(' | '));
    const p = [];
    const kept = K.readTargetInput({ text: '  Max 30   minutes ' }, null, p);
    ok(kept.text === 'Max 30 minutes' && kept.spec?.value === 30 && !p.length, 'free text is kept as typed (spaces tidied), its structure filled');
    const zero = K.effectiveTarget(null, { operator: 'EQ', value: 0, name: 'Customer complaints' });
    ok(zero?.direction === 'LOWER_BETTER' && zero.value === 0 && K.textOfTarget('EQ', 0) === '0' && K.effectiveTarget(null, { operator: 'EQ', value: 0, name: 'Something' })?.direction === 'EXACT',
      'a "0" stored as words (it decodes to a number) reads like the text "0": lower for "complaints", else exactly');
  }

  /* ══ 3. range and date scoring ════════════════════════════════════════════ */
  section('[3] Ranges and dates score');
  {
    ok(rangeAchievement(11, 10, 12) === 100 && rangeAchievement(10, 10, 12) === 100 && rangeAchievement(12, 10, 12) === 100, 'inside the range (its ends included): 100');
    ok(rangeAchievement(9, 10, 12) === 90 && rangeAchievement(15, 10, 12) === 80 && rangeAchievement(0, 10, 12) === 0 && rangeAchievement(5, 0, 2) === 40,
      'outside, by distance from the nearer end: 9 for 10–12 is 90 (9 ÷ 10); 15 is 80 (12 ÷ 15)');
    const r1 = kpiResult({ direction: 'TARGET_RANGE', targetNumber: 10, targetMax: 12, unit: '%', combine: 'AVERAGE' }, [{ slotStart: '2026-10-01', valueNumber: 13 }]);
    ok(r1.achievement === 92.3 && r1.gapText === '1 pt above the range' && r1.gap === -1, 'a range KPI: 13% for 10–12% is 92.3, "1 pt above the range"', J_(r1));
    const r2 = kpiResult({ direction: 'TARGET_RANGE', targetNumber: 3000, targetMax: 3600, unit: 'MT', combine: 'SUM', slotCount: 3, entryFrequency: 'MONTHLY' }, [{ slotStart: '2026-10-01', valueNumber: 1100 }]);
    ok(r2.achievement === 100 && r2.combinedTarget === 1000 && r2.combinedTargetMax === 1200 && r2.pace === 'ON_PACE' && /1,000 MT – 1,200 MT/.test(r2.paceNote), 'a SUM range part-way through: both ends pro-rated (1 of 3 months: 1,000–1,200 MT)', J_(r2));
    ok(gapOf('TARGET_RANGE', 11, 10, '%', 12).gapText === 'within the range', 'inside the range says so');
    const early = kpiResult({ direction: 'DATE', targetDate: '2026-11-30' }, [{ slotStart: '2026-10-01', valueText: '2026-11-27' }]);
    const late = kpiResult({ direction: 'DATE', targetDate: '2026-11-30' }, [{ slotStart: '2026-10-01', valueText: '2026-12-02' }]);
    const onDay = kpiResult({ direction: 'DATE', targetDate: '2026-11-30' }, [{ slotStart: '2026-10-01', valueText: '2026-11-30' }]);
    const none = kpiResult({ direction: 'DATE', targetDate: '2026-11-30' }, []);
    ok(early.achievement === 100 && early.gapText === 'done 3 days early' && late.achievement === 0 && late.gapText === 'done 2 days late' && onDay.achievement === 100 && onDay.gapText === 'done on the day' && none.achievement === null,
      'a date KPI: met when done on or before the date (early, on the day), not met after it; not done yet is not counted');
  }

  /* ══ fixture ══════════════════════════════════════════════════════════════ */
  const settings = await readSettings(db, COMPANY);
  const Q = periodFor('QUARTERLY', settings.yearStartMonth, T);
  const D0 = shift(Q.start, -60);
  const D = await ins("INSERT INTO hrms_departments (company_id, code, name, department_type) VALUES (?, ?, ?, 'Department')", [COMPANY, `${TAG}D`, `${TAG} Dept`]);
  const roleOf = async (code) => ins("INSERT INTO hrms_roles (company_id, role_code, title, role_purpose, status, performance_frequency) VALUES (?, ?, ?, 'For a test.', 'ACTIVE', 'QUARTERLY')", [COMPANY, `${TAG}${code}`, `${TAG} Role ${code}`]);
  const R = await roleOf('R');
  const R2 = await roleOf('R2');
  const P = await ins("INSERT INTO hrms_positions (company_id, position_code, role_id, position_title, department_id, status) VALUES (?, ?, ?, ?, ?, 'ACTIVE')", [COMPANY, `${TAG}-P`, R, `${TAG} P`, D]);
  const E = await ins("INSERT INTO hrms_employees (company_id, employee_code, full_name, date_of_joining, employment_type, employment_status) VALUES (?, ?, ?, ?, 'EMPLOYEE', 'ACTIVE')", [COMPANY, `${TAG}E`, `${TAG} Person`, D0]);
  const WA = await ins("INSERT INTO hrms_work_assignments (company_id, employee_id, role_id, position_id, department_id, is_primary, status, effective_from) VALUES (?, ?, ?, ?, ?, 1, 'ACTIVE', ?)", [COMPANY, E, R, P, D, D0]);
  const kra = await J.createRoleKra(db, hr, R, { name: `${TAG} Results` });
  const def = async (name, extra = {}) => (await RC.createMasterItem(db, hr, 'kpis', { name: `${TAG} ${name}`, status: 'ACTIVE', ...extra })).id;
  const DEF = {
    plan: await def('Plan achievement', { measurementType: 'PERCENTAGE', direction: 'HIGHER_BETTER' }),
    scrap: await def('Scrap', { measurementType: 'PERCENTAGE', direction: 'HIGHER_BETTER' }),   // the name says "lower"; the definition says higher
    collections: await def('Collections', { measurementType: 'CURRENCY', direction: 'TARGET_RANGE' }),
    audit: await def('Audit closed', { measurementType: 'DATE' }),
    walk: await def('Safety walk', { measurementType: 'BOOLEAN' }),
    changeover: await def('Changeover'),
    words: await def('Readiness'),
  };
  const line = async (defId, target, role = R) => RC.addContent(db, hr, role, 'kpis', { kpiDefinitionId: defId, roleKraAssignmentId: role === R ? kra.id : null, target });

  /* ══ 4. role lines ════════════════════════════════════════════════════════ */
  section('[4] Role lines: the text written from the structure, the resolver reads it');
  const L = {};
  {
    const defRow = await one('SELECT measurement_type, unit, direction FROM hrms_kpi_definitions WHERE id = ?', [DEF.plan]);
    const notSet = await one('SELECT measurement_type, unit, direction FROM hrms_kpi_definitions WHERE id = ?', [DEF.words]);
    ok(defRow.measurement_type === 'PERCENTAGE' && defRow.unit === '%' && defRow.direction === 'HIGHER_BETTER' && notSet.measurement_type === 'TEXT' && notSet.direction === null,
      'a library KPI keeps measured in (with its unit) and which way; one made without them is "not set" (TEXT / none)');
    const dur = await caught(() => RC.createMasterItem(db, hr, 'kpis', { name: `${TAG} Bad unit`, measurementType: 'DURATION', unit: 'litres' }));
    ok(dur?.code === 'INVALID' && /minutes or hours or days/.test([dur.message, ...(dur.problems ?? [])].join(' ')), 'a Time KPI is counted in minutes, hours or days — anything else is refused', J_(dur?.problems ?? dur?.message));
    L.plan = await line(DEF.plan, { value: 95 });
    L.scrap = await line(DEF.scrap, { text: '2%' });
    L.collections = await line(DEF.collections, { min: 1000000, max: 1200000 });
    L.audit = await line(DEF.audit, { date: '2026-11-30' });
    L.walk = await line(DEF.walk, { done: true });
    L.changeover = await line(DEF.changeover, { text: 'Max 30 minutes' });
    L.words = await line(DEF.words, { text: 'Ready before the audit season' });
    const row = await one('SELECT target_operator, target_value, target_json FROM hrms_role_kpi_assignments WHERE id = ?', [L.plan.id]);
    ok(row.target_operator === 'EQ' && readJson(row.target_value) === 'at least 95%' && J_(K.normaliseSpec(readJson(row.target_json))) === J_({ measure: 'PERCENTAGE', unit: '%', direction: 'HIGHER_BETTER', value: 95 }),
      'a structured target stores its text (operator EQ, "at least 95%") and its structure (target_json)', J_(row));
    const job = await resolveContent(db, COMPANY, { roleId: R });
    const items = job.kras.flatMap((k) => k.kpis);
    const by = (id) => items.find((i) => Number(i.definitionId) === Number(id));
    ok(by(DEF.plan).targetText === 'at least 95%' && by(DEF.collections).targetText === 'between ₹10 L and ₹12 L' && by(DEF.audit).targetText === 'done by 30 Nov 2026'
      && by(DEF.walk).targetText === 'done' && by(DEF.changeover).targetText === 'Max 30 minutes' && by(DEF.words).targetText === 'Ready before the audit season',
    'the resolver\'s text (what the JD, Ask, Excel and the command bar print) is the stored text — written from the structure, or as typed');
    ok(by(DEF.plan).structured?.sentence === 'At least 95% — higher is better' && by(DEF.scrap).structured?.direction === 'HIGHER_BETTER' && by(DEF.collections).structured?.max === 1200000
      && by(DEF.audit).structured?.date === '2026-11-30' && by(DEF.walk).structured?.measure === 'BOOLEAN' && by(DEF.changeover).structured?.direction === 'LOWER_BETTER' && by(DEF.words).structured === null,
    'each line carries `structured` — the definition\'s which-way over the guess (Scrap stays higher), and words stay null');
    ok(/at least 95%/.test(by(DEF.plan).text ?? '') && /between ₹10 L and ₹12 L/.test(by(DEF.collections).text ?? ''), 'the JD line prints the text', by(DEF.plan).text);
    const badRole = await caught(() => line(DEF.audit, { date: 'soon' }, R2));
    ok(badRole?.code === 'INVALID', 'a bad structured target on a role line is refused', badRole?.message);
    const legacy = await RC.addContent(db, hr, R2, 'kpis', { kpiDefinitionId: DEF.plan, targetOperator: 'EQ', targetValue: '97%' });
    const lrow = await one('SELECT target_value, target_json FROM hrms_role_kpi_assignments WHERE id = ?', [legacy.id]);
    ok(readJson(lrow.target_value) === '97%' && readJson(lrow.target_json)?.value === 97, 'the older form (operator EQ + words) still works on a structured KPI, and its structure is filled');
    const shaped = (await RC.getRoleContent(db, COMPANY, R)).kras?.[0]?.kpis?.find?.((k) => Number(k.kpiDefinitionId ?? k.definitionId) === Number(DEF.collections));
    if (shaped) ok(shaped.targetSpec?.min === 1000000, 'the role content read carries the line\'s targetSpec');
    const jc = await J.positionJobContent(db, COMPANY, P);
    const pl = kpisOf(jc).find((k) => Number(k.definitionId) === Number(DEF.collections));
    ok(pl?.structured?.sentence === 'Between ₹10 L and ₹12 L — inside the range is met' && pl.direction === 'TARGET_RANGE' && pl.measurementType === 'CURRENCY',
      'the position\'s job content line carries the structure, the sentence and the KPI\'s rule (what the editor shows)', J_(pl?.structured));
  }
  // Every role line from before the period, so a plan copied as on its start carries them.
  await db.query('UPDATE hrms_role_kra_assignments SET effective_from = ? WHERE company_id = ? AND role_id IN (?)', [D0, COMPANY, [R, R2]]);
  await db.query('UPDATE hrms_role_kpi_assignments SET effective_from = ? WHERE company_id = ? AND role_id IN (?)', [D0, COMPANY, [R, R2]]);

  /* ══ 5. plans ═════════════════════════════════════════════════════════════ */
  section('[5] Plans copy the structured target, and score it');
  let planId = null;
  {
    const made = await PLAN.createPlans(db, hr, { frequency: 'QUARTERLY', start: Q.start, employeeIds: [E] });
    planId = made.plans?.[0]?.id;
    const p = await PLAN.readPlan(db, COMPANY, planId, { edit: true });
    const all = [...p.kras.flatMap((k) => k.kpis), ...p.ungroupedKpis];
    const k = (n) => all.find((x) => x.name === `${TAG} ${n}`);
    ok(k('Plan achievement')?.direction === 'HIGHER_BETTER' && k('Plan achievement').targetNumber === 95 && k('Plan achievement').unit === '%' && k('Plan achievement').job?.target === 'at least 95%',
      'a number: direction, number and unit copied; "what the job says" is its text', J_(k('Plan achievement')));
    ok(k('Scrap')?.direction === 'HIGHER_BETTER' && k('Scrap').targetNumber === 2, 'the definition\'s which-way reaches the plan (Scrap: higher, though its name says lower)', J_(k('Scrap')));
    ok(k('Collections')?.direction === 'TARGET_RANGE' && k('Collections').targetNumber === 1000000 && k('Collections').targetMax === 1200000 && k('Collections').unit === '₹'
      && k('Collections').target === 'between ₹10 L and ₹12 L' && k('Collections').targetShort === '₹10 L – ₹12 L', 'a range: its lowest and highest copied', J_(k('Collections')));
    ok(k('Audit closed')?.direction === 'DATE' && k('Audit closed').targetDate === '2026-11-30' && k('Audit closed').target === 'done by 30 Nov 2026', 'a date: copied as DATE with its day', J_(k('Audit closed')));
    ok(k('Safety walk')?.direction === 'TEXT' && k('Safety walk').targetText === 'done', 'done or not: met / not met (TEXT)', J_(k('Safety walk')));
    ok(k('Changeover')?.direction === 'LOWER_BETTER' && k('Changeover').targetNumber === 30 && k('Changeover').unit === 'minutes' && k('Readiness')?.direction === 'TEXT' && k('Readiness').targetText === 'Ready before the audit season',
      'free text read into a number is copied as one; words stay words');
    ok(made.kpis.targetsAsNumbers === 6 && made.kpis.targetsAsWords === 1, `the create counts: ${made.kpis.targetsAsNumbers} structured, ${made.kpis.targetsAsWords} as words`, J_(made.kpis));

    await PLAN.activatePlan(db, hr, planId);
    const slot = Q.start;
    await ACT.enterActuals(db, hr, [
      { planId, kpiId: k('Collections').id, slotStart: slot, value: 1300000 },
      { planId, kpiId: k('Audit closed').id, slotStart: slot, value: T },
      { planId, kpiId: k('Changeover').id, slotStart: slot, value: 40 },
    ]);
    const futureDay = await caught(() => ACT.enterActuals(db, hr, [{ planId, kpiId: k('Audit closed').id, slotStart: slot, value: shift(T, 3), reason: 'x' }]));
    const notDay = await caught(() => ACT.enterActuals(db, hr, [{ planId, kpiId: k('Audit closed').id, slotStart: slot, value: '1', reason: 'x' }]));
    const metOnDate = await caught(() => ACT.enterActuals(db, hr, [{ planId, kpiId: k('Audit closed').id, slotStart: slot, met: 'YES' }]));
    ok(futureDay?.code === 'INVALID' && notDay?.code === 'INVALID' && metOnDate?.code === 'INVALID', 'a date KPI takes a real day that has come — not a later day, not "1", not Met', `${futureDay?.message} | ${notDay?.message} | ${metOnDate?.message}`);
    const p2 = await PLAN.readPlan(db, COMPANY, planId, { edit: true });
    const all2 = [...p2.kras.flatMap((x) => x.kpis), ...p2.ungroupedKpis];
    const a = (n) => all2.find((x) => x.name === `${TAG} ${n}`)?.actuals;
    ok(a('Collections').achievement === 92.3 && a('Collections').gapText === '₹1 L above the range', 'the plan page: ₹13 L for ₹10–12 L scores 92.3, "₹1 L above the range"', J_(a('Collections')));
    ok(a('Audit closed').achievement === 100 && /early|on the day/.test(a('Audit closed').gapText ?? ''), 'done today, before 30 Nov: met', J_(a('Audit closed')));
    ok(a('Changeover').achievement === 75 && a('Changeover').gapText === '10 minutes over', '40 minutes for "at most 30": 75, "10 minutes over"', J_(a('Changeover')));
    const card = await PLAN.scorecardOf(db, COMPANY, E, { on: T });
    const row = card.kpis.find((x) => x.name === `${TAG} Collections`);
    ok(card.source === 'PLAN' && row?.direction === 'TARGET_RANGE' && row.targetShort === '₹10 L – ₹12 L' && row.tone === 'CLOSE', 'the scorecard row: ↔ range, its short target, coloured "close"', J_(row));

    const ch = await PLAN.changeTarget(db, hr, planId, k('Collections').id, { direction: 'TARGET_RANGE', targetNumber: 1100000, targetMax: 1400000, reason: 'Budget revised' });
    const tc = await one('SELECT from_number, from_max, to_number, to_max FROM hrms_performance_target_changes WHERE plan_kpi_id = ? ORDER BY id DESC LIMIT 1', [k('Collections').id]);
    const p3 = await PLAN.readPlan(db, COMPANY, planId, { edit: true });
    const c3 = [...p3.kras.flatMap((x) => x.kpis), ...p3.ungroupedKpis].find((x) => x.name === `${TAG} Collections`);
    ok(ch.ok && Number(tc.from_max) === 1200000 && Number(tc.to_max) === 1400000 && c3.targetChanges[0]?.to === 'between ₹11 L and ₹14 L' && c3.actuals.achievement === 100,
      'a dated target change on an active plan keeps the range (from ₹10–12 L to ₹11–14 L); ₹13 L is now inside', J_(c3?.targetChanges));
    const badRange = await caught(() => PLAN.changeTarget(db, hr, planId, k('Collections').id, { direction: 'TARGET_RANGE', targetNumber: 5, targetMax: 4, reason: 'x' }));
    ok(badRange?.code === 'INVALID', 'a range upside down is refused on a plan too', badRange?.message);
  }

  /* ══ 6. inheritance ═══════════════════════════════════════════════════════ */
  section('[6] The library KPI decides — every role, position and person using it follows');
  {
    await J.seatChangeLine(db, hr, P, { kind: 'KPI', definitionId: DEF.plan, target: { value: 90 } });
    await J.personChangeLine(db, hr, E, { kind: 'KPI', definitionId: DEF.plan, target: { text: '92%' } });
    const posLine = kpisOf(await J.positionJobContent(db, COMPANY, P)).find((x) => Number(x.definitionId) === Number(DEF.plan));
    const perLine = kpisOf(await J.employeeJobContent(db, COMPANY, E)).find((x) => Number(x.definitionId) === Number(DEF.plan));
    ok(posLine?.targetText === 'at least 90%' && posLine.structured?.value === 90 && posLine.mark === 'CHANGED' && perLine?.targetText === '92%' && perLine.structured?.value === 92,
      'a position\'s target (structured: "at least 90%") and a person\'s (typed: "92%") are their own lines, structured', `${J_(posLine?.structured)} ${J_(perLine?.structured)}`);
    await RC.updateMasterItem(db, hr, 'kpis', DEF.plan, { direction: 'LOWER_BETTER' });
    const role = (await resolveContent(db, COMPANY, { roleId: R })).kras.flatMap((x) => x.kpis).find((x) => Number(x.definitionId) === Number(DEF.plan));
    const pos2 = kpisOf(await J.positionJobContent(db, COMPANY, P)).find((x) => Number(x.definitionId) === Number(DEF.plan));
    const per2 = kpisOf(await J.employeeJobContent(db, COMPANY, E)).find((x) => Number(x.definitionId) === Number(DEF.plan));
    ok(role.structured?.direction === 'LOWER_BETTER' && pos2.structured?.direction === 'LOWER_BETTER' && per2.structured?.direction === 'LOWER_BETTER'
      && role.structured.value === 95 && pos2.structured.value === 90 && per2.structured.value === 92,
    'the KPI set to "lower is better": role, position and person lines all follow, each keeping its own number');
    const jobT = planTargetOf(per2.structured ? { ...per2, targetOperator: 'EQ', structured: per2.structured } : per2);
    ok(jobT.direction === 'LOWER_BETTER' && jobT.targetNumber === 92, 'and a plan made now would copy it so');
    await RC.updateMasterItem(db, hr, 'kpis', DEF.plan, { measurementType: null, direction: null });
    const free = (await resolveContent(db, COMPANY, { roleId: R })).kras.flatMap((x) => x.kpis).find((x) => Number(x.definitionId) === Number(DEF.plan));
    ok(free.structured?.direction === 'HIGHER_BETTER' && free.structured.measure === 'PERCENTAGE' && free.measurementType === 'TEXT',
      'measured in and which way cleared: the line keeps what it stored (at least 95%) — a KPI without them behaves as before');
  }

  /* ══ 7. dated rules ═══════════════════════════════════════════════════════ */
  section('[7] The dated rules are unchanged');
  {
    const later = shift(T, 10);
    const res = await RC.updateContent(db, hr, 'kpis', L.collections.id, { target: { min: 1100000, max: 1300000 }, takesEffect: later });
    const today = (await resolveContent(db, COMPANY, { roleId: R, on: T })).kras.flatMap((x) => x.kpis).find((x) => Number(x.definitionId) === Number(DEF.collections));
    const then = (await resolveContent(db, COMPANY, { roleId: R, on: later })).kras.flatMap((x) => x.kpis).find((x) => Number(x.definitionId) === Number(DEF.collections));
    ok(res.supersededId === L.collections.id && today.targetText === 'between ₹10 L and ₹12 L' && then.targetText === 'between ₹11 L and ₹13 L' && then.structured.min === 1100000 && then.changedFrom?.target === 'between ₹10 L and ₹12 L',
      `a role target change takes effect on ${later}: the old version holds until then, the new one says what it replaced`, J_({ today: today.targetText, then: then.targetText, from: then.changedFrom }));
    const hist = await roleJobHistory(db, COMPANY, R);
    const h = (hist.items ?? hist.events ?? hist).find?.((x) => x.what === 'TARGET_CHANGED' && /₹11 L/.test(String(x.to ?? '')));
    ok(Boolean(h), 'history: TARGET_CHANGED, from / to in the stored text', J_(h));
    const past = await caught(() => RC.updateContent(db, hr, 'kpis', res.id, { target: { min: 1, max: 2 }, takesEffect: shift(T, -5) }));
    const noReason = await caught(() => RC.updateContent(db, OWNERC, 'kpis', res.id, { target: { min: 1, max: 2 }, takesEffect: shift(T, -5) }));
    ok(past?.code === 'PAST_DATE' && noReason?.code === 'REASON_NEEDED', 'a day that has passed: refused (only the Owner, and with a reason)', `${past?.code} ${noReason?.code}`);
    const ownerPast = await RC.updateContent(db, OWNERC, 'kpis', L.audit.id, { target: { date: '2026-12-15' }, takesEffect: shift(T, -1), reason: 'Agreed last week' });
    ok(ownerPast.effectiveFrom === shift(T, -1) || ownerPast.supersededOn === shift(T, -2), 'the Owner may date it in the past, with a reason', J_({ from: ownerPast.effectiveFrom, sup: ownerPast.supersededOn }));
    const personPast = await caught(() => J.personChangeLine(db, hr, E, { kind: 'KPI', definitionId: DEF.changeover, target: { text: 'Max 25 minutes' }, takesEffect: shift(T, -3) }));
    ok(personPast?.code === 'PAST_DATE', 'a person\'s target dated in the past by HR: refused', personPast?.code);
    await J.personChangeLine(db, hr, E, { kind: 'KPI', definitionId: DEF.changeover, target: { value: 25, direction: 'LOWER_BETTER', unit: 'minutes' }, takesEffect: later });
    const now = kpisOf(await J.employeeJobContent(db, COMPANY, E, { on: T })).find((x) => Number(x.definitionId) === Number(DEF.changeover));
    const fut = kpisOf(await J.employeeJobContent(db, COMPANY, E, { on: later })).find((x) => Number(x.definitionId) === Number(DEF.changeover));
    ok(now.targetText === 'Max 30 minutes' && fut.targetText === 'at most 25 minutes' && fut.structured?.value === 25,
      `a person's structured change "Takes effect" ${later}: today still the role's words, from then "at most 25 minutes"`, `${now.targetText} / ${fut.targetText}`);
  }

  /* ══ 8. the move script ═══════════════════════════════════════════════════ */
  section('[8] The move script: dry run = apply, idempotent, the text never changes');
  {
    const plain = async (name) => (await RC.createMasterItem(db, hr, 'kpis', { name: `${TAG} ${name}`, measurementType: 'TEXT', status: 'ACTIVE' })).id;
    const MV = { agree: await plain('Mv Yield'), clash: await plain('Mv Clash'), words: await plain('Mv Words') };
    const R3 = await roleOf('R3');
    const raw = async (role, defId, text) => ins(
      "INSERT INTO hrms_role_kpi_assignments (company_id, role_id, kpi_definition_id, target_operator, target_value, sequence, effective_from, line_key) VALUES (?, ?, ?, 'EQ', ?, 1, ?, ?)",
      [COMPANY, role, defId, JSON.stringify(text), D0, `${TAG}-${role}-${defId}`]);
    const ids = {
      a1: await raw(R2, MV.agree, '95%'), a2: await raw(R3, MV.agree, '98% compliance'),
      c1: await raw(R2, MV.clash, '95%'), c2: await raw(R3, MV.clash, '30 minutes'),
      w1: await raw(R2, MV.words, '1) 100% compliance by Dec\'26 2) audit'),
    };
    const ov = await ins(
      "INSERT INTO hrms_position_content_overrides (company_id, position_id, content_type, kpi_definition_id, action, override_json, effective_from) VALUES (?, ?, 'KPI', ?, 'OVERRIDE', ?, ?)",
      [COMPANY, P, DEF.changeover, JSON.stringify({ targetOperator: 'EQ', targetValue: 'under 45 minutes' }), D0]);
    const plan = await planMove(db, COMPANY);
    const d = (id) => plan.defs.find((x) => Number(x.id) === Number(id));
    const l = (table, id) => plan.lines.find((x) => x.table === table && Number(x.id) === Number(id));
    ok(d(MV.agree).set && d(MV.agree).after.measurementType === 'PERCENTAGE' && d(MV.agree).after.direction === 'HIGHER_BETTER' && d(MV.agree).read === 2,
      'a KPI whose lines agree ("95%", "98% compliance") gets Percentage, higher');
    ok(!d(MV.clash).set && /measured in/.test(d(MV.clash).conflict ?? ''), 'a KPI whose lines disagree (a percentage and minutes) is a conflict: nothing set', d(MV.clash).conflict);
    ok(l('hrms_role_kpi_assignments', ids.c2)?.spec?.measure === 'DURATION' && l('hrms_role_kpi_assignments', ids.c1)?.spec?.measure === 'PERCENTAGE',
      '…but each of its lines still gets its own structure (the KPI says nothing, so each line keeps its own reading)');
    ok(l('hrms_role_kpi_assignments', ids.w1)?.spec === null && l('hrms_role_kpi_assignments', ids.w1)?.why === 'more than one target', 'a multi-target line stays words, and says why');
    ok(l('hrms_position_content_overrides', ov)?.spec?.value === 45, 'a position\'s target set the older way is structured too');
    const mine = (p) => ({
      defs: p.defs.filter((x) => Object.values(MV).includes(Number(x.id)) && x.set).map((x) => [x.id, x.after]),
      lines: p.lines.filter((x) => (x.table === 'hrms_role_kpi_assignments' && Object.values(ids).includes(Number(x.id))) || (x.table === 'hrms_position_content_overrides' && Number(x.id) === ov)).map((x) => [x.table, x.id, x.spec]),
    });
    const want = mine(plan);
    const textsBefore = await q('SELECT id, target_value FROM hrms_role_kpi_assignments WHERE id IN (?) ORDER BY id', [Object.values(ids)]);
    const auditsBefore = (await one('SELECT COUNT(*) AS n FROM hrms_audit_log WHERE company_id = ?', [COMPANY])).n;
    const rid = `structure-kpi-targets-test-${TAG}`;
    const done = await applyMove(db, COMPANY, plan, rid);
    const got = {
      defs: (await q('SELECT id, measurement_type, unit, direction FROM hrms_kpi_definitions WHERE id IN (?) ORDER BY id', [Object.values(MV)]))
        .filter((r) => r.measurement_type !== 'TEXT').map((r) => [r.id, { measurementType: r.measurement_type, unit: r.unit, direction: r.direction }]),
      lines: [
        ...(await q('SELECT id, target_json FROM hrms_role_kpi_assignments WHERE id IN (?) ORDER BY id', [Object.values(ids)])).filter((r) => r.target_json != null).map((r) => ['hrms_role_kpi_assignments', r.id, readJson(r.target_json)]),
        ...(await q('SELECT id, override_json FROM hrms_position_content_overrides WHERE id = ?', [ov])).filter((r) => readJson(r.override_json)?.targetSpec).map((r) => ['hrms_position_content_overrides', r.id, readJson(r.override_json).targetSpec]),
      ],
    };
    const norm = (x) => J_({ defs: [...x.defs].sort((a, b) => a[0] - b[0]), lines: x.lines.filter((y) => y[2]).map(([a, b, c]) => [a, b, K.normaliseSpec(c)]).sort((a, b) => `${a[0]}${a[1]}`.localeCompare(`${b[0]}${b[1]}`)) });
    const wantDefs = want.defs.map(([id, a]) => [id, { measurementType: a.measurementType, unit: a.unit ?? null, direction: a.direction ?? null }]);
    ok(norm({ defs: wantDefs, lines: want.lines }) === norm(got), 'what the dry run plans is exactly what --apply writes', `${norm({ defs: wantDefs, lines: want.lines })} vs ${norm(got)}`);
    const textsAfter = await q('SELECT id, target_value FROM hrms_role_kpi_assignments WHERE id IN (?) ORDER BY id', [Object.values(ids)]);
    ok(J_(textsBefore.map((r) => readJson(r.target_value))) === J_(textsAfter.map((r) => readJson(r.target_value))) && readJson((await one('SELECT override_json FROM hrms_position_content_overrides WHERE id = ?', [ov])).override_json).targetValue === 'under 45 minutes',
      'no text changed');
    const versions = await one('SELECT COUNT(*) AS n FROM hrms_role_kpi_assignments WHERE role_id IN (?)', [[R2, R3]]);
    ok(Number(versions.n) === Object.values(ids).length + 1, 'in place: no new dated versions were written', `${versions.n}`);
    const audits = await one('SELECT COUNT(*) AS n FROM hrms_audit_log WHERE company_id = ? AND request_id = ?', [COMPANY, rid]);
    ok(Number(audits.n) === done.audits && (await one('SELECT COUNT(*) AS n FROM hrms_audit_log WHERE company_id = ?', [COMPANY])).n - auditsBefore === done.audits && done.audits === plan.changes.defs + plan.changes.lines,
      `one audit row per change, with the run's request id (${done.audits})`);
    const again = await planMove(db, COMPANY);
    ok(again.changes.defs === 0 && again.changes.lines === 0, 'a second run finds nothing to do', J_(again.changes));
    const karni = await planMove(db, COMPANY);
    note(`company-wide, after this run: ${karni.lines.filter((x) => !x.spec).length} lines left as words (${[...new Set(karni.lines.filter((x) => !x.spec).map((x) => x.why))].join(', ')})`);
  }

  /* ══ 9. rights ════════════════════════════════════════════════════════════ */
  section('[9] Rights over HTTP');
  {
    await setupAccess(db, COMPANY, { apply: true });
    const roleByKey = Object.fromEntries((await q('SELECT role_id, template_key FROM hrms_access_roles WHERE company_id = ? AND deleted_at IS NULL AND template_key IS NOT NULL', [COMPANY])).map((r) => [r.template_key, r.role_id]));
    const login = async (label, roleId, employeeId = null) => {
      const email = `${TAG.toLowerCase()}.${label.toLowerCase().replace(/[^a-z0-9]/g, '')}@example.test`;
      const id = await ins('INSERT INTO users (name, email, password, role_id, team_id, company_id) VALUES (?, ?, ?, ?, NULL, ?)', [`${TAG} ${label}`, email, 'x', roleId, COMPANY]);
      await db.query('INSERT INTO app_user_access (user_id, app_id, role_id, company_id) VALUES (?, ?, ?, ?)', [id, app.id, roleId, COMPANY]);
      if (employeeId) await db.query('UPDATE hrms_employees SET user_id = ? WHERE id = ?', [id, employeeId]);
      const roleName = (await one('SELECT name FROM roles WHERE id = ?', [roleId])).name;
      return { id, token: signToken({ id, name: `${TAG} ${label}`, email, role: roleName, company: company.slug, companyId: COMPANY, company_id: COMPANY, uiPermissions: [] }) };
    };
    const O = { id: owner.id, token: signToken({ id: owner.id, name: owner.name, email: owner.email, role: 'admin', company: company.slug, companyId: COMPANY, company_id: COMPANY, uiPermissions: [] }) };
    const EMP = await login('Employee', roleByKey.EMPLOYEE, E);
    forgetAccess();
    server = express();
    server.use(express.json({ limit: '10mb' }));
    server.use(cookieParser());
    server.use('/api', appContext);
    hrmsApp.register(server);
    const listener = await new Promise((resolve) => { const l2 = server.listen(0, '127.0.0.1', () => resolve(l2)); });
    server.close = () => new Promise((resolve) => listener.close(resolve));
    const base = `http://127.0.0.1:${listener.address().port}/api`;
    const call = async (who, method, url, body) => {
      const res = await fetch(`${base}/${company.slug}/cf_hrms${url}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${who.token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
      let json = null;
      try { json = await res.json(); } catch { /* none */ }
      return { status: res.status, json };
    };
    const e1 = await call(EMP, 'PUT', `/role-masters/kpis/${DEF.walk}`, { measurementType: 'PERCENTAGE', direction: 'HIGHER_BETTER' });
    const e2 = await call(EMP, 'PUT', `/role-content/kpis/${L.walk.id}`, { target: { done: true } });
    const e3 = await call(EMP, 'POST', `/people/employees/${E}/job-content/change`, { kind: 'KPI', definitionId: DEF.walk, target: { text: 'x' } });
    ok(e1.status === 403 && e2.status === 403 && e3.status === 403, 'an Employee login cannot set a KPI\'s measured in, a role\'s target, or their own target', `${e1.status} ${e2.status} ${e3.status}`);
    const o1 = await call(O, 'PUT', `/role-masters/kpis/${DEF.words}`, { measurementType: 'WEIGHT', unit: 'MT', direction: 'HIGHER_BETTER' });
    const o2 = await call(O, 'POST', `/positions/${P}/job-content/change`, { kind: 'KPI', definitionId: DEF.walk, target: { done: true }, reason: 'test' });
    const o3 = await call(O, 'GET', '/meta');
    ok(o1.status === 200 && o1.json?.measurementType === 'WEIGHT' && o1.json.unit === 'MT' && o1.json.direction === 'HIGHER_BETTER', 'the Owner sets measured in (Weight, MT) and which way on a library KPI', J_(o1.json));
    ok(o2.status === 200, 'the Owner changes a position\'s target with a structured target', `${o2.status} ${J_(o2.json)?.slice(0, 200)}`);
    ok(o3.status === 200 && o3.json.kpiTargets?.measures?.length === 8 && o3.json.measurementTypes.includes('DATE') && o3.json.kpiDirections.includes('EXACT'), '/meta carries the vocabulary (8 measured-in, the new ENUM values)');
  }
} finally {
  if (server?.close) await server.close();
  try { await db.rollback(); } catch { /* nothing to undo */ }
  db.release();
  pool.query = real.query;
  pool.execute = real.execute;
  pool.getConnection = real.getConnection;
  forgetAccess();
}

section('[end] Nothing is left behind');
{
  const after = await worldCount();
  const moved = Object.keys(before).filter((k) => after[k] !== before[k]);
  ok(moved.length === 0, `every count is what it was (${TABLES.length} tables, every KPI definition and every line's structure)`, moved.map((k) => `${k} ${String(before[k]).slice(0, 40)} -> ${String(after[k]).slice(0, 40)}`).join('; '));
}

console.log(`\n${passed} passed, ${failed.length} failed, 0 skipped`);
if (failed.length) { console.log('\nFAILED:'); for (const f of failed) console.log(`  - ${f}`); }
await pool.end();
process.exit(failed.length ? 1 : 0);
