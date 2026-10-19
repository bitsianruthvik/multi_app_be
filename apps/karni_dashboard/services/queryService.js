import { pool } from '../../../db.js';
import { savedReports } from './reportService.js';

/**
 * Running Karni's saved SAP queries (Query Manager) for real.
 *
 * The Service Layer cannot run a saved query without first saving it into SAP
 * (a write), so the connector on Karni's server runs the SQL itself, through a
 * HANA database user that may only SELECT. Three locks keep it read-only:
 *   1. the database user has SELECT rights only (set up by Karni's SAP partner),
 *   2. the connector opens a READ ONLY transaction and repeats the check below
 *      (connector/run.ps1, Assert-SelectOnly),
 *   3. this file refuses anything that is not a SELECT, or a SQLScript of
 *      variables around SELECTs, before a run is ever queued (classify).
 * Reports that CALL a stored procedure are not run: a procedure could write.
 *
 * A run is queued here (kd_query_runs), picked up by the connector within
 * about 10 seconds while it is between syncs, and its result is kept so the
 * last result of every report opens instantly.
 */
export const MAX_ROWS = 5000;
const QUEUE_TIMEOUT_MIN = 15;
const RUN_TIMEOUT_MIN = 10;
const MAX_WAITING_PER_USER = 3;

// ── Read-only check (the connector repeats it) ───────────────────────────
const FORBIDDEN = /\b(INSERT|UPDATE|DELETE|MERGE|UPSERT|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE|CALL|EXEC|EXECUTE|COMMIT|ROLLBACK|LOCK|RENAME|IMPORT|EXPORT|UNLOAD)\b/i;
const SELECT_START = /^\(*\s*(SELECT|WITH)\b/i;
const SCRIPT_STMT = /^(\(*\s*(SELECT|WITH)\b|DECLARE\b|IF\b|ELSE\b|ELSEIF\b|END\b|[A-Za-z_]\w*\s*(\[[^\]]*\])?\s*:=)/i;

/** The SQL with comments, string literals and quoted names blanked, so words inside them don't count. */
export function skeleton(sql) {
  return String(sql)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""')
    .replace(/\[[^\]]*\]/g, '[]');
}

const refuse = (m) => Object.assign(new Error(m), { status: 400 });

/**
 * How a query runs: 'select' (one SELECT / WITH) or 'script' (SQLScript —
 * DECLARE / IF / := around SELECTs — run in a DO BEGIN … END block).
 * Anything else throws, with the reason.
 */
