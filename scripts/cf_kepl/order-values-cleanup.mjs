/**
 * order-values-cleanup.mjs — existing sales orders brought in line with the values their rows
 * need now (user, 2026-10-08: "in the existing SOs, please do the clean up of values to match
 * what is currently there"). Follows flow-specs-migrate.mjs (§50).
 *
 * Only the values that move retired or moved are looked at (RETIRED + OP_INPUTS below); nothing
 * else on an order row is touched. On every order row (temporary item), each one is:
 *
 *   READ BY ITS FLOW  kept. If no rule asks for it any more, the row gets the rule its flow would
 *                     give (entered, required, origin 'flow'); an optional rule the migration left
 *                     on it becomes that rule. A released line's times keep their inputs.
 *   ASKED BY A RULE   kept (its chain still asks for it, e.g. a cut plate's own CUT_LENGTH).
 *   NEITHER           the value goes, and so does the optional rule flow-specs-migrate left only
 *                     to keep it visible.
 * The row's flow: the flow its BOM line names, else its own, else its definition's.
 * Values are soft-deleted (deleted_at), never erased.
 *
 *   node scripts/cf_kepl/order-values-cleanup.mjs --company 30005            (dry run: rolled back)
 *   node scripts/cf_kepl/order-values-cleanup.mjs --company 30005 --apply    (commits)
 * Re-running changes nothing.
 */
const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const COMPANY = Number(arg('company'));
const APPLY = process.argv.includes('--apply');
if (!Number.isInteger(COMPANY)) throw new Error('Usage: --company <id> [--apply]');

const RETIRED = ['ARC_WELD_SIZE', 'MIG_WELD_SIZE', 'SAW_WELD_SIZE', 'WELD_LENGTH', 'WELD_SIZE', 'COATS', 'JOINTS', 'STIFFENERS',
  'STIFFENERS_AFTER_FLIP', 'GIRDER_TYPE', 'HOLE_DIA', 'HOLED', 'GIRDER_SPACING', 'SKEW_ANGLE'];
const OP_INPUTS = ['ARC_WELD_LENGTH', 'CUT_LENGTH', 'HBFIT_JOINTS', 'HOLES', 'HOLES_BOTTOM', 'HOLES_INNER', 'HOLES_TOP', 'HOLE_TRANSFERS',
  'LINEMATCH_JOINTS', 'METALLISE_COATS', 'MIG_WELD_LENGTH', 'MIG_WELD_LENGTH_AFTER_FLIP', 'PAINT_COATS', 'PIERCINGS', 'SAW_WELD_LENGTH',
  'STIFFENER_FIT_TONNES', 'STIFFENER_FIT_TONNES_AFTER_FLIP', 'STUDS'];
const CODES = [...RETIRED, ...OP_INPUTS];

const { pool } = await import('../../db.js');
const { readMasters, resolveCodes } = await import('../../apps/cf_erp/lib/cutFrom.js');
const { neededCodesOfFlows } = await import('../../apps/cf_erp/services/flowSpecService.js');
const { insertRows } = await import('../../apps/cf_erp/lib/db.js');

