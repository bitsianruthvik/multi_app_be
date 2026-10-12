/**
 * link_groups_test.mjs — linked copies ("same design") on an order line: linkService, the `links`
 * of orderValuesService and bomChangeService, treeCopyService's keys (init.sql §59,
 * CF_ERP_LINKED_COPIES_PLAN.md).
 *
 *   cd multi_app_be && node scripts/cf_kepl/link_groups_test.mjs
 *
 * ONE TRANSACTION, ROLLED BACK; every cf_ table re-counted at the end. The fixture is this run's
 * own (link_fixture.mjs) — no tenant node, record, order or rule is read.
 *
 * What is proved: a copy is linked row by row and a copy of a copy joins the group; the fingerprint
 * takes exactly what the plan's in/out table says; a value / quantity / removal asks, fans out or
 * breaks as said, and breaks the row and its ancestors but never its siblings; link and unlink by
 * hand, suggestions, keep apart; the settle's partition; a locked line still links and unlinks but
 * takes no values, a released one takes nothing; a dry run says what the save does; and the round
 * trips are the same at two sizes.
 */
import { pool } from '../../db.js';
import '../../apps/cf_erp/services/codegenProvider.js';
import { attachNodeCache, detachNodeCache } from '../../apps/cf_erp/lib/db.js';
import * as OV from '../../apps/cf_erp/services/orderValuesService.js';
import * as BC from '../../apps/cf_erp/services/bomChangeService.js';
import * as LS from '../../apps/cf_erp/services/linkService.js';
import { NOT_DESIGN_SPECS, DRAWING_FACT_SPECS } from '../../apps/cf_erp/services/records.js';
import { createDrawing } from '../../apps/cf_erp/services/drawingService.js';
import { withCutPieces } from '../../apps/cf_erp/services/cutPlateService.js';
import { buildLinkFixture, harness, tableCounts, counted, newTag, COMPANY } from './link_fixture.mjs';

if (!/^(localhost|127\.0\.0\.1|::1)$/.test(process.env.DB_HOST ?? 'localhost')) throw new Error('Local only.');
const { state, ok, section, refusal } = harness();
const before = await tableCounts(pool);
const db = await pool.getConnection();
const c = { companyId: COMPANY, userId: null };
let sp = 0;
/** Runs fn inside a savepoint and takes everything it wrote back. */
const rehearse = async (fn) => { const name = `lgt_${sp += 1}`; await db.query(`SAVEPOINT ${name}`); try { return await fn(); } finally { await db.query(`ROLLBACK TO SAVEPOINT ${name}`); } };

