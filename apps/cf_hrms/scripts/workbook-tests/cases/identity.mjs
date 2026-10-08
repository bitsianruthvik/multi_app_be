/**
 * THE test that decides whether every other result can be trusted: export, apply with no edits at all, and nothing
 * changes. Not "nothing important": the dry run reports a literally empty plan. If this fails, the key or the comparison
 * is wrong and no other case means anything.
 */
export const name = 'identity';

export const cases = [
  {
    name: 'export, then apply with no edits at all: the plan is literally empty',
    async run(t) {
      const { buf } = await t.freshExport();
      const prep = await t.plan(buf);
      t.ok(prep.refusals.length === 0, 'the workbook is not refused');
      t.ok(prep.problems.length === 0, `no problems and no warnings (got ${prep.problems.length}: ${prep.problems.slice(0, 3).map((p) => p.code).join(', ')})`);
      t.ok(prep.stale === false, 'the database has not moved since the export');
      t.ok(prep.plan.empty === true, 'the plan is empty');
      t.ok(Object.values(prep.plan.counts).every((n) => n === 0), 'every counter in the plan is zero');
      t.ok(prep.plan.notices.length === 0, 'no notices');
      t.ok(Object.values(prep.plan.kept).every((x) => x.length === 0), 'nothing in the database is missing from the workbook');
      if (!prep.plan.empty) t.note(`the plan was: ${t.summary(prep.plan)}\n${t.describe(prep).join('\n')}`);

      // the same file after another program has opened and saved it: what Excel does to every file
      const again = await t.save(await t.open(buf));
      const prep2 = await t.plan(again);
      t.ok(prep2.plan.empty && prep2.problems.length === 0, 'still empty after the file is loaded and saved again');

      const res = await t.rehearse(buf, {}, async () => 1);
      t.ok(res.status === 'NOTHING_TO_DO', `an --apply of an empty plan does nothing (${res.status})`);
    },
  },
  {
    name: 'a second export taken straight after the first is the same workbook (the fingerprint is stable)',
    async run(t) {
      const a = await t.exportWorkbook();
      const b = await t.exportWorkbook();
      t.ok(a.data.provenance.contentHash === b.data.provenance.contentHash, 'two exports of the same data carry the same content fingerprint');
      t.ok(t.S.fingerprintOf(a.data) === a.data.provenance.contentHash, 'the stamped fingerprint is the fingerprint of what the sheets show');
    },
  },
  {
    name: "the generator's own self-check passes, on an export and on the blank template",
    async run(t) {
      const ex = await t.exportWorkbook();
      const reread = await t.open(Buffer.from(await ex.wb.xlsx.writeBuffer()));
      const { problems } = t.S.checkOrgWorkbook(reread, ex.data);
      t.ok(problems.length === 0, `export: clean (${problems.slice(0, 3).join(' | ')})`);
      const blank = await t.open(Buffer.from(await t.S.buildOrgWorkbook(null).xlsx.writeBuffer()));
      const b = t.S.checkOrgWorkbook(blank, null);
      t.ok(b.problems.length === 0, `blank template: clean (${b.problems.slice(0, 3).join(' | ')})`);
    },
  },
  {
    name: 'provenance names this company, this database and a schema version the reader knows',
    async run(t) {
      const { buf, data } = await t.freshExport();
      const read = t.R.readOrgWorkbook(await t.open(buf));
      t.ok(read.kind === 'prefilled', `read as a pre-filled workbook (${read.kind})`);
      t.ok(read.provenance?.companyId === t.companyId && read.provenance?.companySlug === t.slug, 'company slug and id are the ones exported');
      t.ok(read.provenance?.target === (t.target.isProd ? 'prod' : 'local'), `stamped with the database it came from (${read.provenance?.target})`);
      t.ok(t.R.SUPPORTED_SCHEMA_VERSIONS.includes(read.provenance?.schemaVersion), `schema version ${read.provenance?.schemaVersion} is one the reader supports`);
      t.ok(read.problems.filter((p) => p.severity === 'error').length === 0, 'the reader finds no errors in an untouched export');
      const rows = read.stats.rows;
      t.ok(rows.structure === data.seats.length && rows.people === data.people.length && rows.responsibilities === data.responsibilities.length
        && rows.machines === data.machines.length && rows.questions === data.questions.length, 'every row the database showed is a row in the workbook');
      t.ok(Object.values(read.stats.blankKey).every((n) => n === 0) && Object.values(read.stats.duplicateKey).every((n) => !n), 'every row carries a key, and no key repeats');
    },
  },
  {
    name: 'a person in two seats is two rows with two keys, and still round-trips',
    async run(t) {
      const { buf, data } = await t.freshExport();
      const twice = t.need(data.people.find((p) => data.people.filter((x) => x.employeeId === p.employeeId).length > 1), 'nobody holds two seats in this data');
      const rows = data.people.filter((p) => p.employeeId === twice.employeeId);
      t.ok(new Set(rows.map((r) => r.key)).size === rows.length, `${twice.name} has ${rows.length} rows with ${rows.length} different keys (asg:, not emp:)`);
      const prep = await t.plan(buf);
      t.ok(prep.plan.empty && prep.problems.length === 0, 'and the plan is still empty');
    },
  },
];
