/**
 * machine_purchase_test.mjs — §103, buying a NEW machine (user, 2026-11-12): Request a new machine → an MR for "New machine"
 * (a new model becomes a draft catalog item under Capital equipment › Machinery › Machines) → Stores saves the MR → its PR
 * waits for Maintenance (a comment is required) → then the MD → only then may Purchase add vendors, quote and raise the PO
 * (which goes to the MD as every PO does). A send-back is asked again by Stores.
 *
 *   cd multi_app_be && node scripts/cf_kepl/machine_purchase_test.mjs        (CF_MACH_COMPANY, default 2)
 * One transaction, rolled back; the cf_ tables are counted before and after.
 */
import path from 'path';
import { pathToFileURL } from 'url';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
await imp('apps/cf_erp/services/codegenProvider.js');
const { attachNodeCache, detachNodeCache } = await imp('apps/cf_erp/lib/db.js');
const MR = await imp('apps/cf_erp/services/machineRequestService.js');
const PRS = await imp('apps/cf_erp/services/purchaseRequestService.js');
const AP = await imp('apps/cf_erp/services/approvalService.js');
const RQ = await imp('apps/cf_erp/services/requisitionService.js');
const routes = (await imp('apps/cf_erp/routes/purchaseRequests.js')).default;

if (!/^(localhost|127\.0\.0\.1|::1)$/.test(process.env.DB_HOST ?? 'localhost')) throw new Error('This suite is local only.');
const COMPANY = Number(process.env.CF_MACH_COMPANY ?? 2);
const RUN = `TEST-MACH-${Date.now().toString(36).toUpperCase()}`;
let passed = 0; let failed = 0; const fails = [];
function ok(label, cond, detail = '') {
  if (typeof label !== 'string' || typeof cond !== 'boolean') throw new Error('ok(label, cond)');
  if (cond) { passed += 1; console.log(`  PASS  ${label}`); } else { failed += 1; fails.push(label); console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
}
const refusal = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
async function census(db) {
  const [rows] = await db.query("SHOW TABLES LIKE 'cf\\_%'");
  const out = {};
  for (const t of rows.map((r) => Object.values(r)[0]).sort()) { const [[r]] = await db.query(`SELECT COUNT(*) AS n FROM \`${t}\``); out[t] = Number(r.n); }
  return out;
}

const routeList = routes.stack.filter((l) => l.route).map((l) => `${Object.keys(l.route.methods)[0]} ${l.route.path}`);
ok('routes: request a machine, ask the approvals again', routeList.includes('post /machine-requests') && routeList.includes('get /machine-models') && routeList.includes('post /purchase-requests/:id/ask-approval'));
ok('the approval types: Maintenance (maintenance tag), then the MD (its own tag)', AP.APPROVAL_TYPES.machine_pr_maintenance?.perm === 'cf_erp_maintenance' && AP.APPROVAL_TYPES.machine_pr_md?.perm === 'cf_erp_approve_machine_purchase');
ok('"For" has New machine', RQ.FOR_TYPES.includes('machine') && RQ.FOR_LABEL.machine === 'New machine');

const conn = await pool.getConnection();
let before = null;
let exitCode = 0;
try {
  before = await census(conn);
  await conn.beginTransaction();
  attachNodeCache(conn);
  const [[user]] = await conn.query('SELECT id FROM users WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [COMPANY]);
  const c = { companyId: COMPANY, userId: user?.id ?? null };
  const [[other]] = await conn.query('SELECT id FROM users WHERE company_id = ? AND deleted_at IS NULL AND id <> ? ORDER BY id LIMIT 1', [COMPANY, user?.id ?? 0]);
  const md = { companyId: COMPANY, userId: other?.id ?? null };
  const all = { can: () => true, isAdmin: false };
  const asMd = { can: () => true, isAdmin: true };   // the MD step is asked in Maintenance's name: another person decides it
  const [[sup]] = await conn.query("SELECT id FROM cf_parties WHERE company_id = ? AND is_supplier = 1 AND status = 'active' AND deleted_at IS NULL LIMIT 1", [COMPANY]);

  console.log('\nA. Request a new machine');
  const bad = await refusal(() => MR.requestMachine(conn, c, { quantity: 1 }));
  ok('a request needs a purpose and a model', bad?.code === 'INVALID' && bad.problems.some((p) => /what the machine is for/.test(p)) && bad.problems.some((p) => /machine model/.test(p)), JSON.stringify(bad?.problems));
  const r = await MR.requestMachine(conn, c, { newModel: { name: `${RUN} Plasma cutter XPR300` }, quantity: 1, purpose: 'Second plasma line for 40 mm plate', needBy: '2027-01-15' });
  ok('a new model becomes a draft catalog item', r.createdModel === true && Number.isInteger(r.modelId));
  const [[item]] = await conn.query(`SELECT m.status, i.item_type, n.code AS cls FROM cf_master_records m JOIN cf_item_details i ON i.master_id = m.id
    JOIN cf_classification_nodes n ON n.id = m.classification_id WHERE m.id = ?`, [r.modelId]);
  ok('…under Capital equipment › Machinery › Machines', item.item_type === 'catalog' && item.status === 'draft' && item.cls === 'CAPEX-MACH-MC', JSON.stringify(item));
  const [[req]] = await conn.query('SELECT for_type, notes, machine_request_json FROM cf_requisitions WHERE id = ?', [r.requisition.id]);
  const mj = typeof req.machine_request_json === 'string' ? JSON.parse(req.machine_request_json) : req.machine_request_json;
  ok('the MR is "For: New machine", its request kept', req.for_type === 'machine' && /Second plasma line/.test(req.notes) && mj.needBy === '2027-01-15' && mj.createdModel === true);
  const again = await MR.requestMachine(conn, c, { itemId: r.modelId, quantity: 2, purpose: 'Third line' });
  ok('a second request picks the same model, no new item', again.createdModel === false && again.modelId === r.modelId);
  const models = await MR.listMachineModels(conn, COMPANY, { search: RUN });
  ok('the model is in the machine models list', models.length === 1 && models[0].id === r.modelId && models[0].status === 'draft', JSON.stringify(models));

  console.log('\nB. Stores raises the PR: it waits for Maintenance');
  let screen = await PRS.mrScreen(conn, COMPANY, r.requisition.id);
  screen = await PRS.saveMr(conn, c, r.requisition.id, { lines: screen.lines.map((l) => ({ lineId: l.id, takeFromStock: 0 })) });
  const prId = screen.purchaseRequest?.id;
  let pr = await PRS.getPr(conn, COMPANY, prId);
  ok('the PR waits for Maintenance and cannot be bought yet', pr.approval?.state === 'maintenance' && pr.canEdit === false && pr.requisition.forType === 'machine', JSON.stringify(pr.approval));
  const [[ap1]] = await conn.query("SELECT id, status FROM cf_approvals WHERE company_id = ? AND approval_type = 'machine_pr_maintenance' AND subject_id = ? AND status = 'pending'", [COMPANY, prId]);
  ok('…an approval for Maintenance is pending', !!ap1);
  if (sup) {
    const early = await refusal(() => PRS.addVendor(conn, c, prId, { supplierId: sup.id }));
    ok('Purchase may not add a vendor yet', early?.code === 'WAITING_FOR_APPROVAL', early?.message);
  }

  console.log('\nC. Maintenance (with a comment), then the MD');
  const noNote = await refusal(() => AP.decide(conn, md, ap1.id, { decision: 'approve' }, all));
  ok('Maintenance must comment to approve', noNote?.code === 'COMMENT_REQUIRED', noNote?.message);
  await AP.decide(conn, md, ap1.id, { decision: 'approve', note: 'Foundation and 3-phase supply are ready in bay 2.' }, all);
  pr = await PRS.getPr(conn, COMPANY, prId);
  const [[ap2]] = await conn.query("SELECT id, request_note FROM cf_approvals WHERE company_id = ? AND approval_type = 'machine_pr_md' AND subject_id = ? AND status = 'pending'", [COMPANY, prId]);
  ok('then it waits for the MD, Maintenance\'s comment carried', pr.approval?.state === 'md' && !!ap2 && /bay 2/.test(ap2.request_note ?? ''), JSON.stringify([pr.approval, ap2?.request_note]));
  await AP.decide(conn, md, ap2.id, { decision: 'reject', note: 'Get a second quote for the CNC first.' }, asMd);
  pr = await PRS.getPr(conn, COMPANY, prId);
  ok('the MD sends it back', pr.approval?.state === 'rejected' && pr.canEdit === false);
  const twice = await refusal(() => MR.askApprovalAgain(conn, c, prId));
  ok('Stores asks again: Maintenance first', twice === null && (await PRS.getPr(conn, COMPANY, prId)).approval?.state === 'maintenance');
  const [[ap3]] = await conn.query("SELECT id FROM cf_approvals WHERE company_id = ? AND approval_type = 'machine_pr_maintenance' AND subject_id = ? AND status = 'pending'", [COMPANY, prId]);
  await AP.decide(conn, md, ap3.id, { decision: 'approve', note: 'Still ready.' }, all);
  const [[ap4]] = await conn.query("SELECT id FROM cf_approvals WHERE company_id = ? AND approval_type = 'machine_pr_md' AND subject_id = ? AND status = 'pending'", [COMPANY, prId]);
  await AP.decide(conn, md, ap4.id, { decision: 'approve' }, asMd);
  pr = await PRS.getPr(conn, COMPANY, prId);
  ok('approved: Purchase may buy it', pr.approval?.state === 'approved' && pr.canEdit === true);
  const [[model]] = await conn.query('SELECT code, status FROM cf_master_records WHERE id = ?', [r.modelId]);
  ok('§104: the new model has a code and is active now (a GRN refuses a draft)', model.status === 'active' && /^MM-|./.test(model.code ?? ''), JSON.stringify(model));
  if (sup) {
    const withVendor = await PRS.addVendor(conn, c, prId, { supplierId: sup.id });
    ok('Purchase adds a vendor now', withVendor.vendors.length === 1);
  }
  const notMachine = await refusal(() => MR.askApprovalAgain(conn, c, prId));
  ok('an approved PR is not asked again', notMachine?.code === 'NOT_SENT_BACK');
} catch (e) {
  exitCode = 1;
  console.error(e);
} finally {
  try { detachNodeCache(conn); } catch { /* none */ }
  await conn.rollback();
  const after = await census(conn);
  const moved = Object.keys(after).filter((t) => after[t] !== before?.[t]);
  ok('rolled back: every cf_ table has the count it had', moved.length === 0, moved.join(', '));
  conn.release();
  await pool.end();
}
console.log(`\n${passed} passed, ${failed} failed`);
if (fails.length) console.log(`Failed:\n  ${fails.join('\n  ')}`);
process.exit(failed || exitCode ? 1 : 0);
