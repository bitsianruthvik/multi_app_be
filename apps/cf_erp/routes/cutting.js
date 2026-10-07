/**
 * cutting.js — Setup › Cutting and the section stock picker (CF_ERP_CUT_FROM_PLAN.md §3.4, §11.2).
 *
 *   GET  /cut-places          { plate: Place, section: Place, sectionSettings: { sawKerfMm, endTrimMm, minOffcutMm },
 *                               problems: string[], flows: { plate: FlowRef|null, section: FlowRef|null } }
 *                             Place = { blanksNode: NodeRef|null, offcutNode: NodeRef|null, stockNodes: NodeRef[] },
 *                             NodeRef = { id, code, name, path }  ("Steel › Plates › Cut plate")
 *   PUT  /cut-places          { plate?: { blanksNodeId?, offcutNodeId?, stockNodeIds? }, section?: { … },
 *                               sectionSettings?: { sawKerfMm?, endTrimMm?, minOffcutMm? }, sectionFlowId? } -> the same
 *                             blanks / offcut nodes: live leaves that hold items (not machine or definition-only);
 *                             stock nodes: live, not machine; a null node id clears it. Catalog manage.
 *   GET  /section-stock?search=&limit=50
 *                             [{ id, code, name, thickness, width, depth, lengthMm, sectionArea, grade, nodeName }]
 *                             catalog items filed under the section stock places; the search ignores spaces and
 *                             reads "x" and "×" alike, so "75x75x8" finds ISA 75 × 75 × 8 in every stock length.
 *   GET  /flows/cut-sections  { flow } — the flow a new cut section takes (production view)
 *   PUT  /flows/cut-sections  { flowId } — null clears it (production manage)
 */
import { Router } from 'express';
import { pool, withTransaction } from '../lib/db.js';
import { PERM, guard, handle, ctx } from '../lib/http.js';
import { invalid, assertNoProblems } from '../lib/errors.js';
import { cutPlaces, CUT_KINDS } from '../lib/cutPlaces.js';
import { sectionSteelOf } from '../lib/cutFrom.js';
import { getCutPlateFlow, getCutSectionFlow, setCutSectionFlow, requireUsableFlow } from '../services/flowService.js';

const router = Router();
const tx = (req, fn) => withTransaction((db) => fn(db, ctx(req)));
const KIND_WORD = { plate: 'Plate', section: 'Section' };

/** NodeRefs for some node ids, each with its path from the family down. One query. */
async function nodeRefs(db, companyId, ids) {
  const want = [...new Set(ids.filter((x) => x != null).map(Number))];
  const out = new Map();
  if (!want.length) return out;
  const [rows] = await db.query(
    `WITH RECURSIVE up AS (
       SELECT n.id AS seed, n.id, n.parent_id, n.code, n.name, CAST(0 AS SIGNED) AS hop
         FROM cf_classification_nodes n WHERE n.company_id = ? AND n.id IN (?) AND n.deleted_at IS NULL
        UNION ALL
       SELECT up.seed, p.id, p.parent_id, p.code, p.name, up.hop + 1
         FROM up JOIN cf_classification_nodes p ON p.company_id = ? AND p.id = up.parent_id
        WHERE up.hop < 8
     )
     SELECT seed, id, code, name, hop FROM up`,
    [companyId, want, companyId],
  );
  const bySeed = new Map();
  for (const r of rows) {
    if (!bySeed.has(Number(r.seed))) bySeed.set(Number(r.seed), []);
    bySeed.get(Number(r.seed)).push(r);
  }
  for (const [seed, list] of bySeed) {
    list.sort((a, b) => Number(b.hop) - Number(a.hop));
    const self = list[list.length - 1];
    out.set(seed, { id: seed, code: self.code, name: self.name, path: list.map((n) => n.name ?? n.code).join(' › ') });
  }
  return out;
}

