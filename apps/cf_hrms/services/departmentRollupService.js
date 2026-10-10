/**
 * departmentRollupService.js — "what is this department accountable for?"
 *
 * The read model behind the Departments view on the org-chart screen
 * (CF_HRMS_ORG_CHART_SPEC.md §13). One call, the whole company: every unit in
 * `hrms_departments`, the positions inside each, and the KRAs,
 * responsibilities, KPIs and qualifications those positions carry —
 * de-duplicated WITHIN a unit and never across units, with every line naming
 * the positions that carry it.
 *
 * ── WHY DE-DUPLICATE INSIDE A UNIT AND NOT ACROSS ─────────────────────────
 * Content belongs to a ROLE, and roles are shared: Karni's 130 positions hold
 * 73 roles, and "Operator - Production" sits in 8 units. Inside one unit, three
 * seats holding the same duty are one duty with three carriers — listing it
 * three times would read as three different jobs. Across units, the same duty
 * under Printing and under Slitting is the honest answer to "what is each of
 * them accountable for", so it is listed in both. `positionIds` on every line
 * is what stops a reader assuming one person does it.
 *
 * ── WHICH UNIT A POSITION COUNTS IN ──────────────────────────────────────
 * `hrms_positions.department_id`, read as stored. The importer set it by walking
 * up the chart from the position ITSELF to the nearest unit, so a unit's own
 * head job sits inside the unit it heads, not above it. Walking again here
 * would be a second copy of the importer's rule.
 *
 * Since 2026-10-10 a "unit" is ANY department: a machine and a shared crew are
 * departments in the same tree, so an operator's duties roll up under his
 * machine and the Printing process shows only what its Incharge carries. Each
 * unit carries `type` (the company's label, never logic) and `isShared`. This
 * service no longer reads work contexts at all.
 *
 * ── WHERE THE LINES COME FROM ─────────────────────────────────────────────
 * Content resolution is contentResolver.js (plan §2 rule 6) and nothing else.
 * But `resolveContent` answers for ONE target in about a dozen queries; called
 * per position here that is ~1,600 round trips, roughly 80 seconds against
 * production at 49 ms each (plan §16). So the work splits on the one line rule 6
 * cares about:
 *
 *   - A position with NO overlay rows resolves to exactly its role layer:
 *     SUPPRESS, OVERRIDE and ADD have nothing to act on. Those lines come from
 *     one set-based read over every role at once, using the same
 *     effective-date window as `roleContentService.getRoleContent`
 *     (`ROLE_LAYER_WINDOW`, below).
 *   - A position WITH overlay rows goes through `resolveContent` itself, and
 *     its output is used as it comes back. Overlays are the exception by
 *     design, so this costs about 13 queries per exception. Karni has none.
 *
 * Assignment overlays are deliberately NOT applied. They are one person's
 * exceptions; this view asks what the SEAT is accountable for, the same
 * question a Role JD for a position answers.
 *
 * ── ROUND TRIPS ───────────────────────────────────────────────────────────
 * Five queries for the whole company (six until the work-context read was
 * retired, 2026-10-10), issued together and grouped in JS, plus
 * ~13 for each position that carries a seat-level exception. The payload
 * reports the exact number it used (`queries`), counted at the connection.
 *
 * Reads only. Gated by `cf_hrms_org_view` in routes/orgchart.js — never by
 * `cf_hrms_self_view`, whose holders must not see the whole organisation.
 */
import { dateText, today, LIVE_ON } from './positionService.js';
import { resolveContent, targetText } from './contentResolver.js';

/* ══════════════════════════════════════════════════════════════════════════
 * The reads — each runs ONCE for the whole company
 * ══════════════════════════════════════════════════════════════════════════ */

const UNITS_SQL = `
  SELECT id, code, name, parent_department_id, department_type, is_shared, status
    FROM hrms_departments
   WHERE company_id = ? AND deleted_at IS NULL
   ORDER BY name, code, id`;

/**
 * The same positions the chart draws: CLOSED seats are out, DRAFT and FROZEN
 * stay. If this filter ever differs from orgChartService's POSITIONS_SQL, the
 * two views on one screen will count different positions.
 */
