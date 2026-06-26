// mutateController.js — permission-gated write handler for fab_erp resources.
//
// POST /mutate  { resource, op, payload }
//   op ∈ { insert, update, delete }
//
// Security model:
//   - Caller must be authenticated (protect middleware runs before this handler).
//   - Admin role (req.user.role === 'admin') bypasses feature-tag checks.
//   - All other roles must have the required feature_tag in req.user.uiPermissions.
//   - payload is filtered to the resource's declared writeFields before any DB call.
//   - company_id is always forced from req.user.companyId — the client cannot supply it.

import { pool } from '../../../db.js';
import { logger } from '../../../core/utils/logger.js';
import { hasResource, getResource } from '../../../core/query/resourceRegistry.js';
import resourcePermissions from '../config/resourcePermissions.js';
import { isVersionConsumable } from '../services/versionService.js';

// ---------------------------------------------------------------------------
// EU-B3: Consumption-gate helpers
// ---------------------------------------------------------------------------

/**
 * Direct-ref rules: resource alias → array of { field, entity } pairs.
 * Only fields that are present AND non-null in the filtered payload are checked.
 */
const CONSUMPTION_RULES = {
  fabErpItem: [
    { field: 'manufacturing_method_template_id', entity: 'manufacturing_method_templates' },
  ],
  fabErpMfgMethodLine: [
    { field: 'routing_template_id',  entity: 'routing_templates'  },
    { field: 'process_template_id',  entity: 'process_templates'  },
  ],
  // fabErpProcessTemplateStep and fabErpRoutingTemplateStep use formula_id → formula_set_id
  // resolution (see checkFormulaRef below); no direct entity ref here.
};

/**
 * Resources that gate via formula_id → parent formula_set_id lookup.
 */
const FORMULA_REF_RESOURCES = new Set([
  'fabErpProcessTemplateStep',
  'fabErpRoutingTemplateStep',
]);

/**
 * Resolves a formula's parent formula_set_id, then checks consumability.
 * Returns null if approved/consumable, or an error object if not.
 *
 * @param {number} formulaId
 * @param {number} companyId
 * @returns {Promise<null|{error:string, code:string}>}
 */
async function checkFormulaRef(formulaId, companyId) {
  const [rows] = await pool.query(
    `SELECT formula_set_id
       FROM fab_formulas
      WHERE id = ? AND company_id = ? AND deleted_at IS NULL
      LIMIT 1`,
    [formulaId, companyId],
  );

  if (!rows.length) {
    return {
      error: `Referenced formula (id=${formulaId}) does not exist or is not accessible.`,
      code: 'NOT_FOUND',
    };
  }

  const formulaSetId = rows[0].formula_set_id;
  const consumable = await isVersionConsumable('formula_sets', formulaSetId, companyId);
  if (!consumable) {
    return {
      error: `Referenced formula_set (id=${formulaSetId}, via formula id=${formulaId}) is not approved and cannot be used.`,
      code: 'NOT_APPROVED',
    };
  }
  return null;
}

/**
 * Runs all consumption-gate checks for the given resource + filtered payload.
 * Returns null if everything is consumable, or the first blocking error object.
 *
 * Only called for op ∈ { insert, update }. Delete ops skip this entirely.
 *
 * @param {string} resource         - Resource alias (e.g. 'fabErpItem').
 * @param {object} filteredPayload  - Already-filtered write payload.
 * @param {number} companyId        - Tenant scope from JWT.
 * @returns {Promise<null|{error:string, code:string}>}
 */
async function runConsumptionGate(resource, filteredPayload, companyId) {
  // ── Direct-ref rules ────────────────────────────────────────────────────
  const rules = CONSUMPTION_RULES[resource] ?? [];
  for (const { field, entity } of rules) {
    const refId = filteredPayload[field];
    if (refId === undefined || refId === null) continue; // not in this payload

    const consumable = await isVersionConsumable(entity, refId, companyId);
    if (!consumable) {
      const label = entity.replace(/_/g, ' ');
      return {
        error: `Referenced ${label} (id=${refId}) is not approved and cannot be used.`,
        code: 'NOT_APPROVED',
      };
    }
  }

  // ── Formula-id → formula_set resolution ─────────────────────────────────
  if (FORMULA_REF_RESOURCES.has(resource)) {
    const formulaId = filteredPayload.formula_id;
    if (formulaId !== undefined && formulaId !== null) {
      const err = await checkFormulaRef(formulaId, companyId);
      if (err) return err;
    }
  }

  return null; // all clear
}

const VALID_OPS = new Set(['insert', 'update', 'delete']);

