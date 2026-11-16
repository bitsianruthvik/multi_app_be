/**
 * valueWaveReads.js — what resolve() reads, for MANY records at once (2026-11-16).
 *
 * Working one record's values out reads about a dozen things, each its own round trip: the record, the tree above it, its
 * template, the rules that reach it, their pick lists, the values along the chain, the order's values, its BOM parent and
 * that parent's values, its BOM children and theirs. valueService.refreshValues did that record after record, so a large
 * imported order line was thousands of round trips (SO260031 span 1, 362 rows: 2,987 round trips, 434 s on TiDB).
 *
 * refreshValues now takes the records a WAVE at a time (records that do not read each other) and this module loads what
 * the whole wave needs in a fixed number of reads, then answers resolve()'s reads from memory (resolutionService
 * DEFAULT_READS is the same set, read one record at a time).
 *
 *   never changes during a walk   the tree, templates, rules, pick lists, the values on tree nodes and templates, the
 *                                 order's values, the BOMs. Read once and kept for the walk. (The walk writes only the
 *                                 values of the items it works out.)
 *   changes during a walk         the items' own values. Read again for every wave: the wave's own records, the BOM
 *                                 parents they inherit from and the BOM children they roll up. None of those is written
 *                                 while the wave is worked out (that is what makes a wave), so what was read is current.
 *
 * Anything asked for that was not loaded falls through to the ordinary one-record read, so an answer is never wrong
 * for being unprepared, only slower.
 */
import { loadMasters, frozenBy } from './records.js';
import { ancestors } from './tree.js';
import { parseFormula } from './formulaEngine.js';
import { bomsOfParents, linesOfBoms, rollupLines, ROLLUP_VALUE_SELECT, ROLLUP_KIN_SELECT } from './bomGraph.js';
import { DEFAULT_READS, RULE_SELECT, VALUE_SELECT, rulesReaching, chainForMaster } from './resolutionService.js';

const IN_CHUNK = 1000;
const chunks = (xs, n = IN_CHUNK) => { const out = []; for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n)); return out; };
const subjectKey = (type, id) => `${type}:${id}`;
const groupInto = (map, rows, keyOf) => { for (const r of rows) { const k = keyOf(r); if (!map.has(k)) map.set(k, []); map.get(k).push(r); } };

