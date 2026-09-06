/**
 * show-bom.mjs — print a catalog item's BOM as a tree.
 *
 * Read-only. Walks `fab_item_bom` from a root item and renders what an order
 * built from it would contain, with the quantity rule and default flow on each
 * line — the three things that decide what gets made.
 *
 *   node scripts/show-bom.mjs [rootName]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = process.argv[2] ?? 'Span';
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
const COMPANY = 30005;

const [[root]] = await pool.query(
  'SELECT id, code, name FROM fab_item_catalog WHERE company_id = ? AND name = ? AND deleted_at IS NULL',
  [COMPANY, ROOT]);
if (!root) { console.error(`no catalog item named "${ROOT}"`); process.exit(1); }

const [lines] = await pool.query(
  `SELECT b.id, b.parent_item_id AS p, b.child_item_id AS c, b.qty_num AS qtyNum,
          b.qty_param AS qtyParam, b.default_qty AS defQty, b.per_instance_qty AS perInstance,
          b.code_segment AS seg, b.sort_order AS sortOrder,
          ch.name AS childName, ch.code AS childCode,
          f.name AS flowName
     FROM fab_item_bom b
     JOIN fab_item_catalog ch ON ch.id = b.child_item_id AND ch.deleted_at IS NULL
     LEFT JOIN fab_operation_flows f ON f.id = b.default_flow_id AND f.deleted_at IS NULL
    WHERE b.company_id = ? AND b.deleted_at IS NULL AND b.active = 1
    ORDER BY b.sort_order, ch.name`, [COMPANY]);

const byParent = new Map();
for (const l of lines) {
  if (!byParent.has(l.p)) byParent.set(l.p, []);
  byParent.get(l.p).push(l);
}

console.log(`\n${root.name}  [${root.code}]`);
const walk = (id, prefix, depth) => {
  if (depth > 8) return;
  const kids = byParent.get(id) ?? [];
  kids.forEach((l, i) => {
    const last = i === kids.length - 1;
    const qty = l.qtyParam
      ? `asks "${l.qtyParam}"${l.defQty != null ? ` (default ${Number(l.defQty)})` : ''}${Number(l.perInstance) ? ' per-parent' : ''}`
      : `x${Number(l.qtyNum)}`;
    console.log(`${prefix}${last ? '└─ ' : '├─ '}${String(l.childName).padEnd(32)} ${qty.padEnd(42)}`
      + `${l.seg ? `code "${l.seg}"` : 'code = number'}${l.flowName ? `  · ${l.flowName}` : '  · no flow'}`);
    walk(l.c, prefix + (last ? '   ' : '│  '), depth + 1);
  });
};
walk(root.id, '', 0);

const [[n]] = await pool.query(
  'SELECT COUNT(*) n FROM fab_item_bom WHERE company_id = ? AND deleted_at IS NULL AND active = 1', [COMPANY]);
console.log(`\n${n.n} BOM lines in the company.`);
await pool.end();
