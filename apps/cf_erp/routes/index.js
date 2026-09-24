import { Router } from 'express';
import { PERM, guard, handle } from '../lib/http.js';
import { LEVELS, LEAF_DEPTH } from '../services/tree.js';
import { DATA_TYPES, MEASUREMENT_TYPES } from '../services/specificationService.js';
import { VALUE_RULES, CAPTURE_LEVELS } from '../services/assignmentService.js';
import setupRoutes from './setup.js';
import recordRoutes from './records.js';
import bomRoutes from './boms.js';
import orderRoutes from './orders.js';
import productionRoutes from './production.js';
import inventoryRoutes from './inventory.js';
import overviewRoutes from './overview.js';
import trackerRoutes from './tracker.js';
import purchaseRoutes from './purchase.js';
import processRoutes from './process.js';
import drawingRoutes from './drawings.js';
import { DRAWING_SOURCES, DRAWING_STATUSES, DRAWING_SUBJECT_TYPES } from '../services/drawingService.js';
import { PURPOSES } from '../services/stockingAreaService.js';
import { BATCH_STATUSES } from '../services/batchService.js';
import { MOVEMENT_TYPES } from '../services/stockService.js';
import { PO_STATUSES } from '../services/purchaseService.js';
import { WEEKDAYS } from '../services/shiftService.js';
import { ORDER_TYPES, TRANSITIONS } from '../services/salesOrderService.js';
import { RELATIONS } from '../services/flowService.js';

const router = Router();

/**
 * cf_erp route root.
 *
 * Reads that are plain lists can also go through the generic query API
 * (resources in resourceDef.json). Everything with a rule behind it goes
 * through these routes and never through the generic write path:
 *   - items and definitions — a master row + a detail row, together;
 *   - BOM lines — a template line on a Custom BOM creates temporary items, and
 *     every change re-works roll-ups and inherited values;
 *   - sales orders and their lines — a custom line creates its whole structure;
 *   - machines — a master row plus specification values, like items;
 *   - flows — steps and wait rules are checked against each other;
 *   - stock — only movements write it: ledger rows and balances together;
 *   - the production tracker — release writes it whole, and steps change only
 *     through start / progress / hold / resume.
 *   - specification values — every change writes its history row;
 *   - drawings — a revision is a new row and its links are copied, never
 *     moved, so a generic UPDATE of `revision` would rewrite history;
 *   - code sequences — only the generator moves them.
 */
router.get('/health', (req, res) => res.json({ ok: true, app: 'cf_erp' }));

/** The vocabulary the screens build their pickers from. */
router.get('/meta', guard(PERM.view), handle(async () => ({
  levels: LEVELS,
  leafDepth: LEAF_DEPTH,
  dataTypes: DATA_TYPES,
  measurementTypes: MEASUREMENT_TYPES,
  valueRules: VALUE_RULES,
  captureLevels: CAPTURE_LEVELS,
  tracking: ['quantity', 'batch', 'individual'],
  selectionModes: ['allowed_list', 'spec_match', 'both'],
  statuses: ['draft', 'active', 'obsolete'],
  orderTypes: ORDER_TYPES,
  orderTransitions: TRANSITIONS,
  waitRelations: RELATIONS,
  flowStatuses: ['draft', 'active', 'obsolete'],
  weekdays: WEEKDAYS,
  areaPurposes: PURPOSES,
  batchStatuses: BATCH_STATUSES,
  movementTypes: MOVEMENT_TYPES,
  purchaseStatuses: PO_STATUSES,
  drawingSources: DRAWING_SOURCES,
  drawingStatuses: DRAWING_STATUSES,
  drawingSubjectTypes: DRAWING_SUBJECT_TYPES,
})));

router.use(setupRoutes);
router.use(recordRoutes);
router.use(bomRoutes);
router.use(orderRoutes);
router.use(productionRoutes);
router.use(inventoryRoutes);
router.use(overviewRoutes);
router.use(trackerRoutes);
router.use(purchaseRoutes);
router.use(processRoutes);
router.use(drawingRoutes);

export default router;
