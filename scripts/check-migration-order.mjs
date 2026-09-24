/**
 * check-migration-order.mjs — can these schema files actually build a database?
 *
 * WHY THIS EXISTS. On 2026-09-24 three bugs of one shape turned up in a single
 * afternoon, across two apps and the platform core:
 *
 *   - cf_hrms  guarded ALTER on hrms_audit_log sat ~500 lines above the CREATE
 *              of that table. Aborted production at 35 of 46 tables.
 *   - core     role_capability was created with foreign keys into roles, teams,
 *              companies and apps — all created below it. No new environment
 *              could be built from the migration files at all.
 *   - fab_erp  fab_order_lines is ALTERed (including DROP COLUMN) from line 914
 *              and created at line 4256.
 *
 * Every one of them had worked for months, because `CREATE TABLE IF NOT EXISTS`
 * is a no-op on a database that already has the table. Ordering is therefore
 * exercised exactly once — the first time a file meets an empty schema. For all
 * three, that first time was going to be production.
 *
 * This script asks the question statically, in a second, without a database:
 *   for every ALTER TABLE X / DROP ... X / REFERENCES X,
 *   is X created ABOVE that line, in the same file or an earlier one?
 *
 * It is deliberately dumb and textual. It will not catch everything a real
 * apply would (it does not evaluate an IF-guard, or know that a table lives in
 * another schema). It catches the one mistake that has actually been made here,
 * three times, and it is cheap enough to run before every push.
 *
 *   node scripts/check-migration-order.mjs            # the sanctioned set, in order
 *   node scripts/check-migration-order.mjs a.sql b.sql
 *
 * Exit code 1 when anything is out of order, so it can gate a push.
 *
 * A clean run is NOT proof the file builds — a table whose CREATE is missing
 * entirely is reported separately, because that is the other half of what went
 * wrong (fab_orders and fab_item_catalog are defined only in a mysqldump, not
 * in any migration file).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/** The set push-to-prod applies, in the order it applies them. Keep in step with that command. */
const SANCTIONED = [
  'models/core-init.sql',
  'apps/audio_intelligence/models/init.sql',
  'apps/fab_erp/models/init.sql',
  'apps/fab_flow/models/init.sql',
  'apps/cf_erp/modules/parties/models/init.sql',
  'apps/cf_erp/models/init.sql',
  'apps/cf_erp/modules/codegen/models/init.sql',
  'apps/cf_hrms/models/init.sql',
];

const strip = (sql) =>
  sql
    .split('\n')
    .map((line) => {
      const i = line.indexOf('--');
      return i === -1 ? line : line.slice(0, i);
    })
    .join('\n');

const name = (raw) => String(raw || '').replace(/[`'"]/g, '').trim().toLowerCase();

function scan(files) {
  /** table -> { file, line } of its first CREATE, across all files in apply order. */
  const created = new Map();
  const problems = [];
  const referenced = new Set();

  for (const rel of files) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) {
      problems.push({ kind: 'MISSING FILE', file: rel, line: 0, detail: 'not found' });
      continue;
    }
    const lines = strip(fs.readFileSync(abs, 'utf8')).split('\n');

    // Pass 1: every CREATE TABLE in this file, so a reference later in the SAME
    // file to a table created further down is still caught as out of order.
    lines.forEach((text, i) => {
      const m = text.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([`"']?[\w.]+[`"']?)/i);
      if (m) {
        const t = name(m[1]);
        if (!created.has(t)) created.set(t, { file: rel, line: i + 1 });
      }
    });

    // Pass 2: every use, checked against where its target is created.
    lines.forEach((text, i) => {
      const uses = [
        ...[...text.matchAll(/ALTER\s+TABLE\s+([`"']?[\w.]+[`"']?)/gi)].map((m) => ['ALTER', m[1]]),
        ...[...text.matchAll(/REFERENCES\s+([`"']?[\w.]+[`"']?)/gi)].map((m) => ['REFERENCES', m[1]]),
      ];

      // `DROP TABLE IF EXISTS x` where x is never created is RETIREMENT, not a
      // bug — it is how a file cleans up a table an older version made. Only a
      // guardless DROP is worth reporting, and even then only as its own class.
      for (const m of text.matchAll(/DROP\s+TABLE\s+(IF\s+EXISTS\s+)?([`"']?[\w.]+[`"']?)/gi)) {
        if (m[1]) continue;
        uses.push(['DROP TABLE without IF EXISTS', m[2]]);
      }

      for (const [kind, rawTarget] of uses) {
        const t = name(rawTarget);
        if (!t) continue;
        referenced.add(t);
        const at = created.get(t);
        if (!at) {
          problems.push({
            kind: `${kind} a table never created`,
            file: rel, line: i + 1, detail: t,
          });
        } else if (at.file === rel && at.line > i + 1) {
          problems.push({
            kind: `${kind} above its own CREATE`,
            file: rel, line: i + 1,
            detail: `${t} is created at line ${at.line} of this file`,
          });
        }
      }
    });
  }
  return { created, problems, referenced };
}

const files = process.argv.slice(2).length ? process.argv.slice(2) : SANCTIONED;
const { created, problems } = scan(files);

console.log(`Checked ${files.length} file(s), ${created.size} tables created.\n`);

if (!problems.length) {
  console.log('No ordering problems. Every ALTER, DROP and REFERENCES targets a table');
  console.log('created above it, in this file or an earlier one.');
  console.log('\nThis does NOT prove the files build — run them into an empty schema to know that.');
  process.exit(0);
}

const byKind = problems.reduce((acc, p) => ((acc[p.kind] ??= []).push(p), acc), {});
for (const [kind, list] of Object.entries(byKind)) {
  console.log(`${kind}  (${list.length})`);
  for (const p of list) console.log(`   ${p.file}:${p.line}  ${p.detail}`);
  console.log('');
}
console.log(`${problems.length} problem(s). A file in this state cannot build an empty database.`);
process.exit(1);
