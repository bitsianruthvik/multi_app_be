/**
 * verify-consumption-match.mjs — would the new consumption rule pick a
 * different plate?
 *
 * Read-only. Phase 6 made consumption match the plate size nesting declared,
 * instead of FIFO-picking any piece of the catalog item. That is a real change
 * in what comes off the shelf, so it must be looked at before it is trusted:
 * for every material link on every live order, this reports what the OLD rule
 * would have taken and what the NEW rule takes.
 *
 * Differences are expected — they are the bug being fixed. Each one should be
 * explicable as "the old rule would have taken the wrong plate".
 *
 * The third column is the one to watch: WOULD NOW FAIL means the new rule finds
 * nothing eligible where the old one found something. That is not necessarily
 * wrong — taking the wrong plate is worse than refusing — but it is the case
 * that will stop a job starting, so it needs to be seen before enforcement, not
 * discovered by an operator at a machine.
 *
 * Usage:  node scripts/verify-consumption-match.mjs [companyId]
 */

import { pool } from '../db.js';
import { isConsumable } from '../apps/fab_erp/services/itemFieldService.js';

const only = Number(process.argv[2]) || null;

const [links] = await pool.query(
  `SELECT rm.id AS linkId, rm.company_id AS companyId, rm.nest_no AS nestNo,
          rm.length AS wantLen, rm.width AS wantWid, rm.qty AS plates,
          rm.catalog_item_id AS catalogItemId,
          fic.code AS materialCode,
          p.name AS partName,
          o.order_number AS orderNumber, o.status AS orderStatus
     FROM fab_items rm
     JOIN fab_items p ON p.id = rm.parent_item_id AND p.deleted_at IS NULL
     JOIN fab_orders o ON o.id = rm.order_id AND o.deleted_at IS NULL
     JOIN fab_item_catalog fic ON fic.id = rm.catalog_item_id AND fic.deleted_at IS NULL
    WHERE rm.deleted_at IS NULL AND rm.catalog_item_id IS NOT NULL AND rm.flow_id IS NULL
      ${only ? 'AND rm.company_id = ?' : ''}
    ORDER BY o.order_number, fic.code, rm.nest_no`,
  only ? [only] : [],
);

if (!links.length) { console.log('No material links to replay.'); await pool.end(); process.exit(0); }

console.log(`Replaying ${links.length} material link(s)…\n`);

let differs = 0, wouldFail = 0, notConsumable = 0, unsized = 0;

for (const l of links) {
  // Mirrors consumeStock exactly: the filter only engages once this item has
  // at least one measured piece in stock. Any other rule here and the report
  // would describe behaviour the code does not have.
  const wantsSize = l.wantLen != null || l.wantWid != null;
  const [[m]] = await pool.query(
    `SELECT COUNT(*) AS measured FROM fab_stock_pieces
      WHERE company_id = ? AND catalog_item_id = ? AND status = 'in_stock'
        AND deleted_at IS NULL AND qty > 0
        AND (length_mm IS NOT NULL OR width_mm IS NOT NULL)`,
    [l.companyId, l.catalogItemId],
  );
  const sized = wantsSize && Number(m?.measured) > 0;

  // OLD rule: any in-stock piece of the item, FIFO.
  const [[oldPick]] = await pool.query(
    `SELECT id, code, length_mm, width_mm FROM fab_stock_pieces
      WHERE company_id = ? AND catalog_item_id = ? AND status = 'in_stock'
        AND deleted_at IS NULL AND qty > 0
      ORDER BY (received_date IS NULL), received_date ASC, id ASC LIMIT 1`,
    [l.companyId, l.catalogItemId],
  );

  // NEW rule: exact size when one was declared.
  const [[newPick]] = sized
    ? await pool.query(
        `SELECT id, code, length_mm, width_mm FROM fab_stock_pieces
          WHERE company_id = ? AND catalog_item_id = ? AND status = 'in_stock'
            AND deleted_at IS NULL AND qty > 0
            AND length_mm <=> ? AND width_mm <=> ?
          ORDER BY (received_date IS NULL), received_date ASC, id ASC LIMIT 1`,
        [l.companyId, l.catalogItemId, l.wantLen ?? null, l.wantWid ?? null],
      )
    : [[oldPick]];

  const ok = await isConsumable(l.companyId, l.catalogItemId);
  if (!ok) {
    notConsumable++;
    console.log(`REFUSED  ${l.orderNumber} · ${l.partName} · ${l.materialCode} — `
      + 'marked not consumable, so it can never be issued as material.');
    continue;
  }

  if (!sized) { unsized++; continue; }

  const oldId = oldPick?.id ?? null;
  const newId = newPick?.id ?? null;
  if (oldId === newId) continue;

  differs++;
  const want = `${l.wantLen ?? '?'}×${l.wantWid ?? '?'}`;
  if (newId == null) {
    wouldFail++;
    console.log(`WOULD NOW FAIL  ${l.orderNumber} · ${l.partName} · ${l.materialCode} `
      + `wants ${want} — old rule would have taken piece ${oldPick?.code ?? oldId} `
      + `(${oldPick?.length_mm ?? '—'}×${oldPick?.width_mm ?? '—'}), which is the wrong plate.`);
  } else {
    console.log(`DIFFERENT  ${l.orderNumber} · ${l.partName} · ${l.materialCode} wants ${want} — `
      + `old took ${oldPick?.code ?? oldId} (${oldPick?.length_mm ?? '—'}×${oldPick?.width_mm ?? '—'}), `
      + `new takes ${newPick.code ?? newId} (${newPick.length_mm}×${newPick.width_mm}).`);
  }
}

console.log(`\n${links.length} link(s): ${differs} would choose differently `
  + `(${wouldFail} would find nothing), ${notConsumable} refused as not consumable, `
  + `${unsized} not size-matched yet (no declared size, or no measured stock of that item).`);
console.log(differs === 0 && notConsumable === 0
  ? 'CLEAN — the new rule picks exactly what the old one did.'
  : 'REVIEW the lines above before this is relied on.');

await pool.end();
