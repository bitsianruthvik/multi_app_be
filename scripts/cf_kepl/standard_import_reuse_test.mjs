/**
 * standard_import_reuse_test.mjs — the standard importer reuses the catalog's definitions (user, 2026-11-06: the 11-05
 * imports made 19 definitions that repeated one the catalog had; TM/drawing_bom/DEFINITION_AUDIT.md). Pure: planImport
 * on small bom.json trees against a small catalog, no database.
 *   node scripts/cf_kepl/standard_import_reuse_test.mjs
 */
import { planImport, plainName, likeness } from '../../apps/cf_erp/lib/standardImport.js';

let pass = 0; let fail = 0;
const ok = (what, cond, extra = '') => { if (cond) { pass++; console.log(`  PASS  ${what}`); } else { fail++; console.log(`  FAIL  ${what}${extra ? ` — ${extra}` : ''}`); } };

// Classes: 1 Parts › 11 Plate part, 12 Profile part; 2 Assemblies › 21 Girder segment, 22 Diaphragm, 23 Arch box, 24 Top tie beam, 25 Seismic stoppers.
const classes = [{ id: 1, parent_id: null }, { id: 2, parent_id: null }, { id: 11, parent_id: 1 }, { id: 12, parent_id: 1 }, { id: 21, parent_id: 2 }, { id: 22, parent_id: 2 }, { id: 23, parent_id: 2 }, { id: 24, parent_id: 2 }, { id: 25, parent_id: 2 }];
let n = 100;
const def = (name, cls, extra = {}) => ({ id: ++n, code: name.slice(0, 3).toUpperCase(), name, short_name: null, status: 'active', classification_id: cls, default_flow_id: null, definition_type: 'template', bom_id: null, ...extra });
const defs = [
  def('Composite girder span', 21, { code: 'SPAN-001' }), def('Girder segment', 21), def('Splice set', 21),
  def('End diaphragm', 22), def('Intermediate diaphragm', 22), def('Arch box', 23), def('Top tie beam', 24), def('Seismic stopper', 25),
  def('Top flange', 11), def('Web plate', 11), def('Intermediate diaphragm web', 11), def('Pad plate', 11), def('Packing plate', 11), def('Web splice', 11), def('Bracket plate', 11),
  def('Girder top splice plate', 11), def('Arch side splice plate', 11), def('Bow string splice plate', 11), def('Restrainer plate', 11), def('Stiffener plate', 11),
  def('Splice plate', 11, { status: 'obsolete' }), def('Cover plate', 11, { status: 'obsolete' }), def('Web cover plate', 11),
  def('Bracing', 12), def('Bottom lateral bracing member', 12), def('Angle cleat', 12),
  def('Bottom longitudinal beam', 23), def('Intermediate cross beam', 24),
  def('Bow string girder span', 21), def('Tub girder span', 21),
];
const catalog = { defs, classes, specs: new Map(), gradeOption: new Map(), impactOption: new Map(), materialOption: new Map(), studs: [], bolts: [], standards: new Map() };
const plate = (id, mark, role, description) => ({ id, mark, role, description, category: 'plate', thicknessMm: 20, widthMm: 300, lengthMm: 1000 });
const bomOf = (title, nodes, items) => ({ schema: 'rdso-standard-drawing-bom/1', drawing: { number: 'T-1', title }, items, assembly: { kind: 'span', name: `SPAN/${title}`, children: nodes } });
const to = (p, what) => { const r = p.rows.find((x) => (x.item ? `${x.item.mark}` : x.node?.name) === what); return r?.def?.new ? `NEW ${r.def.new}` : (r?.def?.name ?? '(none)'); };

console.log('1. plainName: what follows a comma is a note');
ok('"Stringer, end bay" → Stringer', plainName('Stringer, end bay') === 'Stringer', plainName('Stringer, end bay'));
ok('"Hanger beam HB-4, two pieces, with its stiffeners" → Hanger beam', plainName('Hanger beam HB-4, two pieces, with its stiffeners') === 'Hanger beam', plainName('Hanger beam HB-4, two pieces, with its stiffeners'));
ok('"End cover plate 36 thick, joins BLB and arch, true shape" → End cover plate', plainName('End cover plate 36 thick, joins BLB and arch, true shape') === 'End cover plate');
ok('an RDSO name stays: "Jacking bracket plate 680x12x700"', plainName('Jacking bracket plate 680x12x700') === 'Jacking bracket plate');
ok('likeness: "Intermediate bottom cross beam" holds every word of "Intermediate cross beam"', likeness('Intermediate bottom cross beam', 'Intermediate cross beam').subset);

