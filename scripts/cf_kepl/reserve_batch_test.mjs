/**
 * reserve_batch_test.mjs — how many round trips "reserve all" costs on the KEPL
 * line, and a golden snapshot of everything it writes, so a rewrite of
 * releaseService.reserveRelease is PROVED to reserve exactly what the old
 * one-requirement-at-a-time loop did. Against the local database.
 *
 *   cd multi_app_be
 *   node scripts/cf_kepl/reserve_batch_test.mjs --save  <file>    # capture the snapshot
 *   node scripts/cf_kepl/reserve_batch_test.mjs --check <file>    # compare with it
 *   node scripts/cf_kepl/reserve_batch_test.mjs                   # counts only
 *
 *   CF_RESERVE_COMPANY (2), CF_RESERVE_LINE (923 — the local KEPL copy, 128 requirements since the nest rule)
 *   CF_RESERVE_MAX_TRIPS (60) — the most round trips one "reserve all" may take
 *   CF_RESERVE_TRACE=1 — print every counted query
 *
 * EVERYTHING HAPPENS INSIDE ONE TRANSACTION THAT IS ROLLED BACK, and the last
 * thing it does is re-count every cf_ table and prove each is back where it
 * started. Save snapshots to scratch, never into the repo (~40 MB).
 *
 * Like release_batch_test it BORROWS the real line: inside the transaction the
 * line is locked, its order confirmed, a dispatch area made if there is none,
 * and the line released. Then stock is put on the shelf THROUGH THE STOCK
 * SERVICES (postMovement receipts and a transfer, setBatchStatus), never as raw
 * rows, so balances, batches and the ledger agree — checkLedger is asserted.
 * The stock is chosen so reservation is interesting.
 *
 * Since 2026-09-30 the line's raw plate comes from its NEST: one requirement
 * of ONE whole plate per plate lot (releaseService "raw plate from the nest"),
 * 128 requirements where there were 2,952 plate fractions. The seed below was
 * re-cut to whole plates then, and the golden re-saved deliberately. The local
 * DB already holds a few plates of most sizes (a received demo PO), so the
 * seed is on top of that:
 *
 *   PL-12X2500X12100 (9 lots): four batches over two usable areas — one batch
 *     split across storage and WIP by a transfer, two received the same day
 *     (the batch id breaks the tie), one on hold, plus stock in quarantine that
 *     must not count. One plate goes short until scenario 2's older batch.
 *   PL-16X2300X12100 (4 lots): one big batch — every requirement covered.
 *   PL-16X2300X6500 (3): two small batches — the last one partial.
 *   PL-12X2250X12050 (4): extra stock in quarantine only — it never counts.
 *   PL-16X1600X12350 (4): a rejected batch and a small good one — one short.
 *   PL-16X2000X8000 (1): two more batches, more than the demand.
 *   PL-25X1750X10850 (8): one batch — one plate short.
 *   STUD-001 (counted by quantity, no batches): storage + WIP, four of eight
 *     requirements covered, one partly.
 *   everything else: no stock at all.
 *
 * Before the counted run two requirements are reserved one at a time
 * (reserveRequirement with a quantity and with a batch), so "reserve all" meets
 * requirements already partly and wholly covered.
 *
 * SCENARIO 2 runs "reserve all" again ON TOP of the first: a new, older batch
 * arrives, one reservation is let go, one requirement is issued, and a few
 * reserveRequirement refusals are recorded (their words are part of the
 * snapshot). Then the second counted run.
 *
 * The snapshot, per scenario: every reservation row made inside the run (all
 * columns but ids and times; requirement = `Q<n>` in id order, item and batch by
 * code), every requirement's quantity and issued, the balances of the seeded
 * items (area, item, batch codes), and what reserveRelease returned — the
 * `reserved` count, the `short` list and the whole tracker with ids replaced
 * by stable keys (item = sort_order, step = sort_order:flow_step_id).
 */
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
await imp('apps/cf_erp/services/codegenProvider.js');           // registers the code-generator entities
const { attachNodeCache, detachNodeCache } = await imp('apps/cf_erp/lib/db.js');
const REL = await imp('apps/cf_erp/services/releaseService.js');
const LOCK = await imp('apps/cf_erp/services/lockService.js');
const SO = await imp('apps/cf_erp/services/salesOrderService.js');
const AREAS = await imp('apps/cf_erp/services/stockingAreaService.js');
const STOCK = await imp('apps/cf_erp/services/stockService.js');
const BATCH = await imp('apps/cf_erp/services/batchService.js');

