/**
 * orderValuesService.js — every specification value of one order line's
 * structure, read in one go and written in one go. The Values stage of the
 * sales-order flow is built on it.
 *
 *   GET /order-lines/:id/values
 *     -> every node of the line's structure that takes values, grouped by kind
 *        of thing (classification), with each applicable item-level spec:
 *        code, name, data type, unit, rule, required, editable, the value and
 *        its display, and the options of an option spec
 *   PUT /order-lines/:id/values   { dryRun?, writes: [{ recordId, specCode, value }] }
 *     -> one transaction, all or nothing, every problem reported at once
 *
 * WHY THIS IS NOT resolve() AND setValues() IN A LOOP
 * Production is ~49 ms a round trip away, and one bridge is ~220 records.
 * `resolve()` answers one record in about eight queries, so reading a line
 * the old way (useSpecValues' sweep of GET /records/:id/specs) is four figures
 * of round trips. Writing is worse: `setValues` resolves the record, writes it,
 * materialises it and then `refreshValues` walks every parent up to the root,
 * each step another resolve — per record written. Filling the plate parts of
 * one bridge that way is thousands of round trips.
 *
 * So both directions work from ONE load of everything the line's structure
 * touches — its lines, its records, their classification chains, the rules,
 * options and values on every subject in those chains — in a fixed number of
 * queries whatever the size of the structure (see ROUND TRIPS below). The rest
 * happens in memory:
 *
 *   resolveRecord   mirrors resolutionService.resolve() in item mode, reading
 *                   the loaded rows instead of querying. The merge rule, the
 *                   value rules, formulas, roll-ups and inheritance are the same
 *                   code paths, in the same order; the helpers resolve() exports
 *                   (rawOf, displayOf, CAPTURE_DEPTH, TRACK_DEPTH) are reused.
 *                   The test compares it to resolve() record by record, field by
 *                   field, so the two cannot drift silently.
 *   derivedWrites   mirrors valueService.storeDerived's decisions.
 *   refresh         mirrors valueService.refreshValues' walk — parents re-worked
 *                   when a child changes (roll-ups), temporary children when a
 *                   parent changes (inherited values) — until nothing moves.
 *                   Every affected record is re-worked in memory, so a batch of
 *                   any size re-works each record chain ONCE, not once per value.
 *
 * and only then is the NET difference written: one multi-row statement per kind
 * of change (clear / update / insert), the new ids read back by natural key
 * (TiDB does not hand out AUTO_INCREMENT contiguously — valueService explains),
 * and one multi-row INSERT of history rows. processService already goes around
 * resolve() the same way for its stage counts; this is the full mirror because
 * the screen shows and writes every value, not two narrow facts.
 *
 * WHAT MAY BE WRITTEN HERE
 * Only the order's OWN nodes — the temporary items of this line. Catalog items
 * under it (and selections not chosen yet) are shared definitions: shown,
 * read-only, with the structure tree's own words — their values belong to the
 * record itself. On an own node, a person may type what valueService.setValues
 * accepts: `entered`, and `defaulted` (to override the default). `fixed`,
 * `calculated`, `rollup` and `inherited` come back with their worked-out value
 * and the reason they are not typed. A line whose order is closed, lost or
 * cancelled, or which is released to production, is read-only (409 on write),
 * as bomChangeService treats a frozen structure.
 *
 * HISTORY
 * Every value a person typed gets its history row, exactly as setValues writes
 * it. A value the refresh re-worked gets ONE row for its net change: the walk
 * may pass a roll-up several times on its way to the answer, and those
 * intermediate states were never true of anything.
 *
 * ROUND TRIPS (the cost that matters on production)
 *   read    8   line · structure (one recursive CTE) · records · classification
 *               chains (one recursive CTE) · rules · values · options · narrowed
 *               option lists. Rules + values and options + narrowed are
 *               independent, so on a pool they go out together (6 in sequence).
 *   write   8 to load (the line is read FOR UPDATE, so two saves on one order
 *           take turns) + 1 SAVEPOINT + at most one statement per kind of change
 *           (clear, update, insert, read-back, history — chunked per 100-200 rows)
 *           + 1 ROLLBACK TO SAVEPOINT on a dry run. About 15 for a batch of any
 *           realistic size. The only thing that can add more is a temporary item
 *           that is ALSO held by a BOM outside this line's structure — nothing
 *           builds that today; if it ever happens, those outside parents are
 *           handed to valueService.refreshValues after the flush, and it pays
 *           its usual per-record cost for them.
 */
import { invalid, notFound, conflict, translateDbError } from '../lib/errors.js';
import { LOCKED_ORDER_STATUSES, frozenBy } from './records.js';
import { levelName, LEAF_DEPTH } from './tree.js';
import { rawOf, displayOf, dateText, CAPTURE_DEPTH, TRACK_DEPTH } from './resolutionService.js';
import { parseFormula, evaluateFormula } from './formulaEngine.js';
import { coerce, refreshValues } from './valueService.js';

/** explode()'s depth cap, so this screen and the Structure tab stop at the same place. */
const MAX_DEPTH = 15;
/** tree.js walks at most LEAF_DEPTH + 3 nodes up (its MAX_CHAIN); the CTE's hop bound is one less. */
const CHAIN_HOPS = LEAF_DEPTH + 2;
/** valueService.refreshValues' guard against two rules feeding each other through the BOM. */
const MAX_VISITS = 20;
const INSERT_CHUNK = 200;
const UPDATE_CHUNK = 100;
const ID_CHUNK = 500;
/** More writes than this in one request is not a person at a grid. */
const MAX_WRITES = 5000;

const EMPTY = { value_number: null, value_text: null, value_bool: null, value_date: null, option_id: null };
const SET_COLS = ['value_number', 'value_text', 'value_bool', 'value_date', 'option_id', 'uom', 'source'];
const READ_ONLY_RULES = ['fixed', 'calculated', 'rollup', 'inherited'];

