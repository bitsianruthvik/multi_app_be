/**
 * nest_geometry_test.mjs — nestGeometry (waste by cause, offcuts, DXF) and
 * cncExportService (the CNC files), CF_ERP.
 *
 *   cd multi_app_be && node scripts/cf_kepl/nest_geometry_test.mjs
 *
 * Sections 1–11 are pure geometry with made-up numbers, no connection.
 * Section 12 reads the local database INSIDE A TRANSACTION THAT IS ROLLED
 * BACK: it borrows company 2's saved KEPL lots (order 887, line 923) read-only,
 * and if cf_offcuts does not exist yet it makes a TEMPORARY one (no implicit
 * commit, gone with the connection). Skip it with CF_GEOM_NO_DB=1.
 */
import path from 'path';
import { pathToFileURL } from 'url';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const G = await imp('apps/cf_erp/services/nestGeometry.js');
const P = await imp('apps/cf_erp/services/nestingPacker.js');

let passed = 0;
let failed = 0;
const fails = [];
function ok(name, cond, detail = '') {
  if (cond) { passed += 1; console.log(`  PASS  ${name}`); } else {
    failed += 1; fails.push(name); console.log(`  FAIL  ${name}${detail ? `  -- ${detail}` : ''}`);
  }
}
const near = (a, b, tol = 1) => Math.abs(a - b) <= tol;
const sumWaste = (r) => Object.values(r.waste).reduce((a, b) => a + b, 0);
const identity = (r) => near(r.partsArea + sumWaste(r), r.plateArea, 1);
const signed = (ring) => {
  let a = 0;
  for (let i = 0; i < ring.length; i += 1) {
    const [x1, y1] = ring[i]; const [x2, y2] = ring[(i + 1) % ring.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
};
const ringsArea = (outline) => outline.reduce((a, r) => a + signed(r), 0);

/* ------------------------------------------------------------------------ */
console.log('\n1. An empty plate');
{
  const r = G.analyseNest({ length: 2000, width: 1000, kerf: 3, pieces: [] });
  ok('plate area', r.plateArea === 2e6);
  ok('no parts, no kerf', r.partsArea === 0 && r.waste.kerf === 0);
  ok('rim is the kerf band', near(r.waste.rim, 2e6 - 1994 * 994, 1e-3), `${r.waste.rim}`);
  ok('one offcut, the interior', r.offcuts.length === 1 && near(r.offcuts[0].area, 1994 * 994, 1e-3));
  ok('offcut outline is the interior rectangle, CCW', r.offcuts[0]?.outline.length === 1
    && r.offcuts[0].outline[0].length === 4 && signed(r.offcuts[0].outline[0]) > 0
    && near(signed(r.offcuts[0].outline[0]), 1994 * 994, 1e-3));
  ok('rect = bbox = interior', r.offcuts[0].rect.length === 1994 && r.offcuts[0].rect.width === 994
    && r.offcuts[0].bbox.x === 3 && r.offcuts[0].bbox.y === 3);
  ok('identity', identity(r));
  ok('no pierces, no cut', r.pierces === 0 && r.cutLength === 0);
  const tiny = G.analyseNest({ length: 250, width: 250, kerf: 3, pieces: [] });
  ok('a plate under 300x300 of area is all wastage', tiny.offcuts.length === 0 && near(tiny.waste.wastage, 244 * 244, 1e-3));
  const noKerf = G.analyseNest({ length: 1000, width: 500, kerf: 0, pieces: [] });
  ok('kerf 0: no rim, whole plate is an offcut', noKerf.waste.rim === 0 && noKerf.waste.offcut === 5e5);
}

console.log('\n2. One piece in a corner — and the L-shaped offcut it leaves');
{
  const r = G.analyseNest({ length: 2000, width: 1000, kerf: 3, pieces: [{ x: 3, y: 3, length: 500, width: 400, seqNo: 1, rowNo: 1 }] });
  ok('parts area', r.partsArea === 200000);
  ok('kerf = halo clipped to the plate', near(r.waste.kerf, 506 * 406 - 200000, 1e-3), `${r.waste.kerf}`);
  const rimExpected = (2e6 - 1994 * 994) - (506 * 406 - 503 * 403);
  ok('rim = rim band less what the halo took', near(r.waste.rim, rimExpected, 1e-3), `${r.waste.rim} vs ${rimExpected}`);
  ok('one offcut', r.offcuts.length === 1);
  const o = r.offcuts[0];
  const ring = o.outline[0];
  ok('L-shaped: 6 vertices, one ring', o.outline.length === 1 && ring.length === 6, JSON.stringify(o.outline));
  ok('outline CCW and its area = offcut area', signed(ring) > 0 && near(signed(ring), o.area, 1e-3));
  const want = new Set(['506,3', '1997,3', '1997,997', '3,997', '3,406', '506,406']);
  ok('outline vertices exact', ring.every(([x, y]) => want.has(`${x},${y}`)), JSON.stringify(ring));
  ok('largest inscribed rect is the tall arm', o.rect.x === 506 && o.rect.y === 3 && o.rect.length === 1491 && o.rect.width === 994, JSON.stringify(o.rect));
  ok('bbox is the interior', o.bbox.length === 1994 && o.bbox.width === 994);
  ok('identity', identity(r));
  ok('one pierce, perimeter cut', r.pierces === 1 && r.cutLength === 1800);
}

console.log('\n3. A thin sliver between the rows and the rim is not an offcut');
{
  const r = G.analyseNest({ length: 3000, width: 1000, kerf: 3, pieces: [{ x: 3, y: 3, length: 2994, width: 900 }] });
  ok('no offcut', r.offcuts.length === 0);
  ok('the 2994 x 91 sliver is wastage', near(r.waste.wastage, 2994 * 91, 1e-3), `${r.waste.wastage}`);
  ok('its area alone passes the area test (so the side test did the work)', 2994 * 91 >= 90000);
  ok('identity', identity(r));
  const wide = G.analyseNest({ length: 3000, width: 1000, kerf: 3, pieces: [{ x: 3, y: 3, length: 2994, width: 880 }] });
  ok('at 111 mm deep it IS an offcut', wide.offcuts.length === 1 && wide.offcuts[0].rect.width === 111);
  const cfg = G.analyseNest({ length: 3000, width: 1000, kerf: 3, minOffcutSide: 80, pieces: [{ x: 3, y: 3, length: 2994, width: 900 }] });
  ok('thresholds are parameters', cfg.offcuts.length === 1);
}

console.log('\n4. A hole: one piece in the middle');
{
  const r = G.analyseNest({ length: 2000, width: 2000, kerf: 3, pieces: [{ x: 900, y: 900, length: 200, width: 200 }] });
  const o = r.offcuts[0];
  ok('one offcut with an outer ring and a hole', r.offcuts.length === 1 && o.outline.length === 2);
  ok('outer CCW, hole CW', signed(o.outline[0]) > 0 && signed(o.outline[1]) < 0);
  ok('rings net to the offcut area', near(ringsArea(o.outline), o.area, 1e-3));
  ok('identity', identity(r));
}

console.log('\n5. Shared edges are cut once; sequence gaps beyond the kerf');
{
  const shared = G.analyseNest({ length: 1000, width: 500, kerf: 3, pieces: [
    { x: 3, y: 3, length: 100, width: 100 }, { x: 106, y: 3, length: 100, width: 100 }] });
  ok('common boundary: 800 - 100', shared.cutLength === 700, `${shared.cutLength}`);
  const apart = G.analyseNest({ length: 1000, width: 500, kerf: 3, pieces: [
    { x: 3, y: 3, length: 100, width: 100 }, { x: 109, y: 3, length: 100, width: 100 }] });
  ok('separate cuts: 800', apart.cutLength === 800);
  ok('shared halo counted once (less kerf than separate)', shared.waste.kerf < apart.waste.kerf);
  const stacked = G.analyseNest({ length: 1000, width: 500, kerf: 3, pieces: [
    { x: 3, y: 3, length: 100, width: 100 }, { x: 3, y: 106, length: 100, width: 100 }] });
  ok('stacked common boundary: 700', stacked.cutLength === 700);

  // Two sequences 10 mm apart with kerf 3: a 4 mm band over their common 300 mm (+ halo each end).
  const seq = G.analyseNest({ length: 1000, width: 500, kerf: 3, seqGapMin: 5, pieces: [
    { x: 3, y: 3, length: 300, width: 100, seqNo: 1 }, { x: 3, y: 113, length: 300, width: 100, seqNo: 2 }] });
  ok('sequence gap band = (10 - 2k) x (300 + 2k)', near(seq.waste.sequenceGaps, 4 * 306, 1e-3), `${seq.waste.sequenceGaps}`);
  ok('identity with a band', identity(seq));
  const packerGap = G.analyseNest({ length: 1000, width: 500, kerf: 3, pieces: [
    { x: 3, y: 3, length: 300, width: 100, seqNo: 1 }, { x: 3, y: 109, length: 300, width: 100, seqNo: 2 }] });
  ok('6 mm gap with 3 mm kerf: the band is all kerf', packerGap.waste.sequenceGaps === 0);
  const close = G.analyseNest({ length: 1000, width: 500, kerf: 3, seqGapMin: 5, pieces: [
    { x: 3, y: 3, length: 300, width: 100, seqNo: 1 }, { x: 3, y: 106, length: 300, width: 100, seqNo: 2 }] });
  ok('sequences closer than the minimum are warned about', close.warnings.some((w) => /only 3 mm apart/.test(w)));
}

console.log('\n6. Pieces with null x/y are ignored by the geometry');
{
  const base = { length: 2000, width: 1000, kerf: 3 };
  const laid = [{ x: 3, y: 3, length: 500, width: 400 }];
  const r = G.analyseNest({ ...base, pieces: [...laid, { x: null, y: null, length: 100, width: 100 }, { length: 50, width: 50 }] });
  ok('partsArea still counts them', r.partsArea === 200000 + 10000 + 2500);
  ok('laid/unlaid counted', r.laid === 1 && r.unlaid === 2 && r.pierces === 1);
  ok('no offcuts claimed when a piece has no layout', r.offcuts.length === 0 && r.waste.offcut === 0);
  ok('identity still holds', identity(r), `${r.partsArea + sumWaste(r)}`);
  ok('says so', r.warnings.some((w) => /no layout/.test(w)));
  const all = G.analyseNest({ ...base, pieces: [{ x: null, y: null, length: 1500, width: 900 }] });
  ok('all unlaid: identity', identity(all));
  const over = G.analyseNest({ ...base, pieces: [{ x: null, y: null, length: 2000, width: 1000 }, { x: null, y: null, length: 500, width: 500 }] });
  ok('overfull reports overflow', over.overflow > 0 && over.waste.wastage === 0);
}

console.log('\n7. A real row layout from nestingPacker');
{
  const pieces = [
    { key: 'WEB', length: 2400, width: 610, qty: 4 },
    { key: 'FLG', length: 3000, width: 350, qty: 6 },
    { key: 'STF', length: 580, width: 180, qty: 40 },
    { key: 'GUS', length: 450, width: 450, qty: 9 },
    { key: 'PAD', length: 150, width: 120, qty: 60 },
  ];
  const res = P.nest({ pieces, sheets: [{ key: 'P', length: 12000, width: 2500 }], kerf: 3, sequenceGap: 8, effort: 'quick', seed: 1 });
  ok('packer produced nests', res.nests.length >= 1);
  let allOk = true; let seqGap = 0; let usedOk = true; let sharesOk = true; let offcutsOk = true;
  for (const n of res.nests) {
    const ps = n.pieces.map((p) => ({ x: p.x, y: p.y, length: p.length, width: p.width, seqNo: p.sequence, rowNo: p.row }));
    const r = G.analyseNest({ length: n.sheetLength, width: n.sheetWidth, kerf: 3, seqGapMin: 5, pieces: ps });
    if (!identity(r)) allOk = false;
    if (!near(r.partsArea, n.usedArea, 1e-3)) usedOk = false;
    seqGap += r.waste.sequenceGaps;
    const perim = ps.reduce((a, p) => a + 2 * (p.length + p.width), 0);
    if (n.commonCuts > 0 && !(r.cutLength < perim)) sharesOk = false;
    if (r.pierces !== ps.length) sharesOk = false;
    for (const o of r.offcuts) {
      if (!(o.area >= 90000 && Math.min(o.rect.length, o.rect.width) >= 100)) offcutsOk = false;
      if (!near(ringsArea(o.outline), o.area, 1e-2)) offcutsOk = false;
    }
    if (r.warnings.some((w) => /overlap|hang over/.test(w))) allOk = false;
  }
  ok('identity on every packed plate, no overlaps', allOk);
  ok('partsArea = the packer\'s usedArea', usedOk);
  ok('common boundaries shorten the cut; one pierce per piece', sharesOk);
  ok('8 mm gap with 3 mm kerf leaves a sequence-gap band somewhere', seqGap > 0, `${seqGap}`);
  ok('every offcut passes both tests and its rings match its area', offcutsOk);
}

console.log('\n8. The sum identity on random layouts (incl. overlaps and overhangs)');
{
  let s = 12345;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  let bad = 0;
  for (let t = 0; t < 60; t += 1) {
    const L = 500 + Math.round(rnd() * 5000); const W = 300 + Math.round(rnd() * 2000);
    const k = [0, 2.5, 3, 4, 5][t % 5];
    const ps = [];
    for (let i = 0; i < 15; i += 1) {
      ps.push({ x: Math.round(rnd() * L * 10) / 10 - 20, y: Math.round(rnd() * W * 10) / 10 - 20,
        length: 10 + Math.round(rnd() * L / 3), width: 10 + Math.round(rnd() * W / 3), seqNo: 1 + (i % 3) });
    }
    const r = G.analyseNest({ length: L, width: W, kerf: k, seqGapMin: 5, pieces: ps });
    if (!near(r.partsArea + sumWaste(r), r.plateArea, 1)) bad += 1;
    for (const o of r.offcuts) if (!near(ringsArea(o.outline), o.area, 1e-2)) bad += 1;
  }
  ok('60 random plates: parts + waste = plate, outlines = areas', bad === 0, `${bad} bad`);
}

console.log('\n9. Performance');
{
  // ~300 pieces, every length different so every x is its own grid line (the worst case).
  const ps = [];
  let y = 3; let seq = 1; let rowInSeq = 0;
  for (let row = 0; row < 15; row += 1) {
    let x = 3;
    for (let i = 0; i < 20; i += 1) {
      const l = 400 + ((row * 20 + i) * 7) % 180;
      ps.push({ x, y, length: l, width: 110, seqNo: seq, rowNo: rowInSeq + 1 });
      x += l + 3 + (i % 2) * 3;
    }
    y += 110 + 3;
    rowInSeq += 1;
    if (rowInSeq === 3) { rowInSeq = 0; seq += 1; y += 5; }
  }
  const t0 = process.hrtime.bigint();
  const r = G.analyseNest({ length: 12100, width: 2500, kerf: 3, seqGapMin: 5, pieces: ps });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  ok(`300 pieces analysed in ${ms.toFixed(1)} ms (< 500)`, ms < 500 && r.pierces === 300);
  ok('identity at scale', identity(r));
  const t1 = process.hrtime.bigint();
  const dxf = G.nestToDxf({ lot: { lotNo: 'N-001', length: 12100, width: 2500 }, pieces: ps.map((p) => ({ ...p, code: 'CP-1' })), offcuts: r.offcuts });
  const ms2 = Number(process.hrtime.bigint() - t1) / 1e6;
  ok(`DXF of 300 pieces in ${ms2.toFixed(1)} ms (< 200)`, ms2 < 200 && dxf.length > 0);
}

/* ------------------------------------------------------------------------ */
/** Parse a DXF into group pairs and check its structure. */
function checkDxf(text, { plate = 1, parts = 0, offcutRings = 0 } = {}) {
  const lines = text.split(/\r\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  const problems = [];
  if (lines.length % 2) problems.push('odd number of lines');
  const pairs = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = lines[i].trim();
    if (!/^-?\d+$/.test(code)) problems.push(`bad group code at line ${i + 1}: ${code}`);
    pairs.push([Number(code), lines[i + 1]]);
  }
  let depth = 0; let sections = 0;
  const polys = { PLATE: 0, PARTS: 0, OFFCUTS: 0, LABELS: 0 };
  let texts = 0; let version = null; let insunits = null;
  const layersDefined = new Set();
  for (let i = 0; i < pairs.length; i += 1) {
    const [c, v] = pairs[i];
    if (c === 9 && v === '$ACADVER') version = pairs[i + 1][1];
    if (c === 9 && v === '$INSUNITS') insunits = pairs[i + 1][1];
    if (c !== 0) continue;
    if (v === 'SECTION') { depth += 1; sections += 1; if (depth > 1) problems.push('nested SECTION'); }
    if (v === 'ENDSEC') { depth -= 1; if (depth < 0) problems.push('ENDSEC without SECTION'); }
    if (v === 'LAYER' && pairs[i + 1][0] === 2) layersDefined.add(pairs[i + 1][1]);
    if (v === 'TEXT') texts += 1;
    if (v === 'POLYLINE') {
      let layer = null; let closed = false; let j = i + 1;
      for (; j < pairs.length && pairs[j][0] !== 0; j += 1) {
        if (pairs[j][0] === 8) layer = pairs[j][1];
        if (pairs[j][0] === 70 && (Number(pairs[j][1]) & 1)) closed = true;
      }
      if (!closed) problems.push(`open POLYLINE on ${layer}`);
      let verts = 0;
      while (j < pairs.length && pairs[j][0] === 0 && pairs[j][1] === 'VERTEX') {
        let hasX = false; let hasY = false; j += 1;
        for (; j < pairs.length && pairs[j][0] !== 0; j += 1) {
          if (pairs[j][0] === 10 && Number.isFinite(Number(pairs[j][1]))) hasX = true;
          if (pairs[j][0] === 20 && Number.isFinite(Number(pairs[j][1]))) hasY = true;
        }
        if (!hasX || !hasY) problems.push('VERTEX without a coordinate');
        verts += 1;
      }
      if (!(pairs[j]?.[0] === 0 && pairs[j][1] === 'SEQEND')) problems.push(`POLYLINE on ${layer} not ended by SEQEND`);
      if (verts < 3) problems.push(`POLYLINE on ${layer} has ${verts} vertices`);
      if (layer === 'PARTS' && verts !== 4) problems.push(`part polyline with ${verts} vertices`);
      polys[layer] = (polys[layer] ?? 0) + 1;
    }
  }
  if (depth !== 0) problems.push('unbalanced SECTION/ENDSEC');
  if (!(pairs.length && pairs[pairs.length - 1][0] === 0 && pairs[pairs.length - 1][1] === 'EOF')) problems.push('no EOF');
  if (version !== 'AC1009') problems.push(`version ${version}`);
  if (insunits !== '4') problems.push(`INSUNITS ${insunits}`);
  for (const l of ['PLATE', 'PARTS', 'LABELS', 'OFFCUTS']) if (!layersDefined.has(l)) problems.push(`layer ${l} not defined`);
  if (polys.PLATE !== plate) problems.push(`PLATE polylines ${polys.PLATE}`);
  if (polys.PARTS !== parts) problems.push(`PARTS polylines ${polys.PARTS} (want ${parts})`);
  if (polys.OFFCUTS !== offcutRings) problems.push(`OFFCUTS polylines ${polys.OFFCUTS} (want ${offcutRings})`);
  if (/[^\x00-\x7F]/.test(text)) problems.push('non-ASCII text');
  return { problems, sections, texts };
}

console.log('\n10. DXF structure');
{
  const pieces = [
    { x: 3, y: 3, length: 500, width: 400, code: 'CP-000001' },
    { x: 506, y: 3, length: 300, width: 400, code: 'CP-000002' },
    { x: null, y: null, length: 100, width: 100, code: 'NOPE' },
  ];
  const a = G.analyseNest({ length: 2000, width: 1000, kerf: 3, pieces });
  const rings = a.offcuts.reduce((n, o) => n + o.outline.length, 0);
  const dxf = G.nestToDxf({ lot: { lotNo: 'N-007', plateCode: 'PL-12-E350 – ×', thickness: 12, grade: 'E350', length: 2000, width: 1000 },
    pieces, offcuts: a.offcuts.map((o, i) => ({ ...o, offcutNo: `N-007-${'AB'[i]}` })) });
  const c = checkDxf(dxf, { parts: 2, offcutRings: rings });
  ok('parses: balanced sections, closed polylines, right counts', c.problems.length === 0, c.problems.join('; '));
  ok('HEADER, TABLES, ENTITIES', c.sections === 3);
  ok('labels + title + offcut names', c.texts === 2 + 1 + a.offcuts.length, `${c.texts}`);
  ok('title carries lot, plate, thickness, grade', /Nest N-007/.test(dxf) && /12 mm/.test(dxf) && /E350/.test(dxf));
  ok('title TEXT sits outside (below) the plate', /TEXT\r\n8\r\nLABELS\r\n10\r\n0\r\n20\r\n-/.test(dxf));
  ok('true-size part corner', /VERTEX\r\n8\r\nPARTS\r\n10\r\n503\r\n20\r\n403/.test(dxf));
  const empty = G.nestToDxf({ lot: { lot_no: 'N-1', length_mm: '1000', width_mm: '500' }, pieces: [] });
  ok('an empty nest is still a valid drawing', checkDxf(empty).problems.length === 0);
  let threw = false;
  try { G.nestToDxf({ lot: {}, pieces: [] }); } catch { threw = true; }
  ok('refuses a lot with no size', threw);
}

console.log('\n11. Bad input');
{
  let threw = false;
  try { G.analyseNest({ length: 0, width: 100, pieces: [] }); } catch { threw = true; }
  ok('refuses a plate with no size', threw);
  const r = G.analyseNest({ length: 1000, width: 1000, kerf: 3, pieces: [{ x: 3, y: 3, length: 0, width: 5 }] });
  ok('a piece with no size is ignored and said', r.laid === 0 && r.warnings.length === 1 && identity(r));
}

/* ------------------------------------------------------------------------ */
if (process.env.CF_GEOM_NO_DB) {
  console.log('\n12. cncExportService — skipped (CF_GEOM_NO_DB)');
} else {
  console.log('\n12. cncExportService against the local database (rolled back)');
  const { pool } = await imp('db.js');
  const X = await imp('apps/cf_erp/services/cncExportService.js');
  const JSZip = (await import('jszip')).default;
  const COMPANY = 2; const LINE = 923;
  const conn = await pool.getConnection();
  let tempTable = false;
  try {
    await conn.beginTransaction();
    const [lots] = await conn.query(
      `SELECT l.id, l.lot_no, l.length_mm, l.width_mm, l.thickness_mm, l.grade, l.material, l.density,
              COUNT(p.id) AS pieces, SUM(p.x_mm IS NULL) AS unlaid
         FROM cf_plate_lots l
         LEFT JOIN cf_nest_placements p ON p.plate_lot_id = l.id AND p.company_id = l.company_id AND p.deleted_at IS NULL
        WHERE l.company_id = ? AND l.order_line_id = ? AND l.deleted_at IS NULL
        GROUP BY l.id ORDER BY l.lot_no, l.id`, [COMPANY, LINE]);
    if (!lots.length) {
      ok('line 923 has saved lots (fixture missing — nothing to test)', false);
    } else {
      const withLayout = lots.filter((l) => Number(l.pieces) > 0 && Number(l.unlaid ?? 0) === 0);
      const big = [...withLayout].sort((a, b) => b.pieces - a.pieces)[0];

      // cf_offcuts: the real one if the schema agent has made it, else a temporary stand-in.
      const [[t]] = await conn.query(
        `SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'cf_offcuts'`);
      if (!Number(t.n)) {
        await conn.query(`CREATE TEMPORARY TABLE cf_offcuts (
          id INT AUTO_INCREMENT PRIMARY KEY, company_id INT NOT NULL, order_line_id INT NOT NULL, plate_lot_id INT NOT NULL,
          offcut_no VARCHAR(40) NOT NULL, thickness_mm DECIMAL(10,3), grade VARCHAR(100), material VARCHAR(100), density DECIMAL(12,3),
          area_mm2 DECIMAL(16,3), weight_kg DECIMAL(14,3), bbox_length_mm DECIMAL(12,3), bbox_width_mm DECIMAL(12,3),
          rect_length_mm DECIMAL(12,3), rect_width_mm DECIMAL(12,3), outline_json JSON,
          status ENUM('planned','available','used','scrapped') DEFAULT 'planned', notes VARCHAR(500),
          deleted_at DATETIME NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, created_by INT NULL)`);
        tempTable = true;
      }

      // Without stored offcuts the drawing works them out from the geometry.
      const d0 = await X.lotDxf(conn, COMPANY, LINE, big.id);
      ok('filename = order-line-lot.dxf', d0.filename === `SO-20260924-0003-L10-${big.lot_no}.dxf`, d0.filename);
      const c0 = checkDxf(d0.buffer.toString('latin1'), { parts: Number(big.pieces), offcutRings: (d0.buffer.toString('latin1').match(/POLYLINE\r\n8\r\nOFFCUTS/g) ?? []).length });
      ok(`lot ${big.lot_no}: ${big.pieces} parts, DXF parses`, c0.problems.length === 0, c0.problems.join('; '));

      // A stored offcut is drawn as stored.
      await conn.query(
        `INSERT INTO cf_offcuts (company_id, order_line_id, plate_lot_id, offcut_no, thickness_mm, area_mm2, rect_length_mm, rect_width_mm, outline_json)
         VALUES (?, ?, ?, ?, 12, 250000, 500, 500, ?)`,
        [COMPANY, LINE, big.id, `${big.lot_no}-TESTZ`, JSON.stringify([[[0, 0], [500, 0], [500, 500], [0, 500]]])]);
      const d1 = await X.lotDxf(conn, COMPANY, LINE, big.id);
      const s1 = d1.buffer.toString('latin1');
      ok('stored offcut used (its name, one OFFCUTS ring)', s1.includes(`${big.lot_no}-TESTZ`) && (s1.match(/POLYLINE\r\n8\r\nOFFCUTS/g) ?? []).length === 1);

      const code = async (fn) => { try { await fn(); return null; } catch (e) { return e.code ?? e.message; } };
      ok('a lot on another line is not found', await code(() => X.lotDxf(conn, COMPANY, LINE + 999999, big.id)) === 'NOT_FOUND');
      const [[other]] = await conn.query(
        `SELECT l.id, l.order_line_id FROM cf_plate_lots l WHERE l.company_id = ? AND l.order_line_id <> ? AND l.deleted_at IS NULL LIMIT 1`, [COMPANY, LINE]);
      if (other) ok('a lot of a different line of the same company is refused', await code(() => X.lotDxf(conn, COMPANY, LINE, other.id)) === 'NOT_FOUND');
      ok('another company cannot read it', await code(() => X.lotDxf(conn, COMPANY + 999999, LINE, big.id)) === 'NOT_FOUND');
      ok('an unknown lot is not found', await code(() => X.lotDxf(conn, COMPANY, LINE, 0)) === 'NOT_FOUND');

      // A lot with no layout: null the placements of one lot inside the transaction.
      const [[nullable]] = await conn.query(
        `SELECT IS_NULLABLE AS n FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'cf_nest_placements' AND column_name = 'x_mm'`);
      const victim = withLayout.find((l) => l.id !== big.id);
      let noLayoutLot = null;
      if (nullable?.n === 'YES' && victim) {
        await conn.query('UPDATE cf_nest_placements SET x_mm = NULL, y_mm = NULL WHERE company_id = ? AND plate_lot_id = ?', [COMPANY, victim.id]);
        noLayoutLot = victim;
        ok('a lot without a layout is refused in words', await code(() => X.lotDxf(conn, COMPANY, LINE, victim.id)) === 'NO_LAYOUT');
      } else {
        console.log('  (x_mm is still NOT NULL locally — the no-layout lot check waits for the schema change)');
      }

      const t0 = Date.now();
      const z = await X.lineCncZip(conn, COMPANY, LINE);
      const zms = Date.now() - t0;
      ok('zip filename', z.filename === 'SO-20260924-0003-L10-nesting-cnc.zip', z.filename);
      const zip = await JSZip.loadAsync(z.buffer);
      const names = Object.keys(zip.files);
      const dxfs = names.filter((n) => n.endsWith('.dxf'));
      const expectDxf = withLayout.length - (noLayoutLot ? 1 : 0);
      ok(`one DXF per laid-out lot (${dxfs.length}/${expectDxf}), built in ${zms} ms`, dxfs.length === expectDxf);
      const csv = (await zip.file('nests.csv').async('string')).replace(/^﻿/, '').trim().split(/\r\n/);
      ok('nests.csv: header + one row per lot', csv.length === lots.length + 1, `${csv.length}`);
      if (noLayoutLot) ok('the no-layout lot is listed as such', csv.some((r) => r.startsWith(`${noLayoutLot.lot_no},`) && /no layout/.test(r)));
      let allParse = true;
      for (const n of dxfs.slice(0, 20)) {
        const s = await zip.file(n).async('string');
        const pc = (s.match(/POLYLINE\r\n8\r\nPARTS/g) ?? []).length;
        const oc = (s.match(/POLYLINE\r\n8\r\nOFFCUTS/g) ?? []).length;
        if (checkDxf(s, { parts: pc, offcutRings: oc }).problems.length) allParse = false;
      }
      ok('the zipped DXFs parse', allParse);
      ok('zip for another company is refused', await code(() => X.lineCncZip(conn, COMPANY + 999999, LINE)) === 'NOT_FOUND');
    }
  } finally {
    await conn.rollback();
    if (tempTable) await conn.query('DROP TEMPORARY TABLE IF EXISTS cf_offcuts');
    conn.release();
    await pool.end();
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log(`Failed: ${fails.join(', ')}`); process.exit(1); }
