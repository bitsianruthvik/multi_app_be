/**
 * cf_operation_times.mjs — gives the Composite girder span flows their operation
 * times, from the plant's workbook (Process_Flow_v5.xlsx, sheets Master_Formulae
 * and Sample_Calculations) and the user's decisions of 2026-10-01. Findings it
 * acts on: TM/CF_ERP_OPERATION_TIMES_FINDINGS.md.
 *
 * USER DECISIONS
 *   - A workbook "day" is 24 HOURS: "We have multiple shifts in the factory
 *     running all day long." Where the workbook says "1 shift" it says 12 h.
 *   - Quantities that come from the drawings (weld lengths and sizes, hole
 *     counts, stiffener and stud counts, coats) are NOT decided. Nothing here
 *     invents one: their fields are made assignable and left empty.
 *
 * WHAT IT SETS (each row prints Before -> After; a re-run changes nothing)
 *   1. Jack bend removal: a rule on the "Hydraulic jack" machine type (found by
 *      NAME). "1 shift (12 hours) = 24 m of girder length" -> 30 min a metre ->
 *      work = item.LENGTH * 30 / 1000 min per girder segment (the piece whose
 *      flow, CG-GIRDERASM, carries the operation; LENGTH is assignable there).
 *   2. Line matching: "2 joints = 1 day" (the sheet: "Need to confirm") -> 720
 *      min a joint. The operation sits on each SEGMENT, so a segment carries
 *      (joints per girder line / segments per line) x 720, joints = segments - 1,
 *      counted in the line's own structure (KEPL: 4/5 x 720 = 576). A constant:
 *      a timing formula reads only the item's own values (item.X / machine.X),
 *      never its girder line's segment count.
 *   3. Trial assembly: composite girder 6.5 days at 36 m, x span/36, x1.2 above
 *      36 m (x0.8 below), day = 1,440 min. The operation sits on every piece,
 *      not on the span, so the span's time is spread by weight: work =
 *      item.WEIGHT x rate, rate = T / span weight. Not a formula on span length:
 *      a splice plate cannot see SPAN_LENGTH (only assemblies inherit it), no
 *      piece can see the span's weight, and the KEPL span holds no SPAN_LENGTH —
 *      so the rate is worked out here (SPAN_LENGTH if the span has one, else
 *      59,300 mm from the BOQ) and printed. Dismantling = half of it.
 *   4. Girder segment LENGTH (H-beam fit-up and jack bend read item.LENGTH).
 *      All segments come from ONE definition but are 11,650 or 12,000 mm long,
 *      and LENGTH's rule is "entered" (a definition value never reaches an item
 *      under an entered rule) — so the value belongs on each segment ITEM: its
 *      web's LENGTH (else its longest plate's).
 *   5. Cut plates: CUT_LENGTH calculated = 2 x (LENGTH + WIDTH), the outer
 *      perimeter, and PIERCINGS defaulted to 1 a blank, both on the Cut plate
 *      classification — every new order's blanks get them by themselves, and a
 *      blank with holes can still be given more piercings.
 *   6. Traps:
 *      a. One WELD_LENGTH / WELD_SIZE was read by SAW, ARC and MIG — a diaphragm
 *         would count its weld three times. Each process now reads its own
 *         SAW_ / ARC_ / MIG_WELD_LENGTH and _SIZE; COATS splits into
 *         METALLISE_COATS and PAINT_COATS. Fields made, values left empty.
 *      b. An operation listed twice in one flow got its full time on every
 *         pass. The workbook lists each pass as its own job (hole transfer, top
 *         holes, bottom holes; stiffener fit-up and MIG before and after the
 *         flip; match drilling, then drilling, on an inner splice), so each
 *         later pass becomes ITS OWN OPERATION reading its own quantity. Cleaner
 *         than a per-pass fraction, which the formula language cannot express:
 *         a formula does not know its flow or pass, and MANDRILL runs 3x on a
 *         girder but 2x on an inner splice. A step already released cannot
 *         change operation (flowService refuses) — reported: take the release
 *         back, re-run, release again.
 *      c. SURFACE_AREA counts ONE face (LENGTH x WIDTH on a part, summed on an
 *         assembly). Metallising and painting cover both faces, so their
 *         formulas read item.SURFACE_AREA * 2 (edges ignored — about 2 % on these
 *         plates). Blasting has no formula yet (the sheet calls it undefined).
 *      d. Every quantity a flow's formulas read is made assignable on what the
 *         flow makes (e.g. HOLES on a girder segment, METALLISE_COATS on the
 *         metallised splice plates) — so the drawing quantities have a field.
 *   7. Shifts (report always; writes only with --shifts): the production
 *      machines (types that carry a timing rule) and their shifts, and what
 *      round-the-clock work would add. Pattern: an existing ~24 h machine's, if
 *      any; else 2 x 12 h (the workbook's own shift) on the days the machine
 *      already works. The house Day shift is stretched, not deleted, so day-offs
 *      that name it survive; a machine with other shifts is left alone.
 *
 * LOCKED LINES. A locked line's items are frozen: they show only the values
 * they hold, and valueService refuses new ones (records.assertNotFrozen). The
 * KEPL line is locked (prod: also released). Parts 4 and 5 cannot reach its
 * items the normal way — the script says so, and writes them onto the locked
 * line's items only with --locked-line-values (valueService.upsertValues, with
 * history; an exception the user must OK). A RELEASED line still keeps the
 * times release copied (est_minutes) until the release is taken back and
 * released again.
 *
 *   node scripts/cf_kepl/cf_operation_times.mjs [--line <order line id>]       # dry run: SELECTs only, read-only transaction
 *   node scripts/cf_kepl/cf_operation_times.mjs --commit                       # rules, formulas, specs, flows (+ values on a live line)
 *   node scripts/cf_kepl/cf_operation_times.mjs --commit --locked-line-values  # + values on a locked line's items
 *   node scripts/cf_kepl/cf_operation_times.mjs --shifts                       # round-the-clock shifts only
 *   CF_BRIDGE_COMPANY=30005 … for prod Placebo, with TM/.env.tidb loaded by the caller (default company 2)
 */
import { pathToFileURL } from 'url';
import { pool } from '../../db.js';
import '../../apps/cf_erp/services/codegenProvider.js';
import { attachNodeCache, detachNodeCache } from '../../apps/cf_erp/lib/db.js';
import { parseFormula } from '../../apps/cf_erp/services/formulaEngine.js';
import * as opsSvc from '../../apps/cf_erp/services/operationService.js';
import * as flowSvc from '../../apps/cf_erp/services/flowService.js';
import * as specSvc from '../../apps/cf_erp/services/specificationService.js';
import * as ruleSvc from '../../apps/cf_erp/services/assignmentService.js';
import * as formulaSvc from '../../apps/cf_erp/services/formulaService.js';
import * as valueSvc from '../../apps/cf_erp/services/valueService.js';
import * as shiftSvc from '../../apps/cf_erp/services/shiftService.js';
import { getLineTimes } from '../../apps/cf_erp/services/timeEstimateService.js';

/* ===========================================================================
 * The numbers, and where each came from
 * ======================================================================== */

export const DAY_MIN = 1440;               // user 2026-10-01: a workbook day is 24 h
const SHIFT_MIN = 720;                     // the workbook's "1 shift (12 hours)"
const JACK_MM_PER_SHIFT = 24000;           // Sample_Calculations: 1 shift = 24 m of girder length
const JOINTS_PER_DAY = 2;                  // Sample_Calculations: "2 joints = 1 day" (need to confirm)
const TRIAL_DAYS_36 = 6.5;                 // Sample_Calculations: composite girder + ROB at 36 m
const TRIAL_REF_MM = 36000;
const DEFAULT_SPAN_MM = Number(process.env.CF_SPAN_LENGTH_MM ?? 59300); // KEPL BOQ: ROB 59.3 m
const sig6 = (x) => Number(Number(x).toPrecision(6));
export const trialFactor = (spanMm) => (spanMm > TRIAL_REF_MM ? 1.2 : spanMm < TRIAL_REF_MM ? 0.8 : 1);
const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/**
 * Every code and name the script looks up or creates goes through these — the
 * test runs the same plan against its own fixture with a tagged prefix.
 */
function namesOf(prefix = '') {
  const t = (c) => `${prefix}${c}`;
  return { op: t, spec: t, formula: t, cls: t, flow: t, type: t };
}

