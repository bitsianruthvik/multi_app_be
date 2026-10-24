/**
 * seed-law-rules.mjs — writes the new law data (services/law/lawData.js: Telangana minimum wages,
 * bonus, gratuity, overtime and hours, the Labour Code 50% wage rule, leave and holiday minimums)
 * into hrms_law_rules as PUBLISHED versions. (TM/CF_HRMS_HIRING_SPEC.md §36.1.)
 *
 *   node seed-law-rules.mjs                        DRY RUN on local — what would be added / changed
 *   node seed-law-rules.mjs --apply
 *   node seed-law-rules.mjs --apply --target=prod  (after the rules are reviewed)
 *
 * Idempotent by domain + jurisdiction + rule_key + effective_from: a missing rule is added as
 * version 1; a rule whose PUBLISHED value, source or verified flag differs from the seed gets a NEW
 * version, published, the old one SUPERSEDED (a published version is never edited) — said, old → new;
 * an equal one is left alone. A second run changes nothing. One transaction. Needs apply-law-schema.mjs.
 */
import path from 'path';
import { fileURLToPath } from 'url';
import mysql from 'mysql2/promise';
import { resolveTarget, announce } from './dbTarget.mjs';
import { LAW_RULE_ROWS } from '../services/law/lawData.js';
import { lawSeedPlan, applyLawSeed, SEEDED_BY } from '../services/law/migrate.js';
import { valueProblems, runExamples } from '../services/law/validate.js';

const APPLY = process.argv.includes('--apply');

async function newVersions(conn, differs) {
  for (const r of differs) {
    const [[m]] = await conn.query('SELECT COALESCE(MAX(version), 0) AS v FROM hrms_law_rules WHERE domain = ? AND jurisdiction = ? AND rule_key = ? AND effective_from = ?', [r.domain, r.jurisdiction, r.rule_key, r.effective_from]);
    await conn.query("UPDATE hrms_law_rules SET status = 'SUPERSEDED' WHERE id = ? AND status = 'PUBLISHED'", [r.id]);
    await conn.query(
      `INSERT INTO hrms_law_rules (domain, jurisdiction, rule_key, title, value_json, effective_from, effective_to, version, status, source_url, source_note, note, verified, reviewed_by, published_at, review_by, supersedes_id, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PUBLISHED', ?, ?, ?, ?, ?, NOW(), ?, ?, ?)`,
      [r.domain, r.jurisdiction, r.rule_key, r.title ?? null, JSON.stringify(r.value), r.effective_from, r.effective_to ?? null, Number(m.v) + 1, r.source_url ?? null, r.source_note ?? null, r.note ?? null, r.verified ? 1 : 0, SEEDED_BY, r.review_by ?? null, r.id, SEEDED_BY]);
  }
}

async function main() {
  const target = resolveTarget();
  announce(target);
  for (const r of LAW_RULE_ROWS) {
    const p = [...valueProblems(r.domain, r.rule_key, r.value), ...runExamples(r.domain, r.rule_key, r.value)];
    if (p.length) throw new Error(`${r.domain} ${r.jurisdiction} ${r.rule_key} ${r.effective_from}: ${p.join('; ')}`);
  }
  const conn = await mysql.createConnection({ ...target.cfg, dateStrings: true });
  try {
    const [[t]] = await conn.query("SELECT COUNT(*) AS c FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_law_rules'");
    if (!t.c) throw new Error('hrms_law_rules is not there — run apply-law-schema.mjs --apply first.');
    if (!APPLY) console.log('  DRY RUN — nothing is written without --apply\n');
    const plan = await lawSeedPlan(conn);
    for (const r of plan.insert) console.log(`  ${APPLY ? 'add' : 'would add'}     ${r.domain.padEnd(9)} ${r.jurisdiction} ${r.rule_key} from ${r.effective_from}${r.verified ? '' : '   (NOT VERIFIED)'}`);
    for (const r of plan.differs) console.log(`  ${APPLY ? 'new version' : 'would publish a new version'}  ${r.domain} ${r.jurisdiction} ${r.rule_key} from ${r.effective_from}: ${r.changes.join(', ')}`);
    console.log(`\n  ${plan.insert.length} to add, ${plan.differs.length} new version(s), ${plan.same} already equal.`);
    if (APPLY && (plan.insert.length || plan.differs.length)) {
      await conn.beginTransaction();
      try { await applyLawSeed(conn, plan); await newVersions(conn, plan.differs); await conn.commit(); } catch (e) { await conn.rollback(); throw e; }
      const again = await lawSeedPlan(conn);
      if (again.insert.length || again.differs.length) throw new Error('after applying, the seed still plans changes');
      console.log('  done; checked: a second run plans nothing.');
    }
    const unverified = LAW_RULE_ROWS.filter((r) => !r.verified);
    if (unverified.length) console.log(`\n  NOT VERIFIED (check before use): ${unverified.map((r) => `${r.domain} ${r.jurisdiction} ${r.rule_key}`).join('; ')}`);
    console.log('');
  } finally {
    await conn.end();
  }
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) main().then(() => process.exit(0)).catch((e) => { console.error(`\n  FAILED: ${e.message}\n`); process.exit(1); });
