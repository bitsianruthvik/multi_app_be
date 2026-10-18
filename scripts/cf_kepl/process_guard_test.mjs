/**
 * process_guard_test.mjs — one request must not take the server down (core/utils/processGuard.js, 2026-10-18).
 *
 *   cd multi_app_be && node scripts/cf_kepl/process_guard_test.mjs        (no database)
 *
 * Production 2026-10-18 07:36–07:39 UTC: the instance went with nothing in the log. The guard names what was
 * running, bounds the large bodies, survives stray exceptions and drains on SIGTERM. A real express app on a free
 * port, a fake logger and a fake exit:
 *   1  requests in flight are listed while they run and gone when they end
 *   2  a request still running past the slow mark is logged once, by path
 *   3  an event-loop stall is logged with the request that caused it
 *   4  large bodies: one at a time (the second gets a 503 in words), none when memory is short; small ones pass
 *   5  memory high is logged (once a minute) with the requests in flight; the peak is kept
 *   6  uncaught exceptions: logged, the server keeps serving; too many in a minute → drain and exit(1)
 *   7  SIGTERM: new requests refused, the running one FINISHES, then exit(0)
 *   8  server timeouts: keep-alive 65 s, headers 66 s, requests 10 min
 *   9  a real process with the guard: a throw in a timer does not end it; it still answers
 */
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import express from 'express';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { createProcessGuard } = await imp('core/utils/processGuard.js');

let pass = 0, failed = 0;
const ok = (label, cond) => { if (cond) pass += 1; else { failed += 1; console.error('FAIL', label); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MB = 1048576;

function fakeLog() {
  const lines = [];
  const at = (level) => (obj, msg) => lines.push({ level, msg: typeof obj === 'string' ? obj : msg, obj: typeof obj === 'object' ? obj : {} });
  return { lines, info: at('info'), warn: at('warn'), error: at('error'), fatal: at('fatal'), has: (re) => lines.find((l) => re.test(l.msg ?? '')) };
}

function request(port, method, p, body) {
  return new Promise((resolve) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: data ? { 'content-type': 'application/json', 'content-length': data.length } : {} }, (res) => {
      let s = '';
      res.on('data', (d) => { s += d; });
      res.on('end', () => { let j = null; try { j = JSON.parse(s); } catch { /* text */ } resolve({ status: res.statusCode, body: j }); });
    });
    req.on('error', (e) => resolve({ status: 0, error: e.code }));
    if (data) req.write(data);
    req.end();
  });
}

async function makeApp(guard) {
  const app = express();
  app.use(guard.track);
  app.use(express.json({ limit: '50mb' }));
  app.get('/fast', (req, res) => res.json({ ok: true }));
  app.get('/slow', async (req, res) => { await sleep(Number(req.query.ms ?? 400)); res.json({ ok: true }); });
  app.post('/upload', async (req, res) => { await sleep(Number(req.query.ms ?? 300)); res.json({ got: String(req.body?.blob ?? '').length }); });
  app.get('/block', (req, res) => { const t = Date.now(); while (Date.now() - t < 600) { /* synchronous work */ } res.json({ ok: true }); });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  guard.attachServer(server);
  return { server, port: server.address().port };
}

// ---------------------------------------------------------------------------------------------------------------
let mem = { rss: 100 * MB, heapUsed: 50 * MB, external: 1 * MB };
const log = fakeLog();
const exits = [];
const guard = createProcessGuard({
  logger: log, exit: (c) => exits.push(c), memoryUsage: () => mem,
  settings: { slowMs: 150, stallMs: 300, memoryLimit: 512 * MB, bigBodyBytes: 1024, bigBodies: 1, fatalLimit: 3, drainMs: 3000, sampleMs: 100000 },
});
guard.start({ processHandlers: false });
const { server, port } = await makeApp(guard);

