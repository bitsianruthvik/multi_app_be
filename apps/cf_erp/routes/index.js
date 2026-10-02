import { Router } from 'express';
import { PERM, guard, handle } from '../lib/http.js';
import { LEVELS, LEAF_DEPTH } from '../services/tree.js';
import { DATA_TYPES, MEASUREMENT_TYPES } from '../services/specificationService.js';
import { VALUE_RULES, CAPTURE_LEVELS } from '../services/assignmentService.js';
import setupRoutes from './setup.js';
import recordRoutes from './records.js';
import bomRoutes from './boms.js';
import orderRoutes from './orders.js';
import bomSheetRoutes from './bomSheet.js';
import nestingRoutes from './nesting.js';
import productionRoutes from './production.js';
import inventoryRoutes from './inventory.js';
import stockMoneyRoutes from './stockMoney.js';
import overviewRoutes from './overview.js';
import trackerRoutes from './tracker.js';
import purchaseRoutes from './purchase.js';
import procurementRoutes from './procurement.js';
import buyingRoutes from './buying.js';
import processRoutes from './process.js';
import drawingRoutes from './drawings.js';
import orderValuesRoutes from './orderValues.js';
import lockRoutes from './lock.js';
import placeholderRoutes from './placeholders.js';
import timeRoutes from './times.js';
import workOrderRoutes from './workOrders.js';
import plannerRoutes from './planner.js';
import floorRoutes from './floor.js';
import gstRoutes from './gst.js';
import dashboardRoutes from './dashboard.js';
import { DRAWING_SOURCES, DRAWING_STATUSES, DRAWING_SUBJECT_TYPES } from '../services/drawingService.js';
import { PURPOSES } from '../services/stockingAreaService.js';
import { BATCH_STATUSES } from '../services/batchService.js';
import { MOVEMENT_TYPES } from '../services/stockService.js';
import { PO_STATUSES } from '../services/purchaseService.js';
import { PR_STATUSES, RFQ_STATUSES, RFQ_SUPPLIER_STATUSES } from '../services/procurementService.js';
import { WEEKDAYS } from '../services/shiftService.js';
import { ORDER_TYPES, TRANSITIONS } from '../services/salesOrderService.js';
import { RELATIONS } from '../services/flowService.js';
import { WO_STATUSES } from '../services/workOrderService.js';

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
  purchaseRequestStatuses: PR_STATUSES,
  rfqStatuses: RFQ_STATUSES,
  rfqSupplierStatuses: RFQ_SUPPLIER_STATUSES,
  drawingSources: DRAWING_SOURCES,
  drawingStatuses: DRAWING_STATUSES,
  drawingSubjectTypes: DRAWING_SUBJECT_TYPES,
  workOrderStatuses: WO_STATUSES,
})));

router.use(setupRoutes);
router.use(recordRoutes);
router.use(bomRoutes);
router.use(orderRoutes);
router.use(bomSheetRoutes);
router.use(nestingRoutes);
router.use(productionRoutes);
router.use(inventoryRoutes);
router.use(stockMoneyRoutes);
router.use(overviewRoutes);
router.use(trackerRoutes);
router.use(purchaseRoutes);
router.use(procurementRoutes);
router.use(buyingRoutes);
router.use(processRoutes);
router.use(drawingRoutes);
router.use(orderValuesRoutes);
router.use(lockRoutes);
router.use(placeholderRoutes);
router.use(timeRoutes);
router.use(workOrderRoutes);
router.use(plannerRoutes);
router.use(floorRoutes);
router.use(gstRoutes);
router.use(dashboardRoutes);

export default router;
