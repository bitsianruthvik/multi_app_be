/**
 * kepl-stiffener-names.mjs — stiffeners named the way the shop says them.
 *
 * Two namings were cryptic:
 *
 *   the catalogue item   "Stiffener 12 × 170" — a size with no noun. It is a
 *                        stiffener PLATE, so it says so: "Stiffener Plate 12 × 170".
 *   the order rows       "Intermediate Stiffener (drilled)" — my invention.
 *                        KEPL's own words are Plain and Hole, and every other
 *                        fabricator reads those the same way.
 *
 * The rows change on this order; the items change in the catalogue, so every
 * future order inherits the clearer name.
 *
 *   node scripts/kepl-stiffener-names.mjs           # dry run
 *   node scripts/kepl-stiffener-names.mjs --apply
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const env = {};
fs.readFileSync(path.join(__dir, '..', '..', '.env.tidb'), 'utf8').split('\n').forEach((l) => {
  l = l.trim(); if (!l || l.startsWith('#')) return;
  const [k, ...r] = l.split('='); env[k.trim()] = r.join('=').trim();
});
Object.assign(process.env, {
  DB_HOST: env.DB_HOST, DB_PORT: env.DB_PORT ?? '4000', DB_USER: env.DB_USER,
  DB_PASSWORD: env.DB_PASSWORD, DB_NAME: env.DB_NAME, DB_SSL: 'true',
});
const { pool } = await import('../db.js');
const { orderRowCodes } = await import('../apps/fab_erp/services/codegenService.js');

const APPLY = process.argv.includes('--apply');
const C = 30005;
const ORDER = 1410063;

/** Row name now → what the shop calls it. */
const ROWS = [
  ['Intermediate Stiffener (drilled)', 'Intermediate Stiffener Hole'],
  ['Intermediate Stiffener', 'Intermediate Stiffener Plain'],
  ['Bearing Stiffener (drilled)', 'Bearing Stiffener Hole'],
  ['Bearing Stiffener', 'Bearing Stiffener Plain'],
];

const conn = await pool.getConnection();
try {
  await conn.beginTransaction();

  // ── the catalogue: a size becomes a thing with a size ────────────────────
  const [items] = await conn.query(
    `SELECT id, name FROM fab_item_catalog
      WHERE company_id = ? AND deleted_at IS NULL AND name LIKE 'Stiffener %×%'`, [C],
  );
  let renamed = 0;
  for (const it of items) {
    const want = it.name.replace(/^Stiffener /, 'Stiffener Plate ');
    if (want === it.name) continue;
    const [[clash]] = await conn.query(
      `SELECT id FROM fab_item_catalog WHERE company_id = ? AND name = ? AND deleted_at IS NULL`, [C, want],
    );
    if (clash) { console.log(`  ${it.name}: "${want}" already exists, left alone`); continue; }
    if (APPLY) await conn.query(`UPDATE fab_item_catalog SET name = ? WHERE id = ?`, [want, it.id]);
    renamed += 1;
  }
  console.log(`catalogue: ${renamed} stiffener item(s) ${APPLY ? 'renamed' : 'to rename'} → "Stiffener Plate <t> × <w>"`);

  // ── the order rows: Plain and Hole ───────────────────────────────────────
  // Longest first, so "Intermediate Stiffener (drilled)" is not caught by the
  // rule for "Intermediate Stiffener".
  for (const [from, to] of ROWS) {
    const [rows] = await conn.query(
      `SELECT id FROM fab_items WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL AND name = ?`,
      [C, ORDER, from],
    );
    if (APPLY && rows.length) {
      await conn.query(`UPDATE fab_items SET name = ? WHERE id IN (?)`, [to, rows.map((r) => r.id)]);
    }
    console.log(`  ${String(rows.length).padStart(3)} rows  ${from}  →  ${to}`);
  }

  if (APPLY) {
    const codes = await orderRowCodes(C, ORDER);
    const seen = new Map();
    for (const [id, c] of codes) seen.set(c, [...(seen.get(c) ?? []), id]);
    const dups = [...seen].filter(([, ids]) => ids.length > 1);
    if (dups.length) {
      throw new Error(`Rolled back: ${dups.length} duplicate code(s), e.g. ${dups[0][0]}`);
    }
    console.log(`codes: ${codes.size} rows, all unique — e.g. ${[...codes.values()].find((c) => /ISH1|ISP1/.test(c))}`);
    await conn.commit();
    console.log('Committed.');
  } else {
    await conn.rollback();
    console.log('DRY RUN — nothing written.');
  }
} catch (e) {
  await conn.rollback();
  throw e;
} finally {
  conn.release();
  await pool.end();
}
