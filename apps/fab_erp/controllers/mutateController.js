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
import { generateCode } from '../services/codegenService.js';
import { recomputeItemShape, orderIdOfItem } from '../services/itemShapeService.js';
import { recomputeCatalogWeight } from '../services/fieldDeriveService.js';
import { assertNoStartedWork } from '../services/itemGuards.js';
import { fail } from '../../../core/middleware/requirePerm.js';

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
  // A catalogue item can be created from the order's add-a-row picker, where
  // there is nowhere to type a code and no reason to: the item rule builds one
  // from the category. A typed code still wins — imports carry the shop's own.
  fabErpItemCatalog:   { entityType: 'item',           mode: 'ifBlank' },
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

/**
 * Delete hooks: resource -> async (conn, companyId, id, payload) => void.
 *
 * Run BEFORE the row's own soft-delete, on the SAME transaction — a hook that
 * throws leaves nothing written. Only a resource whose delete is more than
 * "soft-delete this one row" belongs here.
 */
const DELETE_HOOKS = {
  /**
   * Deleting a line used to orphan its structure: `fab_items.order_line_id`
   * rows stayed live under a line that no longer existed, and every
   * readiness/nesting/task query kept counting them as real parts. Refuse
   * with the row count unless the caller passes `cascade: true` in the
   * mutate payload; when it does, mirror `bomService.applyTree`'s own
   * removed-row cleanup — refuse outright (not partially) if any row under
   * the line carries shop-floor history, otherwise drop the tasks and then
   * the rows, in the same transaction as the line itself.
   */
  fabErpOrderLine: async (conn, companyId, id, payload) => {
    const [items] = await conn.query(
      `SELECT id FROM fab_items WHERE company_id = ? AND order_line_id = ? AND deleted_at IS NULL`,
      [companyId, id],
    );
    if (!items.length) return;
    const ids = items.map((r) => Number(r.id));
    if (payload?.cascade !== true) {
      const e = new Error(
        `This line has ${ids.length} structure row${ids.length === 1 ? '' : 's'} under it. `
        + 'Delete again with cascade to remove them too.',
      );
      e.status = 409;
      e.code = 'LINE_HAS_STRUCTURE';
      e.detail = { count: ids.length };
      throw e;
    }
    await assertNoStartedWork(conn, companyId, ids);
    await conn.query(
      `UPDATE fab_project_tasks SET deleted_at = UTC_TIMESTAMP()
        WHERE company_id = ? AND item_id IN (?) AND deleted_at IS NULL`,
      [companyId, ids],
    );
    await conn.query(
      `UPDATE fab_items SET deleted_at = UTC_TIMESTAMP()
        WHERE company_id = ? AND id IN (?) AND deleted_at IS NULL`,
      [companyId, ids],
    );
  },

  /**
   * A catalog item had NO delete guard at all before this: the generic
   * soft-delete just flipped `deleted_at` regardless of who still points at
   * it, so every BOM row (`fab_item_bom.child_item_id`) and order item
   * (`fab_items.catalog_item_id`) referencing it was silently orphaned —
   * the row it joins against vanishes from every taxonomy/weight/spec
   * lookup that filters `deleted_at IS NULL`. `routes/catalog.js`'s
   * `GET /catalog/items/:id/usage` was already built "for the delete
   * dialog" (its own header comment) but nothing ever called it as an
   * actual gate — same counts, mirrored here as the one true delete path
   * (the FE's quick-delete button goes through this generic `/mutate`
   * route, not a dedicated one). Same shape as `fabErpOrderLine` above:
   * refuse with the counts, no cascade option — unlike an order line's
   * structure, a shared catalog item's BOM/order references are not this
   * delete's to remove.
   */
  fabErpItemCatalog: async (conn, companyId, id) => {
    const [[bom]] = await conn.query(
      `SELECT COUNT(*) AS n FROM fab_item_bom
        WHERE company_id = ? AND deleted_at IS NULL AND child_item_id = ?`,
      [companyId, id],
    );
    const [[orders]] = await conn.query(
      `SELECT COUNT(DISTINCT i.order_id) AS n
         FROM fab_items i
         JOIN fab_orders o ON o.id = i.order_id AND o.deleted_at IS NULL
        WHERE i.company_id = ? AND i.deleted_at IS NULL AND i.catalog_item_id = ?`,
      [companyId, id],
    );
    const bomCount = Number(bom?.n ?? 0);
    const orderCount = Number(orders?.n ?? 0);
    if (bomCount || orderCount) {
      const parts = [];
      if (bomCount) parts.push(`${bomCount} BOM row${bomCount === 1 ? '' : 's'}`);
      if (orderCount) parts.push(`${orderCount} order${orderCount === 1 ? '' : 's'}`);
      const e = new Error(`Still referenced by ${parts.join(' and ')}. Remove those references first.`);
      e.status = 409;
      e.code = 'ITEM_IN_USE';
      e.detail = { bomCount, orderCount };
      throw e;
    }
  },
};

