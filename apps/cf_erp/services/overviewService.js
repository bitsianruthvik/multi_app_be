/**
 * overviewService.js — what the shell and the Home cockpit read: live counts
 * for the second nav row, record search for the ⌘K palette, and the work
 * queues on Home. Read-only and cheap; the screens treat all of it as advisory
 * (a failed count shows no badge, never an error).
 */
import { trackerCounts } from './releaseService.js';
import { purchaseCounts } from './purchaseService.js';

const blank = (v) => v == null || String(v).trim() === '';
const OPEN = "('draft','inquiry','quoted','confirmed')";
const QUEUE_ORDER = { overdue: 1, onhold: 2, ready: 3, material: 4, buy: 5, deliveries: 6, delivered: 7, release: 8, inquiries: 9, quoted: 10, selections: 11, drafts: 12, flows: 13, shifts: 14, untimed: 15, held: 16 };

async function one(db, sql, params) {
  const [[row]] = await db.query(sql, params);
  return Number(Object.values(row)[0]) || 0;
}

/** Row-2 badges. Sizes stay neutral on screen; a few name work waiting (see SectionNav). */
export async function navCounts(db, companyId) {
  const c = [companyId];
  const [openOrders, customers, items, definitions, machines, operations, draftFlows, stockLines, heldBatches, areas] = await Promise.all([
    one(db, `SELECT COUNT(*) FROM cf_sales_orders WHERE company_id = ? AND deleted_at IS NULL AND status IN ${OPEN}`, c),
    one(db, 'SELECT COUNT(*) FROM cf_parties WHERE company_id = ? AND deleted_at IS NULL AND is_customer = 1', c),
    one(db, "SELECT COUNT(*) FROM cf_master_records WHERE company_id = ? AND deleted_at IS NULL AND record_kind = 'item'", c),
    one(db, "SELECT COUNT(*) FROM cf_master_records WHERE company_id = ? AND deleted_at IS NULL AND record_kind = 'definition'", c),
    one(db, "SELECT COUNT(*) FROM cf_machines WHERE company_id = ? AND deleted_at IS NULL AND status = 'active'", c),
    one(db, "SELECT COUNT(*) FROM cf_operations WHERE company_id = ? AND deleted_at IS NULL AND status = 'active'", c),
    one(db, "SELECT COUNT(*) FROM cf_operation_flows WHERE company_id = ? AND deleted_at IS NULL AND status = 'draft'", c),
    one(db, 'SELECT COUNT(*) FROM cf_stock_balances WHERE company_id = ? AND quantity <> 0', c),
    one(db, `SELECT COUNT(*) FROM cf_stock_batches b WHERE b.company_id = ? AND b.deleted_at IS NULL AND b.status <> 'available'
              AND EXISTS (SELECT 1 FROM cf_stock_balances k WHERE k.company_id = b.company_id AND k.batch_id = b.id AND k.quantity <> 0)`, c),
    one(db, "SELECT COUNT(*) FROM cf_stocking_areas WHERE company_id = ? AND deleted_at IS NULL AND status = 'active'", c),
  ]);
  const t = await trackerCounts(db, companyId);
  const b = await purchaseCounts(db, companyId);
  return { counts: { openOrders, customers, items, definitions, machines, operations, draftFlows, stockLines, heldBatches, areas, readySteps: t.readySteps, toBuy: b.toBuy, openPurchases: b.draftOrders + b.awaitingDelivery } };
}

/**
 * Everything the palette can jump to, by code or name (two characters at
 * least). Each result carries its own route, so the screen needs no map.
 */
