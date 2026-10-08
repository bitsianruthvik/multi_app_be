/**
 * CF_HRMS organisation workbook generator.
 *
 * A template a non-technical person fills in to create a whole organisation's
 * chart in one go - and, more usefully, the SAME workbook pre-filled from what a
 * company already has, because editing beats authoring.
 *
 *   node org-template.mjs                      blank template, with grey examples
 *   node org-template.mjs --company=karni      pre-filled from that company's live data
 *   node org-template.mjs --company=karni --target=prod      (opt-in; local is the default)
 *   node org-template.mjs ... --out=C:/somewhere/file.xlsx   (default: the TM folder)
 *
 * The layout, formulas and drop-downs live in lib/orgTemplateSheets.mjs. THIS file
 * is the database half: it reads the company's rows (read-only SELECTs, nothing
 * is written to the database) and turns them into that module's plain input.
 *
 * WHAT A FILLED WORKBOOK CAN AND CANNOT SAY. The workbook is seat-shaped, the
 * database is role-and-assignment-shaped, so a few things are translated and a
 * few have no home. Every one is counted and printed, never dropped silently:
 *
 *   - Hierarchy: the PRIMARY_MANAGER edge of each position, walked depth-first
 *     (siblings in position-code order, as the org chart screen orders them).
 *     Machines are never in the outline: they are not managers, and the importer
 *     already re-pointed anything that hung under one to its nearest human.
 *   - Day & night: a position with a Day AND a Night manpower requirement is a
 *     "Day & night" seat, and the count is the per-shift number.
 *   - Responsibilities belong to a ROLE in the database, and several seats can
 *     share one role (eight "Operator" seats share one list of 56). The sheet is
 *     seat-keyed, so each role's list is written ONCE, against the first seat in
 *     outline order that has that role.
 *   - Reporting lines other than the main one (dotted lines) have no column; they
 *     are written into Notes in words.
 *   - Closed positions, ended assignments, resolved open points, KRAs/KPIs/skills
 *     and the like are not in the workbook; their counts are printed.
 *
 * THE ROUND TRIP. Every row of a pre-filled workbook carries a hidden KEY, the
 * database id of the record it shows (pos:, asg:, rsp:, ovr:, wct:, opn: - see
 * lib/orgTemplateSheets.mjs), and `Start here` carries the provenance (company,
 * database, time, schema version, a fingerprint of what the sheets show). The
 * ids ride on the rows `loadOrg` returns, so org-apply-workbook.mjs can read a
 * workbook back and compare it with the SAME rendering of the database that
 * produced it. That is why the export and the comparison share this one function:
 * the reverse trip is only as faithful as the forward one.
 *
 * What the workbook cannot say in reverse, and the applier therefore never writes:
 *   - Notes (it is generated text: dotted lines in words, uneven shifts);
 *   - the order of siblings (there is no sibling order in the database: they are
 *     shown in position-code order, so a new seat lands last under its manager);
 *   - a duty's place in its role's list;
 *   - which seat a role's duties are shown against (always the first seat of the role).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import ExcelJS from 'exceljs';
import mysql from 'mysql2/promise';
import { resolveTarget, announce } from './dbTarget.mjs';
import { buildOrgWorkbook, checkOrgWorkbook, fingerprintOf, squeeze, seatRef, DAY_AND_NIGHT, LEVELS, SCHEMA_VERSION } from './lib/orgTemplateSheets.mjs';

const TM_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

const args = process.argv.slice(2);
const arg = (name) => {
  const hit = args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return null;
  return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : '';
};

// ------------------------------------------------------------- small helpers ----
const natural = (a, b) => String(a ?? '').localeCompare(String(b ?? ''), 'en', { numeric: true, sensitivity: 'base' });
const pad2 = (n) => String(n).padStart(2, '0');
const todayText = () => { const d = new Date(); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
const longDate = (d = new Date()) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
/** A DATE column comes back as 'YYYY-MM-DD' (dateStrings). Excel stores a date as UTC midnight, so no time zone can move it a day. */
const utcDate = (text) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(text ?? ''));
  return m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : null;
};
const KIND_OF = { MACHINE: 'Machine', LINE: 'Line', AREA: 'Area', PROJECT: 'Project', CELL: 'Cell', OTHER: 'Other' };

