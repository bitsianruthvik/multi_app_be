/**
 * release_batch_test.mjs — how many round trips releasing the KEPL line costs,
 * and a golden snapshot of everything release writes, so a rewrite of the
 * write path (releaseService.releaseLine) is PROVED to write the same thing.
 * Against the local database.
 *
 *   cd multi_app_be
 *   node scripts/cf_kepl/release_batch_test.mjs --save  <file>    # capture the snapshot
 *   node scripts/cf_kepl/release_batch_test.mjs --check <file>    # compare with it
 *   node scripts/cf_kepl/release_batch_test.mjs                   # counts only
 *
 *   CF_BATCH_COMPANY (2), CF_BATCH_LINE (923 — the local KEPL copy, 6,072 pieces)
 *   CF_BATCH_MAX_TRIPS (100) — the most round trips release may take
 *
 * EVERYTHING HAPPENS INSIDE ONE TRANSACTION THAT IS ROLLED BACK, and the last
 * thing it does is re-count every cf_ table and prove each is back where it
 * started.
 *
 * Unlike the other suites it BORROWS its data on purpose: the point is the
 * real 6,072-piece line. Inside the transaction the line is locked
 * (lockService.lockLine, every check it makes — as cf_lock_nested_lines.mjs
 * does), its order confirmed, and the line released through a query-counting
 * proxy. If the line is already locked or released it says so and stops.
 *
 * The snapshot is every row release wrote — the release, its production items,
 * steps, step dependencies, material requirements and reservations, all columns
 * — and the tracker releaseLine returns, with every id release made replaced by
 * a stable key: an item is `I<sort_order>`, a step `S<sort_order>:<flow_step_id>`,
 * a requirement `Q<n>` in id order. Timestamps are dropped. Rows are in the
 * order the tracker reads them (items by sort_order, steps by sequence then id
 * within their item, dependencies and requirements by id), so an order change
 * the tracker would show is a difference too.
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

const COMPANY = Number(process.env.CF_BATCH_COMPANY ?? 2);
const LINE = Number(process.env.CF_BATCH_LINE ?? 923);
const MAX_TRIPS = Number(process.env.CF_BATCH_MAX_TRIPS ?? 100);
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
        if (process.env.CF_BATCH_TRACE) console.log(`    ${String(tally.n).padStart(4)}  ${String(args[0]?.sql ?? args[0]).replace(/\s+/g, ' ').slice(0, 110)}`);
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

async function snapshot(db, releaseId, returned) {
  const [[release]] = await db.query('SELECT * FROM cf_production_releases WHERE id = ?', [releaseId]);
  const [items] = await db.query('SELECT * FROM cf_production_items WHERE release_id = ? ORDER BY sort_order', [releaseId]);
  const itemKey = new Map(items.map((x) => [x.id, `I${x.sort_order}`]));
  // The locked piece an item is, by its path key — lock wrote those rows inside this run too.
  const [locked] = await db.query('SELECT id, path_key FROM cf_order_pieces WHERE order_line_id = ? AND deleted_at IS NULL', [release.order_line_id]);
  const pieceKey = new Map(locked.map((p) => [p.id, `P:${p.path_key}`]));
  const [steps] = await db.query(
    `SELECT s.*, pi.sort_order AS item_sort FROM cf_production_steps s JOIN cf_production_items pi ON pi.id = s.production_item_id
      WHERE pi.release_id = ? ORDER BY pi.sort_order, s.sequence, s.id`,
    [releaseId],
  );
  const stepKey = new Map(steps.map((s) => [s.id, `S${s.item_sort}:${s.flow_step_id}`]));
  const [deps] = await db.query(
    `SELECT d.* FROM cf_step_dependencies d JOIN cf_production_steps s ON s.id = d.step_id JOIN cf_production_items pi ON pi.id = s.production_item_id
      WHERE pi.release_id = ? ORDER BY d.id`,
    [releaseId],
  );
  const [reqs] = await db.query('SELECT * FROM cf_material_requirements WHERE release_id = ? ORDER BY id', [releaseId]);
  const reqKey = new Map(reqs.map((q, i) => [q.id, `Q${i + 1}`]));
  const [reservations] = reqs.length
    ? await db.query('SELECT * FROM cf_stock_reservations WHERE requirement_id IN (?) ORDER BY id', [reqs.map((q) => q.id)])
    : [[]];

  const miss = (map, id, what) => {
    if (id == null) return null;
    const k = map.get(id);
    if (!k) throw new Error(`snapshot: ${what} ${id} is not one release wrote`);
    return k;
  };
  // Within an item, steps must come back in the order the tracker reads them.
  const rankInItem = new Map();
  const seenOf = new Map();
  for (const s of steps) { const n = (seenOf.get(s.production_item_id) ?? 0) + 1; seenOf.set(s.production_item_id, n); rankInItem.set(s.id, n); }

  const normaliseReturn = (rel) => ({
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
      reservations: q.reservations.map((v) => ({ ...v, id: 'V' })),
    })),
  });

  return {
    release: { ...strip(release, ['id', 'finished_area_id']), finishedArea: returned.finishedArea?.code ?? null },
    items: items.map((x) => ({
      ...strip(x, ['id', 'release_id', 'parent_id', 'order_piece_id']),
      parent: miss(itemKey, x.parent_id, 'parent'), orderPiece: miss(pieceKey, x.order_piece_id, 'locked piece'),
    })),
    steps: steps.map((s) => ({ ...strip(s, ['id', 'production_item_id', 'item_sort']), item: `I${s.item_sort}`, key: stepKey.get(s.id), rank: rankInItem.get(s.id) })),
    deps: deps.map((d) => ({
      ...strip(d, ['id', 'step_id', 'target_step_id', 'target_item_id']),
      step: miss(stepKey, d.step_id, 'step'), targetStep: miss(stepKey, d.target_step_id, 'step'), targetItem: miss(itemKey, d.target_item_id, 'item'),
    })),
    reqs: reqs.map((q) => ({
      ...strip(q, ['id', 'release_id', 'production_item_id', 'step_id']),
      item: miss(itemKey, q.production_item_id, 'item'), step: miss(stepKey, q.step_id, 'step'),
    })),
    reservations: reservations.map((v) => ({ ...strip(v, ['id', 'requirement_id']), requirement: reqKey.get(v.requirement_id) })),
    returned: normaliseReturn(returned),
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
  if (await REL.liveReleaseOfLine(conn, COMPANY, LINE)) throw new Error(`Line ${LINE} is already released — nothing to measure.`);

  console.log(`\nCompany ${COMPANY}, ${line.order_code} line ${line.line_no} (${LINE})`);
  if (!line.locked_at) {
    const t = Date.now();
    await LOCK.lockLine(conn, c, LINE);
    console.log(`  locked inside the transaction (${Date.now() - t} ms)`);
  }
  if (line.status !== 'confirmed') {
    // Confirm asks for a committed date; a fixed one, so the snapshot does not drift by the day.
    await conn.query("UPDATE cf_sales_orders SET committed_date = COALESCE(committed_date, '2026-12-31') WHERE company_id = ? AND id = ?", [COMPANY, line.order_id]);
    await SO.setOrderStatus(conn, c, line.order_id, 'confirmed');
    console.log(`  order ${line.order_code} confirmed inside the transaction (was ${line.status})`);
  }
  let check = await REL.releaseCheck(conn, COMPANY, LINE);
  if (check.needsFinishedArea && !check.areas.some((a) => a.purpose === 'dispatch')) {
    await AREAS.createArea(conn, c, { code: 'RBT-DSP', name: 'Release batch test dispatch', purpose: 'dispatch' });
    console.log('  a dispatch area made inside the transaction (the company has none)');
    check = await REL.releaseCheck(conn, COMPANY, LINE);
  }
  if (!check.ok) throw new Error(`The line cannot be released: ${check.problems.slice(0, 5).join(' | ')}`);
  const input = check.needsFinishedArea ? { finishedAreaId: check.areas.find((a) => a.purpose === 'dispatch')?.id } : {};
  console.log(`  will write ${check.summary.pieces} pieces + ${check.summary.groups} groups, ${check.summary.steps} steps, ${check.summary.waits} waits, ${check.summary.requirements} requirements`);

  const { db, tally } = counting(conn);
  const t0 = Date.now();
  const rel = await REL.releaseLine(db, c, LINE, input);
  const ms = Date.now() - t0;
  console.log(`\n  release: ${tally.n} round trips, ${ms} ms (${rel.items.length} items)\n`);

  const snap = await snapshot(conn, rel.id, rel);
  ok(`release takes at most ${MAX_TRIPS} round trips (took ${tally.n})`, tally.n <= MAX_TRIPS);
  ok('every node the check counted was written', snap.items.length === check.summary.pieces + check.summary.groups);
  ok('every step the check counted was written', snap.steps.length === check.summary.steps);
  ok('every requirement the check counted was written', snap.reqs.length === check.summary.requirements);
  ok('the tracker returned is the one written', rel.items.length === snap.items.length);
  ok('sort_order is 1..n with no gaps', snap.items.every((x, i) => x.sort_order === i + 1));
  if (SAVE) {
    fs.writeFileSync(SAVE, JSON.stringify(snap));
    console.log(`  snapshot saved to ${SAVE} (${snap.items.length} items, ${snap.steps.length} steps, ${snap.deps.length} deps, ${snap.reqs.length} requirements)`);
  }
  if (CHECK) {
    const golden = JSON.parse(fs.readFileSync(CHECK, 'utf8'));
    const got = JSON.parse(JSON.stringify(snap));
    const diff = differences(golden, got);
    for (const part of Object.keys(golden)) {
      ok(`${part} identical to the snapshot`, JSON.stringify(golden[part]) === JSON.stringify(got[part]));
    }
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
