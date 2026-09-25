/**
 * packer_test.mjs — the whole test for `apps/cf_erp/services/nestingPacker.js`.
 *
 *   cd multi_app_be && node scripts/cf_kepl/packer_test.mjs
 *
 * NO DATABASE, no tenant, no order. That is the point of a pure-geometry
 * packer: every number below is made up and hand-checkable, and every
 * arithmetic claim is written out in the comment above the assertion so a
 * person can disagree with it without reading the packer.
 *
 * THE GEOMETRY CHECKERS ARE WRITTEN FRESH HERE, not imported. A packer with a
 * bug reports success with the same bug, so `checkNest` re-derives everything
 * from the OUTPUT — coordinates, sequence and row numbers, cut order — and
 * knows nothing about how the layout was reached. Every nest produced by every
 * test goes through it.
 *
 * Kerf is PFPL's: 3 mm on 5–16 mm plate. The rim IS cut, so a part is 3 mm off
 * every edge of the plate; two parts sharing a cut are 3 mm apart and two cut
 * separately are 6 mm apart.
 */

import {
  nest, nestAsync, SEQUENCE_GAP, ORDER_MARGIN,
} from '../../apps/cf_erp/services/nestingPacker.js';

const TOL = 1e-6;
let passed = 0;
let failed = 0;
const notes = [];

function ok(cond, msg) {
  if (cond) passed += 1;
  else { failed += 1; console.log(`   FAIL  ${msg}`); }
}
const near = (a, b) => Math.abs(a - b) <= 1e-6;
function eq(got, want, msg) { ok(near(got, want), `${msg} — got ${got}, want ${want}`); }
function note(s) { notes.push(s); }

async function test(name, fn) {
  console.log(` • ${name}`);
  const before = failed;
  try { await fn(); } catch (e) { failed += 1; console.log(`   FAIL  threw: ${e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n') : e}`); }
  if (failed === before) console.log('   ok');
}

/* ───────────────────────── the independent checkers ────────────────────── */

/**
 * Everything that must be true of a finished nest, re-derived from the output.
 * `cfg` is what was asked for, so the checker can hold the packer to it.
 */
