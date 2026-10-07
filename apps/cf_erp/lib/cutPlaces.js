/**
 * cutPlaces.js — where each kind of cut piece, its raw stock and its offcuts are
 * filed (init.sql §48, CF_ERP_CUT_FROM_PLAN.md §3.4). THE one place every
 * service asks; no service names a classification code for this any more.
 *
 *   cutPlaces(db, companyId) -> {
 *     plate:   { placeId, blanksNodeId, blanksIds: Set, offcutNodeId, offcutIds: Set, stockNodeIds: [], stockIds: Set },
 *     section: { … the same … },
 *     settings: { sawKerfMm, endTrimMm, minOffcutMm },   // section cutting (cf_section_settings, else defaults)
 *     problems: [{ kind, what, text }],                  // a place not set, in words
 *   }
 *   placeOfNode(places, nodeId) -> { kind, role: 'blanks' | 'offcut' | 'stock' } | null
 *
 * Sets hold each place's node AND its whole subtree, so a blank filed on a
 * variant under the blanks node still counts. Read once per request: a few
 * small queries, no per-row calls.
 */
const SUBTREE_HOPS = 8;
export const CUT_KINDS = ['plate', 'section'];
export const SECTION_DEFAULTS = { sawKerfMm: 3, endTrimMm: 10, minOffcutMm: 500 };
const KIND_WORD = { plate: 'plate', section: 'section' };

/**
 * Every live place node (blanks, offcut and stock, of every kind) with its whole
 * live subtree, in ONE recursive query seeded from the place tables themselves.
 * Rows: { place_id, role, seed_id, id } — a seed missing from the answer is a
 * node that was deleted (or never set).
 */
const PLACE_SUBTREES_SQL = `
  WITH RECURSIVE roots AS (
    SELECT p.id AS place_id, 'blanks' AS role, p.blanks_node_id AS node_id FROM cf_cut_places p WHERE p.company_id = ? AND p.blanks_node_id IS NOT NULL
     UNION ALL
    SELECT p.id, 'offcut', p.offcut_node_id FROM cf_cut_places p WHERE p.company_id = ? AND p.offcut_node_id IS NOT NULL
     UNION ALL
    SELECT s.place_id, 'stock', s.node_id FROM cf_cut_place_stock s WHERE s.company_id = ?
  ), sub AS (
    SELECT r.place_id, CAST(r.role AS CHAR(10)) AS role, n.id AS seed_id, n.id, CAST(0 AS SIGNED) AS hop
      FROM roots r JOIN cf_classification_nodes n ON n.company_id = ? AND n.id = r.node_id AND n.deleted_at IS NULL
     UNION ALL
    SELECT s.place_id, s.role, s.seed_id, c.id, s.hop + 1
      FROM sub s JOIN cf_classification_nodes c ON c.company_id = ? AND c.parent_id = s.id AND c.deleted_at IS NULL
     WHERE s.hop < ?
  )
  SELECT place_id, role, seed_id, id FROM sub`;

export async function cutPlaces(db, companyId) {
  // Two round trips side by side: the place rows with the settings, and every
  // place's live subtree (production is ~49 ms a round trip, and a cut-piece
  // derive asks after every save).
  const [[placeRows], [subRows]] = await Promise.all([
    db.query(
      `SELECT p.id, p.kind, p.blanks_node_id, p.offcut_node_id, x.saw_kerf_mm, x.end_trim_mm, x.min_offcut_mm
         FROM (SELECT 1 AS one) o
         LEFT JOIN cf_cut_places p ON p.company_id = ?
         LEFT JOIN cf_section_settings x ON x.company_id = ?`,
      [companyId, companyId],
    ),
    db.query(PLACE_SUBTREES_SQL, [companyId, companyId, companyId, companyId, companyId, SUBTREE_HOPS]),
  ]);
  const places = placeRows.filter((p) => p.id != null);
  const settingsRows = placeRows.filter((p) => p.saw_kerf_mm != null).slice(0, 1);
  const live = new Set(subRows.map((r) => Number(r.seed_id)));
  const sub = new Map();
  for (const r of subRows) {
    const k = Number(r.seed_id);
    if (!sub.has(k)) sub.set(k, new Set());
    sub.get(k).add(Number(r.id));
  }
  // Stock nodes as the place lists them (live ones only), in id order of the link rows.
  const stockSeeds = new Map();
  for (const r of subRows) {
    if (r.role !== 'stock' || Number(r.seed_id) !== Number(r.id)) continue;
    const pid = Number(r.place_id);
    if (!stockSeeds.has(pid)) stockSeeds.set(pid, []);
    if (!stockSeeds.get(pid).includes(Number(r.seed_id))) stockSeeds.get(pid).push(Number(r.seed_id));
  }
  for (const list of stockSeeds.values()) list.sort((a, b) => a - b);
  const stock = [...stockSeeds].flatMap(([pid, ids]) => ids.map((id) => ({ place_id: pid, node_id: id })));
  const union = (ids) => { const out = new Set(); for (const id of ids) for (const x of sub.get(id) ?? []) out.add(x); return out; };

  const out = { problems: [] };
  for (const kind of CUT_KINDS) {
    const p = places.find((x) => x.kind === kind) ?? null;
    const blanks = p?.blanks_node_id != null && live.has(Number(p.blanks_node_id)) ? Number(p.blanks_node_id) : null;
    const offcut = p?.offcut_node_id != null && live.has(Number(p.offcut_node_id)) ? Number(p.offcut_node_id) : null;
    const stockNodeIds = p ? stock.filter((s) => Number(s.place_id) === Number(p.id)).map((s) => Number(s.node_id)) : [];
    out[kind] = {
      placeId: p ? Number(p.id) : null,
      blanksNodeId: blanks, blanksIds: blanks ? union([blanks]) : new Set(),
      offcutNodeId: offcut, offcutIds: offcut ? union([offcut]) : new Set(),
      stockNodeIds, stockIds: union(stockNodeIds),
    };
    const w = KIND_WORD[kind];
    if (!blanks) out.problems.push({ kind, what: 'blanks', text: `No place is set for ${w} cut pieces — choose one in Setup › Cutting.` });
    if (!stockNodeIds.length) out.problems.push({ kind, what: 'stock', text: `No raw ${w} stock is set — choose where it is filed in Setup › Cutting.` });
    if (!offcut) out.problems.push({ kind, what: 'offcut', text: `No place is set for ${w} offcuts — choose one in Setup › Cutting.` });
  }
  const st = settingsRows[0];
  out.settings = st
    ? { sawKerfMm: Number(st.saw_kerf_mm), endTrimMm: Number(st.end_trim_mm), minOffcutMm: Number(st.min_offcut_mm) }
    : { ...SECTION_DEFAULTS };
  return out;
}

/** Which place (and role) a classification node belongs to, or null. */
export function placeOfNode(places, nodeId) {
  const id = Number(nodeId);
  for (const kind of CUT_KINDS) {
    const p = places[kind];
    if (!p) continue;
    if (p.blanksIds.has(id)) return { kind, role: 'blanks' };
    if (p.offcutIds.has(id)) return { kind, role: 'offcut' };
    if (p.stockIds.has(id)) return { kind, role: 'stock' };
  }
  return null;
}

/** The problems of one kind only (a line with no section parts need not hear about section places). */
export const problemsOf = (places, kind, roles = ['blanks', 'stock', 'offcut']) => places.problems.filter((p) => p.kind === kind && roles.includes(p.what));
