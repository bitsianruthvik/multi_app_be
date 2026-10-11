/**
 * jobContentService.js — a job's KRAs, with the responsibilities and KPIs under
 * each, as ONE shape four screens draw (the org chart panel, a role, a position,
 * the Departments screen), plus the plain-language edits of that content.
 *
 * WHAT THIS FILE IS NOT. It is not a resolver. `contentResolver.resolveContent`
 * is the one implementation of Role -> Position overlay -> Assignment overlay
 * (plan §2 rule 6) and everything here reads its output. This file only
 *   - flattens that output into the lines a screen prints, each carrying a MARK
 *     that says whether the seat added it, changed it or switched it off, and
 *   - turns "add / change / switch off / undo for this seat" into the override
 *     rows `positionService` already knows how to write.
 * A generated JD reads the same resolver, so the screen and the document cannot
 * disagree.
 *
 * THE RULE THE CLIENT SET (2026-10-10). KRAs are fixed at the ROLE. A seat may
 * expand, change or contract the RESPONSIBILITIES, the KPIs and a KPI's TARGET —
 * never the KRAs. So the seat actions below refuse a KRA, and the role actions
 * are the only way a KRA is created, renamed or removed.
 *
 * HOW "CHANGE THE WORDING FOR THIS SEAT" IS STORED. The resolver deliberately
 * cannot rename a definition from an overlay ("define once, assign to a
 * context"), and a JD prints the definition's name. So a wording change is the
 * pattern the resolver's own header describes — "not the role's X, mine":
 *     SUPPRESS the role's line  +  ADD a new line, written for this seat
 * The ADD's `override_json` carries `replacesDefinitionId` so the two rows read
 * as ONE change on screen ("Changed for this position — the role says: …") and are
 * undone together. The resolver ignores json keys it does not know on an ADD, so
 * the JD shows the new line as specific to the position and lists the role's
 * line among the seat's exceptions. A change to a KPI TARGET alone is a plain
 * OVERRIDE of `targetOperator` / `targetValue`, which the resolver records as a
 * change with its before and after.
 *
 * `seatAuthored` in the same json marks a definition that was written for the
 * seat, so undoing the change can retire it instead of leaving the master lists
 * full of one-seat sentences. A definition picked from a master is never retired.
 */
import { invalid, conflict, notFound, assertNoProblems } from '../lib/errors.js';
import { resolveContent, targetText } from './contentResolver.js';
import {
  requirePosition, addPositionOverride, dateText, today,
} from './positionService.js';
import {
  requireRole, audit, createMasterItem, addContent, removeContent, validateTarget, CONTENT,
} from './roleContentService.js';
import { buildOrgChart } from './orgChartService.js';
import { SEATS_PER_POSITION } from './seatCount.js';

const KINDS = ['RESPONSIBILITY', 'KPI'];
const DEF_COLUMN = { RESPONSIBILITY: 'responsibility_definition_id', KPI: 'kpi_definition_id' };
const DEF_FIELD = { RESPONSIBILITY: 'responsibilityDefinitionId', KPI: 'kpiDefinitionId' };
const DEF_TABLE = { RESPONSIBILITY: 'hrms_responsibility_definitions', KPI: 'hrms_kpi_definitions' };
const MASTER_KIND = { RESPONSIBILITY: 'responsibilities', KPI: 'kpis' };
const ROLE_TABLE = { RESPONSIBILITY: 'hrms_role_responsibility_assignments', KPI: 'hrms_role_kpi_assignments' };
const NOUN = { RESPONSIBILITY: 'responsibility', KPI: 'KPI' };

const titleCase = (s) => (s ? String(s).replace(/_/g, ' ').toLowerCase().replace(/^./, (ch) => ch.toUpperCase()) : null);
const same = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();

/**
 * A definition's name is 250 characters; a long duty is stored with its name cut
 * short and ending "..." and the whole sentence in the description (the importer
 * does this, and so does a seat line written here). On screen that is ONE
 * sentence — the whole one — not a cut-off line with its own text repeated under it.
 */
const NAME_MAX = 250;
const cutShort = (name, description) => {
  const n = String(name ?? '').trim();
  const d = String(description ?? '').trim();
  if (!d || !/(\.\.\.|\u2026)$/.test(n)) return false;
  const stem = n.replace(/(\.\.\.|\u2026)$/, '').trim().toLowerCase();
  return stem.length > 0 && d.toLowerCase().startsWith(stem);
};
const wordingOf = (name, description) => (cutShort(name, description) ? String(description).trim() : name);
const nameFor = (text) => (text.length > NAME_MAX ? `${text.slice(0, NAME_MAX - 3).trimEnd()}...` : text);

/* ══════════════════════════════════════════════════════════════════════════
 * The read — one shape for a role and for a seat
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * One printed line. `mark` is the whole provenance story in one word:
 *   null      the role says it, and this seat does it as written
 *   ADDED     specific to this seat
 *   CHANGED   the role says something else (`was` holds what)
 *   OFF       the role says it and this seat does not do it
 * `overrideIds` are the seat's own rows behind the mark — what Undo removes.
 */
