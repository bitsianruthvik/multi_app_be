/**
 * orderSheetLayout.js — what the Structure tab draws for one order line, as data.
 *
 * The order-line Excel (services/orderSheetService.js) is "the BOM as seen on
 * screen, two rows per line". So the rule for WHICH rows there are, WHICH fields
 * each row has, in WHAT order and with WHAT text is written here once, as a
 * pure function of the two things the screen itself is drawn from:
 *
 *   root     the structure tree   (GET /order-lines/:id/structure — bomService.explode)
 *   view     the values view      (GET /order-lines/:id/values   — orderValuesService.readLineValues)
 *   codes    Map 'l<bomLineId>' | 'i<itemId>' -> placeholder code (placeholderService.linePlaceholders)
 *
 * It is the backend's MIRROR of the frontend's own pure rules, and the two are
 * held together by a test that runs both over one fixture and compares them
 * row by row, field by field, text by text:
 *   multi_app_fe/scripts/cf_erp_order_sheet_layout_test.mjs
 *
 *   frontend rule                                   mirrored here by
 *   bomModel.flattenBom + withoutCutPieces          visibleRows
 *   bomModel.rowLabel / roleShown                   rowLabel
 *   lib/displayCode.displayCode + placeholderOf     codeShown
 *   lib/bomGridLayout.viewCatalog / sortColumns     catalogOf
 *   lib/bomGridLayout.shownColumns / rowColumnCodes fieldCodes
 *   lib/bomGridLayout.viewCell                      valueField
 *   valuesModel.computeGaps (nothing typed)         missingOf
 *   lib/stripLayout (dimensions, roll-ups, total,
 *     SHIP_UNIT, PART_FUNCTION, sheetLabel)         the constants below
 *
 * Change a rule on one side and that test fails until the other follows.
 * Nothing here reads the database or knows about Excel.
 */

export const DIMENSION_CODES = ['THICKNESS', 'LENGTH', 'WIDTH'];
export const ROLLUP_CODES = ['WEIGHT'];
export const HIDDEN_ON_GRID = new Set(['PART_FUNCTION']);
const DIMS = new Set(DIMENSION_CODES);
const ROLLUPS = new Set(ROLLUP_CODES);

/** stripLayout.SHORT — the word above a cell. */
const SHORT = {
  THICKNESS: 'Thk', LENGTH: 'L', WIDTH: 'W', DEPTH: 'D', DIAMETER: 'Dia', SECTION_AREA: 'Area', WEIGHT: 'Wt',
  DENSITY: 'Density', CUT_LENGTH: 'Cut L', SPAN_LENGTH: 'Span L', MAX_THICKNESS: 'Max thk', GRADE: 'Grade',
  MATERIAL: 'Material', IMPACT_CLASS: 'Impact', PART_FUNCTION: 'Function', DRAWING_MARK: 'Dwg mark', HEAT_NO: 'Heat no',
  BOLT_CLASS: 'Bolt cl', SKEW_ANGLE: 'Skew', GIRDER_SPACING: 'Spacing', PIERCINGS: 'Pierce', HOLED: 'Holed',
  NESTING: 'Nesting', NEST_MANUAL: 'Nest by hand', SHIP_UNIT: 'Ship unit',
};

/**
 * stripLayout.sheetLabel — the word above a cell where there is room for it:
 * the grid's own short word for a well-known value (Thk, L, W, Wt …), else the
 * specification's whole name. The grid cuts a long name to fit its cell and
 * keeps the rest in a tooltip; a spreadsheet has no tooltip, so it is not cut.
 */
export function sheetLabel(code, name) {
  return SHORT[code] ?? String(name || code).trim();
}

/** The label of a value field: that word, and its unit. */
export const fieldLabel = (code, name, unit) => `${sheetLabel(code, name)}${unit ? ` (${unit})` : ''}`;

export const QTY = '$quantity';
export const TOTAL = '$total';
export const FLOW = '$flow';
export const FIXED_LABELS = { [QTY]: 'Qty', [TOTAL]: 'Total', [FLOW]: 'Flow' };

/** bomModel.isCutPiece — rows the system makes by itself under a plate or section part. */
export const isCutPiece = (n) => n.role === 'Cut from' || n.role === 'Raw plate';

