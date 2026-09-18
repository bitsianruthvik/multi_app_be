/**
 * itemsImportService.js — bulk Item Catalog export/import via Excel.
 *
 * exportItemsTemplate — builds an .xlsx with a fill-in "Items" sheet
 *   (Category / Group / Sub-group columns), a read-only "Existing Taxonomy"
 *   reference sheet, and an "Instructions" sheet.
 *
 * importItemsExcel — parses the "Items" sheet and inserts catalog items.
 *   Category / Group / Sub-group are resolved by name (case-insensitive);
 *   any that don't already exist are created on the fly, preserving the
 *   Category → Group → Sub-group parent relationship from the row.
 */

import fs from 'fs';
import ExcelJS from 'exceljs';
import { pool } from '../../../db.js';
import { generateCode } from './codegenService.js';
import { fieldRegistry, setFields, resolveFields } from './fieldService.js';
import { mayHoldValue } from './fieldLadder.js';
import { PROCUREMENT_TYPES, autoCode } from './itemGuards.js';
import { catalogedForNew, procurementFor } from './catalogKind.js';

const CF_PREFIX = 'CF: ';

// ── helpers ───────────────────────────────────────────────────────────────────

function cellVal(row, col) {
  const c = row.getCell(col);
  if (c.value === null || c.value === undefined) return null;
  if (typeof c.value === 'object' && c.value.text)                 return String(c.value.text).trim();
  if (typeof c.value === 'object' && c.value.result !== undefined) return String(c.value.result).trim();
  return String(c.value).trim() || null;
}

function numVal(row, col) {
  const v = cellVal(row, col);
  if (v === null) return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
}

/** Returns a code guaranteed not to be in codeSet, adding it to the set. */
function uniqueCode(codeSet, name, maxLen = 20) {
  const code = autoCode(name, maxLen);
  if (!codeSet.has(code)) { codeSet.add(code); return code; }
  const base = autoCode(name, maxLen - 4); // leave room for "_NN" suffix
  let n = 2;
  let candidate = `${base}_${n}`;
  while (codeSet.has(candidate)) { n++; candidate = `${base}_${n}`; }
  codeSet.add(candidate);
  return candidate;
}

function styledHeader(ws, cols) {
  ws.addRow(cols.map((c) => c.header));
  const row = ws.getRow(1);
  row.font      = { bold: true, color: { argb: 'FFFFFFFF' } };
  row.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } };
  row.alignment = { vertical: 'middle', horizontal: 'center' };
  row.height    = 20;
  cols.forEach((c, i) => { ws.getColumn(i + 1).width = c.width ?? 20; });
}

function dropdown(ws, col, list, fromRow, toRow) {
  for (let r = fromRow; r <= toRow; r++) {
    ws.getCell(r, col).dataValidation = { type: 'list', allowBlank: true, formulae: [`"${list.join(',')}"`] };
  }
}

/** Same as dropdown(), but the list comes from a cell range (e.g. another sheet) rather than an inline literal. */
function dropdownFromRange(ws, col, rangeRef, fromRow, toRow) {
  for (let r = fromRow; r <= toRow; r++) {
    ws.getCell(r, col).dataValidation = {
      type: 'list', allowBlank: true, showErrorMessage: false, formulae: [rangeRef],
    };
  }
}