export async function search(db, companyId, q) {
  const term = String(q ?? '').trim();
  if (term.length < 2) return { results: [] };
  const like = `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
  const run = (sql, params) => db.query(sql, [companyId, ...params]).then(([rows]) => rows);
  const [records, orders, machines, operations, flows, batches, areas, parties, movements] = await Promise.all([
    run(`SELECT m.id, m.code, m.name, m.record_kind, i.item_type, d.definition_type, n.name AS node FROM cf_master_records m
           LEFT JOIN cf_item_details i ON i.master_id = m.id LEFT JOIN cf_definition_details d ON d.master_id = m.id
           LEFT JOIN cf_classification_nodes n ON n.id = m.classification_id
          WHERE m.company_id = ? AND m.deleted_at IS NULL AND (m.code LIKE ? OR m.name LIKE ?) ORDER BY m.code LIMIT 8`, [like, like]),
    run(`SELECT o.id, o.code, o.title, o.status, p.name AS customer FROM cf_sales_orders o LEFT JOIN cf_parties p ON p.id = o.customer_id
          WHERE o.company_id = ? AND o.deleted_at IS NULL AND (o.code LIKE ? OR o.title LIKE ? OR p.name LIKE ?) ORDER BY o.id DESC LIMIT 6`, [like, like, like]),
    run('SELECT id, code, name, serial_number FROM cf_machines WHERE company_id = ? AND deleted_at IS NULL AND (code LIKE ? OR name LIKE ? OR serial_number LIKE ?) ORDER BY code LIMIT 5', [like, like, like]),
    run('SELECT id, code, name FROM cf_operations WHERE company_id = ? AND deleted_at IS NULL AND (code LIKE ? OR name LIKE ?) ORDER BY code LIMIT 5', [like, like]),
    run('SELECT id, code, name, status FROM cf_operation_flows WHERE company_id = ? AND deleted_at IS NULL AND (code LIKE ? OR name LIKE ?) ORDER BY code LIMIT 5', [like, like]),
    run(`SELECT b.id, b.code, b.supplier_ref, m.code AS item_code FROM cf_stock_batches b JOIN cf_master_records m ON m.id = b.item_id
          WHERE b.company_id = ? AND b.deleted_at IS NULL AND (b.code LIKE ? OR b.supplier_ref LIKE ?) ORDER BY b.id DESC LIMIT 5`, [like, like]),
    run('SELECT id, code, name FROM cf_stocking_areas WHERE company_id = ? AND deleted_at IS NULL AND (code LIKE ? OR name LIKE ?) ORDER BY code LIMIT 5', [like, like]),
    run('SELECT id, code, name, is_customer FROM cf_parties WHERE company_id = ? AND deleted_at IS NULL AND (code LIKE ? OR name LIKE ?) ORDER BY name LIMIT 5', [like, like]),
    run('SELECT id, code, movement_type, reference FROM cf_stock_movements WHERE company_id = ? AND deleted_at IS NULL AND (code LIKE ? OR reference LIKE ?) ORDER BY id DESC LIMIT 5', [like, like]),
  ]);
  const kindOf = (r) => (r.record_kind === 'item' ? r.item_type : r.definition_type);
  const results = [
    ...orders.map((o) => ({ type: 'order', id: o.id, code: o.code, name: o.title ?? o.customer ?? o.code, detail: `${o.status}${o.customer ? ` · ${o.customer}` : ''}`, route: `orders/${o.id}` })),
    ...records.map((r) => ({
      type: r.record_kind, id: r.id, code: r.code, name: r.name, detail: [kindOf(r), r.node].filter(Boolean).join(' · '),
      route: `${r.record_kind === 'item' ? 'items' : 'definitions'}/${r.id}`,
    })),
    ...machines.map((m) => ({ type: 'machine', id: m.id, code: m.code, name: m.name, detail: m.serial_number, route: `machines/${m.id}` })),
    ...batches.map((b) => ({ type: 'batch', id: b.id, code: b.code, name: b.code, detail: [b.item_code, b.supplier_ref].filter(Boolean).join(' · '), route: `batches/${b.id}` })),
    ...movements.map((m) => ({ type: 'movement', id: m.id, code: m.code, name: m.code, detail: [m.movement_type, m.reference].filter(Boolean).join(' · '), route: `movements/${m.id}` })),
    ...operations.map((o) => ({ type: 'operation', id: o.id, code: o.code, name: o.name, detail: null, route: `operations/${o.id}` })),
    ...flows.map((f) => ({ type: 'flow', id: f.id, code: f.code, name: f.name, detail: f.status, route: `flows/${f.id}` })),
    ...areas.map((a) => ({ type: 'area', id: a.id, code: a.code, name: a.name, detail: null, route: `stocking-areas/${a.id}` })),
    ...parties.map((p) => ({ type: 'party', id: p.id, code: p.code, name: p.name, detail: Number(p.is_customer) ? 'customer' : 'supplier', route: 'customers' })),
  ];
  return { results: results.slice(0, 30) };
}

/**
 * The Home cockpit: a to-do surface, not a chart. Each queue is work waiting,
 * with the one screen that clears it; the screen shows the ones with work in them.
 */
export async function cockpit(db, companyId) {
  const c = [companyId];
  const [inquiries, quoted, confirmed, overdue, selections, itemDrafts, defDrafts, draftFlows, idleMachines, heldBatches, untimedOps, openOrders, machines, stockLines] = await Promise.all([
    one(db, "SELECT COUNT(*) FROM cf_sales_orders WHERE company_id = ? AND deleted_at IS NULL AND status = 'inquiry'", c),
    one(db, "SELECT COUNT(*) FROM cf_sales_orders WHERE company_id = ? AND deleted_at IS NULL AND status = 'quoted'", c),
    one(db, "SELECT COUNT(*) FROM cf_sales_orders WHERE company_id = ? AND deleted_at IS NULL AND status = 'confirmed'", c),
    one(db, `SELECT COUNT(*) FROM cf_sales_orders WHERE company_id = ? AND deleted_at IS NULL AND status IN ${OPEN} AND committed_date < CURDATE()`, c),
    one(db, `SELECT COUNT(*) FROM cf_bom_lines l
               JOIN cf_boms b ON b.id = l.bom_id AND b.deleted_at IS NULL AND b.bom_type = 'custom'
               JOIN cf_master_records ch ON ch.id = l.child_id
               JOIN cf_item_details pi ON pi.master_id = b.parent_id
               JOIN cf_sales_order_lines ol ON ol.id = pi.owner_order_line_id
               JOIN cf_sales_orders o ON o.id = ol.order_id AND o.deleted_at IS NULL
              WHERE l.company_id = ? AND l.deleted_at IS NULL AND l.selection_definition_id IS NOT NULL
                AND ch.record_kind = 'definition' AND o.status IN ${OPEN}`, c),
    one(db, `SELECT COUNT(*) FROM cf_master_records m JOIN cf_item_details i ON i.master_id = m.id
              WHERE m.company_id = ? AND m.deleted_at IS NULL AND m.status = 'draft' AND i.item_type = 'catalog'`, c),
    one(db, "SELECT COUNT(*) FROM cf_master_records WHERE company_id = ? AND deleted_at IS NULL AND status = 'draft' AND record_kind = 'definition'", c),
    one(db, "SELECT COUNT(*) FROM cf_operation_flows WHERE company_id = ? AND deleted_at IS NULL AND status = 'draft'", c),
    one(db, `SELECT COUNT(*) FROM cf_machines mc WHERE mc.company_id = ? AND mc.deleted_at IS NULL AND mc.status = 'active'
              AND NOT EXISTS (SELECT 1 FROM cf_machine_shifts s WHERE s.company_id = mc.company_id AND s.machine_id = mc.id AND s.deleted_at IS NULL)`, c),
    one(db, `SELECT COUNT(*) FROM cf_stock_batches b WHERE b.company_id = ? AND b.deleted_at IS NULL AND b.status <> 'available'
              AND EXISTS (SELECT 1 FROM cf_stock_balances k WHERE k.company_id = b.company_id AND k.batch_id = b.id AND k.quantity <> 0)`, c),
    one(db, `SELECT COUNT(*) FROM cf_operations o WHERE o.company_id = ? AND o.deleted_at IS NULL AND o.status = 'active'
              AND NOT EXISTS (SELECT 1 FROM cf_operation_machine_rules r WHERE r.company_id = o.company_id AND r.operation_id = o.id AND r.deleted_at IS NULL)`, c),
    one(db, `SELECT COUNT(*) FROM cf_sales_orders WHERE company_id = ? AND deleted_at IS NULL AND status IN ${OPEN}`, c),
    one(db, "SELECT COUNT(*) FROM cf_machines WHERE company_id = ? AND deleted_at IS NULL AND status = 'active'", c),
    one(db, 'SELECT COUNT(*) FROM cf_stock_balances WHERE company_id = ? AND quantity <> 0', c),
  ]);
  const plural = (n, one1, many) => (n === 1 ? one1 : many);
  const t = await trackerCounts(db, companyId);
  const toRelease = await one(db, `SELECT COUNT(*) FROM cf_sales_order_lines l JOIN cf_sales_orders o ON o.id = l.order_id AND o.deleted_at IS NULL AND o.status = 'confirmed'
     WHERE l.company_id = ? AND l.deleted_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM cf_production_releases r WHERE r.company_id = l.company_id AND r.order_line_id = l.id AND r.deleted_at IS NULL)`, c);
  // Fully delivered = no line still owes anything. NOT EXISTS over the lines that
  // still owe also skips an order with no lines at all, which owes nothing by accident.
  const delivered = await one(db, `SELECT COUNT(*) FROM cf_sales_orders o
     WHERE o.company_id = ? AND o.deleted_at IS NULL AND o.status = 'confirmed'
       AND EXISTS (SELECT 1 FROM cf_sales_order_lines l WHERE l.company_id = o.company_id AND l.order_id = o.id AND l.deleted_at IS NULL)
       AND NOT EXISTS (SELECT 1 FROM cf_sales_order_lines l WHERE l.company_id = o.company_id AND l.order_id = o.id AND l.deleted_at IS NULL
                         AND l.delivered_qty < l.quantity)`, c);
  const b = await purchaseCounts(db, companyId);
  const queues = [
    { key: 'buy', title: 'Material to buy', count: b.toBuy, unit: plural(b.toBuy, 'item', 'items'), tone: 'danger',
      description: 'Short after what is held and what is already on order — nobody has this steel.', actionLabel: 'See what to buy', path: 'buy-list' },
    { key: 'deliveries', title: 'Deliveries to book in', count: b.awaitingDelivery, unit: plural(b.awaitingDelivery, 'order', 'orders'), tone: 'info',
      description: 'Purchase orders sent and not fully received.', actionLabel: 'Open purchase orders', path: 'purchase-orders' },
    { key: 'delivered', title: 'Orders fully delivered', count: delivered, unit: plural(delivered, 'order', 'orders'), tone: 'success',
      description: 'Everything on them has gone out. Closing them lets go of any material still reserved for them.', actionLabel: 'Close them', path: 'orders?status=confirmed' },
    { key: 'ready', title: 'Steps ready to start', count: t.readySteps, unit: plural(t.readySteps, 'step', 'steps'), tone: 'success',
      description: 'Everything they wait for is done and their material is reserved.', actionLabel: 'Open the tracker', path: 'tracker?status=ready' },
    { key: 'material', title: 'Material to reserve', count: t.materialShort, unit: plural(t.materialShort, 'requirement', 'requirements'), tone: 'warning',
      description: 'Released work waiting for material — a step cannot start until it is reserved.', actionLabel: 'Reserve material', path: 'tracker?view=material' },
    { key: 'onhold', title: 'Steps on hold', count: t.onHold, unit: plural(t.onHold, 'step', 'steps'), tone: 'danger',
      description: 'Stopped on the shop floor, each with its reason.', actionLabel: 'See why', path: 'tracker?status=on_hold' },
    { key: 'release', title: 'Lines to release', count: toRelease, unit: plural(toRelease, 'line', 'lines'), tone: 'primary',
      description: 'Lines of confirmed orders not released to production yet.', actionLabel: 'Open orders', path: 'orders?status=confirmed' },
    { key: 'overdue', title: 'Orders past their date', count: overdue, unit: plural(overdue, 'order', 'orders'), tone: 'danger',
      description: 'Open orders whose committed date has passed.', actionLabel: 'Review them', path: 'orders?status=overdue' },
    { key: 'inquiries', title: 'Inquiries to quote', count: inquiries, unit: plural(inquiries, 'inquiry', 'inquiries'), tone: 'info',
      description: 'Design the structure, then send the quotation.', actionLabel: 'Open inquiries', path: 'orders?status=inquiry' },
    { key: 'quoted', title: 'Quotes awaiting the customer', count: quoted, unit: plural(quoted, 'quote', 'quotes'), tone: 'primary',
      description: 'Confirm or close them when the customer answers.', actionLabel: 'Follow up', path: 'orders?status=quoted' },
    { key: 'selections', title: 'Items still to choose', count: selections, unit: plural(selections, 'selection', 'selections'), tone: 'warning',
      description: 'Selection lines on open orders without a catalog item yet.', actionLabel: 'Open orders', path: 'orders' },
    { key: 'drafts', title: 'Drafts to finish', count: itemDrafts + defDrafts, unit: plural(itemDrafts + defDrafts, 'record', 'records'), tone: 'warning',
      description: `${[itemDrafts ? `${itemDrafts} catalog ${plural(itemDrafts, 'item', 'items')}` : null, defDrafts ? `${defDrafts} ${plural(defDrafts, 'definition', 'definitions')}` : null]
        .filter(Boolean).join(' and ') || 'Nothing'} not yet active — activating checks the code and required values.`,
      actionLabel: 'Finish them', path: itemDrafts ? 'items?status=draft' : 'definitions?status=draft' },
    { key: 'flows', title: 'Flows in draft', count: draftFlows, unit: plural(draftFlows, 'flow', 'flows'), tone: 'warning',
      description: 'Nothing can be made by a flow until it is active.', actionLabel: 'Review flows', path: 'flows?status=draft' },
    { key: 'shifts', title: 'Machines without shifts', count: idleMachines, unit: plural(idleMachines, 'machine', 'machines'), tone: 'warning',
      description: 'Until a machine has shifts, no work can be planned on it.', actionLabel: 'Set shifts', path: 'machines' },
    { key: 'untimed', title: 'Operations no machine does', count: untimedOps, unit: plural(untimedOps, 'operation', 'operations'), tone: 'info',
      description: 'No timing rule yet — say which machines do them and how fast.', actionLabel: 'Add timing', path: 'operations' },
    { key: 'held', title: 'Stock on hold', count: heldBatches, unit: plural(heldBatches, 'batch', 'batches'), tone: 'warning',
      description: 'Batches held or rejected — release, move or scrap them.', actionLabel: 'Open batches', path: 'batches?status=on_hold' },
  ];
  return {
    stats: [
      { key: 'openOrders', label: 'Open orders', value: openOrders },
      { key: 'confirmed', label: 'Confirmed orders', value: confirmed },
      { key: 'inProgress', label: 'Steps in progress', value: t.inProgress },
      { key: 'machines', label: 'Machines active', value: machines },
      { key: 'stockLines', label: 'Stock lines', value: stockLines },
    ],
    // Worst first: late orders and stopped work, then what can move now, then setup gaps.
    queues: queues.sort((a, b) => (QUEUE_ORDER[a.key] ?? 50) - (QUEUE_ORDER[b.key] ?? 50)),
  };
}
