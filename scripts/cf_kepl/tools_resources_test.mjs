/**
 * tools_resources_test.mjs — TOOLS, SPARES AND CONSUMABLES AS STOCK ITEMS, each machine's RESOURCE LIST
 * (init.sql §81, TM/CF_ERP_ORDER_FLOW_PLAN.md "2026-10-18 — S5"). Against the local database.
 *
 *   cd multi_app_be
 *   node scripts/cf_kepl/tools_resources_test.mjs
 *
 *   CF_TOOLS_COMPANY (2)
 *
 * EVERYTHING HAPPENS INSIDE ONE TRANSACTION THAT IS ROLLED BACK, and the last thing it does is re-count every
 * cf_ table. It OWNS its fixture (tagged with a run id): machine types and machines (one a tool of the register),
 * an area, a supplier, an order. The Tools / Spares / Consumables families come from §81 itself.
 *
 *   1. the classification: three families flagged, each with a General variant
 *   2. the migration: a register machine that is a tool gets a catalog item; run twice = once; the old row is still read
 *   3. tool issue: "Used for" is needed; a tool with a life gets a row per piece; use counts; worn out; retire; reversal voids
 *   4. an item without a life is not tracked; life setting rules
 *   5. the machine resource list: CRUD, whole-list save, refusals, machineResources() shape and order
 *   6. the routes are mounted
 */
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
await imp('apps/cf_erp/services/codegenProvider.js');
const { attachNodeCache, detachNodeCache } = await imp('apps/cf_erp/lib/db.js');
const STOCK = await imp('apps/cf_erp/services/stockService.js');
const TOOLS = await imp('apps/cf_erp/services/toolLifeService.js');
const RES = await imp('apps/cf_erp/services/machineResourceService.js');
const MACH = await imp('apps/cf_erp/services/machineService.js');
const toolRoutes = (await imp('apps/cf_erp/routes/toolsResources.js')).default;

const COMPANY = Number(process.env.CF_TOOLS_COMPANY ?? 2);
const RUN = `TR${Date.now().toString(36).toUpperCase()}`;

