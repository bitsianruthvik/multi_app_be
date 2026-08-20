/**
 * 04-shopfloor.mjs — the shop: machine types, machines, operations, flows, rules.
 *
 * WHERE THIS DATA COMES FROM. Not from imagination. Placebo (company 30005) was
 * wiped on 2026-08-20 and restored locally as the `placebo_old` schema; every
 * formula, every step sequence, every crane move and every operation default in
 * this file was read out of that schema and copied CHARACTER FOR CHARACTER. The
 * formulas in particular are careful work — `IF(item.x > 0, item.x, op.x)`
 * everywhere so a missing measurement falls back to an operation default rather
 * than planning a zero-length task — and reformatting them would be a way of
 * changing them without noticing. They are string literals here and they are not
 * to be "tidied".
 *
 * WHAT IS DELIBERATELY NOT REBUILT:
 *   `FT1`   — a scratch flow with no steps.
 *   `VSPGF` — a flat 7-step variant of SEG from the VSP project. SEG supersedes
 *             it; it was already `active = 0` in the old data.
 *
 * ── THE ONE THING THAT CHANGED: PER-MACHINE WIP AREAS ───────────────────────
 *
 * In the old data 15 of the 18 machines shared one pooled area (`MACH-ON`).
 * `openOrMoveWipOnStart` puts a task's WIP piece in `fab_resources
 * .stock_location_id` and moves it to the next machine's area at the next step —
 * so when fifteen machines name the same area, every one of those moves is a
 * no-op and per-machine work-in-process is structurally invisible. Here every
 * machine gets its own `WIP-M<id>`, minted by the helper that owns that naming
 * (`provisionMachineWipLocation`) rather than by an INSERT written out again.
 *
 * The canonical link is written too. `fab_resource_stock_areas` is supposed to
 * be the machine→area table, but nothing except a one-off backfill has ever
 * written it, so machines created by any other path have no row at all. Going
 * through `syncResourceAreaLink` gets the row, gets the old link retired, and
 * keeps this seed honest against the same table the buffer views read.
 *
 * ── machine.speed IS A RESOURCE-TYPE PROPERTY, NOT A MACHINE COLUMN ─────────
 *
 * `fab_resources` has no `speed` column and never had one. `formulaEngine`
 * resolves `machine.<key>` from `fab_resource_type_properties` keyed by
 * RESOURCE TYPE (see its `machineProps` query), so speed is a property of "SAW
 * Welding", not of "SAW Welding 3". The values below are the old ones, and each
 * equals the fallback baked into the formula that divides by it — CNCP 15000
 * against `IF(machine.speed > 0, machine.speed, 15000)`, and so on down. That
 * agreement is the point: the fallback exists so a missing property does not
 * produce Infinity, and it should produce the same answer the property does.
 *
 * ── IDEMPOTENCE ────────────────────────────────────────────────────────────
 *
 * Everything is looked up by `code` within the company and upserted. No id from
 * another module is ever assumed; types, operations and flows are re-found by
 * code on every run. A second `--apply` creates nothing.
 *
 * Contract: seed(ctx) -> { resourceTypes, machines, operations, flows, steps, rules }
 * Counts are TOTALS ENSURED, not rows inserted; what was actually created or
 * updated is logged, which is how "the second run created nothing" is read.
 */

import { parseFormula } from '../../apps/fab_erp/services/formulaEngine.js';
import { provisionMachineWipLocation } from '../../apps/fab_erp/services/wipInventoryService.js';
import { syncResourceAreaLink } from '../../apps/fab_erp/services/resourceAreaService.js';

export const NAME = 'Shop floor';

/* ─────────────────────────── 1. resource types ─────────────────────────── */

/**
 * The ten machine types, with the `speed` property each one's formulas divide
 * by. `speedUnit` is not decoration — `speed` means mm²/min on a plasma table
 * and kg/min on a crane, and `/formula/variables` refuses to show a unit at all
 * when the types disagree, so the unit only ever lives here.
 */
const RESOURCE_TYPES = [
  { code: 'CNCP',  name: 'CNC Plate Cutting',     category: 'Cutting',      units: 2, costPerHour: 1200, speed: 15000,  speedUnit: 'mm2/min' },
  { code: 'CNCD',  name: 'CNC Drilling',          category: 'Drilling',     units: 1, costPerHour: 900,  speed: 2,      speedUnit: 'holes/min' },
  { code: 'HBW',   name: 'CNC I/H-Beam Welding',  category: 'Assembly',     units: 1, costPerHour: 1500, speed: 0.3333, speedUnit: 'm/min' },
  { code: 'SAWRF', name: 'SAW Welding',           category: 'Welding',      units: 4, costPerHour: 1000, speed: 0.5,    speedUnit: 'm/min' },
  { code: 'ABM',   name: 'Shot Blasting',         category: 'Surface Prep', units: 1, costPerHour: 800,  speed: 0.6667, speedUnit: 'm2/min' },
  { code: 'MSG',   name: 'Metalizing',            category: 'Coating',      units: 3, costPerHour: 1100, speed: 0.5,    speedUnit: 'm2/min' },
  { code: 'APS',   name: 'Painting',              category: 'Coating',      units: 2, costPerHour: 700,  speed: 0.8333, speedUnit: 'm2/min' },
  { code: 'CRN',   name: 'Crane / EOT Crane',     category: null,           units: 2, costPerHour: null, speed: 400,    speedUnit: 'kg/min' },
  { code: 'QC',    name: 'Quality Control',       category: null,           units: 1, costPerHour: null, speed: 1,      speedUnit: 'checks/min' },
  { code: 'EDGE',  name: 'Edge Preparation',      category: null,           units: 1, costPerHour: null, speed: 0.5,    speedUnit: 'm/min' },
];

