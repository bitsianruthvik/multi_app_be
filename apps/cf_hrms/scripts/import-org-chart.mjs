/**
 * Org_Chart_V12.html  ->  CF_HRMS
 *
 * The first real run of the migration described in TM/CF_HRMS_PLAN.md §9. This
 * is a SCRIPT, not the product feature: routes/imports.js (Phase 8) will do the
 * same work behind a parse -> validate -> commit UI. The logic here is meant to
 * be lifted into importService.js, so keep it honest.
 *
 * THE IMPORT IS AN INVERSION, NOT A COPY. The source is position-shaped with
 * people embedded inside position rows; the target is assignment-shaped. The
 * three rules that matter, all measured against the real file:
 *
 *   1. A machine is never a manager. 36 nodes hang under one. Their formal
 *      manager is the nearest non-machine ancestor; the machines they passed
 *      become work contexts on the position.
 *   2. Only 13 of the 43 `people` rows are people. The other 30 have a blank
 *      name — they are seat markers the client used to record a shift and an
 *      attendance state for an unfilled seat. Importing them would create 30
 *      employees named "".
 *   3. `kras[]` are task statements, not Key Result Areas. They import as
 *      Responsibilities. Promoting them to KRAs would corrupt the one
 *      distinction the whole model is built on.
 *
 * Usage:
 *   node import-org-chart.mjs --company=karni [--dry-run] [--wipe]
 *
 * --dry-run prints the validation report and writes nothing.
 * --wipe clears this company's hrms_ rows first (local development only).
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import mysql from 'mysql2/promise';
import { resolveTarget, announce } from './dbTarget.mjs';

const TARGET = resolveTarget();

const SOURCE = 'C:/Users/Digital Initiatives/Downloads/Org_Chart_V12.html';

const args = process.argv.slice(2);
const arg = (n, d) => (args.find((a) => a.startsWith(`--${n}=`)) || `--${n}=${d}`).split('=')[1];
const has = (n) => args.includes(`--${n}`);
const COMPANY_SLUG = arg('company', 'karni');
const DRY = has('dry-run');
const WIPE = has('wipe');

/** Findings the client has to see before this is trusted. Plan §9. */
const findings = [];
const note = (kind, detail) => findings.push({ kind, detail });

const norm = (s) => String(s ?? '').trim().replace(/\s+/g, ' ');
const normKey = (s) => norm(s).toLowerCase().replace(/[.;,]+$/, '');

// ---------------------------------------------------------------- parse ----
function readSeed() {
  const html = fs.readFileSync(SOURCE, 'utf8');
  const m = html.match(/<script id="seed" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) throw new Error('No <script id="seed"> block in the source file.');
  return {
    seed: JSON.parse(m[1]),
    hash: crypto.createHash('sha256').update(html).digest('hex'),
    size: Buffer.byteLength(html),
  };
}

/**
 * The two ancestor walks, reproduced from the source tool (Org_Chart_V12.html
 * `managerOf` / `machinesOf`) including their cycle guards.
 *
 * One deliberate difference. The tool collects machines only while the ancestor
 * is itself a machine, which loses the context of a node sitting under a SHARED
 * node that sits under a machine — P210 "Asst Op 1 & 2 & 3 (Shared between 3
 * machines)" ends up with no machines at all, though its title says otherwise.
 * Here the context walk continues through `shared` nodes and stops at the first
 * `role`, so those positions keep the machines they actually work on. The
 * MANAGER walk is unchanged: a shared node is a real supervisory position and
 * stays the manager of its children.
 */
function walks(byId) {
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
  return { managerOf, contextsOf };
}

// ------------------------------------------------------------- db helper ----
function makeDb(conn, companyId) {
  const ins = async (table, row) => {
    const cols = Object.keys(row);
    const [r] = await conn.execute(
      `INSERT INTO ${table} (company_id, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})`,
      [companyId, ...cols.map((c) => row[c])],
    );
    return r.insertId;
  };
  return { ins };
}

