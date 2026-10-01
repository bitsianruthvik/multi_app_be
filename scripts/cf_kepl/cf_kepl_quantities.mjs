/**
 * cf_kepl_quantities.mjs — DERIVES the work quantities the KEPL order's time
 * formulas read, writes them onto its frozen pieces and re-releases the line.
 * ONE-OFF, FOR THE KEPL ORDER ONLY (prod SO-20260930-0001, line 210001; local
 * stand-in line 923). User, 2026-10-01: "For this order derive it but in
 * general I will supply." So nothing here is a rule, formula or default for
 * other orders — the values land on this line's own items and nowhere else.
 * Write-up: TM/CF_ERP_KEPL_QUANTITIES.md. Formulas and fields it feeds:
 * cf_operation_times.mjs (applied 2026-10-01) and
 * TM/CF_ERP_OPERATION_TIMES_FINDINGS.md.
 *
 * THE RULES (each value is worked out from the line's own geometry — the
 * plates under each assembly — the BOQ, and the workbook
 * Downloads/Process_Flow_v5.xlsx, Master_Formulae + Sample_Calculations; the
 * workbook holds no worked numbers for this girder, only rates and bands):
 *
 *   SAW_WELD_LENGTH   flange-to-web: 2 fillets x each flange's long edge. A
 *                     girder segment (2 flanges) = 4 x its length (46.6 m end,
 *                     48 m middle); a diaphragm the same over its flanges.
 *   *_WELD_SIZE       workbook weld bands — SAW Girder row: root 3–6 mm,
 *                     fill-up 10–12 mm; MIG I-beam row: 12 mm only. A joint
 *                     whose thinner plate is >= 10 mm is a fill-up weld -> 12;
 *                     thinner -> 6 (root). Every KEPL joint is 12–40 mm -> 12.
 *                     One value an item: the thinnest joint of that process.
 *   STIFFENERS /      the segment's stiffener children (bearing, end,
 *   _AFTER_FLIP       intermediate), half on each face of the web: the BOQ
 *                     pairs them (BS plain + BS holed; 4 end = 2 a side; G1's
 *                     3 holed + 23 plain = 13 + 13 and G2's 6 holed = 3 a side,
 *                     the holed ones facing a diaphragm). Fitted before the
 *                     flip = ceil(n/2), after = floor(n/2) — workbook flow
 *                     S10 / S18.
 *   MIG_WELD_LENGTH / each stiffener welded to the web by 2 fillets along its
 *   _AFTER_FLIP       long edge (2 x 2,995 mm), split with the stiffeners
 *                     (S11 before the flip, S19 after). Stiffener-to-flange
 *                     returns are not counted.
 *   ARC_WELD_LENGTH   diaphragms: every plate that is neither a flange nor a
 *                     web (jacking stiffeners, pad plates, the plates lining
 *                     the opening) welded by 2 fillets along its long edge.
 *                     They carry no holes, so they are welded, not bolted.
 *                     ARC stays UNTIMED: no ARC_RATE chart (user has not given
 *                     one). A diaphragm's MIG pass gets no length — nothing
 *                     says which of its welds are MIG rather than arc.
 *   STUDS             the girder line's shear studs (BOQ: 1,803 a line,
 *                     25 x 175; 14,424 on the order) shared over its segments
 *                     by top-flange length, whole studs, summing exactly:
 *                     11,650 mm end -> 354, 12,000 mm middle -> 365.
 *   METALLISE_COATS   1 (the workbook bands metallising by coat THICKNESS and
 *                     gives no coat count), on every piece whose flow
 *                     metallises.
 *   PAINT_COATS       LEFT EMPTY: no paint system in the workbook, the BOQ or
 *                     the order (the 2 coats in Master_Formulae is a made-up
 *                     sample). Painting stays untimed.
 *   HOLES, HOLE_DIA, HOLE_TRANSFERS, HOLES_TOP / _BOTTOM / _INNER
 *                     LEFT EMPTY: hole counts and diameters live on the
 *                     detailing drawings; neither the BOQ, the workbook nor
 *                     the order holds them. Drilling stays untimed.
 *
 * A value is written only where the piece's own flow reads it (the item refs
 * of its operations' work formulas) and where the piece can hold it (an
 * applicable item-level rule — else the Times grid would never see it).
 *
 * --commit, in ONE transaction:
 *   1. if the line is released and nothing has started or been issued, take
 *      the release back (releaseService.unrelease); if anything started or was
 *      issued, stop before writing anything;
 *   2. write the values onto the frozen pieces (valueService.upsertValues,
 *      history kept — the --locked-line-values path of cf_operation_times);
 *   3. release again with the previous release's finished area and notes;
 *   4. print hours per operation before / after and the new release's timed
 *      steps. No value changed -> nothing is taken back or released.
 *
 *   node scripts/cf_kepl/cf_kepl_quantities.mjs [--line <id>]     # dry run (read-only transaction; TiDB stale read)
 *   node scripts/cf_kepl/cf_kepl_quantities.mjs --commit
 *   CF_BRIDGE_COMPANY=30005 … for prod Placebo, TM/.env.tidb loaded by the caller (default company 2)
 */
