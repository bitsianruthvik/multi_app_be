/**
 * nestingService.js — laying a line's cut plates out on real raw plates.
 *
 * WHAT THIS REPLACES
 * cutPlateService pools a sales order line's plate parts into CUT PLATES:
 * rectangles of one thickness/length/width/grade, each a temporary item of
 * quantity N. The BOM line from a cut plate to its raw plate carries an AREA
 * FRACTION, and cutPlateService.AREA_FRACTION_CAVEAT says out loud what that is
 * worth — it ignores how the blanks lie on the sheet and the offcut left over,
 * "a first answer, not a nesting plan". This is the nesting plan. It produces a
 * real plate count, and it asks for more steel than the fraction did, not less.
 *
 * TWO ENTRY POINTS AND A LOOK.
 *   planNesting    proposes a layout. Writes NOTHING, ever.
 *   acceptNesting  writes it: cf_plate_lots + cf_nest_placements, and the
 *                  quantity on each cut plate's raw-plate BOM line.
 *   getNesting     reads the saved plan back. A LOOK IS A LOOK — opening the
 *                  screen does not re-pack. Re-packing is something a person
 *                  asks for, because a search costs seconds and a saved plan
 *                  IS the plan.
 *
 * QUANTITY SEMANTICS, STATED ONCE AND MEANT EVERYWHERE BELOW.
 *   A PLACEMENT IS ONE PIECE ON ONE LOT. The plate count of a nest is always
 *   ONE, because a nest IS one lot — one physical plate drawn from stock once
 *   and shared by everything cut from it. So: COUNT LOTS to count plates; SUM
 *   PLACEMENTS to count pieces. Never sum placements to get plates. That
 *   arithmetic buys a plate per blank, which is the absurdity the area fraction
 *   existed to avoid in the first place.
 *
 * THE LINE QUANTITY IS MULTIPLIED EXACTLY ONCE, in surveyLine(), by handing
 * `rootQuantity: line.quantity` to explode(). Every piece count downstream is
 * already a whole-line count and nothing multiplies again.
 *
 * GROUPING IS ON THREE AXES TOGETHER — thickness, grade AND material. Grouping
 * on thickness alone nests an E350 rectangle onto an E250 plate and scores
 * BETTER for it, because it had more rectangles to choose from.
 *
 * THE UNKNOWN IS NOT SYMMETRIC. A rectangle that does not state its steel is
 * REFUSED — a part is a thing we are about to cut and guessing its grade is how
 * the wrong steel reaches the floor. A PLATE that does not state its grade or
 * material is TOLERATED as a candidate, because a catalog row with a blank
 * attribute is a data-entry gap, not a claim that the plate is made of nothing.
 *
 * THE PACKER IS PURE GEOMETRY (services/nestingPacker.js): no database, no
 * tenant, no order. Everything tenant-shaped is resolved here and handed in as
 * numbers. It is reached through a dynamic import, and `input.pack` can replace
 * it, because a pure function is the one thing in this app that is trivially
 * substitutable — a what-if, a test, or a second algorithm.
 *
 * THE SHOP'S CUTTING RULES, which this service resolves and the packer obeys:
 *   KERF IS BANDED BY PLATE THICKNESS (cf_cut_settings) — roughly 3 mm up to
 *   16 mm, 4 mm to 20 mm, 5 mm to 50 mm — and there is ONE number spent two
 *   ways. An EDGE boundary is unshared and costs one kerf, AT THE PLATE RIM
 *   TOO, because the raw plate's own edge is cut. A COMMON boundary is shared
 *   by two parts and is cut ONCE. Three 100 mm parts therefore span 312 mm
 *   sharing their boundaries and 318 mm not sharing them, at 3 mm kerf.
 *   A LAYOUT IS Plate -> Sequence -> Row -> Part. A sequence holds a fixed
 *   number of rows and is cut as a unit, in order, so the pierce order is
 *   controlled; rows per sequence come from part size on BOTH dimensions
 *   (under 200 mm on both = Small = 2 rows, otherwise Big = 3). Consecutive
 *   sequences are 5–8 mm apart.
 *   THE PLATE IS ORDERED LARGER THAN THE LAYOUT NEEDS — +50 mm on width and
 *   +100 mm on length — because plate edges are not straight and a standard
 *   size procures faster. That difference is deliberate and is not waste, so a
 *   lot records the REQUIRED size and the ORDERED size as two numbers.
 *
 * ONE RESOLVER FOR THOSE NUMBERS (resolveCutSettings), used by the planner and
 * by the accept-time verification alike. Two constants in two places is the
 * bug: fab ran 2 mm in its packer and 4 mm in its remnant tracker and made
 * every drop 2 mm small on every edge.
 *
 * VERIFICATION HAPPENS INSIDE THE ACCEPT TRANSACTION, AND READS THE DATABASE,
 * NEVER THE REQUEST — the sizes, the grades, the piece counts and the cutting
 * settings all come back out of the DB. But it verifies the RECORDED GEOMETRY:
 * it checks that the layout it was handed is legal, it does not re-solve each
 * sheet from empty and compare. fab did the latter and refused about a quarter
 * of its own plans with a 422.
 *
 * IMPORTED NESTS AND "NEST THE REST" (decided 2026-09-29, CF_ERP_NESTING_PLAN
 * last section). The user: people often nest in another program and get a
 * plan of several nests, each one standard plate plus the cut plates on it
 * with quantities. So a lot has an ORIGIN:
 *   'auto'      our packer laid it out (planNesting / acceptNesting)
 *   'imported'  it came in from the nesting sheet, a plate and quantities.
 *               checkNest says whether it will work (fits / tight / wont_fit)
 *               and the user may save it anyway ("forced").
 * planNesting takes the imported lots' pieces off the demand, and
 * acceptNesting clears only 'auto' lots. With nothing imported it is the full
 * automatic nesting it always was. NEST_MANUAL now means "leave it out of
 * AUTOMATIC nesting" — such a cut plate may sit on an imported lot.
 *
 * EVERY SAVED LOT carries its waste split by cause (nestGeometry.analyseNest:
 * kerf, sequence gaps, rim, offcut, wastage) in waste_json, and its reusable
 * offcuts as cf_offcuts rows. "Only what is left is wastage."
 */
import { invalid, notFound, assertNoProblems } from '../lib/errors.js';
import { insertRows } from '../lib/db.js';
import { LOCKED_ORDER_STATUSES, revisedOrderMessage, latestRevisionSql } from './records.js';
import { subtreeIds } from './tree.js';
import { explode } from './bomService.js';
import { runAll, pickBest, seedsFor } from '../lib/packerPool.js';
import { analyseNest } from './nestGeometry.js';
import { availability } from './rollOutService.js';

/* ---------------------------------------------------------------------------
 * Vocabulary
 * ------------------------------------------------------------------------ */

/** Where raw plates and cut plates are filed. Found by code, like cutPlateService. */
export const PLATE_CODE = 'PLATE';
export const CUT_PLATE_CODE = 'CUT_PLATE';

/** The boolean specification that keeps a cut plate out of the packer. */
export const NEST_MANUAL_SPEC_CODE = 'NEST_MANUAL';

/** Under this on BOTH dimensions a part is Small, and a sequence holds 2 rows. */
export const SMALL_PART_MM = 200;

/** Steel, when the plate does not say. Only ever used to turn area into kilograms. */
const FALLBACK_DENSITY = 7850;

/**
 * What the shop does when cf_cut_settings holds nothing at all. A default in
 * code rather than a refusal, because a company that has not opened the
 * settings screen yet should still be able to see a plan; `basis` says which
 * of these numbers a plan was built on, so nobody has to guess.
 */
/**
 * The shop's published kerf bands (PFPL v1). init.sql SEEDS these into
 * cf_cut_settings for every company; this copy exists because SQL and JS cannot
 * share a literal, and `nesting_test` asserts the two agree so they cannot
 * drift apart silently.
 *
 * 5–16 mm is quoted as 2.5–3; 3 is taken, which is the number the shop's own
 * worked example uses (100 x 100 on 16 mm plate nests as 103 x 103).
 */
export const PUBLISHED_KERF_BANDS = Object.freeze([
  Object.freeze({ minMm: 5, maxMm: 16, kerfMm: 3 }),
  Object.freeze({ minMm: 18, maxMm: 20, kerfMm: 4 }),
  Object.freeze({ minMm: 25, maxMm: 50, kerfMm: 5 }),
]);

/** The published kerf for a thickness; the widest band's value off the top. */
export function publishedKerf(thicknessMm) {
  const t = Number(thicknessMm);
  if (!(t > 0)) return DEFAULT_CUT_SETTINGS.kerfMm;
  for (const b of PUBLISHED_KERF_BANDS) if (t >= b.minMm && t <= b.maxMm) return b.kerfMm;
  return t > PUBLISHED_KERF_BANDS[PUBLISHED_KERF_BANDS.length - 1].maxMm
    ? PUBLISHED_KERF_BANDS[PUBLISHED_KERF_BANDS.length - 1].kerfMm
    : DEFAULT_CUT_SETTINGS.kerfMm;
}

/**
 * HOW MANY SEEDS A PLAN TRIES, AND WHY MORE THAN ONE.
 *
 * Running several seeds and keeping the best is a real mechanism and it works:
 * the layouts differ, and on one steel group here seed 7 genuinely beat seed 1.
 * It is just the EXPENSIVE axis. Measured end to end on the real KEPL line:
 *
 *   1 seed  x  8 restarts   651.158 t    23 s
 *   1 seed  x 32 restarts   650.991 t    35 s   <- 167 kg for 12 s
 *   8 seeds x 32 restarts   650.964 t   138 s   <-  27 kg for 103 s
 *   8 seeds x 64 restarts   650.923 t   259 s
 *
 * Per second of compute more restarts pay 14 kg, more seeds 0.26 kg. Fifty
 * times worse — because restarts inside ONE run inherit the repairs that
 * improved the running best, while independent seeds each spend their repair
 * budget on their own local best and throw the rest away.
 *
 * Nor are seeds free in wall clock, which was the hope. Six steel groups times
 * eight seeds is 48 CPU-bound jobs on seven workers: seven waves, not one. The
 * floor is the single slowest GROUP and no number of cores gets under it.
 *
 * SET TO 8 BY THE USER (2026-09-25), with 64 restarts, and the cost is known:
 * 650.983 t in 245 s against 650.991 t in 35 s at one seed x 32 restarts — eight
 * kilograms for seven times the wall clock.
 *
 * MOST OF THAT WORK IS A DUPLICATE, AND IT IS WORTH SEEING WHY. The seeds ARE
 * distinct (seedsFor proves it against the real generator, and drops any that
 * are not). What converges is the ANSWER: with 64 restarts inside every run the
 * search explores enough that where it started stops mattering. On the real KEPL
 * line eight seeds produced ONE layout in four groups of six, eight in the 16 mm
 * group and three in the 32 mm one. Seven eighths of the CPU redid a layout
 * already in hand.
 *
 * That is why `distinct` is reported per group: if it reads 1, the seeds bought
 * nothing there and the number can come down. It is the honest dial to watch,
 * not the seed count.
 */
export const DEFAULT_SEEDS = 1;

export const DEFAULT_CUT_SETTINGS = {
  kerfMm: 3,
  seqGapMinMm: 5,
  seqGapMaxMm: 8,
  orderMarginLengthMm: 100,
  orderMarginWidthMm: 50,
  orderStepMm: 50,
  guillotine: false,
  // A reusable offcut: at least 300 x 300 of area AND an inscribed rectangle
  // whose short side is at least 100 mm (user, 2026-09-29).
  offcutMinAreaMm2: 90000,
  offcutMinSideMm: 100,
};

/**
 * The size of plate to ORDER for a layout that needs `requiredMm`.
 *
 * The rule (decided by the user 2026-09-25): ADD the margin, THEN round up to
 * the next step. Plate edges are not straight, so the margin is real slack that
 * must survive; rounding afterwards is what makes it a size a mill sells.
 *
 * Note the shop's own worked example does NOT follow this: it takes 2562 mm to
 * 2600 (+38), which is a bare round-up with no margin left. Under this rule the
 * same case orders 2650. That divergence is deliberate — rounding alone gives
 * ZERO slack whenever the requirement is already round, which defeats the
 * reason the margin exists.
 */
export const orderedSize = (requiredMm, marginMm, stepMm) => {
  const step = Number(stepMm) > 0 ? Number(stepMm) : 1;
  return Math.ceil((Number(requiredMm) + Number(marginMm)) / step) * step;
};

