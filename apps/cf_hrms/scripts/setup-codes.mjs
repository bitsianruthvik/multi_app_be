/**
 * setup-codes.mjs — a company's code rules, for everything that has a code.
 * (TM/CF_HRMS_HIRING_SPEC.md §1.5 and §11.)
 *
 *   node setup-codes.mjs --company=karni                    DRY RUN — says what it would do
 *   node setup-codes.mjs --company=karni --apply
 *   node setup-codes.mjs --company=karni --apply --target=prod
 *
 *   --employee-prefix=KP      text in front of the employee number   (Karni: KP)
 *   --ref-prefix=KPPL/HR/     text in front of the letter reference  (Karni: KPPL/HR/)
 * Both are required for any company other than Karni.
 *   --department-prefix=D  --role-prefix=R  --position-prefix=P  --location-prefix=L
 * Optional; these are the defaults.
 *
 * WHAT IT CREATES, each only if the company has no rule of that kind yet:
 *   departments         D + 000                          D001
 *   roles               R + 000                          R001
 *   positions           P + 000                          P238
 *   locations           L + 00                           L01
 *   employees           <prefix> + 0000                  KP0072
 *   letter references   <prefix> + {fy} + / + 000        KPPL/HR/26-27/001
 * The rules are ordinary rules of the code generator (apps/cf_erp/modules/codegen)
 * and can be changed afterwards under Code formats.
 *
 * AND IT SETS EACH COUNTER. A company that already has records has codes —
 * Karni's employees are KP0001 to KP0071, its positions P001 to P237 — so the
 * next number must start after the highest one in use, not at 1. The issuing
 * function would get there by itself (it skips a code already in use), but 237
 * skipped numbers on the first new position is 237 wasted round trips, so the
 * counter is put where it belongs. It is only ever RAISED: a counter that goes
 * backwards re-issues codes.
 *
 * "The highest one in use" is the highest NUMBER among codes of the rule's own
 * shape: <prefix><number>, with or without a -<number> tail. Karni's positions
 * are P021-1, P021-2 ... P237-2, so P237-2 counts as 237 and the first new
 * position is P238 — not a P234 that would read as one of role P234's chairs.
 * A department coded P014 is not of the shape D<number> and moves nothing.
 * It is read from records that are not deleted; a deleted record's code is
 * still never issued again — the issuing function refuses it when the counter
 * reaches it.
 *
 * A rule that is no longer "<prefix> + number" is somebody's own: its counter
 * is left alone. Existing codes are never changed.
 *
 * Idempotent: a second run finds the rules and the counters and changes nothing.
 * Dry run by default. Local by default (scripts/dbTarget.mjs).
 */
import mysql from 'mysql2/promise';
import { resolveTarget, announce } from './dbTarget.mjs';
import { createScheme } from '../../cf_erp/modules/codegen/service.js';
import {
  EMPLOYEE_ENTITY, HIRING_ENTITY, DEPARTMENT_ENTITY, ROLE_ENTITY, POSITION_ENTITY, LOCATION_ENTITY,
} from '../services/codegenProvider.js';
import { DEFAULT_RULES, CODE_HOME } from '../services/codeService.js';

const args = process.argv.slice(2);
const arg = (n) => {
  const hit = args.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(hit.indexOf('=') + 1) : null;
};
const APPLY = args.includes('--apply');

const KNOWN = { karni: { employeePrefix: 'KP', refPrefix: 'KPPL/HR/' } };

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const pad = (n, zeros) => String(n).padStart(zeros.length, '0');

