/**
 * Sumangal ERP agent. Runs on a machine inside the customer's network (set up by setup.ps1, see README.md).
 *
 *   node agent.mjs test        connect to SQL Server read-only, report the login's rights, count every table's rows
 *   node agent.mjs register    make this agent's key and register it with the dashboard (an admin then approves it)
 *   node agent.mjs status      ask the dashboard whether this agent is approved
 *   node agent.mjs run         nightly: copy every table afresh (never password columns) into the local working copy
 *                              (work\erp.sqlite), build the dashboard dataset here, send it gzipped, report
 *   node agent.mjs listen      any hour, every day, until stopped: whenever the dashboard asks (someone opens it or presses
 *                              "Refresh now"), read the rows changed since the last read into the copy, rebuild, send.
 *                              ('day' is the old name.) Hourly, and before the nightly run, it looks for a new version
 *                              signed by the platform team (release.json + release.sig), installs it and restarts.
 *   node agent.mjs self-update look for a new signed version now
 *   node agent.mjs update      one day-time update now (what "day" does each time)
 *     --source=sqlite:<file>   build from an existing SQLite copy instead of reading SQL Server (tests)
 *     --server-sqlite=<file>   read "the ERP" from an SQLite file instead of SQL Server (tests of run / update)
 *     --keep                   keep the intermediate files
 *
 * Read-only towards the ERP by construction: the only statements it sends are SELECTs it generates from the
 * database's own table list and SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED (so a read never blocks people entering
 * data); assertSelectOnly() refuses anything else before it reaches the server. The working copy stays on this
 * machine. Secrets (the SQL password, the agent key) are kept encrypted with Windows DPAPI for the user running it.
 *
 * Changed rows: a table with modified_date / created_date gives the rows touched since the last read (by SQL Server's
 * own clock, less 10 minutes). A table without dates follows its parent: its rows are re-read for every parent row that
 * changed (found by a column named like the parent's key), which also drops lines deleted under a changed header.
 * Rows deleted outright, or edited without a date change, show after the nightly run, which copies everything afresh.
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
const COPY = path.join(WORK, 'erp.sqlite');
const STATE = path.join(WORK, 'state.json');
const VERSION = '2026-11-26a';
// The platform team's Ed25519 public key: a new version is installed only when its file list carries their signature.
const RELEASE_KEY = 'MCowBQYDK2VwAyEAhTOWDagwzCp2/dPOPd4Tdf8HlOI2+2c5aP5grwWCdmM=';
fs.mkdirSync(WORK, { recursive: true }); fs.mkdirSync(LOGS, { recursive: true });
const ARGS = process.argv.slice(2);
const opt = (k) => (ARGS.find((a) => a.startsWith(`--${k}=`)) || '').slice(k.length + 3) || null;

// ---------- log
const logFile = () => path.join(LOGS, `agent-${new Date().toISOString().slice(0, 10)}.log`);
const log = (...a) => { const line = `${new Date().toISOString()} ${a.join(' ')}`; console.log(line); fs.appendFileSync(logFile(), line + '\n'); };

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

// ---------- the ERP side: SQL Server, read-only (or an SQLite file standing in for it in tests)
function assertSelectOnly(sql) {
  const s = sql.trim().replace(/\s+/g, ' ');
  const ok = /^SELECT /i.test(s) || /^SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;?$/i.test(s);
  if (!ok || /;\s*\S/.test(s) || /\b(INSERT|UPDATE|DELETE|MERGE|DROP|ALTER|CREATE|EXEC|EXECUTE|TRUNCATE|GRANT|DENY|INTO)\b/i.test(s.replace(/'[^']*'/g, ''))) throw new Error('Refused, not a plain SELECT: ' + s.slice(0, 120));
  return sql;
}
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ident = (x) => { if (!IDENT.test(x)) throw new Error('Bad name: ' + x); return x; };
const DT = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const pad = (x) => String(x).padStart(2, '0');
const fmtDate = (v) => `${v.getUTCFullYear()}-${pad(v.getUTCMonth() + 1)}-${pad(v.getUTCDate())} ${pad(v.getUTCHours())}:${pad(v.getUTCMinutes())}:${pad(v.getUTCSeconds())}`;
const val = (v) => (v == null ? null : v instanceof Date ? fmtDate(v) : typeof v === 'boolean' ? (v ? 1 : 0) : typeof v === 'bigint' ? Number(v) : Buffer.isBuffer(v) ? null : v);
/** Never read: passwords (tbl_user_master.login_pass and the like). */
const SECRET_COL = /pass|pwd/i;
const SKIP_TABLES = new Set(['dtproperties', 'sysdiagrams']);
const SKIP_TYPES = new Set(['image', 'varbinary', 'binary', 'timestamp', 'rowversion', 'xml', 'geography', 'geometry', 'hierarchyid', 'sql_variant']);
/** WHERE for generated SELECTs: { col, since } or { col, in: [numbers or strings] }. Values are checked, then written in. */
function whereSql(w, q, lit = (d) => d) {
  if (!w) return '';
  if (w.since) { if (!DT.test(w.since)) throw new Error('Bad date ' + w.since); return ` WHERE ${w.cols.map((c) => `${q(ident(c))} >= '${lit(w.since)}'`).join(' OR ')}`; }
  const vals = w.in.map((v) => (typeof v === 'number' && Number.isFinite(v) ? String(v) : /^[A-Za-z0-9 _./-]{1,60}$/.test(String(v)) ? `'${v}'` : (() => { throw new Error('Bad key value'); })()));
  return ` WHERE ${q(ident(w.col))} IN (${vals.join(',')})`;
}

