/**
 * What must NOT happen. A workbook for the wrong tenant, the wrong database or a version nobody knows is refused (case 8 of
 * the brief); a database that has moved since the export is not quietly put back; a damaged Key is not read as a thousand new rows;
 * and what Excel's own rules would have stopped, pasted past them, is stopped here instead.
 */
export const name = 'safety';

export const cases = [
  {
    name: 'REFUSE a workbook that belongs to a different company, database or schema version',
    async run(t) {
      const { buf } = await t.freshExport();
      // (a) a genuine one: this company's own workbook, pointed at another company that exists on the same server
      const [other] = await t.q('SELECT slug FROM companies WHERE id <> ? AND deleted_at IS NULL AND slug IS NOT NULL ORDER BY id LIMIT 1', [t.companyId]);
      if (other) {
        const prep = await t.A.prepare({ conn: t.conn, buf, slug: other.slug, target: t.target, deleteMissing: false })
          .catch((e) => ({ refusals: [], plan: undefined, crashed: e.message }));
        if (prep.crashed) t.note(`it was not refused, and went on to read the other company: ${prep.crashed}`);
        t.ok(prep.refusals.length === 1 && /different company/.test(prep.refusals[0]) && prep.plan === null, `a ${t.slug} workbook applied with --company=${other.slug} is REFUSED: "${prep.refusals[0]?.slice(0, 110)}..."`);
        const res = await t.A.applyWorkbook({ conn: t.conn, buf, file: 'x.xlsx', slug: other.slug, target: t.target, flags: { rehearse: async () => 1, again: true } });
        t.ok(res.status === 'REFUSED', `and an --apply is refused too (${res.status}); nothing was written`);
      } else t.partial.push('no second company on this server for the genuine wrong-tenant check');

      // (b) forged provenance: another company's slug and id, applied here
      const wb = await t.open(buf);
      t.setProvenance(wb, 'companySlug', `forged-${t.tag}`);
      t.setProvenance(wb, 'companyId', t.companyId + 987654);
      const p2 = await t.plan(await t.save(wb));
      t.ok(p2.refusals.length === 1 && p2.refusals[0].includes(`forged-${t.tag} (company id ${t.companyId + 987654})`) && p2.refusals[0].includes(`${t.slug} (company id ${t.companyId})`), 'a workbook exported for another company is REFUSED, and the message names both');
      // (c) the id alone is enough
      const wb2 = await t.open(buf);
      t.setProvenance(wb2, 'companyId', t.companyId + 1);
      t.ok((await t.plan(await t.save(wb2))).refusals.length === 1, 'the right slug with the wrong company id is REFUSED');
      // (d) a schema version nobody knows
      const wb3 = await t.open(buf);
      t.setProvenance(wb3, 'schemaVersion', 99);
      const p4 = await t.plan(await t.save(wb3));
      t.ok(p4.refusals.some((r) => /schema version 99/.test(r)) && p4.plan === null, 'an unknown schema version (99) is REFUSED');
      // (e) the other database
      const wb4 = await t.open(buf);
      t.setProvenance(wb4, 'target', t.target.isProd ? 'local' : 'prod');
      const p5 = await t.plan(await t.save(wb4));
      t.ok(p5.refusals.some((r) => /database; you are applying it to/.test(r)), `a workbook exported from ${t.target.isProd ? 'LOCAL' : 'PRODUCTION'} is REFUSED here (its keys are ids in the other database)`);
      // (f) a provenance block with a field torn out
      const wb5 = await t.open(buf);
      t.clearProvenance(wb5, 'contentHash');
      const p6 = await t.plan(await t.save(wb5));
      t.ok(p6.plan === null && t.codes(p6).includes('PROVENANCE_INCOMPLETE'), 'a provenance block with a field missing is an ERROR, not a pass');
    },
  },
  {
    name: 'STALE: the database changed after the workbook was exported, so applying it would put the old values back',
    async run(t) {
      const { buf, data } = await t.freshExport();
      const seat = t.need(data.seats[3] ?? data.seats[0], 'no seats');
      await t.conn.beginTransaction();
      let prep;
      try {
        await t.conn.query('UPDATE hrms_positions SET position_title = ? WHERE id = ?', [`Changed in the system meanwhile ${t.tag}`, seat.positionId]);
        prep = await t.plan(buf);
      } finally { await t.conn.rollback(); }
      t.ok(prep.stale === true, 'the fingerprint no longer matches: stale');
      t.ok(prep.plan.counts.seatsRetitled === 1, 'and the plan WOULD put the old title back (which is exactly the danger)');
      t.ok(t.A.gate(prep, { allowStale: false })?.status === 'STALE', 'an --apply is refused');
      t.ok(t.A.gate(prep, { allowStale: true })?.status !== 'STALE', '--allow-stale lets it through');
    },
  },
  {
    name: 'DAMAGED KEYS: all wiped, one cleared, the wrong kind, made up',
    async run(t) {
      const { buf, data } = await t.freshExport();
      const seat = t.need(data.seats[Math.min(40, data.seats.length - 1)], 'no seats');
      const wipe = await t.open(buf);
      const ws = wipe.getWorksheet('Structure');
      for (let r = 2; r <= ws.rowCount; r++) if (ws.getRow(r).getCell(t.COLS.key).value) ws.getRow(r).getCell(t.COLS.key).value = null;
      const wiped = await t.plan(await t.save(wipe));
      t.ok(t.codes(wiped).includes('KEYS_MISSING') && wiped.plan.counts.seatsCreated === data.seats.length, `Structure with ALL keys cleared: an ERROR (KEYS_MISSING), not ${data.seats.length} new seats being quietly created`);

      const wb = await t.open(buf);
      wb.getWorksheet('Structure').getRow(t.rowOfKey(wb, seat.key)).getCell(t.COLS.key).value = null;
      t.ok(t.codes(await t.plan(await t.save(wb))).includes('LOOKS_LIKE_ERASED_KEY'), `one seat's Key cleared ("${seat.title}"): refused as a damaged key, not added as a duplicate`);

      const wb2 = await t.open(buf);
      wb2.getWorksheet('Structure').getRow(t.rowOfKey(wb2, data.seats[0].key)).getCell(t.COLS.key).value = 'asg:1';
      t.ok(t.codes(await t.plan(await t.save(wb2))).includes('BAD_KEY'), 'an asg: key on Structure is an ERROR (BAD_KEY)');

      const wb3 = await t.open(buf);
      wb3.getWorksheet('Structure').getRow(t.rowOfKey(wb3, data.seats[0].key)).getCell(t.COLS.key).value = 'pos:999999999';
      const p3 = await t.plan(await t.save(wb3));
      t.ok(t.codes(p3).includes('KEY_NOT_IN_DATABASE') && p3.plan.counts.seatsCreated === 0, 'a key that is not in the database is a reported problem (KEY_NOT_IN_DATABASE): not a crash, and not a new row');
    },
  },
  {
    name: 'BAD DATA pasted past the in-sheet rules is an error here: count, shift, machine, two titles, skipped level, date, seat',
    async run(t) {
      const { buf, data } = await t.freshExport();
      t.need(data.seats.length >= 10, 'fewer than ten seats');
      const wb = await t.open(buf);
      const set = (i, col, v) => t.setCell(wb, 'Structure', t.rowOfKey(wb, data.seats[i].key), col, v);
      set(4, t.COLS.count, 'abc');
      set(5, t.COLS.shift, 'Swing');
      set(6, t.COLS.machines, 'No Such Machine');
      const c1 = t.codes(await t.plan(await t.save(wb)));
      t.ok(c1.includes('BAD_COUNT') && c1.includes('BAD_SHIFT') && c1.includes('UNKNOWN_MACHINE'), `count "abc", shift "Swing" and machine "No Such Machine" are all ERRORS (${c1.join(', ')})`);

      const wb2 = await t.open(buf);
      wb2.getWorksheet('Structure').getRow(t.rowOfKey(wb2, data.seats[7].key)).getCell(t.S.COL.lastLevel).value = 'A second title in the same row';
      t.ok(t.codes(await t.plan(await t.save(wb2))).includes('TWO_TITLES'), 'two titles in one row is an ERROR');

      const wb3 = await t.open(buf);
      const shallow = t.need(data.seats.find((s, i) => i > 1 && (t.levelOfRow(wb3, t.rowOfKey(wb3, s.key)) ?? 10) <= 6), 'no seat shallow enough to push three levels deeper');
      const r3 = t.rowOfKey(wb3, shallow.key);
      const lvl = t.levelOfRow(wb3, r3);
      const ws3 = wb3.getWorksheet('Structure');
      const cell = ws3.getRow(r3).getCell(t.S.COL.firstLevel + lvl - 1).value;
      ws3.getRow(r3).getCell(t.S.COL.firstLevel + lvl - 1).value = null;
      ws3.getRow(r3).getCell(t.S.COL.firstLevel + lvl + 2).value = cell;
      t.ok(t.codes(await t.plan(await t.save(wb3))).includes('SKIPPED_LEVEL'), 'a seat indented three levels in one go is an ERROR (SKIPPED_LEVEL)');

      if (data.people.length) {
        const wb4 = await t.open(buf);
        t.setCell(wb4, 'People', t.findKeyRow(wb4, 'People', data.people[0].key), 5, 'next Tuesday');
        t.ok(t.codes(await t.plan(await t.save(wb4))).includes('BAD_DATE'), 'a Joined date that is not a date is an ERROR');
        const wb5 = await t.open(buf);
        t.setCell(wb5, 'People', t.findKeyRow(wb5, 'People', data.people[0].key), 2, 'P9999 — Nobody');
        t.ok(t.codes(await t.plan(await t.save(wb5))).includes('SEAT_NOT_FOUND'), 'a People row pointing at a seat that is not on Structure is an ERROR');
      } else t.partial.push('no people for the date and seat checks');
    },
  },
  {
    name: 'MACHINE NAMES: a new name with a comma and a duplicate are refused; an existing comma name still round-trips',
    async run(t) {
      const { buf, data } = await t.freshExport();
      const machine = t.need(data.machines[0], 'no machines');
      const wb = await t.open(buf);
      t.appendRow(wb, 'Machines & areas', [`Press ${t.tag}, Press 2`, 'Machine', '']);
      t.appendRow(wb, 'Machines & areas', [machine.name.toUpperCase(), 'Machine', '']);
      const prep = await t.plan(await t.save(wb));
      t.ok(t.codes(prep).includes('COMMA_IN_NAME'), 'a NEW machine name with a comma is refused (it could not be told apart from two machines)');
      t.ok(t.codes(prep).some((c) => c === 'DUPLICATE_NAME' || c === 'MACHINE_NAME_TAKEN'), `a machine named twice (different case) is refused (${t.codeList(prep)})`);
      const withComma = data.machines.find((m) => m.name.includes(','));
      if (withComma) {
        const same = await t.plan(buf);
        t.ok(same.plan.empty && same.problems.length === 0, `the existing machine "${withComma.name}" (a comma in its name) still round-trips untouched`);
      } else t.partial.push('no existing machine has a comma in its name');
    },
  },
];
