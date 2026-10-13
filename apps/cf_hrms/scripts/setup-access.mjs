/**
 * setup-access.mjs — move a company onto the rights model.
 * (TM/CF_HRMS_HIRING_SPEC.md §12.4.)
 *
 *   node setup-access.mjs --company=karni                    DRY RUN — says what it would do
 *   node setup-access.mjs --company=karni --apply
 *   node setup-access.mjs --company=karni --apply --target=prod
 *   --allow-gain     let an EXISTING role that already has logins take the rights of the
 *                    ready-made role it is named after (refused otherwise)
 *
 * WHAT IT DOES (services/accessSetup.js — the same function the tests run):
 *   1. the feature rows and one capability per right exist (global, created once);
 *   2. the company's ready-made roles exist — Owner (its existing `admin` role,
 *      never renamed), HR manager, HR executive, Department head, Employee —
 *      each with its row in hrms_access_roles and its grants, for THIS company
 *      and its own cf_hrms app only;
 *   3. every other role of the company that holds old cf_hrms tags gets the new
 *      rights those map to, and an access role named after it.
 *
 * It prints, per role: the logins holding it and its rights before -> after.
 * "Before" is what the role could do under the old backend, said in the new
 * words. A role that existed must come out with the same rights; if one would
 * gain or lose anything, NOTHING is written and the script says which.
 *
 * RUN IT BEFORE THE BACKEND DEPLOY. The old backend ignores the new tags; the
 * new backend ignores the old ones. apply-access-schema.mjs comes first.
 *
 * Idempotent, and it never takes a right away. Dry run by default. Local by
 * default (scripts/dbTarget.mjs).
 */
import mysql from 'mysql2/promise';
import { resolveTarget, announce } from './dbTarget.mjs';
import { setupAccess } from '../services/accessSetup.js';
import { ALL_TAGS, AREAS, NAMED, areaTag } from '../lib/access.js';

const args = process.argv.slice(2);
const arg = (n) => { const hit = args.find((a) => a.startsWith(`--${n}=`)); return hit ? hit.slice(hit.indexOf('=') + 1) : null; };
const APPLY = args.includes('--apply');
const ALLOW_GAIN = args.includes('--allow-gain');

/** A set of rights in a few words: "everything (37)", or area by area. */
function inWords(tags) {
  if (!tags.length) return 'nothing';
  if (tags.length === ALL_TAGS.length) return `everything (${tags.length} rights)`;
  const have = new Set(tags);
  const parts = [];
  for (const a of AREAS) {
    const rights = a.rights.filter((r) => have.has(areaTag(a.key, r)));
    if (rights.length) parts.push(`${a.key}: ${rights.join('+')}`);
  }
  const named = NAMED.filter((n) => have.has(n.tag)).map((n) => n.tag.replace('cf_hrms_', ''));
  if (named.length) parts.push(named.join(', '));
  return `${parts.join(' · ')}  (${tags.length})`;
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
    console.log(`  company: ${company.name} (${company.id})${APPLY ? '' : '   DRY RUN — nothing is written without --apply'}\n`);

    await conn.beginTransaction();
    // A dry run still runs the whole thing, to say exactly what an apply would do — and is rolled back.
    const report = await setupAccess(conn, company.id, { apply: true, allowGain: ALLOW_GAIN });
    const willWrite = APPLY && !report.problems.length;
    if (willWrite) await conn.commit(); else await conn.rollback();

    const c = report.catalog;
    const did = (n, one, many) => `${n} ${n === 1 ? one : many}`;
    console.log(`  rights catalogue   ${ALL_TAGS.length} rights; ${c.features.length ? `${did(c.features.length, 'feature', 'features')} ${willWrite ? 'created' : 'to create'}` : 'every feature exists'}; `
      + `${c.capabilities.length ? `${did(c.capabilities.length, 'capability', 'capabilities')} ${willWrite ? 'created' : 'to create'}` : 'every capability exists'}`
      + `${c.repaired.length ? `; REPAIRED (held more than its one feature): ${c.repaired.join(', ')}` : ''}\n`);

    for (const r of report.roles) {
      const what = r.templateKey ? `${r.label} [${r.templateKey}]` : r.label;
      console.log(`  ${r.platformName}  ->  ${what}, scope ${r.scope}${r.existed ? '' : `   (NEW role${willWrite ? '' : ', to create'})`}`);
      console.log(`      logins   ${r.logins} with access to the app${r.loginsOfRole !== r.logins ? ` (${r.loginsOfRole} users have it as their company role)` : ''}`);
      if (r.existed) {
        console.log(`      before   ${r.templateKey === 'OWNER' ? 'everything (the platform lets "admin" through every check)' : inWords(r.before)}${r.oldTags.length ? `   [old tags: ${r.oldTags.map((t) => t.replace('cf_hrms_', '')).join(', ')}]` : ''}`);
      }
      console.log(`      after    ${inWords(r.after)}`);
      if (r.existed) console.log(`      ${r.same ? 'SAME — nothing gained, nothing lost' : `CHANGED — gained: ${r.gained.join(', ') || 'none'}; lost: ${r.lost.join(', ') || 'none'}`}`);
      if (r.wildcard.length) console.log(`      WARNING  holds ${r.wildcard.join(', ')} through a grant with NO app (it applies in every app); this script does not write or remove those.`);
      console.log('');
    }
    if (report.diverged.length) {
      console.log(`  NOTE  ${did(report.diverged.length, 'login has', 'logins have')} a company role different from the role on this app's access row (user ids ${report.diverged.map((d) => d.userId).join(', ')}).`
        + ' This app goes by its own access row; the Logins screen sets both when a role is changed.\n');
    }
    if (report.problems.length) {
      console.log('  NOTHING WRITTEN — these must be settled first:');
      for (const p of report.problems) console.log(`    - ${p}`);
      console.log('');
      process.exitCode = 1;
    } else {
      console.log(APPLY ? '  done.\n' : '  nothing written. Run again with --apply.\n');
    }
  } catch (e) {
    try { await conn.rollback(); } catch { /* the first error is the one that matters */ }
    throw e;
  } finally {
    await conn.end();
  }
}

main().then(() => process.exit(process.exitCode ?? 0)).catch((e) => { console.error(`\n  FAILED: ${e.message}\n`); process.exit(1); });
