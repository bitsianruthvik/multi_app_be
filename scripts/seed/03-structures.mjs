/**
 * 03-structures.mjs — the five things this shop knows how to build.
 *
 * THE MODEL, which is not mine and must not be re-invented here (it is
 * FAB_ERP_FIELDS_REDESIGN.md §5, implemented by scripts/seed-bom-from-templates.mjs):
 *
 *     the VARIANT is a CATEGORY          'Composite Girder'
 *     each structural LEVEL is an ITEM   Span, Girder, Segment, Top Flange, ...
 *     the STRUCTURE is BOM LINES         Span -@girders-> Girder -@segments-> Segment -> parts
 *
 * A template is not flagged; `routes/templates.js` DERIVES it — a catalog item
 * with BOM lines under it and none above it. So the five Span items below
 * become the five things the order wizard offers, and nothing else has to know
 * they exist. The five category names are spelled exactly as
 * `multi_app_fe/src/apps/fab_erp/types.ts` LINE_TYPES spells them, because that
 * string is also `fab_flow_rules.line_type` and `fab_order_lines.line_type`;
 * a typo here is a rule that silently never fires.
 *
 * WHAT IS COPIED AND WHAT IS DESIGNED. Composite Girder is a byte-for-byte
 * reproduction of what Placebo had (read out of the `placebo_old` schema,
 * company 30005: catalog ids 390062-390071, fab_item_bom ids 30001-30009) —
 * same codes, same names, same defaults of 6 and 5, same help text. The other
 * four are new and are modelled on how each type is actually fabricated, not on
 * Composite with the words changed. Notes are on each block.
 *
 * ── THREE RULES THAT ARE NOT OBVIOUS FROM THE SCHEMA ───────────────────────
 *
 * 1. A `/D` LINE MAY NOW CARRY ITS REAL QUANTITY. It could not before, and the
 *    reason is worth keeping because it is the kind of bug that reports
 *    success. `expand()` numbers siblings by editing `code_segment` whenever
 *    qty > 1. It used to APPEND the ordinal, so a `GUSS/D` line at qty 2 gave
 *    codes ending `GUSS/D1` and `GUSS/D2`; `itemCodeService.codeSuffix()` reads
 *    everything after the LAST `/`, so the suffix read `/D1`, and
 *    `flowAllocationService.pickRule()` matches a suffix EXACTLY — no rule
 *    names `/D1`, so a part that must be drilled was quietly given the PLAIN
 *    flow and shipped with no holes. Every `/D` line here was therefore pinned
 *    to 1, with the real count raised in the wizard.
 *
 *    `bomService.expand()` now inserts the ordinal BEFORE the slash (`GUSS1/D`,
 *    `GUSS2/D`), so the suffix survives and the constraint is gone. PEB below
 *    uses real counts because of it. The four bridge variants are deliberately
 *    NOT re-quantified in the same pass: Composite Girder is a reproduction of
 *    placebo_old and must stay identical to it, and the other three were
 *    authored against it. Raising their counts is a separate, reviewable
 *    change — not a side effect of a bug fix.
 *
 * 2. LEVEL ITEMS ARE HAND-CODED, deliberately. `itemCodeService` mints codes
 *    for an ORDER's items (`CUST-SO-…-G1-1-TF`), not for catalog rows, and the
 *    catalog code generator produces serials like `RM26RM01418` which identify
 *    nothing to a reader. `bomService.instantiate()` strips the ROOT's whole
 *    code off every descendant, so the root code is load-bearing text a person
 *    has to recognise. `<CATEGORY>-<LEVEL>` is what Placebo used and what
 *    scripts/compare-wizard.mjs looks up by literal string (`COMPOS-SPAN`).
 *    A `/` in a code segment becomes `-` in the item code — `BS/D` -> `COMPOS-BS-D`
 *    — again copying the old data.
 *
 * 3. `level_kind` IS THE POINT. A girder with no level_kind is classified as
 *    raw material for its span and gated on as steel waiting to arrive (the H1
 *    note in bomService.instantiate). span/girder/segment/part, always, and
 *    never 'material'.
 *
 * FLOWS. Flow assignment is `fab_flow_rules` (level + code suffix), which
 * module 04 owns and which is line_type-agnostic, so all five variants are
 * covered by the same three rules. Placebo ALSO carried `flow_id` on the
 * catalog row, and `instantiate()` prefers it, so this module links flows
 * best-effort by code (PARTPL / PARTDR / SEG) if they already exist — filling
 * only NULLs, never overwriting a choice. On a first combined run module 04 has
 * not run yet and the links stay NULL; the rules still route correctly, and a
 * second run fills them in.
 *
 * IDEMPOTENT. Everything is found by `code` within the company and upserted; a
 * second run creates nothing. Lines under a parent this module owns that are
 * not in the spec are soft-deleted, so editing the spec converges rather than
 * accumulating.
 */

