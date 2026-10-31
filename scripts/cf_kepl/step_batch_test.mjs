/**
 * step_batch_test.mjs — "Finish selected" on the Tracker (stepBatchService.finishSteps, 2026-10-31): many floor steps
 * started (if not) and finished with their remaining quantity good, each through the tracker's own startStep /
 * recordProgress, one transaction per step, in the order the waits allow. Against the local database.
 *
 *   cd multi_app_be
 *   node scripts/cf_kepl/step_batch_test.mjs
 *
 *   CF_BATCH_COMPANY (2), CF_BATCH_LINE (923 — the local KEPL copy)
 *   CF_BATCH_MAX_TRIPS_PER_STEP (26) — the most round trips one finished step may cost, the wave reads included
 *   (the WIP lots the production ledger makes for the pieces a cut brings out are counted apart)
 *
 * EVERYTHING HAPPENS INSIDE ONE TRANSACTION THAT IS ROLLED BACK (the line is NEVER left released): it borrows the
 * line as tracker_tree_test does. The per-step transactions are SAVEPOINTs inside it, so a refusal still undoes only
 * its own step. The last thing it does is re-count every cf_ table and prove each is back where it started.
 */
import path from 'path';
import { pathToFileURL } from 'url';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
await imp('apps/cf_erp/services/codegenProvider.js');
const { attachNodeCache } = await imp('apps/cf_erp/lib/db.js');
const REL = await imp('apps/cf_erp/services/releaseService.js');
const LOCK = await imp('apps/cf_erp/services/lockService.js');
const SO = await imp('apps/cf_erp/services/salesOrderService.js');
const AREAS = await imp('apps/cf_erp/services/stockingAreaService.js');
const BATCH = await imp('apps/cf_erp/services/stepBatchService.js');

const COMPANY = Number(process.env.CF_BATCH_COMPANY ?? 2);
const LINE = Number(process.env.CF_BATCH_LINE ?? 923);
const MAX_TRIPS = Number(process.env.CF_BATCH_MAX_TRIPS_PER_STEP ?? 26);

