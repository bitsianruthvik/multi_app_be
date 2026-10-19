/**
 * seed-tax-rules.mjs — writes the tax engine's rules (services/tax/ruleData.js) into
 * hrms_tax_rules (TM/CF_HRMS_HIRING_SPEC.md §25.3; models/init.sql §27).
 *
 *   node seed-tax-rules.mjs                       DRY RUN on local — what would be added / changed
 *   node seed-tax-rules.mjs --apply
 *   node seed-tax-rules.mjs --apply --target=prod (after the rules are reviewed)
 *   node seed-tax-rules.mjs --year=2026-27        one year only
 *
 * Idempotent by (tax_year, regime, rule_key): a missing row is inserted, a row whose value,
 * source or verified flag differs is updated (and said, old → new), an equal row is left
 * alone; a second run changes nothing. Rows in the table that the seed does not know are
 * listed, never deleted. One transaction. Needs apply-tax-schema.mjs first.
 */
import path from 'path';
import { fileURLToPath } from 'url';
import mysql from 'mysql2/promise';
import { resolveTarget, announce } from './dbTarget.mjs';
import { TAX_RULE_ROWS } from '../services/tax/ruleData.js';

const APPLY = process.argv.includes('--apply');
const YEAR = (process.argv.find((a) => a.startsWith('--year=')) || '').split('=')[1] || null;

/** Key order does not matter: a stable JSON for comparing. */
export function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

/** What the seed would do: { insert[], update[], same, unknown[] }. Reads only. */
export async function seedPlan(conn, rows = TAX_RULE_ROWS) {
  const [have] = await conn.query('SELECT id, tax_year, regime, rule_key, value_json, source_note, source_url, verified, deleted_at FROM hrms_tax_rules');
  const byKey = new Map(have.map((r) => [`${r.tax_year}|${r.regime}|${r.rule_key}`, r]));
  const plan = { insert: [], update: [], same: 0, unknown: [] };
  const seen = new Set();
  for (const r of rows) {
    const k = `${r.tax_year}|${r.regime}|${r.rule_key}`;
    seen.add(k);
    const cur = byKey.get(k);
    if (!cur) { plan.insert.push(r); continue; }
    const curVal = typeof cur.value_json === 'string' ? JSON.parse(cur.value_json) : cur.value_json;
    const changes = [];
    if (stable(curVal) !== stable(r.value)) changes.push('value');
    if ((cur.source_note ?? '') !== r.source_note) changes.push('source_note');
    if ((cur.source_url ?? '') !== r.source_url) changes.push('source_url');
    if (Number(cur.verified) !== Number(r.verified)) changes.push(`verified ${cur.verified} → ${r.verified}`);
    if (cur.deleted_at) changes.push('restored (was deleted)');
    if (changes.length) plan.update.push({ ...r, id: cur.id, changes }); else plan.same += 1;
  }
  for (const [k, r] of byKey) if (!seen.has(k) && (!YEAR || r.tax_year === YEAR)) plan.unknown.push(k);
  return plan;
}

/** Applies a plan inside the caller's transaction. */
export async function applyPlan(conn, plan) {
  for (const r of plan.insert) {
    await conn.query('INSERT INTO hrms_tax_rules (tax_year, regime, rule_key, value_json, source_note, source_url, verified) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [r.tax_year, r.regime, r.rule_key, JSON.stringify(r.value), r.source_note, r.source_url, r.verified]);
  }
  for (const r of plan.update) {
    await conn.query('UPDATE hrms_tax_rules SET value_json = ?, source_note = ?, source_url = ?, verified = ?, deleted_at = NULL WHERE id = ?',
      [JSON.stringify(r.value), r.source_note, r.source_url, r.verified, r.id]);
  }
}

async function main() {
  const target = resolveTarget();
  announce(target);
  const rows = YEAR ? TAX_RULE_ROWS.filter((r) => r.tax_year === YEAR) : TAX_RULE_ROWS;
  if (!rows.length) throw new Error(`The seed has no rows for ${YEAR}.`);
  const conn = await mysql.createConnection({ ...target.cfg, dateStrings: true });
  try {
    const [[t]] = await conn.query("SELECT COUNT(*) AS c FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_tax_rules'");
    if (!t.c) throw new Error('hrms_tax_rules is not there — run apply-tax-schema.mjs --apply first.');
    if (!APPLY) console.log('  DRY RUN — nothing is written without --apply\n');
    const plan = await seedPlan(conn, rows);
    for (const r of plan.insert) console.log(`  ${APPLY ? 'add' : 'would add'}     ${r.tax_year} ${r.regime.padEnd(3)} ${r.rule_key}${r.verified ? '' : '   (NOT VERIFIED)'}`);
    for (const r of plan.update) console.log(`  ${APPLY ? 'update' : 'would update'}  ${r.tax_year} ${r.regime.padEnd(3)} ${r.rule_key}: ${r.changes.join(', ')}`);
    for (const k of plan.unknown) console.log(`  in the table, not in the seed (left alone): ${k.replace(/\|/g, ' ')}`);
    console.log(`\n  ${plan.insert.length} to add, ${plan.update.length} to change, ${plan.same} already equal.`);
    if (APPLY && (plan.insert.length || plan.update.length)) {
      await conn.beginTransaction();
      try { await applyPlan(conn, plan); await conn.commit(); } catch (e) { await conn.rollback(); throw e; }
      const again = await seedPlan(conn, rows);
      if (again.insert.length || again.update.length) throw new Error('after applying, the seed still plans changes');
      console.log('  done; checked: a second run plans nothing.');
    }
    const unverified = rows.filter((r) => !r.verified);
    if (unverified.length) console.log(`\n  NOT VERIFIED (check before use): ${unverified.map((r) => `${r.tax_year} ${r.regime} ${r.rule_key}`).join('; ')}`);
    console.log('');
  } finally {
    await conn.end();
  }
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) main().then(() => process.exit(0)).catch((e) => { console.error(`\n  FAILED: ${e.message}\n`); process.exit(1); });
