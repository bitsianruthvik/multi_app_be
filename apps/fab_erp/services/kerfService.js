/**
 * kerfService.js — the cutting gap, in one place.
 *
 * Two callers used to carry their own blanket number: the packer's 2 mm and
 * `remnantService`'s 4 mm. Both were the shop's real rule for something, but
 * disagreeing is why a drop computed after a 2 mm pack was recorded 2 mm
 * small on every edge — the pack thought the gap was one size, the leftover
 * geometry assumed another. `kerfFor` is the one place either of them reads
 * it from, so they can no longer drift apart.
 *
 * ORDER OF PRECEDENCE: a banded rule in `fab_cutting_kerfs` (by process and
 * thickness, EU-1 — empty today), else the company's `nest_kerf_mm` setting
 * (`fab_company_settings`, a key/value row, absent today), else a blanket
 * 2 mm. With both sources empty, every call resolves to 2 — today's packer
 * default — so wiring this in changes nothing until somebody enters a row.
 *
 * NOT CALLED BY THE PACKER ITSELF. `nestingPacker.js` is pure geometry with no
 * database connection, by design (see its own header) — kerf reaches it as a
 * plain `kerfMm` option that the CALLER resolves first.
 */

import { pool } from '../../../db.js';

const DEFAULT_KERF_MM = 2;

/**
 * @param {number} companyId
 * @param {number|null} thicknessMm
 * @param {string|null} [process]   e.g. 'cutting'. Matched against a band's own
 *   `process`, or any band that names none.
 * @param {Map<string, number>} [cache]   CALLER-OWNED, for the life of one
 *   request — the same rule as the formula engine's (ARCHITECTURE §13
 *   "Resolution and materialization are batched"): a module-level cache would
 *   outlive an edit to a company's kerf setting on a long-running server.
 * @returns {Promise<number>}
 */
export async function kerfFor(companyId, thicknessMm, process = null, cache = null) {
  const key = `${companyId}|${process ?? ''}|${thicknessMm ?? ''}`;
  if (cache?.has(key)) return cache.get(key);

  const value = await resolveKerf(companyId, thicknessMm, process);
  cache?.set(key, value);
  return value;
}

async function resolveKerf(companyId, thicknessMm, process) {
  const t = Number(thicknessMm);
  if (Number.isFinite(t)) {
    const [rows] = await pool.query(
      `SELECT kerf_mm AS kerfMm FROM fab_cutting_kerfs
        WHERE company_id = ? AND deleted_at IS NULL
          AND (process IS NULL OR process = ?)
          AND (thickness_min_mm IS NULL OR thickness_min_mm <= ?)
          AND (thickness_max_mm IS NULL OR thickness_max_mm >= ?)
        -- A band naming THIS process, over one that names none; likewise a
        -- band with an explicit thickness range over an unbounded one.
        ORDER BY (process IS NULL) ASC, (thickness_min_mm IS NULL) ASC LIMIT 1`,
      [companyId, process, t, t],
    );
    if (rows.length) return Number(rows[0].kerfMm);
  }

  const [[setting]] = await pool.query(
    `SELECT setting_value AS v FROM fab_company_settings
      WHERE company_id = ? AND setting_key = 'nest_kerf_mm' AND deleted_at IS NULL LIMIT 1`,
    [companyId],
  );
  // An empty `nest_kerf_mm` row (setting_value '' or NULL-ish) makes
  // Number(setting?.v) === 0, which is a real kerf value to MySQL's eyes but
  // never a real one to a torch — a cut with no gap at all. Only accept a
  // positive number; anything else falls through to the blanket default.
  const n = Number(setting?.v);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_KERF_MM;
}
