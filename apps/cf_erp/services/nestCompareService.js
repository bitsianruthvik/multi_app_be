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
 * saved nest writes on its cut plates), and cost by the saved nest's own rule
 * (valuationService.orderCosts): what that plate size cost issued to this line, else its average
 * cost, else its last receipt — and, for a plate never received (the usual case before buying),
 * its last purchase price, else its list price; `basis` says which. A plate with none of them has
 * NO cost: the total is then null with the reason, never a partial sum, never zero.
 *
 * ACCEPTING. `uploaded` keeps what is saved and marks the run discarded. `auto` replaces the
 * uploaded plates with the run's WHOLE-LINE plan through acceptNesting (replaceImported), which
 * verifies the geometry against the database and works every derived number out again.
 */
import { invalid, notFound } from '../lib/errors.js';
import {
  importContext, importBlocker, acceptNesting, kgOf, lineHead, exclusionsOfLine, demandFor, assertFrozen, effortOf,
} from './nestingService.js';
import { savedLotsOf, coverageOfLots, isUploadedPiece, measureSavedLots } from './nestDxfImportService.js';
import { drawingFactsOfLine } from './partDrawingService.js';
import { cutsOfLotsAsync } from './plateCutsService.js';
import { lastPricesPaid, listPricesOf, perUnitPrice } from './priceService.js';
import { shapeOfCutPlate } from './nestShapes.js';
import { startRun, memoryRun, snapshot, unpackPlan, packPlan, resumeRun, settleRuns } from './nestRunService.js';

const WASTE_KEYS = ['kerf', 'sequenceGaps', 'rim', 'offcut', 'wastage'];
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const r3 = (n) => Math.round(Number(n) * 1000) / 1000;
const parseJson = (v) => { if (v == null) return null; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return null; } };
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const missingTable = (e) => e?.code === 'ER_NO_SUCH_TABLE' || e?.errno === 1146;

/* ───────────────────────────── cost ───────────────────────────── */

/**
 * What one plate of each size costs — Map plateItemId → { unit, basis } | { unit: null, reason }.
 * A fixed number of reads whatever the number of plates.
 */
