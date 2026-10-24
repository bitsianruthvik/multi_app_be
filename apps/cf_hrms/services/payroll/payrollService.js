/**
 * payrollService.js — components, structures, salaries and the statutory settings.
 * (TM/CF_HRMS_HIRING_SPEC.md §25.2.) Runs and payslips: runService.js.
 *
 * Every write is audited in the caller's transaction. Nothing is hard-deleted: a component,
 * a structure or a statutory row is soft-deleted (and refused while something uses it); a
 * salary is ENDED by the next one, never overwritten — except a correction of a row no
 * locked run has used yet.
 *
 * SALARY AMOUNTS: the routes ask for cf_hrms_pay_view; every read of another person's salary
 * here writes a READ row in the audit log (`auditSalaryRead`).
 */
import * as LAW from '../law/index.js';
import * as LAWCO from '../law/company.js';
import { notFound, invalid } from '../../lib/errors.js';
import {
  audit, money, num, flag, text, isDate, json, stamp, refuse, bad, readAmount, longDate, dayBefore, dateText, today,
  loadComponents, loadStructures, shapeComponent, shapeSalary, SALARY_COLUMNS, overrideMap, companySettings, statutoryOn, seatsOn,
  STATUTORY_KEYS, STATUTORY_WORDS,
} from './common.js';
import { breakdown } from './structure.js';
import { checkLines, VARIABLES, parse, FormulaError, MAX_FORMULA_LENGTH } from './formula.js';
import { KINDS, inCtc } from './structure.js';
import { seedPayroll } from './seed.js';
import * as CHK from '../complianceChecks/wire.js';

const CODE_RE = /^[A-Z][A-Z0-9_]{0,29}$/;
const RESERVED = new Set([...VARIABLES, 'BALANCE', 'MIN', 'MAX', 'ROUND', 'OF']);
const TAXABLE = ['YES', 'PARTLY', 'NO'];
const FREQ = ['MONTHLY', 'YEARLY'];
const PF_MODES = ['CEILING', 'FULL', 'NONE'];
const LOCKED = ['LOCKED', 'RELEASED', 'PAID'];

/* ══ setup ══════════════════════════════════════════════════════════════ */

/** POST /payroll/setup — the ready-made components, the sample structure, the statutory rows. */
export async function setupPayroll(db, c, requestId) {
  return { created: await seedPayroll(db, c, requestId) };
}

/* ══ components ═════════════════════════════════════════════════════════ */

export async function listComponents(db, c) {
  const { list } = await loadComponents(db, c.companyId);
  const [uses] = await db.query(
    `SELECT l.component_id, COUNT(DISTINCT l.structure_id) AS n FROM hrms_pay_structure_lines l
       JOIN hrms_pay_structures s ON s.company_id = l.company_id AND s.id = l.structure_id AND s.deleted_at IS NULL
      WHERE l.company_id = ? AND l.deleted_at IS NULL GROUP BY l.component_id`, [c.companyId]);
  const n = new Map(uses.map((u) => [u.component_id, Number(u.n)]));
  return {
    // oneTimeOk: may be a one-time item of a run (runService.itemComponentOk).
    components: list.map((x) => ({ ...x, structureCount: n.get(x.id) ?? 0, oneTimeOk: x.status === 'ACTIVE' && (x.statutoryKey === 'TDS' || (!x.statutoryKey && x.kind !== 'EMPLOYER_CONTRIBUTION')) })),
    kinds: KINDS, statutoryKeys: STATUTORY_KEYS.map((k) => ({ key: k, label: STATUTORY_WORDS[k] })),
    exemptionRules: ['HRA', 'LTA', 'GRATUITY', 'LEAVE_ENCASHMENT', 'PERQUISITE', 'CONVEYANCE', 'CHILDREN_EDUCATION', 'NPS_80CCD2', 'SUPERANNUATION', 'OTHER'],
  };
}

function readComponent(body, { creating, current = null }) {
  const problems = [];
  const out = {};
  if (creating || body.code !== undefined) {
    const code = String(body.code ?? '').trim().toUpperCase();
    if (!CODE_RE.test(code)) problems.push('Code: capital letters, digits and _, starting with a letter, up to 30 (it is what a formula names: BASIC, HRA).');
    else if (RESERVED.has(code)) problems.push(`Code: ${code} is a word of the formula language. Choose another code.`);
    out.code = code;
  }
  if (creating || body.name !== undefined) {
    out.name = text(body.name, 120);
    if (!out.name) problems.push('Name: give the component a name.');
  }
  if (creating || body.kind !== undefined) {
    out.kind = String(body.kind ?? '').toUpperCase();
    if (!KINDS.includes(out.kind)) problems.push('Kind: an earning, a deduction, an employer contribution or a reimbursement.');
  }
  if (body.taxable !== undefined || creating) { out.taxable = String(body.taxable ?? 'YES').toUpperCase(); if (!TAXABLE.includes(out.taxable)) problems.push('Taxable: yes, partly or no.'); }
  if (body.exemptionRule !== undefined) out.exemptionRule = text(body.exemptionRule, 40)?.toUpperCase() ?? null;
  for (const [k, col] of [['inPfWage', 'in_pf_wage'], ['inEsiWage', 'in_esi_wage'], ['inGratuityWage', 'in_gratuity_wage'], ['prorateOnLop', 'prorate_on_lop']]) {
    if (body[k] !== undefined) out[col] = flag(body[k]) ? 1 : 0;
  }
  if (body.frequency !== undefined || creating) { out.frequency = String(body.frequency ?? 'MONTHLY').toUpperCase(); if (!FREQ.includes(out.frequency)) problems.push('Paid: monthly or yearly.'); }
  if (body.sortOrder !== undefined) out.sort_order = Number.isInteger(Number(body.sortOrder)) ? Number(body.sortOrder) : 0;
  if (body.status !== undefined) { out.status = String(body.status).toUpperCase(); if (!['ACTIVE', 'INACTIVE'].includes(out.status)) problems.push('Status: active or inactive.'); }
  if (body.description !== undefined) out.description = text(body.description, 500);
  if (body.statutoryKey !== undefined && String(body.statutoryKey ?? '') !== String(current?.statutoryKey ?? '')) {
    problems.push('What the run works out by law (PF, ESI, professional tax, LWF, TDS, arrears) is set on the ready-made components and cannot be changed.');
  }
  const kind = out.kind ?? current?.kind;
  if (current?.statutoryKey && out.kind && out.kind !== current.kind) problems.push(`${current.name} is worked out by law as a ${current.kind.toLowerCase().replace('_', ' ')}; its kind cannot change.`);
  if (kind === 'DEDUCTION' || kind === 'EMPLOYER_CONTRIBUTION') {
    if (out.in_pf_wage || out.in_esi_wage) problems.push('Only an earning counts toward the PF or ESI wage.');
  }
  return { out, problems };
}

