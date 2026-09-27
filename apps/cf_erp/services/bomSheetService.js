/**
 * bomSheetService.js — a sales order line's structure as a spreadsheet, out and
 * back in again.
 *
 * WHY THIS EXISTS
 * A bridge BOQ arrives as a spreadsheet and an engineer works in one. Asking
 * them to retype four hundred parts into a web form to change twelve quantities
 * is how a system stops being used. fab_erp learned the same thing and settled
 * on ONE sheet whose code columns ARE the structure; this is the same idea with
 * the identity problem solved properly.
 *
 * WHAT IDENTIFIES A ROW
 * Not its position. A person will sort, insert and delete, and a sheet matched
 * by row number corrupts everything below the first insert. Every row carries
 *   Row ID         the cf_bom_lines id it came from ('ROOT' for the top item)
 *   Parent Row ID  the Row ID of the row it hangs under
 * Both are written by the export and neither may be typed. From those two
 * columns the whole tree is rebuilt whatever order the rows arrive in:
 *   a Row ID that comes back            -> the same line, compared field by field
 *   a row with no Row ID                -> a new line under its Parent Row ID
 *   a row with Delete? = yes            -> that line goes, and everything under it
 *   a Row ID that never appears at all  -> NOT MENTIONED, and so left alone
 *
 * A ROW LEFT OUT OF THE SHEET IS NOT A DELETION.
 * Deleting the row was the first design, and it is the natural spreadsheet
 * gesture, but the failure mode is not symmetric. Filtering is the commonest
 * thing anyone does to a spreadsheet, and "filter to the 25 mm plates, fix
 * them, save, import" is an ordinary afternoon — under that rule it would wipe
 * every row the filter hid. Requiring the ROOT row catches a truncated file but
 * not a filter on thickness or role, which leaves the root visible. So deletion
 * is an explicit `Delete?` column, and the cost of the change is one column
 * against a destroyed BOM that no re-import can rebuild, because the rows that
 * went are exactly the ones no longer in the sheet.
 *
 * A line whose BOM hangs under several parents (three parts cut from one blank)
 * appears once per parent. It is ONE row in the database, so its copies must
 * agree; a sheet that gives them two different quantities is refused rather
 * than guessed at, and marking some copies for deletion but not all is refused
 * too — deleting the line takes it out of every parent at once.
 *
 * WHAT MAY BE CHANGED
 * This sheet edits THIS ORDER'S OWN structure and nothing else:
 *   - Quantity, Role and Notes of a line whose parent is a temporary item;
 *   - specification values on a temporary item, where the value is one a person
 *     is allowed to type (entered / defaulted);
 *   - rows added under a temporary item, and rows removed from one.
 * Everything else is exported for context and locked. In particular:
 *   - a `calculated`, `rollup`, `inherited` or `fixed` value is worked out, not
 *     typed — the engine owns it and the sheet may not write it (the same rule
 *     valueService.setValues enforces, checked here so a dry run can say so);
 *   - Code, Name, Kind, Total Qty, UoM, Flow, Level and Path are derived or
 *     generated — a code in particular belongs to the code generator;
 *   - a line inside a CATALOG item's Standard BOM is shared by every order that
 *     uses that item, so changing it here would change other people's work;
 *   - what a line HOLDS cannot change (bomService's rule) — a different Code on
 *     an existing row is remove-and-add, said in those words.
 *
 * ALL OR NOTHING, AND IT SAYS SO FIRST
 * Reading the sheet writes nothing. The whole plan is built and every problem
 * collected before a single row is touched, then assertNoProblems refuses the
 * sheet as a whole (the house pattern). `dryRun` returns that same plan without
 * applying it — "12 quantities changed, 3 rows added, 1 removed" is the useful
 * half of this feature. Applying runs inside the caller's transaction, so a
 * refusal anywhere still leaves the order exactly as it was.
 *
 * A frozen line refuses both directions: bomService.assertEditable is the one
 * rule for "this structure can still change", and it is asked before anything
 * else happens.
 */
import ExcelJS from 'exceljs';
import { invalid, notFound, assertNoProblems } from '../lib/errors.js';
import { requireMaster, kindOf } from './records.js';
import {
  explode, addLine, writeLineUpdate, writeLineRemoval, assertEditable, ALLOWED_CHILDREN,
} from './bomService.js';
import { bomTypeOf, descendantIds } from './bomGraph.js';
import { loadSpecs, coerce, setValues, refreshValues } from './valueService.js';
import { resolve, dateText, tableSummary, parseJsonCol } from './resolutionService.js';
import { linePlaceholders } from './placeholderService.js';

/** How a structure node finds its placeholder: by its BOM line, or by item for what the line sells. */
const placeholderKey = (lineId, itemId) => (lineId != null ? `l${lineId}` : `i${itemId}`);

export const SHEET_NAME = 'BOM';
export const NOTES_SHEET = 'How to use this';
export const ROOT_ROW_ID = 'ROOT';
const MAX_ROWS = 20000;
const ID_CHUNK = 500;

/** Values a person may type. The rest are worked out and the sheet may not write them. */
const TYPEABLE_SOURCES = new Set(['entered', 'defaulted']);
const TYPEABLE_RULES = new Set(['entered', 'defaulted']);

/* ---------------------------------------------------------------------------
 * Columns.
 *
 * `locked` columns are written by the export and refused on import. They are
 * shaded in the workbook and their header says so in words, because a CSV
 * carries no shading and the header is the only warning that survives.
 * ------------------------------------------------------------------------ */
const LOCK = ' [do not edit]';
export const FIXED_COLUMNS = [
  { key: 'name', header: 'Name', width: 36, locked: true },
  { key: 'quantity', header: 'Quantity', width: 12, locked: false },
  { key: 'role', header: 'Role', width: 22, locked: false },
  { key: 'notes', header: 'Notes', width: 32, locked: false },
  // The only way to remove anything. Left blank by the export, always.
  { key: 'del', header: 'Delete?', width: 9, locked: false },
  { key: 'code', header: 'Code', width: 22, locked: true },
  { key: 'rowId', header: 'Row ID', width: 12, locked: true },
  { key: 'parentRowId', header: 'Parent Row ID', width: 16, locked: true },
  { key: 'uom', header: 'UoM', width: 7, locked: true },
  { key: 'flow', header: 'Flow', width: 16, locked: true },
  { key: 'locked', header: 'Locked', width: 22, locked: true },
  { key: 'level', header: 'Level', width: 7, locked: true, hidden: true },
  { key: 'path', header: 'Path', width: 42, locked: true, hidden: true },
  { key: 'kind', header: 'Kind', width: 11, locked: true, hidden: true },
  { key: 'totalQty', header: 'Total Qty', width: 11, locked: true, hidden: true },
  { key: 'shared', header: 'Shared', width: 9, locked: true, hidden: true },
];

/**
 * A header down to the name a column is matched by: everything before the first
 * bracket or parenthesis, upper-cased. `Quantity` -> QUANTITY,
 * `THICKNESS (mm) [worked out - do not edit]` -> THICKNESS. One rule for the
 * fixed columns and the specification ones, so a header may carry its unit and
 * its warning without the import losing track of it.
 */
export const normaliseHeader = (h) => String(h ?? '').split(/[([]/)[0].trim().toUpperCase();

const FIXED_BY_HEADER = new Map(FIXED_COLUMNS.map((c) => [normaliseHeader(c.header), c]));

/**
 * What counts as "yes" in the Delete? column. A person types whichever of these
 * comes to hand; anything else is refused rather than read as a no, because
 * guessing at the one column that destroys work is how work gets destroyed.
 */
const DELETE_YES = new Set(['yes', 'y', 'true', '1', 'x', 'delete', 'remove']);
const DELETE_NO = new Set(['no', 'n', 'false', '0', '-']);

/* --- small helpers -------------------------------------------------------- */
const blank = (v) => v == null || String(v).trim() === '';
const text = (v) => (blank(v) ? null : String(v).trim());
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 1e-6;
const labelOf = (n) => n.code ?? n.name ?? `#${n.id}`;
const chunk = (xs, n) => { const out = []; for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n)); return out; };

