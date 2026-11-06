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
ok('obsolete "Cover plate" → its successor the row\'s words point at (Web cover plate)', to(g, 'WCP') === 'Web cover plate' && g.mappings.some((m) => m.how === 'successor'), to(g, 'WCP'));
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