function mssqlSource(c) {
  const [host, instance] = String(c.server).split('\\');
  const auth = c.auth === 'windows'
    ? { type: 'ntlm', options: { userName: c.user.split('\\').pop(), domain: c.user.includes('\\') ? c.user.split('\\')[0] : (c.domain || ''), password: secret('sql.sec') } }
    : { type: 'default', options: { userName: c.user, password: secret('sql.sec') } };
  const options = { database: c.database || 'Casting_DB', encrypt: !!c.encrypt, trustServerCertificate: true, tdsVersion: c.tdsVersion || '7_3_B', connectTimeout: 30000, requestTimeout: 0, rowCollectionOnDone: false, rowCollectionOnRequestCompletion: false, useUTC: true, readOnlyIntent: true };
  if (instance) options.instanceName = instance; else options.port = +(c.port || 1433);
  let conn;
  const q = (x) => `[${x}]`;
  const run = (sql, onRow) => { assertSelectOnly(sql); return new Promise((resolve, reject) => { let n = 0; const req = new Request(sql, (err) => (err ? reject(err) : resolve(n))); req.on('row', (row) => { n++; onRow && onRow(row.map((x) => x.value)); }); conn.execSql(req); }); };
  return {
    kind: 'SQL Server',
    async open() { conn = await new Promise((resolve, reject) => { const k = new Connection({ server: host, authentication: auth, options }); k.on('connect', (e) => (e ? reject(e) : resolve(k))); k.connect(); }); await new Promise((resolve, reject) => { const s = 'SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED'; assertSelectOnly(s); conn.execSqlBatch(new Request(s, (e) => (e ? reject(e) : resolve()))); }); },
    close() { conn?.close(); },
    async version() { let v = ''; await run('SELECT @@VERSION', (r) => { v = String(r[0]).split('\n')[0]; }); return v; },
    async now() { let v; await run('SELECT GETDATE()', (r) => { v = val(r[0]); }); return v; },
    async columns(t) { const out = []; await run(`SELECT c.name, ty.name FROM sys.columns c JOIN sys.types ty ON ty.user_type_id = c.user_type_id WHERE c.object_id = OBJECT_ID(N'dbo.${ident(t)}') ORDER BY c.column_id`, (r) => { if (!SKIP_TYPES.has(String(r[1]).toLowerCase()) && !SECRET_COL.test(r[0])) out.push(r[0]); }); return out; },
    async tables() { const out = []; await run("SELECT name FROM sys.tables WHERE schema_id = SCHEMA_ID('dbo') AND is_ms_shipped = 0 ORDER BY name", (r) => out.push(r[0])); return out; },
    async key(t) {
      const out = []; await run(`SELECT c.name FROM sys.indexes i JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id WHERE i.is_primary_key = 1 AND i.object_id = OBJECT_ID(N'dbo.${ident(t)}') ORDER BY ic.key_ordinal`, (r) => out.push(r[0]));
      if (!out.length) await run(`SELECT name FROM sys.identity_columns WHERE object_id = OBJECT_ID(N'dbo.${ident(t)}')`, (r) => out.push(r[0]));
      return out;
    },
    async count(t) { let n = 0; await run(`SELECT COUNT(*) FROM [dbo].${q(ident(t))}`, (r) => { n = r[0]; }); return n; },
    /** What this login could do besides reading (the agent itself only ever sends SELECTs). */
    async rights() {
      const names = ['INSERT', 'UPDATE', 'DELETE', 'ALTER', 'EXECUTE', 'db_owner', 'db_datawriter', 'sysadmin']; let row;
      await run(`SELECT HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'INSERT'), HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'UPDATE'), HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'DELETE'), HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'ALTER'), HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'EXECUTE'), IS_MEMBER('db_owner'), IS_MEMBER('db_datawriter'), IS_SRVROLEMEMBER('sysadmin')`, (r) => { row = r; });
      return names.filter((_, i) => row && row[i] === 1);
    },
    // dates as 'YYYY-MM-DDTHH:MM:SS': read the same whatever the server's date format setting
    select(t, cols, w, onRow) { return run(`SELECT ${cols.map((x) => q(ident(x))).join(', ')} FROM [dbo].${q(ident(t))}${whereSql(w, q, (d) => d.replace(' ', 'T'))}`, (r) => onRow(r.map(val))); },
  };
}
function sqliteSource(file) {
  let db; const q = (x) => `"${x}"`;
  return {
    kind: 'SQLite ' + file,
    async open() { db = new DatabaseSync(file, { readOnly: true }); },
    close() { db?.close(); },
    async version() { return 'SQLite stand-in'; },
    async now() { return fmtDate(new Date(Date.now() + 330 * 60000)); },
    async columns(t) { return db.prepare(`PRAGMA table_info(${q(ident(t))})`).all().map((r) => r.name).filter((c) => !SECRET_COL.test(c)); },
    async tables() { return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name); },
    async key(t) { const k = db.prepare(`PRAGMA table_info(${q(ident(t))})`).all().filter((r) => r.pk).map((r) => r.name); return k.length ? k : [db.prepare(`PRAGMA table_info(${q(ident(t))})`).all()[0]?.name].filter(Boolean); },
    async count(t) { return db.prepare(`SELECT COUNT(*) n FROM ${q(ident(t))}`).get().n; },
    async select(t, cols, w, onRow) { const sql = assertSelectOnly(`SELECT ${cols.map((x) => q(ident(x))).join(', ')} FROM ${q(ident(t))}${whereSql(w, q)}`); let n = 0; for (const r of db.prepare(sql).iterate()) { n++; onRow(cols.map((c) => r[c])); } return n; },
  };
}
const source = () => (opt('server-sqlite') ? sqliteSource(opt('server-sqlite')) : mssqlSource(cfg()));
const TABLES = () => JSON.parse(fs.readFileSync(path.join(DIR, 'tables.json'), 'utf8'));
const DATE_COLS = ['modified_date', 'created_date'];
/** Every table of the database (the dashboard's first), less system tables and names we cannot quote safely. */
async function allTables(src) { const dash = TABLES(); const rest = (await src.tables()).filter((t) => IDENT.test(t) && !SKIP_TABLES.has(t.toLowerCase()) && !/^sqlite_/i.test(t) && !dash.includes(t)); return [...dash, ...rest]; }

