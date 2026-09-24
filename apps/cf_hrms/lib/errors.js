/**
 * Errors a person can act on. `fail()` (core/middleware/requirePerm.js) trusts
 * the status and message of these and passes `code`, `problems` and `detail`
 * through, so every rule a service enforces reaches the screen in words.
 *
 * This matters more in cf_hrms than usual: TiDB runs no CHECK constraints, so a
 * large share of this app's rules live in services, and a rule the user cannot
 * read is a rule they will keep breaking.
 */
export class HrmsError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    Object.assign(this, extra);
  }
}

export const invalid = (code, message, extra) => new HrmsError(422, code, message, extra);
export const notFound = (what) => new HrmsError(404, 'NOT_FOUND', `${what} not found.`);
export const conflict = (code, message, extra) => new HrmsError(409, code, message, extra);
export const forbidden = (message) => new HrmsError(403, 'FORBIDDEN', message);

/** Throws INVALID with every problem at once, instead of one per round trip. */
export function assertNoProblems(problems, message = 'Some fields need attention.') {
  if (problems.length) throw invalid('INVALID', message, { problems });
}

// The unique keys a person can actually hit, in their words. Keyed by index name
// (see models/init.sql). Anything not listed here falls back to a generic
// message, which is a signal that the index deserves a sentence.
const UNIQUE_MESSAGES = {
  uq_hloc_code: 'A location with that code already exists.',
  uq_hdep_code: 'A department with that code already exists.',
  uq_hwct_code: 'A work context with that code already exists.',
  uq_hwct_name: 'A work context with that name already exists — machines are named once.',
  uq_hcon_code: 'A contractor with that code already exists.',
  uq_hcon_name: 'A contractor with that name already exists.',
  uq_hshf_code: 'A shift with that code already exists.',
  uq_hhol_day: 'That date is already a holiday for this location.',
  uq_hrrt_code: 'A reporting relationship type with that code already exists.',

  uq_hkrd_code: 'A KRA with that code already exists.',
  uq_hkrd_name: 'A KRA with that name already exists — assign the existing one instead.',
  uq_hrsd_code: 'A responsibility with that code already exists.',
  uq_hkpd_code: 'A KPI with that code already exists.',
  uq_hkpd_name: 'A KPI with that name already exists — assign the existing one instead.',
  uq_hskd_name: 'That skill is already in the catalogue.',
  uq_hqld_name: 'That qualification is already in the catalogue.',
  uq_hatd_name: 'That authority is already in the catalogue.',

  uq_hrol_code: 'A role with that code already exists.',
  uq_hrol_title: 'A role with that title already exists.',
  uq_hrka_pair: 'This role already has that KRA.',
  uq_hrra_pair: 'This role already has that responsibility.',
  uq_hrkp_pair: 'This role already has that KPI.',
  uq_hrsk_pair: 'This role already requires that skill.',
  uq_hrqr_pair: 'This role already requires that qualification.',
  uq_hrau_pair: 'This role already carries that authority.',

  uq_hpos_code: 'A position with that code already exists.',
  uq_hpwc_pair: 'That work context is already linked to this position.',
  uq_hprr_edge: 'That reporting line already exists between these two positions.',

  uq_hemp_code: 'An employee with that code already exists.',
  uq_hemp_user: 'That login is already linked to another employee.',
  uq_heid_value: 'That identifier is already recorded for this employee.',

  uq_hwac_pair: 'That work context is already linked to this assignment.',
  uq_harr_edge: 'That manager is already recorded for this assignment with that relationship type.',

  uq_hros_day: 'This assignment already has a roster entry for that date.',
  // The one people hit most, and the one whose meaning must be unmistakable.
  uq_hatr_day: 'Attendance for this person on this date and shift already exists. One person has one attendance row per day — record the second role as an attribution, not a second row.',

  uq_hlvt_code: 'A leave type with that code already exists.',
  uq_hlvb_period: 'This employee already has a balance for that leave type and period.',

  uq_hgdo_current: 'There is already a current document of that kind for this role, position or employee.',
};

/**
 * Turns a MySQL / TiDB constraint error into an HrmsError. Anything else comes
 * back unchanged and becomes a logged 500 with a generic message in fail().
 * Both engines name the key as `table.index` in newer versions and `index` in
 * older ones, so the table prefix is optional in the match.
 */
export function translateDbError(err) {
  if (!err || err instanceof HrmsError || err.status) return err;
  if (err.errno === 1062) {
    const key = /for key '(?:[^.']+\.)?([^']+)'/.exec(err.sqlMessage || '')?.[1];
    return conflict('DUPLICATE', UNIQUE_MESSAGES[key] || 'That value is already in use.', { detail: key });
  }
  if (err.errno === 1452) {
    // A composite FK on (company_id, x_id) fails this way when the reference
    // belongs to another company — which is the point of the composite key.
    return invalid('BAD_REFERENCE', 'A referenced record does not exist in this company.');
  }
  if (err.errno === 1451) {
    return conflict('IN_USE', 'This record is still referenced elsewhere. End or retire it instead of deleting it.');
  }
  return err;
}
