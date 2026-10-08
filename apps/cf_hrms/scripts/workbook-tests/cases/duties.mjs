/**
 * Editing the Responsibilities sheet. A duty belongs to a ROLE and several seats share one role, so a row written against a
 * seat lands on that seat's role (every seat of it sees it), and rewording a duty that other roles share must fork it for this
 * role instead of changing theirs (case 6 of the brief: "must not fork that role silently").
 */
export const name = 'duties';

const DUTY_TEXT = (t) => `ZZ ${t.tag} duty: confirm the round trip puts this on the role, not on one seat.`;
const defsUsedByRoles = (t, n) => t.q(
  `SELECT responsibility_definition_id d, COUNT(DISTINCT role_id) c FROM hrms_role_responsibility_assignments
    WHERE company_id = ? AND deleted_at IS NULL GROUP BY responsibility_definition_id HAVING ${n === 1 ? 'c = 1' : 'c > 1'}`, [t.companyId]);

export const cases = [
  {
    name: 'ADD a duty against a seat: it goes on that seat\'s ROLE (shared by every seat of it) and no role is forked',
    async run(t) {
      const { buf, data } = await t.freshExport();
      const seat = t.need(data.seats.find((s) => t.seatsOfRole(data, s) >= 3) ?? data.seats.find((s) => t.seatsOfRole(data, s) >= 2) ?? data.seats[0], 'no seats');
      const sharers = t.seatsOfRole(data, seat);
      const text = DUTY_TEXT(t);
      const rolesBefore = (await t.q('SELECT COUNT(*) n FROM hrms_roles WHERE company_id = ? AND deleted_at IS NULL', [t.companyId]))[0].n;
      const wb = await t.open(buf);
      t.appendRow(wb, 'Responsibilities', [t.labelOf(data, seat), text]);
      const edited = await t.save(wb);
      const prep = await t.plan(edited);
      t.ok(prep.plan.counts.responsibilitiesAdded === 1 && prep.plan.responsibilities.add[0]?.sharedBy === sharers && t.changed(prep.plan) === 'responsibilitiesAdded',
        `added to the ROLE "${seat.roleTitle}", shared by ${sharers} seat(s), and the plan says so`);
      const res = await t.rehearse(edited, {}, async (c) => ({
        rows: await t.q('SELECT a.role_id FROM hrms_role_responsibility_assignments a JOIN hrms_responsibility_definitions d ON d.id = a.responsibility_definition_id WHERE d.description = ? AND a.deleted_at IS NULL', [text], c),
        roles: (await t.q('SELECT COUNT(*) n FROM hrms_roles WHERE company_id = ? AND deleted_at IS NULL', [t.companyId], c))[0].n,
        reexport: (await t.freshExport(c)).data.responsibilities.filter((r) => r.text === text),
      }));
      if (!t.ok(res.status === 'REHEARSED', `applied (${t.why(res)})`)) return;
      t.ok(res.observed.rows.length === 1 && res.observed.rows[0].role_id === seat.roleId, "one assignment, on the seat's existing role");
      t.ok(Number(res.observed.roles) === Number(rolesBefore), 'no role was created or forked');
      t.ok(res.observed.reexport.length === 1 && res.observed.reexport[0].roleId === seat.roleId, "a fresh export shows it once, against the role's first seat");
    },
  },
  {
    name: 'REWORD a duty whose wording other roles SHARE: this role gets new wording, the others keep theirs',
    async run(t) {
      const { buf, data } = await t.freshExport();
      const shared = t.need((await defsUsedByRoles(t, 2))[0], 'no duty wording is shared by two roles');
      const row = t.need(data.responsibilities.find((r) => r.defId === shared.d && r.overrideId == null), 'the shared duty is not on a seat in the workbook');
      const others = data.responsibilities.filter((r) => r.defId === shared.d && r.key !== row.key);
      const wb = await t.open(buf);
      t.setCell(wb, 'Responsibilities', t.findKeyRow(wb, 'Responsibilities', row.key), 2, `${row.text} (reworded ${t.tag})`);
      const edited = await t.save(wb);
      const prep = await t.plan(edited);
      t.ok(prep.plan.counts.responsibilitiesReworded === 1 && prep.plan.responsibilities.retext[0]?.defShared === true, `the wording is shared by ${shared.c} roles, and the plan says it forks`);
      const res = await t.rehearse(edited, {}, async (c) => ({
        old: (await t.q('SELECT description FROM hrms_responsibility_definitions WHERE id = ?', [row.defId], c))[0].description,
        mine: await t.q('SELECT responsibility_definition_id d FROM hrms_role_responsibility_assignments WHERE role_id = ? AND deleted_at IS NULL AND sequence = ?', [row.roleId, row.sequence], c),
        theirs: await t.q('SELECT role_id FROM hrms_role_responsibility_assignments WHERE responsibility_definition_id = ? AND deleted_at IS NULL', [row.defId], c),
      }));
      if (!t.ok(res.status === 'REHEARSED', `applied (${t.why(res)})`)) return;
      t.ok(res.observed.old.trim() === row.text.trim() || res.observed.old.replace(/\s+/g, ' ').trim() === row.text, 'the shared definition keeps its original wording');
      t.ok(res.observed.mine.some((m) => m.d !== row.defId), 'this role now points at a NEW definition');
      t.ok(res.observed.theirs.length === others.length && !res.observed.theirs.some((x) => x.role_id === row.roleId), `the other ${others.length} role(s) still use the old wording`);
    },
  },
  {
    name: 'REWORD a duty used by ONE role (changed in place); re-adding a duty the role already has adds nothing',
    async run(t) {
      const { buf, data } = await t.freshExport();
      const own = new Set((await defsUsedByRoles(t, 1)).map((r) => r.d));
      const row = t.need(data.responsibilities.find((r) => r.overrideId == null && own.has(r.defId) && data.responsibilities.filter((x) => x.roleId === r.roleId).length >= 2), 'no role has an unshared duty and a second one');
      const sibling = data.responsibilities.find((r) => r.roleId === row.roleId && r.key !== row.key);
      const seat = data.seats[row.seat];
      const wb = await t.open(buf);
      t.setCell(wb, 'Responsibilities', t.findKeyRow(wb, 'Responsibilities', row.key), 2, `${row.text} Reworded in place ${t.tag}.`);
      t.appendRow(wb, 'Responsibilities', [t.labelOf(data, seat), sibling.text]);
      const edited = await t.save(wb);
      const prep = await t.plan(edited);
      t.ok(prep.plan.counts.responsibilitiesReworded === 1 && prep.plan.responsibilities.retext[0]?.defShared === false, "reworded; the definition is this role's own");
      t.ok(prep.plan.counts.responsibilitiesAdded === 0 && prep.plan.notices.some((n) => n.code === 'DUTY_ALREADY_THERE'), 'a duty the role already has adds nothing, and says so');
      const res = await t.rehearse(edited, {}, async (c) => ({
        d: (await t.q('SELECT description FROM hrms_responsibility_definitions WHERE id = ?', [row.defId], c))[0].description,
      }));
      t.ok(res.status === 'REHEARSED' && res.observed.d === `${row.text} Reworded in place ${t.tag}.`, `the definition was changed in place (${res.status === 'REHEARSED' ? 'yes' : t.why(res)})`);
    },
  },
  {
    name: 'MOVE a duty row to a seat of a DIFFERENT role: removed from the first role, added to the second',
    async run(t) {
      const { buf, data } = await t.freshExport();
      const row = t.need(data.responsibilities.find((r) => r.overrideId == null), 'no duties');
      const target = t.need(data.seats.find((s) => s.roleId !== row.roleId), 'every seat has the same role');
      const wb = await t.open(buf);
      t.setCell(wb, 'Responsibilities', t.findKeyRow(wb, 'Responsibilities', row.key), 1, t.labelOf(data, target));
      const edited = await t.save(wb);
      const prep = await t.plan(edited);
      t.ok(prep.plan.counts.responsibilitiesMoved === 1 && t.changed(prep.plan) === 'responsibilitiesMoved', `planned as one move between roles (${t.summary(prep.plan)})`);
      const res = await t.rehearse(edited, {}, async (c) => ({
        from: await t.q('SELECT id FROM hrms_role_responsibility_assignments WHERE role_id = ? AND responsibility_definition_id = ? AND deleted_at IS NULL', [row.roleId, row.defId], c),
        to: await t.q('SELECT id FROM hrms_role_responsibility_assignments WHERE role_id = ? AND responsibility_definition_id = ? AND deleted_at IS NULL', [target.roleId, row.defId], c),
      }));
      t.ok(res.status === 'REHEARSED' && res.observed.from.length === 0 && res.observed.to.length === 1, `removed from the first role, added to the second (${res.status === 'REHEARSED' ? 'yes' : t.why(res)})`);
    },
  },
  {
    name: 'COPY a duty row to another seat: of the SAME role it adds nothing; of a different role it assigns the same wording there',
    async run(t) {
      const { buf, data } = await t.freshExport();
      const duty = t.need(data.responsibilities.find((r) => r.overrideId == null && t.seatsOfRole(data, data.seats[r.seat]) >= 2), 'no duty on a role with two seats');
      const shared = data.seats[duty.seat];
      const same = t.need(data.seats.find((s) => s.roleId === shared.roleId && s.key !== shared.key), 'no second seat in that role');
      const diff = t.need(data.seats.find((s) => s.roleId !== shared.roleId), 'every seat has the same role');
      const wb = await t.open(buf);
      const row = t.findKeyRow(wb, 'Responsibilities', duty.key);
      t.copyRow(wb, 'Responsibilities', row, row + 1);
      t.setCell(wb, 'Responsibilities', row + 1, 1, t.labelOf(data, same));
      const p1 = await t.plan(await t.save(wb));
      t.ok(p1.plan.empty && p1.plan.notices.some((n) => n.code === 'DUTY_ALREADY_THERE'), 'same role, same words: nothing added (the role already has the duty)');
      const wb2 = await t.open(buf);
      t.copyRow(wb2, 'Responsibilities', t.findKeyRow(wb2, 'Responsibilities', duty.key), t.findKeyRow(wb2, 'Responsibilities', duty.key) + 1);
      t.setCell(wb2, 'Responsibilities', t.findKeyRow(wb2, 'Responsibilities', duty.key) + 1, 1, t.labelOf(data, diff));
      const p2 = await t.plan(await t.save(wb2));
      t.ok(p2.plan.counts.responsibilitiesAdded === 1 && p2.plan.responsibilities.add[0].role.id === diff.roleId && p2.plan.responsibilities.add[0].defId === duty.defId,
        'a different role: the SAME definition (existing wording) is assigned to that role too');
    },
  },
  {
    name: 'the order of a role\'s duties is not saved from the sheet, and a swap says so',
    async run(t) {
      const { buf, data } = await t.freshExport();
      const role = t.need(data.responsibilities.find((r) => data.responsibilities.filter((x) => x.roleId === r.roleId && x.overrideId == null).length >= 3), 'no role has three duties').roleId;
      const mine = data.responsibilities.filter((r) => r.roleId === role && r.overrideId == null);
      const wb = await t.open(buf);
      const ra = t.findKeyRow(wb, 'Responsibilities', mine[0].key);
      const rb = t.findKeyRow(wb, 'Responsibilities', mine[1].key);
      const [ta, tb] = [t.getCell(wb, 'Responsibilities', ra, 2), t.getCell(wb, 'Responsibilities', rb, 2)];
      const [ka, kb] = [t.getCell(wb, 'Responsibilities', ra, 3), t.getCell(wb, 'Responsibilities', rb, 3)];
      t.setCell(wb, 'Responsibilities', ra, 2, tb); t.setCell(wb, 'Responsibilities', ra, 3, kb);
      t.setCell(wb, 'Responsibilities', rb, 2, ta); t.setCell(wb, 'Responsibilities', rb, 3, ka);
      const prep = await t.plan(await t.save(wb));
      t.ok(prep.plan.empty && prep.plan.notices.some((n) => n.code === 'DUTY_ORDER_NOT_SAVED'), 'the rows swapped places: nothing changes, and the notice says the order is not saved');
    },
  },
];
