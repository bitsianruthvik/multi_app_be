import ExcelJS from 'exceljs';
import { pool } from '../../../db.js';

const LEVEL_NAMES    = ['Fabrication Package','Package','Girder Line','Bracing Member','Diaphragm Type','Splice Plate','Part','Raw Material'];
const PROCESS_TYPES  = ['Cutting','Drilling','Fit-up','MIG Welding','SAW Welding','Stud Welding','Grinding','Blasting','Primer Painting','Final Painting','Inspection','Assembly','Tack Welding'];
const TIME_UNITS     = ['min','hr','shift'];
const MANDATORY_OPTS = ['Yes','No'];
const NODE_ROLES     = ['Worked-On','Input','Output','Consumed','Reference'];
const CONDITIONS     = ['Complete','In Progress','Started'];
const SCHEDULING_MODES = ['Forward','Backward'];

function header(ws, cols) {
  ws.addRow(cols.map((c) => c.header));
  const row = ws.getRow(1);
  row.font      = { bold: true, color: { argb: 'FFFFFFFF' } };
  row.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } };
  row.alignment = { vertical: 'middle', horizontal: 'center' };
  row.height    = 20;
  cols.forEach((c, i) => {
    ws.getColumn(i + 1).width = c.width ?? 20;
    ws.getColumn(i + 1).key  = c.key;
  });
}

function dropdownValidation(ws, col, list, fromRow, toRow) {
  for (let r = fromRow; r <= toRow; r++) {
    ws.getCell(r, col).dataValidation = {
      type: 'list',
      allowBlank: true,
      formulae: [`"${list.join(',')}"`],
    };
  }
}

function fmtDate(val) {
  if (!val) return null;
  if (val instanceof Date) return val.toISOString().slice(0, 10);
  return String(val).slice(0, 10);
}

