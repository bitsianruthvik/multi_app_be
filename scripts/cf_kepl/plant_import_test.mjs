/** Compare the plant importer with its original service path, locally only.
 * Requires the private TM/imports/Process_Flow_v5.xlsx workbook. Both imports
 * roll back; private snapshots stay in ignored scripts/_scratch. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pool } from '../../db.js';

if (!/^(localhost|127\.0\.0\.1|::1)$/.test(process.env.DB_HOST ?? 'localhost')) throw new Error('This suite is local only.');
const company = String(process.env.CF_PLANT_TEST_COMPANY ?? 2);
const folder = path.resolve('scripts/_scratch');
await fs.mkdir(folder, { recursive: true });
const [tables] = await pool.query("SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME LIKE 'cf\\_%'");
const count = async () => (await pool.query(tables.map((t) => `SELECT '${t.name}' AS name,COUNT(*) AS n FROM \`${t.name}\``).join(' UNION ALL ')))[0];
const before = await count();
let passed = 0, failed = 0;
function ok(label, condition) { console.log(`${condition ? 'PASS' : 'FAIL'} ${label}`); condition ? passed++ : failed++; }
try {
  const outputs = [];
  for (const mode of ['serial', 'bulk']) {
    const file = path.join(folder, `plant-golden-${mode}.json`);
    const { stdout, stderr } = await promisify(execFile)(process.execPath, ['scripts/cf_kepl/cf_plant_machines.mjs', ...(mode === 'serial' ? ['--serial'] : ['--verify-repeat'])], {
      cwd: process.cwd(), env: { ...process.env, CF_BRIDGE_COMPANY: company, CF_PLANT_SNAPSHOT: file }, maxBuffer: 2 * 1024 * 1024,
    });
    await fs.writeFile(path.join(folder, `plant-local-${mode}.log`), stdout + stderr);
    outputs.push(JSON.parse(await fs.readFile(file, 'utf8')));
    ok(`${mode} import rolled back every CF table`, JSON.stringify(await count()) === JSON.stringify(before));
    if (mode === 'bulk') ok('repeating the import creates no duplicates', stdout.includes('repeat import created no duplicate assets'));
  }
  const [serial, bulk] = outputs;
  ok('all 566 machines and their values match the service path', new Set(bulk.values.map((v) => v.code)).size === 566 && JSON.stringify(serial.values) === JSON.stringify(bulk.values));
  ok('specification history matches the service path', JSON.stringify(serial.history) === JSON.stringify(bulk.history));
  ok('bulk path cuts database round trips by at least 40%', bulk.queryCount < serial.queryCount * 0.6);
  console.log(`${serial.values.length} value rows; ${serial.history.length} history groups; ${serial.queryCount} → ${bulk.queryCount} round trips (including repeat check).`);
} catch (e) { failed++; console.error('FAIL', e.message); }
finally { await pool.end(); }
console.log(`${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
