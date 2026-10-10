/**
 * codeService.js — the ONE place an employee code or a letter reference number
 * is issued. (TM/CF_HRMS_HIRING_SPEC.md §1.4.)
 *
 * The rules of issue:
 *   - a code is issued by the server, inside the transaction that creates the
 *     record, and only then. The running number is taken with the caller's
 *     connection, so a create that rolls back gives its number back;
 *   - no client sends one and no endpoint changes one. peopleService ignores an
 *     `employeeCode` in a request body on create and on update;
 *   - a company with no rule gets a default one the first time a code is
 *     needed (EMP0001; HR/26-27/001), so the flow works before anybody has
 *     opened Code formats;
 *   - a generated code that is already in use is skipped and the next number is
 *     tried, up to 50 times: a counter that starts behind the codes a company
 *     already has catches up by itself. A code that belonged to a deleted
 *     record counts as in use — a code is never handed out twice.
 *
 * The generator itself is apps/cf_erp/modules/codegen, reused by import. What
 * an employee or a hiring offers it is in ./codegenProvider.js.
 */
import { generate } from '../../cf_erp/modules/codegen/index.js';
import { createScheme } from '../../cf_erp/modules/codegen/service.js';
import { EMPLOYEE_ENTITY, HIRING_ENTITY } from './codegenProvider.js';
import { invalid, conflict } from '../lib/errors.js';

const MAX_TRIES = 50;

/** The rule a company gets when it has none of its own. Spec §1.4. */
export const DEFAULT_RULES = {
  [EMPLOYEE_ENTITY]: {
    code: 'HRMS_EMPLOYEE',
    name: 'Employee codes',
    description: 'Created automatically the first time an employee code was needed. Change it under Code formats.',
    segments: [
      { segmentType: 'literal', literalText: 'EMP' },
      { segmentType: 'sequence', format: '0000' },
    ],
  },
  [HIRING_ENTITY]: {
    code: 'HRMS_LETTER_REF',
    name: 'Letter reference numbers',
    description: 'Created automatically the first time a letter reference was needed. Change it under Code formats.',
    segments: [
      { segmentType: 'literal', literalText: 'HR/' },
      { segmentType: 'token', tokenKey: 'fy' },
      { segmentType: 'literal', literalText: '/' },
      { segmentType: 'sequence', format: '000' },
    ],
  },
};

const WHAT = { [EMPLOYEE_ENTITY]: 'employee code', [HIRING_ENTITY]: 'letter reference' };

/**
 * Creates the default rule when the company has NO rule of this kind at all —
 * an inactive rule is still a rule somebody wrote, and is left to them.
 * Returns the id of the rule it created, or null.
 */
export async function ensureDefaultRule(conn, companyId, entityType, userId = null) {
  const [[have]] = await conn.query(
    `SELECT id FROM cf_code_schemes
      WHERE company_id = ? AND entity_type = ? AND target_field = 'code' AND deleted_at IS NULL LIMIT 1`,
    [companyId, entityType],
  );
  if (have) return null;
  const rule = DEFAULT_RULES[entityType];
  try {
    const made = await createScheme(conn, companyId, userId, {
      ...rule, entityType, targetField: 'code', seqScope: 'prefix', priority: 0, status: 'active', conditions: [],
    });
    return made.id;
  } catch (err) {
    // Two first codes at the same moment: the other request made the rule.
    if (err?.errno === 1062) return null;
    throw err;
  }
}

async function issue(conn, companyId, entityType, draft, isTaken, userId) {
  await ensureDefaultRule(conn, companyId, entityType, userId);
  let previous = null;
  for (let attempt = 0; attempt < MAX_TRIES; attempt += 1) {
    const out = await generate(conn, companyId, entityType, 'code', { draft }, { consume: true });
    if (!out) {
      throw invalid('NO_CODE_FORMAT', `No code format applies to this ${WHAT[entityType]}. Check the rules under Code formats.`);
    }
    if (!(await isTaken(out.text))) return out.text;
    // No running number, or one that did not move the text: trying again gives the same code.
    if (out.number == null || out.text === previous) {
      throw conflict('CODE_IN_USE', `The code format gives ${out.text}, which is already in use. Add a running number to it under Code formats.`);
    }
    previous = out.text;
  }
  throw conflict('CODE_IN_USE', `The next ${MAX_TRIES} ${WHAT[entityType]}s are all in use. Check the running number under Code formats.`);
}

/**
 * The next employee code. Runs on the caller's connection, inside its
 * transaction.
 *
 * @param context { departmentId?, locationId?, roleId?, shiftId?, joiningDate?, employmentType?, userId? }
 *        where the person starts work — what a rule may print or test. All optional.
 */
export async function issueEmployeeCode(conn, companyId, context = {}) {
  const { userId = null, ...draft } = context ?? {};
  return issue(conn, companyId, EMPLOYEE_ENTITY, draft, async (code) => {
    const [[row]] = await conn.query(
      'SELECT id FROM hrms_employees WHERE company_id = ? AND LOWER(employee_code) = LOWER(?) LIMIT 1',
      [companyId, code],
    );
    return Boolean(row);
  }, userId);
}

/**
 * The next letter reference number. Same rules as an employee code.
 *
 * @param context { letterDate?, departmentId?, locationId?, userId? }
 */
export async function issueHiringRef(conn, companyId, context = {}) {
  const { userId = null, ...draft } = context ?? {};
  return issue(conn, companyId, HIRING_ENTITY, draft, async (ref) => {
    const [[row]] = await conn.query(
      'SELECT id FROM hrms_hirings WHERE company_id = ? AND LOWER(ref_no) = LOWER(?) LIMIT 1',
      [companyId, ref],
    );
    return Boolean(row);
  }, userId);
}

export default { issueEmployeeCode, issueHiringRef, ensureDefaultRule, DEFAULT_RULES };