const POSITIONS_SQL = `
  SELECT p.id, p.position_code, p.position_title, p.role_id, p.department_id, p.status,
         r.title AS role_title
    FROM hrms_positions p
    LEFT JOIN hrms_roles r ON r.company_id = p.company_id AND r.id = p.role_id
   WHERE p.company_id = ? AND p.deleted_at IS NULL AND p.status <> 'CLOSED'
     AND ${LIVE_ON('p')}
   ORDER BY p.position_code, p.id`;

/** Primary managers only, in the chart's precedence. Used to find where a unit starts. */
const PRIMARY_EDGES_SQL = `
  SELECT rr.from_position_id, rr.to_position_id
    FROM hrms_position_reporting_relationships rr
    JOIN hrms_reporting_relationship_types t ON t.company_id = rr.company_id AND t.id = rr.relationship_type_id
   WHERE rr.company_id = ? AND rr.deleted_at IS NULL AND t.code = 'PRIMARY_MANAGER'
     AND ${LIVE_ON('rr')}
   ORDER BY rr.is_primary DESC, t.sort_order, rr.id`;

/**
 * Which rows of a role layer are in force on a date. THE TWIN of
 * `effectiveWhere(alias, { scope: 'effective' })` in roleContentService.js —
 * that is the authority, and this must say exactly what it says: a live row
 * inside its window, or a retired row whose window closed before today (so a
 * past date still reads the old row). The definition join is a LEFT JOIN with
 * no status filter, for the same reason it is there: a retired definition is
 * still what the role said on that date.
 *
 * It is a copy only because roleContentService does not export it. If that
 * function changes, this one changes with it — or better, export it and import
 * it here.
 *
 * Consumes 2 `?` (on, on).
 */
const ROLE_LAYER_WINDOW = (a) => `
  (${a}.deleted_at IS NULL OR (${a}.effective_to IS NOT NULL AND ${a}.effective_to < CURDATE()))
  AND (${a}.effective_from IS NULL OR ${a}.effective_from <= ?)
  AND (${a}.effective_to   IS NULL OR ${a}.effective_to   >= ?)`;

/**
 * Every role's content in the four kinds this view shows, in ONE round trip.
 * The columns are padded to one shape; `target_value` is cast to text because a
 * JSON column next to NULLs in a UNION is typed differently by MySQL and TiDB.
 *
 * Parameter order (12): companyId, on, on — four times.
 */
const CONTENT_SQL = `
    SELECT 'KRA' AS kind, 1 AS kind_order, a.id, a.role_id, a.kra_definition_id AS definition_id, a.sequence,
           d.name, d.description, NULL AS class_override, NULL AS def_class, a.is_mandatory,
           NULL AS target_operator, NULL AS target_value, NULL AS measurement_type, NULL AS unit, NULL AS frequency,
           NULL AS requirement_level, NULL AS qualification_type
      FROM hrms_role_kra_assignments a
      LEFT JOIN hrms_kra_definitions d ON d.company_id = a.company_id AND d.id = a.kra_definition_id
     WHERE a.company_id = ? AND ${ROLE_LAYER_WINDOW('a')}
  UNION ALL
    SELECT 'RESPONSIBILITY', 2, a.id, a.role_id, a.responsibility_definition_id, a.sequence,
           d.name, d.description, a.responsibility_class_override, d.responsibility_class, a.is_mandatory,
           NULL, NULL, NULL, NULL, NULL, NULL, NULL
      FROM hrms_role_responsibility_assignments a
      LEFT JOIN hrms_responsibility_definitions d ON d.company_id = a.company_id AND d.id = a.responsibility_definition_id
     WHERE a.company_id = ? AND ${ROLE_LAYER_WINDOW('a')}
  UNION ALL
    SELECT 'KPI', 3, a.id, a.role_id, a.kpi_definition_id, a.sequence,
           d.name, d.description, NULL, NULL, a.is_mandatory,
           a.target_operator, CAST(a.target_value AS CHAR), d.measurement_type, d.unit,
           COALESCE(a.frequency_override, d.default_frequency), NULL, NULL
      FROM hrms_role_kpi_assignments a
      LEFT JOIN hrms_kpi_definitions d ON d.company_id = a.company_id AND d.id = a.kpi_definition_id
     WHERE a.company_id = ? AND ${ROLE_LAYER_WINDOW('a')}
  UNION ALL
    SELECT 'QUALIFICATION', 4, a.id, a.role_id, a.qualification_definition_id, a.sequence,
           d.name, d.description, NULL, NULL, NULL,
           NULL, NULL, NULL, NULL, NULL, a.requirement_level, d.qualification_type
      FROM hrms_role_qualification_requirements a
      LEFT JOIN hrms_qualification_definitions d ON d.company_id = a.company_id AND d.id = a.qualification_definition_id
     WHERE a.company_id = ? AND ${ROLE_LAYER_WINDOW('a')}
  ORDER BY role_id, kind_order, sequence, id`;