// 1
{
  const p = request(port, 'GET', '/slow?ms=400');
  await sleep(120);
  const snap = guard.snapshot();
  ok('1 a running request is listed in flight', snap.some((r) => r.path === '/slow' && r.method === 'GET'));
  await p;
  await sleep(20);
  ok('1 … and gone when it ends', guard.snapshot().length === 0);
}
// 2
{
  const mark = log.lines.length;
  const p = request(port, 'GET', '/slow?ms=400');
  await sleep(250);
  guard.checkSlow(); guard.checkSlow();
  await p;
  const slow = log.lines.slice(mark).filter((l) => /still running/.test(l.msg ?? ''));
  ok('2 a request past the slow mark is logged by path', slow.length === 1 && slow[0].obj.path === '/slow' && slow[0].obj.ms >= 150);
}
// 3
{
  const before = log.lines.length;
  const p = request(port, 'GET', '/block');
  await p;
  await sleep(400);
  const stall = log.lines.slice(before).find((l) => /event loop was blocked/.test(l.msg ?? ''));
  ok('3 an event-loop stall is logged', !!stall && stall.obj.stallMs >= 300);
  ok('3 … naming the request that held the loop', !!stall && (stall.obj.inflight ?? []).some((r) => r.path === '/block'));
  ok('3 … counted for /health', guard.health().stalls >= 1 && guard.health().lastStall?.ms >= 300);
}
// 4
{
  const big = { blob: 'x'.repeat(4096) };
  const a = request(port, 'POST', '/upload?ms=400', big);
  await sleep(80);
  const b = await request(port, 'POST', '/upload?ms=10', big);
  ok('4 a second large body while one is being taken: 503 in words', b.status === 503 && b.body?.code === 'BUSY_LARGE' && /another large upload/.test(b.body?.message ?? ''));
  const small = await request(port, 'POST', '/upload?ms=10', { blob: 'x' });
  ok('4 a small body passes meanwhile', small.status === 200 && small.body?.got === 1);
  const ra = await a;
  ok('4 the first large body is served', ra.status === 200 && ra.body?.got === 4096);
  const c = await request(port, 'POST', '/upload?ms=10', big);
  ok('4 once it is done the next large body is taken', c.status === 200);
  mem = { ...mem, rss: 460 * MB };
  const d = await request(port, 'POST', '/upload?ms=10', big);
  ok('4 memory above 85 %: a large body is turned away', d.status === 503 && /short of memory/.test(d.body?.message ?? ''));
  const e = await request(port, 'POST', '/upload?ms=10', { blob: 'y' });
  ok('4 … a small one still passes', e.status === 200);
  mem = { ...mem, rss: 100 * MB };
  ok('4 refusals counted', guard.health().bigRefused === 2);
}
// 5
{
  mem = { ...mem, rss: 400 * MB };
  const before = log.lines.filter((l) => /memory high/.test(l.msg ?? '')).length;
  guard.checkMemory(); guard.checkMemory();
  const after = log.lines.filter((l) => /memory high/.test(l.msg ?? ''));
  ok('5 memory high is logged once a minute at most', after.length === before + 1 && after.at(-1).obj.rssMb === 400);
  ok('5 the peak is kept', guard.health().peakRssMb === 400);
  mem = { ...mem, rss: 100 * MB };
}
// 6
{
  guard.onException(new Error('boom 1'));
  guard.onRejection(new Error('a promise nobody awaited'));
  const r = await request(port, 'GET', '/fast');
  ok('6 after an uncaught exception the server keeps serving', r.status === 200 && exits.length === 0);
  ok('6 … it is logged FATAL with what was running', !!log.lines.find((l) => l.level === 'fatal' && /Uncaught exception/.test(l.msg)));
  ok('6 an unhandled rejection is logged and counted', guard.health().rejections === 1 && !!log.has(/Unhandled rejection/));
}
// 7  (the same guard: the third uncaught exception in a minute drains and exits 1 — tested on a second guard so 7 is clean)
{
  const log2 = fakeLog();
  const exits2 = [];
  const g2 = createProcessGuard({ logger: log2, exit: (c) => exits2.push(c), memoryUsage: () => mem, settings: { fatalLimit: 3, drainMs: 2000, sampleMs: 100000 } });
  g2.start({ processHandlers: false });
  const s2 = await makeApp(g2);
  const running = request(s2.port, 'GET', '/slow?ms=500');
  await sleep(80);
  g2.onException(new Error('a')); g2.onException(new Error('b'));
  ok('6 two in a minute: still serving', !g2.draining);
  g2.onException(new Error('c'));
  ok('6 the third in a minute: draining', g2.draining && !!log2.has(/too many uncaught/));
  const refused = await request(s2.port, 'GET', '/fast');
  ok('6 … a new request is refused or not accepted while draining', refused.status === 503 || refused.status === 0);
  const r = await running;
  ok('6 … the running request still finishes', r.status === 200);
  await sleep(300);
  ok('6 … then exit(1)', exits2.length === 1 && exits2[0] === 1);
  g2.stop();
  s2.server.close();
}
{
  const log3 = fakeLog();
  const exits3 = [];
  let closed = false;
  const g3 = createProcessGuard({ logger: log3, exit: (c) => exits3.push(c), memoryUsage: () => mem, beforeExit: () => { closed = true; }, settings: { drainMs: 3000, sampleMs: 100000 } });
  g3.start({ processHandlers: false });
  const s3 = await makeApp(g3);
  const running = request(s3.port, 'GET', '/slow?ms=700');
  await sleep(100);
  g3.shutdown('SIGTERM');
  const sd = log3.has(/shutting down/);
  ok('7 SIGTERM is logged with the requests in flight', !!sd && sd.obj.signal === 'SIGTERM' && sd.obj.inflight.some((x) => x.path === '/slow'));
  await sleep(50);
  ok('7 … no exit while a request is running', exits3.length === 0);
  const r = await running;
  ok('7 … the running request FINISHES (a save is not cut off half way)', r.status === 200);
  await sleep(300);
  ok('7 … then exit(0), after the pool is closed', exits3.length === 1 && exits3[0] === 0 && closed);
  ok('7 … "drained" logged', !!log3.has(/drained/));
  g3.stop();
}
// 8
ok('8 keep-alive 65 s, headers 66 s, requests 10 min', server.keepAliveTimeout === 65000 && server.headersTimeout === 66000 && server.requestTimeout === 600000);