// ------------------------------------------------------------------ main ----
async function main() {
  announce(TARGET);
  if (WIPE && TARGET.isProd) {
    throw new Error("--wipe is refused against production. Deleting a live tenant's rows is not something a convenience flag should do; write a deliberate script if you really mean it.");
  }
  const { seed, hash, size } = readSeed();
  const conn = await mysql.createConnection(TARGET.cfg);
  await conn.query('SET SESSION sql_mode = ""');

  const [[company]] = await conn.query('SELECT id, name FROM companies WHERE slug = ? AND deleted_at IS NULL', [COMPANY_SLUG]);
  if (!company) throw new Error(`No company with slug "${COMPANY_SLUG}". Create it first.`);
  const companyId = company.id;
  const { ins } = makeDb(conn, companyId);

  if (WIPE && !DRY) {
    const order = [
      'hrms_attendance_records', 'hrms_work_assignment_contexts', 'hrms_assignment_reporting_relationships',
      'hrms_work_assignment_content_overrides', 'hrms_work_assignments', 'hrms_employment_events',
      'hrms_employee_identifiers', 'hrms_employee_documents', 'hrms_employees',
      'hrms_manpower_requirements', 'hrms_position_reporting_relationships', 'hrms_position_work_contexts',
      'hrms_position_content_overrides', 'hrms_positions',
      'hrms_role_responsibility_assignments', 'hrms_role_kpi_assignments', 'hrms_role_kra_assignments',
      'hrms_roles', 'hrms_responsibility_definitions', 'hrms_kpi_definitions', 'hrms_kra_definitions',
      'hrms_qualification_definitions', 'hrms_open_points', 'hrms_work_contexts', 'hrms_locations',
      'hrms_import_runs',
    ];
    await conn.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const t of order) await conn.execute(`DELETE FROM ${t} WHERE company_id = ?`, [companyId]);
    await conn.query('SET FOREIGN_KEY_CHECKS = 1');
  }

  const nodes = seed.positions;
  const byId = new Map(nodes.map((p) => [p.id, p]));
  const { managerOf, contextsOf } = walks(byId);
  const chartDate = seed.meta?.date || '2026-09-10';

  const machines = nodes.filter((p) => p.kind === 'machine');
  const real = nodes.filter((p) => p.kind !== 'machine');          // role + shared = a position
  const counts = { nodes: nodes.length, machines: machines.length, positions: real.length };

  // ---- shifts already seeded (G/D/N). Map the source's letters onto them. ----
  const [shiftRows] = await conn.execute('SELECT id, code FROM hrms_shifts WHERE company_id = ? AND deleted_at IS NULL', [companyId]);
  const shiftByCode = new Map(shiftRows.map((s) => [s.code, s.id]));
  if (!shiftByCode.size) throw new Error('No shifts for this company — run models/seed.sql first.');

  const [typeRows] = await conn.execute('SELECT id, code FROM hrms_reporting_relationship_types WHERE company_id = ? AND deleted_at IS NULL', [companyId]);
  const typeByCode = new Map(typeRows.map((t) => [t.code, t.id]));
  if (!typeByCode.has('PRIMARY_MANAGER')) throw new Error('Reporting types missing — run models/seed.sql first.');

  if (DRY) {
    report(seed, nodes, real, machines, counts, byId, managerOf, contextsOf);
    await conn.end();
    return;
  }

  // ---- 1. Location -----------------------------------------------------
  // The chart's subtitle is the only place the site is named. There is no
  // department data in the source at all — see the findings.
  const locationId = await ins('hrms_locations', {
    code: 'UNIT2', name: norm(seed.meta?.subtitle || '').replace(/^Organisation chart,\s*/i, '') || 'Unit 2',
    location_type: 'PLANT', status: 'ACTIVE',
  });
  note('Departments not imported',
    'The source chart carries no department data — only titles like "Production Head/Manager" that hint at one. '
    + 'Inventing departments from title text would put guesses into a live system, so every position is imported '
    + 'without a department for the client to assign.');

  // ---- 2. Work contexts (the machines) ---------------------------------
  const ctxByNode = new Map();
  for (const m of machines) {
    ctxByNode.set(m.id, await ins('hrms_work_contexts', {
      code: m.id, name: norm(m.title), context_type: 'MACHINE',
      location_id: locationId, status: 'ACTIVE', external_ref: m.id,
    }));
  }

  // ---- 3. Roles (deduplicated by normalised title) ----------------------
  const roleByTitle = new Map();
  const titleNodes = new Map();
  for (const p of real) {
    const key = normKey(p.title);
    if (!titleNodes.has(key)) titleNodes.set(key, []);
    titleNodes.get(key).push(p);
  }
  const merged = [];
  for (const [key, group] of titleNodes) {
    const id = await ins('hrms_roles', {
      role_code: group[0].id, title: norm(group[0].title), status: 'ACTIVE', effective_from: chartDate,
    });
    roleByTitle.set(key, id);
    if (group.length > 1) merged.push({ title: norm(group[0].title), nodes: group.map((g) => g.id) });
  }
  counts.roles = roleByTitle.size;
  if (merged.length) {
    merged.sort((a, b) => b.nodes.length - a.nodes.length);
    note('Repeated titles collapsed into shared roles',
      `${real.length} chart nodes became ${roleByTitle.size} roles and ${real.length} positions, because ${merged.length} `
      + `titles were used by more than one node. This is the model working as intended — one "kind of work", many seats `
      + `— but it is the single change most worth checking, because a role now carries the combined responsibilities of `
      + `every node that shared its title. The merges, largest first: `
      + merged.map((m) => `"${m.title}" x${m.nodes.length} (${m.nodes.join(', ')})`).join('; ')
      + `. Split any of these where the work genuinely differs by machine or department.`);
  }

  // ---- 4. Positions ----------------------------------------------------
  // A DN position's sanctioned headcount is `req` PER SHIFT. `sanctioned_headcount`
  // keeps meaning one seat; the day/night doubling becomes manpower requirements,
  // which is the table that exists for exactly this. Plan §9.1.
  const posByNode = new Map();
  for (const p of real) {
    const req = Math.max(0, Number(p.req) || 0);
    posByNode.set(p.id, await ins('hrms_positions', {
      position_code: p.id,
      role_id: roleByTitle.get(normKey(p.title)),
      position_title: norm(p.title),
      location_id: locationId,
      sanctioned_headcount: req,
      default_shift_id: p.shift === 'DN' ? null : (shiftByCode.get(p.shift) ?? shiftByCode.get('G')),
      status: 'ACTIVE', effective_from: chartDate,
    }));
  }
  counts.positionsCreated = posByNode.size;

  // ---- 5. Position -> work contexts -------------------------------------
  let ctxLinks = 0, withContext = 0, directlyUnderMachine = 0, viaShared = 0;
  for (const p of real) {
    const ctxs = contextsOf(p);
    const direct = byId.get(p.reportsTo)?.kind === 'machine';
    for (const [i, m] of ctxs.entries()) {
      await ins('hrms_position_work_contexts', {
        position_id: posByNode.get(p.id), work_context_id: ctxByNode.get(m.id),
        is_primary: i === 0 ? 1 : 0, effective_from: chartDate,
        notes: direct
          ? 'From the org chart: this position sat directly under the machine node.'
          : 'From the org chart: inherited through a shared position that sat under this machine.',
      });
      ctxLinks++;
    }
    if (ctxs.length) { withContext++; if (direct) directlyUnderMachine++; else viaShared++; }
  }
  counts.contextLinks = ctxLinks;
  counts.positionsWithContext = withContext;
  note('Machines became work contexts, not managers',
    `${withContext} positions now carry a machine as a work context. Of those, ${directlyUnderMachine} hung directly `
    + `under a machine node in the chart and have been re-pointed to their nearest human ancestor — a machine is never `
    + `a manager. The other ${viaShared} sat under a SHARED position that itself sat under a machine; their manager is `
    + `unchanged (that shared position is a real supervisory job), but they have inherited its machine, which the `
    + `original chart did not record. Check those ${viaShared}: their titles say "shared between 3 machines", so the `
    + `inheritance looks right, but only the client can confirm it.`);

  // ---- 6. Formal reporting ---------------------------------------------
  const PRIMARY = typeByCode.get('PRIMARY_MANAGER');
  const DOTTED = typeByCode.get('DOTTED_LINE');
  let primaryEdges = 0, dottedEdges = 0, roots = 0;
  for (const p of real) {
    const mgr = managerOf(p);
    if (!mgr) { roots++; continue; }
    await ins('hrms_position_reporting_relationships', {
      from_position_id: posByNode.get(p.id), to_position_id: posByNode.get(mgr.id),
      relationship_type_id: PRIMARY, is_primary: 1, scope_type: 'GENERAL',
      effective_from: chartDate,
    });
    primaryEdges++;
  }
  for (const p of real.filter((x) => x.dotted)) {
    const target = byId.get(p.dotted);
    if (!target || !posByNode.has(target.id)) continue;
    await ins('hrms_position_reporting_relationships', {
      from_position_id: posByNode.get(p.id), to_position_id: posByNode.get(target.id),
      relationship_type_id: DOTTED, is_primary: 0, scope_type: 'GENERAL',
      effective_from: chartDate,
      notes: 'Dotted line from the org chart. Scope was not recorded there — confirm whether it is genuinely general.',
    });
    dottedEdges++;
  }
  counts.primaryEdges = primaryEdges;
  counts.dottedEdges = dottedEdges;
  note('Dotted lines need a scope',
    `${dottedEdges} dotted relationships imported with scope GENERAL because the source records no scope. `
    + `Spec v1.1 §13.2 exists precisely so these can say "statutory compliance only" — review each one.`);

  // ---- 7. Manpower requirements for the day/night positions -------------
  let dnRows = 0, sanctioned = 0;
  for (const p of real) {
    const req = Math.max(0, Number(p.req) || 0);
    sanctioned += p.shift === 'DN' ? req * 2 : req;
    if (p.shift !== 'DN' || !req) continue;
    for (const code of ['D', 'N']) {
      await ins('hrms_manpower_requirements', {
        position_id: posByNode.get(p.id), role_id: roleByTitle.get(normKey(p.title)),
        shift_id: shiftByCode.get(code), required_count: req, effective_from: chartDate,
        notes: 'Day/night position: the chart required this many people per shift.',
      });
      dnRows++;
    }
  }
  counts.sanctionedTrue = sanctioned;
  counts.manpowerRows = dnRows;

  // ---- 8. Responsibilities (the `kras[]` arrays) ------------------------
  const respByText = new Map();
  let respAssigned = 0, respReused = 0;
  for (const p of real) {
    const roleId = roleByTitle.get(normKey(p.title));
    for (const [i, raw] of (p.kras || []).entries()) {
      const text = norm(raw);
      if (!text) continue;
      const key = normKey(text);
      let defId = respByText.get(key);
      if (defId) respReused++;
      else {
        defId = await ins('hrms_responsibility_definitions', {
          name: text.length > 240 ? `${text.slice(0, 237)}...` : text,
          description: text, status: 'ACTIVE',
        });
        respByText.set(key, defId);
      }
      // Two chart nodes sharing a title are now one role, so the same
      // responsibility can arrive twice. The unique key would reject it.
      const [dup] = await conn.execute(
        'SELECT id FROM hrms_role_responsibility_assignments WHERE company_id = ? AND role_id = ? AND responsibility_definition_id = ? AND deleted_at IS NULL',
        [companyId, roleId, defId]);
      if (dup.length) continue;
      await ins('hrms_role_responsibility_assignments', {
        role_id: roleId, responsibility_definition_id: defId,
        is_mandatory: 1, sequence: i + 1, effective_from: chartDate,
      });
      respAssigned++;
    }
  }
  counts.responsibilities = respByText.size;
  counts.responsibilityAssignments = respAssigned;
  note('KRAs imported as Responsibilities',
    `${respAssigned} entries from the chart's "kras" arrays are now Responsibilities, not KRAs — they are task `
    + `statements ("Maintenance of the stock of critical spares"), and a KRA is an area of outcome. `
    + `${respReused} were textual duplicates and were reused rather than copied. No KRAs exist yet: they have to be `
    + `written, then these responsibilities grouped under them.`);

  // ---- 9. People --------------------------------------------------------
  const peopleRows = real.flatMap((p) => (p.people || []).map((x) => ({ node: p, person: x })));
  const named = peopleRows.filter((r) => norm(r.person.name));
  const blanks = peopleRows.filter((r) => !norm(r.person.name));
  const seenName = new Map();
  let empCount = 0, asgCount = 0, attCount = 0;

  for (const [i, { node, person }] of named.entries()) {
    const key = normKey(person.name);
    let employeeId = seenName.get(key);
    if (employeeId) {
      note('Same person in two places',
        `"${norm(person.name)}" appears under more than one chart node. Kept as ONE employee with an extra work assignment.`);
    } else {
      employeeId = await ins('hrms_employees', {
        employee_code: `KP${String(i + 1).padStart(4, '0')}`,
        full_name: norm(person.name),
        date_of_joining: chartDate,
        employment_type: 'EMPLOYEE', employment_status: 'ACTIVE',
      });
      seenName.set(key, employeeId);
      empCount++;
    }

    const assignmentId = await ins('hrms_work_assignments', {
      employee_id: employeeId,
      role_id: roleByTitle.get(normKey(node.title)),
      position_id: posByNode.get(node.id),
      location_id: locationId,
      allocation_percent: 100,
      is_primary: seenName.get(key) === employeeId && asgCount === 0 ? 1 : 0,
      default_shift_id: shiftByCode.get(person.shift) ?? shiftByCode.get('G'),
      status: 'ACTIVE', effective_from: chartDate,
      reason: 'Imported from Org_Chart_V12.html',
    });
    asgCount++;

    await ins('hrms_attendance_records', {
      employee_id: employeeId, attendance_date: chartDate,
      shift_id: shiftByCode.get(person.shift) ?? shiftByCode.get('G'),
      status: person.status === 'A' ? 'ABSENT' : 'PRESENT',
      source: 'IMPORT', work_assignment_id: assignmentId,
      notes: 'Point-in-time state from the org chart, not a attendance history.',
    });
    attCount++;
  }
  // One primary assignment per employee — fix up after the fact.
  await conn.execute(
    `UPDATE hrms_work_assignments w JOIN (SELECT employee_id, MIN(id) AS keep FROM hrms_work_assignments
       WHERE company_id = ? AND deleted_at IS NULL GROUP BY employee_id) f
       ON f.employee_id = w.employee_id
     SET w.is_primary = (w.id = f.keep) WHERE w.company_id = ?`, [companyId, companyId]);

  counts.employees = empCount;
  counts.assignments = asgCount;
  counts.attendance = attCount;
  counts.blankSeatsSkipped = blanks.length;
  note('Blank seats are not people',
    `${blanks.length} of the ${peopleRows.length} "people" rows have no name. They are seat markers recording a shift `
    + `and an attendance state for an unfilled seat, so they were NOT imported as employees. The seats they stood for `
    + `survive as sanctioned headcount and as the day/night manpower requirements. `
    + `${blanks.filter((b) => b.person.status === 'A').length} of them carried an "absent" mark, which is discarded — `
    + `an absence needs a person.`);
  note('Attendance is a single day',
    `Attendance was imported for ${attCount} named people on ${chartDate} only, because that is all the chart holds. `
    + `It is a snapshot, not history.`);

  // ---- 10. Open points --------------------------------------------------
  let openCount = 0;
  for (const d of seed.meta?.openPoints || []) {
    if (!norm(d)) continue;
    await ins('hrms_open_points', { entity_type: 'ORGANIZATION', entity_id: null, description: norm(d), status: 'OPEN' });
    openCount++;
  }
  for (const p of real) {
    for (const d of p.open || []) {
      if (!norm(d)) continue;
      await ins('hrms_open_points', {
        entity_type: 'POSITION', entity_id: posByNode.get(p.id), description: norm(d), status: 'OPEN',
      });
      openCount++;
    }
  }
  counts.openPoints = openCount;

  // ---- 11. Record the run ----------------------------------------------
  const idMap = {
    positions: Object.fromEntries(posByNode), workContexts: Object.fromEntries(ctxByNode),
    roles: Object.fromEntries(roleByTitle),
  };
  await ins('hrms_import_runs', {
    source_kind: 'ORG_CHART_HTML', source_file_name: path.basename(SOURCE),
    source_hash: hash, source_size_bytes: size, status: 'committed',
    parsed_counts_json: JSON.stringify(counts), findings_json: JSON.stringify(findings),
    id_map_json: JSON.stringify(idMap), committed_at: new Date(),
    notes: `Imported by scripts/import-org-chart.mjs into company ${COMPANY_SLUG}.`,
  });

  printReport(company, counts);
  await conn.end();
}

function printReport(company, counts) {
  console.log(`\n=== Imported into ${company.name} (id ${company.id}) ===`);
  for (const [k, v] of Object.entries(counts)) console.log(`  ${k.padEnd(26)} ${v}`);
  console.log(`\n=== ${findings.length} findings for review ===`);
  findings.forEach((f, i) => console.log(`\n${i + 1}. ${f.kind}\n   ${f.detail.replace(/\s+/g, ' ')}`));
}

function report(seed, nodes, real, machines, counts, byId, managerOf, contextsOf) {
  console.log('DRY RUN — nothing written.');
  console.log(`nodes ${nodes.length} | positions ${real.length} | machines ${machines.length}`);
  const people = real.flatMap((p) => (p.people || []).map((x) => x));
  console.log(`people rows ${people.length} | named ${people.filter((x) => String(x.name || '').trim()).length}`);
  console.log(`nodes under a machine ${real.filter((p) => contextsOf(p).length).length}`);
  console.log(`roots ${real.filter((p) => !managerOf(p)).length}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