/** One cell of an ExcelJS sheet as plain text: formulas, rich text and dates all flattened. */
function cellText(v) {
  if (v == null) return null;
  if (v instanceof Date) return dateText(v);
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map((r) => r.text).join('').trim() || null;
    if ('result' in v) return cellText(v.result);
    if ('text' in v) return cellText(v.text);
    if ('hyperlink' in v) return cellText(v.text ?? v.hyperlink);
    if ('error' in v) return null;
    return null;
  }
  const s = String(v).trim();
  return s === '' ? null : s;
}

/* --- CSV, by hand --------------------------------------------------------- */
// exceljs reads and writes CSV through a date-guessing stream with its own
// options; this file needs neither, and thirty lines of RFC 4180 are easier to
// be sure about than the options that would otherwise have to be right.
const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCsv = (rows) => `﻿${rows.map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;

function parseCsv(str) {
  const s = str.replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === ',') { row.push(cell); cell = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; continue; }
    cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/* ===========================================================================
 * Reading the order line and its structure — shared by export and import.
 * ======================================================================== */

async function requireOrderLine(db, companyId, lineId) {
  const [[row]] = await db.query(
    `SELECT ol.id, ol.line_no, ol.quantity, ol.item_id, ol.description,
            o.id AS order_id, o.code AS order_code, o.status AS order_status
       FROM cf_sales_order_lines ol
       JOIN cf_sales_orders o ON o.id = ol.order_id AND o.deleted_at IS NULL
      WHERE ol.company_id = ? AND ol.id = ? AND ol.deleted_at IS NULL`,
    [companyId, lineId],
  );
  if (!row) throw notFound('Order line');
  return row;
}

/** Every stored specification value on these records, keyed `subjectId:SPECCODE`. */
async function valuesOfNodes(db, companyId, ids) {
  const byNode = new Map();
  const specs = new Map();
  if (!ids.length) return { byNode, specs };
  for (const part of chunk([...new Set(ids)], ID_CHUNK)) {
    const [rows] = await db.query(
      `SELECT v.subject_id, v.specification_id, v.source, v.uom,
              v.value_number, v.value_text, v.value_bool, v.value_date, v.option_id, v.value_json,
              s.code, s.name, s.data_type, s.default_uom, s.table_config, o.value AS option_value
         FROM cf_spec_values v
         JOIN cf_specifications s ON s.id = v.specification_id AND s.deleted_at IS NULL
         LEFT JOIN cf_spec_options o ON o.id = v.option_id
        WHERE v.company_id = ? AND v.subject_type = 'master' AND v.subject_id IN (?) AND v.deleted_at IS NULL`,
      [companyId, part],
    );
    for (const r of rows) {
      const code = String(r.code).toUpperCase();
      if (!specs.has(code)) {
        specs.set(code, { id: r.specification_id, code, name: r.name, dataType: r.data_type, uom: r.default_uom, sources: new Set() });
      }
      specs.get(code).sources.add(r.source);
      let display = null;
      switch (r.data_type) {
        case 'number': display = r.value_number == null ? null : Number(r.value_number); break;
        case 'boolean': display = r.value_bool == null ? null : (Number(r.value_bool) ? 'yes' : 'no'); break;
        case 'date': display = dateText(r.value_date); break;
        case 'option': display = r.option_value ?? null; break;
        // A chart is never edited from this sheet — a summary is all it shows here.
        case 'table': display = tableSummary(parseJsonCol(r.table_config), parseJsonCol(r.value_json)); break;
        default: display = r.value_text ?? null;
      }
      if (!byNode.has(r.subject_id)) byNode.set(r.subject_id, new Map());
      byNode.get(r.subject_id).set(code, { display, source: r.source, uom: r.uom ?? r.default_uom ?? null });
    }
  }
  return { byNode, specs };
}

/**
 * Columns for specifications that hold NO value yet.
 *
 * A sheet built only from stored values cannot be used to fill anything in, and
 * a BOQ that has just arrived is empty everywhere — which would leave the one
 * job the sheet exists for undone. Rules hang off the classification, so ONE
 * resolve() per distinct classification covers every item filed under it: a
 * handful of calls for a tree of any size, rather than one per node. An item
 * carrying a rule of its own is resolved as well, because a representative
 * cannot speak for it.
 *
 * This only decides which COLUMNS exist. Whether a particular cell may be
 * written is settled per node against that node's own rules when the sheet
 * comes back, so an approximation here can never let a value through.
 */
const MAX_REPRESENTATIVES = 60;
async function addEmptyColumns(db, companyId, rows, specs) {
  const editable = [...new Set(rows.filter((r) => r.valuesEditable).map((r) => r.node.id))];
  if (!editable.length) return;
  const byClass = new Map();
  const ownRules = new Set();
  for (const part of chunk(editable, ID_CHUNK)) {
    const [ms] = await db.query('SELECT id, classification_id FROM cf_master_records WHERE company_id = ? AND id IN (?) AND deleted_at IS NULL', [companyId, part]);
    for (const m of ms) if (m.classification_id != null && !byClass.has(m.classification_id)) byClass.set(m.classification_id, m.id);
    const [own] = await db.query(
      "SELECT DISTINCT subject_id FROM cf_spec_assignments WHERE company_id = ? AND subject_type = 'master' AND subject_id IN (?) AND deleted_at IS NULL",
      [companyId, part],
    );
    for (const a of own) ownRules.add(a.subject_id);
  }
  const reps = [...new Set([...byClass.values(), ...ownRules])];
  if (!reps.length || reps.length > MAX_REPRESENTATIVES) return;
  for (const id of reps) {
    const master = await requireMaster(db, companyId, id);
    const r = await resolve(db, companyId, { master });
    for (const s of r.specs) {
      if (s.captureAt !== 'item' || !s.applicable) continue;
      const code = String(s.spec.code).toUpperCase();
      if (!specs.has(code)) {
        specs.set(code, { id: s.spec.id, code, name: s.spec.name, dataType: s.spec.dataType, uom: s.spec.unit ?? null, sources: new Set(), rules: new Set() });
      }
      const col = specs.get(code);
      if (!col.rules) col.rules = new Set();
      col.rules.add(s.rule.valueRule);
    }
  }
}

/**
 * The live picture the sheet is built from and compared against.
 *
 * `rows` is the explosion flattened depth first, one entry per PLACE a line
 * occupies (a shared BOM appears under each of its parents). `byRowId` groups
 * them, because the database holds one line however many places it fills.
 */
function normaliseScope(scope) {
  if (typeof scope === 'object' && scope !== null) {
    if (scope.kind === 'record') return { kind: 'record', recordId: Number(scope.recordId) };
    if (scope.kind === 'orderLine') return { kind: 'orderLine', orderLineId: Number(scope.lineId ?? scope.orderLineId) };
  }
  return { kind: 'orderLine', orderLineId: Number(scope) };
}

async function buildModel(db, companyId, scopeInput) {
  const scope = normaliseScope(scopeInput);
  let line = null;
  let root;
  let rootQuantity = 1;
  if (scope.kind === 'record') {
    root = await requireMaster(db, companyId, scope.recordId);
  } else {
    line = await requireOrderLine(db, companyId, scope.orderLineId);
    if (!line.item_id) throw invalid('NO_ITEM', 'This line has no item yet — there is no structure to put in a sheet.');
    root = await requireMaster(db, companyId, line.item_id);
    rootQuantity = Number(line.quantity);
  }
  const tree = await explode(db, companyId, root.id, { rootQuantity });

  const rows = [];
  const walk = (node, parentRowId, parentNode, parentKey) => {
    const rowId = node.lineId == null ? ROOT_ROW_ID : String(node.lineId);
    // A line may only change when it sits in THIS order's own structure: its
    // parent is a temporary item, whose Custom BOM belongs to this line alone.
    // Anything under a catalog item is that item's Standard BOM, shared by
    // every order that uses it.
    const parentKind = parentNode ? parentNode.kind : null;
    const lineEditable = node.lineId != null && (scope.kind === 'record'
      ? parentNode?.id === root.id
      : parentKind === 'temporary');
    const lockedWhy = node.lineId == null ? (scope.kind === 'record' ? 'the top of this structure' : 'the top of the order line')
      : lineEditable ? null
        : `inside ${labelOf(parentNode)}'s own BOM — open that record to change it`;
    rows.push({
      key: node.key,
      rowId,
      parentRowId: parentRowId || null,
      // A shared line has one Row ID but a different parent in each place it
      // fills, so a deletion cascade has to follow the PLACE, not the Row ID.
      parentKey: parentKey ?? null,
      depth: node.depth,
      node,
      parentNode,
      lineEditable,
      valuesEditable: scope.kind === 'orderLine' && node.kind === 'temporary',
      lockedWhy,
    });
    for (const kid of node.children) walk(kid, rowId, node, node.key);
  };
  walk(tree.root, null, null, null);

  const byRowId = new Map();
  for (const r of rows) {
    if (!byRowId.has(r.rowId)) byRowId.set(r.rowId, []);
    byRowId.get(r.rowId).push(r);
  }
  // explode() carries no line notes, and notes are one of the three things a
  // person edits offline — one query rather than a column on the explosion.
  const notes = new Map();
  const lineIds = rows.map((r) => r.node.lineId).filter((x) => x != null);
  for (const part of chunk([...new Set(lineIds)], ID_CHUNK)) {
    const [ns] = await db.query('SELECT id, notes FROM cf_bom_lines WHERE company_id = ? AND id IN (?) AND deleted_at IS NULL', [companyId, part]);
    for (const n of ns) notes.set(String(n.id), n.notes ?? null);
  }
  for (const r of rows) r.notes = notes.get(r.rowId) ?? null;

  const { byNode, specs } = await valuesOfNodes(db, companyId, rows.map((r) => r.node.id));
  await addEmptyColumns(db, companyId, rows, specs);

  // A specification whose code collides with one of this sheet's own columns
  // cannot be told apart from it on the way back in, so it is left out and said
  // so rather than silently overwriting a built-in column.
  const dropped = [];
  for (const code of [...specs.keys()]) {
    if (FIXED_BY_HEADER.has(normaliseHeader(code))) { dropped.push(code); specs.delete(code); }
  }
  const specCols = [...specs.values()].sort((a, b) => a.code.localeCompare(b.code));

  return { scope, line, root, tree, rows, byRowId, values: byNode, specCols, droppedSpecs: dropped,
    bomType: tree.root.bom?.bomType ?? bomTypeOf(root) };
}

