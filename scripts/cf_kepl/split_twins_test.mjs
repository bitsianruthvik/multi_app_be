/**
 * split_twins_test.mjs — line-sync's split twins (lib/splitTwins.mjs, 2026-11-27).
 *
 *   cd multi_app_be && node scripts/cf_kepl/split_twins_test.mjs
 *
 * ONE TRANSACTION, ROLLED BACK; every cf_ table re-counted. Its own fixture (link_fixture.mjs): two linked segments whose
 * webs carry different drawing marks (TW-A, TW-B) — what line-sync makes of a split mark (OWG V2-SP → V2-SPI + V2-SPO).
 * Proved: a plain upload puts the first twin's file on both and refuses the second (the trap); aimed, each file goes on
 * its own row only; a twin's drawing already on a row is taken off when the row's own file comes; a file whose copies
 * carry the same mark (or none) is not aimed.
 */
import { pool } from '../../db.js';
import '../../apps/cf_erp/services/codegenProvider.js';
import { attachNodeCache, detachNodeCache } from '../../apps/cf_erp/lib/db.js';
import * as OV from '../../apps/cf_erp/services/orderValuesService.js';
import * as BC from '../../apps/cf_erp/services/bomChangeService.js';
import { uploadDrawings, getDrawings } from '../../apps/cf_erp/services/partDrawingService.js';
import { aimSplitTwins, aimedFile, dropTwinLinks } from './lib/splitTwins.mjs';
import { buildLinkFixture, harness, tableCounts, newTag, COMPANY } from './link_fixture.mjs';

if (!/^(localhost|127\.0\.0\.1|::1)$/.test(process.env.DB_HOST ?? 'localhost')) throw new Error('Local only.');
const { state, ok, section } = harness();
const before = await tableCounts(pool);
const db = await pool.getConnection();
const c = { companyId: COMPANY, userId: null };
let sp = 0;
const rehearse = async (fn) => { const name = `stt_${sp += 1}`; await db.query(`SAVEPOINT ${name}`); try { return await fn(); } finally { await db.query(`ROLLBACK TO SAVEPOINT ${name}`); } };

const rect = (l, w) => ['0', 'SECTION', '2', 'ENTITIES', '0', 'LWPOLYLINE', '8', 'PART', '90', '4', '70', '1',
  ...[[0, 0], [l, 0], [l, w], [0, w]].flatMap(([x, y]) => ['10', String(x), '20', String(y)]), '0', 'ENDSEC', '0', 'EOF'].join('\n');
const file = (name, text) => ({ name, content: Buffer.from(text, 'latin1').toString('base64') });