/** The passes that become operations of their own (workbook CG_Master_Stores S.No in brackets). */
export function passPlan(p) {
  const drill = (spec) => `item.${p.spec(spec)} * machine.${p.spec('MANUAL_DRILL_TIME')}`;
  return [
    {
      flow: p.flow('CG-GIRDERASM'), op: p.op('CG-MANDRILL'), passes: [
        { stepName: 'Hole transfer (S9)' },
        { stepName: 'Holes drilling on girder - top (S20)', op: p.op('CG-MANDRILL-TOP'), name: 'Manual drilling - girder top holes', formula: p.formula('CG_MANUAL_DRILL_TOP_TIME'), expr: drill('HOLES_TOP'), newSpec: { code: p.spec('HOLES_TOP'), like: p.spec('HOLES'), name: 'Holes - girder top' } },
        { stepName: 'Holes drilling on girder - bottom (S21)', op: p.op('CG-MANDRILL-BOTTOM'), name: 'Manual drilling - girder bottom holes', formula: p.formula('CG_MANUAL_DRILL_BOTTOM_TIME'), expr: drill('HOLES_BOTTOM'), newSpec: { code: p.spec('HOLES_BOTTOM'), like: p.spec('HOLES'), name: 'Holes - girder bottom' } },
      ],
    },
    {
      flow: p.flow('CG-GIRDERASM'), op: p.op('CG-STIFFFIT'), passes: [
        { stepName: 'Stiffener fit-up before the flip (S10)' },
        { stepName: 'Stiffener fit-up after the flip (S18)', op: p.op('CG-STIFFFIT-2'), name: 'Stiffener fit-up after the flip', formula: p.formula('CG_STIFFENER_FITUP_2_TIME'), expr: `item.${p.spec('STIFFENERS_AFTER_FLIP')} * 20`, newSpec: { code: p.spec('STIFFENERS_AFTER_FLIP'), like: p.spec('STIFFENERS'), name: 'Stiffeners fitted after the flip' } },
      ],
    },
    {
      flow: p.flow('CG-GIRDERASM'), op: p.op('CG-MIGWELD'), passes: [
        { stepName: 'MIG welding before the flip (S11)' },
        { stepName: 'MIG welding after the flip (S19)', op: p.op('CG-MIGWELD-2'), name: 'MIG welding after the flip', formula: p.formula('CG_MIG_WELD_2_TIME'), expr: `item.${p.spec('MIG_WELD_LENGTH_AFTER_FLIP')} * LOOKUP(machine.${p.spec('MIG_RATE')}, item.${p.spec('MIG_WELD_SIZE')})`, newSpec: { code: p.spec('MIG_WELD_LENGTH_AFTER_FLIP'), like: p.spec('WELD_LENGTH'), name: 'MIG weld length after the flip' } },
      ],
    },
    {
      flow: p.flow('CG-INNERSPLICE'), op: p.op('CG-MANDRILL'), passes: [
        { stepName: 'Match drilling of outer splice on inner splice (S23)' },
        { stepName: 'Manual drilling on inner splice (S24)', op: p.op('CG-MANDRILL-INNER'), name: 'Manual drilling on inner splice', formula: p.formula('CG_MANUAL_DRILL_INNER_TIME'), expr: drill('HOLES_INNER'), newSpec: { code: p.spec('HOLES_INNER'), like: p.spec('HOLES'), name: 'Holes - inner splice, own drilling' } },
      ],
    },
  ];
}

/** Formulas rewritten: the old form (as cf_plant_operations wrote it) -> the new. */
export function formulaRewrites(p) {
  const i = (c) => `item.${p.spec(c)}`;
  const m = (c) => `machine.${p.spec(c)}`;
  return [
    { code: p.formula('CG_SAW_WELD_TIME'), why: 'own weld (trap a)', from: `${i('WELD_LENGTH')} * LOOKUP(${m('SAW_RATE')}, ${i('WELD_SIZE')})`, to: `${i('SAW_WELD_LENGTH')} * LOOKUP(${m('SAW_RATE')}, ${i('SAW_WELD_SIZE')})` },
    { code: p.formula('CG_ARC_WELD_TIME'), why: 'own weld (trap a)', from: `${i('WELD_LENGTH')} * LOOKUP(${m('ARC_RATE')}, ${i('WELD_SIZE')})`, to: `${i('ARC_WELD_LENGTH')} * LOOKUP(${m('ARC_RATE')}, ${i('ARC_WELD_SIZE')})` },
    { code: p.formula('CG_MIG_WELD_TIME'), why: 'own weld (trap a)', from: `${i('WELD_LENGTH')} * LOOKUP(${m('MIG_RATE')}, ${i('WELD_SIZE')})`, to: `${i('MIG_WELD_LENGTH')} * LOOKUP(${m('MIG_RATE')}, ${i('MIG_WELD_SIZE')})` },
    { code: p.formula('CG_METALLIZE_TIME'), why: 'own coats (a), both faces (c)', from: `${i('SURFACE_AREA')} * ${m('METAL_RATE')} * ${i('COATS')}`, to: `${i('SURFACE_AREA')} * 2 * ${m('METAL_RATE')} * ${i('METALLISE_COATS')}` },
    { code: p.formula('CG_PAINT_TIME'), why: 'own coats (a), both faces (c)', from: `${i('SURFACE_AREA')} * ${m('PAINT_RATE')} * ${i('COATS')}`, to: `${i('SURFACE_AREA')} * 2 * ${m('PAINT_RATE')} * ${i('PAINT_COATS')}` },
  ];
}

/** New per-process specifications, each copying an old one's type and unit, and its rules. */
export function splitSpecs(p) {
  return [
    { code: p.spec('SAW_WELD_LENGTH'), like: p.spec('WELD_LENGTH'), name: 'SAW weld length' },
    { code: p.spec('SAW_WELD_SIZE'), like: p.spec('WELD_SIZE'), name: 'SAW weld size' },
    { code: p.spec('ARC_WELD_LENGTH'), like: p.spec('WELD_LENGTH'), name: 'Arc weld length' },
    { code: p.spec('ARC_WELD_SIZE'), like: p.spec('WELD_SIZE'), name: 'Arc weld size' },
    { code: p.spec('MIG_WELD_LENGTH'), like: p.spec('WELD_LENGTH'), name: 'MIG weld length' },
    { code: p.spec('MIG_WELD_SIZE'), like: p.spec('WELD_SIZE'), name: 'MIG weld size' },
    { code: p.spec('METALLISE_COATS'), like: p.spec('COATS'), name: 'Metallising coats' },
    { code: p.spec('PAINT_COATS'), like: p.spec('COATS'), name: 'Paint coats' },
  ];
}

/* ===========================================================================
 * Read (SELECTs only)
 * ======================================================================== */

/**
 * The setup tables whole (operations, specifications, formulas, rules,
 * classification, flows — small, and the "every input assignable" check needs
 * all of them), then the line's own items, BOM and values. 17 reads in three
 * parallel stages, whatever the size.
 */