/* ===========================================================================
 * Export
 * ======================================================================== */

const indent = (depth, label) => (depth === 0 ? label : `${'  '.repeat(depth - 1)}> ${label}`);

/**
 * The header a specification column carries, warning IN WORDS when the value is
 * worked out. The workbook shades those cells as well, but a CSV carries no
 * shading and this is then the only warning that survives the round trip.
 */
function specHeader(spec) {
  const unit = spec.uom ? ` (${spec.uom})` : '';
  // A chart is never edited from this sheet, whatever rule set it — it belongs
  // to a grid of its own, on the machine or classification it is set up on.
  if (spec.dataType === 'table') return `${spec.code}${unit} [table — do not edit; open it from the machine or its type]`;
  const kinds = new Set([...spec.sources, ...(spec.rules ?? [])]);
  const typeable = [...kinds].filter((s) => TYPEABLE_SOURCES.has(s));
  const derived = [...kinds].filter((s) => !TYPEABLE_SOURCES.has(s));
  if (derived.length && !typeable.length) return `${spec.code}${unit} [${derived.sort().join('/')} — do not edit]`;
  if (derived.length) return `${spec.code}${unit} [some cells are worked out — do not edit those]`;
  return `${spec.code}${unit}`;
}

function sheetMatrix(model) {
  const headers = [
    ...FIXED_COLUMNS.map((c) => (c.locked ? `${c.header}${LOCK}` : c.header)),
    ...model.specCols.map((s) => model.scope.kind === 'record' ? `${s.code}${s.uom ? ` (${s.uom})` : ''}${LOCK}` : specHeader(s)),
  ];
  const body = model.rows.map((r) => {
    const n = r.node;
    const shared = model.byRowId.get(r.rowId).length > 1;
    const vals = model.values.get(n.id) ?? new Map();
    const fields = {
      rowId: r.rowId, parentRowId: r.parentRowId, del: null, level: n.depth,
      path: indent(n.depth, labelOf(n)),
      code: n.code ?? model.placeholders?.get(placeholderKey(n.lineId, n.id))?.code ?? null,
      name: n.name ?? null, kind: n.kind, quantity: Number(n.quantity), totalQty: Number(n.total),
      uom: n.uom ?? null, role: n.role ?? null, notes: r.notes ?? null,
      flow: n.flow?.code ?? n.flow?.name ?? null, shared: shared ? 'yes' : null, locked: r.lockedWhy ?? null,
    };
    const fixed = FIXED_COLUMNS.map((c) => fields[c.key]);
    const specs = model.specCols.map((s) => vals.get(s.code)?.display ?? null);
    return { row: [...fixed, ...specs], model: r, shared, vals };
  });
  return { headers, body };
}

