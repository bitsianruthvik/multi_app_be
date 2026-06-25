import { Router } from 'express';
import { protect } from '../../../core/middleware/authmiddleware.js';
import { pool }    from '../../../db.js';

const router = Router();

// POST /bom/copy-template
// Copies fab_material_bom_items for a catalog item into fab_items for a project.
// Remaps parent IDs so the tree structure is preserved.
// Body: { projectId, catalogItemId, bomId? }
//   - If bomId provided: copy items for that specific BOM.
//   - If bomId omitted: find the default BOM; fall back to first BOM; fall back to
//     legacy query by catalog_item_id directly on the items table.
router.post('/bom/copy-template', protect, async (req, res) => {
  const { projectId, catalogItemId, bomId } = req.body;
  const companyId = req.user.companyId;

  if (!projectId || !catalogItemId) {
    return res.status(400).json({ error: 'projectId and catalogItemId are required' });
  }


  try {
    let rows;

    if (bomId) {
      [rows] = await pool.query(
        `SELECT * FROM fab_material_bom_items
         WHERE bom_id = ? AND deleted_at IS NULL
         ORDER BY id`,
        [bomId],
      );
    } else {
      // Try to find the default BOM for this catalog item / company
      const [[defaultBom]] = await pool.query(
        `SELECT id FROM fab_material_boms
         WHERE company_id = ? AND catalog_item_id = ? AND is_default = 1 AND deleted_at IS NULL
         LIMIT 1`,
        [companyId, catalogItemId],
      );

      let resolvedBomId = defaultBom?.id ?? null;

      if (!resolvedBomId) {
        const [[firstBom]] = await pool.query(
          `SELECT id FROM fab_material_boms
           WHERE company_id = ? AND catalog_item_id = ? AND deleted_at IS NULL
           ORDER BY id
           LIMIT 1`,
          [companyId, catalogItemId],
        );
        resolvedBomId = firstBom?.id ?? null;
      }

      if (resolvedBomId) {
        [rows] = await pool.query(
          `SELECT * FROM fab_material_bom_items
           WHERE bom_id = ? AND deleted_at IS NULL
           ORDER BY id`,
          [resolvedBomId],
        );
      } else {
        // Legacy fallback: query by catalog_item_id directly
        [rows] = await pool.query(
          `SELECT * FROM fab_material_bom_items
           WHERE company_id = ? AND catalog_item_id = ? AND deleted_at IS NULL
           ORDER BY id`,
          [companyId, catalogItemId],
        );
      }
    }

    if (!rows.length) {
      return res.json({ ok: true, inserted: 0 });
    }

    const byParent = new Map();
    rows.forEach((r) => {
      const key = r.parent_bom_item_id ?? null;
      if (!byParent.has(key)) byParent.set(key, []);
      byParent.get(key).push(r);
    });

    let inserted = 0;

    async function insertNode(node, parentItemId) {
      const [result] = await pool.query(
        `INSERT INTO fab_items (company_id, project_id, parent_item_id, catalog_item_id, name, unit, qty)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [companyId, projectId, parentItemId, node.ref_catalog_item_id, node.name, node.unit, node.qty],
      );
      inserted++;
      const newId = result.insertId;
      for (const child of byParent.get(node.id) ?? []) {
        await insertNode(child, newId);
      }
    }

    for (const root of byParent.get(null) ?? []) {
      await insertNode(root, null);
    }

    res.json({ ok: true, inserted });
  } catch (err) {
    console.error('BOM copy-template error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /bom/template-count?catalogItemId=X
// Returns count of template BOM items so the UI knows whether to offer the copy tick.
// Counts via the BOM header join first; falls back to legacy direct count if 0.
router.get('/bom/template-count', protect, async (req, res) => {
  const { catalogItemId } = req.query;
  const companyId = req.user.companyId;

  if (!catalogItemId) return res.json({ count: 0 });


  const [[joinRow]] = await pool.query(
    `SELECT COUNT(*) AS cnt
     FROM fab_material_bom_items fmbi
     JOIN fab_material_boms fmb ON fmbi.bom_id = fmb.id
     WHERE fmb.company_id = ? AND fmb.catalog_item_id = ?
       AND fmbi.deleted_at IS NULL AND fmb.deleted_at IS NULL`,
    [companyId, catalogItemId],
  );

  if (joinRow.cnt > 0) {
    return res.json({ count: joinRow.cnt });
  }

  // Legacy fallback: items stored directly by catalog_item_id without a BOM header
  const [[legacyRow]] = await pool.query(
    `SELECT COUNT(*) AS cnt FROM fab_material_bom_items
     WHERE company_id = ? AND catalog_item_id = ? AND deleted_at IS NULL`,
    [companyId, catalogItemId],
  );
  res.json({ count: legacyRow.cnt });
});

export default router;
