/**
 * setup-performance.mjs — a company's performance settings and role frequencies
 * (TM/CF_HRMS_HIRING_SPEC.md §18.4).
 *
 *   node setup-performance.mjs --company=karni                    DRY RUN — prints what it would set
 *   node setup-performance.mjs --company=karni --apply
 *   node setup-performance.mjs --company=karni --apply --target=prod
 *
 * WHAT IT WRITES:
 *   1. settings, when the company has none: the year starts in April, a role
 *      with no frequency of its own is QUARTERLY, the rating scale 1 "Needs
 *      improvement" … 5 "Outstanding". Settings somebody saved are left as they are.
 *   2. role frequencies: MONTHLY for every role whose title starts with or
 *      contains Operator, Assistant Operator or Helper; QUARTERLY for the rest.
 *      ONLY where a role has no frequency yet — one set by hand (or by an
 *      earlier run) is never overwritten. Both lists are printed in full so a
 *      person can check them.
 * It creates no periods and no plans. Idempotent: a second run changes nothing.
 * Needs apply-performance-schema.mjs first.
 */
import mysql from 'mysql2/promise';
import { resolveTarget, announce } from './dbTarget.mjs';
import { DEFAULTS } from '../services/performance/settingsService.js';

const args = process.argv.slice(2);
const arg = (n) => { const hit = args.find((a) => a.startsWith(`--${n}=`)); return hit ? hit.slice(hit.indexOf('=') + 1) : null; };
const APPLY = args.includes('--apply');

/**
 * Operator, Assistant Operator, Helper — anywhere in the title, as a word. Karni
 * also writes Assistant Operator short, "Asst Op" ("Asst Op 1 & Asst Op 2 …"):
 * that counts too.
 */
export const MONTHLY_TITLE = /\b(?:assistant\s+operator|operator|helper|asst\.?\s+op)s?\b/i;
export const frequencyForTitle = (title) => (MONTHLY_TITLE.test(String(title ?? '')) ? 'MONTHLY' : 'QUARTERLY');

/** What a run would do, and (with apply) does it. Returns the report. Used by the test too. */
export async function setupPerformance(conn, companyId, { apply = false, userId = null } = {}) {
  const [[settings]] = await conn.query('SELECT id FROM hrms_performance_settings WHERE company_id = ?', [companyId]);
  const [roles] = await conn.query('SELECT id, title, performance_frequency FROM hrms_roles WHERE company_id = ? AND deleted_at IS NULL ORDER BY title', [companyId]);
  const plan = roles.map((r) => ({ id: r.id, title: r.title, current: r.performance_frequency ?? null, wanted: frequencyForTitle(r.title) }));
  const toSet = plan.filter((r) => r.current == null);
  const report = {
    settings: settings ? 'kept' : 'create',
    monthly: plan.filter((r) => (r.current ?? r.wanted) === 'MONTHLY'),
    quarterly: plan.filter((r) => (r.current ?? r.wanted) === 'QUARTERLY'),
    other: plan.filter((r) => r.current != null && !['MONTHLY', 'QUARTERLY'].includes(r.current)),
    toSet,
    kept: plan.filter((r) => r.current != null),
  };
  if (!apply) return report;
  if (!settings) {
    await conn.query(
      'INSERT INTO hrms_performance_settings (company_id, year_start_month, default_frequency, rating_scale, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?)',
      [companyId, DEFAULTS.yearStartMonth, DEFAULTS.defaultFrequency, JSON.stringify(DEFAULTS.ratingScale), userId, userId],
    );
  }
  for (const f of ['MONTHLY', 'QUARTERLY']) {
    const ids = toSet.filter((r) => r.wanted === f).map((r) => r.id);
    // "IS NULL" again in the statement: a frequency set by hand since the read is not overwritten.
    if (ids.length) await conn.query('UPDATE hrms_roles SET performance_frequency = ? WHERE company_id = ? AND id IN (?) AND performance_frequency IS NULL', [f, companyId, ids]);
  }
  if (!settings || toSet.length) {
    await conn.query(
      `INSERT INTO hrms_audit_log (company_id, actor_user_id, entity_type, entity_id, action, before_json, after_json, request_id, created_by)
       VALUES (?, ?, 'hrms_performance_settings', ?, 'CREATE', NULL, ?, 'setup-performance', ?)`,
      [companyId, userId, companyId, JSON.stringify({ settingsCreated: !settings, monthly: toSet.filter((r) => r.wanted === 'MONTHLY').length, quarterly: toSet.filter((r) => r.wanted === 'QUARTERLY').length }), userId],
    );
  }
  return report;
}

async function main() {
  const slug = arg('company');
  if (!slug) throw new Error('--company=<slug> is required');
  const target = resolveTarget();
  announce(target);
  const conn = await mysql.createConnection(target.cfg);
  try {
    const [[company]] = await conn.query('SELECT id, name FROM companies WHERE slug = ? AND deleted_at IS NULL', [slug]);
    if (!company) throw new Error(`No company "${slug}".`);
    const [[t]] = await conn.query("SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_performance_settings'");
    if (!Number(t.n)) throw new Error('The performance tables are not there — run apply-performance-schema.mjs first.');
    console.log(`  company: ${company.name} (${company.id})${APPLY ? '' : '   DRY RUN — nothing is written without --apply'}\n`);
    await conn.beginTransaction();
    const report = await setupPerformance(conn, company.id, { apply: APPLY });
    await conn.commit();
    console.log(`  settings: ${report.settings === 'kept' ? 'already saved — left as they are' : `${APPLY ? 'created' : 'would create'}: the year starts in April; default QUARTERLY; rating scale 1 Needs improvement … 5 Outstanding`}`);
    const line = (r) => `      ${r.title}${r.current ? '   (already set — kept)' : ''}`;
    console.log(`\n  MONTHLY (${report.monthly.length}):`);
    for (const r of report.monthly) console.log(line(r));
    console.log(`\n  QUARTERLY (${report.quarterly.length}):`);
    for (const r of report.quarterly) console.log(line(r));
    if (report.other.length) {
      console.log(`\n  OTHER, set by hand (${report.other.length}):`);
      for (const r of report.other) console.log(`      ${r.title}   ${r.current}`);
    }
    console.log(`\n  ${report.toSet.length} role frequenc${report.toSet.length === 1 ? 'y' : 'ies'} ${APPLY ? 'set' : 'to set'}; ${report.kept.length} already set and kept. No periods or plans are made.`);
    console.log(APPLY ? '\n  done.\n' : '\n  nothing written. Run again with --apply.\n');
  } catch (e) {
    try { await conn.rollback(); } catch { /* the first error is the one that matters */ }
    throw e;
  } finally {
    await conn.end();
  }
}

import path from 'path';
import { fileURLToPath } from 'url';
if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) main().then(() => process.exit(0)).catch((e) => { console.error(`\n  FAILED: ${e.message}\n`); process.exit(1); });
