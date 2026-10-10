/**
 * Org_Chart_V28.html  ->  CF_HRMS
 *
 * The migration described in TM/CF_HRMS_PLAN.md §9. This is a SCRIPT, not the
 * product feature: routes/imports.js (Phase 8) will do the same work behind a
 * parse -> validate -> commit UI. The logic here is meant to be lifted into
 * importService.js, so it is written in that shape: plan() reads the file and
 * decides everything, commit() only writes what plan() decided. --dry-run stops
 * between the two and prints the identical report.
 *
 * THE IMPORT IS AN INVERSION, NOT A COPY. The source is position-shaped with
 * people embedded inside position rows; the target is assignment-shaped. The
 * rules that matter, all measured against the real file:
 *
 *   1. A machine is never a manager. 47 nodes hang directly under one. Their
 *      formal manager is the nearest non-machine ancestor. The machine itself
 *      is a DEPARTMENT (2026-10-10): everything the chart draws that is not a
 *      seat is a department or a sub-department, and a seat has exactly one.
 *      hrms_work_contexts is no longer written.
 *   2. Only 71 of the 83 `people` rows are people. The other 12 have a blank
 *      name — they are seat markers the client used to record a shift and an
 *      attendance state for an unfilled seat. Importing them would create 12
 *      employees named "".
 *   3. `kras[]` are task statements, not Key Result Areas. They import as
 *      Responsibilities. Promoting them to KRAs would corrupt the one
 *      distinction the whole model is built on. At 1,363 lines this matters
 *      more than it did at 595.
 *   4. `dtype` marks a seat that ALSO heads a department or a section. It is
 *      still a job — it has people, headcount and responsibilities. The flag
 *      says everything beneath it belongs to that unit until a deeper unit
 *      takes over, which is how every position gets a department.
 *
 * WHAT V28 ADDED over V12, and what was done with it:
 *   dept / dtype  -> hrms_departments + positions.department_id. Machines and
 *                    shared crews are departments too; a shared one says which
 *                    departments it serves in hrms_department_serves.
 *   kpis[]        -> hrms_kpi_definitions + hrms_role_kpi_assignments (the path
 *                    existed and had never been exercised; V12 held zero KPIs)
 *   ttl           -> NOT written. See the finding: there is no salutation column,
 *                    gender is the wrong column, and a name is not an address.
 *   sal/band/cat  -> NOT written. Payroll is out of V1 by the user's decision;
 *                    counted in the findings so nothing is silently dropped.
 *   meta.letter   -> recorded on the import run only; no table owns a letter's
 *                    effective date or signatory yet.
 *
 * ADJUSTMENTS. Some things about an organisation are true and not in the chart:
 * one box drawn for three machines, a crew two machines share, a seat marked
 * shared that is not. Those are a person's decisions, and they live in an
 * optional file beside the chart (`<chart>.adjustments.json`, see
 * orgChartSource.mjs) — never in this script, which must stay a general tool.
 * Three kinds: `split` a machine node into several named departments;
 * `shared` — these seats are a crew serving these departments; `notShared` —
 * this seat sits in its own department whatever the chart marks. Every entry
 * carries a reason, who decided and when. An entry naming a node the chart no
 * longer has STOPS the import: a new revision must not silently drop a decision.
 *
 * KRAs. The chart's `kras[]` lines are tasks and import as responsibilities
 * (rule 3). The outcome areas they belong under are written by a person and
 * kept in a second optional file beside the chart (`<chart>.kras.json`): per
 * role, its KRAs in order, and under each the responsibilities (by text) and
 * KPIs (by name) it holds. KRAs are set per ROLE — two roles may both have a
 * "Quality" and they are unrelated. This script only GROUPS: it never rewords,
 * merges or drops a line. Unlike an adjustment, a KRA entry the chart no
 * longer has does NOT stop the import — a chart revision adds and removes
 * duties all the time — it is reported as stale; a line the file does not
 * place is imported ungrouped and counted as needing a KRA. A malformed file
 * (one line under two KRAs, a KRA named twice in a role) does stop it.
 *
 * PURPOSE. The same file carries each role's `purpose` — one sentence saying
 * why the role exists, the opening line of its job description — and it is
 * written to hrms_roles.role_purpose verbatim. The chart holds none. A role
 * with no duties still has an entry (its `kras` is empty) and a purpose
 * marked `purposeBasis: "title only"`. --no-kras leaves every purpose empty.
 *
 * Usage:
 *   node import-org-chart.mjs --company=karni [--dry-run] [--wipe] [--source=<path>]
 *                             [--adjustments=<path> | --no-adjustments]
 *                             [--kras=<path> | --no-kras]
 *
 * --dry-run prints the validation report and writes nothing.
 * --wipe clears this company's hrms_ rows first (local development only).
 */
import mysql from 'mysql2/promise';
import { resolveTarget, announce } from './dbTarget.mjs';
import { resolveSource, readSeed, PREVIOUS_FILE_NAME, resolveAdjustments, readAdjustments, resolveKras, readKras } from './orgChartSource.mjs';

const TARGET = resolveTarget();

const args = process.argv.slice(2);
const arg = (n, d) => (args.find((a) => a.startsWith(`--${n}=`)) || `--${n}=${d}`).split('=')[1];
const has = (n) => args.includes(`--${n}`);
const COMPANY_SLUG = arg('company', 'karni');
const DRY = has('dry-run');
const WIPE = has('wipe');

