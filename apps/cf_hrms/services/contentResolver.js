/**
 * contentResolver.js — THE one implementation of plan §2 rule 6.
 *
 *     Role content  →  Position overlay  →  Assignment overlay
 *     each layer applying   SUPPRESS, then OVERRIDE, then ADD
 *
 * Nothing else in this app resolves content. `seatCount.js` and
 * `reportingResolver.js` both exist because a rule that was written twice
 * drifted and then disagreed with itself in production — the org chart said 156
 * vacant seats while the Positions screen said 101, adjacent on the same page.
 * This is the third file of that kind, and the cheapest way to earn a fourth is
 * to re-derive "what does this position actually do" somewhere else.
 *
 * ── WHY THREE LAYERS AT ALL ───────────────────────────────────────────────
 * A Role carries content that is reusable: "BFL Incharge" says the same thing
 * wherever a BFL Incharge sits. A Position is that role AT A PLACE, and a place
 * has exceptions — the Unit 2 BFL Incharge also signs off dispatch, and does not
 * do the weighbridge. A Work Assignment is one PERSON's version of that, and it
 * has exceptions too, used sparingly. Writing the exception as an overlay rather
 * than as a copy of the role is the whole reason the model is shaped this way:
 * change the role and every position that never contradicted it changes with it.
 *
 * ── THE FOUR RULES THAT ARE EASY TO GET WRONG ─────────────────────────────
 *
 * 1. ORDER IS SUPPRESS, THEN OVERRIDE, THEN ADD — within each layer. Not in
 *    row-id order. A layer that suppresses X and adds X means "not the role's X,
 *    mine"; in id order that reads as "add X, then remove it", and the position
 *    silently loses a duty it explicitly claimed.
 *
 * 2. AN UNGROUPED RESPONSIBILITY OR KPI GOES UNDER `additional`, NEVER INTO
 *    THE VOID. Karni has 420 responsibility assignments and 0 KRAs: if the
 *    renderer only walked the KRA tree, every JD in the company would be blank.
 *    That is the known failure mode, and it is why grouping is resolved LAST,
 *    from a flat list, rather than by mutating a nested structure.
 *
 * 3. EVERY ROW SAYS WHERE IT CAME FROM. `origin` is the layer that INTRODUCED
 *    the row; `overridden` says a later layer changed it. They are two different
 *    facts and a JD reader needs both — "this duty is specific to this seat" is
 *    not the same statement as "this seat does the role's duty differently".
 *
 * 4. `suppressed` IS RETURNED, NOT SILENTLY ABSENT. "The role says this and this
 *    position does not do it" is information an HR person needs on the page. A
 *    resolver that merely omits the row makes the exception invisible, and the
 *    next person re-adds it.
 *
 * ── WHAT A SUPPRESSED KRA DOES TO ITS CHILDREN ────────────────────────────
 * Nothing. Suppressing the outcome AREA removes the heading, not the duties
 * underneath it: those move to `additional` carrying a note saying why they are
 * no longer under a heading. Dropping them would violate rule 2 for the sake of
 * tidiness, and a duty nobody can see is a duty nobody does. Suppress the
 * children too if they genuinely do not apply — that reads as a decision.
 *
 * ── WHAT THIS FILE DOES NOT DO ────────────────────────────────────────────
 * It does not validate override input: `readContentOverride` in positionService
 * is the write-side authority for "exactly one definition FK, agreeing with
 * content_type", and both override routes already go through it. On READ a row
 * is taken as stored, and one that is malformed anyway (written before that
 * validator existed, or by hand) is reported in `ignored[]` rather than crashing
 * a JD — a document generator that 500s because of one bad row is worse than one
 * that renders and says which row it could not use.
 *
 * It also does not overlay skills, qualifications, experience, authorities,
 * relationship expectations or working conditions: the override tables cover
 * KRA / RESPONSIBILITY / KPI only (models/init.sql), so those six come straight
 * from the role layer, every row tagged `origin: 'ROLE'`, and they say so.
 */
import { notFound } from '../lib/errors.js';
import { getRoleContent } from './roleContentService.js';
import {
  dateText, today, blank, CONTENT_TYPES,
  listPositionOverrides,
} from './positionService.js';
import { listAssignmentOverrides } from './assignmentService.js';

/** The layers, in the order they apply. Exported so a caller can label a UI. */
export const LAYERS = ['ROLE', 'POSITION', 'ASSIGNMENT'];

