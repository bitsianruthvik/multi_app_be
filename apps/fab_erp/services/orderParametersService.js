/**
 * orderParametersService.js — the values an order's flows actually ask for.
 *
 * Three things live here because they are three views of one question and must
 * agree: the grid the screen renders, the spreadsheet people would rather type
 * into, and the write path both of them use.
 *
 * ONLY WHAT THE FLOW ASKS FOR. `missingFieldsForOrder` derives, per flow, the
 * union of `item.*` variables across that flow's operation formulas. That is
 * the required set, and a part is asked for exactly those. The grid previously
 * showed every field ANY flow on the order wanted against EVERY part, so a
 * plate that is only ever cut had an editable weld-length cell — a value that
 * no formula would read and that quietly implied the plate gets welded.
 *
 * ONE ROW PER PEER SET. Where girders or segments are marked similar
 * (similarityService), the thirty copies of "Top Flange" are one row. Writing
 * it writes all thirty. That is the whole point of marking them.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import ExcelJS from 'exceljs';
import { pool } from '../../../db.js';
import { missingFieldsForOrder } from './itemFieldService.js';
import { peerSets } from './similarityService.js';

const SHEET = 'Parameters';

/**
 * The grid: which parts, which columns, what is in them.
 *
 * @returns {Promise<{columns, rows, groupedAway:number}>}
 */
export async function parameterGrid(companyId, orderId, conn = null) {
  const exec = conn ?? pool;

  const readiness = await missingFieldsForOrder(companyId, orderId, exec);
  const requiredByFlow = new Map(
    (readiness.requiredByFlow ?? []).map((r) => [Number(r.flowId), new Set(r.required)]),
  );

  const [items] = await exec.query(
    `SELECT id, code, name, flow_id AS flowId, level_kind AS levelKind, similar_group AS similarGroup
       FROM fab_items
      WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL AND flow_id IS NOT NULL
      ORDER BY code`,
    [companyId, orderId],
  );

  const [defs] = await exec.query(
    `SELECT field_key AS fieldKey, label, unit, data_type AS dataType, sort_order AS sortOrder
       FROM fab_field_defs
      WHERE company_id = ? AND deleted_at IS NULL AND formula_usable = 1`,
    [companyId],
  );
  const defByKey = new Map(defs.map((d) => [d.fieldKey, d]));

  const [vals] = await exec.query(
    `SELECT level_id AS itemId, field_key AS fieldKey, field_value AS fieldValue
       FROM fab_custom_fields
      WHERE company_id = ? AND level = 'order_item' AND deleted_at IS NULL`,
    [companyId],
  );
  const valueOf = new Map(vals.map((v) => [`${v.itemId}:${v.fieldKey}`, v.fieldValue]));

  const { peerOf, leaders } = await peerSets(companyId, orderId, exec);

  // Columns are the union of every required set actually in play, so a column
  // appears because some part on this order needs it — not because the field
  // exists.
  const needed = new Set();
  for (const it of items) {
    for (const k of requiredByFlow.get(Number(it.flowId)) ?? []) needed.add(k);
  }
  const columns = [...needed]
    .map((k) => defByKey.get(k))
    .filter(Boolean)
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.fieldKey.localeCompare(b.fieldKey));

  let groupedAway = 0;
  const rows = [];
  for (const it of items) {
    const peers = peerOf.get(Number(it.id));
    // A peer set is represented by its leader; the rest are the same row.
    if (peers && !leaders.has(Number(it.id))) { groupedAway++; continue; }

    const required = requiredByFlow.get(Number(it.flowId)) ?? new Set();
    rows.push({
      itemId: it.id,
      code: it.code,
      name: it.name,
      levelKind: it.levelKind,
      flowId: it.flowId,
      /** How many real parts this row writes to. 1 unless it leads a peer set. */
      represents: peers ? peers.length : 1,
      required: [...required],
      values: Object.fromEntries(
        [...required].map((k) => [k, valueOf.get(`${it.id}:${k}`) ?? null]),
      ),
    });
  }

  return { columns, rows, groupedAway };
}

