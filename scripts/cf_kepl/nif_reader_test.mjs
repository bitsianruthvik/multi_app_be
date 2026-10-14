/**
 * nif_reader_test.mjs — reading a ProNest job file (lib/nifReader.js, 2026-10-13). The six real
 * jobs of TM/NECL_48M_NESTING_NIF (ProNest LT 16.2.1.9298, one per plate thickness), doctored
 * copies of them (another version, a file that no longer agrees with itself) and a fuzz
 * (truncations and bit flips). No database.
 *
 *   cd multi_app_be && node scripts/cf_kepl/nif_reader_test.mjs
 *   NIF_FUZZ=600 …            # more fuzz cases per file (default 150 flips, 40 truncations, 30 smears)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readNif, isNif, nestOfNif, nifNameFacts, NIF_SUPPORTED, NIF_MAX_BYTES, _test } from '../../apps/cf_erp/lib/nifReader.js';
import { matchNest } from '../../apps/cf_erp/lib/nestDxfReader.js';

let passed = 0, failed = 0;
const ok = (label, cond, detail = '') => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && detail ? ` — ${String(detail).slice(0, 600)}` : ''}`); cond ? passed++ : failed++; };
const section = (s) => console.log(`\n${s}`);
const J = (v) => JSON.stringify(v);
/** What a read throws: its code and message — or 'ok' — or what it should never be. */
const outcome = (buf, name = 'x.nif') => { try { readNif(buf, { filename: name }); return { code: 'ok' }; } catch (e) { return { code: e?.code ?? `UNEXPECTED ${e?.constructor?.name}: ${e?.message}`, message: e?.message ?? '', e }; } };
const REFUSALS = new Set(['BAD_FILE', 'TOO_BIG', 'UNSUPPORTED_VERSION', 'NEST_CHECK_FAILED', 'EMPTY_NEST']);

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../NECL_48M_NESTING_NIF');
/** Exactly as NIF_FORMAT_NOTES.md §10 has them. */
const EXPECT = {
  '10MM-NECL-PATNA.nif': { job: '10MM-NECL-PATNA', t: 10, nests: 1, plates: 1, parts: 1, placements: 24, pieces: 24, sizes: ['2000x6000'], qty: [1], stored: 1 },
  '12MM-NECL-PATNA SPAN1.nif': { job: '12MM-NECL-PATNA', t: 12, nests: 4, plates: 4, parts: 6, placements: 257, pieces: 257, sizes: ['2500x12000'], qty: [1, 1, 1, 1], stored: 1, perNest: [37, 84, 99, 37] },
  '16MM-NECL-PATNA.nif': { job: '16MM-NECL-PATNA', t: 16, nests: 11, plates: 20, parts: 16, placements: 159, pieces: 168, sizes: ['2300x12000'], qty: [4, 4, 4, 1, 1, 1, 1, 1, 1, 1, 1], stored: 11, perNest: [1, 1, 1, 13, 19, 10, 27, 36, 14, 36, 1] },
  '20MM-NECL-PATNA.nif': { job: '20MM-NECL-PATNA', t: 20, nests: 3, plates: 3, parts: 9, placements: 196, pieces: 196, sizes: ['2000x11000'], qty: [1, 1, 1], stored: 3, perNest: [32, 116, 48] },
  '25MM-NECL-PATNA -SPAN1.nif': { job: '25MM-NECL-PATNA', t: 25, nests: 5, plates: 5, parts: 7, placements: 116, pieces: 116, sizes: ['2500x12000'], qty: [1, 1, 1, 1, 1], stored: 3, perNest: [31, 14, 17, 24, 30] },
  '36MM-NECL-PATNA.nif': { job: '36MM-NECL-PATNA', t: 36, nests: 10, plates: 10, parts: 6, placements: 52, pieces: 52, sizes: ['2500x12000', '2000x12000'], qty: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1], stored: 7, perNest: [2, 2, 10, 10, 10, 10, 2, 2, 2, 2] },
};
const files = Object.keys(EXPECT).map((name) => ({ name, buf: fs.readFileSync(path.join(DIR, name)) }));
const docs = {};

