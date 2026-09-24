/**
 * Picks the raw plate each derived blank is cut from, so the chain reaches
 * steel you can actually buy.
 *
 * The rule, deliberately simple and overridable: same THICKNESS, same GRADE,
 * the blank must fit inside the sheet (either way round), and of those, the
 * SMALLEST sheet wins. Grade is not a preference — E250 is a weaker steel and
 * substituting it for E350 would be wrong, not just wasteful.
 *
 * This is a placeholder for nesting, not nesting. It chooses one sheet per
 * blank size and cannot pack several blanks onto one sheet, so the quantity it
 * leaves behind (the area fraction) is optimistic about layout and says
 * nothing about offcuts. Real nesting will ask for MORE steel, not less.
 */
import path from 'path';
import { pathToFileURL } from 'url';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
await imp('apps/cf_erp/services/codegenProvider.js');
const bom = await imp('apps/cf_erp/services/bomService.js');
const { attachNodeCache, detachNodeCache } = await imp('apps/cf_erp/lib/db.js');

const COMPANY = Number(process.env.CF_BRIDGE_COMPANY ?? 2);
const c = { companyId: COMPANY, userId: Number(process.env.CF_BRIDGE_USER ?? 22) };
const num = (alias, code) => `(SELECT v.value_number FROM cf_spec_values v JOIN cf_specifications s ON s.id=v.specification_id
   WHERE v.company_id=${alias}.company_id AND v.subject_id=${alias}.id AND v.subject_type='master' AND s.code='${code}' AND v.deleted_at IS NULL)`;
const opt = (alias, code) => `(SELECT o.value FROM cf_spec_values v JOIN cf_specifications s ON s.id=v.specification_id
   JOIN cf_spec_options o ON o.id=v.option_id
   WHERE v.company_id=${alias}.company_id AND v.subject_id=${alias}.id AND v.subject_type='master' AND s.code='${code}' AND v.deleted_at IS NULL)`;

const conn = await pool.getConnection();
try {
  await conn.beginTransaction();
  attachNodeCache(conn);

  const [plates] = await conn.query(
    `SELECT m.id, m.code, ${num('m','THICKNESS')} thk, ${num('m','LENGTH')} len, ${num('m','WIDTH')} wid, ${opt('m','GRADE')} grade
       FROM cf_master_records m JOIN cf_classification_nodes n ON n.id=m.classification_id AND n.code='PLATE'
      WHERE m.company_id=? AND m.deleted_at IS NULL AND m.status='active'`, [COMPANY]);

  // every unresolved plate line that hangs under a cut plate
  const [lines] = await conn.query(
    `SELECT l.id AS line_id, m.id AS blank_id, m.code AS blank_code,
            ${num('m','THICKNESS')} thk, ${num('m','LENGTH')} len, ${num('m','WIDTH')} wid, ${opt('m','GRADE')} grade
       FROM cf_bom_lines l
       JOIN cf_boms b ON b.id = l.bom_id AND b.deleted_at IS NULL
       JOIN cf_master_records m ON m.id = b.parent_id
       JOIN cf_classification_nodes n ON n.id = m.classification_id AND n.code = 'CUT_PLATE'
      WHERE l.company_id = ? AND l.deleted_at IS NULL AND l.selection_definition_id IS NOT NULL
      ORDER BY thk, len DESC`, [COMPANY]);

  console.log(`${lines.length} blank(s) to point at a plate, from ${plates.length} in the catalog\n`);
  let done = 0; const stuck = [];
  for (const b of lines) {
    const fits = plates.filter((p) => Number(p.thk) === Number(b.thk)
      && String(p.grade) === String(b.grade)
      && ((Number(p.len) >= Number(b.len) && Number(p.wid) >= Number(b.wid))
       || (Number(p.len) >= Number(b.wid) && Number(p.wid) >= Number(b.len))));
    if (!fits.length) { stuck.push(`${b.thk}x${b.len}x${b.wid} ${b.grade}`); continue; }
    const best = fits.sort((x, y) => (Number(x.len) * Number(x.wid)) - (Number(y.len) * Number(y.wid)))[0];
    await bom.resolveLine(conn, c, b.line_id, { itemId: best.id });
    const use = (Number(b.len) * Number(b.wid)) / (Number(best.len) * Number(best.wid));
    console.log(`  ${String(`${b.thk}x${b.len}x${b.wid}`).padEnd(22)} -> ${best.code.padEnd(24)} ${(use * 100).toFixed(0)}% of the sheet`);
    done += 1;
  }
  if (stuck.length) { console.log('\n  NO PLATE OF THE RIGHT GRADE AND THICKNESS FITS:'); for (const s of stuck) console.log(`    ${s}`); }
  detachNodeCache(conn);
  await conn.commit();
  console.log(`\nresolved ${done}, stuck ${stuck.length}.`);
} catch (e) { await conn.rollback(); console.error('FAILED:', e.code ?? '', e.message, (e.problems ?? []).slice(0, 6)); process.exitCode = 1; }
finally { detachNodeCache(conn); conn.release(); await pool.end(); }
