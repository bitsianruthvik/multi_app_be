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
 *   node verify-against-source.mjs --company=karni [--target=prod] [--source=<path>]
 *
 * Read-only. Exits 1 on any mismatch.
 */
import mysql from 'mysql2/promise';
import { resolveTarget, announce } from './dbTarget.mjs';
import { resolveSource, readSeed } from './orgChartSource.mjs';

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
  console.log(`  source: ${source}\n          ${size.toLocaleString()} bytes, sha256 ${hash.slice(0, 12)}…\n`);

  const nodes = seed.positions;
  const byId = new Map(nodes.map((p) => [p.id, p]));
  const real = nodes.filter((p) => p.kind !== 'machine');
  const machines = nodes.filter((p) => p.kind === 'machine');
  const chartDate = seed.meta?.date || '2026-09-30';

  // ---- the walks, re-derived ------------------------------------------------
  const managerOf = (p) => { let c = byId.get(p.reportsTo), g = 0; while (c && c.kind === 'machine' && g++ < 50) c = byId.get(c.reportsTo); return c || null; };
  const contextsOf = (p) => { const out = []; let c = byId.get(p.reportsTo), g = 0; while (c && c.kind !== 'role' && g++ < 50) { if (c.kind === 'machine') out.push(c); c = byId.get(c.reportsTo); } return out; };
  const isUnit = (n) => !!norm(n.dtype);
  const unitName = (n) => norm(n.dept) || norm(n.title);
  const unitOf = (n) => { let c = n, g = 0; while (c && g++ < 60) { if (isUnit(c)) return c; c = byId.get(c.reportsTo); } return null; };
  const unitAbove = (n) => { let c = byId.get(n.reportsTo), g = 0; while (c && g++ < 60) { if (isUnit(c)) return c; c = byId.get(c.reportsTo); } return null; };
  const unitNodes = nodes.filter(isUnit);
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
  const runs = await q('SELECT source_file_name, source_hash, source_size_bytes, status FROM hrms_import_runs WHERE company_id=? AND deleted_at IS NULL ORDER BY id DESC', [c]);
  check('exactly one committed import run', runs.filter((r) => r.status === 'COMMITTED').length === 1,
    `${runs.length} runs, ${runs.filter((r) => r.status === 'COMMITTED').length} committed — a second committed run means two charts are mixed in here`);
  const run = runs.find((r) => r.status === 'COMMITTED');
  check('the committed run is this exact file', !!run && run.source_hash === hash && run.source_file_name === fileName && Number(run.source_size_bytes) === size,
    run ? `db recorded ${run.source_file_name} sha256 ${String(run.source_hash).slice(0, 12)}… (${run.source_size_bytes} bytes); this file is ${fileName} sha256 ${hash.slice(0, 12)}… (${size} bytes)` : 'no committed run');

  // ---- 1. Location --------------------------------------------------------
  const locRows = await q('SELECT id, code, name FROM hrms_locations WHERE company_id=? AND deleted_at IS NULL', [c]);
  const expectedLoc = norm(seed.meta?.subtitle || '').replace(/^Organisation chart,\s*/i, '') || 'Unit 2';
  check('one location, named from the chart subtitle', locRows.length === 1 && norm(locRows[0].name) === expectedLoc,
    `db ${locRows.length} rows${locRows[0] ? ` named "${locRows[0].name}"` : ''}, source subtitle implies "${expectedLoc}"`);
  const locationId = locRows[0]?.id ?? null;

  // ---- 2. DEPARTMENTS -----------------------------------------------------
  const deptRows = await q('SELECT id, code, name, parent_department_id, status FROM hrms_departments WHERE company_id=? AND deleted_at IS NULL', [c]);
  const deptByCode = new Map(deptRows.map((r) => [r.code, r]));
  const deptById = new Map(deptRows.map((r) => [r.id, r]));

  same('exactly the source\'s dtype seats became departments',
    unitNodes.map((n) => n.id), deptRows.map((r) => r.code));

  const deptNameBad = unitNodes.filter((u) => deptByCode.has(u.id) && norm(deptByCode.get(u.id).name) !== clip(unitName(u), 200));
  check('every department name is the source `dept` field (else the title)', deptNameBad.length === 0,
    deptNameBad.slice(0, 5).map((u) => `${u.id}: source "${unitName(u)}" vs db "${deptByCode.get(u.id).name}"`).join(' | '));

  const parentBad = unitNodes.filter((u) => {
    if (!deptByCode.has(u.id)) return false;
    const dbParent = deptByCode.get(u.id).parent_department_id;
    const srcParent = unitAbove(u);
    const dbParentCode = dbParent == null ? null : deptById.get(dbParent)?.code ?? '(dangling)';
    return dbParentCode !== (srcParent ? srcParent.id : null);
  });
  check('every unit hangs under the unit that encloses it', parentBad.length === 0,
    parentBad.slice(0, 6).map((u) => {
      const dbParent = deptByCode.get(u.id).parent_department_id;
      return `${u.id}: source parent ${unitAbove(u)?.id ?? 'ROOT'} vs db ${dbParent == null ? 'ROOT' : deptById.get(dbParent)?.code ?? 'dangling'}`;
    }).join(' | '));

  // A section must end up under a department, never free-floating: the source's
  // 15 sections all sit inside something, so none may come out as a root.
  const sectionRoots = unitNodes.filter((u) => norm(u.dtype) === 'section' && deptByCode.has(u.id) && deptByCode.get(u.id).parent_department_id == null);
  check('no section became a root department', sectionRoots.length === 0, sectionRoots.map((u) => u.id).join(', '));
  const srcRoots = unitNodes.filter((u) => !unitAbove(u));
  check('exactly the source\'s top unit is a root', deptRows.filter((r) => r.parent_department_id == null).length === srcRoots.length,
    `db ${deptRows.filter((r) => r.parent_department_id == null).length} roots, source implies ${srcRoots.length} (${srcRoots.map((u) => u.id).join(', ')})`);

  // No cycle, and the tree is reachable from a root.
  let cyclic = 0;
  for (const r of deptRows) {
    const seen = new Set(); let cur = r;
    while (cur && cur.parent_department_id != null) {
      if (seen.has(cur.id)) { cyclic++; break; }
      seen.add(cur.id); cur = deptById.get(cur.parent_department_id);
    }
  }
  check('the department tree has no cycle', cyclic === 0, `${cyclic} rows loop`);

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

  // THE DEPARTMENT ASSIGNMENT, position by position. This is the new field and
  // the one most worth re-deriving: it is the product of a tree walk, and a
  // tree walk is exactly the kind of thing that is wrong in one branch only.
  const deptBad = real.filter((p) => {
    if (!posByCode.has(p.id)) return false;
    const want = unitOf(p);
    const got = posByCode.get(p.id).department_id;
    return (want ? deptByCode.get(want.id)?.id : null) !== (got ?? null);
  });
  check('every position carries its nearest enclosing unit', deptBad.length === 0,
    deptBad.slice(0, 8).map((p) => `${p.id}: source unit ${unitOf(p)?.id ?? 'none'} vs db dept id ${posByCode.get(p.id).department_id}`).join(' | '));
  check('no position is left without a department', posRows.every((r) => r.department_id != null),
    `${posRows.filter((r) => r.department_id == null).length} positions have none; the source's root seat is a unit, so every node resolves`);

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
  check('every department is ACTIVE', deptRows.every((r) => r.status === 'ACTIVE'),
    `${deptRows.filter((r) => r.status !== 'ACTIVE').length} are not`);

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

  // ---- 5. Work contexts ---------------------------------------------------
  const ctxRows = await q('SELECT id, code, name, context_type, location_id, department_id FROM hrms_work_contexts WHERE company_id=? AND deleted_at IS NULL', [c]);
  const ctxByCode = new Map(ctxRows.map((r) => [r.code, r]));
  same('exactly the machine nodes became work contexts',
    machines.map((m) => m.id), ctxRows.map((r) => r.code));
  const ctxNameBad = machines.filter((m) => ctxByCode.has(m.id) && norm(ctxByCode.get(m.id).name) !== clip(norm(m.title), 200));
  check('every context name matches', ctxNameBad.length === 0, ctxNameBad.map((m) => m.id).join(', '));
  check('every context is a MACHINE at the one location', ctxRows.every((r) => r.context_type === 'MACHINE' && r.location_id === locationId),
    `${ctxRows.filter((r) => r.context_type !== 'MACHINE').length} wrong type, ${ctxRows.filter((r) => r.location_id !== locationId).length} wrong location`);
  // Deliberately not set: the source says which unit a machine sits in, but the
  // import was scoped to positions. If that changes, this check is the reminder.
  check('no machine was given a department (not in scope, so not guessed)', ctxRows.every((r) => r.department_id == null),
    `${ctxRows.filter((r) => r.department_id != null).length} contexts carry one`);

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

  // ---- 7. Position -> context links ---------------------------------------
  const linkRows = await q(
    `SELECT p.position_code AS pos, w.code AS ctx, l.is_primary
       FROM hrms_position_work_contexts l
       JOIN hrms_positions p ON p.company_id=l.company_id AND p.id=l.position_id
       JOIN hrms_work_contexts w ON w.company_id=l.company_id AND w.id=l.work_context_id
      WHERE l.company_id=? AND l.deleted_at IS NULL`, [c]);
  const expectedLinks = real.flatMap((p) => contextsOf(p).map((m, i) => `${p.id}>${m.id}:${i === 0 ? 1 : 0}`));
  same('every machine context link matches the source, and there are no others',
    expectedLinks, linkRows.map((l) => `${l.pos}>${l.ctx}:${Number(l.is_primary)}`));
  check('every machine is worked by at least one position',
    machines.every((m) => linkRows.some((l) => l.ctx === m.id)),
    machines.filter((m) => !linkRows.some((l) => l.ctx === m.id)).map((m) => m.id).join(', '));

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
    ['work context', 'SELECT code k FROM hrms_work_contexts WHERE company_id=? AND deleted_at IS NULL'],
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
