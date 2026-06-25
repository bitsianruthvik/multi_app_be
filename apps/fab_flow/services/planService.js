import { pool } from '../../../db.js';

export async function approvePlan(planId, userId, companyId) {
  const [[plan]] = await pool.query(
    'SELECT * FROM fab_project_plans WHERE id = ? AND company_id = ? AND deleted_at IS NULL',
    [planId, companyId],
  );
  if (!plan)            throw new Error('Plan not found');
  if (plan.status !== 'Draft') throw new Error('Only Draft plans can be approved');

  await pool.query(
    `UPDATE fab_project_plans SET status = 'Approved', approved_by = ?, approved_at = NOW() WHERE id = ?`,
    [userId, planId],
  );
  return { id: planId, status: 'Approved' };
}

export async function revisePlan(planId, userId, companyId) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [[original]] = await conn.query(
      'SELECT * FROM fab_project_plans WHERE id = ? AND company_id = ? AND deleted_at IS NULL',
      [planId, companyId],
    );
    if (!original) throw new Error('Plan not found');
    if (original.status !== 'Approved') throw new Error('Only Approved plans can be revised');

    const currentRev  = parseInt(original.plan_revision.replace(/\D/g, ''), 10) || 0;
    const newRevision = `Rev ${currentRev + 1}`;

    const [newPlanRes] = await conn.query(
      `INSERT INTO fab_project_plans
         (project_code, project_name, client_name, site_location, plan_name, plan_revision,
          status, source, notes, company_id, created_by,
          calendar_id, planned_start_date, target_end_date, scheduling_mode)
       VALUES (?,?,?,?,?,?,'Draft',?,?,?,?,?,?,?,?)`,
      [original.project_code, original.project_name, original.client_name, original.site_location,
       original.plan_name, newRevision, original.source, original.notes, original.company_id, userId,
       original.calendar_id, original.planned_start_date, original.target_end_date, original.scheduling_mode],
    );
    const newPlanId = newPlanRes.insertId;

    // Clone nodes (with preferred_work_area_id)
    const [nodes] = await conn.query(
      'SELECT * FROM fab_nodes WHERE project_plan_id = ? AND deleted_at IS NULL',
      [planId],
    );
    const nodeMap = {};
    for (const n of nodes) {
      const [r] = await conn.query(
        `INSERT INTO fab_nodes
           (project_plan_id, node_code, display_name, level_name, description, quantity, unit,
            drawing_ref, drawing_sheet_no, drawing_revision, material_grade, profile,
            length_mm, width_mm, thickness_mm, weight_kg, location_ref, dispatchable,
            preferred_work_area_id, notes)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [newPlanId, n.node_code, n.display_name, n.level_name, n.description,
         n.quantity, n.unit, n.drawing_ref, n.drawing_sheet_no, n.drawing_revision,
         n.material_grade, n.profile, n.length_mm, n.width_mm, n.thickness_mm,
         n.weight_kg, n.location_ref, n.dispatchable, n.preferred_work_area_id, n.notes],
      );
      nodeMap[n.id] = r[0]?.insertId ?? r.insertId;
    }

    // Clone relationships
    const [rels] = await conn.query(
      'SELECT * FROM fab_node_relationships WHERE project_plan_id = ? AND deleted_at IS NULL',
      [planId],
    );
    for (const rel of rels) {
      const newParent = nodeMap[rel.parent_node_id];
      const newChild  = nodeMap[rel.child_node_id];
      if (newParent && newChild) {
        await conn.query(
          `INSERT INTO fab_node_relationships
             (project_plan_id, parent_node_id, child_node_id, quantity_required, relationship_type, is_primary, notes)
           VALUES (?,?,?,?,?,?,?)`,
          [newPlanId, newParent, newChild, rel.quantity_required, rel.relationship_type, rel.is_primary, rel.notes],
        );
      }
    }

    // Clone process steps (with all new resource fields)
    const [steps] = await conn.query(
      'SELECT * FROM fab_process_steps WHERE project_plan_id = ? AND deleted_at IS NULL',
      [planId],
    );
    const stepMap = {};
    for (const s of steps) {
      const [r] = await conn.query(
        `INSERT INTO fab_process_steps
           (project_plan_id, company_id, process_step_code, process_name, process_type,
            sequence_no, parallel_group, machine_or_workcentre_type,
            estimated_time_value, estimated_time_unit, mandatory, notes,
            requires_work_area, preferred_work_area_id, requires_machine,
            estimated_machine_time_value, estimated_machine_time_unit, resource_notes)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [newPlanId, companyId, s.process_step_code, s.process_name, s.process_type,
         s.sequence_no, s.parallel_group, s.machine_or_workcentre_type,
         s.estimated_time_value, s.estimated_time_unit, s.mandatory, s.notes,
         s.requires_work_area, s.preferred_work_area_id, s.requires_machine,
         s.estimated_machine_time_value, s.estimated_machine_time_unit, s.resource_notes],
      );
      stepMap[s.id] = r[0]?.insertId ?? r.insertId;
    }

    // Clone node maps
    const [nodeMaps] = steps.length
      ? await conn.query(
          `SELECT * FROM fab_process_step_node_map
           WHERE process_step_id IN (?) AND deleted_at IS NULL`,
          [steps.map((s) => s.id)],
        )
      : [[]];
    for (const nm of nodeMaps) {
      const newStepId = stepMap[nm.process_step_id];
      const newNodeId = nodeMap[nm.node_id];
      if (newStepId && newNodeId) {
        await conn.query(
          `INSERT INTO fab_process_step_node_map
             (process_step_id, node_id, company_id, node_role, quantity, notes)
           VALUES (?,?,?,?,?,?)`,
          [newStepId, newNodeId, companyId, nm.node_role, nm.quantity, nm.notes],
        );
      }
    }

    // Clone preconditions
    const [preconds] = steps.length
      ? await conn.query(
          `SELECT * FROM fab_process_preconditions
           WHERE process_step_id IN (?) AND deleted_at IS NULL`,
          [steps.map((s) => s.id)],
        )
      : [[]];
    for (const pc of preconds) {
      const newStepId    = stepMap[pc.process_step_id];
      const newReqStepId = pc.required_process_step_id ? stepMap[pc.required_process_step_id] : null;
      const newReqNodeId = pc.required_node_id ? nodeMap[pc.required_node_id] : null;
      if (newStepId) {
        await conn.query(
          `INSERT INTO fab_process_preconditions
             (process_step_id, company_id, required_node_id, required_process_step_id, required_condition, notes)
           VALUES (?,?,?,?,?,?)`,
          [newStepId, companyId, newReqNodeId, newReqStepId, pc.required_condition, pc.notes],
        );
      }
    }

    // Clone process work area options (work_area_id stays the same — company-wide master)
    const [waOptions] = steps.length
      ? await conn.query(
          `SELECT * FROM fab_process_work_area_options WHERE process_step_id IN (?)`,
          [steps.map((s) => s.id)],
        )
      : [[]];
    for (const opt of waOptions) {
      const newStepId = stepMap[opt.process_step_id];
      if (newStepId) {
        await conn.query(
          `INSERT IGNORE INTO fab_process_work_area_options
             (process_step_id, work_area_id, company_id, priority, notes)
           VALUES (?,?,?,?,?)`,
          [newStepId, opt.work_area_id, companyId, opt.priority, opt.notes],
        );
      }
    }

    // Supersede original
    await conn.query(
      `UPDATE fab_project_plans SET status = 'Superseded' WHERE id = ?`,
      [planId],
    );

    await conn.commit();
    return { id: newPlanId, planRevision: newRevision, status: 'Draft' };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

