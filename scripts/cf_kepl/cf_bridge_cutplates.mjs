/** Derives the cut plates for the order on this tenant. Safe to re-run: the
 *  service reconciles rather than duplicating, and re-running AFTER the plates
 *  are resolved is what turns the placeholder quantity into the area fraction. */
import path from 'path'; import { pathToFileURL } from 'url';
const BE = process.cwd(); const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
await imp('apps/cf_erp/services/codegenProvider.js');
const cut = await imp('apps/cf_erp/services/cutPlateService.js');
const { attachNodeCache, detachNodeCache } = await imp('apps/cf_erp/lib/db.js');
const COMPANY = Number(process.env.CF_BRIDGE_COMPANY ?? 2);
const c = { companyId: COMPANY, userId: 22 };
const conn = await pool.getConnection();
try {
  await conn.beginTransaction(); attachNodeCache(conn);
  const [[line]] = await conn.query(
    `SELECT l.id, o.code FROM cf_sales_order_lines l JOIN cf_sales_orders o ON o.id = l.order_id
      WHERE l.company_id = ? AND l.deleted_at IS NULL LIMIT 1`, [COMPANY]);
  console.log(`order ${line.code}, line ${line.id}\n`);
  const fn = cut.deriveCutPlates ?? cut.default?.deriveCutPlates ?? Object.values(cut).find((f) => typeof f === 'function' && /derive/i.test(f.name));
  console.log('calling:', fn?.name ?? '(not found)', '\n');
  const out = await fn(conn, c, line.id, {});
  console.log(`created ${out.created ?? 0} · updated ${out.updated ?? 0} · removed ${(out.removed ?? []).length} · unchanged ${out.unchanged ?? 0}`);
  console.log(`basis: ${out.basis}`);
  const cps = out.cutPlates ?? [];
  console.log(`\ncut plates: ${cps.length}`);
  for (const p of cps.slice(0, 8)) {
    const s = p.size ?? {};
    console.log(`  ${String(p.code ?? p.name).padEnd(26)} ${s.thickness}x${s.length}x${s.width} ${s.grade}  from ${p.partCount} part(s)`
      + `  plate=${p.plate?.code ?? '(unresolved)'} qty=${p.plateQuantity} [${p.plateQuantityBasis}]`);
  }
  if (cps.length > 8) console.log(`  … and ${cps.length - 8} more`);
  detachNodeCache(conn); await conn.commit(); console.log('\ncommitted.');
} catch (e) { await conn.rollback(); console.error('FAILED:', e.code ?? '', e.message, (e.problems ?? []).slice(0, 8)); process.exitCode = 1; }
finally { detachNodeCache(conn); conn.release(); await pool.end(); }
