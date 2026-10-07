/**
 * section_packer_test.mjs — the 1-D section packer (services/sectionPacker.js,
 * CF_ERP_CUT_FROM_PLAN.md §4.2). Pure: no database.
 *
 *   cd multi_app_be && node scripts/cf_kepl/section_packer_test.mjs
 *
 * Every expected number below is worked out by hand in the comment beside it.
 */
import { packBars, barLayout, EXACT_MAX_PIECES } from '../../apps/cf_erp/services/sectionPacker.js';

let passed = 0;
let failed = 0;
function ok(label, condition, detail = '') {
  if (typeof label !== 'string' || typeof condition !== 'boolean') throw new Error('ok(label, condition) takes a string and then a boolean');
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${!condition && detail ? ` — ${detail}` : ''}`);
  condition ? passed++ : failed++;
}
const section = (s) => console.log(`\n${s}`);
const refusal = (fn) => { try { fn(); return null; } catch (e) { return e; } };
const NO_TRIM = { sawKerfMm: 0, endTrimMm: 0, minOffcutMm: 1e9 };
const SHOP = { sawKerfMm: 3, endTrimMm: 10, minOffcutMm: 500 };
const placedCount = (plan) => plan.bars.reduce((a, b) => a + b.cuts.length, 0);
/** Every bar of a plan re-checked with the one layout rule, and its cut positions too. */
function barsValid(plan, settings) {
  for (const b of plan.bars) {
    const lay = barLayout(b.lengthMm, b.cuts.map((c) => c.lengthMm), settings);
    if (!lay.fits) return `bar ${b.lengthMm} over by ${lay.overByMm}`;
    if (b.cuts.some((c, i) => Math.abs(c.xMm - lay.xs[i]) > 1e-6)) return 'a cut is not where the rule puts it';
    if (Math.abs(lay.wasteMm - b.wasteMm) > 1e-6 || Math.abs(lay.keptOffcutMm - b.keptOffcutMm) > 1e-6) return 'waste / kept disagree';
  }
  return null;
}

section('1. Kerf and trim arithmetic (barLayout)');
{
  // 6000 bar, two 2000 cuts, kerf 3, trim 10, keep ≥ 500:
  //   x = 10 and 10 + 2000 + 3 = 2013; leftover = 6000 − 10 − 4000 − 2·3 = 1984 (kept);
  //   waste = 6000 − 4000 − 1984 = 16 (one trim of 10 + two kerfs).
  const a = barLayout(6000, [2000, 2000], SHOP);
  ok('two 2000 cuts start at 10 and 2013', a.xs[0] === 10 && a.xs[1] === 2013, JSON.stringify(a.xs));
  ok('the 1984 mm leftover is kept as an offcut', a.keptOffcutMm === 1984, String(a.keptOffcutMm));
  ok('waste is 16 mm (trim + 2 kerfs)', a.wasteMm === 16, String(a.wasteMm));
  // 2 × 2990 + 1 kerf = 5983 > 6000 − 2·10 = 5980: does not fit, by 3 mm.
  const b = barLayout(6000, [2990, 2990], SHOP);
  ok('2 × 2990 does not fit a 6000 bar (5983 > 5980)', !b.fits && b.overByMm === 3, JSON.stringify(b));
  // 2 × 2988.5 + 3 = 5980: exactly fits; leftover 6000 − 10 − 5977 − 6 = 7 < 500 → waste 23.
  const c = barLayout(6000, [2988.5, 2988.5], SHOP);
  ok('2 × 2988.5 fits exactly; the 7 mm leftover is waste (23 mm)', c.fits && c.keptOffcutMm === 0 && c.wasteMm === 23, JSON.stringify(c));
}

section('2. Kerf and trim in a plan');
{
  const two = packBars({ pieces: [{ id: 1, lengthMm: 2990, qty: 2 }], stock: [{ itemId: 6, lengthMm: 6000 }], settings: SHOP });
  ok('2 × 2990 need two 6 m bars', two.barsBought === 2, JSON.stringify(two.bars.map((b) => b.cuts.length)));
  const one = packBars({ pieces: [{ id: 1, lengthMm: 2988.5, qty: 2 }], stock: [{ itemId: 6, lengthMm: 6000 }], settings: SHOP });
  ok('2 × 2988.5 share one 6 m bar', one.barsBought === 1 && one.bars[0].cuts.length === 2);
  ok('...the second cut starts at 10 + 2988.5 + 3 = 3001.5', one.bars[0].cuts[1].xMm === 3001.5, String(one.bars[0].cuts[1].xMm));
}

section('3. Exact optimum on a small set (where first-fit decreasing is wrong)');
{
  // One 10 m stock length, no kerf / trim. Pieces 5, 4, 4, 3, 2, 2 m (20 m in all).
  // Two bars are enough: 5+3+2 and 4+4+2. FFD puts 5+4 together and needs three.
  const input = { pieces: [{ id: 'A', lengthMm: 5000, qty: 1 }, { id: 'B', lengthMm: 4000, qty: 2 }, { id: 'C', lengthMm: 3000, qty: 1 }, { id: 'D', lengthMm: 2000, qty: 2 }], stock: [{ itemId: 10, lengthMm: 10000 }], settings: NO_TRIM };
  const exact = packBars(input);
  ok('exact search: two bars', exact.barsBought === 2 && exact.exact === true, `${exact.barsBought} (${exact.method})`);
  ok('...every piece placed once', placedCount(exact) === 6);
  // Plain first-fit decreasing (one stock length, no offcuts) would need three: 5+4 | 4+3+2 | 2.
  const ffd = packBars({ ...input, exactMaxPieces: 0 });
  ok('the fullest-bar heuristic finds two as well (FFD alone would need three)', ffd.barsBought === 2, String(ffd.barsBought));
  ok(`exact threshold is ${EXACT_MAX_PIECES} pieces`, EXACT_MAX_PIECES === 18);
}

section('4. Exact = brute force, on 40 random small sets');
{
  // Brute force minimum number of bins (one stock length, no kerf / trim).
  const minBins = (sizes, cap) => {
    const s = sizes.slice().sort((a, b) => b - a);
    let best = s.length;
    const bins = [];
    const go = (i) => {
      if (bins.length >= best) return;
      if (i === s.length) { best = bins.length; return; }
      const seen = new Set();
      for (let j = 0; j < bins.length; j++) {
        if (bins[j] + s[i] > cap || seen.has(bins[j])) continue;
        seen.add(bins[j]); bins[j] += s[i]; go(i + 1); bins[j] -= s[i];
      }
      bins.push(s[i]); go(i + 1); bins.pop();
    };
    go(0);
    return best;
  };
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  let agree = 0; let firstBad = null;
  for (let trial = 0; trial < 40; trial++) {
    const count = 3 + Math.floor(rnd() * 7);
    const sizes = Array.from({ length: count }, () => 500 * (1 + Math.floor(rnd() * 11)));
    const plan = packBars({ pieces: sizes.map((l, i) => ({ id: i + 1, lengthMm: l, qty: 1 })), stock: [{ itemId: 1, lengthMm: 6000 }], settings: NO_TRIM });
    const want = minBins(sizes, 6000);
    if (plan.barsBought === want) agree++; else firstBad ??= `${sizes.join(',')}: ${plan.barsBought} vs ${want}`;
  }
  ok('the packer matches the brute-force minimum every time', agree === 40, firstBad ?? '');
}

section('5. Reusable offcuts first');
{
  // 3 × 2500 from 6 m bars needs two bars (12 m); with a free 3000 offcut, one bar + the offcut.
  const plan = packBars({ pieces: [{ id: 7, lengthMm: 2500, qty: 3 }], stock: [{ itemId: 6, lengthMm: 6000 }], offcuts: [{ offcutId: 91, lengthMm: 3000 }], settings: NO_TRIM });
  ok('one bar bought, one piece on the offcut', plan.barsBought === 1 && plan.barsFromOffcuts === 1, JSON.stringify(plan.bars.map((b) => [b.source, b.cuts.length])));
  ok('the offcut bar is listed first and named', plan.bars[0].source === 'offcut' && plan.bars[0].offcutId === 91);
  ok('cost is one 6 m bar (an offcut costs nothing)', plan.cost === 6000, String(plan.cost));
  // An offcut too short for anything is simply not used.
  const none = packBars({ pieces: [{ id: 7, lengthMm: 2500, qty: 2 }], stock: [{ itemId: 6, lengthMm: 6000 }], offcuts: [{ offcutId: 92, lengthMm: 1000 }], settings: NO_TRIM });
  ok('an offcut shorter than every piece is left alone', none.barsFromOffcuts === 0 && none.barsBought === 1);
  // Kept offcuts: a 12 m bar with 4 m on it keeps the rest (≥ 500).
  const kept = packBars({ pieces: [{ id: 1, lengthMm: 4000, qty: 1 }], stock: [{ itemId: 12, lengthMm: 12000 }], settings: SHOP });
  // leftover = 12000 − 10 − 4000 − 3 = 7987 kept; waste = 12000 − 4000 − 7987 = 13.
  ok('a 12 m bar cut once keeps a 7987 mm offcut, wastes 13 mm', kept.bars[0].keptOffcutMm === 7987 && kept.wasteMm === 13, JSON.stringify(kept.bars[0]));
}

section('6. Several stock lengths: 6 m or 12 m');
{
  const stock = [{ itemId: 6, lengthMm: 6000 }, { itemId: 12, lengthMm: 12000 }];
  // 3 × 4000: one 12 m bar holds all three (cost 12000); 6 m bars hold one each (18000).
  const a = packBars({ pieces: [{ id: 1, lengthMm: 4000, qty: 3 }], stock, settings: NO_TRIM });
  ok('3 × 4 m: one 12 m bar', a.barsBought === 1 && a.bars[0].itemId === 12, JSON.stringify(a.bars.map((b) => b.itemId)));
  // One 5 m piece: a 6 m bar, not a 12 m one.
  const b = packBars({ pieces: [{ id: 1, lengthMm: 5000, qty: 1 }], stock, settings: NO_TRIM });
  ok('1 × 5 m: a 6 m bar', b.barsBought === 1 && b.bars[0].itemId === 6);
  // Both: 3 × 4 m on a 12 m, the 5 m on a 6 m — cost 18000 (two 12 m bars would be 24000).
  const c = packBars({ pieces: [{ id: 1, lengthMm: 4000, qty: 3 }, { id: 2, lengthMm: 5000, qty: 1 }], stock, settings: NO_TRIM });
  ok('3 × 4 m + 5 m: one 12 m and one 6 m (cost 18000)', c.cost === 18000 && c.bars.map((x) => x.itemId).sort().join(',') === '12,6', `${c.cost} ${JSON.stringify(c.bars.map((x) => x.itemId))}`);
  // Prices change the answer: a 12 m bar priced 3.1× a 6 m one makes three 6 m bars cheaper.
  const d = packBars({ pieces: [{ id: 1, lengthMm: 4000, qty: 3 }], stock: [{ itemId: 6, lengthMm: 6000, value: 100 }, { itemId: 12, lengthMm: 12000, value: 310 }], settings: NO_TRIM });
  ok('priced: three 6 m bars (300) beat one 12 m bar (310)', d.barsBought === 3 && d.cost === 300 && d.bars.every((x) => x.itemId === 6), `${d.cost}`);
}

section('7. A piece longer than every bar is refused, in words');
{
  const e = refusal(() => packBars({ pieces: [{ id: 5, code: 'IBF', lengthMm: 13200, qty: 1 }], stock: [{ itemId: 1, lengthMm: 6000 }, { itemId: 2, lengthMm: 12000 }], settings: SHOP, label: 'ISMB 600' }));
  ok('refused with TOO_LONG', e?.code === 'TOO_LONG', e?.message);
  ok('...naming the piece, the profile and the longest bar', /IBF 13,200 mm is longer than any ISMB 600 bar — 12,000 mm is the longest/.test(e?.message ?? ''), e?.message);
  // Trim counts: 11,990 does not fit a 12 m bar with 10 mm off each end.
  const t = refusal(() => packBars({ pieces: [{ id: 5, code: 'X1', lengthMm: 11990, qty: 1 }], stock: [{ itemId: 2, lengthMm: 12000 }], settings: SHOP, label: 'ISA 75' }));
  ok('11,990 mm on a 12 m bar is refused because of the trims', t?.code === 'TOO_LONG' && /11,980 mm after the 10 mm trim/.test(t.message), t?.message);
  const nostock = refusal(() => packBars({ pieces: [{ id: 5, lengthMm: 100, qty: 1 }], stock: [], settings: SHOP }));
  ok('no stock length at all is refused', nostock?.code === 'NO_STOCK');
}

section('8. Deterministic');
{
  const pieces = [{ id: 3, lengthMm: 1500, qty: 4 }, { id: 1, lengthMm: 2750, qty: 3 }, { id: 2, lengthMm: 900, qty: 5 }, { id: 4, lengthMm: 4100, qty: 2 }];
  const stock = [{ itemId: 12, lengthMm: 12000 }, { itemId: 6, lengthMm: 6000 }, { itemId: 9, lengthMm: 9000 }];
  const offcuts = [{ offcutId: 2, lengthMm: 2000 }, { offcutId: 1, lengthMm: 3200 }];
  const a = JSON.stringify(packBars({ pieces, stock, offcuts, settings: SHOP }));
  const b = JSON.stringify(packBars({ pieces: pieces.slice().reverse(), stock: stock.slice().reverse(), offcuts: offcuts.slice().reverse(), settings: SHOP }));
  const c = JSON.stringify(packBars({ pieces, stock, offcuts, settings: SHOP }));
  ok('same input (in any order) gives the same bars', a === b && a === c);
}

section('9. A 200-piece profile finishes fast and places everything legally');
{
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const pieces = Array.from({ length: 40 }, (_, i) => ({ id: i + 1, code: `P${i + 1}`, lengthMm: 300 + Math.round(rnd() * 5500), qty: 5 }));
  const stock = [{ itemId: 6, lengthMm: 6000 }, { itemId: 9, lengthMm: 9000 }, { itemId: 10, lengthMm: 10000 }, { itemId: 12, lengthMm: 12000 }];
  const offcuts = [{ offcutId: 1, lengthMm: 2500 }, { offcutId: 2, lengthMm: 4100 }];
  const t0 = Date.now();
  const plan = packBars({ pieces, stock, offcuts, settings: SHOP });
  const ms = Date.now() - t0;
  ok(`200 pieces packed in ${ms} ms (under 3 s)`, ms < 3000);
  ok('every one of the 200 pieces is placed once', placedCount(plan) === 200);
  const bad = barsValid(plan, SHOP);
  ok('every bar obeys kerf and trim', bad == null, bad ?? '');
  const parts = pieces.reduce((a, p) => a + p.lengthMm * p.qty, 0);
  const bought = plan.bars.filter((b) => b.source === 'catalog').reduce((a, b) => a + b.lengthMm, 0);
  ok(`bought ${bought} mm for ${parts} mm of pieces (under 115%)`, bought <= parts * 1.15, `${(bought / parts * 100).toFixed(1)}%`);
  ok('a heuristic answered (above the exact threshold)', plan.exact === false && !/exact/.test(plan.method), plan.method);
}

section('10. Small exact plans are legal too');
{
  const plan = packBars({ pieces: [{ id: 1, lengthMm: 1234, qty: 5 }, { id: 2, lengthMm: 2222, qty: 4 }], stock: [{ itemId: 6, lengthMm: 6000 }, { itemId: 12, lengthMm: 12000 }], offcuts: [{ offcutId: 4, lengthMm: 2600 }], settings: SHOP });
  ok('exact plan: every bar obeys kerf and trim', barsValid(plan, SHOP) == null, barsValid(plan, SHOP) ?? '');
  ok('exact plan: all 9 pieces placed', placedCount(plan) === 9 && plan.exact === true, plan.method);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
