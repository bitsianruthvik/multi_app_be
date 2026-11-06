/**
 * girder-order.mjs — a structure package (TM/drawing_bom/out/<SET>, checked by orderCheck) as ONE sales order: the customer
 * from bom.order, the order, one line from its imported standard, each level's drawing on its rows. Status stays inquiry;
 * nothing is nested, locked or confirmed. DRY RUN BY DEFAULT (rolled back); --apply commits.
 *
 *   cd multi_app_be
 *   node scripts/cf_kepl/standard-import.mjs ../drawing_bom/out/<SET> --company 30005 --no-gap-fill [--prod] [--apply]    first
 *   node scripts/cf_kepl/girder-order.mjs --set <SET> --company 30005 [--qty 2] [--prod] [--apply]
 *   Replace on an existing order: --into-order <id> --remove <lineId,lineId> adds the new line there and takes those lines off in one transaction (removeOrderLine: refused if released or locked).
 *   node scripts/cf_kepl/model3d-attach.mjs --company 30005 --standard <id> --file ../drawing_bom/out/<SET>/model.json [--prod] [--apply]
 *   node scripts/cf_kepl/bolts-load.mjs --company 30005 --line <id> --bolts ../drawing_bom/out/<SET>/bolts.json --match mark [--prod] [--apply]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const COMPANY = Number(arg('company')); const SET = arg('set'); const APPLY = process.argv.includes('--apply');
if (!COMPANY || !SET) { console.error('Usage: --set <SET> --company <id> [--qty n] [--prod] [--apply]'); process.exit(2); }
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
const { createOrder, removeOrderLine } = await imp('apps/cf_erp/services/salesOrderService.js');
const { addLineFromStandard } = await imp('apps/cf_erp/services/standardDrawingService.js');
const { uploadDrawings, rowsOfLine } = await imp('apps/cf_erp/services/partDrawingService.js');

const DIR = path.join(BE, '..', 'drawing_bom', 'out', SET);
const bom = JSON.parse(fs.readFileSync(path.join(DIR, 'bom.json'), 'utf8'));
const QTY = Number(arg('qty') ?? bom.order?.spans ?? 1);

const db = await pool.getConnection();
try {
  const [[admin]] = await db.query("SELECT id FROM users WHERE company_id = ? AND email LIKE 'admin@%' ORDER BY id LIMIT 1", [COMPANY]);
  const c = { companyId: COMPANY, userId: admin.id };
  const where = process.env.DB_HOST && !/^(localhost|127\.0\.0\.1)$/.test(process.env.DB_HOST) ? 'PRODUCTION' : 'local';
  console.log(`${where} — company ${COMPANY} — ${SET} — ${APPLY ? 'APPLY' : 'DRY RUN (rolled back)'}`);
  await db.beginTransaction();

  const cust = bom.order.customer;
  let [[party]] = await db.query('SELECT id, name FROM cf_parties WHERE company_id = ? AND (code = ? OR name = ?) AND deleted_at IS NULL ORDER BY id LIMIT 1', [COMPANY, cust.code, cust.name]);
  if (!party) { party = await createParty(db, c, { ...cust, roles: ['customer'] }); console.log(`customer made: #${party.id} ${party.name}`); } else console.log(`customer found: #${party.id} ${party.name}`);

  const number = bom.drawing.number; const withRev = `${number}${bom.drawing.revision ?? ''}`;
  const [[std]] = await db.query('SELECT id, number FROM cf_standard_drawings WHERE company_id = ? AND deleted_at IS NULL AND number IN (?, ?) ORDER BY id DESC LIMIT 1', [COMPANY, number, withRev]);
  if (!std) throw new Error(`No standard ${withRev}: import it first (standard-import.mjs).`);

  const into = Number(arg('into-order'));
  const order = into ? (await db.query('SELECT id, code FROM cf_sales_orders WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [COMPANY, into]))[0][0] : null;
  if (into && !order) throw new Error(`No order #${into}`);
  const made0 = into ? null : await createOrder(db, c, { orderType: 'customer', customerId: party.id, title: bom.order.title, customerReference: bom.order.reference, notes: bom.order.notes ?? `BOM read from ${bom.drawing.sourceFile}; held to the engineer's BOQ (see the package's CORRECTIONS.md).` });
  const orderRec = order ?? made0;
  const orderId = Number(orderRec.id ?? orderRec.order?.id); const orderCode = orderRec.code ?? orderRec.order?.code;
  console.log(`${into ? 'order found' : 'order made'}: #${orderId} ${orderCode}`);
  const made = await addLineFromStandard(db, c, orderId, { standardId: std.id, quantity: QTY, description: bom.order.title });
  const lineId = made.fromStandard.lineId;
  console.log(`line made: #${lineId} × ${QTY}, ${made.fromStandard.rows} rows from ${made.fromStandard.number} v${made.fromStandard.versionNo}`);
  for (const old of String(arg('remove') ?? '').split(',').map(Number).filter(Boolean)) {
    if (!into) throw new Error('--remove needs --into-order');
    await removeOrderLine(db, c, old); console.log(`line removed: #${old}`);
  }
  if (APPLY) { await db.commit(); await db.beginTransaction(); }

  const [[line]] = await db.query('SELECT * FROM cf_sales_order_lines WHERE company_id = ? AND id = ?', [COMPANY, lineId]);
  const rows = await rowsOfLine(db, COMPANY, { ...line, order_id: orderId });
  // Every row with that mark takes the level's drawing: a splice set stands under each girder.
  const byMark = new Map(); const addTo = (k, r) => { const u = String(k).toUpperCase(); if (!byMark.has(u)) byMark.set(u, []); byMark.get(u).push(r); };
  const root = rows.find((r) => Number(r.depth) === 0) ?? rows[0];
  addTo(bom.assembly.id, root);
  const assemblyIds = new Set(); (function w(n) { if (n.children) { assemblyIds.add(String(n.id).toUpperCase()); n.children.forEach(w); } })(bom.assembly);
  for (const r of rows) {
    if (r === root) continue;
    const m = String(r.mark ?? '').toUpperCase(); const n = String(r.name ?? '').split('/')[0].trim().toUpperCase();
    if (assemblyIds.has(m)) addTo(m, r); else if (!r.mark && assemblyIds.has(n)) addTo(n, r);
  }
  const dir = path.join(DIR, 'levels'); const files = []; const none = [];
  // --no-levels: a level is drawn from the one JSON on screen (docs/model_as_source.md); no level file is stored.
  for (const f of process.argv.includes('--no-levels') ? [] : fs.readdirSync(dir).filter((n) => /\.dxf$/i.test(n))) {
    const list = byMark.get(f.replace(/\.dxf$/i, '').toUpperCase());
    if (!list?.length) { none.push(f); continue; }
    const content = fs.readFileSync(path.join(dir, f)).toString('base64');
    for (const row of list) files.push({ name: f, content, rowId: row.id });
  }
  if (none.length) console.log(`  levels with no row: ${none.join(' ')}`);
  for (let i = 0; i < files.length; i += 4) {
    const up = await uploadDrawings(db, c, orderId, lineId, { files: files.slice(i, i + 4), dryRun: false });
    for (const x of up.files ?? []) if (!['new', 'replaces'].includes(x.status)) console.log(`  ${x.name}: ${x.status} ${(x.problems ?? x.warnings ?? []).join('; ')}`);
    if (APPLY) { await db.commit(); await db.beginTransaction(); }
    if (!APPLY) break;
  }
  console.log(`  ${files.length} level drawings${APPLY ? '' : ' (first batch only, in a dry run)'}`);
  if (APPLY) { await db.commit(); console.log(`DONE: ${orderCode} #${orderId}, line ${lineId}, standard ${std.id}`); } else { await db.rollback(); console.log('Dry run: rolled back.'); }
} catch (e) {
  try { await db.rollback(); } catch { /* none */ }
  console.error('FAILED (rolled back):', e.message, e.detail ? JSON.stringify(e.detail).slice(0, 800) : '', e.problems ? JSON.stringify(e.problems).slice(0, 800) : '');
  process.exitCode = 1;
} finally { db.release(); await pool.end(); process.exit(process.exitCode ?? 0); }
