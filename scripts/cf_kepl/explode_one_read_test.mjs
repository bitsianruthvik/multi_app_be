/**
 * explode_one_read_test.mjs — bomService.explode reads every level of a structure in ONE
 * round trip (bomGraph.linesUnderParent, speed 2026-10-19) instead of one read per level.
 * Proves the walk sees exactly what the per-level reads gave it, on every BOM in the
 * local database, and that the round trips no longer grow with the depth. Reads only.
 *
 *   cd multi_app_be
 *   node scripts/cf_kepl/explode_one_read_test.mjs
 *
 * For every live BOM parent of every company:
 *   - the per-level walk (linesOfBomsWithChildBom, level by level, following each child's
 *     own BOM — what readExplode did before) and the one-read walk (linesUnderParent's rows,
 *     grouped by BOM and taken level by level the way readExplode takes them now) give the
 *     same rows, in the same order, at every depth — also with a depth cap of 1 and 2;
 *   - the root's flows read beside the root (through its detail row) equal the read that
 *     waited for the root (by root.source_definition_id);
 *   - explode() itself: the same nodes as the per-level walk, and a fixed number of round
 *     trips whatever the depth (≤ 5 plain; the KEPL line's 5-level structure included).
 */
import { pool } from '../../db.js';
import '../../apps/cf_erp/services/codegenProvider.js';
import { linesOfBomsWithChildBom, linesUnderParent, bomOfParent } from '../../apps/cf_erp/services/bomGraph.js';
import { requireMaster } from '../../apps/cf_erp/services/records.js';
import { explode } from '../../apps/cf_erp/services/bomService.js';