const INSTRUCTIONS = (model) => [
  ['How to change this BOM'],
  [],
  ...(model.scope.kind === 'record'
    ? [[`This sheet is the structure of ${model.root.code ?? model.root.name}.`]]
    : [[`This sheet is the structure of line ${model.line.line_no} of order ${model.line.order_code} — ${labelOf(model.root)}.`]]),
  [model.scope.kind === 'record'
    ? 'Change it here, save it, and import it back on the same item or definition.'
    : 'Change it here, save it, and import it back on the same order line.'],
  ...(model.frozenNote ? [[], ['READ ONLY', model.frozenNote], [undefined, 'This sheet is a record of what was built. It cannot be imported back.']] : []),
  [],
  ['The columns that matter'],
  ['White cells', 'These are the cells you can change. Grey cells are for reference. Quantity, Role and Notes come first.'],
  ['Row ID', 'How the system finds this row again. Never type in it.'],
  ['Parent Row ID', 'The Row ID of the row this one hangs under. ROOT is the top.'],
  ['Delete?', 'The ONLY way to remove anything. Put yes (or y, true, 1, x) against a row to take it out.'],
  [],
  ['Rows you leave out', 'A row that is not in the sheet is simply not mentioned, and nothing happens to it.'],
  [undefined, 'So you can filter this sheet down to the rows you care about, change those, and import'],
  [undefined, 'just that part. Leaving a row out NEVER deletes it — only Delete? does.'],
  [],
  ['What you may change'],
  ['Quantity', 'How many of this row are needed in the row above it.'],
  ['Role', 'What this row is for in its parent, in your own words.'],
  ['Notes', 'Free text.'],
  ['Specification columns', model.scope.kind === 'record' ? 'For reference only. Change these on the record\'s Values tab.' : 'Values you normally type: sizes, grades, and so on.'],
  [],
  ['To ADD a row', 'Insert a row anywhere. Leave Row ID EMPTY. Put the Row ID of its parent in Parent Row ID, put the'],
  [undefined, 'code of the item or template you are adding in Code, and put a Quantity. Role and Notes are optional.'],
  [undefined, 'Add the row first and export again before filling in its specification values.'],
  [],
  ['To REMOVE a row', 'Put yes in its Delete? column. Everything beneath it goes with it — you do not have to mark'],
  [undefined, 'those rows as well, and the dry run tells you how many go before anything happens.'],
  [undefined, 'Deleting the row out of the spreadsheet does NOT remove it.'],
  [],
  ['What you may NOT change', 'Every column marked "do not edit", and every specification cell marked as worked out'],
  [undefined, '(calculated, rollup, inherited or fixed). Those are worked out from other values — change'],
  [undefined, 'what they are worked out FROM and they follow. A code belongs to the code generator.'],
  [undefined, 'A row made for this order has no code yet: its Code shows the code its pieces get when'],
  [undefined, 'the line is locked, with # where each piece\'s own number goes. It is only shown.'],
  ...(model.scope.kind === 'orderLine'
    ? [[undefined, 'A row inside a catalog item\'s own BOM is shared by every order and is read only here;'],
      [undefined, 'the Locked column says which rows those are.']]
    : [[undefined, 'Rows below this item or definition belong to its own BOM. Direct rows can be changed here;'],
      [undefined, 'rows inside a child catalog item are shared and the Locked column explains why.']]),
  [undefined, 'To swap one item for another, remove its row and add the one you want — a row cannot'],
  [undefined, 'change what it holds.'],
  [],
  ['Shared rows', 'A row marked Shared appears more than once because one sub-assembly hangs under several'],
  [undefined, 'parents. It is ONE row in the system: give every copy the same values. Deleting it takes it'],
  [undefined, 'out of every parent, so every copy has to be in the sheet and marked, or none of them.'],
  [],
  ['Nothing is applied until it all works', 'The import checks the whole sheet first and refuses the lot if anything is wrong.'],
  [undefined, 'Upload Excel shows a preview. Review it, then press Apply changes to save.'],
  ...(model.droppedSpecs.length
    ? [[], ['Left out of this sheet', `${model.droppedSpecs.join(', ')} — the code clashes with a column of this sheet.`]]
    : []),
];

const GREY = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } };
const HEAD = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E2F3' } };
const HEAD_LOCKED = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDDDDDD' } };

/**
 * The sheet for one order line.
 * Returns { filename, contentType, buffer } — the route sends it as a file.
 */
export async function exportSheet(db, companyId, scopeInput, { format = 'xlsx' } = {}) {
  const fmt = String(format).toLowerCase() === 'csv' ? 'csv' : 'xlsx';
  const model = await buildModel(db, companyId, scopeInput);
  // An order's rows have no code of their own until the line is LOCKED; the
  // sheet shows the code their pieces will get instead, # where each piece's
  // number goes. Only shown: the import never reads it back. A sheet without
  // them is still a sheet, so a roll-out that cannot be worked out yet
  // (a selection unchosen) leaves the cells empty rather than failing the export.
  model.placeholders = model.scope.kind === 'orderLine'
    ? await linePlaceholders(db, companyId, model.scope.orderLineId)
      .then((ph) => new Map(ph.rows.map((r) => [placeholderKey(r.bomLineId, r.itemId), r])))
      .catch(() => null)
    : null;
  // Reading is always allowed — a closed order's sheet is a record worth having.
  // But the one rule that decides whether it can come back in is asked here too,
  // so the sheet says on its own face that it is read only.
  try { await assertEditable(db, companyId, model.root); model.frozenNote = null; }
  catch (e) { model.frozenNote = e.message; }
  const { headers, body } = sheetMatrix(model);
  const stem = (model.scope.kind === 'record'
    ? `BOM_${model.root.code ?? model.root.name}_structure`
    : `BOM_${model.line.order_code}_L${model.line.line_no}`).replace(/[^\w.-]+/g, '_');

  if (fmt === 'csv') {
    return {
      filename: `${stem}.csv`,
      contentType: 'text/csv; charset=utf-8',
      buffer: Buffer.from(toCsv([headers, ...body.map((b) => b.row)]), 'utf8'),
      rows: body.length,
      specColumns: model.specCols.map((s) => s.code),
    };
  }

  const wb = new ExcelJS.Workbook();
  wb.creator = 'CF ERP';
  wb.created = new Date();
  const ws = wb.addWorksheet(SHEET_NAME, { views: [{ state: 'frozen', xSplit: 1, ySplit: 1 }] });
  ws.columns = [
    ...FIXED_COLUMNS.map((c) => ({ width: c.width, hidden: !!c.hidden })),
    ...model.specCols.map(() => ({ width: 14 })),
  ];
  const head = ws.addRow(headers);
  head.font = { bold: true };
  head.alignment = { vertical: 'middle', wrapText: true };
  head.height = 60;
  headers.forEach((_, i) => {
    const isFixed = i < FIXED_COLUMNS.length;
    const locked = isFixed ? FIXED_COLUMNS[i].locked : model.scope.kind === 'record';
    head.getCell(i + 1).fill = locked ? HEAD_LOCKED : HEAD;
  });

  for (const b of body) {
    const r = ws.addRow(b.row);
    r.getCell(1).alignment = { indent: Math.min(b.model.depth, 10) };
    r.getCell(2).numFmt = '0.######';
    if (b.model.lineEditable && !model.frozenNote) {
      r.getCell(2).dataValidation = { type: 'decimal', operator: 'greaterThan', formulae: [0], showErrorMessage: true, error: 'Enter a quantity greater than zero.' };
      r.getCell(5).dataValidation = { type: 'list', allowBlank: true, formulae: ['"yes,no"'] };
    }
    FIXED_COLUMNS.forEach((c, i) => { if (c.locked) r.getCell(i + 1).fill = GREY; });
    model.specCols.forEach((s, i) => {
      const v = b.vals.get(s.code);
      if (!b.model.valuesEditable || (v && (s.dataType === 'table' || !TYPEABLE_SOURCES.has(v.source)))) r.getCell(FIXED_COLUMNS.length + i + 1).fill = GREY;
    });
    // A line that is not this order line's own is shown for context only — and
    // it cannot be deleted either, so its Delete? cell is shaded with the rest.
    if (!b.model.lineEditable || model.frozenNote) {
      for (const key of ['del', 'quantity', 'role', 'notes']) r.getCell(FIXED_COLUMNS.findIndex((cc) => cc.key === key) + 1).fill = GREY;
    }
  }
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: headers.length } };

  const notes = wb.addWorksheet(NOTES_SHEET);
  notes.columns = [{ width: 26 }, { width: 110 }];
  for (const lineTexts of INSTRUCTIONS(model)) notes.addRow(lineTexts);
  notes.getRow(1).font = { bold: true, size: 14 };

  return {
    filename: `${stem}.xlsx`,
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: Buffer.from(await wb.xlsx.writeBuffer()),
    rows: body.length,
    specColumns: model.specCols.map((s) => s.code),
  };
}

/* ===========================================================================
 * Reading a sheet back
 * ======================================================================== */

/** xlsx is a zip; a CSV is not. Sniffing beats trusting a file name. */
const looksXlsx = (buf) => buf.length > 1 && buf[0] === 0x50 && buf[1] === 0x4b;

async function readRows(buffer) {
  if (looksXlsx(buffer)) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const ws = wb.getWorksheet(SHEET_NAME) ?? wb.worksheets.find((w) => w.name !== NOTES_SHEET) ?? wb.worksheets[0];
    if (!ws) throw invalid('EMPTY_SHEET', 'That workbook has no sheets in it.');
    const out = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      const cells = [];
      const n = Math.max(row.cellCount, row.actualCellCount);
      for (let i = 1; i <= n; i++) cells.push(cellText(row.getCell(i).value));
      out.push(cells);
    });
    return out;
  }
  return parseCsv(buffer.toString('utf8')).map((r) => r.map((v) => (String(v).trim() === '' ? null : String(v).trim())));
}

