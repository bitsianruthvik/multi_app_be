/**
 * standardDrawingService.js — STANDARD DRAWINGS (init.sql §69, TM/s69.sql; contract in TM/CF_ERP_ORDER_FLOW_PLAN.md
 * "Standard drawings").
 *
 * User, 2026-10-16/17: "For every line in SO, while creating itself, give an option to upload its drawing. And if it
 * is a standard drawing, ask for standard name and store that drawing in a tab. And the BOM that gets generated can be
 * copied onto that drawing along with values. In the SO line input, we can give a way to input through drawing
 * number. And the BOM and values should get copied. We can then change it if required. And give an ability to update
 * the drawing BOM or leave that as is."
 *
 * A STANDARD is a number + name + where its sheet lives (a register drawing, cf_drawings, with its URL), and its
 * VERSIONS. A version is a BOM tree with values — the same temporary items an order line holds, owned by no line —
 * and its part files. It never changes: saving a line's BOM onto a standard writes the NEXT version, and a line made
 * from an earlier version keeps its own copy. A line records the standard and the version it came from.
 *
 * ONE COPY MACHINE. A line made from a standard and a standard saved from a line are the deep copy a revision makes
 * (treeCopyService.snapshotSubtrees + writeCopies + copyDrawingLinks): rows, details, BOMs, lines, values with their
 * history, the rows' own rules, the register links. Cut plates are never copied — a line derives its own. Values a
 * line took from its ORDER ('defaulted') are not put on a standard: the next order gives its own.
 *
 * "EDITED". A line's BOM differs from its version when their DESIGN SIGNATURES differ (designSignature): the tree's
 * definitions, quantities, roles, notes and the values a person typed ('entered'), less what cutting, nesting and the
 * drawing work out. Names, codes and worked-out values do not count.
 *
 * ROUND TRIPS (production ~49 ms each): every read and write here is a fixed number of statements a tree LEVEL, never
 * a row at a time; the files go in one INSERT … SELECT.
 */
import crypto from 'crypto';
import { invalid, notFound, conflict, assertNoProblems } from '../lib/errors.js';
import { insertRows } from '../lib/db.js';
import { snapshotSubtrees, writeCopies, copyDrawingLinks, cutPlateNodes } from './treeCopyService.js';
import { createDrawing } from './drawingService.js';
import { readPartDrawing } from './partGeometry.js';
import { normMark } from './partDrawingService.js';
import { WORKED_OUT_SPECS, DRAWING_FACT_SPECS, AFTER_LOCK_SPECS, LIVE_WHEN_FROZEN, LOCKED_ORDER_STATUSES } from './records.js';
import { planImport, normName } from '../lib/standardImport.js';

const MAX_FILE_BYTES = 4 * 1024 * 1024;
const COPY_CHUNK = 1000;
const FILE_BATCH_BYTES = 2 * 1024 * 1024;
const KINDS = { dxf: 'application/dxf', pdf: 'application/pdf' };
/** Values that are not the design: worked out by cutting, nesting or the drawing, or planning after lock. */
const NOT_SIGNED = new Set([...WORKED_OUT_SPECS, ...DRAWING_FACT_SPECS, ...AFTER_LOCK_SPECS, ...LIVE_WHEN_FROZEN]);

const blank = (v) => v == null || String(v).trim() === '';
const r3 = (n) => Math.round(Number(n) * 1000) / 1000;
const num = (v) => (v == null ? null : Number(v));
const kindOf = (name) => { const m = /\.(dxf|pdf)$/i.exec(String(name ?? '')); return m ? m[1].toLowerCase() : null; };
const decode = (content) => Buffer.from(String(content ?? '').replace(/^data:[^,]*,/, ''), 'base64');
const today = () => new Date().toISOString().slice(0, 10);
const parseJson = (v) => { if (v == null) return null; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return null; } };

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

async function requireStandard(db, companyId, id, { lock = false } = {}) {
  const [[s]] = await db.query(`SELECT * FROM cf_standard_drawings WHERE company_id = ? AND id = ? AND deleted_at IS NULL${lock ? ' FOR UPDATE' : ''}`, [companyId, Number(id)]);
  if (!s) throw notFound('Standard drawing');
  return s;
}

async function requireVersion(db, companyId, standardId, versionId) {
  const [[v]] = await db.query(
    'SELECT * FROM cf_standard_drawing_versions WHERE company_id = ? AND standard_id = ? AND id = ? AND deleted_at IS NULL',
    [companyId, Number(standardId), Number(versionId)],
  );
  if (!v) throw notFound('Version of the standard drawing');
  return v;
}

const versionView = (v) => (v ? {
  id: Number(v.id), versionNo: Number(v.version_no), rows: Number(v.rows_count), parts: Number(v.parts_count),
  weightKg: v.weight_kg == null ? null : Number(v.weight_kg), madeFrom: v.made_from, fromLineId: v.from_line_id ?? null,
  note: v.note ?? null, createdAt: v.created_at,
} : null);

function standardView(s, extra = {}) {
  return {
    id: Number(s.id), number: s.number, name: s.name, description: s.description ?? null, revision: s.revision ?? null,
    sourceUrl: s.source_url ?? null, internal: !!Number(s.internal), notes: s.notes ?? null,
    drawingId: s.drawing_id ?? null, currentVersionId: s.current_version_id ?? null,
    createdAt: s.created_at, ...extra,
  };
}

/**
 * GET /standard-drawings?search= — every standard, newest first: number, name, revision, description, the source
 * link, the current version's rows / parts / weight, how many files and how many order lines use it. 4 queries.
 */
export async function listStandards(db, companyId, q = {}) {
  const where = ['s.company_id = ?', 's.deleted_at IS NULL'];
  const params = [companyId];
  if (!blank(q.search)) {
    where.push('(s.number LIKE ? OR s.name LIKE ? OR s.description LIKE ?)');
    const like = `%${String(q.search).trim()}%`;
    params.push(like, like, like);
  }
  const limit = Math.min(Math.max(Number(q.limit) || 200, 1), 500);
  const [rows] = await db.query(
    `SELECT s.*, v.version_no, v.rows_count, v.parts_count, v.weight_kg, v.made_from, v.created_at AS version_at
       FROM cf_standard_drawings s
       LEFT JOIN cf_standard_drawing_versions v ON v.company_id = s.company_id AND v.id = s.current_version_id AND v.deleted_at IS NULL
      WHERE ${where.join(' AND ')}
      ORDER BY s.id DESC LIMIT ${limit}`,
    params,
  );
  if (!rows.length) return { rows: [] };
  const ids = rows.map((r) => r.id);
  const current = rows.map((r) => r.current_version_id).filter(Boolean);
  const [[files], [uses], [vers]] = await Promise.all([
    current.length
      ? db.query("SELECT standard_id, COUNT(*) AS n FROM cf_standard_drawing_files WHERE company_id = ? AND version_id IN (?) AND deleted_at IS NULL AND kind = 'part' GROUP BY standard_id", [companyId, current])
      : [[]],
    db.query('SELECT standard_id, COUNT(*) AS n FROM cf_sales_order_lines WHERE company_id = ? AND standard_id IN (?) AND deleted_at IS NULL GROUP BY standard_id', [companyId, ids]),
    db.query('SELECT standard_id, COUNT(*) AS n FROM cf_standard_drawing_versions WHERE company_id = ? AND standard_id IN (?) AND deleted_at IS NULL GROUP BY standard_id', [companyId, ids]),
  ]);
  const count = (list) => new Map(list.map((r) => [Number(r.standard_id), Number(r.n)]));
  const [f, u, n] = [count(files), count(uses), count(vers)];
  return {
    rows: rows.map((s) => standardView(s, {
      version: s.version_no == null ? null : { versionNo: Number(s.version_no), rows: Number(s.rows_count), parts: Number(s.parts_count), weightKg: num(s.weight_kg), madeFrom: s.made_from, createdAt: s.version_at },
      versions: n.get(Number(s.id)) ?? 0, files: f.get(Number(s.id)) ?? 0, lines: u.get(Number(s.id)) ?? 0,
    })),
  };
}

