/**
 * nestCompareService.js — CF_ERP. The uploaded nesting beside our automatic one (user,
 * 2026-10-10: "While accepting, give an option to compare that with auto nesting and show the
 * comparision side by side in terms of metrics ( and if an auto run already happened, then just
 * pull that up and compare )").
 *
 *   GET  …/nesting/compare?with=auto       getCompare     never packs — reads, measures, pulls up
 *   POST …/nesting/compare { run: true }   startCompare   starts the automatic side in the background
 *   POST …/nesting/compare/accept          acceptCompare  { side: 'uploaded' | 'auto', runId }
 *
 * LIKE FOR LIKE. The automatic side nests THE SAME SET OF PIECES the uploaded plates hold — no
 * more, no fewer (planNesting's `only`) — so plates, steel, waste, cut length and cost are
 * comparable. A second figure nests the WHOLE line, for when the upload covers only part of it.
 *
 * THE RUN THAT ALREADY HAPPENED. Every finished run is in cf_nest_runs with the fingerprint of
 * what it was asked (nestingService.demandOf: the pieces × the cut settings × the plate choices ×
 * the drawings). The comparison works out the fingerprint of what it needs NOW and takes the
 * newest finished run that carries it — whether a comparison made it or a person's own nesting
 * run did. A run with another fingerprint answers another question: it is reported as STALE and
 * never shown as if it were current. Nothing is packed on a GET; `POST { run: true }` starts what
 * is missing and returns the run id to poll.
 *
 * THE SAME MEASURES ON BOTH SIDES, by the same code: steel by weight, waste by cause
 * (nestingService.wasteOfLot), cut length and piercings (plateCutsService.cutsOfLots — what a
 * saved nest writes on its cut plates), and cost by the order's own plate rate (2026-10-16:
 * valuationService.plateRatesPerKg × the plate's kg — average cost, else last receipt, else the last
 * price paid, else the list price; `basis` says which). A plate with none of them has NO cost: the
 * total is then null with the reason, never a partial sum, never zero.
 *
 * THE AUTOMATIC COMPARISON AFTER AN UPLOAD (2026-10-16, the user: "whenever we are uploading the
 * nesting done manually by the customer … run a standard nesting and show a comparison. Don't block
 * the user … Store the auto generated one. Even if the user opens it later, he can see."). When an
 * upload is SAVED (the files route, a lot taken off, or a plate-change request approved), the route
 * calls scheduleAutoCompare: it answers at once, and on the next turn of the event loop
 * startAutoCompare starts a STANDARD run of exactly the pieces the uploaded plates hold (scope
 * 'subset', `only`) — like for like. Pieces the upload left over, and pieces marked as cut from
 * untracked offcuts, are in neither side; the answer says them apart (`leftOverSummary`). It is an
 * ordinary background run (nestRunService): its row is written when it starts, it checkpoints, and
 * a restart picks it up again. A newer upload with other pieces makes it STALE (another demand) and
 * starts its own; one with the same pieces is answered by the run already there.
 *
 * ACCEPTING. `uploaded` keeps what is saved and marks the run discarded. `auto` replaces the
 * uploaded plates with the run's WHOLE-LINE plan through acceptNesting (replaceImported), which
 * verifies the geometry against the database and works every derived number out again.
 */
import { createHash } from 'node:crypto';
import { pool } from '../lib/db.js';
import { invalid, notFound } from '../lib/errors.js';
import {
  importContext, importBlocker, acceptNesting, kgOf, lineHead, exclusionsOfLine, demandFor, assertFrozen, effortOf,
} from './nestingService.js';
import { savedLotsOf, coverageOfLots, isUploadedPiece, measureSavedLots } from './nestDxfImportService.js';
import { drawingFactsOfLine } from './partDrawingService.js';
import { untrackedOfLine } from '../lib/nestUntracked.js';
import { cutsOfLotsAsync } from './plateCutsService.js';
import { plateRatesPerKg } from './valuationService.js';
import { shapeOfCutPlate } from './nestShapes.js';
import { startRun, memoryRun, snapshot, unpackPlan, packPlan, resumeRun, settleRuns, cancelRun } from './nestRunService.js';
// §87 (2026-10-18): the AI alternative stored beside the uploaded nesting, and which of the two is the main one.
import { readAlternative, recordAlternativeRun, alternativeView } from './nestAlternativeService.js';
import { savedLotsOf as savedLotsById } from './nestingService.js';
import { gradeCheck } from '../lib/plateGrade.js';

const WASTE_KEYS = ['kerf', 'sequenceGaps', 'rim', 'offcut', 'wastage'];
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const r3 = (n) => Math.round(Number(n) * 1000) / 1000;
const parseJson = (v) => { if (v == null) return null; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return null; } };
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const missingTable = (e) => e?.code === 'ER_NO_SUCH_TABLE' || e?.errno === 1146;

/* ───────────────────────────── cost ───────────────────────────── */

/**
 * What one plate of each size costs — Map plateItemId → { unit, basis } | { unit: null, reason }.
 * THE ORDER'S OWN PLATE RATE (2026-10-16, the user: plate rates as the order's costs price them):
 * valuationService.plateRatesPerKg — average cost, else last receipt, else the last price paid on a PO,
 * else the list price, per kg — × the plate's kg. The same rule as the plate-change impact sheet and
 * the order's costs. A plate with none has NO price: the total is then "not costed", never 0.
 * A fixed number of reads whatever the number of plates.
 */
async function plateCosts(db, companyId, line, plates) {
  const ids = [...new Set(plates.map((p) => Number(p.id)))];
  const out = new Map();
  if (!ids.length) return out;
  const rates = await plateRatesPerKg(db, companyId, ids);
  for (const p of plates) {
    const id = Number(p.id);
    const r = rates.get(id);
    const kg = p.steel?.length > 0 ? kgOf(p.steel.length * p.steel.width, p.steel.thickness, p.steel.density) : 0;
    out.set(id, r && kg > 0
      ? { unit: r2(r.perKg * kg), basis: r.basis, perKg: r.perKg }
      : { unit: null, reason: `${p.code ?? `plate ${id}`} has no plate rate: never received, never bought and no list price.` });
  }
  void line;
  return out;
}

/* ───────────────────────────── measuring a nesting ───────────────────────────── */

/**
 * One plate as the measures read it, from a proposal's nest or from a saved lot:
 * { lotNo, plateItemId, plateCode, length, width, thickness, density, ownerPartyId, kerfMm,
 *   pieces [{ cutPlateId, x, y, length, width, rotationDeg }], waste, wasteKg, partsKg, offcuts }.
 */
const fromPlanNest = (n, g) => ({
  lotNo: n.lotNo, plateItemId: n.plateItemId, plateCode: n.plateCode, length: n.length, width: n.width, thickness: n.thickness, density: n.density,
  ownerPartyId: n.ownerPartyId ?? null, kerfMm: g?.kerfMm ?? n.kerfMm ?? 0, origin: n.origin ?? 'auto', lotId: n.lotId ?? n.id ?? null,
  // A plate laid out by true shape is cut along its outlines (plateCutsService: free layouts).
  free: n.layout === 'free',
  pieces: (n.pieces ?? []).map((p, i) => ({ key: i, cutPlateId: p.cutPlateId, x: p.x, y: p.y, length: p.length, width: p.width, rotationDeg: p.rotationDeg ?? (p.rotated ? 90 : 0), rings: p.rings ?? null })),
  waste: n.waste, wasteKg: n.wasteKg, partsKg: n.partsKg, offcuts: n.offcuts ?? [],
  // §90: a plate of a custom size the AI proposed (no catalog plate yet unless `inCatalog`).
  customPlate: n.customPlate ?? null,
});

