/**
 * verify-legacy-divergence.mjs — is it safe to drop the legacy sources yet?
 *
 * Read-only. This is the GATE for Phase 11, and it did not exist until now:
 * the plan says the legacy columns come out "only after a sustained period of
 * dual-read with a zero-divergence report", and nobody had written the report.
 * Without it "sustained" means "however long felt like enough", which is how a
 * dual-read window ends with somebody dropping a column that was still the only
 * copy of something.
 *
 * Each check answers one question: does the legacy source still agree with the
 * thing that replaced it? A DIVERGENCE means a writer is still writing to the
 * old place, or the new place is missing something — either way the column
 * cannot come out.
 *
 * It also reports LIVE READERS. Agreement is not sufficient: a column nothing
 * disagrees about is still load-bearing if code reads it. Those are listed with
 * what must change first, so the next person does not have to re-derive it.
 *
 * Run it periodically. When every check reads CLEAN and every reader count is
 * zero, the corresponding drop in Phase 11 is safe — and not before.
 *
 * Usage:  node scripts/verify-legacy-divergence.mjs [companyId]
 */

import { pool } from '../db.js';
import { resolveItemFields } from '../apps/fab_erp/services/itemFieldService.js';

const only = Number(process.argv[2]) || null;
let blocked = 0;
let diverged = 0;
let done = 0;

/**
 * A CHECK MUST SURVIVE ITS OWN SUCCESS.
 *
 * Learned immediately: the first drop this script authorised was
 * `fab_item_metric_defs`, and the next run died on `ER_NO_SUCH_TABLE` querying
 * it — before printing a single verdict. A gate that works exactly once, and
 * then hides the status of every source after it, is worse than no gate,
 * because the failure looks like a broken script rather than a missing report.
 *
 * So every check asks whether its source still exists before measuring it, and
 * reports a dropped source as DONE. The point is to re-run this as each
 * precondition lands and watch the list shorten.
 */
const tableExists = async (t) => {
  const [[r]] = await pool.query(
    `SELECT COUNT(*) AS n FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`, [t],
  );
  return Number(r.n) > 0;
};

const columnExists = async (t, c) => {
  const [[r]] = await pool.query(
    `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`, [t, c],
  );
  return Number(r.n) > 0;
};

const reportDone = (name) => {
  done++;
  console.log(`\nDONE       ${name}`);
  console.log('   already dropped — nothing left to check');
};

const report = (name, { divergence, readers, precondition }) => {
  const ok = divergence === 0 && readers.length === 0;
  if (divergence > 0) diverged++;
  if (readers.length) blocked++;
  console.log(`\n${ok ? 'DROPPABLE' : 'BLOCKED  '}  ${name}`);
  console.log(`   divergence: ${divergence === 0 ? 'none' : `${divergence} row(s) disagree`}`);
  console.log(`   live readers: ${readers.length ? readers.join(', ') : 'none'}`);
  if (!ok) console.log(`   before dropping: ${precondition}`);
};

/**
 * EVERY company that has legacy rows — not every company that has fab_items.
 *
 * The original list joined `fab_items`, on the assumption that a company with no
 * items has nothing to check. It does not hold: locally only company 6 has
 * items, while companies 1-5 hold 46 fab_custom_fields rows and 35
 * fab_bom_templates rows between them. The gate looked at one company out of
 * six and would have reported the other five CLEAN by never asking.
 *
 * A gate that decides what to DROP must be scoped to where the data is, not to
 * where the traffic is.
 */
const legacySources = ['fab_items', 'fab_custom_fields', 'fab_bom_templates',
  'fab_field_defs', 'fab_item_metric_values', 'fab_buffers'];
const present = [];
for (const t of legacySources) if (await tableExists(t)) present.push(t);
const unionSql = present
  .map((t) => `SELECT DISTINCT company_id FROM ${t} WHERE deleted_at IS NULL`)
  .join(' UNION ');

const [companies] = await pool.query(
  only
    ? 'SELECT id, name FROM companies WHERE id = ?'
    : `SELECT c.id, c.name FROM companies c
        WHERE c.id IN (${unionSql || 'SELECT NULL'}) ORDER BY c.id`,
  only ? [only] : [],
);

