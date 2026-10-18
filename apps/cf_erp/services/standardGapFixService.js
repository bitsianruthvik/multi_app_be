/**
 * standardGapFixService.js — fill a standard drawing's gaps from its own drawing data, as a NEW VERSION (2026-10-18).
 *
 * lib/standardGaps.js says what a version lacks and what of it the drawing settles (`derive`). This writes it:
 *
 *   copyVersion     the version's rows, BOMs, values, the rows' own rules, register links and part files copied into
 *                   the NEXT version of the same standard (the copy machine a line uses — treeCopyService), which
 *                   becomes the current one. The version copied from is never touched: lines made from it keep
 *                   their copies, and so does it.
 *   fillVersionGaps on the rows of a version nobody uses yet (a fresh copy, or a version just imported):
 *                   1 flows        a made row with no flow takes the flow its part is made by elsewhere
 *                   2 sections     a section part takes the catalog bar of the drawing's size, profile and grade
 *                                  (a class the order gives: only with `sectionClass`)
 *                   3 flow rules   the rows get the values their flows ask for (flowSpecService.syncFlowSpecs — what
 *                                  a line does when it is made; done here so the values can be held)
 *                   4 values       every derivable value, through valueService.setValues (validated as typed)
 *                   Only what is EMPTY is filled; nothing a person typed is changed.
 *
 * Both run inside the caller's transaction. Round trips: copyVersion ~ a dozen + one per tree level; fill: a few +
 * one setValues per row with values (each ~8 reads; ~25 rows on an RDSO span).
 */
import { snapshotSubtrees, writeCopies, copyDrawingLinks } from './treeCopyService.js';
import { invalid } from '../lib/errors.js';

const COPY_CHUNK = 1000;
const blank = (v) => v == null || String(v).trim() === '';

/** A version's tree, copied as the next version of its standard (now the current one). → { versionId, versionNo, rootId, idMap } */
export async function copyVersion(db, c, standardId, fromVersionId, { note = null, madeFrom = 'fix' } = {}) {
  const { companyId } = c;
  const [[v]] = await db.query('SELECT * FROM cf_standard_drawing_versions WHERE company_id = ? AND standard_id = ? AND id = ? AND deleted_at IS NULL', [companyId, standardId, fromVersionId]);
  if (!v || !v.root_item_id) throw invalid('NO_BOM', `Version #${fromVersionId} of standard #${standardId} has no BOM to copy.`);
  // Lock the standard so two runs cannot both write "the next version".
  await db.query('SELECT id FROM cf_standard_drawings WHERE company_id = ? AND id = ? FOR UPDATE', [companyId, standardId]);
  const rootId = Number(v.root_item_id);
  const snap = await snapshotSubtrees(db, companyId, [rootId], (l) => l.child_item_type === 'temporary');
  const { idMap } = await writeCopies(db, c, snap, [{ srcId: rootId, ownerLineId: null }], { chunk: COPY_CHUNK, links: 'fresh' });
  const newRoot = idMap.get(rootId);
  if (!newRoot) throw new Error(`cf_erp: version #${fromVersionId} could not be copied.`);
  await copyDrawingLinks(db, c, idMap, { chunk: COPY_CHUNK });
  const [[{ top }]] = await db.query('SELECT MAX(version_no) AS top FROM cf_standard_drawing_versions WHERE company_id = ? AND standard_id = ?', [companyId, standardId]);
  const versionNo = (Number(top) || 0) + 1;
  const [ins] = await db.query(
    `INSERT INTO cf_standard_drawing_versions (company_id, standard_id, version_no, root_item_id, design_id, rows_count, parts_count, weight_kg, made_from, from_line_id, note, report_json, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?)`,
    [companyId, standardId, versionNo, newRoot, v.design_id, v.rows_count, v.parts_count, v.weight_kg, String(madeFrom).slice(0, 12), blank(note) ? null : String(note).slice(0, 500), c.userId ?? null],
  );
  const versionId = ins.insertId;
  await db.query(
    `INSERT INTO cf_standard_drawing_files (company_id, version_id, standard_id, kind, drawing_id, mark, mark_norm, file_name, file_kind, length_mm, width_mm, area_mm2,
                                            cut_length_mm, piercings, holes, inner_cuts, geometry_json, warnings_json, file_text, created_by)
     SELECT company_id, ?, standard_id, kind, drawing_id, mark, mark_norm, file_name, file_kind, length_mm, width_mm, area_mm2,
            cut_length_mm, piercings, holes, inner_cuts, geometry_json, warnings_json, file_text, ?
       FROM cf_standard_drawing_files WHERE company_id = ? AND version_id = ? AND deleted_at IS NULL`,
    [versionId, c.userId ?? null, companyId, fromVersionId],
  );
  await db.query('UPDATE cf_standard_drawings SET current_version_id = ? WHERE company_id = ? AND id = ?', [versionId, companyId, standardId]);
  return { versionId: Number(versionId), versionNo, rootId: Number(newRoot), idMap };
}

