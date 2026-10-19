/**
 * demo-payroll.mjs — a LOCAL demo of payroll and income tax on Karni (TM/CF_HRMS_HIRING_SPEC.md §25.2, §25.4).
 *
 *   node apps/cf_hrms/scripts/demo-payroll.mjs [--company=karni]      make it
 *   node apps/cf_hrms/scripts/demo-payroll.mjs --clean                 remove exactly what it made (and put back what it changed)
 *
 * 1. payroll is set up (seed.js — components, "Staff standard", statutory rows), if it is not;
 * 2. JOINING DATES, DEMO ONLY: everybody whose joining date is the import's placeholder (30 Sep 2026)
 *    gets a sensible past date (2015–2025, by their id) so the months are not all prorated; the old
 *    date is kept in the audit row and --clean puts it back;
 * 3. every person without a salary gets one on "Staff standard" from 1 April 2026 (the tax year), with a
 *    PLAUSIBLE CTC FOR THEIR LEVEL (read from their position's title) — the reason says
 *    "DEMO — sample CTC, not real pay";
 * 4. income tax, DEMO: a few people get a DEMO PAN (DEMOP…), three choose the OLD regime with
 *    declarations (rent, PPF, LIC, health insurance, home-loan interest); the 2026-27 windows are set
 *    open now (declarations and proofs to 31 Oct 2026 / 31 Jan 2027, regime cut-off 31 Oct 2026) so a
 *    person can declare and upload a proof today;
 * 5. the payroll of April–September 2026 is calculated (TDS by the engine), locked and released; October
 *    2026 is created and CALCULATED, not locked — open it to see the month's TDS.
 *
 * Everything goes through the services the screens use, in one transaction, audited with request id
 * 'demo-payroll' — which is how --clean finds exactly what this made. It removes that outright (demo
 * data on a local database, not a record) and restores the joining dates.
 *
 * LOCAL ONLY: refuses --target=prod.
 */
import mysql from 'mysql2/promise';
import { resolveTarget, announce } from './dbTarget.mjs';
import { seedPayroll } from '../services/payroll/seed.js';
import { createSalary } from '../services/payroll/payrollService.js';
import { createRun, calculateRun, lockRun, releaseRun } from '../services/payroll/runService.js';
import { chooseRegime } from '../services/payrollTax/profiles.js';
import { addLine } from '../services/payrollTax/declarations.js';
import { putYearSettings } from '../services/payrollTax/settings.js';
import { loadTaxYear } from '../services/tax/index.js';
import { audit } from '../services/payrollTax/common.js';

const args = process.argv.slice(2);
const CLEAN = args.includes('--clean');
const slug = (args.find((a) => a.startsWith('--company=')) ?? '--company=karni').split('=')[1];
const MARK = 'demo-payroll';
const PLACEHOLDER_JOINING = '2026-09-30';
const LOCKED_MONTHS = ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09'];
const OPEN_MONTH = '2026-10';
const SALARY_FROM = '2026-04-01';
const REASON = 'DEMO — sample CTC, not real pay';
const YEAR = '2026-27';

/** A plausible yearly CTC by the words of a title (first match wins). Demo figures only. */
const LEVELS = [
  [/director\s*&\s*ceo|ceo/i, 3600000], [/^director/i, 3000000], [/\bagm\b|general manager/i, 1800000], [/senior manager/i, 1400000],
  [/deputy manager/i, 800000], [/manager/i, 1000000], [/senior executive/i, 600000], [/executive|associate|^officer/i, 450000],
  [/assistant incharge/i, 300000], [/incharge|supervisor/i, 360000], [/junior office/i, 264000], [/assistant operator/i, 180000], [/operator/i, 210000],
];
const ctcFor = (title, id) => {
  const base = LEVELS.find(([re]) => re.test(String(title ?? '')))?.[1] ?? 240000;
  // A little spread so not everyone of a level earns the same: +0..4%, to the thousand.
  return Math.round((base * (1 + (id % 5) / 100)) / 1000) * 1000;
};
/** A past joining date by id: 2015–2025, the 1st of a month. Demo only. */
const joiningFor = (id) => `${2015 + (id % 11)}-${String((id % 12) + 1).padStart(2, '0')}-01`;