/** Within a layer. SUPPRESS first — see rule 1 in the header. */
export const ACTION_ORDER = ['SUPPRESS', 'OVERRIDE', 'ADD'];

/** A content kind as the override tables spell it, from the plural roleContentService uses. */
const KIND_OF = { kras: 'KRA', responsibilities: 'RESPONSIBILITY', kpis: 'KPI' };

/**
 * The wire-field name each content type's definition id arrives under on a
 * shaped override row (positionService.shapeOverride). This is a field-name map,
 * not a second copy of the "exactly one FK" rule — that rule lives in
 * `readContentOverride` and is enforced when the row is written.
 */
const DEF_FIELD = {
  KRA: 'kraDefinitionId',
  RESPONSIBILITY: 'responsibilityDefinitionId',
  KPI: 'kpiDefinitionId',
};

/** The master each ADD row has to read a name and a description out of. */
const DEF_TABLE = {
  KRA: 'hrms_kra_definitions',
  RESPONSIBILITY: 'hrms_responsibility_definitions',
  KPI: 'hrms_kpi_definitions',
};

/**
 * What an OVERRIDE / ADD row's `override_json` may actually change, per kind.
 *
 * NAME AND CODE ARE DELIBERATELY NOT HERE. A definition is created once in a
 * master and assigned to a context ("define once, assign to a context"); a
 * position that renames it creates a shadow definition nobody else can find or
 * report on. What the exception IS goes in the override row's `reason`, which
 * this resolver carries through to the document. A json key that is not on this
 * list is reported in `ignored[]` rather than applied silently.
 */
const OVERRIDABLE = {
  KRA: ['weightPercent', 'isMandatory', 'sequence', 'notes', 'description'],
  RESPONSIBILITY: ['responsibilityClass', 'isMandatory', 'sequence', 'notes', 'description'],
  KPI: ['targetOperator', 'targetValue', 'weightPercent', 'frequency', 'isMandatory', 'sequence', 'notes', 'description'],
};

/**
 * Where an ADD lands when its override_json gives no sequence: after everything
 * the role already said, in the order the overlay rows were written. A default
 * of 0 would push every position-specific duty to the top of the JD.
 */
const ADDED_SEQUENCE_BASE = 10000;

const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

/** A live-on-a-date filter for an overlay row, in JS. The SQL twin is positionService.LIVE_ON. */
const liveOn = (row, on) =>
  (!row.effectiveFrom || row.effectiveFrom <= on) && (!row.effectiveTo || row.effectiveTo >= on);

/* ══════════════════════════════════════════════════════════════════════════
 * Display text. The resolver owns MEANING, the renderers own LAYOUT.
 * ══════════════════════════════════════════════════════════════════════════
 * Every sentence a document prints about a KPI target, an authority limit or an
 * experience requirement is built here and frozen into the snapshot. Two
 * renderers (DOCX and PDF) times two documents is four places for a target to
 * be formatted four ways; a string in the snapshot is formatted once and is
 * still the same string when the document is re-read in a year.
 */

const NUMBER_FORMAT = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 });
const numText = (n) => (Number.isFinite(Number(n)) ? NUMBER_FORMAT.format(Number(n)) : String(n));

/** "at least 95%" / "between 2 and 4 hours" / "Tracked, no target set". */
export function targetText(operator, value, measurementType, unit) {
  const suffix = unit ? ` ${unit}` : (measurementType === 'PERCENTAGE' ? '%' : '');
  if (!operator || operator === 'INFO') return 'Tracked, no target set';
  if (operator === 'BETWEEN') {
    const min = value?.min ?? value?.[0];
    const max = value?.max ?? value?.[1];
    if (min == null || max == null) return 'Range target not set';
    return `between ${numText(min)} and ${numText(max)}${suffix}`;
  }
  if (value === null || value === undefined || value === '') return 'Target not set';
  if (measurementType === 'BOOLEAN') return value === true || value === 'true' ? 'Yes' : 'No';
  if (measurementType === 'TEXT') return String(value);
  const word = { GTE: 'at least', LTE: 'at most', EQ: 'exactly' }[operator] ?? operator;
  return `${word} ${numText(value)}${suffix}`;
}

