/**
 * drawingLineService.js — ADD LINE › FROM A NEW DRAWING, and the New order dialog's order values (init.sql §77,
 * TM/s77.sql; contract: TM/CF_ERP_ORDER_FLOW_PLAN.md "2026-10-18 — Add line three choices + New-order defaults").
 *
 * User, 2026-10-18: "Add line" = three choices — build from parts (a template), from a standard drawing, or from a
 * NEW drawing: upload a DWG/DXF, our rules engine (TM/drawing_bom, copied into lib/drawingBom) builds the line and
 * ADDS IT DIRECTLY, no review screen. Rows the engine is unsure of carry the reason on their BOM line
 * ("Check (by AI): …" — the grid shows it as an amber chip). "Remove line" when the structure is way off. Scanned
 * PDFs: not yet (said politely).
 *
 * ONE MAPPING. The engine's parts become a bom.json (lib/drawingBom/toBom.js) and go through the standard importer's
 * planImport — the same names, roles, values and weights a standard drawing gets. What nothing in the catalog fits is
 * NOT made as a new definition (an upload must not grow the catalog): it takes the nearest generic definition and the
 * row says so. The tree is written by the one copy machine (treeCopyService.writeCopies) onto the new line, the part
 * DXFs go onto the line (cf_part_drawings, one INSERT a batch), then the line's own work (settleLineRows).
 *
 * ROUND TRIPS (production ~49 ms each): the engine runs in memory; the write is a fixed number of statements per tree
 * LEVEL (writeCopies) + catalog read (5) + addOrderLine + one INSERT for files + one for the import record + the
 * line's settle step — never a statement per row.
 */
import { invalid, notFound, conflict } from '../lib/errors.js';
import { insertRows } from '../lib/db.js';
import { readDxfDb } from '../lib/drawingBom/dxfDb.js';
import { readDwgDb, DwgReaderMissing } from '../lib/drawingBom/dwgDb.js';
import { extractFromDb } from '../lib/drawingBom/extract.js';
import { toBom } from '../lib/drawingBom/toBom.js';
import { planImport, normName } from '../lib/standardImport.js';
import { readPartDrawing } from './partGeometry.js';
import { normMark } from './partDrawingService.js';
import { writeCopies } from './treeCopyService.js';
import { importCatalog, settleLineRows, createStandard, saveLineToStandard } from './standardDrawingService.js';
import { LOCKED_ORDER_STATUSES } from './records.js';

/** The prefix of the reason a row carries when the engine was unsure of it. The grid shows it as a chip. */
export const AI_FLAG = 'Check (by AI):';
export const MAX_DRAWING_BYTES = 30 * 1024 * 1024;
const COPY_CHUNK = 1000;
const FILE_BATCH_BYTES = 2 * 1024 * 1024;
const blank = (v) => v == null || String(v).trim() === '';
const r3 = (n) => Math.round(Number(n) * 1000) / 1000;
const missingTable = (err) => err && (err.code === 'ER_NO_SUCH_TABLE' || err.errno === 1146);

/** Generic definitions a row takes when no catalog name fits it (first one the catalog has). */
const FALLBACK = {
  plate: ['Plate', 'Stiffener plate', 'Packing plate', 'Pad plate', 'Gusset plate', 'Cover plate', 'Web plate'],
  profile: ['Bracing', 'Angle cleat', 'X-frame top angle', 'Bottom lateral bracing member'],
  assembly: ['Loose items', 'Splice set', 'Girder segment', 'End diaphragm', 'Bracing'],
  structure: ['Girder line', 'Girder segment', 'Loose items'],
};

// ---------------------------------------------------------------------------
// The file and the engine
// ---------------------------------------------------------------------------

/** { name, content (base64, data URL allowed) } → { name, kind: 'dxf'|'dwg', buf }. Refuses a PDF in words. */
export function readUpload(file) {
  const name = String(file?.name ?? '').trim();
  if (!name || blank(file?.content)) throw invalid('NO_FILE', 'Choose the drawing file (DWG or DXF).');
  const buf = Buffer.from(String(file.content).replace(/^data:[^,]*,/, ''), 'base64');
  if (!buf.length) throw invalid('NO_FILE', 'The drawing file is empty.');
  if (buf.length > MAX_DRAWING_BYTES) throw invalid('TOO_BIG', `The drawing is ${Math.round(buf.length / 1048576)} MB — up to ${MAX_DRAWING_BYTES / 1048576} MB.`);
  const ext = (/\.([a-z0-9]+)$/i.exec(name)?.[1] ?? '').toLowerCase();
  const head = buf.subarray(0, 6).toString('latin1');
  if (ext === 'pdf' || head.startsWith('%PDF-')) {
    throw invalid('PDF_NOT_YET', 'Thanks — PDF drawings (scans) cannot be read by AI yet. Please upload the DWG or DXF of the drawing, or build the line from parts.');
  }
  if (ext === 'dwg' || /^AC10\d\d/.test(head)) return { name: name.slice(0, 255), kind: 'dwg', buf };
  if (ext === 'dxf') return { name: name.slice(0, 255), kind: 'dxf', buf };
  throw invalid('WRONG_FILE', 'The drawing must be a DWG or a DXF file.');
}

