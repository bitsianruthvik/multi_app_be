/**
 * cutFrom.js — how a record's pieces are cut, and the section a section part is
 * cut from (CF_ERP_CUT_FROM_PLAN.md §3.1–3.2, §11.2). Read in bulk.
 *
 *   cutFromOf(db, companyId, masterIds, opts?)   Map id -> 'PLATE' | 'SECTION' | 'NONE' | null
 *   cutFromDetailOf(…)                           Map id -> { value, source, from } (source own|definition|classification|null)
 *   cutStockOf(db, companyId, masterIds, opts?)  Map id -> { stockId, from: 'own' | 'definition' } | null
 *   sectionSteelOf(db, companyId, stockIds)      Map stockId -> { thickness, width, depth, sectionArea, lengthMm,
 *                                                 grade, impactClass, material, density, code, name, rows }
 *   resolveCodes(db, companyId, masters, codes)  the resolver under all three: per record, per spec code,
 *                                                the winning item-level rule and the effective value
 *
 * CUT_FROM IS RESOLVED THE WAY resolutionService RESOLVES ANY SPEC — the chain
 * Family -> Subfamily -> Variant -> [template definition] -> the record, the
 * most specific item-level rule winning whole, a rule switched off meaning "no
 * answer", and for its value rule (defaulted, seeded by §48): the record's own
 * ENTERED value, else the nearest value above. A definition (setup mode) shows
 * its own value whatever its source, else the nearest above. It is the same
 * merge resolve() does per record, done for many at once: a fixed number of
 * queries whatever the size (production is ~49 ms a round trip, and a cut-piece
 * derive runs after every save) — the records (skipped when the caller already
 * read them), their classification chains (one recursive query), then the rules
 * and the values of the asked codes over every subject of every chain, side by
 * side. Three round trips.
 *
 * No answer anywhere = null, which every caller reads as NONE AND REPORTS
 * (lockService's cut_method check): a part that silently stops being cut is
 * exactly what this replaced.
 */
const CHAIN_HOPS = 8;
export const CUT_FROM_CODE = 'CUT_FROM';
export const CUT_FROM_VALUES = ['PLATE', 'SECTION', 'NONE'];

/**
 * The steel a SECTION part takes from the stock bar it is cut from (§3.2):
 * written on the part as source 'inherited' where the part has no entered
 * value, so WEIGHT = SECTION_AREA × LENGTH × DENSITY works with no new formula.
 * The Values engine leaves an 'inherited' row of these codes alone under an
 * 'entered' rule (valueService / orderValuesService derivedWrites); the cut
 * piece derive owns them — it writes, moves and clears them.
 */
export const STEEL_FROM_STOCK = ['THICKNESS', 'WIDTH', 'DEPTH', 'SECTION_AREA', 'GRADE', 'IMPACT_CLASS', 'MATERIAL', 'DENSITY'];
export const STEEL_FROM_STOCK_SET = new Set(STEEL_FROM_STOCK);

const num = (v) => (v == null ? null : Number(Number(v).toFixed(6)));

/** rawOf, for the columns these reads return (no tables: none of these codes is one). */
function rawOfRow(r) {
  if (!r) return null;
  if (r.option_id != null) return Number(r.option_id);
  if (r.value_number != null) return Number(r.value_number);
  if (r.value_text != null) return r.value_text;
  if (r.value_bool != null) return !!Number(r.value_bool);
  if (r.value_date != null) return r.value_date;
  return null;
}

/** The records' own rows: kind, classification, template definition, cut stock. One query. */
export async function readMasters(db, companyId, ids) {
  if (!ids.length) return [];
  const [rows] = await db.query(
    `SELECT m.id, m.code, m.name, m.record_kind, m.classification_id, m.cut_stock_id,
            i.item_type, i.source_definition_id, d.cut_stock_id AS def_cut_stock_id,
            d.code AS def_code, d.name AS def_name
       FROM cf_master_records m
       LEFT JOIN cf_item_details i ON i.master_id = m.id AND i.deleted_at IS NULL
       LEFT JOIN cf_master_records d ON d.id = i.source_definition_id AND d.deleted_at IS NULL
      WHERE m.company_id = ? AND m.id IN (?) AND m.deleted_at IS NULL`,
    [companyId, ids],
  );
  return rows;
}

/**
 * Per record, per code: { rule: { valueRule, isRequired, applicable } | null,
 * value: raw | null, optionValue, row (the value row the answer came from),
 * own (the record's own stored row, any source), source: 'own' | 'definition'
 * | 'classification' | null, from: label | null }.
 *
 * masters: rows with id, record_kind, classification_id, item_type,
 * source_definition_id (+ def_code/def_name for the words) — readMasters' shape.
 */