let passed = 0;
let failed = 0;
function ok(label, cond, detail = '') {
  if (typeof label !== 'string' || typeof cond !== 'boolean') {
    throw new Error(`ok(label, cond) takes a string and then a boolean — got ok(${typeof label}, ${typeof cond})`);
  }
  if (cond) { passed += 1; console.log(`  PASS  ${label}`); }
  else { failed += 1; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
}
const near = (a, b, eps = 0.0005) => a != null && b != null && Math.abs(Number(a) - Number(b)) <= eps;
const eq = (label, got, want) => ok(label, typeof want === 'number' ? near(got, want) : got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const section = (t) => console.log(`\n${t}`);

async function census(db) {
  const [rows] = await db.query("SHOW TABLES LIKE 'cf\\_%'");
  const out = {};
  for (const t of rows.map((r) => Object.values(r)[0]).sort()) {
    const [[r]] = await db.query(`SELECT COUNT(*) AS n FROM \`${t}\``);
    out[t] = Number(r.n);
  }
  return out;
}

async function expectRefusal(label, fn, re) {
  let err = null;
  try { await fn(); } catch (e) { err = e; }
  const text = err ? [err.message, ...(err.problems ?? err.details?.problems ?? [])].join(' | ') : '';
  ok(label, !!err && (!re || re.test(text)), err ? text : 'it was allowed');
}

/** The migration block of init.sql §81, statement by statement. */
function migrationStatements() {
  const sql = fs.readFileSync(path.join(BE, 'apps/cf_erp/models/init.sql'), 'utf8');
  const a = sql.indexOf('-- ----- MIGRATE-BEGIN');
  const b = sql.indexOf('-- ----- MIGRATE-END');
  if (a < 0 || b < a) throw new Error('MIGRATE-BEGIN / MIGRATE-END not found in init.sql');
  return sql.slice(a, b).split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').split(/;\s*\n/).map((s) => s.trim()).filter(Boolean);
}

const conn = await pool.getConnection();
let exitCode = 0;
try {
  const before = await census(conn);
  await conn.beginTransaction();
  attachNodeCache(conn);
  const ins = async (sql, params) => (await conn.query(sql, params))[0].insertId;
  const [[user]] = await conn.query('SELECT id FROM users WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [COMPANY]);
  const c = { companyId: COMPANY, userId: user?.id ?? null };
  console.log(`Company ${COMPANY} — run ${RUN}`);

  section('1. The classification: Tools, Spares, Consumables');
  const [fams] = await conn.query("SELECT id, code, name, resource_kind FROM cf_classification_nodes WHERE company_id = ? AND depth = 0 AND deleted_at IS NULL AND resource_kind IS NOT NULL", [COMPANY]);
  for (const k of ['tool', 'spare', 'consumable']) ok(`a ${k} family exists`, fams.filter((f) => f.resource_kind === k).length === 1);
  const variantOf = async (kind) => {
    const [[v]] = await conn.query(
      `SELECT v.id FROM cf_classification_nodes v JOIN cf_classification_nodes s ON s.id = v.parent_id JOIN cf_classification_nodes f ON f.id = s.parent_id
        WHERE v.company_id = ? AND v.depth = 2 AND v.deleted_at IS NULL AND f.resource_kind = ? ORDER BY v.id LIMIT 1`, [COMPANY, kind]);
    return v?.id;
  };
  const V = { tool: await variantOf('tool'), spare: await variantOf('spare'), consumable: await variantOf('consumable') };
  ok('each family has a variant to put items under', !!V.tool && !!V.spare && !!V.consumable);

  // Fixture: machine types (scope machine), machines, an area, a supplier, an order.
  const node = (parent, depth, key) => ins("INSERT INTO cf_classification_nodes (company_id, parent_id, depth, scope, code, name, status) VALUES (?, ?, ?, 'machine', ?, ?, 'active')",
    [COMPANY, parent, depth, `${RUN}-${key}`, `${RUN} ${key}`]);
  const mf = await node(null, 0, 'MF');
  const ms = await node(mf, 1, 'PLANT-OTHER-TOOL');
  const toolType = await node(ms, 2, 'HANDTOOL');
  const bigFam = await node(null, 0, 'BF');
  const bigSub = await node(bigFam, 1, 'BS');
  const bigType = await node(bigSub, 2, 'CUTTER');
  const toolMachine = await ins("INSERT INTO cf_machines (company_id, code, name, classification_id) VALUES (?, ?, ?, ?)", [COMPANY, `${RUN}-TM1`, `${RUN} torque wrench`, toolType]);
  const bigMachine = await ins("INSERT INTO cf_machines (company_id, code, name, classification_id) VALUES (?, ?, ?, ?)", [COMPANY, `${RUN}-BM1`, `${RUN} plasma`, bigType]);
  const area = await ins("INSERT INTO cf_stocking_areas (company_id, code, name, purpose, status) VALUES (?, ?, ?, 'storage', 'active')", [COMPANY, `${RUN}-A1`, `${RUN} A1`]);
  const supplier = await ins("INSERT INTO cf_parties (company_id, code, name, is_supplier, status) VALUES (?, ?, ?, 1, 'active')", [COMPANY, `${RUN}-SUP`, `${RUN} Supplier`]);
  const customer = await ins("INSERT INTO cf_parties (company_id, code, name, is_customer, status) VALUES (?, ?, ?, 1, 'active')", [COMPANY, `${RUN}-CUS`, `${RUN} Customer`]);
  const order = await ins("INSERT INTO cf_sales_orders (company_id, code, order_type, title, status, customer_id) VALUES (?, ?, 'customer', 'Tools fixture', 'confirmed', ?)", [COMPANY, `${RUN}-SO`, customer]);
  const item = async (key, kind, trackedBy = 'quantity') => {
    const id = await ins("INSERT INTO cf_master_records (company_id, record_kind, code, name, classification_id, status) VALUES (?, 'item', ?, ?, ?, 'active')",
      [COMPANY, `${RUN}-${key}`, `${RUN} ${key}`, V[kind]]);
    await conn.query("INSERT INTO cf_item_details (master_id, company_id, item_type, tracked_by, uom, sourcing) VALUES (?, ?, 'catalog', ?, 'nos', 'stock')", [id, COMPANY, trackedBy]);
    return id;
  };

  section('2. The migration: a register machine that is a tool becomes a catalog tool item');
  const stmts = migrationStatements();
  ok('the migration is three statements', stmts.length === 3, `got ${stmts.length}`);
  const run = async () => { for (const s of stmts) await conn.query(s); };
  const itemsFor = async () => (await conn.query("SELECT r.id, r.classification_id, d.uom FROM cf_master_records r JOIN cf_item_details d ON d.master_id = r.id WHERE r.company_id = ? AND LOWER(r.code) = LOWER(?) AND r.deleted_at IS NULL", [COMPANY, `TL-${RUN}-TM1`]))[0];
  await run();
  let made = await itemsFor();
  eq('one tool item "TL-<machine code>" was made', made.length, 1);
  const [[mrow]] = await conn.query('SELECT catalog_item_id FROM cf_machines WHERE id = ?', [toolMachine]);
  eq('the machine points at it ("bought as")', mrow.catalog_item_id, made[0].id);
  eq('it sits under the Tools family', made[0].classification_id, V.tool);
  const [[bigRow]] = await conn.query('SELECT catalog_item_id FROM cf_machines WHERE id = ?', [bigMachine]);
  ok('a production machine is not touched', bigRow.catalog_item_id === null);
  const [[allCount1]] = await conn.query("SELECT COUNT(*) AS n FROM cf_master_records WHERE company_id = ? AND code LIKE 'TL-%'", [COMPANY]);
  await run();
  made = await itemsFor();
  const [[allCount2]] = await conn.query("SELECT COUNT(*) AS n FROM cf_master_records WHERE company_id = ? AND code LIKE 'TL-%'", [COMPANY]);
  ok('run twice = once: still one item, and no other tool item appeared', made.length === 1 && allCount1.n === allCount2.n);
  const shaped = await MACH.getMachine(conn, COMPANY, toolMachine);
  ok('the old machine row is still read (name, type, bought as)', shaped.name === `${RUN} torque wrench` && shaped.catalogItem?.id === made[0].id);
  const listed = await MACH.listMachines(conn, COMPANY, { search: RUN });
  ok('the machine list still shows both machines', listed.length === 2);
  // Before/after the family sections: re-running them changes nothing either.
  const [[famCount]] = await conn.query("SELECT COUNT(*) AS n FROM cf_classification_nodes WHERE company_id = ? AND resource_kind IS NOT NULL AND deleted_at IS NULL", [COMPANY]);
  eq('exactly three flagged families', famCount.n, 3);

  section('3. Issuing a tool: "Used for", a row per piece, use, worn out, retire, reversal');
  const wrench = await item('WRENCH', 'tool');
  const life = await TOOLS.setItemLife(conn, c, wrench, { lifeUnit: 'uses', lifeLimit: 3 });
  eq('the life is stored: 3 uses', life.lifeLimit, 3);
  eq('…counted in uses', life.lifeUnit, 'uses');
  await STOCK.postMovement(conn, c, { movementType: 'receipt', partyId: supplier, toAreaId: area, lines: [{ itemId: wrench, quantity: 5, unitCost: 400 }] });
  await expectRefusal('a tool issue without Used for is refused', () => STOCK.postMovement(conn, c, { movementType: 'issue', fromAreaId: area, lines: [{ itemId: wrench, quantity: 1 }] }), /used for/i);
  const is1 = await STOCK.postMovement(conn, c, { movementType: 'issue', usedFor: 'general', fromAreaId: area, lines: [{ itemId: wrench, quantity: 2 }] });
  let pieces = await TOOLS.listToolLife(conn, COMPANY, { itemId: wrench });
  eq('two pieces issued = two life rows', pieces.length, 2);
  ok('each starts in use with 3 uses to go', pieces.every((p) => p.status === 'in_use' && p.lifeLimit === 3 && p.lifeUsed === 0 && p.remaining === 3));
  ok('a General issue has no order', pieces.every((p) => p.orderId === null && p.usedFor === 'general'));
  const [p1, p2] = [...pieces].sort((a, b) => a.unitNo - b.unitNo);
  let r = await TOOLS.recordToolUse(conn, c, p1.id, { amount: 1, machineId: bigMachine });
  eq('one use counted', r.lifeUsed, 1);
  eq('2 left', r.remaining, 2);
  eq('and it was mounted on the machine', r.machineId, bigMachine);
  r = await TOOLS.recordToolUse(conn, c, p1.id, { amount: 2 });
  eq('at the limit it is worn out', r.status, 'worn_out');
  eq('percent used 100', r.percentUsed, 100);
  await expectRefusal('a worn-out piece takes no more use', () => TOOLS.recordToolUse(conn, c, p1.id, { amount: 1 }), /worn out/);
  await expectRefusal('use must be above zero', () => TOOLS.recordToolUse(conn, c, p2.id, { amount: 0 }), /above zero/);
  const detail = await TOOLS.getToolLife(conn, COMPANY, p1.id);
  eq('its use history has two entries', detail.usage.length, 2);
  r = await TOOLS.retireTool(conn, c, p2.id, { note: 'chipped' });
  eq('a piece can be retired', r.status, 'retired');
  await expectRefusal('a retired piece cannot be retired again', () => TOOLS.retireTool(conn, c, p2.id), /in use/);
  const summary = await TOOLS.getItemLife(conn, COMPANY, wrench);
  ok('the item counts its pieces: 0 in use, 1 worn out, 1 retired', summary.inUse === 0 && summary.wornOut === 1 && summary.retired === 1);
  const toolItems = await TOOLS.listToolItems(conn, COMPANY, { search: RUN });
  ok('the Tools list shows the item with its life', toolItems.some((t) => t.id === wrench && t.lifeLimit === 3 && t.wornOut === 1));
  // An issue for an order copies the order; a reversal voids its pieces.
  const is2 = await STOCK.postMovement(conn, c, { movementType: 'issue', fromAreaId: area, orderId: order, lines: [{ itemId: wrench, quantity: 1 }] });
  pieces = await TOOLS.listToolLife(conn, COMPANY, { itemId: wrench, status: 'in_use' });
  eq('the order issue made one piece in use', pieces.length, 1);
  eq('…for that order', pieces[0].orderId, order);
  eq('…Used for: order', pieces[0].usedFor, 'order');
  await STOCK.reverseMovement(conn, c, is2.id, { reason: 'taken in error' });
  pieces = await TOOLS.listToolLife(conn, COMPANY, { itemId: wrench, status: 'in_use' });
  eq('reversing the issue removes its piece from tracking', pieces.length, 0);
  ok('the first issue\'s pieces are untouched', (await TOOLS.listToolLife(conn, COMPANY, { itemId: wrench, status: 'all' })).length === 2 && is1.id > 0);

  section('4. No life = no tracking; life rules');
  const plain = await item('PLAIN', 'tool');
  await STOCK.postMovement(conn, c, { movementType: 'receipt', partyId: supplier, toAreaId: area, lines: [{ itemId: plain, quantity: 3, unitCost: 10 }] });
  await STOCK.postMovement(conn, c, { movementType: 'issue', usedFor: 'general', fromAreaId: area, lines: [{ itemId: plain, quantity: 2 }] });
  eq('a tool without a life leaves no rows', (await TOOLS.listToolLife(conn, COMPANY, { itemId: plain, status: 'all' })).length, 0);
  await expectRefusal('a limit needs a unit', () => TOOLS.setItemLife(conn, c, plain, { lifeLimit: 5 }), /counted in/);
  await expectRefusal('an unknown unit is refused', () => TOOLS.setItemLife(conn, c, plain, { lifeUnit: 'days', lifeLimit: 5 }), /uses, hours, metres/);
  await expectRefusal('a zero limit is refused', () => TOOLS.setItemLife(conn, c, plain, { lifeUnit: 'hours', lifeLimit: 0 }), /above zero/);
  const hours = await TOOLS.setItemLife(conn, c, plain, { lifeUnit: 'hours', lifeLimit: 1.5 });
  eq('hours with a fraction are kept', hours.lifeLimit, 1.5);
  await STOCK.postMovement(conn, c, { movementType: 'issue', usedFor: 'general', fromAreaId: area, lines: [{ itemId: plain, quantity: 1 }] });
  const [hp] = await TOOLS.listToolLife(conn, COMPANY, { itemId: plain });
  eq('now an issued piece is tracked in hours', hp.lifeUnit, 'hours');
  r = await TOOLS.recordToolUse(conn, c, hp.id, { amount: 0.75 });
  ok('0.75 h of 1.5 h = 50 %', r.percentUsed === 50 && r.status === 'in_use' && near(r.remaining, 0.75));
  const cleared = await TOOLS.setItemLife(conn, c, plain, { lifeUnit: null, lifeLimit: null });
  ok('the life can be cleared', cleared.lifeUnit === null && cleared.lifeLimit === null);

  section('5. The machine resource list');
  const spare = await item('BEARING', 'spare');
  const cons = await item('NOZZLE', 'consumable');
  const [bare] = [await ins("INSERT INTO cf_master_records (company_id, record_kind, code, name, classification_id, status) VALUES (?, 'item', ?, ?, ?, 'active')", [COMPANY, `${RUN}-TEMP`, `${RUN} temp`, V.consumable])];
  await conn.query("INSERT INTO cf_item_details (master_id, company_id, item_type, tracked_by, uom, sourcing) VALUES (?, ?, 'temporary', 'quantity', 'nos', 'make')", [bare, COMPANY]);
  eq('the list starts empty', (await RES.machineResources(conn, COMPANY, bigMachine)).length, 0);
  const a1 = await RES.addMachineResource(conn, c, bigMachine, { itemId: cons, qty: 6 });
  eq('a consumable takes its kind from its family', a1.kind, 'consumable');
  const a2 = await RES.addMachineResource(conn, c, bigMachine, { itemId: wrench, qty: 1 });
  eq('a tool takes its kind from its family', a2.kind, 'tool');
  const a3 = await RES.addMachineResource(conn, c, bigMachine, { itemId: spare, kind: 'spare', qty: 2, notes: 'drive end' });
  const lean = await RES.machineResources(conn, COMPANY, bigMachine);
  ok('machineResources: tools first, then spares, then consumables', lean.map((x) => x.kind).join() === 'tool,spare,consumable', lean.map((x) => x.kind).join());
  ok('machineResources rows are exactly { itemId, code, name, kind, qty, uom }', lean.every((x) => Object.keys(x).sort().join() === 'code,itemId,kind,name,qty,uom'));
  const cn = lean.find((x) => x.kind === 'consumable');
  ok('…with the item\'s own code, name, quantity and unit', cn.itemId === cons && cn.code === `${RUN}-NOZZLE` && cn.qty === 6 && cn.uom === 'nos');
  const up = await RES.updateMachineResource(conn, c, a1.id, { qty: 10, notes: 'box of 10' });
  ok('a row\'s quantity and note change', up.qty === 10 && up.notes === 'box of 10');
  const up2 = await RES.updateMachineResource(conn, c, a1.id, { kind: 'spare' });
  eq('a row\'s kind can be set by hand', up2.kind, 'spare');
  await expectRefusal('quantity zero is refused', () => RES.updateMachineResource(conn, c, a1.id, { qty: 0 }), /above zero/);
  await expectRefusal('a wrong kind is refused', () => RES.updateMachineResource(conn, c, a1.id, { kind: 'gadget' }), /tool, spare or consumable/);
  await expectRefusal('a temporary item is refused', () => RES.addMachineResource(conn, c, bigMachine, { itemId: bare }), /temporary/);
  await expectRefusal('an unknown item is refused', () => RES.addMachineResource(conn, c, bigMachine, { itemId: -5 }), /choose an item/);
  const again = await RES.addMachineResource(conn, c, bigMachine, { itemId: wrench, qty: 4 });
  ok('adding an item already on the list updates its row', again.id === a2.id && again.qty === 4);
  eq('…so the list still has three rows', (await RES.listMachineResources(conn, COMPANY, bigMachine)).length, 3);
  // The whole list in one save.
  const full = await RES.setMachineResources(conn, c, bigMachine, { rows: [{ itemId: spare, kind: 'spare', qty: 3 }, { itemId: cons, qty: 20 }, { itemId: plain, kind: 'tool' }] });
  ok('a whole-list save: the sent rows, in order of kind', full.map((x) => x.code.replace(`${RUN}-`, '')).join() === 'PLAIN,BEARING,NOZZLE', full.map((x) => x.code).join());
  ok('…the wrench (not sent) is gone, the others updated', !full.some((x) => x.itemId === wrench) && full.find((x) => x.itemId === spare).qty === 3 && full.find((x) => x.itemId === cons).kind === 'consumable');
  await expectRefusal('a duplicate item in one save is refused', () => RES.setMachineResources(conn, c, bigMachine, { rows: [{ itemId: spare }, { itemId: spare }] }), /already on the list/);
  eq('a refused save changed nothing', (await RES.machineResources(conn, COMPANY, bigMachine)).length, 3);
  const [{ id: delId }] = await RES.listMachineResources(conn, COMPANY, bigMachine);
  await RES.removeMachineResource(conn, c, delId);
  eq('a row removed', (await RES.machineResources(conn, COMPANY, bigMachine)).length, 2);
  await RES.addMachineResource(conn, c, bigMachine, { itemId: plain });
  eq('a removed item can be added again', (await RES.machineResources(conn, COMPANY, bigMachine)).length, 3);
  await RES.setMachineResources(conn, c, bigMachine, { rows: [] });
  eq('an empty save clears the list', (await RES.machineResources(conn, COMPANY, bigMachine)).length, 0);
  await expectRefusal('another company\'s machine is not found', () => RES.listMachineResources(conn, COMPANY + 9999, bigMachine), /not found/);
  const picks = await RES.searchResourceItems(conn, COMPANY, { kind: 'spare', search: RUN });
  ok('the picker finds spares by kind and search', picks.length === 1 && picks[0].id === spare && picks[0].kind === 'spare');
  const picksAll = await RES.searchResourceItems(conn, COMPANY, { search: RUN });
  ok('with no kind it finds the four items made here and the migrated tool, no temporary items', picksAll.length === 5 && picksAll.some((x) => x.code === 'TL-' + RUN + '-TM1') && !picksAll.some((x) => x.id === bare), String(picksAll.length));
  // A machine deleted keeps nothing in its list read.
  await RES.setMachineResources(conn, c, toolMachine, { rows: [{ itemId: cons, qty: 1 }] });
  eq('a second machine has its own list', (await RES.machineResources(conn, COMPANY, toolMachine)).length, 1);
  eq('…and the first is unaffected', (await RES.machineResources(conn, COMPANY, bigMachine)).length, 0);

  section('6. The routes are mounted');
  const paths = new Set(toolRoutes.stack.filter((l) => l.route).map((l) => `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}`));
  for (const want of ['GET /machines/:id/resources', 'PUT /machines/:id/resources', 'POST /machines/:id/resources', 'PUT /machine-resources/:id', 'DELETE /machine-resources/:id',
    'GET /resource-items', 'GET /tools/life', 'POST /tools/life/:id/use', 'POST /tools/life/:id/retire', 'GET /tools/items', 'PUT /items/:id/tool-life']) {
    ok(`route ${want}`, paths.has(want));
  }
  ok('the ledger and balances agree at the end', (await STOCK.checkLedger(conn, COMPANY)).ok);

  detachNodeCache(conn);
  await conn.rollback();
  const after = await census(conn);
  // Only the tables THIS suite writes: other agents run suites on the same database at the same time.
  const MINE = /^cf_(machine|tool|stock|item_details|master_records|classification_nodes|sales_order|parties|stocking_areas|item_costs|machines)/;
  const moved = Object.keys({ ...before, ...after }).filter((t) => MINE.test(t) && before[t] !== after[t]);
  ok('every cf_ table is back to its count', moved.length === 0, moved.map((t) => `${t} ${before[t]}->${after[t]}`).join(', '));
} catch (e) {
  exitCode = 1;
  console.error(e);
  try { await conn.rollback(); } catch { /* already gone */ }
} finally {
  conn.release();
  await pool.end();
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed || exitCode ? 1 : 0);