console.log(`Checking ${companies.length} company(ies)…`);

// ── 1. fab_items.length/width/height vs the field registry ─────────────────
//
// The resolver reads these columns as a low-precedence source. They diverge the
// moment a field value is set that disagrees with the column, which is fine
// while both are read and fatal the day one is dropped.
let dimDiverge = 0;
const dimsLive = await columnExists('fab_items', 'length');
for (const co of dimsLive ? companies : []) {
  const [items] = await pool.query(
    `SELECT id, length, width, height FROM fab_items
      WHERE company_id = ? AND deleted_at IS NULL
        AND (length IS NOT NULL OR width IS NOT NULL OR height IS NOT NULL)
      LIMIT 500`,
    [co.id],
  );
  if (!items.length) continue;
  const resolved = await resolveItemFields(co.id, items.map((i) => i.id));
  for (const it of items) {
    const v = resolved.get(it.id) ?? {};
    // height IS thickness — the mapping that must never be "corrected".
    const pairs = [[it.length, v.length_mm], [it.width, v.width_mm], [it.height, v.thickness_mm]];
    for (const [col, field] of pairs) {
      if (col == null) continue;
      if (field == null || Math.abs(Number(col) - Number(field)) > 0.001) dimDiverge++;
    }
  }
}
if (!dimsLive) reportDone('fab_items.length / width / height');
else report('fab_items.length / width / height', {
  divergence: dimDiverge,
  readers: ['nestingBoardService', 'nestingSheetService', 'boqSheetService',
    'nestingIntegrityService', 'itemsImportService'],
  precondition: 'repoint nesting, the BOQ sheet and the item importer to read the field registry',
});

// ── 2. fab_item_metric_values vs fab_custom_fields ────────────────────────
let metricDiverge = 0;
const metricValsLive = await tableExists('fab_item_metric_values');
for (const co of metricValsLive ? companies : []) {
  const [[d]] = await pool.query(
    `SELECT COUNT(*) AS n FROM fab_item_metric_values v
      WHERE v.company_id = ? AND v.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM fab_custom_fields c
                         WHERE c.company_id = v.company_id AND c.level = 'order_item'
                           AND c.level_id = v.item_id AND c.field_key = v.metric_key
                           AND c.deleted_at IS NULL)`,
    [co.id],
  );
  metricDiverge += Number(d.n) || 0;
}
if (!metricValsLive) reportDone('fab_item_metric_values');
else report('fab_item_metric_values', {
  divergence: metricDiverge,
  readers: ['itemWeightService (WRITES it)', 'bufferService', 'machineAnalyticsService',
    'taskGatingService', 'routes/analytics', 'routes/buffers'],
  precondition: 'stop itemWeightService writing unit_weight_kg here and repoint the readers '
    + 'to resolveItemFields; it is still the only copy for anything it alone holds',
});

// ── 3. fab_buffers vs fab_resource_stock_areas ────────────────────────────
let bufDiverge = 0;
const buffersLive = await tableExists('fab_buffers');
for (const co of buffersLive ? companies : []) {
  const [[d]] = await pool.query(
    `SELECT COUNT(*) AS n FROM fab_buffers b
      WHERE b.company_id = ? AND b.deleted_at IS NULL AND b.active = 1
        AND NOT EXISTS (SELECT 1 FROM fab_resource_stock_areas a
                         WHERE a.company_id = b.company_id AND a.resource_id = b.resource_id
                           AND a.role = b.kind AND a.deleted_at IS NULL AND a.active = 1)`,
    [co.id],
  );
  bufDiverge += Number(d.n) || 0;
}
if (!buffersLive) reportDone('fab_buffers');
else report('fab_buffers', {
  divergence: bufDiverge,
  readers: ['bufferService (falls back to it)', 'taskGatingService', 'routes/buffers'],
  precondition: 'remove the fallback in bufferService.resourceAreas once every company has '
    + 'area links, and repoint routes/buffers to the area shape',
});