/** mm are stored to three decimals, so anything under a micron is the same number. */
const EPS = 0.0005;
const round3 = (n) => Number(Number(n).toFixed(3));
const round6 = (n) => Number(Number(n).toFixed(6));
const num = (v) => (v == null || v === '' ? null : Number(v));
const pos = (v) => { const n = num(v); return n != null && Number.isFinite(n) && n > 0 ? n : null; };
const blank = (v) => v == null || String(v).trim() === '';
const nameOf = (r) => r?.code ?? r?.name ?? `#${r?.id}`;
const fmt = (n) => (n == null ? '?' : String(round3(n)));
const list = (names) => (names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

/** Under 200 mm on BOTH dimensions is Small. Size, not role, decides. */
export const isSmallPart = (length, width) => Number(length) < SMALL_PART_MM && Number(width) < SMALL_PART_MM;

/** A sequence holds 2 rows of Small parts, 3 once anything in it is Big. */
export const rowsPerSequence = (parts) => (parts.every((p) => isSmallPart(p.length, p.width)) ? 2 : 3);

/** Area in mm2 -> kilograms, given a thickness in mm and a density in kg/m3. */
const kgOf = (areaMm2, thicknessMm, density) =>
  round3((areaMm2 / 1e6) * (Number(thicknessMm) / 1000) * (Number(density) || FALLBACK_DENSITY));

/* ---------------------------------------------------------------------------
 * Cut settings — the ONE resolver
 * ------------------------------------------------------------------------ */

/**
 * The kerf, sequence gaps, ordering margins and cutting mode for one plate
 * thickness. THE ONLY WAY ANY OF THOSE NUMBERS IS OBTAINED, by the planner and
 * by the verifier both.
 *
 * Bands are inclusive at both ends and may be half-open (a NULL end is no
 * bound). The NARROWEST band that covers the thickness wins, so overlapping
 * bands resolve the same way every time instead of by insertion order; ties go
 * to the lowest id. A row with both ends NULL is the company default and is
 * used only when no band covers the thickness.
 */
export async function resolveCutSettings(db, companyId, thicknessMm) {
  const rows = await cutSettingRows(db, companyId);
  return pickCutSettings(rows, thicknessMm);
}

async function cutSettingRows(db, companyId) {
  const [rows] = await db.query(
    `SELECT id, thickness_min_mm, thickness_max_mm, kerf_mm, seq_gap_min_mm, seq_gap_max_mm,
            order_margin_length_mm, order_margin_width_mm, order_step_mm, guillotine,
            offcut_min_area_mm2, offcut_min_side_mm, notes
       FROM cf_cut_settings
      WHERE company_id = ? AND deleted_at IS NULL
      ORDER BY id`,
    [companyId],
  );
  return rows;
}

const shapeSettings = (r, basis) => ({
  id: r.id,
  kerfMm: Number(r.kerf_mm),
  seqGapMinMm: Number(r.seq_gap_min_mm),
  seqGapMaxMm: Number(r.seq_gap_max_mm),
  orderMarginLengthMm: Number(r.order_margin_length_mm),
  orderMarginWidthMm: Number(r.order_margin_width_mm),
  orderStepMm: Number(r.order_step_mm ?? 50),
  guillotine: !!r.guillotine,
  offcutMinAreaMm2: r.offcut_min_area_mm2 == null ? DEFAULT_CUT_SETTINGS.offcutMinAreaMm2 : Number(r.offcut_min_area_mm2),
  offcutMinSideMm: r.offcut_min_side_mm == null ? DEFAULT_CUT_SETTINGS.offcutMinSideMm : Number(r.offcut_min_side_mm),
  basis,
});

function pickCutSettings(rows, thicknessMm) {
  const t = num(thicknessMm);
  const isDefault = (r) => r.thickness_min_mm == null && r.thickness_max_mm == null;
  const covers = (r) => !isDefault(r)
    && (r.thickness_min_mm == null || t >= Number(r.thickness_min_mm) - EPS)
    && (r.thickness_max_mm == null || t <= Number(r.thickness_max_mm) + EPS);

  if (t != null) {
    const bands = rows.filter(covers).sort((a, b) => {
      const w = (r) => (r.thickness_min_mm == null || r.thickness_max_mm == null
        ? Number.POSITIVE_INFINITY
        : Number(r.thickness_max_mm) - Number(r.thickness_min_mm));
      return w(a) - w(b) || a.id - b.id;
    });
    if (bands.length) {
      const b = bands[0];
      const label = `${b.thickness_min_mm == null ? '' : `${fmt(b.thickness_min_mm)}`}–${b.thickness_max_mm == null ? '' : `${fmt(b.thickness_max_mm)}`} mm band`;
      return shapeSettings(b, label);
    }
  }
  const dflt = rows.find(isDefault);
  if (dflt) return shapeSettings(dflt, 'the company default row');
  // Nothing is set up. Still band the kerf by thickness — flattening every
  // plate to one number nests 40 mm plate at 3 mm instead of 5, and the parts
  // come out undersized at the torch with nothing on screen to say why.
  return {
    id: null,
    ...DEFAULT_CUT_SETTINGS,
    kerfMm: t != null ? publishedKerf(t) : DEFAULT_CUT_SETTINGS.kerfMm,
    basis: 'the published bands (nothing is set up in Cut settings)',
  };
}

/**
 * The span a row of n parts takes, boundaries included. Shared boundaries are
 * cut once, so n parts cost n + 1 kerfs, and the rim costs one of them. This is
 * the arithmetic behind the shop's own example: three 100 mm parts span 312 mm
 * at 3 mm kerf sharing their boundaries, 318 mm not sharing them.
 */
export const sharedSpan = (sizes, kerfMm) =>
  round3(sizes.reduce((a, b) => a + Number(b), 0) + (sizes.length + 1) * Number(kerfMm));

/* ---------------------------------------------------------------------------
 * Waste by cause, and offcuts — one lot at a time
 * ------------------------------------------------------------------------ */

/** The causes, in the order the plate is shared out (nestGeometry). */
export const WASTE_KEYS = Object.freeze(['kerf', 'sequenceGaps', 'rim', 'offcut', 'wastage']);

/** A, B, … Z, AA, AB … — the `<lotNo>-A` suffix. Offcuts come biggest first. */
export function offcutLetters(n) {
  let s = '';
  let i = n + 1;
  while (i > 0) { const r = (i - 1) % 26; s = String.fromCharCode(65 + r) + s; i = Math.floor((i - 1) / 26); }
  return s;
}

const zeroWaste = () => Object.fromEntries(WASTE_KEYS.map((k) => [k, 0]));
const rect4 = (r) => (r ? { x: round3(r.x), y: round3(r.y), length: round3(r.length), width: round3(r.width) } : null);

/**
 * What one plate is made of: the parts, and every other square millimetre
 * given to exactly one cause (nestGeometry.analyseNest). Pure.
 *
 *   lot     { lotNo, length, width, thickness, density, kerfMm, seqGapMinMm,
 *             offcutMinAreaMm2, offcutMinSideMm }
 *   pieces  [{ x, y, length, width, seqNo, rowNo }] — x/y NULL = no layout
 *
 * Returns the per-lot fields the contract names — waste (mm²), wasteKg,
 * offcuts, hasLayout — plus `json`, what cf_plate_lots.waste_json stores.
 * With any piece unlaid there are no offcuts (nobody knows where the free
 * steel is) and the free area is all wastage; if the unlaid pieces need more
 * than the plate, `overflow` says by how much.
 */
export function wasteOfLot(lot, pieces) {
  const kg = (a) => kgOf(a, lot.thickness, lot.density);
  const hasLayout = pieces.length > 0 && pieces.every((p) => p.x != null && p.y != null);
  const length = Number(lot.length);
  const width = Number(lot.width);
  if (!(length > 0 && width > 0)) {
    return { hasLayout, waste: zeroWaste(), wasteKg: zeroWaste(), partsArea: 0, partsKg: 0, offcuts: [], json: null, warnings: [] };
  }
  const a = analyseNest({
    length, width,
    kerf: Number(lot.kerfMm) || 0,
    seqGapMin: Number(lot.seqGapMinMm) || 0,
    pieces: pieces.map((p) => ({ x: p.x, y: p.y, length: p.length, width: p.width, seqNo: p.seqNo, rowNo: p.rowNo })),
    minOffcutArea: lot.offcutMinAreaMm2 ?? DEFAULT_CUT_SETTINGS.offcutMinAreaMm2,
    minOffcutSide: lot.offcutMinSideMm ?? DEFAULT_CUT_SETTINGS.offcutMinSideMm,
  });
  const waste = Object.fromEntries(WASTE_KEYS.map((k) => [k, round3(a.waste?.[k] ?? 0)]));
  const wasteKg = Object.fromEntries(WASTE_KEYS.map((k) => [k, kg(waste[k])]));
  const offcuts = (a.offcuts ?? []).map((o, i) => ({
    offcutNo: `${lot.lotNo ?? 'N'}-${offcutLetters(i)}`,
    area: round3(o.area),
    weightKg: kg(o.area),
    rect: rect4(o.rect),
    bbox: rect4(o.bbox),
    outline: o.outline ?? [],
  }));
  return {
    hasLayout,
    waste,
    wasteKg,
    partsArea: round3(a.partsArea),
    partsKg: kg(a.partsArea),
    offcuts,
    warnings: a.warnings ?? [],
    overflow: round3(a.overflow ?? 0),
    json: {
      plateArea: round3(a.plateArea), partsArea: round3(a.partsArea), ...waste,
      overflow: round3(a.overflow ?? 0), cutLength: round3(a.cutLength ?? 0), pierces: a.pierces ?? 0,
      offcuts: offcuts.length,
    },
  };
}

/** Sums of waste / wasteKg over nests that carry them. */
function sumWaste(nests) {
  const waste = zeroWaste();
  const wasteKg = zeroWaste();
  for (const n of nests) {
    for (const k of WASTE_KEYS) {
      waste[k] += Number(n.waste?.[k] ?? 0);
      wasteKg[k] += Number(n.wasteKg?.[k] ?? 0);
    }
  }
  for (const k of WASTE_KEYS) { waste[k] = round3(waste[k]); wasteKg[k] = round3(wasteKg[k]); }
  return { waste, wasteKg };
}

/* ---------------------------------------------------------------------------
 * The line, and the two rules that close it to change
 * ------------------------------------------------------------------------ */

async function requireLine(db, companyId, lineId, { lock = false } = {}) {
  const [[l]] = await db.query(
    `SELECT l.*, o.id AS order_id, o.code AS order_code, o.status AS order_status,
            o.revision AS order_revision, ${latestRevisionSql('o')} AS order_latest_revision,
            rel.id AS release_id
       FROM cf_sales_order_lines l
       JOIN cf_sales_orders o ON o.id = l.order_id AND o.deleted_at IS NULL
       LEFT JOIN cf_production_releases rel ON rel.order_line_id = l.id AND rel.deleted_at IS NULL
      WHERE l.company_id = ? AND l.id = ? AND l.deleted_at IS NULL${lock ? ' FOR UPDATE' : ''}`,
    [companyId, lineId],
  );
  if (!l) throw notFound('Order line');
  return l;
}

/** The same two rules that close a structure to change: cut plates and their lots are part of it. */
function assertOpen(line) {
  if (LOCKED_ORDER_STATUSES.has(line.order_status)) {
    throw invalid('ORDER_LOCKED', line.order_status === 'revised' ? revisedOrderMessage(line.order_code, line.order_revision, line.order_latest_revision)
      : `Order ${line.order_code} is ${line.order_status} — its structure can no longer change, so its nesting cannot either.`);
  }
  if (line.release_id) {
    throw invalid('RELEASED', `Line ${line.line_no} of ${line.order_code} is released to production — its structure is fixed. Take the release back (while nothing has started) before re-nesting it.`);
  }
}

/**
 * The routes address a line THROUGH its order, so the two have to agree or the
 * URL is a lie: /orders/7/lines/99 must not quietly serve line 99 of order 3.
 * Checked once, up front, on the same connection as the work that follows.
 */
export async function assertLineOnOrder(db, companyId, orderId, lineId) {
  const line = await requireLine(db, companyId, lineId);
  if (orderId != null && Number(orderId) !== Number(line.order_id)) {
    throw invalid('WRONG_ORDER', `Line ${line.line_no} is not on order ${orderId} — it is on ${line.order_code}.`);
  }
  return line.id;
}

async function nodeByCode(db, companyId, code) {
  const [[n]] = await db.query(
    'SELECT id, code, name FROM cf_classification_nodes WHERE company_id = ? AND code = ? AND deleted_at IS NULL',
    [companyId, code],
  );
  return n || null;
}

async function places(db, companyId) {
  const cutPlate = await nodeByCode(db, companyId, CUT_PLATE_CODE);
  if (!cutPlate) throw invalid('NO_CUT_PLATE_CLASS', `There is no ${CUT_PLATE_CODE} variant under Steel › Plates, so nothing says where cut plates are filed — work the line's cut plates out first.`);
  const plate = await nodeByCode(db, companyId, PLATE_CODE);
  if (!plate) throw invalid('NO_PLATE_CLASS', `There is no ${PLATE_CODE} variant under Steel › Plates, so there is nowhere to look for raw plates to nest on.`);
  return {
    cutPlateIds: await subtreeIds(db, companyId, cutPlate.id),
    plateIds: await subtreeIds(db, companyId, plate.id),
    cutPlate,
    plate,
  };
}

/* ---------------------------------------------------------------------------
 * Reading the line: its cut plates, how many of each, and their steel
 * ------------------------------------------------------------------------ */

const SIZE_CODES = ['THICKNESS', 'LENGTH', 'WIDTH', 'GRADE', 'MATERIAL', 'DENSITY'];

/**
 * Every value an item ends up with is STORED on the item (decision Q18), so the
 * sizes are one query rather than a resolution per record. NEST_MANUAL is read
 * in the same pass but only where it is `entered`: the specification is a
 * person's answer about ONE cut plate, so a value materialised onto the item by
 * an inherited or fixed rule is not one, and must not silently take a rectangle
 * out of the pack.
 */
async function valuesOf(db, companyId, masterIds) {
  const out = new Map(masterIds.map((id) => [id, { size: new Map(), manual: false }]));
  if (!masterIds.length) return out;
  const [rows] = await db.query(
    `SELECT v.subject_id, s.code, s.data_type, v.value_number, v.value_text, v.value_bool,
            v.option_id, v.source, o.value AS option_value
       FROM cf_spec_values v
       JOIN cf_specifications s ON s.id = v.specification_id AND s.deleted_at IS NULL
       LEFT JOIN cf_spec_options o ON o.id = v.option_id
      WHERE v.company_id = ? AND v.subject_type = 'master' AND v.subject_id IN (?)
        AND v.deleted_at IS NULL AND s.code IN (?)`,
    [companyId, masterIds, [...SIZE_CODES, NEST_MANUAL_SPEC_CODE]],
  );
  for (const r of rows) {
    const bucket = out.get(r.subject_id);
    if (!bucket) continue;
    const code = String(r.code).toUpperCase();
    if (code === NEST_MANUAL_SPEC_CODE) {
      if (r.source === 'entered' && Number(r.value_bool) === 1) bucket.manual = true;
      continue;
    }
    bucket.size.set(code, r);
  }
  return out;
}

function steelOf(values) {
  const n = (code) => {
    const r = values.get(code);
    return r && r.value_number != null ? round3(Number(r.value_number)) : null;
  };
  const opt = (code) => {
    const r = values.get(code);
    if (!r) return null;
    const text = r.option_value ?? r.value_text;
    return blank(text) ? null : String(text).trim();
  };
  return {
    thickness: n('THICKNESS'),
    length: n('LENGTH'),
    width: n('WIDTH'),
    grade: opt('GRADE'),
    material: opt('MATERIAL'),
    density: n('DENSITY'),
  };
}

const norm = (s) => (blank(s) ? null : String(s).trim().toUpperCase());
const groupKey = (s) => `${s.thickness}|${norm(s.grade)}|${norm(s.material)}`;

/** What the rectangle failed to say about itself. An unknown HERE is refused. */
function missingOnPart(s) {
  const gone = [];
  if (!(s.thickness > 0)) gone.push('THICKNESS');
  if (!(s.length > 0)) gone.push('LENGTH');
  if (!(s.width > 0)) gone.push('WIDTH');
  if (!norm(s.grade)) gone.push('GRADE');
  if (!norm(s.material)) gone.push('MATERIAL');
  return gone;
}

/**
 * The line's cut plates, how many pieces of each the whole line needs, and the
 * steel each one is.
 *
 * THE LINE QUANTITY IS MULTIPLIED HERE AND NOWHERE ELSE. explode() carries a
 * `total` down the tree from `rootQuantity`, so a cut plate's total is already
 * "pieces for the whole line". A cut plate legitimately hangs under several
 * parts — that is what pooling IS — so its totals are summed across every
 * place it appears.
 */
async function surveyLine(db, companyId, line) {
  if (line.line_type !== 'custom') {
    throw invalid('NO_STRUCTURE', `Line ${line.line_no} of ${line.order_code} sells a catalog item, so it has no structure of its own — only a line built from a template has rectangles to nest.`);
  }
  if (!line.item_id) throw invalid('NO_ITEM', `Line ${line.line_no} of ${line.order_code} has no item yet.`);
  const where = await places(db, companyId);

  const tree = await explode(db, companyId, line.item_id, { rootQuantity: Number(line.quantity) });
  const totals = piecesByRecord(tree);

  const ids = [...totals.keys()];
  const [rows] = ids.length ? await db.query(
    `SELECT m.id, m.code, m.name, m.status, m.classification_id
       FROM cf_master_records m
       JOIN cf_item_details i ON i.master_id = m.id AND i.item_type = 'temporary' AND i.deleted_at IS NULL
      WHERE m.company_id = ? AND m.id IN (?) AND m.deleted_at IS NULL AND m.classification_id IN (?)
      ORDER BY m.id`,
    [companyId, ids, where.cutPlateIds],
  ) : [[]];

  const values = await valuesOf(db, companyId, rows.map((r) => r.id));
  const cutPlates = rows.map((r) => {
    const v = values.get(r.id);
    return {
      id: r.id, code: r.code, name: r.name, status: r.status,
      pieces: Math.round(totals.get(r.id) ?? 0),
      steel: steelOf(v.size),
      manual: v.manual,
    };
  });
  return { where, cutPlates, tree };
}

/**
 * Pieces of each record for the WHOLE line, from an exploded structure.
 * explode() carries `total` down from the line quantity, and a record under
 * several parents — a pooled cut plate — sums across every place it hangs.
 * surveyLine and layoutDriftOfLines both count with this, so the Nesting screen
 * and the process stage can never disagree about how many pieces a line needs.
 */
function piecesByRecord(tree) {
  const totals = new Map();
  (function walk(node) {
    if (node.id != null && node.depth > 0) totals.set(node.id, round6((totals.get(node.id) ?? 0) + Number(node.total)));
    for (const child of node.children) walk(child);
  }(tree.root));
  return totals;
}

/* ---------------------------------------------------------------------------
 * Out of date: what a saved layout no longer matches
 * ------------------------------------------------------------------------ */

/**
 * WHAT A SAVED LAYOUT NO LONGER MATCHES — the one rule, for the Nesting screen
 * and the process stage alike.
 *
 * It used to be two. The screen compared pieces; the stage only asked whether a
 * cut piece had no placement, or a placement had lost its cut piece. So a count
 * changed after nesting — a segment x2 made x3, one part of five taken off a
 * shared rectangle, the line itself made x3 — kept the stage "done" while the
 * buy list bought for the old count. User, 2026-09-26: "Even then it should be
 * made out of date."
 *
 *   cutPlates  what the line needs NOW, surveyLine's shape: [{ id, code, pieces, manual }]
 *   placed     what the saved layout places: Map(cutPlateId -> pieces)
 *   codes      optional Map(cutPlateId -> code), to name a cut plate that is gone
 *
 * A rectangle is held to its count when the layout must place it — accept's
 * own rule: not one marked NEST_MANUAL, which is laid out by hand or outside the
 * layout altogether. One entry per rectangle that differs:
 *   { cutPlateId, code, needs, placed, why }   why: 'count' | 'unplaced' | 'gone'
 * 'gone' is a rectangle the layout places that is no longer in the structure —
 * deleted, or re-pooled into another after its parts changed size. Pure.
 */
export function layoutDrift(cutPlates, placed, codes = new Map()) {
  const drift = [];
  const here = new Set();
  for (const cp of cutPlates) {
    here.add(cp.id);
    if (cp.manual) continue;
    const needs = cp.pieces ?? 0;
    const got = placed.get(cp.id) ?? 0;
    if (got !== needs) drift.push({ cutPlateId: cp.id, code: cp.code ?? null, needs, placed: got, why: got === 0 ? 'unplaced' : 'count' });
  }
  for (const [id, got] of placed) {
    if (!here.has(id) && got > 0) drift.push({ cutPlateId: id, code: codes.get(id) ?? null, needs: 0, placed: got, why: 'gone' });
  }
  return drift;
}

/** The same drift in words — one clause per kind, for a stage's line and its blocker. */
export function driftSentence(drift) {
  const of = (why) => drift.filter((d) => d.why === why).length;
  const n = (k, one, many) => `${k} ${k === 1 ? one : many}`;
  return [
    of('count') ? `${n(of('count'), 'cut piece needs', 'cut pieces need')} a different number of pieces` : null,
    of('unplaced') ? `${n(of('unplaced'), 'cut piece is', 'cut pieces are')} not laid out` : null,
    of('gone') ? `${n(of('gone'), 'laid-out cut piece is', 'laid-out cut pieces are')} no longer in the structure` : null,
  ].filter(Boolean).join(', ');
}

/**
 * layoutDrift for several lines at once, from structures the caller has
 * ALREADY exploded: processService explodes every line once for all its
 * stages, and exploding again here would double the order page's round trips
 * (~49 ms each on production). A handful of queries whatever the number of
 * lines — the saved placements, where cut plates are filed, which of the trees'
 * records are cut plates, and their NEST_MANUAL answers. A line with no saved
 * layout is left out: it is not nested, which is not the same as out of date.
 * Returns Map(lineId -> drift[]).
 */
export async function layoutDriftOfLines(db, companyId, lineIds, trees) {
  const out = new Map();
  if (!lineIds.length) return out;
  // The code of a cut plate that has since been deleted still names what was laid out.
  const [placedRows] = await db.query(
    `SELECT pl.order_line_id, np.cut_plate_id, COUNT(*) AS pieces, MAX(m.code) AS code
       FROM cf_plate_lots pl
       JOIN cf_nest_placements np ON np.plate_lot_id = pl.id AND np.company_id = pl.company_id AND np.deleted_at IS NULL
       LEFT JOIN cf_master_records m ON m.id = np.cut_plate_id
      WHERE pl.company_id = ? AND pl.deleted_at IS NULL AND pl.order_line_id IN (?)
      GROUP BY pl.order_line_id, np.cut_plate_id`,
    [companyId, lineIds],
  );
  const placedBy = new Map();
  const codes = new Map();
  for (const r of placedRows) {
    const lineId = Number(r.order_line_id);
    if (!placedBy.has(lineId)) placedBy.set(lineId, new Map());
    placedBy.get(lineId).set(Number(r.cut_plate_id), Number(r.pieces));
    if (r.code) codes.set(Number(r.cut_plate_id), r.code);
  }
  const nested = lineIds.map(Number).filter((id) => placedBy.has(id));
  if (!nested.length) return out;

  const totalsBy = new Map(nested.map((id) => [id, trees.get(id) ? piecesByRecord(trees.get(id)) : new Map()]));
  const recordIds = [...new Set([...totalsBy.values()].flatMap((t) => [...t.keys()]))];
  const cutNode = await nodeByCode(db, companyId, CUT_PLATE_CODE);
  const cutClassIds = cutNode ? await subtreeIds(db, companyId, cutNode.id) : [];
  const [rows] = recordIds.length && cutClassIds.length ? await db.query(
    `SELECT m.id, m.code
       FROM cf_master_records m
       JOIN cf_item_details i ON i.master_id = m.id AND i.item_type = 'temporary' AND i.deleted_at IS NULL
      WHERE m.company_id = ? AND m.id IN (?) AND m.deleted_at IS NULL AND m.classification_id IN (?)`,
    [companyId, recordIds, cutClassIds],
  ) : [[]];
  const values = await valuesOf(db, companyId, rows.map((r) => r.id));
  for (const lineId of nested) {
    const totals = totalsBy.get(lineId);
    const cutPlates = rows.filter((r) => totals.has(r.id)).map((r) => ({
      id: r.id, code: r.code, pieces: Math.round(totals.get(r.id) ?? 0), manual: values.get(r.id)?.manual ?? false,
    }));
    out.set(lineId, layoutDrift(cutPlates, placedBy.get(lineId), codes));
  }
  return out;
}

/* ---------------------------------------------------------------------------
 * Imported lots — what "nest the rest" keeps
 * ------------------------------------------------------------------------ */

/**
 * The line's live IMPORTED lots, and how many pieces of each cut plate they
 * hold. Two queries. `pieces` per lot is aggregated per cut plate — enough to
 * charge each cut plate its share of the plate (replaceAreaFractions) and to
 * take the pieces off the automatic demand.
 */
async function importedLotsOf(db, companyId, orderLineId) {
  const [lots] = await db.query(
    `SELECT l.id, l.lot_no, l.plate_item_id, l.length_mm, l.width_mm, l.thickness_mm, m.code AS plate_code
       FROM cf_plate_lots l
       LEFT JOIN cf_master_records m ON m.id = l.plate_item_id
      WHERE l.company_id = ? AND l.order_line_id = ? AND l.deleted_at IS NULL AND l.origin = 'imported'
      ORDER BY l.lot_no, l.id`,
    [companyId, orderLineId],
  );
  const counts = new Map();
  if (!lots.length) return { lots: [], counts, lotNos: new Set() };
  const [rows] = await db.query(
    `SELECT plate_lot_id, cut_plate_id, COUNT(*) AS pieces, SUM(length_mm * width_mm) AS area
       FROM cf_nest_placements
      WHERE company_id = ? AND plate_lot_id IN (?) AND deleted_at IS NULL
      GROUP BY plate_lot_id, cut_plate_id`,
    [companyId, lots.map((l) => l.id)],
  );
  const byLot = new Map(lots.map((l) => [l.id, []]));
  for (const r of rows) {
    byLot.get(r.plate_lot_id)?.push({ cutPlateId: Number(r.cut_plate_id), count: Number(r.pieces), area: Number(r.area) });
    counts.set(Number(r.cut_plate_id), (counts.get(Number(r.cut_plate_id)) ?? 0) + Number(r.pieces));
  }
  return {
    counts,
    lotNos: new Set(lots.map((l) => String(l.lot_no).toUpperCase())),
    lots: lots.map((l) => ({
      id: l.id,
      lotNo: l.lot_no,
      plate: {
        id: l.plate_item_id, code: l.plate_code,
        steel: { length: Number(l.length_mm), width: Number(l.width_mm), thickness: Number(l.thickness_mm) },
      },
      pieces: byLot.get(l.id) ?? [],
    })),
  };
}

/** N-001, N-002 … skipping any number an imported lot already wears. */
function autoLotNumbers(count, taken) {
  const out = [];
  let n = 0;
  while (out.length < count) {
    n += 1;
    const no = `N-${String(n).padStart(3, '0')}`;
    if (!taken.has(no.toUpperCase())) out.push(no);
  }
  return out;
}

/* ---------------------------------------------------------------------------
 * Candidate plates
 * ------------------------------------------------------------------------ */

/**
 * The raw plates a group could be cut from: catalog plates of the SAME
 * thickness whose grade and material do not contradict the group's.
 *
 * A BLANK ON THE PLATE IS TOLERATED. A catalog row with no MATERIAL is a
 * data-entry gap, not a claim that the plate is made of nothing, and refusing
 * it would leave a whole thickness unnestable for a reason nobody can see.
 * The same blank on the PART is refused, up in eligibility — the asymmetry is
 * the point.
 */
async function candidatePlates(db, companyId, plateIds) {
  if (!plateIds.length) return [];
  const [rows] = await db.query(
    `SELECT m.id, m.code, m.name
       FROM cf_master_records m
       JOIN cf_item_details i ON i.master_id = m.id AND i.item_type = 'catalog' AND i.deleted_at IS NULL
      WHERE m.company_id = ? AND m.deleted_at IS NULL AND m.status = 'active' AND m.classification_id IN (?)
      ORDER BY m.id`,
    [companyId, plateIds],
  );
  const values = await valuesOf(db, companyId, rows.map((r) => r.id));
  return rows.map((r) => ({ ...r, steel: steelOf(values.get(r.id).size) }));
}

/**
 * THE CUSTOMER'S OWN PLATES (init.sql §35, CF_ERP_MONEY_PLAN §1). When the
 * order's customer supplied plate, those plates are offered to the packer FIRST
 * for their order: a sheet that is preferred, costs nothing (it is not bought)
 * and is limited to the WHOLE plates of theirs that are free. Only the order's
 * customer's material is ever read — availability() never counts another
 * customer's lot — so another customer's plate is never nested. Our own stock
 * is not offered here (nesting still buys by catalog size). One read.
 * Returns Map plateItemId -> { ownerPartyId, count }.
 */
async function customerPlates(db, companyId, orderId, plateIds) {
  const out = new Map();
  if (!orderId || !plateIds.length) return out;
  const av = await availability(db, companyId, plateIds, { orderId });
  for (const [plateId, e] of av) {
    const owners = new Map();
    for (const b of e.batches) {
      if (b.owner !== 'theirs' || b.status !== 'available' || b.free <= EPS) continue;
      owners.set(b.ownerPartyId, (owners.get(b.ownerPartyId) ?? 0) + b.free);
    }
    // One customer per order, so at most one owner; the biggest if a party ever changed.
    const best = [...owners].sort((a, b) => b[1] - a[1])[0];
    if (best && Math.floor(best[1] + 1e-6) >= 1) out.set(plateId, { ownerPartyId: Number(best[0]), count: Math.floor(best[1] + 1e-6) });
  }
  return out;
}

const agrees = (plateValue, groupValue) => plateValue == null || norm(plateValue) === norm(groupValue);

function sheetsFor(plates, group) {
  return plates.filter((p) =>
    p.steel.thickness != null
    && Math.abs(p.steel.thickness - group.thickness) <= EPS
    && p.steel.length > 0 && p.steel.width > 0
    && agrees(p.steel.grade, group.grade)
    && agrees(p.steel.material, group.material));
}

/**
 * SORTED EXPLICITLY, ALWAYS. The database returns rows in whatever order it
 * likes and a greedy packer walks the list it is given: fab packed 130 sheets
 * two different ways with the same seed before it sorted them. The order below
 * matters far less than its being total and stable — a free offcut first, then
 * the largest plate, then the id, which is unique, so there is never a tie.
 */
const sortSheets = (sheets) => sheets.slice().sort((a, b) =>
  Number(b.preferred) - Number(a.preferred)
  || b.areaCost - a.areaCost
  || b.length - a.length
  || b.width - a.width
  || a.id - b.id);

/** The pieces are sorted for the same reason, biggest first, id last. */
const sortPieces = (pieces) => pieces.slice().sort((a, b) =>
  (b.length * b.width) - (a.length * a.width)
  || b.length - a.length
  || b.width - a.width
  || a.id - b.id);

/* ---------------------------------------------------------------------------
 * The packer — pure geometry, reached late
 * ------------------------------------------------------------------------ */

/**
 * The packer is a pure function, so it is the one thing here that is trivially
 * substitutable: `input.pack` replaces it for a what-if or a test. Otherwise it
 * is imported when it is first needed rather than at module load, so the rest
 * of this service — reading a saved plan, accepting one, the Excel sheet —
 * works whatever state that file is in.
 */
async function loadPacker(injected) {
  if (typeof injected === 'function') return injected;
  const mod = await import('./nestingPacker.js');
  // nestAsync first, and deliberately: Node runs one thing at a time, and a
  // synchronous pack of a real order holds the event loop for EVERY screen and
  // every tenant, not just this one — `/health` timed out at sixty seconds in
  // fab for exactly this. Same seed, same answer either way.
  const fn = mod.nestAsync ?? mod.nest ?? mod.default?.nestAsync ?? mod.default?.nest ?? mod.default;
  if (typeof fn !== 'function') throw invalid('NO_PACKER', 'services/nestingPacker.js does not export nest() or nestAsync().');
  return fn;
}

/* ---------------------------------------------------------------------------
 * planNesting — proposes. WRITES NOTHING.
 * ------------------------------------------------------------------------ */

/**
 * input: { effort?, guillotine?, seed?, pack? }
 *   effort      'quick' | 'standard' | 'deep' — how long the search may run
 *   guillotine  overrides the setting for this run (a what-if, not a saved change)
 *   seed        so a run can be repeated exactly
 *   pack        the packer, injected
 *
 * Returns groups, the cut plates held back by hand, size advice and every
 * problem it found — it does not throw for a rectangle it cannot use, because
 * a proposal screen that dies on the first bad row tells you about one row.
 * Only the line-level impossibilities (no structure, nowhere to file a plate)
 * throw, because there is no proposal to show at all.
 */
export async function planNesting(db, companyId, orderLineId, input = {}) {
  const planStartedAt = Date.now();   // the effort's budget runs from here
  const budgetCut = new Map();         // group key -> the clock limited its search
  const line = await requireLine(db, companyId, orderLineId);
  const { where, cutPlates: needed } = await surveyLine(db, companyId, line);
  const pack = await loadPacker(input.pack);
  const settingRows = await cutSettingRows(db, companyId);
  const plates = await candidatePlates(db, companyId, where.plateIds);
  const theirs = await customerPlates(db, companyId, line.order_id, plates.map((p) => p.id));

  // NEST THE REST. Pieces already on imported lots are not demand any more;
  // what is left is what the packer is asked to place. With nothing imported
  // this is every piece, exactly as before.
  // `replaceImported: true` plans the whole line, as if nothing were imported.
  const imported = input.replaceImported === true ? { lots: [], counts: new Map(), lotNos: new Set() } : await importedLotsOf(db, companyId, orderLineId);
  const cutPlates = needed.map((cp) => ({ ...cp, pieces: Math.max(0, cp.pieces - (imported.counts.get(cp.id) ?? 0)) }));

  const problems = [];
  const manual = [];
  const seedsTried = [];
  const nestable = [];
  for (const cp of cutPlates) {
    if (!cp.pieces) continue;                       // nothing of it is needed, or it is all on imported lots
    if (cp.manual) { manual.push(describeManual(cp)); continue; }
    const gone = missingOnPart(cp.steel);
    if (gone.length) {
      problems.push(`${nameOf(cp)} does not say its ${list(gone.map((g) => g.toLowerCase()))}, so it cannot be nested. A rectangle that does not state its steel is refused rather than guessed at — set the value on the cut plate, or mark it ${NEST_MANUAL_SPEC_CODE} and lay it out by hand.`);
      continue;
    }
    nestable.push(cp);
  }

  const byGroup = new Map();
  for (const cp of nestable) {
    const key = groupKey(cp.steel);
    if (!byGroup.has(key)) {
      byGroup.set(key, { key, thickness: cp.steel.thickness, grade: cp.steel.grade, material: cp.steel.material, cutPlates: [] });
    }
    byGroup.get(key).cutPlates.push(cp);
  }

  const groups = [];
  const sizeAdvice = [];

  /*
   * EVERY GROUP, EVERY SEED, ALL AT ONCE.
   *
   * The steel groups are strictly independent — a 28 mm layout cannot affect a
   * 16 mm one — but they used to be packed one after another, so six groups
   * cost six packs of wall clock on a machine with eight idle cores.
   *
   * So this runs in two passes. The first works out WHAT to pack (database
   * work, this thread). Then every (group x seed) job is dispatched to the
   * worker pool together. The second pass shapes the winners.
   *
   * Measured on the real KEPL line: the seed alone moves the answer ~500 kg,
   * so the best of several seeds is worth having — but only because they cost
   * the wall clock of one. Keeping the best is done by SCORE with the seed as
   * the tie-break, never by which worker finished first.
   */
  const prepared = [];
  for (const g of [...byGroup.values()].sort((a, b) => a.thickness - b.thickness || String(a.key).localeCompare(String(b.key)))) {
    const settings = pickCutSettings(settingRows, g.thickness);
    const guillotine = input.guillotine == null ? settings.guillotine : !!input.guillotine;
    const candidates = sheetsFor(plates, g);
    if (!candidates.length) {
      problems.push(`No catalog plate is ${fmt(g.thickness)} mm ${g.material} ${g.grade}, so ${g.cutPlates.length === 1 ? nameOf(g.cutPlates[0]) : `${g.cutPlates.length} cut plates`} have nothing to be cut from. Add the plate to the catalog, or correct the cut plate's steel.`);
      groups.push(emptyGroup(g, settings, guillotine, 'no candidate plate'));
      continue;
    }

    const pieceArea = g.cutPlates.reduce((a, cp) => a + cp.steel.length * cp.steel.width * cp.pieces, 0);
    const sheets = sortSheets([
      ...candidates.map((p) => ({
        id: p.id, key: `pl${p.id}`, plate: p,
        length: p.steel.length, width: p.steel.width,
        areaCost: p.steel.length * p.steel.width,
        preferred: false,                                  // offcut sourcing is not built yet
        available: Math.min(1000, Math.max(1, Math.ceil(pieceArea / (p.steel.length * p.steel.width)) + 2)),
      })),
      // The customer's own plates of this size: first, free, and only as many as they sent.
      ...candidates.filter((p) => theirs.has(p.id)).map((p) => ({
        id: p.id, key: `pl${p.id}c${theirs.get(p.id).ownerPartyId}`, plate: p,
        length: p.steel.length, width: p.steel.width,
        areaCost: 0, preferred: true, available: theirs.get(p.id).count,
        ownerPartyId: theirs.get(p.id).ownerPartyId,
      })),
    ]);
    const pieces = sortPieces(g.cutPlates.map((cp) => ({
      id: cp.id, key: `cp${cp.id}`, cutPlate: cp,
      length: cp.steel.length, width: cp.steel.width, qty: cp.pieces,
      grain: 'any',                                        // a plate rectangle has no grain to respect
    })));

    // KERF IS CHARGED AT THE RIM as well as between pieces — the raw plate's
    // own edge is cut — so the packer's rim trim IS the kerf, and `margin`
    // equals `kerf` rather than being a second number.
    //
    // THE KERF HANDED IN HERE IS THE ONLY ONE THAT COUNTS. The packer carries
    // its own thickness table as a fallback for callers that pass none; this
    // caller always passes one, resolved from cf_cut_settings, so the shop can
    // change a band without a deploy and the verifier checks the same number
    // the layout was built with. Two constants in two places is the bug.
    //
    // The sequence gap is sent at the BOTTOM of the band: it is legal, it is
    // what the verifier accepts, and it is the least steel.
    // EVERY SEED FOR THIS GROUP AT ONCE, AND THE BEST ONE KEPT. The winner is
    // chosen by steel bought with the seed as the tie-break — never by whichever
    // worker finished first, or the same order would lay out differently twice.
    const packInput = {
      pieces: pieces.map((p) => ({ key: p.key, length: p.length, width: p.width, qty: p.qty, grain: p.grain })),
      sheets: sheets.map((s) => ({ key: s.key, length: s.length, width: s.width, available: s.available, preferred: s.preferred, areaCost: s.areaCost })),
      kerf: settings.kerfMm,
      gap: settings.kerfMm,
      margin: settings.kerfMm,
      thickness: g.thickness,
      sequenceGap: settings.seqGapMinMm,
      smallThreshold: SMALL_PART_MM,
      rowsPerSequence: { small: 2, big: 3 },
      guillotine,
      effort: input.effort ?? 'standard',
      seed: input.seed ?? 1,
      restarts: input.restarts ?? undefined,
      // No per-job budget here: the pool hands each job its share of the PLAN's
      // budget at dispatch time (see packerPool.runAll). An injected packer
      // (the tests) gets the whole plan budget, as before.
      budgetMs: input.pack ? (input.budgetMs ?? null) : null,
    };

    prepared.push({ g, sheets, pieces, settings, guillotine, packInput });
  }

  // ---- pack everything, in parallel ----------------------------------------
  // Effort carries a seed count too: Deep buys insurance against an unlucky
  // draw, Standard does not pay for it.
  const { EFFORT } = await import('./nestingPacker.js');
  const level = EFFORT?.[input.effort ?? 'standard'] ?? EFFORT?.standard;
  const effortSeeds = level?.seeds;
  const seedCount = Math.max(1, Math.trunc(Number(input.seeds ?? effortSeeds ?? DEFAULT_SEEDS)) || 1);
  /*
   * ONE BUDGET FOR THE WHOLE PLAN. `capMs` (or `budgetMs` from the caller) is
   * the wall clock from the moment this plan started, not a per-job allowance
   * — see packerPool.runAll for how it is shared out. A slice is held back
   * for the last in-flight step of each job and for shaping the answer, so the
   * response lands inside the budget rather than just after it.
   */
  const planBudgetMs = Math.max(0, Number(input.budgetMs ?? level?.capMs ?? 0) || 0);
  const reserveMs = Math.min(30_000, Math.round(planBudgetMs * 0.1));
  const deadlineAt = planStartedAt + planBudgetMs - reserveMs;
  const outByGroup = new Map();
  let budget = null;
  if (input.pack) {
    // A caller injected its own packer (the tests do). Run it here, in order.
    for (const pr of prepared) outByGroup.set(pr.g.key, (await pack(pr.packInput)) ?? {});
  } else {
    const jobs = [];
    let seedsDropped = 0;
    for (const pr of prepared) {
      // Seeds worked out ONCE and checked against the real generator: two seeds
      // whose streams start in the same place would do identical work twice.
      const mine = seedsFor(Number(pr.packInput.seed) || 1, seedCount);
      seedsDropped += mine.dropped ?? 0;
      mine.forEach((seed, round) => jobs.push({ key: pr.g.key, seed, round, input: { ...pr.packInput, seed } }));
    }
    const runs = await runAll(jobs, { workers: input.workers ?? null, deadlineAt });
    const st = runs.stats ?? {};
    for (const pr of prepared) {
      const all = runs
        .map((r, i) => ({ ...r, seed: jobs[i].seed, key: jobs[i].key }))
        .filter((r) => r.key === pr.g.key);
      const mine = all.filter((r) => !r.skipped);
      const best = pickBest(mine);
      outByGroup.set(pr.g.key, best?.out ?? {});
      const skippedTime = all.filter((r) => r.skipped === 'time').length;
      const cappedRuns = mine.filter((r) => r.ok && r.out?.deterministic === false).length;
      budgetCut.set(pr.g.key, skippedTime > 0 || cappedRuns > 0);
      if (seedCount > 1) {
        // How many distinct layouts the seeds actually produced. Two seeds landing
        // on the same answer is wasted CPU and worth being able to see.
        const distinct = new Set(mine.filter((r) => r.ok).map((r) => JSON.stringify(
          (r.out?.nests ?? []).map((n) => [n.sheetKey, n.pieces?.length]),
        ))).size;
        seedsTried.push({
          thickness: pr.g.thickness, grade: pr.g.grade,
          tried: mine.length, distinct, dropped: seedsDropped, won: best?.seed ?? null,
          // Added: seeds not run because the plan's clock had no room for them
          // (or the first seed already hit the lower bound), and seeds whose
          // search the clock cut short.
          skipped: skippedTime, skippedProven: all.filter((r) => r.skipped === 'proven').length,
          capped: cappedRuns,
        });
      }
    }
    budget = {
      effort: input.effort ?? 'standard',
      capMs: planBudgetMs,
      workers: st.workers ?? null,
      jobs: st.jobs ?? jobs.length,
      jobsRun: st.run ?? null,
      seedsSkippedForTime: st.skippedTime ?? 0,
      seedsSkippedProven: st.skippedProven ?? 0,
      jobsCapped: st.capped ?? 0,
      // True when the clock, not the effort's own trial count, decided how far
      // the search went: a seed was skipped for time or a search was cut short.
      capped: (st.skippedTime ?? 0) > 0 || (st.capped ?? 0) > 0,
      packMs: Date.now() - planStartedAt,
    };
  }

  // ---- shape the winners ---------------------------------------------------
  for (const { g, sheets, pieces, settings, guillotine } of prepared) {
    const out = outByGroup.get(g.key) ?? {};

    const sheetByKey = new Map(sheets.map((s) => [s.key, s]));
    const pieceByKey = new Map(pieces.map((p) => [p.key, p]));
    const nests = (out.nests ?? []).map((n) => shapeNest(n, sheetByKey, pieceByKey, settings, g));
    const unplaced = (out.unplaced ?? []).map((u) => ({
      cutPlateId: pieceByKey.get(u.key)?.id ?? null,
      cutPlateCode: nameOf(pieceByKey.get(u.key)?.cutPlate ?? {}),
      qty: Number(u.qty) || 0,
      reason: u.reason ?? 'The packer could not place it.',
    }));
    for (const a of out.sizeAdvice ?? []) sizeAdvice.push({ thickness: g.thickness, grade: g.grade, material: g.material, ...a });
    for (const n of nests) {
      if (n.requiredLength > n.length + EPS || n.requiredWidth > n.width + EPS) continue;
      const wantL = orderedSize(n.requiredLength, settings.orderMarginLengthMm, settings.orderStepMm);
      const wantW = orderedSize(n.requiredWidth, settings.orderMarginWidthMm, settings.orderStepMm);
      if (n.length + EPS < wantL || n.width + EPS < wantW) {
        sizeAdvice.push({
          thickness: g.thickness, grade: g.grade, material: g.material, kind: 'ordering margin',
          lotNo: n.lotNo, plateCode: n.plateCode,
          detail: `${n.plateCode} is ${fmt(n.length)} × ${fmt(n.width)}; the layout needs ${fmt(n.requiredLength)} × ${fmt(n.requiredWidth)}, so it is being cut closer to the edge than the shop likes — it wants +${fmt(settings.orderMarginLengthMm)} on length and +${fmt(settings.orderMarginWidthMm)} on width spare, because mill edges are not straight. No size you stock is at least ${fmt(wantL)} × ${fmt(wantW)}, which is what would carry this layout with that margin. This is advice, not a blocker.`,
        });
      }
    }
    groups.push({
      ...groupHead(g, settings, guillotine),
      cutPlates: g.cutPlates.map(describeCutPlate),
      candidates: sheets.map((s) => ({ plateItemId: s.id, code: s.plate.code, name: s.plate.name, length: s.length, width: s.width })),
      nests,
      unplaced,
      metrics: metricsOf(nests, g),
      deterministic: out.deterministic ?? null,
      elapsedMs: out.elapsedMs ?? null,
      budgetCut: budgetCut.get(g.key) ?? false,
    });
  }

  numberLots(groups, imported.lotNos);
  // Waste and offcuts need the lot number (offcut N-003-A), so they are worked
  // out once the numbers are known.
  for (const g of groups) {
    for (const n of g.nests) Object.assign(n, lotWasteFields(n, g));
    g.metrics = metricsOf(g.nests, g);
  }
  const importedPieces = [...imported.counts.values()].reduce((a, b) => a + b, 0);
  return {
    line: lineHead(line),
    saved: false,
    basis: 'proposal',
    // What "nest the rest" left alone: the imported nests stay as they are.
    imported: { lots: imported.lots.length, pieces: importedPieces },
    settingsNote: 'Kerf is banded by plate thickness and charged at the plate rim as well as between pieces; two parts sharing a boundary are one kerf apart, not two.',
    groups,
    manual,
    sizeAdvice,
    problems,
    // Which seeds were tried and which won, so a plan can say how it was reached
    // and a better one can be got back by asking for that seed again.
    seeds: seedsTried,
    // How the effort's time budget was spent across the plan; `capped` says the
    // clock cut the search. Null when an injected packer ran the plan.
    budget: budget ? { ...budget, elapsedMs: Date.now() - planStartedAt } : null,
    totals: totalsOf(groups),
  };
}

/**
 * The per-nest fields the contract adds, for a lot the packer proposed. It
 * fits by construction, so there is no verdict and nothing was forced.
 */
function lotWasteFields(n, g) {
  const w = wasteOfLot({
    lotNo: n.lotNo, length: n.length, width: n.width, thickness: n.thickness, density: n.density,
    kerfMm: g.kerfMm, seqGapMinMm: g.seqGapMinMm,
    offcutMinAreaMm2: g.offcutMinAreaMm2, offcutMinSideMm: g.offcutMinSideMm,
  }, n.pieces);
  return {
    origin: 'auto', verdict: null, forced: false, reasons: [],
    hasLayout: w.hasLayout, waste: w.waste, wasteKg: w.wasteKg, partsKg: w.partsKg, offcuts: w.offcuts,
  };
}

const lineHead = (line) => ({
  id: line.id, lineNo: line.line_no, orderId: line.order_id, orderCode: line.order_code,
  quantity: Number(line.quantity), orderStatus: line.order_status,
});

const groupHead = (g, settings, guillotine) => ({
  key: g.key, thickness: g.thickness, grade: g.grade, material: g.material,
  kerfMm: settings.kerfMm, seqGapMinMm: settings.seqGapMinMm, seqGapMaxMm: settings.seqGapMaxMm,
  orderMarginLengthMm: settings.orderMarginLengthMm, orderMarginWidthMm: settings.orderMarginWidthMm,
  offcutMinAreaMm2: settings.offcutMinAreaMm2, offcutMinSideMm: settings.offcutMinSideMm,
  guillotine, settingsBasis: settings.basis,
});

const emptyGroup = (g, settings, guillotine, why) => ({
  ...groupHead(g, settings, guillotine),
  cutPlates: g.cutPlates.map(describeCutPlate),
  candidates: [],
  nests: [],
  unplaced: g.cutPlates.map((cp) => ({ cutPlateId: cp.id, cutPlateCode: nameOf(cp), qty: cp.pieces, reason: why })),
  metrics: metricsOf([], g),
  deterministic: null,
  elapsedMs: null,
});

const describeCutPlate = (cp) => ({
  id: cp.id, code: cp.code, name: cp.name, pieces: cp.pieces,
  length: cp.steel.length, width: cp.steel.width, thickness: cp.steel.thickness,
  grade: cp.steel.grade, material: cp.steel.material,
});

const describeManual = (cp) => ({
  ...describeCutPlate(cp),
  reason: `${NEST_MANUAL_SPEC_CODE} is set on it, so the packer leaves it alone — lay it out by hand on the screen or in the sheet.`,
});

/**
 * One returned nest becomes one LOT. The plate count of a nest is 1: it IS one
 * plate. Sequence, row and position are taken from the packer where it gives
 * them and derived from the geometry where it does not, then re-derived in one
 * place here so the numbering is dense, 1-based and unique within its row
 * whatever the packer hands back.
 */
function shapeNest(n, sheetByKey, pieceByKey, settings, g) {
  const sheet = sheetByKey.get(n.sheetKey);
  const raw = (n.pieces ?? []).map((p) => {
    const src = pieceByKey.get(p.key);
    const rotated = !!p.rotated;
    return {
      cutPlateId: src?.id ?? null,
      cutPlateCode: nameOf(src?.cutPlate ?? {}),
      seqNo: Math.max(1, Math.round(num(p.seqNo ?? p.seq ?? p.sequence ?? p.sequenceNo) ?? 1)),
      rowNo: Math.max(1, Math.round(num(p.rowNo ?? p.row ?? p.rowIndex) ?? 1)),
      x: round3(num(p.x) ?? 0),
      y: round3(num(p.y) ?? 0),
      length: round3(num(p.length) ?? (rotated ? src?.width : src?.length) ?? 0),
      width: round3(num(p.width) ?? (rotated ? src?.length : src?.width) ?? 0),
      rotated,
    };
  });
  const pieces = numberWithinRows(raw);
  const usedArea = pieces.reduce((a, p) => a + p.length * p.width, 0);
  const length = sheet?.length ?? Number(n.sheetLength) ?? 0;
  const width = sheet?.width ?? Number(n.sheetWidth) ?? 0;
  const density = sheet?.plate?.steel?.density ?? null;
  return {
    lotNo: null,                                   // assigned across the whole line, below
    plateItemId: sheet?.id ?? null,
    plateCode: sheet?.plate?.code ?? n.sheetKey,
    plateName: sheet?.plate?.name ?? null,
    // A customer's plate is a catalog plate that is theirs, not an offcut.
    source: sheet?.ownerPartyId ? 'catalog' : (n.preferred ? 'offcut' : 'catalog'),
    ownerPartyId: sheet?.ownerPartyId ?? null,
    thickness: g.thickness, grade: g.grade, material: g.material, density,
    length, width,
    ...requiredSize(pieces, settings.kerfMm),
    sheetArea: round3(length * width),
    usedArea: round3(usedArea),
    wasteArea: round3(length * width - usedArea),
    wastePct: length * width > 0 ? round3(((length * width - usedArea) / (length * width)) * 100) : 0,
    weightKg: kgOf(length * width, g.thickness, density),
    wasteTotalKg: kgOf(length * width - usedArea, g.thickness, density),
    sequences: sequenceSummary(pieces),
    pieces,
  };
}

/**
 * Position along a row is derived rather than trusted: sorting by (sequence,
 * row, x, y) and numbering 1..n makes it dense and unique whatever a packer or
 * a person's spreadsheet supplies, which is what the unique key needs.
 */
function numberWithinRows(pieces) {
  const sorted = pieces.slice().sort((a, b) => a.seqNo - b.seqNo || a.rowNo - b.rowNo || a.x - b.x || a.y - b.y || (a.cutPlateId ?? 0) - (b.cutPlateId ?? 0));
  const seen = new Map();
  for (const p of sorted) {
    const k = `${p.seqNo}|${p.rowNo}`;
    const next = (seen.get(k) ?? 0) + 1;
    seen.set(k, next);
    p.posNo = next;
  }
  return sorted;
}

/** What each sequence holds, and how many rows it is allowed — Small 2, Big 3. */
function sequenceSummary(pieces) {
  const by = new Map();
  for (const p of pieces) {
    if (!by.has(p.seqNo)) by.set(p.seqNo, []);
    by.get(p.seqNo).push(p);
  }
  return [...by.entries()].sort((a, b) => a[0] - b[0]).map(([seqNo, ps]) => ({
    seqNo,
    rows: new Set(ps.map((p) => p.rowNo)).size,
    rowsAllowed: rowsPerSequence(ps),
    pieces: ps.length,
    size: ps.every((p) => isSmallPart(p.length, p.width)) ? 'small' : 'big',
  }));
}

/**
 * What the layout actually needs, as opposed to what is ordered: the pieces'
 * bounding box plus one kerf at each rim, because the raw plate's own edge is
 * cut too. The ordering margin (+100 length, +50 width) is deliberately NOT
 * added here — it belongs to procurement, not to the layout, and adding it
 * would make every plate look more wasteful than it is.
 */
function requiredSize(pieces, kerfMm) {
  if (!pieces.length) return { requiredLength: round3(2 * kerfMm), requiredWidth: round3(2 * kerfMm) };
  const maxX = Math.max(...pieces.map((p) => p.x + p.length));
  const maxY = Math.max(...pieces.map((p) => p.y + p.width));
  return { requiredLength: round3(maxX + kerfMm), requiredWidth: round3(maxY + kerfMm) };
}

/** COUNT LOTS FOR PLATES, SUM PLACEMENTS FOR PIECES. Said in the schema, meant here. */
function metricsOf(nests, g) {
  const lots = nests.length;
  const pieces = nests.reduce((a, n) => a + n.pieces.length, 0);
  const areaBought = nests.reduce((a, n) => a + n.sheetArea, 0);
  const usedArea = nests.reduce((a, n) => a + n.usedArea, 0);
  const weightKg = nests.reduce((a, n) => a + n.weightKg, 0);
  const wasteTotalKg = nests.reduce((a, n) => a + Number(n.wasteTotalKg ?? 0), 0);
  const { waste, wasteKg } = sumWaste(nests);
  return {
    lots, plates: lots, pieces,
    areaBought: round3(areaBought), usedArea: round3(usedArea),
    wasteArea: round3(areaBought - usedArea),
    wastePct: areaBought > 0 ? round3(((areaBought - usedArea) / areaBought) * 100) : 0,
    weightKg: round3(weightKg),
    // THE CONTRACT (2026-09-29) makes `wasteKg` the split by cause, an object
    // like `waste` (mm²). The single number it used to be — plate less parts —
    // is `wasteTotalKg`.
    wasteTotalKg: round3(wasteTotalKg),
    waste,
    wasteKg,
    partsKg: round3(nests.reduce((a, n) => a + Number(n.partsKg ?? 0), 0)),
    offcutCount: nests.reduce((a, n) => a + (n.offcuts?.length ?? 0), 0),
    thickness: g?.thickness ?? null,
  };
}

const totalsOf = (groups) => {
  const flat = groups.flatMap((g) => g.nests);
  return { ...metricsOf(flat, null), groups: groups.length, unplaced: groups.reduce((a, g) => a + g.unplaced.length, 0) };
};

/**
 * N-001 upwards across the whole line, in group order then nest order, so it is
 * stable — skipping any number an imported lot already wears, so a proposal's
 * numbers are the ones accept will write.
 */
function numberLots(groups, taken = new Set()) {
  const all = groups.flatMap((g) => g.nests);
  const nos = autoLotNumbers(all.length, taken);
  all.forEach((nest, i) => { nest.lotNo = nos[i]; });
}

/* ---------------------------------------------------------------------------
 * acceptNesting — verifies the recorded geometry, then writes
 * ------------------------------------------------------------------------ */

/**
 * plan: whatever planNesting returned, possibly edited — `groups[].nests[]`, or
 * a flat `nests[]`. Only three things are read off it: which plate each lot is,
 * and where each piece sits. EVERY OTHER FACT COMES BACK OUT OF THE DATABASE:
 * the cut plates, their sizes, how many of each the line needs, which are held
 * back by hand, the plate sizes, and the cutting settings.
 *
 * What it checks is the geometry AS RECORDED — that these rectangles, at these
 * positions, on this plate, are legal. It does NOT re-pack the sheet and
 * compare: fab did that and refused about a quarter of its own plans.
 *
 * Every problem is collected and thrown together (assertNoProblems, the house
 * pattern), because a person fixing a layout one refusal at a time will stop.
 */
export async function acceptNesting(db, c, orderLineId, plan = {}) {
  const companyId = c.companyId;
  const line = await requireLine(db, companyId, orderLineId, { lock: true });
  assertOpen(line);
  const { where, cutPlates } = await surveyLine(db, companyId, line);
  const settingRows = await cutSettingRows(db, companyId);
  const plates = await candidatePlates(db, companyId, where.plateIds);
  const plateById = new Map(plates.map((p) => [p.id, p]));
  const cpById = new Map(cutPlates.map((cp) => [cp.id, cp]));
  const theirs = await customerPlates(db, companyId, line.order_id, plates.map((p) => p.id));
  const theirsUsed = new Map();

  // NEST THE REST: the imported lots stay, and what they hold is not asked of
  // this plan. Read from the DB, like everything else here.
  // `replaceImported: true` is the way back to fully automatic nesting: every
  // lot goes, imported ones too, and the plan must cover the whole line.
  const replaceImported = plan?.replaceImported === true;
  const imported = replaceImported ? { lots: [], counts: new Map(), lotNos: new Set() } : await importedLotsOf(db, companyId, orderLineId);

  const problems = [];

  // What the line actually needs from AUTOMATIC nesting, and what it is
  // holding back by hand.
  const required = new Map();
  for (const cp of cutPlates) {
    if (!cp.pieces || cp.manual) continue;
    const left = cp.pieces - (imported.counts.get(cp.id) ?? 0);
    if (left <= 0) continue;                        // all of it is on imported nests
    if (missingOnPart(cp.steel).length) {
      problems.push(`${nameOf(cp)} does not say its ${list(missingOnPart(cp.steel).map((g) => g.toLowerCase()))}, so a layout naming it cannot be accepted. Set the value, or mark it ${NEST_MANUAL_SPEC_CODE}.`);
      continue;
    }
    required.set(cp.id, left);
  }

  // An empty plan is fine when there is nothing left to nest — the imported
  // nests already hold it all, and accepting just clears old automatic lots.
  const submitted = flattenNests(plan, required.size ? problems : []);

  const lots = [];
  const placed = new Map();
  for (const [i, n] of submitted.entries()) {
    const label = `Lot ${n.lotNo ?? i + 1}`;
    const plate = plateById.get(Number(n.plateItemId));
    if (!plate) {
      problems.push(`${label}: ${n.plateItemId == null ? 'no plate is named' : `plate ${n.plateItemId} is not an active catalog plate in this company`}. A lot is one physical plate, so it has to name a real one.`);
      continue;
    }
    if (!(plate.steel.length > 0 && plate.steel.width > 0 && plate.steel.thickness > 0)) {
      problems.push(`${label}: ${nameOf(plate)} has no thickness, length and width in the catalog, so nothing can be checked against it.`);
      continue;
    }
    const settings = pickCutSettings(settingRows, plate.steel.thickness);
    // A lot on the customer's own plate: only their order's customer, and no
    // more of them than they have free (init.sql §35).
    let ownerPartyId = null;
    if (n.ownerPartyId != null && n.ownerPartyId !== '') {
      const t = theirs.get(plate.id);
      const used = (theirsUsed.get(plate.id) ?? 0) + 1;
      theirsUsed.set(plate.id, used);
      if (!t || Number(t.ownerPartyId) !== Number(n.ownerPartyId)) problems.push(`${label}: it is marked as the customer's plate, but this order's customer has no free ${nameOf(plate)} — a plate that is not theirs, or another customer's, is never used for this order.`);
      else if (used > t.count) problems.push(`${label}: the customer has only ${t.count} free ${nameOf(plate)} — this is plate ${used} of theirs.`);
      else ownerPartyId = t.ownerPartyId;
    }
    const lot = {
      lotNo: n.lotNo ?? `N-${String(i + 1).padStart(3, '0')}`,
      plate,
      ownerPartyId,
      source: n.source === 'offcut' ? 'offcut' : 'catalog',
      isManual: !!n.isManual,
      settings,
      pieces: [],
    };
    verifyLot(lot, n, { label, cpById, required, placed, problems, importedCounts: imported.counts });
    lots.push(lot);
  }

  // Every rectangle the line needs has to be somewhere. A half-nested blank has
  // no honest plate count, so a short plan is refused rather than half-written;
  // NEST_MANUAL is the way to hold a rectangle back on purpose.
  for (const [cpId, want] of required) {
    const got = placed.get(cpId) ?? 0;
    if (got === want) continue;
    const cp = cpById.get(cpId);
    const onImported = imported.counts.get(cpId) ?? 0;
    const also = onImported ? ` (another ${onImported} ${onImported === 1 ? 'is' : 'are'} on imported nests)` : '';
    problems.push(got < want
      ? `${nameOf(cp)}: the line needs ${want} ${want === 1 ? 'piece' : 'pieces'}${also} and the layout places ${got}. Place the rest, or mark it ${NEST_MANUAL_SPEC_CODE} to lay it out by hand.`
      : `${nameOf(cp)}: the layout places ${got} pieces and the line needs only ${want}${also}. Take the extra ${got - want} off a plate.`);
  }

  assertNoProblems(problems, 'That layout cannot be accepted.');

  // ---- from here it only writes -------------------------------------------
  const replaced = await clearLots(db, c, orderLineId, replaceImported ? {} : { origin: 'auto' });
  const numbers = autoLotNumbers(lots.length, imported.lotNos);
  const toWrite = lots.map((lot, i) => {
    const lotNo = numbers[i];
    const pieces = numberWithinRows(lot.pieces);
    const req = requiredSize(pieces, lot.settings.kerfMm);
    // THE LOT'S STEEL IS THE RECTANGLES', NOT THE PLATE ROW'S. A catalog plate
    // with a blank grade is tolerated as a candidate on purpose — it is a
    // data-entry gap, not a claim — and verification has just proved the plate
    // does not contradict the pieces. Recording the plate's blank instead would
    // file this lot under a steel of its own, and the saved plan would read
    // back as two groups where one was proposed.
    const steel = pieces[0]?.cutPlate?.steel ?? {};
    const density = lot.plate.steel.density ?? steel.density;
    const w = wasteOfLot({
      lotNo, length: lot.plate.steel.length, width: lot.plate.steel.width,
      thickness: lot.plate.steel.thickness, density,
      kerfMm: lot.settings.kerfMm, seqGapMinMm: lot.settings.seqGapMinMm,
      offcutMinAreaMm2: lot.settings.offcutMinAreaMm2, offcutMinSideMm: lot.settings.offcutMinSideMm,
    }, pieces);
    return {
      lotNo, plate: lot.plate, source: lot.source, isManual: lot.isManual, settings: lot.settings, ownerPartyId: lot.ownerPartyId,
      grade: steel.grade ?? lot.plate.steel.grade,
      material: steel.material ?? lot.plate.steel.material,
      density,
      requiredLength: req.requiredLength, requiredWidth: req.requiredWidth,
      origin: 'auto', verdict: null, reasons: null, forced: false, notes: null,
      waste: w,
      pieces,
    };
  });
  const written = await writeLots(db, c, orderLineId, toWrite);

  // The plate quantity on each cut plate's BOM line is charged over EVERY lot
  // it sits on — the imported ones kept, and the automatic ones just written —
  // against every piece the line needs of it.
  const blanks = new Map(cutPlates.filter((cp) => cp.pieces).map((cp) => [cp.id, cp.pieces]));
  const quantities = await replaceAreaFractions(db, c, where, [...imported.lots, ...toWrite], blanks);
  return {
    line: lineHead(line),
    replacedLots: replaced,
    keptImportedLots: imported.lots.length,
    lots: written.length,
    plates: written.length,                          // a lot IS a plate; never sum placements for this
    pieces: written.reduce((a, l) => a + l.pieces, 0),
    offcuts: written.reduce((a, l) => a + l.offcuts, 0),
    quantities,
    caveatCleared: 'The plate quantity on each cut plate is now the nesting plan, not the area fraction.',
  };
}

/**
 * Writes lots, their placements and their offcuts in a FIXED number of round
 * trips whatever the size (TiDB is ~49 ms each): one multi-row INSERT for the
 * lots, one SELECT to read their ids back by lot number (AUTO_INCREMENT is not
 * contiguous on TiDB), then the placements and the offcuts in chunks.
 *
 * Each lot: { lotNo, plate {id, steel}, source, isManual, settings, grade,
 * material, density, requiredLength, requiredWidth, origin, verdict, reasons,
 * forced, notes, waste (wasteOfLot), pieces [{ cutPlateId, seqNo, rowNo,
 * posNo, x, y, length, width, rotated }] }. x/y may be NULL: on the plate, no
 * layout. Returns [{ id, lotNo, pieces, offcuts }].
 */
async function writeLots(db, c, orderLineId, lots) {
  if (!lots.length) return [];
  const companyId = c.companyId;
  const user = c.userId ?? null;
  const json = (v) => (v == null ? null : JSON.stringify(v));
  await insertRows(db, 'cf_plate_lots', [
    'company_id', 'order_line_id', 'plate_item_id', 'lot_no', 'source', 'thickness_mm', 'length_mm', 'width_mm',
    'required_length_mm', 'required_width_mm', 'grade', 'material', 'density',
    'kerf_mm', 'seq_gap_min_mm', 'seq_gap_max_mm', 'guillotine', 'is_manual',
    'origin', 'check_verdict', 'check_json', 'forced', 'waste_json', 'notes', 'owner_party_id', 'created_by',
  ], lots.map((l) => [
    companyId, orderLineId, l.plate.id, l.lotNo, l.source ?? 'catalog',
    l.plate.steel.thickness, l.plate.steel.length, l.plate.steel.width,
    l.requiredLength ?? null, l.requiredWidth ?? null, l.grade ?? null, l.material ?? null, l.density ?? null,
    l.settings.kerfMm, l.settings.seqGapMinMm, l.settings.seqGapMaxMm, l.settings.guillotine ? 1 : 0, l.isManual ? 1 : 0,
    l.origin ?? 'auto', l.verdict ?? null, json(l.reasons), l.forced ? 1 : 0, json(l.waste?.json), l.notes ?? null, l.ownerPartyId ?? null, user,
  ]), 500);

  const [idRows] = await db.query(
    'SELECT id, lot_no FROM cf_plate_lots WHERE company_id = ? AND order_line_id = ? AND deleted_at IS NULL AND lot_no IN (?)',
    [companyId, orderLineId, lots.map((l) => l.lotNo)],
  );
  const idByNo = new Map(idRows.map((r) => [String(r.lot_no).toUpperCase(), r.id]));

  const placements = [];
  const offcuts = [];
  const out = [];
  for (const l of lots) {
    const lotId = idByNo.get(String(l.lotNo).toUpperCase());
    for (const p of l.pieces) {
      placements.push([
        companyId, lotId, p.cutPlateId, p.seqNo, p.rowNo, p.posNo,
        p.x == null ? null : p.x, p.y == null ? null : p.y, p.length, p.width, p.rotated ? 1 : 0, user,
      ]);
    }
    for (const o of l.waste?.offcuts ?? []) {
      offcuts.push([
        companyId, orderLineId, lotId, o.offcutNo, l.plate.steel.thickness, l.grade ?? null, l.material ?? null,
        l.density ?? null, o.area, o.weightKg,
        o.bbox?.x ?? null, o.bbox?.y ?? null, o.bbox?.length ?? null, o.bbox?.width ?? null,
        o.rect?.x ?? null, o.rect?.y ?? null, o.rect?.length ?? null, o.rect?.width ?? null,
        JSON.stringify(o.outline ?? []), l.ownerPartyId ?? null, user,   // an offcut is whoever's plate it was cut from
      ]);
    }
    out.push({ id: lotId, lotNo: l.lotNo, plateItemId: l.plate.id, pieces: l.pieces.length, offcuts: l.waste?.offcuts?.length ?? 0 });
  }
  await insertRows(db, 'cf_nest_placements', [
    'company_id', 'plate_lot_id', 'cut_plate_id', 'seq_no', 'row_no', 'pos_no',
    'x_mm', 'y_mm', 'length_mm', 'width_mm', 'rotated', 'created_by',
  ], placements, 1000);
  await insertRows(db, 'cf_offcuts', [
    'company_id', 'order_line_id', 'plate_lot_id', 'offcut_no', 'thickness_mm', 'grade', 'material',
    'density', 'area_mm2', 'weight_kg',
    'bbox_x_mm', 'bbox_y_mm', 'bbox_length_mm', 'bbox_width_mm',
    'rect_x_mm', 'rect_y_mm', 'rect_length_mm', 'rect_width_mm',
    'outline_json', 'owner_party_id', 'created_by',
  ], offcuts, 200);
  return out;
}

/** `groups[].nests[]`, or a flat `nests[]`. Anything else is said plainly. */
function flattenNests(plan, problems) {
  const out = [];
  if (Array.isArray(plan?.groups)) for (const g of plan.groups) for (const n of g?.nests ?? []) out.push(n);
  if (Array.isArray(plan?.nests)) for (const n of plan.nests) out.push(n);
  if (!out.length) problems.push('That plan has no plates in it — there is nothing to accept. Propose a layout first, or upload a sheet with rows on it.');
  return out;
}

/**
 * One lot's geometry, checked against what the database says the plate and the
 * rectangles are. Every failure is pushed, none thrown, so the caller can show
 * them all at once.
 */
function verifyLot(lot, n, { label, cpById, required, placed, problems, importedCounts = new Map() }) {
  const { plate, settings } = lot;
  const k = settings.kerfMm;
  const raw = Array.isArray(n.pieces) ? n.pieces : [];
  if (!raw.length) { problems.push(`${label}: it has no pieces on it. An empty plate is not a nest — take it out of the plan.`); return; }

  const pieces = [];
  for (const [j, p] of raw.entries()) {
    const at = `${label}, piece ${j + 1}`;
    const cp = cpById.get(Number(p.cutPlateId));
    if (!cp) { problems.push(`${at}: ${p.cutPlateId == null ? 'no cut plate is named' : `cut plate ${p.cutPlateId} is not one of this line's`}.`); continue; }
    // NEST_MANUAL means "leave it out of AUTOMATIC nesting" (2026-09-29): it
    // may sit on an imported nest, never on a packed one.
    if (cp.manual) { problems.push(`${at}: ${nameOf(cp)} is marked ${NEST_MANUAL_SPEC_CODE}, so it is left out of automatic nesting and cannot be on a packed plate. Put it on an imported nest, or clear the flag to nest it.`); continue; }
    if (!required.has(cp.id)) {
      problems.push(importedCounts.get(cp.id)
        ? `${at}: every piece of ${nameOf(cp)} the line needs is already on imported nests, so there is none left for this plate.`
        : `${at}: ${nameOf(cp)} is not a rectangle this line needs.`);
      continue;
    }

    // The steel has to agree on all three axes. An unknown on the PLATE is
    // tolerated (a catalog gap); an unknown on the PART was refused already.
    if (Math.abs(cp.steel.thickness - plate.steel.thickness) > EPS) {
      problems.push(`${at}: ${nameOf(cp)} is ${fmt(cp.steel.thickness)} mm and ${nameOf(plate)} is ${fmt(plate.steel.thickness)} mm.`);
    }
    if (!agrees(plate.steel.grade, cp.steel.grade)) problems.push(`${at}: ${nameOf(cp)} is ${cp.steel.grade} and ${nameOf(plate)} is ${plate.steel.grade}. Grade is not something a layout may mix.`);
    if (!agrees(plate.steel.material, cp.steel.material)) problems.push(`${at}: ${nameOf(cp)} is ${cp.steel.material} and ${nameOf(plate)} is ${plate.steel.material}.`);

    const rotated = !!p.rotated;
    const length = round3(num(p.length) ?? (rotated ? cp.steel.width : cp.steel.length));
    const width = round3(num(p.width) ?? (rotated ? cp.steel.length : cp.steel.width));
    const wantL = rotated ? cp.steel.width : cp.steel.length;
    const wantW = rotated ? cp.steel.length : cp.steel.width;
    if (Math.abs(length - wantL) > EPS || Math.abs(width - wantW) > EPS) {
      problems.push(`${at}: it is drawn ${fmt(length)} × ${fmt(width)} but ${nameOf(cp)} is ${fmt(cp.steel.length)} × ${fmt(cp.steel.width)}${rotated ? ' (rotated)' : ''}. A placement is the rectangle itself, not a resize of it.`);
      continue;
    }

    const x = round3(num(p.x) ?? 0);
    const y = round3(num(p.y) ?? 0);
    // Kerf is charged AT THE RIM as well as between pieces, because the raw
    // plate's own edge is cut. So the usable box is the plate less one kerf all
    // round — not less two, and not the full plate.
    if (x < k - EPS || y < k - EPS || x + length > plate.steel.length - k + EPS || y + width > plate.steel.width - k + EPS) {
      problems.push(`${at}: ${nameOf(cp)} at (${fmt(x)}, ${fmt(y)}) runs past ${nameOf(plate)}. The plate is ${fmt(plate.steel.length)} × ${fmt(plate.steel.width)} and one kerf of ${fmt(k)} mm is cut off each edge, so a piece has to sit inside ${fmt(k)}…${fmt(plate.steel.length - k)} by ${fmt(k)}…${fmt(plate.steel.width - k)}.`);
      continue;
    }

    pieces.push({
      cutPlateId: cp.id, cutPlateCode: nameOf(cp), cutPlate: cp,
      seqNo: Math.max(1, Math.round(num(p.seqNo ?? p.seq) ?? 1)),
      rowNo: Math.max(1, Math.round(num(p.rowNo ?? p.row) ?? 1)),
      x, y, length, width, rotated,
    });
    placed.set(cp.id, (placed.get(cp.id) ?? 0) + 1);
  }

  // Two pieces either share a boundary — exactly one kerf apart, cut once — or
  // stand apart. Either way they are at least one kerf apart on one axis, and
  // they never overlap.
  for (let a = 0; a < pieces.length; a++) {
    for (let b = a + 1; b < pieces.length; b++) {
      const p = pieces[a];
      const q = pieces[b];
      const sepX = Math.max(q.x - (p.x + p.length), p.x - (q.x + q.length));
      const sepY = Math.max(q.y - (p.y + p.width), p.y - (q.y + q.width));
      if (Math.max(sepX, sepY) < k - EPS) {
        problems.push(Math.max(sepX, sepY) < -EPS
          ? `${label}: ${p.cutPlateCode} at (${fmt(p.x)}, ${fmt(p.y)}) and ${q.cutPlateCode} at (${fmt(q.x)}, ${fmt(q.y)}) overlap.`
          : `${label}: ${p.cutPlateCode} at (${fmt(p.x)}, ${fmt(p.y)}) and ${q.cutPlateCode} at (${fmt(q.x)}, ${fmt(q.y)}) are closer than the ${fmt(k)} mm kerf. Two parts may share a boundary — one kerf, cut once — but they cannot be nearer than that.`);
      }
    }
  }

  // Plate -> Sequence -> Row -> Part. A sequence of Small parts holds 2 rows,
  // one with anything Big holds 3, and sequences are cut whole and in order, so
  // they may not interleave on the plate.
  const bySeq = new Map();
  for (const p of pieces) {
    if (!bySeq.has(p.seqNo)) bySeq.set(p.seqNo, []);
    bySeq.get(p.seqNo).push(p);
  }
  const boxes = [];
  for (const [seqNo, ps] of [...bySeq.entries()].sort((a, b) => a[0] - b[0])) {
    const allowed = rowsPerSequence(ps);
    const rows = [...new Set(ps.map((p) => p.rowNo))].sort((a, b) => a - b);
    if (rows.length > allowed || rows[rows.length - 1] > allowed) {
      problems.push(`${label}, sequence ${seqNo}: it uses ${rows.length > allowed ? `${rows.length} rows` : `row ${rows[rows.length - 1]}`} and a ${allowed === 2 ? 'Small' : 'Big'} sequence holds ${allowed}. Rows per sequence come from part size on both dimensions — under ${SMALL_PART_MM} mm each way is Small and holds 2, anything larger holds 3.`);
    }
    boxes.push({
      seqNo,
      x0: Math.min(...ps.map((p) => p.x)), x1: Math.max(...ps.map((p) => p.x + p.length)),
      y0: Math.min(...ps.map((p) => p.y)), y1: Math.max(...ps.map((p) => p.y + p.width)),
    });
  }
  for (let a = 0; a < boxes.length; a++) {
    for (let b = a + 1; b < boxes.length; b++) {
      const p = boxes[a];
      const q = boxes[b];
      const sepX = Math.max(q.x0 - p.x1, p.x0 - q.x1);
      const sepY = Math.max(q.y0 - p.y1, p.y0 - q.y1);
      const sep = Math.max(sepX, sepY);
      if (sep < settings.seqGapMinMm - EPS) {
        problems.push(sep < -EPS
          ? `${label}: sequences ${p.seqNo} and ${q.seqNo} overlap on the plate. A sequence is cut whole and in order, so two of them cannot share ground.`
          : `${label}: sequences ${p.seqNo} and ${q.seqNo} are ${fmt(sep)} mm apart and the gap between sequences is ${fmt(settings.seqGapMinMm)}–${fmt(settings.seqGapMaxMm)} mm.`);
      }
    }
  }
  lot.pieces = pieces;
}

/**
 * Soft-deletes the line's lots, their placements and their offcuts — every lot,
 * or only those of one origin ("nest the rest" clears only 'auto'). Accepting
 * twice is not double steel. Four round trips at most, whatever the size.
 */
async function clearLots(db, c, orderLineId, { origin = null } = {}) {
  const [rows] = await db.query(
    `SELECT id FROM cf_plate_lots WHERE company_id = ? AND order_line_id = ? AND deleted_at IS NULL${origin ? ' AND origin = ?' : ''}`,
    origin ? [c.companyId, orderLineId, origin] : [c.companyId, orderLineId],
  );
  if (!rows.length) return 0;
  const ids = rows.map((r) => r.id);
  await db.query('UPDATE cf_nest_placements SET deleted_at = NOW() WHERE company_id = ? AND plate_lot_id IN (?) AND deleted_at IS NULL', [c.companyId, ids]);
  await db.query('UPDATE cf_offcuts SET deleted_at = NOW() WHERE company_id = ? AND plate_lot_id IN (?) AND deleted_at IS NULL', [c.companyId, ids]);
  await db.query('UPDATE cf_plate_lots SET deleted_at = NOW() WHERE company_id = ? AND id IN (?)', [c.companyId, ids]);
  return ids.length;
}

/* ---------------------------------------------------------------------------
 * Replacing the area fraction with the real plate count
 * ------------------------------------------------------------------------ */

/**
 * A cut plate's BOM has one line to its raw plate, and cutPlateService writes
 * the AREA FRACTION on it — the blank's area over the plate's, which ignores
 * kerf, the layout and the offcut. This is what replaces it.
 *
 *   share of a cut plate on a lot   its placed area over all placed area there
 *   area it is charged              that share of the WHOLE plate, waste and all
 *   quantity on the BOM line        that area, in plates, per blank
 *
 * WHEN EVERY LOT A CUT PLATE SITS ON IS THE SAME CATALOG PLATE — which is the
 * ordinary case — this is exactly (lots it used) / (blanks it makes), i.e. THE
 * REAL PLATE COUNT, and the shares across all the cut plates on a lot add up to
 * that one plate. Nothing is double counted and nothing is lost. When a cut
 * plate spills onto a second, different plate size, the sum is the same area
 * expressed in the plate the line names, and `spread` says so rather than
 * pretending otherwise.
 *
 * The line is repointed when the nest chose a different plate from the one it
 * named: the person accepted this layout, and a quantity counted against a
 * plate the layout does not use would be a worse lie than the fraction was.
 */
async function replaceAreaFractions(db, c, where, lots, required, { restore = null } = {}) {
  const charge = new Map();                        // cutPlateId -> Map(plateItemId -> area)
  const plateOf = new Map();                       // plateItemId -> plate
  // A piece is { length, width } (one piece) or { area } (an imported lot's
  // pieces of one cut plate, aggregated) — the arithmetic only needs area.
  const areaOf = (p) => (p.area != null ? Number(p.area) : Number(p.length) * Number(p.width));
  for (const lot of lots) {
    const total = lot.pieces.reduce((a, p) => a + areaOf(p), 0);
    if (!(total > 0)) continue;
    plateOf.set(lot.plate.id, lot.plate);
    const sheetArea = lot.plate.steel.length * lot.plate.steel.width;
    for (const p of lot.pieces) {
      if (!charge.has(p.cutPlateId)) charge.set(p.cutPlateId, new Map());
      const byPlate = charge.get(p.cutPlateId);
      const add = (areaOf(p) / total) * sheetArea;
      byPlate.set(lot.plate.id, (byPlate.get(lot.plate.id) ?? 0) + add);
    }
  }

  // Cut plates on NO lot any more (an import that covers only part of the
  // line) go back to their area fraction against the plate their line names,
  // rather than keeping a plate count from a layout that no longer exists.
  const back = restore
    ? restore.cutPlates.filter((cp) => cp.pieces && !charge.has(cp.id) && cp.steel?.length > 0 && cp.steel?.width > 0)
    : [];

  const lines = await plateLinesOf(db, c.companyId, [...charge.keys(), ...back.map((cp) => cp.id)], where);
  const out = [];
  const updates = [];                              // [bomLineId, childId, quantity]
  for (const [cutPlateId, byPlate] of charge) {
    const blanks = required.get(cutPlateId) ?? 0;
    const link = lines.get(cutPlateId);
    const ranked = [...byPlate.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
    const [plateItemId] = ranked[0];
    const plate = plateOf.get(plateItemId);
    const area = [...byPlate.values()].reduce((a, b) => a + b, 0);
    const quantity = blanks > 0 ? round6(area / (plate.steel.length * plate.steel.width) / blanks) : 0;
    const entry = {
      cutPlateId, plateItemId, plateCode: plate.code, blanks, quantity,
      basis: 'nesting plan', spread: ranked.length > 1 ? ranked.length : null,
      note: ranked.length > 1
        ? `This rectangle is cut from ${ranked.length} different plate sizes. The quantity is the steel it is charged, expressed in ${plate.code}; cf_plate_lots holds which plates they actually are.`
        : null,
    };
    if (!link) {
      entry.applied = false;
      entry.note = `${nameOf({ id: cutPlateId })} has no raw-plate line on its BOM, so there was nothing to write the plate count onto. Work the line's cut plates out again.`;
      out.push(entry);
      continue;
    }
    const repoint = link.child_record_kind !== 'item' || Number(link.child_id) !== Number(plateItemId);
    updates.push([link.line_id, plateItemId, quantity]);
    out.push({ ...entry, applied: true, bomLineId: link.line_id, repointedFrom: repoint ? (link.child_code ?? link.child_id) : null, was: round6(Number(link.quantity)) });
  }
  for (const cp of back) {
    const link = lines.get(cp.id);
    const plate = link && link.child_record_kind === 'item' ? restore.plateById.get(Number(link.child_id)) : null;
    if (!plate || !(plate.steel.length > 0 && plate.steel.width > 0)) continue;
    const quantity = round6((cp.steel.length * cp.steel.width) / (plate.steel.length * plate.steel.width));
    updates.push([link.line_id, Number(link.child_id), quantity]);
    out.push({
      cutPlateId: cp.id, plateItemId: plate.id, plateCode: plate.code, blanks: cp.pieces, quantity,
      basis: 'area fraction', spread: null, applied: true, bomLineId: link.line_id, repointedFrom: null,
      was: round6(Number(link.quantity)),
      note: 'Not on any nest now, so its plate quantity is the area fraction again until it is nested.',
    });
  }
  await updateBomLines(db, c.companyId, updates);
  return out;
}

/**
 * Every plate line's child and quantity in ONE statement per 500 lines — a
 * CASE per column — where one UPDATE a line cost a round trip each (~49 ms on
 * production; a KEPL line has well over a hundred cut plates).
 */
async function updateBomLines(db, companyId, updates) {
  for (let i = 0; i < updates.length; i += 500) {
    const part = updates.slice(i, i + 500);
    const child = part.map(() => 'WHEN ? THEN ?').join(' ');
    const qty = part.map(() => 'WHEN ? THEN ?').join(' ');
    await db.query(
      `UPDATE cf_bom_lines
          SET child_id = CASE id ${child} ELSE child_id END,
              quantity = CASE id ${qty} ELSE quantity END
        WHERE company_id = ? AND id IN (?)`,
      [...part.flatMap(([id, ch]) => [id, ch]), ...part.flatMap(([id, , q]) => [id, q]), companyId, part.map(([id]) => id)],
    );
  }
}

/**
 * Each cut plate's one line to its raw plate. Found by WHAT IT POINTS AT rather
 * than by a selection definition's id: the child is either a catalog plate, or
 * the selection that chooses one and has not been resolved yet.
 */
async function plateLinesOf(db, companyId, cutPlateIds, where) {
  const out = new Map();
  if (!cutPlateIds.length) return out;
  const [rows] = await db.query(
    `SELECT b.parent_id AS cut_plate_id, l.id AS line_id, l.child_id, l.quantity,
            m.code AS child_code, m.record_kind AS child_record_kind, m.classification_id,
            d.definition_type, d.candidate_classification_id
       FROM cf_boms b
       JOIN cf_bom_lines l ON l.company_id = b.company_id AND l.bom_id = b.id AND l.deleted_at IS NULL
       JOIN cf_master_records m ON m.id = l.child_id AND m.deleted_at IS NULL
       LEFT JOIN cf_definition_details d ON d.master_id = m.id AND d.deleted_at IS NULL
      WHERE b.company_id = ? AND b.deleted_at IS NULL AND b.parent_id IN (?)
      ORDER BY l.id`,
    [companyId, cutPlateIds],
  );
  const plateSet = new Set(where.plateIds);
  for (const r of rows) {
    const isPlate = r.child_record_kind === 'item'
      ? plateSet.has(r.classification_id)
      : r.definition_type === 'selection' && plateSet.has(r.candidate_classification_id);
    if (isPlate && !out.has(r.cut_plate_id)) out.set(r.cut_plate_id, r);
  }
  return out;
}

/* ---------------------------------------------------------------------------
 * getNesting — the saved plan. A look is a look.
 * ------------------------------------------------------------------------ */

/**
 * Reads back what was accepted, in the same shape planNesting proposes, WITHOUT
 * re-packing: re-solving on every open cost fab a 36-second spinner, and a
 * saved plan IS the plan. The geometry, the plate sizes and the cutting
 * settings all come off the lot rows, so what is drawn is what was agreed even
 * if the catalog or the settings have moved since.
 */
export async function getNesting(db, companyId, orderLineId) {
  const line = await requireLine(db, companyId, orderLineId);
  const { cutPlates } = await surveyLine(db, companyId, line);
  const cpById = new Map(cutPlates.map((cp) => [cp.id, cp]));

  const [lotRows] = await db.query(
    `SELECT l.*, m.code AS plate_code, m.name AS plate_name
       FROM cf_plate_lots l
       LEFT JOIN cf_master_records m ON m.id = l.plate_item_id AND m.deleted_at IS NULL
      WHERE l.company_id = ? AND l.order_line_id = ? AND l.deleted_at IS NULL
      ORDER BY l.lot_no, l.id`,
    [companyId, orderLineId],
  );
  const [placeRows] = lotRows.length ? await db.query(
    `SELECT p.*, m.code AS cut_plate_code, m.name AS cut_plate_name
       FROM cf_nest_placements p
       LEFT JOIN cf_master_records m ON m.id = p.cut_plate_id
      WHERE p.company_id = ? AND p.plate_lot_id IN (?) AND p.deleted_at IS NULL
      ORDER BY p.plate_lot_id, p.seq_no, p.row_no, p.pos_no`,
    [companyId, lotRows.map((l) => l.id)],
  ) : [[]];

  const byLot = new Map(lotRows.map((l) => [l.id, []]));
  const placedCount = new Map();
  for (const p of placeRows) {
    byLot.get(p.plate_lot_id)?.push({
      id: p.id, cutPlateId: p.cut_plate_id, cutPlateCode: p.cut_plate_code ?? p.cut_plate_name,
      seqNo: p.seq_no, rowNo: p.row_no, posNo: p.pos_no,
      // NULL x/y: the piece is on this plate but we found no layout for it.
      x: p.x_mm == null ? null : Number(p.x_mm), y: p.y_mm == null ? null : Number(p.y_mm),
      length: Number(p.length_mm), width: Number(p.width_mm), rotated: !!p.rotated,
    });
    placedCount.set(p.cut_plate_id, (placedCount.get(p.cut_plate_id) ?? 0) + 1);
  }

  // The stored offcuts, one query. A lot saved before waste was recorded has
  // neither waste_json nor offcut rows; its split is worked out here from the
  // geometry (pure) with today's thresholds, and not written — a look is a look.
  const [offRows] = lotRows.length ? await db.query(
    `SELECT plate_lot_id, offcut_no, area_mm2, weight_kg, bbox_x_mm, bbox_y_mm, bbox_length_mm, bbox_width_mm,
            rect_x_mm, rect_y_mm, rect_length_mm, rect_width_mm, outline_json, status
       FROM cf_offcuts
      WHERE company_id = ? AND plate_lot_id IN (?) AND deleted_at IS NULL
      ORDER BY plate_lot_id, id`,
    [companyId, lotRows.map((l) => l.id)],
  ) : [[]];
  const offByLot = new Map();
  const box = (x, y, l, w) => (l == null ? null : { x: x == null ? null : Number(x), y: y == null ? null : Number(y), length: Number(l), width: Number(w) });
  for (const r of offRows) {
    if (!offByLot.has(r.plate_lot_id)) offByLot.set(r.plate_lot_id, []);
    offByLot.get(r.plate_lot_id).push({
      offcutNo: r.offcut_no, area: Number(r.area_mm2), weightKg: r.weight_kg == null ? null : Number(r.weight_kg),
      rect: box(r.rect_x_mm, r.rect_y_mm, r.rect_length_mm, r.rect_width_mm),
      bbox: box(r.bbox_x_mm, r.bbox_y_mm, r.bbox_length_mm, r.bbox_width_mm),
      outline: parseJson(r.outline_json) ?? [],
      status: r.status,
    });
  }
  const settingRows = lotRows.some((l) => l.waste_json == null) ? await cutSettingRows(db, companyId) : [];

  const groups = new Map();
  for (const l of lotRows) {
    const pieces = byLot.get(l.id) ?? [];
    const usedArea = pieces.reduce((a, p) => a + p.length * p.width, 0);
    const length = Number(l.length_mm);
    const width = Number(l.width_mm);
    const key = `${round3(l.thickness_mm)}|${norm(l.grade)}|${norm(l.material)}`;
    if (!groups.has(key)) {
      groups.set(key, {
        key, thickness: round3(l.thickness_mm), grade: l.grade, material: l.material,
        kerfMm: Number(l.kerf_mm), seqGapMinMm: Number(l.seq_gap_min_mm), seqGapMaxMm: Number(l.seq_gap_max_mm),
        orderMarginLengthMm: null, orderMarginWidthMm: null,
        guillotine: !!l.guillotine, settingsBasis: 'recorded when the plan was accepted',
        cutPlates: [], candidates: [], nests: [], unplaced: [],
        metrics: null, deterministic: null, elapsedMs: null,
      });
    }
    groups.get(key).nests.push({
      id: l.id, lotNo: l.lot_no, plateItemId: l.plate_item_id, plateCode: l.plate_code, plateName: l.plate_name,
      source: l.source, isManual: !!l.is_manual, ownerPartyId: l.owner_party_id ?? null,
      thickness: round3(l.thickness_mm), grade: l.grade, material: l.material, density: l.density == null ? null : Number(l.density),
      length, width,
      requiredLength: l.required_length_mm == null ? null : Number(l.required_length_mm),
      requiredWidth: l.required_width_mm == null ? null : Number(l.required_width_mm),
      sheetArea: round3(length * width),
      usedArea: round3(usedArea),
      wasteArea: round3(length * width - usedArea),
      wastePct: length * width > 0 ? round3(((length * width - usedArea) / (length * width)) * 100) : 0,
      weightKg: kgOf(length * width, l.thickness_mm, l.density),
      wasteTotalKg: kgOf(length * width - usedArea, l.thickness_mm, l.density),
      ...savedWasteFields(l, pieces, offByLot.get(l.id) ?? [], settingRows),
      pieces,
    });
  }

  const out = [...groups.values()];
  for (const g of out) {
    g.cutPlates = cutPlates.filter((cp) => g.nests.some((n) => n.pieces.some((p) => p.cutPlateId === cp.id))).map(describeCutPlate);
    g.metrics = metricsOf(g.nests, g);
  }

  // What the line needs now, against what the saved plan places — layoutDrift,
  // the rule the process stage reads too. A structure that has moved since does
  // not rewrite the plan; it makes it OUT OF DATE, and saying which rectangles
  // drifted is more use than a stale flag. A line not nested yet has no drift.
  const codes = new Map(placeRows.map((p) => [p.cut_plate_id, p.cut_plate_code ?? p.cut_plate_name]));
  const drift = lotRows.length ? layoutDrift(cutPlates, placedCount, codes) : [];

  const importedLots = lotRows.filter((l) => l.origin === 'imported');
  const importedIds = new Set(importedLots.map((l) => l.id));
  return {
    line: lineHead(line),
    saved: lotRows.length > 0,
    basis: lotRows.length ? 'saved plan' : 'nothing saved yet',
    imported: { lots: importedLots.length, pieces: placeRows.filter((p) => importedIds.has(p.plate_lot_id)).length },
    // Needed against nested, every cut plate the line needs — the same numbers
    // the sheet's Needed tab and the import preview show.
    coverage: coverageOf(cutPlates, placedCount),
    groups: out,
    manual: cutPlates.filter((cp) => cp.manual && cp.pieces).map(describeManual),
    sizeAdvice: [],
    problems: [],
    drift,
    totals: totalsOf(out),
  };
}

const parseJson = (v) => {
  if (v == null) return null;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return null; }
};

/** Needed vs nested for every cut plate the line needs. diff > 0 = over, < 0 = short. */
export function coverageOf(cutPlates, placedCount) {
  return cutPlates.filter((cp) => cp.pieces || placedCount.get(cp.id)).map((cp) => {
    const nested = placedCount.get(cp.id) ?? 0;
    return {
      cutPlateId: cp.id, cutPlateCode: cp.code ?? nameOf(cp), needed: cp.pieces, nested, diff: nested - cp.pieces, manual: !!cp.manual,
      thickness: cp.steel?.thickness ?? null, length: cp.steel?.length ?? null, width: cp.steel?.width ?? null, grade: cp.steel?.grade ?? null,
    };
  });
}

/**
 * The contract's per-lot fields for a SAVED lot: origin, verdict, forced,
 * reasons, hasLayout, waste, wasteKg, offcuts — read off the row where they
 * were recorded, worked out from the geometry where the lot predates them.
 */
function savedWasteFields(l, pieces, storedOffcuts, settingRows) {
  const hasLayout = pieces.length > 0 && pieces.every((p) => p.x != null && p.y != null);
  const stored = parseJson(l.waste_json);
  let waste;
  let offcuts = storedOffcuts;
  let partsArea = pieces.reduce((a, p) => a + p.length * p.width, 0);
  if (stored) {
    waste = Object.fromEntries(WASTE_KEYS.map((k) => [k, round3(stored[k] ?? 0)]));
    if (stored.partsArea != null) partsArea = Number(stored.partsArea);
  } else {
    const settings = pickCutSettings(settingRows, l.thickness_mm);
    const w = wasteOfLot({
      lotNo: l.lot_no, length: l.length_mm, width: l.width_mm, thickness: l.thickness_mm, density: l.density,
      kerfMm: l.kerf_mm, seqGapMinMm: l.seq_gap_min_mm,
      offcutMinAreaMm2: settings.offcutMinAreaMm2, offcutMinSideMm: settings.offcutMinSideMm,
    }, pieces);
    waste = w.waste;
    if (!offcuts.length) offcuts = w.offcuts;
  }
  const kg = (a) => kgOf(a, l.thickness_mm, l.density);
  return {
    origin: l.origin ?? 'auto',
    verdict: l.check_verdict ?? null,
    forced: !!l.forced,
    reasons: parseJson(l.check_json) ?? [],
    hasLayout,
    waste,
    wasteKg: Object.fromEntries(WASTE_KEYS.map((k) => [k, kg(waste[k])])),
    partsKg: kg(partsArea),
    offcuts,
    sequences: hasLayout ? sequenceSummary(pieces) : [],
    notes: l.notes ?? null,
  };
}

/* ---------------------------------------------------------------------------
 * checkNest — will this imported nest work? Warns, never refuses.
 * ------------------------------------------------------------------------ */

/**
 * One plate and the cut plates somebody put on it, with quantities, packed
 * with OUR packer on that ONE sheet.
 *
 *   all placed                         fits      (our layout is kept)
 *   area is enough, our layout is not  tight     (their program may do it)
 *   the area itself is not enough      wont_fit
 *   wrong thickness / grade / material wont_fit, with the reason
 *
 * The area test charges each piece its pitch (L + k)(W + k) against the plate
 * inside the rim, (L - k)(W - k): the same arithmetic as a row of n parts
 * spanning the sizes + (n + 1)k. Reasons are plain sentences.
 *
 *   plate     { id, code, steel { thickness, length, width, grade, material } }
 *   items     [{ cutPlate { id, code, steel }, qty }]
 *   settings  pickCutSettings for the plate's thickness
 *   pack      the packer (loadPacker)
 *
 * Returns { verdict, reasons, pieces (a layout when fits, else pieces with
 * NULL x/y), requiredLength, requiredWidth }.
 */
export async function checkNest({ plate, items, settings, pack }) {
  const k = Number(settings.kerfMm) || 0;
  const reasons = [];
  const P = plate.steel;
  const pcs = items.reduce((a, it) => a + it.qty, 0);
  const noLayout = (verdict) => {
    const pieces = items.flatMap((it) => Array.from({ length: it.qty }, () => ({
      cutPlateId: it.cutPlate.id, cutPlateCode: nameOf(it.cutPlate), cutPlate: it.cutPlate,
      seqNo: 1, rowNo: 1, x: null, y: null,
      length: it.cutPlate.steel.length, width: it.cutPlate.steel.width, rotated: false,
    })));
    pieces.forEach((p, i) => { p.posNo = i + 1; });
    return { verdict, reasons, pieces, requiredLength: null, requiredWidth: null };
  };

  if (!(P.length > 0 && P.width > 0 && P.thickness > 0)) {
    reasons.push(`${nameOf(plate)} has no thickness, length and width in the catalog, so nothing can be checked against it.`);
    return noLayout('wont_fit');
  }
  // The steel first. A wrong steel is not a layout question at all.
  for (const it of items) {
    const s = it.cutPlate.steel;
    if (!(Math.abs(Number(s.thickness) - P.thickness) <= EPS)) reasons.push(`${nameOf(it.cutPlate)} is ${fmt(s.thickness)} mm and ${nameOf(plate)} is ${fmt(P.thickness)} mm, so it cannot be cut from it.`);
    if (!agrees(P.grade, s.grade)) reasons.push(`${nameOf(it.cutPlate)} is ${s.grade ?? 'of no stated grade'} and ${nameOf(plate)} is ${P.grade}. A nest cannot mix grades.`);
    if (!agrees(P.material, s.material)) reasons.push(`${nameOf(it.cutPlate)} is ${s.material ?? 'of no stated material'} and ${nameOf(plate)} is ${P.material}.`);
    if (!(s.length > 0 && s.width > 0)) reasons.push(`${nameOf(it.cutPlate)} has no length and width, so it cannot be checked.`);
  }
  if (reasons.length) return noLayout('wont_fit');

  // A piece bigger than the plate inside the rim, either way round.
  const inL = P.length - 2 * k;
  const inW = P.width - 2 * k;
  for (const it of items) {
    const { length: l, width: w } = it.cutPlate.steel;
    const fitsOneWay = (l <= inL + EPS && w <= inW + EPS) || (w <= inL + EPS && l <= inW + EPS);
    if (!fitsOneWay) reasons.push(`${nameOf(it.cutPlate)} is ${fmt(l)} × ${fmt(w)}, and ${nameOf(plate)} is ${fmt(P.length)} × ${fmt(P.width)} with a ${fmt(k)} mm kerf cut off every edge, so it does not fit on it either way round.`);
  }
  if (reasons.length) return noLayout('wont_fit');

  // Our packer, on this one sheet. Quick first; a fuller search only when the
  // quick one leaves something off, because most nests are easy.
  const packInput = (effort, budgetMs) => ({
    pieces: items.map((it) => ({ key: `cp${it.cutPlate.id}`, length: it.cutPlate.steel.length, width: it.cutPlate.steel.width, qty: it.qty, grain: 'any' })),
    sheets: [{ key: 'sheet', length: P.length, width: P.width, available: 1, preferred: false, areaCost: P.length * P.width }],
    kerf: k, gap: k, margin: k, thickness: P.thickness,
    sequenceGap: settings.seqGapMinMm,
    smallThreshold: SMALL_PART_MM, rowsPerSequence: { small: 2, big: 3 },
    guillotine: settings.guillotine,
    effort, seed: 1, budgetMs,
  });
  const placedAll = (o) => (o.nests?.length === 1) && !(o.unplaced ?? []).some((u) => Number(u.qty) > 0);
  let out = (await pack(packInput('quick', null))) ?? {};
  if (!placedAll(out)) {
    const again = (await pack(packInput('standard', 3000))) ?? {};
    if (placedAll(again)) out = again;
  }

  if (placedAll(out)) {
    const pieceByKey = new Map(items.map((it) => [`cp${it.cutPlate.id}`, { id: it.cutPlate.id, cutPlate: it.cutPlate, length: it.cutPlate.steel.length, width: it.cutPlate.steel.width }]));
    const sheetByKey = new Map([['sheet', { id: plate.id, plate, length: P.length, width: P.width }]]);
    const shaped = shapeNest(out.nests[0], sheetByKey, pieceByKey, settings, { thickness: P.thickness, grade: P.grade, material: P.material });
    for (const p of shaped.pieces) p.cutPlate = pieceByKey.get(`cp${p.cutPlateId}`)?.cutPlate;
    return { verdict: 'fits', reasons, pieces: shaped.pieces, requiredLength: shaped.requiredLength, requiredWidth: shaped.requiredWidth };
  }

  const need = items.reduce((a, it) => a + (it.cutPlate.steel.length + k) * (it.cutPlate.steel.width + k) * it.qty, 0);
  const have = (P.length - k) * (P.width - k);
  const m2 = (a) => (a / 1e6).toFixed(3);
  const left = (out.unplaced ?? []).reduce((a, u) => a + Number(u.qty || 0), 0) || pcs;
  if (need <= have + EPS) {
    reasons.push(`The ${pcs} pieces take ${m2(need)} m² with kerf and the plate has ${m2(have)} m² inside its rim, so there is room in principle, but our row-by-row layout could not place ${left} of them. The program this nest came from may manage it; check its drawing before cutting.`);
    return noLayout('tight');
  }
  reasons.push(`The ${pcs} pieces need ${m2(need)} m² with kerf and the plate has only ${m2(have)} m² inside its rim, so they cannot all fit, whatever the layout.`);
  return noLayout('wont_fit');
}

/* ---------------------------------------------------------------------------
 * Imported nests — preview and save (the nesting sheet reads, this decides)
 * ------------------------------------------------------------------------ */

/**
 * What an import is checked against, read once: the line, its cut plates and
 * how many of each it needs, the catalog plates, the cut settings and the
 * packer. nestingSheetService matches the sheet's cells against it.
 */
export async function importContext(db, companyId, orderLineId, { pack } = {}) {
  const line = await requireLine(db, companyId, orderLineId);
  const { where, cutPlates } = await surveyLine(db, companyId, line);
  const plates = await candidatePlates(db, companyId, where.plateIds);
  const settingRows = await cutSettingRows(db, companyId);
  return { line, lineHead: lineHead(line), where, cutPlates, plates, settingRows, pack: await loadPacker(pack) };
}

/** The line's order and release state, for the sheet to say "cannot be saved" before anyone tries. */
export function importBlocker(line) {
  try { assertOpen(line); return null; } catch (e) { return e; }
}

/**
 * Checks the nests a sheet describes. `nests` is [{ nestNo, plate, items:
 * [{ cutPlate, qty }] }] with plate and cut plates already matched. Returns
 * the preview the contract names (nests with verdict, reasons, waste and
 * hasLayout, plus coverage: needed vs nested) and, kept aside under `_save`,
 * what a save writes.
 */
export async function checkImportedNests(ctx, nests) {
  const checked = [];
  for (const n of nests) {
    const settings = pickCutSettings(ctx.settingRows, n.plate.steel.thickness);
    const r = await checkNest({ plate: n.plate, items: n.items, settings, pack: ctx.pack });
    const steel = n.items[0]?.cutPlate?.steel ?? {};
    const density = n.plate.steel.density ?? steel.density;
    const w = wasteOfLot({
      lotNo: n.nestNo, length: n.plate.steel.length, width: n.plate.steel.width,
      thickness: n.plate.steel.thickness, density,
      kerfMm: settings.kerfMm, seqGapMinMm: settings.seqGapMinMm,
      offcutMinAreaMm2: settings.offcutMinAreaMm2, offcutMinSideMm: settings.offcutMinSideMm,
    }, r.pieces);
    const reasons = [...r.reasons];
    if (r.verdict !== 'fits' && w.overflow > 0) reasons.push(`The pieces are ${(w.overflow / 1e6).toFixed(3)} m² more than the whole plate.`);
    checked.push({
      nestNo: n.nestNo,
      plateCode: n.plate.code,
      plateLabel: `${fmt(n.plate.steel.thickness)} × ${fmt(n.plate.steel.length)} × ${fmt(n.plate.steel.width)} mm${n.plate.steel.grade ? ` ${n.plate.steel.grade}` : ''}`,
      items: n.items.map((it) => ({ cutPlateCode: nameOf(it.cutPlate), qty: it.qty })),
      verdict: r.verdict,
      reasons,
      waste: w.waste,
      wasteKg: w.wasteKg,
      hasLayout: r.verdict === 'fits',
      offcutCount: w.offcuts.length,
      sheetRows: n.sheetRows ?? null,
      _save: { plate: n.plate, settings, steel, density, check: r, waste: w },
    });
  }
  const placed = new Map();
  for (const n of nests) for (const it of n.items) placed.set(it.cutPlate.id, (placed.get(it.cutPlate.id) ?? 0) + it.qty);
  const coverage = coverageOf(ctx.cutPlates, placed)
    .map(({ cutPlateCode, needed, nested, diff }) => ({ cutPlateCode, needed, nested, diff }));
  return { nests: checked, coverage };
}

/**
 * Saves checked imported nests. SAVING AN IMPORT REPLACES EVERY LOT ON THE
 * LINE, the imported ones and the automatic ones; the rest must be nested
 * again ("Nest the rest"). Writes the lots (origin 'imported', verdict,
 * reasons, forced), placements (our layout's x/y when it fits, NULL x/y
 * otherwise), waste_json, offcuts, and the plate quantity on each cut plate's
 * BOM line. A fixed number of round trips whatever the size.
 */
export async function saveImportedNests(db, c, orderLineId, ctx, checked) {
  const line = await requireLine(db, c.companyId, orderLineId, { lock: true });
  assertOpen(line);
  const replaced = await clearLots(db, c, orderLineId);
  const toWrite = checked.map((n) => {
    const { plate, settings, steel, density, check, waste } = n._save;
    const laid = check.verdict === 'fits';
    const pieces = check.pieces.map((p, i) => ({
      cutPlateId: p.cutPlateId,
      seqNo: laid ? p.seqNo : 1,
      rowNo: laid ? p.rowNo : 1,
      posNo: laid ? p.posNo : i + 1,
      x: laid ? p.x : null,
      y: laid ? p.y : null,
      length: p.length, width: p.width, rotated: laid ? !!p.rotated : false,
    }));
    const lotNo = String(n.nestNo).slice(0, 30);
    return {
      lotNo, plate, source: 'catalog', isManual: false, settings,
      grade: steel.grade ?? plate.steel.grade, material: steel.material ?? plate.steel.material, density,
      requiredLength: check.requiredLength, requiredWidth: check.requiredWidth,
      origin: 'imported', verdict: check.verdict, reasons: n.reasons, forced: !laid,
      notes: String(n.nestNo).length > 30 ? `Nest in the sheet: ${n.nestNo}`.slice(0, 500) : null,
      waste: { ...waste, offcuts: waste.offcuts.map((o, i) => ({ ...o, offcutNo: `${lotNo}-${offcutLetters(i)}` })) },
      pieces,
    };
  });
  const written = await writeLots(db, c, orderLineId, toWrite);
  const blanks = new Map(ctx.cutPlates.filter((cp) => cp.pieces).map((cp) => [cp.id, cp.pieces]));
  const plateById = new Map(ctx.plates.map((p) => [p.id, p]));
  const quantities = await replaceAreaFractions(db, c, ctx.where,
    toWrite.map((l) => ({ plate: l.plate, pieces: l.pieces })), blanks,
    { restore: { cutPlates: ctx.cutPlates, plateById } });
  return {
    replacedLots: replaced,
    lots: written.length,
    pieces: written.reduce((a, l) => a + l.pieces, 0),
    offcuts: written.reduce((a, l) => a + l.offcuts, 0),
    quantities,
  };
}