/* ───────────────────────────── 2. machines ─────────────────────────────── */

/** The fleet, names and codes as the shop wrote them. */
const MACHINES = [
  { code: 'M00001', name: 'Machine - CNC 1 - Cutting', type: 'CNCP',  costPerHour: 2400 },
  { code: 'M00002', name: 'Machine - CNC 2 - Cutting', type: 'CNCP',  costPerHour: 2400 },
  { code: 'M00003', name: 'Machine - CNC Drilling',    type: 'CNCD',  costPerHour: 1800 },
  { code: 'M00004', name: 'Machine - CNC I/H Beam',    type: 'HBW',   costPerHour: 2900 },
  { code: 'M00005', name: 'Machine - Shot Blasting',   type: 'ABM',   costPerHour: 1500 },
  { code: 'M00006', name: 'Process - Metalizing 1',    type: 'MSG',   costPerHour: 1700 },
  { code: 'M00007', name: 'Process - Metalizing 2',    type: 'MSG',   costPerHour: 1700 },
  { code: 'M00008', name: 'Process - Metalizing 3',    type: 'MSG',   costPerHour: 1700 },
  { code: 'M00009', name: 'Process - Painting 1',      type: 'APS',   costPerHour: 1400 },
  { code: 'M00010', name: 'Process - Painting 2',      type: 'APS',   costPerHour: 1400 },
  { code: 'M00011', name: 'Process - SAW Welding 1',   type: 'SAWRF', costPerHour: 2100 },
  { code: 'M00012', name: 'Process - SAW Welding 2',   type: 'SAWRF', costPerHour: 2100 },
  { code: 'M00013', name: 'Process - SAW Welding 3',   type: 'SAWRF', costPerHour: 2100 },
  { code: 'M00014', name: 'Process - SAW Welding 4',   type: 'SAWRF', costPerHour: 2100 },
  { code: 'M00015', name: 'Crane - EOT 1',             type: 'CRN',   costPerHour: 900 },
  { code: 'M00016', name: 'Crane - EOT 2',             type: 'CRN',   costPerHour: 900 },
  // Two inspectors share one station — the only machine in the fleet that is
  // not a single unit, and it was two in the old data as well.
  { code: 'M00017', name: 'QC / Inspection Station',   type: 'QC',    costPerHour: 800, units: 2 },
  { code: 'M00018', name: 'Edge Prep Station',         type: 'EDGE',  costPerHour: 1200 },
];

/** Same for every machine in the old fleet; kept in one place rather than 18. */
const MACHINE_DEFAULTS = { capacityHrsPerDay: 8.5, units: 1, schedulingBasis: 'finite' };

/* ──────────────────────────── 3. operations ────────────────────────────── */

/**
 * Fourteen operations. `formula` strings are VERBATIM from
 * `placebo_old.fab_operations.time_formula` — do not reformat, do not add
 * whitespace, do not "simplify" a nested IF. `vars` are the `op.*` defaults
 * from `fab_operation_variables`; without them every `op.` fallback in the
 * formulas above resolves to 0, which is the silent failure the fallbacks exist
 * to prevent.
 *
 * `resourceTypes` mirrors `fab_operation_resource_types` — for all fourteen it
 * is exactly the default type, but the table is what the scheduler consults for
 * "what can run this", so an empty one would mean "nothing can".
 */
