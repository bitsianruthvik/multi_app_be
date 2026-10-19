/**
 * standardVersionRepairService.js — repair a standard drawing whose CURRENT version lost what the version it was
 * copied from holds (2026-10-19). Body of scripts/cf_kepl/rdso-standard-repair.mjs; tested in standard_gaps_test (11).
 *
 * Production 2026-10-19 (company 30005): rdso-standard-fix ran twice. treeCopyService did not copy
 * cf_master_records.cut_stock_id then, so the v3 it wrote of 6 standards lost the section bars v2 was given
 * (RDSO/B-11751R3 v2 #30001 → v3 #30008: 6 rows, bars #1317 / #1339 → none), and each fill left one value its new
 * flows ask (the x-frame's SURFACE_AREA), so v2 of the other 10 is one value short.
 *
 * Per standard (ONE TRANSACTION EACH):
 *   1 the current version is compared with the version it was copied from (note "… over vN", made_from 'fix'), row
 *     by row on the same BOM path: a section bar, a row's flow or a BOM line's flow the older one has and the current
 *     one lacks is LOST. A lost TYPED value or rule, or a missing row, is not repaired here (`refused`: a person looks);
 *     a value the engine keeps (rollup, calculated…) that settling removed is listed, not restored.
 *   2 when something is lost, or the drawing still settles something (unless restoreOnly): the current version is
 *     copied into the NEXT version, the lost bars / flows are put back on the NEW rows (only where empty), the new
 *     version is filled until settled (standardGapFixService.fillUntilSettled), checked to hold everything both older
 *     versions hold, and becomes current. Nothing is deleted; no existing version's rows are written — a version an
 *     order line uses (SO260014: v1 of RDSO/B-11753R3) is only ever read.
 *   3 idempotent: a standard whose current version lost nothing and has nothing the drawing settles is left as it is.
 */
import { checkStandards } from '../lib/standardGaps.js';
import { copyVersion, fillUntilSettled, fillableCount, planLines, DEFAULT_BOM_DIR } from './standardGapFixService.js';

/**
 * A version's rows by BOM path ("ROOT/10:Main girder#0/…"): own section bar and flow, the flow of the BOM line it
 * hangs on, which specifications hold a value, its own rules. A level at a time + 2 reads.
 */
export async function versionRows(db, companyId, rootId) {
  const rows = new Map();
  let frontier = [{ id: Number(rootId), key: 'ROOT', lineId: null, lineFlow: null }];
  for (let depth = 0; frontier.length; depth += 1) {
    if (depth > 30) throw new Error('cf_erp: a standard\'s tree deeper than 30 levels');
    const [ms] = await db.query(
      `SELECT m.id, m.cut_stock_id, m.default_flow_id, b.id AS bom_id FROM cf_master_records m
         LEFT JOIN cf_boms b ON b.company_id = m.company_id AND b.parent_id = m.id AND b.deleted_at IS NULL
        WHERE m.company_id = ? AND m.id IN (?)`, [companyId, frontier.map((f) => f.id)]);
    const byId = new Map(ms.map((m) => [Number(m.id), m]));
    for (const f of frontier) {
      const m = byId.get(f.id);
      if (m) rows.set(f.key, { ...f, cut: m.cut_stock_id == null ? null : Number(m.cut_stock_id), flow: m.default_flow_id == null ? null : Number(m.default_flow_id), bomId: m.bom_id, values: new Map(), rules: new Set() });
    }
    const boms = frontier.map((f) => rows.get(f.key)).filter((r) => r?.bomId);
    if (!boms.length) break;
    const [ls] = await db.query(
      `SELECT l.id, l.bom_id, l.line_no, l.role, l.child_id, l.operation_flow_id FROM cf_bom_lines l
         JOIN cf_item_details ci ON ci.master_id = l.child_id AND ci.deleted_at IS NULL AND ci.item_type = 'temporary'
        WHERE l.company_id = ? AND l.bom_id IN (?) AND l.deleted_at IS NULL ORDER BY l.bom_id, l.line_no, l.id`, [companyId, boms.map((r) => r.bomId)]);
    const next = [];
    for (const r of boms) {
      const seen = new Map();
      for (const l of ls.filter((x) => Number(x.bom_id) === Number(r.bomId))) {
        const k = `${l.line_no}:${l.role ?? ''}`;
        const n = seen.get(k) ?? 0; seen.set(k, n + 1);
        next.push({ id: Number(l.child_id), key: `${r.key}/${k}#${n}`, lineId: Number(l.id), lineFlow: l.operation_flow_id == null ? null : Number(l.operation_flow_id) });
      }
    }
    frontier = next;
  }
  const ids = [...rows.values()].map((r) => r.id);
  const byId = new Map([...rows.values()].map((r) => [r.id, r]));
  const [vals] = await db.query(
    `SELECT subject_id, specification_id, source FROM cf_spec_values WHERE company_id = ? AND subject_type = 'master' AND subject_id IN (?) AND deleted_at IS NULL
        AND (value_number IS NOT NULL OR value_text IS NOT NULL OR option_id IS NOT NULL OR value_bool IS NOT NULL OR value_date IS NOT NULL OR value_json IS NOT NULL)`, [companyId, ids]);
  for (const v of vals) byId.get(Number(v.subject_id))?.values.set(Number(v.specification_id), v.source ?? null);
  const [rules] = await db.query(
    "SELECT subject_id, specification_id, capture_at FROM cf_spec_assignments WHERE company_id = ? AND subject_type = 'master' AND subject_id IN (?) AND deleted_at IS NULL", [companyId, ids]);
  for (const r of rules) byId.get(Number(r.subject_id))?.rules.add(`${r.specification_id}:${r.capture_at}`);
  return rows;
}

