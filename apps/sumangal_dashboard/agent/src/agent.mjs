/**
 * Sumangal ERP agent. Runs on a machine inside the customer's network (set up by setup.ps1, see README.md).
 *
 *   node agent.mjs test        connect to SQL Server read-only and count the rows of every table it needs
 *   node agent.mjs register    make this agent's key and register it with the dashboard (an admin then approves it)
 *   node agent.mjs status      ask the dashboard whether this agent is approved
 *   node agent.mjs run         the nightly run: read the ERP into a local working copy, build the dashboard
 *                              dataset here, send it (gzipped), report, delete the working copy
 *     --source=sqlite:<file>   skip SQL Server and build from an existing SQLite copy (for testing)
 *     --keep                   keep the working copy
 *
 * Read-only towards the ERP by construction: the only statements it sends are generated SELECTs from a fixed list of
 * tables (tables.json) and SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED (so the nightly read never blocks
 * anyone entering data), and assertSelectOnly() refuses anything else before it reaches the server.
 * Secrets (the SQL password, the agent key) are kept encrypted with Windows DPAPI for the user running the agent.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import crypto from 'crypto';
import { spawnSync, execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { DatabaseSync } from 'node:sqlite';
import { Connection, Request } from 'tedious';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const CONFIG = path.join(DIR, 'config.json');
const WORK = path.join(DIR, 'work');
const LOGS = path.join(DIR, 'logs');
const VERSION = '2026-11-23';
fs.mkdirSync(WORK, { recursive: true }); fs.mkdirSync(LOGS, { recursive: true });

// ---------- log
const logFile = path.join(LOGS, `agent-${new Date().toISOString().slice(0, 10)}.log`);
const log = (...a) => { const line = `${new Date().toISOString()} ${a.join(' ')}`; console.log(line); fs.appendFileSync(logFile, line + '\n'); };

// ---------- settings and secrets
const cfg = () => { if (!fs.existsSync(CONFIG)) throw new Error('config.json not found. Run setup.ps1 first.'); return JSON.parse(fs.readFileSync(CONFIG, 'utf8')); };
const saveCfg = (c) => fs.writeFileSync(CONFIG, JSON.stringify(c, null, 2));
const ps = (script, input) => {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { input, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error('PowerShell: ' + (r.stderr || r.stdout || '').trim().slice(0, 300));
  return r.stdout.trim();
};
/** DPAPI, current Windows user: the same as PowerShell's ConvertFrom-SecureString / ConvertTo-SecureString. */
const protect = (plain) => ps('$s = [Console]::In.ReadToEnd(); ConvertTo-SecureString -String $s -AsPlainText -Force | ConvertFrom-SecureString', plain);
const unprotect = (cipher) => ps('$c = [Console]::In.ReadToEnd().Trim(); $s = ConvertTo-SecureString $c; [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))', cipher);
const secret = (name) => { const f = path.join(DIR, name); if (!fs.existsSync(f)) throw new Error(`${name} not found. Run setup.ps1 first.`); return unprotect(fs.readFileSync(f, 'utf8')); };

