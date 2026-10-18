/**
 * approvalService.js — ONE approvals inbox for Management (init.sql §73, TM/s73.sql).
 *
 * Everything that needs Management's yes is a row of cf_approvals: its TYPE, the SUBJECT it is about (a sales order's
 * acceptance, a purchase order …), who asked and when, and a snapshot of what the approver saw. Each type has its own
 * permission tag, so a person sees and decides only the types they hold (the Management tab shows itself to anyone who
 * holds at least one). The thing being approved stays where it lives; its module says what approving and rejecting DO
 * (HANDLERS, loaded on first use so this file imports none of them and no import cycle can form).
 *
 *   requestApproval   ask (or refresh the one already waiting for the same type + subject — never two at once)
 *   withdrawApprovals the subject went away or was changed by its owner: what waited for it is withdrawn
 *   closeApprovals    the subject was decided another way (a script, a fixture): the row follows
 *   listApprovals     the inbox: pending (or decided) rows of the types the person holds, each with live context
 *   decide            approve / reject: the person must hold the type's tag and must not be the one who asked
 *                     (an admin may decide their own, as everywhere else); the handler runs in the same transaction
 *
 * Requester ≠ approver is checked here, once, for every type.
 */
import { CfError, invalid, notFound } from '../lib/errors.js';

export const APPROVAL_TYPES = {
  order_acceptance: { perm: 'cf_erp_approve_order_acceptance', label: 'Customer acceptance', subjectType: 'order_acceptance' },
  rate_change: { perm: 'cf_erp_approve_rate_change', label: 'Rate change after acceptance', subjectType: 'order_acceptance' },
  purchase_order: { perm: 'cf_erp_approve_purchase_order', label: 'Purchase order', subjectType: 'purchase_order' },
  contractor_po: { perm: 'cf_erp_approve_contractor_po', label: 'Contractor PO', subjectType: 'purchase_order' },
  po_close_short: { perm: 'cf_erp_approve_po_close_short', label: 'Close a PO short', subjectType: 'purchase_order' },
  rebaseline: { perm: 'cf_erp_approve_rebaseline', label: 'Re-baseline', subjectType: 'plan' },
};
export const APPROVAL_TYPE_KEYS = Object.keys(APPROVAL_TYPES);
export const APPROVAL_PERMS = APPROVAL_TYPE_KEYS.map((k) => APPROVAL_TYPES[k].perm);
export const APPROVAL_STATUSES = ['pending', 'approved', 'rejected', 'withdrawn'];

/** What approving / rejecting each type does, and its live context — in the module that owns the subject. */
const HANDLERS = {
  order_acceptance: () => import('./acceptanceService.js').then((m) => m.acceptanceApprovalHandler),
  rate_change: () => import('./acceptanceService.js').then((m) => m.acceptanceApprovalHandler),
  purchase_order: () => import('./purchaseService.js').then((m) => m.poApprovalHandler),
  contractor_po: () => import('./purchaseService.js').then((m) => m.poApprovalHandler),
  po_close_short: () => import('./purchaseService.js').then((m) => m.closeShortApprovalHandler),
  rebaseline: async () => null,
};

const blank = (v) => v == null || String(v).trim() === '';
const note500 = (v) => (blank(v) ? null : String(v).trim().slice(0, 500));
const parseJson = (v) => { if (v == null) return null; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return null; } };

function requireType(type) {
  const t = APPROVAL_TYPES[type];
  if (!t) throw invalid('INVALID', `There is no approval of type "${type}".`);
  return t;
}

/**
 * cf_company_settings.approve_own_requests (§78): 1 = a person holding the tag may decide what they asked for themselves.
 * TEMPORARY, for the testing / early-adoption phase (Placebo, 2026-10-18) — turn it off for the four-eyes rule.
 * Reads 0 when the column is not there yet.
 */
export async function approvesOwnRequests(db, companyId) {
  try {
    const [[s]] = await db.query('SELECT approve_own_requests FROM cf_company_settings WHERE company_id = ?', [companyId]);
    return Number(s?.approve_own_requests) === 1;
  } catch { return false; }
}

/** The types a person may decide: `can(tag)` answers for the person (admins pass every tag). */
export const typesFor = (can) => APPROVAL_TYPE_KEYS.filter((k) => can(APPROVAL_TYPES[k].perm));

/**
 * Asks Management. One pending row per type + subject: asking again refreshes it (title, summary, amount, context,
 * note, and the time it was asked) and keeps who asked first. Returns the approval id. 1 read + 1 write.
 */
