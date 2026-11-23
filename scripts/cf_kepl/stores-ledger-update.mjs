/**
 * stores-ledger-update.mjs — a newer version of the stores' ledger workbook into a company that already holds an older
 * one: only what changed, as movements (user, 2026-11-23: "a few more changes … get this data properly into the system").
 * The plan is built outside the app from the two workbooks (TM/stores_import/v2/build-plan.mjs → plan-update.json):
 *   receipt  { date, reference, notes, lines: [{ code | newItem: { name, uom, likeCode }, quantity, unitCost?, brand? }] }
 *            one new lot a line, its brand from the name when the brand list has it
 *   issue    { date, party, orderCode, reference, lines: [{ code, quantity }] }  from the oldest lots (as the desk does)
 *
 *   cd multi_app_be
 *   node scripts/cf_kepl/stores-ledger-update.mjs --company 30005 --prod --plan <plan.json> [--departments "URC,V R C"] [--apply]
 * A party with a sales order goes to it. A party named in --departments goes to the department "Project: <party>" (the
 * sandbox way). Any other party is LEFT OUT and listed. An issue line the book cannot fully cover gives out what the book
 * holds (the item ends at 0) and the rest is listed.
 * DRY RUN BY DEFAULT: all in one transaction, rolled back. --apply commits a movement at a time; a reference already
 * there is skipped, so it is safe to run again.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const COMPANY = Number(arg('company'));
const APPLY = process.argv.includes('--apply');
const DEPTS = new Set(String(arg('departments') ?? '').split(',').map((x) => x.trim()).filter(Boolean));
if (!COMPANY || !arg('plan')) { console.error('Usage: --company <id> [--prod] --plan plan.json [--departments "A,B"] [--apply]'); process.exit(2); }
if (process.argv.includes('--prod')) {
  const env = {};
  fs.readFileSync(path.join(__dir, '..', '..', '..', '.env.tidb'), 'utf8').split('\n').forEach((l) => {
    l = l.trim(); if (!l || l.startsWith('#')) return;
    const [k, ...r] = l.split('='); env[k.trim()] = r.join('=').trim();
  });
  Object.assign(process.env, { DB_HOST: env.DB_HOST, DB_PORT: env.DB_PORT ?? '4000', DB_USER: env.DB_USER, DB_PASSWORD: env.DB_PASSWORD, DB_NAME: env.DB_NAME, DB_SSL: 'true' });
}
const imp = (p) => import(pathToFileURL(path.join(__dir, '..', '..', p)).href);
const { pool } = await imp('db.js');
await imp('apps/cf_erp/services/codegenProvider.js');
const { postMovement } = await imp('apps/cf_erp/services/stockService.js');
const { createItem } = await imp('apps/cf_erp/services/masterRecordService.js');
const D = await imp('apps/cf_erp/services/storesDeskService.js');
const { attachNodeCache, detachNodeCache } = await imp('apps/cf_erp/lib/nodeCache.js');

const plan = JSON.parse(fs.readFileSync(arg('plan'), 'utf8'));
const r6 = (n) => Math.round(n * 1e6) / 1e6;
const where = process.env.DB_HOST && !/^(localhost|127\.0\.0\.1)$/.test(process.env.DB_HOST) ? 'PRODUCTION DB' : 'local';

try {
  const [[user]] = await pool.query("SELECT id FROM users WHERE company_id = ? AND deleted_at IS NULL ORDER BY (name LIKE 'Stores%') DESC, id LIMIT 1", [COMPANY]);
  const c = { companyId: COMPANY, userId: user?.id ?? null };
  const [[area]] = await pool.query("SELECT id, code FROM cf_stocking_areas WHERE company_id = ? AND purpose = 'storage' AND status = 'active' AND deleted_at IS NULL ORDER BY id LIMIT 1", [COMPANY]);
  if (!area) throw new Error('No store area.');
  console.log(`${where} — company ${COMPANY} — ${APPLY ? 'APPLY' : 'DRY RUN (rolled back)'} — ${plan.length} movements — area ${area.code}${DEPTS.size ? ` — to departments: ${[...DEPTS].join(', ')}` : ''}`);
  const [brands] = await pool.query('SELECT id, name FROM cf_brands WHERE company_id = ? AND deleted_at IS NULL', [COMPANY]);
  const brandId = (name) => (name ? brands.find((b) => b.name.toLowerCase() === name.toLowerCase())?.id ?? null : null);

  const itemOf = async (db, l) => {
    if (l.code) {
      const [[it]] = await db.query("SELECT m.id, m.code, i.tracked_by FROM cf_master_records m JOIN cf_item_details i ON i.master_id = m.id WHERE m.company_id = ? AND m.code = ? AND m.deleted_at IS NULL", [COMPANY, l.code]);
      if (!it) throw new Error(`${l.code} is not in company ${COMPANY}`);
      return it;
    }
    const n = l.newItem;
    const [[have]] = await db.query("SELECT m.id, m.code, i.tracked_by FROM cf_master_records m JOIN cf_item_details i ON i.master_id = m.id WHERE m.company_id = ? AND UPPER(m.name) = UPPER(?) AND m.record_kind = 'item' AND m.deleted_at IS NULL", [COMPANY, n.name]);
    if (have) return have;
    const [[like]] = await db.query('SELECT classification_id FROM cf_master_records WHERE company_id = ? AND code = ? AND deleted_at IS NULL', [COMPANY, n.likeCode]);
    if (!like) throw new Error(`${n.likeCode} (to file ${n.name} beside) is not there`);
    const prefix = n.likeCode.replace(/-\d+$/, '');
    const [[top]] = await db.query('SELECT MAX(CAST(SUBSTRING(code, ?) AS UNSIGNED)) AS n FROM cf_master_records WHERE company_id = ? AND code LIKE ?', [prefix.length + 2, COMPANY, `${prefix}-%`]);
    const code = `${prefix}-${String((Number(top?.n) || 0) + 1).padStart(4, '0')}`;
    const made = await createItem(db, c, { classificationId: like.classification_id, name: n.name, code, uom: n.uom, trackedBy: 'batch', sourcing: 'stock', status: 'active' });
    const id = made?.id ?? made;
    console.log(`   new item ${code} "${n.name}" beside ${n.likeCode}`);
    return { id: Number(id), code, tracked_by: 'batch' };
  };
  const lotsFor = async (db, itemId, qty) => {
    const [rows] = await db.query(
      `SELECT k.batch_id, k.quantity FROM cf_stock_balances k JOIN cf_stock_batches b ON b.id = k.batch_id
        WHERE k.company_id = ? AND k.item_id = ? AND k.stocking_area_id = ? AND k.quantity > 0 AND b.status = 'available' AND b.owner_party_id IS NULL ORDER BY b.id`, [COMPANY, itemId, area.id]);
    const out = []; let left = qty;
    for (const r of rows) { if (left <= 1e-9) break; const t = Math.min(left, Number(r.quantity)); out.push({ batchId: r.batch_id, quantity: r6(t) }); left = r6(left - t); }
    return { lots: out, short: left > 1e-9 ? left : 0 };
  };
  const dept = new Map();
  const leftOut = []; const short = [];
  const post = async (db, e) => {
    const [[there]] = await db.query('SELECT id FROM cf_stock_movements WHERE company_id = ? AND reference = ? AND reversal_of_id IS NULL LIMIT 1', [COMPANY, e.reference]);
    if (there) return 'skipped';
    if (e.kind === 'receipt') {
      const lines = [];
      for (const l of e.lines) {
        const it = await itemOf(db, l);
        lines.push({ itemId: it.id, quantity: l.quantity, ...(l.unitCost > 0 ? { unitCost: l.unitCost } : {}),
          ...(it.tracked_by === 'batch' ? { batch: { receivedOn: e.date, ...(brandId(l.brand) ? { brandId: brandId(l.brand) } : {}) } } : {}) });
      }
      await postMovement(db, c, { movementType: 'receipt', movementDate: e.date, reference: e.reference, notes: e.notes, toAreaId: area.id, lines }, { allowBackdate: true });
      return 'posted';
    }
    let given; let extra = {};
    if (e.orderCode) {
      const [[o]] = await db.query('SELECT id FROM cf_sales_orders WHERE company_id = ? AND code = ? AND deleted_at IS NULL', [COMPANY, e.orderCode]);
      if (!o) throw new Error(`No sales order ${e.orderCode}`);
      given = { type: 'order' }; extra = { usedFor: 'order', orderId: o.id };
    } else if (DEPTS.has(e.party)) {
      const name = `Project: ${e.party}`;
      if (!dept.has(name)) { const [[d]] = await db.query('SELECT id FROM cf_departments WHERE company_id = ? AND name = ? AND deleted_at IS NULL', [COMPANY, name]); dept.set(name, d?.id ?? (await D.addDepartment(db, c, { name })).id); }
      given = { type: 'department', departmentId: dept.get(name) }; extra = { usedFor: 'general' };
    } else { leftOut.push(...e.lines.map((l) => ({ party: e.party, text: `${e.date} ${e.party}: ${l.code} ${l.quantity} ${l.name}` }))); return 'left out'; }
    const lines = [];
    for (const l of e.lines) {
      const it = await itemOf(db, l);
      if (it.tracked_by === 'batch') {
        // user, 2026-11-23: where the ledger gives out more than it holds, give out what the book has (it ends at 0) and list the rest
        const { lots, short: s } = await lotsFor(db, it.id, l.quantity);
        if (s) short.push(`${e.date} ${e.party}: ${l.code} ${l.name} — ${l.quantity} in the ledger, ${r6(l.quantity - s)} given out, ${s} not in the book`);
        for (const lot of lots) lines.push({ itemId: it.id, quantity: lot.quantity, batchId: lot.batchId });
      } else lines.push({ itemId: it.id, quantity: l.quantity });
    }
    if (!lines.length) return 'nothing';
    await postMovement(db, c, { movementType: 'issue', movementDate: e.date, reference: e.reference, notes: `Stores' ledger: issued to ${e.party}`, fromAreaId: area.id, lines, ...extra }, { allowBackdate: true, given });
    return 'posted';
  };

  const tally = {}; let failed = 0;
  const run = async (db, e) => {
    try { if (!APPLY) await db.query('SAVEPOINT one'); const r = await post(db, e); tally[r] = (tally[r] ?? 0) + 1; console.log(`   ${r.padEnd(8)} ${e.reference} (${e.lines.length} lines)`); }
    catch (err) { if (!APPLY) await db.query('ROLLBACK TO SAVEPOINT one'); failed++; console.log(`   FAILED   ${e.reference}: ${err.message}${err.problems ? ' — ' + err.problems.slice(0, 4).join('; ') : ''}`); throw err; }
  };
  if (!APPLY) {
    const db = await pool.getConnection();
    try { await db.beginTransaction(); attachNodeCache(db); for (const e of plan) { try { await run(db, e); } catch { /* listed */ } } }
    finally { try { await db.rollback(); } catch { /* */ } detachNodeCache(db); db.release(); }
  } else {
    for (const e of plan) {
      const db = await pool.getConnection();
      try { await db.beginTransaction(); attachNodeCache(db); await run(db, e); await db.commit(); }
      catch { try { await db.rollback(); } catch { /* */ } dept.clear(); }
      finally { detachNodeCache(db); db.release(); }
    }
  }
  console.log(`\n${JSON.stringify(tally)}, failed ${failed}`);
  if (short.length) { console.log(`${short.length} issue line(s) the book could not fully cover — given out what it holds, the rest listed:`); short.forEach((s) => console.log(`   ${s}`)); }
  if (leftOut.length) console.log(`${leftOut.length} issue line(s) left out — no sales order or department for their party (${[...new Set(leftOut.map((x) => x.party))].join(', ')})`);
  process.exitCode = failed ? 1 : 0;
} finally { await pool.end(); }