// ---------- SQL Server (read-only)
function assertSelectOnly(sql) {
  const s = sql.trim().replace(/\s+/g, ' ');
  const ok = /^SELECT /i.test(s) || /^SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;?$/i.test(s);
  if (!ok || /;\s*\S/.test(s) || /\b(INSERT|UPDATE|DELETE|MERGE|DROP|ALTER|CREATE|EXEC|EXECUTE|TRUNCATE|GRANT|DENY|INTO)\b/i.test(s.replace(/'[^']*'/g, ''))) throw new Error('Refused, not a plain SELECT: ' + s.slice(0, 120));
  return sql;
}
function connect(c) {
  const [host, instance] = String(c.server).split('\\');
  const auth = c.auth === 'windows'
    ? { type: 'ntlm', options: { userName: c.user.split('\\').pop(), domain: c.user.includes('\\') ? c.user.split('\\')[0] : (c.domain || ''), password: secret('sql.sec') } }
    : { type: 'default', options: { userName: c.user, password: secret('sql.sec') } };
  const options = { database: c.database || 'Casting_DB', encrypt: !!c.encrypt, trustServerCertificate: true, tdsVersion: c.tdsVersion || '7_3_B', connectTimeout: 30000, requestTimeout: 0, rowCollectionOnDone: false, rowCollectionOnRequestCompletion: false, useUTC: true, readOnlyIntent: true };
  if (instance) options.instanceName = instance; else options.port = +(c.port || 1433);
  return new Promise((resolve, reject) => { const conn = new Connection({ server: host, authentication: auth, options }); conn.on('connect', (e) => (e ? reject(e) : resolve(conn))); conn.connect(); });
}
/** Runs one SELECT and hands each row (array of values) to onRow. */
function query(conn, sql, onRow) {
  assertSelectOnly(sql);
  return new Promise((resolve, reject) => {
    let cols = null; let n = 0;
    const req = new Request(sql, (err) => (err ? reject(err) : resolve(n)));
    req.on('columnMetadata', (m) => { cols = m.map((x) => x.colName); });
    req.on('row', (row) => { n++; onRow && onRow(row.map((x) => x.value), cols); });
    conn.execSql(req);
  });
}
const exec = (conn, sql) => new Promise((resolve, reject) => { assertSelectOnly(sql); conn.execSqlBatch(new Request(sql, (e) => (e ? reject(e) : resolve()))); });
const SKIP_TYPES = new Set(['image', 'varbinary', 'binary', 'timestamp', 'rowversion', 'xml', 'geography', 'geometry', 'hierarchyid', 'sql_variant']);
const pad = (x) => String(x).padStart(2, '0');
const val = (v) => (v == null ? null : v instanceof Date ? `${v.getUTCFullYear()}-${pad(v.getUTCMonth() + 1)}-${pad(v.getUTCDate())} ${pad(v.getUTCHours())}:${pad(v.getUTCMinutes())}:${pad(v.getUTCSeconds())}` : typeof v === 'boolean' ? (v ? 1 : 0) : typeof v === 'bigint' ? Number(v) : Buffer.isBuffer(v) ? null : v);
const TABLES = () => JSON.parse(fs.readFileSync(path.join(DIR, 'tables.json'), 'utf8'));

/** Copies the needed tables, read-only, into a local SQLite file with the same table and column names. */
async function extract(dbFile) {
  const c = cfg(); const conn = await connect(c); const t0 = Date.now(); let total = 0;
  try {
    await exec(conn, 'SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED');
    if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile);
    const db = new DatabaseSync(dbFile); db.exec('PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF;');
    for (const t of TABLES()) {
      if (!/^tbl_[a-z0-9_]+$/i.test(t)) throw new Error('Bad table name in tables.json: ' + t);
      const cols = []; await query(conn, `SELECT c.name, ty.name FROM sys.columns c JOIN sys.types ty ON ty.user_type_id = c.user_type_id WHERE c.object_id = OBJECT_ID(N'dbo.${t}') ORDER BY c.column_id`, (r) => { if (!SKIP_TYPES.has(String(r[1]).toLowerCase())) cols.push(r[0]); });
      if (!cols.length) { log(`  ${t}: not found, skipped`); continue; }
      db.exec(`CREATE TABLE "${t}" (${cols.map((x) => `"${x}"`).join(', ')})`);
      const ins = db.prepare(`INSERT INTO "${t}" VALUES (${cols.map(() => '?').join(', ')})`);
      db.exec('BEGIN');
      const n = await query(conn, `SELECT ${cols.map((x) => `[${x}]`).join(', ')} FROM [dbo].[${t}]`, (r) => ins.run(...r.map(val)));
      db.exec('COMMIT'); total += n;
      log(`  ${t}: ${n} rows`);
    }
    db.close();
  } finally { conn.close(); }
  log(`read ${total} rows from SQL Server in ${Math.round((Date.now() - t0) / 1000)} s`);
  return total;
}

// ---------- dashboard API
const api = async (method, p, body, headers = {}) => {
  const c = cfg(); const url = `${c.api.replace(/\/$/, '')}/api/${c.company}/sumangal_dashboard${p}`;
  const h = { ...headers }; if (c.agentUid && p !== '/agent/register') { h['X-Agent-Uid'] = c.agentUid; h.Authorization = `Bearer ${secret('agent.sec')}`; }
  let b = body; if (body && !Buffer.isBuffer(body)) { b = JSON.stringify(body); h['Content-Type'] = 'application/json'; }
  const r = await fetch(url, { method, headers: h, body: b }); const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = { raw: t.slice(0, 200) }; }
  if (!r.ok) throw new Error(`${method} ${p}: ${r.status} ${j.error || j.raw || ''}`);
  return j;
};

