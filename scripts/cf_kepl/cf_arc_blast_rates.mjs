/**
 * RETIRED 2026-10-01 — superseded by cf_table_rates.mjs, which applies the whole
 * Master_Formulae table (arc 2.8 min/m and blasting 2.5 min/m² x 2 faces + 15
 * manual included). Do NOT run this one: its CLI refuses. run() is kept only so
 * arc_blast_rates_test.mjs (rolled back) keeps documenting what it did.
 *
 * cf_arc_blast_rates.mjs — gives CF_ERP's composite girder flows a time for ARC
 * WELDING and BLASTING (user decisions, 2026-10-01), then re-releases the KEPL
 * line so its production steps carry them. Earlier steps:
 * cf_operation_times.mjs (rules, formulas, specs) and cf_kepl_quantities.mjs
 * (the KEPL line's weld lengths etc.); findings in
 * TM/CF_ERP_OPERATION_TIMES_FINDINGS.md and TM/CF_ERP_KEPL_QUANTITIES.md.
 *
 * THE TWO RATES
 *   CG-ARCWELD (Arc welding type): the workbook's worked example taken as a
 *     flat rate — Process_Flow_v5 Master_Formulae worked example, 2.8 min per
 *     metre of weld (user OK 2026-10-01). work = item.ARC_WELD_LENGTH [m] x 2.8.
 *     The old formula CG_ARC_WELD_TIME (which needs machine.ARC_RATE, a chart
 *     nobody has) is KEPT; only the rule is repointed to CG_ARC_WELD_FLAT_TIME.
 *   CG-BLAST (blasting type): 2.5 min per m² (Master_Formulae R_blast) for the blast pass,
 *     both faces, plus 15 min manual blasting a piece. work =
 *     item.SURFACE_AREA [m²] x 2 x 2.5 + 15 (SURFACE_AREA is ONE face — see the
 *     findings §4). Formula CG_BLAST_TIME.
 *   Units are read off the specifications: a length held in mm is divided by
 *   1,000, an area held in mm² by 1,000,000. Any other unit stops the rule.
 *
 * --commit, in ONE transaction:
 *   1. write the formulas and repoint every eligible machine rule of the two
 *      operations (idempotent: a re-run changes nothing);
 *   2. if the line (auto-detected like the other cf_kepl scripts, or --line) is
 *      RELEASED and its arc / blast times differ from what the release carries,
 *      take the release back (refused before anything is written if a step has
 *      started or material was issued), and release again with the old
 *      finished area and notes; print hours per operation before / after and
 *      the new release's timed steps and hours. Nothing changed -> nothing done.
 *
 *   node scripts/cf_kepl/cf_arc_blast_rates.mjs [--line <id>]     # dry run (read-only transaction; TiDB stale read)
 *   node scripts/cf_kepl/cf_arc_blast_rates.mjs --commit
 *   CF_BRIDGE_COMPANY=30005 … for prod Placebo, TM/.env.tidb loaded by the caller (default company 2)
 */
import { pathToFileURL } from 'url';
import { pool } from '../../db.js';
import '../../apps/cf_erp/services/codegenProvider.js';
import { attachNodeCache, detachNodeCache } from '../../apps/cf_erp/lib/db.js';
import * as opsSvc from '../../apps/cf_erp/services/operationService.js';
import * as formulaSvc from '../../apps/cf_erp/services/formulaService.js';
import { effectiveByCode as effectiveMap } from '../../apps/cf_erp/services/resolutionService.js';
import { load, lineTimes, projectTimes, reRelease } from './cf_kepl_quantities.mjs';

/* ===========================================================================
 * The rates, as data and pure functions (the test calls them)
 * ======================================================================== */

export const ARC_MIN_PER_M = 2.8;
export const BLAST_MIN_PER_M2 = 2.5;
export const BLAST_FACES = 2;
export const BLAST_MANUAL_MIN = 15;
const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const unitOf = (u) => String(u ?? '').toLowerCase().replace(/\s+/g, '').replace('²', '2').replace('^2', '2');

