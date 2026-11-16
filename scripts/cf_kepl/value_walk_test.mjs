/**
 * value_walk_test.mjs — valueService.refreshValues a wave at a time stores the SAME values as record by record did
 * (refreshValuesOneByOne, kept for this), in a fraction of the round trips (2026-11-16).
 *
 *   cd multi_app_be && node scripts/cf_kepl/value_walk_test.mjs [--company 2] [--line <id,id>] [--prod] [--mode both|settled|rebuild]
 *
 * EVERYTHING IS ROLLED BACK: each walk runs in its own transaction on an existing order line's rows and nothing is kept.
 * The lines: --line, else the two largest unlocked custom lines of the company.
 *
 *   both (default, local)   1. worked out from nothing: the line's derived values are taken away, then worked out again
 *                              — once each way; the stored values are compared value by value, and with what was stored before
 *                           2. as it stands: neither way changes anything
 *                           3. one input changed (a number typed on a part is doubled): the change is followed up the
 *                              BOM — both ways store the same
 *   settled                 only "as it stands", the new way only: a READ of every record, nothing to write. Safe on
 *                           production: it shows the new way agrees with every value the old way stored on real orders.
 *   rebuild                 only "worked out from nothing", the new way only, compared with what is stored now.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const PROD = process.argv.includes('--prod');
const MODE = arg('mode') ?? (PROD ? 'settled' : 'both');
if (PROD) {
  const env = {};
  fs.readFileSync(path.join(__dir, '..', '..', '..', '.env.tidb'), 'utf8').split('\n').forEach((l) => {
    l = l.trim(); if (!l || l.startsWith('#')) return;
    const [k, ...r] = l.split('='); env[k.trim()] = r.join('=').trim();
  });
  Object.assign(process.env, { DB_HOST: env.DB_HOST, DB_PORT: env.DB_PORT ?? '4000', DB_USER: env.DB_USER, DB_PASSWORD: env.DB_PASSWORD, DB_NAME: env.DB_NAME, DB_SSL: 'true' });
}
const imp = (p) => import(pathToFileURL(path.join(__dir, '..', '..', p)).href);
const { pool } = await imp('db.js');
await imp('apps/cf_erp/services/codegenProvider.js');
const V = await imp('apps/cf_erp/services/valueService.js');

const COMPANY = Number(arg('company') ?? process.env.CF_COMPANY ?? 2);
let pass = 0; let fail = 0;
const ok = (name, cond, detail = '') => { if (cond) { pass += 1; console.log(`  ok   ${name}`); } else { fail += 1; console.log(`  FAIL ${name} ${detail}`); } };

const stable = (v) => (v == null ? null : JSON.stringify(typeof v === 'string' ? JSON.parse(v) : v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : x)));
const dateOf = (d) => (d == null ? null : d instanceof Date ? `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}` : String(d).slice(0, 10));
/** The live values of some records, as comparable text: Map `subject:spec` → text. */
async function stored(db, ids) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 800) {
    const [rows] = await db.query(
      `SELECT subject_id, specification_id, value_number, value_text, value_bool, value_date, option_id, value_json, uom, source
         FROM cf_spec_values WHERE company_id = ? AND subject_type = 'master' AND subject_id IN (?) AND deleted_at IS NULL`, [COMPANY, ids.slice(i, i + 800)]);
    for (const r of rows) {
      out.set(`${r.subject_id}:${r.specification_id}`, [r.value_number == null ? null : Number(Number(r.value_number).toFixed(6)), r.value_text ?? null,
        r.value_bool == null ? null : Number(r.value_bool), dateOf(r.value_date), r.option_id ?? null, stable(r.value_json), r.uom ?? null, r.source].join('|'));
    }
  }
  return out;
}
const differences = (a, b) => {
  const out = [];
  for (const [k, v] of a) if (b.get(k) !== v) out.push(`${k}: ${v} ≠ ${b.get(k) ?? '(none)'}`);
  for (const k of b.keys()) if (!a.has(k)) out.push(`${k}: (none) ≠ ${b.get(k)}`);
  return out;
};

/** One walk in a transaction that is always rolled back. → { result, after, trips, seconds, history } */
async function walk(fn, ids, before = null) {
  const db = await pool.getConnection();
  let trips = 0; const q0 = db.query.bind(db); db.query = (...a) => { trips += 1; return q0(...a); };
  try {
    await db.beginTransaction();
    if (before) await before(db);
    const [[h0]] = await q0('SELECT COUNT(*) AS n FROM cf_spec_value_history WHERE company_id = ?', [COMPANY]);
    trips = 0;
    const t = Date.now();
    const result = await fn(db);
    const seconds = (Date.now() - t) / 1000;
    const walked = trips;
    const after = await stored(db, ids);
    const [[h1]] = await q0('SELECT COUNT(*) AS n FROM cf_spec_value_history WHERE company_id = ?', [COMPANY]);
    return { result, after, trips: walked, seconds, history: Number(h1.n) - Number(h0.n) };
  } finally {
    try { await db.rollback(); } catch { /* it is going back anyway */ }
    db.release();
  }
}

