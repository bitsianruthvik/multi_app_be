/**
 * standardImport.js — turns a ready-made standard's bom.json (TM/drawing_bom/out/<SET>/bom.json, format
 * `rdso-standard-drawing-bom/1`, TM/drawing_bom/out/IMPORT_FORMAT.md) into a PLAN: the tree mapped onto the
 * tenant's EXISTING definitions, the values each row holds, the part files, the notes a person must see.
 * Pure: no database. standardDrawingService.importStandard writes the plan; the script prints it.
 *
 * PART NAMES (user, 2026-10-17: reuse the names that exist). Each part and assembly is mapped by its ROLE to an
 * ordered list of definition names; the first one the catalog has wins. Names are compared loosely (case,
 * punctuation, "Inter." / "Diaph." / "center", plurals, "Hole" = "(holed)"), so an older catalog that still says
 * "Bearing Stiffener Plain" matches "Bearing stiffener (plain)". Only when no name fits is a NEW definition planned,
 * and the plan lists it (`newDefinitions`).
 *
 * BOUGHT items (bearings, holding-down bolts, HSFG bolts) are not made, so they are not rows: the plan lists them
 * (`bought`) and the standard's notes carry them.
 */

const r3 = (n) => Math.round(Number(n) * 1000) / 1000;

/** A name as the comparison sees it. */
export function normName(s) {
  let t = ` ${String(s ?? '').toLowerCase()} `;
  t = t.replace(/\binter\.\s*/g, 'intermediate ').replace(/\bdiaph\.\s*/g, 'diaphragm ').replace(/\blong\.\s*/g, 'longitudinal ');
  t = t.replace(/\bg\s*&\s*a\b/g, 'girder arch').replace(/\bed\b/g, 'end diaphragm').replace(/\bid\b/g, 'intermediate diaphragm');
  t = t.replace(/\bcenter\b/g, 'centre').replace(/\bdigonal\b/g, 'diagonal').replace(/\bstiffner/g, 'stiffener');
  t = t.replace(/[()&/.,_\-–—']+/g, ' ');
  t = t.replace(/\bhole\b/g, 'holed');
  const singular = { frames: 'frame', plates: 'plate', stiffeners: 'stiffener', bracings: 'bracing', cleats: 'cleat', supports: 'support', brackets: 'bracket', splices: 'splice', angles: 'angle' };
  return t.split(/\s+/).filter(Boolean).map((w) => singular[w] ?? w).join(' ');
}

/**
 * A definition name is a SHORT generic part name (sizes and notes belong in values and notes): brackets, anything
 * after ":" ";" or " - ", a "for … / at … / under … / on … / per …" clause, section designations, every token with a
 * digit and its unit are taken away; "a/b" keeps b; plurals become singular. Sentence case, like the catalog.
 *   "Jacking bracket plate 680x12x700" → "Jacking bracket plate"   "Spreader beam 2-ISMC 400 x 3640" → "Spreader beam"
 *   "Lifting station under one girder end" → "Lifting station"     "Spacer/spreader beam channel" → "Spreader beam channel"
 */
export function plainName(s) {
  // What follows a comma is a note, never the name (user, 2026-11-06: "Stringer, end bay", "Girder shoe, high tub",
  // "Hanger beam HB-4, two pieces, with its stiffeners and covers" made definitions of their own); so is "with its …",
  // "welded", "true shape", "ends cut".
  let t = ` ${String(s ?? '')} `.replace(/\([^)]*\)/g, ' ').replace(/[:;].*$/, ' ').replace(/\s-\s.*$/, ' ').replace(/,.*$/, ' ');
  t = t.replace(/\s(for|at|under|on|per|in|to|from|with|between|joins)\s.*$/i, ' ');
  t = t.replace(/\b(welded|true\s+shape|ends?\s+cut|two\s+pieces)\b/gi, ' ');
  t = t.replace(/\b(ISMC|ISLC|ISMB|ISJB|ISA|ISHB|ISMB|L)\b(?=\s*\d)/gi, ' ');
  t = t.replace(/\S*\d\S*(\s*(mm|m|thk|thick|th|dia|long|lg)\b\.?)?/gi, ' ');
  t = t.replace(/\b(\w+)\/(\w+)\b/g, '$2').replace(/\s[x×*]\s/gi, ' ').replace(/[,./\s-]+$/g, ' ');
  const singular = { plates: 'plate', stiffeners: 'stiffener', angles: 'angle', beams: 'beam', channels: 'channel', strips: 'strip', bolts: 'bolt', brackets: 'bracket', gussets: 'gusset', stations: 'station' };
  const words = t.split(/\s+/).filter(Boolean).map((w) => singular[w.toLowerCase()] ?? w);
  return sentence(words.join(' ')) || sentence(String(s ?? '').replace(/\([^)]*\)/g, ' ')) || 'Part';
}

/** "TOP FLANGE OUTER COVER PLATE" → "Top flange outer cover plate". */
export function sentence(s) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : t;
}

const BOUGHT_ROLES = new Set(['bolt', 'bearing_elastomeric', 'bearing_guide', 'holding_down_bolt']);

/**
 * A bolt as the BOM names it: { dia, length, grade } (any of them null). Reads "M24 x 95", "M22", "HSFG BOLT 22 MM DIA
 * PROPERTY CLASS 8.8", "class 10.9" from the item's profile, description and material. Pure.
 */
export function boltWanted(it) {
  const s = `${it?.profile ?? ''} ${it?.description ?? ''} ${it?.material ?? ''}`;
  const m = /\bM\s?(\d{2})(?:\s*[x×]\s*(\d{2,3}))?/i.exec(s) ?? /\b(\d{2})\s*MM\s*DIA/i.exec(s);
  const len = /\bM\s?\d{2}\s*[x×]\s*(\d{2,3})/i.exec(s)?.[1] ?? (Number(it?.lengthMm) > 0 ? String(it.lengthMm) : null);
  const g = /(?:class|grade)\s*(\d{1,2}\.\d)/i.exec(s)?.[1] ?? null;
  return { dia: m ? Number(m[1]) : null, length: len ? Number(len) : null, grade: g };
}
/** A catalog bolt set's name ("HSFG bolt set M24 x 95, class 10.9 (bolt + nut + 2 washers)") → { dia, length, grade } | null. */
export function boltOf(name) {
  const m = /\bM(\d{2})\s*x\s*(\d{2,3})\b/i.exec(String(name ?? ''));
  if (!m) return null;
  return { dia: Number(m[1]), length: Number(m[2]), grade: /class\s*(\d{1,2}\.\d)/i.exec(String(name))?.[1] ?? null };
}