// -------------------------------------------------------------- the loading ----
/**
 * @returns {{data: object, report: {stats: object, warnings: string[], notInWorkbook: string[]}}}
 */
async function loadOrg(conn, slug) {
  const q = async (sql, params = []) => (await conn.execute(sql, params))[0];
  const today = todayText();
  // "live today": the same rule as the rest of the app (positionService LIVE_ON)
  const live = (a) => `(${a}.effective_from IS NULL OR ${a}.effective_from <= ?) AND (${a}.effective_to IS NULL OR ${a}.effective_to >= ?)`;
  const warnings = [];
  const notInWorkbook = [];

  const [company] = await q('SELECT id, name, slug FROM companies WHERE slug = ? AND deleted_at IS NULL', [slug]);
  if (!company) throw new Error(`No company with slug "${slug}".`);
  const id = company.id;

  const shiftRows = await q("SELECT code, name FROM hrms_shifts WHERE company_id = ? AND deleted_at IS NULL AND status = 'ACTIVE' ORDER BY id", [id]);
  const shiftName = new Map(shiftRows.map((s) => [s.code, squeeze(s.name)]));

  const positions = await q(
    `SELECT p.id, p.position_code AS code, p.position_title AS title, p.role_id, p.sanctioned_headcount AS headcount,
            p.department_id, p.location_id, p.default_shift_id AS shift_id, p.status,
            r.title AS role_title, d.name AS department, l.name AS location, s.code AS shift_code
       FROM hrms_positions p
       LEFT JOIN hrms_roles       r ON r.company_id = p.company_id AND r.id = p.role_id        AND r.deleted_at IS NULL
       LEFT JOIN hrms_departments d ON d.company_id = p.company_id AND d.id = p.department_id  AND d.deleted_at IS NULL
       LEFT JOIN hrms_locations   l ON l.company_id = p.company_id AND l.id = p.location_id    AND l.deleted_at IS NULL
       LEFT JOIN hrms_shifts      s ON s.company_id = p.company_id AND s.id = p.default_shift_id AND s.deleted_at IS NULL
      WHERE p.company_id = ? AND p.deleted_at IS NULL AND p.status <> 'CLOSED'
      ORDER BY p.position_code, p.id`, [id]);
  const [{ n: closed }] = await q("SELECT COUNT(*) AS n FROM hrms_positions WHERE company_id = ? AND deleted_at IS NULL AND status = 'CLOSED'", [id]);
  if (closed) notInWorkbook.push(`${closed} closed position(s)`);
  if (!positions.length) throw new Error(`${company.name} has no positions to put in a workbook.`);

  // ---- the outline: PRIMARY_MANAGER edges, depth first ----
  const edges = await q(
    `SELECT rr.id AS edge_id, rr.from_position_id AS from_id, rr.to_position_id AS to_id, rr.scope_label,
            t.code AS type_code, t.name AS type_name
       FROM hrms_position_reporting_relationships rr
       JOIN hrms_reporting_relationship_types t ON t.company_id = rr.company_id AND t.id = rr.relationship_type_id AND t.deleted_at IS NULL
      WHERE rr.company_id = ? AND rr.deleted_at IS NULL AND ${live('rr')}
      ORDER BY rr.is_primary DESC, t.sort_order, rr.id`, [id, today, today]);

  const byId = new Map(positions.map((p) => [p.id, p]));
  const parentOf = new Map();
  const primaryEdgeOf = new Map();
  for (const e of edges.filter((x) => x.type_code === 'PRIMARY_MANAGER')) {
    if (!byId.has(e.from_id)) continue;
    if (parentOf.has(e.from_id)) { warnings.push(`position ${byId.get(e.from_id).code} has more than one main manager; the first was used`); continue; }
    if (!byId.has(e.to_id)) { warnings.push(`position ${byId.get(e.from_id).code} reports to a position that is not in the chart; it is shown as a top-level seat`); continue; }
    parentOf.set(e.from_id, e.to_id);
    primaryEdgeOf.set(e.from_id, e.edge_id);
  }
  const bySiblings = (a, b) => natural(a.code, b.code) || a.id - b.id;
  const kids = new Map();
  const roots = [];
  for (const p of positions) {
    const parent = parentOf.get(p.id);
    if (parent == null) { roots.push(p); continue; }
    if (!kids.has(parent)) kids.set(parent, []);
    kids.get(parent).push(p);
  }
  roots.sort(bySiblings);
  for (const list of kids.values()) list.sort(bySiblings);

  const ordered = []; // { p, level, parent: index in `ordered` | null }
  const seen = new Set();
  const walk = (root) => {
    const stack = [{ p: root, level: 1, parent: null }];
    while (stack.length) {
      const item = stack.pop();
      if (seen.has(item.p.id)) continue;
      seen.add(item.p.id);
      const index = ordered.push(item) - 1;
      const children = kids.get(item.p.id) ?? [];
      for (let i = children.length - 1; i >= 0; i--) stack.push({ p: children[i], level: item.level + 1, parent: index });
    }
  };
  roots.forEach(walk);
  const stranded = positions.filter((p) => !seen.has(p.id)); // members of a reporting cycle: no root reaches them
  for (const p of stranded) walk(p);
  if (stranded.length) warnings.push(`${stranded.length} position(s) sit in a reporting loop and are shown as top-level seats`);
  const deepest = Math.max(...ordered.map((o) => o.level));
  if (deepest > LEVELS) throw new Error(`The chart is ${deepest} levels deep and the workbook has ${LEVELS} Level columns.`);
  const indexOfPosition = new Map(ordered.map((o, i) => [o.p.id, i]));

  // ---- shifts, machines, notes per seat ----
  const manpower = await q(
    `SELECT m.id, m.position_id, m.shift_id, s.code AS shift_code, m.required_count AS n
       FROM hrms_manpower_requirements m
       JOIN hrms_shifts s ON s.company_id = m.company_id AND s.id = m.shift_id AND s.deleted_at IS NULL
      WHERE m.company_id = ? AND m.deleted_at IS NULL AND m.position_id IS NOT NULL AND ${live('m')}`, [id, today, today]);
  const manpowerOf = new Map();
  for (const m of manpower) { if (!manpowerOf.has(m.position_id)) manpowerOf.set(m.position_id, []); manpowerOf.get(m.position_id).push(m); }

  const posContexts = await q(
    `SELECT c.id AS link_id, c.position_id, c.work_context_id AS context_id, c.is_primary, wc.name
       FROM hrms_position_work_contexts c
       JOIN hrms_work_contexts wc ON wc.company_id = c.company_id AND wc.id = c.work_context_id AND wc.deleted_at IS NULL
      WHERE c.company_id = ? AND c.deleted_at IS NULL AND ${live('c')}
      ORDER BY c.is_primary DESC, wc.name`, [id, today, today]);
  const machinesOf = new Map();
  const contextLinksOf = new Map();
  for (const c of posContexts) {
    if (!machinesOf.has(c.position_id)) { machinesOf.set(c.position_id, []); contextLinksOf.set(c.position_id, []); }
    machinesOf.get(c.position_id).push(squeeze(c.name));
    contextLinksOf.get(c.position_id).push({ linkId: c.link_id, contextId: c.context_id, name: squeeze(c.name), isPrimary: Boolean(c.is_primary) });
  }

  // reporting lines that are not the main one have no column: say them in words, in Notes
  const otherLines = new Map();
  const nameOf = (p) => squeeze(p.title || p.role_title || p.code);
  const titleUses = new Map();
  for (const p of positions) titleUses.set(nameOf(p).toLowerCase(), (titleUses.get(nameOf(p).toLowerCase()) ?? 0) + 1);
  for (const e of edges.filter((x) => x.type_code !== 'PRIMARY_MANAGER')) {
    const from = byId.get(e.from_id);
    const to = byId.get(e.to_id);
    if (!from || !to) continue;
    // a title shared by several seats cannot say which one is meant, so add its Ref (true as of this copy)
    const which = titleUses.get(nameOf(to).toLowerCase()) > 1 ? ` [${seatRef(indexOfPosition.get(to.id))}]` : '';
    const text = `${squeeze(e.type_name)} to ${nameOf(to)}${which}${e.scope_label ? ` (${squeeze(e.scope_label)})` : ''}`;
    if (!otherLines.has(e.from_id)) otherLines.set(e.from_id, []);
    otherLines.get(e.from_id).push(text);
  }
  const otherLineCount = [...otherLines.values()].reduce((n, list) => n + list.length, 0);

  const seats = ordered.map(({ p, level, parent }) => {
    const reqs = manpowerOf.get(p.id) ?? [];
    const codes = new Set(reqs.map((r) => r.shift_code));
    const notes = [];
    let shift = shiftName.get(p.shift_code) ?? '';
    let count = Number(p.headcount);
    if (codes.has('D') && codes.has('N')) {
      // Day AND night: the number on the row is the number needed on EACH shift (plan §9.1)
      const perShift = reqs.filter((r) => r.shift_code === 'D' || r.shift_code === 'N').map((r) => Number(r.n));
      shift = DAY_AND_NIGHT;
      count = Math.max(...perShift);
      if (!perShift.every((n) => n === perShift[0])) {
        notes.push(`The system has different numbers per shift (${reqs.map((r) => `${shiftName.get(r.shift_code) ?? r.shift_code} ${Number(r.n)}`).join(', ')}).`);
        warnings.push(`position ${p.code} needs different numbers on the two shifts; the larger is on the row and the detail is in Notes`);
      }
    } else if (!shift && reqs.length === 1) {
      shift = shiftName.get(reqs[0].shift_code) ?? '';
    }
    if (otherLines.has(p.id)) notes.push(`${otherLines.get(p.id).join('; ')}.`);
    return {
      title: squeeze(p.title || p.role_title || p.code),
      level,
      count: Number.isFinite(count) ? count : 1,
      shift,
      department: squeeze(p.department),
      location: squeeze(p.location),
      machines: machinesOf.get(p.id) ?? [],
      notes: notes.join(' '),
      parent,                       // index into `seats`; the workbook builder ignores it, the self-check uses it
      positionId: p.id, roleId: p.role_id, code: p.code, roleTitle: p.role_title,
      // ---- what the applier needs to compare this row with a workbook and write it back (the builder ignores all of it) ----
      key: `pos:${p.id}`,
      parentPositionId: parentOf.get(p.id) ?? null,
      primaryEdgeId: primaryEdgeOf.get(p.id) ?? null,
      status: p.status,
      headcountRaw: Number(p.headcount),
      shiftId: p.shift_id ?? null,
      shiftCode: p.shift_code ?? null,
      departmentId: p.department_id ?? null,
      locationId: p.location_id ?? null,
      manpower: reqs.map((r) => ({ id: r.id, shiftId: r.shift_id, shiftCode: r.shift_code, count: Number(r.n) })),
      contextLinks: contextLinksOf.get(p.id) ?? [],
    };
  });

  // a reader that groups seats by TITLE must land on the same groups the database has by ROLE
  const normTitle = (s) => squeeze(s).toLowerCase().replace(/[.;,]+$/, '');
  const rolesOfTitle = new Map();
  const titlesOfRole = new Map();
  for (const s of seats) {
    const t = normTitle(s.title);
    if (!rolesOfTitle.has(t)) rolesOfTitle.set(t, new Set());
    rolesOfTitle.get(t).add(s.roleId);
    if (!titlesOfRole.has(s.roleId)) titlesOfRole.set(s.roleId, new Set());
    titlesOfRole.get(s.roleId).add(t);
  }
  const splitTitles = [...rolesOfTitle].filter(([, roles]) => roles.size > 1).length;
  const mergedRoles = [...titlesOfRole].filter(([, titles]) => titles.size > 1).length;
  if (splitTitles) warnings.push(`${splitTitles} title(s) belong to more than one role in the system; a reader that groups seats by title will merge them`);
  if (mergedRoles) warnings.push(`${mergedRoles} role(s) are used by seats with different titles; a reader that groups seats by title will split them`);

  // ---- machines & areas ----
  const contexts = await q(
    `SELECT wc.id, wc.name, wc.context_type AS type, wc.location_id, wc.status, l.name AS location
       FROM hrms_work_contexts wc
       LEFT JOIN hrms_locations l ON l.company_id = wc.company_id AND l.id = wc.location_id AND l.deleted_at IS NULL
      WHERE wc.company_id = ? AND wc.deleted_at IS NULL`, [id]);
  const machines = contexts
    .map((c) => ({
      name: squeeze(c.name), kind: KIND_OF[c.type] ?? 'Other', where: squeeze(c.location),
      key: `wct:${c.id}`, id: c.id, locationId: c.location_id ?? null, typeCode: c.type, status: c.status,
    }))
    .sort((a, b) => natural(a.name, b.name));
  for (const m of machines) {
    if (m.name.includes(',')) {
      warnings.push(`machine "${m.name}" has a comma in its name: the Machines column is read against the machine list so it still round-trips, `
        + 'but Machines & areas will not let anyone type a comma, so the name cannot be re-entered by hand');
    }
  }
  const machineNames = new Set(machines.map((m) => m.name.toLowerCase()));
  for (const s of seats) for (const n of s.machines) if (!machineNames.has(n.toLowerCase())) warnings.push(`seat ${s.code} works "${n}", which is not in the machine list`);

  // ---- people ----
  const assignments = await q(
    `SELECT wa.id AS assignment_id, wa.position_id, wa.role_id, wa.default_shift_id AS shift_id, wa.is_primary, wa.allocation_percent,
            wa.effective_from, e.id AS employee_id, e.full_name, e.employee_code, e.date_of_joining, s.code AS shift_code
       FROM hrms_work_assignments wa
       JOIN hrms_employees e ON e.company_id = wa.company_id AND e.id = wa.employee_id AND e.deleted_at IS NULL
       LEFT JOIN hrms_shifts s ON s.company_id = wa.company_id AND s.id = wa.default_shift_id AND s.deleted_at IS NULL
      WHERE wa.company_id = ? AND wa.deleted_at IS NULL AND wa.status = 'ACTIVE' AND wa.position_id IS NOT NULL AND ${live('wa')}
      ORDER BY e.full_name, wa.id`, [id, today, today]);
  const people = [];
  let onClosedSeats = 0;
  for (const a of assignments) {
    const seat = indexOfPosition.get(a.position_id);
    if (seat == null) { onClosedSeats++; continue; }
    people.push({
      name: squeeze(a.full_name), seat, shift: shiftName.get(a.shift_code) ?? '',
      code: squeeze(a.employee_code), joined: utcDate(a.date_of_joining),
      key: `asg:${a.assignment_id}`, assignmentId: a.assignment_id, employeeId: a.employee_id, seatKey: seats[seat].key,
      roleId: a.role_id, shiftId: a.shift_id ?? null, isPrimary: Boolean(a.is_primary),
      allocation: a.allocation_percent == null ? null : Number(a.allocation_percent), effectiveFrom: a.effective_from ?? null,
    });
  }
  people.sort((a, b) => a.seat - b.seat || natural(a.name, b.name));
  if (onClosedSeats) notInWorkbook.push(`${onClosedSeats} assignment(s) on closed positions`);
  const [{ n: employees }] = await q('SELECT COUNT(*) AS n FROM hrms_employees WHERE company_id = ? AND deleted_at IS NULL', [id]);
  const seated = new Set(assignments.filter((a) => indexOfPosition.has(a.position_id)).map((a) => a.employee_id)).size;
  if (employees > seated) notInWorkbook.push(`${employees - seated} employee(s) with no current seat`);
  const joinedDates = new Set(people.map((p) => p.joined?.getTime()).filter((t) => t != null));
  if (people.length > 1 && joinedDates.size === 1) {
    warnings.push(`all ${people.length} people share one Joined date (${[...joinedDates].map((t) => new Date(t).toISOString().slice(0, 10))[0]}); if that is a stand-in (the chart import used the chart date), replace it with the real joining dates`);
  }

  // ---- responsibilities: a role's list, written once, on the first seat that has the role ----
  const roleResp = await q(
    `SELECT a.id AS row_id, a.role_id, a.responsibility_definition_id AS def_id, a.sequence,
            COALESCE(NULLIF(TRIM(d.description), ''), d.name) AS text
       FROM hrms_role_responsibility_assignments a
       JOIN hrms_responsibility_definitions d ON d.company_id = a.company_id AND d.id = a.responsibility_definition_id AND d.deleted_at IS NULL
      WHERE a.company_id = ? AND a.deleted_at IS NULL AND ${live('a')}
      ORDER BY a.role_id, a.sequence, a.id`, [id, today, today]);
  const firstSeatOfRole = new Map();
  const seatsOfRole = new Map();
  seats.forEach((s, i) => {
    if (!firstSeatOfRole.has(s.roleId)) firstSeatOfRole.set(s.roleId, i);
    seatsOfRole.set(s.roleId, (seatsOfRole.get(s.roleId) ?? 0) + 1);
  });
  const perSeat = seats.map(() => []);
  let roleLevel = 0;
  let noSeat = 0;
  for (const r of roleResp) {
    const text = squeeze(r.text);
    if (!text) continue;
    const seat = firstSeatOfRole.get(r.role_id);
    if (seat == null) { noSeat++; continue; }
    perSeat[seat].push({ text, key: `rsp:${r.role_id}:${r.def_id}`, roleId: r.role_id, defId: r.def_id, rowId: r.row_id, sequence: r.sequence });
    roleLevel++;
  }
  if (noSeat) notInWorkbook.push(`${noSeat} responsibilit(ies) on roles that no seat uses`);
  const sharedRoles = [...seatsOfRole].filter(([roleId, n]) => n > 1 && roleResp.some((r) => r.role_id === roleId));
  const sharedRoleSeatsLeftEmpty = sharedRoles.reduce((n, [, seatCount]) => n + seatCount - 1, 0);

  const overrides = await q(
    `SELECT o.id, o.position_id, o.action, o.responsibility_definition_id AS def_id, COALESCE(NULLIF(TRIM(d.description), ''), d.name) AS text
       FROM hrms_position_content_overrides o
       LEFT JOIN hrms_responsibility_definitions d ON d.company_id = o.company_id AND d.id = o.responsibility_definition_id AND d.deleted_at IS NULL
      WHERE o.company_id = ? AND o.deleted_at IS NULL AND o.content_type = 'RESPONSIBILITY' AND ${live('o')}`, [id, today, today]);
  let overridesAdded = 0;
  let overridesLost = 0;
  for (const o of overrides) {
    const seat = indexOfPosition.get(o.position_id);
    const text = squeeze(o.text);
    if (o.action === 'ADD' && seat != null && text) {
      if (!perSeat[seat].some((x) => x.text === text)) {
        perSeat[seat].push({ text, key: `ovr:${o.id}`, overrideId: o.id, defId: o.def_id, positionId: o.position_id });
        overridesAdded++;
      }
    } else overridesLost++;
  }
  if (overridesLost) notInWorkbook.push(`${overridesLost} seat-level responsibility override(s) that suppress or replace a duty`);
  const responsibilities = [];
  perSeat.forEach((list, seat) => list.forEach((x) => responsibilities.push({ ...x, seat })));

  // ---- open points -> questions ----
  const points = await q(
    `SELECT op.id, op.entity_type, op.entity_id, op.description FROM hrms_open_points op
      WHERE op.company_id = ? AND op.deleted_at IS NULL AND op.status = 'OPEN' ORDER BY op.id`, [id]);
  const [{ n: settled }] = await q("SELECT COUNT(*) AS n FROM hrms_open_points WHERE company_id = ? AND deleted_at IS NULL AND status <> 'OPEN'", [id]);
  if (settled) notInWorkbook.push(`${settled} resolved or dismissed open point(s)`);
  const roleTitles = new Map(positions.map((p) => [p.role_id, squeeze(p.role_title)]));
  const seatOfAssignment = new Map(assignments.map((a) => [a.assignment_id, indexOfPosition.get(a.position_id)]));
  const contextNames = new Map((await q('SELECT id, name FROM hrms_work_contexts WHERE company_id = ? AND deleted_at IS NULL', [id])).map((c) => [c.id, squeeze(c.name)]));
  const questions = [];
  for (const op of points) {
    const text = squeeze(op.description);
    if (!text) continue;
    let seat = null;
    let prefix = '';
    switch (op.entity_type) {
      case 'POSITION':
        seat = indexOfPosition.get(op.entity_id) ?? null;
        if (seat == null) prefix = '(About a seat that is no longer in the chart) ';
        break;
      case 'WORK_ASSIGNMENT':
        seat = seatOfAssignment.get(op.entity_id) ?? null;
        if (seat == null) prefix = '(About a person who is no longer in a seat) ';
        break;
      case 'ROLE': prefix = `(About the role "${roleTitles.get(op.entity_id) ?? op.entity_id}") `; break;
      case 'WORK_CONTEXT': prefix = `(About "${contextNames.get(op.entity_id) ?? op.entity_id}") `; break;
      default: break; // ORGANIZATION: the whole organisation, no seat
    }
    questions.push({ seat, text: prefix + text, id: op.id, key: `opn:${op.id}`, entityType: op.entity_type, entityId: op.entity_id ?? null, prefix, rawText: text });
  }
  // the whole organisation first, then seat by seat in outline order
  questions.sort((a, b) => (a.seat ?? -1) - (b.seat ?? -1) || a.id - b.id);

  // ---- content the workbook has no room for ----
  const [content] = await q(
    `SELECT
       (SELECT COUNT(*) FROM hrms_role_kra_assignments           WHERE company_id = ? AND deleted_at IS NULL) AS kras,
       (SELECT COUNT(*) FROM hrms_role_kpi_assignments           WHERE company_id = ? AND deleted_at IS NULL) AS kpis,
       (SELECT COUNT(*) FROM hrms_role_skill_requirements        WHERE company_id = ? AND deleted_at IS NULL) AS skills,
       (SELECT COUNT(*) FROM hrms_role_qualification_requirements WHERE company_id = ? AND deleted_at IS NULL) AS quals,
       (SELECT COUNT(*) FROM hrms_role_authority_assignments     WHERE company_id = ? AND deleted_at IS NULL) AS authorities`,
    [id, id, id, id, id]);
  for (const [k, label] of [['kras', 'KRA'], ['kpis', 'KPI'], ['skills', 'skill'], ['quals', 'qualification'], ['authorities', 'authority']]) {
    if (Number(content[k])) notInWorkbook.push(`${content[k]} role ${label} assignment(s)`);
  }

  const startNotes = [];
  if (otherLineCount) {
    startNotes.push(`${otherLineCount} dotted-line report${otherLineCount === 1 ? ' is' : 's are'} written in Notes, in words (there is no column to set ${otherLineCount === 1 ? 'it' : 'them'} up).`);
  }
  if (sharedRoles.length) {
    startNotes.push(`${sharedRoles.length} title${sharedRoles.length === 1 ? ' is' : 's are'} shared by several seats; the duties are written once, on the first of them.`);
  }

  const data = {
    company: { id: company.id, name: company.name, slug: company.slug },
    generatedOn: longDate(),
    shifts: [...shiftName.values()],
    startNotes,
    seats, people, responsibilities, machines, questions,
  };

  const stats = {
    company: `${company.name} (id ${company.id}, slug ${company.slug})`,
    seats: seats.length,
    deepestLevel: deepest,
    topLevelSeats: roots.length + stranded.length,
    dayAndNightSeats: seats.filter((s) => s.shift === DAY_AND_NIGHT).length,
    people: people.length,
    responsibilitiesInWorkbook: responsibilities.length,
    responsibilitiesFromRoles: roleLevel,
    responsibilitiesFromSeatOverrides: overridesAdded,
    rolesSharedBySeveralSeats: sharedRoles.length,
    seatsLeftWithNoRowsBecauseTheirRoleIsShared: sharedRoleSeatsLeftEmpty,
    machines: machines.length,
    questions: questions.length,
    organisationWideQuestions: questions.filter((x) => x.seat == null).length,
    otherReportingLinesWrittenAsNotes: otherLineCount,
  };
  return { data, report: { stats, warnings, notInWorkbook } };
}