/** A value as a person reads it: "32 mm", "E250", "TF1", "yes". */
function valueText(v, spec, option) {
  if (option) return option.label ?? option.value;
  if (v.value_number != null) return `${Number(Number(v.value_number).toFixed(3))}${spec?.default_uom ? ` ${v.uom ?? spec.default_uom}` : v.uom ? ` ${v.uom}` : ''}`;
  if (v.value_text != null) return String(v.value_text);
  if (v.value_bool != null) return Number(v.value_bool) ? 'yes' : 'no';
  if (v.value_date != null) return String(v.value_date).slice(0, 10);
  if (v.value_json != null) return 'table';
  return null;
}

/**
 * The BOM tree of a version, top first, with every value and the file each row is drawn on:
 * [{ key, rowId, parentKey, depth, lineNo, role, name, kind ('row' | 'catalog' | 'choose'), definition, quantity,
 *    total, mark, notes, sizeText, grade, weightKg, values: [{ code, name, text }], fileId }].
 * A fixed handful of queries a level (snapshotSubtrees) and 3 more.
 */
export async function versionTree(db, companyId, version, files = []) {
  const rootId = Number(version.root_item_id);
  if (!rootId) return [];
  const snap = await snapshotSubtrees(db, companyId, [rootId], (l) => l.child_item_type === 'temporary');
  const specIds = new Set(); const optionIds = new Set(); const defIds = new Set();
  for (const vs of snap.values.values()) for (const v of vs) { specIds.add(v.specification_id); if (v.option_id != null) optionIds.add(v.option_id); }
  for (const it of snap.items.values()) if (it.source_definition_id) defIds.add(it.source_definition_id);
  for (const ls of snap.linesByBom.values()) for (const l of ls) if (!l.copy) { defIds.add(l.child_id); if (l.selection_definition_id) defIds.add(l.selection_definition_id); }
  const [[specs], [opts], [defs]] = await Promise.all([
    specIds.size ? db.query('SELECT id, UPPER(code) AS code, name, default_uom, data_type FROM cf_specifications WHERE company_id = ? AND id IN (?)', [companyId, [...specIds]]) : [[]],
    optionIds.size ? db.query('SELECT id, value, label FROM cf_spec_options WHERE company_id = ? AND id IN (?)', [companyId, [...optionIds]]) : [[]],
    defIds.size ? db.query('SELECT id, code, name, short_name, record_kind FROM cf_master_records WHERE company_id = ? AND id IN (?)', [companyId, [...defIds]]) : [[]],
  ]);
  const specOf = new Map(specs.map((s) => [Number(s.id), s]));
  const optOf = new Map(opts.map((o) => [Number(o.id), o]));
  const defOf = new Map(defs.map((d) => [Number(d.id), d]));
  const fileOf = new Map(files.filter((f) => f.mark_norm).map((f) => [f.mark_norm, Number(f.id)]));
  const out = [];
  const visit = (itemId, parentKey, depth, line, total) => {
    const it = snap.items.get(itemId);
    const vals = (snap.values.get(itemId) ?? []).map((v) => {
      const s = specOf.get(Number(v.specification_id));
      return { code: s?.code ?? String(v.specification_id), name: s?.name ?? null, text: valueText(v, s, v.option_id != null ? optOf.get(Number(v.option_id)) : null), number: num(v.value_number), source: v.source };
    }).sort((a, b) => a.code.localeCompare(b.code));
    const by = new Map(vals.map((v) => [v.code, v]));
    const mark = by.get('DRAWING_MARK')?.text ?? null;
    const dims = ['THICKNESS', 'WIDTH', 'LENGTH'].map((c) => by.get(c)?.number).filter((x) => x != null);
    const def = it?.source_definition_id ? defOf.get(Number(it.source_definition_id)) : null;
    const key = line ? `l${line.id}` : `r${itemId}`;
    out.push({
      key, rowId: itemId, parentKey, depth, lineNo: line?.line_no ?? null, role: line?.role ?? null, name: it?.name ?? '(missing)',
      kind: 'row', definition: def ? { id: Number(def.id), code: def.code, name: def.name } : null,
      quantity: line ? Number(line.quantity) : 1, total: r3(total), mark, notes: line?.notes ?? null,
      sizeText: dims.length === 3 ? dims.join(' × ') : null, grade: by.get('GRADE')?.text ?? null,
      weightKg: by.get('WEIGHT')?.number ?? null, values: vals.map(({ number: _n, ...v }) => v),
      fileId: mark ? fileOf.get(normMark(mark)) ?? null : null,
    });
    for (const l of (it?.bom_id ? snap.linesByBom.get(it.bom_id) ?? [] : [])) {
      const t = total * Number(l.quantity);
      if (l.copy && snap.items.has(l.child_id)) { visit(Number(l.child_id), key, depth + 1, l, t); continue; }
      const chosen = l.child_id !== l.selection_definition_id && l.selection_definition_id != null;
      const d = defOf.get(Number(l.child_id));
      out.push({
        key: `l${l.id}`, rowId: null, parentKey: key, depth: depth + 1, lineNo: l.line_no, role: l.role ?? null,
        name: d?.name ?? l.child_name ?? `#${l.child_id}`,
        kind: l.selection_definition_id != null && !chosen ? 'choose' : 'catalog',
        definition: d ? { id: Number(d.id), code: d.code, name: d.name } : null,
        quantity: Number(l.quantity), total: r3(t), mark: null, notes: l.notes ?? null, sizeText: null, grade: null, weightKg: null, values: [], fileId: null,
      });
    }
  };
  visit(rootId, null, 0, null, 1);
  return out;
}

/** The files of a standard, without their text: the version's part files, and the standard's own sheet. One query. */
async function filesOf(db, companyId, standardId, versionId) {
  const [rows] = await db.query(
    `SELECT id, version_id, kind, drawing_id, mark, mark_norm, file_name, file_kind, length_mm, width_mm, area_mm2, holes, created_at
       FROM cf_standard_drawing_files
      WHERE company_id = ? AND standard_id = ? AND deleted_at IS NULL AND (version_id IS NULL OR version_id = ?)
      ORDER BY kind DESC, mark, id`,
    [companyId, Number(standardId), versionId == null ? 0 : Number(versionId)],
  );
  return rows;
}

const fileView = (f) => ({
  id: Number(f.id), kind: f.kind, mark: f.mark ?? null, fileName: f.file_name, fileKind: f.file_kind,
  lengthMm: num(f.length_mm), widthMm: num(f.width_mm), areaMm2: num(f.area_mm2), holes: f.holes == null ? null : Number(f.holes),
  drawingId: f.drawing_id ?? null,
});

/**
 * GET /standard-drawings/:id?versionId= — the standard, its register drawing, every version, the chosen one's tree
 * (the current one by default) with values, its files, and the order lines made from it.
 */