const norm = (s) => String(s ?? '').trim().replace(/\s+/g, ' ');
const normKey = (s) => norm(s).toLowerCase().replace(/[.;,]+$/, '');
/** NOW() as the database sees it, as text — the clock its own created_at uses. */
const dbNow = async (conn) => (await conn.query("SELECT DATE_FORMAT(NOW(), '%Y-%m-%d %H:%i:%s') AS t"))[0][0].t;
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 3)}...` : s);

/** Set once rows start being written, so a crash can record a FAILED run. */
let RUN_CONTEXT = null;

// =========================================================== PLAN =========
// Everything the file means, decided before a single row is written.

function plan(seed, prev, adj = null, kraFile = null) {
  const findings = [];
  const note = (kind, detail) => findings.push({ kind, detail });
  const counts = {};

  const nodes = seed.positions;
  const byId = new Map(nodes.map((p) => [p.id, p]));
  const chartDate = seed.meta?.date || '2026-09-30';
  const machines = nodes.filter((p) => p.kind === 'machine');
  const real = nodes.filter((p) => p.kind !== 'machine');   // role + shared = a position

  // ---- 0. Adjustments: read, checked against THIS chart, before anything else
  // Every problem is collected and reported at once, and any problem is fatal.
  const adjEntries = adj?.entries ?? [];
  const adjProblems = [];
  const who = (a, i) => `adjustment ${i + 1} (${a?.kind ?? 'no kind'})`;
  const splitOf = new Map();                  // machine node id -> { names, entry }
  const adjShared = [];                       // { seats, serves, name, entry }
  const adjNotShared = new Map();             // seat id -> entry
  if (adj?.forSource && adj.forSource !== adj.sourceFileName) {
    adjProblems.push(`${adj.fileName} says it is for "${adj.forSource}" but the chart being imported is "${adj.sourceFileName}". Decisions made about one revision are not carried to another by accident: review them and update "forSource".`);
  }
  adjEntries.forEach((a, i) => {
    for (const k of ['reason', 'decidedBy', 'decidedOn']) if (!norm(a?.[k])) adjProblems.push(`${who(a, i)} has no "${k}". Every decision says why, who and when.`);
    if (a?.kind === 'split') {
      const n = byId.get(a.node);
      const names = Array.isArray(a.into) ? a.into.map(norm) : [];
      if (!n) adjProblems.push(`${who(a, i)} splits node "${a.node}", which this chart does not have.`);
      else if (n.kind !== 'machine') adjProblems.push(`${who(a, i)} splits ${a.node} "${norm(n.title)}", which is a seat, not a machine or area.`);
      if (names.length < 2 || names.some((x) => !x)) adjProblems.push(`${who(a, i)}: "into" must name two or more departments.`);
      if (new Set(names.map(normKey)).size !== names.length) adjProblems.push(`${who(a, i)}: "into" names the same department twice.`);
      if (splitOf.has(a.node)) adjProblems.push(`${who(a, i)}: ${a.node} is split twice.`);
      splitOf.set(a.node, { names, entry: a });
    } else if (a?.kind === 'shared') {
      const seats = Array.isArray(a.seats) ? a.seats : [];
      const serves = Array.isArray(a.serves) ? a.serves : [];
      if (!seats.length) adjProblems.push(`${who(a, i)} names no seats.`);
      for (const id of seats) {
        const n = byId.get(id);
        if (!n) adjProblems.push(`${who(a, i)} names seat "${id}", which this chart does not have.`);
        else if (n.kind === 'machine') adjProblems.push(`${who(a, i)} names ${id} "${norm(n.title)}" as a seat; it is a machine.`);
        if (adjShared.some((o) => o.seats.includes(id))) adjProblems.push(`${who(a, i)}: seat ${id} is already placed by an earlier shared adjustment.`);
      }
      if (new Set(serves).size < 2) adjProblems.push(`${who(a, i)}: a shared department serves two or more departments.`);
      adjShared.push({ seats, serves: [...new Set(serves)], name: norm(a.name) || null, entry: a });
    } else if (a?.kind === 'notShared') {
      const n = byId.get(a.seat);
      if (!n) adjProblems.push(`${who(a, i)} names seat "${a.seat}", which this chart does not have.`);
      else if (n.kind !== 'shared') adjProblems.push(`${who(a, i)}: ${a.seat} "${norm(n.title)}" is not marked shared in this chart, so there is nothing to undo.`);
      if (adjShared.some((o) => o.seats.includes(a.seat))) adjProblems.push(`${who(a, i)}: seat ${a.seat} is also placed by a shared adjustment.`);
      adjNotShared.set(a.seat, a);
    } else {
      adjProblems.push(`${who(a, i)}: unknown kind. Known kinds are split, shared, notShared.`);
    }
  });
  const failAdjustments = () => {
    if (!adjProblems.length) return;
    throw new Error(`The adjustments file does not fit this chart — nothing was imported.\n  - ${adjProblems.join('\n  - ')}\n`
      + `Fix ${adj.file}, or run with --no-adjustments to import the chart alone.`);
  };
  failAdjustments();
  counts.adjustments = adjEntries.length;

  counts.sourceNodes = nodes.length;
  counts.sourceRoleNodes = nodes.filter((p) => p.kind === 'role').length;
  counts.sourceSharedNodes = nodes.filter((p) => p.kind === 'shared').length;
  counts.sourceMachineNodes = machines.length;

  /**
   * The two ancestor walks, reproduced from the source tool (`managerOf` /
   * `machinesOf`) including their cycle guards. `contextsOf` no longer feeds
   * anything that is written — machines are departments now (section 1) — and
   * survives only to word a split role's qualifier in section 3 the way it has
   * always been worded, so role titles do not move when the model does.
   *
   * One deliberate difference. The tool collects machines only while the ancestor
   * is itself a machine, which loses the context of a node sitting under a SHARED
   * node that sits under a machine — the "Asst Op 1 & 2 & 3 (Shared between 3
   * machines)" seat ends up with no machines at all, though its title says
   * otherwise. Here the context walk continues through `shared` nodes and stops
   * at the first `role`, so those positions keep the machines they actually work
   * on. The MANAGER walk is unchanged: a shared node is a real supervisory
   * position and stays the manager of its children.
   */
  const managerOf = (p) => {
    let c = byId.get(p.reportsTo), guard = 0;
    while (c && c.kind === 'machine' && guard++ < 50) c = byId.get(c.reportsTo);
    return c || null;
  };
  const contextsOf = (p) => {
    const out = [];
    let c = byId.get(p.reportsTo), guard = 0;
    while (c && c.kind !== 'role' && guard++ < 50) {
      if (c.kind === 'machine') out.push(c);
      c = byId.get(c.reportsTo);
    }
    return out;
  };

  // ---- 1. Departments: ONE tree — units, machines and shared crews ---------
  // Everything the chart draws that is not a person's seat is a department or a
  // sub-department (the user's decision, 2026-10-10). Two things in the file
  // say "here is a unit": a seat carrying `dtype` (it heads a department or a
  // section AND holds a job), and a `kind:'machine'` node (a machine, an area
  // or a process — never a seat). Both become rows of hrms_departments, and a
  // position then takes the NEAREST one that encloses it, walking up the chart
  // from the seat itself.
  //
  // ONE DEPARTMENT PER REAL THING. The chart says the same thing twice in four
  // shapes, and each is collapsed by a rule read off the data, never a list:
  //
  //   (a) A machine node whose ONLY child is a unit seat that itself contains
  //       machines is a heading over that unit, not a second unit ("Printing
  //       Process" over the Printing section and its three machines). The
  //       heading is merged into the section and gets no row.
  //   (b) A unit whose nearest enclosing UNIT has the same name repeats it
  //       (the "Slitting" flag on each slitting operator, inside Slitting). No
  //       row; its seats fall to the machine they stand under.
  //   (c) A unit sitting directly under a machine of the same name IS that
  //       machine ("Inspection" under the Inspection machine). One row, the
  //       machine's.
  //   (d) Units of one name hanging from the same place are one unit with
  //       several senior people in it ("Sales & Marketing" x4). One row, coded
  //       by the first of them in the chart.
  //
  // Names are compared normalised (case, spacing, trailing punctuation) and
  // nothing else: "Ink" under "Ink Mixing" is NOT collapsed, because deciding
  // those are one thing would be reading meaning into two different names.
  const isUnit = (n) => !!norm(n.dtype);
  const isMachine = (n) => n.kind === 'machine';
  const unitName = (n) => norm(n.dept) || norm(n.title);
  const sameName = (a, b) => normKey(a) === normKey(b);
  const unitOf = (n) => { let c = n, g = 0; while (c && g++ < 60) { if (isUnit(c)) return c; c = byId.get(c.reportsTo); } return null; };
  const unitAbove = (n) => { let c = byId.get(n.reportsTo), g = 0; while (c && g++ < 60) { if (isUnit(c)) return c; c = byId.get(c.reportsTo); } return null; };
  const order = new Map(nodes.map((n, i) => [n.id, i]));
  const kidsOf = new Map();
  for (const n of nodes) {
    if (!byId.has(n.reportsTo)) continue;
    if (!kidsOf.has(n.reportsTo)) kidsOf.set(n.reportsTo, []);
    kidsOf.get(n.reportsTo).push(n);
  }
  const kids = (n) => kidsOf.get(n.id) || [];
  const hasMachineBelow = (n, g = 0) => g < 60 && kids(n).some((k) => isMachine(k) || hasMachineBelow(k, g + 1));

  // The raw `dtype` units, exactly as the chart flags them. Kept for two things
  // only: the role qualifiers in section 3 (so split role titles do not move
  // when the department model does) and the report of what was collapsed.
  const unitNodes = nodes.filter(isUnit);
  const unitByNode = new Map(real.map((p) => [p.id, unitOf(p)?.id ?? null]));

  // (a)
  const headingOver = new Map();              // machine id -> the unit seat it is a heading for
  for (const m of machines) {
    const ks = kids(m);
    if (ks.length === 1 && isUnit(ks[0]) && hasMachineBelow(ks[0])) headingOver.set(m.id, ks[0]);
  }
  // (b), (c)
  const repeatsEnclosing = (u) => { const up = unitAbove(u); return !!up && sameName(unitName(u), unitName(up)); };
  const machineItNames = (u) => {
    const m = byId.get(u.reportsTo);
    return m && isMachine(m) && !headingOver.has(m.id) && sameName(unitName(u), m.title) ? m : null;
  };
  // (d) — needs "where does this unit hang", which needs the units above it, so
  // it is memoised and only ever recurses upward.
  const canonical = new Map();                // unit id -> the unit id that carries the row
  const deptKeyAt = (n) => {                  // the department this node opens, or null
    // A heading has no row; a SPLIT machine has several, and which of them a
    // seat below it belongs to is for an adjustment to say, not this walk.
    if (isMachine(n)) return headingOver.has(n.id) || splitOf.has(n.id) ? null : n.id;
    if (!isUnit(n) || repeatsEnclosing(n)) return null;
    const m = machineItNames(n);
    if (m) return m.id;
    if (!canonical.has(n.id)) {
      canonical.set(n.id, n.id);              // provisional: a same-named unit further down must not recurse back here
      const hangsFrom = containerAbove(n);
      const twins = unitNodes.filter((o) => !repeatsEnclosing(o) && !machineItNames(o)
        && sameName(unitName(o), unitName(n)) && containerAbove(o) === hangsFrom)
        .sort((a, b) => order.get(a.id) - order.get(b.id));
      for (const t of twins) canonical.set(t.id, twins[0].id);
    }
    return canonical.get(n.id);
  };
  const containerAt = (n) => { let c = n, g = 0; while (c && g++ < 80) { const k = deptKeyAt(c); if (k) return k; c = byId.get(c.reportsTo); } return null; };
  function containerAbove(n) { const up = byId.get(n.reportsTo); return up ? containerAt(up) : null; }

  const deptMap = new Map();                  // key -> department
  const addDept = (d) => { deptMap.set(d.key, d); return d; };
  for (const n of nodes) {
    if (splitOf.has(n.id)) {
      // One box in the chart, several departments by decision. Coded <node>-1,
      // <node>-2 … in the order the adjustment names them, so the codes are
      // stable for as long as the decision is.
      if (headingOver.has(n.id)) adjProblems.push(`${n.id} "${norm(n.title)}" is a heading over one section, not a machine; it cannot be split.`);
      splitOf.get(n.id).names.forEach((name, i) => addDept({
        key: `${n.id}-${i + 1}`, code: `${n.id}-${i + 1}`, node: n, part: i + 1, name, type: 'Machine / area',
        parentKey: containerAbove(n), isShared: 0, serves: [], origin: 'machine', splitFrom: n.id,
      }));
      continue;
    }
    const key = deptKeyAt(n);
    if (!key || key !== n.id) continue;       // not a department, or folded into another node's row
    const absorbed = [...headingOver].filter(([, u]) => deptKeyAt(u) === key).map(([mid]) => mid);
    addDept({
      key, code: n.id, node: n,
      name: isMachine(n) ? norm(n.title) : unitName(n),
      type: isMachine(n) ? 'Machine / area' : (norm(n.dtype) === 'dept' ? 'Department' : (absorbed.length ? 'Process' : 'Section')),
      parentKey: containerAbove(n), isShared: 0, serves: [], origin: isMachine(n) ? 'machine' : 'unit',
    });
  }

  // ---- 2. Shared seats: one department per distinct set of departments served
  // V28 marks 8 seats `kind:'shared'`. What each one is shared BETWEEN is read
  // from the only three things the chart gives:
  //   * `sharedWith` — named seats. Their departments, plus the department of
  //     the seat it reports to, are what it serves. Exact as far as it goes,
  //     and lossy: the chart named people, a department is coarser.
  //   * where it stands. Under a machine whose WHOLE crew is shared, the
  //     machine node is itself several machines drawn as one box ("IBC 1/2/3")
  //     and the crew is simply that department's crew: nothing to point at.
  //   * the odd one out. A single shared seat among dedicated seats under one
  //     machine is shared with something BEYOND that machine, and the chart
  //     does not say what. The neighbouring machines under the same unit are
  //     the only candidates the file offers — a GUESS, and reported as one.
  // A set of one is not sharing: the seat sits in that department. A set of
  // two or more gets a department of its own, under the nearest department
  // that encloses everything it serves, with one hrms_department_serves row
  // per department served. Never cloned per machine.
  const deptOrder = () => {
    const rank = new Map();
    const walk = (parentKey, g) => {
      if (g > 60) return;
      for (const d of [...deptMap.values()].filter((x) => x.parentKey === parentKey)
        .sort((a, b) => (order.get(a.node?.id) ?? 1e9) - (order.get(b.node?.id) ?? 1e9) || (a.part ?? 0) - (b.part ?? 0))) {
        if (rank.has(d.key)) continue;
        rank.set(d.key, rank.size);
        walk(d.key, g + 1);
      }
    };
    walk(null, 0);
    return rank;
  };
  const baseRank = deptOrder();
  const chainUp = (key) => { const out = []; let k = key, g = 0; while (k && g++ < 60) { out.push(k); k = deptMap.get(k)?.parentKey ?? null; } return out; };
  const nearestCommon = (keys) => {
    const chains = keys.map(chainUp);
    return chains[0].find((k) => chains.every((c) => c.includes(k))) ?? null;
  };
  const sharedDecisions = [];
  const sharedDeptOfSeat = new Map();         // seat id -> shared department key
  /** The shared department for a set of served departments — one per distinct set, made on first use. */
  const sharedDeptFor = (keys, name = null) => {
    const deptKey = `shared:${keys.join('+')}`;
    if (!deptMap.has(deptKey)) {
      const names = keys.map((k) => deptMap.get(k).name);
      const joined = `SH-${keys.join('-')}`;
      addDept({
        key: deptKey, node: null, origin: 'shared', isShared: 1, serves: keys, type: 'Shared crew',
        code: joined.length <= 50 ? joined : `SH-${keys[0]}-${keys.length}-${keys.join('').split('').reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7).toString(36)}`,
        name: clip(name || `Shared · ${names.slice(0, 3).join(' + ')}${names.length > 3 ? ` + ${names.length - 3} more` : ''}`, 200),
        parentKey: nearestCommon(keys), seats: [],
      });
    }
    return deptKey;
  };
  const byRank = (keys) => [...new Set(keys.filter(Boolean))].sort((a, b) => baseRank.get(a) - baseRank.get(b));

  // (i) What a person decided. These come first and are never second-guessed.
  for (const s of adjShared) {
    const unknown = s.serves.filter((k) => !deptMap.has(k) || deptMap.get(k).isShared);
    if (unknown.length) {
      adjProblems.push(`A shared adjustment (seats ${s.seats.join(', ')}) serves ${unknown.map((k) => `"${k}"`).join(', ')}, which ${unknown.length === 1 ? 'is' : 'are'} not a department this chart and these adjustments produce. Departments are coded by their node id; a split machine's parts are <node>-1, <node>-2 ….`);
      continue;
    }
    const keys = byRank(s.serves);
    const deptKey = sharedDeptFor(keys, s.name);
    for (const id of s.seats) {
      sharedDeptOfSeat.set(id, deptKey);
      deptMap.get(deptKey).seats.push(id);
      sharedDecisions.push({
        id, title: norm(byId.get(id).title), serves: keys, names: keys.map((k) => deptMap.get(k).name), department: deptMap.get(deptKey).name,
        shared: true, guess: Boolean(s.entry.needsConfirmation), decided: true,
        basis: `by decision (${norm(s.entry.decidedBy)}, ${norm(s.entry.decidedOn)}): ${norm(s.entry.reason)} Serves`,
      });
    }
  }
  failAdjustments();
  /** The nearest seat above this one that a decision placed, with no department opening in between. */
  const placedAbove = (p) => {
    let c = byId.get(p.reportsTo), g = 0;
    while (c && g++ < 60) {
      if (sharedDeptOfSeat.has(c.id)) return c;
      if (isMachine(c) || deptKeyAt(c)) return null;
      c = byId.get(c.reportsTo);
    }
    return null;
  };

  // (ii) What the chart marks as shared and nobody has decided about.
  for (const s of real.filter((p) => p.kind === 'shared')) {
    if (sharedDeptOfSeat.has(s.id)) continue;                 // decided above
    if (adjNotShared.has(s.id)) {
      const e = adjNotShared.get(s.id);
      const key = containerAt(s);
      sharedDecisions.push({ id: s.id, title: norm(s.title), serves: [key], names: [deptMap.get(key)?.name], department: deptMap.get(key)?.name,
        shared: false, guess: false, decided: true,
        basis: `NOT shared, by decision (${norm(e.decidedBy)}, ${norm(e.decidedOn)}): ${norm(e.reason)} It stays in` });
      continue;
    }
    const lead = placedAbove(s);
    if (lead) {
      const d = deptMap.get(sharedDeptOfSeat.get(lead.id));
      sharedDecisions.push({ id: s.id, title: norm(s.title), serves: d.serves, names: d.serves.map((k) => deptMap.get(k).name), department: d.name,
        shared: true, guess: false, decided: true,
        basis: `reports to ${lead.id} "${norm(lead.title)}" with no department in between, so it goes where that seat was placed. Serves` });
      continue;
    }
    let keys, basis, guess = false;
    if (Array.isArray(s.sharedWith) && s.sharedWith.length) {
      const seats = [byId.get(s.reportsTo), ...s.sharedWith.map((id) => byId.get(id))].filter(Boolean);
      keys = seats.map(containerAt);
      basis = `sharedWith names ${s.sharedWith.join(', ')}; with the seat it reports to (${s.reportsTo}) those sit in`;
    } else {
      let m = byId.get(s.reportsTo), g = 0;
      while (m && m.kind === 'shared' && g++ < 50) m = byId.get(m.reportsTo);
      if (!m || !isMachine(m) || headingOver.has(m.id)) {
        keys = [containerAt(s)];
        basis = 'stands under no machine and names nobody, so nothing says what it is shared between; it stays in';
      } else if (splitOf.has(m.id)) {
        throw new Error(`${s.id} "${norm(s.title)}" is a shared seat under ${m.id} "${norm(m.title)}", which an adjustment splits into ${splitOf.get(m.id).names.join(', ')} — and no adjustment says which of them it serves. Add a "shared" adjustment naming it (or the seat it reports to).`);
      } else {
        const crew = kids(m).filter((k) => !isMachine(k));
        if (crew.every((k) => k.kind === 'shared')) {
          keys = [m.id];
          basis = `every seat under ${m.id} "${norm(m.title)}" is shared, so that one box stands for several machines and this is its crew:`;
        } else {
          const neighbours = kids(byId.get(m.reportsTo) || { id: null }).filter((k) => isMachine(k) && k.id !== m.id && !headingOver.has(k.id) && !splitOf.has(k.id));
          keys = [m.id, ...neighbours.map((k) => k.id)];
          guess = neighbours.length > 0;
          basis = neighbours.length
            ? `the only shared seat among ${crew.length} under ${m.id} "${norm(m.title)}", so it is shared beyond that machine; the chart does not say with what, and the neighbouring machine${neighbours.length === 1 ? '' : 's'} under the same unit ${neighbours.length === 1 ? 'is' : 'are'} the only candidate${neighbours.length === 1 ? '' : 's'}:`
            : `the only shared seat under ${m.id} "${norm(m.title)}", which has no neighbouring machine to share with:`;
        }
      }
    }
    keys = byRank(keys);
    const names = keys.map((k) => deptMap.get(k).name);
    let deptKey = keys[0];
    if (keys.length > 1) {
      deptKey = sharedDeptFor(keys);
      deptMap.get(deptKey).seats.push(s.id);
      sharedDeptOfSeat.set(s.id, deptKey);
    }
    sharedDecisions.push({ id: s.id, title: norm(s.title), serves: keys, names, department: deptMap.get(deptKey).name, shared: keys.length > 1, guess, basis });
  }

  // Every seat's ONE department. A seat reporting to a shared seat, with no
  // department of its own in between, goes where that shared seat went.
  const deptKeyByNode = new Map();
  // The same holds for any seat an adjustment placed. A seat that reaches a
  // SPLIT machine without having been placed is an error, never a silent
  // fall-through to the unit above: the decision to split is incomplete.
  for (const p of real) {
    let c = p, g = 0, key = null;
    while (c && g++ < 80 && !key) {
      if (splitOf.has(c.id)) {
        adjProblems.push(`${p.id} "${norm(p.title)}" stands under ${c.id} "${norm(c.title)}", which is split into ${splitOf.get(c.id).names.join(', ')}, and no adjustment says which it belongs to. Name it (or the seat it reports to) in a "shared" adjustment.`);
        break;
      }
      key = sharedDeptOfSeat.get(c.id) || deptKeyAt(c);
      c = byId.get(c.reportsTo);
    }
    deptKeyByNode.set(p.id, key);
  }
  failAdjustments();

  // Parents before children; a shared department is never a parent.
  const depthOfDept = (d) => chainUp(d.key).length;
  const finalRank = deptOrder();
  const departments = [...deptMap.values()].sort((a, b) => depthOfDept(a) - depthOfDept(b) || finalRank.get(a.key) - finalRank.get(b.key));
  const serves = departments.flatMap((d) => d.serves.map((k) => ({ deptKey: d.key, servesKey: k })));

  const orphans = real.filter((p) => !deptKeyByNode.get(p.id));
  const seatsIn = (origin) => real.filter((p) => deptMap.get(deptKeyByNode.get(p.id))?.origin === origin).length;
  const perDept = new Map();
  for (const p of real) { const k = deptKeyByNode.get(p.id); if (k) perDept.set(k, (perDept.get(k) || 0) + 1); }
  counts.sourceUnitFlags = unitNodes.length;
  counts.departmentRows = departments.length;
  counts.unitDepartments = departments.filter((d) => d.origin === 'unit').length;
  counts.machineDepartments = departments.filter((d) => d.origin === 'machine').length;
  counts.sharedDepartments = departments.filter((d) => d.origin === 'shared').length;
  counts.departmentServes = serves.length;
  counts.positionsWithDepartment = real.length - orphans.length;
  counts.seatsInMachineDepartment = seatsIn('machine');
  counts.seatsInSharedDepartment = seatsIn('shared');
  counts.seatsElsewhere = seatsIn('unit');

  const headings = [...headingOver].map(([mid, u]) => `${mid} "${norm(byId.get(mid).title)}" -> ${u.id} ${unitName(u)}`);
  const repeats = unitNodes.filter(repeatsEnclosing);
  const namesMachine = unitNodes.filter((u) => !repeatsEnclosing(u) && machineItNames(u));
  const twinGroups = new Map();
  for (const [id, to] of canonical) { if (!twinGroups.has(to)) twinGroups.set(to, []); twinGroups.get(to).push(id); }
  const twinSets = [...twinGroups].filter(([, ids]) => ids.length > 1);
  const deptLine = (d) => `${d.name} [${d.type}] (${d.code}, ${perDept.get(d.key) || 0} seats)`;
  note('Everything is a department now — machines and shared crews included',
    `The chart flags ${unitNodes.length} seats as heading a unit (\`dtype\`) and draws ${machines.length} machine or process boxes. Those `
    + `${unitNodes.length + machines.length} became ${departments.length - counts.sharedDepartments} departments, plus ${counts.sharedDepartments} for shared crews: `
    + `${counts.unitDepartments} from unit seats, ${counts.machineDepartments} from machines (type "Machine / area"). Every one of the ${real.length} positions has `
    + `exactly one: ${counts.seatsInMachineDepartment} sit directly in a machine's department, ${counts.seatsInSharedDepartment} in a shared one and `
    + `${counts.seatsElsewhere} in a department, process or section. Work contexts are no longer written. `
    + `What was collapsed, so that one real thing is one department: `
    + `(a) ${headings.length} process headings merged into the section they sit over — ${headings.join('; ')}. `
    + `(b) ${repeats.length} unit flags that only repeat the unit around them — ${repeats.map((u) => `${u.id} "${unitName(u)}" inside ${unitAbove(u).id}`).join(', ')}. `
    + `(c) ${namesMachine.length} unit flags that name the machine they stand under — ${namesMachine.map((u) => `${u.id} "${unitName(u)}" = ${machineItNames(u).id}`).join(', ')}. `
    + `(d) ${twinSets.length} name${twinSets.length === 1 ? '' : 's'} claimed by several seats hanging from one place — `
    + `${twinSets.map(([to, ids]) => `"${unitName(byId.get(to))}" x${ids.length} (${ids.join(', ')}) kept as ${to}`).join('; ') || 'none'}. `
    + `Largest first: ${[...departments].sort((a, b) => (perDept.get(b.key) || 0) - (perDept.get(a.key) || 0)).slice(0, 8).map(deptLine).join('; ')}. `
    + `The \`type\` is a label for people to read; nothing in the app decides anything from its text.`);
  if (adjEntries.length) {
    const say = (a) => {
      const tail = ` — ${norm(a.reason)} [${norm(a.decidedBy)}, ${norm(a.decidedOn)}]${a.needsConfirmation ? ' *** NEEDS CONFIRMATION — this one was inferred, not stated ***' : ''}`;
      if (a.kind === 'split') return `SPLIT ${a.node} "${norm(byId.get(a.node).title)}" into ${a.into.map((n, i) => `${n} (${a.node}-${i + 1})`).join(', ')}${tail}`;
      if (a.kind === 'shared') return `SHARED: seats ${a.seats.join(', ')} serve ${a.serves.map((k) => `${deptMap.get(k).name} (${k})`).join(' + ')}${tail}`;
      return `NOT SHARED: ${a.seat} "${norm(byId.get(a.seat).title)}"${tail}`;
    };
    note(`${adjEntries.length} adjustments applied on top of the chart`,
      `From ${adj.fileName} (sha256 ${adj.hash.slice(0, 12)}…), which records decisions the chart cannot express. All ${adjEntries.length} fitted this chart and were applied: ` + adjEntries.map((a, i) => `(${i + 1}) ${say(a)}`).join(' ')
      + ` A split machine has no row of its own; its parts are coded <node>-1, <node>-2 … in the order the file names them. Had any entry named a node this chart does not have, the import would have stopped.`);
  }
  const nearMiss = departments.filter((d) => d.origin === 'unit' && isMachine(byId.get(d.node.reportsTo) || {})
    && !headingOver.has(d.node.reportsTo) && kids(byId.get(d.node.reportsTo)).length === 1);
  if (nearMiss.length) {
    note('A section that is the whole of a differently named machine',
      nearMiss.map((d) => `${d.code} "${d.name}" is the only thing under ${d.node.reportsTo} "${norm(byId.get(d.node.reportsTo).title)}"`).join('; ')
      + `. The names differ, so both were kept: the machine as a department with no seats of its own, the section inside it. `
      + `If they are one thing, rename one to match the other in the chart (or merge them on the Departments screen) and `
      + `the next import makes one department of them.`);
  }
  note(`${sharedDecisions.length} shared seats: where each one went`,
    sharedDecisions.map((s) => `${s.id} "${s.title}" — ${s.basis} ${s.names.join(' + ')}. `
      + (s.shared ? `Department: "${s.department}"${s.guess ? ' (A GUESS — confirm what this seat is shared between)' : ''}.` : `Department: "${s.department}", not a shared one.`)).join(' ')
    + ` A seat stays ONE position whatever it serves; a shared department is one box with a line to each department it serves.`);
  if (orphans.length) {
    note('Positions with no department',
      `${orphans.length} positions sit above every unit and machine in the chart and so have no enclosing department: `
      + `${orphans.map((p) => `${p.id} "${norm(p.title)}"`).join(', ')}. Their department is left empty rather than guessed.`);
  }

  // ---- 3. Roles: one per (title, duty list) -----------------------------
  // A role is a KIND OF WORK, and its content is the job description of every
  // seat that holds it. So two seats may share a role only if they share the
  // same work — same title AND the same duties and KPIs.
  //
  // This used to group by title alone, and that inflated job descriptions:
  // the chart keeps a duty list PER SEAT, each seat's list was attached to the
  // shared role, and every holder inherited the union. "Operator - Production"
  // is 10 seats with 7 different lists and NOT ONE duty in common — a printing
  // operator, a lamination operator and a slitting operator. P136 (slitting)
  // has 27 duties in the chart and had 106 here, the first of them "operations
  // of Printing Machines". 22 seats across 6 titles carried 1,122 duties that
  // were never theirs (measured 2026-10-09).
  //
  // Seats whose lists are identical still share a role — the ten "Helper 1"
  // seats are one role, exactly as before — and a title whose seats all agree
  // keeps its old key, title and code, so unaffected roles do not churn. Only a
  // title that genuinely splits gets qualified role titles. The SEAT keeps the
  // client's title untouched (position_title comes from the node, below); only
  // the role behind it says which kind of operator it is.
  //
  // Considered and rejected: keep one shared role and hang each seat's duties on
  // the seat as position overlays. With "Operator - Production" sharing nothing,
  // the role would be empty and all 106 duties seat-level — which the org
  // workbook can only remove, never edit, and which costs the Departments view
  // ~13 queries per overlaid seat (≈280 over the link). Plan §9 finding 4 always
  // said the remedy was to split.
  const dutySignature = (p) => JSON.stringify([
    [...new Set((p.kras || []).map(norm).filter(Boolean).map(normKey))].sort(),
    [...new Set((p.kpis || []).map((k) => norm(k?.k)).filter(Boolean).map(normKey))].sort(),
  ]);
  const titleNodes = new Map();
  for (const p of real) {
    const key = normKey(p.title);
    if (!titleNodes.has(key)) titleNodes.set(key, []);
    titleNodes.get(key).push(p);
  }
  const unitNameOf = (p) => {
    const id = unitByNode.get(p.id);
    return id ? unitName(byId.get(id)) : null;
  };
  const roleGroups = [];
  const roleKeyByNode = new Map();
  const splitTitles = [];
  for (const [titleKey, group] of titleNodes) {
    const bySig = new Map();
    for (const p of group) {
      const s = dutySignature(p);
      if (!bySig.has(s)) bySig.set(s, []);
      bySig.get(s).push(p);
    }
    const parts = [...bySig.values()];
    if (parts.length === 1) {
      roleGroups.push({ key: titleKey, code: group[0].id, title: norm(group[0].title), nodes: group });
      for (const p of group) roleKeyByNode.set(p.id, titleKey);
      continue;
    }
    // A qualifier a person can read. Start from the unit the seats sit in
    // ("Slitting"); only where two parts of this title share a unit, add the
    // machines they work ("Lamination · Raulimex" against "Lamination · Nord /
    // Uflex"); only where that still does not tell them apart, add seat codes.
    // Refining just the colliding parts keeps the common case short.
    const join = (xs) => [...new Set(xs.filter(Boolean))].join(' / ');
    const unitLabel = (nodes) => join(nodes.map(unitNameOf));
    const machineLabel = (nodes, unit) => join(nodes.map((p) => norm(contextsOf(p)[0]?.title))
      .filter((m) => m && m.toLowerCase() !== String(unit).toLowerCase())
      .map((m) => m.replace(/\s+machine$/i, '')));
    const codesLabel = (nodes) => nodes.map((p) => p.id).join(', ');
    const collide = (ls) => {
      const seen = new Map();
      for (const l of ls) seen.set(l.toLowerCase(), (seen.get(l.toLowerCase()) || 0) + 1);
      return (l) => !l || seen.get(l.toLowerCase()) > 1;
    };
    let labels = parts.map(unitLabel);
    let clash = collide(labels);
    labels = labels.map((l, i) => {
      if (!clash(l)) return l;
      const m = machineLabel(parts[i], l);
      return [l, m].filter(Boolean).join(' · ');
    });
    clash = collide(labels);
    labels = labels.map((l, i) => (clash(l) ? [l, codesLabel(parts[i])].filter(Boolean).join(' · ') : l));
    const base = norm(group[0].title);
    parts.forEach((nodes, i) => {
      const key = `${titleKey}#${i + 1}`;
      roleGroups.push({ key, code: nodes[0].id, title: `${base} (${labels[i]})`, nodes });
      for (const p of nodes) roleKeyByNode.set(p.id, key);
    });
    splitTitles.push({ title: base, seats: group.length, parts: parts.map((nodes, i) => ({ label: labels[i], codes: nodes.map((p) => p.id) })) });
  }
  const roleKeyOf = (p) => roleKeyByNode.get(p.id);
  if (splitTitles.length) {
    const seats = splitTitles.reduce((a, t) => a + t.seats, 0);
    const roles = splitTitles.reduce((a, t) => a + t.parts.length, 0);
    note('Seats with the same title but different duties have different roles',
      `${splitTitles.length} titles are used by seats whose duty lists differ, so they became ${roles} roles for ${seats} `
      + `seats instead of ${splitTitles.length}. A role's content is the job description of every seat holding it, so `
      + `sharing one would have given each seat the duties of all the others — "${splitTitles[0].title}" alone would have `
      + `handed every holder the duties of ${splitTitles[0].parts.length} different jobs. Each seat keeps the chart's own `
      + `title; only the role behind it is qualified. `
      + splitTitles.map((t) => `"${t.title}" -> ${t.parts.map((x) => `(${x.label}) ${x.codes.join('/')}`).join('; ')}`).join('. ')
      + `. If two of these really are the same job, make their duty lists identical in the chart and they will share a role.`);
  }
  counts.titlesSplit = splitTitles.length;
  counts.roles = roleGroups.length;
  counts.positions = real.length;
  const merged = roleGroups.filter((g) => g.nodes.length > 1).sort((a, b) => b.nodes.length - a.nodes.length);
  if (merged.length) {
    note('Repeated titles collapsed into shared roles',
      `${real.length} chart nodes became ${roleGroups.length} roles and ${real.length} positions, because ${merged.length} `
      + `roles are held by more than one seat. Every seat sharing a role here has the same title AND the same duty list `
      + `in the chart, so the role's content is exactly each holder's job description — nothing is combined. The shared `
      + `roles, largest first: `
      + merged.map((m) => `"${m.title}" x${m.nodes.length} (${m.nodes.map((g) => g.id).join(', ')})`).join('; ')
      + `. "${merged[0].title}" spans ${new Set(merged[0].nodes.map((n) => deptKeyByNode.get(n.id))).size} department(s).`);
  }

  // ---- 4. Positions ----------------------------------------------------
  // A DN position's sanctioned headcount is `req` PER SHIFT. `sanctioned_headcount`
  // keeps meaning one seat; the day/night doubling becomes manpower requirements,
  // which is the table that exists for exactly this. Plan §9.1.
  const positions = real.map((p) => ({
    node: p,
    roleKey: roleKeyOf(p),
    req: Math.max(0, Number(p.req) || 0),
    shift: p.shift === 'DN' ? null : (p.shift || 'G'),
    deptKey: deptKeyByNode.get(p.id) || null,
  }));
  const manpower = [];
  let sanctioned = 0;
  for (const pos of positions) {
    sanctioned += pos.node.shift === 'DN' ? pos.req * 2 : pos.req;
    if (pos.node.shift !== 'DN' || !pos.req) continue;
    for (const code of ['D', 'N']) manpower.push({ nodeId: pos.node.id, roleKey: pos.roleKey, shift: code, count: pos.req });
  }
  counts.sanctionedNaive = positions.reduce((a, p) => a + p.req, 0);
  counts.sanctionedTrue = sanctioned;
  counts.manpowerRows = manpower.length;

  // ---- 5. Formal reporting ---------------------------------------------
  const edges = [];
  let roots = 0;
  for (const p of real) {
    const mgr = managerOf(p);
    if (!mgr) { roots++; continue; }
    edges.push({ fromId: p.id, toId: mgr.id, type: 'PRIMARY_MANAGER', isPrimary: 1, notes: null });
  }
  for (const p of real.filter((x) => x.dotted)) {
    const target = byId.get(p.dotted);
    if (!target || target.kind === 'machine') continue;
    edges.push({
      fromId: p.id, toId: target.id, type: 'DOTTED_LINE', isPrimary: 0,
      notes: 'Dotted line from the org chart. Scope was not recorded there — confirm whether it is genuinely general.',
    });
  }
  counts.primaryEdges = edges.filter((e) => e.type === 'PRIMARY_MANAGER').length;
  counts.dottedEdges = edges.filter((e) => e.type === 'DOTTED_LINE').length;
  counts.roots = roots;
  note('Dotted lines need a scope',
    `${counts.dottedEdges} dotted relationships imported with scope GENERAL because the source records no scope. `
    + `Spec v1.1 §13.2 exists precisely so these can say "statutory compliance only" — review each one.`);

  // ---- 6. Responsibilities (the `kras[]` arrays) ------------------------
  const respDefs = new Map();                 // normKey -> { key, text }
  const respAssign = [];                      // { roleKey, defKey, sequence }
  const respSeen = new Set();                 // roleKey|defKey
  const respSeq = new Map();                  // roleKey -> running sequence
  let respReused = 0, respSkipped = 0;
  for (const p of real) {
    const roleKey = roleKeyOf(p);
    for (const raw of (p.kras || [])) {
      const text = norm(raw);
      if (!text) continue;
      const key = normKey(text);
      if (respDefs.has(key)) respReused++;
      else respDefs.set(key, { key, text });
      // Two chart nodes sharing a title are now one role, so the same
      // responsibility can arrive twice. The unique key would reject it.
      const pair = `${roleKey}|${key}`;
      if (respSeen.has(pair)) { respSkipped++; continue; }
      respSeen.add(pair);
      // Sequence runs per ROLE, not per node: a merged role's list has to read
      // in one order, and a node-local index would interleave three 1s.
      const seq = (respSeq.get(roleKey) || 0) + 1;
      respSeq.set(roleKey, seq);
      respAssign.push({ roleKey, defKey: key, sequence: seq });
    }
  }
  counts.responsibilityLines = real.reduce((a, p) => a + (p.kras || []).length, 0);
  counts.responsibilities = respDefs.size;
  counts.responsibilityAssignments = respAssign.length;
  // The illustration is pulled from the file so it cannot become a stale quote.
  const typical = [...respDefs.values()].map((d) => d.text).sort((a, b) => a.length - b.length)[Math.floor(respDefs.size / 2)] || '';
  note('KRAs imported as Responsibilities',
    `${counts.responsibilityLines} entries from the chart's "kras" arrays are Responsibilities, not KRAs — they are task `
    + `statements ("${typical}"), and a KRA is an area of outcome. The rule has not `
    + `changed since V12; it matters more now that there are ${counts.responsibilityLines} of them rather than 595. `
    + `${respReused} were textual duplicates and were reused rather than copied, leaving ${respDefs.size} distinct `
    + `responsibilities; a further ${respSkipped} were dropped as the same text arriving twice at one merged role, `
    + `leaving ${respAssign.length} role assignments. The outcome areas themselves are not in the chart: they come `
    + `from the KRA file beside it (see the key result areas finding). Nothing is lost where that file places nothing — `
    + `a responsibility with no KRA still renders on a JD.`);
  const longResp = [...respDefs.values()].filter((d) => d.text.length > 250);
  const nameGroups = new Map();
  for (const d of respDefs.values()) {
    const n = clip(d.text, 250);
    if (!nameGroups.has(n)) nameGroups.set(n, []);
    nameGroups.get(n).push(d);
  }
  const nameClash = [...nameGroups.values()].filter((v) => v.length > 1);
  if (longResp.length) {
    note(`${longResp.length} responsibility statements are too long for a label`,
      `${longResp.length} statements run past the 250 characters \`name\` holds, so their short name is a truncated prefix while `
      + `\`description\` keeps the full text — nothing is lost. ${nameClash.length
        ? `${nameClash.length} truncation${nameClash.length > 1 ? 's' : ''} left two or more different statements sharing one name `
          + `(${nameClash.map((v) => `"${clip(v[0].text, 70)}" x${v.length}`).join('; ')}); they are different statements, so give them `
          + `real labels when they are reviewed.`
        : 'No two truncated names collide.'}`);
  }

  // ---- 7. KPIs (new in V28 — the path existed and had never run) --------
  // hrms_kpi_definitions is UNIQUE on name, so the name is the identity and a
  // target cannot live on it (the schema says so too: the same indicator carries
  // different expectations by role). Targets here are sentences — "100% adoption
  // by end of Nov'26" — so measurement_type is TEXT and the target is carried
  // verbatim on the assignment, in the shape roleContentService.validateTarget
  // writes for TEXT: operator EQ, value a JSON string.
  const kpiDefs = new Map();                  // normKey -> { key, name, description, nodes: [] }
  const kpiAssign = [];                       // { roleKey, defKey, target, sequence, notes }
  const kpiSeen = new Map();                  // roleKey|defKey -> assignment
  const kpiSeq = new Map();                   // roleKey -> running sequence
  const kpiVariants = [];                     // reported: same name, different words
  let kpiDropped = 0;
  for (const p of real) {
    const roleKey = roleKeyOf(p);
    for (const raw of (p.kpis || [])) {
      const name = norm(raw?.k);
      if (!name) continue;
      const key = normKey(name);
      const description = norm(raw?.d);
      const target = norm(raw?.t);
      let def = kpiDefs.get(key);
      if (!def) { def = { key, name: clip(name, 250), description, nodes: [] }; kpiDefs.set(key, def); }
      def.nodes.push(p.id);
      const differs = description && normKey(description) !== normKey(def.description);
      if (differs) kpiVariants.push({ key, name, nodeId: p.id });

      const pair = `${roleKey}|${key}`;
      const kept = kpiSeen.get(pair);
      if (kept) {
        // One assignment per role+KPI is all the unique key allows. Keep the
        // first and write the other nodes' targets into its notes rather than
        // losing them.
        kpiDropped++;
        const extra = `${p.id} recorded the target as "${target}".`;
        kept.notes = kept.notes ? `${kept.notes} ${extra}` : extra;
        if (differs) kept.notes += ` ${p.id} worded the KPI as: ${description}`;
        continue;
      }
      const seq = (kpiSeq.get(roleKey) || 0) + 1;
      kpiSeq.set(roleKey, seq);
      const a = {
        roleKey, defKey: key, nodeId: p.id, target, sequence: seq,
        notes: differs ? `Description as recorded on ${p.id}: ${description}` : null,
      };
      kpiSeen.set(pair, a);
      kpiAssign.push(a);
    }
  }
  counts.kpiLines = real.reduce((a, p) => a + (p.kpis || []).length, 0);
  counts.kpis = kpiDefs.size;
  counts.kpiAssignments = kpiAssign.length;
  if (counts.kpiLines) {
    note('KPIs exist for the first time, and their targets are sentences',
      `V12 held none; V28 holds ${counts.kpiLines} KPI entries on ${real.filter((p) => (p.kpis || []).length).length} seats, which became `
      + `${kpiDefs.size} KPI definitions and ${kpiAssign.length} role assignments. The import path was built for V12 and never exercised `
      + `until now. Two things to know. First, every target is written as a sentence — `
      + `${[...new Set(real.flatMap((p) => (p.kpis || []).map((k) => norm(k?.t)).filter(Boolean)))].slice(0, 3).map((t) => `"${clip(t, 50)}"`).join(', ')} `
      + `— so each definition is stored as measured in TEXT and the `
      + `sentence is kept verbatim on the role's assignment. That is lossless but it is not yet measurable: reclassify `
      + `the ones that are really numbers (percentages, minutes, tonnes) and the screens can start colouring them. `
      + `Second, the target does NOT live on the definition, by design — the same "SAP Adoption" is a different `
      + `expectation for a Quality Officer than for the AGM.`);
  }
  if (kpiDropped) {
    const widest = [...kpiDefs.values()].sort((a, b) => b.nodes.length - a.nodes.length)[0];
    const widestTargets = new Set(real.flatMap((p) => (p.kpis || []).filter((k) => normKey(k?.k) === widest.key).map((k) => normKey(k?.t))));
    note('Merged roles cannot hold the same KPI twice',
      `${kpiDropped} of the ${counts.kpiLines} KPI entries could not become their own assignment: the chart put the same KPI name on `
      + `two or more seats that share a title, and those seats are now one role, which may hold a KPI once. The first `
      + `target was kept and every other seat's target was written into that assignment's notes, so nothing is lost — `
      + `but where the targets genuinely differ the roles should be split. "${widest.name}" is the clearest case: `
      + `${widest.nodes.length} seats carry it with ${widestTargets.size} different target${widestTargets.size === 1 ? '' : 's'}.`);
  }
  if (kpiVariants.length) {
    const byName = new Map();
    for (const v of kpiVariants) byName.set(v.name, (byName.get(v.name) || 0) + 1);
    const worst = [...byName].sort((a, b) => b[1] - a[1])[0];
    const worstDefs = new Set(real.flatMap((p) => (p.kpis || []).filter((k) => normKey(k?.k) === normKey(worst[0])).map((k) => normKey(k?.d))));
    note('One KPI name, several descriptions',
      `A KPI definition is unique by name, so ${byName.size} names that were worded differently on different seats share one `
      + `definition: ${[...byName.keys()].map((n) => `"${n}"`).join(', ')}. The first wording is the definition; every other wording is `
      + `kept verbatim in the notes of the assignment it came from. Read those before the first review cycle — `
      + `"${worst[0]}" is described ${worstDefs.size} different ways in this file.`);
  }

  // ---- 7b. KRAs: the outcome areas, from the file beside the chart --------
  // A KRA is an area of outcome ("Wastage & scrap"); the chart holds none, only
  // the tasks. The file says, per role, which KRA each responsibility and KPI
  // sits under. This section only GROUPS what sections 6 and 7 already decided
  // to write: it sets `kraKey` on those assignments and never adds, rewords or
  // removes one.
  //
  // KEYS, and how each one fails:
  //   role — by its title as this import names it (so a split title is found
  //          by its qualified title), and failing that by its exact set of
  //          seats. A role that was renamed AND re-seated is not found: its
  //          whole entry is stale and its lines import ungrouped.
  //   line — a responsibility by its text, a KPI by its name, normalised the
  //          way the definitions are (case, spacing, trailing punctuation). A
  //          reworded duty is a different duty: stale in the file, ungrouped
  //          in the tenant, until someone places the new wording.
  //
  // KRAs are per ROLE (the user's decision, 2026-10-10): the grouping row is
  // hrms_role_kra_assignments. hrms_kra_definitions is unique by name, so two
  // roles that both say "Quality" share one definition ROW — a name, nothing
  // more; neither role's grouping can see the other's.
  const PURPOSE_BASES = ['duties', 'title only', 'reviewed'];
  const kraDefs = new Map();                  // normKey(name) -> { key, name }
  const kraAssign = [];                       // { roleKey, defKey, sequence, description }
  const kraStale = [];                        // { role, kra?, what, text? }
  const kraBySeats = [];                      // roles found by seats, not title
  if (kraFile) {
    const problems = [];
    const groupByTitle = new Map(roleGroups.map((g) => [normKey(g.title), g]));
    const seatSig = (ids) => [...new Set(ids)].sort().join(',');
    const groupBySeats = new Map(roleGroups.map((g) => [seatSig(g.nodes.map((n) => n.id)), g]));
    const lineIndex = (rows) => {
      const m = new Map();
      for (const a of rows) { if (!m.has(a.roleKey)) m.set(a.roleKey, new Map()); m.get(a.roleKey).set(a.defKey, a); }
      return m;
    };
    const respOf = lineIndex(respAssign);
    const kpiOf = lineIndex(kpiAssign);
    const claimed = new Map();                // roleKey -> the entry that took it
    kraFile.roles.forEach((entry, i) => {
      const label = `role entry ${i + 1} ("${norm(entry?.role) || 'no role'}")`;
      if (!norm(entry?.role)) { problems.push(`${label} has no "role".`); return; }
      if (!Array.isArray(entry.kras)) { problems.push(`${label} has no "kras" array.`); return; }
      // The entry's own shape, checked whether or not the chart still has the role.
      const names = new Set();
      const placed = new Map();               // kind|line -> KRA name
      for (const k of entry.kras) {
        const name = norm(k?.name);
        if (!name) { problems.push(`${label}: a KRA has no name.`); continue; }
        if (names.has(normKey(name))) problems.push(`${label}: the KRA "${name}" is listed twice.`);
        names.add(normKey(name));
        for (const [kind, list] of [['responsibility', k.responsibilities], ['KPI', k.kpis]]) {
          if (list !== undefined && !Array.isArray(list)) { problems.push(`${label}: KRA "${name}" — its ${kind} list is not a list.`); continue; }
          for (const raw of list || []) {
            const key = `${kind}|${normKey(raw)}`;
            if (!normKey(raw)) { problems.push(`${label}: KRA "${name}" holds a blank ${kind}.`); continue; }
            if (placed.has(key)) problems.push(`${label}: the ${kind} "${clip(norm(raw), 80)}" is under both "${placed.get(key)}" and "${name}". A line sits under one KRA.`);
            else placed.set(key, name);
          }
        }
      }
      if (entry.purpose !== undefined && entry.purpose !== null && typeof entry.purpose !== 'string') problems.push(`${label}: "purpose" is not text.`);
      if (norm(entry.purposeBasis) && !PURPOSE_BASES.includes(norm(entry.purposeBasis))) {
        problems.push(`${label}: "purposeBasis" is "${norm(entry.purposeBasis)}"; it is one of ${PURPOSE_BASES.map((b) => `"${b}"`).join(', ')}.`);
      }
      let g = groupByTitle.get(normKey(entry.role));
      let bySeats = false;
      if (!g && Array.isArray(entry.seats) && entry.seats.length) { g = groupBySeats.get(seatSig(entry.seats)); bySeats = !!g; }
      if (!g) { kraStale.push({ role: norm(entry.role), what: 'role', lines: placed.size }); return; }
      if (claimed.has(g.key)) { problems.push(`${label} and ${claimed.get(g.key)} are both the role "${g.title}".`); return; }
      claimed.set(g.key, label);
      if (bySeats) kraBySeats.push({ from: norm(entry.role), to: g.title, seats: entry.seats.join(', ') });
      // The purpose rides on the role group itself: section 4 of the commit
      // writes it with the role. Verbatim — only the ends are trimmed.
      if (typeof entry.purpose === 'string' && entry.purpose.trim()) {
        g.purpose = entry.purpose.trim();
        g.purposeBasis = norm(entry.purposeBasis) || null;
      }
      let seq = 0;
      for (const k of entry.kras) {
        const name = norm(k?.name);
        if (!name) continue;
        const hits = [];
        for (const [what, list, index] of [['responsibility', k.responsibilities, respOf], ['KPI', k.kpis, kpiOf]]) {
          for (const raw of (Array.isArray(list) ? list : [])) {
            const a = index.get(g.key)?.get(normKey(raw));
            if (a) hits.push(a);
            else if (normKey(raw)) kraStale.push({ role: g.title, kra: name, what, text: norm(raw) });
          }
        }
        // A KRA none of whose lines the chart still has is not created: an
        // outcome area with nothing under it is a heading over nothing.
        if (!hits.length) { kraStale.push({ role: g.title, kra: name, what: 'KRA' }); continue; }
        const defKey = normKey(name);
        if (!kraDefs.has(defKey)) kraDefs.set(defKey, { key: defKey, name: clip(name, 200) });
        kraAssign.push({ roleKey: g.key, defKey, sequence: ++seq, description: norm(k.description) || null });
        for (const a of hits) a.kraKey = defKey;
      }
    });
    if (problems.length) {
      throw new Error(`The KRA file is not well formed — nothing was imported.\n  - ${problems.join('\n  - ')}\n`
        + `Fix ${kraFile.file}, or run with --no-kras to import the chart with every line ungrouped.`);
    }
  }
  const titleOfRole = new Map(roleGroups.map((g) => [g.key, g.title]));
  const linesOfRole = new Map();              // roleKey -> { resp, kpi, ungrouped: [] }
  for (const [kind, rows, text] of [['resp', respAssign, (a) => respDefs.get(a.defKey).text], ['kpi', kpiAssign, (a) => kpiDefs.get(a.defKey).name]]) {
    for (const a of rows) {
      if (!linesOfRole.has(a.roleKey)) linesOfRole.set(a.roleKey, { resp: 0, kpi: 0, ungrouped: [] });
      const r = linesOfRole.get(a.roleKey);
      r[kind]++;
      if (!a.kraKey) r.ungrouped.push(text(a));
    }
  }
  const rolesWithKras = new Set(kraAssign.map((a) => a.roleKey));
  const rolesNoContent = roleGroups.filter((g) => !linesOfRole.has(g.key));
  const rolesNoKras = [...linesOfRole.keys()].filter((k) => !rolesWithKras.has(k));
  const ungrouped = [...linesOfRole].filter(([, r]) => r.ungrouped.length);
  counts.kraFileRoles = kraFile ? kraFile.roles.length : 0;
  counts.kraDefinitions = kraDefs.size;
  counts.kraAssignments = kraAssign.length;
  counts.rolesWithKras = rolesWithKras.size;
  counts.rolesWithContentButNoKras = rolesNoKras.length;
  counts.rolesWithoutContent = rolesNoContent.length;
  counts.responsibilitiesGrouped = respAssign.filter((a) => a.kraKey).length;
  counts.kpisGrouped = kpiAssign.filter((a) => a.kraKey).length;
  counts.linesUngrouped = ungrouped.reduce((n, [, r]) => n + r.ungrouped.length, 0);
  counts.kraStaleEntries = kraStale.length;
  const withPurpose = roleGroups.filter((g) => g.purpose);
  const dutiesNoPurpose = roleGroups.filter((g) => !g.purpose && linesOfRole.has(g.key));
  const idleNoPurpose = roleGroups.filter((g) => !g.purpose && !linesOfRole.has(g.key));
  counts.rolesWithPurpose = withPurpose.length;
  counts.rolesPurposeFromTitleOnly = withPurpose.filter((g) => g.purposeBasis === 'title only').length;
  counts.rolesWithDutiesButNoPurpose = dutiesNoPurpose.length;
  if (kraFile) {
    note(`Role purposes: ${withPurpose.length} of ${roleGroups.length} roles have one`,
      `${kraFile.fileName} gives ${withPurpose.length} roles a one-sentence purpose, written to the role verbatim; it is the opening line of the job description. `
      + `${counts.rolesPurposeFromTitleOnly} of them are marked "title only": the chart gives those roles no duties, so the sentence rests on the title, the department and the reporting line and says less. `
      + (dutiesNoPurpose.length ? `NO PURPOSE, though the role has duties: ${dutiesNoPurpose.map((g) => `"${g.title}"`).join(', ')}. ` : 'Every role with duties has one. ')
      + (idleNoPurpose.length ? `No purpose and no duties: ${idleNoPurpose.map((g) => `"${g.title}"`).join(', ')}. ` : '')
      + `A job description counts as ready when the role has a purpose AND at least one KRA, so ${withPurpose.filter((g) => rolesWithKras.has(g.key)).length} roles are ready; `
      + `a role with no duties has no KRA and stays not ready whatever its purpose says.`);
  }
  if (!kraFile) {
    note('No KRA file: every responsibility and KPI is ungrouped',
      `No <chart>.kras.json was found beside the chart (or --no-kras was given), so no key result areas were created and all `
      + `${respAssign.length + kpiAssign.length} role lines are ungrouped. Every role page will say its job description is not ready. `
      + `Nothing is lost — the lines are all there — but they sit under no outcome area.`);
  } else {
    const shared = [...kraDefs.values()].map((d) => [d.name, kraAssign.filter((a) => a.defKey === d.key).length]).filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]);
    note(`Key result areas: ${rolesWithKras.size} roles grouped under ${kraAssign.length} KRAs`,
      `${kraFile.fileName} groups ${counts.responsibilitiesGrouped} of ${respAssign.length} responsibilities and ${counts.kpisGrouped} of `
      + `${kpiAssign.length} KPIs under ${kraAssign.length} KRAs on ${rolesWithKras.size} roles (${kraDefs.size} distinct KRA names). `
      + `KRAs are per role: ${shared.length} names are used by more than one role${shared.length ? ` (${shared.slice(0, 6).map(([n, c]) => `"${n}" x${c}`).join(', ')}${shared.length > 6 ? ', …' : ''})` : ''}, `
      + `and each such name is one definition row that those roles share as a NAME only — renaming it on the KRA master renames it for all of them. `
      + `UNGROUPED — NEEDS A KRA: ${counts.linesUngrouped} line${counts.linesUngrouped === 1 ? '' : 's'}`
      + (ungrouped.length ? ` on ${ungrouped.length} role${ungrouped.length === 1 ? '' : 's'}: `
        + ungrouped.map(([k, r]) => `"${titleOfRole.get(k)}" ${r.ungrouped.length} (${r.ungrouped.slice(0, 2).map((t) => `"${clip(t, 60)}"`).join(', ')}${r.ungrouped.length > 2 ? ', …' : ''})`).join('; ') : '')
      + `. ${rolesNoContent.length} roles carry no duties or KPIs in the chart and so get no KRAs: `
      + `${rolesNoContent.map((g) => `"${g.title}"`).join(', ') || 'none'}.`
      + (rolesNoKras.length ? ` ${rolesNoKras.length} roles HAVE duties and no KRA at all: ${rolesNoKras.map((k) => `"${titleOfRole.get(k)}"`).join(', ')}.` : '')
      + (kraBySeats.length ? ` Found by their seats because the title in the file no longer matches: ${kraBySeats.map((m) => `"${m.from}" -> "${m.to}" (${m.seats})`).join('; ')} — update the file's "role".` : '')
      + (kraFile.forSource && kraFile.forSource !== kraFile.sourceFileName ? ` NOTE: the file says it was written for "${kraFile.forSource}" and this chart is "${kraFile.sourceFileName}"; it was applied anyway, line by line, and whatever no longer fits is listed as stale.` : ''));
    if (kraStale.length) {
      const sr = kraStale.filter((x) => x.what === 'role');
      const sk = kraStale.filter((x) => x.what === 'KRA');
      const sl = kraStale.filter((x) => x.what === 'responsibility' || x.what === 'KPI');
      note(`${kraStale.length} stale entries in the KRA file`,
        `The KRA file names things this chart does not have. They were skipped, not guessed at: `
        + (sr.length ? `${sr.length} role${sr.length === 1 ? '' : 's'} (${sr.map((x) => `"${x.role}", ${x.lines} lines`).join('; ')}). ` : '')
        + (sl.length ? `${sl.length} line${sl.length === 1 ? '' : 's'} (${sl.slice(0, 12).map((x) => `${x.role} / ${x.kra}: ${x.what} "${clip(x.text, 60)}"`).join('; ')}${sl.length > 12 ? '; …' : ''}). ` : '')
        + (sk.length ? `${sk.length} KRA${sk.length === 1 ? '' : 's'} left with no line and so not created (${sk.map((x) => `${x.role} / ${x.kra}`).join('; ')}). ` : '')
        + `A reworded duty shows up twice: stale here, and ungrouped above under its new wording.`);
    }
  }

  // ---- 8. Qualifications ------------------------------------------------
  counts.qualificationLines = nodes.reduce((a, p) => a + (p.quals || []).length, 0);
  note('Still no qualifications',
    `\`quals[]\` is empty on all ${nodes.length} nodes, exactly as it was in V12. The import path exists and wrote nothing. `
    + `Qualification requirements are what makes a JD usable for hiring, so this is the biggest remaining gap in the `
    + `role content — and it is a gap in the source, not in the import.`);

  // ---- 9. People --------------------------------------------------------
  const peopleRows = real.flatMap((p) => (p.people || []).map((x) => ({ node: p, person: x })));
  const named = peopleRows.filter((r) => norm(r.person.name));
  const blanks = peopleRows.filter((r) => !norm(r.person.name));
  const seen = new Map();                     // normKey(name) -> { code, rows: [] }
  const employees = [];
  let code = 0;
  for (const r of named) {
    const key = normKey(r.person.name);
    let emp = seen.get(key);
    if (!emp) {
      emp = { key, name: norm(r.person.name), code: `KP${String(++code).padStart(4, '0')}`, titles: new Set(), rows: [] };
      seen.set(key, emp);
      employees.push(emp);
    }
    if (norm(r.person.ttl)) emp.titles.add(norm(r.person.ttl));
    emp.rows.push(r);
  }
  const dupes = employees.filter((e) => e.rows.length > 1);
  counts.peopleRows = peopleRows.length;
  counts.employees = employees.length;
  counts.assignments = named.length;
  counts.blankSeatsSkipped = blanks.length;
  counts.vacancies = sanctioned - named.length;
  for (const e of dupes) {
    note('Same person in two places',
      `"${e.name}" appears under ${e.rows.length} chart nodes (${e.rows.map((r) => r.node.id).join(', ')}). Kept as ONE employee with `
      + `one work assignment per seat; the first is marked primary.`);
  }
  note('Blank seats are not people',
    `${blanks.length} of the ${peopleRows.length} "people" rows have no name. They are seat markers recording a shift `
    + `and an attendance state for an unfilled seat, so they were NOT imported as employees. The seats they stood for `
    + `survive as sanctioned headcount and as the day/night manpower requirements. `
    + `${blanks.filter((b) => b.person.status === 'A').length} of them carried an "absent" mark, which is discarded — `
    + `an absence needs a person.`);
  // A courtesy title goes in its own column, verbatim. Not into the name (a
  // prefix glued in cannot be taken out again) and not into `gender` (reading
  // 'Ms.' as female is an inference, and this records what was written).
  for (const e of employees) e.salutation = e.titles.size === 1 ? [...e.titles][0] : null;
  const conflicted = employees.filter((e) => e.titles.size > 1);
  if (conflicted.length) {
    note('One person, two different courtesy titles',
      conflicted.map((e) => `"${e.name}" is written as ${[...e.titles].join(' and ')} on different seats`).join('; ')
      + `. Neither was written to \`salutation\`, because picking one would be a guess. Set it on the People screen.`);
  }
  const titled = named.filter((r) => norm(r.person.ttl));
  if (titled.length) {
    note('Courtesy titles now have a column of their own',
      `${titled.length} of the ${named.length} named people carry a \`ttl\` (${[...new Set(named.map((r) => norm(r.person.ttl)).filter(Boolean))].join(' / ')}); the other `
      + `${named.length - titled.length} carry none. They are written verbatim into \`hrms_employees.salutation\`, a column added for `
      + `them — "Mr." stays "Mr.", because normalising it would be editing the client's data to no purpose. Two `
      + `columns were deliberately not used. Not \`full_name\`: a name is not a form of address, and full_name is what `
      + `this importer's duplicate-person check keys on, what the people list indexes and sorts by, and what a letter `
      + `template prefixes with a salutation of its own — glued in, it could never be taken out again without guessing `
      + `where the name starts. Not \`gender\`: reading "Ms." as female is an inference, and an import that guesses `
      + `about people is the one thing this migration was built not to do. The titles are also kept in this run's id `
      + `map (\`personTitles\`) as the provenance record.`);
  }
  const over = positions.filter((pos) => {
    const n = (pos.node.people || []).filter((x) => norm(x.name)).length;
    return n > (pos.node.shift === 'DN' ? 2 : 1) * pos.req;
  });
  if (over.length) {
    const headOf = (pos) => (pos.node.people || []).filter((x) => norm(x.name)).length;
    const worst = [...over].sort((a, b) => headOf(b) - headOf(a))[0];
    note(`${over.length} seats hold more people than the seat is sanctioned for`,
      over.map((pos) => `${pos.node.id} "${norm(pos.node.title)}" has ${headOf(pos)} people against `
        + `req ${pos.req} on ${pos.node.shift}`).join('; ')
      + `. Both numbers are imported as the chart states them: the people become work assignments, and `
      + `sanctioned_headcount stays at \`req\`, so these positions read as over-filled. Either \`req\` understates the `
      + `seat or those people are a pool covering several machines. ${worst.node.id} "${norm(worst.node.title)}" with `
      + `${headOf(worst)} is the one to start with.`);
  }

  // ---- 10. Attendance ---------------------------------------------------
  // One row per person per date per shift: the unique key says so, and a person
  // in two seats is still one person having one day.
  const attendance = employees.map((e) => ({
    empKey: e.key,
    shift: norm(e.rows[0].person.shift) || 'G',
    status: e.rows[0].person.status === 'A' ? 'ABSENT' : 'PRESENT',
  }));
  counts.attendance = attendance.length;
  note('Attendance is a single day',
    `Attendance was imported for ${attendance.length} named people on ${chartDate} only, because that is all the chart holds. `
    + `It is a snapshot, not history. Every named person in this file is marked present; all `
    + `${blanks.filter((b) => b.person.status === 'A').length} absences sit on blank seat markers and are discarded, so this table says nothing `
    + `useful yet. It is written for completeness and because the shape has to be right before real attendance arrives.`);

  // ---- 11. Open points --------------------------------------------------
  const openOrg = (seed.meta?.openPoints || []).map(norm).filter(Boolean);
  const openNode = real.flatMap((p) => (p.open || []).map(norm).filter(Boolean).map((d) => ({ nodeId: p.id, description: d })));
  counts.openPoints = openOrg.length + openNode.length;
  const areas = [...new Set(openOrg.map((t) => (/^\[([^\]]+)\]/.exec(t) || [, null])[1]).filter(Boolean))];
  const ownerless = openOrg.filter((t) => /owner to be decided/i.test(t)).length;
  note('Open points: the client closed almost all of them',
    `V12 carried 96 open points on nodes and 15 organisation-wide. V28 carries ${openNode.length} on nodes and ${openOrg.length} `
    + `organisation-wide — the client worked through them, and the editor they use has an "add this as a KRA and remove `
    + `the doubt everywhere" action, which is where the other 96 went: the questions were answered as responsibility `
    + `lines on named seats and the question text was consumed. ${ownerless} of the ${openOrg.length} that remain say `
    + `"owner to be decided"${areas.length ? `, across ${areas.join(', ')}` : ''}. They import as ORGANIZATION open points because `
    + `no position owns them yet. NOTE for a tenant that already holds the V12 import: those 111 rows are the only `
    + `surviving record of what was asked, and a --wipe re-import deletes them. Read the findings before replacing a `
    + `live tenant.`);

  // ---- 11b. What this revision changed about the organisation ------------
  // Keyed on the node id, which is the only stable key across revisions: both
  // versions derive `position_code` from it. The seat is the same seat; the job
  // on it may have been rewritten, and that is what a reader has to know,
  // because anything recorded against the OLD title may have gone stale.
  if (prev) {
    const prevById = new Map((prev.positions || []).filter((x) => x.kind !== 'machine').map((x) => [x.id, x]));
    const kept = [], renamed = [], added = [], dropped = [];
    for (const n of real) {
      const was = prevById.get(n.id);
      if (!was) { added.push(n); continue; }
      (normKey(was.title) === normKey(n.title) ? kept : renamed).push({ id: n.id, from: norm(was.title), to: norm(n.title) });
    }
    for (const [id, was] of prevById) if (!byId.has(id)) dropped.push({ id, title: norm(was.title) });
    counts.seatsKept = kept.length;
    counts.seatsRenamed = renamed.length;
    counts.seatsAdded = added.length;
    counts.seatsDropped = dropped.length;
    note(`${renamed.length} seats kept their place in the chart and changed their job title`,
      `Against the previous revision (${prevById.size} seats, this one has ${real.length}): ${kept.length} seats are unchanged in both `
      + `code and title, ${renamed.length} kept the code and were given a different title, ${added.length} are new and `
      + `${dropped.length} are gone. THE RENAMES, old -> new: `
      + renamed.map((r) => `${r.id} "${r.from}" -> "${r.to}"`).join('; ')
      + `. This is the list to read before trusting anything recorded against the old titles — a note, a question or a `
      + `job description written for "${renamed[0]?.from}" was not written for "${renamed[0]?.to}". Note what the code `
      + `still tells apart and the title no longer does: `
      + (() => {
        const collapsed = new Map();
        for (const r of renamed) { const k = normKey(r.to); if (!collapsed.has(k)) collapsed.set(k, []); collapsed.get(k).push(r); }
        const worst = [...collapsed.values()].filter((v) => v.length > 1).sort((a, b) => b.length - a.length)[0];
        if (!worst) return 'no two renamed seats landed on the same title.';
        const froms = [...new Set(worst.map((r) => `"${r.from}"`))];
        return `${worst.length} seats (${worst.map((r) => r.id).join(', ')}) are now all "${worst[0].to}", where they were `
          + `${froms.length === 1 ? `all ${froms[0]}` : froms.join(', ')}.`;
      })()
      + (dropped.length ? ` The ${dropped.length} gone: ${dropped.map((d) => `${d.id} "${d.title}"`).join('; ')} — nothing in this chart `
        + `replaces them by code.` : ''));
  } else {
    note('No previous revision to compare against',
      `The title-change list could not be produced because the earlier chart was not found beside this one. Put `
      + `Org_Chart_V12.html in the TM root, or pass --previous=<path>, and the report will name every seat whose job `
      + `title changed. Without it there is no way to tell a renamed seat from an unchanged one.`);
  }

  // ---- 12. What V28 holds and this model does not take -----------------
  const salNodes = nodes.filter((n) => n.sal && (Number(n.sal.min) > 0 || Number(n.sal.max) > 0));
  const bandNodes = nodes.filter((n) => norm(n.band));
  const catNodes = nodes.filter((n) => norm(n.cat));
  counts.droppedSalaryBands = salNodes.length;
  counts.droppedBands = bandNodes.length;
  counts.droppedCategories = catNodes.length;
  note('Pay data is dropped on purpose',
    `V28 added three pay fields and none is imported, because payroll is out of V1 and there are no columns for them — `
    + `storing them in a JSON blob would be worse than not storing them. What was dropped, exactly: \`sal\` (a `
    + `{min,max} band) carries a figure on ${salNodes.length} of ${nodes.length} nodes `
    + `(${salNodes.map((n) => `${n.id} ${n.sal.min}-${n.sal.max}`).join(', ') || 'none'}) and is empty on the rest; \`band\` is set on `
    + `${bandNodes.length} nodes (values ${[...new Set(bandNodes.map((n) => norm(n.band)))].sort().join(', ')}); \`cat\` is set on `
    + `${catNodes.length} nodes (${[...new Set(catNodes.map((n) => norm(n.cat)))].join('/')}, which the file's own settings expand to `
    + `${(seed.settings?.cats || []).map((c) => c.name).join('/')}). Every person row also has a \`sal\` field and all 83 are empty. `
    + `Nothing here is recoverable from the database afterwards — re-import from the file when there is somewhere to put it.`);
  const sharedWith = nodes.filter((n) => Array.isArray(n.sharedWith) && n.sharedWith.length);
  if (sharedWith.length) {
    note('"Shared with" names people; a department is coarser',
      sharedWith.map((n) => `${n.id} "${norm(n.title)}" (reports to ${n.reportsTo}) is marked shared with `
        + `${n.sharedWith.map((id) => `${id} ${norm(nodes.find((x) => x.id === id)?.title || '?')}`).join(', ')}`).join('; ')
      + `. Where each went is in the shared-seat finding. A department is coarser than a list of people: no table holds seat-to-seat sharing, and it is not a reporting line, so the names themselves were not written anywhere.`);
  }
  if (seed.meta?.letter) {
    const l = seed.meta.letter;
    note('The letter block is recorded on the run only',
      `V28 added \`meta.letter\`: effective ${norm(l.eff)}, letter dated ${norm(l.date)}, signed by ${norm(l.sn)}, ${norm(l.sd)}. `
      + `This is appointment-letter furniture and no table owns it — hrms_generated_documents stores a rendered `
      + `document and its snapshot, not the standing defaults a render should use. It is kept in this run's `
      + `parsed counts so the values are not lost, and it should become part of the document template settings when `
      + `Phase 7's templates get configuration.`);
  }
  note('Chart layout and identifiers are not data',
    `Four source fields are ignored by design: \`arrange\` (how the tool draws children), \`id\` on each person row (the `
    + `tool's own row key — stable, but hrms_employees has no external_ref column to hold it, so people are matched by `
    + `name), \`settings\` (colours and the four-row operator template) and \`view\`. Node ids ARE kept: they are the `
    + `position codes, the department codes (a unit by its heading seat, a machine by its own node) and the role codes, which is what lets `
    + `verify-against-source.mjs tie a row back to the chart.`);

  return {
    chartDate, nodes, byId, real, machines, departments, serves, deptKeyByNode, sharedDecisions, roleGroups, roleKeyOf,
    adjustments: adj ? { fileName: adj.fileName, hash: adj.hash, count: adjEntries.length, entries: adjEntries } : null,
    positions, manpower, edges,
    respDefs, respAssign, kpiDefs, kpiAssign,
    kraDefs, kraAssign, kras: kraFile ? { fileName: kraFile.fileName, hash: kraFile.hash } : null,
    employees, named, blanks, attendance, openOrg, openNode,
    counts, findings, meta: seed.meta || {}, settings: seed.settings || {},
  };
}