let passed = 0;
let failed = 0;
const fails = [];
function ok(label, cond, detail = '') {
  if (cond) { passed += 1; console.log(`  PASS  ${label}`); } else { failed += 1; fails.push(label); console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
}
function counting(db) {
  const tally = { n: 0 };
  const proxy = new Proxy(db, { get: (t, p) => (p === 'query' || p === 'execute' ? (...a) => { tally.n += 1; return t[p](...a); } : Reflect.get(t, p)) });
  return { db: proxy, tally };
}
const rowKey = (l) => JSON.stringify(l);

/** The levels as the per-level reads gave them: depth -> rows, following every child that has a BOM. */
async function levelsByReads(db, companyId, rootBomId, maxDepth) {
  const out = [];
  let frontier = rootBomId ? [rootBomId] : [];
  for (let depth = 1; frontier.length && depth <= maxDepth; depth++) {
    const rows = await linesOfBomsWithChildBom(db, companyId, [...new Set(frontier)]);
    out.push(rows.map(rowKey));
    frontier = rows.filter((r) => r.cb_id).map((r) => r.cb_id);
  }
  return out;
}

/** The same levels from the one read, taken as readExplode takes them. */
function levelsFromOneRead(rows, rootBomId, maxDepth) {
  const byBom = new Map();
  for (const l of rows) { if (!byBom.has(l.bom_id)) byBom.set(l.bom_id, []); byBom.get(l.bom_id).push(l); }
  const out = [];
  let frontier = rootBomId ? [rootBomId] : [];
  for (let depth = 1; frontier.length && depth <= maxDepth; depth++) {
    const lines = [...new Set(frontier)].sort((a, b) => a - b).flatMap((id) => byBom.get(id) ?? []);
    out.push(lines.map(rowKey));
    frontier = lines.filter((r) => r.cb_id).map((r) => r.cb_id);
  }
  return out;
}

try {
  const [roots] = await pool.query('SELECT DISTINCT company_id, parent_id FROM cf_boms WHERE deleted_at IS NULL ORDER BY company_id, parent_id');
  console.log(`\n1. Every live BOM (${roots.length}): the one read gives the levels the per-level reads gave`);
  let same = 0; const differ = []; let deepest = 0;
  for (const r of roots) {
    const bom = await bomOfParent(pool, r.company_id, r.parent_id);
    for (const cap of [15, 2, 1]) {
      const a = await levelsByReads(pool, r.company_id, bom?.id, cap);
      const b = levelsFromOneRead(await linesUnderParent(pool, r.company_id, r.parent_id, cap), bom?.id, cap);
      if (JSON.stringify(a) === JSON.stringify(b)) same += 1; else differ.push(`${r.company_id}/${r.parent_id} cap ${cap}`);
      if (cap === 15) deepest = Math.max(deepest, a.length);
    }
  }
  ok(`every BOM, depth caps 15 / 2 / 1: identical rows in identical order (${same} of ${roots.length * 3})`, differ.length === 0, differ.slice(0, 5).join(', '));
  ok(`the database has structures several levels deep to prove it on (deepest ${deepest})`, deepest >= 3, String(deepest));

  console.log('\n2. The root\'s flows, read beside the root');
  let flowSame = 0; const flowDiffer = [];
  for (const r of roots) {
    const root = await requireMaster(pool, r.company_id, r.parent_id);
    const [[before]] = await pool.query(
      `SELECT f.id AS child_flow_id, df.id AS def_flow_id, df.code AS def_flow_code FROM cf_master_records m
         LEFT JOIN cf_operation_flows f ON f.id = m.default_flow_id
         LEFT JOIN cf_master_records sd ON sd.id = ? LEFT JOIN cf_operation_flows df ON df.id = sd.default_flow_id
        WHERE m.company_id = ? AND m.id = ?`, [root.source_definition_id ?? null, r.company_id, root.id]);
    const [[now]] = await pool.query(
      `SELECT f.id AS child_flow_id, df.id AS def_flow_id, df.code AS def_flow_code FROM cf_master_records m
         LEFT JOIN cf_operation_flows f ON f.id = m.default_flow_id
         LEFT JOIN cf_item_details i ON i.master_id = m.id AND i.deleted_at IS NULL
         LEFT JOIN cf_master_records sd ON sd.id = i.source_definition_id LEFT JOIN cf_operation_flows df ON df.id = sd.default_flow_id
        WHERE m.company_id = ? AND m.id = ?`, [r.company_id, root.id]);
    if (JSON.stringify(before) === JSON.stringify(now)) flowSame += 1; else flowDiffer.push(`${r.company_id}/${r.parent_id}`);
  }
  ok(`every root: the same item and definition flow (${flowSame} of ${roots.length})`, flowDiffer.length === 0, flowDiffer.slice(0, 5).join(', '));

  console.log('\n3. explode(): the per-level nodes, in a fixed number of round trips');
  let nodesSame = 0; const nodeDiffer = []; let maxTrips = 0; let tripsDeep = null;
  for (const r of roots) {
    const bom = await bomOfParent(pool, r.company_id, r.parent_id);
    const levels = await levelsByReads(pool, r.company_id, bom?.id, 15);
    const { db, tally } = counting(pool);
    const t = await explode(db, r.company_id, r.parent_id);
    maxTrips = Math.max(maxTrips, tally.n);
    if (levels.length >= 4 && tripsDeep == null) tripsDeep = { id: r.parent_id, depth: levels.length, trips: tally.n };
    // Every line the per-level reads found is a node of the tree (a BOM reached from two parents is a node under each).
    const want = new Set(levels.flat().map((k) => JSON.parse(k).id));
    const got = new Set();
    const walk = (n) => { if (n.lineId) got.add(n.lineId); for (const k of n.children) walk(k); };
    walk(t.root);
    if (want.size === got.size && [...want].every((id) => got.has(id))) nodesSame += 1; else nodeDiffer.push(`${r.company_id}/${r.parent_id}`);
  }
  ok(`every root: the tree holds exactly the lines the per-level reads found (${nodesSame} of ${roots.length})`, nodeDiffer.length === 0, nodeDiffer.slice(0, 5).join(', '));
  ok(`a plain explode is at most 5 round trips whatever the depth — 4, + 1 when a selection is still open (most: ${maxTrips})`, maxTrips <= 5, String(maxTrips));
  ok(`a structure 4+ levels deep is among them (${tripsDeep ? `record ${tripsDeep.id}: ${tripsDeep.depth} levels, ${tripsDeep.trips} round trips` : 'none'})`, !!tripsDeep && tripsDeep.trips <= 4);
} catch (err) {
  console.error(err);
  failed += 1;
} finally {
  await pool.end();
}
console.log(`\n${passed} passed, ${failed} failed${fails.length ? `\n  ${fails.join('\n  ')}` : ''}`);
process.exitCode = failed ? 1 : 0;
