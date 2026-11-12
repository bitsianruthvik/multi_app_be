/**
 * machineRequestService.js — BUYING A NEW MACHINE (user, 2026-11-12):
 *
 *   "Creating new machines, production or planning can make the request. It will be an MR request to stores. Stores should
 *    create a PR which needs a permission from maintenance (need to add their comments). Then it needs to go to MD and if
 *    MD says ok, it will go to procurement who will take quotes and all and give the final PO which first goes to MD for
 *    approval and then goes PO waiting for GRN. Then once the machine comes, there will be a lifecycle for machine. That we
 *    will do in the next change."
 *
 * Decided with the user the same day: the MACHINE MODEL lives in the catalog ("Plasma cutter — Hypertherm XPR300"); the
 * machine register (cf_machines) stays the physical machines, each "bought as" its model. The approvals are two new types.
 *
 *   POST /machine-requests { itemId? | newModel: { name, description? }, machineTypeId?, quantity, needBy?, purpose, notes? }
 *     Production manage (planning) or maintenance. A new model becomes a DRAFT catalog item under Capital equipment ›
 *     Machinery › Machines (made once per company). → an MR "for: New machine" in Stores' MR inbox.
 *   Stores raises its PR as for any MR; that PR waits for approvals before Purchase may touch it (init.sql §103,
 *   cf_buy_requests.approval_state): 'maintenance' → (Maintenance approves, with a comment) → 'md' → (the MD approves)
 *   → 'approved'. A send-back is 'rejected'; Stores asks again (POST /purchase-requests/:id/ask-approval).
 *   Purchase then quotes and raises the PO, which goes to the MD as every PO does, then waits for its GRN.
 * The machine's lifecycle once it arrives (making its register entry) is the next change.
 */
import { invalid, notFound } from '../lib/errors.js';
import { createRequisition } from './requisitionService.js';
import { requestApproval } from './approvalService.js';

const blank = (v) => v == null || String(v).trim() === '';

/** The catalog place machine models sit on: Capital equipment › Machinery › Machines (made once, found by code). */
const PLACE = [
  { code: 'CAPEX', name: 'Capital equipment' },
  { code: 'CAPEX-MACH', name: 'Machinery' },
  { code: 'CAPEX-MACH-MC', name: 'Machines' },
];
export async function machineModelVariant(db, c) {
  let parent = null;
  for (let depth = 0; depth < PLACE.length; depth += 1) {
    const p = PLACE[depth];
    const [[have]] = await db.query('SELECT id FROM cf_classification_nodes WHERE company_id = ? AND code = ? AND deleted_at IS NULL LIMIT 1', [c.companyId, p.code]);
    if (have) { parent = Number(have.id); continue; }
    const [ins] = await db.query(
      `INSERT INTO cf_classification_nodes (company_id, parent_id, depth, scope, code, name, description, sort_order, status, created_by)
       VALUES (?, ?, ?, 'item', ?, ?, 'Machine models bought through Request a new machine.', 0, 'active', ?)`,
      [c.companyId, parent, depth, p.code, p.name, c.userId ?? null],
    );
    parent = Number(ins.insertId);
  }
  return parent;
}

/** GET /machine-models?search= — the machine models in the catalog (Capital equipment › Machinery › Machines), drafts too. */
export async function listMachineModels(db, companyId, q = {}) {
  const term = blank(q.search) ? null : `%${String(q.search).trim().slice(0, 80)}%`;
  const [rows] = await db.query(
    `SELECT m.id, m.code, m.name, m.status FROM cf_master_records m
       JOIN cf_classification_nodes n ON n.id = m.classification_id AND n.code = 'CAPEX-MACH-MC' AND n.company_id = m.company_id
      WHERE m.company_id = ? AND m.deleted_at IS NULL${term ? ' AND (m.code LIKE ? OR m.name LIKE ?)' : ''}
      ORDER BY m.name LIMIT 50`,
    term ? [companyId, term, term] : [companyId],
  );
  return rows.map((r) => ({ id: Number(r.id), code: r.code, name: r.name, status: r.status }));
}

