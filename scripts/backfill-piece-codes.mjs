/**
 * backfill-piece-codes.mjs — give every stock piece its code, and put the
 * ledger's piece and batch identities back in their own columns.
 *
 * Two bugs found in the 2026-08-20 UI pass, which are really one bug seen from
 * two ends: nothing was consistently naming a physical piece.
 *
 *   BUG-18  `fab_stock_pieces.code` was NULL on every row older than the
 *           stock-in path that mints codes. The generator was never wrong; it
 *           just never ran for rows that predate it or that init.sql inserts
 *           straight from SQL (the per-machine piece backfill), where no
 *           generator can be called.
 *
 *   BUG-19  a stock-in wrote the PIECE's code (`SP-000010`) into the ledger's
 *           `batch_code`, leaving `piece_code` NULL. A batch is a mill lot that
 *           many pieces share; a piece is one physical thing. Two columns, two
 *           questions — and the answers had been swapped.
 *
 * WHERE THE NUMBERS COME FROM. Codes are minted through `ensurePieceCodes`,
 * which calls the same `generateCode(company, 'stock_piece')` the live paths
 * call, advancing the same `fab_codegen_rules.next_seq`. A parallel numbering
 * scheme invented here would eventually collide with a code the app issues,
 * and a code naming two different pieces is worse than no code at all.
 *
 * THE LEDGER IS AN AUDIT TRAIL, so this corrects only what it can prove:
 *
 *   piece_code   filled ONLY from the row's own `piece_id`. The piece is
 *                identified by a foreign key, and a code is frozen once
 *                issued, so the value written is the same one the row would
 *                have carried had the column been populated at the time.
 *
 *   batch_code   cleared ONLY where it literally equals the referenced piece's
 *                code — the exact signature of the bug, and impossible to
 *                confuse with a real batch number. Whatever batch the row does
 *                know is in `batch_no`, and that is what moves in.
 *
 * Everything else is LEFT ALONE and listed at the end. Rows with `piece_id`
 * NULL — the WIP issues, opens, moves and receipts written before those paths
 * carried a piece reference — cannot say which piece they were about, and no
 * amount of joining recovers it. Guessing from batch + location + item would
 * pick one of several plates off the same lot, and a plausible wrong answer in
 * an audit trail is worse than an honest gap.
 *
 * Read-only unless you ask. Safe to re-run: a second pass finds nothing to do.
 *
 * Usage:
 *   node scripts/backfill-piece-codes.mjs [companyId]           # dry run
 *   node scripts/backfill-piece-codes.mjs [companyId] --apply   # write
 *
 * With no companyId it covers every company that owns stock pieces.
 */

import { pool } from '../db.js';
import { uncodedPieces, ensurePieceCodes } from '../apps/fab_erp/services/stockCodeService.js';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply') || args.includes('--fix');
const only = Number(args.find((a) => /^\d+$/.test(a))) || null;

const mode = APPLY ? 'APPLY' : 'DRY RUN';
console.log(`backfill-piece-codes — ${mode}${APPLY ? '' : '  (re-run with --apply to write)'}`);

const [companies] = await pool.query(
  only
    ? 'SELECT id, name FROM companies WHERE id = ?'
    : `SELECT DISTINCT c.id, c.name FROM companies c
         JOIN fab_stock_pieces p ON p.company_id = c.id`,
  only ? [only] : [],
);
if (!companies.length) {
  console.log('No company matched. Nothing to do.');
  await pool.end();
  process.exit(0);
}

const n = (v) => Number(v ?? 0);

