/**
 * seed.js — what a company starts payroll with (TM/CF_HRMS_HIRING_SPEC.md §25.2):
 * the ready-made components, one sample structure ("Staff standard") and the statutory
 * settings for Telangana from 2025-04-01 and 2026-04-01, EACH VALUE WITH ITS SOURCE.
 *
 * Read on 2026-10-19 from the official pages named in `source_url`. A value that could not
 * be confirmed on an official page is seeded `UNVERIFIED`, and the screen says so; HR (or
 * the company's CA) confirms it and ticks it VERIFIED. Nothing here is a rule of the code:
 * these are rows, and a change in the law is a new row from its date.
 *
 * `seedPayroll` is idempotent: what exists (by code, by kind + state + date) is left alone.
 */
import { audit } from './common.js';

export const READY_MADE_COMPONENTS = [
  // code, name, kind, taxable, exemption, pf, esi, gratuity, frequency, prorate, statutory
  ['BASIC', 'Basic', 'EARNING', 'YES', null, 1, 1, 1, 'MONTHLY', 1, null],
  ['DA', 'Dearness allowance', 'EARNING', 'YES', null, 1, 1, 1, 'MONTHLY', 1, null],
  ['HRA', 'House rent allowance', 'EARNING', 'PARTLY', 'HRA', 0, 1, 0, 'MONTHLY', 1, null],
  ['SPECIAL', 'Special allowance', 'EARNING', 'YES', null, 0, 1, 0, 'MONTHLY', 1, null],
  ['CONVEYANCE', 'Conveyance allowance', 'EARNING', 'PARTLY', 'CONVEYANCE', 0, 1, 0, 'MONTHLY', 1, null],
  ['MEDICAL', 'Medical allowance', 'EARNING', 'YES', null, 0, 1, 0, 'MONTHLY', 1, null],
  ['LTA', 'Leave travel allowance', 'EARNING', 'PARTLY', 'LTA', 0, 0, 0, 'YEARLY', 0, null],
  ['BONUS', 'Bonus', 'EARNING', 'YES', null, 0, 0, 0, 'YEARLY', 0, null],
  ['OVERTIME', 'Overtime', 'EARNING', 'YES', null, 0, 1, 0, 'MONTHLY', 0, null],
  ['ARREARS', 'Arrears', 'EARNING', 'YES', null, 0, 1, 0, 'MONTHLY', 0, 'ARREARS'],
  ['PF_EE', 'PF (employee)', 'DEDUCTION', 'NO', null, 0, 0, 0, 'MONTHLY', 0, 'PF_EE'],
  ['ESI_EE', 'ESI (employee)', 'DEDUCTION', 'NO', null, 0, 0, 0, 'MONTHLY', 0, 'ESI_EE'],
  ['PT', 'Professional tax', 'DEDUCTION', 'NO', null, 0, 0, 0, 'MONTHLY', 0, 'PT'],
  ['LWF_EE', 'LWF (employee)', 'DEDUCTION', 'NO', null, 0, 0, 0, 'MONTHLY', 0, 'LWF_EE'],
  ['TDS', 'TDS (income tax)', 'DEDUCTION', 'NO', null, 0, 0, 0, 'MONTHLY', 0, 'TDS'],
  ['LOAN', 'Loan recovery', 'DEDUCTION', 'NO', null, 0, 0, 0, 'MONTHLY', 0, null],
  ['OTHER_DED', 'Other deduction', 'DEDUCTION', 'NO', null, 0, 0, 0, 'MONTHLY', 0, null],
  ['PF_ER', 'PF (employer)', 'EMPLOYER_CONTRIBUTION', 'NO', null, 0, 0, 0, 'MONTHLY', 0, 'PF_ER'],
  ['ESI_ER', 'ESI (employer)', 'EMPLOYER_CONTRIBUTION', 'NO', null, 0, 0, 0, 'MONTHLY', 0, 'ESI_ER'],
  ['LWF_ER', 'LWF (employer)', 'EMPLOYER_CONTRIBUTION', 'NO', null, 0, 0, 0, 'MONTHLY', 0, 'LWF_ER'],
  // The employer's NPS contribution (spec §25.5): part of CTC, not paid out. Exemption rule NPS_80CCD2 tells
  // the tax side to count it in salary and deduct it under 80CCD(2) / s.124(1)–(2) up to the year's limit
  // (payrollTax/runTax.js). Put it in a structure with e.g. round(10% of BASIC), or round(14% of (BASIC + DA))
  // when the structure has DA — the limit is 14% of Basic + DA in the new regime, 10% in the old one.
  ['NPS_ER', 'NPS (employer)', 'EMPLOYER_CONTRIBUTION', 'YES', 'NPS_80CCD2', 0, 0, 0, 'MONTHLY', 1, null],
].map(([code, name, kind, taxable, exemptionRule, inPf, inEsi, inGratuity, frequency, prorate, statutoryKey], i) => ({
  code, name, kind, taxable, exemptionRule, inPfWage: inPf, inEsiWage: inEsi, inGratuityWage: inGratuity, frequency, prorateOnLop: prorate, statutoryKey, sortOrder: (i + 1) * 10,
}));

