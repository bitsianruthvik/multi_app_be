/**
 * A blank template has no provenance and no keys, so applying one is a pure create: allowed, but loud, and (on a company that
 * already has seats) only with --create-only. This case fills the template the way a new customer would and applies it in a
 * rehearsal, so it also exercises every create path at once: two departments (one under the other), role, seats (including a Day & night one),
 * the chart, a person with a generated code, duties on new roles, and questions.
 */
export const name = 'blank template';

/** Clear the grey example rows (any row with a cell that starts "Example:"), leaving the formulas alone. */
function clearExamples(t, wb) {
  for (const ws of wb.worksheets) {
    if (ws.name === t.S.SHEET.lists || ws.name === t.S.SHEET.start) continue;
    for (let r = 2; r <= ws.rowCount; r++) {
      let example = false;
      for (let c = 1; c <= ws.columnCount; c++) { const v = ws.getRow(r).getCell(c).value; if (typeof v === 'string' && v.startsWith(t.S.EXAMPLE_MARK)) example = true; }
      if (!example) continue;
      for (let c = 1; c <= ws.columnCount; c++) { const cell = ws.getRow(r).getCell(c); if (!(cell.value && typeof cell.value === 'object' && 'formula' in cell.value)) cell.value = null; }
    }
  }
}