function lineOf(item, overrideById) {
  const line = {
    key: item.key,
    kind: item.kind,
    definitionId: item.definitionId,
    name: wordingOf(item.name, item.description),
    description: item.description && !same(item.description, item.name) && !cutShort(item.name, item.description)
      ? item.description
      : null,
    detail: null,
    mark: null,
    was: null,
    reason: item.reason ?? null,
    overrideIds: [],
    replacesDefinitionId: null,
    // The role's own assignment row, when the role introduced the line — what the
    // role editor edits, moves and removes. Null for a line the seat added.
    roleRowId: item.origin === 'ROLE' ? item.sourceRowId : null,
    parentKraDefinitionId: item.parentKraDefinitionId ?? null,
    note: item.orphanNote ?? null,
  };

  if (item.kind === 'KPI') {
    line.targetText = item.targetText ?? null;
    line.targetOperator = item.targetOperator ?? null;
    line.targetValue = item.targetValue ?? null;
    line.measurementType = item.measurementType ?? null;
    line.unit = item.unit ?? null;
    line.frequency = item.frequency ?? null;
    line.detail = [item.targetText, titleCase(item.frequency)].filter(Boolean).join(' · ') || null;
  } else if (item.responsibilityClass && item.responsibilityClass !== 'GENERIC') {
    line.detail = titleCase(item.responsibilityClass);
  }

  if (item.origin !== 'ROLE') {
    const row = overrideById.get(Number(item.sourceRowId));
    const replaces = row?.overrideJson?.replacesDefinitionId ?? null;
    line.mark = replaces ? 'CHANGED' : 'ADDED';
    line.replacesDefinitionId = replaces ? Number(replaces) : null;
    line.overrideIds = [Number(item.sourceRowId)];
    line.seatAuthored = row?.overrideJson?.seatAuthored === true;
  } else if (item.overridden) {
    line.mark = 'CHANGED';
    line.overrideIds = [...new Set((item.changes ?? []).map((c) => Number(c.byOverrideId)))];
    line.was = wasText(item);
  }
  return line;
}

/** "Role target: 95%" — what the role said before the seat changed it. */
function wasText(item) {
  const changes = item.changes ?? [];
  const firstOf = (field) => changes.find((c) => c.field === field);
  const bits = [];
  if (item.kind === 'KPI' && (firstOf('targetValue') || firstOf('targetOperator'))) {
    const operator = firstOf('targetOperator') ? firstOf('targetOperator').from : item.targetOperator;
    const value = firstOf('targetValue') ? firstOf('targetValue').from : item.targetValue;
    bits.push(`Role target: ${targetText(operator, value, item.measurementType, item.unit)}`);
  }
  const LABEL = {
    weightPercent: 'weight', frequency: 'frequency', isMandatory: 'mandatory',
    responsibilityClass: 'class', notes: 'notes', description: 'description', sequence: 'order',
  };
  const other = [...new Set(changes.map((c) => c.field))].filter((f) => LABEL[f]).map((f) => LABEL[f]);
  if (other.length) bits.push(`Also changed here: ${other.join(', ')}`);
  return bits.join('. ') || 'Changed for this position';
}

/** A line the seat switched off, rebuilt from the resolver's `suppressed` entry. */
function offLine(s) {
  return {
    key: `${s.kind}:${s.definitionId}`,
    kind: s.kind,
    definitionId: s.definitionId,
    name: s.name,
    description: null,
    detail: null,
    mark: 'OFF',
    was: null,
    reason: s.reason ?? null,
    overrideIds: [Number(s.byOverrideId)],
    replacesDefinitionId: null,
    roleRowId: null,
    parentKraDefinitionId: null,
    note: null,
  };
}

/**
 * Where the role files each switched-off line. The resolver reports that a line
 * was suppressed but not which KRA it sat under — and a switched-off line shown
 * out of its group reads as "ungrouped", which is a different statement. One
 * query, only when something is switched off.
 */
async function parentsOfSuppressed(db, companyId, roleId, suppressed) {
  const out = new Map();
  for (const kind of KINDS) {
    const ids = suppressed.filter((s) => s.kind === kind).map((s) => Number(s.definitionId));
    if (!ids.length) continue;
    const [rows] = await db.query(
      `SELECT a.${DEF_COLUMN[kind]} AS definition_id, k.kra_definition_id
         FROM ${ROLE_TABLE[kind]} a
         JOIN hrms_role_kra_assignments k ON k.company_id = a.company_id AND k.id = a.role_kra_assignment_id
        WHERE a.company_id = ? AND a.role_id = ? AND a.deleted_at IS NULL
          AND a.${DEF_COLUMN[kind]} IN (${ids.map(() => '?').join(',')})`,
      [companyId, roleId, ...ids],
    );
    for (const r of rows) out.set(`${kind}:${r.definition_id}`, Number(r.kra_definition_id));
  }
  return out;
}

