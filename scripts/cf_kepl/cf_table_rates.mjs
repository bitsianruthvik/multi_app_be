/**
 * cf_table_rates.mjs — makes CF_ERP's composite girder operation times follow
 * the user's Master_Formulae table (Downloads/Process_Flow_v5.xlsx, tab
 * Master_Formulae) EXACTLY — the formula SHAPES and the RATES — and re-releases
 * the KEPL line once. User, 2026-10-01: "use the table's rates and re-release
 * KEPL and note the formulas too. Not just the rates."
 * Write-up: TM/CF_ERP_MASTER_FORMULAE_APPLIED.md.
 *
 * Supersedes cf_arc_blast_rates.mjs (arc 2.8 min/m, blasting 2.5 min/m² x 2
 * faces + 15 manual are folded in here) — that script is RETIRED from the run
 * order. Earlier steps it builds on: cf_operation_times.mjs (specs, passes as
 * their own operations) and cf_kepl_quantities.mjs (the KEPL weld lengths,
 * stiffeners, studs, coats; its load/projectTimes/reRelease are reused).
 *
 * THE TABLE -> THE FORMULA NOW IN THE SYSTEM (minutes per piece)
 *   1  CNC cutting    T = L x R_cut(Thk) + N_pierce x T_pierce
 *                     item.CUT_LENGTH / LOOKUP(machine.CUT_SPEED, item.THICKNESS) + item.PIERCINGS * 0.2
 *                     R_cut stays the plasma cutter's speed chart (the table says so); T_pierce 0.2 min (was 3 s).
 *   2  Gas cutting    T = L x R_gas(Thk) — the Pug cutting speed chart IS the per-band study; unchanged.
 *   3  H-beam fit-up  T = N x R_hfit x Wt / Wt_ref + setup -> item.HBFIT_JOINTS * 25 * item.WEIGHT / 1000 + 60
 *   4  SAW            T = L x R_saw(WT) -> item.SAW_WELD_LENGTH * 1.0
 *   5  Line matching  T = N x R_lm x Wt / 1000 -> item.LINEMATCH_JOINTS * 10 * item.WEIGHT / 1000
 *   6  CNC drilling   T = N_holes x R_cncd(Thk, Dia) -> item.HOLES * 0.35
 *   7  Manual drill   T = N_holes x R_mand + N_transfer x R_transfer -> item.HOLES * 1.1 + item.HOLE_TRANSFERS * 1.5
 *                     (the top / bottom / inner-splice passes: their own HOLES_* x 1.1)
 *   8  Stiffener fit  USER DECISION 2026-10-01: per stiffener max(8, 8 x its own weight in t), summed over the
 *                     stiffeners on that face -> item.STIFFENER_FIT_TONNES * 8 (pass 2: STIFFENER_FIT_TONNES_AFTER_FLIP),
 *                     STIFFENER_FIT_TONNES = sum over the face of max(1, stiffener kg / 1000)
 *   9  MIG            T = L x R_mig(WT) -> item.MIG_WELD_LENGTH * 1.6 (pass 2: MIG_WELD_LENGTH_AFTER_FLIP)
 *   10 Arc            T = L x R_arc(WT) -> item.ARC_WELD_LENGTH * 2.8
 *   11 Trial assembly T = T_36_ref x span / 36 x (1.2 above 36 m, 0.8 below), T_36_ref = 6.5 days x 1440 min
 *                     (USER DECISION 2026-10-01: Sample_Calculations, 24 h day — not the table's 60 min sample),
 *                     spread over the span by weight: item.WEIGHT / <span kg> * 6.5 * 1440 * <span mm> / 36000 * <factor>
 *   19 Dismantling    0.5 x trial assembly
 *   12 Stud welding   T = N_studs x R_stud -> item.STUDS * 0.4
 *   13 Blasting       T = Area x R_blast x coats + manual -> item.SURFACE_AREA * 2 * 2.5 * 1 + 15
 *   14 Metallising    T = Area x R_metal x coats -> item.SURFACE_AREA * 2 * 4.7 * item.METALLISE_COATS
 *   15 Painting       T = Area x R_paint x N_coats + drying -> item.SURFACE_AREA * 2 * 1.5 * item.PAINT_COATS + 0
 *
 * SINGLE-BAND LOOKUPS. Where the table names a lookup but gives ONE sample band
 * (SAW, MIG, arc, metallising, CNC drilling, manual drilling) the rate is a FLAT
 * CONSTANT IN THE FORMULA. The machine charts / rates (SAW_RATE, MIG_RATE,
 * ARC_RATE, DRILL_TIME, METAL_RATE, PAINT_RATE, STUD_TIME, MANUAL_DRILL_TIME,
 * MARK_TIME, PIERCE_TIME) are NOT touched — they stay on the machine types and
 * machines, only no formula reads them any more; the report prints them so
 * nothing is lost. CUT_SPEED and GAS_CUT_SPEED stay read (rows 1 and 2).
 *
 * KEPL-ONLY DERIVED INPUTS (user: "for this order derive it, in general I will supply"):
 *   STIFFENER_FIT_TONNES / _AFTER_FLIP  girder segment: the stiffeners on each web face (the same split as
 *                    cf_kepl_quantities: longest first, alternating faces), each counted at max(1, own WEIGHT kg / 1000).
 *   HBFIT_JOINTS     girder segment: the flange-to-web joints = its flange plates (2 on KEPL).
 *   LINEMATCH_JOINTS girder segment: its girder line's joints / segments = (n-1)/n (KEPL 4/5 = 0.8).
 *   Wt is the segment's own WEIGHT (rolled up) for H-beam, line matching and stiffener fit-up.
 * New specs, assignable (entered) on the Girder segment classification, written
 * onto the KEPL line's frozen segments with history (valueService.upsertValues).
 *
 * --commit, in ONE transaction: specs + assignment rules -> formulas -> machine
 * rules -> (only if KEPL's computed times or its derived inputs change) take
 * back the release (refused before anything is written if a step started or
 * material was issued) -> write the derived inputs -> release again with the old
 * finished area and notes. A re-run changes nothing.
 *
 *   node scripts/cf_kepl/cf_table_rates.mjs [--line <id>]     # dry run (read-only transaction; TiDB stale read)
 *   node scripts/cf_kepl/cf_table_rates.mjs --commit
 *   CF_BRIDGE_COMPANY=30005 … for prod Placebo, TM/.env.tidb loaded by the caller (default company 2)
 */
import { pathToFileURL } from 'url';
import { pool } from '../../db.js';
import '../../apps/cf_erp/services/codegenProvider.js';
import { attachNodeCache, detachNodeCache } from '../../apps/cf_erp/lib/db.js';
import { parseFormula } from '../../apps/cf_erp/services/formulaEngine.js';
import * as opsSvc from '../../apps/cf_erp/services/operationService.js';
import * as formulaSvc from '../../apps/cf_erp/services/formulaService.js';
import * as specSvc from '../../apps/cf_erp/services/specificationService.js';
import * as ruleSvc from '../../apps/cf_erp/services/assignmentService.js';
import * as valueSvc from '../../apps/cf_erp/services/valueService.js';
import { effectiveByCode } from '../../apps/cf_erp/services/resolutionService.js';
import { load, lineTimes, projectTimes, reRelease } from './cf_kepl_quantities.mjs';

/* ===========================================================================
 * The table's numbers (Master_Formulae, Process_Flow_v5.xlsx)
 * ======================================================================== */

