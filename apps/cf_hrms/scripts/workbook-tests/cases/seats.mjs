/**
 * Editing the Structure sheet: what each kind of edit becomes in the database. Cases 1 to 4 of the brief
 * (retitle, headcount, insert mid-outline, copy-paste) and the rest of what a person does to a chart.
 */
export const name = 'seats';

const DN = 'Day & night';
const liveManpower = (t, c, positionId) => t.q(
  `SELECT m.id, s.code, m.required_count AS n FROM hrms_manpower_requirements m JOIN hrms_shifts s ON s.id = m.shift_id
    WHERE m.position_id = ? AND m.deleted_at IS NULL AND (m.effective_to IS NULL OR m.effective_to >= CURDATE()) ORDER BY s.code`, [positionId], c);
const primaryEdges = (t, c, positionId) => t.q(
  `SELECT id, to_position_id, effective_from, effective_to, deleted_at FROM hrms_position_reporting_relationships
    WHERE company_id = ? AND from_position_id = ? AND relationship_type_id = (SELECT id FROM hrms_reporting_relationship_types WHERE company_id = ? AND code = 'PRIMARY_MANAGER' LIMIT 1)
    ORDER BY id`, [t.companyId, positionId, t.companyId], c);

export const cases = [
  {
    name: 'RETITLE a seat: its display title changes; its role, and the other seats of that role, do not',
    async run(t) {
      const { buf, data } = await t.freshExport();
      const seat = t.need(data.seats.find((s) => t.seatsOfRole(data, s) > 1) ?? data.seats[0], 'the company has no seats');
      const sharers = t.seatsOfRole(data, seat);
      const newTitle = `${seat.title} [${t.tag}]`;
      const others = await t.q('SELECT id, position_title FROM hrms_positions WHERE role_id = ? AND id <> ? AND deleted_at IS NULL ORDER BY id', [seat.roleId, seat.positionId]);
      const wb = await t.open(buf);
      t.setSeatTitle(wb, t.rowOfKey(wb, seat.key), newTitle);
      const edited = await t.save(wb);
      const prep = await t.plan(edited);
      t.ok(t.changed(prep.plan) === 'seatsRetitled' && prep.plan.counts.seatsRetitled === 1, `exactly one change: one seat retitled (${t.summary(prep.plan)})`);
      const res = await t.rehearse(edited, {}, async (c) => ({
        pos: (await t.q('SELECT position_title, role_id FROM hrms_positions WHERE id = ?', [seat.positionId], c))[0],
        role: (await t.q('SELECT title FROM hrms_roles WHERE id = ?', [seat.roleId], c))[0],
        others: await t.q('SELECT id, position_title FROM hrms_positions WHERE role_id = ? AND id <> ? AND deleted_at IS NULL ORDER BY id', [seat.roleId, seat.positionId], c),
        audit: (await t.q("SELECT before_json b, after_json a FROM hrms_audit_log WHERE entity_type = 'hrms_positions' AND entity_id = ? ORDER BY id DESC LIMIT 1", [seat.positionId], c))[0],
        reexport: (await t.freshExport(c)).data.seats.find((s) => s.key === seat.key)?.title,
      }));
      if (!t.ok(res.status === 'REHEARSED', `applied (${t.why(res)})`)) return;
      const o = res.observed;
      t.ok(o.pos.position_title === newTitle && o.pos.role_id === seat.roleId, 'position_title is the new title and the seat keeps its role');
      t.ok(o.role.title === seat.roleTitle, `the role keeps its title (${sharers} seat(s) share it)`);
      t.ok(JSON.stringify(o.others) === JSON.stringify(others), 'the other seats of that role are untouched');
      t.ok(o.audit && JSON.stringify(o.audit.a).includes(newTitle), 'an audit row records the change');
      t.ok(o.reexport === newTitle, 'a fresh export shows the new title');
    },
  },
  {
    name: 'CHANGE A HEADCOUNT: a single-shift seat, and a Day & night seat (both shifts follow)',
    async run(t) {
      const { buf, data } = await t.freshExport();
      const single = t.part(data.seats.find((s) => s.shift && s.shift !== DN), 'no single-shift seat');
      const dn = t.part(data.seats.find((s) => s.shift === DN && s.manpower.length === 2 && s.manpower[0].count === s.manpower[1].count), 'no Day & night seat with equal per-shift numbers');
      t.need(single || dn, 'no seat whose headcount can be changed');
      const wb = await t.open(buf);
      if (single) t.setCell(wb, 'Structure', t.rowOfKey(wb, single.key), t.COLS.count, single.count + 2);
      if (dn) t.setCell(wb, 'Structure', t.rowOfKey(wb, dn.key), t.COLS.count, dn.count + 1);
      const edited = await t.save(wb);
      const prep = await t.plan(edited);
      t.ok(prep.plan.counts.headcountsChanged === (single ? 1 : 0) + (dn ? 1 : 0) && t.changed(prep.plan) === 'headcountsChanged', `the headcounts are the only change (${t.summary(prep.plan)})`);
      const res = await t.rehearse(edited, {}, async (c) => ({
        s: single && (await t.q('SELECT sanctioned_headcount n FROM hrms_positions WHERE id = ?', [single.positionId], c))[0].n,
        d: dn && (await t.q('SELECT sanctioned_headcount n FROM hrms_positions WHERE id = ?', [dn.positionId], c))[0].n,
        dRows: dn && await liveManpower(t, c, dn.positionId),
        exported: (await t.freshExport(c)).data.seats.filter((s) => [single?.key, dn?.key].includes(s.key)).map((s) => [s.key, s.count]),
      }));
      if (!t.ok(res.status === 'REHEARSED', `applied (${t.why(res)})`)) return;
      const o = res.observed;
      if (single) t.ok(Number(o.s) === single.count + 2, `single-shift seat: sanctioned_headcount ${single.count} -> ${o.s}`);
      if (dn) t.ok(Number(o.d) === dn.count + 1 && o.dRows.length === 2 && o.dRows.every((r) => Number(r.n) === dn.count + 1),
        `Day & night seat: sanctioned ${o.d}, per-shift requirements ${o.dRows.map((r) => `${r.code}=${r.n}`).join(' ')}`);
      t.ok(o.exported.every(([key, n]) => n === (key === single?.key ? single.count + 2 : dn.count + 1)), 'a fresh export shows the new counts');
    },
  },
  {
    name: 'CHANGE A SHIFT: single -> Day & night creates the two per-shift requirements; Day & night -> one shift ends them',
    async run(t) {
      const env = await t.env();
      t.need(env.dayShift && env.nightShift, 'the company has no day and night shifts');
      const { buf, data } = await t.freshExport();
      const single = t.need(data.seats.find((s) => s.shift && s.shift !== DN && s.manpower.length === 0), 'no single-shift seat without requirements');
      const dn = t.need(data.seats.find((s) => s.shift === DN), 'no Day & night seat');
      const wb = await t.open(buf);
      t.setCell(wb, 'Structure', t.rowOfKey(wb, single.key), t.COLS.shift, DN);
      t.setCell(wb, 'Structure', t.rowOfKey(wb, dn.key), t.COLS.shift, env.nightShift.name);
      const edited = await t.save(wb);
      const prep = await t.plan(edited);
      t.ok(prep.plan.counts.seatShiftsChanged === 2 && t.changed(prep.plan) === 'seatShiftsChanged', `two shifts changed and nothing else (${t.summary(prep.plan)})`);
      const res = await t.rehearse(edited, {}, async (c) => ({
        s: (await t.q('SELECT default_shift_id d FROM hrms_positions WHERE id = ?', [single.positionId], c))[0].d,
        sRows: await liveManpower(t, c, single.positionId),
        d: (await t.q('SELECT p.default_shift_id d, s.code FROM hrms_positions p LEFT JOIN hrms_shifts s ON s.id = p.default_shift_id WHERE p.id = ?', [dn.positionId], c))[0],
        dRows: await liveManpower(t, c, dn.positionId),
      }));
      if (!t.ok(res.status === 'REHEARSED', `applied (${t.why(res)})`)) return;
      const o = res.observed;
      t.ok(o.s === null && o.sRows.length === 2, `single -> D&N: the default shift is cleared and ${o.sRows.length} per-shift requirements exist (${o.sRows.map((r) => `${r.code}=${r.n}`)})`);
      t.ok(o.d.code === env.nightShift.code && o.dRows.length === 0, `D&N -> ${env.nightShift.name}: the default shift is ${o.d.code} and the requirements are ended (${o.dRows.length} live)`);
    },
  },
  {
    name: 'INSERT a new seat mid-outline (blank key): it is created; the rows that slid down are not touched',
    async run(t) {
      const env = await t.env();
      const shift = t.need(env.shifts[0]?.name, 'the company has no shifts');
      const { buf, data } = await t.freshExport();
      const wb = await t.open(buf);
      const parent = t.need(data.seats.find((s, i) => i > 0 && data.seats.some((c) => c.parentPositionId === s.positionId)
        && (t.levelOfRow(wb, t.rowOfKey(wb, s.key)) ?? 10) < 10), 'no seat with children to insert a seat under');
      const parentRow = t.rowOfKey(wb, parent.key);
      const title = t.name('seat');
      const dept = t.name('Dept');
      const loc = env.locationByName.values().next().value?.name ?? '';
      t.insertSeat(wb, parentRow + 1, { level: t.levelOfRow(wb, parentRow) + 1, title, count: 2, shift, department: dept, location: loc });
      const edited = await t.save(wb);
      const prep = await t.plan(edited);
      t.ok(t.codes(prep).length === 0, `no errors (${t.codes(prep)})`);
      t.ok(t.changed(prep.plan) === 'departmentsCreated,rolesCreated,seatsCreated', `only a seat, its new role and its new department are planned (${t.changed(prep.plan)}); the ${data.seats.length} rows that slid down are not touched`);
      const res = await t.rehearse(edited, {}, async (c, info) => {
        const id = Number(info.created[`structure:${parentRow + 1}`].split(':')[1]);
        const [run] = await t.q('SELECT findings_json f FROM hrms_import_runs ORDER BY id DESC LIMIT 1', [], c);
        const range = (typeof run.f === 'string' ? JSON.parse(run.f) : run.f).auditRows;
        return {
          id,
          pos: (await t.q('SELECT position_code, position_title, role_id, department_id, sanctioned_headcount n, status, effective_from FROM hrms_positions WHERE id = ?', [id], c))[0],
          edge: await t.q('SELECT to_position_id, is_primary, scope_type, effective_from FROM hrms_position_reporting_relationships WHERE from_position_id = ? AND deleted_at IS NULL', [id], c),
          role: (await t.q('SELECT title, status FROM hrms_roles WHERE id = (SELECT role_id FROM hrms_positions WHERE id = ?)', [id], c))[0],
          dept: (await t.q('SELECT name FROM hrms_departments WHERE id = (SELECT department_id FROM hrms_positions WHERE id = ?)', [id], c))[0],
          audit: await t.q('SELECT entity_type, action FROM hrms_audit_log WHERE company_id = ? AND id > ? AND id <= ? ORDER BY id', [t.companyId, range.after, range.upTo], c),
          reexport: (await t.freshExport(c)).data,
        };
      });
      if (!t.ok(res.status === 'REHEARSED', `applied (${t.why(res)})`)) return;
      const o = res.observed;
      t.ok(o.pos.position_title === title && Number(o.pos.n) === 2 && o.pos.status === 'ACTIVE', `new position ${o.pos.position_code} "${o.pos.position_title}", headcount ${o.pos.n}, ${o.pos.status}`);
      t.ok(o.edge.length === 1 && o.edge[0].to_position_id === parent.positionId && o.edge[0].is_primary === 1 && o.edge[0].scope_type === 'GENERAL',
        `it reports to the right seat ("${parent.title}") by a PRIMARY line`);
      t.ok(o.role.title === title && o.role.status === 'ACTIVE' && o.dept.name === dept, 'a new role and a new department were created for it');
      t.ok(o.audit.some((a) => a.entity_type === 'hrms_positions' && a.action === 'CREATE') && o.audit.length >= 4,
        `the apply's audit rows are traceable by the range kept on its import run (${o.audit.length} rows: ${[...new Set(o.audit.map((a) => a.entity_type))].join(', ')})`);
      const s = o.reexport.seats.find((x) => x.key === `pos:${o.id}`);
      t.ok(s && o.reexport.seats[s.parent].key === parent.key, 'a fresh export lists it under the same parent');
    },
  },
  {
    name: 'INSERT at the very top: every Ref below slides down by one, and only the new seat is planned',
    async run(t) {
      const env = await t.env();
      const shift = t.need(env.shifts[0]?.name, 'the company has no shifts');
      const { buf, data } = await t.freshExport();
      const wb = await t.open(buf);
      const first = data.seats[0];
      const row = t.rowOfKey(wb, first.key);
      const level = t.levelOfRow(wb, row);
      t.need(level < 10, 'the first seat is already at the deepest level');
      t.insertSeat(wb, row + 1, { level: level + 1, title: t.name('second seat'), count: 1, shift });
      const prep = await t.plan(await t.save(wb));
      t.ok(t.codes(prep).length === 0, `no errors (${t.codes(prep)})`);
      t.ok(t.changed(prep.plan) === 'rolesCreated,seatsCreated', `${data.seats.length} rows slid down by one and ONLY the new seat is planned (${t.changed(prep.plan)})`);
      t.ok(prep.plan.people.move.length === 0 && prep.plan.responsibilities.move.length === 0 && prep.plan.questions.update.length === 0 && prep.plan.people.employeesUpdate.length === 0,
        'no person, duty or question moved because its Ref number changed');
      const labelWarnings = prep.problems.filter((p) => p.severity === 'warning' && /AMBIGUOUS|STALE/.test(p.code));
      t.note(`${labelWarnings.length} seat-label warning(s), e.g. ${labelWarnings[0]?.message.slice(0, 160) ?? '(none)'}`);
    },
  },
  {
    name: 'COPY-PASTE an existing row to make a similar seat (duplicate key): a new seat, same role, original untouched',
    async run(t) {
      const { buf, data } = await t.freshExport();
      const wb = await t.open(buf);
      const leaf = t.need(data.seats.find((s) => t.isLeaf(data, s) && s.parentPositionId != null && s.contextLinks.length > 0 && t.seatsOfRole(data, s) > 1)
        ?? data.seats.find((s) => t.isLeaf(data, s) && s.parentPositionId != null), 'no leaf seat to copy');
      const row = t.rowOfKey(wb, leaf.key);
      t.copyRow(wb, 'Structure', row, row + 1);
      const edited = await t.save(wb);
      const prep = await t.plan(edited);
      t.ok(prep.read.problems.some((p) => p.code === 'DUPLICATE_KEY' && p.severity === 'info'), 'the repeated key is reported as a finding, not an error');
      t.ok(t.changed(prep.plan) === 'seatsCreated' && prep.plan.counts.seatsCreated === 1, `one NEW seat, no new role, the original untouched (${t.summary(prep.plan)})`);
      const sharedBefore = t.seatsOfRole(data, leaf);
      const res = await t.rehearse(edited, {}, async (c, info) => {
        const id = Number(info.created[`structure:${row + 1}`].split(':')[1]);
        return {
          copy: (await t.q('SELECT position_code, position_title, role_id FROM hrms_positions WHERE id = ?', [id], c))[0],
          orig: (await t.q('SELECT position_code, position_title, role_id FROM hrms_positions WHERE id = ?', [leaf.positionId], c))[0],
          links: await t.q('SELECT work_context_id FROM hrms_position_work_contexts WHERE position_id = ? AND deleted_at IS NULL', [id], c),
          edge: await t.q('SELECT to_position_id FROM hrms_position_reporting_relationships WHERE from_position_id = ? AND deleted_at IS NULL AND effective_to IS NULL', [id], c),
          seatsOfRole: (await t.q('SELECT COUNT(*) n FROM hrms_positions WHERE role_id = ? AND deleted_at IS NULL', [leaf.roleId], c))[0].n,
        };
      });
      if (!t.ok(res.status === 'REHEARSED', `applied (${t.why(res)})`)) return;
      const o = res.observed;
      t.ok(o.copy.role_id === leaf.roleId && o.orig.role_id === leaf.roleId, `the copy shares the original's role ("${leaf.roleTitle}"), so it shares its duties: nothing was forked`);
      t.ok(o.copy.position_code && o.copy.position_code !== o.orig.position_code && o.copy.position_title === leaf.title, `it has its own position code (${o.copy.position_code}, the original has ${o.orig.position_code}) and the same title`);
      t.ok(o.links.length === leaf.contextLinks.length && o.edge[0]?.to_position_id === leaf.parentPositionId, `the same machines (${o.links.length}) and the same manager as the original`);
      t.ok(Number(o.seatsOfRole) === sharedBefore + 1, 'the role now has exactly one more seat');
    },
  },
  {
    name: 'COPY-PASTE and give the copy a different title: a new seat AND a new role',
    async run(t) {
      const { buf, data } = await t.freshExport();
      const wb = await t.open(buf);
      const leaf = t.need(data.seats.find((s) => t.isLeaf(data, s) && s.parentPositionId != null), 'no leaf seat to copy');
      const row = t.rowOfKey(wb, leaf.key);
      t.copyRow(wb, 'Structure', row, row + 1);
      t.setSeatTitle(wb, row + 1, `${leaf.title} ${t.name('special')}`);
      const prep = await t.plan(await t.save(wb));
      t.ok(t.changed(prep.plan) === 'rolesCreated,seatsCreated', `a new seat and a new role, because the title is new (${t.changed(prep.plan)})`);
    },
  },
  {
    name: "CHANGE a seat's department, location and machine list",
    async run(t) {
      const { buf, data } = await t.freshExport();
      const seat = t.need(data.seats.find((s) => s.contextLinks.length === 1), 'no seat with exactly one machine');
      const machineB = t.need(data.machines.find((m) => !seat.contextLinks.some((l) => l.contextId === m.id) && !m.name.includes(',')), 'no second machine to swap in');
      const dept = t.name('Dept');
      const loc = t.name('Loc');
      const wb = await t.open(buf);
      const row = t.rowOfKey(wb, seat.key);
      t.setCell(wb, 'Structure', row, t.COLS.department, dept);
      t.setCell(wb, 'Structure', row, t.COLS.location, loc);
      t.setCell(wb, 'Structure', row, t.COLS.machines, machineB.name);
      const edited = await t.save(wb);
      const prep = await t.plan(edited);
      t.ok(t.changed(prep.plan) === 'departmentsCreated,locationsCreated,seatDepartmentsChanged,seatLocationsChanged,seatMachinesChanged', `department, location and machine list changed, and the two new names are new masters (${t.changed(prep.plan)})`);
      const res = await t.rehearse(edited, {}, async (c) => ({
        pos: (await t.q('SELECT d.name dn, l.name ln FROM hrms_positions p LEFT JOIN hrms_departments d ON d.id = p.department_id LEFT JOIN hrms_locations l ON l.id = p.location_id WHERE p.id = ?', [seat.positionId], c))[0],
        links: await t.q('SELECT work_context_id, is_primary FROM hrms_position_work_contexts WHERE position_id = ? AND deleted_at IS NULL', [seat.positionId], c),
      }));
      if (!t.ok(res.status === 'REHEARSED', `applied (${t.why(res)})`)) return;
      t.ok(res.observed.pos.dn === dept && res.observed.pos.ln === loc, `department "${res.observed.pos.dn}", location "${res.observed.pos.ln}"`);
      t.ok(res.observed.links.length === 1 && res.observed.links[0].work_context_id === machineB.id && res.observed.links[0].is_primary === 1, `the machine is now "${machineB.name}" (primary), the old link removed`);
    },
  },
  {
    name: 'MOVE a seat to a new manager by outdenting it, then MOVE IT BACK the same day (ends the old line, reopens it)',
    async run(t) {
      const { buf, data } = await t.freshExport();
      const wb = await t.open(buf);
      // the LAST child of its parent, so outdenting it is exactly one move (an earlier sibling would drag the ones below it along)
      const leaf = t.need(data.seats.find((s, i) => i > 0 && t.isLeaf(data, s) && s.parent != null && data.seats[s.parent].parent != null && t.isLastChild(data, s)), 'no last-child leaf with a grandparent');
      const parent = data.seats[leaf.parent];
      const grand = data.seats[parent.parent];
      const row = t.rowOfKey(wb, leaf.key);
      const level = t.levelOfRow(wb, row);
      const ws = wb.getWorksheet('Structure');
      const cell = ws.getRow(row).getCell(t.S.COL.firstLevel + level - 1).value;
      ws.getRow(row).getCell(t.S.COL.firstLevel + level - 1).value = null;
      ws.getRow(row).getCell(t.S.COL.firstLevel + level - 2).value = cell; // cut the title one Level column to the left
      const edited = await t.save(wb);
      const prep = await t.plan(edited);
      t.ok(t.codes(prep).length === 0 && t.changed(prep.plan) === 'seatsMovedToNewManager' && prep.plan.counts.seatsMovedToNewManager === 1, `exactly one change: one seat moved to a new manager (${t.summary(prep.plan)})`);
      t.ok(prep.plan.seats.update[0]?.set.parent?.from === parent.key && prep.plan.seats.update[0]?.set.parent?.to === grand.key, `from "${parent.title}" to the grandparent "${grand.title}"`);

      // two applies in ONE open transaction, so the second sees the first (the connection is the case's own)
      const conn = t.conn;
      await conn.beginTransaction();
      try {
        const step = async (buffer) => {
          const p = await t.plan(buffer);
          if (p.refusals.length || t.codes(p).length) throw new Error(`not applicable: ${t.codes(p)} ${p.refusals}`);
          return t.A.executePlan({ conn, plan: p.plan, loaded: p.loaded, env: p.env, requestId: 'workbook-test-chain' });
        };
        await step(edited);
        const e1 = await primaryEdges(t, conn, leaf.positionId);
        const open1 = e1.filter((e) => e.deleted_at === null && e.effective_to === null);
        t.ok(e1.length === 2 && e1[0].effective_to !== null && open1.length === 1 && open1[0].to_position_id === grand.positionId, 'the old PRIMARY line is ENDED (not overwritten) and a new one starts: history keeps both');

        // now cut the row and paste it back as the first child of its old manager, from a fresh export taken inside the same transaction
        const second = await t.freshExport(conn);
        const wb2 = await t.open(second.buf);
        t.deleteRow(wb2, 'Structure', t.rowOfKey(wb2, leaf.key));
        const parentRow = t.rowOfKey(wb2, parent.key);
        t.insertSeat(wb2, parentRow + 1, { level: t.levelOfRow(wb2, parentRow) + 1, title: leaf.title, count: leaf.count, shift: leaf.shift, department: leaf.department, location: leaf.location, machines: leaf.machines.join(', ') });
        wb2.getWorksheet('Structure').getRow(parentRow + 1).getCell(t.COLS.key).value = leaf.key;
        const back = await t.save(wb2);
        const p2 = await t.plan(back);
        t.ok(t.codes(p2).length === 0 && p2.plan.counts.seatsMovedToNewManager === 1 && p2.plan.counts.seatsCreated === 0, 'moving it back is one move, not a delete and a create');
        await step(back);
        const e2 = await primaryEdges(t, conn, leaf.positionId);
        const open2 = e2.filter((e) => e.deleted_at === null && e.effective_to === null);
        t.ok(open2.length === 1 && open2[0].to_position_id === parent.positionId, `back under "${parent.title}": exactly one open PRIMARY line, to the original manager`);
        t.ok(open2[0]?.id === e1[0].id, 'the ORIGINAL line was reopened (the unique key would refuse a second identical one)');
        t.ok(e2.filter((e) => e.deleted_at !== null).length === 1, 'the line that only ever existed today is soft-deleted, not left as a one-day record');
        const after = (await t.freshExport(conn)).data;
        const seat = after.seats.find((x) => x.key === leaf.key);
        t.ok(seat && after.seats[seat.parent].key === parent.key, 'a fresh export has the seat under its original manager again');
      } finally { await conn.rollback(); }
    },
  },
  {
    name: 'CUT a seat and PASTE it elsewhere (same key, new place): one move, not a delete and a create',
    async run(t) {
      const { buf, data } = await t.freshExport();
      const wb = await t.open(buf);
      const leaf = t.need(data.seats.find((s, i) => i > 1 && t.isLeaf(data, s) && s.parentPositionId != null), 'no leaf seat');
      const other = t.need(data.seats.find((s) => s.key !== leaf.key && s.positionId !== leaf.parentPositionId
        && (t.levelOfRow(wb, t.rowOfKey(wb, s.key)) ?? 10) < 10), 'no other seat to move it under');
      t.deleteRow(wb, 'Structure', t.rowOfKey(wb, leaf.key));
      const orow = t.rowOfKey(wb, other.key);
      t.insertSeat(wb, orow + 1, { level: t.levelOfRow(wb, orow) + 1, title: leaf.title, count: leaf.count, shift: leaf.shift, department: leaf.department, location: leaf.location, machines: leaf.machines.join(', ') });
      wb.getWorksheet('Structure').getRow(orow + 1).getCell(t.COLS.key).value = leaf.key;
      const prep = await t.plan(await t.save(wb));
      t.ok(t.codes(prep).length === 0 && t.changed(prep.plan) === 'seatsMovedToNewManager' && prep.plan.seats.update[0].set.parent.to === other.key, `moved under "${other.title}" as ONE move`);
    },
  },
  {
    name: 'NOTES are not saved (and it says so); a cleared headcount changes nothing',
    async run(t) {
      const { buf, data } = await t.freshExport();
      const wb = await t.open(buf);
      const withNote = t.part(data.seats.find((s) => s.notes), 'no seat has a note');
      const plain = t.need(data.seats.find((s) => !s.notes && s.key !== withNote?.key), 'every seat has a note');
      const cleared = t.need(data.seats.find((s) => s.key !== plain.key && s.key !== withNote?.key), 'too few seats');
      if (withNote) t.setCell(wb, 'Structure', t.rowOfKey(wb, withNote.key), t.COLS.notes, `${withNote.notes} Edited by hand.`);
      t.setCell(wb, 'Structure', t.rowOfKey(wb, plain.key), t.COLS.notes, 'A note typed by a person.');
      t.setCell(wb, 'Structure', t.rowOfKey(wb, cleared.key), t.COLS.count, null);
      const prep = await t.plan(await t.save(wb));
      const expected = withNote ? 2 : 1;
      t.ok(prep.plan.empty && prep.plan.notices.filter((n) => n.code === 'NOTES_NOT_SAVED').length === expected, `${expected} edited Notes cell(s) are reported as not saved, and change nothing`);
      t.ok(t.warns(prep).includes('COUNT_KEPT') && prep.plan.empty, 'a cleared "How many people?" is a warning, and the seat keeps its headcount');
    },
  },
];
