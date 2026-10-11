/**
 * buying-unowned-shares.mjs — READ-ONLY report: the purchase-order shares still bought "for the order
 * as a whole" (cf_purchase_line_orders with no requisition line — init.sql §56), and WHY no requisition
 * line of the order takes each of them.
 *
 *   cd multi_app_be
 *   node scripts/cf_kepl/buying-unowned-shares.mjs --company <id>            live purchase orders with something still to come
 *   node scripts/cf_kepl/buying-unowned-shares.mjs --company <id> --all      …and the shares of received / cancelled POs (history)
 *   node scripts/cf_kepl/buying-unowned-shares.mjs --company <id> --json     the rows as JSON
 *   (reads the database the environment points at: export the TiDB variables first for production)
 *
 * IT WRITES NOTHING. Four SELECTs, whatever the number of shares; no transaction; the session is put in
 * READ ONLY mode first where the server allows it (said in the output), so a mistake could not write.
 *
 * WHY (worked out per share, first that applies):
 *   order closed        the sales order is closed / lost / cancelled — the share should have been let go
 *   order not frozen    no line of the order is frozen or released: its material is not known, so it has no requisition yet
 *   no requisition      a line's material is known but no requisition was raised for the order (raise it: it adopts the share)
 *   released, not asked the order's released lines have no requirement for this item (the requirement went with a re-release)
 *   item not needed     the order's requisitions have no line for this item: it is not in the order's current material
 *   above the need      requisition lines for the item exist and are already covered: this share is more than they need
 *   to adopt            a requisition line still lacks it — "Refresh" the order's requisitions and it is handed over
 */
import { pathToFileURL } from 'node:url';

const LIVE_PO = ['requested', 'quoting', 'draft', 'ordered', 'partially_received'];
const OPEN_ORDER = ['inquiry', 'quoted', 'confirmed'];
const r6 = (n) => Math.round((Number(n) + Number.EPSILON) * 1e6) / 1e6;
const day = (d) => (d == null ? null : d instanceof Date ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : String(d).slice(0, 10));

/**
 * The report's rows. `all`: also shares on purchase orders that are received or cancelled.
 * → { rows: [{ po: { id, code, status }, supplier, item: { id, code, name, uom }, quantity, received, outstanding, expectedDate,
 *              order: { id, code, status, title }, liveOrder: { id, status } | null, why, detail }], totals }
 * Four reads.
 */