/** `item.CODE` in metres, or null if the unit is not a length we know. */
export function metresOf(code, uom) {
  const u = unitOf(uom);
  if (['m', 'metre', 'meter', 'metres', 'meters'].includes(u)) return `item.${code}`;
  if (['mm', 'millimetre', 'millimeter'].includes(u)) return `item.${code} / 1000`;
  return null;
}

/** `item.CODE` in square metres, or null if the unit is not an area we know. */
export function squareMetresOf(code, uom) {
  const u = unitOf(uom);
  if (['m2', 'sqm', 'sq.m', 'sqmetre', 'sqmeter'].includes(u)) return `item.${code}`;
  if (['mm2', 'sqmm', 'sq.mm'].includes(u)) return `item.${code} / 1000000`;
  return null;
}

export const arcExpression = (uom) => { const m = metresOf('ARC_WELD_LENGTH', uom); return m ? `${m} * ${ARC_MIN_PER_M}` : null; };
export const blastExpression = (uom) => { const a = squareMetresOf('SURFACE_AREA', uom); return a ? `${a} * ${BLAST_FACES} * ${BLAST_MIN_PER_M2} + ${BLAST_MANUAL_MIN}` : null; };

export const RATES = [
  {
    op: 'CG-ARCWELD', input: 'ARC_WELD_LENGTH', kind: 'length', expression: arcExpression,
    formula: 'CG_ARC_WELD_FLAT_TIME', name: 'Arc welding time (flat 2.8 min/m)',
    description: 'Process_Flow_v5 Master_Formulae worked example, flat 2.8 min/m, user OK 2026-10-01. Minutes per piece = arc weld length (m) x 2.8. Replaces CG_ARC_WELD_TIME on the rule (that formula needs a machine ARC_RATE chart nobody has; it is kept).',
    notes: 'Process_Flow_v5 Master_Formulae worked example, flat 2.8 min/m, user OK 2026-10-01. work = ARC_WELD_LENGTH (m) x 2.8 min. Was CG_ARC_WELD_TIME (needs machine.ARC_RATE, no chart) — that formula is kept.',
  },
  {
    op: 'CG-BLAST', input: 'SURFACE_AREA', kind: 'area', expression: blastExpression,
    formula: 'CG_BLAST_TIME', name: 'Blasting time (2.5 min/m² both faces + 15 min manual)',
    description: 'User 2026-10-01: 2.5 min per m² (Master_Formulae R_blast) for the blast pass, both faces, plus 15 min manual blasting per piece. SURFACE_AREA is one face, so x 2. Minutes per piece.',
    notes: 'User decision 2026-10-01: 2.5 min per m² (Master_Formulae R_blast) for the blast pass, both faces (SURFACE_AREA is one face, x 2), plus 15 min manual blasting per piece. work = SURFACE_AREA (m²) x 2 x 2.5 + 15 min.',
  },
];

/* ===========================================================================
 * Read and plan (SELECTs only)
 * ======================================================================== */

async function loadSetup(db, companyId) {
  const q = (sql, p) => db.query(sql, p).then(([r]) => r);
  const opCodes = RATES.map((r) => r.op);
  const [ops, specs, formulas, rules] = await Promise.all([
    q('SELECT id, code, name FROM cf_operations WHERE company_id = ? AND deleted_at IS NULL AND code IN (?)', [companyId, opCodes]),
    q('SELECT id, code, default_uom, data_type FROM cf_specifications WHERE company_id = ? AND deleted_at IS NULL AND code IN (?)', [companyId, RATES.map((r) => r.input)]),
    q('SELECT id, code, expression, description FROM cf_formulas WHERE company_id = ? AND deleted_at IS NULL AND code IN (?)', [companyId, [...RATES.map((r) => r.formula), 'CG_ARC_WELD_TIME']]),
    q(`SELECT r.*, o.code AS op_code, wf.code AS work_code, wf.expression AS work_expr, n.name AS node_name, mc.code AS machine_code
         FROM cf_operation_machine_rules r JOIN cf_operations o ON o.id = r.operation_id
         LEFT JOIN cf_formulas wf ON wf.id = r.work_formula_id
         LEFT JOIN cf_classification_nodes n ON r.subject_type = 'classification' AND n.id = r.subject_id
         LEFT JOIN cf_machines mc ON r.subject_type = 'machine' AND mc.id = r.subject_id
        WHERE r.company_id = ? AND r.deleted_at IS NULL AND o.code IN (?) ORDER BY r.id`, [companyId, opCodes]),
  ]);
  return {
    ops: new Map(ops.map((o) => [o.code, o])), specs: new Map(specs.map((s) => [s.code, s])),
    formulas: new Map(formulas.map((f) => [f.code, f])), rules,
  };
}