async function shape(db, companyId, resolved, subject, extra = {}) {
  const overrideById = new Map((resolved.overlay?.position ?? []).map((o) => [Number(o.id), o]));
  const suppressed = (resolved.suppressed ?? []).filter((s) => KINDS.includes(s.kind) && s.byLayer === 'POSITION');
  const parents = suppressed.length
    ? await parentsOfSuppressed(db, companyId, resolved.target.roleId, suppressed)
    : new Map();

  const kras = resolved.kras.map((k) => ({
    key: k.key,
    definitionId: k.definitionId,
    // The role's own KRA row — what rename, delete and "move a line here" address.
    roleRowId: k.origin === 'ROLE' ? k.sourceRowId : null,
    name: k.name,
    description: k.description ?? null,
    weightPercent: k.weightPercent ?? null,
    mark: k.origin !== 'ROLE' ? 'ADDED' : (k.overridden ? 'CHANGED' : null),
    overrideIds: k.origin !== 'ROLE' ? [Number(k.sourceRowId)] : [],
    responsibilities: k.responsibilities.map((i) => lineOf(i, overrideById)),
    kpis: k.kpis.map((i) => lineOf(i, overrideById)),
  }));
  const ungrouped = {
    responsibilities: resolved.additional.responsibilities.map((i) => lineOf(i, overrideById)),
    kpis: resolved.additional.kpis.map((i) => lineOf(i, overrideById)),
  };
  const kraByDefinition = new Map(kras.map((k) => [Number(k.definitionId), k]));

  // A wording change is two rows that are one change: fold the switched-off role
  // line into the seat's replacement, so it is shown once.
  const everyLine = [
    ...kras.flatMap((k) => [...k.responsibilities, ...k.kpis]),
    ...ungrouped.responsibilities, ...ungrouped.kpis,
  ];
  const replacementOf = new Map(
    everyLine.filter((l) => l.replacesDefinitionId).map((l) => [`${l.kind}:${l.replacesDefinitionId}`, l]),
  );
  for (const s of suppressed) {
    const key = `${s.kind}:${s.definitionId}`;
    const replacement = replacementOf.get(key);
    if (replacement) {
      replacement.was = `The role says: ${s.name}`;
      replacement.roleWording = s.name;
      replacement.overrideIds.push(Number(s.byOverrideId));
      continue;
    }
    const line = offLine(s);
    const parent = kraByDefinition.get(parents.get(key));
    line.parentKraDefinitionId = parent ? parent.definitionId : null;
    const into = s.kind === 'KPI' ? 'kpis' : 'responsibilities';
    (parent ?? ungrouped)[into].push(line);
  }
  // A replacement whose role line is no longer suppressed is simply the seat's own line.
  for (const l of everyLine) {
    if (l.replacesDefinitionId && !l.was) { l.mark = 'ADDED'; l.replacesDefinitionId = null; }
  }

  const all = [
    ...kras.flatMap((k) => [...k.responsibilities, ...k.kpis]),
    ...ungrouped.responsibilities, ...ungrouped.kpis,
  ];
  const live = all.filter((l) => l.mark !== 'OFF');

  return {
    asOf: resolved.asOf,
    subject,                                  // 'ROLE' | 'SEAT'
    roleId: resolved.target.roleId,
    roleTitle: resolved.target.roleTitle,
    positionId: resolved.target.positionId,
    ...extra,
    kras,
    ungrouped,
    counts: {
      kras: kras.length,
      responsibilities: live.filter((l) => l.kind === 'RESPONSIBILITY').length,
      kpis: live.filter((l) => l.kind === 'KPI').length,
      ungrouped: ungrouped.responsibilities.length + ungrouped.kpis.length,
      added: all.filter((l) => l.mark === 'ADDED').length,
      changed: all.filter((l) => l.mark === 'CHANGED').length,
      off: all.filter((l) => l.mark === 'OFF').length,
    },
    /**
     * Seat rows that touch a KRA. The rule is that KRAs are fixed at the role, so
     * the screens offer no way to write one — but a row written before the rule
     * (or through the raw override endpoint) still resolves, and hiding it would
     * make the seat's KRAs differ from its role's for no visible reason.
     */
    kraExceptions: (resolved.overlay?.position ?? [])
      .filter((o) => o.contentType === 'KRA')
      .map((o) => ({ overrideId: o.id, action: o.action, name: o.definitionName ?? null, reason: o.reason ?? null })),
    /** Seat rows that changed nothing, each with the reason — never silent. */
    ignored: (resolved.overlay?.ignored ?? [])
      .filter((i) => i.layer === 'POSITION')
      .map((i) => ({ overrideId: i.overrideId, name: i.name ?? null, why: i.why })),
  };
}

/** A ROLE's job content: what every seat holding it starts from. */
export async function roleJobContent(db, companyId, roleId, { on } = {}) {
  const resolved = await resolveContent(db, companyId, { roleId, on });
  return shape(db, companyId, resolved, 'ROLE');
}

/** A SEAT's job content: its role's, with this seat's own changes applied and marked. */
export async function positionJobContent(db, companyId, positionId, { on } = {}) {
  const position = await requirePosition(db, companyId, positionId);
  const resolved = await resolveContent(db, companyId, { roleId: position.role_id, positionId, on });
  // How many OTHER seats hold the same role — so "for this seat only" has a number beside it.
  const [[others]] = await db.query(
    `SELECT COUNT(*) AS n FROM hrms_positions
      WHERE company_id = ? AND role_id = ? AND id <> ? AND deleted_at IS NULL AND status <> 'CLOSED'`,
    [companyId, position.role_id, positionId],
  );
  return shape(db, companyId, resolved, 'SEAT', {
    positionTitle: position.position_title ?? resolved.target.roleTitle ?? null,
    positionCode: position.position_code ?? null,
    otherSeatsOnRole: Number(others.n ?? 0),
  });
}

/* ══════════════════════════════════════════════════════════════════════════
 * Seat edits — Add, Change, Switch off, Undo
 * ══════════════════════════════════════════════════════════════════════════
 * Each one is a handful of override rows written in the caller's transaction,
 * and each answers with the seat's job content AFTER the edit, so the screen
 * needs no second request to show what it did.
 */

function readKind(value) {
  const kind = String(value ?? '').trim().toUpperCase();
  if (kind === 'KRA') {
    throw invalid('KRA_FIXED_AT_ROLE', 'KRAs are set on the role and are the same for every position holding it. Change them on the role.');
  }
  if (!KINDS.includes(kind)) throw invalid('INVALID', 'Say whether this is a responsibility or a KPI.');
  return kind;
}

function readText(value, label, problems, { required = true, max = 2000 } = {}) {
  const s = value == null ? '' : String(value).trim();
  if (!s) { if (required) problems.push(`${label} is required.`); return null; }
  if (s.length > max) problems.push(`${label} is up to ${max} characters.`);
  return s;
}