export async function unownedShares(db, companyId, { all = false } = {}) {
  const [shares] = await db.query(
    `SELECT a.id, a.quantity, a.qty_received, l.id AS po_line_id, l.item_id, l.uom, COALESCE(l.expected_date, p.expected_date) AS due,
            p.id AS po_id, p.code AS po_code, p.status AS po_status, s.name AS supplier_name,
            m.code AS item_code, m.name AS item_name,
            o.id AS order_id, o.code AS order_code, o.status AS order_status, o.title AS order_title, o.code_active
       FROM cf_purchase_line_orders a
       JOIN cf_purchase_order_lines l ON l.id = a.purchase_line_id AND l.deleted_at IS NULL
       JOIN cf_purchase_orders p ON p.id = l.purchase_order_id AND p.deleted_at IS NULL
       LEFT JOIN cf_parties s ON s.id = p.supplier_id
       JOIN cf_master_records m ON m.id = l.item_id
       JOIN cf_sales_orders o ON o.id = a.order_id
      WHERE a.company_id = ? AND a.deleted_at IS NULL AND a.pr_line_id IS NULL
        ${all ? '' : 'AND p.status IN (?) AND a.quantity > a.qty_received'}
      ORDER BY o.code, p.code, m.code, a.id`,
    all ? [companyId] : [companyId, LIVE_PO],
  );
  const empty = { rows: [], totals: { shares: 0, quantity: 0, outstanding: 0, byWhy: {} } };
  if (!shares.length) return empty;
  const codes = [...new Set(shares.map((x) => x.code_active).filter(Boolean))];
  // The live revision of each order (the newest row of its number that was not replaced), and its lines.
  const [lines] = codes.length ? await db.query(
    `SELECT o.code_active, o.id AS order_id, o.status AS order_status, o.revision, ol.id AS line_id, ol.line_no, ol.locked_at,
            (SELECT r.id FROM cf_production_releases r WHERE r.company_id = ol.company_id AND r.order_line_id = ol.id AND r.deleted_at IS NULL LIMIT 1) AS release_id
       FROM cf_sales_orders o
       LEFT JOIN cf_sales_order_lines ol ON ol.company_id = o.company_id AND ol.order_id = o.id AND ol.deleted_at IS NULL
      WHERE o.company_id = ? AND o.deleted_at IS NULL AND o.status <> 'revised' AND o.code_active IN (?)
      ORDER BY o.code_active, o.revision DESC, ol.line_no`,
    [companyId, codes],
  ) : [[]];
  const liveOf = new Map();                          // order number -> { id, status, lines: [] }
  for (const r of lines) {
    let e = liveOf.get(r.code_active);
    if (!e) { e = { id: r.order_id, status: r.order_status, revision: r.revision, lines: [] }; liveOf.set(r.code_active, e); }
    if (r.order_id === e.id && r.line_id != null) e.lines.push({ id: r.line_id, lineNo: r.line_no, frozen: !!r.locked_at, releaseId: r.release_id ?? null });
  }
  const lineIds = [...liveOf.values()].flatMap((e) => e.lines.map((l) => l.id));
  const releaseIds = [...liveOf.values()].flatMap((e) => e.lines.map((l) => l.releaseId).filter(Boolean));
  const [[reqLines], [reqs]] = await Promise.all([
    // Requisition lines of those lines, each with what it already has of its own (held + still coming).
    lineIds.length ? db.query(
      `SELECT pl.id, pl.order_line_id, pl.item_id, pl.quantity,
              (SELECT COALESCE(SUM(v.quantity), 0) FROM cf_stock_reservations v WHERE v.company_id = pl.company_id AND v.pr_line_id = pl.id AND v.status = 'active' AND v.deleted_at IS NULL) AS held,
              (SELECT COALESCE(SUM(GREATEST(x.quantity - x.qty_received, 0)), 0) FROM cf_purchase_line_orders x
                 JOIN cf_purchase_order_lines xl ON xl.id = x.purchase_line_id AND xl.deleted_at IS NULL
                 JOIN cf_purchase_orders xp ON xp.id = xl.purchase_order_id AND xp.deleted_at IS NULL AND xp.status IN ('requested','quoting','draft','ordered','partially_received')
                WHERE x.company_id = pl.company_id AND x.pr_line_id = pl.id AND x.deleted_at IS NULL) AS coming
         FROM cf_requisition_lines pl JOIN cf_requisitions r ON r.id = pl.requisition_id AND r.deleted_at IS NULL
        WHERE pl.company_id = ? AND pl.order_line_id IN (?) AND pl.deleted_at IS NULL`,
      [companyId, lineIds],
    ) : [[]],
    releaseIds.length ? db.query(
      `SELECT r.order_line_id, q.item_id, SUM(q.quantity) AS need FROM cf_material_requirements q
         JOIN cf_production_releases r ON r.id = q.release_id
        WHERE q.company_id = ? AND q.release_id IN (?) AND q.deleted_at IS NULL GROUP BY r.order_line_id, q.item_id`,
      [companyId, releaseIds],
    ) : [[]],
  ]);
  const prOfLine = new Map();                        // line -> [requisition line]
  for (const p of reqLines) { if (!prOfLine.has(p.order_line_id)) prOfLine.set(p.order_line_id, []); prOfLine.get(p.order_line_id).push(p); }
  const reqOf = new Set(reqs.map((q) => `${q.order_line_id}:${q.item_id}`));

  const rows = shares.map((x) => {
    const live = liveOf.get(x.code_active) ?? null;
    const outstanding = LIVE_PO.includes(x.po_status) ? r6(Math.max(0, Number(x.quantity) - Number(x.qty_received))) : 0;
    let why;
    let detail;
    if (!LIVE_PO.includes(x.po_status)) { why = 'history'; detail = `the purchase order is ${x.po_status} — nothing more is coming on it`; } else if (outstanding <= 0) { why = 'history'; detail = 'all of it has arrived (what arrived is a hold)'; } else if (!live || !OPEN_ORDER.includes(live.status)) {
      why = 'order closed'; detail = `the sales order is ${live?.status ?? x.order_status} — the share should be let go (it then serves any order)`;
    } else {
      const known = live.lines.filter((l) => l.frozen || l.releaseId);
      const withPr = live.lines.filter((l) => prOfLine.has(l.id));
      const mine = withPr.flatMap((l) => prOfLine.get(l.id).filter((p) => Number(p.item_id) === Number(x.item_id)).map((p) => ({ ...p, lineNo: l.lineNo })));
      if (!known.length) { why = 'order not frozen'; detail = `none of its ${live.lines.length} line(s) is frozen or released — its material is not known yet`; } else if (!withPr.length) { why = 'no requisition'; detail = `line(s) ${known.map((l) => l.lineNo).join(', ')} have known material but no requisition — raise it and the share is handed over`; } else if (!mine.length) {
        const released = known.filter((l) => l.releaseId);
        if (released.length && !released.some((l) => reqOf.has(`${l.id}:${x.item_id}`)) && released.length === known.length) { why = 'released, not asked'; detail = `line(s) ${released.map((l) => l.lineNo).join(', ')} are released and no requirement asks for this item`; } else { why = 'item not needed'; detail = 'no requisition line of the order asks for this item — it is not in the order\'s current material'; }
      } else {
        const lack = r6(mine.reduce((t, p) => t + Math.max(0, Number(p.quantity) - Number(p.held) - Number(p.coming)), 0));
        const need = r6(mine.reduce((t, p) => t + Number(p.quantity), 0));
        if (lack > 1e-6) { why = 'to adopt'; detail = `line(s) ${mine.map((p) => p.lineNo).join(', ')} still lack ${lack} — refresh the order's requisitions and it is handed over`; } else { why = 'above the need'; detail = `line(s) ${mine.map((p) => p.lineNo).join(', ')} need ${need} in all and are already covered — this is more than the order needs`; }
      }
    }
    return {
      po: { id: x.po_id, code: x.po_code, status: x.po_status }, supplier: x.supplier_name ?? null,
      item: { id: x.item_id, code: x.item_code, name: x.item_name, uom: x.uom },
      quantity: Number(x.quantity), received: Number(x.qty_received), outstanding, expectedDate: day(x.due),
      order: { id: x.order_id, code: x.order_code, status: x.order_status, title: x.order_title ?? null },
      liveOrder: live ? { id: live.id, status: live.status } : null, why, detail,
    };
  });
  const totals = { shares: rows.length, quantity: r6(rows.reduce((t, r) => t + r.quantity, 0)), outstanding: r6(rows.reduce((t, r) => t + r.outstanding, 0)), byWhy: {} };
  for (const r of rows) { const e = totals.byWhy[r.why] ?? { shares: 0, outstanding: 0 }; e.shares += 1; e.outstanding = r6(e.outstanding + r.outstanding); totals.byWhy[r.why] = e; }
  return { rows, totals };
}