import { setBomLine } from '../../apps/fab_erp/services/bomService.js';

export const NAME = 'Structures';

/** Every level item is made, is measured in pieces, and is not raw material. */
const UNIT = 'nos';

/** Verbatim from placebo_old fab_item_bom #30001 / #30002. */
const HELP_GIRDERS = '0 if this job has no girders - the level collapses and parts sit under the span';
const HELP_SEGMENTS = 'The default for every girder. An end girder is routinely cut differently, so each can be overridden.';

/**
 * The five variants.
 *
 * `girder.defaultQty` is the answer the wizard pre-fills; 0 means the level
 * COLLAPSES and its contents hoist to the span. `segment` may be null, in which
 * case `parts` hang off the girder.
 *
 * `assemblies` (PEB only) is the second shape a girder level can have: instead
 * of ONE segment level whose children are all the parts, a girder may hold
 * SEVERAL named weldments side by side, each with its own parts, plus loose
 * parts of its own. Each entry is a `level_kind = 'segment'` item — which is
 * the point, because `fab_flow_rules` gives every `segment` the SEG assembly
 * flow, so an assembly declared this way needs no new rule.
 *
 * `seg` is `code_segment`: what this level contributes to a generated code.
 * 'G' for girders and the part's own abbreviation for parts, per the old data;
 * null on the single `segment` line, which is why a bridge segment reads as
 * `-1-`, `-2-`. An `assemblies` entry MUST carry a real `seg`: two different
 * weldments under one parent would otherwise both number from 1 and collide
 * (rafter `-1`, column `-1`).
 */
