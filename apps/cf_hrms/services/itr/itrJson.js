/**
 * itrJson.js — the return as e-filing JSON, ONLY for a form and year whose official schema is
 * vendored in ./schema/ (see ./schema/README.md) and ONLY when the output validates against it
 * (./jsonSchema.js). Otherwise a refusal in words — the person uses the guide and the PDF.
 *
 * Built today: ITR-1 for 2025-26 (AY 2026-27), schema V1.1 of 30 Jun 2026. Not built: ITR-2
 * (its schema V1.2 is published, 390 kB, but its schedules — CG by asset, 112A by scrip, AL,
 * CFL … — need far more than this helper asks), and every year under the 2025 Act (no form or
 * schema is published yet).
 *
 * WHAT THE FILE IS. A JSON the person may try to import on incometax.gov.in (e-File › Income Tax
 * Returns › File › Offline › "Upload JSON"). CreationInfo names the software that made it: this
 * app is NOT a registered e-filing utility, so it says SW00000000 (a placeholder, never another
 * vendor's id). If the portal refuses the file for that reason, the guide shows where to type
 * each number. The app never sends the file anywhere.
 *
 * THE DEDUCTION SCHEDULES. The CBDT "ITR 1 – Validation Rules for AY 2026-27" (V1.0, 15 May 2026,
 * https://www.incometax.gov.in/iec/foportal/sites/default/files/2026-05/CBDT_e-Filing_ITR%201_Validation%20Rules_AY%202026-27.pdf)
 * make these Category A (the return is NOT uploaded without them) in the OLD regime:
 *   Schedule 80C  — rules 241, 247 and the "Identification Number of supporting document" rule;
 *   Schedule 80D  — rules 138, 254, insurer + policy number 256–259, premium rows = the amount 235–237;
 *   Schedule 80G  — rule 8 (donee, PAN, address), 9, 10, 139, IFSC + reference for non-cash 325–326;
 *   Schedule 80E  — rules 242, 248;
 *   Schedule 10(13A) — rules 265 ("needs to be filled for claiming"), 261–263, 266, 269.
 * In the NEW regime they must NOT be filled (rules 156, 173, 255). So each is written when the
 * old regime claims it, from the details step 3 collects; without them the JSON is refused with
 * what is missing. The Chapter VI-A parts are each deduction's `counted` (engine.js), so they
 * add up to TotalChapVIADeductions even when the total is cut to the gross total income.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { HrmsError } from '../../lib/errors.js';
import { validate } from './jsonSchema.js';
import { yearBounds } from '../tax/rules.js';
import { donationsWorked } from '../tax/itr.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const SCHEMAS = {
  '2025-26': {
    ITR1: {
      file: 'ITR-1_AY2026-27_V1.1.json', version: 'V1.1 (30 Jun 2026)', assessmentYear: '2026-27',
      source: 'https://www.incometax.gov.in/iec/foportal/sites/default/files/2026-06/ITR-1_2026_Main_V1.1.json',
    },
  },
};
const loaded = new Map();
function schemaJson(year, form) {
  const k = `${year}|${form}`;
  if (!loaded.has(k)) loaded.set(k, JSON.parse(fs.readFileSync(path.join(here, 'schema', SCHEMAS[year][form].file), 'utf8')));
  return loaded.get(k);
}

/** { ITR1?: { version, file, source }, … } for `year`, or null when none is vendored. */
export function schemaFor(year) {
  return SCHEMAS[year] ?? null;
}

const int = (v) => Math.max(0, Math.round(Number(v) || 0));
const sint = (v) => Math.round(Number(v) || 0);

/** The ITR's TDS section codes drop the leading "1" of 194x (e.g. 194A → "94A"); 192A / 193 / 194 stay. */
function tdsSectionCode(section, allowed) {
  const s = String(section ?? '').toUpperCase().replace(/^SECTION\s*/, '').replace(/\s/g, '');
  if (allowed.includes(s)) return s;
  const short = s.replace(/^1(9[4-6].*)$/, '$1');
  if (allowed.includes(short)) return short;
  const shorter = s.replace(/^19(4.*)$/, '$1');
  return allowed.includes(shorter) ? shorter : null;
}

