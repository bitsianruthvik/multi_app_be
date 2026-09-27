/**
 * cf_lock_nested_lines.mjs — locks the lines that were already NESTED before
 * lock existed, keeping every piece code they had. Decided 2026-09-26: lock
 * sits after Values and cut pieces, before nesting — so a line that is nested
 * already is past lock, and is locked now rather than left open behind it.
 *
 *   cd multi_app_be
 *   node scripts/cf_kepl/cf_lock_nested_lines.mjs              # company 2, dry run
 *   CF_BRIDGE_COMPANY=30005 node scripts/cf_kepl/cf_lock_nested_lines.mjs --commit
 *
 * Run it AFTER cf_add_lock_stage.mjs and BEFORE cf_rows_no_codes.mjs: while the
 * rows still carry their codes, the codes the current rules give each piece are
 * captured first; then the line is locked (lockService.lockLine, every check it
 * makes) and every locked piece is compared with what it was, by path_key. A
 * line is committed only when every one of its pieces kept its code — each
 * line in its own transaction, so one that differs changes nothing and the
 * others still lock.
 *
 * Left alone, and said so:
 *   - a line that is not nested (it is still being designed; it locks through
 *     the Lock stage when its values are complete);
 *   - a line RELEASED before lock existed — lock refuses it until the release
 *     is taken back, and taking a release back is a person's decision;
 *   - a line already locked (a second run changes nothing).
 */
import path from 'path';
import { pathToFileURL } from 'url';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
await imp('apps/cf_erp/services/codegenProvider.js');   // registers the code-generator entities
const RO = await imp('apps/cf_erp/services/rollOutService.js');
const { lockLine } = await imp('apps/cf_erp/services/lockService.js');

const COMPANY = Number(process.env.CF_BRIDGE_COMPANY ?? 2);
const COMMIT = process.argv.includes('--commit');
const where = /^(localhost|127\.0\.0\.1|::1)?$/i.test(process.env.DB_HOST ?? '') ? 'local' : 'PRODUCTION';
const [[user]] = await pool.query('SELECT id FROM users WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [COMPANY]);
const c = { companyId: COMPANY, userId: Number(process.env.CF_BRIDGE_USER ?? user?.id) || null };
const say = (...a) => console.log(...a);
say(`${where}, company ${COMPANY} — ${COMMIT ? 'locks each nested line whose pieces all keep their codes' : 'dry run: every line locked, compared, rolled back'}`);

const [lines] = await pool.query(
  `SELECT l.id, l.line_no, l.locked_at, o.code AS order_code,
          (SELECT COUNT(*) FROM cf_production_releases r WHERE r.company_id = l.company_id AND r.order_line_id = l.id AND r.deleted_at IS NULL) AS releases,
          (SELECT COUNT(*) FROM cf_nest_placements p JOIN cf_item_details ci ON ci.master_id = p.cut_plate_id
            WHERE p.company_id = l.company_id AND ci.owner_order_line_id = l.id AND p.deleted_at IS NULL) AS nests
     FROM cf_sales_order_lines l
     JOIN cf_sales_orders o ON o.id = l.order_id AND o.deleted_at IS NULL
     JOIN cf_item_details i ON i.master_id = l.item_id AND i.item_type = 'temporary'
    WHERE l.company_id = ? AND l.deleted_at IS NULL
    ORDER BY o.id, l.line_no`,
  [COMPANY],
);

let failed = 0;
for (const l of lines) {
  const name = `${l.order_code} line ${l.line_no}`;
  if (l.locked_at) { say(`   ${name}: already locked`); continue; }
  if (!Number(l.nests)) { say(`   ${name}: not nested — left to lock through its Lock stage`); continue; }
  if (Number(l.releases)) { say(`   ${name}: RELEASED before lock existed — left alone (take the release back first to lock it)`); continue; }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[line]] = await conn.query(
      `SELECT l.*, o.code AS order_code, o.status AS order_status, o.order_type
         FROM cf_sales_order_lines l JOIN cf_sales_orders o ON o.id = l.order_id WHERE l.company_id = ? AND l.id = ?`,
      [COMPANY, l.id],
    );
    // 1. what the current rules print for every piece, rows' codes still in place
    const plan = await RO.rollOutPlan(conn, COMPANY, line);
    const memo = await RO.seedPieceMemo(conn, COMPANY, line, plan.nodes);
    const linePosition = await RO.linePositionOf(conn, COMPANY, l.id);
    await RO.codeNodes(conn, COMPANY, line, plan.nodes, { consume: false, memo, linePosition });
    const was = new Map(plan.nodes.map((n) => [n.pathKey, n.code]));

    // 2. the lock itself, with every check it makes
    const t0 = Date.now();
    await lockLine(conn, c, l.id);
    const ms = Date.now() - t0;

    // 3. every locked piece against what it was
    const pieces = await RO.lockedPiecesOf(conn, COMPANY, l.id);
    const moved = pieces.filter((p) => was.get(p.path_key) !== p.code);
    const ok = pieces.length === plan.nodes.length && moved.length === 0;
    say(`   ${name}: ${pieces.length} pieces, ${pieces.length - moved.length} kept their code (${ms} ms)${moved.length ? ` — e.g. ${moved.slice(0, 3).map((p) => `${was.get(p.path_key)} -> ${p.code}`).join(', ')}` : ''}`);
    if (ok && COMMIT) { await conn.commit(); say('      locked.'); }
    else {
      await conn.rollback();
      if (!ok) { failed += 1; say('      NOT locked — a code would change.'); }
      else say('      (dry run — rolled back)');
    }
  } catch (err) {
    failed += 1;
    try { await conn.rollback(); } catch { /* the error below is the one that matters */ }
    say(`   ${name}: NOT locked — ${err.message}${err.problems?.length ? `\n      ${err.problems.join('\n      ')}` : ''}`);
  } finally {
    conn.release();
  }
}
say(failed ? `\n${failed} line(s) not locked.` : '\ndone.');
await pool.end();
process.exitCode = failed ? 1 : 0;
