/**
 * payroll_exit_test.mjs — payroll P3b (TM/CF_HRMS_HIRING_SPEC.md §25.5, §28.6; 2026-10-20): attendance into the run,
 * perquisites / Form 10E relief / retirement contributions in TDS and Form 16, full and final settlements, claims,
 * and the second review's fixes (ECR days from the run, HR on their own records, challan fitting, Part A limits,
 * audit of the proof queue and the forms list).
 *
 *   0. the schema (apply-payroll-exit-schema.mjs reads init.sql §32) and the rules (retirement_contributions,
 *      final_settlement: both years, both regimes, sources; final_settlement NOT verified, said);
 *   1. pure: service length, gratuity, leave-encashment limbs, notice, retirement perquisite, challan fitting,
 *      the engine's leave-encashment cap, Part A limits;
 *   2–9 through the routes on the LOCAL database, the tax year 2025-26, every month April 2025 to March 2026 run,
 *      locked, released and paid; then rights; then nothing left behind.
 *
 * HAND-WORKED (structure S: Basic 50% of CTC, HRA 50% of Basic, Special the balance; no PF unless said; new regime
 * unless said; 2025-26 rules)
 *   ATTENDANCE, T (₹3,12,000: Basic 13,000, HRA 6,500, Special 6,500 a month), live from 1 June 2025:
 *     June CLOSED: absent 10 Jun (1) + half absent 11 Jun (0.5) + unpaid leave 12 Jun (1) + a penalty LOP of 0.5
 *     (20 Jun) = 3 LOP days → 27/30: Basic 11,700 + HRA 5,850 + Special 5,850 = 23,400;
 *     overtime 10 h × 2 × (13,000 + 0) ÷ 26 ÷ 8 = 62.50 an hour = 1,250; penalty amount 300 (a deduction);
 *     PT on 24,650 = 200; TDS nil → net 24,650 − 200 − 300 = 24,150.
 *     July live and NOT closed: calculating is refused ("Close attendance for July 2025 first"); HR pays without
 *     attendance (a reason) → T full: 26,000; closing July afterwards makes the run stale (lock refused).
 *   PERQUISITES IN TDS, P (₹18,00,000) with a company car, mixed use, above 1.6 L, employer pays (rule 3: 2,400 a
 *     month) = 28,800: taxable 18,00,000 + 28,800 − 75,000 = 17,53,800; tax 20,000 + 40,000 + 60,000 + 30,760 =
 *     1,50,760 + cess 6,030.40 = 1,56,790 → April TDS 1,56,790 ÷ 12 = 13,066 (without the car: 1,50,800 ÷ 12 = 12,567).
 *     Form 12BA: "2. Cars / Other automotive", value 28,800, recovered 0, taxable 28,800.
 *   10E RELIEF, R (₹24,00,000), a READY Form 10E worksheet of 5,000: tax on 23,25,000 = 2,81,250 + cess 11,250 =
 *     2,92,500 − relief 5,000 = 2,87,500 → April TDS 23,958 (without: 24,375). Form 16 row 18 = 5,000, row 19 = the year's tax less 5,000 (the year includes the March flexible balance);
 *     Annexure II relief 5,000.
 *   ₹7.5 LAKH, K (₹36,00,000, structure: Basic 50%, NPS (employer) 40% of Basic, Special the balance; PF on the full
 *     Basic): PF employer 12% × 1,50,000 = 18,000 × 12 = 2,16,000 + NPS 60,000 × 12 = 7,20,000 = 9,36,000 → 1,86,000
 *     above 7,50,000; facts PC1 1,00,000, TP1 8,000, R 8.25%: (1,86,000 ÷ 2 + 1,00,000 + 8,000) × 8.25% = 16,582.50 →
 *     16,583. Pure: 3,60,000 + 6,00,000 = 9,60,000 → 2,10,000; (1,05,000 + 1,08,000) × 8.25% = 17,573.
 *   FULL AND FINAL (last day 20 Oct 2025; October paid 20/31):
 *     G1 joined 21 Nov 2020 → 4 years 11 months: no gratuity. Resigned, notice 30 days typed, given 1 Oct → 19 served,
 *       11 short × (80,000 ÷ 30 = 2,666.67) = 29,333 recovered; bonus 10,000; loan 5,000 recovered. October: Basic
 *       25,806 + HRA 12,903 + Special 12,903 = 51,612 + bonus 10,000 − PT 200 (on 51,612: settlement amounts are not in
 *       the PT slab) − 29,333 − 5,000 = 27,079 net (TDS nil, rebate).
 *     G2 joined 21 Oct 2020 → 5 years 0 months: gratuity 15/26 × 40,000 × 5 = 1,15,385; 10 days encashed × 40,000 ÷ 26
 *       (1,538.46) = 15,385.
 *     G3 joined 10 Mar 2018 → 7 years 7 months 11 days → 8 years: ₹24,00,000 (Basic 1,00,000): gratuity 15/26 × 1,00,000
 *       × 8 = 4,61,538 (all exempt: least of received, formula, ₹20,00,000); 300 days typed × 3,846.15 = 11,53,845,
 *       exempt least of 10 × 1,00,000 = 10,00,000 and min(300, 30 × 7) = 210 days × 1,00,000 ÷ 30 = 7,00,000 →
 *       7,00,000; REMOVED with 19 of 30 days' notice → 11 × 6,666.67 = 73,333 notice pay. The year: salary 6 × 2,00,000
 *       + 1,29,032 + gratuity 4,61,538 + 11,53,845 + 73,333 = 30,17,748 − exempt 11,61,538 = 18,56,210 − 75,000 =
 *       17,81,210 → tax 1,20,000 + 36,242 = 1,56,242 + cess 6,249.68 = 1,62,491.68 → 1,62,490 = all the TDS of
 *       April–October (the October run takes the balance: the last month).
 *     G4 left 15 Sep 2025; settlement approved after September was locked → paid in October on its own: 5 days ×
 *       1,538.46 = 7,692 + an approved claim of 1,500; no salary, no PT → net 9,192.
 *   CLAIMS, C (₹9,60,000, OLD regime): FUEL limit 36,000: 30,000 filed, then 7,000 refused (6,000 left); HR approves
 *     25,000 (lower, with a note) → a REIMB line of 25,000 in April; MEALS rejected; PHONE without bills refused.
 *     LTA (block 2022–2025, two journeys): May journey → exempt (1 of 2), August → exempt (2 of 2), December →
 *     taxable (REIMB_TAX). March 2026 (unclaimed flexible balance paid, taxed): FUEL 11,000 + PHONE 24,000 + LTA
 *     10,000 + MEALS 26,400 + BOOKS 12,000 = 83,400. Form 16 (old regime): leave travel exempt 20,000.
 *
 *   node scripts/cf_hrms/payroll_exit_test.mjs [--company=karni] [--verbose]
 *
 * NOTHING IS LEFT BEHIND: one connection, one transaction (pool.query / getConnection point at it), rolled back.
 * The company's own runs are set aside inside the transaction. Local only.
 */
import express from 'express';
import cookieParser from 'cookie-parser';
import mysql from 'mysql2/promise';
import zlib from 'node:zlib';
import JSZip from 'jszip';
import { pool } from '../../db.js';
import { signToken } from '../../core/utils/jwt.js';
import { appContext } from '../../core/middleware/appContext.js';
import hrmsApp from '../../apps/cf_hrms/app.js';
import { forgetAccess } from '../../apps/cf_hrms/lib/accessContext.js';
import { hrmsAppOf, ensureCatalog, setRoleTags } from '../../apps/cf_hrms/services/accessGrants.js';
import { setupAccess } from '../../apps/cf_hrms/services/accessSetup.js';
import { areaTag } from '../../apps/cf_hrms/lib/access.js';
import { schemaSteps, PAYROLL_EXIT_TABLES } from '../../apps/cf_hrms/scripts/apply-payroll-exit-schema.mjs';
import { TAX_RULE_ROWS, rulesFromSeed, computeTax } from '../../apps/cf_hrms/services/tax/index.js';
import { retirementPerquisite } from '../../apps/cf_hrms/services/tax/retirement.js';
import { serviceLength, gratuity, encashmentExemptFormula, notice } from '../../apps/cf_hrms/services/payrollExit/fnfMath.js';
import { allocateRows } from '../../apps/cf_hrms/services/payrollTax/quarterly.js';
import { quarterData } from '../../apps/cf_hrms/services/payrollTax/quarterly.js';
import { pansInPdf, readCapped, PART_A_LIMITS, partBRows } from '../../apps/cf_hrms/services/payrollTax/form16.js';
import { yearActuals } from '../../apps/cf_hrms/services/payrollTax/actuals.js';
import { formsOf, loadRules } from '../../apps/cf_hrms/services/payrollTax/common.js';
import { loadWorlds, approverChain } from '../../apps/cf_hrms/services/leave/requestService.js';

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
const section = (title) => console.log(`\n${title}`);
const started = Date.now();
const dbCfg = { host: process.env.DB_HOST ?? 'localhost', user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME, port: Number(process.env.DB_PORT) || 3306 };

