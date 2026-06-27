/**
 * routes/routing.js
 * -----------------
 * Visual Routing Plan Builder API
 *
 * Routing Plans:
 *   GET  /routing/boms                      — all BOMs with catalog item names
 *   GET  /routing/plans?bomId=X             — plans for a BOM
 *   POST /routing/plans                     — create plan
 *   GET  /routing/plans/:id                 — full plan (steps + deps + inputs + outputs + formulas)
 *   PUT  /routing/plans/:id                 — update plan header
 *   POST /routing/plans/:id/validate        — validate graph
 *   POST /routing/plans/:id/release         — release plan
 *
 * Steps:
 *   POST   /routing/steps                   — create step
 *   PUT    /routing/steps/:id               — update step
 *   PATCH  /routing/steps/:id/pos           — update canvas position
 *   DELETE /routing/steps/:id               — delete step (cascades deps/inputs/outputs/formulas)
 *
 * Deps (edges):
 *   POST   /routing/deps                    — create dep
 *   DELETE /routing/deps/:id                — delete dep
 *
 * Inputs per step:
 *   POST   /routing/inputs                  — create input
 *   DELETE /routing/inputs/:id              — delete input
 *
 * Outputs per step:
 *   POST   /routing/outputs                 — create output
 *   PUT    /routing/outputs/:id             — update output
 *   DELETE /routing/outputs/:id             — delete output
 *
 * Formulas per step:
 *   POST   /routing/formulas                — upsert formula (by stepId + formulaType)
 *   DELETE /routing/formulas/:id            — delete formula
 *
 * Resource type variables (for formula hints):
 *   GET  /routing/resource-type-vars/:rtId  — formula variable list for a resource type
 */

import { Router } from 'express';
import { protect } from '../../../core/middleware/authmiddleware.js';
import { pool }    from '../../../db.js';

const router = Router();

