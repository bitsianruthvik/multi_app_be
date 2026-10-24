/**
 * review.js — the company's CA reviews the rules and the calculations (spec §36.5).
 *
 * THE RULES IN FORCE come from the law layer (lawAdapter.rulesInForce — its own "Rules in force" page
 * is C1's; this is the REVIEW layer on top of the same list). They are grouped into RULE SETS:
 * "<domain>:<jurisdiction>" ("PF:IN", "PT:TS") and, for income tax, "TAX:IN:<tax year>".
 *
 *   a set's state   PENDING / APPROVED / QUESTIONED, with the set's FINGERPRINT (its rules' versions
 *                   and values) at the decision. A new version changes the fingerprint: the set is
 *                   PENDING again, said ("changed since you approved it").
 *   comments        COMMENT, APPROVE, QUESTION (a question needs words). Kept, never edited.
 *   since sign-off  what was published, and which sets changed, since the last yearly sign-off.
 *   trace           one person in one run: every payslip line, and the rule version each used — from
 *                   the law layer's run snapshot when it has one, else from the run's own lines and
 *                   tax_json and the rules in force at the month's end (said: "derived").
 *   sign-off        once per company and tax year, by a login with cf_hrms_compliance_review. It
 *                   writes hrms_tax_settings.ca_reviewed for the year (P2's "Reviewed by our CA" tick,
 *                   services/payrollTax/settings.js) — the banner on every tax screen goes.
 *
 * Writing needs the named right cf_hrms_compliance_review (the "Reviewer (CA)" ready-made role holds
 * it; the Owner holds every right). Reading needs compliance view; amounts need payroll + pay view.
 */
import { invalid, notFound, conflict } from '../../lib/errors.js';
import { audit } from '../peopleService.js';
import { auditSalaryRead } from '../payroll/payrollService.js';
import { defaultsFor } from '../payrollTax/settings.js';
import { rulesInForce, fingerprint, runSnapshot, reproduceRun, taxYearOf, lawStatus } from './lawAdapter.js';
import { today } from './calendar.js';

const json = (v, d = null) => { if (v == null) return d; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch { return d; } };
const stamp = (v) => (v ? (v instanceof Date ? v.toISOString() : String(v)) : null);
const money = (v) => Math.round(Number(v ?? 0) * 100) / 100;
const YEAR_RE = /^\d{4}-\d{2}$/;

export const setOf = (r) => (r.domain === 'TAX' ? `TAX:${r.jurisdiction ?? 'IN'}:${r.taxYear ?? taxYearOf(r.effectiveFrom ?? today())}` : `${r.domain}:${r.jurisdiction ?? 'IN'}`);
const DOMAIN_WORD = { TAX: 'Income tax', PF: 'Provident fund', ESI: 'ESI', PT: 'Professional tax', LWF: 'Labour welfare fund', MIN_WAGE: 'Minimum wages', BONUS: 'Bonus', GRATUITY: 'Gratuity', OVERTIME: 'Overtime', LEAVE_MIN: 'Leave minimums', WAGES: 'Labour Code wages' };
export function setLabel(set) {
  const [d, j, y] = set.split(':');
  return `${DOMAIN_WORD[d] ?? d}${j && j !== 'IN' ? ` (${j})` : ''}${y ? ` ${y}` : ''}`;
}

/** A value in a few words for a list (the whole value is in the detail and the pack). */
export function valueWords(v) {
  if (v == null) return '';
  if (typeof v !== 'object') return String(v);
  const parts = [];
  for (const [k, x] of Object.entries(v)) {
    if (parts.join('; ').length > 160) { parts.push('…'); break; }
    if (x == null) continue;
    if (Array.isArray(x)) { if (k !== 'examples') parts.push(`${k}: ${x.length} ${x.length === 1 ? 'entry' : 'entries'}`); continue; }
    if (typeof x === 'object') continue;
    parts.push(`${k} ${x}`);
  }
  return parts.join('; ') || JSON.stringify(v).slice(0, 160);
}

