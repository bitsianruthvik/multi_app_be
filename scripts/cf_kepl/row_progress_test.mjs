/**
 * row_progress_test.mjs — where every row of a line is in its flow, per unit, for the 3D progress view
 * (rowProgressService.lineRowProgress; user, 2026-11-01). Local only; ONE TRANSACTION, ROLLED BACK.
 *   cd multi_app_be && node scripts/cf_kepl/row_progress_test.mjs
 *
 * On the most advanced local release (any company), by moving its steps' states inside the transaction:
 *   1. every step pending → every row of every unit 'waiting' on its first operation, nothing joined
 *   2. one part's first step in progress → that part 'working' on that operation, inProgress; its unit only
 *   3. a parent's first step started → every child of it 'joined' (the 3D view paints it with its parent)
 *   4. every step done → the top rows 'done', the rest joined
 *   5. one row per unit and one unit per line quantity; an unreleased line says not_released
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
if (!/^(localhost|127\.0\.0\.1|::1)$/.test(process.env.DB_HOST ?? 'localhost')) throw new Error('This suite is local only.');
const { lineRowProgress } = await imp('apps/cf_erp/services/rowProgressService.js');

let passed = 0; let failed = 0; const fails = [];
const ok = (name, cond, detail = '') => { if (cond) { passed += 1; console.log(`  PASS  ${name}`); } else { failed += 1; fails.push(name); console.log(`  FAIL  ${name}${detail ? ` — ${String(detail).slice(0, 600)}` : ''}`); } };
const J = (v) => JSON.stringify(v);

const conn = await pool.getConnection();
try {
  await conn.beginTransaction();
  const [[t]] = await conn.query(`SELECT r.id AS release_id, r.company_id, r.order_id, r.order_line_id, l.quantity,
      (SELECT COUNT(*) FROM cf_production_steps s JOIN cf_production_items pi ON pi.id = s.production_item_id WHERE pi.release_id = r.id AND s.deleted_at IS NULL) AS steps
     FROM cf_production_releases r JOIN cf_sales_order_lines l ON l.id = r.order_line_id
    WHERE r.deleted_at IS NULL HAVING steps > 0 ORDER BY steps DESC LIMIT 1`);
  if (!t) throw new Error('No local release with steps to test on.');
  const C = t.company_id;
  const items = (await conn.query('SELECT * FROM cf_production_items WHERE release_id = ? AND deleted_at IS NULL', [t.release_id]))[0];
  const ids = items.map((i) => i.id);
  const setAll = (state) => conn.query('UPDATE cf_production_steps SET state = ? WHERE production_item_id IN (?) AND deleted_at IS NULL', [state, ids]);
  const read = () => lineRowProgress(conn, C, t.order_id, t.order_line_id);
  console.log(`  release ${t.release_id}: line ${t.order_line_id} × ${Number(t.quantity)}, ${items.length} items, ${t.steps} steps`);

  await setAll('pending');
  let p = await read();
  const states = (x) => x.rows.flatMap((r) => r.units.map((u) => u.state));
  ok('5. one unit per line quantity on every row; released', p.released && p.rows.every((r) => r.units.length === Math.max(1, Math.round(Number(t.quantity)))), J(p.rows.map((r) => r.units.length)));
  ok('1. every step pending: every unit waiting, nothing joined or done', states(p).every((s) => s === 'waiting'), J(states(p)));
  ok('…and each waiting unit names its first operation', p.rows.every((r) => r.units.every((u) => !u.pieces || u.op?.code)), J(p.rows.map((r) => r.units.map((u) => u.op))));

  // A leaf part (an item with a parent that is a row) — its first step in progress.
  const rowIds = new Set(p.rows.map((r) => r.rowId));
  const leaf = items.find((i) => i.parent_id != null && rowIds.has(Number(i.item_id)) && items.some((x) => x.id === i.parent_id && rowIds.has(Number(x.item_id))));
  if (leaf) {
    const [[first]] = await conn.query('SELECT s.id, o.code FROM cf_production_steps s JOIN cf_operations o ON o.id = s.operation_id WHERE s.production_item_id = ? AND s.deleted_at IS NULL ORDER BY s.sequence LIMIT 1', [leaf.id]);
    await conn.query("UPDATE cf_production_steps SET state = 'in_progress' WHERE id = ?", [first.id]);
    p = await read();
    const row = p.rows.find((r) => r.rowId === Number(leaf.item_id));
    const worked = row.units.filter((u) => u.state === 'working');
    ok('2. a part started: that row is working on that operation, being worked', worked.length >= 1 && worked.every((u) => u.op?.code === first.code && u.inProgress), J(row.units));
    ok('…in its own unit only (the other units still wait)', row.units.length === 1 || row.units.some((u) => u.state === 'waiting'), J(row.units));

    // Its parent's first step started → the part is joined.
    const parent = items.find((x) => x.id === leaf.parent_id);
    const [[pf]] = await conn.query('SELECT id FROM cf_production_steps WHERE production_item_id = ? AND deleted_at IS NULL ORDER BY sequence LIMIT 1', [parent.id]);
    await conn.query("UPDATE cf_production_steps SET state = 'in_progress' WHERE id = ?", [pf.id]);
    p = await read();
    const kidsOfParent = items.filter((x) => x.parent_id === parent.id && rowIds.has(Number(x.item_id)));
    const rowOfKid = (k) => p.rows.find((r) => r.rowId === Number(k.item_id));
    const unitIdx = (() => { const tops = items.filter((x) => x.parent_id == null).sort((a, b) => (a.piece_no ?? 0) - (b.piece_no ?? 0) || a.id - b.id); let x = parent; while (x.parent_id != null) x = items.find((y) => y.id === x.parent_id); return tops.findIndex((y) => y.id === x.id); })();
    ok("3. the parent started: its children are joined (painted with the parent) in that unit", kidsOfParent.every((k) => rowOfKid(k).units[Math.max(0, unitIdx)].state === 'joined'), J(kidsOfParent.map((k) => rowOfKid(k).units)));
  } else ok('2–3. (no nested part on this release — skipped)', true);

  await setAll('done');
  p = await read();
  const tops = p.rows.filter((r) => r.parentRowId == null);
  ok('4. every step done: the top rows done, every other row joined', tops.every((r) => r.units.every((u) => u.state === 'done')) && p.rows.filter((r) => r.parentRowId != null).every((r) => r.units.every((u) => u.state === 'joined' || u.state === 'done')), J(p.rows.map((r) => [r.name, r.units.map((u) => u.state)])));

  const [[other]] = await conn.query(`SELECT l.id, l.order_id, l.company_id FROM cf_sales_order_lines l WHERE l.deleted_at IS NULL AND l.line_type = 'custom' AND l.item_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM cf_production_releases r WHERE r.order_line_id = l.id AND r.deleted_at IS NULL) LIMIT 1`);
  if (other) {
    const q = await lineRowProgress(conn, other.company_id, other.order_id, other.id);
    ok('5. an unreleased line: every unit not_released', !q.released && q.rows.every((r) => r.units.every((u) => u.state === 'not_released')), J(q.rows.slice(0, 2)));
  }
} catch (e) { failed += 1; fails.push(`crashed: ${e.message}`); console.log(e); } finally { await conn.rollback(); conn.release(); await pool.end(); }
console.log(`\n${passed} passed, ${failed} failed${fails.length ? `\n  ${fails.join('\n  ')}` : ''}`);
process.exit(failed ? 1 : 0);
