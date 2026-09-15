// export-prod-data.mjs — READ-ONLY export of production DATA (no DDL) for a local copy.
// Usage: node scripts/export-prod-data.mjs <out.sql>   (credentials from ../.env.tidb via MYSQL_PWD; never printed)
// TiDB has no savepoints in mysqldump's --single-transaction mode, so that flag is deliberately absent.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
const env = Object.fromEntries(fs.readFileSync('C:/Users/Digital Initiatives/Desktop/TM/.env.tidb', 'utf8').split(/\r?\n/)
  .filter((l) => l.includes('=') && !l.startsWith('#')).map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"|"$/g, '')]; }));
const out = process.argv[2];
const args = [
  '-h', env.DB_HOST, '-P', String(env.DB_PORT || 4000), '-u', env.DB_USER,
  '--ssl-mode=REQUIRED', '--default-character-set=utf8mb4',
  '--no-create-info', '--complete-insert', '--skip-triggers', '--hex-blob',
  '--skip-lock-tables', '--set-gtid-purged=OFF', '--column-statistics=0', '--no-tablespaces',
  '--max-allowed-packet=256M', '--net-buffer-length=1M', '--skip-add-locks',
  '--result-file=' + out,
  env.DB_NAME,
];
const r = spawnSync('C:/Program Files/MySQL/MySQL Server 8.0/bin/mysqldump.exe', args, {
  env: { ...process.env, MYSQL_PWD: env.DB_PASSWORD }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
});
const err = (r.stderr || '').replace(/password[^\n]*/gi, '[redacted]');
console.log('exit', r.status, err.trim().slice(0, 2000));
if (fs.existsSync(out)) console.log('size MB', (fs.statSync(out).size / 1048576).toFixed(1));