/**
 * Fill what `entry` (one version of lib/standardGaps.versionGaps) can derive, on the rows `idMap` maps them to (null:
 * the version's own rows — only for a version no line uses). → { flows, sections, values, skipped: [words], problems: [words] }
 */
export async function fillVersionGaps(db, c, entry, idMap = null, { sectionClass = null } = {}) {
  const { companyId } = c;
  const to = (id) => (idMap ? idMap.get(Number(id)) ?? null : Number(id));
  const out = { flows: 0, sections: 0, values: 0, skipped: [], problems: [] };
  const g = entry.gaps;

  // 1. flows — grouped by flow, one UPDATE each; only where the row still has none of its own.
  const byFlow = new Map();
  for (const f of g.flows) {
    if (!f.derive?.flowId) { out.skipped.push(`flow: ${f.path}`); continue; }
    const id = to(f.itemId);
    if (!id) continue;
    if (!byFlow.has(f.derive.flowId)) byFlow.set(f.derive.flowId, []);
    byFlow.get(f.derive.flowId).push(id);
  }
  for (const [flowId, ids] of byFlow) {
    const [r] = await db.query('UPDATE cf_master_records SET default_flow_id = ? WHERE company_id = ? AND id IN (?) AND default_flow_id IS NULL', [flowId, companyId, ids]);
    out.flows += r.affectedRows ?? 0;
  }

  // 2. sections — the bar of the drawing's size and grade (of the asked class when the order gives the class).
  const byBar = new Map();
  for (const s of g.sections) {
    const d = s.derive;
    const pick = d?.stockId ? d : d?.byClass && sectionClass ? d.byClass[String(sectionClass).toUpperCase()] ?? null : null;
    if (!pick) { out.skipped.push(`section: ${s.path} (${s.profile ?? 'no size'}${d?.byClass && !sectionClass ? ' — the impact class is the order\'s: run with --section-class' : ''})`); continue; }
    const id = to(s.itemId);
    if (!id) continue;
    if (!byBar.has(pick.stockId)) byBar.set(pick.stockId, []);
    byBar.get(pick.stockId).push(id);
  }
  for (const [stockId, ids] of byBar) {
    const [r] = await db.query('UPDATE cf_master_records SET cut_stock_id = ? WHERE company_id = ? AND id IN (?) AND cut_stock_id IS NULL', [stockId, companyId, ids]);
    out.sections += r.affectedRows ?? 0;
  }

  // 3. the rows' flow-made rules, so the values their flows ask for can be held on the standard.
  const wanted = g.values.filter((v) => v.derive && (v.derive.value != null || v.derive.optionId != null));
  const rowIds = [...new Set(wanted.map((v) => to(v.itemId)).filter(Boolean))];
  const allIds = [...new Set([...rowIds, ...[...byFlow.values()].flat()])];
  if (allIds.length) {
    const { syncFlowSpecs } = await import('./flowSpecService.js');
    await syncFlowSpecs(db, c, allIds, { settle: false });
  }

  // 4. values, row by row (setValues validates them as a person's typing would be).
  const { setValues } = await import('./valueService.js');
  const byRow = new Map();
  for (const v of wanted) {
    const id = to(v.itemId);
    if (!id) continue;
    if (!byRow.has(id)) byRow.set(id, []);
    if (!byRow.get(id).some((e) => e.specCode === v.specCode)) byRow.get(id).push({ specCode: v.specCode, value: v.derive.optionId ?? v.derive.value, path: v.path });
  }
  for (const [id, entries] of byRow) {
    // Only what is still empty: a value a person typed meanwhile stays.
    const [have] = await db.query(
      `SELECT UPPER(s.code) AS code FROM cf_spec_values x JOIN cf_specifications s ON s.id = x.specification_id
        WHERE x.company_id = ? AND x.subject_type = 'master' AND x.subject_id = ? AND x.deleted_at IS NULL
          AND (x.value_number IS NOT NULL OR x.value_text IS NOT NULL OR x.option_id IS NOT NULL OR x.value_bool IS NOT NULL OR x.value_date IS NOT NULL)
          AND s.code IN (?)`, [companyId, id, entries.map((e) => e.specCode)]);
    const held = new Set(have.map((h) => h.code));
    const todo = entries.filter((e) => !held.has(String(e.specCode).toUpperCase()));
    if (!todo.length) continue;
    try {
      await setValues(db, c, 'master', id, todo.map((e) => ({ specCode: e.specCode, value: e.value })));
      out.values += todo.length;
    } catch (err) {
      // One row's refusal (a rule changed since the check) is said and the rest go on: setValues writes nothing when it refuses.
      out.problems.push(`${todo[0].path}: ${err.message}${err.problems ? ` — ${err.problems.join('; ')}` : ''}`);
    }
  }
  for (const v of g.values) if (!(v.derive && (v.derive.value != null || v.derive.optionId != null))) out.skipped.push(`value: ${v.path} ${v.specCode}`);
  return out;
}