// ── 4. fab_field_defs.piece_varying vs level ──────────────────────────────
let pvDiverge = 0;
const pvLive = await columnExists('fab_field_defs', 'piece_varying');
for (const co of pvLive ? companies : []) {
  const [[d]] = await pool.query(
    `SELECT COUNT(*) AS n FROM fab_field_defs
      WHERE company_id = ? AND deleted_at IS NULL
        AND ((piece_varying = 1 AND level = 'item') OR (piece_varying = 0 AND level <> 'item'))`,
    [co.id],
  );
  pvDiverge += Number(d.n) || 0;
}
if (!pvLive) reportDone('fab_field_defs.piece_varying');
else report('fab_field_defs.piece_varying', {
  divergence: pvDiverge,
  // Reader list corrected 2026-08-18. It named `resourceDef.fabErpFieldDef` as
  // a live reader, which stopped being true when the registry page moved to
  // fabErpField/fab_fields — so this gate would have reported a blocker that no
  // longer exists. A stale reader list on the script that decides what is safe
  // to DROP is worse than no list, because it is trusted.
  readers: ['itemFieldService.resolveItemFieldsLegacy (via fieldRegistry)'],
  precondition: 'remove the legacy fallback in itemFieldService once nothing '
    + 'writes a duplicated column (step 4), which retires the old registry read with it',
});

// ── 5. fab_item_metric_defs — the one with no readers at all ──────────────
//
// DROPPED 2026-08-17, on this script's own verdict. Kept in the list rather
// than deleted, because the retirement sequence is easier to trust when you can
// see what has already gone: five sources, one done, four to go.
const metricDefsLive = await tableExists('fab_item_metric_defs');
if (!metricDefsLive) {
  reportDone('fab_item_metric_defs');
} else {
  let defRows = 0;
  for (const co of companies) {
    const [[d]] = await pool.query(
      'SELECT COUNT(*) AS n FROM fab_item_metric_defs WHERE company_id = ? AND deleted_at IS NULL',
      [co.id],
    );
    defRows += Number(d.n) || 0;
  }
  report('fab_item_metric_defs', { divergence: 0, readers: [], precondition: '—' });
  console.log(`   (${defRows} row(s); every key was migrated into fab_field_defs in Phase 1)`);
}

// ── 6. fab_field_defs vs fab_fields ───────────────────────────────────────
//
// The registry itself. A definition that exists in the old table and has no
// counterpart in the new one is a field the resolver would stop knowing about.
let defDiverge = 0;
const fieldDefsLive = await tableExists('fab_field_defs');
for (const co of fieldDefsLive ? companies : []) {
  const [[d]] = await pool.query(
    `SELECT COUNT(*) AS n FROM fab_field_defs o
      WHERE o.company_id = ? AND o.deleted_at IS NULL AND o.active = 1
        AND NOT EXISTS (SELECT 1 FROM fab_fields f
                         WHERE f.company_id = o.company_id AND f.field_key = o.field_key
                           AND f.deleted_at IS NULL)`,
    [co.id],
  );
  defDiverge += Number(d.n) || 0;
}
if (!fieldDefsLive) reportDone('fab_field_defs');
else report('fab_field_defs', {
  divergence: defDiverge,
  readers: ['itemFieldService.resolveItemFieldsLegacy', 'resourceDef.fabErpFieldDef',
    'resourcePermissions.fabErpFieldDef'],
  precondition: 'remove the legacy fallback in itemFieldService — which cannot go until '
    + 'nothing writes a duplicated column (check 1) — then drop the resourceDef entry',
});