async function plateCosts(db, companyId, line, plates) {
  const ids = [...new Set(plates.map((p) => Number(p.id)))];
  const out = new Map();
  if (!ids.length) return out;
  const [[issued], [pools], [stock], [receipts], paid, listed] = await Promise.all([
    db.query(
      `SELECT l.item_id, SUM(-l.quantity) AS qty, SUM(-l.value) AS value
         FROM cf_stock_ledger l
         JOIN cf_stock_movements m ON m.id = l.movement_id AND m.movement_type = 'issue'
         LEFT JOIN cf_stock_batches b ON b.id = l.batch_id
        WHERE l.company_id = ? AND m.order_line_id = ? AND l.item_id IN (?) AND l.value IS NOT NULL AND b.owner_party_id IS NULL
        GROUP BY l.item_id`,
      [companyId, line.id, ids],
    ),
    db.query('SELECT item_id, avg_unit_cost FROM cf_item_costs WHERE company_id = ? AND owner_key = 0 AND item_id IN (?) AND avg_unit_cost IS NOT NULL', [companyId, ids]),
    db.query(
      `SELECT b.item_id, SUM(k.quantity * b.unit_cost) / SUM(k.quantity) AS avg_cost
         FROM cf_stock_balances k JOIN cf_stock_batches b ON b.id = k.batch_id
        WHERE k.company_id = ? AND b.item_id IN (?) AND k.quantity > 0 AND b.unit_cost IS NOT NULL AND b.owner_party_id IS NULL
        GROUP BY b.item_id`,
      [companyId, ids],
    ),
    db.query(
      `SELECT l.item_id, l.unit_cost FROM cf_stock_ledger l
         JOIN cf_stock_movements m ON m.id = l.movement_id AND m.movement_type = 'receipt' AND m.reversal_of_id IS NULL AND m.reversed_by_id IS NULL
         LEFT JOIN cf_stock_batches b ON b.id = l.batch_id
        WHERE l.company_id = ? AND l.item_id IN (?) AND l.unit_cost IS NOT NULL AND l.quantity > 0 AND b.owner_party_id IS NULL
        ORDER BY m.movement_date DESC, m.id DESC`,
      [companyId, ids],
    ),
    lastPricesPaid(db, companyId, ids),
    listPricesOf(db, companyId, ids),
  ]);
  const first = (rows, f) => { const m = new Map(); for (const r of rows) if (!m.has(Number(r.item_id))) { const v = f(r); if (v != null && Number.isFinite(v)) m.set(Number(r.item_id), v); } return m; };
  const tiers = [
    ['issued to this line', first(issued, (r) => (Number(r.qty) > 1e-9 ? Number(r.value) / Number(r.qty) : null))],
    ['average cost', first(pools, (r) => Number(r.avg_unit_cost))],
    ['stock on hand', first(stock, (r) => (r.avg_cost == null ? null : Number(r.avg_cost)))],
    ['last receipt', first(receipts, (r) => Number(r.unit_cost))],
  ];
  for (const p of plates) {
    const id = Number(p.id);
    let hit = null;
    for (const [basis, m] of tiers) if (m.has(id)) { hit = { unit: r2(m.get(id)), basis }; break; }
    if (!hit && paid.get(id)?.unitPrice != null) hit = { unit: r2(paid.get(id).unitPrice), basis: 'last purchase price' };
    if (!hit && listed.get(id)?.listPrice != null) {
      const kg = p.steel?.length > 0 ? kgOf(p.steel.length * p.steel.width, p.steel.thickness, p.steel.density) : null;
      const per = perUnitPrice(listed.get(id).listPrice, listed.get(id).priceBasis, { weightKg: kg, lengthM: p.steel?.length > 0 ? p.steel.length / 1000 : null });
      if (per != null) hit = { unit: r2(per), basis: 'list price' };
    }
    out.set(id, hit ?? { unit: null, reason: `${p.code ?? `plate ${id}`} has never been received or bought and has no list price.` });
  }
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
export async function nestingMetrics(nests, { facts, sizeOf, costs }) {
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
      const c = costs.get(Number(n.plateItemId));
      if (c?.unit != null) { plateCost = c.unit; basis = c.basis; bases.add(c.basis); cost += c.unit; } else if (!uncosted.includes(n.plateCode ?? `plate ${n.plateItemId}`)) uncosted.push(n.plateCode ?? `plate ${n.plateItemId}`);
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
    });
  }
  const cuts = await cutsOfLotsAsync(nests.map((n) => ({ kerf: n.kerfMm, pieces: n.pieces, free: !!n.free })), facts, sizeOf);
  return {
    metrics: {
      plates: nests.length, pieces,
      tonnesBought: r3(boughtKg / 1000), partsTonnes: r3(partsKg / 1000),
      wastePct: boughtKg > 0 ? r3(((boughtKg - partsKg) / boughtKg) * 100) : null,
      ...(boughtKg > 0 ? {} : { wastePctReason: nests.length ? 'The plates have no weight on record (no density, or no size), so waste cannot be given as a share of the steel bought.' : 'There are no plates.' }),
      wasteKgTotal: r3(boughtKg - partsKg),
      wasteKg: Object.fromEntries(WASTE_KEYS.map((k) => [k, r3(wasteKg[k])])),
      offcuts: { count: offcut.count, kg: r3(offcut.kg), largestKg: offcut.largestKg == null ? 0 : r3(offcut.largestKg), largestAreaM2: offcut.largestAreaM2 ?? 0 },
      cutLengthM: r3(cuts.cutLengthMm / 1000), sharedCutM: r3(cuts.sharedMm / 1000), piercings: cuts.piercings,
      cost: uncosted.length
        ? { value: null, currency: 'INR', basis: null, customerPlates, reason: `No cost for ${uncosted.join(', ')}: ${uncosted.length === 1 ? 'it has' : 'they have'} never been received or bought and ${uncosted.length === 1 ? 'has' : 'have'} no list price, so the nesting cannot be priced.` }
        : { value: r2(cost), currency: 'INR', basis: [...bases].join(' / ') || (customerPlates ? "the customer's own plates" : null), customerPlates, reason: null },
    },
    perPlate,
  };
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
} : null);

/**
 * Everything the three entry points need, read once: the line, what is saved, the two demands
 * and the runs that answer them.
 */