/** Saved lots as the measures read them — [[lot, pieces], …] — measured together, off this thread. */
async function fromSavedLots(pairs, ctx) {
  const measured = await measureSavedLots(pairs, ctx);
  return pairs.map(([lot, pieces], i) => fromSavedLot(lot, pieces, measured[i]));
}
function fromSavedLot(lot, pieces, m) {
  return {
    lotNo: lot.lotNo, lotId: lot.id, plateItemId: lot.plateItemId, plateCode: lot.plateCode, length: lot.length, width: lot.width, thickness: lot.thickness, density: lot.density,
    ownerPartyId: lot.ownerPartyId ?? null, kerfMm: lot.kerfMm, origin: lot.origin, sourceFile: lot.sourceFile ?? null,
    free: lot.sourceKind === 'shape' || lot.layoutOrigin === 'customer' || lot.waste?.layout === 'free' || m.pieces.some((p) => p.shaped && p.x != null),
    pieces: m.pieces.map((p, i) => ({ key: i, cutPlateId: p.cutPlateId, x: p.x, y: p.y, length: p.length, width: p.width, rotationDeg: p.rotationDeg, rings: p.placedRings ?? null })),
    waste: m.waste.waste, wasteKg: m.waste.wasteKg, partsKg: m.waste.partsKg, offcuts: m.waste.offcuts,
  };
}

/**
 * THE METRICS of a set of plates — one function for both sides of the comparison.
 * Every number is worked out; `cost.value` is null (with `cost.reason`) when any plate has no cost.
 */
export async function nestingMetrics(nests, { facts, sizeOf, costs, cuts: withCuts = true }) {
  let boughtKg = 0; let partsKg = 0; let pieces = 0;
  const wasteKg = Object.fromEntries(WASTE_KEYS.map((k) => [k, 0]));
  const offcut = { count: 0, kg: 0, largestKg: null, largestAreaM2: null };
  let cost = 0; let customerPlates = 0;
  const uncosted = [];
  const bases = new Set();
  const perPlate = [];
  for (const n of nests) {
    const plateKg = kgOf(n.length * n.width, n.thickness, n.density);
    boughtKg += plateKg; partsKg += Number(n.partsKg ?? 0); pieces += n.pieces.length;
    for (const k of WASTE_KEYS) wasteKg[k] += Number(n.wasteKg?.[k] ?? 0);
    const offKg = (n.offcuts ?? []).reduce((a, o) => a + Number(o.weightKg ?? 0), 0);
    for (const o of n.offcuts ?? []) {
      offcut.count += 1; offcut.kg += Number(o.weightKg ?? 0);
      if (offcut.largestKg == null || Number(o.weightKg ?? 0) > offcut.largestKg) { offcut.largestKg = Number(o.weightKg ?? 0); offcut.largestAreaM2 = r3(Number(o.area ?? 0) / 1e6); }
    }
    let plateCost = null; let basis = null;
    if (n.ownerPartyId) { plateCost = 0; basis = "the customer's own plate"; customerPlates += 1; } else {
      // §90: a custom size not in the catalog yet is priced at the per-kg rate of the plate it replaces.
      const custom = n.customPlate && (n.plateItemId == null || n.plateItemId === '');
      const c = costs.get(Number(custom ? n.customPlate.replaces?.plateItemId : n.plateItemId));
      const unit = custom ? (c?.perKg != null && plateKg > 0 ? r2(c.perKg * plateKg) : null) : c?.unit;
      if (unit != null) { plateCost = unit; basis = custom ? `${c.basis} (the rate of the plate it replaces)` : c.basis; bases.add(c.basis); cost += unit; } else if (!uncosted.includes(n.plateCode ?? `plate ${n.plateItemId}`)) uncosted.push(n.plateCode ?? `plate ${n.plateItemId}`);
    }
    perPlate.push({
      lotNo: n.lotNo, lotId: n.lotId ?? null, origin: n.origin ?? null, file: n.sourceFile ?? null,
      plateItemId: n.plateItemId, plateCode: n.plateCode, thickness: n.thickness, length: n.length, width: n.width,
      // The kerf this plate is measured with (waste by cause, shared cuts): the one recorded on the saved plate, or the proposal's.
      kerfMm: n.kerfMm == null ? null : Number(n.kerfMm),
      pieces: n.pieces.length, plateKg: r3(plateKg), partsKg: r3(Number(n.partsKg ?? 0)),
      wastePct: plateKg > 0 ? r3(((plateKg - Number(n.partsKg ?? 0)) / plateKg) * 100) : null,
      wasteKg: Object.fromEntries(WASTE_KEYS.map((k) => [k, r3(Number(n.wasteKg?.[k] ?? 0))])),
      offcuts: (n.offcuts ?? []).length, offcutKg: r3(offKg), cost: plateCost, costBasis: basis,
      // §90: a custom plate size — 'not in the catalog yet' until the nesting is used (inCatalog false).
      custom: n.customPlate ? { inCatalog: !!n.customPlate.inCatalog, length: n.customPlate.length, width: n.customPlate.width, grade: n.customPlate.grade ?? null, impactClass: n.customPlate.impactClass ?? null, replaces: n.customPlate.replaces ?? null } : null,
    });
  }
  // `cuts: false` (the plate-change sheet, which shows no cut length): the true-shape cut walk is skipped — null below.
  const cuts = withCuts ? await cutsOfLotsAsync(nests.map((n) => ({ kerf: n.kerfMm, pieces: n.pieces, free: !!n.free })), facts, sizeOf) : { cutLengthMm: null, sharedMm: null, piercings: null };
  return {
    metrics: {
      plates: nests.length, pieces,
      tonnesBought: r3(boughtKg / 1000), partsTonnes: r3(partsKg / 1000),
      wastePct: boughtKg > 0 ? r3(((boughtKg - partsKg) / boughtKg) * 100) : null,
      ...(boughtKg > 0 ? {} : { wastePctReason: nests.length ? 'The plates have no weight on record (no density, or no size), so waste cannot be given as a share of the steel bought.' : 'There are no plates.' }),
      wasteKgTotal: r3(boughtKg - partsKg),
      wasteKg: Object.fromEntries(WASTE_KEYS.map((k) => [k, r3(wasteKg[k])])),
      offcuts: { count: offcut.count, kg: r3(offcut.kg), largestKg: offcut.largestKg == null ? 0 : r3(offcut.largestKg), largestAreaM2: offcut.largestAreaM2 ?? 0 },
      cutLengthM: cuts.cutLengthMm == null ? null : r3(cuts.cutLengthMm / 1000), sharedCutM: cuts.sharedMm == null ? null : r3(cuts.sharedMm / 1000), piercings: cuts.piercings,
      // NET STEEL (§87, 2026-10-18): what the job really consumes when every offcut is kept and used again — bought − offcuts.
      netTonnes: r3((boughtKg - offcut.kg) / 1000),
      cost: uncosted.length
        ? { value: null, currency: 'INR', basis: null, customerPlates, reason: `No cost for ${uncosted.join(', ')}: ${uncosted.length === 1 ? 'it has' : 'they have'} never been received or bought and ${uncosted.length === 1 ? 'has' : 'have'} no list price, so the nesting cannot be priced.` }
        : { value: r2(cost), currency: 'INR', basis: [...bases].join(' / ') || (customerPlates ? "the customer's own plates" : null), customerPlates, reason: null },
    },
    perPlate,
  };
}

/**
 * §90 (item 22): the grade check of one side's plates (lib/plateGrade.gradeCheck) — each piece's steel (its cut plate)
 * against its plate's (the catalog plate; a custom size not in the catalog yet carries its own). A plate the catalog no
 * longer has is left out (nothing to say of it). → (nests) → { ok, rule, mismatches, unknown, substitutes, sentence }
 */
function sideGrade(plates, cpById, rule) {
  const byId = new Map((plates ?? []).map((p) => [Number(p.id), p]));
  return (nests) => gradeCheck(nests.map((n) => {
    const plate = n.customPlate && (n.plateItemId == null || n.plateItemId === '') ? n.customPlate : byId.get(Number(n.plateItemId))?.steel;
    if (!plate) return null;
    return { lotNo: n.lotNo, plateCode: n.plateCode, plate, pieces: n.pieces.map((p) => { const cp = cpById.get(Number(p.cutPlateId)); return { cutPlateId: p.cutPlateId, code: cp?.code ?? null, steel: cp?.steel ?? {} }; }) };
  }).filter(Boolean), rule);
}

const nestsOfPlan = (plan) => (plan?.groups ?? []).flatMap((g) => (g.nests ?? []).map((n) => fromPlanNest(n, g)));

