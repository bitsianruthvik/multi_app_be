/**
 * The Departments sheet: one tree of departments, processes, machines and shared crews (a machine is a department with a
 * Type label of "Machine / area"; a shared crew is a department marked Shared that SERVES others). A seat sits in exactly
 * one of them.
 *
 * What a person can do here, and what must be refused:
 *   - add a department (under another, of any Type), seat someone in it; add a tree in any row order
 *   - make a department a shared crew and say which departments it serves; take one serves row away; stop sharing
 *   - move a department under another (or to the top), including two that trade places; rename or retype one
 *     (the seats in it follow BY KEY: their cells may still say the old name)
 *   - remove one, only with --delete-missing, and only when nothing is in it or under it, naming what is in the way
 *   - REFUSED: a cycle, a department under itself, a shared crew serving itself, a serves list on a department that is not
 *     shared, a parent that is not on the sheet, and a workbook from an older layout (told to export a fresh one)
 *
 * Nothing is hard-coded: every case picks from a fresh export. Nothing is left behind: applies are rehearsed and rolled back, and
 * the two cases that need a second apply on top of the first run both inside one transaction that is rolled back.
 */
export const name = 'departments';

const descendants = (data, key) => {
  const out = new Set();
  const walk = (k) => { for (const d of data.departments) if (d.parentKey === k && !out.has(d.key)) { out.add(d.key); walk(d.key); } };
  walk(key);
  return out;
};
const rowOf = (t, wb, dept) => t.findKeyRow(wb, 'Departments', dept.key);
const live = (t, c, deptId) => t.q('SELECT serves_department_id s FROM hrms_department_serves WHERE department_id = ? AND deleted_at IS NULL ORDER BY serves_department_id', [deptId], c);
const ids = (rows) => rows.map((r) => Number(r.s)).sort((a, b) => a - b).join();
const idsOf = (depts) => depts.map((d) => d.id).sort((a, b) => a - b).join();

/** Run `fn` inside a transaction that is always rolled back: for the cases that apply twice and look in between. */
async function inTransaction(t, fn) {
  await t.conn.beginTransaction();
  try { return await fn(); } finally { await t.conn.rollback(); }
}
/** Apply a workbook inside the open transaction (no convergence check: the caller looks at what it wants). */
async function step(t, buffer, flags = {}) {
  const p = await t.plan(buffer, flags);
  if (p.refusals.length || t.codes(p).length) throw new Error(`not applicable: ${t.codeList(p)} ${p.refusals}`);
  await t.A.executePlan({ conn: t.conn, plan: p.plan, loaded: p.loaded, env: p.env, requestId: 'workbook-test-chain' });
  return p;
}