/** Header row -> { fixed: {key -> index}, specs: [{code, index}], unknown: [] }. */
function mapHeaders(headerCells, problems) {
  const fixed = {};
  const specs = [];
  const seen = new Set();
  headerCells.forEach((h, i) => {
    const name = normaliseHeader(h);
    if (!name) return;
    if (seen.has(name)) { problems.push(`The column "${h}" appears twice — there can only be one of each.`); return; }
    seen.add(name);
    const col = FIXED_BY_HEADER.get(name);
    if (col) fixed[col.key] = i;
    else specs.push({ code: name, index: i, header: String(h).trim() });
  });
  for (const need of ['rowId', 'parentRowId', 'code', 'quantity']) {
    if (fixed[need] === undefined) {
      problems.push(`The sheet has no "${FIXED_COLUMNS.find((c) => c.key === need).header}" column — it is not a BOM sheet from this structure.`);
    }
  }
  return { fixed, specs };
}

/* ===========================================================================
 * The plan: what this sheet would do, worked out without writing anything.
 * ======================================================================== */

const sentence = (s) => {
  const bits = [];
  const add = (n, one, many) => { if (n) bits.push(`${n} ${n === 1 ? one : many}`); };
  add(s.quantityChanged, 'quantity changed', 'quantities changed');
  add(s.roleChanged, 'role changed', 'roles changed');
  add(s.notesChanged, 'note changed', 'notes changed');
  add(s.valuesChanged, 'value changed', 'values changed');
  add(s.rowsAdded, 'row added', 'rows added');
  add(s.rowsRemoved, 'row removed', 'rows removed');
  // The number somebody has to see before they agree to a deletion.
  if (s.rowsRemovedBeneath) bits.push(`${s.rowsRemovedBeneath} ${s.rowsRemovedBeneath === 1 ? 'row' : 'rows'} beneath them going too`);
  return bits.length ? bits.join(', ') : 'nothing to change';
};

