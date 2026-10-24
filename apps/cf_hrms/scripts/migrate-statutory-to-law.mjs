/**
 * migrate-statutory-to-law.mjs — moves PF, ESI, PT and LWF from the per-company
 * hrms_pay_statutory_settings into the law layer (hrms_law_rules, PUBLISHED version 1, rule_key
 * 'settings'), keeping their values, sources, verified flags and effective dates; makes each
 * company's choices row (hrms_law_company_choices). (TM/CF_HRMS_HIRING_SPEC.md §36.1;
 * services/law/migrate.js says exactly how.)
 *
 *   node migrate-statutory-to-law.mjs                        DRY RUN on local — what it would do
 *   node migrate-statutory-to-law.mjs --apply
 *   node migrate-statutory-to-law.mjs --apply --target=prod
 *
 * Idempotent: a rule already in the law layer with the same value is left alone; with another value
 * it is reported and left alone (a change of law is a new version). Companies whose values differ
 * from the rest are reported. The old table is not changed. One transaction. Needs apply-law-schema.mjs.
 */
import path from 'path';
import { fileURLToPath } from 'url';
import mysql from 'mysql2/promise';
import { resolveTarget, announce } from './dbTarget.mjs';
import { statutoryMigrationPlan, applyStatutoryMigration } from '../services/law/migrate.js';

const APPLY = process.argv.includes('--apply');

async function main() {
  const target = resolveTarget();
  announce(target);
  const conn = await mysql.createConnection({ ...target.cfg, dateStrings: true });
  try {
    const [[t]] = await conn.query("SELECT COUNT(*) AS c FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_law_rules'");
    if (!t.c) throw new Error('hrms_law_rules is not there — run apply-law-schema.mjs --apply first.');
    if (!APPLY) console.log('  DRY RUN — nothing is written without --apply\n');
    const plan = await statutoryMigrationPlan(conn);
    for (const r of plan.insert) console.log(`  ${APPLY ? 'add' : 'would add'}     ${r.domain.padEnd(4)} ${r.jurisdiction} from ${r.effective_from}${r.verified ? '' : '   (NOT VERIFIED)'}   held by companies ${r.companies.join(', ') || '— (the product seed)'}`);
    for (const r of plan.same) console.log(`  same        ${r.key.replace(/\|/g, ' ')} (law rule ${r.id})`);
    for (const r of plan.differs) console.log(`  DIFFERS     ${r.key.replace(/\|/g, ' ')}: the law layer already holds another value (rule ${r.id}) — left alone; publish a new version if the law changed`);
    for (const r of plan.conflicts) console.log(`  CONFLICT    ${r.key.replace(/\|/g, ' ')}: kept the value of ${r.kept}; companies ${r.others.join(', ')} held another — check them`);
    for (const id of plan.choices) console.log(`  ${APPLY ? 'add' : 'would add'}     choices row for company ${id}`);
    console.log(`\n  ${plan.insert.length} rule(s) to add, ${plan.same.length} already there, ${plan.differs.length} different, ${plan.conflicts.length} conflict(s), ${plan.choices.length} choices row(s).`);
    if (APPLY && (plan.insert.length || plan.choices.length)) {
      await conn.beginTransaction();
      try { await applyStatutoryMigration(conn, plan); await conn.commit(); } catch (e) { await conn.rollback(); throw e; }
      const again = await statutoryMigrationPlan(conn);
      if (again.insert.length || again.choices.length) throw new Error('after applying, the migration still plans changes');
      console.log('  done; checked: a second run plans nothing.');
    }
    console.log('');
  } finally {
    await conn.end();
  }
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) main().then(() => process.exit(0)).catch((e) => { console.error(`\n  FAILED: ${e.message}\n`); process.exit(1); });
