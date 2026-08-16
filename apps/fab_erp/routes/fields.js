/**
 * fields.js — the vocabulary a field definition may draw on.
 *
 *   GET /fields/vocabulary   data types, units, and authoring levels
 *
 * Served rather than duplicated in the frontend because the same list has to
 * validate on the way in and render on the way out, and two copies of a
 * vocabulary drift — which is exactly how this registry ended up with
 * `Thickness (mm)` living beside `thickness_mm`.
 *
 * The lists themselves are code, not table rows: "mm" means the same thing for
 * every company. See services/fieldVocabulary.js for why that is not a
 * `company_id = -1` row.
 */

import { Router } from 'express';
import { protect } from '../../../core/middleware/authmiddleware.js';
import { DATA_TYPES, UNITS, FIELD_LEVELS } from '../services/fieldVocabulary.js';

const router = Router();

router.get('/fields/vocabulary', protect, (_req, res) => {
  res.json({
    dataTypes: DATA_TYPES,
    units: UNITS,
    levels: FIELD_LEVELS,
    /**
     * Stated so the editor can say it out loud rather than implying a
     * capability that does not exist: a unit is documentation, and nothing
     * converts between them. Define a length in metres against a formula that
     * assumes millimetres and the answer is plausible and wrong by 1000x.
     */
    unitsAreNotConverted: true,
  });
});

export default router;