/** `{ operator, value }` as the screen sends it -> the two json fields an override carries. */
function readTarget(target, measurementType, problems) {
  if (target == null) return null;
  // An empty box is "no target", not a target that failed validation.
  if (!target.operator && (target.value == null || String(target.value).trim() === '')) return null;
  const operator = String(target.operator ?? (measurementType === 'TEXT' ? 'EQ' : '')).trim().toUpperCase() || null;
  const before = problems.length;
  const stored = validateTarget(operator, target.value, measurementType ?? 'NUMBER', problems);
  if (problems.length > before) return null;
  return { targetOperator: operator ?? 'INFO', targetValue: stored == null ? null : JSON.parse(stored) };
}

async function liveOverrides(db, companyId, positionId) {
  const [rows] = await db.query(
    `SELECT id, content_type, action, responsibility_definition_id, kpi_definition_id, parent_kra_definition_id, override_json, reason
       FROM hrms_position_content_overrides
      WHERE company_id = ? AND position_id = ? AND deleted_at IS NULL`,
    [companyId, positionId],
  );
  return rows.map((r) => ({
    ...r,
    json: r.override_json == null ? null : (typeof r.override_json === 'string' ? JSON.parse(r.override_json) : r.override_json),
  }));
}

async function dropOverrides(db, c, rows) {
  if (!rows.length) return;
  await db.query(
    `UPDATE hrms_position_content_overrides SET deleted_at = NOW()
      WHERE company_id = ? AND id IN (${rows.map(() => '?').join(',')}) AND deleted_at IS NULL`,
    [c.companyId, ...rows.map((r) => r.id)],
  );
  for (const r of rows) {
    await audit(db, c, 'hrms_position_content_overrides', r.id, 'DELETE',
      { action: r.action, contentType: r.content_type, definitionId: r.responsibility_definition_id ?? r.kpi_definition_id }, null);
  }
}

async function writeOverride(db, c, positionId, body) {
  const { id } = await addPositionOverride(db, c, positionId, body);
  await audit(db, c, 'hrms_position_content_overrides', id, 'CREATE', null, { positionId, ...body });
  return id;
}

/**
 * Retires a definition that was written for one seat and is now used by nothing.
 * Never touches a definition any role assigns or any other overlay names.
 */
async function retireIfUnused(db, c, kind, definitionId) {
  const col = DEF_COLUMN[kind];
  const [[use]] = await db.query(
    `SELECT (SELECT COUNT(*) FROM ${ROLE_TABLE[kind]} a WHERE a.company_id = ? AND a.${col} = ? AND a.deleted_at IS NULL)
          + (SELECT COUNT(*) FROM hrms_position_content_overrides o WHERE o.company_id = ? AND o.${col} = ? AND o.deleted_at IS NULL)
          + (SELECT COUNT(*) FROM hrms_work_assignment_content_overrides o WHERE o.company_id = ? AND o.${col} = ? AND o.deleted_at IS NULL) AS n`,
    [c.companyId, definitionId, c.companyId, definitionId, c.companyId, definitionId],
  );
  if (Number(use.n) > 0) return;
  await db.query(`UPDATE ${DEF_TABLE[kind]} SET deleted_at = NOW() WHERE company_id = ? AND id = ? AND deleted_at IS NULL`, [c.companyId, definitionId]);
  await audit(db, c, DEF_TABLE[kind], definitionId, 'DELETE', { retired: 'written for one seat, no longer used' }, null);
}

/** Every line the seat currently resolves to, flat, with the role's KRAs. */
async function currentLines(db, companyId, position) {
  const resolved = await resolveContent(db, companyId, { roleId: position.role_id, positionId: position.id });
  const lines = [
    ...resolved.kras.flatMap((k) => [...k.responsibilities, ...k.kpis]),
    ...resolved.additional.responsibilities, ...resolved.additional.kpis,
  ];
  return { resolved, lines };
}

async function writeSeatDefinition(db, c, kind, text, like = null) {
  const body = kind === 'KPI'
    ? {
      name: nameFor(text),
      description: text.length > NAME_MAX ? text : null,
      measurementType: like?.measurementType ?? 'TEXT',
      unit: like?.unit ?? null,
      direction: like?.direction ?? null,
      defaultFrequency: like?.frequency ?? null,
      status: 'ACTIVE',
    }
    : { name: nameFor(text), description: text, responsibilityClass: like?.responsibilityClass ?? null, status: 'ACTIVE' };
  return createMasterItem(db, c, MASTER_KIND[kind], body);
}

/**
 * ADD — a responsibility or a KPI for this seat only, under one of the role's
 * KRAs (or under none).
 */
export async function seatAddLine(db, c, positionId, body = {}) {
  const position = await requirePosition(db, c.companyId, positionId);
  const kind = readKind(body.kind);
  const problems = [];
  const text = readText(body.text, kind === 'KPI' ? 'The KPI' : 'The responsibility', problems);
  const reason = readText(body.reason, 'Reason', problems, { required: false, max: 2000 });
  const target = kind === 'KPI' ? readTarget(body.target, 'TEXT', problems) : null;
  assertNoProblems(problems);

  const { resolved, lines } = await currentLines(db, c.companyId, position);
  if (lines.some((l) => l.kind === kind && same(wordingOf(l.name, l.description), text))) {
    throw conflict('ALREADY_THERE', `This seat already has that ${NOUN[kind]}.`);
  }
  const parent = body.parentKraDefinitionId == null || body.parentKraDefinitionId === '' ? null : Number(body.parentKraDefinitionId);
  if (parent != null && !resolved.kras.some((k) => Number(k.definitionId) === parent)) {
    throw invalid('BAD_REFERENCE', 'Pick one of the KRAs of this seat\'s role. A seat cannot have a KRA its role does not have.');
  }

  const definition = await writeSeatDefinition(db, c, kind, text);
  await writeOverride(db, c, positionId, {
    contentType: kind,
    action: 'ADD',
    [DEF_FIELD[kind]]: definition.id,
    parentKraDefinitionId: parent,
    overrideJson: { seatAuthored: true, ...(target ?? {}) },
    reason,
  });
  return positionJobContent(db, c.companyId, positionId);
}