/** Actions { area, what, before, after, status: change | same | blocked, run?, why? } + the expression per op. */
export function planRates(setup) {
  const A = [];
  const exprOf = new Map(); // op code -> { code, expression, setupMinutes }
  const fmtRule = (r) => (r.work_minutes != null ? `${Number(r.work_minutes)} min` : r.work_code ? `${r.work_code}: ${r.work_expr}` : 'no work time');
  for (const rate of RATES) {
    const op = setup.ops.get(rate.op);
    const spec = setup.specs.get(rate.input);
    if (!op) { A.push({ area: 'Machine rule', what: rate.op, before: 'operation missing', after: '(not changed)', status: 'blocked', why: 'run cf_plant_operations.mjs first' }); continue; }
    if (!spec) { A.push({ area: 'Formula', what: rate.formula, before: '—', after: '(not changed)', status: 'blocked', why: `no specification ${rate.input} — run cf_operation_times.mjs --commit first` }); continue; }
    const expression = rate.expression(spec.default_uom);
    if (!expression) { A.push({ area: 'Formula', what: rate.formula, before: '—', after: '(not changed)', status: 'blocked', why: `${rate.input} is held in "${spec.default_uom ?? '(no unit)'}" — not a ${rate.kind} unit this script converts` }); continue; }
    const f = setup.formulas.get(rate.formula);
    const unitNote = `${rate.input} in ${spec.default_uom}`;
    if (!f) A.push({ area: 'Formula', what: rate.formula, before: 'missing', after: `${expression}  [${unitNote}]`, status: 'change', run: async (x) => { await formulaSvc.createFormula(x.db, x.c, { code: rate.formula, name: rate.name, expression, description: rate.description }); } });
    else if (norm(f.expression) !== norm(expression) || norm(f.description) !== norm(rate.description)) A.push({ area: 'Formula', what: rate.formula, before: f.expression, after: `${expression}  [${unitNote}]`, status: 'change', run: async (x) => { await formulaSvc.updateFormula(x.db, x.c, f.id, { expression, description: rate.description }); } });
    else A.push({ area: 'Formula', what: rate.formula, before: f.expression, after: expression, status: 'same' });

    const rules = setup.rules.filter((r) => r.op_code === rate.op && r.eligible);
    if (!rules.length) { A.push({ area: 'Machine rule', what: rate.op, before: 'no eligible rule', after: '(not changed)', status: 'blocked', why: `no machine type is eligible for ${rate.op}` }); continue; }
    exprOf.set(rate.op, { code: rate.formula, expression, setupMinutes: rules[0].setup_minutes == null ? null : Number(rules[0].setup_minutes) });
    for (const r of rules) {
      const what = `${rate.op} on ${r.subject_type === 'machine' ? `machine ${r.machine_code}` : r.node_name}`;
      const same = r.work_code === rate.formula && r.work_minutes == null && norm(r.notes) === norm(rate.notes);
      if (same) { A.push({ area: 'Machine rule', what, before: fmtRule(r), after: rate.formula, status: 'same' }); continue; }
      A.push({
        area: 'Machine rule', what, before: fmtRule(r), after: `${rate.formula}${r.work_code === 'CG_ARC_WELD_TIME' ? ' (CG_ARC_WELD_TIME kept)' : ''}`, status: 'change',
        run: async (x) => {
          const [[fr]] = await x.db.query('SELECT id FROM cf_formulas WHERE company_id = ? AND code = ? AND deleted_at IS NULL', [x.c.companyId, rate.formula]);
          await opsSvc.updateTimingRule(x.db, x.c, r.id, { workFormulaId: fr.id, workMinutes: null, notes: rate.notes });
        },
      });
    }
  }
  return { actions: A, exprOf };
}

