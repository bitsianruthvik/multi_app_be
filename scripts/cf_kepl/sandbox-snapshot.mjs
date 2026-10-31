/**
 * sandbox-snapshot.mjs — save a SANDBOX company's whole CF_ERP state to a file, and put it back (user, 2026-10-31:
 * "do one full run, then reset it and show it to them — I might have to do the run a few times").
 *
 *   node scripts/cf_kepl/sandbox-snapshot.mjs save    --company placebo_sandbox --file <path.json.gz>
 *   node scripts/cf_kepl/sandbox-snapshot.mjs restore --company placebo_sandbox --file <path.json.gz>   (dry run)
 *   node scripts/cf_kepl/sandbox-snapshot.mjs restore --company placebo_sandbox --file <path.json.gz> --apply
 *
 * What: every row of the company in every table whose name starts cf_ and has a company_id column (orders, stock,
 * buying, production, invoices, maintenance, master data, sequences — all of it), ids kept. Restore deletes the
 * company's rows in those tables and writes the saved ones back with the same ids, inside one transaction.
 * Not touched: users, roles, logins and grants (they are not cf_ tables), and the tables in KEEP — files a demo never
 * changes (the standards' DXFs and the RDSO sheets' pages, ~100 MB), so a reset neither drops nor re-sends them.
 *
 * GUARDS: the company is named by SLUG and must end in "sandbox" (never a live tenant); every statement filters on that
 * company's id; restore refuses a file saved from another company.
 */
import fs from 'node:fs';
import zlib from 'node:zlib';

const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const MODE = process.argv[2];
const SLUG = arg('company');
const FILE = arg('file');
const APPLY = process.argv.includes('--apply');
if (!['save', 'restore'].includes(MODE) || !SLUG || !FILE) throw new Error('Usage: save|restore --company <slug> --file <path.json.gz> [--apply]');
if (!/sandbox$/i.test(SLUG)) throw new Error(`Refused: "${SLUG}" is not a sandbox company (the slug must end in "sandbox").`);

