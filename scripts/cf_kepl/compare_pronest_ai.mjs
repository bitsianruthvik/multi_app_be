/**
 * compare_pronest_ai.mjs — the shop's own ProNest nesting against OUR AI plate nesting, like for like
 * (2026-10-18). LOCAL ONLY, READ ONLY: reads the .nif files and the local catalog / cut settings, writes
 * nothing to the database. Output: TM/nest_learning/out/compare/<JOB>_<variant>.json.
 *
 *   cd multi_app_be && node scripts/cf_kepl/compare_pronest_ai.mjs [--job=NECL] [--plates=both|pronest]
 *                                                                [--effort=standard|deep|long] [--company=2]
 *                                                                [--thick=12,20] [--out=compare_after] [--legacy]
 *   --thick   only these thicknesses (a short run while tuning)
 *   --out     the folder under nest_learning/out (default compare); the file is <JOB>_<plates>[_<effort>].json
 *   --legacy  the engine's inputs as before 2026-10-18 (area cost, no plate-size rules, no shop gap / shared cuts)
 *
 * WHAT IS COMPARED
 *   ProNest  every nest of the job's .nif files, each plate × the nest's quantity (identical copies).
 *   AI       exactly the parts and quantities ProNest nested (each part's outline from the .nif), offered
 *            the plate sizes ProNest used + (with --plates=both) the local catalog plates of that thickness,
 *            packed by THE APP'S OWN ENGINE: the same job input planNesting builds (packJob shape job: the
 *            row layout as floor, the true-shape packer seeded with it), the same seeds (Standard: 8), the
 *            same whole-run budget (Standard: 10 min for the job, all thicknesses at once, through
 *            lib/packerPool.runAll) and pickBest. Shop spacing ON (shopRules.withShopSpacing: edge 5 mm,
 *            blocks 13 mm), kerf per thickness from the job's own ProNest settings (INI chunk).
 *
 * THE SAME MEASURING CODE FOR BOTH SIDES
 *   waste by cause + offcuts   nestShapes.shapedWaste (the app's offcut rule: area ≥ offcut_min_area_mm2 and
 *                              an inscribed rectangle whose short side ≥ offcut_min_side_mm — cf_cut_settings)
 *   rule breaks                nestShapes.verifyPlate (overlap / closer than one kerf / outside / in the rim)
 *   cut length, shared cut     plateCutsService.cutsOfLots (free layout: true perimeters, shared cuts on outlines)
 *   pierces, blocks, part-in-part, cut order   aiCutPlan.planCuts (+ checkCutPlan), marking off
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const BE = process.cwd();
const TM = path.resolve(BE, '..');
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const arg = (k, d = null) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };

const { pool } = await imp('db.js');
if (!/^(localhost|127\.0\.0\.1|::1)$/.test(process.env.DB_HOST ?? 'localhost')) throw new Error('Local only.');
const { readNif } = await imp('apps/cf_erp/lib/nifReader.js');
const NS = await imp('apps/cf_erp/services/nestingService.js');
const SH = await imp('apps/cf_erp/services/nestShapes.js');
const SR = await imp('apps/cf_erp/services/shopRules.js');
const PC = await imp('apps/cf_erp/services/plateCutsService.js');
const AC = await imp('apps/cf_erp/services/aiCutPlan.js');
const { runAll, seedsFor, pickBest } = await imp('apps/cf_erp/lib/packerPool.js');
const { EFFORT } = await imp('apps/cf_erp/services/nestingPacker.js');
const { cutPlaces } = await imp('apps/cf_erp/lib/cutPlaces.js');
const { decodeFile } = await import(pathToFileURL(path.join(TM, 'nest_learning', 'decode.mjs')).href);

const COMPANY = Number(arg('company', 2));
const EFF = arg('effort', 'standard');
const PLATES = arg('plates', 'both');
const ONLY_JOB = arg('job');
const THICK = arg('thick') ? new Set(arg('thick').split(',').map(Number)) : null;
const LEGACY = process.argv.includes('--legacy');
const NC = await imp('apps/cf_erp/services/nestCost.js');
const { listPricesOf } = await imp('apps/cf_erp/services/priceService.js');
const DENSITY = 7850; // kg/m³ — MS
const JOBS = [['NECL', 'NECL_48M_NESTING_NIF'], ['NITHINSAI', 'NITHINSAI_36M_NESTING_NIF'], ['VRC', 'VRC_36M_NESTING_NIF']];
const OUT = path.join(TM, 'nest_learning', 'out', arg('out', 'compare'));
fs.mkdirSync(OUT, { recursive: true });

const r1 = (v) => Math.round(v * 10) / 10; const r3 = (v) => Math.round(v * 1000) / 1000;
const kgOf = (areaMm2, t) => (areaMm2 / 1e6) * (t / 1000) * DENSITY;
const absArea = (pts) => { let a = 0; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1]; return Math.abs(a / 2); };
const boxOf = (pts) => { let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity; for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); } return { x0, y0, x1, y1 }; };
const parseIni = (txt) => { const o = {}; let sec = ''; for (const l of txt.split('\n')) { const m = /^\[(.*)\]$/.exec(l.trim()); if (m) { sec = m[1]; o[sec] = o[sec] || {}; continue; } const i = l.indexOf('='); if (i > 0 && sec) o[sec][l.slice(0, i)] = l.slice(i + 1).trim(); } return o; };
const kerfOfFile = (job, file) => {
  const n = `${job}__${file.replace(/\.nif$/i, '').replace(/[^A-Za-z0-9]+/g, '_')}.ini`;
  try { const v = parseFloat(parseIni(fs.readFileSync(path.join(TM, 'nest_learning', 'out', 'ini', n), 'utf8'))['Process 1 Default Process Parameters'].kerf); return Math.round(v * 25.4 * 10) / 10; } catch { return null; }
};
const ringsOfNifPart = (p) => ({ outline: p.rings.outline, cutouts: [...p.rings.cutouts, ...(p.unsure ?? [])], holes: p.rings.holes });

/* ───────────────────────────── the one measure ───────────────────────────── */