/* ───────────────────────────── the state of a comparison ───────────────────────────── */

async function runRows(db, companyId, lineId) {
  try {
    const [rows] = await db.query(
      `SELECT id, run_uid, scope, purpose, status, demand_hash, params_json, metrics_json, error_json, started_at, finished_at, started_by_name, (plan_json IS NOT NULL) AS has_plan
         FROM cf_nest_runs
        WHERE company_id = ? AND order_line_id = ? AND kind = 'auto' AND deleted_at IS NULL
        ORDER BY id DESC LIMIT 40`,
      [companyId, lineId],
    );
    return rows;
  } catch (e) { if (missingTable(e)) return []; throw e; }
}

const USABLE = new Set(['ready', 'accepted', 'discarded']);
const describeRun = (row) => (row ? {
  runId: row.run_uid, rowId: row.id, scope: row.scope, purpose: row.purpose, status: row.status,
  decision: row.status === 'accepted' ? 'auto' : row.status === 'discarded' ? 'uploaded' : null,
  ranAt: row.finished_at ?? row.started_at, startedBy: row.started_by_name ?? null,
  params: (() => { const p = parseJson(row.params_json) ?? {}; return { effort: p.effort ?? 'standard', seed: p.seed ?? 1, guillotine: p.guillotine ?? null }; })(),
  // 2026-10-16: 'upload' = started by the server after an upload was saved; 'person' = somebody pressed Run.
  trigger: parseJson(row.params_json)?.trigger ?? 'person',
  // The upload it was started for: { key, plates, pieces } (null for a run a person started).
  upload: parseJson(row.params_json)?.upload ?? null,
} : null);

/**
 * Everything the three entry points need, read once: the line, what is saved, the two demands
 * and the runs that answer them.
 */
export async function compareState(db, companyId, lineId, { alt: knownAlt } = {}) {
  const ctx = await importContext(db, companyId, lineId);
  const [saved, facts, excl, untracked] = await Promise.all([savedLotsOf(db, companyId, lineId), drawingFactsOfLine(db, companyId, lineId), exclusionsOfLine(db, companyId, lineId), untrackedOfLine(db, companyId, lineId)]);
  const cpById = new Map(ctx.cutPlates.map((cp) => [cp.id, cp]));
  const shapes = new Map();
  const shapeOf = (cp) => { if (!shapes.has(cp.id)) shapes.set(cp.id, shapeOfCutPlate(cp, facts)); return shapes.get(cp.id); };
  const mctx = { cpById, shapeOf, settingRows: ctx.settingRows, plates: ctx.plates };
  let uploadedLots = saved.filter((l) => l.origin === 'imported');
  // §87: AI's nesting made the MAIN one — the customer's plates are kept (soft-deleted) and read back by id, so the
  // comparison stands as it was: the same upload, the same pieces, the same demand, the same AI run.
  const alt = knownAlt !== undefined ? knownAlt : await readAlternative(db, companyId, lineId);
  const swapped = !!alt && alt.main === 'ai' && alt.valid && !uploadedLots.length;
  if (swapped) uploadedLots = await savedLotsById(db, companyId, lineId, { ids: alt.uploadLotIds });
  const subset = new Map();
  for (const l of uploadedLots) for (const p of l.pieces) if (isUploadedPiece(l, p)) subset.set(p.cutPlateId, (subset.get(p.cutPlateId) ?? 0) + 1);
  // Never more of a cut plate than the line needs: an over-covered upload is compared on what the line needs.
  const only = Object.fromEntries([...subset].map(([id, q]) => [id, Math.min(q, cpById.get(id)?.pieces ?? 0)]).filter(([, q]) => q > 0));
  // WHICH UPLOAD this is (2026-10-16): the uploaded plates, their files and where every customer part sits — a new
  // upload changes it even when it nests the same pieces. Stored with the automatic run started for it.
  const uploadKey = uploadedLots.length
    ? createHash('sha256').update(JSON.stringify(uploadedLots.map((l) => [l.id, l.nestFileId ?? null, l.plateItemId, l.pieces.filter((p) => isUploadedPiece(l, p)).map((p) => [p.cutPlateId, p.x, p.y]).sort()]).sort((a, b) => a[0] - b[0]))).digest('hex').slice(0, 16)
    : null;

  // The two questions an automatic run can be asked here, fingerprinted from what is already read
  // (demandFor — the same selection and hash planNesting reports for a run).
  let demandSubset = null; let demandLine = null; let demandError = null;
  try {
    assertFrozen(ctx.line);
    const args = { line: ctx.line, needed: ctx.cutPlates, everyPlate: ctx.plates, settingRows: ctx.settingRows, excl, facts, untracked };
    demandLine = demandFor({ ...args, replaceImported: true });
    demandSubset = Object.keys(only).length ? demandFor({ ...args, only }) : null;
  } catch (e) { demandError = { code: e?.code ?? 'INVALID', message: e?.message ?? String(e) }; }

  // A run flips to "done" in memory a moment BEFORE its row is written (the write is queued behind
  // it). Read in that moment, the line has no running run and no row for this demand — and the
  // comparison answered "stale" (an older run's row) or "none" for a run that had just finished.
  // So the line's own run is given the time to land its row first: one short database write.
  let mem = memoryRun(companyId, lineId);
  if (mem && mem.status !== 'running' && mem.persist) await mem.persist;
  let rows = await runRows(db, companyId, lineId);
  const lost = rows.filter((r) => r.status === 'running' && r.run_uid !== mem?.id).map((r) => r.run_uid);
  // A run the server slept or restarted under is PICKED UP AGAIN from its checkpoint (nestRunService.resumeRun);
  // only one that cannot be is marked failed there, with the reason.
  if (lost.length) { await resumeRun(companyId, lineId, { db }); mem = memoryRun(companyId, lineId); rows = await runRows(db, companyId, lineId); }
  const newest = (hash) => (hash ? rows.find((r) => r.demand_hash === hash && USABLE.has(r.status) && Number(r.has_plan)) ?? null : null);
  const rowSubset = newest(demandSubset?.hash);
  const rowLine = newest(demandLine?.hash);
  // A finished run of ANOTHER demand: what "stale" means.
  const stale = rows.find((r) => USABLE.has(r.status) && r.demand_hash && r.demand_hash !== demandSubset?.hash && r.demand_hash !== demandLine?.hash) ?? null;
  const failed = rows.find((r) => r.status === 'failed') ?? null;
  return { ctx, saved, facts, excl, untracked, cpById, mctx, uploadedLots, subset, only, uploadKey, demandSubset, demandLine, demandError, rows, mem, rowSubset, rowLine, stale, failed, alt, swapped };
}

export async function plansOf(db, companyId, rowIds) {
  const ids = [...new Set(rowIds.filter(Boolean))];
  const out = new Map();
  if (!ids.length) return out;
  const [rows] = await db.query('SELECT id, plan_json, plan_encoding FROM cf_nest_runs WHERE company_id = ? AND id IN (?)', [companyId, ids]);
  for (const r of rows) out.set(r.id, unpackPlan(r.plan_json, r.plan_encoding)?.plan ?? null);
  return out;
}

const money = (v) => `₹${Math.abs(Math.round(v)).toLocaleString('en-IN')}`;