console.log('2. A girder span: synonyms, the family guard, obsolete → successor');
const g = planImport(bomOf('Plate girder 60 m', [
  { kind: 'assembly', name: 'ED/End cross girder diaphragm', qtyPerParent: 2, children: [{ item: 'p1', qtyPerParent: 1 }] },
  { kind: 'assembly', name: 'ID/Intermediate cross girder diaphragm', qtyPerParent: 4, children: [{ item: 'p1', qtyPerParent: 1 }] },
  { kind: 'assembly', name: 'GSA/Girder seismic arrestor', qtyPerParent: 4, children: [{ item: 'p4', qtyPerParent: 2 }] },
  { kind: 'girder_segment', name: 'G1/Girder segment', qtyPerParent: 1, children: [{ item: 'p2', qtyPerParent: 2 }, { item: 'p3', qtyPerParent: 4 }, { item: 'p5', qtyPerParent: 2 }, { item: 'p6', qtyPerParent: 1 }] },
], [plate('p1', 'DW', 'diaphragm_web', 'Diaphragm web'), plate('p2', 'SPL', 'splice_plate', 'Splice plate, web 1 to web 2'), plate('p3', 'TIPK', 'top_packing_splice', 'SP1 top inner packing'),
  plate('p4', 'GSA-TOP', 'restrainer_plate', 'Girder seismic arrestor top plate'), plate('p5', 'CL', 'cleat_plate', 'Cleat plate'), plate('p6', 'WCP', 'cover_plate', 'Web side cover plate')]), catalog);
ok('a web cover plate → Web cover plate', to(g, 'WCP') === 'Web cover plate', to(g, 'WCP'));
// The successor route, through a role the list does not know (its name comes from the description: "Cover plate").
const sc = planImport(bomOf('Plate girder', [{ kind: 'girder_segment', name: 'G1/Girder segment', qtyPerParent: 1, children: [{ item: 'w1', qtyPerParent: 1 }] }],
  [plate('w1', 'WCP2', 'cover', 'Cover plate, web side')]), catalog);
ok('obsolete "Cover plate" → its successor the row\'s words point at (Web cover plate)', to(sc, 'WCP2') === 'Web cover plate' && sc.mappings.some((m) => m.how === 'successor'), `${to(sc, 'WCP2')} ${JSON.stringify(sc.mappings.map((m) => m.how))}`);
ok('"End cross girder diaphragm" → End diaphragm', to(g, 'ED/End cross girder diaphragm') === 'End diaphragm', to(g, 'ED/End cross girder diaphragm'));
ok('"Intermediate cross girder diaphragm" → Intermediate diaphragm', to(g, 'ID/Intermediate cross girder diaphragm') === 'Intermediate diaphragm');
ok('a seismic arrestor → Seismic stopper, with no second stopper inside it', to(g, 'GSA/Girder seismic arrestor') === 'Seismic stopper' && !g.rows.some((r) => r.node?.name === 'Seismic stopper'));
ok('"Splice plate, web …" → Web splice', to(g, 'SPL') === 'Web splice', to(g, 'SPL'));
ok('a packing splice → Packing plate', to(g, 'TIPK') === 'Packing plate', to(g, 'TIPK'));
ok('a cleat plate → Bracket plate', to(g, 'CL') === 'Bracket plate', to(g, 'CL'));
ok('no new definitions on a girder span the catalog covers', g.newDefinitions.length === 0, g.newDefinitions.map((d) => d.name).join(', '));