/** The line's release: minutes, timed and untimed steps per operation code. */
async function releaseByOp(db, companyId, releaseId) {
  if (!releaseId) return null;
  const [rows] = await db.query(
    `SELECT o.code, COUNT(*) AS steps, SUM(s.est_minutes IS NOT NULL) AS timed, COALESCE(SUM(s.est_minutes), 0) AS minutes
       FROM cf_production_steps s JOIN cf_production_items pi ON pi.id = s.production_item_id
       JOIN cf_operations o ON o.id = s.operation_id
      WHERE s.company_id = ? AND pi.release_id = ? AND s.deleted_at IS NULL GROUP BY o.code`, [companyId, releaseId]);
  return new Map(rows.map((r) => [r.code, { steps: Number(r.steps), timed: Number(r.timed ?? 0), minutes: Number(r.minutes) }]));
}

/** Piece-passes of an operation on the line, and how many get a time in the projection. */
function coverage(data, projected, opCode) {
  let total = 0;
  const passes = new Set();
  for (const n of data.nodes) {
    for (const o of data.flowOps.get(n.flow?.id)?.values() ?? []) {
      if (o.code !== opCode) continue;
      total += Number(n.total) * o.passes;
      passes.add(o.passes);
    }
  }
  const u = projected.untimed.get(opCode);
  return { total, untimed: u?.pieces ?? 0, timed: total - (u?.pieces ?? 0), reasons: u ? [...u.reasons] : [], passes: [...passes] };
}

/** Which untimed pieces (item names) an operation leaves, for the report. */
function untimedItems(data, estimateFor, opCode) {
  const out = new Map();
  for (const n of data.nodes) {
    const o = [...(data.flowOps.get(n.flow?.id)?.values() ?? [])].find((x) => x.code === opCode);
    if (!o) continue;
    const f = estimateFor(o, data.readerOf(n.id));
    if (f?.work != null) continue;
    const k = n.name;
    out.set(k, (out.get(k) ?? 0) + Number(n.total) * o.passes);
  }
  return out;
}

/* ===========================================================================
 * The entry point (the test calls it) and the CLI
 * ======================================================================== */

/**
 * opts: { lineId?, commit?, userId? }. Plans with SELECTs only; with commit,
 * applies in the CALLER's transaction: rules, then (only if the release's arc /
 * blast times differ) take back -> release again.
 */