/** The delta (automatic − uploaded) and the verdict in words. */
function judge(up, auto) {
  if (!up || !auto) return { delta: null, verdict: null };
  // delta.cost is null exactly when one side cannot be priced: say which, in its own words.
  const costReason = auto.cost.value == null ? auto.cost.reason : up.cost.value == null ? up.cost.reason : null;
  const d = (a, b) => (a == null || b == null ? null : r3(a - b));
  const delta = {
    plates: auto.plates - up.plates,
    tonnesBought: d(auto.tonnesBought, up.tonnesBought), partsTonnes: d(auto.partsTonnes, up.partsTonnes),
    wastePct: d(auto.wastePct, up.wastePct), wasteKgTotal: d(auto.wasteKgTotal, up.wasteKgTotal),
    offcutKg: d(auto.offcuts.kg, up.offcuts.kg), cutLengthM: d(auto.cutLengthM, up.cutLengthM), piercings: d(auto.piercings, up.piercings),
    cost: auto.cost.value == null || up.cost.value == null ? null : r2(auto.cost.value - up.cost.value),
    ...(costReason ? { costReason } : {}),
  };
  const say = [];
  const steel = delta.tonnesBought;
  const who = (v) => (v < 0 ? 'Our automatic nesting' : 'The uploaded nesting');
  if (Math.abs(steel) < 0.0005 && delta.plates === 0) say.push('Both buy the same steel on the same number of plates.');
  else {
    const better = steel < -0.0005 || (Math.abs(steel) < 0.0005 && delta.plates < 0) ? -1 : 1;
    const bits = [];
    if (delta.plates !== 0) bits.push(`${plural(Math.abs(delta.plates), 'plate', 'plates')} ${Math.sign(delta.plates) === better ? 'fewer' : 'more'}`);
    if (Math.abs(steel) >= 0.0005) bits.push(`${Math.abs(steel).toFixed(3)} t ${Math.sign(steel) === better ? 'less' : 'more'} steel`);
    say.push(`${who(better)} buys ${bits.join(' and ')}${delta.cost != null && Math.abs(delta.cost) >= 0.5 ? ` (${money(delta.cost)} ${Math.sign(delta.cost) === better ? 'less' : 'more'})` : ''}.`);
  }
  if (delta.wastePct != null && Math.abs(delta.wastePct) >= 0.05) say.push(`Waste is ${Number(auto.wastePct).toFixed(1)}% automatic against ${Number(up.wastePct).toFixed(1)}% uploaded.`);
  if (delta.cutLengthM != null && Math.abs(delta.cutLengthM) >= 0.5) say.push(`The automatic layout cuts ${Math.abs(delta.cutLengthM).toFixed(1)} m ${delta.cutLengthM > 0 ? 'more' : 'less'}.`);
  if (delta.cost == null) say.push('Cost cannot be compared: a plate has no cost yet.');
  return { delta, verdict: say.join(' ') };
}

/**
 * THE VERDICT IN ONE PLAIN LINE (2026-10-16, the Compare tab): ours against the customer's, plates, steel and
 * money, each with its own direction. "Ours uses 2 plates fewer, 1.4 t less steel and ₹61,924 less."
 * Cost not known on a side: "Cost cannot be compared yet: a plate has no rate." Null without a delta.
 */
export function headlineOf(delta) {
  if (!delta) return null;
  const bits = [];
  if (delta.plates) bits.push(`${plural(Math.abs(delta.plates), 'plate', 'plates')} ${delta.plates < 0 ? 'fewer' : 'more'}`);
  const t = Number(delta.tonnesBought ?? 0);
  if (Math.abs(t) >= 0.0005) bits.push(`${Math.abs(t) >= 1 ? `${Math.abs(t).toFixed(1)} t` : `${Math.round(Math.abs(t) * 1000).toLocaleString('en-IN')} kg`} ${t < 0 ? 'less' : 'more'} steel`);
  if (delta.cost != null && Math.abs(delta.cost) >= 0.5) bits.push(`${money(delta.cost)} ${delta.cost < 0 ? 'less' : 'more'}`);
  const costWord = delta.cost == null ? ' Cost cannot be compared yet: a plate has no rate.' : '';
  if (!bits.length) return `AI's nesting and the customer's use the same plates and the same steel.${costWord}`;
  const list = bits.length === 1 ? bits[0] : `${bits.slice(0, -1).join(', ')} and ${bits.at(-1)}`;
  return `AI's nesting uses ${list}.${costWord}`;
}

/**
 * THE FIGURES PER THICKNESS (2026-10-16), from each side's perPlate: plates, steel bought, parts, waste (bought −
 * parts: offcuts INCLUDED — the user's rule), offcut kg and cost (null = "not costed": a plate of it has no rate).
 * → [{ thickness, uploaded: { plates, tonnesBought, partsTonnes, wasteKg, wastePct, offcutKg, cost } | null, auto: … | null }]
 */
export function byThickness(upPlates, autoPlates) {
  const agg = (plates) => {
    if (!plates.length) return null;
    const kgB = plates.reduce((a, p) => a + Number(p.plateKg ?? 0), 0);
    const kgP = plates.reduce((a, p) => a + Number(p.partsKg ?? 0), 0);
    const uncosted = plates.some((p) => p.cost == null);
    return {
      plates: plates.length, tonnesBought: r3(kgB / 1000), partsTonnes: r3(kgP / 1000),
      wasteKg: r3(kgB - kgP), wastePct: kgB > 0 ? r3(((kgB - kgP) / kgB) * 100) : null,
      offcutKg: r3(plates.reduce((a, p) => a + Number(p.offcutKg ?? 0), 0)),
      cost: uncosted ? null : r2(plates.reduce((a, p) => a + Number(p.cost ?? 0), 0)),
    };
  };
  const keys = [...new Set([...upPlates, ...autoPlates].map((p) => Number(p.thickness ?? 0)))].sort((a, b) => a - b);
  return keys.map((t) => ({
    thickness: t || null,
    uploaded: agg(upPlates.filter((p) => Number(p.thickness ?? 0) === t)),
    auto: agg(autoPlates.filter((p) => Number(p.thickness ?? 0) === t)),
  }));
}

/**
 * WHAT TAKING THE AUTOMATIC SIDE REPLACES, IN NUMBERS — for the confirm on the screen. Accepting
 * "auto" replaces the WHOLE line's nesting (every plate, the customer's and ours alike) with the
 * run's whole-line plan; this says how much that is before anyone presses the button.
 *   saved      every plate saved on the line (savedLotsOf)
 *   withPlan   the whole-line plan that would be written, or null when it is not worked out yet
 *   leftOver   what would be left un-nested afterwards (held back by hand / left out), when known
 */
export function willReplaceOf(saved, withPlan, cutPlates = [], excl = null) {
  const customer = saved.filter((l) => l.origin === 'imported');
  const ours = saved.filter((l) => l.origin !== 'imported');
  const count = (lots, f) => lots.reduce((a, l) => a + l.pieces.filter((p) => f(l, p)).length, 0);
  const customerPieces = count(customer, (l, p) => isUploadedPiece(l, p));
  const ourPiecesOnCustomerPlates = count(customer, (l, p) => !isUploadedPiece(l, p));
  const ourPieces = count(ours, () => true);
  const files = customer.filter((l) => l.nestFileId != null || l.sourceFile).length;
  const nests = withPlan ? (withPlan.groups ?? []).flatMap((g) => g.nests ?? []) : null;
  const withPieces = nests ? nests.reduce((a, n) => a + (n.pieces ?? []).length, 0) : null;
  const notNested = withPlan ? cutPlates.filter((cp) => cp.pieces > 0 && (cp.manual || excl?.cutPlates?.has(cp.id))).reduce((a, cp) => a + cp.pieces, 0) : null;
  const bits = [
    customer.length ? `${plural(customer.length, 'uploaded plate', 'uploaded plates')} (${plural(customerPieces, 'piece', 'pieces')} as the customer nested them${ourPiecesOnCustomerPlates ? `, and ${plural(ourPiecesOnCustomerPlates, 'piece', 'pieces')} added by AI` : ''})` : null,
    ours.length ? `${plural(ours.length, 'plate', 'plates')} nested by AI (${plural(ourPieces, 'piece', 'pieces')})` : null,
  ].filter(Boolean);
  return {
    side: 'auto',
    customerPlates: customer.length, ourPlates: ours.length, plates: saved.length,
    customerPieces, ourPiecesOnCustomerPlates, ourPieces, pieces: customerPieces + ourPiecesOnCustomerPlates + ourPieces,
    customerFiles: files,
    withPlates: nests ? nests.length : null, withPieces, notNestedAfter: notNested,
    // Why the three figures above are null, when they are.
    withReason: nests ? null : 'The automatic nesting of the whole line is not worked out yet — start the comparison (or run it again) and these are filled in.',
    message: !saved.length ? 'Nothing is saved on this line yet, so nothing would be replaced.'
      : `Taking AI's nesting replaces everything saved on this line: ${bits.join(' and ')}${files ? `; the ${plural(files, "customer's file", "customer's files")} ${files === 1 ? 'goes' : 'go'} with ${files === 1 ? 'its plate' : 'their plates'} (a copy of the uploaded nesting is kept with the run)` : ''}.${nests ? ` In their place: ${plural(nests.length, 'plate', 'plates')} holding ${plural(withPieces, 'piece', 'pieces')}${notNested ? `; ${plural(notNested, 'piece stays', 'pieces stay')} un-nested (held back by hand or left out)` : ''}.` : ' The automatic nesting of the whole line is not worked out yet.'}`,
  };
}