async function load(db, companyId, p, { lineId }) {
  const q = (sql, params) => db.query(sql, params).then(([rows]) => rows);
  const [ops, specs, formulas, nodes, flowSteps, machines, rules, assignments, classValues, flowUsers, liveRuleSubjects, candidateLines] = await Promise.all([
    q('SELECT id, code, name, status FROM cf_operations WHERE company_id = ? AND deleted_at IS NULL', [companyId]),
    q('SELECT * FROM cf_specifications WHERE company_id = ? AND deleted_at IS NULL', [companyId]),
    q('SELECT id, code, name, expression, status, description FROM cf_formulas WHERE company_id = ? AND deleted_at IS NULL', [companyId]),
    q('SELECT id, code, name, depth, parent_id, scope, status FROM cf_classification_nodes WHERE company_id = ? AND deleted_at IS NULL', [companyId]),
    q(`SELECT s.id, s.flow_id, f.code AS flow_code, f.status AS flow_status, s.sequence, s.operation_id, s.step_name
         FROM cf_operation_flow_steps s JOIN cf_operation_flows f ON f.company_id = s.company_id AND f.id = s.flow_id AND f.deleted_at IS NULL
        WHERE s.company_id = ? AND s.deleted_at IS NULL AND f.status <> 'obsolete' ORDER BY s.flow_id, s.sequence, s.id`, [companyId]),
    q("SELECT id, code, name, classification_id FROM cf_machines WHERE company_id = ? AND deleted_at IS NULL AND status = 'active' ORDER BY code", [companyId]),
    q(`SELECT r.*, fw.code AS work_code, fw.expression AS work_expr FROM cf_operation_machine_rules r
         LEFT JOIN cf_formulas fw ON fw.company_id = r.company_id AND fw.id = r.work_formula_id
        WHERE r.company_id = ? AND r.deleted_at IS NULL ORDER BY r.id`, [companyId]),
    q(`SELECT a.*, s.code AS spec_code FROM cf_spec_assignments a JOIN cf_specifications s ON s.id = a.specification_id
        WHERE a.company_id = ? AND a.deleted_at IS NULL AND a.capture_at = 'item'`, [companyId]),
    q("SELECT subject_id, specification_id, value_number FROM cf_spec_values WHERE company_id = ? AND subject_type = 'classification' AND deleted_at IS NULL", [companyId]),
    // Who each flow makes: records that have it as their own flow, and BOM-line overrides.
    q(`SELECT DISTINCT m.default_flow_id AS flow_id, m.classification_id, m.id AS master_id FROM cf_master_records m
        WHERE m.company_id = ? AND m.deleted_at IS NULL AND m.default_flow_id IS NOT NULL
        UNION SELECT DISTINCT bl.operation_flow_id, m.classification_id, m.id FROM cf_bom_lines bl
          JOIN cf_master_records m ON m.company_id = bl.company_id AND m.id = bl.child_id AND m.deleted_at IS NULL
        WHERE bl.company_id = ? AND bl.deleted_at IS NULL AND bl.operation_flow_id IS NOT NULL`, [companyId, companyId]),
    q(`SELECT DISTINCT r.subject_type, r.subject_id FROM cf_operation_machine_rules r
         JOIN cf_operations o ON o.company_id = r.company_id AND o.id = r.operation_id AND o.deleted_at IS NULL AND o.status = 'active'
        WHERE r.company_id = ? AND r.deleted_at IS NULL AND r.eligible = 1`, [companyId]),
    // Lines that sell a bridge span — the line the numbers are read from.
    q(`SELECT ol.id, ol.order_id, ol.line_no, ol.item_id, ol.quantity, ol.locked_at, o.code AS order_code, o.status AS order_status,
              (SELECT r.id FROM cf_production_releases r WHERE r.company_id = ol.company_id AND r.order_line_id = ol.id AND r.deleted_at IS NULL LIMIT 1) AS release_id
         FROM cf_sales_order_lines ol
         JOIN cf_sales_orders o ON o.company_id = ol.company_id AND o.id = ol.order_id AND o.deleted_at IS NULL
         JOIN cf_master_records m ON m.company_id = ol.company_id AND m.id = ol.item_id
         JOIN cf_classification_nodes n ON n.id = m.classification_id AND n.code = ?
        WHERE ol.company_id = ? AND ol.deleted_at IS NULL ${lineId ? 'AND ol.id = ?' : ''} ORDER BY ol.id`,
    lineId ? [p.cls('BRIDGE_SPAN'), companyId, lineId] : [p.cls('BRIDGE_SPAN'), companyId]),
  ]);

  // The line: given, or the only live one in the company that sells a span.
  const live = candidateLines.filter((l) => !['closed', 'lost', 'cancelled', 'revised'].includes(l.order_status));
  const line = lineId ? candidateLines[0] ?? null : live.length === 1 ? live[0] : null;
  const stepIds = flowSteps.map((s) => s.id);
  const [items, releasedSteps, allShifts] = await Promise.all([
    line ? q(`SELECT m.id, m.name, m.classification_id, n.code AS cls FROM cf_item_details i
        JOIN cf_master_records m ON m.company_id = i.company_id AND m.id = i.master_id AND m.deleted_at IS NULL
        JOIN cf_classification_nodes n ON n.id = m.classification_id
       WHERE i.company_id = ? AND i.owner_order_line_id = ? AND i.deleted_at IS NULL`, [companyId, line.id]) : [],
    stepIds.length ? q('SELECT flow_step_id, COUNT(*) AS n FROM cf_production_steps WHERE company_id = ? AND deleted_at IS NULL AND flow_step_id IN (?) GROUP BY flow_step_id', [companyId, stepIds]) : [],
    q('SELECT * FROM cf_machine_shifts WHERE company_id = ? AND deleted_at IS NULL ORDER BY machine_id, sort_order, start_time, id', [companyId]),
  ]);
  const ids = items.map((i) => i.id);
  const [bom, values] = ids.length ? await Promise.all([
    q(`SELECT b.parent_id, bl.child_id, bl.quantity FROM cf_bom_lines bl JOIN cf_boms b ON b.company_id = bl.company_id AND b.id = bl.bom_id AND b.deleted_at IS NULL
        WHERE bl.company_id = ? AND bl.deleted_at IS NULL AND b.parent_id IN (?)`, [companyId, ids]),
    q("SELECT subject_id, specification_id, value_number, source FROM cf_spec_values WHERE company_id = ? AND subject_type = 'master' AND deleted_at IS NULL AND subject_id IN (?)", [companyId, ids]),
  ]) : [[], []];

  // Production machines: under a machine type (or named by a rule) that an active operation's rule makes eligible.
  const nodesById = new Map(nodes.map((n) => [n.id, n]));
  const ruleNodes = new Set(liveRuleSubjects.filter((s) => s.subject_type === 'classification').map((s) => Number(s.subject_id)));
  const ruleMachines = new Set(liveRuleSubjects.filter((s) => s.subject_type === 'machine').map((s) => Number(s.subject_id)));
  const underRule = (nodeId) => {
    for (let n = nodesById.get(nodeId), hop = 0; n && hop < 8; n = nodesById.get(n.parent_id), hop++) if (ruleNodes.has(n.id)) return true;
    return false;
  };
  const productionMachines = machines.filter((m) => underRule(m.classification_id) || ruleMachines.has(m.id));

  return {
    ops: new Map(ops.map((o) => [o.code, o])), opsById: new Map(ops.map((o) => [o.id, o])),
    specs: new Map(specs.map((s) => [s.code, s])),
    formulas: new Map(formulas.map((f) => [f.code, f])), formulasById: new Map(formulas.map((f) => [f.id, f])),
    nodes, nodesById, flowSteps, rules, assignments, classValues,
    released: new Map(releasedSteps.map((r) => [r.flow_step_id, Number(r.n)])),
    flowUsers, machines, productionMachines, allShifts, candidateLines, line, items, bom, values,
  };
}

/* ===========================================================================
 * Plan: what differs from what the workbook and the user say
 * ======================================================================== */

