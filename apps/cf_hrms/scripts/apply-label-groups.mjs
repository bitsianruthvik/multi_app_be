/**
 * apply-label-groups.mjs — labels in groups (TM/CF_HRMS_HIRING_SPEC.md §15.1).
 *
 *   node apply-label-groups.mjs                       DRY RUN on local — says what it would do
 *   node apply-label-groups.mjs --apply
 *   node apply-label-groups.mjs --apply --target=prod
 *   node apply-label-groups.mjs --company=karni       one company only (default: every company with departments or labels)
 *
 * 1. THE SCHEMA (DDL commits by itself, so it runs first, outside the
 *    transaction; the text of each CREATE is read out of models/init.sql §17):
 *    hrms_label_groups · hrms_department_labels.group_id · a label's name unique
 *    within its group (uq_hdlb_group_name) in place of within the company
 *    (uq_hdlb_name) · hrms_department_label_links.
 * 2. PER COMPANY, one transaction for all (scripts/labelGroupsMigration.mjs):
 *    the group Kind; its labels moved into it; every department linked to its
 *    Kind label from department_type. It prints, per company, departments per
 *    label before and after and the Kind links before and after.
 *
 * RUN IT BEFORE THE BACKEND THAT READS THE GROUPS IS DEPLOYED (that backend
 * reads the new tables on every department list), and AGAIN right after the
 * deploy: a department or label the old backend wrote in between is picked up
 * by the second run. The old backend keeps working on the new schema.
 *
 * Idempotent: a second run finds nothing to do. Dry run by default. Local by
 * default (scripts/dbTarget.mjs).
 */
import mysql from 'mysql2/promise';
import { resolveTarget, announce } from './dbTarget.mjs';
import { schemaSteps, readCompany, planCompany, applyCompany } from './labelGroupsMigration.mjs';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const only = (args.find((a) => a.startsWith('--company=')) ?? '').split('=')[1] || null;

const show = (counts) => (Object.entries(counts).map(([k, n]) => `${k} ${n}`).join(' · ') || 'none');
const some = (n, one, many) => `${n} ${n === 1 ? one : many}`;

async function main() {
  const target = resolveTarget();
  announce(target);
  const conn = await mysql.createConnection({ ...target.cfg, dateStrings: true });
  try {
    if (!APPLY) console.log('  DRY RUN — nothing is written without --apply\n');

    // 1. the schema
    const steps = await schemaSteps(conn);
    if (!steps.length) console.log('  schema: already there');
    for (const s of steps) {
      if (APPLY) { await conn.query(s.sql); console.log(`  schema: ${s.what} — done`); } else console.log(`  schema: would ${s.what}`);
    }
    const schemaReady = APPLY || !steps.length;

    // 2. the companies
    const [companies] = await conn.query(
      `SELECT c.id, c.slug, c.name FROM companies c
        WHERE c.deleted_at IS NULL
          AND (EXISTS (SELECT 1 FROM hrms_departments d WHERE d.company_id = c.id)
               OR EXISTS (SELECT 1 FROM hrms_department_labels l WHERE l.company_id = c.id))
          ${only ? 'AND c.slug = ?' : ''} ORDER BY c.id`,
      only ? [only] : [],
    );
    if (only && !companies.length) throw new Error(`No company "${only}" with departments or labels.`);
    if (!companies.length) console.log('\n  no company has departments or labels — nothing to do.');

    await conn.beginTransaction();
    let changed = 0;
    for (const company of companies) {
      const state = await readCompany(conn, company.id, { schemaReady });
      const plan = planCompany(state);
      const live = state.departments.filter((d) => d.deleted_at == null).length;
      console.log(`\n  ${company.name} (${company.slug}, ${company.id}) — ${some(live, 'department', 'departments')}`);
      console.log(`    labels before   ${show(plan.before.byType)}`);
      console.log(`    labels after    ${show(plan.after.byType)}`);
      console.log(`    Kind links      before ${show(plan.before.kindLinks)}   →   after ${show(plan.after.kindLinks)}`);
      if (plan.nothing) { console.log('    nothing to do'); continue; }
      const what = [
        plan.makeKind && (APPLY ? 'made the group Kind' : 'would make the group Kind'),
        plan.moveLabels.length && `${APPLY ? 'moved' : 'would move'} ${some(plan.moveLabels.length, 'label', 'labels')} into Kind`,
        plan.addLabels.length && `${APPLY ? 'added' : 'would add'} ${plan.addLabels.join(', ')} to Kind`,
        plan.blankDepartments.length && `${APPLY ? 'gave' : 'would give'} ${some(plan.blankDepartments.length, 'department', 'departments')} with no label the first Kind label`,
        plan.link.length && `${APPLY ? 'linked' : 'would link'} ${some(plan.link.length, 'department', 'departments')}`,
        plan.relink.length && `${APPLY ? 'relinked' : 'would relink'} ${some(plan.relink.length, 'department', 'departments')} whose link disagreed with department_type`,
      ].filter(Boolean);
      console.log(`    ${what.join('; ')}`);
      changed += 1;
      if (APPLY) await applyCompany(conn, company.id, plan);
    }
    if (APPLY) {
      // Read back what was written: every live department's Kind link agrees with department_type.
      for (const company of companies) {
        const again = planCompany(await readCompany(conn, company.id));
        if (!again.nothing) throw new Error(`${company.slug}: after applying, the plan is not empty — rolled back.`);
      }
      await conn.commit();
    } else await conn.rollback();
    console.log(APPLY
      ? `\n  done — ${some(changed, 'company', 'companies')} changed; a second run plans nothing.\n`
      : `\n  nothing written — ${some(changed, 'company', 'companies')} would change. Run again with --apply.\n`);
  } catch (e) {
    try { await conn.rollback(); } catch { /* the first error is the one that matters */ }
    throw e;
  } finally {
    await conn.end();
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(`\n  FAILED: ${e.message}\n`); process.exit(1); });
