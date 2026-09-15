/**
 * kepl-finish.mjs — the last two steps of the order, for real this time.
 *
 *   1. The derived formula inputs, from the geometry the BOQ gave.
 *   2. Nesting SUGGESTED AND ACCEPTED. `suggestNesting` writes nothing by
 *      design, so an earlier run produced a plate list that existed only in its
 *      own output — the order still read "1090 of 1090 parts have no material".
 *      Accepting is what creates the links and the nest numbers.
 *
 * TWO FIELDS ARE DELIBERATELY LEFT EMPTY. `num_holes` and `weld_length_m` are
 * not in the BOQ — a part is named "…Hole" but never counted, and weld length
 * appears nowhere. They come off the fabrication drawings. Filling them with a
 * plausible number would put invented durations into the schedule and onto the
 * floor, so the stage stays amber and says what it wants.
 *
 *   node scripts/kepl-finish.mjs <orderId> [--apply]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const APPLY = process.argv.includes('--apply');
const orderId = Number(process.argv[2]);
const __dir = path.dirname(fileURLToPath(import.meta.url));
const env = {};
fs.readFileSync(path.join(__dir, '..', '..', '.env.tidb'), 'utf8').split('\n').forEach((l) => {
  l = l.trim(); if (!l || l.startsWith('#')) return;
  const [k, ...r] = l.split('='); env[k.trim()] = r.join('=').trim();
});
Object.assign(process.env, {
  DB_HOST: env.DB_HOST, DB_PORT: env.DB_PORT ?? '4000', DB_USER: env.DB_USER,
  DB_PASSWORD: env.DB_PASSWORD, DB_NAME: env.DB_NAME, DB_SSL: 'true',
});
const { pool } = await import('../db.js');
const { setFields } = await import('../apps/fab_erp/services/fieldService.js');
const { suggestNesting, acceptSuggestion } = await import('../apps/fab_erp/services/nestingSuggestService.js');
const { orderReadiness } = await import('../apps/fab_erp/services/orderReadinessService.js');
const { nestTotals } = await import('../apps/fab_erp/services/nestTotalsService.js');

const COMPANY = 30005;

// ── 1. the formula inputs that follow from the geometry ────────────────────
/**
 * THE POOL GOES STALE DURING THE NEST, and the first write after it fails.
 *
 * A deep nest is minutes of pure computation with no queries in between, which
 * is long enough for TiDB Cloud to close the idle connection. The suggestion
 * finished, `acceptSuggestion` opened with ECONNRESET, and the whole plate list
 * was lost — 129 plates computed and nothing written.
 *
 * So anything that runs after the nest goes through here: wake the pool, and
 * retry once if the connection was dead rather than the query wrong.
 */
async function withLiveConnection(fn, label) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await pool.query('SELECT 1');
      return await fn();
    } catch (err) {
      const dead = ['ECONNRESET', 'PROTOCOL_CONNECTION_LOST', 'EPIPE', 'ETIMEDOUT'].includes(err.code);
      if (!dead || attempt === 3) throw err;
      console.log(`   ${label}: connection dropped (${err.code}), reconnecting — attempt ${attempt + 1}`);
      await new Promise((r) => { setTimeout(r, 2000); });
    }
  }
  return null;
}

const SKIP_FIELDS = process.argv.includes('--skip-fields');
const [rows] = SKIP_FIELDS ? [[]] : await pool.query(
  `SELECT id, length, width, height, COALESCE(unit_weight, computed_unit_weight) AS uw
     FROM fab_items
    WHERE company_id=? AND order_id=? AND deleted_at IS NULL
      AND node_kind='structure' AND is_leaf=1 AND COALESCE(procurement_type,'make')='make'`,
  [COMPANY, orderId]);
const sized = rows.filter((r) => Number(r.length) > 0 && Number(r.width) > 0);
console.log(SKIP_FIELDS ? 'step 1 — derived fields: skipped (already written)'
  : `step 1 — derived fields: ${sized.length} made leaves with geometry (${rows.length - sized.length} without)`);

if (APPLY) {
  let n = 0;
  for (const r of sized) {
    const L = Number(r.length); const W = Number(r.width); const t = Number(r.height) || 0;
    const vals = {
      // The cut perimeter, in metres — what a cutting rate multiplies.
      edge_length_m: Number((2 * (L + W) / 1000).toFixed(3)),
      // Both faces plus the edge band — what blasting and painting rates use.
      surface_area_m2: Number(((2 * L * W + 2 * t * (L + W)) / 1e6).toFixed(4)),
    };
    if (r.uw != null) vals.unit_weight_kg = Number(Number(r.uw).toFixed(3));
    await setFields(COMPANY, 'order_item', r.id, vals);
    if ((++n % 200) === 0) console.log(`   ${n}/${sized.length}`);
  }
  console.log(`   wrote ${n}`);
}

// ── 2. nest, and ACCEPT — this is the part that was missing ────────────────
console.log('\nstep 2 — nesting at deep…');
const s = await suggestNesting(COMPANY, orderId, { effort: 'deep' });
if (s.message) { console.log(`   suggestor: ${s.message}`); await pool.end(); process.exit(1); }
console.log(`   proposed ${s.groups.length} plates · ${s.unplaced?.length ?? 0} unplaced`);
console.log(`   ${JSON.stringify(s.summary)}`);

if (APPLY) {
  const res = await withLiveConnection(() => acceptSuggestion(COMPANY, orderId, s.groups), 'accept');
  console.log(`   accepted: ${JSON.stringify(res)}`);
  const { totals } = await withLiveConnection(() => nestTotals(COMPANY, orderId), 'totals');
  console.log(`   material now on the order: ${JSON.stringify(totals)}`);
}

if (!APPLY) { console.log('\nDRY RUN — pass --apply.'); await pool.end(); process.exit(0); }

const r = await withLiveConnection(() => orderReadiness(COMPANY, orderId), 'readiness');
console.log('\nreadiness:');
for (const st of r.stages) console.log(`  ${st.state === 'done' ? '[x]' : st.state === 'partial' ? '[~]' : '[ ]'} ${String(st.label).padEnd(13)} ${st.detail}`);
await pool.end();
