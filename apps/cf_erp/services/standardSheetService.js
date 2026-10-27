/**
 * standardSheetService.js — THE SHEETS OF A STANDARD DRAWING ON THE LEVELS THEY DRAW (user, 2026-10-27: "some of the
 * RDSO diagrams are not at structure levels").
 *
 * An RDSO standard is a SERIES of sheets (bom.json `drawing.sheets`): the general arrangement, the splice joint, the
 * X-frame and end diaphragm, the bearings, the assembly drawing with the part & shipping list, the camber diagram…
 * The importer registered the series once and linked it to the span only, and each part's DXF to its part row — so
 * every assembly row between them (girder line, segment, end diaphragm, X-frame, bracing, splice set, seismic stopper,
 * bearing) had no drawing, on the standard and on every order line copied from it.
 *
 * Here each sheet becomes a register drawing of its own (the customer's number and revision as printed — RDSO/B-11753/2
 * rev R4 — with the series link opened at its page, `#page=N`), linked to the assembly rows it draws, decided from the
 * sheet's title and the row's level / name / mark (sheetLinksPlan, pure). A sheet that is the series' own number (the
 * general arrangement) is the register drawing the standard already has. An assembly row no sheet names gets the series.
 * Nothing is moved or removed: links are only added where missing, so it is idempotent.
 *
 *   importStandard calls attachSheetsOnImport; scripts/cf_kepl/rdso-sheets-attach.mjs repairs what was imported before
 *   (repairStandardSheets: the standard's versions by the rule, its order lines by BOM path from their version).
 */
import { cutPlateNodes } from './treeCopyService.js';
import { insertRows } from '../lib/db.js';

const norm = (s) => String(s ?? '').replace(/[^a-z0-9]/gi, '').toLowerCase();

/** "RDSO/B-11753/2R4" → { number: 'RDSO/B-11753/2', revision: 'R4' }; "RDSO/B-11765/1" → revision '0' (never altered). */
export function parseSheetNumber(raw) {
  const s = String(raw ?? '').trim();
  const m = /^(.*?[^/])\/?(R\d*)$/i.exec(s);
  if (m && /\d/.test(m[1])) return { number: m[1].replace(/\/$/, ''), revision: m[2].toUpperCase() };
  return { number: s, revision: '0' };
}

const SHEET = {
  splice: /splice/i,
  frame: /x-?\s?frame|diaphragm|cross.?frame/i,
  bearing: /bearing|bed.?plate/i,
  seismic: /seismic|restrainer|stopper/i,
  assembly: /assembly\s+drawing|shipping|erection/i,
  camber: /camber/i,
};
/** A row's words → the sheets that draw it, most specific first; the first that the series has wins. */
const ROW_RULES = [
  { row: /splice/i, sheets: [[SHEET.splice]] },
  { row: /diaphragm|x-?\s?frame|cross.?frame/i, sheets: [[SHEET.frame]] },
  { row: /bearing|bed.?plate/i, sheets: [[SHEET.bearing]] },
  { row: /seismic|stopper|restrainer/i, sheets: [[SHEET.seismic], [SHEET.assembly]] },
  { row: /segment/i, sheets: [[SHEET.assembly, SHEET.camber]] },
  { row: /girder|bracing/i, sheets: [[SHEET.assembly]] },
];

/**
 * PURE. sheets: bom.json `drawing.sheets` [{ sheet, number, title }]; main: the series' register number / revision;
 * rows: the ASSEMBLY rows of a tree [{ id, text, isRoot }] (text = level, name, mark — whatever names the row).
 * → { sheets: [{ key, sheet, page, number, revision, title, isMain }], links: [{ key, rowId }] }  (key 'main' = the series)
 */
