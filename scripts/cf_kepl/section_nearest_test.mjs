/**
 * section_nearest_test.mjs — walkthrough 2026-10-18 fixes on the backend (TM/walkthrough/log.md):
 *
 *   cd multi_app_be && node scripts/cf_kepl/section_nearest_test.mjs
 *
 *   1. (18) lib/sectionSize: a section size read in any form ("110 x 110 x 12", "110×110×12mm", "110 110 12",
 *      "L110*110*12", "ISA110", with a grade or a stock length after it), exact matches by the bar's steel, and the
 *      nearest SIZES of the same profile, each with how it differs and heavier / lighter.
 *   2. (18) routes/cutting: GET /section-stock falls back to the size when nothing matches by name; GET
 *      /section-stock/nearest answers { size, exact, nearest, like } — on company 2's own catalog (read only).
 *   3. (7) the freeze checklist WARNS about made rows with no flow (key 'flows', warning: true, the rows listed for
 *      "Give them a flow"), never holds the freeze up, and the warning goes once they are given a flow through
 *      the same bom-changes the screen sends. In one transaction on line CF_CUT_LINE (923), rolled back.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

if (!/^(localhost|127\.0\.0\.1|::1)$/.test(process.env.DB_HOST ?? 'localhost')) throw new Error('This suite is local only.');
const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
await imp('apps/cf_erp/services/codegenProvider.js');
const S = await imp('apps/cf_erp/lib/sectionSize.js');
const { sectionStock, sectionNearest } = await imp('apps/cf_erp/routes/cutting.js');
const LOCK = await imp('apps/cf_erp/services/lockService.js');
const { applyBomChanges } = await imp('apps/cf_erp/services/bomChangeService.js');

const COMPANY = 2;
const LINE = Number(process.env.CF_CUT_LINE ?? 923);
let passed = 0; let failed = 0;
const ok = (label, cond, more = '') => {
  if (typeof label !== 'string' || typeof cond !== 'boolean') throw new Error(`ok(label, boolean) — got ${typeof label}, ${typeof cond}`);
  if (cond) { passed++; console.log(`  PASS  ${label}`); } else { failed++; console.log(`  FAIL  ${label}${more ? ` — ${more}` : ''}`); }
};
const eq = (label, got, want) => ok(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const section = (t) => console.log(`\n${t}`);

/* ---- 1. parsing and the nearest sizes (pure) ---------------------------------------------- */
section('1. A size read in any form; the nearest sizes of the same profile');
eq('"110 x 110 x 12"', S.parseSectionSize('110 x 110 x 12'), { profile: null, dims: [110, 110, 12], lengthMm: null });
eq('"110×110×12mm"', S.parseSectionSize('110×110×12mm'), { profile: null, dims: [110, 110, 12], lengthMm: null });
eq('"110 110 12"', S.parseSectionSize('110 110 12'), { profile: null, dims: [110, 110, 12], lengthMm: null });
eq('"L110*110*12"', S.parseSectionSize('L110*110*12'), { profile: 'L', dims: [110, 110, 12], lengthMm: null });
eq('"ISA110"', S.parseSectionSize('ISA110'), { profile: 'ISA', dims: [110], lengthMm: null });
eq('"ISA 100 x 100 x 12 x 6000 E350 BO": the grade is not a size, the fourth number is the stock length', S.parseSectionSize('ISA 100 x 100 x 12 x 6000 E350 BO'), { profile: 'ISA', dims: [100, 100, 12], lengthMm: 6000 });
eq('"E350" alone is not a size', S.parseSectionSize('E350'), null);
eq('nothing typed', S.parseSectionSize('  '), null);

const bar = (id, d, w, t, grade = 'E250') => ({ id, name: `ISA ${d} x ${w} x ${t} x 10000 ${grade} BO`, code: `B${id}`, depth: d, width: w, thickness: t, lengthMm: 10000, grade });
const bars = [bar(1, 100, 100, 12), bar(2, 100, 100, 12, 'E350'), bar(3, 110, 110, 10), bar(4, 130, 130, 12), bar(5, 150, 115, 10), bar(6, 75, 75, 8),
  { id: 9, name: 'ISMC 100', code: 'C9', depth: 100, width: 50, thickness: 5, lengthMm: 10000, grade: 'E250' }];
