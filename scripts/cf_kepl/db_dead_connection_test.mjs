/**
 * db_dead_connection_test.mjs — a pooled connection the SERVER has already closed (2026-10-18).
 *
 *   cd multi_app_be && node scripts/cf_kepl/db_dead_connection_test.mjs        (local DB only; writes nothing)
 *
 * Production, 2026-10-18 13:16 UTC: "Record payment" for SO260014 opened on "Something went wrong" —
 * GET /accounts/orders/690001/payments → 500 "Connection lost: The server closed the connection." at
 * billingService.billingFacts (a Promise.all of seven reads); 200 twelve seconds later. Same error twice that week on
 * the classification tree. TiDB Cloud's gateway hangs up on pooled connections and mysql2 can hand one out in the
 * moment before it notices.
 *
 * The race is made here on purpose: the pool's next connection is KILLed by another session before it is handed
 * out (the server closes it — what TiDB's gateway did). Then:
 *   1  isReadOnlySql: which statements may be sent again
 *   2  the real driver error of a killed connection counts as a dead connection
 *   3  pool.query / pool.execute of a READ on that connection: answered (sent again on another connection)
 *   4  a WRITE on it: NOT sent again — the error reaches the caller
 *   5  pool.getConnection (transactions): the dead one is dropped, a live one returned; cf_erp withTransaction runs
 *   6  receiptService.orderPayments (the screen's read) answers through the race
 *   7  translateDbError → 503 DB_CONNECTION_LOST with words; fail() sends those words (not "Something went wrong")
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool, isDeadConnection, isReadOnlySql, withReadRetry, guardCoreGetConnection } = await imp('db.js');
if (!/^(localhost|127\.0\.0\.1)$/.test(process.env.DB_HOST || 'localhost')) { console.error('Local database only.'); process.exit(1); }
const { withTransaction } = await imp('apps/cf_erp/lib/db.js');
const { translateDbError } = await imp('apps/cf_erp/lib/errors.js');
const { fail: failResponse } = await imp('core/middleware/requirePerm.js');
const { orderPayments } = await imp('apps/cf_erp/services/receiptService.js');

let pass = 0, failed = 0;
const ok = (label, cond) => { if (cond) pass += 1; else { failed += 1; console.error('FAIL', label); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const core = pool.pool;
const counts = { handedDead: 0, driverThrows: 0 };
// mysql2 3.15: pool.query on a connection already in the closed state rejects the query, then throws a TypeError
// from its own callback. Production's index.js logs uncaught exceptions and keeps serving; here they are counted.
process.on('uncaughtException', (e) => {
  if (e instanceof TypeError && /reading 'once'/.test(e.message)) { counts.driverThrows += 1; return; }
  console.error('UNCAUGHT', e); process.exit(1);
});

/** The pool's NEXT connection is killed by the server just before it is handed out. */
function poisonNext(n = 1) {
  const original = core.getConnection;
  let left = n;
  core.getConnection = function (cb) {
    if (left <= 0) return original.call(this, cb);
    left -= 1;
    return original.call(this, (err, conn) => {
      if (err) return cb(err);
      const killer = pool.pool.config.connectionConfig;
      // Another session kills it — the server hangs up, as TiDB's gateway did.
      import('mysql2').then(async ({ default: mysql }) => {
        const k = mysql.createConnection({ host: killer.host, port: killer.port, user: killer.user, password: killer.password, database: killer.database });
        k.query(`KILL ${conn.threadId}`, async () => {
          k.end();
          for (let i = 0; i < 50 && !(conn._closing || conn._fatalError || conn.stream?.destroyed); i += 1) await sleep(10);
          counts.handedDead += 1;
          cb(null, conn);
        });
      });
    });
  };
  return () => { core.getConnection = original; };
}