// ─── CamelCase helpers ────────────────────────────────────────────────────────
const toCamelKey = s => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
const cc  = row  => { if (!row) return row; const o = {}; for (const k of Object.keys(row)) o[toCamelKey(k)] = row[k]; return o; };
const ccs = rows => rows.map(cc);
// Group array by a snake_case key, converting each row to camelCase
const byStepCC = (arr, key = 'step_id') => {
  const map = {};
  arr.forEach(r => { const k = r[key]; if (!map[k]) map[k] = []; map[k].push(cc(r)); });
  return map;
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function hasCycle(stepIds, deps) {
  const adj = new Map();
  stepIds.forEach(id => adj.set(id, []));
  deps.forEach(d => {
    if (adj.has(d.from_step_id)) adj.get(d.from_step_id).push(d.to_step_id);
  });

  const visited  = new Set();
  const recStack = new Set();

  function dfs(nodeId) {
    visited.add(nodeId);
    recStack.add(nodeId);
    for (const nb of (adj.get(nodeId) ?? [])) {
      if (!visited.has(nb)) {
        if (dfs(nb)) return true;
      } else if (recStack.has(nb)) {
        return true;
      }
    }
    recStack.delete(nodeId);
    return false;
  }

  for (const id of stepIds) {
    if (!visited.has(id) && dfs(id)) return true;
  }
  return false;
}

async function validatePlan(planId, companyId) {
  const errors = [];

  const [steps] = await pool.query(
    `SELECT id, name, resource_type_id FROM fab_routing_op_steps
     WHERE routing_plan_id = ? AND company_id = ? AND deleted_at IS NULL`,
    [planId, companyId],
  );

  const [deps] = await pool.query(
    `SELECT from_step_id, to_step_id FROM fab_routing_op_deps
     WHERE routing_plan_id = ? AND company_id = ? AND deleted_at IS NULL`,
    [planId, companyId],
  );

  if (steps.length === 0) {
    errors.push('Routing plan must have at least one operation step.');
    return errors;
  }

  // Name check
  steps.forEach(s => {
    if (!s.name || !s.name.trim()) errors.push(`An operation step is missing a name.`);
  });

  // Resource type check
  steps.forEach(s => {
    if (!s.resource_type_id) errors.push(`Step "${s.name}" does not have a resource type assigned.`);
  });

  // Cycle check
  if (hasCycle(steps.map(s => s.id), deps)) {
    errors.push('Circular dependency detected between operation steps.');
  }

  // Connectivity check (for plans with more than 1 step, every step must have at least one edge)
  if (steps.length > 1) {
    const connectedIds = new Set([
      ...deps.map(d => d.from_step_id),
      ...deps.map(d => d.to_step_id),
    ]);
    steps.forEach(s => {
      if (!connectedIds.has(s.id)) {
        errors.push(`Step "${s.name}" is not connected to any other operation.`);
      }
    });
  }

  return errors;
}

// ─── GET /routing/boms ───────────────────────────────────────────────────────
router.get('/routing/boms', protect, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT fmb.id, fmb.name AS bom_name, fmb.is_default, fmb.base_qty, fmb.base_unit,
              fic.id AS catalog_item_id, fic.name AS catalog_item_name, fic.code AS catalog_item_code,
              cat.name AS category_name, grp.name AS group_name,
              (SELECT COUNT(*) FROM fab_material_bom_items
                 WHERE bom_id = fmb.id AND deleted_at IS NULL) AS item_count
         FROM fab_material_boms fmb
         JOIN fab_item_catalog fic ON fic.id = fmb.catalog_item_id
         LEFT JOIN fab_item_categories cat ON cat.id = fic.category_id
         LEFT JOIN fab_item_groups     grp ON grp.id = fic.group_id
        WHERE fmb.company_id = ? AND fmb.deleted_at IS NULL AND fic.deleted_at IS NULL
        ORDER BY fic.name, fmb.name`,
      [req.user.companyId],
    );
    // kept snake_case (not run through ccs()) — the frontend already consumes this
    // endpoint's existing fields as snake_case (bom_name, catalog_item_name, ...).
    res.json({ data: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /routing/plans ──────────────────────────────────────────────────────
router.get('/routing/plans', protect, async (req, res) => {
  try {
    const { bomId } = req.query;
    let sql = `
      SELECT frp.*,
             fmb.name AS bom_name,
             fic.name AS catalog_item_name, fic.code AS catalog_item_code,
             (SELECT COUNT(*) FROM fab_routing_op_steps WHERE routing_plan_id = frp.id AND deleted_at IS NULL) AS step_count
        FROM fab_routing_plans frp
        JOIN fab_material_boms fmb ON fmb.id = frp.bom_id
        JOIN fab_item_catalog  fic ON fic.id  = fmb.catalog_item_id
       WHERE frp.company_id = ? AND frp.deleted_at IS NULL`;
    const params = [req.user.companyId];
    if (bomId) { sql += ' AND frp.bom_id = ?'; params.push(bomId); }
    sql += ' ORDER BY frp.updated_at DESC';
    const [rows] = await pool.query(sql, params);
    res.json({ data: ccs(rows) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /routing/plans ─────────────────────────────────────────────────────
router.post('/routing/plans', protect, async (req, res) => {
  try {
    const { bomId, name, notes } = req.body;
    if (!bomId || !name) return res.status(400).json({ error: 'bomId and name are required' });

    const [result] = await pool.query(
      `INSERT INTO fab_routing_plans (company_id, bom_id, name, notes, version_no, is_current, status)
       VALUES (?, ?, ?, ?, 1, 1, 'draft')`,
      [req.user.companyId, bomId, name, notes ?? null],
    );
    res.json({ id: result.insertId, ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /routing/plans/:id ──────────────────────────────────────────────────
router.get('/routing/plans/:id', protect, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const planId = parseInt(req.params.id);

    const [[plan]] = await pool.query(
      `SELECT frp.*, fmb.name AS bom_name, fmb.catalog_item_id,
              fic.name AS catalog_item_name, fic.code AS catalog_item_code
         FROM fab_routing_plans frp
         JOIN fab_material_boms fmb ON fmb.id = frp.bom_id
         JOIN fab_item_catalog  fic ON fic.id  = fmb.catalog_item_id
        WHERE frp.id = ? AND frp.company_id = ? AND frp.deleted_at IS NULL`,
      [planId, companyId],
    );
    if (!plan) return res.status(404).json({ error: 'Plan not found' });

    const [steps] = await pool.query(
      `SELECT fros.*, frt.name AS resource_type_name, frt.code AS resource_type_code
         FROM fab_routing_op_steps fros
         LEFT JOIN fab_resource_types frt ON frt.id = fros.resource_type_id
        WHERE fros.routing_plan_id = ? AND fros.company_id = ? AND fros.deleted_at IS NULL
        ORDER BY fros.seq_no, fros.id`,
      [planId, companyId],
    );

    const [deps] = await pool.query(
      `SELECT * FROM fab_routing_op_deps
        WHERE routing_plan_id = ? AND company_id = ? AND deleted_at IS NULL`,
      [planId, companyId],
    );

    const stepIds = steps.map(s => s.id);
    let inputs = [], outputs = [], formulas = [];

    if (stepIds.length > 0) {
      [inputs] = await pool.query(
        `SELECT froi.*, fmbi.name AS bom_item_name
           FROM fab_routing_op_inputs froi
           LEFT JOIN fab_material_bom_items fmbi ON fmbi.id = froi.bom_item_id
          WHERE froi.step_id IN (?) AND froi.company_id = ? AND froi.deleted_at IS NULL`,
        [stepIds, companyId],
      );
      [outputs] = await pool.query(
        `SELECT * FROM fab_routing_op_outputs
          WHERE step_id IN (?) AND company_id = ? AND deleted_at IS NULL`,
        [stepIds, companyId],
      );
      [formulas] = await pool.query(
        `SELECT * FROM fab_routing_op_formulas
          WHERE step_id IN (?) AND company_id = ? AND deleted_at IS NULL`,
        [stepIds, companyId],
      );
    }

    // group by stepId
    res.json({
      plan:     cc(plan),
      steps:    ccs(steps),
      deps:     ccs(deps),
      inputs:   byStepCC(inputs),
      outputs:  byStepCC(outputs),
      formulas: byStepCC(formulas),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── PUT /routing/plans/:id ──────────────────────────────────────────────────
router.put('/routing/plans/:id', protect, async (req, res) => {
  try {
    const { name, notes } = req.body;
    await pool.query(
      `UPDATE fab_routing_plans SET name = ?, notes = ? WHERE id = ? AND company_id = ?`,
      [name, notes ?? null, req.params.id, req.user.companyId],
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /routing/plans/:id/validate ────────────────────────────────────────
router.post('/routing/plans/:id/validate', protect, async (req, res) => {
  try {
    const errors = await validatePlan(parseInt(req.params.id), req.user.companyId);
    res.json({ valid: errors.length === 0, errors });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /routing/plans/:id/release ─────────────────────────────────────────
router.post('/routing/plans/:id/release', protect, async (req, res) => {
  try {
    const planId    = parseInt(req.params.id);
    const companyId = req.user.companyId;

    const errors = await validatePlan(planId, companyId);
    if (errors.length > 0) return res.status(400).json({ valid: false, errors });

    await pool.query(
      `UPDATE fab_routing_plans SET status = 'released', released_by = ?, released_at = NOW()
        WHERE id = ? AND company_id = ?`,
      [req.user.id, planId, companyId],
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /routing/bom-items/:bomId ───────────────────────────────────────────
// Returns all BOM items split into inputs (components) and outputs (co_products)
router.get('/routing/bom-items/:bomId', protect, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT fmbi.id, fmbi.name, fmbi.qty, fmbi.unit, fmbi.item_category,
              fic.name AS ref_item_name, fic.code AS ref_item_code
         FROM fab_material_bom_items fmbi
         LEFT JOIN fab_item_catalog fic ON fic.id = fmbi.ref_catalog_item_id
        WHERE fmbi.bom_id = ? AND fmbi.company_id = ? AND fmbi.deleted_at IS NULL
        ORDER BY fmbi.item_category, fmbi.name`,
      [req.params.bomId, req.user.companyId],
    );
    res.json({ data: ccs(rows) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /routing/resource-types ─────────────────────────────────────────────
router.get('/routing/resource-types', protect, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, name, code, category FROM fab_resource_types
        WHERE company_id = ? AND deleted_at IS NULL ORDER BY name`,
      [req.user.companyId],
    );
    res.json({ data: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /routing/resource-type-vars/:rtId ───────────────────────────────────
router.get('/routing/resource-type-vars/:rtId', protect, async (req, res) => {
  try {
    const [rt] = await pool.query(
      `SELECT id, name, capacity_hrs_per_day, num_units, utilization_pct, efficiency_pct,
              overload_pct, setup_time_hrs, teardown_time_hrs, queue_time_hrs, move_time_hrs,
              scheduling_basis, cost_per_hour, currency
         FROM fab_resource_types WHERE id = ? AND company_id = ?`,
      [req.params.rtId, req.user.companyId],
    );
    const [props] = await pool.query(
      `SELECT property_key, property_label, unit
         FROM fab_resource_type_properties
        WHERE resource_type_id = ? AND deleted_at IS NULL
        ORDER BY property_key`,
      [req.params.rtId],
    );

    const stdVars = [
      { key: 'resource.capacity_hrs_per_day', label: 'Capacity Hrs/Day' },
      { key: 'resource.num_units',            label: 'Number of Units' },
      { key: 'resource.utilization_pct',      label: 'Utilization %' },
      { key: 'resource.efficiency_pct',       label: 'Efficiency %' },
      { key: 'resource.setup_time_hrs',       label: 'Setup Time (hrs)' },
      { key: 'resource.teardown_time_hrs',    label: 'Teardown Time (hrs)' },
      { key: 'resource.move_time_hrs',        label: 'Move Time (hrs)' },
      { key: 'resource.cost_per_hour',        label: 'Cost Per Hour' },
    ];
    const propVars = props.map(p => ({
      key:   `resource.${p.property_key}`,
      label: p.property_label,
      unit:  p.unit,
    }));

    res.json({ vars: [...stdVars, ...propVars] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /routing/steps ─────────────────────────────────────────────────────
router.post('/routing/steps', protect, async (req, res) => {
  try {
    const { routingPlanId, name, xPos, yPos, description, resourceTypeId } = req.body;
    if (!routingPlanId || !name) return res.status(400).json({ error: 'routingPlanId and name are required' });

    const [result] = await pool.query(
      `INSERT INTO fab_routing_op_steps (company_id, routing_plan_id, name, description, resource_type_id, x_pos, y_pos)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [req.user.companyId, routingPlanId, name, description ?? null, resourceTypeId ?? null,
       xPos ?? 100, yPos ?? 100],
    );
    res.json({ id: result.insertId, ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── PUT /routing/steps/:id ──────────────────────────────────────────────────
router.put('/routing/steps/:id', protect, async (req, res) => {
  try {
    const { name, description, resourceTypeId, notes } = req.body;
    await pool.query(
      `UPDATE fab_routing_op_steps
          SET name = ?, description = ?, resource_type_id = ?, notes = ?
        WHERE id = ? AND company_id = ?`,
      [name, description ?? null, resourceTypeId ?? null, notes ?? null,
       req.params.id, req.user.companyId],
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── PATCH /routing/steps/:id/pos ────────────────────────────────────────────
router.patch('/routing/steps/:id/pos', protect, async (req, res) => {
  try {
    const { xPos, yPos } = req.body;
    await pool.query(
      `UPDATE fab_routing_op_steps SET x_pos = ?, y_pos = ? WHERE id = ? AND company_id = ?`,
      [xPos, yPos, req.params.id, req.user.companyId],
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── DELETE /routing/steps/:id ───────────────────────────────────────────────
router.delete('/routing/steps/:id', protect, async (req, res) => {
  try {
    const stepId    = req.params.id;
    const companyId = req.user.companyId;
    const now = new Date();
    await pool.query(`UPDATE fab_routing_op_steps  SET deleted_at = ? WHERE id = ? AND company_id = ?`, [now, stepId, companyId]);
    await pool.query(`UPDATE fab_routing_op_deps   SET deleted_at = ? WHERE (from_step_id = ? OR to_step_id = ?) AND company_id = ?`, [now, stepId, stepId, companyId]);
    await pool.query(`UPDATE fab_routing_op_inputs SET deleted_at = ? WHERE step_id = ? AND company_id = ?`, [now, stepId, companyId]);
    await pool.query(`UPDATE fab_routing_op_outputs SET deleted_at = ? WHERE step_id = ? AND company_id = ?`, [now, stepId, companyId]);
    await pool.query(`UPDATE fab_routing_op_formulas SET deleted_at = ? WHERE step_id = ? AND company_id = ?`, [now, stepId, companyId]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /routing/deps ──────────────────────────────────────────────────────
router.post('/routing/deps', protect, async (req, res) => {
  try {
    const { routingPlanId, fromStepId, toStepId } = req.body;
    if (!routingPlanId || !fromStepId || !toStepId) return res.status(400).json({ error: 'routingPlanId, fromStepId, toStepId required' });
    if (fromStepId === toStepId) return res.status(400).json({ error: 'Cannot connect a step to itself' });

    const [result] = await pool.query(
      `INSERT INTO fab_routing_op_deps (company_id, routing_plan_id, from_step_id, to_step_id)
       VALUES (?, ?, ?, ?)`,
      [req.user.companyId, routingPlanId, fromStepId, toStepId],
    );
    res.json({ id: result.insertId, ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── DELETE /routing/deps/:id ─────────────────────────────────────────────────
router.delete('/routing/deps/:id', protect, async (req, res) => {
  try {
    await pool.query(
      `UPDATE fab_routing_op_deps SET deleted_at = NOW() WHERE id = ? AND company_id = ?`,
      [req.params.id, req.user.companyId],
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /routing/inputs ─────────────────────────────────────────────────────
router.post('/routing/inputs', protect, async (req, res) => {
  try {
    const { stepId, sourceType, bomItemId, sourceStepId, label, qty, uom, notes } = req.body;
    if (!stepId || !sourceType) return res.status(400).json({ error: 'stepId and sourceType required' });

    const [result] = await pool.query(
      `INSERT INTO fab_routing_op_inputs
         (company_id, step_id, source_type, bom_item_id, source_step_id, label, qty, uom, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [req.user.companyId, stepId, sourceType, bomItemId ?? null, sourceStepId ?? null,
       label ?? null, qty ?? null, uom ?? null, notes ?? null],
    );
    res.json({ id: result.insertId, ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── DELETE /routing/inputs/:id ──────────────────────────────────────────────
router.delete('/routing/inputs/:id', protect, async (req, res) => {
  try {
    await pool.query(
      `UPDATE fab_routing_op_inputs SET deleted_at = NOW() WHERE id = ? AND company_id = ?`,
      [req.params.id, req.user.companyId],
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /routing/outputs ───────────────────────────────────────────────────
router.post('/routing/outputs', protect, async (req, res) => {
  try {
    const { stepId, name, outputType, qtyFormula, uom, notes } = req.body;
    if (!stepId || !name) return res.status(400).json({ error: 'stepId and name required' });

    const [result] = await pool.query(
      `INSERT INTO fab_routing_op_outputs (company_id, step_id, name, output_type, qty_formula, uom, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [req.user.companyId, stepId, name, outputType ?? 'wip', qtyFormula ?? null, uom ?? null, notes ?? null],
    );
    res.json({ id: result.insertId, ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── PUT /routing/outputs/:id ────────────────────────────────────────────────
router.put('/routing/outputs/:id', protect, async (req, res) => {
  try {
    const { name, outputType, qtyFormula, uom, notes } = req.body;
    await pool.query(
      `UPDATE fab_routing_op_outputs SET name = ?, output_type = ?, qty_formula = ?, uom = ?, notes = ?
        WHERE id = ? AND company_id = ?`,
      [name, outputType ?? 'wip', qtyFormula ?? null, uom ?? null, notes ?? null,
       req.params.id, req.user.companyId],
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── DELETE /routing/outputs/:id ─────────────────────────────────────────────
router.delete('/routing/outputs/:id', protect, async (req, res) => {
  try {
    await pool.query(
      `UPDATE fab_routing_op_outputs SET deleted_at = NOW() WHERE id = ? AND company_id = ?`,
      [req.params.id, req.user.companyId],
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /routing/formulas ───────────────────────────────────────────────────
// Upsert: replaces existing formula of the same type for the same step
router.post('/routing/formulas', protect, async (req, res) => {
  try {
    const { stepId, formulaType, expression, outputUnit } = req.body;
    if (!stepId || !formulaType || !expression) return res.status(400).json({ error: 'stepId, formulaType, expression required' });

    const [existing] = await pool.query(
      `SELECT id FROM fab_routing_op_formulas
        WHERE step_id = ? AND formula_type = ? AND company_id = ? AND deleted_at IS NULL`,
      [stepId, formulaType, req.user.companyId],
    );

    if (existing.length > 0) {
      await pool.query(
        `UPDATE fab_routing_op_formulas SET expression = ?, output_unit = ? WHERE id = ? AND company_id = ?`,
        [expression, outputUnit ?? 'hours', existing[0].id, req.user.companyId],
      );
      res.json({ id: existing[0].id, ok: true });
    } else {
      const [result] = await pool.query(
        `INSERT INTO fab_routing_op_formulas (company_id, step_id, formula_type, expression, output_unit)
         VALUES (?, ?, ?, ?, ?)`,
        [req.user.companyId, stepId, formulaType, expression, outputUnit ?? 'hours'],
      );
      res.json({ id: result.insertId, ok: true });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── DELETE /routing/formulas/:id ────────────────────────────────────────────
router.delete('/routing/formulas/:id', protect, async (req, res) => {
  try {
    await pool.query(
      `UPDATE fab_routing_op_formulas SET deleted_at = NOW() WHERE id = ? AND company_id = ?`,
      [req.params.id, req.user.companyId],
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