const OPERATIONS = [
  {
    code: 'Cut', name: 'Marking and Cutting', type: 'CNCP', timeUnit: 'min', setupMinutes: 10,
    formula: '(2 * (item.length_mm + item.width_mm)) * IF(input.raw_material.thickness_mm > 0, input.raw_material.thickness_mm, item.thickness_mm) / IF(machine.speed > 0, machine.speed, 15000)',
    vars: [{ key: 'cut_length', label: 'Cut Length', unit: null, value: 1000 }],
  },
  {
    code: 'DRILL', name: 'CNC Drilling', type: 'CNCD', timeUnit: 'min', setupMinutes: null,
    formula: 'IF(item.num_holes > 0, item.num_holes, op.num_holes) / IF(machine.speed > 0, machine.speed, 2) * IF(input.raw_material.thickness_mm > 0, input.raw_material.thickness_mm / 16, 1)',
    vars: [{ key: 'num_holes', label: 'No. of Holes', unit: null, value: 100 }],
  },
  {
    code: 'ASSY', name: 'Fit-up & I/H-Beam Assembly', type: 'HBW', timeUnit: 'min', setupMinutes: null,
    formula: 'IF(item.weld_length_m > 0, item.weld_length_m, op.weld_length) / IF(machine.speed > 0, machine.speed, 0.3333) + inputs.count * 4',
    vars: [{ key: 'weld_length', label: 'Weld Length (m)', unit: 'm', value: 15 }],
  },
  {
    code: 'SAW', name: 'SAW Welding', type: 'SAWRF', timeUnit: 'min', setupMinutes: null,
    formula: 'IF(item.weld_length_m > 0, item.weld_length_m, op.weld_length) / IF(machine.speed > 0, machine.speed, 0.5) * IF(input.raw_material.thickness_mm > 12, input.raw_material.thickness_mm / 12, 1)',
    vars: [{ key: 'weld_length', label: 'Weld Length (m)', unit: 'm', value: 15 }],
  },
  {
    code: 'BLAST', name: 'Shot Blasting', type: 'ABM', timeUnit: 'min', setupMinutes: null,
    formula: 'IF(item.surface_area_m2 > 0, item.surface_area_m2, IF(inputs.sum(surface_area_m2) > 0, inputs.sum(surface_area_m2), op.area_m2)) / IF(machine.speed > 0, machine.speed, 0.6667)',
    vars: [{ key: 'area_m2', label: 'Surface Area (m²)', unit: 'm2', value: 50 }],
  },
  {
    code: 'METAL', name: 'Metalizing', type: 'MSG', timeUnit: 'min', setupMinutes: null,
    formula: 'IF(item.surface_area_m2 > 0, item.surface_area_m2, IF(inputs.sum(surface_area_m2) > 0, inputs.sum(surface_area_m2), op.area_m2)) / IF(machine.speed > 0, machine.speed, 0.5)',
    vars: [{ key: 'area_m2', label: 'Surface Area (m²)', unit: 'm2', value: 50 }],
  },
  {
    code: 'PAINT', name: 'Painting', type: 'APS', timeUnit: 'min', setupMinutes: null,
    formula: 'IF(item.surface_area_m2 > 0, item.surface_area_m2, IF(inputs.sum(surface_area_m2) > 0, inputs.sum(surface_area_m2), op.area_m2)) / IF(machine.speed > 0, machine.speed, 0.8333)',
    vars: [{ key: 'area_m2', label: 'Surface Area (m²)', unit: 'm2', value: 50 }],
  },
  {
    code: 'CRNMV', name: 'Crane Move / Material Handling', type: 'CRN', timeUnit: 'min', setupMinutes: null,
    formula: 'IF(item.unit_weight_kg > 0, 6 + item.unit_weight_kg / IF(machine.speed > 0, machine.speed, 400), IF(inputs.sum(unit_weight_kg) > 0, 6 + inputs.sum(unit_weight_kg) / IF(machine.speed > 0, machine.speed, 400), op.move_time))',
    vars: [{ key: 'move_time', label: 'move_time', unit: 'min', value: 15 }],
  },
  {
    code: 'CRNTN', name: 'Crane Turn / Reposition', type: 'CRN', timeUnit: 'min', setupMinutes: null,
    formula: 'IF(item.unit_weight_kg > 0, 10 + item.unit_weight_kg / 300, IF(inputs.sum(unit_weight_kg) > 0, 10 + inputs.sum(unit_weight_kg) / 300, op.turn_time))',
    vars: [{ key: 'turn_time', label: 'turn_time', unit: 'min', value: 20 }],
  },
  {
    code: 'EDGEP', name: 'Edge / Bevel Preparation', type: 'EDGE', timeUnit: 'min', setupMinutes: null,
    formula: 'IF(item.edge_length_m > 0, item.edge_length_m, op.edge_length) / IF(machine.speed > 0, machine.speed, 0.5) * IF(input.raw_material.thickness_mm > 0, input.raw_material.thickness_mm / 16, 1)',
    vars: [{ key: 'edge_length', label: 'edge_length', unit: 'm', value: 10 }],
  },
  {
    code: 'TACK', name: 'Tack Weld', type: 'HBW', timeUnit: 'min', setupMinutes: null,
    formula: 'IF(item.weld_length_m > 0, item.weld_length_m, op.weld_length) * 0.5 + inputs.count * 2',
    vars: [{ key: 'weld_length', label: 'weld_length', unit: 'm', value: 15 }],
  },
  {
    code: 'PQC', name: 'Part QC (Dimensional)', type: 'QC', timeUnit: 'min', setupMinutes: 5,
    formula: 'IF(item.edge_length_m > 0, item.edge_length_m * 1.5, op.qc_time)',
    vars: [{ key: 'qc_time', label: 'qc_time', unit: 'min', value: 15 }],
  },
  {
    code: 'WQC', name: 'Weld QC / NDT', type: 'QC', timeUnit: 'min', setupMinutes: 10,
    formula: 'IF(item.weld_length_m > 0, item.weld_length_m * 1.5, op.qc_time)',
    vars: [{ key: 'qc_time', label: 'qc_time', unit: 'min', value: 45 }],
  },
  {
    code: 'FQC', name: 'Final QC', type: 'QC', timeUnit: 'min', setupMinutes: 15,
    formula: 'IF(item.surface_area_m2 > 0, item.surface_area_m2 * 0.8, op.qc_time)',
    vars: [{ key: 'qc_time', label: 'qc_time', unit: 'min', value: 30 }],
  },
];