import { pathToFileURL } from 'url';
import { pool } from '../../db.js';
import '../../apps/cf_erp/services/codegenProvider.js';
import { attachNodeCache, detachNodeCache } from '../../apps/cf_erp/lib/db.js';
import { parseFormula } from '../../apps/cf_erp/services/formulaEngine.js';
import { explode } from '../../apps/cf_erp/services/bomService.js';
import * as valueSvc from '../../apps/cf_erp/services/valueService.js';
import { resolveLineRecords } from '../../apps/cf_erp/services/orderValuesService.js';
import { effectiveByCode } from '../../apps/cf_erp/services/resolutionService.js';
import { valueReaders } from '../../apps/cf_erp/services/operationService.js';
import { getLineTimes, loadMachineSide, flowSteps, opsOfFlow } from '../../apps/cf_erp/services/timeEstimateService.js';
import { unrelease, releaseLine, liveReleaseOfLine } from '../../apps/cf_erp/services/releaseService.js';

/* ===========================================================================
 * The rules, as data and pure functions (the test calls them)
 * ======================================================================== */

export const FILL_BAND_MIN_PLATE = 10; // workbook SAW Girder row: fill-up 10–12 mm
export const FILL_SIZE = 12;
export const ROOT_SIZE = 6;            // workbook SAW Girder row: root 3–6 mm
export const METALLISE_COATS = 1;
export const SOURCE = 'entered';

/** The weld band of a joint from its thinner plate. */
export const sizeBand = (thinnerMm) => (thinnerMm >= FILL_BAND_MIN_PLATE ? FILL_SIZE : ROOT_SIZE);

const isFlange = (n) => /flange/i.test(n.name);
const isWeb = (n) => /\bweb\b/i.test(n.name);
const isStiffener = (n) => /stiffener/i.test(n.name);
const isTopFlange = (n) => /top\s*flange/i.test(n.name);
const isStud = (n) => /STUD/i.test(n.cls ?? '') || /\bstud/i.test(n.name);
const r3 = (x) => Number(Number(x).toFixed(3));

/** Long edge and thickness of a plate node (LENGTH and WIDTH are swapped on some rows). */
function plate(n) {
  const L = n.vals.LENGTH;
  const W = n.vals.WIDTH;
  const T = n.vals.THICKNESS;
  if (L == null || W == null || T == null) return null;
  return { long: Math.max(L, W), t: T };
}

/**
 * Whole numbers per row summing exactly to `total` over rows of `qty` pieces,
 * shared by `weight` per piece. Rounded first, then the rest moved one piece at
 * a time onto the qty-1 rows nearest to rounding the other way.
 */
export function shareWhole(total, rows) {
  const W = rows.reduce((s, r) => s + r.qty * r.weight, 0);
  if (!W) return { values: rows.map(() => null), residual: total };
  const exact = rows.map((r) => (total * r.weight) / W);
  const values = exact.map((x) => Math.round(x));
  let diff = total - rows.reduce((s, r, i) => s + r.qty * values[i], 0);
  for (let guard = 0; diff !== 0 && guard < 10000; guard++) {
    const dir = Math.sign(diff);
    const cands = rows.map((r, i) => ({ i, r, err: (values[i] - exact[i]) * dir })).filter((x) => x.r.qty <= Math.abs(diff));
    if (!cands.length) break;
    cands.sort((a, b) => a.err - b.err || a.r.qty - b.r.qty);
    values[cands[0].i] += dir;
    diff -= dir * cands[0].r.qty;
  }
  return { values, residual: diff };
}

/** Flange-to-web: 2 fillets x each flange's long edge; size from the thinner plate. */
function sawOf(kids, notes, label) {
  const flanges = kids.filter(isFlange);
  const webs = kids.filter(isWeb);
  if (!flanges.length || !webs.length) { notes.push(`${label}: no flange/web plates under it — no SAW length.`); return null; }
  const fp = flanges.map((k) => ({ k, p: plate(k) }));
  const wp = webs.map(plate).filter(Boolean);
  if (fp.some((x) => !x.p) || !wp.length) { notes.push(`${label}: a flange or web has no LENGTH/WIDTH/THICKNESS — no SAW length.`); return null; }
  const webT = Math.min(...wp.map((p) => p.t));
  const length = fp.reduce((s, { k, p }) => s + k.quantity * 2 * p.long, 0) / 1000;
  const size = sizeBand(Math.min(...fp.map(({ p }) => Math.min(p.t, webT))));
  return { length: r3(length), size, webT };
}

/**
 * The derived values for one line's tree. `root` is explode()'s root with
 * every node carrying `cls` (classification code) and `vals` (its own numeric
 * values by code). Returns per item id the values, and the rule each follows.
 */