export async function run(db, companyId, opts = {}) {
  const c = { companyId, userId: opts.userId ?? null };
  const setup = await loadSetup(db, companyId);
  const { actions, exprOf } = planRates(setup);
  const data = await load(db, companyId, opts.lineId ?? null);

  // The projection: the two operations evaluated with their NEW formulas, the rest as the database has them.
  const noMachine = opsSvc.valueReaders(new Map());
  const estimateFor = (o, readers) => {
    const e = exprOf.get(o.code);
    if (!e) return null;
    const r = opsSvc.evaluateRuleTimes({ work: { minutes: null, formula: { code: e.code, expression: e.expression } }, setup: e.setupMinutes != null ? { minutes: e.setupMinutes } : null }, { item: readers, machine: noMachine });
    const missing = r.work.minutes == null ? (r.work.missing?.length ? `Needs ${r.work.missing.join(', ')}.` : `The formula ${e.code} cannot be worked out: ${r.work.error ?? 'no result'}.`) : null;
    return { work: r.work.minutes == null ? null : Number(r.work.minutes.toFixed(3)), setup: r.setup.minutes == null ? null : Number(r.setup.minutes.toFixed(3)), missing };
  };
  const before = await lineTimes(db, companyId, data.line);
  const projected = await projectTimes(db, companyId, data, [], { estimateFor });
  const rel = data.release;
  const relOps = rel ? await releaseByOp(db, companyId, rel.id) : null;

  // Did the line's arc / blast times change against what the release carries?
  const diffs = [];
  if (rel) {
    for (const rate of RATES) {
      const pj = projected.byCode.get(rate.op);
      if (!pj) continue; // the line's flows do not run it
      const rm = relOps.get(rate.op);
      const relMin = rm?.minutes ?? 0;
      const relUntimed = rm ? rm.steps - rm.timed : 0;
      const pjUntimed = projected.untimed.get(rate.op)?.pieces ?? 0;
      if (Math.abs((pj.minutes ?? 0) - relMin) > 1 || (relUntimed > 0) !== (pjUntimed > 0)) diffs.push({ op: rate.op, release: relMin, projected: pj.minutes ?? 0 });
    }
  }
  const ruleChanges = actions.filter((a) => a.status === 'change');
  const stopped = rel && diffs.length && (rel.started || rel.issued > 1e-9)
    ? `Line ${data.line.line_no} of ${data.line.order_code} has started (${rel.started} step(s) begun${rel.issued > 1e-9 ? `, material issued: ${rel.issued}` : ''}) — release ${rel.id} cannot be taken back. Nothing was written.`
    : null;
  const coverageOf = Object.fromEntries(RATES.map((r) => [r.op, coverage(data, projected, r.op)]));
  data.readerOf = (itemId) => {
    const r = data.resolutions.get(itemId);
    return r ? opsSvc.valueReaders(effectiveMap(r)) : null;
  };
  const untimedBlast = untimedItems(data, estimateFor, 'CG-BLAST');
  const untimedArc = untimedItems(data, estimateFor, 'CG-ARCWELD');
  const out = { data, actions, ruleChanges, exprOf, before, projected, relOps, diffs, stopped, coverageOf, untimedBlast, untimedArc, applied: 0, tookBack: null, released: null, newRelOps: null, after: null };
  if (!opts.commit) return out;
  if (stopped) { const e = new Error(stopped); e.code = 'STARTED'; throw e; }
  if (!ruleChanges.length && !diffs.length) return out;

  // 1. Formulas and rules.
  for (const a of ruleChanges) {
    try { await a.run({ db, c }); } catch (e) { e.message = `${a.area} ${a.what}: ${e.message}${e.problems ? ` — ${JSON.stringify(e.problems)}` : ''}`; throw e; }
    out.applied += 1;
  }
  // 2. Take back -> release again, only when the release's times are stale.
  if (rel && diffs.length) {
    const rr = await reRelease(db, c, data, async () => {});
    out.tookBack = rr.tookBack;
    out.released = rr.released;
    out.newRelOps = await releaseByOp(db, companyId, rr.released.id);
  }
  out.after = await lineTimes(db, companyId, data.line);
  return out;
}


const pad = (s, n) => { const t = String(s ?? ''); return t.length > n ? `${t.slice(0, n - 1)}…` : t.padEnd(n); };
const h = (m) => (m == null ? '—' : (m / 60).toFixed(1));

