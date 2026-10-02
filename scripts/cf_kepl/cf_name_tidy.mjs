/**
 * cf_name_tidy.mjs — one-off name clean-up (user 2026-10-02).
 *
 *   CF_COMPANY=30005 node scripts/cf_kepl/cf_name_tidy.mjs            # dry run: lists every change, writes nothing
 *   CF_COMPANY=30005 node scripts/cf_kepl/cf_name_tidy.mjs --commit   # applies them in one transaction
 *
 * 1. BOM line roles that only number or restate their child ("Segment 1" under Girder segment,
 *    "Girder" under Girder line, a role equal to the child's name) are cleared, on templates and
 *    order lines alike. System roles ('Raw plate', 'Cut from') are never touched, and when the same
 *    child repeats under one parent with a real label ("Top flange outer" / "Top flange inner")
 *    every role in that repeat is kept — the roles are what tell the uses apart.
 * 2. A trailing " (copy)" (left by the old row copy) is stripped from roles.
 * 3. Part function (spec PART_FUNCTION) stops being required: is_required = 0 on its assignments.
 *    Values stay; nothing is deleted. Hiding it in the order grids is a screen rule.
 * Order lines that are RELEASED, or on a closed / lost / cancelled / revised order, are skipped
 * and listed. Idempotent: a second run finds nothing to do.
 */
import { pool } from '../../db.js';

const COMPANY = Number(process.env.CF_COMPANY ?? 2);
const COMMIT = process.argv.includes('--commit');
const SYSTEM_ROLES = new Set(['raw plate', 'cut from']);
const FROZEN_ORDER = new Set(['closed', 'lost', 'cancelled', 'revised']);

const norm = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
export const stripCopy = (s) => String(s ?? '').replace(/(\s*\(copy\))+\s*$/i, '').trim();
const words = (s) => norm(s).split(/[^a-z0-9]+/).filter(Boolean);

