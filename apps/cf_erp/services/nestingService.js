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
 */
import { invalid, notFound, assertNoProblems } from '../lib/errors.js';
import { LOCKED_ORDER_STATUSES } from './records.js';
import { subtreeIds } from './tree.js';
import { explode } from './bomService.js';
import { runAll, pickBest } from '../lib/packerPool.js';

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
 * So one seed by default, four at Deep as insurance against an order where seed
 * 1 is not the lucky one. Settable per request for anyone wanting to spend it.
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
            order_margin_length_mm, order_margin_width_mm, order_step_mm, guillotine, notes
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
 * The line, and the two rules that close it to change
 * ------------------------------------------------------------------------ */

async function requireLine(db, companyId, lineId, { lock = false } = {}) {
  const [[l]] = await db.query(
    `SELECT l.*, o.id AS order_id, o.code AS order_code, o.status AS order_status,
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
    throw invalid('ORDER_LOCKED', `Order ${line.order_code} is ${line.order_status} — its structure can no longer change, so its nesting cannot either.`);
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
  const totals = new Map();
  (function walk(node) {
    if (node.id != null && node.depth > 0) totals.set(node.id, round6((totals.get(node.id) ?? 0) + Number(node.total)));
    for (const child of node.children) walk(child);
  }(tree.root));

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
  const line = await requireLine(db, companyId, orderLineId);
  const { where, cutPlates } = await surveyLine(db, companyId, line);
  const pack = await loadPacker(input.pack);
  const settingRows = await cutSettingRows(db, companyId);
  const plates = await candidatePlates(db, companyId, where.plateIds);

  const problems = [];
  const manual = [];
  const seedsTried = [];
  const nestable = [];
  for (const cp of cutPlates) {
    if (!cp.pieces) continue;                       // nothing of it is needed
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
    const sheets = sortSheets(candidates.map((p) => ({
      id: p.id, key: `pl${p.id}`, plate: p,
      length: p.steel.length, width: p.steel.width,
      areaCost: p.steel.length * p.steel.width,
      preferred: false,                                    // offcut sourcing is not built yet
      available: Math.min(1000, Math.max(1, Math.ceil(pieceArea / (p.steel.length * p.steel.width)) + 2)),
    })));
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
      budgetMs: input.budgetMs ?? null,
    };

    prepared.push({ g, sheets, pieces, settings, guillotine, packInput });
  }

  // ---- pack everything, in parallel ----------------------------------------
  // Effort carries a seed count too: Deep buys insurance against an unlucky
  // draw, Standard does not pay for it.
  const effortSeeds = (await import('./nestingPacker.js')).EFFORT?.[input.effort ?? 'standard']?.seeds;
  const seedCount = Math.max(1, Math.trunc(Number(input.seeds ?? effortSeeds ?? DEFAULT_SEEDS)) || 1);
  const outByGroup = new Map();
  if (input.pack) {
    // A caller injected its own packer (the tests do). Run it here, in order.
    for (const pr of prepared) outByGroup.set(pr.g.key, (await pack(pr.packInput)) ?? {});
  } else {
    const jobs = [];
    for (const pr of prepared) {
      const base = Number(pr.packInput.seed) || 1;
      for (let i = 0; i < seedCount; i += 1) {
        jobs.push({ key: pr.g.key, seed: base + i, input: { ...pr.packInput, seed: base + i } });
      }
    }
    const runs = await runAll(jobs);
    for (const pr of prepared) {
      const mine = runs
        .map((r, i) => ({ ...r, seed: jobs[i].seed, key: jobs[i].key }))
        .filter((r) => r.key === pr.g.key);
      const best = pickBest(mine);
      outByGroup.set(pr.g.key, best?.out ?? {});
      if (seedCount > 1) {
        seedsTried.push({
          thickness: pr.g.thickness, grade: pr.g.grade, tried: mine.length, won: best?.seed ?? null,
        });
      }
    }
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
    });
  }

  numberLots(groups);
  return {
    line: lineHead(line),
    saved: false,
    basis: 'proposal',
    settingsNote: 'Kerf is banded by plate thickness and charged at the plate rim as well as between pieces; two parts sharing a boundary are one kerf apart, not two.',
    groups,
    manual,
    sizeAdvice,
    problems,
    // Which seeds were tried and which won, so a plan can say how it was reached
    // and a better one can be got back by asking for that seed again.
    seeds: seedsTried,
    totals: totalsOf(groups),
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
    source: n.preferred ? 'offcut' : 'catalog',
    thickness: g.thickness, grade: g.grade, material: g.material, density,
    length, width,
    ...requiredSize(pieces, settings.kerfMm),
    sheetArea: round3(length * width),
    usedArea: round3(usedArea),
    wasteArea: round3(length * width - usedArea),
    wastePct: length * width > 0 ? round3(((length * width - usedArea) / (length * width)) * 100) : 0,
    weightKg: kgOf(length * width, g.thickness, density),
    wasteKg: kgOf(length * width - usedArea, g.thickness, density),
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
  const wasteKg = nests.reduce((a, n) => a + n.wasteKg, 0);
  return {
    lots, plates: lots, pieces,
    areaBought: round3(areaBought), usedArea: round3(usedArea),
    wasteArea: round3(areaBought - usedArea),
    wastePct: areaBought > 0 ? round3(((areaBought - usedArea) / areaBought) * 100) : 0,
    weightKg: round3(weightKg), wasteKg: round3(wasteKg),
    thickness: g?.thickness ?? null,
  };
}

const totalsOf = (groups) => {
  const flat = groups.flatMap((g) => g.nests);
  return { ...metricsOf(flat, null), groups: groups.length, unplaced: groups.reduce((a, g) => a + g.unplaced.length, 0) };
};

/** N-001 upwards across the whole line, in group order then nest order, so it is stable. */
function numberLots(groups) {
  let n = 0;
  for (const g of groups) for (const nest of g.nests) { n += 1; nest.lotNo = `N-${String(n).padStart(3, '0')}`; }
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

  const problems = [];
  const submitted = flattenNests(plan, problems);

  // What the line actually needs, and what it is holding back by hand.
  const required = new Map();
  for (const cp of cutPlates) {
    if (!cp.pieces || cp.manual) continue;
    if (missingOnPart(cp.steel).length) {
      problems.push(`${nameOf(cp)} does not say its ${list(missingOnPart(cp.steel).map((g) => g.toLowerCase()))}, so a layout naming it cannot be accepted. Set the value, or mark it ${NEST_MANUAL_SPEC_CODE}.`);
      continue;
    }
    required.set(cp.id, cp.pieces);
  }

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
    const lot = {
      lotNo: n.lotNo ?? `N-${String(i + 1).padStart(3, '0')}`,
      plate,
      source: n.source === 'offcut' ? 'offcut' : 'catalog',
      isManual: !!n.isManual,
      settings,
      pieces: [],
    };
    verifyLot(lot, n, { label, cpById, required, placed, problems });
    lots.push(lot);
  }

  // Every rectangle the line needs has to be somewhere. A half-nested blank has
  // no honest plate count, so a short plan is refused rather than half-written;
  // NEST_MANUAL is the way to hold a rectangle back on purpose.
  for (const [cpId, want] of required) {
    const got = placed.get(cpId) ?? 0;
    if (got === want) continue;
    const cp = cpById.get(cpId);
    problems.push(got < want
      ? `${nameOf(cp)}: the line needs ${want} ${want === 1 ? 'piece' : 'pieces'} and the layout places ${got}. Place the rest, or mark it ${NEST_MANUAL_SPEC_CODE} to lay it out by hand.`
      : `${nameOf(cp)}: the layout places ${got} pieces and the line needs only ${want}. Take the extra ${got - want} off a plate.`);
  }

  assertNoProblems(problems, 'That layout cannot be accepted.');

  // ---- from here it only writes -------------------------------------------
  const replaced = await clearLots(db, c, orderLineId);
  const written = [];
  for (const [i, lot] of lots.entries()) {
    const lotNo = `N-${String(i + 1).padStart(3, '0')}`;
    const req = requiredSize(lot.pieces, lot.settings.kerfMm);
    // THE LOT'S STEEL IS THE RECTANGLES', NOT THE PLATE ROW'S. A catalog plate
    // with a blank grade is tolerated as a candidate on purpose — it is a
    // data-entry gap, not a claim — and verification has just proved the plate
    // does not contradict the pieces. Recording the plate's blank instead would
    // file this lot under a steel of its own, and the saved plan would read
    // back as two groups where one was proposed.
    const steel = lot.pieces[0]?.cutPlate?.steel ?? {};
    const grade = steel.grade ?? lot.plate.steel.grade;
    const material = steel.material ?? lot.plate.steel.material;
    const density = lot.plate.steel.density ?? steel.density;
    const [r] = await db.query(
      `INSERT INTO cf_plate_lots
         (company_id, order_line_id, plate_item_id, lot_no, source, thickness_mm, length_mm, width_mm,
          required_length_mm, required_width_mm, grade, material, density,
          kerf_mm, seq_gap_min_mm, seq_gap_max_mm, guillotine, is_manual, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [companyId, orderLineId, lot.plate.id, lotNo, lot.source,
        lot.plate.steel.thickness, lot.plate.steel.length, lot.plate.steel.width,
        req.requiredLength, req.requiredWidth, grade, material, density,
        lot.settings.kerfMm, lot.settings.seqGapMinMm, lot.settings.seqGapMaxMm,
        lot.settings.guillotine ? 1 : 0, lot.isManual ? 1 : 0, c.userId ?? null],
    );
    const lotId = r.insertId;
    const rows = numberWithinRows(lot.pieces).map((p) => [
      companyId, lotId, p.cutPlateId, p.seqNo, p.rowNo, p.posNo, p.x, p.y, p.length, p.width, p.rotated ? 1 : 0, c.userId ?? null,
    ]);
    if (rows.length) {
      await db.query(
        `INSERT INTO cf_nest_placements
           (company_id, plate_lot_id, cut_plate_id, seq_no, row_no, pos_no, x_mm, y_mm, length_mm, width_mm, rotated, created_by)
         VALUES ?`,
        [rows],
      );
    }
    written.push({ id: lotId, lotNo, plateItemId: lot.plate.id, pieces: rows.length });
  }

  const quantities = await replaceAreaFractions(db, c, where, lots, required);
  return {
    line: lineHead(line),
    replacedLots: replaced,
    lots: written.length,
    plates: written.length,                          // a lot IS a plate; never sum placements for this
    pieces: written.reduce((a, l) => a + l.pieces, 0),
    quantities,
    caveatCleared: 'The plate quantity on each cut plate is now the nesting plan, not the area fraction.',
  };
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
function verifyLot(lot, n, { label, cpById, required, placed, problems }) {
  const { plate, settings } = lot;
  const k = settings.kerfMm;
  const raw = Array.isArray(n.pieces) ? n.pieces : [];
  if (!raw.length) { problems.push(`${label}: it has no pieces on it. An empty plate is not a nest — take it out of the plan.`); return; }

  const pieces = [];
  for (const [j, p] of raw.entries()) {
    const at = `${label}, piece ${j + 1}`;
    const cp = cpById.get(Number(p.cutPlateId));
    if (!cp) { problems.push(`${at}: ${p.cutPlateId == null ? 'no cut plate is named' : `cut plate ${p.cutPlateId} is not one of this line's`}.`); continue; }
    if (cp.manual) { problems.push(`${at}: ${nameOf(cp)} is marked ${NEST_MANUAL_SPEC_CODE}, so it is laid out by hand and cannot also be on a packed plate. Clear the flag to nest it.`); continue; }
    if (!required.has(cp.id)) { problems.push(`${at}: ${nameOf(cp)} is not a rectangle this line needs.`); continue; }

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

/** Soft-deletes the line's lots and their placements. Accepting twice is not double steel. */
async function clearLots(db, c, orderLineId) {
  const [rows] = await db.query(
    'SELECT id FROM cf_plate_lots WHERE company_id = ? AND order_line_id = ? AND deleted_at IS NULL',
    [c.companyId, orderLineId],
  );
  if (!rows.length) return 0;
  const ids = rows.map((r) => r.id);
  await db.query('UPDATE cf_nest_placements SET deleted_at = NOW() WHERE company_id = ? AND plate_lot_id IN (?) AND deleted_at IS NULL', [c.companyId, ids]);
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
async function replaceAreaFractions(db, c, where, lots, required) {
  const charge = new Map();                        // cutPlateId -> Map(plateItemId -> area)
  for (const lot of lots) {
    const total = lot.pieces.reduce((a, p) => a + p.length * p.width, 0);
    if (!(total > 0)) continue;
    const sheetArea = lot.plate.steel.length * lot.plate.steel.width;
    for (const p of lot.pieces) {
      if (!charge.has(p.cutPlateId)) charge.set(p.cutPlateId, new Map());
      const byPlate = charge.get(p.cutPlateId);
      const add = ((p.length * p.width) / total) * sheetArea;
      byPlate.set(lot.plate.id, (byPlate.get(lot.plate.id) ?? 0) + add);
    }
  }

  const lines = await plateLinesOf(db, c.companyId, [...charge.keys()], where);
  const out = [];
  for (const [cutPlateId, byPlate] of charge) {
    const blanks = required.get(cutPlateId) ?? 0;
    const link = lines.get(cutPlateId);
    const ranked = [...byPlate.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
    const [plateItemId, ] = ranked[0];
    const plate = lots.find((l) => l.plate.id === plateItemId).plate;
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
    if (repoint) await db.query('UPDATE cf_bom_lines SET child_id = ? WHERE company_id = ? AND id = ?', [plateItemId, c.companyId, link.line_id]);
    await db.query('UPDATE cf_bom_lines SET quantity = ? WHERE company_id = ? AND id = ?', [quantity, c.companyId, link.line_id]);
    out.push({ ...entry, applied: true, bomLineId: link.line_id, repointedFrom: repoint ? (link.child_code ?? link.child_id) : null, was: round6(Number(link.quantity)) });
  }
  return out;
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
       LEFT JOIN cf_master_records m ON m.id = p.cut_plate_id AND m.deleted_at IS NULL
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
      x: Number(p.x_mm), y: Number(p.y_mm), length: Number(p.length_mm), width: Number(p.width_mm), rotated: !!p.rotated,
    });
    placedCount.set(p.cut_plate_id, (placedCount.get(p.cut_plate_id) ?? 0) + 1);
  }

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
      source: l.source, isManual: !!l.is_manual,
      thickness: round3(l.thickness_mm), grade: l.grade, material: l.material, density: l.density == null ? null : Number(l.density),
      length, width,
      requiredLength: l.required_length_mm == null ? null : Number(l.required_length_mm),
      requiredWidth: l.required_width_mm == null ? null : Number(l.required_width_mm),
      sheetArea: round3(length * width),
      usedArea: round3(usedArea),
      wasteArea: round3(length * width - usedArea),
      wastePct: length * width > 0 ? round3(((length * width - usedArea) / (length * width)) * 100) : 0,
      weightKg: kgOf(length * width, l.thickness_mm, l.density),
      wasteKg: kgOf(length * width - usedArea, l.thickness_mm, l.density),
      sequences: sequenceSummary(pieces),
      pieces,
    });
  }

  const out = [...groups.values()];
  for (const g of out) {
    g.cutPlates = cutPlates.filter((cp) => g.nests.some((n) => n.pieces.some((p) => p.cutPlateId === cp.id))).map(describeCutPlate);
    g.metrics = metricsOf(g.nests, g);
  }

  // What the line needs now, against what the saved plan places. A structure
  // that has moved since does not invalidate the plan; it means somebody has to
  // look, and saying which rectangles drifted is more use than a stale flag.
  const drift = [];
  for (const cp of cutPlates) {
    if (cp.manual || !cp.pieces) continue;
    const got = placedCount.get(cp.id) ?? 0;
    if (got !== cp.pieces) drift.push({ cutPlateId: cp.id, code: cp.code, needs: cp.pieces, placed: got });
  }

  return {
    line: lineHead(line),
    saved: lotRows.length > 0,
    basis: lotRows.length ? 'saved plan' : 'nothing saved yet',
    groups: out,
    manual: cutPlates.filter((cp) => cp.manual && cp.pieces).map(describeManual),
    sizeAdvice: [],
    problems: [],
    drift,
    totals: totalsOf(out),
  };
}

/* ---------------------------------------------------------------------------
 * The Excel sheet, out and back in
 * ------------------------------------------------------------------------ */

export const SHEET_NAME = 'NESTING';
export const NOTES_SHEET = 'How to use this';
const MAX_SHEET_ROWS = 20000;

/**
 * `locked` columns are written by the export for context and ignored on the way
 * back in — everything the layout actually IS comes from the unlocked ones.
 */
const SHEET_COLUMNS = [
  { key: 'rowId', header: 'Row ID', width: 10, locked: true },
  { key: 'lot', header: 'Lot', width: 10 },
  { key: 'plateCode', header: 'Plate Code', width: 26 },
  { key: 'plateSize', header: 'Plate Size (mm)', width: 20, locked: true },
  { key: 'thickness', header: 'Thickness (mm)', width: 13, locked: true },
  { key: 'grade', header: 'Grade', width: 10, locked: true },
  { key: 'material', header: 'Material', width: 10, locked: true },
  { key: 'cutPlateCode', header: 'Cut Plate Code', width: 26 },
  { key: 'cutPlateName', header: 'Cut Plate', width: 30, locked: true },
  { key: 'seqNo', header: 'Seq', width: 7 },
  { key: 'rowNo', header: 'Row', width: 7 },
  { key: 'posNo', header: 'Pos', width: 7, locked: true },
  { key: 'x', header: 'X (mm)', width: 11 },
  { key: 'y', header: 'Y (mm)', width: 11 },
  { key: 'length', header: 'Length (mm)', width: 12 },
  { key: 'width', header: 'Width (mm)', width: 12 },
  { key: 'rotated', header: 'Rotated?', width: 10 },
];

const normaliseHeader = (h) => String(h ?? '').split(/[([]/)[0].trim().toUpperCase();
const HEADER_TO_KEY = new Map(SHEET_COLUMNS.map((c) => [normaliseHeader(c.header), c.key]));

const INSTRUCTIONS = (model) => [
  ['Nesting layout', `${model.line.orderCode} · line ${model.line.lineNo}`],
  ['', ''],
  ['UPLOADING THIS SHEET IS ACCEPTING IT.', 'There is no separate confirm step. The moment this file is read back, these plates and these positions replace whatever was saved, and each cut plate\'s plate quantity is rewritten from them. People were surprised by this in the other system, so it is said here.'],
  ['', ''],
  ['The sheet IS the whole plan.', 'Unlike the BOM sheet, a row that is not here is not "left alone" — it is a piece that is not placed. Every rectangle the line needs has to appear, or the upload is refused and says which ones are short.'],
  ['One row is one piece.', 'A cut plate needed six times is six rows, each with its own position. Never a row with a quantity.'],
  ['Row ID', 'Written by the export. Leave it. A new row you add just has an empty Row ID.'],
  ['Lot', 'One physical plate. Rows sharing a Lot are one nest and are cut from one plate. A new Lot label opens a new plate.'],
  ['Plate Code', 'The catalog plate the lot is. It must be the same thickness as the pieces on it, and its grade and material must not contradict theirs.'],
  ['Seq / Row', 'The plate is cut Sequence by Sequence, in order, and each sequence holds rows. Under 200 mm on both dimensions is a Small part and its sequence holds 2 rows; anything larger holds 3.'],
  ['X / Y', 'The piece\'s own corner, measured from the plate\'s corner, in mm. Kerf is cut at the plate rim too, so nothing may sit closer to an edge than one kerf; two pieces may share a boundary, which is one kerf, but never less.'],
  ['Rotated?', 'yes swaps the piece\'s length and width. Length and Width here are the footprint as placed.'],
  ['Grey columns', 'Written for context and ignored when this comes back.'],
  ['', ''],
  ['Kerf on this plan', model.groups.map((g) => `${fmt(g.thickness)} mm: ${fmt(g.kerfMm)} mm kerf, sequences ${fmt(g.seqGapMinMm)}–${fmt(g.seqGapMaxMm)} mm apart (${g.settingsBasis})`).join('; ') || '—'],
  ['Ordering margin', 'Plate is ordered +100 mm on length and +50 mm on width over what the layout needs, because plate edges are not straight. That is procurement, not waste, and it is not drawn here.'],
];

/*
 * exportNestingSheet / importNestingSheet USED TO LIVE HERE. They are gone:
 * nestingSheetService.js is the one implementation of the sheet, and the only
 * caller these still had was a test — so the suite was exercising the dead copy
 * while the live one was covered somewhere else. Two implementations of one
 * feature is the same trap as two kerf tables.
 */
