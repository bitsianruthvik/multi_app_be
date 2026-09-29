/**
 * cf_rows_no_codes.mjs — an order's rows lose their codes (user, 2026-09-26: "the
 * codes can't live on the BOM as it is yet to be rolled out based on the
 * quantity"). A BOM row is a design with a quantity; its PIECES are coded when
 * the line is LOCKED (lockService). Idempotent; every company unless one is named.
 *
 *   cd multi_app_be
 *   node scripts/cf_kepl/cf_rows_no_codes.mjs              # dry run: does it all, says so, rolls back
 *   node scripts/cf_kepl/cf_rows_no_codes.mjs --commit     # does it
 *   CF_COMPANY=30005 node scripts/cf_kepl/cf_rows_no_codes.mjs --commit
 *
 * Acting user CF_BRIDGE_USER (the rules' updated_by), else none.
 *
 * PER COMPANY, IN THIS ORDER
 *
 *   1. The top piece rule stops reading the row's code. A production-piece rule
 *      for the top of the tree (placement = line) that prints {item.code} gets,
 *      in its place, the pattern of the item rule that coded the line's row
 *      (CFTMP-LINE: {order.code}-{record.shortName}-{position:00}), each token
 *      said the piece's way — record.shortName -> item.shortName, position ->
 *      line.position (given at lock, no gaps). SO-…-SPAN-01-1 stays
 *      SO-…-SPAN-01-1. A token that has no piece equivalent stops the company,
 *      in words, before anything is written.
 *      THEN IT PROVES IT: every live custom line whose row still has a code is
 *      coded through the new rule, and must come out as that code plus "-1"
 *      (what the old rule printed for its first piece). A line where it does not
 *      — its row was numbered with a gap the lock no longer leaves (the "2"
 *      after a deleted line) — is listed; if such a line is released or
 *      nested, its pieces' codes would change, so the company is not committed.
 *   2. The row rules retire (status inactive): every active item rule for
 *      temporary items that can reach one that is not a cut plate. The cut
 *      plate rule (CFTMP-BLANK) stays: a cut plate names a rectangle by size.
 *   3. Rows on UNLOCKED lines lose their codes — cut plates keep theirs, and a
 *      locked line's rows keep theirs (frozen: its pieces carry the codes).
 *
 * CHECKS, before a company is committed: no unlocked line's row has a code, no
 * active item rule reaches a row, no piece rule for a top piece prints
 * {item.code}. A second run changes nothing.
 */
import path from 'path';
import { pathToFileURL } from 'url';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
await imp('apps/cf_erp/services/codegenProvider.js');   // registers the code-generator entities
const codegen = await imp('apps/cf_erp/modules/codegen/service.js');
const { generate } = await imp('apps/cf_erp/modules/codegen/index.js');
const { linePositionOf } = await imp('apps/cf_erp/services/rollOutService.js');
const { subtreeIds } = await imp('apps/cf_erp/services/tree.js');

const COMMIT = process.argv.includes('--commit');
const ONLY = process.env.CF_COMPANY ? Number(process.env.CF_COMPANY) : null;
const USER = Number(process.env.CF_BRIDGE_USER ?? 0) || null;
const say = (...a) => console.log(...a);

// ---------------------------------------------------------------------------
// Rules, the way the deleted cf_range_rules read and writes them: whole.
// ---------------------------------------------------------------------------
const asBody = (full) => ({
  code: full.code, name: full.name, entityType: full.entityType, targetField: full.targetField,
  seqScope: full.seqScope, priority: full.priority, description: full.description, status: full.status,
  conditions: full.conditions.map((x) => ({ tokenKey: x.tokenKey, operator: x.operator, value: x.value })),
  segments: full.segments.map((s) => ({
    segmentType: s.segmentType, literalText: s.literalText, tokenKey: s.tokenKey,
    format: s.format, transform: s.transform, maxLength: s.maxLength, isRequired: s.isRequired,
  })),
});
const patternOf = (full) => full.segments.map((s) => {
  if (s.segmentType === 'literal') return s.literalText;
  if (s.segmentType === 'token') return `{${s.tokenKey}${s.format ? `:${s.format}` : ''}${s.isRequired ? '' : '?'}}`;
  if (s.segmentType === 'sequence') return `{#${s.format ?? ''}}`;
  return `{date:${s.format ?? ''}}`;
}).join('');
const valuesOf = (x) => (x.operator === 'in' ? String(x.value).split(',').map((v) => v.trim()) : [String(x.value).trim()]);
const hasCond = (full, key, value) => full.conditions.some((x) => x.tokenKey === key && valuesOf(x).includes(value));

/** An item token said the way a production piece says it — or undefined when it has no such word. */
const PIECE_WORD = {
  'record.shortName': 'item.shortName',
  'definition.shortName': 'definition.shortName',
  'order.code': 'order.code',
  'line.no': 'line.no',
  position: 'line.position',     // a line's row: its place among the order's lines of the same design
};

