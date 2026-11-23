/**
 * Lists a company's ERP agents, or approves / revokes one. An agent is ignored until it is approved.
 *
 *   node apps/sumangal_dashboard/scripts/v15/approve-agent.mjs [--company=sumangal] [--target=prod]              list
 *   node apps/sumangal_dashboard/scripts/v15/approve-agent.mjs --id=<id> [--revoke] [--apply] [--target=prod]  approve (or revoke)
 */
import mysql from 'mysql2/promise';
import { resolveTarget, announce } from '../../../cf_hrms/scripts/dbTarget.mjs';
const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || `--${k}=${d ?? ''}`).split('=')[1];
const SLUG = arg('company', 'sumangal'); const ID = +arg('id', 0) || null; const REVOKE = process.argv.includes('--revoke'); const APPLY = process.argv.includes('--apply');
const target = resolveTarget(); announce(target);
const conn = await mysql.createConnection(target.cfg);
const [[company]] = await conn.query('SELECT id FROM companies WHERE slug = ? AND deleted_at IS NULL', [SLUG]);
if (!company) { console.error(`No company "${SLUG}".`); process.exit(1); }
const [rows] = await conn.query('SELECT id, machine, win_user, status, created_at, approved_at, last_seen_at, last_run_at, last_ok, last_message FROM sd_agents WHERE company_id = ? ORDER BY id', [company.id]);
for (const r of rows) console.log(`  #${r.id} ${r.status.padEnd(8)} ${r.machine} (${r.win_user}) registered ${r.created_at?.toISOString?.() ?? r.created_at}; last run ${r.last_run_at ? `${r.last_run_at.toISOString?.() ?? r.last_run_at} ${r.last_ok ? 'ok' : 'FAILED'} ${r.last_message || ''}` : 'never'}`);
if (!rows.length) console.log('  no agents registered yet');
if (ID) {
  const a = rows.find((r) => r.id === ID); if (!a) { console.error(`No agent #${ID} for ${SLUG}.`); process.exit(1); }
  const to = REVOKE ? 'revoked' : 'approved';
  console.log(`\n#${ID}: ${a.status} -> ${to}${APPLY ? '' : '   (dry run: add --apply)'}`);
  if (APPLY) { await conn.query(`UPDATE sd_agents SET status = ?, approved_at = ${REVOKE ? 'approved_at' : 'UTC_TIMESTAMP()'} WHERE id = ? AND company_id = ?`, [to, ID, company.id]); console.log('done'); }
}
await conn.end();