export function deriveQuantities(root) {
  const notes = [];
  const byItem = new Map(); // itemId -> { name, cls, values: Map(code -> { value, rule }) }
  const conflicts = [];
  const put = (n, code, value, rule) => {
    if (value == null) return;
    if (!byItem.has(n.id)) byItem.set(n.id, { id: n.id, name: n.name, cls: n.cls, nodes: [], values: new Map() });
    const rec = byItem.get(n.id);
    const had = rec.values.get(code);
    if (had && had.value !== value) { conflicts.push(`${n.name} (item ${n.id}) ${code}: ${had.value} vs ${value} — kept ${had.value}`); return; }
    rec.values.set(code, { value, rule });
  };
  const all = [];
  const walk = (n, parent) => { n.parent = parent; all.push(n); for (const k of n.children) walk(k, n); };
  walk(root, null);

  for (const n of all) {
    const label = `${n.name} (item ${n.id})`;
    if (n.cls === 'GIRDER_SEGMENT') {
      const saw = sawOf(n.children, notes, label);
      if (saw) {
        put(n, 'SAW_WELD_LENGTH', saw.length, 'flange-to-web: 2 fillets x each flange long edge');
        put(n, 'SAW_WELD_SIZE', saw.size, `fill-up band (thinner plate >= ${FILL_BAND_MIN_PLATE} mm)`);
      }
      const pieces = [];
      for (const k of n.children.filter(isStiffener)) {
        const p = plate(k);
        if (!p) { notes.push(`${label}: stiffener ${k.name} has no LENGTH/WIDTH/THICKNESS — left out.`); continue; }
        for (let i = 0; i < k.quantity; i++) pieces.push(p);
      }
      if (pieces.length) {
        pieces.sort((a, b) => b.long - a.long || b.t - a.t);
        const before = pieces.filter((_, i) => i % 2 === 0);
        const after = pieces.filter((_, i) => i % 2 === 1);
        const weld = (ps) => r3(ps.reduce((s, p) => s + 2 * p.long, 0) / 1000);
        put(n, 'STIFFENERS', before.length, 'half the stiffeners, one face of the web, before the flip');
        put(n, 'STIFFENERS_AFTER_FLIP', after.length, 'the other half, after the flip');
        put(n, 'MIG_WELD_LENGTH', weld(before), '2 fillets x long edge of each stiffener fitted before the flip');
        put(n, 'MIG_WELD_LENGTH_AFTER_FLIP', weld(after), '2 fillets x long edge of each stiffener fitted after the flip');
        const webT = saw?.webT ?? Infinity;
        put(n, 'MIG_WELD_SIZE', sizeBand(Math.min(...pieces.map((p) => Math.min(p.t, webT)))), 'workbook MIG I-beam band (12 mm) for joints >= 10 mm');
      } else notes.push(`${label}: no stiffeners under it.`);
    }
    if (n.cls === 'DIAPHRAGM') {
      const saw = sawOf(n.children, notes, label);
      if (saw) {
        put(n, 'SAW_WELD_LENGTH', saw.length, 'flange-to-web: 2 fillets x each flange long edge');
        put(n, 'SAW_WELD_SIZE', saw.size, `fill-up band (thinner plate >= ${FILL_BAND_MIN_PLATE} mm)`);
      }
      const others = n.children.filter((k) => !isFlange(k) && !isWeb(k)).map((k) => ({ k, p: plate(k) }));
      if (others.some((x) => !x.p)) notes.push(`${label}: a plate has no LENGTH/WIDTH/THICKNESS — left out of ARC.`);
      const ok = others.filter((x) => x.p);
      if (ok.length) {
        const webT = saw?.webT ?? Infinity;
        put(n, 'ARC_WELD_LENGTH', r3(ok.reduce((s, { k, p }) => s + k.quantity * 2 * p.long, 0) / 1000), 'every plate not a flange or web: 2 fillets x long edge');
        put(n, 'ARC_WELD_SIZE', sizeBand(Math.min(...ok.map(({ p }) => Math.min(p.t, webT)))), `fill-up band (thinner plate >= ${FILL_BAND_MIN_PLATE} mm)`);
      }
    }
    if (n.cls === 'GIRDER_LINE') {
      const studs = n.children.filter(isStud).reduce((s, k) => s + k.quantity, 0);
      const segs = n.children.filter((k) => k.cls === 'GIRDER_SEGMENT');
      if (!studs) { if (segs.length) notes.push(`${label}: no shear studs under the girder line — no STUDS.`); continue; }
      if (!segs.length) { notes.push(`${label}: ${studs} studs but no segments to share them over.`); continue; }
      const rows = segs.map((s) => {
        const tf = s.children.find(isTopFlange);
        const len = (tf && plate(tf)?.long) ?? s.vals.LENGTH ?? null;
        return { qty: s.quantity, weight: len ?? 0, seg: s };
      });
      if (rows.some((r) => !r.weight)) { notes.push(`${label}: a segment has no top-flange length — studs not shared.`); continue; }
      const { values, residual } = shareWhole(studs, rows);
      if (residual) notes.push(`${label}: ${studs} studs could not be shared in whole numbers (${residual} left over) — STUDS left out.`);
      else rows.forEach((r, i) => put(r.seg, 'STUDS', values[i], `girder line's ${studs} studs by top-flange length`));
    }
  }
  return { all, byItem, notes, conflicts };
}

/* ===========================================================================
 * Read
 * ======================================================================== */

const DERIVED = ['SAW_WELD_LENGTH', 'SAW_WELD_SIZE', 'MIG_WELD_LENGTH', 'MIG_WELD_LENGTH_AFTER_FLIP', 'MIG_WELD_SIZE',
  'ARC_WELD_LENGTH', 'ARC_WELD_SIZE', 'STIFFENERS', 'STIFFENERS_AFTER_FLIP', 'STUDS', 'METALLISE_COATS'];
export const LEFT_EMPTY = {
  PAINT_COATS: 'no paint system in the workbook, BOQ or order — the user supplies it',
  HOLES: 'hole counts are on the detailing drawings, not in the BOQ or workbook',
  HOLE_DIA: 'hole diameters are on the detailing drawings',
  HOLE_TRANSFERS: 'hole transfers are on the detailing drawings',
  HOLES_TOP: 'top-flange splice holes are on the detailing drawings',
  HOLES_BOTTOM: 'bottom-flange splice holes are on the detailing drawings',
  HOLES_INNER: 'inner-splice holes are on the detailing drawings',
};
const LENGTH_CODES = new Set(['SAW_WELD_LENGTH', 'MIG_WELD_LENGTH', 'MIG_WELD_LENGTH_AFTER_FLIP', 'ARC_WELD_LENGTH']);
const LIVE_ORDER = (s) => !['closed', 'lost', 'cancelled', 'revised'].includes(s);

