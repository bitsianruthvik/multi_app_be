/**
 * Deleting rows, and the other sheets' edits that can remove something (case 7 of the brief). A row missing from the workbook is
 * ambiguous (deleted, or the sheet was never filled in), so nothing is removed without --delete-missing; and even then nothing
 * is erased: a seat is CLOSED, an assignment ENDED, a duty retired, a question DISMISSED. A department is
 * retired only when no seat sits in it and nothing is under it (see departments.mjs).
 */
export const name = 'removals';

const deleteRowsDescending = (t, wb, sheet, rows) => [...rows].sort((a, b) => b - a).forEach((r) => t.deleteRow(wb, sheet, r));

export const cases = [
  {
    name: 'DELETE a seat row: NOT removed without --delete-missing; with it the seat is CLOSED (kept in history)',
    async run(t) {
      const { buf, data } = await t.freshExport();
      const wb = await t.open(buf);
      const seat = t.need(data.seats.find((s) => t.isLeaf(data, s) && !t.peopleIn(data, s).length && t.seatsOfRole(data, s) === 1)
        ?? data.seats.find((s) => t.isLeaf(data, s) && !t.peopleIn(data, s).length), 'no empty leaf seat to delete');
      t.deleteRow(wb, 'Structure', t.rowOfKey(wb, seat.key));
      const edited = await t.save(wb);

      const without = await t.plan(edited);
      t.ok(without.plan.empty && without.plan.kept.seats.length === 1 && without.plan.kept.seats[0].key === seat.key, `without the flag: the plan is empty and "${seat.title}" is listed as LEFT ALONE`);
      const r1 = await t.rehearse(edited, {}, async (c) => ({ s: (await t.q('SELECT status FROM hrms_positions WHERE id = ?', [seat.positionId], c))[0].status }));
      t.ok(r1.status === 'NOTHING_TO_DO', `an --apply without the flag does nothing (${r1.status})`);

      const withFlag = await t.plan(edited, { deleteMissing: true });
      t.ok(t.codes(withFlag).length === 0 && withFlag.plan.counts.seatsClosed === 1, `with the flag the seat is to be closed (${t.summary(withFlag.plan)})`);
      const r2 = await t.rehearse(edited, { deleteMissing: true }, async (c) => ({
        s: (await t.q('SELECT status, deleted_at FROM hrms_positions WHERE id = ?', [seat.positionId], c))[0],
        listed: (await t.freshExport(c)).data.seats.some((x) => x.key === seat.key),
      }));
      if (!t.ok(r2.status === 'REHEARSED', `applied (${t.why(r2)})`)) return;
      t.ok(r2.observed.s.status === 'CLOSED' && r2.observed.s.deleted_at === null, 'the seat is CLOSED, not erased: it keeps its history');
      t.ok(r2.observed.listed === false, 'a fresh export no longer lists it');
    },
  },
  {
    name: 'DELETE a People row, a duty row and a question row: left alone without the flag; ended, retired and dismissed with it',
    async run(t) {
      const { buf, data } = await t.freshExport();
      const wb = await t.open(buf);
      const person = t.part(data.people[3] ?? data.people[0], 'nobody holds a seat');
      const duty = t.part(data.responsibilities.find((r) => r.overrideId == null), 'no duties');
      const question = t.part(data.questions[0], 'no open questions');
      t.need(person || duty || question, 'nothing to delete');
      if (person) t.deleteRow(wb, 'People', t.findKeyRow(wb, 'People', person.key));
      if (duty) t.deleteRow(wb, 'Responsibilities', t.findKeyRow(wb, 'Responsibilities', duty.key));
      if (question) t.deleteRow(wb, 'Questions & doubts', t.findKeyRow(wb, 'Questions & doubts', question.key));
      const edited = await t.save(wb);

      const without = await t.plan(edited);
      t.ok(without.plan.empty && without.plan.kept.people.length === (person ? 1 : 0) && without.plan.kept.responsibilities.length === (duty ? 1 : 0) && without.plan.kept.questions.length === (question ? 1 : 0),
        'without the flag: nothing planned, every deleted row is listed as left alone');
      const withFlag = await t.plan(edited, { deleteMissing: true });
      t.ok(t.codes(withFlag).length === 0, `with the flag: ${t.summary(withFlag.plan)}`);
      const res = await t.rehearse(edited, { deleteMissing: true }, async (c) => ({
        a: person && (await t.q('SELECT status, effective_to, deleted_at FROM hrms_work_assignments WHERE id = ?', [person.assignmentId], c))[0],
        e: person && (await t.q('SELECT employment_status, deleted_at FROM hrms_employees WHERE id = ?', [person.employeeId], c))[0],
        d: duty && (await t.q('SELECT deleted_at, effective_to FROM hrms_role_responsibility_assignments WHERE id = ?', [duty.rowId], c))[0],
        def: duty && (await t.q('SELECT deleted_at FROM hrms_responsibility_definitions WHERE id = ?', [duty.defId], c))[0],
        q: question && (await t.q('SELECT status, resolution, deleted_at FROM hrms_open_points WHERE id = ?', [question.id], c))[0],
      }));
      if (!t.ok(res.status === 'REHEARSED', `applied (${t.why(res)})`)) return;
      const o = res.observed;
      if (person) t.ok(o.a.status === 'ENDED' && o.a.deleted_at === null && o.e.deleted_at === null && o.e.employment_status !== 'EXITED', "the person's assignment is ENDED; they are still an employee");
      if (duty) t.ok(o.d.deleted_at !== null && o.d.effective_to !== null && o.def.deleted_at === null, 'the duty is retired from the role (dated); its definition is kept');
      if (question) t.ok(o.q.status === 'DISMISSED' && /workbook/.test(o.q.resolution) && o.q.deleted_at === null, `the question is DISMISSED with a note ("${o.q.resolution}")`);
    },
  },
  {
    name: 'DELETE guards: an occupied seat, and an emptied sheet',
    async run(t) {
      const { buf, data } = await t.freshExport();
      const occupied = t.part(data.seats.find((s) => t.isLeaf(data, s) && t.peopleIn(data, s).length > 0), 'no occupied leaf seat');
      if (occupied) {
        const wb = await t.open(buf);
        t.deleteRow(wb, 'Structure', t.rowOfKey(wb, occupied.key));
        const p1 = await t.plan(await t.save(wb), { deleteMissing: true });
        t.ok(t.codes(p1).includes('SEAT_STILL_OCCUPIED'), `deleting the occupied seat "${occupied.title}" while its people's rows stay is an ERROR, not a quiet end`);

        const wb2 = await t.open(buf);
        const people = t.peopleIn(data, occupied);
        deleteRowsDescending(t, wb2, 'People', people.map((p) => t.findKeyRow(wb2, 'People', p.key)));
        t.deleteRow(wb2, 'Structure', t.rowOfKey(wb2, occupied.key));
        const p2 = await t.plan(await t.save(wb2), { deleteMissing: true });
        t.ok(t.codes(p2).length === 0 && p2.plan.counts.seatsClosed === 1 && p2.plan.counts.peopleEnded === people.length, `seat row and ${people.length} person row(s) deleted: they are ended, then the seat is closed`);
      }
      if (data.people.length) {
        const wb4 = await t.open(buf);
        const ws = wb4.getWorksheet('People');
        for (let r = ws.rowCount; r >= 2; r--) ws.spliceRows(r, 1);
        const p4 = await t.plan(await t.save(wb4), { deleteMissing: true });
        t.ok(p4.plan.counts.peopleEnded === 0 && p4.plan.notices.some((n) => n.code === 'SHEET_EMPTY'), 'People emptied entirely + --delete-missing: NOBODY is ended (an empty sheet means "not filled in")');
      } else t.partial.push('no people to empty the People sheet of');
      t.need(occupied || data.people.length, 'nothing to guard');
    },
  },
  {
    name: 'a seat deleted together with its role\'s last seat leaves the duties on the role, and says so',
    async run(t) {
      const { buf, data } = await t.freshExport();
      const seat = t.need(data.seats.find((s) => t.isLeaf(data, s) && !t.peopleIn(data, s).length && t.seatsOfRole(data, s) === 1
        && data.responsibilities.some((r) => r.roleId === s.roleId)), 'no empty leaf seat that is the only seat of a role with duties');
      const wb = await t.open(buf);
      t.deleteRow(wb, 'Structure', t.rowOfKey(wb, seat.key));
      const edited = await t.save(wb);
      const prep = await t.plan(edited, { deleteMissing: true });
      t.ok(t.codes(prep).length === 0 && prep.plan.counts.seatsClosed === 1 && prep.plan.notices.some((n) => n.code === 'ROLE_LEFT_WITHOUT_SEAT'),
        'planned as a closure, with a notice that the role keeps its duties but will not show them in the next export');
      const res = await t.rehearse(edited, { deleteMissing: true }, async (c) => ({
        kept: (await t.q('SELECT COUNT(*) n FROM hrms_role_responsibility_assignments WHERE role_id = ? AND deleted_at IS NULL', [seat.roleId], c))[0].n,
      }));
      t.ok(res.status === 'REHEARSED', `applied, and the post-write re-check agreed (${t.why(res)})`);
      t.ok(res.status === 'REHEARSED' && Number(res.observed.kept) === data.responsibilities.filter((r) => r.roleId === seat.roleId).length, 'the role still holds all of its duties');
    },
  },
  {
    name: 'QUESTIONS: reword one; change what another is about',
    async run(t) {
      const { buf, data } = await t.freshExport();
      const a = t.need(data.questions[0], 'no open questions');
      const b = t.need(data.questions[1], 'only one open question');
      const seat = t.need(data.seats.find((s, i) => i !== b.seat && s.positionId !== b.entityId), 'no other seat');
      const wb = await t.open(buf);
      t.setCell(wb, 'Questions & doubts', t.findKeyRow(wb, 'Questions & doubts', a.key), 2, `${a.text} (and who signs? ${t.tag})`);
      t.setCell(wb, 'Questions & doubts', t.findKeyRow(wb, 'Questions & doubts', b.key), 1, t.labelOf(data, seat));
      const edited = await t.save(wb);
      const prep = await t.plan(edited);
      t.ok(prep.plan.counts.questionsChanged === 2 && t.changed(prep.plan) === 'questionsChanged', `two questions changed (${t.summary(prep.plan)})`);
      const res = await t.rehearse(edited, {}, async (c) => ({
        a: (await t.q('SELECT description FROM hrms_open_points WHERE id = ?', [a.id], c))[0].description,
        b: (await t.q('SELECT entity_type, entity_id FROM hrms_open_points WHERE id = ?', [b.id], c))[0],
      }));
      if (!t.ok(res.status === 'REHEARSED', `applied (${t.why(res)})`)) return;
      t.ok(res.observed.a.includes(t.tag), 'the first question is reworded');
      t.ok(res.observed.b.entity_type === 'POSITION' && res.observed.b.entity_id === seat.positionId, 'the second is now about that seat');
    },
  },
];