export const R = {
  PIERCE_MIN: 0.2,        // 1  T_pierce
  HFIT_MIN: 25,           // 3  R_hfit min per fit-up
  WT_REF_KG: 1000,        // 3/5/8 Wt_ref
  HFIT_SETUP_MIN: 60,     // 3  "Setup time (in between process)": Sample_Calculations H_Beam row says 60 min (the table gives no number)
  SAW_MIN_PER_M: 1.0,     // 4  R_saw at WT 10 mm
  LM_MIN: 10,             // 5  R_lm min per joint
  CNCD_MIN_PER_HOLE: 0.35,// 6  R_cncd at 16 mm / 24 mm
  MAND_MIN_PER_HOLE: 1.1, // 7  R_mand at 12 mm / 22 mm
  TRANSFER_MIN: 1.5,      // 7  R_transfer
  SFIT_MIN: 8,            // 8  R_sfit min per fit-up
  MIG_MIN_PER_M: 1.6,     // 9  R_mig at WT 6 mm
  ARC_MIN_PER_M: 2.8,     // 10 R_arc at WT 8 mm
  TA_36_REF_DAYS: 6.5,    // 11 T_36_ref — USER DECISION 2026-10-01: Sample_Calculations composite girder 6.5 days at 36 m (not the table's 60 min sample)
  DAY_MIN: 1440,          //    a workbook day is 24 h (user 2026-10-01)
  TA_SAMPLE_MIN: 60,      //    the table's own sample (R_ta = 60 min/assembly) — NOT used, reported only
  SFIT_FLOOR_T: 1,        // 8  USER DECISION 2026-10-01: each stiffener counts at least 1 t -> at least 8 min
  TA_REF_MM: 36000,       // 11 the formula's 36 m reference
  STUD_MIN: 0.4,          // 12 R_stud
  BLAST_MIN_PER_M2: 2.5,  // 13 R_blast
  BLAST_COATS: 1,         // 13 no. of coatings (one blast pass)
  BLAST_MANUAL_MIN: 15,   // 13 manual blasting: Sample_Calculations "~15-20 min" (low end)
  METAL_MIN_PER_M2: 4.7,  // 14 R_metal at 100 µm
  PAINT_MIN_PER_M2: 1.5,  // 15 R_paint
  PAINT_DRYING_MIN: 0,    // 15 drying between coats — not given (a wait, not machine time)
  FACES: 2,               // SURFACE_AREA is ONE face; blast, metallise, paint cover both
};
export const DEFAULT_SPAN_MM = Number(process.env.CF_SPAN_LENGTH_MM ?? 59300); // KEPL BOQ: ROB 59.3 m
export const trialFactor = (spanMm) => (spanMm > R.TA_REF_MM ? 1.2 : spanMm < R.TA_REF_MM ? 0.8 : 1);
const SOURCE = 'entered';
const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const r3 = (x) => Number(Number(x).toFixed(3));

/* --- The table's samples as pure functions (the test reproduces the table with them) --- */
export const sample = {
  cncCut: (Lm, rCut, nPierce, tPierce = R.PIERCE_MIN) => Lm * rCut + nPierce * tPierce,
  gasCut: (Lm, rGas) => Lm * rGas,
  hbeam: (n, wtKg, setup = 0) => n * R.HFIT_MIN * (wtKg / R.WT_REF_KG) + setup,
  saw: (Lm) => Lm * R.SAW_MIN_PER_M,
  lineMatch: (n, wtKg) => n * R.LM_MIN * (wtKg / R.WT_REF_KG),
  cncDrill: (holes) => holes * R.CNCD_MIN_PER_HOLE,
  manDrill: (holes, transfers) => holes * R.MAND_MIN_PER_HOLE + transfers * R.TRANSFER_MIN,
  stiffFitTableSample: (n, wtKg) => n * R.SFIT_MIN * (wtKg / R.WT_REF_KG), // the table's sample (N x R x structure Wt)
  stiffFit: (stiffenerKgs) => stiffenerKgs.reduce((s, kg) => s + Math.max(R.SFIT_MIN, R.SFIT_MIN * kg / R.WT_REF_KG), 0), // user decision
  stiffFitTonnes: (stiffenerKgs) => stiffenerKgs.reduce((s, kg) => s + Math.max(R.SFIT_FLOOR_T, kg / R.WT_REF_KG), 0),
  mig: (Lm) => Lm * R.MIG_MIN_PER_M,
  arc: (Lm) => Lm * R.ARC_MIN_PER_M,
  trial: (spanMm, t36 = R.TA_36_REF_DAYS * R.DAY_MIN) => t36 * (spanMm / R.TA_REF_MM) * trialFactor(spanMm),
  stud: (n) => n * R.STUD_MIN,
  blast: (m2, coats = R.BLAST_COATS, manual = R.BLAST_MANUAL_MIN) => m2 * R.BLAST_MIN_PER_M2 * coats + manual,
  metallise: (m2, coats) => m2 * R.METAL_MIN_PER_M2 * coats,
  paint: (m2, coats, drying = R.PAINT_DRYING_MIN) => m2 * R.PAINT_MIN_PER_M2 * coats + drying,
};

/* --- Units off the specifications --- */
const unitOf = (u) => String(u ?? '').toLowerCase().replace(/\s+/g, '').replace('²', '2').replace('^2', '2');
export function metresOf(code, uom) {
  const u = unitOf(uom);
  if (['m', 'metre', 'meter', 'metres', 'meters'].includes(u)) return `item.${code}`;
  if (['mm', 'millimetre', 'millimeter'].includes(u)) return `item.${code} / 1000`;
  return null;
}
export function squareMetresOf(code, uom) {
  const u = unitOf(uom);
  if (['m2', 'sqm', 'sq.m', 'sqmetre', 'sqmeter'].includes(u)) return `item.${code}`;
  if (['mm2', 'sqmm', 'sq.mm'].includes(u)) return `item.${code} / 1000000`;
  return null;
}
export function kilogramsOf(code, uom) {
  const u = unitOf(uom);
  if (['kg', 'kgs', 'kilogram', 'kilograms'].includes(u)) return `item.${code}`;
  if (['t', 'mt', 'tonne', 'tonnes', 'ton'].includes(u)) return `item.${code} * 1000`;
  return null;
}

/* ===========================================================================
 * One entry per operation: the table formula, the formula code, how to build it
 * ======================================================================== */

/**
 * `u` = spec units by code; `trial` = { spanKg, spanMm, factor } or null.
 * build() returns { expression } or { why } (blocked).
 */