const COMPANY = Number(process.env.CF_RESERVE_COMPANY ?? 2);
const LINE = Number(process.env.CF_RESERVE_LINE ?? 923);
const MAX_TRIPS = Number(process.env.CF_RESERVE_MAX_TRIPS ?? 60);
const arg = (flag) => { const i = process.argv.indexOf(flag); return i > 0 ? process.argv[i + 1] : null; };
const SAVE = arg('--save');
const CHECK = arg('--check');

let passed = 0;
let failed = 0;
const fails = [];
function ok(label, cond, detail = '') {
  if (typeof label !== 'string' || typeof cond !== 'boolean') {
    throw new Error(`ok(label, cond) takes a string and then a boolean — got ok(${typeof label}, ${typeof cond})`);
  }
  if (cond) { passed += 1; console.log(`  PASS  ${label}`); }
  else { failed += 1; fails.push(label); console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
}

async function census(db) {
  const [rows] = await db.query("SHOW TABLES LIKE 'cf\\_%'");
  const out = {};
  for (const t of rows.map((r) => Object.values(r)[0]).sort()) {
    const [[r]] = await db.query(`SELECT COUNT(*) AS n FROM \`${t}\``);
    out[t] = Number(r.n);
  }
  return out;
}
/** Counts the round trips made through it. A Proxy, so the transaction's node cache still rides on the connection. */
function counting(db) {
  const tally = { n: 0 };
  const proxy = new Proxy(db, {
    get: (target, prop) => (prop === 'query' || prop === 'execute'
      ? (...args) => {
        tally.n += 1;
        if (process.env.CF_RESERVE_TRACE) console.log(`    ${String(tally.n).padStart(5)}  ${String(args[0]?.sql ?? args[0]).replace(/\s+/g, ' ').slice(0, 110)}`);
        return target[prop](...args);
      }
      : Reflect.get(target, prop)),
  });
  return { db: proxy, tally };
}

// --- the snapshot ---------------------------------------------------------------

const TIMES = new Set(['created_at', 'updated_at', 'deleted_at', 'started_at', 'finished_at', 'closed_at']);
const num = (v) => (v == null ? null : v instanceof Date ? v.toISOString() : v);
function strip(row, drop) {
  const out = {};
  for (const k of Object.keys(row).sort()) {
    if (TIMES.has(k) || drop.includes(k)) continue;
    out[k] = num(row[k]);
  }
  return out;
}

async function keysOf(db, releaseId) {
  const [items] = await db.query('SELECT id, sort_order FROM cf_production_items WHERE release_id = ?', [releaseId]);
  const itemKey = new Map(items.map((x) => [x.id, `I${x.sort_order}`]));
  const [steps] = await db.query(
    `SELECT s.id, s.flow_step_id, pi.sort_order AS item_sort FROM cf_production_steps s JOIN cf_production_items pi ON pi.id = s.production_item_id
      WHERE pi.release_id = ?`,
    [releaseId],
  );
  const stepKey = new Map(steps.map((s) => [s.id, `S${s.item_sort}:${s.flow_step_id}`]));
  const [reqs] = await db.query('SELECT id FROM cf_material_requirements WHERE release_id = ? ORDER BY id', [releaseId]);
  const reqKey = new Map(reqs.map((q, i) => [q.id, `Q${i + 1}`]));
  return { itemKey, stepKey, reqKey };
}

function miss(map, id, what) {
  if (id == null) return null;
  const k = map.get(id);
  if (!k) throw new Error(`snapshot: ${what} ${id} has no stable key`);
  return k;
}

function normaliseRelease(rel, { itemKey, stepKey, reqKey }) {
  return {
    ...rel,
    id: 'R',
    releasedAt: null,
    finishedArea: rel.finishedArea ? { ...rel.finishedArea, id: 'AREA' } : null,
    items: rel.items.map((it) => ({
      ...it,
      id: miss(itemKey, it.id, 'item'),
      parentId: miss(itemKey, it.parentId, 'item'),
      steps: it.steps.map((s) => ({ ...s, id: miss(stepKey, s.id, 'step'), requirementIds: s.requirementIds.map((q) => miss(reqKey, q, 'requirement')), startedAt: null, finishedAt: null })),
    })),
    requirements: rel.requirements.map((q) => ({
      ...q,
      id: miss(reqKey, q.id, 'requirement'),
      piece: q.piece ? { ...q.piece, id: miss(itemKey, q.piece.id, 'item') } : null,
      step: q.step ? { ...q.step, id: miss(stepKey, q.step.id, 'step') } : null,
      reservations: q.reservations.map((v) => ({ ...v, id: 'V', batch: v.batch ? { ...v.batch, id: 'B' } : null })),
    })),
  };
}

async function snapshot(db, releaseId, keys, sinceReservationId, seededItems, returned) {
  const [res] = await db.query(
    `SELECT v.*, m.code AS item_code, b.code AS batch_code FROM cf_stock_reservations v
       JOIN cf_master_records m ON m.id = v.item_id LEFT JOIN cf_stock_batches b ON b.id = v.batch_id
      WHERE v.company_id = ? AND v.id > ? ORDER BY v.id`,
    [COMPANY, sinceReservationId],
  );
  const [reqs] = await db.query('SELECT id, item_id, quantity, issued FROM cf_material_requirements WHERE release_id = ? ORDER BY id', [releaseId]);
  const [bal] = await db.query(
    `SELECT a.code AS area, m.code AS item, b.code AS batch, b.status AS batch_status, b.received_on, k.quantity
       FROM cf_stock_balances k JOIN cf_stocking_areas a ON a.id = k.stocking_area_id JOIN cf_master_records m ON m.id = k.item_id
       LEFT JOIN cf_stock_batches b ON b.id = k.batch_id
      WHERE k.company_id = ? AND k.item_id IN (?) ORDER BY a.code, m.code, b.code`,
    [COMPANY, seededItems],
  );
  return {
    reservations: res.map((v) => ({
      ...strip(v, ['id', 'requirement_id', 'item_id', 'batch_id']),
      requirement: miss(keys.reqKey, v.requirement_id, 'requirement'),
    })),
    requirements: reqs.map((q) => ({ key: keys.reqKey.get(q.id), item_id: q.item_id, quantity: q.quantity, issued: q.issued })),
    balances: bal.map((b) => strip(b, [])),
    returned: { reserved: returned.reserved, short: returned.short, release: normaliseRelease(returned.release, keys) },
  };
}

/** The first few differences between two snapshots, as paths. */
function differences(a, b, at = '', out = []) {
  if (out.length >= 20) return out;
  if (JSON.stringify(a) === JSON.stringify(b)) return out;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    if (Array.isArray(a) && Array.isArray(b) && a.length !== b.length) out.push(`${at}: length ${a.length} vs ${b.length}`);
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) differences(a[k], b[k], `${at}/${k}`, out);
    return out;
  }
  out.push(`${at}: ${JSON.stringify(a)?.slice(0, 120)} vs ${JSON.stringify(b)?.slice(0, 120)}`);
  return out;
}