async function schemes(db, companyId, entityType) {
  const [rows] = await db.query(
    "SELECT id FROM cf_code_schemes WHERE company_id = ? AND entity_type = ? AND target_field = 'code' AND deleted_at IS NULL ORDER BY code",
    [companyId, entityType],
  );
  const out = [];
  for (const r of rows) out.push(await codegen.getScheme(db, companyId, r.id));
  return out;
}

async function cutPlateNodes(db, companyId) {
  const [[n]] = await db.query("SELECT id FROM cf_classification_nodes WHERE company_id = ? AND code = 'CUT_PLATE' AND deleted_at IS NULL", [companyId]);
  return n ? new Set(await subtreeIds(db, companyId, n.id)) : new Set();
}

/** A rule for temporary items that only ever reaches cut plates: classified at or under CUT_PLATE. */
const onlyCutPlates = (full, cut) => full.conditions.some((x) => x.tokenKey === 'classification' && valuesOf(x).every((v) => cut.has(Number(v))));

// ---------------------------------------------------------------------------
// One company
// ---------------------------------------------------------------------------
async function runCompany(db, companyId) {
  const out = { companyId, rewritten: [], retired: [], cleared: 0, mismatches: [], blocked: [], problems: [] };
  const cut = await cutPlateNodes(db, companyId);
  const itemRules = await schemes(db, companyId, 'item');
  const pieceRules = await schemes(db, companyId, 'production_piece');

  // 1. the top piece rule: {item.code} -> the line row's own pattern, said the piece's way
  const lineRule = itemRules.find((r) => r.status === 'active' && hasCond(r, 'kind', 'temporary') && hasCond(r, 'placement', 'line'));
  for (const full of pieceRules) {
    const at = full.segments.findIndex((s) => s.segmentType === 'token' && s.tokenKey === 'item.code');
    if (at < 0 || !hasCond(full, 'placement', 'line') || full.status !== 'active') continue;
    if (!lineRule) { out.problems.push(`${full.code} prints {item.code} for a top piece, and no item rule for a line's row says what that code was.`); continue; }
    const untranslatable = lineRule.segments.filter((s) => s.segmentType === 'token' && !PIECE_WORD[s.tokenKey]).map((s) => s.tokenKey);
    if (lineRule.segments.some((s) => s.segmentType === 'sequence')) untranslatable.push('a running number');
    if (untranslatable.length) { out.problems.push(`${full.code}: ${lineRule.code} prints ${untranslatable.join(', ')}, which a production piece cannot print.`); continue; }
    const body = asBody(full);
    const said = asBody(lineRule).segments.map((s) => (s.segmentType === 'token' ? { ...s, tokenKey: PIECE_WORD[s.tokenKey] } : s));
    body.segments.splice(at, 1, ...said);
    const after = await codegen.updateScheme(db, companyId, USER, full.id, body);
    out.rewritten.push(`${full.code}  ${patternOf(full)}  ->  ${patternOf(after)}`);
  }

  // ...and prove it on every live custom line whose row still has its code
  const [lines] = await db.query(
    `SELECT l.id, l.line_no, l.order_id, l.item_id, l.locked_at, m.code AS row_code, o.code AS order_code,
            (SELECT COUNT(*) FROM cf_production_releases r WHERE r.company_id = l.company_id AND r.order_line_id = l.id AND r.deleted_at IS NULL) AS releases,
            -- nested: a cut plate of this line has a place on a plate
            (SELECT COUNT(*) FROM cf_nest_placements p JOIN cf_item_details ci ON ci.master_id = p.cut_plate_id
              WHERE p.company_id = l.company_id AND ci.owner_order_line_id = l.id AND p.deleted_at IS NULL) AS nests
       FROM cf_sales_order_lines l
       JOIN cf_sales_orders o ON o.id = l.order_id AND o.deleted_at IS NULL
       JOIN cf_master_records m ON m.id = l.item_id
       JOIN cf_item_details i ON i.master_id = m.id AND i.item_type = 'temporary'
      WHERE l.company_id = ? AND l.deleted_at IS NULL AND m.code IS NOT NULL
      ORDER BY o.id, l.line_no`,
    [companyId],
  );
  if (out.rewritten.length) {
    for (const l of lines) {
      const g = await generate(db, companyId, 'production_piece', 'code', {
        draft: { itemId: l.item_id, orderId: l.order_id, lineNo: l.line_no, linePosition: await linePositionOf(db, companyId, l.id), parentCode: null, pieceNo: 1, pieceSeq: 1 },
      }, { consume: false }).catch((e) => ({ text: null, error: e.message }));
      const want = `${l.row_code}-1`;
      if (g?.text !== want) {
        const hard = Number(l.releases) > 0 || Number(l.nests) > 0;
        out.mismatches.push(`${l.order_code} line ${l.line_no}: the old rule printed ${want}, the new one ${g?.text ?? `nothing (${g?.error ?? 'no rule'})`}${hard ? ' — RELEASED OR NESTED' : ''}`);
        if (hard) out.blocked.push(`${l.order_code} line ${l.line_no}`);
      }
    }
  }

  // 2. the row rules retire
  for (const full of itemRules) {
    if (full.status !== 'active' || !hasCond(full, 'kind', 'temporary') || onlyCutPlates(full, cut)) continue;
    await codegen.updateScheme(db, companyId, USER, full.id, { ...asBody(full), status: 'inactive' });
    out.retired.push(`${full.code}  ${patternOf(full)}`);
  }

  // 3. rows on unlocked lines lose their codes; cut plates and locked lines keep theirs
  const cutIds = [...cut];
  const [res] = await db.query(
    `UPDATE cf_master_records m
       JOIN cf_item_details i ON i.master_id = m.id AND i.item_type = 'temporary'
       JOIN cf_sales_order_lines l ON l.id = i.owner_order_line_id AND l.locked_at IS NULL
        SET m.code = NULL
      WHERE m.company_id = ? AND m.code IS NOT NULL
        ${cutIds.length ? 'AND m.classification_id NOT IN (?)' : ''}`,
    cutIds.length ? [companyId, cutIds] : [companyId],
  );
  out.cleared = res.affectedRows;

  // checks
  const [[left]] = await db.query(
    `SELECT COUNT(*) AS n FROM cf_master_records m
       JOIN cf_item_details i ON i.master_id = m.id AND i.item_type = 'temporary'
       JOIN cf_sales_order_lines l ON l.id = i.owner_order_line_id AND l.locked_at IS NULL AND l.deleted_at IS NULL
      WHERE m.company_id = ? AND m.deleted_at IS NULL AND m.code IS NOT NULL
        ${cutIds.length ? 'AND m.classification_id NOT IN (?)' : ''}`,
    cutIds.length ? [companyId, cutIds] : [companyId],
  );
  if (Number(left.n)) out.problems.push(`${left.n} rows of unlocked lines still have a code.`);
  for (const full of await schemes(db, companyId, 'item')) {
    if (full.status === 'active' && hasCond(full, 'kind', 'temporary') && !onlyCutPlates(full, cut)) out.problems.push(`Item rule ${full.code} still reaches rows.`);
  }
  for (const full of await schemes(db, companyId, 'production_piece')) {
    if (full.status === 'active' && hasCond(full, 'placement', 'line') && full.segments.some((s) => s.segmentType === 'token' && s.tokenKey === 'item.code')) {
      out.problems.push(`Piece rule ${full.code} still prints {item.code} for a top piece.`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
const [companies] = ONLY
  ? await pool.query('SELECT id, name FROM companies WHERE id = ?', [ONLY])
  : await pool.query(
    `SELECT DISTINCT c.id, c.name FROM companies c
      WHERE EXISTS (SELECT 1 FROM cf_code_schemes s WHERE s.company_id = c.id AND s.deleted_at IS NULL)
         OR EXISTS (SELECT 1 FROM cf_item_details i WHERE i.company_id = c.id AND i.item_type = 'temporary')
      ORDER BY c.id`,
  );
say(`${COMMIT ? 'COMMIT' : 'DRY RUN'} — ${companies.length} compan${companies.length === 1 ? 'y' : 'ies'}`);
let failed = 0;
for (const co of companies) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const r = await runCompany(conn, co.id);
    say(`\n== company ${co.id} (${co.name}) ==`);
    for (const x of r.rewritten) say(`   rewritten  ${x}`);
    for (const x of r.retired) say(`   retired    ${x}`);
    say(`   rows of unlocked lines cleared of their codes: ${r.cleared}`);
    for (const x of r.mismatches) say(`   position   ${x}`);
    for (const x of r.problems) say(`   PROBLEM    ${x}`);
    const stop = r.problems.length > 0 || r.blocked.length > 0;
    if (stop) {
      failed += 1;
      await conn.rollback();
      say(`   rolled back${r.blocked.length ? ` — the pieces of ${r.blocked.join(', ')} would change code; lock them at their old position first` : ''}.`);
    } else if (COMMIT) {
      await conn.commit();
      say('   committed.');
    } else {
      await conn.rollback();
      say('   (dry run — rolled back)');
    }
  } catch (err) {
    failed += 1;
    try { await conn.rollback(); } catch { /* the error below is the one that matters */ }
    say(`\n== company ${co.id} (${co.name}) — THREW: ${err.message}`);
  } finally {
    conn.release();
  }
}
say(failed ? `\n${failed} compan${failed === 1 ? 'y' : 'ies'} not done.` : '\nall done.');
await pool.end();
process.exitCode = failed ? 1 : 0;
