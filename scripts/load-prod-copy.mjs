// load-prod-copy.mjs — REPLACE the LOCAL sqldb data with an export made by export-prod-data.mjs.
// DESTRUCTIVE for local data (schema kept; every base table truncated). Requires --yes.
// Usage: node scripts/load-prod-copy.mjs <prod_data.sql> --yes   then: node fix-passwords.js --reset-all (from TM root)
if (!process.argv.includes('--yes')) { console.error('Refusing: this truncates every local table. Pass --yes.'); process.exit(2); }
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire('C:/Users/Digital Initiatives/Desktop/TM/multi_app_be/package.json');
const mysql = require('mysql2/promise');
const MYSQL = 'C:/Program Files/MySQL/MySQL Server 8.0/bin/mysql.exe';
const DUMP = process.argv[2];
const local = await mysql.createConnection({ host: 'localhost', port: 3306, user: 'root', password: '1234', database: 'sqldb', multipleStatements: true });

const [tables] = await local.query(`SELECT TABLE_NAME t FROM information_schema.TABLES WHERE TABLE_SCHEMA='sqldb' AND TABLE_TYPE='BASE TABLE'`);
console.log(`local base tables: ${tables.length}`);
await local.query('SET GLOBAL max_allowed_packet = 268435456');
await local.query('SET FOREIGN_KEY_CHECKS = 0');
for (const { t } of tables) await local.query(`TRUNCATE TABLE \`${t}\``);
console.log('truncated all local tables');
await local.end();

const sql = `SET FOREIGN_KEY_CHECKS=0; SET UNIQUE_CHECKS=0; SET SESSION sql_mode=''; SOURCE ${DUMP.replace(/\\/g, '/')}; SET FOREIGN_KEY_CHECKS=1; SET UNIQUE_CHECKS=1;`;
const r = spawnSync(MYSQL, ['-uroot', '--max-allowed-packet=256M', '--default-character-set=utf8mb4', 'sqldb', '-e', sql], {
  env: { ...process.env, MYSQL_PWD: '1234' }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
});
console.log('load exit', r.status, (r.stderr || '').split('\n').filter((l) => l && !/insecure/i.test(l)).slice(0, 20).join('\n'));

// verify: rows per table now vs INSERT statements' table list
const c2 = await mysql.createConnection({ host: 'localhost', port: 3306, user: 'root', password: '1234', database: 'sqldb' });
const dumpText = fs.readFileSync(DUMP, 'utf8');
const dumped = new Set([...dumpText.matchAll(/^INSERT INTO `([a-z_0-9]+)`/gm)].map((m) => m[1]));
let total = 0; const rows = [];
for (const { t } of tables) { const [[{ n }]] = await c2.query(`SELECT COUNT(*) n FROM \`${t}\``); total += Number(n); rows.push([t, Number(n), dumped.has(t) ? 'in dump' : '(no rows in prod)']); }
rows.sort((a, b) => b[1] - a[1]);
console.log('\nrows after load (top 30):'); for (const r2 of rows.slice(0, 30)) console.log(`  ${r2[0]}: ${r2[1]} ${r2[2]}`);
console.log(`\ntotal rows: ${total}; tables with data: ${rows.filter((x) => x[1] > 0).length}; tables in dump: ${dumped.size}`);
const missing = [...dumped].filter((t) => !rows.find((x) => x[0] === t && x[1] > 0));
console.log('dumped tables that ended up EMPTY locally (load problem):', missing.join(', ') || '(none)');
await c2.end();
