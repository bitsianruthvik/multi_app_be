/**
 * setup-codes.mjs — a company's employee-code and letter-reference rules.
 * (TM/CF_HRMS_HIRING_SPEC.md §1.5.)
 *
 *   node setup-codes.mjs --company=karni                    DRY RUN — says what it would do
 *   node setup-codes.mjs --company=karni --apply
 *   node setup-codes.mjs --company=karni --apply --target=prod
 *
 *   --employee-prefix=KP      text in front of the employee number   (Karni: KP)
 *   --ref-prefix=KPPL/HR/     text in front of the letter reference  (Karni: KPPL/HR/)
 * Both are required for any company other than Karni.
 *
 * WHAT IT CREATES, each only if the company has no rule of that kind yet:
 *   employee codes      <prefix> + 0000                  KP0072
 *   letter references   <prefix> + {fy} + / + 000        KPPL/HR/26-27/001
 * The rules are ordinary rules of the code generator (apps/cf_erp/modules/codegen)
 * and can be changed afterwards under Code formats.
 *
 * AND IT SETS THE EMPLOYEE COUNTER. A company that already has employees has
 * codes — Karni's are KP0001 to KP0071 — so the next number must start after
 * the highest one in use, not at 1. The issuing function would get there by
 * itself (it skips a code already in use), but 71 skipped numbers on the first
 * hire is 71 wasted round trips, so the counter is put where it belongs. It is
 * only ever RAISED: a counter that goes backwards re-issues codes.
 *
 * The highest code is read from employees that are not deleted. A deleted
 * record's code is still never issued again — the issuing function refuses it
 * when the counter reaches it.
 *
 * Idempotent: a second run finds the rules and the counter and changes nothing.
 * Dry run by default. Local by default (scripts/dbTarget.mjs).
 */
import mysql from 'mysql2/promise';
import { resolveTarget, announce } from './dbTarget.mjs';
import { createScheme } from '../../cf_erp/modules/codegen/service.js';
import { EMPLOYEE_ENTITY, HIRING_ENTITY } from '../services/codegenProvider.js';
import { DEFAULT_RULES } from '../services/codeService.js';

const args = process.argv.slice(2);
const arg = (n) => {
  const hit = args.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(hit.indexOf('=') + 1) : null;
};
const APPLY = args.includes('--apply');