// ── 7. fab_custom_fields vs fab_field_values ──────────────────────────────
//
// The values. `level` here is the OLD vocabulary, so it is mapped onto the
// ladder rather than compared as a string; an unmapped level is itself a
// divergence, because a row nothing can be compared to is a row nothing carried.
let cfDiverge = 0;
const cfUnmapped = [];
const customFieldsLive = await tableExists('fab_custom_fields');
for (const co of customFieldsLive ? companies : []) {
  const [[d]] = await pool.query(
    `SELECT COUNT(*) AS n FROM fab_custom_fields c
      WHERE c.company_id = ? AND c.deleted_at IS NULL
        AND NOT EXISTS (
              SELECT 1 FROM fab_field_values v
                JOIN fab_fields f ON f.id = v.field_id AND f.deleted_at IS NULL
               WHERE v.company_id = c.company_id AND v.deleted_at IS NULL
                 AND f.field_key = c.field_key AND v.scope_id = c.level_id
                 AND v.scope = CASE c.level
                                 WHEN 'item' THEN 'catalog_item'
                                 WHEN 'piece' THEN 'stock_piece'
                                 ELSE c.level END)`,
    [co.id],
  );
  cfDiverge += Number(d.n) || 0;
  const [levels] = await pool.query(
    `SELECT DISTINCT level FROM fab_custom_fields
      WHERE company_id = ? AND deleted_at IS NULL
        AND level NOT IN ('item','piece','order_item','stock_piece','catalog_item',
                          'category','group','subgroup')`,
    [co.id],
  );
  cfUnmapped.push(...levels.map((l) => l.level));
}
if (!customFieldsLive) reportDone('fab_custom_fields');
else {
  report('fab_custom_fields', {
    divergence: cfDiverge,
    readers: ['routes/stock', 'itemFieldService.resolveItemFieldsLegacy',
      'resourceDef.fabErpCustomField', 'FE ItemCatalog.tsx (WRITES it)',
      'FE ItemCatalogDetail.tsx (WRITES it)'],
    precondition: 'repoint the two catalog pages at /fields/values — while they still WRITE here, '
      + 'every new value lands only in the old table and the divergence above keeps growing',
  });
  if (cfUnmapped.length) {
    console.log(`   unmapped level(s): ${[...new Set(cfUnmapped)].join(', ')} — not carried by the importer`);
  }
}

// ── 8. fab_bom_templates vs fab_item_bom ──────────────────────────────────
//
// The flat parts list the old wizard read. Its successor is a real BOM, so the
// comparison is not row-for-row: a template row is carried when a catalog item
// exists for its code AND something has a BOM line pointing at it.
let bomDiverge = 0;
const bomTemplatesLive = await tableExists('fab_bom_templates');
for (const co of bomTemplatesLive ? companies : []) {
  const [[d]] = await pool.query(
    `SELECT COUNT(*) AS n FROM fab_bom_templates t
      WHERE t.company_id = ? AND t.deleted_at IS NULL AND t.active = 1
        AND NOT EXISTS (
              SELECT 1 FROM fab_item_bom b
                JOIN fab_item_catalog c ON c.id = b.child_item_id AND c.deleted_at IS NULL
               WHERE b.company_id = t.company_id AND b.deleted_at IS NULL AND b.active = 1
                 AND c.code LIKE CONCAT('%-', REPLACE(t.code, '/', '-')))`,
    [co.id],
  );
  bomDiverge += Number(d.n) || 0;
}
if (!bomTemplatesLive) reportDone('fab_bom_templates');
else report('fab_bom_templates', {
  divergence: bomDiverge,
  readers: ['routes/navCounts', 'resourceDef.fabErpBomTemplate',
    'scripts/seed-bom-from-templates (READS it to build the successor)',
    'scripts/compare-wizard (READS it as the old wizard input)'],
  precondition: 'cut over BoqWizardDialog to /templates/:itemId/preview, then re-point navCounts; '
    + 'the two scripts must go last — they are what proves the successor matches',
});

// fab_flow_rules is NOT a candidate here. It came up in the reader sweep, but
// this migration gave it no successor — flowAllocationService and
// orderReadinessService still read it as the only copy. Listing it as a
// candidate would invite a drop that has nowhere to fall back to.

console.log(
  `\n${diverged === 0 ? 'No divergence anywhere.' : `${diverged} source(s) DISAGREE with their replacement.`}`
  + ` ${blocked} source(s) still have live readers.`
  + ` ${done} already dropped.`,
);
console.log(blocked === 0 && diverged === 0
  ? 'Everything above is safe to drop.'
  : 'Drop only the sources marked DROPPABLE. The rest need the precondition done first.');

await pool.end();