// 1 ------------------------------------------------------------------------------------------
ok('SELECT is a read', isReadOnlySql('SELECT 1'));
ok('leading spaces / comments / ( are fine', isReadOnlySql('  /* x */ -- y\n (SELECT 1) UNION (SELECT 2)'));
ok('SHOW / WITH / EXPLAIN are reads', isReadOnlySql('SHOW TABLES') && isReadOnlySql('WITH a AS (SELECT 1) SELECT * FROM a') && isReadOnlySql('EXPLAIN SELECT 1'));
ok('{ sql } objects are read', isReadOnlySql({ sql: 'SELECT 1' }));
ok('INSERT / UPDATE / DELETE are not', !isReadOnlySql('INSERT INTO t VALUES (1)') && !isReadOnlySql('UPDATE t SET a = 1') && !isReadOnlySql('DELETE FROM t'));
ok('SELECT … FOR UPDATE is not', !isReadOnlySql('SELECT * FROM t WHERE id = 1 FOR UPDATE'));
ok('LOCK IN SHARE MODE / GET_LOCK are not', !isReadOnlySql('SELECT * FROM t LOCK IN SHARE MODE') && !isReadOnlySql("SELECT GET_LOCK('x', 1)"));
ok('WITH … UPDATE is not', !isReadOnlySql('WITH a AS (SELECT 1 AS id) UPDATE t JOIN a ON a.id = t.id SET t.x = 1'));
ok('nothing / a number is not', !isReadOnlySql(null) && !isReadOnlySql(42));

// 2 ------------------------------------------------------------------------------------------
{
  const conn = await pool.getConnection();
  const k = await pool.getConnection();
  await k.query(`KILL ${conn.threadId}`);
  k.release();
  for (let i = 0; i < 50 && !(conn.connection._closing || conn.connection._fatalError || conn.connection.stream?.destroyed); i += 1) await sleep(10);
  let err = null;
  try { await conn.query('SELECT 1'); } catch (e) { err = e; }
  ok('a statement on a killed connection fails', !!err);
  ok(`… and counts as a dead connection (${err?.code ?? ''} ${String(err?.message ?? '').slice(0, 60)})`, isDeadConnection(err));
  try { conn.destroy(); } catch { /* gone */ }
  ok('a rejected statement is NOT a dead connection', !isDeadConnection(Object.assign(new Error("Table 'x' doesn't exist"), { code: 'ER_NO_SUCH_TABLE', errno: 1146 })));
}

// 3 ------------------------------------------------------------------------------------------
{
  let undo = poisonNext();
  const before = counts.handedDead;
  const [[row]] = await pool.query('SELECT 41 + 1 AS n');
  undo();
  ok('the race happened (a killed connection was handed out)', counts.handedDead === before + 1);
  ok('pool.query of a READ on it is answered', Number(row?.n) === 42);
  undo = poisonNext();
  const [[row2]] = await pool.execute('SELECT ? + 1 AS n', [9]);
  undo();
  ok('pool.execute of a READ on it is answered', Number(row2?.n) === 10);
  undo = poisonNext(2);
  const [[row3]] = await pool.query('SELECT 7 AS n');
  undo();
  ok('two dead in a row: still answered (third attempt)', Number(row3?.n) === 7);
}

// 3b -----------------------------------------------------------------------------------------
{
  // db.js guards the driver's pool: a connection it can already see is closed is never handed out. Put the guard
  // OVER the poison (in production it sits over the driver's own getConnection) and the dead one is skipped.
  const undoPoison = poisonNext();
  const undoGuard = guardCoreGetConnection(core, { force: true });
  const throwsBefore = counts.driverThrows;
  const before = counts.handedDead;
  const [[row]] = await pool.query('SELECT 3 AS n');
  undoGuard(); undoPoison();
  await sleep(50);
  ok('guard: the killed connection was offered', counts.handedDead === before + 1);
  ok('guard: the read is answered', Number(row?.n) === 3);
  ok('guard: and the driver never threw (it never saw the closed connection)', counts.driverThrows === throwsBefore);
}