/**
 * Positions that carry ANY overlay row, live or not. Deliberately a superset:
 * whether a row is in force on the date is contentResolver's decision, not a
 * second copy of it here. A position whose overlays have all lapsed simply
 * resolves to its role layer.
 */
const OVERLAY_POSITIONS_SQL = `
  SELECT DISTINCT position_id
    FROM hrms_position_content_overrides
   WHERE company_id = ? AND deleted_at IS NULL`;

/* ══════════════════════════════════════════════════════════════════════════
 * Lines — what one row of content says, and when two rows say the same thing
 * ══════════════════════════════════════════════════════════════════════════ */

/** The four kinds, in the order a reader meets them. */
export const ROLLUP_KINDS = ['KRA', 'RESPONSIBILITY', 'KPI', 'QUALIFICATION'];

const titleCase = (s) => (s ? String(s).replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase()) : '');
const clean = (s) => (s == null ? '' : String(s).trim());

function readJson(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return value; }
}

/** A description is worth printing only when it says more than the name. */
function extraDescription(name, description) {
  const d = clean(description);
  return d && d.toLowerCase() !== clean(name).toLowerCase() ? d : null;
}

/**
 * One line, built from structured fields so the set-based rows and the
 * resolver's items produce the same key for the same statement.
 *
 * THE KEY IS WHAT "THE SAME LINE" MEANS. A KPI is the same line only at the
 * same target and frequency: Karni's "Job Changeover Time" is 15 minutes on one
 * role and 60 on another, and merging them would print one target and hide the
 * other. A responsibility is the same line only in the same class (owner and
 * reviewer of one duty are two different accountabilities). Weights are left
 * out entirely: a weight is a share of ONE role's total, and has no meaning
 * summed across the roles in a unit.
 */
function makeLine(kind, f) {
  const definitionId = f.definitionId == null ? null : Number(f.definitionId);
  const name = clean(f.name) || `${titleCase(kind)} ${definitionId ?? ''}`.trim();
  const description = extraDescription(name, f.description);

  if (kind === 'KPI') {
    const target = f.targetText ?? targetText(f.targetOperator ?? null, f.targetValue ?? null, f.measurementType ?? null, f.unit ?? null);
    const frequency = f.frequency ? titleCase(f.frequency) : null;
    return {
      key: `KPI:${definitionId}|${target}|${frequency ?? ''}`,
      kind, definitionId, name, description,
      detail: [target, frequency].filter(Boolean).join(' · ') || null,
    };
  }
  if (kind === 'RESPONSIBILITY') {
    const cls = f.responsibilityClass && f.responsibilityClass !== 'GENERIC' ? f.responsibilityClass : null;
    const optional = f.isMandatory === false || f.isMandatory === 0;
    return {
      key: `RESPONSIBILITY:${definitionId}|${cls ?? ''}|${optional ? 'optional' : ''}`,
      kind, definitionId, name, description,
      detail: [cls ? titleCase(cls) : null, optional ? 'not mandatory' : null].filter(Boolean).join(', ') || null,
    };
  }
  if (kind === 'QUALIFICATION') {
    const level = f.requirementLevel === 'PREFERRED' ? 'Preferred' : 'Required';
    return {
      key: `QUALIFICATION:${definitionId}|${level}`,
      kind, definitionId, name, description,
      detail: [level, f.qualificationType ? titleCase(f.qualificationType) : null].filter(Boolean).join(' · '),
    };
  }
  return { key: `KRA:${definitionId}`, kind: 'KRA', definitionId, name, description, detail: null };
}

function lineFromContentRow(r) {
  return makeLine(r.kind, {
    definitionId: r.definition_id,
    name: r.name,
    description: r.description,
    responsibilityClass: r.class_override ?? r.def_class ?? null,
    isMandatory: r.is_mandatory == null ? null : !!r.is_mandatory,
    targetOperator: r.target_operator,
    targetValue: readJson(r.target_value),
    measurementType: r.measurement_type,
    unit: r.unit,
    frequency: r.frequency,
    requirementLevel: r.requirement_level,
    qualificationType: r.qualification_type,
  });
}