const chunk = (xs, n) => {
  const out = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const blank = (v) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
/** How a record is named in a sentence: its code, or — a draft may have none — its name and id. */
const labelOf = (rec) => rec.code ?? `${rec.name} (#${rec.id})`;
const isOwn = (ctx, rec) => rec.record_kind === 'item' && rec.item_type === 'temporary' && rec.owner_order_line_id === ctx.line.id;

/** The structure tree's own words for a node that is not this order's work (BomPanel.whyNotValues). */
const sharedWhy = (rec) => `${rec.code ?? rec.name} is not this order’s own work, so its values belong to the record itself.`;

/* ===========================================================================
 * Loading — everything the line's structure touches, in a fixed number of queries
 * ======================================================================== */

async function loadLine(db, companyId, lineId, { lock }) {
  const [[row]] = await db.query(
    `SELECT ol.id, ol.line_no, ol.line_type, ol.item_id, ol.quantity,
            o.id AS order_id, o.code AS order_code, o.status AS order_status,
            (SELECT r.id FROM cf_production_releases r
              WHERE r.company_id = ol.company_id AND r.order_line_id = ol.id AND r.deleted_at IS NULL LIMIT 1) AS release_id
       FROM cf_sales_order_lines ol
       JOIN cf_sales_orders o ON o.company_id = ol.company_id AND o.id = ol.order_id AND o.deleted_at IS NULL
      WHERE ol.company_id = ? AND ol.id = ? AND ol.deleted_at IS NULL${lock ? ' FOR UPDATE' : ''}`,
    [companyId, lineId],
  );
  if (!row) throw notFound('Order line');
  if (!row.item_id) throw invalid('NO_ITEM', 'This line has no item yet — there are no values to fill.');
  return {
    id: row.id,
    lineNo: row.line_no,
    lineType: row.line_type,
    itemId: row.item_id,
    quantity: Number(row.quantity),
    orderId: row.order_id,
    orderCode: row.order_code,
    orderStatus: row.order_status,
    releaseId: row.release_id ?? null,
  };
}

/**
 * Every live BOM line under the root, in one recursive query — the same lines
 * explode() reads one level at a time. A line reached through several parents
 * (a cut plate three parts are cut from) comes back once, at its shallowest
 * depth. Rows past explode()'s depth cap are dropped and reported, as it does.
 */
const STRUCTURE_SQL = `
  WITH RECURSIVE walk AS (
    SELECT l.id AS line_id, l.child_id AS child_id, CAST(1 AS SIGNED) AS depth
      FROM cf_boms b
      JOIN cf_bom_lines l ON l.company_id = b.company_id AND l.bom_id = b.id AND l.deleted_at IS NULL
     WHERE b.company_id = ? AND b.parent_id = ? AND b.deleted_at IS NULL
     UNION ALL
    SELECT l.id, l.child_id, w.depth + 1
      FROM walk w
      JOIN cf_boms b ON b.company_id = ? AND b.parent_id = w.child_id AND b.deleted_at IS NULL
      JOIN cf_bom_lines l ON l.company_id = b.company_id AND l.bom_id = b.id AND l.deleted_at IS NULL
     WHERE w.depth < ?
  )
  SELECT l.id, l.bom_id, l.line_no, l.child_id, l.position, l.quantity, l.role, l.selection_definition_id,
         b.parent_id, b.bom_type, MIN(w.depth) AS depth
    FROM walk w
    JOIN cf_bom_lines l ON l.id = w.line_id
    JOIN cf_boms b ON b.id = l.bom_id
   GROUP BY l.id, l.bom_id, l.line_no, l.child_id, l.position, l.quantity, l.role, l.selection_definition_id,
            b.parent_id, b.bom_type`;

/**
 * The records, with what loadMaster joins (the owner order and release, which
 * decide frozenBy), the template definition the chain passes through, whether
 * each holds a BOM (a BOM with no lines is "no lines yet", not "no BOM"), and
 * how many live BOM lines anywhere hold it — more than the structure shows
 * means a parent outside this line, which the write path has to hand on.
 * Deleted records are loaded too, flagged: a live line can still point at one,
 * and linesOfBom (what a roll-up reads) does not filter them either.
 */
const RECORDS_SQL = `
  SELECT m.id, m.record_kind, m.code, m.name, m.status, m.classification_id,
         (m.deleted_at IS NOT NULL) AS is_deleted,
         i.item_type, i.tracked_by, i.uom, i.source_definition_id, i.owner_order_line_id,
         d.definition_type,
         sd.id AS def_id, sd.code AS def_code, sd.name AS def_name,
         so.id AS owner_order_id, so.code AS owner_order_code, so.status AS owner_order_status,
         ol.line_no AS owner_line_no, rel.id AS owner_release_id,
         bh.id AS bom_id,
         COALESCE(pl.n, 0) AS placements
    FROM cf_master_records m
    LEFT JOIN cf_item_details i       ON i.master_id = m.id AND i.deleted_at IS NULL
    LEFT JOIN cf_definition_details d ON d.master_id = m.id AND d.deleted_at IS NULL
    LEFT JOIN cf_master_records sd    ON sd.company_id = m.company_id AND sd.id = i.source_definition_id AND sd.deleted_at IS NULL
    LEFT JOIN cf_sales_order_lines ol ON ol.id = i.owner_order_line_id
    LEFT JOIN cf_sales_orders so      ON so.id = ol.order_id
    LEFT JOIN cf_production_releases rel ON rel.order_line_id = ol.id AND rel.deleted_at IS NULL
    LEFT JOIN cf_boms bh ON bh.company_id = m.company_id AND bh.parent_id = m.id AND bh.deleted_at IS NULL
    LEFT JOIN (SELECT l2.child_id, COUNT(*) AS n
                 FROM cf_bom_lines l2
                 JOIN cf_boms b2 ON b2.id = l2.bom_id AND b2.deleted_at IS NULL
                WHERE l2.company_id = ? AND l2.deleted_at IS NULL AND l2.child_id IN (?)
                GROUP BY l2.child_id) pl ON pl.child_id = m.id
   WHERE m.company_id = ? AND m.id IN (?)`;

/** Every classification chain at once: tree.js's CHAIN_SQL, seeded with several nodes. */
const CHAINS_SQL = `
  WITH RECURSIVE chain AS (
    SELECT n.id, n.parent_id, n.depth, n.code, n.name, n.company_id, n.id AS start_id, CAST(0 AS SIGNED) AS hop
      FROM cf_classification_nodes n
     WHERE n.company_id = ? AND n.id IN (?) AND n.deleted_at IS NULL
     UNION ALL
    SELECT p.id, p.parent_id, p.depth, p.code, p.name, p.company_id, c.start_id, c.hop + 1
      FROM chain c
      JOIN cf_classification_nodes p ON p.company_id = c.company_id AND p.id = c.parent_id AND p.deleted_at IS NULL
     WHERE c.hop < ?
  )
  SELECT id, parent_id, depth, code, name, start_id, hop FROM chain`;

/** Two subject kinds, two IN lists: classification 7 and master 7 are different things. */
function subjectScope(alias, clsIds, masterIds) {
  const parts = [];
  const params = [];
  if (clsIds.length) { parts.push(`(${alias}.subject_type = 'classification' AND ${alias}.subject_id IN (?))`); params.push(clsIds); }
  if (masterIds.length) { parts.push(`(${alias}.subject_type = 'master' AND ${alias}.subject_id IN (?))`); params.push(masterIds); }
  return { sql: parts.join(' OR '), params };
}

const subjectKey = (type, id) => `${type}:${id}`;

/**
 * One load. `lock` reads the line FOR UPDATE, so two value saves on one order
 * take turns instead of each re-working roll-ups from what the other has not
 * committed yet.
 */
async function loadContext(db, companyId, lineId, { lock = false } = {}) {
  const line = await loadLine(db, companyId, lineId, { lock });

  // ---- the structure ------------------------------------------------------
  const [lineRows] = await db.query(STRUCTURE_SQL, [companyId, line.itemId, companyId, MAX_DEPTH + 1]);
  const truncated = lineRows.some((l) => Number(l.depth) > MAX_DEPTH);
  const lines = lineRows
    .filter((l) => Number(l.depth) <= MAX_DEPTH)
    .map((l) => ({
      id: l.id, bomId: l.bom_id, lineNo: l.line_no, childId: l.child_id, position: l.position,
      quantity: Number(l.quantity), role: l.role, selectionDefinitionId: l.selection_definition_id,
      parentId: l.parent_id, bomType: l.bom_type, depth: Number(l.depth),
    }));
  // linesOfBom's order — line number, then id — so roll-up children and the
  // screen's row order both read the BOM the way the tree draws it.
  lines.sort((a, b) => a.lineNo - b.lineNo || a.id - b.id);
  const linesByParent = new Map();
  const linesByChild = new Map();
  for (const l of lines) {
    if (!linesByParent.has(l.parentId)) linesByParent.set(l.parentId, []);
    linesByParent.get(l.parentId).push(l);
    if (!linesByChild.has(l.childId)) linesByChild.set(l.childId, []);
    linesByChild.get(l.childId).push(l);
  }

  // ---- the records --------------------------------------------------------
  const ids = [...new Set([line.itemId, ...lines.map((l) => l.childId)])];
  const [recRows] = await db.query(RECORDS_SQL, [companyId, ids, companyId, ids]);
  const records = new Map();
  for (const r of recRows) {
    if (records.has(r.id)) continue; // a second live BOM or release row cannot happen (unique keys); first wins
    records.set(r.id, { ...r, is_deleted: !!Number(r.is_deleted), placements: Number(r.placements) });
  }
  const root = records.get(line.itemId);
  if (!root || root.is_deleted) throw notFound('The item this line sells');

  // ---- classification chains ----------------------------------------------
  const clsSeeds = [...new Set([...records.values()].map((r) => r.classification_id).filter((v) => v != null))];
  const chains = new Map();
  if (clsSeeds.length) {
    const [chainRows] = await db.query(CHAINS_SQL, [companyId, clsSeeds, CHAIN_HOPS]);
    for (const n of chainRows) {
      if (!chains.has(n.start_id)) chains.set(n.start_id, []);
      chains.get(n.start_id).push(n);
    }
    for (const list of chains.values()) list.sort((a, b) => b.hop - a.hop); // root first, as ancestors() returns it
  }

  // ---- rules and values on every subject of every chain ---------------------
  const clsIds = [...new Set([...chains.values()].flat().map((n) => n.id))];
  const masterIds = [...new Set([...records.values()].flatMap((r) => (r.def_id ? [r.id, r.def_id] : [r.id])))];
  const scopeA = subjectScope('a', clsIds, masterIds);
  const scopeV = subjectScope('v', clsIds, masterIds);
  const [[ruleRows], [valueRows]] = await Promise.all([
    db.query(
      `SELECT a.id, a.specification_id, a.subject_type, a.subject_id, a.capture_at, a.is_required, a.is_applicable,
              a.value_rule, a.formula_id, a.sort_order,
              s.code AS spec_code, s.name AS spec_name, s.data_type, s.default_uom, s.decimals,
              f.code AS formula_code, f.name AS formula_name, f.expression AS formula_expression, f.version AS formula_version
         FROM cf_spec_assignments a
         JOIN cf_specifications s ON s.id = a.specification_id AND s.deleted_at IS NULL
         LEFT JOIN cf_formulas f  ON f.id = a.formula_id AND f.deleted_at IS NULL
        WHERE a.company_id = ? AND a.deleted_at IS NULL AND (${scopeA.sql})`,
      [companyId, ...scopeA.params],
    ),
    db.query(
      `SELECT v.*, s.code AS spec_code, s.name AS spec_name, s.data_type, s.decimals
         FROM cf_spec_values v
         JOIN cf_specifications s ON s.id = v.specification_id AND s.deleted_at IS NULL
        WHERE v.company_id = ? AND v.deleted_at IS NULL AND (${scopeV.sql})`,
      [companyId, ...scopeV.params],
    ),
  ]);

  const rulesBySubject = new Map();
  const specMeta = new Map();
  for (const r of ruleRows) {
    const k = subjectKey(r.subject_type, r.subject_id);
    if (!rulesBySubject.has(k)) rulesBySubject.set(k, []);
    rulesBySubject.get(k).push(r);
    if (!specMeta.has(r.specification_id)) {
      specMeta.set(r.specification_id, { code: r.spec_code, name: r.spec_name, data_type: r.data_type, decimals: r.decimals, default_uom: r.default_uom });
    }
  }

  // The value store: subject -> spec -> row. Master rows are what the write
  // path changes; `initial` keeps the loaded maps so the flush can write only
  // the net difference. Rows are never mutated, only replaced.
  const store = new Map();
  for (const v of valueRows) {
    const k = subjectKey(v.subject_type, v.subject_id);
    if (!store.has(k)) store.set(k, new Map());
    store.get(k).set(v.specification_id, v);
  }

  // ---- options and narrowed lists -------------------------------------------
  const specIds = [...specMeta.keys()];
  const ruleIds = ruleRows.map((r) => r.id);
  const [[optionRows], [narrowRows]] = await Promise.all([
    specIds.length
      ? db.query(
        `SELECT id, specification_id, value, label, status, sort_order FROM cf_spec_options
          WHERE company_id = ? AND specification_id IN (?) AND deleted_at IS NULL ORDER BY sort_order, value`,
        [companyId, specIds])
      : [[]],
    ruleIds.length
      ? db.query(
        `SELECT assignment_id, option_id FROM cf_spec_assignment_options
          WHERE company_id = ? AND assignment_id IN (?) AND deleted_at IS NULL`,
        [companyId, ruleIds])
      : [[]],
  ]);
  const optionsBySpec = new Map();
  for (const o of optionRows) {
    if (!optionsBySpec.has(o.specification_id)) optionsBySpec.set(o.specification_id, []);
    optionsBySpec.get(o.specification_id).push(o);
  }
  const narrowedBy = new Map();
  for (const n of narrowRows) {
    if (!narrowedBy.has(n.assignment_id)) narrowedBy.set(n.assignment_id, []);
    narrowedBy.get(n.assignment_id).push(n.option_id);
  }

  return {
    companyId, line, lines, linesByParent, linesByChild, truncated, records, chains,
    rulesBySubject, specMeta, store, optionsBySpec, narrowedBy,
    formulaCache: new Map(),
  };
}

/* ===========================================================================
 * Resolution — resolutionService.resolve(), item mode, over the loaded rows
 * ======================================================================== */

/** chainForMaster: Family -> Subfamily -> Variant -> [its Template Definition] -> the record. */
function chainOf(ctx, rec) {
  const nodes = rec.classification_id != null ? (ctx.chains.get(rec.classification_id) ?? []) : [];
  const chain = nodes.map((n) => ({
    subjectType: 'classification', subjectId: n.id, level: levelName(n.depth), code: n.code, name: n.name, self: false,
  }));
  if (rec.record_kind === 'item' && rec.item_type === 'temporary' && rec.source_definition_id && rec.def_id) {
    chain.push({ subjectType: 'master', subjectId: rec.def_id, level: 'Template definition', code: rec.def_code, name: rec.def_name, self: false });
  }
  chain.push({
    subjectType: 'master', subjectId: rec.id,
    level: rec.record_kind === 'item' ? 'This item' : 'This definition',
    code: rec.code, name: rec.name, self: true,
  });
  return chain;
}

function parsed(ctx, expression) {
  if (!ctx.formulaCache.has(expression)) {
    let p;
    try { p = parseFormula(expression); } catch (e) { p = e; }
    ctx.formulaCache.set(expression, p);
  }
  return ctx.formulaCache.get(expression);
}

/**
 * placementOf: the Custom BOM line that holds a temporary item, and its parent.
 * The query it mirrors takes `LIMIT 1` with no order; for the one item in a
 * hundred that has two places (a shared cut plate), the lowest line id is used.
 */
function placementOf(ctx, itemId) {
  const held = (ctx.linesByChild.get(itemId) ?? [])
    .filter((l) => l.bomType === 'custom' && !ctx.records.get(l.parentId)?.is_deleted)
    .sort((a, b) => a.id - b.id);
  if (!held.length) return null;
  const parent = ctx.records.get(held[0].parentId);
  return { line_id: held[0].id, parent_id: held[0].parentId, parent_code: parent?.code ?? null, parent_name: parent?.name ?? null };
}

/** rollupChildren: one entry per line of the record's BOM, reading each child's stored numbers. */
function rollupChildrenOf(ctx, rec) {
  if (!rec.bom_id) return null;
  const lines = ctx.linesByParent.get(rec.id) ?? [];
  return lines.map((l) => {
    const child = ctx.records.get(l.childId);
    const isItem = child?.record_kind === 'item';
    const name = child ? (child.code ?? child.name) : `#${l.childId}`;
    const own = isItem ? ctx.store.get(subjectKey('master', l.childId)) : null;
    return {
      lineId: l.id,
      label: isItem ? name : `${name} (not chosen yet)`,
      quantity: Number(l.quantity),
      get: (code) => {
        if (!isItem || !own) return null;
        for (const row of own.values()) {
          if (row.value_number != null && String(row.spec_code).toUpperCase() === code) return Number(row.value_number);
        }
        return null;
      },
    };
  });
}

/**
 * The same object resolve() returns for an item — mode, chain, specs,
 * missingRequired, problems, unassignedValues, frozen and `internal` — built
 * from the loaded rows. Kept in resolve()'s own order, statement for
 * statement, so the two read side by side.
 */
function resolveRecord(ctx, rec) {
  const chain = chainOf(ctx, rec);
  const mode = rec.record_kind === 'item' ? 'item' : 'setup';
  const levelOf = new Map(chain.map((s, i) => [subjectKey(s.subjectType, s.subjectId), i]));
  const selfIndex = chain.findIndex((s) => s.self);
  const aboveTop = selfIndex >= 0 ? selfIndex - 1 : chain.length - 1;

  const rules = [];
  for (const s of chain) {
    for (const r of ctx.rulesBySubject.get(subjectKey(s.subjectType, s.subjectId)) ?? []) {
      rules.push({ ...r, levelIndex: levelOf.get(subjectKey(r.subject_type, r.subject_id)) });
    }
  }
  rules.sort((a, b) => a.levelIndex - b.levelIndex || a.sort_order - b.sort_order || a.id - b.id);

  const merged = new Map();
  for (const r of rules) {
    const key = `${r.specification_id}:${r.capture_at}`;
    const prev = merged.get(key);
    merged.set(key, { rule: r, overridden: prev ? [...prev.overridden, prev.rule] : [] });
  }
  const specIds = [...new Set(rules.map((r) => r.specification_id))];
  const options = specIds.flatMap((id) => ctx.optionsBySpec.get(id) ?? []);
  const optionById = new Map(options.map((o) => [o.id, o]));

  const valueAt = new Map();
  const values = [];
  chain.forEach((s, i) => {
    const rows = ctx.store.get(subjectKey(s.subjectType, s.subjectId));
    if (!rows) return;
    for (const v of rows.values()) { valueAt.set(`${i}:${v.specification_id}`, v); values.push({ v, i }); }
  });
  const ownRow = (specId) => (selfIndex >= 0 ? valueAt.get(`${selfIndex}:${specId}`) ?? null : null);
  const aboveRow = (specId) => {
    for (let i = aboveTop; i >= 0; i--) {
      const v = valueAt.get(`${i}:${specId}`);
      if (v) return { row: v, levelIndex: i };
    }
    return null;
  };
  const trackDepth = mode !== 'item' ? Infinity : TRACK_DEPTH[rec.tracked_by ?? 'quantity'];
  const frozen = frozenBy(rec);
  const winning = [...merged.values()].map((m) => m.rule);

  const inheritedSpecIds = mode === 'item' && !frozen
    ? winning.filter((r) => r.is_applicable && r.capture_at === 'item' && r.value_rule === 'inherited').map((r) => r.specification_id)
    : [];
  let parentPlace = null;
  let parentRows = new Map();
  if (inheritedSpecIds.length && rec.item_type === 'temporary') {
    parentPlace = placementOf(ctx, rec.id);
    if (parentPlace) {
      const rows = ctx.store.get(subjectKey('master', parentPlace.parent_id)) ?? new Map();
      parentRows = new Map(inheritedSpecIds.filter((id) => rows.has(id)).map((id) => [id, rows.get(id)]));
    }
  }

  const specs = [];
  const effectiveRows = new Map();
  for (const { rule: r, overridden } of merged.values()) {
    const spec = { id: r.specification_id, code: r.spec_code, name: r.spec_name, dataType: r.data_type, unit: r.default_uom, decimals: r.decimals };
    let allowed;
    if (r.data_type === 'option') {
      const narrowIds = new Set(ctx.narrowedBy.get(r.id) ?? []);
      allowed = options
        .filter((o) => o.specification_id === r.specification_id && o.status === 'active' && (!narrowIds.size || narrowIds.has(o.id)))
        .map((o) => ({ id: o.id, value: o.value, label: o.label }));
    }
    const entry = {
      spec,
      captureAt: r.capture_at,
      applicable: !!r.is_applicable,
      capturable: CAPTURE_DEPTH[r.capture_at] <= trackDepth,
      rule: {
        assignmentId: r.id,
        valueRule: r.value_rule,
        isRequired: !!r.is_required,
        formula: r.formula_id ? { id: r.formula_id, code: r.formula_code, name: r.formula_name, expression: r.formula_expression, version: r.formula_version } : null,
        sortOrder: r.sort_order,
      },
      definedAt: { level: chain[r.levelIndex].level, subjectType: r.subject_type, subjectId: r.subject_id, code: chain[r.levelIndex].code, name: chain[r.levelIndex].name },
      overrides: overridden.map((o) => ({ level: chain[o.levelIndex].level, valueRule: o.value_rule, applicable: !!o.is_applicable })),
      options: allowed,
      value: null,
      status: 'empty',
    };
    specs.push(entry);

    if (!entry.applicable) { entry.status = 'switched_off'; continue; }
    if (r.capture_at !== 'item') { entry.status = entry.capturable ? 'captured_later' : 'not_capturable'; continue; }

    const own = ownRow(spec.id);
    const above = aboveRow(spec.id);
    const view = (row, source, from) => {
      const raw = rawOf(row, spec.dataType);
      if (raw === null) return null;
      const v = { raw, display: displayOf(raw, spec, optionById), source, from };
      if (spec.dataType === 'option') v.optionValue = optionById.get(raw)?.value ?? null;
      return v;
    };

    if (frozen) {
      if (own) entry.value = view(own, own.source, 'here');
      entry.status = 'frozen';
      continue;
    }

    switch (r.value_rule) {
      case 'entered':
        if (own) { entry.value = view(own, own.source, 'here'); entry.status = 'set'; effectiveRows.set(spec.id, own); }
        break;
      case 'defaulted':
        if (own && own.source === 'entered') { entry.value = view(own, 'entered', 'here'); entry.status = 'set'; effectiveRows.set(spec.id, own); }
        else if (above) { entry.value = view(above.row, 'defaulted', chain[above.levelIndex].level); entry.status = 'default'; effectiveRows.set(spec.id, above.row); }
        break;
      case 'fixed':
        if (above) {
          entry.value = view(above.row, 'fixed', chain[above.levelIndex].level);
          entry.status = 'fixed';
          effectiveRows.set(spec.id, above.row);
          if (own && own.source === 'entered' && rawOf(own, spec.dataType) !== entry.value.raw) entry.conflict = 'An entered value here is overridden by the fixed value.';
        } else {
          entry.status = 'no_fixed_value';
          entry.problem = `The rule says fixed, but no value is set at ${entry.definedAt.level.toLowerCase()} level or above.`;
        }
        break;
      case 'inherited': {
        if (rec.item_type !== 'temporary') {
          entry.status = 'no_parent';
          entry.note = 'A catalog item sits in many BOMs, so it has no single parent to inherit from.';
          break;
        }
        if (!parentPlace) {
          entry.status = 'no_parent';
          entry.note = 'This is the item a sales order line sells — it has no BOM parent.';
          break;
        }
        const parentLabel = parentPlace.parent_code ?? parentPlace.parent_name;
        const row = parentRows.get(spec.id);
        if (!row) { entry.status = 'waiting_parent'; entry.missingInputs = [`${parentLabel} · ${spec.code}`]; break; }
        entry.value = view(row, 'inherited', `parent ${parentLabel}`);
        entry.status = 'inherited';
        effectiveRows.set(spec.id, row);
        if (allowed && row.option_id != null && !allowed.some((o) => o.id === row.option_id)) {
          entry.problem = `${entry.value?.display} from the parent is not allowed here.`;
        }
        break;
      }
      default:
        break; // calculated and rollup: second pass
    }
    if (entry.rule.isRequired && !entry.value && ['entered', 'defaulted'].includes(r.value_rule)) entry.status = 'missing';
  }

  if (mode === 'item' && !frozen) {
    const lookup = new Map();
    for (const s of specs) if (s.value && s.spec.dataType === 'number') lookup.set(s.spec.code, s.value.raw);
    const calc = specs.filter((s) => s.applicable && s.captureAt === 'item' && ['calculated', 'rollup'].includes(s.rule.valueRule));
    const parsedOf = new Map();
    for (const s of calc) {
      if (!s.rule.formula) continue;
      parsedOf.set(s, parsed(ctx, s.rule.formula.expression));
    }
    let children = null;
    if (calc.some((s) => s.rule.valueRule === 'rollup')) children = rollupChildrenOf(ctx, rec);
    const done = new Set();
    let moved = true;
    while (moved) {
      moved = false;
      for (const s of calc) {
        if (done.has(s)) continue;
        const isRollup = s.rule.valueRule === 'rollup';
        if (!s.rule.formula) { s.status = 'formula_missing'; done.add(s); moved = true; continue; }
        const p = parsedOf.get(s);
        if (p instanceof Error) { s.status = 'formula_error'; s.problem = p.message; done.add(s); moved = true; continue; }
        if (isRollup && (!children || !children.length)) {
          s.status = 'no_bom';
          s.note = children ? 'Its BOM has no lines yet.' : 'It has no BOM to roll up.';
          done.add(s); moved = true; continue;
        }
        const waiting = p.references.some((code) => !lookup.has(code) && calc.some((o) => o.spec.code === code && !done.has(o)));
        if (waiting) continue;
        const out = evaluateFormula(p, (code) => (lookup.has(code) ? lookup.get(code) : null), isRollup ? children : null);
        done.add(s);
        moved = true;
        if (out.value === null) {
          s.status = out.missing ? 'waiting_inputs' : 'formula_error';
          if (out.missing) s.missingInputs = out.missing;
          if (out.error) s.problem = out.error;
        } else {
          s.value = {
            raw: out.value,
            display: displayOf(out.value, s.spec, optionById),
            source: isRollup ? 'rollup' : 'calculated',
            from: isRollup ? `BOM · ${children.length} line${children.length === 1 ? '' : 's'}` : `formula ${s.rule.formula.code}`,
          };
          s.status = isRollup ? 'rollup' : 'calculated';
          lookup.set(s.spec.code, out.value);
          effectiveRows.set(s.spec.id, { value_number: out.value, value_text: null, value_bool: null, value_date: null, option_id: null });
        }
      }
    }
    for (const s of calc) {
      if (!done.has(s)) { s.status = 'formula_cycle'; s.problem = 'This formula depends on itself through other calculated values.'; }
    }
  }

  specs.sort((a, b) => CAPTURE_DEPTH[a.captureAt] - CAPTURE_DEPTH[b.captureAt]
    || a.rule.sortOrder - b.rule.sortOrder || a.spec.code.localeCompare(b.spec.code));

  const resolvedItemSpecs = new Set(specs.filter((s) => s.applicable && s.captureAt === 'item').map((s) => s.spec.id));
  const ownRows = new Map();
  if (selfIndex >= 0) for (const { v, i } of values) if (i === selfIndex) ownRows.set(v.specification_id, v);
  const unassigned = [...ownRows.values()]
    .filter((v) => !resolvedItemSpecs.has(v.specification_id))
    .map((v) => ({ code: v.spec_code, name: v.spec_name, source: v.source, raw: rawOf(v, v.data_type) }));

  return {
    mode,
    chain: chain.map(({ subjectType, subjectId, level, code, name, self }) => ({ subjectType, subjectId, level, code, name, self })),
    specs,
    missingRequired: specs.filter((s) => s.status === 'missing').map((s) => ({ code: s.spec.code, name: s.spec.name })),
    problems: specs.filter((s) => s.problem).map((s) => `${s.spec.code}: ${s.problem}`),
    unassignedValues: unassigned,
    frozen,
    internal: { ownRows, effectiveRows },
  };
}

/* ===========================================================================
 * Writing in memory — valueService's upsert, storeDerived and refreshValues
 * ======================================================================== */

/**
 * valueService.sameValue. Its `typed` side is always fresh ('YYYY-MM-DD'
 * strings); here either side can also be a row as the driver returned it (a
 * DATE as a Date), so both dates go through dateText — which leaves a
 * 'YYYY-MM-DD' string exactly as it was.
 */
function sameValue(row, typed) {
  const num = (x) => (x == null ? null : Number(x));
  const a = num(row.value_number);
  const b = num(typed.value_number);
  if ((a === null) !== (b === null) || (a !== null && Math.abs(a - b) > 1e-9)) return false;
  return (row.value_text ?? null) === (typed.value_text ?? null)
    && (row.value_bool == null ? null : Number(row.value_bool)) === (typed.value_bool == null ? null : Number(typed.value_bool))
    && dateText(row.value_date) === dateText(typed.value_date)
    && (row.option_id ?? null) === (typed.option_id ?? null);
}

/** valueService.snapshot — what a history row records. */
function snapshot(row, source, uom) {
  if (!row) return null;
  return {
    number: row.value_number == null ? null : Number(row.value_number),
    text: row.value_text ?? null,
    bool: row.value_bool == null ? null : !!Number(row.value_bool),
    date: dateText(row.value_date),
    option_id: row.option_id ?? null,
    uom: uom ?? row.uom ?? null,
    source: source ?? row.source,
  };
}

function ownStore(ctx, recordId) {
  const k = subjectKey('master', recordId);
  if (!ctx.store.has(k)) ctx.store.set(k, new Map());
  return ctx.store.get(k);
}

/**
 * valueService.applyWrites, against the store: writes applied in order, each
 * seeing the one before, no-ops dropped (same value AND same source). Returns
 * the change records. Rows are replaced, never mutated, so `initial` still
 * holds what was loaded.
 */
function applyToStore(ctx, recordId, writes) {
  const rows = ownStore(ctx, recordId);
  const changes = [];
  for (const w of writes) {
    const row = rows.get(w.spec.id) ?? null;
    if (!w.typed) {
      if (!row) continue;
      rows.delete(w.spec.id);
      changes.push({ recordId, specId: w.spec.id, spec: w.spec.code, change: 'cleared', source: row.source });
      continue;
    }
    if (row && sameValue(row, w.typed) && row.source === w.source) continue;
    const meta = ctx.specMeta.get(w.spec.id) ?? {};
    rows.set(w.spec.id, {
      specification_id: w.spec.id, subject_type: 'master', subject_id: recordId,
      ...EMPTY, ...w.typed,
      uom: w.spec.default_uom ?? null, // locked to the spec's unit for now (Q11), as valueService does
      source: w.source,
      spec_code: meta.code ?? w.spec.code, spec_name: meta.name ?? null, data_type: meta.data_type ?? null, decimals: meta.decimals ?? null,
    });
    changes.push({ recordId, specId: w.spec.id, spec: w.spec.code, change: row ? 'changed' : 'set', source: w.source });
  }
  return changes;
}

/** valueService.storeDerived's decisions: the values an item's rules produce, and the derived ones no rule produces any more. */
function derivedWrites(r) {
  const { ownRows, effectiveRows } = r.internal;
  const writes = [];
  const touch = (s, typed, source) => {
    writes.push({ spec: { id: s.spec.id, code: s.spec.code, default_uom: s.spec.unit }, typed, source });
  };
  const typedOf = (row) => (row ? {
    value_number: row.value_number == null ? null : Number(row.value_number),
    value_text: row.value_text ?? null,
    value_bool: row.value_bool == null ? null : Number(row.value_bool),
    value_date: dateText(row.value_date),
    option_id: row.option_id ?? null,
  } : null);

  const produced = new Set();
  for (const s of r.specs) {
    if (!s.applicable || s.captureAt !== 'item') continue;
    produced.add(s.spec.id);
    const own = ownRows.get(s.spec.id) ?? null;
    switch (s.rule.valueRule) {
      case 'fixed':
        if (s.value) touch(s, typedOf(effectiveRows.get(s.spec.id)), 'fixed');
        else if (own && own.source === 'fixed') touch(s, null, 'fixed');
        break;
      case 'defaulted':
        if (own && own.source === 'entered') break;
        if (s.value) touch(s, typedOf(effectiveRows.get(s.spec.id)), 'defaulted');
        else if (own) touch(s, null, 'defaulted');
        break;
      case 'calculated':
        if (s.status === 'calculated') touch(s, { ...EMPTY, value_number: s.value.raw }, 'calculated');
        else if (own) touch(s, null, 'calculated');
        break;
      case 'rollup':
        if (s.status === 'rollup') touch(s, { ...EMPTY, value_number: s.value.raw }, 'rollup');
        else if (own) touch(s, null, 'rollup');
        break;
      case 'inherited':
        if (s.status === 'inherited') touch(s, typedOf(effectiveRows.get(s.spec.id)), 'inherited');
        else if (own) touch(s, null, 'inherited');
        break;
      case 'entered':
        if (own && own.source !== 'entered') touch(s, null, own.source);
        break;
      default:
        break;
    }
  }
  for (const own of ownRows.values()) {
    if (!produced.has(own.specification_id) && own.source !== 'entered') {
      writes.push({ spec: { id: own.specification_id, code: own.spec_code, default_uom: own.uom }, typed: null, source: own.source });
    }
  }
  return writes;
}

/** valueService.materialize: a live, unfrozen item re-worked from its rules. */
function materializeInMemory(ctx, recordId) {
  const rec = ctx.records.get(recordId);
  if (!rec || rec.is_deleted || rec.record_kind !== 'item' || frozenBy(rec)) return [];
  return applyToStore(ctx, recordId, derivedWrites(resolveRecord(ctx, rec)));
}

/** parentsOf + tempChildrenOf, inside the structure: who reads this record's values. */
function neighboursOf(ctx, id) {
  const out = [];
  for (const l of ctx.linesByChild.get(id) ?? []) if (!out.includes(l.parentId)) out.push(l.parentId);
  for (const l of ctx.linesByParent.get(id) ?? []) {
    const child = ctx.records.get(l.childId);
    if (child?.item_type === 'temporary' && !out.includes(l.childId)) out.push(l.childId);
  }
  return out;
}

/**
 * valueService.refreshValues with startWithNeighbours: the given records have
 * changed, so their neighbours are re-worked, and theirs in turn, until nothing
 * moves. Returns every change the walk made.
 */
function refreshInMemory(ctx, changedIds) {
  const queue = [];
  const queued = new Set();
  const visits = new Map();
  const push = (id) => { if (!queued.has(id)) { queued.add(id); queue.push(id); } };
  for (const id of changedIds) for (const n of neighboursOf(ctx, id)) push(n);
  const changes = [];
  while (queue.length) {
    const id = queue.shift();
    queued.delete(id);
    const n = (visits.get(id) ?? 0) + 1;
    visits.set(id, n);
    if (n > MAX_VISITS) {
      const m = ctx.records.get(id);
      throw invalid('VALUE_LOOP', `Values on ${m?.code ?? m?.name ?? id} keep changing each other through the BOM — a roll-up and an inherited rule probably feed each other. Check the rules on this structure.`);
    }
    const ch = materializeInMemory(ctx, id);
    if (ch.length) { changes.push(...ch); for (const k of neighboursOf(ctx, id)) push(k); }
  }
  return changes;
}

/** What the store held when the line was loaded — the flush writes the difference from it. */
function storeAsLoaded(ctx) {
  const initial = new Map();
  for (const rec of ctx.records.values()) {
    const rows = ctx.store.get(subjectKey('master', rec.id));
    initial.set(rec.id, rows ? new Map(rows) : new Map());
  }
  return initial;
}

/** Every (record, specification) pair a pass touched, in the order first touched — what flush() walks. */
function changeLog() {
  const order = { records: [], specsOf: new Map() };
  const note = (changes) => {
    for (const ch of changes) {
      if (!order.specsOf.has(ch.recordId)) { order.specsOf.set(ch.recordId, []); order.records.push(ch.recordId); }
      const list = order.specsOf.get(ch.recordId);
      if (!list.includes(ch.specId)) list.push(ch.specId);
    }
  };
  return { order, note };
}

/**
 * The values of records JUST CREATED under a line: valueService.materialize for
 * each of them, deepest first, then one walk from everything that moved — what
 * the per-item path reaches, in this engine's fixed number of statements.
 *
 * The batched template copy (instantiationService) calls it instead of one
 * materialize per new item and a refreshValues over all of them afterwards. On
 * a 203-item bridge span that refresh alone was 1,483 round trips (~73 s on
 * production, ~49 ms each) and changed nothing, because the per-item pass had
 * already arrived; here the loading is 8 statements and the writing a handful.
 * The line is open — the records were created a moment ago. Returns
 * { records, values }: how many records changed, how many value rows were written.
 */
export async function materializeLineRecords(db, c, lineId, recordIds) {
  const ctx = await loadContext(db, c.companyId, lineId);
  const initial = storeAsLoaded(ctx);
  const { order, note } = changeLog();
  const depthOf = new Map([[ctx.line.itemId, 0], ...ctx.lines.map((l) => [l.childId, l.depth])]);
  const ids = [...new Set([...recordIds].map(Number))]
    .filter((id) => ctx.records.has(id))
    .sort((a, b) => (depthOf.get(b) ?? 0) - (depthOf.get(a) ?? 0));
  const moved = [];
  for (const id of ids) {
    const own = materializeInMemory(ctx, id);
    note(own);
    if (own.length) moved.push(id);
  }
  note(refreshInMemory(ctx, moved));
  const flushed = order.records.length ? await flush(db, c, ctx, initial, order) : { values: 0 };
  return { records: order.records.length, values: flushed.values };
}

/* ===========================================================================
 * The flush — the net difference, in a fixed number of statements
 * ======================================================================== */

async function flush(db, c, ctx, initial, order) {
  const clears = [];
  const updates = [];
  const inserts = [];
  const history = []; // in the order the changes were first made
  for (const recordId of order.records) {
    const before = initial.get(recordId) ?? new Map();
    const after = ctx.store.get(subjectKey('master', recordId)) ?? new Map();
    for (const specId of order.specsOf.get(recordId) ?? []) {
      const b = before.get(specId) ?? null;
      const a = after.get(specId) ?? null;
      if (!b && !a) continue;
      if (b && !a) {
        clears.push(b.id);
        history.push({ recordId, specId, valueId: b.id, changeType: 'delete', before: snapshot(b), after: null });
      } else if (!b && a) {
        inserts.push({ recordId, specId, row: a });
        history.push({ recordId, specId, valueId: null, changeType: 'create', before: null, after: snapshot(a, a.source, a.uom) });
      } else if (!(sameValue(b, a) && b.source === a.source)) {
        updates.push({ id: b.id, row: a });
        history.push({ recordId, specId, valueId: b.id, changeType: 'update', before: snapshot(b), after: snapshot(a, a.source, a.uom) });
      }
    }
  }
  if (!history.length) return { values: 0, history: [] };

  for (const part of chunk(clears, INSERT_CHUNK)) {
    await db.query('UPDATE cf_spec_values SET deleted_at = NOW() WHERE company_id = ? AND id IN (?)', [c.companyId, part]);
  }
  for (const part of chunk(updates, UPDATE_CHUNK)) {
    // valueService.updateRows: one CASE per column, and every id in the WHERE has a WHEN.
    const params = [];
    const sets = SET_COLS.map((col) => {
      const whens = part.map((u) => { params.push(u.id, u.row[col] ?? null); return 'WHEN ? THEN ?'; }).join(' ');
      return `${col} = CASE id ${whens} END`;
    }).join(', ');
    params.push(c.companyId, part.map((u) => u.id));
    await db.query(`UPDATE cf_spec_values SET ${sets} WHERE company_id = ? AND id IN (?)`, params);
  }
  for (const part of chunk(inserts, INSERT_CHUNK)) {
    const params = [];
    for (const { recordId, specId, row } of part) {
      params.push(c.companyId, specId, 'master', recordId, row.value_number, row.value_text, row.value_bool,
        row.value_date, row.option_id, row.uom ?? null, row.source, c.userId);
    }
    await db.query(
      `INSERT INTO cf_spec_values
         (company_id, specification_id, subject_type, subject_id, value_number, value_text, value_bool, value_date, option_id, uom, source, created_by)
       VALUES ${part.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
      params,
    );
  }
  if (inserts.length) {
    // The new rows' ids, by their natural key — uq_csv_value makes each
    // (spec, subject) match exactly the row this flush inserted.
    const wanted = new Set(inserts.map((i) => `${i.recordId}:${i.specId}`));
    const found = new Map();
    const subjects = [...new Set(inserts.map((i) => i.recordId))];
    const specs = [...new Set(inserts.map((i) => i.specId))];
    for (const part of chunk(subjects, ID_CHUNK)) {
      const [rows] = await db.query(
        `SELECT id, subject_id, specification_id FROM cf_spec_values
          WHERE company_id = ? AND subject_type = 'master' AND subject_id IN (?) AND specification_id IN (?) AND deleted_at IS NULL`,
        [c.companyId, part, specs],
      );
      for (const r of rows) {
        const k = `${r.subject_id}:${r.specification_id}`;
        if (wanted.has(k)) found.set(k, r.id);
      }
    }
    for (const h of history) {
      if (h.changeType !== 'create') continue;
      h.valueId = found.get(`${h.recordId}:${h.specId}`);
      if (!h.valueId) throw new Error(`cf_erp: value row for specification ${h.specId} on master ${h.recordId} vanished between insert and read-back.`);
    }
  }
  for (const part of chunk(history, INSERT_CHUNK)) {
    const params = [];
    for (const h of part) {
      params.push(c.companyId, h.valueId, h.specId, 'master', h.recordId, h.changeType,
        h.before ? JSON.stringify(h.before) : null, h.after ? JSON.stringify(h.after) : null, c.userId);
    }
    await db.query(
      `INSERT INTO cf_spec_value_history
         (company_id, value_id, specification_id, subject_type, subject_id, change_type, old_value, new_value, changed_by)
       VALUES ${part.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
      params,
    );
  }
  return { values: clears.length + updates.length + inserts.length, history };
}

/* ===========================================================================
 * The screen's shape
 * ======================================================================== */

/** Why a value that applies is not typed here — said on the cell. */
function whyReadOnly(s) {
  const vr = s.rule.valueRule;
  const waiting = s.missingInputs?.length ? ` — waiting for ${s.missingInputs.slice(0, 3).join(', ')}${s.missingInputs.length > 3 ? ` and ${s.missingInputs.length - 3} more` : ''}` : '';
  if (vr === 'fixed') {
    const at = s.definedAt.name ? ` (${s.definedAt.name})` : '';
    return s.value
      ? `Fixed at ${s.definedAt.level.toLowerCase()} level${at} — change it there.`
      : `Fixed at ${s.definedAt.level.toLowerCase()} level${at}, but no value is set there yet.`;
  }
  if (vr === 'calculated') return `Worked out by ${s.rule.formula ? `formula ${s.rule.formula.code}` : 'a formula'} from this item’s other values${waiting}.`;
  if (vr === 'rollup') return `Added up from the BOM below${s.rule.formula ? ` (${s.rule.formula.code})` : ''}${waiting}.`;
  if (vr === 'inherited') return `Taken from the BOM parent${s.value?.from ? ` — ${s.value.from.replace(/^parent /, '')}` : ''}${waiting}.`;
  return null;
}

/** What an input starts at: the record's own typed value — a default from above is not its own. */
function ownInput(s) {
  const own = s.value && (s.value.source === 'entered' || s.rule.valueRule === 'entered');
  if (!own) return '';
  const raw = s.value.raw;
  if (raw === null || raw === undefined) return '';
  if (typeof raw === 'boolean') return raw ? 'true' : 'false';
  return String(raw);
}

/**
 * The GET body (and the `view` a PUT hands back): rows are records, once each
 * however many places hold them, in the order the tree draws them; grouped by
 * whose they are (the order's own first) and by classification.
 *
 * KEPT SMALL ON PURPOSE. The backend sends JSON uncompressed, and a bridge is
 * ~220 rows of ~11 values. So what is the same for a whole column — its rule,
 * whether it is required, why it cannot be typed, its option list — is said
 * once on the column, and a cell carries a field only when it differs from its
 * column or says something (an own value, a worked-out value, a gap, a
 * problem). A cell with no fields is an empty value that follows the column.
 *
 *   column { code, name, dataType, unit, decimals, rule, required, why?, options?, editable }
 *   cell   { input?, display?, defaultDisplay?, missing?, rule?, required?, why?, problem?, note?, options? }
 *
 *   input           the record's OWN typed value, as an input edits it (an option's id)
 *   display         the value in words, for a value that is not typed here
 *   defaultDisplay  a Defaulted rule's default, shown while nothing is typed
 *   editable        on the column: any row may type it. A cell is typed when its
 *                   rule is entered or defaulted, its row has no `readOnly`, and
 *                   the view is `editable` — the server refuses anything else.
 */
function buildView(ctx) {
  const { line } = ctx;
  const lock = LOCKED_ORDER_STATUSES.has(line.orderStatus)
    ? { reason: 'closed', message: `Order ${line.orderCode} is ${line.orderStatus}, so everything made for it is frozen — its values are kept as they were.` }
    : line.releaseId
      ? { reason: 'released', message: `Line ${line.lineNo} of ${line.orderCode} was released to production, so its values are frozen. Take the release back — while nothing has started — to change them.` }
      : null;

  // First visit in tree order gives each record its depth and the parent it is shown under.
  const order = [];
  const seen = new Map();
  const walk = (id, depth, viaLine) => {
    if (seen.has(id)) return;
    seen.set(id, { depth, viaLine });
    order.push(id);
    for (const l of ctx.linesByParent.get(id) ?? []) walk(l.childId, depth + 1, l);
  };
  walk(line.itemId, 0, null);

  const optionLists = {};
  const optionKeys = new Map();
  const optionsKey = (s) => {
    const sig = `${s.spec.id}:${s.options.map((o) => o.id).join(',')}`;
    if (!optionKeys.has(sig)) {
      const key = `o${optionKeys.size + 1}`;
      optionKeys.set(sig, key);
      optionLists[key] = s.options.map((o) => ({ id: o.id, value: o.value, label: o.label }));
    }
    return optionKeys.get(sig);
  };

  // ---- every row, every cell, in full --------------------------------------
  const groups = new Map();
  const counts = { rows: 0, own: 0, shared: 0, missingOwn: 0, missingShared: 0, rowsMissing: 0, unresolved: 0, noValues: 0 };
  for (const id of order) {
    const rec = ctx.records.get(id);
    if (!rec || rec.is_deleted) continue;
    if (rec.record_kind !== 'item') { counts.unresolved += 1; continue; } // a selection not chosen yet
    const r = resolveRecord(ctx, rec);
    const applicable = r.specs.filter((s) => s.applicable && s.captureAt === 'item');
    if (!applicable.length) { counts.noValues += 1; continue; }

    const own = isOwn(ctx, rec);
    // A locked line says so once, on the view — every own item of a closed
    // order is frozen with it, so repeating that on each row says nothing. A
    // row only says what is true of IT alone.
    const rowWhy = !own ? sharedWhy(rec)
      : r.frozen && !lock ? `${labelOf(rec)} is frozen with order ${r.frozen.orderCode}.`
        : null;
    const full = new Map();
    let missing = 0;
    for (const s of applicable) {
      const typeable = ['entered', 'defaulted'].includes(s.rule.valueRule);
      const cell = {
        rule: s.rule.valueRule,
        required: s.rule.isRequired,
        typeable,
        input: typeable ? ownInput(s) : '',
        // A typed value is shown by its input; only a value that is not typed here needs words.
        display: typeable ? null : s.value?.display ?? null,
        defaultDisplay: s.rule.valueRule === 'defaulted' && s.value && s.value.source !== 'entered' ? s.value.display : null,
        missing: s.status === 'missing',
        why: typeable ? null : whyReadOnly(s),
        problem: s.problem ?? null,
        note: s.note ?? s.conflict ?? null,
        options: s.spec.dataType === 'option' && s.options ? optionsKey(s) : null,
      };
      if (cell.missing) missing += 1;
      full.set(s.spec.code, { s, cell });
    }

    const at = seen.get(id);
    const parent = at.viaLine ? ctx.records.get(at.viaLine.parentId) : null;
    const classificationId = rec.classification_id ?? null;
    const nodes = classificationId != null ? (ctx.chains.get(classificationId) ?? []) : [];
    const leaf = nodes[nodes.length - 1];
    const groupKey = `${own ? 'own' : 'shared'}:${classificationId ?? 'none'}`;
    if (!groups.has(groupKey)) {
      groups.set(groupKey, {
        key: groupKey,
        own,
        classification: { id: classificationId, code: leaf?.code ?? null, name: leaf?.name ?? 'Not classified', path: nodes.map((n) => n.name).join(' › ') },
        columns: new Map(),
        rows: [],
      });
    }
    const g = groups.get(groupKey);
    for (const [code, { s, cell }] of full) {
      if (!g.columns.has(code)) {
        g.columns.set(code, {
          code, name: s.spec.name, dataType: s.spec.dataType, unit: s.spec.unit, decimals: s.spec.decimals,
          sortOrder: s.rule.sortOrder, first: g.columns.size, cells: [], editable: false,
        });
      }
      const col = g.columns.get(code);
      col.cells.push(cell);
      if (cell.typeable && !rowWhy && !lock) col.editable = true;
    }
    const row = {
      id: rec.id,
      code: rec.code,
      name: rec.name,
      kind: rec.item_type,
      status: rec.status,
      depth: at.depth,
      parent: parent ? { id: parent.id, code: parent.code, name: parent.name } : null,
      places: (ctx.linesByChild.get(id) ?? []).length,
      lineNo: at.viaLine?.lineNo ?? null,
      position: at.viaLine?.position ?? null,
      quantity: at.viaLine ? at.viaLine.quantity : line.quantity,
      missing,
      full,
    };
    if (rowWhy) row.readOnly = rowWhy;
    g.rows.push(row);
    counts.rows += 1;
    if (own) { counts.own += 1; counts.missingOwn += missing; } else { counts.shared += 1; counts.missingShared += missing; }
    if (missing) counts.rowsMissing += 1;
  }

  // ---- what a whole column shares is said once, on the column -----------------
  const commonest = (xs) => {
    const n = new Map();
    for (const x of xs) n.set(x, (n.get(x) ?? 0) + 1);
    let best = xs[0];
    for (const [x, k] of n) if (k > (n.get(best) ?? 0)) best = x;
    return best;
  };
  const shapeGroup = (g) => {
    const columns = [...g.columns.values()]
      .sort((a, b) => a.sortOrder - b.sortOrder || a.first - b.first)
      .map((col) => ({
        code: col.code, name: col.name, dataType: col.dataType, unit: col.unit, decimals: col.decimals,
        rule: commonest(col.cells.map((x) => x.rule)),
        required: commonest(col.cells.map((x) => x.required)),
        why: commonest(col.cells.map((x) => x.why)),
        options: commonest(col.cells.map((x) => x.options)),
        editable: col.editable,
      }));
    const byCode = new Map(columns.map((col) => [col.code, col]));
    const rows = g.rows.map(({ full, ...row }) => {
      const cells = {};
      for (const [code, { cell }] of full) {
        const col = byCode.get(code);
        const out = {};
        if (cell.input !== '') out.input = cell.input;
        if (cell.display != null) out.display = cell.display;
        if (cell.defaultDisplay != null) out.defaultDisplay = cell.defaultDisplay;
        if (cell.missing) out.missing = true;
        if (cell.rule !== col.rule) out.rule = cell.rule;
        if (cell.required !== col.required) out.required = cell.required;
        if (cell.why !== col.why) out.why = cell.why;
        if (cell.problem) out.problem = cell.problem;
        if (cell.note) out.note = cell.note;
        if (cell.options !== col.options) out.options = cell.options;
        cells[code] = out;
      }
      return { ...row, cells };
    });
    for (const col of columns) {
      if (col.why == null) delete col.why;
      if (col.options == null) delete col.options;
    }
    return { key: g.key, own: g.own, classification: g.classification, columns, rows };
  };

  // The order's own work first, then shared records; each in the order its first row appears.
  const list = [...groups.values()].sort((a, b) => Number(b.own) - Number(a.own));
  const root = ctx.records.get(line.itemId);
  return {
    line: { id: line.id, lineNo: line.lineNo, lineType: line.lineType, quantity: line.quantity },
    order: { id: line.orderId, code: line.orderCode, status: line.orderStatus },
    root: { id: root.id, code: root.code, name: root.name },
    editable: !lock,
    lock,
    truncated: ctx.truncated,
    counts,
    optionLists,
    groups: list.map(shapeGroup),
  };
}

/* ===========================================================================
 * The two entry points
 * ======================================================================== */

/** GET /order-lines/:id/values */
export async function readLineValues(db, companyId, lineId) {
  return buildView(await loadContext(db, companyId, lineId));
}

/** Every write as given, or the problem with its shape. */
function readWrites(input, problems) {
  if (!Array.isArray(input)) { problems.push('writes must be a list of { recordId, specCode, value }.'); return []; }
  if (input.length > MAX_WRITES) { problems.push(`Up to ${MAX_WRITES} values can be saved at once — this is ${input.length}.`); return []; }
  const out = [];
  input.forEach((w, i) => {
    const where = `Value ${i + 1}`;
    if (!w || typeof w !== 'object') { problems.push(`${where} is not a { recordId, specCode, value }.`); return; }
    const recordId = Number(w.recordId);
    if (!Number.isInteger(recordId) || recordId <= 0) { problems.push(`${where}: recordId must be a positive whole number.`); return; }
    if (blank(w.specCode) || typeof w.specCode !== 'string') { problems.push(`${where}: specCode is required.`); return; }
    const value = w.value === undefined ? null : w.value;
    if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) { problems.push(`${where}: value must be text, a number, yes/no or null.`); return; }
    out.push({ index: i, recordId, specCode: w.specCode.trim().toUpperCase(), value });
  });
  return out;
}

/**
 * valueService.coerce, with option lists answered from what is already loaded
 * (coerce reads them per call) — the same matching, in the same order: by id,
 * then by value ignoring case; retired refused; then the narrowed list.
 */
async function coerceFor(db, ctx, s, value) {
  const spec = { id: s.spec.id, code: s.spec.code, data_type: s.spec.dataType };
  if (s.spec.dataType !== 'option') return coerce(db, ctx.companyId, spec, value, null);
  if (value === null || value === undefined || value === '') return { typed: null };
  const options = ctx.optionsBySpec.get(s.spec.id) ?? [];
  const found = options.find((o) => o.id === Number(value))
    ?? options.find((o) => o.value.toLowerCase() === String(value).trim().toLowerCase());
  if (!found) return { problem: `"${value}" is not an option of ${spec.code}.` };
  if (found.status !== 'active') return { problem: `Option ${found.value} of ${spec.code} is retired.` };
  const allowed = s.options ? new Set(s.options.map((o) => o.id)) : null;
  if (allowed && allowed.size && !allowed.has(found.id)) return { problem: `${found.value} is not allowed for ${spec.code} here.` };
  return { typed: { ...EMPTY, option_id: found.id } };
}

let savepointNo = 0;

/**
 * PUT /order-lines/:id/values — { dryRun?, writes: [{ recordId, specCode, value }] }.
 * Needs a transaction (it takes a savepoint on the caller's connection).
 *
 * Every problem that can be found without writing comes back together, as one
 * 422 whose `problems` name the row and the specification ("CODE · SPEC: …");
 * `detail.cells` carries the same as { recordId, specCode, problem }. Nothing
 * is written unless everything is right. A dry run is the real write inside a
 * SAVEPOINT, rolled back — so it reports exactly what a save would do.
 */
export async function writeLineValues(db, c, lineId, input = {}) {
  const dryRun = input.dryRun === true || input.dryRun === 'true' || input.dryRun === 1 || input.dryRun === '1';
  const shapeProblems = [];
  const writes = readWrites(input.writes, shapeProblems);
  if (shapeProblems.length) throw invalid('INVALID', `${dryRun ? 'These values cannot be saved' : 'Nothing was saved'} — ${plural(shapeProblems.length, 'problem')} to fix first.`, { problems: shapeProblems });

  const ctx = await loadContext(db, c.companyId, lineId, { lock: true });
  const { line } = ctx;
  if (LOCKED_ORDER_STATUSES.has(line.orderStatus)) {
    throw conflict('ORDER_CLOSED', `Order ${line.orderCode} is ${line.orderStatus} — its values can no longer change.`);
  }
  if (line.releaseId) {
    throw conflict('RELEASED', `Line ${line.lineNo} of ${line.orderCode} was released to production — its values are frozen. Take the release back, while nothing has started, to change them.`);
  }

  // ---- check everything before writing anything ----------------------------
  const problems = [];
  const cells = [];
  const say = (rec, specCode, text) => {
    const head = rec ? labelOf(rec) : null;
    const p = specCode ? `${head ?? 'Record'} · ${specCode}: ${text}` : `${head ?? 'Record'}: ${text}`;
    problems.push(p);
    cells.push({ recordId: rec?.id ?? null, specCode: specCode ?? null, problem: p });
  };
  const inStructure = new Set([line.itemId, ...ctx.lines.map((l) => l.childId)]);
  const resolutions = new Map();
  const plan = new Map(); // recordId -> [{ spec, typed, source }]
  const seen = new Set();
  for (const w of writes) {
    const rec = ctx.records.get(w.recordId);
    if (!rec || rec.is_deleted || !inStructure.has(w.recordId)) {
      problems.push(`Record #${w.recordId} is not part of line ${line.lineNo}’s structure — it may have changed since the screen was opened. Reload it and make the change again.`);
      cells.push({ recordId: w.recordId, specCode: w.specCode, problem: problems[problems.length - 1] });
      continue;
    }
    if (!isOwn(ctx, rec)) {
      say(rec, null, rec.record_kind === 'item' && rec.item_type === 'temporary'
        ? 'belongs to another line’s structure — its values are changed there.'
        : `is not this order’s own work, so its values belong to the record itself — change them on ${rec.code ?? rec.name}.`);
      continue;
    }
    const f = frozenBy(rec);
    if (f) { say(rec, null, f.reason === 'released' ? `was released to production with line ${f.lineNo} of ${f.orderCode} — its values can no longer change.` : `belongs to order ${f.orderCode}, which is ${f.orderStatus} — its values can no longer change.`); continue; }
    const key = `${w.recordId}:${w.specCode}`;
    if (seen.has(key)) { say(rec, w.specCode, 'is given twice — say it once.'); continue; }
    seen.add(key);

    if (!resolutions.has(rec.id)) resolutions.set(rec.id, resolveRecord(ctx, rec));
    const r = resolutions.get(rec.id);
    const s = r.specs.find((x) => x.captureAt === 'item' && x.spec.code.toUpperCase() === w.specCode);
    if (!s || !s.applicable) {
      const later = r.specs.find((x) => x.applicable && x.captureAt !== 'item' && x.spec.code.toUpperCase() === w.specCode);
      say(rec, w.specCode, later
        ? `is recorded on each ${later.captureAt === 'batch' ? 'batch' : 'unit'}, not on the item.`
        : 'is not part of this item’s setup.');
      continue;
    }
    const vr = s.rule.valueRule;
    if (vr === 'fixed') { say(rec, s.spec.code, `is fixed at ${s.definedAt.level.toLowerCase()} level — change it there.`); continue; }
    if (READ_ONLY_RULES.includes(vr)) { say(rec, s.spec.code, `is ${vr === 'rollup' ? 'a roll-up' : vr} — it cannot be typed in.`); continue; }
    const out = await coerceFor(db, ctx, s, w.value);
    if (out.problem) {
      // coerce's sentences start with the spec code; the head already says it.
      say(rec, s.spec.code, out.problem.startsWith(`${s.spec.code} `) ? out.problem.slice(s.spec.code.length + 1) : out.problem);
      continue;
    }
    if (!plan.has(rec.id)) plan.set(rec.id, []);
    plan.get(rec.id).push({ spec: { id: s.spec.id, code: s.spec.code, default_uom: s.spec.unit }, typed: out.typed, source: 'entered' });
  }
  if (problems.length) {
    throw invalid('INVALID', `${dryRun ? 'These values cannot be saved' : 'Nothing was saved'} — ${plural(problems.length, 'problem')} to fix first.`, { problems, detail: { cells } });
  }

  // ---- work it out in memory ----------------------------------------------
  // `initial` is what was loaded; the store is changed from here on, and the
  // flush writes the difference between the two for every pair `order` names.
  const initial = storeAsLoaded(ctx);
  const { order, note } = changeLog();
  // setValues, for every record at once: the typed values, then the record's
  // own derived values, then ONE walk from everything that moved. Deepest
  // first, so a parent is worked out after the children written with it.
  const depthOf = new Map([[line.itemId, 0], ...ctx.lines.map((l) => [l.childId, l.depth])]);
  const written = [...plan.keys()].sort((a, b) => (depthOf.get(b) ?? 0) - (depthOf.get(a) ?? 0));
  const typedChanges = [];
  const moved = [];
  for (const id of written) {
    const typed = applyToStore(ctx, id, plan.get(id));
    typedChanges.push(...typed);
    note(typed);
    const own = materializeInMemory(ctx, id);
    note(own);
    if (typed.length || own.length) moved.push(id);
  }
  note(refreshInMemory(ctx, moved));

  // ---- write the net difference -------------------------------------------
  let flushed = { values: 0, history: [] };
  let view = null;
  if (order.records.length) {
    const sp = `cf_order_values_${savepointNo += 1}`;
    await db.query(`SAVEPOINT ${sp}`);
    try {
      flushed = await flush(db, c, ctx, initial, order);
      // A parent OUTSIDE this structure reads one of these records too. Nothing
      // builds that today; if it ever happens, valueService does the rest from
      // the flushed rows, at its own per-record cost — and the grid is read
      // again, since that walk may come back into this structure.
      const outside = order.records.filter((id) => {
        const rec = ctx.records.get(id);
        return rec && rec.placements > (ctx.linesByChild.get(id) ?? []).length;
      });
      if (outside.length) {
        const [rows] = await db.query(
          `SELECT DISTINCT b.parent_id FROM cf_bom_lines l
             JOIN cf_boms b ON b.id = l.bom_id AND b.deleted_at IS NULL
            WHERE l.company_id = ? AND l.child_id IN (?) AND l.deleted_at IS NULL`,
          [c.companyId, outside],
        );
        const parents = rows.map((r) => r.parent_id).filter((id) => !inStructure.has(id));
        if (parents.length) {
          await refreshValues(db, c, parents);
          view = buildView(await loadContext(db, c.companyId, lineId));
        }
      }
      if (dryRun) await db.query(`ROLLBACK TO SAVEPOINT ${sp}`);
    } catch (err) {
      try { await db.query(`ROLLBACK TO SAVEPOINT ${sp}`); } catch { /* the original error is the one that matters */ }
      throw translateDbError(err);
    }
  }

  // What a person changed, and what followed from it — counted from what the
  // flush actually wrote, so a roll-up that went round and came back to where
  // it started is not counted as a change.
  const typedPairs = new Set(typedChanges.map((ch) => `${ch.recordId}:${ch.specId}`));
  const derived = flushed.history.filter((h) => !typedPairs.has(`${h.recordId}:${h.specId}`));
  const records = new Set(flushed.history.map((h) => h.recordId)).size;
  const sentence = !typedChanges.length
    ? 'Nothing changed — every value was already as given.'
    : `${plural(typedChanges.length, 'value')} ${dryRun ? 'would be saved' : 'saved'}`
      + (derived.length ? `; ${plural(derived.length, 'worked-out value')} ${dryRun ? 'would follow' : 'followed'}` : '')
      + ` across ${plural(records, 'item')}.`;

  return {
    applied: !dryRun,
    dryRun,
    summary: {
      sentence,
      given: writes.length,
      changed: typedChanges.length,
      derived: derived.length,
      records,
      rowsWritten: flushed.values,
      historyRows: flushed.history.length,
    },
    changes: typedChanges.map((ch) => {
      const rec = ctx.records.get(ch.recordId);
      return { recordId: ch.recordId, code: rec?.code ?? null, specCode: ch.spec, change: ch.change };
    }),
    // What the grid looks like now (for a dry run: what it WOULD look like),
    // worked out from the same rows that were just written — no second read.
    view: view ?? buildView(ctx),
  };
}

/** For the test: the mirror, exposed so it can be compared with resolve() record by record. */
export async function resolveLineRecords(db, companyId, lineId) {
  const ctx = await loadContext(db, companyId, lineId);
  const out = new Map();
  for (const rec of ctx.records.values()) {
    if (rec.is_deleted || rec.record_kind !== 'item') continue;
    const { internal, ...pub } = resolveRecord(ctx, rec);
    out.set(rec.id, pub);
  }
  return out;
}