// ---------------------------------------------------------------------------
// EU-B3: Consumption-gate helpers
// ---------------------------------------------------------------------------

/**
 * Direct-ref rules: resource alias → array of { field, entity } pairs.
 * Only fields that are present AND non-null in the filtered payload are checked.
 */
/*
 * `fabErpItem.manufacturing_method_template_id` was gated here against a
 * `manufacturing_method_templates` table that does not exist in any environment
 * — the column held zero rows for its whole life and nothing in the frontend
 * ever referenced it. Dropped with the column, 2026-09-02.
 */
/**
 * `depth` and `is_leaf` after any hand-edit of the item tree.
 *
 * The order tree's Add item writes through this controller, and this controller
 * writes exactly the columns in `writeFields` — which do not include the two
 * derived ones. So a row added here arrived with a parent and a depth of 0 (the
 * column default) and `is_leaf = 0`, which put it at the wrong rung and made it
 * invisible to nesting, with nothing reporting a problem. Found on the live
 * KEPL order eight minutes after it was built.
 *
 * Fixed by DERIVING rather than by asking this path to remember: see
 * itemShapeService. Failure is logged and swallowed — a stale shape is a bug to
 * chase, not a reason to fail a save the user has already been told succeeded.
 */
/**
 * Fields that can actually change `depth`/`is_leaf` — reparenting or switching
 * a row between a structural node and a material link. Everything else on an
 * item (name, qty, flow_id, dims, ...) leaves the tree's SHAPE untouched.
 */
const SHAPE_AFFECTING_FIELDS = ['parent_item_id', 'node_kind'];

/**
 * `recomputeItemShape` walks the WHOLE order — up to a dozen depth passes plus
 * two leaf passes, regardless of how small the edit was. Insert and delete
 * always change the shape (a row appeared or disappeared) and stay
 * unconditional; an UPDATE only needs it when the write touched one of
 * `SHAPE_AFFECTING_FIELDS` — pass the filtered payload so a plain field edit
 * (the common case) skips a whole-order recompute it cannot possibly need.
 */
async function restampItemShape(resource, companyId, orderIdFromRow, itemId, filteredPayload = null) {
  if (resource !== 'fabErpItem') return;
  if (filteredPayload && !SHAPE_AFFECTING_FIELDS.some((f) => f in filteredPayload)) return;
  try {
    const orderId = orderIdFromRow ?? await orderIdOfItem(companyId, itemId);
    if (orderId) await recomputeItemShape(companyId, orderId);
  } catch (err) {
    logger.error({ err, companyId, itemId }, 'fab_erp mutate: could not restamp item shape');
  }
}

/**
 * `fab_item_catalog.thickness_mm` is a writable column edited through this
 * generic path (density/section_area are not, today); a catalog item's
 * derived `unit_weight_kg` (EU-15 item 7) must not go stale the moment
 * somebody changes it here instead of through `/fields/values`.
 */
async function restampCatalogWeight(resource, companyId, filteredPayload, catalogItemId) {
  if (resource !== 'fabErpItemCatalog') return;
  if (!Object.prototype.hasOwnProperty.call(filteredPayload, 'thickness_mm')) return;
  try {
    await recomputeCatalogWeight(companyId, [catalogItemId]);
  } catch (err) {
    logger.error({ err, catalogItemId }, 'fab_erp mutate: could not restamp catalog weight');
  }
}

/*
 * The EU-B3 version-consumption gate (CONSUMPTION_RULES / runConsumptionGate,
 * backed by versionService.isVersionConsumable) was removed 2026-09-13
 * (PLAN.md EU-20). Its only rule guarded `fabErpMfgMethodLine`, a resource
 * that was never added to resourceDef.json — CONSUMPTION_RULES[resource] was
 * therefore always `[]` for every real resource and the gate never once
 * fired. Two of the four entities versionService knew how to check
 * (`routing_templates`, `manufacturing_method_templates`) also point at
 * tables `init.sql` drops outright. See §13 "fab_erp: Version Consumption
 * Gates (422 NOT_APPROVED)" for the removal note.
 */

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
 * `line_type` used to be typed by the FE from `item.groupName` the moment a
 * line's catalog item was picked (EU-15 item 8) — a fact the SERVER already
 * knows the moment `catalog_item_id` is written, and the one place three
 * columns (`catalog_item_id`, `template_item_id`, `line_type`) holding one
 * fact could actually be kept in agreement.
 *
 * Only acts when `catalog_item_id` is IN THIS WRITE — an update that never
 * touches it (saving qty, say) leaves `line_type` exactly as it was.
 */