/* ─────────────────────────── 4. flows and steps ────────────────────────── */

/**
 * Three flows, 29 steps, copied from `placebo_old.fab_operation_flow_steps` in
 * `seq_no` order including `depends_on` and the step notes.
 *
 * `depends_on` is a comma-separated list of seq numbers, not ids — SEG step 4
 * is `'2,3'` because the crane cannot lift the section until both the fit-up
 * and the tack weld are done. It is a string on purpose.
 *
 * SEG welds, turns, and welds again: the second SAW is the far side. The crane
 * moves between stations are real operations with real durations, which is what
 * makes a schedule built from this flow honest rather than optimistic.
 */
const FLOWS = [
  {
    code: 'PARTPL',
    name: 'Part Fabrication — Plain (no holes)',
    description: 'Cut → crane → edge prep → crane → QC. For plate parts without drilled holes.',
    steps: [
      { seq: 1, op: 'Cut',   dependsOn: null, notes: 'Marking & plasma/oxy cutting from raw plate' },
      { seq: 2, op: 'CRNMV', dependsOn: '1',  notes: 'Crane move: cutting bay → edge prep' },
      { seq: 3, op: 'EDGEP', dependsOn: '2',  notes: 'Edge / bevel preparation' },
      { seq: 4, op: 'CRNMV', dependsOn: '3',  notes: 'Crane move: edge prep → QC' },
      { seq: 5, op: 'PQC',   dependsOn: '4',  notes: 'Dimensional QC' },
    ],
  },
  {
    code: 'PARTDR',
    name: 'Part Fabrication — Drilled',
    description: 'Cut → crane → drill → crane → edge prep → crane → QC. For plate parts requiring holes.',
    steps: [
      { seq: 1, op: 'Cut',   dependsOn: null, notes: 'Marking & cutting from raw plate' },
      { seq: 2, op: 'CRNMV', dependsOn: '1',  notes: 'Crane move: cutting bay → drilling' },
      { seq: 3, op: 'DRILL', dependsOn: '2',  notes: 'CNC drilling of holes' },
      { seq: 4, op: 'CRNMV', dependsOn: '3',  notes: 'Crane move: drilling → edge prep' },
      { seq: 5, op: 'EDGEP', dependsOn: '4',  notes: 'Edge / bevel preparation' },
      { seq: 6, op: 'CRNMV', dependsOn: '5',  notes: 'Crane move: edge prep → QC' },
      { seq: 7, op: 'PQC',   dependsOn: '6',  notes: 'Dimensional QC' },
    ],
  },
  {
    code: 'SEG',
    name: 'Girder Segment — Assembly, Welding & Finishing',
    description: 'Weldment flow on a segment node: fit-up → weld (both sides) → stiffeners → NDT → blast → metalize → paint → final QC, with crane handling at every station transition.',
    steps: [
      { seq: 1,  op: 'CRNMV', dependsOn: null,  notes: 'Crane: load finished parts onto assembly bay' },
      { seq: 2,  op: 'ASSY',  dependsOn: '1',   notes: 'Fit-up of web + top/bottom flange into I-section' },
      { seq: 3,  op: 'TACK',  dependsOn: '2',   notes: 'Tack weld the I-section' },
      { seq: 4,  op: 'CRNMV', dependsOn: '2,3', notes: 'Crane move: assembly bay → SAW station' },
      { seq: 5,  op: 'SAW',   dependsOn: '4',   notes: 'SAW weld — side 1' },
      { seq: 6,  op: 'CRNTN', dependsOn: '5',   notes: 'Crane: turn girder to weld other side' },
      { seq: 7,  op: 'SAW',   dependsOn: '6',   notes: 'SAW weld — side 2' },
      { seq: 8,  op: 'CRNMV', dependsOn: '7',   notes: 'Crane move: SAW → assembly bay for stiffeners' },
      { seq: 9,  op: 'ASSY',  dependsOn: '8',   notes: 'Fit & weld stiffeners' },
      { seq: 10, op: 'WQC',   dependsOn: '9',   notes: 'Weld QC / NDT (UT/MPI)' },
      { seq: 11, op: 'CRNMV', dependsOn: '10',  notes: 'Crane move: assembly → shot blast' },
      { seq: 12, op: 'BLAST', dependsOn: '11',  notes: 'Shot blasting (SA 2.5)' },
      { seq: 13, op: 'CRNMV', dependsOn: '12',  notes: 'Crane move: blast → metalizing' },
      { seq: 14, op: 'METAL', dependsOn: '13',  notes: 'Metalizing (zinc thermal spray)' },
      { seq: 15, op: 'CRNMV', dependsOn: '14',  notes: 'Crane move: metalizing → paint' },
      { seq: 16, op: 'PAINT', dependsOn: '15',  notes: 'Painting (epoxy/PU system)' },
      { seq: 17, op: 'FQC',   dependsOn: '16',  notes: 'Final QC & dispatch clearance' },
    ],
  },
];