export async function findLine(db, companyId, lineId) {
  const [rows] = await db.query(
    `SELECT ol.id, ol.order_id, ol.line_no, ol.item_id, ol.quantity, ol.locked_at, o.code AS order_code, o.status AS order_status
       FROM cf_sales_order_lines ol
       JOIN cf_sales_orders o ON o.company_id = ol.company_id AND o.id = ol.order_id AND o.deleted_at IS NULL
       JOIN cf_master_records m ON m.company_id = ol.company_id AND m.id = ol.item_id
       JOIN cf_classification_nodes n ON n.id = m.classification_id AND n.code = 'BRIDGE_SPAN'
      WHERE ol.company_id = ? AND ol.deleted_at IS NULL ${lineId ? 'AND ol.id = ?' : ''} ORDER BY ol.id`,
    lineId ? [companyId, lineId] : [companyId],
  );
  if (lineId) {
    if (!rows.length) throw new Error(`Line ${lineId} is not a line of company ${companyId} that sells a bridge span.`);
    return rows[0];
  }
  const live = rows.filter((l) => LIVE_ORDER(l.order_status));
  if (live.length !== 1) throw new Error(`${live.length} live lines sell a bridge span in company ${companyId} — pass --line <id>${live.length ? ` (${live.map((l) => l.id).join(', ')})` : ''}.`);
  return live[0];
}

/** The release, what would stop a take-back, and its steps' estimates. */
export async function releaseState(db, companyId, lineId) {
  const rel = await liveReleaseOfLine(db, companyId, lineId);
  if (!rel) return null;
  const [[[s]], [[i]], [[v]]] = await Promise.all([
    db.query(
      `SELECT COUNT(*) AS steps, SUM(s.est_minutes IS NOT NULL) AS timed, COALESCE(SUM(s.est_minutes), 0) AS minutes,
              SUM(s.state <> 'pending' OR s.qty_good > 0 OR s.qty_scrap > 0 OR s.started_at IS NOT NULL) AS started
         FROM cf_production_steps s JOIN cf_production_items pi ON pi.id = s.production_item_id
        WHERE s.company_id = ? AND pi.release_id = ? AND s.deleted_at IS NULL`, [companyId, rel.id]),
    db.query('SELECT COALESCE(SUM(issued), 0) AS issued, COUNT(*) AS reqs FROM cf_material_requirements WHERE company_id = ? AND release_id = ? AND deleted_at IS NULL', [companyId, rel.id]),
    db.query(`SELECT COUNT(*) AS n FROM cf_stock_reservations v JOIN cf_material_requirements q ON q.id = v.requirement_id
               WHERE v.company_id = ? AND q.release_id = ? AND v.status = 'active'`, [companyId, rel.id]),
  ]);
  return {
    id: rel.id, finishedAreaId: rel.finished_area_id, notes: rel.notes ?? null,
    steps: Number(s.steps), timed: Number(s.timed ?? 0), minutes: Number(s.minutes), started: Number(s.started ?? 0),
    issued: Number(i.issued), requirements: Number(i.reqs), reservations: Number(v.n),
  };
}

/**
 * Everything the derivation and the projection need, in a fixed number of
 * reads: the line, explode (2 + one a level), classes + values (2), flow steps
 * + rules (2), specs (1), overrides (1), the Values mirror (~6). Also used by
 * cf_arc_blast_rates.mjs.
 */
export async function load(db, companyId, lineId) {
  const line = await findLine(db, companyId, lineId);
  const tree = await explode(db, companyId, line.item_id, { rootQuantity: Number(line.quantity), maxDepth: 15 });
  const nodes = [];
  const walk = (n) => { nodes.push(n); n.children.forEach(walk); };
  walk(tree.root);
  const ids = [...new Set(nodes.map((n) => n.id))];
  const flowIds = [...new Set(nodes.map((n) => n.flow?.id).filter(Boolean))];
  const q = (sql, p) => db.query(sql, p).then(([r]) => r);
  const [cls, vals, steps, specs, overrides, release] = await Promise.all([
    q('SELECT m.id, n.code FROM cf_master_records m JOIN cf_classification_nodes n ON n.id = m.classification_id WHERE m.company_id = ? AND m.id IN (?)', [companyId, ids]),
    q(`SELECT v.subject_id, s.code, v.value_number, v.source FROM cf_spec_values v JOIN cf_specifications s ON s.id = v.specification_id
        WHERE v.company_id = ? AND v.subject_type = 'master' AND v.deleted_at IS NULL AND v.subject_id IN (?)`, [companyId, ids]),
    flowSteps(db, companyId, flowIds),
    q('SELECT * FROM cf_specifications WHERE company_id = ? AND deleted_at IS NULL AND code IN (?)', [companyId, [...DERIVED, ...Object.keys(LEFT_EMPTY)]]),
    q('SELECT bom_line_id, operation_id, work_minutes, setup_minutes FROM cf_time_overrides WHERE company_id = ? AND order_line_id = ? AND deleted_at IS NULL', [companyId, line.id]),
    releaseState(db, companyId, line.id),
  ]);
  const opIds = [...new Set([...steps.values()].flat().map((s) => s.operation_id))];
  const [rules, resolutions] = await Promise.all([
    opIds.length ? q(`SELECT r.operation_id, f.expression FROM cf_operation_machine_rules r
        JOIN cf_formulas f ON f.company_id = r.company_id AND f.id = r.work_formula_id AND f.deleted_at IS NULL
       WHERE r.company_id = ? AND r.deleted_at IS NULL AND r.eligible = 1 AND r.operation_id IN (?)`, [companyId, opIds]) : [],
    resolveLineRecords(db, companyId, line.id),
  ]);
  const clsOf = new Map(cls.map((r) => [r.id, r.code]));
  const valsOf = new Map();
  const ownOf = new Map(); // `${id}:${code}` -> { value, source }
  for (const v of vals) {
    if (!valsOf.has(v.subject_id)) valsOf.set(v.subject_id, {});
    if (v.value_number != null) valsOf.get(v.subject_id)[v.code] = Number(v.value_number);
    ownOf.set(`${v.subject_id}:${v.code}`, { value: v.value_number == null ? null : Number(v.value_number), source: v.source });
  }
  for (const n of nodes) { n.cls = clsOf.get(n.id) ?? null; n.vals = valsOf.get(n.id) ?? {}; }
  // What each operation's work formulas read of the item.
  const readsOfOp = new Map();
  for (const r of rules) {
    let refs = [];
    try { refs = parseFormula(r.expression).itemRefs ?? []; } catch { /* a broken formula reads nothing */ }
    if (!readsOfOp.has(r.operation_id)) readsOfOp.set(r.operation_id, new Set());
    for (const x of refs) readsOfOp.get(r.operation_id).add(String(x).toUpperCase());
  }
  const flowOps = new Map([...steps].map(([fid, ss]) => [fid, opsOfFlow(ss)]));
  const readsOfFlow = new Map();
  for (const [fid, ops] of flowOps) {
    const set = new Set();
    for (const o of ops.values()) for (const x of readsOfOp.get(o.id) ?? []) set.add(x);
    readsOfFlow.set(fid, set);
  }
  return {
    line, tree, nodes, specs: new Map(specs.map((s) => [s.code, s])), ownOf, flowOps, readsOfFlow, resolutions, release,
    overrides: new Map(overrides.map((o) => [`${o.bom_line_id ?? 0}:${o.operation_id}`, o])),
  };
}