/** Runs the engine on the file (in memory). → { result, bom, flags, stats, ms }. */
export async function readDrawing(file) {
  const t0 = Date.now();
  let db;
  try {
    db = file.kind === 'dwg' ? await readDwgDb(file.buf) : readDxfDb(file.buf.toString('latin1'));
  } catch (err) {
    if (err instanceof DwgReaderMissing) throw invalid('DWG_READER', err.message);
    throw invalid('UNREADABLE', `${file.name} could not be read: ${err.message}`);
  }
  const result = extractFromDb(db, { readPartDrawing, name: file.name });
  if (!result.parts.length) {
    throw invalid('NO_PARTS', `AI found no part call-outs in ${file.name} (sizes like "PL 240X25X2150" or "ISA 100X100X10X2930"). Build the line from parts instead, or check that the drawing's text is not exploded into lines.`);
  }
  const { bom, flags, stats } = toBom(result, { sourceName: file.name });
  return { result, bom, flags, stats, ms: Date.now() - t0 };
}

// ---------------------------------------------------------------------------
// The plan onto the catalog
// ---------------------------------------------------------------------------

/**
 * planImport, then the parts of it an UPLOAD must not do: no new definitions (the nearest generic one, said on the
 * row), the impact class from the grade (E350-B0 → BO), the order-free grade note dropped (the import record keeps it).
 * Mutates and returns the plan; `flagsByKey` Map(row key → [reason]).
 */
export function planForLine(bom, flags, catalog, grade) {
  const plan = planImport(bom, catalog);
  const live = (catalog.defs ?? []).filter((d) => d.status === 'active' && d.definition_type === 'template');
  const byName = (names) => { for (const n of names) { const d = live.find((x) => normName(x.name) === normName(n)); if (d) return d; } return null; };
  const flagsByKey = new Map();
  const say = (key, reason) => { if (!flagsByKey.has(key)) flagsByKey.set(key, []); flagsByKey.get(key).push(reason); };
  const problems = [];
  for (const r of plan.rows) {
    if (r.item && flags.has(r.item.id)) for (const f of flags.get(r.item.id)) say(r.key, f);
    if (r.kind !== 'temp' || !r.def?.new) continue;
    const hint = r.def.classHint ?? (r.item ? (r.item.category === 'section' ? 'profile' : 'plate') : 'assembly');
    const fb = byName(FALLBACK[hint] ?? FALLBACK.assembly);
    if (!fb) { problems.push(`No catalog definition fits "${r.def.new}" (and none of ${(FALLBACK[hint] ?? []).join(', ')} exists).`); continue; }
    say(r.key, `no catalog name "${r.def.new}" — placed as ${fb.name}; change it if needed`);
    r.def = { id: Number(fb.id), code: fb.code, name: fb.name, classification_id: fb.classification_id, default_flow_id: fb.default_flow_id ?? null, bom_id: fb.bom_id ?? null };
  }
  // Positions again (1, 2 … per parent and definition): two names that fell back to one definition share it now.
  for (const r of plan.rows) {
    const seen = new Map();
    for (const k of r.children) { const dk = k.def?.id ?? k.def?.new ?? k.key; seen.set(dk, (seen.get(dk) ?? 0) + 1); k.position = seen.get(dk); }
  }
  if (plan.rows[0] && !plan.rows[0].def?.id) problems.push('The catalog has no span definition (SPAN-001, "Bridge span" or any "… span") to hang the line on.');
  // E350-B0 / -BR: the impact class goes with the grade when the catalog has that option.
  const impact = /B[O0]\s*$/i.test(String(grade ?? '')) ? 'BO' : /BR\s*$/i.test(String(grade ?? '')) ? 'BR' : null;
  const impactId = impact ? catalog.impactOption?.get(impact) ?? null : null;
  const impactSpec = catalog.specs.get('IMPACT_CLASS');
  for (const r of plan.rows) {
    if (r.kind !== 'temp' || !r.item) continue;
    if (impactId && impactSpec && !r.values.some((v) => v.code === 'IMPACT_CLASS')) r.values.push({ code: 'IMPACT_CLASS', optionId: impactId, display: impact });
    if (r.notes) r.notes = r.notes.split(' · ').filter((x) => !/^Original grade on drawing:/.test(x)).join(' · ') || null;
  }
  for (const r of plan.rows) {
    const f = flagsByKey.get(r.key);
    if (!f?.length || r.kind !== 'temp' || !r.parentKey) continue;
    r.notes = [r.notes, `${AI_FLAG} ${[...new Set(f)].join('; ')}`].filter(Boolean).join(' · ').slice(0, 2000);
  }
  return { plan, flagsByKey, problems };
}

