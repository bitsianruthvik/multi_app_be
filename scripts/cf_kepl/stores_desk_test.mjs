/**
 * stores_desk_test.mjs — the Stores desk (init.sql §111, services/storesDeskService.js).
 *
 *   cd multi_app_be && node scripts/cf_kepl/stores_desk_test.mjs        CF_COMPANY=2 (the default)
 *
 * One transaction on an existing catalog item of the company, ROLLED BACK at the end: nothing is kept.
 *   1. the ledger: a receipt shows as In, the balance follows, the opening does not move
 *   2. give out: exactly one of order / department / vendor; a department issue is "general" for costing
 *   3. out with: a returnable item given to a person is expected back; returned (back on the shelf), worn, lost
 *   4. a vendor: sent out is not consumption, and comes back by "returned"
 *   5. count: matched; a small difference posts at once; a large one waits and the book does not move until approved
 *   6. the refusals, in words
 */
import path from 'path';
import { pathToFileURL } from 'url';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
await imp('apps/cf_erp/services/codegenProvider.js');
const D = await imp('apps/cf_erp/services/storesDeskService.js');
const { postMovement } = await imp('apps/cf_erp/services/stockService.js');
const { attachNodeCache, detachNodeCache } = await imp('apps/cf_erp/lib/nodeCache.js');

const COMPANY = Number(process.env.CF_COMPANY ?? 2);
let pass = 0; let fail = 0;
const ok = (name, cond, detail = '') => { if (cond) { pass += 1; console.log(`  ok   ${name}`); } else { fail += 1; console.log(`  FAIL ${name} ${detail}`); } };
const refusal = (p) => p.then(() => null, (e) => e);
const said = (e) => JSON.stringify([e?.message, e?.problems]);