/* ───────────────────────────── 5. flow rules ───────────────────────────── */

/**
 * Flow follows the LEVEL, not the item — every part gets the part flow, every
 * segment the segment flow, and `/D` on a code picks the drilled variant.
 *
 * `lineType: null` means ANY structure type, and that is deliberate: module 03
 * creates five structure variants (Composite Girder, BowString, Tub Girder,
 * Openweb Girder, PEB) and all five fabricate parts and segments the same way.
 * `flowAllocationService.pickRule` filters with `r.line_type == null ||
 * r.line_type === lineType`, so a NULL rule is a candidate for every type and
 * loses only to a rule naming that type explicitly — which is what "default"
 * should mean.
 *
 * Span and girder get NO rule on purpose. They are groupings; there is no work
 * to do on them, and `applyFlowRules` counts a level with no rule as `noRule`
 * rather than as a failure.
 */
const FLOW_RULES = [
  { levelKind: 'part',    lineType: null, codeSuffix: null, flow: 'PARTPL', notes: 'default for parts' },
  { levelKind: 'part',    lineType: null, codeSuffix: '/D', flow: 'PARTDR', notes: 'parts whose code ends /D are drilled' },
  { levelKind: 'segment', lineType: null, codeSuffix: null, flow: 'SEG',    notes: 'default for girder segments' },
];

/* ─────────────────────────────── the seed ──────────────────────────────── */