export async function requestApproval(db, c, { type, subjectId, subjectCode = null, orderId = null, title, summary = null, amount = null, note = null, context = null }) {
  const t = requireType(type);
  const [[have]] = await db.query(
    "SELECT id FROM cf_approvals WHERE company_id = ? AND approval_type = ? AND subject_type = ? AND subject_id = ? AND status = 'pending' AND deleted_at IS NULL FOR UPDATE",
    [c.companyId, type, t.subjectType, Number(subjectId)],
  );
  const ctxText = context == null ? null : JSON.stringify(context);
  const amt = amount == null || !Number.isFinite(Number(amount)) ? null : Math.round(Number(amount) * 100) / 100;
  if (have) {
    await db.query(
      `UPDATE cf_approvals SET subject_code = ?, order_id = ?, title = ?, summary = ?, amount = ?, request_note = COALESCE(?, request_note),
              context_json = COALESCE(?, context_json), requested_at = NOW() WHERE company_id = ? AND id = ?`,
      [subjectCode, orderId, String(title).slice(0, 255), summary == null ? null : String(summary).slice(0, 500), amt, note500(note), ctxText, c.companyId, have.id],
    );
    return have.id;
  }
  const [ins] = await db.query(
    `INSERT INTO cf_approvals (company_id, approval_type, subject_type, subject_id, subject_code, order_id, title, summary, amount, status, requested_by, request_note, context_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
    [c.companyId, type, t.subjectType, Number(subjectId), subjectCode, orderId, String(title).slice(0, 255), summary == null ? null : String(summary).slice(0, 500),
      amt, c.userId ?? null, note500(note), ctxText],
  );
  return ins.insertId;
}

/** What waited for a subject is withdrawn (it was cancelled, or its owner took it back). Set-based, 1 write. */
export async function withdrawApprovals(db, c, { subjectType, subjectId, types = null, note = null }) {
  const where = ["company_id = ?", 'subject_type = ?', 'subject_id = ?', "status = 'pending'", 'deleted_at IS NULL'];
  const args = [c.companyId, subjectType, Number(subjectId)];
  if (types?.length) { where.push('approval_type IN (?)'); args.push(types); }
  await db.query(`UPDATE cf_approvals SET status = 'withdrawn', decided_by = ?, decided_at = NOW(), decision_note = ? WHERE ${where.join(' AND ')}`,
    [c.userId ?? null, note500(note), ...args]);
}

/** The subject was decided another way (approved / rejected by its own service): its pending row follows. 1 write. */
export async function closeApprovals(db, c, { subjectType, subjectId, types, status = 'approved', note = null }) {
  if (!APPROVAL_STATUSES.includes(status) || status === 'pending') throw new Error(`closeApprovals: status ${status}`);
  await db.query(
    `UPDATE cf_approvals SET status = ?, decided_by = ?, decided_at = NOW(), decision_note = COALESCE(?, decision_note)
      WHERE company_id = ? AND subject_type = ? AND subject_id = ? AND approval_type IN (?) AND status = 'pending' AND deleted_at IS NULL`,
    [status, c.userId ?? null, note500(note), c.companyId, subjectType, Number(subjectId), types],
  );
}

function shape(r) {
  const t = APPROVAL_TYPES[r.approval_type];
  return {
    id: r.id,
    type: r.approval_type,
    typeLabel: t?.label ?? r.approval_type,
    permission: t?.perm ?? null,
    subject: { type: r.subject_type, id: r.subject_id, code: r.subject_code ?? null },
    order: r.order_id ? { id: r.order_id, code: r.order_code ?? null, customer: r.customer_name ?? null } : null,
    title: r.title,
    summary: r.summary ?? null,
    amount: r.amount == null ? null : Number(r.amount),
    status: r.status,
    requestedBy: r.requested_by ? { id: r.requested_by, name: r.requester_name ?? null } : null,
    requestedAt: r.requested_at,
    requestNote: r.request_note ?? null,
    decidedBy: r.decided_by ? { id: r.decided_by, name: r.decider_name ?? null } : null,
    decidedAt: r.decided_at ?? null,
    decisionNote: r.decision_note ?? null,
    context: parseJson(r.context_json),
  };
}

const SELECT = `SELECT a.*, o.code AS order_code, cp.name AS customer_name, ru.name AS requester_name, du.name AS decider_name
                  FROM cf_approvals a
                  LEFT JOIN cf_sales_orders o ON o.id = a.order_id
                  LEFT JOIN cf_parties cp ON cp.id = o.customer_id
                  LEFT JOIN users ru ON ru.id = a.requested_by
                  LEFT JOIN users du ON du.id = a.decided_by`;

/** Adds each row's LIVE context (its handler's), grouped by type: one call per type present, never per row. */
async function withLiveContext(db, companyId, rows) {
  const byType = new Map();
  for (const r of rows) { if (!byType.has(r.type)) byType.set(r.type, []); byType.get(r.type).push(r); }
  for (const [type, list] of byType) {
    const h = await HANDLERS[type]?.();
    if (!h?.context) continue;
    const live = await h.context(db, companyId, list.filter((r) => r.status === 'pending'));
    for (const r of list) if (live?.has(r.id)) r.context = live.get(r.id);
  }
  return rows;
}

/**
 * GET /approvals?status=pending|decided|all&type= — the inbox. Only the types `can` allows. Pending rows carry their live
 * context (what the PO / the terms are NOW); a decided row keeps the snapshot of what was decided.
 * → { rows, counts: { [type]: pending }, types: [{ key, label }] }. Fixed: 2 reads + one per type present.
 */
export async function listApprovals(db, companyId, can, q = {}) {
  const types = typesFor(can);
  const out = { rows: [], counts: Object.fromEntries(types.map((t) => [t, 0])), types: types.map((key) => ({ key, label: APPROVAL_TYPES[key].label })) };
  if (!types.length) return out;
  const status = ['pending', 'decided', 'all'].includes(q.status) ? q.status : 'pending';
  const want = !blank(q.type) && types.includes(String(q.type)) ? [String(q.type)] : types;
  const where = ['a.company_id = ?', 'a.deleted_at IS NULL', 'a.approval_type IN (?)'];
  const args = [companyId, want];
  if (status === 'pending') where.push("a.status = 'pending'");
  if (status === 'decided') where.push("a.status <> 'pending'");
  if (!blank(q.orderId)) { where.push('a.order_id = ?'); args.push(Number(q.orderId)); }
  const [[rows], [counts]] = await Promise.all([
    db.query(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY a.status = 'pending' DESC, ${status === 'pending' ? 'a.requested_at' : 'COALESCE(a.decided_at, a.requested_at) DESC'}, a.id LIMIT 200`, args),
    db.query("SELECT approval_type AS t, COUNT(*) AS n FROM cf_approvals WHERE company_id = ? AND deleted_at IS NULL AND status = 'pending' AND approval_type IN (?) GROUP BY approval_type", [companyId, types]),
  ]);
  for (const r of counts) out.counts[r.t] = Number(r.n) || 0;
  out.rows = await withLiveContext(db, companyId, rows.map(shape));
  out.ownAllowed = await approvesOwnRequests(db, companyId);
  return out;
}