export async function mutate(req, res) {
  const { resource, op, payload = {} } = req.body ?? {};

  // ── 1. Validate resource ──────────────────────────────────────────────────
  if (!resource || typeof resource !== 'string') {
    return res.status(400).json({ message: 'Missing or invalid "resource" field.' });
  }

  if (!(resource in resourcePermissions)) {
    return res.status(400).json({
      message: `Unknown fab_erp resource: "${resource}". Not listed in resourcePermissions.`,
    });
  }

  if (!hasResource(resource)) {
    return res.status(400).json({
      message: `Resource "${resource}" is not registered in the resource registry.`,
    });
  }

  // ── 2. Authorize ──────────────────────────────────────────────────────────
  const user = req.user;
  const isAdmin = user?.role && String(user.role).toLowerCase() === 'admin';

  if (!isAdmin) {
    const requiredTag = resourcePermissions[resource];
    const granted = Array.isArray(user?.uiPermissions) && user.uiPermissions.includes(requiredTag);
    if (!granted) {
      logger.warn(
        { userId: user?.id, resource, requiredTag },
        'fab_erp mutate: permission denied',
      );
      return res.status(403).json({
        message: `Permission denied. Required: "${requiredTag}".`,
      });
    }
  }

  // ── 3. Validate op ────────────────────────────────────────────────────────
  if (!op || !VALID_OPS.has(op)) {
    return res.status(400).json({
      message: `Invalid "op". Must be one of: insert, update, delete.`,
    });
  }

  // ── 4. Load resourceDef & filter payload to declared writeFields ──────────
  const def = getResource(resource);   // { table, alias, writeFields, fields, ... }
  const writeFields = Array.isArray(def.writeFields) ? def.writeFields : [];

  const filteredPayload = {};
  for (const field of writeFields) {
    if (Object.prototype.hasOwnProperty.call(payload, field)) {
      filteredPayload[field] = payload[field];
    }
  }

  // ── 5. Force company_id = req.user.companyId ──────────────────────────────
  const companyId = user?.companyId ?? user?.company_id;
  if (companyId === undefined || companyId === null) {
    logger.error({ userId: user?.id }, 'fab_erp mutate: companyId missing from JWT');
    return res.status(500).json({ message: 'Cannot determine company context from token.' });
  }

  const tableName = def.table;
  const tableAlias = def.alias;

  // ── 6. EU-B3: Consumption gate (insert / update only) ─────────────────────
  //   Runs AFTER permission check and payload filtering, BEFORE any DB write.
  //   Delete ops are exempt — removing a row that references a draft is fine.
  if (op === 'insert' || op === 'update') {
    try {
      const gateError = await runConsumptionGate(resource, filteredPayload, companyId);
      if (gateError) {
        logger.warn(
          { userId: user.id, companyId, resource, op, gateError },
          'fab_erp mutate: consumption gate rejected write',
        );
        return res.status(422).json(gateError);
      }
    } catch (gateErr) {
      logger.error(
        { gateErr, resource, op, userId: user?.id },
        'fab_erp mutate: consumption gate DB error',
      );
      return res.status(500).json({ message: 'Approval check failed. Please try again.' });
    }
  }

  // ── 7. Execute write ───────────────────────────────────────────────────────
  try {
    if (op === 'insert') {
      const row = { ...filteredPayload, company_id: companyId };

      const [result] = await pool.query(`INSERT INTO \`${tableName}\` SET ?`, [row]);

      logger.info(
        { userId: user.id, companyId, resource, insertId: result.insertId },
        'fab_erp mutate: insert ok',
      );
      return res.status(201).json({ ok: true, id: result.insertId });
    }

    if (op === 'update') {
      const id = payload?.id;
      if (id === undefined || id === null) {
        return res.status(400).json({ message: '"id" is required in payload for update.' });
      }

      if (Object.keys(filteredPayload).length === 0) {
        return res.status(400).json({ message: 'No writable fields provided for update.' });
      }

      // Scope to user's company + non-deleted rows to prevent cross-tenant writes.
      const [result] = await pool.query(
        `UPDATE \`${tableName}\`
         SET ?, updated_at = NOW()
         WHERE id = ? AND company_id = ? AND deleted_at IS NULL`,
        [filteredPayload, id, companyId],
      );

      if (result.affectedRows === 0) {
        return res.status(404).json({ message: 'Row not found or not owned by your company.' });
      }

      logger.info(
        { userId: user.id, companyId, resource, id },
        'fab_erp mutate: update ok',
      );
      return res.json({ ok: true, id, affectedRows: result.affectedRows });
    }

    if (op === 'delete') {
      const id = payload?.id;
      if (id === undefined || id === null) {
        return res.status(400).json({ message: '"id" is required in payload for delete.' });
      }

      // Soft-delete — consistent with platform convention (deleted_at IS NULL queries).
      const [result] = await pool.query(
        `UPDATE \`${tableName}\`
         SET deleted_at = NOW()
         WHERE id = ? AND company_id = ? AND deleted_at IS NULL`,
        [id, companyId],
      );

      if (result.affectedRows === 0) {
        return res.status(404).json({ message: 'Row not found or not owned by your company.' });
      }

      logger.info(
        { userId: user.id, companyId, resource, id },
        'fab_erp mutate: soft-delete ok',
      );
      return res.json({ ok: true, id, deleted: true });
    }
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY' || err.errno === 1062) {
      // sqlMessage looks like: Duplicate entry 'x-y' for key 'table.uq_some_name_active'
      // Match on the *_active suffix to tell name vs code collisions apart.
      const indexName = String(err.sqlMessage ?? '').match(/for key '[^']*\.([^']+)'/)?.[1] ?? '';
      let message = 'A record with this name or code already exists.';
      if (/code_active|_code\b/i.test(indexName)) {
        message = 'A record with this code already exists.';
      } else if (/name_active/i.test(indexName)) {
        message = 'A record with this name already exists.';
      }

      logger.warn(
        { resource, op, userId: user?.id, indexName },
        'fab_erp mutate: duplicate key',
      );
      return res.status(409).json({ message });
    }

    logger.error({ err, resource, op, userId: user?.id }, 'fab_erp mutate: DB error');
    return res.status(500).json({ message: 'Database write failed. Please try again.' });
  }
}