export function tableEntries(u, trial) {
  const need = (fn, code, kind) => { const e = fn(code, u[code]); return e ? { e } : { why: `${code} is held in "${u[code] ?? '(no spec / no unit)'}" — not a ${kind} unit this script converts` }; };
  const len = (code) => need(metresOf, code, 'length');
  const area = () => need(squareMetresOf, 'SURFACE_AREA', 'area');
  const kg = () => need(kilogramsOf, 'WEIGHT', 'weight');
  const by = (parts, f) => { const bad = parts.find((p) => p.why); return bad ? { why: bad.why } : { expression: f(...parts.map((p) => p.e)) }; };
  const trialExpr = (half) => {
    if (!trial) return { why: 'no span WEIGHT to spread the span\'s time over — pass --line' };
    return by([kg()], (w) => `${half ? '0.5 * (' : ''}${w} / ${trial.spanKg} * ${R.TA_36_REF_DAYS} * ${R.DAY_MIN} * ${trial.spanMm} / ${R.TA_REF_MM} * ${trial.factor}${half ? ')' : ''}`);
  };
  const SRC = 'Master_Formulae (Process_Flow_v5.xlsx)';
  return [
    { no: 1, name: 'CNC cutting', op: 'CG-CNCCUT', formula: 'CG_CNC_CUT_TIME', fname: 'CNC cutting time',
      table: 'T = L × R_cut(Thk) + N_pierce × T_pierce', sampleText: 'Thk 12 mm → R_cut 1.8 min/m; T_pierce 0.2 min',
      rates: 'R_cut = the machine speed chart CUT_SPEED (mm/min) at THICKNESS (kept, as the table says); T_pierce = 0.2 min (was machine PIERCE_TIME 3 s)',
      build: () => ({ expression: `item.CUT_LENGTH / LOOKUP(machine.CUT_SPEED, item.THICKNESS) + item.PIERCINGS * ${R.PIERCE_MIN}` }) },
    { no: 2, name: 'Gas cutting', op: 'CG-GASCUT', formula: 'CG_GAS_CUT_TIME', fname: 'Gas cutting time',
      table: 'T = L × R_gas(Thk)', sampleText: 'Thk 20 mm → R_gas 4.5 min/m',
      rates: 'R_gas = the Pug cutting speed chart GAS_CUT_SPEED (mm/min) at THICKNESS — the per-band study (kept)',
      build: () => ({ expression: 'item.CUT_LENGTH / LOOKUP(machine.GAS_CUT_SPEED, item.THICKNESS)' }) },
    { no: 3, name: 'H-beam fit-up', op: 'CG-HBFIT', formula: 'CG_HBEAM_FITUP_TIME', fname: 'H-beam fit-up time',
      table: 'T = R_hfit × L / L_ref + Setup time (in between process); sample N × R_hfit × Wt / Wt_ref', sampleText: 'R_hfit 25 min/fit-up, Wt_ref 1000 kg, N 4, Wt 2500 kg → 250 min',
      rates: `R_hfit 25 min per fit-up, Wt_ref 1000 kg, N = HBFIT_JOINTS (flange-to-web joints), Wt = the segment's WEIGHT; setup ${R.HFIT_SETUP_MIN} min (Sample_Calculations H_Beam row)`,
      build: () => by([kg()], (w) => `item.HBFIT_JOINTS * ${R.HFIT_MIN} * ${w} / ${R.WT_REF_KG} + ${R.HFIT_SETUP_MIN}`) },
    { no: 4, name: 'SAW welding', op: 'CG-SAWWELD', formula: 'CG_SAW_WELD_TIME', fname: 'SAW welding time',
      table: 'T = L × R_saw(WT)', sampleText: 'WT 10 mm → R_saw 1.0 min/m',
      rates: 'R_saw 1.0 min/m flat (one band given; SAW_RATE chart kept, not read)',
      build: () => by([len('SAW_WELD_LENGTH')], (l) => `${l} * ${R.SAW_MIN_PER_M.toFixed(1)}`) },
    { no: 5, name: 'Line matching', op: 'CG-LINEMATCH', formula: 'CG_LINE_MATCH_TIME', fname: 'Line matching time',
      table: '(none — "same reasoning as H-beam"); sample N × R_lm × Wt / 1000', sampleText: 'R_lm 10 min/joint, N 6, Wt 1500 kg → 90 min',
      rates: 'R_lm 10 min per joint, N = LINEMATCH_JOINTS (girder line joints / segments), Wt = the segment\'s WEIGHT (was constant 576 min a segment)',
      build: () => by([kg()], (w) => `item.LINEMATCH_JOINTS * ${R.LM_MIN} * ${w} / ${R.WT_REF_KG}`) },
    { no: 6, name: 'CNC drilling', op: 'CG-CNCDRILL', formula: 'CG_CNC_DRILL_TIME', fname: 'CNC drilling time',
      table: 'T = N_holes × R_cncd(Thk, Dia)', sampleText: 'Thk 16 mm, Dia 24 mm → 0.35 min/hole',
      rates: 'R_cncd 0.35 min/hole flat (one band given; DRILL_TIME chart kept, not read)',
      build: () => ({ expression: `item.HOLES * ${R.CNCD_MIN_PER_HOLE}` }) },
    { no: 7, name: 'Manual drilling', op: 'CG-MANDRILL', formula: 'CG_MANUAL_DRILL_TIME', fname: 'Manual drilling time',
      table: 'T = [N_holes × R_mand(Thk, Dia)] + [N_transfer × R_transfer]', sampleText: 'Thk 12 mm, Dia 22 mm → R_mand 1.1 min/hole, R_transfer 1.5 min',
      rates: 'R_mand 1.1 min/hole flat, R_transfer 1.5 min (were machine MANUAL_DRILL_TIME 2.5 / MARK_TIME 0.5, kept, not read)',
      build: () => ({ expression: `item.HOLES * ${R.MAND_MIN_PER_HOLE} + item.HOLE_TRANSFERS * ${R.TRANSFER_MIN}` }) },
    ...[['CG-MANDRILL-TOP', 'CG_MANUAL_DRILL_TOP_TIME', 'HOLES_TOP', 'girder top holes'],
      ['CG-MANDRILL-BOTTOM', 'CG_MANUAL_DRILL_BOTTOM_TIME', 'HOLES_BOTTOM', 'girder bottom holes'],
      ['CG-MANDRILL-INNER', 'CG_MANUAL_DRILL_INNER_TIME', 'HOLES_INNER', 'inner splice own holes']].map(([op, formula, spec, what]) => ({
      no: 7, name: `Manual drilling — ${what}`, op, formula, fname: `Manual drilling time — ${what}`,
      table: 'T = [N_holes × R_mand(Thk, Dia)] (+ transfers, counted on the hole-transfer pass)', sampleText: 'R_mand 1.1 min/hole',
      rates: 'R_mand 1.1 min/hole flat; no transfer term (the hole-transfer pass, CG-MANDRILL, carries it)',
      build: () => ({ expression: `item.${spec} * ${R.MAND_MIN_PER_HOLE}` }) })),
    { no: 8, name: 'Stiffener fit-up', op: 'CG-STIFFFIT', formula: 'CG_STIFFENER_FITUP_TIME', fname: 'Stiffener fit-up time',
      table: '(none — "same structure as H-beam, lower rate"); sample N × R_sfit × Wt / 1000', sampleText: 'R_sfit 8 min/fit-up, N 30, Wt 1200 kg → 288 min',
      rates: 'USER DECISION 2026-10-01: R_sfit 8 min x each stiffener\'s own weight in t, at least 8 min a stiffener, summed over the face fitted before the flip = STIFFENER_FIT_TONNES x 8 (was 20 min a stiffener)',
      build: () => ({ expression: `item.STIFFENER_FIT_TONNES * ${R.SFIT_MIN}` }) },
    { no: 8, name: 'Stiffener fit-up after the flip', op: 'CG-STIFFFIT-2', formula: 'CG_STIFFENER_FITUP_2_TIME', fname: 'Stiffener fit-up time after the flip',
      table: 'as 8', sampleText: 'R_sfit 8 min/fit-up',
      rates: 'USER DECISION 2026-10-01: as #8 for the face fitted after the flip = STIFFENER_FIT_TONNES_AFTER_FLIP x 8',
      build: () => ({ expression: `item.STIFFENER_FIT_TONNES_AFTER_FLIP * ${R.SFIT_MIN}` }) },
    { no: 9, name: 'MIG welding', op: 'CG-MIGWELD', formula: 'CG_MIG_WELD_TIME', fname: 'MIG welding time',
      table: 'T = L × R_mig(WT)', sampleText: 'WT 6 mm → R_mig 1.6 min/m',
      rates: 'R_mig 1.6 min/m flat (one band given; MIG_RATE chart kept, not read)',
      build: () => by([len('MIG_WELD_LENGTH')], (l) => `${l} * ${R.MIG_MIN_PER_M}`) },
    { no: 9, name: 'MIG welding after the flip', op: 'CG-MIGWELD-2', formula: 'CG_MIG_WELD_2_TIME', fname: 'MIG welding time after the flip',
      table: 'as 9', sampleText: 'R_mig 1.6 min/m',
      rates: 'R_mig 1.6 min/m flat',
      build: () => by([len('MIG_WELD_LENGTH_AFTER_FLIP')], (l) => `${l} * ${R.MIG_MIN_PER_M}`) },
    { no: 10, name: 'Arc welding', op: 'CG-ARCWELD', formula: 'CG_ARC_WELD_TIME', fname: 'Arc welding time',
      table: 'T = L × R_arc(WT)', sampleText: 'WT 8 mm → R_arc 2.8 min/m',
      rates: 'R_arc 2.8 min/m flat (one band given; ARC_RATE chart was empty)',
      build: () => by([len('ARC_WELD_LENGTH')], (l) => `${l} * ${R.ARC_MIN_PER_M}`) },
    { no: 11, name: 'Trial assembly', op: 'CG-TRIALASM', formula: 'CG_TRIAL_ASSEMBLY_TIME', fname: 'Trial assembly time (by weight)',
      table: 'T = T_36_ref × span_length / 36 (×0.8 if span < 36 m, ×1.2 if span > 36 m)', sampleText: 'R_ta 60 min/assembly (sample uses Span_ref 12 m, contradicting the 36 m formula)',
      rates: `USER DECISION 2026-10-01: T_36_ref ${R.TA_36_REF_DAYS} days x ${R.DAY_MIN} min (Sample_Calculations; not the table's 60 min sample), span ${trial ? `${trial.spanMm} mm, factor ${trial.factor}` : '?'}; the span's T spread over its ${trial ? `${trial.spanKg} kg` : '?'} by piece WEIGHT`,
      build: () => trialExpr(false) },
    { no: 19, name: 'Dismantling', op: 'CG-DISMANTLE', formula: 'CG_DISMANTLE_TIME', fname: 'Dismantling time (by weight)',
      table: 'T = Trial_Assembly_time × 0.5', sampleText: '—',
      rates: '0.5 × trial assembly',
      build: () => trialExpr(true) },
    { no: 12, name: 'Stud welding', op: 'CG-STUDWELD', formula: 'CG_STUD_WELD_TIME', fname: 'Stud welding time',
      table: 'T = N_studs × R_stud', sampleText: 'R_stud 0.4 min/stud',
      rates: 'R_stud 0.4 min/stud (was machine STUD_TIME 25 s, kept, not read)',
      build: () => ({ expression: `item.STUDS * ${R.STUD_MIN}` }) },
    { no: 13, name: 'Blasting', op: 'CG-BLAST', formula: 'CG_BLAST_TIME', fname: 'Blasting time',
      table: 'T = Area × R_blast × No. of coatings + Manual blasting time', sampleText: 'R_blast 2.5 min/m²',
      rates: `R_blast 2.5 min/m², Area = SURFACE_AREA × ${R.FACES} faces, coats ${R.BLAST_COATS}, manual ${R.BLAST_MANUAL_MIN} min a piece (Sample_Calculations "~15-20 min")`,
      build: () => by([area()], (a) => `${a} * ${R.FACES} * ${R.BLAST_MIN_PER_M2} * ${R.BLAST_COATS} + ${R.BLAST_MANUAL_MIN}`) },
    { no: 14, name: 'Metallising', op: 'CG-METALLIZE', formula: 'CG_METALLIZE_TIME', fname: 'Metallising time',
      table: 'T = Area × R_metalising × No. of coatings', sampleText: 'CoatThk 100 µm → R_metal 4.7 min/m²',
      rates: `R_metal 4.7 min/m² flat (one band given; METAL_RATE 3.3 kept, not read), Area = SURFACE_AREA × ${R.FACES} faces, coats = METALLISE_COATS`,
      build: () => by([area()], (a) => `${a} * ${R.FACES} * ${R.METAL_MIN_PER_M2} * item.METALLISE_COATS`) },
    { no: 15, name: 'Painting', op: 'CG-PAINT', formula: 'CG_PAINT_TIME', fname: 'Painting time',
      table: 'T = Area × R_paint × N_coats + Drying time between coats', sampleText: 'R_paint 1.5 min/m², N_coats 2 → 450 min on 150 m²',
      rates: `R_paint 1.5 min/m² (PAINT_RATE 0.5 kept, not read), Area = SURFACE_AREA × ${R.FACES} faces, N_coats = PAINT_COATS (empty on KEPL), drying ${R.PAINT_DRYING_MIN}`,
      build: () => by([area()], (a) => `${a} * ${R.FACES} * ${R.PAINT_MIN_PER_M2} * item.PAINT_COATS + ${R.PAINT_DRYING_MIN}`) },
  ].map((e) => ({ ...e, description: `${SRC} #${e.no} ${e.name}: ${e.table}. ${e.rates}. Minutes per piece. Applied by cf_table_rates.mjs (2026-10-01).` }));
}