export async function getPlanReadiness(planId, companyId) {
  const [[plan]] = await pool.query(
    `SELECT p.id, p.plan_name, p.plan_revision,
            p.calendar_id, p.planned_start_date, p.target_end_date, p.scheduling_mode,
            wc.calendar_code, wc.calendar_name
     FROM fab_project_plans p
     LEFT JOIN fab_work_calendars wc ON wc.id = p.calendar_id
     WHERE p.id = ? AND p.company_id = ? AND p.deleted_at IS NULL`,
    [planId, companyId],
  );
  if (!plan) throw new Error('Plan not found');

  const [steps] = await pool.query(
    `SELECT s.id, s.process_step_code, s.process_name, s.process_type, s.sequence_no,
            s.parallel_group, s.machine_or_workcentre_type,
            s.estimated_time_value, s.estimated_time_unit, s.mandatory, s.notes,
            s.requires_work_area, s.preferred_work_area_id, s.requires_machine,
            s.estimated_machine_time_value, s.estimated_machine_time_unit, s.resource_notes,
            s.time_calc_mode, s.time_metric_key, s.time_rate_value, s.time_rate_unit,
            wa.work_area_code AS preferred_work_area_code,
            wa.work_area_name AS preferred_work_area_name
     FROM fab_process_steps s
     LEFT JOIN fab_work_areas wa ON wa.id = s.preferred_work_area_id
     WHERE s.project_plan_id = ? AND s.deleted_at IS NULL
     ORDER BY s.sequence_no`,
    [planId],
  );

  if (steps.length === 0) {
    return {
      planName: `${plan.plan_name} (${plan.plan_revision})`,
      calendarCode: plan.calendar_code,
      calendarName: plan.calendar_name,
      plannedStartDate: plan.planned_start_date,
      targetEndDate: plan.target_end_date,
      schedulingMode: plan.scheduling_mode,
      steps: [],
    };
  }

  const stepIds = steps.map((s) => s.id);

  const [nodeMaps] = await pool.query(
    `SELECT fpsnm.id, fpsnm.process_step_id, fpsnm.node_id, fpsnm.node_role,
            fpsnm.quantity, fpsnm.notes,
            fn.node_code, fn.display_name AS node_display_name
     FROM fab_process_step_node_map fpsnm
     JOIN fab_nodes fn ON fn.id = fpsnm.node_id
     WHERE fpsnm.process_step_id IN (?) AND fpsnm.deleted_at IS NULL`,
    [stepIds],
  );

  const [preconditions] = await pool.query(
    `SELECT fppc.id, fppc.process_step_id,
            fppc.required_process_step_id, fppc.required_node_id,
            fppc.required_condition, fppc.notes,
            fps_req.process_step_code AS required_step_code,
            fps_req.process_name      AS required_step_name,
            fn_req.node_code          AS required_node_code
     FROM fab_process_preconditions fppc
     LEFT JOIN fab_process_steps fps_req ON fps_req.id = fppc.required_process_step_id
     LEFT JOIN fab_nodes fn_req          ON fn_req.id  = fppc.required_node_id
     WHERE fppc.process_step_id IN (?) AND fppc.deleted_at IS NULL`,
    [stepIds],
  );

  const [workAreaOpts] = await pool.query(
    `SELECT opt.process_step_id, opt.priority, opt.notes,
            wa.work_area_code, wa.work_area_name
     FROM fab_process_work_area_options opt
     JOIN fab_work_areas wa ON wa.id = opt.work_area_id
     WHERE opt.process_step_id IN (?)
     ORDER BY opt.priority`,
    [stepIds],
  );

  // Group by step id
  const nmByStep  = {};
  const pcByStep  = {};
  const waByStep  = {};
  for (const nm of nodeMaps)    (nmByStep[nm.process_step_id] ??= []).push(nm);
  for (const pc of preconditions)(pcByStep[pc.process_step_id] ??= []).push(pc);
  for (const wa of workAreaOpts) (waByStep[wa.process_step_id] ??= []).push(wa);

  const result = steps.map((s) => {
    const stepPreconds = pcByStep[s.id] ?? [];
    // Resource completeness check
    const missingWorkArea = s.requires_work_area &&
      !s.preferred_work_area_id && (waByStep[s.id] ?? []).length === 0;
    const missingMachineType = s.requires_machine && !s.machine_or_workcentre_type;

    return {
      id:                        s.id,
      processStepCode:           s.process_step_code,
      processName:               s.process_name,
      processType:               s.process_type,
      sequenceNo:                s.sequence_no,
      parallelGroup:             s.parallel_group,
      machineOrWorkcentreType:   s.machine_or_workcentre_type,
      estimatedTimeValue:        s.estimated_time_value,
      estimatedTimeUnit:         s.estimated_time_unit,
      mandatory:                 Boolean(s.mandatory),
      notes:                     s.notes,
      requiresWorkArea:          Boolean(s.requires_work_area),
      preferredWorkAreaId:       s.preferred_work_area_id,
      preferredWorkAreaCode:     s.preferred_work_area_code,
      preferredWorkAreaName:     s.preferred_work_area_name,
      requiresMachine:           Boolean(s.requires_machine),
      estimatedMachineTimeValue: s.estimated_machine_time_value,
      estimatedMachineTimeUnit:  s.estimated_machine_time_unit,
      resourceNotes:             s.resource_notes,
      timeCalcMode:              s.time_calc_mode,
      timeMetricKey:             s.time_metric_key,
      timeRateValue:             s.time_rate_value,
      timeRateUnit:              s.time_rate_unit,
      allowedWorkAreas:          waByStep[s.id] ?? [],
      missingWorkArea,
      missingMachineType,
      resourceComplete:          !missingWorkArea && !missingMachineType,
      nodeMaps: (nmByStep[s.id] ?? []).map((nm) => ({
        id:              nm.id,
        nodeId:          nm.node_id,
        nodeRole:        nm.node_role,
        nodeCode:        nm.node_code,
        nodeDisplayName: nm.node_display_name,
        quantity:        nm.quantity,
        notes:           nm.notes,
      })),
      preconditions: stepPreconds.map((pc) => ({
        id:                    pc.id,
        requiredProcessStepId: pc.required_process_step_id,
        requiredNodeId:        pc.required_node_id,
        requiredCondition:     pc.required_condition,
        notes:                 pc.notes,
        requiredStepCode:      pc.required_step_code,
        requiredStepName:      pc.required_step_name,
        requiredNodeCode:      pc.required_node_code,
      })),
      ready: stepPreconds.length === 0,
    };
  });

  return {
    planName:         `${plan.plan_name} (${plan.plan_revision})`,
    calendarCode:     plan.calendar_code,
    calendarName:     plan.calendar_name,
    plannedStartDate: plan.planned_start_date,
    targetEndDate:    plan.target_end_date,
    schedulingMode:   plan.scheduling_mode,
    steps:            result,
  };
}