/** "up to ₹50,000 for plant consumables, with the CFO informed". */
function limitText(limit) {
  if (!limit || typeof limit !== 'object') return null;
  const parts = [];
  if (limit.amount != null) parts.push(`up to ${limit.currency ? `${limit.currency} ` : ''}${numText(limit.amount)}`);
  if (limit.scope) parts.push(`for ${limit.scope}`);
  if (limit.condition) parts.push(limit.condition);
  return parts.length ? parts.join(', ') : null;
}

/* ── the one-line rendering of a row ───────────────────────────────────────
 * `text` on every row is THE sentence: the screen prints it, the DOCX prints it
 * and the PDF prints it. It is built here, once, for the same reason `targetText`
 * is: two renderings of one row eventually disagree, and the one that is wrong
 * will be the one somebody printed and signed.
 *
 * NOTHING OUTSIDE CP1252 IN THESE STRINGS. pdfkit's built-in Helvetica is
 * WinAnsi-encoded; an em dash and a middle dot are in it, an arrow is not, and a
 * missing glyph does not fail — it silently prints the wrong character.
 */

const ORIGIN_WORD = {
  ROLE: null,                                 // the default; saying it on every line is noise
  POSITION: 'specific to this position',
  ASSIGNMENT: 'specific to this assignment',
};

/**
 * The bracketed tail: which layer introduced the row, and whether a later one
 * changed it. This is the answer to "is this part of the role everywhere, or just
 * here" — the reason every row carries an origin at all (plan §17.1).
 */
export function originTail(item) {
  const bits = [];
  if (ORIGIN_WORD[item.origin]) bits.push(ORIGIN_WORD[item.origin]);
  if (item.overridden) {
    const layers = [...new Set((item.changes ?? []).map((c) => String(c.byLayer).toLowerCase()))];
    bits.push(`adjusted by the ${layers.join(' and ') || 'position'}`);
  }
  return bits.length ? ` (${bits.join('; ')})` : '';
}

const titleCase = (s) => (s ? String(s).replace(/_/g, ' ').toLowerCase().replace(/^./, (ch) => ch.toUpperCase()) : '');

/** One KRA / responsibility / KPI as the single line every renderer prints. */
export function itemText(item) {
  if (item.kind === 'KPI') {
    const meta = [item.targetText];
    if (item.frequency) meta.push(titleCase(item.frequency));
    if (item.weightPercent != null) meta.push(`weight ${item.weightPercent}%`);
    if (item.unit) meta.push(item.unit);
    return `${item.name} — ${meta.filter(Boolean).join(' · ')}${originTail(item)}`;
  }
  if (item.kind === 'KRA') {
    const head = item.weightPercent != null ? `${item.name} — ${item.weightPercent}%` : item.name;
    return `${head}${originTail(item)}`;
  }
  const meta = [];
  if (item.responsibilityClass && item.responsibilityClass !== 'GENERIC') meta.push(titleCase(item.responsibilityClass));
  if (item.isMandatory === false) meta.push('not mandatory');
  return `${item.name}${meta.length ? ` — ${meta.join(', ')}` : ''}${originTail(item)}`;
}

/** "5 years minimum, 8 preferred — sheet metal fabrication". */
function experienceText(row) {
  const parts = [];
  if (row.minYears != null) parts.push(`${numText(row.minYears)} year${Number(row.minYears) === 1 ? '' : 's'} minimum`);
  if (row.preferredYears != null) parts.push(`${numText(row.preferredYears)} preferred`);
  const years = parts.join(', ');
  if (years && row.experienceArea) return `${years} — ${row.experienceArea}`;
  return years || row.experienceArea || 'Not stated';
}

/* ══════════════════════════════════════════════════════════════════════════
 * Items
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * One resolved KRA / responsibility / KPI, flattened for a renderer.
 *
 * `name`, `code` and `description` are lifted out of `definition` on purpose:
 * a document prints them on every line, and a renderer reaching two levels down
 * for a heading is a renderer that will one day print "undefined". The full
 * `definition` stays for a screen that wants the detail.
 */