// 4 ------------------------------------------------------------------------------------------
{
  await pool.query('CREATE TEMPORARY TABLE IF NOT EXISTS _x (a INT)').catch(() => {});
  const undo = poisonNext();
  let err = null;
  try { await pool.query('UPDATE cf_sales_orders SET title = title WHERE id = -1'); } catch (e) { err = e; }
  undo();
  ok('a WRITE on a dead connection is NOT sent again: the error reaches the caller', !!err && isDeadConnection(err));
  // withReadRetry on a fake: counts the attempts.
  let n = 0;
  const fake = { query: async (sql) => { n += 1; if (n === 1) throw Object.assign(new Error('Connection lost: The server closed the connection.'), { code: 'PROTOCOL_CONNECTION_LOST', fatal: true }); return [[{ ok: sql }]]; } };
  withReadRetry(fake, 'query', { log: { warn() {} } });
  const [[r]] = await fake.query('SELECT 1');
  ok('wrapper: read retried once', n === 2 && r.ok === 'SELECT 1');
  n = 0;
  let werr = null;
  try { await fake.query('INSERT INTO t VALUES (1)'); } catch (e) { werr = e; }
  ok('wrapper: write tried once only', n === 1 && !!werr);
  n = 0;
  const fake2 = { query: async () => { n += 1; throw Object.assign(new Error('bad'), { code: 'ER_PARSE_ERROR' }); } };
  withReadRetry(fake2, 'query', { log: { warn() {} } });
  try { await fake2.query('SELECT bad'); } catch { /* expected */ }
  ok('wrapper: a rejected READ is not retried', n === 1);
}

// 5 ------------------------------------------------------------------------------------------
{
  let undo = poisonNext();
  const conn = await pool.getConnection();
  undo();
  const [[r]] = await conn.query('SELECT 5 AS n');
  conn.release();
  ok('pool.getConnection drops a dead connection and returns a live one', Number(r?.n) === 5);
  undo = poisonNext();
  const out = await withTransaction(async (c) => { const [[x]] = await c.query('SELECT 6 AS n'); return Number(x.n); });
  undo();
  ok('cf_erp withTransaction starts on a live connection', out === 6);
}

// 6 ------------------------------------------------------------------------------------------
{
  const [[o]] = await pool.query('SELECT id, company_id FROM cf_sales_orders WHERE deleted_at IS NULL ORDER BY id DESC LIMIT 1');
  if (o) {
    const undo = poisonNext(2);
    let res = null, err = null;
    try { res = await orderPayments(pool, o.company_id, o.id); } catch (e) { err = e; }
    undo();
    ok(`orderPayments (Record payment's read) answers through dead connections${err ? ` — ${err.message}` : ''}`, !!res && Array.isArray(res.invoices) && !err);
  } else ok('a local order to read payments of', false);
}

// 7 ------------------------------------------------------------------------------------------
{
  const dead = Object.assign(new Error('Connection lost: The server closed the connection.'), { code: 'PROTOCOL_CONNECTION_LOST', fatal: true });
  const t = translateDbError(dead);
  ok('translateDbError: a dead connection is a 503 DB_CONNECTION_LOST', t.status === 503 && t.code === 'DB_CONNECTION_LOST');
  let sent = null, status = null;
  const res = { status(s) { status = s; return this; }, json(b) { sent = b; return this; } };
  const quiet = console.error; // fail() logs the 5xx through pino (stdout), nothing to silence
  failResponse(res, t);
  console.error = quiet;
  ok('fail(): the 503 keeps its words', status === 503 && /database dropped for a moment/.test(sent?.message ?? '') && sent?.code === 'DB_CONNECTION_LOST');
  failResponse(res, new Error('SQL detail that must not leak'));
  ok('fail(): any other 500 still says only "Something went wrong."', status === 500 && sent?.message === 'Something went wrong.');
}

await pool.end();
console.log(`db_dead_connection_test: ${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