/** Nightly: copies every table afresh into the working copy and works out how each table is followed. */
async function extractAll() {
  const src = source(); await src.open(); const t0 = Date.now(); let total = 0;
  const tmp = COPY + '.new'; if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  const state = { fullAt: null, since: null, tables: {} };
  try {
    state.since = await src.now();
    const db = new DatabaseSync(tmp); db.exec('PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF;');
    const dash = new Set(TABLES());
    for (const t of await allTables(src)) {
      const cols = await src.columns(t); if (!cols.length) { log(`  ${t}: not found, skipped`); continue; }
      db.exec(`CREATE TABLE "${t}" (${cols.map((x) => `"${x}"`).join(', ')})`);
      const ins = db.prepare(`INSERT INTO "${t}" VALUES (${cols.map(() => '?').join(', ')})`);
      db.exec('BEGIN'); const n = await src.select(t, cols, null, (r) => ins.run(...r)); db.exec('COMMIT'); total += n;
      state.tables[t] = { cols, key: await src.key(t), dates: DATE_COLS.filter((d) => cols.includes(d)), dash: dash.has(t) };
      log(`  ${t}: ${n} rows`);
    }
    // a table without dates follows the table whose single-column key it carries
    const keyOwner = new Map(Object.entries(state.tables).filter(([, v]) => v.key.length === 1).map(([t, v]) => [v.key[0], t]));
    for (const [t, v] of Object.entries(state.tables)) {
      if (v.dates.length) continue;
      const own = v.key[0]; const p = v.cols.map((c) => (c !== own && keyOwner.has(c) && keyOwner.get(c) !== t ? [c, keyOwner.get(c)] : null)).filter(Boolean);
      const best = p[0]; // the first key column after its own is the header it belongs to (batch_id, dispatch_id, melting_prod_item_id…)
      if (best) { v.parent = best[1]; v.fk = best[0]; db.exec(`CREATE INDEX IF NOT EXISTS "fx_${t}" ON "${t}"("${v.fk}")`); }
    }
    // day updates follow the dashboard's tables and the headers they hang from; the rest refresh nightly
    for (const v of Object.values(state.tables)) v.live = v.dash;
    for (let more = true; more;) { more = false; for (const v of Object.values(state.tables)) if (v.live && v.parent && !state.tables[v.parent].live) { state.tables[v.parent].live = true; more = true; } }
    for (const [t, v] of Object.entries(state.tables)) for (const k of v.key) db.exec(`CREATE INDEX IF NOT EXISTS "kx_${t}_${k}" ON "${t}"("${k}")`);
    db.close();
  } finally { src.close(); }
  if (fs.existsSync(COPY)) fs.unlinkSync(COPY); fs.renameSync(tmp, COPY);
  state.fullAt = new Date().toISOString(); fs.writeFileSync(STATE, JSON.stringify(state, null, 1));
  const follow = Object.entries(state.tables).filter(([, v]) => v.live && !v.dates.length).map(([t, v]) => `${t}${v.parent ? ' <- ' + v.parent : ' (re-read whole)'}`);
  log(`read ${total} rows from ${src.kind} in ${Math.round((Date.now() - t0) / 1000)} s; ${Object.keys(state.tables).length} tables, ${Object.values(state.tables).filter((v) => v.live).length} kept up to date in the day; those without dates: ${follow.join(', ')}`);
}

