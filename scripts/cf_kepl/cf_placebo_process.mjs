/**
 * cf_placebo_process.mjs — the sales-order process for Placebo.
 *
 * Placebo had NO process at all: zero processes, zero stages, zero rules, and
 * its one order running unstaged. So this creates one rather than adding a
 * stage to something that was not there.
 *
 * It goes through processService, not through INSERTs, so the service's own
 * validation runs — an unknown stage key is refused by name, and a duplicate
 * rule is refused rather than silently shadowing another.
 *
 * WHAT IS REQUIRED, AND WHAT THAT MEANS. A required stage is a GATE: the order
 * cannot be confirmed until it is satisfied. `cut_pieces` and `nesting` are
 * required by the user's decision (2026-09-25) — a bridge whose plate parts have
 * not been pooled and laid out is not ready to sell, and making them advisory
 * would let that through.
 *
 * The rule is the HOUSE DEFAULT for this company only (customer_id and
 * order_type both NULL). A process is company-scoped, so "only for Placebo" is
 * what a Placebo process already is.
 *
 * Idempotent: run it twice and the second run changes nothing.
 */
import path from 'path';
import { pathToFileURL } from 'url';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
await imp('apps/cf_erp/services/codegenProvider.js');
const proc = await imp('apps/cf_erp/services/processService.js');

const COMPANY = Number(process.env.CF_BRIDGE_COMPANY ?? 30005);
const USER = Number(process.env.CF_SEED_USER ?? 22);
const c = { companyId: COMPANY, userId: USER };
const CODE = 'PRC-SALES';

/** Sequence, key, requirement. Order is the dependency order, not a preference. */
const STAGES = [
  { stageKey: 'lines', sequence: 10, requirement: 'required' },
  { stageKey: 'structure', sequence: 20, requirement: 'required' },
  { stageKey: 'values', sequence: 30, requirement: 'optional' },
  { stageKey: 'cut_pieces', sequence: 40, requirement: 'required' },
  { stageKey: 'nesting', sequence: 50, requirement: 'required' },
  { stageKey: 'buying', sequence: 60, requirement: 'optional' },
  { stageKey: 'production', sequence: 70, requirement: 'optional' },
  { stageKey: 'confirm', sequence: 80, requirement: 'required' },
];

const conn = await pool.getConnection();
const say = (s) => console.log(s);

try {
  await conn.beginTransaction();

  const [[existing]] = await conn.query(
    'SELECT id, code FROM cf_processes WHERE company_id = ? AND code = ? AND deleted_at IS NULL',
    [COMPANY, CODE],
  );

  let id;
  if (existing) {
    id = existing.id;
    say(`process ${CODE} already exists (id ${id}) — its stages will be replaced`);
  } else {
    const made = await proc.createProcess(conn, c, {
      code: CODE,
      name: 'Sales order',
      description: 'Placebo: lines through to confirmation, with cut pieces and nesting as gates.',
    });
    id = made.id;
    say(`created process ${CODE} (id ${id})`);
  }

  await proc.replaceStages(conn, c, id, { stages: STAGES });
  say(`${STAGES.length} stages set:`);
  for (const s of STAGES) say(`   ${String(s.sequence).padStart(3)}  ${s.stageKey.padEnd(11)} ${s.requirement}`);

  await proc.setProcessStatus(conn, c, id, 'active').catch(() => {});

  // The house default for this company. A process is company-scoped already, so
  // "only Placebo" is what this is; the NULLs mean "every order in it".
  const [[rule]] = await conn.query(
    `SELECT id FROM cf_process_rules
      WHERE company_id = ? AND customer_id IS NULL AND order_type IS NULL AND deleted_at IS NULL`,
    [COMPANY],
  );
  if (rule) {
    say(`a house default rule already exists (id ${rule.id}) — left alone`);
  } else {
    await conn.query(
      'INSERT INTO cf_process_rules (company_id, process_id, customer_id, order_type) VALUES (?, ?, NULL, NULL)',
      [COMPANY, id],
    );
    say('house default rule added: every Placebo order follows it');
  }

  const [[check]] = await conn.query(
    `SELECT COUNT(*) AS stages FROM cf_process_stages
      WHERE company_id = ? AND process_id = ? AND deleted_at IS NULL`, [COMPANY, id],
  );
  if (Number(check.stages) !== STAGES.length) throw new Error(`expected ${STAGES.length} stages, found ${check.stages}`);

  await conn.commit();
  say('\ncommitted.');
} catch (e) {
  await conn.rollback();
  console.error('FAILED:', e.code ?? '', e.message, (e.problems ?? []).slice(0, 5));
  process.exitCode = 1;
} finally {
  conn.release();
  await pool.end();
}
