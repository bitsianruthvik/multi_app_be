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
import { generateCode } from '../services/codegenService.js';

// Resources whose `code` the server fills in on insert.
//
// Two policies, because the two cases are genuinely different:
//
//   'always'  — the code is an internal identifier nobody types or recognises,
//               so a client value is ignored outright (EU-2, customers).
//   'ifBlank' — the thing has a name people say out loud on the floor ("CNC 2",
//               "Bay 3 rack"), so a code the user typed is theirs and is kept.
//               Only an absent or empty one is generated.
//
// 'ifBlank' is what makes the codes automatic without making them mandatory:
// the create forms can stop demanding a code, and anything left blank comes
// back numbered. Generating it HERE rather than in the browser also stops the
// old two-round-trip pattern (ask for a number, then insert) from burning a
// number every time the insert that followed it failed.
const AUTOGEN_CODE_RESOURCES = {
  fabErpCustomer:      { entityType: 'customer',       mode: 'always'  },
  // 'ifBlank' rather than 'always' because a supplier code is often the vendor's
  // own account number, written on their invoices — if somebody typed one, it is
  // the number the paperwork already uses and we do not get to renumber it.
  fabErpSupplier:      { entityType: 'supplier',       mode: 'ifBlank' },
  fabErpResource:      { entityType: 'resource',       mode: 'ifBlank' },
  fabErpStockLocation: { entityType: 'stock_location', mode: 'ifBlank' },
};

/**
 * Resources this endpoint must never write, no matter what resourceDef says.
 *
 * Physical stock is the case that matters. Creating a piece has three
 * obligations beyond the row itself: issue its code, append a fab_stock_ledger
 * entry, and re-evaluate every task gated on that material. stockInService does
 * all three inside one transaction. This controller does none of them — so a
 * piece inserted here is uncoded, invisible to the ledger, and leaves blocked
 * work blocked forever with no signal.
 *
 * `writeFields: []` in resourceDef already makes these read-only, but that is a
 * data file someone will one day "fix" by adding the fields back. This is the
 * check that survives that, and it names the route to use instead.
 */
const WRITE_FORBIDDEN = {
  fabErpStockPiece: 'POST /stock/receive (stockInService) — it also writes the ledger, issues the piece code, and re-checks material-gated tasks',
  fabErpStockLedger: 'the ledger is append-only and written by the service that moves the stock',
};

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
};

/*
 * A formula_id -> formula_set_id consumption gate lived here, resolving the
 * parent set through a fab_formulas table and checking it was approved.
 *
 * Removed 2026-08-05. There is no fab_formulas table — init.sql line 13 drops
 * it explicitly, and no environment has one. A formula is now just a TEXT
 * expression on the step itself (fab_process_template_steps.formula), with no
 * separate row to version or approve. The gate could never have fired anyway:
 * formula_id is not a writable field on either resource it guarded, so the
 * payload it read was always empty.
 */

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

  return null; // all clear
}

const VALID_OPS = new Set(['insert', 'update', 'delete']);

/**
 * `fab_orders.confirmed_date` is a consequence of confirming an order, not a
 * field anyone should type. It is stamped here — the one place every fab_erp
 * write passes through — rather than in the two dialogs that can set a status,
 * because a rule split across call sites is a rule that drifts.
 *
 *   insert : a draft has no confirmation date. Anything sent is discarded unless
 *            the order is being created already confirmed.
 *   update : entering 'confirmed' stamps today, but only if the order does not
 *            already carry a date — a confirmation that happened last week must
 *            not be rewritten to today by an unrelated edit.
 *
 * Moving back to draft deliberately leaves the date alone: it records that the
 * order WAS confirmed on that day, which stays true afterwards.
 */
async function applyOrderConfirmationStamp(resource, op, filteredPayload, companyId, id) {
  if (resource !== 'fabErpOrder') return;
  const today = new Date().toISOString().slice(0, 10);
  const status = filteredPayload.status;

  if (op === 'insert') {
    filteredPayload.confirmed_date = status === 'confirmed' ? (filteredPayload.confirmed_date || today) : null;
    return;
  }
  if (op !== 'update' || status !== 'confirmed') return;
  if (filteredPayload.confirmed_date) return; // an explicit correction wins

  const [[row]] = await pool.query(
    'SELECT confirmed_date FROM fab_orders WHERE id = ? AND company_id = ? AND deleted_at IS NULL',
    [id, companyId],
  );
  if (row && !row.confirmed_date) filteredPayload.confirmed_date = today;
}

/**
 * Resolves the set of fields required for this write, from the resource's
 * declared `requiredFields` config in resourceDef.json:
 *   { always: [...], byOrderType: { <typeValue>: [...] }, orderTypeField: 'order_type' }
 * `byOrderType` is a generic discriminator rule — keyed off whatever field
 * `orderTypeField` names — not specific to orders.
 *
 * On insert, every required field must be present and non-empty in the
 * filtered payload. On update, only fields explicitly included in the
 * payload are checked (we don't fetch the existing row), so a partial
 * update that doesn't touch a required field is not blocked retroactively.
 */
function getMissingRequiredFields(def, filteredPayload, op) {
  const rf = def.requiredFields;
  if (!rf) return [];

  const required = new Set(rf.always ?? []);
  if (rf.byOrderType && rf.orderTypeField) {
    const discriminator = filteredPayload[rf.orderTypeField];
    for (const f of rf.byOrderType[discriminator] ?? []) required.add(f);
  }

  const missing = [];
  for (const field of required) {
    const present = Object.prototype.hasOwnProperty.call(filteredPayload, field);
    if (op === 'insert' && !present) { missing.push(field); continue; }
    if (!present) continue; // update: untouched field — not our concern
    const v = filteredPayload[field];
    if (v === undefined || v === null || v === '') missing.push(field);
  }
  return missing;
}

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

  if (WRITE_FORBIDDEN[resource]) {
    return res.status(400).json({
      message: `"${resource}" cannot be written through the generic endpoint. Use ${WRITE_FORBIDDEN[resource]}.`,
      code: 'WRITE_FORBIDDEN',
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

  // ── 5b. Required-field enforcement (insert / update only) ─────────────────
  if (op === 'insert' || op === 'update') {
    const missing = getMissingRequiredFields(def, filteredPayload, op);
    if (missing.length) {
      return res.status(422).json({
        message: `Missing required field${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}.`,
        missingFields: missing,
      });
    }
  }

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

  // ── 6b. Server-owned field stamps ─────────────────────────────────────────
  if (op === 'insert' || op === 'update') {
    try {
      await applyOrderConfirmationStamp(resource, op, filteredPayload, companyId, payload?.id);
    } catch (stampErr) {
      logger.error({ stampErr, resource, op }, 'fab_erp mutate: confirmation stamp failed');
      return res.status(500).json({ message: 'Could not set the confirmation date. Please try again.' });
    }
  }

  // ── 7. Execute write ───────────────────────────────────────────────────────
  try {
    if (op === 'insert') {
      const row = { ...filteredPayload, company_id: companyId };

      const autogen = AUTOGEN_CODE_RESOURCES[resource];
      if (autogen) {
        const supplied = typeof row.code === 'string' ? row.code.trim() : row.code;
        if (autogen.mode === 'always' || supplied === undefined || supplied === null || supplied === '') {
          row.code = await generateCode(companyId, autogen.entityType, {});
        } else {
          row.code = supplied;
        }
      }

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
         SET ?, updated_at = UTC_TIMESTAMP()
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
         SET deleted_at = UTC_TIMESTAMP()
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