guard.stop();
server.close();

// 9  a real process: guard.start() with its process handlers; a throw in a timer must not end it.
{
  const child = `
    import express from 'express';
    import { pathToFileURL } from 'node:url';
    const { createProcessGuard } = await import(pathToFileURL(${JSON.stringify(path.join(BE, 'core/utils/processGuard.js'))}).href);
    const g = createProcessGuard({ settings: { sampleMs: 100000 } });
    g.start();
    const app = express(); app.use(g.track);
    app.get('/boom', (req, res) => { setTimeout(() => { throw new Error('thrown outside any request chain'); }, 10); Promise.reject(new Error('nobody awaits this')); res.json({ ok: true }); });
    app.get('/ok', (req, res) => res.json({ alive: true, uncaught: g.health().uncaught, rejections: g.health().rejections }));
    const s = app.listen(0, '127.0.0.1', () => console.log('PORT ' + s.address().port));
  `;
  const proc = spawn(process.execPath, ['--input-type=module', '-e', child], { cwd: BE, env: { ...process.env, LOG_LEVEL: 'silent' } });
  let out = '';
  proc.stdout.on('data', (d) => { out += d; });
  for (let i = 0; i < 100 && !/PORT \d+/.test(out); i += 1) await sleep(50);
  const cport = Number(/PORT (\d+)/.exec(out)?.[1]);
  const b = await request(cport, 'GET', '/boom');
  await sleep(200);
  const a = await request(cport, 'GET', '/ok');
  ok('9 a throw in a timer and an unawaited rejection do not end the process', b.status === 200 && a.status === 200 && a.body?.alive === true);
  ok('9 … both were seen by the guard', a.body?.uncaught === 1 && a.body?.rejections === 1);
  const exited = new Promise((r) => proc.once('exit', (code) => r(code)));
  proc.kill('SIGTERM');
  const code = await Promise.race([exited, sleep(5000).then(() => 'timeout')]);
  ok(`9 SIGTERM: the process drains and exits cleanly (exit ${code})`, code === 0 || (process.platform === 'win32' && code === null));
}

console.log(`process_guard_test: ${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