export async function resolveCodes(db, companyId, masters, codes) {
  const out = new Map();
  if (!masters.length || !codes.length) return out;
  const clsIds = [...new Set(masters.map((m) => Number(m.classification_id)).filter(Boolean))];
  const masterIds = [...new Set(masters.flatMap((m) => [Number(m.id), m.source_definition_id != null ? Number(m.source_definition_id) : null]).filter(Boolean))];
  const upper = codes.map((c) => String(c).toUpperCase());
  // ONE round trip: the classification chains (walked up from every record's
  // node), and the rules and values of the asked codes on every subject of
  // every chain — three row shapes in one UNION ALL, told apart by `t`.
  const [rows] = await db.query(
    `WITH RECURSIVE up AS (
       SELECT n.id AS seed, n.id, n.parent_id, n.code, n.name, CAST(0 AS SIGNED) AS hop
         FROM cf_classification_nodes n WHERE n.company_id = ? AND n.id IN (?)
        UNION ALL
       SELECT up.seed, p.id, p.parent_id, p.code, p.name, up.hop + 1
         FROM up JOIN cf_classification_nodes p ON p.company_id = ? AND p.id = up.parent_id
        WHERE up.hop < ?
     )
     SELECT 'n' AS t, up.seed, up.id, up.code AS node_code, up.name AS node_name, up.hop, NULL AS subject_type, NULL AS subject_id, NULL AS is_required, NULL AS is_applicable, NULL AS value_rule, NULL AS sort_order, NULL AS code, NULL AS value_number, NULL AS value_text, NULL AS value_bool, NULL AS value_date, NULL AS option_id, NULL AS source, NULL AS uom, NULL AS data_type, NULL AS option_value FROM up
     UNION ALL
     SELECT 'a', NULL, a.id, NULL, NULL, NULL, a.subject_type, a.subject_id, a.is_required, a.is_applicable, a.value_rule, a.sort_order,
            UPPER(s.code), NULL, NULL, NULL, NULL, NULL, a.origin, NULL, NULL, NULL
       FROM cf_spec_assignments a
       JOIN cf_specifications s ON s.id = a.specification_id AND s.deleted_at IS NULL AND s.code IN (?)
      WHERE a.company_id = ? AND a.deleted_at IS NULL AND a.capture_at = 'item'
        AND ((a.subject_type = 'classification' AND a.subject_id IN (SELECT id FROM up)) OR (a.subject_type = 'master' AND a.subject_id IN (?)))
     UNION ALL
     SELECT 'v', NULL, v.id, NULL, NULL, NULL, v.subject_type, v.subject_id, NULL, NULL, NULL, NULL,
            UPPER(s.code), v.value_number, v.value_text, v.value_bool, v.value_date, v.option_id, v.source, v.uom, s.data_type, o.value
       FROM cf_spec_values v
       JOIN cf_specifications s ON s.id = v.specification_id AND s.deleted_at IS NULL AND s.code IN (?)
       LEFT JOIN cf_spec_options o ON o.id = v.option_id
      WHERE v.company_id = ? AND v.deleted_at IS NULL
        AND ((v.subject_type = 'classification' AND v.subject_id IN (SELECT id FROM up)) OR (v.subject_type = 'master' AND v.subject_id IN (?)))`,
    [companyId, clsIds.length ? clsIds : [0], companyId, CHAIN_HOPS,
      upper, companyId, masterIds.length ? masterIds : [0],
      upper, companyId, masterIds.length ? masterIds : [0]],
  );
  const chainRows = [];
  const rules = [];
  const values = [];
  for (const r of rows) {
    if (r.t === 'n') chainRows.push({ seed: r.seed, id: r.id, code: r.node_code, name: r.node_name, hop: r.hop });
    else if (r.t === 'a') rules.push({ ...r, sort_order: Number(r.sort_order ?? 0) });
    else values.push(r);
  }
  const chainOf = new Map();                       // classification id -> [node] broadest first
  for (const r of chainRows) {
    if (!chainOf.has(Number(r.seed))) chainOf.set(Number(r.seed), []);
    chainOf.get(Number(r.seed)).push(r);
  }
  for (const list of chainOf.values()) list.sort((a, b) => Number(b.hop) - Number(a.hop));
  const key = (t, id) => `${t}:${id}`;
  const rulesAt = new Map();
  for (const r of rules) {
    const k = key(r.subject_type, r.subject_id);
    if (!rulesAt.has(k)) rulesAt.set(k, []);
    rulesAt.get(k).push(r);
  }
  const valueAt = new Map();                       // "type:id:CODE" -> row
  for (const v of values) valueAt.set(`${key(v.subject_type, v.subject_id)}:${v.code}`, v);

  for (const m of masters) {
    const chain = (chainOf.get(Number(m.classification_id)) ?? []).map((n) => ({ t: 'classification', id: Number(n.id), label: n.name ?? n.code, level: 'classification' }));
    if (m.record_kind === 'item' && m.item_type === 'temporary' && m.source_definition_id != null) {
      chain.push({ t: 'master', id: Number(m.source_definition_id), label: m.def_code ?? m.def_name ?? `definition ${m.source_definition_id}`, level: 'definition' });
    }
    chain.push({ t: 'master', id: Number(m.id), label: null, level: 'own', self: true });
    const selfIndex = chain.length - 1;
    const mode = m.record_kind === 'item' ? 'item' : 'setup';
    const mine = new Map();
    for (const code of upper) {
      let win = null;
      chain.forEach((s, i) => {
        // `source` carries a rule's origin here: a flow-made rule is its own record's only.
        const list = (rulesAt.get(key(s.t, s.id)) ?? []).filter((r) => r.code === code && !(r.source === 'flow' && !s.self))
          .sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);
        for (const r of list) win = { r, i };
      });
      const own = valueAt.get(`${key('master', m.id)}:${code}`) ?? null;
      const entry = { rule: null, value: null, optionValue: null, row: null, own, source: null, from: null };
      if (win) entry.rule = { valueRule: win.r.value_rule, isRequired: !!win.r.is_required, applicable: !!win.r.is_applicable };
      if (win && win.r.is_applicable) {
        let at = null;
        const above = () => {
          for (let i = selfIndex - 1; i >= 0; i--) {
            const v = valueAt.get(`${key(chain[i].t, chain[i].id)}:${code}`);
            if (v) return { row: v, i };
          }
          return null;
        };
        const vr = win.r.value_rule;
        if (mode === 'setup') at = own ? { row: own, i: selfIndex } : above();
        else if (vr === 'entered') at = own ? { row: own, i: selfIndex } : null;
        else if (vr === 'defaulted') at = own && own.source === 'entered' ? { row: own, i: selfIndex } : above();
        else if (vr === 'fixed') at = above();
        else at = own ? { row: own, i: selfIndex } : null;   // calculated / rollup / inherited: what is stored
        if (at) {
          const raw = rawOfRow(at.row);
          if (raw != null) {
            entry.value = raw;
            entry.optionValue = at.row.option_value ?? null;
            entry.row = at.row;
            const lv = chain[at.i].level;
            entry.source = lv === 'own' ? 'own' : lv;
            entry.from = lv === 'own' ? null : chain[at.i].label;
          }
        }
        // What it would be without its own answer (the screen's "Inherit").
        const up = vr === 'fixed' || vr === 'defaulted' || mode === 'setup' ? above() : null;
        if (up && rawOfRow(up.row) != null) {
          entry.above = { value: rawOfRow(up.row), optionValue: up.row.option_value ?? null, source: chain[up.i].level, from: chain[up.i].label };
        }
      }
      mine.set(code, entry);
    }
    out.set(Number(m.id), mine);
  }
  return out;
}

