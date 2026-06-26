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

const MATERIAL_TYPES    = ['raw_material', 'component', 'semi_finished', 'finished_good'];
const PROCUREMENT_TYPES = ['buy', 'make'];
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

function autoCode(name, maxLen = 20) {
  const c = (name || '').trim().toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, maxLen);
  return c || 'CODE';
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

// ── export ────────────────────────────────────────────────────────────────────

export async function exportItemsTemplate(companyId) {
  const wb = new ExcelJS.Workbook();

  // ── Sheet 1: Items (fill-in template) ────────────────────────────────────
  const ws = wb.addWorksheet('Items');
  const cols = [
    { header: 'Item Name *',      width: 28 },
    { header: 'Item Code',        width: 18 },
    { header: 'Unit',             width: 10 },
    { header: 'Category',         width: 20 },
    { header: 'Group',            width: 20 },
    { header: 'Sub-group',        width: 20 },
    { header: 'Material Type',    width: 16 },
    { header: 'Procurement Type', width: 16 },
    { header: 'Description',      width: 30 },
    { header: 'HSN Code',         width: 14 },
    { header: 'Division',         width: 14 },
    { header: 'Lead Time (Days)', width: 14 },
    { header: 'Gross Weight',     width: 14 },
    { header: 'Net Weight',       width: 14 },
    { header: 'Weight Unit',      width: 12 },
    { header: 'Volume',           width: 14 },
    { header: 'Volume Unit',      width: 12 },
    { header: 'Length',           width: 12 },
    { header: 'Width',            width: 12 },
    { header: 'Height',           width: 12 },
    { header: 'Dimension Unit',   width: 14 },
    { header: 'Barcode/EAN',      width: 18 },
    { header: 'Purchase Cost',    width: 14 },
    { header: 'Decimal Places',   width: 14 },
  ];

  const [cfKeys] = await pool.query(
    `SELECT DISTINCT field_key, field_type FROM fab_custom_fields
      WHERE company_id = ? AND level = 'item' AND deleted_at IS NULL ORDER BY field_key`,
    [companyId],
  );
  for (const cf of cfKeys) cols.push({ header: `${CF_PREFIX}${cf.field_key}`, width: 18 });

  styledHeader(ws, cols);

  const exampleRow = [
    'Structural Steel Bar 50x50', 'STRUCT-STEEL-50', 'kg',
    'Raw Material', 'Structural Steel', '',
    'raw_material', 'buy',
    'Example row — delete before importing', '', '', 5,
    '', '', '', '', '', '', '', '', '', '', '', '',
  ];
  for (let i = 0; i < cfKeys.length; i++) exampleRow.push('');
  ws.addRow(exampleRow);
  ws.getRow(2).font = { italic: true, color: { argb: 'FF999999' } };

  dropdown(ws, 7, MATERIAL_TYPES, 2, 1000);
  dropdown(ws, 8, PROCUREMENT_TYPES, 2, 1000);

  // ── Sheet 2: Existing Taxonomy (reference) ──────────────────────────────
  const wsTax = wb.addWorksheet('Existing Taxonomy');
  styledHeader(wsTax, [
    { header: 'Level',           width: 14 },
    { header: 'Name',            width: 24 },
    { header: 'Parent Category', width: 24 },
    { header: 'Parent Group',    width: 24 },
  ]);

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
    '5. Material Type: one of raw_material, component, semi_finished, finished_good (default: component).',
    '6. Procurement Type: buy or make (default: buy).',
    '7. See the "Existing Taxonomy" sheet for Category / Group / Sub-group names already in use —',
    '   reuse them exactly to avoid creating near-duplicate entries.',
    '8. If an Item Code already exists, that row is skipped (existing items are never overwritten by import).',
    '9. Gross Weight, Net Weight, Volume, Length, Width, Height are numeric. Weight Unit, Volume Unit,',
    '   Dimension Unit are free-text unit labels (e.g. kg, m3, mm) — left blank, the item default is used.',
    '10. Barcode/EAN and Purchase Cost are optional.',
    '11. Decimal Places sets how many decimals this item\'s dimension/weight/volume fields display and',
    '    round to (default 3 if left blank or not a valid number).',
    '12. Columns titled "CF: <name>" are existing item-level custom fields for this company — fill in a',
    '    value per row to set that custom field on the imported item. Leave blank to skip it for that row.',
  ];
  lines.forEach((l) => wsHelp.addRow([l]));
  wsHelp.getRow(1).font = { bold: true, size: 13 };

  return wb.xlsx.writeBuffer();
}

