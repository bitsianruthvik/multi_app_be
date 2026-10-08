/**
 * Put a company's HR data back from a backup-company.mjs snapshot.
 *
 *   node restore-company.mjs --file=backup_karni_prod_....json             DRY RUN
 *   node restore-company.mjs --file=... --apply                            write (local)
 *   node restore-company.mjs --file=... --apply --target=prod              write (TiDB)
 *   node restore-company.mjs --file=... --apply --schema=scratch_restore   somewhere else
 *
 * Dry run is the default. `--apply` is the opt-in and production needs
 * `--target=prod` on top of it, so an accidental restore takes two mistakes.
 *
 * HOW IT RESTORES. Ids are preserved: a snapshot and its database hold the same
 * rows, so the restore deletes the company's rows and re-inserts the snapshot
 * under its original primary keys. That keeps every foreign key between restored
 * rows valid with no remapping table, and makes a restore idempotent — running
 * it twice leaves the same database.
 *
 * ORDER. Parents before children going in, children before parents coming out.
 * The order is read from the database's own foreign keys and sorted, never
 * hardcoded: a hardcoded list is correct the day it is written and wrong after
 * the next migration, and that failure looks like a corrupt backup.
 *
 * WHAT IT WILL NOT DO. It refuses a snapshot from a different company, does not
 * write the `companies` row itself, and cannot bring back excluded blob columns.
 * All three are reported rather than assumed.
 */
import fs from 'fs';
import mysql from 'mysql2/promise';
import { resolveTarget, announce } from './dbTarget.mjs';

const args = process.argv.slice(2);
const arg = (n) => {
  const hit = args.find((a) => a === `--${n}` || a.startsWith(`--${n}=`));
  return hit ? (hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : '') : null;
};
const has = (n) => args.includes(`--${n}`);

/** Never deleted or re-inserted: the tenant row itself. */
const NEVER_WRITE = new Set(['companies']);

/**
 * A value as the driver should receive it.
 *
 * A JSON column comes back from the snapshot as a parsed object or array, and
 * mysql2 expands an ARRAY bound to a single `?` into a comma-separated list —
 * so one JSON array in one row turns a 20-column insert into a 23-value insert
 * and the whole statement fails with "Column count doesn't match value count".
 * JSON goes back as text. A Buffer is already bytes and is left alone.
 */
const bind = (v) =>
  v !== null && typeof v === 'object' && !Buffer.isBuffer(v) && !(v instanceof Date) ? JSON.stringify(v) : v;

/**
 * The snapshot's tables ordered so each one follows everything it points at.
 * Self-references are ignored — a row pointing inside its own table is a matter
 * of insert order within the table, not between tables.
 */
async function dependencyOrder(q, schema, tables) {
  const want = new Set(tables);
  const fks = await q(
    `SELECT DISTINCT TABLE_NAME AS child, REFERENCED_TABLE_NAME AS parent
       FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME IS NOT NULL`,
    [schema],
  );
  const deps = new Map(tables.map((t) => [t, new Set()]));
  for (const { child, parent } of fks) {
    if (want.has(child) && want.has(parent) && child !== parent) deps.get(child).add(parent);
  }
  const out = [];
  const done = new Set();
  // Kahn's algorithm, alphabetical among the ready set so the order is stable
  // run to run and two reports diff cleanly.
  while (out.length < tables.length) {
    const ready = tables
      .filter((t) => !done.has(t) && [...deps.get(t)].every((p) => done.has(p)))
      .sort();
    if (!ready.length) {
      throw new Error(`foreign keys form a cycle among: ${tables.filter((t) => !done.has(t)).join(', ')}`);
    }
    for (const t of ready) { out.push(t); done.add(t); }
  }
  return out;
}