const cutFromWord = (e) => {
  const v = e?.optionValue ?? (typeof e?.value === 'string' ? e.value : null);
  const up = v == null ? null : String(v).toUpperCase();
  return CUT_FROM_VALUES.includes(up) ? up : null;
};

/** Map id -> { value, source, from } — the Details screen's "Plate — from Plate part". */
export async function cutFromDetailOf(db, companyId, masterIds, { masters = null } = {}) {
  const ids = [...new Set(masterIds.map(Number))];
  const out = new Map(ids.map((id) => [id, { value: null, source: null, from: null }]));
  if (!ids.length) return out;
  const rows = masters ?? await readMasters(db, companyId, ids);
  const res = await resolveCodes(db, companyId, rows, [CUT_FROM_CODE]);
  for (const id of ids) {
    const e = res.get(id)?.get(CUT_FROM_CODE);
    const value = cutFromWord(e);
    const d = value ? { value, source: e.source, from: e.from } : { value: null, source: null, from: null };
    // An own answer also says what "inherit" would give: the value above it, and where from.
    if (d.source === 'own') {
      const iv = e.above ? cutFromWord(e.above) : null;
      d.inherited = iv ? { value: iv, source: e.above.source, from: e.above.from } : { value: null, source: null, from: null };
    }
    out.set(id, d);
  }
  return out;
}