async function componentRow(db, companyId, id) {
  const [[r]] = await db.query('SELECT * FROM hrms_pay_components WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, id]);
  if (!r) throw notFound('That component');
  return shapeComponent(r);
}

/** Where a component is used: structure lines (live), formulas naming it, run lines. */
async function usesOf(db, companyId, comp) {
  const [lines] = await db.query(
    `SELECT s.name, l.formula, l.component_id FROM hrms_pay_structure_lines l JOIN hrms_pay_structures s ON s.company_id = l.company_id AND s.id = l.structure_id AND s.deleted_at IS NULL
      WHERE l.company_id = ? AND l.deleted_at IS NULL`, [companyId]);
  const re = new RegExp(`\\b${comp.code}\\b`, 'i');
  const structures = [...new Set(lines.filter((l) => l.component_id === comp.id).map((l) => l.name))];
  const formulas = [...new Set(lines.filter((l) => l.component_id !== comp.id && re.test(l.formula)).map((l) => l.name))];
  const [[run]] = await db.query('SELECT COUNT(*) AS n FROM hrms_pay_run_lines WHERE company_id = ? AND component_id = ? AND deleted_at IS NULL', [companyId, comp.id]);
  const [[item]] = await db.query('SELECT COUNT(*) AS n FROM hrms_pay_items WHERE company_id = ? AND component_id = ? AND deleted_at IS NULL', [companyId, comp.id]);
  return { structures, formulas, runLines: Number(run.n), items: Number(item.n) };
}

export async function createComponent(db, c, body = {}, requestId = null) {
  const { out, problems } = readComponent(body, { creating: true });
  if (problems.length) throw bad('The component cannot be saved yet.', problems);
  const [ins] = await db.query(
    `INSERT INTO hrms_pay_components (company_id, code, name, kind, taxable, exemption_rule, in_pf_wage, in_esi_wage, in_gratuity_wage, frequency, prorate_on_lop, sort_order, status, description, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [c.companyId, out.code, out.name, out.kind, out.taxable, out.exemptionRule ?? null, out.in_pf_wage ?? 0, out.in_esi_wage ?? 0, out.in_gratuity_wage ?? 0,
      out.frequency, out.prorate_on_lop ?? 1, out.sort_order ?? 500, out.status ?? 'ACTIVE', out.description ?? null, c.userId],
  ).catch((e) => { if (e.errno === 1062) throw refuse('DUPLICATE', `A component with the code ${out.code} already exists.`); throw e; });
  const comp = await componentRow(db, c.companyId, ins.insertId);
  await audit(db, c, 'hrms_pay_components', comp.id, 'CREATE', null, comp, requestId);
  return { component: comp };
}

export async function updateComponent(db, c, id, body = {}, requestId = null) {
  const before = await componentRow(db, c.companyId, id);
  const { out, problems } = readComponent(body, { creating: false, current: before });
  if (out.code && out.code !== before.code) {
    const u = await usesOf(db, c.companyId, before);
    if (u.structures.length || u.formulas.length || u.runLines || u.items) {
      problems.push(`The code ${before.code} is in use (${[...u.structures, ...u.formulas].join(', ') || 'payroll runs'}): formulas and runs name it. Keep the code; change the name.`);
    }
  }
  if (before.statutoryKey && out.status === 'INACTIVE' && ['PF_EE', 'PF_ER', 'ESI_EE', 'ESI_ER', 'ARREARS'].includes(before.statutoryKey)) {
    // Allowed: a company not covered by ESI switches ESI off. Said in the answer.
  }
  if (problems.length) throw bad('The component cannot be saved yet.', problems);
  const cols = Object.keys(out);
  if (!cols.length) return { component: before };
  await db.query(`UPDATE hrms_pay_components SET ${cols.map((k) => `${k} = ?`).join(', ')} WHERE company_id = ? AND id = ?`, [...cols.map((k) => out[k]), c.companyId, id])
    .catch((e) => { if (e.errno === 1062) throw refuse('DUPLICATE', `A component with the code ${out.code} already exists.`); throw e; });
  const after = await componentRow(db, c.companyId, id);
  await audit(db, c, 'hrms_pay_components', id, 'UPDATE', before, after, requestId);
  return { component: after };
}

export async function deleteComponent(db, c, id, requestId = null) {
  const comp = await componentRow(db, c.companyId, id);
  if (comp.statutoryKey) throw refuse('IN_USE', `${comp.name} is worked out by law in every run. Make it inactive instead of removing it.`);
  const u = await usesOf(db, c.companyId, comp);
  if (u.structures.length || u.formulas.length) throw refuse('IN_USE', `${comp.name} is in use by ${[...new Set([...u.structures, ...u.formulas])].join(', ')}. Take it out of those structures first, or make it inactive.`);
  if (u.runLines || u.items) throw refuse('IN_USE', `${comp.name} has been paid in a payroll run. It stays, for the payslips that print it: make it inactive instead.`);
  await db.query('UPDATE hrms_pay_components SET deleted_at = NOW() WHERE company_id = ? AND id = ?', [c.companyId, id]);
  await audit(db, c, 'hrms_pay_components', id, 'DELETE', comp, null, requestId);
  return { ok: true };
}

/* ══ structures ═════════════════════════════════════════════════════════ */

async function varsOn(db, companyId, on) {
  const s = await statutoryOn(db, companyId, on, (await companySettings(db, companyId)).stateCode);
  return { PF_CEILING: s.PF?.wageCeiling ?? null, ESI_CEILING: s.ESI?.wageCeiling ?? null };
}

function shapeStructure(s, comps) {
  return {
    id: s.id, code: s.code, name: s.name, description: s.description, status: s.status, updatedAt: s.updatedAt,
    lines: s.lines.map((l) => {
      const k = comps.byId.get(l.componentId);
      return { id: l.id, componentId: l.componentId, code: k?.code ?? null, name: k?.name ?? '(removed)', kind: k?.kind ?? null, formula: l.formula, sortOrder: l.sortOrder };
    }),
  };
}

export async function listStructures(db, c) {
  const [structs, comps] = await Promise.all([loadStructures(db, c.companyId), loadComponents(db, c.companyId)]);
  const [counts] = await db.query(
    `SELECT structure_id, COUNT(DISTINCT employee_id) AS n FROM hrms_pay_salaries WHERE company_id = ? AND deleted_at IS NULL
        AND effective_from <= CURDATE() AND (effective_to IS NULL OR effective_to >= CURDATE()) GROUP BY structure_id`, [c.companyId]);
  const n = new Map(counts.map((r) => [r.structure_id, Number(r.n)]));
  return { structures: [...structs.values()].map((s) => ({ ...shapeStructure(s, comps), peopleCount: n.get(s.id) ?? 0 })) };
}

export async function getStructure(db, c, id) {
  const [structs, comps] = await Promise.all([loadStructures(db, c.companyId, [id]), loadComponents(db, c.companyId)]);
  const s = structs.get(id);
  if (!s) throw notFound('That salary structure');
  return { structure: shapeStructure(s, comps), variables: VARIABLES };
}

/** Reads lines from a body: [{ componentId, formula }] -> checked rows, problems. */
function readLines(rawLines, comps) {
  const problems = [];
  if (!Array.isArray(rawLines)) return { lines: [], problems: ['Send the structure’s lines as a list.'] };
  if (rawLines.length > 60) problems.push('A structure has at most 60 lines.');
  const lines = [];
  const seen = new Set();
  rawLines.forEach((l, i) => {
    const comp = comps.byId.get(Number(l?.componentId)) ?? comps.byCode.get(String(l?.code ?? '').toUpperCase());
    if (!comp) { problems.push(`Line ${i + 1}: choose a component.`); return; }
    if (seen.has(comp.id)) { problems.push(`${comp.name} is in the structure twice.`); return; }
    seen.add(comp.id);
    const formula = String(l?.formula ?? '').trim();
    if (formula.length > MAX_FORMULA_LENGTH) problems.push(`${comp.name}: a formula is at most ${MAX_FORMULA_LENGTH} characters.`);
    if (comp.statutoryKey && !['PF_ER', 'ESI_ER', 'LWF_ER'].includes(comp.statutoryKey)) problems.push(`${comp.name} is worked out by the run from the month’s wages. Leave it out of the structure.`);
    lines.push({ componentId: comp.id, formula, sortOrder: (i + 1) * 10, comp });
  });
  const check = checkLines(lines.map((l) => ({ code: l.comp.code, name: l.comp.name, formula: l.formula, inCtc: inCtc(l.comp.kind) })));
  problems.push(...check.problems);
  return { lines, problems };
}

/** POST /payroll/structures/preview { lines, annualCtc, overrides?, pfMode? } — the live preview. Writes nothing. */
export async function previewStructure(db, c, body = {}) {
  const comps = await loadComponents(db, c.companyId);
  const { lines, problems } = readLines(body.lines ?? [], comps);
  const p = [];
  const ctc = readAmount(body.annualCtc ?? 600000, 'Sample CTC', p);
  const vars = await varsOn(db, c.companyId, isDate(body.on) ? body.on : today());
  if (problems.length || p.length) return { ok: false, problems: [...problems, ...p], warnings: [], lines: [], vars };
  const pfMode = PF_MODES.includes(body.pfMode) ? body.pfMode : 'CEILING';
  const b = breakdown(lines, comps.byId, ctc, body.overrides ?? {}, { pfMode, vars });
  // Spec §36.2: the live compliance check for the sample CTC and the role's skill (body.place: { roleId?, state?, zone?, skill? }).
  const compliance = b.ok ? await CHK.structurePreviewChecks(db, c, { lines: b.lines, components: comps, place: body.place ?? {}, on: isDate(body.on) ? body.on : today(), pfMode }) : null;
  return { ...b, vars, compliance };
}

async function writeLines(db, c, structureId, lines) {
  await db.query('UPDATE hrms_pay_structure_lines SET deleted_at = NOW() WHERE company_id = ? AND structure_id = ? AND deleted_at IS NULL', [c.companyId, structureId]);
  for (const l of lines) {
    await db.query('INSERT INTO hrms_pay_structure_lines (company_id, structure_id, component_id, formula, sort_order, created_by) VALUES (?, ?, ?, ?, ?, ?)',
      [c.companyId, structureId, l.componentId, l.formula, l.sortOrder, c.userId]);
  }
}

export async function createStructure(db, c, body = {}, requestId = null) {
  const comps = await loadComponents(db, c.companyId);
  const problems = [];
  const code = String(body.code ?? '').trim().toUpperCase();
  if (!CODE_RE.test(code)) problems.push('Code: capital letters, digits and _, starting with a letter, up to 30.');
  const name = text(body.name, 120);
  if (!name) problems.push('Name: give the structure a name.');
  let raw = body.lines;
  if (body.copyOf != null) {
    const src = (await loadStructures(db, c.companyId, [Number(body.copyOf)])).get(Number(body.copyOf));
    if (!src) problems.push('The structure to copy is not there.');
    else raw = src.lines.map((l) => ({ componentId: l.componentId, formula: l.formula }));
  }
  const { lines, problems: lp } = readLines(raw ?? [], comps);
  problems.push(...lp);
  if (problems.length) throw bad('The structure cannot be saved yet.', problems);
  const [ins] = await db.query("INSERT INTO hrms_pay_structures (company_id, code, name, description, status, created_by) VALUES (?, ?, ?, ?, 'ACTIVE', ?)",
    [c.companyId, code, name, text(body.description, 500), c.userId])
    .catch((e) => { if (e.errno === 1062) throw refuse('DUPLICATE', `A structure with the code ${code} already exists.`); throw e; });
  await writeLines(db, c, ins.insertId, lines);
  const out = await getStructure(db, c, ins.insertId);
  await structureAcks(db, c, ins.insertId, lines, comps, body);
  await audit(db, c, 'hrms_pay_structures', ins.insertId, 'CREATE', null, { code, name, lines: lines.map((l) => [l.comp.code, l.formula]) }, requestId);
  return out;
}

export async function updateStructure(db, c, id, body = {}, requestId = null) {
  const before = (await getStructure(db, c, id)).structure;
  const problems = [];
  const sets = {};
  if (body.name !== undefined) { sets.name = text(body.name, 120); if (!sets.name) problems.push('Name: give the structure a name.'); }
  if (body.description !== undefined) sets.description = text(body.description, 500);
  if (body.status !== undefined) {
    sets.status = String(body.status).toUpperCase();
    if (!['ACTIVE', 'INACTIVE'].includes(sets.status)) problems.push('Status: active or inactive.');
  }
  let lines = null;
  if (body.lines !== undefined) {
    const comps = await loadComponents(db, c.companyId);
    const r = readLines(body.lines, comps);
    problems.push(...r.problems);
    lines = r.lines;
  }
  if (problems.length) throw bad('The structure cannot be saved yet.', problems);
  const cols = Object.keys(sets);
  if (cols.length) await db.query(`UPDATE hrms_pay_structures SET ${cols.map((k) => `${k} = ?`).join(', ')} WHERE company_id = ? AND id = ?`, [...cols.map((k) => sets[k]), c.companyId, id]);
  if (lines) await writeLines(db, c, id, lines);
  if (lines && body.complianceReason) await structureAcks(db, c, id, lines, await loadComponents(db, c.companyId), body);
  if (!cols.length && lines) await db.query('UPDATE hrms_pay_structures SET updated_at = NOW() WHERE company_id = ? AND id = ?', [c.companyId, id]);
  const after = await getStructure(db, c, id);
  await audit(db, c, 'hrms_pay_structures', id, 'UPDATE',
    { name: before.name, status: before.status, lines: before.lines.map((l) => [l.code, l.formula]) },
    { name: after.structure.name, status: after.structure.status, lines: after.structure.lines.map((l) => [l.code, l.formula]) }, requestId);
  return after;
}

/** A structure saved with body.complianceReason: its structure-level WARNs (50% rule, usual shares) at the sample CTC are accepted. */
async function structureAcks(db, c, structureId, lines, comps, body) {
  if (!body.complianceReason) return;
  const ctc = Number(body.sampleCtc) > 0 ? Number(body.sampleCtc) : 600000;
  const b = breakdown(lines, comps.byId, ctc, {}, { vars: await varsOn(db, c.companyId, today()) });
  if (!b.ok) return;
  const chk = await CHK.structurePreviewChecks(db, c, { lines: b.lines, components: comps, place: body.place ?? {} });
  await CHK.structureSaveAcks(db, c, structureId, chk.results, body.complianceReason);
}

export async function deleteStructure(db, c, id, requestId = null) {
  const s = (await getStructure(db, c, id)).structure;
  const [[used]] = await db.query('SELECT COUNT(*) AS n FROM hrms_pay_salaries WHERE company_id = ? AND structure_id = ? AND deleted_at IS NULL', [c.companyId, id]);
  if (Number(used.n)) throw refuse('IN_USE', `${s.name} is the structure of ${used.n} salar${Number(used.n) === 1 ? 'y' : 'ies'} (now or in the past). Make it inactive instead.`);
  await db.query('UPDATE hrms_pay_structure_lines SET deleted_at = NOW() WHERE company_id = ? AND structure_id = ? AND deleted_at IS NULL', [c.companyId, id]);
  await db.query('UPDATE hrms_pay_structures SET deleted_at = NOW() WHERE company_id = ? AND id = ?', [c.companyId, id]);
  await audit(db, c, 'hrms_pay_structures', id, 'DELETE', { code: s.code, name: s.name }, null, requestId);
  return { ok: true };
}

/* ══ salaries ═══════════════════════════════════════════════════════════ */

/** Every read of ANOTHER person's salary leaves a READ row (spec §25.2). */
export async function auditSalaryRead(db, c, employeeIds, what, requestId = null) {
  const others = await notMe(db, c, employeeIds);
  if (!others.length) return;
  if (others.length === 1) {
    await audit(db, c, 'hrms_pay_salary_read', others[0], 'READ', null, { what }, requestId);
  } else {
    // A list: one row, naming everyone on it (entity 0 = many).
    await audit(db, c, 'hrms_pay_salary_read', 0, 'READ', null, { what, employeeIds: others.slice(0, 2000), count: others.length }, requestId);
  }
}
async function notMe(db, c, ids) {
  const [[me]] = await db.query('SELECT id FROM hrms_employees WHERE company_id = ? AND user_id = ? AND deleted_at IS NULL LIMIT 1', [c.companyId, c.userId ?? 0]);
  return [...new Set(ids.map(Number))].filter((id) => id && id !== me?.id);
}

/** The salary breakdown of one salary row, on its own first day. */
export async function salaryBreakdown(db, c, salary, { comps = null, structs = null, on = null } = {}) {
  const components = comps ?? await loadComponents(db, c.companyId);
  const structures = structs ?? await loadStructures(db, c.companyId, [salary.structureId]);
  const s = structures.get(salary.structureId);
  if (!s) return { ok: false, problems: ['The structure of this salary is not there any more.'], lines: [], totals: {} };
  const day = on ?? (salary.effectiveFrom > today() ? salary.effectiveFrom : today());
  const vars = await varsOn(db, c.companyId, day);
  return { ...breakdown(s.lines, components.byId, salary.annualCtc, overrideMap(salary), { pfMode: salary.pfMode, vars }), structure: { id: s.id, name: s.name, code: s.code } };
}

/**
 * GET /payroll/salaries?q=&structureId=&has=with|without — every person (not exited before this
 * year) with their salary today. One READ audit row for the list.
 */
export async function listSalaries(db, c, query = {}, requestId = null) {
  const where = ['e.company_id = ?', 'e.deleted_at IS NULL', "(e.employment_status <> 'EXITED' OR e.exit_date >= DATE_SUB(CURDATE(), INTERVAL 1 YEAR))"];
  const params = [c.companyId];
  if (query.q) { where.push('(e.full_name LIKE ? OR e.employee_code LIKE ?)'); const like = `%${String(query.q).trim().slice(0, 100)}%`; params.push(like, like); }
  const [emps] = await db.query(`SELECT e.id, e.employee_code, e.full_name, e.employment_status, e.date_of_joining, e.exit_date FROM hrms_employees e WHERE ${where.join(' AND ')} ORDER BY e.full_name, e.id LIMIT 5000`, params);
  const ids = emps.map((e) => e.id);
  const t = today();
  const [rows] = ids.length ? await db.query(
    `SELECT ${SALARY_COLUMNS} FROM hrms_pay_salaries WHERE company_id = ? AND deleted_at IS NULL AND employee_id IN (${ids.map(() => '?').join(',')}) ORDER BY effective_from`,
    [c.companyId, ...ids]) : [[]];
  const byEmp = new Map();
  for (const r of rows) { const s = shapeSalary(r); if (!byEmp.has(s.employeeId)) byEmp.set(s.employeeId, []); byEmp.get(s.employeeId).push(s); }
  const [structs, seats] = await Promise.all([loadStructures(db, c.companyId), seatsOn(db, c.companyId, ids, t)]);
  let items = emps.map((e) => {
    const all = byEmp.get(e.id) ?? [];
    const current = all.filter((s) => s.effectiveFrom <= t && (!s.effectiveTo || s.effectiveTo >= t)).pop() ?? null;
    const next = all.find((s) => s.effectiveFrom > t) ?? null;
    const shown = current ?? next;
    return {
      employee: { id: e.id, code: e.employee_code, name: e.full_name, status: e.employment_status, joiningDate: dateText(e.date_of_joining), exitDate: dateText(e.exit_date), ...(seats.get(e.id) ?? { positionTitle: null, departmentName: null }) },
      salary: shown ? { id: shown.id, annualCtc: shown.annualCtc, monthlyCtc: shown.monthlyCtc, effectiveFrom: shown.effectiveFrom, structure: structs.get(shown.structureId) ? { id: shown.structureId, name: structs.get(shown.structureId).name } : null, pfMode: shown.pfMode, future: !current } : null,
      revisions: all.length,
    };
  });
  if (query.structureId) items = items.filter((i) => i.salary?.structure?.id === Number(query.structureId));
  if (query.has === 'without') items = items.filter((i) => !i.salary);
  if (query.has === 'with') items = items.filter((i) => i.salary);
  await auditSalaryRead(db, c, items.filter((i) => i.salary).map((i) => i.employee.id), 'salaries list', requestId);
  return { items, total: items.length, structures: [...structs.values()].map((s) => ({ id: s.id, name: s.name, status: s.status })) };
}

async function employeeRow(db, companyId, employeeId) {
  const [[e]] = await db.query('SELECT id, employee_code, full_name, employment_status, date_of_joining, exit_date FROM hrms_employees WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, employeeId]);
  if (!e) throw notFound('That employee');
  return { id: e.id, code: e.employee_code, name: e.full_name, status: e.employment_status, joiningDate: dateText(e.date_of_joining), exitDate: dateText(e.exit_date) };
}

async function salaryRows(db, companyId, employeeId) {
  const [rows] = await db.query(`SELECT ${SALARY_COLUMNS} FROM hrms_pay_salaries WHERE company_id = ? AND employee_id = ? AND deleted_at IS NULL ORDER BY effective_from, id`, [companyId, employeeId]);
  return rows.map(shapeSalary);
}

/** Months of LOCKED (or later) runs that paid this person on a salary row — such a row is not corrected, it is revised. */
async function lockedMonthsOf(db, companyId, employeeId) {
  const [rows] = await db.query(
    `SELECT r.period_month, p.calc_json FROM hrms_pay_run_people p JOIN hrms_pay_runs r ON r.company_id = p.company_id AND r.id = p.run_id AND r.deleted_at IS NULL
      WHERE p.company_id = ? AND p.employee_id = ? AND p.deleted_at IS NULL AND p.included = 1 AND r.status IN ('LOCKED','RELEASED','PAID')`,
    [companyId, employeeId]);
  return rows.map((r) => ({ month: r.period_month, salaryIds: json(r.calc_json, {})?.salaryIds ?? [] }));
}

/** GET /payroll/salaries/:employeeId — the person, their salary today with its breakdown, and every revision. Audited. */
export async function getSalary(db, c, employeeId, requestId = null) {
  const employee = await employeeRow(db, c.companyId, employeeId);
  const [rows, comps] = await Promise.all([salaryRows(db, c.companyId, employeeId), loadComponents(db, c.companyId)]);
  const structs = await loadStructures(db, c.companyId, [...new Set(rows.map((r) => r.structureId))]);
  const t = today();
  const locked = await lockedMonthsOf(db, c.companyId, employeeId);
  const usedIds = new Set(locked.flatMap((l) => l.salaryIds));
  const history = [];
  for (const s of [...rows].reverse()) {
    history.push({
      ...s, structure: structs.get(s.structureId) ? { id: s.structureId, name: structs.get(s.structureId).name } : null,
      current: s.effectiveFrom <= t && (!s.effectiveTo || s.effectiveTo >= t), future: s.effectiveFrom > t, paidInLockedRun: usedIds.has(s.id),
      breakdown: await salaryBreakdown(db, c, s, { comps, structs }),
    });
  }
  await auditSalaryRead(db, c, [employeeId], 'salary of a person', requestId);
  const seat = (await seatsOn(db, c.companyId, [employeeId], t)).get(employeeId) ?? {};
  return { employee: { ...employee, ...seat }, current: history.find((h) => h.current) ?? null, history };
}

function readSalaryBody(body, { creating }) {
  const problems = [];
  const out = {};
  if (creating || body.annualCtc !== undefined) out.annualCtc = readAmount(body.annualCtc, 'CTC a year', problems);
  if (creating || body.structureId !== undefined) { out.structureId = Number(body.structureId); if (!Number.isInteger(out.structureId) || out.structureId <= 0) problems.push('Structure: choose a salary structure.'); }
  if (creating || body.effectiveFrom !== undefined) { out.effectiveFrom = String(body.effectiveFrom ?? '').slice(0, 10); if (!isDate(out.effectiveFrom)) problems.push('Effective from: a date as YYYY-MM-DD.'); }
  if (body.pfMode !== undefined) { out.pfMode = String(body.pfMode).toUpperCase(); if (!PF_MODES.includes(out.pfMode)) problems.push('PF: on the wage up to the ceiling, on the full wage, or not a PF member.'); }
  if (body.stateCode !== undefined) out.stateCode = text(body.stateCode, 10)?.toUpperCase() ?? null;
  if (body.reason !== undefined) out.reason = text(body.reason, 500);
  if (body.overrides !== undefined) {
    if (!Array.isArray(body.overrides)) problems.push('Overrides: send a list of { componentId, amount }.');
    else {
      out.overrides = [];
      for (const o of body.overrides) {
        if (o?.amount === null || o?.amount === undefined || o?.amount === '') continue;
        const a = readAmount(o.amount, 'An override', problems, { allowNegative: false });
        if (a != null) out.overrides.push({ componentId: Number(o.componentId), amount: a });
      }
    }
  }
  return { out, problems };
}

async function checkSalary(db, c, employee, s, { comps, structs }) {
  const problems = [];
  const structure = structs.get(s.structureId);
  if (!structure) problems.push('Structure: that salary structure is not there.');
  else if (structure.status !== 'ACTIVE') problems.push(`Structure: ${structure.name} is inactive.`);
  if (s.effectiveFrom && employee.joiningDate && s.effectiveFrom < employee.joiningDate) problems.push(`Effective from: ${longDate(s.effectiveFrom)} is before the person joined (${longDate(employee.joiningDate)}).`);
  if (s.effectiveFrom && employee.exitDate && s.effectiveFrom > employee.exitDate) problems.push(`Effective from: the person left on ${longDate(employee.exitDate)}.`);
  for (const o of s.overrides ?? []) {
    if (!structure?.lines.some((l) => l.componentId === o.componentId)) problems.push(`An override is for ${comps.byId.get(o.componentId)?.name ?? `component #${o.componentId}`}, which is not a line of ${structure?.name ?? 'the structure'}.`);
  }
  if (!problems.length) {
    const b = await salaryBreakdown(db, c, { ...s, overrides: s.overrides ?? [] }, { comps, structs, on: s.effectiveFrom });
    problems.push(...b.problems);
    if (b.ok && b.lines.some((l) => l.monthly < 0)) problems.push(...b.warnings);
  }
  return problems;
}

/**
 * POST /payroll/salaries { employeeId, annualCtc, structureId, effectiveFrom, overrides?, pfMode?, stateCode?, reason? }
 * A new salary or a revision. The row before it is ENDED the day before. A revision may be
 * dated in the past (a raise announced in June from April): the next run pays the arrears.
 * -> { salary, arrearsFrom?: month }
 */
export async function createSalary(db, c, body = {}, requestId = null, opts = {}) {
  const employeeId = Number(body.employeeId);
  if (!Number.isInteger(employeeId) || employeeId <= 0) throw bad('Choose the person.', ['Choose the person.']);
  const employee = await employeeRow(db, c.companyId, employeeId);
  await db.query('SELECT id FROM hrms_employees WHERE company_id = ? AND id = ? FOR UPDATE', [c.companyId, employeeId]);
  const { out, problems } = readSalaryBody(body, { creating: true });
  const rows = await salaryRows(db, c.companyId, employeeId);
  const last = rows.filter((r) => !r.effectiveTo || r.effectiveTo >= r.effectiveFrom).pop() ?? null;
  if (last && out.effectiveFrom && out.effectiveFrom <= last.effectiveFrom) {
    problems.push(`Effective from: the salary from ${longDate(last.effectiveFrom)} is the latest. A revision starts after it — or correct that one.`);
  }
  const [comps, structs] = await Promise.all([loadComponents(db, c.companyId), loadStructures(db, c.companyId)]);
  const s = { pfMode: (await LAWCO.getChoices(db, c.companyId)).pfWageBasis, overrides: [], ...out };
  if (!problems.length) problems.push(...await checkSalary(db, c, employee, s, { comps, structs }));
  if (problems.length) throw bad('The salary cannot be saved yet.', problems);
  // Spec §36.2: HARD refuses (422 COMPLIANCE_HARD); a WARN needs body.complianceReason (409 COMPLIANCE_WARN), kept with the approver.
  const gate = await CHK.salaryGate(db, c, { employeeId, salary: s, breakdown: await salaryBreakdown(db, c, { ...s, overrides: s.overrides ?? [] }, { comps, structs, on: s.effectiveFrom }), components: comps, body, warn: opts.warn ?? 'require', reason: opts.reason ?? null });
  if (last) {
    await db.query('UPDATE hrms_pay_salaries SET effective_to = ? WHERE company_id = ? AND id = ?', [dayBefore(s.effectiveFrom), c.companyId, last.id]);
    await audit(db, c, 'hrms_pay_salaries', last.id, 'UPDATE', { effectiveTo: last.effectiveTo }, { effectiveTo: dayBefore(s.effectiveFrom), endedBy: 'revision' }, requestId);
  }
  const [ins] = await db.query(
    `INSERT INTO hrms_pay_salaries (company_id, employee_id, effective_from, annual_ctc, structure_id, overrides_json, pf_mode, state_code, reason, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [c.companyId, employeeId, s.effectiveFrom, s.annualCtc, s.structureId, s.overrides.length ? JSON.stringify(s.overrides) : null, s.pfMode, s.stateCode ?? null, s.reason ?? null, c.userId],
  );
  const [[row]] = await db.query(`SELECT ${SALARY_COLUMNS} FROM hrms_pay_salaries WHERE id = ?`, [ins.insertId]);
  const salary = shapeSalary(row);
  await CHK.recordAcks(db, c, 'SALARY', salary.id, gate.toAck, gate.reason, { employeeId });
  await audit(db, c, 'hrms_pay_salaries', salary.id, 'CREATE', null, { employeeId, annualCtc: salary.annualCtc, structureId: salary.structureId, effectiveFrom: salary.effectiveFrom, pfMode: salary.pfMode, overrides: salary.overrides, reason: salary.reason }, requestId);
  const locked = await lockedMonthsOf(db, c.companyId, employeeId);
  const back = locked.filter((l) => l.month >= salary.effectiveFrom.slice(0, 7)).map((l) => l.month).sort();
  return { salary, compliance: gate.results, arrearsFor: back, note: back.length ? `Dated back over ${back.length} paid month${back.length === 1 ? '' : 's'} (${back.join(', ')}): the next run pays the arrears.` : null };
}

/** PUT /payroll/salaries/:id — corrects a row no locked run has paid on. Otherwise: add a revision. */
export async function updateSalary(db, c, id, body = {}, requestId = null, opts = {}) {
  const [[row]] = await db.query(`SELECT ${SALARY_COLUMNS} FROM hrms_pay_salaries WHERE company_id = ? AND id = ? AND deleted_at IS NULL`, [c.companyId, id]);
  if (!row) throw notFound('That salary');
  const before = shapeSalary(row);
  const employee = await employeeRow(db, c.companyId, before.employeeId);
  const locked = await lockedMonthsOf(db, c.companyId, before.employeeId);
  if (locked.some((l) => l.salaryIds.includes(id))) {
    throw refuse('PAID_ON', `A locked payroll (${locked.filter((l) => l.salaryIds.includes(id)).map((l) => l.month).join(', ')}) paid on this salary, so it is kept as it was. Add a revision from the day the change applies — a past day pays arrears.`);
  }
  const { out, problems } = readSalaryBody(body, { creating: false });
  const rows = await salaryRows(db, c.companyId, before.employeeId);
  const prev = rows.filter((r) => r.effectiveFrom < before.effectiveFrom).pop() ?? null;
  const nextRow = rows.find((r) => r.effectiveFrom > before.effectiveFrom) ?? null;
  if (out.effectiveFrom && ((prev && out.effectiveFrom <= prev.effectiveFrom) || (nextRow && out.effectiveFrom >= nextRow.effectiveFrom))) {
    problems.push('Effective from: it must stay between the salary before and the one after.');
  }
  const s = { ...before, ...out };
  const [comps, structs] = await Promise.all([loadComponents(db, c.companyId), loadStructures(db, c.companyId)]);
  if (!problems.length) problems.push(...await checkSalary(db, c, employee, s, { comps, structs }));
  if (problems.length) throw bad('The salary cannot be saved yet.', problems);
  const gate = await CHK.salaryGate(db, c, { employeeId: before.employeeId, salary: s, breakdown: await salaryBreakdown(db, c, { ...s, overrides: s.overrides ?? [] }, { comps, structs, on: s.effectiveFrom }), components: comps, body, warn: opts.warn ?? 'require', reason: opts.reason ?? null });
  await db.query('UPDATE hrms_pay_salaries SET effective_from = ?, annual_ctc = ?, structure_id = ?, overrides_json = ?, pf_mode = ?, state_code = ?, reason = ? WHERE company_id = ? AND id = ?',
    [s.effectiveFrom, s.annualCtc, s.structureId, s.overrides?.length ? JSON.stringify(s.overrides) : null, s.pfMode, s.stateCode ?? null, s.reason ?? null, c.companyId, id]);
  if (prev && out.effectiveFrom && out.effectiveFrom !== before.effectiveFrom) {
    await db.query('UPDATE hrms_pay_salaries SET effective_to = ? WHERE company_id = ? AND id = ?', [dayBefore(s.effectiveFrom), c.companyId, prev.id]);
  }
  const [[again]] = await db.query(`SELECT ${SALARY_COLUMNS} FROM hrms_pay_salaries WHERE id = ?`, [id]);
  const after = shapeSalary(again);
  await CHK.recordAcks(db, c, 'SALARY', id, gate.toAck, gate.reason, { employeeId: before.employeeId });
  await audit(db, c, 'hrms_pay_salaries', id, 'UPDATE', before, after, requestId);
  return { salary: after, compliance: gate.results };
}

/** DELETE /payroll/salaries/:id — only the latest row, unpaid; the row before it runs on again. */
export async function deleteSalary(db, c, id, requestId = null) {
  const [[row]] = await db.query(`SELECT ${SALARY_COLUMNS} FROM hrms_pay_salaries WHERE company_id = ? AND id = ? AND deleted_at IS NULL`, [c.companyId, id]);
  if (!row) throw notFound('That salary');
  const s = shapeSalary(row);
  const rows = await salaryRows(db, c.companyId, s.employeeId);
  if (rows.some((r) => r.effectiveFrom > s.effectiveFrom)) throw refuse('NOT_LATEST', 'Only the latest salary can be removed. Correct this one instead.');
  const locked = await lockedMonthsOf(db, c.companyId, s.employeeId);
  if (locked.some((l) => l.salaryIds.includes(id))) throw refuse('PAID_ON', 'A locked payroll paid on this salary. It stays.');
  await db.query('UPDATE hrms_pay_salaries SET deleted_at = NOW() WHERE company_id = ? AND id = ?', [c.companyId, id]);
  const prev = rows.filter((r) => r.effectiveFrom < s.effectiveFrom).pop();
  if (prev) await db.query('UPDATE hrms_pay_salaries SET effective_to = NULL WHERE company_id = ? AND id = ?', [c.companyId, prev.id]);
  await audit(db, c, 'hrms_pay_salaries', id, 'DELETE', s, prev ? { reopened: prev.id } : null, requestId);
  return { ok: true };
}

/* ══ statutory settings ══════════════════════════════════════════════════ */

/* ══ statutory: THE LAW LAYER (spec §36.1) ══════════════════════════════
 * PF, ESI, PT and LWF are product-level law since §37 (hrms_law_rules, services/law): read-only for a
 * company. The company keeps its CHOICES (PF basis for new salaries, registration numbers, bonus rate —
 * GET/PUT /law/choices) and may record its own note and "checked" mark against a version. */
const KINDS_S = ['PF', 'ESI', 'PT', 'LWF'];
const shapeStatutory = (r, note = null) => ({
  id: r.id, kind: r.domain, stateCode: r.jurisdiction, effectiveFrom: r.effectiveFrom, effectiveTo: r.effectiveTo ?? null, settings: r.value,
  source: r.sourceNote ?? null, sourceUrl: r.sourceUrl ?? null, verification: r.verified ? 'VERIFIED' : 'UNVERIFIED', note: r.note ?? null,
  version: r.version, status: r.status, publishedAt: r.publishedAt ?? null, reviewedBy: r.reviewedBy ?? null, title: r.title ?? null,
  companyNote: note ? { verification: note.verification, note: note.note } : null,
});
const LAW_WORDS = 'The law is kept by the product team for every company, versioned and published with its source.';

export async function listStatutory(db, c) {
  const settings = await companySettings(db, c.companyId);
  const states = await LAW.companyStates(db, c.companyId);
  const rows = (await LAW.listRules(db, { includeTax: false })).filter((r) => KINDS_S.includes(r.domain) && r.ruleKey === 'settings' && r.status !== 'DRAFT' && ['IN', ...states].includes(r.jurisdiction));
  const notes = await LAWCO.notesOf(db, c.companyId);
  const inForce = await statutoryOn(db, c.companyId, today(), settings.stateCode);
  const published = rows.filter((r) => r.status === 'PUBLISHED');
  return {
    settings: published.map((r) => shapeStatutory(r, notes.get(r.id))),
    superseded: rows.filter((r) => r.status === 'SUPERSEDED').map((r) => shapeStatutory(r, notes.get(r.id))),
    company: settings, choices: await LAWCO.getChoices(db, c.companyId), readOnly: true, readOnlyWhy: LAW_WORDS,
    inForce: Object.fromEntries(Object.entries(inForce).map(([k, v]) => [k, v?.meta?.id ?? null])),
    states: [{ code: 'IN', name: 'All India (PF, ESI)' }, ...LAWCO.STATES],
    unverified: published.filter((r) => !r.verified).length,
  };
}

export async function createStatutory() {
  throw refuse('LAW_IS_PRODUCT', `${LAW_WORDS} A new rate or slab is published there, from its date; it then applies to every company. Your own choices are under Payroll › Statutory settings › Your choices.`);
}

/**
 * PUT /payroll/statutory/:id — a published law version is never edited. Only the company's OWN note and
 * "checked" mark against it can be recorded (hrms_law_company_notes); the law row stays as published.
 */
export async function updateStatutory(db, c, id, body = {}, requestId = null) {
  const r = await LAW.getVersion(db, id);
  if (!r || r.kind !== 'LAW' || !KINDS_S.includes(r.domain) || r.status === 'DRAFT') throw notFound('Those statutory settings');
  const valuesChange = (body.settings !== undefined && JSON.stringify(body.settings) !== JSON.stringify(r.value))
    || (body.effectiveFrom !== undefined && String(body.effectiveFrom).slice(0, 10) !== r.effectiveFrom)
    || (body.kind !== undefined && String(body.kind).toUpperCase() !== r.domain)
    || (body.stateCode !== undefined && String(body.stateCode).toUpperCase() !== r.jurisdiction)
    || body.source !== undefined || body.sourceUrl !== undefined;
  if (valuesChange) {
    throw bad('Published law is not changed here.', [`Published law is never edited: to change it, the product team must add a new row (a new version of the rule) from the day the change applies. ${LAW_WORDS} You can still record your own note and “checked” mark.`]);
  }
  await LAWCO.setNote(db, c, r.id, { verification: body.verification, note: body.note }, requestId);
  return { setting: shapeStatutory(r, (await LAWCO.notesOf(db, c.companyId)).get(r.id)) };
}

export async function deleteStatutory() {
  throw refuse('LAW_IS_PRODUCT', `${LAW_WORDS} A published version stays, for the months that used it.`);
}

/** PUT /payroll/settings { stateCode?, debitAccountNo?, debitIfsc?, narration? } */
export async function putSettings(db, c, body = {}, requestId = null) {
  const before = await companySettings(db, c.companyId);
  const problems = [];
  const next = { ...before };
  if (body.stateCode !== undefined) { next.stateCode = String(body.stateCode ?? '').trim().toUpperCase(); if (!/^[A-Z]{2}$/.test(next.stateCode)) problems.push('State: a two-letter code (TG for Telangana).'); }
  if (body.debitAccountNo !== undefined) { next.debitAccountNo = text(body.debitAccountNo, 40); if (next.debitAccountNo && !/^[0-9A-Za-z]{6,40}$/.test(next.debitAccountNo)) problems.push('Debit account: letters and digits only.'); }
  if (body.debitIfsc !== undefined) { next.debitIfsc = text(body.debitIfsc, 20)?.toUpperCase() ?? null; if (next.debitIfsc && !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(next.debitIfsc)) problems.push('IFSC: four letters, a zero, then six letters or digits (SBIN0001234).'); }
  if (body.narration !== undefined) next.narration = text(body.narration, 60) ?? 'Salary';
  if (problems.length) throw bad('The payroll settings cannot be saved yet.', problems);
  const [[row]] = await db.query('SELECT id FROM hrms_pay_settings WHERE company_id = ? AND deleted_at IS NULL', [c.companyId]);
  if (row) await db.query('UPDATE hrms_pay_settings SET state_code = ?, debit_account_no = ?, debit_ifsc = ?, narration = ? WHERE id = ?', [next.stateCode, next.debitAccountNo, next.debitIfsc, next.narration, row.id]);
  else await db.query('INSERT INTO hrms_pay_settings (company_id, state_code, debit_account_no, debit_ifsc, narration, created_by) VALUES (?, ?, ?, ?, ?, ?)', [c.companyId, next.stateCode, next.debitAccountNo, next.debitIfsc, next.narration, c.userId]);
  await audit(db, c, 'hrms_pay_settings', row?.id ?? 0, row ? 'UPDATE' : 'CREATE', before, next, requestId);
  return { company: await companySettings(db, c.companyId) };
}

/* ══ self ════════════════════════════════════════════════════════════════ */

/** GET /user/me/pay — my salary today: CTC a year and a month, the components, the date. My own: no audit. */
export async function myPay(db, c, employeeId) {
  const employee = await employeeRow(db, c.companyId, employeeId);
  const rows = await salaryRows(db, c.companyId, employeeId);
  const t = today();
  const current = rows.filter((s) => s.effectiveFrom <= t && (!s.effectiveTo || s.effectiveTo >= t)).pop() ?? null;
  const upcoming = rows.find((s) => s.effectiveFrom > t) ?? null;
  const shape = async (s) => {
    if (!s) return null;
    const b = await salaryBreakdown(db, c, s);
    return {
      effectiveFrom: s.effectiveFrom, effectiveTo: s.effectiveTo, annualCtc: s.annualCtc, monthlyCtc: s.monthlyCtc, structureName: b.structure?.name ?? null, pfMode: s.pfMode,
      lines: (b.lines ?? []).map((l) => ({ code: l.code, name: l.name, kind: l.kind, frequency: l.frequency, monthly: l.monthly, annual: l.annual })),
      totals: b.totals ?? {},
      note: 'Employer PF in the breakdown is how the CTC is split. Each month’s PF, ESI, professional tax and TDS are worked out from that month’s pay, and are on the payslip.',
    };
  };
  return {
    employee: { name: employee.name, code: employee.code, joiningDate: employee.joiningDate },
    salary: await shape(current),
    upcoming: await shape(upcoming),
    history: [...rows].reverse().map((s) => ({ effectiveFrom: s.effectiveFrom, effectiveTo: s.effectiveTo, annualCtc: s.annualCtc, monthlyCtc: s.monthlyCtc, reason: s.reason })),
  };
}

export { invalid, FormulaError, parse };