async function deriveOrderLineType(resource, filteredPayload, companyId) {
  if (resource !== 'fabErpOrderLine') return;
  if (!Object.prototype.hasOwnProperty.call(filteredPayload, 'catalog_item_id')) return;
  const catalogItemId = filteredPayload.catalog_item_id;
  if (!catalogItemId) { filteredPayload.line_type = null; return; }
  // A structure root (e.g. this company's COMPOS-SPAN) has no GROUP — its
  // CATEGORY is what names the structure type — so falling back to the
  // category when there is no group is not a guess, it's the other half of
  // the same taxonomy. Without it, a line built on such a root got
  // `line_type = null` forever and readiness's "lines without a structure
  // type" could never clear.
  const [[cat]] = await pool.query(
    `SELECT g.name AS groupName, cat.name AS categoryName FROM fab_item_catalog c
       LEFT JOIN fab_item_groups g ON g.id = c.group_id AND g.deleted_at IS NULL
       LEFT JOIN fab_item_categories cat ON cat.id = c.category_id AND cat.deleted_at IS NULL
      WHERE c.id = ? AND c.company_id = ? AND c.deleted_at IS NULL LIMIT 1`,
    [catalogItemId, companyId],
  );
  filteredPayload.line_type = cat?.groupName ?? cat?.categoryName ?? null;
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

  // ── 6b. Server-owned field stamps ─────────────────────────────────────────
  if (op === 'insert' || op === 'update') {
    try {
      await applyOrderConfirmationStamp(resource, op, filteredPayload, companyId, payload?.id);
      await deriveOrderLineType(resource, filteredPayload, companyId);
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
          // The item rule reads the category for its short form, so the row's
          // own taxonomy is what the code is built from.
          row.code = await generateCode(companyId, autogen.entityType, {
            categoryId: row.category_id ?? null,
            groupId: row.group_id ?? null,
            subgroupId: row.subgroup_id ?? null,
          });
        } else {
          row.code = supplied;
        }
      }

      const [result] = await pool.query(`INSERT INTO \`${tableName}\` SET ?`, [row]);
      await restampItemShape(resource, companyId, row.order_id ?? null, result.insertId);
      await restampCatalogWeight(resource, companyId, filteredPayload, result.insertId);

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

      await restampItemShape(resource, companyId, null, id, filteredPayload);
      await restampCatalogWeight(resource, companyId, filteredPayload, id);

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

      const hook = DELETE_HOOKS[resource];
      if (hook) {
        const conn = await pool.getConnection();
        try {
          await conn.beginTransaction();
          await hook(conn, companyId, id, payload);
          const [result] = await conn.query(
            `UPDATE \`${tableName}\`
             SET deleted_at = UTC_TIMESTAMP()
             WHERE id = ? AND company_id = ? AND deleted_at IS NULL`,
            [id, companyId],
          );
          if (result.affectedRows === 0) {
            await conn.rollback();
            return res.status(404).json({ message: 'Row not found or not owned by your company.' });
          }
          await conn.commit();
        } catch (hookErr) {
          await conn.rollback();
          if (hookErr.status) return fail(res, hookErr);
          throw hookErr;
        } finally {
          conn.release();
        }

        await restampItemShape(resource, companyId, null, id);
        logger.info({ userId: user.id, companyId, resource, id }, 'fab_erp mutate: soft-delete ok (hooked)');
        return res.json({ ok: true, id, deleted: true });
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

      // Deleting a row can make its PARENT a leaf, so the shape is restamped
      // here too — the row itself is gone, but the tree around it changed.
      await restampItemShape(resource, companyId, null, id);

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

    if (err.code === 'ER_DATA_TOO_LONG' || err.errno === 1406) {
      // sqlMessage: Data too long for column 'shortform' at row 1. A value
      // that does not fit is the caller's to shorten — a 422 that names the
      // field, not a 500 that says the database is broken (prod UAT finding 1).
      const column = String(err.sqlMessage ?? '').match(/for column '([^']+)'/)?.[1];
      const message = column
        ? `"${column.replace(/_/g, ' ')}" is too long for this record — shorten it and try again.`
        : 'One of the values is too long for this record — shorten it and try again.';
      logger.warn({ resource, op, userId: user?.id, column }, 'fab_erp mutate: value too long');
      return res.status(422).json({ message, column: column ?? null });
    }

    logger.error({ err, resource, op, userId: user?.id }, 'fab_erp mutate: DB error');
    return res.status(500).json({ message: 'Database write failed. Please try again.' });
  }
}
