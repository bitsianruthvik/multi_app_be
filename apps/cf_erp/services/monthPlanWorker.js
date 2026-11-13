/**
 * monthPlanWorker.js — THE OPTIMISER OFF THE SERVER'S THREAD (2026-11-13).
 *
 * The search (monthPlanEngine.optimise) is pure CPU work: seconds on a laptop, far longer on a small server — and while it
 * ran inside a request, NOTHING else was answered (Node has one thread): on the day the sandbox got a 1,371-unit month
 * every screen of every company waited behind it. So a plan is a JOB run in a worker thread; the request only awaits it.
 *
 *   runPlanJob(job) → Promise<{ plan, suggestions }>      (a worker per job; falls back to this thread if none can start)
 *   job = { input, opts: { iterations, startOrder }, suggest: null | { spare: [{ id, code, name, fn, minutes: [per day] }], monthEndDay, fnNames } }
 *
 * MORE MACHINES (suggest): the machine types the plan waited for or filled to the brim; for each, the spare machine with
 * the most hours — tried alone, and added one at a time into the best set (while each adds tonnes). Kept small on purpose:
 * at most MAX_TYPES singles and MAX_SET rounds of MAX_CANDS, each a short warm-started search.
 */
import { Worker, isMainThread, parentPort, workerData } from 'worker_threads';
import { optimise, whatIf } from './monthPlanEngine.js';

const MAX_TYPES = 4; const MAX_SET = 3; const MAX_CANDS = 3;
const r3 = (x) => Math.round(Number(x) * 1000) / 1000;

export function suggestOptions(input, plan, { spare, monthEndDay, fnNames = {} }) {
  const total = (arr) => { let t = 0; for (let d = 0; d <= monthEndDay && d < arr.length; d += 1) t += arr[d]; return t; };
  const waited = new Map();
  for (const u of plan.units) if (u.reason?.kind === 'capacity' && u.reason.fn) waited.set(u.reason.fn, (waited.get(u.reason.fn) ?? 0) + u.tonnes);
  for (const [fn, arr] of Object.entries(plan.load)) {
    const cap = total(input.pools[fn] ?? []); const used = total(arr);
    if (cap > 0 && used / cap > 0.9 && !waited.has(fn)) waited.set(fn, 0.001);
  }
  const usable = spare.map((m) => ({ ...m, hours: total(m.minutes) })).filter((m) => m.hours > 0);
  const bestOfType = (fn, skip) => usable.filter((m) => m.fn === fn && !skip.has(m.id)).sort((a, b) => b.hours - a.hours)[0] ?? null;
  const addOf = (ms) => {
    const add = {};
    for (const m of ms) {
      if (!add[m.fn]) add[m.fn] = new Array(input.days).fill(0);
      m.minutes.forEach((x, i) => { if (i < input.days) add[m.fn][i] += x; });
    }
    return add;
  };
  const fnsAll = [...waited].sort((a, b) => b[1] - a[1]).map(([fn]) => fn);
  const noSpare = fnsAll.filter((fn) => !bestOfType(fn, new Set())).map((fn) => fnNames[fn] ?? fn);
  const fnsToTry = fnsAll.filter((fn) => bestOfType(fn, new Set())).slice(0, MAX_TYPES);
  if (!fnsToTry.length) return { options: [], noSpare };
  const quick = { basePlan: plan, iterations: 40, decodeBudget: 1500, minIterations: 8 };
  const singles = fnsToTry.map((fn) => bestOfType(fn, new Set()));
  const single = whatIf(input, singles.map((m) => ({ key: `m${m.id}`, label: `${m.code} · ${m.name}`, machineIds: [m.id], add: addOf([m]) })), quick);
  const set = []; const taken = new Set(); let cur = plan.tonnes;
  for (let round = 0; round < MAX_SET; round += 1) {
    const cands = fnsToTry.map((fn) => bestOfType(fn, taken)).filter(Boolean).slice(0, MAX_CANDS);
    if (!cands.length) break;
    const res = whatIf(input, cands.map((m) => ({ key: `m${m.id}`, machine: m, add: addOf([...set, m]) })), quick);
    const top = res[0];
    if (!top || top.tonnes <= cur + 0.0005) break;
    set.push(top.machine); taken.add(top.machine.id); cur = top.tonnes;
  }
  const options = [];
  if (set.length > 1) options.push({ key: `set${set.map((m) => m.id).join('.')}`, label: `${set.length} machines: ${set.map((m) => m.code).join(', ')}`, machineIds: set.map((m) => m.id), tonnes: r3(cur), gain: r3(cur - plan.tonnes), best: true });
  for (const o of single) if (o.gain > 0.0005) options.push({ key: o.key, label: o.label, machineIds: o.machineIds, tonnes: o.tonnes, gain: o.gain });
  options.sort((a, b) => b.gain - a.gain);
  return { options: options.slice(0, 6), noSpare };
}

/** The job itself (also what the worker runs). */
export function runJobHere(job) {
  const plan = optimise(job.input, job.opts ?? {});
  const suggestions = job.suggest ? suggestOptions(job.input, plan, job.suggest) : null;
  return { plan, suggestions };
}

const JOB_TIMEOUT_MS = 120_000;

/** Runs a plan job in a worker thread; the server's thread stays free. */
export function runPlanJob(job) {
  return new Promise((resolve, reject) => {
    let worker;
    try { worker = new Worker(new URL(import.meta.url), { workerData: job, execArgv: [] }); } catch { resolve(runJobHere(job)); return; }
    const timer = setTimeout(() => { worker.terminate(); reject(Object.assign(new Error('The plan took too long to work out — try again with fewer orders or machines.'), { status: 503, code: 'PLAN_TIMEOUT' })); }, JOB_TIMEOUT_MS);
    let settled = false;
    worker.once('message', (m) => { settled = true; clearTimeout(timer); if (m?.error) reject(new Error(m.error)); else resolve(m); });
    worker.once('error', (e) => { settled = true; clearTimeout(timer); reject(e); });
    worker.once('exit', (code) => { clearTimeout(timer); if (!settled) reject(new Error(`The planning worker stopped (${code}).`)); });
  });
}

if (!isMainThread && parentPort && workerData?.input) {
  try { parentPort.postMessage(runJobHere(workerData)); } catch (e) { parentPort.postMessage({ error: e?.message ?? String(e) }); }
}
