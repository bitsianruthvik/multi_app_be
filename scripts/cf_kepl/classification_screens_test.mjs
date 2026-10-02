/**
 * classification_screens_test.mjs — classification managed from the screens
 * that use it, with DERIVED visibility (no hand tagging):
 *
 *   cd multi_app_be && node scripts/cf_kepl/classification_screens_test.mjs
 *   CF_CS_COMPANY=2 (the default: the local KEPL copy)
 *
 * Everything runs inside ONE transaction that is rolled back; the last thing it
 * does is re-count every cf_ table.
 *
 *   1. items-only, definitions-only and shared branches show where they should
 *   2. a selection's candidate branch shows on Definitions (and only the branch)
 *   3. a machine branch shows on Machines only
 *   4. an empty node shows on the screen whose pop-up made it; legacy NULL and
 *      'setup' on Items + Definitions
 *   5. filing a record under a node makes it visible there at once
 *   6. subtree counts, visibleBecause, ancestors, ?all=1 flags hidden nodes
 *   7. retire and move are refused while a branch holds things — in words
 *   8. createdIn is stamped by every door, refused when unknown
 *   9. the screen read is a fixed number of round trips (no query per node)
 */
import '../../apps/cf_erp/services/codegenProvider.js';
import { pool } from '../../db.js';
import { attachNodeCache } from '../../apps/cf_erp/lib/db.js';
import {
  createNode, updateNode, deleteNode, createCatalogNode, createMachineType, getNode,
} from '../../apps/cf_erp/services/classificationService.js';
import { screenTree } from '../../apps/cf_erp/services/classificationScreenService.js';
import { createItem, createDefinition } from '../../apps/cf_erp/services/masterRecordService.js';
import { createMachine } from '../../apps/cf_erp/services/machineService.js';
import { clearProductionMachines } from '../../apps/cf_erp/services/operationService.js';

if (!/^(localhost|127\.0\.0\.1|::1)$/.test(process.env.DB_HOST ?? 'localhost')) throw new Error('This suite is local only.');
const COMPANY = Number(process.env.CF_CS_COMPANY ?? 2);

let passed = 0;
let failed = 0;
function ok(label, condition, detail = '') {
  if (typeof label !== 'string' || typeof condition !== 'boolean') throw new Error('ok(label, condition) takes a string and then a boolean');
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${!condition && detail ? ` — ${detail}` : ''}`);
  if (condition) passed++; else failed++;
}
const eq = (label, got, want) => ok(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
const section = (s) => console.log(`\n${s}`);
const says = (t) => console.log(`        says: ${t}`);
async function refusal(fn) { try { await fn(); return null; } catch (e) { return e; } }

const [tables] = await pool.query("SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME LIKE 'cf\\_%' ORDER BY TABLE_NAME");
const counts = async () => (await pool.query(tables.map((t) => `SELECT '${t.name}' AS name,COUNT(*) AS n FROM \`${t.name}\``).join(' UNION ALL ')))[0];
const before = await counts();
const conn = await pool.getConnection();
let exitCode = 0;

/** Every node of a screen tree, flattened, by id. */
function index(tree) {
  const out = new Map();
  const walk = (n, parent) => { out.set(n.id, { ...n, parent }); n.children.forEach((c) => walk(c, n.id)); };
  tree.roots.forEach((r) => walk(r, null));
  return out;
}