const cut = (v, n) => { const t = String(v ?? ''); return t.length > n ? `${t.slice(0, n - 1)}…` : t.padEnd(n); };

async function main() {
  const args = process.argv.slice(2);
  const at = args.indexOf('--company');
  const companyId = at >= 0 ? Number(args[at + 1]) : NaN;
  if (!Number.isInteger(companyId) || companyId <= 0) { console.error('usage: node scripts/cf_kepl/buying-unowned-shares.mjs --company <id> [--all] [--json]'); process.exit(2); }
  const { pool } = await import('../../db.js');
  const db = await pool.getConnection();
  let code = 0;
  try {
    // Belt and braces: the session refuses writes where the server knows how. Nothing below writes either way.
    let readOnly = false;
    try { await db.query('SET SESSION TRANSACTION READ ONLY'); readOnly = true; } catch { /* a server without it: the report is SELECTs only */ }
    const out = await unownedShares(db, companyId, { all: args.includes('--all') });
    if (args.includes('--json')) console.log(JSON.stringify(out, null, 1));
    else {
      console.log(`PO shares bought "for the order as a whole" — company ${companyId} — host ${process.env.DB_HOST ?? 'localhost'} — ${readOnly ? 'read-only session' : 'SELECTs only (the server did not take READ ONLY)'}`);
      if (!out.rows.length) console.log('  none: every share that is still coming belongs to a requisition line.');
      else {
        console.log(`  ${cut('PO', 12)} ${cut('status', 10)} ${cut('supplier', 16)} ${cut('item', 28)} ${cut('qty', 9)} ${cut('recd', 8)} ${cut('due', 10)} ${cut('sales order', 22)} ${cut('status', 9)} ${cut('title', 18)} why`);
        for (const r of out.rows) {
          console.log(`  ${cut(r.po.code, 12)} ${cut(r.po.status, 10)} ${cut(r.supplier ?? '—', 16)} ${cut(`${r.item.code ?? ''} ${r.item.name ?? ''}`, 28)} ${cut(r.quantity, 9)} ${cut(r.received, 8)} ${cut(r.expectedDate ?? '—', 10)} ${cut(r.order.code, 22)} ${cut(r.liveOrder?.status ?? r.order.status, 9)} ${cut(r.order.title ?? '—', 18)} ${r.why.toUpperCase()} — ${r.detail}`);
        }
      }
      console.log(`  total: ${out.totals.shares} share(s), quantity ${out.totals.quantity}, still to come ${out.totals.outstanding}`);
      for (const [why, e] of Object.entries(out.totals.byWhy)) console.log(`    ${why.padEnd(20)} ${String(e.shares).padStart(4)} share(s), ${e.outstanding} to come`);
    }
    if (readOnly) await db.query('SET SESSION TRANSACTION READ WRITE').catch(() => {});
  } catch (e) { console.error(`FAILED: ${e.message}`); code = 1; } finally { db.release(); await pool.end(); }
  process.exit(code);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