export async function getStandard(db, companyId, id, q = {}) {
  const s = await requireStandard(db, companyId, id);
  const [[versions], [drawing], [lines]] = await Promise.all([
    db.query('SELECT * FROM cf_standard_drawing_versions WHERE company_id = ? AND standard_id = ? AND deleted_at IS NULL ORDER BY version_no DESC', [companyId, s.id]),
    s.drawing_id ? db.query('SELECT id, code, number, revision, title, url, status, source FROM cf_drawings WHERE company_id = ? AND id = ?', [companyId, s.drawing_id]) : [[]],
    db.query(
      `SELECT l.id, l.line_no, l.order_id, l.standard_version_id, o.code AS order_code, o.revision AS order_revision, o.status AS order_status
         FROM cf_sales_order_lines l JOIN cf_sales_orders o ON o.id = l.order_id AND o.deleted_at IS NULL
        WHERE l.company_id = ? AND l.standard_id = ? AND l.deleted_at IS NULL ORDER BY l.id DESC LIMIT 50`,
      [companyId, s.id],
    ),
  ]);
  const wanted = q.versionId != null && q.versionId !== '' ? Number(q.versionId) : Number(s.current_version_id ?? versions[0]?.id ?? 0);
  const version = versions.find((v) => Number(v.id) === wanted) ?? null;
  if (q.versionId != null && q.versionId !== '' && !version) throw notFound('Version of the standard drawing');
  const files = await filesOf(db, companyId, s.id, version?.id ?? null);
  const tree = version ? await versionTree(db, companyId, version, files) : [];
  const noOf = new Map(versions.map((v) => [Number(v.id), Number(v.version_no)]));
  return {
    ...standardView(s),
    drawing: drawing[0] ? { id: Number(drawing[0].id), code: drawing[0].code, number: drawing[0].number, revision: drawing[0].revision, title: drawing[0].title, url: drawing[0].url, status: drawing[0].status } : null,
    versions: versions.map(versionView),
    version: versionView(version),
    report: version?.report_json ? parseJson(version.report_json) : null,
    tree,
    files: files.map(fileView),
    lines: lines.map((l) => ({
      id: Number(l.id), lineNo: l.line_no, orderId: Number(l.order_id), orderCode: Number(l.order_revision) > 1 ? `${l.order_code} rev ${l.order_revision}` : l.order_code,
      orderStatus: l.order_status, versionNo: l.standard_version_id ? noOf.get(Number(l.standard_version_id)) ?? null : null,
    })),
  };
}