/** The machine-side values no formula reads any more (printed so nothing is lost). */
export const RETIRED_MACHINE_SPECS = ['SAW_RATE', 'MIG_RATE', 'ARC_RATE', 'DRILL_TIME', 'METAL_RATE', 'PAINT_RATE', 'STUD_TIME', 'MANUAL_DRILL_TIME', 'MARK_TIME', 'PIERCE_TIME'];
const KEPT_MACHINE_SPECS = ['CUT_SPEED', 'GAS_CUT_SPEED'];

/** New KEPL-only inputs. */
export const NEW_SPECS = [
  { code: 'HBFIT_JOINTS', name: 'H-beam fit-up joints', decimals: 0, measurementType: 'COUNT', op: 'CG-HBFIT',
    description: 'N of Master_Formulae #3 (H-beam fit-up): the flange-to-web fit-up joints on the segment. Supplied per order; derived for KEPL by cf_table_rates.mjs (2026-10-01) = its flange plates.' },
  { code: 'STIFFENER_FIT_TONNES', name: 'Stiffener fit-up tonnes (before the flip)', decimals: 3, measurementType: null, op: 'CG-STIFFFIT',
    description: 'Master_Formulae #8 stiffener fit-up, user decision 2026-10-01: the stiffeners fitted on the first web face, each counted at its own weight in tonnes but at least 1 t (time = this x 8 min, so at least 8 min a stiffener). Supplied per order; derived for KEPL by cf_table_rates.mjs.' },
  { code: 'STIFFENER_FIT_TONNES_AFTER_FLIP', name: 'Stiffener fit-up tonnes (after the flip)', decimals: 3, measurementType: null, op: 'CG-STIFFFIT-2',
    description: 'As STIFFENER_FIT_TONNES, for the stiffeners fitted on the other web face after the flip. Supplied per order; derived for KEPL by cf_table_rates.mjs.' },
  { code: 'LINEMATCH_JOINTS', name: 'Line matching joints', decimals: 3, measurementType: 'COUNT', op: 'CG-LINEMATCH',
    description: 'N of Master_Formulae #5 (line matching), per segment: the girder line\'s joints shared over its segments. Supplied per order; derived for KEPL by cf_table_rates.mjs (2026-10-01) = (segments - 1) / segments.' },
];

const isFlange = (n) => /flange/i.test(n.name);

const isStiffener = (n) => /stiffener/i.test(n.name);
/** Long edge and thickness of a plate node (LENGTH and WIDTH are swapped on some rows) — as cf_kepl_quantities. */
function plate(n) {
  const L = n.vals?.LENGTH;
  const W = n.vals?.WIDTH;
  const T = n.vals?.THICKNESS;
  if (L == null || W == null || T == null) return null;
  return { long: Math.max(L, W), t: T };
}

/**
 * HBFIT_JOINTS, LINEMATCH_JOINTS and STIFFENER_FIT_TONNES(_AFTER_FLIP) per segment item, from the line's
 * own tree. weightOf(node) -> kg (the piece's own WEIGHT). The stiffeners are split over the two faces
 * exactly as cf_kepl_quantities splits STIFFENERS: longest first, alternating, even positions before the flip.
 */