const main = async () => {
  const file = arg('file');
  if (!file) throw new Error('--file=<snapshot.json> is required');
  const apply = has('apply');
  // Opt-in, because substituting a value during a restore is a decision, not a
  // detail. The refusal below names this flag, so the path is: hit the error,
  // read exactly which rows and what they would become, then allow it.
  const repairEnums = has('repair-enums');
  /**
   * Restore only these tables, comma-separated. For putting one thing back
   * rather than the whole tenant — which is the common recovery, not the rare
   * one. `--only=hrms_shifts,hrms_reporting_relationship_types` is what put
   * Karni's seed-owned configuration back after a clear took it.
   */
  const only = (arg('only') || '').split(',').map((s) => s.trim()).filter(Boolean);

  const snap = JSON.parse(fs.readFileSync(file, 'utf8'));
  const target = resolveTarget();
  const schema = arg('schema') || target.cfg.database;

  console.log(`\n  snapshot: ${file}`);
  console.log(`  taken:    ${snap.takenAt}  from ${snap.target}`);
  console.log(`  company:  ${snap.company.name} (id ${snap.company.id})`);
  announce(target);
  console.log(`  schema:   ${schema}`);
  console.log(`  mode:     ${apply ? 'APPLY - rows will be written' : 'DRY RUN - nothing will be written'}\n`);

  const conn = await mysql.createConnection({ ...target.cfg, database: schema, dateStrings: true });
  const q = async (sql, p = []) => (await conn.execute(sql, p))[0];

  try {
    const [live] = await q('SELECT id, slug, name FROM companies WHERE id = ?', [snap.company.id]);
    if (!live) throw new Error(`company id ${snap.company.id} does not exist in ${schema} - create it there first`);
    if (live.slug !== snap.company.slug) {
      throw new Error(
        `company id ${snap.company.id} is "${live.slug}" here but "${snap.company.slug}" in the snapshot - wrong database`,
      );
    }

    const present = new Set(
      (await q('SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?', [schema])).map((r) => r.t),
    );

    /**
     * Which columns this schema actually has, per table — because a snapshot and
     * its destination need not agree. Restoring a production snapshot into a
     * database built from the migration files turned up `users.preferences`,
     * live in production and absent from `core-init.sql`, and the whole restore
     * died on it. One unknown column should cost that column and a line in the
     * report, not the other 1,341 rows.
     *
     * A column the destination has and the snapshot lacks takes its default, so
     * it needs no handling here — only a mention, since the restored row is then
     * not quite the row that was backed up.
     */
    const columnsOf = new Map();
    for (const r of await q(
      `SELECT TABLE_NAME AS t, COLUMN_NAME AS c, GENERATION_EXPRESSION AS gen FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ?`, [schema],
    )) {
      if (!columnsOf.has(r.t)) columnsOf.set(r.t, new Map());
      // A generated column cannot be written to at all, so it is not "missing"
      // when the snapshot omits it, and must be dropped when the snapshot has it.
      //
      // Test GENERATION_EXPRESSION, not EXTRA. MySQL 8 writes `DEFAULT_GENERATED`
      // into EXTRA for any column with an expression default, so matching EXTRA
      // on /GENERATED/ silently classes every `created_at TIMESTAMP DEFAULT
      // CURRENT_TIMESTAMP` as generated and throws away its value — a restore
      // that quietly re-dates all 1,341 rows to the moment of the restore.
      columnsOf.get(r.t).set(r.c, Boolean(r.gen));
    }
    const writable = (t) => {
      const m = columnsOf.get(t) || new Map();
      return new Set([...m].filter(([, gen]) => !gen).map(([c]) => c));
    };
    const dropped = [];
    const defaulted = [];

    /**
     * Enum columns and what they will actually accept, plus whether NULL is one
     * of the options.
     *
     * Needed because TiDB and MySQL do not agree on what an enum will accept.
     * Karni's production `hrms_import_runs.status` holds an EMPTY STRING, which
     * its own enum does not list — TiDB took it, and MySQL under
     * STRICT_TRANS_TABLES refuses it with "Data truncated for column 'status'".
     * A recovery tool that dies on a value production is already storing is not
     * a recovery tool, so an unacceptable value becomes NULL and is named in the
     * report, row by row. Never silently.
     */
    const enumsOf = new Map();
    for (const r of await q(
      `SELECT TABLE_NAME AS t, COLUMN_NAME AS c, COLUMN_TYPE AS ct,
              IS_NULLABLE AS nullable, COLUMN_DEFAULT AS dflt
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ? AND DATA_TYPE = 'enum'`, [schema],
    )) {
      const allowed = new Set([...r.ct.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'")));
      if (!enumsOf.has(r.t)) enumsOf.set(r.t, new Map());
      enumsOf.get(r.t).set(r.c, {
        allowed,
        nullable: r.nullable === 'YES',
        fallback: allowed.has(r.dflt) ? r.dflt : null,
      });
    }
    const coerced = [];
    const wanted = (t) => !only.length || only.includes(t);
    if (only.length) {
      const unknown = only.filter((t) => !(t in snap.data));
      if (unknown.length) throw new Error(`--only names tables the snapshot does not hold: ${unknown.join(', ')}`);
      console.log(`  only:    ${only.join(', ')}\n`);
    }
    const missing = Object.keys(snap.data).filter((t) => !present.has(t) && !NEVER_WRITE.has(t) && wanted(t));
    const tables = Object.keys(snap.data).filter((t) => present.has(t) && !NEVER_WRITE.has(t) && wanted(t));
    const order = await dependencyOrder(q, schema, tables);

    for (const t of order) {
      const rows = snap.data[t].rows;
      if (!rows.length) continue;
      const here = writable(t);
      const snapCols = Object.keys(rows[0]);
      for (const c of snapCols) if (!here.has(c)) dropped.push(`${t}.${c}`);
      for (const c of here) if (!snapCols.includes(c)) defaulted.push(`${t}.${c}`);

      for (const [c, { allowed, nullable, fallback }] of enumsOf.get(t) || []) {
        if (!snapCols.includes(c)) continue;
        for (const r of rows) {
          const v = r[c];
          if (v === null || allowed.has(String(v))) continue;
          const to = nullable ? null : fallback;
          if (to === undefined || (to === null && !nullable)) {
            throw new Error(
              `${t}.${c} is NOT NULL with no usable default, and row id ${r.id} holds ${JSON.stringify(v)}, ` +
              `which the enum does not allow (${[...allowed].join(', ')}). Widen the column or mend the snapshot.`,
            );
          }
          if (!repairEnums) {
            throw new Error(
              `${t}.${c} row id ${r.id} holds ${JSON.stringify(v)}, which this enum does not allow ` +
              `(${[...allowed].join(', ')}).\n` +
              `          TiDB accepted the value and MySQL will not. Re-run with --repair-enums to write ` +
              `${to === null ? 'NULL' : JSON.stringify(to)} instead; every substitution is listed in the report.`,
            );
          }
          coerced.push(`${t}.${c} row id ${r.id}: ${JSON.stringify(v)} -> ${to === null ? 'NULL' : JSON.stringify(to)}`);
          r[c] = to;
        }
      }
    }

    // What is there now, so the report says what the restore costs.
    const nowCounts = {};
    for (const t of order) {
      const [{ n }] = await q(`SELECT COUNT(*) AS n FROM \`${t}\` WHERE company_id = ?`, [snap.company.id]);
      nowCounts[t] = n;
    }

    const wide = Math.max(...order.map((t) => t.length));
    console.log(`  ${'table'.padEnd(wide)}   now  ->  after`);
    let del = 0;
    let ins = 0;
    for (const t of order) {
      const want = snap.data[t].rows.length;
      if (!nowCounts[t] && !want) continue;
      console.log(
        `  ${t.padEnd(wide)} ${String(nowCounts[t]).padStart(5)}  -> ${String(want).padStart(6)}` +
        `${nowCounts[t] === want ? '' : '   <-- changes'}`,
      );
      del += nowCounts[t];
      ins += want;
    }
    console.log(`\n  delete ${del} rows, insert ${ins} rows`);
    if (missing.length) console.log(`  in the snapshot but not in this schema, skipped: ${missing.join(', ')}`);
    const excluded = Object.entries(snap.data).flatMap(([t, d]) => (d.excludedColumns || []).map((c) => `${t}.${c}`));
    if (excluded.length) console.log(`  not captured by the snapshot, will be left NULL: ${excluded.join(', ')}`);
    if (dropped.length) console.log(`  in the snapshot but not a writable column here, DROPPED: ${dropped.join(', ')}`);
    if (defaulted.length) console.log(`  a column here that the snapshot has no value for, left at its default: ${defaulted.join(', ')}`);
    if (coerced.length) {
      console.log(`  values this schema will not accept, substituted (${coerced.length}):`);
      for (const line of coerced) console.log(`    ${line}`);
      console.log('    (the substitute is the column default, which need not be the truth - check these by hand)');
    }

    if (!apply) {
      console.log('\n  dry run - pass --apply to write\n');
      return;
    }

    await conn.query('SET FOREIGN_KEY_CHECKS = 0');
    await conn.beginTransaction();
    try {
      for (const t of [...order].reverse()) {
        await conn.execute(`DELETE FROM \`${t}\` WHERE company_id = ?`, [snap.company.id]);
      }
      for (const t of order) {
        const rows = snap.data[t].rows;
        if (!rows.length) continue;
        const here = writable(t);
        const cols = Object.keys(rows[0]).filter((c) => here.has(c));
        if (!cols.length) continue;
        const list = cols.map((c) => `\`${c}\``).join(', ');
        const marks = `(${cols.map(() => '?').join(', ')})`;
        // Chunked, not one statement per row: a round trip costs ~49 ms over the
        // link, and 1,342 of them is a minute of waiting for no reason.
        for (let i = 0; i < rows.length; i += 200) {
          const chunk = rows.slice(i, i + 200);
          await conn.query(
            `INSERT INTO \`${t}\` (${list}) VALUES ${chunk.map(() => marks).join(', ')}`,
            chunk.flatMap((r) => cols.map((c) => bind(r[c]))),
          );
        }
      }
      await conn.commit();
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      await conn.query('SET FOREIGN_KEY_CHECKS = 1');
    }

    // Prove it rather than trusting that it worked.
    let bad = 0;
    for (const t of order) {
      const [{ n }] = await q(`SELECT COUNT(*) AS n FROM \`${t}\` WHERE company_id = ?`, [snap.company.id]);
      if (n !== snap.data[t].rows.length) {
        console.log(`  MISMATCH ${t}: ${n} rows here, ${snap.data[t].rows.length} in the snapshot`);
        bad++;
      }
    }
    console.log(bad ? `\n  RESTORED WITH ${bad} MISMATCHES\n` : '\n  restored, every table matches the snapshot\n');
    if (bad) process.exitCode = 1;
  } finally {
    await conn.end();
  }
};

main().catch((e) => {
  console.error(`\n  FAILED: ${e.message}\n`);
  process.exit(1);
});