function itemFromRoleRow(kindKey, row, parentKraDefinitionId) {
  const kind = KIND_OF[kindKey];
  const def = row.definition ?? {};
  const item = {
    key: `${kind}:${row.definitionId}`,
    kind,
    definitionId: row.definitionId,
    code: def.code ?? null,
    name: def.name ?? `${kind} ${row.definitionId}`,
    description: def.description ?? null,

    // Where it came from, and whether a later layer changed it. Two facts.
    origin: 'ROLE',
    overridden: false,
    changes: [],
    reason: null,

    sequence: Number(row.sequence ?? 0),
    effectiveFrom: row.effectiveFrom ?? null,
    effectiveTo: row.effectiveTo ?? null,
    notes: row.notes ?? null,
    isMandatory: row.isMandatory ?? null,
    parentKraDefinitionId: parentKraDefinitionId ?? null,

    // For an auditor reading the snapshot in two years: which row said this.
    sourceTable: `hrms_role_${kindKey === 'kras' ? 'kra' : kindKey === 'kpis' ? 'kpi' : 'responsibility'}_assignments`,
    sourceRowId: row.id,
  };

  if (kind === 'KRA' || kind === 'KPI') item.weightPercent = num(row.weightPercent);
  if (kind === 'RESPONSIBILITY') item.responsibilityClass = row.responsibilityClass ?? null;
  if (kind === 'KPI') {
    Object.assign(item, {
      targetOperator: row.targetOperator ?? null,
      targetValue: row.targetValue ?? null,
      frequency: row.frequency ?? null,
      measurementType: def.measurementType ?? null,
      unit: def.unit ?? null,
      direction: def.direction ?? null,
      formulaText: def.formulaText ?? null,
      dataSource: def.dataSource ?? null,
    });
    item.targetText = targetText(item.targetOperator, item.targetValue, item.measurementType, item.unit);
  }
  return item;
}

/** An item an overlay ADDED. Same shape, so a renderer cannot tell them apart by accident. */
function itemFromAdd(kind, override, definition, layer, fallbackSequence) {
  const item = {
    key: `${kind}:${override[DEF_FIELD[kind]]}`,
    kind,
    definitionId: override[DEF_FIELD[kind]],
    code: definition?.code ?? null,
    name: definition?.name ?? override.definitionName ?? `${kind} ${override[DEF_FIELD[kind]]}`,
    description: definition?.description ?? null,

    origin: layer,
    overridden: false,
    changes: [],
    reason: override.reason ?? null,

    sequence: fallbackSequence,
    effectiveFrom: override.effectiveFrom ?? null,
    effectiveTo: override.effectiveTo ?? null,
    notes: null,
    isMandatory: true,
    parentKraDefinitionId: override.parentKraDefinitionId ?? null,

    sourceTable: layer === 'POSITION' ? 'hrms_position_content_overrides' : 'hrms_work_assignment_content_overrides',
    sourceRowId: override.id,
  };

  if (kind === 'KRA' || kind === 'KPI') item.weightPercent = null;
  if (kind === 'RESPONSIBILITY') item.responsibilityClass = definition?.responsibility_class ?? null;
  if (kind === 'KPI') {
    Object.assign(item, {
      targetOperator: null,
      targetValue: null,
      frequency: definition?.default_frequency ?? null,
      measurementType: definition?.measurement_type ?? null,
      unit: definition?.unit ?? null,
      direction: definition?.direction ?? null,
      formulaText: definition?.formula_text ?? null,
      dataSource: definition?.data_source ?? null,
    });
  }

  // An ADD carries its own context in the same json an OVERRIDE uses, so the
  // two paths cannot disagree about what a weight or a target means.
  applyOverrideJson(item, override, layer, { record: false });
  if (kind === 'KPI') {
    item.targetText = targetText(item.targetOperator, item.targetValue, item.measurementType, item.unit);
  }
  return item;
}

/**
 * Applies one override row's json to an item, recording every change.
 *
 * `changes` is what makes an overlay legible: "Weight 10% → 15% (position)".
 * Without it the JD shows a number and no one can tell whether the role says it
 * or the seat does.
 */
function applyOverrideJson(item, override, layer, { record = true } = {}) {
  const json = override.overrideJson;
  const ignoredKeys = [];
  if (!json || typeof json !== 'object') return { ignoredKeys };

  const allowed = OVERRIDABLE[item.kind] ?? [];
  for (const [field, value] of Object.entries(json)) {
    if (!allowed.includes(field)) { ignoredKeys.push(field); continue; }
    const from = item[field] ?? null;
    const to = field === 'sequence' || field === 'weightPercent' ? num(value) : value;
    if (field === 'sequence' && to === null) continue;
    item[field] = to;
    if (record) {
      item.overridden = true;
      item.changes.push({ field, from, to, byLayer: layer, byOverrideId: override.id, reason: override.reason ?? null });
    }
  }
  if (record && override.reason && !item.reason) item.reason = override.reason;
  if (item.kind === 'KPI') {
    item.targetText = targetText(item.targetOperator, item.targetValue, item.measurementType, item.unit);
  }
  return { ignoredKeys };
}