/** The ITR-1 object for the return, or { missing: [words] } when the person has not given enough. */
export function buildItr1(full, { today = new Date().toISOString().slice(0, 10) } = {}) {
  const r = full.result;
  const c = r.computation;
  const s = r.salary;
  const parts = full.parts ?? {};
  const pers = { ...(full.draft?.personal ?? {}), ...(parts.personal ?? {}) };
  if (!pers.dateOfBirth) pers.dateOfBirth = full.draft?.personal?.dateOfBirth ?? null;
  const addr = pers.address ?? {};
  const bank = parts.bank ?? {};
  const p = full.personFull ?? {};
  const schema = schemaJson(full.year, 'ITR1');
  const D = schema.definitions;
  const missing = [];
  if (!p.pan) missing.push('your PAN (ask HR to add it to your record)');
  if (!pers.dateOfBirth) missing.push('your date of birth');
  if (!pers.fatherName) missing.push("your father's name (the ITR's verification asks for it)");
  if (!addr.flat || !addr.area || !addr.city || !addr.stateCode) missing.push('your address (flat / door, area, city, state)');
  if (!pers.mobile) missing.push('your mobile number');
  if (!pers.email) missing.push('your email address');
  if (!s.tan && (s.tds.value || s.grossSalary.value)) missing.push("your employer's TAN (on your Form 16)");
  if (!bank.account || !bank.ifsc || !bank.bankName) missing.push('the bank account for the refund (bank, IFSC, account number)');
  const cg = c.capitalGains;
  const cgParts = parts.income?.capitalGains ?? {};
  if (cg.ltcg112A && !(Number(cgParts.ltcg112ASale) > 0)) missing.push('the sale value and cost of your long-term equity gains (ITR-1 asks for both)');
  const tdsCodes = D.TDSonOthThanSal.properties.TDSSection.enum ?? [];
  const otherTds = (parts.taxes?.otherTds ?? []).filter((t) => t.kind !== 'TCS');
  for (const t of otherTds) {
    if (!t.tan) missing.push(`the TAN of ${t.deductor || 'each other deductor'}`);
    if (!tdsSectionCode(t.section, tdsCodes)) missing.push(`the TDS section of ${t.deductor || 'each other deductor'} (e.g. 194A for bank interest)`);
  }
  for (const t of parts.taxes?.paid ?? []) if (!t.bsrCode || !t.date || !t.challanNo) missing.push('the BSR code, date and serial number of each challan');
  if (s.employerNps.value && !s.basicDa.value) missing.push("your Basic and DA for the year (the employer's NPS, 80CCD(2), is limited to a share of them)");
  const sch = scheduleDetails(full, missing);
  if (missing.length) return { missing: [...new Set(missing)] };

  const nameParts = String(p.name ?? '').trim().split(/\s+/);
  const surname = nameParts.length > 1 ? nameParts.pop() : nameParts[0];
  const first = nameParts.length && nameParts[0] !== surname ? nameParts.join(' ') : null;
  const ded = Object.fromEntries(c.deductions.map((d) => [d.key, d]));
  // What the person claims (the schedules' totals where there is a schedule: rules 10, 138, 241, 242)
  // and what counts — each deduction's part after the cut to the gross total income (engine.js
  // `counted`, filled in the order of Chapter VI-A, so the LAST ones are cut first).
  const claimed = (k) => (k === 'ded_80d' && sch.s80D ? sch.s80D.Sec80DSelfFamSrCtznHealth.EligibleAmountOfDedn
    : k === 'ded_80g' && sch.s80G ? sch.s80G.TotalEligibleDonationsUs80G : int(ded[k]?.claimed));
  const allowed = (k) => int(ded[k]?.counted ?? ded[k]?.allowed);
  const zero = (keys) => Object.fromEntries(keys.map((k) => [k, 0]));
  const VIA_KEYS = ['Section80C', 'Section80CCC', 'Section80CCDEmployeeOrSE', 'Section80CCD1B', 'Section80CCDEmployer', 'Section80D', 'Section80DD', 'Section80DDB', 'Section80E', 'Section80EE', 'Section80EEA', 'Section80EEB', 'Section80G', 'Section80GG', 'Section80GGA', 'Section80GGC', 'Section80U', 'Section80TTA', 'Section80TTB', 'AnyOthSec80CCH'];
  const via = (get) => {
    const o = { ...zero(VIA_KEYS), Section80C: get('ded_80c'), Section80CCD1B: get('ded_80ccd1b'), Section80CCDEmployer: get('ded_80ccd2'), Section80D: get('ded_80d'), Section80E: get('ded_80e'), Section80G: get('ded_80g'), Section80TTA: get('ded_80tta'), Section80TTB: get('ded_80ttb') };
    o.TotalChapVIADeductions = VIA_KEYS.reduce((a, k) => a + o[k], 0);
    return o;
  };
  const usr = via(claimed);
  const allowedVia = via(allowed);
  if (allowedVia.TotalChapVIADeductions !== int(c.totalDeductions)) {
    throw new HrmsError(500, 'VIA_PARTS', `Chapter VI-A parts ${allowedVia.TotalChapVIADeductions} do not add up to the deductions counted ${int(c.totalDeductions)}.`);
  }

  const exemptDtls = [];
  for (const e of c.exemptions) {
    if (e.key === 'exempt_hra' && e.working) {
      // Worked out from the rent: the same figure as Schedule 10(13A) (rule 269).
      if (e.exempt) exemptDtls.push({ SalNatureDesc: '10(13A)', SalOthAmount: int(e.exempt) });
    } else if (e.key === 'exempt_hra') {
      if (s.exemptHra.value && !c.exemptions.some((x) => x.key === 'exempt_hra' && x.working)) exemptDtls.push({ SalNatureDesc: '10(13A)', SalOthAmount: int(s.exemptHra.value) });
      if (s.exemptLta.value) exemptDtls.push({ SalNatureDesc: '10(5)', SalOthAmount: int(s.exemptLta.value) });
    } else if (e.key === 'exempt_other') exemptDtls.push({ SalNatureDesc: s.exemptOtherSection, SalOthAmount: int(e.exempt) });
  }
  const totalExempt = exemptDtls.reduce((a, x) => a + x.SalOthAmount, 0);
  const salary = int(s.grossSalary.value) + int(s.previous?.salary);
  const grossSalary = salary + int(s.perquisites.value);
  const os = c.otherSources;
  const osDtls = [
    ...(os.savingsInterest ? [{ OthSrcNatureDesc: 'SAV', OthSrcOthAmount: int(os.savingsInterest) }] : []),
    ...(os.depositInterest ? [{ OthSrcNatureDesc: 'IFD', OthSrcOthAmount: int(os.depositInterest) }] : []),
    ...(os.dividends ? [{ OthSrcNatureDesc: 'DIV', OthSrcOthAmount: int(os.dividends) }] : []),
    ...(parts.income?.other ?? []).filter((o) => Number(o.amount) > 0).map((o) => ({ OthSrcNatureDesc: 'OTH', OthSrcOthNatOfInc: String(o.description || 'Other income').slice(0, 125), OthSrcOthAmount: int(o.amount) })),
  ];
  const props = c.houseProperties.map((h, i) => ({
    HPSNo: i + 1,
    AddressDetailWithZipCode: { AddrDetail: String(h.name || `${addr.flat}, ${addr.area}`).slice(0, 50), CityOrTownOrDistrict: addr.city, StateCode: addr.stateCode, CountryCode: '91', ...(addr.pinCode ? { PinCode: Number(addr.pinCode) } : {}) },
    PropertyOwner: 'SE', PropCoOwnedFlg: 'NO',
    ifLetOut: h.kind === 'SELF_OCCUPIED' ? 'S' : 'L',
    Rentdetails: h.kind === 'SELF_OCCUPIED'
      ? { AnnualLetableValue: 0, TotalUnrealizedAndTax: 0, BalanceALV: 0, AnnualOfPropOwned: 0, ThirtyPercentOfBalance: 0, IntOnBorwCap: int(h.interestAllowed), TotalDeduct: int(h.interestAllowed), IncomeOfHP: sint(h.income) }
      : { AnnualLetableValue: int(h.rentReceived), LocalTaxes: int(h.municipalTaxPaid), TotalUnrealizedAndTax: int(h.municipalTaxPaid), BalanceALV: int(h.netAnnualValue), AnnualOfPropOwned: int(h.netAnnualValue), ThirtyPercentOfBalance: int(h.standardDeduction), IntOnBorwCap: int(h.interest), TotalDeduct: int(h.standardDeduction) + int(h.interest), IncomeOfHP: sint(h.income) },
  }));
  const gtiExclLtcg = sint(c.grossTotalIncome) - int(cg.ltcg112A);
  const prepaid = r.prepaid;
  const i = r.interest;
  const taxOnIncome = int(c.taxBeforeRebate);
  const afterRebate = int(c.taxAfterRebate);
  const gross = int(c.totalTax);
  const challans = (parts.taxes?.paid ?? []).map((t) => ({ BSRCode: t.bsrCode, DateDep: t.date, SrlNoOfChaln: Number(t.challanNo), Amt: int(t.amount) }));
  const { startYear } = yearBounds(full.year);
  const city = addr.city;

  const itr1 = {
    CreationInfo: { SWVersionNo: '1.0', SWCreatedBy: 'SW00000000', JSONCreatedBy: 'SW00000000', JSONCreationDate: today, IntermediaryCity: String(city).slice(0, 25), Digest: '-' },
    Form_ITR1: { FormName: 'ITR-1', Description: 'For Indls having Income from Salary, Pension, family pension and Interest', AssessmentYear: String(startYear + 1), SchemaVer: 'Ver1.0', FormVer: 'Ver1.0' },
    PersonalInfo: {
      AssesseeName: { ...(first ? { FirstName: first.slice(0, 25) } : {}), SurNameOrOrgName: surname.slice(0, 75) },
      PAN: p.pan,
      Address: {
        ResidenceNo: addr.flat, ...(addr.premises ? { ResidenceName: addr.premises } : {}), ...(addr.road ? { RoadOrStreet: addr.road } : {}), LocalityOrArea: addr.area,
        CityOrTownOrDistrict: addr.city, StateCode: addr.stateCode, CountryCode: '91', ...(addr.pinCode ? { PinCode: Number(addr.pinCode) } : {}),
        CountryCodeMobile: 91, MobileNo: Number(pers.mobile), EmailAddress: pers.email,
      },
      SecondaryAdd: 'N',
      DOB: pers.dateOfBirth,
      EmployerCategory: pers.employerCategory ?? 'OTH',
    },
    FilingStatus: { ReturnFileSec: i.late ? 12 : 11, OptOutNewTaxRegime: r.regime === 'OLD' ? 'Y' : 'N', AsseseeRepFlg: 'N', ItrFilingDueDate: i.dueDate },
    ITR1_IncomeDeductions: {
      GrossSalary: grossSalary, Salary: salary, PerquisitesValue: int(s.perquisites.value), ProfitsInSalary: 0,
      AllwncExemptUs10: { ...(exemptDtls.length ? { AllwncExemptUs10Dtls: exemptDtls } : {}), TotalAllwncExemptUs10: totalExempt },
      NetSalary: int(c.netSalary), DeductionUs16: int(c.standardDeduction) + int(c.professionalTax), DeductionUs16ia: int(c.standardDeduction), EntertainmentAlw16ii: 0, ProfessionalTaxUs16iii: int(c.professionalTax),
      IncomeFromSal: int(c.incomeFromSalary),
      ...(props.length ? { PropertyDetails: props, TotalIncomeChargeableUnHP: sint(c.houseProperty) } : {}),
      IncomeOthSrc: int(c.otherIncome),
      ...(osDtls.length ? { OthersInc: { OthersIncDtlsOthSrc: osDtls } } : {}),
      GrossTotIncome: gtiExclLtcg, GrossTotIncomeIncLTCG112A: sint(c.grossTotalIncome),
      UsrDeductUndChapVIA: usr, DeductUndChapVIA: allowedVia,
      TotalIncome: int(c.taxableIncome),
      ...(Number(pers.agriculturalIncome) > 0 ? { ExemptIncAgriOthUs10: { ExemptIncAgriOthUs10Dtls: [{ Category: 'AGRI', SubCategory: '10(1)', OthAmount: int(pers.agriculturalIncome) }], ExemptIncAgriOthUs10Total: int(pers.agriculturalIncome) } } : {}),
    },
    ITR1_TaxComputation: {
      TotalTaxPayable: taxOnIncome, Rebate87A: int(c.rebate), TaxPayableOnRebate: afterRebate, EducationCess: int(c.cess), GrossTaxLiability: gross, Section89: 0, NetTaxLiability: gross,
      TotalIntrstPay: int(i.total) + int(i.fee), IntrstPay: { IntrstPayUs234A: int(i.a), IntrstPayUs234B: int(i.b), IntrstPayUs234C: int(i.c), LateFilingFee234F: int(i.fee) },
      TotTaxPlusIntrstPay: gross + int(i.total) + int(i.fee),
    },
    TaxPaid: {
      TaxesPaid: { AdvanceTax: int(prepaid.advance), TDS: int(prepaid.salaryTds) + int(prepaid.otherTds), TCS: int(prepaid.tcs), SelfAssessmentTax: int(prepaid.selfAssessment), TotalTaxesPaid: int(prepaid.total) },
      BalTaxPayable: int(r.payable),
    },
    Refund: { RefundDue: int(r.refund), BankAccountDtls: { AddtnlBankDetails: [{ IFSCCode: bank.ifsc, BankName: bank.bankName, BankAccountNo: bank.account, AccountType: bank.type === 'CURRENT' ? 'CA' : 'SB', UseForRefund: 'true' }] } },
    TDSonSalaries: {
      TDSonSalary: [
        ...(s.tan ? [{ EmployerOrDeductorOrCollectDetl: { TAN: s.tan, EmployerOrDeductorOrCollecterName: String(s.employerName ?? 'Employer').slice(0, 125) }, IncChrgSal: Math.max(0, int(c.incomeFromSalary) - int(s.previous?.salary)), TotalTDSSal: int(s.tds.value) }] : []),
        ...(s.previous?.tan ? [{ EmployerOrDeductorOrCollectDetl: { TAN: s.previous.tan, EmployerOrDeductorOrCollecterName: String(s.previous.name ?? 'Previous employer').slice(0, 125) }, IncChrgSal: int(s.previous.salary), TotalTDSSal: int(s.previous.tds) }] : []),
      ],
      TotalTDSonSalaries: int(prepaid.salaryTds),
    },
    TDSonOthThanSals: {
      ...(otherTds.length ? {
        TDSonOthThanSal: otherTds.map((t) => ({
          EmployerOrDeductorOrCollectDetl: { TAN: t.tan, EmployerOrDeductorOrCollecterName: String(t.deductor ?? 'Deductor').slice(0, 125) },
          TDSSection: tdsSectionCode(t.section, tdsCodes), AmtForTaxDeduct: int(t.income), DeductedYr: String(startYear), TotTDSOnAmtPaid: int(t.amount), ClaimOutOfTotTDSOnAmtPaid: int(t.amount),
        })),
      } : {}),
      TotalTDSonOthThanSals: int(prepaid.otherTds),
    },
    ScheduleTCS: { TotalSchTCS: int(prepaid.tcs) },
    TaxPayments: { ...(challans.length ? { TaxPayment: challans } : {}), TotalTaxPayments: challans.reduce((a, x) => a + x.Amt, 0) },
    ...(sch.s80G ? { Schedule80G: sch.s80G } : {}),
    ...(sch.s80D ? { Schedule80D: sch.s80D } : {}),
    ...(sch.s80E ? { Schedule80E: sch.s80E } : {}),
    ...(sch.s80C ? { Schedule80C: sch.s80C } : {}),
    ...(sch.ea13A ? { ScheduleEA10_13A: sch.ea13A } : {}),
    ...(cg.ltcg112A ? { LTCG112A: { TotSaleCnsdrn: int(cgParts.ltcg112ASale), TotCstAcqisn: int(cgParts.ltcg112ACost), LongCap112A: int(cg.ltcg112A) } } : {}),
    Verification: { Declaration: { AssesseeVerName: String(p.name).slice(0, 127), FatherName: pers.fatherName, AssesseeVerPAN: p.pan }, Capacity: 'S', Place: String(city).slice(0, 50) },
  };
  return { json: { ITR: { ITR1: itr1 } } };
}

