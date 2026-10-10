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
  purchaseApprove: 'cf_erp_purchase_approve', // approve / reject purchase requests (init.sql §39); raising and RFQs use inventory manage
  floor: 'cf_erp_floor',                    // the machine log: read the floor screens and record work and stops (init.sql §32)
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

/**
 * protect + ANY ONE of several permissions. The floor screens take cf_erp_floor
 * (a shared tablet has only that) or production manage (a manager records too).
 */
export const guardAny = (...perms) => [protect, (req, res, next) => (perms.some((p) => isPermitted(req.user, p))
  ? next()
  : res.status(403).json({ error: 'FORBIDDEN', message: `Permission required: ${perms.join(' or ')}` }))];

/**
 * A REQUEST BODY THE SERVER WILL NOT READ, SAID AS JSON (2026-10-10). The body is parsed before any
 * route runs (index.js: express.json, 50 MB), and the platform has no error handler of its own: a
 * body over the limit came back as express's HTML page with a stack trace, which a screen expecting
 * { message } cannot show. cf_erp takes whole files as base64 in JSON (nesting DXFs, drawings,
 * workbooks), so it is the app that meets this. Mounted by app.js for cf_erp's own paths only —
 * anything else is passed on untouched.
 */
export function bodyErrors(err, req, res, next) {
  if (res.headersSent || !String(req.originalUrl ?? req.url ?? '').includes('/cf_erp/')) return next(err);
  if (err?.type === 'entity.too.large' || err?.status === 413) {
    const mb = (n) => (Number(n) > 0 ? `${(Number(n) / 1048576).toFixed(0)} MB` : null);
    return res.status(413).json({ code: 'TOO_LARGE', message: `That request is ${mb(err.length) ?? 'too large'}${mb(err.limit) ? ` and the server takes at most ${mb(err.limit)} at a time` : ''}. Send fewer files in one go — a second upload adds to the first.` });
  }
  if (err?.type === 'entity.parse.failed' || (err instanceof SyntaxError && err?.status === 400)) {
    return res.status(400).json({ code: 'BAD_JSON', message: 'The request body is not valid JSON, so nothing was read from it.' });
  }
  return next(err);
}

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

/** Inside a handler: 403 unless the user holds ANY one of the tags. Admins pass. */
export function assertAnyPerm(req, ...tags) {
  if (!tags.some((t) => isPermitted(req.user, t))) throw new CfError(403, 'FORBIDDEN', `Permission required: ${tags.join(' or ')}`);
}