/* ══════════════════════════════════════════════════════════════════════════
 * The six kinds with no overlay table
 * ══════════════════════════════════════════════════════════════════════════
 * Role layer only. Each row gets the same pair every other row has:
 *   `detail` — the qualifier phrase on its own ("Required · Advanced"), for a
 *              screen that puts the name in one column and the rest in another;
 *   `text`   — the whole line, which is what the DOCX, the PDF and the screen
 *              all print. One sentence, three consumers, no drift.
 */
function withText(row) {
  return { ...row, text: row.detail ? `${row.name} — ${row.detail}` : row.name };
}

function plainRows(kindKey, rows) {
  return rows.map((r) => withText(plainRow(kindKey, r)));
}

function plainRow(kindKey, r) {
  {
    const def = r.definition ?? {};
    const base = {
      kind: kindKey.toUpperCase(),
      origin: 'ROLE',
      definitionId: r.definitionId ?? null,
      sequence: Number(r.sequence ?? 0),
      effectiveFrom: r.effectiveFrom ?? null,
      effectiveTo: r.effectiveTo ?? null,
      notes: r.notes ?? null,
      sourceRowId: r.id,
    };
    switch (kindKey) {
      case 'skills':
        return {
          ...base,
          name: def.name ?? 'Skill',
          skillType: def.skillType ?? null,
          requirementLevel: r.requirementLevel ?? null,
          proficiencyLevel: r.proficiencyLevel ?? null,
          description: def.description ?? null,
          detail: [r.requirementLevel === 'PREFERRED' ? 'Preferred' : 'Required', r.proficiencyLevel, def.skillType]
            .filter(Boolean).join(' · '),
        };
      case 'qualifications':
        return {
          ...base,
          name: def.name ?? 'Qualification',
          qualificationType: def.qualificationType ?? null,
          requirementLevel: r.requirementLevel ?? null,
          description: def.description ?? null,
          detail: [r.requirementLevel === 'PREFERRED' ? 'Preferred' : 'Required', def.qualificationType]
            .filter(Boolean).join(' · '),
        };
      case 'experience':
        return {
          ...base,
          name: r.experienceArea || 'Experience',
          minYears: num(r.minYears),
          preferredYears: num(r.preferredYears),
          experienceArea: r.experienceArea ?? null,
          requirementLevel: r.requirementLevel ?? null,
          detail: experienceText(r),
        };
      case 'authorities':
        return {
          ...base,
          name: def.name ?? 'Authority',
          authorityType: def.authorityType ?? null,
          limitJson: r.limitJson ?? null,
          description: def.description ?? null,
          detail: [def.authorityType, limitText(r.limitJson)].filter(Boolean).join(' — '),
        };
      case 'relationships':
        // JD-facing only (plan §2 rule 9). These are people and bodies the role
        // coordinates WITH. None of them is a manager, and the renderers say so
        // out loud next to the heading.
        return {
          ...base,
          name: r.counterparty ?? 'Counterparty',
          relationshipScope: r.relationshipScope ?? null,
          purpose: r.purpose ?? null,
          detail: [r.relationshipScope === 'EXTERNAL' ? 'External' : 'Internal', r.purpose].filter(Boolean).join(' — '),
        };
      case 'conditions':
        return {
          ...base,
          name: r.conditionType ?? 'Condition',
          conditionType: r.conditionType ?? null,
          description: r.description ?? null,
          isMandatory: r.isMandatory ?? null,
          detail: r.description ?? '',
        };
      default:
        return { ...base, name: def.name ?? '', detail: '' };
    }
  }
}

/* ══════════════════════════════════════════════════════════════════════════
 * resolveContent — the one entry point
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * @param db          pool or a transaction connection
 * @param companyId   from the token, never the URL
 * @param opts.roleId            required unless positionId or workAssignmentId names one
 * @param opts.positionId        apply the position overlay
 * @param opts.workAssignmentId  apply the position AND assignment overlays
 * @param opts.on                the date everything is resolved for (default today)
 */