// --- the stock ------------------------------------------------------------------

async function itemByCode(db, code) {
  const [[m]] = await db.query("SELECT id FROM cf_master_records WHERE company_id = ? AND code = ? AND deleted_at IS NULL AND record_kind = 'item'", [COMPANY, code]);
  if (!m) throw new Error(`Item ${code} is not in company ${COMPANY} — the scenario is written for the KEPL line.`);
  return m.id;
}
async function batchByCode(db, code) {
  const [[b]] = await db.query('SELECT id FROM cf_stock_batches WHERE company_id = ? AND code = ?', [COMPANY, code]);
  return b.id;
}
const receipt = (c, db, date, toAreaId, lines) => STOCK.postMovement(db, c, { movementType: 'receipt', movementDate: date, toAreaId, reference: 'reserve_batch_test', lines });

async function seedStock(db, c, A, I) {
  // PL-12X2500X12100: 9 plate lots.
  await receipt(c, db, '2026-08-15', A.sto, [{ itemId: I.p1621, quantity: 2, batch: { code: 'RSV-1621-A' } }]);      // oldest
  await receipt(c, db, '2026-09-01', A.sto, [
    { itemId: I.p1621, quantity: 1, batch: { code: 'RSV-1621-B' } },
    { itemId: I.p1621, quantity: 1, batch: { code: 'RSV-1621-C' } },                                            // same day as B: id breaks the tie
    { itemId: I.p1621, quantity: 1, batch: { code: 'RSV-1621-H' } },                                            // to be put on hold
  ]);
  await receipt(c, db, '2026-09-10', A.qua, [{ itemId: I.p1621, quantity: 4, batch: { code: 'RSV-1621-Q' } }]);    // quarantine: never counts
  const bA = await batchByCode(db, 'RSV-1621-A');
  const bB = await batchByCode(db, 'RSV-1621-B');
  await STOCK.postMovement(db, c, { movementType: 'transfer', movementDate: '2026-09-12', fromAreaId: A.sto, toAreaId: A.wip, lines: [
    { itemId: I.p1621, quantity: 1, batchId: bA },                                                               // one batch, two usable areas
    { itemId: I.p1621, quantity: 1, batchId: bB },
  ] });
  await BATCH.setBatchStatus(db, c, await batchByCode(db, 'RSV-1621-H'), { status: 'on_hold', note: 'reserve_batch_test' });

  // PL-16X2300X12100: far more than needed.
  await receipt(c, db, '2026-09-02', A.sto, [{ itemId: I.p1641, quantity: 100, batch: { code: 'RSV-1641-A' } }]);
  // PL-16X2300X6500: two small batches, in two areas.
  await receipt(c, db, '2026-09-03', A.sto, [{ itemId: I.p1624, quantity: 0.5, batch: { code: 'RSV-1624-A' } }]);
  await receipt(c, db, '2026-09-04', A.wip, [{ itemId: I.p1624, quantity: 0.3, batch: { code: 'RSV-1624-B' } }]);
  // PL-12X2250X12050: quarantine only.
  await receipt(c, db, '2026-09-05', A.qua, [{ itemId: I.p3003, quantity: 50, batch: { code: 'RSV-3003-Q' } }]);
  // PL-16X1600X12350: a rejected batch and a small good one.
  await receipt(c, db, '2026-08-01', A.sto, [{ itemId: I.p1643, quantity: 10, batch: { code: 'RSV-1643-R' } }]);
  await receipt(c, db, '2026-09-06', A.sto, [{ itemId: I.p1643, quantity: 1, batch: { code: 'RSV-1643-A' } }]);
  await BATCH.setBatchStatus(db, c, await batchByCode(db, 'RSV-1643-R'), { status: 'rejected', note: 'reserve_batch_test' });
  // PL-16X2000X8000: more than the one plate wanted, in two batches.
  await receipt(c, db, '2026-09-07', A.sto, [{ itemId: I.p1625, quantity: 1, batch: { code: 'RSV-1625-A' } }]);
  await receipt(c, db, '2026-09-08', A.wip, [{ itemId: I.p1625, quantity: 0.87434, batch: { code: 'RSV-1625-B' } }]);
  // PL-25X1750X10850: 8 plates wanted, 3 already on hand.
  await receipt(c, db, '2026-09-09', A.sto, [{ itemId: I.p3005, quantity: 4, batch: { code: 'RSV-3005-A' } }]);
  // STUD-001: counted by quantity — 8 × 1,803 wanted, 8,000 on hand over two areas.
  await receipt(c, db, '2026-09-09', A.sto, [{ itemId: I.stud, quantity: 5000 }]);
  await receipt(c, db, '2026-09-11', A.wip, [{ itemId: I.stud, quantity: 3000 }]);
}

