import { protect } from '../../../core/middleware/authmiddleware.js';
import { requirePerm, fail, isPermitted } from '../../../core/middleware/requirePerm.js';
import { CfError, translateDbError } from './errors.js';

/**
 * Permission tags. Seeded by models/seed.sql; admins bypass them on the
 * backend (requirePerm), but the frontend's usePermission has no bypass, so an
 * admin role still needs the grants for the screens to show.
 */
export const PERM = {
  view: 'cf_erp_catalog_view',       // see everything in the catalog and setup
  catalog: 'cf_erp_catalog_manage',  // items, definitions, their values and selection lists
  setup: 'cf_erp_setup_manage',      // classification, specifications, formulas, spec rules
  codegen: 'cf_erp_codegen_manage',  // coding rules
  ordersView: 'cf_erp_orders_view',  // see sales orders, their structures and customers
  orders: 'cf_erp_orders_manage',    // sales orders, their lines and custom BOMs
  parties: 'cf_erp_parties_manage',  // customers, suppliers, subcontractors
  productionView: 'cf_erp_production_view', // see machines, operations and flows
  production: 'cf_erp_production_manage',   // machines, shifts, operations, timing rules, flows and their waits
  inventoryView: 'cf_erp_inventory_view',   // see stocking areas, stock, batches and movements
  inventory: 'cf_erp_inventory_manage',     // stocking areas, receipts, issues, transfers, counts, scrap, batches
};

/** The tenant and user of a request. The company always comes from the token, never the URL. */
export function ctx(req) {
  const companyId = Number(req.user?.companyId ?? req.user?.company_id);
  if (!companyId) throw new CfError(401, 'NO_COMPANY', 'This session has no company.');
  const userId = Number(req.user?.id) || null;
  return { companyId, userId };
}

/** For a route whose permission depends on what it touches (a BOM's parent). Admins pass, as everywhere. */
export function assertPerm(req, tag) {
  if (!isPermitted(req.user, tag)) throw new CfError(403, 'FORBIDDEN', `Permission required: ${tag}`);
}

/** protect + permission, as one middleware list. */
export const guard = (perm) => [protect, requirePerm(perm)];

/** Wraps an async handler: its return value is the JSON body; errors go through fail(). */
export const handle = (fn) => async (req, res) => {
  try {
    const out = await fn(req, res);
    if (!res.headersSent) res.json(out ?? { ok: true });
  } catch (err) {
    fail(res, translateDbError(err));
  }
};

/** Positive integer from a route param or body field, or a 422. */
export function intParam(value, name = 'id') {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new CfError(422, 'INVALID', `${name} must be a positive whole number.`);
  return n;
}