export async function resolveContent(db, companyId, opts = {}) {
  const on = dateText(opts.on) || today();

  // ── what are we resolving? ───────────────────────────────────────────────
  // A work assignment names its own role and (optionally) its position, so a
  // caller that has one needs to pass nothing else. An explicit positionId is
  // honoured when it is also given, because a JD "for this position" is a real
  // request even when a person sits in it.
  let roleId = blank(opts.roleId) ? null : Number(opts.roleId);
  let positionId = blank(opts.positionId) ? null : Number(opts.positionId);
  const workAssignmentId = blank(opts.workAssignmentId) ? null : Number(opts.workAssignmentId);
  let assignment = null;

  if (workAssignmentId) {
    const [[a]] = await db.query(
      `SELECT wa.id, wa.employee_id, wa.role_id, wa.position_id, wa.assignment_title,
              wa.allocation_percent, wa.is_primary, wa.status, wa.effective_from, wa.effective_to,
              e.full_name, e.employee_code
         FROM hrms_work_assignments wa
         LEFT JOIN hrms_employees e ON e.company_id = wa.company_id AND e.id = wa.employee_id
        WHERE wa.company_id = ? AND wa.id = ? AND wa.deleted_at IS NULL`,
      [companyId, workAssignmentId],
    );
    if (!a) throw notFound('Work assignment');
    assignment = a;
    roleId = roleId ?? a.role_id;
    positionId = positionId ?? a.position_id;
  }

  if (!roleId && positionId) {
    const [[p]] = await db.query(
      'SELECT role_id FROM hrms_positions WHERE company_id = ? AND id = ? AND deleted_at IS NULL',
      [companyId, positionId],
    );
    if (!p) throw notFound('Position');
    roleId = p.role_id;
  }
  if (!roleId) throw notFound('Role');

  // ── layer 1: the role. Read once, not re-derived. ────────────────────────
  const roleLayer = await getRoleContent(db, companyId, roleId, { on, scope: 'effective' });

  // Flat lists with a parent pointer, not a nested structure. Grouping is
  // rebuilt at the very end — which is what makes a suppressed KRA's children
  // fall into `additional` instead of disappearing with their heading.
  const kras = [];
  const responsibilities = [];
  const kpis = [];
  for (const kra of roleLayer.kras) {
    kras.push(itemFromRoleRow('kras', kra, null));
    for (const r of kra.responsibilities) responsibilities.push(itemFromRoleRow('responsibilities', r, kra.definitionId));
    for (const k of kra.kpis) kpis.push(itemFromRoleRow('kpis', k, kra.definitionId));
  }
  for (const r of roleLayer.additional.responsibilities) responsibilities.push(itemFromRoleRow('responsibilities', r, null));
  for (const k of roleLayer.additional.kpis) kpis.push(itemFromRoleRow('kpis', k, null));

  const bucket = { KRA: kras, RESPONSIBILITY: responsibilities, KPI: kpis };
  const find = (kind, definitionId) =>
    bucket[kind].findIndex((i) => Number(i.definitionId) === Number(definitionId));

  // ── layers 2 and 3: the overlays ─────────────────────────────────────────
  const layers = ['ROLE'];
  const suppressed = [];
  const ignored = [];
  const overlayRows = { position: [], assignment: [] };
  let addedCount = 0;

  const overlaySets = [];
  if (positionId) {
    const { items } = await listPositionOverrides(db, companyId, positionId);
    overlayRows.position = items;
    overlaySets.push({ layer: 'POSITION', rows: items.filter((o) => liveOn(o, on)) });
    layers.push('POSITION');
  }
  if (workAssignmentId) {
    const { items } = await listAssignmentOverrides(db, companyId, workAssignmentId);
    overlayRows.assignment = items;
    overlaySets.push({ layer: 'ASSIGNMENT', rows: items.filter((o) => liveOn(o, on)) });
    layers.push('ASSIGNMENT');
  }

  // Every definition an ADD names, fetched once per master rather than once per
  // row. A per-row lookup is free locally and ruinous over the prod link.
  const definitions = await loadDefinitions(db, companyId, overlaySets);

  for (const { layer, rows } of overlaySets) {
    // THE ORDER. Not row-id order — see rule 1 in the header.
    for (const action of ACTION_ORDER) {
      for (const o of rows.filter((r) => r.action === action)) {
        const kind = o.contentType;
        if (!CONTENT_TYPES.includes(kind) || o[DEF_FIELD[kind]] == null) {
          // Malformed as stored. The write path cannot produce this any more
          // (positionService.readContentOverride); a row that predates it, or
          // one written by hand, is named rather than allowed to throw.
          ignored.push({
            layer, overrideId: o.id, action: o.action, contentType: o.contentType,
            why: 'The override names no definition of its own content type, so there is nothing to apply.',
          });
          continue;
        }
        const definitionId = o[DEF_FIELD[kind]];
        const at = find(kind, definitionId);

        if (action === 'SUPPRESS') {
          if (at < 0) {
            ignored.push({
              layer, overrideId: o.id, action, contentType: kind, definitionId,
              name: o.definitionName ?? null,
              why: 'Nothing to suppress — the role does not carry this on this date.',
            });
            continue;
          }
          const [gone] = bucket[kind].splice(at, 1);
          suppressed.push({
            kind,
            definitionId,
            name: gone.name,
            code: gone.code,
            byLayer: layer,
            byOverrideId: o.id,
            reason: o.reason ?? null,
            origin: gone.origin,
            // Set below, once we know what was orphaned.
            movedChildren: 0,
          });
          continue;
        }

        if (action === 'OVERRIDE') {
          if (at < 0) {
            ignored.push({
              layer, overrideId: o.id, action, contentType: kind, definitionId,
              name: o.definitionName ?? null,
              why: 'Nothing to override — the role does not carry this on this date. An ADD would put it on the seat.',
            });
            continue;
          }
          const { ignoredKeys } = applyOverrideJson(bucket[kind][at], o, layer);
          if (ignoredKeys.length) {
            ignored.push({
              layer, overrideId: o.id, action, contentType: kind, definitionId,
              name: bucket[kind][at].name,
              why: `${ignoredKeys.join(', ')} cannot be overridden on an assignment — a definition's name and code live in its master.`,
            });
          }
          continue;
        }

        // ADD. An ADD that names something already present is not an error: it
        // is the same claim the role makes, so its json is applied as an
        // override and the duplication is reported rather than doubling the row.
        if (at >= 0) {
          const { ignoredKeys } = applyOverrideJson(bucket[kind][at], o, layer);
          ignored.push({
            layer, overrideId: o.id, action, contentType: kind, definitionId,
            name: bucket[kind][at].name,
            why: 'Already inherited from the role, so this ADD was applied as an override instead of a second row.'
              + (ignoredKeys.length ? ` ${ignoredKeys.join(', ')} were not applied.` : ''),
          });
          continue;
        }
        const def = definitions.get(`${kind}:${definitionId}`) ?? null;
        bucket[kind].push(itemFromAdd(kind, o, def, layer, ADDED_SEQUENCE_BASE + addedCount));
        addedCount += 1;
      }
    }
  }

  // ── the one-line rendering, after every layer has had its say ────────────
  // Last, not per-layer: a sentence built before an OVERRIDE lands would state
  // the role's weight on a row the position had already changed.
  for (const item of [...kras, ...responsibilities, ...kpis]) item.text = itemText(item);

  // ── grouping, last ───────────────────────────────────────────────────────
  const order = (a, b) => (a.sequence - b.sequence) || (Number(a.sourceRowId) - Number(b.sourceRowId));
  kras.sort(order);
  responsibilities.sort(order);
  kpis.sort(order);

  const suppressedKra = new Map(suppressed.filter((s) => s.kind === 'KRA').map((s) => [Number(s.definitionId), s]));

  const nodes = kras.map((k) => ({ ...k, responsibilities: [], kpis: [] }));
  const nodeOf = new Map(nodes.map((n) => [Number(n.definitionId), n]));
  const additional = { responsibilities: [], kpis: [] };

  const place = (item, into) => {
    const parent = item.parentKraDefinitionId == null ? null : nodeOf.get(Number(item.parentKraDefinitionId));
    if (parent) { parent[into].push(item); return; }
    // Ungrouped, or grouped under a KRA that is not here on this date. Either
    // way it is visible. Rule 2.
    if (item.parentKraDefinitionId != null) {
      const s = suppressedKra.get(Number(item.parentKraDefinitionId));
      if (s) {
        s.movedChildren += 1;
        item.orphanNote = `Listed here because its outcome area was suppressed by the ${s.byLayer.toLowerCase()}. The duty still stands.`;
      } else {
        item.orphanNote = 'Listed here because the outcome area it was filed under is not in force on this date.';
      }
    }
    additional[into].push(item);
  };
  for (const r of responsibilities) place(r, 'responsibilities');
  for (const k of kpis) place(k, 'kpis');

  // ── the six kinds with no overlay ────────────────────────────────────────
  const skills = plainRows('skills', roleLayer.skills);
  const qualifications = plainRows('qualifications', roleLayer.qualifications);
  const experience = plainRows('experience', roleLayer.experience);
  const authorities = plainRows('authorities', roleLayer.authorities);
  const relationships = plainRows('relationships', roleLayer.relationships);
  const conditions = plainRows('conditions', roleLayer.conditions);

  const weight = (rows) => rows.reduce((t, r) => t + (Number(r.weightPercent) || 0), 0);

  return {
    asOf: on,
    layers,

    /** What was resolved, resolved — so a snapshot read years later is self-describing. */
    target: {
      roleId,
      roleCode: roleLayer.role.roleCode ?? null,
      roleTitle: roleLayer.role.title ?? null,
      positionId: positionId ?? null,
      workAssignmentId: workAssignmentId ?? null,
      employeeId: assignment?.employee_id ?? null,
      employeeCode: assignment?.employee_code ?? null,
      employeeName: assignment?.full_name ?? null,
    },
    role: roleLayer.role,

    kras: nodes,
    additional,
    suppressed,

    skills,
    qualifications,
    experience,
    authorities,
    relationships,
    conditions,

    /**
     * The overlay rows themselves, live and not, so a JD can print "this seat's
     * exceptions" as a section and an HR reader can see a future-dated one
     * coming. `ignored` is every override that changed nothing, with the reason
     * — an exception that silently does nothing is the worst kind.
     */
    overlay: {
      position: overlayRows.position,
      assignment: overlayRows.assignment,
      appliedLayers: layers.filter((l) => l !== 'ROLE'),
      added: addedCount,
      suppressedCount: suppressed.length,
      overriddenCount: [...kras, ...responsibilities, ...kpis].filter((i) => i.overridden).length,
      ignored,
    },

    counts: {
      kras: nodes.length,
      responsibilities: responsibilities.length,
      kpis: kpis.length,
      groupedResponsibilities: responsibilities.length - additional.responsibilities.length,
      ungroupedResponsibilities: additional.responsibilities.length,
      ungroupedKpis: additional.kpis.length,
      skills: skills.length,
      qualifications: qualifications.length,
      experience: experience.length,
      authorities: authorities.length,
      relationships: relationships.length,
      conditions: conditions.length,
      suppressed: suppressed.length,
    },

    weights: {
      kraTotal: Math.round(weight(kras) * 100) / 100,
      kpiTotal: Math.round(weight(kpis) * 100) / 100,
      kraWeighted: kras.filter((k) => k.weightPercent != null).length,
      kpiWeighted: kpis.filter((k) => k.weightPercent != null).length,
    },
  };
}

/**
 * The definitions every ADD row needs, in one query per master.
 *
 * `shapeOverride` already resolves a name, but an ADD has to render like any
 * other line — a class, a measurement type, a unit — and that lives in the
 * master. Three queries at most, and none at all when nothing was added.
 */
async function loadDefinitions(db, companyId, overlaySets) {
  const wanted = { KRA: new Set(), RESPONSIBILITY: new Set(), KPI: new Set() };
  for (const { rows } of overlaySets) {
    for (const o of rows) {
      if (o.action !== 'ADD') continue;
      const id = o[DEF_FIELD[o.contentType]];
      if (id != null && wanted[o.contentType]) wanted[o.contentType].add(Number(id));
    }
  }
  const out = new Map();
  await Promise.all(Object.entries(wanted).map(async ([kind, ids]) => {
    if (!ids.size) return;
    const list = [...ids];
    const [rows] = await db.query(
      `SELECT * FROM ${DEF_TABLE[kind]} WHERE company_id = ? AND id IN (${list.map(() => '?').join(',')})`,
      [companyId, ...list],
    );
    for (const r of rows) out.set(`${kind}:${r.id}`, r);
  }));
  return out;
}

export default { resolveContent, targetText, LAYERS, ACTION_ORDER };