/** Tax, DEMO: by employee code — a PAN or not, the regime, the declarations. */
const TAX_PEOPLE = {
  KP0001: { pan: true },
  KP0056: { pan: true, regime: 'OLD', lines: [['RENT', null, { monthlyRent: 60000, landlordName: 'DEMO landlord', landlordPan: 'DEMOL1001L' }], ['PPF', 150000], ['MEDICAL_SELF', 25000], ['HOME_LOAN_INTEREST', 200000, { lenderName: 'DEMO Bank', lenderType: 'BANK' }]] },
  KP0053: { pan: false },
  KP0002: { pan: true, regime: 'OLD', lines: [['RENT', null, { monthlyRent: 35000, landlordName: 'DEMO landlord', landlordPan: 'DEMOL1002L' }], ['PPF', 100000], ['LIC', 40000]] },
  KP0048: { pan: true },
  KP0050: { pan: true },
  KP0049: { pan: true },
  KP0034: { pan: true },
  KP0003: { pan: true },
  KP0052: { pan: true, regime: 'OLD', lines: [['ELSS', 150000], ['MEDICAL_PARENTS', 30000, { parentsSenior: true }]] },
};

async function make(db, c) {
  const seeded = await seedPayroll(db, c, MARK);
  console.log(`  setup: ${seeded.components.length} components, ${seeded.structure ? 'Staff standard' : 'structure there'}, ${seeded.statutory.length} statutory rows added`);

  // Joining dates (DEMO): the import's placeholder → a past date, the old one kept in the audit row.
  const [placeholders] = await db.query("SELECT id, date_of_joining FROM hrms_employees WHERE company_id = ? AND deleted_at IS NULL AND date_of_joining = ?", [c.companyId, PLACEHOLDER_JOINING]);
  for (const e of placeholders) {
    const d = joiningFor(e.id);
    await db.query('UPDATE hrms_employees SET date_of_joining = ? WHERE id = ?', [d, e.id]);
    await audit(db, c, 'hrms_employees', e.id, 'UPDATE', { date_of_joining: PLACEHOLDER_JOINING, demo: true }, { date_of_joining: d, demo: 'demo-payroll joining date' }, MARK);
  }
  console.log(`  joining dates: ${placeholders.length} people moved from ${PLACEHOLDER_JOINING} to a DEMO past date (2015–2025)`);

  const [[staff]] = await db.query("SELECT id FROM hrms_pay_structures WHERE company_id = ? AND code = 'STAFF_STD' AND deleted_at IS NULL", [c.companyId]);
  const [emps] = await db.query(
    `SELECT e.id, e.employee_code, e.full_name, (SELECT p.position_title FROM hrms_work_assignments wa JOIN hrms_positions p ON p.id = wa.position_id
        WHERE wa.company_id = e.company_id AND wa.employee_id = e.id AND wa.deleted_at IS NULL ORDER BY wa.is_primary DESC, wa.id LIMIT 1) AS title
       FROM hrms_employees e WHERE e.company_id = ? AND e.deleted_at IS NULL AND e.employment_status <> 'EXITED'
        AND NOT EXISTS (SELECT 1 FROM hrms_pay_salaries s WHERE s.company_id = e.company_id AND s.employee_id = e.id AND s.deleted_at IS NULL) ORDER BY e.id`, [c.companyId]);
  let total = 0;
  for (const e of emps) {
    const ctc = ctcFor(e.title, e.id);
    total += ctc;
    await createSalary(db, c, { employeeId: e.id, annualCtc: ctc, structureId: staff.id, effectiveFrom: SALARY_FROM, reason: REASON }, MARK);
  }
  console.log(`  salaries: ${emps.length} people given a DEMO salary from ${SALARY_FROM} (₹${(total / 100000).toFixed(1)} lakh a year in all)`);

  // Tax (DEMO): windows open now, PANs, regimes, declarations.
  await putYearSettings(db, c, YEAR, { declarationFrom: '2026-04-01', declarationTo: '2026-10-31', proofFrom: '2026-10-01', proofTo: '2027-01-31', regimeCutoff: '2026-10-31' }, MARK);
  const rules = await loadTaxYear(db, YEAR);
  const [people] = await db.query(`SELECT id, employee_code FROM hrms_employees WHERE company_id = ? AND deleted_at IS NULL AND employee_code IN (${Object.keys(TAX_PEOPLE).map(() => '?').join(',')})`, [c.companyId, ...Object.keys(TAX_PEOPLE)]);
  let pans = 0;
  let old = 0;
  let lines = 0;
  for (const p of people) {
    const t = TAX_PEOPLE[p.employee_code];
    if (t.pan) {
      const [[has]] = await db.query("SELECT id FROM hrms_employee_identifiers WHERE company_id = ? AND employee_id = ? AND identifier_type = 'PAN' AND deleted_at IS NULL", [c.companyId, p.id]);
      if (!has) {
        const pan = `DEMOP${String(1000 + (p.id % 9000)).padStart(4, '0')}D`;
        const [ins] = await db.query("INSERT INTO hrms_employee_identifiers (company_id, employee_id, identifier_type, identifier_value, created_by) VALUES (?, ?, 'PAN', ?, ?)", [c.companyId, p.id, pan, c.userId]);
        await audit(db, c, 'hrms_employee_identifiers', ins.insertId, 'CREATE', null, { employeeId: p.id, type: 'PAN', demo: true }, MARK);
        pans += 1;
      }
    }
    if (t.regime) { await chooseRegime(db, c, p.id, YEAR, { regime: t.regime, reason: 'DEMO — chose the old regime' }, { by: 'HR', requestId: MARK }); old += 1; }
    for (const [kind, amount, details] of t.lines ?? []) {
      await addLine(db, c, p.id, YEAR, { kind, amount, details: details ?? {} }, { rules, by: 'HR', requestId: MARK });
      lines += 1;
    }
  }
  console.log(`  tax: ${pans} DEMO PANs, ${old} people on the old regime, ${lines} declaration lines; ${YEAR} windows open (DEMO)`);

  for (const month of [...LOCKED_MONTHS, OPEN_MONTH]) {
    const [[had]] = await db.query('SELECT id FROM hrms_pay_runs WHERE company_id = ? AND period_month = ? AND deleted_at IS NULL', [c.companyId, month]);
    if (had) { console.log(`  the ${month} run exists already (#${had.id}) — left as it is`); continue; }
    const { run } = await createRun(db, c, { month, note: 'DEMO payroll — sample salaries' }, MARK);
    const calc = await calculateRun(db, c, run.id, MARK);
    const tds = calc.people.reduce((s, x) => s + x.tds, 0);
    if (month === OPEN_MONTH) { console.log(`  run ${month} (#${run.id}): ${calc.run.peopleCount} paid, TDS ₹${tds.toLocaleString('en-IN')} — CALCULATED, not locked`); continue; }
    await lockRun(db, c, run.id, MARK);
    const rel = await releaseRun(db, c, run.id, MARK);
    console.log(`  run ${month} (#${run.id}): ${calc.run.peopleCount} paid, net ₹${calc.run.net.toLocaleString('en-IN')}, TDS ₹${tds.toLocaleString('en-IN')}; locked; ${rel.released} payslips`);
  }
}