/**
 * The deduction schedules for the old regime, from the details of step 3, or words pushed onto
 * `missing`. { s80C, s80D, s80E, s80G, ea13A } — each null when not claimed (or the new regime).
 */
function scheduleDetails(full, missing) {
  const r = full.result;
  const c = r.computation;
  const s = r.salary;
  const d = full.parts?.deductions ?? {};
  const out = { s80C: null, s80D: null, s80E: null, s80G: null, ea13A: null };
  if (r.regime !== 'OLD') return out;
  const ded = Object.fromEntries(c.deductions.map((x) => [x.key, x]));
  const text = (v) => String(v ?? '').trim();

  /* 80C: one line per payment, with the policy / document number (rules 241, 247). */
  if (int(ded.ded_80c?.claimed)) {
    const items = (d['80CItems'] ?? []).filter((x) => Number(x.amount) > 0);
    if (!items.length) missing.push('the 80C payments one by one, each with its policy / document number (Schedule 80C)');
    else if (items.some((x) => !text(x.documentNo))) missing.push('the policy / document number of each 80C payment (Schedule 80C)');
    else {
      const rows = items.map((x) => ({ IdentificationNo: text(x.documentNo).slice(0, 50), Amount: int(x.amount) }));
      out.s80C = { Schedule80CDtls: rows, TotalAmt: rows.reduce((a, x) => a + x.Amount, 0) };
    }
  }

  /* 80D: insurer and policy number for each premium (rules 235–238, 254, 256–259); the halves from the engine. */
  const d80 = ded.ded_80d;
  if (d80?.split && int(d80.allowed)) {
    const sp = d80.split;
    const pol = (d['80D']?.policies ?? []).filter((x) => Number(x.amount) > 0);
    const rows = (who) => pol.filter((x) => (who === 'PARENTS' ? x.for === 'PARENTS' : x.for !== 'PARENTS'));
    const bad = (list) => list.some((x) => !text(x.insurer) || !text(x.policyNo));
    if ((sp.selfFamilyPremium && !rows('SELF').length) || (sp.parentsPremium && !rows('PARENTS').length)) missing.push('each health-insurance policy (insurer, policy number, premium) — Schedule 80D');
    else if (bad(pol)) missing.push('the insurer and policy number of each health-insurance policy (Schedule 80D)');
    else {
      const dtls = (list) => ({ Sch80DInsDtls: list.map((x) => ({ InsurerName: text(x.insurer).slice(0, 125), PolicyNo: text(x.policyNo).slice(0, 75), HealthInsAmt: int(x.amount) })), TotalPayments: list.reduce((a, x) => a + int(x.amount), 0) });
      const h = { SeniorCitizenFlag: 'S', ParentsSeniorCitizenFlag: 'P' };
      if (sp.selfFamily) {
        if (sp.selfFamilySenior) Object.assign(h, { SeniorCitizenFlag: 'Y', SelfAndFamilySeniorCitizen: int(sp.selfFamily), HlthInsPremSlfFamSrCtzn: int(sp.selfFamilyPremium), ...(sp.selfFamilyPremium ? { Sec80DSelfFamSrCtznHIDtls: dtls(rows('SELF')) } : {}), PrevHlthChckUpSlfFamSrCtzn: int(sp.preventive), MedicalExpSlfFamSrCtzn: 0 });
        else Object.assign(h, { SeniorCitizenFlag: 'N', SelfAndFamily: int(sp.selfFamily), HealthInsPremSlfFam: int(sp.selfFamilyPremium), ...(sp.selfFamilyPremium ? { Sec80DSelfFamHIDtls: dtls(rows('SELF')) } : {}), PrevHlthChckUpSlfFam: int(sp.preventive) });
      }
      if (sp.parents) {
        if (sp.parentsSenior) Object.assign(h, { ParentsSeniorCitizenFlag: 'Y', ParentsSeniorCitizen: int(sp.parents), HlthInsPremParentsSrCtzn: int(sp.parentsPremium), Sec80DParentsSrCtznHIDtls: dtls(rows('PARENTS')), PrevHlthChckUpParentsSrCtzn: 0, MedicalExpParentsSrCtzn: 0 });
        else Object.assign(h, { ParentsSeniorCitizenFlag: 'N', Parents: int(sp.parents), HlthInsPremParents: int(sp.parentsPremium), Sec80DParentsHIDtls: dtls(rows('PARENTS')), PrevHlthChckUpParents: 0 });
      }
      // Sl. 3 = 1a + 1b + 2a + 2b, "subject to GTI" (rule 137).
      h.EligibleAmountOfDedn = Math.min(int(sp.selfFamily) + int(sp.parents), Math.max(0, int(c.grossTotalIncome)));
      out.s80D = { Sec80DSelfFamSrCtznHealth: h };
    }
  }

  /* 80E: each loan (rules 242, 248). */
  if (int(ded.ded_80e?.claimed)) {
    const loans = (d['80ELoans'] ?? []).filter((x) => Number(x.interest) > 0);
    if (!loans.length || loans.some((x) => !text(x.lender) || !text(x.loanAccount) || !x.loanDate)) missing.push('each education loan (bank or institution, loan account number, date of the loan, amount, outstanding, interest) — Schedule 80E');
    else {
      const rows = loans.map((x) => ({ LoanTknFrom: x.lenderType === 'I' ? 'I' : 'B', BankOrInstnName: text(x.lender).slice(0, 125), LoanAccNoOfBankOrInstnRefNo: text(x.loanAccount).slice(0, 20), DateofLoan: x.loanDate, TotalLoanAmt: int(x.loanAmount), LoanOutstndngAmt: int(x.outstanding), Interest80E: int(x.interest) }));
      out.s80E = { Schedule80EDtls: rows, TotalInterest80E: rows.reduce((a, x) => a + x.Interest80E, 0) };
    }
  }

  /* 80G: each donee in its table (rules 8–10, 85–88, 139, 325–327). */
  if (int(ded.ded_80g?.claimed)) {
    const gifts = donationsWorked((d['80GDonations'] ?? []).filter((x) => (Number(x.cash) || 0) + (Number(x.otherMode) || 0) > 0));
    if (!gifts.length) missing.push("each donation (donee's name, PAN, address, the amount in cash and otherwise) — Schedule 80G");
    else if (gifts.some((x) => !text(x.name) || !x.pan || !text(x.address) || !text(x.city) || !x.stateCode || !x.pinCode)) missing.push("the donee's name, PAN and address (with city, state and PIN) of each donation (Schedule 80G)");
    else if (gifts.some((x) => x.otherMode && (!x.ifsc || !text(x.transactionRef)))) missing.push('the IFSC and the transaction reference (UPI / cheque / NEFT) of each donation not in cash (Schedule 80G)');
    else {
      const TABLE = {
        NO_LIMIT_100: ['Don100Percent', 'TotDon100PercentCash', 'TotDon100PercentOtherMode', 'TotDon100Percent', 'TotEligibleDon100Percent'],
        NO_LIMIT_50: ['Don50PercentNoApprReqd', 'TotDon50PercentNoApprReqdCash', 'TotDon50PercentNoApprReqdOtherMode', 'TotDon50PercentNoApprReqd', 'TotEligibleDon50Percent'],
        LIMIT_100: ['Don100PercentApprReqd', 'TotDon100PercentApprReqdCash', 'TotDon100PercentApprReqdOtherMode', 'TotDon100PercentApprReqd', 'TotEligibleDon100PercentApprReqd'],
        LIMIT_50: ['Don50PercentApprReqd', 'TotDon50PercentApprReqdCash', 'TotDon50PercentApprReqdOtherMode', 'TotDon50PercentApprReqd', 'TotEligibleDon50PercentApprReqd'],
      };
      const g = { TotalDonationsUs80GCash: 0, TotalDonationsUs80GOtherMode: 0, TotalDonationsUs80G: 0, TotalEligibleDonationsUs80G: 0 };
      for (const [cat, [block, tCash, tOther, tAll, tElig]] of Object.entries(TABLE)) {
        const list = gifts.filter((x) => x.category === cat);
        if (!list.length) continue;
        const donees = list.map((x) => ({
          DoneeWithPanName: text(x.name).slice(0, 125), DoneePAN: x.pan, ...(x.arn ? { ArnNbr: text(x.arn).slice(0, 25) } : {}),
          AddressDetail: { AddrDetail: text(x.address).slice(0, 200), CityOrTownOrDistrict: text(x.city).slice(0, 50), StateCode: x.stateCode, PinCode: Number(x.pinCode) },
          DonationAmtCash: int(x.cash), DonationAmtOtherMode: int(x.otherMode),
          ...(x.otherMode ? { TransactionRefNum: text(x.transactionRef).slice(0, 50), IFSCCode: x.ifsc } : {}),
          DonationAmt: int(x.cash) + int(x.otherMode), EligibleDonationAmt: int(x.eligible),
        }));
        const t = { [tCash]: 0, [tOther]: 0, [tAll]: 0, [tElig]: 0 };
        for (const x of donees) { t[tCash] += x.DonationAmtCash; t[tOther] += x.DonationAmtOtherMode; t[tAll] += x.DonationAmt; t[tElig] += x.EligibleDonationAmt; }
        out.s80G = { ...(out.s80G ?? {}), [block]: { DoneeWithPan: donees, ...t } };
        g.TotalDonationsUs80GCash += t[tCash]; g.TotalDonationsUs80GOtherMode += t[tOther]; g.TotalDonationsUs80G += t[tAll]; g.TotalEligibleDonationsUs80G += t[tElig];
      }
      out.s80G = { ...out.s80G, ...g };
    }
  }

  /* 10(13A): the HRA working (rules 261–263, 265, 266, 269). */
  const hraWorked = c.exemptions.find((e) => e.key === 'exempt_hra' && e.working);
  const hraCertified = s.exemptHra.value && !hraWorked && c.exemptions.some((e) => e.key === 'exempt_hra');
  if (hraCertified) missing.push('the HRA working — the rent you paid, the city where you work, and your Basic and DA (Schedule 10(13A))');
  if (hraWorked && hraWorked.exempt) {
    const w = hraWorked.working[0];
    const salary17 = int(s.grossSalary.value) + int(s.previous?.salary);
    if (!s.basicDa.value) missing.push('your Basic and DA for the year (Schedule 10(13A))');
    else if (int(s.basic.value) + int(s.da.value) + int(w.hraReceived) > salary17) missing.push(`Basic + DA + HRA received (${int(s.basic.value) + int(s.da.value) + int(w.hraReceived)}) is more than the salary (${salary17}) — check Basic, DA and the HRA received (rule 266)`);
    else {
      out.ea13A = {
        Placeofwork: w.metro ? '1' : '2', ActlHRARecv: int(w.hraReceived), ActlRentPaid: int(w.rentPaid), DtlsSalUsSec171: salary17,
        BasicSalary: int(s.basic.value), DearnessAllwnc: int(s.da.value), ActlRentPaid10Per: int(w.rentMinusTenth), Sal40Or50Per: int(w.pctOfSalary), EligbleExmpAllwncUs13A: int(hraWorked.exempt),
      };
    }
  }
  return out;
}

