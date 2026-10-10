/**
 * Editing the People sheet. A person who moves is two assignments, not one edited (case 5 of the brief); a person in two
 * seats is two rows by design; a row whose Key was cleared is matched by person and seat, never added a second time.
 */
export const name = 'people';

export const cases = [
  {
    name: 'MOVE a person to a different seat: the old assignment ENDS, a new one starts, an employment event is written',
    async run(t) {
      const { buf, data } = await t.freshExport();
      const person = t.need(data.people[0], 'nobody holds a seat');
      const target = t.need(data.seats.find((s) => s.key !== person.seatKey && !t.peopleIn(data, s).length && s.roleId !== person.roleId), 'no empty seat in another role');
      const employeesBefore = (await t.q('SELECT COUNT(*) n FROM hrms_employees WHERE company_id = ? AND deleted_at IS NULL', [t.companyId]))[0].n;
      const wb = await t.open(buf);
      t.setCell(wb, 'People', t.findKeyRow(wb, 'People', person.key), 2, t.labelOf(data, target));
      const edited = await t.save(wb);
      const prep = await t.plan(edited);
      t.ok(t.changed(prep.plan) === 'peopleMovedToAnotherSeat' && t.totalChanges(prep.plan) === 1, `exactly one change: one person moved (${t.summary(prep.plan)})`);
      const res = await t.rehearse(edited, {}, async (c) => ({
        asg: await t.q('SELECT id, position_id, role_id, status, effective_from, effective_to, is_primary, allocation_percent FROM hrms_work_assignments WHERE employee_id = ? AND deleted_at IS NULL ORDER BY id', [person.employeeId], c),
        events: await t.q('SELECT event_type, summary, work_assignment_id FROM hrms_employment_events WHERE employee_id = ? ORDER BY id DESC LIMIT 1', [person.employeeId], c),
        employees: (await t.q('SELECT COUNT(*) n FROM hrms_employees WHERE company_id = ? AND deleted_at IS NULL', [t.companyId], c))[0].n,
        reexport: (await t.freshExport(c)).data.people.find((p) => p.employeeId === person.employeeId && p.seatKey === target.key),
      }));
      if (!t.ok(res.status === 'REHEARSED', `applied (${t.why(res)})`)) return;
      const o = res.observed;
      const oldA = o.asg.find((a) => a.id === person.assignmentId);
      const newA = o.asg.find((a) => a.position_id === target.positionId && a.status === 'ACTIVE');
      t.ok(oldA?.status === 'ENDED' && oldA.effective_to !== null, `the old assignment is ENDED (to ${String(oldA?.effective_to).slice(0, 10)}): history is kept`);
      t.ok(newA && newA.role_id === target.roleId, `a new assignment is ACTIVE in "${target.title}", with that seat's role`);
      t.ok(newA && newA.is_primary === (person.isPrimary ? 1 : 0), 'the primary flag carries over');
      t.ok(o.events[0]?.event_type === 'TRANSFER' && o.events[0].work_assignment_id === newA?.id, `an employment event was written: "${o.events[0]?.summary}"`);
      t.ok(Number(o.employees) === Number(employeesBefore), 'no employee was created or removed');
      t.ok(Boolean(o.reexport), 'a fresh export shows the person in the new seat');
    },
  },
  {
    name: "EDIT a person: name, employee code, joining date, shift",
    async run(t) {
      const env = await t.env();
      const { buf, data } = await t.freshExport();
      const person = t.need(data.people[1] ?? data.people[0], 'nobody holds a seat');
      const shift = t.need(env.shifts.find((s) => s.name !== person.shift), 'only one shift in this company');
      const name = `Renamed ${t.tag}`;
      const code = `ZX${t.tag}`.toUpperCase();
      const wb = await t.open(buf);
      const row = t.findKeyRow(wb, 'People', person.key);
      t.setCell(wb, 'People', row, 1, name);
      t.setCell(wb, 'People', row, 3, shift.name);
      t.setCell(wb, 'People', row, 4, code);
      t.setCell(wb, 'People', row, 5, new Date(Date.UTC(2020, 0, 15)));
      const edited = await t.save(wb);
      const prep = await t.plan(edited);
      t.ok(t.changed(prep.plan) === 'peopleChanged,peopleShiftChanged', `name/code/joined and shift are the only changes (${t.summary(prep.plan)})`);
      const res = await t.rehearse(edited, {}, async (c) => ({
        e: (await t.q('SELECT full_name, employee_code, date_of_joining, salutation FROM hrms_employees WHERE id = ?', [person.employeeId], c))[0],
        before: (await t.q('SELECT salutation FROM hrms_employees WHERE id = ?', [person.employeeId])).at(0),
        a: (await t.q('SELECT default_shift_id FROM hrms_work_assignments WHERE id = ?', [person.assignmentId], c))[0],
      }));
      if (!t.ok(res.status === 'REHEARSED', `applied (${t.why(res)})`)) return;
      const o = res.observed;
      t.ok(o.e.full_name === name && o.e.employee_code === code && String(o.e.date_of_joining).slice(0, 10) === '2020-01-15', `employee: ${JSON.stringify({ name: o.e.full_name, code: o.e.employee_code, joined: String(o.e.date_of_joining).slice(0, 10) })}`);
      t.ok(o.a.default_shift_id === shift.id, 'the assignment now has the new shift');
      t.ok(o.e.salutation === o.before?.salutation, 'a rename leaves the salutation alone (the sheet has no column for it)');
    },
  },
  {
    name: 'ADD people: a brand new person, and an existing person given a SECOND seat by name',
    async run(t) {
      const env = await t.env();
      const { buf, data } = await t.freshExport();
      const existing = t.need(data.people[2] ?? data.people[0], 'nobody holds a seat');
      // One person per position (2026-10-10): both additions need a VACANT seat. The services refuse a second
      // person on a filled one (409 POSITION_FILLED), which is what this case used to do with seats[1].
      const empty = data.seats.filter((s) => !t.peopleIn(data, s).length);
      const seatA = t.need(empty[0], 'no vacant seat');
      const seatB = t.need(empty.find((s) => s.key !== seatA.key && s.key !== existing.seatKey), 'no second vacant seat to give');
      const newName = `New Person ${t.tag}`;
      const joined = new Date(Date.UTC(2026, 9, 1));
      const shift = env.shifts[0]?.name ?? '';
      const wb = await t.open(buf);
      t.appendRow(wb, 'People', [newName, t.labelOf(data, seatA), shift, '', joined]);
      t.appendRow(wb, 'People', [existing.name, t.labelOf(data, seatB), shift]);
      const prep = await t.plan(await t.save(wb));
      t.ok(prep.plan.counts.peopleAdded === 1 && prep.plan.counts.peopleSeatedAgain === 1 && t.codes(prep).length === 0, `one new person and one existing person given another seat (${t.summary(prep.plan)})`);
      const codes = (await t.q('SELECT employee_code c FROM hrms_employees WHERE company_id = ? AND deleted_at IS NULL', [t.companyId])).map((r) => r.c);
      const res = await t.rehearse(await t.save(wb), {}, async (c) => ({
        n: (await t.q('SELECT id, employee_code, date_of_joining FROM hrms_employees WHERE full_name = ? AND company_id = ? AND deleted_at IS NULL', [newName, t.companyId], c))[0],
        mine: await t.q("SELECT position_id, is_primary FROM hrms_work_assignments WHERE employee_id = ? AND deleted_at IS NULL AND status = 'ACTIVE' ORDER BY id", [existing.employeeId], c),
        same: (await t.q('SELECT COUNT(*) n FROM hrms_employees WHERE full_name = ? AND company_id = ? AND deleted_at IS NULL', [existing.name, t.companyId], c))[0].n,
        join: await t.q("SELECT event_type FROM hrms_employment_events WHERE employee_id = (SELECT id FROM hrms_employees WHERE full_name = ? AND company_id = ? AND deleted_at IS NULL LIMIT 1)", [newName, t.companyId], c),
      }));
      if (!t.ok(res.status === 'REHEARSED', `applied (${t.why(res)})`)) return;
      const o = res.observed;
      t.ok(o.n && !codes.includes(o.n.employee_code) && String(o.n.date_of_joining).slice(0, 10) === '2026-10-01', `the new person got a code nobody else has (${o.n?.employee_code}) and the joining date typed`);
      t.ok(o.same === 1 && o.mine.some((a) => a.position_id === seatB.positionId && a.is_primary === 0), 'the existing person kept ONE employee row and gained a second, non-primary assignment');
      t.ok(o.join.some((e) => e.event_type === 'JOIN'), 'the new person has a JOIN event');
    },
  },
  {
    name: 'COPY-PASTE a People row to a different seat: the SAME employee in a second seat; left in the same seat it adds nothing',
    async run(t) {
      const { buf, data } = await t.freshExport();
      const person = t.need(data.people[2] ?? data.people[0], 'nobody holds a seat');
      const seat = t.need(data.seats.find((s) => s.key !== person.seatKey && !t.peopleIn(data, s).length), 'no empty seat');
      const wb = await t.open(buf);
      const row = t.findKeyRow(wb, 'People', person.key);
      t.copyRow(wb, 'People', row, row + 1);
      t.setCell(wb, 'People', row + 1, 2, t.labelOf(data, seat));
      const edited = await t.save(wb);
      const prep = await t.plan(edited);
      t.ok(prep.read.problems.some((p) => p.code === 'DUPLICATE_KEY') && prep.plan.counts.peopleSeatedAgain === 1 && prep.plan.counts.peopleAdded === 0 && t.codes(prep).length === 0,
        'the copy is a second seat for the SAME employee (matched by name), not a new person');
      const res = await t.rehearse(edited, {}, async (c) => ({
        employees: (await t.q('SELECT COUNT(*) n FROM hrms_employees WHERE full_name = ? AND company_id = ? AND deleted_at IS NULL', [person.name, t.companyId], c))[0].n,
        live: await t.q("SELECT is_primary FROM hrms_work_assignments WHERE employee_id = ? AND deleted_at IS NULL AND status = 'ACTIVE'", [person.employeeId], c),
      }));
      const had = data.people.filter((p) => p.employeeId === person.employeeId).length;
      t.ok(res.status === 'REHEARSED' && res.observed.live.length === had + 1 && res.observed.live.filter((a) => a.is_primary === 1).length <= 1, `one more live assignment (${had} -> ${res.observed?.live.length}) and no second primary`);

      const wb2 = await t.open(buf);
      t.copyRow(wb2, 'People', t.findKeyRow(wb2, 'People', person.key), t.findKeyRow(wb2, 'People', person.key) + 1);
      const same = await t.plan(await t.save(wb2));
      t.ok(same.plan.empty && same.problems.some((p) => p.code === 'PERSON_ALREADY_IN_SEAT'), 'a copied row left in the same seat adds nothing (a warning, no duplicate person)');
    },
  },
  {
    name: 'a person row whose Key was CLEARED is matched by person and seat: not added again, not ended by --delete-missing',
    async run(t) {
      const { buf, data } = await t.freshExport();
      const person = t.need(data.people[0], 'nobody holds a seat');
      const wb = await t.open(buf);
      t.setCell(wb, 'People', t.findKeyRow(wb, 'People', person.key), t.keyCol('People'), null);
      const prep = await t.plan(await t.save(wb), { deleteMissing: true });
      t.ok(t.codes(prep).length === 0 && prep.plan.empty && prep.plan.notices.some((n) => n.code === 'PERSON_MATCHED_BY_NAME'),
        'matched to their existing assignment: nothing added, and --delete-missing does not end them');
    },
  },
];
