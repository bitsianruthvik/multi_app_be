/**
 * truss-order.mjs — the Thane Coastal Road 75.0 m steel truss (Tandon Consultants EB427-NEC-TCR-DW-3451..3471) as a
 * sales order in Placebo: the customer, the order, one line made from the imported standard, and every LEVEL's
 * drawing (TM/drawing_bom/out/<SET>/levels/<MARK>.dxf) attached to the line's rows with that drawing mark.
 * DRY RUN BY DEFAULT (rolled back); --apply commits. One transaction.
 *
 *   cd multi_app_be
 *   node scripts/cf_kepl/truss-order.mjs ../drawing_bom/out/TCPL_TRUSS_75M --company 30005 --prod [--apply]
 *        [--quantity 3]   spans on the line (default 3: PL133–PL134, PL247–PL248, PR135–PR136)
 *        [--user <id>]    written as (default: the company's admin@ login, else its first user)
 * Uses the app's own services (createParty, createOrder, addLineFromStandard, uploadDrawings), as the screens do.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const folder = path.resolve(process.argv[2] ?? '');
const COMPANY = Number(arg('company'));
const APPLY = process.argv.includes('--apply');
const QTY = Number(arg('quantity') ?? 3);
if (!fs.existsSync(path.join(folder, 'bom.json')) || !Number.isInteger(COMPANY)) {
  console.error('Usage: node scripts/cf_kepl/truss-order.mjs <set folder> --company <id> [--prod] [--apply] [--quantity n] [--user id]');
  process.exit(2);
}
if (process.argv.includes('--prod')) {
  const env = {};
  fs.readFileSync(path.join(__dir, '..', '..', '..', '.env.tidb'), 'utf8').split('\n').forEach((l) => {
    l = l.trim(); if (!l || l.startsWith('#')) return;
    const [k, ...r] = l.split('='); env[k.trim()] = r.join('=').trim();
  });
  Object.assign(process.env, { DB_HOST: env.DB_HOST, DB_PORT: env.DB_PORT ?? '4000', DB_USER: env.DB_USER, DB_PASSWORD: env.DB_PASSWORD, DB_NAME: env.DB_NAME, DB_SSL: 'true' });
}
const BE = path.join(__dir, '..', '..');
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
await imp('apps/cf_erp/services/codegenProvider.js');
const { createParty } = await imp('apps/cf_erp/modules/parties/service.js');
const { createOrder } = await imp('apps/cf_erp/services/salesOrderService.js');
const { addLineFromStandard } = await imp('apps/cf_erp/services/standardDrawingService.js');
const { uploadDrawings, rowsOfLine } = await imp('apps/cf_erp/services/partDrawingService.js');

const bom = JSON.parse(fs.readFileSync(path.join(folder, 'bom.json'), 'utf8'));
const meta = bom.order ?? {};
const levelsDir = path.join(folder, 'levels');
const levels = fs.existsSync(levelsDir) ? fs.readdirSync(levelsDir).filter((f) => /\.dxf$/i.test(f)) : [];

const db = await pool.getConnection();
try {
  const where = process.env.DB_HOST && !/^(localhost|127\.0\.0\.1)$/.test(process.env.DB_HOST) ? 'PRODUCTION' : 'local';
  const [[co]] = await db.query('SELECT id, name FROM companies WHERE id = ?', [COMPANY]);
  const [[admin]] = await db.query("SELECT id FROM users WHERE company_id = ? AND email LIKE 'admin@%' ORDER BY id LIMIT 1", [COMPANY]);
  const userId = arg('user') ? Number(arg('user')) : admin?.id ?? (await db.query('SELECT id FROM users WHERE company_id = ? ORDER BY id LIMIT 1', [COMPANY]))[0][0]?.id;
  const c = { companyId: COMPANY, userId };
  console.log(`${where} — company ${co.id} ${co.name} — ${APPLY ? 'APPLY' : 'DRY RUN (rolled back)'} — as user ${userId}`);
  await db.beginTransaction();

  // 1. The customer (found again by code, else made).
  const cust = meta.customer;
  let [[party]] = await db.query('SELECT id, name FROM cf_parties WHERE company_id = ? AND code = ? AND deleted_at IS NULL', [COMPANY, cust.code]);
  if (!party) { party = await createParty(db, c, { ...cust, roles: ['customer'] }); console.log(`customer made: #${party.id} ${party.name}`); }
  else console.log(`customer found: #${party.id} ${party.name}`);

  // 2. The order.
  const order = await createOrder(db, c, { orderType: 'customer', customerId: party.id, title: meta.title, customerReference: meta.customerReference, notes: meta.notes });
  console.log(`order made: #${order.id ?? order.order?.id} ${order.code ?? order.order?.code}`);
  const orderId = Number(order.id ?? order.order?.id);

  // 3. The line from the standard.
  const [[std]] = await db.query('SELECT id, number FROM cf_standard_drawings WHERE company_id = ? AND deleted_at IS NULL AND number IN (?, ?) ORDER BY id DESC LIMIT 1', [COMPANY, bom.drawing.number, `${bom.drawing.number}${bom.drawing.revision ?? ''}`]);
  if (!std) throw new Error(`No standard ${bom.drawing.number} — import it first (standard-import.mjs).`);
  const made = await addLineFromStandard(db, c, orderId, { standardId: std.id, quantity: QTY, description: meta.lineDescription });
  const lineId = made.fromStandard.lineId;
  console.log(`line made: #${lineId} — ${made.fromStandard.rows} rows from ${made.fromStandard.number} v${made.fromStandard.versionNo}, ×${QTY}`);

  // 4. Each level's drawing onto the rows with its mark (aimed by row id, every copy of that design takes it).
  const [[line]] = await db.query('SELECT * FROM cf_sales_order_lines WHERE company_id = ? AND id = ?', [COMPANY, lineId]);
  const rows = await rowsOfLine(db, COMPANY, { ...line, order_id: orderId });
  const byMark = new Map();
  for (const r of rows) if (r.mark) { const k = String(r.mark).toUpperCase(); if (!byMark.has(k)) byMark.set(k, r); }
  // The import links the set's main sheet (the GA, 3451) to every assembly row; each level has its own drawing here, so on
  // this line only the span keeps that link (SPAN.dxf, the GA, becomes the sheet's file) and the other rows drop it.
  const root = rows.find((r) => Number(r.depth) === 0) ?? rows[0];
  const [[mainReg]] = await db.query('SELECT id FROM cf_drawings WHERE company_id = ? AND number = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 1', [COMPANY, bom.drawing.number]);
  if (mainReg) {
    const others = rows.filter((r) => r.id !== root.id).map((r) => r.id);
    const [u] = await db.query('UPDATE cf_drawing_links SET deleted_at = NOW() WHERE company_id = ? AND drawing_id = ? AND subject_id IN (?) AND deleted_at IS NULL', [COMPANY, mainReg.id, others]);
    console.log(`main sheet links taken off ${u.affectedRows} level rows (kept on the span)`);
  }
  byMark.set('SPAN', root);
  const files = [];
  for (const f of levels) {
    const mark = f.replace(/\.dxf$/i, '').toUpperCase();
    const row = byMark.get(mark);
    if (!row) { console.log(`  level ${f}: no row with mark ${mark} — skipped`); continue; }
    files.push({ name: f, content: fs.readFileSync(path.join(levelsDir, f)).toString('base64'), rowId: row.id });
  }
  // The order and the line commit first; the level drawings (up to ~3.5 MB each, ~70 MB in all) then go in batches
  // of 6, one transaction each, so no transaction is huge. A dry run sends the first batch only, inside its rollback.
  if (APPLY) { await db.commit(); console.log('order and line COMMITTED'); }
  const st = {};
  for (let i = 0; i < files.length; i += 6) {
    const batch = files.slice(i, i + 6);
    if (APPLY) await db.beginTransaction();
    const up = await uploadDrawings(db, c, orderId, lineId, { files: batch, dryRun: false });
    for (const x of up.files ?? []) { st[x.status] = (st[x.status] ?? 0) + 1; if (!['new', 'replaces'].includes(x.status)) console.log(`  ${x.name}: ${x.status} ${(x.problems ?? x.warnings ?? []).join(' ')}`); }
    if (APPLY) await db.commit();
    console.log(`  level drawings ${i + batch.length}/${files.length} — ${JSON.stringify(st)}`);
    if (!APPLY) break;
  }
  const [[cnt]] = await db.query('SELECT COUNT(*) n FROM cf_part_drawings WHERE company_id = ? AND order_line_id = ? AND deleted_at IS NULL', [COMPANY, lineId]);
  console.log(`drawings on the line now: ${cnt.n}`);
  if (APPLY) { console.log('DONE'); } else { await db.rollback(); console.log('Dry run — rolled back.'); }
} catch (e) {
  try { await db.rollback(); } catch { /* none */ }
  console.error('FAILED (rolled back):', e.message, e.detail ? JSON.stringify(e.detail).slice(0, 800) : '');
  process.exitCode = 1;
} finally { db.release(); await pool.end(); }