for (const co of companies) {
  console.log(`\n══ ${co.name} (company ${co.id})`);

  // ── BEFORE ───────────────────────────────────────────────────────────────
  const before = await snapshot(co.id);
  report('BEFORE', before);

  // ── 1. codes for every piece, live and soft-deleted ──────────────────────
  //
  // Soft-deleted pieces are included on purpose. A deleted piece is still the
  // subject of the ledger rows that recorded its life, and `code_active`
  // (`if(deleted_at is null, code, null)`) is what the UNIQUE index covers, so
  // coding a dead row cannot take a code away from a live one.
  const uncodedLive = await uncodedPieces(co.id);
  const uncodedAll = await uncodedPieces(co.id, null, { includeDeleted: true });
  const uncodedDeleted = uncodedAll.filter((id) => !uncodedLive.includes(id));

  console.log(`\n  1. piece codes`);
  console.log(`     uncoded live      : ${uncodedLive.length}${uncodedLive.length ? `  (${preview(uncodedLive)})` : ''}`);
  console.log(`     uncoded deleted   : ${uncodedDeleted.length}${uncodedDeleted.length ? `  (${preview(uncodedDeleted)})` : ''}`);

  if (uncodedAll.length && APPLY) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const { minted } = await ensurePieceCodes(conn, co.id, uncodedAll, { includeDeleted: true });
      await conn.commit();
      console.log(`     minted            : ${minted}`);
    } catch (e) {
      await conn.rollback();
      console.log(`     ! minting failed  : ${e.message}`);
    } finally { conn.release(); }
  }

  // ── 2. ledger: piece_code from piece_id ──────────────────────────────────
  //
  // Runs after step 1 so a row whose piece was uncoded a moment ago still gets
  // its snapshot. The code is frozen from the instant it is issued, so this is
  // the same string the row would have carried all along.
  // Counted WITHOUT requiring p.code, because on a dry run step 1 has not run
  // yet — every one of these pieces is about to have a code, and reporting only
  // the handful already coded would understate the work by an order of
  // magnitude. The UPDATE below still refuses to write a NULL.
  const [[fillable]] = await pool.query(
    `SELECT COUNT(*) c FROM fab_stock_ledger l
       JOIN fab_stock_pieces p ON p.id = l.piece_id AND p.company_id = l.company_id
      WHERE l.company_id = ? AND l.piece_id IS NOT NULL AND l.piece_code IS NULL`,
    [co.id],
  );
  console.log(`\n  2. ledger piece_code recoverable from piece_id : ${n(fillable.c)}`
    + `${APPLY ? '' : '  (once step 1 has coded their pieces)'}`);
  if (n(fillable.c) && APPLY) {
    const [r] = await pool.query(
      `UPDATE fab_stock_ledger l
         JOIN fab_stock_pieces p ON p.id = l.piece_id AND p.company_id = l.company_id
          SET l.piece_code = p.code
        WHERE l.company_id = ? AND l.piece_id IS NOT NULL
          AND l.piece_code IS NULL AND p.code IS NOT NULL`,
      [co.id],
    );
    console.log(`     filled            : ${r.affectedRows}`);
  }

  // ── 3. ledger: a piece code sitting in batch_code ────────────────────────
  //
  // Matched by equality with the referenced piece's own code. That is the
  // bug's fingerprint and nothing else produces it: a real batch number would
  // have to have been named identically to the code the generator later issued
  // to the one piece it names.
  const [misfiled] = await pool.query(
    `SELECT l.id, l.txn_type, l.qty, l.batch_code, l.batch_no, p.code pieceCode
       FROM fab_stock_ledger l
       JOIN fab_stock_pieces p ON p.id = l.piece_id AND p.company_id = l.company_id
      WHERE l.company_id = ? AND l.batch_code IS NOT NULL
        AND p.code IS NOT NULL AND l.batch_code = p.code
      ORDER BY l.id`,
    [co.id],
  );
  console.log(`\n  3. ledger rows with a PIECE code in batch_code : ${misfiled.length}`);
  for (const r of misfiled) {
    console.log(`     #${r.id} ${String(r.txn_type).padEnd(12)} batch_code '${r.batch_code}'`
      + ` -> ${r.batch_no == null ? 'NULL (the receipt named no batch)' : `'${r.batch_no}' (from batch_no)`}`);
  }
  if (misfiled.length && APPLY) {
    // batch_no is the row's own record of the lot, written by the same INSERT,
    // so it needs no lookup and cannot disagree with itself.
    const [r] = await pool.query(
      `UPDATE fab_stock_ledger l
         JOIN fab_stock_pieces p ON p.id = l.piece_id AND p.company_id = l.company_id
          SET l.batch_code = NULLIF(l.batch_no, '')
        WHERE l.company_id = ? AND l.batch_code IS NOT NULL
          AND p.code IS NOT NULL AND l.batch_code = p.code`,
      [co.id],
    );
    console.log(`     corrected         : ${r.affectedRows}`);
  }

  // ── 4. what is deliberately not touched ──────────────────────────────────
  const [stranded] = await pool.query(
    `SELECT txn_type, COUNT(*) c, COUNT(DISTINCT COALESCE(batch_code, '~')) codes
       FROM fab_stock_ledger
      WHERE company_id = ? AND deleted_at IS NULL AND piece_id IS NULL
      GROUP BY txn_type ORDER BY c DESC`,
    [co.id],
  );
  console.log(`\n  4. LEFT ALONE — no piece_id, so nothing identifies the piece:`);
  if (!stranded.length) console.log('     (none)');
  for (const s of stranded) {
    console.log(`     ${String(s.txn_type).padEnd(14)} ${String(s.c).padStart(4)} row(s)`);
  }

  // ── AFTER ────────────────────────────────────────────────────────────────
  const after = await snapshot(co.id);
  report('AFTER', after);
}