const SETTING_ROWS = await NS.cutSettingRows(pool, COMPANY);
const bandOf = (t) => { const rows = SETTING_ROWS.slice(); return NS.pickCutSettings(rows, t); }; // rows without .shop → the band as it is

/** One laid-out plate → every figure, by the app's own code. pieces: [{ key, partId, name, rings (placed), area }] */
function measurePlate({ L, W, t, kerf, pieces, offcutRule }) {
  const plateKg = kgOf(L * W, t);
  const partsArea = pieces.reduce((a, p) => a + p.area, 0);
  const sw = SH.shapedWaste({ length: L, width: W, kerf, pieces: pieces.map((p) => ({ rings: p.rings, area: p.area })), minOffcutArea: offcutRule.area, minOffcutSide: offcutRule.side });
  const ver = SH.verifyPlate({ length: L, width: W, placements: pieces.map((p) => ({ key: p.key, rings: p.rings })), kerf, margin: kerf });
  const cuts = PC.cutsOfLots([{ kerf, free: true, pieces: pieces.map((p) => { const b = boxOf(p.rings.outline); return { key: p.key, cutPlateId: p.partId, x: b.x0, y: b.y0, length: b.x1 - b.x0, width: b.y1 - b.y0, rings: p.rings }; }) }]);
  const rules = AC.aiRulesOf({ kerfMm: kerf, edgeMarginMm: 5, partGapMm: 5, groupGapMm: 13, shopSpacing: true });
  let plan = null; let planErr = null;
  try { plan = AC.planCuts({ plate: { length: L, width: W }, pieces: pieces.map((p) => ({ key: p.key, code: p.name, rings: p.rings })), rules, options: { marking: false, sequences: false } }); } catch (e) { planErr = e.message; }
  const offcuts = (sw?.offcuts ?? []).map((o) => ({ area: o.area, bbox: o.bbox, rect: o.rect, rectShare: r3((o.rect.length * o.rect.width) / o.area), outline: o.outline }));
  const probs = {}; for (const p of ver.problems) probs[p.kind] = (probs[p.kind] ?? 0) + 1;
  const findings = {}; for (const f of plan?.spacing?.findings ?? []) findings[f.kind] = (findings[f.kind] ?? 0) + 1;
  const cutProblems = {}; for (const p of plan?.check?.problems ?? []) cutProblems[p.kind] = (cutProblems[p.kind] ?? 0) + 1;
  const edgeMin = Math.min(...pieces.map((p) => { const b = boxOf(p.rings.outline); return Math.min(b.x0, b.y0, L - b.x1, W - b.y1); }));
  return {
    plateKg, partsKg: kgOf(partsArea, t), partsArea, pieces: pieces.length,
    waste: sw ? Object.fromEntries(Object.entries(sw.waste).map(([k, v]) => [k, kgOf(v, t)])) : null,
    offcuts,
    cutLengthMm: cuts.cutLengthMm, sharedMm: cuts.sharedMm, appPiercings: cuts.piercings,
    pierces: plan?.counts?.pierces ?? null, blocks: plan?.counts?.blocks ?? null, inBlocks: plan?.counts?.inBlocks ?? null,
    partInPart: plan?.counts?.partInPart ?? null, backSteps: plan?.counts?.backSteps ?? null,
    cutOrderOk: plan ? plan.check.ok : null, cutProblems, planErr,
    breaks: probs, commonCuts: ver.commonCuts.length,
    shopFindings: findings, edgeMinMm: r3(edgeMin), partGapMinMm: plan?.spacing?.partGapMinMm ?? null, groupGapMinMm: plan?.spacing?.groupGapMinMm ?? null,
  };
}