const VARIANTS = [
  // ───────────────────────────────────────────────────────────────────────
  // 1. COMPOSITE GIRDER — reproduced exactly from placebo_old.
  //
  // A welded plate I-girder acting compositely with the deck slab. The segment
  // is what the shop assembles on the H-beam line: three plates make the I,
  // stiffeners are welded on after. Bearing stiffeners sit over the supports,
  // intermediate ones between; each comes plain or drilled, which is the only
  // reason there are seven parts rather than five.
  // ───────────────────────────────────────────────────────────────────────
  {
    name: 'Composite Girder',
    code: 'COMPOS',
    span: { code: 'SPAN', name: 'Span' },
    girder: { code: 'GDR', name: 'Girder', defaultQty: 6, seg: 'G', help: HELP_GIRDERS },
    segment: { code: 'SEG', name: 'Segment', defaultQty: 5, help: HELP_SEGMENTS },
    parts: [
      { seg: 'TF', name: 'Top Flange', qty: 1 },
      { seg: 'WP', name: 'Web Plate', qty: 1 },
      { seg: 'BF', name: 'Bottom Flange', qty: 1 },
      { seg: 'BS', name: 'Bearing Stiffener Plain', qty: 1 },
      { seg: 'BS/D', name: 'Bearing Stiffener Hole', qty: 1 },
      { seg: 'IS', name: 'Intermediate Stiffener Plain', qty: 1 },
      { seg: 'IS/D', name: 'Intermediate Stiffener Hole', qty: 1 },
    ],
  },

  // ───────────────────────────────────────────────────────────────────────
  // 2. BOWSTRING — a tied arch. TWO members per plane, not one.
  //
  // The girder here is a whole arch PLANE: a curved arch rib in compression
  // over a straight tie girder in tension, with hangers between them. The tie
  // takes the arch's horizontal thrust, which is what lets the bridge sit on
  // ordinary bearings — so the tie is not optional trim, it is half the
  // structure, and it is fabricated as its own welded I-section. Both members
  // are cut into segments and spliced, and a segment therefore carries plates
  // for BOTH: that is what makes a bowstring segment different from a composite
  // one, not the curvature.
  //
  // The arch rib is a closed box (top plate, two webs, bottom plate) because a
  // compression member needs torsional stiffness; boxes need internal
  // diaphragms at intervals to stop the walls buckling. Hangers and the knuckle
  // gussets where the arch lands on the tie are PINNED or BOLTED, never welded,
  // so those two parts are the drilled ones.
  // ───────────────────────────────────────────────────────────────────────
  {
    name: 'BowString',
    code: 'BOWSTR',
    span: { code: 'SPAN', name: 'BowString Span' },
    girder: {
      code: 'GDR',
      name: 'BowString Arch Girder',
      defaultQty: 2,
      seg: 'G',
      help: 'Arch planes. A road bowstring has two; 0 collapses the level and parts sit under the span.',
    },
    segment: {
      code: 'SEG',
      name: 'BowString Segment',
      defaultQty: 6,
      help: 'Shipping segments per arch plane. The crown and springing segments usually differ, so each plane can be overridden.',
    },
    parts: [
      { seg: 'ARTP', name: 'Arch Rib Top Plate', qty: 1 },
      { seg: 'ARWP', name: 'Arch Rib Web Plate', qty: 2 },
      { seg: 'ARBP', name: 'Arch Rib Bottom Plate', qty: 1 },
      { seg: 'ARDP', name: 'Arch Rib Diaphragm', qty: 2 },
      { seg: 'ARST', name: 'Arch Rib Stiffener', qty: 2 },
      { seg: 'TGTF', name: 'Tie Girder Top Flange', qty: 1 },
      { seg: 'TGWP', name: 'Tie Girder Web Plate', qty: 1 },
      { seg: 'TGBF', name: 'Tie Girder Bottom Flange', qty: 1 },
      { seg: 'HGR/D', name: 'Hanger Plate', qty: 1 },
      { seg: 'GUS/D', name: 'Knuckle Gusset Plate', qty: 1 },
    ],
  },

  // ───────────────────────────────────────────────────────────────────────
  // 3. TUB GIRDER — a trapezoidal box, open at the top until the deck goes on.
  //
  // Two narrow top flanges (one over each web), two webs leaning inward, one
  // wide bottom flange. Everything that follows comes from it being CLOSED:
  //   - the bottom flange is wide and in compression over the piers, so it is
  //     stiffened longitudinally with ribs — a composite girder never needs this
  //   - internal diaphragms hold the trapezoid's shape against torsion, and a
  //     tub is chosen precisely because it is torsionally stiff on a curve
  //   - one diaphragm per segment carries a MAN ACCESS HOLE, because once the
  //     deck is cast the inside is a confined space that still has to be
  //     inspected. That hole is why the diaphragm is the drilled part.
  //   - the open top is unstable in transport and erection, so a temporary top
  //     lateral bracing X is BOLTED across it and removed after the pour —
  //     bolted, therefore drilled.
  // ───────────────────────────────────────────────────────────────────────
  {
    name: 'Tub Girder',
    code: 'TUBGIR',
    span: { code: 'SPAN', name: 'Tub Girder Span' },
    girder: {
      code: 'GDR',
      name: 'Tub Girder',
      defaultQty: 2,
      seg: 'G',
      help: 'Tubs across the deck width. 0 collapses the level and parts sit under the span.',
    },
    segment: {
      code: 'SEG',
      name: 'Tub Girder Segment',
      defaultQty: 5,
      help: 'Shipping segments per tub. Pier segments are deeper and shorter, so each tub can be overridden.',
    },
    parts: [
      { seg: 'TTF', name: 'Tub Top Flange Plate', qty: 2 },
      { seg: 'TIW', name: 'Tub Inclined Web Plate', qty: 2 },
      { seg: 'TBF', name: 'Tub Bottom Flange Plate', qty: 1 },
      { seg: 'TBS', name: 'Tub Bottom Flange Stiffener', qty: 4 },
      { seg: 'TWS', name: 'Tub Web Stiffener', qty: 2 },
      { seg: 'TDP', name: 'Tub Internal Diaphragm', qty: 1 },
      { seg: 'TBD', name: 'Tub Bearing Diaphragm', qty: 1 },
      { seg: 'TDP/D', name: 'Tub Diaphragm with Access Hole', qty: 1 },
      { seg: 'TLB/D', name: 'Tub Top Lateral Bracing Strut', qty: 1 },
    ],
  },

  // ───────────────────────────────────────────────────────────────────────
  // 4. OPENWEB GIRDER — a truss, and the one variant whose PART is a MEMBER.
  //
  // The other four are plate structures: a part is a plate, and the segment is
  // where plates become a member. A truss inverts that. Its panel is an
  // assembly of finished MEMBERS — chords, diagonals, verticals — meeting at a
  // gusset, and the members are bought or built as sections. So 'part' here
  // means a member, and the segment level is the PANEL between two nodes.
  //
  // A truss is a BOLTED structure, which is why six of nine parts are drilled.
  // That is not padding: every chord splice, every diagonal end, every gusset
  // is a hole pattern, and getting them wrong is the classic truss failure. The
  // three plain parts are the deck framing — cross girders and stringers are
  // welded plate girders that happen to live inside a truss, and the lateral
  // bracing angles are welded — so this variant exercises BOTH part flows
  // heavily rather than nominally.
  // ───────────────────────────────────────────────────────────────────────
  {
    name: 'Openweb Girder',
    code: 'OPENWE',
    span: { code: 'SPAN', name: 'Openweb Span' },
    girder: {
      code: 'GDR',
      name: 'Openweb Truss Girder',
      defaultQty: 2,
      seg: 'G',
      help: 'Truss planes, one each side of the deck. 0 collapses the level and parts sit under the span.',
    },
    segment: {
      code: 'SEG',
      name: 'Openweb Panel',
      defaultQty: 8,
      help: 'Panels between nodes, per truss plane. End panels carry the portal and differ, so each plane can be overridden.',
    },
    parts: [
      { seg: 'TC/D', name: 'Truss Top Chord Member', qty: 1 },
      { seg: 'BC/D', name: 'Truss Bottom Chord Member', qty: 1 },
      { seg: 'DIAG/D', name: 'Truss Diagonal Member', qty: 1 },
      { seg: 'VERT/D', name: 'Truss Vertical Member', qty: 1 },
      { seg: 'GUSS/D', name: 'Truss Gusset Plate', qty: 1 },
      { seg: 'SPL/D', name: 'Truss Splice Plate', qty: 1 },
      { seg: 'LAT', name: 'Truss Lateral Bracing Angle', qty: 2 },
      { seg: 'XGD', name: 'Truss Cross Girder', qty: 1 },
      { seg: 'STR', name: 'Truss Stringer', qty: 2 },
    ],
  },

  // ───────────────────────────────────────────────────────────────────────
  // 5. PEB — the one variant whose girder level is not a single segment run.
  //
  // A pre-engineered building has no girders and no shipping segments. It has
  // FRAMES: a frame is the building's repeating portal, and how many there are
  // IS the building's length. So the girder level is the frame and its quantity
  // is the parameter — that part of the old model was right.
  //
  // WHAT WAS WRONG. The rafter and the column are not parts. They are welded
  // built-up TAPERED I-sections: a trapezoidal web plate plus two flange
  // plates, cut on the plasma table and run through the H-beam welding line,
  // exactly as a girder segment is. Hanging those plates directly off the frame
  // with level_kind='part' gave each plate a part flow (cut → move → edge prep
  // → QC) and left NOTHING that welded them together — the building's two
  // principal members were never fabricated, only their ingredients. A PEB is
  // the one structure here where a frame holds SEVERAL weldments rather than a
  // run of identical segments, and `assemblies` is that shape.
  //
  // WHY TWO OF EACH.
  //   Rafter ×2  — a clear-span portal ships as two rafter halves spliced at
  //                the ridge; each half bolts to a column at the eave. That is
  //                also why the rafter carries TWO end plates, one per joint.
  //   Column ×2  — one each side of the frame.
  //
  // WHAT IS WELDED AND WHAT IS BOLTED, which is the whole fabrication story:
  //   WELDED   web + 2 flanges into the tapered I, then the end plate (rafter)
  //            or the base plate and cap plate (column) welded onto the ends.
  //            All of this happens in the shop, on the assembly.
  //   BOLTED   the joints those plates make: base plate to foundation on anchor
  //            bolts, rafter end plate to column cap at the eave, rafter to
  //            rafter at the ridge, purlins to rafters, bracing flats at both
  //            ends. Bolted means DRILLED, hence `/D`.
  //
  // So the base plate and the end plate are drilled AND welded-on: they belong
  // under the weldment that carries them, not loose under the frame. They were
  // loose in the first draft, which meant four holes-in-plate with no assembly
  // consuming them — the same gap as the rafter, one level down. Purlins and
  // bracing flats ARE loose: they span BETWEEN frames and are bolted on site,
  // so they stay direct children of the frame with no shop assembly at all.
  //
  // `EP/D` is deliberately ONE catalog item used under BOTH assemblies. A PEB
  // moment end plate is the same detail at the eave and at the ridge; two items
  // would be two names for one plate. `fab_item_bom` is (parent, child) pairs,
  // so one child under two parents is a normal line, not a trick.
  // ───────────────────────────────────────────────────────────────────────
  {
    name: 'PEB',
    code: 'PEB',
    span: { code: 'SPAN', name: 'PEB Span' },
    girder: {
      code: 'FRM',
      name: 'PEB Frame',
      // WHY 5 AND NOT 0. The old default was 0 to demonstrate the collapse
      // rule, and with no assembly level to lose that was harmless. It is not
      // harmless now: 0 collapses the frame, and the rafter and column
      // assemblies hoist to the span — so the default PEB becomes a building
      // with ONE rafter and TWO columns and no repeating unit at all. A frame
      // count is not a level a PEB can do without; it is the building's length.
      // 5 frames is 4 bays at 6 m centres — a 24 m shed, the smallest thing a
      // customer actually orders. The collapse rule loses nothing by not being
      // the default: it is exercised by ANSWERING 0, which the help text says
      // and which is a keystroke away in the wizard.
      defaultQty: 5,
      seg: 'G',
      help: 'Portal frames — this is the building\'s length (5 frames = 4 bays at 6 m = 24 m). Answer 0 and the level collapses so one frame\'s worth of members sits directly under the span.',
    },
    segment: null,
    assemblies: [
      {
        code: 'RAFT',
        name: 'PEB Rafter',
        qty: 2,
        seg: 'RAFT',
        parts: [
          { seg: 'RFW', name: 'PEB Rafter Web Plate', qty: 1 },
          { seg: 'RFF', name: 'PEB Rafter Flange Plate', qty: 2 },
          // Eave and ridge. This is the line that could not exist before the
          // expand() index-before-slash fix: at qty 2 its codes are EP1/D and
          // EP2/D, and the old numbering made them EP/D1 and EP/D2, which no
          // flow rule names.
          { seg: 'EP/D', name: 'PEB End Plate', qty: 2 },
        ],
      },
      {
        code: 'COL',
        name: 'PEB Column',
        qty: 2,
        seg: 'COL',
        parts: [
          { seg: 'COLW', name: 'PEB Column Web Plate', qty: 1 },
          { seg: 'COLF', name: 'PEB Column Flange Plate', qty: 2 },
          { seg: 'BP/D', name: 'PEB Base Plate', qty: 1 },
          { seg: 'EP/D', name: 'PEB End Plate', qty: 1 },
        ],
      },
    ],
    // Loose, site-bolted, no shop assembly. Counts are per BAY, carried on the
    // frame because a bay and a frame are one-for-one along the building.
    parts: [
      { seg: 'PRL/D', name: 'PEB Purlin', qty: 12 },
      { seg: 'BRC/D', name: 'PEB Bracing Flat', qty: 4 },
    ],
  },
];