/** Day-time: reads only rows changed since the last read into the working copy. Returns the number of rows taken in. */
async function extractChanges() {
  if (!fs.existsSync(COPY) || !fs.existsSync(STATE)) { log('no working copy yet: reading everything'); await extractAll(); return -1; }
  const state = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  if (Object.values(state.tables).some((v) => v.live === undefined)) { log('working copy from an older agent: reading everything'); await extractAll(); return -1; }
  const src = source(); await src.open(); const t0 = Date.now(); let total = 0;
  const db = new DatabaseSync(COPY); db.exec('PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF;');
  try {
    const now = await src.now();
    const since = fmtDate(new Date(Date.parse(state.since.replace(' ', 'T') + 'Z') - 10 * 60000));
    const changed = new Map(); // table -> Set of key values (single-column keys) of rows taken in
    const take = async (t, v, w, dropWhere) => {
      const rows = []; await src.select(t, v.cols, w, (r) => rows.push(r));
      db.exec('BEGIN');
      if (dropWhere) { const vals = dropWhere.in; for (let i = 0; i < vals.length; i += 500) { const part = vals.slice(i, i + 500); db.prepare(`DELETE FROM "${t}" WHERE "${dropWhere.col}" IN (${part.map(() => '?').join(',')})`).run(...part); } }
      else if (v.key.length) { const del = db.prepare(`DELETE FROM "${t}" WHERE ${v.key.map((k) => `"${k}" = ?`).join(' AND ')}`); const ki = v.key.map((k) => v.cols.indexOf(k)); for (const r of rows) del.run(...ki.map((i) => r[i])); }
      const ins = db.prepare(`INSERT INTO "${t}" VALUES (${v.cols.map(() => '?').join(', ')})`); for (const r of rows) ins.run(...r);
      db.exec('COMMIT');
      if (v.key.length === 1) { const ki = v.cols.indexOf(v.key[0]); const s = changed.get(t) || changed.set(t, new Set()).get(t); for (const r of rows) s.add(r[ki]); }
      total += rows.length; return rows.length;
    };
    for (const [t, v] of Object.entries(state.tables)) if (v.live && v.dates.length) { const n = await take(t, v, { since, cols: v.dates }); if (n) log(`  ${t}: ${n} changed`); }
    // follow parents, a few rounds deep (melting rejection <- melting line <- heat)
    for (let round = 0; round < 4; round++) {
      let any = false;
      for (const [t, v] of Object.entries(state.tables)) {
        if (!v.live || v.dates.length || !v.parent || v.done) continue; const ids = [...(changed.get(v.parent) || [])]; const parentDone = state.tables[v.parent].dates.length || state.tables[v.parent].done;
        if (!parentDone) continue; v.done = true; any = true; if (!ids.length) continue;
        let n = 0; for (let i = 0; i < ids.length; i += 800) { const part = ids.slice(i, i + 800); n += await take(t, v, { col: v.fk, in: part }, { col: v.fk, in: part }); }
        if (n) log(`  ${t}: ${n} rows under ${ids.length} changed ${v.parent} rows`);
      }
      if (!any) break;
    }
    for (const [t, v] of Object.entries(state.tables)) if (v.live && !v.dates.length && !v.parent) { db.exec(`DELETE FROM "${t}"`); const n = await take(t, v, null); log(`  ${t}: re-read whole (${n})`); }
    for (const v of Object.values(state.tables)) delete v.done;
    state.since = now; state.updatedAt = new Date().toISOString(); fs.writeFileSync(STATE, JSON.stringify(state, null, 1));
  } finally { db.close(); src.close(); }
  log(`took in ${total} changed rows in ${Math.round((Date.now() - t0) / 1000)} s`);
  return total;
}