/**
 * Write values, fanning out to peers.
 *
 * @param {Array<{itemId:number, fieldKey:string, value:string|null}>} edits
 * @returns {Promise<{written:number, itemsTouched:number}>}
 */
export async function setParameters(companyId, orderId, edits, existingConn = null) {
  const conn = existingConn ?? await pool.getConnection();
  const owned = !existingConn;
  try {
    if (owned) await conn.beginTransaction();
    const { peerOf } = await peerSets(companyId, orderId, conn);

    const touched = new Set();
    let written = 0;
    for (const e of edits ?? []) {
      const base = Number(e.itemId);
      if (!base || !e.fieldKey) continue;
      const targets = peerOf.get(base) ?? [base];
      for (const itemId of targets) {
        const value = e.value == null || e.value === '' ? null : String(e.value);
        if (value === null) {
          await conn.query(
            `UPDATE fab_custom_fields SET deleted_at = NOW()
              WHERE company_id = ? AND level = 'order_item' AND level_id = ?
                AND field_key = ? AND deleted_at IS NULL`,
            [companyId, itemId, e.fieldKey],
          );
        } else {
          // Upsert by hand: the table has no unique key on
          // (company, level, level_id, field_key), so ON DUPLICATE KEY would
          // not fire and would silently insert a second row that later reads
          // pick between at random.
          const [[existing]] = await conn.query(
            `SELECT id FROM fab_custom_fields
              WHERE company_id = ? AND level = 'order_item' AND level_id = ?
                AND field_key = ? AND deleted_at IS NULL LIMIT 1`,
            [companyId, itemId, e.fieldKey],
          );
          if (existing) {
            await conn.query('UPDATE fab_custom_fields SET field_value = ? WHERE id = ?', [value, existing.id]);
          } else {
            await conn.query(
              `INSERT INTO fab_custom_fields (company_id, level, level_id, field_key, field_value)
               VALUES (?, 'order_item', ?, ?, ?)`,
              [companyId, itemId, e.fieldKey, value],
            );
          }
        }
        touched.add(itemId);
        written++;
      }
    }
    if (owned) await conn.commit();
    return { written, itemsTouched: touched.size };
  } catch (err) {
    if (owned) await conn.rollback();
    throw err;
  } finally {
    if (owned) conn.release();
  }
}

// ── the spreadsheet ─────────────────────────────────────────────────────────

/**
 * Export the grid as a sheet.
 *
 * Asked for because "many times it is easier to enter that way", which is the
 * same reason the BOQ is a sheet: a column of three hundred numbers is typed
 * far faster than three hundred fields, and people already have the values in
 * a spreadsheet somewhere.
 *
 * Item code is the key on the way back in — it is stable, unique, and visible,
 * whereas the id means nothing to the person editing the file. The id rides
 * along in a hidden-ish first column purely so a renamed code cannot orphan a
 * row.
 */