/** GET /standard-drawings/files/:fileId — one file, to view or download. */
export async function standardFile(db, companyId, fileId) {
  const [[f]] = await db.query('SELECT file_name, file_kind, file_text FROM cf_standard_drawing_files WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, Number(fileId)]);
  if (!f || f.file_text == null) throw notFound('Drawing file');
  const kind = f.file_kind === 'pdf' ? 'pdf' : 'dxf';
  return { filename: f.file_name, contentType: KINDS[kind], buffer: kind === 'pdf' ? Buffer.from(f.file_text, 'base64') : Buffer.from(f.file_text, 'latin1') };
}

// ---------------------------------------------------------------------------
// The design signature: is a line's BOM still its version's?
// ---------------------------------------------------------------------------

/**
 * One hash for the DESIGN of a tree: each row's definition and classification, the values a person typed (source
 * 'entered', less NOT_SIGNED), and its BOM lines in order — line number, role, quantity, notes, the selection, and the
 * child (a row: its own signature; a catalog item: its id; one the system chose: 'auto'). Lines to cut pieces are
 * left out: a line derives its own. Reads a level at a time (snapshotSubtrees) + 1.
 */
export async function designSignature(db, companyId, rootId, { cutNodes = null } = {}) {
  if (!rootId) return null;
  const cuts = cutNodes ?? await cutPlateNodes(db, companyId);
  const isCut = (l) => l.child_item_type === 'temporary' && cuts.has(l.child_classification_id);
  const snap = await snapshotSubtrees(db, companyId, [Number(rootId)], (l) => l.child_item_type === 'temporary' && !isCut(l));
  const specIds = new Set();
  for (const vs of snap.values.values()) for (const v of vs) specIds.add(v.specification_id);
  const [specs] = specIds.size ? await db.query('SELECT id, UPPER(code) AS code FROM cf_specifications WHERE company_id = ? AND id IN (?)', [companyId, [...specIds]]) : [[]];
  const skip = new Set(specs.filter((s) => NOT_SIGNED.has(s.code)).map((s) => Number(s.id)));
  const canon = (id, guard = 0) => {
    const it = snap.items.get(id);
    if (!it || guard > 30) return null;
    const vals = (snap.values.get(id) ?? [])
      .filter((v) => v.source === 'entered' && !skip.has(Number(v.specification_id)))
      .map((v) => [Number(v.specification_id), v.value_number == null ? null : Number(v.value_number), v.value_text ?? null,
        v.value_bool == null ? null : Number(v.value_bool), v.value_date == null ? null : String(v.value_date).slice(0, 10), v.option_id ?? null,
        v.value_json == null ? null : JSON.stringify(parseJson(v.value_json))])
      .sort((a, b) => a[0] - b[0]);
    const lines = (it.bom_id ? snap.linesByBom.get(it.bom_id) ?? [] : [])
      .filter((l) => !isCut(l))
      .slice().sort((a, b) => a.line_no - b.line_no || a.position - b.position || a.id - b.id)
      .map((l) => [l.line_no, l.role ?? null, Number(l.quantity), l.notes ?? null, l.selection_definition_id ?? null,
        l.copy ? canon(Number(l.child_id), guard + 1) : (l.auto_chosen ? 'auto' : Number(l.child_id))]);
    return [it.source_definition_id ?? null, it.classification_id ?? null, vals, lines];
  };
  return crypto.createHash('sha1').update(JSON.stringify(canon(Number(rootId)))).digest('hex');
}

// ---------------------------------------------------------------------------
// Copies in and out
// ---------------------------------------------------------------------------

/** Rows, parts (rows with no row below them) and the root's weight, from a snapshot. */
function statsOf(snap, rootId, weightSpecId) {
  let rows = 0; let parts = 0;
  for (const it of snap.items.values()) {
    rows++;
    const kids = it.bom_id ? (snap.linesByBom.get(it.bom_id) ?? []).filter((l) => l.copy) : [];
    if (!kids.length) parts++;
  }
  const w = weightSpecId ? (snap.values.get(Number(rootId)) ?? []).find((v) => Number(v.specification_id) === Number(weightSpecId)) : null;
  return { rows, parts, weightKg: w?.value_number == null ? null : r3(w.value_number) };
}

async function weightSpecId(db, companyId) {
  const [[s]] = await db.query("SELECT id FROM cf_specifications WHERE company_id = ? AND code = 'WEIGHT' AND deleted_at IS NULL", [companyId]);
  return s?.id ?? null;
}

/** The order line, with its order and whether it is frozen. */
async function requireLine(db, companyId, lineId, { lock = false } = {}) {
  const [[l]] = await db.query(
    `SELECT l.*, o.code AS order_code, o.status AS order_status, o.order_type, o.revision AS order_revision,
            EXISTS (SELECT 1 FROM cf_production_releases r WHERE r.company_id = l.company_id AND r.order_line_id = l.id AND r.deleted_at IS NULL) AS released
       FROM cf_sales_order_lines l JOIN cf_sales_orders o ON o.id = l.order_id AND o.deleted_at IS NULL
      WHERE l.company_id = ? AND l.id = ? AND l.deleted_at IS NULL${lock ? ' FOR UPDATE' : ''}`,
    [companyId, Number(lineId)],
  );
  if (!l) throw notFound('Order line');
  return l;
}

/**
 * The version's tree copied onto a NEW line (the line's own rows): rows, values, rules, links; its part files onto the
 * line (cf_part_drawings, each on its register revision); then everything a line works out for itself — flow rules,
 * values in the line's context (order values included), names, cut lengths, the drawings' facts, cut pieces.
 */
async function copyVersionToLine(db, c, version, lineId) {
  const { companyId } = c;
  const rootId = Number(version.root_item_id);
  const snap = await snapshotSubtrees(db, companyId, [rootId], (l) => l.child_item_type === 'temporary');
  const { idMap } = await writeCopies(db, c, snap, [{ srcId: rootId, ownerLineId: lineId }], { chunk: COPY_CHUNK, links: 'fresh' });
  const newRoot = idMap.get(rootId);
  if (!newRoot) throw new Error(`cf_erp: the rows of version ${version.version_no} could not be read to copy them.`);
  await db.query('UPDATE cf_sales_order_lines SET item_id = ?, standard_id = ?, standard_version_id = ?, standard_kept_sig = NULL WHERE company_id = ? AND id = ?',
    [newRoot, version.standard_id, version.id, companyId, lineId]);
  await copyDrawingLinks(db, c, idMap, { chunk: COPY_CHUNK });
  // The part files, onto the line — one statement, whatever their number.
  await db.query(
    `INSERT INTO cf_part_drawings (company_id, order_line_id, drawing_id, mark, mark_norm, file_name, file_kind, length_mm, width_mm, area_mm2,
                                   cut_length_mm, piercings, holes, inner_cuts, geometry_json, warnings_json, dxf_text, created_by)
     SELECT company_id, ?, drawing_id, mark, mark_norm, file_name, file_kind, length_mm, width_mm, area_mm2,
            cut_length_mm, piercings, holes, inner_cuts, geometry_json, warnings_json, file_text, ?
       FROM cf_standard_drawing_files
      WHERE company_id = ? AND version_id = ? AND kind = 'part' AND deleted_at IS NULL AND mark_norm IS NOT NULL AND file_text IS NOT NULL`,
    [lineId, c.userId ?? null, companyId, version.id],
  );
  const ids = [...idMap.values()];
  const names = new Map([...idMap].map(([src, fresh]) => [fresh, snap.items.get(src)?.name ?? null]));
  const { syncFlowSpecs } = await import('./flowSpecService.js');
  const { materializeLineRecords } = await import('./orderValuesService.js');
  const { nameNewItems } = await import('./codeRangeService.js');
  await syncFlowSpecs(db, c, ids, { settle: false });
  await materializeLineRecords(db, c, lineId, ids);
  await nameNewItems(db, c, { rootId: newRoot, parentId: null, ids, fallbackName: names });
  const { refreshPlateCuts } = await import('./plateCutsService.js');
  const { refreshDrawingValues } = await import('./drawingValueService.js');
  const { refreshCutPieces } = await import('./cutPlateService.js');
  await refreshPlateCuts(db, c, lineId);
  await refreshDrawingValues(db, c, lineId, { force: true });
  const cut = await refreshCutPieces(db, c, lineId);
  return { rootId: newRoot, rows: ids.length, cutPieces: { made: cut.made, reason: cut.reason ?? null, message: cut.message ?? null } };
}

/**
 * POST /orders/:id/lines/from-standard — a new line made from a standard: { standardId | number, versionId?,
 * quantity, committedDate?, description?, lineNo?, notes?, rate?, rateBasis? }. The line sells the version's root
 * definition, with a deep copy of its BOM, values and part drawings, editable until lock. Needs a transaction.
 * Returns the order (getOrder) with `fromStandard` { lineId, standardId, versionNo, rows, cutPieces }.
 */
export async function addLineFromStandard(db, c, orderId, input = {}) {
  const { companyId } = c;
  let s;
  if (!blank(input.standardId)) s = await requireStandard(db, companyId, input.standardId);
  else if (!blank(input.number)) {
    const [[hit]] = await db.query('SELECT * FROM cf_standard_drawings WHERE company_id = ? AND number_active = ?', [companyId, String(input.number).trim().toLowerCase()]);
    if (!hit) throw invalid('NO_STANDARD', `No standard drawing ${String(input.number).trim()} — check the number, or add it under Standard drawings.`);
    s = hit;
  } else throw invalid('NO_STANDARD', 'Choose the standard drawing.');
  const versionId = !blank(input.versionId) ? Number(input.versionId) : s.current_version_id;
  if (!versionId) throw invalid('NO_BOM', `${s.number} has no BOM yet. Make the line from a template, then save its BOM to the standard.`);
  const version = await requireVersion(db, companyId, s.id, versionId);
  if (!version.root_item_id || !version.design_id) throw invalid('NO_BOM', `Version ${version.version_no} of ${s.number} has no BOM.`);
  const { addOrderLine } = await import('./salesOrderService.js');
  let made = null;
  const order = await addOrderLine(db, c, orderId, {
    recordId: version.design_id, quantity: input.quantity, committedDate: input.committedDate, description: blank(input.description) ? s.name.slice(0, 500) : input.description,
    lineNo: input.lineNo, notes: input.notes, rate: input.rate, rateBasis: input.rateBasis,
  }, { build: async (lineId) => { made = { lineId, ...(await copyVersionToLine(db, c, version, lineId)) }; } });
  const { getOrder } = await import('./salesOrderService.js');
  const fresh = made ? await getOrder(db, companyId, orderId) : order;
  return { ...fresh, fromStandard: made ? { lineId: made.lineId, standardId: Number(s.id), number: s.number, versionNo: Number(version.version_no), rows: made.rows, cutPieces: made.cutPieces } : null };
}

/**
 * A new version of a standard from a line's BOM: the line's rows copied (cut plates left out, values the order gave
 * left out), their register links, and the line's files. Stats worked out from the snapshot. → the version row.
 */
async function writeVersionFromLine(db, c, s, line, { note = null } = {}) {
  const { companyId } = c;
  const cuts = await cutPlateNodes(db, companyId);
  const isCut = (l) => l.child_item_type === 'temporary' && cuts.has(l.child_classification_id);
  const snap = await snapshotSubtrees(db, companyId, [Number(line.item_id)], (l) => l.child_item_type === 'temporary' && !isCut(l));
  if (!snap.items.has(Number(line.item_id))) throw invalid('NO_BOM', `Line ${line.line_no} of ${line.order_code} has no BOM to save.`);
  // What the ORDER gave a row is not the standard's: the next order gives its own.
  for (const [id, vs] of snap.values) snap.values.set(id, vs.filter((v) => v.source !== 'defaulted'));
  const { idMap } = await writeCopies(db, c, snap, [{ srcId: Number(line.item_id), ownerLineId: null }], { keepLine: (l) => !isCut(l), chunk: COPY_CHUNK, links: 'fresh' });
  const root = idMap.get(Number(line.item_id));
  await copyDrawingLinks(db, c, idMap, { chunk: COPY_CHUNK });
  const stats = statsOf(snap, Number(line.item_id), await weightSpecId(db, companyId));
  const [[{ top }]] = await db.query('SELECT MAX(version_no) AS top FROM cf_standard_drawing_versions WHERE company_id = ? AND standard_id = ?', [companyId, s.id]);
  const versionNo = (Number(top) || 0) + 1;
  const [ins] = await db.query(
    `INSERT INTO cf_standard_drawing_versions (company_id, standard_id, version_no, root_item_id, design_id, rows_count, parts_count, weight_kg, made_from, from_line_id, note, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'line', ?, ?, ?)`,
    [companyId, s.id, versionNo, root, line.design_id, stats.rows, stats.parts, stats.weightKg, line.id, blank(note) ? null : String(note).slice(0, 500), c.userId ?? null],
  );
  const versionId = ins.insertId;
  await db.query(
    `INSERT INTO cf_standard_drawing_files (company_id, version_id, standard_id, kind, drawing_id, mark, mark_norm, file_name, file_kind, length_mm, width_mm, area_mm2,
                                            cut_length_mm, piercings, holes, inner_cuts, geometry_json, warnings_json, file_text, created_by)
     SELECT company_id, ?, ?, 'part', drawing_id, mark, mark_norm, file_name, file_kind, length_mm, width_mm, area_mm2,
            cut_length_mm, piercings, holes, inner_cuts, geometry_json, warnings_json, dxf_text, ?
       FROM cf_part_drawings WHERE company_id = ? AND order_line_id = ? AND deleted_at IS NULL`,
    [versionId, s.id, c.userId ?? null, companyId, line.id],
  );
  await db.query('UPDATE cf_standard_drawings SET current_version_id = ? WHERE company_id = ? AND id = ?', [versionId, companyId, s.id]);
  return { id: versionId, version_no: versionNo, ...stats };
}

/**
 * GET /order-lines/:id/standard — where the line stands with its standard drawing:
 * { line, standard, version (the one it came from), latest, edited, kept, offer: 'save' | 'update' | null, canCreate }.
 *   save    the line is tied to a standard that has no BOM from it yet → "Save this BOM to the standard"
 *   update  its BOM differs from the version it came from (and nobody chose "keep" for this BOM) →
 *           "Update the standard too (new version)" or "Keep the standard as it is"
 */
export async function lineStandard(db, companyId, lineId) {
  const line = await requireLine(db, companyId, lineId);
  const lineView = { id: Number(line.id), lineNo: line.line_no, orderId: Number(line.order_id), orderCode: line.order_code, hasBom: line.line_type === 'custom' && !!line.item_id, locked: !!line.locked_at };
  if (!line.standard_id) return { line: lineView, standard: null, version: null, latest: null, edited: false, kept: false, offer: null, canCreate: lineView.hasBom };
  const s = await requireStandard(db, companyId, line.standard_id);
  const [vers] = await db.query('SELECT * FROM cf_standard_drawing_versions WHERE company_id = ? AND standard_id = ? AND deleted_at IS NULL ORDER BY version_no DESC', [companyId, s.id]);
  const version = vers.find((v) => Number(v.id) === Number(line.standard_version_id)) ?? null;
  const latest = vers[0] ?? null;
  let edited = false; let kept = false; let signature = null;
  if (version && lineView.hasBom) {
    const cutNodes = await cutPlateNodes(db, companyId);
    signature = await designSignature(db, companyId, line.item_id, { cutNodes });
    edited = signature !== await designSignature(db, companyId, version.root_item_id, { cutNodes });
    kept = edited && line.standard_kept_sig === signature;
  }
  const offer = !lineView.hasBom ? null : !version ? 'save' : edited && !kept ? 'update' : null;
  return {
    line: lineView, standard: standardView(s), version: versionView(version), latest: versionView(latest),
    newer: !!(version && latest && Number(latest.version_no) > Number(version.version_no)),
    edited, kept, offer, canCreate: false,
  };
}

/**
 * POST /order-lines/:id/standard/save { note? } — the line's BOM and values become the NEXT version of its standard.
 * Lines made from earlier versions keep their own copies; this line now counts as made from the new version.
 */
export async function saveLineToStandard(db, c, lineId, input = {}) {
  const { companyId } = c;
  const line = await requireLine(db, companyId, lineId, { lock: true });
  if (!line.standard_id) throw invalid('NO_STANDARD', `Line ${line.line_no} is not tied to a standard drawing. Mark it as one first.`);
  if (line.line_type !== 'custom' || !line.item_id) throw invalid('NO_BOM', `Line ${line.line_no} sells a catalog item — it has no BOM of its own to save.`);
  const s = await requireStandard(db, companyId, line.standard_id, { lock: true });
  const v = await writeVersionFromLine(db, c, s, line, { note: input.note });
  await db.query('UPDATE cf_sales_order_lines SET standard_version_id = ?, standard_kept_sig = NULL WHERE company_id = ? AND id = ?', [v.id, companyId, line.id]);
  return { saved: { versionId: Number(v.id), versionNo: v.version_no, rows: v.rows, parts: v.parts, weightKg: v.weightKg }, ...(await lineStandard(db, companyId, lineId)) };
}

/** POST /order-lines/:id/standard/keep — "Keep the standard as it is": this BOM stops asking; a further edit asks again. */
export async function keepStandard(db, c, lineId) {
  const { companyId } = c;
  const line = await requireLine(db, companyId, lineId, { lock: true });
  if (!line.standard_id || !line.item_id) throw invalid('NO_STANDARD', `Line ${line.line_no} is not made from a standard drawing.`);
  const sig = await designSignature(db, companyId, line.item_id);
  await db.query('UPDATE cf_sales_order_lines SET standard_kept_sig = ? WHERE company_id = ? AND id = ?', [sig, companyId, line.id]);
  return lineStandard(db, companyId, lineId);
}

// ---------------------------------------------------------------------------
// Create and change a standard
// ---------------------------------------------------------------------------

function readFields(input, problems, { create = false } = {}) {
  const out = {};
  if (create || input.number !== undefined) {
    const number = String(input.number ?? '').trim();
    if (!number) problems.push('A standard drawing needs its number, as it is written on the sheet.');
    else if (number.length > 150) problems.push('The number is up to 150 characters.');
    out.number = number;
  }
  if (create || input.name !== undefined) {
    const name = String(input.name ?? '').trim();
    if (name.length > 255) problems.push('The name is up to 255 characters.');
    out.name = name || out.number || null;
    if (!out.name) problems.push('Give the standard a name.');
  }
  if (input.description !== undefined) out.description = blank(input.description) ? null : String(input.description).trim();
  if (input.revision !== undefined) {
    const r = blank(input.revision) ? null : String(input.revision).trim();
    if (r && (r.length > 20 || !/^[A-Za-z0-9._/-]+$/.test(r))) problems.push('Revision: up to 20 letters, digits and - _ . /, no spaces.');
    out.revision = r;
  }
  if (input.sourceUrl !== undefined) {
    const u = blank(input.sourceUrl) ? null : String(input.sourceUrl).trim();
    if (u && (u.length > 1000 || /^\s*(javascript|data|vbscript):/i.test(u))) problems.push('The link must be a web address or a share path.');
    out.source_url = u;
  }
  if (input.internal !== undefined) out.internal = input.internal ? 1 : 0;
  if (input.notes !== undefined) out.notes = blank(input.notes) ? null : String(input.notes);
  return out;
}

/** The register drawing a standard's sheet is: the customer's number and revision, made once and found again. */
async function registerDrawingFor(db, c, { number, revision, title, url, notes }) {
  const rev = revision || 'A';
  const [[have]] = await db.query(
    "SELECT id FROM cf_drawings WHERE company_id = ? AND source = 'customer' AND number_active = ? AND revision = ? AND deleted_at IS NULL",
    [c.companyId, String(number).toLowerCase(), rev],
  );
  if (have) return Number(have.id);
  const d = await createDrawing(db, c, { number, revision: rev, title: title ? String(title).slice(0, 255) : null, source: 'customer', url: url ?? null, status: 'issued', notes: notes ?? null });
  return Number(d.id);
}

/**
 * POST /standard-drawings { number, name?, description?, revision?, sourceUrl?, internal?, notes?, file?: { name, content } }
 * and POST /order-lines/:id/standard (the same, with the line): a new standard. Its sheet is a register drawing
 * (the customer's number and revision); an uploaded file (DXF or PDF, up to 4 MB) is kept as the standard's own. With
 * a line: the line is tied to the standard, and the file also goes on the line's top row (the existing upload). No
 * BOM yet — "Save this BOM to the standard" makes the first version. Needs a transaction. → getStandard.
 */
export async function createStandard(db, c, input = {}, { lineId = null } = {}) {
  const { companyId } = c;
  const problems = [];
  const f = readFields(input, problems, { create: true });
  let file = null;
  if (input.file && (input.file.name || input.file.content)) {
    const kind = kindOf(input.file.name);
    const buf = decode(input.file.content);
    if (!kind) problems.push('The drawing must be a DXF or a PDF.');
    else if (!buf.length) problems.push('The drawing file is empty.');
    else if (buf.length > MAX_FILE_BYTES) problems.push('The drawing file is larger than 4 MB. Give its link instead.');
    else if (kind === 'pdf' && buf.subarray(0, 5).toString('latin1') !== '%PDF-') problems.push('This does not read as a PDF file.');
    else file = { name: String(input.file.name).trim().slice(0, 255), kind, buf, content: input.file.content };
  }
  let line = null;
  if (lineId != null) {
    line = await requireLine(db, companyId, lineId, { lock: true });
    if (line.standard_id) problems.push(`Line ${line.line_no} is already tied to a standard drawing.`);
    if (LOCKED_ORDER_STATUSES.has(line.order_status)) problems.push(`${line.order_code} is ${line.order_status}.`);
  }
  assertNoProblems(problems);
  const [[dup]] = await db.query('SELECT id FROM cf_standard_drawings WHERE company_id = ? AND number_active = ?', [companyId, f.number.toLowerCase()]);
  if (dup) throw conflict('DUPLICATE', `Standard drawing ${f.number} is already there. Pick it from the list.`, { standardId: Number(dup.id) });

  const drawingId = await registerDrawingFor(db, c, { number: f.number, revision: f.revision, title: f.name, url: f.source_url, notes: f.notes });
  const [ins] = await db.query(
    `INSERT INTO cf_standard_drawings (company_id, number, name, description, revision, drawing_id, source_url, internal, notes, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [companyId, f.number, f.name, f.description ?? null, f.revision ?? null, drawingId, f.source_url ?? null, f.internal ?? 0, f.notes ?? null, c.userId ?? null],
  );
  const id = ins.insertId;
  if (file) {
    await insertRows(db, 'cf_standard_drawing_files', ['company_id', 'version_id', 'standard_id', 'kind', 'drawing_id', 'mark', 'mark_norm', 'file_name', 'file_kind', 'file_text', 'created_by'],
      [[companyId, null, id, 'source', drawingId, null, null, file.name, file.kind, file.kind === 'pdf' ? file.buf.toString('base64') : file.buf.toString('latin1'), c.userId ?? null]]);
  }
  if (line) {
    await db.query('UPDATE cf_sales_order_lines SET standard_id = ?, standard_version_id = NULL, standard_kept_sig = NULL WHERE company_id = ? AND id = ?', [id, companyId, line.id]);
    if (file && line.item_id && !Number(line.released)) {
      // The sheet is the drawing of the line's top row too: linked first, so the upload puts the file on that revision.
      await insertRows(db, 'cf_drawing_links', ['company_id', 'drawing_id', 'subject_type', 'subject_id', 'created_by'], [[companyId, drawingId, 'master_record', line.item_id, c.userId ?? null]]);
      const { uploadDrawings } = await import('./partDrawingService.js');
      await uploadDrawings(db, c, null, line.id, { files: [{ name: file.name, content: file.content, drawingId }], dryRun: false });
    }
  }
  return getStandard(db, companyId, id);
}

/** PUT /standard-drawings/:id { name?, description?, revision?, sourceUrl?, internal?, notes? } — the number stays. */
export async function updateStandard(db, c, id, input = {}) {
  const s = await requireStandard(db, c.companyId, id, { lock: true });
  const problems = [];
  if (input.number !== undefined && String(input.number).trim() !== s.number) problems.push('The number of a standard drawing does not change. Add a new standard for a new number.');
  const f = readFields({ ...input, number: undefined }, problems);
  assertNoProblems(problems);
  const sets = Object.entries(f).filter(([k]) => k !== 'number');
  if (sets.length) {
    await db.query(`UPDATE cf_standard_drawings SET ${sets.map(([k]) => `${k} = ?`).join(', ')} WHERE company_id = ? AND id = ?`, [...sets.map(([, v]) => v), c.companyId, s.id]);
  }
  return getStandard(db, c.companyId, s.id);
}

// ---------------------------------------------------------------------------
// The importer (scripts/cf_kepl/standard-import.mjs)
// ---------------------------------------------------------------------------

/** What planImport needs to know about the tenant. 5 queries. */
export async function importCatalog(db, companyId) {
  const [[defs], [specs], [grades], [studs], [existing]] = await Promise.all([
    db.query(
      `SELECT m.id, m.code, m.name, m.short_name, m.status, m.classification_id, m.default_flow_id, d.definition_type, b.id AS bom_id, b.status AS bom_status
         FROM cf_master_records m
         JOIN cf_definition_details d ON d.master_id = m.id AND d.deleted_at IS NULL
         LEFT JOIN cf_boms b ON b.company_id = m.company_id AND b.parent_id = m.id AND b.deleted_at IS NULL
        WHERE m.company_id = ? AND m.record_kind = 'definition' AND m.deleted_at IS NULL`,
      [companyId],
    ),
    db.query('SELECT id, UPPER(code) AS code, data_type, default_uom FROM cf_specifications WHERE company_id = ? AND deleted_at IS NULL', [companyId]),
    db.query(
      `SELECT o.id, o.value, o.label FROM cf_spec_options o JOIN cf_specifications s ON s.id = o.specification_id AND s.deleted_at IS NULL
        WHERE s.company_id = ? AND s.code = 'GRADE' AND o.deleted_at IS NULL`,
      [companyId],
    ),
    db.query(
      `SELECT m.id, m.code, m.name FROM cf_master_records m JOIN cf_item_details i ON i.master_id = m.id AND i.item_type = 'catalog' AND i.deleted_at IS NULL
        WHERE m.company_id = ? AND m.deleted_at IS NULL AND m.status = 'active' AND LOWER(m.name) LIKE '%stud%'`,
      [companyId],
    ),
    db.query('SELECT id, number FROM cf_standard_drawings WHERE company_id = ? AND deleted_at IS NULL', [companyId]),
  ]);
  const gradeOption = new Map();
  for (const g of grades) { if (g.value) gradeOption.set(String(g.value).toUpperCase(), Number(g.id)); if (g.label && !gradeOption.has(String(g.label).toUpperCase())) gradeOption.set(String(g.label).toUpperCase(), Number(g.id)); }
  return {
    defs: defs.map((d) => ({ ...d, id: Number(d.id) })),
    specs: new Map(specs.map((s) => [s.code, { id: Number(s.id), data_type: s.data_type, default_uom: s.default_uom }])),
    gradeOption,
    studs: studs.map((s) => ({ id: Number(s.id), code: s.code, name: s.name })),
    standards: new Map(existing.map((s) => [String(s.number).toLowerCase(), Number(s.id)])),
  };
}

/** Where a NEW definition is filed: beside the definitions its kind of row already uses. */
function classFor(catalog, hint) {
  const byName = (names) => {
    for (const n of names) { const d = catalog.defs.find((x) => normName(x.name) === normName(n) && x.status === 'active'); if (d) return Number(d.classification_id); }
    return null;
  };
  if (hint === 'plate') return byName(['Top flange', 'Bottom flange', 'Web plate', 'Pad plate']);
  if (hint === 'profile') return byName(['X-frame top angle', 'Bracing', 'Bottom lateral bracing member']);
  if (hint === 'structure') return byName(['Girder line', 'Bridge span']);
  return byName(['Girder segment', 'End diaphragm', 'Splice set']);
}

/** A short name for a new definition, free among the company's: its mark's letters, else its initials. */
function shortNameFor(catalog, name, mark, taken) {
  const used = new Set([...catalog.defs.map((d) => String(d.short_name ?? '').toUpperCase()), ...taken]);
  const fromMark = String(mark ?? '').replace(/[^A-Za-z]/g, '').toUpperCase();
  const initials = String(name).split(/\s+/).map((w) => w[0]).join('').toUpperCase();
  for (const cand of [fromMark, initials, `${initials}X`, `${fromMark}2`]) if (cand && cand.length <= 30 && !used.has(cand)) { taken.add(cand); return cand; }
  const n = `${initials}${Date.now() % 1000}`; taken.add(n); return n;
}

/**
 * The plan for a bom.json, and — when `apply` — the standard written in the caller's transaction:
 *   new definitions (only those nothing fits; created and activated through masterRecordService),
 *   the register drawing of the sheet (the customer's number and revision, with the source link),
 *   the standard and its version 1,
 *   the tree (writeCopies from a synthetic snapshot: items, details, BOMs, lines, values + history — bulk),
 *   a register drawing per part file (one INSERT), the links (one INSERT), the files (one INSERT a 2 MB batch).
 * `files` [{ name, text }] are the dxf/ folder's files. Returns { plan, report, standardId? }.
 */
export async function importStandard(db, c, { bom, files = [], apply = false, sourceUrl = null, catalog: given = null } = {}) {
  const { companyId } = c;
  const catalog = given ?? await importCatalog(db, companyId);
  const plan = planImport(bom, catalog);
  if (sourceUrl) plan.standard.sourceUrl = sourceUrl;
  const byFile = new Map(files.map((f) => [String(f.name).toLowerCase(), f]));
  const fileRows = plan.files.map((pf) => {
    const f = byFile.get(String(pf.file).toLowerCase());
    if (!f) return { ...pf, missing: true };
    const read = readPartDrawing(f.text);
    return { ...pf, text: f.text, geometry: read.geometry ?? null, warnings: [...(read.warnings ?? []), ...(read.geometry ? [] : read.problems ?? [])] };
  });
  for (const f of fileRows) if (f.missing) plan.problems.push(`${f.mark}: ${f.file} is not in the dxf folder.`);
  for (const f of fileRows) if (!f.missing && !f.geometry) plan.problems.push(`${f.mark}: ${f.file} has no shape the app can read (${f.warnings.join(' ') || 'no outline'}).`);
  const existingId = catalog.standards.get(plan.standard.number.toLowerCase()) ?? null;
  const report = reportOf(plan, fileRows, existingId);
  if (!apply) return { plan, report, standardId: existingId };
  if (existingId) throw conflict('DUPLICATE', `Standard drawing ${plan.standard.number} is already there (id ${existingId}). Nothing was written.`, { standardId: existingId });

  // ---- 1. the new definitions (rare: only what nothing in the catalog fits) ----
  const { createDefinition, setStatus } = await import('./masterRecordService.js');
  const made = new Map();
  const taken = new Set();
  for (const nd of plan.newDefinitions) {
    const classificationId = classFor(catalog, nd.classHint);
    if (!classificationId) throw invalid('NO_CLASS', `No place to file the new definition ${nd.name}: the catalog has none of the usual ${nd.classHint} definitions.`);
    const mark = plan.rows.find((r) => r.def?.new === nd.name)?.mark ?? null;
    const rec = await createDefinition(db, c, { definitionType: 'template', classificationId, name: nd.name, shortName: shortNameFor(catalog, nd.name, mark, taken) });
    const active = await setStatus(db, c, rec.id, 'active');
    made.set(nd.name, { id: Number(rec.id), code: active.code ?? null, name: nd.name, classification_id: classificationId, default_flow_id: null, bom_id: null });
  }
  for (const r of plan.rows) if (r.def?.new) r.def = made.get(r.def.new);

  // ---- 2. the sheet in the register, and the standard ----------------------
  const s = plan.standard;
  const notes = [s.ownership, s.sheets?.length ? `Sheets: ${s.sheets.map((x) => `${x.number} ${x.title}`).join('; ')}` : null,
    plan.bought.length ? `Bought out, not in the BOM: ${plan.bought.map((b) => `${b.quantity} × ${b.description}${b.profile ? ` (${b.profile})` : ''}`).join('; ')}` : null]
    .filter(Boolean).join('\n');
  const drawingId = await registerDrawingFor(db, c, { number: s.registerNumber, revision: s.revision, title: s.description ?? s.name, url: s.sourceUrl, notes });
  const [insS] = await db.query(
    `INSERT INTO cf_standard_drawings (company_id, number, name, description, revision, drawing_id, source_url, internal, notes, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [companyId, s.number, s.name.slice(0, 255), s.description, s.revision, drawingId, s.sourceUrl, s.internal ? 1 : 0, notes || null, c.userId ?? null],
  );
  const standardId = insS.insertId;

  // ---- 3. the tree: a synthetic snapshot, written by the one copy machine ----
  const snap = { items: new Map(), linesByBom: new Map(), values: new Map(), rules: new Map(), ruleOptions: new Map() };
  const srcOf = new Map(); let n = 0;
  for (const r of plan.rows) if (r.kind === 'temp') srcOf.set(r.key, ++n);
  const bomOf = new Map(); let b = 0;
  for (const r of plan.rows) if (r.kind === 'temp' && r.children.length) bomOf.set(r.key, ++b);
  for (const r of plan.rows) {
    if (r.kind !== 'temp') continue;
    const id = srcOf.get(r.key);
    snap.items.set(id, {
      id, name: r.def.name, short_name: null, description: null, classification_id: r.def.classification_id, default_flow_id: r.def.default_flow_id ?? null,
      status: 'draft', tracked_by: 'individual', uom: 'nos', source_definition_id: r.def.id, link_group: null,
      bom_id: bomOf.get(r.key) ?? null, bom_status: 'draft', source_bom_id: r.def.bom_id ?? null, bom_revision: null, bom_notes: null,
    });
    snap.values.set(id, r.values.map((v) => {
      const spec = catalog.specs.get(v.code);
      return {
        specification_id: spec.id, subject_id: id, value_number: v.number ?? null, value_text: v.text ?? null, value_bool: null, value_date: null,
        option_id: v.optionId ?? null, value_json: null, uom: v.uom ?? null, source: v.source ?? 'entered',
      };
    }));
    if (r.children.length) {
      snap.linesByBom.set(bomOf.get(r.key), r.children.map((k) => {
        const sel = k.kind === 'selection';
        return {
          id: 0, bom_id: bomOf.get(r.key), line_no: k.lineNo, child_id: sel ? (k.chosen?.id ?? k.def.id) : srcOf.get(k.key), design_id: k.def.id,
          position: k.position, role: k.role, quantity: k.quantity, selection_definition_id: sel ? k.def.id : null, source_line_id: null,
          operation_flow_id: null, notes: k.notes ?? null, auto_chosen: null, copy: !sel, child_item_type: sel ? (k.chosen ? 'catalog' : null) : 'temporary',
          child_code: null, child_name: k.def.name,
        };
      }));
    }
  }
  const rootKey = plan.rows[0]?.key;
  const { idMap } = await writeCopies(db, c, snap, [{ srcId: srcOf.get(rootKey), ownerLineId: null }], { chunk: COPY_CHUNK });
  const rowIdOf = (key) => idMap.get(srcOf.get(key));
  const root = rowIdOf(rootKey);

  // ---- 4. the version ---------------------------------------------------------
  const tempRows = plan.rows.filter((r) => r.kind === 'temp');
  const [insV] = await db.query(
    `INSERT INTO cf_standard_drawing_versions (company_id, standard_id, version_no, root_item_id, design_id, rows_count, parts_count, weight_kg, made_from, note, report_json, created_by)
     VALUES (?, ?, 1, ?, ?, ?, ?, ?, 'import', ?, ?, ?)`,
    [companyId, standardId, root, plan.rows[0].def.id, tempRows.length, plan.totals.parts, plan.totals.steelKg, `Imported from ${bom.set ?? 'bom.json'}`.slice(0, 500), JSON.stringify(report), c.userId ?? null],
  );
  const versionId = insV.insertId;
  await db.query('UPDATE cf_standard_drawings SET current_version_id = ? WHERE company_id = ? AND id = ?', [versionId, companyId, standardId]);

  // ---- 5. a register drawing per part file (our redrawing of the part), each linked to its rows ----
  const okFiles = fileRows.filter((f) => !f.missing);
  const partNumber = (mark) => `${s.number}/${mark}`.slice(0, 150);
  const [[mainCode]] = await db.query('SELECT code FROM cf_drawings WHERE company_id = ? AND id = ?', [companyId, drawingId]);
  const drawingOf = new Map();
  if (okFiles.length) {
    const numbers = okFiles.map((f) => partNumber(f.mark));
    const [have] = await db.query("SELECT id, number, root_id, revision FROM cf_drawings WHERE company_id = ? AND source = 'shop' AND deleted_at IS NULL AND status IN ('draft', 'issued') AND number_active IN (?)", [companyId, numbers.map((x) => x.toLowerCase())]);
    for (const h of have) drawingOf.set(String(h.number).toLowerCase(), Number(h.id));
    const fresh = okFiles.filter((f) => !drawingOf.has(partNumber(f.mark).toLowerCase()));
    if (fresh.length) {
      const codeBase = String(mainCode?.code ?? `STD${standardId}`);
      await insertRows(db, 'cf_drawings', ['company_id', 'code', 'number', 'revision', 'title', 'source', 'url', 'status', 'issued_on', 'notes', 'created_by'],
        fresh.map((f) => [companyId, `${codeBase}-${f.mark}`.replace(/[^A-Za-z0-9._/-]/g, '-').slice(0, 100), partNumber(f.mark), 'A',
          `${f.mark} ${f.item.description}`.slice(0, 255), 'shop', null, 'issued', today(),
          `Redrawn from ${s.registerNumber} ${s.revision ?? ''}${s.internal ? ' — internal use only' : ''}`.trim(), c.userId ?? null]));
      const [back] = await db.query("SELECT id, number FROM cf_drawings WHERE company_id = ? AND source = 'shop' AND deleted_at IS NULL AND revision = 'A' AND number_active IN (?)", [companyId, fresh.map((f) => partNumber(f.mark).toLowerCase())]);
      for (const x of back) drawingOf.set(String(x.number).toLowerCase(), Number(x.id));
      await db.query('UPDATE cf_drawings SET root_id = id WHERE company_id = ? AND id IN (?) AND root_id IS NULL', [companyId, back.map((x) => x.id)]);
    }
  }
  const links = [[companyId, drawingId, 'master_record', root, c.userId ?? null]];
  for (const r of tempRows) {
    const d = r.mark && r.item ? drawingOf.get(partNumber(r.mark).toLowerCase()) : null;
    if (d) links.push([companyId, d, 'master_record', rowIdOf(r.key), c.userId ?? null]);
  }
  await insertRows(db, 'cf_drawing_links', ['company_id', 'drawing_id', 'subject_type', 'subject_id', 'created_by'], links, 500);

  // ---- 6. the files ------------------------------------------------------------
  const cols = ['company_id', 'version_id', 'standard_id', 'kind', 'drawing_id', 'mark', 'mark_norm', 'file_name', 'file_kind', 'length_mm', 'width_mm', 'area_mm2',
    'cut_length_mm', 'piercings', 'holes', 'inner_cuts', 'geometry_json', 'warnings_json', 'file_text', 'created_by'];
  let batch = []; let bytes = 0;
  const flush = async () => { if (batch.length) await insertRows(db, 'cf_standard_drawing_files', cols, batch, batch.length); batch = []; bytes = 0; };
  for (const f of okFiles) {
    const g = f.geometry;
    const row = [companyId, versionId, standardId, 'part', drawingOf.get(partNumber(f.mark).toLowerCase()) ?? null, f.mark.slice(0, 120), normMark(f.mark).slice(0, 120),
      String(f.file).slice(0, 255), 'dxf', g?.lengthMm ?? null, g?.widthMm ?? null, g?.areaMm2 ?? null, g?.cutLengthMm ?? null, g?.piercings ?? null,
      g?.holes ?? null, g?.innerCuts ?? null, g ? JSON.stringify(g) : null, JSON.stringify(f.warnings ?? []), f.text, c.userId ?? null];
    if (bytes + f.text.length > FILE_BATCH_BYTES) await flush();
    batch.push(row); bytes += f.text.length;
  }
  await flush();
  return { plan, report: { ...report, written: { standardId, versionId, drawingId, rows: tempRows.length, files: okFiles.length, newDefinitions: [...made.values()].map((d) => ({ id: d.id, code: d.code, name: d.name })) } }, standardId };
}

/** The mapping report a person reads before --apply: every row → definition, the new ones, the notes, the files. */
function reportOf(plan, fileRows, existingId) {
  const rows = plan.rows.map((r) => ({
    depth: r.depth, mark: r.mark ?? null, what: r.item ? `${r.item.mark} ${r.item.description}` : r.node?.name ?? null,
    role: r.role, quantity: r.quantity, to: r.def?.new ? `NEW: ${r.def.new}` : r.def ? `${r.def.name}${r.def.code ? ` (${r.def.code})` : ''}` : '(left out)',
    chosen: r.kind === 'selection' ? (r.chosen?.name ?? 'to choose') : undefined, note: r.notes ?? null,
    weightKg: r.weightKg ?? null, values: r.values.map((v) => `${v.code}=${v.display ?? v.number ?? v.text ?? v.optionId}`).join(' '),
  }));
  return {
    standard: { number: plan.standard.number, name: plan.standard.name, sourceUrl: plan.standard.sourceUrl, internal: plan.standard.internal, alreadyThere: existingId },
    totals: plan.totals,
    rows,
    newDefinitions: plan.newDefinitions.map((d) => ({ name: d.name, kind: d.classHint, for: d.used })),
    fallbacks: plan.mappings.filter((m) => m.fallback).map((m) => ({ what: m.what, asked: m.asked[0], took: m.to.name ?? m.to.new })),
    bought: plan.bought,
    files: fileRows.map((f) => ({ mark: f.mark, file: f.file, read: !!f.geometry, sizeMm: f.geometry ? `${r3(f.geometry.lengthMm)} × ${r3(f.geometry.widthMm)}` : null, holes: f.geometry?.holes ?? null, missing: !!f.missing })),
    notes: rows.filter((r) => r.note).map((r) => ({ mark: r.mark, note: r.note })),
    problems: plan.problems,
  };
}