/* ===========================================================================
 * Plan
 * ======================================================================== */

function plan(data) {
  const { byItem, notes, conflicts } = deriveQuantities(data.tree.root);
  // METALLISE_COATS: every piece whose flow metallises.
  for (const n of data.nodes) {
    if (!data.readsOfFlow.get(n.flow?.id)?.has('METALLISE_COATS')) continue;
    if (!byItem.has(n.id)) byItem.set(n.id, { id: n.id, name: n.name, cls: n.cls, values: new Map() });
    byItem.get(n.id).values.set('METALLISE_COATS', { value: METALLISE_COATS, rule: 'workbook gives no coat count -> 1' });
  }
  const readsOfItem = new Map();
  const piecesOfItem = new Map();
  for (const n of data.nodes) {
    if (!readsOfItem.has(n.id)) readsOfItem.set(n.id, new Set());
    for (const x of data.readsOfFlow.get(n.flow?.id) ?? []) readsOfItem.get(n.id).add(x);
    piecesOfItem.set(n.id, (piecesOfItem.get(n.id) ?? 0) + Number(n.total));
  }
  const holdable = (itemId, code) => !!data.resolutions.get(itemId)?.specs?.some((s) => s.spec.code === code && s.applicable && s.captureAt === 'item');
  const writes = [];     // change or already so
  const blocked = [];
  const unread = [];     // derived but the piece's flow does not read it
  for (const rec of byItem.values()) {
    for (const [code, { value, rule }] of rec.values) {
      const spec = data.specs.get(code);
      const pieces = piecesOfItem.get(rec.id) ?? 0;
      if (!readsOfItem.get(rec.id)?.has(code)) { unread.push({ ...rec, code, value }); continue; }
      if (!spec) { blocked.push({ item: rec, code, value, why: `no specification ${code} — run cf_operation_times.mjs --commit first` }); continue; }
      const stored = LENGTH_CODES.has(code) && String(spec.default_uom ?? 'm').toLowerCase() === 'mm' ? r3(value * 1000) : value;
      if (!holdable(rec.id, code)) { blocked.push({ item: rec, code, value: stored, why: `${code} is not assignable on this piece — cf_operation_times.mjs makes every flow input assignable` }); continue; }
      const own = data.ownOf.get(`${rec.id}:${code}`);
      const same = own && own.value != null && Math.abs(own.value - stored) < 1e-6 && own.source === SOURCE;
      writes.push({ item: rec, itemId: rec.id, code, spec, value: stored, uom: spec.default_uom ?? null, rule, pieces, before: own?.value ?? null, change: !same });
    }
  }
  // What the line's flows read that nothing derives (left empty, said so).
  const empty = new Map();
  for (const n of data.nodes) {
    for (const code of data.readsOfFlow.get(n.flow?.id) ?? []) {
      if (!LEFT_EMPTY[code] && !(code === 'MIG_WELD_LENGTH' || code === 'MIG_WELD_SIZE') ) continue;
      if (byItem.get(n.id)?.values.has(code)) continue;
      const why = LEFT_EMPTY[code] ?? (n.cls === 'DIAPHRAGM' ? 'a diaphragm\'s welds are counted as arc — nothing says which are MIG' : 'not derived');
      const k = `${code}|${why}`;
      if (!empty.has(k)) empty.set(k, { code, why, items: new Set(), pieces: 0 });
      const e = empty.get(k);
      if (!e.items.has(n.id)) { e.items.add(n.id); }
      e.pieces += Number(n.total);
    }
  }
  return { writes, blocked, unread, notes, conflicts, empty: [...empty.values()] };
}