// ========================================================= COMMIT =========

/**
 * Every ENUM in the schema, read from the database rather than copied into a
 * list here that would drift.
 *
 * WHY THIS EXISTS. The V12 run wrote `status: 'committed'` into
 * hrms_import_runs, lower case. MySQL's default collation is case-insensitive,
 * so locally it landed as COMMITTED and nothing looked wrong. TiDB's is not:
 * production stored the EMPTY STRING — the value MySQL uses for "not a member
 * of this enum" — and because the script also ran with sql_mode = "" nothing
 * complained. It stayed invisible until a restore of that snapshot into a
 * freshly built schema died on the row. Two fixes, both here:
 *   * the session runs STRICT, so a truncation is an error and not a shrug;
 *   * every value this script writes into an ENUM is checked against the
 *     column's declared members, case included, before the INSERT.
 * TiDB has CHECK constraints disabled, so this is the only enforcement there is.
 */
async function loadEnums(conn) {
  const [rows] = await conn.query(
    `SELECT TABLE_NAME t, COLUMN_NAME c, COLUMN_TYPE ct
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND DATA_TYPE = 'enum' AND TABLE_NAME LIKE 'hrms\\_%'`);
  const map = new Map();
  for (const r of rows) {
    const members = [...String(r.ct).matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'"));
    map.set(`${String(r.t).toLowerCase()}.${String(r.c).toLowerCase()}`, new Set(members));
  }
  if (!map.size) throw new Error('Could not read the hrms_ ENUM definitions from information_schema.');
  return map;
}

function makeDb(conn, companyId, enums) {
  const ins = async (table, row) => {
    const cols = Object.keys(row);
    for (const col of cols) {
      const allowed = enums.get(`${table.toLowerCase()}.${col.toLowerCase()}`);
      const v = row[col];
      if (!allowed || v === null || v === undefined) continue;
      if (!allowed.has(String(v))) {
        throw new Error(`${table}.${col} is an ENUM and "${v}" is not one of its values `
          + `(${[...allowed].join(', ')}). Case matters: TiDB compares these case-sensitively and stores a `
          + `non-member as the empty string.`);
      }
    }
    const [r] = await conn.execute(
      `INSERT INTO ${table} (company_id, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})`,
      [companyId, ...cols.map((c) => row[c])],
    );
    return r.insertId;
  };
  return { ins };
}

const WIPE_ORDER = [
  'hrms_attendance_records', 'hrms_work_assignment_contexts', 'hrms_assignment_reporting_relationships',
  'hrms_work_assignment_content_overrides', 'hrms_work_assignments', 'hrms_employment_events',
  'hrms_employee_identifiers', 'hrms_employee_documents', 'hrms_employees',
  'hrms_manpower_requirements', 'hrms_position_reporting_relationships', 'hrms_position_work_contexts',
  'hrms_position_content_overrides', 'hrms_positions',
  'hrms_role_responsibility_assignments', 'hrms_role_kpi_assignments', 'hrms_role_kra_assignments',
  'hrms_roles', 'hrms_responsibility_definitions', 'hrms_kpi_definitions', 'hrms_kra_definitions',
  'hrms_qualification_definitions', 'hrms_open_points', 'hrms_work_contexts',
  'hrms_department_serves', 'hrms_departments', 'hrms_locations', 'hrms_import_runs',
];

async function main() {
  announce(TARGET);
  if (WIPE && TARGET.isProd) {
    throw new Error("--wipe is refused against production. Deleting a live tenant's rows is not something a convenience flag should do; write a deliberate script if you really mean it.");
  }

  const source = resolveSource();
  const { seed, hash, size, fileName } = readSeed(source);
  console.log(`  source: ${source}\n          ${size.toLocaleString()} bytes, sha256 ${hash.slice(0, 12)}…`);

  // Read only to report what changed between the revisions. Nothing from it is
  // ever written, so a missing previous chart costs one finding, not the import.
  const prevPath = resolveSource(process.argv, PREVIOUS_FILE_NAME, { flag: 'previous', optional: true });
  const prev = prevPath ? readSeed(prevPath).seed : null;
  console.log(`  compared with: ${prevPath || '(not found — the title-change list will be skipped)'}\n`);

  // Decisions the chart cannot express. Optional; found beside the source.
  const adjPath = resolveAdjustments(source);
  const adj = adjPath ? { ...readAdjustments(adjPath), sourceFileName: fileName } : null;
  console.log(`  adjustments: ${adj ? `${adjPath}\n               ${adj.entries.length} entries, sha256 ${adj.hash.slice(0, 12)}…` : '(none — the chart alone)'}\n`);

  // The outcome areas, written by a person. Optional; found beside the source.
  const kraPath = resolveKras(source);
  const kraFile = kraPath ? { ...readKras(kraPath), sourceFileName: fileName } : null;
  console.log(`  kras: ${kraFile ? `${kraPath}\n        ${kraFile.roles.length} roles, sha256 ${kraFile.hash.slice(0, 12)}…` : '(none — every line imports ungrouped)'}\n`);

  const p = plan(seed, prev, adj, kraFile);

  const conn = await mysql.createConnection(TARGET.cfg);
  // STRICT, deliberately. The previous version ran with sql_mode = "" and that
  // is half of why a bad enum value reached production unnoticed — see
  // loadEnums(). A truncation here should stop the import, not be absorbed.
  await conn.query("SET SESSION sql_mode = 'STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION'");
  const [[company]] = await conn.query('SELECT id, name FROM companies WHERE slug = ? AND deleted_at IS NULL', [COMPANY_SLUG]);
  if (!company) throw new Error(`No company with slug "${COMPANY_SLUG}". Create it first.`);
  const companyId = company.id;
  const enums = await loadEnums(conn);
  const { ins } = makeDb(conn, companyId, enums);

  if (DRY) {
    printReport(company, p, { dry: true });
    await conn.end();
    return;
  }

  // A second run that is not a wipe would not "update" anything — it would
  // insert a parallel copy of the chart and trip a unique key somewhere in the
  // middle, leaving half a tenant. Refuse instead of half-doing it.
  const [[existing]] = await conn.query(
    'SELECT (SELECT COUNT(*) FROM hrms_positions WHERE company_id=? AND deleted_at IS NULL) AS positions,'
    + ' (SELECT COUNT(*) FROM hrms_employees WHERE company_id=? AND deleted_at IS NULL) AS employees',
    [companyId, companyId]);
  if (!WIPE && (existing.positions || existing.employees)) {
    throw new Error(
      `${company.name} already holds ${existing.positions} positions and ${existing.employees} employees. This script writes a whole `
      + `chart, it does not reconcile one: run it with --wipe to replace them, or point it at an empty tenant. (Re-running `
      + `without --wipe is the exact failure verify-against-source.mjs hunts for, so it is refused here rather than `
      + `found there.)`);
  }

  if (WIPE) {
    await conn.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const t of WIPE_ORDER) await conn.execute(`DELETE FROM ${t} WHERE company_id = ?`, [companyId]);
    await conn.query('SET FOREIGN_KEY_CHECKS = 1');
  }

  const [shiftRows] = await conn.execute('SELECT id, code FROM hrms_shifts WHERE company_id = ? AND deleted_at IS NULL', [companyId]);
  const shiftByCode = new Map(shiftRows.map((s) => [s.code, s.id]));
  if (!shiftByCode.size) throw new Error('No shifts for this company — run models/seed.sql first.');
  const [typeRows] = await conn.execute('SELECT id, code FROM hrms_reporting_relationship_types WHERE company_id = ? AND deleted_at IS NULL', [companyId]);
  const typeByCode = new Map(typeRows.map((t) => [t.code, t.id]));
  if (!typeByCode.has('PRIMARY_MANAGER')) throw new Error('Reporting types missing — run models/seed.sql first.');
  const shiftId = (c) => shiftByCode.get(c) ?? shiftByCode.get('G');

  // From here on rows exist. If anything throws now, the tenant holds half a
  // chart and that has to be recorded as a FAILED run rather than left silent.
  RUN_CONTEXT = { conn, companyId, fileName, hash, size, wrote: true };

  // ---- 1. Location -----------------------------------------------------
  // The chart's subtitle is the only place the site is named.
  const locationId = await ins('hrms_locations', {
    code: 'UNIT2', name: norm(p.meta.subtitle || '').replace(/^Organisation chart,\s*/i, '') || 'Unit 2',
    location_type: 'PLANT', status: 'ACTIVE',
  });

  // ---- 2. Departments, parents first (plan() sorted them) ----------------
  // Units, machines and shared crews alike. `department_type` is a label only.
  const deptByKey = new Map();
  for (const d of p.departments) {
    deptByKey.set(d.key, await ins('hrms_departments', {
      code: d.code,
      name: clip(d.name, 200),
      parent_department_id: d.parentKey ? deptByKey.get(d.parentKey) : null,
      department_type: d.type,
      is_shared: d.isShared,
      status: 'ACTIVE',
    }));
  }
  for (const sv of p.serves) {
    await ins('hrms_department_serves', {
      department_id: deptByKey.get(sv.deptKey), serves_department_id: deptByKey.get(sv.servesKey),
    });
  }
  const deptOfNode = (nodeId) => {
    const key = p.deptKeyByNode.get(nodeId);
    return key ? deptByKey.get(key) : null;
  };

  // ---- 3. (was: work contexts) ------------------------------------------
  // Nothing. A machine is a department now; hrms_work_contexts and
  // hrms_position_work_contexts are left in the schema and not written.

  // ---- 4. Roles --------------------------------------------------------
  const roleByKey = new Map();
  for (const g of p.roleGroups) {
    roleByKey.set(g.key, await ins('hrms_roles', {
      role_code: g.code, title: clip(g.title, 200), role_purpose: g.purpose ?? null, status: 'ACTIVE', effective_from: p.chartDate,
    }));
  }

  // ---- 4b. KRAs: one definition per name, one assignment per role + KRA ---
  // Written before the content they group, so each responsibility and KPI row
  // can be inserted already pointing at its KRA. `sequence` is the file's order.
  const kraDefByKey = new Map();
  for (const d of p.kraDefs.values()) {
    kraDefByKey.set(d.key, await ins('hrms_kra_definitions', { name: d.name, status: 'ACTIVE' }));
  }
  const kraAsgByKey = new Map();              // roleKey|kraKey -> hrms_role_kra_assignments.id
  for (const a of p.kraAssign) {
    kraAsgByKey.set(`${a.roleKey}|${a.defKey}`, await ins('hrms_role_kra_assignments', {
      role_id: roleByKey.get(a.roleKey), kra_definition_id: kraDefByKey.get(a.defKey),
      is_mandatory: 1, sequence: a.sequence, effective_from: p.chartDate,
      // A description in the file is this ROLE's reading of the area, so it
      // goes on the role's row; the definition is shared by name.
      notes: a.description,
    }));
  }
  // A line's KRA is always a KRA of its OWN role: the key carries the role.
  const kraOf = (a) => (a.kraKey ? kraAsgByKey.get(`${a.roleKey}|${a.kraKey}`) ?? null : null);

  // ---- 5. Positions ----------------------------------------------------
  const posByNode = new Map();
  for (const pos of p.positions) {
    posByNode.set(pos.node.id, await ins('hrms_positions', {
      position_code: pos.node.id,
      role_id: roleByKey.get(pos.roleKey),
      position_title: clip(norm(pos.node.title), 200),
      department_id: deptOfNode(pos.node.id),
      location_id: locationId,
      sanctioned_headcount: pos.req,
      default_shift_id: pos.shift ? shiftId(pos.shift) : null,
      status: 'ACTIVE', effective_from: p.chartDate,
    }));
  }

  // ---- 7. Formal reporting ---------------------------------------------
  for (const e of p.edges) {
    await ins('hrms_position_reporting_relationships', {
      from_position_id: posByNode.get(e.fromId), to_position_id: posByNode.get(e.toId),
      relationship_type_id: typeByCode.get(e.type), is_primary: e.isPrimary, scope_type: 'GENERAL',
      effective_from: p.chartDate, notes: e.notes,
    });
  }

  // ---- 8. Manpower for the day/night positions -------------------------
  for (const m of p.manpower) {
    await ins('hrms_manpower_requirements', {
      position_id: posByNode.get(m.nodeId), role_id: roleByKey.get(m.roleKey),
      shift_id: shiftByCode.get(m.shift), required_count: m.count, effective_from: p.chartDate,
      notes: 'Day/night position: the chart required this many people per shift.',
    });
  }

  // ---- 9. Responsibilities ---------------------------------------------
  const respByKey = new Map();
  for (const d of p.respDefs.values()) {
    respByKey.set(d.key, await ins('hrms_responsibility_definitions', {
      name: clip(d.text, 250), description: d.text, status: 'ACTIVE',
    }));
  }
  for (const a of p.respAssign) {
    await ins('hrms_role_responsibility_assignments', {
      role_id: roleByKey.get(a.roleKey), responsibility_definition_id: respByKey.get(a.defKey),
      role_kra_assignment_id: kraOf(a),
      is_mandatory: 1, sequence: a.sequence, effective_from: p.chartDate,
    });
  }

  // ---- 10. KPIs --------------------------------------------------------
  const kpiByKey = new Map();
  for (const d of p.kpiDefs.values()) {
    kpiByKey.set(d.key, await ins('hrms_kpi_definitions', {
      name: d.name, description: d.description || null,
      measurement_type: 'TEXT', status: 'ACTIVE',
    }));
  }
  for (const a of p.kpiAssign) {
    await ins('hrms_role_kpi_assignments', {
      role_id: roleByKey.get(a.roleKey), kpi_definition_id: kpiByKey.get(a.defKey),
      role_kra_assignment_id: kraOf(a),
      // The TEXT shape roleContentService.validateTarget writes: a JSON string.
      target_operator: a.target ? 'EQ' : 'INFO',
      target_value: a.target ? JSON.stringify(a.target) : null,
      is_mandatory: 1, sequence: a.sequence, effective_from: p.chartDate,
      notes: a.notes,
    });
  }

  // ---- 11. People ------------------------------------------------------
  const empByKey = new Map();
  for (const e of p.employees) {
    empByKey.set(e.key, await ins('hrms_employees', {
      employee_code: e.code, full_name: e.name, salutation: e.salutation,
      date_of_joining: p.chartDate,
      employment_type: 'EMPLOYEE', employment_status: 'ACTIVE',
    }));
  }
  const asgByEmp = new Map();
  for (const e of p.employees) {
    for (const [i, r] of e.rows.entries()) {
      const id = await ins('hrms_work_assignments', {
        employee_id: empByKey.get(e.key),
        role_id: roleByKey.get(p.roleKeyOf(r.node)),
        position_id: posByNode.get(r.node.id),
        department_id: deptOfNode(r.node.id),
        location_id: locationId,
        allocation_percent: 100,
        is_primary: i === 0 ? 1 : 0,
        default_shift_id: shiftId(norm(r.person.shift) || 'G'),
        status: 'ACTIVE', effective_from: p.chartDate,
        reason: `Imported from ${fileName}`,
      });
      if (i === 0) asgByEmp.set(e.key, id);
    }
  }
  for (const a of p.attendance) {
    await ins('hrms_attendance_records', {
      employee_id: empByKey.get(a.empKey), attendance_date: p.chartDate,
      shift_id: shiftId(a.shift), status: a.status,
      source: 'IMPORT', work_assignment_id: asgByEmp.get(a.empKey),
      notes: 'Point-in-time state from the org chart, not attendance history.',
    });
  }

  // ---- 12. Open points --------------------------------------------------
  for (const d of p.openOrg) {
    await ins('hrms_open_points', { entity_type: 'ORGANIZATION', entity_id: null, description: d, status: 'OPEN' });
  }
  for (const o of p.openNode) {
    await ins('hrms_open_points', {
      entity_type: 'POSITION', entity_id: posByNode.get(o.nodeId), description: o.description, status: 'OPEN',
    });
  }

  // ---- 13. Record the run ----------------------------------------------
  const idMap = {
    departments: Object.fromEntries(p.departments.map((d) => [d.code, deptByKey.get(d.key)])),
    positions: Object.fromEntries(posByNode),
    sharedSeats: p.sharedDecisions,
    adjustments: p.adjustments?.entries ?? [],
    roles: Object.fromEntries(roleByKey),
    employees: Object.fromEntries(p.employees.map((e) => [e.code, empByKey.get(e.key)])),
    // The one V28 field with nowhere to live. Kept here so it survives the run.
    personTitles: Object.fromEntries(p.employees.filter((e) => e.titles.size).map((e) => [e.name, [...e.titles].join(' / ')])),
  };
  // `status` is written explicitly, in the exact case the ENUM declares, and the
  // three stage timestamps are all set because this script does parse, validate
  // and commit in one pass — the UI version (routes/imports.js) will stop between
  // them and write PARSED, then VALIDATED, then COMMITTED on its own rows.
  // The DATABASE's own clock, not a JS Date. mysql2 renders a Date in the
  // machine's zone, so a run committed from an IST laptop recorded 23:27 beside
  // created_at/updated_at of 17:57 on TiDB (which runs UTC), and a 'what changed
  // since the import' query silently missed five and a half hours of edits
  // (2026-10-09). UTC text would not do either: local MySQL runs IST. NOW() in
  // this session is the clock that fills created_at, wherever that is.
  const now = await dbNow(conn);
  await ins('hrms_import_runs', {
    source_kind: 'ORG_CHART_HTML', source_file_name: fileName,
    source_hash: hash, source_size_bytes: size, status: 'COMMITTED',
    // The adjustments file's hash sits beside the source's: together they are
    // what this tenant was built from, and the verifier checks both.
    parsed_counts_json: JSON.stringify({
      ...p.counts, chartDate: p.chartDate, letter: p.meta.letter ?? null,
      adjustmentsFile: p.adjustments?.fileName ?? null, adjustmentsHash: p.adjustments?.hash ?? null,
      // ... and the KRA file's, for the same reason: chart + adjustments + KRAs
      // are the three things this tenant's content was built from.
      krasFile: p.kras?.fileName ?? null, krasHash: p.kras?.hash ?? null,
    }),
    findings_json: JSON.stringify(p.findings),
    id_map_json: JSON.stringify(idMap),
    parsed_at: now, validated_at: now, committed_at: now,
    notes: `Imported by scripts/import-org-chart.mjs into company ${COMPANY_SLUG}.`
      + (p.adjustments ? ` With ${p.adjustments.count} adjustments from ${p.adjustments.fileName} (sha256 ${p.adjustments.hash}).` : ' No adjustments file.')
      + (p.kras ? ` KRAs from ${p.kras.fileName} (sha256 ${p.kras.hash}).` : ' No KRA file.'),
  });

  RUN_CONTEXT = null;
  printReport(company, p, { dry: false });
  await conn.end();
}