/** The definition names a part may take, best first — by its role (IMPORT_FORMAT.md `items[].role`). */
export function partCandidates(item, place = {}) {
  const holed = Number(item?.holes?.count ?? 0) > 0;
  const stiffener = (word) => (holed ? [`${word} stiffener (holed)`, `${word} stiffener`] : [`${word} stiffener (plain)`, `${word} stiffener`]);
  const desc = String(item?.description ?? '').toUpperCase();
  switch (item?.role) {
    case 'top_flange': return ['Top flange'];
    case 'bottom_flange': return ['Bottom flange'];
    case 'web': return ['Web plate', 'Web'];
    case 'intermediate_stiffener': return stiffener('Intermediate');
    // Older sets call the stiffener at the bearing an END STIFFENER — the catalog has that name too.
    case 'bearing_stiffener': return /END\s+STIFFENER/.test(desc) ? [...stiffener('End'), ...stiffener('Bearing')] : stiffener('Bearing');
    case 'diaphragm_bearing_stiffener': return stiffener('Bearing');
    case 'lifting_stiffener': return ['Lifting stiffener'];
    case 'jacking_stiffener': return ['Jacking stiffener'];
    case 'diaphragm_top_flange': return place.endDiaphragm ? ['Diaphragm top flange', 'End diaphragm top flange'] : ['Diaphragm top flange', 'Intermediate diaphragm top flange'];
    case 'diaphragm_bottom_flange': return place.endDiaphragm ? ['Diaphragm bottom flange', 'End diaphragm bottom flange'] : ['Diaphragm bottom flange', 'Intermediate diaphragm bottom flange'];
    // The End diaphragm template's own web is "Intermediate diaphragm web" (the catalog's convention, and the user's list).
    case 'diaphragm_web': return ['Intermediate diaphragm web', 'End diaphragm web', 'Diaphragm web'];
    // One gusset of its frame, without holes, where the diagonals cross: the centre gusset.
    case 'gusset':
      if (/CENTRAL|CENTRE|CENTER/.test(desc)) return ['Centre gusset', 'Gusset plate'];
      if (/CORNER\s+TOP|TOP\s+CORNER/.test(desc)) return ['Top gusset', 'Gusset plate'];
      if (/CORNER\s+BOTTOM|BOTTOM\s+CORNER/.test(desc)) return ['Bottom gusset', 'Gusset plate'];
      return place.single && !holed ? ['Centre gusset', 'Gusset plate'] : ['Gusset plate'];
    // Older sets (riveted and early welded spans, rocker / sliding bearings):
    case 'shear_connector_channel': return ['Channel shear connector'];
    case 'bearing_sole_plate': return [plainName(item?.description ?? 'Bearing plate')];
    case 'bed_plate': return ['Bed plate'];
    case 'bearing_sliding_plate': return /PHOSPHOR/.test(desc) ? ['Phosphor bronze plate'] : ['Sliding plate'];
    case 'bearing_location_strip': return ['Location strip'];
    case 'bearing_top_plate': return ['Bearing top plate'];
    case 'bearing_bottom_plate': return ['Bearing bottom plate'];
    case 'bearing_stopper': return ['Bearing stopper'];
    case 'channel': return [plainName(item?.description ?? 'Channel')];
    case 'top_flange_cover_outer': return ['Top flange outer cover plate', 'Cover plate'];
    case 'top_flange_cover_inner': return ['Top flange inner cover plate', 'Cover plate'];
    case 'bottom_flange_cover_outer': return ['Bottom flange outer cover plate', 'Cover plate'];
    case 'bottom_flange_cover_inner': return ['Bottom flange inner cover plate', 'Cover plate'];
    case 'web_cover_plate': return ['Web cover plate', 'Cover plate'];
    case 'restrainer_plate': return ['Restrainer plate'];
    // User, 2026-10-17: the restrainer's stiffeners are the catalog's Stiffener plate (SFP).
    case 'restrainer_stiffener': return ['Stiffener plate', 'Restrainer stiffener plate'];
    // User, 2026-10-17: a jacking bracket's PLATE is the catalog's Bracket plate (BKT); its seat plate keeps its own name.
    case 'jacking_bracket':
      if (/BRACKET\s+PLATE/.test(desc)) return ['Bracket plate', 'Jacking bracket plate'];
      return [plainName(item?.description ?? 'Jacking bracket part')];
    // Truss parts (2026-10-31, the 75 m Thane truss): the catalog's girder splice names, and short generic names.
    case 'web_splice': return ['Web splice'];
    case 'top_outer_splice': return ['Top outer splice'];
    case 'top_inner_splice': return ['Top inner splice'];
    case 'bottom_outer_splice': return ['Bottom outer splice'];
    case 'bottom_inner_splice': return ['Bottom inner splice'];
    case 'flange_cover_plate': return ['Flange cover plate'];
    case 'connection_plate': return ['Connection plate'];
    case 'spade_plate': return ['Spade plate'];
    case 'access_hole_cover_plate': return ['Access hole cover plate'];
    case 'jacking_plate': return ['Jacking plate'];
    case 'diaphragm_plate': return ['Diaphragm plate'];
    case 'bracket_plate': return ['Bracket plate'];
    // A stiffener plate whose description is a catalog name ("Inside support", "Box closing plate") takes that name.
    case 'stiffener_plate': { const own = plainName(item?.description ?? ''); return place.has?.(own) && normName(own) !== 'stiffener plate' ? [own, 'Stiffener plate'] : ['Stiffener plate']; }
    // User, 2026-11-06 (definition audit): a splice plate by its place — the catalog's girder / arch splice plates by
    // face, the bow string's own splice plate on a bow string, a web's splice; "Splice plate" (obsolete) last.
    case 'splice_plate': {
      const out = [];
      if (/\bWEB\b/.test(desc)) out.push('Web splice');
      const face = /\bTOP\b/.test(desc) ? 'top' : /\bBOTTOM\b/.test(desc) ? 'bottom' : /\bSIDE\b/.test(desc) ? 'side' : null;
      const at = /\bARCH\b/.test(desc) ? 'Arch' : /\b(BLB|BOTTOM\s+LONG|LONGITUDINAL|GIRDER)\b/.test(desc) ? 'Girder' : null;
      if (at && face) out.push(`${at} ${face} splice plate`);
      if (place.bowstring) out.push('Bow string splice plate');
      return [...out, 'Splice plate'];
    }
    case 'cleat_plate':
      if (/TIE\s+BEAM\s+(BRACKET|CLEAT)/.test(desc)) return ['Top tie beam cleat', 'Bracket plate'];
      return ['Bracket plate', 'Cleat plate'];
    case 'top_packing_splice': case 'bottom_packing_splice': case 'packing_splice': return ['Packing plate'];
    case 'bottom_lateral_bracing_member': return ['Bottom lateral bracing member'];
    case 'top_lateral_bracing_member': return ['Top lateral bracing member'];
    case 'pad_plate': return ['Pad plate'];
    case 'packing_plate': return ['Packing plate'];
    case 'shear_stud': return ['Shear stud'];
    case 'bolt': return ['Bolt set'];
    case 'angle':
      // "BLB angle" is the bottom lateral bracing's angle on a girder span (on a bow string BLB is the bottom long beam).
      if (/LATERAL\s+BRAC/.test(desc) || (!place.bowstring && /\bBLB\b/.test(desc))) return ['Bottom lateral bracing member', 'Bottom bracings lateral', 'Bracing'];
      if (/CROSS\s+BEAM/.test(desc) && /\bANGLE\b|\bCLEAT\b/.test(desc)) return ['Intermediate cross beam angle cleat', 'Angle cleat'];
      if (/DIAGONAL|DIGONAL/.test(desc)) return ['X-frame diagonal angle'];
      if (/TOP\s*\/\s*BOTTOM/.test(desc)) return ['X-frame top angle'];
      if (/\bTOP\b/.test(desc)) return ['X-frame top angle'];
      if (/\bBOTTOM\b/.test(desc)) return ['X-frame bottom angle'];
      // A lifting-beam angle stiffener: the extractor calls the plate ones jacking stiffeners.
      if (/STIFFENER/.test(desc)) return ['Jacking stiffener'];
      // An "L cleat" is the catalog's angle cleat (before "bracing": "L CLEAT FOR TEMPORARY BRACING" is still a cleat).
      if (/\bCLEAT/.test(desc)) return ['Angle cleat', 'Angle cleats'];
      // User, 2026-10-17: a jacking bracket's angle is an Angle cleat (ACL).
      if (/BRACKET/.test(desc)) return ['Angle cleat', 'Angle cleats'];
      if (/BRACING|BRACE\b/.test(desc)) return ['Bracing'];
      // Any other angle (a jacking-bracket angle, an X-frame horizontal): its own short name, never "Bracing".
      return [plainName(item?.description ?? 'Angle')];
    // A role the list above does not know: a role of two words or more IS the generic name ("batten_plate" →
    // "Batten plate", "lifting_plate" → "Lifting plate"); else the description, cleaned.
    default: {
      const words = String(item?.role ?? '').split('_').filter(Boolean);
      const fromDesc = plainName(item?.description ?? item?.mark ?? 'Part');
      const fromRole = sentence(words.join(' '));
      // The description says more when it starts with the role ("Jacking bracket SEAT PLATE" under jacking_bracket).
      if (words.length >= 2) return [normName(fromDesc).startsWith(normName(fromRole)) ? fromDesc : fromRole];
      return [fromDesc];
    }
  }
}

