/**
 * bom_edits_custom_po_test.mjs — PURE (no database), user 2026-11-12:
 *   A. a line's BOM edits on its standard's 3D model (lib/lineModelEdits.js): reorder changes nothing, a removed row's
 *      pieces (and what is inside a removed assembly) go, a pasted-back row returns, a new row with sizes is a box beside
 *      its parent (stacked; moved by `placed`), a row lacking a size waits, a part DXF uploaded after the model replaces
 *      the mark's shape in place (quarter turn when drawn the other way), an older DXF does not
 *   B. CUSTOM production orders (executionPlanModel / productionOrderModel): one per chosen group (spanning lines, keyed
 *      by content), one "rest" per line unless the line itself was chosen, counts in the preview and totals, problems
 *      (a row twice, a row inside another chosen row, a row the line lacks), and which order each piece goes to
 *
 *   cd multi_app_be && node scripts/cf_kepl/bom_edits_custom_po_test.mjs
 */
import path from 'path';
import { pathToFileURL } from 'url';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const E = await imp('apps/cf_erp/lib/lineModelEdits.js');
const EPM = await imp('apps/cf_erp/services/executionPlanModel.js');
const POM = await imp('apps/cf_erp/services/productionOrderModel.js');

let passed = 0;
let failed = 0;
function ok(label, cond, detail = '') {
  if (typeof label !== 'string' || typeof cond !== 'boolean') throw new Error('ok(label, cond) takes a string and then a boolean');
  if (cond) { passed += 1; console.log(`  PASS  ${label}`); } else { failed += 1; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
}
const section = (s) => console.log(`\n${s}`);

/* ── A. the line's diagram ─────────────────────────────────────────────── */
section('A. BOM edits on the 3D model');
const saved = '2026-11-01T10:00:00Z';
const before = '2026-10-30T10:00:00Z';
const later = '2026-11-05T10:00:00Z';
const model = {
  schema: 'cf-erp-model3d/2', units: 'mm',
  parts: { p1: { pts: [[0, 0], [1000, 0], [1000, 200], [0, 200]], t: 10, holes: [[100, 100, 22]] } },
  elements: [
    { id: 'a', mark: 'G1-W', in: ['G1'], part: 'p1', o: [0, 0, 0], u: [1, 0, 0], v: [0, 0, 1], w: [0, 1, 0] },
    { id: 'b', mark: 'G1-F', in: ['G1'], part: 'p1', o: [0, 0, 200], u: [1, 0, 0], v: [0, 1, 0], w: [0, 0, 1] },
    { id: 'c', mark: 'G2-W', in: ['G2'], part: 'p1', o: [0, 3000, 0], u: [1, 0, 0], v: [0, 0, 1], w: [0, 1, 0] },
    { id: 'd', mark: 'X1', in: ['G2'], box: { c: [500, 3000, 500], size: [100, 100, 100] } },
  ],
};
const row = (id, mark, parentId, extra = {}) => ({ id, name: `Row ${id}`, mark, markNorm: mark ? E.editsOf({ removed: [mark] }).removed[0] : null, parentId, createdAt: before, hasChildren: false, ...extra });
const rows = [row(1, 'G1', null, { hasChildren: true }), row(2, 'G1-W', 1), row(3, 'G1-F', 1), row(4, 'G2', null, { hasChildren: true }), row(5, 'G2-W', 4), row(6, 'X1', 4)];

let r = E.applyLineEdits(model, { savedAt: saved, rows, edits: null });
ok('no edits: every piece drawn, nothing listed', r.model.elements.length === 4 && !E.hasEdits(r.edits));
r = E.applyLineEdits(model, { savedAt: saved, rows: [...rows].reverse(), edits: null });
ok('rows reordered: the same diagram', r.model.elements.map((x) => x.id).join() === 'a,b,c,d');

r = E.applyLineEdits(model, { savedAt: saved, rows: rows.filter((x) => x.id !== 3), edits: { removed: ['G1-F'] } });
ok('a removed row: its piece goes', r.model.elements.map((x) => x.id).join() === 'a,c,d' && r.edits.hidden.pieces === 1);
r = E.applyLineEdits(model, { savedAt: saved, rows: rows.filter((x) => ![4, 5, 6].includes(x.id)), edits: E.withRemoved(null, ['G2', 'G2-W', 'X1']) });
ok('a removed assembly: everything inside it goes', r.model.elements.map((x) => x.id).join() === 'a,b' && r.edits.hidden.marks.join() === 'G2,G2-W,X1');
r = E.applyLineEdits(model, { savedAt: saved, rows, edits: { removed: ['G1-F'] } });
ok('pasted back (live again): the piece returns', r.model.elements.length === 4 && r.edits.hidden.pieces === 0);
ok('the input model is left alone', model.elements.length === 4 && !model.parts['p1~dxf1']);

const newRow = row(7, null, 1, { createdAt: later, name: 'Stiffener', lengthMm: 300, widthMm: 100, thicknessMm: 12 });
const newRow2 = row(8, null, 1, { createdAt: later, name: 'Packer', lengthMm: 50, widthMm: 50, thicknessMm: 8 });
r = E.applyLineEdits(model, { savedAt: saved, rows: [...rows, newRow, newRow2], edits: null });
const box = r.model.elements.find((x) => x.id === 'row7');
const box2 = r.model.elements.find((x) => x.id === 'row8');
ok('a new row with sizes: a box of its sizes', !!box && box.box.size.join() === '300,100,12' && box.added === true);
ok('beside its parent: past the parent\'s far x, lit with it', box.box.c[0] === 1000 + 200 + 150 && box.in?.[0] === 'G1');
ok('a second new row stacks above the first', box2 && box2.box.c[2] - 4 > box.box.c[2] + 6 - 0.001);
ok('both listed as added', r.edits.added.length === 2 && r.edits.added[0].moved === false);
r = E.applyLineEdits(model, { savedAt: saved, rows: [...rows, newRow], edits: E.withPlaced(null, 7, [10, 20, 30]) });
ok('moved by X / Y / Z: its corner there', r.model.elements.find((x) => x.id === 'row7').box.c.join() === '160,70,36' && r.edits.added[0].moved);
r = E.applyLineEdits(model, { savedAt: saved, rows: [...rows, { ...newRow, thicknessMm: null }], edits: null });
ok('a new row without a thickness waits', r.edits.waiting.length === 1 && r.edits.waiting[0].missing.join() === 'thickness' && !r.model.elements.some((x) => x.added));
r = E.applyLineEdits(model, { savedAt: saved, rows: [...rows, { ...newRow, createdAt: before }], edits: null });
ok('a row older than the model is not a new part', r.edits.added.length === 0);
r = E.applyLineEdits(model, { savedAt: saved, rows: [...rows, { ...newRow, hasChildren: true }], edits: null });
ok('an assembly row is not drawn as a box', r.edits.added.length === 0);

const g = { lengthMm: 200, widthMm: 1000, holes: 1, innerCuts: 0, rings: [[[0, 0], [200, 0], [200, 1000], [0, 1000]], [[90, 490], [110, 490], [110, 510], [90, 510]]] };
r = E.applyLineEdits(model, { savedAt: saved, rows, drawings: [{ id: 9, markNorm: 'G1-F', mark: 'G1-F', createdAt: later, geometry: g }] });
const fl = r.model.elements.find((x) => x.id === 'b');
const shape = r.model.parts[fl.part];
ok('a new DXF: the mark takes its shape, the other marks keep theirs', fl.part === 'p1~dxf9' && r.model.elements.find((x) => x.id === 'a').part === 'p1');
ok('drawn the other way: turned a quarter onto the old outline', shape.pts.map((q) => q.join(':')).join() === '0:0,0:200,1000:200,1000:0' && r.edits.replaced[0].swapped);
ok('its hole moved with it, thickness kept', shape.holes[0].join() === '500,100,20' && shape.t === 10);
r = E.applyLineEdits(model, { savedAt: saved, rows, drawings: [{ id: 9, markNorm: 'G1-F', createdAt: before, geometry: g }] });
ok('a DXF older than the model changes nothing', r.edits.replaced.length === 0 && r.model.elements.find((x) => x.id === 'b').part === 'p1');

/* ── B. custom production orders ───────────────────────────────────────── */
section('B. Custom production orders');
const n = (id, lineId, kids = [], q = 1) => ({ id, lineId, name: `N${id}`, code: null, quantity: q, depth: 1, kind: 'temporary', children: kids });
const tree1 = { root: { id: 100, name: 'Span', code: null, quantity: 1, depth: 0, children: [n(1, 11, [n(2, 12), n(3, 13)]), n(4, 14)] } };
const tree2 = { root: { id: 200, name: 'Pier', code: null, quantity: 1, depth: 0, children: [n(5, 21)] } };
const plan = (groups) => ({ production: { level: 'custom', levelId: null }, dispatch: { level: 'same', levelId: null }, groups });
const groups = [{ name: null, keys: ['L1N11', 'L2N21'] }, { name: 'Bracings', keys: ['L1N14'] }];
const lines = [
  { lineId: 1, lineNo: 1, quantity: 1, itemName: 'Span', plan: plan(groups), tree: tree1, shape: null },
  { lineId: 2, lineNo: 2, quantity: 1, itemName: 'Pier', plan: plan(groups), tree: tree2, shape: null },
];
const defOf = () => null;
const pos = POM.plannedProductionOrders('SO1', lines, defOf);
ok('one per group, then one rest per line', pos.map((x) => x.scopeKey).join() === 'C:L1N11,C:L1N14,L1R,L2R', pos.map((x) => x.scopeKey).join());
ok('a group spanning lines covers both', pos[0].lineIds.join() === '1,2' && pos[0].lineId === null && pos[0].members.join() === 'L1N11,L2N21');
ok('named groups keep their name', /Bracings/.test(pos[1].label));
const pv = EPM.previewOrder('SO1', lines, defOf);
ok('the preview counts each group once', pv.production.count === 4 && pv.dispatch.count === 4, `${pv.production.count}/${pv.dispatch.count}`);
ok('totals agree', EPM.totalsOf(lines).production === 4);
const whole = plan([{ name: null, keys: ['L2'] }]);
const pos2 = POM.plannedProductionOrders('SO1', lines.map((l) => ({ ...l, plan: whole })), defOf);
ok('a whole line chosen: no rest for it', pos2.map((x) => x.scopeKey).join() === 'C:L2,L1R');
ok('nothing chosen yet: one per line', POM.plannedProductionOrders('SO1', lines.map((l) => ({ ...l, plan: plan([]) })), defOf).length === 2);

ok('a fine plan has no problems', EPM.checkCustomGroups(lines[0], lines[0].plan, tree1).length === 0);
ok('a row twice is a problem', EPM.checkCustomGroups(lines[0], plan([{ keys: ['L1N12'] }, { keys: ['L1N12'] }]), tree1).some((x) => /in one production order/.test(x)));
ok('a row inside another picked row is fine (the nearest pick wins)', EPM.checkCustomGroups(lines[0], plan([{ keys: ['L1N11'] }, { keys: ['L1N12'] }]), tree1).length === 0);
ok('a row the line lacks is a problem', EPM.checkCustomGroups(lines[0], plan([{ keys: ['L1N99'] }]), tree1).some((x) => /no longer has/.test(x)));
ok('the picker lists the line and its rows', EPM.customNodes(lines[0]).map((x) => x.key).join() === 'L1,L1N11,L1N12,L1N13,L1N14');

const items0 = () => [
  { id: 1, parent_id: null, depth: 0, sort_order: 0, bom_line_id: null, item_id: 100 },
  { id: 2, parent_id: 1, depth: 1, sort_order: 1, bom_line_id: 11, item_id: 1 },
  { id: 3, parent_id: 2, depth: 2, sort_order: 2, bom_line_id: 12, item_id: 2 },
  { id: 4, parent_id: 1, depth: 1, sort_order: 3, bom_line_id: 14, item_id: 4 },
];
const stored = pos.map((x, i) => ({ id: 50 + i, scope_key: x.scopeKey, level: x.level, level_id: null, members_json: x.members ? JSON.stringify(x.members) : null }));
const items = items0();
const map = POM.assignPieces(1, items, stored.filter((o) => o.scope_key !== 'L2R'), defOf);
ok('pieces go with the row picked above them', map.get(2) === 50 && map.get(3) === 50 && map.get(4) === 51);
ok('the line\'s own assembly goes to its rest', map.get(1) === 52);
{
  const nested = plan([{ name: null, keys: ['L1'] }, { name: null, keys: ['L1N12'] }]);
  const one = [{ ...lines[0], plan: nested }];
  const ps = POM.plannedProductionOrders('SO1', one, defOf);
  const st = ps.map((x, i) => ({ id: 70 + i, scope_key: x.scopeKey, level: x.level, level_id: null, members_json: JSON.stringify(x.members) }));
  const m = POM.assignPieces(1, items0(), st, defOf);
  ok('the whole line picked, one row inside it picked too: that row (and below) to its own, the rest to the line', ps.length === 2 && m.get(3) === 71 && m.get(2) === 70 && m.get(1) === 70 && m.get(4) === 70);
}
ok('keyLineId reads custom keys', EPM.keyLineId('L12N4') === 12 && EPM.keyLineId('L12') === 12 && EPM.keyLineId('L3U1') === 3);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
