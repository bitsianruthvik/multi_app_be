/**
 * cf_add_execution_plan_stage.mjs — puts the EXECUTION PLAN stage into every sales-order process of a company
 * that has a Structure or Freeze design stage (user, 2026-10-18; init.sql §72 — TM/s72.sql does the same for
 * company 30005 in SQL). Its place is the stage catalogue's (after Structure & values, before Freeze design); it
 * is required — "check the plan, then freeze".
 *
 * It goes through processService.replaceStages, the one way a process's stages change, handing every other stage
 * back exactly as it was. A process that already has the stage is left alone, so running it twice changes nothing.
 * Line items is retired in code (merged into Structure & values): it is not handed back, and its stored row is
 * kept, hidden.
 *
 *   cd multi_app_be
 *   node scripts/cf_kepl/cf_add_execution_plan_stage.mjs             # company 2 (local)
 *   CF_BRIDGE_COMPANY=30005 node scripts/cf_kepl/cf_add_execution_plan_stage.mjs
 *   node scripts/cf_kepl/cf_add_execution_plan_stage.mjs --dry-run   # says what it would do, writes nothing
 */
import path from 'path';
import { pathToFileURL } from 'url';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
await imp('apps/cf_erp/services/codegenProvider.js');
const proc = await imp('apps/cf_erp/services/processService.js');

const COMPANY = Number(process.env.CF_BRIDGE_COMPANY ?? 2);
const USER = process.env.CF_SEED_USER ? Number(process.env.CF_SEED_USER) : null;
const DRY = process.argv.includes('--dry-run');
const c = { companyId: COMPANY, userId: USER };

/** A stage handed back as it came — what the Processes screen sends (lib/process.ts toStageInput). */
const asInput = (s) => ({
  stageKey: s.stageKey,
  label: s.label ?? null,
  requirement: s.requirement,
  overrideSpecId: s.overrideSpec?.id ?? null,
  settings: s.settings ?? null,
});

const conn = await pool.getConnection();
const done = { added: [], already: [], skipped: [] };
try {
  await conn.beginTransaction();
  const [rows] = await conn.query('SELECT id, code FROM cf_processes WHERE company_id = ? AND deleted_at IS NULL ORDER BY id', [COMPANY]);
  console.log(`company ${COMPANY}: ${rows.length} process${rows.length === 1 ? '' : 'es'}${DRY ? ' (dry run — nothing is written)' : ''}`);
  for (const { id, code } of rows) {
    const p = await proc.getProcess(conn, COMPANY, id);
    const stages = [...p.stages].sort((a, b) => a.sequence - b.sequence);
    const keys = stages.map((s) => s.stageKey);
    if (keys.includes('execution_plan')) { done.already.push(code); console.log(`  ${code}: already has Execution plan — ${keys.join(' → ')}`); continue; }
    if (!keys.includes('structure') && !keys.includes('lock')) { done.skipped.push(code); console.log(`  ${code}: has neither Structure nor Freeze design — left alone (${keys.join(' → ')})`); continue; }
    const at = keys.includes('lock') ? keys.indexOf('lock') : keys.length;
    const next = [...stages.slice(0, at).map(asInput), { stageKey: 'execution_plan', requirement: 'required' }, ...stages.slice(at).map(asInput)];
    console.log(`  ${code}: ${keys.join(' → ')}\n      -> ${next.map((s) => s.stageKey).join(' → ')}`);
    if (!DRY) {
      const saved = await proc.replaceStages(conn, c, id, { stages: next });
      const got = saved.stages;
      // Everything else handed back unchanged — checked, not assumed.
      for (const s of stages) {
        const g = got.find((x) => x.stageKey === s.stageKey);
        const same = g && g.label === s.label && g.requirement === s.requirement
          && (g.overrideSpec?.id ?? null) === (s.overrideSpec?.id ?? null)
          && JSON.stringify(g.settings ?? null) === JSON.stringify(s.settings ?? null);
        if (!same) throw new Error(`${code}: stage ${s.stageKey} did not come back as it was.`);
      }
    }
    done.added.push(code);
  }
  if (DRY) await conn.rollback(); else await conn.commit();
  console.log(`\n${DRY ? 'would add' : 'added'} Execution plan to ${done.added.length} (${done.added.join(', ') || 'none'}); already there: ${done.already.length}; left alone: ${done.skipped.length}`);
} catch (e) {
  await conn.rollback();
  console.error('FAILED — nothing was written:', e.code ?? '', e.message, e.problems ?? '');
  process.exitCode = 1;
} finally {
  conn.release();
  await pool.end();
}