const KNOWN = { karni: { employeePrefix: 'KP', refPrefix: 'KPPL/HR/' } };

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function main() {
  const slug = arg('company');
  if (!slug) throw new Error('--company=<slug> is required');
  const employeePrefix = arg('employee-prefix') ?? KNOWN[slug]?.employeePrefix;
  const refPrefix = arg('ref-prefix') ?? KNOWN[slug]?.refPrefix;
  if (!employeePrefix || !refPrefix) throw new Error(`--employee-prefix= and --ref-prefix= are required for "${slug}"`);

  const target = resolveTarget();
  announce(target);
  const conn = await mysql.createConnection(target.cfg);
  try {
    const [[company]] = await conn.query('SELECT id, name FROM companies WHERE slug = ? AND deleted_at IS NULL', [slug]);
    if (!company) throw new Error(`No company "${slug}".`);
    console.log(`  company: ${company.name} (${company.id})${APPLY ? '' : '   DRY RUN — nothing is written without --apply'}\n`);

    const ruleOf = async (entityType) => (await conn.query(
      `SELECT id, code, status FROM cf_code_schemes
        WHERE company_id = ? AND entity_type = ? AND target_field = 'code' AND deleted_at IS NULL ORDER BY id LIMIT 1`,
      [company.id, entityType],
    ))[0][0] ?? null;

    await conn.beginTransaction();

    // ── employee codes ──────────────────────────────────────────────────────
    let employeeRule = await ruleOf(EMPLOYEE_ENTITY);
    if (employeeRule) {
      console.log(`  employee codes     rule ${employeeRule.code} exists (${employeeRule.status}) — left as it is`);
    } else if (APPLY) {
      const made = await createScheme(conn, company.id, null, {
        ...DEFAULT_RULES[EMPLOYEE_ENTITY],
        description: `Employee codes: ${employeePrefix} and a running number. Set up by setup-codes.mjs.`,
        entityType: EMPLOYEE_ENTITY, targetField: 'code', seqScope: 'prefix', priority: 0, status: 'active', conditions: [],
        segments: [{ segmentType: 'literal', literalText: employeePrefix }, { segmentType: 'sequence', format: '0000' }],
      });
      employeeRule = { id: made.id, code: made.code };
      console.log(`  employee codes     rule ${made.code} created: ${employeePrefix} + 0000`);
    } else {
      console.log(`  employee codes     would create a rule: ${employeePrefix} + 0000`);
    }

    // ── the counter: after the highest code in use ───────────────────────────
    const [codes] = await conn.query('SELECT employee_code FROM hrms_employees WHERE company_id = ? AND deleted_at IS NULL', [company.id]);
    const numbered = new RegExp(`^${esc(employeePrefix)}(\\d+)$`, 'i');
    const used = codes.map((r) => numbered.exec(String(r.employee_code ?? '').trim())).filter(Boolean).map((m) => Number(m[1]));
    const next = (used.length ? Math.max(...used) : 0) + 1;
    console.log(`  employees          ${codes.length} with a code, ${used.length} of the form ${employeePrefix}<number>, highest ${used.length ? Math.max(...used) : 'none'}`);

    if (!employeeRule) {
      console.log(`  employee counter   would start at ${next}  (first new code ${employeePrefix}${String(next).padStart(4, '0')})`);
    } else {
      // Whether the rule counts per prefix (the text before the number) or for the whole rule.
      const [[scheme]] = await conn.query('SELECT seq_scope FROM cf_code_schemes WHERE id = ?', [employeeRule.id]);
      const [segments] = await conn.query(
        'SELECT segment_type, literal_text FROM cf_code_scheme_segments WHERE company_id = ? AND scheme_id = ? AND deleted_at IS NULL ORDER BY sort_order, id',
        [company.id, employeeRule.id],
      );
      const simple = segments.length === 2 && segments[0].segment_type === 'literal' && segments[1].segment_type === 'sequence'
        && String(segments[0].literal_text) === employeePrefix;
      if (!simple) {
        console.log(`  employee counter   the rule is not "${employeePrefix} + number" — its counter is left to the rule's owner`);
      } else {
        const key = scheme.seq_scope === 'scheme' ? '' : employeePrefix;
        const [[counter]] = await conn.query(
          'SELECT id, next_value FROM cf_code_sequences WHERE company_id = ? AND scheme_id = ? AND seq_key = ?',
          [company.id, employeeRule.id, key],
        );
        const first = `${employeePrefix}${String(Math.max(next, counter?.next_value ?? 0)).padStart(4, '0')}`;
        if (counter && counter.next_value >= next) {
          console.log(`  employee counter   at ${counter.next_value} — unchanged  (first new code ${first})`);
        } else if (APPLY) {
          await conn.query(
            `INSERT INTO cf_code_sequences (company_id, scheme_id, seq_key, next_value) VALUES (?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE next_value = GREATEST(next_value, VALUES(next_value))`,
            [company.id, employeeRule.id, key, next],
          );
          console.log(`  employee counter   set to ${next}  (first new code ${first})`);
        } else {
          console.log(`  employee counter   would be set to ${next}  (first new code ${first})`);
        }
      }
    }

    // ── letter reference numbers ─────────────────────────────────────────────
    const refRule = await ruleOf(HIRING_ENTITY);
    if (refRule) {
      console.log(`  letter references  rule ${refRule.code} exists (${refRule.status}) — left as it is`);
    } else if (APPLY) {
      const made = await createScheme(conn, company.id, null, {
        ...DEFAULT_RULES[HIRING_ENTITY],
        description: `Letter references: ${refPrefix}, the financial year and a running number that restarts each year. Set up by setup-codes.mjs.`,
        entityType: HIRING_ENTITY, targetField: 'code', seqScope: 'prefix', priority: 0, status: 'active', conditions: [],
        segments: [
          { segmentType: 'literal', literalText: refPrefix },
          { segmentType: 'token', tokenKey: 'fy' },
          { segmentType: 'literal', literalText: '/' },
          { segmentType: 'sequence', format: '000' },
        ],
      });
      console.log(`  letter references  rule ${made.code} created: ${refPrefix} + {fy} + / + 000`);
    } else {
      console.log(`  letter references  would create a rule: ${refPrefix} + {fy} + / + 000`);
    }

    if (APPLY) await conn.commit(); else await conn.rollback();
    console.log(APPLY ? '\n  done.\n' : '\n  nothing written. Run again with --apply.\n');
  } catch (e) {
    try { await conn.rollback(); } catch { /* the first error is the one that matters */ }
    throw e;
  } finally {
    await conn.end();
  }
}

// The provider import brings the app's own connection pool with it; it is never
// used here, so the process is ended explicitly rather than left waiting on it.
main().then(() => process.exit(0)).catch((e) => { console.error(`\n  FAILED: ${e.message}\n`); process.exit(1); });