/** Every table with company_id AND deleted_at: rows and live rows. */
async function worldCount() {
  const conn = await mysql.createConnection(dbCfg);
  try {
    const [tables] = await conn.query(`SELECT c1.TABLE_NAME AS t FROM information_schema.COLUMNS c1 JOIN information_schema.COLUMNS c2 ON c2.TABLE_SCHEMA = c1.TABLE_SCHEMA AND c2.TABLE_NAME = c1.TABLE_NAME AND c2.COLUMN_NAME = 'deleted_at'
      JOIN information_schema.TABLES tb ON tb.TABLE_SCHEMA = c1.TABLE_SCHEMA AND tb.TABLE_NAME = c1.TABLE_NAME AND tb.TABLE_TYPE = 'BASE TABLE'
      WHERE c1.TABLE_SCHEMA = DATABASE() AND c1.COLUMN_NAME = 'company_id' ORDER BY c1.TABLE_NAME`);
    const out = {};
    for (const { t } of tables) {
      const [[r]] = await conn.query(`SELECT COUNT(*) AS n, COALESCE(SUM(deleted_at IS NULL), 0) AS live FROM \`${t}\``);
      out[t] = `${r.n}/${r.live}`;
    }
    const [[a]] = await conn.query('SELECT COUNT(*) AS n FROM hrms_attendance_settings');
    out['hrms_attendance_settings (all)'] = String(a.n);
    return out;
  } finally { await conn.end(); }
}
const before = await worldCount();

/* ══ 0. schema and rules ═══════════════════════════════════════════════ */
section('[0] The schema and the rules');
{
  const conn = await mysql.createConnection(dbCfg);
  try {
    ok(PAYROLL_EXIT_TABLES.length === 7, 'init.sql §32 declares seven tables', PAYROLL_EXIT_TABLES.join(', '));
    ok((await schemaSteps(conn)).length === 0, 'apply-payroll-exit-schema: nothing left to do (idempotent, the ENUM values appended)');
    const [cols] = await conn.query(`SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (?) AND COLUMN_NAME IN ('company_id', 'deleted_at')`, [PAYROLL_EXIT_TABLES]);
    ok(cols.length === 14, 'every §32 table has company_id and deleted_at', String(cols.length));
    const [[src]] = await conn.query("SELECT COLUMN_TYPE AS t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_pay_run_lines' AND COLUMN_NAME = 'source'");
    ok(/'ATTENDANCE'/.test(src.t) && /'SETTLEMENT'/.test(src.t) && /'CLAIM'/.test(src.t), 'run lines take the sources ATTENDANCE, SETTLEMENT, CLAIM');
    const [rules] = await conn.query("SELECT tax_year, regime, rule_key, verified, source_url FROM hrms_tax_rules WHERE rule_key IN ('retirement_contributions', 'final_settlement') AND deleted_at IS NULL");
    ok(rules.length === 8 && rules.every((r) => r.source_url), 'retirement_contributions and final_settlement: both years, both regimes, seeded with a source', String(rules.length));
    ok(rules.filter((r) => r.rule_key === 'retirement_contributions').every((r) => Number(r.verified) === 1) && rules.filter((r) => r.rule_key === 'final_settlement').every((r) => Number(r.verified) === 0),
      'retirement contributions verified (rule 3B / rule 16 read); the gratuity Act figures NOT verified (secondary sources) — said');
    const R26 = rulesFromSeed('2026-27', 'NEW').get('retirement_contributions');
    ok(R26.limit === 750000 && /17\(1\)\(h\)/.test(R26.section) && /rule 16/.test(R26.accretionRule), '2026-27: s.17(1)(h), rule 16 of the 2026 Rules, ₹7,50,000');
    ok(TAX_RULE_ROWS.filter((r) => ['retirement_contributions', 'final_settlement'].includes(r.rule_key)).length === 8, 'the seed has them');
  } finally { await conn.end(); }
}