export function deriveInputs(root, weightOf = (n) => n.vals?.WEIGHT ?? null) {
  const byItem = new Map(); // itemId -> { name, values: Map(code -> { value, rule }) }
  const notes = [];
  const put = (n, code, value, rule) => {
    if (!byItem.has(n.id)) byItem.set(n.id, { id: n.id, name: n.name, values: new Map() });
    const had = byItem.get(n.id).values.get(code);
    if (had && had.value !== value) { notes.push(`${n.name} (item ${n.id}) ${code}: ${had.value} vs ${value} — kept ${had.value}`); return; }
    byItem.get(n.id).values.set(code, { value, rule });
  };
  const walk = (n) => {
    if (n.cls === 'GIRDER_SEGMENT') {
      const flanges = n.children.filter(isFlange).reduce((s, k) => s + Number(k.quantity), 0);
      if (flanges) put(n, 'HBFIT_JOINTS', flanges, 'flange-to-web joints = its flange plates');
      else notes.push(`${n.name} (item ${n.id}): no flange plates under it — HBFIT_JOINTS left out.`);
      const pieces = [];
      let missing = false;
      for (const k of n.children.filter(isStiffener)) {
        const p = plate(k);
        const kg = weightOf(k);
        if (!p || kg == null) { missing = true; continue; }
        for (let i = 0; i < Number(k.quantity); i++) pieces.push({ ...p, kg: Number(kg) });
      }
      if (missing) notes.push(`${n.name} (item ${n.id}): a stiffener has no size or WEIGHT — STIFFENER_FIT_TONNES left out.`);
      else if (pieces.length) {
        pieces.sort((a, b) => b.long - a.long || b.t - a.t);
        const before = pieces.filter((_, i) => i % 2 === 0);
        const after = pieces.filter((_, i) => i % 2 === 1);
        const face = (ps) => r3(sample.stiffFitTonnes(ps.map((x) => x.kg)));
        const rule = (ps) => `${ps.length} stiffeners on the face, each max(1 t, own weight); heaviest ${Math.max(...ps.map((x) => x.kg)).toFixed(1)} kg`;
        put(n, 'STIFFENER_FIT_TONNES', face(before), rule(before));
        if (after.length) put(n, 'STIFFENER_FIT_TONNES_AFTER_FLIP', face(after), rule(after));
      }
    }
    if (n.cls === 'GIRDER_LINE') {
      const segs = n.children.filter((k) => k.cls === 'GIRDER_SEGMENT');
      const count = segs.reduce((s, k) => s + Number(k.quantity), 0);
      if (count >= 1) for (const s of segs) put(s, 'LINEMATCH_JOINTS', r3((count - 1) / count), `girder line joints / segments = (${count} - 1) / ${count}`);
    }
    n.children.forEach(walk);
  };
  walk(root);
  return { byItem, notes };
}

/* ===========================================================================
 * Read (SELECTs only)
 * ======================================================================== */

async function loadSetup(db, companyId, entries) {
  const q = (sql, p) => db.query(sql, p).then(([r]) => r);
  const opCodes = [...new Set(entries.map((e) => e.op))];
  const fCodes = [...new Set([...entries.map((e) => e.formula), 'CG_ARC_WELD_FLAT_TIME'])];
  const specCodes = ['SAW_WELD_LENGTH', 'MIG_WELD_LENGTH', 'MIG_WELD_LENGTH_AFTER_FLIP', 'ARC_WELD_LENGTH', 'SURFACE_AREA', 'WEIGHT', 'SPAN_LENGTH',
    ...NEW_SPECS.map((s) => s.code), ...RETIRED_MACHINE_SPECS, ...KEPT_MACHINE_SPECS];
  const [ops, formulas, rules, specs, segNodes] = await Promise.all([
    q('SELECT id, code, name FROM cf_operations WHERE company_id = ? AND deleted_at IS NULL AND code IN (?)', [companyId, opCodes]),
    q('SELECT id, code, name, expression, description FROM cf_formulas WHERE company_id = ? AND deleted_at IS NULL AND code IN (?)', [companyId, fCodes]),
    q(`SELECT r.*, o.code AS op_code, wf.code AS work_code, wf.expression AS work_expr, n.name AS node_name
         FROM cf_operation_machine_rules r JOIN cf_operations o ON o.id = r.operation_id
         LEFT JOIN cf_formulas wf ON wf.id = r.work_formula_id
         LEFT JOIN cf_classification_nodes n ON r.subject_type = 'classification' AND n.id = r.subject_id
        WHERE r.company_id = ? AND r.deleted_at IS NULL AND o.code IN (?) ORDER BY r.id`, [companyId, opCodes]),
    q('SELECT * FROM cf_specifications WHERE company_id = ? AND deleted_at IS NULL AND code IN (?)', [companyId, specCodes]),
    q("SELECT id, code, name FROM cf_classification_nodes WHERE company_id = ? AND deleted_at IS NULL AND code = 'GIRDER_SEGMENT' AND scope <> 'machine' ORDER BY depth DESC", [companyId]),
  ]);
  const specIds = specs.map((s) => s.id);
  const [assignments, chartValues] = await Promise.all([
    specIds.length ? q(`SELECT a.*, s.code AS spec_code FROM cf_spec_assignments a JOIN cf_specifications s ON s.id = a.specification_id
                         WHERE a.company_id = ? AND a.deleted_at IS NULL AND a.capture_at = 'item' AND a.specification_id IN (?)`, [companyId, specIds]) : [],
    q(`SELECT v.subject_type, v.subject_id, v.value_number, v.value_json, v.source, s.code, s.data_type, s.table_config, s.default_uom,
              COALESCE(n.name, m.code) AS subject_name, m.classification_id AS machine_cls
         FROM cf_spec_values v JOIN cf_specifications s ON s.id = v.specification_id
         LEFT JOIN cf_classification_nodes n ON v.subject_type = 'classification' AND n.id = v.subject_id
         LEFT JOIN cf_machines m ON v.subject_type = 'machine' AND m.id = v.subject_id AND m.deleted_at IS NULL AND m.status = 'active'
        WHERE v.company_id = ? AND v.deleted_at IS NULL AND v.subject_type IN ('classification', 'machine') AND s.company_id = ? AND s.code IN (?)`,
      [companyId, companyId, [...RETIRED_MACHINE_SPECS, ...KEPT_MACHINE_SPECS]]),
  ]);
  return {
    ops: new Map(ops.map((o) => [o.code, o])), formulas: new Map(formulas.map((f) => [f.code, f])), rules,
    specs: new Map(specs.map((s) => [s.code, s])), segNode: segNodes[0] ?? null, assignments, chartValues,
  };
}

/** Machine readers for the expressions that read machine.X (CNC / gas cutting): the type's value, else the machines'. */
async function machineSide(db, companyId, setup, opCodes) {
  const ruleNodes = new Map(); // op -> node ids
  for (const r of setup.rules) if (opCodes.includes(r.op_code) && r.eligible && r.subject_type === 'classification') {
    if (!ruleNodes.has(r.op_code)) ruleNodes.set(r.op_code, []);
    ruleNodes.get(r.op_code).push(r.subject_id);
  }
  const [nodes] = await db.query('SELECT id, parent_id FROM cf_classification_nodes WHERE company_id = ? AND deleted_at IS NULL', [companyId]);
  const parentOf = new Map(nodes.map((n) => [n.id, n.parent_id]));
  const under = (nodeId, top) => { for (let n = nodeId, h = 0; n != null && h < 10; n = parentOf.get(n), h++) if (n === top) return true; return false; };
  const parse = (v) => (v == null ? null : typeof v === 'string' ? JSON.parse(v) : v);
  const entryOf = (row) => ({ raw: row.data_type === 'table' ? parse(row.value_json) : row.value_number == null ? null : Number(row.value_number), dataType: row.data_type, optionValue: null, display: '', tableConfig: row.data_type === 'table' ? parse(row.table_config) : null });
  return (opCode) => {
    const out = [];
    for (const top of ruleNodes.get(opCode) ?? []) {
      const typeMap = new Map();
      for (const v of setup.chartValues) if (v.subject_type === 'classification' && v.subject_id === top) typeMap.set(v.code, entryOf(v));
      out.push({ basis: 'type', readers: opsSvc.valueReaders(typeMap) });
      const machines = new Map();
      for (const v of setup.chartValues) {
        if (v.subject_type !== 'machine' || v.machine_cls == null || !under(v.machine_cls, top)) continue;
        if (!machines.has(v.subject_id)) machines.set(v.subject_id, { name: v.subject_name, map: new Map(typeMap) });
        machines.get(v.subject_id).map.set(v.code, entryOf(v));
      }
      for (const m of machines.values()) out.push({ basis: 'machine', name: m.name, readers: opsSvc.valueReaders(m.map) });
    }
    return out;
  };
}

async function releaseByOp(db, companyId, releaseId) {
  if (!releaseId) return null;
  const [rows] = await db.query(
    `SELECT o.code, COUNT(*) AS steps, SUM(s.est_minutes IS NOT NULL) AS timed, COALESCE(SUM(s.est_minutes), 0) AS minutes
       FROM cf_production_steps s JOIN cf_production_items pi ON pi.id = s.production_item_id
       JOIN cf_operations o ON o.id = s.operation_id
      WHERE s.company_id = ? AND pi.release_id = ? AND s.deleted_at IS NULL GROUP BY o.code`, [companyId, releaseId]);
  return new Map(rows.map((r) => [r.code, { steps: Number(r.steps), timed: Number(r.timed ?? 0), minutes: Number(r.minutes) }]));
}