/* ───────────────────────────── GET ───────────────────────────── */

/**
 * GET …/nesting/compare?with=auto — both sides, measured the same way. Never packs.
 * `detail` adds the automatic side's proposal itself (`auto.plan`) so its plates can be drawn.
 */
export async function getCompare(db, companyId, lineId, { with: other = 'auto', detail = false } = {}) {
  if (other != null && String(other).toLowerCase() !== 'auto') throw invalid('INVALID', 'An uploaded nesting is compared with "auto" — AI\'s nesting.');
  const st = await compareState(db, companyId, lineId);
  const { ctx } = st;
  const sizeOf = new Map(ctx.cutPlates.map((cp) => [cp.id, cp.steel ?? {}]));
  const plans = await plansOf(db, companyId, [st.rowSubset?.id, st.rowLine?.id]);
  const planSubset = st.rowSubset ? plans.get(st.rowSubset.id) : null;
  const planLine = st.rowLine ? plans.get(st.rowLine.id) : null;

  // Every plate either side names, costed in one go.
  const autoNests = planSubset ? nestsOfPlan(planSubset) : [];
  const lineNests = planLine && planLine !== planSubset ? nestsOfPlan(planLine) : autoNests;
  const bothSides = await fromSavedLots([
    ...st.uploadedLots.map((l) => [l, l.pieces.filter((p) => isUploadedPiece(l, p))]),
    ...st.saved.map((l) => [l, l.pieces]),
  ], st.mctx);
  const upNests = bothSides.slice(0, st.uploadedLots.length);
  const savedNests = bothSides.slice(st.uploadedLots.length);
  const plateIds = new Set([...autoNests, ...lineNests, ...upNests, ...savedNests].map((n) => Number(n.plateItemId ?? n.customPlate?.replaces?.plateItemId)));
  const costs = await plateCosts(db, companyId, ctx.line, ctx.plates.filter((p) => plateIds.has(Number(p.id))));
  const measure = (nests) => nestingMetrics(nests, { facts: st.facts, sizeOf, costs });

  // §90 (item 22): grade / impact class of every piece against its plate, on both sides, by the company's rule.
  const gradeOf = sideGrade(ctx.plates, st.cpById, ctx.settingRows?.gradeRule);
  const uploaded = upNests.length ? { ...(await measure(upNests)), gradeCheck: gradeOf(upNests), files: st.uploadedLots.map((l) => ({ lotId: l.id, lotNo: l.lotNo, filename: l.sourceFile, sourceKind: l.sourceKind })) } : null;
  const running = st.mem?.status === 'running' && st.mem.purpose === 'compare' ? snapshot(st.mem) : null;
  const sideOf = async (row, plan, nests) => {
    if (!row || !plan) return null;
    const m = await measure(nests);
    return {
      ...describeRun(row), metrics: m.metrics, perPlate: m.perPlate,
      // §90: grade / impact class on this side, and the custom plate sizes it proposes ("custom size, not in the catalog yet").
      gradeCheck: gradeOf(nests), customPlates: plan.customPlates ?? [],
      unplaced: (plan.groups ?? []).flatMap((g) => g.unplaced ?? []), problems: plan.problems ?? [],
      // 2026-10-16: it was told "stop and use this" (a person started a nesting run, or pressed Stop): its best so far.
      stoppedEarly: plan.budget?.stopped === true,
      // Made for the upload saved now (false: for an earlier upload of the same pieces — it still answers them).
      forThisUpload: (parseJson(row.params_json)?.upload?.key ?? null) === st.uploadKey,
      ...(detail ? { plan } : {}),
    };
  };
  const autoSide = await sideOf(st.rowSubset, planSubset, autoNests);
  const auto = autoSide ?? {
    status: running ? 'running' : !uploaded ? 'none' : st.stale ? 'stale' : st.demandError ? 'unavailable' : 'none',
    runId: running?.runId ?? null, ranAt: null, params: null, decision: null, metrics: null, perPlate: [],
    reason: running ? 'Our automatic nesting of these pieces is being worked out.'
      : !uploaded ? 'Nothing is uploaded on this line, so there is nothing to compare.'
      : st.demandError ? st.demandError.message
        : st.stale ? 'An automatic run exists, but for a different demand — the pieces, their quantities, the cut settings, the plate choices or the drawings have changed since. Run it again to compare.'
          : !uploaded ? 'Nothing is uploaded on this line, so there is nothing to compare.'
            : 'No automatic run has nested these pieces yet. Start one to compare.',
  };

  // LIKE FOR LIKE: the automatic side nests the pieces the uploaded plates hold.
  const want = new Map(Object.entries(st.only).map(([id, q]) => [Number(id), q]));
  const got = new Map();
  for (const n of autoNests) for (const p of n.pieces) got.set(Number(p.cutPlateId), (got.get(Number(p.cutPlateId)) ?? 0) + 1);
  const differ = [];
  if (autoSide) for (const id of new Set([...want.keys(), ...got.keys()])) if ((want.get(id) ?? 0) !== (got.get(id) ?? 0)) differ.push({ cutPlateId: id, cutPlateCode: st.cpById.get(id)?.code ?? `#${id}`, uploaded: want.get(id) ?? 0, auto: got.get(id) ?? 0 });
  const upPieces = [...want.values()].reduce((a, b) => a + b, 0);
  const overNested = [...st.subset].filter(([id, q]) => q > (st.cpById.get(id)?.pieces ?? 0)).map(([id, q]) => ({ cutPlateId: id, cutPlateCode: st.cpById.get(id)?.code ?? `#${id}`, uploaded: q, needed: st.cpById.get(id)?.pieces ?? 0 }));

  const { coverage, leftOver } = coverageOfLots(ctx.cutPlates, st.saved, st.excl, st.untracked);
  const lineSide = st.rowLine && planLine ? await sideOf(st.rowLine, planLine, lineNests) : null;
  const savedSide = await measure(savedNests);
  const { delta, verdict } = judge(uploaded?.metrics ?? null, autoSide?.metrics ?? null);
  // The second figure gets its own delta and verdict: everything SAVED on the line against our nesting of the whole line.
  const whole = judge(savedNests.length ? savedSide.metrics : null, lineSide?.metrics ?? null);
  const noLineSide = running ? 'Our automatic nesting of the whole line is being worked out.'
    : st.demandError ? st.demandError.message
      : 'No automatic run has nested the whole line as it is now. Start the comparison to work it out.';
  const blocker = importBlocker(ctx.line);
  const decided = autoSide?.decision ?? null;
  // 2026-10-16, the Compare tab: what neither side holds, and the line's ask for the automatic run.
  const kgOfCp = (id) => { const sz = st.cpById.get(id)?.steel; return sz?.length > 0 ? kgOf(sz.length * sz.width, sz.thickness, sz.density) : 0; };
  const leftToNest = leftOver.filter((x) => !x.manual && !x.leftOut);
  const { untracked: marks } = coverageOfLots(ctx.cutPlates, st.saved, st.excl, st.untracked);
  const leftOverSummary = {
    pieces: leftOver.reduce((a, x) => a + x.qty, 0), cutPieces: leftOver.length, kg: r3(leftOver.reduce((a, x) => a + x.qty * kgOfCp(x.cutPlateId), 0)),
    heldBack: leftOver.filter((x) => x.manual || x.leftOut).reduce((a, x) => a + x.qty, 0), toNest: leftToNest.reduce((a, x) => a + x.qty, 0),
    untrackedPieces: marks.reduce((a, x) => a + x.qty, 0), untrackedKg: r3(marks.reduce((a, x) => a + x.qty * kgOfCp(x.cutPlateId), 0)),
  };
  leftOverSummary.sentence = [
    leftOverSummary.pieces ? `${plural(leftOverSummary.pieces, 'piece is', 'pieces are')} left over by the upload (${Math.round(leftOverSummary.kg).toLocaleString('en-IN')} kg). They are in neither side.` : null,
    leftOverSummary.untrackedPieces ? `${plural(leftOverSummary.untrackedPieces, 'piece is', 'pieces are')} cut from untracked offcuts (${Math.round(leftOverSummary.untrackedKg).toLocaleString('en-IN')} kg). They are in neither side.` : null,
  ].filter(Boolean).join(' ') || null;
  const autoAsk = autoCompareState(companyId, lineId);
  return {
    line: lineHead(ctx.line), with: 'auto',
    demand: {
      hash: st.demandSubset?.hash ?? null, pieces: upPieces, cutPlates: want.size,
      wholeLineHash: st.demandLine?.hash ?? null, coversWholeLine: !!st.demandSubset && st.demandSubset.hash === st.demandLine?.hash,
      drawings: st.demandSubset?.drawings ?? 0,
    },
    uploaded,
    auto,
    stale: st.stale && !autoSide && uploaded ? { ...describeRun(st.stale), reason: 'It nested a different demand: the pieces, their quantities, the cut settings, the plate choices or the drawings have changed since.' } : null,
    delta, verdict,
    // 2026-10-16: the verdict in one plain line ("Ours uses 2 plates fewer, 1.4 t less steel and ₹61,924 less."), null with delta.
    headline: headlineOf(delta),
    // The same figures per thickness: [{ thickness, uploaded: ThicknessFigures | null, auto: ThicknessFigures | null }].
    byThickness: byThickness(uploaded?.perPlate ?? [], autoSide?.perPlate ?? []),
    leftOverSummary,
    // The server's own automatic run after an upload: what it is doing about this line in this process (null after a restart —
    // the run itself is in `auto` / `run`). { trigger, status: queued | waiting | started | answered | skipped | failed, message, at, runId }
    autoCompare: autoAsk,
    // Why `delta` / `verdict` are null, when they are (2026-10-10): never a bare null.
    deltaReason: delta ? null : (!uploaded ? 'Nothing is uploaded on this line, so there is nothing to compare.' : auto.reason ?? 'There is no automatic nesting of these pieces to compare with yet.'),
    likeForLike: autoSide ? { same: differ.length === 0, uploadedPieces: upPieces, autoPieces: [...got.values()].reduce((a, b) => a + b, 0), differ, overNested } : null,
    wholeLine: {
      saved: { ...savedSide, complete: leftOver.filter((x) => !x.manual && !x.leftOut).length === 0, leftOverPieces: leftOver.reduce((a, x) => a + x.qty, 0) },
      auto: lineSide ?? { status: running ? 'running' : 'none', runId: running?.runId ?? null, metrics: null, perPlate: [], reason: noLineSide },
      // automatic − saved, and the same kind of sentence as the main verdict (2026-10-10).
      delta: whole.delta, verdict: whole.verdict ? whole.verdict.replace(/The uploaded nesting/g, 'What is saved on the line').replace(/uploaded/g, 'saved') : null,
      deltaReason: whole.delta ? null : (!savedNests.length ? 'Nothing is saved on this line yet.' : noLineSide),
    },
    coverage, leftOver,
    // What accepting the automatic side would replace, in numbers (2026-10-10; additive).
    willReplace: willReplaceOf(st.saved, planLine ?? null, ctx.cutPlates, st.excl),
    // §87: the stored AI alternative — which side is the main nesting now, and whether (and why not) it may be swapped.
    alternative: alternativeView({
      alt: st.alt, swapped: st.swapped, autoSide, blocker, differ,
      additions: st.swapped ? 0 : st.uploadedLots.reduce((a, l) => a + l.pieces.filter((p) => !isUploadedPiece(l, p)).length, 0),
    }),
    run: running,
    lastFailure: !autoSide && !running && st.failed ? { ...describeRun(st.failed), error: parseJson(st.failed.error_json) } : null,
    canAccept: {
      uploaded: !!uploaded && !!autoSide && autoSide.status === 'ready',
      auto: !!autoSide && autoSide.status === 'ready' && !!lineSide && !blocker && !st.swapped,
      reason: decided ? `Already decided: the ${decided === 'auto' ? 'automatic' : 'uploaded'} nesting was taken.`
        : blocker ? blocker.message
          : !autoSide ? 'There is no automatic run of this demand to decide against yet.'
            : !lineSide ? 'The automatic nesting of the whole line is not worked out yet — run the comparison again.' : null,
    },
  };
}