try {
  const where = process.env.DB_HOST && !/^(localhost|127\.0\.0\.1)$/.test(process.env.DB_HOST) ? 'PRODUCTION' : 'local';
  console.log(`${where} — company ${COMPANY} — mode ${MODE} — every walk is rolled back`);
  if (where === 'PRODUCTION' && MODE === 'both') { console.error('On production use --mode settled (reads only) or --mode rebuild.'); process.exit(2); }
  const [[user]] = await pool.query("SELECT id FROM users WHERE company_id = ? ORDER BY (email LIKE 'admin@%') DESC, id LIMIT 1", [COMPANY]);
  const c = { companyId: COMPANY, userId: user?.id ?? 1 };
  let lines = String(arg('line') ?? '').split(',').map(Number).filter(Boolean);
  if (!lines.length) {
    const [rows] = await pool.query(
      `SELECT i.owner_order_line_id AS id, COUNT(*) AS n FROM cf_item_details i
         JOIN cf_master_records m ON m.id = i.master_id AND m.deleted_at IS NULL AND m.company_id = ?
         JOIN cf_sales_order_lines l ON l.id = i.owner_order_line_id AND l.deleted_at IS NULL AND l.locked_at IS NULL
         JOIN cf_sales_orders o ON o.id = l.order_id AND o.deleted_at IS NULL AND o.status NOT IN ('closed','lost','cancelled','revised')
        WHERE i.item_type = 'temporary' AND i.deleted_at IS NULL GROUP BY 1 ORDER BY n DESC LIMIT 2`, [COMPANY]);
    lines = rows.map((r) => Number(r.id));
  }
  if (!lines.length) console.log('  (no unlocked custom order line in this company: nothing to compare)');

  for (const lineId of lines) {
    const [items] = await pool.query(
      `SELECT m.id FROM cf_master_records m JOIN cf_item_details i ON i.master_id = m.id AND i.deleted_at IS NULL
        WHERE m.company_id = ? AND m.deleted_at IS NULL AND i.owner_order_line_id = ? ORDER BY m.id`, [COMPANY, lineId]);
    const ids = items.map((r) => Number(r.id));
    console.log(`\nline ${lineId}: ${ids.length} rows`);
    if (!ids.length) continue;
    const now = await stored(pool, ids);
    const unsettle = (db) => db.query(
      "UPDATE cf_spec_values SET deleted_at = NOW() WHERE company_id = ? AND subject_type = 'master' AND subject_id IN (?) AND deleted_at IS NULL AND source <> 'entered'", [COMPANY, ids]);
    const say = (label, w) => console.log(`       ${label}: ${w.trips} round trips, ${w.seconds.toFixed(1)} s, ${w.result.records} records worked, ${w.result.changes} values changed, ${w.history} history rows`);

    if (MODE === 'both' || MODE === 'rebuild') {
      console.log('  1. worked out from nothing');
      const neu = await walk((db) => V.refreshValues(db, c, ids), ids, unsettle);
      say('a wave at a time', neu);
      if (MODE === 'both') {
        const old = await walk((db) => V.refreshValuesOneByOne(db, c, ids), ids, unsettle);
        say('record by record', old);
        const d = differences(old.after, neu.after);
        ok(`both ways store the same ${old.after.size} values`, d.length === 0 && old.after.size === neu.after.size, d.slice(0, 5).join('; '));
        ok('in fewer round trips', neu.trips < old.trips, `${neu.trips} vs ${old.trips}`);
      }
      const d0 = differences(now, neu.after);
      ok(`and they are the ${now.size} values stored before`, d0.length === 0, `${d0.length} differ: ${d0.slice(0, 5).join('; ')}`);
    }
    if (MODE === 'both' || MODE === 'settled') {
      console.log('  2. as it stands');
      const neu = await walk((db) => V.refreshValues(db, c, ids), ids);
      say('a wave at a time', neu);
      ok('the new way changes nothing on a line that is worked out', neu.result.changes === 0 && differences(now, neu.after).length === 0, `${neu.result.changes} changes: ${differences(now, neu.after).slice(0, 5).join('; ')}`);
      if (MODE === 'both') {
        const old = await walk((db) => V.refreshValuesOneByOne(db, c, ids), ids);
        say('record by record', old);
        ok('nor does the old way', old.result.changes === 0);
      }
    }
    if (MODE === 'both') {
      console.log('  3. one input changed');
      // a typed number on a row that sits in a BOM (so the change has somewhere to go)
      const [[typed]] = await pool.query(
        `SELECT v.id, v.subject_id, v.value_number FROM cf_spec_values v
          WHERE v.company_id = ? AND v.subject_type = 'master' AND v.subject_id IN (?) AND v.deleted_at IS NULL AND v.source = 'entered' AND v.value_number > 0
            AND EXISTS (SELECT 1 FROM cf_bom_lines l JOIN cf_boms b ON b.id = l.bom_id AND b.deleted_at IS NULL WHERE l.child_id = v.subject_id AND l.deleted_at IS NULL)
          ORDER BY v.subject_id DESC, v.id LIMIT 1`, [COMPANY, ids]);
      if (!typed) console.log('     (no typed number on a BOM child in this line: skipped)');
      else {
        const change = (db) => db.query('UPDATE cf_spec_values SET value_number = value_number * 2 WHERE id = ?', [typed.id]);
        const neu = await walk((db) => V.refreshValues(db, c, [Number(typed.subject_id)]), ids, change);
        const old = await walk((db) => V.refreshValuesOneByOne(db, c, [Number(typed.subject_id)]), ids, change);
        say('a wave at a time', neu); say('record by record', old);
        const d = differences(old.after, neu.after);
        ok('both ways store the same values', d.length === 0, d.slice(0, 5).join('; '));
        ok('and the same number of changes', old.result.changes === neu.result.changes, `${neu.result.changes} vs ${old.result.changes}`);
        const neuN = await walk((db) => V.refreshValues(db, c, [Number(typed.subject_id)], { startWithNeighbours: true }), ids, change);
        const oldN = await walk((db) => V.refreshValuesOneByOne(db, c, [Number(typed.subject_id)], { startWithNeighbours: true }), ids, change);
        ok('starting from its neighbours: the same values', differences(oldN.after, neuN.after).length === 0 && oldN.result.changes === neuN.result.changes, `${neuN.result.changes} vs ${oldN.result.changes}`);
      }
    }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
} finally { await pool.end(); }