async function compareState(db, companyId, lineId) {
  const ctx = await importContext(db, companyId, lineId);
  const [saved, facts, excl] = await Promise.all([savedLotsOf(db, companyId, lineId), drawingFactsOfLine(db, companyId, lineId), exclusionsOfLine(db, companyId, lineId)]);
  const cpById = new Map(ctx.cutPlates.map((cp) => [cp.id, cp]));
  const shapes = new Map();
  const shapeOf = (cp) => { if (!shapes.has(cp.id)) shapes.set(cp.id, shapeOfCutPlate(cp, facts)); return shapes.get(cp.id); };
  const mctx = { cpById, shapeOf, settingRows: ctx.settingRows, plates: ctx.plates };
  const uploadedLots = saved.filter((l) => l.origin === 'imported');
  const subset = new Map();
  for (const l of uploadedLots) for (const p of l.pieces) if (isUploadedPiece(l, p)) subset.set(p.cutPlateId, (subset.get(p.cutPlateId) ?? 0) + 1);
  // Never more of a cut plate than the line needs: an over-covered upload is compared on what the line needs.
  const only = Object.fromEntries([...subset].map(([id, q]) => [id, Math.min(q, cpById.get(id)?.pieces ?? 0)]).filter(([, q]) => q > 0));

  // The two questions an automatic run can be asked here, fingerprinted from what is already read
  // (demandFor — the same selection and hash planNesting reports for a run).
  let demandSubset = null; let demandLine = null; let demandError = null;
  try {
    assertFrozen(ctx.line);
    const args = { line: ctx.line, needed: ctx.cutPlates, everyPlate: ctx.plates, settingRows: ctx.settingRows, excl, facts };
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
  return { ctx, saved, facts, excl, cpById, mctx, uploadedLots, subset, only, demandSubset, demandLine, demandError, rows, mem, rowSubset, rowLine, stale, failed };
}

async function plansOf(db, companyId, rowIds) {
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
    customer.length ? `${plural(customer.length, 'uploaded plate', 'uploaded plates')} (${plural(customerPieces, 'piece', 'pieces')} as the customer nested them${ourPiecesOnCustomerPlates ? `, and ${plural(ourPiecesOnCustomerPlates, 'piece', 'pieces')} we added to them` : ''})` : null,
    ours.length ? `${plural(ours.length, 'plate', 'plates')} of our own (${plural(ourPieces, 'piece', 'pieces')})` : null,
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
      : `Taking our automatic nesting replaces everything saved on this line: ${bits.join(' and ')}${files ? `; the ${plural(files, "customer's file", "customer's files")} ${files === 1 ? 'goes' : 'go'} with ${files === 1 ? 'its plate' : 'their plates'} (a copy of the uploaded nesting is kept with the run)` : ''}.${nests ? ` In their place: ${plural(nests.length, 'plate', 'plates')} holding ${plural(withPieces, 'piece', 'pieces')}${notNested ? `; ${plural(notNested, 'piece stays', 'pieces stay')} un-nested (held back by hand or left out)` : ''}.` : ' The automatic nesting of the whole line is not worked out yet.'}`,
  };
}

/* ───────────────────────────── GET ───────────────────────────── */

/**
 * GET …/nesting/compare?with=auto — both sides, measured the same way. Never packs.
 * `detail` adds the automatic side's proposal itself (`auto.plan`) so its plates can be drawn.
 */
export async function getCompare(db, companyId, lineId, { with: other = 'auto', detail = false } = {}) {
  if (other != null && String(other).toLowerCase() !== 'auto') throw invalid('INVALID', 'An uploaded nesting is compared with "auto" — our automatic nesting.');
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
  const plateIds = new Set([...autoNests, ...lineNests, ...upNests, ...savedNests].map((n) => Number(n.plateItemId)));
  const costs = await plateCosts(db, companyId, ctx.line, ctx.plates.filter((p) => plateIds.has(Number(p.id))));
  const measure = (nests) => nestingMetrics(nests, { facts: st.facts, sizeOf, costs });

  const uploaded = upNests.length ? { ...(await measure(upNests)), files: st.uploadedLots.map((l) => ({ lotId: l.id, lotNo: l.lotNo, filename: l.sourceFile, sourceKind: l.sourceKind })) } : null;
  const running = st.mem?.status === 'running' && st.mem.purpose === 'compare' ? snapshot(st.mem) : null;
  const sideOf = async (row, plan, nests) => {
    if (!row || !plan) return null;
    const m = await measure(nests);
    return {
      ...describeRun(row), metrics: m.metrics, perPlate: m.perPlate,
      unplaced: (plan.groups ?? []).flatMap((g) => g.unplaced ?? []), problems: plan.problems ?? [],
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

  const { coverage, leftOver } = coverageOfLots(ctx.cutPlates, st.saved, st.excl);
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
    run: running,
    lastFailure: !autoSide && !running && st.failed ? { ...describeRun(st.failed), error: parseJson(st.failed.error_json) } : null,
    canAccept: {
      uploaded: !!uploaded && !!autoSide && autoSide.status === 'ready',
      auto: !!autoSide && autoSide.status === 'ready' && !!lineSide && !blocker,
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
  const st = await compareState(db, companyId, lineId);
  if (!st.uploadedLots.length) throw invalid('NOTHING_UPLOADED', 'Nothing is uploaded on this line, so there is nothing to compare our automatic nesting with.');
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
  const { leftOver } = coverageOfLots(st.ctx.cutPlates, after, st.excl);
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
    message: `Our automatic nesting is saved: ${plural(accepted.lots, 'plate', 'plates')} in place of ${plural(st.uploadedLots.length, 'uploaded plate', 'uploaded plates')}${willReplace.ourPlates ? ` and ${plural(willReplace.ourPlates, 'plate', 'plates')} of our own` : ''}.`,
  };
}

/** For callers that hold a plan and want its figures by the comparison's own rule (tests, reports). */
export async function metricsOfPlan(db, companyId, lineId, plan) {
  const st = await compareState(db, companyId, lineId);
  const nests = nestsOfPlan(plan);
  const costs = await plateCosts(db, companyId, st.ctx.line, st.ctx.plates.filter((p) => nests.some((n) => Number(n.plateItemId) === Number(p.id))));
  return nestingMetrics(nests, { facts: st.facts, sizeOf: new Map(st.ctx.cutPlates.map((cp) => [cp.id, cp.steel ?? {}])), costs });
}

export const _test = { plateCosts, compareState };