/* ───────────── 1. the six real jobs ───────────── */
section('1. The six real jobs (ProNest LT 16.2.1.9298) — every figure of NIF_FORMAT_NOTES.md §10');
let totalNests = 0; let totalPlacements = 0; let totalStored = 0;
for (const { name, buf } of files) {
  const x = EXPECT[name];
  const t0 = Date.now();
  let d;
  try { d = readNif(buf, { filename: name }); } catch (e) { ok(`${name}: read`, false, `${e.code}: ${e.message}`); continue; }
  const ms = Date.now() - t0;
  docs[name] = d;
  totalNests += d.nests.length; totalPlacements += d.counts.placements;
  ok(`${name}: ${d.program} ${d.version}, job "${d.jobName}" (${ms} ms, ${d.counts.checks} self-checks passed)`, d.program === 'ProNest LT' && d.version === '16.2.1.9298' && d.jobName === x.job && d.units === 'in' && d.counts.checks > 100 && ms < 3000);
  ok(`${name}: ${x.nests} nests, ${x.plates} plates to cut, ${x.parts} parts, ${x.placements} placements = ${x.pieces} pieces`,
    d.counts.nests === x.nests && d.counts.plates === x.plates && d.counts.parts === x.parts && d.counts.placements === x.placements && d.counts.pieces === x.pieces && d.nests.length === x.nests && d.partsList.length === x.parts, J(d.counts));
  ok(`${name}: nest quantities ${x.qty.join(' ')}`, J(d.nests.map((n) => n.quantity)) === J(x.qty) && d.nests.every((n, i) => n.nestNo === i + 1));
  if (x.perNest) ok(`${name}: pieces per nest ${x.perNest.join(' ')}`, J(d.nests.map((n) => n.parts.length)) === J(x.perNest) && d.nests.every((n) => n.pieces === n.parts.length));
  const sizes = [...new Set(d.nests.map((n) => `${n.plate.length}x${n.plate.width}`))];
  ok(`${name}: plates ${x.sizes.join(', ')} × ${x.t} mm MS, plain rectangles, x along the short side as the file has it`, J(sizes) === J(x.sizes) && d.nests.every((n) => n.plate.thickness === x.t && n.plate.material === 'MS' && n.plate.rectangular && n.plate.outline.length === 4 && !n.problems.length) && d.problems.length === 0, J(sizes));
  const stored = d.nests.filter((n) => n.utilisationStored != null);
  totalStored += stored.length;
  ok(`${name}: utilisation worked out = the figure ProNest stored, on the ${stored.length} of ${d.nests.length} nests where it stored one (worst ${Math.max(0, ...stored.map((n) => Math.abs(n.utilisation - n.utilisationStored) * 100)).toFixed(3)} points)`,
    stored.length === x.stored && stored.every((n) => Math.abs(n.utilisation - n.utilisationStored) <= 0.001), J(stored.map((n) => [n.nestNo, n.utilisation, n.utilisationStored])));
  ok(`${name}: every piece lies on its plate, 5 mm or more from its edge, in plate millimetres`, d.nests.every((n) => n.minEdgeMargin >= 5 && n.parts.every((p) => p.bbox.x >= 0 && p.bbox.y >= 0 && p.bbox.x + p.bbox.length <= n.plate.length && p.bbox.y + p.bbox.width <= n.plate.width && p.x === p.bbox.x && p.y === p.bbox.y)), J(d.nests.map((n) => n.minEdgeMargin)));
  ok(`${name}: every piece is a ring of corners, counter-clockwise, with its part's name, source drawing and required quantity`, d.nests.every((n) => n.parts.every((p) => p.rings.outline.length >= 3 && area(p.rings.outline) > 0 && Math.abs(area(p.rings.outline) - p.area) <= 1 + p.area * 1e-6 && p.name && /\.dwg$/i.test(p.sourceFile) && p.requiredQty > 0 && /^P\d+$/.test(p.id))));
  // The parts list adds up: nested = pieces × the nest's quantity, by name.
  const byName = new Map();
  for (const n of d.nests) for (const p of n.parts) byName.set(p.name, (byName.get(p.name) ?? 0) + n.quantity);
  ok(`${name}: the parts list adds up — nested, counted over the nests × their quantity, is each part's "nested", and never more than required`, d.partsList.every((p) => (byName.get(p.name) ?? 0) === p.nested && p.nested <= p.required && p.notNested === p.required - p.nested && p.thickness === x.t && p.material === 'MS'), J(d.partsList.map((p) => [p.name, p.required, p.nested, byName.get(p.name) ?? 0])));
  // Against what the spike wrote next to the file: the same pieces of the same parts on every nest.
  const spike = JSON.parse(fs.readFileSync(path.join(DIR, name.replace(/\.nif$/, '.nests.json')), 'utf8'));
  ok(`${name}: the same pieces of the same parts on every nest as the spike's ${name.replace(/\.nif$/, '.nests.json')}`, spike.nests.length === d.nests.length && spike.nests.every((sn, i) => {
    const mine = {}; for (const p of d.nests[i].parts) mine[p.name] = (mine[p.name] ?? 0) + 1;
    return J(Object.entries(sn.partCounts).sort()) === J(Object.entries(mine).sort());
  }));
}
function area(r) { let a = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j][0] * r[i][1] - r[i][0] * r[j][1]; return a / 2; }
ok(`all six: 34 nests, 804 placements, the stored utilisation on 26 nests`, totalNests === 34 && totalPlacements === 804 && totalStored === 26, J([totalNests, totalPlacements, totalStored]));

