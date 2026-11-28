// export-prod-data.mjs — READ-ONLY export of production DATA (no DDL) for a local copy.
// Usage: node scripts/export-prod-data.mjs <out.sql>   (production = AWS via scripts/lib/prodDb.mjs; password via MYSQL_PWD, never printed)
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { useProdDb } from './lib/prodDb.mjs';
const p = await useProdDb();
const env = { DB_HOST: p.host, DB_PORT: p.port, DB_USER: p.user, DB_PASSWORD: p.password, DB_NAME: p.database };
const out = process.argv[2];
const args = [
  '-h', env.DB_HOST, '-P', String(env.DB_PORT), '-u', env.DB_USER,
  '--default-character-set=utf8mb4',
  '--no-create-info', '--complete-insert', '--skip-triggers', '--hex-blob',
  '--skip-lock-tables', '--set-gtid-purged=OFF', '--column-statistics=0', '--no-tablespaces',
  '--max-allowed-packet=256M', '--net-buffer-length=1M', '--skip-add-locks',
  '--result-file=' + out,
  env.DB_NAME,
];
const r = spawnSync(process.platform === 'win32' ? 'C:/Program Files/MySQL/MySQL Server 8.0/bin/mysqldump.exe' : 'mysqldump', args, {
  env: { ...process.env, MYSQL_PWD: env.DB_PASSWORD }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
});
const err = (r.stderr || '').replace(/password[^\n]*/gi, '[redacted]');
console.log('exit', r.status, err.trim().slice(0, 2000));
if (fs.existsSync(out)) console.log('size MB', (fs.statSync(out).size / 1048576).toFixed(1));