async function buildPlan(db, c, model, sheet) {
  const problems = [];
  const changes = [];
  const companyId = c.companyId;
  if (!sheet.length) throw invalid('EMPTY_SHEET', 'That sheet has no rows in it.');
  if (sheet.length - 1 > MAX_ROWS) throw invalid('TOO_BIG', `A sheet of more than ${MAX_ROWS} rows is more than this import will take in one go.`);

  const { fixed, specs: specCols } = mapHeaders(sheet[0], problems);
  assertNoProblems(problems, 'That sheet cannot be read.');

  // A column's data type is needed before its cells are read — a table's is
  // never written back, whatever the sheet's cell says (its column header
  // already says so; specHeader marks the export the same way).
  if (specCols.length) {
    const { byCode: specTypeByCode } = await loadSpecs(db, companyId, specCols.map((s) => ({ specCode: s.code })));
    for (const col of specCols) col.dataType = specTypeByCode.get(col.code)?.data_type ?? null;
  }

  const cell = (row, key) => (fixed[key] === undefined ? null : text(row[fixed[key]]));
  const bodyRows = sheet.slice(1)
    .map((row, i) => ({ row, sheetRow: i + 2 }))
    .filter(({ row }) => row.some((v) => !blank(v)));

  // ---- group the sheet's rows by Row ID ------------------------------------
  const seenByRowId = new Map();
  const newRows = [];
  for (const entry of bodyRows) {
    const rowId = cell(entry.row, 'rowId');
    if (rowId === null) { newRows.push(entry); continue; }
    const key = rowId === ROOT_ROW_ID ? ROOT_ROW_ID : rowId;
    if (key !== ROOT_ROW_ID && !/^\d+$/.test(key)) {
      problems.push(`Row ${entry.sheetRow}: "${rowId}" is not a Row ID this sheet handed out. Leave Row ID empty to add a row; never type in it.`);
      continue;
    }
    if (!seenByRowId.has(key)) seenByRowId.set(key, []);
    seenByRowId.get(key).push(entry);
  }
  if (!seenByRowId.has(ROOT_ROW_ID)) {
    problems.push(`The ${ROOT_ROW_ID} row is missing. A sheet without it is a part of the structure, not the structure — export it again and change that copy.`);
  }
  for (const rowId of seenByRowId.keys()) {
    if (!model.byRowId.has(rowId)) {
      problems.push(`Row ID ${rowId} is not part of this structure any more — it may have changed since the sheet was exported. Export it again and redo the change.`);
    }
  }
  // A sheet that does not line up with this order line has no plan to report:
  // working out removals from it would be guesswork on a sheet nobody trusts.
  // It still comes back as a REPORT rather than an exception, so a dry run
  // always answers in the same shape; applying it refuses on these problems
  // like any others.
  if (problems.length) {
    return {
      problems, changes: [], removalPlan: [], updatePlan: [], valuePlan: [], addPlan: [],
      specColumns: specCols.map((x) => x.code),
      summary: {
        rowsInSheet: bodyRows.length, rowsMatched: 0, quantityChanged: 0, roleChanged: 0, notesChanged: 0,
        valuesChanged: 0, rowsAdded: 0, rowsRemoved: 0, rowsRemovedBeneath: 0, unchanged: 0,
        sentence: 'nothing — this sheet does not match this structure',
      },
    };
  }

  // ---- what the sheet says twice, which is never right ---------------------
  for (const [rowId, entries] of seenByRowId) {
    if (rowId === ROOT_ROW_ID) continue;
    const live = model.byRowId.get(rowId).length;
    if (entries.length > live) {
      problems.push(live > 1
        ? `Row ${rowId} (${labelOf(model.byRowId.get(rowId)[0].node)}) sits under ${live} parents, so it belongs in the sheet ${live} times; it is there ${entries.length} times. Delete the extra copies.`
        : `Row ${rowId} appears ${entries.length} times in the sheet but only once in the structure. Delete the extra copies.`);
    }
  }

  // ---- removals: only what Delete? asks for --------------------------------
  // A row that is not in the sheet is NOT MENTIONED, and nothing happens to it,
  // so a filtered sheet changes only what it shows. Nothing is removed without
  // somebody writing it down.
  const removedSet = new Set();
  for (const [rowId, entries] of seenByRowId) {
    const given = entries.map((e) => (cell(e.row, 'del') ?? '').toLowerCase());
    const bad = given.filter((g) => g !== '' && !DELETE_YES.has(g) && !DELETE_NO.has(g));
    if (bad.length) {
      problems.push(`Row ${rowId}: "${bad[0]}" is not an answer to Delete?. Write yes to take the row out, or leave it empty to keep it.`);
      continue;
    }
    const yes = given.filter((g) => DELETE_YES.has(g));
    if (!yes.length) continue;
    const places = model.byRowId.get(rowId);
    if (rowId === ROOT_ROW_ID) {
      problems.push(model.scope.kind === 'record'
        ? `The ${ROOT_ROW_ID} row is the item or definition itself — change its record details on the item screen, not the top of its own structure.`
        : `The ${ROOT_ROW_ID} row is the item this order line sells — take the LINE off the order, not the top of its own structure.`);
      continue;
    }
    if (!places[0].lineEditable) {
      problems.push(`Row ${rowId} (${labelOf(places[0].node)}) cannot be removed here — it is ${places[0].lockedWhy}.`);
      continue;
    }
    // Deleting a shared line takes it out of EVERY parent, so every copy has to
    // be in the sheet and marked. One marked copy of three is an instruction
    // that cannot be carried out as written.
    // (Unreachable as the model stands: a temporary item has exactly one parent,
    // so every shared row sits in a catalog item's own BOM and the locked rule
    // above answers first. Kept because the rule is true whatever makes a shared
    // BOM, and the alternative to refusing is deleting from a parent nobody
    // mentioned.)
    if (yes.length !== places.length) {
      problems.push(`Row ${rowId} (${labelOf(places[0].node)}) sits under ${places.length} parents and is one row in the system — deleting it takes it out of all of them. Mark every one of its ${places.length} rows, or none.`);
      continue;
    }
    removedSet.add(rowId);
  }

  // Everything that disappears, place by place: a marked row, and whatever hangs
  // below it. model.rows is depth first, parents before children, so one forward
  // pass settles it. This is the number a person needs before agreeing.
  const doomedKeys = new Set();
  for (const r of model.rows) {
    if (r.rowId === ROOT_ROW_ID) continue;
    if (removedSet.has(r.rowId) || (r.parentKey && doomedKeys.has(r.parentKey))) doomedKeys.add(r.key);
  }
  const markedKeys = new Set(model.rows.filter((r) => removedSet.has(r.rowId)).map((r) => r.key));
  const removedBeneath = [...doomedKeys].filter((k) => !markedKeys.has(k)).length;

  // Only the topmost removal is acted on; the rest go with it.
  const removalPlan = [];
  for (const rowId of removedSet) {
    const places = model.byRowId.get(rowId);
    const first = places[0];
    if (places.every((p) => p.parentKey && doomedKeys.has(p.parentKey))) continue;
    removalPlan.push({ rowId, lineId: Number(rowId), depth: first.depth, node: first.node });
    const beneath = [...doomedKeys].filter((k) => k !== first.key && !markedKeys.has(k)).length;
    changes.push({
      action: 'remove',
      rowId,
      path: indent(first.depth, labelOf(first.node)),
      detail: `quantity ${Number(first.node.quantity)} under ${labelOf(first.parentNode)}`
        + (beneath ? ', taking what is under it with it' : ''),
    });
  }

  // ---- changes to the rows that came back ----------------------------------
  const updatePlan = [];
  const valuePlan = [];
  const specNeedingRules = new Map(); // nodeId -> { node, codes:Set }
  const valueDrafts = [];

  for (const [rowId, entries] of seenByRowId) {
    const places = model.byRowId.get(rowId);
    if (!places) continue;
    const place = places[0];
    const n = place.node;
    const label = indent(place.depth, labelOf(n));
    const vals = model.values.get(n.id) ?? new Map();

    // A row the sheet marks for deletion is going. Whatever else is typed in it
    // is beside the point, and complaining about it would be noise.
    if (removedSet.has(rowId)) continue;
    // A row that goes because something ABOVE it was marked is different: the
    // sheet still shows it, so an edit to it is a contradiction worth saying out
    // loud rather than dropping. Anything this row produces is taken back at the
    // bottom of the loop and replaced with one sentence.
    const goingWithParent = rowId !== ROOT_ROW_ID && places.every((p) => doomedKeys.has(p.key));
    const mark = { changes: changes.length, updates: updatePlan.length, drafts: valueDrafts.length };

    // Every copy of a shared row must say the same thing.
    const agree = (key, read) => {
      const seenVals = entries.map(read);
      const first = seenVals[0];
      if (seenVals.some((v) => (v ?? '') !== (first ?? ''))) {
        problems.push(`Row ${rowId} (${labelOf(n)}) is given more than one ${key} — its copies must agree. Found ${[...new Set(seenVals.map((v) => `"${v ?? ''}"`))].join(', ')}.`);
        return { conflict: true, value: first };
      }
      return { conflict: false, value: first };
    };

    // Code is identity, not a field. Changing it is remove-and-add.
    //
    // Except on an order's own rows (temporary items): a row is a design with no
    // code of its own — its pieces are coded when the line is LOCKED — so its
    // Code cell holds the placeholder the export printed (# where each piece's
    // number goes), or, on a sheet exported before rows lost their codes, the
    // code it used to carry. Either way it names nothing, so it is not read.
    // The Row ID says which line this is, and a line never changes what it holds.
    const codeRead = n.kind === 'temporary' ? { conflict: true } : agree('Code', (e) => cell(e.row, 'code'));
    if (!codeRead.conflict) {
      const was = n.code ?? '';
      const now = codeRead.value ?? '';
      if (was !== '' && now !== '' && was.toUpperCase() !== now.toUpperCase()) {
        problems.push(n.selection
          ? `Row ${rowId} chooses a catalog item for ${n.selection.code ?? n.selection.name}; the sheet does not change that choice — make it on the structure screen.`
          : `Row ${rowId}: what a line holds cannot change (${was} -> ${now}) — take this row out and add ${now} instead.`);
      } else if (was === '' && now !== '') {
        // A catalog item still without a code gets one from the code generator,
        // which owns it. Typing one here would otherwise look like it worked
        // and then quietly do nothing.
        problems.push(`Row ${rowId} (${labelOf(n)}) has no code of its own, and a code is given by the code generator — this sheet does not name records. Leave Code empty on a row that came out empty.`);
      }
    }
    // Parent Row ID is the ONE column whose copies are meant to differ: a shared
    // row has a different parent in each place it fills. So the set is compared,
    // not the values one against another. (A mismatched COUNT is the copy check
    // below; reporting it here as well would say the same thing twice.)
    if (rowId !== ROOT_ROW_ID) {
      const expected = places.map((p) => p.parentRowId).sort();
      const given = entries.map((e) => cell(e.row, 'parentRowId') ?? '').sort();
      if (expected.length === given.length && given.some((g, i) => g !== expected[i])) {
        problems.push(`Row ${rowId} (${labelOf(n)}) has been given a different Parent Row ID (${given.join(', ')} instead of ${expected.join(', ')}). A row cannot be moved by retyping its parent — take it out and add it where it belongs.`);
      }
    }

    if (rowId === ROOT_ROW_ID) {
      const q = agree('Quantity', (e) => cell(e.row, 'quantity')).value;
      if (q !== null && !near(q, Number(n.quantity))) {
        problems.push(model.scope.kind === 'record' ? 'The ROOT quantity is always 1 for an item structure.' : `The ${ROOT_ROW_ID} row's quantity is the order line's own quantity — change it on the order, not in this sheet.`);
      }
    } else if (place.lineEditable) {
      const sets = {};
      const q = agree('Quantity', (e) => cell(e.row, 'quantity'));
      if (!q.conflict) {
        if (q.value === null) problems.push(`Row ${rowId} (${labelOf(n)}) has no quantity. Every row needs one.`);
        else {
          const num = Number(q.value);
          if (!Number.isFinite(num) || num <= 0) problems.push(`Row ${rowId} (${labelOf(n)}): "${q.value}" is not a quantity — it must be a number greater than zero.`);
          else if (num >= 1e9) problems.push(`Row ${rowId} (${labelOf(n)}): that quantity is too large.`);
          else if (!near(num, Number(n.quantity))) {
            sets.quantity = Number(num.toFixed(6));
            changes.push({ action: 'update', field: 'quantity', rowId, path: label, from: Number(n.quantity), to: sets.quantity });
          }
        }
      }
      const role = agree('Role', (e) => cell(e.row, 'role'));
      if (!role.conflict && fixed.role !== undefined && (role.value ?? null) !== (n.role ?? null)) {
        if ((role.value ?? '').length > 100) problems.push(`Row ${rowId}: Role is up to 100 characters.`);
        else {
          sets.role = role.value;
          changes.push({ action: 'update', field: 'role', rowId, path: label, from: n.role, to: role.value });
        }
      }
      const notes = agree('Notes', (e) => cell(e.row, 'notes'));
      if (!notes.conflict && fixed.notes !== undefined && (notes.value ?? null) !== (place.notes ?? null)) {
        sets.notes = notes.value;
        changes.push({ action: 'update', field: 'notes', rowId, path: label, from: place.notes ?? null, to: notes.value });
      }
      if (Object.keys(sets).length) updatePlan.push({ lineId: Number(rowId), rowId, sets, depth: place.depth });
    } else {
      // A locked line is shown for context. Say so only when they actually
      // changed something on it — silently dropping the edit is the one thing
      // that must not happen.
      const q = agree('Quantity', (e) => cell(e.row, 'quantity')).value;
      const role = agree('Role', (e) => cell(e.row, 'role')).value;
      const notes = agree('Notes', (e) => cell(e.row, 'notes')).value;
      const touched = [
        q !== null && !near(q, Number(n.quantity)) ? 'Quantity' : null,
        fixed.role !== undefined && (role ?? null) !== (n.role ?? null) ? 'Role' : null,
        fixed.notes !== undefined && (notes ?? null) !== (place.notes ?? null) ? 'Notes' : null,
      ].filter(Boolean);
      if (touched.length) {
        problems.push(`Row ${rowId} (${labelOf(n)}): ${touched.join(' and ')} cannot change here — it is ${place.lockedWhy}.`);
      }
    }

    // ---- specification values ----------------------------------------------
    for (const col of specCols) {
      const read = agree(col.code, (e) => text(e.row[col.index]));
      if (read.conflict) continue;
      const now = read.value;
      const stored = vals.get(col.code) ?? null;
      const was = stored?.display == null ? null : String(stored.display);
      if ((now ?? '') === (was ?? '')) continue;
      if (was !== null && now !== null && !Number.isNaN(Number(was)) && !Number.isNaN(Number(now)) && near(was, now)) continue;
      if (col.dataType === 'table') {
        // The cell shows a summary ("15 rows, 6-50 mm"), never the chart
        // itself — a changed cell is reported rather than silently dropped,
        // the same as any other edit this sheet cannot carry out.
        problems.push(`Row ${rowId} (${labelOf(n)}): ${col.code} is a table — its chart cannot be set from this sheet. Open it from the machine or classification it is set up on.`);
        continue;
      }
      if (!place.valuesEditable) {
        problems.push(`Row ${rowId} (${labelOf(n)}): ${col.code} cannot be set here — ${n.kind === 'catalog' ? 'it is a catalog item, shared by every order' : `it is ${place.lockedWhy ?? 'not part of this order line'}`}.`);
        continue;
      }
      if (stored && !TYPEABLE_SOURCES.has(stored.source)) {
        problems.push(`Row ${rowId} (${labelOf(n)}): ${col.code} is ${stored.source} — it is worked out, not typed in. Change what it is worked out from.`);
        continue;
      }
      if (!specNeedingRules.has(n.id)) specNeedingRules.set(n.id, { node: n, codes: new Set() });
      specNeedingRules.get(n.id).codes.add(col.code);
      valueDrafts.push({ rowId, nodeId: n.id, label, code: col.code, from: was, to: now });
    }

    if (goingWithParent && (changes.length > mark.changes || updatePlan.length > mark.updates || valueDrafts.length > mark.drafts)) {
      changes.length = mark.changes;
      updatePlan.length = mark.updates;
      valueDrafts.length = mark.drafts;
      problems.push(`Row ${rowId} (${labelOf(n)}) is changed by this sheet, but it also goes when the row above it is deleted — a change and a deletion of the same thing cannot both happen. Take the change out, or take the Delete? off its parent.`);
    }
  }

  // ---- the rules behind every value that changed ----------------------------
  // resolve() is asked once per node that has an edited cell — bounded by the
  // number of edits, not by the size of the tree — so a dry run can refuse a
  // calculated value without having written anything.
  if (valueDrafts.length) {
    const { byCode } = await loadSpecs(db, companyId, [...new Set(valueDrafts.map((d) => d.code))].map((specCode) => ({ specCode })));
    for (const [nodeId, { node, codes }] of specNeedingRules) {
      const master = await requireMaster(db, companyId, nodeId);
      const r = await resolve(db, companyId, { master });
      const byName = new Map(r.specs.map((s) => [String(s.spec.code).toUpperCase(), s]));
      for (const code of codes) {
        // A draft taken back above (a row that goes with its parent) leaves its
        // node listed here with nothing left to check.
        const draft = valueDrafts.find((d) => d.nodeId === nodeId && d.code === code);
        if (!draft) continue;
        const spec = byCode.get(code);
        if (!spec) { problems.push(`${draft.label}: there is no specification with the code ${code}.`); continue; }
        const entry = byName.get(code);
        if (!entry || !entry.applicable) { problems.push(`${draft.label}: ${code} is not part of this item's setup.`); continue; }
        if (entry.captureAt !== 'item') { problems.push(`${draft.label}: ${code} is captured on the ${entry.captureAt}, not on the item, so it is not set from this sheet.`); continue; }
        const vr = entry.rule.valueRule;
        if (!TYPEABLE_RULES.has(vr)) {
          problems.push(vr === 'fixed'
            ? `${draft.label}: ${code} is fixed at ${entry.definedAt.level.toLowerCase()} level — change it there, not here.`
            : `${draft.label}: ${code} is ${vr} — it is worked out, not typed in. Change what it is worked out from.`);
          continue;
        }
        const allowed = entry.options ? new Set(entry.options.map((o) => o.id)) : null;
        const out = await coerce(db, companyId, spec, draft.to, allowed);
        if (out.problem) { problems.push(`${draft.label}: ${out.problem}`); continue; }
        valuePlan.push({ nodeId, code, specificationId: spec.id, value: draft.to });
        changes.push({ action: 'value', field: code, rowId: draft.rowId, path: draft.label, from: draft.from, to: draft.to });
      }
    }
  }

  // ---- new rows -------------------------------------------------------------
  const addPlan = [];
  for (const { row, sheetRow } of newRows) {
    const parentRowId = cell(row, 'parentRowId');
    const code = cell(row, 'code');
    const label = `New row ${sheetRow}`;
    if (!parentRowId) { problems.push(`${label}: it has no Parent Row ID, so there is nowhere to put it. Put the Row ID of the row it belongs under.`); continue; }
    const parentPlaces = model.byRowId.get(parentRowId);
    if (!parentPlaces) {
      problems.push(`${label}: Parent Row ID ${parentRowId} is not a row of this structure. A new row must hang under a row that is already there — add one level, export again, then add beneath it.`);
      continue;
    }
    const parent = parentPlaces[0];
    if (parentPlaces.some((p) => doomedKeys.has(p.key))) {
      problems.push(`${label}: its parent is being removed. Keep the parent or remove this new row.`);
      continue;
    }
    const canAddUnder = model.scope.kind === 'record'
      ? parent.node.id === model.root.id
      : parent.node.kind === 'temporary';
    if (!canAddUnder) {
      problems.push(model.scope.kind === 'record'
        ? `${label}: rows can only be added directly under ${labelOf(model.root)} in this sheet. ${labelOf(parent.node)} is inside a child catalog BOM, which is shared.`
        : `${label}: rows can only be added under this order's own parts. ${labelOf(parent.node)} is a ${parent.node.kind} record, shared by every order that uses it.`);
      continue;
    }
    if (!code) { problems.push(`${label}: it has no Code, so there is nothing to add. Put the code of the item or template definition you want.`); continue; }
    const [[found]] = await db.query(
      'SELECT id FROM cf_master_records WHERE company_id = ? AND UPPER(code) = ? AND deleted_at IS NULL LIMIT 2',
      [companyId, code.toUpperCase()],
    );
    if (!found) { problems.push(`${label}: nothing in the catalog has the code ${code}.`); continue; }
    const child = await requireMaster(db, companyId, found.id);
    const childKind = kindOf(child);
    const allowedKinds = model.scope.kind === 'record'
      ? (ALLOWED_CHILDREN[model.bomType] ?? [])
      : ALLOWED_CHILDREN.custom;
    if (!allowedKinds.includes(childKind)) {
      problems.push(model.scope.kind === 'record'
        ? `${label}: ${code} is a ${childKind} record, and this ${model.bomType ?? 'item'} structure accepts ${allowedKinds.join(', ') || 'no child records'}.`
        : `${label}: ${code} is a row of another order’s structure and cannot be put on this one. Add the template definition it was made from.`);
      continue;
    }
    if (child.status === 'obsolete') { problems.push(`${label}: ${code} is obsolete.`); continue; }
    if (child.id === parent.node.id || (await descendantIds(db, companyId, child.id)).has(parent.node.id)) {
      problems.push(`${label}: ${code} would make this structure contain itself.`);
      continue;
    }
    if ((cell(row, 'role') ?? '').length > 100) { problems.push(`${label}: Role is up to 100 characters.`); continue; }
    const qText = cell(row, 'quantity');
    const q = Number(qText);
    if (qText === null) { problems.push(`${label}: it has no Quantity.`); continue; }
    if (!Number.isFinite(q) || q <= 0 || q >= 1e9) { problems.push(`${label}: "${qText}" is not a quantity — it must be a number greater than zero.`); continue; }
    // Values on something that does not exist yet have nowhere to go.
    const withValues = specCols.filter((col) => !blank(row[col.index]));
    if (withValues.length) {
      problems.push(`${label}: values (${withValues.map((x) => x.code).join(', ')}) cannot be set on a row that does not exist yet. Add the row, export the sheet again, then fill them in.`);
      continue;
    }
    addPlan.push({
      sheetRow, parentId: parent.node.id, parentRowId, childId: child.id, code: child.code ?? code,
      quantity: Number(q.toFixed(6)), role: cell(row, 'role'), notes: cell(row, 'notes'),
    });
    changes.push({ action: 'add', rowId: null, path: `${indent(parent.depth + 1, child.code ?? child.name)}`, detail: `under ${labelOf(parent.node)}, quantity ${Number(q.toFixed(6))}` });
  }

  const touched = new Set(changes.filter((x) => x.action !== 'remove' && x.action !== 'add' && x.rowId).map((x) => x.rowId));
  // Rows the sheet mentions that are on their way out — neither changed nor left alone.
  const mentionedAndGoing = [...seenByRowId.keys()]
    .filter((id) => id !== ROOT_ROW_ID && (model.byRowId.get(id) ?? []).every((p) => doomedKeys.has(p.key))).length;
  const summary = {
    rowsInSheet: bodyRows.length,
    rowsMatched: seenByRowId.size,
    quantityChanged: changes.filter((x) => x.action === 'update' && x.field === 'quantity').length,
    roleChanged: changes.filter((x) => x.action === 'update' && x.field === 'role').length,
    notesChanged: changes.filter((x) => x.action === 'update' && x.field === 'notes').length,
    valuesChanged: changes.filter((x) => x.action === 'value').length,
    rowsAdded: addPlan.length,
    rowsRemoved: removalPlan.length,
    rowsRemovedBeneath: removedBeneath,
    unchanged: seenByRowId.size - touched.size - mentionedAndGoing,
  };
  summary.sentence = sentence(summary);

  return { problems, changes, summary, removalPlan, updatePlan, valuePlan, addPlan, specColumns: specCols.map((x) => x.code) };
}