async function clean(db, companyId) {
  const [rows] = await db.query("SELECT entity_type, entity_id, action, before_json FROM hrms_audit_log WHERE company_id = ? AND request_id = ?", [companyId, MARK]);
  const ids = (t, action = 'CREATE') => rows.filter((r) => r.entity_type === t && r.action === action).map((r) => r.entity_id);
  const runs = ids('hrms_pay_runs');
  const salaries = ids('hrms_pay_salaries');
  if (runs.length) {
    await db.query('DELETE FROM hrms_pay_payslips WHERE company_id = ? AND run_id IN (?)', [companyId, runs]);
    await db.query('DELETE FROM hrms_pay_run_lines WHERE company_id = ? AND run_id IN (?)', [companyId, runs]);
    await db.query('DELETE FROM hrms_pay_run_people WHERE company_id = ? AND run_id IN (?)', [companyId, runs]);
    await db.query('DELETE FROM hrms_pay_items WHERE company_id = ? AND run_id IN (?)', [companyId, runs]);
    await db.query('DELETE FROM hrms_tax_tds_overrides WHERE company_id = ? AND run_id IN (?)', [companyId, runs]);
    await db.query('DELETE FROM hrms_pay_runs WHERE company_id = ? AND id IN (?)', [companyId, runs]);
    await db.query("DELETE FROM hrms_audit_log WHERE company_id = ? AND entity_type IN ('hrms_pay_runs') AND entity_id IN (?)", [companyId, runs]);
  }
  if (salaries.length) {
    await db.query('DELETE FROM hrms_pay_salaries WHERE company_id = ? AND id IN (?) AND reason = ?', [companyId, salaries, REASON]);
    await db.query("DELETE FROM hrms_audit_log WHERE company_id = ? AND entity_type = 'hrms_pay_salaries' AND entity_id IN (?)", [companyId, salaries]);
  }
  // Tax: the demo's declarations (and their files), profiles, PANs, the year's settings.
  const lines = ids('hrms_tax_declaration_lines');
  if (lines.length) {
    const [files] = await db.query('SELECT id FROM hrms_tax_files WHERE company_id = ? AND line_id IN (?)', [companyId, lines]);
    if (files.length) {
      await db.query('DELETE FROM hrms_tax_file_chunks WHERE company_id = ? AND file_id IN (?)', [companyId, files.map((f) => f.id)]);
      await db.query('DELETE FROM hrms_tax_files WHERE company_id = ? AND id IN (?)', [companyId, files.map((f) => f.id)]);
    }
    await db.query('DELETE FROM hrms_tax_declaration_lines WHERE company_id = ? AND id IN (?)', [companyId, lines]);
  }
  const profiles = [...new Set(rows.filter((r) => r.entity_type === 'hrms_tax_profiles').map((r) => r.entity_id))];
  if (profiles.length) await db.query('DELETE FROM hrms_tax_profiles WHERE company_id = ? AND id IN (?)', [companyId, profiles]);
  const pans = ids('hrms_employee_identifiers');
  if (pans.length) await db.query("DELETE FROM hrms_employee_identifiers WHERE company_id = ? AND id IN (?) AND identifier_value LIKE 'DEMOP%'", [companyId, pans]);
  const settings = [...new Set(rows.filter((r) => r.entity_type === 'hrms_tax_settings').map((r) => r.entity_id))];
  if (settings.length) await db.query('DELETE FROM hrms_tax_settings WHERE company_id = ? AND id IN (?)', [companyId, settings]);
  // Joining dates back.
  let restored = 0;
  for (const r of rows.filter((x) => x.entity_type === 'hrms_employees' && x.action === 'UPDATE')) {
    const b = typeof r.before_json === 'string' ? JSON.parse(r.before_json) : r.before_json;
    if (b?.demo && b.date_of_joining) { await db.query('UPDATE hrms_employees SET date_of_joining = ? WHERE company_id = ? AND id = ?', [b.date_of_joining, companyId, r.entity_id]); restored += 1; }
  }
  await db.query(`DELETE FROM hrms_audit_log WHERE company_id = ? AND request_id = ? AND entity_type IN ('hrms_pay_runs', 'hrms_pay_salaries', 'hrms_pay_salary_read', 'hrms_tax_declaration_lines', 'hrms_tax_profiles',
    'hrms_employee_identifiers', 'hrms_tax_settings', 'hrms_employees')`, [companyId, MARK]);
  console.log(`  removed: ${runs.length} run(s) with their people, lines and payslips; ${salaries.length} DEMO salaries; ${lines.length} declarations, ${profiles.length} tax profiles, ${pans.length} DEMO PANs, ${settings.length} tax-year settings. ${restored} joining dates put back. The payroll setup (components, structure, statutory rows) stays.`);
}

