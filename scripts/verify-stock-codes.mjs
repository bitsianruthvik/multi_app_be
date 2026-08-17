/**
 * verify-stock-codes.mjs — does every physical thing have a code, and does
 * every movement say which thing moved?
 *
 * Read-only by default. Pass `--fix` to mint codes for uncoded pieces; that is
 * the one write it will do, and it is idempotent.
 *
 * The three questions, which are the three gaps found on 2026-08-17:
 *
 *   1. CODES        production had 0 of 173 pieces coded, despite the column,
 *                   the `stock_piece` codegen rule and stockInService already
 *                   generating one on receipt. Every piece predated that path,
 *                   and init.sql's machine backfill inserts straight from SQL
 *                   where the generator cannot be called.
 *
 *   2. NON-CATALOG  all 173 pieces were catalog-backed and WIP existed only as
 *                   ledger rows with no piece behind them, because
 *                   `catalog_item_id` was NOT NULL and a made part has none.
 *
 *   3. MOVEMENTS    the ledger had grn_receipt / wip_issue / wip_open and
 *                   nothing else. Nothing recorded a move at all.
 *
 * Re-run it after any change to stock handling. A movement that cannot say
 * which piece moved is the failure this is watching for.
 *
 * Usage:  node scripts/verify-stock-codes.mjs [companyId] [--fix]
 */

import { pool } from '../db.js';
import { uncodedPieces, ensurePieceCodes } from '../apps/fab_erp/services/stockCodeService.js';

const args = process.argv.slice(2);
const FIX = args.includes('--fix');
const only = Number(args.find((a) => /^\d+$/.test(a))) || null;
let problems = 0;
const flag = (m) => { problems++; console.log(`   ! ${m}`); };

const [companies] = await pool.query(
  only
    ? 'SELECT id, name FROM companies WHERE id = ?'
    : `SELECT DISTINCT c.id, c.name FROM companies c
         JOIN fab_stock_pieces p ON p.company_id = c.id AND p.deleted_at IS NULL`,
  only ? [only] : [],
);