/* ===========================================================================
 * Hours: the Times grid now, and projected with the derived values
 * ======================================================================== */

export async function lineTimes(db, companyId, line) {
  const v = await getLineTimes(db, companyId, line.order_id, line.id);
  const byCode = new Map();
  for (const o of v.operations) byCode.set(o.code, { name: o.name, minutes: v.totals.byOperation[o.id] ?? null });
  return { byCode, all: v.totals.all };
}

/**
 * The Times grid's arithmetic with the planned values laid over each piece's own
 * (buildTimesView's sum). `estimateFor(op, readers)` — optional — answers for an
 * operation whose rule is about to change (cf_arc_blast_rates.mjs); null falls
 * back to the rules in the database.
 */
export async function projectTimes(db, companyId, data, writes, { estimateFor = null } = {}) {
  const ops = new Map();
  for (const fo of data.flowOps.values()) for (const o of fo.values()) if (!ops.has(o.id)) ops.set(o.id, { id: o.id, code: o.code, name: o.name });
  const { estimate } = await loadMachineSide(db, companyId, ops, undefined);
  const add = new Map();
  for (const w of writes) { if (!add.has(w.itemId)) add.set(w.itemId, []); add.get(w.itemId).push(w); }
  const readers = new Map();
  const readerOf = (itemId) => {
    if (!readers.has(itemId)) {
      const r = data.resolutions.get(itemId);
      const map = r ? effectiveByCode(r) : new Map();
      for (const w of add.get(itemId) ?? []) map.set(w.code, { raw: w.value, dataType: 'number', optionValue: null, display: String(w.value), tableConfig: null });
      readers.set(itemId, r || add.has(itemId) ? valueReaders(map) : null);
    }
    return readers.get(itemId);
  };
  const memo = new Map();
  const byCode = new Map();
  const untimed = new Map();
  let all = 0;
  for (const n of data.nodes) {
    for (const o of data.flowOps.get(n.flow?.id)?.values() ?? []) {
      const k = `${n.id}:${o.id}`;
      if (!memo.has(k)) memo.set(k, estimateFor?.(o, readerOf(n.id)) ?? estimate(o.id, readerOf(n.id)));
      const f = memo.get(k);
      const ov = data.overrides.get(`${n.lineId ?? 0}:${o.id}`);
      const work = ov?.work_minutes != null ? Number(ov.work_minutes) : f.work;
      const setup = ov?.setup_minutes != null ? Number(ov.setup_minutes) : f.setup;
      if (!byCode.has(o.code)) byCode.set(o.code, { name: o.name, minutes: null });
      if (work != null) {
        const m = ((setup ?? 0) + work * Number(n.total)) * o.passes;
        byCode.get(o.code).minutes = (byCode.get(o.code).minutes ?? 0) + m;
        all += m;
      } else {
        if (!untimed.has(o.code)) untimed.set(o.code, { name: o.name, pieces: 0, reasons: new Set() });
        const u = untimed.get(o.code);
        u.pieces += Number(n.total) * o.passes;
        if (f.missing) u.reasons.add(f.missing);
      }
    }
  }
  return { byCode, all, untimed };
}

export async function newReleaseStats(db, companyId, releaseId) {
  const [[s]] = await db.query(
    `SELECT COUNT(*) AS steps, SUM(s.est_minutes IS NOT NULL) AS timed, COALESCE(SUM(s.est_minutes), 0) AS minutes
       FROM cf_production_steps s JOIN cf_production_items pi ON pi.id = s.production_item_id
      WHERE s.company_id = ? AND pi.release_id = ? AND s.deleted_at IS NULL`, [companyId, releaseId]);
  return { id: releaseId, steps: Number(s.steps), timed: Number(s.timed ?? 0), minutes: Number(s.minutes) };
}

/**
 * Take the line's release back, run `apply`, release again with the old
 * release's finished area and notes — all in the CALLER's transaction. No
 * release: just `apply`. Refuses (code STARTED) before `apply` if anything
 * started or was issued; unrelease refuses again if that changed meanwhile.
 * Shared with cf_arc_blast_rates.mjs.
 */
export async function reRelease(db, c, data, apply) {
  const rel = data.release;
  if (rel && (rel.started || rel.issued > 1e-9)) {
    const e = new Error(`Release ${rel.id} has started (${rel.started} step(s) begun, material issued ${rel.issued}) — it cannot be taken back. Nothing was written.`);
    e.code = 'STARTED';
    throw e;
  }
  if (rel) await unrelease(db, c, rel.id);
  await apply();
  if (!rel) return { tookBack: null, released: null };
  const r = await releaseLine(db, c, data.line.id, { finishedAreaId: rel.finishedAreaId, notes: rel.notes });
  const released = await newReleaseStats(db, c.companyId, r.id ?? r.release?.id ?? (await liveReleaseOfLine(db, c.companyId, data.line.id)).id);
  return { tookBack: rel, released };
}

/* ===========================================================================
 * The entry point (the test calls it) and the CLI
 * ======================================================================== */

/**
 * opts: { lineId?, commit?, userId?, times? (default true) }. Plans with
 * SELECTs only; with commit, applies in the CALLER's transaction: take back ->
 * values -> release again, or nothing at all when no value changes.
 */
