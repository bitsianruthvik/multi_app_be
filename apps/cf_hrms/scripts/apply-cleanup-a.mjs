/**
 * apply-cleanup-a.mjs — department labels (TM/CF_HRMS_HIRING_SPEC.md §9).
 *
 *   node apply-cleanup-a.mjs                       DRY RUN on local — says what it would do
 *   node apply-cleanup-a.mjs --apply
 *   node apply-cleanup-a.mjs --apply --target=prod
 *   node apply-cleanup-a.mjs --company=karni       one company only (default: every company with departments)
 *
 * WHAT IT DOES, for each company that has departments:
 *
 *   1. creates hrms_department_labels if it is not there (CREATE TABLE IF NOT
 *      EXISTS, the text taken from models/init.sql — never the whole file);
 *   2. renames the old labels on its departments:
 *          Process          -> Section
 *          Shared crew      -> Section, and the department is marked shared
 *          Machine / area   -> Machine
 *          no label         -> Department
 *      (matched without case; deleted departments too, so one that is restored
 *      does not come back with a label nobody has);
 *   3. gives the company its list: Department, Section, Machine — only when it
 *      has no list yet — plus every OTHER label its departments use, so no
 *      department is left with a label that is not in the list.
 *
 * It prints, per company, how many departments carry each label before and
 * after. A company with no departments is not touched here: its list is written
 * the first time it is read (services/departmentLabelService.js).
 *
 * The codes of §11 need no schema and no script here — see setup-codes.mjs.
 *
 * Idempotent: a second run finds nothing to rename and nothing to add.
 * Dry run by default. Local by default (scripts/dbTarget.mjs).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import mysql from 'mysql2/promise';
import { resolveTarget, announce } from './dbTarget.mjs';
import { TABLE, planLabels, applyLabels, readCompany } from './cleanupALabels.mjs';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const only = (args.find((a) => a.startsWith('--company=')) ?? '').split('=')[1] || null;

const sqlPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../models/init.sql');
const sql = fs.readFileSync(sqlPath, 'utf8');
const start = sql.indexOf(`CREATE TABLE IF NOT EXISTS ${TABLE} (`);
if (start < 0) throw new Error(`init.sql has no CREATE TABLE for ${TABLE}`);
const createText = sql.slice(start, sql.indexOf(';', sql.indexOf('\n)', start)));

const show = (counts) => (Object.entries(counts).map(([k, n]) => `${k} ${n}`).join(' · ') || 'none');
const some = (n, one, many) => `${n} ${n === 1 ? one : many}`;

async function main() {
  const target = resolveTarget();
  announce(target);
  const conn = await mysql.createConnection({ ...target.cfg, dateStrings: true });
  try {
    if (!APPLY) console.log('  DRY RUN — nothing is written without --apply\n');

    // 1. The table. DDL commits by itself, so it is done before the transaction.
    const [[there]] = await conn.query('SELECT COUNT(*) n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [TABLE]);
    let tableExists = Number(there.n) > 0;
    if (tableExists) console.log(`  ${TABLE}: already there`);
    else if (APPLY) { await conn.query(createText); tableExists = true; console.log(`  ${TABLE}: created`); } else console.log(`  ${TABLE}: would be created`);

    const [companies] = await conn.query(
      `SELECT c.id, c.slug, c.name FROM companies c
        WHERE c.deleted_at IS NULL AND EXISTS (SELECT 1 FROM hrms_departments d WHERE d.company_id = c.id)
          ${only ? 'AND c.slug = ?' : ''} ORDER BY c.id`,
      only ? [only] : [],
    );
    if (only && !companies.length) throw new Error(`No company "${only}" with departments.`);
    if (!companies.length) console.log('\n  no company has departments — nothing to do.');

    await conn.beginTransaction();
    let changed = 0;
    for (const company of companies) {
      const { departments, labels } = await readCompany(conn, company.id, { tableExists });
      const plan = planLabels(departments, labels);
      const live = departments.filter((d) => d.deleted_at == null).length;

      console.log(`\n  ${company.name} (${company.slug}, ${company.id}) — ${some(live, 'department', 'departments')}`);
      console.log(`    before   ${show(plan.before)}   · shared ${plan.sharedBefore}`);
      console.log(`    after    ${show(plan.after)}   · shared ${plan.sharedAfter}`);
      console.log(`    labels   ${labels.length ? labels.map((l) => l.name).join(', ') : 'none yet'}${plan.add.length ? `   + ${plan.add.join(', ')}` : ''}`);
      if (plan.nothing) { console.log('    nothing to do'); continue; }
      console.log(`    ${APPLY ? 'renamed' : 'would rename'} ${some(plan.renameCount, 'department', 'departments')}`
        + `${plan.share.length ? `, ${APPLY ? 'marked' : 'would mark'} ${plan.share.length} shared` : ''}`
        + `${plan.add.length ? `, ${APPLY ? 'added' : 'would add'} ${some(plan.add.length, 'label', 'labels')}` : ''}`);
      changed += 1;
      if (APPLY) await applyLabels(conn, company.id, plan, labels);
    }
    if (APPLY) await conn.commit(); else await conn.rollback();
    console.log(APPLY
      ? `\n  done — ${some(changed, 'company', 'companies')} changed.\n`
      : `\n  nothing written — ${some(changed, 'company', 'companies')} would change. Run again with --apply.\n`);
  } catch (e) {
    try { await conn.rollback(); } catch { /* the first error is the one that matters */ }
    throw e;
  } finally {
    await conn.end();
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(`\n  FAILED: ${e.message}\n`); process.exit(1); });
