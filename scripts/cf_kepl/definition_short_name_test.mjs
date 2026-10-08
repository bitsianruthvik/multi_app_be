/**
 * definition_short_name_test.mjs — a definition is known by its short name (user, 2026-10-08:
 * "use short name everywhere for definitions; hide the codes"). A new definition activates with no
 * code typed (it is given one quietly), search finds it by its short name, and the BOM shapes carry
 * short names. Local only, one rolled-back transaction, every cf_ table re-counted.
 *
 *   cd multi_app_be && node scripts/cf_kepl/definition_short_name_test.mjs
 */
import { pool } from '../../db.js';
import '../../apps/cf_erp/services/codegenProvider.js';
import { createDefinition, setStatus, listRecords } from '../../apps/cf_erp/services/masterRecordService.js';
import { addLine, explode, getBom } from '../../apps/cf_erp/services/bomService.js';

if (!/^(localhost|127\.0\.0\.1|::1)$/.test(process.env.DB_HOST ?? 'localhost')) throw new Error('Local only.');
const COMPANY = 2;
let passed = 0, failed = 0;
const ok = (label, cond, detail = '') => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && detail ? ` — ${detail}` : ''}`); cond ? passed++ : failed++; };
const [tables] = await pool.query("SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME LIKE 'cf\\_%' ORDER BY TABLE_NAME");
const counts = async () => (await pool.query(tables.map((t) => `SELECT '${t.name}' AS name,COUNT(*) AS n FROM \`${t.name}\``).join(' UNION ALL ')))[0];
const before = await counts();
const db = await pool.getConnection();
try {
  await db.beginTransaction();
  const c = { companyId: COMPANY, userId: null };
  const [[leaf]] = await db.query(
    `SELECT n.id FROM cf_classification_nodes n WHERE n.company_id = ? AND n.deleted_at IS NULL AND n.scope <> 'machine'
        AND NOT EXISTS (SELECT 1 FROM cf_classification_nodes k WHERE k.parent_id = n.id AND k.deleted_at IS NULL)
      ORDER BY n.id LIMIT 1`, [COMPANY]);
  const T = `ZQ${Date.now() % 100000}`;
  const a = await createDefinition(db, c, { classificationId: leaf.id, name: 'Short name test A', shortName: T });
  ok('a definition is created with no code typed (a coding rule may still give it one)', !!a.id, JSON.stringify(a.code));
  const actA = await setStatus(db, c, a.id, 'active').catch((e) => e);
  ok('…and activates: given a code quietly (its short name, or a rule\'s)', actA?.status === 'active' && !!actA.code, JSON.stringify(actA?.code ?? actA?.message));
  const b = await createDefinition(db, c, { classificationId: leaf.id, name: 'Short name test B', shortName: T });
  const actB = await setStatus(db, c, b.id, 'active').catch((e) => e);
  ok('a second one with the same short name activates too, its code made unique', actB?.status === 'active' && actB.code && actB.code !== actA.code, `${actA?.code} / ${actB?.code ?? actB?.message}`);

  // With no coding rule for definitions: the short name becomes the hidden code, or short name + id when taken.
  await db.query("UPDATE cf_code_schemes SET deleted_at = NOW() WHERE company_id = ? AND entity_type = 'definition' AND deleted_at IS NULL", [COMPANY]);
  const T2 = `${T}X`;
  const d1 = await createDefinition(db, c, { classificationId: leaf.id, name: 'Short name test C', shortName: T2 });
  const a1 = await setStatus(db, c, d1.id, 'active').catch((e) => e);
  ok('no coding rule: the short name is its code', a1?.status === 'active' && a1.code === T2, JSON.stringify(a1?.code ?? a1?.message));
  const d2 = await createDefinition(db, c, { classificationId: leaf.id, name: 'Short name test D', shortName: T2 });
  const a2 = await setStatus(db, c, d2.id, 'active').catch((e) => e);
  ok('…and the same short name again: short name + its id', a2?.code === `${T2}-${d2.id}`, JSON.stringify(a2?.code ?? a2?.message));

  const found = await listRecords(db, COMPANY, { search: T, kind: 'template' });
  const rows = Array.isArray(found) ? found : found.rows ?? found.items ?? [];
  ok('search finds definitions by their short name', rows.filter((r) => r.id === a.id || r.id === b.id).length === 2, JSON.stringify(rows.map((r) => r.id)).slice(0, 200));

  await addLine(db, c, a.id, { childId: b.id, quantity: 2 });
  const t = await explode(db, COMPANY, a.id, {});
  ok('the BOM tree carries short names (top and row)', t.root.shortName === T && t.root.children[0]?.shortName === T, JSON.stringify([t.root.shortName, t.root.children[0]?.shortName]));
  const bom = await getBom(db, COMPANY, a.id);
  const line = (bom.lines ?? [])[0];
  ok('the BOM lines carry them too (parent, child, design)', bom.parent?.shortName === T && line?.child?.shortName === T && line?.design?.shortName === T, JSON.stringify([bom.parent?.shortName, line?.child?.shortName, line?.design?.shortName]));
} catch (e) {
  failed++;
  console.error('  ERROR', e.message, e.problems ? JSON.stringify(e.problems) : '', e.stack?.split('\n').slice(1, 3).join(' '));
} finally {
  await db.rollback();
  db.release();
  const after = await counts();
  const changed = after.filter((x) => before.find((y) => y.name === x.name)?.n !== x.n);
  ok('every cf_ table count is back', changed.length === 0, changed.map((x) => x.name).join(', '));
  await pool.end();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
}