console.log('3. A bow string: the catalog\'s names, splice plates by place');
const b = planImport(bomOf('Bow string span 72 m', [
  { kind: 'assembly', name: 'BLB1/Bottom long beam BLB1, 10250 long', qtyPerParent: 2, children: [{ item: 'b1', qtyPerParent: 2 }, { item: 'b2', qtyPerParent: 2 }] },
  { kind: 'assembly', name: 'AB1/Arch beam AB1', qtyPerParent: 2, children: [{ item: 'b3', qtyPerParent: 2 }] },
  { kind: 'assembly', name: 'BCB1/Intermediate bottom cross beam BCB1', qtyPerParent: 4, children: [{ item: 'b4', qtyPerParent: 2 }] },
  { kind: 'assembly', name: 'TTC/Top tie chord beam, first and last bay', qtyPerParent: 2, children: [{ item: 'b4', qtyPerParent: 1 }] },
  { kind: 'assembly', name: 'HB1/Hanger beam HB-1, with its stiffeners and covers', qtyPerParent: 2, children: [{ item: 'b5', qtyPerParent: 1 }] },
], [plate('b1', 'BLB-SP1', 'splice_plate', 'BLB top / bottom splice plate 32 x 650 x 2200, welded'), plate('b2', 'BLB-W', 'web', 'BLB side plate'),
  plate('b3', 'AB-SP2', 'splice_plate', 'Arch side splice plate 40 x 1000 x 1800, welded'), plate('b4', 'BCB3-SP1', 'splice_plate', 'BCB3 top / bottom splice plate, welded'),
  plate('b5', 'HB-SP1', 'splice_plate', 'Hanger front / back splice plate, welded')]), catalog);
ok('"Bottom long beam" → Bottom longitudinal beam', to(b, 'BLB1/Bottom long beam BLB1, 10250 long') === 'Bottom longitudinal beam');
ok('"Arch beam" → Arch box', to(b, 'AB1/Arch beam AB1') === 'Arch box');
ok('"Intermediate bottom cross beam" → Intermediate cross beam', to(b, 'BCB1/Intermediate bottom cross beam BCB1') === 'Intermediate cross beam');
ok('"Top tie chord beam, first and last bay" → Top tie beam', to(b, 'TTC/Top tie chord beam, first and last bay') === 'Top tie beam');
ok('BLB splice plate → Girder top splice plate', to(b, 'BLB-SP1') === 'Girder top splice plate', to(b, 'BLB-SP1'));
ok('arch side splice plate → Arch side splice plate', to(b, 'AB-SP2') === 'Arch side splice plate', to(b, 'AB-SP2'));
ok('any other bow string splice plate → Bow string splice plate (never the obsolete Splice plate again)', to(b, 'HB-SP1') === 'Bow string splice plate', to(b, 'HB-SP1'));
const hb = b.newDefinitions.find((d) => d.name === 'Hanger beam');
ok('what is new is one short name ("Hanger beam"), listed with a nearest existing definition', b.newDefinitions.length === 1 && !!hb && 'nearest' in hb, b.newDefinitions.map((d) => d.name).join(', '));

const lone = planImport(bomOf('Plate girder', [{ kind: 'girder_segment', name: 'G1/Girder segment', qtyPerParent: 1, children: [{ item: 'y1', qtyPerParent: 1 }] }],
  [plate('y1', 'CPX', 'cover_plate', 'Cover plate')]), { ...catalog, defs: defs.filter((d) => d.name !== 'Web cover plate').concat(def('Web cover plate', 11)) });
ok('a row whose words point at no successor is not given one by default', to(lone, 'CPX') === 'NEW Cover plate', to(lone, 'CPX'));

console.log('4. The family guard: a plate never lands on an assembly');
const f = planImport(bomOf('Plate girder', [{ kind: 'girder_segment', name: 'G1/Girder segment', qtyPerParent: 1, children: [{ item: 'x1', qtyPerParent: 1 }] }],
  [plate('x1', 'X', 'arch_beam_plate', 'Arch beam plate')]), catalog);
ok('"Arch beam plate" (a plate) is not taken as Arch box (an assembly)', to(f, 'X') !== 'Arch box', to(f, 'X'));