const db = await pool.getConnection();
try {
  await db.beginTransaction(); attachNodeCache(db);
  const [[user]] = await db.query('SELECT id FROM users WHERE company_id = ? ORDER BY id LIMIT 1', [COMPANY]);
  const c = { companyId: COMPANY, userId: user?.id ?? null };
  // 2026-11-22: departments and "collected by" are company settings, off by default — this suite runs with both on.
  { const St_ = await imp('apps/cf_erp/services/settingsService.js'); await St_.saveSettings(db, c, { values: { giveout_departments: true, giveout_person: true } }); St_.clearSettingsCache(); }
  const [[item]] = await db.query(
    `SELECT m.id, m.name FROM cf_master_records m JOIN cf_item_details i ON i.master_id = m.id
      WHERE m.company_id = ? AND m.deleted_at IS NULL AND m.status = 'active' AND i.item_type = 'catalog' AND i.tracked_by = 'quantity'
        AND NOT EXISTS (SELECT 1 FROM cf_stock_balances k WHERE k.item_id = m.id AND k.quantity <> 0)
      ORDER BY m.id DESC LIMIT 1`, [COMPANY]);
  const [[area]] = await db.query("SELECT id, name FROM cf_stocking_areas WHERE company_id = ? AND purpose = 'storage' AND status = 'active' AND deleted_at IS NULL ORDER BY id LIMIT 1", [COMPANY]);
  if (!item || !area) throw new Error('This company needs an active catalog item counted by quantity and a storage area.');
  const row = async (q = {}) => (await D.ledger(db, COMPANY, { search: item.name, paged: 1, limit: 200, ...q })).rows.find((r) => r.item.id === item.id);

  console.log(`1. the ledger (${item.name}, ${area.name})`);
  const before = await row();
  ok('the item is on the ledger with nothing in stock', !!before && before.balance === 0 && before.in === 0);
  await postMovement(db, c, { movementType: 'receipt', lines: [{ itemId: item.id, quantity: 100, toAreaId: area.id, unitCost: 10 }] });
  const r1 = await row();
  ok('a receipt of 100 is In 100, balance 100, opening still 0', r1.in === 100 && r1.out === 0 && r1.balance === 100 && r1.opening === 0, JSON.stringify(r1));
  const later = await row({ from: '2099-01-01', to: '2099-01-31' });
  ok('a later period opens with the 100', later.opening === 100 && later.in === 0 && later.balance === 100, JSON.stringify(later));
  ok('show=stock keeps it, show=low does not (no minimum)', !!(await row({ show: 'stock' })) && !(await row({ show: 'low' })));

  console.log('2. give out');
  const dept = await D.addDepartment(db, c, { name: `Test bay ${Date.now()}` });
  const person = await D.addPerson(db, c, { name: `Test person ${Date.now()}`, departmentId: dept.id });
  ok('a department is added once', (await D.addDepartment(db, c, { name: dept.name })).id === dept.id);
  const g1 = await D.giveOut(db, c, { givenFor: { type: 'department', departmentId: dept.id }, lines: [{ itemId: item.id, quantity: 10 }] });
  const [[m1]] = await db.query('SELECT used_for, given_type, department_id FROM cf_stock_movements WHERE id = ?', [g1.movement.id]);
  ok('given to a department: an issue, "general" for costing, the department on it', m1.used_for === 'general' && m1.given_type === 'department' && Number(m1.department_id) === dept.id, JSON.stringify(m1));
  ok('a consumable is not expected back', g1.outWith === 0);
  const r2 = await row();
  ok('the ledger: Out 10, balance 90', r2.out === 10 && r2.balance === 90, JSON.stringify(r2));
  const detail = await D.itemLedger(db, COMPANY, item.id, {});
  ok('the row opens into its events, newest first, with what each was for', detail.events.length === 2 && detail.events[0].change === -10 && detail.events[0].given?.label === dept.name, JSON.stringify(detail.events.map((e) => [e.change, e.given])));
  ok('and where it is', detail.areas.length === 1 && detail.areas[0].quantity === 90);

  console.log('3. out with');
  await db.query("UPDATE cf_item_details SET stores_kind = 'returnable', due_days = 7 WHERE master_id = ?", [item.id]);
  const g2 = await D.giveOut(db, c, { givenFor: { type: 'department', departmentId: dept.id }, personId: person.id, lines: [{ itemId: item.id, quantity: 3 }] });
  ok('a returnable item given out is expected back', g2.outWith === 1);
  let ow = await D.outWith(db, COMPANY, { search: item.name });
  const cu = ow.rows.find((x) => x.item.id === item.id);
  ok('it is out with the person, 3 left, due in a week', cu?.holderType === 'person' && cu.holder === person.name && cu.left === 3 && !!cu.dueOn, JSON.stringify(cu));
  ok('the ledger shows 3 out with', (await row()).outWith === 3);
  const back = await D.custodyBack(db, c, cu.id, { kind: 'returned', quantity: 1 });
  ok('one returned: 2 left, and it is back on the shelf (88)', back.left === 2 && back.returned === 1 && (await row()).balance === 88, JSON.stringify(back));
  await D.custodyBack(db, c, cu.id, { kind: 'worn', quantity: 1 });
  ok('lost needs what is known', (await refusal(D.custodyBack(db, c, cu.id, { kind: 'lost' })))?.code === 'REASON');
  const lost = await D.custodyBack(db, c, cu.id, { kind: 'lost', note: 'Not found at shift end' });
  ok('one worn, one lost: closed, nothing more comes back, the shelf is unchanged', lost.status === 'closed' && lost.left === 0 && lost.worn === 1 && lost.lost === 1 && (await row()).balance === 88);
  ok('more than is out is refused', (await refusal(D.custodyBack(db, c, cu.id, { kind: 'returned' })))?.code === 'CLOSED');

  console.log('4. a vendor');
  const [[party]] = await db.query('SELECT id, name FROM cf_parties WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [COMPANY]);
  if (!party) console.log('  (no party in this company: skipped)');
  else {
    // 2026-11-22: only a contractor is a vendor things are given to; and only a tool is then "out with" them.
    await db.query('UPDATE cf_parties SET is_subcontractor = 0 WHERE id = ?', [party.id]);
    const notC = await D.giveOut(db, c, { givenFor: { type: 'vendor', partyId: party.id }, lines: [{ itemId: item.id, quantity: 5 }] }).then(() => null, (e) => e);
    ok('a party that is not a contractor is refused', /not marked as a contractor/.test((notC?.problems ?? []).join(' ')));
    await db.query('UPDATE cf_parties SET is_subcontractor = 1 WHERE id = ?', [party.id]);
    const [[cons]] = await db.query(
      `SELECT m.id FROM cf_master_records m JOIN cf_item_details i ON i.master_id = m.id JOIN cf_stock_balances k ON k.item_id = m.id AND k.stocking_area_id = ? AND k.quantity >= 1
        WHERE m.company_id = ? AND m.deleted_at IS NULL AND i.tracked_by = 'quantity' AND i.stores_kind IS NULL AND i.issue_conditions IS NULL AND m.id <> ? LIMIT 1`, [area.id, COMPANY, item.id]);
    if (cons) {
      const gc = await D.giveOut(db, c, { givenFor: { type: 'vendor', partyId: party.id }, lines: [{ itemId: cons.id, quantity: 1 }] });
      ok('a consumable sent to a contractor is not on Out with', gc.outWith === 0);
    }
    // the tool below is the one that is out with the contractor
    const g3 = await D.giveOut(db, c, { givenFor: { type: 'vendor', partyId: party.id }, lines: [{ itemId: item.id, quantity: 5 }] });
    const [[m3]] = await db.query('SELECT used_for, given_type, given_party_id FROM cf_stock_movements WHERE id = ?', [g3.movement.id]);
    ok('sent to a vendor: not an order, not overhead', m3.used_for === 'vendor' && m3.given_type === 'vendor' && Number(m3.given_party_id) === party.id);
    ow = await D.outWith(db, COMPANY, { holder: 'vendor', search: item.name });
    ok('it is out with the vendor', ow.rows[0]?.holder === party.name && ow.rows[0].left === 5 && ow.counts.vendor >= 1);
    await D.custodyBack(db, c, ow.rows[0].id, { kind: 'returned' });
    ok('received back: on the shelf again', (await row()).balance === 88);
  }

  console.log('5. count');
  const list = await D.countList(db, COMPANY, { areaId: area.id });
  ok("today's list has what moved, with the book quantity", list.lines.some((l) => l.item.id === item.id && l.book === 88), JSON.stringify(list.lines.slice(0, 3)));
  const c0 = await D.postCount(db, c, { areaId: area.id, lines: [{ itemId: item.id, counted: 88 }] });
  ok('counted as the book says: matched, nothing posted', c0.status === 'matched' && c0.movementId == null);
  ok('a difference needs its reason', /say why/.test(said(await refusal(D.postCount(db, c, { areaId: area.id, lines: [{ itemId: item.id, counted: 86 }] })))));
  const c1 = await D.postCount(db, c, { areaId: area.id, lines: [{ itemId: item.id, counted: 86, reason: 'Two short on the shelf' }] });
  ok('2 short at ₹10: posted at once, the book is 86', c1.status === 'posted' && c1.value === 20 && !!c1.movementId && (await row()).balance === 86, JSON.stringify([c1.status, c1.value]));
  const c2 = await D.postCount(db, c, { areaId: area.id, lines: [{ itemId: item.id, counted: 6, reason: 'A box of 80 is missing' }] });
  ok('80 short (₹800, over the limit): it waits, the book stays 86', c2.status === 'pending' && !!c2.approvalId && c2.movementId == null && (await row()).balance === 86, JSON.stringify([c2.status, c2.value]));
  const [[ap]] = await db.query('SELECT * FROM cf_approvals WHERE id = ?', [c2.approvalId]);
  ok('it is in the approvals inbox as a stock count', ap.approval_type === 'stock_count' && ap.status === 'pending' && Number(ap.amount) === 800);
  await D.stockCountApprovalHandler.onApprove(db, c, ap);
  ok('approved: posted, the book is 6', (await D.getCount(db, COMPANY, c2.id)).status === 'posted' && (await row()).balance === 6);
  const c3 = await D.postCount(db, c, { areaId: area.id, lines: [{ itemId: item.id, counted: 96, reason: 'Found the box' }] });
  await D.stockCountApprovalHandler.onReject(db, c, { subject_id: c3.id }, 'Count it again');
  ok('sent back: rejected, the book does not move', (await D.getCount(db, COMPANY, c3.id)).status === 'rejected' && (await row()).balance === 6);

  console.log('5b. take back what was given out');
  {
    const [[cz]] = await db.query(
      `SELECT m.id, m.name, k.quantity AS q FROM cf_master_records m JOIN cf_item_details i ON i.master_id = m.id JOIN cf_stock_balances k ON k.item_id = m.id AND k.stocking_area_id = ? AND k.quantity >= 10
        WHERE m.company_id = ? AND m.deleted_at IS NULL AND i.tracked_by = 'quantity' AND i.stores_kind IS NULL AND i.issue_conditions IS NULL AND m.id <> ?
          AND NOT EXISTS (SELECT 1 FROM cf_stock_reservations v WHERE v.item_id = m.id AND v.status = 'active') LIMIT 1`, [area.id, COMPANY, item.id]);
    if (!cz) console.log('  (no consumable with 10 in stock: skipped)');
    else {
      const bal = async () => Number((await db.query('SELECT COALESCE(SUM(quantity), 0) AS q FROM cf_stock_balances WHERE company_id = ? AND item_id = ? AND stocking_area_id = ?', [COMPANY, cz.id, area.id]))[0][0].q);
      const before = await bal();
      const dz = await D.addDepartment(db, c, { name: `Take back ${Date.now()}` });
      const gz = await D.giveOut(db, c, { givenFor: { type: 'department', departmentId: dz.id }, lines: [{ itemId: cz.id, quantity: 8 }] });
      ok('8 given out', (await bal()) === before - 8);
      const tooMany = await D.takeBack(db, c, { movementId: gz.movement.id, itemId: cz.id, quantity: 9 }).then(() => null, (e) => e);
      ok('more than was given is refused', tooMany?.code === 'TOO_MANY');
      const tb = await D.takeBack(db, c, { movementId: gz.movement.id, itemId: cz.id, quantity: 3, note: 'not needed' });
      ok('3 taken back: the store has them again and the give-out stands for 5', tb.takenBack === 3 && !!tb.instead && (await bal()) === before - 5, JSON.stringify(tb));
      const [[cost]] = await db.query(
        `SELECT COALESCE(-SUM(l.quantity), 0) AS used FROM cf_stock_ledger l JOIN cf_stock_movements mm ON mm.id = l.movement_id
          WHERE l.company_id = ? AND l.item_id = ? AND mm.movement_type = 'issue'
            AND (mm.department_id = ? OR mm.reversal_of_id IN (SELECT id FROM cf_stock_movements WHERE department_id = ?))`, [COMPANY, cz.id, dz.id, dz.id]);
      ok('what is charged is the 5 that were used', Number(cost.used) === 5, String(cost.used));
      const again = await D.takeBack(db, c, { movementId: gz.movement.id, itemId: cz.id, quantity: 1 }).then(() => null, (e) => e);
      ok('the old entry cannot be taken back from twice', again?.code === 'REVERSED');
      const tool = await D.takeBack(db, c, { movementId: g2.movement.id, itemId: item.id, quantity: 1 }).then(() => null, (e) => e);
      ok('a tool does not come back this way', ['HAS_TOOLS', 'REVERSED'].includes(tool?.code), tool?.code);
      // a give-out with a consumable AND a tool: the consumable can be taken back, the tool stays out
      await db.query("UPDATE cf_item_details SET stores_kind = 'returnable' WHERE master_id = ?", [item.id]);
      const pz = await D.addPerson(db, c, { name: `Mixed ${Date.now()}`, departmentId: dz.id });
      const gm = await D.giveOut(db, c, { givenFor: { type: 'department', departmentId: dz.id }, personId: pz.id, lines: [{ itemId: cz.id, quantity: 2 }, { itemId: item.id, quantity: 1 }] });
      const tm = await D.takeBack(db, c, { movementId: gm.movement.id, itemId: cz.id, quantity: 2 });
      const [[cu]] = await db.query('SELECT c.status, mv.code, mv.reversed_by_id FROM cf_stock_custody c JOIN cf_stock_movements mv ON mv.id = c.movement_id WHERE c.company_id = ? AND c.item_id = ? AND c.person_id = ?', [COMPANY, item.id, pz.id]);
      ok('from a mixed give-out the consumable comes back; the tool is still out, on the entry written in its place', tm.takenBack === 2 && cu?.status === 'open' && cu.code === tm.instead && !cu.reversed_by_id, JSON.stringify({ tm, cu }));
    }
  }

  console.log('6. refusals');
  ok('given for nothing', /sales order, a department or a contractor/.test(said(await refusal(D.giveOut(db, c, { lines: [{ itemId: item.id, quantity: 1 }] })))));
  ok('a department that is not there', /Choose the department/.test(said(await refusal(D.giveOut(db, c, { givenFor: { type: 'department', departmentId: 999999999 }, lines: [{ itemId: item.id, quantity: 1 }] })))));
  ok('more than the shelf holds is refused by the stock itself', !!(await refusal(D.giveOut(db, c, { givenFor: { type: 'department', departmentId: dept.id }, lines: [{ itemId: item.id, quantity: 1000 }] }))));
  await db.query('INSERT INTO cf_company_settings (company_id, stores_v2) VALUES (?, 1) ON DUPLICATE KEY UPDATE stores_v2 = 1', [COMPANY]);
  ok('on the desk a free receipt, issue or count is refused in words', (await refusal(D.assertDeskAllows(db, COMPANY, 'receipt')))?.code === 'USE_THE_DESK' && /Give out/.test((await refusal(D.assertDeskAllows(db, COMPANY, 'issue')))?.message ?? '') && (await refusal(D.assertDeskAllows(db, COMPANY, 'adjustment')))?.code === 'USE_THE_DESK');
  ok('a transfer and a scrap are not', (await refusal(D.assertDeskAllows(db, COMPANY, 'transfer'))) === null && (await refusal(D.assertDeskAllows(db, COMPANY, 'scrap'))) === null);
  await db.query('UPDATE cf_company_settings SET stores_v2 = 0 WHERE company_id = ?', [COMPANY]);
  ok('off the desk nothing is refused', (await refusal(D.assertDeskAllows(db, COMPANY, 'receipt'))) === null);
  ok('a period that ends before it starts', (await refusal(D.ledger(db, COMPANY, { from: '2026-02-01', to: '2026-01-01' })))?.code === 'INVALID');

  // ---- §112 -------------------------------------------------------------------
  const T = await imp('apps/cf_erp/services/storesTodayService.js');
  const pad2 = (n) => String(n).padStart(2, '0');
  const dayText = (back) => { const d = new Date(); d.setDate(d.getDate() - back); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
  await db.query('INSERT IGNORE INTO cf_company_settings (company_id) VALUES (?)', [COMPANY]);

  console.log('7. levels from usage: the gate and the sums');
  ok('7 weeks of history: no suggestion', T.suggestLevels([5, 5, 5, 5, 5, 5, 5], { leadDays: 14 }) === null);
  ok('8 weeks but used in 3: no suggestion', T.suggestLevels([5, 0, 5, 0, 0, 5, 0, 0], { leadDays: 14 }) === null);
  const steady = T.suggestLevels(new Array(12).fill(10), { leadDays: 14 });
  ok('steady 10 a week, 14 days to get: minimum 30, maximum 70', steady?.min === 30 && steady?.max === 70 && steady?.cls === 'smooth', JSON.stringify(steady));
  const uneven = T.suggestLevels([4, 16, 9, 12, 2, 20, 7, 10, 11, 9, 14, 6], { leadDays: 14 });
  ok('uneven use holds more than the average needs', uneven.min > 30 && uneven.max > uneven.min, JSON.stringify(uneven));
  const rare = [0, 0, 6, 0, 0, 0, 4, 0, 0, 8, 0, 0, 0, 5, 0, 0];
  const r1s = T.suggestLevels(rare, { leadDays: 14, seed: 7 });
  ok('occasional use: from its own weeks, the same every time', r1s?.cls === 'intermittent' && r1s.min >= 4 && r1s.min <= 23 && JSON.stringify(r1s) === JSON.stringify(T.suggestLevels(rare, { leadDays: 14, seed: 7 })), JSON.stringify(r1s));
  ok('a minimum order quantity lifts the maximum', T.suggestLevels(new Array(12).fill(10), { leadDays: 14, minOrderQty: 100 }).max === 130);

  await postMovement(db, c, { movementType: 'receipt', lines: [{ itemId: item.id, quantity: 200, toAreaId: area.id, unitCost: 10 }] });
  for (let w = 1; w <= 9; w++) {
    await postMovement(db, c, { movementType: 'issue', usedFor: 'general', movementDate: dayText(w * 7 + 1), lines: [{ itemId: item.id, quantity: 6, fromAreaId: area.id }] }, { allowBackdate: true });
  }
  let lv = await T.levelSuggestions(db, COMPANY);
  let mine = lv.rows.find((r) => r.item.id === item.id);
  ok('ten weeks of give-outs: the item is suggested, as new', mine?.kind === 'new' && mine.suggested.min > 0 && mine.suggested.max > mine.suggested.min && mine.weeks >= 9, JSON.stringify(mine ?? lv.summary));
  ok('the reason is in words, and says the lead time is assumed', /a week over/.test(mine?.why ?? '') && mine?.leadAssumed === true);
  await T.applyLevel(db, c, item.id, mine.suggested);
  const [[ps]] = await db.query('SELECT method, min_qty, max_qty FROM cf_procurement_settings WHERE company_id = ? AND master_id = ?', [COMPANY, item.id]);
  ok('Apply sets the item to minimum / maximum at those levels', ps?.method === 'buy_min_max' && Number(ps.min_qty) === mine.suggested.min && Number(ps.max_qty) === mine.suggested.max);
  lv = await T.levelSuggestions(db, COMPANY);
  ok('once applied it is not suggested again', !lv.rows.some((r) => r.item.id === item.id));

  console.log('8. the closed period and backdating');
  await T.setDeskSettings(db, c, { closedThrough: dayText(1) });
  const closed = await refusal(postMovement(db, c, { movementType: 'receipt', movementDate: dayText(1), lines: [{ itemId: item.id, quantity: 1, toAreaId: area.id }] }));
  ok('an entry dated in the closed period is refused', closed?.code === 'PERIOD_CLOSED', said(closed));
  ok('today is still open', (await refusal(postMovement(db, c, { movementType: 'receipt', lines: [{ itemId: item.id, quantity: 1, toAreaId: area.id, unitCost: 10 }] }))) === null);
  ok('a period cannot be closed beyond today', (await refusal(T.setDeskSettings(db, c, { closedThrough: '2099-01-01' })))?.code === 'INVALID');
  await T.setDeskSettings(db, c, { closedThrough: null });
  await db.query('UPDATE cf_company_settings SET stores_v2 = 1 WHERE company_id = ?', [COMPANY]);
  const old = await refusal(postMovement(db, c, { movementType: 'transfer', movementDate: dayText(10), lines: [{ itemId: item.id, quantity: 1, fromAreaId: area.id, toAreaId: area.id }] }));
  ok('on the desk an entry dated 10 days back is refused', old?.code === 'BACKDATED', said(old));
  await db.query('UPDATE cf_company_settings SET stores_v2 = 0 WHERE company_id = ?', [COMPANY]);

  console.log('9. out with: how long');
  const g9 = await D.giveOut(db, c, { givenFor: { type: 'department', departmentId: dept.id }, personId: person.id, lines: [{ itemId: item.id, quantity: 2 }] });
  let age = await D.outWith(db, COMPANY, { search: item.name });
  ok('given today: in the 0–30 day bucket', g9.outWith === 1 && age.counts.d30 >= 1 && age.rows.every((r) => r.overdueDays === 0), JSON.stringify(age.counts));
  await db.query('UPDATE cf_stock_custody SET issued_on = ?, due_on = NULL WHERE company_id = ? AND movement_id = ?', [dayText(100), COMPANY, g9.movement.id]);
  age = await D.outWith(db, COMPANY, { age: 'over', search: item.name });
  ok('100 days out: over 90, and out too long by 10 days', age.rows.length === 1 && age.rows[0].overdueDays === 10 && age.counts.over >= 1 && age.counts.overdue >= 1, JSON.stringify(age.rows[0] ?? age.counts));
  ok('the 0–30 bucket no longer has it', !(await D.outWith(db, COMPANY, { age: 'd30', search: item.name })).rows.some((r) => r.movementId === g9.movement.id));

  console.log('10. today');
  const nowMin = Math.floor((((Date.now() / 1000 + 19800) % 86400)) / 60);
  const hhmm = (m) => `${pad2(Math.floor((m % 1440) / 60))}:${pad2(m % 60)}`;
  await T.setDeskSettings(db, c, { openTime: hhmm(nowMin + 120), closeTime: hhmm(nowMin + 121) });   // now is outside the store's hours
  let td = await T.today(db, COMPANY);
  ok('entries made outside the hours are listed', td.afterHours.entries.some((e) => e.id === g9.movement.id), JSON.stringify(td.afterHours.hours));
  ok('the thing out too long is on the page', td.outTooLong.count >= 1 && td.outTooLong.rows.some((r) => r.movementId === g9.movement.id));
  ok('the page carries every line', Array.isArray(td.purchaseOrders.rows) && typeof td.count.dailyDue === 'boolean' && typeof td.belowMinimum.count === 'number' && td.levels.gate.weeks === 8);
  const chk = await T.nightCheck(db, c, { note: 'seen' });
  await new Promise((r) => setTimeout(r, 1100));
  td = await T.today(db, COMPANY);
  ok('after the morning check they are gone', chk.checked >= 1 && td.afterHours.entries.length === 0 && !!td.afterHours.lastCheckedAt, String(td.afterHours.entries.length));
  await T.setDeskSettings(db, c, { openTime: hhmm(nowMin + 1380), closeTime: hhmm(nowMin + 60) });   // now is inside the hours
  const g10 = await D.giveOut(db, c, { givenFor: { type: 'department', departmentId: dept.id }, lines: [{ itemId: item.id, quantity: 1 }] });
  ok('an entry made in the hours is not listed', !(await T.today(db, COMPANY)).afterHours.entries.some((e) => e.id === g10.movement.id));
  const low = await db.query('UPDATE cf_procurement_settings SET min_qty = 100000, max_qty = 200000 WHERE company_id = ? AND master_id = ?', [COMPANY, item.id]);
  td = await T.today(db, COMPANY);
  ok('below its minimum with nothing on order', !!low && td.belowMinimum.rows.concat([]).length >= 1 && td.belowMinimum.count >= 1);

  console.log('11. the machine\'s owner');
  const M = await imp('apps/cf_erp/services/machineService.js');
  const [[mach]] = await db.query('SELECT id FROM cf_machines WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [COMPANY]);
  if (!mach) console.log('  (no machine in this company: skipped)');
  else ok('an owner is kept on the machine', (await M.updateMachine(db, c, mach.id, { ownerName: 'Test owner' })).ownerName === 'Test owner');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
} catch (e) {
  console.log('THREW:', e.message, e.problems ?? '', '\n', e.stack?.split('\n').slice(1, 4).join('\n'));
  process.exitCode = 1;
} finally {
  try { await db.rollback(); } catch { /* going back anyway */ }
  detachNodeCache(db); db.release(); await pool.end();
}