/** "Staff standard": Basic 40% of CTC, HRA half of Basic, fixed conveyance and medical, employer PF, special = balance. */
export const SAMPLE_STRUCTURE = {
  code: 'STAFF_STD',
  name: 'Staff standard',
  description: 'Basic 40% of CTC, HRA 50% of Basic, conveyance ₹1,600 and medical ₹1,250 a month, employer PF on Basic up to the PF ceiling in force, and the rest as special allowance. A sample: change it, or copy it for another grade.',
  lines: [
    ['BASIC', '40% of CTC'],
    ['HRA', '50% of BASIC'],
    ['CONVEYANCE', '1600'],
    ['MEDICAL', '1250'],
    ['PF_ER', 'round(12% of min(BASIC, PF_CEILING))'],
    ['SPECIAL', 'balance'],
  ],
};

const EPFO_SHEET = 'https://www.epfindia.gov.in/site_docs/PDFs/MiscPDFs/ContributionRate.pdf';
const EPF_SCHEME_2026 = 'https://egazette.gov.in/WriteReadData/2026/273957.pdf';
const PF_CEILING_25K = 'https://egazette.gov.in/WriteReadData/2026/276299.pdf';
const ESIC = 'https://www.esic.gov.in/contribution';
const SS_RULES_2026 = 'https://egazette.gov.in/WriteReadData/2026/272366.pdf';
const TG_PT = 'https://www.tgct.gov.in/tgportal/AllActs/APPT/APPTSchedule.aspx';
const TG_LWF = 'https://labour.telangana.gov.in/content/ActsRules/TELANGANA%20LABOUR%20WELFARE%20FUND%20ACT,%201987.htm';

const PF = (wageCeiling) => ({
  employeeRate: 12, employerRate: 12, epsRate: 8.33, wageCeiling, edliRate: 0.5, edliAdminRate: 0, adminRate: 0.5, adminMinimum: 500, adminMinimumNoMember: 75, rounding: 'NEAREST',
});
const ESI = { employeeRate: 0.75, employerRate: 3.25, wageCeiling: 21000, wageCeilingDisabled: 25000, exemptDailyWage: 176, periods: [{ from: '04-01', to: '09-30' }, { from: '10-01', to: '03-31' }], rounding: 'UP' };
const PT_TG = { slabs: [{ upTo: 15000, amount: 0 }, { upTo: 20000, amount: 150 }, { upTo: null, amount: 200 }], basis: 'GROSS', yearlyMaximum: 2500 };
const LWF_TG = { employee: 2, employer: 5, months: [12] };

/**
 * Statutory rows: kind, state, from, settings, verification, source (words), url, note.
 * PF and ESI are national ('IN'); professional tax and LWF are Telangana's ('TG').
 */
