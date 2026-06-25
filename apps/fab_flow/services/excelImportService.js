import fs from 'fs';
import ExcelJS from 'exceljs';
import { pool } from '../../../db.js';

// ── helpers ────────────────────────────────────────────────────────────────

function cellVal(row, col) {
  const c = row.getCell(col);
  if (c.value === null || c.value === undefined) return null;
  if (typeof c.value === 'object' && c.value.text)             return String(c.value.text).trim();
  if (typeof c.value === 'object' && c.value.result !== undefined) return c.value.result;
  return String(c.value).trim() || null;
}

function numVal(row, col) {
  const v = cellVal(row, col);
  if (v === null) return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
}

function boolVal(row, col, defaultVal = true) {
  const v = (cellVal(row, col) ?? '').toLowerCase();
  if (v === 'yes' || v === '1' || v === 'true') return 1;
  if (v === 'no'  || v === '0' || v === 'false') return 0;
  return defaultVal ? 1 : 0;
}

function fmtDate(raw) {
  if (!raw) return null;
  if (raw instanceof Date) return raw.toISOString().slice(0, 10);
  const s = String(raw).trim();
  return s || null;
}

function issue(list, sheet, rowNum, severity, field, message) {
  list.push({ sheet_name: sheet, row_number: rowNum, severity, field_name: field, message });
}

// ── main parse ─────────────────────────────────────────────────────────────