section('2. What the shop\'s files hold');
{
  const d16 = docs['16MM-NECL-PATNA.nif']; const d12 = docs['12MM-NECL-PATNA SPAN1.nif']; const d10 = docs['10MM-NECL-PATNA.nif']; const d36 = docs['36MM-NECL-PATNA.nif'];
  const mirrored = d16.nests.flatMap((n) => n.parts.filter((p) => p.mirrored).map((p) => ({ ...p, nestNo: n.nestNo })));
  ok('16 mm: exactly ONE piece is nested mirrored — "…IS2-424X2150- 6" on nest 7 — and it counts with its part (6 of 6)', mirrored.length === 1 && mirrored[0].nestNo === 7 && /IS2-424X2150/.test(mirrored[0].name) && d16.counts.mirrored === 1 && d16.partsList.find((p) => /IS2-424X2150/.test(p.name)).nested === 6 && d16.partsList.find((p) => /IS2-424X2150/.test(p.name)).mirroredCopies === 1, J(mirrored.map((p) => [p.nestNo, p.name])));
  ok('16 mm: three nests are ×4 — one web per sheet, four sheets — 20 plates to cut from 11 nests', d16.nests.filter((n) => n.quantity === 4).length === 3 && d16.nests.slice(0, 3).every((n) => n.parts.length === 1 && /WEB PL[234]/.test(n.parts[0].name)));
  const web = d16.nests[10].parts[0];
  ok(`16 mm: a web is drawn WIDER than its name says (camber): "…WEB PL…-2150X6130" is ${web.bbox.length} × ${web.bbox.width}, its outline ${web.rings.outline.length} corners (an arc of 500 m radius is not drawn straight)`, /2150X6130/.test(web.name) && Math.abs(Math.max(web.bbox.length, web.bbox.width) - 6130) < 3 && Math.abs(Math.min(web.bbox.length, web.bbox.width) - 2275) < 1.5 && web.rings.outline.length > 20, J(web.bbox));
  const webs = d16.nests.flatMap((n) => n.parts).filter((p) => /MM-WEB PL\d/.test(p.name));
  ok('16 mm: the closed letters of the marking text on the five webs are MARKING — counted, never cut-outs (16 shapes on 5 parts)', webs.length === 11 && new Set(webs.map((p) => p.name)).size === 5 && webs.every((p) => p.marking >= 3 && p.rings.cutouts.length === 0 && p.rings.holes.length === 0 && !p.unsure) && d16.partsList.reduce((a, p) => a + p.marking, 0) === 16 && d16.notes.some((s) => /16 closed shapes inside 5 parts .*marking/.test(s)), J(webs.map((p) => p.marking)));
  ok('no nest of any job holds a cut-out or a hole (holes are drilled later)', Object.values(docs).every((d) => d.nests.every((n) => n.parts.every((p) => !p.rings.cutouts.length && !p.rings.holes.length))));
  ok('16 mm: a web nested at 89.4° keeps ProNest\'s own turn', Math.abs(d16.nests[0].parts[0].rotationDeg - 89.375) < 0.01 && d16.nests[0].parts[0].mirrored === false, String(d16.nests[0].parts[0].rotationDeg));
  ok('common-line-cut groups are opened into their pieces, 3 mm apart, and say which group they were', d10.counts.clcGroups === 3 && d10.nests[0].parts.every((p) => /^clc1-\d+$/.test(p.clcGroup)) && d36.counts.clcGroups === 0 && d36.nests.every((n) => n.parts.every((p) => p.clcGroup === null)), J(d10.nests[0].parts.map((p) => p.clcGroup)));
  const not = (d) => d.partsList.filter((p) => p.notNested > 0).map((p) => `${p.name.split('-').slice(1, 2).join('')}:${p.nested}/${p.required}`);
  ok('what is NOT nested is plain: 16 mm 0 of 144 packs; 12 mm 14 of 16 and 3 of 16; 36 mm 28 of 36 and 0 of 6', J(not(d16)) === J(['ID PACK PL2:0/144']) && J(not(d12)) === J(['SP1 BTM PACK PL:14/16', 'SP1 TOP PACK PL:3/16']) && J(not(d36)) === J(['ED JACK PL1:28/36', 'ED PAD PL:0/6']), J([not(d16), not(d12), not(d36)]));
  const cover = d10.partsList[0];
  ok('the part NAME is the shop\'s label, read for what it says: "9MM-ED COVER PACK PL-185X1400- 12" → 9 mm, 185 × 1400, 12 — on 10 mm plate, required 24', cover.nameThickness === 9 && J(cover.nameSize) === J([185, 1400]) && cover.nameQuantity === 12 && cover.thickness === 10 && cover.required === 24 && d10.notes.some((s) => /named another thickness/.test(s)), J(cover));
  ok('nifNameFacts: sizes either way, a thickness inside the size, no size at all', J(nifNameFacts('25MM-SP2 BTM INNER PL-400x1770- 16').size) === J([400, 1770]) && J(nifNameFacts('PL 16X2150X6130', 16).size) === J([2150, 6130]) && nifNameFacts('GUSSET LEFT').size === null && nifNameFacts('16MM-ID STFR EG2-3&IG2-3 IS1\'-424X2128- 18').quantity === 18);
  // The form the upload reads: one nest as lib/nestDxfReader gives one plate.
  const n7 = nestOfNif(d16, d16.nests[6]);
  ok('nestOfNif: one nest as the upload reads a DXF plate — plate drawn, thickness from the job, every part labelled by its name and matched by its outline', n7.plate.found === 'outline' && n7.plate.length === 2300 && n7.plate.width === 12000 && n7.hints.thicknessMm === 16 && n7.hints.grade === null && n7.parts.length === 27 && n7.parts.every((p) => p.outlineOnly === true && p.labelFrom === 'name' && p.labels.length === 1 && p.rings.outline.length >= 3 && p.outsidePlate === false) && n7.parts.some((p) => J(p.nameSize) === J([424, 2150])));
  // …and matchNest takes it unchanged: rectangles of the name's size are found by their outline.
  const cands = [{ key: 'a', codes: ['ZZ-A'], rings: null, length: 2150, width: 424 }, { key: 'b', codes: ['ZZ-B'], rings: null, length: 2128, width: 424 }];
  const m = matchNest(n7, cands);
  ok(`nestOfNif → matchNest: the 424 × 2150 and 424 × 2128 stiffeners of nest 7 are matched by size (${m.placements.length} of 27), the rest are nobody's`, m.placements.length > 0 && m.placements.every((p) => p.by === 'size') && m.placements.length + m.unmatched.length + m.ambiguous.length === 27, J(m.counts));
}

