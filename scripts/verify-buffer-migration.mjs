/**
 * verify-buffer-migration.mjs — does the new area structure say the same thing
 * as the old buffer table?
 *
 * Read-only. Phase 10 moves capacity and thresholds off `fab_buffers`
 * (keyed on machine + side) and onto the STOCK AREA, with a link table giving
 * a machine any number of areas with roles.
 *
 * The old model resolved BOTH a machine's input and output buffer to the same
 * location — `WIP-M<id>` — so the two sides always measured one pile, and
 * `isOutputBlocked`'s "both sides full" test compared a number with itself.
 * The migration preserves that rather than inventing two areas, so this report
 * should show the two roles agreeing; that is the old behaviour, not a fault.
 *
 * What must NOT happen: an area losing its capacity, or a machine losing a
 * buffer it had. Either would silently turn "this bay is full" into "no limit
 * recorded", and a load with no limit never blocks.
 *
 * `fab_cc_buffers` — the critical chain's TIME buffers — are a different
 * concept sharing a word, and are untouched. Counted here only to prove it.
 *
 * Usage:  node scripts/verify-buffer-migration.mjs [companyId]
 */

import { pool } from '../db.js';
import { resourceAreas, loadOfArea, loadOf, statusFor } from '../apps/fab_erp/services/bufferService.js';

const only = Number(process.argv[2]) || null;
let problems = 0;
const flag = (m) => { problems++; console.log(`   ⚠ ${m}`); };

const [companies] = await pool.query(
  only
    ? 'SELECT id, name FROM companies WHERE id = ?'
    : `SELECT DISTINCT c.id, c.name FROM companies c
         JOIN fab_resources r ON r.company_id = c.id AND r.deleted_at IS NULL`,
  only ? [only] : [],
);

for (const co of companies) {
  console.log(`\n── ${co.name} (company ${co.id})`);

  const [buffers] = await pool.query(
    `SELECT b.id, b.resource_id AS resourceId, b.kind, b.capacity_value AS capacityValue,
            b.warn_pct AS warnPct, b.block_pct AS blockPct, r.name AS machine
       FROM fab_buffers b
       LEFT JOIN fab_resources r ON r.id = b.resource_id
      WHERE b.company_id = ? AND b.deleted_at IS NULL AND b.active = 1`,
    [co.id],
  );
  const [[cc]] = await pool.query(
    'SELECT COUNT(*) AS n FROM fab_cc_buffers WHERE company_id = ? AND deleted_at IS NULL',
    [co.id],
  );
  const [areas] = await pool.query(
    `SELECT a.resource_id AS resourceId, a.role, a.stock_location_id AS locationId
       FROM fab_resource_stock_areas a
      WHERE a.company_id = ? AND a.deleted_at IS NULL AND a.active = 1`,
    [co.id],
  );

  console.log(`   ${buffers.length} legacy buffer(s) · ${areas.length} area link(s)`
    + ` · ${cc.n} critical-chain TIME buffer(s), untouched`);

  // Every legacy buffer must have an equivalent link, and the same numbers.
  for (const b of buffers) {
    const links = areas.filter((a) => a.resourceId === b.resourceId && a.role === b.kind);
    if (!links.length) {
      flag(`"${b.machine}" ${b.kind} buffer has no area link — its capacity would be lost`);
      continue;
    }
    const got = await resourceAreas(co.id, b.resourceId, { role: b.kind });
    const area = got[0];
    if (area?.capacityValue == null) {
      flag(`"${b.machine}" ${b.kind}: capacity ${b.capacityValue} did not reach the area — `
        + 'a load with no limit never blocks');
      continue;
    }
    if (Math.abs(Number(area.capacityValue) - Number(b.capacityValue)) > 0.001) {
      flag(`"${b.machine}" ${b.kind}: capacity ${b.capacityValue} became ${area.capacityValue}`);
    }
    // …and the derived status must match, which is what anything downstream reads.
    const oldLoad = await loadOf(co.id, b.id).catch(() => null);
    const newLoad = await loadOfArea(co.id, area);
    const oldStatus = oldLoad ? statusFor(oldLoad.pct, oldLoad.warnPct, oldLoad.blockPct) : null;
    const newStatus = newLoad.pct == null ? null : statusFor(newLoad.pct, newLoad.warnPct, newLoad.blockPct);
    if (oldStatus !== newStatus) {
      flag(`"${b.machine}" ${b.kind}: status was "${oldStatus}", now "${newStatus}"`);
    } else {
      console.log(`   ok  ${b.machine} ${b.kind}: ${b.capacityValue} cap · status ${newStatus ?? 'n/a'}`);
    }
  }

  if (!buffers.length) console.log('   no legacy buffers to compare against');
}

console.log(problems === 0
  ? '\nCLEAN — every buffer became an area with the same capacity and the same status.'
  : `\nREVIEW — ${problems} problem(s) above.`);

await pool.end();