console.log('5. A railway open web girder reuses the truss names (RDSO B-17186 / B-17081, 2026-11-06)');
const trussDefs = defs.concat([
  def('Steel truss span', 21), def('Main truss', 21), def('Top chord piece', 21), def('Bottom chord piece', 21), def('End raker piece', 21),
  def('Truss vertical', 21), def('Truss diagonal', 21), def('Truss joint', 21), def('End cross girder', 21), def('Bottom cross girder', 21),
  def('Stringer', 21), def('Bracing gusset set', 21), def('Top bracing system', 21), def('Batten plate', 11), def('Gusset plate', 11),
  def('Top flange inner cover plate', 11), def('Flange cover plate', 11), def('Top lateral bracing member', 12),
]);
const tr = planImport({ ...bomOf('RDSO/B-17186: 30.50 m clear span open web girder, welded through type', [
  { kind: 'truss', name: 'TRUSS/Main truss (T1, T2)', qtyPerParent: 2, children: [
    { kind: 'member', name: 'TC1/Top chord U1–U2 (shipping marks 2 / 2X)', qtyPerParent: 2, children: [{ item: 't1', qtyPerParent: 1 }, { item: 't2', qtyPerParent: 2 }] },
    { kind: 'member', name: 'V1/Vertical L1–U1', qtyPerParent: 2, children: [{ item: 't1', qtyPerParent: 1 }] },
    { kind: 'joint', name: 'JU1/Joint U1 and U5 (marks 12, 13, 14)', qtyPerParent: 2, children: [{ item: 't3', qtyPerParent: 1 }, { item: 't4', qtyPerParent: 1 }, { item: 't5', qtyPerParent: 1 }] },
  ] },
  { kind: 'assembly', name: 'FLOOR/Floor system', qtyPerParent: 1, children: [
    { kind: 'cross_girder', name: 'ICG/Intermediate cross girder', qtyPerParent: 5, children: [{ item: 't1', qtyPerParent: 2 }] },
    { kind: 'assembly', name: 'LBX/Bottom lateral crossing: central gusset', qtyPerParent: 1, children: [{ item: 't3', qtyPerParent: 1 }] },
  ] },
  { kind: 'assembly', name: 'TLAT/Top lateral bracing', qtyPerParent: 1, children: [{ item: 't6', qtyPerParent: 2 }] },
  { kind: 'assembly', name: 'PG/Portal girder PG', qtyPerParent: 2, children: [{ item: 't1', qtyPerParent: 2 }] },
], [
  plate('t1', 'TC1-FL', 'flange', 'Top chord U1–U2: flange strip 100 × 12 × 5325'),
  plate('t2', 'TC-BT', 'batten', 'Top chord: end batten 550 × 470 × 12'),
  plate('t3', 'P12', 'bent_plate', 'BLB BEND PLATE, 10 mm'),
  plate('t4', 'P16', 'cover_plate', 'Top inner flange cover plate U2, U3, 490 × 10 × 882'),
  plate('t5', 'P27', 'cover_plate', 'Top and bottom flange cover plate L1, 482 × 10 × 1130'),
  { id: 't6', mark: 'A1', role: 'section', description: 'TLB, ISST 200x165 x 3813.5', category: 'section', profile: 'ISST 200x165', lengthMm: 3813.5 },
]) }, { ...catalog, defs: trussDefs });
const nodeTo = (p, name) => { const r = p.rows.find((x) => x.node?.name === name); return r?.def?.new ? `NEW ${r.def.new}` : (r?.def?.name ?? '(none)'); };
ok('an open web girder span is a Steel truss span', tr.rows[0]?.def?.name === 'Steel truss span', tr.rows[0]?.def?.name ?? tr.rows[0]?.def?.new);
ok('"Top chord U1–U2" → Top chord piece', nodeTo(tr, 'TC1/Top chord U1–U2 (shipping marks 2 / 2X)') === 'Top chord piece', nodeTo(tr, 'TC1/Top chord U1–U2 (shipping marks 2 / 2X)'));
ok('"Vertical L1–U1" → Truss vertical', nodeTo(tr, 'V1/Vertical L1–U1') === 'Truss vertical');
ok('"Joint U1 and U5" → Truss joint (never "Joint and")', nodeTo(tr, 'JU1/Joint U1 and U5 (marks 12, 13, 14)') === 'Truss joint', nodeTo(tr, 'JU1/Joint U1 and U5 (marks 12, 13, 14)'));
ok('an intermediate cross girder of a through truss → Bottom cross girder', nodeTo(tr, 'ICG/Intermediate cross girder') === 'Bottom cross girder');
ok('a lateral crossing gusset set → Bracing gusset set', nodeTo(tr, 'LBX/Bottom lateral crossing: central gusset') === 'Bracing gusset set');
ok('top lateral bracing → Top bracing system (not Bottom lateral bracing)', nodeTo(tr, 'TLAT/Top lateral bracing') === 'Top bracing system', nodeTo(tr, 'TLAT/Top lateral bracing'));
ok('"Portal girder PG" → a short new name, the mark dropped', nodeTo(tr, 'PG/Portal girder PG') === 'NEW Portal girder', nodeTo(tr, 'PG/Portal girder PG'));
ok('a flange strip is named by its role, not by its member ("Top chord …:")', to(tr, 'TC1-FL') === 'NEW Member flange plate', to(tr, 'TC1-FL'));
ok('a batten → Batten plate', to(tr, 'TC-BT') === 'Batten plate');
ok('a bent plate → Gusset plate', to(tr, 'P12') === 'Gusset plate');
ok('"Top inner flange cover plate" → Top flange inner cover plate', to(tr, 'P16') === 'Top flange inner cover plate', to(tr, 'P16'));
ok('a flange cover plate on both faces → Flange cover plate', to(tr, 'P27') === 'Flange cover plate', to(tr, 'P27'));
ok('a TLB tee → Top lateral bracing member', to(tr, 'A1') === 'Top lateral bracing member', to(tr, 'A1'));
console.log('6. Each structure takes the span of its own kind (2026-11-07: bow strings had been given the Composite girder span)');
const rootOf = (p) => (p.rows[0]?.def?.new ? `NEW ${p.rows[0].def.new}` : (p.rows[0]?.def?.name ?? '(none)'));
ok('a bow string span → Bow string girder span', rootOf(b) === 'Bow string girder span', rootOf(b));
ok('…never the Composite girder span (SPAN-001)', b.rows[0]?.def?.code !== 'SPAN-001');
const bsTitle = planImport({ ...bomOf('1 x 49.4 m clear span steel bow string girder', [], []), assembly: { kind: 'span', name: 'SPAN/Span 49.4 m clear', children: [] } }, catalog);
ok('the drawing title says bow string when the span name does not', rootOf(bsTitle) === 'Bow string girder span', rootOf(bsTitle));
const tub = planImport(bomOf('Khajaguda flyover P10–P13: 3 × 30 m continuous steel tub girder superstructure', [], []), catalog);
ok('a continuous steel tub girder → Tub girder span', rootOf(tub) === 'Tub girder span', rootOf(tub));
const owg = planImport(bomOf('RDSO/B-17186: 30.50 m clear span open web girder, welded through type', [], []), { ...catalog, defs: trussDefs });
ok('a railway open web girder → Steel truss span', rootOf(owg) === 'Steel truss span', rootOf(owg));
const noBs = { ...catalog, defs: defs.filter((d) => !/^(Bow string girder span|Tub girder span)$/.test(d.name)) };
const bNew = planImport(bomOf('Bow string span 72 m', [], []), noBs);
const nd = bNew.newDefinitions.find((d) => d.name === 'Bow string girder span');
ok('a tenant without it: a NEW Bow string girder span (asked by name), never SPAN-001', rootOf(bNew) === 'NEW Bow string girder span', rootOf(bNew));
ok('…filed as a structure, beside the Composite girder span (its nearest, a telling word)', nd?.classHint === 'structure' && nd?.nearest?.name === 'Composite girder span' && nd?.nearest?.telling, JSON.stringify(nd));
ok('a launching tackle keeps its own name', rootOf(planImport({ ...bomOf('Launching tackle', [], []), assembly: { kind: 'span', name: 'LT/Launching tackle', children: [] } }, catalog)) === 'NEW Launching tackle');
ok('a girder title without truss words is still a Bridge span', planImport(bomOf('Plate girder 36 m', [], []), catalog).rows[0]?.def?.name === 'Composite girder span');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
