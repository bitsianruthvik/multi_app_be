/**
 * review_marks_test.mjs — the drawing review's decisions kept on the server (reviewService readMarks / writeMarks,
 * cf_review_marks; user, 2026-11-28: "Keep saving the reviews I have written so far, so that if I open it again I can see
 * them"). Runs in one transaction that is rolled back: nothing stays.
 *   node scripts/cf_kepl/review_marks_test.mjs
 * Checks: saved marks read back per person; a later save of a mark replaces it, others stay; the line's route reads the
 * same marks as its standard's; another person sees none; another company's standard is "not found"; a bad decision, a
 * long comment and no signed-in person are refused.
 */
import 'dotenv/config';
import { pool } from '../../apps/cf_erp/lib/db.js';
import * as rv from '../../apps/cf_erp/services/reviewService.js';

let failed = 0;
const ok = (label, cond, detail = '') => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`); if (!cond) failed++; };
const refused = async (label, fn, status) => { try { await fn(); ok(label, false, 'not refused'); } catch (e) { ok(label, e.status === status, `${e.status} ${e.message}`); } };

const conn = await pool.getConnection();
try {
  await conn.beginTransaction();
  const [[line]] = await conn.query(
    `SELECT l.company_id, l.standard_id, l.order_id, l.id FROM cf_sales_order_lines l
       JOIN cf_standard_drawings s ON s.id = l.standard_id AND s.company_id = l.company_id AND s.deleted_at IS NULL
      WHERE l.deleted_at IS NULL ORDER BY l.id DESC LIMIT 1`,
  );
  if (!line) throw new Error('No order line made from a standard drawing in this database.');
  const [[other]] = await conn.query('SELECT id FROM companies WHERE id <> ? ORDER BY id LIMIT 1', [line.company_id]);
  const C = Number(line.company_id), S = Number(line.standard_id), U = 900000001, U2 = 900000002;
  const m1 = `__rmt_${Date.now()}`, m2 = `${m1}_b`;

  ok('save two marks', (await rv.saveStandardReviewMarks(conn, C, S, U, { parts: { [m1]: { d: 'bad', c: 'too short' }, [m2]: { d: 'ok' } } })).saved === 2);
  let got = (await rv.standardReviewMarks(conn, C, S, U)).parts;
  ok('read back', got[m1]?.d === 'bad' && got[m1]?.c === 'too short' && got[m2]?.d === 'ok');
  await rv.saveStandardReviewMarks(conn, C, S, U, { parts: { [m1]: { d: 'q', c: 'look again' } } });
  got = (await rv.lineReviewMarks(conn, C, line.order_id, line.id, U)).parts;
  ok('a later save replaces the mark, the others stay (read by the line)', got[m1]?.d === 'q' && got[m1]?.c === 'look again' && got[m2]?.d === 'ok');
  await rv.saveLineReviewMarks(conn, C, line.order_id, line.id, U, { parts: { [m2]: { d: null, c: '' } } });
  got = (await rv.standardReviewMarks(conn, C, S, U)).parts;
  ok('a cleared mark is not listed', !got[m2] && !!got[m1]);
  ok('another person sees none of it', !(await rv.standardReviewMarks(conn, C, S, U2)).parts[m1]);
  if (other) await refused("another company's standard is not found", () => rv.standardReviewMarks(conn, Number(other.id), S, U), 404);
  await refused("another company's order line is not found", () => rv.lineReviewMarks(conn, Number(other?.id ?? 0), line.order_id, line.id, U), 404);
  await refused('a decision other than ok / bad / q', () => rv.saveStandardReviewMarks(conn, C, S, U, { parts: { x: { d: 'yes' } } }), 422);
  await refused('a comment over 4000 characters', () => rv.saveStandardReviewMarks(conn, C, S, U, { parts: { x: { c: 'x'.repeat(4001) } } }), 422);
  await refused('parts not an object', () => rv.saveStandardReviewMarks(conn, C, S, U, { parts: [] }), 422);
  await refused('no signed-in person', () => rv.standardReviewMarks(conn, C, S, null), 422);
} finally {
  await conn.rollback(); conn.release(); await pool.end();
}
console.log(failed ? `${failed} FAILED` : 'all passed');
process.exit(failed ? 1 : 0);
