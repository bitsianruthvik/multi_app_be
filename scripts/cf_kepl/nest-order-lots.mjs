#!/usr/bin/env node
/**
 * nest-order-lots.mjs — NEST EVERY LINE OF AN ORDER ON STANDARD + CUSTOM SIZES, THE MILL'S LOT COUNTED OVER THE ORDER
 * (user, 2026-11-02: custom 1250–3000 × 6000–14000, generally 5 pieces of each size or 20 t; standard sizes no rule; one
 * production order for the lines). On this machine, against whatever database the environment points at.
 *
 *   1. custom sizes made for ALL the lines' pieces together, per thickness (nestCustomPlate.lotCandidates);
 *   2. short searches of every line; a size the order does not take in a full lot is dropped; again, until all hold;
 *   3. the sizes that held are settled: no other custom size may come in, only drop out;
 *   4. the long search of every line on those; checked again; with --apply the plans checked are the runs written, one per line.
 * Lots are per line in the app: a plate holds one line's pieces, so remnants do not pass between the lines.
 *
 *   node scripts/cf_kepl/nest-order-lots.mjs --company 30005 --order SO260019 --minutes 15 [--workers 7] [--prod] [--apply]
 *        [--compare]  also a standard-only search of each line, for the figures (never written)
 *        [--sizes "12:9150x1650,12200x1550;22:9150x2100"]  the settled sizes, stated: skips 1 and 2
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const argv = process.argv;
const arg = (k) => { const i = argv.indexOf(`--${k}`); return i > 0 ? argv[i + 1] : null; };
const here = path.dirname(fileURLToPath(import.meta.url));
if (argv.includes('--prod')) {
  const env = {};
  fs.readFileSync(path.join(here, '..', '..', '..', '.env.tidb'), 'utf8').split('\n').forEach((l) => { l = l.trim(); if (!l || l.startsWith('#')) return; const [k, ...r] = l.split('='); env[k.trim()] = r.join('=').trim(); });
  Object.assign(process.env, { DB_HOST: env.DB_HOST, DB_PORT: env.DB_PORT ?? '4000', DB_USER: env.DB_USER, DB_PASSWORD: env.DB_PASSWORD, DB_NAME: env.DB_NAME, DB_SSL: 'true' });
}
const COMPANY = Number(arg('company')); const ORDER = arg('order'); const MINUTES = Number(arg('minutes') ?? 15); const WORKERS = arg('workers') ? Number(arg('workers')) : null; const APPLY = argv.includes('--apply');
const { pool } = await import('../../db.js');
await import('../../apps/cf_erp/services/codegenProvider.js');
const { nestLine } = await import('./lib/nestLineRunner.mjs');
const { customLotsOf, cutSettingRows } = await import('../../apps/cf_erp/services/nestingService.js');
const { insertFinishedRun } = await import('../../apps/cf_erp/services/nestRunService.js');
const { lotCandidates, lotKey, lotPasses, lotRuleOf, customLimits } = await import('../../apps/cf_erp/services/nestCustomPlate.js');

const [lines] = await pool.query(
  `SELECT l.id, l.line_no, l.nest_plates FROM cf_sales_order_lines l JOIN cf_sales_orders o ON o.id = l.order_id AND o.deleted_at IS NULL
    WHERE l.company_id = ? AND o.code = ? AND l.deleted_at IS NULL ORDER BY l.line_no`, [COMPANY, ORDER]);
if (!lines.length) throw new Error(`No lines on ${ORDER}.`);
const rows = await cutSettingRows(pool, COMPANY);
const rule = lotRuleOf(rows.customPlates);
if (!rule) throw new Error('The company\'s custom-plate setting states no lot.');
console.log(`${process.env.DB_HOST}: ${ORDER}, lines ${lines.map((l) => l.line_no).join(', ')}; lot ${JSON.stringify(rule)}; ${APPLY ? 'WILL WRITE a run per line' : 'dry run'}`);
const say = () => {};
const run = (l, planInput, minutes, apply = false, effort = 'quick') => nestLine({
  db: pool, companyId: COMPANY, orderCode: ORDER, lineNo: l.line_no, effort, workers: WORKERS, apply, budgetMs: minutes * 60000,
  startedBy: `nest-order-lots (${process.env.USERNAME ?? 'someone'})`, say, planInput,
});
const summary = (p) => `${p.totals.plates} plates, ${p.totals.unplaced} not placed, ${(p.groups.flatMap((g) => g.nests).reduce((a, n) => a + (Number(n.weightKg) || 0), 0) / 1000).toFixed(1)} t`;
const pooled = (plans) => { const m = new Map(); for (const p of plans) customLotsOf(p, m); return m; };
const failing = (m) => [...m.values()].filter((e) => !lotPasses(rule, e.plates, e.kg));

const stated = arg('sizes');
// 1. The pieces of all the lines, by thickness, and the sizes made for them.
const first = [];
if (!stated) for (const l of lines) first.push((await run(l, { lotPass: true, lotNoNew: true }, 0.5)).plan);
const byT = new Map();
for (const p of first) for (const g of p.groups) for (const cp of g.cutPlates ?? []) {
  if (!byT.has(g.thickness)) byT.set(g.thickness, new Map());
  const L = Math.max(cp.steel?.length ?? cp.length, cp.steel?.width ?? cp.width); const W = Math.min(cp.steel?.length ?? cp.length, cp.steel?.width ?? cp.width);
  const k = `${L}x${W}`; const e = byT.get(g.thickness).get(k) ?? { length: L, width: W, qty: 0 };
  e.qty += Number(cp.pieces) || 0; byT.get(g.thickness).set(k, e);
}
for (const p of first) { for (const x of p.problems ?? []) console.log('  problem:', String(x).slice(0, 200)); if ((p.missingPlates ?? []).length) console.log('  missing plates:', JSON.stringify(p.missingPlates.map((m) => [m.thickness, m.grade, m.impactClass]))); }
const lotSizes = {};
const removed = new Set();
const fmtT = (t) => String(Math.round(Number(t) * 1000) / 1000);
for (const [t, m] of byT) {
  const lim = customLimits(rows.customPlates, [], t, { orderStepMm: 50 });
  const sizes = lotCandidates([...m.values()], { limits: { ...lim, step: lim.step || 50 }, kerf: t >= 25 ? 5 : t >= 18 ? 4 : 3, step: lim.step || 50, thickness: t, maxSizes: 6 });
  lotSizes[fmtT(t)] = sizes;
  console.log(`  ${t} mm: ${[...m.values()].reduce((a, e) => a + e.qty, 0)} pieces; sizes offered ${sizes.map((z) => `${z.length}×${z.width}`).join(', ') || 'none'}`);
}

// 2. Short searches until every custom size holds its lot over the order.
let plans = first;
for (let pass = 1; pass <= 4 && !stated; pass++) {
  plans = [];
  for (const l of lines) plans.push((await run(l, { lotPass: true, lotSizes, lotRemoved: removed }, 1)).plan);
  const m = pooled(plans); const bad = failing(m);
  console.log(`pass ${pass}: ${plans.map(summary).join(' | ')}; custom sizes ${[...m.values()].map((e) => `${e.thickness}mm ${e.length}×${e.width} ×${e.plates} ${(e.kg / 1000).toFixed(1)}t`).join('; ') || 'none'}`);
  if (!bad.length) break;
  // The weakest first, so a size can still gain what the dropped one leaves.
  const worst = bad.sort((a, b) => a.kg - b.kg).slice(0, Math.max(1, Math.ceil(bad.length / 2)));
  for (const e of worst) { removed.add(e.key); console.log(`  dropped ${e.thickness} mm ${e.length} × ${e.width}: ${e.plates} plates, ${(e.kg / 1000).toFixed(1)} t`); }
}

// 3. Settle: what held is all the custom sizes there are from here on.
const settled = {};
if (stated) for (const part of stated.split(';')) { const [t, list] = part.split(':'); settled[fmtT(t)] = list.split(',').map((z) => { const [L, W] = z.split('x').map(Number); return { length: L, width: W }; }); }
else for (const e of pooled(plans).values()) if (lotPasses(rule, e.plates, e.kg) && !removed.has(e.key)) (settled[fmtT(e.thickness)] ??= []).push({ length: e.length, width: e.width });
console.log('settled:', Object.entries(settled).map(([t, zs]) => `${t} mm ${zs.map((z) => `${z.length}×${z.width}`).join(', ')}`).join('; ') || 'none');
const longInput = { lotPass: true, lotFrozen: true, lotSizes: settled, lotRemoved: removed };

// 4. The long search.
let done = null;
for (let pass = 1; pass <= 5 && !done; pass++) {
  const results = [];
  for (const l of lines) results.push(await run(l, longInput, MINUTES, false, 'long'));
  const m = pooled(results.map((r) => r.plan)); const bad = failing(m);
  console.log(`long ${pass}: ${results.map((r) => summary(r.plan)).join(' | ')}`);
  if (bad.length) { for (const e of bad) { removed.add(e.key); console.log(`  dropped ${e.thickness} mm ${e.length} × ${e.width}: ${e.plates} plates, ${(e.kg / 1000).toFixed(1)} t`); } continue; }
  done = { results, m };
}
if (!done) throw new Error('The custom sizes would not settle in five long searches.');
console.log('\nCUSTOM SIZES, over the order:');
for (const e of done.m.values()) console.log(`  ${e.thickness} mm  ${e.length} × ${e.width}  ${e.plates} plates  ${(e.kg / 1000).toFixed(1)} t`);
for (const [i, l] of lines.entries()) {
  const p = done.results[i].plan;
  console.log(`\nline ${l.line_no}: ${summary(p)}`);
  for (const g of p.groups) {
    const by = new Map(); for (const n of g.nests) { const k = `${Math.max(n.length, n.width)}×${Math.min(n.length, n.width)}${n.lotCustom || n.customPlate ? ' custom' : ''}`; by.set(k, (by.get(k) ?? 0) + 1); }
    const kg = g.nests.reduce((a, n) => a + (Number(n.weightKg) || 0), 0); const waste = g.nests.reduce((a, n) => a + (Number(n.wasteTotalKg) || 0), 0);
    console.log(`  ${String(g.thickness).padStart(3)} mm  ${g.nests.length} plates ${(kg / 1000).toFixed(1)} t, waste ${(kg ? (100 * waste) / kg : 0).toFixed(1)} %  ${[...by].map(([k, v]) => `${k} ×${v}`).join(', ')}`);
  }
  for (const x of p.problems ?? []) console.log('  problem:', String(x).slice(0, 200));
  for (const c of p.manual ?? []) console.log('  by hand:', JSON.stringify(c).slice(0, 160));
}
if (APPLY) {
  // The plans just checked, not a fresh search: another search could break a lot.
  for (const out of done.results) {
    const finishedAt = Date.now();
    const row = await insertFinishedRun(pool, { companyId: COMPANY, lineId: out.line.id, plan: out.plan, demand: out.demand, input: { effort: out.effort, seed: 1, ...longInput, lotRemoved: [...removed] }, scope: out.scope, startedAt: finishedAt - out.elapsedMs, finishedAt, startedBy: `nest-order-lots (${process.env.USERNAME ?? 'someone'})`, log: [], sections: out.sections, budgetMs: out.budgetMs });
    console.log(`line ${out.line.lineNo} written: run ${row.runId} (${summary(out.plan)})`);
  }
}
if (argv.includes('--compare')) {
  for (const l of lines) { const r = await run(l, { lotPass: true, plateChoice: 'standard' }, MINUTES / 2, false, 'long'); console.log(`standard only, line ${l.line_no}: ${summary(r.plan)}`); }
}
void lotKey;
await pool.end();
process.exit(0);
