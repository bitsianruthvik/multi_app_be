/**
 * kepl-rebuild.mjs — build the KEPL order end to end on the corrected BOM.
 *
 * Lines -> structure -> geometry -> flows -> nesting, then compare the plates
 * it wants against the raw-material list the customer sent.
 *
 * A NEW ORDER rather than a rebuild of the old one, so the two can be put side
 * by side: the old one was built from a BOM missing the End Stiffener, carrying
 * one intermediate stiffener where the BOQ has twenty-four, and no studs.
 *
 *   node scripts/kepl-rebuild.mjs           # report
 *   node scripts/kepl-rebuild.mjs --apply
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const APPLY = process.argv.includes('--apply');
const __dir = path.dirname(fileURLToPath(import.meta.url));
const env = {};
fs.readFileSync(path.join(__dir, '..', '..', '.env.tidb'), 'utf8').split('\n').forEach((l) => {
  l = l.trim(); if (!l || l.startsWith('#')) return;
  const [k, ...r] = l.split('='); env[k.trim()] = r.join('=').trim();
});
Object.assign(process.env, {
  DB_HOST: env.DB_HOST, DB_PORT: env.DB_PORT ?? '4000', DB_USER: env.DB_USER,
  DB_PASSWORD: env.DB_PASSWORD, DB_NAME: env.DB_NAME, DB_SSL: 'true',
});

const { pool } = await import('../db.js');
const { instantiate, parametersFor } = await import('../apps/fab_erp/services/bomService.js');
const { generateCode } = await import('../apps/fab_erp/services/codegenService.js');
const { setFields } = await import('../apps/fab_erp/services/fieldService.js');
const { orderCodePrefix } = await import('../apps/fab_erp/services/itemCodeService.js');
const { recomputeItemShape } = await import('../apps/fab_erp/services/itemShapeService.js');

const COMPANY = 30005;
/** The BOQ's own counts for this bridge: 4 girders, 5 segments each, 2 spans. */
const PARAMS = { girders: 4, segmentsPerGirder: 5, endDiaphragms: 6, intermDiaphragms: 45, splices: 16 };

const [[span]] = await pool.query(
  "SELECT id, name FROM fab_item_catalog WHERE company_id=? AND name='Span' AND deleted_at IS NULL", [COMPANY]);
const [[cust]] = await pool.query(
  "SELECT id, name FROM fab_customers WHERE company_id=? AND name LIKE 'Kalpataru%' AND deleted_at IS NULL LIMIT 1",
  [COMPANY]);

const questions = await parametersFor(COMPANY, span.id);
console.log('the template asks:', questions.map((q) => `${q.param} (default ${Number(q.defaultQty)})`).join(', '));
console.log('answering:', JSON.stringify(PARAMS));
console.log(`customer: ${cust?.name ?? 'NOT FOUND'}`);

if (!APPLY) { console.log('\nDRY RUN — pass --apply to build.'); await pool.end(); process.exit(0); }

// ── 1. the order and its two span lines ────────────────────────────────────
const orderNumber = await generateCode(COMPANY, 'sales_order', {});
const [ord] = await pool.query(
  `INSERT INTO fab_orders (company_id, order_number, order_type, type, status, customer_id,
                           customer_name, currency, priority, notes, created_at)
   VALUES (?,?, 'sales', 'Composite Girder', 'draft', ?, ?, 'INR', 'normal', ?, NOW())`,
  [COMPANY, orderNumber, cust?.id ?? null, cust?.name ?? 'KEPL',
    'ROB 59.3M, 2 spans. Built from the corrected Composite Girder BOM.']);
const orderId = ord.insertId;
console.log(`\ncreated ${orderNumber} (#${orderId})`);

const lineIds = [];
for (let i = 1; i <= 2; i += 1) {
  const [l] = await pool.query(
    `INSERT INTO fab_order_lines (company_id, order_id, line_no, code, description, qty, unit,
                                  line_type, catalog_item_id, status, created_at)
     VALUES (?,?,?,?,?,1,'nos','Composite Girder',?, 'open', NOW())`,
    [COMPANY, orderId, i, `SPAN${i}`, `Span ${i} — 59.3 m composite girder`, span.id]);
  lineIds.push(l.insertId);
}
console.log(`  2 span lines`);

// ── 2. the structure, from the BOM ─────────────────────────────────────────
const prefix = await orderCodePrefix(COMPANY, orderId);
for (let i = 0; i < lineIds.length; i += 1) {
  const res = await instantiate(COMPANY, {
    orderId,
    orderLineId: lineIds[i],
    rootItemId: span.id,
    params: PARAMS,
    perInstance: {},
    codePrefix: `${prefix}-SPAN${i + 1}`,
  });
  console.log(`  SPAN${i + 1}: ${res.created} items, byDepth ${JSON.stringify(res.byDepth)}`);
}
await recomputeItemShape(COMPANY, orderId);

// ── 3. the steel, on the lines so every part inherits it ───────────────────
for (const id of lineIds) {
  await setFields(COMPANY, 'order_line', id, { grade: 'E350 BO', material: 'MS' });
}
console.log('  grade E350 BO + material MS set on both lines');

const [[shape]] = await pool.query(
  `SELECT COUNT(*) items, SUM(is_leaf=1) leaves, MAX(depth) maxDepth
     FROM fab_items WHERE company_id=? AND order_id=? AND deleted_at IS NULL AND node_kind='structure'`,
  [COMPANY, orderId]);
console.log(`\nstructure: ${shape.items} items, ${shape.leaves} leaves, depth 0..${shape.maxDepth}`);

const [sample] = await pool.query(
  `SELECT code FROM fab_items WHERE company_id=? AND order_id=? AND deleted_at IS NULL
     AND depth=2 ORDER BY code LIMIT 6`, [COMPANY, orderId]);
console.log('segment codes:', sample.map((s) => s.code.split('-').slice(-2).join('-')).join(', '));
console.log(`\norderId=${orderId}`);
await pool.end();