async function placesView(db, companyId) {
  const places = await cutPlaces(db, companyId);
  const ids = CUT_KINDS.flatMap((k) => [places[k].blanksNodeId, places[k].offcutNodeId, ...places[k].stockNodeIds]);
  const [refs, plateFlow, sectionFlow] = await Promise.all([nodeRefs(db, companyId, ids), getCutPlateFlow(db, companyId), getCutSectionFlow(db, companyId)]);
  const place = (k) => ({
    blanksNode: places[k].blanksNodeId != null ? refs.get(places[k].blanksNodeId) ?? null : null,
    offcutNode: places[k].offcutNodeId != null ? refs.get(places[k].offcutNodeId) ?? null : null,
    stockNodes: places[k].stockNodeIds.map((id) => refs.get(id)).filter(Boolean),
  });
  return {
    plate: place('plate'),
    section: place('section'),
    sectionSettings: { ...places.settings },
    problems: places.problems.map((p) => p.text),
    flows: { plate: plateFlow.flow, section: sectionFlow.flow },
  };
}

/** The live nodes asked for, with whether each has live children. One query. */
async function nodesOf(db, companyId, ids) {
  const want = [...new Set(ids.map(Number))];
  if (!want.length) return new Map();
  const [rows] = await db.query(
    `SELECT n.id, n.code, n.name, n.scope,
            EXISTS (SELECT 1 FROM cf_classification_nodes c WHERE c.company_id = n.company_id AND c.parent_id = n.id AND c.deleted_at IS NULL) AS has_children
       FROM cf_classification_nodes n
      WHERE n.company_id = ? AND n.id IN (?) AND n.deleted_at IS NULL`,
    [companyId, want],
  );
  return new Map(rows.map((r) => [Number(r.id), r]));
}

const idOrNull = (v, what, problems) => {
  if (v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) { problems.push(`${what} must be a classification node id, or null to clear it.`); return undefined; }
  return n;
};

const MM = { sawKerfMm: [0, 50, 'Saw kerf'], endTrimMm: [0, 1000, 'End trim'], minOffcutMm: [0, 100000, 'Minimum offcut'] };