section('2b. matchNest for a ProNest part — the rungs, on parts made by hand');
{
  const rect = (l, w, x = 0, y = 0) => [[x, y], [x + l, y], [x + l, y + w], [x, y + w]];
  const hole = (cx, cy, r) => Array.from({ length: 72 }, (_, k) => [cx + r * Math.cos((k * 5 * Math.PI) / 180), cy + r * Math.sin((k * 5 * Math.PI) / 180)]);
  const win = (x, y) => rect(120, 60, x, y);
  const part = (id, name, rings, extra = {}) => ({ id, rings, bbox: { x: 0, y: 0, length: 0, width: 0 }, labels: [name], labelFrom: 'name', outlineOnly: true, nameSize: nifNameFacts(name).size, partName: name, ...extra });
  const one = (p, cands, opts) => { const m = matchNest({ parts: [p] }, cands, { kerfOffsetMaxMm: 0, ...opts }); return m.placements[0] ?? (m.ambiguous[0] ? { ambiguous: m.ambiguous[0].candidateKeys } : { unmatched: m.unmatched[0].why }); };
  const plain = { outline: rect(600, 300, 50, 50), cutouts: [], holes: [] };
  const drilled = { key: 'drilled', codes: ['ZZ-1'], rings: [rect(600, 300), hole(100, 150, 13), hole(500, 150, 13)], length: 600, width: 300 };
  const bare = { key: 'bare', codes: ['GP-7'], rings: null, length: 600, width: 300 };
  let r = one(part('P1', '12MM-SPLICE-300X600- 4', plain), [drilled]);
  ok('outline only: a drawing with two bolt holes is the shape of a nested part that has none (by "shape")', r.candidateKey === 'drilled' && r.by === 'shape', J(r));
  r = one(part('P1', '12MM-GP-7-300X600- 4', plain), [drilled, bare]);
  ok('label: a code standing in the name as whole words ("…-GP-7-…") names the cut piece', r.candidateKey === 'bare' && r.by === 'label', J(r));
  r = one(part('P1', '12MM-PL-300X600- 7', plain), [{ ...bare, key: 'seven', codes: ['7'] }, { ...bare, key: 'mm', codes: ['12MM'] }, { ...bare, key: 'sz', codes: ['300X600'] }]);
  ok('…never the quantity, the thickness or the size the name also holds (cut pieces coded "7", "12MM", "300X600" are not named by it)', J(r.ambiguous) === J(['seven', 'mm', 'sz']), J(r));
  r = one(part('P1', '12MM-WEB-280X600- 2', plain), [{ key: 'web', codes: ['ZZ-2'], rings: null, length: 600, width: 280 }]);
  ok('name size: drawn 600 × 300, named 280X600 — the cut piece of 600 × 280 is it, by "name size", saying both sizes', r.candidateKey === 'web' && r.by === 'name size' && J(r.outlineDiffers) === J({ drawn: [600, 300], cutPiece: [600, 280] }), J(r));
  // 2026-10-14 — CUTTING ALLOWANCE (from a shop's real jobs: flanges nested 6135 for 6120, 11955 for 11940).
  const flange = { outline: rect(6135, 500, 5, 5), cutouts: [], holes: [] };
  const fl = (key, length, width) => ({ key, codes: [`ZZ-${key}`], rings: null, length, width });
  r = one(part('P1', '25MM-TOP FL1-500X6135- 8', flange), [fl('tf', 6120, 500), fl('wide', 6120, 750)]);
  ok('allowance: named and drawn 15 mm longer than the cut piece, same width — matched, the allowance said', r.candidateKey === 'tf' && r.allowanceMm === 15 && J(r.outlineDiffers?.cutPiece) === J([6120, 500]), J(r));
  r = one(part('P1', '25MM-TOP FL1-500X6135- 8', flange), [fl('exact', 6135, 500), fl('short', 6120, 500)]);
  ok('…a cut piece of exactly that size beats one that fits only with an allowance', r.candidateKey === 'exact' && r.allowanceMm == null, J(r));
  r = one(part('P1', '25MM-TOP FL1-500X6135- 8', flange), [fl('far', 6100, 500), fl('thin', 6120, 480), fl('longer', 6140, 500)]);
  ok('…never more than 25 mm over, never another width, never SHORTER than the cut piece', typeof r.unmatched === 'string', J(r));
  r = one(part('P1', '25MM-TOP FL1-500X6135- 8', flange), [fl('near', 6125, 500), fl('nearer', 6130, 500)]);
  ok('…of two that fit with an allowance, the smaller allowance', r.candidateKey === 'nearer' && r.allowanceMm === 5, J(r));
  r = one({ ...part('P1', 'FLANGE', flange), nameSize: null }, [fl('tf', 6120, 500)]);
  ok('…with no size in the name, the outline\x27s own size does the same (by "size")', r.candidateKey === 'tf' && r.by === 'size' && r.allowanceMm === 15, J(r));
  // 2026-10-14 — THE USER'S OWN CHOICE (placeAs), and what the ladder found on its way (facts).
  {
    const p = part('P1', '25MM-TOP FL1-500X6135- 8', flange);
    const m = matchNest({ parts: [p] }, [fl('exact', 6135, 500), fl('short', 6120, 500), fl('far', 3000, 400), { ...drilled, key: 'drawn' }], { kerfOffsetMaxMm: 0 });
    ok('facts: the rectangle round the part, and the candidates the ladder found to fit it', J(m.facts.get('P1').size) === J([6135, 500]) && m.facts.get('P1').fits.get('exact') === 'size' && !m.facts.get('P1').fits.has('short'), J([m.facts.get('P1').size, [...m.facts.get('P1').fits]]));
    let c = m.placeAs(p, 'exact');
    ok('placeAs: the candidate the ladder matched is the ladder\x27s own placement', c.candidateKey === 'exact' && c.x === m.placements[0].x && c.rotationDeg === m.placements[0].rotationDeg && c.outlineDiffers === undefined, J(c));
    c = m.placeAs(p, 'short');
    ok('…another one, 15 mm shorter and the same width: laid where the part is drawn, with the allowance said', c.candidateKey === 'short' && c.by === 'choice' && c.allowanceMm === 15 && c.x === 5 && c.y === 5 && c.rotationDeg === 0 && J(c.outlineDiffers) === J({ drawn: [6135, 500], cutPiece: [6120, 500] }), J(c));
    c = m.placeAs(p, 'far');
    ok('…one of quite another size: taken all the same, both sizes said, no allowance', c.candidateKey === 'far' && c.allowanceMm === undefined && J(c.outlineDiffers) === J({ drawn: [6135, 500], cutPiece: [3000, 400] }) && c.x === 5 && c.y === 5, J(c));
    ok('…and a key that is no candidate gives nothing', m.placeAs(p, 'nobody') === null);
    const q = part('P2', '12MM-SPLICE-300X600- 4', plain);
    const m2 = matchNest({ parts: [q] }, [drilled, bare], { kerfOffsetMaxMm: 0 });
    ok('facts: a true-shape fit is remembered as "shape", a rectangle of the size as "size"', m2.facts.get('P2').fits.get('drilled') === 'shape' && m2.facts.get('P2').fits.get('bare') === 'size', J([...m2.facts.get('P2').fits]));
  }
  r = one(part('P1', '12MM-GP-7-900X900- 2', plain), [{ ...bare, length: 900, width: 400 }, { key: 'other', codes: ['ZZ-3'], rings: null, length: 600, width: 300 }]);
  ok('a name that holds a code of ANOTHER shape and size does not end the search: the outline finds the cut piece it is', r.candidateKey === 'other' && r.by === 'size', J(r));
  r = one(part('P1', '12MM-GP-7-900X900- 2', plain), [{ ...bare, length: 900, width: 400 }]);
  ok('…and when nothing else is it either, the mismatch is said ("It is labelled …")', /^It is labelled "GP-7", but it is not the shape of GP-7/.test(r.unmatched ?? ''), J(r));
  r = one(part('P1', '12MM-PL-300X600- 4', plain), [{ ...bare, key: 'thick' }, { ...bare, key: 'thin', codes: ['ZZ-4'] }], { prefer: (key) => key === 'thin' });
  ok('prefer: of two cut pieces of the same size, the one the job\'s plate can be cut into is looked among first', r.candidateKey === 'thin' && r.by === 'size', J(r));
  r = one(part('P1', '12MM-PL-300X600- 4', plain), [{ ...bare, key: 'thick' }], { prefer: () => false });
  ok('…and when none of those is it, the others are still found (the caller then says the thickness)', r.candidateKey === 'thick', J(r));
  // Closed shapes inside a part whose layer the job does not give: cut-outs only when the drawing has them.
  const withWin = { outline: rect(600, 300, 50, 50), cutouts: [win(290, 170)], holes: [] };
  const unsure = part('P1', '12MM-FRAME-300X600- 1', withWin, { ringsNoMarks: plain, unsureMarks: 1, unsureStyle: 'a layer the job does not name' });
  r = one(unsure, [{ key: 'frame', codes: ['ZZ-5'], rings: [rect(600, 300), win(240, 120)], length: 600, width: 300 }]);
  ok('an unsure closed shape inside a part IS a cut-out when the cut piece\'s drawing has that opening there (nothing left out)', r.candidateKey === 'frame' && r.marksLeftOut === undefined, J(r));
  r = one(unsure, [drilled]);
  ok('…and is left out (marksLeftOut 1) when the drawing has no such opening — the upload then says MARKING_UNSURE or a note, never a cut-out', r.candidateKey === 'drilled' && r.marksLeftOut === 1, J(r));
  r = one(unsure, [bare]);
  ok('…the same for a cut piece with no drawing', r.candidateKey === 'bare' && r.marksLeftOut === 1, J(r));
}