console.log(APPLY
  ? '\nDone. Re-run to confirm it is a no-op, then run scripts/verify-stock-codes.mjs.'
  : '\nNothing was written. Re-run with --apply to make the changes above.');

await pool.end();

// ---------------------------------------------------------------------------

async function snapshot(companyId) {
  const [[pieces]] = await pool.query(
    `SELECT COUNT(*) total,
            SUM(deleted_at IS NULL AND (code IS NULL OR code = '')) uncodedLive,
            SUM(deleted_at IS NOT NULL AND (code IS NULL OR code = '')) uncodedDeleted
       FROM fab_stock_pieces WHERE company_id = ?`,
    [companyId],
  );
  const [[ledger]] = await pool.query(
    `SELECT COUNT(*) total,
            SUM(piece_id IS NOT NULL) withPiece,
            SUM(piece_id IS NOT NULL AND piece_code IS NULL) pieceNoCode,
            SUM(batch_code IS NOT NULL) withBatchCode
       FROM fab_stock_ledger WHERE company_id = ? AND deleted_at IS NULL`,
    [companyId],
  );
  const [[misfiled]] = await pool.query(
    `SELECT COUNT(*) c FROM fab_stock_ledger l
       JOIN fab_stock_pieces p ON p.id = l.piece_id AND p.company_id = l.company_id
      WHERE l.company_id = ? AND l.batch_code IS NOT NULL AND l.batch_code = p.code`,
    [companyId],
  );
  return { pieces, ledger, misfiled: n(misfiled.c) };
}

function report(label, s) {
  console.log(`\n  ${label}`);
  console.log(`     pieces ${n(s.pieces.total)} · uncoded live ${n(s.pieces.uncodedLive)}`
    + ` · uncoded soft-deleted ${n(s.pieces.uncodedDeleted)}`);
  console.log(`     ledger ${n(s.ledger.total)} · with piece_id ${n(s.ledger.withPiece)}`
    + ` · of those missing piece_code ${n(s.ledger.pieceNoCode)}`
    + ` · batch_code holding a piece code ${s.misfiled}`);
}

function preview(ids) {
  return ids.length <= 8 ? ids.join(', ') : `${ids.slice(0, 8).join(', ')}, …+${ids.length - 8}`;
}
