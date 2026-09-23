/**
 * Errors a person can act on. `fail()` (core/middleware/requirePerm.js) trusts
 * the status and message of these and passes `code`, `problems` and `detail`
 * through, so every rule a service enforces reaches the screen in words.
 */
export class CfError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    Object.assign(this, extra);
  }
}

export const invalid = (code, message, extra) => new CfError(422, code, message, extra);
export const notFound = (what) => new CfError(404, 'NOT_FOUND', `${what} not found.`);
export const conflict = (code, message, extra) => new CfError(409, code, message, extra);

/** Throws INVALID with every problem at once, instead of one per round trip. */
export function assertNoProblems(problems, message = 'Some fields need attention.') {
  if (problems.length) throw invalid('INVALID', message, { problems });
}

// The unique keys a person can actually hit, in their words. Keyed by index name.
const UNIQUE_MESSAGES = {
  uq_cmr_code: 'That code is already used by another item or definition.',
  uq_ccn_code: 'That classification code is already in use.',
  uq_ccn_sibling: 'A node with that name already exists at this level.',
  uq_csp_code: 'A specification with that code already exists.',
  uq_cso_value: 'That option already exists for this specification.',
  uq_cfm_code: 'A formula with that code already exists.',
  uq_csa_rule: 'This specification already has a rule here for that capture level.',
  uq_csao_pair: 'That option is already in the list.',
  uq_csv_value: 'This specification already has a value here.',
  uq_cdai_pair: 'That item is already on the allowed list.',
  uq_ccs_code: 'A coding rule with that code already exists.',
  uq_cbm_parent: 'This record already has a BOM.',
  uq_cbl_line_no: 'That line number is already used in this BOM.',
  uq_cbl_position: 'That position is already taken in this BOM — try again.',
  uq_csor_code: 'That order number is already used.',
  uq_cprl_line: 'This line is already released.',
  uq_cpo_code: 'That purchase order number is already used.',
  uq_cpo_suggest: 'There is already a suggested purchase order — it is rewritten rather than raised again.',
  uq_cpol_item: 'That item is already a line on this purchase order.',
  uq_csol_line_no: 'That line number is already used on this order.',
  uq_csol_position: 'That position is already taken on this order — try again.',
  uq_cpt_code: 'A party with that code already exists.',
  uq_cop_code: 'An operation with that code already exists.',
  uq_cof_code: 'A flow with that code already exists.',
  uq_cofs_operation: 'That operation is already a step of this flow — an operation appears once per flow.',
  uq_cswr_rule: 'This step already waits for that.',
  uq_cmc_code: 'A machine with that code already exists.',
  uq_comr_rule: 'There is already a rule for that machine type or machine starting on that date.',
  uq_csar_code: 'A stocking area with that code already exists.',
  uq_csb_code: 'That batch code is already used.',
  uq_csm_code: 'That document number is already used.',
};

/**
 * Turns a MySQL / TiDB constraint error into a CfError. Anything else comes
 * back unchanged and becomes a logged 500 with a generic message in fail().
 * Both engines name the key as `table.index` in newer versions and `index`
 * in older ones, so the table prefix is optional in the match.
 */
export function translateDbError(err) {
  if (!err || err instanceof CfError || err.status) return err;
  if (err.errno === 1062) {
    const key = /for key '(?:[^.']+\.)?([^']+)'/.exec(err.sqlMessage || '')?.[1];
    return conflict('DUPLICATE', UNIQUE_MESSAGES[key] || 'That value is already in use.', { detail: key });
  }
  if (err.errno === 1452) {
    return invalid('BAD_REFERENCE', 'A referenced record does not exist in this company.');
  }
  if (err.errno === 1451) {
    return conflict('IN_USE', 'This record is still referenced elsewhere.');
  }
  return err;
}
