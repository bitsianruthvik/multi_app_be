/**
 * Where a cf_hrms script writes. Local by default; production only when asked
 * for by name, out loud, on the command line.
 *
 *   node <script>.mjs                 -> localhost/sqldb
 *   node <script>.mjs --target=prod   -> TiDB, credentials from TM/.env.tidb
 *   node <script>.mjs --target=server -> this machine's backend database (multi_app_be/.env), e.g.
 *                                        run on the AWS Lightsail server over ssh
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
  // --target=server: the database this machine's backend uses (DB_* in multi_app_be/.env). Meant
  // for running a script ON a production server (the AWS Lightsail box, 2026-11-24), where the
  // database is local to it and its credentials never leave it.
  if (argv.includes('--target=server')) {
    const envPath = path.join(TM_ROOT, 'multi_app_be', '.env');
    const env = { ...process.env };
    if (fs.existsSync(envPath)) {
      for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
        const m = /^\s*([A-Z_]+)\s*=\s*(.*)\s*$/.exec(line);
        if (m && env[m[1]] === undefined) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    }
    const missing = ['DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME'].filter((k) => !env[k]);
    if (missing.length) throw new Error(`--target=server but ${envPath} is missing ${missing.join(', ')}`);
    return {
      name: `THIS SERVER's database (${env.DB_NAME} @ ${env.DB_HOST})`,
      isProd: env.NODE_ENV === 'production',
      cfg: { host: env.DB_HOST, port: Number(env.DB_PORT || 3306), user: env.DB_USER, password: env.DB_PASSWORD, database: env.DB_NAME },
    };
  }
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
