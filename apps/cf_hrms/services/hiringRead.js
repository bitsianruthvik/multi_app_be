/**
 * hiringRead.js — the OPEN hiring on a position, for the reads and the one rule
 * that other services need. (TM/CF_HRMS_HIRING_SPEC.md §2.5.)
 *
 * The chart, the position card, the Positions list and the Departments screen
 * each show, on a vacant position, that somebody is being hired for it; and
 * assignmentService must refuse to put an existing employee into a position
 * while a hiring is open on it. All of them ask here.
 *
 * It is its own small file — importing nothing from the other services — so
 * positionService, orgChartService and assignmentService can use it without
 * importing hiringService, which imports all three.
 *
 * ONE QUERY, whatever the size of the company: never one per position (a round
 * trip to production costs ~49 ms and Karni has 220 positions).
 */
import { conflict } from '../lib/errors.js';

/** A hiring in one of these is open; DONE and CLOSED are finished. */
export const OPEN_STAGES = ['JD', 'OFFER', 'APPOINTMENT'];

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const dayText = (v) => {
  if (!v) return null;
  const s = v instanceof Date
    ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`
    : String(v).slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : null;
};

/**
 * One short line for a row: where the hiring stands and what it waits for.
 * The ONE wording — the list, the detail and every position read print this.
 *
 * @param h a row with stage, candidate_name, close_reason, has_offer_letter,
 *          joining_date and (when DONE) employee_code
 * @param today YYYY-MM-DD, to tell "joined" from "joins on"
 */
export function statusLineOf(h, today = null) {
  const name = h.candidate_name ? String(h.candidate_name).trim() : '';
  switch (h.stage) {
    case 'JD':
      return 'Job description to confirm';
    case 'OFFER':
      if (!name) return 'Candidate details to enter';
      return h.has_offer_letter ? `Offer sent to ${name}` : `Offer letter to generate for ${name}`;
    case 'APPOINTMENT':
      return `Offer accepted by ${name || 'the candidate'}`;
    case 'DONE': {
      const joining = h.joining_date ? String(h.joining_date instanceof Date ? dayIso(h.joining_date) : h.joining_date).slice(0, 10) : null;
      if (joining && today && joining > today) return `${name || 'The candidate'} joins on ${dayText(joining)}`;
      return `${name || 'The candidate'} appointed${h.employee_code ? ` as ${h.employee_code}` : ''}`;
    }
    case 'CLOSED':
      return closedLine(h.close_reason, name);
    default:
      return '';
  }
}

function dayIso(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/* ── why a hiring was closed (spec §3.4) ─────────────────────────────────────
 * Fourteen reasons in two groups, most likely first. `applies` says at which
 * point of a hiring a reason makes sense — nobody "declined the offer" before
 * an offer letter exists — and `next` what the screen offers straight after:
 *   REHIRE           start a new hiring for the position
 *   MOVE_EMPLOYEE    move an existing employee here
 *   REMOVE_POSITION  the remove dialog
 *   null             nothing
 * `line` is the hiring's status line once closed, with the candidate's name.
 *
 * What `applies` reads off a hiring row: has_offer_letter, candidate_name, stage.
 */
const named = (h) => Boolean(h.candidate_name && String(h.candidate_name).trim());
const offered = (h) => Boolean(h.has_offer_letter);
const fromOffer = (h) => h.stage === 'OFFER' || h.stage === 'APPOINTMENT';
const anyTime = () => true;
const who = (name) => name || 'The candidate';

export const CLOSE_REASON_GROUPS = [
  {
    label: 'The candidate',
    reasons: [
      { code: 'OFFER_DECLINED', label: 'Candidate declined the offer', hint: 'They said no to the offer letter.', noteRequired: false, next: 'REHIRE', applies: offered, line: (n) => `${who(n)} declined the offer` },
      { code: 'NO_RESPONSE', label: 'Candidate did not reply; the offer lapsed', hint: 'The offer passed its valid-until date without an answer.', noteRequired: false, next: 'REHIRE', applies: offered, line: (n) => `${who(n)} did not reply; the offer lapsed` },
      { code: 'DID_NOT_JOIN', label: 'Candidate accepted but did not join', hint: 'They accepted the offer and then did not turn up.', noteRequired: false, next: 'REHIRE', applies: (h) => h.stage === 'APPOINTMENT', line: (n) => `${who(n)} accepted but did not join` },
      { code: 'PAY_NOT_AGREED', label: 'Could not agree on pay', hint: 'The pay we could offer and the pay they wanted did not meet.', noteRequired: false, next: 'REHIRE', applies: fromOffer, line: (n) => (n ? `Could not agree on pay with ${n}` : 'Could not agree on pay') },
      { code: 'STAYED_WITH_EMPLOYER', label: 'Candidate stayed with their current employer', hint: 'Their employer kept them, with or without a counter-offer.', noteRequired: false, next: 'REHIRE', applies: fromOffer, line: (n) => `${who(n)} stayed with their current employer` },
      { code: 'CANDIDATE_WITHDREW', label: 'Candidate withdrew before an offer was made', hint: 'They pulled out before any offer letter went to them.', noteRequired: false, next: 'REHIRE', applies: (h) => named(h) && !offered(h), line: (n) => `${who(n)} withdrew before an offer was made` },
      { code: 'CHECKS_FAILED', label: 'Documents or background check did not clear', hint: 'Their papers or references did not check out.', noteRequired: false, next: 'REHIRE', applies: named, line: (n) => `${who(n)}: documents or background check did not clear` },
    ],
  },
  {
    label: 'The company',
    reasons: [
      { code: 'ANOTHER_CANDIDATE', label: 'We chose another candidate', hint: 'Someone else is being hired for this position.', noteRequired: false, next: 'REHIRE', applies: named, line: () => 'Closed: we chose another candidate' },
      { code: 'FILLED_INTERNALLY', label: 'An existing employee will take the position', hint: 'The position will be filled by moving someone who already works here.', noteRequired: false, next: 'MOVE_EMPLOYEE', applies: anyTime, line: () => 'Closed: an existing employee will take the position' },
      { code: 'ON_HOLD', label: 'Hiring is on hold for now', hint: 'The position stays; nobody is being hired for it for the moment.', noteRequired: false, next: null, applies: anyTime, line: () => 'Hiring is on hold for now' },
      { code: 'NOT_NEEDED', label: 'The position is no longer needed', hint: 'Nobody will be hired. You can remove the position next.', noteRequired: false, next: 'REMOVE_POSITION', applies: anyTime, line: () => 'Closed: the position is no longer needed' },
      { code: 'OFFER_WITHDRAWN', label: 'We withdrew the offer', hint: 'The company took the offer back. Say why in the note.', noteRequired: true, next: 'REHIRE', applies: offered, line: (n) => (n ? `We withdrew the offer to ${n}` : 'We withdrew the offer') },
      { code: 'STARTED_BY_MISTAKE', label: 'Started by mistake', hint: 'This hiring should not have been started.', noteRequired: false, next: null, applies: anyTime, line: () => 'Closed: started by mistake' },
      { code: 'OTHER', label: 'Something else', hint: 'None of the above. Say what happened in the note.', noteRequired: true, next: null, applies: anyTime, line: () => 'Hiring closed' },
    ],
  },
];

/** The three codes of the first release, and what each is now. Read as the new one; still taken on a write for one release. */
export const LEGACY_CLOSE_REASONS = { DECLINED: 'OFFER_DECLINED', LAPSED: 'NO_RESPONSE', CANCELLED: 'OTHER' };

/** A stored or sent code as today's code. */
export const closeReasonCode = (code) => (code == null ? null : LEGACY_CLOSE_REASONS[code] ?? code);
export const closeReasonOf = (code) => CLOSE_REASON_GROUPS.flatMap((g) => g.reasons).find((r) => r.code === closeReasonCode(code)) ?? null;
export const closeReasonLabel = (code) => closeReasonOf(code)?.label ?? null;
function closedLine(code, name) {
  return closeReasonOf(code)?.line(name) ?? 'Hiring closed';
}

/**
 * The reasons that apply to a hiring as it stands (or all of them, with no
 * hiring), in the shape GET /hiring/close-reasons returns. A group with nothing
 * left is dropped.
 */
export function closeReasonsFor(h = null) {
  return CLOSE_REASON_GROUPS
    .map((g) => ({
      label: g.label,
      reasons: g.reasons.filter((r) => !h || r.applies(h)).map(({ code, label, hint, noteRequired, next }) => ({ code, label, hint, noteRequired, next })),
    }))
    .filter((g) => g.reasons.length);
}

/** What a position read carries about its open hiring. Spec §2.5 — exactly these four fields. */
export const shapePositionHiring = (h) => ({
  id: h.id,
  stage: h.stage,
  candidateName: h.candidate_name ?? null,
  statusLine: statusLineOf(h),
});

/**
 * The open hiring of every position that has one (or of one position).
 *
 * @returns {Map<number, { id, stage, candidateName, statusLine }>} position id -> its open hiring
 */
export async function openHiringsByPosition(db, companyId, positionId = null) {
  const [rows] = await db.query(
    `SELECT h.id, h.position_id, h.stage, h.candidate_name, h.close_reason, l.id AS has_offer_letter
       FROM hrms_hirings h
       LEFT JOIN hrms_hiring_letters l
              ON l.company_id = h.company_id AND l.hiring_id = h.id
             AND l.kind = 'OFFER' AND l.is_current = 1 AND l.deleted_at IS NULL
      WHERE h.company_id = ? AND h.deleted_at IS NULL AND h.stage IN (?)${positionId == null ? '' : ' AND h.position_id = ?'}`,
    positionId == null ? [companyId, OPEN_STAGES] : [companyId, OPEN_STAGES, positionId],
  );
  return new Map(rows.map((h) => [h.position_id, shapePositionHiring(h)]));
}

/**
 * "Move an existing employee here" is refused while a hiring is open on the
 * position: two ways of filling one chair at once ends with two people
 * promised it. Cancel the hiring first.
 *
 * `exceptHiringId` is the hiring that is itself doing the appointing.
 */
export async function assertNoOpenHiring(db, companyId, positionId, { exceptHiringId = null } = {}) {
  if (positionId == null) return;
  const open = (await openHiringsByPosition(db, companyId, positionId)).get(Number(positionId));
  if (!open || open.id === exceptHiringId) return;
  throw conflict(
    'HIRING_OPEN',
    `A hiring is open on this position: ${open.statusLine}. Close that hiring before moving someone else here.`,
    { existing: { id: open.id, stage: open.stage }, detail: { hiringId: open.id, positionId: Number(positionId) } },
  );
}

/* ── the person due to join ──────────────────────────────────────────────────
 * A person appointed from a future date holds nothing yet: by the one-chair rule
 * (seatCount.js) the position is vacant until that morning. But it is promised,
 * and a screen that says plain "Vacant" invites a hiring the server refuses. So
 * the same reads that carry `hiring` carry `joining`:
 *
 *   { employeeId, employeeCode, name, date }   date = YYYY-MM-DD, the day they start
 *
 * = the assignment on the position that is not deleted, not ENDED and NOT YET IN
 * DATE on the day asked about — the earliest, if bad data holds several. Counts
 * do not move: the position stays vacant until the date.
 *
 * It is not a separate read. A caller widens the occupants query it already
 * makes from "in date" to "not over yet" (COMING_OR_LIVE_SQL) and splits the
 * rows here.
 */

/** In place of LIVE_ON on an occupants query: live on the date OR starting after it. One `?` (the date). */
export const COMING_OR_LIVE_SQL = (wa = 'wa') => `(${wa}.effective_to IS NULL OR ${wa}.effective_to >= ?)`;

const isoDay = (v) => (v == null ? null : (v instanceof Date ? dayIso(v) : String(v).slice(0, 10)));

/** True for a row that starts after `on`. */
export const startsAfter = (row, on) => { const from = isoDay(row.effective_from); return from != null && from > on; };

export const shapeJoining = (r) => ({
  employeeId: r.employee_id,
  employeeCode: r.employee_code ?? null,
  name: r.full_name,
  date: isoDay(r.effective_from),
});

/**
 * Splits occupant rows (each with position_id, employee_id, employee_code,
 * full_name, effective_from) into who is IN each position on the date and who
 * is due to join it.
 * @returns {{ live: Array, joining: Map<number, { employeeId, employeeCode, name, date }> }}
 */
export function splitComing(rows, on) {
  const live = [];
  const coming = new Map();
  for (const r of rows) {
    if (!startsAfter(r, on)) { live.push(r); continue; }
    const had = coming.get(r.position_id);
    if (!had || isoDay(r.effective_from) < isoDay(had.effective_from)
      || (isoDay(r.effective_from) === isoDay(had.effective_from) && (r.assignment_id ?? r.id ?? 0) < (had.assignment_id ?? had.id ?? 0))) coming.set(r.position_id, r);
  }
  return { live, joining: new Map([...coming].map(([positionId, r]) => [positionId, shapeJoining(r)])) };
}

export default {
  OPEN_STAGES, statusLineOf, shapePositionHiring, openHiringsByPosition, assertNoOpenHiring,
  COMING_OR_LIVE_SQL, startsAfter, shapeJoining, splitComing, dayText,
  CLOSE_REASON_GROUPS, LEGACY_CLOSE_REASONS, closeReasonCode, closeReasonOf, closeReasonLabel, closeReasonsFor,
};