for (const co of companies) {
  console.log(`\n── ${co.name} (company ${co.id})`);

  // ── 1. every live piece has a code ──────────────────────────────────────
  const uncoded = await uncodedPieces(co.id);
  const [[tot]] = await pool.query(
    'SELECT COUNT(*) n FROM fab_stock_pieces WHERE company_id = ? AND deleted_at IS NULL',
    [co.id],
  );
  console.log(`   pieces: ${tot.n} · uncoded: ${uncoded.length}`);
  if (uncoded.length) {
    if (FIX) {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const { minted } = await ensurePieceCodes(conn, co.id, uncoded);
        await conn.commit();
        console.log(`   minted ${minted} code(s)`);
      } catch (e) { await conn.rollback(); flag(`could not mint: ${e.message}`); }
      finally { conn.release(); }
    } else {
      flag(`${uncoded.length} piece(s) have no code — re-run with --fix`);
    }
  }

  // Codes must be unique among LIVE pieces. uq_fsp_company_code_active enforces
  // it, so a duplicate here means something wrote `code` without `code_active`.
  const [[dupe]] = await pool.query(
    `SELECT COUNT(*) n FROM (
       SELECT code FROM fab_stock_pieces
        WHERE company_id = ? AND deleted_at IS NULL AND code IS NOT NULL
        GROUP BY code HAVING COUNT(*) > 1) d`,
    [co.id],
  );
  if (Number(dupe.n) > 0) flag(`${dupe.n} code(s) shared by more than one live piece`);

  // `code_active` must stay GENERATED. It is the uniqueness mechanism, and if
  // someone ever converts it to a plain column the guarantee silently becomes
  // "whatever the last writer remembered to set" — checking its value would
  // prove nothing, since while generated it cannot disagree with `code`.
  const [[gen]] = await pool.query(
    `SELECT EXTRA e FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fab_stock_pieces'
        AND COLUMN_NAME = 'code_active'`,
  );
  if (!/GENERATED/i.test(gen?.e ?? '')) {
    flag('fab_stock_pieces.code_active is no longer a generated column — code uniqueness is no longer automatic');
  }

  // ── 2. non-catalog stock can be a piece ─────────────────────────────────
  const [[nullable]] = await pool.query(
    `SELECT IS_NULLABLE v FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fab_stock_pieces'
        AND COLUMN_NAME = 'catalog_item_id'`,
  );
  if (nullable?.v !== 'YES') flag('fab_stock_pieces.catalog_item_id is still NOT NULL — WIP for a made part cannot be a piece');

  const [[kinds]] = await pool.query(
    `SELECT SUM(catalog_item_id IS NOT NULL) catalogBacked,
            SUM(catalog_item_id IS NULL)     nonCatalog,
            SUM(wip_item_id IS NOT NULL)     wip
       FROM fab_stock_pieces WHERE company_id = ? AND deleted_at IS NULL`,
    [co.id],
  );
  console.log(`   catalog-backed ${kinds.catalogBacked ?? 0} · non-catalog ${kinds.nonCatalog ?? 0} · WIP ${kinds.wip ?? 0}`);

  // A piece must be identifiable as SOMETHING.
  const [[orphan]] = await pool.query(
    `SELECT COUNT(*) n FROM fab_stock_pieces
      WHERE company_id = ? AND deleted_at IS NULL
        AND catalog_item_id IS NULL AND wip_item_id IS NULL`,
    [co.id],
  );
  if (Number(orphan.n) > 0) flag(`${orphan.n} piece(s) have neither a catalog item nor a WIP item — nothing identifies them`);

  // ── 3. movements are recorded, and say what moved ───────────────────────
  const [types] = await pool.query(
    `SELECT txn_type t, COUNT(*) n,
            SUM(piece_id IS NULL) noPiece, SUM(piece_code IS NULL) noCode
       FROM fab_stock_ledger
      WHERE company_id = ? AND deleted_at IS NULL
      GROUP BY txn_type ORDER BY n DESC`,
    [co.id],
  );
  console.log('   ledger:');
  for (const t of types) {
    console.log(`     ${String(t.t).padEnd(14)} ${String(t.n).padStart(5)}`
      + (Number(t.noPiece) ? `  (${t.noPiece} with no piece)` : ''));
  }

  // Every MOVE must carry piece, code and a pairable ref.
  const [[badMove]] = await pool.query(
    `SELECT COUNT(*) n FROM fab_stock_ledger
      WHERE company_id = ? AND deleted_at IS NULL
        AND txn_type IN ('transfer','transfer_op','wip_move','machine_move')
        AND (piece_id IS NULL OR piece_code IS NULL OR move_ref IS NULL)`,
    [co.id],
  );
  if (Number(badMove.n) > 0) flag(`${badMove.n} movement row(s) cannot say which piece moved`);

  // Both halves, or the balance per area is wrong.
  const [halves] = await pool.query(
    `SELECT move_ref, COUNT(*) n, SUM(qty) net FROM fab_stock_ledger
      WHERE company_id = ? AND deleted_at IS NULL AND move_ref IS NOT NULL
      GROUP BY move_ref HAVING COUNT(*) <> 2 OR SUM(qty) <> 0`,
    [co.id],
  );
  for (const h of halves) {
    flag(`move ${h.move_ref} has ${h.n} row(s) netting ${h.net} — a move must be two rows netting zero`);
  }
  const [[moves]] = await pool.query(
    `SELECT COUNT(DISTINCT move_ref) n FROM fab_stock_ledger
      WHERE company_id = ? AND deleted_at IS NULL AND move_ref IS NOT NULL`,
    [co.id],
  );
  console.log(`   recorded moves: ${moves.n}`);
}

console.log(problems === 0
  ? '\nCLEAN — every piece is coded and identifiable, and every movement says what moved.'
  : `\nREVIEW — ${problems} problem(s) above.`);

await pool.end();
