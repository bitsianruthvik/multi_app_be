import path from 'path'; import { pathToFileURL } from 'url';
const BE = process.cwd(); const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
const parties = await imp('apps/cf_erp/modules/parties/service.js');
const COMPANY = Number(process.env.CF_BRIDGE_COMPANY ?? 2);
const c = { companyId: COMPANY, userId: Number(process.env.CF_BRIDGE_USER ?? 22) };
const NAME = 'Kalpataru Enterprise Private Limited';
const NOTE = 'Name given by the user. The BOQ itself says only "KEPL" (drawing '
  + 'P103-VDB-WK-DD-MJB-200+003-401). A company-registry search on 2026-09-24 found no exact '
  + 'match: the nearest registrations are Kalpatru Enterprises Private Limited '
  + '(U45201MP2006PTC043404, Bhopal) and Kalpatharu Enterprises Private Limited '
  + '(U45201TN1981PTC008782, Chennai), both spelled differently. Confirm before invoicing.';
const conn = await pool.getConnection();
try {
  await conn.beginTransaction();
  const [[p]] = await conn.query("SELECT id, name FROM cf_parties WHERE company_id=? AND code='KEPL' AND deleted_at IS NULL", [COMPANY]);
  if (!p) { console.log(`no KEPL party in company ${COMPANY} — nothing to do`); }
  else if (p.name === NAME) { console.log('already set:', p.name); }
  else {
    await parties.updateParty(conn, c, p.id, { name: NAME, notes: NOTE });
    const [[now]] = await conn.query('SELECT name FROM cf_parties WHERE id=?', [p.id]);
    console.log(`${p.name}  ->  ${now.name}`);
  }
  await conn.commit();
} catch (e) { await conn.rollback(); console.error('FAILED:', e.code, e.message, e.problems ?? ''); process.exitCode = 1; }
finally { conn.release(); await pool.end(); }