// ── import ────────────────────────────────────────────────────────────────────

export async function importItemsExcel(file, companyId) {
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
      materialTypeRaw:  (cellVal(row, 7) || '').toLowerCase(),
      procurementRaw:   (cellVal(row, 8) || '').toLowerCase(),
      description:      cellVal(row, 9),
      hsnCode:           cellVal(row, 10),
      division:          cellVal(row, 11),
      leadTimeDays:      numVal(row, 12),
      grossWeight:       numVal(row, 13),
      netWeight:         numVal(row, 14),
      weightUnit:        cellVal(row, 15),
      volume:            numVal(row, 16),
      volumeUnit:        cellVal(row, 17),
      length:            numVal(row, 18),
      width:             numVal(row, 19),
      height:            numVal(row, 20),
      dimensionUnit:     cellVal(row, 21),
      barcode:           cellVal(row, 22),
      purchaseCost:      numVal(row, 23),
      dimensionDecimalsRaw: cellVal(row, 24),
      customFields: cfColumns.map((cf) => ({ fieldKey: cf.fieldKey, value: cellVal(row, cf.col) })),
    });
  });

  const result = {
    itemsCreated: 0, itemsSkipped: 0,
    categoriesCreated: 0, groupsCreated: 0, subgroupsCreated: 0,
    warnings: [],
  };

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // ── preload existing item-level custom-field keys/types ────────────────
    const [existingCf] = await conn.query(
      `SELECT DISTINCT field_key, field_type FROM fab_custom_fields
        WHERE company_id = ? AND level = 'item' AND deleted_at IS NULL`,
      [companyId],
    );
    const cfTypeByKey = new Map(existingCf.map((cf) => [cf.field_key, cf.field_type]));

    // ── preload existing taxonomy + codes ──────────────────────────────────
    const [existingCats] = await conn.query(
      'SELECT id, name, code FROM fab_item_categories WHERE company_id = ? AND deleted_at IS NULL',
      [companyId],
    );
    const categoryCache = new Map(existingCats.map((c) => [c.name.toLowerCase(), c.id]));
    const categoryCodeSet = new Set(existingCats.map((c) => c.code.toUpperCase()));

    const [existingGroups] = await conn.query(
      'SELECT id, name, code, category_id FROM fab_item_groups WHERE company_id = ? AND deleted_at IS NULL',
      [companyId],
    );
    const groupCache = new Map(existingGroups.map((g) => [`${g.category_id}::${g.name.toLowerCase()}`, g.id]));
    const groupCodeSetByCategory = new Map();
    for (const g of existingGroups) {
      if (!groupCodeSetByCategory.has(g.category_id)) groupCodeSetByCategory.set(g.category_id, new Set());
      groupCodeSetByCategory.get(g.category_id).add(g.code.toUpperCase());
    }

    const [existingSubgroups] = await conn.query(
      'SELECT id, name, code, group_id FROM fab_item_subgroups WHERE company_id = ? AND deleted_at IS NULL',
      [companyId],
    );
    const subgroupCache = new Map(existingSubgroups.map((s) => [`${s.group_id}::${s.name.toLowerCase()}`, s.id]));
    const subgroupCodeSetByGroup = new Map();
    for (const s of existingSubgroups) {
      if (!subgroupCodeSetByGroup.has(s.group_id)) subgroupCodeSetByGroup.set(s.group_id, new Set());
      subgroupCodeSetByGroup.get(s.group_id).add(s.code.toUpperCase());
    }

    const [existingItems] = await conn.query(
      'SELECT code FROM fab_item_catalog WHERE company_id = ? AND deleted_at IS NULL',
      [companyId],
    );
    const itemCodeSet = new Set(existingItems.map((r) => r.code.toUpperCase()));

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
      result.subgroupsCreated++;
      return res.insertId;
    }

    async function resolveDefaultGroup(categoryId) {
      const key = `${categoryId}::default`;
      if (groupCache.has(key)) return groupCache.get(key);
      const [rows] = await conn.query(
        'SELECT id FROM fab_item_groups WHERE company_id = ? AND category_id = ? AND name = ? AND deleted_at IS NULL LIMIT 1',
        [companyId, categoryId, 'Default'],
      );
      if (rows.length) { groupCache.set(key, rows[0].id); return rows[0].id; }
      return resolveGroup(categoryId, 'Default');
    }

    async function resolveDefaultSubgroup(groupId) {
      const key = `${groupId}::default`;
      if (subgroupCache.has(key)) return subgroupCache.get(key);
      const [rows] = await conn.query(
        'SELECT id FROM fab_item_subgroups WHERE company_id = ? AND group_id = ? AND name = ? AND deleted_at IS NULL LIMIT 1',
        [companyId, groupId, 'Default'],
      );
      if (rows.length) { subgroupCache.set(key, rows[0].id); return rows[0].id; }
      return resolveSubgroup(groupId, 'Default');
    }

    // ── process rows ─────────────────────────────────────────────────────────
    for (const r of rows) {
      let code = r.code ? r.code.trim().toUpperCase() : null;
      if (code && itemCodeSet.has(code)) {
        result.warnings.push({ row: r.rowNumber, message: `Item code '${code}' already exists — row skipped.` });
        result.itemsSkipped++;
        continue;
      }
      if (!code) code = uniqueCode(itemCodeSet, r.name);
      else itemCodeSet.add(code);

      if (!r.categoryName) {
        result.warnings.push({ row: r.rowNumber, message: `Category is required — row skipped.` });
        result.itemsSkipped++;
        continue;
      }

      const categoryId = await resolveCategory(r.categoryName);
      let groupId = r.groupName ? await resolveGroup(categoryId, r.groupName) : await resolveDefaultGroup(categoryId);
      const subgroupId = r.subgroupName ? await resolveSubgroup(groupId, r.subgroupName) : await resolveDefaultSubgroup(groupId);

      let materialType = 'component';
      if (r.materialTypeRaw) {
        if (MATERIAL_TYPES.includes(r.materialTypeRaw)) materialType = r.materialTypeRaw;
        else result.warnings.push({ row: r.rowNumber, message: `Unrecognised Material Type — defaulted to 'component'.` });
      }
      let procurementType = 'buy';
      if (r.procurementRaw) {
        if (PROCUREMENT_TYPES.includes(r.procurementRaw)) procurementType = r.procurementRaw;
        else result.warnings.push({ row: r.rowNumber, message: `Unrecognised Procurement Type — defaulted to 'buy'.` });
      }

      let dimensionDecimals = parseInt(r.dimensionDecimalsRaw, 10);
      if (!Number.isInteger(dimensionDecimals) || dimensionDecimals < 0) {
        if (r.dimensionDecimalsRaw) {
          result.warnings.push({ row: r.rowNumber, message: `Invalid Decimal Places — defaulted to 3.` });
        }
        dimensionDecimals = 3;
      }

      const [insertRes] = await conn.query(
        `INSERT INTO fab_item_catalog
           (company_id, name, code, unit, description, category_id, group_id, subgroup_id,
            material_type, procurement_type, hsn_code, division, lead_time_days,
            gross_weight, net_weight, weight_unit, volume, volume_unit,
            length, width, height, dimension_unit, barcode, purchase_cost, dimension_decimals)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [companyId, r.name.trim(), code, r.unit, r.description || null, categoryId, groupId, subgroupId,
         materialType, procurementType, r.hsnCode || null, r.division || null, r.leadTimeDays,
         r.grossWeight, r.netWeight, r.weightUnit || 'kg', r.volume, r.volumeUnit || 'm3',
         r.length, r.width, r.height, r.dimensionUnit || 'mm', r.barcode || null, r.purchaseCost, dimensionDecimals],
      );
      result.itemsCreated++;

      const itemId = insertRes.insertId;
      let cfSortOrder = 0;
      for (const cf of r.customFields) {
        if (cf.value === null || cf.value === undefined || cf.value === '') continue;
        const fieldType = cfTypeByKey.get(cf.fieldKey) || 'text';
        await conn.query(
          `INSERT INTO fab_custom_fields
             (company_id, level, level_id, field_key, field_type, field_value, sort_order)
           VALUES (?,?,?,?,?,?,?)`,
          [companyId, 'item', itemId, cf.fieldKey, fieldType, cf.value, cfSortOrder],
        );
        if (!cfTypeByKey.has(cf.fieldKey)) cfTypeByKey.set(cf.fieldKey, fieldType);
        cfSortOrder++;
      }
    }

    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}
