// prodDb.mjs — what `--prod` means for every script: the production database, which is the MySQL on the AWS
// Lightsail server (app.ceofactory.vc / api.ceofactory.vc). TiDB, Render and Vercel were retired on 2026-11-28.
//
//   import { useProdDb } from '../lib/prodDb.mjs';
//   if (process.argv.includes('--prod')) await useProdDb();   // BEFORE db.js is imported
//
// ON the server (the repo lives in /srv/tm, or TM_ON_SERVER=1): the backend's own .env — the server's MySQL.
// On the laptop: the ssh tunnel 127.0.0.1:3307 -> the server's MySQL, user and password from TM/.env.aws
// (AWS_DB_PORT, AWS_DB_USER, AWS_DB_PASSWORD, AWS_DB_NAME; AWS_HOST and AWS_KEY for ssh). When nothing answers on
// the tunnel port, this opens one for the life of the script; if ssh cannot get through (this laptop's IP changed),
// it says to run `node lightsail/prod.mjs tunnel`, which allows the IP and keeps a tunnel open.
//
// It sets DB_HOST / DB_PORT / DB_USER / DB_PASSWORD / DB_NAME / DB_SSL in process.env (what db.js reads) and returns
// the same as mysql2 connection options for scripts that open their own connection (plus a non-enumerable `label`,
// e.g. "PRODUCTION AWS (MySQL sqldb via tunnel 127.0.0.1:3307)"). Nothing here prints a password.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TM = path.resolve(REPO, '..');

/** True when this runs on the production server itself. */
export const onServer = () => process.env.TM_ON_SERVER === '1' || REPO.replace(/\\/g, '/').startsWith('/srv/tm/');

function readEnv(file) {
  const o = {};
  if (!fs.existsSync(file)) return o;
  for (const l of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = l.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) o[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return o;
}

const answers = (port, host = '127.0.0.1') => new Promise((res) => {
  const s = net.connect(port, host); s.setTimeout(3000);
  s.once('connect', () => { s.destroy(); res(true); });
  s.once('error', () => res(false));
  s.once('timeout', () => { s.destroy(); res(false); });
});

let tunnel = null;
/** Opens ssh -L <port>:127.0.0.1:3306 for the life of this process; resolves true once the port answers. */
async function openTunnel(aws, port) {
  const key = aws.AWS_KEY ? path.resolve(TM, aws.AWS_KEY) : null;
  if (!aws.AWS_HOST || !key || !fs.existsSync(key)) return { ok: false, why: 'TM/.env.aws has no usable AWS_HOST / AWS_KEY' };
  let why = '';
  tunnel = spawn('ssh', ['-i', key, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15',
    '-o', 'ExitOnForwardFailure=yes', '-N', '-L', `${port}:127.0.0.1:3306`, `ubuntu@${aws.AWS_HOST}`], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  tunnel.stderr.on('data', (d) => { why += String(d); });
  let exited = false;
  tunnel.once('exit', () => { exited = true; });
  tunnel.once('error', (e) => { exited = true; why += e.message; });
  process.once('exit', () => { try { tunnel?.kill(); } catch { /* gone */ } });
  for (let i = 0; i < 40 && !exited; i++) {
    if (await answers(port)) {
      tunnel.stderr.removeAllListeners('data'); tunnel.stderr.destroy(); tunnel.unref();
      return { ok: true };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  try { tunnel.kill(); } catch { /* gone */ }
  return { ok: false, why: why.split('\n').filter((l) => l && !/Warning: Permanently added/i.test(l)).join(' ').slice(0, 300) || 'ssh did not open the tunnel in 20 s' };
}

/**
 * The production connection options without touching the network: { cfg, label, tunnelPort (null on the server) }.
 * For callers that cannot await (cf_hrms dbTarget.mjs); on the laptop the tunnel must already be open.
 */
export function prodConfig() {
  let cfg, label, tunnelPort = null;
  if (onServer()) {
    const env = readEnv(path.join(REPO, '.env'));
    cfg = { host: env.DB_HOST || '127.0.0.1', port: Number(env.DB_PORT || 3306), user: env.DB_USER, password: env.DB_PASSWORD, database: env.DB_NAME };
    label = `PRODUCTION AWS (server MySQL, ${cfg.database})`;
  } else {
    const aws = readEnv(path.join(TM, '.env.aws'));
    tunnelPort = Number(aws.AWS_DB_PORT || 3307);
    const missing = ['AWS_DB_USER', 'AWS_DB_PASSWORD', 'AWS_DB_NAME'].filter((k) => !aws[k]);
    if (missing.length) throw new Error(`--prod: TM/.env.aws is missing ${missing.join(', ')} (the production MySQL user the laptop uses through the tunnel)`);
    cfg = { host: '127.0.0.1', port: tunnelPort, user: aws.AWS_DB_USER, password: aws.AWS_DB_PASSWORD, database: aws.AWS_DB_NAME };
    label = `PRODUCTION AWS (MySQL ${cfg.database} via tunnel 127.0.0.1:${tunnelPort})`;
  }
  if (!cfg.user || !cfg.password || !cfg.database) throw new Error('--prod: the production database user, password or name is not set');
  return { cfg, label, tunnelPort };
}

/**
 * Points this process at production: on the laptop makes sure the tunnel answers (opening one if not), then sets
 * DB_* in process.env. Returns mysql2 options { host, port, user, password, database } with a non-enumerable label.
 * Call before db.js (or anything that imports it) is imported.
 */
export async function useProdDb() {
  const { cfg, label, tunnelPort } = prodConfig();
  if (tunnelPort && !(await answers(tunnelPort))) {
    const r = await openTunnel(readEnv(path.join(TM, '.env.aws')), tunnelPort);
    if (!r.ok) {
      throw new Error(`--prod: nothing answers on 127.0.0.1:${tunnelPort} (the tunnel to the AWS MySQL) and ssh could not open it: ${r.why}\n`
        + '  Start it from the TM folder and leave it running:  node lightsail/prod.mjs tunnel\n'
        + "  (it adds this laptop's current IP to the SSH rule with the aws CLI, profile tm, when needed)");
    }
    console.error(`--prod: opened an ssh tunnel to the AWS MySQL on 127.0.0.1:${tunnelPort} for this run`);
  }
  Object.assign(process.env, {
    DB_HOST: cfg.host, DB_PORT: String(cfg.port), DB_USER: cfg.user, DB_PASSWORD: cfg.password, DB_NAME: cfg.database, DB_SSL: 'false',
  });
  // label is not enumerable, so the result can go straight to mysql2.createConnection (which warns on unknown keys).
  return Object.defineProperty({ ...cfg }, 'label', { value: label, enumerable: false });
}