// ---------- dashboard API
const api = async (method, p, body, headers = {}) => {
  const c = cfg(); const url = `${c.api.replace(/\/$/, '')}/api/${c.company}/sumangal_dashboard${p}`;
  const h = { ...headers }; if (c.agentUid && p !== '/agent/register') { h['X-Agent-Uid'] = c.agentUid; h.Authorization = `Bearer ${secret('agent.sec')}`; }
  let b = body; if (body && !Buffer.isBuffer(body)) { b = JSON.stringify(body); h['Content-Type'] = 'application/json'; }
  const r = await fetch(url, { method, headers: h, body: b }); if (r.status === 204) return null;
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = { raw: t.slice(0, 200) }; }
  if (!r.ok) throw new Error(`${method} ${p}: ${r.status} ${j.error || j.raw || ''}`);
  return j;
};

/** Builds the dataset from the working copy (or --source) and sends it. */
async function buildAndSend(kind, dbFile) {
  log('building the dashboard dataset');
  execFileSync(process.execPath, ['--no-warnings', path.join(DIR, 'build-v15.mjs')], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, SUMANGAL_DB: dbFile, SUMANGAL_WORK: WORK }, maxBuffer: 64 * 1024 * 1024 });
  const json = fs.readFileSync(path.join(WORK, 'v15.json')); const gz = zlib.gzipSync(json, { level: 9 });
  fs.writeFileSync(path.join(DIR, 'last-sent.json.gz'), gz);
  log(`sending ${Math.round(gz.length / 1024)} KB (${Math.round(json.length / 1024 / 1024)} MB unpacked)`);
  const r = await api('POST', '/agent/push', gz, { 'Content-Type': 'application/octet-stream', 'X-Run-Kind': kind });
  if (!ARGS.includes('--keep')) for (const f of ['v15.json', 'v13-data.js', 'supp.json', 'hist.json']) { const p = path.join(WORK, f); if (fs.existsSync(p)) fs.unlinkSync(p); }
  return { kb: Math.round(gz.length / 1024), chunks: r.chunks };
}
async function approvedOrThrow() { const st = await api('GET', '/agent/status'); if (st.status !== 'approved') throw new Error(`this agent is ${st.status}; an admin has to approve it first`); }
/** One run at a time: on a PC that was off at night, the nightly run and the day task can start together. */
async function takeLock() {
  const f = path.join(WORK, 'run.lock'); const t0 = Date.now(); let said = false;
  for (;;) {
    try { fs.writeFileSync(f, String(process.pid), { flag: 'wx' }); return () => { try { fs.unlinkSync(f); } catch { /* gone */ } }; } catch (e) { if (e.code !== 'EEXIST') throw e; }
    let stale = false; try { stale = Date.now() - fs.statSync(f).mtimeMs > 3 * 3600e3; } catch { continue; }
    if (stale) { try { fs.unlinkSync(f); } catch { /* raced */ } continue; }
    if (Date.now() - t0 > 3 * 3600e3) throw new Error('another run has been busy for 3 hours');
    if (!said) { log('another run is busy, waiting for it'); said = true; }
    await new Promise((r) => setTimeout(r, 10000));
  }
}
async function oneRun(kind, work) {
  const unlock = await takeLock(); try { return await oneRunLocked(kind, work); } finally { unlock(); }
}
async function oneRunLocked(kind, work) {
  const t0 = Date.now();
  try {
    await approvedOrThrow();
    const note = await work();
    const sent = await buildAndSend(kind, opt('source')?.startsWith('sqlite:') ? opt('source').slice(7) : COPY);
    const secs = Math.round((Date.now() - t0) / 1000); log(`${kind}: stored on the dashboard in ${secs} s`);
    await api('POST', '/agent/report', { ok: true, kind, message: `${kind}: ${note ? note + ', ' : ''}sent ${sent.kb} KB`, seconds: secs });
    return true;
  } catch (e) {
    log(`FAILED (${kind}): ` + e.message);
    try { await api('POST', '/agent/report', { ok: false, kind, message: `${kind}: ${e.message}`.slice(0, 480), seconds: Math.round((Date.now() - t0) / 1000) }); } catch { /* the log keeps it */ }
    return false;
  }
}