export async function seed(ctx) {
  const { companyId, apply, conn } = ctx;
  const log = ctx.log ?? ((m) => console.log(m));
  const tally = { created: 0, updated: 0, unchanged: 0 };

  /**
   * The primary plant: the company's oldest live plant.
   *
   * Placebo keeps two (`PLT01 Chandavalle Plant` and `PLT02 Unit 2` in the old
   * data) and the whole fleet lived on the first. There is no `is_primary`
   * column to consult, so "oldest" is the rule — it is stable across runs,
   * which is what idempotence needs, and it is the one the machines were on.
   * Named in the log so the choice is never a guess someone has to reverse
   * engineer.
   */
  const [plants] = await conn.query(
    `SELECT id, code, name FROM fab_plants
      WHERE company_id = ? AND deleted_at IS NULL ORDER BY id`,
    [companyId],
  );
  if (!plants.length) {
    throw new Error(
      `Company ${companyId} has no plant. Machines and their WIP areas are both `
      + 'scoped to a plant, so there is nowhere to put the shop floor.',
    );
  }
  const plant = plants[0];
  log(`plant: ${plant.name} (${plant.code}, id ${plant.id})`
    + `${plants.length > 1 ? ` — primary of ${plants.length}` : ''}`);

  /* ── 1. resource types + the machine.speed property ────────────────────── */

  const typeIdByCode = new Map();
  for (const t of RESOURCE_TYPES) {
    const [[found]] = await conn.query(
      `SELECT id FROM fab_resource_types
        WHERE company_id = ? AND code = ? AND deleted_at IS NULL LIMIT 1`,
      [companyId, t.code],
    );
    if (!apply) { if (found) typeIdByCode.set(t.code, found.id); continue; }

    const cols = [t.name, t.category, plant.id, 8.0, t.units, 85.0, 100.0, 100.0, 'machine', t.costPerHour, 'INR'];
    let id = found?.id;
    if (id) {
      await conn.query(
        `UPDATE fab_resource_types
            SET name = ?, category = ?, plant_id = ?, capacity_hrs_per_day = ?, num_units = ?,
                utilization_pct = ?, efficiency_pct = ?, overload_pct = ?,
                scheduling_basis = ?, cost_per_hour = ?, currency = ?
          WHERE id = ? AND company_id = ?`,
        [...cols, id, companyId],
      );
      tally.updated += 1;
    } else {
      const [ins] = await conn.query(
        `INSERT INTO fab_resource_types
           (company_id, code, name, category, plant_id, capacity_hrs_per_day, num_units,
            utilization_pct, efficiency_pct, overload_pct, scheduling_basis, cost_per_hour, currency)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [companyId, t.code, ...cols],
      );
      id = ins.insertId;
      tally.created += 1;
    }
    typeIdByCode.set(t.code, id);

    /**
     * `uq_rtp_key (resource_type_id, property_key)` does NOT include
     * `deleted_at`, so a previously soft-deleted property still occupies the
     * key and a plain INSERT would collide. Upsert and revive.
     */
    await conn.query(
      `INSERT INTO fab_resource_type_properties
         (company_id, resource_type_id, property_key, property_label, unit, default_value)
       VALUES (?, ?, 'speed', 'Machine speed', ?, ?)
       ON DUPLICATE KEY UPDATE
         company_id = VALUES(company_id), property_label = VALUES(property_label),
         unit = VALUES(unit), default_value = VALUES(default_value), deleted_at = NULL`,
      [companyId, id, t.speedUnit, t.speed],
    );
  }

  /* ── 2. machines, each with its own WIP area ───────────────────────────── */

  let wipAreas = 0;
  let areaLinks = 0;
  for (const m of MACHINES) {
    const typeId = typeIdByCode.get(m.type);
    const [[found]] = await conn.query(
      `SELECT id, name, plant_id, stock_location_id FROM fab_resources
        WHERE company_id = ? AND code = ? AND deleted_at IS NULL LIMIT 1`,
      [companyId, m.code],
    );
    if (!apply) continue;
    if (!typeId) throw new Error(`Resource type ${m.type} missing for machine ${m.code}`);

    const cols = [
      m.name, typeId, plant.id, MACHINE_DEFAULTS.capacityHrsPerDay,
      m.units ?? MACHINE_DEFAULTS.units, 85.0, 100.0, 100.0,
      MACHINE_DEFAULTS.schedulingBasis, m.costPerHour, 'INR',
    ];
    let id = found?.id;
    if (id) {
      await conn.query(
        `UPDATE fab_resources
            SET name = ?, resource_type_id = ?, plant_id = ?, capacity_hrs_per_day = ?,
                num_units = ?, utilization_pct = ?, efficiency_pct = ?, overload_pct = ?,
                scheduling_basis = ?, cost_per_hour = ?, currency = ?
          WHERE id = ? AND company_id = ?`,
        [...cols, id, companyId],
      );
      tally.updated += 1;
    } else {
      const [ins] = await conn.query(
        `INSERT INTO fab_resources
           (company_id, code, name, resource_type_id, plant_id, capacity_hrs_per_day, num_units,
            utilization_pct, efficiency_pct, overload_pct, scheduling_basis, cost_per_hour, currency)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [companyId, m.code, ...cols],
      );
      id = ins.insertId;
      tally.created += 1;
    }

    /**
     * The machine's OWN area — `provisionMachineWipLocation`, not a hand-rolled
     * INSERT, because that helper owns the `WIP-M<id>` naming and the
     * find-or-create. `provision…` rather than `ensureMachineWipLocation` is
     * the deliberate choice: `ensure…` returns early the moment
     * `stock_location_id` is set, which would leave a machine that already
     * points at a POOLED area pooled for ever — exactly the state this rebuild
     * exists to end.
     */
    const priorLocation = found?.stock_location_id ?? null;
    const locId = await provisionMachineWipLocation(conn, companyId, {
      id, name: m.name, plant_id: plant.id,
    });
    if (!locId) throw new Error(`Could not provision a WIP area for ${m.code}`);
    wipAreas += 1;

    if (Number(priorLocation) !== Number(locId)) {
      await conn.query(
        `UPDATE fab_resources SET stock_location_id = ? WHERE id = ? AND company_id = ?`,
        [locId, id, companyId],
      );
    }
    // The canonical link. Nothing but a one-off backfill has ever written this
    // table, so a machine created any other way has no row in it at all.
    await syncResourceAreaLink(conn, companyId, id, {
      fromId: priorLocation, toId: locId, role: 'wip',
    });
    areaLinks += 1;
  }

  /* ── 3. operations, their allowed types and their op.* defaults ────────── */

  const opIdByCode = new Map();
  for (const o of OPERATIONS) {
    const typeId = typeIdByCode.get(o.type);
    const [[found]] = await conn.query(
      `SELECT id FROM fab_operations
        WHERE company_id = ? AND code = ? AND deleted_at IS NULL LIMIT 1`,
      [companyId, o.code],
    );
    if (!apply) { if (found) opIdByCode.set(o.code, found.id); continue; }
    if (!typeId) throw new Error(`Resource type ${o.type} missing for operation ${o.code}`);

    let id = found?.id;
    if (id) {
      await conn.query(
        `UPDATE fab_operations
            SET name = ?, default_resource_type_id = ?, time_formula = ?, time_unit = ?,
                setup_minutes = ?, active = 1
          WHERE id = ? AND company_id = ?`,
        [o.name, typeId, o.formula, o.timeUnit, o.setupMinutes, id, companyId],
      );
      tally.updated += 1;
    } else {
      const [ins] = await conn.query(
        `INSERT INTO fab_operations
           (company_id, code, name, default_resource_type_id, time_formula, time_unit, setup_minutes, active)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
        [companyId, o.code, o.name, typeId, o.formula, o.timeUnit, o.setupMinutes],
      );
      id = ins.insertId;
      tally.created += 1;
    }
    opIdByCode.set(o.code, id);

    // Neither unique key below carries `deleted_at`, so both upsert-and-revive
    // rather than insert.
    await conn.query(
      `INSERT INTO fab_operation_resource_types (company_id, operation_id, resource_type_id)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE company_id = VALUES(company_id), deleted_at = NULL`,
      [companyId, id, typeId],
    );
    for (const v of o.vars ?? []) {
      await conn.query(
        `INSERT INTO fab_operation_variables
           (company_id, operation_id, var_key, label, unit, default_value, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, 0)
         ON DUPLICATE KEY UPDATE
           company_id = VALUES(company_id), label = VALUES(label), unit = VALUES(unit),
           default_value = VALUES(default_value), deleted_at = NULL`,
        [companyId, id, v.key, v.label, v.unit, v.value],
      );
    }
  }

  /* ── 4. flows and steps ───────────────────────────────────────────────── */

  const flowIdByCode = new Map();
  let stepCount = 0;
  for (const f of FLOWS) {
    stepCount += f.steps.length;
    const [[found]] = await conn.query(
      `SELECT id FROM fab_operation_flows
        WHERE company_id = ? AND code = ? AND deleted_at IS NULL LIMIT 1`,
      [companyId, f.code],
    );
    if (!apply) { if (found) flowIdByCode.set(f.code, found.id); continue; }

    let flowId = found?.id;
    if (flowId) {
      await conn.query(
        `UPDATE fab_operation_flows SET name = ?, description = ?, active = 1
          WHERE id = ? AND company_id = ?`,
        [f.name, f.description, flowId, companyId],
      );
      tally.updated += 1;
    } else {
      const [ins] = await conn.query(
        `INSERT INTO fab_operation_flows (company_id, code, name, description, active)
         VALUES (?, ?, ?, ?, 1)`,
        [companyId, f.code, f.name, f.description],
      );
      flowId = ins.insertId;
      tally.created += 1;
    }
    flowIdByCode.set(f.code, flowId);

    /**
     * Steps are keyed by (flow, seq_no) — the position IS the identity, which
     * is why re-running rewrites step 4 in place instead of appending a second
     * one. Any live step beyond the end of the declared sequence is retired:
     * shortening a flow has to actually shorten it, or the old tail would go on
     * being materialized onto every item.
     */
    for (const s of f.steps) {
      const opId = opIdByCode.get(s.op);
      const rtId = typeIdByCode.get(OPERATIONS.find((o) => o.code === s.op).type);
      if (!opId) throw new Error(`Operation ${s.op} missing for flow ${f.code} step ${s.seq}`);
      const [[step]] = await conn.query(
        `SELECT id FROM fab_operation_flow_steps
          WHERE company_id = ? AND flow_id = ? AND seq_no = ? AND deleted_at IS NULL LIMIT 1`,
        [companyId, flowId, s.seq],
      );
      if (step) {
        await conn.query(
          `UPDATE fab_operation_flow_steps
              SET operation_id = ?, depends_on = ?, resource_type_id = ?, notes = ?
            WHERE id = ?`,
          [opId, s.dependsOn, rtId, s.notes, step.id],
        );
        tally.updated += 1;
      } else {
        await conn.query(
          `INSERT INTO fab_operation_flow_steps
             (company_id, flow_id, operation_id, seq_no, depends_on, resource_type_id, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [companyId, flowId, opId, s.seq, s.dependsOn, rtId, s.notes],
        );
        tally.created += 1;
      }
    }
    const [trimmed] = await conn.query(
      `UPDATE fab_operation_flow_steps SET deleted_at = UTC_TIMESTAMP()
        WHERE company_id = ? AND flow_id = ? AND seq_no > ? AND deleted_at IS NULL`,
      [companyId, flowId, f.steps.length],
    );
    if (trimmed.affectedRows) log(`${f.code}: retired ${trimmed.affectedRows} step(s) past seq ${f.steps.length}`);
  }

  /* ── 5. flow rules ────────────────────────────────────────────────────── */

  for (const r of FLOW_RULES) {
    const flowId = flowIdByCode.get(r.flow);
    /**
     * A rule has no unique key, so its natural key is what it MATCHES ON:
     * (level_kind, line_type, code_suffix). Two live rules with the same match
     * key are not two rules, they are an ambiguity — `loadRules` resolves such
     * a pair by "oldest id wins", so a second one would be silently dead. NULL-
     * safe `<=>` because both `line_type` and `code_suffix` are NULL here and
     * `= NULL` matches nothing.
     */
    const [[found]] = await conn.query(
      `SELECT id, flow_id FROM fab_flow_rules
        WHERE company_id = ? AND level_kind = ? AND line_type <=> ? AND code_suffix <=> ?
          AND deleted_at IS NULL
        ORDER BY id LIMIT 1`,
      [companyId, r.levelKind, r.lineType, r.codeSuffix],
    );
    if (!apply) continue;
    if (!flowId) throw new Error(`Flow ${r.flow} missing for the ${r.levelKind} rule`);

    if (found) {
      if (Number(found.flow_id) !== Number(flowId)) {
        log(`rule ${r.levelKind}${r.codeSuffix ?? ''}: repointed from flow #${found.flow_id} to ${r.flow}`);
      }
      await conn.query(
        `UPDATE fab_flow_rules SET flow_id = ?, notes = ?, active = 1 WHERE id = ?`,
        [flowId, r.notes, found.id],
      );
      tally.updated += 1;
    } else {
      await conn.query(
        `INSERT INTO fab_flow_rules (company_id, line_type, level_kind, code_suffix, flow_id, active, notes)
         VALUES (?, ?, ?, ?, ?, 1, ?)`,
        [companyId, r.lineType, r.levelKind, r.codeSuffix, flowId, r.notes],
      );
      tally.created += 1;
    }
  }

  /* ── 6. lint every formula before anyone can be fooled by a zero ───────── */

  await lintFormulas(conn, companyId, log);

  if (apply) {
    log(`wrote ${tally.created} new row(s), refreshed ${tally.updated}; `
      + `${wipAreas} per-machine WIP area(s), ${areaLinks} canonical area link(s)`);
  } else {
    log('dry run — nothing written');
  }

  return {
    resourceTypes: RESOURCE_TYPES.length,
    machines: MACHINES.length,
    operations: OPERATIONS.length,
    flows: FLOWS.length,
    steps: stepCount,
    rules: FLOW_RULES.length,
  };
}

