/**
 * Does what is in the database actually match Org_Chart_V28.html?
 *
 * WHY THIS IS NOT THE SAME AS THE IMPORT'S OWN REPORT. The importer prints
 * counts it computed while writing, and afterwards we counted rows and got the
 * same numbers. That is the database agreeing with itself, and with the process
 * that filled it. It cannot catch a value that was written wrong, only a row
 * that is missing.
 *
 * The cf_erp session hit exactly that on a different import: an interrupted run
 * was resumed, the resumed pass wrote only what was MISSING, and one part kept a
 * stale thickness — 30 where the source said 25, worth 1,441 kg. Every
 * self-consistency check passed, because they compared the model to itself.
 *
 * So this walks the SOURCE file and asserts, field by field, that the database
 * says the same thing. It is the only check that can fail when the import was
 * subtly wrong rather than incomplete.
 *
 * EVERY CHECK RUNS IN BOTH DIRECTIONS. "Every source item is in the database"
 * catches an incomplete import; "the database holds nothing the source implies"
 * catches a second run that added a parallel copy, and it is the half that is
 * easy to leave out. The walks below are re-derived here rather than imported
 * from the importer on purpose: a shared helper that is wrong is wrong on both
 * sides at once, and then no check can see it. Only the file path and the raw
 * read are shared, so that both scripts provably read the same bytes.
 *
 * THE ADJUSTMENTS FILE is part of the source. Where a person decided something
 * the chart cannot say (one box is three machines; this crew serves those two;
 * this seat is not shared), the expectation is chart + adjustments, and it is
 * derived here from the file's own entries, not from anything the importer
 * computed. Only the path rule and the raw read are shared, as for the chart.
 *
 *   node verify-against-source.mjs --company=karni [--target=prod] [--source=<path>]
 *                                  [--adjustments=<path> | --no-adjustments]
 *
 * Read-only. Exits 1 on any mismatch.
 */
import mysql from 'mysql2/promise';
import { resolveTarget, announce } from './dbTarget.mjs';
import { resolveSource, readSeed, resolveAdjustments, readAdjustments } from './orgChartSource.mjs';

const TARGET = resolveTarget();
const args = process.argv.slice(2);
const COMPANY_SLUG = (args.find((a) => a.startsWith('--company=')) || '--company=karni').split('=')[1];