// ---------- commands
async function cmdTest() {
  const src = source(); log(`agent ${VERSION}: testing ${src.kind}`); await src.open(); let missing = 0;
  try {
    log('  ' + await src.version()); log('  server clock ' + await src.now());
    if (src.rights) {
      const extra = await src.rights();
      log(extra.length ? `  NOTE: this login can also change data (${extra.join(', ')}). The agent never does: it sends only SELECTs. A read-only login is still better.` : '  login rights: read-only');
    }
    const dash = new Set(TABLES()); const all = await allTables(src); let rows = 0;
    for (const t of all) { try { const [n, k] = [await src.count(t), await src.key(t)]; rows += n; log(`  ${t}: ${n} rows, key ${k.join('+') || 'none'}${dash.has(t) ? ' (dashboard)' : ''}`); } catch (e) { if (dash.has(t)) missing++; log(`  ${t}: ${e.message}`); } }
    log(`  ${all.length} tables, ${rows} rows (password columns are never read)`);
  } finally { src.close(); }
  log(missing ? `${missing} dashboard tables could not be read` : 'all tables readable'); if (missing) process.exitCode = 1;
}
async function cmdRegister() {
  const c = cfg(); if (c.agentUid) { log('already registered as ' + c.agentUid); return cmdStatus(); }
  const uid = crypto.randomUUID(); const key = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(path.join(DIR, 'agent.sec'), protect(key));
  const r = await api('POST', '/agent/register', { agentUid: uid, keyHash: crypto.createHash('sha256').update(key).digest('hex'), machine: os.hostname(), winUser: os.userInfo().username });
  c.agentUid = uid; saveCfg(c); log(`registered as agent ${r.id} (${r.status}). Ask the dashboard admin to approve it.`);
}
async function cmdStatus() { const r = await api('GET', '/agent/status'); log(`agent ${r.id}: ${r.status}`); }
// ---------- self-update: release.json ({ version, files: { name: SHA-256 } }) signed by the platform team (release.sig)
const UPDATABLE = /^[A-Za-z0-9-]+\.(mjs|json|vbs|ps1|md)$/;
async function fetchFile(name) {
  const c = cfg(); const r = await fetch(`${c.api.replace(/\/$/, '')}/api/${c.company}/sumangal_dashboard/agent/files/${name}`, { headers: { 'Cache-Control': 'no-cache' } });
  if (!r.ok) throw new Error(`file ${name}: ${r.status}`); return Buffer.from(await r.arrayBuffer());
}
/** true when a new version was installed (the caller then restarts). Never throws: a failed check keeps this version running. */
async function selfUpdate() {
  if (ARGS.includes('--no-update')) return false;
  try {
    const rel = await fetchFile('release.json'); const sig = Buffer.from((await fetchFile('release.sig')).toString('utf8').trim(), 'base64');
    const pub = crypto.createPublicKey({ key: Buffer.from(RELEASE_KEY, 'base64'), format: 'der', type: 'spki' });
    if (!crypto.verify(null, rel, pub, sig)) { log('update check: the release is not signed by the platform team, ignored'); return false; }
    const r = JSON.parse(rel.toString('utf8'));
    if (!r.version || r.version === VERSION) return false;
    const files = {};
    for (const [name, sha] of Object.entries(r.files || {})) {
      if (!UPDATABLE.test(name)) throw new Error('bad file name in the release: ' + name);
      const b = await fetchFile(name);
      if (crypto.createHash('sha256').update(b).digest('hex') !== sha) throw new Error(`${name}: checksum does not match the signed list`);
      files[name] = b;
    }
    // the new agent must call itself this version, or it would update itself again on every start
    if (!files['agent.mjs'] || !files['agent.mjs'].toString('utf8').includes(`VERSION = "${r.version}"`)) throw new Error(`the release's agent.mjs is not version ${r.version}`);
    const unlock = await takeLock();
    try {
      const old = path.join(WORK, 'previous-version'); fs.mkdirSync(old, { recursive: true });
      // agent.mjs last: a half-done update leaves the old agent with new helpers, never a new agent with old ones
      for (const name of Object.keys(files).sort((a, b) => (a === 'agent.mjs') - (b === 'agent.mjs'))) {
        const p = path.join(DIR, name); if (fs.existsSync(p)) fs.copyFileSync(p, path.join(old, name));
        fs.writeFileSync(p + '.new', files[name]); fs.renameSync(p + '.new', p);
      }
    } finally { unlock(); }
    log(`updated ${VERSION} -> ${r.version} (${Object.keys(files).length} files; the old ones are in work\\previous-version)`);
    try { await api('POST', '/agent/report', { ok: true, kind: 'update', message: `agent updated ${VERSION} -> ${r.version}`, seconds: 0 }); } catch { /* the log keeps it */ }
    return true;
  } catch (e) { log(`update check failed (keeping ${VERSION}): ${e.message}`); return false; }
}
/** Runs this same command again with the files now on disk (after a self-update). */
function relaunch(more = []) {
  const r = spawnSync(process.execPath, ['--no-warnings', path.join(DIR, 'agent.mjs'), ...ARGS, ...more], { stdio: 'inherit', windowsHide: true });
  process.exitCode = r.status ?? 1;
}
/** update.ps1: the files beside this agent.mjs match release.json, and release.json carries the platform team's signature. */
function cmdVerifyRelease() {
  const rel = fs.readFileSync(path.join(DIR, 'release.json')); const sig = Buffer.from(fs.readFileSync(path.join(DIR, 'release.sig'), 'utf8').trim(), 'base64');
  const pub = crypto.createPublicKey({ key: Buffer.from(RELEASE_KEY, 'base64'), format: 'der', type: 'spki' });
  if (!crypto.verify(null, rel, pub, sig)) { console.log('  NOT signed by the platform team'); process.exitCode = 1; return; }
  const r = JSON.parse(rel.toString('utf8'));
  for (const [name, sha] of Object.entries(r.files)) if (crypto.createHash('sha256').update(fs.readFileSync(path.join(DIR, name))).digest('hex') !== sha) { console.log('  ' + name + ' does not match'); process.exitCode = 1; return; }
  console.log(`  version ${r.version}: signed by the platform team, ${Object.keys(r.files).length} files match`);
}
async function cmdSelfUpdate() { log(`agent ${VERSION}: checking for a new version`); if (!(await selfUpdate())) log('no new version installed'); }