export async function exportPlan(planId, companyId) {
  const [[plan]] = await pool.query(
    `SELECT p.*, wc.calendar_code
       FROM fab_project_plans p
       LEFT JOIN fab_work_calendars wc ON wc.id = p.calendar_id
      WHERE p.id = ? AND p.company_id = ? AND p.deleted_at IS NULL`,
    [planId, companyId],
  );
  if (!plan) throw new Error('Plan not found');

  const [nodes] = await pool.query(
    `SELECT n.*, wa.work_area_code AS preferred_work_area_code
       FROM fab_nodes n
       LEFT JOIN fab_work_areas wa ON wa.id = n.preferred_work_area_id
      WHERE n.project_plan_id = ? AND n.deleted_at IS NULL ORDER BY n.id`,
    [planId],
  );

  // child -> parent_node_code via is_primary relationships
  const [rels] = await pool.query(
    `SELECT r.child_node_id, n.node_code AS parent_node_code
       FROM fab_node_relationships r
       JOIN fab_nodes n ON n.id = r.parent_node_id
      WHERE r.project_plan_id = ? AND r.deleted_at IS NULL AND r.is_primary = 1`,
    [planId],
  );
  const parentMap = {};
  for (const r of rels) parentMap[r.child_node_id] = r.parent_node_code;

  const [steps] = await pool.query(
    `SELECT s.*, wa.work_area_code AS preferred_work_area_code
       FROM fab_process_steps s
       LEFT JOIN fab_work_areas wa ON wa.id = s.preferred_work_area_id
      WHERE s.project_plan_id = ? AND s.deleted_at IS NULL ORDER BY s.sequence_no, s.id`,
    [planId],
  );

  const [stepNodes] = await pool.query(
    `SELECT m.node_role, m.quantity, m.notes,
            n.node_code, s.process_step_code
       FROM fab_process_step_node_map m
       JOIN fab_nodes n         ON n.id = m.node_id
       JOIN fab_process_steps s ON s.id = m.process_step_id
      WHERE s.project_plan_id = ? AND m.deleted_at IS NULL
      ORDER BY s.sequence_no, m.id`,
    [planId],
  );

  const [preconditions] = await pool.query(
    `SELECT pc.required_condition, pc.notes,
            s.process_step_code,
            rs.process_step_code AS required_process_step_code,
            rn.node_code          AS required_node_code
       FROM fab_process_preconditions pc
       JOIN fab_process_steps s        ON s.id  = pc.process_step_id
       LEFT JOIN fab_process_steps rs  ON rs.id = pc.required_process_step_id
       LEFT JOIN fab_nodes rn          ON rn.id = pc.required_node_id
      WHERE s.project_plan_id = ? AND pc.deleted_at IS NULL
      ORDER BY s.sequence_no, pc.id`,
    [planId],
  );

  const [workAreaOptions] = await pool.query(
    `SELECT opt.priority, opt.notes,
            s.process_step_code,
            wa.work_area_code
       FROM fab_process_work_area_options opt
       JOIN fab_process_steps s  ON s.id  = opt.process_step_id
       JOIN fab_work_areas wa    ON wa.id = opt.work_area_id
      WHERE s.project_plan_id = ? AND opt.company_id = ?
      ORDER BY s.sequence_no, opt.priority`,
    [planId, companyId],
  );

  const wb   = new ExcelJS.Workbook();
  wb.creator = 'FabFlow';
  wb.created = new Date();

  // ── Sheet 1: Project_Info ──────────────────────────────────────────────────
  // Columns: project_code(1) project_name(2) client_name(3) site_location(4)
  //          plan_name(5) plan_revision(6) planned_start_date(7) target_end_date(8)
  //          calendar_code(9) scheduling_mode(10) notes(11)
  const s1 = wb.addWorksheet('Project_Info');
  header(s1, [
    { header: 'project_code',       key: 'project_code',       width: 20 },
    { header: 'project_name',       key: 'project_name',       width: 40 },
    { header: 'client_name',        key: 'client_name',        width: 30 },
    { header: 'site_location',      key: 'site_location',      width: 30 },
    { header: 'plan_name',          key: 'plan_name',          width: 40 },
    { header: 'plan_revision',      key: 'plan_revision',      width: 15 },
    { header: 'planned_start_date', key: 'planned_start_date', width: 20 },
    { header: 'target_end_date',    key: 'target_end_date',    width: 18 },
    { header: 'calendar_code',      key: 'calendar_code',      width: 22 },
    { header: 'scheduling_mode',    key: 'scheduling_mode',    width: 18 },
    { header: 'notes',              key: 'notes',              width: 40 },
  ]);
  s1.addRow([
    plan.project_code, plan.project_name, plan.client_name,
    plan.site_location, plan.plan_name, plan.plan_revision,
    fmtDate(plan.planned_start_date), fmtDate(plan.target_end_date),
    plan.calendar_code ?? null, plan.scheduling_mode ?? 'Forward', plan.notes,
  ]);
  dropdownValidation(s1, 10, SCHEDULING_MODES, 2, 3);

  // ── Sheet 2: Nodes ─────────────────────────────────────────────────────────
  // Columns 1–18 unchanged; col 19 = preferred_work_area_code (NEW); col 20 = notes
  const s2 = wb.addWorksheet('Nodes');
  const nodeCols = [
    { header: 'node_code',                key: 'node_code',                width: 22 },
    { header: 'display_name',             key: 'display_name',             width: 35 },
    { header: 'level_name',               key: 'level_name',               width: 22 },
    { header: 'description',              key: 'description',              width: 35 },
    { header: 'quantity',                 key: 'quantity',                 width: 12 },
    { header: 'unit',                     key: 'unit',                     width: 10 },
    { header: 'parent_node_code',         key: 'parent_node_code',         width: 22 },
    { header: 'drawing_ref',              key: 'drawing_ref',              width: 20 },
    { header: 'drawing_sheet_no',         key: 'drawing_sheet_no',         width: 18 },
    { header: 'drawing_revision',         key: 'drawing_revision',         width: 16 },
    { header: 'material_grade',           key: 'material_grade',           width: 16 },
    { header: 'profile',                  key: 'profile',                  width: 22 },
    { header: 'length_mm',               key: 'length_mm',                width: 12 },
    { header: 'width_mm',                key: 'width_mm',                 width: 12 },
    { header: 'thickness_mm',            key: 'thickness_mm',             width: 14 },
    { header: 'weight_kg',               key: 'weight_kg',                width: 12 },
    { header: 'location_ref',             key: 'location_ref',             width: 18 },
    { header: 'dispatchable',             key: 'dispatchable',             width: 14 },
    { header: 'preferred_work_area_code', key: 'preferred_work_area_code', width: 24 },
    { header: 'notes',                    key: 'notes',                    width: 30 },
  ];
  header(s2, nodeCols);
  for (const n of nodes) {
    s2.addRow([
      n.node_code, n.display_name, n.level_name, n.description,
      n.quantity, n.unit, parentMap[n.id] ?? null,
      n.drawing_ref, n.drawing_sheet_no, n.drawing_revision,
      n.material_grade, n.profile,
      n.length_mm, n.width_mm, n.thickness_mm, n.weight_kg,
      n.location_ref, n.dispatchable ? 'Yes' : 'No',
      n.preferred_work_area_code ?? null,
      n.notes,
    ]);
  }
  const nodeValidRows = Math.max(nodes.length, 500) + 1;
  dropdownValidation(s2, 3,  LEVEL_NAMES, 2, nodeValidRows);
  dropdownValidation(s2, 18, ['Yes','No'], 2, nodeValidRows);

  // ── Sheet 3: Process_Steps ─────────────────────────────────────────────────
  // Original cols 1-10 unchanged.
  // New cols: 11=requires_work_area 12=preferred_work_area_code 13=requires_machine
  //           14=estimated_machine_time_value 15=estimated_machine_time_unit 16=resource_notes
  const s3 = wb.addWorksheet('Process_Steps');
  header(s3, [
    { header: 'process_step_code',           key: 'process_step_code',           width: 24 },
    { header: 'process_name',                key: 'process_name',                width: 30 },
    { header: 'process_type',                key: 'process_type',                width: 18 },
    { header: 'sequence_no',                 key: 'sequence_no',                 width: 13 },
    { header: 'parallel_group',              key: 'parallel_group',              width: 16 },
    { header: 'machine_or_workcentre_type',  key: 'machine_or_workcentre_type',  width: 28 },
    { header: 'estimated_time_value',        key: 'estimated_time_value',        width: 20 },
    { header: 'estimated_time_unit',         key: 'estimated_time_unit',         width: 18 },
    { header: 'mandatory',                   key: 'mandatory',                   width: 12 },
    { header: 'notes',                       key: 'notes',                       width: 30 },
    { header: 'requires_work_area',          key: 'requires_work_area',          width: 18 },
    { header: 'preferred_work_area_code',    key: 'preferred_work_area_code',    width: 24 },
    { header: 'requires_machine',            key: 'requires_machine',            width: 18 },
    { header: 'estimated_machine_time_value',key: 'estimated_machine_time_value',width: 26 },
    { header: 'estimated_machine_time_unit', key: 'estimated_machine_time_unit', width: 24 },
    { header: 'resource_notes',              key: 'resource_notes',              width: 30 },
  ]);
  for (const s of steps) {
    s3.addRow([
      s.process_step_code, s.process_name, s.process_type,
      s.sequence_no, s.parallel_group, s.machine_or_workcentre_type,
      s.estimated_time_value, s.estimated_time_unit,
      s.mandatory ? 'Yes' : 'No', s.notes,
      s.requires_work_area  ? 'Yes' : 'No',
      s.preferred_work_area_code ?? null,
      s.requires_machine ? 'Yes' : 'No',
      s.estimated_machine_time_value,
      s.estimated_machine_time_unit ?? 'hr',
      s.resource_notes,
    ]);
  }
  const stepValidRows = Math.max(steps.length, 500) + 1;
  dropdownValidation(s3, 3,  PROCESS_TYPES,  2, stepValidRows);
  dropdownValidation(s3, 8,  TIME_UNITS,     2, stepValidRows);
  dropdownValidation(s3, 9,  MANDATORY_OPTS, 2, stepValidRows);
  dropdownValidation(s3, 11, MANDATORY_OPTS, 2, stepValidRows);
  dropdownValidation(s3, 13, MANDATORY_OPTS, 2, stepValidRows);
  dropdownValidation(s3, 15, TIME_UNITS,     2, stepValidRows);

  // ── Sheet 4: Process_Step_Nodes ────────────────────────────────────────────
  const s4 = wb.addWorksheet('Process_Step_Nodes');
  header(s4, [
    { header: 'process_step_code', key: 'process_step_code', width: 24 },
    { header: 'node_code',         key: 'node_code',         width: 22 },
    { header: 'node_role',         key: 'node_role',         width: 18 },
    { header: 'quantity',          key: 'quantity',          width: 12 },
    { header: 'notes',             key: 'notes',             width: 35 },
  ]);
  for (const sn of stepNodes) {
    s4.addRow([sn.process_step_code, sn.node_code, sn.node_role, sn.quantity, sn.notes]);
  }
  dropdownValidation(s4, 3, NODE_ROLES, 2, Math.max(stepNodes.length, 500) + 1);

  // ── Sheet 5: Process_Preconditions ─────────────────────────────────────────
  const s5 = wb.addWorksheet('Process_Preconditions');
  header(s5, [
    { header: 'process_step_code',          key: 'process_step_code',          width: 24 },
    { header: 'required_node_code',         key: 'required_node_code',         width: 22 },
    { header: 'required_process_step_code', key: 'required_process_step_code', width: 28 },
    { header: 'required_condition',         key: 'required_condition',         width: 20 },
    { header: 'notes',                      key: 'notes',                      width: 35 },
  ]);
  for (const pc of preconditions) {
    s5.addRow([
      pc.process_step_code, pc.required_node_code,
      pc.required_process_step_code, pc.required_condition, pc.notes,
    ]);
  }
  dropdownValidation(s5, 4, CONDITIONS, 2, Math.max(preconditions.length, 200) + 1);

  // ── Sheet 6: Process_WorkArea_Options ──────────────────────────────────────
  const s6 = wb.addWorksheet('Process_WorkArea_Options');
  header(s6, [
    { header: 'process_step_code', key: 'process_step_code', width: 24 },
    { header: 'work_area_code',    key: 'work_area_code',    width: 22 },
    { header: 'priority',          key: 'priority',          width: 12 },
    { header: 'notes',             key: 'notes',             width: 35 },
  ]);
  for (const opt of workAreaOptions) {
    s6.addRow([opt.process_step_code, opt.work_area_code, opt.priority, opt.notes]);
  }

  // ── Sheet 7: Masters_Reference ─────────────────────────────────────────────
  const s7 = wb.addWorksheet('Masters_Reference');
  s7.getColumn(1).width = 30;
  s7.getColumn(2).width = 30;
  s7.getColumn(3).width = 22;
  s7.getColumn(4).width = 20;
  s7.getColumn(5).width = 16;
  s7.addRow(['level_name examples', 'process_type examples', 'node_role examples', 'time_unit examples', 'scheduling_mode']);
  s7.getRow(1).font = { bold: true };
  const maxRows = Math.max(LEVEL_NAMES.length, PROCESS_TYPES.length, NODE_ROLES.length, TIME_UNITS.length);
  for (let i = 0; i < maxRows; i++) {
    s7.getCell(i + 2, 1).value = LEVEL_NAMES[i]      ?? '';
    s7.getCell(i + 2, 2).value = PROCESS_TYPES[i]    ?? '';
    s7.getCell(i + 2, 3).value = NODE_ROLES[i]       ?? '';
    s7.getCell(i + 2, 4).value = TIME_UNITS[i]       ?? '';
    s7.getCell(i + 2, 5).value = SCHEDULING_MODES[i] ?? '';
  }

  return wb.xlsx.writeBuffer();
}