/* ===========================================================================
 * Plan
 * ======================================================================== */

function planSetup(setup, entries, companyId) {
  const A = [];
  const exprOf = new Map(); // op -> { code, expression }
  const fmtRule = (r) => (!r ? 'no rule' : r.work_minutes != null ? `${Number(r.work_minutes)} min` : r.work_code ? `${r.work_code}: ${r.work_expr}` : 'no work time');
  const lookupId = async (db, table, code) => {
    const [[r]] = await db.query(`SELECT id FROM ${table} WHERE company_id = ? AND code = ? AND deleted_at IS NULL`, [companyId, code]);
    if (!r) throw new Error(`${table} ${code} is missing at apply time`);
    return r.id;
  };

  // New specs + their assignment rule on the Girder segment classification.
  for (const s of NEW_SPECS) {
    const have = setup.specs.get(s.code);
    if (!have) A.push({ area: 'Specification', what: s.code, before: 'missing', after: `${s.name} (number, ${s.decimals} dp)`, status: 'change',
      run: async (x) => { await specSvc.createSpec(x.db, x.c, { code: s.code, name: s.name, dataType: 'number', decimals: s.decimals, measurementType: s.measurementType, description: s.description }); } });
    else A.push({ area: 'Specification', what: s.code, before: 'exists', after: 'exists', status: 'same' });
    if (!setup.segNode) { A.push({ area: 'Spec rule', what: `${s.code} on Girder segment`, before: '—', after: '(not changed)', status: 'blocked', why: 'no GIRDER_SEGMENT classification' }); continue; }
    const a = have ? setup.assignments.find((x) => x.specification_id === have.id && x.subject_type === 'classification' && Number(x.subject_id) === setup.segNode.id) : null;
    if (a && a.is_applicable && a.value_rule === 'entered') A.push({ area: 'Spec rule', what: `${s.code} on ${setup.segNode.name}`, before: 'entered', after: 'entered', status: 'same' });
    else if (a) A.push({ area: 'Spec rule', what: `${s.code} on ${setup.segNode.name}`, before: `${a.is_applicable ? a.value_rule : 'switched off'}`, after: 'entered', status: 'change',
      run: async (x) => { await ruleSvc.updateRule(x.db, x.c, a.id, { valueRule: 'entered', isApplicable: true, formulaId: null }); } });
    else A.push({ area: 'Spec rule', what: `${s.code} on ${setup.segNode.name}`, before: 'none', after: 'entered (assignable on every girder segment)', status: 'change',
      run: async (x) => { await ruleSvc.createRule(x.db, x.c, { specificationId: await lookupId(x.db, 'cf_specifications', s.code), subjectType: 'classification', subjectId: setup.segNode.id, captureAt: 'item', valueRule: 'entered', isRequired: false }); } });
  }

  for (const e of entries) {
    const op = setup.ops.get(e.op);
    const rules = setup.rules.filter((r) => r.op_code === e.op && r.eligible);
    e.oldRule = rules.length ? rules.map(fmtRule).join(' | ') : (op ? 'no eligible rule' : 'operation missing');
    if (!op) { A.push({ area: 'Formula', what: `${e.formula} (${e.op})`, before: 'operation missing', after: '(not changed)', status: 'blocked', why: `no operation ${e.op} in this company` }); continue; }
    const b = e.build();
    if (b.why) { A.push({ area: 'Formula', what: e.formula, before: setup.formulas.get(e.formula)?.expression ?? 'missing', after: '(not changed)', status: 'blocked', why: b.why }); continue; }
    e.expression = b.expression;
    const f = setup.formulas.get(e.formula);
    if (!f) A.push({ area: 'Formula', what: e.formula, before: 'missing', after: e.expression, status: 'change', run: async (x) => { await formulaSvc.createFormula(x.db, x.c, { code: e.formula, name: e.fname, expression: e.expression, description: e.description }); } });
    else if (norm(f.expression) !== norm(e.expression) || norm(f.description) !== norm(e.description)) A.push({ area: 'Formula', what: e.formula, before: f.expression, after: e.expression, status: 'change', run: async (x) => { await formulaSvc.updateFormula(x.db, x.c, f.id, { expression: e.expression, description: e.description }); } });
    else A.push({ area: 'Formula', what: e.formula, before: f.expression, after: e.expression, status: 'same' });
    if (!rules.length) { A.push({ area: 'Machine rule', what: e.op, before: 'no eligible rule', after: '(not changed)', status: 'blocked', why: `no machine type is eligible for ${e.op}` }); continue; }
    const parsed = parseFormula(e.expression);
    const machineRefs = [...(parsed.machineRefs ?? []), ...(parsed.lookupRefs ?? []).filter((x) => x.role === 'machine').map((x) => x.code)];
    exprOf.set(e.op, { code: e.formula, expression: e.expression, machineRefs });
    for (const r of rules) {
      const what = `${e.op} on ${r.subject_type === 'machine' ? `machine ${r.subject_id}` : r.node_name}`;
      const same = r.work_code === e.formula && r.work_minutes == null && norm(r.notes) === norm(e.description);
      if (same) { A.push({ area: 'Machine rule', what, before: fmtRule(r), after: e.formula, status: 'same' }); continue; }
      A.push({ area: 'Machine rule', what, before: fmtRule(r), after: e.formula, status: 'change',
        run: async (x) => { await opsSvc.updateTimingRule(x.db, x.c, r.id, { workFormulaId: await lookupId(x.db, 'cf_formulas', e.formula), workMinutes: null, notes: e.description }); } });
    }
  }
  return { actions: A, exprOf };
}

/** The derived inputs to write: only on pieces whose flow runs the operation reading them. */
function planValues(data, setup) {
  const weightOf = (n) => { const r = data.resolutions.get(n.id); const w = r ? effectiveByCode(r).get('WEIGHT')?.raw : null; return w != null ? Number(w) : n.vals?.WEIGHT ?? null; };
  const { byItem, notes } = deriveInputs(data.tree.root, weightOf);
  const opsOf = new Map(); // itemId -> Set(op code)
  const piecesOf = new Map();
  for (const n of data.nodes) {
    if (!opsOf.has(n.id)) opsOf.set(n.id, new Set());
    for (const o of data.flowOps.get(n.flow?.id)?.values() ?? []) opsOf.get(n.id).add(o.code);
    piecesOf.set(n.id, (piecesOf.get(n.id) ?? 0) + Number(n.total));
  }
  const specId = new Map(NEW_SPECS.map((s) => [s.code, setup.specs.get(s.code)?.id ?? null]));
  const writes = [];
  for (const rec of byItem.values()) {
    for (const [code, { value, rule }] of rec.values) {
      const s = NEW_SPECS.find((x) => x.code === code);
      if (!opsOf.get(rec.id)?.has(s.op)) continue;
      const own = specId.get(code) ? data.ownOf.get(`${rec.id}:${code}`) : null;
      const same = own && own.value != null && Math.abs(own.value - value) < 1e-6 && own.source === SOURCE;
      writes.push({ itemId: rec.id, name: rec.name, code, value, rule, pieces: piecesOf.get(rec.id) ?? 0, before: own?.value ?? null, change: !same });
    }
  }
  return { writes, notes };
}

/* ===========================================================================
 * The entry point (the test calls it) and the CLI
 * ======================================================================== */

/**
 * opts: { lineId?, commit?, userId? }. Plans with SELECTs only; with commit,
 * applies in the CALLER's transaction.
 */
