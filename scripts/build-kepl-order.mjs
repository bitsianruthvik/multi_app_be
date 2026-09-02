/**
 * build-kepl-order.mjs — build the KEPL ROB 59.3m order and walk the wizard.
 *
 * From "BOQ OF 60MTR - 2 SPANS KEPL.pdf":
 *   2 spans, marks G1..G4 x segments 1..5, i.e. 4 girders of 5 segments each.
 *
 * NOTE the document contradicts itself: the header says "5 Girder Arrangement"
 * but every shipping mark in the body is G1-G4. The MARKS are what the shop
 * fabricates to, so four is what gets built. Same trap as the 2026-08 run.
 *
 * Walks the five preparation stages and prints readiness after each, so a
 * failure names the stage it happened in.
 *
 *   node scripts/build-kepl-order.mjs            # report what it would do
 *   node scripts/build-kepl-order.mjs --apply
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
process.env.DB_HOST = env.DB_HOST; process.env.DB_PORT = env.DB_PORT ?? '4000';
process.env.DB_USER = env.DB_USER; process.env.DB_PASSWORD = env.DB_PASSWORD;
process.env.DB_NAME = env.DB_NAME; process.env.DB_SSL = 'true';

const { pool } = await import('../db.js');
const { instantiate, parametersFor } = await import('../apps/fab_erp/services/bomService.js');
const { flowSummary } = await import('../apps/fab_erp/services/orderFlowService.js');
const { orderReadiness } = await import('../apps/fab_erp/services/orderReadinessService.js');
const { generateCode } = await import('../apps/fab_erp/services/codegenService.js');
const { orderCodePrefix } = await import('../apps/fab_erp/services/itemCodeService.js');

const COMPANY = 30005;                 // Placebo
const GIRDERS = 4;                     // from the shipping marks, not the header
const SEGMENTS = 5;
const SPANS = ['SPAN1', 'SPAN2'];

const [[cust]] = await pool.query(
  `SELECT id, name FROM fab_customers
    WHERE company_id = ? AND deleted_at IS NULL AND name LIKE '%Kalpataru%' LIMIT 1`, [COMPANY]);
const [[tpl]] = await pool.query(
  `SELECT id, name FROM fab_item_catalog
    WHERE company_id = ? AND deleted_at IS NULL AND name = 'Span' LIMIT 1`, [COMPANY]);

if (!cust) throw new Error('Kalpataru customer not found in Placebo');
if (!tpl) throw new Error('"Span" template not found in Placebo');
console.log(`customer: ${cust.name} (#${cust.id})`);
console.log(`template: ${tpl.name} (#${tpl.id})`);
console.log(`plan:     2 spans x ${GIRDERS} girders x ${SEGMENTS} segments`);
console.log(`questions the BOM asks: ${JSON.stringify((await parametersFor(COMPANY, tpl.id)).map((p) => p.param))}\n`);

if (!APPLY) { console.log('DRY RUN — pass --apply to build it.'); await pool.end(); process.exit(0); }

const orderNumber = await generateCode(COMPANY, 'sales_order', {});
const [o] = await pool.query(
  `INSERT INTO fab_orders
     (company_id, order_number, order_type, type, status, customer_id, customer_name,
      customer_po_ref, required_date, notes, wizard_step, created_at)
   VALUES (?,?,'sales','standard','draft',?,?,?,?,?, 'lines', NOW())`,
  [COMPANY, orderNumber, cust.id, cust.name, 'KEPL ROB 59.3M',
   '2026-12-15', 'ROB 59.3M Span — 2 spans, 4 girders x 5 segments (17 deg skew). Drg P103-VDB-WK-DD-MJB-200+003-401'],
);
const orderId = o.insertId;
console.log(`STAGE 1 — lines: order ${orderNumber} (#${orderId})`);

const prefix = await orderCodePrefix(COMPANY, orderId);
console.log(`  code prefix: ${prefix}`);

for (const [i, code] of SPANS.entries()) {
  const [l] = await pool.query(
    `INSERT INTO fab_order_lines (company_id, order_id, line_no, code, description, qty, unit, line_type, created_at)
     VALUES (?,?,?,?,?,1,'nos','Composite Girder', NOW())`,
    [COMPANY, orderId, i + 1, code, `Span ${i + 1} — ROB 59.3 m, ${GIRDERS} girders x ${SEGMENTS} segments`],
  );
  console.log(`  line ${i + 1}: ${code} (#${l.insertId})`);

  const res = await instantiate(COMPANY, {
    orderId,
    orderLineId: l.insertId,
    rootItemId: tpl.id,
    params: { girders: GIRDERS, segmentsPerGirder: SEGMENTS },
    codePrefix: `${prefix}-${code}`,
  });
  console.log(`    STAGE 2 — structure: ${res.created} items, byDepth=${JSON.stringify(res.byDepth)}`);
}

// ── what the tree came out as ───────────────────────────────────────────────
const [levels] = await pool.query(
  `SELECT depth, COUNT(*) n, SUM(is_leaf) leaves,
          SUBSTRING_INDEX(GROUP_CONCAT(name ORDER BY id), ',', 1) label
     FROM fab_items WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL
      AND node_kind = 'structure' GROUP BY depth ORDER BY depth`, [COMPANY, orderId]);
console.log('\n  tree by depth:');
for (const l of levels) console.log(`    d${l.depth}  ${String(l.n).padStart(4)} x ${l.label}${Number(l.leaves) ? `  (${l.leaves} leaves)` : ''}`);

const [[sample]] = await pool.query(
  `SELECT code FROM fab_items WHERE company_id = ? AND order_id = ? AND is_leaf = 1 AND deleted_at IS NULL
    ORDER BY code LIMIT 1`, [COMPANY, orderId]);
console.log(`  sample leaf code: ${sample?.code}`);

// ── stage 3: flows ──────────────────────────────────────────────────────────
const fs3 = await flowSummary(COMPANY, orderId);
console.log('\nSTAGE 3 — flows (from the BOM lines, nothing applied by hand):');
for (const l of fs3.levels) {
  console.log(`  d${l.depth} ${String(l.label).padEnd(26)} ${l.withFlow}/${l.items} have a flow` +
    (l.flows.length ? `  [${l.flows.map((f) => `${f.name} x${f.count}`).join(', ')}]` : ''));
}
console.log(`  outstanding the BOM could still answer: ${fs3.wouldAssign}`);

// ── readiness across every stage ────────────────────────────────────────────
const r = await orderReadiness(COMPANY, orderId);
console.log('\nREADINESS — the five preparation stages:');
for (const s of r.stages) {
  console.log(`  ${s.state === 'done' ? '[x]' : s.state === 'partial' ? '[~]' : '[ ]'} ${String(s.label).padEnd(12)} ${s.detail}`);
}
console.log(`\n  next stage: ${r.nextStage} · prepared: ${r.preparationComplete} · status: ${r.status}`);
console.log(`\norder ${orderNumber} (#${orderId}) built.`);
await pool.end();
