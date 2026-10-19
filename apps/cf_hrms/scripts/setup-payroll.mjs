/**
 * setup-payroll.mjs — give a company what payroll starts with (TM/CF_HRMS_HIRING_SPEC.md §25.2):
 * the ready-made components, the sample structure "Staff standard", the statutory settings of
 * Telangana from 2025-04-01 and 2026-04-01 (and the PF ceiling row of 2026-09-17), each with its
 * source, and the company's payroll settings (state TG).
 *
 *   node setup-payroll.mjs --company=karni                    DRY RUN — says what it would add
 *   node setup-payroll.mjs --company=karni --apply
 *   node setup-payroll.mjs --company=karni --apply --target=prod
 *
 * The same function as POST /payroll/setup (services/payroll/seed.js). Idempotent: what exists
 * is left alone, a second run adds nothing. Audited. apply-payroll-schema.mjs comes first.
 */
import mysql from 'mysql2/promise';
import { resolveTarget, announce } from './dbTarget.mjs';
import { seedPayroll } from '../services/payroll/seed.js';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const slug = (args.find((a) => a.startsWith('--company=')) ?? '').split('=')[1];

async function main() {
  if (!slug) throw new Error('--company=<slug> is required');
  const target = resolveTarget();
  announce(target);
  const conn = await mysql.createConnection({ ...target.cfg, dateStrings: true });
  try {
    const [[company]] = await conn.query('SELECT id, name FROM companies WHERE slug = ? AND deleted_at IS NULL', [slug]);
    if (!company) throw new Error(`No company "${slug}".`);
    const [[owner]] = await conn.query("SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE u.company_id = ? AND u.deleted_at IS NULL AND LOWER(r.name) = 'admin' ORDER BY u.id LIMIT 1", [company.id]);
    console.log(`  company: ${company.name} (${company.id})${APPLY ? '' : '   DRY RUN — nothing is written without --apply'}\n`);
    await conn.beginTransaction();
    const made = await seedPayroll(conn, { companyId: company.id, userId: owner?.id ?? null }, 'setup-payroll');
    if (APPLY) await conn.commit(); else await conn.rollback();
    const w = APPLY ? 'added' : 'to add';
    console.log(`  components ${w}: ${made.components.length ? made.components.join(', ') : 'none (all there)'}`);
    console.log(`  structure ${w}: ${made.structure ?? 'none (Staff standard is there)'}`);
    console.log(`  statutory rows ${w}: ${made.statutory.length ? `\n    ${made.statutory.join('\n    ')}` : 'none (all there)'}`);
    console.log(`  payroll settings ${w}: ${made.settings ? 'yes (state TG)' : 'no (there)'}`);
    console.log(APPLY ? '\n  done.\n' : '\n  nothing written. Run again with --apply.\n');
  } catch (e) {
    try { await conn.rollback(); } catch { /* the first error matters */ }
    throw e;
  } finally {
    await conn.end();
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(`\n  FAILED: ${e.message}\n`); process.exit(1); });