/** The JSON file for the person's return, or a refusal in words. */
export function returnJson(full, opts = {}) {
  const form = full.result.form.form;
  const label = form === 'ITR1' ? 'ITR-1' : 'ITR-2';
  const s = schemaFor(full.year)?.[form];
  if (!s) {
    throw new HrmsError(409, 'NO_SCHEMA', form === 'ITR2' && schemaFor(full.year)
      ? `This app makes the JSON for ITR-1 only; ${label} for ${full.year} is not built. Use the "where to type each number" guide and the PDF.`
      : `No official e-filing JSON schema for ${label} of ${full.year} is in the app${full.result.form.published === false ? ' (the forms for this year are not published yet)' : ''}. Use the "where to type each number" guide and the PDF.`);
  }
  const built = buildItr1(full, opts);
  if (built.missing) throw new HrmsError(422, 'NEEDS_MORE', `To make the JSON the return needs: ${built.missing.join('; ')}.`, { problems: built.missing });
  const errors = validate(schemaJson(full.year, form), built.json);
  if (errors.length) {
    throw new HrmsError(422, 'SCHEMA_INVALID', `The JSON does not pass the official ${label} schema ${s.version}, so it is not given out.`, { problems: errors.slice(0, 20).map((e) => `${e.path} ${e.message}`) });
  }
  const pan = full.personFull?.pan ?? 'PAN';
  return { json: built.json, version: s.version, fileName: `${pan}_${label}_AY${s.assessmentYear}.json` };
}