/** The rule sets of a company on a date, with their review state. */
export async function ruleSets(db, companyId, { on = today() } = {}) {
  const rules = await rulesInForce(companyId, on, db);
  const groups = new Map();
  for (const r of rules) {
    const s = setOf(r);
    if (!groups.has(s)) groups.set(s, []);
    groups.get(s).push(r);
  }
  const [reviews] = await db.query('SELECT r.*, u.name AS by_name FROM hrms_compliance_reviews r LEFT JOIN users u ON u.id = r.decided_by WHERE r.company_id = ? AND r.deleted_at IS NULL', [companyId]);
  const byset = new Map(reviews.map((r) => [r.rule_set, r]));
  const [counts] = await db.query('SELECT rule_set, COUNT(*) AS n FROM hrms_compliance_review_comments WHERE company_id = ? AND deleted_at IS NULL GROUP BY rule_set', [companyId]);
  const nComments = new Map(counts.map((c) => [c.rule_set, Number(c.n)]));
  const sets = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([set, list]) => {
    const fp = fingerprint(list);
    const rv = byset.get(set);
    const changed = Boolean(rv && rv.status !== 'PENDING' && rv.fingerprint && rv.fingerprint !== fp);
    return {
      set, label: setLabel(set), rules: list.length, unverified: list.filter((r) => !r.verified).length,
      status: changed ? 'PENDING' : (rv?.status ?? 'PENDING'), decidedStatus: rv?.status ?? null, changedSinceDecision: changed,
      decidedBy: rv?.by_name ?? null, decidedAt: stamp(rv?.decided_at), comments: nComments.get(set) ?? 0, fingerprint: fp,
      via: list[0]?.via ?? 'ADAPTER',
    };
  });
  return { on, sets, lawLayer: await lawStatus() };
}

/** One rule set: its rules (value, source, verified, examples) and every comment. */
export async function ruleSetDetail(db, companyId, set, { on = today() } = {}) {
  const rules = (await rulesInForce(companyId, on, db)).filter((r) => setOf(r) === set);
  if (!rules.length) throw notFound('That rule set');
  const all = await ruleSets(db, companyId, { on });
  const summary = all.sets.find((s) => s.set === set);
  const [comments] = await db.query(
    'SELECT c.*, u.name FROM hrms_compliance_review_comments c JOIN users u ON u.id = c.user_id WHERE c.company_id = ? AND c.rule_set = ? AND c.deleted_at IS NULL ORDER BY c.created_at, c.id', [companyId, set]);
  return {
    ...summary,
    ruleList: rules.map((r) => ({ id: r.id, ruleKey: r.ruleKey, value: r.value, valueWords: valueWords(r.value), effectiveFrom: r.effectiveFrom, version: r.version, sourceUrl: r.sourceUrl, sourceNote: r.sourceNote, verified: r.verified, examples: r.examples ?? null, regime: r.regime ?? null })),
    commentList: comments.map((c) => ({ id: c.id, action: c.action, body: c.body, ruleKey: c.rule_key, by: c.name, at: stamp(c.created_at) })),
  };
}

/** COMMENT / APPROVE / QUESTION on a set. */
export async function addReviewComment(db, c, set, body = {}) {
  const action = String(body.action ?? 'COMMENT').toUpperCase();
  const text = body.body == null ? null : String(body.body).trim().slice(0, 2000);
  const problems = [];
  if (!['COMMENT', 'APPROVE', 'QUESTION'].includes(action)) problems.push('Action: COMMENT, APPROVE or QUESTION.');
  if ((action === 'COMMENT' || action === 'QUESTION') && !text) problems.push(action === 'QUESTION' ? 'A question needs words: what is in doubt.' : 'A comment needs words.');
  if (problems.length) throw invalid('INVALID', 'The review cannot be saved yet.', { problems });
  const detail = await ruleSetDetail(db, c.companyId, set);
  const ruleKey = body.ruleKey && detail.ruleList.some((r) => r.ruleKey === body.ruleKey) ? body.ruleKey : null;
  const [ins] = await db.query('INSERT INTO hrms_compliance_review_comments (company_id, rule_set, rule_key, action, body, user_id) VALUES (?, ?, ?, ?, ?, ?)', [c.companyId, set, ruleKey, action, text, c.userId]);
  if (action !== 'COMMENT') {
    const status = action === 'APPROVE' ? 'APPROVED' : 'QUESTIONED';
    const [[rv]] = await db.query('SELECT id FROM hrms_compliance_reviews WHERE company_id = ? AND rule_set = ? AND deleted_at IS NULL FOR UPDATE', [c.companyId, set]);
    if (rv) await db.query('UPDATE hrms_compliance_reviews SET status = ?, fingerprint = ?, decided_by = ?, decided_at = ? WHERE id = ?', [status, detail.fingerprint, c.userId, new Date(), rv.id]);
    else await db.query('INSERT INTO hrms_compliance_reviews (company_id, rule_set, status, fingerprint, decided_by, decided_at) VALUES (?, ?, ?, ?, ?, ?)', [c.companyId, set, status, detail.fingerprint, c.userId, new Date()]);
  }
  await audit(db, c, 'hrms_compliance_review_comments', ins.insertId, action === 'COMMENT' ? 'CREATE' : 'APPROVE', null, { set, action, ruleKey, body: text }, null);
  return ruleSetDetail(db, c.companyId, set);
}