/**
 * CHANGE — the wording of a line, or a KPI's target, for this seat only.
 * See the header for why a wording change is a SUPPRESS plus an ADD.
 */
export async function seatChangeLine(db, c, positionId, body = {}) {
  const position = await requirePosition(db, c.companyId, positionId);
  const kind = readKind(body.kind);
  const definitionId = Number(body.definitionId);
  const { resolved, lines } = await currentLines(db, c.companyId, position);
  const line = lines.find((l) => l.kind === kind && Number(l.definitionId) === definitionId);
  if (!line) throw notFound(`That ${NOUN[kind]} on this seat`);

  const problems = [];
  const text = body.text === undefined ? null : readText(body.text, 'The wording', problems);
  const reason = readText(body.reason, 'Reason', problems, { required: false, max: 2000 });
  const target = kind === 'KPI' && body.target !== undefined ? readTarget(body.target, line.measurementType, problems) : null;
  assertNoProblems(problems);

  const rewording = text != null && !same(text, wordingOf(line.name, line.description));
  if (!rewording && !target) throw invalid('NOTHING_TO_CHANGE', 'Nothing was changed.');
  if (rewording && lines.some((l) => l !== line && l.kind === kind && same(wordingOf(l.name, l.description), text))) {
    throw conflict('ALREADY_THERE', `This seat already has a ${NOUN[kind]} with that wording.`);
  }

  const col = DEF_COLUMN[kind];
  const overrides = await liveOverrides(db, c.companyId, positionId);
  const mine = overrides.filter((o) => o.content_type === kind && Number(o[col]) === definitionId);
  const seatOwned = line.origin !== 'ROLE';

  if (!rewording) {
    // Target only. One row says it: replace whichever row said it before.
    if (seatOwned) {
      const add = mine.find((o) => o.action === 'ADD');
      await dropOverrides(db, c, mine.filter((o) => o.action === 'ADD'));
      await writeOverride(db, c, positionId, {
        contentType: kind, action: 'ADD', [DEF_FIELD[kind]]: definitionId,
        parentKraDefinitionId: add?.parent_kra_definition_id ?? line.parentKraDefinitionId ?? null,
        overrideJson: { ...(add?.json ?? {}), ...target },
        reason: reason ?? add?.reason ?? null,
      });
    } else {
      const earlier = mine.filter((o) => o.action === 'OVERRIDE');
      // Keep anything else an earlier override said (a weight, a frequency).
      const carried = Object.assign({}, ...earlier.map((o) => o.json ?? {}));
      await dropOverrides(db, c, earlier);
      await writeOverride(db, c, positionId, {
        contentType: kind, action: 'OVERRIDE', [DEF_FIELD[kind]]: definitionId,
        overrideJson: { ...carried, ...target },
        reason,
      });
    }
    return positionJobContent(db, c.companyId, positionId);
  }

  // Wording. The seat gets a line of its own; the role's line is switched off.
  const definition = await writeSeatDefinition(db, c, kind, text, line);
  const carriedTarget = kind === 'KPI'
    ? (target ?? { targetOperator: line.targetOperator ?? 'INFO', targetValue: line.targetValue ?? null })
    : {};
  if (seatOwned) {
    const add = mine.find((o) => o.action === 'ADD');
    await dropOverrides(db, c, mine);
    await writeOverride(db, c, positionId, {
      contentType: kind, action: 'ADD', [DEF_FIELD[kind]]: definition.id,
      parentKraDefinitionId: add?.parent_kra_definition_id ?? line.parentKraDefinitionId ?? null,
      overrideJson: { ...(add?.json ?? {}), seatAuthored: true, ...carriedTarget },
      reason: reason ?? add?.reason ?? null,
    });
    if (add?.json?.seatAuthored) await retireIfUnused(db, c, kind, definitionId);
  } else {
    await dropOverrides(db, c, mine);
    await writeOverride(db, c, positionId, { contentType: kind, action: 'SUPPRESS', [DEF_FIELD[kind]]: definitionId, reason });
    const parentStillThere = line.parentKraDefinitionId != null
      && resolved.kras.some((k) => Number(k.definitionId) === Number(line.parentKraDefinitionId));
    await writeOverride(db, c, positionId, {
      contentType: kind, action: 'ADD', [DEF_FIELD[kind]]: definition.id,
      parentKraDefinitionId: parentStillThere ? line.parentKraDefinitionId : null,
      overrideJson: { seatAuthored: true, replacesDefinitionId: definitionId, sequence: line.sequence, ...carriedTarget },
      reason,
    });
  }
  return positionJobContent(db, c.companyId, positionId);
}

/** SWITCH OFF — a line of the role that does not apply to this seat. */
export async function seatSwitchOffLine(db, c, positionId, body = {}) {
  const position = await requirePosition(db, c.companyId, positionId);
  const kind = readKind(body.kind);
  const definitionId = Number(body.definitionId);
  const problems = [];
  const reason = readText(body.reason, 'Reason', problems, { required: false, max: 2000 });
  assertNoProblems(problems);

  const { lines } = await currentLines(db, c.companyId, position);
  const line = lines.find((l) => l.kind === kind && Number(l.definitionId) === definitionId);
  if (!line) throw notFound(`That ${NOUN[kind]} on this seat`);

  const col = DEF_COLUMN[kind];
  const overrides = await liveOverrides(db, c.companyId, positionId);
  const mine = overrides.filter((o) => o.content_type === kind && Number(o[col]) === definitionId);

  if (line.origin !== 'ROLE') {
    // The seat's own line. Switching it off is removing it; if it replaced a role
    // line, that role line stays switched off — which is what was asked for.
    const add = mine.find((o) => o.action === 'ADD');
    await dropOverrides(db, c, mine);
    if (add?.json?.seatAuthored) await retireIfUnused(db, c, kind, definitionId);
  } else {
    await dropOverrides(db, c, mine);
    await writeOverride(db, c, positionId, { contentType: kind, action: 'SUPPRESS', [DEF_FIELD[kind]]: definitionId, reason });
  }
  return positionJobContent(db, c.companyId, positionId);
}