const db = await pool.getConnection();
try {
  await db.beginTransaction();
  // Every order row holding a value for one of the codes.
  const [held] = await db.query(
    `SELECT v.id, v.subject_id, v.specification_id, UPPER(s.code) AS code, o.code AS order_code, ol.line_no
       FROM cf_spec_values v
       JOIN cf_specifications s ON s.id = v.specification_id AND s.code IN (?)
       JOIN cf_item_details i ON i.master_id = v.subject_id AND i.item_type = 'temporary' AND i.deleted_at IS NULL
       LEFT JOIN cf_sales_order_lines ol ON ol.id = i.owner_order_line_id
       LEFT JOIN cf_sales_orders o ON o.id = ol.order_id
      WHERE v.company_id = ? AND v.subject_type = 'master' AND v.deleted_at IS NULL
        AND (v.value_number IS NOT NULL OR v.value_text IS NOT NULL OR v.value_bool IS NOT NULL OR v.value_date IS NOT NULL OR v.option_id IS NOT NULL)`,
    [CODES, COMPANY]);
  const ids = [...new Set(held.map((h) => Number(h.subject_id)))];
  console.log(`${held.length} values of retired or moved fields on ${ids.length} order rows`);
  if (!ids.length) { await db.rollback(); console.log('Nothing to do.'); process.exit(0); }

  // Each row's flow, and what that flow reads.
  const [fl] = await db.query(
    `SELECT m.id, m.default_flow_id AS own, d.default_flow_id AS def,
            (SELECT bl.operation_flow_id FROM cf_bom_lines bl WHERE bl.company_id = m.company_id AND bl.child_id = m.id AND bl.deleted_at IS NULL AND bl.operation_flow_id IS NOT NULL ORDER BY bl.id LIMIT 1) AS line_flow
       FROM cf_master_records m JOIN cf_item_details i ON i.master_id = m.id AND i.deleted_at IS NULL
       LEFT JOIN cf_master_records d ON d.id = i.source_definition_id
      WHERE m.company_id = ? AND m.id IN (?)`, [COMPANY, ids]);
  const flowOf = new Map(fl.map((r) => [Number(r.id), r.line_flow ?? r.own ?? r.def ?? null]));
  const need = await neededCodesOfFlows(db, COMPANY, [...new Set([...flowOf.values()].filter((f) => f != null).map(Number))]);
  const reads = (id, code) => { const f = flowOf.get(id); return f != null && (need.get(Number(f))?.has(code) ?? false); };

  // What each row's chain asks, and the rules the row holds itself.
  const resolved = await resolveCodes(db, COMPANY, await readMasters(db, COMPANY, ids), CODES);
  const [own] = await db.query(
    `SELECT a.id, a.subject_id, UPPER(s.code) AS code, a.origin, a.is_required, a.value_rule, a.created_by
       FROM cf_spec_assignments a JOIN cf_specifications s ON s.id = a.specification_id AND s.code IN (?)
      WHERE a.company_id = ? AND a.subject_type = 'master' AND a.subject_id IN (?) AND a.capture_at = 'item' AND a.deleted_at IS NULL`,
    [CODES, COMPANY, ids]);
  const ownOf = new Map(own.map((a) => [`${a.subject_id}:${a.code}`, a]));
  /** An optional, unattributed, entered rule of the row's own: what flow-specs-migrate left to keep a value visible. */
  const keptVisible = (a) => a && a.origin === 'manual' && !a.is_required && a.created_by == null && a.value_rule === 'entered';

  const dropValues = [];
  const dropRules = [];
  const toFlowRule = [];
  const addRules = [];
  const tally = new Map();
  const count = (order, what) => { const k = `${order ?? '(no order)'}|${what}`; tally.set(k, (tally.get(k) ?? 0) + 1); };
  for (const h of held) {
    const id = Number(h.subject_id);
    const a = ownOf.get(`${id}:${h.code}`);
    const rule = resolved.get(id)?.get(h.code)?.rule ?? null;
    const order = h.order_code ? `${h.order_code} line ${h.line_no}` : null;
    if (reads(id, h.code)) {
      if (keptVisible(a)) { toFlowRule.push(a.id); count(order, `${h.code} kept (its flow reads it) — now required`); }
      else if (!rule || !rule.applicable) { addRules.push([COMPANY, h.specification_id, 'master', id, 'item', 1, 1, 'entered', 'flow']); count(order, `${h.code} kept (its flow reads it) — rule added`); }
      continue;
    }
    if (rule && rule.applicable && !keptVisible(a)) continue;               // still asked for by its rules
    dropValues.push(h.id);
    if (keptVisible(a)) dropRules.push(a.id);
    count(order, `${h.code} removed`);
  }
  if (dropValues.length) await db.query('UPDATE cf_spec_values SET deleted_at = NOW() WHERE company_id = ? AND id IN (?)', [COMPANY, dropValues]);
  if (dropRules.length) await db.query('UPDATE cf_spec_assignments SET deleted_at = NOW() WHERE company_id = ? AND id IN (?)', [COMPANY, [...new Set(dropRules)]]);
  if (toFlowRule.length) await db.query("UPDATE cf_spec_assignments SET origin = 'flow', is_required = 1 WHERE company_id = ? AND id IN (?)", [COMPANY, toFlowRule]);
  if (addRules.length) await insertRows(db, 'cf_spec_assignments', ['company_id', 'specification_id', 'subject_type', 'subject_id', 'capture_at', 'is_required', 'is_applicable', 'value_rule', 'origin'], addRules);

  const rows = [...tally].map(([k, n]) => { const [o, w] = k.split('|'); return { o, w, n }; }).sort((x, y) => x.o.localeCompare(y.o) || x.w.localeCompare(y.w));
  let last = null;
  for (const r of rows) { if (r.o !== last) { console.log(`\n  ${r.o}`); last = r.o; } console.log(`     ${String(r.n).padStart(4)}  ${r.w}`); }
  console.log(`\nSUMMARY  ${dropValues.length} values removed · ${dropRules.length} leftover rules removed · ${toFlowRule.length + addRules.length} values kept because their flow reads them`);
  if (APPLY) { await db.commit(); console.log('COMMITTED'); } else { await db.rollback(); console.log('DRY RUN — rolled back. Add --apply to keep it.'); }
} catch (err) {
  await db.rollback().catch(() => {});
  console.error('ERROR', err.message);
  process.exitCode = 1;
} finally {
  db.release();
  await pool.end();
}
