/**
 * plate_change_test.mjs — plate changes after a purchase order, approved by the MD (init.sql §62, 2026-10-16):
 * services/plateChangeService.js (the gate on every nesting plate write, the request, approval, the buyer
 * checklist). Local only.
 *
 *   cd multi_app_be && node scripts/cf_kepl/plate_change_test.mjs
 *   CF_NEST_COMPANY (2) · CF_PLATE_CHANGE_SHOW=1 prints the impact sheet and the checklist of section 3 / 5
 *
 * ONE TRANSACTION, ROLLED BACK, and every cf_ table is re-counted at the end. It owns its fixture
 * (lib/nestV2Fixture.mjs, as nest_untracked_test) and rolls the line out into cf_order_pieces by hand (what
 * lock does), so the line has a planned need, a requisition and a purchase order.
 *
 *   1. no PO: every write goes straight through, as before; `impact: true` adds the before / after
 *   2. a PO on the line: a save is a request (a reason is needed), nothing is saved
 *   3. the impact sheet: plates added / removed, tonnes, waste with offcuts, cost at the plate rate
 *   4. while it waits the line is held (a preview still works)
 *   5. the requester cannot approve; somebody else can — the nesting is saved exactly as the upload would,
 *      the requisition follows the new need, the buyer checklist says what to do on which PO
 *   6. the checklist ticked → done
 *   7. stale: the buying changes underneath → cannot be approved; withdraw
 *   8. reject (a note is needed) and withdraw; the line is free again
 *   9. the nesting choices ("can't get this plate") as a request with its reason; approved
 *  10. pieces cut from offcuts that change no plate go straight through, even with a PO
 *  11. the lists: the line's gate, and the list across orders
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
if (!/^(localhost|127\.0\.0\.1|::1)$/.test(process.env.DB_HOST ?? 'localhost')) throw new Error('This suite is local only.');
const { attachNodeCache, detachNodeCache } = await imp('apps/cf_erp/lib/db.js');
await imp('apps/cf_erp/services/codegenProvider.js');
const N = await imp('apps/cf_erp/services/nestingService.js');
const U = await imp('apps/cf_erp/services/nestDxfImportService.js');
const RQ = await imp('apps/cf_erp/services/requisitionService.js');
const PC = await imp('apps/cf_erp/services/plateChangeService.js');
const R = await imp('apps/cf_erp/services/nestRunService.js');
const F = await imp('scripts/cf_kepl/lib/nestV2Fixture.mjs');

const COMPANY = Number(process.env.CF_NEST_COMPANY ?? 2);
const EPS = 1e-6;

let passed = 0; let failed = 0; const fails = [];
function ok(name, cond, detail = '') {
  if (typeof name !== 'string' || typeof cond !== 'boolean') throw new Error(`ok(label, condition) takes a string and then a boolean (${String(name).slice(0, 60)})`);
  if (cond) { passed += 1; console.log(`  PASS  ${name}`); } else { failed += 1; fails.push(name); console.log(`  FAIL  ${name}${detail ? ` — ${String(detail).slice(0, 900)}` : ''}`); }
}
const section = (s) => console.log(`\n${s}`);
const J = (v) => JSON.stringify(v);
const near = (a, b, tol = 0.02) => Math.abs(Number(a) - Number(b)) <= tol;
const refusal = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

const [tables] = await pool.query("SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME LIKE 'cf\\_%' ORDER BY TABLE_NAME");
const counts = async () => (await pool.query(tables.map((t) => `SELECT '${t.name}' AS name,COUNT(*) AS n FROM \`${t.name}\``).join(' UNION ALL ')))[0];
const before = await counts();

// Two people of the company: the one who asks, and the MD who approves (neither an admin).
const [people] = await pool.query(
  `SELECT u.id, u.name FROM users u LEFT JOIN roles r ON r.id = u.role_id
    WHERE u.company_id = ? AND u.deleted_at IS NULL AND LOWER(COALESCE(r.name, '')) <> 'admin' ORDER BY u.id LIMIT 2`, [COMPANY]);
if (people.length < 2) throw new Error(`Company ${COMPANY} needs two users that are not admins.`);
const [[adminUser]] = await pool.query(
  `SELECT u.id, u.name FROM users u JOIN roles r ON r.id = u.role_id WHERE u.company_id = ? AND u.deleted_at IS NULL AND LOWER(r.name) = 'admin' ORDER BY u.id LIMIT 1`, [COMPANY]);

const conn = await pool.getConnection();
const asker = { companyId: COMPANY, userId: people[0].id, userName: people[0].name };
const md = { companyId: COMPANY, userId: people[1].id, userName: people[1].name, canApprove: true, isAdmin: false, canTick: false };
const askerAsApprover = { ...asker, canApprove: true, isAdmin: false };
const buyer = { companyId: COMPANY, userId: people[1].id, userName: people[1].name, canTick: true };
const asRequest = (fx, files) => files.map((f) => ({ filename: f.filename, file: f.file, ...(f.style === 'segments' ? { plateCode: fx.plateCode('PS') } : {}) }));
const gate = (fx, kind, body, c = asker) => PC.plateChangeGate(conn, c, fx.lineId, kind, body);
const lotsOf = async (fx) => (await conn.query("SELECT id, plate_item_id FROM cf_plate_lots WHERE company_id = ? AND order_line_id = ? AND deleted_at IS NULL AND kind = 'plate' ORDER BY id", [COMPANY, fx.lineId]))[0];
const plateCount = (lots) => { const m = new Map(); for (const l of lots) m.set(Number(l.plate_item_id), (m.get(Number(l.plate_item_id)) ?? 0) + 1); return m; };
const requestRow = async (id) => (await conn.query('SELECT * FROM cf_plate_change_requests WHERE company_id = ? AND id = ?', [COMPANY, id]))[0][0];

/** What lock does to a custom line: its rows rolled out into cf_order_pieces (root → part rows → cut plates). */
async function rollOut(fx) {
  const [bl] = await conn.query(
    `SELECT b.parent_id, l.id, l.child_id FROM cf_boms b JOIN cf_bom_lines l ON l.bom_id = b.id AND l.deleted_at IS NULL
      WHERE b.company_id = ? AND b.parent_id IN (?) AND b.deleted_at IS NULL`, [COMPANY, [fx.root, ...Object.values(fx.partRow)]]);
  const lineOf = (parent, child) => bl.find((x) => Number(x.parent_id) === Number(parent) && Number(x.child_id) === Number(child))?.id ?? null;
  let sort = 0;
  const piece = async (parentId, itemId, bomLineId, qty, depth) => (await conn.query(
    'INSERT INTO cf_order_pieces (company_id, order_id, order_line_id, parent_id, item_id, bom_line_id, quantity, code, path_key, depth, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [COMPANY, fx.orderId, fx.lineId, parentId, itemId, bomLineId, qty, `${fx.tag}-PCE-${sort}`, `${fx.tag}/${sort}`, depth, sort++],
  ))[0].insertId;
  const root = await piece(null, fx.root, null, 1, 0);
  for (const [sfx, p] of Object.entries(fx.parts)) {
    const row = await piece(root, fx.partRow[sfx], lineOf(fx.root, fx.partRow[sfx]), p.qty, 1);
    await piece(row, fx.cut[sfx], lineOf(fx.partRow[sfx], fx.cut[sfx]), p.qty, 2);
  }
}