/**
 * What `later` lacks that `earlier` has, row by row (same path). A value the ENGINE keeps (source rollup / calculated /
 * inherited / defaulted) that is gone is `recomputed`, not lost: the value engine removes one it can no longer work
 * out (production RDSO/B-516: the assemblies' rolled-up WEIGHT went when their 100 x 75 angles, thickness not shown,
 * were settled) — said, not restored, since the next settle would remove it again. A TYPED value gone is lost.
 */
const ENGINE_KEPT = new Set(['rollup', 'calculated', 'inherited', 'defaulted']);
export function lostBetween(earlier, later) {
  const out = { missingRows: [], cuts: [], flows: [], lineFlows: [], values: [], recomputed: [], rules: [] };
  for (const [key, a] of earlier) {
    const b = later.get(key);
    if (!b) { out.missingRows.push(key); continue; }
    if (a.cut != null && b.cut == null) out.cuts.push({ key, toId: b.id, stockId: a.cut });
    if (a.flow != null && b.flow == null) out.flows.push({ key, toId: b.id, flowId: a.flow });
    if (a.lineFlow != null && b.lineFlow == null && b.lineId) out.lineFlows.push({ key, toId: b.id, flowId: a.lineFlow });
    for (const [s, source] of a.values) if (!b.values.has(s)) (ENGINE_KEPT.has(source) ? out.recomputed : out.values).push({ key, specId: s, source });
    for (const r of a.rules) if (!b.rules.has(r)) out.rules.push({ key, rule: r });
  }
  out.restorable = out.cuts.length + out.flows.length + out.lineFlows.length;
  out.unrepairable = out.missingRows.length + out.values.length + out.rules.length;
  out.count = out.restorable + out.unrepairable;
  return out;
}

