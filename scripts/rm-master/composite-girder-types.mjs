/**
 * composite-girder-types.mjs — the catalogue types a composite-girder bridge
 * needs, and which order-row code maps to which.
 *
 * EXTRACTED SO THERE IS ONE COPY. Two things consume this: the order builder,
 * which types each row as it inserts it, and the repair script, which types an
 * order built before anyone remembered to. Declared twice they would drift, and
 * the drift would be invisible — a part typed one way by the builder and
 * another by the repair reports no error, it just inherits different defaults.
 */

/** Flows already seeded for this family. Plain / drilled / assembly. */
export const FLOW = { plain: 120001, drilled: 120002, assembly: 120003 };

/**
 * The types a composite-girder bridge needs beyond a bare girder.
 *
 * Codes follow the family's own convention — `COMPOS-<abbr>`, with `-D` where
 * the part is drilled, which is also what routes it to the drilled flow.
 */
export const NEW_TYPES = [
  // the three cross-girder assemblies
  ['COMPOS-EDIA', 'End Diaphragm', 'segment', FLOW.assembly],
  ['COMPOS-IDIA', 'Intermediate Diaphragm', 'segment', FLOW.assembly],
  ['COMPOS-SPL', 'Splice', 'segment', FLOW.assembly],
  // end diaphragm
  ['COMPOS-EDTF', 'End Diaphragm Top Flange', 'part', FLOW.plain],
  ['COMPOS-EDW', 'End Diaphragm Web', 'part', FLOW.plain],
  ['COMPOS-EDBF', 'End Diaphragm Bottom Flange', 'part', FLOW.plain],
  ['COMPOS-JS-D', 'End Diaphragm Joint Stiffener', 'part', FLOW.drilled],
  ['COMPOS-PP-D', 'End Diaphragm Packing Plate', 'part', FLOW.drilled],
  // intermediate diaphragm
  ['COMPOS-IDTF', 'Interm Diaphragm Top Flange', 'part', FLOW.plain],
  ['COMPOS-IDW', 'Interm Diaphragm Web', 'part', FLOW.plain],
  ['COMPOS-IDDW', 'Interm Diaphragm Diagonal Web', 'part', FLOW.plain],
  ['COMPOS-IDBF', 'Interm Diaphragm Bottom Flange', 'part', FLOW.plain],
  ['COMPOS-ISP', 'Interm Diaphragm Side Plate', 'part', FLOW.plain],
  ['COMPOS-IFP', 'Interm Diaphragm Fill Plate', 'part', FLOW.plain],
  ['COMPOS-ICP', 'Interm Diaphragm Corner Plate', 'part', FLOW.plain],
  // splice
  ['COMPOS-WCP-D', 'Web Cover Plate', 'part', FLOW.drilled],
  ['COMPOS-TFICP-D', 'Top Flange Inner Cover Plate', 'part', FLOW.drilled],
  ['COMPOS-TFOCP-D', 'Top Flange Outer Cover Plate', 'part', FLOW.drilled],
  ['COMPOS-BFOCP-D', 'Bottom Flange Outer Cover Plate', 'part', FLOW.drilled],
  ['COMPOS-BFICP-D', 'Bottom Flange Inner Cover Plate', 'part', FLOW.drilled],
];

/**
 * Order-row code suffix -> catalogue code. DECLARED, never guessed.
 *
 * The suffix is the last dash-separated piece of the row's code, which is what
 * the drawing calls the part: `KEPL-ROB60-SPAN1/G1/S1-IS1/D` -> `IS1/D`.
 */
export const PART_TYPE = {
  TF: 'COMPOS-TF',
  W: 'COMPOS-WP',
  BF: 'COMPOS-BF',
  'BS/D': 'COMPOS-BS-D',
  // An end stiffener is a plain stiffener at the bearing; the family's plain
  // bearing-stiffener type is exactly that thing.
  ES: 'COMPOS-BS',
  'IS1/D': 'COMPOS-IS-D',
  IS2: 'COMPOS-IS',
  EDTF: 'COMPOS-EDTF',
  EDW: 'COMPOS-EDW',
  EDBF: 'COMPOS-EDBF',
  'JS/D': 'COMPOS-JS-D',
  'PP/D': 'COMPOS-PP-D',
  IDTF: 'COMPOS-IDTF',
  IDW: 'COMPOS-IDW',
  IDDW: 'COMPOS-IDDW',
  IDBF: 'COMPOS-IDBF',
  ISP: 'COMPOS-ISP',
  IFP: 'COMPOS-IFP',
  ICP: 'COMPOS-ICP',
  'WCP/D': 'COMPOS-WCP-D',
  'TFICP/D': 'COMPOS-TFICP-D',
  'TFOCP/D': 'COMPOS-TFOCP-D',
  'BFOCP/D': 'COMPOS-BFOCP-D',
  'BFICP/D': 'COMPOS-BFICP-D',
};

/** Assemblies and the tree above them, matched on the shape of the suffix. */
export function structureType(levelKind, suffix) {
  if (levelKind === 'span') return 'COMPOS-SPAN';
  if (levelKind === 'girder') return 'COMPOS-GDR';
  if (levelKind === 'segment') {
    // A girder segment's suffix carries its position — SPAN1/G1/S1. An assembly's
    // is a tag — ED01, ID07, SPL14. Different things, different types.
    if (/\/S\d+$/.test(suffix)) return 'COMPOS-SEG';
    if (/^ED\d+$/.test(suffix)) return 'COMPOS-EDIA';
    if (/^ID\d+$/.test(suffix)) return 'COMPOS-IDIA';
    if (/^SPL\d+$/.test(suffix)) return 'COMPOS-SPL';
    return null;
  }
  if (levelKind === 'part') {
    // A stud is bought, not made — its type is the fastener itself, resolved by
    // the material it is already linked to rather than invented here.
    if (suffix === 'STUD') return null;
    return PART_TYPE[suffix] ?? null;
  }
  return null;
}

