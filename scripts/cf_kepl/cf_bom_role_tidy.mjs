/**
 * cf_bom_role_tidy.mjs — clears the "name in this parent" (cf_bom_lines.role)
 * where it only repeats the child's own name (user, 2026-10-01: one name per BOM
 * line). The screens already hide such a role, so this is tidiness, not a fix.
 *
 * Leaves alone: the system roles ('Raw plate', 'Cut from'), any role that says
 * something other than the child's name, and a role on a child that appears more
 * than once in the same BOM (the roles are what tell those uses apart).
 *
 *   cd multi_app_be && node scripts/cf_kepl/cf_bom_role_tidy.mjs                    # dry run, lists what it would clear
 *   cd multi_app_be && node scripts/cf_kepl/cf_bom_role_tidy.mjs --commit           # writes
 *   CF_COMPANY=30005 ...                                                            # one company (default: all)
 * Target database = whatever DB_HOST/DB_* the environment names (local by default).
 */
import path from 'path';
import { pathToFileURL } from 'url';

const BE = process.cwd();
const { pool } = await import(pathToFileURL(path.join(BE, 'db.js')).href);
const COMMIT = process.argv.includes('--commit');
const COMPANY = process.env.CF_COMPANY ? Number(process.env.CF_COMPANY) : null;
const where = /^(localhost|127\.0\.0\.1|::1)?$/i.test(process.env.DB_HOST ?? '') ? 'local' : 'PRODUCTION';
const norm = (t) => String(t ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

console.log(`${where}${COMPANY ? `, company ${COMPANY}` : ', every company'} — ${COMMIT ? 'WRITING' : 'dry run'}`);
const [rows] = await pool.query(
  `SELECT l.id, l.company_id, l.bom_id, l.child_id, l.design_id, l.role, ch.name AS child_name
     FROM cf_bom_lines l JOIN cf_master_records ch ON ch.id = l.child_id
    WHERE l.deleted_at IS NULL AND l.role IS NOT NULL ${COMPANY ? 'AND l.company_id = ?' : ''}`,
  COMPANY ? [COMPANY] : [],
);
const uses = new Map();
for (const r of rows) { const k = `${r.bom_id}:${r.design_id}`; uses.set(k, (uses.get(k) ?? 0) + 1); }
const SYSTEM = new Set(['raw plate', 'cut from']);
const clear = rows.filter((r) => !SYSTEM.has(norm(r.role)) && norm(r.role) === norm(r.child_name) && uses.get(`${r.bom_id}:${r.design_id}`) === 1);
// Repeats among ALL live lines (a repeat whose other use has no role is also a repeat).
if (clear.length) {
  const [all] = await pool.query(
    `SELECT bom_id, design_id, COUNT(*) AS n FROM cf_bom_lines WHERE deleted_at IS NULL AND bom_id IN (?) GROUP BY bom_id, design_id HAVING n > 1`,
    [[...new Set(clear.map((r) => r.bom_id))]],
  );
  const rep = new Set(all.map((a) => `${a.bom_id}:${a.design_id}`));
  for (let i = clear.length - 1; i >= 0; i -= 1) if (rep.has(`${clear[i].bom_id}:${clear[i].design_id}`)) clear.splice(i, 1);
}
console.log(`${rows.length} lines have a role; ${clear.length} only repeat the child's name.`);
for (const r of clear.slice(0, 40)) console.log(`  line ${r.id} (company ${r.company_id}): "${r.role}"`);
if (clear.length > 40) console.log(`  … and ${clear.length - 40} more`);
if (COMMIT && clear.length) {
  const [res] = await pool.query('UPDATE cf_bom_lines SET role = NULL WHERE id IN (?)', [clear.map((r) => r.id)]);
  console.log(`cleared ${res.affectedRows} roles.`);
} else if (!COMMIT) console.log('Nothing written (dry run). Add --commit to clear them.');
await pool.end();