export const cases = [
  {
    name: 'ADD a machine department under a process, and seat someone in it',
    async run(t) {
      const { buf, data } = await t.freshExport();
      const parent = t.need(data.departments.find((d) => !d.shared) ?? data.departments[0], 'no departments');
      const seat = t.need(data.seats.find((s) => t.peopleIn(data, s).length) ?? data.seats[0], 'no seats');
      const machine = t.name('Machine');
      const wb = await t.open(buf);
      t.appendDepartment(wb, { name: machine, under: parent.name, type: 'Machine / area' });
      t.setCell(wb, 'Structure', t.rowOfKey(wb, seat.key), t.COLS.department, machine);
      const edited = await t.save(wb);
      const prep = await t.plan(edited);
      t.ok(t.codes(prep).length === 0 && t.changed(prep.plan) === 'departmentsCreated,seatDepartmentsChanged', `one department created and one seat moved into it, nothing else (${t.codeList(prep) || t.changed(prep.plan)})`);
      const res = await t.rehearse(edited, {}, async (c) => {
        const after = (await t.freshExport(c)).data;
        return {
          dept: after.departments.find((d) => d.name === machine),
          seat: after.seats.find((s) => s.key === seat.key),
          people: after.people.filter((p) => p.seatKey === seat.key).length,
          count: after.departments.length,
        };
      });
      if (!t.ok(res.status === 'REHEARSED', `applied, and the post-write re-check agreed (${t.why(res)})`)) return;
      const o = res.observed;
      t.ok(o.dept?.under === parent.name && o.dept.type === 'Machine / area' && !o.dept.shared, `the new department sits under "${parent.name}" with Type "Machine / area"`);
      t.ok(o.seat?.department === machine, `the seat "${seat.title}" now sits in it`);
      t.ok(o.people === t.peopleIn(data, seat).length, 'the people in that seat are untouched');
      t.ok(o.count === data.departments.length + 1, 'exactly one department more');
    },
  },
  {
    name: 'ADD a small tree in any row order: a child listed before its parent, and a shared crew serving what was just created',
    async run(t) {
      const { buf, data } = await t.freshExport();
      const top = t.need(data.departments[0], 'no departments');
      const [a, b, crew] = [t.name('Process'), t.name('Cell'), t.name('Crew')];
      const wb = await t.open(buf);
      t.appendDepartment(wb, { name: b, under: a, type: 'Machine / area' });          // the child first
      t.appendDepartment(wb, { name: a, under: top.name, type: 'Process' });
      t.appendDepartment(wb, { name: crew, type: 'Shared crew', shared: true, serves: [a, b, top.name] });
      const edited = await t.save(wb);
      const prep = await t.plan(edited);
      t.ok(t.codes(prep).length === 0 && t.changed(prep.plan) === 'departmentsCreated,servesAdded' && prep.plan.counts.departmentsCreated === 3 && prep.plan.counts.servesAdded === 3,
        `three departments and three serves rows, nothing else (${t.codeList(prep) || t.summary(prep.plan)})`);
      const res = await t.rehearse(edited, {}, async (c) => ({ after: (await t.freshExport(c)).data }));
      if (!t.ok(res.status === 'REHEARSED', `applied (parents first, serves last), and the re-check agreed (${t.why(res)})`)) return;
      const d = (n) => res.observed.after.departments.find((x) => x.name === n);
      t.ok(d(b)?.under === a && d(a)?.under === top.name, 'the chain is as typed');
      t.ok(d(crew)?.shared && [a, b, top.name].every((n) => d(crew).serves.includes(n)) && d(crew).serves.length === 3, 'the crew is shared and serves the three');
    },
  },
  {
    name: 'MAKE a department a shared crew that serves two others',
    async run(t) {
      const { buf, data } = await t.freshExport();
      const target = t.need(data.departments.find((d) => !d.shared && data.departments.length >= 3), 'fewer than three departments');
      const others = data.departments.filter((d) => d.key !== target.key).slice(0, 2);
      const wb = await t.open(buf);
      const row = rowOf(t, wb, target);
      t.setCell(wb, 'Departments', row, t.DEPT.shared, t.S.YES);
      t.setServes(wb, row, others.map((o) => o.name));
      const edited = await t.save(wb);
      const prep = await t.plan(edited);
      t.ok(t.codes(prep).length === 0 && t.changed(prep.plan) === 'departmentsSharedChanged,servesAdded' && prep.plan.counts.servesAdded === 2,
        `shared on, two serves rows added, nothing else (${t.codeList(prep) || t.summary(prep.plan)})`);
      const res = await t.rehearse(edited, {}, async (c) => ({
        shared: (await t.q('SELECT is_shared s FROM hrms_departments WHERE id = ?', [target.id], c))[0].s,
        serves: ids(await live(t, c, target.id)),
      }));
      if (!t.ok(res.status === 'REHEARSED', `applied (${t.why(res)})`)) return;
      t.ok(Number(res.observed.shared) === 1 && res.observed.serves === idsOf(others), `"${target.name}" is shared and serves "${others[0].name}" and "${others[1].name}"`);
    },
  },
  {
    name: 'REMOVE a serves row, then stop sharing altogether (and a serves list that outlives its sharing is refused)',
    async run(t) {
      const { buf, data } = await t.freshExport();
      const crew = t.need(data.departments.find((d) => d.shared && d.serves.length >= 1), 'no shared department that serves anything');
      const byName = new Map(data.departments.map((d) => [d.name, d]));
      // (a) take the first serves row away
      const wb = await t.open(buf);
      const row = rowOf(t, wb, crew);
      t.setServes(wb, row, crew.serves.slice(1));
      const dropOne = await t.save(wb);
      const prep = await t.plan(dropOne);
      t.ok(t.codes(prep).length === 0 && t.changed(prep.plan) === 'servesRemoved' && prep.plan.counts.servesRemoved === 1, `exactly one serves row removed (${t.codeList(prep) || t.summary(prep.plan)})`);
      const res = await t.rehearse(dropOne, {}, async (c) => ({ serves: ids(await live(t, c, crew.id)) }));
      if (t.ok(res.status === 'REHEARSED', `applied (${t.why(res)})`)) {
        t.ok(res.observed.serves === idsOf(crew.serves.slice(1).map((n) => byName.get(n))), `"${crew.name}" now serves ${crew.serves.length - 1} of the ${crew.serves.length}; the row is retired, not erased`);
      }
      // (b) Shared = No with the Serves cells still filled: refused, in words
      const wb2 = await t.open(buf);
      t.setCell(wb2, 'Departments', rowOf(t, wb2, crew), t.DEPT.shared, t.S.NO);
      const p2 = await t.plan(await t.save(wb2));
      t.ok(t.codes(p2).includes('SERVES_NOT_SHARED'), 'Shared set to No while Serves still names departments is an ERROR (SERVES_NOT_SHARED)');
      // (c) Shared = No and Serves cleared: sharing off, every serves row retired
      const wb3 = await t.open(buf);
      t.setCell(wb3, 'Departments', rowOf(t, wb3, crew), t.DEPT.shared, t.S.NO);
      t.setServes(wb3, rowOf(t, wb3, crew), []);
      const stop = await t.save(wb3);
      const p3 = await t.plan(stop);
      t.ok(t.codes(p3).length === 0 && t.changed(p3.plan) === 'departmentsSharedChanged,servesRemoved' && p3.plan.counts.servesRemoved === crew.serves.length, `sharing off and all ${crew.serves.length} serves rows go (${t.codeList(p3) || t.summary(p3.plan)})`);
      const r3 = await t.rehearse(stop, {}, async (c) => ({
        shared: (await t.q('SELECT is_shared s FROM hrms_departments WHERE id = ?', [crew.id], c))[0].s,
        serves: ids(await live(t, c, crew.id)),
      }));
      if (t.ok(r3.status === 'REHEARSED', `applied (${t.why(r3)})`)) t.ok(Number(r3.observed.shared) === 0 && r3.observed.serves === '', 'no longer shared, and nothing live in its serves list');
    },
  },
  {
    name: 'RE-PARENT a department (and to the top), and two departments that trade places',
    async run(t) {
      const { buf, data } = await t.freshExport();
      const mover = t.need(data.departments.find((d) => d.parentKey && data.departments.some((y) => y.key !== d.key && y.key !== d.parentKey && !descendants(data, d.key).has(y.key))), 'no department that can move under another');
      const inside = descendants(data, mover.key);
      const newParent = data.departments.find((y) => y.key !== mover.key && y.key !== mover.parentKey && !inside.has(y.key));
      const wb = await t.open(buf);
      t.setCell(wb, 'Departments', rowOf(t, wb, mover), t.DEPT.under, newParent.name);
      const moved = await t.save(wb);
      const prep = await t.plan(moved);
      t.ok(t.codes(prep).length === 0 && t.changed(prep.plan) === 'departmentsMoved' && prep.plan.counts.departmentsMoved === 1, `one department moved, nothing else (${t.codeList(prep) || t.summary(prep.plan)})`);
      const kids = data.departments.filter((d) => d.parentKey === mover.key).length;
      const res = await t.rehearse(moved, {}, async (c) => ({
        parent: (await t.q('SELECT parent_department_id p FROM hrms_departments WHERE id = ?', [mover.id], c))[0].p,
        kids: Number((await t.q('SELECT COUNT(*) n FROM hrms_departments WHERE parent_department_id = ? AND deleted_at IS NULL', [mover.id], c))[0].n),
      }));
      if (t.ok(res.status === 'REHEARSED', `applied (${t.why(res)})`)) {
        t.ok(res.observed.parent === newParent.id && res.observed.kids === kids, `"${mover.name}" is now under "${newParent.name}" and still has its ${kids} department(s)`);
      }
      // to the top
      const wb2 = await t.open(buf);
      t.setCell(wb2, 'Departments', rowOf(t, wb2, mover), t.DEPT.under, null);
      const top = await t.save(wb2);
      const r2 = await t.rehearse(top, {}, async (c) => ({ parent: (await t.q('SELECT parent_department_id p FROM hrms_departments WHERE id = ?', [mover.id], c))[0].p }));
      t.ok(r2.status === 'REHEARSED' && r2.observed.parent === null, `cleared Under puts it at the top (${r2.status === 'REHEARSED' ? 'yes' : t.why(r2)})`);

      // a parent and its child trade places: B (under A) becomes A's parent, A goes under B. Attaching A first would trip the cycle rule.
      const child = data.departments.find((b) => b.parentKey);
      if (!child) { t.partial.push('no parent and child to trade places'); return; }
      const parent = data.departments.find((a) => a.key === child.parentKey);
      const wb3 = await t.open(buf);
      t.setCell(wb3, 'Departments', rowOf(t, wb3, child), t.DEPT.under, parent.under || null);
      t.setCell(wb3, 'Departments', rowOf(t, wb3, parent), t.DEPT.under, child.name);
      const swap = await t.save(wb3);
      const p3 = await t.plan(swap);
      t.ok(t.codes(p3).length === 0 && t.changed(p3.plan) === 'departmentsMoved' && p3.plan.counts.departmentsMoved === 2, `a parent and child trading places is two moves (${t.codeList(p3) || t.summary(p3.plan)})`);
      const r3 = await t.rehearse(swap, {}, async (c) => ({
        child: (await t.q('SELECT parent_department_id p FROM hrms_departments WHERE id = ?', [child.id], c))[0].p,
        parent: (await t.q('SELECT parent_department_id p FROM hrms_departments WHERE id = ?', [parent.id], c))[0].p,
      }));
      if (t.ok(r3.status === 'REHEARSED', `applied without tripping the cycle rule, and the re-check agreed (${t.why(r3)})`)) {
        t.ok(r3.observed.parent === child.id && r3.observed.child === (parent.parentId ?? null), `"${child.name}" is now the parent of "${parent.name}"`);
      }
    },
  },
  {
    name: 'RENAME a department: its seats follow by key, even when their cells still say the old name; RETYPE another',
    async run(t) {
      const { buf, data } = await t.freshExport();
      const seated = (d) => data.seats.some((s) => s.departmentKey === d.key);
      // preferably one with departments under it too: their Under cells keep the old name and must follow
      const dept = t.need(data.departments.find((d) => seated(d) && data.departments.some((k) => k.parentKey === d.key)) ?? data.departments.find(seated), 'no department has a seat in it');
      const inIt = data.seats.filter((s) => s.departmentKey === dept.key);
      const newName = `${dept.name} ${t.tag}`;
      // (a) renamed on Departments only: the seat cells still hold the old name
      const wb = await t.open(buf);
      t.setCell(wb, 'Departments', rowOf(t, wb, dept), t.DEPT.name, newName);
      const renamed = await t.save(wb);
      const prep = await t.plan(renamed);
      t.ok(t.codes(prep).length === 0 && t.changed(prep.plan) === 'departmentsRenamed', `only the department changes: its ${inIt.length} seat(s) are not touched (${t.codeList(prep) || t.changed(prep.plan)})`);
      const res = await t.rehearse(renamed, {}, async (c) => ({
        after: (await t.freshExport(c)).data,
        seatRows: await t.q(`SELECT department_id d FROM hrms_positions WHERE id IN (${inIt.map(() => '?').join(',')})`, inIt.map((s) => s.positionId), c),
      }));
      if (t.ok(res.status === 'REHEARSED', `applied, and the re-check agreed (${t.why(res)})`)) {
        t.ok(res.observed.seatRows.every((r) => r.d === dept.id), 'every seat is still in the same department row (by id)');
        t.ok(res.observed.after.seats.filter((s) => s.departmentKey === dept.key).every((s) => s.department === newName) && res.observed.after.seats.filter((s) => s.departmentKey === dept.key).length === inIt.length, `and a fresh export shows them in "${newName}"`);
      }
      // (b) the careful way: the seat cells are changed to the new name too. The same plan.
      const wb2 = await t.open(buf);
      t.setCell(wb2, 'Departments', rowOf(t, wb2, dept), t.DEPT.name, newName);
      for (const s of inIt) t.setCell(wb2, 'Structure', t.rowOfKey(wb2, s.key), t.COLS.department, newName);
      const p2 = await t.plan(await t.save(wb2));
      t.ok(t.codes(p2).length === 0 && t.changed(p2.plan) === 'departmentsRenamed', `renaming the seat cells as well changes nothing more (${t.codeList(p2) || t.changed(p2.plan)})`);
      // (c) retype
      const other = t.part(data.departments.find((d) => d.key !== dept.key), 'only one department');
      if (other) {
        const wb3 = await t.open(buf);
        t.setCell(wb3, 'Departments', rowOf(t, wb3, other), t.DEPT.type, `Type ${t.tag}`);
        const typed = await t.save(wb3);
        const p3 = await t.plan(typed);
        t.ok(t.codes(p3).length === 0 && t.changed(p3.plan) === 'departmentsRetyped', `a changed Type is a retype and nothing else (${t.codeList(p3) || t.changed(p3.plan)})`);
        const r3 = await t.rehearse(typed, {}, async (c) => ({ type: (await t.q('SELECT department_type ty FROM hrms_departments WHERE id = ?', [other.id], c))[0].ty }));
        t.ok(r3.status === 'REHEARSED' && r3.observed.type === `Type ${t.tag}`, `the label is saved as typed (${r3.status === 'REHEARSED' ? r3.observed.type : t.why(r3)})`);
      }
    },
  },
  {
    name: 'REMOVE a department: never without --delete-missing; only when nothing is in it or under it; the blockers are named',
    async run(t) {
      const { buf, data } = await t.freshExport();
      // (a) a department with seats in it, deleted: refused, and it says why
      const withSeats = t.part(data.departments.find((d) => data.seats.some((s) => s.departmentKey === d.key) && !data.departments.some((k) => k.parentKey === d.key)), 'no childless department with a seat in it');
      if (withSeats) {
        const wb = await t.open(buf);
        t.deleteRow(wb, 'Departments', rowOf(t, wb, withSeats));
        const edited = await t.save(wb);
        const withFlag = await t.plan(edited, { deleteMissing: true });
        const blocker = withFlag.problems.find((p) => p.code === 'DEPARTMENT_IN_USE' && p.message.includes(`"${withSeats.name}"`));
        t.ok(blocker && /seats? sits? in it|seats? sit in it/.test(blocker.message), `deleting "${withSeats.name}" with --delete-missing is refused, naming the seats in it (${blocker ? blocker.message.slice(0, 140) : t.codeList(withFlag)})`);
        const without = await t.plan(edited);
        t.ok(without.plan.counts.departmentsRemoved === 0 && without.plan.kept.departments.some((d) => d.key === withSeats.key), 'without the flag nothing is removed: the department is only reported as left alone');
      }
      // (b) the whole subtree of a department that has a seat somewhere below it: the parent is blocked by what is under it
      const parent = t.part(data.departments.find((p) => descendants(data, p.key).size + 1 < data.departments.length && [...descendants(data, p.key)].some((k) => data.seats.some((s) => s.departmentKey === k))), 'no department with a seated department below it that leaves other departments on the sheet');
      if (parent) {
        const subtree = [parent, ...[...descendants(data, parent.key)].map((k) => data.departments.find((d) => d.key === k))];
        const wb = await t.open(buf);
        for (const row of subtree.map((d) => rowOf(t, wb, d)).sort((a, b) => b - a)) t.deleteRow(wb, 'Departments', row);
        const p = await t.plan(await t.save(wb), { deleteMissing: true });
        const mine = p.problems.find((e) => e.code === 'DEPARTMENT_IN_USE' && e.message.includes(`"${parent.name}"`));
        t.ok(mine && /under it/.test(mine.message), `"${parent.name}" cannot go while a department below it is kept: ${mine ? mine.message.slice(0, 150) : t.codeList(p)}`);
      }
      // (c) an empty department: made, then removed, in one transaction that is rolled back
      const top = t.need(data.departments[0], 'no departments');
      const empty = t.name('Empty');
      const wbAdd = await t.open(buf);
      t.appendDepartment(wbAdd, { name: empty, under: top.name, type: 'Machine / area' });
      await inTransaction(t, async () => {
        await step(t, await t.save(wbAdd));
        const second = await t.freshExport(t.conn);
        const made = second.data.departments.find((d) => d.name === empty);
        if (!t.ok(Boolean(made), 'an empty tagged department exists for the next step')) return;
        const wb = await t.open(second.buf);
        t.deleteRow(wb, 'Departments', rowOf(t, wb, made));
        const edited = await t.save(wb);
        const without = await t.plan(edited);
        t.ok(t.codes(without).length === 0 && without.plan.counts.departmentsRemoved === 0 && without.plan.kept.departments.length === 1, 'without --delete-missing it is left alone');
        const flagged = await t.plan(edited, { deleteMissing: true });
        t.ok(t.codes(flagged).length === 0 && t.changed(flagged.plan) === 'departmentsRemoved', `with --delete-missing it is retired (${t.codeList(flagged) || t.changed(flagged.plan)})`);
        await t.A.executePlan({ conn: t.conn, plan: flagged.plan, loaded: flagged.loaded, env: flagged.env, requestId: 'workbook-test-chain' });
        const row = (await t.q('SELECT deleted_at d FROM hrms_departments WHERE id = ?', [made.id], t.conn))[0];
        t.ok(row.d !== null, 'the department row is soft-retired by the service, not erased');
        const after = (await t.freshExport(t.conn)).data;
        t.ok(!after.departments.some((d) => d.key === made.key), 'and the next export no longer lists it');
      });
    },
  },
  {
    name: 'REFUSE: a cycle, a department under itself, a shared crew serving itself, serves on a department that is not shared, an unknown parent',
    async run(t) {
      const { buf, data } = await t.freshExport();
      const edit = async (fn) => { const wb = await t.open(buf); fn(wb); return t.plan(await t.save(wb)); };
      const child = t.part(data.departments.find((d) => d.parentKey), 'no department has a parent');
      if (child) {
        const parent = data.departments.find((d) => d.key === child.parentKey);
        const p = await edit((wb) => t.setCell(wb, 'Departments', rowOf(t, wb, parent), t.DEPT.under, child.name));
        t.ok(t.codes(p).includes('DEPARTMENT_CYCLE'), `"${parent.name}" under its own child "${child.name}" is a CYCLE (${t.codeList(p)})`);
        const grand = data.departments.find((d) => d.key === parent.parentKey);
        if (grand) {
          const p2 = await edit((wb) => t.setCell(wb, 'Departments', rowOf(t, wb, grand), t.DEPT.under, child.name));
          t.ok(t.codes(p2).includes('DEPARTMENT_CYCLE'), 'and so is a department under its grandchild');
        }
      }
      const any = t.need(data.departments[0], 'no departments');
      const self = await edit((wb) => t.setCell(wb, 'Departments', rowOf(t, wb, any), t.DEPT.under, any.name));
      t.ok(t.codes(self).includes('PARENT_IS_SELF'), 'a department under itself is refused (PARENT_IS_SELF)');
      const selfServe = await edit((wb) => { const r = rowOf(t, wb, any); t.setCell(wb, 'Departments', r, t.DEPT.shared, t.S.YES); t.setServes(wb, r, [any.name]); });
      t.ok(t.codes(selfServe).includes('SERVES_SELF'), 'a shared crew serving itself is refused (SERVES_SELF)');
      const notShared = t.part(data.departments.find((d) => !d.shared && data.departments.length > 1), 'every department is shared');
      if (notShared) {
        const other = data.departments.find((d) => d.key !== notShared.key);
        const p = await edit((wb) => t.setServes(wb, rowOf(t, wb, notShared), [other.name]));
        t.ok(t.codes(p).includes('SERVES_NOT_SHARED'), `a Serves list on "${notShared.name}", which is not shared, is refused (SERVES_NOT_SHARED)`);
      }
      const unknown = await edit((wb) => t.setCell(wb, 'Departments', rowOf(t, wb, any), t.DEPT.under, `Nowhere ${t.tag}`));
      t.ok(t.codes(unknown).includes('UNKNOWN_PARENT'), 'an Under that is not a department on the sheet is refused (UNKNOWN_PARENT)');
      const newUnder = await edit((wb) => t.appendDepartment(wb, { name: t.name('Orphan'), under: `Nowhere ${t.tag}` }));
      t.ok(t.codes(newUnder).includes('UNKNOWN_PARENT'), 'and so is a NEW department whose parent is not on the sheet');
      const unknownServes = await edit((wb) => { const r = rowOf(t, wb, any); t.setCell(wb, 'Departments', r, t.DEPT.shared, t.S.YES); t.setServes(wb, r, [`Nowhere ${t.tag}`]); });
      t.ok(t.codes(unknownServes).includes('UNKNOWN_SERVES'), 'a Serves name that is not on the sheet is refused (UNKNOWN_SERVES)');
      const badYes = await edit((wb) => t.setCell(wb, 'Departments', rowOf(t, wb, any), t.DEPT.shared, 'maybe'));
      t.ok(t.codes(badYes).includes('BAD_YES_NO'), 'Shared crew? other than Yes or No is refused (BAD_YES_NO)');
    },
  },
  {
    name: 'REFUSE a workbook from an older layout, with a sentence that says to export a fresh one',
    async run(t) {
      const { buf } = await t.freshExport();
      const sentence = (prep) => prep.refusals.concat(prep.problems.filter((p) => p.severity === 'error').map((p) => p.message)).find((m) => /older version/.test(m) && /Export a fresh workbook/.test(m));
      const wb = await t.open(buf);
      t.setProvenance(wb, 'schemaVersion', t.S.SCHEMA_VERSION - 1);
      const old = await t.plan(await t.save(wb));
      t.ok(old.plan === null && Boolean(sentence(old)), `schema version ${t.S.SCHEMA_VERSION - 1} is refused, and says: "${(sentence(old) ?? old.refusals[0] ?? t.codeList(old)).slice(0, 120)}..."`);
      const res = await t.A.applyWorkbook({ conn: t.conn, buf: await t.save(wb), file: 'old.xlsx', slug: t.slug, target: t.target, flags: { again: true, rehearse: async () => 1 } });
      t.ok(res.status === 'REFUSED' || res.status === 'PROBLEMS', `and an --apply is refused too (${res.status}); nothing was written`);

      // the old SHAPE itself: no Departments sheet, a "Machines & areas" sheet in its place, no provenance to read the version from
      const blank = await t.open(await t.save(t.S.buildOrgWorkbook(null)));
      blank.removeWorksheet(blank.getWorksheet(t.S.SHEET.departments).id);
      blank.addWorksheet('Machines & areas');
      const shape = await t.plan(await t.save(blank));
      t.ok(shape.plan === null && shape.problems.some((p) => p.code === 'OLD_LAYOUT' && /Export a fresh workbook/.test(p.message)), `a file with the old Machines sheet is refused as an old layout (${t.codeList(shape)})`);
    },
  },
];