export const STATUTORY_ROWS = [
  ['PF', 'IN', '2025-04-01', PF(15000), 'VERIFIED',
    'EPFO contribution rate sheet: employee 12%; employer 12% = EPS 8.33% (on wages up to the ceiling) + EPF 3.67%; EDLI 0.5%; EPF admin 0.50% w.e.f. 01-06-2018 (min ₹500 a month, ₹75 with no contributing member); EDLI admin nil w.e.f. 01-04-2017; wage ceiling ₹15,000; each contribution rounded to the nearest rupee. Read on the archived official page (web.archive.org snapshot 2026-02-01).',
    EPFO_SHEET, 'Contribution above the ceiling is optional, by a joint request of the employee and the employer (pf_mode FULL on the salary). A new joiner above the ceiling is an excluded employee (pf_mode NONE).'],
  ['PF', 'IN', '2026-04-01', PF(15000), 'VERIFIED',
    'Unchanged from 2025-04-01. From 21-Nov-2025 under the Code on Social Security, 2020; EPF Scheme, 2026 (G.S.R. 525(E), 29-Jun-2026) para 18(2) 12% each, 18(3) limited to the ceiling, 18(5) nearest rupee. EPS 8.33% and EDLI 0.5% under the 2026 schemes: rates unchanged, read on secondary sources only; the admin charge has no 2026 re-fixation found (para 29(1)).',
    EPF_SCHEME_2026, 'Admin 0.50% and EDLI rates after 29-Jun-2026: not re-confirmed on an official page (EPF scheme 2026 para 29(1) leaves the admin rate to a notification not found).'],
  ['PF', 'IN', '2026-09-17', PF(25000), 'VERIFIED',
    'Wage ceiling raised to ₹25,000 a month for Chapter III (EPF, EPS, EDLI): S.O. 5109(E), 17-Sep-2026, under the Code on Social Security §2(89), in force on publication; supersedes S.O. 2702(E) of 29-May-2026. EPS reopened for EPF-only members at or under the new ceiling: G.S.R. 847(E), 25-Sep-2026.',
    PF_CEILING_25K, 'A run takes the settings in force on the FIRST day of its month: September 2026 uses ₹15,000, October 2026 onward ₹25,000. Check with your CA whether September 2026 should be split (1–16 Sep at ₹15,000, 17–30 Sep at ₹25,000).'],
  ['ESI', 'IN', '2025-04-01', ESI, 'VERIFIED',
    'ESIC: employee 0.75%, employer 3.25% w.e.f. 01-07-2019; employee share exempt at a daily average wage up to ₹176 (the employer still pays); contribution periods 1 Apr–30 Sep and 1 Oct–31 Mar; coverage ceiling ₹21,000 a month (₹25,000 for a person with disability) since 01-01-2017; shares rounded to the next higher rupee.',
    ESIC, 'Ceiling: https://www.esic.gov.in/coverage.'],
  ['ESI', 'IN', '2026-04-01', ESI, 'VERIFIED',
    'Unchanged. Social Security (Central) Rules, 2026 (G.S.R. 344(E), 8-May-2026) rule 19(1): employer 3.25%, employee 0.75%, each rounded to the next higher rupee. S.O. 2351(E), 8-May-2026: a person whose wage crosses the ceiling after a contribution period starts stays covered to its end. No new ESI ceiling notified under the Code: ₹21,000 continues.',
    SS_RULES_2026, 'The ₹176 daily-wage exemption is on esic.gov.in but not restated in the 2026 Rules: kept, as a setting. The Code’s 50% wage rule (allowances over half of pay added back) is not applied by this engine: mark the components that count toward the PF and ESI wage.'],
  ['PT', 'TG', '2025-04-01', PT_TG, 'VERIFIED',
    'Telangana Tax on Professions, Trades, Callings and Employments Act, 1987, Schedule entry 1 (salaried, a month): up to ₹15,000 nil; ₹15,001–₹20,000 ₹150; above ₹20,000 ₹200. The same every month (no special February amount). No slab change after G.O. 170 of 18-09-2015.',
    TG_PT, 'The schedule page does not print the date the slabs took effect.'],
  ['PT', 'TG', '2026-04-01', PT_TG, 'VERIFIED',
    'Unchanged: the Telangana commercial taxes schedule (read 2026-10-19) shows the same slabs, and the G.O.s page shows no change after G.O. 170 of 18-09-2015.',
    TG_PT, null],
  ['LWF', 'TG', '2025-04-01', LWF_TG, 'UNVERIFIED',
    'Telangana Labour Welfare Fund Act, 1987 s.10(1): employee ₹2 a year, employer ₹5 a year per employee (verified on the Telangana labour department’s text; adapted by G.O.Ms.No.6 of 01-02-2016). DEDUCTED IN DECEMBER and paid by 31 January: secondary sources only (the 1988 Rules could not be opened) — hence UNVERIFIED.',
    TG_LWF, 'Covers establishments with 20 or more persons; excludes managerial staff, supervisors drawing over ₹1,600 a month, apprentices and part-time workers. The ₹30/₹70 figures seen elsewhere are Andhra Pradesh’s, not Telangana’s.'],
  ['LWF', 'TG', '2026-04-01', LWF_TG, 'UNVERIFIED',
    'Unchanged: Telangana Labour Welfare Fund Act, 1987 s.10(1), ₹2 employee and ₹5 employer a year. December deduction / 31 January due date: secondary sources only.',
    TG_LWF, null],
].map(([kind, stateCode, effectiveFrom, settings, verification, source, sourceUrl, note]) => ({ kind, stateCode, effectiveFrom, settings, verification, source, sourceUrl, note }));

/**
 * Adds what is missing. -> { components, structure, statutory, settings } — what was created.
 * Never changes a row that exists.
 */