/** The definition names an assembly node may take (IMPORT_FORMAT.md `assembly` kinds). */
export function nodeCandidates(node, items = null) {
  const name = String(node?.name ?? '').toUpperCase();
  // A group holding ONE kind of part and nothing else ("Lifting plates for the 30.5 m span: …") is a set of that part.
  const kids = node?.children ?? [];
  const setOf = () => (items && kids.length === 1 && kids[0].item != null && items.get(kids[0].item) ? `${partCandidates(items.get(kids[0].item))[0]} set` : null);
  switch (node?.kind) {
    // A launching / lifting tackle is not a bridge span: it gets its own name.
    // A truss span is its own kind of span (user, 2026-10-31: a 75 m through truss), never the girder span.
    case 'span': return /LAUNCH|TACKLE|LIFTING\s+ARRANGEMENT/.test(name) ? [plainName(nodeTitle(name))] : /\bTRUSS\b/.test(name) ? ['Steel truss span'] : ['Bridge span'];
    case 'girder': return ['Girder line'];
    case 'girder_segment': return ['Girder segment'];
    case 'splice_set': return ['Splice set'];
    case 'assembly':
      // Bow string (the catalog's 2026-10-07 set) and tub girder (Khajaguda, 2026-11-02) assemblies by the catalog's names
      // (user, 2026-11-06: fit what exists; a drawing's title is not a definition name).
      if (/BOTTOM\s+LONG(ITUDINAL)?\s+BEAM/.test(name)) return ['Bottom longitudinal beam'];
      if (/\bARCH\s+(BEAM|BOX)\b/.test(name)) return ['Arch box'];
      if (/HANGER\s+BEAM/.test(name)) return ['Hanger beam'];
      if (/INTERMEDIATE\s+(BOTTOM\s+)?CROSS\s+BEAM/.test(name)) return ['Intermediate cross beam'];
      if (/\bEND\s+(BOTTOM\s+)?CROSS\s+BEAM|BOTTOM\s+END\s+CROSS\s+BEAM/.test(name)) return ['Bottom end cross beam'];
      if (/TOP\s+TIE\s+DIAGONAL/.test(name)) return ['Top tie diagonal'];
      if (/TOP\s+TIE\s+(CHORD\s+)?BEAM/.test(name)) return ['Top tie beam'];
      if (/GIRDER\s+(AND|&)\s+ARCH\s+CONNECTION/.test(name)) return ['Girder and arch connection'];
      if (/SEISMIC\s+(ARRESTOR|ARRESTER|STOPPER)/.test(name)) return ['Seismic stopper'];
      if (/GIRDER\s+SHOE/.test(name)) return ['Girder shoe'];
      if (/CONNECTING\s+GIRDER/.test(name)) return ['Connecting girder between the tubs', 'Connecting girder'];
      if (/INTERNAL\s+CROSS\s+GIRDER/.test(name)) return ['Internal cross girder'];
      if (/CROSS\s+GIRDER\s+PLATE/.test(name)) return ['Cross girder plate'];
      if (/PLAN\s+BRACING/.test(name)) return ['Plan bracing panel'];
      if (/DIAPHRAGM\s+IN\s+THE\s+TUB/.test(name)) return ['Diaphragm'];
      if (/END\s+(CROSS\s+GIRDER\s+)?DIAPHRAGM/.test(name)) return ['End diaphragm'];
      if (/INTERMEDIATE\s+CROSS\s+GIRDER\s+DIAPHRAGM/.test(name)) return ['Intermediate diaphragm'];
      if (/END\s+DIAPHRAGM/.test(name)) return ['End diaphragm'];
      if (/END\s+X-?\s*FRAME/.test(name)) return ['End diaphragm frame', 'End diaphragm'];
      if (/X-?\s*FRAME|INTERMEDIATE\s+DIAPHRAGM|CROSS\s+FRAME/.test(name)) return ['Intermediate diaphragm frame', 'Intermediate diaphragm'];
      if (/LATERAL\s+BRAC/.test(name)) return ['Bottom lateral bracing', 'Bracing'];
      if (/BED\s+PLATE|BEARING/.test(name)) return ['Bearing assembly'];
      return [setOf() ?? plainName(nodeTitle(name))];
    case 'loose':
      if (/BRAC/.test(name)) return ['Bottom lateral bracing', 'Bracing'];
      return ['Loose items'];
    default: return [plainName(nodeTitle(name)) || 'Assembly'];
  }
}