/* ───────────────────────────── reading a job ───────────────────────────── */

function readJob(job, dir) {
  const files = fs.readdirSync(path.join(TM, dir)).filter((f) => f.toLowerCase().endsWith('.nif'));
  const byT = new Map();
  for (const file of files) {
    const full = path.join(TM, dir, file);
    const doc = readNif(fs.readFileSync(full), { filename: file });
    let decoded = null; try { decoded = decodeFile({ job, dir, file, full }); } catch { decoded = null; }
    const kerf = kerfOfFile(job, file);
    doc.nests.forEach((n, ni) => {
      const t = Math.round(n.plate.thickness ?? doc.partsList?.[0]?.thickness);
      if (!byT.has(t)) byT.set(t, { t, files: new Set(), kerf: null, nests: [], parts: new Map() });
      const T = byT.get(t);
      T.files.add(file); if (kerf != null) T.kerf = T.kerf == null ? kerf : Math.max(T.kerf, kerf);
      const seqEntries = decoded?.nests?.[ni]?.seq?.length ?? null;
      const pieces = n.parts.map((p, i) => {
        const rings = ringsOfNifPart(p);
        const area = SH.ringsArea(SH.ringsObject(rings));
        if (!T.parts.has(p.partId)) T.parts.set(p.partId, { partId: p.partId, name: p.name, qty: 0, rings: null, area, mirroredSeen: 0 });
        const P = T.parts.get(p.partId);
        P.qty += n.quantity;
        if (p.mirrored) P.mirroredSeen += n.quantity;
        if (!P.rings || (P.fromMirrored && !p.mirrored)) { P.rings = SH.placeShape(rings, { x: 0, y: 0, rotationDeg: 0, mirrored: false }); P.fromMirrored = !!p.mirrored; }
        return { key: `n${ni}_${i}`, partId: p.partId, name: p.name, rings: SH.ringsObject(rings), area, rotationDeg: p.rotationDeg, clc: p.clcGroup ?? null };
      });
      T.nests.push({ file, nestNo: n.nestNo, qty: n.quantity, L: n.plate.length, W: n.plate.width, pieces, seqEntries, utilStored: n.utilisationStored });
    });
  }
  return [...byT.values()].sort((a, b) => a.t - b.t);
}

/* ───────────────────────────── the AI side, as planNesting builds it ───────────────────────────── */

async function catalogPlates() {
  const p = (await cutPlaces(pool, COMPANY)).plate;
  return NS.candidatePlates(pool, COMPANY, [...p.stockIds]);
}

