/**
 * orderPriority.js — one answer to "which order comes first".
 *
 * WHY THIS EXISTS
 * ---------------
 * There were two implementations of that question — `planSuggestionService.
 * buildPriorityMap` and `dispatchService.compare` — and they already disagreed
 * about which signals mattered and in what order. Worse, BOTH ignored the one
 * field a user can actually see and set: `fab_orders.priority`. dispatchService's
 * own header said so outright — "free text, user-visible, read by no backend
 * code" — so a planner marking an order Critical changed nothing anywhere, and
 * the two fields that did drive the ranking (`priority_rank`, `must_finish_by`)
 * had no UI in the entire application. The planner looked like it ignored
 * priority because there was no way to give it any.
 *
 * THE ORDER, and why it is this order
 * ----------------------------------
 *   1. priority_rank    an explicit sequence somebody dragged into place. A
 *                       human who has literally numbered the orders outranks
 *                       every inference we could make from the data.
 *   2. priority         Critical > High > Medium > Low. The planner's judgement
 *                       about the job, which is a different statement from any
 *                       date on it: "this one matters" is not "this one is due".
 *   3. must_finish_by   the date declared non-compromisable, earliest first.
 *                       Below the enum deliberately — a Critical order outranks
 *                       a Low one even when the Low one is committed sooner,
 *                       because the whole point of marking something Critical is
 *                       to say so. Dates then sequence work WITHIN a band.
 *   4. slack            least first. The computed signal, and the last word only
 *                       when nobody has said anything.
 *
 * Point 3 is a CHANGE: `must_finish_by` used to outrank everything in the
 * suggestion engine. It is the one judgement call here, and it is the one to
 * revisit first if the shop's sequencing ever looks wrong.
 */

/** Critical first. Anything unrecognised sorts as "no opinion", behind Low. */
const PRIORITY_WEIGHT = new Map([
  ['critical', 0],
  ['high', 1],
  ['medium', 2],
  ['low', 3],
]);

const NONE = Number.POSITIVE_INFINITY;

/** The enum as a sortable number. Unset or unknown ⇒ behind everything named. */
export function priorityWeight(priority) {
  if (priority == null) return NONE;
  return PRIORITY_WEIGHT.get(String(priority).trim().toLowerCase()) ?? NONE;
}

/** The choices a UI should offer, in rank order. */
export const PRIORITY_LEVELS = ['critical', 'high', 'medium', 'low'];

/**
 * Compare two orders. `slackOf(orderId)` supplies the computed signal; pass a
 * function returning Infinity when slack is unknown.
 *
 * Each order needs `{ orderId, priorityRank, priority, mustFinishBy }`.
 */
export function compareOrders(a, b, slackOf) {
  const ra = a.priorityRank ?? NONE;
  const rb = b.priorityRank ?? NONE;
  if (ra !== rb) return ra - rb;

  const pa = priorityWeight(a.priority);
  const pb = priorityWeight(b.priority);
  if (pa !== pb) return pa - pb;

  const da = a.mustFinishBy ? new Date(a.mustFinishBy).getTime() : NONE;
  const db = b.mustFinishBy ? new Date(b.mustFinishBy).getTime() : NONE;
  if (da !== db) return da - db;

  const sa = slackOf(a.orderId);
  const sb = slackOf(b.orderId);
  if (sa !== sb) return sa - sb;

  return (a.orderId ?? 0) - (b.orderId ?? 0);
}

/** Why this order sits where it does, for a UI that has to explain the sequence. */
export function rankReason(order) {
  if (order.priorityRank != null) return `sequenced #${order.priorityRank}`;
  const w = priorityWeight(order.priority);
  if (w !== NONE) return String(order.priority).toLowerCase();
  if (order.mustFinishBy) return 'finish-by date';
  return 'least slack';
}