// ---------- commands
async function cmdTest() {
  const c = cfg(); log(`agent ${VERSION}: testing ${c.server} / ${c.database || 'Casting_DB'} as ${c.user}`);
  const conn = await connect(c); let missing = 0;
  try {
    await query(conn, 'SELECT @@VERSION', (r) => log('  SQL Server: ' + String(r[0]).split('\n')[0]));
    for (const t of TABLES()) { let n = null; try { await query(conn, `SELECT COUNT(*) FROM [dbo].[${t}]`, (r) => { n = r[0]; }); } catch (e) { missing++; log(`  ${t}: ${e.message}`); continue; } log(`  ${t}: ${n} rows`); }
  } finally { conn.close(); }
  log(missing ? `${missing} tables could not be read` : 'all tables readable'); if (missing) process.exitCode = 1;
}
async function cmdRegister() {
  const c = cfg(); if (c.agentUid) { log('already registered as ' + c.agentUid); return cmdStatus(); }
  const uid = crypto.randomUUID(); const key = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(path.join(DIR, 'agent.sec'), protect(key));
  const r = await api('POST', '/agent/register', { agentUid: uid, keyHash: crypto.createHash('sha256').update(key).digest('hex'), machine: os.hostname(), winUser: os.userInfo().username });
  c.agentUid = uid; saveCfg(c); log(`registered as agent ${r.id} (${r.status}). Ask the dashboard admin to approve it.`);
}
async function cmdStatus() { const r = await api('GET', '/agent/status'); log(`agent ${r.id}: ${r.status}`); }
async function cmdRun(args) {
  const t0 = Date.now(); const keep = args.includes('--keep'); const src = (args.find((a) => a.startsWith('--source=sqlite:')) || '').slice('--source=sqlite:'.length);
  const dbFile = src || path.join(WORK, 'erp.sqlite');
  try {
    log(`agent ${VERSION}: nightly run`);
    const st = await api('GET', '/agent/status'); if (st.status !== 'approved') throw new Error(`this agent is ${st.status}; an admin has to approve it first`);
    if (!src) await extract(dbFile); else log('using existing copy ' + dbFile);
    log('building the dashboard dataset');
    execFileSync(process.execPath, ['--no-warnings', path.join(DIR, 'build-v15.mjs')], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, SUMANGAL_DB: dbFile, SUMANGAL_WORK: WORK }, maxBuffer: 64 * 1024 * 1024 });
    const json = fs.readFileSync(path.join(WORK, 'v15.json')); const gz = zlib.gzipSync(json, { level: 9 });
    fs.writeFileSync(path.join(DIR, 'last-sent.json.gz'), gz);
    log(`sending ${Math.round(gz.length / 1024)} KB (${Math.round(json.length / 1024 / 1024)} MB unpacked)`);
    const r = await api('POST', '/agent/push', gz, { 'Content-Type': 'application/octet-stream' });
    const secs = Math.round((Date.now() - t0) / 1000); log(`stored on the dashboard (${r.chunks} chunks) in ${secs} s`);
    await api('POST', '/agent/report', { ok: true, message: `sent ${Math.round(gz.length / 1024)} KB`, seconds: secs });
  } catch (e) {
    log('FAILED: ' + e.message);
    try { await api('POST', '/agent/report', { ok: false, message: e.message.slice(0, 480), seconds: Math.round((Date.now() - t0) / 1000) }); } catch { /* the report itself failed: the log keeps it */ }
    process.exitCode = 1;
  } finally {
    if (!keep) for (const f of ['erp.sqlite', 'v15.json', 'v13-data.js', 'supp.json', 'hist.json']) { const p = path.join(WORK, f); if (p !== src && fs.existsSync(p)) fs.unlinkSync(p); }
  }
}

const [cmd, ...args] = process.argv.slice(2);
const cmds = { test: cmdTest, register: cmdRegister, status: cmdStatus, run: () => cmdRun(args) };
if (!cmds[cmd]) { console.log('Usage: node agent.mjs test | register | status | run [--source=sqlite:<file>] [--keep]'); process.exit(cmd ? 1 : 0); }
cmds[cmd]().catch((e) => { log('FAILED: ' + e.message); process.exit(1); });