export async function exportParameters(companyId, orderId) {
  const { columns, rows } = await parameterGrid(companyId, orderId);
  const [[order]] = await pool.query(
    'SELECT order_number AS orderNumber FROM fab_orders WHERE id = ? AND company_id = ?',
    [orderId, companyId],
  );

  const wb = new ExcelJS.Workbook();
  const help = wb.addWorksheet('Instructions');
  help.getColumn(1).width = 104;
  [
    `Order ${order?.orderNumber ?? orderId} — Parameters`,
    '',
    'FILL IN THE VALUE COLUMNS AND UPLOAD THIS FILE BACK.',
    '  Only the columns after "Represents" are read. Everything to the left identifies the row',
    '  and is ignored on import, so widening or re-sorting the sheet is safe.',
    '',
    'A BLANK CELL CLEARS THAT VALUE. It does not mean "leave it alone" — if you want a value',
    '  kept, leave it in the cell.',
    '',
    'A GREYED "—" MEANS THE FLOW DOES NOT ASK FOR IT. Typing there does nothing: the part has no',
    '  operation whose formula reads that field.',
    '',
    'REPRESENTS tells you how many real parts the row writes to. Where girders or segments are',
    '  marked similar, one row stands for all of its copies and filling it fills every one.',
  ].forEach((l) => help.addRow([l]));

  const ws = wb.addWorksheet(SHEET);
  const head = ['Item ID', 'Code', 'Name', 'Represents',
    ...columns.map((c) => (c.unit ? `${c.label} (${c.unit})` : c.label))];
  ws.addRow(head);
  const h = ws.getRow(1);
  h.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  h.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } };
  h.alignment = { vertical: 'middle', horizontal: 'center' };
  ws.getColumn(1).width = 10;
  ws.getColumn(2).width = 40;
  ws.getColumn(3).width = 26;
  ws.getColumn(4).width = 11;
  columns.forEach((_, i) => { ws.getColumn(5 + i).width = 16; });
  ws.views = [{ state: 'frozen', ySplit: 1, xSplit: 3 }];

  for (const r of rows) {
    ws.addRow([
      r.itemId, r.code, r.name, r.represents,
      // "—" for a field this row's flow does not ask for. The cell is present
      // so the columns line up; it is not a value and is not read back.
      ...columns.map((c) => (r.required.includes(c.fieldKey) ? (r.values[c.fieldKey] ?? '') : '—')),
    ]);
  }

  const file = path.join(os.tmpdir(), `params-${orderId}-${process.pid}.xlsx`);
  await wb.xlsx.writeFile(file);
  const buf = fs.readFileSync(file);
  fs.unlink(file, () => {});
  return { buffer: buf, fileName: `${order?.orderNumber ?? `order-${orderId}`}-parameters.xlsx` };
}

/** Read a filled sheet back. Unknown codes and untouched "—" cells are skipped. */
export async function importParameters(companyId, orderId, filePath) {
  const { columns, rows } = await parameterGrid(companyId, orderId);
  const byId = new Map(rows.map((r) => [Number(r.itemId), r]));
  const byCode = new Map(rows.map((r) => [String(r.code ?? '').toUpperCase(), r]));

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const ws = wb.getWorksheet(SHEET) ?? wb.worksheets.find((w) => w.name !== 'Instructions');
  if (!ws) throw Object.assign(new Error(`No "${SHEET}" sheet in that file.`), { status: 400 });

  const edits = [];
  const warnings = [];
  for (let n = 2; n <= ws.rowCount; n++) {
    const row = ws.getRow(n);
    const idCell = row.getCell(1).value;
    const codeCell = String(row.getCell(2).value ?? '').trim();
    if (!idCell && !codeCell) continue;

    const target = byId.get(Number(idCell)) ?? byCode.get(codeCell.toUpperCase());
    if (!target) {
      warnings.push({ row: n, message: `Row ${n}: "${codeCell || idCell}" is not a part on this order — skipped.` });
      continue;
    }

    columns.forEach((c, i) => {
      if (!target.required.includes(c.fieldKey)) return; // "—" column, not asked for
      const raw = row.getCell(5 + i).value;
      const v = raw === null || raw === undefined ? '' : String(typeof raw === 'object' && raw.result !== undefined ? raw.result : raw).trim();
      if (v === '—') return;
      const before = target.values[c.fieldKey] ?? '';
      if (String(before) === v) return; // unchanged — do not rewrite
      edits.push({ itemId: target.itemId, fieldKey: c.fieldKey, value: v === '' ? null : v });
    });
  }

  const result = await setParameters(companyId, orderId, edits);
  return { ...result, edits: edits.length, warnings, rowsRead: ws.rowCount - 1 };
}