/* ───────────── doctoring ───────────── */
const { parseTree } = _test;
const kid = (n, id) => n.kids.find((k) => k.id === id);
const own = (n) => n.segs.filter(Array.isArray);
const findAll = (n, id, out = []) => { if (n.id === id) out.push(n); for (const k of n.kids) findAll(k, id, out); return out; };
const base = files.find((f) => f.name.startsWith('36MM'));      // no common-line groups: every 1012 is a piece
const tree = parseTree(base.buf).root;
const job = kid(kid(tree, 1000), 1001);
const doctor = (f) => { const c = Buffer.from(base.buf); f(c); return c; };
const addF64 = (c, at, d) => c.writeDoubleLE(c.readDoubleLE(at) + d, at);

section('3. The version gate — another ProNest is refused in a sentence that names it');
{
  let r = outcome(doctor((c) => c.write('15.1.0.0000', 2 + 'ProNest LT '.length, 'latin1')), 'old.nif');
  ok('written by ProNest LT 15.1 → UNSUPPORTED_VERSION, naming program and version found and the one supported', r.code === 'UNSUPPORTED_VERSION' && /"old\.nif" was written by ProNest LT 15\.1 \(15\.1\.0\.0000\) — this reads ProNest 2025 LT \(16\.2\)\. Export the nests as DXF, or send us a sample job so it can be added\./.test(r.message) && r.e.program === 'ProNest LT' && r.e.version === '15.1.0.0000' && r.e.supported === NIF_SUPPORTED.label, r.message);
  r = outcome(doctor((c) => c.write('17.0.0.1234', 2 + 'ProNest LT '.length, 'latin1')));
  ok('written by a LATER ProNest (17.0) → refused the same way', r.code === 'UNSUPPORTED_VERSION' && /ProNest LT 17\.0/.test(r.message), r.message);
  r = outcome(doctor((c) => c.write('16.2.9.9999', 2 + 'ProNest LT '.length, 'latin1')));
  ok('another build of the same series (16.2.9) with the same records is read', r.code === 'ok', r.message);
  const nest1 = kid(kid(job, 1004), 1007).kids.find((k) => k.id === 1008);
  r = outcome(doctor((c) => c.writeUInt16LE(14, nest1.start + 8)));
  ok('a record at a version it was not tested on (the nest record, 13 → 14) → UNSUPPORTED_VERSION naming the record', r.code === 'UNSUPPORTED_VERSION' && /record 1008 at version 14; it knows version 13/.test(r.message) && r.e.chunk === 1008 && r.e.chunkVersion === 14, r.message);
  r = outcome(doctor((c) => c.writeUInt32LE(1999, nest1.start + 4)));
  ok('a record it has never seen (id 1999) → UNSUPPORTED_VERSION', r.code === 'UNSUPPORTED_VERSION' && /record 1999/.test(r.message), r.message);
  // An instruction it does not know inside a part's drawing: the first line of the first part becomes code 4.
  const P = kid(job, 1002); const stream = P.segs[P.segs.indexOf(kid(P, 1015)) + 1];
  let lineAt = -1; for (let o = stream[0]; o + 20 <= stream[1]; o += 20) if (base.buf.readInt32LE(o) === 1) { lineAt = o; break; }
  r = outcome(doctor((c) => c.writeInt32LE(4, lineAt)));
  ok('an instruction it does not know in a part\'s drawing (code 4) → UNSUPPORTED_VERSION: geometry is never guessed at', r.code === 'UNSUPPORTED_VERSION' && /instruction this reader has not seen \(code 4\)/.test(r.message) && r.e.token === 4, r.message);
  r = outcome(doctor((c) => c.writeInt32LE(1301, lineAt)));
  ok('a known setting where a move should be (a line turned into code 1301 inside a cut) → refused, not skipped', r.code === 'UNSUPPORTED_VERSION' && /inside a cut/.test(r.message), `${r.code} ${r.message}`);
}