/**
 * The whole export in one call: read the company, stamp the provenance, build the workbook.
 * The provenance is what lets org-apply-workbook.mjs refuse a workbook that belongs to a different company or
 * database, and the fingerprint is what lets it notice the database has moved since.
 *
 * @param {import('mysql2/promise').Connection} conn  opened with dateStrings: true
 * @param {{isProd:boolean, name:string}} target      from dbTarget.resolveTarget()
 */
export async function exportWorkbook(conn, slug, target) {
  const loaded = await loadOrg(conn, slug);
  const { data } = loaded;
  data.provenance = {
    schemaVersion: SCHEMA_VERSION,
    companySlug: data.company.slug,
    companyId: data.company.id,
    target: target.isProd ? 'prod' : 'local',
    // the host of a production database is not something to carry around in a file that gets e-mailed
    targetName: target.isProd ? 'PRODUCTION (TiDB)' : target.name,
    exportedAt: new Date().toISOString(),
    contentHash: fingerprintOf(data),
    counts: {
      structure: data.seats.length, people: data.people.length, responsibilities: data.responsibilities.length,
      machines: data.machines.length, questions: data.questions.length,
    },
  };
  return { ...loaded, wb: buildOrgWorkbook(data) };
}

// --------------------------------------------------------------------- main ----
async function main() {
  const slug = arg('company');
  if (slug === '') throw new Error('--company needs a slug, e.g. --company=karni');
  let loaded = null;
  let target = null;

  if (slug) {
    target = resolveTarget();
    announce(target);
    const conn = await mysql.createConnection({ ...target.cfg, dateStrings: true });
    try {
      loaded = await exportWorkbook(conn, slug, target);
    } finally {
      await conn.end();
    }
  } else if (args.some((a) => a === '--target=prod' || a === '--prod')) {
    console.log('(--target=prod is ignored: the blank template reads no database.)');
  }

  const wb = loaded ? loaded.wb : buildOrgWorkbook(null);

  const defaultName = slug
    ? `CF_HRMS_org_workbook_${slug}${target.isProd ? '_PROD' : ''}.xlsx`
    : 'CF_HRMS_org_workbook_blank.xlsx';
  const file = path.resolve(arg('out') || path.join(TM_ROOT, defaultName));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    await wb.xlsx.writeFile(file);
  } catch (e) {
    if (e.code === 'EBUSY' || e.code === 'EPERM') throw new Error(`Cannot write ${file}: is it open in Excel? Close it and run again.`);
    throw e;
  }

  // Prove the file on disk, not the object in memory: open it again and check it.
  const reread = new ExcelJS.Workbook();
  await reread.xlsx.readFile(file);
  const { problems, stats } = checkOrgWorkbook(reread, loaded ? loaded.data : null);

  console.log(`written   ${file}  (${(fs.statSync(file).size / 1024).toFixed(0)} KB)`);
  console.log(`sheets    ${reread.worksheets.map((w) => `${w.name}${w.state === 'hidden' ? ' (hidden)' : ''}`).join(' | ')}`);
  console.log(`in file   ${stats.seats} seat rows, deepest in Level ${stats.deepestLevel}, ${stats.people} people, ${stats.responsibilities} responsibilities, `
    + `${stats.machines} machines, ${stats.questions} questions, ${stats.dropdowns} drop-down columns, ${stats.exampleRows} example rows`);
  if (loaded) {
    const pv = loaded.data.provenance;
    console.log(`round trip  every row carries its database id in the hidden last column; stamped ${pv.companySlug} (id ${pv.companyId}), `
      + `${pv.target}, schema ${pv.schemaVersion}, ${pv.exportedAt}`);
    console.log('\nfrom the database:');
    for (const [k, v] of Object.entries(loaded.report.stats)) console.log(`  ${k.padEnd(46)} ${v}`);
    if (loaded.report.notInWorkbook.length) {
      console.log('\nin the database but NOT in the workbook (it has no place for them):');
      loaded.report.notInWorkbook.forEach((x) => console.log(`  - ${x}`));
    }
    if (loaded.report.warnings.length) {
      console.log('\nwarnings:');
      loaded.report.warnings.forEach((x) => console.log(`  ! ${x}`));
    }
  }
  if (problems.length) {
    console.error(`\nSELF-CHECK FAILED (${problems.length}):`);
    problems.slice(0, 25).forEach((x) => console.error(`  x ${x}`));
    process.exitCode = 1;
  } else {
    console.log('\nself-check passed: sheet order, hidden Lists, headings, freeze panes, drop-downs, names, outline rule'
      + (loaded ? ', and every count and parent agrees with the database.' : '.'));
  }
}

// Run only when started as a script, so a test can import loadOrg without writing a workbook.
// (The file-name test is a fallback for a path that differs in spelling but is the same file: a subst drive, a link.)
const here = fileURLToPath(import.meta.url);
if (process.argv[1] && (import.meta.url === pathToFileURL(process.argv[1]).href || path.basename(process.argv[1]) === path.basename(here))) {
  main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
}

export { loadOrg };