/** GET /approvals/:id — one row, with live context while pending. The person must hold its type. */
export async function getApproval(db, companyId, id, can = () => true) {
  const [[r]] = await db.query(`${SELECT} WHERE a.company_id = ? AND a.id = ? AND a.deleted_at IS NULL`, [companyId, Number(id)]);
  if (!r) throw notFound('Approval');
  const row = shape(r);
  if (!can(row.permission)) throw new CfError(403, 'FORBIDDEN', `Permission required: ${row.permission}`);
  return (await withLiveContext(db, companyId, [row]))[0];
}

/** The pending approvals of some subjects (a PO page shows "waiting for Management"). 1 read. */
export async function pendingFor(db, companyId, subjectType, subjectIds) {
  const ids = [...new Set((subjectIds ?? []).map(Number))];
  const out = new Map(ids.map((i) => [i, []]));
  if (!ids.length) return out;
  const [rows] = await db.query(`${SELECT} WHERE a.company_id = ? AND a.subject_type = ? AND a.subject_id IN (?) AND a.status = 'pending' AND a.deleted_at IS NULL ORDER BY a.id`,
    [companyId, subjectType, ids]);
  for (const r of rows) out.get(Number(r.subject_id))?.push(shape(r));
  return out;
}

/**
 * POST /approvals/:id/decide { decision: 'approve' | 'reject', note? } — Management decides. `who` = { can(tag), isAdmin }.
 * Refused: not pending any more, a type the person does not hold, the person who asked (unless admin), a rejection
 * without a reason. The handler does what the decision means (place the PO, confirm the order …) in the same
 * transaction, so a refusal there leaves the row pending. → { approval, result }.
 */
