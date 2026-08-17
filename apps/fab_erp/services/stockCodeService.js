/**
 * stockCodeService.js — every stock piece has a code, and it never changes.
 *
 * A code is how a person refers to a physical thing: it goes on the paint pen
 * mark, the tag, the ledger row and the conversation. `fab_stock_pieces.code`
 * and a `stock_piece` codegen rule (`SP-` + 6 digits) both existed, and
 * `stockInService` generates one on goods receipt — but 0 of production's 173
 * pieces had one, because every piece predates that path and because the
 * machine backfill in init.sql inserts pieces straight from SQL, where the
 * generator cannot be called.
 *
 * So this is deliberately SELF-HEALING rather than a one-time backfill. Any
 * code path that is about to name a piece calls `ensurePieceCode`, which
 * returns the existing code or mints one and persists it. A piece created by a
 * future migration is uncoded only until the first thing that needs to talk
 * about it, and then it is coded forever.
 *
 * NEVER WRITE `code_active`. It is a VIRTUAL GENERATED column —
 * `if(deleted_at is null, code, null)` — and `uq_fsp_company_code_active` is
 * UNIQUE over it. That combination is what makes a code unique among LIVE
 * pieces while a soft-deleted piece keeps the code its history refers to, and
 * it is derived, so assigning to it is an error rather than a no-op:
 *
 *   The value specified for generated column 'code_active' ... is not allowed
 *
 * Set `code` and the uniqueness follows on its own.
 */

import { pool } from '../../../db.js';
import { generateCode } from './codegenService.js';

/**
 * This piece's code, minting one if it has none.
 *
 * @param {object} conn a connection/transaction — the code must be part of
 *   whatever movement is being recorded, so a rolled-back move does not burn a
 *   sequence number or leave a piece coded for an event that never happened.
 * @returns {Promise<string|null>} null only if the piece does not exist
 */
export async function ensurePieceCode(conn, companyId, pieceId) {
  if (!pieceId) return null;
  const exec = conn ?? pool;

  const [[piece]] = await exec.query(
    `SELECT id, code FROM fab_stock_pieces
      WHERE id = ? AND company_id = ? AND deleted_at IS NULL LIMIT 1`,
    [pieceId, companyId],
  );
  if (!piece) return null;
  if (piece.code) return piece.code;

  const code = await generateCode(companyId, 'stock_piece', {}, exec);
  await exec.query(
    `UPDATE fab_stock_pieces SET code = ? WHERE id = ? AND company_id = ?`,
    [code, pieceId, companyId],
  );
  return code;
}

/**
 * Codes for many pieces at once, minting only the missing ones.
 *
 * One query for what exists and one INSERT-worth of work per gap, because the
 * backfill runs over every piece a company owns and doing that a round trip at
 * a time is the difference between a second and a minute.
 *
 * @returns {Promise<{ codes: Map<number,string>, minted: number }>}
 */
export async function ensurePieceCodes(conn, companyId, pieceIds) {
  const ids = [...new Set((pieceIds ?? []).map(Number).filter(Boolean))];
  const codes = new Map();
  if (!ids.length) return { codes, minted: 0 };
  const exec = conn ?? pool;

  const [rows] = await exec.query(
    `SELECT id, code FROM fab_stock_pieces
      WHERE company_id = ? AND deleted_at IS NULL AND id IN (${ids.map(() => '?').join(',')})`,
    [companyId, ...ids],
  );

  let minted = 0;
  for (const r of rows) {
    if (r.code) { codes.set(Number(r.id), r.code); continue; }
    // Sequentially, not in parallel: generateCode advances a shared counter, and
    // concurrent callers would race for the same number.
    const code = await generateCode(companyId, 'stock_piece', {}, exec);
    await exec.query(
      `UPDATE fab_stock_pieces SET code = ? WHERE id = ? AND company_id = ?`,
      [code, r.id, companyId],
    );
    codes.set(Number(r.id), code);
    minted++;
  }
  return { codes, minted };
}

/** Every live piece of this company that still has no code. */
export async function uncodedPieces(companyId, conn = null) {
  const exec = conn ?? pool;
  const [rows] = await exec.query(
    `SELECT id FROM fab_stock_pieces
      WHERE company_id = ? AND deleted_at IS NULL AND (code IS NULL OR code = '')
      ORDER BY id`,
    [companyId],
  );
  return rows.map((r) => Number(r.id));
}