/** 1 -> "A", 27 -> "AA". Excel column letters for a defined-name range string. */
function colLetter(n) {
  let s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

/**
 * A valid, unique Excel defined name for one taxonomy list. Only strips the
 * characters the paired lookup formula (SUBSTITUTE of spaces, see
 * dropdownIndirect) can remove itself — a name built from text with other
 * punctuation won't round-trip through that formula, so its cascading
 * dropdown falls back to the flat list instead of resolving to a name
 * nothing points at. That is the intended degradation, not a bug: better a
 * dropdown that shows every value than one that silently shows none.
 */
function definedNameFor(prefix, text, used) {
  const base = `${prefix}${String(text).trim().replace(/[^A-Za-z0-9_]/g, '_')}`.slice(0, 200) || `${prefix}X`;
  let name = base;
  let n = 2;
  while (used.has(name.toLowerCase())) { name = `${base}_${n}`; n += 1; }
  used.add(name.toLowerCase());
  return name;
}

/**
 * A cascading dropdown: which values are legal depends on another cell in
 * the SAME row (that row's own Category, for the Group column; its own
 * Group, for the Sub-group column). `INDIRECT` resolves a defined name built
 * from that cell's text; `IFERROR` falls back to the flat range whenever the
 * text doesn't resolve to one — blank, mid-edit, or a name `definedNameFor`
 * couldn't build cleanly.
 */
function dropdownIndirect(ws, col, refCol, prefix, fallbackRange, fromRow, toRow) {
  const refLetter = colLetter(refCol);
  for (let r = fromRow; r <= toRow; r++) {
    const formula = `IFERROR(INDIRECT("${prefix}"&SUBSTITUTE($${refLetter}${r}," ","_")),${fallbackRange})`;
    ws.getCell(r, col).dataValidation = {
      type: 'list', allowBlank: true, showErrorMessage: false, formulae: [formula],
    };
  }
}

// ── export ────────────────────────────────────────────────────────────────────

export async function exportItemsTemplate(companyId) {
  const wb = new ExcelJS.Workbook();

  // ── Taxonomy, fetched up front so both the Items sheet's dropdowns and the
  //    Existing Taxonomy reference sheet can use it ─────────────────────────
  const [categories] = await pool.query(
    'SELECT id, name FROM fab_item_categories WHERE company_id = ? AND deleted_at IS NULL ORDER BY name',
    [companyId],
  );
  const [groups] = await pool.query(
    `SELECT g.id, g.name, c.name AS category_name
       FROM fab_item_groups g JOIN fab_item_categories c ON c.id = g.category_id
      WHERE g.company_id = ? AND g.deleted_at IS NULL ORDER BY c.name, g.name`,
    [companyId],
  );
  const [subgroups] = await pool.query(
    `SELECT s.name, g.name AS group_name, c.name AS category_name
       FROM fab_item_subgroups s
       JOIN fab_item_groups g     ON g.id = s.group_id
       JOIN fab_item_categories c ON c.id = g.category_id
      WHERE s.company_id = ? AND s.deleted_at IS NULL ORDER BY c.name, g.name, s.name`,
    [companyId],
  );

  // ── Sheet 1: Items (fill-in template) ────────────────────────────────────
  const ws = wb.addWorksheet('Items');
  const cols = [
    { header: 'Item Name *',      width: 28 },
    { header: 'Item Code',        width: 18 },
    { header: 'Unit',             width: 10 },
    { header: 'Category',         width: 20 },
    { header: 'Group',            width: 20 },
    { header: 'Sub-group',        width: 20 },
    { header: 'Procurement Type', width: 16 },
    { header: 'Description',      width: 30 },
    { header: 'HSN Code',         width: 14 },
    { header: 'Lead Time (Days)', width: 14 },
  ];

  // The CF columns come from the field REGISTRY (fab_fields), not from values
  // that happen to exist. Reading them out of the value store meant a field
  // nobody had filled in yet had no column, so the template could never be the
  // way to populate it for the first time — the schema was being derived from
  // the data. `applies_at` decides which fields a catalog item may carry at
  // all; offering one it cannot hold would only earn a rejection on import,
  // since writes now validate.
  const { rows: fieldDefs } = await fieldRegistry(companyId);
  const cfKeys = fieldDefs.filter((f) => mayHoldValue(f, 'catalog_item'));
  for (const cf of cfKeys) cols.push({ header: `${CF_PREFIX}${cf.fieldKey}`, width: 18 });

  styledHeader(ws, cols);

  /*
   * THE CURRENT CATALOG, so the export is something to review and re-import
   * rather than a blank form every time. Re-importing it unmodified with
   * `mode=upsert` is then a no-op; editing a cell and re-importing corrects
   * that one item. `mode=append` (the default) still skips these rows, since
   * their codes already exist — exporting them does not risk duplicating them.
   * Queried before the example row below, which reuses this to name a
   * taxonomy that actually exists.
   */
  const [catalogItems] = await pool.query(
    `SELECT c.id, c.name, c.code, c.unit, c.description, c.hsn_code AS hsnCode,
            c.lead_time_days AS leadTimeDays, COALESCE(c.procurement_type, 'buy') AS procurementType,
            cat.name AS categoryName, g.name AS groupName, sg.name AS subgroupName
       FROM fab_item_catalog c
       LEFT JOIN fab_item_categories cat ON cat.id = c.category_id
       LEFT JOIN fab_item_groups g ON g.id = c.group_id
       LEFT JOIN fab_item_subgroups sg ON sg.id = c.subgroup_id
      WHERE c.company_id = ? AND c.deleted_at IS NULL
      ORDER BY c.code`,
    [companyId],
  );

  /*
   * The example row's taxonomy must name something that actually exists —
   * a hand-typed guess here ("Raw Material" vs the real "Raw Materials")
   * used to spawn a duplicate category plus a junk item the first time
   * someone imported the template unmodified. Prefer the taxonomy of a real
   * catalog item (so category/group/subgroup are a coherent, already-linked
   * triple) and fall back to "Raw Materials" only when the catalog is empty.
   * The code `EXAMPLE-ROW` is what `importItemsExcel` matches on to skip
   * this row outright, so it is inert even if never deleted.
   */
  const itemWithCategory = catalogItems.find((it) => it.categoryName);
  const exampleTaxonomy = itemWithCategory
    ? [itemWithCategory.categoryName || '', itemWithCategory.groupName || '', itemWithCategory.subgroupName || '']
    : [categories.some((c) => c.name === 'Raw Materials') ? 'Raw Materials' : '', '', ''];

  const exampleRow = [
    'Structural Steel Bar 50x50', 'EXAMPLE-ROW', 'kg',
    ...exampleTaxonomy,
    'buy',
    'Example row — skipped automatically on import, delete or leave as-is', '', 5,
  ];
  for (let i = 0; i < cfKeys.length; i++) exampleRow.push('');
  ws.addRow(exampleRow);
  ws.getRow(2).font = { italic: true, color: { argb: 'FF999999' } };

  const cfValuesByItem = cfKeys.length && catalogItems.length
    ? await resolveFields(companyId, catalogItems.map((c) => ({ scope: 'catalog_item', scopeId: c.id })))
    : new Map();
  for (const it of catalogItems) {
    const row = [
      it.name, it.code, it.unit, it.categoryName || '', it.groupName || '', it.subgroupName || '',
      it.procurementType, it.description || '', it.hsnCode || '', it.leadTimeDays ?? '',
    ];
    const resolved = cfValuesByItem.get(`catalog_item:${it.id}`) ?? {};
    for (const cf of cfKeys) {
      const v = resolved[cf.fieldKey]?.value;
      // `resolveFields` renders a bool field as a JS true/false — write it
      // back as the canonical yes/no spelling the importer's own validator
      // requires, or a re-import of this exact export rejects every boolean
      // custom field it just wrote (a real gap this closed, not theoretical:
      // exporting the current catalog and re-importing it unmodified is
      // exactly the `mode=upsert` workflow this item exists for).
      row.push(cf.dataType === 'bool' ? (v == null ? '' : (v ? 'yes' : 'no')) : (v ?? ''));
    }
    ws.addRow(row);
  }

  // Enough rows for every exported item plus room to add more by hand.
  const lastDataRow = Math.max(1000, catalogItems.length + 20);
  dropdown(ws, 7, PROCUREMENT_TYPES, 2, lastDataRow);

  // ── Hidden "Lists" sheet backing the Category / Group / Sub-group dropdowns
  //    on the Items sheet — a plain (non-cascading) list of every name that
  //    currently exists for this company, kept off to the side so it doesn't
  //    clutter the fill-in sheet. Data validation still lets the user type a
  //    brand-new name — new taxonomy is created automatically on import.
  const wsLists = wb.addWorksheet('Lists', { state: 'veryHidden' });
  wsLists.getCell(1, 1).value = 'Category';
  wsLists.getCell(1, 2).value = 'Group';
  wsLists.getCell(1, 3).value = 'Sub-group';
  categories.forEach((c, i) => { wsLists.getCell(i + 2, 1).value = c.name; });
  const uniqueGroupNames    = [...new Set(groups.map((g) => g.name))];
  const uniqueSubgroupNames = [...new Set(subgroups.map((s) => s.name))];
  uniqueGroupNames.forEach((n, i)    => { wsLists.getCell(i + 2, 2).value = n; });
  uniqueSubgroupNames.forEach((n, i) => { wsLists.getCell(i + 2, 3).value = n; });

  if (categories.length > 0) {
    dropdownFromRange(ws, 4, `Lists!$A$2:$A$${categories.length + 1}`, 2, lastDataRow);
  }

  /*
   * CASCADING Group / Sub-group (item 2). The flat lists above let a person
   * pick a sub-group that belongs to a completely different group — nothing
   * on the sheet said no, and the import used to create a second, wrongly-
   * parented entry with the same name rather than catch it. A named range
   * per category (its groups) and per group (its sub-groups), addressed by
   * INDIRECT off the row's own Category/Group cell, narrows what Excel even
   * offers; `importItemsExcel`'s TAXONOMY_MISMATCH check is the backstop for
   * anyone who types past the dropdown anyway.
   *
   * Sub-group lists are keyed by GROUP NAME, not group id: the Group column
   * is free text, so two categories that both happen to have a group named
   * "Fasteners" share one dropdown listing sub-groups from both — a real
   * limitation of a name-only cascade, not something this sheet can resolve
   * without a hidden id column a person would have to keep in sync by hand.
   */
  const definedNameSet = new Set();
  const groupsByCategory = new Map();
  for (const g of groups) {
    if (!groupsByCategory.has(g.category_name)) groupsByCategory.set(g.category_name, []);
    groupsByCategory.get(g.category_name).push(g.name);
  }
  const subgroupsByGroupName = new Map();
  for (const s of subgroups) {
    if (!subgroupsByGroupName.has(s.group_name)) subgroupsByGroupName.set(s.group_name, []);
    subgroupsByGroupName.get(s.group_name).push(s.name);
  }

  let nextListCol = 3; // columns A/B/C already hold the flat lists above
  for (const [categoryName, names] of groupsByCategory) {
    const values = [...new Set(names)];
    if (!values.length) continue;
    const col = ++nextListCol;
    wsLists.getCell(1, col).value = `Groups: ${categoryName}`;
    values.forEach((n, i) => { wsLists.getCell(i + 2, col).value = n; });
    wb.definedNames.add(
      `Lists!$${colLetter(col)}$2:$${colLetter(col)}$${values.length + 1}`,
      definedNameFor('CAT_', categoryName, definedNameSet),
    );
  }
  for (const [groupName, names] of subgroupsByGroupName) {
    const values = [...new Set(names)];
    if (!values.length) continue;
    const col = ++nextListCol;
    wsLists.getCell(1, col).value = `Sub-groups: ${groupName}`;
    values.forEach((n, i) => { wsLists.getCell(i + 2, col).value = n; });
    wb.definedNames.add(
      `Lists!$${colLetter(col)}$2:$${colLetter(col)}$${values.length + 1}`,
      definedNameFor('GRP_', groupName, definedNameSet),
    );
  }

  if (uniqueGroupNames.length > 0) {
    dropdownIndirect(ws, 5, 4, 'CAT_', `Lists!$B$2:$B$${uniqueGroupNames.length + 1}`, 2, lastDataRow);
  }
  if (uniqueSubgroupNames.length > 0) {
    dropdownIndirect(ws, 6, 5, 'GRP_', `Lists!$C$2:$C$${uniqueSubgroupNames.length + 1}`, 2, lastDataRow);
  }

  // ── Sheet 2: Existing Taxonomy (reference) ──────────────────────────────
  const wsTax = wb.addWorksheet('Existing Taxonomy');
  styledHeader(wsTax, [
    { header: 'Level',           width: 14 },
    { header: 'Name',            width: 24 },
    { header: 'Parent Category', width: 24 },
    { header: 'Parent Group',    width: 24 },
  ]);

  for (const c of categories) wsTax.addRow(['Category',  c.name, '', '']);
  for (const g of groups)     wsTax.addRow(['Group',     g.name, g.category_name, '']);
  for (const s of subgroups)  wsTax.addRow(['Sub-group', s.name, s.category_name, s.group_name]);

  // ── Sheet 3: Instructions ────────────────────────────────────────────────
  const wsHelp = wb.addWorksheet('Instructions');
  wsHelp.getColumn(1).width = 100;
  const lines = [
    'How to use this template',
    '',
    '1. Fill in rows on the "Items" sheet. Delete the example row (row 2) before importing.',
    '2. "Item Name" is required. "Item Code" is optional — auto-generated from the name if left blank.',
    '3. Category / Group / Sub-group — type the exact name. If a name does not already exist for',
    '   this company, it will be created automatically when you import.',
    '4. A Group must have a Category in the same row. A Sub-group must have a Group in the same row.',
    '   If the parent is missing, that level is skipped for the row (the item is still created).',
    '5. Procurement Type: buy or make (default: buy).',
    '6. See the "Existing Taxonomy" sheet for Category / Group / Sub-group names already in use —',
    '   reuse them exactly to avoid creating near-duplicate entries.',
    '7. If an Item Code already exists, that row is skipped (existing items are never overwritten by import).',
    '8. Columns titled "CF: <name>" are existing item-level custom fields for this company — fill in a',
    '    value per row to set that custom field on the imported item. Leave blank to skip it for that row.',
  ];
  lines.forEach((l) => wsHelp.addRow([l]));
  wsHelp.getRow(1).font = { bold: true, size: 13 };

  return wb.xlsx.writeBuffer();
}

// ── import report ────────────────────────────────────────────────────────────

/** Builds a per-row status log as an .xlsx buffer — what got imported, what was skipped, and why. */
async function buildImportReport(rowLog) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Import Log');
  styledHeader(ws, [
    { header: 'Row',        width: 8 },
    { header: 'Item Name',  width: 28 },
    { header: 'Code',       width: 18 },
    { header: 'Category',   width: 20 },
    { header: 'Group',      width: 20 },
    { header: 'Sub-group',  width: 20 },
    { header: 'Status',     width: 12 },
    { header: 'Reason',     width: 40 },
  ]);
  for (const r of rowLog) {
    ws.addRow([r.row, r.name, r.code, r.categoryName, r.groupName, r.subgroupName, r.status, r.reason]);
    const excelRow = ws.lastRow;
    const fill = r.status === 'Created'
      ? { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE6F4EA' } }
      : { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFCE8E6' } };
    excelRow.eachCell((cell) => { cell.fill = fill; });
  }
  return wb.xlsx.writeBuffer();
}

// ── import ────────────────────────────────────────────────────────────────────

/**
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun] parse, resolve and validate every row —
 *   including creating any taxonomy the sheet implies, so a later apply sees
 *   exactly what the dry run saw — then ROLL BACK instead of committing.
 *   Returns `{ problems, wouldInsert, wouldUpdate, wouldSkip }` instead of the
 *   normal `result` shape.
 * @param {'append'|'upsert'} [opts.mode] `append` (default): a row whose code
 *   already exists is skipped, as before. `upsert`: that row UPDATES the
 *   existing item instead (fields + custom field values); it never creates a
 *   second row for a code already in the catalog.
 */
export async function importItemsExcel(file, companyId, opts = {}) {
  const { dryRun = false, mode = 'append' } = opts;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file.path);
  fs.unlinkSync(file.path);

  const ws = wb.getWorksheet('Items');
  if (!ws) throw new Error('Sheet "Items" not found in the uploaded file. Use the exported template.');

  // CF: <key> columns can appear anywhere past the standard columns — find them by header text.
  const headerRow = ws.getRow(1);
  const cfColumns = []; // { col, fieldKey }
  headerRow.eachCell((cell, colNumber) => {
    const text = cell.value && (cell.value.text || cell.value.result || cell.value);
    const header = text === null || text === undefined ? '' : String(text).trim();
    if (header.startsWith(CF_PREFIX)) {
      cfColumns.push({ col: colNumber, fieldKey: header.slice(CF_PREFIX.length).trim() });
    }
  });

  // Collect rows synchronously first (ExcelJS eachRow callback is sync).
  const rows = [];
  ws.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return; // header
    const name = cellVal(row, 1);
    if (!name) return; // blank row
    rows.push({
      rowNumber,
      name,
      code:             cellVal(row, 2),
      unit:             cellVal(row, 3) || 'pcs',
      categoryName:     cellVal(row, 4),
      groupName:        cellVal(row, 5),
      subgroupName:     cellVal(row, 6),
      procurementRaw:   (cellVal(row, 7) || '').toLowerCase(),
      description:      cellVal(row, 8),
      hsnCode:           cellVal(row, 9),
      leadTimeDays:      numVal(row, 10),
      customFields: cfColumns.map((cf) => ({ fieldKey: cf.fieldKey, value: cellVal(row, cf.col) })),
    });
  });

  const result = {
    itemsCreated: 0, itemsUpdated: 0, itemsSkipped: 0,
    categoriesCreated: 0, groupsCreated: 0, subgroupsCreated: 0,
    warnings: [],
    rowLog: [], // one entry per data row — backs the downloadable import report
    problems: [], // one entry per row that will NOT insert cleanly — dry-run's real output
  };

  const conn = await pool.getConnection();
  /** Shared across every row's `generateCode` call — see the call site below. */
  const ctxCache = new Map();
  try {
    await conn.beginTransaction();

    // ── preload the field registry ─────────────────────────────────────────
    // Definitions, not values: a key is known because it is declared in
    // fab_fields, not because some other item already carries it. The type is
    // only for the message a rejected column gets below — setFields does the
    // actual typing and validation on write.
    const { rows: fieldDefs } = await fieldRegistry(companyId, conn);
    const cfTypeByKey = new Map(fieldDefs.map((f) => [f.fieldKey, f.dataType]));

    // ── preload existing taxonomy + codes ──────────────────────────────────
    const [existingCats] = await conn.query(
      'SELECT id, name, code FROM fab_item_categories WHERE company_id = ? AND deleted_at IS NULL',
      [companyId],
    );
    const categoryCache = new Map(existingCats.map((c) => [c.name.toLowerCase(), c.id]));
    const categoryCodeSet = new Set(existingCats.map((c) => c.code.toUpperCase()));
    const categoryNameById = new Map(existingCats.map((c) => [c.id, c.name]));

    const [existingGroups] = await conn.query(
      'SELECT id, name, code, category_id FROM fab_item_groups WHERE company_id = ? AND deleted_at IS NULL',
      [companyId],
    );
    const groupCache = new Map(existingGroups.map((g) => [`${g.category_id}::${g.name.toLowerCase()}`, g.id]));
    const groupCodeSetByCategory = new Map();
    const groupNameById = new Map(existingGroups.map((g) => [g.id, g.name]));
    /**
     * Group NAME -> every category id it already lives under (item 2). A
     * group is scoped by (categoryId, name), so the same name can legally
     * exist under two categories — but a row naming a group that exists
     * ONLY under some other category is not a second, coincidental group of
     * the same name, it is someone who picked the wrong entry off a flat,
     * unscoped dropdown. Reported as TAXONOMY_MISMATCH instead of silently
     * creating a duplicate under the category the row happens to state.
     */
    const groupParentByName = new Map();
    for (const g of existingGroups) {
      if (!groupCodeSetByCategory.has(g.category_id)) groupCodeSetByCategory.set(g.category_id, new Set());
      groupCodeSetByCategory.get(g.category_id).add(g.code.toUpperCase());
      const nameKey = g.name.toLowerCase();
      if (!groupParentByName.has(nameKey)) groupParentByName.set(nameKey, new Set());
      groupParentByName.get(nameKey).add(g.category_id);
    }

    const [existingSubgroups] = await conn.query(
      'SELECT id, name, code, group_id FROM fab_item_subgroups WHERE company_id = ? AND deleted_at IS NULL',
      [companyId],
    );
    const subgroupCache = new Map(existingSubgroups.map((s) => [`${s.group_id}::${s.name.toLowerCase()}`, s.id]));
    const subgroupCodeSetByGroup = new Map();
    // Sub-group NAME -> every group id it already lives under — same
    // reasoning as groupParentByName, one level down.
    const subgroupParentByName = new Map();
    for (const s of existingSubgroups) {
      if (!subgroupCodeSetByGroup.has(s.group_id)) subgroupCodeSetByGroup.set(s.group_id, new Set());
      subgroupCodeSetByGroup.get(s.group_id).add(s.code.toUpperCase());
      const nameKey = s.name.toLowerCase();
      if (!subgroupParentByName.has(nameKey)) subgroupParentByName.set(nameKey, new Set());
      subgroupParentByName.get(nameKey).add(s.group_id);
    }

    const [existingItems] = await conn.query(
      'SELECT id, code FROM fab_item_catalog WHERE company_id = ? AND deleted_at IS NULL',
      [companyId],
    );
    const itemCodeSet = new Set(existingItems.map((r) => r.code.toUpperCase()));
    // code -> id, for `mode: 'upsert'` — an existing code updates that row
    // instead of being skipped.
    const itemIdByCode = new Map(existingItems.map((r) => [r.code.toUpperCase(), r.id]));

    // ── resolvers (get-or-create) ───────────────────────────────────────────
    async function resolveCategory(name) {
      const key = name.trim().toLowerCase();
      if (categoryCache.has(key)) return categoryCache.get(key);
      const code = uniqueCode(categoryCodeSet, name);
      const [res] = await conn.query(
        'INSERT INTO fab_item_categories (company_id, name, code) VALUES (?,?,?)',
        [companyId, name.trim(), code],
      );
      categoryCache.set(key, res.insertId);
      categoryNameById.set(res.insertId, name.trim());
      result.categoriesCreated++;
      return res.insertId;
    }

    async function resolveGroup(categoryId, name) {
      const key = `${categoryId}::${name.trim().toLowerCase()}`;
      if (groupCache.has(key)) return groupCache.get(key);
      if (!groupCodeSetByCategory.has(categoryId)) groupCodeSetByCategory.set(categoryId, new Set());
      const code = uniqueCode(groupCodeSetByCategory.get(categoryId), name);
      const [res] = await conn.query(
        'INSERT INTO fab_item_groups (company_id, category_id, name, code) VALUES (?,?,?,?)',
        [companyId, categoryId, name.trim(), code],
      );
      groupCache.set(key, res.insertId);
      groupNameById.set(res.insertId, name.trim());
      // A row later in the SAME file naming this group under a different
      // category must see it as taken too, not just rows against the DB
      // state as of the start of the import.
      const nameKey = name.trim().toLowerCase();
      if (!groupParentByName.has(nameKey)) groupParentByName.set(nameKey, new Set());
      groupParentByName.get(nameKey).add(categoryId);
      result.groupsCreated++;
      return res.insertId;
    }

    async function resolveSubgroup(groupId, name) {
      const key = `${groupId}::${name.trim().toLowerCase()}`;
      if (subgroupCache.has(key)) return subgroupCache.get(key);
      if (!subgroupCodeSetByGroup.has(groupId)) subgroupCodeSetByGroup.set(groupId, new Set());
      const code = uniqueCode(subgroupCodeSetByGroup.get(groupId), name);
      const [res] = await conn.query(
        'INSERT INTO fab_item_subgroups (company_id, group_id, name, code) VALUES (?,?,?,?)',
        [companyId, groupId, name.trim(), code],
      );
      subgroupCache.set(key, res.insertId);
      const nameKey = name.trim().toLowerCase();
      if (!subgroupParentByName.has(nameKey)) subgroupParentByName.set(nameKey, new Set());
      subgroupParentByName.get(nameKey).add(groupId);
      result.subgroupsCreated++;
      return res.insertId;
    }



    // ── process rows ─────────────────────────────────────────────────────────
    for (const r of rows) {
      const rowBase = {
        row: r.rowNumber, name: r.name, code: r.code || '',
        categoryName: r.categoryName || '', groupName: r.groupName || '', subgroupName: r.subgroupName || '',
      };

      let code = r.code ? r.code.trim().toUpperCase() : null;
      // The template's own example row (code EXAMPLE-ROW, item 3 of the
      // static review) — never imported, whether or not the user deleted it,
      // and regardless of mode/dry-run: leaving it in used to spawn a
      // duplicate category (a hand-typed taxonomy guess) plus a junk item.
      if (code === 'EXAMPLE-ROW') {
        const message = 'Example row from the template — skipped automatically.';
        result.warnings.push({ row: r.rowNumber, message });
        result.problems.push({ row: r.rowNumber, code: 'EXAMPLE_ROW_SKIPPED', reason: message });
        result.itemsSkipped++;
        result.rowLog.push({ ...rowBase, status: 'Skipped', reason: message });
        continue;
      }
      let existingItemId = null;
      if (code && itemCodeSet.has(code)) {
        if (mode !== 'upsert') {
          const message = `Item code '${code}' already exists — row skipped.`;
          result.warnings.push({ row: r.rowNumber, message });
          result.problems.push({ row: r.rowNumber, code, reason: message });
          result.itemsSkipped++;
          result.rowLog.push({ ...rowBase, status: 'Skipped', reason: message });
          continue;
        }
        // upsert: this row updates the existing row rather than being skipped.
        existingItemId = itemIdByCode.get(code) ?? null;
        if (!existingItemId) {
          // The code was in the sheet twice (added to itemCodeSet by an earlier
          // row in THIS import) rather than pre-existing — still a duplicate,
          // still not creatable, and upsert has no earlier DB row to update.
          const message = `Item code '${code}' is duplicated within this file — row skipped.`;
          result.warnings.push({ row: r.rowNumber, message });
          result.problems.push({ row: r.rowNumber, code, reason: message });
          result.itemsSkipped++;
          result.rowLog.push({ ...rowBase, status: 'Skipped', reason: message });
          continue;
        }
      }
      if (code) itemCodeSet.add(code);

      if (!r.categoryName) {
        const message = `Category is required — row skipped.`;
        result.warnings.push({ row: r.rowNumber, message });
        result.itemsSkipped++;
        result.rowLog.push({ ...rowBase, status: 'Skipped', reason: message });
        continue;
      }

      const categoryId = await resolveCategory(r.categoryName);

      // TAXONOMY_MISMATCH (item 2): a Group name that already belongs to a
      // DIFFERENT category — the exact shape a flat, unscoped dropdown lets
      // someone pick by mistake. Reported and skipped rather than silently
      // minting a second, wrongly-parented group with the same name.
      if (r.groupName) {
        const owners = groupParentByName.get(r.groupName.trim().toLowerCase());
        if (owners && !owners.has(categoryId)) {
          const ownerNames = [...owners].map((id) => categoryNameById.get(id)).filter(Boolean).join(', ');
          const message = `Group "${r.groupName}" already exists under ${ownerNames || 'a different category'}, not "${r.categoryName}".`;
          result.warnings.push({ row: r.rowNumber, message });
          result.problems.push({ row: r.rowNumber, code: 'TAXONOMY_MISMATCH', reason: message });
          result.itemsSkipped++;
          result.rowLog.push({ ...rowBase, status: 'Skipped', reason: message });
          continue;
        }
      }

      /**
       * A BLANK GROUP MEANS NO GROUP — it does not mean "invent one".
       *
       * This used to mint a group literally named "Default" (and a sub-group
       * under it) whenever the sheet left the column blank, which at import
       * scale produced one per category in a single upload. Nobody asked for
       * them, and because the taxonomy is what scopes field definitions, an item
       * parked under "Default" silently inherits anything later attached there.
       *
       * NULL is the supported state: the columns are nullable with no FK, the
       * field ladder's `parentOf('catalog_item')` already falls through a null
       * group straight to the category, and every join against these columns is
       * a LEFT join. It is also what rule 7 of this importer's own instructions
       * has always promised — a missing parent skips that level and still
       * creates the item.
       *
       * A sub-group cannot outlive its group (`group_id` is NOT NULL), so a
       * sheet naming one without a group gets the sub-group skipped and a
       * warning, rather than a fabricated parent to hang it from.
       */
      const groupId = r.groupName ? await resolveGroup(categoryId, r.groupName) : null;
      let subgroupId = null;
      if (r.subgroupName) {
        if (groupId) {
          // Same TAXONOMY_MISMATCH check, one level down: a Sub-group name
          // that already belongs to a different Group.
          const subOwners = subgroupParentByName.get(r.subgroupName.trim().toLowerCase());
          if (subOwners && !subOwners.has(groupId)) {
            const ownerNames = [...subOwners].map((id) => groupNameById.get(id)).filter(Boolean).join(', ');
            const message = `Sub-group "${r.subgroupName}" already exists under ${ownerNames || 'a different group'}, not "${r.groupName}".`;
            result.warnings.push({ row: r.rowNumber, message });
            result.problems.push({ row: r.rowNumber, code: 'TAXONOMY_MISMATCH', reason: message });
            result.itemsSkipped++;
            result.rowLog.push({ ...rowBase, status: 'Skipped', reason: message });
            continue;
          }
          subgroupId = await resolveSubgroup(groupId, r.subgroupName);
        } else {
          const message = `Sub-group '${r.subgroupName}' needs a Group — sub-group left unset for this row.`;
          result.warnings.push({ row: r.rowNumber, message });
        }
      }

      if (!code) {
        // No code in the spreadsheet — use the company's configured item code rule
        // (falls back to a sensible default when none is configured), retrying on
        // the rare collision against codes already used elsewhere in this import.
        //
        // `conn` — the import's own transaction, not a second pool connection.
        // Without it, every code issued here committed on its own connection
        // immediately, so a later row's failure rolled back the items but not
        // the sequence numbers already consumed for them — a permanent gap
        // every time an import partially failed. `ctxCache` shares taxonomy
        // shortform lookups across the whole file instead of one query per row.
        do {
          code = (await generateCode(companyId, 'item', { categoryId }, conn, ctxCache)).toUpperCase();
        } while (itemCodeSet.has(code));
        itemCodeSet.add(code);
      }

      let procurementType = 'buy';
      const rowNotes = [];
      if (r.procurementRaw) {
        if (PROCUREMENT_TYPES.includes(r.procurementRaw)) procurementType = r.procurementRaw;
        else {
          const message = `Unrecognised Procurement Type — defaulted to 'buy'.`;
          result.warnings.push({ row: r.rowNumber, message });
          rowNotes.push(message);
        }
      }

      let itemId;
      if (existingItemId) {
        // The catalog sheet is for CATALOG items. A code that belongs to a
        // template part or a cut plate is not this sheet's to overwrite —
        // re-importing one with an empty Procurement cell used to flip it to
        // 'buy', making a cut plate purchasable.
        const [[kind]] = await conn.query(
          `SELECT is_cataloged FROM fab_item_catalog WHERE id = ? AND company_id = ? LIMIT 1`,
          [existingItemId, companyId],
        );
        if (kind && Number(kind.is_cataloged) === 0) {
          const message = `Code ${code} is a template part or cut plate, not a catalog item — row skipped.`;
          result.warnings.push({ row: r.rowNumber, message });
          result.rowLog.push({ ...rowBase, status: 'Skipped', reason: message });
          continue;
        }
        // upsert: the code was already the catalog's, so this row corrects
        // that row rather than minting another with the same code.
        await conn.query(
          `UPDATE fab_item_catalog
              SET name = ?, unit = ?, description = ?, category_id = ?, group_id = ?, subgroup_id = ?,
                  procurement_type = ?, hsn_code = ?, lead_time_days = ?, updated_at = UTC_TIMESTAMP()
            WHERE id = ? AND company_id = ? AND deleted_at IS NULL`,
          [r.name.trim(), r.unit, r.description || null, categoryId, groupId, subgroupId,
           procurementType, r.hsnCode || null, r.leadTimeDays, existingItemId, companyId],
        );
        result.itemsUpdated++;
        itemId = existingItemId;
      } else {
        // Stamped from the category, like every other way an item is created.
        const isCataloged = await catalogedForNew(conn, companyId, { categoryId });
        const [insertRes] = await conn.query(
          `INSERT INTO fab_item_catalog
             (company_id, name, code, unit, description, category_id, group_id, subgroup_id,
              procurement_type, hsn_code, lead_time_days, is_cataloged)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          [companyId, r.name.trim(), code, r.unit, r.description || null, categoryId, groupId, subgroupId,
           procurementFor(isCataloged, procurementType), r.hsnCode || null, r.leadTimeDays, isCataloged],
        );
        result.itemsCreated++;
        itemId = insertRes.insertId;
      }

      // The value store moved to fab_field_values, written through setFields
      // rather than by INSERT: it validates (unknown key, wrong scope, non-
      // number into a number field), canonicalises enum spelling and upserts,
      // so re-importing a row updates its values instead of duplicating them.
      // It takes the transaction connection, so values roll back with the item.
      // Sort order is no longer written per value — it belongs to the field.
      const cfValues = Object.fromEntries(
        r.customFields
          .filter((cf) => cf.value !== null && cf.value !== undefined && cf.value !== '')
          .map((cf) => [cf.fieldKey, cf.value]),
      );
      if (Object.keys(cfValues).length) {
        const { rejected } = await setFields(companyId, 'catalog_item', itemId, cfValues, conn);
        // setFields returns rejections instead of throwing, so they have to be
        // surfaced here or the value is dropped in silence — reported like any
        // other per-row problem: a warning plus a note on the row's log entry,
        // with the item itself still created.
        for (const rej of rejected) {
          const declared = cfTypeByKey.get(rej.fieldKey);
          const message = `Custom field '${rej.fieldKey}'${declared ? ` (${declared})` : ''} not set — ${rej.why}.`;
          result.warnings.push({ row: r.rowNumber, message });
          result.problems.push({ row: r.rowNumber, code, reason: message });
          rowNotes.push(message);
        }
      }

      result.rowLog.push({
        ...rowBase, code, status: existingItemId ? 'Updated' : 'Created',
        reason: rowNotes.join(' ') || '',
      });
    }

    if (dryRun) {
      // Everything above ran for real against this connection so the same
      // categories/groups/subgroups the sheet implies were resolved exactly as
      // an apply would see them — then discarded. Nothing the caller asked
      // NOT to write gets written.
      await conn.rollback();
      return {
        problems: result.problems,
        wouldInsert: result.itemsCreated,
        wouldUpdate: result.itemsUpdated,
        wouldSkip: result.itemsSkipped,
      };
    }

    await conn.commit();
    result.reportBase64 = (await buildImportReport(result.rowLog)).toString('base64');
    delete result.rowLog;
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}
