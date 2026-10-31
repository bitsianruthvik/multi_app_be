/**
 * tt24-order.mjs — a new sales order for the T&T 24 m composite girder span (RDSO/B-11780, fab drawing
 * PFPL/TRACKS&TOWERS/24M SPAN/01–08), made from the BOM already built and checked on SO260002 (line 390001):
 * that line is saved as a STANDARD (rows, values, every drawing it carries — 210 of 210 rows), and the new order's
 * line is made from the standard, as the screens' "line from a standard drawing" does. SO260002 itself is left as it
 * was (its line's standard fields are put back in the same transaction). DRY RUN BY DEFAULT (rolled back); --apply.
 *
 *   cd multi_app_be
 *   node scripts/cf_kepl/tt24-order.mjs --company 30005 --prod [--apply] [--quantity 1] [--from-line 390001]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const COMPANY = Number(arg('company'));
const APPLY = process.argv.includes('--apply');
const QTY = Number(arg('quantity') ?? 1);
const FROM_LINE = Number(arg('from-line') ?? 390001);
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
const { saveLineAsStandard } = await imp('apps/cf_erp/services/drawingLineService.js');
const { createOrder } = await imp('apps/cf_erp/services/salesOrderService.js');
const { addLineFromStandard } = await imp('apps/cf_erp/services/standardDrawingService.js');
const { drawingTree } = await imp('apps/cf_erp/services/partDrawingService.js');

const NUMBER = 'PFPL/TRACKS&TOWERS/24M SPAN';
const db = await pool.getConnection();
try {
  const [[admin]] = await db.query("SELECT id FROM users WHERE company_id = ? AND email LIKE 'admin@%' ORDER BY id LIMIT 1", [COMPANY]);
  const c = { companyId: COMPANY, userId: admin.id };
  console.log(`company ${COMPANY} — ${APPLY ? 'APPLY' : 'DRY RUN (rolled back)'}`);
  await db.beginTransaction();

  // 1. The standard, from SO260002's line (found again if a run made it before).
  let [[std]] = await db.query('SELECT id, number, current_version_id FROM cf_standard_drawings WHERE company_id = ? AND number = ? AND deleted_at IS NULL', [COMPANY, NUMBER]);
  if (!std) {
    const [[src]] = await db.query('SELECT l.id, l.order_id, o.code, l.standard_id, l.standard_version_id, l.standard_kept_sig FROM cf_sales_order_lines l JOIN cf_sales_orders o ON o.id = l.order_id WHERE l.company_id = ? AND l.id = ?', [COMPANY, FROM_LINE]);
    if (src.standard_id) throw new Error(`Line ${FROM_LINE} is already tied to standard #${src.standard_id}.`);
    await saveLineAsStandard(db, c, FROM_LINE, {
      number: NUMBER, revision: '0',
      name: 'T&T 24 m composite girder span, 5 girders (RDSO/B-11780) — fab drawing PFPL/TRACKS&TOWERS/24M SPAN/01–08',
      description: 'Tracks and Towers 24.0 m composite girder span, 5 girders, RDSO/B-11780; BOM and drawings as built and checked on SO260002.',
      note: `From ${src.code} line ${FROM_LINE}`,
    });
    // SO260002 stays as it was: its line is not tied to the new standard.
    await db.query('UPDATE cf_sales_order_lines SET standard_id = ?, standard_version_id = ?, standard_kept_sig = ? WHERE company_id = ? AND id = ?',
      [src.standard_id, src.standard_version_id, src.standard_kept_sig, COMPANY, FROM_LINE]);
    [[std]] = await db.query('SELECT id, number, current_version_id FROM cf_standard_drawings WHERE company_id = ? AND number = ? AND deleted_at IS NULL', [COMPANY, NUMBER]);
    const [[v]] = await db.query('SELECT version_no, rows_count, parts_count, weight_kg FROM cf_standard_drawing_versions WHERE id = ?', [std.current_version_id]);
    const [[f]] = await db.query('SELECT COUNT(*) n FROM cf_standard_drawing_files WHERE company_id = ? AND version_id = ?', [COMPANY, std.current_version_id]);
    console.log(`standard made: #${std.id} ${std.number} v${v.version_no} — ${v.rows_count} rows, ${v.parts_count} parts, ${Math.round(v.weight_kg)} kg, ${f.n} files`);
  } else console.log(`standard found: #${std.id} ${std.number}`);

  // 2. The order, for Tracks and Towers.
  const [[party]] = await db.query("SELECT id, name FROM cf_parties WHERE company_id = ? AND code = 'C002' AND deleted_at IS NULL", [COMPANY]);
  const order = await createOrder(db, c, {
    orderType: 'customer', customerId: party.id,
    title: 'T&T 24 m span (RDSO-B-11780) — 5 girders, from fab drawing PFPL/TRACKS&TOWERS/24M SPAN/01-08',
    customerReference: 'PFPL/TRACKS&TOWERS/24M SPAN/01-08',
    notes: 'From "T&T 24M (RDSO-B-11780) - FAB DRAWING.dxf" (received 2026-10-31). Steel E350 B0. BOM and drawings from the standard made of SO260002 (same drawing).',
  });
  console.log(`order made: #${order.id} ${order.code} for ${party.name}`);

  // 3. The line from the standard.
  const made = await addLineFromStandard(db, c, order.id, { standardId: std.id, quantity: QTY, description: '24.0 m composite girder span, 5 girders — RDSO/B-11780 (PFPL/TRACKS&TOWERS/24M SPAN/01-08)' });
  const lineId = made.fromStandard.lineId;
  console.log(`line made: #${lineId} — ${made.fromStandard.rows} rows, ×${QTY}`);
  const t = await drawingTree(db, COMPANY, order.id, lineId);
  console.log(`rows ${t.rows.length}, with their own drawing ${t.rows.filter((r) => r.hasDrawing).length}`);
  if (APPLY) { await db.commit(); console.log('COMMITTED'); } else { await db.rollback(); console.log('Dry run — rolled back.'); }
} catch (e) {
  try { await db.rollback(); } catch { /* none */ }
  console.error('FAILED (rolled back):', e.message, e.detail ? JSON.stringify(e.detail).slice(0, 600) : '', e.problems ? JSON.stringify(e.problems).slice(0, 600) : '');
  process.exitCode = 1;
} finally { db.release(); await pool.end(); }
