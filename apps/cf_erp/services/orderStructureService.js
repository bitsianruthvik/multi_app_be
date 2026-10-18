/**
 * orderStructureService.js — the WHOLE order's structure written in one go (user, 2026-10-18: the first step of a
 * sales order captures every line's structure and values in one view).
 *
 *   POST /orders/:id/structure/changes  { dryRun?, lines: [{ lineId, changes }] }
 *
 * Each line's changes are exactly what POST /bom-changes takes for that line (bomChangeService — one mutation
 * path), and each line's cut pieces follow its save (cutPlateService.withCutPieces), as after any structure save.
 * Needs a transaction: the lines are written one after another on it, so a refusal on ANY line leaves EVERY line
 * as it was. A dry run rehearses every line and writes nothing.
 */
import { invalid } from '../lib/errors.js';
import { applyBomChanges } from './bomChangeService.js';
import { withCutPieces } from './cutPlateService.js';

/** opts.allow(bomType): the route's permission check per BOM type touched (as /bom-changes). */
export async function applyOrderStructureChanges(db, c, orderId, input = {}, opts = {}) {
  const dryRun = input.dryRun === true;
  const list = Array.isArray(input.lines) ? input.lines : [];
  if (!list.length) throw invalid('INVALID', 'Send the changes line by line: lines: [{ lineId, changes }].');
  const ids = list.map((x) => Number(x?.lineId));
  const [own] = await db.query(
    'SELECT id FROM cf_sales_order_lines WHERE company_id = ? AND order_id = ? AND id IN (?) AND deleted_at IS NULL',
    [c.companyId, orderId, ids.filter(Number.isInteger)],
  );
  const mine = new Set(own.map((r) => r.id));
  const strays = ids.filter((x) => !mine.has(x));
  if (strays.length || new Set(ids).size !== ids.length) {
    throw invalid('INVALID', 'Every line must be a line of this order, once.', {
      problems: strays.map((x) => `Line ${Number.isInteger(x) ? x : '?'} is not a line of this order.`),
    });
  }
  const lines = [];
  for (const x of list) {
    const lineId = Number(x.lineId);
    const out = await applyBomChanges(db, c, { scope: { orderLineId: lineId }, dryRun, changes: x.changes }, opts);
    lines.push({ lineId, ...(out.applied ? await withCutPieces(db, c, lineId, out) : out) });
  }
  return { applied: !dryRun, dryRun, lines };
}