export async function parseExcel(file, planId, userId, companyId) {
  const [[plan]] = await pool.query(
    'SELECT * FROM fab_project_plans WHERE id = ? AND company_id = ? AND deleted_at IS NULL',
    [planId, companyId],
  );
  if (!plan)                   throw new Error('Plan not found');
  if (plan.status !== 'Draft') throw new Error('Excel can only be uploaded to a Draft plan');

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file.path);
  fs.unlinkSync(file.path);

  const issues = [];
  const parsed = {};

  // ── Sheet 1: Project_Info ─────────────────────────────────────────────────
  // Columns: project_code(1) project_name(2) client_name(3) site_location(4)
  //          plan_name(5) plan_revision(6) planned_start_date(7) target_end_date(8)
  //          calendar_code(9) scheduling_mode(10) notes(11)
  const s1 = wb.getWorksheet('Project_Info');
  if (s1 && s1.rowCount > 1) {
    const r = s1.getRow(2);
    parsed.projectInfo = {
      project_code:       cellVal(r, 1),
      project_name:       cellVal(r, 2),
      client_name:        cellVal(r, 3),
      site_location:      cellVal(r, 4),
      plan_name:          cellVal(r, 5),
      plan_revision:      cellVal(r, 6),
      planned_start_date: fmtDate(cellVal(r, 7)),
      target_end_date:    fmtDate(cellVal(r, 8)),
      calendar_code:      cellVal(r, 9),
      scheduling_mode:    cellVal(r, 10) ?? 'Forward',
      notes:              cellVal(r, 11),
    };
    if (!parsed.projectInfo.project_code) issue(issues,'Project_Info',2,'Warning','project_code','project_code is empty');
    if (!parsed.projectInfo.project_name) issue(issues,'Project_Info',2,'Warning','project_name','project_name is empty');
  }

  // ── Sheet 2: Nodes ────────────────────────────────────────────────────────
  // Columns 1–18 unchanged; col 19 = preferred_work_area_code (NEW); col 20 = notes
  const s2          = wb.getWorksheet('Nodes');
  const nodes       = [];
  const nodeCodeSet = new Set();
  if (s2) {
    s2.eachRow((row, rowNum) => {
      if (rowNum === 1) return;
      const nodeCode = cellVal(row, 1);
      if (!nodeCode) return;
      if (nodeCodeSet.has(nodeCode)) {
        issue(issues,'Nodes',rowNum,'Error','node_code',`Duplicate node_code: ${nodeCode}`);
      }
      nodeCodeSet.add(nodeCode);

      const displayName = cellVal(row, 2);
      if (!displayName) issue(issues,'Nodes',rowNum,'Error','display_name',`display_name is required for node ${nodeCode}`);

      const dispRaw = (cellVal(row, 18) || '').toLowerCase();
      nodes.push({
        node_code:               nodeCode,
        display_name:            displayName,
        level_name:              cellVal(row, 3),
        description:             cellVal(row, 4),
        quantity:                numVal(row, 5) ?? 1,
        unit:                    cellVal(row, 6) ?? 'Nos',
        parent_node_code:        cellVal(row, 7),
        drawing_ref:             cellVal(row, 8),
        drawing_sheet_no:        cellVal(row, 9),
        drawing_revision:        cellVal(row, 10),
        material_grade:          cellVal(row, 11),
        profile:                 cellVal(row, 12),
        length_mm:               numVal(row, 13),
        width_mm:                numVal(row, 14),
        thickness_mm:            numVal(row, 15),
        weight_kg:               numVal(row, 16),
        location_ref:            cellVal(row, 17),
        dispatchable:            dispRaw === 'yes' ? 1 : 0,
        preferred_work_area_code:cellVal(row, 19),
        notes:                   cellVal(row, 20),
        _row:                    rowNum,
      });
    });
  }

  nodes.forEach((n) => {
    if (n.parent_node_code && !nodeCodeSet.has(n.parent_node_code)) {
      issue(issues,'Nodes',n._row,'Error','parent_node_code',
        `Parent node_code '${n.parent_node_code}' not found in Nodes sheet`);
    }
  });

  // ── Sheet 3: Process_Steps ────────────────────────────────────────────────
  // Original cols 1-10 unchanged.
  // New: col 11=requires_work_area  12=preferred_work_area_code  13=requires_machine
  //      col 14=estimated_machine_time_value  15=estimated_machine_time_unit  16=resource_notes
  const s3          = wb.getWorksheet('Process_Steps');
  const steps       = [];
  const stepCodeSet = new Set();
  if (s3) {
    s3.eachRow((row, rowNum) => {
      if (rowNum === 1) return;
      const stepCode = cellVal(row, 1);
      const procName = cellVal(row, 2);
      if (!stepCode && !procName) return;

      if (stepCode) {
        if (stepCodeSet.has(stepCode)) {
          issue(issues,'Process_Steps',rowNum,'Error','process_step_code',`Duplicate process_step_code: ${stepCode}`);
        }
        stepCodeSet.add(stepCode);
      }
      if (!procName) issue(issues,'Process_Steps',rowNum,'Error','process_name','process_name is required');

      const seqNo = numVal(row, 4);
      if (!seqNo && seqNo !== 0) issue(issues,'Process_Steps',rowNum,'Error','sequence_no','sequence_no is required');

      const mandRaw        = (cellVal(row, 9)  || 'yes').toLowerCase();
      const reqWaRaw       = (cellVal(row, 11) || 'no').toLowerCase();
      const reqMachRaw     = (cellVal(row, 13) || 'no').toLowerCase();
      const prefWaCode     = cellVal(row, 12);
      const reqMachineType = cellVal(row, 6);  // machine_or_workcentre_type doubles as required_machine_type

      if (reqMachRaw === 'yes' && !reqMachineType) {
        issue(issues,'Process_Steps',rowNum,'Warning','machine_or_workcentre_type',
          `requires_machine is Yes but machine_or_workcentre_type is empty for step ${stepCode || procName}`);
      }

      steps.push({
        process_step_code:            stepCode,
        process_name:                 procName,
        process_type:                 cellVal(row, 3),
        sequence_no:                  seqNo,
        parallel_group:               cellVal(row, 5),
        machine_or_workcentre_type:   reqMachineType,
        estimated_time_value:         numVal(row, 7),
        estimated_time_unit:          cellVal(row, 8) ?? 'min',
        mandatory:                    mandRaw === 'yes' ? 1 : 0,
        notes:                        cellVal(row, 10),
        requires_work_area:           reqWaRaw === 'yes' ? 1 : 0,
        preferred_work_area_code:     prefWaCode,
        requires_machine:             reqMachRaw === 'yes' ? 1 : 0,
        estimated_machine_time_value: numVal(row, 14),
        estimated_machine_time_unit:  cellVal(row, 15) ?? 'hr',
        resource_notes:               cellVal(row, 16),
        _row:                         rowNum,
      });
    });
  }

  // ── Sheet 4: Process_Step_Nodes ───────────────────────────────────────────
  const s4        = wb.getWorksheet('Process_Step_Nodes');
  const stepNodes = [];
  const VALID_ROLES = new Set(['Input','Output','Worked-On','Consumed','Reference']);
  if (s4) {
    s4.eachRow((row, rowNum) => {
      if (rowNum === 1) return;
      const stepCode = cellVal(row, 1);
      const nodeCode = cellVal(row, 2);
      if (!stepCode && !nodeCode) return;

      if (stepCode && !stepCodeSet.has(stepCode)) {
        issue(issues,'Process_Step_Nodes',rowNum,'Error','process_step_code',
          `process_step_code '${stepCode}' not found in Process_Steps sheet`);
      }
      if (!nodeCode) {
        issue(issues,'Process_Step_Nodes',rowNum,'Error','node_code','node_code is required');
      } else if (!nodeCodeSet.has(nodeCode)) {
        issue(issues,'Process_Step_Nodes',rowNum,'Error','node_code',
          `node_code '${nodeCode}' not found in Nodes sheet`);
      }

      const role = cellVal(row, 3) ?? 'Worked-On';
      if (!VALID_ROLES.has(role)) {
        issue(issues,'Process_Step_Nodes',rowNum,'Warning','node_role',
          `node_role '${role}' not valid — defaulting to Worked-On`);
      }

      stepNodes.push({
        process_step_code: stepCode,
        node_code:         nodeCode,
        node_role:         VALID_ROLES.has(role) ? role : 'Worked-On',
        quantity:          numVal(row, 4),
        notes:             cellVal(row, 5),
        _row:              rowNum,
      });
    });
  }

  // ── Sheet 5: Process_Preconditions ────────────────────────────────────────
  const s5            = wb.getWorksheet('Process_Preconditions');
  const preconditions = [];
  if (s5) {
    s5.eachRow((row, rowNum) => {
      if (rowNum === 1) return;
      const stepCode    = cellVal(row, 1);
      const reqNodeCode = cellVal(row, 2);
      const reqStepCode = cellVal(row, 3);
      if (!stepCode && !reqStepCode) return;

      if (stepCode && !stepCodeSet.has(stepCode)) {
        issue(issues,'Process_Preconditions',rowNum,'Error','process_step_code',
          `process_step_code '${stepCode}' not found in Process_Steps sheet`);
      }
      if (reqStepCode && !stepCodeSet.has(reqStepCode)) {
        issue(issues,'Process_Preconditions',rowNum,'Error','required_process_step_code',
          `required_process_step_code '${reqStepCode}' not found in Process_Steps sheet`);
      }
      if (reqNodeCode && !nodeCodeSet.has(reqNodeCode)) {
        issue(issues,'Process_Preconditions',rowNum,'Error','required_node_code',
          `required_node_code '${reqNodeCode}' not found in Nodes sheet`);
      }

      preconditions.push({
        process_step_code:          stepCode,
        required_node_code:         reqNodeCode,
        required_process_step_code: reqStepCode,
        required_condition:         cellVal(row, 4) ?? 'Complete',
        notes:                      cellVal(row, 5),
        _row:                       rowNum,
      });
    });
  }

  // ── Sheet 6: Node_Metrics ─────────────────────────────────────────────────
  // Columns: node_code(1)  metric_key(2)  metric_value(3)  metric_unit(4)
  // metric_key examples: weld_length_mm, cut_length_mm, num_holes, num_studs,
  //   paint_area_m2, blast_area_m2, bend_length_mm, grind_length_mm, weight_kg
  const s6         = wb.getWorksheet('Node_Metrics');
  const nodeMetrics = [];
  if (s6) {
    s6.eachRow((row, rowNum) => {
      if (rowNum === 1) return;
      const nodeCode   = cellVal(row, 1);
      const metricKey  = cellVal(row, 2);
      const metricValue = numVal(row, 3);
      if (!nodeCode && !metricKey) return;

      if (!nodeCode) {
        issue(issues,'Node_Metrics',rowNum,'Error','node_code','node_code is required');
        return;
      }
      if (!nodeCodeSet.has(nodeCode)) {
        issue(issues,'Node_Metrics',rowNum,'Error','node_code',
          `node_code '${nodeCode}' not found in Nodes sheet`);
      }
      if (!metricKey) {
        issue(issues,'Node_Metrics',rowNum,'Error','metric_key','metric_key is required');
        return;
      }
      if (metricValue === null) {
        issue(issues,'Node_Metrics',rowNum,'Error','metric_value','metric_value must be a number');
        return;
      }

      nodeMetrics.push({
        node_code:    nodeCode,
        metric_key:   metricKey,
        metric_value: metricValue,
        metric_unit:  cellVal(row, 4),
        _row:         rowNum,
      });
    });
  }

  // ── Sheet 7: Process_WorkArea_Options ─────────────────────────────────────
  const s7              = wb.getWorksheet('Process_WorkArea_Options');
  const workAreaOptions = [];
  if (s7) {
    s7.eachRow((row, rowNum) => {
      if (rowNum === 1) return;
      const stepCode = cellVal(row, 1);
      const waCode   = cellVal(row, 2);
      if (!stepCode && !waCode) return;

      if (stepCode && !stepCodeSet.has(stepCode)) {
        issue(issues,'Process_WorkArea_Options',rowNum,'Error','process_step_code',
          `process_step_code '${stepCode}' not found in Process_Steps sheet`);
      }
      if (!waCode) {
        issue(issues,'Process_WorkArea_Options',rowNum,'Error','work_area_code','work_area_code is required');
      }

      workAreaOptions.push({
        process_step_code: stepCode,
        work_area_code:    waCode,
        priority:          numVal(row, 3) ?? 1,
        notes:             cellVal(row, 4),
        _row:              rowNum,
      });
    });
  }

  const errorCount   = issues.filter((i) => i.severity === 'Error').length;
  const warningCount = issues.filter((i) => i.severity === 'Warning').length;

  const [batchRes] = await pool.query(
    `INSERT INTO fab_excel_import_batches
       (project_plan_id, file_name, uploaded_by, status, error_count, warning_count, parsed_data)
     VALUES (?,?,?,?,?,?,?)`,
    [planId, file.originalname, userId,
     errorCount > 0 ? 'Failed' : 'Parsed',
     errorCount, warningCount,
     JSON.stringify({ nodes, steps, stepNodes, preconditions, workAreaOptions, nodeMetrics, projectInfo: parsed.projectInfo })],
  );
  const batchId = batchRes.insertId;

  if (issues.length) {
    await pool.query(
      `INSERT INTO fab_excel_import_issues (import_batch_id, sheet_name, \`row_number\`, severity, field_name, message) VALUES ?`,
      [issues.map((i) => [batchId, i.sheet_name, i.row_number, i.severity, i.field_name, i.message])],
    );
  }

  return {
    batchId,
    status:       errorCount > 0 ? 'Failed' : 'Parsed',
    errorCount,
    warningCount,
    preview:      { projectInfo: parsed.projectInfo, nodes, steps, stepNodes, preconditions, workAreaOptions, nodeMetrics },
    issues,
  };
}

