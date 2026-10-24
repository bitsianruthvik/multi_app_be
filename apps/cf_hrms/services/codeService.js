/**
 * codeService.js — the ONE place a code is issued: an employee's, a letter
 * reference, a department's, a role's, a position's, a location's.
 * (TM/CF_HRMS_HIRING_SPEC.md §1.4 and §11.)
 *
 * The rules of issue, the same for all six:
 *   - a code is issued by the server, inside the transaction that creates the
 *     record, and only then. The running number is taken with the caller's
 *     connection, so a create that rolls back gives its number back;
 *   - no client sends one and no endpoint changes one. The services that create
 *     these records do not read a code from a request body, on create or on
 *     update;
 *   - a company with no rule gets a default one the first time a code is
 *     needed (EMP0001; HR/26-27/001; D001; R001; P001; L01), so every screen
 *     works before anybody has opened Code formats;
 *   - a generated code that is already in use is skipped and the next number is
 *     tried, up to 50 times: a counter that starts behind the codes a company
 *     already has catches up by itself. A code that belonged to a deleted
 *     record counts as in use — a code is never handed out twice.
 *
 * The generator itself is apps/cf_erp/modules/codegen, reused by import. What
 * each record offers it is in ./codegenProvider.js and ./codegenOrgProvider.js.
 */
import { generate } from '../../cf_erp/modules/codegen/index.js';
import { createScheme } from '../../cf_erp/modules/codegen/service.js';
import {
  EMPLOYEE_ENTITY, HIRING_ENTITY, DEPARTMENT_ENTITY, ROLE_ENTITY, POSITION_ENTITY, LOCATION_ENTITY,
} from './codegenProvider.js';
import { invalid, conflict } from '../lib/errors.js';
import { ruleReader } from '../lib/batch.js';

const MAX_TRIES = 50;

const literalAndNumber = (text, zeros) => [
  { segmentType: 'literal', literalText: text },
  { segmentType: 'sequence', format: zeros },
];
const madeOnFirstUse = (what) => `Created automatically the first time ${what} was needed. Change it under Code formats.`;

/** The rule a company gets when it has none of its own. Spec §1.4 and §11. */
export const DEFAULT_RULES = {
  [EMPLOYEE_ENTITY]: {
    code: 'HRMS_EMPLOYEE', name: 'Employee codes', description: madeOnFirstUse('an employee code'),
    segments: literalAndNumber('EMP', '0000'),
  },
  [HIRING_ENTITY]: {
    code: 'HRMS_LETTER_REF', name: 'Letter reference numbers', description: madeOnFirstUse('a letter reference'),
    segments: [
      { segmentType: 'literal', literalText: 'HR/' },
      { segmentType: 'token', tokenKey: 'fy' },
      { segmentType: 'literal', literalText: '/' },
      { segmentType: 'sequence', format: '000' },
    ],
  },
  [DEPARTMENT_ENTITY]: {
    code: 'HRMS_DEPARTMENT', name: 'Org unit codes', description: madeOnFirstUse('an org unit code'),
    segments: literalAndNumber('D', '000'),
  },
  [ROLE_ENTITY]: {
    code: 'HRMS_ROLE', name: 'Role codes', description: madeOnFirstUse('a role code'),
    segments: literalAndNumber('R', '000'),
  },
  [POSITION_ENTITY]: {
    code: 'HRMS_POSITION', name: 'Position codes', description: madeOnFirstUse('a position code'),
    segments: literalAndNumber('P', '000'),
  },
  [LOCATION_ENTITY]: {
    code: 'HRMS_LOCATION', name: 'Location codes', description: madeOnFirstUse('a location code'),
    segments: literalAndNumber('L', '00'),
  },
};

/**
 * Where each kind of code lives. `max` is the column's width: a rule that would
 * print something longer is refused in words, not by a truncation error.
 */
export const CODE_HOME = {
  [EMPLOYEE_ENTITY]: { what: 'employee code', table: 'hrms_employees', column: 'employee_code', max: 50 },
  [HIRING_ENTITY]: { what: 'letter reference', table: 'hrms_hirings', column: 'ref_no', max: 100 },
  [DEPARTMENT_ENTITY]: { what: 'org unit code', table: 'hrms_departments', column: 'code', max: 50 },
  [ROLE_ENTITY]: { what: 'role code', table: 'hrms_roles', column: 'role_code', max: 50 },
  [POSITION_ENTITY]: { what: 'position code', table: 'hrms_positions', column: 'position_code', max: 50 },
  [LOCATION_ENTITY]: { what: 'location code', table: 'hrms_locations', column: 'code', max: 50 },
};

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