/**
 * UNDO — put one line back to what the role says. Removes every row this seat
 * holds on it; for a wording change that is the seat's line AND the switch-off
 * of the role's line, together.
 */
export async function seatUndoLine(db, c, positionId, body = {}) {
  await requirePosition(db, c.companyId, positionId);
  const kind = readKind(body.kind);
  const definitionId = Number(body.definitionId);
  const col = DEF_COLUMN[kind];

  const overrides = await liveOverrides(db, c.companyId, positionId);
  const mine = overrides.filter((o) => o.content_type === kind && Number(o[col]) === definitionId);
  if (!mine.length) throw invalid('NOTHING_TO_UNDO', 'This seat has not changed that line — it already reads as the role says.');

  const replaced = mine.filter((o) => o.action === 'ADD' && o.json?.replacesDefinitionId).map((o) => Number(o.json.replacesDefinitionId));
  const paired = overrides.filter((o) => o.content_type === kind && o.action === 'SUPPRESS' && replaced.includes(Number(o[col])));
  await dropOverrides(db, c, [...mine, ...paired]);
  if (mine.some((o) => o.action === 'ADD' && o.json?.seatAuthored)) await retireIfUnused(db, c, kind, definitionId);
  return positionJobContent(db, c.companyId, positionId);
}

/* ══════════════════════════════════════════════════════════════════════════
 * Role edits — the KRAs themselves
 * ══════════════════════════════════════════════════════════════════════════
 * A KRA is written freely per role, but `hrms_kra_definitions.name` is unique
 * per company (the master is a shared vocabulary). So:
 *   create  reuses the definition of that name when one exists, else writes one;
 *   rename  edits the definition in place when only this role uses it, and gives
 *           this role its OWN definition when another role shares it — a rename
 *           on one role must never rename another role's KRA.
 */

async function requireRoleKra(db, companyId, id) {
  const [[row]] = await db.query(
    `SELECT a.id, a.role_id, a.kra_definition_id, d.name, d.description
       FROM hrms_role_kra_assignments a
       JOIN hrms_kra_definitions d ON d.company_id = a.company_id AND d.id = a.kra_definition_id
      WHERE a.company_id = ? AND a.id = ? AND a.deleted_at IS NULL`,
    [companyId, id],
  );
  if (!row) throw notFound('KRA');
  return row;
}

async function kraDefinitionNamed(db, companyId, name) {
  const [[row]] = await db.query(
    'SELECT id, name, description, status FROM hrms_kra_definitions WHERE company_id = ? AND deleted_at IS NULL AND LOWER(name) = LOWER(?)',
    [companyId, name],
  );
  return row ?? null;
}

async function roleHasKra(db, companyId, roleId, definitionId, exceptId = null) {
  const [[row]] = await db.query(
    `SELECT id FROM hrms_role_kra_assignments
      WHERE company_id = ? AND role_id = ? AND kra_definition_id = ? AND deleted_at IS NULL AND (? IS NULL OR id <> ?)`,
    [companyId, roleId, definitionId, exceptId, exceptId],
  );
  return !!row;
}

/** Create a KRA on a role by writing it: `{ name, description? }`. */
export async function createRoleKra(db, c, roleId, body = {}) {
  await requireRole(db, c.companyId, roleId);
  const problems = [];
  const name = readText(body.name, 'The KRA', problems, { max: 200 });
  const description = readText(body.description, 'Description', problems, { required: false, max: 4000 });
  assertNoProblems(problems);

  let definition = await kraDefinitionNamed(db, c.companyId, name);
  if (definition && await roleHasKra(db, c.companyId, roleId, definition.id)) {
    throw conflict('ALREADY_THERE', `This role already has the KRA "${definition.name}".`);
  }
  if (!definition) {
    definition = await createMasterItem(db, c, 'kras', { name, description, status: 'ACTIVE' });
  } else if (definition.status === 'INACTIVE') {
    throw conflict('INACTIVE', `A KRA named "${definition.name}" exists but is inactive. Reactivate it in the KRA list, or use another name.`);
  }
  return addContent(db, c, roleId, 'kras', { kraDefinitionId: definition.id });
}

/** How many OTHER roles (and seats outside this role) lean on a KRA definition. */
async function kraSharedBy(db, companyId, definitionId, roleId) {
  const [[row]] = await db.query(
    `SELECT (SELECT COUNT(*) FROM hrms_role_kra_assignments a
              WHERE a.company_id = ? AND a.kra_definition_id = ? AND a.deleted_at IS NULL AND a.role_id <> ?) AS roles`,
    [companyId, definitionId, roleId],
  );
  return Number(row.roles ?? 0);
}

