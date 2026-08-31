/**
 * actualsRunService.js — turning timestamps into the runs a board can draw.
 *
 * WHY THIS IS ITS OWN MODULE, AND PURE
 * ------------------------------------
 * Everything here is arithmetic on intervals. It is separated from
 * actualsBoardService because the one question it answers — "when was this unit
 * actually being worked on?" — is the only part of the Actuals Board that can be
 * wrong in a way nobody notices, and a pure module can be reasoned about (and
 * later tested) without a database.
 *
 * THE OVERSTATEMENT TRAP
 * ----------------------
 * A task started 16:00 Monday and completed 10:00 Tuesday did not run for
 * eighteen hours. It ran for two, then the shop went home, then it ran for two
 * more. Drawn as one solid bar from start to finish it claims a machine, an
 * evening and a night that were never spent on it.
 *
 * The planner already paid for this lesson once (`d0048b1`): a bundle stretched
 * across its whole span over-stated every finish, and the rule that came out of
 * it is that **understating is safe and overstating is not**. So every span here
 * is intersected with the plant's working intervals before it is allowed to
 * become a block, and the gaps that leaves are drawn as gaps.
 *
 * THE JOIN, AND WHY IT IS MEASURED IN WORKING TIME
 * ------------------------------------------------
 * Two runs of the same unit separated by a lunch break are one run to anybody
 * looking at the board; two separated by nine days are not. The threshold has to
 * be in WORKING minutes, or every overnight break would look like a nine-hour
 * stall and every unit would shatter into one run per day.
 *
 * Working time is not linear in wall-clock time, so the comparison is made
 * through a "work clock" — a prefix sum over the merged working intervals that
 * maps an instant to the number of working milliseconds before it. Distance in
 * that space is exactly "how much shop time went by", which is the question.
 */

/**
 * How long a hole has to be, in WORKING milliseconds, before a unit's bar breaks
 * in two.
 *
 * Two hours: long enough that a break, a tool change or a handover does not
 * shatter a girder into a dotted line, short enough that a shift spent on
 * something else shows up as the gap it is. The same class of knob as the
 * planner's TAIL_BUCKET_MIN — wrong in either direction it does not error, it
 * just quietly draws a different shop.
 */
export const RUN_JOIN_MIN = 120;
export const RUN_JOIN_MS = RUN_JOIN_MIN * 60 * 1000;

/**
 * Merge overlapping and touching [s, e) spans into a disjoint ascending list.
 * Numbers, not Dates — this runs over every task in a month.
 */
export function mergeSpans(spans) {
  if (spans.length === 0) return [];
  const sorted = spans.slice().sort((a, b) => a.s - b.s);
  const out = [{ s: sorted[0].s, e: sorted[0].e }];
  for (let i = 1; i < sorted.length; i += 1) {
    const last = out[out.length - 1];
    if (sorted[i].s <= last.e) {
      if (sorted[i].e > last.e) last.e = sorted[i].e;
    } else {
      out.push({ s: sorted[i].s, e: sorted[i].e });
    }
  }
  return out;
}

/**
 * The part of `span` that falls inside `working`.
 *
 * `working` must be disjoint and ascending (as `workingIntervalsInWindow`
 * returns it). Walks from a bisected starting point so clipping ten thousand
 * tasks against a month of shifts stays linear-ish rather than quadratic.
 */
export function clipToWorking(span, working) {
  if (!(span.e > span.s) || working.length === 0) return [];
  // First interval that could possibly end after the span starts.
  let lo = 0;
  let hi = working.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (working[mid].e <= span.s) lo = mid + 1;
    else hi = mid;
  }
  const out = [];
  for (let i = lo; i < working.length; i += 1) {
    const w = working[i];
    if (w.s >= span.e) break;
    const s = Math.max(span.s, w.s);
    const e = Math.min(span.e, w.e);
    if (e > s) out.push({ s, e });
  }
  return out;
}

/**
 * A function from instant → working milliseconds elapsed before it.
 *
 * This is what makes RUN_JOIN_MS mean "two hours of shop time" rather than "two
 * hours of clock". Built once per calendar per window; each call is a bisection.
 */
export function makeWorkClock(working) {
  const n = working.length;
  const starts = new Float64Array(n);
  const ends = new Float64Array(n);
  const before = new Float64Array(n + 1);
  for (let i = 0; i < n; i += 1) {
    starts[i] = working[i].s;
    ends[i] = working[i].e;
    before[i + 1] = before[i] + (working[i].e - working[i].s);
  }
  return (t) => {
    if (n === 0) return 0;
    if (t <= starts[0]) return 0;
    if (t >= ends[n - 1]) return before[n];
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= t) lo = mid;
      else hi = mid - 1;
    }
    // Inside interval `lo`, or in the dead time after it.
    return before[lo] + Math.max(0, Math.min(t, ends[lo]) - starts[lo]);
  };
}

/**
 * Merge already-clipped spans into the runs a unit's bar is drawn from.
 *
 * Two spans join when less than `joinMs` of WORKING time separates them. Each
 * run reports the spans that fed it so the caller can decide the run's status
 * from the tasks inside it.
 */
export function joinRuns(spans, workClock, joinMs = RUN_JOIN_MS) {
  const merged = [];
  const sorted = spans.slice().sort((a, b) => a.s - b.s);
  for (const sp of sorted) {
    const last = merged[merged.length - 1];
    if (last && (workClock(sp.s) - workClock(last.e)) <= joinMs && sp.s >= last.s) {
      if (sp.e > last.e) last.e = sp.e;
      last.parts.push(sp);
    } else {
      merged.push({ s: sp.s, e: sp.e, parts: [sp] });
    }
  }
  return merged;
}

/** Total milliseconds covered by a disjoint span list. */
export function spanMs(spans) {
  let t = 0;
  for (const s of spans) t += s.e - s.s;
  return t;
}

/**
 * Interval partitioning: give every unit the first lane that is free when it
 * starts, and open a new one only when none is.
 *
 * This is the classic minimum-lane result, which is exactly why it is the right
 * layout here rather than merely a compact one: **the number of lanes it needs
 * is the peak number of units the shop had open at once.** The row count on
 * screen is itself the answer to "how parallel were we running", and no separate
 * calculation can disagree with the picture.
 *
 * Packed on each unit's EXTENT, not on its runs. Packing on runs would let
 * another girder drop into this girder's idle fortnight and produce a denser
 * board — at the cost of scattering one unit across several rows, which throws
 * away the one reading this mode exists for: one row, one unit's story. The idle
 * stays visible as white inside the lane.
 *
 * @param {Array<{startRel:number,endRel:number}>} units  mutated: `laneIdx` set.
 * @returns {number} lanes used — peak concurrency.
 */
export function packLanes(units) {
  const order = units
    .map((u, i) => i)
    .sort((a, b) => (units[a].startRel - units[b].startRel)
      || (units[a].endRel - units[b].endRel));
  /** Last end in each lane. */
  const laneEnds = [];
  for (const i of order) {
    const u = units[i];
    let placed = -1;
    for (let l = 0; l < laneEnds.length; l += 1) {
      if (laneEnds[l] <= u.startRel) { placed = l; break; }
    }
    if (placed < 0) { placed = laneEnds.length; laneEnds.push(-Infinity); }
    laneEnds[placed] = u.endRel;
    u.laneIdx = placed;
  }
  return laneEnds.length;
}
