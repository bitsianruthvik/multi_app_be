/**
 * def-merge.mjs — merges duplicate TEMPLATE definitions into the catalog's existing ones
 * (TM/drawing_bom/DEFINITION_AUDIT.md §4, plan file TM/drawing_bom/def_merge_plan.json).
 * DRY RUN BY DEFAULT: everything is done in a transaction per pair, then rolled back. --apply commits.
 *
 *   cd multi_app_be
 *   node scripts/cf_kepl/def-merge.mjs --plan ../drawing_bom/def_merge_plan.json --company 30005 --prod            dry run
 *   node scripts/cf_kepl/def-merge.mjs --plan ../drawing_bom/def_merge_plan.json --company 30005 --prod --apply    writes
 *        [--only 9100003,9100004]   only these `from` ids
 *
 * For each pair { from, to }:
 *   CHECKS (nothing is written for a pair that fails one):
 *     both are live definitions of the same type, `to` is active, `from` is not `to`;
 *     no row made from `from` (or holding it in its BOM) belongs to a locked / released / confirmed / closed line;
 *     `from` is not tested by a coding rule, and has no definition-level spec rules or values of its own (taking those
 *     onto `to` would change every other user of `to` — a person decides that);
 *     a pair already done (`from` obsolete and used by nothing) is skipped.
 *   WHAT IS RE-POINTED from `from` to `to` (every column that can name a template definition — init.sql):
 *     cf_item_details.source_definition_id   the order rows (temporary items, standard drawings' trees included); the
 *                                            row moves to `to`'s classification (a temporary item sits where its
 *                                            definition sits, as masterRecordService.updateRecord does), a row still
 *                                            named exactly like `from` takes `to`'s name, and its derived values are
 *                                            worked out again (valueService.materialize)
 *     cf_bom_lines.design_id (+ position)    a new position after `to`'s highest in that BOM, deleted lines included
 *                                            (uq_cbl_position); rows have no code before their line is locked
 *     cf_bom_lines.child_id                  where a line's child is the definition itself
 *     cf_bom_lines.selection_definition_id   (selections only — template pairs have none; checked)
 *     cf_sales_order_lines.design_id (+ position)
 *     cf_step_wait_rules.target_definition_id
 *     cf_cut_allowances.definition_id
 *     cf_order_execution_plans.production_level_id / dispatch_level_id, cf_production_orders.dispatch_level_id
 *     cf_standard_drawing_versions.design_id
 *     cf_drawing_links (subject master_record)  a link `to` already has is dropped (soft delete) instead
 *   VALUES: a value a row holds as ENTERED whose specification applied under `from` (row, `from`, `from`'s classes)
 *     but would not apply under `to` gets a rule on `to` (entered, item level — assignmentService.createRule), so no
 *     row value is hidden. Rematerialising every other row of `to` is deferred and not needed (an entered rule
 *     derives nothing).
 *   LAST: `from` gets a note in its description ("Merged into …" — the schema has no successor column) and becomes
 *     obsolete (masterRecordService.setStatus). Never deleted.
 *   CHUNKS (user, 2026-11-06): with --apply each step commits on its own — the value rules, then the BOM lines 200 at a
 *     time with their rows, then the remaining rows 200 at a time, then the other references and the status. A lost
 *     connection loses one chunk; the next run picks up what is left (every step reads what still names `from`).
 *     cf_procurement_settings and cf_code_scheme_conditions are reported, never changed.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const COMPANY = Number(arg('company'));
const APPLY = process.argv.includes('--apply');
const ONLY = arg('only') ? new Set(arg('only').split(',').map(Number)) : null;
const CHUNK = 200;
if (!COMPANY || !arg('plan')) { console.error('Usage: --plan <def_merge_plan.json> --company <id> [--prod] [--apply] [--only <from ids>]'); process.exit(2); }
const PLAN = JSON.parse(fs.readFileSync(path.resolve(arg('plan')), 'utf8'));
if (PLAN.company && Number(PLAN.company) !== COMPANY) { console.error(`The plan is for company ${PLAN.company}, not ${COMPANY}.`); process.exit(2); }
if (process.argv.includes('--prod')) {
  const env = {}; fs.readFileSync(path.join(__dir, '..', '..', '..', '.env.tidb'), 'utf8').split('\n').forEach((l) => { l = l.trim(); if (!l || l.startsWith('#')) return; const [k, ...r] = l.split('='); env[k.trim()] = r.join('=').trim(); });
  Object.assign(process.env, { DB_HOST: env.DB_HOST, DB_PORT: env.DB_PORT ?? '4000', DB_USER: env.DB_USER, DB_PASSWORD: env.DB_PASSWORD, DB_NAME: env.DB_NAME, DB_SSL: 'true' });
}
const imp = (p) => import(pathToFileURL(path.join(__dir, '..', '..', p)).href);
const { pool } = await imp('db.js');
await imp('apps/cf_erp/services/codegenProvider.js');
const { setStatus, updateRecord } = await imp('apps/cf_erp/services/masterRecordService.js');
const { materialize } = await imp('apps/cf_erp/services/valueService.js');
const { createRule } = await imp('apps/cf_erp/services/assignmentService.js');
const { loadMasters, frozenBy } = await imp('apps/cf_erp/services/records.js');
const { findConditionsReferencing } = await imp('apps/cf_erp/modules/codegen/index.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (s = '') => console.log(s);
const db = await pool.getConnection();
if (process.argv.includes('--trace')) {
  // Every statement this connection sends, before it is sent (finds the one a lock wait stops on).
  const raw = db.query.bind(db);
  db.query = (sql, ...a) => { const t = typeof sql === 'string' ? sql : sql?.sql; console.log(`    [sql ${new Date().toISOString().slice(11, 19)}] ${String(t).replace(/\s+/g, ' ').slice(0, 110)}`); return raw(sql, ...a); };
  const rawPool = pool.query.bind(pool);
  pool.query = (sql, ...a) => { console.log(`    [POOL] ${String(typeof sql === 'string' ? sql : sql?.sql).replace(/\s+/g, ' ').slice(0, 110)}`); return rawPool(sql, ...a); };
}
const q =async (sql, p = []) => (await db.query(sql, p))[0];
let code = 0;

try {
  await q('SET SESSION innodb_lock_wait_timeout = 20').catch(() => {});
  const [admin] = await q("SELECT id FROM users WHERE company_id = ? AND email LIKE 'admin@%' ORDER BY id LIMIT 1", [COMPANY]);
  const [{ d: dbName }] = await q('SELECT DATABASE() AS d');
  // Which of the referencing columns this database has (older schemas lack some).
  const cols = new Set((await q('SELECT CONCAT(TABLE_NAME, \'.\', COLUMN_NAME) AS k FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()')).map((r) => r.k));
  const has = (t, c) => cols.has(`${t}.${c}`);
  /** Simple references: table, column, extra condition. Re-pointed with one UPDATE each. */
  const SIMPLE = [
    ['cf_step_wait_rules', 'target_definition_id', ''],
    ['cf_cut_allowances', 'definition_id', ''],
    ['cf_order_execution_plans', 'production_level_id', ''],
    ['cf_order_execution_plans', 'dispatch_level_id', ''],
    ['cf_production_orders', 'dispatch_level_id', ''],
    ['cf_standard_drawing_versions', 'design_id', ''],
  ].filter(([t, c]) => has(t, c) && has(t, 'company_id'));
  const live = (t) => (has(t, 'deleted_at') ? ' AND deleted_at IS NULL' : '');

  // Classification tree, once: a node's chain up to the root.
  const nodes = new Map((await q('SELECT id, parent_id FROM cf_classification_nodes WHERE company_id = ?', [COMPANY])).map((n) => [Number(n.id), n.parent_id == null ? null : Number(n.parent_id)]));
  const chain = (id) => { const out = []; let n = id == null ? null : Number(id); while (n != null && out.length < 20) { out.push(n); n = nodes.get(n) ?? null; } return out; };
  const classRules = new Map();   // node id -> Map(spec id -> is_applicable)
  for (const r of await q("SELECT subject_id, specification_id, is_applicable FROM cf_spec_assignments WHERE company_id = ? AND subject_type = 'classification' AND deleted_at IS NULL", [COMPANY])) {
    const k = Number(r.subject_id); if (!classRules.has(k)) classRules.set(k, new Map());
    const m = classRules.get(k); const s = Number(r.specification_id);
    // Several capture levels may exist for one spec: applicable when any is.
    m.set(s, (m.get(s) ?? false) || Number(r.is_applicable) === 1);
  }
  const masterRules = async (ids) => {
    const out = new Map(ids.map((i) => [Number(i), new Map()]));
    for (let i = 0; i < ids.length; i += 500) {
      const part = ids.slice(i, i + 500); if (!part.length) continue;
      for (const r of await q("SELECT subject_id, specification_id, is_applicable FROM cf_spec_assignments WHERE company_id = ? AND subject_type = 'master' AND subject_id IN (?) AND deleted_at IS NULL", [COMPANY, part])) {
        const m = out.get(Number(r.subject_id)); const s = Number(r.specification_id);
        m.set(s, (m.get(s) ?? false) || Number(r.is_applicable) === 1);
      }
    }
    return out;
  };
  /** Whether a spec applies: the nearest rule decides — the row, then the definition, then its classes leaf to root. */
  const applies = (spec, levels) => { for (const m of levels) if (m?.has(spec)) return m.get(spec); return false; };

  say(`${APPLY ? 'APPLY' : 'DRY RUN (each pair rolled back)'} — database ${dbName} at ${process.env.DB_HOST ?? 'local'}, company ${COMPANY}, ${PLAN.pairs.length} pairs in the plan`);
  const summary = [];

  for (const pair of PLAN.pairs) {
    const from = Number(pair.from); const to = Number(pair.to);
    if (ONLY && !ONLY.has(from)) continue;
    for (let attempt = 1; ; attempt++) {
      try {
        summary.push(await mergePair(pair, from, to));
        break;
      } catch (e) {
        try { await db.rollback(); } catch { /* none open */ }
        const lockWait = e.errno === 1205 || /lock wait|deadlock|write conflict/i.test(String(e.message));
        if (lockWait && attempt < 4) { say(`  lock wait on ${from} → ${to} (attempt ${attempt}: ${String(e.message).slice(0, 160)}); waiting 3 minutes …`); await sleep(180000); continue; }
        say(`  FAILED ${from} → ${to}: ${e.message}${e.extra ? ` ${JSON.stringify(e.extra)}` : ''}`);
        summary.push({ from, to, status: 'failed', note: e.message });
        code = 1;
        break;
      }
    }
  }

  say('\n=== Summary');
  for (const s of summary) say(`  ${String(s.from).padEnd(8)} → ${String(s.to).padEnd(8)} ${s.status.padEnd(9)} ${s.note ?? ''}`);
  for (const n of PLAN.notDone ?? []) say(`  not in this run: ${Array.isArray(n.id) ? n.id.join(', ') : n.id} ${n.name} — ${n.reason}`);
  if (!APPLY) say('\nNothing was written (every pair was rolled back). --apply commits.');

  // ---------------------------------------------------------------------------------------------------------------
  async function mergePair(pair, from, to) {
    const masters = await loadMasters(db, COMPANY, [from, to]);
    const F = masters.get(from); const T = masters.get(to);
    say(`\n--- ${from} "${F?.name ?? pair.fromName}" → ${to} "${T?.name ?? pair.toName}"  (${pair.order ?? ''})`);
    const refuse = (why) => { say(`  SKIPPED: ${why}`); return { from, to, status: 'skipped', note: why }; };
    if (!F || !T) return refuse(`${!F ? from : to} is not a live record.`);
    if (from === to) return refuse('from and to are the same record.');
    if (F.record_kind !== 'definition' || T.record_kind !== 'definition') return refuse('both must be definitions.');
    if (F.definition_type !== T.definition_type) return refuse(`types differ (${F.definition_type} vs ${T.definition_type}).`);
    if (T.status !== 'active') return refuse(`the target is ${T.status}.`);

    const use = await usage(from);
    const used = Object.values(use).reduce((a, b) => a + b, 0);
    if (F.status === 'obsolete' && used === 0) { say('  already done (obsolete, used by nothing).'); return { from, to, status: 'done', note: 'already merged' }; }
    say(`  uses: ${Object.entries(use).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}`);

    // Selection-only tables must be empty for a template pair.
    for (const [t, c] of [['cf_definition_allowed_items', 'definition_id'], ['cf_selection_criteria', 'definition_id'], ['cf_selection_scope', 'definition_id']]) {
      if (!has(t, c)) continue;
      const [{ n }] = await q(`SELECT COUNT(*) AS n FROM ${t} WHERE company_id = ? AND ${c} = ?${live(t)}`, [COMPANY, from]);
      if (Number(n)) return refuse(`${t} holds ${n} row(s) for it (a selection's list) — not handled here.`);
    }
    const rules = await findConditionsReferencing(db, COMPANY, 'definition', from);
    if (rules.length) return refuse(`coding rule(s) ${rules.map((r) => r.code).join(', ')} test it — a person changes those first.`);
    const [ownRules] = [await q("SELECT COUNT(*) AS n FROM cf_spec_assignments WHERE company_id = ? AND subject_type = 'master' AND subject_id = ? AND deleted_at IS NULL", [COMPANY, from])];
    const [ownVals] = [await q("SELECT COUNT(*) AS n FROM cf_spec_values WHERE company_id = ? AND subject_type = 'master' AND subject_id = ? AND deleted_at IS NULL", [COMPANY, from])];
    if (Number(ownRules[0].n) || Number(ownVals[0].n)) return refuse(`it has ${ownRules[0].n} rule(s) and ${ownVals[0].n} value(s) of its own — taking them onto ${T.name} would change its other rows; a person decides.`);

    // The rows: made from it, and the parents whose BOM names it.
    const itemIds = (await q('SELECT master_id FROM cf_item_details WHERE company_id = ? AND source_definition_id = ? AND deleted_at IS NULL', [COMPANY, from])).map((r) => Number(r.master_id));
    const lines = await q(
      `SELECT l.id, l.bom_id, l.child_id, l.design_id, l.position, b.parent_id FROM cf_bom_lines l JOIN cf_boms b ON b.id = l.bom_id
        WHERE l.company_id = ? AND l.deleted_at IS NULL AND (l.design_id = ? OR l.child_id = ?) ORDER BY l.id`, [COMPANY, from, from]);
    const parentIds = [...new Set(lines.map((l) => Number(l.parent_id)))];
    const touched = await loadMasters(db, COMPANY, [...itemIds, ...parentIds, ...lines.map((l) => Number(l.child_id))]);
    const frozen = [];
    for (const m of touched.values()) {
      const f = frozenBy(m);
      if (f || m.owner_order_status === 'confirmed') frozen.push(`${m.code ?? m.name} #${m.id} (${m.owner_order_code ?? '?'} line ${m.owner_line_no ?? '?'}: ${f?.reason ?? 'confirmed'})`);
    }
    if (frozen.length) return refuse(`${frozen.length} row(s) on a locked / released / confirmed / closed line: ${frozen.slice(0, 5).join('; ')}${frozen.length > 5 ? ' …' : ''}`);
    const owners = new Map();
    for (const id of itemIds) { const m = touched.get(id); const k = m?.owner_order_code ?? '(no order)'; owners.set(k, (owners.get(k) ?? 0) + 1); }
    say(`  rows made from it: ${itemIds.length} (${[...owners].map(([k, n]) => `${k} ${n}`).join(', ') || '—'}); with a code already: ${itemIds.filter((id) => touched.get(id)?.code).length}`);
    say(`  BOM lines naming it: ${lines.length} in ${new Set(lines.map((l) => l.bom_id)).size} BOM(s)`);

    // Values the rows hold that would stop applying under `to`.
    const entered = itemIds.length ? await q(
      `SELECT v.subject_id, v.specification_id, s.code FROM cf_spec_values v JOIN cf_specifications s ON s.id = v.specification_id
        WHERE v.company_id = ? AND v.subject_type = 'master' AND v.subject_id IN (?) AND v.source = 'entered' AND v.deleted_at IS NULL`, [COMPANY, itemIds]) : [];
    const mr = await masterRules([...itemIds, from, to]);
    const fromLevels = (item) => [mr.get(item), mr.get(from), ...chain(F.classification_id).map((n) => classRules.get(n))];
    const toLevels = (item) => [mr.get(item), mr.get(to), ...chain(T.classification_id).map((n) => classRules.get(n))];
    const needRule = new Map();   // spec id -> { code, rows }
    for (const v of entered) {
      const s = Number(v.specification_id); const it = Number(v.subject_id);
      if (applies(s, fromLevels(it)) && !applies(s, toLevels(it))) {
        if (!needRule.has(s)) needRule.set(s, { code: v.code, rows: 0 });
        needRule.get(s).rows++;
      }
    }
    say(`  entered values on the rows: ${entered.length}; specs that need a rule on ${T.name}: ${needRule.size ? [...needRule.values()].map((x) => `${x.code} (${x.rows} rows)`).join(', ') : 'none'}`);

    const c = { companyId: COMPANY, userId: admin?.id ?? null, deferRematerialize: true };
    const counts = { rules: 0, bomLines: 0, rows: 0, renamed: 0, materialized: 0, solLines: 0, links: 0, linksDropped: 0, other: {} };
    // Dry run: one transaction for the whole pair, rolled back. Apply: a transaction per chunk, committed.
    const chunk = async (fn) => { if (APPLY) { await db.beginTransaction(); try { await fn(); await db.commit(); } catch (e) { await db.rollback(); throw e; } } else await fn(); };
    if (!APPLY) await db.beginTransaction();
    try {
      // 1. Rules on `to` for values the rows hold.
      await chunk(async () => {
        for (const [specId, x] of needRule) {
          await createRule(db, c, { subjectType: 'master', subjectId: to, specificationId: specId, captureAt: 'item', valueRule: 'entered' });
          counts.rules++;
          say(`    + rule ${x.code} on ${T.name} (entered, item level)`);
        }
      });

      const moveRows = async (ids) => {
        if (!ids.length) return;
        const [r1] = await db.query(
          `UPDATE cf_master_records m JOIN cf_item_details i ON i.master_id = m.id
              SET m.name = ? WHERE m.company_id = ? AND m.id IN (?) AND i.source_definition_id = ? AND LOWER(m.name) = LOWER(?)`,
          [T.name, COMPANY, ids, from, F.name]);
        counts.renamed += r1.affectedRows;
        // A two-table UPDATE counts a row once per table it changes: count the rows themselves first.
        const [[{ n: moving }]] = await db.query('SELECT COUNT(*) AS n FROM cf_item_details WHERE company_id = ? AND master_id IN (?) AND source_definition_id = ?', [COMPANY, ids, from]);
        counts.rows += Number(moving);
        await db.query(
          `UPDATE cf_master_records m JOIN cf_item_details i ON i.master_id = m.id
              SET i.source_definition_id = ?, m.classification_id = ? WHERE m.company_id = ? AND m.id IN (?) AND i.source_definition_id = ?`,
          [to, T.classification_id, COMPANY, ids, from]);
        for (const id of ids) { await materialize(db, c, id); counts.materialized++; }
      };

      // 2. BOM lines, 200 at a time, each with the rows it holds.
      for (let i = 0; i < lines.length; i += CHUNK) {
        const part = lines.slice(i, i + CHUNK);
        await chunk(async () => {
          const boms = [...new Set(part.map((l) => Number(l.bom_id)))];
          const next = new Map((await q('SELECT bom_id, MAX(position) AS p FROM cf_bom_lines WHERE company_id = ? AND bom_id IN (?) AND design_id = ? GROUP BY bom_id', [COMPANY, boms, to])).map((r) => [Number(r.bom_id), Number(r.p)]));
          for (const l of part) {
            const sets = []; const vals = [];
            if (Number(l.design_id) === from) { const p = (next.get(Number(l.bom_id)) ?? 0) + 1; next.set(Number(l.bom_id), p); sets.push('design_id = ?', 'position = ?'); vals.push(to, p); }
            if (Number(l.child_id) === from) { sets.push('child_id = ?'); vals.push(to); }
            if (sets.length) { await db.query(`UPDATE cf_bom_lines SET ${sets.join(', ')} WHERE company_id = ? AND id = ?`, [...vals, COMPANY, l.id]); counts.bomLines++; }
          }
          const kids = part.map((l) => Number(l.child_id)).filter((id) => itemIds.includes(id));
          await moveRows(kids);
        });
      }
      // 3. Rows made from it that no line above reached (roots, loose rows), 200 at a time.
      const left = (await q('SELECT master_id FROM cf_item_details WHERE company_id = ? AND source_definition_id = ? AND deleted_at IS NULL', [COMPANY, from])).map((r) => Number(r.master_id));
      for (let i = 0; i < left.length; i += CHUNK) await chunk(() => moveRows(left.slice(i, i + CHUNK)));

      // 4. Everything else, the note and the status.
      await chunk(async () => {
        // Selection lines (none for templates — checked above, kept for completeness).
        await db.query('UPDATE cf_bom_lines SET selection_definition_id = ? WHERE company_id = ? AND selection_definition_id = ? AND deleted_at IS NULL', [to, COMPANY, from]);
        // Order lines sold as `from`: a new position per order.
        const sol = await q('SELECT id, order_id FROM cf_sales_order_lines WHERE company_id = ? AND design_id = ? AND deleted_at IS NULL', [COMPANY, from]);
        for (const l of sol) {
          const [{ p }] = await q('SELECT MAX(position) AS p FROM cf_sales_order_lines WHERE company_id = ? AND order_id = ? AND design_id = ?', [COMPANY, l.order_id, to]);
          await db.query('UPDATE cf_sales_order_lines SET design_id = ?, position = ? WHERE company_id = ? AND id = ?', [to, Number(p ?? 0) + 1, COMPANY, l.id]);
          counts.solLines++;
        }
        for (const [t, col, extra] of SIMPLE) {
          const [r] = await db.query(`UPDATE ${t} SET ${col} = ? WHERE company_id = ? AND ${col} = ?${extra}${live(t)}`, [to, COMPANY, from]);
          if (r.affectedRows) counts.other[`${t}.${col}`] = r.affectedRows;
        }
        if (has('cf_drawing_links', 'subject_id')) {
          const links = await q("SELECT id, drawing_id FROM cf_drawing_links WHERE company_id = ? AND subject_type = 'master_record' AND subject_id = ? AND deleted_at IS NULL", [COMPANY, from]);
          for (const k of links) {
            const [[clash]] = await db.query("SELECT id FROM cf_drawing_links WHERE company_id = ? AND subject_type = 'master_record' AND subject_id = ? AND drawing_id = ? AND deleted_at IS NULL", [COMPANY, to, k.drawing_id]);
            if (clash) { await db.query('UPDATE cf_drawing_links SET deleted_at = NOW() WHERE id = ?', [k.id]); counts.linksDropped++; }
            else { await db.query('UPDATE cf_drawing_links SET subject_id = ? WHERE id = ?', [to, k.id]); counts.links++; }
          }
        }
        const after = await usage(from);
        const still = Object.entries(after).filter(([, n]) => n);
        if (still.length) throw new Error(`still used after re-pointing: ${still.map(([k, n]) => `${k} ${n}`).join(', ')}`);
        const [ps] = has('cf_procurement_settings', 'master_id') ? await db.query('SELECT COUNT(*) AS n FROM cf_procurement_settings WHERE company_id = ? AND master_id = ?', [COMPANY, from]) : [[{ n: 0 }]];
        if (Number(ps[0].n)) say(`    note: it keeps ${ps[0].n} procurement setting(s) (left as they are)`);
        const note = `Merged into ${T.code ?? ''} ${T.name} (#${to}) on ${new Date().toISOString().slice(0, 10)} — ${pair.why ?? 'duplicate definition'} (drawing_bom/DEFINITION_AUDIT.md)`;
        await updateRecord(db, c, from, { description: [F.description, note].filter(Boolean).join('\n') });
        if (F.status !== 'obsolete') await setStatus(db, c, from, 'obsolete');
      });
      if (!APPLY) await db.rollback();
    } catch (e) {
      if (!APPLY) { try { await db.rollback(); } catch { /* */ } }
      throw e;
    }
    const other = Object.entries(counts.other).map(([k, n]) => `${k} ${n}`).join(', ');
    const line = `rules ${counts.rules}, BOM lines ${counts.bomLines}, rows ${counts.rows} (renamed ${counts.renamed}, values redone ${counts.materialized}), order lines ${counts.solLines}, drawing links ${counts.links}${counts.linksDropped ? ` (+${counts.linksDropped} dropped)` : ''}${other ? `, ${other}` : ''}; then obsolete`;
    say(`  ${APPLY ? 'DONE' : 'would do'}: ${line}`);
    return { from, to, status: APPLY ? 'merged' : 'ok (dry)', note: line };
  }

  /** What still names a definition — the references a merge moves. */
  async function usage(id) {
    const one = async (sql, p) => Number((await q(sql, p))[0].n);
    const out = {
      rows: await one('SELECT COUNT(*) AS n FROM cf_item_details WHERE company_id = ? AND source_definition_id = ? AND deleted_at IS NULL', [COMPANY, id]),
      bomDesign: await one('SELECT COUNT(*) AS n FROM cf_bom_lines WHERE company_id = ? AND design_id = ? AND deleted_at IS NULL', [COMPANY, id]),
      bomChild: await one('SELECT COUNT(*) AS n FROM cf_bom_lines WHERE company_id = ? AND child_id = ? AND deleted_at IS NULL', [COMPANY, id]),
      bomSelection: await one('SELECT COUNT(*) AS n FROM cf_bom_lines WHERE company_id = ? AND selection_definition_id = ? AND deleted_at IS NULL', [COMPANY, id]),
      orderLines: await one('SELECT COUNT(*) AS n FROM cf_sales_order_lines WHERE company_id = ? AND design_id = ? AND deleted_at IS NULL', [COMPANY, id]),
    };
    for (const [t, col] of SIMPLE) out[`${t}.${col}`] = await one(`SELECT COUNT(*) AS n FROM ${t} WHERE company_id = ? AND ${col} = ?${live(t)}`, [COMPANY, id]);
    return out;
  }
} catch (err) {
  code = 1;
  try { await db.rollback(); } catch { /* */ }
  console.error(`\nSTOPPED — ${err.message}`);
} finally {
  db.release();
  await pool.end();
}
process.exit(code);