export async function run(db, companyId, opts = {}) {
  const c = { companyId, userId: opts.userId ?? null };
  const data = await load(db, companyId, opts.lineId ?? null);
  const p = plan(data);
  const changes = p.writes.filter((w) => w.change);
  const wantTimes = opts.times !== false;
  const before = wantTimes ? await lineTimes(db, companyId, data.line) : null;
  const projected = wantTimes ? await projectTimes(db, companyId, data, p.writes) : null;
  const out = { data, ...p, changes, before, projected, after: null, tookBack: null, released: null, written: 0, stopped: null };
  const rel = data.release;
  if (rel && (rel.started || rel.issued > 1e-9)) {
    out.stopped = `Line ${data.line.line_no} of ${data.line.order_code} has started (${rel.started} step${rel.started === 1 ? '' : 's'} begun${rel.issued > 1e-9 ? `, material issued: ${rel.issued}` : ''}) — release ${rel.id} cannot be taken back, so its times cannot be re-estimated. Nothing was written.`;
  }
  if (!opts.commit || !changes.length) return out;
  if (out.stopped) { const e = new Error(out.stopped); e.code = 'STARTED'; throw e; }

  // 1. take back (unrelease refuses again if anything started meanwhile) ->
  // 2. the values, with history, onto the frozen pieces -> 3. release again, as it was released.
  const rr = await reRelease(db, c, data, async () => {
    const bySubject = new Map();
    for (const w of changes) { if (!bySubject.has(w.itemId)) bySubject.set(w.itemId, []); bySubject.get(w.itemId).push(w); }
    for (const [id, ws] of bySubject) {
      const typed = [];
      for (const w of ws) {
        const { typed: t, problem } = await valueSvc.coerce(db, companyId, w.spec, w.value);
        if (problem) throw new Error(`${w.code} on item ${id}: ${problem}`);
        typed.push({ spec: w.spec, typed: t, source: SOURCE });
      }
      out.written += (await valueSvc.upsertValues(db, c, 'master', id, typed)).length;
    }
  });
  out.tookBack = rr.tookBack;
  out.released = rr.released;
  if (wantTimes) out.after = await lineTimes(db, companyId, data.line);
  return out;
}

const pad = (s, n) => { const t = String(s ?? ''); return t.length > n ? `${t.slice(0, n - 1)}…` : t.padEnd(n); };
const h = (m) => (m == null ? '—' : (m / 60).toFixed(1));