function checkNest(n, cfg, label) {
  const k = cfg.kerf;
  const m = cfg.margin ?? 0;
  const gap = cfg.sequenceGap ?? SEQUENCE_GAP.default;
  const common = cfg.commonBoundary !== false;
  const rowsPer = { small: 2, big: 3, ...(cfg.rowsPerSequence ?? {}) };
  const sizeOf = new Map((cfg.pieces ?? []).map((p) => [String(p.key), p]));

  // 1. INSIDE THE PLATE, AND CLEAR OF THE RIM CUT. The rim is cut, so nothing
  //    may sit closer than one kerf to any edge (plus any rim trim asked for).
  for (const p of n.pieces) {
    const inside = p.x >= m + k - TOL && p.y >= m + k - TOL
      && p.x + p.length <= n.sheetLength - m - k + TOL
      && p.y + p.width <= n.sheetWidth - m - k + TOL;
    if (!inside) {
      ok(false, `${label}: ${p.key} at ${p.x},${p.y} (${p.length}x${p.width}) breaks the rim cut on a `
        + `${n.sheetLength}x${n.sheetWidth} plate`);
      return;
    }
  }

  // 2. NO TWO PARTS OVERLAP. Sweep by x so a big plate does not cost O(n²).
  const by = [...n.pieces].sort((a, b) => a.x - b.x || a.y - b.y);
  for (let i = 0; i < by.length; i += 1) {
    const a = by[i];
    for (let j = i + 1; j < by.length; j += 1) {
      const b = by[j];
      if (b.x >= a.x + a.length - TOL) break;
      if (b.y < a.y + a.width - TOL && a.y < b.y + b.width - TOL) {
        ok(false, `${label}: ${a.key} at ${a.x},${a.y} overlaps ${b.key} at ${b.x},${b.y}`);
        return;
      }
    }
  }

  // 3. THE FOOTPRINT IS THE PART, TURNED OR NOT.
  for (const p of n.pieces) {
    const src = sizeOf.get(String(p.key));
    if (!src) continue;
    const want = p.rotated ? [src.width, src.length] : [src.length, src.width];
    if (!near(p.length, want[0]) || !near(p.width, want[1])) {
      ok(false, `${label}: ${p.key} is ${p.length}x${p.width} but the part is ${src.length}x${src.width}`
        + `${p.rotated ? ' (turned)' : ''}`);
      return;
    }
    if (src.grain === 'length' && p.rotated) { ok(false, `${label}: ${p.key} has grain 'length' and was turned`); return; }
    if (src.grain === 'width' && !p.rotated) { ok(false, `${label}: ${p.key} has grain 'width' and was not turned`); return; }
  }

  // 4. THE STRUCTURE IS REAL: every part appears once in exactly one row of one
  //    sequence, and the flat list is in cut order.
  const flat = [];
  let prevSeqNo = 0;
  for (const s of n.sequences) {
    if (s.sequence !== prevSeqNo + 1) { ok(false, `${label}: sequences are not numbered 1..n`); return; }
    prevSeqNo = s.sequence;
    if (s.rows.length > rowsPer[s.cls]) {
      ok(false, `${label}: sequence ${s.sequence} is ${s.cls} and holds ${s.rows.length} rows, `
        + `more than the ${rowsPer[s.cls]} allowed`);
      return;
    }
    s.rows.forEach((r, i) => {
      if (r.row !== i + 1) ok(false, `${label}: rows in sequence ${s.sequence} are not numbered 1..n`);
      r.parts.forEach((p, j) => {
        if (p.order !== j + 1) ok(false, `${label}: parts in ${s.sequence}/${r.row} are not in cut order`);
        flat.push(p);
      });
    });
  }
  if (flat.length !== n.pieces.length) {
    ok(false, `${label}: the flat list has ${n.pieces.length} parts, the sequences hold ${flat.length}`);
    return;
  }
  for (let i = 0; i < flat.length; i += 1) {
    const a = n.pieces[i]; const b = flat[i];
    if (a.x !== b.x || a.y !== b.y || a.key !== b.key) {
      ok(false, `${label}: the flat list is not in sequence/row/order`);
      return;
    }
  }

  // 5. INSIDE A ROW: one baseline, and a kerf between neighbours — two of them
  //    unless the neighbours are the same height, which is when one cut can
  //    serve both. A sequence gap never appears inside a sequence.
  for (const s of n.sequences) {
    for (const r of s.rows) {
      for (const p of r.parts) {
        if (!near(p.y, r.y)) { ok(false, `${label}: ${p.key} is not on its row's baseline`); return; }
        if (p.width > r.height + TOL) { ok(false, `${label}: ${p.key} is taller than its row`); return; }
      }
      const tallest = Math.max(...r.parts.map((p) => p.width));
      if (!near(tallest, r.height)) ok(false, `${label}: row ${s.sequence}/${r.row} says ${r.height} tall but holds ${tallest}`);
      const flush = r.parts.every((p) => near(p.width, r.height));
      if (flush !== r.flush) ok(false, `${label}: row ${s.sequence}/${r.row} reports flush=${r.flush} but is ${flush}`);
      for (let i = 1; i < r.parts.length; i += 1) {
        const a = r.parts[i - 1]; const b = r.parts[i];
        const g = b.x - (a.x + a.length);
        const need = (common && near(a.width, b.width)) ? k : 2 * k;
        if (g < need - TOL) {
          ok(false, `${label}: ${a.key} and ${b.key} are ${g} mm apart in row ${s.sequence}/${r.row}, need ${need}`);
          return;
        }
      }
    }
  }

  // 6. BETWEEN ROWS: a kerf when both rows are flush (one cut serves the tops of
  //    one and the bottoms of the next), two when they are not. BETWEEN
  //    SEQUENCES: the sequence clearance, which is not a kerf.
  const rows = n.sequences.flatMap((s) => s.rows.map((r) => ({ ...r, seq: s.sequence })));
  for (let i = 1; i < rows.length; i += 1) {
    const a = rows[i - 1]; const b = rows[i];
    const g = b.y - (a.y + a.height);
    if (b.seq !== a.seq) {
      if (g < gap - TOL) { ok(false, `${label}: sequences ${a.seq} and ${b.seq} are ${g} mm apart, need ${gap}`); return; }
    } else {
      const need = (common && a.flush && b.flush) ? k : 2 * k;
      if (g < need - TOL) { ok(false, `${label}: rows ${a.seq}/${a.row} and ${b.row} are ${g} mm apart, need ${need}`); return; }
    }
  }

  // 7. THE REPORTED AREAS ARE THE AREAS.
  const area = n.pieces.reduce((s, p) => s + p.length * p.width, 0);
  eq(n.usedArea, area, `${label}: usedArea`);
  eq(n.sheetArea, n.sheetLength * n.sheetWidth, `${label}: sheetArea`);
}

/** Run the packer and hold every nest it produced to the checkers. */
function run(input, label) {
  const r = nest(input);
  for (const n of r.nests) checkNest(n, input, `${label} [${n.sheetKey}]`);

  // Quantity conservation, across the whole answer, every time. This is the one
  // that broke silently: nothing was left unplaced to complain about, 2,692
  // pieces simply ceased to exist and were reported as finished work.
  const want = new Map();
  for (const p of input.pieces) want.set(String(p.key), (want.get(String(p.key)) ?? 0) + p.qty);
  const got = new Map();
  for (const n of r.nests) for (const p of n.pieces) got.set(String(p.key), (got.get(String(p.key)) ?? 0) + 1);
  for (const u of r.unplaced) got.set(String(u.key), (got.get(String(u.key)) ?? 0) + u.qty);
  for (const [key, n] of want) {
    ok(got.get(key) === n, `${label}: ${key} — ${n} demanded, ${got.get(key) ?? 0} accounted for`);
  }
  for (const key of got.keys()) ok(want.has(key), `${label}: ${key} appears in the answer but was never demanded`);

  // The headline numbers must agree with the nests they came from.
  const bought = r.nests.reduce((s, n) => s + (n.preferred ? 0 : n.sheetArea), 0);
  eq(r.areaBought, bought, `${label}: areaBought`);
  const sheet = r.nests.reduce((s, n) => s + n.sheetArea, 0);
  const used = r.nests.reduce((s, n) => s + n.usedArea, 0);
  eq(r.wasteArea, sheet - used, `${label}: wasteArea`);
  return r;
}

const placedCount = (r) => r.nests.reduce((s, n) => s + n.pieces.length, 0);
const canon = (r) => JSON.stringify({ ...r, elapsedMs: 0 });

/* ────────────────────────────────  the tests  ──────────────────────────── */