export const cases = [
  {
    name: 'a filled-in blank template: every row is a CREATE, nothing that exists is touched, and the post-write re-check agrees',
    async run(t) {
      const env = await t.env();
      t.need(['general', 'day', 'night'].every((n) => env.shiftByName.has(n)) && env.dayShift && env.nightShift, 'the blank template names the shifts General, Day and Night, and this company does not have all three');
      const [head, lead, operator, line] = [t.name('Works Head'), t.name('Shift Lead'), t.name('Operator'), t.name('Line')];
      const dept = t.name('Dept');
      const person = `Person ${t.tag}`;
      const codesBefore = new Set(env.employees.map((e) => e.code));
      const seatsBefore = (await t.q('SELECT COUNT(*) n FROM hrms_positions WHERE company_id = ? AND deleted_at IS NULL AND status <> \'CLOSED\'', [t.companyId]))[0].n;

      const blank = await t.save(t.S.buildOrgWorkbook(null));
      const wb = await t.open(blank);
      clearExamples(t, wb);
      const S = wb.getWorksheet('Structure');
      const put = (r, level, title, count, shift, extra = {}) => {
        S.getRow(r).getCell(t.S.COL.firstLevel + level - 1).value = title;
        S.getRow(r).getCell(t.S.COL.count).value = count;
        S.getRow(r).getCell(t.S.COL.shift).value = shift;
        for (const [c, v] of Object.entries(extra)) S.getRow(r).getCell(Number(c)).value = v;
      };
      put(2, 1, head, 1, 'General', { [t.S.COL.department]: dept });
      put(3, 2, lead, 1, 'Day & night', { [t.S.COL.department]: line });
      put(4, 3, operator, 3, 'Day', { [t.S.COL.department]: line });
      t.appendDepartment(wb, { name: dept, type: 'Department' });
      t.appendDepartment(wb, { name: line, under: dept, type: 'Machine / area' });
      const P = wb.getWorksheet('People');
      P.getRow(2).getCell(1).value = person; P.getRow(2).getCell(2).value = t.S.seatLabel(2, operator); P.getRow(2).getCell(3).value = 'Day';
      const R = wb.getWorksheet('Responsibilities');
      R.getRow(2).getCell(1).value = t.S.seatLabel(2, operator); R.getRow(2).getCell(2).value = `Runs the line to the job card. ${t.tag}`;
      R.getRow(3).getCell(1).value = t.S.seatLabel(1, lead); R.getRow(3).getCell(2).value = `Signs the handover note. ${t.tag}`;
      const Q = wb.getWorksheet('Questions & doubts');
      Q.getRow(2).getCell(2).value = `Who covers the works head? ${t.tag}`;
      Q.getRow(3).getCell(1).value = t.S.seatLabel(1, lead); Q.getRow(3).getCell(2).value = `Is the night lead needed? ${t.tag}`;
      const filled = await t.save(wb);

      const prep = await t.plan(filled);
      t.ok(prep.read.kind === 'blank' && prep.refusals.length === 0, 'read as a blank template, and not refused');
      t.noErrors(prep);
      const c = prep.plan.counts;
      t.ok(c.seatsCreated === 3 && c.peopleAdded === 1 && c.responsibilitiesAdded === 2 && c.questionsAdded === 2 && c.departmentsCreated === 2 && c.rolesCreated === 3,
        `every row is a create (${t.summary(prep.plan)})`);
      t.ok(c.seatsMovedToNewManager === 0 && c.seatsRetitled === 0 && c.seatsClosed === 0 && c.peopleMovedToAnotherSeat === 0 && c.peopleEnded === 0, 'nothing that exists is changed or removed');
      const gate = t.A.gate(prep, { createOnly: false });
      t.ok(Number(seatsBefore) === 0 ? gate?.status !== 'CREATE_ONLY' : gate?.status === 'CREATE_ONLY', `onto a company that already has ${seatsBefore} seat(s) an --apply needs --create-only (${gate?.status ?? 'free to go'})`);

      const res = await t.rehearse(filled, { createOnly: true }, async (cn) => ({
        seats: await t.q("SELECT position_title, sanctioned_headcount n FROM hrms_positions WHERE company_id = ? AND position_title LIKE ? AND deleted_at IS NULL ORDER BY id", [t.companyId, `ZZ ${t.tag} %`], cn),
        manpower: (await t.q("SELECT COUNT(*) n FROM hrms_manpower_requirements m JOIN hrms_positions p ON p.id = m.position_id WHERE p.position_title = ? AND m.deleted_at IS NULL", [lead], cn))[0].n,
        edges: await t.q("SELECT a.position_title child, b.position_title parent FROM hrms_position_reporting_relationships r JOIN hrms_positions a ON a.id = r.from_position_id JOIN hrms_positions b ON b.id = r.to_position_id WHERE a.position_title LIKE ? AND r.deleted_at IS NULL ORDER BY a.id", [`ZZ ${t.tag} %`], cn),
        machine: (await t.q('SELECT m.department_type, p.name parent FROM hrms_departments m LEFT JOIN hrms_departments p ON p.id = m.parent_department_id WHERE m.company_id = ? AND m.name = ? AND m.deleted_at IS NULL', [t.companyId, line], cn))[0],
        seated: (await t.q('SELECT COUNT(*) n FROM hrms_positions p JOIN hrms_departments d ON d.id = p.department_id WHERE d.company_id = ? AND d.name = ? AND p.deleted_at IS NULL', [t.companyId, line], cn))[0].n,
        person: (await t.q("SELECT e.employee_code, w.status FROM hrms_employees e JOIN hrms_work_assignments w ON w.employee_id = e.id WHERE e.company_id = ? AND e.full_name = ?", [t.companyId, person], cn))[0],
        duties: (await t.q("SELECT COUNT(*) n FROM hrms_role_responsibility_assignments a JOIN hrms_roles r ON r.id = a.role_id WHERE r.company_id = ? AND r.title LIKE ? AND a.deleted_at IS NULL", [t.companyId, `ZZ ${t.tag} %`], cn))[0].n,
        questions: (await t.q('SELECT entity_type FROM hrms_open_points WHERE company_id = ? AND description LIKE ? ORDER BY id', [t.companyId, `%${t.tag}`], cn)).map((x) => x.entity_type),
      }));
      if (!t.ok(res.status === 'REHEARSED', `applied with --create-only, and the post-write re-check agreed (${t.why(res)})`)) return;
      const o = res.observed;
      t.ok(o.seats.length === 3 && Number(o.manpower) === 2, '3 seats were created; the Day & night one has its 2 per-shift requirements');
      t.ok(o.edges.map((e) => `${e.child}<-${e.parent}`).join() === `${lead}<-${head},${operator}<-${lead}`, `the chart is as typed (${o.edges.map((e) => `${e.child.replace(`ZZ ${t.tag} `, '')}<-${e.parent.replace(`ZZ ${t.tag} `, '')}`).join(', ')})`);
      t.ok(o.machine?.department_type === 'Machine / area' && o.machine.parent === dept && Number(o.seated) === 2, 'the machine was created as a department under its parent, and the two seats that name it sit in it');
      t.ok(o.person?.status === 'ACTIVE' && o.person.employee_code && !codesBefore.has(o.person.employee_code), `the person is seated, with a new employee code (${o.person?.employee_code})`);
      t.ok(Number(o.duties) === 2 && o.questions.join() === 'ORGANIZATION,POSITION', 'two duties on the new roles, and two questions (one general, one about a seat)');
    },
  },
];
