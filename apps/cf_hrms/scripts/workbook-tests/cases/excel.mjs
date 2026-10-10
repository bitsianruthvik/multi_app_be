/**
 * The case that closes the gap every other case has: they edit the workbook with ExcelJS, which is not what a person uses. This
 * one drives REAL Excel through COM (Windows with Excel installed; run it with --excel): it opens a copy of a fresh export, does
 * what a person does (retitle, change a count, insert a row, copy a row and insert the copy, delete a row, pick a new seat for a
 * person from the live drop-down labels, add a duty, a question and a machine department), saves it as Excel saves it, and the applier reads
 * THAT file. What it proves that nothing else does: the hidden Key travels with a copied row, survives an inserted and a deleted
 * row, dates and formulas come back from Excel's own writer as the reader expects, and the plan is exactly the edits made.
 *
 * The script that drives Excel is excel-edit.ps1 beside this file. It stops any Excel it started and did not manage to close.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

export const name = 'excel';
export const optIn = 'excel';

const here = path.dirname(fileURLToPath(import.meta.url));

export const cases = [
  {
    name: 'a file edited and SAVED BY REAL EXCEL applies as intended, and the post-write re-check agrees',
    async run(t) {
      t.need(process.platform === 'win32', 'driving Excel needs Windows');
      const { buf, data } = await t.freshExport();
      const wb = await t.open(buf);
      const rows = t.structureRows(wb);
      const rowOf = (s) => rows.find((r) => r.key === s.key)?.row;
      const levelOf = (s) => rows.find((r) => r.key === s.key)?.level;
      const idx = (s) => data.seats.indexOf(s);
      const unique = (s) => data.seats.filter((x) => x.title === s.title).length === 1;

      // Edits in OUTLINE order, because Excel applies them bottom-up: retitle < count < insert < copy < delete.
      const retitle = t.need(data.seats[1], 'too few seats');
      const count = t.need(data.seats[2], 'too few seats');
      const insertAfter = t.need(data.seats.find((s, i) => i > 2 && levelOf(s) < 10), 'no seat to insert under');
      const copy = t.need(data.seats.find((s, i) => i > idx(insertAfter) && t.isLeaf(data, s) && s.parentPositionId != null), 'no leaf seat to copy after that');
      const del = t.need(data.seats.find((s, i) => i > idx(copy) && t.isLeaf(data, s) && !t.peopleIn(data, s).length), 'no empty leaf seat to delete after that');
      const taken = new Set([retitle, count, insertAfter, copy, del].map((s) => s.key));
      const person = t.need(data.people[0], 'nobody holds a seat');
      const target = t.need(data.seats.find((s) => !taken.has(s.key) && unique(s) && !t.peopleIn(data, s).length && s.roleId !== person.roleId), 'no empty seat with a unique title to move a person to');
      const dutySeat = t.need(data.seats.find((s) => !taken.has(s.key) && s.key !== target.key && unique(s)), 'no seat with a unique title for a duty');
      const question = t.need(data.questions[0], 'no open questions');

      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hrms-workbook-excel-'));
      try {
        const job = {
          inFile: path.join(dir, 'in.xlsx'), outFile: path.join(dir, 'out.xlsx'),
          col: { firstLevel: t.S.COL.firstLevel, count: t.S.COL.count, shift: t.S.COL.shift, department: t.S.COL.department },
          retitleRow: rowOf(retitle), retitleLevel: levelOf(retitle), retitleTo: `${retitle.title} [${t.tag}]`,
          countRow: rowOf(count), countTo: count.count + 3,
          insertAt: rowOf(insertAfter) + 1, insertLevel: levelOf(insertAfter) + 1, insertTitle: t.name('inserted seat'), insertShift: (await t.env()).shifts[0].name, machineName: t.name('Line'),
          deptCol: { name: t.S.DEPT_COL.name, under: t.S.DEPT_COL.under, type: t.S.DEPT_COL.type, shared: t.S.DEPT_COL.shared },
          underName: (data.departments.find((d) => !d.shared) ?? data.departments[0])?.name ?? '',
          copyRow: rowOf(copy), deleteRow: rowOf(del),
          personRow: t.findKeyRow(wb, 'People', person.key), targetTitle: target.title,
          dutySeatTitle: dutySeat.title, dutyText: `ZZ ${t.tag} duty typed in Excel.`,
          questionDeleteRow: t.findKeyRow(wb, 'Questions & doubts', question.key), questionText: `ZZ ${t.tag} question typed in Excel?`,
        };
        fs.writeFileSync(job.inFile, buf);
        const jobFile = path.join(dir, 'job.json');
        fs.writeFileSync(jobFile, JSON.stringify(job, null, 1));
        const run = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(here, 'excel-edit.ps1'), '-JobFile', jobFile], { encoding: 'utf8', timeout: 240000 });
        if (/NO_EXCEL/.test(run.stdout ?? '')) t.skip('Excel is not installed (or not registered for COM) on this machine');
        t.note(`excel-edit.ps1 said:\n${(run.stdout ?? '').trim()}\n${(run.stderr ?? '').trim()}`);
        if (!t.ok(run.status === 0 && fs.existsSync(job.outFile), `Excel made the edits and saved the file (exit ${run.status})`)) return;

        const out = fs.readFileSync(job.outFile);
        const prep = await t.plan(out);
        t.ok(prep.refusals.length === 0 && t.codes(prep).length === 0, `the Excel-written file reads cleanly (${t.codeList(prep) || 'no errors'})`);
        t.ok(prep.read.problems.some((p) => p.code === 'DUPLICATE_KEY'), 'the copied row carried its hidden Key with it, so it is read as a copy (a repeated key)');
        t.ok(t.changed(prep.plan) === 'departmentsCreated,headcountsChanged,peopleMovedToAnotherSeat,questionsAdded,responsibilitiesAdded,rolesCreated,seatsCreated,seatsRetitled',
          `the plan is exactly the edits that were made, and no others (${t.summary(prep.plan)})`);
        t.ok(prep.plan.counts.seatsCreated === 2 && prep.plan.counts.rolesCreated === 1, 'two new seats (the inserted one, the copy); only the inserted one needs a new role');
        t.ok(prep.plan.kept.seats.some((s) => s.key === del.key) && prep.plan.kept.questions.some((q) => q.key === question.key), 'the deleted seat and question are LEFT ALONE without the flag');

        const withFlag = await t.plan(out, { deleteMissing: true });
        t.ok(t.codes(withFlag).length === 0 && withFlag.plan.counts.seatsClosed === 1 && withFlag.plan.counts.questionsDismissed === 1, 'with --delete-missing the seat is closed and the question dismissed');
        const res = await t.rehearse(out, { deleteMissing: true }, async (c) => ({ seats: (await t.freshExport(c)).data.seats.length }));
        if (t.ok(res.status === 'REHEARSED', `applied, and the post-write re-check agreed (${t.why(res)})`)) {
          t.ok(res.observed.seats === data.seats.length + 2 - 1, `the chart now has ${res.observed.seats} seats (${data.seats.length} + 2 created - 1 closed)`);
        }
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  },
];