export async function requestMachine(db, c, input = {}) {
  const problems = [];
  const quantity = blank(input.quantity) ? 1 : Number(input.quantity);
  if (!Number.isInteger(quantity) || quantity <= 0 || quantity > 100) problems.push('How many: a whole number from 1.');
  const purpose = blank(input.purpose) ? null : String(input.purpose).trim().slice(0, 300);
  if (!purpose) problems.push('Say what the machine is for.');
  const needBy = blank(input.needBy) ? null : String(input.needBy).slice(0, 10);
  if (needBy && !/^\d{4}-\d{2}-\d{2}$/.test(needBy)) problems.push('Needed by: a date.');
  let machineType = null;
  if (!blank(input.machineTypeId)) {
    const [[t]] = await db.query("SELECT id, code, name FROM cf_classification_nodes WHERE company_id = ? AND id = ? AND scope = 'machine' AND deleted_at IS NULL", [c.companyId, Number(input.machineTypeId)]);
    if (!t) problems.push('That machine type does not exist.');
    machineType = t ?? null;
  }
  const itemId = blank(input.itemId) ? null : Number(input.itemId);
  const model = input.newModel && !blank(input.newModel.name) ? { name: String(input.newModel.name).trim().slice(0, 200), description: blank(input.newModel.description) ? null : String(input.newModel.description).slice(0, 2000) } : null;
  if (!itemId && !model) problems.push('Pick the machine model from the catalog, or name a new one.');
  if (itemId && model) problems.push('Pick a model or name a new one — not both.');
  if (problems.length) throw invalid('INVALID', 'The machine cannot be requested yet.', { problems });

  let modelId = itemId;
  let createdModel = false;
  if (!modelId) {
    const variant = await machineModelVariant(db, c);
    const { createItem } = await import('./masterRecordService.js');
    const made = await createItem(db, c, {
      itemType: 'catalog', classificationId: variant, name: model.name, description: model.description, trackedBy: 'quantity', sourcing: 'stock', uom: 'nos',
    }, { fallbackName: model.name });
    modelId = Number(made.id);
    createdModel = true;
  }
  const lines = [
    `New machine: ${purpose}`,
    machineType ? `Machine type: ${machineType.name}` : null,
    needBy ? `Needed by ${needBy}` : null,
    blank(input.notes) ? null : String(input.notes).trim(),
  ].filter(Boolean).join(' · ').slice(0, 500);
  const mr = await createRequisition(db, c, { forType: 'machine', note: lines, lines: [{ itemId: modelId, qty: quantity }] });
  await db.query('UPDATE cf_requisitions SET machine_request_json = ? WHERE company_id = ? AND id = ?', [
    JSON.stringify({ purpose, needBy, machineTypeId: machineType?.id ?? null, machineTypeName: machineType?.name ?? null, modelId, createdModel, quantity, notes: blank(input.notes) ? null : String(input.notes).trim().slice(0, 500) }),
    c.companyId, mr.id,
  ]);
  return { requisition: mr, modelId, createdModel };
}

/* ── The PR's approvals (§103) ──────────────────────────────────────────────────────────────────────────── */

export const PR_APPROVAL_LABEL = { maintenance: 'Waiting for Maintenance', md: 'Waiting for the MD', approved: 'Approved', rejected: 'Sent back' };

async function prHead(db, companyId, prId, { lock = false } = {}) {
  const [[p]] = await db.query(
    `SELECT br.id, br.code, br.approval_state, br.requisition_id, r.code AS mr_code, r.notes AS mr_notes, r.for_type, r.machine_request_json
       FROM cf_buy_requests br JOIN cf_requisitions r ON r.id = br.requisition_id
      WHERE br.company_id = ? AND br.id = ? AND br.deleted_at IS NULL${lock ? ' FOR UPDATE' : ''}`,
    [companyId, Number(prId)],
  );
  if (!p) throw notFound('Purchase request');
  return p;
}