/** Rename a role's KRA, and/or rewrite its description. */
export async function renameRoleKra(db, c, id, body = {}) {
  const kra = await requireRoleKra(db, c.companyId, id);
  const problems = [];
  const name = body.name === undefined ? kra.name : readText(body.name, 'The KRA', problems, { max: 200 });
  const description = body.description === undefined
    ? kra.description
    : readText(body.description, 'Description', problems, { required: false, max: 4000 });
  assertNoProblems(problems);

  const shared = await kraSharedBy(db, c.companyId, kra.kra_definition_id, kra.role_id);
  const renamed = !same(name, kra.name);
  const existing = renamed ? await kraDefinitionNamed(db, c.companyId, name) : null;
  if (existing && Number(existing.id) !== Number(kra.kra_definition_id)
      && await roleHasKra(db, c.companyId, kra.role_id, existing.id, id)) {
    throw conflict('ALREADY_THERE', `This role already has a KRA named "${existing.name}". Move the lines there instead.`);
  }

  if (!renamed || (!shared && !existing)) {
    // Only this role uses it (or only the description changed): edit it where it is.
    await db.query('UPDATE hrms_kra_definitions SET name = ?, description = ? WHERE company_id = ? AND id = ?',
      [name, description, c.companyId, kra.kra_definition_id]);
    await audit(db, c, 'hrms_kra_definitions', kra.kra_definition_id, 'UPDATE',
      { name: kra.name, description: kra.description }, { name, description });
    return { ok: true, id, definitionId: kra.kra_definition_id, forked: false, sharedWithRoles: shared };
  }

  // Another role shares the definition, or the new name already exists: this
  // role's row moves to the right definition and takes its seats' rows with it.
  const target = existing ?? await createMasterItem(db, c, 'kras', { name, description, status: 'ACTIVE' });
  await db.query('UPDATE hrms_role_kra_assignments SET kra_definition_id = ? WHERE company_id = ? AND id = ?',
    [target.id, c.companyId, id]);
  for (const [table, owner, ownerTable] of [
    ['hrms_position_content_overrides', 'position_id', 'hrms_positions'],
    ['hrms_work_assignment_content_overrides', 'work_assignment_id', 'hrms_work_assignments'],
  ]) {
    for (const column of ['parent_kra_definition_id', 'kra_definition_id']) {
      await db.query(
        `UPDATE ${table} o JOIN ${ownerTable} t ON t.company_id = o.company_id AND t.id = o.${owner}
            SET o.${column} = ?
          WHERE o.company_id = ? AND t.role_id = ? AND o.${column} = ? AND o.deleted_at IS NULL`,
        [target.id, c.companyId, kra.role_id, kra.kra_definition_id],
      );
    }
  }
  await audit(db, c, 'hrms_role_kra_assignments', id, 'UPDATE',
    { kraDefinitionId: kra.kra_definition_id, name: kra.name }, { kraDefinitionId: target.id, name });
  if (!shared) {
    // Nothing else pointed at the old definition; do not leave it behind.
    const [[left]] = await db.query(
      `SELECT (SELECT COUNT(*) FROM hrms_role_kra_assignments a WHERE a.company_id = ? AND a.kra_definition_id = ? AND a.deleted_at IS NULL)
            + (SELECT COUNT(*) FROM hrms_position_content_overrides o WHERE o.company_id = ? AND (o.kra_definition_id = ? OR o.parent_kra_definition_id = ?) AND o.deleted_at IS NULL)
            + (SELECT COUNT(*) FROM hrms_work_assignment_content_overrides o WHERE o.company_id = ? AND (o.kra_definition_id = ? OR o.parent_kra_definition_id = ?) AND o.deleted_at IS NULL) AS n`,
      [c.companyId, kra.kra_definition_id, c.companyId, kra.kra_definition_id, kra.kra_definition_id, c.companyId, kra.kra_definition_id, kra.kra_definition_id],
    );
    if (!Number(left.n)) {
      await db.query('UPDATE hrms_kra_definitions SET deleted_at = NOW() WHERE company_id = ? AND id = ?', [c.companyId, kra.kra_definition_id]);
    }
  }
  return { ok: true, id, definitionId: target.id, forked: true, sharedWithRoles: shared };
}

/**
 * Delete a KRA from a role. ITS LINES ARE NOT DELETED: they are un-filed first
 * and stay on the role, ungrouped. They are un-filed explicitly rather than left
 * pointing at the ended row, so writing the same KRA again later starts empty
 * instead of silently swallowing them back.
 */
export async function deleteRoleKra(db, c, id) {
  const kra = await requireRoleKra(db, c.companyId, id);
  let ungrouped = 0;
  for (const kind of ['responsibilities', 'kpis']) {
    const [res] = await db.query(
      `UPDATE ${CONTENT[kind].table} SET role_kra_assignment_id = NULL
        WHERE company_id = ? AND role_id = ? AND role_kra_assignment_id = ? AND deleted_at IS NULL`,
      [c.companyId, kra.role_id, id],
    );
    ungrouped += Number(res.affectedRows ?? 0);
  }
  await removeContent(db, c, 'kras', id);
  return { ok: true, id, name: kra.name, ungrouped };
}

/**
 * Move several lines under one KRA (or out of every KRA) in one write.
 * `{ roleKraAssignmentId | null, responsibilities: [rowId], kpis: [rowId] }`.
 * One request for a selection of thirty, not thirty requests.
 */
export async function moveRoleLines(db, c, roleId, body = {}) {
  await requireRole(db, c.companyId, roleId);
  const target = body.roleKraAssignmentId == null || body.roleKraAssignmentId === '' ? null : Number(body.roleKraAssignmentId);
  if (target != null) {
    const kra = await requireRoleKra(db, c.companyId, target);
    if (Number(kra.role_id) !== Number(roleId)) {
      throw invalid('BAD_REFERENCE', 'A responsibility or KPI can only be grouped under a KRA that belongs to the same role.');
    }
  }
  let moved = 0;
  for (const kind of ['responsibilities', 'kpis']) {
    const ids = [...new Set((Array.isArray(body[kind]) ? body[kind] : []).map(Number))].filter((n) => Number.isInteger(n) && n > 0);
    if (!ids.length) continue;
    const marks = ids.map(() => '?').join(',');
    const [found] = await db.query(
      `SELECT id FROM ${CONTENT[kind].table} WHERE company_id = ? AND role_id = ? AND deleted_at IS NULL AND id IN (${marks})`,
      [c.companyId, roleId, ...ids],
    );
    if (found.length !== ids.length) {
      throw invalid('INVALID', 'That selection lists a line that is not part of this role — reload the screen and try again.');
    }
    await db.query(
      `UPDATE ${CONTENT[kind].table} SET role_kra_assignment_id = ? WHERE company_id = ? AND role_id = ? AND id IN (${marks})`,
      [target, c.companyId, roleId, ...ids],
    );
    await audit(db, c, CONTENT[kind].table, roleId, 'UPDATE', null, { movedToRoleKraAssignmentId: target, ids });
    moved += ids.length;
  }
  if (!moved) throw invalid('INVALID', 'Pick at least one line to move.');
  return { ok: true, roleId, roleKraAssignmentId: target, moved };
}

