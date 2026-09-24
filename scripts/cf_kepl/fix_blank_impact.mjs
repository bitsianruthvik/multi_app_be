/** A blank inherits its steel from the part it serves, and that includes
 *  IMPACT_CLASS — without it the plate coding rule cannot render and the blank
 *  can never be activated. The derivation copies THICKNESS/LENGTH/WIDTH/GRADE;
 *  this fills the fifth. Worth folding into cutPlateService.               */
import path from 'path'; import { pathToFileURL } from 'url';
const BE = process.cwd(); const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
await imp('apps/cf_erp/services/codegenProvider.js');
const values = await imp('apps/cf_erp/services/valueService.js');
const { attachNodeCache, detachNodeCache } = await imp('apps/cf_erp/lib/db.js');
const COMPANY = Number(process.env.CF_BRIDGE_COMPANY ?? 2); const c = { companyId: COMPANY, userId: 22 };
const conn = await pool.getConnection();
try {
  await conn.beginTransaction(); attachNodeCache(conn);
  const [blanks] = await conn.query(
    `SELECT m.id, m.name FROM cf_master_records m
       JOIN cf_classification_nodes n ON n.id=m.classification_id AND n.code='CUT_PLATE'
      WHERE m.company_id=? AND m.deleted_at IS NULL`, [COMPANY]);
  let set = 0;
  for (const b of blanks) {
    const [[have]] = await conn.query(
      `SELECT v.id FROM cf_spec_values v JOIN cf_specifications s ON s.id=v.specification_id
        WHERE v.company_id=? AND v.subject_id=? AND v.subject_type='master' AND s.code='IMPACT_CLASS' AND v.deleted_at IS NULL`,
      [COMPANY, b.id]);
    if (have) continue;
    await values.setValues(conn, c, 'master', b.id, [{ specCode: 'IMPACT_CLASS', value: 'BO' }]);
    set += 1;
  }
  detachNodeCache(conn); await conn.commit();
  console.log(`set IMPACT_CLASS on ${set} of ${blanks.length} blanks`);
} catch (e) { await conn.rollback(); console.error('FAILED:', e.code ?? '', e.message, (e.problems ?? []).slice(0, 4)); process.exitCode = 1; }
finally { detachNodeCache(conn); conn.release(); await pool.end(); }