/** Map id -> 'PLATE' | 'SECTION' | 'NONE' | null (null = no answer anywhere). */
export async function cutFromOf(db, companyId, masterIds, opts = {}) {
  const detail = await cutFromDetailOf(db, companyId, masterIds, opts);
  return new Map([...detail].map(([id, d]) => [id, d.value]));
}

/** Map id -> { stockId, from: 'own' | 'definition' } | null — the item's own, else its template definition's. */
export async function cutStockOf(db, companyId, masterIds, { masters = null } = {}) {
  const ids = [...new Set(masterIds.map(Number))];
  const out = new Map(ids.map((id) => [id, null]));
  if (!ids.length) return out;
  const rows = masters ?? await readMasters(db, companyId, ids);
  for (const m of rows) {
    if (m.cut_stock_id != null) out.set(Number(m.id), { stockId: Number(m.cut_stock_id), from: 'own' });
    else if (m.def_cut_stock_id != null && m.record_kind === 'item') out.set(Number(m.id), { stockId: Number(m.def_cut_stock_id), from: 'definition' });
  }
  return out;
}

export const SECTION_STEEL_CODES = ['THICKNESS', 'WIDTH', 'DEPTH', 'SECTION_AREA', 'LENGTH', 'GRADE', 'IMPACT_CLASS', 'MATERIAL', 'DENSITY'];

/**
 * The steel of stock bars, read where it is stored (a catalog item's values are
 * all stored). One query. Map stockId -> { …, rows: Map(code -> value row) };
 * a stock id that is not a live record is absent.
 */
export async function sectionSteelOf(db, companyId, stockIds) {
  const ids = [...new Set(stockIds.filter((x) => x != null).map(Number))];
  const out = new Map();
  if (!ids.length) return out;
  const [rows] = await db.query(
    `SELECT m.id, m.code, m.name, m.classification_id, x.code AS spec_code, x.specification_id, x.data_type, x.value_number, x.value_text,
            x.value_bool, x.value_date, x.option_id, x.option_value, x.uom
       FROM cf_master_records m
       LEFT JOIN (SELECT v.subject_id, UPPER(s.code) AS code, v.specification_id, s.data_type, v.value_number, v.value_text,
                         v.value_bool, v.value_date, v.option_id, o.value AS option_value, v.uom
                    FROM cf_spec_values v
                    JOIN cf_specifications s ON s.id = v.specification_id AND s.deleted_at IS NULL
                    LEFT JOIN cf_spec_options o ON o.id = v.option_id
                   WHERE v.company_id = ? AND v.subject_type = 'master' AND v.subject_id IN (?)
                     AND v.deleted_at IS NULL AND s.code IN (?)) x ON x.subject_id = m.id
      WHERE m.company_id = ? AND m.id IN (?) AND m.deleted_at IS NULL`,
    [companyId, ids, SECTION_STEEL_CODES, companyId, ids],
  );
  for (const r of rows) {
    if (!out.has(r.id)) out.set(r.id, { id: r.id, code: r.code, name: r.name, classificationId: r.classification_id, rows: new Map() });
    if (r.spec_code != null) out.get(r.id).rows.set(r.spec_code, r);
  }
  for (const s of out.values()) {
    const n = (code) => num(s.rows.get(code)?.value_number);
    const t = (code) => { const r = s.rows.get(code); return r ? (r.option_value ?? r.value_text ?? (r.value_number != null ? String(Number(r.value_number)) : null)) : null; };
    Object.assign(s, {
      thickness: n('THICKNESS'), width: n('WIDTH'), depth: n('DEPTH'), sectionArea: n('SECTION_AREA'), lengthMm: n('LENGTH'),
      grade: t('GRADE'), impactClass: t('IMPACT_CLASS'), material: t('MATERIAL'), density: n('DENSITY'),
      gradeId: s.rows.get('GRADE')?.option_id ?? null, impactId: s.rows.get('IMPACT_CLASS')?.option_id ?? null,
    });
  }
  return out;
}

/** The profile two bars share when they are the same bar in any stock length (§3.3). */
export const profileKeyOf = (s) => [
  s.thickness, s.width, s.depth,
  s.gradeId != null ? `o${s.gradeId}` : `t${String(s.grade ?? '').trim().toUpperCase()}`,
  s.impactId != null ? `o${s.impactId}` : `t${String(s.impactClass ?? '').trim().toUpperCase()}`,
].join('|');

/** "ISA 75 × 75 × 8" — a section's size in words, from its steel. */
export const profileLabelOf = (s) => {
  const dims = [s.width, s.depth, s.thickness].filter((x) => x != null && x > 0).map((x) => String(x));
  return `${dims.join(' × ')}${s.grade ? ` ${s.grade}` : ''}`.trim();
};