function prepare(T, catalog) {
  const band = bandOf(T.t);
  const kerf = T.kerf ?? SR.shopKerfFor(T.t);
  const settings = SR.withShopSpacing({ ...band, kerfMm: kerf }, { on: true, rows: [] }, T.t);
  const rim = SR.shopRimOf(settings, SH.rimOf);
  const sizes = new Map();
  const ofT = catalog.filter((c) => c.steel.thickness != null && Math.abs(c.steel.thickness - T.t) <= 1e-6 && c.steel.length > 0 && c.steel.width > 0);
  const catOf = (L, W) => ofT.find((c) => Math.max(c.steel.length, c.steel.width) === L && Math.min(c.steel.length, c.steel.width) === W) ?? null;
  for (const n of T.nests) { const L = Math.max(n.L, n.W); const W = Math.min(n.L, n.W); sizes.set(`${L}x${W}`, { L, W, from: 'pronest', cat: catOf(L, W) }); }
  if (PLATES === 'both') {
    for (const c of ofT) {
      const L = Math.max(c.steel.length, c.steel.width); const W = Math.min(c.steel.length, c.steel.width);
      if (!sizes.has(`${L}x${W}`)) sizes.set(`${L}x${W}`, { L, W, from: 'catalog', cat: c });
    }
  }
  // The plates' price and penalty as planNesting works them out (nestCost.plateCosts: list price, CUSTOM, short).
  const sizeList = [...sizes.values()];
  const costs = LEGACY ? null : NC.plateCosts(sizeList.map((s) => {
    const lp = s.cat ? PRICES.get(s.cat.id) : null;
    return { length: s.L, width: s.W, kind: s.cat?.kind ?? null, ratePerKg: lp ? NC.ratePerKg(lp.listPrice, lp.priceBasis, (s.L * s.W * T.t * 7.85e-6)) : null };
  }));
  sizeList.forEach((s, i) => { s.areaCost = costs ? costs[i].areaCost : s.L * s.W; s.penalty = costs ? costs[i].penalty : 0; });
  const parts = [...T.parts.values()];
  const pieceArea = parts.reduce((a, p) => { const b = boxOf(p.rings.outline); return a + (b.x1 - b.x0) * (b.y1 - b.y0) * p.qty; }, 0);
  const sheets = sizeList.map((s) => ({ key: `pl${s.L}x${s.W}`, length: s.L, width: s.W, areaCost: s.areaCost, penalty: s.penalty, preferred: false, available: Math.min(1000, Math.max(1, Math.ceil(pieceArea / (s.L * s.W)) + 2)), from: s.from }))
    .sort((a, b) => b.areaCost - a.areaCost || b.length - a.length || b.width - a.width || a.key.localeCompare(b.key));
  const pieces = parts.map((p) => { const b = boxOf(p.rings.outline); return { key: `p${p.partId}`, part: p, length: r3(b.x1 - b.x0), width: r3(b.y1 - b.y0), qty: p.qty }; })
    .sort((a, b) => b.length * b.width - a.length * a.width || b.length - a.length || b.width - a.width || a.part.partId - b.part.partId);
  const packInput = {
    pieces: pieces.map((p) => ({ key: p.key, length: p.length, width: p.width, qty: p.qty, grain: 'any' })),
    sheets: sheets.map(({ from, penalty, ...s }) => s),
    kerf: settings.kerfMm, gap: settings.kerfMm, margin: rim.rectMargin, thickness: T.t,
    sequenceGap: settings.seqGapMinMm, smallThreshold: 200, rowsPerSequence: { small: 2, big: 3 },
    guillotine: !!settings.guillotine, effort: EFF === 'long' ? 'deep' : EFF, seed: 1, budgetMs: null,
  };
  const shapeInput = {
    pieces: pieces.map((p) => ({ key: p.key, qty: p.qty, rings: p.part.rings, length: p.length, width: p.width, grain: 'any', allowMirror: false })),
    sheets: sheets.map(({ from, ...s }) => s), kerf: settings.kerfMm, margin: rim.shapeMargin, rotations: SR.rotationsOf(settings), partInPart: true, effort: EFF, seed: 1,
    // What planNesting hands the true-shape packer since 2026-10-18 (nestingService.shapeHabits).
    ...(LEGACY ? {} : NS.shapeHabits(settings, T.t, SETTING_ROWS.maxPlateSizes, true)),
  };
  // --gap=kerf|part|group (tuning only): the clearance between parts that share no cut.
  if (!LEGACY && arg('gap')) shapeInput.gap = { kerf: settings.kerfMm, part: Math.max(settings.kerfMm, settings.partGapMm), group: Math.max(settings.kerfMm, settings.groupGapMm) }[arg('gap')] ?? shapeInput.gap;
  if (!LEGACY && process.argv.includes('--no-shared')) shapeInput.sharedCuts = false;
  const realShapes = parts.filter((p) => !SH.isPlainRect({ outline: p.rings.outline, cutouts: [], holes: [] })).length;
  return { T, settings, rim, sheets, pieces, packInput, shapeInput, realShapes, kerf, offcutRule: { area: settings.offcutMinAreaMm2, side: settings.offcutMinSideMm } };
}

