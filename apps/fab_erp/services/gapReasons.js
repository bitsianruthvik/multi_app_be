/**
 * gapReasons.js — the vocabulary for explaining unaccounted time.
 *
 * Every reason declares THREE things:
 *
 *   scope       which stream the explanation is written to. The operator never
 *               learns this word — they pick "Rain", and a plant event gets
 *               written instead of nine machine events.
 *   waitReason  which fab_task_wait_segments.reason the attribution engine will
 *               produce from it. This is what stops a site inventing vocabulary
 *               the engine knows nothing about: a new local code still has to
 *               land in one of the categories attribution can reason over.
 *   sortOrder   the common ones first, because the whole point is that a normal
 *               day is one tap.
 *
 * Built-ins live here; `fab_gap_reasons` holds per-company additions and
 * overrides (a row with the same code wins; active = 0 hides a built-in). Same
 * pattern as fab_resource_downtime_reasons.
 */

import { pool } from '../../../db.js';
import { logger } from '../../../core/utils/logger.js';

export const SCOPE_SITE = 'site';
export const SCOPE_MACHINE = 'machine';
export const SCOPE_TASK = 'task';

/**
 * Ordered so the four or five reasons that cover a normal day are visible
 * without opening anything. The long tail is real but rare, and burying the
 * common case behind a scroll is how a form stops being filled in.
 */
export const BUILT_IN_REASONS = [
  // ── machine scope — written to fab_resource_events ───────────────────────
  { code: 'breakdown',        label: 'Breakdown',                 scope: SCOPE_MACHINE, waitReason: 'machine_down',       sortOrder: 10 },
  { code: 'maintenance',      label: 'Maintenance',               scope: SCOPE_MACHINE, waitReason: 'machine_down',       sortOrder: 20 },
  { code: 'changeover',       label: 'Setup / changeover',        scope: SCOPE_MACHINE, waitReason: 'machine_down',       sortOrder: 30 },
  { code: 'no_power',         label: 'No power',                  scope: SCOPE_MACHINE, waitReason: 'machine_down',       sortOrder: 40 },
  { code: 'consumables',      label: 'Out of consumables',        scope: SCOPE_MACHINE, waitReason: 'machine_down',       sortOrder: 50 },

  // ── site scope — written to fab_plant_events ─────────────────────────────
  { code: 'weather',          label: 'Weather',                   scope: SCOPE_SITE,    waitReason: 'weather',            sortOrder: 15 },
  { code: 'power_outage',     label: 'Power outage (site)',       scope: SCOPE_SITE,    waitReason: 'weather',            sortOrder: 60 },
  { code: 'site_shutdown',    label: 'Site shutdown (unplanned)', scope: SCOPE_SITE,    waitReason: 'weather',            sortOrder: 70 },

  // ── task scope — written to fab_task_holds ───────────────────────────────
  { code: 'client_inspection', label: 'Client inspection',        scope: SCOPE_TASK,    waitReason: 'waiting_inspection', sortOrder: 12 },
  { code: 'qc_inspection',     label: 'Internal QC inspection',   scope: SCOPE_TASK,    waitReason: 'waiting_inspection', sortOrder: 14 },
  { code: 'ndt',               label: 'NDT / third-party test',   scope: SCOPE_TASK,    waitReason: 'waiting_inspection', sortOrder: 45 },
  { code: 'drawing_revision',  label: 'Drawing revision / hold',  scope: SCOPE_TASK,    waitReason: 'drawing_hold',       sortOrder: 18 },
  { code: 'customer_hold',     label: 'Customer hold',            scope: SCOPE_TASK,    waitReason: 'drawing_hold',       sortOrder: 55 },

  // ── the honest escape hatch ──────────────────────────────────────────────
  // Distinct from leaving the gap unexplained. "We know what this was and it
  // fits no code" must not read the same as "nobody looked at it", or the
  // residual — the number this whole mechanism exists to drive down — stops
  // meaning anything.
  { code: 'other',             label: 'Other (explain in note)',  scope: SCOPE_MACHINE, waitReason: 'other_explained',    sortOrder: 900 },
];

/** Which wait reasons a supervisor can assert. Everything else is derived. */
export const ASSERTABLE_WAIT_REASONS = new Set(
  BUILT_IN_REASONS.map((r) => r.waitReason),
);

/**
 * The catalogue for one company: built-ins, overlaid with its own rows.
 *
 * A company row with a built-in's code replaces it (so a site can relabel
 * "Breakdown" to whatever their people actually say); `active = 0` hides it.
 */
export async function reasonCatalogue(companyId) {
  const byCode = new Map(BUILT_IN_REASONS.map((r) => [r.code, { ...r, builtIn: true }]));
  try {
    const [rows] = await pool.query(
      `SELECT scope, code, label, wait_reason AS waitReason, sort_order AS sortOrder, active
         FROM fab_gap_reasons
        WHERE company_id = ? AND deleted_at IS NULL`,
      [companyId],
    );
    for (const r of rows) {
      if (!r.active) { byCode.delete(r.code); continue; }
      byCode.set(r.code, { ...r, active: 1, builtIn: false });
    }
  } catch (err) {
    // A missing table (migration not applied) must leave the built-ins working.
    logger.warn({ err, companyId }, 'gapReasons: catalogue lookup failed, using built-ins');
  }
  return [...byCode.values()]
    .filter((r) => r.active !== 0)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label));
}

/** One reason by code, or null. Callers must reject unknown codes. */
export async function findReason(companyId, code) {
  const all = await reasonCatalogue(companyId);
  return all.find((r) => r.code === code) ?? null;
}
