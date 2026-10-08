/**
 * The one case that really commits (run it with --commit). Every other case rehearses: it applies inside a transaction and rolls
 * back, which proves every write but never the COMMIT itself, the import-run record, or the repeat-file guard. This one does,
 * on a harmless change, and puts it back.
 *
 * WHAT IT LEAVES BEHIND, because nothing here is erased: two rows in hrms_import_runs (source_kind EXCEL, one per apply) and two
 * hrms_audit_log rows (the headcount going up and coming back). The headcount itself is restored in a finally block, whatever
 * happened.
 */
export const name = 'commit';
export const optIn = 'commit';

const DN = 'Day & night';

export const cases = [
  {
    name: 'a REAL apply commits and records its import run; the same file is refused twice; the change is put back',
    commits: true,
    async run(t) {
      t.need(!t.target.isProd, 'never against production');
      const { buf, data } = await t.freshExport();
      const seat = t.need(data.seats.find((s) => s.shift && s.shift !== DN), 'no single-shift seat to change');
      const original = (await t.q('SELECT sanctioned_headcount n FROM hrms_positions WHERE id = ?', [seat.positionId]))[0].n;
      const headcount = async () => Number((await t.q('SELECT sanctioned_headcount n FROM hrms_positions WHERE id = ?', [seat.positionId]))[0].n);
      const flags = { deleteMissing: false, allowStale: false, again: false, createOnly: false };
      const apply = (file, b) => t.A.applyWorkbook({ conn: t.conn, buf: b, file, slug: t.slug, target: t.target, flags });
      const withCount = async (source, n) => {
        const wb = await t.open(source);
        t.setCell(wb, 'Structure', t.rowOfKey(wb, seat.key), t.COLS.count, n);
        return t.save(wb);
      };
      try {
        const up = await withCount(buf, seat.count + 1);
        const r1 = await apply('commit-test-up.xlsx', up);
        t.ok(r1.status === 'APPLIED', `the apply committed (${t.why(r1)})`);
        t.ok((await headcount()) === seat.count + 1, `the headcount really changed in the database (${seat.count} -> ${await headcount()})`);
        const [run] = await t.q('SELECT status, source_kind, source_file_name, source_size_bytes FROM hrms_import_runs WHERE company_id = ? AND source_hash = ? ORDER BY id DESC LIMIT 1', [t.companyId, t.A.sha256(up)]);
        t.ok(run?.status === 'COMMITTED' && run.source_kind === 'EXCEL' && Number(run.source_size_bytes) === up.length, 'the file is recorded as a committed EXCEL import run, with its SHA-256 and size');

        // put it back, from a fresh export so its keys are current
        const second = await t.freshExport();
        const r2 = await apply('commit-test-down.xlsx', await withCount(second.buf, seat.count));
        t.ok(r2.status === 'APPLIED' && (await headcount()) === Number(original), `and the change is put back (${t.why(r2)}; headcount ${await headcount()})`);

        // The database is back where the first file was exported from, so that file is not stale and its plan is not empty:
        // only the repeat-file guard stands between it and a second apply.
        const r3 = await apply('commit-test-up.xlsx', up);
        t.ok(r3.status === 'ALREADY_APPLIED', `the first file again is refused as already applied (${t.why(r3)})`);
        t.ok((await headcount()) === Number(original), 'and it changed nothing');

        const after = await t.freshExport();
        const prep = await t.plan(after.buf);
        t.ok(prep.plan.empty && prep.problems.length === 0, 'a fresh export of the restored database is, once more, an empty plan');
      } finally {
        await t.q('UPDATE hrms_positions SET sanctioned_headcount = ? WHERE id = ?', [original, seat.positionId]);
      }
    },
  },
];
