/**
 * orderItems.js — the sales-order wizard's routes: flows, blanks/nesting,
 * parameters, spec, revisions and the wizard/confirm lifecycle itself.
 *
 * The Excel bulk-import pair this file once documented here (BOQ sheet
 * export/import, the nesting board and the nesting suggestor) was deleted in
 * PLAN.md EU-20 (2026-09-13, User Clarifications decision 2) — the blank-plan
 * screens below (`/blanks`, `/blanks/accept`, `/blanks/sheet`) are the one
 * live nesting path now. `POST /orders/:orderId/items/recompute-weights`
 * survives (see below) and still requires: fab_erp_projects_manage.
 */

import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { protect } from '../../../core/middleware/authmiddleware.js';
import { requirePerm, fail } from '../../../core/middleware/requirePerm.js';
import { logger } from '../../../core/utils/logger.js';
import { pool } from '../../../db.js';
import { missingFieldsForOrder } from '../services/itemFieldService.js';
import { demandFor } from '../services/partIdentityService.js';
import { duplicateSubtree } from '../services/bomService.js';
import { syncFlowsFromBom, setItemFlows, itemFlows } from '../services/orderFlowService.js';
import { blankPlan } from '../services/blankPlanService.js';
import { exportPlan, importPlan } from '../services/blankSheetService.js';
import { nestDxfFile, nestsDxfZip } from '../services/dxfService.js';
import { exportLineStructure, importLineStructure } from '../services/structureSheetService.js';
import { acceptNestingPlan } from '../services/blankService.js';
import { refreshOrderStage, setWizardStep, orderReadiness } from '../services/orderReadinessService.js';
import { listRevisions } from '../services/orderRevisionService.js';
import { generateCode, getRule } from '../services/codegenService.js';
import {
  recomputeOrderWeightsHandler,
  orderWeightSummaryHandler,
  orderNestingHandler,
  setItemSpecHandler,
  getItemSpecHandler,
  deleteOrderHandler,
  parameterGridHandler,
  exportParametersHandler,
  importParametersHandler,
  setParametersHandler,
  orderReadinessHandler,
  confirmOrderHandler,
} from '../controllers/orderItemsImportController.js';

const router = Router();
const upload = multer({ dest: path.join(process.cwd(), 'tmp') });

router.post('/orders/:orderId/items/recompute-weights', protect, requirePerm('fab_erp_projects_manage'), recomputeOrderWeightsHandler);

/**
 * What an assembly NEEDS, for a screen that used to read its children.
 *
 * Identical parts are consolidated onto the line, so a diaphragm has no
 * children at all and a tree that asks for them shows an empty assembly — which
 * reads as nothing wrong rather than as a question asked in the wrong place.
 */
router.get('/orders/:orderId/items/:itemId/demand', protect, async (req, res) => {
  try {
    const cid = req.user?.companyId ?? req.user?.company_id;
    const orderId = Number(req.params.orderId);
    const itemId = Number(req.params.itemId);
    const map = await demandFor(cid, orderId, [itemId]);
    res.json({ itemId, parts: map.get(itemId) ?? [] });
  } catch (err) {
    return fail(res, err);
  }
});

// ── Flows: stage 3, at last with routes of its own (EU-9 item 6 / X3) ───────
//
// syncFlowsFromBom/setItemFlow/itemFlows have existed since the 2026-09-02
// flow rework with nothing mounted to call them — the FE has been unable to
// reach any of the three. Same permission as /structure/apply: assigning a
// flow is an edit action, reading the review grid is not.
/**
 * POST /orders/:orderId/flows/sync — re-pull the BOM's default flow for every
 * item that still has none. Body `{ reassign?: boolean }` — true also
 * overwrites items that already carry a flow (an exception someone set is
 * otherwise never undone by this).
 */