// ── import validated batch into the plan ──────────────────────────────────

export async function importBatch(batchId, userId, companyId) {
  const [[batch]] = await pool.query(
    `SELECT b.*, p.company_id, p.status AS planStatus
       FROM fab_excel_import_batches b
       JOIN fab_project_plans p ON p.id = b.project_plan_id
      WHERE b.id = ? AND b.deleted_at IS NULL`,
    [batchId],
  );
  if (!batch)                         throw new Error('Import batch not found');
  if (batch.company_id !== companyId) throw new Error('Access denied');
  if (batch.planStatus !== 'Draft')   throw new Error('Plan is no longer a Draft');
  if (batch.status !== 'Parsed')      throw new Error(`Batch status is '${batch.status}' — only Parsed batches can be imported`);

  const { nodes, steps, stepNodes, preconditions, workAreaOptions, nodeMetrics, projectInfo } =
    JSON.parse(batch.parsed_data);
  const planId = batch.project_plan_id;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // ── Resolve calendar_code to calendar_id if present ───────────────────
    let calendarId = null;
    if (projectInfo?.calendar_code) {
      const [[calRow]] = await conn.query(
        'SELECT id FROM fab_work_calendars WHERE company_id = ? AND calendar_code = ? AND deleted_at IS NULL',
        [companyId, projectInfo.calendar_code],
      );
      calendarId = calRow?.id ?? null;
    }

    // ── Update plan with scheduling fields ────────────────────────────────
    if (projectInfo) {
      await conn.query(
        `UPDATE fab_project_plans
            SET project_code = COALESCE(?, project_code),
                project_name = COALESCE(?, project_name),
                client_name  = COALESCE(?, client_name),
                site_location= COALESCE(?, site_location),
                plan_name    = COALESCE(?, plan_name),
                plan_revision= COALESCE(?, plan_revision),
                planned_start_date = ?,
                target_end_date    = ?,
                calendar_id        = COALESCE(?, calendar_id),
                scheduling_mode    = COALESCE(?, scheduling_mode),
                notes        = COALESCE(?, notes)
          WHERE id = ?`,
        [projectInfo.project_code, projectInfo.project_name, projectInfo.client_name,
         projectInfo.site_location, projectInfo.plan_name, projectInfo.plan_revision,
         projectInfo.planned_start_date || null, projectInfo.target_end_date || null,
         calendarId, projectInfo.scheduling_mode,
         projectInfo.notes, planId],
      );
    }

    // ── Insert nodes ──────────────────────────────────────────────────────
    const nodeCodeToId = {};
    for (const n of nodes) {
      // Resolve preferred_work_area_code -> id
      let prefWaId = null;
      if (n.preferred_work_area_code) {
        const [[waRow]] = await conn.query(
          'SELECT id FROM fab_work_areas WHERE company_id = ? AND work_area_code = ? AND deleted_at IS NULL',
          [companyId, n.preferred_work_area_code],
        );
        prefWaId = waRow?.id ?? null;
      }
      const [r] = await conn.query(
        `INSERT INTO fab_nodes
           (project_plan_id, node_code, display_name, level_name, description, quantity, unit,
            drawing_ref, drawing_sheet_no, drawing_revision, material_grade, profile,
            length_mm, width_mm, thickness_mm, weight_kg, location_ref, dispatchable,
            preferred_work_area_id, notes)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [planId, n.node_code, n.display_name, n.level_name, n.description,
         n.quantity, n.unit, n.drawing_ref, n.drawing_sheet_no, n.drawing_revision,
         n.material_grade, n.profile, n.length_mm, n.width_mm, n.thickness_mm,
         n.weight_kg, n.location_ref, n.dispatchable, prefWaId, n.notes],
      );
      nodeCodeToId[n.node_code] = r.insertId;
    }

    // ── Insert relationships ───────────────────────────────────────────────
    for (const n of nodes) {
      if (!n.parent_node_code) continue;
      const parentId = nodeCodeToId[n.parent_node_code];
      const childId  = nodeCodeToId[n.node_code];
      if (parentId && childId) {
        await conn.query(
          `INSERT IGNORE INTO fab_node_relationships
             (project_plan_id, parent_node_id, child_node_id, quantity_required, relationship_type, is_primary)
           VALUES (?,?,?,1,'Assembly',1)`,
          [planId, parentId, childId],
        );
      }
    }

    // ── Insert / replace node metrics ─────────────────────────────────────
    for (const m of (nodeMetrics ?? [])) {
      const nodeId = nodeCodeToId[m.node_code];
      if (!nodeId) continue;
      await conn.query(
        `INSERT INTO fab_node_metrics (node_id, company_id, metric_key, metric_value, metric_unit)
         VALUES (?,?,?,?,?)
         ON DUPLICATE KEY UPDATE metric_value=VALUES(metric_value), metric_unit=VALUES(metric_unit)`,
        [nodeId, companyId, m.metric_key, m.metric_value, m.metric_unit],
      );
    }

    // ── Insert process steps ───────────────────────────────────────────────
    const stepCodeToId = {};
    for (const s of steps) {
      // Resolve preferred_work_area_code -> id
      let prefWaId = null;
      if (s.preferred_work_area_code) {
        const [[waRow]] = await conn.query(
          'SELECT id FROM fab_work_areas WHERE company_id = ? AND work_area_code = ? AND deleted_at IS NULL',
          [companyId, s.preferred_work_area_code],
        );
        prefWaId = waRow?.id ?? null;
      }
      const [r] = await conn.query(
        `INSERT INTO fab_process_steps
           (project_plan_id, company_id, process_step_code, process_name, process_type,
            sequence_no, parallel_group, machine_or_workcentre_type,
            estimated_time_value, estimated_time_unit, mandatory, notes,
            requires_work_area, preferred_work_area_id, requires_machine,
            estimated_machine_time_value, estimated_machine_time_unit, resource_notes)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [planId, companyId, s.process_step_code, s.process_name, s.process_type,
         s.sequence_no, s.parallel_group, s.machine_or_workcentre_type,
         s.estimated_time_value, s.estimated_time_unit, s.mandatory, s.notes,
         s.requires_work_area, prefWaId, s.requires_machine,
         s.estimated_machine_time_value, s.estimated_machine_time_unit, s.resource_notes],
      );
      if (s.process_step_code) stepCodeToId[s.process_step_code] = r.insertId;
    }

    // ── Insert step → node mappings ────────────────────────────────────────
    for (const sn of stepNodes) {
      const stepId = stepCodeToId[sn.process_step_code];
      const nodeId = nodeCodeToId[sn.node_code];
      if (stepId && nodeId) {
        await conn.query(
          `INSERT INTO fab_process_step_node_map
             (process_step_id, node_id, company_id, node_role, quantity, notes)
           VALUES (?,?,?,?,?,?)`,
          [stepId, nodeId, companyId, sn.node_role, sn.quantity, sn.notes],
        );
      }
    }

    // ── Insert preconditions ──────────────────────────────────────────────
    for (const pc of preconditions) {
      const stepId    = stepCodeToId[pc.process_step_code];
      const reqStepId = pc.required_process_step_code ? stepCodeToId[pc.required_process_step_code] : null;
      const reqNodeId = pc.required_node_code ? nodeCodeToId[pc.required_node_code] : null;
      if (stepId) {
        await conn.query(
          `INSERT INTO fab_process_preconditions
             (process_step_id, company_id, required_node_id, required_process_step_id, required_condition, notes)
           VALUES (?,?,?,?,?,?)`,
          [stepId, companyId, reqNodeId, reqStepId, pc.required_condition, pc.notes],
        );
      }
    }

    // ── Insert process work area options ──────────────────────────────────
    for (const opt of (workAreaOptions ?? [])) {
      const stepId = stepCodeToId[opt.process_step_code];
      if (!stepId || !opt.work_area_code) continue;
      const [[waRow]] = await conn.query(
        'SELECT id FROM fab_work_areas WHERE company_id = ? AND work_area_code = ? AND deleted_at IS NULL',
        [companyId, opt.work_area_code],
      );
      const waId = waRow?.id ?? null;
      if (stepId && waId) {
        await conn.query(
          `INSERT IGNORE INTO fab_process_work_area_options
             (process_step_id, work_area_id, company_id, priority, notes)
           VALUES (?,?,?,?,?)`,
          [stepId, waId, companyId, opt.priority, opt.notes],
        );
      }
    }

    await conn.query(`UPDATE fab_excel_import_batches SET status = 'Imported' WHERE id = ?`, [batchId]);
    await conn.query(`UPDATE fab_project_plans SET source = 'Excel Upload' WHERE id = ?`, [planId]);

    await conn.commit();
    return {
      planId,
      nodesImported:         nodes.length,
      stepsImported:         steps.length,
      stepNodesImported:     stepNodes.length,
      precondsImported:      preconditions.length,
      workAreaOptsImported:  (workAreaOptions ?? []).length,
      nodeMetricsImported:   (nodeMetrics ?? []).length,
    };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}