/** What the approvers read: the PR's lines and the request behind it. */
async function prSummary(db, companyId, p) {
  const [lines] = await db.query(
    `SELECT m.code, m.name, bl.quantity, bl.uom FROM cf_buy_request_lines bl JOIN cf_master_records m ON m.id = bl.item_id
      WHERE bl.company_id = ? AND bl.request_id = ? AND bl.deleted_at IS NULL AND bl.quantity > 0`,
    [companyId, p.id],
  );
  const what = lines.map((l) => `${Number(l.quantity)} × ${l.name ?? l.code}`).join(', ');
  return `${what}${p.mr_notes ? ` — ${p.mr_notes}` : ''}`.slice(0, 500);
}

/** Starts (or restarts) a machine PR's approvals: Maintenance first. Called when the PR is made, or asked again. */
export async function askMaintenance(db, c, prId) {
  const p = await prHead(db, c.companyId, prId, { lock: true });
  await db.query("UPDATE cf_buy_requests SET approval_state = 'maintenance' WHERE company_id = ? AND id = ?", [c.companyId, p.id]);
  await requestApproval(db, c, {
    type: 'machine_pr_maintenance', subjectId: p.id, subjectCode: p.code,
    title: `New machine ${p.code} (${p.mr_code}) — Maintenance`, summary: await prSummary(db, c.companyId, p),
  });
}

/** POST /purchase-requests/:id/ask-approval — a machine PR sent back is asked again (Stores). */
export async function askApprovalAgain(db, c, prId) {
  const p = await prHead(db, c.companyId, prId, { lock: true });
  if (p.for_type !== 'machine') throw invalid('NOT_NEEDED', `${p.code} needs no approval.`);
  if (p.approval_state !== 'rejected') throw invalid('NOT_SENT_BACK', `${p.code} is ${PR_APPROVAL_LABEL[p.approval_state]?.toLowerCase() ?? 'not waiting'} — there is nothing to ask again.`);
  await askMaintenance(db, c, p.id);
  const { getPr } = await import('./purchaseRequestService.js');
  return getPr(db, c.companyId, p.id);
}

const reject = (state) => async (db, c, row) => {
  await db.query("UPDATE cf_buy_requests SET approval_state = 'rejected' WHERE company_id = ? AND id = ? AND approval_state = ?", [c.companyId, row.subject_id, state]);
  return { rejected: true };
};
const withdraw = (state) => (db, c, row) => db.query("UPDATE cf_buy_requests SET approval_state = 'rejected' WHERE company_id = ? AND id = ? AND approval_state = ?", [c.companyId, row.subject_id, state]);

/** Maintenance's step: a comment is required; then it goes to the MD. */
export const maintenanceApprovalHandler = {
  async onApprove(db, c, row, note) {
    if (blank(note)) throw invalid('COMMENT_REQUIRED', 'Maintenance approves a new machine with a comment — say what you checked.');
    const p = await prHead(db, c.companyId, row.subject_id, { lock: true });
    if (p.approval_state !== 'maintenance') throw invalid('NOT_PENDING', `${p.code} is not waiting for Maintenance.`);
    await db.query("UPDATE cf_buy_requests SET approval_state = 'md' WHERE company_id = ? AND id = ?", [c.companyId, p.id]);
    await requestApproval(db, c, {
      type: 'machine_pr_md', subjectId: p.id, subjectCode: p.code,
      title: `New machine ${p.code} (${p.mr_code}) — MD`, summary: await prSummary(db, c.companyId, p),
      note: `Maintenance: ${String(note).trim().slice(0, 450)}`,
    });
    return { toMd: true };
  },
  onReject: reject('maintenance'),
  onWithdraw: withdraw('maintenance'),
};

/** The MD's step: then Purchase may quote and raise the PO. */
export const mdApprovalHandler = {
  async onApprove(db, c, row) {
    await db.query("UPDATE cf_buy_requests SET approval_state = 'approved' WHERE company_id = ? AND id = ? AND approval_state = 'md'", [c.companyId, row.subject_id]);
    return { approved: true };
  },
  onReject: reject('md'),
  onWithdraw: withdraw('md'),
};

/** Why Purchase may not work on a PR yet (null = it may). */
export const approvalBlock = (state) => (state && state !== 'approved'
  ? (state === 'rejected' ? 'This machine purchase was sent back — Stores asks for the approvals again.' : `This machine purchase is ${PR_APPROVAL_LABEL[state].toLowerCase()} — quotes and POs wait for the approvals.`)
  : null);