export function sheetLinksPlan({ sheets = [], main, rows = [] }) {
  const mainKey = norm(`${main?.number ?? ''}${main?.revision ?? ''}`);
  const mainNumber = norm(main?.number);
  const out = [];
  for (const [i, s] of (sheets ?? []).entries()) {
    if (!s?.number) continue;
    const p = parseSheetNumber(s.number);
    // The general arrangement carries the series' own number (RDSO/B-11753R3, RDSO/B-11754/R3, RDSO/B-1534/R): the standard's register drawing.
    const isMain = [mainKey, mainNumber].includes(norm(s.number)) || norm(p.number) === mainNumber;
    out.push({ key: isMain ? 'main' : `${p.number}|${p.revision}`.toLowerCase(), sheet: Number(s.sheet ?? i + 1), page: Number(s.sheet ?? i + 1), number: p.number, revision: p.revision, title: s.title ?? null, isMain });
  }
  const links = [];
  for (const r of rows) {
    if (r.isRoot) continue;   // the span carries the series already (the general arrangement)
    const rule = ROW_RULES.find((x) => x.row.test(r.text ?? ''));
    let hit = [];
    for (const group of rule?.sheets ?? []) {
      hit = out.filter((s) => !s.isMain && group.some((re) => re.test(s.title ?? '')));
      if (hit.length) break;
    }
    if (!hit.length) links.push({ key: 'main', rowId: r.id });
    else for (const s of hit) links.push({ key: s.key, rowId: r.id });
  }
  return { sheets: out.filter((s) => !s.isMain), links };
}

/**
 * The register drawing of each sheet, found again or made (the customer's, issued, with the series link at its page).
 * `dryRun` makes nothing: a sheet not yet registered maps to null. → Map key -> drawing id | null ('main' -> mainDrawingId).
 */
export async function registerSheets(db, c, { sheets, mainDrawingId, seriesNumber, sourceUrl = null, internal = false, dryRun = false, codeBase = null }) {
  const ids = new Map([['main', mainDrawingId ?? null]]);
  if (!sheets.length) return ids;
  // Set-based, whatever the number of sheets: one read; when some are new, the series' code, one insert, one read back.
  const keyOf = (number, revision) => `${String(number).toLowerCase()}|${String(revision).toLowerCase()}`;
  const find = async () => {
    const [have] = await db.query(
      "SELECT id, number, revision FROM cf_drawings WHERE company_id = ? AND source = 'customer' AND deleted_at IS NULL AND number_active IN (?)",
      [c.companyId, [...new Set(sheets.map((s) => s.number.toLowerCase()))]],
    );
    return new Map(have.map((h) => [keyOf(h.number, h.revision), Number(h.id)]));
  };
  let found = await find();
  const fresh = sheets.filter((s) => !found.has(keyOf(s.number, s.revision)));
  if (fresh.length && !dryRun) {
    const [[m]] = codeBase || !mainDrawingId ? [[{ code: codeBase }]] : await db.query('SELECT code FROM cf_drawings WHERE company_id = ? AND id = ?', [c.companyId, mainDrawingId]);
    const base = String(m?.code ?? `SHEET-${Date.now().toString(36)}`);
    await insertRows(db, 'cf_drawings', ['company_id', 'code', 'number', 'revision', 'title', 'source', 'url', 'status', 'issued_on', 'notes', 'created_by'],
      fresh.map((s) => [c.companyId, `${base}-S${s.sheet}`.replace(/[^A-Za-z0-9._/-]/g, '-').slice(0, 100), s.number.slice(0, 150), s.revision.slice(0, 20),
        `${s.title ?? `Sheet ${s.sheet}`}`.slice(0, 255), 'customer',
        sourceUrl ? `${String(sourceUrl).replace(/#.*$/, '')}#page=${s.page}`.slice(0, 1000) : null, 'issued', new Date().toISOString().slice(0, 10),
        `Sheet ${s.sheet} of the ${seriesNumber} series${sourceUrl ? ` (page ${s.page} of the PDF)` : ''}${internal ? ' — RDSO property, internal use only' : ''}.`, c.userId ?? null]));
    found = await find();
    const made = fresh.map((s) => found.get(keyOf(s.number, s.revision))).filter(Boolean);
    if (made.length) await db.query('UPDATE cf_drawings SET root_id = id WHERE company_id = ? AND id IN (?) AND root_id IS NULL', [c.companyId, made]);
  }
  for (const s of sheets) ids.set(s.key, found.get(keyOf(s.number, s.revision)) ?? null);
  return ids;
}