const s110 = S.parseSectionSize('110 x 110 x 12');
ok('legs compare in either order', S.sizeMatches(S.parseSectionSize('115 x 150 x 10'), bars[4]));
ok('the thickness must match when typed', !S.sizeMatches(S.parseSectionSize('110x110x12'), bars[2]) && S.sizeMatches(S.parseSectionSize('110x110x10'), bars[2]));
ok('one number: either leg', S.sizeMatches(S.parseSectionSize('ISA115'), bars[4]));
const near = S.nearestSections(s110, bars);
eq('nearest SIZES, best first, one group per size', near.map((g) => g.label), ['100 × 100 × 12', '110 × 110 × 10', '130 × 130 × 12', '150 × 115 × 10', '75 × 75 × 8'].slice(0, near.length));
eq('every bar of a size is in its group (two grades of 100 × 100 × 12)', near[0].bars.map((b) => b.id), [1, 2]);
eq('how each differs, in words', near.slice(0, 3).map((g) => g.differs), ['legs 10 mm smaller', '2 mm thinner', 'legs 20 mm bigger']);
eq('heavier / lighter, with a rough percentage', near.slice(0, 3).map((g) => [g.weight, g.weightPct]), [['lighter', -10], ['lighter', -16], ['heavier', 19]]);
ok('same profile only: the ISMC channel is never offered for an angle', near.every((g) => g.profile === 'ISA'));
eq('unequal legs said leg by leg', S.nearestSections(S.parseSectionSize('150x100x10'), [bars[4]])[0].differs, 'long leg the same, short leg 15 mm bigger');
eq('nothing typed, nothing near', S.nearestSections(null, bars), []);

/* ---- 2. on the catalog (company 2, read only) ----------------------------------------------- */
section('2. GET /section-stock falls back to the size; GET /section-stock/nearest');
const byName = await sectionStock(pool, COMPANY, { search: '75x75x8', limit: 200 });
const bySize = await sectionStock(pool, COMPANY, { search: '75 75 8', limit: 200 });
ok('"75 75 8" (no x) finds what "75x75x8" finds', byName.length > 0 && JSON.stringify(bySize.map((b) => b.id).sort()) === JSON.stringify(byName.map((b) => b.id).sort()), `${byName.length} vs ${bySize.length}`);
const byL = await sectionStock(pool, COMPANY, { search: 'L75*75*8', limit: 200 });
ok('"L75*75*8" too (the catalog says ISA)', byL.length === byName.length);
const missing = await sectionStock(pool, COMPANY, { search: '110 x 110 x 12', limit: 50 });
const n110 = await sectionNearest(pool, COMPANY, { search: '110 x 110 x 12' });
ok('a size the catalog does not have: the search finds nothing, and nearest says the size', missing.length === 0 && JSON.stringify(n110.size?.dims) === '[110,110,12]', JSON.stringify(n110.size));
ok('…no exact bar, and nearest sizes listed, each with its bars', n110.exact.length === 0 && n110.nearest.length > 0 && n110.nearest.every((g) => g.bars.length > 0 && typeof g.differs === 'string'), JSON.stringify(n110.nearest.map((g) => g.label)));
ok('…the closest first: 100 × 100 × 12 or 110 × 110 × 10 (one step away)', ['100 × 100 × 12', '110 × 110 × 10'].includes(n110.nearest[0]?.label), n110.nearest[0]?.label);
ok('…all of one profile (angles)', new Set(n110.nearest.map((g) => g.profile)).size === 1);
ok('…and the bar a new size would be made like', n110.like?.id === n110.nearest[0].bars[0].id);
const n75 = await sectionNearest(pool, COMPANY, { search: 'ISA 75 x 75 x 8' });
ok('an existing size: its bars are exact', n75.exact.length === byName.length && n75.exact.every((b) => Number(b.depth) === 75 && Number(b.thickness) === 8));
eq('not a size: nothing', await sectionNearest(pool, COMPANY, { search: 'E350' }), { size: null, exact: [], nearest: [], like: null });

