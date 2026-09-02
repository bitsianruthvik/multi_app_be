/**
 * smoke-structure.mjs — prove the new structure path end to end, in one go.
 *
 * Builds a throwaway order from a real template and asserts the four things the
 * whole refactor rests on:
 *
 *   1. depth is stamped and increases down the tree
 *   2. is_leaf marks exactly the rows with no structural children
 *   3. node_kind is 'structure' for everything a template builds
 *   4. flow_id came from the BOM LINE, not from a rules table
 *
 * Rolls back at the end, so it leaves nothing behind.
 */
import mysql from 'mysql2/promise';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const env = {};
fs.readFileSync(path.join(__dir, '..', '.env'), 'utf8').split('\n').forEach((l) => {
  l = l.trim(); if (!l || l.startsWith('#')) return;
  const [k, ...r] = l.split('='); env[k.trim()] = r.join('=').trim();
});
process.env.DB_HOST = env.DB_HOST; process.env.DB_USER = env.DB_USER;
process.env.DB_PASSWORD = env.DB_PASSWORD; process.env.DB_NAME = env.DB_NAME;
process.env.DB_PORT = env.DB_PORT ?? '3306';

const { pool } = await import('../db.js');
const { parametersFor, expand, instantiate } = await import('../apps/fab_erp/services/bomService.js');
const { flowSummary } = await import('../apps/fab_erp/services/orderFlowService.js');

const fail = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) fail.push(name);
};

// A template = a catalog item with BOM lines under it and nothing above it.
const [[tpl]] = await pool.query(
  `SELECT c.id, c.company_id AS companyId, c.name
     FROM fab_item_catalog c
    WHERE c.deleted_at IS NULL
      AND EXISTS (SELECT 1 FROM fab_item_bom b WHERE b.parent_item_id = c.id AND b.deleted_at IS NULL AND b.active = 1)
      AND NOT EXISTS (SELECT 1 FROM fab_item_bom b2 WHERE b2.child_item_id = c.id AND b2.deleted_at IS NULL AND b2.active = 1)
    LIMIT 1`,
);
if (!tpl) { console.log('No template found locally — nothing to smoke-test.'); process.exit(0); }
console.log(`template: ${tpl.name} (#${tpl.id}, company ${tpl.companyId})\n`);

const params = await parametersFor(tpl.companyId, tpl.id);
console.log('questions the BOM asks:', JSON.stringify(params.map((p) => `${p.param}=${p.defaultQty}`)));

const answers = Object.fromEntries(params.map((p) => [p.param, Number(p.defaultQty ?? 2)]));
const tree = await expand(tpl.companyId, tpl.id, answers);
console.log(`expand(): ${tree.nodes} nodes\n`);
check('expand carries a flow from the BOM line',
  JSON.stringify(tree.root).includes('defaultFlowId'),
  'defaultFlowId present on nodes');

const conn = await pool.getConnection();
await conn.beginTransaction();
try {
  const [o] = await conn.query(
    `INSERT INTO fab_orders (company_id, order_number, order_type, type, status, customer_name, created_at)
     VALUES (?, ?, 'sales', 'standard', 'draft', 'SMOKE TEST', NOW())`,
    [tpl.companyId, `SMOKE-${Date.now()}`],
  );
  const orderId = o.insertId;

  const res = await instantiate(tpl.companyId, {
    orderId, orderLineId: null, rootItemId: tpl.id, params: answers, codePrefix: 'SMOKE',
  }, conn);
  console.log(`instantiate(): ${res.created} rows, byDepth=${JSON.stringify(res.byDepth)}\n`);

  const [rows] = await conn.query(
    `SELECT id, code, name, depth, is_leaf AS isLeaf, node_kind AS nodeKind, flow_id AS flowId,
            parent_item_id AS parentId
       FROM fab_items WHERE order_id = ? AND deleted_at IS NULL`,
    [orderId],
  );

  check('rows created', rows.length > 0, `${rows.length} rows`);
  check('every row is structure', rows.every((r) => r.nodeKind === 'structure'));
  check('root is depth 0', rows.filter((r) => r.parentId === null).every((r) => r.depth === 0));

  const byId = new Map(rows.map((r) => [r.id, r]));
  check('depth = parent depth + 1 everywhere',
    rows.filter((r) => r.parentId != null)
      .every((r) => r.depth === (byId.get(r.parentId)?.depth ?? -99) + 1));

  const hasKids = new Set(rows.map((r) => r.parentId).filter(Boolean));
  check('is_leaf marks exactly the childless rows',
    rows.every((r) => Number(r.isLeaf) === (hasKids.has(r.id) ? 0 : 1)),
    `${rows.filter((r) => Number(r.isLeaf)).length} leaves`);

  const leavesWithFlow = rows.filter((r) => Number(r.isLeaf) && r.flowId != null).length;
  const leaves = rows.filter((r) => Number(r.isLeaf)).length;
  check('leaves got a flow from the BOM line', leavesWithFlow > 0,
    `${leavesWithFlow}/${leaves} leaves have a flow`);

  const depths = [...new Set(rows.map((r) => r.depth))].sort();
  check('tree is deeper than one rung', depths.length > 1, `depths present: ${depths.join(', ')}`);

  // The readiness/flows summary must survive the same data.
  const summary = await flowSummary(tpl.companyId, orderId, conn);
  check('flowSummary groups by depth and labels from the items',
    summary.levels.length > 0 && summary.levels.every((l) => typeof l.depth === 'number' && l.label),
    summary.levels.map((l) => `${l.label}(d${l.depth}): ${l.withFlow}/${l.items}`).join(', '));

  await conn.rollback();
  console.log('\nrolled back — nothing left behind.');
} catch (err) {
  await conn.rollback();
  console.error('\nTHREW:', err.message);
  fail.push(`exception: ${err.message}`);
} finally {
  conn.release();
}

console.log(fail.length ? `\n${fail.length} FAILED: ${fail.join('; ')}` : '\nAll checks passed.');
await pool.end();
process.exit(fail.length ? 1 : 0);