/** Of [{ drawingId, rowId }], the pairs with no live link yet (a null drawing id is a sheet still to register: missing). */
export async function missingLinks(db, companyId, pairs) {
  const known = pairs.filter((p) => p.drawingId != null);
  const have = new Set();
  const rowIds = [...new Set(known.map((p) => p.rowId))];
  for (let i = 0; i < rowIds.length; i += 1000) {
    const [rows] = await db.query(
      "SELECT drawing_id, subject_id FROM cf_drawing_links WHERE company_id = ? AND subject_type = 'master_record' AND subject_id IN (?) AND deleted_at IS NULL",
      [companyId, rowIds.slice(i, i + 1000)],
    );
    for (const r of rows) have.add(`${r.drawing_id}:${r.subject_id}`);
  }
  const seen = new Set();
  return pairs.filter((p) => {
    const k = `${p.drawingId}:${p.rowId}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return p.drawingId == null || !have.has(k);
  });
}

export async function attachLinks(db, c, pairs) {
  const rows = pairs.filter((p) => p.drawingId != null).map((p) => [c.companyId, p.drawingId, 'master_record', p.rowId, 'Sheet of the standard', c.userId ?? null]);
  if (rows.length) await insertRows(db, 'cf_drawing_links', ['company_id', 'drawing_id', 'subject_type', 'subject_id', 'note', 'created_by'], rows, 500);
  return rows.length;
}

/**
 * Every row of a tree (a standard version's or an order line's), cut plates left out, a level at a time:
 * [{ id, parentId, path, text, isRoot, isAssembly }] — `path` is the row's place by BOM line (line no, position,
 * definition), so a line's row is found from its version's; `isAssembly` = it has a row of its own under it.
 */
export async function treeRows(db, companyId, rootId, { cutNodes = null } = {}) {
  const cuts = cutNodes ?? await cutPlateNodes(db, companyId);
  const [[root]] = await db.query(
    `SELECT m.id, m.name, n.name AS level FROM cf_master_records m LEFT JOIN cf_classification_nodes n ON n.id = m.classification_id
      WHERE m.company_id = ? AND m.id = ? AND m.deleted_at IS NULL`, [companyId, Number(rootId)]);
  if (!root) return [];
  const out = [{ id: Number(root.id), parentId: null, path: '', name: root.name, level: root.level, isRoot: true }];
  const byId = new Map(out.map((r) => [r.id, r]));
  let frontier = [Number(root.id)];
  for (let guard = 0; frontier.length && guard < 30; guard++) {
    const [kids] = await db.query(
      `SELECT b.parent_id, l.child_id, l.line_no, l.position, i.source_definition_id, m.name, m.classification_id, n.name AS level
         FROM cf_boms b
         JOIN cf_bom_lines l ON l.bom_id = b.id AND l.deleted_at IS NULL
         JOIN cf_item_details i ON i.master_id = l.child_id AND i.item_type = 'temporary' AND i.deleted_at IS NULL
         JOIN cf_master_records m ON m.id = l.child_id AND m.deleted_at IS NULL
         LEFT JOIN cf_classification_nodes n ON n.id = m.classification_id
        WHERE b.company_id = ? AND b.parent_id IN (?) AND b.deleted_at IS NULL
        ORDER BY l.line_no, l.id`,
      [companyId, frontier],
    );
    const next = [];
    for (const k of kids) {
      const id = Number(k.child_id);
      if (byId.has(id) || cuts.has(Number(k.classification_id))) continue;
      const parent = byId.get(Number(k.parent_id));
      const r = { id, parentId: Number(k.parent_id), path: `${parent.path}/${k.line_no ?? ''}.${k.position ?? ''}.${k.source_definition_id ?? ''}`, name: k.name, level: k.level, isRoot: false };
      out.push(r); byId.set(id, r); next.push(id);
    }
    frontier = next;
  }
  const [marks] = await db.query(
    `SELECT v.subject_id, v.value_text, v.value_number FROM cf_spec_values v JOIN cf_specifications s ON s.id = v.specification_id AND UPPER(s.code) = 'DRAWING_MARK'
      WHERE v.company_id = ? AND v.subject_type = 'master' AND v.deleted_at IS NULL AND v.subject_id IN (?)`,
    [companyId, out.map((r) => r.id)],
  );
  const markOf = new Map(marks.map((m) => [Number(m.subject_id), m.value_text ?? (m.value_number != null ? String(Number(m.value_number)) : null)]));
  const parents = new Set(out.filter((r) => r.parentId != null).map((r) => r.parentId));
  for (const r of out) {
    r.mark = markOf.get(r.id) ?? null;
    r.text = [r.level, r.name, r.mark].filter(Boolean).join(' ');
    r.isAssembly = parents.has(r.id);
  }
  return out;
}

/**
 * importStandard's step: the bom.json's sheets registered and linked to the version's assembly rows.
 * rows [{ id, text, isRoot }] — the plan's assembly rows with their new ids. → { sheets, links }
 */
export async function attachSheetsOnImport(db, c, { bom, rows, mainDrawingId, seriesNumber, mainRevision, sourceUrl, internal, codeBase = null }) {
  const plan = sheetLinksPlan({ sheets: bom?.drawing?.sheets ?? [], main: { number: seriesNumber, revision: mainRevision }, rows });
  if (!plan.links.length) return { sheets: 0, links: 0 };
  const used = new Set(plan.links.map((l) => l.key));
  const sheets = plan.sheets.filter((x) => used.has(x.key));   // a sheet no row is drawn on (the deck slab) is not registered
  const ids = await registerSheets(db, c, { sheets, mainDrawingId, seriesNumber: `${seriesNumber}${mainRevision ?? ''}`, sourceUrl, internal, codeBase });
  // The rows were just written: none has a sheet yet, so nothing is read to find out.
  const seen = new Set();
  const pairs = plan.links.map((l) => ({ drawingId: ids.get(l.key) ?? null, rowId: l.rowId })).filter((p) => { const k = `${p.drawingId}:${p.rowId}`; if (seen.has(k)) return false; seen.add(k); return true; });
  return { sheets: sheets.length, links: await attachLinks(db, c, pairs) };
}

/**
 * THE REPAIR for one standard imported before its sheets were linked: (1) each live version's assembly rows planned by
 * the rule, (2) the sheets they use registered (found again when they are), (3) the version links added, (4) each order
 * line made from the standard given the links its version's rows have, by BOM path (a row the line no longer has at that
 * place is counted, not guessed). Only cf_drawings (sheets) and cf_drawing_links rows are written; nothing changes or
 * goes. `commit: false` reads only (no sheet made, nothing attached) and reports what it would do.
 * → { standard, sheets: [{ number, revision, title, registered }], versions: [{ id, versionNo, assemblies, map, add }], lines: [{ id, order, add, unmatched }] }
 */
export async function repairStandardSheets(db, c, { standard, bom, commit = false }) {
  const { companyId } = c;
  const [[reg]] = await db.query('SELECT id, number, revision, url FROM cf_drawings WHERE company_id = ? AND id = ?', [companyId, Number(standard.drawing_id)]);
  if (!reg) return { standard: standard.number, skipped: 'the standard has no register drawing' };
  const sheets = bom?.drawing?.sheets ?? [];
  const main = { number: reg.number, revision: reg.revision };
  const cutNodes = await cutPlateNodes(db, companyId);
  const [versions] = await db.query('SELECT id, version_no, root_item_id FROM cf_standard_drawing_versions WHERE company_id = ? AND standard_id = ? AND deleted_at IS NULL ORDER BY version_no', [companyId, standard.id]);
  // 1. plan every version (reads only)
  const planned = [];
  const used = new Set();
  let all = [];
  for (const v of versions) {
    if (!v.root_item_id) continue;
    const rows = await treeRows(db, companyId, v.root_item_id, { cutNodes });
    const plan = sheetLinksPlan({ sheets, main, rows: rows.filter((r) => r.isAssembly) });
    for (const l of plan.links) used.add(l.key);
    all = plan.sheets;
    planned.push({ v, rows, plan });
  }
  // 2. the sheets in use, registered
  const toRegister = all.filter((x) => used.has(x.key));
  const ids = await registerSheets(db, c, { sheets: toRegister, mainDrawingId: Number(reg.id), seriesNumber: standard.number, sourceUrl: reg.url ?? standard.source_url, internal: !!Number(standard.internal), dryRun: !commit });
  const out = { standard: standard.number, sheets: toRegister.map((x) => ({ number: x.number, revision: x.revision, title: x.title, registered: ids.get(x.key) != null })), versions: [], lines: [] };
  const sheetName = (k) => (k === 'main' ? `${reg.number} rev ${reg.revision} (the series)` : all.find((x) => x.key === k)?.number ?? k);
  // 3. the versions
  const planOf = new Map();   // version id -> Map(path -> keys[])
  for (const { v, rows, plan } of planned) {
    const pathOf = new Map(rows.map((r) => [r.id, r.path]));
    const byPath = new Map();
    const keysOf = new Map();
    for (const l of plan.links) {
      const p = pathOf.get(l.rowId);
      if (!byPath.has(p)) byPath.set(p, []);
      byPath.get(p).push(l.key);
      keysOf.set(l.rowId, [...(keysOf.get(l.rowId) ?? []), l.key]);
    }
    planOf.set(Number(v.id), byPath);
    const pairs = await missingLinks(db, companyId, plan.links.map((l) => ({ drawingId: ids.get(l.key) ?? null, rowId: l.rowId })));
    const assemblies = rows.filter((r) => r.isAssembly && !r.isRoot);
    out.versions.push({
      id: Number(v.id), versionNo: Number(v.version_no), assemblies: assemblies.length,
      map: assemblies.map((r) => `${r.text} → ${(keysOf.get(r.id) ?? []).map(sheetName).join(', ')}`),
      add: commit ? await attachLinks(db, c, pairs) : pairs.length,
    });
  }
  // 4. the order lines made from it, by BOM path from their version
  const [lines] = await db.query(
    `SELECT l.id, l.item_id, l.standard_version_id, o.code AS order_code FROM cf_sales_order_lines l JOIN cf_sales_orders o ON o.id = l.order_id AND o.company_id = l.company_id
      WHERE l.company_id = ? AND l.standard_id = ? AND l.deleted_at IS NULL AND o.deleted_at IS NULL AND l.item_id IS NOT NULL`, [companyId, standard.id]);
  for (const l of lines) {
    const byPath = planOf.get(Number(l.standard_version_id));
    if (!byPath) { out.lines.push({ id: Number(l.id), order: l.order_code, add: 0, unmatched: 0, note: 'its version is not live' }); continue; }
    const rows = await treeRows(db, companyId, l.item_id, { cutNodes });
    const rowAt = new Map(rows.map((r) => [r.path, r.id]));
    const want = []; let unmatched = 0;
    for (const [p, keys] of byPath) {
      const rowId = rowAt.get(p);
      if (rowId == null) { unmatched++; continue; }
      for (const k of keys) want.push({ drawingId: ids.get(k) ?? null, rowId });
    }
    const pairs = await missingLinks(db, companyId, want);
    out.lines.push({ id: Number(l.id), order: l.order_code, add: commit ? await attachLinks(db, c, pairs) : pairs.length, unmatched });
  }
  return out;
}