const norm = (s) => String(s ?? '').trim().replace(/\s+/g, ' ');
const normKey = (s) => norm(s).toLowerCase().replace(/[.;,]+$/, '');
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 3)}...` : s);
/** mysql2 hands a DATE back as a local-midnight Date; toISOString would shift it. */
const ymd = (v) => {
  if (v == null) return null;
  if (v instanceof Date) return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  return String(v).slice(0, 10);
};
const fails = [];
const passes = [];
const check = (name, ok, detail) => (ok ? passes.push(name) : fails.push({ name, detail }));

/**
 * Both directions in one check, which is the point — and as MULTISETS, not sets.
 *
 * A set comparison cannot see a duplicate: a second import that inserts a
 * parallel copy leaves exactly the same VALUES and twice as many ROWS, and that
 * is the failure this verifier exists to catch. So `actual` is passed as a plain
 * array straight off the query and the counts have to agree too. `expected` is a
 * Set wherever the model deliberately holds one row for several source entries
 * (a merged role's responsibilities), and an array wherever it holds one per
 * source entry.
 */
const same = (name, expected, actual, show = (x) => x) => {
  const tally = (xs) => { const m = new Map(); for (const x of xs) m.set(x, (m.get(x) || 0) + 1); return m; };
  const e = tally(expected);
  const a = tally(actual);
  const miss = [...e].filter(([k, n]) => (a.get(k) || 0) < n).map(([k, n]) => `${show(k)}${n - (a.get(k) || 0) > 1 ? ` x${n - (a.get(k) || 0)}` : ''}`);
  const extra = [...a].filter(([k, n]) => (e.get(k) || 0) < n).map(([k, n]) => `${show(k)}${n - (e.get(k) || 0) > 1 ? ` (${n} rows, source implies ${e.get(k) || 0})` : ''}`);
  check(name, miss.length === 0 && extra.length === 0,
    `${miss.length} missing${miss.length ? ` (e.g. ${miss.slice(0, 4).join(' | ')})` : ''}`
    + `, ${extra.length} in the db that the source does not imply${extra.length ? ` (e.g. ${extra.slice(0, 4).join(' | ')})` : ''}`);
};

async function main() {
  announce(TARGET);

  const source = resolveSource();
  const { seed, hash, size, fileName } = readSeed(source);
  console.log(`  source: ${source}\n          ${size.toLocaleString()} bytes, sha256 ${hash.slice(0, 12)}…`);
  const adjFile = readAdjustments(resolveAdjustments(source));
  const adjEntries = adjFile?.entries ?? [];
  console.log(`  adjustments: ${adjFile ? `${adjFile.file}\n          ${adjEntries.length} entries, sha256 ${adjFile.hash.slice(0, 12)}…` : '(none — the chart alone)'}\n`);

  const nodes = seed.positions;
  const byId = new Map(nodes.map((p) => [p.id, p]));
  const real = nodes.filter((p) => p.kind !== 'machine');
  const machines = nodes.filter((p) => p.kind === 'machine');
  const chartDate = seed.meta?.date || '2026-09-30';

  // ---- the walks, re-derived ------------------------------------------------
  const managerOf = (p) => { let c = byId.get(p.reportsTo), g = 0; while (c && c.kind === 'machine' && g++ < 50) c = byId.get(c.reportsTo); return c || null; };
  const isUnit = (n) => !!norm(n.dtype);
  const unitName = (n) => norm(n.dept) || norm(n.title);
  // A seat's role is identified by the role its position points at in the
  // database. That is only legitimate because section 4 first proves, from the
  // source alone, that the assignment of seats to roles is right: same role ⇔
  // same title AND same duty list. Every content check after that compares a
  // role's rows with its seats' own lists in the chart.
  const roleKeyByNode = new Map();
  const roleKeyOf = (p) => roleKeyByNode.get(p.id);
  // Independent of the importer's code on purpose: what makes two seats the
  // same kind of work is the chart's own data, and it is re-read here.
  const dutySig = (p) => JSON.stringify([
    [...new Set((p.kras || []).map(norm).filter(Boolean).map(normKey))].sort(),
    [...new Set((p.kpis || []).map((k) => norm(k?.k)).filter(Boolean).map(normKey))].sort(),
  ]);

  const conn = await mysql.createConnection(TARGET.cfg);
  const q = async (sql, p = []) => (await conn.execute(sql, p))[0];
  const [[company]] = await conn.query('SELECT id, name FROM companies WHERE slug = ? AND deleted_at IS NULL', [COMPANY_SLUG]);
  if (!company) throw new Error(`No company "${COMPANY_SLUG}"`);
  const c = company.id;

  // ---- 0. PROVENANCE: is the database holding THIS file? -------------------
  // Without this, a verifier left pointed at the previous version would pass
  // every check it could still find and prove nothing at all.
  //
  // ORG-CHART runs only. hrms_import_runs also records every Excel workbook
  // apply (source_kind EXCEL), and those are legitimate edits made on top of
  // the chart, not a second chart. Counting them made the first workbook apply
  // read as "two charts are mixed in here" (found 2026-10-10, when the workbook
  // suite's --commit case left two EXCEL runs behind). They are reported on a
  // line of their own instead: after one, the database has legitimately moved
  // away from the chart, and content checks below may differ for that reason.
  const allRuns = await q('SELECT source_kind, source_file_name, source_hash, source_size_bytes, status, parsed_counts_json FROM hrms_import_runs WHERE company_id=? AND deleted_at IS NULL ORDER BY id DESC', [c]);
  const runs = allRuns.filter((r) => r.source_kind === 'ORG_CHART_HTML');
  const workbookApplies = allRuns.filter((r) => r.source_kind !== 'ORG_CHART_HTML' && r.status === 'COMMITTED').length;
  if (workbookApplies) {
    console.log(`    note ${workbookApplies} workbook apply run(s) since the chart import — a difference below may be an edit made in Excel, not an import fault`);
  }
  check('exactly one committed org-chart import run', runs.filter((r) => r.status === 'COMMITTED').length === 1,
    `${runs.length} org-chart runs, ${runs.filter((r) => r.status === 'COMMITTED').length} committed — a second committed run means two charts are mixed in here`);
  const run = runs.find((r) => r.status === 'COMMITTED');
  check('the committed run is this exact file', !!run && run.source_hash === hash && run.source_file_name === fileName && Number(run.source_size_bytes) === size,
    run ? `db recorded ${run.source_file_name} sha256 ${String(run.source_hash).slice(0, 12)}… (${run.source_size_bytes} bytes); this file is ${fileName} sha256 ${hash.slice(0, 12)}… (${size} bytes)` : 'no committed run');

  // ... and with THESE adjustments. A tenant imported before a decision was
  // recorded (or after it was changed) is not what chart + file now imply, and
  // every department check below would fail for a reason this states plainly.
  const runCounts = (() => { const v = run?.parsed_counts_json; if (v == null) return {}; if (typeof v === 'string') { try { return JSON.parse(v); } catch { return {}; } } return v; })();
  check('the committed run used this exact adjustments file (or none, if there is none)',
    (runCounts.adjustmentsHash ?? null) === (adjFile?.hash ?? null),
    `the run recorded ${runCounts.adjustmentsHash ? `${runCounts.adjustmentsFile} sha256 ${String(runCounts.adjustmentsHash).slice(0, 12)}…` : 'no adjustments'}; this run reads ${adjFile ? `${adjFile.fileName} sha256 ${adjFile.hash.slice(0, 12)}…` : 'none'}`);
  // The entries, by kind, read straight from the file.
  const splitNames = new Map(adjEntries.filter((a) => a.kind === 'split').map((a) => [a.node, a.into.map(norm)]));
  const decidedShared = adjEntries.filter((a) => a.kind === 'shared');
  const decidedNotShared = new Set(adjEntries.filter((a) => a.kind === 'notShared').map((a) => a.seat));
  const stale = adjEntries.flatMap((a) => [a.node, a.seat, ...(a.seats ?? [])].filter((id) => id !== undefined && !byId.has(id)));
  check('every adjustment names a node this chart still has', stale.length === 0, `not in the chart: ${stale.join(', ')}`);

  // ---- 1. Location --------------------------------------------------------
  const locRows = await q('SELECT id, code, name FROM hrms_locations WHERE company_id=? AND deleted_at IS NULL', [c]);
  const expectedLoc = norm(seed.meta?.subtitle || '').replace(/^Organisation chart,\s*/i, '') || 'Unit 2';
  check('one location, named from the chart subtitle', locRows.length === 1 && norm(locRows[0].name) === expectedLoc,
    `db ${locRows.length} rows${locRows[0] ? ` named "${locRows[0].name}"` : ''}, source subtitle implies "${expectedLoc}"`);
  const locationId = locRows[0]?.id ?? null;

  // ---- 2. DEPARTMENTS: one tree, machines and shared crews included --------
  // Re-derived TOP-DOWN, from the root seat outward, carrying "the department
  // we are inside" down the chart. The importer works the other way (each seat
  // walks UP to its nearest unit), so a mistake in one direction is not
  // repeated in the other. Nothing here is imported from the importer.
  //
  // What the source implies:
  //   * a machine node is a department — except a "... Process" node, which is
  //     only a heading over the one section beneath it;
  //   * a `dtype` seat opens a department — unless it stands directly under a
  //     machine of the same name (it IS that machine), or it carries the name
  //     of the unit already around it (a repeat), or a seat hanging from the
  //     same place already opened a department of that name (one unit, several
  //     senior people);
  //   * every seat belongs to the department it is inside.
  const deptRows = await q('SELECT id, code, name, parent_department_id, department_type, is_shared, status FROM hrms_departments WHERE company_id=? AND deleted_at IS NULL', [c]);
  const deptByCode = new Map(deptRows.map((r) => [r.code, r]));
  const deptById = new Map(deptRows.map((r) => [r.id, r]));
  const serveRows = await q(
    `SELECT s.department_id, s.serves_department_id FROM hrms_department_serves s WHERE s.company_id=? AND s.deleted_at IS NULL`, [c]);

  const childrenOf = new Map();
  for (const n of nodes) {
    const k = byId.has(n.reportsTo) ? n.reportsTo : '';
    if (!childrenOf.has(k)) childrenOf.set(k, []);
    childrenOf.get(k).push(n);
  }
  const childNodes = (id) => childrenOf.get(id) || [];
  const isProcessHeading = (n) => n.kind === 'machine' && /\bprocess$/i.test(norm(n.title));

  // The source shape the "Process" rule rests on. If a later chart breaks it,
  // this fails first and says so, rather than the tree checks failing obscurely.
  const processNodes = machines.filter(isProcessHeading);
  const processBad = processNodes.filter((m) => {
    const ks = childNodes(m.id);
    return ks.length !== 1 || norm(ks[0].dtype) !== 'section';
  });
  check('every "... Process" node is a heading over exactly one section seat', processBad.length === 0,
    processBad.map((m) => `${m.id} "${norm(m.title)}" has ${childNodes(m.id).length} children`).join(' | '));

  const exp = new Map();          // code -> { code, name, parent, kind }
  const expSeat = new Map();      // seat id -> department code
  // Two seats "hang from the same place" when they are inside the same
  // department, whatever seat they report to: P102/P103/P104/P071 all report to
  // a Director who sits in Management, so they share Management's map.
  const siblingMaps = new Map();   // department code ('' for none) -> Map(name -> code)
  const openedIn = (dept) => { const k = dept ?? ''; if (!siblingMaps.has(k)) siblingMaps.set(k, new Map()); return siblingMaps.get(k); };
  const startsDept = new Set();   // seats at which a department starts (its own row, or a namesake's)
  const descend = (n, inside, unitNames) => {
    // `inside`    the department code we are in when we reach n
    // `unitNames` names of the UNIT departments around us, nearest last
    const opened = openedIn(inside);
    let here = inside;
    let names = unitNames;
    if (n.kind === 'machine' && splitNames.has(n.id)) {
      // One box, several departments by decision. Whoever stands under it has
      // to be placed by an adjustment; until then they are "under the split".
      splitNames.get(n.id).forEach((name, i) => exp.set(`${n.id}-${i + 1}`, { code: `${n.id}-${i + 1}`, name, parent: inside, kind: 'machine' }));
      here = `split:${n.id}`;
    } else if (n.kind === 'machine') {
      if (!isProcessHeading(n)) {
        exp.set(n.id, { code: n.id, name: norm(n.title), parent: inside, kind: 'machine' });
        here = n.id;
      }
    } else if (isUnit(n)) {
      const name = unitName(n);
      const parentNode = byId.get(n.reportsTo);
      const isItsMachine = parentNode && parentNode.kind === 'machine' && !isProcessHeading(parentNode) && normKey(parentNode.title) === normKey(name);
      const repeats = unitNames.length && normKey(unitNames[unitNames.length - 1]) === normKey(name);
      if (isItsMachine || repeats) {
        // no department of its own: `here` stays the machine, or the unit around it
      } else if (opened.has(normKey(name))) {
        here = opened.get(normKey(name));
        names = [...unitNames, name];
        startsDept.add(n.id);
      } else {
        exp.set(n.id, { code: n.id, name, parent: inside, kind: norm(n.dtype) });
        startsDept.add(n.id);
        opened.set(normKey(name), n.id);
        here = n.id;
        names = [...unitNames, name];
      }
    }
    if (n.kind !== 'machine') expSeat.set(n.id, here);
    for (const k of childNodes(n.id)) descend(k, here, names);
  };
  for (const root of childNodes('')) descend(root, null, []);

  // ---- shared seats: what a person decided first, then what the chart marks --
  // By decision (adjustments): the listed seats serve the listed departments.
  // By the chart: a shared seat serves the departments of the seats it is
  // `sharedWith` plus its own manager's; or, standing under a machine, that
  // machine alone when the whole crew there is shared (one box drawn for
  // several machines), and otherwise that machine and its neighbours.
  // A seat reporting to a placed seat, with no department starting in between,
  // goes with it. A seat decided "not shared" stays where the tree puts it.
  const sharedKeyOf = (codes) => codes.join('+');
  const expServed = new Map();     // seat id -> sorted department codes it serves
  const customName = new Map();    // served-set key -> a name the adjustment gave
  for (const a of decidedShared) {
    const codes = [...new Set(a.serves)].sort();
    for (const id of a.seats) expServed.set(id, codes);
    if (norm(a.name)) customName.set(sharedKeyOf(codes), norm(a.name));
  }
  const decidedSeats = new Set(expServed.keys());
  /** The nearest seat above that has been given a shared department, unless a department starts first. */
  const leadOf = (p) => {
    let up = byId.get(p.reportsTo), g = 0;
    while (up && g++ < 60) {
      if (up.kind === 'machine' || startsDept.has(up.id)) return null;
      if ((expServed.get(up.id)?.length ?? 0) > 1) return up.id;
      up = byId.get(up.reportsTo);
    }
    return null;
  };
  const sharedSeats = real.filter((p) => p.kind === 'shared');
  const undecidedUnderSplit = [];
  for (const s of sharedSeats) {
    if (decidedSeats.has(s.id)) continue;
    if (decidedNotShared.has(s.id)) { expServed.set(s.id, [expSeat.get(s.id)]); continue; }
    let lead = null;
    { let up = byId.get(s.reportsTo), g = 0; while (up && g++ < 60) { if (up.kind === 'machine' || startsDept.has(up.id)) break; if (decidedSeats.has(up.id)) { lead = up.id; break; } up = byId.get(up.reportsTo); } }
    if (lead) { expServed.set(s.id, expServed.get(lead)); continue; }
    let set;
    if (Array.isArray(s.sharedWith) && s.sharedWith.length) {
      set = [s.reportsTo, ...s.sharedWith].filter((id) => expSeat.has(id)).map((id) => expSeat.get(id));
    } else {
      let m = byId.get(s.reportsTo), g = 0;
      while (m && m.kind === 'shared' && g++ < 50) m = byId.get(m.reportsTo);
      if (!m || m.kind !== 'machine' || isProcessHeading(m)) set = [expSeat.get(s.id)];
      else if (splitNames.has(m.id)) { undecidedUnderSplit.push(s.id); set = [expSeat.get(s.id)]; }
      else {
        const crew = childNodes(m.id).filter((k) => k.kind !== 'machine');
        set = crew.every((k) => k.kind === 'shared')
          ? [m.id]
          : [m.id, ...childNodes(m.reportsTo).filter((k) => k.kind === 'machine' && k.id !== m.id && !isProcessHeading(k) && !splitNames.has(k.id)).map((k) => k.id)];
      }
    }
    expServed.set(s.id, [...new Set(set)].sort());
  }
  // A served set of two or more is a shared department; one is just that department.
  const expSharedSets = new Map();   // key -> codes
  for (const [id, codes] of expServed) if (codes.length > 1) { expSharedSets.set(sharedKeyOf(codes), codes); expSeat.set(id, `shared:${sharedKeyOf(codes)}`); }
  for (const p of real) {
    if (expServed.has(p.id) || startsDept.has(p.id)) continue;
    const lead = leadOf(p);
    if (lead) expSeat.set(p.id, expSeat.get(lead));
  }
  const unplaced = real.filter((p) => String(expSeat.get(p.id)).startsWith('split:'));
  check('every seat under a split machine is placed by an adjustment', unplaced.length === 0 && undecidedUnderSplit.length === 0,
    [...unplaced.map((p) => `${p.id} "${norm(p.title)}" (${expSeat.get(p.id)})`), ...undecidedUnderSplit].slice(0, 8).join(' | '));

  // ---- compare with the database ------------------------------------------
  const plainRows = deptRows.filter((r) => Number(r.is_shared) !== 1);
  const sharedRows = deptRows.filter((r) => Number(r.is_shared) === 1);
  const servesOf = new Map();        // shared dept id -> sorted served codes
  for (const r of sharedRows) servesOf.set(r.id, []);
  const strayServes = [];
  for (const s of serveRows) {
    const code = deptById.get(s.serves_department_id)?.code ?? `#${s.serves_department_id}`;
    if (servesOf.has(s.department_id)) servesOf.get(s.department_id).push(code);
    else strayServes.push(`${deptById.get(s.department_id)?.code ?? `#${s.department_id}`} -> ${code}`);
  }
  for (const v of servesOf.values()) v.sort();

  same('exactly the source\'s units and machines became departments (one per real thing)',
    [...exp.keys()], plainRows.map((r) => r.code));

  const machineDeptBad = machines.filter((m) => {
    const rows = deptRows.filter((r) => r.code === m.id);
    if (splitNames.has(m.id)) return rows.length !== 0;     // its parts are checked just below
    return isProcessHeading(m) ? rows.length !== 0 : rows.length !== 1;
  });
  // A split, checked against the FILE entry by entry: the box has no row, and
  // each named part is one row with that name, under what encloses the box.
  const splitBad = [];
  for (const [nodeId, names] of splitNames) {
    if (deptRows.some((r) => r.code === nodeId)) splitBad.push(`${nodeId} still has a department of its own`);
    names.forEach((name, i) => {
      const rows = deptRows.filter((r) => r.code === `${nodeId}-${i + 1}`);
      if (rows.length !== 1) splitBad.push(`${nodeId}-${i + 1} "${name}": ${rows.length} rows`);
      else if (norm(rows[0].name) !== name) splitBad.push(`${nodeId}-${i + 1} is named "${rows[0].name}", the decision says "${name}"`);
      else if (Number(rows[0].is_shared) === 1) splitBad.push(`${nodeId}-${i + 1} "${name}" is marked shared`);
    });
    const extra = deptRows.filter((r) => new RegExp(`^${nodeId}-\\d+$`).test(String(r.code)) && Number(String(r.code).split('-').pop()) > names.length);
    if (extra.length) splitBad.push(`${extra.map((r) => r.code).join(', ')}: more parts than the decision names`);
  }
  check('every split in the adjustments file is applied: the box has no row, each named part has one', splitBad.length === 0, splitBad.slice(0, 6).join(' | '));
  check('every machine node is exactly one department, and a process heading is none',
    machineDeptBad.length === 0,
    machineDeptBad.slice(0, 6).map((m) => `${m.id} "${norm(m.title)}": ${deptRows.filter((r) => r.code === m.id).length} rows`).join(' | '));

  const deptNameBad = [...exp.values()].filter((d) => deptByCode.has(d.code) && norm(deptByCode.get(d.code).name) !== clip(d.name, 200));
  check('every department name is the source `dept` field, or the machine\'s title', deptNameBad.length === 0,
    deptNameBad.slice(0, 5).map((d) => `${d.code}: source "${d.name}" vs db "${deptByCode.get(d.code).name}"`).join(' | '));

  const dbParentCode = (r) => (r.parent_department_id == null ? null : deptById.get(r.parent_department_id)?.code ?? '(dangling)');
  const parentBad = [...exp.values()].filter((d) => deptByCode.has(d.code) && dbParentCode(deptByCode.get(d.code)) !== d.parent);
  check('every department hangs under the department that encloses it', parentBad.length === 0,
    parentBad.slice(0, 6).map((d) => `${d.code}: source parent ${d.parent ?? 'ROOT'} vs db ${dbParentCode(deptByCode.get(d.code)) ?? 'ROOT'}`).join(' | '));

  // THE DUPLICATE CHECK, on the database alone. Whatever the rules above say,
  // one real thing drawn twice has a recognisable shape: a department carrying
  // its parent's name, or two of one name under one parent.
  const sameAsParent = deptRows.filter((r) => r.parent_department_id != null && normKey(deptById.get(r.parent_department_id)?.name) === normKey(r.name));
  const bySiblingName = new Map();
  for (const r of deptRows) {
    const k = `${r.parent_department_id ?? 'ROOT'}|${normKey(r.name)}`;
    bySiblingName.set(k, [...(bySiblingName.get(k) || []), r.code]);
  }
  const siblingTwins = [...bySiblingName.values()].filter((v) => v.length > 1);
  // ... and one that only shows against the chart: a unit name used again
  // further down the same branch (the "Slitting" flag on a slitting operator).
  const nameDownBranch = deptRows.filter((r) => {
    let cur = deptById.get(r.parent_department_id), g = 0;
    while (cur && g++ < 60) { if (normKey(cur.name) === normKey(r.name)) return true; cur = deptById.get(cur.parent_department_id); }
    return false;
  });
  check('no department repeats the one above it, and no two siblings share a name (one department per real thing)',
    sameAsParent.length === 0 && siblingTwins.length === 0 && nameDownBranch.length === 0,
    [...sameAsParent.map((r) => `${r.code} "${r.name}" repeats its parent`),
      ...siblingTwins.map((v) => `"${deptByCode.get(v[0]).name}" x${v.length} under one parent (${v.join(', ')})`),
      ...nameDownBranch.filter((r) => !sameAsParent.includes(r)).map((r) => `${r.code} "${r.name}" repeats a department further up its branch`)].slice(0, 6).join(' | '));

  check('no section became a root department',
    [...exp.values()].filter((d) => d.kind !== 'dept' && deptByCode.has(d.code) && deptByCode.get(d.code).parent_department_id == null).length === 0,
    [...exp.values()].filter((d) => d.kind !== 'dept' && deptByCode.get(d.code)?.parent_department_id == null).map((d) => d.code).join(', '));
  const srcRoots = [...exp.values()].filter((d) => d.parent == null);
  check('exactly the source\'s top unit is a root', deptRows.filter((r) => r.parent_department_id == null).length === srcRoots.length,
    `db ${deptRows.filter((r) => r.parent_department_id == null).length} roots, source implies ${srcRoots.length} (${srcRoots.map((u) => u.code).join(', ')})`);

  let cyclic = 0;
  for (const r of deptRows) {
    const seen = new Set(); let cur = r;
    while (cur && cur.parent_department_id != null) {
      if (seen.has(cur.id)) { cyclic++; break; }
      seen.add(cur.id); cur = deptById.get(cur.parent_department_id);
    }
  }
  check('the department tree has no cycle', cyclic === 0, `${cyclic} rows loop`);

  // The label is free text and no logic reads it — but the IMPORT chose these
  // four, and a machine labelled "Department" would mislead whoever reads it.
  const labelBad = deptRows.filter((r) => {
    if (Number(r.is_shared) === 1) return r.department_type !== 'Shared crew';
    const d = exp.get(r.code);
    if (!d) return false;
    if (d.kind === 'machine') return r.department_type !== 'Machine / area';
    if (d.kind === 'dept') return r.department_type !== 'Department';
    return !['Process', 'Section'].includes(r.department_type);
  });
  check('every department carries the label its source kind implies', labelBad.length === 0,
    labelBad.slice(0, 6).map((r) => `${r.code} "${r.name}" is labelled "${r.department_type}"`).join(' | '));
  const processLabelBad = processNodes.filter((m) => {
    const section = childNodes(m.id)[0];
    return section && deptByCode.get(section.id)?.department_type !== 'Process';
  });
  check('the section under a "... Process" heading is the one labelled Process', processLabelBad.length === 0
    && deptRows.filter((r) => r.department_type === 'Process').length === processNodes.length,
    `${deptRows.filter((r) => r.department_type === 'Process').length} labelled Process, source has ${processNodes.length} headings`);

  // ---- shared departments ---------------------------------------------------
  same('one shared department per distinct set of departments served, and no others',
    [...expSharedSets.keys()], sharedRows.map((r) => sharedKeyOf(servesOf.get(r.id))),
    (k) => `serves ${k}`);
  check('only a shared department has serves rows, and none serves itself',
    strayServes.length === 0 && serveRows.every((s) => s.department_id !== s.serves_department_id),
    strayServes.slice(0, 4).join(' | ') || 'a department serves itself');
  same('every serves row is one the source implies, once',
    [...expSharedSets.values()].flatMap((codes) => codes.map((x) => `${sharedKeyOf(codes)}>${x}`)),
    serveRows.filter((s) => servesOf.has(s.department_id)).map((s) => `${sharedKeyOf(servesOf.get(s.department_id))}>${deptById.get(s.serves_department_id)?.code}`));
  // Its place in the tree: the nearest department that is every served
  // department's ancestor or the department itself.
  const upChain = (code) => { const out = []; let cur = deptByCode.get(code), g = 0; while (cur && g++ < 60) { out.push(cur.code); cur = deptById.get(cur.parent_department_id); } return out; };
  const sharedPlaceBad = sharedRows.filter((r) => {
    const codes = servesOf.get(r.id);
    if (!codes.length) return true;
    const chains = codes.map(upChain);
    const want = chains[0].find((x) => chains.every((ch) => ch.includes(x))) ?? null;
    return dbParentCode(r) !== want;
  });
  check('a shared department hangs under the nearest department enclosing everything it serves', sharedPlaceBad.length === 0,
    sharedPlaceBad.map((r) => `${r.code} is under ${dbParentCode(r) ?? 'ROOT'}`).join(' | '));
  // Its name: "Shared · A + B", at most three named, then "+ N more", in tree order.
  // Where a department sits in the chart's own order: its node's place, and for
  // a split machine's part, the box's place then the part number.
  const chartPlace = (code) => {
    const whole = nodes.findIndex((n) => n.id === code);
    if (whole >= 0) return whole;
    const m = /^(.*)-(\d+)$/.exec(String(code));
    const box = m ? nodes.findIndex((n) => n.id === m[1]) : -1;
    return box >= 0 ? box + Number(m[2]) / 1000 : 1e9;
  };
  const treeRank = new Map();
  { const walk = (parentId) => { for (const r of deptRows.filter((x) => (x.parent_department_id ?? null) === parentId && Number(x.is_shared) !== 1)
      .sort((a, b) => chartPlace(a.code) - chartPlace(b.code))) { treeRank.set(r.code, treeRank.size); walk(r.id); } };
    walk(null); }
  const sharedNameBad = sharedRows.filter((r) => {
    const names = [...servesOf.get(r.id)].sort((a, b) => treeRank.get(a) - treeRank.get(b)).map((x) => deptByCode.get(x)?.name);
    const want = customName.get(sharedKeyOf(servesOf.get(r.id))) ?? `Shared · ${names.slice(0, 3).join(' + ')}${names.length > 3 ? ` + ${names.length - 3} more` : ''}`;
    return norm(r.name) !== clip(want, 200);
  });
  check('a shared department is named for what it serves', sharedNameBad.length === 0,
    sharedNameBad.map((r) => `${r.code} "${r.name}"`).join(' | '));
  check('every department is ACTIVE', deptRows.every((r) => r.status === 'ACTIVE'),
    `${deptRows.filter((r) => r.status !== 'ACTIVE').length} are not`);

  /** What a seat's department_id means in the source's terms: a code, or `shared:<served codes>`. */
  const dbDeptKey = (departmentId) => {
    const r = deptById.get(departmentId);
    if (!r) return null;
    return Number(r.is_shared) === 1 ? `shared:${sharedKeyOf(servesOf.get(r.id))}` : r.code;
  };

  // ---- 3. Positions -------------------------------------------------------
  const posRows = await q(
    `SELECT id, position_code, position_title, sanctioned_headcount, department_id, location_id, default_shift_id, status, effective_from
       FROM hrms_positions WHERE company_id=? AND deleted_at IS NULL`, [c]);
  const posByCode = new Map(posRows.map((r) => [r.position_code, r]));
  const posById = new Map(posRows.map((r) => [r.id, r]));

  same('exactly the source\'s non-machine nodes became positions',
    real.map((p) => p.id), posRows.map((r) => r.position_code));

  const titleMismatch = real.filter((p) => posByCode.has(p.id) && norm(posByCode.get(p.id).position_title) !== clip(norm(p.title), 200));
  check('every title matches the source', titleMismatch.length === 0,
    titleMismatch.slice(0, 5).map((p) => `${p.id}: source "${norm(p.title)}" vs db "${norm(posByCode.get(p.id).position_title)}"`).join(' | '));

  const headMismatch = real.filter((p) => posByCode.has(p.id) && Number(posByCode.get(p.id).sanctioned_headcount) !== Math.max(0, Number(p.req) || 0));
  check('every sanctioned headcount matches `req`', headMismatch.length === 0,
    headMismatch.slice(0, 5).map((p) => `${p.id}: source ${p.req} vs db ${posByCode.get(p.id).sanctioned_headcount}`).join(' | '));

  const locBad = real.filter((p) => posByCode.has(p.id) && posByCode.get(p.id).location_id !== locationId);
  check('every position sits at the one location', locBad.length === 0, locBad.slice(0, 5).map((p) => p.id).join(', '));

  // THE DEPARTMENT ASSIGNMENT, seat by seat — the product of a tree walk, which
  // is exactly the kind of thing that is wrong in one branch only. A dedicated
  // seat sits in its machine's department, a shared seat in the shared
  // department for what it serves, everything else in its unit.
  const deptBad = real.filter((p) => posByCode.has(p.id) && dbDeptKey(posByCode.get(p.id).department_id) !== expSeat.get(p.id));
  check('every seat sits in the department the chart puts it in', deptBad.length === 0,
    deptBad.slice(0, 8).map((p) => `${p.id} "${norm(p.title)}": source ${expSeat.get(p.id) ?? 'none'} vs db ${dbDeptKey(posByCode.get(p.id).department_id) ?? 'none'}`).join(' | '));
  check('no position is left without a department', posRows.every((r) => r.department_id != null),
    `${posRows.filter((r) => r.department_id == null).length} positions have none; the source's root seat is a unit, so every node resolves`);
  const servingSeats = real.filter((p) => expServed.has(p.id));
  const sharedSeatBad = servingSeats.filter((p) => {
    const got = deptById.get(posByCode.get(p.id)?.department_id);
    if (!got) return true;
    return expServed.get(p.id).length > 1
      ? Number(got.is_shared) !== 1 || sharedKeyOf(servesOf.get(got.id)) !== sharedKeyOf(expServed.get(p.id))
      : Number(got.is_shared) === 1 || got.code !== expServed.get(p.id)[0];
  });
  check('each shared seat is in a department serving exactly what the source implies (or, serving one, in that one)',
    sharedSeatBad.length === 0,
    sharedSeatBad.map((p) => `${p.id}: source serves ${expServed.get(p.id).join('+')} vs db ${dbDeptKey(posByCode.get(p.id)?.department_id)}`).join(' | '));
  // Each decision, by name, so a failure says WHICH decision the database lost.
  const decisionBad = [];
  for (const a of decidedShared) {
    const want = sharedKeyOf([...new Set(a.serves)].sort());
    for (const id of a.seats) {
      const got = deptById.get(posByCode.get(id)?.department_id);
      const has = got && Number(got.is_shared) === 1 ? sharedKeyOf(servesOf.get(got.id)) : null;
      if (has !== want) decisionBad.push(`${id} should be in a shared department serving ${want}; it is in ${got ? `${got.code}${has ? ` serving ${has}` : ' (not shared)'}` : 'none'}`);
    }
  }
  check('every "shared" decision in the adjustments file holds: those seats, serving exactly those departments', decisionBad.length === 0, decisionBad.slice(0, 5).join(' | '));
  const notSharedBad = [...decidedNotShared].filter((id) => {
    const got = deptById.get(posByCode.get(id)?.department_id);
    return !got || Number(got.is_shared) === 1 || got.code !== expSeat.get(id);
  });
  check('every "not shared" decision holds: that seat sits in its own department, not a shared one', notSharedBad.length === 0,
    notSharedBad.map((id) => `${id}: db ${dbDeptKey(posByCode.get(id)?.department_id)}, the decision implies ${expSeat.get(id)}`).join(' | '));
  const kindOfSeat = (p) => { const k = String(expSeat.get(p.id)); return k.startsWith('shared:') ? 'shared' : (exp.get(k)?.kind === 'machine' ? 'machine' : 'unit'); };
  const seatSplit = { machine: 0, shared: 0, unit: 0 };
  for (const p of real) seatSplit[kindOfSeat(p)] += 1;
  console.log(`  seats by where they sit: ${seatSplit.machine} in a machine's department, ${seatSplit.shared} in a shared department, ${seatSplit.unit} elsewhere (${real.length})\n`);

  // Shift: DN is two shifts and must be NULL, never a third shift row.
  const shiftRows = await q('SELECT id, code FROM hrms_shifts WHERE company_id=? AND deleted_at IS NULL', [c]);
  const shiftById = new Map(shiftRows.map((s) => [s.id, s.code]));
  const shiftByCode = new Map(shiftRows.map((s) => [s.code, s.id]));
  const shiftBad = real.filter((p) => {
    if (!posByCode.has(p.id)) return false;
    const got = posByCode.get(p.id).default_shift_id;
    if (p.shift === 'DN') return got != null;
    return shiftById.get(got) !== (p.shift || 'G');
  });
  check('a DN position has no default shift, every other matches', shiftBad.length === 0,
    shiftBad.slice(0, 6).map((p) => `${p.id}: source ${p.shift} vs db ${shiftById.get(posByCode.get(p.id).default_shift_id) ?? 'NULL'}`).join(' | '));

  const machineAsPosition = machines.filter((m) => posByCode.has(m.id));
  check('no machine became a position', machineAsPosition.length === 0, machineAsPosition.map((m) => m.id).join(', '));

  check('every position is ACTIVE from the chart date',
    posRows.every((r) => r.status === 'ACTIVE' && ymd(r.effective_from) === chartDate),
    `${posRows.filter((r) => r.status !== 'ACTIVE').length} not ACTIVE, ${posRows.filter((r) => ymd(r.effective_from) !== chartDate).length} dated otherwise`);
  // ---- 4. Roles -----------------------------------------------------------
  const roleRows = await q('SELECT id, role_code, title, default_department_id, status, effective_from FROM hrms_roles WHERE company_id=? AND deleted_at IS NULL', [c]);
  check('every role is ACTIVE from the chart date',
    roleRows.every((r) => r.status === 'ACTIVE' && ymd(r.effective_from) === chartDate),
    `${roleRows.filter((r) => r.status !== 'ACTIVE').length} not ACTIVE, ${roleRows.filter((r) => ymd(r.effective_from) !== chartDate).length} dated otherwise`);
  // A merged role spans several units, so no role was given a default department.
  check('no role was given a default department (a merged role spans units)',
    roleRows.every((r) => r.default_department_id == null),
    `${roleRows.filter((r) => r.default_department_id != null).length} carry one`);
  const roleById = new Map(roleRows.map((r) => [r.id, r]));
  const posRoleRows = await q(
    `SELECT p.position_code AS code, r.title AS role_title, r.role_code
       FROM hrms_positions p JOIN hrms_roles r ON r.company_id=p.company_id AND r.id=p.role_id
      WHERE p.company_id=? AND p.deleted_at IS NULL`, [c]);
  const posRole = new Map(posRoleRows.map((r) => [r.code, r]));
  check('every seat in the chart has a position with a role',
    real.every((p) => posRole.has(p.id)),
    real.filter((p) => !posRole.has(p.id)).slice(0, 5).map((p) => p.id).join(', '));
  for (const p of real) if (posRole.has(p.id)) roleKeyByNode.set(p.id, normKey(posRole.get(p.id).role_title));

  // The two directions of "a role is one kind of work". The first is the
  // inflation bug's signature: before 2026-10-09 a role was keyed by title
  // alone, so ten seats with seven different duty lists shared one role and
  // every one of them carried the union.
  const seatsByRole = new Map();
  for (const p of real) {
    const k = roleKeyOf(p);
    if (!seatsByRole.has(k)) seatsByRole.set(k, []);
    seatsByRole.get(k).push(p);
  }
  const mixed = [...seatsByRole].filter(([, ps]) =>
    new Set(ps.map((p) => normKey(p.title))).size > 1 || new Set(ps.map(dutySig)).size > 1);
  check('seats sharing a role share their title AND their duty list (no inflated job descriptions)',
    mixed.length === 0,
    mixed.slice(0, 4).map(([k, ps]) => `"${k}": ${ps.map((p) => p.id).join('/')}`).join(' | '));
  const sameWork = new Map();
  for (const p of real) {
    const k = `${normKey(p.title)}|${dutySig(p)}`;
    if (!sameWork.has(k)) sameWork.set(k, new Set());
    sameWork.get(k).add(roleKeyOf(p));
  }
  const scattered = [...sameWork.values()].filter((s) => s.size > 1);
  check('seats with the same title and the same duty list share ONE role (no needless split)',
    scattered.length === 0, scattered.slice(0, 4).map((s) => [...s].join(' + ')).join(' | '));
  same('one role per kind of work, and no others',
    [...sameWork.keys()].map((k) => [...sameWork.get(k)][0]), roleRows.map((r) => normKey(r.title)));

  // A title whose seats all do the same work keeps its exact title; one that
  // splits keeps the title as a prefix and adds a qualifier, all distinct.
  const byTitle = new Map();
  for (const p of real) {
    const t = normKey(p.title);
    if (!byTitle.has(t)) byTitle.set(t, []);
    byTitle.get(t).push(p);
  }
  const roleNameBad = [];
  for (const [t, ps] of byTitle) {
    const keys = new Set(ps.map(roleKeyOf));
    if (new Set(ps.map(dutySig)).size === 1) { if (keys.size !== 1 || ![...keys][0] || [...keys][0] !== t) roleNameBad.push(`"${t}" should be unqualified`); }
    else for (const k of keys) if (!k.startsWith(`${t} (`)) roleNameBad.push(`"${k}" should start "${t} ("`);
  }
  check('a role keeps its seats\' title, qualified only when the title splits', roleNameBad.length === 0, roleNameBad.slice(0, 4).join(' | '));
  const codeBad = [...seatsByRole].filter(([, ps]) => posRole.get(ps[0].id).role_code !== ps[0].id);
  check('a role is coded by the first seat that holds it', codeBad.length === 0,
    codeBad.slice(0, 5).map(([k, ps]) => `"${k}" should be ${ps[0].id}`).join(' | '));

  // ---- 5. Work contexts are RETIRED: the import writes none -----------------
  // Machines are departments (section 2). The tables stay in the schema; a row
  // in any of them after an import means the old path is still running beside
  // the new one, and then a seat has two answers to "where does it work".
  for (const [label, table] of [
    ['work context', 'hrms_work_contexts'],
    ['position-to-context link', 'hrms_position_work_contexts'],
    ['assignment-to-context link', 'hrms_work_assignment_contexts'],
  ]) {
    const [[n]] = await conn.query(`SELECT COUNT(*) n FROM ${table} WHERE company_id=? AND deleted_at IS NULL`, [c]);
    check(`no ${label} was written (machines are departments)`, Number(n.n) === 0, `${n.n} live rows in ${table}`);
  }

  // ---- 6. Formal reporting: every edge, re-derived -------------------------
  const edgeRows = await q(
    `SELECT f.position_code AS src, t.position_code AS dst, ty.code AS type, r.is_primary, r.scope_type
       FROM hrms_position_reporting_relationships r
       JOIN hrms_positions f ON f.company_id=r.company_id AND f.id=r.from_position_id
       JOIN hrms_positions t ON t.company_id=r.company_id AND t.id=r.to_position_id
       JOIN hrms_reporting_relationship_types ty ON ty.company_id=r.company_id AND ty.id=r.relationship_type_id
      WHERE r.company_id=? AND r.deleted_at IS NULL`, [c]);
  const expectedPrimary = real.map((p) => { const m = managerOf(p); return m ? `${p.id}>${m.id}:PRIMARY_MANAGER` : null; }).filter(Boolean);
  const expectedDotted = real.filter((p) => p.dotted && byId.has(p.dotted) && byId.get(p.dotted).kind !== 'machine').map((p) => `${p.id}>${p.dotted}:DOTTED_LINE`);
  same('every reporting edge matches the source, and there are no others',
    [...expectedPrimary, ...expectedDotted], edgeRows.map((e) => `${e.src}>${e.dst}:${e.type}`));
  check('a primary edge is primary and a dotted one is not',
    edgeRows.every((e) => (e.type === 'PRIMARY_MANAGER' ? Number(e.is_primary) === 1 : Number(e.is_primary) === 0)),
    `${edgeRows.filter((e) => e.type === 'PRIMARY_MANAGER' && Number(e.is_primary) !== 1).length} primaries not primary`);
  check('no position reports to a machine', edgeRows.every((e) => !machines.some((m) => m.id === e.dst)), 'a machine is on the receiving end of an edge');
  const srcRootNodes = real.filter((p) => !managerOf(p));
  check('exactly the source\'s root seats have no manager',
    real.length - new Set(edgeRows.filter((e) => e.type === 'PRIMARY_MANAGER').map((e) => e.src)).size === srcRootNodes.length,
    `source implies ${srcRootNodes.length} roots (${srcRootNodes.map((p) => p.id).join(', ')})`);

  // ---- 8. Manpower: the day/night doubling, plan §9.1 ----------------------
  const mpRows = await q(
    `SELECT p.position_code AS pos, s.code AS shift, m.required_count, r.title AS role_title
       FROM hrms_manpower_requirements m
       JOIN hrms_positions p ON p.company_id=m.company_id AND p.id=m.position_id
       JOIN hrms_shifts s ON s.company_id=m.company_id AND s.id=m.shift_id
       JOIN hrms_roles r ON r.company_id=m.company_id AND r.id=m.role_id
      WHERE m.company_id=? AND m.deleted_at IS NULL`, [c]);
  const expectedMp = real.filter((p) => p.shift === 'DN' && Math.max(0, Number(p.req) || 0) > 0)
    .flatMap((p) => ['D', 'N'].map((s) => `${p.id}:${s}:${Math.max(0, Number(p.req) || 0)}`));
  same('every DN seat has one requirement per shift, and no other seat has any',
    expectedMp, mpRows.map((m) => `${m.pos}:${m.shift}:${Number(m.required_count)}`));
  check('a manpower row carries the same role as its position',
    mpRows.every((m) => normKey(m.role_title) === roleKeyOf(byId.get(m.pos))),
    mpRows.filter((m) => normKey(m.role_title) !== roleKeyOf(byId.get(m.pos))).slice(0, 4).map((m) => m.pos).join(', '));
  const trueSanctioned = real.reduce((a, p) => a + (p.shift === 'DN' ? 2 : 1) * Math.max(0, Number(p.req) || 0), 0);
  const dbSanctioned = posRows.reduce((a, r) => a + Number(r.sanctioned_headcount), 0)
    + mpRows.filter((m) => m.shift === 'N').reduce((a, m) => a + Number(m.required_count), 0);
  check('sanctioned headcount plus the night requirement is the chart\'s true total', dbSanctioned === trueSanctioned,
    `db ${dbSanctioned}, source implies ${trueSanctioned} (${posRows.reduce((a, r) => a + Number(r.sanctioned_headcount), 0)} seats, ${real.filter((p) => p.shift === 'DN').length} of them day+night)`);

  // ---- 9. Responsibilities: the text, and the pairing ---------------------
  const respDefRows = await q('SELECT id, name, description FROM hrms_responsibility_definitions WHERE company_id=? AND deleted_at IS NULL', [c]);
  const srcRespTexts = new Map();   // normKey -> first-seen exact text
  for (const p of real) for (const raw of (p.kras || [])) { const t = norm(raw); if (t && !srcRespTexts.has(normKey(t))) srcRespTexts.set(normKey(t), t); }
  same('one responsibility definition per distinct statement, and no others',
    [...srcRespTexts.keys()], respDefRows.map((r) => normKey(r.description)),
    (k) => `"${clip(srcRespTexts.get(k) || k, 50)}"`);
  const descBad = respDefRows.filter((r) => {
    const want = srcRespTexts.get(normKey(r.description));
    return want !== undefined && r.description !== want;
  });
  check('a responsibility description is the source text verbatim', descBad.length === 0,
    descBad.slice(0, 3).map((r) => `"${clip(r.description, 60)}"`).join(' | '));
  const nameBad = respDefRows.filter((r) => r.name !== clip(r.description, 250));
  check('a responsibility name is its description, truncated only when it must be', nameBad.length === 0,
    nameBad.slice(0, 3).map((r) => `"${clip(r.name, 60)}"`).join(' | '));

  const respPairRows = await q(
    `SELECT r.title AS role_title, d.description
       FROM hrms_role_responsibility_assignments ra
       JOIN hrms_roles r ON r.company_id=ra.company_id AND r.id=ra.role_id
       JOIN hrms_responsibility_definitions d ON d.company_id=ra.company_id AND d.id=ra.responsibility_definition_id
      WHERE ra.company_id=? AND ra.deleted_at IS NULL`, [c]);
  const expectedRespPairs = new Set();
  for (const p of real) for (const raw of (p.kras || [])) { const t = normKey(raw); if (t) expectedRespPairs.add(`${roleKeyOf(p)}|${t}`); }
  same('every role holds exactly the responsibilities its seats carried',
    expectedRespPairs, respPairRows.map((r) => `${normKey(r.role_title)}|${normKey(r.description)}`),
    (k) => `${k.split('|')[0]} / "${clip(k.split('|')[1], 40)}"`);

  // ---- 10. KPIs: new in V28, and the path had never run -------------------
  const kpiDefRows = await q('SELECT id, name, description, measurement_type FROM hrms_kpi_definitions WHERE company_id=? AND deleted_at IS NULL', [c]);
  const srcKpiFirst = new Map();    // normKey(name) -> { name, description }
  for (const p of real) for (const k of (p.kpis || [])) {
    const name = norm(k?.k); if (!name) continue;
    if (!srcKpiFirst.has(normKey(name))) srcKpiFirst.set(normKey(name), { name: clip(name, 250), description: norm(k?.d) });
  }
  same('one KPI definition per distinct name, and no others',
    [...srcKpiFirst.keys()], kpiDefRows.map((r) => normKey(r.name)),
    (k) => `"${clip(srcKpiFirst.get(k)?.name || k, 50)}"`);
  const kpiNameBad = kpiDefRows.filter((r) => srcKpiFirst.has(normKey(r.name)) && r.name !== srcKpiFirst.get(normKey(r.name)).name);
  check('a KPI name is the source name verbatim', kpiNameBad.length === 0,
    kpiNameBad.slice(0, 3).map((r) => `db "${r.name}" vs source "${srcKpiFirst.get(normKey(r.name)).name}"`).join(' | '));
  const kpiDescBad = kpiDefRows.filter((r) => {
    const want = srcKpiFirst.get(normKey(r.name));
    return want && norm(r.description ?? '') !== want.description;
  });
  check('a KPI description is the first wording the chart used', kpiDescBad.length === 0,
    kpiDescBad.slice(0, 3).map((r) => `"${r.name}"`).join(' | '));
  check('every KPI is measured as TEXT (its target is a sentence)', kpiDefRows.every((r) => r.measurement_type === 'TEXT'),
    `${kpiDefRows.filter((r) => r.measurement_type !== 'TEXT').length} are not`);

  const kpiPairRows = await q(
    `SELECT r.title AS role_title, d.name AS kpi_name, a.target_operator, a.target_value, a.notes
       FROM hrms_role_kpi_assignments a
       JOIN hrms_roles r ON r.company_id=a.company_id AND r.id=a.role_id
       JOIN hrms_kpi_definitions d ON d.company_id=a.company_id AND d.id=a.kpi_definition_id
      WHERE a.company_id=? AND a.deleted_at IS NULL`, [c]);
  // A role may hold a KPI once (uq_hrkp_pair), so the expectation is the set of
  // role x KPI-name pairs, and the kept target is the FIRST seat's.
  const expectedKpiPairs = new Map();   // roleKey|kpiKey -> first target
  const droppedTargets = [];            // the ones that must survive in notes
  for (const p of real) for (const k of (p.kpis || [])) {
    const name = norm(k?.k); if (!name) continue;
    const key = `${roleKeyOf(p)}|${normKey(name)}`;
    if (expectedKpiPairs.has(key)) { droppedTargets.push({ key, nodeId: p.id, target: norm(k?.t) }); continue; }
    expectedKpiPairs.set(key, norm(k?.t));
  }
  same('every role holds exactly the KPIs its seats carried',
    [...expectedKpiPairs.keys()], kpiPairRows.map((r) => `${normKey(r.role_title)}|${normKey(r.kpi_name)}`),
    (k) => `${k.split('|')[0]} / "${k.split('|')[1]}"`);

  const readJson = (v) => { if (v == null) return null; if (typeof v === 'string') { try { return JSON.parse(v); } catch { return v; } } return v; };
  const targetBad = kpiPairRows.filter((r) => {
    const want = expectedKpiPairs.get(`${normKey(r.role_title)}|${normKey(r.kpi_name)}`);
    if (want === undefined) return false;
    if (!want) return r.target_operator !== 'INFO' || readJson(r.target_value) != null;
    return r.target_operator !== 'EQ' || String(readJson(r.target_value)) !== want;
  });
  check('every KPI target is the source sentence, stored in the TEXT shape', targetBad.length === 0,
    targetBad.slice(0, 4).map((r) => `${r.role_title} / ${r.kpi_name}: db ${r.target_operator} ${JSON.stringify(readJson(r.target_value))} vs source "${expectedKpiPairs.get(`${normKey(r.role_title)}|${normKey(r.kpi_name)}`)}"`).join(' | '));

  // Nothing may be silently lost where a merged role could hold only one: the
  // other seats' targets have to be readable in the notes.
  const notesByPair = new Map(kpiPairRows.map((r) => [`${normKey(r.role_title)}|${normKey(r.kpi_name)}`, String(r.notes ?? '')]));
  const lostTargets = droppedTargets.filter((d) => {
    const notes = notesByPair.get(d.key) ?? '';
    return !(notes.includes(d.nodeId) && (!d.target || notes.includes(d.target)));
  });
  check('a target a merged role could not hold survives in the notes', lostTargets.length === 0,
    `${lostTargets.length} of ${droppedTargets.length} dropped targets are nowhere: `
    + lostTargets.slice(0, 4).map((d) => `${d.nodeId} "${d.target}"`).join(' | '));

  // ---- 11. The rule that must never bend: kras are NOT KRAs ---------------
  const [[kraCount]] = await conn.query('SELECT COUNT(*) n FROM hrms_kra_definitions WHERE company_id=? AND deleted_at IS NULL', [c]);
  check('no KRA was invented from a task statement', Number(kraCount.n) === 0, `${kraCount.n} KRA definitions exist`);
  const [[qualCount]] = await conn.query('SELECT COUNT(*) n FROM hrms_qualification_definitions WHERE company_id=? AND deleted_at IS NULL', [c]);
  check('no qualification was invented (the source has none)',
    Number(qualCount.n) === nodes.reduce((a, p) => a + (p.quals || []).length, 0),
    `db ${qualCount.n}, source ${nodes.reduce((a, p) => a + (p.quals || []).length, 0)}`);

  // ---- 12. People: only the NAMED ones, and their seat --------------------
  const namedSource = real.flatMap((p) => (p.people || []).filter((x) => norm(x.name)).map((x) => ({ node: p, person: x })));
  const srcEmpNames = new Map();   // normKey -> exact name
  for (const r of namedSource) if (!srcEmpNames.has(normKey(r.person.name))) srcEmpNames.set(normKey(r.person.name), norm(r.person.name));
  const empRows = await q('SELECT id, employee_code, full_name, salutation, date_of_joining, employment_status FROM hrms_employees WHERE company_id=? AND deleted_at IS NULL', [c]);
  same('exactly the named people exist', [...srcEmpNames.keys()], empRows.map((e) => normKey(e.full_name)));
  const exactNameBad = empRows.filter((e) => srcEmpNames.has(normKey(e.full_name)) && e.full_name !== srcEmpNames.get(normKey(e.full_name)));
  check('every name is stored exactly as the chart wrote it', exactNameBad.length === 0,
    exactNameBad.slice(0, 4).map((e) => `db "${e.full_name}" vs source "${srcEmpNames.get(normKey(e.full_name))}"`).join(' | '));
  check('nobody blank-named was imported', empRows.every((e) => norm(e.full_name)), 'a blank-named employee exists');
  // The ttl decision, asserted rather than described: a courtesy title is not
  // part of a name, so no name may start with one.
  const titledNames = empRows.filter((e) => /^(mr|mrs|ms|miss|dr|shri|smt)\.?\s/i.test(norm(e.full_name)));
  check('no courtesy title was glued onto a name', titledNames.length === 0,
    titledNames.slice(0, 4).map((e) => `"${e.full_name}"`).join(' | '));

  // `salutation` holds the source's `ttl`, verbatim, and both directions matter:
  // a missing one loses what the client wrote, and an invented one gives someone
  // a form of address the chart never gave them.
  const srcTtl = new Map();   // normKey(name) -> the ttl exactly as written, or ''
  for (const r of namedSource) {
    const k = normKey(r.person.name);
    const t = norm(r.person.ttl);
    if (!srcTtl.has(k)) srcTtl.set(k, t);
    else if (t && srcTtl.get(k) && t !== srcTtl.get(k)) srcTtl.set(k, null);   // two different ones: neither is written
  }
  const salBad = empRows.filter((e) => {
    const want = srcTtl.get(normKey(e.full_name));
    if (want === undefined) return false;                       // not from this chart
    return norm(e.salutation ?? '') !== (want ?? '');
  });
  check('every salutation is the source\'s `ttl`, verbatim, and nobody has one the source does not give',
    salBad.length === 0,
    salBad.slice(0, 5).map((e) => `${e.full_name}: db "${e.salutation ?? ''}" vs source "${srcTtl.get(normKey(e.full_name)) ?? ''}"`).join(' | '));
  const withTtl = [...srcTtl.values()].filter(Boolean).length;
  check('the salutations that exist are exactly as many as the source has',
    empRows.filter((e) => norm(e.salutation ?? '')).length === withTtl,
    `db ${empRows.filter((e) => norm(e.salutation ?? '')).length}, source gives ${withTtl} of ${srcTtl.size} people a title`);
  // The exact-string compare above is what proves nothing was "tidied up" on the
  // way in: "Mr." normalised to "Mr" would fail it, which is the point.
  const joinBad = empRows.filter((e) => ymd(e.date_of_joining) !== chartDate);
  check('every joining date is the chart date (all the source gives)', joinBad.length === 0, `${joinBad.length} differ`);

  const asgRows = await q(
    `SELECT e.full_name, p.position_code, r.title AS role_title, a.department_id, a.is_primary, s.code AS shift, a.location_id
       FROM hrms_work_assignments a
       JOIN hrms_employees e ON e.company_id=a.company_id AND e.id=a.employee_id
       JOIN hrms_roles r ON r.company_id=a.company_id AND r.id=a.role_id
       LEFT JOIN hrms_positions p ON p.company_id=a.company_id AND p.id=a.position_id
       LEFT JOIN hrms_shifts s ON s.company_id=a.company_id AND s.id=a.default_shift_id
      WHERE a.company_id=? AND a.deleted_at IS NULL`, [c]);
  same('every person sits in exactly the seats the source put them in',
    namedSource.map((r) => `${normKey(r.person.name)}@${r.node.id}`),
    asgRows.map((a) => `${normKey(a.full_name)}@${a.position_code}`));
  const asgShiftBad = namedSource.filter((r) => {
    const row = asgRows.find((a) => normKey(a.full_name) === normKey(r.person.name) && a.position_code === r.node.id);
    return row && row.shift !== (norm(r.person.shift) || 'G');
  });
  check('every assignment carries the person\'s own shift, not the seat\'s', asgShiftBad.length === 0,
    asgShiftBad.slice(0, 5).map((r) => `${norm(r.person.name)}: source ${r.person.shift}`).join(' | '));
  const asgRoleBad = namedSource.filter((r) => {
    const row = asgRows.find((a) => normKey(a.full_name) === normKey(r.person.name) && a.position_code === r.node.id);
    return row && normKey(row.role_title) !== roleKeyOf(r.node);
  });
  check('every assignment carries its seat\'s role', asgRoleBad.length === 0, asgRoleBad.slice(0, 4).map((r) => norm(r.person.name)).join(', '));
  const asgDeptBad = asgRows.filter((a) => (a.department_id ?? null) !== (posByCode.get(a.position_code)?.department_id ?? null));
  check('an assignment\'s department is its position\'s department', asgDeptBad.length === 0,
    asgDeptBad.slice(0, 4).map((a) => `${a.full_name} @ ${a.position_code}`).join(' | '));
  const primaryPerEmp = new Map();
  for (const a of asgRows) primaryPerEmp.set(normKey(a.full_name), (primaryPerEmp.get(normKey(a.full_name)) || 0) + Number(a.is_primary));
  check('every employee has exactly one primary assignment', [...primaryPerEmp.values()].every((n) => n === 1),
    [...primaryPerEmp].filter(([, n]) => n !== 1).slice(0, 4).map(([k, n]) => `${k}: ${n}`).join(' | '));

  // ---- 13. Attendance: one day, and only for people ----------------------
  const attRows = await q(
    `SELECT e.full_name, a.attendance_date, a.status, s.code AS shift, a.source
       FROM hrms_attendance_records a
       JOIN hrms_employees e ON e.company_id=a.company_id AND e.id=a.employee_id
       LEFT JOIN hrms_shifts s ON s.company_id=a.company_id AND s.id=a.shift_id
      WHERE a.company_id=? AND a.deleted_at IS NULL`, [c]);
  const expectedAtt = new Set();
  const firstSeatOf = new Map();
  for (const r of namedSource) if (!firstSeatOf.has(normKey(r.person.name))) firstSeatOf.set(normKey(r.person.name), r);
  for (const [k, r] of firstSeatOf) expectedAtt.add(`${k}:${norm(r.person.shift) || 'G'}:${r.person.status === 'A' ? 'ABSENT' : 'PRESENT'}`);
  same('one attendance row per named person, with that person\'s shift and mark',
    expectedAtt, attRows.map((a) => `${normKey(a.full_name)}:${a.shift}:${a.status}`),
    (k) => k.split(':')[0]);
  check('every attendance row is the chart date and marked as an import',
    attRows.every((a) => ymd(a.attendance_date) === chartDate && a.source === 'IMPORT'),
    `${attRows.filter((a) => ymd(a.attendance_date) !== chartDate).length} wrong date, `
    + `${attRows.filter((a) => a.source !== 'IMPORT').length} not marked IMPORT`);
  const blankAbsences = real.flatMap((p) => (p.people || [])).filter((x) => !norm(x.name) && x.status === 'A').length;
  check('no absence was imported from a blank seat', attRows.filter((a) => a.status === 'ABSENT').length === 0,
    `${attRows.filter((a) => a.status === 'ABSENT').length} absences in the db; the source's ${blankAbsences} all sit on nameless rows`);

  // ---- 14. Open points ---------------------------------------------------
  const opRows = await q('SELECT entity_type, entity_id, description FROM hrms_open_points WHERE company_id=? AND deleted_at IS NULL', [c]);
  // An array, not a set: the import writes one row per source entry and does not
  // deduplicate them, so two identical open points must stay two rows.
  const expectedOps = [];
  for (const d of (seed.meta?.openPoints || [])) { const t = norm(d); if (t) expectedOps.push(`ORGANIZATION||${normKey(t)}`); }
  for (const p of real) for (const d of (p.open || [])) { const t = norm(d); if (t) expectedOps.push(`POSITION|${p.id}|${normKey(t)}`); }
  same('every open point, at the right entity, and no others',
    expectedOps,
    opRows.map((o) => `${o.entity_type}|${o.entity_id ? posById.get(o.entity_id)?.position_code ?? `#${o.entity_id}` : ''}|${normKey(o.description)}`),
    (k) => `${k.split('|')[0]} "${clip(k.split('|')[2], 40)}"`);
  const opTextBad = opRows.filter((o) => {
    const src = [...(seed.meta?.openPoints || []), ...real.flatMap((p) => p.open || [])].map(norm).find((t) => normKey(t) === normKey(o.description));
    return src !== undefined && o.description !== src;
  });
  check('an open point is the source text verbatim', opTextBad.length === 0, opTextBad.slice(0, 3).map((o) => clip(o.description, 50)).join(' | '));

  // ---- 15. Every ENUM holds a value its own column declares ---------------
  // The cheap check that catches a whole class of TiDB-only corruption. MySQL's
  // default collation is case-insensitive and TiDB's is not, so 'committed'
  // where the column says 'COMMITTED' lands as COMMITTED locally and as the
  // EMPTY STRING on TiDB — which then refuses to restore into a strict MySQL.
  // That is exactly what the V12 run left on Karni's production row. Reading the
  // members from information_schema rather than listing them here means this
  // check follows the schema instead of drifting behind it.
  const enumCols = await q(
    `SELECT TABLE_NAME t, COLUMN_NAME col, COLUMN_TYPE ct
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND DATA_TYPE = 'enum' AND TABLE_NAME LIKE 'hrms\\_%'`);
  const byTable = new Map();
  for (const r of enumCols) {
    const t = String(r.t);
    if (!byTable.has(t)) byTable.set(t, []);
    byTable.get(t).push({
      col: String(r.col),
      members: new Set([...String(r.ct).matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'"))),
    });
  }
  check('the schema still declares enums to check', byTable.size > 0, 'information_schema returned none');
  const badEnums = [];
  for (const [table, cols] of byTable) {
    const rows = await q(`SELECT DISTINCT ${cols.map((x) => `\`${x.col}\``).join(', ')} FROM \`${table}\` WHERE company_id=?`, [c]);
    for (const row of rows) {
      for (const { col, members } of cols) {
        const v = row[col];
        if (v === null || v === undefined) continue;
        if (!members.has(String(v))) {
          badEnums.push(`${table}.${col} = ${v === '' ? '(empty string)' : `"${v}"`} — allowed: ${[...members].join(', ')}`);
        }
      }
    }
  }
  check('every enum column holds one of its declared values', badEnums.length === 0,
    `${badEnums.length} column${badEnums.length === 1 ? ' holds' : 's hold'} a value the enum does not declare: ${[...new Set(badEnums)].slice(0, 6).join(' | ')}`);
  check('the committed run says COMMITTED, in the case the enum declares', run?.status === 'COMMITTED',
    `status is ${run ? `"${run.status}"` : 'absent'}`);

  // ---- 16. Duplicates: the shape a resumed or repeated run leaves ---------
  for (const [label, sql] of [
    ['position', 'SELECT position_code k FROM hrms_positions WHERE company_id=? AND deleted_at IS NULL'],
    ['employee', 'SELECT full_name k FROM hrms_employees WHERE company_id=? AND deleted_at IS NULL'],
    ['department', 'SELECT code k FROM hrms_departments WHERE company_id=? AND deleted_at IS NULL'],
    ['role title', 'SELECT title k FROM hrms_roles WHERE company_id=? AND deleted_at IS NULL'],
    ['KPI name', 'SELECT name k FROM hrms_kpi_definitions WHERE company_id=? AND deleted_at IS NULL'],
    ['responsibility text', 'SELECT description k FROM hrms_responsibility_definitions WHERE company_id=? AND deleted_at IS NULL'],
  ]) {
    const rows = await q(sql, [c]);
    const seen = new Map();
    for (const r of rows) { const k = normKey(r.k); seen.set(k, (seen.get(k) || 0) + 1); }
    const dup = [...seen].filter(([, n]) => n > 1);
    check(`no duplicated ${label} (a re-run would show here)`, dup.length === 0,
      `${dup.length} repeat: ${dup.slice(0, 3).map(([k, n]) => `"${clip(k, 40)}" x${n}`).join(', ')}`);
  }

  await conn.end();

  console.log(`  ${passes.length} checks passed`);
  passes.forEach((p) => console.log(`    ok   ${p}`));
  if (fails.length) {
    console.log(`\n  ${fails.length} FAILED`);
    fails.forEach((f) => console.log(`    FAIL ${f.name}\n         ${f.detail}`));
    process.exit(1);
  }
  console.log(`\n  The database matches ${fileName}, field by field.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
