/**
 * seed-bom-from-templates.mjs — turn the flat parts list into a real BOM.
 *
 * Converts what `fab_bom_templates` holds today — a FLAT list of parts keyed on
 * the free-text string 'Composite Girder' — into the model agreed in
 * FAB_ERP_FIELDS_REDESIGN.md:
 *
 *   the VARIANT becomes a CATEGORY      'Composite Girder'
 *   each LEVEL becomes a CATALOG ITEM   Span, Girder, Segment, Top Flange, ...
 *   the STRUCTURE becomes BOM lines     Span -> @girders x Girder -> ...
 *
 * WHY A CATEGORY AND NOT AN ITEM. The taxonomy already scopes field definitions
 * and material pick lists — 28 of 53 field definitions key on it. Making the
 * variant a category means "grade E350 for everything composite" is one row and
 * needs no new mechanism. Making it an item would need a parallel one.
 *
 * WHAT THIS DOES NOT DO. It does not catalogue instances. The thirty top
 * flanges on a span stay fab_items rows pointing at the ONE Top Flange item.
 *
 * Idempotent: every insert is keyed on (company, code) and re-running updates
 * rather than duplicating.
 *
 * Usage:  node scripts/seed-bom-from-templates.mjs [companyId] [--dry]
 */

import { pool } from '../db.js';
import { setBomLine } from '../apps/fab_erp/services/bomService.js';

const only = Number(process.argv[2]) || 30005;
const dry = process.argv.includes('--dry');

/**
 * The levels above the parts. These are not in fab_bom_templates — it only ever
 * held the parts inside a segment, which is precisely why the wizard had to
 * hardcode span/girder/segment in a loop.
 *
 * Defaults of 6 and 5 come from `BoqWizardDialog`'s useState, where they were
 * typed into React. They belong on the BOM line.
 */
const LEVELS = [
  { code: 'SPAN', name: 'Span', levelKind: 'span' },
  { code: 'GDR', name: 'Girder', levelKind: 'girder' },
  { code: 'SEG', name: 'Segment', levelKind: 'segment' },
];

const [[co]] = await pool.query('SELECT id, name FROM companies WHERE id = ?', [only]);
if (!co) { console.error(`No company ${only}`); process.exit(1); }
console.log(`── ${co.name} (company ${co.id})`);

const [templates] = await pool.query(
  `SELECT line_type AS lineType, code, name, qty, thickness_mm AS thicknessMm, sort_order AS sortOrder
     FROM fab_bom_templates
    WHERE company_id = ? AND deleted_at IS NULL AND active = 1
    ORDER BY line_type, sort_order`,
  [co.id],
);
if (!templates.length) { console.log('   nothing in fab_bom_templates'); await pool.end(); process.exit(0); }

const byVariant = new Map();
for (const t of templates) {
  if (!byVariant.has(t.lineType)) byVariant.set(t.lineType, []);
  byVariant.get(t.lineType).push(t);
}

const slug = (s) => String(s).toUpperCase().replace(/[^A-Z0-9]+/g, '').slice(0, 6);

for (const [variant, parts] of byVariant) {
  console.log(`\n   variant "${variant}" — ${parts.length} part(s)`);
  const vCode = slug(variant);

  if (dry) {
    console.log(`   [dry] would create category ${vCode}, ${LEVELS.length + parts.length} item(s),`
      + ` and ${2 + parts.length} BOM line(s)`);
    continue;
  }

  // ── the category ────────────────────────────────────────────────────────
  const [[existingCat]] = await pool.query(
    'SELECT id FROM fab_item_categories WHERE company_id = ? AND code = ? LIMIT 1',
    [co.id, vCode],
  );
  let categoryId = existingCat?.id;
  if (!categoryId) {
    const [r] = await pool.query(
      'INSERT INTO fab_item_categories (company_id, code, name) VALUES (?,?,?)',
      [co.id, vCode, variant],
    );
    categoryId = r.insertId;
  }
  console.log(`     category ${vCode} #${categoryId}`);

  // ── the items ───────────────────────────────────────────────────────────
  const itemId = {};
  const upsertItem = async (code, name, levelKind) => {
    const full = `${vCode}-${code}`;
    const [[found]] = await pool.query(
      'SELECT id FROM fab_item_catalog WHERE company_id = ? AND code = ? LIMIT 1',
      [co.id, full],
    );
    if (found) {
      await pool.query(
        'UPDATE fab_item_catalog SET name = ?, category_id = ?, procurement_type = ?, level_kind = ? WHERE id = ?',
        [name, categoryId, 'make', levelKind, found.id],
      );
      return found.id;
    }
    const [r] = await pool.query(
      `INSERT INTO fab_item_catalog (company_id, code, name, category_id, unit, procurement_type, level_kind)
       VALUES (?,?,?,?,'nos','make',?)`,
      [co.id, full, name, categoryId, levelKind],
    );
    return r.insertId;
  };

  for (const lv of LEVELS) itemId[lv.code] = await upsertItem(lv.code, lv.name, lv.levelKind);
  for (const p of parts) {
    // A '/' in a part code ('BS/D') is the variant convention. It stays in the
    // code because the existing BOQ and every generated item code use it; what
    // changes is that it no longer has to be PARSED to decide a flow, because
    // the drilled variant is now its own item with its own BOM line.
    // A leaf of the structure is a 'part'. NEVER 'material' — that is the link
    // itemMaterialService creates UNDER a part, and a girder marked material
    // would be gated on as steel waiting to arrive rather than something made.
    itemId[p.code] = await upsertItem(p.code.replace(/\//g, '-'), p.name, 'part');
  }
  console.log(`     ${LEVELS.length + parts.length} catalog item(s)`);

  // ── the structure ───────────────────────────────────────────────────────
  const lines = [
    {
      parentItemId: itemId.SPAN, childItemId: itemId.GDR,
      qtyParam: 'girders', defaultQty: 6, codeSegment: 'G', sortOrder: 0,
      helpText: '0 if this job has no girders - the level collapses and parts sit under the span',
    },
    {
      parentItemId: itemId.GDR, childItemId: itemId.SEG,
      qtyParam: 'segmentsPerGirder', defaultQty: 5, perInstanceQty: 1,
      codeSegment: null, sortOrder: 0,
      helpText: 'The default for every girder. An end girder is routinely cut differently, so each can be overridden.',
    },
    ...parts.map((p, i) => ({
      parentItemId: itemId.SEG, childItemId: itemId[p.code],
      qtyNum: Number(p.qty) || 1, codeSegment: p.code, sortOrder: p.sortOrder ?? i,
    })),
  ];

  // Replace this template's lines rather than adding to them, so a re-run does
  // not double the parts in every segment.
  await pool.query(
    `UPDATE fab_item_bom SET deleted_at = NOW()
      WHERE company_id = ? AND parent_item_id IN (?,?,?) AND deleted_at IS NULL`,
    [co.id, itemId.SPAN, itemId.GDR, itemId.SEG],
  );
  for (const l of lines) await setBomLine(co.id, l);
  console.log(`     ${lines.length} BOM line(s): Span -> @girders Girder -> @segmentsPerGirder Segment -> ${parts.length} parts`);
}

console.log(dry ? '\n[dry] nothing written.' : '\nSeeded.');
await pool.end();