/** A service call whose outcome (not its tracker) goes into the snapshot. */
async function outcome(fn) {
  try { await fn(); return { ok: true }; } catch (e) { return { ok: false, code: e.code ?? null, message: e.message }; }
}

// --- the run ----------------------------------------------------------------------

const conn = await pool.getConnection();
let exitCode = 0;
try {
  const before = await census(conn);
  await conn.beginTransaction();
  attachNodeCache(conn);
  const [[user]] = await conn.query('SELECT id FROM users WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [COMPANY]);
  const c = { companyId: COMPANY, userId: user?.id ?? null };
  const [[line]] = await conn.query(
    `SELECT l.id, l.line_no, l.locked_at, l.order_id, o.code AS order_code, o.status
       FROM cf_sales_order_lines l JOIN cf_sales_orders o ON o.id = l.order_id WHERE l.company_id = ? AND l.id = ?`,
    [COMPANY, LINE],
  );
  if (!line) throw new Error(`Line ${LINE} is not a line of company ${COMPANY}.`);
  if (await REL.liveReleaseOfLine(conn, COMPANY, LINE)) throw new Error(`Line ${LINE} is already released — this test releases it itself.`);

  console.log(`\nCompany ${COMPANY}, ${line.order_code} line ${line.line_no} (${LINE})`);
  if (!line.locked_at) await LOCK.lockLine(conn, c, LINE);
  if (line.status !== 'confirmed') {
    await conn.query("UPDATE cf_sales_orders SET committed_date = COALESCE(committed_date, '2026-12-31') WHERE company_id = ? AND id = ?", [COMPANY, line.order_id]);
    await SO.setOrderStatus(conn, c, line.order_id, 'confirmed');
  }
  let check = await REL.releaseCheck(conn, COMPANY, LINE);
  if (check.needsFinishedArea && !check.areas.some((a) => a.purpose === 'dispatch')) {
    await AREAS.createArea(conn, c, { code: 'RSV-DSP', name: 'Reserve batch test dispatch', purpose: 'dispatch' });
    check = await REL.releaseCheck(conn, COMPANY, LINE);
  }
  if (!check.ok) throw new Error(`The line cannot be released: ${check.problems.slice(0, 5).join(' | ')}`);
  const input = check.needsFinishedArea ? { finishedAreaId: check.areas.find((a) => a.purpose === 'dispatch')?.id } : {};
  const released = await REL.releaseLine(conn, c, LINE, input);
  const releaseId = released.id;
  const keys = await keysOf(conn, releaseId);
  console.log(`  released inside the transaction: ${released.items.length} items, ${keys.reqKey.size} requirements`);

  // Areas and stock, through the services.
  const mk = async (code, purpose) => (await AREAS.createArea(conn, c, { code, name: `Reserve batch test ${purpose}`, purpose })).id;
  const A = { sto: await mk('RSV-STO', 'storage'), wip: await mk('RSV-WIP', 'wip'), qua: await mk('RSV-QUA', 'quarantine') };
  const I = {
    p1621: await itemByCode(conn, 'PL-12X2500X12100-E350BO'), p1641: await itemByCode(conn, 'PL-16X2300X12100-E350BR'),
    p1624: await itemByCode(conn, 'PL-16X2300X6500-E350BO'), p3003: await itemByCode(conn, 'PL-12X2250X12050-E350BO'),
    p1643: await itemByCode(conn, 'PL-16X1600X12350-E350BO'), p1625: await itemByCode(conn, 'PL-16X2000X8000-E350BO'),
    p3005: await itemByCode(conn, 'PL-25X1750X10850-E350BO'), stud: await itemByCode(conn, 'STUD-001'),
    p1722: await itemByCode(conn, 'PL-32X2150X12500-E350BO'),
  };
  const seeded = Object.values(I);
  await seedStock(conn, c, A, I);
  ok('the stock ledger and balances agree after seeding', (await STOCK.checkLedger(conn, COMPANY)).ok);

  const [reqRows] = await conn.query('SELECT id, item_id, quantity FROM cf_material_requirements WHERE release_id = ? ORDER BY id', [releaseId]);
  const reqsOf = (itemId) => reqRows.filter((q) => q.item_id === itemId);
  const [[{ since }]] = await conn.query('SELECT COALESCE(MAX(id), 0) AS since FROM cf_stock_reservations');

  // Some requirements already partly / wholly covered, one at a time.
  const pre = [];
  const q1621 = reqsOf(I.p1621);
  const q1641 = reqsOf(I.p1641);
  pre.push(await outcome(() => REL.reserveRequirement(conn, c, q1621[5].id, { quantity: 0.01 })));             // partly, oldest batch
  pre.push(await outcome(async () => REL.reserveRequirement(conn, c, q1621[7].id, { batchId: await batchByCode(conn, 'RSV-1621-H') })));   // on hold: NOT_FREE
  pre.push(await outcome(async () => REL.reserveRequirement(conn, c, q1621[8].id, { batchId: await batchByCode(conn, 'RSV-1621-B') })));
  pre.push(await outcome(() => REL.reserveRequirement(conn, c, q1641[3].id)));                                   // wholly
  const stud = reqsOf(I.stud);
  pre.push(await outcome(() => REL.reserveRequirement(conn, c, stud[2].id, { quantity: 1000 })));                // counted item, partly

  // Scenario 1 — the counted run.
  let snap1;
  {
    const { db, tally } = counting(conn);
    const t0 = Date.now();
    const out = await REL.reserveRelease(db, c, releaseId);
    const ms = Date.now() - t0;
    console.log(`\n  scenario 1 reserve all: ${tally.n} round trips, ${ms} ms (${out.reserved} requirements got stock, ${out.short.length} items short)\n`);
    ok(`scenario 1: reserve all takes at most ${MAX_TRIPS} round trips (took ${tally.n})`, tally.n <= MAX_TRIPS);
    snap1 = await snapshot(conn, releaseId, keys, since, seeded, out);
    snap1.pre = pre;
    ok('scenario 1: some requirements got stock', out.reserved > 0);
    ok('scenario 1: some items are short', out.short.length > 0);
  }

  // Between the runs: newer facts on the shelf.
  const between = [];
  between.push(await outcome(() => receipt(c, conn, '2026-07-01', A.sto, [{ itemId: I.p1621, quantity: 2, batch: { code: 'RSV-1621-OLD' } }])));
  between.push(await outcome(() => receipt(c, conn, '2026-09-20', A.wip, [{ itemId: I.p1722, quantity: 0.2, batch: { code: 'RSV-1722-A' } }])));
  const [[firstRes]] = await conn.query("SELECT id FROM cf_stock_reservations WHERE id > ? AND item_id = ? AND status = 'active' ORDER BY id LIMIT 1 OFFSET 3", [since, I.p1624]);
  if (firstRes) between.push(await outcome(() => REL.releaseReservation(conn, c, firstRes.id)));
  between.push(await outcome(() => REL.issueRequirement(conn, c, q1641[0].id)));
  between.push(await outcome(() => REL.reserveRequirement(conn, c, q1641[0].id)));                               // already covered: issued
  const q1643 = reqsOf(I.p1643);
  const shortOne = q1643[q1643.length - 1];                                                                        // short after scenario 1
  between.push(await outcome(() => REL.reserveRequirement(conn, c, shortOne.id, { quantity: 5 })));              // TOO_MANY
  between.push(await outcome(() => REL.reserveRequirement(conn, c, shortOne.id, { quantity: -1 })));             // INVALID
  between.push(await outcome(() => REL.reserveRequirement(conn, c, reqsOf(I.p1722)[0].id, { quantity: 0.001 }))); // the new batch, partly
  between.push(await outcome(() => REL.reserveRequirement(conn, c, reqsOf(I.p3003)[0].id)));                     // quarantine only: NOT_FREE
  between.push(await outcome(async () => REL.reserveRequirement(conn, c, shortOne.id, { batchId: await batchByCode(conn, 'RSV-1643-R') })));           // rejected batch
  ok('the stock ledger and balances agree between the runs', (await STOCK.checkLedger(conn, COMPANY)).ok);

  // Scenario 2 — "reserve all" on top of the first.
  let snap2;
  {
    const { db, tally } = counting(conn);
    const t0 = Date.now();
    const out = await REL.reserveRelease(db, c, releaseId);
    const ms = Date.now() - t0;
    console.log(`\n  scenario 2 reserve all again: ${tally.n} round trips, ${ms} ms (${out.reserved} requirements got stock, ${out.short.length} items short)\n`);
    ok(`scenario 2: reserve all takes at most ${MAX_TRIPS} round trips (took ${tally.n})`, tally.n <= MAX_TRIPS);
    snap2 = await snapshot(conn, releaseId, keys, since, seeded, out);
    snap2.between = between;
    ok('scenario 2: the new batch was reserved', snap2.reservations.some((v) => v.batch_code === 'RSV-1621-OLD'));
  }
  ok('the stock ledger and balances agree at the end', (await STOCK.checkLedger(conn, COMPANY)).ok);

  const snap = { scenario1: snap1, scenario2: snap2 };
  if (SAVE) {
    fs.writeFileSync(SAVE, JSON.stringify(snap));
    console.log(`  snapshot saved to ${SAVE} (${snap1.reservations.length} + ${snap2.reservations.length} reservation rows)`);
  }
  if (CHECK) {
    const golden = JSON.parse(fs.readFileSync(CHECK, 'utf8'));
    const got = JSON.parse(JSON.stringify(snap));
    for (const sc of Object.keys(golden)) {
      for (const part of Object.keys(golden[sc])) {
        ok(`${sc}/${part} identical to the snapshot`, JSON.stringify(golden[sc][part]) === JSON.stringify(got[sc]?.[part]));
      }
    }
    const diff = differences(golden, got);
    if (diff.length) console.log(`  first differences (golden vs now):\n    ${diff.join('\n    ')}`);
  }

  await conn.rollback();
  detachNodeCache(conn);
  const after = await census(conn);
  const moved = Object.keys(before).filter((t) => before[t] !== after[t]);
  ok('every cf_ table is back to its count', moved.length === 0);
  if (moved.length) console.log(`    moved: ${moved.map((t) => `${t} ${before[t]} -> ${after[t]}`).join(', ')}`);
} catch (err) {
  try { await conn.rollback(); } catch { /* the error below is the one that matters */ }
  console.error(`\nERROR: ${err.message}${err.problems?.length ? `\n  ${err.problems.slice(0, 10).join('\n  ')}` : ''}`);
  exitCode = 1;
} finally {
  conn.release();
  await pool.end();
}
console.log(`\n${passed} passed, ${failed} failed${fails.length ? `\n  ${fails.join('\n  ')}` : ''}`);
process.exitCode = exitCode || (failed ? 1 : 0);