/** How much of a version's gaps the drawing settles (with the class given). */
export function fillableCount(entry, { sectionClass = null } = {}) {
  const g = entry.gaps;
  return g.flows.filter((f) => f.derive?.flowId).length
    + g.sections.filter((s) => s.derive?.stockId || (s.derive?.byClass && sectionClass && s.derive.byClass[String(sectionClass).toUpperCase()])).length
    + g.values.filter((v) => v.derive && (v.derive.value != null || v.derive.optionId != null)).length;
}

/** The words of what a version's derive would fill — one line each. */
export function planLines(entry, { sectionClass = null } = {}) {
  const g = entry.gaps;
  const lines = [];
  for (const f of g.flows) lines.push(f.derive?.flowId ? `  flow     ${f.path}  →  ${f.derive.code} (${f.derive.how})` : `  (person) flow     ${f.path}`);
  for (const s of g.sections) {
    const pick = s.derive?.stockId ? s.derive : s.derive?.byClass && sectionClass ? s.derive.byClass[sectionClass] ?? null : null;
    lines.push(pick ? `  section  ${s.path}  ${s.profile ?? ''}  →  ${pick.code}` : `  (person) section  ${s.path}  ${s.profile ?? ''}${s.derive?.byClass ? `  — bars ${s.derive.code}: say the class (--section-class)` : '  — no catalog bar of this size'}`);
  }
  for (const v of g.values) {
    const d = v.derive;
    lines.push(d && (d.value != null || d.optionId != null) ? `  value    ${v.path}  ${v.specCode} = ${d.display ?? d.value}  (${d.how})` : `  (person) value    ${v.path}  ${v.specCode}`);
  }
  for (const q of g.quantities) lines.push(`  (person) quantity ${q.path}: ${q.problem}`);
  return lines;
}

/**
 * The fix script's body (scripts/cf_kepl/rdso-standard-fix.mjs, and the test): for each standard whose current version
 * has something the drawing settles, a new version with it filled — one transaction per standard. Dry run: the plan.
 * → { fixed, skipped, failed, results: [{ number, versionId?, versionNo?, filled? }] }
 */