const squash = (t) => String(t ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
/** bomModel.roleShown / rowLabel — a role is shown only when it says something the name does not. */
export function rowLabel(name, role) {
  const r = String(role ?? '').trim();
  return r && squash(r) !== squash(name) ? `${name} · ${r}` : name;
}

/** How a structure node finds its placeholder (api/placeholders.placeholderKey). */
export const placeholderKey = (lineId, itemId) => (lineId != null ? `l${lineId}` : `i${itemId}`);

/**
 * The code a row shows under its name: its placeholder; else nothing for an
 * order's own row (it has no code until the line is locked), a definition's
 * short name, a catalog item's code.
 */
export function codeShown(node, codes) {
  const p = codes?.get(placeholderKey(node.lineId, node.id));
  if (p) return p;
  if (node.kind === 'temporary') return '';
  if (node.kind === 'template' || node.kind === 'selection') return node.shortName ? node.shortName : '';
  return node.code ? node.code : '';
}

/**
 * The stable id of one PLACE in the structure: the BOM line (ROOT for what the
 * line sells; `#n` when one line is reached through several parents) and the
 * record it holds.
 */
export function pairId(node) {
  const place = node.lineId == null ? 'ROOT' : String(node.key).replace(/^l/, '');
  return `${place}:${node.id}`;
}

/** Every row the screen draws, depth first, everything open, cut pieces left out. */
export function visibleRows(root) {
  const rows = [];
  const walk = (node, parent) => {
    rows.push({ node, parent });
    for (const kid of node.children ?? []) walk(kid, node);
  };
  walk(root, null);
  return rows.filter((r) => !isCutPiece(r.node)).map((r) => ({
    ...r,
    hasChildren: (r.node.children ?? []).length > 0 && !(r.node.children ?? []).every(isCutPiece),
  }));
}

/** The grid's columns: every group's, the ones somebody may type first; and each record's own row and columns. */
function catalogOf(view) {
  const cols = new Map();
  const records = new Map();
  for (const group of view?.groups ?? []) {
    for (const col of group.columns) {
      const old = cols.get(col.code);
      cols.set(col.code, old ? { ...old, editable: old.editable || col.editable } : col);
    }
    const columns = new Map(group.columns.map((c) => [c.code, c]));
    for (const row of group.rows) records.set(row.id, { row, columns, own: !!group.own });
  }
  // Array.prototype.sort is stable: what may be typed leads, each half in the order it arrived.
  return { cols: [...cols.values()].sort((a, b) => Number(b.editable) - Number(a.editable)), records };
}

/** A cell with its column's shared fields put back (valuesModel.effectiveCell). */
function effective(view, col, row, cell, canEdit) {
  const pick = (key) => (key in cell ? cell[key] : col[key]);
  const rule = pick('rule');
  const optionsKey = pick('options');
  const typeable = col.dataType !== 'table' && (rule === 'entered' || rule === 'defaulted');
  return {
    rule,
    required: !!pick('required'),
    why: pick('why') ?? null,
    options: optionsKey ? view.optionLists?.[optionsKey] : undefined,
    input: cell.input ?? '',
    display: cell.display ?? null,
    defaultDisplay: cell.defaultDisplay ?? null,
    missing: !!cell.missing,
    typeable,
    editable: !!canEdit && !!view.editable && !row.readOnly && typeable,
  };
}

const optionText = (o) => o.label || o.value;

/**
 * The layout: one entry per row the screen draws, each with its own fields in
 * the screen's order.
 *
 *   row    { id, key, nodeId, lineId, depth, name, label, code, hasChildren, fields }
 *   field  { key, kind, label, value, editable, ... }
 *     kind 'quantity' | 'total' | 'flow' | 'value' | 'na'
 *          ('na' is a dimension the row does not have: the grid still draws its
 *           slot, empty, so Thk · L · W line up — the sheet leaves it out)
 *     value      the text the screen shows in that cell
 *     editable   a person may type it (the line is open, the row is the order's own, the rule lets them)
 *   a 'value' field also carries
 *     code, name, unit, dataType
 *     state      'typed' (its own value) | 'default' (a default shown) | 'worked' (not typed here) | 'empty'
 *     input      the record's own typed value as the server takes it ('' when none; an option's id)
 *     missing    required and still empty — the amber cell
 *     why        why it is not typed, when it is not
 *     options    [{ id, text }] for a pick-list, as this row may choose
 */
export function orderSheetLayout({ root, view, codes = null }) {
  const rows = visibleRows(root);
  const { cols, records } = catalogOf(view);
  const uses = (node, code) => {
    const info = records.get(node.id);
    return !!info?.columns.get(code) && !!info.row.cells[code];
  };
  // Gaps are read on the rows a person can see: the order's own records, never a cut piece.
  const seen = new Set();
  const collect = (n) => { if (!isCutPiece(n)) seen.add(n.id); for (const k of n.children ?? []) collect(k); };
  collect(root);
  const missingOf = (node, code) => {
    const info = records.get(node.id);
    return !!info && info.own && seen.has(node.id) && !!info.row.cells[code]?.missing;
  };

  const used = cols.filter((c) => rows.some((r) => uses(r.node, c.code)));
  const byCode = new Map(cols.map((c) => [c.code, c]));
  const dims = used.some((c) => DIMS.has(c.code))
    ? DIMENSION_CODES.map((code) => byCode.get(code) ?? { code, name: code.charAt(0) + code.slice(1).toLowerCase(), unit: 'mm', dataType: 'number' })
    : [];
  const shown = [...dims, ...used.filter((c) => !DIMS.has(c.code))];
  const shownByCode = new Map(shown.map((c) => [c.code, c]));
  const open = !!view?.editable;

  const valueField = (r, code) => {
    const node = r.node;
    const head = shownByCode.get(code);
    const label = fieldLabel(code, head?.name, head?.unit);
    const info = records.get(node.id);
    const col = info?.columns.get(code);
    const raw = info?.row.cells[code];
    if (!col || !raw) return { key: code, kind: 'na', label, value: '', editable: false };
    const c = effective(view, col, info.row, raw, node.kind === 'temporary');
    const value = c.input === '' ? c.defaultDisplay ?? c.display ?? ''
      : col.dataType === 'option' ? (() => { const o = c.options?.find((x) => String(x.id) === c.input); return (o && (o.label || o.value)) || c.input; })()
        : col.dataType === 'boolean' ? (c.input === 'true' ? 'Yes' : 'No') : c.input;
    const state = !c.typeable ? 'worked' : c.input !== '' ? 'typed' : c.defaultDisplay != null ? 'default' : 'empty';
    return {
      key: code, kind: 'value', label, value: String(value), editable: c.editable,
      code, name: col.name, unit: col.unit ?? null, dataType: col.dataType, rule: c.rule, required: c.required,
      state, input: c.input, missing: missingOf(node, code),
      why: c.editable ? null : (info.row.readOnly ?? c.why ?? (node.kind !== 'temporary' ? 'It is not one of this order’s own rows.' : !open ? (view.lock?.message ?? 'This line no longer changes.') : null)),
      options: col.dataType === 'option' ? (c.options ?? []).map((o) => ({ id: o.id, text: optionText(o) })) : null,
    };
  };

  return rows.map((r) => {
    const n = r.node;
    const own = shown.filter((c) => {
      if (!uses(n, c.code)) return false;
      const gap = missingOf(n, c.code);
      if (c.code === 'SHIP_UNIT') {
        const input = records.get(n.id)?.row.cells[c.code]?.input ?? '';
        if (!(r.hasChildren || input !== '' || gap)) return false;
      }
      return !(HIDDEN_ON_GRID.has(c.code) && !gap);
    }).map((c) => c.code);
    const rest = own.filter((c) => !DIMS.has(c));
    const ordered = own.some((c) => DIMS.has(c)) ? [...DIMENSION_CODES, ...rest] : rest;
    const codesInOrder = [...ordered.filter((c) => !ROLLUPS.has(c)), ...ordered.filter((c) => ROLLUPS.has(c))];

    const lineEditable = open && !!r.parent && r.parent.kind === 'temporary' && n.lineId != null;
    const fields = [
      {
        key: QTY, kind: 'quantity', label: FIXED_LABELS[QTY], value: String(n.quantity), editable: lineEditable, dataType: 'number',
        why: lineEditable ? null : !r.parent ? 'It is the order line’s own quantity — change it on the order.'
          : !open ? (view?.lock?.message ?? 'This line no longer changes.')
            : `It sits inside ${r.parent.code ?? r.parent.name}’s own BOM, which is shared — change it on that record.`,
      },
      ...(Number(n.quantity) !== Number(n.total)
        ? [{ key: TOTAL, kind: 'total', label: FIXED_LABELS[TOTAL], value: String(n.total), editable: false, why: 'It is worked out from the quantities above this row.' }]
        : []),
      { key: FLOW, kind: 'flow', label: FIXED_LABELS[FLOW], value: n.flow?.code ?? '', editable: false, why: 'How a row is made is chosen on the screen, not in this sheet.' },
      ...codesInOrder.map((code) => valueField(r, code)),
    ];
    // A label names its field on the way back in, so two fields of one row may not share one.
    const count = new Map();
    for (const f of fields) if (f.kind !== 'na') count.set(f.label, (count.get(f.label) ?? 0) + 1);
    for (const f of fields) if (f.kind === 'value' && count.get(f.label) > 1) f.label = `${f.label} [${f.code}]`;
    return {
      id: pairId(n), key: n.key, nodeId: n.id, lineId: n.lineId, depth: n.depth,
      name: n.name, label: rowLabel(n.name, n.role), code: codeShown(n, codes), kind: n.kind, hasChildren: r.hasChildren, fields,
    };
  });
}