try {
  await conn.beginTransaction();
  attachNodeCache(conn);
  clearProductionMachines();
  const [[user]] = await conn.query('SELECT id FROM users WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [COMPANY]);
  const c = { companyId: COMPANY, userId: user?.id ?? null };
  const tag = `CS${Date.now().toString(36).toUpperCase()}`.slice(0, 9);
  let seq = 0;
  /** A Family > Subfamily > Variant chain, each stamped with `createdIn`. */
  const chain = async (key, createdIn) => {
    const f = await createNode(conn, c, { code: `${tag}${key}F`, name: `${tag} ${key} family`, createdIn });
    const s = await createNode(conn, c, { parentId: f.id, code: `${tag}${key}S`, name: `${tag} ${key} sub`, createdIn });
    const v = await createNode(conn, c, { parentId: s.id, code: `${tag}${key}V`, name: `${tag} ${key} variant`, createdIn });
    return { f: f.id, s: s.id, v: v.id };
  };
  const item = (classificationId) => createItem(conn, c, { classificationId, code: `${tag}-I${++seq}`, name: `${tag} item ${seq}` });
  const template = (classificationId) => createDefinition(conn, c, { definitionType: 'template', classificationId, code: `${tag}-D${++seq}`, name: `${tag} def ${seq}` });

  // ---- fixtures --------------------------------------------------------
  const I = await chain('I', 'items');        // holds an item
  const D = await chain('D', 'definitions');  // holds a template definition
  const B = await chain('B', 'items');        // holds both
  const C = await chain('C', 'items');        // holds an item AND is a selection's search area
  await item(I.v);
  await template(D.v);
  await item(B.v);
  await template(B.v);
  await item(C.v);
  const sel = await createDefinition(conn, c, { definitionType: 'selection', classificationId: D.v, selectionMode: 'spec_match', candidateClassificationId: C.f, code: `${tag}-SEL`, name: `${tag} selection` });
  const mt = await createMachineType(conn, c, { family: { code: `${tag}MF`, name: `${tag} machines` }, subfamily: { code: `${tag}MS`, name: `${tag} cutting` }, code: `${tag}MT`, name: `${tag} plasma` });
  const machine = await createMachine(conn, c, { code: `${tag}-M1`, name: `${tag} plasma 1`, classificationId: mt.id });
  // Empty nodes, one made from each screen, plus the legacy kinds.
  const eItems = await createNode(conn, c, { code: `${tag}EI`, name: `${tag} empty from items`, createdIn: 'items' });
  const eDefs = await createNode(conn, c, { code: `${tag}ED`, name: `${tag} empty from definitions`, createdIn: 'definitions' });
  const eMach = await createNode(conn, c, { code: `${tag}EM`, name: `${tag} empty from machines`, scope: 'machine', createdIn: 'machines' });
  const eNull = await createNode(conn, c, { code: `${tag}EN`, name: `${tag} legacy empty` });
  const eSetup = await createNode(conn, c, { code: `${tag}ES`, name: `${tag} setup empty`, createdIn: 'setup' });
  // An empty Variant made from Definitions INSIDE the items branch.
  const vDefsInI = await createNode(conn, c, { parentId: I.s, code: `${tag}IV2`, name: `${tag} I variant from definitions`, createdIn: 'definitions' });

  const items = index(await screenTree(conn, COMPANY, 'items'));
  const defs = index(await screenTree(conn, COMPANY, 'definitions'));
  const mach = index(await screenTree(conn, COMPANY, 'machines'));
  const on = (map, id) => map.has(id);
  const why = (map, id) => map.get(id)?.visibleBecause ?? [];

  section('1. items-only, definitions-only and shared branches');
  ok('items branch: every level on Items', [I.f, I.s, I.v].every((id) => on(items, id)));
  ok('items branch: variant not on Definitions (it holds only an item)', !on(defs, I.v));
  ok('items branch: not on Machines', ![I.f, I.s, I.v].some((id) => on(mach, id)));
  eq('items variant is there because it holds items', why(items, I.v), ['holds_items']);
  ok('definitions branch: every level on Definitions', [D.f, D.s, D.v].every((id) => on(defs, id)));
  ok('definitions branch: not on Items', ![D.f, D.s, D.v].some((id) => on(items, id)));
  eq('definitions variant is there because it holds definitions', why(defs, D.v), ['holds_definitions']);
  ok('shared branch: on Items and on Definitions', [B.f, B.s, B.v].every((id) => on(items, id) && on(defs, id)));

  section('2. a selection\'s search area shows on Definitions — the branch, not everything below it');
  ok('search area (a Family) is on Definitions', on(defs, C.f));
  ok('…because it is a selection source', why(defs, C.f).includes('selection_source'), JSON.stringify(why(defs, C.f)));
  ok('its variant (items only) stays off Definitions', !on(defs, C.v));
  ok('the whole C branch is on Items (it holds an item)', [C.f, C.s, C.v].every((id) => on(items, id)));
  eq('selection source counts its selection', defs.get(C.f)?.selectionSources, 1);
  ok('the selection itself is a definition in D\'s variant', (defs.get(D.v)?.definitionCount ?? 0) === 2, String(defs.get(D.v)?.definitionCount));
  void sel;

  section('3. a machine branch shows on Machines only');
  ok('family, subfamily and type on Machines', [mt.familyId, mt.subfamilyId, mt.id].every((id) => on(mach, id)));
  ok('…and not on Items or Definitions', ![mt.familyId, mt.subfamilyId, mt.id].some((id) => on(items, id) || on(defs, id)));
  eq('machine type is there because it holds machines', why(mach, mt.id), ['holds_machines']);
  eq('machine family made by the Machines door is stamped machines', (await getNode(conn, COMPANY, mt.familyId)).createdIn, 'machines');

  section('4. empty nodes: the screen that made them; legacy NULL / setup on Items + Definitions');
  ok('empty from Items: on Items only', on(items, eItems.id) && !on(defs, eItems.id) && !on(mach, eItems.id));
  eq('…because it was created here', why(items, eItems.id), ['created_here']);
  ok('empty from Definitions: on Definitions only', on(defs, eDefs.id) && !on(items, eDefs.id) && !on(mach, eDefs.id));
  ok('empty from Machines: on Machines only', on(mach, eMach.id) && !on(items, eMach.id) && !on(defs, eMach.id));
  ok('legacy NULL empty: on Items and Definitions, not Machines', on(items, eNull.id) && on(defs, eNull.id) && !on(mach, eNull.id));
  eq('…because it is a legacy empty node', why(items, eNull.id), ['legacy_empty']);
  ok('setup-made empty: on Items and Definitions', on(items, eSetup.id) && on(defs, eSetup.id) && !on(mach, eSetup.id));
  ok('empty Variant made from Definitions inside the items branch: on Definitions', on(defs, vDefsInI.id));
  ok('…its Subfamily and Family come along as ancestors', why(defs, I.s).includes('ancestor') && why(defs, I.f).includes('ancestor'), `${why(defs, I.s)} / ${why(defs, I.f)}`);
  ok('…and it is not on Items', !on(items, vDefsInI.id));

  section('5. filing a record under a node makes it visible there at once');
  const eDefsS = await createNode(conn, c, { parentId: eDefs.id, code: `${tag}EDS`, name: `${tag} ED sub`, createdIn: 'definitions' });
  const eDefsV = await createNode(conn, c, { parentId: eDefsS.id, code: `${tag}EDV`, name: `${tag} ED variant`, createdIn: 'definitions' });
  ok('before: the definitions-made branch is not on Items', !index(await screenTree(conn, COMPANY, 'items')).has(eDefsV.id));
  await item(eDefsV.id);
  const items2 = index(await screenTree(conn, COMPANY, 'items'));
  ok('after an item is filed there: on Items, every level', [eDefs.id, eDefsS.id, eDefsV.id].every((id) => items2.has(id)));
  eq('…because it holds items', items2.get(eDefsV.id)?.visibleBecause, ['holds_items']);

  section('6. counts, ancestors, ?all=1');
  eq('shared family: subtree counts', items.get(B.f)?.subtree, { items: 1, definitions: 1, machines: 0 });
  eq('shared variant: own counts', [items.get(B.v)?.itemCount, items.get(B.v)?.definitionCount], [1, 1]);
  eq('machine family: subtree machines', mach.get(mt.familyId)?.subtree, { items: 0, definitions: 0, machines: 1 });
  let orphan = 0; let reasonless = 0;
  for (const map of [items, defs, mach]) {
    for (const n of map.values()) {
      if (!n.visibleBecause.length) reasonless++;
      if (n.parentId != null && !map.has(n.parentId)) orphan++;
    }
  }
  eq('every visible node says why', reasonless, 0);
  eq('every visible node\'s parent is visible too', orphan, 0);
  const allDefs = await screenTree(conn, COMPANY, 'definitions', { all: true });
  const allIdx = index(allDefs);
  ok('?all=1 lists the hidden items-only variant, flagged hidden', allIdx.get(I.v)?.hidden === true);
  ok('?all=1 never lists a machine node on the definitions side', !allIdx.has(mt.id));
  const defsNow = index(await screenTree(conn, COMPANY, 'definitions'));
  eq('hiddenCount = the nodes ?all=1 adds', allDefs.hiddenCount, allIdx.size - defsNow.size);
  ok('a definitions-made branch that now holds only an item has left Definitions (derived, strict)', !defsNow.has(eDefsV.id));

  section('7. retire and move refused while a branch holds things');
  let e = await refusal(() => deleteNode(conn, c, B.v));
  ok('retiring the shared variant is refused', e?.code === 'IN_USE', e?.message);
  if (e) says(e.message);
  ok('…naming what it holds', /holds 1 item · 1 definition · 0 machines/.test(e?.message ?? ''));
  e = await refusal(() => deleteNode(conn, c, B.f));
  ok('retiring the shared family: whole branch counted, plus its Subfamily', /holds 1 item · 1 definition · 0 machines; it also has 1 Subfamily below it/.test(e?.message ?? ''), e?.message);
  if (e) says(e.message);
  e = await refusal(() => deleteNode(conn, c, mt.id));
  ok('retiring a machine type with a machine is refused', /holds 0 items · 0 definitions · 1 machine\b/.test(e?.message ?? ''), e?.message);
  e = await refusal(() => updateNode(conn, c, I.s, { parentId: D.f }));
  ok('moving a Subfamily that holds an item is refused', e?.code === 'NOT_EMPTY', e?.message);
  if (e) says(e.message);
  const lone = await createNode(conn, c, { parentId: I.f, code: `${tag}IS2`, name: `${tag} I empty sub`, createdIn: 'items' });
  e = await refusal(() => updateNode(conn, c, lone.id, { parentId: D.f }));
  ok('moving an EMPTY Subfamily is allowed', e === null, e?.message);
  eq('…and it now sits under the definitions family', (await getNode(conn, COMPANY, lone.id)).parentId, D.f);
  e = await refusal(() => deleteNode(conn, c, eNull.id));
  ok('retiring an empty node works', e === null, e?.message);
  ok('…and it is gone from every screen', !index(await screenTree(conn, COMPANY, 'items')).has(eNull.id));
  void machine;

  section('8. createdIn stamped by every door');
  const viaCatalog = await createCatalogNode(conn, c, { parentId: D.s, code: `${tag}CAT`, name: `${tag} via catalog`, createdIn: 'definitions' });
  eq('catalog door keeps definitions', viaCatalog.createdIn, 'definitions');
  const viaPalette = await createCatalogNode(conn, c, { code: `${tag}PAL`, name: `${tag} via palette` });
  eq('catalog door without a screen stamps setup', viaPalette.createdIn, 'setup');
  const viaPaletteMachine = await createCatalogNode(conn, c, { code: `${tag}PM2`, name: `${tag} sneaky`, createdIn: 'machines' });
  eq('catalog door cannot claim machines', viaPaletteMachine.createdIn, 'setup');
  e = await refusal(() => createNode(conn, c, { code: `${tag}BAD`, name: `${tag} bad`, createdIn: 'orders' }));
  ok('an unknown createdIn is refused', e?.code === 'INVALID', e?.message);
  await updateNode(conn, c, eItems.id, { name: `${tag} renamed`, createdIn: 'definitions' });
  eq('rename never rewrites createdIn (the route drops it; the service ignores it)', (await getNode(conn, COMPANY, eItems.id)).createdIn, 'items');
  e = await refusal(() => screenTree(conn, COMPANY, 'orders'));
  ok('an unknown screen is refused', e?.code === 'INVALID');

  section('9. a fixed number of round trips');
  let queries = 0;
  const realQuery = conn.query.bind(conn);
  conn.query = (...args) => { queries++; return realQuery(...args); };
  await screenTree(conn, COMPANY, 'items');
  const forItems = queries;
  queries = 0;
  await screenTree(conn, COMPANY, 'definitions', { all: true });
  conn.query = realQuery;
  eq('items screen read: 6 queries, whatever the tree size', forItems, 6);
  eq('definitions ?all=1: the same 6', queries, 6);
} catch (err) {
  console.error(err);
  failed++;
} finally {
  await conn.rollback();
  conn.release();
  clearProductionMachines();
  const after = await counts();
  const changed = after.filter((a) => Number(before.find((b) => b.name === a.name)?.n) !== Number(a.n)).map((a) => a.name);
  section('table counts');
  ok('every cf_ table count restored', changed.length === 0, changed.join(', '));
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) exitCode = 1;
  await pool.end();
  process.exit(exitCode);
}