export async function decide(db, c, id, input = {}, who = { can: () => false, isAdmin: false }) {
  const decision = input.decision === 'approve' || input.decision === 'approved' ? 'approve'
    : input.decision === 'reject' || input.decision === 'rejected' ? 'reject' : null;
  if (!decision) throw invalid('INVALID', 'Say approve or reject.');
  const [[row]] = await db.query('SELECT * FROM cf_approvals WHERE company_id = ? AND id = ? AND deleted_at IS NULL FOR UPDATE', [c.companyId, Number(id)]);
  if (!row) throw notFound('Approval');
  const t = requireType(row.approval_type);
  if (!who.can(t.perm)) throw new CfError(403, 'FORBIDDEN', `Approving a ${t.label.toLowerCase()} needs the permission ${t.perm}.`);
  if (row.status !== 'pending') throw invalid('NOT_PENDING', `This was ${row.status} already${row.decided_at ? ` on ${new Date(row.decided_at).toLocaleDateString('en-IN')}` : ''}.`);
  if (row.requested_by && c.userId && Number(row.requested_by) === Number(c.userId) && !who.isAdmin
    && !(await approvesOwnRequests(db, c.companyId))) {
    throw new CfError(403, 'OWN_REQUEST', 'You asked for this one — somebody else in Management decides it.');
  }
  const note = note500(input.note);
  if (decision === 'reject' && !note) throw invalid('REASON', 'Say why it is sent back — the person who asked reads it.');
  const h = await HANDLERS[row.approval_type]?.();
  const result = decision === 'approve' ? await h?.onApprove?.(db, c, row, note) : await h?.onReject?.(db, c, row, note);
  // The context the decision was made on is kept with it.
  let snapshot = null;
  if (h?.context) snapshot = (await h.context(db, c.companyId, [{ id: row.id, subject: { type: row.subject_type, id: row.subject_id }, type: row.approval_type, status: 'pending', requestNote: row.request_note }]))?.get(row.id) ?? null;
  await db.query(
    'UPDATE cf_approvals SET status = ?, decided_by = ?, decided_at = NOW(), decision_note = ?, context_json = COALESCE(?, context_json) WHERE company_id = ? AND id = ?',
    [decision === 'approve' ? 'approved' : 'rejected', c.userId ?? null, note, snapshot ? JSON.stringify(snapshot) : null, c.companyId, row.id],
  );
  return { approval: await getApproval(db, c.companyId, row.id), result: result ?? null };
}

/** The pending approval of one subject for one of some types, or a refusal in words. 1 read. */
export async function pendingOf(db, companyId, subjectType, subjectId, types) {
  const [[r]] = await db.query(
    "SELECT id, approval_type FROM cf_approvals WHERE company_id = ? AND subject_type = ? AND subject_id = ? AND approval_type IN (?) AND status = 'pending' AND deleted_at IS NULL ORDER BY id LIMIT 1",
    [companyId, subjectType, Number(subjectId), types],
  );
  return r ?? null;
}

/** POST /approvals/:id/withdraw — the person who asked takes it back (or an admin). The handler's onWithdraw runs. */
export async function withdraw(db, c, id, { isAdmin = false } = {}) {
  const [[row]] = await db.query('SELECT * FROM cf_approvals WHERE company_id = ? AND id = ? AND deleted_at IS NULL FOR UPDATE', [c.companyId, Number(id)]);
  if (!row) throw notFound('Approval');
  if (row.status !== 'pending') throw invalid('NOT_PENDING', `This was ${row.status} already.`);
  if (!isAdmin && Number(row.requested_by) !== Number(c.userId)) throw new CfError(403, 'FORBIDDEN', 'Only the person who asked can take it back.');
  const h = await HANDLERS[row.approval_type]?.();
  await h?.onWithdraw?.(db, c, row);
  await db.query("UPDATE cf_approvals SET status = 'withdrawn', decided_by = ?, decided_at = NOW() WHERE company_id = ? AND id = ?", [c.userId ?? null, c.companyId, row.id]);
  return getApproval(db, c.companyId, row.id);
}

/** Home / nav: how many wait for this person. 1 read. */
export async function pendingCount(db, companyId, can) {
  const types = typesFor(can);
  if (!types.length) return 0;
  const [[{ n }]] = await db.query("SELECT COUNT(*) AS n FROM cf_approvals WHERE company_id = ? AND deleted_at IS NULL AND status = 'pending' AND approval_type IN (?)", [companyId, types]);
  return Number(n) || 0;
}
