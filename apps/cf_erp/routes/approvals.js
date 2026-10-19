/**
 * approvals.js — the MANAGEMENT approvals inbox (init.sql §73, services/approvalService.js).
 *
 *   GET  /approvals?status=pending|decided|all&type=&orderId=   the types the person holds; pending rows carry live context
 *   GET  /approvals/:id
 *   POST /approvals/:id/decide   { decision: 'approve' | 'reject', note? }  (a rejection needs the note; requester ≠ approver,
 *                                 an admin may decide their own)
 *   POST /approvals/:id/withdraw  the person who asked takes it back
 * Each type has its own tag (approvalService.APPROVAL_TYPES); holding any one of them opens the inbox.
 */
import { Router } from 'express';
import { protect } from '../../../core/middleware/authmiddleware.js';
import { isPermitted } from '../../../core/middleware/requirePerm.js';
import { pool, withTransaction } from '../lib/db.js';
import { guardAny, handle, ctx, intParam } from '../lib/http.js';
import { APPROVAL_PERMS, listApprovals, getApproval, decide, withdraw, canSetOwnRequests, setApprovesOwnRequests } from '../services/approvalService.js';

const router = Router();
const id = (req) => intParam(req.params.id);
/** Who is asking: their tags (admins pass every one) and whether they are an admin. */
export const approverOf = (req) => ({ can: (tag) => isPermitted(req.user, tag), isAdmin: String(req.user?.role ?? '').toLowerCase() === 'admin' });
const inbox = guardAny(...APPROVAL_PERMS);

router.get('/approvals', inbox, handle(async (req) => ({ ...(await listApprovals(pool, ctx(req).companyId, approverOf(req).can, req.query)), canSetOwn: canSetOwnRequests(approverOf(req)) })));
// The "approve your own requests" switch (§78) — must come before /approvals/:id.
router.put('/approvals/settings', inbox, handle((req) => withTransaction((db) => setApprovesOwnRequests(db, ctx(req), req.body ?? {}, approverOf(req)))));
router.get('/approvals/:id', inbox, handle((req) => getApproval(pool, ctx(req).companyId, id(req), approverOf(req).can)));
router.post('/approvals/:id/decide', inbox, handle((req) => withTransaction((db) => decide(db, ctx(req), id(req), req.body ?? {}, approverOf(req)))));
router.post('/approvals/:id/withdraw', protect, handle((req) => withTransaction((db) => withdraw(db, ctx(req), id(req), { isAdmin: approverOf(req).isAdmin }))));

export default router;