export function waveReader(db, companyId) {
  // kept for the whole walk
  const nodeChains = new Map();    // classification id → its chain of nodes, root first
  const defs = new Map();          // definition id → master row | null
  const rules = new Map();         // subject → rule rows
  const options = new Map();       // specification id → option rows, in the pick list's order
  const narrowed = new Map();      // assignment id → narrowed option rows
  const fixedValues = new Map();   // subject (tree node, template) → value rows
  const orderDefaults = new Map(); // `${orderId}:${lineId}` → rows
  const places = new Map();        // temporary item id → its Custom BOM line and parent | null
  const parents = new Map();       // record id → BOM parent ids
  const tempKids = new Map();      // record id → temporary items directly under it
  const boms = new Map();          // parent id → its BOM's lines | null (no BOM)
  const kin = new Map();           // BOM child id → what it is (ROLLUP_KIN_SELECT row)
  const parsed = new Map();        // formula text → parsed | Error
  // read again for every wave
  let masters = new Map();         // record id → master row
  let ownValues = new Map();       // item id → its value rows
  let childValues = null;          // { codes: Set, byChild: Map child id → rows } | null (no roll-up in this wave)

  const parse = (expression) => {
    if (!parsed.has(expression)) { let p; try { p = parseFormula(expression); } catch (e) { p = e; } parsed.set(expression, p); }
    return parsed.get(expression);
  };

  const reads = {
    parse,
    async ancestors(_db, _c, id) {
      if (id == null) return [];
      if (!nodeChains.has(id)) nodeChains.set(id, await ancestors(db, companyId, id));
      return nodeChains.get(id);
    },
    async loadMaster(_db, _c, id) {
      if (id == null) return null;
      if (!defs.has(id)) defs.set(id, (await loadMasters(db, companyId, [id])).get(Number(id)) ?? null);
      return defs.get(id);
    },
    async loadRules(_db, _c, chain) {
      if (chain.some((s) => !rules.has(subjectKey(s.subjectType, s.subjectId)))) return DEFAULT_READS.loadRules(db, companyId, chain);
      return rulesReaching(chain, chain.flatMap((s) => rules.get(subjectKey(s.subjectType, s.subjectId))));
    },
    async loadOptions(_db, _c, specIds, assignmentIds) {
      if (specIds.some((id) => !options.has(id)) || assignmentIds.some((id) => !narrowed.has(id))) return DEFAULT_READS.loadOptions(db, companyId, specIds, assignmentIds);
      return { options: specIds.flatMap((id) => options.get(id)), narrowed: assignmentIds.flatMap((id) => narrowed.get(id)) };
    },
    async loadValues(_db, _c, chain) {
      const out = [];
      for (const s of chain) {
        const rows = s.self && s.subjectType === 'master' ? ownValues.get(Number(s.subjectId)) : fixedValues.get(subjectKey(s.subjectType, s.subjectId));
        if (!rows) return DEFAULT_READS.loadValues(db, companyId, chain);
        out.push(...rows);
      }
      return out;
    },
    async loadOrderDefaultRows(_db, _c, orderId, lineIds) {
      const k = `${orderId}:${(lineIds ?? []).join(',')}`;
      if (!orderDefaults.has(k)) orderDefaults.set(k, await DEFAULT_READS.loadOrderDefaultRows(db, companyId, orderId, lineIds));
      return orderDefaults.get(k);
    },
    async placementOf(_db, _c, itemId) {
      if (!places.has(Number(itemId))) return DEFAULT_READS.placementOf(db, companyId, itemId);
      return places.get(Number(itemId));
    },
    async storedValues(_db, _c, masterId, specIds) {
      const rows = ownValues.get(Number(masterId));
      if (!rows) return DEFAULT_READS.storedValues(db, companyId, masterId, specIds);
      const want = new Set(specIds.map(Number));
      return new Map(rows.filter((r) => want.has(Number(r.specification_id))).map((r) => [r.specification_id, r]));
    },
    async rollupChildren(_db, _c, parentId, specCodes) {
      const pid = Number(parentId);
      const want = specCodes.map((x) => String(x).toUpperCase());
      if (!boms.has(pid) || (boms.get(pid)?.length && want.length && (!childValues || want.some((x) => !childValues.codes.has(x))))) {
        return DEFAULT_READS.rollupChildren(db, companyId, parentId, specCodes);
      }
      const lines = boms.get(pid);
      if (!lines) return null;
      if (!lines.length) return [];
      const wanted = new Set(want);
      const rows = want.length ? lines.flatMap((l) => (childValues.byChild.get(l.child_id) ?? [])).filter((r) => wanted.has(String(r.code).toUpperCase())) : [];
      // a child on two lines is listed twice above; its values are a map, so reading them twice changes nothing
      return rollupLines(lines, rows, kin);
    },
  };

  /** BOM parents of these records, for the walk and for telling which records read each other. One read for the new ones. */
  async function loadParents(ids) {
    const need = [...new Set(ids.map(Number))].filter((id) => !parents.has(id));
    for (const part of chunks(need)) {
      const [rows] = await db.query(
        `SELECT DISTINCT l.child_id, b.parent_id FROM cf_bom_lines l
           JOIN cf_boms b ON b.id = l.bom_id AND b.deleted_at IS NULL
          WHERE l.company_id = ? AND l.child_id IN (?) AND l.deleted_at IS NULL ORDER BY b.parent_id`,
        [companyId, part],
      );
      for (const id of part) parents.set(id, []);
      for (const r of rows) parents.get(Number(r.child_id)).push(Number(r.parent_id));
    }
  }

  /** Temporary items directly under these records (they may inherit from them). One read for the new ones. */
  async function loadTempChildren(ids) {
    const need = [...new Set(ids.map(Number))].filter((id) => !tempKids.has(id));
    for (const part of chunks(need)) {
      const [rows] = await db.query(
        `SELECT DISTINCT b.parent_id, l.child_id FROM cf_boms b
           JOIN cf_bom_lines l ON l.bom_id = b.id AND l.deleted_at IS NULL
           JOIN cf_item_details i ON i.master_id = l.child_id AND i.item_type = 'temporary' AND i.deleted_at IS NULL
          WHERE b.company_id = ? AND b.parent_id IN (?) AND b.deleted_at IS NULL ORDER BY l.child_id`,
        [companyId, part],
      );
      for (const id of part) tempKids.set(id, []);
      for (const r of rows) tempKids.get(Number(r.parent_id)).push(Number(r.child_id));
    }
  }

  /** Everything the wave's records read, loaded together. → the records to work out (live items), in the order given. */
  async function prepare(ids) {
    masters = await loadMasters(db, companyId, ids);
    const live = ids.map((id) => masters.get(Number(id))).filter((m) => m && m.record_kind === 'item' && !frozenBy(m));
    ownValues = new Map();
    childValues = null;
    if (!live.length) return live;

    // templates, then each record's chain (the tree above it, its template, itself)
    const newDefs = [...new Set(live.filter((m) => m.item_type === 'temporary' && m.source_definition_id).map((m) => Number(m.source_definition_id)))].filter((id) => !defs.has(id));
    if (newDefs.length) {
      const got = await loadMasters(db, companyId, newDefs);
      for (const id of newDefs) defs.set(id, got.get(id) ?? null);
    }
    const chainOf = new Map();
    for (const m of live) chainOf.set(m.id, await chainForMaster(db, companyId, m, reads));

    // rules of every subject not seen before in this walk
    const newSubjects = new Map();
    for (const chain of chainOf.values()) for (const s of chain) { const k = subjectKey(s.subjectType, s.subjectId); if (!rules.has(k)) newSubjects.set(k, s); }
    const subjectWhere = (alias, list) => {
      const nodes = list.filter((s) => s.subjectType === 'classification').map((s) => s.subjectId);
      const recs = list.filter((s) => s.subjectType === 'master').map((s) => s.subjectId);
      const parts = []; const params = [];
      if (nodes.length) { parts.push(`(${alias}.subject_type = 'classification' AND ${alias}.subject_id IN (?))`); params.push(nodes); }
      if (recs.length) { parts.push(`(${alias}.subject_type = 'master' AND ${alias}.subject_id IN (?))`); params.push(recs); }
      return { sql: parts.join(' OR '), params };
    };
    for (const part of chunks([...newSubjects.values()])) {
      const w = subjectWhere('a', part);
      const [rows] = await db.query(`${RULE_SELECT} AND (${w.sql})`, [companyId, ...w.params]);
      for (const s of part) rules.set(subjectKey(s.subjectType, s.subjectId), []);
      groupInto(rules, rows, (r) => subjectKey(r.subject_type, r.subject_id));
    }

    // pick lists of the rules' specifications, and where a rule narrows one
    const waveRules = [...chainOf.values()].flatMap((chain) => chain.flatMap((s) => rules.get(subjectKey(s.subjectType, s.subjectId))));
    const newSpecs = [...new Set(waveRules.map((r) => r.specification_id))].filter((id) => !options.has(id));
    for (const part of chunks(newSpecs)) {
      const [rows] = await db.query(
        `SELECT id, specification_id, value, label, status, sort_order FROM cf_spec_options
          WHERE company_id = ? AND specification_id IN (?) AND deleted_at IS NULL ORDER BY sort_order, value`,
        [companyId, part],
      );
      for (const id of part) options.set(id, []);
      groupInto(options, rows, (r) => r.specification_id);
    }
    const newRules = [...new Set(waveRules.map((r) => r.id))].filter((id) => !narrowed.has(id));
    for (const part of chunks(newRules)) {
      const [rows] = await db.query(
        'SELECT assignment_id, option_id FROM cf_spec_assignment_options WHERE company_id = ? AND assignment_id IN (?) AND deleted_at IS NULL',
        [companyId, part],
      );
      for (const id of part) narrowed.set(id, []);
      groupInto(narrowed, rows, (r) => r.assignment_id);
    }

    // where each temporary item sits (its BOM parent, for an inherited value)
    const newPlaces = live.filter((m) => m.item_type === 'temporary' && !places.has(m.id)).map((m) => m.id);
    for (const part of chunks(newPlaces)) {
      const [rows] = await db.query(
        `SELECT l.child_id, l.id AS line_id, l.bom_id, l.line_no, l.position, l.quantity, l.role, b.parent_id,
                p.code AS parent_code, p.name AS parent_name
           FROM cf_bom_lines l
           JOIN cf_boms b ON b.id = l.bom_id AND b.deleted_at IS NULL AND b.bom_type = 'custom'
           JOIN cf_master_records p ON p.id = b.parent_id AND p.deleted_at IS NULL
          WHERE l.company_id = ? AND l.child_id IN (?) AND l.deleted_at IS NULL ORDER BY l.id`,
        [companyId, part],
      );
      for (const id of part) places.set(id, null);
      for (const r of rows) { if (!places.get(Number(r.child_id))) { const { child_id: _c, ...place } = r; places.set(Number(r.child_id), place); } }
    }

    // values: tree nodes and templates once a walk; the wave's own records and their BOM parents every wave
    const newFixed = new Map();
    for (const chain of chainOf.values()) for (const s of chain) { const k = subjectKey(s.subjectType, s.subjectId); if (!s.self && !fixedValues.has(k)) newFixed.set(k, s); }
    for (const part of chunks([...newFixed.values()])) {
      const w = subjectWhere('v', part);
      const [rows] = await db.query(`${VALUE_SELECT} AND (${w.sql})`, [companyId, ...w.params]);
      for (const s of part) fixedValues.set(subjectKey(s.subjectType, s.subjectId), []);
      groupInto(fixedValues, rows, (r) => subjectKey(r.subject_type, r.subject_id));
    }
    const fresh = [...new Set([...live.map((m) => m.id), ...live.map((m) => places.get(m.id)?.parent_id).filter((id) => id != null).map(Number)])];
    for (const part of chunks(fresh)) {
      const [rows] = await db.query(`${VALUE_SELECT} AND v.subject_type = 'master' AND v.subject_id IN (?)`, [companyId, part]);
      for (const id of part) ownValues.set(id, []);
      groupInto(ownValues, rows, (r) => Number(r.subject_id));
    }

    // roll-ups: the BOM children, when a rule of the wave reads them
    const terms = new Set();
    let rollsUp = false;
    for (const r of waveRules) {
      if (r.value_rule === 'rollup') rollsUp = true;
      if (!r.formula_expression) continue;
      const p = parse(r.formula_expression);
      if (p instanceof Error) continue;
      if (p.usesRollup) rollsUp = true;
      for (const t of p.rollupTerms ?? []) terms.add(String(t).toUpperCase());
    }
    if (rollsUp) {
      const newBoms = live.map((m) => m.id).filter((id) => !boms.has(id));
      for (const part of chunks(newBoms)) {
        const heads = await bomsOfParents(db, companyId, part);
        const lines = heads.size ? await linesOfBoms(db, companyId, [...heads.values()].map((b) => b.id)) : [];
        const byBom = new Map();
        groupInto(byBom, lines, (l) => l.bom_id);
        for (const id of part) { const b = heads.get(id); boms.set(id, b ? (byBom.get(b.id) ?? []) : null); }
        const newKin = [...new Set(lines.map((l) => l.child_id))].filter((id) => !kin.has(id));
        for (const ks of chunks(newKin)) {
          const [rows] = await db.query(ROLLUP_KIN_SELECT, [companyId, ks]);
          for (const r of rows) kin.set(r.id, r);
        }
      }
      childValues = { codes: terms, byChild: new Map() };
      const kids = [...new Set(live.flatMap((m) => (boms.get(m.id) ?? []).filter((l) => l.child_record_kind === 'item').map((l) => l.child_id)))];
      if (terms.size) {
        for (const part of chunks(kids)) {
          const [rows] = await db.query(`${ROLLUP_VALUE_SELECT} AND s.code IN (?)`, [companyId, part, [...terms]]);
          groupInto(childValues.byChild, rows, (r) => r.subject_id);
        }
      }
    }
    return live;
  }

  return {
    reads,
    prepare,
    loadParents,
    loadTempChildren,
    parentsOf: (id) => parents.get(Number(id)) ?? [],
    tempChildrenOf: (id) => tempKids.get(Number(id)) ?? [],
    master: (id) => masters.get(Number(id)) ?? null,
  };
}