/** `BS/D` -> `BS-D`. A slash is legal in a code_segment but not wanted in a code. */
const itemCode = (variantCode, seg) => `${variantCode}-${String(seg).replace(/\//g, '-')}`;

/** First occurrence of each `code` wins; a repeated child is one catalog item. */
const dedupeByCode = (rows) => [...new Map(rows.map((r) => [r.code, r])).values()];

/** The flow a level should carry, by code. Null means "a grouping, no work". */
function flowCodeFor(levelKind, seg) {
  if (levelKind === 'segment') return 'SEG';
  if (levelKind !== 'part') return null;
  return String(seg).toUpperCase().endsWith('/D') ? 'PARTDR' : 'PARTPL';
}

export async function seed(ctx) {
  const { companyId, apply, conn, log } = ctx;

  const counts = { categories: 0, items: 0, bomLines: 0, created: 0 };
  /** What a dry run would have to make. Reported, never written. */
  const missing = { categories: 0, items: 0, bomLines: 0 };

  // Flows, if module 04 has already run. Best-effort by code; absent is fine.
  const [flowRows] = await conn.query(
    `SELECT id, code FROM fab_operation_flows
      WHERE company_id = ? AND deleted_at IS NULL AND active = 1`,
    [companyId],
  );
  const flowIdByCode = new Map(flowRows.map((f) => [String(f.code).toUpperCase(), Number(f.id)]));
  if (!flowIdByCode.size) log('no flows yet — catalog flow_id stays NULL, fab_flow_rules will route');

  for (const v of VARIANTS) {
    // ── the category ────────────────────────────────────────────────────
    // Looked up by code AND by name, because `name` carries its own unique
    // index; finding one but not the other and inserting anyway is a duplicate
    // key at 3am rather than an error here.
    const [[catByCode]] = await conn.query(
      'SELECT id, name FROM fab_item_categories WHERE company_id = ? AND code = ? AND deleted_at IS NULL LIMIT 1',
      [companyId, v.code],
    );
    const [[catByName]] = catByCode ? [[null]] : await conn.query(
      'SELECT id, code FROM fab_item_categories WHERE company_id = ? AND name = ? AND deleted_at IS NULL LIMIT 1',
      [companyId, v.name],
    );
    let categoryId = catByCode?.id ?? catByName?.id ?? null;
    counts.categories++;

    if (!categoryId) {
      missing.categories++;
      if (apply) {
        const [r] = await conn.query(
          `INSERT INTO fab_item_categories (company_id, code, name, shortform, is_system, description)
           VALUES (?,?,?,?,0,?)`,
          [companyId, v.code, v.name, v.code, `${v.name} — structure template. The variant is the category.`],
        );
        categoryId = r.insertId;
        counts.created++;
        log(`+ category ${v.code} "${v.name}"`);
      }
    }

    // ── the level items ─────────────────────────────────────────────────
    // Deduped by code: `EP/D` is one catalog item that appears under two
    // assemblies, and creating it twice would collide on its unique name.
    const asms = v.assemblies ?? [];
    const levels = dedupeByCode([
      { ...v.span, levelKind: 'span', seg: null },
      { ...v.girder, levelKind: 'girder' },
      ...(v.segment ? [{ ...v.segment, levelKind: 'segment', seg: null }] : []),
      ...asms.map((a) => ({ code: a.code, name: a.name, levelKind: 'segment', seg: a.seg })),
      ...asms.flatMap((a) => a.parts).map((p) => ({ code: p.seg, name: p.name, levelKind: 'part', seg: p.seg })),
      ...v.parts.map((p) => ({ code: p.seg, name: p.name, levelKind: 'part', seg: p.seg })),
    ]);

    /** code -> id, for the BOM lines below. Null in a dry run. */
    const idByCode = new Map();

    for (const lv of levels) {
      const code = itemCode(v.code, lv.code);
      const flowId = flowIdByCode.get(flowCodeFor(lv.levelKind, lv.seg) ?? '') ?? null;
      counts.items++;

      const [[byCode]] = await conn.query(
        'SELECT id FROM fab_item_catalog WHERE company_id = ? AND code = ? AND deleted_at IS NULL LIMIT 1',
        [companyId, code],
      );
      const [[byName]] = byCode ? [[null]] : await conn.query(
        'SELECT id, code FROM fab_item_catalog WHERE company_id = ? AND name = ? AND deleted_at IS NULL LIMIT 1',
        [companyId, lv.name],
      );
      if (byName) {
        // Somebody else owns that name. Refuse rather than rename their row.
        throw new Error(
          `"${lv.name}" already exists as catalog item ${byName.code}; ${code} cannot take the name.`,
        );
      }

      const existingId = byCode?.id ?? null;
      if (!existingId) missing.items++;

      if (!apply) continue;

      if (existingId) {
        // flow_id only ever fills a NULL — never overwrite a choice someone made.
        await conn.query(
          `UPDATE fab_item_catalog
              SET name = ?, category_id = ?, unit = ?, procurement_type = 'make',
                  level_kind = ?, flow_id = COALESCE(flow_id, ?)
            WHERE id = ? AND company_id = ?`,
          [lv.name, categoryId, UNIT, lv.levelKind, flowId, existingId, companyId],
        );
        idByCode.set(lv.code, existingId);
      } else {
        const [r] = await conn.query(
          `INSERT INTO fab_item_catalog
             (company_id, code, name, category_id, unit, procurement_type, level_kind, flow_id, mrp_policy)
           VALUES (?,?,?,?,?, 'make', ?,?, 'lot_for_lot')`,
          [companyId, code, lv.name, categoryId, UNIT, lv.levelKind, flowId],
        );
        idByCode.set(lv.code, r.insertId);
        counts.created++;
      }
    }

    // ── the structure ───────────────────────────────────────────────────
    // The girder line always exists, even for PEB where its default is 0 — that
    // zero IS the PEB, and deleting the line instead would delete the parts too.
    const partParent = v.segment ? v.segment.code : v.girder.code;
    const spec = [
      {
        parentCode: v.span.code,
        childCode: v.girder.code,
        qtyParam: 'girders',
        defaultQty: v.girder.defaultQty,
        codeSegment: v.girder.seg,
        helpText: v.girder.help,
        sortOrder: 0,
      },
      ...(v.segment ? [{
        parentCode: v.girder.code,
        childCode: v.segment.code,
        qtyParam: 'segmentsPerGirder',
        defaultQty: v.segment.defaultQty,
        // An end girder is routinely cut differently, so each girder's count
        // can be overridden independently. This is the only per-instance line.
        perInstanceQty: 1,
        codeSegment: null,
        helpText: v.segment.help,
        sortOrder: 0,
      }] : []),
      // Named weldments under the girder level, and their own parts. Fixed
      // quantities, not parameters: two rafter halves and two columns is what a
      // portal frame IS, not a question to ask. Sorted before the loose parts,
      // which is why those start after them — with no assemblies the offset is
      // zero and the four bridge variants keep the sort orders they had.
      ...asms.map((a, i) => ({
        parentCode: v.girder.code,
        childCode: a.code,
        qtyNum: a.qty,
        codeSegment: a.seg,
        helpText: a.help ?? null,
        sortOrder: i + 1,
      })),
      ...asms.flatMap((a) => a.parts.map((p, i) => ({
        parentCode: a.code,
        childCode: p.seg,
        qtyNum: p.qty,
        codeSegment: p.seg,
        sortOrder: i + 1,
      }))),
      ...v.parts.map((p, i) => ({
        parentCode: partParent,
        childCode: p.seg,
        qtyNum: p.qty,
        codeSegment: p.seg,
        sortOrder: i + 1 + asms.length,
      })),
    ];
    counts.bomLines += spec.length;

    if (!apply) {
      // Count what is not there yet, by (parent, child) code pair.
      for (const s of spec) {
        const [[hit]] = await conn.query(
          `SELECT b.id FROM fab_item_bom b
             JOIN fab_item_catalog p ON p.id = b.parent_item_id
             JOIN fab_item_catalog c ON c.id = b.child_item_id
            WHERE b.company_id = ? AND b.deleted_at IS NULL AND b.active = 1
              AND p.code = ? AND c.code = ? LIMIT 1`,
          [companyId, itemCode(v.code, s.parentCode), itemCode(v.code, s.childCode)],
        );
        if (!hit) missing.bomLines++;
      }
      continue;
    }

    // Existing lines under any parent this variant owns, keyed parent:child.
    const parentIds = [...new Set(spec.map((s) => idByCode.get(s.parentCode)))].filter(Boolean);
    const [existingLines] = await conn.query(
      `SELECT id, parent_item_id, child_item_id FROM fab_item_bom
        WHERE company_id = ? AND parent_item_id IN (?) AND deleted_at IS NULL AND active = 1`,
      [companyId, parentIds],
    );
    const lineIdByPair = new Map(
      existingLines.map((l) => [`${l.parent_item_id}:${l.child_item_id}`, l.id]),
    );

    const kept = new Set();
    for (const s of spec) {
      const parentItemId = idByCode.get(s.parentCode);
      const childItemId = idByCode.get(s.childCode);
      const pair = `${parentItemId}:${childItemId}`;
      const id = lineIdByPair.get(pair) ?? null;
      kept.add(pair);
      if (!id) counts.created++;

      // setBomLine validates (exactly one of qty/param, no self-reference, no
      // cycle) and updates in place when given an id, so a re-run does not add
      // a second copy of every part to every segment.
      await setBomLine(companyId, {
        id,
        parentItemId,
        childItemId,
        qtyNum: s.qtyNum ?? null,
        qtyParam: s.qtyParam ?? null,
        defaultQty: s.defaultQty ?? null,
        perInstanceQty: s.perInstanceQty ?? 0,
        codeSegment: s.codeSegment ?? null,
        helpText: s.helpText ?? null,
        sortOrder: s.sortOrder ?? 0,
      }, conn);
    }

    // Anything under one of this variant's parents that the spec no longer
    // names is stale — a part removed from the design above. Retire it, so
    // editing the spec converges instead of accumulating.
    const stale = existingLines.filter((l) => !kept.has(`${l.parent_item_id}:${l.child_item_id}`));
    if (stale.length) {
      await conn.query(
        'UPDATE fab_item_bom SET deleted_at = NOW() WHERE id IN (?) AND company_id = ?',
        [stale.map((l) => l.id), companyId],
      );
      log(`${v.name}: retired ${stale.length} stale BOM line(s)`);
    }
  }

  if (!apply) {
    log(`would create ${missing.categories} categor(ies), ${missing.items} item(s), ${missing.bomLines} BOM line(s)`);
    counts.created = missing.categories + missing.items + missing.bomLines;
  }

  return counts;
}