try {
  await db.beginTransaction();
  attachNodeCache(db);
  const fx = await buildLinkFixture(db, c, { tag: newTag('STT'), parts: 0 });
  const { lineId, order } = fx;
  let r = await fx.rows();
  await BC.applyBomChanges(db, c, { scope: { orderLineId: lineId }, changes: [{ op: 'paste', sourceLineId: r.segments[0].node.lineId, parentId: r.girder.id }] });
  r = await fx.rows();
  const [S, S2] = r.segments;
  await OV.writeLineValues(db, c, lineId, { writes: [
    { recordId: S.web.id, specCode: 'DRAWING_MARK', value: 'TW-A' }, { recordId: S2.web.id, specCode: 'DRAWING_MARK', value: 'TW-B' },
    { recordId: S.flange.id, specCode: 'DRAWING_MARK', value: 'TF' }, { recordId: S2.flange.id, specCode: 'DRAWING_MARK', value: 'TF' },
  ] });
  const [[line]] = await db.query('SELECT * FROM cf_sales_order_lines WHERE id = ?', [lineId]);
  const keyOf = async (id) => (await db.query('SELECT link_group FROM cf_item_details WHERE master_id = ?', [id]))[0][0]?.link_group ?? null;
  const rowsOf = async (fileName) => ((await getDrawings(db, COMPANY, order.id, lineId)).drawings.find((d) => d.fileName === fileName)?.rows ?? []).map((x) => x.id).sort();
  const A = file('TW-A_12mm_E250.dxf', rect(3000, 400));
  const B = file('TW-B_12mm_E250.dxf', rect(3000, 380));
  const F = file('TF_16mm_E250.dxf', rect(3000, 300));
  ok('the fixture: two linked webs with marks TW-A / TW-B', (await keyOf(S.web.id)) != null && (await keyOf(S.web.id)) === (await keyOf(S2.web.id)));

  section('1. The trap: a plain upload');
  const plain = await rehearse(() => uploadDrawings(db, c, order.id, lineId, { files: [A, B], dryRun: true }));
  ok('TW-A reaches both webs, TW-B is refused', plain.files[0].fanOut.added.includes(S2.web.id) && plain.files[1].status === 'error' && /already take/.test(plain.files[1].problems.join(' ')), JSON.stringify(plain.files.map((f) => [f.status, f.problems])));

  section('2. Aimed: each twin on its own row');
  const both = await rehearse(async () => {
    const { rows, aim } = await aimSplitTwins(db, c, line, [A, B, F]);
    const up = await uploadDrawings(db, c, order.id, lineId, { files: [A, B, F].map((f) => aimedFile(f, aim)), dryRun: false });
    const off = [await dropTwinLinks(db, c, rows, A.name, aim), await dropTwinLinks(db, c, rows, B.name, aim)];
    return { aim, up, off, a: await rowsOf(A.name), b: await rowsOf(B.name), f: await rowsOf(F.name), kS: await keyOf(S.web.id), kS2: await keyOf(S2.web.id), fk: [await keyOf(S.flange.id), await keyOf(S2.flange.id)] };
  });
  ok('both twins are aimed, the flanges (same mark on both copies) are not', both.aim.has(A.name) && both.aim.has(B.name) && !both.aim.has(F.name) && both.aim.get(A.name).twins.has('TW-B'), JSON.stringify([...both.aim].map(([k, v]) => [k, v.rowId, [...v.twins]])));
  ok('all three files saved, none refused', both.up.saved && both.up.files.every((f) => f.problems.length === 0), JSON.stringify(both.up.files.map((f) => [f.name, f.status, f.problems])));
  ok('TW-A is on its web only, TW-B on its web only', JSON.stringify(both.a) === JSON.stringify([S.web.id]) && JSON.stringify(both.b) === JSON.stringify([S2.web.id]), JSON.stringify([both.a, both.b]));
  ok('…the webs are no longer copies of each other', both.kS !== both.kS2 || both.kS == null);
  ok('…the flanges keep one drawing on both, still linked', both.f.length === 2 && both.fk[0] != null && both.fk[0] === both.fk[1], JSON.stringify([both.f, both.fk]));

  section('3. A twin whose drawing went on both rows first (an earlier plain load)');
  const late = await rehearse(async () => {
    await uploadDrawings(db, c, order.id, lineId, { files: [A], dryRun: false });
    const first = await rowsOf(A.name);
    const { rows, aim } = await aimSplitTwins(db, c, line, [B]);
    await uploadDrawings(db, c, order.id, lineId, { files: [aimedFile(B, aim)], dryRun: false });
    const off = await dropTwinLinks(db, c, rows, B.name, aim);
    return { first, aimed: aim.has(B.name), off, a: await rowsOf(A.name), b: await rowsOf(B.name) };
  });
  ok('the plain TW-A went on both webs', late.first.length === 2);
  ok('TW-B aimed; its web\'s link to TW-A taken off (1)', late.aimed && late.off === 1, JSON.stringify(late));
  ok('…now TW-A is on its web only and TW-B on its own', JSON.stringify(late.a) === JSON.stringify([S.web.id]) && JSON.stringify(late.b) === JSON.stringify([S2.web.id]), JSON.stringify([late.a, late.b]));
} catch (e) {
  state.failed += 1;
  console.error('  ERROR', e.message, e.problems ? JSON.stringify(e.problems) : '', e.stack?.split('\n').slice(1, 4).join(' '));
} finally {
  detachNodeCache(db);
  await db.rollback();
  db.release();
  const after = await tableCounts(pool);
  const changed = after.filter((a) => before.find((b) => b.name === a.name)?.n !== a.n);
  ok('every cf_ table count is back', changed.length === 0, changed.map((x) => x.name).join(', '));
  await pool.end();
  console.log(`\n${state.passed} passed, ${state.failed} failed`);
  if (state.fails.length) console.log(`failed: ${state.fails.join(' | ')}`);
  process.exitCode = state.failed ? 1 : 0;
}