async function main() {
  const slug = arg('company');
  if (!slug) throw new Error('--company=<slug> is required');
  const employeePrefix = arg('employee-prefix') ?? KNOWN[slug]?.employeePrefix;
  const refPrefix = arg('ref-prefix') ?? KNOWN[slug]?.refPrefix;
  if (!employeePrefix || !refPrefix) throw new Error(`--employee-prefix= and --ref-prefix= are required for "${slug}"`);

  /** The rules of the shape <prefix> + number, in the order the screen lists them. */
  const SIMPLE = [
    { entityType: DEPARTMENT_ENTITY, label: 'departments', prefix: arg('department-prefix') ?? 'D', zeros: '000' },
    { entityType: ROLE_ENTITY, label: 'roles', prefix: arg('role-prefix') ?? 'R', zeros: '000' },
    { entityType: POSITION_ENTITY, label: 'positions', prefix: arg('position-prefix') ?? 'P', zeros: '000' },
    { entityType: LOCATION_ENTITY, label: 'locations', prefix: arg('location-prefix') ?? 'L', zeros: '00' },
    { entityType: EMPLOYEE_ENTITY, label: 'employees', prefix: employeePrefix, zeros: '0000' },
  ];

  const target = resolveTarget();
  announce(target);
  const conn = await mysql.createConnection(target.cfg);
  try {
    const [[company]] = await conn.query('SELECT id, name FROM companies WHERE slug = ? AND deleted_at IS NULL', [slug]);
    if (!company) throw new Error(`No company "${slug}".`);
    console.log(`  company: ${company.name} (${company.id})${APPLY ? '' : '   DRY RUN — nothing is written without --apply'}\n`);

    const ruleOf = async (entityType) => (await conn.query(
      `SELECT id, code, status, seq_scope FROM cf_code_schemes
        WHERE company_id = ? AND entity_type = ? AND target_field = 'code' AND deleted_at IS NULL ORDER BY id LIMIT 1`,
      [company.id, entityType],
    ))[0][0] ?? null;

    await conn.beginTransaction();

    for (const { entityType, label, prefix, zeros } of SIMPLE) {
      const { table, column } = CODE_HOME[entityType];
      const name = label.padEnd(18);

      // ── positions as "role code - number" (--position-by-role; user's choice for Karni, 2026-10-12) ──
      // P021-3 is the third position of role P021. One counter per role (seq_scope 'prefix'); the
      // issuing function steps past numbers already in use, so no counter needs setting here.
      if (entityType === POSITION_ENTITY && args.includes('--position-by-role')) {
        const existing = await ruleOf(entityType);
        if (existing) {
          console.log(`  ${name} rule ${existing.code} exists (${existing.status}) — left as it is\n`);
        } else if (APPLY) {
          const made = await createScheme(conn, company.id, null, {
            ...DEFAULT_RULES[entityType],
            description: 'Positions: the role\'s code, a dash and a running number per role. Set up by setup-codes.mjs.',
            entityType, targetField: 'code', seqScope: 'prefix', priority: 0, status: 'active', conditions: [],
            segments: [
              { segmentType: 'token', tokenKey: 'role.code' },
              { segmentType: 'literal', literalText: '-' },
              { segmentType: 'sequence', format: '0' },
            ],
          });
          console.log(`  ${name} rule ${made.code} created: {role.code} + - + running number per role\n`);
        } else {
          console.log(`  ${name} would create a rule: {role.code} + - + running number per role\n`);
        }
        continue;
      }

      // ── the rule ──────────────────────────────────────────────────────────
      let rule = await ruleOf(entityType);
      if (rule) {
        console.log(`  ${name} rule ${rule.code} exists (${rule.status}) — left as it is`);
      } else if (APPLY) {
        const made = await createScheme(conn, company.id, null, {
          ...DEFAULT_RULES[entityType],
          description: `${label[0].toUpperCase()}${label.slice(1)}: ${prefix} and a running number. Set up by setup-codes.mjs.`,
          entityType, targetField: 'code', seqScope: 'prefix', priority: 0, status: 'active', conditions: [],
          segments: [{ segmentType: 'literal', literalText: prefix }, { segmentType: 'sequence', format: zeros }],
        });
        rule = { id: made.id, code: made.code, seq_scope: 'prefix' };
        console.log(`  ${name} rule ${made.code} created: ${prefix} + ${zeros}`);
      } else {
        console.log(`  ${name} would create a rule: ${prefix} + ${zeros}`);
      }

      // ── the counter: after the highest number of that shape among live records ──
      const [codes] = await conn.query(`SELECT ${column} AS code FROM ${table} WHERE company_id = ? AND deleted_at IS NULL AND ${column} IS NOT NULL`, [company.id]);
      const shape = new RegExp(`^${esc(prefix)}(\\d+)(?:-\\d+)*$`, 'i');
      const used = codes.map((r) => shape.exec(String(r.code ?? '').trim())).filter(Boolean).map((m) => Number(m[1]));
      const highest = used.length ? Math.max(...used) : 0;
      const next = highest + 1;
      const found = `${codes.length} with a code, ${used.length} of the form ${prefix}<number>, highest ${used.length ? highest : 'none'}`;

      if (!rule) {
        console.log(`  ${''.padEnd(18)} ${found}\n  ${''.padEnd(18)} counter would start at ${next}  (first new code ${prefix}${pad(next, zeros)})\n`);
        continue;
      }
      const [segments] = await conn.query(
        'SELECT segment_type, literal_text, format FROM cf_code_scheme_segments WHERE company_id = ? AND scheme_id = ? AND deleted_at IS NULL ORDER BY sort_order, id',
        [company.id, rule.id],
      );
      const simple = segments.length === 2 && segments[0].segment_type === 'literal' && segments[1].segment_type === 'sequence'
        && String(segments[0].literal_text) === prefix;
      if (!simple) {
        console.log(`  ${''.padEnd(18)} the rule is not "${prefix} + number" — its counter is left to the rule's owner\n`);
        continue;
      }
      const width = segments[1].format && /^0+$/.test(segments[1].format) ? segments[1].format : '0';
      const key = rule.seq_scope === 'scheme' ? '' : prefix;
      const [[counter]] = await conn.query(
        'SELECT id, next_value FROM cf_code_sequences WHERE company_id = ? AND scheme_id = ? AND seq_key = ?',
        [company.id, rule.id, key],
      );
      const starts = Math.max(next, counter?.next_value ?? 0);
      const first = `${prefix}${pad(starts, width)}`;
      console.log(`  ${''.padEnd(18)} ${found}`);
      if (counter && counter.next_value >= next) {
        console.log(`  ${''.padEnd(18)} counter at ${counter.next_value} — unchanged  (first new code ${first})\n`);
      } else if (APPLY) {
        await conn.query(
          `INSERT INTO cf_code_sequences (company_id, scheme_id, seq_key, next_value) VALUES (?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE next_value = GREATEST(next_value, VALUES(next_value))`,
          [company.id, rule.id, key, next],
        );
        console.log(`  ${''.padEnd(18)} counter set to ${next}  (first new code ${first})\n`);
      } else {
        console.log(`  ${''.padEnd(18)} counter would be set to ${next}  (first new code ${first})\n`);
      }
    }

    // ── letter reference numbers: the number restarts each financial year, so there is no counter to place ──
    const refName = 'letter references'.padEnd(18);
    const refRule = await ruleOf(HIRING_ENTITY);
    if (refRule) {
      console.log(`  ${refName} rule ${refRule.code} exists (${refRule.status}) — left as it is`);
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
      console.log(`  ${refName} rule ${made.code} created: ${refPrefix} + {fy} + / + 000`);
    } else {
      console.log(`  ${refName} would create a rule: ${refPrefix} + {fy} + / + 000`);
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