export async function run(db, companyId, opts = {}) {
  const c = { companyId, userId: opts.userId ?? null };
  const data = await load(db, companyId, opts.lineId ?? null);

  // The span: its weight and length for trial assembly.
  const spanRes = data.resolutions.get(data.tree.root.id);
  const spanEff = spanRes ? effectiveByCode(spanRes) : new Map();
  const spanKgRaw = Number(spanEff.get('WEIGHT')?.raw ?? data.tree.root.vals.WEIGHT ?? NaN);
  const spanMmRaw = spanEff.get('SPAN_LENGTH')?.raw ?? data.tree.root.vals.SPAN_LENGTH ?? null;
  const spanMm = spanMmRaw != null ? Number(spanMmRaw) : DEFAULT_SPAN_MM;
  const trial = Number.isFinite(spanKgRaw) && spanKgRaw > 0 ? { spanKg: Number(spanKgRaw.toFixed(2)), spanMm, factor: trialFactor(spanMm), fromBoq: spanMmRaw == null } : null;

  const units = {};
  const pre = await loadSetup(db, companyId, tableEntries({}, trial));
  for (const [code, s] of pre.specs) units[code] = s.default_uom;
  const entries = tableEntries(units, trial);
  const setup = pre;
  const { actions, exprOf } = planSetup(setup, entries, companyId);
  const vals = planValues(data, setup);
  const valueChanges = vals.writes.filter((w) => w.change);

  // Projection: the changed operations with their NEW formulas, the derived inputs laid over the pieces.
  const noMachine = opsSvc.valueReaders(new Map());
  const machinesFor = await machineSide(db, companyId, setup, [...exprOf].filter(([, e]) => e.machineRefs.length).map(([op]) => op));
  const estimateFor = (o, readers) => {
    const e = exprOf.get(o.code);
    if (!e) return null;
    const rule = { work: { minutes: null, formula: { code: e.code, expression: e.expression } }, setup: null };
    const evalWith = (machine) => opsSvc.evaluateRuleTimes(rule, { item: readers, machine });
    let best = null;
    let problem = null;
    if (!e.machineRefs.length) {
      const r = evalWith(noMachine);
      if (r.work.minutes != null) best = r; else problem = r;
    } else {
      const cands = machinesFor(o.code);
      const type = cands.find((x) => x.basis === 'type');
      const rt = type ? evalWith(type.readers) : null;
      if (rt && rt.work.minutes != null) best = rt;
      else {
        problem = rt;
        for (const m of cands.filter((x) => x.basis === 'machine')) {
          const r = evalWith(m.readers);
          if (r.work.minutes != null) { if (!best || r.work.minutes > best.work.minutes) best = r; } else problem ??= r;
        }
      }
    }
    if (best) return { work: Number(best.work.minutes.toFixed(3)), setup: 0, missing: null };
    const w = problem?.work;
    return { work: null, setup: null, missing: w?.missing?.length ? `Needs ${w.missing.join(', ')}.` : `The formula ${e.code} cannot be worked out: ${w?.error ?? 'no machine value'}.` };
  };
  const before = await lineTimes(db, companyId, data.line);
  const projected = await projectTimes(db, companyId, data, vals.writes.map((w) => ({ ...w })), { estimateFor });
  const rel = data.release;
  const relOps = rel ? await releaseByOp(db, companyId, rel.id) : null;

  // Did KEPL's computed times change against what the release carries?
  const diffs = [];
  if (rel) {
    for (const op of exprOf.keys()) {
      const pj = projected.byCode.get(op);
      if (!pj) continue; // the line's flows do not run it
      const rm = relOps.get(op);
      const relMin = rm?.minutes ?? 0;
      const relUntimed = rm ? rm.steps - rm.timed : 0;
      const pjUntimed = projected.untimed.get(op)?.pieces ?? 0;
      if (Math.abs((pj.minutes ?? 0) - relMin) > 1 || (relUntimed > 0) !== (pjUntimed > 0)) diffs.push({ op, release: relMin, projected: pj.minutes ?? 0 });
    }
  }
  const setupChanges = actions.filter((a) => a.status === 'change');
  const needRelease = !!rel && (diffs.length > 0 || valueChanges.length > 0);
  const stopped = needRelease && (rel.started || rel.issued > 1e-9)
    ? `Line ${data.line.line_no} of ${data.line.order_code} has started (${rel.started} step(s) begun${rel.issued > 1e-9 ? `, material issued: ${rel.issued}` : ''}) — release ${rel.id} cannot be taken back. Nothing was written.`
    : null;
  const out = { data, trial, entries, actions, setupChanges, exprOf, values: vals, valueChanges, before, projected, relOps, diffs, needRelease, stopped,
    setup, applied: 0, written: 0, tookBack: null, released: null, newRelOps: null, after: null };
  if (!opts.commit) return out;
  if (stopped) { const e = new Error(stopped); e.code = 'STARTED'; throw e; }
  if (!setupChanges.length && !needRelease && !(valueChanges.length && !rel)) return out;

  // 1. Specs, assignment rules, formulas, machine rules.
  for (const a of setupChanges) {
    try { await a.run({ db, c }); } catch (e) { e.message = `${a.area} ${a.what}: ${e.message}${e.problems ? ` — ${JSON.stringify(e.problems)}` : ''}`; throw e; }
    out.applied += 1;
  }
  // 2. Take back -> derived inputs (with history) -> release again; or just the inputs on an unreleased line.
  const writeValues = async () => {
    if (!valueChanges.length) return;
    const { byCode } = await valueSvc.loadSpecs(db, companyId, NEW_SPECS.map((s) => ({ specCode: s.code })));
    const bySubject = new Map();
    for (const w of valueChanges) { if (!bySubject.has(w.itemId)) bySubject.set(w.itemId, []); bySubject.get(w.itemId).push(w); }
    for (const [id, ws] of bySubject) {
      const typed = [];
      for (const w of ws) {
        const spec = byCode.get(w.code);
        const { typed: t, problem } = await valueSvc.coerce(db, companyId, spec, w.value);
        if (problem) throw new Error(`${w.code} on item ${id}: ${problem}`);
        typed.push({ spec, typed: t, source: SOURCE });
      }
      out.written += (await valueSvc.upsertValues(db, c, 'master', id, typed)).length;
    }
  };
  if (needRelease) {
    const rr = await reRelease(db, c, data, writeValues);
    out.tookBack = rr.tookBack;
    out.released = rr.released;
    out.newRelOps = await releaseByOp(db, companyId, rr.released.id);
  } else if (!rel) await writeValues();
  out.after = await lineTimes(db, companyId, data.line);
  return out;
}

const pad = (s, n) => { const t = String(s ?? ''); return t.length > n ? `${t.slice(0, n - 1)}…` : t.padEnd(n); };
const h = (m) => (m == null ? '—' : (m / 60).toFixed(1));

function chartText(v) {
  if (v.data_type !== 'table') return `${Number(v.value_number)}${v.default_uom ? ` ${v.default_uom}` : ''}`;
  const j = typeof v.value_json === 'string' ? JSON.parse(v.value_json) : v.value_json;
  if (!j) return '(empty)';
  if (j.y) return `x(thk)=[${j.x}] y(dia)=[${j.y}] v=${JSON.stringify(j.v)} ${v.default_uom ?? ''}`;
  return `x=[${j.x}] v=[${j.v}] ${v.default_uom ?? ''}`;
}

