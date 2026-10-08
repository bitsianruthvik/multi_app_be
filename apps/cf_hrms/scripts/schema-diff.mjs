/**
 * Compare this app's schema between LOCAL and PRODUCTION, column by column.
 *
 *   node schema-diff.mjs                 every hrms_ table
 *   node schema-diff.mjs --prefix=hrms_  (the default)
 *   node schema-diff.mjs --prefix=''     every table in the schema, core included
 *
 * READ-ONLY on both sides.
 *
 * Why: a script that works locally and fails against production usually fails
 * because the two schemas are not the same, and the failure arrives halfway
 * through writing. Running this first turns that into a list.
 *
 * It was written after a production restore rehearsal found `users.preferences`
 * live in both databases and in no migration file, and `users.team_id` NOT NULL
 * locally while production allows the NULL that 13 of its users actually hold.
 * Those were found by accident. This finds them on purpose.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import mysql from 'mysql2/promise';
import { resolveTarget } from './dbTarget.mjs';

const TM_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const args = process.argv.slice(2);
const arg = (n) => {
  const hit = args.find((a) => a === `--${n}` || a.startsWith(`--${n}=`));
  return hit ? (hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : '') : null;
};

const prefix = arg('prefix') ?? 'hrms_';

/** Everything that decides whether a value can be written, as one comparable string. */
const SHAPE = `CONCAT(
  COLUMN_TYPE, ' ',
  IF(IS_NULLABLE = 'YES', 'NULL', 'NOT NULL'),
  IFNULL(CONCAT(' DEFAULT ', COLUMN_DEFAULT), ''),
  IFNULL(CONCAT(' AS ', GENERATION_EXPRESSION), '')
)`;

/**
 * The same column shape as written by either server.
 *
 * MySQL and TiDB render a generated column's expression differently — MySQL
 * gives `if((`deleted_at` is null),lower(`code`),NULL)` where TiDB gives
 * `if(`deleted_at` is null, lower(`code`), null)`. Identical meaning, and
 * comparing the raw text reported 34 of 46 tables as differing when none did.
 * A diff tool that is 100 % false positives gets ignored, and then the one real
 * difference gets ignored with it.
 */
const canon = (shape) => String(shape)
  .toLowerCase()
  .replace(/`/g, '')
  .replace(/\\/g, '')          // MySQL escapes quotes inside a generation expression; TiDB does not
  .replace(/\s+/g, '')
  // A DECIMAL default is `0.00` on one server and `0` on the other. Same number.
  .replace(/default(-?\d+)\.0*(?=\D|$)/g, 'default$1')
  .replace(/default(-?\d+\.\d*?)0+(?=\D|$)/g, 'default$1')
  // Parentheses are dropped wholesale. MySQL parenthesises every predicate it
  // prints — `((deleted_at is null) and (is_current = 1))` where TiDB prints
  // `deleted_at is null and is_current = 1` — and matching each pattern in turn
  // is an arms race against two servers' pretty-printers. Two expressions whose
  // texts are otherwise character-identical and differ only in bracketing are
  // the same expression in every case this schema contains. The trade is
  // deliberate: it can in principle hide a genuine difference in grouping,
  // which is far cheaper than the 34 false positives the raw comparison gave.
  .replace(/[()]/g, '');

async function read(cfg) {
  const conn = await mysql.createConnection({ ...cfg, dateStrings: true });
  try {
    const [rows] = await conn.query(
      `SELECT TABLE_NAME AS t, COLUMN_NAME AS c, ${SHAPE} AS shape
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME LIKE CONCAT(?, '%')
        ORDER BY TABLE_NAME, ORDINAL_POSITION`,
      [prefix],
    );
    const byTable = new Map();
    for (const r of rows) {
      if (!byTable.has(r.t)) byTable.set(r.t, new Map());
      byTable.get(r.t).set(r.c, r.shape);
    }
    return byTable;
  } finally {
    await conn.end();
  }
}

const main = async () => {
  const local = resolveTarget([]);
  const prod = resolveTarget(['--target=prod']);
  console.log(`\n  local: ${local.name}`);
  console.log(`  prod:  ${prod.name}`);
  console.log(`  tables matching "${prefix}%"\n`);

  const [L, P] = await Promise.all([read(local.cfg), read(prod.cfg)]);

  const tables = [...new Set([...L.keys(), ...P.keys()])].sort();
  const lines = [];
  let identical = 0;

  for (const t of tables) {
    const l = L.get(t);
    const p = P.get(t);
    if (!p) { lines.push(`  ${t}  — LOCAL ONLY (${l.size} columns), production does not have this table`); continue; }
    if (!l) { lines.push(`  ${t}  — PRODUCTION ONLY (${p.size} columns), local does not have this table`); continue; }

    const diffs = [];
    for (const [c, shape] of l) {
      if (!p.has(c)) diffs.push(`      + ${c}  local only   ${shape}`);
      else if (canon(p.get(c)) !== canon(shape)) {
        diffs.push(`      ~ ${c}\n          local: ${shape}\n          prod:  ${p.get(c)}`);
      }
    }
    for (const c of p.keys()) if (!l.has(c)) diffs.push(`      - ${c}  PRODUCTION only   ${p.get(c)}`);

    if (diffs.length) lines.push(`  ${t}\n${diffs.join('\n')}`);
    else identical++;
  }

  if (lines.length) {
    console.log(lines.join('\n'));
    console.log(`\n  ${identical} of ${tables.length} tables identical, ${lines.length} differ\n`);
    process.exitCode = 1;
  } else {
    console.log(`  all ${tables.length} tables identical\n`);
  }
};

main().catch((e) => { console.error(`\n  FAILED: ${e.message}\n`); process.exit(1); });