section('4. The self-checks — a file that no longer agrees with itself is refused whole, saying which check and where');
{
  const P = kid(job, 1002); const part1 = kid(P, 1015); const stream = P.segs[P.segs.indexOf(part1) + 1];
  const lines = []; for (let o = stream[0]; o + 20 <= stream[1]; o += 20) if (base.buf.readInt32LE(o) === 1) lines.push(o);
  const pieces = findAll(kid(kid(job, 1004), 1007), 1012);
  const boxOfPiece = (inst) => own(kid(inst, 1019))[0][0];
  const matOfPiece = (inst) => own(kid(inst, 1018))[0][0];
  const check = (r, name, re) => r.code === 'NEST_CHECK_FAILED' && r.e.check === name && re.test(r.message) && /nothing of it is taken/.test(r.message);

  let r = outcome(doctor((c) => { addF64(c, lines[1] + 4, 3); }));
  ok('a corner of a part\'s outline moved 76 mm along its edge (the box round it stays the same) → "part size": its outline no longer encloses the area its header states', check(r, 'part size', /part "36MM-.*its outline encloses \d+ mm² and its own header says \d+ mm²/), `${r.code} ${r.e?.check} ${r.message}`);
  r = outcome(doctor((c) => { addF64(c, matOfPiece(pieces[0]) + 48, 2); }));
  ok('a piece\'s placement moved 51 mm (its matrix only) → "placement box": the outline, placed, is not the box the file stores', check(r, 'placement box', /nest 1, "36MM-.*not the box the file stores for it \(50\.8 mm off\)/), `${r.code} ${r.e?.check} ${r.message}`);
  r = outcome(doctor((c) => { addF64(c, matOfPiece(pieces[0]), 0.2); }));
  ok('a piece\'s matrix stretched → "placement box": placed by something other than a turn, a flip and a move', check(r, 'placement box', /something other than a turn/), `${r.code} ${r.e?.check} ${r.message}`);
  r = outcome(doctor((c) => { addF64(c, matOfPiece(pieces[0]) + 48, 200); addF64(c, boxOfPiece(pieces[0]), 200); addF64(c, boxOfPiece(pieces[0]) + 16, 200); }));
  ok('a piece moved 5 m off its plate, matrix and stored box alike → "inside plate"', check(r, 'inside plate', /lies outside its plate, which is 2500 × 12000 mm/), `${r.code} ${r.e?.check} ${r.message}`);
  // Nest 1 holds two flanges side by side: the second is laid on the first, matrix and stored box alike.
  {
    const nest1 = kid(kid(job, 1004), 1007).kids.find((k) => k.id === 1008);
    const two = findAll(nest1, 1012);
    const dx = base.buf.readDoubleLE(boxOfPiece(two[0])) - base.buf.readDoubleLE(boxOfPiece(two[1]));
    const dy = base.buf.readDoubleLE(boxOfPiece(two[0]) + 8) - base.buf.readDoubleLE(boxOfPiece(two[1]) + 8);
    r = outcome(doctor((c) => { addF64(c, matOfPiece(two[1]) + 48, dx); addF64(c, matOfPiece(two[1]) + 56, dy); for (const [o, d] of [[0, dx], [8, dy], [16, dx], [24, dy]]) addF64(c, boxOfPiece(two[1]) + o, d); }));
    ok('one piece laid on another, matrix and stored box alike → "overlap", naming both', two.length === 2 && check(r, 'overlap', /nest 1: "36MM-.*" at \(.*\) and "36MM-.*" at \(.*\) overlap/), `${r.code} ${r.e?.check} ${r.message}`);
  }
  r = outcome(doctor((c) => { const at = own(part1)[0][0] + 12; c.writeInt32LE(c.readInt32LE(at) + 1, at); }));
  ok('a part\'s "nested" count changed in its header → "counts": what is nested, counted, is not what the header says', check(r, 'counts', /are nested, counted, and its own header says/), `${r.code} ${r.e?.check} ${r.message}`);
  r = outcome(doctor((c) => { const at = own(part1)[0][0] + 8; c.writeInt32LE(1, at); }));
  ok('a part required once and nested four times → "counts"', check(r, 'counts', /4 are nested and only 1 are required/), `${r.code} ${r.e?.check} ${r.message}`);
  r = outcome(doctor((c) => { const at = own(kid(kid(job, 1004), 1007))[0][0]; c.writeInt32LE(c.readInt32LE(at) + 1, at); }));
  ok('the nest list says one more nest than it holds → "counts"', check(r, 'counts', /it says it holds 11 nests and holds 10/), `${r.code} ${r.e?.check} ${r.message}`);
  r = outcome(doctor((c) => { const nest1 = kid(kid(job, 1004), 1007).kids.find((k) => k.id === 1008); c.writeUInt32LE(3, own(nest1)[0][0] + 2); }));
  ok('a nest\'s quantity changed 1 → 3 → "counts": the nest and its plate disagree', check(r, 'counts', /nest 1: it is to be cut 3 times and its plate is counted 1 times/), `${r.code} ${r.e?.check} ${r.message}`);
  r = outcome(doctor((c) => { const tail = own(pieces[0])[2]; c.writeUInt32LE(12345, tail[0] + 12); }));
  ok('a piece that refers to no part → "counts"', check(r, 'counts', /refers to a part the job does not hold/), `${r.code} ${r.e?.check} ${r.message}`);
  r = outcome(doctor((c) => { c.writeDoubleLE(NaN, lines[0] + 4); }));
  ok('a coordinate that is not a number → BAD_FILE, not a nest with a hole in it', r.code === 'BAD_FILE' && /is not a number/.test(r.message), `${r.code} ${r.message}`);
}

section('5. Not a ProNest job, cut short, too big');
{
  let r = outcome(Buffer.from('0\nSECTION\n2\nENTITIES\n0\nENDSEC\n0\nEOF\n'), 'plate.nif');
  ok('a DXF renamed .nif → BAD_FILE: "is not a ProNest job file"', r.code === 'BAD_FILE' && /"plate\.nif" is not a ProNest job file \(\.nif\)/.test(r.message), r.message);
  ok('an empty file, eight bytes, random bytes → BAD_FILE', [Buffer.alloc(0), Buffer.from('ProNest!'), Buffer.from(Array.from({ length: 5000 }, (_, i) => (i * 7919 + 13) % 256))].every((b) => outcome(b).code === 'BAD_FILE'));
  ok('isNif: by its first bytes whatever it is called, else by its name', isNif(base.buf, 'job.bin') && isNif(Buffer.from('x'), 'JOB.NIF') && !isNif(Buffer.from('0\nSECTION'), 'plate.dxf') && !isNif(null, 'plate.dxf'));
  const cuts = [16, 30, 223, 224, 240, 1000, Math.floor(base.buf.length / 3), Math.floor(base.buf.length / 2), base.buf.length - 5000, base.buf.length - 8, base.buf.length - 4, base.buf.length - 1];
  const got = cuts.map((n) => outcome(base.buf.subarray(0, n)));
  ok(`cut short at ${cuts.length} places (16 bytes … the last byte) → BAD_FILE every time, in words`, got.every((g) => g.code === 'BAD_FILE' && /cut short or damaged|not a ProNest job/.test(g.message)), J(got.map((g) => g.code)));
  r = outcome(Buffer.concat([base.buf.subarray(0, 300), Buffer.alloc(NIF_MAX_BYTES)]));
  ok(`over ${NIF_MAX_BYTES / 1048576} MB → TOO_BIG, before anything is read`, r.code === 'TOO_BIG', r.message);
  // Records opened 500 deep, and half a million of them: capped, not followed.
  const open = (id) => { const c = Buffer.alloc(10); c.writeUInt32LE(0xf0f0f0f0, 0); c.writeUInt32LE(id, 4); c.writeUInt16LE(1, 8); return c; };
  const close = Buffer.from([0x0f, 0x0f, 0x0f, 0x0f]);
  const pro = base.buf.subarray(0, 223);
  r = outcome(Buffer.concat([pro, ...Array.from({ length: 500 }, () => open(1005)), ...Array.from({ length: 500 }, () => close)]));
  ok('records nested 500 deep → BAD_FILE (the depth is capped)', r.code === 'BAD_FILE' && /deeper than a ProNest job/.test(r.message), `${r.code} ${r.message}`);
  const t0 = Date.now();
  r = outcome(Buffer.concat([pro, open(1000), ...Array.from({ length: 450000 }, () => Buffer.concat([open(1005), close])), close]));
  ok(`450,000 records → TOO_BIG (the count is capped), in ${Date.now() - t0} ms`, r.code === 'TOO_BIG' && Date.now() - t0 < 5000, `${r.code} ${r.message}`);
}

section('6. Fuzz — truncations, bit flips and smeared bytes of the six real files: refused cleanly or read whole, never anything else');
{
  // A fixed seed: the same cases every run.
  let seed = 20261013;
  const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const N = Math.max(10, Number(process.env.NIF_FUZZ ?? 150));
  const tally = {}; const bad = []; let slowest = 0; let cases = 0; let truncOk = 0;
  const run = (kind, name, buf) => {
    const t0 = Date.now(); const r = outcome(buf, name); const ms = Date.now() - t0;
    cases += 1; if (ms > slowest) slowest = ms;
    tally[r.code] = (tally[r.code] ?? 0) + 1;
    if (r.code !== 'ok' && !REFUSALS.has(r.code)) bad.push(`${kind} ${name}: ${r.code}`);
    if (kind === 'truncated' && r.code === 'ok') truncOk += 1;
    if (r.code !== 'ok' && !(r.message.length > 20)) bad.push(`${kind} ${name}: a refusal with no sentence`);
  };
  for (const { name, buf } of files) {
    for (let i = 0; i < Math.ceil(N * 0.27); i++) run('truncated', name, buf.subarray(0, Math.floor(rnd() * buf.length)));
    for (let i = 0; i < N; i++) { const c = Buffer.from(buf); const at = Math.floor(rnd() * c.length); c[at] ^= 1 << Math.floor(rnd() * 8); run('bit flip', name, c); }
    for (let i = 0; i < Math.ceil(N * 0.2); i++) { const c = Buffer.from(buf); const at = Math.floor(rnd() * (c.length - 64)); const len = 1 + Math.floor(rnd() * 48); for (let k = 0; k < len; k++) c[at + k] = Math.floor(rnd() * 256); run('smear', name, c); }
  }
  ok(`${cases} cases: every one is either read whole or refused with a known code and a sentence — nothing unexpected is thrown`, bad.length === 0, bad.slice(0, 5).join(' | '));
  ok('no truncated file is ever read', truncOk === 0, String(truncOk));
  ok(`none hangs: the slowest case took ${slowest} ms`, slowest < 5000);
  console.log(`        outcomes: ${Object.entries(tally).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  console.log('        (a flipped bit that is read "ok" sits where nothing reads it — padding, settings, costing — or moves a figure by less than the checks\' 0.05 mm.)');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