export function printReport(out, { commit }) {
  const say = (...a) => console.log(...a);
  const { data, actions, before, projected, relOps, diffs, coverageOf, released, tookBack, newRelOps } = out;
  const L = data.line;
  const rel = data.release;
  say(`line ${L.id} (${L.order_code} line ${L.line_no}, x${Number(L.quantity)}) — ${rel ? `RELEASED (release ${rel.id}: ${rel.steps} steps, ${rel.timed} timed, ${h(rel.minutes)} h; started ${rel.started}, issued ${rel.issued}, active reservations ${rel.reservations})` : L.locked_at ? 'LOCKED, not released' : 'live'}`);

  say('\nRATES:');
  say(`  CG-ARCWELD  ${ARC_MIN_PER_M} min per metre of arc weld (Process_Flow_v5 Master_Formulae worked example, flat; user OK 2026-10-01)`);
  say(`  CG-BLAST    ${BLAST_MIN_PER_M2} min/m² x ${BLAST_FACES} faces (one blast pass) + ${BLAST_MANUAL_MIN} min manual a piece (user 2026-10-01)`);
  for (const [op, e] of out.exprOf) say(`  ${pad(op, 11)} work = ${e.expression}`);

  say(`\n${pad('Area', 13)} ${pad('What', 40)} ${pad('Before', 62)} ${pad('After', 58)} Status`);
  const order = { change: 0, blocked: 1, same: 2 };
  for (const a of [...actions].sort((x, y) => order[x.status] - order[y.status])) {
    say(`${pad(a.area, 13)} ${pad(a.what, 40)} ${pad(a.before, 62)} ${pad(a.after, 58)} ${a.status === 'change' ? (commit ? 'CHANGED' : 'would change') : a.status === 'blocked' ? 'BLOCKED' : 'already so'}`);
    if (a.status === 'blocked') say(`${' '.repeat(14)}why: ${a.why}`);
  }

  say('\nCOVERAGE on this line (piece-passes = pieces x passes of the operation in their flow):');
  for (const [op, cv] of Object.entries(coverageOf)) {
    say(`  ${pad(op, 11)} ${cv.total} piece-passes: ${cv.timed} get a time, ${cv.untimed} do not${cv.passes.length ? ` (passes per flow: ${cv.passes.join('/')})` : ''}${cv.reasons.length ? ` — ${cv.reasons.slice(0, 2).join(' | ')}` : ''}`);
    const list = op === 'CG-BLAST' ? out.untimedBlast : out.untimedArc;
    for (const [name, n] of [...list].sort((a, b) => b[1] - a[1]).slice(0, 8)) say(`      untimed: ${pad(name, 50)} ${n}`);
  }
  if ((coverageOf['CG-BLAST']?.passes ?? []).some((p) => p > 1)) say('  NOTE: a flow blasts more than once — every pass gets the full time; the user said one pass.');

  const codes = [...new Set([...before.byCode.keys(), ...projected.byCode.keys(), ...(relOps?.keys() ?? []), ...(newRelOps?.keys() ?? [])])].sort();
  say(`\nHOURS per operation, whole line — ${rel ? 'release now | ' : ''}Times grid now | projected${newRelOps ? ' | NEW release' : ''}:`);
  say(`  ${pad('Operation', 46)} ${rel ? pad('Rel. h', 9) : ''}${pad('Grid h', 9)} ${pad('Proj. h', 9)} ${newRelOps ? 'New rel. h' : ''}`);
  for (const code of codes) {
    const b = before.byCode.get(code);
    const pj = projected.byCode.get(code);
    const mark = RATES.some((r) => r.op === code) ? '*' : ' ';
    say(`${mark} ${pad(`${code} ${b?.name ?? pj?.name ?? ''}`, 46)} ${rel ? pad(relOps.get(code)?.timed ? h(relOps.get(code).minutes) : '—', 9) : ''}${pad(h(b?.minutes), 9)} ${pad(h(pj?.minutes), 9)} ${newRelOps ? (newRelOps.get(code)?.timed ? h(newRelOps.get(code).minutes) : '—') : ''}`);
  }
  const relAll = relOps ? [...relOps.values()].reduce((s, r) => s + r.minutes, 0) : null;
  const newAll = newRelOps ? [...newRelOps.values()].reduce((s, r) => s + r.minutes, 0) : null;
  say(`  ${pad('All', 46)} ${rel ? pad(h(relAll), 9) : ''}${pad(h(before.all), 9)} ${pad(h(projected.all), 9)} ${newRelOps ? h(newAll) : ''}`);
  say('  (* = the two operations this script times; release and grid differ by setup minutes, counted once a row in the grid and once a step on the release)');

  say('');
  const nBlocked = actions.filter((a) => a.status === 'blocked').length;
  if (nBlocked) say(`${nBlocked} BLOCKED (see "why" above) — those rates are not set by this run.`);
  if (out.stopped) say(`STOP: ${out.stopped}`);
  else if (!out.ruleChanges.length && !diffs.length) say('Nothing to change: the rules are already so and the release carries these times.');
  else if (!commit) {
    say(`--commit would: ${out.ruleChanges.length ? `write ${out.ruleChanges.length} formula/rule change(s)` : 'change no rule'}${rel ? (diffs.length ? `; take back release ${rel.id} (allowed: nothing started, nothing issued${rel.reservations ? `; ${rel.reservations} active reservation(s) would be let go — reserve again after` : ''}) and release again into finished area ${rel.finishedAreaId} — ${diffs.map((d) => `${d.op} ${h(d.release)} h -> ${h(d.projected)} h`).join(', ')}` : '; leave the release alone (it already carries these times)') : '; the line is not released, nothing to re-release'}.`);
  }
  if (commit && (out.ruleChanges.length || diffs.length)) {
    say(`Wrote ${out.applied} formula/rule change(s).`);
    if (tookBack) say(`Took back release ${tookBack.id} (${tookBack.steps} steps, ${tookBack.timed} timed, ${h(tookBack.minutes)} h${tookBack.reservations ? `; ${tookBack.reservations} reservation(s) let go — reserve again` : ''}).`);
    if (released) say(`Released again: release ${released.id} — ${released.steps} steps, ${released.timed} timed, ${h(released.minutes)} h (was ${tookBack ? `${tookBack.timed} timed, ${h(tookBack.minutes)} h` : '—'}).`);
    else if (rel) say(`Release ${rel.id} left alone (its arc / blast times already match).`);
  }
}