async function savePlaces(db, c, input = {}) {
  const { companyId } = c;
  const problems = [];
  const asked = {};
  for (const kind of CUT_KINDS) {
    const k = input[kind];
    if (k == null) continue;
    if (typeof k !== 'object') { problems.push(`${kind} must be an object of node ids.`); continue; }
    const a = {};
    if (k.blanksNodeId !== undefined) a.blanks = idOrNull(k.blanksNodeId, `${KIND_WORD[kind]} cut pieces`, problems);
    if (k.offcutNodeId !== undefined) a.offcut = idOrNull(k.offcutNodeId, `${KIND_WORD[kind]} offcuts`, problems);
    if (k.stockNodeIds !== undefined) {
      if (!Array.isArray(k.stockNodeIds)) problems.push(`${KIND_WORD[kind]} stock must be a list of classification node ids.`);
      else a.stock = [...new Set(k.stockNodeIds.map((v) => idOrNull(v, `${KIND_WORD[kind]} stock`, problems)).filter((x) => x != null))];
    }
    asked[kind] = a;
  }
  assertNoProblems(problems);
  // What is not being changed stays as it is — the checks below read both.
  const current = await cutPlaces(db, companyId);
  for (const [kind, a] of Object.entries(asked)) {
    if (a.blanks === undefined) a.keepBlanks = current[kind].blanksNodeId;
    if (a.offcut === undefined) a.keepOffcut = current[kind].offcutNodeId;
  }
  const nodes = await nodesOf(db, companyId, Object.values(asked).flatMap((a) => [a.blanks, a.offcut, ...(a.stock ?? [])]).filter((x) => x != null));
  for (const [kind, a] of Object.entries(asked)) {
    const word = KIND_WORD[kind];
    for (const [role, label] of [['blanks', 'cut pieces'], ['offcut', 'offcuts']]) {
      if (a[role] == null) continue;
      const n = nodes.get(a[role]);
      if (!n) { problems.push(`${word} ${label}: node ${a[role]} does not exist.`); continue; }
      if (Number(n.has_children)) problems.push(`${word} ${label}: ${n.name ?? n.code} has nodes under it — records are filed at the lowest level, so choose a node with none.`);
      if (!['item', 'both'].includes(n.scope)) problems.push(`${word} ${label}: ${n.name ?? n.code} holds ${n.scope === 'machine' ? 'machines' : 'definitions only'} — choose a node that holds items.`);
    }
    const blanksAt = a.blanks !== undefined ? a.blanks : a.keepBlanks;
    const offcutAt = a.offcut !== undefined ? a.offcut : a.keepOffcut;
    if (blanksAt != null && offcutAt != null && blanksAt === offcutAt) problems.push(`${word}: cut pieces and offcuts cannot be filed at the same node — an offcut would be taken for a cut piece.`);
    for (const id of a.stock ?? []) {
      const n = nodes.get(id);
      if (!n) problems.push(`${word} stock: node ${id} does not exist.`);
      else if (n.scope === 'machine') problems.push(`${word} stock: ${n.name ?? n.code} holds machines, not stock.`);
    }
  }
  // Plate and section cut pieces apart, so a blank's method can be told from where it is filed.
  const blanksOf = (k) => (asked[k]?.blanks !== undefined ? asked[k].blanks : current[k].blanksNodeId);
  if ((asked.plate || asked.section) && blanksOf('plate') != null && blanksOf('plate') === blanksOf('section')) problems.push('Plate and section cut pieces cannot be filed at the same node.');
  let settings = null;
  if (input.sectionSettings != null) {
    settings = {};
    for (const [key, [min, max, label]] of Object.entries(MM)) {
      const v = input.sectionSettings[key];
      if (v === undefined) continue;
      const n = Number(v);
      if (!Number.isFinite(n) || n < min || n > max) problems.push(`${label} is a number of millimetres from ${min} to ${max}.`);
      else settings[key] = Number(n.toFixed(2));
    }
  }
  let sectionFlowId;
  if (input.sectionFlowId !== undefined) {
    sectionFlowId = input.sectionFlowId == null || input.sectionFlowId === '' ? null : await requireUsableFlow(db, companyId, input.sectionFlowId, problems);
  }
  assertNoProblems(problems);

  for (const [kind, a] of Object.entries(asked)) {
    await db.query(
      'INSERT INTO cf_cut_places (company_id, kind, updated_by) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE updated_by = VALUES(updated_by)',
      [companyId, kind, c.userId ?? null],
    );
    const [[row]] = await db.query('SELECT id FROM cf_cut_places WHERE company_id = ? AND kind = ?', [companyId, kind]);
    const sets = {};
    if (a.blanks !== undefined) sets.blanks_node_id = a.blanks;
    if (a.offcut !== undefined) sets.offcut_node_id = a.offcut;
    if (Object.keys(sets).length) {
      await db.query(`UPDATE cf_cut_places SET ${Object.keys(sets).map((k) => `${k} = ?`).join(', ')}, updated_by = ? WHERE company_id = ? AND id = ?`,
        [...Object.values(sets), c.userId ?? null, companyId, row.id]);
    }
    if (a.stock !== undefined) {
      // The list replaces the old one: a link row is a setting, not a record with a history.
      await db.query(
        `DELETE FROM cf_cut_place_stock WHERE company_id = ? AND place_id = ?${a.stock.length ? ' AND node_id NOT IN (?)' : ''}`,
        a.stock.length ? [companyId, row.id, a.stock] : [companyId, row.id],
      );
      if (a.stock.length) {
        await db.query(
          `INSERT IGNORE INTO cf_cut_place_stock (company_id, place_id, node_id) VALUES ${a.stock.map(() => '(?, ?, ?)').join(', ')}`,
          a.stock.flatMap((id) => [companyId, row.id, id]),
        );
      }
    }
  }
  if (settings && Object.keys(settings).length) {
    const cols = { sawKerfMm: 'saw_kerf_mm', endTrimMm: 'end_trim_mm', minOffcutMm: 'min_offcut_mm' };
    const keys = Object.keys(settings);
    await db.query(
      `INSERT INTO cf_section_settings (company_id, ${keys.map((k) => cols[k]).join(', ')}, updated_by) VALUES (?, ${keys.map(() => '?').join(', ')}, ?)
       ON DUPLICATE KEY UPDATE ${keys.map((k) => `${cols[k]} = VALUES(${cols[k]})`).join(', ')}, updated_by = VALUES(updated_by)`,
      [companyId, ...keys.map((k) => settings[k]), c.userId ?? null],
    );
  }
  if (sectionFlowId !== undefined) await setCutSectionFlow(db, c, { flowId: sectionFlowId });
  return placesView(db, companyId);
}