try {
  await conn.beginTransaction();
  attachNodeCache(conn);

  section('Fixture');
  const fx = await F.buildFixture(conn, { company: COMPANY, tagPrefix: 'PC' });
  await rollOut(fx);
  const sets = F.nestings(fx);

  /* ───────────── 1. no PO ───────────── */
  section('1. No purchase order: every write goes straight through, as before');
  let st = (await PC.lineStates(conn, COMPANY, [fx.lineId])).get(fx.lineId);
  ok('the line has no PO share: nothing covers it', st.covering.length === 0 && st.shares.length === 0);
  const prevA = await gate(fx, 'upload', { files: asRequest(fx, sets.A) });
  ok('a preview goes through the gate untouched (dryRun is the default)', prevA.dryRun === true && prevA.applied === false && prevA.plateChange === undefined, J([prevA.dryRun, prevA.applied]));
  const savedA = await gate(fx, 'upload', { files: asRequest(fx, sets.A), dryRun: false, impact: true });
  ok(`set A saved straight away (${savedA.saved?.lots} plates), no request`, savedA.applied === true && !savedA.requested, J([savedA.applied, savedA.message]));
  const dImp = savedA.plateChange?.impact;
  ok('…and `impact: true` gave the before / after: nothing → the plates saved, marked direct', savedA.plateChange?.direct === true && dImp?.before.plates === 0 && dImp.after.plates === (await lotsOf(fx)).length && dImp.plates.added.length > 0, J(dImp?.plates?.words));
  ok('…its sentence says plates more and the cost', /plates? more/.test(dImp.sentence) && /₹[\d,]+ more/.test(dImp.sentence), dImp.sentence);
  {
    const tally = { n: 0 };
    const counted = new Proxy(conn, { get: (t, prop) => (prop === 'query' ? (...a) => { tally.n += 1; return t.query(...a); } : Reflect.get(t, prop)) });
    await PC.plateChangeGate(counted, asker, fx.lineId, 'choices', { excludedCutPlateIds: [], excludedPlateIds: [] }, async () => ({ ok: true }));
    ok('the gate costs a line with no PO 2 reads (a request holding it? a PO covering it?) on top of the save', tally.n === 2, String(tally.n));
  }
  const [[{ n: noReq }]] = await conn.query('SELECT COUNT(*) AS n FROM cf_plate_change_requests WHERE company_id = ? AND order_line_id = ?', [COMPANY, fx.lineId]);
  ok('no request was written for a line with no PO', Number(noReq) === 0);
  const lotsA = await lotsOf(fx);

  /* ───────────── 2. a PO ───────────── */
  section('2. A purchase order on the line: a save becomes a request');
  const raised = await RQ.raiseRequisitions(conn, asker, fx.orderId, { lineIds: [fx.lineId] });
  const pr = raised.requisitions.find((r) => r.line.id === fx.lineId);
  const plateLines = pr.lines.filter((l) => Object.values(fx.plates).includes(Number(l.item.id)));
  const needA = plateCount(lotsA);
  ok('the requisition asks for one plate per lot of set A', plateLines.length === needA.size && plateLines.every((l) => near(l.need, needA.get(Number(l.item.id)) ?? -1, EPS)), J(plateLines.map((l) => [l.item.code, l.need])));
  const made = await RQ.makePurchaseOrders(conn, asker, { orders: [{ lines: plateLines.map((l) => ({ prLineId: l.id })) }] });
  const po = made.purchaseOrders[0];
  ok(`a purchase order (${po.code}, ${po.status}) covers every plate`, po.lines.length === plateLines.length, J(po.lines.map((l) => [l.item.code, l.quantity])));
  st = (await PC.lineStates(conn, COMPANY, [fx.lineId])).get(fx.lineId);
  ok('the line is covered now', st.covering.length === plateLines.length);

  const bodyB = { files: asRequest(fx, sets.B), dryRun: false, mode: 'replace' };
  let e = await refusal(() => gate(fx, 'upload', bodyB));
  ok('without a reason: refused PLATE_CHANGE_REASON, naming the PO', e?.code === 'PLATE_CHANGE_REASON' && e.message.includes(po.code) && /MD for approval/.test(e.message), e?.message);
  const prevB = await gate(fx, 'upload', { files: asRequest(fx, sets.B), mode: 'replace' });
  ok('a preview still works with a PO (no reason, no request)', prevB.dryRun === true && prevB.applied === false && !prevB.requested);
  const REASON = 'The customer revised the nesting — 3000 × 1500 plates only.';
  const askB = await gate(fx, 'upload', { ...bodyB, reason: REASON });
  const reqB = askB.plateChange;
  ok(`with a reason: a request (${reqB?.code}), pending, nothing saved`, askB.requested === true && askB.applied === false && reqB?.status === 'pending' && /^PC-\d{6}$/.test(reqB.code), J([askB.message, reqB?.status]));
  ok('…the plates on the line are still set A', J((await lotsOf(fx)).map((l) => l.id)) === J(lotsA.map((l) => l.id)));
  const rowB = await requestRow(reqB.id);
  const [filesB] = await conn.query('SELECT file_no, bytes FROM cf_plate_change_files WHERE company_id = ? AND request_id = ? ORDER BY file_no', [COMPANY, reqB.id]);
  ok(`…its ${sets.B.length} files are kept a row each, raw bytes; the stored body names them`, filesB.length === sets.B.length && filesB.every((f) => f.bytes > 0)
    && JSON.parse(rowB.proposal_json).body.files.every((f, i) => f.fileRef === i && f.file === undefined), J(filesB));
  ok('…the reason, the kind, who asked and the hash are stored', rowB.reason === REASON && rowB.kind === 'upload' && Number(rowB.requested_by) === asker.userId && rowB.base_hash === st.hash);

  /* ───────────── 3. the impact sheet ───────────── */
  section('3. The impact sheet');
  const imp1 = reqB.impact;
  if (process.env.CF_PLATE_CHANGE_SHOW) console.log('IMPACT', JSON.stringify({ sentence: imp1.sentence, plates: imp1.plates.words, before: imp1.before, after: imp1.after, delta: imp1.delta, buying: imp1.buying }, null, 1));
  const lotsAfterB = (await conn.query("SELECT COUNT(*) AS n FROM cf_plate_lots WHERE company_id = ? AND order_line_id = ? AND deleted_at IS NULL", [COMPANY, fx.lineId]))[0][0].n;
  ok('before = set A as saved', imp1.before.plates === lotsA.length && Number(lotsAfterB) === lotsA.length, J([imp1.before.plates, lotsA.length]));
  ok(`after = the ${sets.B.length} plates of set B`, imp1.after.plates === sets.B.length, J(imp1.after));
  const kgOf = (p) => (p.length * p.width / 1e6) * (p.thickness / 1000) * F.DENSITY;
  const listRate = (id) => (id === fx.plates.PB ? 71 : 62);
  const costOf = (plates) => plates.reduce((t, p) => t + p.count * kgOf(p) * listRate(p.plateItemId), 0);
  ok(`cost before = Σ plate kg × the plate rate (list price ₹62 / ₹71 a kg): ₹${Math.round(imp1.before.cost.value)}`, near(imp1.before.cost.value, costOf(imp1.plates.before), 1) && imp1.before.cost.basis === 'list price', J([imp1.before.cost, costOf(imp1.plates.before)]));
  ok(`cost after likewise: ₹${Math.round(imp1.after.cost.value)}; the difference is after − before`, near(imp1.after.cost.value, costOf(imp1.plates.after), 1) && near(imp1.delta.cost, imp1.after.cost.value - imp1.before.cost.value, 0.02), J(imp1.delta));
  ok('tonnes bought = the plates\' kg', near(imp1.before.tonnesBought * 1000, imp1.plates.before.reduce((t, p) => t + p.count * kgOf(p), 0), 1) && near(imp1.after.tonnesBought * 1000, imp1.plates.after.reduce((t, p) => t + p.count * kgOf(p), 0), 1));
  ok('waste counts the offcuts: waste kg = bought − parts, and the % of it', near(imp1.after.wasteKg, (imp1.after.tonnesBought - imp1.after.partsTonnes) * 1000, 1) && near(imp1.after.wastePct, (imp1.after.wasteKg / (imp1.after.tonnesBought * 1000)) * 100, 0.05) && imp1.after.offcutKg <= imp1.after.wasteKg + 0.01, J(imp1.after));
  ok('the parts are the same steel on both sides (the same pieces nested)', near(imp1.before.partsTonnes, imp1.after.partsTonnes, 0.002), J([imp1.before.partsTonnes, imp1.after.partsTonnes]));
  const paGone = imp1.plates.removed.find((p) => p.plateItemId === fx.plates.PA);
  ok('the 6000 × 2000 plate is removed; 3000 × 1500 plates are added or more', !!paGone && paGone.from === 1 && (imp1.plates.added.length + imp1.plates.changed.length) > 0, J(imp1.plates.words));
  ok('the buying part names the PO and what is ordered / received / held', imp1.buying.purchaseOrders[0]?.code === po.code && imp1.buying.text.includes(po.code) && imp1.buying.items.some((x) => x.itemId === fx.plates.PA && x.ordered === 1 && x.needBefore === 1 && x.needAfter === 0), J(imp1.buying));
  ok('the reason and who asked are on the sheet', imp1.reason === REASON && imp1.requestedBy?.id === asker.userId);
  ok('a sentence: plates, steel, cost, waste', imp1.sentence.length > 10 && /plate/.test(imp1.sentence), imp1.sentence);

  /* ───────────── 4. held ───────────── */
  section('4. While it waits, the line is held');
  e = await refusal(() => gate(fx, 'choices', { excludedCutPlateIds: [], excludedPlateIds: [fx.plates.PW], reason: 'x' }));
  ok('another write is refused PLATE_CHANGE_PENDING, naming the request and who asked', e?.code === 'PLATE_CHANGE_PENDING' && e.status === 409 && e.message.includes(reqB.code) && e.message.includes(people[0].name), e?.message);
  e = await refusal(() => gate(fx, 'delete_lot', { lotId: lotsA[0].id, reason: 'x' }));
  ok('…and a plate delete too', e?.code === 'PLATE_CHANGE_PENDING');
  ok('a preview is still allowed', (await gate(fx, 'upload', { files: asRequest(fx, sets.C), mode: 'replace' })).dryRun === true);

  /* ───────────── 5. approval ───────────── */
  section('5. Approval');
  e = await refusal(() => PC.approveChange(conn, askerAsApprover, reqB.id, {}));
  ok('the person who asked cannot approve it, even holding the permission', e?.status === 403 && /somebody else/.test(e.message), e?.message);
  e = await refusal(() => PC.approveChange(conn, { ...md, canApprove: false }, reqB.id, {}));
  ok('without the permission: 403', e?.status === 403);
  const view = await PC.getChange(conn, { companyId: COMPANY, userId: asker.userId, canApprove: true }, reqB.id);
  ok('the screen is told why the asker cannot approve', view.canApprove === false && /somebody else/.test(view.whyNotApprove ?? ''), view.whyNotApprove);
  const needBefore = (await RQ.readRequisitions(conn, COMPANY, { lineId: fx.lineId }))[0].lines;
  const done = await PC.approveChange(conn, md, reqB.id, { note: 'Fine — go ahead.' });
  const appr = done.request;
  ok(`approved by somebody else: status ${appr.status}, the note kept`, ['approved', 'applied'].includes(appr.status) && appr.decisionNote === 'Fine — go ahead.' && appr.decidedBy?.id === md.userId, J([appr.status, appr.decisionNote]));
  const lotsB = await lotsOf(fx);
  const countB = plateCount(lotsB);
  ok(`the nesting is saved: ${lotsB.length} plates of set B, none of set A`, lotsB.length === sets.B.length && !lotsB.some((l) => lotsA.some((a) => a.id === l.id)), J(lotsB));
  ok('…exactly the plates the impact sheet said', J([...countB].sort()) === J(imp1.plates.after.map((p) => [p.plateItemId, p.count]).sort()), J([[...countB], imp1.plates.after.map((p) => [p.plateItemId, p.count])]));
  const [placedB] = await conn.query("SELECT COUNT(*) AS n FROM cf_nest_placements p JOIN cf_plate_lots l ON l.id = p.plate_lot_id WHERE l.order_line_id = ? AND l.deleted_at IS NULL AND p.deleted_at IS NULL", [fx.lineId]);
  ok('…with their pieces placed', Number(placedB[0].n) > 0);
  const prAfter = (await RQ.readRequisitions(conn, COMPANY, { lineId: fx.lineId }))[0];
  const raisedNow = new Map(prAfter.lines.map((l) => [Number(l.item.id), l.needRaised]));
  ok('the requisition follows the new need (one plate per lot of set B; the 6000 × 2000 kept at 0, it has a PO share)',
    [...countB].every(([id, n]) => near(raisedNow.get(id), n, EPS)) && near(raisedNow.get(fx.plates.PA), 0, EPS) && !prAfter.stale, J([...raisedNow]));
  const cl = appr.checklist;
  if (process.env.CF_PLATE_CHANGE_SHOW) console.log('CHECKLIST', JSON.stringify(cl.items.map((x) => ({ code: x.code, needBefore: x.needBefore, needAfter: x.needAfter, onOrder: x.onOrder, held: x.held, actions: x.actions.map((q) => q.text), note: x.note })), null, 1));
  const paItem = cl.items.find((x) => x.itemId === fx.plates.PA);
  ok('checklist: the 6000 × 2000 needs 1 → 0 — "Reduce PO-…\'s … line by 1"', paItem?.needBefore === 1 && paItem.needAfter === 0 && paItem.actions.length === 1 && paItem.actions[0].kind === 'reduce' && paItem.actions[0].poCode === po.code && paItem.actions[0].quantity === 1 && /^Reduce PO-\d+'s .+ line by 1/.test(paItem.actions[0].text), J(paItem));
  for (const [id, n] of countB) {
    const it = cl.items.find((x) => x.itemId === id);
    const was = needA.get(id) ?? 0;
    if (n > was) {
      const want = was > 0 ? 'add' : 'order';
      ok(`checklist: ${it?.code} ${was} → ${n} — ${want} ${n - was}`, it?.actions[0]?.kind === want && it.actions[0].quantity === n - was && (want === 'add' ? it.actions[0].text.startsWith(`Add ${n - was}`) && it.actions[0].poCode === po.code : /no open purchase order/.test(it.actions[0].text)), J(it));
    }
  }
  ok('every action starts open; the request waits for the buyer', cl.open === cl.items.reduce((t, x) => t + x.actions.length, 0) && cl.open > 0 && appr.status === 'approved');
  ok('the line is free again', !(await PC.lineChanges(conn, { companyId: COMPANY, userId: asker.userId }, fx.lineId)).gate.held);
  void needBefore;

  /* ───────────── 6. the checklist ───────────── */
  section('6. The buyer ticks the checklist');
  const keys = cl.items.flatMap((x) => x.actions.map((a) => a.key));
  e = await refusal(() => PC.tickChecklist(conn, { ...buyer, canTick: false }, reqB.id, { key: keys[0] }));
  ok('without the buying permission: 403', e?.status === 403);
  let t = await PC.tickChecklist(conn, buyer, reqB.id, { key: keys[0], done: true });
  ok('one ticked: done by whom, still approved', t.checklist.items.flatMap((x) => x.actions).find((a) => a.key === keys[0]).done === true && t.status === 'approved' && t.checklist.open === keys.length - 1);
  for (const k of keys.slice(1)) t = await PC.tickChecklist(conn, buyer, reqB.id, { key: k });
  ok('every action ticked: the request is done (applied)', t.status === 'applied' && t.checklist.open === 0, t.status);
  t = await PC.tickChecklist(conn, buyer, reqB.id, { key: keys[0], done: false });
  ok('unticking one takes it back to approved', t.status === 'approved' && t.checklist.open === 1);
  t = await PC.tickChecklist(conn, buyer, reqB.id, { key: keys[0], done: true });
  ok('the events say requested, approved, ticked …, applied', t.status === 'applied' && t.events[0].action === 'requested' && t.events.some((x) => x.action === 'approved') && t.events.some((x) => x.action === 'applied'), J(t.events.map((x) => x.action)));

  /* ───────────── 7. stale ───────────── */
  section('7. Stale: the buying changes underneath');
  const lotX = lotsB[0];
  const askDel = await gate(fx, 'delete_lot', { lotId: lotX.id, reason: 'This plate is not needed.' });
  ok(`taking a plate off is a request too (${askDel.plateChange?.code}); the plate stays`, askDel.requested === true && (await lotsOf(fx)).some((l) => l.id === lotX.id));
  ok('its impact: one plate fewer', askDel.plateChange.impact.delta.plates === -1, J(askDel.plateChange.impact.delta));
  // The buyer changes the PO share under it (what a quantity cut on the PO would do).
  await conn.query('UPDATE cf_purchase_line_orders SET quantity = quantity + 1 WHERE company_id = ? AND id = ?', [COMPANY, st.covering[0].id]);
  const lc = await PC.lineChanges(conn, { companyId: COMPANY, userId: md.userId, canApprove: true }, fx.lineId);
  const staleView = lc.requests.find((r) => r.id === askDel.plateChange.id);
  ok('read now, it says out of date and cannot be approved', staleView.stale === true && staleView.statusLabel === 'Out of date' && staleView.canApprove === false && /changed after it was asked/.test(staleView.whyNotApprove), J([staleView.statusLabel, staleView.whyNotApprove]));
  const staleTry = await PC.approveChange(conn, md, askDel.plateChange.id, {});
  ok('approving it is refused PLATE_CHANGE_STALE, and the request is marked stale', staleTry.refusal?.code === 'PLATE_CHANGE_STALE' && (await requestRow(askDel.plateChange.id)).status === 'stale', staleTry.refusal?.message);
  ok('…the plate was not taken off', (await lotsOf(fx)).some((l) => l.id === lotX.id));
  e = await refusal(() => gate(fx, 'delete_lot', { lotId: lotX.id, reason: 'again' }));
  ok('a stale request still holds the line until it is withdrawn', e?.code === 'PLATE_CHANGE_PENDING');
  e = await refusal(() => PC.withdrawChange(conn, { companyId: COMPANY, userId: md.userId }, askDel.plateChange.id, {}));
  ok('only the person who asked (or an approver / admin) may withdraw', e?.status === 403);
  const wd = await PC.withdrawChange(conn, asker, askDel.plateChange.id, { note: 'Will ask again.' });
  ok('withdrawn by the person who asked', wd.status === 'withdrawn');

  /* ───────────── 8. reject ───────────── */
  section('8. Reject, withdraw');
  const askRe = await gate(fx, 'delete_lot', { lotId: lotX.id, reason: 'Try one plate fewer.' });
  e = await refusal(() => PC.rejectChange(conn, md, askRe.plateChange.id, {}));
  ok('reject needs a note', e?.code === 'NOTE_REQUIRED');
  const rj = await PC.rejectChange(conn, md, askRe.plateChange.id, { note: 'We need that plate.' });
  ok('rejected with the note; nothing saved; the line is free', rj.status === 'rejected' && rj.decisionNote === 'We need that plate.' && (await lotsOf(fx)).some((l) => l.id === lotX.id)
    && !(await PC.lineChanges(conn, { companyId: COMPANY }, fx.lineId)).gate.held);
  e = await refusal(() => PC.approveChange(conn, md, askRe.plateChange.id, {}));
  ok('a rejected request cannot be approved', e?.code === 'NOT_PENDING');

  /* ───────────── 9. the choices ───────────── */
  section('9. "Can\'t get this plate" — the nesting choices as a request');
  const askCh = await gate(fx, 'choices', { excludedCutPlateIds: [], excludedPlateIds: [fx.plates.PW], reason: 'Supplier has no 16 mm.' });
  ok('a request with its reason; nothing is excluded yet', askCh.requested === true && askCh.plateChange.reason === 'Supplier has no 16 mm.' && (await N.exclusionsOfLine(conn, COMPANY, fx.lineId)).plates.size === 0);
  ok('its impact: the saved plates do not change, and it names the plate', askCh.plateChange.impact.plates.same === true && askCh.plateChange.impact.choice.platesExcluded[0]?.id === fx.plates.PW
    && /saved plates do not change/.test(askCh.plateChange.impact.sentence), askCh.plateChange.impact.sentence);
  const apCh = await PC.approveChange(conn, md, askCh.plateChange.id, {});
  ok('approved: the exclusion is saved; nothing for the buyer to do → done', (await N.exclusionsOfLine(conn, COMPANY, fx.lineId)).plates.has(fx.plates.PW) && apCh.request.status === 'applied' && apCh.request.checklist.open === 0, J([apCh.request.status, apCh.request.checklist.open]));

  /* ───────────── 10. offcuts ───────────── */
  section('10. Pieces cut from offcuts that change no plate go straight through');
  // Take one plate off with the MD's approval, so pieces are left over, then mark them.
  const askOne = await gate(fx, 'delete_lot', { lotId: lotX.id, reason: 'Its parts come from the yard.' });
  const apOne = await PC.approveChange(conn, md, askOne.plateChange.id, {});
  ok(`the plate is off (approved, ${apOne.request.status})`, !(await lotsOf(fx)).some((l) => l.id === lotX.id));
  const left = (await U.getNestFiles(conn, COMPANY, fx.lineId)).leftOver.filter((x) => !x.manual && !x.leftOut);
  if (left.length) {
    const mk = await gate(fx, 'untracked', { pieces: [{ cutPlateId: left[0].cutPlateId, quantity: 1 }] });
    ok('marking a left-over piece changes no plate need: saved directly, no reason asked', mk.applied === true && !mk.requested, J([mk.applied, mk.message]));
    const un = await gate(fx, 'untracked_undo', { cutPlateIds: String(left[0].cutPlateId) });
    ok('…and undoing it too', !un.requested && /Undone/.test(un.message ?? ''), un.message);
  } else ok('(nothing left over to mark)', true);

  /* ───────────── 11. lists ───────────── */
  section('11. The line\'s gate and the list across orders');
  const lc2 = await PC.lineChanges(conn, { companyId: COMPANY, userId: md.userId, canApprove: true, canTick: true }, fx.lineId);
  ok('the gate: covered by the PO, needs approval, not held; the PO named in the sentence', lc2.gate.covered && lc2.gate.needsApproval && !lc2.gate.held && lc2.gate.message.includes(po.code), J(lc2.gate));
  ok('the line lists its requests, newest first', lc2.requests.length === 5 && lc2.requests[0].id > lc2.requests[1].id, J(lc2.requests.map((r) => [r.code, r.status])));
  const pend = await gate(fx, 'nest_plates', { plates: 'standard', reason: 'Standard sizes only from now on.' });
  const all = await PC.listChanges(conn, { companyId: COMPANY, userId: md.userId, canApprove: true }, { status: 'pending' });
  ok('the list of pending requests across orders has it, approvable by the MD', all.requests.some((r) => r.id === pend.plateChange.id && r.canApprove && r.order.code === `${fx.tag}-SO`) && all.counts.pending >= 1, J(all.counts));
  const byAdmin = await PC.approveChange(conn, { companyId: COMPANY, userId: asker.userId, canApprove: true, isAdmin: true }, pend.plateChange.id, {});
  ok('an admin may approve a change they asked for themselves (the §39 rule)', byAdmin.request.status === 'applied');
  void adminUser;

  /* ───────────── 12. the checklist rule ───────────── */
  section('12. The checklist rule (pure)');
  const need = (pairs) => ({ known: true, items: new Map(pairs.map(([id, n]) => [id, { need: n, item: { id, code: `P${id}`, uom: 'nos' } }])) });
  const share = (id, itemId, poCode, quantity, received, status = 'ordered') => ({ id, prLineId: 900 + itemId, itemId, itemCode: `P${itemId}`, quantity, received, purchaseLineId: 500 + id, po: { id, code: poCode, status } });
  const stateOf = (shares, holds = []) => ({ covering: shares, holds });
  let k = PC.checklistOf(stateOf([share(1, 7, 'PO-000101', 2, 0)]), need([[7, 2]]), need([[7, 5]]), new Set([7]));
  ok('more needed, a PO line still open: "Add 3 nos to PO-000101 (P7)."', k.items[0].actions[0]?.text === 'Add 3 nos to PO-000101 (P7).' && k.items[0].actions[0].purchaseLineId === 501 && k.open === 1, J(k.items[0]));
  k = PC.checklistOf(stateOf([share(1, 7, 'PO-000101', 2, 2, 'received')], [{ id: 1, prLineId: 907, itemId: 7, quantity: 2 }]), need([[7, 2]]), need([[7, 3]]), new Set([7]));
  ok('more needed, the PO is received: "Order 1 nos P7 — no open purchase order …"', k.items[0].actions[0]?.kind === 'order' && k.items[0].actions[0].quantity === 1, J(k.items[0].actions));
  k = PC.checklistOf(stateOf([share(1, 7, 'PO-000101', 3, 1, 'partially_received'), share(2, 7, 'PO-000102', 2, 0)], [{ id: 1, prLineId: 907, itemId: 7, quantity: 1 }]), need([[7, 6]]), need([[7, 0]]), new Set([7]));
  const kinds = k.items[0].actions.map((a) => [a.kind, a.poCode ?? null, a.quantity]);
  ok('none needed now: reduce what is still coming, newest PO first (2 on PO-000102, 2 on PO-000101), then keep 1 received plate for stock',
    J(kinds) === J([['reduce', 'PO-000102', 2], ['reduce', 'PO-000101', 2], ['keep', null, 1]]) && /Release excess/.test(k.items[0].actions[2].text), J(kinds));
  k = PC.checklistOf(stateOf([share(1, 7, 'PO-000101', 1, 0)]), need([[7, 3]]), need([[7, 2]]), new Set([7]));
  ok('fewer needed but still more than is coming: nothing to take back, said', k.items[0].actions.length === 0 && /Nothing to take back/.test(k.items[0].note) && k.open === 0, J(k.items[0]));
  k = PC.checklistOf(stateOf([]), need([[7, 0]]), need([[7, 1]]), new Set([7]));
  ok('a plate the line did not need before, on no PO: "Order 1 …"', k.items[0].actions[0]?.kind === 'order' && k.items[0].needBefore === 0, J(k.items[0]));
} catch (err) {
  failed += 1;
  fails.push(`ERROR ${err?.message}`);
  console.error('\nERROR', err);
} finally {
  await R.settleRuns().catch(() => {});
  try { await conn.rollback(); } catch { /* the original error is the one that matters */ }
  detachNodeCache(conn);
  conn.release();
}

section('Nothing survived the rollback');
const after = await counts();
const changed = after.filter((a) => Number(a.n) !== Number(before.find((b) => b.name === a.name)?.n));
ok('every cf_ table is back to the count it started at', changed.length === 0, changed.map((d) => `${d.name} ${before.find((b) => b.name === d.name)?.n}->${d.n}`).join(', '));
console.log(`\n${passed} passed, ${failed} failed${fails.length ? `\n  failed: ${fails.join('\n          ')}` : ''}`);
await pool.end();
process.exit(failed ? 1 : 0);