async function main() {
  console.error('cf_arc_blast_rates.mjs is RETIRED (2026-10-01): run scripts/cf_kepl/cf_table_rates.mjs instead — it applies these two rates and the rest of the Master_Formulae table.');
  process.exitCode = 1;
  await pool.end();
  return;
  const argv = process.argv.slice(2);
  const COMMIT = argv.includes('--commit');
  const li = argv.indexOf('--line');
  const LINE = li >= 0 ? Number(argv[li + 1]) : null;
  const COMPANY = Number(process.env.CF_BRIDGE_COMPANY ?? 2);
  const USER = process.env.CF_BRIDGE_USER ? Number(process.env.CF_BRIDGE_USER) : null;
  const where = /^(localhost|127\.0\.0\.1|::1)?$/i.test(process.env.DB_HOST ?? '') ? 'local' : 'PRODUCTION';
  console.log(`${where}, company ${COMPANY} — ${COMMIT ? 'WRITING (rules -> take back -> release again if times changed, one transaction)' : 'dry run (SELECTs only, read-only transaction)'}`);
  const conn = await pool.getConnection();
  let trips = 0;
  const db = new Proxy(conn, { get: (t, k) => (k === 'query' ? (...a) => { trips += 1; return t.query(...a); } : Reflect.get(t, k)) });
  const t0 = Date.now();
  try {
    if (COMMIT) await conn.beginTransaction();
    else {
      const [[{ v }]] = await conn.query('SELECT VERSION() AS v');
      // TiDB's READ ONLY is a no-op; a stale read is genuinely read-only (it refuses writes).
      await conn.query(/tidb/i.test(v) ? 'START TRANSACTION READ ONLY AS OF TIMESTAMP NOW() - INTERVAL 1 SECOND' : 'START TRANSACTION READ ONLY');
    }
    attachNodeCache(db);
    const out = await run(db, COMPANY, { lineId: LINE, commit: COMMIT, userId: USER });
    printReport(out, { commit: COMMIT });
    detachNodeCache(db);
    if (COMMIT) { await conn.commit(); console.log(out.ruleChanges.length || out.diffs.length ? '\nCommitted.' : '\nNothing to commit.'); } else await conn.query('ROLLBACK');
    console.log(`round trips: ${trips}, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  } catch (e) {
    try { await conn.query('ROLLBACK'); } catch { /* keep the first error */ }
    console.error(`\nFAILED, rolled back — nothing was written: ${e.code ?? ''} ${e.message}${e.problems ? ` ${JSON.stringify(e.problems)}` : ''}`);
    process.exitCode = 1;
  } finally {
    conn.release();
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