router.post('/orders/:orderId/flows/sync', protect, requirePerm('fab_erp_projects_manage'), async (req, res) => {
  try {
    const cid = req.user?.companyId ?? req.user?.company_id;
    const orderId = Number(req.params.orderId);
    const result = await syncFlowsFromBom(cid, orderId, { reassign: !!req.body?.reassign });
    // 'lines' is where a missing/would-assign flow is reported (flowState is
    // part of that stage's own compute) — see orderReadinessService STAGES.
    res.json({ ok: true, ...result, readiness: await refreshOrderStage(cid, orderId, { hint: 'lines' }) });
  } catch (err) {
    return fail(res, err);
  }
});

/**
 * POST /orders/:orderId/flows/set — override one or more items' flow at once.
 * Body `{ itemIds: number[], flowId: number|null }`; null clears it.
 */
router.post('/orders/:orderId/flows/set', protect, requirePerm('fab_erp_projects_manage'), async (req, res) => {
  try {
    const cid = req.user?.companyId ?? req.user?.company_id;
    const orderId = Number(req.params.orderId);
    const flowId = req.body?.flowId == null ? null : Number(req.body.flowId);
    const result = await setItemFlows(cid, orderId, req.body?.itemIds, flowId);
    res.json({ ok: true, ...result, readiness: await refreshOrderStage(cid, orderId, { hint: 'lines' }) });
  } catch (err) {
    return fail(res, err);
  }
});

/** GET /orders/:orderId/flows — every structural item with its flow, for the Flows step. */
router.get('/orders/:orderId/flows', protect, async (req, res) => {
  try {
    const cid = req.user?.companyId ?? req.user?.company_id;
    const orderId = Number(req.params.orderId);
    res.json({ ok: true, items: await itemFlows(cid, orderId) });
  } catch (err) {
    return fail(res, err);
  }
});

/**
 * THE BLANKS (2026-09-10) — nesting as it now works.
 *
 * `GET  /orders/:orderId/blanks`          what has to be cut, and from what
 * `POST /orders/:orderId/blanks/accept`   make it real and raise the work
 *
 * These replaced the drag-and-drop nesting board and the nesting suggestor,
 * both deleted whole in PLAN.md EU-20 (2026-09-13) — this is now the ONLY
 * nesting path. The difference from the old pair is the BLANK: they linked a
 * plate straight to each part, so 960 identical stiffeners were 960 claims on
 * steel and the rectangle they share existed nowhere. Reading writes nothing,
 * so it needs only the permission to look.
 */
router.get('/orders/:orderId/blanks', protect, async (req, res) => {
  try {
    const plan = await blankPlan((req.user?.companyId ?? req.user?.company_id), Number(req.params.orderId), {
      effort: req.query?.effort,
      repack: req.query?.repack === '1',
      // `saved=1`: the accepted plan or an empty answer — never a fresh pack.
      savedOnly: req.query?.saved === '1',
    });
    return res.json({ ok: true, ...plan });
  } catch (err) {
    return fail(res, err);
  }
});

router.post('/orders/:orderId/blanks/accept', protect, requirePerm('fab_erp_projects_manage'),
  async (req, res) => {
    try {
      const out = await acceptNestingPlan(
        (req.user?.companyId ?? req.user?.company_id), Number(req.params.orderId), req.body?.plan ?? {},
      );
      return res.json({ ok: true, ...out });
    } catch (err) {
      return fail(res, err);
    }
  });

/**
 * THE PLAN AS A SPREADSHEET — the second way in.
 *
 * `GET  /orders/:orderId/blanks/sheet`    download the plan to edit
 * `POST /orders/:orderId/blanks/sheet`    upload a filled one and apply it
 *
 * The packer does not know that the 40 mm is stacked behind the 25 mm, or that
 * the cutter wants the diaphragm plates in one setup. A planner who cannot say
 * so keeps the real plan in a spreadsheet beside the software, and then the
 * software describes a job nobody is doing.
 *
 * Upload APPLIES the plan, so it needs the same permission as accepting one.
 */