/* ───────────────────────────── POST: start what is missing ───────────────────────────── */

/**
 * POST …/nesting/compare { run: true, effort?, rerun? } — starts the automatic side for the
 * demand(s) no finished run answers, and returns the run id to poll (GET …/nesting/compare).
 * With a run already there it starts NOTHING and says so; `rerun: true` packs again regardless.
 * Without `run: true` it is the GET.
 */
export async function startCompare(db, c, lineId, input = {}) {
  const companyId = c.companyId;
  if (input.run !== true && input.run !== 'true') return getCompare(db, companyId, lineId, {});
  // { run: true, auto: true } — the Compare tab asking for the AUTOMATIC run of the upload that is saved (when the
  // server's own start was lost, e.g. a restart in the moment after the save): the same start as after an upload.
  if (input.auto === true || input.auto === 'true') {
    const out = await startAutoCompare(db, c, lineId, { trigger: 'screen', rerun: input.rerun === true || input.rerun === 'true' });
    if (out.busy) throw invalid('RUN_BUSY', out.message);
    if (out.reason && !out.started && !out.running && !out.answered) throw invalid(out.reason, out.message);
    return out;
  }
  const st = await compareState(db, companyId, lineId);
  if (!st.uploadedLots.length) throw invalid('NOTHING_UPLOADED', 'Nothing is uploaded on this line, so there is nothing to compare AI\'s nesting with.');
  if (st.demandError) throw invalid(st.demandError.code, st.demandError.message);
  if (st.mem?.status === 'running' && st.mem.purpose === 'compare') return { started: false, running: true, runId: st.mem.id, status: 'running', run: snapshot(st.mem) };
  const rerun = input.rerun === true || input.rerun === 'true';
  const effort = effortOf(input.effort);
  const base = { effort, ...(input.seed != null ? { seed: Number(input.seed) || 1 } : {}) };
  const jobs = [];
  const same = st.demandSubset?.hash === st.demandLine?.hash;
  if (st.demandSubset && (rerun || !st.rowSubset)) jobs.push({ scope: 'subset', input: { ...base, only: st.only } });
  if (!same && (rerun || !st.rowLine)) jobs.push({ scope: 'line', input: { ...base, replaceImported: true } });
  if (!jobs.length) {
    return { started: false, running: false, runId: st.rowSubset?.run_uid ?? null, status: st.rowSubset?.status ?? 'ready', reason: 'An automatic run already answers this demand — it is pulled up, not run again. Send rerun: true to pack again.' };
  }
  // The run reads and keeps its rows through `db`: the pool in the app; a test hands in its own
  // connection so the run can see rows the test has not committed.
  const snap = startRun(companyId, c, lineId, base, { purpose: 'compare', jobs, db, pack: input.pack ?? null });
  return { started: true, running: true, runId: snap.runId, status: 'running', jobs: jobs.map((j) => j.scope), run: snap };
}

/* ───────────────────────────── the automatic run after an upload ───────────────────────────── */

/** How hard the server tries on its own: the Standard level (up to 10 minutes; a small line is done in seconds). */
export const AUTO_COMPARE_EFFORT = 'standard';
/** A nesting run of a person is working on the line: try again this often, this many times (20 min), then leave it to the Compare tab. */
const AUTO_RETRY_MS = 30_000;
const AUTO_TRIES = 40;
export const AUTO_QUEUED = 'Our own Standard nesting of the same pieces runs in the background now. See the Compare tab.';
const sameOnly = (a, b) => {
  const norm = (o) => JSON.stringify(Object.entries(o ?? {}).map(([k, v]) => [Number(k), Number(v)]).filter(([, v]) => v > 0).sort((x, y) => x[0] - y[0]));
  return norm(a) === norm(b);
};

