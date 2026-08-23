/**
 * stageApplicabilityService.js — which preparation stages apply to a line type.
 *
 * The eight stages are a fixed catalogue of KINDS, because each one is code:
 * `nesting` is six services and three screens, and no amount of configuration
 * conjures a stage nobody wrote. What genuinely varies — between customers, and
 * between a Composite Girder and a PEB inside one customer — is which of those
 * stages APPLY, and whether an inapplicable one should stop the order.
 *
 * This is the same split the shop floor already uses one level down:
 * `fab_operations` are implemented concepts and `fab_operation_flow_steps`
 * sequences them. Here the stage kinds are implemented and
 * `fab_line_type_stages` selects them.
 *
 * ── THREE STATES, AND THE MIDDLE ONE EARNS ITS PLACE ──────────────────────
 *   required        the stage must be done. The default, and what every tenant
 *                   gets until somebody configures otherwise.
 *   optional        the stage is shown and can be done, but does not hold the
 *                   order up. For work a shop sometimes does and sometimes
 *                   skips — not every job gets a nesting sheet.
 *   not_applicable  the stage is meaningless for this line type. Reported as
 *                   "not relevant" rather than hidden, because a stage that
 *                   silently vanishes leaves somebody wondering whether they
 *                   forgot it.
 *
 * Hiding and skipping are different claims and the strip should be able to make
 * both. That is why this is an enum and not a boolean.
 */

import { pool } from '../../../db.js';

export const APPLICABILITY = ['required', 'optional', 'not_applicable'];
const DEFAULT_APPLICABILITY = 'required';

/**
 * Pick the rule that best fits a line type. More specific wins.
 *
 * Deliberately the same shape as `flowAllocationService.pickRule`: an exact
 * `line_type` beats a NULL one, and among equals the older id wins so two rules
 * of the same specificity always resolve the same way. One matching idea in
 * this app rather than two that drift.
 */
export function pickStageRule(rules, { lineType, stageKey }) {
  const candidates = rules.filter((r) => r.stage_key === stageKey
    && (r.line_type == null || r.line_type === lineType));
  if (!candidates.length) return null;
  return candidates.reduce(
    (best, r) => ((r.line_type != null ? 1 : 0) > (best.line_type != null ? 1 : 0) ? r : best),
    candidates[0],
  );
}

/** Every active rule for a company. */
export async function loadStageRules(companyId, conn = null) {
  const exec = conn ?? pool;
  const [rows] = await exec.query(
    `SELECT id, line_type, stage_key, applicability, notes
       FROM fab_line_type_stages
      WHERE company_id = ? AND active = 1 AND deleted_at IS NULL
      ORDER BY stage_key, line_type, id`,
    [companyId],
  );
  return rows;
}

/**
 * Applicability of every stage, for one line type.
 *
 * @returns {Map<string, {applicability:string, notes:string|null, configured:boolean}>}
 */
export function applicabilityFor(rules, stageKeys, lineType) {
  const out = new Map();
  for (const key of stageKeys) {
    const rule = pickStageRule(rules, { lineType, stageKey: key });
    out.set(key, {
      applicability: rule?.applicability ?? DEFAULT_APPLICABILITY,
      notes: rule?.notes ?? null,
      // So a screen can say "this is the default" rather than implying somebody
      // chose it.
      configured: !!rule,
    });
  }
  return out;
}

/**
 * Applicability across every line type ON one order.
 *
 * AN ORDER CAN HOLD MORE THAN ONE TYPE — a deck of composite girders and a PEB
 * shed on the same contract — and then a stage can be required for one line and
 * meaningless for another. This resolves the ORDER-level answer, which is the
 * union: a stage that any line still needs is still a stage this order has to
 * do.
 *
 * It is only 'not_applicable' at order level when EVERY line type says so,
 * because switching a gate off for the whole order on the strength of one line
 * is how an order ships without being nested.
 *
 * The per-LINE answer is the finer one and is what a mixed order really wants;
 * `applicabilityFor` gives it, and the readiness strip will use it once stage
 * counts are line-scoped. Until then this is the honest order-level reading and
 * it is exactly right for the common case of one type per order.
 */
export async function orderStageApplicability(companyId, orderId, stageKeys, conn = null) {
  const exec = conn ?? pool;
  const [lines] = await exec.query(
    `SELECT DISTINCT line_type FROM fab_order_lines
      WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL`,
    [companyId, orderId],
  );
  const types = lines.map((l) => l.line_type ?? null);
  const rules = await loadStageRules(companyId, exec);

  // No lines yet: nothing to scope by, so everything applies as it always did.
  if (!types.length) return applicabilityFor(rules, stageKeys, null);

  const perType = types.map((t) => applicabilityFor(rules, stageKeys, t));
  const out = new Map();
  for (const key of stageKeys) {
    const all = perType.map((m) => m.get(key));
    const strongest = all.some((a) => a.applicability === 'required') ? 'required'
      : all.some((a) => a.applicability === 'optional') ? 'optional'
        : 'not_applicable';
    out.set(key, {
      applicability: strongest,
      notes: all.find((a) => a.applicability === strongest)?.notes ?? null,
      configured: all.some((a) => a.configured),
      // Named so a strip can flag "required here, not relevant there" instead of
      // quietly reporting the union as though the order were uniform.
      mixed: new Set(all.map((a) => a.applicability)).size > 1,
      lineTypes: types,
    });
  }
  return out;
}

/**
 * Replace the rules for one line type.
 *
 * Whole-set replacement rather than per-row edits: the caller is configuring
 * "what a PEB line needs", which is one decision about eight stages, and
 * applying it as eight independent writes leaves a half-configured type live in
 * between.
 *
 * A stage left at 'required' stores NO ROW. The table then holds only the
 * DIFFERENCES from the default, so reading it tells you what somebody actually
 * decided rather than burying three real choices in eight rows of noise.
 */
export async function setStageRules(companyId, lineType, entries, existingConn = null) {
  const conn = existingConn ?? await pool.getConnection();
  const owned = !existingConn;
  try {
    if (owned) await conn.beginTransaction();

    for (const e of entries ?? []) {
      if (!APPLICABILITY.includes(e.applicability)) {
        const err = new Error(
          `"${e.applicability}" is not an applicability. Expected one of ${APPLICABILITY.join(', ')}.`,
        );
        err.status = 400;
        throw err;
      }
    }

    await conn.query(
      `UPDATE fab_line_type_stages SET deleted_at = NOW()
        WHERE company_id = ? AND deleted_at IS NULL AND line_type <=> ?`,
      [companyId, lineType ?? null],
    );

    const rows = (entries ?? [])
      .filter((e) => e.applicability !== DEFAULT_APPLICABILITY)
      .map((e) => [companyId, lineType ?? null, e.stageKey, e.applicability, e.notes ?? null]);
    if (rows.length) {
      await conn.query(
        `INSERT INTO fab_line_type_stages (company_id, line_type, stage_key, applicability, notes)
         VALUES ?`,
        [rows],
      );
    }

    if (owned) await conn.commit();
    return { lineType: lineType ?? null, stored: rows.length, defaulted: (entries ?? []).length - rows.length };
  } catch (err) {
    if (owned) await conn.rollback();
    throw err;
  } finally {
    if (owned) conn.release();
  }
}