function aiNests(pr, raw) {
  const free = raw.packer === 'shape' && raw.chosen === 'shape' && !!raw.shape;
  const out = free ? raw.shape : (raw.rect ?? {});
  const pieceByKey = new Map(pr.pieces.map((p) => [p.key, p]));
  const sheetByKey = new Map(pr.sheets.map((s) => [s.key, s]));
  return {
    chosen: free ? 'shape' : 'rect',
    unplaced: (out.unplaced ?? []).reduce((a, u) => a + (Number(u.qty) || 0), 0),
    nests: (out.nests ?? []).map((n) => {
      const s = sheetByKey.get(n.sheetKey);
      const list = free ? n.placements : n.pieces;
      return {
        L: s.length, W: s.width, from: s.from, qty: 1,
        pieces: list.map((q, i) => {
          const src = pieceByKey.get(q.key);
          const rot = free ? (q.rotationDeg ?? 0) : (q.rotated ? 90 : 0);
          const rings = SH.placeShape(src.part.rings, { x: q.x, y: q.y, rotationDeg: rot, mirrored: free ? !!q.mirrored : false });
          return { key: `a${i}`, partId: src.part.partId, name: src.part.name, rings, area: src.part.area, rotationDeg: rot, seqNo: q.seqNo ?? null, rowNo: q.rowNo ?? null };
        }),
      };
    }),
  };
}

/* ───────────────────────────── sums ───────────────────────────── */

function total(plates) {
  const z = { plates: 0, tonnes: 0, partsT: 0, kerfT: 0, rimT: 0, scrapT: 0, offcutT: 0, seqT: 0, offcuts: 0, offcutRect: 0, cutM: 0, sharedM: 0, pierces: 0, appPierces: 0, pip: 0, blocks: 0, inBlocks: 0, breaks: 0, pieces: 0, cutOrderOk: 0, sizes: {} };
  for (const p of plates) {
    const q = p.qty; const m = p.m;
    z.plates += q; z.tonnes += q * m.plateKg / 1000; z.partsT += q * m.partsKg / 1000; z.pieces += q * m.pieces;
    if (m.waste) { z.kerfT += q * m.waste.kerf / 1000; z.rimT += q * m.waste.rim / 1000; z.scrapT += q * m.waste.wastage / 1000; z.offcutT += q * m.waste.offcut / 1000; z.seqT += q * (m.waste.sequenceGaps ?? 0) / 1000; }
    z.offcuts += q * m.offcuts.length; z.offcutRect += q * m.offcuts.filter((o) => o.rectShare >= 0.9).length;
    z.cutM += q * m.cutLengthMm / 1000; z.sharedM += q * m.sharedMm / 1000; z.pierces += q * (m.pierces ?? 0); z.appPierces += q * m.appPiercings;
    z.pip += q * (m.partInPart ?? 0); z.blocks += q * (m.blocks ?? 0); z.inBlocks += q * (m.inBlocks ?? 0);
    z.breaks += q * Object.values(m.breaks).reduce((a, v) => a + v, 0); z.cutOrderOk += m.cutOrderOk ? q : 0;
    const k = `${Math.max(p.L, p.W)}×${Math.min(p.L, p.W)}`; z.sizes[k] = (z.sizes[k] ?? 0) + q;
  }
  z.util = z.tonnes > 0 ? (100 * z.partsT) / z.tonnes : null;
  z.wastePct = z.tonnes > 0 ? 100 - z.util : null;
  return z;
}

/* ───────────────────────────── run ───────────────────────────── */