export const pathOfKey = (key) => key.replace(/#\d+/g, '').replace(/\/\d+:/g, ' › ').replace(/^ROOT( › )?/, '') || '(top)';

/**
 * Every standard of the company (or `only` numbers). `read`: the connection reads go through before a standard is
 * written (a read-only wrapper on a dry run). `conn`: a caller's transaction (the test) — each standard then is a
 * savepoint. → { repaired, ok, refused, failed, results: [{ number, versionId?, versionNo?, restored?, filled?, planned? }] }
 */
export async function repairStandards({ pool = null, read, conn: given = null, companyId, userId = null, only = null, sectionClass = null, restoreOnly = false, commit = false, bomDir = DEFAULT_BOM_DIR, log = () => {} }) {
  const out = { repaired: 0, ok: 0, refused: 0, failed: 0, results: [] };
  const [vers] = await read.query(
    `SELECT v.id, v.standard_id, v.version_no, v.root_item_id, v.made_from, v.note, s.number, s.current_version_id
       FROM cf_standard_drawings s JOIN cf_standard_drawing_versions v ON v.company_id = s.company_id AND v.standard_id = s.id AND v.deleted_at IS NULL
      WHERE s.company_id = ? AND s.deleted_at IS NULL AND v.root_item_id IS NOT NULL ORDER BY s.number, v.version_no`, [companyId]);
  const want = (n) => !only || only.some((o) => o.toLowerCase() === String(n).toLowerCase());
  const [lineRows] = await read.query('SELECT DISTINCT standard_version_id FROM cf_sales_order_lines WHERE company_id = ? AND standard_version_id IS NOT NULL AND deleted_at IS NULL', [companyId]);
  const usedVersions = new Set(lineRows.map((l) => Number(l.standard_version_id)));
  const check = await checkStandards(read, companyId, { only: [...new Set(vers.filter((v) => want(v.number)).map((v) => v.number))], bomDir });
  const checkOf = new Map(check.standards.map((s) => [s.versionId, s]));
  const codes = new Map();
  const codeOf = async (id) => {
    if (!codes.has(id)) { const [[r]] = await read.query('SELECT code FROM cf_master_records WHERE company_id = ? AND id = ?', [companyId, id]); codes.set(id, r?.code ?? `#${id}`); }
    return codes.get(id);
  };

  for (const cur of vers.filter((v) => Number(v.id) === Number(v.current_version_id) && want(v.number))) {
    const from = /over v(\d+)/.exec(cur.note ?? '');
    const prev = cur.made_from === 'fix' && from ? vers.find((v) => Number(v.standard_id) === Number(cur.standard_id) && Number(v.version_no) === Number(from[1])) : null;
    log(`\n${cur.number} — current v${cur.version_no} (#${cur.id})${prev ? `, copied from v${prev.version_no} (#${prev.id})` : ''}${usedVersions.has(Number(cur.id)) ? ' — used by an order line (only read)' : ''}`);
    const curRows = await versionRows(read, companyId, cur.root_item_id);
    const prevRows = prev ? await versionRows(read, companyId, prev.root_item_id) : null;
    const lost = lostBetween(prevRows ?? new Map(), curRows);
    if (lost.unrepairable) {
      log(`  NOT REPAIRED — a person looks: ${lost.missingRows.length} row(s) missing, ${lost.values.length} typed value(s) and ${lost.rules.length} rule(s) gone since v${prev?.version_no}`);
      for (const k of lost.missingRows.slice(0, 10)) log(`    row missing: ${pathOfKey(k)}`);
      for (const x of lost.values.slice(0, 10)) log(`    value gone: ${pathOfKey(x.key)} (specification #${x.specId}, ${x.source ?? 'no source'})`);
      out.refused += 1; out.results.push({ number: cur.number, refused: true });
      continue;
    }
    if (prev) log(`  lost since v${prev.version_no}: ${lost.cuts.length} section bar(s), ${lost.flows.length} row flow(s), ${lost.lineFlows.length} BOM-line flow(s); typed values, rules, rows: none`);
    if (lost.recomputed.length) {
      const [specs] = await read.query('SELECT id, code FROM cf_specifications WHERE company_id = ? AND id IN (?)', [companyId, [...new Set(lost.recomputed.map((x) => x.specId))]]);
      const codeOfSpec = new Map(specs.map((s) => [Number(s.id), s.code]));
      log(`  values the engine no longer works out (removed when the rows were settled; not restored — the next settle would remove them again):`);
      for (const x of lost.recomputed) log(`    ${pathOfKey(x.key)}  ${codeOfSpec.get(x.specId) ?? `#${x.specId}`} (${x.source})`);
    }
    const entry = checkOf.get(Number(cur.id));
    const restoredIds = new Set(lost.cuts.map((x) => x.toId));
    for (const x of lost.cuts) {
      const gap = entry?.gaps.sections.find((s) => Number(s.itemId) === x.toId);
      const drawn = gap?.derive?.stockId ?? (sectionClass ? gap?.derive?.byClass?.[sectionClass]?.stockId : null) ?? null;
      log(`    restore section   ${pathOfKey(x.key)}  ←  ${await codeOf(x.stockId)} (#${x.stockId}, as on v${prev.version_no})${drawn != null ? `  [the drawing's ${sectionClass ?? ''} bar: ${Number(drawn) === x.stockId ? 'the same' : `DIFFERENT, ${await codeOf(Number(drawn))}`}]` : ''}`);
    }
    for (const x of lost.flows) log(`    restore flow      ${pathOfKey(x.key)}  ←  flow #${x.flowId}`);
    for (const x of lost.lineFlows) log(`    restore line flow ${pathOfKey(x.key)}  ←  flow #${x.flowId}`);
    const rest = entry && !restoreOnly ? { ...entry, gaps: { ...entry.gaps, sections: entry.gaps.sections.filter((s) => !restoredIds.has(Number(s.itemId))) } } : null;
    const fillable = rest ? fillableCount(rest, { sectionClass }) : 0;
    if (rest) {
      log(`  the drawing settles on v${cur.version_no}${lost.cuts.length ? ' besides those' : ''}: ${fillable} (${entry.total} gap(s) listed; the rest need a person)`);
      for (const l of planLines(rest, { sectionClass }).filter((x) => !/\(person\)/.test(x))) log(`  ${l}`);
    }
    if (!lost.restorable && !fillable) { log('  OK — nothing lost, nothing to fill: left as it is'); out.ok += 1; out.results.push({ number: cur.number, ok: true }); continue; }
    const nextNo = Math.max(...vers.filter((v) => Number(v.standard_id) === Number(cur.standard_id)).map((v) => Number(v.version_no))) + 1;
    if (!commit) {
      log(`  → would write v${nextNo}: a copy of v${cur.version_no}${lost.restorable ? `, ${lost.restorable} restored` : ''}${fillable ? ', filled until the drawing settles nothing more' : ''}; made current`);
      out.repaired += 1; out.results.push({ number: cur.number, planned: { restore: lost.restorable, fill: fillable } });
      continue;
    }

    const conn = given ?? await pool.getConnection();
    const SP = 'std_repair';
    try {
      if (!given) await conn.beginTransaction(); else await conn.query(`SAVEPOINT ${SP}`);
      const c = { companyId, userId };
      const note = `Repair (rdso-standard-repair ${new Date().toISOString().slice(0, 10)}) over v${cur.version_no}${prev && lost.restorable ? `; restored from v${prev.version_no}: ${lost.cuts.length} section bars, ${lost.flows.length + lost.lineFlows.length} flows` : ''}`;
      const v = await copyVersion(conn, c, Number(cur.standard_id), Number(cur.id), { note, madeFrom: 'fix' });
      const fresh = new Set([...v.idMap.values()].map(Number));
      const toNew = (id) => { const n = Number(v.idMap.get(Number(id))); if (!fresh.has(n)) throw new Error(`row #${id} has no copy in the new version`); return n; };
      let restored = 0;
      const byBar = new Map();
      for (const x of lost.cuts) { if (!byBar.has(x.stockId)) byBar.set(x.stockId, []); byBar.get(x.stockId).push(toNew(x.toId)); }
      for (const [stockId, ids] of byBar) restored += (await conn.query('UPDATE cf_master_records SET cut_stock_id = ? WHERE company_id = ? AND id IN (?) AND cut_stock_id IS NULL', [stockId, companyId, ids]))[0].affectedRows;
      for (const x of lost.flows) restored += (await conn.query('UPDATE cf_master_records SET default_flow_id = ? WHERE company_id = ? AND id = ? AND default_flow_id IS NULL', [x.flowId, companyId, toNew(x.toId)]))[0].affectedRows;
      for (const x of lost.lineFlows) {
        restored += (await conn.query(
          `UPDATE cf_bom_lines l JOIN cf_boms b ON b.id = l.bom_id SET l.operation_flow_id = ?
            WHERE l.company_id = ? AND l.child_id = ? AND l.deleted_at IS NULL AND l.operation_flow_id IS NULL AND b.parent_id IN (?)`, [x.flowId, companyId, toNew(x.toId), [...fresh]]))[0].affectedRows;
      }
      if (restored !== lost.restorable) throw new Error(`restored ${restored} of ${lost.restorable}`);
      const filled = restoreOnly ? { values: 0, sections: 0, flows: 0, problems: [], left: 0, passes: 0 }
        : await fillUntilSettled(conn, c, { id: v.versionId, standard_id: Number(cur.standard_id), version_no: v.versionNo, root_item_id: v.rootId, number: cur.number }, { sectionClass, bomDir });
      // The new version holds everything both older ones hold — else nothing is kept.
      const newRows = await versionRows(conn, companyId, v.rootId);
      const l1 = lostBetween(curRows, newRows);
      const l2 = prevRows ? lostBetween(prevRows, newRows) : { count: 0 };
      if (l1.count || l2.count) throw new Error(`the new version would still lack ${l1.count} of v${cur.version_no}'s and ${l2.count} of v${prev?.version_no}'s`);
      if (!(restored + filled.values + filled.sections + filled.flows)) throw new Error('nothing would be written');
      await conn.query('UPDATE cf_standard_drawing_versions SET note = ? WHERE company_id = ? AND id = ?',
        [`${note}; filled: ${filled.values} values, ${filled.sections} sections, ${filled.flows} flows${filled.problems.length ? `; ${filled.problems.length} refused` : ''}`.slice(0, 500), companyId, v.versionId]);
      if (!given) await conn.commit(); else await conn.query(`RELEASE SAVEPOINT ${SP}`);
      log(`  WRITTEN: v${v.versionNo} (#${v.versionId}), now current — ${restored} restored; filled ${filled.values} values, ${filled.sections} sections, ${filled.flows} flows${filled.problems.length ? `\n  refused:\n    ${filled.problems.join('\n    ')}` : ''}`);
      out.repaired += 1;
      out.results.push({ number: cur.number, versionId: v.versionId, versionNo: v.versionNo, rootId: v.rootId, restored, filled });
    } catch (err) {
      if (!given) { try { await conn.rollback(); } catch { /* the error below is the one */ } } else { try { await conn.query(`ROLLBACK TO SAVEPOINT ${SP}`); } catch { /* idem */ } }
      log(`  FAILED, rolled back: ${err.message}`);
      out.failed += 1; out.results.push({ number: cur.number, error: err.message });
      if (!given) conn.release();
      break;
    }
    if (!given) conn.release();
  }
  return out;
}
