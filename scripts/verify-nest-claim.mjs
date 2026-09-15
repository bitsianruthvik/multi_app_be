/**
 * verify-nest-claim.mjs — proves wipInventoryService.claimNest under the
 * qty-is-pieces contract (User Clarification 1 / EU-4), against LOCAL sqldb
 * only.
 *
 * Everything happens inside one transaction that is rolled back at the end —
 * no row survives this script. There is no DDL: a rolled-back rehearsal still
 * COMMITS any DDL inside it, so this only ever INSERTs/SELECTs.
 *
 * Two fresh fab_items material links are written under the LOCAL-FIXTURE-01
 * part (order 247, item 2164), on catalog items that part does not already
 * use — one with nest_no='ZZ-TEST' qty=7, one with nest_no=NULL qty=7 — then
 * claimNest is called on each exactly as openOrMoveWipOnStart calls it.
 *
 * Expected:
 *   nested   -> { qty: 1, nestNo: 'ZZ-TEST' }   (a nest is ONE sheet, however
 *                many pieces its links say come off it)
 *   un-nested -> { qty: required, nestNo: null } (unchanged legacy behaviour)
 *
 * Usage: node scripts/verify-nest-claim.mjs
 */
import { pool } from '../db.js';
import { claimNest } from '../apps/fab_erp/services/wipInventoryService.js';

const COMPANY_ID = 6;
const ORDER_ID = 247;
const PARENT_ITEM_ID = 2164; // LOCAL-FIXTURE-01, an existing "structure" part with real material links on catalog item 297
const NESTED_CATALOG_ITEM_ID = 1;   // not already linked under PARENT_ITEM_ID
const UNNESTED_CATALOG_ITEM_ID = 2; // not already linked under PARENT_ITEM_ID
const REQUIRED = 7;

let failed = false;
function check(label, ok) {
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${label}`);
  if (!ok) failed = true;
}

const conn = await pool.getConnection();
try {
  await conn.beginTransaction();

  await conn.query(
    `INSERT INTO fab_items
       (company_id, order_id, parent_item_id, catalog_item_id, name, node_kind, nest_no, qty, length, width)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [COMPANY_ID, ORDER_ID, PARENT_ITEM_ID, NESTED_CATALOG_ITEM_ID, 'ZZ-TEST nested link', 'material', 'ZZ-TEST', REQUIRED, 3000, 1500],
  );
  await conn.query(
    `INSERT INTO fab_items
       (company_id, order_id, parent_item_id, catalog_item_id, name, node_kind, nest_no, qty, length, width)
     VALUES (?,?,?,?,?,?,NULL,?,?,?)`,
    [COMPANY_ID, ORDER_ID, PARENT_ITEM_ID, UNNESTED_CATALOG_ITEM_ID, 'ZZ-TEST un-nested link', 'material', REQUIRED, 3000, 1500],
  );

  // Shaped the way openOrMoveWipOnStart's call site (wipInventoryService.js)
  // reads them: claimNest only touches task.id / task.order_id and node.id /
  // node.order_id.
  const task = { id: 9999001, order_id: ORDER_ID };
  const node = { id: PARENT_ITEM_ID, order_id: ORDER_ID };

  const nested = await claimNest(
    conn, COMPANY_ID, task, node, { ref_catalog_item_id: NESTED_CATALOG_ITEM_ID, unit: 'kg' }, REQUIRED,
  );
  check(
    `nested link (nest_no='ZZ-TEST', link.qty=${REQUIRED}) -> {qty:1, nestNo:'ZZ-TEST'} (got ${JSON.stringify(nested)})`,
    !!nested && nested.qty === 1 && nested.nestNo === 'ZZ-TEST',
  );

  const unnested = await claimNest(
    conn, COMPANY_ID, task, node, { ref_catalog_item_id: UNNESTED_CATALOG_ITEM_ID, unit: 'kg' }, REQUIRED,
  );
  check(
    `un-nested link (nest_no=NULL, link.qty=${REQUIRED}) -> {qty:${REQUIRED}, nestNo:null} (got ${JSON.stringify(unnested)})`,
    !!unnested && unnested.qty === REQUIRED && unnested.nestNo === null,
  );

  // The nested claim must have actually won the unique index with qty=1 —
  // proving the fix reaches the write, not just claimNest's return value.
  const [[issueRow]] = await conn.query(
    `SELECT qty, nest_no AS nestNo FROM fab_nest_issues
      WHERE company_id = ? AND order_id = ? AND catalog_item_id = ? AND nest_no = ?`,
    [COMPANY_ID, ORDER_ID, NESTED_CATALOG_ITEM_ID, 'ZZ-TEST'],
  );
  check(
    `fab_nest_issues row written with qty=1 (got ${JSON.stringify(issueRow)})`,
    !!issueRow && Number(issueRow.qty) === 1,
  );

  // fab_nest_issues.nest_no is NOT NULL, so the un-nested early return must
  // never attempt an insert there — confirms it stayed byte-identical.
  const [[noIssueRow]] = await conn.query(
    `SELECT COUNT(*) AS n FROM fab_nest_issues WHERE company_id = ? AND order_id = ? AND catalog_item_id = ?`,
    [COMPANY_ID, ORDER_ID, UNNESTED_CATALOG_ITEM_ID],
  );
  check('un-nested branch wrote no fab_nest_issues row', Number(noIssueRow?.n) === 0);
} catch (err) {
  failed = true;
  console.error('ERROR', err);
} finally {
  await conn.rollback();
  conn.release();
  await pool.end();
}

console.log(failed ? '\nFAILED' : '\nALL PASS (transaction rolled back, nothing persisted)');
process.exit(failed ? 1 : 0);