export async function seedPayroll(db, c, requestId = null) {
  const made = { components: [], structure: null, statutory: [], settings: false };
  const [have] = await db.query('SELECT id, code, statutory_key FROM hrms_pay_components WHERE company_id = ? AND deleted_at IS NULL', [c.companyId]);
  const codes = new Set(have.map((h) => String(h.code).toUpperCase()));
  const keys = new Set(have.map((h) => h.statutory_key).filter(Boolean));
  for (const k of READY_MADE_COMPONENTS) {
    if (codes.has(k.code) || (k.statutoryKey && keys.has(k.statutoryKey))) continue;
    const [ins] = await db.query(
      `INSERT INTO hrms_pay_components (company_id, code, name, kind, taxable, exemption_rule, in_pf_wage, in_esi_wage, in_gratuity_wage, frequency, prorate_on_lop,
         statutory_key, sort_order, status, is_ready_made, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', 1, ?)`,
      [c.companyId, k.code, k.name, k.kind, k.taxable, k.exemptionRule, k.inPfWage, k.inEsiWage, k.inGratuityWage, k.frequency, k.prorateOnLop, k.statutoryKey, k.sortOrder, c.userId],
    );
    await audit(db, c, 'hrms_pay_components', ins.insertId, 'CREATE', null, { ...k, readyMade: true }, requestId);
    made.components.push(k.code);
  }

  const [[st]] = await db.query('SELECT id FROM hrms_pay_structures WHERE company_id = ? AND deleted_at IS NULL AND UPPER(code) = ?', [c.companyId, SAMPLE_STRUCTURE.code]);
  if (!st) {
    const [comps] = await db.query('SELECT id, code FROM hrms_pay_components WHERE company_id = ? AND deleted_at IS NULL', [c.companyId]);
    const idOf = new Map(comps.map((r) => [String(r.code).toUpperCase(), r.id]));
    if (SAMPLE_STRUCTURE.lines.every(([code]) => idOf.has(code))) {
      const [ins] = await db.query("INSERT INTO hrms_pay_structures (company_id, code, name, description, status, created_by) VALUES (?, ?, ?, ?, 'ACTIVE', ?)",
        [c.companyId, SAMPLE_STRUCTURE.code, SAMPLE_STRUCTURE.name, SAMPLE_STRUCTURE.description, c.userId]);
      let n = 0;
      for (const [code, formula] of SAMPLE_STRUCTURE.lines) {
        n += 10;
        await db.query('INSERT INTO hrms_pay_structure_lines (company_id, structure_id, component_id, formula, sort_order, created_by) VALUES (?, ?, ?, ?, ?, ?)',
          [c.companyId, ins.insertId, idOf.get(code), formula, n, c.userId]);
      }
      await audit(db, c, 'hrms_pay_structures', ins.insertId, 'CREATE', null, { code: SAMPLE_STRUCTURE.code, name: SAMPLE_STRUCTURE.name, lines: SAMPLE_STRUCTURE.lines }, requestId);
      made.structure = SAMPLE_STRUCTURE.name;
    }
  }

  const [rows] = await db.query('SELECT kind, state_code, effective_from FROM hrms_pay_statutory_settings WHERE company_id = ? AND deleted_at IS NULL', [c.companyId]);
  const present = new Set(rows.map((r) => `${r.kind}|${r.state_code}|${String(r.effective_from instanceof Date ? r.effective_from.toISOString() : r.effective_from).slice(0, 10)}`));
  for (const s of STATUTORY_ROWS) {
    if (present.has(`${s.kind}|${s.stateCode}|${s.effectiveFrom}`)) continue;
    const [ins] = await db.query(
      `INSERT INTO hrms_pay_statutory_settings (company_id, kind, state_code, effective_from, settings_json, source, source_url, verification, note, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [c.companyId, s.kind, s.stateCode, s.effectiveFrom, JSON.stringify(s.settings), s.source, s.sourceUrl, s.verification, s.note, c.userId],
    );
    await audit(db, c, 'hrms_pay_statutory_settings', ins.insertId, 'CREATE', null, { kind: s.kind, stateCode: s.stateCode, effectiveFrom: s.effectiveFrom, settings: s.settings, verification: s.verification }, requestId);
    made.statutory.push(`${s.kind} ${s.stateCode} ${s.effectiveFrom}`);
  }

  const [[set]] = await db.query('SELECT id FROM hrms_pay_settings WHERE company_id = ? AND deleted_at IS NULL', [c.companyId]);
  if (!set) {
    const [ins] = await db.query("INSERT INTO hrms_pay_settings (company_id, state_code, narration, created_by) VALUES (?, 'TG', 'Salary', ?)", [c.companyId, c.userId]);
    await audit(db, c, 'hrms_pay_settings', ins.insertId, 'CREATE', null, { stateCode: 'TG', narration: 'Salary' }, requestId);
    made.settings = true;
  }
  return made;
}

export default { READY_MADE_COMPONENTS, SAMPLE_STRUCTURE, STATUTORY_ROWS, seedPayroll };