/**
 * A resolved position, flattened. Reads the resolver's output and nothing
 * else: grouping under KRAs does not matter to a rollup, so every
 * responsibility and KPI is taken wherever it sits — under a heading or in
 * `additional`, which is never dropped (rule 2).
 */
function linesFromResolved(content) {
  const out = [];
  const fromItem = (kind, item) => ({
    line: makeLine(kind, item),
    exception: item.origin !== 'ROLE' || !!item.overridden,
  });
  for (const kra of content.kras ?? []) out.push(fromItem('KRA', kra));
  for (const kra of content.kras ?? []) {
    for (const r of kra.responsibilities ?? []) out.push(fromItem('RESPONSIBILITY', r));
  }
  for (const r of content.additional?.responsibilities ?? []) out.push(fromItem('RESPONSIBILITY', r));
  for (const kra of content.kras ?? []) {
    for (const k of kra.kpis ?? []) out.push(fromItem('KPI', k));
  }
  for (const k of content.additional?.kpis ?? []) out.push(fromItem('KPI', k));
  for (const q of content.qualifications ?? []) out.push(fromItem('QUALIFICATION', q));
  return out;
}

/* ══════════════════════════════════════════════════════════════════════════
 * Telling units apart
 * ══════════════════════════════════════════════════════════════════════════
 * The V28 import used to leave 32 units carrying 24 names ("Sales & Marketing"
 * four times, "Slitting" inside "Slitting"). Since 2026-10-10 the importer
 * makes one department per real thing, so Karni has no clash left — but a
 * company can still create two departments of one name by hand, and a list
 * that prints the bare name twice reads as broken.
 *
 * The parent path separates a unit from a namesake ELSEWHERE in the tree, and
 * the screen always shows it. It cannot separate SIBLINGS of one name, nor a
 * unit from a same-named parent, so those get a qualifier. Each unit is a job
 * as well as a unit, and the first fact that actually differs is used:
 *   1. its head's title — "AGM - Sales & Marketing" / "Associate - …";
 *   2. its code, which is unique by constraint.
 * (The machine its head works on used to come first. A machine is a department
 * now, so it is already the unit's own name.)
 */
function qualifyUnits(units, headsOf, positionById) {
  const norm = (s) => clean(s).toLowerCase();
  const candidates = (u) => {
    const heads = headsOf.get(u.id) ?? [];
    const titles = [...new Set(heads.map((id) => positionById.get(id)?.title).filter(Boolean))];
    return {
      head: titles.length ? titles.join(', ') : null,
      code: u.code || `#${u.id}`,
    };
  };

  const byName = new Map();
  for (const u of units) {
    const k = norm(u.name);
    byName.set(k, [...(byName.get(k) ?? []), u]);
  }
  const unitById = new Map(units.map((u) => [u.id, u]));
  const ORDER = ['head', 'code'];

  for (const u of units) {
    u.clash = (byName.get(norm(u.name))?.length ?? 0) > 1;
    u.qualifier = null;
    u.qualifierKind = null;
  }

  // Siblings of one name: the first kind of fact that is present and different for all of them.
  const siblingGroups = new Map();
  for (const u of units) {
    const k = `${u.parentId ?? 'root'}|${norm(u.name)}`;
    siblingGroups.set(k, [...(siblingGroups.get(k) ?? []), u]);
  }
  for (const group of siblingGroups.values()) {
    if (group.length < 2) continue;
    const c = group.map(candidates);
    const kind = ORDER.find((key) => c.every((x) => x[key]) && new Set(c.map((x) => x[key])).size === group.length) ?? 'code';
    group.forEach((u, i) => { u.qualifier = c[i][kind]; u.qualifierKind = kind; });
  }

  // A unit inside one of its own name ("BFL" within "BFL"): the indent says
  // which is which, but not WHY there are two, and the machine does.
  for (const u of units) {
    if (u.qualifier) continue;
    const parent = u.parentId == null ? null : unitById.get(u.parentId);
    if (!parent || norm(parent.name) !== norm(u.name)) continue;
    const c = candidates(u);
    const kind = ORDER.find((key) => c[key]);
    u.qualifier = c[kind];
    u.qualifierKind = kind;
  }
}