/** "75 X 75×8" -> "75x75x8": spaces out, × read as x, one case. */
const normalise = (s) => String(s ?? '').toLowerCase().replace(/×/g, 'x').replace(/[\s\-_]+/g, '');

async function sectionStock(db, companyId, q = {}) {
  const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 200);
  const places = await cutPlaces(db, companyId);
  if (!places.section.stockIds.size) return [];
  const term = normalise(q.search);
  const like = term ? `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%` : null;
  // The same normalising in SQL: spaces, dashes and underscores out, × as x, lower case.
  const norm = (col) => `REPLACE(REPLACE(REPLACE(REPLACE(LOWER(${col}), '×', 'x'), ' ', ''), '-', ''), '_', '')`;
  const [rows] = await db.query(
    `SELECT m.id, m.code, m.name, n.name AS node_name
       FROM cf_master_records m
       JOIN cf_item_details i ON i.master_id = m.id AND i.item_type = 'catalog' AND i.deleted_at IS NULL
       JOIN cf_classification_nodes n ON n.id = m.classification_id
      WHERE m.company_id = ? AND m.deleted_at IS NULL AND m.status <> 'obsolete' AND m.classification_id IN (?)
        ${like ? `AND (${norm('m.name')} LIKE ? OR ${norm('m.code')} LIKE ?)` : ''}
      ORDER BY m.name, m.id
      LIMIT ?`,
    [companyId, [...places.section.stockIds], ...(like ? [like, like] : []), limit],
  );
  const steel = await sectionSteelOf(db, companyId, rows.map((r) => r.id));
  return rows.map((r) => {
    const st = steel.get(r.id) ?? {};
    return {
      id: r.id, code: r.code, name: r.name,
      thickness: st.thickness ?? null, width: st.width ?? null, depth: st.depth ?? null,
      lengthMm: st.lengthMm ?? null, sectionArea: st.sectionArea ?? null, grade: st.grade ?? null,
      nodeName: r.node_name,
    };
  });
}

router.get('/cut-places', guard(PERM.view), handle((req) => placesView(pool, ctx(req).companyId)));
router.put('/cut-places', guard(PERM.catalog), handle((req) => tx(req, (db, c) => {
  if (req.body == null || typeof req.body !== 'object') throw invalid('INVALID', 'Send the places to change.');
  return savePlaces(db, c, req.body);
})));
router.get('/section-stock', guard(PERM.view), handle((req) => sectionStock(pool, ctx(req).companyId, req.query)));
router.get('/flows/cut-sections', guard(PERM.productionView), handle((req) => getCutSectionFlow(pool, ctx(req).companyId)));
router.put('/flows/cut-sections', guard(PERM.production), handle((req) => tx(req, (db, c) => setCutSectionFlow(db, c, req.body ?? {}))));

export { placesView, savePlaces, sectionStock };
export default router;