/** The plan's tree as a synthetic snapshot for writeCopies (the importer's shape). → { snap, srcOf, rootSrc }. */
function snapshotOf(plan, catalog) {
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
      const optionId = v.optionId ?? null;
      if (!spec || (v.optionValue != null && optionId == null)) return null;
      return {
        specification_id: spec.id, subject_id: id, value_number: v.number ?? null, value_text: v.text ?? null, value_bool: null, value_date: null,
        option_id: optionId, value_json: null, uom: v.uom ?? null, source: v.source ?? 'entered',
      };
    }).filter(Boolean));
    const kids = r.children.filter((k) => k.kind === 'temp' || k.def?.id);
    if (kids.length) {
      snap.linesByBom.set(bomOf.get(r.key), kids.map((k) => {
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
  return { snap, srcOf, rootSrc: srcOf.get(plan.rows[0].key) };
}

// ---------------------------------------------------------------------------
// POST /orders/:id/lines/from-drawing
// ---------------------------------------------------------------------------

/**
 * { file: { name, content }, quantity?, committedDate?, description?, rate?, rateBasis? } — the line is built and
 * added at once. Needs a transaction. → the order (getOrder) + `fromDrawing` { lineId, file, rows, parts, flagged,
 * weightKg, ms, cutPieces, sentence, flags: [{ rowId, mark, what, reasons }] }.
 */
export async function addLineFromDrawing(db, c, orderId, input = {}) {
  const { companyId } = c;
  const file = readUpload(input.file);
  const read = await readDrawing(file);
  const catalog = await importCatalog(db, companyId);
  const { plan, flagsByKey, problems } = planForLine(read.bom, read.flags, catalog, read.result.grade);
  if (problems.length) throw invalid('NO_FIT', `AI read ${read.stats.parts} parts but could not place them — nothing was added.`, { problems });
  const root = plan.rows[0];
  const { addOrderLine, getOrder } = await import('./salesOrderService.js');
  let made = null;
  await addOrderLine(db, c, orderId, {
    recordId: root.def.id, quantity: blank(input.quantity) ? 1 : input.quantity, committedDate: input.committedDate,
    description: blank(input.description) ? read.stats.title.slice(0, 500) : input.description,
    lineNo: input.lineNo, notes: input.notes, rate: input.rate, rateBasis: input.rateBasis,
  }, {
    build: async (lineId) => {
      const { snap, srcOf, rootSrc } = snapshotOf(plan, catalog);
      const { idMap } = await writeCopies(db, c, snap, [{ srcId: rootSrc, ownerLineId: lineId }], { chunk: COPY_CHUNK });
      const newRoot = idMap.get(rootSrc);
      if (!newRoot) throw new Error('cf_erp: the rows read from the drawing could not be written.');
      await db.query('UPDATE cf_sales_order_lines SET item_id = ? WHERE company_id = ? AND id = ?', [newRoot, companyId, lineId]);
      // The part files the engine drew, onto the line (one INSERT a 2 MB batch).
      const files = [];
      for (const pf of plan.files) {
        const text = read.result.files[pf.file];
        if (!text) continue;
        const g = readPartDrawing(text);
        if (!g.geometry) continue;
        files.push({ mark: pf.mark, name: pf.file, text, g: g.geometry, warnings: g.warnings ?? [] });
      }
      const cols = ['company_id', 'order_line_id', 'drawing_id', 'mark', 'mark_norm', 'file_name', 'file_kind', 'length_mm', 'width_mm', 'area_mm2',
        'cut_length_mm', 'piercings', 'holes', 'inner_cuts', 'geometry_json', 'warnings_json', 'dxf_text', 'created_by'];
      let batch = []; let bytes = 0;
      const flush = async () => { if (batch.length) await insertRows(db, 'cf_part_drawings', cols, batch, batch.length); batch = []; bytes = 0; };
      for (const f of files) {
        if (bytes + f.text.length > FILE_BATCH_BYTES) await flush();
        batch.push([companyId, lineId, null, String(f.mark).slice(0, 120), normMark(f.mark).slice(0, 120), String(f.name).slice(0, 255), 'dxf',
          f.g.lengthMm ?? null, f.g.widthMm ?? null, f.g.areaMm2 ?? null, f.g.cutLengthMm ?? null, f.g.piercings ?? null, f.g.holes ?? null, f.g.innerCuts ?? null,
          JSON.stringify(f.g), JSON.stringify(f.warnings), f.text, c.userId ?? null]);
        bytes += f.text.length;
      }
      await flush();
      const ids = [...idMap.values()];
      const names = new Map([...idMap].map(([src, fresh]) => [fresh, snap.items.get(src)?.name ?? null]));
      const settled = await settleLineRows(db, c, lineId, newRoot, ids, names);
      const flagList = [];
      for (const r of plan.rows) {
        const f = flagsByKey.get(r.key);
        if (!f?.length || r.kind !== 'temp' || !r.parentKey) continue;
        flagList.push({ rowId: idMap.get(srcOf.get(r.key)) ?? null, mark: r.mark ?? null, what: r.item ? `${r.item.description} ${r.item.thicknessMm ?? ''}×${r.item.widthMm ?? ''}×${r.item.lengthMm ?? ''}`.trim() : r.def.name, reasons: [...new Set(f)] });
      }
      made = { lineId, rows: ids.length, files: files.length, cutPieces: settled.cutPieces, flags: flagList };
      // The import record (§77): what was read, by AI, from which file. A database without §77 skips it.
      const report = {
        engine: 'drawing_bom (deterministic rules, no LLM)', file: file.name, kind: file.kind, bytes: file.buf.length, ms: read.ms,
        sheets: read.result.sheets, grade: read.result.grade, girders: read.result.girders, framed: read.result.framed,
        parts: read.result.parts.map((p) => ({ mark: p.mark, caption: p.caption, qty: p.qty, confidence: p.confidence, geometry: p.geometryConfidence, assembly: p.assembly, reasons: p.reasons })),
        mappings: plan.mappings.map((m) => ({ what: m.what, to: m.to.name ?? m.to.new })), flags: flagList,
      };
      try {
        await insertRows(db, 'cf_line_drawing_imports',
          ['company_id', 'order_id', 'order_line_id', 'file_name', 'file_kind', 'file_bytes', 'parts', 'rows_count', 'flagged', 'weight_kg', 'report_json', 'created_by'],
          [[companyId, Number(orderId), lineId, file.name, file.kind, file.buf.length, read.stats.parts, ids.length, flagList.length, plan.totals.steelKg ?? null, JSON.stringify(report), c.userId ?? null]]);
      } catch (err) { if (!missingTable(err)) throw err; }
    },
  });
  const fresh = await getOrder(db, companyId, orderId);
  const fd = made ? {
    lineId: made.lineId, file: file.name, parts: read.stats.parts, rows: made.rows, files: made.files, flagged: made.flags.length,
    weightKg: plan.totals.steelKg == null ? null : r3(plan.totals.steelKg), ms: read.ms, cutPieces: made.cutPieces, flags: made.flags,
    sentence: `Line added by AI from ${file.name}: ${read.stats.parts} parts in ${made.rows} rows${made.flags.length ? `, ${made.flags.length} to check (amber "AI" chips)` : ''}.`,
  } : null;
  return { ...fresh, fromDrawing: fd };
}

// ---------------------------------------------------------------------------
// The AI flags of a line: read, and mark checked
// ---------------------------------------------------------------------------

/** BOM lines of an order line's own rows that still carry an AI flag. One query. */
async function flaggedLines(db, companyId, lineId, rowIds = null) {
  const [rows] = await db.query(
    `SELECT bl.id, bl.child_id, bl.notes FROM cf_bom_lines bl
       JOIN cf_boms b ON b.id = bl.bom_id AND b.deleted_at IS NULL
       JOIN cf_item_details i ON i.master_id = b.parent_id AND i.deleted_at IS NULL AND i.owner_order_line_id = ?
      WHERE bl.company_id = ? AND bl.deleted_at IS NULL AND bl.notes LIKE ?${rowIds ? ' AND bl.child_id IN (?)' : ''}`,
    [lineId, companyId, `%${AI_FLAG}%`, ...(rowIds ? [rowIds] : [])],
  );
  return rows;
}

/** The note without its AI part (null when nothing else is left). */
export function withoutAiFlag(notes) {
  const kept = String(notes ?? '').split(' · ').filter((x) => !x.startsWith(AI_FLAG)).join(' · ').trim();
  return kept || null;
}

async function requireLine(db, companyId, lineId) {
  const [[l]] = await db.query(
    `SELECT l.id, l.line_no, l.order_id, l.item_id, l.locked_at, l.standard_id, o.status AS order_status, o.code AS order_code
       FROM cf_sales_order_lines l JOIN cf_sales_orders o ON o.id = l.order_id AND o.deleted_at IS NULL
      WHERE l.company_id = ? AND l.id = ? AND l.deleted_at IS NULL`, [companyId, Number(lineId)]);
  if (!l) throw notFound('Order line');
  return l;
}

/** GET /order-lines/:id/drawing-import → { import: { file, kind, parts, rows, flagged, weightKg, at } | null, open: [{ rowId, notes }] }. 2 queries. */
export async function lineDrawingImport(db, companyId, lineId) {
  const l = await requireLine(db, companyId, lineId);
  let imp = null;
  try {
    const [[r]] = await db.query('SELECT file_name, file_kind, parts, rows_count, flagged, weight_kg, created_at FROM cf_line_drawing_imports WHERE company_id = ? AND order_line_id = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 1', [companyId, l.id]);
    if (r) imp = { file: r.file_name, kind: r.file_kind, parts: Number(r.parts), rows: Number(r.rows_count), flagged: Number(r.flagged), weightKg: r.weight_kg == null ? null : Number(r.weight_kg), at: r.created_at };
  } catch (err) { if (!missingTable(err)) throw err; }
  const open = imp ? (await flaggedLines(db, companyId, l.id)).map((x) => ({ rowId: Number(x.child_id), notes: x.notes })) : [];
  return { lineId: Number(l.id), import: imp, open };
}

/** POST /order-lines/:id/ai-flags/clear { rowIds? } — the AI part of those rows' notes goes (all rows when none given). Set-based: 2 statements. */
export async function clearAiFlags(db, c, lineId, input = {}) {
  const l = await requireLine(db, c.companyId, lineId);
  if (LOCKED_ORDER_STATUSES.has(l.order_status)) throw conflict('ORDER_CLOSED', `${l.order_code} is ${l.order_status}.`);
  const rowIds = Array.isArray(input.rowIds) && input.rowIds.length ? input.rowIds.map(Number).filter((x) => Number.isInteger(x) && x > 0) : null;
  const rows = await flaggedLines(db, c.companyId, l.id, rowIds);
  if (rows.length) {
    const params = [];
    const cases = rows.map((r) => { params.push(r.id, withoutAiFlag(r.notes)); return 'WHEN ? THEN ?'; }).join(' ');
    await db.query(`UPDATE cf_bom_lines SET notes = CASE id ${cases} END WHERE company_id = ? AND id IN (?)`, [...params, c.companyId, rows.map((r) => r.id)]);
  }
  return { cleared: rows.length, ...(await lineDrawingImport(db, c.companyId, l.id)) };
}

// ---------------------------------------------------------------------------
// "Save as a standard drawing" — the standard and its first version, in one request
// ---------------------------------------------------------------------------

/**
 * POST /order-lines/:id/standard/from-line { number, name?, revision?, description?, notes?, note? } — a new standard
 * tied to the line (standardDrawingService.createStandard) and the line's BOM as its version 1 (saveLineToStandard),
 * one transaction. The standard is the line as it is (AI notes included); `openFlags` says how many rows still carried
 * one, so the screen can ask to check them first.
 */
export async function saveLineAsStandard(db, c, lineId, input = {}) {
  const l = await requireLine(db, c.companyId, lineId);
  if (l.standard_id) throw invalid('HAS_STANDARD', `Line ${l.line_no} is already tied to a standard drawing — use "Update the standard" from its standard drawing.`);
  const open = (await flaggedLines(db, c.companyId, l.id)).length;
  await createStandard(db, c, { number: input.number, name: input.name, revision: input.revision, description: input.description, notes: input.notes }, { lineId: l.id });
  const out = await saveLineToStandard(db, c, l.id, { note: input.note ?? null });
  return { ...out, openFlags: open };
}

// ---------------------------------------------------------------------------
// The New order dialog's order values (Feature A)
// ---------------------------------------------------------------------------

/**
 * GET /order-defaults/new → { available, specs (the Structure panel's: flagged "Can be set for a whole order", with
 * options), values: { CODE: { input, display, from: 'last_order' | 'template' } }, lastOrder: { id, code } | null }.
 * Prefill: the company's LAST order that has order values; a spec it does not hold takes the value most of the
 * company's active template definitions hold. 4 queries.
 */
export async function newOrderDefaults(db, companyId) {
  const { flaggedSpecs, shownValue } = await import('./orderDefaultService.js');
  const specs = await flaggedSpecs(db, companyId);
  if (specs === null) return { available: false, specs: [], values: {}, lastOrder: null };
  const view = specs.map(({ allOptions, ...s }) => ({
    ...s, ...(s.dataType === 'option' ? { options: allOptions.filter((x) => x.status === 'active').map((x) => ({ id: x.id, value: x.value, label: x.label })) } : {}),
  }));
  if (!specs.length) return { available: true, specs: view, values: {}, lastOrder: null };
  const ids = specs.map((s) => s.id);
  const byId = new Map(specs.map((s) => [Number(s.id), s]));
  const values = {};
  const [last] = await db.query(
    `SELECT d.*, o.code AS order_code FROM cf_order_spec_defaults d JOIN cf_sales_orders o ON o.id = d.order_id
      WHERE d.company_id = ? AND d.deleted_at IS NULL AND d.order_line_id IS NULL AND d.specification_id IN (?)
        AND d.order_id = (SELECT MAX(x.order_id) FROM cf_order_spec_defaults x JOIN cf_sales_orders xo ON xo.id = x.order_id AND xo.deleted_at IS NULL
                           WHERE x.company_id = ? AND x.deleted_at IS NULL AND x.order_line_id IS NULL)`,
    [companyId, ids, companyId],
  );
  let lastOrder = null;
  for (const r of last) {
    const s = byId.get(Number(r.specification_id));
    const v = s ? shownValue(r, s) : null;
    if (v && (s.dataType !== 'option' || s.allOptions.some((o) => o.id === r.option_id && o.status === 'active'))) values[s.code] = { ...v, from: 'last_order' };
    lastOrder = { id: Number(r.order_id), code: r.order_code };
  }
  const missing = specs.filter((s) => !values[s.code]).map((s) => s.id);
  if (missing.length) {
    const [common] = await db.query(
      `SELECT v.specification_id, v.option_id, v.value_number, v.value_text, v.value_bool, v.value_date, COUNT(*) AS n
         FROM cf_spec_values v
         JOIN cf_master_records m ON m.id = v.subject_id AND m.record_kind = 'definition' AND m.status = 'active' AND m.deleted_at IS NULL
         JOIN cf_definition_details dd ON dd.master_id = m.id AND dd.definition_type = 'template' AND dd.deleted_at IS NULL
        WHERE v.company_id = ? AND v.subject_type = 'master' AND v.deleted_at IS NULL AND v.specification_id IN (?)
        GROUP BY v.specification_id, v.option_id, v.value_number, v.value_text, v.value_bool, v.value_date
        ORDER BY n DESC`,
      [companyId, missing],
    );
    for (const r of common) {
      const s = byId.get(Number(r.specification_id));
      if (!s || values[s.code]) continue;
      if (s.dataType === 'option' && !s.allOptions.some((o) => o.id === r.option_id && o.status === 'active')) continue;
      const v = shownValue(r, s);
      if (v) values[s.code] = { ...v, from: 'template' };
    }
  }
  return { available: true, specs: view, values, lastOrder };
}

/** createOrder's step: the order values given with the new order, written in its transaction (no lines yet). */
export async function applyNewOrderDefaults(db, c, orderId, writes) {
  const list = (Array.isArray(writes) ? writes : []).filter((w) => w && !blank(w.specCode) && !blank(w.value));
  if (!list.length) return null;
  const { writeOrderDefaults } = await import('./orderDefaultService.js');
  const out = await writeOrderDefaults(db, c, orderId, { writes: list.map((w) => ({ specCode: w.specCode, value: w.value })) });
  return { changed: out.summary.changed, sentence: out.summary.sentence };
}