const PLATE = (key, length, width, extra = {}) => ({ key, length, width, ...extra });

async function main() {
  console.log('\nCF_ERP nesting packer — PFPL CNC rules v1\n');

  /* ─────────────────────────────────────────────────────────────────────── */
  /* ─────────────────────────────────────────────────────────────────────── */
  await test('the rim IS cut — one 100x100 part needs 106x106 on 16 mm plate', () => {
    // 3 + 100 + 3 = 106 on each axis. This is the rule that replaced fab's
    // "kerf never at the rim": PFPL's note 1 says the RM plate's own edge has
    // to be cut, so the outer boundary consumes a kerf like any other.
    const piece = { key: 'P', length: 100, width: 100, qty: 1 };
    const fits = run({ pieces: [piece], sheets: [PLATE('S', 106, 106)], kerf: 3, effort: 'quick' }, 'rim-fits');
    eq(fits.nests.length, 1, 'a 106x106 plate takes it');
    eq(fits.unplaced.length, 0, 'nothing left over');
    eq(fits.nests[0].pieces[0].x, 3, 'sitting one kerf off the left edge');
    eq(fits.nests[0].pieces[0].y, 3, 'and one kerf off the bottom');

    const tight = run({ pieces: [piece], sheets: [PLATE('S', 105, 106)], kerf: 3, effort: 'quick' }, 'rim-tight');
    eq(tight.nests.length, 0, '105 long is one millimetre short and buys nothing');
    eq(tight.unplaced.length, 1, 'and says so');
    eq(tight.unplaced[0].qty, 1, 'for the one part');

    // The old brief had this the other way round (a 12000 part fitting a 12050
    // plate with a 50 mm gap). Under PFPL's rules it does not: 12000 + 2*3 is
    // 12006, which needs 12006 of plate and not 12000.
    const exact = run({
      pieces: [{ key: 'W', length: 12000, width: 2995, qty: 1 }],
      sheets: [PLATE('A', 12000, 3100), PLATE('B', 12006, 3100)],
      kerf: 3,
      effort: 'quick',
    }, 'rim-12000');
    eq(exact.nests.length, 1, 'the 12006 plate is the one that works');
    ok(exact.nests[0].sheetKey === 'B', 'and the 12000 plate is not offered as a fit');
  });

  /* ─────────────────────────────────────────────────────────────────────── */
  await test('common boundary: three 100 mm parts are 312 shared and 318 separate', () => {
    // shared    3 + 100 + 3 + 100 + 3 + 100 + 3 = 312
    // separate  3 + 100 + 6 + 100 + 6 + 100 + 3 = 318
    const pieces = [{ key: 'P', length: 100, width: 100, qty: 3, grain: 'length' }];
    const base = { pieces, kerf: 3, effort: 'quick' };

    const shared = run({ ...base, sheets: [PLATE('S', 312, 106)], commonBoundary: true }, 'cb-312');
    eq(shared.nests.length, 1, 'all three share one plate at 312');
    eq(shared.nests[0].pieces.length, 3, 'three parts on it');
    eq(shared.nests[0].pieces[0].x, 3, 'first at 3');
    eq(shared.nests[0].pieces[1].x, 106, 'second at 106');
    eq(shared.nests[0].pieces[2].x, 209, 'third at 209');
    eq(shared.separateCuts, 0, 'nothing was cut twice');

    const one = run({ ...base, sheets: [PLATE('S', 311, 106)], commonBoundary: true }, 'cb-311');
    eq(one.nests[0].pieces.length, 2, 'one millimetre short and only two fit');

    const sep = run({ ...base, sheets: [PLATE('S', 312, 106)], commonBoundary: false }, 'cb-off-312');
    eq(sep.nests[0].pieces.length, 2, 'without a shared cut 312 holds only two');
    const sep3 = run({ ...base, sheets: [PLATE('S', 318, 106)], commonBoundary: false }, 'cb-off-318');
    eq(sep3.nests[0].pieces.length, 3, 'and 318 holds three');
    eq(sep3.nests[0].pieces[1].x, 109, 'the second one starts 6 mm after the first');
    eq(sep3.nests[0].pieces[2].x, 215, 'and the third 6 mm after that');
  });

  /* ─────────────────────────────────────────────────────────────────────── */
  await test('PFPL worked example: three 850 mm parts need 2562', () => {
    // 3 + 850 + 3 + 850 + 3 + 850 + 3 = 2562
    const pieces = [{ key: 'L', length: 850, width: 400, qty: 3, grain: 'length' }];
    const fit = run({ pieces, sheets: [PLATE('S', 2562, 406)], kerf: 3, effort: 'quick' }, '850-fit');
    eq(fit.nests.length, 1, 'one plate of 2562 x 406');
    eq(fit.nests[0].pieces.length, 3, 'holding all three');
    const short = run({ pieces, sheets: [PLATE('S', 2561, 406)], kerf: 3, effort: 'quick' }, '850-short');
    eq(short.nests[0].pieces.length, 2, '2561 holds two');
    // …and the ordering margin turns 2562 into a size somebody can actually buy.
    eq(ORDER_MARGIN.lengthMm, 100, 'ordering adds 100 mm of length');
    eq(ORDER_MARGIN.widthMm, 50, 'and 50 mm of width');
  });

  /* ─────────────────────────────────────────────────────────────────────── */
  await test('small parts give 2 rows per sequence, big parts 3', () => {
    // SMALL: 150x150 is under 200 in both dimensions. Five rows of three.
    //   y:  3 +150 ->153 | +3 ->156 +150 ->306 | seq gap 6 ->312 +150 ->462
    //       | +3 ->465 +150 ->615 | seq gap 6 ->621 +150 ->771 | +3 rim = 774
    //   x:  3 +150 +3 +150 +3 +150 +3 = 462
    const small = run({
      pieces: [{ key: 'S', length: 150, width: 150, qty: 15 }],
      sheets: [PLATE('P', 462, 774)],
      kerf: 3,
      sequenceGap: 6,
      effort: 'quick',
    }, 'seq-small');
    eq(small.nests.length, 1, 'all fifteen on one plate');
    eq(small.nests[0].sequences.length, 3, 'three sequences');
    ok(small.nests[0].sequences.every((s) => s.cls === 'small'), 'all classed small');
    ok(JSON.stringify(small.nests[0].sequences.map((s) => s.rows.length)) === '[2,2,1]',
      `two, two and a trailing one — got ${JSON.stringify(small.nests[0].sequences.map((s) => s.rows.length))}`);
    eq(small.nests[0].sequences[0].rows[0].y, 3, 'first row one kerf off the edge');
    eq(small.nests[0].sequences[0].rows[1].y, 156, 'second row one kerf above the first');
    eq(small.nests[0].sequences[1].rows[0].y, 312, 'the next sequence is a 6 mm clearance away');

    // BIG: 300x300. Four rows of two.
    //   y:  3 +300 ->303 | +3 ->306 +300 ->606 | +3 ->609 +300 ->909
    //       | seq gap 6 ->915 +300 ->1215 | +3 rim = 1218
    //   x:  3 +300 +3 +300 +3 = 609
    const big = run({
      pieces: [{ key: 'B', length: 300, width: 300, qty: 8 }],
      sheets: [PLATE('P', 609, 1218)],
      kerf: 3,
      sequenceGap: 6,
      effort: 'quick',
    }, 'seq-big');
    eq(big.nests.length, 1, 'all eight on one plate');
    eq(big.nests[0].sequences.length, 2, 'two sequences');
    ok(big.nests[0].sequences.every((s) => s.cls === 'big'), 'all classed big');
    ok(JSON.stringify(big.nests[0].sequences.map((s) => s.rows.length)) === '[3,1]',
      `three then a trailing one — got ${JSON.stringify(big.nests[0].sequences.map((s) => s.rows.length))}`);
    eq(big.nests[0].sequences[1].rows[0].y, 915, 'the second sequence starts after a 6 mm clearance');

    // A part 200 mm in one dimension is NOT small: the rule is under 200 in both.
    const edge = run({
      pieces: [{ key: 'E', length: 250, width: 150, qty: 8 }],
      sheets: [PLATE('P', 2000, 2000)],
      kerf: 3,
      effort: 'quick',
    }, 'seq-edge');
    ok(edge.nests[0].sequences.every((s) => s.cls === 'big'), '250 x 150 is Big, not Small');
  });

  /* ─────────────────────────────────────────────────────────────────────── */
  await test('the sequence clearance is honoured at 5 and at 8', () => {
    for (const gapMm of [5, 8]) {
      const r = run({
        pieces: [{ key: 'B', length: 300, width: 300, qty: 40 }],
        sheets: [PLATE('P', 2000, 2000)],
        kerf: 3,
        sequenceGap: gapMm,
        effort: 'quick',
      }, `gap-${gapMm}`);
      eq(r.sequenceGap, gapMm, `the answer says its clearance was ${gapMm}`);
      const rows = r.nests[0].sequences.flatMap((s) => s.rows.map((x) => ({ ...x, seq: s.sequence })));
      let checked = 0;
      for (let i = 1; i < rows.length; i += 1) {
        if (rows[i].seq === rows[i - 1].seq) continue;
        eq(rows[i].y - (rows[i - 1].y + rows[i - 1].height), gapMm, `clearance before sequence ${rows[i].seq}`);
        checked += 1;
      }
      ok(checked > 0, 'there was more than one sequence to check');
    }
    ok(SEQUENCE_GAP.min === 5 && SEQUENCE_GAP.max === 8, 'the published range is 5 to 8');
  });

  /* ─────────────────────────────────────────────────────────────────────── */
  await test('quantity is conserved across rows that share a key and a size', () => {
    // Five separate demand rows of 56, all named STIFF, all the same size, on
    // plates far too small to take them together — so every row is split over
    // several plates and one pooled name exists as many plate-rows at once.
    // Counting those by NAME instead of by row is what lost 2,692 pieces.
    const pieces = Array.from({ length: 5 }, () => ({ key: 'STIFF', length: 300, width: 200, qty: 56 }));
    const r = run({
      pieces,
      sheets: [PLATE('P', 1000, 700)],
      kerf: 3,
      effort: 'standard',
      budgetMs: 1500,
    }, 'conserve');
    eq(placedCount(r) + r.unplaced.reduce((s, u) => s + u.qty, 0), 280, '280 demanded, 280 accounted for');
    ok(r.nests.length > 1, 'and it really was spread over several plates');

    // The same thing with distinct keys, so a per-key answer is checkable too.
    const named = Array.from({ length: 5 }, (_, i) => ({ key: `R${i}`, length: 300, width: 200, qty: 56 }));
    const r2 = run({ pieces: named, sheets: [PLATE('P', 1000, 700)], kerf: 3, effort: 'standard', budgetMs: 1500 }, 'conserve-named');
    for (let i = 0; i < 5; i += 1) {
      const got = r2.nests.reduce((s, n) => s + n.pieces.filter((p) => p.key === `R${i}`).length, 0)
        + r2.unplaced.filter((u) => u.key === `R${i}`).reduce((s, u) => s + u.qty, 0);
      eq(got, 56, `row R${i}`);
    }
  });

  /* ─────────────────────────────────────────────────────────────────────── */
  await test('a demand row may split across plates', () => {
    // 20 parts of 400x300 on a plate that holds six (2 per row, 3 rows):
    //   x: 3 +400 +3 +400 +3 = 809   y: 3 +300 +3 +300 +3 +300 +3 = 915
    const r = run({
      pieces: [{ key: 'G', length: 400, width: 300, qty: 20, grain: 'length' }],
      sheets: [PLATE('P', 809, 915)],
      kerf: 3,
      effort: 'quick',
    }, 'split');
    eq(placedCount(r), 20, 'all twenty placed');
    eq(r.nests.length, 4, 'over four plates — six, six, six and two');
    ok(r.nests.some((n) => n.pieces.length === 6), 'and the full plates really hold six');
  });

  /* ─────────────────────────────────────────────────────────────────────── */
  await test('a part nobody stocks steel for is refused, not searched for', () => {
    const t0 = Date.now();
    const r = run({
      pieces: [
        { key: 'HUGE', length: 20000, width: 100, qty: 4 },
        { key: 'FINE', length: 200, width: 100, qty: 4 },
      ],
      sheets: [PLATE('P', 1000, 1000)],
      kerf: 3,
      effort: 'deep',
    }, 'refuse');
    eq(placedCount(r), 4, 'the four that fit are placed');
    const huge = r.unplaced.find((u) => u.key === 'HUGE');
    ok(huge && huge.qty === 4, 'all four impossible ones are reported');
    ok(/does not fit any offered plate/.test(huge.reason), `and the reason says why — "${huge && huge.reason}"`);
    ok(Date.now() - t0 < 5000, 'and it did not spin looking');
  });

  /* ─────────────────────────────────────────────────────────────────────── */
  await test('it stops instead of spinning when the plates run out', () => {
    // 10,000 parts, one plate in the world, one part per plate.
    //   x: 3 + 900 + 3 = 906 <= 1000, and two would need 3+900+3+900+3 = 1809.
    const t0 = Date.now();
    const r = run({
      pieces: [{ key: 'X', length: 900, width: 900, qty: 10000 }],
      sheets: [PLATE('P', 1000, 1000, { available: 1 })],
      kerf: 3,
      effort: 'standard',
      budgetMs: 2000,
    }, 'nospin');
    eq(placedCount(r), 1, 'exactly one part went onto the one plate');
    eq(r.unplaced.reduce((s, u) => s + u.qty, 0), 9999, 'and the other 9,999 are reported, not lost');
    ok(Date.now() - t0 < 8000, `it finished promptly (${Date.now() - t0} ms)`);
  });

  /* ─────────────────────────────────────────────────────────────────────── */
  await test('grain fixes the orientation', () => {
    const sheets = [PLATE('P', 2000, 2000)];
    const asIs = run({ pieces: [{ key: 'A', length: 400, width: 120, qty: 12, grain: 'length' }], sheets, kerf: 3, effort: 'quick' }, 'grain-l');
    ok(asIs.nests.every((n) => n.pieces.every((p) => p.rotated === false)), "grain 'length' is never turned");
    ok(asIs.nests[0].pieces.every((p) => p.length === 400 && p.width === 120), 'and keeps its footprint');

    const turned = run({ pieces: [{ key: 'A', length: 400, width: 120, qty: 12, grain: 'width' }], sheets, kerf: 3, effort: 'quick' }, 'grain-w');
    ok(turned.nests.every((n) => n.pieces.every((p) => p.rotated === true)), "grain 'width' is always turned");
    ok(turned.nests[0].pieces.every((p) => p.length === 120 && p.width === 400), 'and its footprint is the other way round');
  });

  /* ─────────────────────────────────────────────────────────────────────── */
  await test('a plate already owned costs no area', () => {
    // A drop that holds everything must beat buying a fresh plate, even one
    // that would pack tighter — the objective is steel BOUGHT, and the drop has
    // been bought already. Scoring on utilisation gets this exactly backwards.
    const pieces = [{ key: 'P', length: 100, width: 100, qty: 3, grain: 'length' }];
    const r = run({
      pieces,
      sheets: [
        PLATE('DROP', 600, 200, { preferred: true, available: 1 }),
        PLATE('NEW', 312, 106),
      ],
      kerf: 3,
      effort: 'quick',
    }, 'owned');
    eq(r.areaBought, 0, 'nothing was bought');
    ok(r.nests.length === 1 && r.nests[0].sheetKey === 'DROP', 'the drop was used');
    ok(r.nests[0].preferred === true, 'and is reported as material already owned');
    ok(r.wasteArea > 0, 'its waste is still counted as physical waste');

    // One physical drop is one plate: a second nest may not stand on it.
    const many = run({
      pieces: [{ key: 'P', length: 100, width: 100, qty: 12, grain: 'length' }],
      sheets: [PLATE('DROP', 312, 106, { preferred: true, available: 1 }), PLATE('NEW', 312, 106)],
      kerf: 3,
      effort: 'quick',
    }, 'owned-one');
    eq(many.nests.filter((n) => n.sheetKey === 'DROP').length, 1, 'the drop is used exactly once');
    eq(placedCount(many), 12, 'and the rest went onto bought plates');
  });

  /* ─────────────────────────────────────────────────────────────────────── */
  await test('a rim trim is respected on top of the rim cut', () => {
    const m = 10;
    const r = run({
      pieces: [{ key: 'P', length: 300, width: 200, qty: 9 }],
      sheets: [PLATE('P', 2000, 1200)],
      kerf: 3,
      margin: m,
      effort: 'quick',
    }, 'margin');
    for (const n of r.nests) {
      for (const p of n.pieces) {
        ok(p.x >= m + 3 - TOL && p.y >= m + 3 - TOL
          && p.x + p.length <= n.sheetLength - m - 3 + TOL
          && p.y + p.width <= n.sheetWidth - m - 3 + TOL,
        `every part is clear of the ${m} mm trim and the 3 mm rim cut`);
      }
    }
  });

  /* ─────────────────────────────────────────────────────────────────────── */
  await test('the candidate plates are sorted, so their input order cannot matter', () => {
    const pieces = [
      { key: 'A', length: 900, width: 400, qty: 14 },
      { key: 'B', length: 300, width: 300, qty: 40 },
      { key: 'C', length: 180, width: 120, qty: 60 },
    ];
    const sheets = [PLATE('S1', 2000, 1200), PLATE('S2', 3000, 1500), PLATE('S3', 1200, 1000), PLATE('S4', 6000, 2000)];
    const a = run({ pieces, sheets, kerf: 3, effort: 'standard', budgetMs: 3000, seed: 42 }, 'sort-a');
    const shuffled = [sheets[2], sheets[0], sheets[3], sheets[1]];
    const b = run({ pieces, sheets: shuffled, kerf: 3, effort: 'standard', budgetMs: 3000, seed: 42 }, 'sort-b');
    ok(canon(a) === canon(b), 'the same answer whatever order the catalogue arrives in');
  });

  /* ─────────────────────────────────────────────────────────────────────── */
  await test('same seed, same answer — and nest agrees with nestAsync', async () => {
    const input = {
      pieces: [
        { key: 'W', length: 1800, width: 700, qty: 9 },
        { key: 'F', length: 1200, width: 260, qty: 24 },
        { key: 'S', length: 420, width: 178, qty: 70 },
        { key: 'C', length: 160, width: 140, qty: 90 },
      ],
      sheets: [PLATE('A', 2500, 1250), PLATE('B', 3000, 1500), PLATE('C', 6000, 2000)],
      kerf: 3,
      effort: 'standard',
      budgetMs: 6000,
      seed: 7,
    };
    const a = run(input, 'det-1');
    const b = run(input, 'det-2');
    ok(canon(a) === canon(b), 'twice with the same seed gives byte-identical answers');
    ok(a.deterministic === true, 'and it says so — the iteration count ended the search, not the clock');

    const c = await nestAsync(input);
    ok(canon(a) === canon(c), 'nestAsync returns exactly what nest returns');

    const d = run({ ...input, seed: 8 }, 'det-seed8');
    ok(d.deterministic === true, 'a different seed is still deterministic');
  });

  /* ─────────────────────────────────────────────────────────────────────── */
  await test('nestAsync lets the event loop through', () => new Promise((resolve) => {
    let ticks = 0;
    let running = true;
    const tick = () => { if (running) { ticks += 1; setImmediate(tick); } };
    setImmediate(tick);
    nestAsync({
      pieces: [
        { key: 'W', length: 1800, width: 700, qty: 40 },
        { key: 'S', length: 420, width: 178, qty: 300 },
        { key: 'C', length: 160, width: 140, qty: 400 },
      ],
      sheets: [PLATE('A', 2500, 1250), PLATE('B', 3000, 1500), PLATE('C', 6000, 2000)],
      kerf: 3,
      effort: 'standard',
      budgetMs: 2500,
    }).then((r) => {
      running = false;
      ok(ticks > 10, `the loop ran ${ticks} times while the packer worked (a synchronous pack would give 0)`);
      ok(r.nests.length > 0, 'and it still produced a plan');
      note(`event loop breathed ${ticks} times during a ${r.elapsedMs} ms async pack`);
      resolve();
    });
  }));

  /* ─────────────────────────────────────────────────────────────────────── */
  await test('more effort is never worse', () => {
    // Deliberately awkward sizes, so the deterministic floor is NOT already the
    // answer and the restarts and the repair loop have something to find.
    const base = {
      pieces: [
        { key: 'A', length: 1370, width: 830, qty: 17 },
        { key: 'B', length: 910, width: 610, qty: 23 },
        { key: 'C', length: 640, width: 390, qty: 41 },
        { key: 'D', length: 355, width: 247, qty: 59 },
        { key: 'E', length: 181, width: 163, qty: 97 },
      ],
      sheets: [PLATE('A', 2000, 1000), PLATE('B', 2500, 1250), PLATE('C', 3000, 1500), PLATE('D', 6000, 2000)],
      kerf: 3,
      seed: 5,
    };
    const q = run({ ...base, effort: 'quick' }, 'effort-quick');
    const s = run({ ...base, effort: 'standard', budgetMs: 6000 }, 'effort-standard');
    const d = run({ ...base, effort: 'deep', budgetMs: 15000 }, 'effort-deep');
    ok(s.areaBought <= q.areaBought + TOL, `standard (${s.areaBought}) never buys more than quick (${q.areaBought})`);
    ok(d.areaBought <= s.areaBought + TOL, `deep (${d.areaBought}) never buys more than standard (${s.areaBought})`);
    const un = (r) => r.unplaced.reduce((t, u) => t + u.qty, 0);
    ok(un(s) <= un(q) && un(d) <= un(s), 'and more effort never strands more parts');
    ok(d.areaBought < q.areaBought - TOL, 'on an awkward order the search really does find something');
    note(`effort ladder: quick ${(q.areaBought / 1e6).toFixed(3)} m²  ->  standard `
      + `${(s.areaBought / 1e6).toFixed(3)} m²  ->  deep ${(d.areaBought / 1e6).toFixed(3)} m² `
      + `(${q.elapsedMs}/${s.elapsedMs}/${d.elapsedMs} ms)`);
  });

  /* ─────────────────────────────────────────────────────────────────────── */
  await test('sizeAdvice names the plate the catalogue should have offered', () => {
    // Ten 2000x1200 parts, grain fixed, on a 12000 x 3100 plate.
    //   five per row: 3 + 5*2000 + 4*3 + 3 = 10018 of length
    //   two rows:     3 + 1200 + 3 + 1200 + 3 = 2409 of width
    // Ordered, that is 10018+100 -> 10150 and 2409+50 -> 2500 at a 50 mm step,
    // against a plate of 12000 x 3100. The difference is a purchasing answer.
    const r = run({
      pieces: [{ key: 'P', length: 2000, width: 1200, qty: 10, grain: 'length' }],
      sheets: [PLATE('BIG', 12000, 3100)],
      kerf: 3,
      effort: 'quick',
    }, 'advice');
    eq(r.nests.length, 1, 'one plate');
    eq(placedCount(r), 10, 'holding all ten');
    eq(r.sizeAdvice.length, 1, 'one piece of advice');
    const a = r.sizeAdvice[0];
    eq(a.needLength, 10018, 'the exact length it needed');
    eq(a.needWidth, 2409, 'the exact width it needed');
    eq(a.orderLength, 10150, 'ordered at +100 mm, rounded to the 50 mm step');
    eq(a.orderWidth, 2500, 'ordered at +50 mm, rounded to the 50 mm step');
    eq(a.nests, 1, 'over one plate');
    eq(a.savingArea, 12000 * 3100 - 10150 * 2500, 'and that is what the catalogue is costing');

    // A plate that is already the right size has nothing to say.
    const tidy = run({
      pieces: [{ key: 'P', length: 100, width: 100, qty: 3, grain: 'length' }],
      sheets: [PLATE('S', 312, 106)],
      kerf: 3,
      effort: 'quick',
    }, 'advice-none');
    eq(tidy.sizeAdvice.length, 0, 'a plate cut to the millimetre needs no advice');
  });

  /* ─────────────────────────────────────────────────────────────────────── */
  await test('MEASURED: what the common boundary is worth on a realistic order', () => {
    // A bridge-girder-shaped order: a few big webs and flanges, a lot of
    // stiffeners, a lot of small cleats. 16 mm plate, so kerf 3 mm.
    const pieces = [
      { key: 'WEB', length: 2960, width: 1180, qty: 16, grain: 'length' },
      { key: 'FLG-T', length: 2960, width: 520, qty: 16, grain: 'length' },
      { key: 'FLG-B', length: 2960, width: 460, qty: 16, grain: 'length' },
      { key: 'STIFF-A', length: 1150, width: 178, qty: 180 },
      { key: 'STIFF-B', length: 860, width: 178, qty: 120 },
      { key: 'GUSSET', length: 420, width: 400, qty: 64 },
      { key: 'CLEAT', length: 165, width: 140, qty: 240 },
      { key: 'SHIM', length: 120, width: 90, qty: 180 },
    ];
    const sheets = [
      PLATE('2500x1250', 2500, 1250),
      PLATE('3000x1500', 3000, 1500),
      PLATE('6000x2000', 6000, 2000),
      PLATE('12000x2500', 12000, 2500),
    ];
    const opts = { pieces, sheets, kerf: 3, effort: 'standard', budgetMs: 6000, seed: 11 };

    const withCB = run({ ...opts, commonBoundary: true }, 'real-cb');
    const without = run({ ...opts, commonBoundary: false }, 'real-nocb');

    ok(withCB.areaBought <= without.areaBought + TOL,
      `sharing cuts never buys more steel (${withCB.areaBought} vs ${without.areaBought})`);
    eq(placedCount(withCB) + withCB.unplaced.reduce((s, u) => s + u.qty, 0), 832, 'every part is accounted for');
    eq(placedCount(without) + without.unplaced.reduce((s, u) => s + u.qty, 0), 832, 'both ways round');

    const saved = without.areaBought - withCB.areaBought;
    const pct = without.areaBought ? (100 * saved) / without.areaBought : 0;
    note('COMMON BOUNDARY, measured on 832 parts / 16 mm plate / 3 mm kerf:');
    note(`  shared cuts    ${(withCB.areaBought / 1e6).toFixed(3)} m² bought, `
      + `${withCB.nests.length} plates, ${withCB.wastePct.toFixed(2)}% waste, `
      + `${withCB.commonCuts} shared / ${withCB.separateCuts} separate cuts`);
    note(`  separate cuts  ${(without.areaBought / 1e6).toFixed(3)} m² bought, `
      + `${without.nests.length} plates, ${without.wastePct.toFixed(2)}% waste, `
      + `${without.commonCuts} shared / ${without.separateCuts} separate cuts`);
    note(`  DIFFERENCE     ${(saved / 1e6).toFixed(3)} m² (${pct.toFixed(2)}%) `
      + `and ${without.nests.length - withCB.nests.length} fewer plates`);
    if (withCB.sizeAdvice.length) {
      const a = withCB.sizeAdvice[0];
      note(`  sizeAdvice     ${a.nests} x ${a.sheetKey} would have wanted `
        + `${a.orderLength} x ${a.orderWidth} (${a.savingPct}% of each plate, `
        + `${(a.savingArea / 1e6).toFixed(3)} m² in total)`);
    }
    ok(withCB.separateCuts >= 0 && withCB.commonCuts > 0, 'and the shared cuts were actually counted');
    ok(without.commonCuts === 0, 'and with sharing off, none were claimed');

    /*
     * THE SAME MEASUREMENT ON SMALL PARTS, which is where it is worth having.
     * A shared cut saves one kerf per adjacency, so the saving is a fraction of
     * the PART, not of the plate: on a 150 mm cleat 3 mm is 2% of the pitch on
     * each axis, and on a 2960 mm web it is a tenth of one per cent. An order
     * of cleats is where the common boundary pays for itself.
     */
    const smallOpts = {
      pieces: [
        { key: 'CLEAT', length: 150, width: 150, qty: 900 },
        { key: 'SHIM', length: 120, width: 90, qty: 600 },
        { key: 'TAB', length: 95, width: 60, qty: 800 },
      ],
      sheets: [PLATE('2500x1250', 2500, 1250), PLATE('3000x1500', 3000, 1500), PLATE('6000x2000', 6000, 2000)],
      kerf: 3,
      effort: 'quick',
      seed: 11,
    };
    const sCB = run({ ...smallOpts, commonBoundary: true }, 'small-cb');
    const sNo = run({ ...smallOpts, commonBoundary: false }, 'small-nocb');
    ok(sCB.areaBought <= sNo.areaBought + TOL, 'sharing still never buys more');
    const sSaved = sNo.areaBought - sCB.areaBought;
    note('COMMON BOUNDARY on 2,300 SMALL parts (95–150 mm), where a 3 mm kerf is a real fraction:');
    note(`  shared cuts    ${(sCB.areaBought / 1e6).toFixed(3)} m² bought, ${sCB.nests.length} plates, ${sCB.wastePct.toFixed(2)}% waste`);
    note(`  separate cuts  ${(sNo.areaBought / 1e6).toFixed(3)} m² bought, ${sNo.nests.length} plates, ${sNo.wastePct.toFixed(2)}% waste`);
    note(`  DIFFERENCE     ${(sSaved / 1e6).toFixed(3)} m² `
      + `(${(sNo.areaBought ? (100 * sSaved) / sNo.areaBought : 0).toFixed(2)}%)`);
  });

  /* ─────────────────────────────────────────────────────────────────────── */
  await test('bad input is refused rather than guessed', () => {
    const bad = (input, what) => {
      let threw = false;
      try { nest(input); } catch { threw = true; }
      ok(threw, what);
    };
    bad({ pieces: [{ key: 'A', length: 0, width: 10, qty: 1 }], sheets: [PLATE('P', 100, 100)], kerf: 3 }, 'a part with no length');
    bad({ pieces: [{ key: 'A', length: 10, width: 10, qty: 1 }], sheets: [PLATE('P', 100, 100)] }, 'no kerf and no thickness');
    bad({ pieces: [{ key: 'A', length: 10, width: 10, qty: 1, grain: 'diagonal' }], sheets: [PLATE('P', 100, 100)], kerf: 3 }, 'a grain nobody has heard of');
    bad({ pieces: [{ key: 'A', length: 10, width: 10, qty: 1 }], sheets: [PLATE('P', 100, -5)], kerf: 3 }, 'a plate with a negative side');

    // A thickness ALONE is refused. Kerf is shop data owned by cf_cut_settings;
    // a table in here would be a second copy read by nothing, which is how the
    // other app came to nest at 2 mm and record its offcuts at 4.
    bad({
      pieces: [{ key: 'P', length: 100, width: 100, qty: 3 }],
      sheets: [PLATE('S', 314, 108)],
      thickness: 18,
    }, 'a thickness with no kerf — the packer does not own the bands');

    const r = nest({
      pieces: [{ key: 'P', length: 100, width: 100, qty: 3, grain: 'length' }],
      sheets: [PLATE('S', 314, 108)],
      kerf: 4,                       // what an 18 mm plate resolves to upstream
      effort: 'quick',
    });
    eq(r.kerf, 4, 'the kerf it was handed is the kerf it used');
    // 4 + 100 + 4 + 100 + 4 + 100 + 4 = 316, so 314 holds only two.
    eq(r.nests[0].pieces.length, 2, 'and the arithmetic moves with it');
    eq(nest({ pieces: [], sheets: [], kerf: 3 }).nests.length, 0, 'nothing in, nothing out');
  });

  /* ─────────────────────────────────────────────────────────────────────── */
  console.log('');
  for (const n of notes) console.log(`   ${n}`);
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