/* ===========================================================================
 * Import
 * ======================================================================== */

/**
 * Reads a sheet back onto an order line.
 *
 *   input.fileBase64 / input.file   the workbook or CSV, base64 (a Buffer is
 *                                   taken too, which is what the tests pass)
 *   input.dryRun                    true reports the plan and writes nothing
 *
 * Nothing is written until the whole sheet has been read and every problem
 * collected; a sheet with two problems reports both and applies neither.
 */
export async function importSheet(db, c, scopeInput, input = {}) {
  const dryRun = input.dryRun === true || input.dryRun === 'true' || input.dryRun === 1 || input.dryRun === '1';
  const raw = input.file ?? input.fileBase64 ?? input.content;
  if (raw == null || raw === '') throw invalid('NO_FILE', 'There is no sheet to import — send the file as `fileBase64`.');
  let buffer;
  try {
    buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw).replace(/^data:[^,]*,/, ''), 'base64');
  } catch {
    throw invalid('BAD_FILE', 'That file could not be read — send it as base64.');
  }
  if (!buffer.length) throw invalid('BAD_FILE', 'That file is empty.');

  const model = await buildModel(db, c.companyId, scopeInput);
  // One rule for "this structure can still change", asked before anything else.
  await assertEditable(db, c.companyId, model.root);

  const sheet = await readRows(buffer);
  const plan = await buildPlan(db, c, model, sheet);

  const head = {
    ...(model.scope.kind === 'orderLine' ? {
      orderLine: { id: model.line.id, lineNo: model.line.line_no, quantity: Number(model.line.quantity) },
      order: { id: model.line.order_id, code: model.line.order_code, status: model.line.order_status },
    } : {
      record: { id: model.root.id, code: model.root.code, name: model.root.name, kind: kindOf(model.root) },
    }),
    root: { id: model.root.id, code: model.root.code, name: model.root.name },
    format: looksXlsx(buffer) ? 'xlsx' : 'csv',
    dryRun,
    summary: plan.summary,
    changes: plan.changes,
    problems: plan.problems,
    ok: plan.problems.length === 0,
  };
  // A dry run REPORTS; it never throws for a problem the sheet can be fixed to
  // avoid, because seeing the plan and the problems together is the point.
  if (dryRun) return head;

  assertNoProblems(plan.problems, `That sheet was not applied — ${plan.problems.length} problem${plan.problems.length === 1 ? '' : 's'} to fix first.`);

  // Keep BOM validation in its shared mutators, but refresh quantities once for
  // the whole sheet. Recalculating the same tree after every cell takes minutes
  // over the production database connection.
  const refreshParents = new Set();

  // Removals shallowest first: a parent takes its subtree with it, so a deeper
  // removal may already be gone by the time its turn comes.
  for (const r of [...plan.removalPlan].sort((a, b) => a.depth - b.depth)) {
    const [[still]] = await db.query('SELECT id FROM cf_bom_lines WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [c.companyId, r.lineId]);
    if (still) refreshParents.add((await writeLineRemoval(db, c, r.lineId)).parentId);
  }
  for (const u of plan.updatePlan) {
    const changed = await writeLineUpdate(db, c, u.lineId, u.sets);
    if (changed.values) refreshParents.add(changed.parentId);
  }
  if (refreshParents.size) await refreshValues(db, c, [...refreshParents]);
  const byNode = new Map();
  for (const v of plan.valuePlan) {
    if (!byNode.has(v.nodeId)) byNode.set(v.nodeId, []);
    byNode.get(v.nodeId).push({ specificationId: v.specificationId, value: v.value });
  }
  for (const [nodeId, entries] of byNode) await setValues(db, c, 'master', nodeId, entries);
  for (const a of plan.addPlan) {
    await addLine(db, c, a.parentId, { childId: a.childId, quantity: a.quantity, role: a.role, notes: a.notes });
  }

  const after = await explode(db, c.companyId, model.root.id, {
    rootQuantity: model.scope.kind === 'orderLine' ? Number(model.line.quantity) : 1,
  });
  return { ...head, applied: true, stats: after.stats };
}

/** Item / definition structure wrappers keep the order-line API readable. */
export async function exportRecordSheet(db, companyId, recordId, opts = {}) {
  return exportSheet(db, companyId, { kind: 'record', recordId }, opts);
}

export async function importRecordSheet(db, c, recordId, input = {}) {
  return importSheet(db, c, { kind: 'record', recordId }, input);
}
