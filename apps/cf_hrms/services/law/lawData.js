/**
 * lawData.js — the seed of the NEW law data in hrms_law_rules (spec §36.1): minimum wages, bonus,
 * gratuity, overtime and hours, the Labour Code "wages" 50% rule, leave and holiday minimums.
 * Written by scripts/seed-law-rules.mjs (idempotent by domain + jurisdiction + rule_key +
 * effective_from). PF / ESI / PT / LWF come from the per-company statutory settings (moved by
 * migrate-statutory-to-law.mjs), not from here.
 *
 * verified = 1 ONLY where the number was read in an official or primary text on an official host
 * (labour.gov.in, egazette.gov.in). verified = 0 otherwise, with the reason in source_note —
 * including where the primary text itself was read, but from a copy on a third-party server (said
 * so). Researched 2026-10-24.
 *
 * Labour Codes in force 21-11-2025 (Code on Wages: S.O. 5322(E); OSH Code: S.O. 5321(E) — both as
 * cited by Telangana's own G.O.s; the IR and SS Codes' S.O.s seen on secondary sources only). Central
 * rules: Code on Wages (Central) Rules, 2026, G.S.R. 343(E), 8-May-2026; Social Security (Central)
 * Rules, 2026, G.S.R. 344(E), 8-May-2026.
 */
const URL = {
  codeOnWages: 'https://egazette.gov.in/WriteReadData/2019/210356.pdf',
  oshCode: 'https://egazette.gov.in/WriteReadData/2020/222112.pdf',
  ssCode: 'https://www.labour.gov.in/static/uploads/2025/07/b0620548445580767b5c0d18c95c26f7.pdf',
  wageRules2026: 'https://www.labour.gov.in/static/uploads/2026/05/6eb0c35ba63b776487a025e5123b6b12.pdf',
  bonusCeiling: 'https://www.labour.gov.in/static/uploads/2026/09/3977906b27b1b53b9b98c245091b0726.pdf',
  handbook: 'https://www.labour.gov.in/static/uploads/2026/02/83978455025732b99b0165def80ab171.pdf',
  faq2026: 'https://www.labour.gov.in/static/uploads/2026/03/a4ccf4c6d97c4f1f36a6d83f8c64213d.pdf',
  factoriesAct: 'https://www.labour.gov.in/static/uploads/2025/06/b878b8d9f3d9abc62fbe0a6c92f606e3.pdf',
  tgGo6: 'https://www.comply4hr.com/noti/2016/TLGMWR2026May30.PDF',
  tgShops: 'https://www.lawrbit.com/wp-content/uploads/2020/08/telangana-shops-establishments-acts-and-rules.pdf',
  tgLabour: 'https://labour.telangana.gov.in/',
};

const CODES_FROM = '2025-11-21';

/* ── Telangana minimum wages: G.O.Ms.No.6, 30-05-2026, in force 01-06-2026 ── */
const TG_RATES = [
  ['I', 16000, 17000, 18500, 20000],
  ['II', 15000, 16000, 17500, 19000],
  ['III', 14000, 15000, 16500, 18000],
].flatMap(([zone, u, ss, s, hs]) => [
  { zone, skill: 'UNSKILLED', basic: u, vda: null },
  { zone, skill: 'SEMI_SKILLED', basic: ss, vda: null },
  { zone, skill: 'SKILLED', basic: s, vda: null },
  { zone, skill: 'HIGHLY_SKILLED', basic: hs, vda: null },
]);

