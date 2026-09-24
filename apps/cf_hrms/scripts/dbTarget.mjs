/**
 * Where a cf_hrms script writes. Local by default; production only when asked
 * for by name, out loud, on the command line.
 *
 *   node <script>.mjs                 -> localhost/sqldb
 *   node <script>.mjs --target=prod   -> TiDB, credentials from TM/.env.tidb
 *
 * The credentials are read from the file and never printed. The default is
 * local on purpose: a script that defaults to production is one mistyped
 * command away from being a production incident.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const TM_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

export function resolveTarget(argv = process.argv) {
  const wantsProd = argv.some((a) => a === '--target=prod' || a === '--prod');
  if (!wantsProd) {
    return {
      name: 'LOCAL (localhost/sqldb)',
      isProd: false,
      cfg: { host: 'localhost', user: 'root', password: '1234', database: 'sqldb', port: 3306 },
    };
  }

  const envPath = path.join(TM_ROOT, '.env.tidb');
  if (!fs.existsSync(envPath)) throw new Error(`--target=prod but no .env.tidb at ${envPath}`);
  const env = {};
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  const missing = ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME'].filter((k) => !env[k]);
  if (missing.length) throw new Error(`.env.tidb is missing ${missing.join(', ')}`);

  return {
    name: `PRODUCTION TiDB (${env.DB_NAME} @ ${env.DB_HOST.split('.')[0]}…)`,
    isProd: true,
    cfg: {
      host: env.DB_HOST, port: Number(env.DB_PORT), user: env.DB_USER,
      password: env.DB_PASSWORD, database: env.DB_NAME,
      ssl: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
    },
  };
}

/** Say out loud which database is about to be written to. */
export function announce(target) {
  console.log(`\n  target: ${target.name}${target.isProd ? '   *** PRODUCTION ***' : ''}\n`);
}