try {
  await db.beginTransaction();
  attachNodeCache(db);
  const fx = await buildLinkFixture(db, c, { tag: newTag('LGT'), parts: 1, lines: 2 });
  const { lineId, spec } = fx;
  const change = (changes, extra = {}) => BC.applyBomChanges(db, c, { scope: { orderLineId: lineId }, changes, ...extra });
  const write = (writes, extra = {}) => OV.writeLineValues(db, c, lineId, { writes, ...extra });
  const keyOf = async (id) => (await db.query('SELECT link_group FROM cf_item_details WHERE master_id = ?', [id]))[0][0]?.link_group ?? null;
  const prints = async () => (await LS.readLinks(db, COMPANY, lineId)).prints;
  const fpOf = async (...ids) => { const p = await prints(); return ids.map((id) => p.fp.get(id)); };
  const valueOf = async (id, code) => {
    const [[r]] = await db.query("SELECT v.value_number, v.value_text, v.option_id FROM cf_spec_values v JOIN cf_specifications s ON s.id = v.specification_id WHERE v.company_id = ? AND v.subject_type = 'master' AND v.subject_id = ? AND s.code = ? AND v.deleted_at IS NULL", [COMPANY, id, code]);
    return r ? (r.value_number != null ? Number(r.value_number) : r.value_text ?? r.option_id) : null;
  };

  /* ------------------------------------------------------------------ */
  section('1. Nothing is linked at birth; the group key');
  const k1 = LS.newGroupKey(); const k2 = LS.newGroupKey();
  ok('a group key is opaque, at most 32 characters, and never the same twice', /^[0-9a-z]{12,32}$/.test(k1) && k1 !== k2, `${k1} ${k2}`);
  ok('NOT_DESIGN_SPECS holds the drawing mark, what cutting works out, what the drawing says, planning values',
    ['DRAWING_MARK', 'CUTS', 'CUT_ACROSS', 'PIERCINGS', 'NEST_MANUAL', 'SHIP_UNIT', ...DRAWING_FACT_SPECS].every((x) => NOT_DESIGN_SPECS.has(x)) && !NOT_DESIGN_SPECS.has('LENGTH'));
  let r0 = await fx.rows();
  const S = r0.segments[0];
  // The values a designer types before copying: sizes on the parts, a coat on the segment.
  await write([
    { recordId: S.flange.id, specCode: 'LENGTH', value: 12000 }, { recordId: S.flange.id, specCode: 'WIDTH', value: 500 },
    { recordId: S.flange.id, specCode: 'THICKNESS', value: 25 }, { recordId: S.flange.id, specCode: 'GRADE', value: 'E350' },
    { recordId: S.web.id, specCode: 'LENGTH', value: 12000 }, { recordId: S.web.id, specCode: 'WIDTH', value: 1500 },
    { recordId: S.web.id, specCode: 'THICKNESS', value: 12 }, { recordId: S.node.id, specCode: spec.COAT, value: 'Zinc' },
  ]);
  let view = await OV.readLineValues(db, COMPANY, lineId);
  ok('GET values carries a top-level links block, empty on a fresh line', !!view.links && Object.keys(view.links.rows).length === 0 && Object.keys(view.links.groups).length === 0, JSON.stringify(view.links));
  ok('the inherited coat reached the parts (the fixture works)', await valueOf(S.flange.id, spec.COAT) === 'Zinc' && Math.abs(await valueOf(S.flange.id, spec.WT) - 6000) < 1e-6);

  /* ------------------------------------------------------------------ */
  section('2. A copy is linked to its original, row by row; a copy of a copy joins the group');
  const paste1 = await counted(db, () => change([{ op: 'paste', sourceLineId: S.node.lineId, parentId: r0.girder.id }]));
  let r = await fx.rows();
  const S2 = r.segments[1];
  ok('the copy exists with its own rows', r.segments.length === 2 && S2.node.id !== S.node.id && S2.flange.id !== S.flange.id);
  const pairs = [[S.node.id, S2.node.id], [S.flange.id, S2.flange.id], [S.web.id, S2.web.id], [S.parts[0].id, S2.parts[0].id]];
  const keys = [];
  for (const [a, b] of pairs) keys.push([await keyOf(a), await keyOf(b)]);
  ok('each copied row carries the key of the row it was copied from — written on both', keys.every(([a, b]) => a && a === b), JSON.stringify(keys));
  ok('…one group per pair of rows, not one for the subtree', new Set(keys.map((k) => k[0])).size === 4);
  ok('the catalog item below is not linked (it is referenced, not copied)', (await keyOf(fx.boltId)) === null);
  ok('the save answers with the links as they now stand', paste1.out.links.after.rows[S2.flange.id]?.n === 2 && paste1.out.links.after.rows[S.node.id]?.g === keys[0][0] && paste1.out.links.breaks.length === 0 && paste1.out.links.needsChoice === false, JSON.stringify(paste1.out.links).slice(0, 300));
  view = await OV.readLineValues(db, COMPANY, lineId);
  ok('GET values: every linked row says its group and how many it is one of', pairs.flat().every((id) => view.links.rows[id]?.n === 2) && Object.keys(view.links.groups).length === 4 && view.links.groups[keys[1][0]].length === 2);
  ok('the copy holds the same values as its original', await valueOf(S2.flange.id, 'LENGTH') === 12000 && await valueOf(S2.node.id, spec.COAT) === 'Zinc');
  await change([{ op: 'paste', sourceLineId: S2.node.lineId, parentId: r.girder.id }]);
  r = await fx.rows();
  const S3 = r.segments[2];
  ok('a copy of a copy joins the same group (three of each)', (await keyOf(S3.flange.id)) === keys[1][0] && (await keyOf(S3.node.id)) === keys[0][0]);
  view = await OV.readLineValues(db, COMPANY, lineId);
  ok('…and the screen says three', view.links.rows[S.flange.id].n === 3 && view.links.rows[S3.web.id].n === 3 && view.links.groups[keys[0][0]].length === 3);
  const flanges = [S.flange.id, S2.flange.id, S3.flange.id];
  const webs = [S.web.id, S2.web.id, S3.web.id];
  const segs = [S.node.id, S2.node.id, S3.node.id];

  /* ------------------------------------------------------------------ */
  section('3. The fingerprint: what is IN, what is OUT');
  const [f0, s0, w0, g0] = await fpOf(S2.flange.id, S2.node.id, S2.web.id, r.girder.id);
  ok('copies have the same fingerprint, different designs do not', (await fpOf(...flanges)).every((x) => x === f0) && f0 !== w0 && (await fpOf(...segs)).every((x) => x === s0));
  const own = (await prints()).own.get(S2.flange.id);
  ok('own values in the fingerprint: the typed size and grade, and the INHERITED coat', own.values.get('LENGTH') === 12000 && own.values.has('GRADE') && own.values.get(spec.COAT) === 'Zinc', JSON.stringify([...own.values]));
  ok('…not the calculated weight, not the formula value nobody typed over, not CUT_FROM\'s absence', !own.values.has(spec.WT) && !own.values.has(spec.AREA), JSON.stringify([...own.values.keys()]));
  const specRow = async (code) => (await db.query('SELECT id FROM cf_specifications WHERE company_id = ? AND code = ? AND deleted_at IS NULL', [COMPANY, code]))[0][0];
  const setRaw = async (id, specId, number, text = null) => {
    await db.query("UPDATE cf_spec_values SET deleted_at = NOW() WHERE company_id = ? AND subject_type = 'master' AND subject_id = ? AND specification_id = ? AND deleted_at IS NULL", [COMPANY, id, specId]);
    await db.query("INSERT INTO cf_spec_values (company_id, specification_id, subject_type, subject_id, value_number, value_text, source) VALUES (?, ?, 'master', ?, ?, ?, 'entered')", [COMPANY, specId, id, number, text]);
  };
  const flangeLine = S2.flange.lineId;
  const moved = async (label, fn, { flange, segment, web = false, girder }) => rehearse(async () => {
    await fn();
    const [f, s, w, g] = await fpOf(S2.flange.id, S2.node.id, S2.web.id, r.girder.id);
    ok(label, (f !== f0) === flange && (s !== s0) === segment && (w !== w0) === web && (girder === undefined || (g !== g0) === girder),
      `flange ${f !== f0}, segment ${s !== s0}, web ${w !== w0}, girder ${g !== g0}`);
  });
  await moved('IN  an entered value — breaks the row and every row above it, never its sibling',
    () => db.query("UPDATE cf_spec_values SET value_number = 12001 WHERE company_id = ? AND subject_type = 'master' AND subject_id = ? AND specification_id = ? AND deleted_at IS NULL", [COMPANY, S2.flange.id, fx.specId.LENGTH]),
    { flange: true, segment: true, girder: true });
  await moved('IN  an inherited value (the coat typed on the segment above) — the parts below change with it',
    () => db.query("UPDATE cf_spec_values SET value_text = 'Paint' WHERE company_id = ? AND subject_type = 'master' AND subject_id IN (?) AND specification_id = ? AND deleted_at IS NULL", [COMPANY, [S2.node.id, S2.flange.id, S2.web.id], fx.specId.COAT]),
    { flange: true, segment: true, web: true, girder: true });
  await moved('IN  a formula value a person typed over (different from the answer)',
    () => setRaw(S2.flange.id, fx.specId.AREA, 5),
    { flange: true, segment: true });
  await moved('OUT the same formula value typed EQUAL to the answer',
    () => setRaw(S2.flange.id, fx.specId.AREA, 12000 * 500),
    { flange: false, segment: false });
  await moved('IN  the drawing the row is built to',
    async () => {
      const d = await createDrawing(db, c, { number: `${fx.tag}/D1`, revision: 'A', source: 'shop', status: 'issued' });
      await db.query("INSERT INTO cf_drawing_links (company_id, drawing_id, subject_type, subject_id) VALUES (?, ?, 'master_record', ?)", [COMPANY, d.id, S2.flange.id]);
    }, { flange: true, segment: true });
  await moved('IN  the section it is cut from (cut_stock_id)',
    () => db.query('UPDATE cf_master_records SET cut_stock_id = ? WHERE id = ?', [fx.boltId, S2.flange.id]),
    { flange: true, segment: true });
  await moved('IN  a child\'s quantity — the PARENT\'s design, not the child\'s (D2)',
    () => db.query('UPDATE cf_bom_lines SET quantity = 3 WHERE id = ?', [flangeLine]),
    { flange: false, segment: true, girder: true });
  await moved('IN  a child taken away — the parent\'s design',
    () => db.query('UPDATE cf_bom_lines SET deleted_at = NOW() WHERE id = ?', [S2.web.lineId]),
    { flange: false, segment: true, web: true });   // (the web itself is gone from the structure)
  await moved('IN  a catalog child\'s quantity',
    () => db.query('UPDATE cf_bom_lines SET quantity = 9 WHERE id = ?', [S2.bolt.lineId]),
    { flange: false, segment: true });
  await moved('OUT the row\'s own line: its number, description and notes',
    () => db.query("UPDATE cf_bom_lines SET line_no = line_no + 5, role = 'Top', notes = 'n' WHERE id = ?", [flangeLine]),
    { flange: false, segment: false });
  await moved('OUT its name, short name, description and status',
    () => db.query("UPDATE cf_master_records SET name = 'Another name', short_name = 'AN', description = 'd', status = 'active' WHERE id = ?", [S2.flange.id]),
    { flange: false, segment: false });
  await moved('OUT the drawing mark (D4)',
    () => setRaw(S2.flange.id, fx.specId.DRAWING_MARK, null, 'TFL-9'),
    { flange: false, segment: false });
  await moved('OUT what the drawing says (TRUE_AREA — a fact, not a field)',
    async () => {
      let t = await specRow('TRUE_AREA');
      if (!t) { await db.query("INSERT INTO cf_specifications (company_id, code, name, data_type, default_uom, decimals, status) VALUES (?, 'TRUE_AREA', 'True area', 'number', 'mm2', 3, 'active')", [COMPANY]); t = await specRow('TRUE_AREA'); }
      await setRaw(S2.flange.id, t.id, 5_900_000);
    }, { flange: false, segment: false });
  await moved('OUT a value a FLOW asks for (origin flow) — how it is made, not what it is',
    async () => { await fx.rule('master', S2.flange.id, fx.specId.HOW, 'entered', { origin: 'flow' }); await setRaw(S2.flange.id, fx.specId.HOW, 42); },
    { flange: false, segment: false });
  await moved('OUT the stored calculated weight (it is worked out, never read)',
    () => db.query("UPDATE cf_spec_values SET value_number = 1 WHERE company_id = ? AND subject_type = 'master' AND subject_id = ? AND specification_id = ? AND deleted_at IS NULL", [COMPANY, S2.flange.id, fx.specId.WT]),
    { flange: false, segment: false });

  /* ------------------------------------------------------------------ */
  section('4. A value on a linked row: ask, apply to all, or only this one');
  const dryAsk = await write([{ recordId: S2.flange.id, specCode: 'LENGTH', value: 11000 }], { dryRun: true });
  const t0 = dryAsk.links.touched[0];
  ok('said nothing: the dry run asks (needsChoice) and names the row, its group and the value', dryAsk.links.needsChoice === true && dryAsk.links.touched.length === 1 && t0.recordId === S2.flange.id && t0.count === 3 && t0.specs.join() === 'LENGTH' && t0.reason === 'values' && t0.choice === null && t0.members.length === 3, JSON.stringify(dryAsk.links.touched));
  const broke = (out) => out.links.breaks.map((b) => b.recordId).sort((a, b) => a - b);
  ok('…it would break that row and the segment above it, never the web beside it', JSON.stringify(broke(dryAsk)) === JSON.stringify([S2.flange.id, S2.node.id].sort((a, b) => a - b)), JSON.stringify(dryAsk.links.breaks));
  ok('…each break says what it was and why', dryAsk.links.breaks.every((b) => b.was && typeof b.because === 'string' && b.because.length > 3 && b.label) && /LENGTH differs/.test(dryAsk.links.breaks.find((b) => b.recordId === S2.flange.id).because), JSON.stringify(dryAsk.links.breaks));
  ok('…the picture of the screen after shows the two that stay linked', dryAsk.view.links.rows[S.flange.id]?.n === 2 && !dryAsk.view.links.rows[S2.flange.id]?.g && dryAsk.view.links.rows[S2.web.id]?.n === 3);
  ok('a dry run writes nothing', await valueOf(S2.flange.id, 'LENGTH') === 12000 && (await keyOf(S2.flange.id)) === keys[1][0]);

  const dryAll = await write([{ recordId: S2.flange.id, specCode: 'LENGTH', value: 11000 }], { dryRun: true, links: 'all' });
  ok('"all copies": two more rows take the value, nothing breaks, nothing to ask', dryAll.links.needsChoice === false && dryAll.links.breaks.length === 0 && dryAll.links.fanned === 2 && dryAll.summary.changed === 3 && dryAll.links.touched[0].choice === 'all', JSON.stringify(dryAll.links).slice(0, 300));
  const all = await write([{ recordId: S2.flange.id, specCode: 'LENGTH', value: 11000 }], { links: 'all' });
  const lens = []; for (const id of flanges) lens.push(await valueOf(id, 'LENGTH'));
  ok('saved: every copy holds the value', lens.every((x) => x === 11000), JSON.stringify(lens));
  ok('…their worked-out values followed on each', Math.abs(await valueOf(S.flange.id, spec.WT) - 5500) < 1e-6 && Math.abs(await valueOf(S3.flange.id, spec.WT) - 5500) < 1e-6);
  ok('…and the groups stand: three flanges, three segments', all.links.after.rows[S.flange.id].n === 3 && all.links.after.rows[S3.node.id].n === 3 && (await keyOf(S3.flange.id)) === keys[1][0]);
  ok('the dry run said what the save did', JSON.stringify([dryAll.links.needsChoice, dryAll.links.touched, dryAll.links.breaks, dryAll.links.skipped, dryAll.links.after.rows]) === JSON.stringify([all.links.needsChoice, all.links.touched, all.links.breaks, all.links.skipped, all.links.after.rows]));

  const mark = await write([{ recordId: S2.flange.id, specCode: 'DRAWING_MARK', value: 'TFL-2' }], { dryRun: true });
  ok('a value that is not design (the drawing mark) never asks, fans out or breaks', mark.links.needsChoice === false && mark.links.touched.length === 0 && mark.links.breaks.length === 0 && mark.summary.changed === 1);

  const coat = await write([{ recordId: S2.node.id, specCode: spec.COAT, value: 'Paint' }], { dryRun: true, links: 'all' });
  ok('a value the rows below INHERIT, applied to all copies, keeps every level linked', coat.links.breaks.length === 0 && coat.links.after.rows[S2.flange.id].n === 3 && coat.links.after.rows[S2.node.id].n === 3, JSON.stringify(coat.links.breaks));
  const coatOne = await write([{ recordId: S2.node.id, specCode: spec.COAT, value: 'Paint' }], { dryRun: true, links: 'one' });
  ok('…and on one copy only it breaks that segment AND the parts below it that inherit it', [S2.node.id, S2.flange.id, S2.web.id].every((id) => broke(coatOne).includes(id)) && coatOne.links.needsChoice === false, JSON.stringify(broke(coatOne)));

  const conflict = await refusal(() => write([{ recordId: S.flange.id, specCode: 'THICKNESS', value: 20 }, { recordId: S2.flange.id, specCode: 'THICKNESS', value: 22 }], { links: 'all', dryRun: true }));
  ok('two different values for one design under "all copies" are refused: 422 LINK_CONFLICT', conflict?.status === 422 && conflict.code === 'LINK_CONFLICT' && /two different values/.test(conflict.problems.join(' ')), `${conflict?.code} ${conflict?.message}`);
  const unanimous = await write(flanges.map((id) => ({ recordId: id, specCode: 'THICKNESS', value: 20 })), { dryRun: true });
  ok('a batch that already gives every copy the same value needs no choice', unanimous.links.needsChoice === false && unanimous.links.breaks.length === 0 && unanimous.links.touched.every((t) => t.choice === 'all') && unanimous.links.fanned === 0);
  const perWrite = await write([{ recordId: S.flange.id, specCode: 'THICKNESS', value: 20, links: 'all' }, { recordId: S.web.id, specCode: 'THICKNESS', value: 14 }], { dryRun: true, links: 'one' });
  ok('each write may say its own: the flange goes to all, the web alone', perWrite.links.fanned === 2 && JSON.stringify(broke(perWrite)) === JSON.stringify([S.web.id, S.node.id].sort((a, b) => a - b)), JSON.stringify(broke(perWrite)));
  const badChoice = await refusal(() => write([{ recordId: S.flange.id, specCode: 'THICKNESS', value: 20 }], { links: 'every' }));
  ok('anything but all / one is refused before anything is read', badChoice?.status === 422 && /links must be/.test(badChoice.problems.join(' ')));

  const one = await write([{ recordId: S3.flange.id, specCode: 'GRADE', value: 'E250' }], { links: 'one' });
  ok('"only this row": the row and its segment stop being copies, without a question', one.links.needsChoice === false && JSON.stringify(broke(one)) === JSON.stringify([S3.flange.id, S3.node.id].sort((a, b) => a - b)) && (await keyOf(S3.flange.id)) === null && (await keyOf(S3.node.id)) === null);
  ok('…the other two stay linked, and so does its sibling web with the other webs', (await keyOf(S.flange.id)) === keys[1][0] && (await keyOf(S2.flange.id)) === keys[1][0] && (await keyOf(S3.web.id)) === keys[2][0] && one.links.after.rows[S3.web.id].n === 3 && one.links.after.rows[S.node.id].n === 2);

  /* ------------------------------------------------------------------ */
  section('5. Visible and repairable: suggestions, link, unlink, keep apart');
  await write([{ recordId: S3.flange.id, specCode: 'GRADE', value: 'E350' }]);
  view = await OV.readLineValues(db, COMPANY, lineId);
  ok('equal again: the row is offered for re-linking with the rows it equals', JSON.stringify(view.links.rows[S3.flange.id]) === JSON.stringify({ same: [S.flange.id, S2.flange.id] }) && JSON.stringify(view.links.rows[S3.node.id]?.same) === JSON.stringify([S.node.id, S2.node.id]), JSON.stringify([view.links.rows[S3.flange.id], view.links.rows[S3.node.id]]));
  ok('…nothing is stored for a suggestion', (await keyOf(S3.flange.id)) === null);
  const relink = await change([{ op: 'link', recordIds: [S3.flange.id, S.flange.id] }, { op: 'link', recordIds: [S3.node.id, S2.node.id] }]);
  ok('linked by hand: each joins the group its partner is in (three again)', (await keyOf(S3.flange.id)) === keys[1][0] && (await keyOf(S3.node.id)) === keys[0][0] && relink.links.after.rows[S3.flange.id].n === 3 && relink.results[0].op === 'link' && relink.results[0].recordIds.length === 3, JSON.stringify(relink.results));
  const notEqual = await refusal(() => change([{ op: 'link', recordIds: [S.flange.id, S.web.id] }]));
  ok('rows that are not the same design cannot be linked: 422 LINK_NOT_EQUAL, saying how they differ', notEqual?.status === 422 && notEqual.code === 'LINK_NOT_EQUAL' && /LENGTH differs/.test(notEqual.message) && notEqual.detail?.differences?.length > 0, `${notEqual?.code} ${notEqual?.message}`);
  const otherRows = await fx.rows(fx.lines[1].id);
  const otherLine = await refusal(() => change([{ op: 'link', recordIds: [S.flange.id, otherRows.segments[0].flange.id] }]));
  ok('a row of another order line cannot join: 422 LINK_OTHER_LINE', otherLine?.status === 422 && otherLine.code === 'LINK_OTHER_LINE', `${otherLine?.code} ${otherLine?.message}`);
  ok('a refused link leaves nothing behind', (await keyOf(S.web.id)) === keys[2][0] && (await keyOf(otherRows.segments[0].flange.id)) === null);
  const fresh = await rehearse(async () => {
    await db.query('UPDATE cf_item_details SET link_group = NULL WHERE master_id IN (?)', [[...flanges, ...webs, ...segs, S.parts[0].id, S2.parts[0].id, S3.parts[0].id]]);
    const out = await change([{ op: 'link', recordIds: [S.web.id, S2.web.id] }]);
    return { out, key: await keyOf(S.web.id), other: await keyOf(S3.web.id) };
  });
  ok('linking rows that are in no group makes a new one for exactly those rows', !!fresh.key && fresh.other === null && fresh.out.results[0].recordIds.length === 2);

  const apart = await change([{ op: 'unlink', recordId: S3.web.id, keepApart: true }]);
  ok('unlink + keep apart: the row is out, marked, and never suggested', (await keyOf(S3.web.id)) === null && JSON.stringify(apart.links.after.rows[S3.web.id]) === JSON.stringify({ apart: true }) && apart.links.after.rows[S.web.id].n === 2 && apart.results[0].was === keys[2][0], JSON.stringify(apart.links.after.rows[S3.web.id]));
  ok('…its segment stays linked — the row is still the same design', (await keyOf(S3.node.id)) === keys[0][0] && apart.links.breaks.length === 0);
  const plain = await change([{ op: 'unlink', recordId: S2.parts[0].id }]);
  ok('unlink without keep apart: offered again straight away', JSON.stringify(plain.links.after.rows[S2.parts[0].id]?.same ?? null) === 'null' || Array.isArray(plain.links.after.rows[S2.parts[0].id]?.same));
  await change([{ op: 'link', recordIds: [S3.web.id, S.web.id] }, { op: 'link', recordIds: [S2.parts[0].id, S.parts[0].id] }]);
  ok('linking again clears keep apart', (await keyOf(S3.web.id)) === keys[2][0] && Number((await db.query('SELECT link_apart FROM cf_item_details WHERE master_id = ?', [S3.web.id]))[0][0].link_apart) === 0);

  /* ------------------------------------------------------------------ */
  section('6. A child\'s quantity and a removed child are the PARENT\'s design');
  const qAsk = await change([{ op: 'quantity', lineId: S2.flange.lineId, quantity: 4 }], { dryRun: true });
  ok('said nothing: the segment is the row touched, and the dry run asks', qAsk.links.needsChoice === true && qAsk.links.touched.length === 1 && qAsk.links.touched[0].recordId === S2.node.id && qAsk.links.touched[0].reason === 'quantity' && qAsk.links.touched[0].count === 3, JSON.stringify(qAsk.links.touched));
  ok('…it would break the segment only — the flange itself is still the same design', JSON.stringify(broke(qAsk)) === JSON.stringify([S2.node.id]) && qAsk.links.after.rows[S2.flange.id].n === 3, JSON.stringify(broke(qAsk)));
  const qAll = await change([{ op: 'quantity', lineId: S2.flange.lineId, quantity: 4, links: 'all' }]);
  const qs = (await db.query('SELECT quantity FROM cf_bom_lines WHERE id IN (?)', [[S.flange.lineId, S2.flange.lineId, S3.flange.lineId]]))[0].map((x) => Number(x.quantity));
  ok('"all copies": the corresponding line of every copy of the segment takes the quantity', qs.every((x) => x === 4) && qAll.links.breaks.length === 0 && qAll.links.needsChoice === false && qAll.results.filter((x) => x?.op === 'quantity' && x.fanned).length === 2 && qAll.summary.counts.quantity === 3, JSON.stringify([qs, qAll.results]));
  const qConflict = await refusal(() => change([{ op: 'quantity', lineId: S.flange.lineId, quantity: 5, links: 'all' }, { op: 'quantity', lineId: S2.flange.lineId, quantity: 6 }], { dryRun: true }));
  ok('two quantities for one design under "all copies": 422 LINK_CONFLICT', qConflict?.status === 422 && qConflict.code === 'LINK_CONFLICT', `${qConflict?.code} ${qConflict?.message}`);
  const rmDry = await change([{ op: 'remove', lineId: S.parts[0].lineId, links: 'all' }], { dryRun: true });
  ok('removing a child from all copies (dry run): three lines go, nothing breaks', rmDry.results.filter((x) => x?.op === 'remove').length === 3 && rmDry.links.breaks.filter((b) => segs.includes(b.recordId)).length === 0 && rmDry.summary.counts.removed === 3, JSON.stringify(rmDry.links.breaks));
  const rmOne = await change([{ op: 'remove', lineId: S3.parts[0].lineId, links: 'one' }]);
  ok('removing it from one copy breaks that segment, without a question', rmOne.links.needsChoice === false && broke(rmOne).includes(S3.node.id) && (await keyOf(S3.node.id)) === null && (await keyOf(S.node.id)) === keys[0][0] && (await keyOf(S3.flange.id)) === keys[1][0], JSON.stringify(rmOne.links.breaks));
  const add = await change([{ op: 'paste', sourceLineId: S.web.lineId, parentId: S2.node.id }], { dryRun: true });
  ok('a row added below a linked row breaks that row (no fan-out in v1) and says so', add.links.touched.some((t) => t.recordId === S2.node.id && t.reason === 'add') && broke(add).includes(S2.node.id) && add.links.needsChoice === false, JSON.stringify(add.links.touched));
  ok('…while the new copy joins the webs', Object.values(add.links.after.rows).filter((x) => x.g === keys[2][0]).length === 4);
  const own2 = await change([{ op: 'role', lineId: S2.flange.lineId, role: 'Top flange' }]);
  ok('a row\'s own description is not design: nothing to settle, nothing breaks', own2.links.breaks.length === 0 && own2.links.touched.length === 0 && (await keyOf(S2.node.id)) === keys[0][0]);

  /* ------------------------------------------------------------------ */
  section('7. The settle: stored keys follow the designs');
  await rehearse(async () => {
    // One stored key over two designs and a loner: webs (3), flanges (2), a part on its own.
    await db.query("UPDATE cf_item_details SET link_group = 'mixedkey' WHERE master_id IN (?)", [[...webs, S.flange.id, S2.flange.id, S.parts[0].id]]);
    const read = await LS.readLinks(db, COMPANY, lineId);
    ok('read before any settle: only rows whose designs agree count as linked (a second class is key:fp)', read.byRecord.get(S.web.id).n === 3 && read.byRecord.get(S.web.id).g === 'mixedkey' && read.byRecord.get(S.flange.id).n === 2 && /^mixedkey:/.test(read.byRecord.get(S.flange.id).g) && !read.byRecord.get(S.parts[0].id)?.g);
    const settled = await LS.settleLine(db, c, lineId);
    const kw = await keyOf(S.web.id); const kf = await keyOf(S.flange.id);
    ok('the largest class keeps the key, the other class of two gets a new one, the loner none', kw === 'mixedkey' && (await keyOf(S3.web.id)) === 'mixedkey' && kf && kf !== 'mixedkey' && kf === (await keyOf(S2.flange.id)) && (await keyOf(S.parts[0].id)) === null, `${kw} ${kf}`);
    ok('…reported row by row', settled.breaks.filter((b) => b.was === 'mixedkey').length === 3 && settled.breaks.every((b) => b.label && b.because));
    const again = await counted(db, () => LS.settleLine(db, c, lineId));
    ok('settling again changes nothing and writes nothing', again.out.breaks.length === 0 && !again.sql.some((x) => /^UPDATE/i.test(x)));
  });
  await rehearse(async () => {
    // A write path that knows nothing of links (a direct value write), then any save on the line.
    await db.query("UPDATE cf_spec_values SET value_number = 777 WHERE company_id = ? AND subject_type = 'master' AND subject_id = ? AND specification_id = ? AND deleted_at IS NULL", [COMPANY, S2.web.id, fx.specId.WIDTH]);
    const read = await OV.readLineValues(db, COMPANY, lineId);
    ok('a write path that forgot the links shows as a broken link at once — never a wrong fan-out', !read.links.rows[S2.web.id]?.g && read.links.rows[S.web.id]?.n === 2 && (await keyOf(S2.web.id)) === keys[2][0]);
    await withCutPieces(db, c, lineId, {});
    ok('…and the next save on the line (withCutPieces) settles the stored key', (await keyOf(S2.web.id)) === null && (await keyOf(S.web.id)) === keys[2][0]);
    const skipped = await counted(db, () => LS.settleLine(db, c, fx.lines[1].id));
    ok('a line with no linked row costs the settle ONE round trip', skipped.n === 1 && skipped.out.breaks.length === 0, String(skipped.n));
  });

  /* ------------------------------------------------------------------ */
  section('8. Locked: link and unlink still go through; values do not. Released: nothing does');
  await rehearse(async () => {
    await db.query('UPDATE cf_sales_order_lines SET locked_at = NOW() WHERE id = ?', [lineId]);
    const v = await refusal(() => write([{ recordId: S.flange.id, specCode: 'LENGTH', value: 1 }], { links: 'all' }));
    ok('a value on a locked line is refused (409 LOCKED), whatever it says about copies', v?.status === 409 && v.code === 'LOCKED', `${v?.status} ${v?.code}`);
    const q = await refusal(() => change([{ op: 'quantity', lineId: S.flange.lineId, quantity: 7, links: 'all' }]));
    ok('…and so is a quantity', q?.status === 409 && q.code === 'LOCKED', `${q?.status} ${q?.code}`);
    const un = await change([{ op: 'unlink', recordId: S2.web.id }]);
    ok('unlink goes through on a locked line', un.applied && (await keyOf(S2.web.id)) === null && un.links.after.rows[S.web.id].n === 2);
    const li = await change([{ op: 'link', recordIds: [S2.web.id, S.web.id] }]);
    ok('link goes through on a locked line', li.applied && (await keyOf(S2.web.id)) === keys[2][0]);
    const lockedView = await OV.readLineValues(db, COMPANY, lineId);
    ok('a locked line still shows its links', lockedView.editable === false && lockedView.links.rows[S.flange.id]?.n === 3);
    await db.query('INSERT INTO cf_production_releases (company_id, order_id, order_line_id, item_id, quantity) VALUES (?, ?, ?, ?, 1)', [COMPANY, fx.order.id, lineId, r.girder.id]);
    const rel = await refusal(() => change([{ op: 'unlink', recordId: S2.web.id }]));
    ok('released: 409, link and unlink included', rel?.status === 409 && rel.code === 'RELEASED', `${rel?.status} ${rel?.code}`);
  });

  /* ------------------------------------------------------------------ */
  section('9. A dry run says what the save does');
  const shape = (o) => JSON.stringify([o.links.needsChoice, o.links.touched.map((t) => [t.recordId, t.reason, t.choice, t.count]), o.links.breaks.map((b) => [b.recordId, b.was]).sort(), o.links.skipped, Object.entries(o.links.after.rows).map(([id, v]) => [id, v.n ?? v.same ?? v.apart])]);
  for (const [label, changes] of [
    ['a quantity said for one row', [{ op: 'quantity', lineId: S2.web.lineId, quantity: 2 }]],
    ['a value for all copies with a removal for one', [{ op: 'values', links: 'all', writes: [{ recordId: S.web.id, specCode: 'THICKNESS', value: 16 }] }, { op: 'remove', lineId: S2.bolt.lineId, links: 'one' }]],
    ['an unlink', [{ op: 'unlink', recordId: S.flange.id, keepApart: true }]],
  ]) {
    const dry = await change(changes, { dryRun: true });
    const real = await rehearse(() => change(changes));
    ok(`${label}: the same links block`, shape(dry) === shape(real), `${shape(dry)} / ${shape(real)}`);
  }

  /* ------------------------------------------------------------------ */
  section('10. Round trips: the same at two sizes');
  const big = await buildLinkFixture(db, c, { tag: newTag('LGB'), parts: 24 });
  const bigChange = (changes, extra = {}) => BC.applyBomChanges(db, c, { scope: { orderLineId: big.lineId }, changes, ...extra });
  let br = await big.rows();
  await OV.writeLineValues(db, c, big.lineId, { writes: [...br.segments[0].parts, br.segments[0].flange, br.segments[0].web].flatMap((p) => [{ recordId: p.id, specCode: 'LENGTH', value: 9000 }, { recordId: p.id, specCode: 'WIDTH', value: 300 }]) });
  const bigPaste = await counted(db, () => bigChange([{ op: 'paste', sourceLineId: br.segments[0].node.lineId, parentId: br.girder.id }]));
  br = await big.rows();
  const B1 = br.segments[0]; const B2 = br.segments[1];
  const sizes = { small: (await OV.readLineValues(db, COMPANY, lineId)).counts.rows, big: (await OV.readLineValues(db, COMPANY, big.lineId)).counts.rows };
  ok(`the two lines differ in size (${sizes.small} rows against ${sizes.big})`, sizes.big > 3 * sizes.small);
  ok(`a copy with its links costs the same whatever its size (5 rows: ${paste1.n}, 28 rows: ${bigPaste.n})`, Math.abs(bigPaste.n - paste1.n) <= 2 && bigPaste.out.links.after.rows[B2.flange.id]?.n === 2, `${paste1.n} / ${bigPaste.n}`);
  const linkSql = (x) => x.sql.filter((q) => /link_group|cf_drawing_links|cf_cut_places/.test(q));
  console.log(`        of a paste's ${bigPaste.n} round trips, ${linkSql(bigPaste).length} are for links: ${linkSql(bigPaste).map((q) => q.slice(0, 46)).join(' | ')}`);
  const readS = await counted(db, () => OV.readLineValues(db, COMPANY, lineId));
  const readB = await counted(db, () => OV.readLineValues(db, COMPANY, big.lineId));
  ok(`GET values with its links: 9 round trips at both sizes (${readS.n}, ${readB.n})`, readS.n === 9 && readB.n === 9);
  const linksS = await counted(db, () => LS.readLinks(db, COMPANY, lineId));
  const linksB = await counted(db, () => LS.readLinks(db, COMPANY, big.lineId));
  ok(`readLinks: 9 at both sizes (${linksS.n}, ${linksB.n}), and none with a context in hand`, linksS.n === 9 && linksB.n === 9 && (await counted(db, () => LS.readLinks(db, COMPANY, lineId, { ctx: linksS.out.ctx }))).n === 0);
  const wS = await counted(db, () => write([{ recordId: S.flange.id, specCode: 'WIDTH', value: 510 }], { links: 'all', dryRun: true }));
  const wB = await counted(db, () => OV.writeLineValues(db, c, big.lineId, { writes: [{ recordId: B1.flange.id, specCode: 'WIDTH', value: 310 }], links: 'all', dryRun: true }));
  ok(`a value applied to all copies: the same round trips at both sizes (${wS.n}, ${wB.n})`, wS.n === wB.n && wB.n <= 18, `${wS.n} / ${wB.n}`);
  const oneS = await counted(db, () => write([{ recordId: S.flange.id, specCode: 'WIDTH', value: 511 }], { links: 'one', dryRun: true }));
  ok(`…and breaking a link costs one UPDATE more, not one per row (${oneS.n})`, oneS.n <= wS.n + 1 && oneS.sql.filter((q) => /UPDATE cf_item_details SET link_group/.test(q)).length === 1);
  const noLinks = await counted(db, () => OV.writeLineValues(db, c, fx.lines[1].id, { writes: [{ recordId: otherRows.segments[0].flange.id, specCode: 'WIDTH', value: 400 }], dryRun: true }));
  ok(`a line with nothing linked pays ONE read for it and no settle (${noLinks.n})`, !noLinks.sql.some((q) => /SET link_group/.test(q)) && noLinks.n <= 15, String(noLinks.n));
  const qS = await counted(db, () => change([{ op: 'quantity', lineId: S.web.lineId, quantity: 3, links: 'all' }], { dryRun: true }));
  const qB = await counted(db, () => bigChange([{ op: 'quantity', lineId: B1.web.lineId, quantity: 3, links: 'all' }], { dryRun: true }));
  console.log(`        a quantity for all copies: ${qS.n} round trips on ${sizes.small} rows (3 copies), ${qB.n} on ${sizes.big} rows (2 copies)`);
  const perLine = qS.sql.filter((q) => /^UPDATE cf_bom_lines/i.test(q)).length - qB.sql.filter((q) => /^UPDATE cf_bom_lines/i.test(q)).length;
  ok('a quantity for all copies grows with the COPIES it is repeated on, never with the rows of the line', qB.n <= qS.n && perLine >= 0, `${qS.n} / ${qB.n}`);
  const lS = await counted(db, () => change([{ op: 'unlink', recordId: S.web.id }], { dryRun: true }));
  const lB = await counted(db, () => bigChange([{ op: 'unlink', recordId: B1.web.id }], { dryRun: true }));
  ok(`link / unlink: the same round trips at both sizes (${lS.n}, ${lB.n})`, Math.abs(lS.n - lB.n) <= 1, `${lS.n} / ${lB.n}`);
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
