/**
 * fields.js — the field vocabulary, and the values themselves.
 *
 *   GET  /fields/vocabulary          data types, units (with factors), rungs
 *   GET  /fields/values              resolved values for one thing, with provenance
 *   POST /fields/values              write values for one thing
 *
 * VALUES GO THROUGH HERE, NOT THROUGH THE GENERIC /mutate PATH. That is the
 * point of this route existing. `fab_custom_fields` was writable through the
 * generic resource API, which does no validation at all — so the table
 * accumulated values its own vocabulary would reject, and nobody found out
 * until a migration tried to read them. `setFields` refuses an unknown key, a
 * value at a rung the field may not be set on, a non-number in a number field
 * and an enum spelling that is not in the list. A write that cannot be
 * validated is a write that should not happen.
 */

import { Router } from 'express';
import { protect } from '../../../core/middleware/authmiddleware.js';
import { pool } from '../../../db.js';
import { logger } from '../../../core/utils/logger.js';
import { DATA_TYPES } from '../services/fieldVocabulary.js';
import { RUNGS } from '../services/fieldLadder.js';
import { resolveOne, setFields, fieldRegistry } from '../services/fieldService.js';

const router = Router();
const companyId = (req) => req.user?.companyId ?? req.user?.company_id;

const requirePerm = (tag) => (req, res, next) => {
  if (!Array.isArray(req.user?.uiPermissions) || !req.user.uiPermissions.includes(tag)) {
    return res.status(403).json({ message: `Permission required: ${tag}` });
  }
  next();
};

/**
 * The vocabulary an editor draws on.
 *
 * Units now come from `fab_units` rather than a code constant, because they
 * carry conversion factors and a factor is data. Two units are comparable when
 * they share a `baseCode` — which is what lets the editor group them and what
 * lets `convert()` refuse across money or compound rates instead of guessing.
 */
router.get('/fields/vocabulary', protect, async (req, res) => {
  try {
    const [units] = await pool.query(
      `SELECT code, dimension, base_code AS baseCode, factor_to_base AS factorToBase, label
         FROM fab_units ORDER BY dimension, factor_to_base`,
    );
    const byDimension = new Map();
    for (const u of units) {
      if (!byDimension.has(u.dimension)) byDimension.set(u.dimension, []);
      byDimension.get(u.dimension).push(u);
    }
    res.json({
      dataTypes: DATA_TYPES,
      units,
      unitGroups: [...byDimension].map(([group, values]) => ({ group, values })),
      /**
       * The rungs a value may hang off, broadest first. `appliesAt` on a field
       * names the NARROWEST of these it may be set on; broader is always
       * allowed, because a broad value is a default.
       */
      rungs: RUNGS,
      levels: [
        { value: 'order_item', label: 'Same for every piece', hint: 'thickness, grade, model' },
        { value: 'stock_piece', label: 'Differs per piece', hint: 'length, heat number, serial' },
      ],
      /**
       * This used to say `unitsAreNotConverted: true`, and the editor said so
       * out loud. It is no longer true — fab_units carries factor_to_base — so
       * the flag is inverted rather than removed, because a client that still
       * reads the old name would otherwise silently believe the wrong thing.
       */
      unitsAreConverted: true,
    });
  } catch (err) {
    logger.error({ err }, 'fab_erp fields/vocabulary failed');
    res.status(500).json({ message: err.message });
  }
});

/**
 * GET /fields/values?scope=catalog_item&scopeId=123
 *
 * Every field that applies to this thing, with the value, its unit, and the rung
 * it came from. `from` is the part that could not be answered before: a person
 * looking at 40 could not tell a category default from something typed on the
 * part, which makes "why is this wrong?" unanswerable and every disagreement a
 * guess.
 *
 * Read-only and gated only by `protect` — knowing what a thing is measured at is
 * not a manage action.
 */
router.get('/fields/values', protect, async (req, res) => {
  const cid = companyId(req);
  const { scope, scopeId } = req.query;
  if (!scope || !scopeId) return res.status(400).json({ message: 'scope and scopeId are required.' });
  if (!RUNGS.includes(String(scope))) {
    return res.status(400).json({ message: `Unknown scope "${scope}". Expected one of ${RUNGS.join(', ')}.` });
  }
  try {
    const [registry, values] = await Promise.all([
      fieldRegistry(cid),
      resolveOne(cid, String(scope), Number(scopeId)),
    ]);
    // The definitions come back too, so a client can render a field that has no
    // value yet. Deriving the form from the values alone would mean a field
    // nobody has filled in never appears — which is how the item import ended
    // up with columns for used fields only.
    res.json({
      scope, scopeId: Number(scopeId),
      fields: registry.rows.map((f) => ({
        fieldKey: f.fieldKey, label: f.label, dataType: f.dataType,
        unit: f.defaultUnit, dimension: f.dimension, appliesAt: f.applies_at,
        allowedValues: f.allowedValues, isStandard: !!Number(f.isStandard),
        formulaUsable: !!Number(f.formulaUsable), sortOrder: f.sortOrder,
        categoryId: f.categoryId, groupId: f.groupId, subgroupId: f.subgroupId,
      })),
      values,
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ message: err.message });
    logger.error({ err }, 'fab_erp fields/values read failed');
    res.status(500).json({ message: err.message });
  }
});

/**
 * POST /fields/values
 * { scope, scopeId, values: { thickness_mm: { value: 40, unit: 'mm' } } }
 *
 * A bare value is accepted too (`{ thickness_mm: 40 }`) and takes the field's
 * declared unit.
 *
 * Returns rejections rather than failing the whole write. One bad key in twenty
 * should not discard the other nineteen, and the caller needs to know WHICH one
 * and why — a 400 with no detail is what makes people retype the whole form.
 */
router.post('/fields/values', protect, requirePerm('fab_erp_items_meta_manage'), async (req, res) => {
  const cid = companyId(req);
  const { scope, scopeId, values } = req.body ?? {};
  if (!scope || !scopeId) return res.status(400).json({ message: 'scope and scopeId are required.' });
  try {
    const result = await setFields(cid, String(scope), Number(scopeId), values ?? {});
    res.json({ ok: true, ...result });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ message: err.message });
    logger.error({ err }, 'fab_erp fields/values write failed');
    res.status(500).json({ message: err.message });
  }
});

export default router;