export function printReport(out, { commit }) {
  const say = (...a) => console.log(...a);
  const { data, writes, changes, blocked, notes, conflicts, empty, unread, before, projected, after, released, tookBack } = out;
  const L = data.line;
  const rel = data.release;
  say(`line ${L.id} (${L.order_code} line ${L.line_no}, x${Number(L.quantity)}) — ${rel ? `RELEASED (release ${rel.id}: ${rel.steps} steps, ${rel.timed} timed, ${h(rel.minutes)} h; started ${rel.started}, issued ${rel.issued}, active reservations ${rel.reservations})` : L.locked_at ? 'LOCKED, not released' : 'live'}`);

  say('\nRULES (KEPL only — derived from the line\'s own plates, the BOQ and Process_Flow_v5.xlsx):');
  const rules = [
    ['SAW_WELD_LENGTH', 'flange-to-web: 2 fillets x each flange long edge (segment = 4 x length)'],
    ['SAW/MIG/ARC_WELD_SIZE', `workbook bands: thinner plate >= ${FILL_BAND_MIN_PLATE} mm -> fill-up ${FILL_SIZE} mm, else root ${ROOT_SIZE} mm`],
    ['STIFFENERS / _AFTER_FLIP', 'segment stiffeners split over the two web faces: ceil(n/2) before the flip, floor(n/2) after'],
    ['MIG_WELD_LENGTH / _AFTER_FLIP', '2 fillets x long edge of each stiffener on that face'],
    ['ARC_WELD_LENGTH', 'diaphragm plates that are neither flange nor web: 2 fillets x long edge (ARC_RATE chart missing: untimed)'],
    ['STUDS', 'girder line studs shared over its segments by top-flange length, whole studs, exact sum'],
    ['METALLISE_COATS', '1 on every piece whose flow metallises'],
  ];
  for (const [k, v] of rules) say(`  ${pad(k, 30)} ${v}`);

  say('\nVALUES (per piece):');
  say(`  ${pad('Spec', 27)} ${pad('Rows', 5)} ${pad('Pieces', 7)} ${pad('Range', 22)} ${pad('Change', 8)} Rule`);
  const byCode = new Map();
  for (const w of writes) { if (!byCode.has(w.code)) byCode.set(w.code, []); byCode.get(w.code).push(w); }
  for (const code of DERIVED.filter((x) => byCode.has(x))) {
    const ws = byCode.get(code);
    const vals = ws.map((w) => w.value);
    const lo = Math.min(...vals);
    const hi = Math.max(...vals);
    const range = `${lo === hi ? lo : `${lo} – ${hi}`}${ws[0].uom ? ` ${ws[0].uom}` : ''}`;
    say(`  ${pad(code, 27)} ${pad(ws.length, 5)} ${pad(ws.reduce((s, w) => s + w.pieces, 0), 7)} ${pad(range, 22)} ${pad(ws.filter((w) => w.change).length, 8)} ${ws[0].rule}`);
  }
  const studs = writes.filter((w) => w.code === 'STUDS').reduce((s, w) => s + w.value * w.pieces, 0);
  if (studs) say(`  studs on the line: ${studs.toLocaleString('en-US')} (BOQ 14,424 for 2 spans)`);
  say(`\n${changes.length} value(s) to write on ${new Set(changes.map((w) => w.itemId)).size} piece row(s); ${writes.length - changes.length} already so; ${blocked.length} blocked.`);
  for (const b of blocked) say(`  BLOCKED ${b.code} = ${b.value} on ${b.item.name} (item ${b.item.id}): ${b.why}`);
  if (unread.length) say(`  (${unread.length} derived value(s) not written: the piece's flow does not read them — ${[...new Set(unread.map((u) => u.code))].join(', ')})`);
  if (empty.length) {
    say('\nLEFT EMPTY (read by a flow on this line, not derivable — say so, never invent):');
    for (const e of empty) say(`  ${pad(e.code, 27)} ${pad(`${e.items.size} rows / ${e.pieces} pcs`, 22)} ${e.why}`);
  }
  if (notes.length || conflicts.length) { say('\nnotes:'); for (const x of [...notes, ...conflicts]) say(`  - ${x}`); }

  if (before) {
    const codes = [...new Set([...before.byCode.keys(), ...(projected?.byCode.keys() ?? [])])].sort();
    say(`\nHOURS per operation, whole line (Times grid) — now -> ${after ? 'after (re-read) [projected]' : 'projected with these values'}:`);
    say(`  ${pad('Operation', 50)} ${pad('Now h', 9)} ${pad(after ? 'After h' : 'Proj. h', 9)} ${after ? 'Proj. h' : ''}`);
    for (const code of codes) {
      const b = before.byCode.get(code);
      const pj = projected?.byCode.get(code);
      const a = after?.byCode.get(code);
      say(`  ${pad(`${code} ${b?.name ?? pj?.name ?? ''}`, 50)} ${pad(h(b?.minutes), 9)} ${pad(after ? h(a?.minutes) : h(pj?.minutes), 9)} ${after ? h(pj?.minutes) : ''}`);
    }
    say(`  ${pad('All', 50)} ${pad(h(before.all), 9)} ${pad(after ? h(after.all) : h(projected?.all), 9)} ${after ? h(projected?.all) : ''}`);
    if (projected?.untimed.size) {
      say('\nSTILL UNTIMED after this (operation: piece-passes, why):');
      for (const [code, u] of [...projected.untimed].sort()) say(`  ${pad(code, 20)} ${pad(u.pieces, 7)} ${[...u.reasons].slice(0, 2).join(' | ')}`);
    }
  }

  say('');
  if (out.stopped) say(`STOP: ${out.stopped}`);
  else if (!changes.length) say('No value changes — the release is left alone (nothing taken back, nothing re-released).');
  else if (!commit) say(rel ? `--commit would: take back release ${rel.id} (allowed: nothing started, nothing issued${rel.reservations ? `; ${rel.reservations} active reservation(s) would be let go — reserve again after` : ''}), write ${changes.length} value(s), release again into finished area ${rel.finishedAreaId}.` : `--commit would write ${changes.length} value(s) (the line is not released).`);
  if (commit && changes.length) {
    if (tookBack) say(`Took back release ${tookBack.id} (${tookBack.steps} steps, ${tookBack.timed} timed, ${h(tookBack.minutes)} h${tookBack.reservations ? `; ${tookBack.reservations} reservation(s) let go — reserve again` : ''}).`);
    say(`Wrote ${out.written} value(s), with history.`);
    if (released) say(`Released again: release ${released.id} — ${released.steps} steps, ${released.timed} timed, ${h(released.minutes)} h (was ${tookBack ? `${tookBack.timed} timed, ${h(tookBack.minutes)} h` : '—'}).`);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const COMMIT = argv.includes('--commit');
  const li = argv.indexOf('--line');
  const LINE = li >= 0 ? Number(argv[li + 1]) : null;
  const COMPANY = Number(process.env.CF_BRIDGE_COMPANY ?? 2);
  const USER = process.env.CF_BRIDGE_USER ? Number(process.env.CF_BRIDGE_USER) : null;
  const where = /^(localhost|127\.0\.0\.1|::1)?$/i.test(process.env.DB_HOST ?? '') ? 'local' : 'PRODUCTION';
  console.log(`${where}, company ${COMPANY} — ${COMMIT ? 'WRITING (take back -> values -> release again, one transaction)' : 'dry run (SELECTs only, read-only transaction)'}`);
  const conn = await pool.getConnection();
  let trips = 0;
  const db = new Proxy(conn, { get: (t, k) => (k === 'query' ? (...a) => { trips += 1; return t.query(...a); } : Reflect.get(t, k)) });
  const t0 = Date.now();
  try {
    if (COMMIT) await conn.beginTransaction();
    else {
      const [[{ v }]] = await conn.query('SELECT VERSION() AS v');
      // TiDB's READ ONLY is a no-op; a stale read is genuinely read-only (it refuses writes).
      await conn.query(/tidb/i.test(v) ? 'START TRANSACTION READ ONLY AS OF TIMESTAMP NOW() - INTERVAL 1 SECOND' : 'START TRANSACTION READ ONLY');
    }
    attachNodeCache(db);
    const out = await run(db, COMPANY, { lineId: LINE, commit: COMMIT, userId: USER });
    printReport(out, { commit: COMMIT });
    detachNodeCache(db);
    if (COMMIT) { await conn.commit(); console.log(out.changes.length ? '\nCommitted.' : '\nNothing to commit.'); } else await conn.query('ROLLBACK');
    console.log(`round trips: ${trips}, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  } catch (e) {
    try { await conn.query('ROLLBACK'); } catch { /* keep the first error */ }
    console.error(`\nFAILED, rolled back — nothing was written: ${e.code ?? ''} ${e.message}${e.problems ? ` ${JSON.stringify(e.problems)}` : ''}`);
    process.exitCode = 1;
  } finally {
    conn.release();
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