export const LAW_RULE_ROWS = [
  {
    domain: 'MIN_WAGE', jurisdiction: 'TG', rule_key: 'ALL_EMPLOYMENTS', effective_from: '2026-06-01',
    title: 'Telangana minimum wages — all employments (G.O.Ms.No.6, 2026)',
    value: {
      unit: 'MONTH', dailyDivisor: 26,
      employments: [
        { key: 'PRINTING_PRESSES', name: 'Printing presses, including litho and offset printing', schedule: 'Schedule II, no. 40' },
        { key: 'FACTORY_MANUFACTURING', name: 'Any manufacturing process carried out in a factory (plastic film, flexible packaging …)', schedule: 'Schedule II, no. 49' },
      ],
      zones: { I: 'Municipal corporations (e.g. GHMC)', II: 'Municipalities', III: 'Rural and other areas' },
      rates: TG_RATES,
      vda: { basePoint: 443, perPoint: 33.86, series: 'CPI 2001 = 100', revised: 'every 1 April and 1 October (Commissioner of Labour)', current: null },
      trainee: { pctOfCategory: 75, notBelow: 'UNSKILLED' },
      higherExisting: { raisePct: 10 },
      overtime: { afterHoursADay: 8, multiplier: 2 },
      roundTo: 0.5,
      examples: [{ zone: 'I', skill: 'UNSKILLED', total: 16000 }, { zone: 'III', skill: 'HIGHLY_SKILLED', total: 18000 }],
    },
    source_url: URL.tgGo6,
    source_note: 'G.O.Ms.No.6, Labour, Employment, Training & Factories (LAB-I) Dept, 30-05-2026, under ss.6–8 of the Code on Wages, 2019; Extraordinary Gazette 01-06-2026; in force 01-06-2026 for ALL establishments, superseding the earlier per-employment notifications; "subject to outcome of pending W.P.s". Basic a month: Zone I (municipal corporations) 16,000 / 17,000 / 18,500 / 20,000; Zone II (municipalities) 15,000 / 16,000 / 17,500 / 19,000; Zone III (other areas) 14,000 / 15,000 / 16,500 / 18,000 (unskilled / semi-skilled / skilled / highly skilled). VDA ₹33.86 a point a month above CPI 443 (2001=100), notified each 1 April and 1 October — NO VDA under this G.O. found yet (1-Oct-2026 not notified as of 2026-10-24), so VDA is empty and the total is the basic. Daily = monthly ÷ 26. NOT VERIFIED: the G.O. text was read in full, but from a copy on comply4hr.com (not an official host) — check it against the Telangana gazette.',
    note: 'Printing presses (Schedule II no. 40) and any factory manufacturing (no. 49) get the same rates, so Karni\'s schedule does not change the amount. The zone is the local body where the factory sits (corporation / municipality / gram panchayat): set it on the location. Skills from the G.O.\'s Schedule III, e.g. helper, packer = unskilled; printer, offset feeder = semi-skilled; machine man, rewinder, quality checker = skilled; rotary pressman, plate maker = highly skilled.',
    verified: 0, review_by: '2026-11-15',
  },

  /* ── Bonus (Code on Wages, Chapter IV, ss.26–41) ── */
  {
    domain: 'BONUS', jurisdiction: 'IN', rule_key: 'eligibility', effective_from: CODES_FROM, title: 'Bonus — who is eligible',
    value: { wageCeilingMonthly: 21000, minDaysWorked: 30 },
    source_url: URL.codeOnWages,
    source_note: 'Code on Wages s.26(1): an employee whose wages do not exceed the amount notified by the appropriate Government and who worked at least 30 days in the accounting year (30 days: read in the Code). The ₹21,000 a month ceiling: S.O. 4711(E), 25-08-2026, deemed from 21-11-2025 — seen on secondary sources only (gazette copy not found); no Telangana notification found. NOT VERIFIED (the ceiling).',
    note: 'Karni is in the State sphere: Telangana is the appropriate Government. Until it notifies, ₹21,000 (the Act\'s figure since 2015) is the conservative reading.',
    verified: 0, review_by: '2026-12-31',
  },
  {
    domain: 'BONUS', jurisdiction: 'IN', rule_key: 'rates', effective_from: CODES_FROM, title: 'Bonus — minimum and maximum',
    value: { minRatePct: 8.33, minAmount: 100, maxRatePct: 20, payableWithoutSurplus: true, newEstablishmentYears: 5 },
    source_url: URL.codeOnWages,
    source_note: 'Code on Wages s.26(1): minimum bonus 8.33% of wages or ₹100, whichever is higher, whether or not there is allocable surplus; s.26(3): maximum 20%; s.26(6): a new establishment pays only in years of profit in its first five accounting years. Read in the Code (egazette).',
    verified: 1,
  },
  {
    domain: 'BONUS', jurisdiction: 'IN', rule_key: 'calculation_ceiling', effective_from: CODES_FROM, title: 'Bonus — wage it is calculated on',
    value: { fixedMonthly: 7000, orMinimumWage: true, rule: 'higher of the fixed amount and the minimum wage' },
    source_url: URL.bonusCeiling,
    source_note: 'S.O. 4710(E), 25-08-2026, deemed in force from 21-11-2025 (read on labour.gov.in): bonus is calculated on ₹7,000 a month or the minimum wage fixed by the Central Government, whichever is higher. For a State-sphere factory the State minimum wage is the usual reading (as under the old Act s.12) — that reading is not confirmed by a Telangana notification.',
    verified: 1,
  },
  {
    domain: 'BONUS', jurisdiction: 'IN', rule_key: 'set_on_set_off', effective_from: CODES_FROM, title: 'Bonus — set-on and set-off',
    value: { carryForwardYears: 4, capPctOfSalary: 20 },
    source_url: URL.wageRules2026,
    source_note: 'Code on Wages s.36: allocable surplus above the maximum bonus is carried forward (set on), capped at 20% of the total salary, up to and including the 4th accounting year; a shortfall is set off the same way. Code on Wages (Central) Rules, 2026 (G.S.R. 343(E)) rr.27–28 and Appendix A. Read on egazette / labour.gov.in.',
    verified: 1,
  },
  {
    domain: 'BONUS', jurisdiction: 'IN', rule_key: 'payment_time', effective_from: CODES_FROM, title: 'Bonus — when it is paid',
    value: { withinMonthsOfYearEnd: 8, extendableToYears: 2 },
    source_url: URL.codeOnWages,
    source_note: 'Code on Wages s.39: within 8 months of the close of the accounting year; extendable, at most to two years in all. Read in the Code.',
    verified: 1,
  },

  /* ── Gratuity (Code on Social Security, s.53) ── */
  {
    domain: 'GRATUITY', jurisdiction: 'IN', rule_key: 'eligibility', effective_from: CODES_FROM, title: 'Gratuity — who gets it',
    value: { minYears: 5, fixedTermMinYears: 1, partYearCountsFromMonths: 6, fiveYearsWaivedOn: ['DEATH', 'DISABLEMENT', 'FIXED_TERM_END'] },
    source_url: URL.ssCode,
    source_note: 'Code on Social Security s.53(1): five years\' continuous service, waived on death or disablement and on the end of a fixed-term contract; SS (Central) Rules, 2026 (G.S.R. 344(E)) r.33(1)(a) second proviso: a fixed-term employee after at least one year; a part of a year of six months or more counts as a year. MoLE FAQ of 16-03-2026 says the same. Read on labour.gov.in.',
    verified: 1,
  },
  {
    domain: 'GRATUITY', jurisdiction: 'IN', rule_key: 'rate', effective_from: CODES_FROM, title: 'Gratuity — how much',
    value: { daysPerYear: 15, monthlyDivisor: 26, seasonalDaysPerSeason: 7, wages: 'Code on Wages s.2(y), with the 50% add-back' },
    source_url: URL.ssCode,
    source_note: 'Code on Social Security s.53(2): 15 days\' wages for every completed year (or part above six months); Explanation: monthly-rated = monthly wage ÷ 26 × 15; seasonal 7 days a season. Wages for gratuity = Code on Wages s.2(y) incl. the 50% rule from 21-11-2025 (MoLE Additional FAQs 16-03-2026, Q6). Read on labour.gov.in.',
    verified: 1,
  },
  {
    domain: 'GRATUITY', jurisdiction: 'IN', rule_key: 'cap', effective_from: CODES_FROM, title: 'Gratuity — the most payable',
    value: { amount: 2000000 },
    source_url: URL.ssCode,
    source_note: 'Code on Social Security s.53(3): "such amount as may be notified by the Central Government". ₹20,00,000 continues (as under the 1972 Act, S.O. 1420(E) of 29-03-2018), reported in a MoLE letter of 3-Aug-2026; no gazette notification under s.53(3) found. NOT VERIFIED.',
    verified: 0, review_by: '2026-12-31',
  },
  {
    domain: 'GRATUITY', jurisdiction: 'IN', rule_key: 'payment_time', effective_from: CODES_FROM, title: 'Gratuity — when it is paid',
    value: { withinDays: 30 },
    source_url: URL.handbook,
    source_note: 'Within 30 days of becoming payable (Code on Social Security s.56; MoLE Compliance Handbook). Read on labour.gov.in.',
    verified: 1,
  },

  /* ── Overtime and hours ── */
  {
    domain: 'OVERTIME', jurisdiction: 'IN', rule_key: 'rate', effective_from: '2025-04-01', effective_to: '2025-11-20', title: 'Overtime — Factories Act, 1948',
    value: { multiplier: 2, dailyHours: 9, weeklyHours: 48, quarterlyCapHours: 50, quarterlyCapHoursExempted: 75, maxDailyWithOvertime: 10, maxWeeklyWithOvertime: 60 },
    source_url: URL.factoriesAct,
    source_note: 'Factories Act, 1948: s.51 48 hours a week; s.54 9 hours a day; s.59 overtime at twice the ordinary rate beyond 9 hours a day or 48 a week; s.64(4) 10 hours a day, 60 a week, overtime at most 50 hours a quarter; s.65(3) 75 hours a quarter under exemption orders. Read on labour.gov.in. Repealed by the OSH Code from 21-11-2025 (savings clause).',
    verified: 1,
  },
  {
    domain: 'OVERTIME', jurisdiction: 'IN', rule_key: 'rate', effective_from: CODES_FROM, title: 'Overtime — OSH Code and Code on Wages',
    value: { multiplier: 2, dailyHours: 8, weeklyHours: 48, daysPerWeek: 6, computedDailyOrWeekly: 'whichever is better for the worker', consentNeeded: true, quarterlyCapHours: null },
    source_url: URL.oshCode,
    source_note: 'OSH Code s.25(1) at most 8 hours a day; s.26 six days a week; s.27 overtime at twice the rate of wages, with the worker\'s consent, total overtime hours as the appropriate Government prescribes; Code on Wages s.14 and Code on Wages (Central) Rules, 2026 r.5: 8-hour day, 48 hours a week, overtime at least twice. Read on egazette / labour.gov.in. The quarterly cap is left to the State (see TG quarterly_cap).',
    verified: 1,
  },
  {
    domain: 'OVERTIME', jurisdiction: 'TG', rule_key: 'quarterly_cap', effective_from: CODES_FROM, title: 'Overtime — Telangana quarterly limit',
    value: { hours: 50, hoursExempted: 75, draftRulesHours: 156, final: false },
    source_note: 'Telangana has not finalised its OSH rules: the draft Telangana OSH Rules, 2026 (preliminary notification reported 08-05-2026) r.52(6) say at most 156 hours of overtime a quarter, and r.52 overtime beyond 8 hours a day or 48 a week at twice the ordinary rate — DRAFT only (text read on a third-party copy). Until they are final the old Factories Act limits (50 hours a quarter; 75 under an exemption) are the safe reading. G.O.Ms.No.6 (2026) condition 9: overtime beyond 8 hours a day at double. NOT VERIFIED.',
    note: 'Change to the final rules\' number when Telangana notifies them.',
    verified: 0, review_by: '2026-12-31',
  },

  /* ── Wages: the Labour Code 50% rule ── */
  {
    domain: 'WAGES', jurisdiction: 'IN', rule_key: 'fifty_percent_rule', effective_from: CODES_FROM, title: 'Wages — the 50% rule (Code on Wages s.2(y))',
    value: {
      excludedSharePct: 50,
      inWages: ['BASIC', 'DA', 'RETAINING_ALLOWANCE'],
      excludedCounted: ['BONUS', 'HOUSING_AMENITIES', 'EMPLOYER_PF_PENSION', 'CONVEYANCE', 'SPECIAL_EXPENSES', 'HRA', 'AWARD_SETTLEMENT', 'OVERTIME', 'COMMISSION'],
      excludedNotCounted: ['GRATUITY', 'RETRENCHMENT_RETIREMENT'],
      countsFor: ['PF', 'ESI', 'GRATUITY', 'BONUS'],
      inKindCapPct: 15,
    },
    source_url: URL.codeOnWages,
    source_note: 'Code on Wages s.2(y): wages = basic, DA and retaining allowance; clauses (a)–(k) are excluded, but where the payments under (a)–(i) exceed one-half of all remuneration, the excess is deemed wages (first proviso); remuneration in kind counts up to 15% of wages. The same definition applies to the Code on Social Security (s.2(88): PF, ESI, gratuity). MoLE Additional FAQs, 16-03-2026: overtime is in the 50% test; employer PF and statutory bonus are counted in the remuneration; gratuity, ESI and retirement benefits are not. Read on egazette / labour.gov.in.',
    verified: 1,
  },

  /* ── Leave and holidays (minimums) ── */
  {
    domain: 'LEAVE_MIN', jurisdiction: 'IN', rule_key: 'annual_leave_factory', effective_from: '2025-04-01', effective_to: '2025-11-20', title: 'Annual leave — Factories Act s.79',
    value: { daysWorkedPerLeaveDay: 20, eligibilityDaysWorked: 240, adolescentDaysWorkedPerLeaveDay: 15 },
    source_url: URL.factoriesAct,
    source_note: 'Factories Act, 1948 s.79: a worker who worked 240 days in a calendar year earns one day for every 20 days worked (adults; 15 for children). Read on labour.gov.in. Repealed from 21-11-2025 by the OSH Code.',
    verified: 1,
  },
  {
    domain: 'LEAVE_MIN', jurisdiction: 'IN', rule_key: 'annual_leave_factory', effective_from: CODES_FROM, title: 'Annual leave — OSH Code s.32',
    value: { daysWorkedPerLeaveDay: 20, eligibilityDaysWorked: 180, adolescentDaysWorkedPerLeaveDay: 15, carryForwardCapDays: 30, encashAtYearEnd: true, joinerEligibleAfterShareOfRemaining: 0.25 },
    source_url: URL.oshCode,
    source_note: 'OSH Code s.32: 180 days of work in a calendar year earns one day for every 20 days worked (adolescents 15); lay-off, maternity and leave days count toward the 180; a joiner in the year after working a quarter of the remaining days; carry forward at most 30 days (refused leave without limit); encashment at year end. Read on egazette.',
    verified: 1,
  },
  {
    domain: 'LEAVE_MIN', jurisdiction: 'TG', rule_key: 'shops_establishments', effective_from: '2025-04-01', title: 'Telangana Shops and Establishments Act — leave (not factories)',
    value: { earnedLeaveDays: 15, earnedAfterDaysWorked: 240, accumulateUpTo: 60, encashPerYear: 8, sickLeaveDays: 12, casualLeaveDays: 12, paidHolidays: 9, appliesTo: 'shops and commercial establishments, NOT factories' },
    source_url: URL.tgShops,
    source_note: 'Telangana Shops and Establishments Act, 1988 (as adapted) s.30: 15 days\' leave with wages after 240 days in 12 months, accumulating to 60, 8 encashable a year; 12 days sick and 12 days casual leave; s.31: 9 paid holidays incl. 26 Jan, 1 May, 15 Aug, 2 Oct and 2 June. NOT VERIFIED: the Act\'s text was read on a third-party compilation (lawrbit.com); the indiacode copy would not download.',
    note: 'For the company\'s office staff in a commercial establishment; a factory follows the OSH Code s.32 row.',
    verified: 0, review_by: '2026-12-31',
  },
  {
    domain: 'LEAVE_MIN', jurisdiction: 'TG', rule_key: 'holidays_factory', effective_from: '2025-04-01', title: 'Telangana national and festival holidays — factories',
    value: { national: 4, nationalDays: ['01-26', '05-01', '08-15', '10-02'], festival: 4, total: 8, eligibilityDaysInPrevious90: 30, workOnHoliday: 'twice the wages, or wages and a substitute holiday' },
    source_url: URL.tgLabour,
    source_note: '(A.P./Telangana) Factories and Establishments (National, Festival and Other Holidays) Act, 1974: 8 paid holidays a year — 4 national (26 January, 1 May, 15 August, 2 October) and 4 festival holidays chosen with the workers; 30 days\' service in the preceding 90 days. NOT VERIFIED: compliance-matrix (simpliance) only; the official text could not be opened.',
    verified: 0, review_by: '2026-12-31',
  },
];

export default { LAW_RULE_ROWS };
