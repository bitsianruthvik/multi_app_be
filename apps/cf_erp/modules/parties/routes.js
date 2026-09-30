/**
 * routes.js — the parties API. The host app mounts it and supplies the
 * permission tags, so this module never learns the host's tag names.
 *
 *   GET    /parties?role=customer|supplier|subcontractor&search=&status=
 *   GET    /parties/:id
 *   POST   /parties        { code, name, roles: [...], taxNumber?, contactName?, email?, phone?, address?, notes? }
 *   PUT    /parties/:id    same fields; status active | inactive
 *   DELETE /parties/:id    refused while anything references the party
 *   GET/POST /parties/:id/addresses, PUT/DELETE /parties/:id/addresses/:addressId — ship-to addresses (GST); each returns the list
 *   Party bodies also take gstin (= taxNumber), gstRegistration, stateCode, city, pincode (CF_ERP_GST_PLAN §1)
 */
import { Router } from 'express';
import { protect } from '../../../../core/middleware/authmiddleware.js';
import { requirePerm, fail } from '../../../../core/middleware/requirePerm.js';
import { pool } from '../../../../db.js';
import { PartyError } from './errors.js';
import {
  listParties, getParty, createParty, updateParty, deleteParty, listAddresses, createAddress, updateAddress, deleteAddress,
} from './service.js';

async function inTransaction(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const out = await fn(conn);
    await conn.commit();
    return out;
  } catch (err) {
    try { await conn.rollback(); } catch { /* keep the original error */ }
    throw err;
  } finally {
    conn.release();
  }
}

function who(req) {
  const companyId = Number(req.user?.companyId ?? req.user?.company_id);
  if (!companyId) throw new PartyError(401, 'NO_COMPANY', 'This session has no company.');
  return { companyId, userId: Number(req.user?.id) || null };
}

const handle = (fn) => async (req, res) => {
  try {
    res.json(await fn(req));
  } catch (err) {
    if (err?.errno === 1062) return fail(res, new PartyError(409, 'DUPLICATE', 'A party with that code already exists.'));
    fail(res, err);
  }
};

function id(req) {
  const n = Number(req.params.id);
  if (!Number.isInteger(n) || n <= 0) throw new PartyError(422, 'INVALID', 'Party id must be a positive whole number.');
  return n;
}

function addressId(req) {
  const n = Number(req.params.addressId);
  if (!Number.isInteger(n) || n <= 0) throw new PartyError(422, 'INVALID', 'Address id must be a positive whole number.');
  return n;
}

export function createPartiesRouter({ viewPerm, managePerm }) {
  const router = Router();
  const view = [protect, requirePerm(viewPerm)];
  const manage = [protect, requirePerm(managePerm)];

  router.get('/parties', view, handle((req) => listParties(pool, who(req).companyId, req.query)));
  router.get('/parties/:id', view, handle((req) => getParty(pool, who(req).companyId, id(req))));
  router.post('/parties', manage, handle((req) => inTransaction((db) => createParty(db, who(req), req.body ?? {}))));
  router.put('/parties/:id', manage, handle((req) => inTransaction((db) => updateParty(db, who(req), id(req), req.body ?? {}))));
  router.delete('/parties/:id', manage, handle((req) => inTransaction((db) => deleteParty(db, who(req), id(req)))));
  router.get('/parties/:id/addresses', view, handle((req) => listAddresses(pool, who(req).companyId, id(req))));
  router.post('/parties/:id/addresses', manage, handle((req) => inTransaction((db) => createAddress(db, who(req), id(req), req.body ?? {}))));
  router.put('/parties/:id/addresses/:addressId', manage, handle((req) => inTransaction((db) => updateAddress(db, who(req), id(req), addressId(req), req.body ?? {}))));
  router.delete('/parties/:id/addresses/:addressId', manage, handle((req) => inTransaction((db) => deleteAddress(db, who(req), id(req), addressId(req)))));
  return router;
}
