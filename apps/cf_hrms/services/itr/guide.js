/**
 * guide.js — "where to type each number": the worked-out return laid out screen by screen as
 * the e-filing portal's online form asks for it (incometax.gov.in › e-File › Income Tax Returns ›
 * File Income Tax Return › Online). ITR-1's online form has five tabs; ITR-2 is a list of
 * schedules. Words only — the portal's own field names, the person's own numbers.
 */
const n = (v) => { const x = Number(v); return Number.isFinite(x) ? Math.round(x) : 0; };

export function guideFor(r, parts) {
  const c = r.computation;
  const s = r.salary;
  const cert = r.forms.certificate.label;
  const item = (field, value, note = null) => ({ field, value: value == null ? null : (typeof value === 'number' ? n(value) : value), note });
  const exempt = c.exemptions.reduce((a, e) => a + n(e.exempt), 0);
  const salaryItems = [
    item(`Salary as per section 17(1) — from your ${cert}`, s.grossSalary.value + (s.previous?.salary ?? 0), s.previous ? 'Both employers together; add each employer as its own row where the form asks.' : null),
    item('Value of perquisites as per section 17(2)', s.perquisites.value),
    item('Less: allowances to the extent exempt u/s 10 (pick each allowance from the list)', exempt, exempt ? 'Pick "Sec 10(13A) — HRA" and "Sec 10(5) — LTA" or the matching item for each part.' : 'None.'),
    item('Standard deduction u/s 16(ia)', c.standardDeduction),
    item('Professional tax u/s 16(iii)', c.professionalTax),
    item('Income chargeable under the head Salaries', c.incomeFromSalary),
  ];
  const hpItems = c.houseProperties.flatMap((h, i) => (h.kind === 'SELF_OCCUPIED'
    ? [item(`Property ${i + 1}: type of house property`, 'Self-occupied'), item(`Property ${i + 1}: interest payable on borrowed capital`, h.interestAllowed ?? 0)]
    : [item(`Property ${i + 1}: type of house property`, 'Let out'), item(`Property ${i + 1}: gross rent received`, h.rentReceived), item(`Property ${i + 1}: tax paid to local authorities`, h.municipalTaxPaid),
      item(`Property ${i + 1}: 30% of annual value`, h.standardDeduction, 'The portal works this out.'), item(`Property ${i + 1}: interest payable on borrowed capital`, h.interest)]));
  if (c.houseProperties.length) hpItems.push(item('Income chargeable under the head House Property', c.houseProperty, c.hpLossCarriedForward ? `The rest of the loss (${n(c.hpLossCarriedForward)}) is carried forward — Schedule CFL (ITR-2).` : null));
  const os = c.otherSources;
  const osItems = [
    ...(os.savingsInterest ? [item('Interest from saving bank accounts', os.savingsInterest)] : []),
    ...(os.depositInterest ? [item('Interest from deposits (bank / post office / co-operative society)', os.depositInterest)] : []),
    ...(os.dividends ? [item('Dividend income', os.dividends, 'ITR-2 also asks the dividends by quarter of receipt (for 234C).')] : []),
    ...(parts.income?.other ?? []).filter((o) => n(o.amount)).map((o) => item(`Any other income — ${o.description || 'other'}`, o.amount)),
  ];
  const cg = c.capitalGains;
  const cgItems = [
    ...(cg.ltcg112A ? [item('Long-term capital gains u/s 112A', cg.ltcg112A, r.form.form === 'ITR1' ? 'In ITR-1 this is the one LTCG line (up to the limit).' : 'Schedule 112A lists each sale (or one total per scrip for grandfathered shares).')] : []),
    ...(cg.stcg111A ? [item('Short-term capital gains u/s 111A (equity, STT paid)', cg.stcg111A, 'Schedule CG, part A.')] : []),
    ...(cg.ltcg112 ? [item('Long-term capital gains u/s 112 (other assets)', cg.ltcg112, 'Schedule CG, part B.')] : []),
    ...(cg.stcgOther ? [item('Short-term capital gains at normal rates', cg.stcgOther, 'Schedule CG, part A.')] : []),
  ];
  // `counted`: each deduction's part after the cut to the gross total income (engine.js), so the lines add up to the total.
  const dedItems = c.deductions.map((d) => {
    const counted = d.counted ?? d.allowed;
    const notes = [d.claimed !== d.allowed ? `You entered ${n(d.claimed)}; the limit allows ${n(d.allowed)}.` : null, counted !== d.allowed ? `Only ${n(counted)} fits in the gross total income (the later deductions are cut first).` : null].filter(Boolean);
    return item(`${d.section}`, counted, notes.length ? notes.join(' ') : null);
  });
  const taxPaid = [
    item(`TDS on salary — ${s.employerName ?? 'employer'} (TAN ${s.tan ?? 'from your certificate'})`, s.tds.value),
    ...(s.previous ? [item(`TDS on salary — ${s.previous.name ?? 'previous employer'}`, s.previous.tds)] : []),
    ...(parts.taxes?.otherTds ?? []).filter((t) => t.kind !== 'TCS').map((t) => item(`TDS other than salary — ${t.deductor ?? ''} ${t.tan ? `(TAN ${t.tan})` : ''}`.trim(), t.amount, 'It should match your Form 26AS / AIS.')),
    ...(parts.taxes?.otherTds ?? []).filter((t) => t.kind === 'TCS').map((t) => item(`TCS — ${t.deductor ?? ''}`.trim(), t.amount)),
    ...(parts.taxes?.paid ?? []).map((t) => item(`${t.kind === 'ADVANCE' ? 'Advance tax' : 'Self-assessment tax'} — BSR ${t.bsrCode ?? '…'}, ${t.date ?? '…'}, challan ${t.challanNo ?? '…'}`, t.amount)),
  ];
  const liability = [
    item('Tax regime', r.regime === 'OLD' ? 'Old regime (opt out of the new regime: answer "Yes" to opting out)' : 'New regime (the default)'),
    item('Total income', c.taxableIncome),
    item('Tax payable on total income', c.taxBeforeRebate),
    item('Rebate u/s 87A', c.rebate),
    ...(c.surcharge ? [item('Surcharge', c.surcharge)] : []),
    item('Health and education cess', c.cess),
    item('Interest u/s 234A / 234B / 234C', r.interest.total, 'The portal works out the interest itself; ours is an estimate to check it against.'),
    ...(r.interest.fee ? [item('Fee u/s 234F', r.interest.fee)] : []),
    item(r.payable ? 'Amount payable' : 'Refund', r.payable || r.refund),
  ];
  const bank = item('Bank account for the refund', 'Pick it in "Bank details" — it must be pre-validated on the portal (Profile › My Bank Account).');
  if (r.form.form === 'ITR1') {
    return {
      form: 'ITR1',
      intro: 'On incometax.gov.in: e-File › Income Tax Returns › File Income Tax Return › assessment year ' + r.assessmentYear + ' › Online › Individual › ITR-1. The portal fills much from your AIS; check each number against this list.',
      screens: [
        { screen: 'Personal Information', items: [item('Filing section', 'On or before the due date — 139(1)' + (r.interest.late ? ' (after it: 139(4))' : '')), item('Opting out of the new regime', r.regime === 'OLD' ? 'Yes' : 'No'), bank] },
        { screen: 'Gross Total Income › Salary', items: salaryItems },
        ...(hpItems.length ? [{ screen: 'Gross Total Income › House Property', items: hpItems }] : []),
        ...(osItems.length ? [{ screen: 'Gross Total Income › Income from Other Sources', items: osItems }] : []),
        ...(cgItems.length ? [{ screen: 'Gross Total Income › Long-term capital gains u/s 112A', items: cgItems }] : []),
        { screen: 'Total Deductions', items: dedItems.length ? dedItems : [item('Deductions', 0, 'None claimed.')] },
        { screen: 'Tax Paid', items: taxPaid },
        { screen: 'Total Tax Liability', items: liability },
        { screen: 'Preview and submit', items: [item('Verify', 'Submit, then e-verify (Aadhaar OTP, net banking or a bank account EVC) within the time allowed.')] },
      ],
    };
  }
  return {
    form: 'ITR2',
    intro: 'On incometax.gov.in: e-File › Income Tax Returns › File Income Tax Return › assessment year ' + r.assessmentYear + ' › Online › Individual › ITR-2. Pick the schedules below when the portal asks which apply to you.',
    screens: [
      { screen: 'Part A — General information', items: [item('Filing section', 'On or before the due date — 139(1)' + (r.interest.late ? ' (after it: 139(4))' : '')), item('Opting out of the new regime', r.regime === 'OLD' ? 'Yes' : 'No'), bank] },
      { screen: 'Schedule S — Salary', items: salaryItems },
      ...(hpItems.length ? [{ screen: 'Schedule HP — House property', items: hpItems }] : []),
      ...(cgItems.length ? [{ screen: 'Schedule CG — Capital gains (and Schedule 112A)', items: cgItems }] : []),
      ...(osItems.length ? [{ screen: 'Schedule OS — Other sources', items: osItems }] : []),
      { screen: 'Schedule VI-A — Deductions', items: dedItems.length ? dedItems : [item('Deductions', 0, 'None claimed.')] },
      ...(c.hpLossCarriedForward ? [{ screen: 'Schedule CYLA / CFL — losses', items: [item('House-property loss carried forward', c.hpLossCarriedForward)] }] : []),
      { screen: 'Part B-TI — Total income', items: r.schedules.BTI.map((x) => item(x.label, x.amount)) },
      { screen: 'Part B-TTI — Tax on total income', items: liability },
      { screen: 'Schedules TDS1 / TDS2 / TCS / IT — taxes paid', items: taxPaid },
      { screen: 'Preview and submit', items: [item('Verify', 'Submit, then e-verify (Aadhaar OTP, net banking or a bank account EVC) within the time allowed.')] },
    ],
  };
}