/** True when a role only numbers or restates its child, so the child's own name says it all. */
export function restates(role, name, shortName) {
  const r = norm(stripCopy(role));
  if (!r) return true;
  const n = norm(name);
  if (r === n) return true;
  const nameWords = new Set(words(name));
  const short = norm(shortName);
  const numbered = r.match(/^(.+?)\s*#?\d+$/);            // "Segment 1", "Girder 2", "GS1"
  if (numbered) {
    const base = numbered[1].trim();
    if (base === n || base === short || words(base).every((w) => nameWords.has(w))) return true;
  }
  const rw = words(r);
  return rw.length > 0 && rw.every((w) => nameWords.has(w));   // "Girder" under "Girder line"
}

/** Works out every change; reads only. */
export async function planNameTidy(db, companyId) {
  const [lines] = await db.query(
    `SELECT l.id, l.bom_id, l.child_id, l.role, m.name AS child_name, m.short_name AS child_short,
            pd.item_type AS parent_type, pd.owner_order_line_id AS order_line_id
       FROM cf_bom_lines l
       JOIN cf_boms b ON b.id = l.bom_id AND b.deleted_at IS NULL
       JOIN cf_master_records m ON m.id = l.child_id
       LEFT JOIN cf_item_details pd ON pd.master_id = b.parent_id
      WHERE l.company_id = ? AND l.deleted_at IS NULL AND l.role IS NOT NULL AND l.role <> ''`,
    [companyId],
  );
  const orderLineIds = [...new Set(lines.map((l) => l.order_line_id).filter(Boolean))];
  const blocked = new Map();   // order line id -> reason
  if (orderLineIds.length) {
    const [rel] = await db.query(
      `SELECT order_line_id FROM cf_production_releases WHERE company_id = ? AND deleted_at IS NULL AND order_line_id IN (?)`,
      [companyId, orderLineIds],
    );
    for (const r of rel) blocked.set(r.order_line_id, 'released');
    const [ord] = await db.query(
      `SELECT sl.id, o.status, o.code FROM cf_sales_order_lines sl JOIN cf_sales_orders o ON o.id = sl.order_id
        WHERE sl.company_id = ? AND sl.id IN (?)`,
      [companyId, orderLineIds],
    );
    for (const r of ord) if (!blocked.has(r.id) && FROZEN_ORDER.has(r.status)) blocked.set(r.id, `order ${r.code} is ${r.status}`);
  }
  // Repeats: the same child more than once under one parent. Keep their roles if any is a real label.
  const groups = new Map();
  for (const l of lines) {
    const k = `${l.bom_id}:${l.child_id}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(l);
  }
  const keepGroup = new Set();
  for (const [k, g] of groups) {
    if (g.length > 1 && g.some((l) => !SYSTEM_ROLES.has(norm(l.role)) && !restates(l.role, l.child_name, l.child_short))) keepGroup.add(k);
  }
  const clear = [], strip = [], skipped = [];
  for (const l of lines) {
    if (SYSTEM_ROLES.has(norm(l.role))) continue;
    if (l.order_line_id && blocked.has(l.order_line_id)) {
      if (restates(l.role, l.child_name, l.child_short) || stripCopy(l.role) !== l.role) skipped.push({ ...l, why: blocked.get(l.order_line_id) });
      continue;
    }
    const keep = keepGroup.has(`${l.bom_id}:${l.child_id}`);
    if (!keep && restates(l.role, l.child_name, l.child_short)) clear.push(l);
    else if (stripCopy(l.role) !== l.role) strip.push({ ...l, to: stripCopy(l.role) });
  }
  const [req] = await db.query(
    `SELECT a.id, a.subject_type, a.subject_id FROM cf_spec_assignments a
       JOIN cf_specifications s ON s.id = a.specification_id AND s.company_id = a.company_id
      WHERE a.company_id = ? AND a.deleted_at IS NULL AND a.is_required = 1 AND s.code = 'PART_FUNCTION'`,
    [companyId],
  );
  return { clear, strip, skipped, partFunction: req };
}

/** Applies a plan with set-based writes. */
export async function applyNameTidy(db, companyId, plan) {
  if (plan.clear.length) {
    await db.query('UPDATE cf_bom_lines SET role = NULL WHERE company_id = ? AND id IN (?)', [companyId, plan.clear.map((l) => l.id)]);
  }
  if (plan.strip.length) {
    const cases = plan.strip.map(() => 'WHEN ? THEN ?').join(' ');
    await db.query(
      `UPDATE cf_bom_lines SET role = CASE id ${cases} END WHERE company_id = ? AND id IN (?)`,
      [...plan.strip.flatMap((l) => [l.id, l.to]), companyId, plan.strip.map((l) => l.id)],
    );
  }
  if (plan.partFunction.length) {
    await db.query('UPDATE cf_spec_assignments SET is_required = 0 WHERE company_id = ? AND id IN (?)', [companyId, plan.partFunction.map((a) => a.id)]);
  }
}

async function main() {
  const where = /^(localhost|127\.0\.0\.1|::1)$/.test(process.env.DB_HOST ?? 'localhost') ? 'local' : 'PRODUCTION';
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const plan = await planNameTidy(conn, COMPANY);
    const show = (l) => `  line ${l.id} · ${l.child_name} · "${l.role}"${l.to !== undefined ? ` → "${l.to}"` : ''}${l.why ? ` (skipped: ${l.why})` : ''}`;
    console.log(`${where}, company ${COMPANY} — ${COMMIT ? 'COMMIT' : 'dry run (writes nothing)'}`);
    console.log(`\nRoles cleared (they only number or restate the part): ${plan.clear.length}`);
    for (const l of plan.clear.slice(0, 60)) console.log(show(l));
    if (plan.clear.length > 60) console.log(`  … and ${plan.clear.length - 60} more`);
    console.log(`\n" (copy)" stripped: ${plan.strip.length}`);
    for (const l of plan.strip) console.log(show(l));
    console.log(`\nSkipped (released or frozen order): ${plan.skipped.length}`);
    for (const l of plan.skipped.slice(0, 30)) console.log(show(l));
    console.log(`\nPart function made optional: ${plan.partFunction.length} assignment(s)`);
    if (COMMIT) {
      await applyNameTidy(conn, COMPANY, plan);
      await conn.commit();
      console.log('\nCommitted.');
    } else {
      await conn.rollback();
      console.log('\nDry run — nothing written. Add --commit to apply.');
    }
  } catch (e) {
    await conn.rollback();
    console.error('Rolled back:', e.message);
    process.exitCode = 1;
  } finally {
    conn.release();
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) await main();