function printReport(company, p, { dry }) {
  console.log(dry
    ? `=== DRY RUN — nothing written. This is what would go into ${company.name} (id ${company.id}) ===`
    : `=== Imported into ${company.name} (id ${company.id}) ===`);
  for (const [k, v] of Object.entries(p.counts)) console.log(`  ${k.padEnd(26)} ${v}`);
  console.log(`\n=== ${p.findings.length} findings for review ===`);
  p.findings.forEach((f, i) => console.log(`\n${i + 1}. ${f.kind}\n   ${f.detail.replace(/\s+/g, ' ')}`));
}

/**
 * A half-written tenant must say so. If the commit throws after the first row,
 * the run is recorded as FAILED with the error in words, so the next person can
 * see that the chart in there is incomplete instead of trusting it.
 */
async function recordFailure(err) {
  if (!RUN_CONTEXT?.wrote) return;
  const { conn, companyId, fileName, hash, size } = RUN_CONTEXT;
  try {
    await conn.execute(
      `INSERT INTO hrms_import_runs (company_id, source_kind, source_file_name, source_hash, source_size_bytes,
                                     status, error_text, parsed_at, validated_at, notes)
       VALUES (?, 'ORG_CHART_HTML', ?, ?, ?, 'FAILED', ?, ?, ?, ?)`,
      [companyId, fileName, hash, size, String(err?.message ?? err).slice(0, 4000), await dbNow(conn), await dbNow(conn),
        'Partial write: rows were created before this failed, so the tenant holds an incomplete chart. Re-run with --wipe.'],
    );
    console.error('\n  Recorded a FAILED import run. The tenant holds a partial chart — re-run with --wipe.');
  } catch {
    // The connection may be the thing that broke. Saying so is all we can do.
    console.error('\n  The import failed AFTER writing rows and the failure could not be recorded. The tenant holds a partial chart.');
  }
}

main().catch(async (e) => { await recordFailure(e); console.error(e); process.exit(1); });