/** Is this code already somebody's? Deleted records count: a code is never handed out twice. */
async function isTaken(conn, companyId, entityType, code) {
  const { table, column } = CODE_HOME[entityType];
  const [[row]] = await conn.query(`SELECT id FROM ${table} WHERE company_id = ? AND LOWER(${column}) = LOWER(?) LIMIT 1`, [companyId, code]);
  return Boolean(row);
}

async function issue(connection, companyId, entityType, context) {
  // In a bulk run the company's code rules are read once, not once a row (lib/batch.js). The running
  // number is still taken from its table, under its lock, every time.
  const conn = ruleReader(connection);
  const { userId = null, ...draft } = context ?? {};
  const { what, max } = CODE_HOME[entityType];
  await ensureDefaultRule(conn, companyId, entityType, userId);
  let previous = null;
  for (let attempt = 0; attempt < MAX_TRIES; attempt += 1) {
    const out = await generate(conn, companyId, entityType, 'code', { draft }, { consume: true });
    if (!out) {
      throw invalid('NO_CODE_FORMAT', `No code format applies to this ${what}. Check the rules under Code formats.`);
    }
    if (out.text.length > max) {
      throw invalid('CODE_TOO_LONG', `The code format gives ${out.text}, which is longer than the ${max} characters ${/^[aeiou]/i.test(what) ? 'an' : 'a'} ${what} can hold. Shorten the format under Code formats.`);
    }
    if (!(await isTaken(connection, companyId, entityType, out.text))) return out.text;
    // No running number, or one that did not move the text: trying again gives the same code.
    if (out.number == null || out.text === previous) {
      throw conflict('CODE_IN_USE', `The code format gives ${out.text}, which is already in use. Add a running number to it under Code formats.`);
    }
    previous = out.text;
  }
  throw conflict('CODE_IN_USE', `The next ${MAX_TRIES} ${what}s are all in use. Check the running number under Code formats.`);
}

/**
 * The next employee code. Runs on the caller's connection, inside its
 * transaction.
 *
 * @param context { departmentId?, locationId?, roleId?, shiftId?, joiningDate?, employmentType?, userId? }
 *        where the person starts work — what a rule may print or test. All optional.
 */
export const issueEmployeeCode = (conn, companyId, context = {}) => issue(conn, companyId, EMPLOYEE_ENTITY, context);

/** The next letter reference number. @param context { letterDate?, departmentId?, locationId?, userId? } */
export const issueHiringRef = (conn, companyId, context = {}) => issue(conn, companyId, HIRING_ENTITY, context);

/** A new department's code. @param context { name?, type? (its label), parentId?, userId? } */
export const issueDepartmentCode = (conn, companyId, context = {}) => issue(conn, companyId, DEPARTMENT_ENTITY, context);

/** A new role's code. @param context { title?, defaultDepartmentId?, userId? } */
export const issueRoleCode = (conn, companyId, context = {}) => issue(conn, companyId, ROLE_ENTITY, context);

/**
 * A new position's code.
 * @param context { roleId?, departmentId?, locationId?, shiftId?, cardCode?, userId? } — `cardCode` only
 *        when the position is added next to an existing one (positionService.addSiblingPosition).
 */
export const issuePositionCode = (conn, companyId, context = {}) => issue(conn, companyId, POSITION_ENTITY, context);

/** A new location's code. @param context { name?, address?, userId? } */
export const issueLocationCode = (conn, companyId, context = {}) => issue(conn, companyId, LOCATION_ENTITY, context);

/**
 * A code a record ALREADY HOLDS elsewhere, for the retired workbook and import
 * scripts only — never reachable from a route. It is checked the way an issued
 * one is: not blank, not too long, nobody else's.
 */
export async function acceptImportedCode(conn, companyId, entityType, value) {
  const code = String(value ?? '').trim();
  if (!code) return null;
  const { what, max } = CODE_HOME[entityType];
  if (code.length > max) throw invalid('INVALID', `The ${what} ${code.slice(0, 20)}… is longer than ${max} characters.`);
  if (await isTaken(conn, companyId, entityType, code)) throw conflict('DUPLICATE', `The ${what} ${code} is already in use.`);
  return code;
}

export default {
  issueEmployeeCode, issueHiringRef, issueDepartmentCode, issueRoleCode, issuePositionCode, issueLocationCode,
  acceptImportedCode, ensureDefaultRule, DEFAULT_RULES, CODE_HOME,
};