/**
 * Does every variable these formulas name actually resolve?
 *
 * THIS IS THE ONLY CHECK THAT MATTERS HERE. An unresolved variable does not
 * throw: `formulaEngine` defaults any unknown namespaced symbol to 0, so
 * `item.edge_length_m / machine.speed` with no such field defined evaluates to
 * 0 (or Infinity when it is the divisor that is missing, which fails the
 * isFinite check and returns null). `computed_hours` lands 0 or NULL, the
 * critical chain reads the task as instant, the project buffer never shrinks,
 * and a date is promised that the shop cannot meet — with no error anywhere.
 *
 * The rules are `POST /formula/validate`'s, deliberately: `machine.*` against
 * `fab_resource_type_properties`, `item.*` against `fab_fields` filtered on
 * `active = 1 AND formula_usable = 1`, `op.*` against that operation's own
 * variables. `step.*`, `input.<role>.*` and the `inputs.*` aggregates are
 * skipped there and skipped here, and for the same reason: which roles a task
 * has depends on the BOM under the item it runs on, so a formula that is
 * correct for a part with raw material would be flagged on one without.
 *
 * Machine keys are the union of what is in the database and what this module
 * declares, so the lint is truthful in a dry run too — otherwise every
 * `machine.speed` would be reported missing purely because nothing has been
 * written yet.
 */