/* ══════════════════════════════════════════════════════════════════════════
 * Departments — the roles and positions inside each one
 * ══════════════════════════════════════════════════════════════════════════
 * Built FROM THE ORG CHART'S OWN NODES, not from a second query over positions,
 * so a department's seats, filled and vacant here are the chart's numbers by
 * construction. One position is one seat (services/seatCount.js): `seats` is
 * the number of positions, and each position row is filled (one `occupant`) or
 * vacant. Each row also carries its `shift` and its `cardId`, so the screen can
 * show seven chairs of one card as one line with seven rows.
 * The whole company in one answer — Karni is 220 positions — so the Departments
 * screen makes one request, not one per department and never one per position.
 */
export async function departmentStaffing(db, companyId, { on } = {}) {
  const asOf = dateText(on) || today();
  const chart = await buildOrgChart(db, companyId, { on: asOf });

  const byDepartment = new Map();
  const bucket = (id) => {
    const key = id == null ? 0 : Number(id);
    if (!byDepartment.has(key)) byDepartment.set(key, { departmentId: id == null ? null : Number(id), roles: new Map() });
    return byDepartment.get(key);
  };

  for (const n of chart.nodes) {
    const dept = bucket(n.departmentId);
    const roleKey = n.roleId ?? 0;
    if (!dept.roles.has(roleKey)) {
      dept.roles.set(roleKey, {
        roleId: n.roleId ?? null, roleTitle: n.roleTitle ?? 'No role', roleCode: n.roleCode ?? null,
        seats: 0, filled: 0, vacant: 0, positions: [],
      });
    }
    const role = dept.roles.get(roleKey);
    const vacant = Number(n.vacancies);
    const seats = SEATS_PER_POSITION;
    const filled = seats - vacant;
    role.seats += seats;
    role.filled += filled;
    role.vacant += vacant;
    role.positions.push({
      positionId: n.id,
      positionCode: n.positionCode,
      title: n.displayTitle ?? n.title,
      status: n.status,
      cardId: n.cardId,
      shiftPattern: n.shiftPattern,
      shift: n.defaultShift,
      seats,
      filled,
      vacant,
      overFilled: n.overFilled === true,
      // The one person in the position, or null. `occupants` is the same person
      // as a list, for the screens written when a position held several.
      occupant: n.occupants[0]
        ? { employeeId: n.occupants[0].employeeId, name: n.occupants[0].name, employeeCode: n.occupants[0].employeeCode ?? null, notice: n.occupants[0].notice ?? null }
        : null,
      occupants: n.occupants.map((o) => ({ employeeId: o.employeeId, name: o.name, employeeCode: o.employeeCode ?? null, notice: o.notice ?? null })),
      // The OPEN hiring on this position, or null — the chart's own, so the two screens agree.
      hiring: n.hiring ?? null,
      // …and who is due to join it from a later date, or null.
      joining: n.joining ?? null,
      // Whether this seat reads differently from its role (an add / change / switch-off).
      hasSeatChanges: false,
    });
  }

  // Which seats carry changes of their own — one grouped query for the company.
  const [changed] = await db.query(
    `SELECT o.position_id, COUNT(*) AS n FROM hrms_position_content_overrides o
      WHERE o.company_id = ? AND o.deleted_at IS NULL
        AND (o.effective_from IS NULL OR o.effective_from <= ?) AND (o.effective_to IS NULL OR o.effective_to >= ?)
      GROUP BY o.position_id`,
    [companyId, asOf, asOf],
  );
  const changedIds = new Set(changed.map((r) => Number(r.position_id)));

  const departments = [...byDepartment.values()].map((d) => {
    const roles = [...d.roles.values()].sort((a, b) => a.roleTitle.localeCompare(b.roleTitle));
    for (const r of roles) {
      for (const p of r.positions) p.hasSeatChanges = changedIds.has(Number(p.positionId));
      r.positions.sort((a, b) => a.title.localeCompare(b.title));
    }
    const sum = (key) => roles.reduce((t, r) => t + r[key], 0);
    return {
      departmentId: d.departmentId,
      roles,
      counts: {
        roles: roles.length,
        positions: roles.reduce((t, r) => t + r.positions.length, 0),
        seats: sum('seats'),
        filled: sum('filled'),
        vacant: sum('vacant'),
      },
    };
  });

  return {
    asOf,
    departments,
    // The chart's own totals, passed through so the screen can show they agree.
    counts: {
      positions: chart.counts.positions,
      seats: chart.counts.sanctioned,
      filled: chart.counts.filled,
      vacant: chart.counts.vacant,
    },
  };
}

export default {
  roleJobContent, positionJobContent,
  seatAddLine, seatChangeLine, seatSwitchOffLine, seatUndoLine,
  createRoleKra, renameRoleKra, deleteRoleKra, moveRoleLines,
  departmentStaffing,
};