const catalog = await catalogPlates();
const PRICES = await listPricesOf(pool, COMPANY, catalog.map((c) => c.id));
for (const [job, dir] of JOBS) {
  if (ONLY_JOB && ONLY_JOB !== job) continue;
  const t0 = Date.now();
  const Ts = readJob(job, dir).filter((T) => !THICK || THICK.has(T.t));
  console.log(`\n=== ${job}: ${Ts.map((T) => `${T.t} mm (${T.nests.length} nests, ${[...T.parts.values()].reduce((a, p) => a + p.qty, 0)} pcs, kerf ${T.kerf})`).join(' · ')}`);
  const prepared = Ts.map((T) => prepare(T, catalog));

  // ProNest side
  const tPro = Date.now();
  for (const pr of prepared) {
    for (const n of pr.T.nests) n.m = measurePlate({ L: n.L, W: n.W, t: pr.T.t, kerf: pr.kerf, pieces: n.pieces, offcutRule: pr.offcutRule });
  }
  console.log(`  ProNest measured in ${((Date.now() - tPro) / 1000).toFixed(1)} s`);

  // AI side — one plan budget for the whole job, as a Standard background run
  const level = EFFORT[EFF === 'long' ? 'deep' : EFF] ?? EFFORT.standard;
  const seedCount = Math.max(1, level.seeds ?? 1);
  const planBudgetMs = NS.runBudgetMs(EFF);
  const reserveMs = Math.min(30_000, Math.round(planBudgetMs * 0.1));
  const tPack = Date.now();
  const deadlineAt = tPack + planBudgetMs - reserveMs;
  const jobs = [];
  for (const pr of prepared) {
    seedsFor(1, seedCount).forEach((seed, round) => jobs.push({
      key: String(pr.T.t), seed, round,
      input: { packer: 'shape', seed, rect: { ...pr.packInput, seed }, shape: { ...pr.shapeInput, seed }, fillSheets: [], pieces: pr.packInput.pieces, sheets: pr.packInput.sheets, ...(pr.realShapes ? { shapesDecide: true } : {}) },
    }));
  }
  console.log(`  packing ${jobs.length} jobs (${seedCount} seeds × ${prepared.length} thicknesses), budget ${planBudgetMs / 1000} s`);
  const runs = await runAll(jobs, { deadlineAt, onJob: ({ job: j, result, done, total: tot }) => console.log(`    ${j.key} mm seed#${j.round + 1}: ${result?.skipped ? `skipped (${result.skipped})` : result?.ok ? `${(result.out?.nests ?? []).length} plates, chosen ${result.out?.chosen}, off ${(result.out?.unplaced ?? []).reduce((a, u) => a + (Number(u.qty) || 0), 0)}` : `failed ${result?.error}`}  [${done}/${tot}, ${((Date.now() - tPack) / 1000).toFixed(0)} s]`) });
  const packMs = Date.now() - tPack;
  const rows = [];
  for (const pr of prepared) {
    const mine = runs.map((r, i) => ({ ...r, seed: jobs[i].seed, key: jobs[i].key })).filter((r) => r.key === String(pr.T.t) && !r.skipped);
    const best = pickBest(mine);
    const ai = aiNests(pr, best?.out ?? {});
    for (const n of ai.nests) n.m = measurePlate({ L: n.L, W: n.W, t: pr.T.t, kerf: pr.kerf, pieces: n.pieces, offcutRule: pr.offcutRule });
    const pro = pr.T.nests;
    const row = {
      t: pr.T.t, kerf: pr.kerf, files: [...pr.T.files], pieces: [...pr.T.parts.values()].reduce((a, p) => a + p.qty, 0), partTypes: pr.T.parts.size,
      realShapes: pr.realShapes, mirroredInProNest: [...pr.T.parts.values()].reduce((a, p) => a + p.mirroredSeen, 0),
      settings: { kerf: pr.settings.kerfMm, edge: pr.settings.edgeMarginMm, blockGap: pr.settings.groupGapMm, rimShape: pr.rim.shapeMargin, rimRect: pr.rim.rectMargin, offcutRule: pr.offcutRule },
      offered: pr.sheets.map((s) => `${s.length}×${s.width}${s.from === 'pronest' ? '*' : ''}`),
      ai: { chosen: ai.chosen, unplaced: ai.unplaced, seed: best?.seed ?? null, deterministic: best?.out?.deterministic ?? null, stopped: best?.out?.stopped ?? null, elapsedMs: best?.out?.elapsedMs ?? null, total: total(ai.nests), plates: ai.nests },
      pronest: { total: total(pro), seqEntries: pro.reduce((a, n) => a + (n.seqEntries ?? 0) * n.qty, 0), seqKnown: pro.every((n) => n.seqEntries != null && n.seqEntries > 0), plates: pro },
    };
    rows.push(row);
    const P = row.pronest.total; const A = row.ai.total;
    console.log(`  ${pr.T.t} mm  ProNest ${P.plates} pl ${P.tonnes.toFixed(3)} t util ${P.util.toFixed(1)}%  |  AI(${ai.chosen}) ${A.plates} pl ${A.tonnes.toFixed(3)} t util ${A.util?.toFixed(1)}% off ${ai.unplaced}`);
  }
  const res = { job, variant: PLATES, effort: EFF, legacy: LEGACY, company: COMPANY, ranAt: new Date().toISOString(), runMs: Date.now() - t0, packMs, planBudgetMs, rows };
  const file = path.join(OUT, `${job}_${PLATES}${EFF === 'standard' ? '' : `_${EFF}`}${THICK ? `_t${[...THICK].join('-')}` : ''}.json`);
  fs.writeFileSync(file, JSON.stringify(res, (k, v) => (typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * 1000) / 1000 : v)));
  console.log(`  wrote ${file}  (${(res.runMs / 1000).toFixed(0)} s)`);
}
await pool.end().catch(() => {});
process.exit(0);
