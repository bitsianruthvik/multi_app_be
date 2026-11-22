/**
 * stock_filter_test.mjs — Stores › Stock read for several families / sub-families / variants at once (2026-11-23), and
 * every row at once for printing (all=1).   cd multi_app_be && node scripts/cf_kepl/stock_filter_test.mjs   (reads only)
 */
import path from 'path';
import { pathToFileURL } from 'url';

const imp = (p) => import(pathToFileURL(path.join(process.cwd(), p)).href);
const { pool } = await imp('db.js');
const D = await imp('apps/cf_erp/services/storesDeskService.js');
const COMPANY = Number(process.env.CF_COMPANY ?? 2);
let pass = 0; let fail = 0;
const ok = (name, cond, detail = '') => { if (cond) { pass += 1; console.log(`  ok   ${name}`); } else { fail += 1; console.log(`  FAIL ${name} ${detail}`); } };
try {
  const base = await D.ledger(pool, COMPANY, { paged: 1, limit: 1, show: 'all' });
  const groups = base.counts.groups;
  ok('the groups come a variant a row, with family and sub-family', groups.length > 0 && groups.every((g) => g.variantId != null && g.subfamilyId != null && g.familyId != null));
  const fams = [...new Set(groups.map((g) => g.familyId))];
  const twoFams = fams.slice(0, 2);
  const r1 = await D.ledger(pool, COMPANY, { paged: 1, all: 1, show: 'all', familyIds: twoFams.join(',') });
  const want1 = groups.filter((g) => twoFams.includes(g.familyId)).reduce((t, g) => t + g.items, 0);
  ok(`two families: every item of both (${want1}), nothing else`, r1.total === want1 && r1.rows.every((r) => twoFams.includes(r.group.familyId)), JSON.stringify([r1.total, want1]));
  ok('all=1 gives every row in one go', r1.rows.length === r1.total);
  // a family and ONE sub-family inside it + another whole family: the picked sub-family narrows its own family only
  const f0 = twoFams[0]; const sub0 = groups.find((g) => g.familyId === f0).subfamilyId;
  const r2 = await D.ledger(pool, COMPANY, { paged: 1, all: 1, show: 'all', familyIds: twoFams.join(','), subfamilyIds: String(sub0) });
  const want2 = groups.filter((g) => g.subfamilyId === sub0 || (twoFams[1] != null && g.familyId === twoFams[1])).reduce((t, g) => t + g.items, 0);
  ok('a sub-family picked under one family narrows that family only', r2.total === want2 && r2.rows.every((r) => r.group.subfamilyId === sub0 || r.group.familyId === twoFams[1]), JSON.stringify([r2.total, want2]));
  const v0 = groups[groups.length - 1];
  const r3 = await D.ledger(pool, COMPANY, { paged: 1, all: 1, show: 'all', variantIds: String(v0.variantId) });
  ok('one variant: its items, each row saying its variant', r3.total === v0.items && r3.rows.every((r) => r.group.variantId === v0.variantId && r.group.variant === v0.variant), JSON.stringify([r3.total, v0.items]));
} catch (e) { fail += 1; console.log('  FAIL (threw)', e?.message); } finally {
  console.log(`\n${pass} passed, ${fail} failed`);
  await pool.end(); process.exit(fail ? 1 : 0);
}
