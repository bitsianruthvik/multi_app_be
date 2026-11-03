/**
 * tub-order.mjs — the Khajaguda flyover steel tub girders (GHMC-KHAJ-DD-1100… P10–P13, GHMC-KHAJ-DD-1400… P15–P17) as ONE
 * sales order in Placebo: the customer, the order, one line per structure from its imported standard, each level's drawing
 * on its rows, the mill's custom-plate rules, 'standard + custom' on both lines, the plan that makes both lines ONE
 * production order, and the cut pieces. DRY RUN BY DEFAULT (rolled back); --apply commits.
 *
 *   cd multi_app_be
 *   node scripts/cf_kepl/tub-order.mjs --company 30005 --prod [--order SO260019] [--apply]     --order: new lines on that order
 * Uses the app's own services, as the screens do. Import the standards first (standard-import.mjs).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const COMPANY = Number(arg('company'));
const APPLY = process.argv.includes('--apply');
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
const { saveExecutionPlan } = await imp('apps/cf_erp/services/executionPlanService.js');

const OUT = path.join(BE, '..', 'drawing_bom', 'out');
const SETS = [
  { dir: 'KHAJ_3X30', description: 'P10–P13: 3 × 30 m continuous steel tub girder superstructure, two girders' },
  { dir: 'KHAJ_2X30', description: 'P15–P17: 2 × 30 m continuous steel tub girder superstructure, two girders' },
];
// The mill's rules for custom plates (user, 2026-11-02); standard sizes carry no such rule.
const CUSTOM = { on: true, maxLength: 14000, maxWidth: 3000, minLength: 6000, minWidth: 1250, minLotPieces: 5, minLotTonnes: 20 };

const db = await pool.getConnection();
try {
  const [[admin]] = await db.query("SELECT id FROM users WHERE company_id = ? AND email LIKE 'admin@%' ORDER BY id LIMIT 1", [COMPANY]);
  const c = { companyId: COMPANY, userId: admin.id };
  const where = process.env.DB_HOST && !/^(localhost|127\.0\.0\.1)$/.test(process.env.DB_HOST) ? 'PRODUCTION' : 'local';
  console.log(`${where} — company ${COMPANY} — ${APPLY ? 'APPLY' : 'DRY RUN (rolled back)'}`);
  await db.beginTransaction();

  const first = JSON.parse(fs.readFileSync(path.join(OUT, SETS[0].dir, 'bom.json'), 'utf8'));
  const cust = first.order.customer;
  let [[party]] = await db.query('SELECT id, name FROM cf_parties WHERE company_id = ? AND code = ? AND deleted_at IS NULL', [COMPANY, cust.code]);
  if (!party) { party = await createParty(db, c, { ...cust, roles: ['customer'] }); console.log(`customer made: #${party.id} ${party.name}`); } else console.log(`customer found: #${party.id} ${party.name}`);

  const [[had]] = arg('order') ? await db.query('SELECT id, code FROM cf_sales_orders WHERE company_id = ? AND code = ? AND deleted_at IS NULL', [COMPANY, arg('order')]) : [[null]];
  if (arg('order') && !had) throw new Error(`No order ${arg('order')}.`);
  const order = had ?? await createOrder(db, c, {
    orderType: 'customer', customerId: party.id, title: 'Khajaguda flyover: steel tub girders P10–P13 and P15–P17',
    customerReference: 'GHMC-KHAJ-DD-1101 / GHMC-KHAJ-DD-1401',
    notes: 'BOM read from the scanned good-for-construction sheets; see each line\'s readings (plan radius, EJ gap, hole notes against dimensions, stud size).',
  });
  const orderId = Number(order.id ?? order.order?.id); const orderCode = order.code ?? order.order?.code;
  console.log(`order made: #${orderId} ${orderCode}`);

  await db.query(
    `INSERT INTO cf_company_settings (company_id, nest_custom_plates, updated_by) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE nest_custom_plates = VALUES(nest_custom_plates), updated_by = VALUES(updated_by)`,
    [COMPANY, JSON.stringify(CUSTOM), c.userId],
  );
  console.log(`custom plate rules: ${JSON.stringify(CUSTOM)}`);

  const lines = [];
  for (const s of SETS) {
    const bom = JSON.parse(fs.readFileSync(path.join(OUT, s.dir, 'bom.json'), 'utf8'));
    const [[std]] = await db.query('SELECT id, number FROM cf_standard_drawings WHERE company_id = ? AND deleted_at IS NULL AND number IN (?, ?) ORDER BY id DESC LIMIT 1', [COMPANY, bom.drawing.number, `${bom.drawing.number}${bom.drawing.revision}`]);
    if (!std) throw new Error(`No standard ${bom.drawing.number}: import it first (standard-import.mjs).`);
    const made = await addLineFromStandard(db, c, orderId, { standardId: std.id, quantity: 1, description: s.description });
    const lineId = made.fromStandard.lineId;
    console.log(`line made: #${lineId}, ${made.fromStandard.rows} rows from ${made.fromStandard.number} v${made.fromStandard.versionNo}`);
    await db.query("UPDATE cf_sales_order_lines SET nest_plates = 'any' WHERE company_id = ? AND id = ?", [COMPANY, lineId]);
    lines.push({ ...s, lineId, bom, std });
  }
  // Both lines one production order. Made when the order is locked and confirmed; the plan says so from now.
  await saveExecutionPlan(db, c, orderId, { production: { level: 'order' } });
  console.log('execution plan: every line on the order level, so one production order');
  if (APPLY) { await db.commit(); console.log('order, lines and plan COMMITTED'); await db.beginTransaction(); }

  for (const l of lines) {
    const [[line]] = await db.query('SELECT * FROM cf_sales_order_lines WHERE company_id = ? AND id = ?', [COMPANY, l.lineId]);
    const rows = await rowsOfLine(db, COMPANY, { ...line, order_id: orderId });
    const byMark = new Map();
    for (const r of rows) if (r.mark) { const k = String(r.mark).toUpperCase(); if (!byMark.has(k)) byMark.set(k, r); }
    const root = rows.find((r) => Number(r.depth) === 0) ?? rows[0];
    byMark.set('VIADUCT', root);
    // The girders carry no drawing mark of their own (an importer's top rows): they come in the tree's order.
    const tops = rows.filter((r) => Number(r.depth) === 1 && !r.mark).sort((a, b) => Number(a.seq ?? 0) - Number(b.seq ?? 0));
    tops.slice(0, 2).forEach((r, i) => byMark.set(`G${i + 1}`, r));
    // The import links the set's sheets to the assembly rows; each level has its own drawing here, so only the span keeps its sheet.
    const others = rows.filter((r) => r.id !== root.id).map((r) => r.id);
    const [regs] = await db.query("SELECT id FROM cf_drawings WHERE company_id = ? AND number LIKE 'GHMC-KHAJ-DD-%' AND deleted_at IS NULL", [COMPANY]);
    if (regs.length) await db.query('UPDATE cf_drawing_links SET deleted_at = NOW() WHERE company_id = ? AND drawing_id IN (?) AND subject_id IN (?) AND deleted_at IS NULL', [COMPANY, regs.map((r) => r.id), others]);
    const dir = path.join(OUT, l.dir, 'levels');
    const files = [];
    for (const f of fs.readdirSync(dir).filter((n) => /\.dxf$/i.test(n))) {
      const row = byMark.get(f.replace(/\.dxf$/i, '').toUpperCase());
      if (!row) { console.log(`  level ${f}: no row with that mark, skipped`); continue; }
      files.push({ name: f, content: fs.readFileSync(path.join(dir, f)).toString('base64'), rowId: row.id });
    }
    for (let i = 0; i < files.length; i += 6) {
      const up = await uploadDrawings(db, c, orderId, l.lineId, { files: files.slice(i, i + 6), dryRun: false });
      for (const x of up.files ?? []) if (!['new', 'replaces'].includes(x.status)) console.log(`  ${x.name}: ${x.status} ${(x.problems ?? x.warnings ?? []).join('; ')}`);
      if (APPLY) { await db.commit(); await db.beginTransaction(); }
      if (!APPLY) break;
    }
    console.log(`  ${l.dir}: ${files.length} level drawings`);
    if (APPLY) { await db.commit(); await db.beginTransaction(); }
  }
  if (APPLY) { await db.commit(); console.log(`DONE: ${orderCode}, lines ${lines.map((l) => l.lineId).join(', ')}`); } else { await db.rollback(); console.log('Dry run: rolled back.'); }
} catch (e) {
  try { await db.rollback(); } catch { /* none */ }
  console.error('FAILED (rolled back):', e.message, e.detail ? JSON.stringify(e.detail).slice(0, 800) : '', e.problems ? JSON.stringify(e.problems).slice(0, 800) : '');
  process.exitCode = 1;
} finally { db.release(); await pool.end(); process.exit(process.exitCode ?? 0); }