let passed = 0;
let failed = 0;
const fails = [];
function ok(label, cond, detail = '') {
  if (typeof label !== 'string' || typeof cond !== 'boolean') throw new Error(`ok(label, cond) takes a string and then a boolean — got ok(${typeof label}, ${typeof cond})`);
  if (cond) { passed += 1; console.log(`  PASS  ${label}`); } else { failed += 1; fails.push(label); console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
}
async function census(db) {
  const [rows] = await db.query("SHOW TABLES LIKE 'cf\\_%'");
  const out = {};
  for (const t of rows.map((r) => Object.values(r)[0]).sort()) { const [[r]] = await db.query(`SELECT COUNT(*) AS n FROM \`${t}\``); out[t] = Number(r.n); }
  return out;
}
function counting(db) {
  const tally = { n: 0, lots: 0 };
  const proxy = new Proxy(db, {
    get: (target, prop) => (prop === 'query' || prop === 'execute'
      ? (...args) => { tally.n += 1; if (/cf_stock_(batches|balances)/.test(String(args[0]?.sql ?? args[0]))) tally.lots += 1; if (process.env.CF_BATCH_DEBUG) { const k = String(args[0]?.sql ?? args[0]).replace(/\s+/g, ' ').slice(0, 90); (tally.by ??= new Map()).set(k, (tally.by.get(k) ?? 0) + 1); } return target[prop](...args); }
      : Reflect.get(target, prop)),
  });
  return { db: proxy, tally };
}

const conn = await pool.getConnection();
let exitCode = 0;
try {
  const before = await census(conn);
  await conn.beginTransaction();
  attachNodeCache(conn);
  const [[user]] = await conn.query('SELECT id FROM users WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [COMPANY]);
  const c = { companyId: COMPANY, userId: user?.id ?? null };
  const [[line]] = await conn.query(
    'SELECT l.id, l.line_no, l.locked_at, l.order_id, o.code AS order_code, o.status FROM cf_sales_order_lines l JOIN cf_sales_orders o ON o.id = l.order_id WHERE l.company_id = ? AND l.id = ?',
    [COMPANY, LINE],
  );
  if (!line) throw new Error(`Line ${LINE} is not a line of company ${COMPANY}.`);
  if (await REL.liveReleaseOfLine(conn, COMPANY, LINE)) throw new Error(`Line ${LINE} is already released — it must not be; stopping.`);
  console.log(`\nCompany ${COMPANY}, ${line.order_code} line ${line.line_no} (${LINE})`);
  if (!line.locked_at) await LOCK.lockLine(conn, c, LINE);
  if (line.status !== 'confirmed') {
    await conn.query("UPDATE cf_sales_orders SET committed_date = COALESCE(committed_date, '2026-12-31') WHERE company_id = ? AND id = ?", [COMPANY, line.order_id]);
    await SO.setOrderStatus(conn, c, line.order_id, 'confirmed');
  }
  let check = await REL.releaseCheck(conn, COMPANY, LINE);
  if (check.needsFinishedArea && !check.areas.some((a) => a.purpose === 'dispatch')) {
    await AREAS.createArea(conn, c, { code: 'SBT-DSP', name: 'Step batch test dispatch', purpose: 'dispatch' });
    check = await REL.releaseCheck(conn, COMPANY, LINE);
  }
  if (!check.ok) throw new Error(`The line cannot be released: ${check.problems.slice(0, 5).join(' | ')}`);
  const rel = await REL.releaseLine(conn, c, LINE, { view: 'none', ...(check.needsFinishedArea ? { finishedAreaId: check.areas.find((a) => a.purpose === 'dispatch')?.id } : {}) });
  const releaseId = rel.id;
  await REL.reserveRelease(conn, c, releaseId, { view: 'none' }).catch(() => null);
  // The material counts as issued (a fixture; rolled back): what is left is the waits between steps.
  await conn.query('UPDATE cf_material_requirements SET issued = quantity WHERE company_id = ? AND release_id = ?', [COMPANY, releaseId]);

  // The batch's per-step transactions become savepoints of this one.
  let sp = 0;
  const tx = async (fn, db = conn) => {
    sp += 1;
    const name = `sb${sp}`;
    await conn.query(`SAVEPOINT ${name}`);
    try { const out = await fn(db); await conn.query(`RELEASE SAVEPOINT ${name}`); return out; } catch (e) { await conn.query(`ROLLBACK TO SAVEPOINT ${name}`); throw e; }
  };
  const evalNow = async () => {
    const data = await REL.evaluatedTracker(conn, COMPANY, [releaseId]);
    return { d: data, byId: new Map(data.steps.map((s) => [s.id, s])) };
  };

  // --- the fixture: the ready steps and the steps that wait only on them, a few levels down ----------------------
  let { d, byId } = await evalNow();
  const counts = {};
  for (const s of d.steps) counts[s._status] = (counts[s._status] ?? 0) + 1;
  console.log(`  released inside the transaction: ${d.steps.length} steps (${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ')})`);
  const depsOf = new Map();
  for (const x of d.deps) { if (!depsOf.has(x.step_id)) depsOf.set(x.step_id, []); depsOf.get(x.step_id).push(x); }
  const stepsOfItem = new Map();
  for (const s of d.steps) { if (!stepsOfItem.has(s.production_item_id)) stepsOfItem.set(s.production_item_id, []); stepsOfItem.get(s.production_item_id).push(s); }
  const ready = d.steps.filter((s) => s._status === 'ready' && s.state === 'pending');
  if (ready.length < 2) throw new Error('Fewer than two ready steps — the fixture needs the line\'s material issued.');
  // A step joins when everything it waits on is in the selection: a step, or every step of a piece.
  const chosen = new Set(ready.slice(0, 4).map((s) => s.id));
  const held = (x) => (x.target_step_id != null ? chosen.has(x.target_step_id) : (stepsOfItem.get(x.target_item_id) ?? []).every((t) => chosen.has(t.id)));
  for (let level = 0; level < 6 && chosen.size < 60; level += 1) {
    const add = d.steps.filter((s) => !chosen.has(s.id) && s.state === 'pending' && (depsOf.get(s.id) ?? []).length && depsOf.get(s.id).every(held));
    if (!add.length) break;
    for (const s of add.slice(0, 60 - chosen.size)) chosen.add(s.id);
  }
  const chain = d.steps.filter((s) => chosen.has(s.id));
  const later = chain.filter((s) => s._status !== 'ready');
  console.log(`  selection: ${chain.length} steps, ${chain.length - later.length} ready now and ${later.length} waiting on them`);

  // --- 1. guards -----------------------------------------------------------------------------------------
  console.log('\n1. What is refused before anything is done');
  const refusedWith = async (input) => { try { await BATCH.finishSteps(c, input, { db: conn, tx }); return null; } catch (e) { return e; } };
  ok('no steps named is refused', (await refusedWith({ stepIds: [] }))?.code === 'NO_STEPS');
  const tooMany = await refusedWith({ stepIds: Array.from({ length: BATCH.MAX_BATCH_STEPS + 1 }, (_, i) => i + 1) });
  ok(`more than ${BATCH.MAX_BATCH_STEPS} steps is refused, in words`, tooMany?.code === 'TOO_MANY' && /at most 200/.test(tooMany.message));
  ok('a step id that is no number is refused', (await refusedWith({ stepIds: ['x'] }))?.code === 'INVALID');

  // --- 2. the selection, named last first, is finished in the order its waits allow -------------------------
  console.log('\n2. The selection, named last first');
  // And a step that waits on something outside the batch (refused; the rest stand), and an unknown id.
  const outside = d.steps.find((s) => s._status === 'not_ready' && !chosen.has(s.id) && !(depsOf.get(s.id) ?? []).every(held)
    && !(s._blockers ?? []).some((b) => b.kind === 'production_order'));
  const ids = [...chain.map((s) => s.id).reverse(), ...(outside ? [outside.id] : []), 999999999];
  const { db: counted, tally } = counting(conn);
  const t0 = Date.now();
  const out = await BATCH.finishSteps(c, { stepIds: ids, note: 'catch-up' }, { db: counted, tx: (fn) => tx(fn, counted) });
  const ms = Date.now() - t0;
  console.log(`    ${out.done.length} done, ${out.refused.length} refused, ${out.waves} waves — ${tally.n} round trips (${(tally.n / Math.max(1, out.done.length)).toFixed(1)} a step), ${ms} ms`);
  console.log(`    ${out.message}`);
  if (tally.by) for (const [k, n] of [...tally.by].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`      ${n}  ${k}`);
  ({ d, byId } = await evalNow());
  const waveOf = new Map(out.done.map((x) => [x.stepId, x.wave]));
  ok('every step of the selection is done', chain.every((s) => waveOf.has(s.id) && byId.get(s.id).state === 'done'), JSON.stringify(out.refused.slice(0, 3)));
  ok('each finished with its whole quantity good', chain.every((s) => Math.abs(Number(byId.get(s.id).qty_good) - Number(s.quantity)) < 1e-6));
  ok('the steps ready at the start went in the first wave', chain.filter((s) => s._status === 'ready').every((s) => waveOf.get(s.id) === 1));
  ok('steps that waited on the selection were taken in later waves', later.length > 0 && out.waves >= 2 && later.every((s) => waveOf.get(s.id) >= 2));
  ok('…each after everything it waits on', chain.every((s) => (depsOf.get(s.id) ?? []).every((x) => (x.target_step_id != null
    ? waveOf.get(x.target_step_id) < waveOf.get(s.id)
    : (stepsOfItem.get(x.target_item_id) ?? []).every((t) => waveOf.get(t.id) < waveOf.get(s.id))))));
  if (outside) {
    const r = out.refused.find((x) => x.stepId === outside.id);
    ok('a step waiting on something outside the batch is refused, with what it waits for', !!r && /cannot start yet/.test(r.reason) && r.reason.length > 25 && !!r.label, r?.reason);
    ok('…and it is left as it was', byId.get(outside.id).state === 'pending');
  }
  ok('an unknown step is refused by id', out.refused.some((x) => x.stepId === 999999999 && x.reason === 'Step not found.'));
  ok('the answer says what was done and what was not', /Finished \d+ steps/.test(out.message) && /not/.test(out.message), out.message);
  const [ev] = await conn.query('SELECT step_id, event, qty_good, note FROM cf_step_events WHERE company_id = ? AND step_id IN (?) ORDER BY id', [COMPANY, chain.map((s) => s.id)]);
  ok('each step has its start and its progress event, with the note', chain.every((s) => ev.some((e) => e.step_id === s.id && e.event === 'start' && e.note === 'catch-up')
    && ev.some((e) => e.step_id === s.id && e.event === 'progress' && Math.abs(Number(e.qty_good) - Number(s.quantity)) < 1e-6)));
  // The production ledger makes a work-in-progress lot (with its code) for every piece a cut or a split brings out —
  // productionLedgerService's own cost, the same when the steps are finished one by one; counted apart.
  const per = (tally.n - tally.lots) / Math.max(1, out.done.length);
  console.log(`    ${tally.lots} of them on the ledger's work-in-progress lots`);
  ok(`at most ${MAX_TRIPS} round trips a finished step, wave reads included, the ledger's lots apart (${per.toFixed(1)})`, per <= MAX_TRIPS);

  // --- 3. again: nothing is done twice ----------------------------------------------------------------------
  console.log('\n3. The same steps again');
  const again = await BATCH.finishSteps(c, { stepIds: chain.map((s) => s.id) }, { db: conn, tx });
  ok('steps already done are not done again, and say so', again.done.length === 0 && again.refused.length === chain.length && again.refused.every((x) => x.reason === 'It is already done.'));

  // --- 4. one refusal does not undo the rest ----------------------------------------------------------------
  console.log('\n4. A refusal inside a wave');
  ({ d, byId } = await evalNow());
  const readyNow = d.steps.filter((s) => s._status === 'ready' && s.state === 'pending').slice(0, 3);
  if (readyNow.length >= 2) {
    const victim = readyNow[1];
    // Its start fails (as if another user had just changed it): its savepoint is rolled back, the others stand.
    const failing = (fn) => tx((db) => fn(new Proxy(db, { get: (t, p) => (p === 'query' ? (sql, params) => {
      if (typeof sql === 'string' && /SET state = 'in_progress', started_at/.test(sql) && params?.includes(victim.id)) {
        return Promise.reject(Object.assign(new Error('Refused for the test.'), { problems: ['A reason.'] }));
      }
      return t.query(sql, params);
    } : Reflect.get(t, p)) })));
    const r = await BATCH.finishSteps(c, { stepIds: readyNow.map((s) => s.id) }, { db: conn, tx: failing });
    ({ d, byId } = await evalNow());
    ok('the refused step is listed with its reason', r.refused.length === 1 && r.refused[0].stepId === victim.id && r.refused[0].reason === 'Refused for the test. A reason.', JSON.stringify(r.refused));
    ok('…its own writes are undone', byId.get(victim.id).state === 'pending' && Number(byId.get(victim.id).qty_good) === 0);
    ok('…and the others stand', readyNow.filter((s) => s !== victim).every((s) => byId.get(s.id).state === 'done'));
  } else console.log('    (fewer than two ready steps left — skipped)');

  await conn.rollback();
  const after = await census(conn);
  const changed = Object.keys(before).filter((t) => before[t] !== after[t]);
  ok('every cf_ table is back where it started', changed.length === 0, changed.map((t) => `${t} ${before[t]}→${after[t]}`).join(', '));
} catch (err) {
  try { await conn.rollback(); } catch { /* the error below matters */ }
  console.error(`\nERROR: ${err.stack}${err.problems?.length ? `\n  ${err.problems.slice(0, 10).join('\n  ')}` : ''}`);
  exitCode = 1;
} finally {
  conn.release();
  await pool.end();
}
console.log(`\n${passed} passed, ${failed} failed${fails.length ? `\n  ${fails.join('\n  ')}` : ''}`);
process.exitCode = exitCode || (failed ? 1 : 0);