/** The actions: { area, what, before, after, status: 'change' | 'blocked' | 'same', run? , why? } */
async function plan(companyId, p, data, opts) {
  const A = [];
  const notes = [];
  const add = (area, what, before, after, run) => A.push({ area, what, before: before ?? '—', after: after ?? '—', status: run ? 'change' : 'same', run });
  const blocked = (area, what, before, why) => A.push({ area, what, before: before ?? '—', after: '(not changed)', status: 'blocked', why });

  const specId = (code) => data.specs.get(code)?.id;
  const fmtRule = (r) => (!r ? 'no rule' : r.work_minutes != null ? `${Number(r.work_minutes)} min` : r.work_code ? `${r.work_code}: ${r.work_expr}` : 'no work time');
  const planned = { specs: new Map(), formulaExpr: new Map(), ops: new Set(), rules: [], opFormula: new Map(), stepOp: new Map() };

  // --- idempotent planners for one thing each -----------------------------------------------------
  const lookupId = async (x, table, code) => {
    const [[r]] = await x.db.query(`SELECT id FROM ${table} WHERE company_id = ? AND code = ? AND deleted_at IS NULL`, [companyId, code]);
    if (!r) throw new Error(`${table} ${code} is missing at apply time`);
    return r.id;
  };
  const ensureFormula = (code, name, expression, description) => {
    planned.formulaExpr.set(code, expression);
    const f = data.formulas.get(code);
    if (!f) add('Formula', code, 'missing', expression, async (x) => { await formulaSvc.createFormula(x.db, x.c, { code, name, expression, description }); });
    else if (norm(f.expression) !== norm(expression)) add('Formula', code, f.expression, expression, async (x) => { await formulaSvc.updateFormula(x.db, x.c, f.id, { expression, description }); });
    else add('Formula', code, f.expression, expression, null);
  };
  /** A machine rule: want = { workMinutes } | { workFormula: code }, plus notes. */
  const ensureTimingRule = (opCode, rule, subject, want, label) => {
    if (want.workFormula) planned.opFormula.set(opCode, want.workFormula);
    const what = `${opCode} on ${subject.name}`;
    const fNow = rule?.work_code ?? null;
    const mNow = rule?.work_minutes == null ? null : Number(rule.work_minutes);
    const same = rule && norm(rule.notes) === norm(want.notes)
      && (want.workFormula ? fNow === want.workFormula && mNow == null : mNow === want.workMinutes && !fNow);
    const after = `${want.workFormula ?? `${want.workMinutes} min`}${label ? ` (${label})` : ''}`;
    if (same) return add('Machine rule', what, fmtRule(rule), after, null);
    add('Machine rule', what, fmtRule(rule), after, async (x) => {
      const body = want.workFormula
        ? { workFormulaId: await lookupId(x, 'cf_formulas', want.workFormula), workMinutes: null, notes: want.notes }
        : { workMinutes: want.workMinutes, workFormulaId: null, notes: want.notes };
      if (rule) await opsSvc.updateTimingRule(x.db, x.c, rule.id, body);
      else await opsSvc.createTimingRule(x.db, x.c, data.ops.get(opCode)?.id ?? await lookupId(x, 'cf_operations', opCode), { subjectType: subject.type, subjectId: subject.id, eligible: true, ...body });
    });
  };
  const rulesOf = (opCode) => { const op = data.ops.get(opCode); return op ? data.rules.filter((r) => r.operation_id === op.id) : []; };
  const subjectOf = (r) => (r.subject_type === 'classification'
    ? { type: 'classification', id: r.subject_id, name: data.nodesById.get(r.subject_id)?.name ?? `type ${r.subject_id}` }
    : { type: 'machine', id: r.subject_id, name: data.machines.find((m) => m.id === r.subject_id)?.code ?? `machine ${r.subject_id}` });
  const ensureSpec = (code, likeCode, name, fallback = null) => {
    if (data.specs.has(code)) return add('Specification', code, 'exists', 'exists', null);
    if (planned.specs.has(code)) return null;
    const model = data.specs.get(likeCode) ?? planned.specs.get(likeCode) ?? fallback;
    if (!model) return blocked('Specification', code, 'missing', `${likeCode} (its model) does not exist`);
    planned.specs.set(code, { ...model, code, name });
    return add('Specification', code, 'missing', `${name} (${model.data_type}${model.default_uom ? `, ${model.default_uom}` : ''})`, async (x) => {
      await specSvc.createSpec(x.db, x.c, {
        code, name, dataType: model.data_type, defaultUom: model.default_uom ?? null, measurementType: model.measurement_type ?? null,
        ...(model.data_type === 'number' && model.decimals != null ? { decimals: model.decimals } : {}),
        description: `Made from ${likeCode} by cf_operation_times.mjs (2026-10-01) so each operation reads its own quantity. From the drawings — not decided yet.`,
      });
    });
  };
  const ruleExists = (specCode, subjectType, subjectId) => data.assignments.some((a) => a.spec_code === specCode && a.subject_type === subjectType && Number(a.subject_id) === Number(subjectId) && a.is_applicable)
    || planned.rules.some((r) => r.specCode === specCode && r.subjectType === subjectType && Number(r.subjectId) === Number(subjectId));
  const ensureSpecRule = (specCode, subjectType, subjectId, subjectName, body, why) => {
    if (!data.specs.has(specCode) && !planned.specs.has(specCode)) return blocked('Spec rule', `${specCode} on ${subjectName}`, 'none', `specification ${specCode} does not exist and cannot be made`);
    const existing = data.assignments.find((a) => a.spec_code === specCode && a.subject_type === subjectType && Number(a.subject_id) === Number(subjectId));
    const after = `${body.valueRule}${body.formula ? ` = ${body.formula}` : ''}${why ? ` (${why})` : ''}`;
    const what = `${specCode} on ${subjectName}`;
    if (existing) {
      const fNow = existing.formula_id ? data.formulasById.get(existing.formula_id)?.code ?? `formula ${existing.formula_id}` : null;
      const before = `${existing.is_applicable ? existing.value_rule : 'switched off'}${fNow ? ` = ${fNow}` : ''}`;
      if (existing.is_applicable && existing.value_rule === body.valueRule && (fNow ?? null) === (body.formula ?? null)) return add('Spec rule', what, before, after, null);
      return add('Spec rule', what, before, after, async (x) => {
        await ruleSvc.updateRule(x.db, x.c, existing.id, { valueRule: body.valueRule, isApplicable: true, formulaId: body.formula ? await lookupId(x, 'cf_formulas', body.formula) : null });
      });
    }
    if (ruleExists(specCode, subjectType, subjectId)) return null;
    planned.rules.push({ specCode, subjectType, subjectId });
    return add('Spec rule', what, 'none', after, async (x) => {
      await ruleSvc.createRule(x.db, x.c, {
        specificationId: specId(specCode) ?? await lookupId(x, 'cf_specifications', specCode),
        subjectType, subjectId, captureAt: 'item', valueRule: body.valueRule, isRequired: false,
        formulaId: body.formula ? await lookupId(x, 'cf_formulas', body.formula) : null,
      });
    });
  };
  const chainOf = (nodeId) => { const out = []; for (let n = data.nodesById.get(nodeId), h = 0; n && h < 8; n = data.nodesById.get(n.parent_id), h++) out.push(n); return out; };

  // =================================================================================================
  // 1. Jack bend removal on the Hydraulic jack type
  // =================================================================================================
  {
    const opCode = p.op('CG-JACKBEND');
    const jackName = p.type('Hydraulic jack').toLowerCase();
    const jack = data.nodes.filter((n) => n.scope === 'machine' && n.name.toLowerCase() === jackName).sort((a, b) => b.depth - a.depth)[0];
    if (!data.ops.has(opCode)) blocked('Machine rule', opCode, 'operation missing', 'run cf_plant_operations.mjs first');
    else if (!jack) blocked('Machine rule', opCode, 'no rule', `no machine type named "${p.type('Hydraulic jack')}"`);
    else {
      const fCode = p.formula('CG_JACK_BEND_TIME');
      ensureFormula(fCode, 'Jack bend removal time', `item.${p.spec('LENGTH')} * 30 / 1000`,
        'Workbook Sample_Calculations: 1 shift (12 hours) = 24 m of girder length -> 720 min / 24,000 mm = 30 min a metre of girder segment. Minutes per piece.');
      const existing = rulesOf(opCode).find((r) => r.subject_type === 'classification' && r.subject_id === jack.id && !r.effective_from);
      ensureTimingRule(opCode, existing, { type: 'classification', id: jack.id, name: jack.name }, {
        workFormula: fCode,
        notes: `Workbook: 1 shift (12 h) = ${JACK_MM_PER_SHIFT / 1000} m of girder length (48 m in total, both sides, top + bottom) -> ${SHIFT_MIN / (JACK_MM_PER_SHIFT / 1000)} min a metre. The workbook names no machine; the Hydraulic jack type holds the plant's jacks. Reads the girder segment's LENGTH.`,
      }, '30 min a metre');
    }
  }

  // =================================================================================================
  // 2. Line matching: (joints per girder line / segments per line) x 720, per segment
  // =================================================================================================
  const segCls = p.cls('GIRDER_SEGMENT');
  const itemById = new Map(data.items.map((i) => [i.id, i]));
  {
    const opCode = p.op('CG-LINEMATCH');
    const counts = [];
    for (const gl of data.items.filter((i) => i.cls === p.cls('GIRDER_LINE'))) {
      const n = data.bom.filter((b) => b.parent_id === gl.id && itemById.get(b.child_id)?.cls === segCls).reduce((s, b) => s + Number(b.quantity), 0);
      if (n > 0) counts.push(n);
    }
    const rules = rulesOf(opCode).filter((r) => r.eligible);
    if (!data.ops.has(opCode)) blocked('Machine rule', opCode, 'operation missing', 'run cf_plant_operations.mjs first');
    else if (!counts.length) blocked('Machine rule', opCode, rules.map(fmtRule).join('; ') || 'no rule', data.line ? `line ${data.line.id} has no girder line with segments` : 'no line to count segments on — pass --line');
    else if (!rules.length) blocked('Machine rule', opCode, 'no rule', 'no machine type is eligible for line matching (the EOT crane rule is missing)');
    else {
      const tally = new Map();
      for (const n of counts) tally.set(n, (tally.get(n) ?? 0) + 1);
      const segs = [...tally.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
      if (tally.size > 1) notes.push(`Line matching: girder lines have ${[...tally.keys()].join(' / ')} segments — used ${segs}, the most common.`);
      const perJoint = DAY_MIN / JOINTS_PER_DAY;
      const minutes = Number(((segs - 1) / segs * perJoint).toFixed(4));
      for (const r of rules) {
        ensureTimingRule(opCode, r, subjectOf(r), {
          workMinutes: minutes,
          notes: `Workbook: "2 joints = 1 day" — NEED TO CONFIRM (the sheet's own words). Day = 24 h (user 2026-10-01) -> ${perJoint} min a joint. The operation sits on each girder SEGMENT: (joints per girder line / segments per line) x ${perJoint} = (${segs - 1} / ${segs}) x ${perJoint} = ${minutes} min, joints = segments - 1, ${segs} segments per girder line in the KEPL structure. A constant because a timing formula sees only the segment's own values, not its girder line's segment count.`,
        }, `${segs - 1}/${segs} x ${perJoint}`);
      }
    }
  }

  // =================================================================================================
  // 3. Trial assembly and dismantling: the span's time spread by weight
  // =================================================================================================
  const valOf = (itemId, code) => { const sid = specId(code); return data.values.find((x) => x.subject_id === itemId && x.specification_id === sid) ?? null; };
  const numOf = (itemId, code) => { const v = valOf(itemId, code); return v?.value_number == null ? null : Number(v.value_number); };
  let trial = null;
  {
    const spanCls = p.cls('BRIDGE_SPAN');
    const span = data.line ? data.items.find((i) => i.id === data.line.item_id && i.cls === spanCls) ?? data.items.find((i) => i.cls === spanCls) : null;
    const weight = span ? numOf(span.id, p.spec('WEIGHT')) : null;
    const spanLen = span ? numOf(span.id, p.spec('SPAN_LENGTH')) : null;
    const trialOps = ['CG-TRIALASM', 'CG-DISMANTLE'].map(p.op).filter((c) => data.ops.has(c) && rulesOf(c).some((r) => r.eligible));
    if (!trialOps.length) {
      for (const code of ['CG-TRIALASM', 'CG-DISMANTLE']) blocked('Machine rule', p.op(code), data.ops.has(p.op(code)) ? 'no eligible rule' : 'operation missing', data.ops.has(p.op(code)) ? 'no machine type is eligible (the Gantry crane rule is missing)' : 'run cf_plant_operations.mjs first');
    } else if (!span || !weight) {
      for (const code of ['CG-TRIALASM', 'CG-DISMANTLE']) blocked('Machine rule', p.op(code), rulesOf(p.op(code)).map(fmtRule).join('; ') || 'no rule', span ? 'the span has no WEIGHT' : 'no span to read the length and weight from — pass --line');
    } else {
      const L = spanLen ?? DEFAULT_SPAN_MM;
      if (spanLen == null) notes.push(`Trial assembly: the span holds no SPAN_LENGTH value — took ${DEFAULT_SPAN_MM.toLocaleString('en-US')} mm (ROB 59.3 m, the BOQ; CF_SPAN_LENGTH_MM overrides).`);
      const factor = trialFactor(L);
      const T = TRIAL_DAYS_36 * DAY_MIN * (L / TRIAL_REF_MM) * factor;
      const rate = sig6(T / weight);
      const rateHalf = sig6(T / 2 / weight);
      trial = { L, factor, T, weight, rate, rateHalf, spanItem: span.id };
      const desc = `Workbook: trial assembly T = T36 x span / 36 m, x1.2 above 36 m (x0.8 below); composite girder T36 = 6.5 days; a day = 24 h (user 2026-10-01). Span ${L.toLocaleString('en-US')} mm -> T = 6.5 x ${DAY_MIN} x ${(L / TRIAL_REF_MM).toFixed(4)} x ${factor} = ${T.toFixed(1)} min a span, spread over the span's ${weight.toLocaleString('en-US', { maximumFractionDigits: 0 })} kg because the operation sits on every piece, not on the span.`;
      const fT = p.formula('CG_TRIAL_ASSEMBLY_TIME');
      const fD = p.formula('CG_DISMANTLE_TIME');
      ensureFormula(fT, 'Trial assembly time (by weight)', `item.${p.spec('WEIGHT')} * ${rate}`, `${desc} Rate ${rate} min/kg.`);
      ensureFormula(fD, 'Dismantling time (by weight)', `item.${p.spec('WEIGHT')} * ${rateHalf}`, `Workbook: dismantling = 0.5 x trial assembly. ${desc} Rate ${rateHalf} min/kg.`);
      for (const [code, f, label] of [['CG-TRIALASM', fT, `${rate} min/kg`], ['CG-DISMANTLE', fD, `${rateHalf} min/kg`]]) {
        const opCode = p.op(code);
        const rules = rulesOf(opCode).filter((r) => r.eligible);
        if (!data.ops.has(opCode)) { blocked('Machine rule', opCode, 'operation missing', 'run cf_plant_operations.mjs first'); continue; }
        if (!rules.length) { blocked('Machine rule', opCode, 'no rule', 'no machine type is eligible (the Gantry crane rule is missing)'); continue; }
        for (const r of rules) {
          ensureTimingRule(opCode, r, subjectOf(r), {
            workFormula: f,
            notes: `${code === 'CG-DISMANTLE' ? 'Half of trial assembly. Trial assembly is ' : ''}${T.toFixed(1)} min a span (${(T / 60).toFixed(1)} h), spread by weight. Not a formula on span length: a splice plate cannot see SPAN_LENGTH and no piece can see the span's weight.`,
          }, label);
        }
      }
    }
  }

  // =================================================================================================
  // 4 + 5. Item values on the line, and the Cut plate rules
  // =================================================================================================
  const frozen = data.line ? (data.line.release_id ? 'released' : data.line.locked_at ? 'locked' : ['closed', 'lost', 'cancelled', 'revised'].includes(data.line.order_status) ? data.line.order_status : null) : null;
  const itemWrites = []; // { itemId, specCode, value, source }
  {
    // 4. Segment LENGTH = its web's LENGTH, else its longest plate's.
    let already = 0;
    for (const seg of data.items.filter((i) => i.cls === segCls)) {
      const kids = data.bom.filter((b) => b.parent_id === seg.id).map((b) => itemById.get(b.child_id)).filter(Boolean);
      const web = kids.find((k) => /\bweb\b/i.test(k.name) && numOf(k.id, p.spec('LENGTH')) != null);
      const lengths = kids.map((k) => numOf(k.id, p.spec('LENGTH'))).filter((v) => v != null);
      const want = web ? numOf(web.id, p.spec('LENGTH')) : lengths.length ? Math.max(...lengths) : null;
      const own = numOf(seg.id, p.spec('LENGTH'));
      if (want == null) { notes.push(`Segment ${seg.id}: no plate length under it — LENGTH left alone.`); continue; }
      if (own != null && own !== want) { notes.push(`Segment ${seg.id}: LENGTH is ${own} but its web is ${want} — left as it is.`); continue; }
      if (own === want) { already += 1; continue; }
      itemWrites.push({ itemId: seg.id, specCode: p.spec('LENGTH'), value: want, source: 'entered' });
    }
    if (already) add('Item values', `LENGTH on ${already} girder segment row(s), line ${data.line?.id}`, 'set', 'set', null);
  }
  {
    // 5. Cut plates: calculated perimeter + defaulted piercings, on the classification.
    const cut = data.nodes.find((n) => n.code === p.cls('CUT_PLATE') && n.scope !== 'machine');
    if (!cut) blocked('Spec rule', `${p.spec('CUT_LENGTH')} on ${p.cls('CUT_PLATE')}`, '—', 'no Cut plate classification');
    else {
      ensureSpec(p.spec('CUT_LENGTH'), p.spec('LENGTH'), 'Cut length');
      ensureSpec(p.spec('PIERCINGS'), p.spec('HOLES'), 'Piercings', { data_type: 'number', default_uom: null, measurement_type: 'COUNT', decimals: 0 });
      const fP = p.formula('CG_CUT_PLATE_PERIMETER');
      ensureFormula(fP, 'Cut plate perimeter', `2 * (${p.spec('LENGTH')} + ${p.spec('WIDTH')})`,
        'The outer perimeter of a rectangular blank — what CNC cutting cuts. The workbook takes cut length from the nesting file; until one gives it, the perimeter. mm.');
      ensureSpecRule(p.spec('CUT_LENGTH'), 'classification', cut.id, cut.name, { valueRule: 'calculated', formula: fP }, 'perimeter, every blank');
      ensureSpecRule(p.spec('PIERCINGS'), 'classification', cut.id, cut.name, { valueRule: 'defaulted' }, 'default 1, a blank can override');
      const pv = data.classValues.find((v) => v.subject_id === cut.id && v.specification_id === specId(p.spec('PIERCINGS')));
      const nowP = pv?.value_number == null ? null : Number(pv.value_number);
      if (!data.specs.has(p.spec('PIERCINGS')) && !planned.specs.has(p.spec('PIERCINGS'))) blocked('Class value', `${p.spec('PIERCINGS')} on ${cut.name}`, 'none', 'no PIERCINGS specification');
      else if (nowP === 1) add('Class value', `${p.spec('PIERCINGS')} on ${cut.name}`, '1', '1', null);
      else add('Class value', `${p.spec('PIERCINGS')} on ${cut.name}`, nowP == null ? 'none' : String(nowP), '1 a blank (holes added per blank later)', async (x) => { await valueSvc.setValues(x.db, x.c, 'classification', cut.id, [{ specCode: p.spec('PIERCINGS'), value: 1 }]); });
      // A live line's blanks get both from the rules; a frozen line's only if written onto them.
      if (frozen) {
        for (const cp of data.items.filter((i) => i.cls === p.cls('CUT_PLATE'))) {
          const L = numOf(cp.id, p.spec('LENGTH'));
          const W = numOf(cp.id, p.spec('WIDTH'));
          if (L == null || W == null) { notes.push(`Cut plate ${cp.id}: no LENGTH/WIDTH — no perimeter.`); continue; }
          if (numOf(cp.id, p.spec('CUT_LENGTH')) == null) itemWrites.push({ itemId: cp.id, specCode: p.spec('CUT_LENGTH'), value: Number((2 * (L + W)).toFixed(6)), source: 'calculated' });
          if (numOf(cp.id, p.spec('PIERCINGS')) == null) itemWrites.push({ itemId: cp.id, specCode: p.spec('PIERCINGS'), value: 1, source: 'defaulted' });
        }
      }
    }
    if (itemWrites.length) {
      const segW = itemWrites.filter((w) => w.specCode === p.spec('LENGTH'));
      const cutW = itemWrites.filter((w) => w.specCode !== p.spec('LENGTH'));
      const what = [segW.length ? `LENGTH on ${segW.length} girder segment row(s) (${[...new Set(segW.map((w) => w.value))].join(' / ')} mm)` : null,
        cutW.length ? `CUT_LENGTH + PIERCINGS on ${new Set(cutW.map((w) => w.itemId)).size} cut plate(s)` : null].filter(Boolean).join('; ');
      const label = `${what}, line ${data.line.id}`;
      if (frozen && !opts.lockedLineValues) {
        blocked('Item values', label, 'missing', `line ${data.line.id} is ${frozen}: its items show only the values they hold and valueService refuses new ones. --locked-line-values writes them anyway (the user's call).${frozen === 'released' ? ' Released: its steps keep the times release copied until the release is taken back and released again.' : ''}`);
      } else {
        add('Item values', label, 'missing', frozen ? `written onto the ${frozen} line (--locked-line-values)` : 'set (valueService.setValues)', async (x) => {
          const bySubject = new Map();
          for (const w of itemWrites) { if (!bySubject.has(w.itemId)) bySubject.set(w.itemId, []); bySubject.get(w.itemId).push(w); }
          if (frozen) {
            const { byCode } = await valueSvc.loadSpecs(x.db, companyId, itemWrites.map((w) => ({ specCode: w.specCode })));
            for (const [id, ws] of bySubject) {
              const writes = [];
              for (const w of ws) {
                const spec = byCode.get(w.specCode.toUpperCase());
                const { typed, problem } = await valueSvc.coerce(x.db, companyId, spec, w.value);
                if (problem) throw new Error(problem);
                writes.push({ spec, typed, source: w.source });
              }
              await valueSvc.upsertValues(x.db, x.c, 'master', id, writes);
            }
          } else {
            for (const [id, ws] of bySubject) await valueSvc.setValues(x.db, x.c, 'master', id, ws.map((w) => ({ specCode: w.specCode, value: w.value })));
          }
        });
      }
    }
  }

  // =================================================================================================
  // 6a. Per-process weld and coat specifications; formulas repointed (and both faces)
  // =================================================================================================
  for (const s of splitSpecs(p)) {
    ensureSpec(s.code, s.like, s.name);
    // Assignable wherever the old one was (classification rules); values: none.
    for (const a of data.assignments.filter((x) => x.spec_code === s.like && x.subject_type === 'classification' && x.is_applicable)) {
      const node = data.nodesById.get(a.subject_id);
      ensureSpecRule(s.code, 'classification', a.subject_id, node?.name ?? `node ${a.subject_id}`, { valueRule: ['entered', 'defaulted'].includes(a.value_rule) ? a.value_rule : 'entered' }, `like ${s.like}`);
    }
  }
  for (const f of formulaRewrites(p)) {
    const cur = data.formulas.get(f.code);
    if (!cur) { blocked('Formula', f.code, 'missing', 'run cf_plant_operations.mjs first'); continue; }
    if (norm(cur.expression) === norm(f.to)) { planned.formulaExpr.set(f.code, f.to); add('Formula', f.code, cur.expression, f.to, null); }
    else if (norm(cur.expression) === norm(f.from)) {
      planned.formulaExpr.set(f.code, f.to);
      add('Formula', f.code, cur.expression, `${f.to}  [${f.why}]`, async (x) => { await formulaSvc.updateFormula(x.db, x.c, cur.id, { expression: f.to }); });
    } else blocked('Formula', f.code, cur.expression, `changed by hand since the import — expected ${f.from}`);
  }

  // =================================================================================================
  // 6b. A repeated operation: each later pass becomes its own operation
  // =================================================================================================
  for (const rep of passPlan(p)) {
    const op = data.ops.get(rep.op);
    const passOpIds = new Set(rep.passes.filter((x) => x.op && data.ops.get(x.op)).map((x) => data.ops.get(x.op).id));
    const steps = op ? data.flowSteps.filter((s) => s.flow_code === rep.flow && (s.operation_id === op.id || passOpIds.has(s.operation_id))) : [];
    if (!op || !steps.length) { blocked('Flow step', `${rep.flow} ${rep.op}`, 'not found', 'flow or operation missing'); continue; }
    if (steps.length !== rep.passes.length) { blocked('Flow step', `${rep.flow} ${rep.op}`, `${steps.length} pass(es)`, `expected ${rep.passes.length} — the flow changed since the workbook import; left alone`); continue; }
    for (const [k, pass] of rep.passes.entries()) {
      const step = steps[k];
      let renamedByRepoint = false;
      if (pass.op) {
        ensureSpec(pass.newSpec.code, pass.newSpec.like, pass.newSpec.name);
        ensureFormula(pass.formula, `${pass.name} time`, pass.expr, `Pass ${k + 1} of ${rep.op} in ${rep.flow} (workbook ${pass.stepName.match(/\(S\d+\)/)?.[0] ?? ''}) as its own operation, reading only its own quantity — a flow that repeats an operation no longer counts the whole quantity on every pass.`);
        const newOp = data.ops.get(pass.op);
        if (!newOp && !planned.ops.has(pass.op)) {
          planned.ops.add(pass.op);
          add('Operation', pass.op, 'missing', pass.name, async (x) => {
            await opsSvc.createOperation(x.db, x.c, { code: pass.op, name: pass.name, description: `Pass ${k + 1} of ${rep.op} in ${rep.flow} (${pass.stepName}). Its own operation since 2026-10-01 (cf_operation_times.mjs).` });
          });
        } else if (newOp) add('Operation', pass.op, 'exists', 'exists', null);
        // The same machines as the original, its own formula.
        for (const r of rulesOf(rep.op).filter((x) => x.eligible)) {
          const mine = newOp ? data.rules.find((x) => x.operation_id === newOp.id && x.subject_type === r.subject_type && x.subject_id === r.subject_id && !x.effective_from) : null;
          ensureTimingRule(pass.op, mine, subjectOf(r), { workFormula: pass.formula, notes: `Pass ${k + 1} of ${rep.op} in ${rep.flow}: ${pass.stepName}. Same machines as ${rep.op}; reads only this pass's quantity.` }, 'own quantity');
        }
        const used = data.released.get(step.id) ?? 0;
        const opNow = data.opsById.get(step.operation_id)?.code ?? String(step.operation_id);
        if (newOp && step.operation_id === newOp.id) { planned.stepOp.set(step.id, pass.op); add('Flow step', `${rep.flow} seq ${step.sequence}`, opNow, pass.op, null); }
        else if (used) blocked('Flow step', `${rep.flow} seq ${step.sequence}`, opNow, `${used} released production step(s) were copied from it — flowService refuses to change its operation. Take the release back, re-run, release again.`);
        else {
          planned.stepOp.set(step.id, pass.op);
          renamedByRepoint = true;
          add('Flow step', `${rep.flow} seq ${step.sequence}`, `${opNow} "${step.step_name ?? ''}"`, `${pass.op} "${pass.stepName}"`, async (x) => {
            await flowSvc.updateStep(x.db, x.c, step.id, { operationId: newOp?.id ?? await lookupId(x, 'cf_operations', pass.op), stepName: pass.stepName });
          });
        }
      }
      if (!renamedByRepoint && norm(step.step_name) !== norm(pass.stepName)) {
        add('Flow step name', `${rep.flow} seq ${step.sequence}`, step.step_name ?? '—', pass.stepName, async (x) => { await flowSvc.updateStep(x.db, x.c, step.id, { stepName: pass.stepName }); });
      }
    }
  }

  // =================================================================================================
  // 6d. Every quantity a flow's formulas read is assignable on what the flow makes
  // =================================================================================================
  {
    const exprOfOp = (opCode) => {
      const fCode = planned.opFormula.get(opCode) ?? null;
      if (fCode) return planned.formulaExpr.get(fCode) ?? data.formulas.get(fCode)?.expression ?? null;
      const op = data.ops.get(opCode);
      if (!op) return null;
      // The op's rules' work formulas (all of them), as planned.
      const exprs = data.rules.filter((r) => r.operation_id === op.id && r.eligible && r.work_code).map((r) => planned.formulaExpr.get(r.work_code) ?? r.work_expr);
      return exprs.length ? exprs.join(' + ') : null;
    };
    const itemRefs = (expr) => { try { return parseFormula(expr).itemRefs ?? []; } catch { return []; } };
    const byFlow = new Map();
    for (const s of data.flowSteps) { if (!byFlow.has(s.flow_id)) byFlow.set(s.flow_id, []); byFlow.get(s.flow_id).push(s); }
    for (const [flowId, steps] of byFlow) {
      const users = data.flowUsers.filter((u) => u.flow_id === flowId);
      if (!users.length) continue;
      const reads = new Set();
      for (const s of steps) {
        const opCode = planned.stepOp.get(s.id) ?? data.opsById.get(s.operation_id)?.code;
        const expr = opCode ? exprOfOp(opCode) : null;
        if (expr) for (const r of itemRefs(expr)) reads.add(r);
      }
      const classes = [...new Set(users.map((u) => u.classification_id))].map((id) => data.nodesById.get(id)).filter(Boolean);
      for (const node of classes) {
        const masters = users.filter((u) => u.classification_id === node.id).map((u) => u.master_id);
        for (const code of reads) {
          if (!data.specs.has(code) && !planned.specs.has(code)) continue;
          const onChain = chainOf(node.id).some((n) => ruleExists(code, 'classification', n.id));
          // Every record made by the flow already carries it on its own definition: enough.
          const onAllMasters = masters.length && masters.every((m) => ruleExists(code, 'master', m));
          if (!onChain && !onAllMasters) ensureSpecRule(code, 'classification', node.id, node.name, { valueRule: 'entered' }, `read by ${steps[0].flow_code}`);
        }
      }
    }
  }

  return { actions: A, notes, trial, frozen };
}

/* ===========================================================================
 * Shifts: report, and round-the-clock on --shifts
 * ======================================================================== */

const toMin = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + m; };
const spanMin = (s) => { const a = toMin(s.start_time); const b = toMin(s.end_time); return b > a ? b - a : b + 1440 - a; };
const daysOf = (s) => String(s.weekdays).split(',').filter(Boolean);
const weekHours = (rows) => rows.reduce((t, s) => t + daysOf(s).length * (spanMin(s) - s.break_minutes), 0) / 60;
const sigOf = (rows) => rows.map((s) => `${s.name}|${s.weekdays}|${String(s.start_time).slice(0, 5)}-${String(s.end_time).slice(0, 5)}|${s.break_minutes}`).sort().join(' + ');
const HOUSE_DAY = { name: 'Day', start: '08:00', end: '17:00' };

