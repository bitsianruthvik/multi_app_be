/**
 * Dated history of job content (CF_HRMS_HIRING_SPEC.md §16), on a database
 * that already exists.
 *
 *   node apply-history-schema.mjs                    DRY RUN on local — says what it would do
 *   node apply-history-schema.mjs --apply
 *   node apply-history-schema.mjs --apply --target=prod
 *
 * 1. Columns: line_key, ended_by (and change_reason on the three role tables)
 *    plus a (company_id, line_key) key on
 *      hrms_role_kra_assignments, hrms_role_responsibility_assignments,
 *      hrms_role_kpi_assignments, hrms_position_content_overrides,
 *      hrms_work_assignment_content_overrides.
 *    The statements are section 18 of models/init.sql, read from the file, never
 *    retyped here.
 *
 * 2. A stable line identity for every existing row (only where line_key IS NULL):
 *      role rows            K-<id> / R-<id> / P-<id>; a row that SUPERSEDED another
 *                           of the same definition (it opened the day after the
 *                           other closed) takes that row's key — one line, two versions;
 *      a position's / person's SUPPRESS or OVERRIDE, and an ADD that rewords a line
 *                           the key of the role line it changes (the position's
 *                           role carrying that definition);
 *      any other ADD        S-<id> (position) / E-<id> (person) — a line of its own.
 *
 * 3. The starting version (spec §16.1): a LIVE row with no effective_from gets the
 *    day it was written (DATE(created_at)) — "the earliest sensible date already
 *    stored". Nothing else is dated, and no history is invented.
 *
 * Idempotent: a second run finds the columns and no NULL keys or dates, and
 * changes nothing. Run it BEFORE the backend that reads line_key is deployed
 * (that backend also gives a key to an old row it edits, so the order is safe
 * either way — but the history lists are only complete after this has run).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import mysql from 'mysql2/promise';
import { resolveTarget, announce } from './dbTarget.mjs';

const APPLY = process.argv.includes('--apply');
const sql = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../models/init.sql'), 'utf8');

const ROLE = [
  ['hrms_role_kra_assignments', 'kra_definition_id', 'K'],
  ['hrms_role_responsibility_assignments', 'responsibility_definition_id', 'R'],
  ['hrms_role_kpi_assignments', 'kpi_definition_id', 'P'],
];
const OVERLAY = [
  ['hrms_position_content_overrides', 'S'],
  ['hrms_work_assignment_content_overrides', 'E'],
];
const ROLE_OF_KIND = { KRA: ROLE[0], RESPONSIBILITY: ROLE[1], KPI: ROLE[2] };

function section18() {
  const start = sql.indexOf('-- ## 18. DATED HISTORY OF JOB CONTENT');
  if (start < 0) throw new Error('init.sql has no section 18');
  const from = sql.lastIndexOf('-- ####', start);
  const next = sql.indexOf('\n-- ## 19.', start);
  return sql.slice(from, next < 0 ? undefined : next);
}

const target = resolveTarget();
announce(target);
const conn = await mysql.createConnection({ ...target.cfg, multipleStatements: true });
const say = (what, n, verb) => console.log(`  ${what.padEnd(66)} ${n}${verb ? ` ${verb}` : ''}`);
const dry = APPLY ? '' : ' (dry run; add --apply)';

try {
  /* ── 1. columns and keys ─────────────────────────────────────────────── */
  const wanted = [
    ...ROLE.flatMap(([t]) => ['line_key', 'ended_by', 'change_reason'].map((c) => [t, c])),
    ...OVERLAY.flatMap(([t]) => ['line_key', 'ended_by'].map((c) => [t, c])),
  ];
  const missing = [];
  for (const [t, c] of wanted) {
    const [[{ n }]] = await conn.query(
      'SELECT COUNT(*) n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?', [t, c]);
    if (!Number(n)) missing.push(`${t}.${c}`);
  }
  const [[{ k }]] = await conn.query(
    `SELECT COUNT(*) k FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()
      AND INDEX_NAME IN ('idx_hrka_line','idx_hrra_line','idx_hrkp_line','idx_hpco_line','idx_hwco_line')`);
  console.log('1. Columns and keys');
  if (!missing.length && Number(k) >= 5) say('all there', 'nothing to do');
  else {
    for (const m of missing) say(m, APPLY ? 'adding' : `WOULD ADD${dry}`);
    if (Number(k) < 5) say('line keys (company_id, line_key)', APPLY ? 'adding' : `WOULD ADD${dry}`);
    if (APPLY) {
      await conn.query(section18());
      say('section 18 of init.sql', 'applied');
    }
  }
  if (!APPLY && missing.length) {
    console.log('\n  (Steps 2 and 3 need the columns; on a dry run they are only counted where the columns exist.)');
  }

  const hasKey = async (t) => {
    const [[{ n }]] = await conn.query(
      'SELECT COUNT(*) n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?', [t, 'line_key']);
    return Number(n) > 0;
  };

  /* ── 2. line identities ──────────────────────────────────────────────── */
  console.log('\n2. A line identity for every existing row');
  for (const [t, def, prefix] of ROLE) {
    if (!(await hasKey(t))) { say(t, 'no line_key column yet'); continue; }
    const [rows] = await conn.query(
      `SELECT id, company_id, role_id, ${def} AS def, DATE_FORMAT(effective_from, '%Y-%m-%d') AS f,
              DATE_FORMAT(effective_to, '%Y-%m-%d') AS t, line_key
         FROM ${t} ORDER BY company_id, role_id, ${def}, COALESCE(effective_from, '1000-01-01'), id`);
    const todo = rows.filter((r) => !r.line_key);
    // A successor takes its predecessor's key: same role and definition, opened the day after it closed.
    const keyOf = new Map(rows.map((r) => [r.id, r.line_key ?? `${prefix}-${r.id}`]));
    let chained = 0;
    const dayAfter = (iso) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); };
    for (let i = 1; i < rows.length; i += 1) {
      const r = rows[i];
      if (r.line_key || !r.f) continue;
      const prev = rows.slice(0, i).reverse().find((p) => p.company_id === r.company_id && p.role_id === r.role_id && p.def === r.def && p.t && dayAfter(p.t) === r.f);
      if (prev) { keyOf.set(r.id, keyOf.get(prev.id)); chained += 1; }
    }
    say(`${t}: rows without a line key`, todo.length, todo.length ? (APPLY ? 'keyed' : `WOULD KEY${dry}`) : '');
    if (chained) say(`  … of which a later version of an earlier row`, chained);
    if (APPLY && todo.length) {
      await conn.query(`UPDATE ${t} SET line_key = CONCAT('${prefix}-', id) WHERE line_key IS NULL`);
      for (const r of todo) {
        const key = keyOf.get(r.id);
        if (key !== `${prefix}-${r.id}`) await conn.query(`UPDATE ${t} SET line_key = ? WHERE id = ?`, [key, r.id]);
      }
    }
  }
  for (const [t, prefix] of OVERLAY) {
    if (!(await hasKey(t))) { say(t, 'no line_key column yet'); continue; }
    const position = t === 'hrms_position_content_overrides';
    const ownerJoin = position
      ? 'JOIN hrms_positions p ON p.company_id = o.company_id AND p.id = o.position_id'
      : `JOIN hrms_work_assignments wa ON wa.company_id = o.company_id AND wa.id = o.work_assignment_id
         LEFT JOIN hrms_positions p ON p.company_id = wa.company_id AND p.id = wa.position_id`;
    const roleId = position ? 'p.role_id' : 'COALESCE(p.role_id, wa.role_id)';
    const [[{ n }]] = await conn.query(`SELECT COUNT(*) n FROM ${t} WHERE line_key IS NULL`);
    say(`${t}: rows without a line key`, Number(n), Number(n) ? (APPLY ? 'keyed' : `WOULD KEY${dry}`) : '');
    if (!APPLY || !Number(n)) continue;
    for (const [kind, [roleTable, def]] of Object.entries(ROLE_OF_KIND)) {
      // A change of a role line (switch-off, target): the role line's key.
      await conn.query(
        `UPDATE ${t} o ${ownerJoin}
            JOIN ${roleTable} a ON a.company_id = o.company_id AND a.role_id = ${roleId} AND a.${def} = o.${def}
            SET o.line_key = a.line_key
          WHERE o.line_key IS NULL AND o.content_type = ? AND o.action IN ('SUPPRESS', 'OVERRIDE') AND a.line_key IS NOT NULL`, [kind]);
      // A rewording: the key of the role line it replaces.
      await conn.query(
        `UPDATE ${t} o ${ownerJoin}
            JOIN ${roleTable} a ON a.company_id = o.company_id AND a.role_id = ${roleId}
                               AND a.${def} = CAST(JSON_UNQUOTE(JSON_EXTRACT(o.override_json, '$.replacesDefinitionId')) AS UNSIGNED)
            SET o.line_key = a.line_key
          WHERE o.line_key IS NULL AND o.content_type = ? AND o.action = 'ADD' AND a.line_key IS NOT NULL
            AND JSON_EXTRACT(o.override_json, '$.replacesDefinitionId') IS NOT NULL`, [kind]);
    }
    await conn.query(`UPDATE ${t} SET line_key = CONCAT('${prefix}-', id) WHERE line_key IS NULL`);
  }

  /* ── 3. the starting version ─────────────────────────────────────────── */
  console.log('\n3. The starting version: a live row with no start date starts the day it was written');
  for (const t of [...ROLE.map(([x]) => x), ...OVERLAY.map(([x]) => x)]) {
    const [[{ n }]] = await conn.query(`SELECT COUNT(*) n FROM ${t} WHERE deleted_at IS NULL AND effective_from IS NULL`);
    say(`${t}: live rows with no start date`, Number(n), Number(n) ? (APPLY ? 'dated' : `WOULD DATE${dry}`) : '');
    if (APPLY && Number(n)) {
      await conn.query(
        `UPDATE ${t} SET effective_from = DATE(created_at)
          WHERE deleted_at IS NULL AND effective_from IS NULL AND (effective_to IS NULL OR effective_to >= DATE(created_at))`);
    }
  }
  console.log(APPLY ? '\n  done.' : '\n  dry run — nothing was written.');
} finally {
  await conn.end();
}