export async function fixStandards({ pool, companyId, userId = null, standards, commit = false, sectionClass = null, log = () => {}, conn: given = null }) {
  const out = { fixed: 0, skipped: 0, failed: 0, results: [] };
  for (const s of standards) {
    if (!s.current) continue;
    const n = fillableCount(s, { sectionClass });
    log(`\n${s.number} v${s.versionNo} (#${s.versionId})${s.usedByLines?.length ? ` — used by ${s.usedByLines.join(', ')} (left as it is)` : ''}: ${n} of ${s.total} gap(s) the drawing settles`);
    if (!n) { out.skipped += 1; out.results.push({ number: s.number, skipped: true }); log('  nothing to fill — skipped'); continue; }
    for (const l of planLines(s, { sectionClass })) log(l);
    if (!commit) { out.fixed += 1; out.results.push({ number: s.number, planned: n }); continue; }
    const conn = given ?? await pool.getConnection();
    try {
      if (!given) await conn.beginTransaction();
      const c = { companyId, userId };
      const note = `Gaps filled from the drawing (rdso-standard-fix ${new Date().toISOString().slice(0, 10)}) over v${s.versionNo}${sectionClass ? `; section bars ${sectionClass}` : ''}`;
      const v = await copyVersion(conn, c, s.standardId, s.versionId, { note });
      const filled = await fillVersionGaps(conn, c, s, v.idMap, { sectionClass });
      await conn.query('UPDATE cf_standard_drawing_versions SET note = ? WHERE company_id = ? AND id = ?',
        [`${note}: ${filled.values} values, ${filled.sections} sections, ${filled.flows} flows${filled.problems.length ? `; ${filled.problems.length} refused` : ''}`.slice(0, 500), companyId, v.versionId]);
      if (!given) await conn.commit();
      log(`  WRITTEN: version ${v.versionNo} (#${v.versionId}) — ${filled.values} values, ${filled.sections} sections, ${filled.flows} flows${filled.problems.length ? `\n  refused:\n    ${filled.problems.join('\n    ')}` : ''}`);
      out.fixed += 1;
      out.results.push({ number: s.number, versionId: v.versionId, versionNo: v.versionNo, rootId: v.rootId, filled });
    } catch (err) {
      if (!given) { try { await conn.rollback(); } catch { /* the error below is the one */ } }
      log(`  FAILED, rolled back: ${err.message}${err.problems ? ` — ${err.problems.join('; ')}` : ''}`);
      out.failed += 1;
      out.results.push({ number: s.number, error: err.message });
      if (given) throw err;
      break;
    } finally {
      if (!given) conn.release();
    }
  }
  return out;
}

/**
 * After an import (scripts/cf_kepl/standard-import.mjs and -all, on --apply): what the drawing settles but the mapping
 * left empty, filled on the just-written version's own rows — nobody uses it yet. 2026-10-18: RDSO/B-11753R3 v1
 * made a line with 20 required values, 4 section bars and 3 flows to fill by hand. Kept out of importStandard so
 * its round trips stay the same whatever the set's size (standard_drawings_test); this one costs one setValues a
 * row with values. → fillVersionGaps' answer + { before } (the gaps there were).
 */
export async function fillImportedGaps(db, c, { standardId, bom = null, sectionClass = null }) {
  const { versionGaps, gapReaders } = await import('../lib/standardGaps.js');
  const [[v]] = await db.query(
    `SELECT v.id, v.standard_id, v.version_no, v.root_item_id, s.number FROM cf_standard_drawings s
       JOIN cf_standard_drawing_versions v ON v.id = s.current_version_id WHERE s.company_id = ? AND s.id = ?`, [c.companyId, standardId]);
  if (!v) return { flows: 0, sections: 0, values: 0, skipped: [], problems: ['no version'], before: 0 };
  const readers = await gapReaders(db, c.companyId);
  const g = await versionGaps(db, c.companyId, [v], { bom, ...readers });
  const entry = g.versions[0];
  return { ...(await fillVersionGaps(db, c, entry, null, { sectionClass })), before: entry.total };
}