export function planShifts(data) {
  const byMachine = new Map();
  for (const s of data.allShifts) { if (!byMachine.has(s.machine_id)) byMachine.set(s.machine_id, []); byMachine.get(s.machine_id).push(s); }
  // A pattern already in the database that covers the day? That is the template.
  let template = null;
  for (const rows of byMachine.values()) {
    if (rows.length < 2) continue;
    const perDay = rows.reduce((t, s) => t + spanMin(s), 0);
    const sameDays = rows.every((s) => s.weekdays === rows[0].weekdays);
    if (sameDays && perDay >= 23 * 60) {
      template = { source: `copied from a machine that already runs round the clock: ${sigOf(rows)}`, shifts: rows.map((s) => ({ name: s.name, weekdays: daysOf(s), startTime: String(s.start_time).slice(0, 5), endTime: String(s.end_time).slice(0, 5), breakMinutes: s.break_minutes })) };
      break;
    }
  }
  const out = { template, machines: [], byType: new Map() };
  for (const m of data.productionMachines) {
    const rows = byMachine.get(m.id) ?? [];
    const days = rows.length ? [...new Set(rows.flatMap(daysOf))] : ['mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
    const ordered = shiftSvc.WEEKDAYS.filter((d) => days.includes(d));
    const target = template?.shifts ?? [
      { name: 'Day', weekdays: ordered, startTime: '08:00', endTime: '20:00', breakMinutes: 60 },
      { name: 'Night', weekdays: ordered, startTime: '20:00', endTime: '08:00', breakMinutes: 60 },
    ];
    const asRows = target.map((t) => ({ name: t.name, weekdays: t.weekdays.join(','), start_time: t.startTime, end_time: t.endTime, break_minutes: t.breakMinutes }));
    let kind;
    if (rows.length && sigOf(rows) === sigOf(asRows)) kind = 'already';
    else if (!rows.length) kind = 'none';
    else if (rows.length === 1 && rows[0].name === HOUSE_DAY.name && String(rows[0].start_time).slice(0, 5) === HOUSE_DAY.start && String(rows[0].end_time).slice(0, 5) === HOUSE_DAY.end) kind = 'house-day';
    else kind = 'custom';
    const rec = { machine: m, rows, kind, target, before: weekHours(rows), after: weekHours(kind === 'custom' ? rows : asRows) };
    out.machines.push(rec);
    const typeName = data.nodesById.get(m.classification_id)?.name ?? `type ${m.classification_id}`;
    if (!out.byType.has(typeName)) out.byType.set(typeName, { machines: 0, before: 0, after: 0, kinds: {} });
    const t = out.byType.get(typeName);
    t.machines += 1; t.before += rec.before; t.after += rec.after; t.kinds[kind] = (t.kinds[kind] ?? 0) + 1;
  }
  return out;
}

async function applyShifts(db, c, sp) {
  let changed = 0;
  for (const rec of sp.machines) {
    if (rec.kind === 'already' || rec.kind === 'custom') continue;
    const [first, ...rest] = rec.target;
    // The house Day shift is UPDATED, not deleted, so day-offs that name it survive.
    if (rec.kind === 'house-day') await shiftSvc.updateShift(db, c, rec.rows[0].id, first);
    else await shiftSvc.createShift(db, c, rec.machine.id, first);
    for (const s of rest) await shiftSvc.createShift(db, c, rec.machine.id, s);
    changed += 1;
  }
  return changed;
}

/* ===========================================================================
 * Line times, through the Times grid's own service
 * ======================================================================== */

export async function lineTimes(db, companyId, line) {
  if (!line) return null;
  const v = await getLineTimes(db, companyId, line.order_id, line.id);
  const byCode = new Map();
  for (const o of v.operations) byCode.set(o.code, { name: o.name, minutes: v.totals.byOperation[o.id] ?? null });
  return { byCode, all: v.totals.all };
}

/* ===========================================================================
 * The entry point (the test calls it), and the CLI
 * ======================================================================== */

/**
 * opts: { prefix?, lineId?, commit?, shifts?, lockedLineValues?, userId?, beforeApply?(data) }
 * Plans with SELECTs only; applies — in the CALLER's transaction — with commit
 * (rules, formulas, specs, flows, values) and/or shifts.
 */
export async function run(db, companyId, opts = {}) {
  const p = namesOf(opts.prefix ?? '');
  const c = { companyId, userId: opts.userId ?? null };
  const data = await load(db, companyId, p, { lineId: opts.lineId ?? null });
  const planned = await plan(companyId, p, data, opts);
  const shiftPlan = planShifts(data);
  const before = opts.beforeApply ? await opts.beforeApply(data) : null;
  let appliedActions = 0;
  let appliedShifts = 0;
  if (opts.commit) {
    for (const a of planned.actions.filter((x) => x.status === 'change')) {
      try { await a.run({ db, c }); } catch (e) { e.message = `${a.area} ${a.what}: ${e.message}${e.problems ? ` — ${JSON.stringify(e.problems)}` : ''}`; throw e; }
      appliedActions += 1;
    }
  }
  if (opts.shifts) appliedShifts = await applyShifts(db, c, shiftPlan);
  return { ...planned, data, shiftPlan, before, appliedActions, appliedShifts };
}

const pad = (s, n) => { const t = String(s ?? ''); return t.length > n ? `${t.slice(0, n - 1)}…` : t.padEnd(n); };

function printReport(out, { commit, shifts }) {
  const say = (...a) => console.log(...a);
  const { actions, notes, trial, data, shiftPlan } = out;
  if (data.line) say(`line ${data.line.id} (${data.line.order_code} line ${data.line.line_no}, x${Number(data.line.quantity)}) — ${out.frozen ? out.frozen.toUpperCase() : 'live'}`);
  else if (data.candidateLines.length > 1) say(`${data.candidateLines.length} lines sell a span — pass --line <id> (${data.candidateLines.map((l) => l.id).join(', ')})`);
  else say('no line sells a span — the line-dependent parts are blocked');
  if (trial) say(`trial assembly: span ${trial.L.toLocaleString('en-US')} mm, x${trial.factor}, ${trial.T.toFixed(1)} min (${(trial.T / 60).toFixed(1)} h) a span over ${trial.weight.toLocaleString('en-US', { maximumFractionDigits: 1 })} kg -> ${trial.rate} min/kg (dismantling ${trial.rateHalf})`);

  const W = [15, 54, 50, 62];
  say(`\n${pad('Area', W[0])} ${pad('What', W[1])} ${pad('Before', W[2])} ${pad('After', W[3])} Status`);
  say('-'.repeat(W.reduce((a, b) => a + b + 1, 0) + 12));
  const order = { change: 0, blocked: 1, same: 2 };
  for (const a of [...actions].sort((x, y) => order[x.status] - order[y.status])) {
    const status = a.status === 'change' ? (commit ? 'CHANGED' : 'would change') : a.status === 'blocked' ? 'BLOCKED' : 'already so';
    say(`${pad(a.area, W[0])} ${pad(a.what, W[1])} ${pad(a.before, W[2])} ${pad(a.after, W[3])} ${status}`);
    if (a.status === 'blocked') say(`${' '.repeat(W[0] + 1)}  why: ${a.why}`);
  }
  const n = (s) => actions.filter((a) => a.status === s).length;
  say(`\n${n('change')} to change, ${n('same')} already so, ${n('blocked')} blocked.`);
  if (notes.length) { say('\nnotes:'); for (const x of notes) say(`  - ${x}`); }

  say(`\nshifts — ${data.productionMachines.length} production machines (types that carry a timing rule). Round-the-clock pattern: ${shiftPlan.template ? shiftPlan.template.source : '2 x 12 h — Day 08:00-20:00 + Night 20:00-08:00, 60 min break each, on the days each machine already works (no round-the-clock pattern in the database; the workbook works in 12 h shifts)'}`);
  say(`${pad('Machine type', 36)} ${pad('Machines', 9)} ${pad('h/week now', 11)} ${pad('h/week then', 12)} today`);
  for (const [type, t] of [...shiftPlan.byType.entries()].sort()) {
    say(`${pad(type, 36)} ${pad(t.machines, 9)} ${pad(t.before.toFixed(0), 11)} ${pad(t.after.toFixed(0), 12)} ${Object.entries(t.kinds).map(([k, v]) => `${v} ${k}`).join(', ')}`);
  }
  const tot = shiftPlan.machines.reduce((a, r) => ({ b: a.b + r.before, f: a.f + r.after }), { b: 0, f: 0 });
  say(`${pad('All', 36)} ${pad(shiftPlan.machines.length, 9)} ${pad(tot.b.toFixed(0), 11)} ${pad(tot.f.toFixed(0), 12)} (house-day: the Day 08-17 shift is stretched to 08-20 and a Night added; custom: left alone)`);
  say(shifts ? `shifts: ${out.appliedShifts} machine(s) set round the clock.` : 'shifts: report only — --shifts applies them.');
  if (!commit && !shifts) say('\nDry run — read-only transaction, nothing written. --commit to mean it (--locked-line-values for values on a locked line; --shifts for the shifts).');
}

function printTimes(before, after) {
  if (!before) return;
  const codes = [...new Set([...before.byCode.keys(), ...(after ? after.byCode.keys() : [])])].sort();
  const h = (m) => (m == null ? '—' : (m / 60).toFixed(1));
  console.log(`\nTimes grid (timeEstimateService.getLineTimes), hours per operation for the whole line${after ? ' — before -> after' : ' — now'}:`);
  console.log(`${pad('Operation', 56)} ${pad('Before h', 10)} ${after ? 'After h' : ''}`);
  for (const code of codes) {
    const b = before.byCode.get(code);
    const a = after?.byCode.get(code);
    console.log(`${pad(`${code} ${b?.name ?? a?.name ?? ''}`, 56)} ${pad(b ? h(b.minutes) : '(none)', 10)} ${after ? (a ? h(a.minutes) : '(none)') : ''}`);
  }
  console.log(`${pad('All', 56)} ${pad(h(before.all), 10)} ${after ? h(after.all) : ''}`);
}

async function main() {
  const argv = process.argv.slice(2);
  const COMMIT = argv.includes('--commit');
  const SHIFTS = argv.includes('--shifts');
  const LOCKED = argv.includes('--locked-line-values');
  const li = argv.indexOf('--line');
  const LINE = li >= 0 ? Number(argv[li + 1]) : (process.env.CF_TIMES_LINE ? Number(process.env.CF_TIMES_LINE) : null);
  const COMPANY = Number(process.env.CF_BRIDGE_COMPANY ?? 2);
  const USER = process.env.CF_BRIDGE_USER ? Number(process.env.CF_BRIDGE_USER) : null;
  const where = /^(localhost|127\.0\.0\.1|::1)?$/i.test(process.env.DB_HOST ?? '') ? 'local' : 'PRODUCTION';
  const write = COMMIT || SHIFTS;
  console.log(`${where}, company ${COMPANY} — ${write ? `WRITING${COMMIT ? ' rules/formulas/specs/flows' : ''}${COMMIT && LOCKED ? ' + locked-line values' : ''}${SHIFTS ? ' + shifts' : ''}` : 'dry run (SELECTs only, read-only transaction)'}`);

  const conn = await pool.getConnection();
  let trips = 0;
  const db = new Proxy(conn, { get: (t, k) => (k === 'query' ? (...a) => { trips += 1; return t.query(...a); } : Reflect.get(t, k)) });
  try {
    if (write) await conn.beginTransaction();
    else {
      const [[{ v }]] = await conn.query('SELECT VERSION() AS v');
      // TiDB's READ ONLY is a no-op; a stale read is genuinely read-only (it refuses writes).
      await conn.query(/tidb/i.test(v) ? 'START TRANSACTION READ ONLY AS OF TIMESTAMP NOW() - INTERVAL 1 SECOND' : 'START TRANSACTION READ ONLY');
    }
    attachNodeCache(db);
    const out = await run(db, COMPANY, {
      lineId: LINE, commit: COMMIT, shifts: SHIFTS, lockedLineValues: LOCKED, userId: USER,
      beforeApply: (data) => lineTimes(db, COMPANY, data.line),
    });
    const after = COMMIT && out.data.line ? await lineTimes(db, COMPANY, out.data.line) : null;
    printReport(out, { commit: COMMIT, shifts: SHIFTS });
    printTimes(out.before, after);
    detachNodeCache(db);
    if (write) { await conn.commit(); console.log(`\nCommitted: ${out.appliedActions} change(s)${SHIFTS ? `, ${out.appliedShifts} machine(s) round the clock` : ''}.`); }
    else await conn.query('ROLLBACK');
    console.log(`round trips: ${trips}`);
  } catch (e) {
    try { await conn.query('ROLLBACK'); } catch { /* keep the first error */ }
    console.error('\nFAILED, rolled back:', e.code ?? '', e.message, e.problems ? JSON.stringify(e.problems) : '');
    process.exitCode = 1;
  } finally {
    conn.release();
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