/** "GA/GIRDER COMPLETE 7925*750" → "GIRDER COMPLETE 7925*750": the words after a leading mark. */
function nodeTitle(name) { return String(name ?? '').replace(/^[A-Z][A-Z0-9-]{0,11}\s*\//, ''); }

/** "GA/GIRDER COMPLETE" → "GA"; a node without a mark → null. */
export const nodeMark = (node) => {
  const m = /^([A-Z][A-Z0-9-]{0,11})\s*\//.exec(String(node?.name ?? '').trim());
  return m ? m[1] : null;
};

/**
 * The note a person must see on a row (user: "parts flagged drill on assembly or needs decision must carry that
 * note"): the DRILL ON ASSEMBLY notes, any other drilling caution, and any decision on the part not yet decided.
 */
export function rowNote(item, decisions = []) {
  const out = [];
  const status = String(item?.status ?? 'ok').toLowerCase();
  const notes = (item?.notes ?? []).map(String);
  if (status === 'drill on assembly') {
    const drill = notes.filter((n) => /drill on assembly/i.test(n));
    out.push(...(drill.length ? drill : ['DRILL ON ASSEMBLY — see the drawing.']));
  }
  for (const n of notes) if (/drill/i.test(n) && !out.includes(n)) out.push(n);
  const byId = new Map((decisions ?? []).map((d) => [d.id, d]));
  const open = (item?.decisions ?? []).map((id) => byId.get(id)).filter((d) => d && String(d.status ?? '').toLowerCase() !== 'decided');
  for (const d of open) out.push(`NEEDS DECISION ${d.id}: ${d.what}`);
  if (status === 'needs decision' && !open.length) out.push('NEEDS DECISION — see the drawing.');
  return out.length ? out.join(' · ').slice(0, 2000) : null;
}

/** Sentence-cased role text for a BOM line: "Top flange", "GA girder complete". */
const roleText = (s) => sentence(String(s ?? '').replace(/\//g, ' ')).slice(0, 100);

/**
 * Names that mean a catalog definition (user, 2026-11-06, the definition audit: the 11-05 imports made 19 definitions that
 * repeat one the catalog had). Tried after an exact name: { re } on the normalised name, { to } the catalog's names,
 * first one there wins (and only in the same family of classes as the row: a plate never lands on an assembly).
 * Not here on purpose — the engineer's calls: End cross girder / Bottom end cross beam, Bottom cross girder / Intermediate
 * cross beam, Flange cover plate / the splices, Connection plate / Gusset plate, Jacking plate / Pad plate, Plan bracing panel.
 */
export const SYNONYMS = [
  { re: /\bend cross girder diaphragm\b/, to: ['End diaphragm'] },
  { re: /\bintermediate cross girder diaphragm\b/, to: ['Intermediate diaphragm'] },
  { re: /\bsplice plate web\b|\bweb splice plate\b/, to: ['Web splice'] },
  { re: /\bpacking splice\b|\binner packing\b/, to: ['Packing plate'] },
  { re: /\bseismic arrest[oe]r\b/, to: ['Seismic stopper'] },
  { re: /\bblb angle\b/, to: ['Bottom lateral bracing member'] },
  { re: /\bbottom long beam\b/, to: ['Bottom longitudinal beam'] },
  { re: /\barch beam\b/, to: ['Arch box'] },
  { re: /\bintermediate bottom cross beam\b/, to: ['Intermediate cross beam'] },
  { re: /\bend bottom cross beam\b/, to: ['Bottom end cross beam'] },
  { re: /\btop tie chord beam\b/, to: ['Top tie beam'] },
  { re: /\bcleat plate\b/, to: ['Bracket plate'] },
  { re: /\bcross beam end angle\b/, to: ['Intermediate cross beam angle cleat', 'Angle cleat'] },
  { re: /\bgirder shoe\b/, to: ['Girder shoe'] },
];

const STOPWORDS = new Set(['the', 'a', 'an', 'of', 'and', 'with', 'its', 'in', 'on', 'at', 'to', 'for', 'by']);
/** Words most definition names share: a likeness on these alone does not say two parts are the same kind. */
const GENERIC_WORDS = new Set(['plate', 'beam', 'girder', 'set', 'top', 'bottom', 'end', 'side', 'inner', 'outer', 'inside', 'outside', 'piece', 'member', 'assembly', 'part', 'cross', 'intermediate', 'left', 'right', 'cover', 'stiffener', 'splice']);
const wordsOf = (s) => normName(s).split(' ').filter((w) => w && !STOPWORDS.has(w));
/** How alike two names are: the share of words they have in common (Jaccard), and whether one's words are all in the other. */
export function likeness(a, b) {
  const A = new Set(wordsOf(a)); const B = new Set(wordsOf(b));
  if (!A.size || !B.size) return { j: 0, subset: false, shared: [] };
  const shared = [...A].filter((w) => B.has(w));
  const [s, l] = A.size <= B.size ? [A, B] : [B, A];
  return { j: shared.length / new Set([...A, ...B]).size, subset: [...s].every((w) => l.has(w)), shared };
}

/** The family of a definition: its class's parent (Parts, Assemblies, Structures …), from catalog.classes when given. */
function familyTools(catalog) {
  const parent = new Map((catalog.classes ?? []).map((c) => [Number(c.id), c.parent_id == null ? null : Number(c.parent_id)]));
  const familyOf = (classId) => (parent.size ? parent.get(Number(classId)) ?? null : null);
  const classOfName = (names) => {
    for (const n of names) { const d = (catalog.defs ?? []).find((x) => x.status === 'active' && normName(x.name) === normName(n)); if (d) return Number(d.classification_id); }
    return null;
  };
  const anchor = {
    plate: classOfName(['Top flange', 'Web plate', 'Pad plate']),
    profile: classOfName(['Bracing', 'X-frame top angle', 'Bottom lateral bracing member']),
    assembly: classOfName(['Girder segment', 'End diaphragm', 'Splice set']),
    structure: classOfName(['Composite girder span', 'Bridge span', 'Girder line']),
  };
  /** The family a row of this kind belongs to (null: not known, so no family test). */
  const familyFor = (hint) => (anchor[hint] != null ? familyOf(anchor[hint]) : null);
  return { familyOf, familyFor, anchor };
}

/**
 * THE PLAN. `catalog`:
 *   defs        [{ id, code, name, short_name, definition_type, status, classification_id, default_flow_id, bom_id }]
 *   specs       Map(CODE -> { id, data_type, default_uom })
 *   gradeOption Map(UPPER value or label -> option id)
 *   studs       [{ id, code, name }] — the Shear stud selection's catalog candidates
 * Returns { standard, rows, files, bought, newDefinitions, mappings, problems, totals }.
 *   rows   [{ key, parentKey, kind: 'temp' | 'selection', depth, lineNo, position, role, quantity, notes, mark,
 *             def: { id, name, code } | { new: name }, classHint, values: [{ code, ... }], item, node, weightKg }]
 */
export function planImport(bom, catalog) {
  const problems = [];
  if (bom?.schema !== 'rdso-standard-drawing-bom/1') problems.push(`bom.json says schema ${bom?.schema ?? '(none)'} — this importer reads rdso-standard-drawing-bom/1.`);
  const dw = bom?.drawing ?? {};
  // Two DIFFERENT items under one mark (BP = batten plates 200 / 300 / 400; LP = a lifting plate per span) would share a
  // drawing mark and so one drawing file: each takes its own id (BP200, LP-30.5) as its mark instead.
  const markCount = new Map();
  for (const it of bom?.items ?? []) if (it.mark) markCount.set(it.mark, (markCount.get(it.mark) ?? 0) + 1);
  const items = new Map((bom?.items ?? []).map((it) => [it.id, it.mark && markCount.get(it.mark) > 1 && it.id ? { ...it, mark: it.id } : it]));
  const density = Number(bom?.material?.densityKgM3) || 7850;
  const defsByNorm = new Map();
  for (const d of catalog.defs ?? []) {
    if (d.status !== 'active') continue;
    const k = normName(d.name);
    if (!defsByNorm.has(k)) defsByNorm.set(k, []);
    defsByNorm.get(k).push(d);
  }
  const fam = familyTools(catalog);
  const active = (catalog.defs ?? []).filter((d) => d.status === 'active');
  const inFamily = (d, hint) => { const f = fam.familyFor(hint); return f == null || fam.familyOf(d.classification_id) === f; };
  const exact = (n, type) => (defsByNorm.get(normName(n)) ?? []).find((d) => d.definition_type === type) ?? null;
  /**
   * The definition a row takes (user, 2026-11-06: reuse what the catalog has; a new one only where nothing fits), tried
   * in this order: 1 a name exactly; 2 an OBSOLETE definition of that name → its successor (an active one in the same
   * class whose name holds every word of it, told apart by the row's own words); 3 a synonym (SYNONYMS); 4 a name
   * alike within the row's family (every word of the shorter in the longer, and most words shared).
   * → { def, asked, how: 'exact' | 'successor' | 'synonym' | 'similar', note? } | null
   */
  const pick = (names, type, { hint = null, hints = [] } = {}) => {
    for (const n of names) { const d = exact(n, type); if (d) return { def: d, asked: n, how: 'exact' }; }
    const rowWords = new Set(hints.flatMap(wordsOf));
    for (const n of names) {
      const old = (catalog.defs ?? []).find((d) => d.status === 'obsolete' && d.definition_type === type && normName(d.name) === normName(n));
      if (!old) continue;
      const ow = wordsOf(old.name);
      const next = active.filter((d) => d.definition_type === type && Number(d.classification_id) === Number(old.classification_id) && d.id !== old.id && ow.every((w) => wordsOf(d.name).includes(w)));
      if (!next.length) continue;
      // The row's own words must point at one successor ("web" → Web cover plate), never a lone successor by default.
      const scored = next.map((d) => ({ d, s: wordsOf(d.name).filter((w) => !ow.includes(w) && rowWords.has(w)).length })).sort((a, b) => b.s - a.s);
      if (scored[0].s > 0 && (scored.length === 1 || scored[0].s > scored[1].s)) return { def: scored[0].d, asked: n, how: 'successor', note: `${old.name} is obsolete` };
    }
    for (const n of names) {
      const k = normName(n);
      for (const rule of SYNONYMS) {
        if (!rule.re.test(k)) continue;
        for (const t of rule.to) { const d = exact(t, type); if (d && inFamily(d, hint)) return { def: d, asked: n, how: 'synonym' }; }
      }
    }
    if (hint) {
      for (const n of names) {
        const best = active.filter((d) => d.definition_type === type && inFamily(d, hint)).map((d) => ({ d, l: likeness(n, d.name) }))
          .filter((x) => x.l.subset && x.l.j >= 0.67).sort((a, b) => b.l.j - a.l.j);
        if (best.length && (best.length === 1 || best[0].l.j > best[1].l.j)) return { def: best[0].d, asked: n, how: 'similar', note: `words ${best[0].l.shared.join(', ')}` };
      }
    }
    return null;
  };
  /**
   * The nearest existing definition to a name nothing fits — proposed in the dry run, and (for an assembly) where a new
   * one is filed. A word every kind shares ("beam", "plate", "girder") says little: a name sharing a word of its own
   * ("hanger", "tie") comes first. `telling` says whether it does.
   */
  const nearestTo = (name, type, hint) => {
    const scored = active.filter((d) => d.definition_type === type).map((d) => {
      const l = likeness(name, d.name);
      const telling = l.shared.some((w) => !GENERIC_WORDS.has(w));
      return { d, l, telling, s: l.j + (inFamily(d, hint) ? 0.15 : 0) + (telling ? 0.25 : 0) };
    }).filter((x) => x.l.shared.length).sort((a, b) => b.s - a.s || (a.d.bom_id ? -1 : 1));
    const b = scored[0];
    return b ? { id: b.d.id, code: b.d.code, name: b.d.name, classification_id: b.d.classification_id, score: Math.round(b.l.j * 100) / 100, telling: b.telling, why: `words ${b.l.shared.join(', ')}` } : null;
  };
  // A bow string span: its splice plates are the catalog's bow string ones; "BLB" is its bottom long beam.
  const bowstring = /BOW\s*STRING|BOWSTRING|\bARCH\b/i.test(`${dw.title ?? ''} ${bom?.assembly?.name ?? ''}`);
  const has = (n) => !!(defsByNorm.get(normName(n)) ?? []).length;
  const newDefs = new Map();   // name -> { name, classHint, roles }
  const mappings = [];
  const rows = [];
  const bought = [];
  const files = new Map();     // mark -> { mark, file, item }
  let seq = 0;

  const spec = (code) => catalog.specs?.get(code) ?? null;
  const num = (code, v) => (v == null || !Number.isFinite(Number(v)) || !spec(code) ? null : { code, number: r3(v), uom: spec(code).default_uom ?? null });
  const txt = (code, v) => (v == null || v === '' || !spec(code) ? null : { code, text: String(v).slice(0, 255) });
  const gradeMisses = new Map();   // the grade as written -> rows left without one (said once, below)
  /** What each set's grades became, row by row — the summary prints it. */
  const gradeMap = { asWritten: 0, eNamed: 0, legacyE250: 0, impactBR: 0, impactA: 0, legacyNoClass: 0, bronze: 0, missed: 0 };
  /** An option value as a row value: its id when the option exists, else the value to find once the setup made it. */
  const optionValue = (code, value, display = value) => {
    if (!spec(code)) return null;
    const map = code === 'GRADE' ? catalog.gradeOption : code === 'IMPACT_CLASS' ? catalog.impactOption : catalog.materialOption;
    return { code, optionId: map?.get(String(value).toUpperCase()) ?? null, optionValue: value, display };
  };
  /**
   * GRADE (and what goes with it) from the grade a drawing writes. User, 2026-10-17:
   *   an option as written, or the grade the wording names ("… = today IS 2062 E250")   → that grade
   *   IS 2062-84 Gr B                                      → E250, IMPACT_CLASS BR
   *   IS 2062-84 Gr A, IS 226                              → E250, IMPACT_CLASS A ("A — no impact test")
   *   IS 2062 with no grade letter                         → E250, no impact class (said in the note)
   *   phosphor bronze                                      → no GRADE; MATERIAL PB ("Phosphor bronze")
   * Every row whose grade was translated carries "Original grade on drawing: <text>".
   * → { values, note }
   */
  const gradeOf = (it) => {
    const g = String(it?.grade ?? '').trim();
    if (!g) return { values: [], note: null };
    const original = `Original grade on drawing: ${g}`;
    if (/PHOSPHOR|BRONZE/i.test(`${g} ${it.material ?? ''}`)) {
      gradeMap.bronze++;
      return { values: [optionValue('MATERIAL', 'PB', 'Phosphor bronze')].filter(Boolean), note: original, bronze: true };
    }
    if (!spec('GRADE')) return { values: [], note: null };
    const exact = catalog.gradeOption?.get(g.toUpperCase());
    if (exact != null) { gradeMap.asWritten++; return { values: [{ code: 'GRADE', optionId: exact, display: g }], note: null }; }
    const named = /\bE\s?(250|275|300|350|410|450)\b/i.exec(g);
    if (named && catalog.gradeOption?.get(`E${named[1]}`) != null) {
      gradeMap.eNamed++;
      return { values: [{ code: 'GRADE', optionId: catalog.gradeOption.get(`E${named[1]}`), display: `E${named[1]}` }], note: original };
    }
    if (/IS\s*2062|IS\s*226/i.test(g) && catalog.gradeOption?.get('E250') != null) {
      gradeMap.legacyE250++;
      const v = [{ code: 'GRADE', optionId: catalog.gradeOption.get('E250'), display: 'E250' }];
      if (/\bGr\.?\s*B\b/i.test(g)) { gradeMap.impactBR++; v.push(optionValue('IMPACT_CLASS', 'BR')); }
      else if (/\bGr\.?\s*A\b/i.test(g) || /IS\s*226/i.test(g)) { gradeMap.impactA++; v.push(optionValue('IMPACT_CLASS', 'A', 'A — no impact test')); }
      else gradeMap.legacyNoClass++;
      return { values: v.filter(Boolean), note: original };
    }
    gradeMap.missed++;
    gradeMisses.set(g, (gradeMisses.get(g) ?? 0) + 1);
    return { values: [], note: original };
  };
  /** Definitions that must hold a value themselves (MATERIAL PB on the phosphor bronze plate: a fixed rule reads it there). */
  const definitionValues = [];

  /** The values a part row holds; its weight each (kg, gross: bom.json's own figure when it gives one). */
  function partValues(it, mark) {
    const gv = gradeOf(it);
    const v = [txt('DRAWING_MARK', mark), ...gv.values];
    let kg = null;
    const L = Number(it.lengthMm);
    if (it.category === 'plate') {
      v.push(num('THICKNESS', it.thicknessMm), num('WIDTH', it.widthMm), num('LENGTH', it.lengthMm));
      if ([it.thicknessMm, it.widthMm, it.lengthMm].every((x) => Number(x) > 0)) kg = (it.lengthMm * it.widthMm * it.thicknessMm * density) / 1e9;
    } else if (it.category === 'section') {
      // An angle "ISA a x b x t": legs a and b, gross section t (a + b - t) (IMPORT_FORMAT.md, no root fillet).
      // Any other section (a channel "ISMC 250x80"): depth and width from the profile, its area from bom.json's weight.
      const p = /(\d+(?:\.\d+)?)\s*[x×*]\s*(\d+(?:\.\d+)?)(?:\s*[x×*]\s*(\d+(?:\.\d+)?))?/.exec(String(it.profile ?? ''));
      const isAngle = it.role === 'angle' || /\bISA\b|^L\s?\d/i.test(String(it.profile ?? ''));
      const a = p ? Number(p[1]) : Number(it.widthMm); const b = p ? Number(p[2]) : Number(it.widthMm);
      const t = p?.[3] ? Number(p[3]) : Number(it.thicknessMm);
      let area = isAngle && a > 0 && b > 0 && t > 0 ? t * (a + b - t) : null;
      if (!area && Number(it.unitWeightKg) > 0 && L > 0) area = (Number(it.unitWeightKg) * 1e9) / (L * density);
      v.push(num('THICKNESS', t > 0 ? t : null), num('WIDTH', isAngle ? a : b), num('DEPTH', isAngle ? b : a), num('LENGTH', it.lengthMm), num('SECTION_AREA', area));
      if (area && L > 0) kg = (area * L * density) / 1e9;
    }
    // bom.json's gross weight each wins when it gives one (shaped plates, channels); else the one worked out here.
    if (Number(it.unitWeightKg) > 0) kg = Number(it.unitWeightKg);
    if (kg != null && spec('WEIGHT')) v.push({ code: 'WEIGHT', number: r3(kg), uom: spec('WEIGHT').default_uom ?? 'kg', source: 'calculated' });
    return { values: v.filter(Boolean), kg, gradeNote: gv.note, bronze: !!gv.bronze };
  }
  const joinNotes = (...xs) => { const t = xs.filter(Boolean).join(' · '); return t ? t.slice(0, 2000) : null; };

  /** The span (root): an existing span definition before a new one — SPAN-001, the names asked, then any "…span…". */
  const pickSpan = (names) => {
    const live = (catalog.defs ?? []).filter((d) => d.status === 'active' && d.definition_type === 'template');
    const byCode = live.find((d) => String(d.code ?? '').toUpperCase() === 'SPAN-001');
    if (byCode) return { def: byCode, asked: byCode.name };
    const named = pick(names, 'template');
    if (named) return named;
    const spans = live.filter((d) => /\bspan\b/i.test(String(d.name ?? '')));
    const best = spans.find((d) => d.bom_id) ?? spans[0];
    return best ? { def: best, asked: best.name } : null;
  };

  function mapDef(names, type, what, classHint, { span = false, hints = [] } = {}) {
    const hit = span ? pickSpan(names) : pick(names, type, { hint: classHint, hints: [what, ...hints] });
    if (hit) {
      mappings.push({ what, asked: names, to: { id: hit.def.id, code: hit.def.code, name: hit.def.name }, fallback: hit.asked !== names[0] && (hit.how ?? 'exact') === 'exact', how: hit.how ?? 'exact', note: hit.note ?? null });
      return { id: hit.def.id, code: hit.def.code, name: hit.def.name, classification_id: hit.def.classification_id, default_flow_id: hit.def.default_flow_id, bom_id: hit.def.bom_id ?? null };
    }
    const name = names[0];
    if (type === 'selection') { problems.push(`${what}: no selection definition named ${names.join(' / ')} — left out.`); return null; }
    if (!newDefs.has(name)) newDefs.set(name, { name, classHint, used: [], nearest: nearestTo(name, type, classHint) });
    if (!newDefs.get(name).used.includes(what)) newDefs.get(name).used.push(what);
    mappings.push({ what, asked: names, to: { new: name }, fallback: false, how: 'new' });
    return { new: name, name, classHint };
  }

  /**
   * User, 2026-10-17: a restrainer plate and its stiffeners sit together under the catalog's "Seismic stopper"
   * assembly when the catalog has one — a node put in between, quantities divided so the pieces (and the weight)
   * are the same. Without that definition they stay direct parts, and the plan says so.
   */
  const stopperDef = pick(['Seismic stopper'], 'template');
  // The bolt sets' selection (Fasteners › Bolt set) — null on a tenant that has none (bolts are then listed, as before).
  const boltHit = pick(['Bolt set'], 'selection');
  const boltDef = boltHit ? { id: boltHit.def.id, code: boltHit.def.code, name: boltHit.def.name, classification_id: boltHit.def.classification_id, default_flow_id: boltHit.def.default_flow_id, bom_id: null } : null;
  const what2Of = (it) => `${it.mark} ${it.description}`;
  const info = [];
  const withStopper = (node) => {
    const children = node.children ?? [];
    // A drawing's "seismic arrestor" IS the stopper (it maps to Seismic stopper): no second stopper inside it.
    if (/seismic\s+(stopper|arrestor|arrester)/i.test(String(node.name ?? ''))) return children;
    const rp = children.filter((c) => c.item != null && items.get(c.item)?.role === 'restrainer_plate');
    const rsp = children.filter((c) => c.item != null && items.get(c.item)?.role === 'restrainer_stiffener');
    if (!rp.length) return children;
    if (!stopperDef) {
      if (!info.some((x) => /Seismic stopper/.test(x))) info.push('No "Seismic stopper" assembly in the catalog: the restrainer plates and their stiffeners stay direct parts of their segment.');
      return children;
    }
    const k = rp.length === 1 && [...rp, ...rsp].every((c) => Number(c.qtyPerParent) % Number(rp[0].qtyPerParent) === 0) ? Number(rp[0].qtyPerParent) : 1;
    const stopper = {
      id: `${node.id ?? 'N'}-STP`, kind: 'assembly', name: 'Seismic stopper', qtyPerParent: k,
      children: [...rp, ...rsp].map((c) => ({ ...c, qtyPerParent: Number(c.qtyPerParent) / k })),
    };
    const at = children.indexOf(rp[0]);
    const rest = children.filter((c) => !rp.includes(c) && !rsp.includes(c));
    rest.splice(Math.min(at, rest.length), 0, stopper);
    return rest;
  };

  function walk(node, parentKey, depth, place) {
    const children = withStopper(node);
    const leaves = children.filter((c) => c.item != null);
    // A node of bought items only is not made: list it, write nothing.
    if (node.item == null && leaves.length && leaves.length === children.length && leaves.every((l) => BOUGHT_ROLES.has(items.get(l.item)?.role) && !(boltDef && items.get(l.item)?.role === 'bolt'))) {
      for (const l of leaves) { const it = items.get(l.item); bought.push({ mark: it?.mark ?? l.item, description: it?.description ?? l.item, quantity: Number(l.qtyPerParent) * (place.mult ?? 1), profile: it?.profile ?? null }); }
      return;
    }
    const key = `n${++seq}`;
    // A span or a girder line carries no drawing mark of its own; a segment or an assembly does ("GA/…").
    const mark = node.kind === 'span' || node.kind === 'girder' ? null : nodeMark(node);
    const what = `${node.kind} ${node.name}`;
    const asked = nodeCandidates(node, items);
    const def = mapDef(asked, 'template', what, node.kind === 'span' || node.kind === 'girder' ? 'structure' : 'assembly', { span: asked[0] === 'Bridge span' });
    // What a group's name says after ":" ("use only the variant of the span being launched") is a NOTE on its line.
    const nodeNote = /:\s*(.+)$/.exec(String(node.name ?? '').replace(/\([^)]*\)/g, ''))?.[1]?.trim() ?? null;
    const v = [txt('DRAWING_MARK', mark)].filter(Boolean);
    if (node.kind === 'span') {
      const layout = (bom.assembly?.children ?? []).flatMap((c) => c.layoutMm ?? []);
      const span = layout.length ? Math.max(...layout.map((s) => Number(s.toMm) || 0)) : null;
      const sl = num('SPAN_LENGTH', span); if (sl) v.push(sl);
    }
    const row = {
      key, parentKey, kind: 'temp', depth, lineNo: place.lineNo ?? null, position: null,
      role: depth === 0 ? null : roleText(String(node.name ?? '').replace(/:.*$/, '')), quantity: Number(node.qtyPerParent ?? 1), notes: depth === 0 ? null : nodeNote?.slice(0, 2000) ?? null, mark,
      def, values: v, node: { id: node.id, kind: node.kind, name: node.name }, item: null, weightKg: null, children: [],
    };
    rows.push(row);
    const endDiaphragm = /END\s+DIAPHRAGM/i.test(String(node.name ?? ''));
    let lineNo = 0;
    for (const c of children) {
      lineNo += 10;
      if (c.item == null) { walk(c, key, depth + 1, { lineNo, mult: (place.mult ?? 1) * Number(c.qtyPerParent ?? 1) }); continue; }
      const it = items.get(c.item);
      if (!it) { problems.push(`${node.name}: item ${c.item} is not in items[] — left out.`); continue; }
      const q = Number(c.qtyPerParent ?? 1);
      // BOLTS ARE ROWS (user, 2026-11-01: "are these … bolts selected of the right dia and length … in the BOM?"): a bolt
      // item becomes a "Bolt set" selection row, its catalog size chosen when the BOM names diameter, length and class —
      // else left to choose, and said. A tenant without the "Bolt set" selection keeps the old way (listed, not a row).
      if (it.role === 'bolt' && boltDef) {
        const want = boltWanted(it);
        const match = want.dia && want.length ? (catalog.bolts ?? []).find((b) => boltOf(b.name)?.dia === want.dia && boltOf(b.name)?.length === want.length && (!want.grade || boltOf(b.name)?.grade === want.grade)) : null;
        rows.push({
          key: `n${++seq}`, parentKey: key, kind: 'selection', depth: depth + 1, lineNo, position: null,
          role: roleText(it.description), quantity: q, mark: it.mark,
          notes: match ? (it.notes?.length ? it.notes.join(' ') : null)
            : `Choose the bolt size: ${want.dia ? `M${want.dia}` : (it.profile ?? 'diameter not stated')}${want.length ? ` x ${want.length}` : ' — length by grip (plies + nut + 2 washers + 3 threads)'}${want.grade ? `, class ${want.grade}` : ''}.`,
          def: boltDef, chosen: match ? { id: match.id, code: match.code, name: match.name } : null, values: [], item: it, weightKg: null, children: [],
        });
        mappings.push({ what: what2Of(it), asked: ['Bolt set'], to: { id: boltDef.id, code: boltDef.code, name: boltDef.name }, fallback: false, chosen: match ? match.name : null });
        continue;
      }
      if (BOUGHT_ROLES.has(it.role) || (it.category === 'bought' && it.role !== 'shear_stud')) {
        bought.push({ mark: it.mark ?? it.id, description: it.description, quantity: q * (place.mult ?? 1), profile: it.profile ?? null });
        continue;
      }
      const what2 = `${it.mark} ${it.description}`;
      // A placeholder for parts the drawing does not size: not a row — said, so a person adds them.
      if (it.role === 'main_girder_unsized') { problems.push(`${what2.slice(0, 120)}: not sized in the drawing — left out; add these parts by hand.`); continue; }
      if (it.role === 'shear_stud') {
        const sel = mapDef(partCandidates(it), 'selection', what2, null);
        if (!sel) continue;
        // The catalog stud of this size if there is one; else the selection stays to be chosen, and says so.
        const want = /(\d+)\s*dia\s*x\s*(\d+)/i.exec(String(it.profile ?? it.material ?? ''));
        const match = want ? (catalog.studs ?? []).find((s) => new RegExp(`\\b${want[1]}\\b`).test(s.name) && new RegExp(`\\b${want[2]}\\b`).test(s.name)) : null;
        rows.push({
          key: `n${++seq}`, parentKey: key, kind: 'selection', depth: depth + 1, lineNo, position: null,
          role: roleText(it.description), quantity: q, mark: it.mark,
          notes: match ? null : `Choose the stud: ${it.profile ?? it.material} — no catalog stud of this size yet.`,
          def: sel, chosen: match ? { id: match.id, code: match.code, name: match.name } : null, values: [], item: it, weightKg: null, children: [],
        });
        mappings[mappings.length - 1].chosen = match ? match.name : null;
        continue;
      }
      // An angle written TOP/BOTTOM is two rows of the frame, one each — the catalog names them apart. An X-frame
      // HORIZONTAL that does not say which (RDSO_516) is split too, evenly, and says so (user, 2026-10-17).
      const desc = String(it.description ?? '');
      const both = /TOP\s*\/\s*BOTTOM/i.test(desc);
      const horizontal = !both && /X-?\s*FRAME/i.test(desc) && /HORIZONTAL/i.test(desc) && !/\bTOP\b|\bBOTTOM\b/i.test(desc);
      const split = it.role === 'angle' && (both || horizontal) && q >= 2;
      const top = Math.ceil(q / 2);
      const splitNote = horizontal ? `Top or bottom is not told apart on the drawing: the ${q} split evenly (${top} top, ${q - top} bottom).` : null;
      const parts = split
        ? [{ names: ['X-frame top angle'], quantity: top, role: 'Top angle' }, { names: ['X-frame bottom angle'], quantity: q - top, role: 'Bottom angle' }]
        : [{ names: partCandidates(it, { endDiaphragm, single: q === 1, bowstring, has }), quantity: q, role: roleText(it.description) }];
      for (const [i, p] of parts.entries()) {
        const d = mapDef(p.names, 'template', split ? `${what2} (${p.role.toLowerCase()})` : what2, it.category === 'section' ? 'profile' : 'plate');
        const { values: pv, kg, gradeNote, bronze } = partValues(it, it.mark);
        if (bronze && d) definitionValues.push({ def: d, code: 'MATERIAL', value: optionValue('MATERIAL', 'PB', 'Phosphor bronze') });
        rows.push({
          key: `n${++seq}`, parentKey: key, kind: 'temp', depth: depth + 1, lineNo: lineNo + i, position: null,
          role: p.role, quantity: p.quantity, mark: it.mark, notes: joinNotes(rowNote(it, bom.decisions), splitNote, gradeNote),
          def: d, values: pv, item: it, weightKg: kg == null ? null : r3(kg), children: [],
        });
      }
      if (it.dxf && !files.has(it.mark)) files.set(it.mark, { mark: it.mark, file: it.dxf, item: it });
    }
  }
  if (bom?.assembly) walk(bom.assembly, null, 0, { lineNo: null, mult: 1 });
  else problems.push('bom.json has no assembly tree.');
  for (const [g, n] of gradeMisses) problems.push(`Grade "${g}" is not an option of GRADE here — ${n} row${n === 1 ? '' : 's'} left without a grade.`);

  // Children, positions (per parent and definition, 1, 2 …), and the roll-up of weights per unit.
  const byKey = new Map(rows.map((r) => [r.key, r]));
  for (const r of rows) if (r.parentKey) byKey.get(r.parentKey).children.push(r);
  for (const r of rows) {
    const seen = new Map();
    for (const k of r.children) {
      const dk = k.def?.id ?? k.def?.new ?? k.key;
      seen.set(dk, (seen.get(dk) ?? 0) + 1);
      k.position = seen.get(dk);
    }
  }
  const studKg = new Map((bom.items ?? []).filter((i) => i.role === 'shear_stud').map((i) => [i.mark, Number(i.unitWeightKg) || 0]));
  const roll = (r) => {
    if (r.kind === 'selection') return { steel: 0, studs: (studKg.get(r.mark) ?? 0) * r.quantity };
    if (!r.children.length) return { steel: r.weightKg ?? 0, studs: 0 };
    let steel = 0; let studs = 0;
    for (const k of r.children) { const w = roll(k); steel += w.steel * k.quantity; studs += w.studs * (k.kind === 'selection' ? 1 : k.quantity); }
    r.weightKg = r3(steel);
    if (spec('WEIGHT')) r.values.push({ code: 'WEIGHT', number: r3(steel), uom: spec('WEIGHT').default_uom ?? 'kg', source: 'rollup' });
    return { steel, studs };
  };
  const root = rows[0] ?? null;
  const w = root ? roll(root) : { steel: 0, studs: 0 };

  const tempRows = rows.filter((r) => r.kind === 'temp');
  // A revision is a short mark ("R3"). Older sets put a sentence there ("PROVISIONAL 8-8-91; …"): that is a note, not a revision.
  const rev = /^[A-Za-z0-9._/-]{1,20}$/.test(String(dw.revision ?? '').trim()) ? String(dw.revision).trim() : null;
  const revNote = !rev && dw.revision ? String(dw.revision).trim() : null;
  const number = `${dw.number ?? bom?.set ?? 'STANDARD'}${rev ?? ''}`;
  return {
    standard: {
      number,
      registerNumber: dw.number ?? number,
      revision: rev,
      name: `${number} — ${dw.spanM ? `${dw.spanM} m span` : ''}${dw.loading ? `, ${dw.loading}` : ''}`.replace(/ — $/, '').replace(/ — , /, ' — ').slice(0, 255),
      description: [dw.title ?? null, revNote ? `Revision: ${revNote}` : null].filter(Boolean).join('\n') || null,
      sourceUrl: dw.sourceUrl ?? null,
      internal: /internal/i.test(String(dw.ownership ?? '')),
      ownership: dw.ownership ?? null,
      sheets: dw.sheets ?? [],
    },
    rows,
    files: [...files.values()],
    bought,
    newDefinitions: [...newDefs.values()],
    mappings,
    problems,
    info,
    gradeMap,
    definitionValues,
    totals: {
      rows: tempRows.length,
      parts: tempRows.filter((r) => !r.children.length).length,
      steelKg: r3(w.steel),
      studKg: r3(w.studs),
      bomSteelKg: bom?.totals?.steelKg ?? null,
      // Older sets keep non-steel parts (phosphor bronze plates) apart from steelKg; the tree weighs them too.
      bomNonSteelKg: bom?.totals?.nonSteelKg ?? 0,
      bomSteelKgInclStuds: bom?.totals?.steelKgInclStuds ?? null,
    },
  };
}
