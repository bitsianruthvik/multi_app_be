/**
 * compare-wizard.mjs — the old wizard against the new one, same inputs.
 *
 * Step 7's gate, and the one thing in this whole migration a verifier cannot
 * settle on its own. Everything else has an objective answer — do the values
 * match, do the estimates change, does the matcher pick the same plate. "Is the
 * structure this produces the right structure" is a judgement about a real span,
 * and it belongs to whoever knows what a real span looks like.
 *
 * So this does not PASS or FAIL. It prints both, aligned, and says where they
 * differ. Read it before the old path is removed.
 *
 *   OLD  buildWizardRows()      a hardcoded four-level nest: span / girders /
 *                               segmentsPerGirder / parts, with an if(!girders)
 *                               branch for a PEB and defaults typed into React
 *   NEW  bomService.expand()    whatever the BOM says, at whatever depth
 *
 * Usage:  node scripts/compare-wizard.mjs [companyId]
 */

import { pool } from '../db.js';
import { buildWizardRows } from '../apps/fab_erp/services/boqSheetService.js';
import { expand, flatten } from '../apps/fab_erp/services/bomService.js';

const CO = Number(process.argv[2]) || 30005;

const [[template]] = await pool.query(
  `SELECT id, code, name FROM fab_item_catalog
    WHERE company_id = ? AND code = 'COMPOS-SPAN' AND deleted_at IS NULL LIMIT 1`,
  [CO],
);
if (!template) { console.error('No COMPOS-SPAN template — run seed-bom-from-templates.mjs first.'); process.exit(1); }

// The parts the OLD wizard was given, from the table it read them out of.
const [parts] = await pool.query(
  `SELECT code, name, qty FROM fab_bom_templates
    WHERE company_id = ? AND line_type = 'Composite Girder' AND deleted_at IS NULL AND active = 1
    ORDER BY sort_order`,
  [CO],
);

const CASES = [
  { label: 'a six-girder span, five segments each', girders: 6, segs: 5, counts: null },
  { label: 'uneven girders (the segmentCounts case)', girders: 6, segs: 5, counts: [4, 5, 5, 5, 5, 4] },
  { label: 'a PEB — no girders at all', girders: 0, segs: 0, counts: null },
  { label: 'girders but no segments', girders: 3, segs: 0, counts: null },
];

for (const c of CASES) {
  console.log(`\n${'═'.repeat(72)}\n${c.label}\n${'═'.repeat(72)}`);

  // ── OLD ────────────────────────────────────────────────────────────────
  const oldRows = buildWizardRows({
    spanCode: 'SPANA',
    girders: c.girders,
    segmentsPerGirder: c.segs,
    segmentCounts: c.counts,
    parts: parts.map((p) => ({ code: p.code, name: p.name, qty: p.qty })),
  });
  // The sheet is flat; a row with a blank Part declares the level above it.
  const oldLevels = { span: 0, girder: 0, segment: 0, part: 0 };
  for (const r of oldRows) {
    if (r.part) oldLevels.part++;
    else if (r.segment) oldLevels.segment++;
    else if (r.girder) oldLevels.girder++;
    else oldLevels.span++;
  }

  // ── NEW ────────────────────────────────────────────────────────────────
  const tree = await expand(
    CO, template.id,
    { girders: c.girders, segmentsPerGirder: c.segs },
    c.counts ? { perInstance: { segmentsPerGirder: c.counts } } : {},
  );
  const newLevels = { span: 0, girder: 0, segment: 0, part: 0 };
  for (const [name, n] of Object.entries(tree.byName)) {
    if (name === 'Span') newLevels.span += n;
    else if (name === 'Girder') newLevels.girder += n;
    else if (name === 'Segment') newLevels.segment += n;
    else newLevels.part += n;
  }

  const row = (k) => {
    const o = oldLevels[k];
    const n = newLevels[k];
    const mark = o === n ? ' ' : '  <-- DIFFERS';
    return `   ${k.padEnd(10)} old ${String(o).padStart(4)}   new ${String(n).padStart(4)}${mark}`;
  };
  console.log(['span', 'girder', 'segment', 'part'].map(row).join('\n'));
  console.log(`   ${'total'.padEnd(10)} old ${String(oldRows.length).padStart(4)}   new ${String(tree.nodes).padStart(4)}`);

  // Codes, which is where a difference would actually bite: an item code that
  // does not match the one already on the order is a code nobody can find.
  const newCodes = flatten(tree.root)
    .filter((r) => /-(TF|WP|BF|BS|IS)$/.test(r.code))
    .slice(0, 3)
    .map((r) => r.code.replace(`${template.code}-`, 'SPANA-'));
  const oldCodes = oldRows
    .filter((r) => r.part)
    .slice(0, 3)
    .map((r) => [r.span, r.girder, r.segment, r.part].filter(Boolean).join('-'));
  console.log(`\n   old codes: ${oldCodes.join('  ') || '(none)'}`);
  console.log(`   new codes: ${newCodes.join('  ') || '(none)'}`);
}

console.log(`\n${'─'.repeat(72)}`);
console.log('The counts and codes above are the whole comparison. Nothing here');
console.log('passes or fails on its own — decide whether the new column is the');
console.log('structure you want before the old wizard is removed.');
await pool.end();