const { pool } = await import('../../db.js');
const target = process.env.DB_HOST && !/localhost|127\.0\.0\.1/.test(process.env.DB_HOST) ? 'PRODUCTION DB' : 'local DB';
const db = await pool.getConnection();
try {
  const [[co]] = await db.query('SELECT id, slug FROM companies WHERE slug = ? AND deleted_at IS NULL', [SLUG]);
  if (!co) throw new Error(`No company ${SLUG}`);
  const CO = Number(co.id);
  console.log(`${target} — ${MODE} ${SLUG} (company ${CO})${MODE === 'restore' ? (APPLY ? ' — APPLY' : ' — dry run') : ''}`);
  const [tables] = await db.query(
    `SELECT TABLE_NAME t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME = 'company_id'
        AND TABLE_NAME LIKE 'cf\\_%' ORDER BY TABLE_NAME`);
  const KEEP = new Set(['cf_standard_drawing_files']);
  const names = tables.map((r) => r.t).filter((t) => !KEEP.has(t));
  const [cols] = await db.query(
    `SELECT TABLE_NAME t, COLUMN_NAME c, EXTRA x FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (?) ORDER BY TABLE_NAME, ORDINAL_POSITION`, [names]);
  const writable = new Map(names.map((t) => [t, []]));
  for (const r of cols) if (!/(VIRTUAL|STORED) GENERATED/i.test(r.x)) writable.get(r.t).push(r.c);

  if (MODE === 'save') {
    const out = { company: { id: CO, slug: SLUG }, savedAt: new Date().toISOString(), tables: {} };
    let total = 0;
    for (const t of names) {
      const c = writable.get(t);
      const [rows] = await db.query(`SELECT ${c.map((x) => `\`${x}\``).join(', ')} FROM \`${t}\` WHERE company_id = ?`, [CO]);
      if (!rows.length) continue;
      out.tables[t] = { cols: c, rows: rows.map((r) => c.map((x) => { const v = r[x]; if (v instanceof Date) return { $d: v.toISOString() }; if (Buffer.isBuffer(v)) return { $b: v.toString('base64') }; if (v !== null && typeof v === 'object') return { $j: JSON.stringify(v) }; return v; })) };
      total += rows.length;
    }
    fs.writeFileSync(FILE, zlib.gzipSync(JSON.stringify(out)));
    console.log(`saved ${total} rows from ${Object.keys(out.tables).length} tables → ${FILE} (${(fs.statSync(FILE).size / 1e6).toFixed(1)} MB)`);
  } else {
    const snap = JSON.parse(zlib.gunzipSync(fs.readFileSync(FILE)).toString('utf8'));
    if (snap.company?.slug !== SLUG || Number(snap.company?.id) !== CO) throw new Error(`Refused: the file was saved from ${snap.company?.slug} (${snap.company?.id}), not ${SLUG} (${CO}).`);
    const now = {};
    for (const t of names) { const [[{ n }]] = await db.query(`SELECT COUNT(*) n FROM \`${t}\` WHERE company_id = ?`, [CO]); if (n || snap.tables[t]) now[t] = Number(n); }
    const changed = Object.keys(now).filter((t) => now[t] !== (snap.tables[t]?.rows.length ?? 0));
    console.log(`snapshot of ${snap.savedAt}: ${Object.values(snap.tables).reduce((a, x) => a + x.rows.length, 0)} rows; now ${Object.values(now).reduce((a, b) => a + b, 0)} rows; tables whose count differs: ${changed.length}`);
    for (const t of changed.slice(0, 40)) console.log(`  ${t}: now ${now[t]}, snapshot ${snap.tables[t]?.rows.length ?? 0}`);
    if (!APPLY) { console.log('Dry run — nothing changed. Add --apply.'); process.exit(0); }
    const t0 = Date.now();
    await db.beginTransaction();
    await db.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const t of names) await db.query(`DELETE FROM \`${t}\` WHERE company_id = ?`, [CO]);
    for (const [t, { cols: c, rows }] of Object.entries(snap.tables)) {
      if (KEEP.has(t)) continue;
      const live = new Set(writable.get(t) ?? []);
      const keep = c.map((x, i) => [x, i]).filter(([x]) => live.has(x));
      if (!keep.length) continue;
      const head = `INSERT INTO \`${t}\` (${keep.map(([x]) => `\`${x}\``).join(', ')}) VALUES `;
      let batch = []; let bytes = 0;
      const flush = async () => { if (!batch.length) return; await db.query(head + batch.map(() => `(${keep.map(() => '?').join(', ')})`).join(', '), batch.flat()); batch = []; bytes = 0; };
      for (const r of rows) {
        const vals = keep.map(([, i]) => { const v = r[i]; if (v && typeof v === 'object') { if ('$d' in v) return new Date(v.$d); if ('$b' in v) return Buffer.from(v.$b, 'base64'); if ('$j' in v) return v.$j; } return v; });
        if (vals.some((v) => v !== null && typeof v === 'object' && !(v instanceof Date) && !Buffer.isBuffer(v))) throw new Error(`${t}: unexpected value`);
        batch.push(vals); bytes += vals.reduce((a, v) => a + (typeof v === 'string' ? v.length : 8), 0);
        if (batch.length >= 500 || bytes > 4_000_000) await flush();
      }
      await flush();
    }
    await db.query('SET FOREIGN_KEY_CHECKS = 1');
    await db.commit();
    console.log(`restored in ${((Date.now() - t0) / 1000).toFixed(1)} s — RESTORE-OK`);
  }
} catch (e) {
  try { await db.rollback(); } catch { /* not in a transaction */ }
  console.error('FAILED (nothing changed on restore):', e.message);
  process.exitCode = 1;
} finally {
  db.release();
  await pool.end();
}