async function cmdRun() {
  if (await selfUpdate()) return relaunch(['--no-update']); // the night's run: no second check
  log(`agent ${VERSION}: nightly run`);
  const ok = await oneRun('nightly', async () => { if (opt('source')) { log('using existing copy ' + opt('source')); return 'existing copy'; } await extractAll(); return 'full read'; });
  if (!ok) process.exitCode = 1;
}
async function cmdUpdate() {
  log(`agent ${VERSION}: day update`);
  const ok = await oneRun('update', async () => { const n = await extractChanges(); return n < 0 ? 'full read' : `${n} changed rows`; });
  if (!ok) process.exitCode = 1;
}
async function cmdDay() {
  // any hour, every day, until stopped; --until=HH:MM only if asked (the old 'day' task passed 21:00)
  const until = ARGS[0] === 'listen' ? opt('until') : null; const every = +(opt('every') || 0) * 60000; // 0: only when the dashboard asks
  const end = new Date(8.64e15); if (until) { const [hh, mm] = until.split(':').map(Number); end.setTime(Date.now()); end.setHours(hh, mm, 0, 0); }
  log(`agent ${VERSION}: listening${until ? ` until ${until}` : ' (any hour, every day)'}, an update when the dashboard asks${every ? `, and every ${every / 60000} min` : ''}`);
  let last = 0; let checked = 0;
  while (Date.now() < end.getTime()) {
    if (Date.now() - checked > 3600e3) { checked = Date.now(); if (await selfUpdate()) { log('restarting with the new version'); return relaunch(); } }
    let job = null;
    try { job = await api('GET', '/agent/jobs?wait=25'); } catch (e) { log('waiting for requests failed: ' + e.message); await new Promise((r) => setTimeout(r, 30000)); }
    if (job?.id || (every && Date.now() - last >= every)) {
      if (job?.id) log(`refresh requested (job ${job.id})`);
      const ok = await oneRun('update', async () => { const n = await extractChanges(); return n < 0 ? 'full read' : `${n} changed rows`; });
      last = Date.now();
      if (job?.id) { try { await api('POST', `/agent/jobs/${job.id}/done`, { ok }); } catch (e) { log('could not close job: ' + e.message); } }
    }
  }
  log('listening ends');
}

const [cmd] = ARGS;
const cmds = { test: cmdTest, register: cmdRegister, status: cmdStatus, run: cmdRun, update: cmdUpdate, listen: cmdDay, day: cmdDay, 'self-update': cmdSelfUpdate, 'verify-release': async () => cmdVerifyRelease() };
if (!cmds[cmd]) { console.log('Usage: node agent.mjs test | register | status | run | update | listen [--until=HH:MM] [--every=<minutes>] | self-update   (tests: --source=sqlite:<file>, --server-sqlite=<file>, --keep)'); process.exit(cmd ? 1 : 0); }
cmds[cmd]().catch((e) => { log('FAILED: ' + e.message); process.exit(1); });