/* ══════════════════════════════════════════════════════════════════════════
 * The rollup
 * ══════════════════════════════════════════════════════════════════════════ */

/** Exceptions resolved this many at a time, so a tenant full of them cannot drain the pool. */
const RESOLVE_CONCURRENCY = 4;

/**
 * @param db         pool or connection
 * @param companyId  from the token, never the URL
 * @param opts.on    the date everything is read as of (default today)
 */
export async function buildDepartmentRollup(db, companyId, { on } = {}) {
  const asOf = dateText(on) || today();
  const startedAt = Date.now();

  // Count every round trip, the resolver's included, so the payload can say
  // what it cost. A per-row query is free on localhost and invisible until prod.
  let queries = 0;
  const counted = { query: (...args) => { queries += 1; return db.query(...args); } };

  const [
    [unitRows], [positionRows], [edgeRows], [contentRows], [overlayRows],
  ] = await Promise.all([
    counted.query(UNITS_SQL, [companyId]),
    counted.query(POSITIONS_SQL, [companyId, asOf, asOf]),
    counted.query(PRIMARY_EDGES_SQL, [companyId, asOf, asOf]),
    counted.query(CONTENT_SQL, [companyId, asOf, asOf, companyId, asOf, asOf, companyId, asOf, asOf, companyId, asOf, asOf]),
    counted.query(OVERLAY_POSITIONS_SQL, [companyId]),
  ]);

  /* ── positions ────────────────────────────────────────────────────────── */
  const positions = positionRows.map((p) => ({
    id: p.id,
    code: p.position_code ?? null,
    // The chart's own rule (orgChartService baseTitleOf): `||`, not COALESCE,
    // so an empty title falls through to the role's the same way there.
    title: p.position_title || p.role_title || `Position ${p.id}`,
    roleId: p.role_id ?? null,
    roleTitle: p.role_title ?? null,
    unitId: p.department_id ?? null,
    status: p.status,
  }));
  const positionById = new Map(positions.map((p) => [p.id, p]));

  const primaryManagerOf = new Map();
  for (const e of edgeRows) {
    if (!primaryManagerOf.has(e.from_position_id)) primaryManagerOf.set(e.from_position_id, e.to_position_id);
  }

  /* ── lines: one dictionary, keyed by what the line says ─────────────── */
  const lines = new Map();
  const register = (line) => {
    if (!lines.has(line.key)) lines.set(line.key, line);
    return line.key;
  };

  const writtenByKind = Object.fromEntries(ROLLUP_KINDS.map((k) => [k, new Set()]));
  const roleLines = new Map();   // roleId -> [{ key, exception:false }] in JD order
  for (const r of contentRows) {
    const key = register(lineFromContentRow(r));
    writtenByKind[r.kind]?.add(key);
    const list = roleLines.get(r.role_id) ?? [];
    list.push({ key, exception: false });
    roleLines.set(r.role_id, list);
  }

  /* ── the exceptions, through the one resolver ─────────────────────────── */
  const overlayIds = overlayRows.map((r) => r.position_id).filter((id) => positionById.get(id)?.roleId);
  const resolvedLines = new Map();   // positionId -> [{ key, exception }]
  const suppressedBy = new Map();    // positionId -> [{ kind, definitionId, name, reason }]
  const unresolved = [];
  for (let i = 0; i < overlayIds.length; i += RESOLVE_CONCURRENCY) {
    await Promise.all(overlayIds.slice(i, i + RESOLVE_CONCURRENCY).map(async (positionId) => {
      const p = positionById.get(positionId);
      try {
        const content = await resolveContent(counted, companyId, { roleId: p.roleId, positionId, on: asOf });
        resolvedLines.set(positionId, linesFromResolved(content).map(({ line, exception }) => {
          const key = register(line);
          writtenByKind[line.kind]?.add(key);
          return { key, exception };
        }));
        suppressedBy.set(positionId, (content.suppressed ?? []).map((s) => ({
          kind: s.kind, definitionId: s.definitionId, name: s.name, reason: s.reason ?? null,
        })));
      } catch (err) {
        // One seat the resolver cannot read must not blank the whole view.
        // It is named, and its role layer stands in until it is fixed.
        unresolved.push({ positionId, message: err?.message ?? String(err) });
      }
    }));
  }
  const linesOf = (p) => resolvedLines.get(p.id) ?? roleLines.get(p.roleId) ?? [];

  /* ── units: the tree, guarded against a cycle ─────────────────────────── */
  const units = unitRows.map((u) => ({
    id: u.id,
    code: u.code ?? null,
    name: clean(u.name) || `Unit ${u.id}`,
    parentId: u.parent_department_id ?? null,
    // The company's own label for the level, and whether it serves other
    // departments. Labels are for people; nothing here branches on the text.
    type: u.department_type ?? null,
    isShared: Boolean(u.is_shared),
    status: u.status,
  }));
  const unitById = new Map(units.map((u) => [u.id, u]));
  for (const u of units) {
    // A parent that is missing, or a loop, is cut: the unit becomes a root
    // rather than vanishing or hanging the walk.
    const seen = new Set([u.id]);
    let c = u.parentId == null ? null : unitById.get(u.parentId);
    if (u.parentId != null && !c) u.parentId = null;
    while (c) {
      if (seen.has(c.id)) { u.parentId = null; break; }
      seen.add(c.id);
      c = c.parentId == null ? null : unitById.get(c.parentId);
    }
  }
  const childrenOf = new Map();
  for (const u of units) {
    if (u.parentId == null) continue;
    childrenOf.set(u.parentId, [...(childrenOf.get(u.parentId) ?? []), u.id]);
  }

  const positionsByUnit = new Map();
  const unplaced = [];
  for (const p of positions) {
    if (p.unitId != null && unitById.has(p.unitId)) {
      positionsByUnit.set(p.unitId, [...(positionsByUnit.get(p.unitId) ?? []), p.id]);
    } else {
      unplaced.push(p.id);
    }
  }

  // Where a unit starts: its positions whose primary manager is outside it.
  // For an imported unit that is the seat the unit was declared on.
  const headsOf = new Map();
  for (const u of units) {
    const ids = positionsByUnit.get(u.id) ?? [];
    headsOf.set(u.id, ids.filter((id) => {
      const m = primaryManagerOf.get(id);
      return m == null || positionById.get(m)?.unitId !== u.id;
    }));
  }

  qualifyUnits(units, headsOf, positionById);

  /* ── per unit: its own positions' lines, de-duplicated ────────────────── */
  const byCode = (a, b) => String(positionById.get(a)?.code ?? '').localeCompare(String(positionById.get(b)?.code ?? ''), undefined, { numeric: true }) || a - b;
  const rollUp = (positionIds, heads) => {
    // Heads first: a unit's own job usually carries most of its content, and
    // reading its duties first reads the unit the way the client's chart does.
    const headSet = new Set(heads);
    const ordered = [...positionIds].sort((a, b) => (headSet.has(b) - headSet.has(a)) || byCode(a, b));
    const byKey = new Map();
    for (const id of ordered) {
      for (const { key, exception } of linesOf(positionById.get(id))) {
        const entry = byKey.get(key) ?? { key, positionIds: [] };
        if (!entry.positionIds.includes(id)) entry.positionIds.push(id);
        if (exception) entry.exceptionPositionIds = [...(entry.exceptionPositionIds ?? []), id];
        byKey.set(key, entry);
      }
    }
    const suppressed = new Map();
    for (const id of ordered) {
      for (const s of suppressedBy.get(id) ?? []) {
        const k = `${s.kind}:${s.definitionId}`;
        const entry = suppressed.get(k) ?? { kind: s.kind, definitionId: s.definitionId, name: s.name, positionIds: [], reasons: [] };
        entry.positionIds.push(id);
        if (s.reason && !entry.reasons.includes(s.reason)) entry.reasons.push(s.reason);
        suppressed.set(k, entry);
      }
    }
    return { positionIds: ordered, lines: [...byKey.values()], suppressed: [...suppressed.values()] };
  };

  // Depth-first, siblings by name then qualifier, so namesakes sit together.
  const siblingOrder = (a, b) => a.name.localeCompare(b.name) || String(a.qualifier ?? a.code ?? '').localeCompare(String(b.qualifier ?? b.code ?? ''), undefined, { numeric: true }) || a.id - b.id;
  const ordered = [];
  const walk = (u, depth, path) => {
    const childIds = (childrenOf.get(u.id) ?? []).map((id) => unitById.get(id)).sort(siblingOrder).map((c) => c.id);
    ordered.push({
      id: u.id,
      code: u.code,
      name: u.name,
      parentId: u.parentId,
      type: u.type,
      isShared: u.isShared,
      status: u.status,
      depth,
      // Root first, parent last. The screen prints it above the name.
      path,
      clash: u.clash,
      qualifier: u.qualifier,
      qualifierKind: u.qualifierKind,
      childIds,
      headPositionIds: [...(headsOf.get(u.id) ?? [])].sort(byCode),
      ...rollUp(positionsByUnit.get(u.id) ?? [], headsOf.get(u.id) ?? []),
    });
    const next = [...path, { id: u.id, name: u.name, code: u.code, qualifier: u.qualifier }];
    for (const childId of childIds) walk(unitById.get(childId), depth + 1, next);
  };
  for (const root of units.filter((u) => u.parentId == null).sort(siblingOrder)) walk(root, 0, []);

  // Positions that sit in no unit get one of their own, at the end, so they
  // are counted rather than silently missing. Karni has none.
  if (unplaced.length) {
    ordered.push({
      id: 0,
      code: null,
      name: 'Not in any department',
      parentId: null,
      status: 'ACTIVE',
      depth: 0,
      path: [],
      clash: false,
      qualifier: null,
      qualifierKind: null,
      childIds: [],
      headPositionIds: [],
      synthetic: true,
      ...rollUp(unplaced, []),
    });
  }

  /* ── who shares what: a role used in several units ────────────────────── */
  const roles = {};
  for (const p of positions) {
    if (p.roleId == null) continue;
    const r = roles[p.roleId] ?? { id: p.roleId, title: p.roleTitle ?? `Role ${p.roleId}`, unitIds: [], positionIds: [] };
    const unitKey = p.unitId != null && unitById.has(p.unitId) ? p.unitId : 0;
    if (!r.unitIds.includes(unitKey)) r.unitIds.push(unitKey);
    r.positionIds.push(p.id);
    roles[p.roleId] = r;
  }

  /* ── totals: "nobody has written any" is not "this unit has none" ────── */
  const carried = Object.fromEntries(ROLLUP_KINDS.map((k) => [k, new Set()]));
  for (const p of positions) {
    for (const { key } of linesOf(p)) carried[lines.get(key).kind]?.add(key);
  }
  const totals = Object.fromEntries(ROLLUP_KINDS.map((k) => [k, {
    // Distinct lines held by at least one current position.
    carried: carried[k].size,
    // Distinct lines written on any role at all, held or not.
    written: writtenByKind[k].size,
  }]));

  // On the wire a line is sent ONCE and units point at it by index. Sending the
  // key with every unit's copy more than doubled the payload (392 KB → see
  // `bytes` in the build notes), and nothing outside this file needs the key.
  const compact = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined));
  const lineList = [];
  const indexOf = new Map();
  for (const [key, line] of lines) {
    if (!carried[line.kind]?.has(key)) continue;
    indexOf.set(key, lineList.length);
    lineList.push(compact({
      kind: line.kind, definitionId: line.definitionId, name: line.name, detail: line.detail, description: line.description,
    }));
  }
  for (const u of ordered) {
    u.lines = u.lines.map((e) => compact({
      line: indexOf.get(e.key), positionIds: e.positionIds, exceptionPositionIds: e.exceptionPositionIds,
    }));
  }

  return {
    asOf,
    units: ordered,
    /** Every distinct line any current position carries. `units[].lines[].line` is an index into this. */
    lines: lineList,
    positions: Object.fromEntries(positions.map((p) => [p.id, {
      id: p.id, code: p.code, title: p.title, roleId: p.roleId, roleTitle: p.roleTitle, unitId: p.unitId ?? 0, status: p.status,
    }])),
    roles,
    totals,
    exceptions: {
      // Positions read through contentResolver because they carry overlay rows.
      positions: resolvedLines.size,
      unresolved,
    },
    counts: {
      units: units.length,
      positions: positions.length,
      unplacedPositions: unplaced.length,
      distinctUnitNames: new Set(units.map((u) => u.name.toLowerCase())).size,
    },
    queries,
    generatedInMs: Date.now() - startedAt,
  };
}

export default { buildDepartmentRollup, ROLLUP_KINDS };