/* ══ 1. pure ═══════════════════════════════════════════════════════════ */
section('[1] By hand: gratuity, encashment, notice, the ₹7.5 lakh rule, challans, Part A limits');
{
  const FS = rulesFromSeed('2025-26', 'NEW').get('final_settlement');
  const s1 = serviceLength('2020-11-21', '2025-10-20');
  ok(s1.years === 4 && s1.months === 11 && s1.days === 0, 'joined 21 Nov 2020, last day 20 Oct 2025: 4 years 11 months', s1.text);
  const g1 = gratuity({ service: s1, wage: 40000, rule: FS.gratuity });
  ok(!g1.eligible && g1.amount === 0 && /not due/.test(g1.lines[0]), '4 years 11 months: no gratuity (5 years needed), said');
  const s2 = serviceLength('2020-10-21', '2025-10-20');
  const g2 = gratuity({ service: s2, wage: 40000, rule: FS.gratuity });
  ok(s2.years === 5 && s2.months === 0 && g2.eligible && g2.years === 5 && g2.amount === 115385, '5 years: 15/26 × 40,000 × 5 = 1,15,385', JSON.stringify(g2));
  const s3 = serviceLength('2018-03-10', '2025-10-20');
  const g3 = gratuity({ service: s3, wage: 100000, rule: FS.gratuity });
  ok(s3.years === 7 && s3.months === 7 && s3.days === 11 && g3.years === 8 && g3.amount === 461538, '7 years 7 months: 8 years (more than six months counts) → 15/26 × 1,00,000 × 8 = 4,61,538', `${s3.text} ${g3.amount}`);
  const s4 = serviceLength('2018-04-21', '2025-10-20');
  ok(gratuity({ service: s4, wage: 100000, rule: FS.gratuity }).years === 7 && s4.months === 6 && s4.days === 0, '7 years 6 months exactly: 7 years (six months is not MORE than six)');
  ok(gratuity({ service: { years: 40, months: 0, days: 0, text: '40 years' }, wage: 200000, rule: FS.gratuity }).amount === 2000000, 'the Act’s ceiling: at most ₹20,00,000');
  const ex = encashmentExemptFormula({ days: 300, completedYears: 7, averageSalary: 100000, rule: FS.leaveEncashment });
  ok(ex.limbC === 1000000 && ex.limbD === 700000 && ex.formulaAmount === 700000, 'encashment limbs: 10 × 1,00,000 = 10,00,000; 210 days × 1,00,000 ÷ 30 = 7,00,000 → 7,00,000', JSON.stringify(ex));
  // The cap (₹25,00,000, a lifetime) through the engine.
  const NEW = rulesFromSeed('2025-26', 'NEW');
  const big = computeTax({ year: '2025-26', regime: 'NEW', salary: { components: [{ code: 'LEAVE_ENC', name: 'Leave encashment', amount: 3000000, taxable: 'PARTLY', exemptRule: 'LEAVE_ENCASHMENT' }] }, exemptions: { leaveEncashment: { formulaAmount: 3000000 } } }, NEW);
  ok(big.exemptions.find((e) => e.key === 'exempt_leave_encashment')?.exempt === 2500000, 'leave encashment of 30 lakh: exempt at most the cap, 25,00,000');
  const before10 = computeTax({ year: '2025-26', regime: 'NEW', salary: { components: [{ code: 'LEAVE_ENC', name: 'Leave encashment', amount: 3000000, taxable: 'PARTLY', exemptRule: 'LEAVE_ENCASHMENT' }] }, exemptions: { leaveEncashment: { formulaAmount: 3000000, exemptedBefore: 2000000 } } }, NEW);
  ok(before10.exemptions.find((e) => e.key === 'exempt_leave_encashment')?.exempt === 500000, '… less 20 lakh exempted by an earlier employer: 5,00,000');
  const nr = notice({ requiredDays: 30, servedDays: 19, exitType: 'RESIGNED', dayRate: 80000 / 30 });
  ok(nr.action === 'RECOVER' && nr.shortDays === 11 && nr.amount === 29333, 'resigned, 19 of 30 days served: 11 × 2,666.67 = 29,333 recovered');
  ok(notice({ requiredDays: 30, servedDays: 19, exitType: 'REMOVED', dayRate: 200000 / 30 }).amount === 73333 && notice({ requiredDays: 30, servedDays: 19, exitType: 'REMOVED', dayRate: 1 }).action === 'PAY', 'removed: 11 × 6,666.67 = 73,333 paid');
  ok(notice({ requiredDays: 30, servedDays: 19, exitType: 'RESIGNED', waived: true, dayRate: 1000 }).amount === 0, 'waived: nothing');
  const RC = rulesFromSeed('2025-26', 'NEW').get('retirement_contributions');
  const rp = retirementPerquisite({ contributions: { pf: 360000, nps: 600000, superannuation: 0 }, rule: RC, facts: { previousExcess: 100000, previousAccretion: 8000, ratePct: 8.25 } });
  ok(rp.total === 960000 && rp.excess === 210000 && rp.accretion === 17573 && rp.perquisites.length === 2, '₹7.5 lakh: 9,60,000 → 2,10,000 above; accretion (1,05,000 + 1,08,000) × 8.25% = 17,573', JSON.stringify(rp));
  const rp2 = retirementPerquisite({ contributions: { pf: 216000, nps: 360000 }, rule: RC });
  ok(rp2.excess === 0 && rp2.perquisites.length === 0, 'under the limit: nothing');
  const rp3 = retirementPerquisite({ contributions: { pf: 360000, nps: 600000 }, rule: RC });
  ok(rp3.excess === 210000 && rp3.accretion === 0 && /not valued/.test(rp3.lines[1]), 'no fund rate entered: the excess counts, the accretion is not valued, said');
  const fit = allocateRows([600, 500, 400], [1000, 500]);
  ok(fit.allocated[0] === 1000 && fit.allocated[1] === 500 && fit.of.join() === '0,1,0', 'challans 1,000 and 500, rows 600, 500, 400: 600 + 400 and 500 (each within what it paid)', JSON.stringify(fit));
  const over = allocateRows([600, 600, 400], [1000, 500]);
  ok(over.allocated[1] > 500, 'rows that do not fit: one challan is over (the return then says so per challan)', JSON.stringify(over));
  // Part A: a stream that inflates past the limit is not read to the end; a ZIP entry past it is refused.
  const bomb = zlib.deflateSync(Buffer.alloc(PART_A_LIMITS.stream + 1024 * 1024, 65));
  const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n1 0 obj << >>\nstream\n'), bomb, Buffer.from('\nendstream\nendobj\n(ABCDE1234F)\n%%EOF')]);
  const t0 = Date.now();
  ok(pansInPdf(pdf).includes('ABCDE1234F') && Date.now() - t0 < 5000, 'a PDF with a 21 MB stream: the stream stops at the limit; the PAN in the text is still found');
  const zip = new JSZip();
  zip.file('big.pdf', Buffer.alloc(PART_A_LIMITS.entry + 1024, 32));
  const loaded = await JSZip.loadAsync(await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
  let refused = null;
  try { await readCapped(loaded.file('big.pdf'), PART_A_LIMITS.entry, 'big.pdf'); } catch (e) { refused = e; }
  ok(refused && /more than the 20 MB/.test(refused.message), 'a ZIP entry that unpacks past 20 MB: refused in words', refused?.message);
}

/* ══ the database part: one transaction, rolled back ═══════════════════ */
const real = { query: pool.query.bind(pool), execute: pool.execute.bind(pool), getConnection: pool.getConnection.bind(pool) };
const db = await real.getConnection();
await db.beginTransaction();
let depth = 0;
const inside = {
  query: (...a) => db.query(...a),
  execute: (...a) => db.execute(...a),
  beginTransaction: async () => { depth += 1; await db.query(`SAVEPOINT zz_pexit_${depth}`); },
  commit: async () => { if (depth > 0) { await db.query(`RELEASE SAVEPOINT zz_pexit_${depth}`); depth -= 1; } },
  rollback: async () => { if (depth > 0) { await db.query(`ROLLBACK TO SAVEPOINT zz_pexit_${depth}`); depth -= 1; } },
  release: () => {},
};
pool.query = inside.query;
pool.execute = inside.execute;
pool.getConnection = async () => inside;

const TAG = `ZZPF${Date.now().toString(36).toUpperCase().slice(-5)}`;
const q = async (sql, params) => (await db.query(sql, params))[0];
const one = async (sql, params) => (await q(sql, params))[0] ?? null;
const ins = async (sql, params) => (await db.query(sql, params))[0].insertId;
const PDF = { fileName: 'bill.pdf', contentBase64: Buffer.from('%PDF-1.4\n% a bill\n%%EOF').toString('base64') };

let server;
try {
  const company = await one('SELECT id, name, slug FROM companies WHERE slug = ? AND deleted_at IS NULL', [slug]);
  if (!company) throw new Error(`No company "${slug}".`);
  const COMPANY = company.id;
  const app = await hrmsAppOf(db, COMPANY);
  console.log(`\npayroll_exit_test — ${company.name} (${COMPANY}), run tag ${TAG}`);
  // The company's own runs, claims, settlements and tax setup: out of the way, inside the transaction.
  for (const t of ['hrms_pay_runs', 'hrms_pay_perquisites', 'hrms_tax_relief_10e', 'hrms_pay_settlements', 'hrms_pay_claims', 'hrms_pay_claim_types', 'hrms_pay_policy', 'hrms_pay_retirement_facts']) {
    await db.query(`UPDATE ${t} SET deleted_at = NOW() WHERE company_id = ? AND deleted_at IS NULL`, [COMPANY]);
  }
  await db.query("UPDATE hrms_tax_settings SET deleted_at = NOW() WHERE company_id = ? AND tax_year IN ('2025-26', '2026-27') AND deleted_at IS NULL", [COMPANY]);
  // Attendance live from 1 June 2025 (put back by the rollback).
  const attRow = await one('SELECT company_id FROM hrms_attendance_settings WHERE company_id = ?', [COMPANY]);
  if (attRow) await db.query("UPDATE hrms_attendance_settings SET live_from = '2025-06-01' WHERE company_id = ?", [COMPANY]);
  else await db.query("INSERT INTO hrms_attendance_settings (company_id, live_from) VALUES (?, '2025-06-01')", [COMPANY]);
  await db.query("DELETE FROM hrms_attendance_months WHERE company_id = ? AND period_month BETWEEN '2025-04' AND '2026-03'", [COMPANY]);

  await setupAccess(db, COMPANY, { apply: true });
  const roleByKey = Object.fromEntries((await q('SELECT role_id, template_key FROM hrms_access_roles WHERE company_id = ? AND deleted_at IS NULL AND template_key IS NOT NULL', [COMPANY])).map((r) => [r.template_key, r.role_id]));
  const catalog = await ensureCatalog(db, { apply: true });
  const clerkRole = await ins('INSERT INTO roles (name, company_id) VALUES (?, ?)', [`${TAG} Payroll clerk`, COMPANY]);
  await db.query("INSERT INTO hrms_access_roles (company_id, role_id, label, scope) VALUES (?, ?, ?, 'COMPANY')", [COMPANY, clerkRole, `${TAG} Payroll clerk`]);
  await setRoleTags(db, { companyId: COMPANY, appId: app.id, roleId: clerkRole, tags: [areaTag('payroll', 'view'), areaTag('payroll', 'edit')], catalog });

  const emp = async (code, name, joining, extra = {}) => ins(
    `INSERT INTO hrms_employees (company_id, employee_code, full_name, date_of_joining, date_of_birth, employment_type, employment_status, exit_date) VALUES (?, ?, ?, ?, '1985-05-05', 'EMPLOYEE', ?, ?)`,
    [COMPANY, `${TAG}${code}`, name, joining, extra.exit ? 'EXITED' : 'ACTIVE', extra.exit ?? null]);
  const E = {
    T: await emp('T', `${TAG} Person T`, '2024-01-01'), P: await emp('P', `${TAG} Person P`, '2024-01-01'), R: await emp('R', `${TAG} Person R`, '2024-01-01'),
    K: await emp('K', `${TAG} Person K`, '2024-01-01'), C: await emp('C', `${TAG} Person C`, '2024-01-01'), H: await emp('H', `${TAG} Person H`, '2024-01-01'),
    G1: await emp('G1', `${TAG} Person G1`, '2020-11-21', { exit: '2025-10-20' }), G2: await emp('G2', `${TAG} Person G2`, '2020-10-21', { exit: '2025-10-20' }),
    G3: await emp('G3', `${TAG} Person G3`, '2018-03-10', { exit: '2025-10-20' }), G4: await emp('G4', `${TAG} Person G4`, '2024-01-01', { exit: '2025-09-15' }),
  };
  const PANS = { T: 'AAAPT1234T', P: 'AAAPP1234P', R: 'AAAPR1234R', K: 'AAAPK1234K', C: 'AAAPC1234C', H: 'AAAPH1234H', G1: 'AAAPG1234A', G2: 'AAAPG1234B', G3: 'AAAPG1234C', G4: 'AAAPG1234D' };
  for (const [k, pan] of Object.entries(PANS)) {
    await db.query('INSERT INTO hrms_employee_identifiers (company_id, employee_id, identifier_type, identifier_value) VALUES (?, ?, ?, ?)', [COMPANY, E[k], 'PAN', pan]);
    await db.query('INSERT INTO hrms_employee_identifiers (company_id, employee_id, identifier_type, identifier_value) VALUES (?, ?, ?, ?)', [COMPANY, E[k], 'BANK_ACCOUNT', `1234567${String(E[k]).padStart(5, '0')}`]);
    await db.query('INSERT INTO hrms_employee_identifiers (company_id, employee_id, identifier_type, identifier_value) VALUES (?, ?, ?, ?)', [COMPANY, E[k], 'IFSC', 'SBIN0001234']);
  }
  const exitRow = (e, type, noticeDate, lastDay) => db.query(
    `INSERT INTO hrms_employee_exits (company_id, employee_id, exit_type, reason_code, notice_date, last_working_day, status, closed_on) VALUES (?, ?, ?, ?, ?, ?, 'CLOSED', ?)`,
    [COMPANY, e, type, type === 'RESIGNED' ? 'BETTER_JOB' : 'ROLE_REMOVED', noticeDate, lastDay, lastDay]);
  await exitRow(E.G1, 'RESIGNED', '2025-10-01', '2025-10-20');
  await exitRow(E.G2, 'RESIGNED', '2025-10-01', '2025-10-20');
  await exitRow(E.G3, 'REMOVED', '2025-10-01', '2025-10-20');
  await exitRow(E.G4, 'RESIGNED', '2025-08-16', '2025-09-15');

  const login = async (label, roleId, employeeId = null) => {
    const email = `${TAG.toLowerCase()}.${label.toLowerCase().replace(/[^a-z0-9]/g, '')}@example.test`;
    const id = await ins('INSERT INTO users (name, email, password, role_id, team_id, company_id) VALUES (?, ?, ?, ?, NULL, ?)', [`${TAG} ${label}`, email, 'x', roleId, COMPANY]);
    await db.query('INSERT INTO app_user_access (user_id, app_id, role_id, company_id) VALUES (?, ?, ?, ?)', [id, app.id, roleId, COMPANY]);
    if (employeeId) await db.query('UPDATE hrms_employees SET user_id = ? WHERE id = ?', [id, employeeId]);
    const roleName = (await one('SELECT name FROM roles WHERE id = ?', [roleId])).name;
    return { id, token: signToken({ id, name: `${TAG} ${label}`, email, role: roleName, company: company.slug, companyId: COMPANY, company_id: COMPANY, uiPermissions: [] }) };
  };
  // A person of the company with a manager (for the manager's first look at a claim).
  let X = null;
  let M = null;
  const cands = await q("SELECT id FROM hrms_employees WHERE company_id = ? AND deleted_at IS NULL AND employment_status = 'ACTIVE' AND user_id IS NULL AND employee_code NOT LIKE 'ZZ%' ORDER BY id LIMIT 60", [COMPANY]);
  const worlds = await loadWorlds(db, COMPANY, cands.map((r) => r.id));
  for (const r of cands) {
    const w = worlds.get(r.id);
    if (!w) continue;
    const a = (await approverChain(db, COMPANY, w)).approverId;
    if (a) { const m = await one('SELECT id, user_id FROM hrms_employees WHERE id = ?', [a]); if (m && !m.user_id) { X = r.id; M = a; break; } }
  }
  const U = {
    HR: await login('HR manager', roleByKey.HR_MANAGER, E.H), HR2: await login('HR manager two', roleByKey.HR_MANAGER), DH: await login('Department head', roleByKey.DEPARTMENT_HEAD),
    CLERK: await login('Clerk', clerkRole), C: await login('Employee C', roleByKey.EMPLOYEE, E.C), G3: await login('Employee G3', roleByKey.EMPLOYEE, E.G3),
    G4: await login('Employee G4', roleByKey.EMPLOYEE, E.G4), T: await login('Employee T', roleByKey.EMPLOYEE, E.T),
    X: X ? await login('Employee X', roleByKey.EMPLOYEE, X) : null, M: M ? await login('Manager M', roleByKey.EMPLOYEE, M) : null,
  };
  forgetAccess();
  server = express();
  server.use(express.json({ limit: '40mb' }));
  server.use(cookieParser());
  server.use('/api', appContext);
  hrmsApp.register(server);
  const listener = await new Promise((resolve) => { const l = server.listen(0, '127.0.0.1', () => resolve(l)); });
  server.close = () => new Promise((resolve) => listener.close(resolve));
  const base = `http://127.0.0.1:${listener.address().port}/api`;
  const call = async (who, method, url, body) => {
    const res = await fetch(`${base}/${company.slug}/cf_hrms${url}`, { method, headers: { 'Content-Type': 'application/json', ...(who ? { Authorization: `Bearer ${who.token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    let json = null;
    try { json = await res.json(); } catch { /* no body */ }
    return { status: res.status, json };
  };
  const must = async (who, method, url, body) => {
    const r = await call(who, method, url, body);
    if (r.status !== 200) throw new Error(`${method} ${url}: ${r.status} ${JSON.stringify(r.json)}`);
    return r.json;
  };

  /* ── setup: components, structures, salaries, claim types ─────────── */
  await must(U.HR, 'POST', '/payroll/setup');
  const CO = Object.fromEntries((await must(U.HR, 'GET', '/payroll/components')).components.map((k) => [k.code, k]));
  ok(['NOTICE_PAY', 'NOTICE_REC', 'LEAVE_ENC', 'GRATUITY', 'ATT_PENALTY', 'REIMB', 'REIMB_TAX', 'REIMB_LTA', 'FLEXI_PAY'].every((k) => CO[k]?.readyMade)
    && CO.GRATUITY.exemptionRule === 'GRATUITY' && CO.LEAVE_ENC.exemptionRule === 'LEAVE_ENCASHMENT' && CO.REIMB_LTA.exemptionRule === 'LTA' && CO.REIMB.taxable === 'NO' && !CO.GRATUITY.inPfWage,
  'P3b ready-made components: notice pay / recovery, leave encashment, gratuity (with their exemption rules), attendance penalty, three reimbursements, flexible balance');
  const S = (await must(U.HR, 'POST', '/payroll/structures', { code: `${TAG}S`, name: `${TAG} Basic half`, lines: [
    { componentId: CO.BASIC.id, formula: '50% of CTC' }, { componentId: CO.HRA.id, formula: '50% of BASIC' }, { componentId: CO.SPECIAL.id, formula: 'balance' }] })).structure;
  const SK = (await must(U.HR, 'POST', '/payroll/structures', { code: `${TAG}K`, name: `${TAG} With NPS`, lines: [
    { componentId: CO.BASIC.id, formula: '50% of CTC' }, { componentId: CO.NPS_ER.id, formula: '40% of BASIC' }, { componentId: CO.SPECIAL.id, formula: 'balance' }] })).structure;
  const salary = (e, ctc, structureId = S.id, pfMode = 'NONE') => must(U.HR, 'POST', '/payroll/salaries', { employeeId: e, annualCtc: ctc, structureId, effectiveFrom: '2025-04-01', pfMode, reason: 'Test' });
  for (const [k, ctc] of [['T', 312000], ['P', 1800000], ['R', 2400000], ['C', 960000], ['H', 960000], ['G1', 960000], ['G2', 960000], ['G3', 2400000], ['G4', 960000]]) await salary(E[k], ctc);
  await salary(E.K, 3600000, SK.id, 'FULL');
  // C on the old regime for 2025-26; R's Form 10E worksheet READY with relief 5,000; P's car.
  await db.query("INSERT INTO hrms_tax_profiles (company_id, employee_id, tax_year, regime, regime_set_how) VALUES (?, ?, '2025-26', 'OLD', 'HR')", [COMPANY, E.C]);
  await db.query("INSERT INTO hrms_tax_relief_10e (company_id, employee_id, tax_year, relief, status) VALUES (?, ?, '2025-26', 5000, 'READY')", [COMPANY, E.R]);
  await must(U.HR, 'POST', '/tax/2025-26/perquisites', { employeeId: E.P, kind: 'CAR', fromDate: '2025-04-01', facts: { ownedBy: 'EMPLOYER', use: 'MIXED', engine: 'ABOVE_1600', runningCostsBy: 'EMPLOYER', chauffeur: false } });
  const types = await must(U.HR, 'POST', '/payroll/claim-types/setup');
  const TY = Object.fromEntries(types.types.map((t) => [t.code, t]));
  ok(types.made.length === 5 && TY.LTA.taxTreatment === 'LTA' && TY.MEALS.taxTreatment === 'TAXABLE' && TY.FUEL.yearlyLimit === 36000 && TY.PHONE.taxRule, 'the five ready-made claim types, each with its tax treatment and the rule in words');
  ok((await call(U.HR, 'POST', '/payroll/claim-types', { code: 'GYM', name: 'Gym', taxTreatment: 'EXEMPT' })).status === 422, 'an EXEMPT type without its rule in words: refused');

  const P = (r) => Object.fromEntries(r.people.map((p) => [p.employee.id, p]));
  const runs = {};
  const linesOf = async (runId, person) => (await must(U.HR, 'GET', `/payroll/runs/${runId}/people/${person.id}`)).lines;
  const finish = async (run) => {
    await must(U.HR, 'POST', `/payroll/runs/${run.id}/lock`);
    await must(U.HR, 'POST', `/payroll/runs/${run.id}/release`);
    await must(U.HR, 'POST', `/payroll/runs/${run.id}/paid`, { note: 'test' });
  };
  const create = async (m) => { const run = (await must(U.HR, 'POST', '/payroll/runs', { month: m })).run; runs[m] = run; return run; };
  const monthRun = async (m, beforeCalc = null) => {
    const run = await create(m);
    if (beforeCalc) await beforeCalc(run);
    const calc = await must(U.HR, 'POST', `/payroll/runs/${run.id}/calculate`);
    await finish(run);
    return calc;
  };
  const claim = (who, body) => call(who, 'POST', '/user/me/claims', { bills: [PDF], ...body });

  /* ══ 2. claims, April ════════════════════════════════════════════════ */
  section('[2] Claims: limits, bills, rejection, a lower amount, the run');
  const fuel = await claim(U.C, { claimTypeId: TY.FUEL.id, billDate: '2025-04-10', amount: 30000, description: 'Fuel, April' });
  ok(fuel.status === 200 && fuel.json.claim.status === 'RECOMMENDED' && !fuel.json.claim.withManager && fuel.json.claim.bills.length === 1, 'C files fuel 30,000 with a bill; no manager in the chart → straight to HR', JSON.stringify(fuel.json?.claim?.status));
  const over = await claim(U.C, { claimTypeId: TY.FUEL.id, billDate: '2025-04-12', amount: 7000 });
  ok(over.status === 409 && over.json.code === 'OVER_LIMIT' && /6,000 is left/.test(over.json.message), 'another 7,000: above the 36,000 limit — 6,000 left, said', JSON.stringify(over.json));
  const noBill = await call(U.C, 'POST', '/user/me/claims', { claimTypeId: TY.PHONE.id, billDate: '2025-04-12', amount: 1000, bills: [] });
  ok(noBill.status === 422 && /needs the bills/.test(JSON.stringify(noBill.json)), 'phone without a bill: refused (bills needed)');
  const meals = await claim(U.C, { claimTypeId: TY.MEALS.id, billDate: '2025-04-15', amount: 2000 });
  ok((await call(U.HR, 'POST', `/payroll/claims/${meals.json.claim.id}/reject`, {})).status === 422, 'a rejection needs a note');
  const rej = await must(U.HR, 'POST', `/payroll/claims/${meals.json.claim.id}/reject`, { note: 'Team lunch: not a reimbursement' });
  ok(rej.claim.status === 'REJECTED' && rej.claim.decisionNote, 'HR rejects the meals claim, with the note');
  const apr = await create('2025-04');
  ok((await call(U.HR, 'POST', `/payroll/claims/${fuel.json.claim.id}/approve`, { amount: 25000 })).status === 422, 'approving less than claimed needs a note');
  ok((await call(U.HR, 'POST', `/payroll/claims/${fuel.json.claim.id}/approve`, { amount: 31000, note: 'x' })).status === 422, 'never more than claimed');
  const appr = await must(U.HR, 'POST', `/payroll/claims/${fuel.json.claim.id}/approve`, { amount: 25000, note: 'Personal trips taken out' });
  ok(appr.claim.status === 'APPROVED' && appr.claim.approvedAmount === 25000 && appr.claim.payMonth === '2025-04', 'approved at 25,000; pays in the April 2025 run (the next run)', appr.claim.payMonth);
  const aprCalc = await must(U.HR, 'POST', `/payroll/runs/${apr.id}/calculate`);
  const pa = P(aprCalc);
  const cL = await linesOf(apr.id, pa[E.C]);
  ok(cL.some((l) => l.code === 'REIMB' && l.kind === 'REIMBURSEMENT' && l.amount === 25000 && l.source === 'CLAIM') && pa[E.C].reimbursements === 25000, 'April: a REIMBURSEMENT line REIMB 25,000 (source CLAIM)', JSON.stringify(cL.filter((l) => l.kind === 'REIMBURSEMENT')));
  /* ── 3. perquisites and relief in TDS (April) ── */
  section('[3] Perquisites and Form 10E relief in the TDS');
  ok(pa[E.P].tds === 13066, 'P: the car (28,800) in the TDS — 1,56,790 ÷ 12 = 13,066 (12,567 without it)', String(pa[E.P].tds));
  ok(pa[E.R].tds === 23958, 'R: Form 10E relief 5,000 given in the TDS (s.192(2A)) — 2,87,500 ÷ 12 = 23,958 (24,375 without)', String(pa[E.R].tds));
  const rTax = (await must(U.HR, 'GET', `/payroll/runs/${apr.id}/people/${pa[E.R].id}`)).person.tax;
  ok(rTax.lines.some((l) => /relief for arrears/.test(l.label) && l.amount === -5000 && /192\(2A\)/.test(l.label)), 'the TDS working names the relief and the employer rule s.192(2A)');
  await finish(apr);
  ok((await must(U.C, 'GET', '/user/me/claims')).claims.find((x) => x.id === fuel.json.claim.id).status === 'PAID', 'April marked paid: the claim is PAID');

  /* ══ 4. May: LTA journey 1; manager's first look ═══════════════════ */
  section('[4] Leave travel and the block of four years; the manager looks first');
  const lta = (date, amount = 10000) => claim(U.C, { claimTypeId: TY.LTA.id, billDate: date, amount, journeys: [{ from: 'Hyderabad', to: 'Goa', startDate: date, mode: 'AIR' }] });
  ok((await call(U.C, 'POST', '/user/me/claims', { claimTypeId: TY.LTA.id, billDate: '2025-05-05', amount: 1000, bills: [PDF] })).status === 422, 'leave travel without the journeys: refused');
  const l1 = (await lta('2025-05-05')).json.claim;
  await create('2025-05');
  const l1a = (await must(U.HR, 'POST', `/payroll/claims/${l1.id}/approve`, {})).claim;
  ok(l1a.ltaExempt === true && /1 of 2 in the block 2022–2025/.test(l1a.ltaNote), 'May journey: exempt — journey 1 of 2 in the block 2022–2025', l1a.ltaNote);
  if (U.X && U.M) {
    const xc = (await claim(U.X, { claimTypeId: TY.BOOKS.id, billDate: '2025-05-02', amount: 800 })).json.claim;
    ok(xc.status === 'SUBMITTED' && xc.withManager, 'X (who has a manager) files a claim: SUBMITTED, with the manager first');
    const feed = await must(U.M, 'GET', '/user/me/approvals');
    ok(feed.items.some((i) => i.kind === 'CLAIM' && i.id === xc.id), 'the manager’s Approvals list it (kind CLAIM)');
    const det = await must(U.M, 'GET', `/user/me/approvals/claim/${xc.id}`);
    ok(det.request.amount === 800 && det.request.bills.length === 1 && det.context.limit === 12000, 'the manager reads it, with its bill and the limit');
    ok((await call(U.M, 'GET', `/user/me/approvals/claim/${xc.id}/bills/${det.request.bills[0].id}`)).status === 200, 'and opens the bill');
    ok((await call(U.C, 'GET', `/user/me/approvals/claim/${xc.id}`)).status === 404 && (await call(U.C, 'GET', `/user/me/approvals/claim/${xc.id}/bills/${det.request.bills[0].id}`)).status === 404, 'another employee: not found (neither the claim nor its bill)');
    const md = await must(U.M, 'POST', `/user/me/approvals/claim/${xc.id}/approve`, { note: 'Fine' });
    ok(md.request.status === 'RECOMMENDED', 'the manager agrees: RECOMMENDED, with HR');
    ok((await call(U.M, 'POST', `/payroll/claims/${xc.id}/approve`, {})).status === 403, 'the manager cannot approve the amount (HR’s route)');
  } else ok(true, 'no person with a manager here: the manager path is skipped');
  const may = await must(U.HR, 'POST', `/payroll/runs/${runs['2025-05'].id}/calculate`);
  const cMay = await linesOf(runs['2025-05'].id, P(may)[E.C]);
  ok(cMay.some((l) => l.code === 'REIMB_LTA' && l.amount === 10000 && l.source === 'CLAIM'), 'May: the leave-travel claim paid as REIMB_LTA (exemption rule LTA)');
  await finish(runs['2025-05']);

  /* ══ 5. June: attendance closed ═════════════════════════════════════ */
  section('[5] Attendance into the run: LOP, overtime, penalty (June); refused when not closed, override (July)');
  const lwp = await one("SELECT id FROM hrms_leave_types WHERE company_id = ? AND is_paid = 0 AND deleted_at IS NULL ORDER BY id LIMIT 1", [COMPANY]);
  const lr = await ins("INSERT INTO hrms_leave_requests (company_id, employee_id, leave_type_id, from_date, to_date, quantity, status, days_json) VALUES (?, ?, ?, '2025-06-12', '2025-06-12', 1, 'APPROVED', ?)",
    [COMPANY, E.T, lwp.id, JSON.stringify([{ date: '2025-06-12', amount: 1 }])]);
  const rec = (date, status, absent, leave, leaveRequest = null) => db.query(
    'INSERT INTO hrms_attendance_records (company_id, employee_id, attendance_date, status, absent_value, leave_value, leave_request_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [COMPANY, E.T, date, status, absent, leave, leaveRequest]);
  await rec('2025-06-10', 'ABSENT', 1, 0);
  await rec('2025-06-11', 'HALF_DAY', 0.5, 0);
  await rec('2025-06-12', 'LEAVE', 0, 1, lr);
  await db.query(`INSERT INTO hrms_attendance_penalties (company_id, employee_id, penalty_date, period_month, rule_key, source_key, action, quantity, amount, reason, status) VALUES
    (?, ?, '2025-06-20', '2025-06', 'LATE_MARKS', ?, 'LOP', 0.5, 0, 'late marks', 'APPLIED'), (?, ?, '2025-06-25', '2025-06', 'LATE_MARKS', ?, 'AMOUNT', 0, 300, 'late marks', 'APPLIED')`,
  [COMPANY, E.T, `${TAG}:1`, COMPANY, E.T, `${TAG}:2`]);
  const snap = (month, people) => JSON.stringify({ month, from: `${month}-01`, to: `${month}-30`, calendarDays: 30, live: true, liveFrom: '2025-06-01', people, totals: {} });
  await db.query("INSERT INTO hrms_attendance_months (company_id, period_month, status, summary_json, closed_at) VALUES (?, '2025-06', 'CLOSED', ?, NOW())", [COMPANY, snap('2025-06', [{
    employeeId: E.T, daysInEmployment: 30, lopDays: 3, payableDays: 27, ncpDays: 3, esiDays: 27, absentLop: 1.5, leave: { paid: 0, unpaid: 1, byType: [] },
    overtime: { minutes: 600, hours: 10, multiplier: 2 }, penalties: { leaveDays: 0, lopDays: 0.5, amount: 300, warnings: 0 },
  }])]);
  const jun = await create('2025-06');
  const state = (await must(U.HR, 'GET', `/payroll/runs/${jun.id}`)).attendance;
  ok(state.live && state.status === 'CLOSED' && state.mode === 'ATTENDANCE', 'June: attendance live and closed — the run reads it');
  const junCalc = await must(U.HR, 'POST', `/payroll/runs/${jun.id}/calculate`);
  const pT = P(junCalc)[E.T];
  const tL = await linesOf(jun.id, pT);
  const amt = (ls, code) => ls.filter((l) => l.code === code).reduce((s, l) => s + l.amount, 0);
  ok(pT.lopDays === 3 && pT.payableDays === 27, 'T: 3 LOP days (unpaid leave 1 + absent 1.5 + penalty 0.5), 27 paid', `${pT.lopDays} / ${pT.payableDays}`);
  ok(amt(tL, 'BASIC') === 11700 && amt(tL, 'HRA') === 5850 && amt(tL, 'SPECIAL') === 5850, 'Basic 11,700, HRA 5,850, Special 5,850 (27/30)');
  const ot = tL.find((l) => l.code === 'OVERTIME');
  ok(ot && ot.amount === 1250 && ot.source === 'ATTENDANCE' && /10 h × 2 × ₹62.5/.test(ot.basis), 'overtime: 10 h × 2 × ₹62.50 an hour ((BASIC + DA) / 26 / 8) = 1,250', JSON.stringify(ot));
  const pen = tL.find((l) => l.code === 'ATT_PENALTY');
  ok(pen && pen.amount === 300 && pen.kind === 'DEDUCTION' && pen.source === 'ATTENDANCE', 'penalty amount 300: a deduction');
  ok(amt(tL, 'PT') === 200 && pT.net === 24150, 'PT 200; net 24,650 − 200 − 300 = 24,150', String(pT.net));
  ok(pT.warnings.some((w) => w.code === 'LOP' && /closed attendance/.test(w.text)), 'the LOP warning says it came from the closed attendance');
  await finish(jun);

  // July: live, NOT closed.
  const jul = await create('2025-07');
  const refusedCalc = await call(U.HR, 'POST', `/payroll/runs/${jul.id}/calculate`);
  ok(refusedCalc.status === 409 && refusedCalc.json.code === 'ATTENDANCE_OPEN' && /Close attendance for July 2025 first/.test(refusedCalc.json.message), 'July not closed: calculating is refused — "Close attendance for July 2025 first"', refusedCalc.json?.message);
  ok((await call(U.HR, 'POST', `/payroll/runs/${jul.id}/attendance-override`, { reason: 'x' })).status === 409, 'paying without attendance needs a reason');
  ok((await call(U.CLERK, 'POST', `/payroll/runs/${jul.id}/attendance-override`, { reason: 'Device was down all month' })).status === 403, 'a clerk without pay view cannot');
  await must(U.HR, 'POST', `/payroll/runs/${jul.id}/attendance-override`, { reason: 'Device was down all month' });
  const julCalc = await must(U.HR, 'POST', `/payroll/runs/${jul.id}/calculate`);
  ok(julCalc.attendance.mode === 'OVERRIDE' && julCalc.run.totals.attendance.override === 'Device was down all month' && P(julCalc)[E.T].gross === 26000, 'override with a reason: calculated without attendance (T full: 26,000), the reason kept on the run');
  await db.query("INSERT INTO hrms_attendance_months (company_id, period_month, status, summary_json, closed_at) VALUES (?, '2025-07', 'CLOSED', ?, NOW())",
    [COMPANY, snap('2025-07', [{ employeeId: E.T, daysInEmployment: 31, lopDays: 0, payableDays: 31, overtime: { minutes: 0, hours: 0, multiplier: 2 }, penalties: { amount: 0, lopDays: 0 } }])]);
  await new Promise((r) => { setTimeout(r, 1100); });
  await db.query("UPDATE hrms_attendance_months SET closed_at = NOW() WHERE company_id = ? AND period_month = '2025-07'", [COMPANY]);
  const staleRun = await must(U.HR, 'GET', `/payroll/runs/${jul.id}`);
  const lockStale = await call(U.HR, 'POST', `/payroll/runs/${jul.id}/lock`);
  ok(staleRun.stale.some((s) => /attendance/.test(s)) && lockStale.status === 409 && lockStale.json.code === 'STALE', 'July closed after the calculation: the run is stale (it watches the month’s status) — lock refused', JSON.stringify(staleRun.stale));
  await must(U.HR, 'DELETE', `/payroll/runs/${jul.id}/attendance-override`);
  const jul2 = await must(U.HR, 'POST', `/payroll/runs/${jul.id}/calculate`);
  ok(jul2.attendance.mode === 'ATTENDANCE', 'calculated again: now from the closed July');
  await finish(jul);
  // Attendance not live from August (the rest of the test is about other things).
  await db.query('UPDATE hrms_attendance_settings SET live_from = NULL WHERE company_id = ?', [COMPANY]);

  /* ══ 6. Aug–Sep; LTA 2; G4 leaves ═══════════════════════════════════ */
  const l2 = (await lta('2025-08-01')).json.claim;
  await create('2025-08');
  const l2a = (await must(U.HR, 'POST', `/payroll/claims/${l2.id}/approve`, {})).claim;
  ok(l2a.ltaExempt === true && /2 of 2/.test(l2a.ltaNote), 'August journey: exempt — 2 of 2 in the block');
  await must(U.HR, 'POST', `/payroll/runs/${runs['2025-08'].id}/calculate`);
  await finish(runs['2025-08']);
  await monthRun('2025-09');

  /* ══ 7. Full and final ═══════════════════════════════════════════════ */
  section('[6] Full and final: gratuity, notice, leave encashment, TDS, the run');
  await must(U.HR, 'PUT', '/payroll/policy', { flexiYearEnd: 'LAPSE' }); // the flexible balance is checked in March, not here
  const list = await must(U.HR, 'GET', '/payroll/settlements');
  ok([E.G1, E.G2, E.G3, E.G4].every((id) => list.people.some((p) => p.employee.id === id && !p.settlement)), 'Exits › Full and final lists the four who left, none settled yet');
  const g4claim = (await claim(U.G4, { claimTypeId: TY.PHONE.id, billDate: '2025-09-10', amount: 1500 })).json.claim;
  const oct = await create('2025-10');
  ok((await must(U.HR, 'POST', `/payroll/claims/${g4claim.id}/approve`, {})).claim.payMonth === '2025-10', 'G4’s claim (approved after September was locked) pays in October');
  const save = (e, inputs) => must(U.HR, 'PUT', `/payroll/settlements/employees/${e}`, inputs);
  const s1 = (await save(E.G1, { noticeDays: 30, encashDays: 0, bonus: [{ label: 'Diwali bonus', amount: 10000 }], recoveries: [{ kind: 'LOAN', label: 'Salary advance', amount: 5000 }] })).settlement;
  const st1 = s1.statement;
  ok(st1.service.years === 4 && st1.service.months === 11 && !st1.gratuity.eligible && !st1.items.some((i) => i.code === 'GRATUITY'), 'G1, 4 years 11 months: no gratuity');
  ok(st1.notice.action === 'RECOVER' && st1.notice.shortDays === 11 && st1.items.find((i) => i.code === 'NOTICE_REC')?.amount === 29333, 'G1 resigned, 19 of 30 days: 29,333 notice pay recovered', JSON.stringify(st1.notice));
  ok(st1.items.find((i) => i.code === 'BONUS')?.amount === 10000 && st1.items.find((i) => i.code === 'LOAN')?.amount === 5000 && st1.totals.settlement === -24333, 'bonus 10,000; loan 5,000 recovered; the settlement adds −24,333');
  ok(st1.payMonth === '2025-10' && s1.status === 'DRAFT', 'a DRAFT, paying in October 2025 (the exit month)');
  const s2 = (await save(E.G2, { noticeDays: 0, encashDays: 10 })).settlement.statement;
  ok(s2.gratuity.eligible && s2.gratuity.years === 5 && s2.items.find((i) => i.code === 'GRATUITY')?.amount === 115385, 'G2, 5 years: gratuity 1,15,385');
  ok(s2.items.find((i) => i.code === 'LEAVE_ENC')?.amount === 15385 && s2.encashment.rate === 1538.46 && s2.encashment.typed === 10, 'G2: 10 days × 1,538.46 (BASIC / 26) = 15,385');
  ok(Array.isArray(s2.encashment.types) && s2.encashment.types.every((t) => t.days === (t.capDays != null ? Math.min(t.available, t.capDays) : t.available)), 'the encashable types of the leave policy are listed with their balance (at most the cap): the days typed win');
  const p3 = await must(U.HR, 'POST', `/payroll/settlements/employees/${E.G3}/preview`, { noticeDays: 30, encashDays: 300 });
  const st3 = p3.statement;
  ok(st3.gratuity.years === 8 && st3.gratuity.amount === 461538, 'G3, 7 years 7 months → 8 years: gratuity 4,61,538');
  ok(st3.encashment.amount === 1153845 && st3.encashment.exempt.formulaAmount === 700000 && st3.encashment.exempt.limbC === 1000000, 'G3: 300 days = 11,53,845; exemption formula 7,00,000 (210 days; 10 months 10,00,000)');
  ok(st3.notice.action === 'PAY' && st3.items.find((i) => i.code === 'NOTICE_PAY')?.amount === 73333, 'G3 removed with 19 of 30 days: 73,333 notice pay paid');
  ok(st3.tds && st3.tds.exemptions.some((x) => /Gratuity/.test(x.label) && x.exempt === 461538) && st3.tds.exemptions.some((x) => /Leave encashment/.test(x.label) && x.exempt === 700000), 'the TDS working: gratuity exempt 4,61,538, leave encashment exempt 7,00,000', JSON.stringify(st3.tds?.exemptions));
  await save(E.G3, { noticeDays: 30, encashDays: 300 });
  // HR's own: HR2 is linked to G2 for this check.
  await db.query('UPDATE hrms_employees SET user_id = ? WHERE id = ?', [U.HR2.id, E.G2]);
  const s2row = (await must(U.HR, 'GET', `/payroll/settlements/employees/${E.G2}`)).settlement;
  const own = await call(U.HR2, 'POST', `/payroll/settlements/${s2row.id}/approve`);
  ok(own.status === 403 && own.json.code === 'OWN_RECORD', 'HR never approves their own full and final (403 OWN_RECORD)');
  await db.query('UPDATE hrms_employees SET user_id = NULL WHERE id = ?', [E.G2]);
  for (const e of [E.G1, E.G2, E.G3]) {
    const sid = (await must(U.HR, 'GET', `/payroll/settlements/employees/${e}`)).settlement.id;
    const a = await must(U.HR, 'POST', `/payroll/settlements/${sid}/approve`);
    ok(a.settlement.status === 'APPROVED' && a.settlement.payMonth === '2025-10', `approved: pays in October (${e === E.G1 ? 'G1' : e === E.G2 ? 'G2' : 'G3'})`);
  }
  ok((await must(U.G3, 'GET', '/user/me/settlement')).settlement?.statement?.gratuity?.amount === 461538, 'G3 sees the approved statement in My pay');
  ok((await call(U.G3, 'GET', '/user/me/settlement/file')).json?.mimeType === 'application/pdf', '… and its PDF');
  ok((await must(U.C, 'GET', '/user/me/settlement')).settlement === null, 'C (not leaving) has none');
  const s4 = (await save(E.G4, { noticeDays: 0, encashDays: 5 })).settlement;
  ok(s4.statement.claims.approved.some((x) => x.id === g4claim.id) && s4.statement.payMonth === '2025-10' && /September 2025 is locked/.test(s4.statement.notes.join(' ')), 'G4 (left 15 Sep): September locked → pays in October on its own; the approved claim is listed', s4.statement.notes.join(' | '));
  await must(U.HR, 'POST', `/payroll/settlements/${s4.id}/approve`);
  const pdf = await must(U.HR, 'GET', `/payroll/settlements/${s4.id}/file`);
  ok(pdf.mimeType === 'application/pdf' && Buffer.from(pdf.contentBase64, 'base64').subarray(0, 5).toString() === '%PDF-', 'the statement PDF');

  const octCalc = await must(U.HR, 'POST', `/payroll/runs/${oct.id}/calculate`);
  const po = P(octCalc);
  ok(po[E.G1].net === 27079, 'G1 in October: 51,612 + 10,000 − PT 200 − 29,333 − 5,000 = 27,079', String(po[E.G1].net));
  const g1L = await linesOf(oct.id, po[E.G1]);
  ok(g1L.filter((l) => l.source === 'SETTLEMENT').length === 3 && amt(g1L, 'PT') === 200, 'G1: three SETTLEMENT lines; PT on the salary only (200)');
  const g4 = po[E.G4];
  const g4L = await linesOf(oct.id, g4);
  ok(g4 && g4.net === 9192 && amt(g4L, 'LEAVE_ENC') === 7692 && amt(g4L, 'REIMB') === 1500 && !g4L.some((l) => l.code === 'PT' || l.code === 'BASIC') && g4.warnings.some((w) => w.code === 'SETTLEMENT_ONLY'),
    'G4 (left in September): only the settlement — 7,692 + the claim 1,500 = 9,192; no salary, no PT', JSON.stringify(g4L.map((l) => `${l.code} ${l.amount}`)));
  const g3L = await linesOf(oct.id, po[E.G3]);
  ok(amt(g3L, 'GRATUITY') === 461538 && amt(g3L, 'LEAVE_ENC') === 1153845 && amt(g3L, 'NOTICE_PAY') === 73333, 'G3: gratuity, leave encashment and notice pay are October lines');
  await finish(oct);
  const g3Tds = await one(`SELECT SUM(p.tds_amount) AS t FROM hrms_pay_run_people p JOIN hrms_pay_runs r ON r.id = p.run_id AND r.deleted_at IS NULL WHERE p.company_id = ? AND p.employee_id = ? AND p.deleted_at IS NULL AND r.period_month BETWEEN '2025-04' AND '2025-10'`, [COMPANY, E.G3]);
  ok(Number(g3Tds.t) === 162490, 'G3: the TDS of April–October adds up to the year’s tax 1,62,490 (October, the last month, takes the balance)', String(g3Tds.t));
  ok((await one('SELECT status FROM hrms_pay_settlements WHERE company_id = ? AND employee_id = ? AND deleted_at IS NULL', [COMPANY, E.G1])).status === 'PAID'
    && (await one('SELECT status FROM hrms_pay_claims WHERE id = ?', [g4claim.id])).status === 'PAID', 'October paid: the settlements and G4’s claim are PAID');
  const unap = await call(U.HR, 'POST', `/payroll/settlements/${s4.id}/unapprove`, {});
  ok(unap.status === 409, 'a paid settlement cannot be taken back');

  /* ══ 8. Nov–Mar; LTA 3; flexible balance in March ═══════════════════ */
  section('[7] The rest of the year: the third journey, the flexible balance in March, Form 16');
  await monthRun('2025-11');
  const l3 = (await lta('2025-12-01')).json.claim;
  await create('2025-12');
  const l3a = (await must(U.HR, 'POST', `/payroll/claims/${l3.id}/approve`, {})).claim;
  ok(l3a.ltaExempt === false && /2 of the 2 journeys/.test(l3a.ltaNote), 'December journey: the block’s two journeys are used — paid as taxable', l3a.ltaNote);
  const dec = await must(U.HR, 'POST', `/payroll/runs/${runs['2025-12'].id}/calculate`);
  ok((await linesOf(runs['2025-12'].id, P(dec)[E.C])).some((l) => l.code === 'REIMB_TAX' && l.amount === 10000), 'December: paid as REIMB_TAX');
  await finish(runs['2025-12']);
  await monthRun('2026-01');
  await monthRun('2026-02');
  await must(U.HR, 'PUT', '/payroll/policy', { flexiYearEnd: 'PAY_TAXABLE' });
  const mar = await monthRun('2026-03');
  const cMar = await linesOf(runs['2026-03'].id, P(mar)[E.C]);
  const flexi = cMar.filter((l) => l.code === 'FLEXI_PAY');
  ok(flexi.length === 5 && flexi.reduce((s, l) => s + l.amount, 0) === 83400 && flexi.every((l) => l.kind === 'EARNING'), 'March: the unclaimed flexible balance paid, taxed — 11,000 + 24,000 + 10,000 + 26,400 + 12,000 = 83,400', JSON.stringify(flexi.map((l) => l.amount)));

  // Form 16 (actuals): P's car on Form 12BA, R's relief, C's leave travel, K's contributions above the limit.
  const { actuals } = await yearActuals(db, COMPANY, '2025-26', [E.P, E.R, E.C, E.K]);
  const aP = actuals.get(E.P);
  const car = aP.perquisites.find((x) => x.row === 2);
  ok(car && car.nature === 'Cars / Other automotive' && car.valueAsPerRules === 28800 && car.recovered === 0 && car.value === 28800, 'Form 12BA for P: "2. Cars / Other automotive", value 28,800, recovered 0, taxable 28,800', JSON.stringify(aP.perquisites));
  const aR = actuals.get(E.R);
  const { rules: R25 } = await loadRules(db, '2025-26');
  const rowsR = partBRows(aR, formsOf(R25));
  ok(aR.relief === 5000 && rowsR.find((r) => r.no === '18')?.amount === 5000 && rowsR.find((r) => r.no === '19')?.amount === aR.computation.totalTax - 5000 && aR.computation.totalTax === 331780, 'Form 16 Part B for R: row 18 relief u/s 89 = 5,000; row 19 = the year’s tax − 5,000 (3,31,780: 24,00,000 + the March flexible balance 1,38,400 − 75,000 = 24,63,400 → 3,19,020 + cess 12,760.80)', JSON.stringify({ relief: aR.relief, tax: aR.computation.totalTax, rows: rowsR.filter((r) => ['17', '18', '19'].includes(r.no)) }));
  const aC = actuals.get(E.C);
  ok(aC.regime === 'OLD' && aC.computation.exemptions.find((x) => x.key === 'exempt_lta')?.exempt === 20000, 'C (old regime): leave travel exempt 20,000 (the two journeys of the block; the third taxed)', JSON.stringify(aC.computation.exemptions));
  const aK = actuals.get(E.K);
  ok(aK.retirement?.total === 936000 && aK.retirement.excess === 186000 && aK.perquisites.some((x) => x.row === 17 && x.value === 186000), 'K: employer PF 2,16,000 + NPS 7,20,000 = 9,36,000 → 1,86,000 a perquisite (Form 12BA row 17)', JSON.stringify(aK.retirement));
  await must(U.HR, 'PUT', `/tax/2025-26/retirement/${E.K}`, { previousExcess: 100000, previousAccretion: 8000, ratePct: 8.25 });
  const ret = await must(U.HR, 'GET', '/tax/2025-26/retirement');
  const k = ret.people.find((x) => x.employee.id === E.K);
  ok(k && k.total === 936000 && k.excess === 186000 && k.accretion === 16583, 'Tax › retirement: K 9,36,000, 1,86,000 above, accretion (93,000 + 1,08,000) × 8.25% = 16,583', JSON.stringify(k));
  const q4 = await quarterData(db, { companyId: COMPANY, userId: U.HR.id }, '2025-26', 'Q4');
  ok(q4.annexureII.find((x) => x.employee.id === E.R)?.relief89 === 5000, 'Annexure II: R’s relief column 5,000');

  /* ══ 9. rights, privacy, review fixes ══════════════════════════════ */
  section('[8] Rights and privacy; HR on their own records; audit');
  const st = async (who, method, url, body) => (await call(who, method, url, body)).status;
  ok(await st(U.CLERK, 'GET', '/payroll/claims') === 403 && await st(U.CLERK, 'GET', '/payroll/settlements') === 403 && await st(U.CLERK, 'GET', '/tax/2025-26/retirement') === 403 && await st(U.CLERK, 'GET', '/payroll/policy') === 200,
    'payroll without pay view: no claims, settlements or retirement amounts; the policy (no amounts) yes');
  ok(await st(U.DH, 'GET', '/payroll/claims') === 403 && await st(U.T, 'GET', '/payroll/claims') === 403 && await st(U.T, 'GET', `/payroll/settlements/employees/${E.G3}`) === 403, 'a department head and an employee: none of the HR routes');
  const cMine = await must(U.C, 'GET', '/user/me/claims?year=2025-26');
  ok(cMine.claims.every((x) => x.employee.id === E.C) && cMine.types.find((t) => t.code === 'FUEL').used.approved === 25000, 'an employee sees only their own claims, with this year’s use');
  ok(await st(U.T, 'GET', `/user/me/claims/${fuel.json.claim.id}/bills/${fuel.json.claim.bills[0].id}`) === 404 && await st(U.T, 'POST', `/user/me/claims/${fuel.json.claim.id}/withdraw`) === 404, 'another person’s claim and bill: not found');
  const hClaim = await ins("INSERT INTO hrms_pay_claims (company_id, employee_id, claim_type_id, tax_year, bill_date, amount, status, created_by) VALUES (?, ?, ?, '2025-26', '2025-12-01', 900, 'RECOMMENDED', ?)", [COMPANY, E.H, TY.BOOKS.id, U.HR.id]);
  const ownC = await call(U.HR, 'POST', `/payroll/claims/${hClaim}/approve`, {});
  ok(ownC.status === 403 && ownC.json.code === 'OWN_RECORD' && /your own claim/.test(ownC.json.message), 'HR never approves their own claim (403 OWN_RECORD, in words)');
  const hLine = await ins("INSERT INTO hrms_tax_declaration_lines (company_id, employee_id, tax_year, kind, declared_amount, status) VALUES (?, ?, '2025-26', 'PPF', 10000, 'SUBMITTED')", [COMPANY, E.H]);
  ok(await st(U.HR, 'POST', `/tax/declaration-lines/${hLine}/verify`, {}) === 403, 'review fix: HR cannot verify their own proof');
  const bulk = await must(U.HR, 'POST', '/tax/2025-26/proofs/bulk-accept', { lineIds: [hLine] });
  ok(bulk.accepted.length === 0 && /your own/.test(bulk.skipped[0]?.why ?? ''), 'review fix: bulk accept skips their own, said');
  const ownDecl = await call(U.HR, 'POST', `/tax/2025-26/declarations/${E.H}`, { kind: 'PPF', amount: 5000 });
  ok(ownDecl.status === 403 && ownDecl.json.code === 'OWN_RECORD', 'review fix: HR cannot add their own declaration from the HR side (outside the window)');
  await ins("INSERT INTO hrms_tax_declaration_lines (company_id, employee_id, tax_year, kind, declared_amount, status) VALUES (?, ?, '2025-26', 'PPF', 10000, 'SUBMITTED')", [COMPANY, E.C]);
  const audit0 = Number((await one("SELECT COUNT(*) AS n FROM hrms_audit_log WHERE company_id = ? AND entity_type = 'hrms_pay_salary_read'", [COMPANY])).n);
  await must(U.HR, 'GET', '/tax/2025-26/proofs?status=ALL');
  await must(U.HR, 'GET', '/tax/2025-26/forms');
  await must(U.HR, 'GET', '/payroll/claims?status=ALL');
  const audit1 = Number((await one("SELECT COUNT(*) AS n FROM hrms_audit_log WHERE company_id = ? AND entity_type = 'hrms_pay_salary_read'", [COMPANY])).n);
  ok(audit1 - audit0 === 2, 'review fix: the proof queue (C’s line) writes a pay-read audit row (the forms list has none to show yet); the claims list one', `${audit1 - audit0}`);
  const wd = (await claim(U.C, { claimTypeId: TY.BOOKS.id, billDate: '2026-03-01', amount: 500 })).json.claim;
  ok((await must(U.C, 'POST', `/user/me/claims/${wd.id}/withdraw`)).claim.status === 'WITHDRAWN', 'a waiting claim can be withdrawn by the person');
  ok((await call(U.C, 'POST', `/user/me/claims/${fuel.json.claim.id}/withdraw`)).status === 409, 'a paid one cannot');
} catch (err) {
  ok(false, 'the run finished', `${err.message} ${(err.stack ?? '').split('\n').slice(1, 3).join(' ')}`);
} finally {
  if (server?.close) await server.close();
  try { await db.rollback(); } catch { /* nothing to undo */ }
  db.release();
  pool.query = real.query;
  pool.execute = real.execute;
  pool.getConnection = real.getConnection;
  forgetAccess();
}

section('[9] Nothing is left behind');
{
  const after = await worldCount();
  const moved = Object.keys(before).filter((k) => after[k] !== before[k]);
  ok(moved.length === 0, `every count is what it was (${Object.keys(before).length} tables with company_id and deleted_at)`, moved.map((k) => `${k} ${before[k]} -> ${after[k]}`).join('; '));
}

console.log(`\n${passed} passed, ${failed.length} failed  (${((Date.now() - started) / 1000).toFixed(1)} s)`);
if (failed.length) { console.log('\nFAILED:'); for (const f of failed) console.log(`  - ${f}`); }
await pool.end();
process.exit(failed.length ? 1 : 0);