/** What changed since the last sign-off (or since ever): publications, sets whose rules changed, open questions. */
export async function changesSinceSignoff(db, companyId) {
  const [[last]] = await db.query('SELECT s.*, u.name FROM hrms_compliance_signoffs s JOIN users u ON u.id = s.signed_by WHERE s.company_id = ? AND s.deleted_at IS NULL ORDER BY s.signed_at DESC LIMIT 1', [companyId]);
  const since = last ? new Date(last.signed_at) : null;
  const [pubs] = await db.query(
    `SELECT p.id, p.title, p.domain, p.jurisdiction, p.rule_key, p.effective_from, p.published_at, p.source_url, p.summary
       FROM hrms_compliance_publications p WHERE p.deleted_at IS NULL ${since ? 'AND p.published_at > ?' : ''} ORDER BY p.published_at DESC LIMIT 200`, since ? [since] : []);
  const now = await ruleSets(db, companyId);
  const snap = json(last?.snapshot_json, {}) ?? {};
  const changedSets = now.sets.filter((s) => !snap.sets || !snap.sets[s.set] || snap.sets[s.set] !== s.fingerprint).map((s) => ({ set: s.set, label: s.label, status: s.status, isNew: !snap.sets?.[s.set] }));
  const [questions] = await db.query(
    "SELECT c.rule_set, c.body, c.created_at, u.name FROM hrms_compliance_review_comments c JOIN users u ON u.id = c.user_id WHERE c.company_id = ? AND c.action = 'QUESTION' AND c.deleted_at IS NULL ORDER BY c.created_at DESC LIMIT 100", [companyId]);
  const open = questions.filter((q) => now.sets.find((s) => s.set === q.rule_set)?.status === 'QUESTIONED');
  return {
    lastSignoff: last ? { year: last.tax_year, by: last.name, at: stamp(last.signed_at), note: last.note } : null,
    publications: pubs.map((p) => ({ id: p.id, title: p.title, domain: p.domain, jurisdiction: p.jurisdiction, ruleKey: p.rule_key, effectiveFrom: p.effective_from instanceof Date ? p.effective_from.toISOString().slice(0, 10) : String(p.effective_from).slice(0, 10), publishedAt: stamp(p.published_at), sourceUrl: p.source_url, summary: p.summary })),
    changedSets, openQuestions: open.map((q) => ({ set: q.rule_set, label: setLabel(q.rule_set), body: q.body, by: q.name, at: stamp(q.created_at) })),
  };
}

/** The runs a trace can be made for (months with people). */
export async function traceRuns(db, companyId) {
  const [runs] = await db.query("SELECT id, period_month, status, people_count FROM hrms_pay_runs WHERE company_id = ? AND deleted_at IS NULL AND status <> 'DRAFT' ORDER BY period_month DESC LIMIT 36", [companyId]);
  return runs.map((r) => ({ id: r.id, month: r.period_month, status: r.status, people: Number(r.people_count) }));
}
export async function tracePeople(db, companyId, runId) {
  const [rows] = await db.query(
    `SELECT p.id, p.employee_id, e.employee_code, e.full_name FROM hrms_pay_run_people p JOIN hrms_employees e ON e.company_id = p.company_id AND e.id = p.employee_id
      WHERE p.company_id = ? AND p.run_id = ? AND p.deleted_at IS NULL ORDER BY e.employee_code`, [companyId, runId]);
  return rows.map((r) => ({ runPersonId: r.id, employeeId: r.employee_id, code: r.employee_code, name: r.full_name }));
}

/** Which rule a payslip line rests on, when nothing stored says so. */
function ruleForLine(line, rules, tax) {
  const key = String(line.statutory_key ?? '').toUpperCase();
  const pick = (domain) => rules.find((r) => r.domain === domain && (domain !== 'PT' && domain !== 'LWF' ? true : r.jurisdiction === (line.state ?? r.jurisdiction)));
  if (line.source === 'TDS' || key === 'TDS') {
    const slabs = rules.find((r) => r.domain === 'TAX' && r.ruleKey === 'slabs' && (!tax?.regime || r.regime === tax.regime)) ?? rules.find((r) => r.domain === 'TAX');
    return slabs ? { id: slabs.id, ruleKey: `${slabs.ruleKey}${tax?.regime ? ` (${tax.regime.toLowerCase()} regime)` : ''}`, version: slabs.version, domain: 'TAX', sourceUrl: slabs.sourceUrl, verified: slabs.verified } : null;
  }
  for (const d of ['PF', 'ESI', 'PT', 'LWF']) {
    if (key.startsWith(d)) {
      const r = pick(d);
      return r ? { id: r.id, ruleKey: r.ruleKey, version: r.version, domain: d, jurisdiction: r.jurisdiction, effectiveFrom: r.effectiveFrom, sourceUrl: r.sourceUrl, verified: r.verified } : { missing: `no ${d} rule in force for the month` };
    }
  }
  return null;
}

