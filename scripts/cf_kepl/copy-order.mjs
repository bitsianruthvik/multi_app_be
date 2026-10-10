/**
 * copy-order.mjs — a NEW order for another customer with exactly the structure of an existing one
 * (user, 2026-10-10: "create a new order of same BOM structure but for the T&T client …
 * SO-20261007-0001 - build is exactly as this order").
 *
 * The same deep copy an order revision makes (revisionService / treeCopyService): every custom line's
 * rows, their BOMs, values and own rules; cut pieces are derived again for the new lines. The new
 * order is an inquiry, not frozen, with a code of its own. Each row keeps the flow its source row has
 * (rows carry their own flow), and then asks for what that flow reads (flowSpecService).
 *
 *   node scripts/cf_kepl/copy-order.mjs --company 30005 --from SO-20261007-0001 --customer C002            (dry run)
 *   node scripts/cf_kepl/copy-order.mjs --company 30005 --from SO-20261007-0001 --customer C002 --apply
 *   optional: --title "…"
 */
const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const COMPANY = Number(arg('company'));
const FROM = arg('from');
const CUSTOMER = arg('customer');
const APPLY = process.argv.includes('--apply');
if (!Number.isInteger(COMPANY) || !FROM || !CUSTOMER) throw new Error('Usage: --company <id> --from <order code> --customer <party code> [--title "…"] [--apply]');

const { pool } = await import('../../db.js');
await import('../../apps/cf_erp/services/codegenProvider.js');
const { createOrder, getOrder } = await import('../../apps/cf_erp/services/salesOrderService.js');
const { snapshotSubtrees, writeCopies, cutPlateNodes } = await import('../../apps/cf_erp/services/treeCopyService.js');
const { refreshCutPieces, rectangleChoices } = await import('../../apps/cf_erp/services/cutPlateService.js');
const { syncFlowSpecs } = await import('../../apps/cf_erp/services/flowSpecService.js');
const { readLineValues } = await import('../../apps/cf_erp/services/orderValuesService.js');

const db = await pool.getConnection();
const c = { companyId: COMPANY, userId: null };
const t0 = Date.now();
try {
  await db.beginTransaction();
  const [[src]] = await db.query(
    `SELECT o.* FROM cf_sales_orders o WHERE o.company_id = ? AND o.code = ? AND o.deleted_at IS NULL ORDER BY o.revision DESC LIMIT 1`, [COMPANY, FROM]);
  if (!src) throw new Error(`No order ${FROM}`);
  const [[cust]] = await db.query('SELECT id, code, name FROM cf_parties WHERE company_id = ? AND code = ? AND deleted_at IS NULL', [COMPANY, CUSTOMER]);
  if (!cust) throw new Error(`No customer ${CUSTOMER}`);
  const [lines] = await db.query(
    `SELECT l.* FROM cf_sales_order_lines l WHERE l.company_id = ? AND l.order_id = ? AND l.deleted_at IS NULL ORDER BY l.line_no`, [COMPANY, src.id]);
  console.log(`From ${src.code} (${src.status}, ${lines.length} line${lines.length === 1 ? '' : 's'}) for ${cust.name} (${cust.code})`);

  const made = await createOrder(db, c, { orderType: 'customer', customerId: cust.id, title: arg('title') ?? src.title ?? null, committedDate: src.committed_date ?? null, notes: `Structure copied from ${src.code}.` });
  await db.query(
    `INSERT INTO cf_sales_order_lines
       (company_id, order_id, line_no, line_type, item_id, design_id, position, quantity, committed_date, bom_revision, description, notes, created_by, rate, rate_basis, currency)
     SELECT company_id, ?, line_no, line_type, IF(line_type = 'custom', NULL, item_id), design_id, position, quantity, committed_date, bom_revision, description, notes, NULL, rate, rate_basis, currency
       FROM cf_sales_order_lines WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL`, [made.id, COMPANY, src.id]);
  const [fresh] = await db.query('SELECT id, line_no FROM cf_sales_order_lines WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL', [COMPANY, made.id]);
  const newLineOf = new Map(fresh.map((l) => [Number(l.line_no), l]));

  const custom = lines.filter((l) => l.line_type === 'custom' && l.item_id);
  let rows = 0;
  if (custom.length) {
    const cutPlates = await cutPlateNodes(db, COMPANY);
    const isCutPlate = (l) => l.child_item_type === 'temporary' && cutPlates.has(l.child_classification_id);
    const snap = await snapshotSubtrees(db, COMPANY, custom.map((l) => l.item_id), (l) => l.child_item_type === 'temporary' && !isCutPlate(l));
    const { idMap } = await writeCopies(db, c, snap, custom.map((l) => ({ srcId: l.item_id, ownerLineId: newLineOf.get(Number(l.line_no)).id })), { keepLine: (l) => !isCutPlate(l) });
    rows = idMap.size;
    for (const l of custom) {
      const nl = newLineOf.get(Number(l.line_no));
      await db.query('UPDATE cf_sales_order_lines SET item_id = ? WHERE company_id = ? AND id = ?', [idMap.get(Number(l.item_id)), COMPANY, nl.id]);
    }
    // The copied rows are drafts of an open order again, and ask for what their own flows read.
    await db.query("UPDATE cf_master_records SET status = 'draft' WHERE company_id = ? AND id IN (?)", [COMPANY, [...idMap.values()]]);
    await syncFlowSpecs(db, c, [...idMap.values()]);
    for (const l of custom) {
      const nl = newLineOf.get(Number(l.line_no));
      const r = await refreshCutPieces(db, c, nl.id, { carry: await rectangleChoices(db, COMPANY, l.id) });
      console.log(`   line ${nl.line_no}: cut pieces ${r.made ? 'made' : `not made yet — ${r.message ?? r.reason ?? ''}`}`);
    }
  }
  const order = await getOrder(db, COMPANY, made.id);
  console.log(`New order ${order.code} (${order.status}) for ${cust.name}: ${order.lines.length} line(s), ${rows} rows copied  (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  for (const l of order.lines) {
    if (l.lineType !== 'custom') continue;
    const v = await readLineValues(db, COMPANY, l.id);
    const [byNode] = await db.query(
      `SELECT n.name, COUNT(*) AS n FROM cf_master_records m JOIN cf_item_details i ON i.master_id = m.id AND i.deleted_at IS NULL AND i.owner_order_line_id = ?
         LEFT JOIN cf_classification_nodes n ON n.id = m.classification_id WHERE m.company_id = ? AND m.deleted_at IS NULL GROUP BY n.name ORDER BY n.name`, [l.id, COMPANY]);
    console.log(`   line ${l.lineNo}: ${byNode.map((x) => `${x.name} ${x.n}`).join(', ')}`);
    console.log(`   required values still empty on it: ${v.counts.missingOwn} (in ${v.counts.rowsMissing} rows)`);
  }
  if (APPLY) { await db.commit(); console.log('COMMITTED'); } else { await db.rollback(); console.log('DRY RUN — rolled back. Add --apply to keep it.'); }
} catch (err) {
  await db.rollback().catch(() => {});
  console.error('ERROR', err.message, err.problems ? JSON.stringify(err.problems).slice(0, 1500) : '', err.stack?.split('\n').slice(1, 4).join(' | '));
  process.exitCode = 1;
} finally {
  db.release();
  await pool.end();
}