/**
 * START THE AUTOMATIC SIDE FOR THE UPLOAD THAT IS SAVED — one Standard run of exactly the pieces the uploaded
 * plates hold (scope 'subset', `only`). Never throws for the line's state; it answers what it did:
 *   { started: true, runId }     a run is working now
 *   { running: true, runId }     one for these pieces was already working
 *   { answered: true, runId }    a finished run already answers these pieces (a re-upload of the same pieces): nothing packed
 *   { busy: true, message }      a person's nesting run (or a comparison of the whole line) holds the line: try later
 *   { reason, message }          nothing to do (NOTHING_UPLOADED) or the line cannot be nested (NOT_FROZEN …)
 * `rerun` (the Compare tab's Run again) packs again although a finished run answers.
 * A comparison still working for OTHER pieces (an earlier upload) is cancelled first: its answer is out of date.
 */
export async function startAutoCompare(db, c, lineId, { trigger = 'upload', rerun = false } = {}) {
  const companyId = c.companyId;
  const st = await compareState(db, companyId, lineId);
  if (!st.uploadedLots.length) return { started: false, reason: 'NOTHING_UPLOADED', message: 'Nothing is uploaded on this line, so there is nothing to compare.' };
  if (st.demandError) return { started: false, reason: st.demandError.code, message: st.demandError.message };
  if (!st.demandSubset) return { started: false, reason: 'NOTHING_TO_NEST', message: 'The uploaded plates hold no piece the line still needs.' };
  const mem = st.mem;
  if (mem?.status === 'running') {
    const forThese = (mem.purpose ?? 'nest') === 'compare' && mem.jobs?.length === 1 && sameOnly(mem.jobs[0].input?.only, st.only);
    if (forThese) return { started: false, running: true, runId: mem.id, message: 'AI\'s nesting of these pieces is already running.' };
    if ((mem.purpose ?? 'nest') === 'compare' && mem.jobs?.every((j) => j.input?.only)) cancelRun(companyId, lineId, { purpose: 'compare' });
    else return { started: false, busy: true, message: 'A nesting run is working on this line. AI\'s nesting of the upload starts when it is done.' };
  }
  if (st.rowSubset && !rerun) {
    // §87: that run is the line's alternative of this upload too.
    await recordAlternativeRun(db, c, lineId, { runUid: st.rowSubset.run_uid, uploadKey: st.uploadKey });
    return { started: false, answered: true, runId: st.rowSubset.run_uid, message: 'AI\'s nesting of these pieces is already done. It is shown again.' };
  }
  const pieces = Object.values(st.only).reduce((a, q) => a + q, 0);
  const upload = { key: st.uploadKey, plates: st.uploadedLots.length, pieces };
  const base = { effort: AUTO_COMPARE_EFFORT, trigger };
  const who = c.userName ? `${c.userName} · automatic, after the upload` : 'automatic, after the upload';
  const snap = startRun(companyId, { ...c, userName: who }, lineId, base, {
    purpose: 'compare', db: db === pool ? undefined : db,
    jobs: [{ scope: 'subset', input: { ...base, only: st.only, upload } }],
  });
  // §87: this run IS the line's alternative of this upload (stored when it finishes, found again by its demand).
  await recordAlternativeRun(db, c, lineId, { runUid: snap.runId, uploadKey: st.uploadKey });
  return { started: true, running: true, runId: snap.runId, status: 'running', jobs: ['subset'], run: snap, message: AUTO_QUEUED };
}

/** The line's last automatic start in this process: { trigger, status, message, at, runId, tries } (key companyId:lineId). */
const AUTO = new Map();
const autoPending = new Set();
const autoKey = (companyId, lineId) => `${Number(companyId)}:${Number(lineId)}`;
/** CF_NEST_AUTO_COMPARE=off turns the automatic run off (suites that test other things set it). */
export const autoCompareOff = () => /^(0|off|false|no)$/i.test(String(process.env.CF_NEST_AUTO_COMPARE ?? '').trim());

/** What the server is doing about the line's automatic comparison, for the GET (null: nothing in this process). */
export function autoCompareState(companyId, lineId) {
  const e = AUTO.get(autoKey(companyId, lineId));
  return e ? { trigger: e.trigger, status: e.status, message: e.message, at: e.at, runId: e.runId, tries: e.tries } : null;
}

/**
 * AFTER AN UPLOAD IS SAVED (the route, once its transaction committed): queue the automatic run and answer AT
 * ONCE — the upload's response never waits for it, not even for its first read. The work starts on the next
 * turn of the event loop, on the pool. While a person's nesting run holds the line it tries again every 30 s
 * (20 min); a newer save of the line takes over from an older one. → { queued, effort, message } | null (off).
 */
export function scheduleAutoCompare(c, lineId, { trigger = 'upload', db = pool } = {}) {
  if (autoCompareOff()) return null;
  const key = autoKey(c.companyId, lineId);
  const entry = { trigger, status: 'queued', message: AUTO_QUEUED, at: new Date().toISOString(), runId: null, tries: 0 };
  AUTO.set(key, entry);
  const track = (p) => { autoPending.add(p); p.finally(() => autoPending.delete(p)); return p; };
  const attempt = async () => {
    if (AUTO.get(key) !== entry) return;                     // a newer save took over
    entry.tries += 1;
    try {
      const out = await startAutoCompare(db, c, lineId, { trigger });
      if (out.busy && entry.tries < AUTO_TRIES) {
        entry.status = 'waiting'; entry.message = out.message;
        track(new Promise((r) => { const t = setTimeout(r, AUTO_RETRY_MS); t.unref?.(); }).then(attempt));
        return;
      }
      entry.status = out.started || out.running ? 'started' : out.answered ? 'answered' : out.busy ? 'failed' : 'skipped';
      entry.runId = out.runId ?? null;
      entry.message = out.started ? AUTO_QUEUED : out.message ?? null;
    } catch (e) {
      entry.status = 'failed'; entry.message = e?.message ?? String(e);
    }
  };
  track(new Promise((r) => { setImmediate(r); }).then(attempt));
  return { queued: true, effort: AUTO_COMPARE_EFFORT, message: AUTO_QUEUED };
}

/** Tests: every queued automatic start has been tried (the runs themselves: nestRunService.settleRuns). */
export async function settleAutoCompares() { while (autoPending.size) await Promise.allSettled([...autoPending]); }

/* ───────────────────────────── POST: take one side ───────────────────────────── */

/**
 * POST …/nesting/compare/accept { side: 'uploaded' | 'auto', runId }.
 *   uploaded  what is saved stays; the run is marked discarded.
 *   auto      the uploaded plates are replaced by the run's whole-line plan (acceptNesting with
 *             replaceImported, which checks the layout against the database and works the plate
 *             quantities, offcuts, cut lengths and piercings out again); the run is marked accepted.
 * The side not taken is kept as a row of cf_nest_runs (kind 'upload' for the uploaded nesting),
 * so what was decided against can still be read. A run already decided is refused.
 */