/** One person in one run: every line with the rule version it used. Audited as a pay read. */
export async function calculationTrace(db, c, runId, employeeId, requestId = null) {
  const [[run]] = await db.query('SELECT * FROM hrms_pay_runs WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [c.companyId, runId]);
  if (!run) throw notFound('That payroll run');
  const [[p]] = await db.query(
    `SELECT p.*, e.employee_code, e.full_name, s.state_code FROM hrms_pay_run_people p JOIN hrms_employees e ON e.company_id = p.company_id AND e.id = p.employee_id
       LEFT JOIN hrms_pay_salaries s ON s.company_id = p.company_id AND s.id = p.salary_id
      WHERE p.company_id = ? AND p.run_id = ? AND p.employee_id = ? AND p.deleted_at IS NULL`, [c.companyId, runId, employeeId]);
  if (!p) throw notFound('That person in this run');
  const [lines] = await db.query(
    `SELECT l.*, k.code, k.name, k.statutory_key FROM hrms_pay_run_lines l JOIN hrms_pay_components k ON k.company_id = l.company_id AND k.id = l.component_id
      WHERE l.company_id = ? AND l.run_person_id = ? AND l.deleted_at IS NULL ORDER BY FIELD(l.kind, 'EARNING','REIMBURSEMENT','DEDUCTION','EMPLOYER_CONTRIBUTION'), l.sort_order, l.id`, [c.companyId, p.id]);
  const [yy, mm] = run.period_month.split('-').map(Number);
  const on = `${run.period_month}-${String(new Date(Date.UTC(yy, mm, 0)).getUTCDate()).padStart(2, '0')}`; // the month's last day
  const snapshot = await runSnapshot(db, c.companyId, runId);
  const tax = json(p.tax_json, null);
  let rules = [];
  let basis;
  if (snapshot?.rules?.length) { rules = snapshot.rules; basis = 'SNAPSHOT'; } else { rules = await rulesInForce(c.companyId, on, db); basis = 'DERIVED'; }
  const structure = p.structure_id ? (await db.query('SELECT code, name FROM hrms_pay_structures WHERE company_id = ? AND id = ?', [c.companyId, p.structure_id]))[0][0] : null;
  await auditSalaryRead(db, c, [p.employee_id], `calculation trace ${run.period_month}`, requestId);
  // With a snapshot, the law layer recomputes the run with exactly those versions (rolled back) and says
  // whether this person's lines come out the same — the proof that the trace is what was paid.
  let reproduced = null;
  if (basis === 'SNAPSHOT') {
    try {
      const rr = await reproduceRun(db, c, runId);
      if (rr) {
        const mine = (rr.differences ?? []).filter((d) => String(d).split(' ')[1]?.startsWith(`${p.employee_id}|`));
        reproduced = { same: mine.length === 0, runSame: Boolean(rr.same), differences: mine.slice(0, 20) };
      }
    } catch (e) { reproduced = { error: String(e.message).slice(0, 200) }; }
  }
  return {
    run: { id: run.id, month: run.period_month, status: run.status },
    person: { employeeId: p.employee_id, code: p.employee_code, name: p.full_name, state: p.state_code ?? null, structure: structure ? `${structure.code} ${structure.name}` : null, payableDays: Number(p.payable_days), lopDays: Number(p.lop_days), gross: money(p.gross), deductions: money(p.deductions), net: money(p.net_pay), tds: money(p.tds_amount) },
    basis,
    basisWords: basis === 'SNAPSHOT' ? 'The rule versions the run stored when it was calculated (the law layer’s snapshot).'
      : 'Derived: this run has no stored rule snapshot (runs before the law layer). Each statutory line is matched to the rule in force at the month’s end; TDS to the tax rules of the year and regime in the run’s tax working.',
    lines: lines.map((l) => {
      const rule = ruleForLine({ ...l, state: p.state_code }, rules, tax);
      return { code: l.code, name: l.name, kind: l.kind, amount: money(l.amount), fullAmount: l.full_amount == null ? null : money(l.full_amount), basis: l.basis, source: l.source, forMonth: l.for_month, rule };
    }),
    tax: tax ? { year: tax.year ?? null, regime: tax.regime ?? null, engineTds: tax.engineTds ?? null, projectedTax: tax.projectedTax ?? null } : null,
    reproduced,
  };
}

/** The yearly sign-offs of a company. */
export async function signoffs(db, companyId) {
  const [rows] = await db.query('SELECT s.*, u.name FROM hrms_compliance_signoffs s JOIN users u ON u.id = s.signed_by WHERE s.company_id = ? AND s.deleted_at IS NULL ORDER BY s.tax_year DESC', [companyId]);
  return rows.map((r) => ({ id: r.id, year: r.tax_year, by: r.name, at: stamp(r.signed_at), note: r.note, sets: Object.keys(json(r.snapshot_json, {})?.sets ?? {}).length }));
}

/** Sign a tax year off: the record, and P2's "Reviewed by our CA for <year>" tick. */
export async function signOff(db, c, body = {}) {
  const year = String(body.year ?? '');
  const note = body.note == null ? null : String(body.note).trim().slice(0, 1000);
  if (!YEAR_RE.test(year) || Number(year.slice(5)) !== (Number(year.slice(0, 4)) + 1) % 100) throw invalid('INVALID', 'Name the tax year as 2026-27.', { problems: ['Year: like 2026-27.'] });
  const [[have]] = await db.query('SELECT id FROM hrms_compliance_signoffs WHERE company_id = ? AND tax_year = ? AND deleted_at IS NULL FOR UPDATE', [c.companyId, year]);
  if (have) throw conflict('SIGNED_OFF', `${year} is signed off already.`);
  const sets = await ruleSets(db, c.companyId); // what the CA sees today: the fingerprints "what changed since" compares with
  const questioned = sets.sets.filter((s) => s.status === 'QUESTIONED');
  if (questioned.length && !body.withOpenQuestions) {
    throw conflict('OPEN_QUESTIONS', `${questioned.length} rule set${questioned.length === 1 ? ' is' : 's are'} questioned: ${questioned.map((s) => s.label).join(', ')}. Resolve them, or sign off saying so.`, { questioned: questioned.map((s) => s.set) });
  }
  const snapshot = { sets: Object.fromEntries(sets.sets.map((s) => [s.set, s.fingerprint])), status: Object.fromEntries(sets.sets.map((s) => [s.set, s.status])) };
  const [ins] = await db.query('INSERT INTO hrms_compliance_signoffs (company_id, tax_year, signed_by, signed_at, note, snapshot_json) VALUES (?, ?, ?, ?, ?, ?)', [c.companyId, year, c.userId, new Date(), note, JSON.stringify(snapshot)]);
  // P2's tick (hrms_tax_settings): the year's row, made with the defaults when it is not there yet.
  const [[me]] = await db.query('SELECT name FROM users WHERE id = ?', [c.userId]);
  const caNote = `Signed off by ${me?.name ?? 'the CA'} (Reviewer) on ${today()}${note ? ` — ${note}` : ''}`.slice(0, 500);
  const [[row]] = await db.query('SELECT id FROM hrms_tax_settings WHERE company_id = ? AND tax_year = ? AND deleted_at IS NULL FOR UPDATE', [c.companyId, year]);
  if (row) await db.query('UPDATE hrms_tax_settings SET ca_reviewed = 1, ca_reviewed_at = ?, ca_reviewed_by = ?, ca_note = ? WHERE id = ?', [new Date(), c.userId, caNote, row.id]);
  else {
    const d = defaultsFor(year);
    await db.query(
      'INSERT INTO hrms_tax_settings (company_id, tax_year, declaration_from, declaration_to, proof_from, proof_to, regime_cutoff, ca_reviewed, ca_reviewed_at, ca_reviewed_by, ca_note, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)',
      [c.companyId, year, d.declarationFrom, d.declarationTo, d.proofFrom, d.proofTo, d.regimeCutoff, new Date(), c.userId, caNote, c.userId]);
  }
  await audit(db, c, 'hrms_compliance_signoffs', ins.insertId, 'APPROVE', null, { year, note, sets: Object.keys(snapshot.sets).length, questioned: questioned.map((s) => s.set) }, null);
  return { signoffs: await signoffs(db, c.companyId), caNote };
}

export default { ruleSets, ruleSetDetail, addReviewComment, changesSinceSignoff, calculationTrace, traceRuns, tracePeople, signoffs, signOff, setOf, setLabel, valueWords };