router.get('/orders/:orderId/blanks/sheet', protect, async (req, res) => {
  try {
    const { buffer, filename } = await exportPlan(
      (req.user?.companyId ?? req.user?.company_id), Number(req.params.orderId),
      { effort: req.query?.effort },
    );
    res.setHeader('Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(Buffer.from(buffer));
  } catch (err) {
    return fail(res, err);
  }
});

router.post('/orders/:orderId/blanks/sheet', protect, requirePerm('fab_erp_projects_manage'),
  upload.single('excel_file'), async (req, res) => {
    try {
      // This router's shared `upload` is disk storage (`dest`), not
      // `memoryStorage()` — `req.file.buffer` is never set here, unlike
      // templates.js's own multer instance. Read the temp file back, the
      // same way importParametersHandler (orderItemsImportController.js)
      // already does for this same middleware.
      if (!req.file?.path) return res.status(400).json({ message: 'No file was uploaded.' });
      const cid = req.user?.companyId ?? req.user?.company_id;
      const orderId = Number(req.params.orderId);
      const buffer = await fs.promises.readFile(req.file.path);
      const read = await importPlan(cid, orderId, buffer);
      const out = await acceptNestingPlan(cid, orderId, {
        ...read.plan,
        provenance: `Uploaded from a spreadsheet — ${read.sheets} sheets, ${read.rows} rows`,
      });
      return res.json({ ok: true, ...out, fromSheet: { rows: read.rows, sheets: read.sheets, short: read.short } });
    } catch (err) {
      return fail(res, err);
    } finally {
      if (req.file?.path) fs.unlink(req.file.path, () => {});
    }
  });

/**
 * THE SHEET AS A DXF — what the CNC opens.
 *
 * `GET /orders/:orderId/nests/dxf.zip`          every accepted sheet, zipped
 * `GET /orders/:orderId/nests/:nestNo/dxf`      one accepted sheet
 *
 * Accepted sheets only (dxfService reads the saved plan, never a fresh pack):
 * a file a machine cuts from must be the arrangement somebody accepted.
 * Reading writes nothing, so it needs only the permission to look.
 */
router.get('/orders/:orderId/nests/dxf.zip', protect, async (req, res) => {
  try {
    const { buffer, filename } = await nestsDxfZip(
      (req.user?.companyId ?? req.user?.company_id), Number(req.params.orderId),
    );
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(buffer);
  } catch (err) {
    return fail(res, err);
  }
});

router.get('/orders/:orderId/nests/:nestNo/dxf', protect, async (req, res) => {
  try {
    const { dxf, filename } = await nestDxfFile(
      (req.user?.companyId ?? req.user?.company_id), Number(req.params.orderId), String(req.params.nestNo),
    );
    res.setHeader('Content-Type', 'application/dxf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(dxf);
  } catch (err) {
    return fail(res, err);
  }
});

// ── One line's structure as a sheet, and back (the wizard's Excel round trip) ──

/**
 * GET /orders/:orderId/structure/sheet?orderLineId=<id> — one line's tree
 * as an editable sheet. Download, edit in Excel, upload to the POST below.
 *
 * Not templates.js's `/structure/export`: that one is the whole order with a
 * Level column and REPLACES on import. This one carries Row ids, so what
 * comes back is applied as a DIFF — the same `applyTree` the structure
 * editor's Save changes uses. Rows keep their ids, and so their sizes, the
 * plate they were nested onto and their tasks.
 */
router.get('/orders/:orderId/structure/sheet', protect, async (req, res) => {
  try {
    const cid = req.user?.companyId ?? req.user?.company_id;
    const orderLineId = Number(req.query?.orderLineId);
    if (!orderLineId) return res.status(400).json({ message: 'orderLineId is required.' });
    const { buffer, filename } = await exportLineStructure(cid, Number(req.params.orderId), orderLineId);
    res.setHeader('Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(Buffer.from(buffer));
  } catch (err) {
    return fail(res, err);
  }
});

/**
 * POST /orders/:orderId/structure/sheet — apply an edited sheet as a diff.
 *
 * Multipart: `excel_file`, plus `orderLineId` (body or query) and an optional
 * `revisionReason` (required by applyTree once the order is no longer a
 * draft). The whole sheet is validated BEFORE anything is written: a 422
 * carries `detail.problems` naming every bad row ("Row 9: …") and nothing
 * has changed. Same permission as saving the structure in the editor.
 */
router.post('/orders/:orderId/structure/sheet', protect, requirePerm('fab_erp_projects_manage'),
  upload.single('excel_file'), async (req, res) => {
    try {
      // Disk-storage multer (see `/blanks/sheet` above) — read the temp file back.
      if (!req.file?.path) return res.status(400).json({ message: 'No file was uploaded.' });
      const cid = req.user?.companyId ?? req.user?.company_id;
      const orderId = Number(req.params.orderId);
      const orderLineId = Number(req.body?.orderLineId ?? req.query?.orderLineId);
      if (!orderLineId) return res.status(400).json({ message: 'orderLineId is required.' });
      const revisionReason = String(req.body?.revisionReason ?? '').trim() || null;
      const buffer = await fs.promises.readFile(req.file.path);
      const result = await importLineStructure(cid, orderId, orderLineId, buffer, {
        revisionReason, userId: req.user?.id ?? null,
      });
      return res.json({ ok: true, ...result, readiness: await refreshOrderStage(cid, orderId) });
    } catch (err) {
      // `fail` forwards status, code and detail — a 422's problems list rides along.
      return fail(res, err);
    } finally {
      if (req.file?.path) fs.unlink(req.file.path, () => {});
    }
  });

// ── Flow allocation: stage 3 (2026-08) ─────────────────────────────────────

/**
 * WHAT THE STEEL IS — material, grade, thickness — on a line or on one part.
 *
 * This replaced `POST /items/:itemId/material`, which pointed a part at a
 * specific catalogue item before nesting. That is no longer a question the BOM
 * stage can answer: a catalogue item is now a SIZE as well as a material, and
 * which size to buy depends on what else is cut from the same sheet. Nesting
 * makes the link, and refuses any plate that disagrees with these three values.
 *
 * `lines` is the one people will use. An order is normally one steel throughout,
 * so it is stated once there and every part inherits it; `items` is for the part
 * that genuinely differs.
 *
 * Two routes rather than one `:scope(lines|items)` — Express 5 uses
 * path-to-regexp v8, which dropped inline patterns and throws at mount time.
 */
/**
 * GET /steel-options — the material and grade values that actually exist.
 *
 * Both were free text on the order line, and that is a correctness problem now
 * rather than a tidiness one: a BLANK's identity is material + grade + size, so
 * "E350 BO", "E350BO" and "e350 bo" would mint three catalog items for one piece
 * of steel. The list is short and real — read off the raw materials somebody
 * can actually buy — so there is no reason to let anyone type a fourth spelling.
 *
 * Grades come back PER MATERIAL, not as one flat list. Today every grade pairs
 * with MS and the distinction is invisible; the first time a second material
 * arrives it stops being.
 */
router.get('/steel-options', protect, async (req, res) => {
  try {
    const cid = req.user?.companyId ?? req.user?.company_id;
    const [rows] = await pool.query(
      `SELECT mat.value_text AS material, gr.value_text AS grade, COUNT(*) AS items
         FROM fab_item_catalog ci
         JOIN fab_item_categories k
               ON k.id = ci.category_id AND k.name = 'Raw Materials' AND k.deleted_at IS NULL
         JOIN fab_field_values mat
               ON mat.company_id = ci.company_id AND mat.scope = 'catalog_item'
              AND mat.scope_id = ci.id AND mat.deleted_at IS NULL
         JOIN fab_fields fm ON fm.id = mat.field_id AND fm.field_key = 'material'
         JOIN fab_field_values gr
               ON gr.company_id = ci.company_id AND gr.scope = 'catalog_item'
              AND gr.scope_id = ci.id AND gr.deleted_at IS NULL
         JOIN fab_fields fg ON fg.id = gr.field_id AND fg.field_key = 'grade'
        WHERE ci.company_id = ? AND ci.deleted_at IS NULL
          AND mat.value_text <> '' AND gr.value_text <> ''
        GROUP BY mat.value_text, gr.value_text
        ORDER BY items DESC`,
      [cid],
    );
    const byMaterial = {};
    for (const r of rows) {
      byMaterial[r.material] = [...(byMaterial[r.material] ?? []), r.grade];
    }
    res.json({
      materials: Object.keys(byMaterial).sort(),
      grades: [...new Set(rows.map((r) => r.grade))].sort(),
      byMaterial,
    });
  } catch (err) {
    logger.error({ err }, 'fab_erp: steel options failed');
    res.status(500).json({ message: err.message });
  }
});

router.get('/spec/lines/:id', protect, getItemSpecHandler('lines'));
router.get('/spec/items/:id', protect, getItemSpecHandler('items'));
router.post('/spec/lines/:id', protect, requirePerm('fab_erp_projects_manage'), setItemSpecHandler('lines'));
router.post('/spec/items/:id', protect, requirePerm('fab_erp_projects_manage'), setItemSpecHandler('items'));


// ── parameters: grid, spreadsheet, and marking copies ──────────────────────
//
// The grid asks each part only for what ITS flow needs. The sheet exists
// because a column of three hundred numbers is typed far faster than three
// hundred fields, and people already have the values in a spreadsheet.
router.get('/orders/:orderId/parameters', protect, parameterGridHandler);
router.get('/orders/:orderId/parameters/export', protect, requirePerm('fab_erp_projects_manage'), exportParametersHandler);
router.post('/orders/:orderId/parameters/import', protect, requirePerm('fab_erp_projects_manage'), upload.single('excel_file'), importParametersHandler);
router.post('/orders/:orderId/parameters', protect, requirePerm('fab_erp_projects_manage'), setParametersHandler);

// Marking girders or segments as copies of each other. One decision typed
// once instead of thirty times.

// ── The wizard: where the order stands, and the act that ends it (2026-08) ──
// Readiness is read-only, so it is gated on view, not manage.
router.get('/orders/:orderId/readiness', protect, orderReadinessHandler);
router.post('/orders/:orderId/confirm', protect, requirePerm('fab_erp_projects_manage'), confirmOrderHandler);

/**
 * POST /orders/:orderId/wizard-step — the user explicitly choosing where to be
 * in the wizard (A5). Same permission tag as `/structure/apply`: moving the
 * rail is an edit action, not a read. This is the ONLY route allowed to move
 * `wizard_step` backward, or park it on a stage that still has work left — see
 * `setWizardStep`/`refreshOrderStage` in orderReadinessService.js for why every
 * OTHER write can only move it forward.
 */
router.post('/orders/:orderId/wizard-step', protect, requirePerm('fab_erp_projects_manage'), async (req, res) => {
  try {
    const cid = req.user?.companyId ?? req.user?.company_id;
    const orderId = Number(req.params.orderId);
    const readiness = await setWizardStep(cid, orderId, req.body?.step);
    res.json({ ok: true, readiness });
  } catch (err) {
    return fail(res, err);
  }
});

/**
 * POST /orders/:orderId/revise — enter revision mode on a confirmed order.
 *
 * Records nothing itself; it only checks the order is out of draft and hands
 * back the current readiness so the wizard can reopen. Each structure change
 * the reopened wizard makes carries this SAME reason through
 * `/structure/apply`'s `revisionReason` body key — that call is what actually
 * writes a `fab_order_structure_revisions` row (User Clarifications 4).
 */
router.post('/orders/:orderId/revise', protect, requirePerm('fab_erp_projects_manage'), async (req, res) => {
  try {
    const cid = req.user?.companyId ?? req.user?.company_id;
    const orderId = Number(req.params.orderId);
    const reason = String(req.body?.reason ?? '').trim();
    if (reason.length < 10) {
      const e = new Error('A revision reason of at least 10 characters is required.');
      e.status = 400;
      e.code = 'REVISION_REASON_REQUIRED';
      throw e;
    }
    const [[order]] = await pool.query(
      `SELECT status FROM fab_orders WHERE id = ? AND company_id = ? AND deleted_at IS NULL`,
      [orderId, cid],
    );
    if (!order) { const e = new Error('Order not found'); e.status = 404; e.code = 'ORDER_NOT_FOUND'; throw e; }
    if (order.status === 'draft') {
      const e = new Error("This order is still a draft — there is nothing to revise, it's still the wizard.");
      e.status = 409;
      e.code = 'ALREADY_DRAFT';
      throw e;
    }
    res.json({ ok: true, revisionMode: true, readiness: await refreshOrderStage(cid, orderId) });
  } catch (err) {
    return fail(res, err);
  }
});

/**
 * GET /orders/:orderId/revisions — the paper trail for the order detail page,
 * newest first. Read-only, so no `requirePerm` beyond being logged in — same
 * as `/structure/tree`.
 */
router.get('/orders/:orderId/revisions', protect, async (req, res) => {
  try {
    const cid = req.user?.companyId ?? req.user?.company_id;
    const orderId = Number(req.params.orderId);
    res.json({ rows: await listRevisions(cid, orderId) });
  } catch (err) {
    return fail(res, err);
  }
});

/**
 * POST /orders/:orderId/convert — a quote becomes a sales order.
 *
 * One transaction, the order row locked: every line, item, nest, parameter and
 * plan the quote already has carries over untouched — nothing is
 * re-materialised here, because Production on a quote was never more than the
 * read-only estimate `isEstimateOnly` gates (EU-13 item 2); once converted it
 * behaves exactly like any other sales draft's Production step.
 *
 * The order number is reissued only if quotes and sales orders resolve to
 * DIFFERENT codegen rules — a company that has not customised either away from
 * the default (`quote_order` QT-, `sales_order` SO-) keeps the number it
 * already quoted the customer only when the two rules happen to be identical.
 * When it IS reissued, the quote's own number is kept in `notes` — no
 * `source_order_ref` column exists (grepped init.sql) and EU-1's follow-up did
 * not add one, so this is not a silent loss of the original number.
 */
router.post('/orders/:orderId/convert', protect, requirePerm('fab_erp_projects_manage'), async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const cid = req.user?.companyId ?? req.user?.company_id;
    const orderId = Number(req.params.orderId);
    await conn.beginTransaction();
    const [[order]] = await conn.query(
      `SELECT id, order_number, order_type, status, notes FROM fab_orders
        WHERE id = ? AND company_id = ? AND deleted_at IS NULL LIMIT 1 FOR UPDATE`,
      [orderId, cid],
    );
    if (!order) { const e = new Error('Order not found'); e.status = 404; e.code = 'ORDER_NOT_FOUND'; throw e; }
    if (order.order_type !== 'quote') {
      const e = new Error('Only a quote can be converted to a sales order.');
      e.status = 409; e.code = 'NOT_A_QUOTE'; throw e;
    }
    if (order.status !== 'draft') {
      const e = new Error('This quote is no longer a draft.');
      e.status = 409; e.code = 'NOT_DRAFT'; throw e;
    }

    const [quoteRule, salesRule] = await Promise.all([
      getRule(cid, 'quote_order'),
      getRule(cid, 'sales_order'),
    ]);
    const sameSeries = JSON.stringify(quoteRule.segments) === JSON.stringify(salesRule.segments);

    let orderNumber = order.order_number;
    let notes = order.notes;
    if (!sameSeries) {
      orderNumber = await generateCode(cid, 'sales_order', {}, conn);
      const ref = `Converted from quote ${order.order_number}.`;
      notes = notes ? `${notes}\n${ref}` : ref;
    }

    // status/order_type re-tested in the WHERE (on top of the row lock above)
    // so the UPDATE itself still refuses if something changed between the
    // SELECT and here.
    await conn.query(
      `UPDATE fab_orders SET order_type = 'sales', order_number = ?, notes = ?
        WHERE id = ? AND company_id = ? AND order_type = 'quote' AND status = 'draft'`,
      [orderNumber, notes, orderId, cid],
    );
    await conn.commit();

    const [[fresh]] = await pool.query(
      `SELECT id, order_number AS orderNumber, order_type AS orderType, status FROM fab_orders WHERE id = ? AND company_id = ? LIMIT 1`,
      [orderId, cid],
    );
    res.json({ ok: true, order: fresh, readiness: await orderReadiness(cid, orderId) });
  } catch (err) {
    try { await conn.rollback(); } catch { /* connection may already be gone */ }
    return fail(res, err);
  } finally {
    conn.release();
  }
});

/**
 * Deleting a sales order removes the whole tree beneath it.
 *
 * The generic row delete is not adequate here and was doing real damage: it left
 * the order's tasks and reservations live, so a deleted job went on holding steel
 * and loading machines. See orderDeleteService for what is deleted, what is
 * released, and what is deliberately kept.
 */
router.delete('/orders/:orderId', protect, requirePerm('fab_erp_projects_manage'), deleteOrderHandler);

/**
 * POST /orders/:orderId/items/:itemId/duplicate — copy a row and its subtree.
 *
 * The copy lands beside the original, under the same parent. "Six of these and
 * four of those" is: copy the row, change the copy — the same gesture the
 * structure editor gives before anything is written, offered again on the tree
 * after it has been.
 */
router.post(
  '/orders/:orderId/items/:itemId/duplicate',
  protect,
  requirePerm('fab_erp_projects_manage'),
  async (req, res) => {
    try {
      const cid = req.user?.companyId ?? req.user?.company_id;
      const orderId = Number(req.params.orderId);
      const result = await duplicateSubtree(cid, orderId, Number(req.params.itemId));
      res.json({ ok: true, ...result, readiness: await refreshOrderStage(cid, orderId) });
    } catch (err) {
      if (err.status) return res.status(err.status).json({ message: err.message });
      logger.error({ err }, 'fab_erp: duplicate subtree failed');
      return res.status(500).json({ message: err.message });
    }
  },
);

// Read-only: gated on view, not manage — anyone who can open the order sees its tonnage.
router.get('/orders/:orderId/items/weight-summary', protect, orderWeightSummaryHandler);
// Read-only too — seeing what the order is waiting on is not a manage action.
router.get('/orders/:orderId/items/nesting', protect, orderNestingHandler);

/**
 * GET /orders/:orderId/field-readiness — can this order be estimated honestly?
 *
 * The answer nobody could get before. A missing field value does not error: the
 * formula engine defaults unknown symbols to 0 so `IF()` fallbacks can work, so
 * a part with no thickness is not rejected — it is estimated as free to cut, and
 * every date computed from it downstream is fiction.
 *
 * Read-only and ungated beyond `protect`: knowing an order cannot be estimated
 * is not a manage action, and the people who most need to see it are often the
 * ones who cannot raise the production order.
 */
router.get('/orders/:orderId/field-readiness', protect, async (req, res) => {
  const companyId = req.user?.companyId;
  if (!companyId) return res.status(400).json({ message: 'Unable to determine companyId from token.' });
  const orderId = Number(req.params.orderId);
  if (!(orderId > 0)) return res.status(400).json({ message: 'orderId is required.' });
  try {
    return res.json({ ok: true, orderId, ...(await missingFieldsForOrder(companyId, orderId)) });
  } catch (err) {
    logger.error({ err, companyId, orderId }, 'fab_erp field-readiness failed');
    return res.status(500).json({ message: 'Could not check the order’s field values.' });
  }
});

export default router;