export function classify(sql) {
  const s = skeleton(sql).trim().replace(/;\s*$/, '');
  if (/^\(*\s*(CALL|EXEC|EXECUTE)\b/i.test(s)) {
    throw refuse('This report calls a stored procedure inside SAP. A procedure could change data, so the dashboard does not run it until Karni\'s SAP partner confirms it only reads.');
  }
  const bad = FORBIDDEN.exec(s) || /\bREPLACE\b(?!\s*\()/i.exec(s);
  if (bad) throw refuse(`READ-ONLY: "${bad[1] || bad[0]}" is not allowed.`);
  if (/\bDO\s+BEGIN\b/i.test(s)) throw refuse('Blocks of their own (DO BEGIN) are not run.');
  const parts = s.split(';').map((x) => x.trim()).filter(Boolean);
  if (parts.length === 1 && SELECT_START.test(parts[0])) return 'select';
  const odd = parts.find((p) => !SCRIPT_STMT.test(p));
  if (odd) throw refuse(`Only SELECT and variable statements can run (found "${odd.slice(0, 40)}…").`);
  if (!parts.some((p) => /\bSELECT\b/i.test(p))) throw refuse('The query has no SELECT.');
  return 'script';
}

// ── Inputs: SAP's [%0] … [%9] prompts ────────────────────────────────────
const human = (f) => f.replace(/^(U_|PD_)/, '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

/** The prompts a query asks for, with a label and type guessed from its variable or the column it is compared with. */
export function paramsOf(sql) {
  const text = String(sql);
  const seen = [...new Set([...text.matchAll(/\[%(\d)\]/g)].map((m) => Number(m[1])))].sort((a, b) => a - b);
  return seen.map((n) => {
    const p = `\\[%${n}\\]`;
    // SQLScript: FromDate := /* T0."DocDate" */ '[%0]'
    const asg = new RegExp(`([A-Za-z_]\\w*)\\s*:=\\s*(?:/\\*[^*]*?"?(\\w+)"?\\s*\\*/)?\\s*N?'?${p}`, 'i').exec(text);
    const cmp = new RegExp(`([A-Za-z_]\\w*)["\\]]?\\s*(>=|<=|<>|=|>|<|LIKE|BETWEEN|IN\\s*\\()\\s*N?'?${p}`, 'i').exec(text);
    const between = new RegExp(`([A-Za-z_]\\w*)["\\]]?\\s*BETWEEN\\s*'?\\[%\\d\\]'?\\s*AND\\s*'?${p}`, 'i').exec(text);
    const near = new RegExp(`"(\\w+)"[^"\\[;]{0,40}${p}`).exec(text);
    let label = null; let field; let op = '';
    if (asg) {
      field = asg[2] || asg[1];
      label = human(asg[1]);
    } else {
      field = between?.[1] || cmp?.[1] || near?.[1] || null;
      op = between ? '<=' : (cmp?.[2] || '').toUpperCase();
    }
    const declared = asg ? new RegExp(`DECLARE\\s+${asg[1]}\\s+(\\w+)`, 'i').exec(text)?.[1] : null;
    const isDate = /^(DATE|TIMESTAMP|SECONDDATE)$/i.test(declared || '') || (!!field && /date|dt$/i.test(field)) || /date/i.test(asg?.[1] || '');
    if (!label) {
      const from = op === '>=' || op === '>' || op === 'BETWEEN';
      const to = op === '<=' || op === '<';
      const suffix = from ? (isDate ? ' from' : ' (min)') : to ? (isDate ? ' to' : ' (max)') : '';
      label = field ? `${human(field)}${suffix}` : `Input ${n + 1}`;
    }
    return { n, field: field || null, label, type: isDate ? 'date' : 'text', quoted: new RegExp(`'${p}'`).test(text) };
  });
}

/** The SQL with the prompts filled in. Values are typed and quoted here; nothing raw reaches the SQL. */
export function fillParams(sql, defs, values = {}) {
  let out = String(sql);
  for (const d of defs) {
    let v = String(values[d.n] ?? '').trim();
    if (d.type === 'date') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw refuse(`${d.label}: a date is needed.`);
      v = v.replace(/-/g, '');
    }
    if (v.length > 200) throw refuse(`${d.label}: too long.`);
    const esc = v.replace(/'/g, "''");
    let val;
    if (d.quoted) val = esc;
    else if (d.type === 'date') val = `'${v}'`;
    else if (/^-?\d+(\.\d+)?$/.test(v)) val = v;
    else val = `'${esc}'`;
    // A quoted prompt keeps its own quotes; replace only the [%n] inside them.
    out = out.split(`[%${d.n}]`).join(val);
  }
  return out;
}

/** Whether a saved query can run from the dashboard, and if not, why. */
export function runnable(sql) {
  try {
    const defs = paramsOf(sql);
    classify(fillParams(sql, defs, Object.fromEntries(defs.map((d) => [d.n, d.type === 'date' ? '2000-01-01' : '0']))));
    return { ok: true, reason: null };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

// ── Reports, runs ────────────────────────────────────────────────────────
async function reportById(companyId, id) {
  const all = await savedReports(companyId);
  const r = all.reports.find((x) => x.id === id);
  if (!r) throw Object.assign(new Error('No such saved report.'), { status: 404 });
  return { ...r, asOf: all.asOf };
}

/** Whether the connector can run queries: what it said on its last check-in. */
export async function runnerState(companyId) {
  const [[r]] = await pool.query(
    "SELECT v, TIMESTAMPDIFF(SECOND, updated_at, NOW()) AS age FROM kd_settings WHERE company_id = ? AND k = 'query_runner'", [companyId]);
  if (!r) return { status: 'not_configured', message: null, seenSecondsAgo: null };
  const v = typeof r.v === 'string' ? JSON.parse(r.v) : r.v;
  return { status: v.status || 'not_configured', message: v.message || null, seenSecondsAgo: r.age };
}

const runRow = (r) => r && ({
  id: r.id, queryId: r.query_id, name: r.query_name, params: typeof r.params === 'string' ? JSON.parse(r.params) : r.params,
  status: r.status, requestedBy: r.requested_by_name, requestedAt: r.requested_at, startedAt: r.started_at, finishedAt: r.finished_at,
  rowCount: r.row_count, truncated: !!r.truncated, error: r.error,
  ...(r.result !== undefined ? { result: r.result ? JSON.parse(r.result) : null } : {}),
});

/** Fail runs nobody picked up, or that never came back. */
async function expire(companyId) {
  await pool.query(
    `UPDATE kd_query_runs SET status = 'failed', finished_at = NOW(),
       error = CASE WHEN status = 'queued' THEN ? ELSE ? END
     WHERE company_id = ? AND ((status = 'queued' AND requested_at < NOW() - INTERVAL ? MINUTE) OR (status = 'running' AND started_at < NOW() - INTERVAL ? MINUTE))`,
    ['The SAP connector did not pick this up. Is the Karni server signed in?', 'The SAP connector did not send a result back.',
      companyId, QUEUE_TIMEOUT_MIN, RUN_TIMEOUT_MIN]);
}

export async function queueRun(companyId, id, values, user) {
  const r = await reportById(companyId, id);
  const defs = paramsOf(r.sql);
  const sql = fillParams(r.sql, defs, values || {});
  const kind = classify(sql);
  await expire(companyId);
  const [[{ n }]] = await pool.query(
    "SELECT COUNT(*) AS n FROM kd_query_runs WHERE company_id = ? AND requested_by <=> ? AND status IN ('queued','running')", [companyId, user?.id ?? null]);
  if (n >= MAX_WAITING_PER_USER) throw Object.assign(new Error('You already have reports running. Wait for them to finish.'), { status: 429 });
  const params = Object.fromEntries(defs.map((d) => [d.label, String(values?.[d.n] ?? '')]));
  const [ins] = await pool.query(
    'INSERT INTO kd_query_runs (company_id, query_id, query_name, params, sql_text, kind, requested_by, requested_by_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [companyId, id, r.name.slice(0, 250), JSON.stringify(params), sql, kind, user?.id ?? null, String(user?.name || user?.email || '').slice(0, 120)]);
  return getRun(companyId, ins.insertId);
}

export async function getRun(companyId, runId) {
  await expire(companyId);
  const [[r]] = await pool.query('SELECT * FROM kd_query_runs WHERE company_id = ? AND id = ?', [companyId, runId]);
  if (!r) throw Object.assign(new Error('No such run.'), { status: 404 });
  const { sql_text: _sql, kind: _kind, ...rest } = r;
  return runRow(rest);
}

/** The report's inputs, whether it can run, its last runs (without results) and the runner's state. */
export async function reportDetail(companyId, id) {
  const r = await reportById(companyId, id);
  await expire(companyId);
  const [runs] = await pool.query(
    `SELECT id, query_id, query_name, params, status, requested_by_name, requested_at, started_at, finished_at, row_count, truncated, error
     FROM kd_query_runs WHERE company_id = ? AND query_id = ? ORDER BY id DESC LIMIT 10`, [companyId, id]);
  return { asOf: r.asOf, report: r, params: paramsOf(r.sql), runnable: runnable(r.sql), runs: runs.map(runRow), runner: await runnerState(companyId) };
}

// ── The connector's side ─────────────────────────────────────────────────
/** The connector checks in: records whether it can run queries, and takes up to 3 waiting runs. */
export async function claimJobs(companyId, runner, message) {
  const status = ['ready', 'not_configured', 'error'].includes(runner) ? runner : 'not_configured';
  await pool.query(
    `INSERT INTO kd_settings (company_id, k, v) VALUES (?, 'query_runner', ?)
     ON DUPLICATE KEY UPDATE v = VALUES(v), updated_at = NOW()`,
    [companyId, JSON.stringify({ status, message: message ? String(message).slice(0, 500) : null })]);
  await expire(companyId);
  if (status !== 'ready') return [];
  const [rows] = await pool.query("SELECT id, sql_text, kind FROM kd_query_runs WHERE company_id = ? AND status = 'queued' ORDER BY id LIMIT 3", [companyId]);
  const jobs = [];
  for (const r of rows) {
    const [u] = await pool.query("UPDATE kd_query_runs SET status = 'running', started_at = NOW() WHERE id = ? AND status = 'queued'", [r.id]);
    if (u.affectedRows) jobs.push({ id: r.id, sql: r.sql_text, kind: r.kind, maxRows: MAX_ROWS });
  }
  return jobs;
}

/** The connector sends a result (columns + rows as arrays) or an error. */
export async function saveResult(companyId, body) {
  const { id, columns, rows, truncated, error } = body || {};
  const [[r]] = await pool.query("SELECT id FROM kd_query_runs WHERE company_id = ? AND id = ? AND status = 'running'", [companyId, id]);
  if (!r) return { ok: false };
  if (error) {
    await pool.query("UPDATE kd_query_runs SET status = 'failed', finished_at = NOW(), error = ? WHERE id = ?", [String(error).slice(0, 2000), id]);
    return { ok: true };
  }
  const cols = Array.isArray(columns) ? columns.map((c) => String(c?.name ?? c).slice(0, 120)) : [];
  let list = Array.isArray(rows) ? rows.slice(0, MAX_ROWS).map((x) => (Array.isArray(x) ? x : [x])) : [];
  let cut = !!truncated || (Array.isArray(rows) && rows.length > MAX_ROWS);
  let json = JSON.stringify({ columns: cols, rows: list });
  // Keep a stored result under ~4 MB (TiDB's row limit is 6 MB).
  while (json.length > 4_000_000 && list.length > 100) {
    list = list.slice(0, Math.floor(list.length * 0.7)); cut = true;
    json = JSON.stringify({ columns: cols, rows: list });
  }
  await pool.query(
    "UPDATE kd_query_runs SET status = 'done', finished_at = NOW(), row_count = ?, truncated = ?, result = ? WHERE id = ?",
    [list.length, cut ? 1 : 0, json, id]);
  return { ok: true };
}