export async function acceptCompare(db, c, lineId, input = {}) {
  const companyId = c.companyId;
  const side = String(input.side ?? '').toLowerCase();
  if (!['uploaded', 'auto'].includes(side)) throw invalid('INVALID', 'Say which side to take: "uploaded" or "auto".');
  if (!input.runId) throw invalid('INVALID', 'Say which run the comparison was made with (runId).');
  await settleRuns();
  const [rows] = await db.query(
    `SELECT id, run_uid, scope, status, demand_hash, plan_json, plan_encoding FROM cf_nest_runs
      WHERE company_id = ? AND order_line_id = ? AND run_uid = ? AND kind = 'auto' AND deleted_at IS NULL FOR UPDATE`,
    [companyId, lineId, String(input.runId)],
  );
  if (!rows.length) throw notFound('Nesting run');
  const decided = rows.find((r) => r.status === 'accepted' || r.status === 'discarded');
  if (decided) throw invalid('ALREADY_DECIDED', `This comparison was already decided — the ${decided.status === 'accepted' ? 'automatic' : 'uploaded'} nesting was taken. Compare again to decide again.`);
  if (rows.some((r) => r.status !== 'ready')) throw invalid('RUN_NOT_READY', rows.some((r) => r.status === 'running') ? 'That run is still working — wait for it to finish.' : 'That run failed, so there is no automatic nesting to decide against. Run the comparison again.');

  const st = await compareState(db, companyId, lineId);
  // §87: with AI's nesting the main one the uploaded side is kept aside — the swap (and switch back) decides, not this.
  if (st.swapped) throw invalid('ALREADY_SWAPPED', "AI's nesting is already the main one. Switch back on the Compare tab if you want the customer's.");
  if (!st.uploadedLots.length) throw invalid('NOTHING_UPLOADED', 'Nothing is uploaded on this line any more, so there is nothing to decide between.');
  const current = rows.filter((r) => r.demand_hash && (r.demand_hash === st.demandSubset?.hash || r.demand_hash === st.demandLine?.hash));
  if (!current.length) throw invalid('STALE_RUN', 'That run nested a different demand — the line has changed since. Compare again.');
  const sizeOf = new Map(st.ctx.cutPlates.map((cp) => [cp.id, cp.steel ?? {}]));
  const upNests = await fromSavedLots(st.uploadedLots.map((l) => [l, l.pieces.filter((p) => isUploadedPiece(l, p))]), st.mctx);
  const costs = await plateCosts(db, companyId, st.ctx.line, st.ctx.plates.filter((p) => upNests.some((n) => Number(n.plateItemId) === Number(p.id))));
  const upMetrics = await nestingMetrics(upNests, { facts: st.facts, sizeOf, costs });
  const keepUpload = async (status, withLots) => {
    const packed = withLots ? packPlan({ lots: st.uploadedLots.map((l) => ({ ...l, waste: undefined })) }) : { text: null, encoding: null };
    await db.query(
      `INSERT INTO cf_nest_runs (company_id, order_line_id, run_uid, kind, scope, purpose, status, demand_hash, params_json, plan_json, plan_encoding, metrics_json, started_at, finished_at, created_by)
       VALUES (?, ?, ?, 'upload', 'upload', 'compare', ?, ?, ?, ?, ?, ?, NOW(3), NOW(3), ?)`,
      [companyId, lineId, String(input.runId), status, st.demandSubset?.hash ?? null, JSON.stringify({ comparedWith: String(input.runId), side }),
        packed.text, packed.encoding, JSON.stringify(upMetrics), c.userId ?? null],
    );
  };

  if (side === 'uploaded') {
    await db.query("UPDATE cf_nest_runs SET status = 'discarded' WHERE company_id = ? AND id IN (?)", [companyId, rows.map((r) => r.id)]);
    await keepUpload('accepted', false);
    return { decision: 'uploaded', runId: String(input.runId), kept: { plates: st.uploadedLots.length }, message: 'The uploaded nesting stays. The automatic run is kept as discarded.' };
  }

  const blocker = importBlocker(st.ctx.line);
  if (blocker) throw blocker;
  const whole = rows.find((r) => r.demand_hash === st.demandLine?.hash)
    ?? (await db.query(
      "SELECT id, run_uid, scope, status, demand_hash, plan_json, plan_encoding FROM cf_nest_runs WHERE company_id = ? AND order_line_id = ? AND kind = 'auto' AND deleted_at IS NULL AND demand_hash = ? AND status IN ('ready','accepted','discarded') AND plan_json IS NOT NULL ORDER BY id DESC LIMIT 1",
      [companyId, lineId, st.demandLine?.hash ?? ''],
    ))[0][0];
  const plan = whole ? unpackPlan(whole.plan_json, whole.plan_encoding)?.plan : null;
  if (!plan) throw invalid('NO_WHOLE_LINE_PLAN', 'The automatic nesting of the WHOLE line is not worked out yet (the run only nested the pieces the files cover). Run the comparison again, then accept.');
  // The uploaded side as it was, kept: every plate, where every part sat, and its file.
  await keepUpload('discarded', true);
  // (clearLots takes the customer's files with the plates it clears.)
  const willReplace = willReplaceOf(st.saved, plan, st.ctx.cutPlates, st.excl);
  const accepted = await acceptNesting(db, c, lineId, { ...plan, replaceImported: true });
  await db.query("UPDATE cf_nest_runs SET status = 'accepted' WHERE company_id = ? AND id IN (?)", [companyId, [...new Set([...rows.map((r) => r.id), whole.id])]]);
  const after = await savedLotsOf(db, companyId, lineId);
  const { leftOver } = coverageOfLots(st.ctx.cutPlates, after, st.excl, st.untracked);
  return {
    decision: 'auto', runId: String(input.runId), accepted,
    // uploadedPlates / plates as before; the rest (2026-10-10) says everything that went, in numbers.
    replaced: {
      uploadedPlates: st.uploadedLots.length, plates: accepted.lots,
      customerPlates: willReplace.customerPlates, ourPlates: willReplace.ourPlates, removedPlates: willReplace.plates,
      customerPieces: willReplace.customerPieces, ourPiecesOnCustomerPlates: willReplace.ourPiecesOnCustomerPlates, ourPieces: willReplace.ourPieces,
      customerFiles: willReplace.customerFiles, withPlates: accepted.lots, withPieces: accepted.pieces,
    },
    leftOver,
    message: `AI's nesting is saved: ${plural(accepted.lots, 'plate', 'plates')} in place of ${plural(st.uploadedLots.length, 'uploaded plate', 'uploaded plates')}${willReplace.ourPlates ? ` and ${plural(willReplace.ourPlates, 'plate', 'plates')} nested by AI` : ''}.`,
  };
}

/** For callers that hold a plan and want its figures by the comparison's own rule (tests, reports). */
export async function metricsOfPlan(db, companyId, lineId, plan) {
  const st = await compareState(db, companyId, lineId);
  const nests = nestsOfPlan(plan);
  const costs = await plateCosts(db, companyId, st.ctx.line, st.ctx.plates.filter((p) => nests.some((n) => Number(n.plateItemId) === Number(p.id))));
  return nestingMetrics(nests, { facts: st.facts, sizeOf: new Map(st.ctx.cutPlates.map((cp) => [cp.id, cp.steel ?? {}])), costs });
}

/**
 * WHAT IS SAVED ON A LINE, MEASURED by the comparison's own rule (nestingMetrics: steel, parts, waste by
 * cause with the offcuts in it, offcuts, cut length) — for the plate-change impact sheet (§62,
 * plateChangeService). Never packs, never resumes a run: only the saved plates are read.
 *   costsOf(plates) → Map plateItemId → { unit, basis } | { unit: null } — the caller's price rule
 *                     (the impact sheet prices by valuationService.plateRatesPerKg, as the order's costs do).
 * Returns { ctx, saved, metrics, perPlate }.
 */
export async function measureSavedLine(db, companyId, lineId, { costsOf, cuts = true }) {
  const ctx = await importContext(db, companyId, lineId);
  const [saved, facts] = await Promise.all([savedLotsOf(db, companyId, lineId), drawingFactsOfLine(db, companyId, lineId)]);
  const cpById = new Map(ctx.cutPlates.map((cp) => [cp.id, cp]));
  const shapes = new Map();
  const shapeOf = (cp) => { if (!shapes.has(cp.id)) shapes.set(cp.id, shapeOfCutPlate(cp, facts)); return shapes.get(cp.id); };
  const nests = saved.length ? await fromSavedLots(saved.map((l) => [l, l.pieces]), { cpById, shapeOf, settingRows: ctx.settingRows, plates: ctx.plates }) : [];
  const costs = await costsOf(nests, ctx);
  const m = await nestingMetrics(nests, { facts, sizeOf: new Map(ctx.cutPlates.map((cp) => [cp.id, cp.steel ?? {}])), costs, cuts });
  return { ctx, saved, ...m };
}

export const _test = { plateCosts, compareState };