export function printReport(out, { commit }) {
  const say = (...a) => console.log(...a);
  const { data, entries, actions, before, projected, relOps, diffs, released, tookBack, newRelOps, trial, values } = out;
  const L = data.line;
  const rel = data.release;
  say(`line ${L.id} (${L.order_code} line ${L.line_no}, x${Number(L.quantity)}) — ${rel ? `RELEASED (release ${rel.id}: ${rel.steps} steps, ${rel.timed} timed, ${h(rel.minutes)} h; started ${rel.started}, issued ${rel.issued}, active reservations ${rel.reservations})` : L.locked_at ? 'LOCKED, not released' : 'live'}`);
  if (trial) say(`span for trial assembly: ${trial.spanKg.toLocaleString('en-US')} kg, ${trial.spanMm.toLocaleString('en-US')} mm${trial.fromBoq ? ' (no SPAN_LENGTH on the span — the BOQ 59.3 m)' : ''}, factor ${trial.factor}: T = ${R.TA_36_REF_DAYS} x ${R.DAY_MIN} x ${(trial.spanMm / R.TA_REF_MM).toFixed(4)} x ${trial.factor} = ${sample.trial(trial.spanMm).toFixed(1)} min = ${(sample.trial(trial.spanMm) / 60).toFixed(1)} h a span (user decision; the table's 60 min sample would give ${sample.trial(trial.spanMm, R.TA_SAMPLE_MIN).toFixed(1)} min)`);

  say('\nMACHINE CHARTS / RATES no formula reads any more (left on the machines as they are — recorded here):');
  const byCode = new Map();
  for (const v of out.setup.chartValues) { if (!byCode.has(v.code)) byCode.set(v.code, []); byCode.get(v.code).push(v); }
  for (const code of [...RETIRED_MACHINE_SPECS, ...KEPT_MACHINE_SPECS]) {
    const vs = byCode.get(code) ?? [];
    const types = vs.filter((v) => v.subject_type === 'classification');
    const machines = vs.filter((v) => v.subject_type === 'machine');
    const kept = KEPT_MACHINE_SPECS.includes(code) ? ' [STILL READ]' : '';
    if (!vs.length) { say(`  ${pad(code, 18)} (no values)${kept}`); continue; }
    for (const t of types) say(`  ${pad(code, 18)} ${pad(t.subject_name, 26)} ${chartText(t)}${kept}`);
    const distinct = [...new Set(machines.map(chartText))];
    if (machines.length) say(`  ${pad(code, 18)} ${pad(`${machines.length} machine(s)`, 26)} ${distinct.length === 1 ? distinct[0] : `${distinct.length} different: ${distinct.slice(0, 2).join(' | ')}`}${kept}`);
  }

  say('\nCHANGES:');
  const order = { change: 0, blocked: 1, same: 2 };
  for (const a of [...actions].sort((x, y) => order[x.status] - order[y.status])) {
    if (a.status === 'same') continue;
    say(`  ${pad(a.area, 13)} ${pad(a.what, 42)} ${a.status === 'change' ? (commit ? 'CHANGED' : 'would change') : 'BLOCKED'}${a.status === 'blocked' ? ` — ${a.why}` : ''}`);
  }
  const same = actions.filter((a) => a.status === 'same').length;
  if (same) say(`  (${same} already so)`);
  say(`\nKEPL-ONLY INPUTS (${values.writes.length} on segment rows; ${out.valueChanges.length} to write):`);
  const byIn = new Map();
  for (const w of values.writes) { if (!byIn.has(w.code)) byIn.set(w.code, []); byIn.get(w.code).push(w); }
  for (const [code, ws] of byIn) say(`  ${pad(code, 32)} ${pad(`${ws.length} rows / ${ws.reduce((s, w) => s + w.pieces, 0)} pcs`, 20)} value ${[...new Set(ws.map((w) => w.value))].join(' / ')} — ${ws[0].rule}; ${ws.filter((w) => w.change).length} to write`);
  for (const n of values.notes) say(`  note: ${n}`);

  say('\nPER OPERATION (table formula · old formula · new formula):');
  const oldH = (op) => (rel ? (relOps.get(op)?.timed ? relOps.get(op).minutes : null) : before.byCode.get(op)?.minutes ?? null);
  for (const e of entries) {
    say(`  #${pad(e.no, 3)}${pad(`${e.name} (${e.op})`, 52)} old ${pad(h(oldH(e.op)), 8)} -> new ${h(projected.byCode.get(e.op)?.minutes)} h`);
    say(`        table: ${e.table}   [sample: ${e.sampleText}]`);
    say(`        old:   ${e.oldRule ?? '—'}`);
    say(`        new:   ${e.expression ? `${e.formula} = ${e.expression}` : '(not changed)'}`);
  }

  // The summary — kept last so `| Select-Object -Last 40` shows it.
  const codes = [...new Set([...before.byCode.keys(), ...projected.byCode.keys(), ...(relOps?.keys() ?? []), ...(newRelOps?.keys() ?? [])])].sort();
  say(`\nHOURS, whole line — ${rel ? 'release now' : 'Times grid now'} -> projected${newRelOps ? ' -> NEW release' : ''} (* = operation this script times):`);
  for (const code of codes) {
    const mark = out.exprOf.has(code) ? '*' : ' ';
    const o = rel ? (relOps.get(code)?.timed ? relOps.get(code).minutes : null) : before.byCode.get(code)?.minutes;
    const pj = projected.byCode.get(code)?.minutes;
    const nr = newRelOps ? (newRelOps.get(code)?.timed ? newRelOps.get(code).minutes : null) : undefined;
    if (o == null && pj == null && !nr) continue;
    say(`${mark} ${pad(code, 20)} ${pad(h(o), 9)} ${pad(h(pj), 9)} ${newRelOps ? h(nr) : ''}`);
  }
  const relAll = relOps ? [...relOps.values()].reduce((s, r) => s + r.minutes, 0) : before.all;
  const newAll = newRelOps ? [...newRelOps.values()].reduce((s, r) => s + r.minutes, 0) : null;
  say(`  ${pad('ALL', 20)} ${pad(h(relAll), 9)} ${pad(h(projected.all), 9)} ${newRelOps ? h(newAll) : ''}`);
  const stillUntimed = [...projected.untimed].filter(([code]) => out.exprOf.has(code)).map(([code, u]) => `${code} ${u.pieces}`);
  if (stillUntimed.length) say(`  untimed piece-passes (no input yet): ${stillUntimed.join(', ')}`);

  const nBlocked = actions.filter((a) => a.status === 'blocked').length;
  if (nBlocked) say(`${nBlocked} BLOCKED (see CHANGES).`);
  if (out.stopped) say(`STOP: ${out.stopped}`);
  else if (!out.setupChanges.length && !out.needRelease && !out.valueChanges.length) say('Nothing to change: formulas, rules and inputs are already so and the release carries these times.');
  else if (!commit) {
    say(`--commit would: write ${out.setupChanges.length} spec/rule/formula change(s), ${out.valueChanges.length} KEPL input(s); ${rel ? (out.needRelease ? `take back release ${rel.id} (nothing started or issued${rel.reservations ? `; ${rel.reservations} active reservation(s) let go — reserve again after` : ''}) and release again (${diffs.length} operation(s) change)` : 'leave the release alone (it already carries these times)') : 'the line is not released'}.`);
  }
  if (commit && (out.applied || out.written || tookBack)) {
    say(`Wrote ${out.applied} spec/rule/formula change(s) and ${out.written} KEPL input(s), with history.`);
    if (tookBack) say(`Took back release ${tookBack.id} (${tookBack.steps} steps, ${tookBack.timed} timed, ${h(tookBack.minutes)} h${tookBack.reservations ? `; ${tookBack.reservations} reservation(s) let go — reserve again` : ''}).`);
    if (released) say(`Released again: release ${released.id} — ${released.steps} steps, ${released.timed} timed, ${h(released.minutes)} h.`);
    else if (rel) say(`Release ${rel.id} left alone (its times already match).`);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const COMMIT = argv.includes('--commit');
  const li = argv.indexOf('--line');
  const LINE = li >= 0 ? Number(argv[li + 1]) : null;
  const COMPANY = Number(process.env.CF_BRIDGE_COMPANY ?? 2);
  const USER = process.env.CF_BRIDGE_USER ? Number(process.env.CF_BRIDGE_USER) : null;
  const where = /^(localhost|127\.0\.0\.1|::1)?$/i.test(process.env.DB_HOST ?? '') ? 'local' : 'PRODUCTION';
  console.log(`${where}, company ${COMPANY} — ${COMMIT ? 'WRITING (formulas/rules -> take back -> inputs -> release again if times changed, one transaction)' : 'dry run (SELECTs only, read-only transaction)'}`);
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
    if (COMMIT) { await conn.commit(); console.log(out.applied || out.written || out.tookBack ? '\nCommitted.' : '\nNothing to commit.'); } else await conn.query('ROLLBACK');
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