/* ---- 3. the freeze checklist warns about rows with no flow ---------------------------------- */
section('3. Freeze design: made rows with no flow are a WARNING, with the rows, and never hold the freeze up');
const conn = await pool.getConnection();
try {
  await conn.beginTransaction();
  const c = { companyId: COMPANY, userId: null };
  const [[line]] = await conn.query('SELECT id, locked_at FROM cf_sales_order_lines WHERE company_id = ? AND id = ?', [COMPANY, LINE]);
  if (!line) throw new Error(`Line ${LINE} is not on company ${COMPANY}.`);
  await conn.query('UPDATE cf_sales_order_lines SET locked_at = NULL WHERE id = ?', [LINE]);
  const before = await LOCK.lockPlan(conn, COMPANY, LINE);
  const flowsBefore = before.checks.find((ch) => ch.key === 'flows');
  // One made row of the line, not a cut piece, that has a flow now — its flow taken away.
  const [[row]] = await conn.query(
    `SELECT bl.id AS line_id, bl.child_id, m.name FROM cf_bom_lines bl
       JOIN cf_boms b ON b.id = bl.bom_id AND b.deleted_at IS NULL
       JOIN cf_master_records m ON m.id = bl.child_id AND m.deleted_at IS NULL
       JOIN cf_item_details d ON d.master_id = m.id AND d.owner_order_line_id = ? AND d.deleted_at IS NULL
      WHERE bl.deleted_at IS NULL AND (bl.role IS NULL OR bl.role NOT IN ('Cut from', 'Raw plate'))
        AND (bl.operation_flow_id IS NOT NULL OR m.default_flow_id IS NOT NULL)
        AND EXISTS (SELECT 1 FROM cf_boms b2 JOIN cf_bom_lines k ON k.bom_id = b2.id AND k.deleted_at IS NULL WHERE b2.parent_id = m.id AND b2.deleted_at IS NULL)
      ORDER BY bl.id LIMIT 1`,
    [LINE],
  );
  if (!row) throw new Error(`Line ${LINE} has no made row with a flow to take away.`);
  const [[flowOf]] = await conn.query('SELECT COALESCE(bl.operation_flow_id, m.default_flow_id) AS flow_id FROM cf_bom_lines bl JOIN cf_master_records m ON m.id = bl.child_id WHERE bl.id = ?', [row.line_id]);
  await conn.query('UPDATE cf_bom_lines SET operation_flow_id = NULL WHERE child_id = ? AND deleted_at IS NULL', [row.child_id]);
  await conn.query('UPDATE cf_master_records SET default_flow_id = NULL WHERE id = ?', [row.child_id]);
  const after = await LOCK.lockPlan(conn, COMPANY, LINE);
  const w = after.checks.find((ch) => ch.key === 'flows');
  ok('a check "flows" appears, as a warning', !!w && w.warning === true && w.ok === false && w.applies === true, JSON.stringify(w));
  ok('it lists the row, with its BOM line (what "Give them a flow" sends)', !!w?.rows?.some((r) => r.recordId === Number(row.child_id) && r.lineId === Number(row.line_id)), JSON.stringify(w?.rows));
  ok('it says release will ask, and that freezing is not held up', /no flow yet/.test(w?.detail ?? '') && /release will ask/i.test(w?.detail ?? '') && /not held up/.test(w?.detail ?? ''), w?.detail);
  ok('it is not among the problems that refuse the freeze', !after.problems.some((p) => /has no flow|have no flow/.test(p)), after.problems.join(' | '));
  eq('can the line be frozen? the same as before', after.canLock, before.canLock);
  ok('before the flow was taken away it was not said for that row', !flowsBefore?.rows?.some((r) => r.recordId === Number(row.child_id)));
  // "Give them a flow": the bom-changes the dialog sends, for that row's line.
  await applyBomChanges(conn, c, { scope: { orderLineId: LINE }, changes: [{ op: 'flow', lineId: Number(row.line_id), flowId: Number(flowOf.flow_id) }] });
  const given = await LOCK.lockPlan(conn, COMPANY, LINE);
  ok('given a flow, the row is no longer listed', !given.checks.find((ch) => ch.key === 'flows')?.rows?.some((r) => r.recordId === Number(row.child_id)));
} finally {
  await conn.query('ROLLBACK').catch(() => {});
  conn.release();
}

await pool.end();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