async function main() {
  // Refused before anything else: a production target is never even resolved.
  if (args.some((a) => a.startsWith('--target') || a === '--prod')) throw new Error('demo-payroll is LOCAL ONLY.');
  const target = resolveTarget();
  if (target.isProd) throw new Error('demo-payroll is LOCAL ONLY.');
  announce(target);
  const conn = await mysql.createConnection({ ...target.cfg, dateStrings: true });
  try {
    const [[company]] = await conn.query('SELECT id, name FROM companies WHERE slug = ? AND deleted_at IS NULL', [slug]);
    if (!company) throw new Error(`No company "${slug}".`);
    const [[owner]] = await conn.query("SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE u.company_id = ? AND u.deleted_at IS NULL AND LOWER(r.name) = 'admin' ORDER BY u.id LIMIT 1", [company.id]);
    console.log(`  company: ${company.name} (${company.id})${CLEAN ? '   CLEAN' : ''}\n`);
    await conn.beginTransaction();
    if (CLEAN) await clean(conn, company.id);
    else await make(conn, { companyId: company.id, userId: owner?.id ?? null, owner: true });
    await conn.commit();
    console.log('\n  done.\n');
  } catch (e) {
    try { await conn.rollback(); } catch { /* the first error matters */ }
    throw e;
  } finally {
    await conn.end();
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(`\n  FAILED: ${e.message}\n`); process.exit(1); });