async function lintFormulas(conn, companyId, log) {
  const [fieldRows] = await conn.query(
    `SELECT field_key FROM fab_fields
      WHERE company_id = ? AND deleted_at IS NULL AND active = 1 AND formula_usable = 1`,
    [companyId],
  );
  const [propRows] = await conn.query(
    `SELECT DISTINCT p.property_key
       FROM fab_resource_type_properties p
       JOIN fab_resource_types rt ON rt.id = p.resource_type_id AND rt.deleted_at IS NULL
      WHERE rt.company_id = ? AND p.deleted_at IS NULL`,
    [companyId],
  );

  const knownItem = new Set(fieldRows.map((r) => r.field_key));
  const knownMachine = new Set([...propRows.map((r) => r.property_key), 'speed']);

  const problems = [];
  for (const o of OPERATIONS) {
    const parsed = parseFormula(o.formula);
    if (!parsed.valid) { problems.push(`${o.code}: will not parse — ${parsed.error}`); continue; }
    const knownOp = new Set((o.vars ?? []).map((v) => v.key));
    for (const v of parsed.variables) {
      const [ns, key] = v.split('.');
      if (!ns || !key) continue;                 // input_*/inputs_* arrive bare
      if (ns === 'step') continue;
      if (ns === 'item' && !knownItem.has(key)) problems.push(`${o.code}: ${v} is not a formula-usable field`);
      if (ns === 'machine' && !knownMachine.has(key)) problems.push(`${o.code}: ${v} is not a resource-type property`);
      if (ns === 'op' && !knownOp.has(key)) problems.push(`${o.code}: ${v} has no operation variable`);
    }
  }

  if (!problems.length) {
    log(`formulas: ${OPERATIONS.length}/${OPERATIONS.length} parse, every variable resolves`);
    return;
  }
  log(`formulas: ${problems.length} UNRESOLVED VARIABLE(S) — these evaluate to 0, silently:`);
  for (const p of problems) log(`  ! ${p}`);
  log('  fix the field registry (module 01) before trusting any duration.');
}
