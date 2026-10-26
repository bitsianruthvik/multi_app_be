/**
 * unitReportingService.js — an org unit's Head and Reports into, moving a unit with
 * them, and the consistency check (TM/CF_HRMS_HIRING_SPEC.md §40.2, §40.4, §40.5).
 *
 * The ORDER a manager resolves in is lib/unitReporting.js; the rows are loaded by
 * reportingResolver.loadReportingModel. This file only reads that model, writes
 * hrms_unit_heads / hrms_departments.reports_into_* / a line's cross_tree_reason,
 * and words what it finds.
 *
 *   GET  /organisation/departments/:id/reporting   unitReporting(db, companyId, id)
 *   PUT  /organisation/departments/:id/reporting   setUnitReporting(db, c, id, body)
 *        { heads?: [{ positionId, shiftId|null }], reportsInto?: { mode: 'DEFAULT' } | { mode: 'CHOSEN', positionId, reason? } }
 *   GET  /organisation/consistency                 consistency(db, companyId)
 *   POST /organisation/consistency/fix             fixConsistency(db, c, { key, action, positionId?, reason?, edgeId?, unitId? })
 *
 * RULES (every write; refusals in words, 422 unless said):
 *   - a head is a live position of this unit or of a unit above it (one position may head several units);
 *   - one head per shift; either one head for the unit (no shift) or a head per shift, not both;
 *   - Reports into CHOSEN: a live position, never in this unit or under it (LOOP); outside the parent and the
 *     units above it only with a reason (REASON_NEEDED);
 *   - nothing may create a reporting loop (LOOP, with the chairs named);
 *   - another company's unit or position reads as not found.
 * Every change is audited (hrms_departments / hrms_unit_heads / hrms_position_reporting_relationships).
 */
import { HrmsError, invalid, notFound, conflict } from '../lib/errors.js';
import { buildReportingModel, findInconsistencies } from '../lib/unitReporting.js';
import { loadReportingModel, posRef } from './reportingResolver.js';
import { audit } from './peopleService.js';
import { today, endPositionReporting, removePositionReporting, addPositionReporting, previousDay } from './positionService.js';
import { dateText } from './positionService.js';

const REASON_MAX = 500;
const clean = (v) => (v == null ? null : String(v).trim().slice(0, REASON_MAX) || null);

async function shiftsOf(db, companyId) {
  const [rows] = await db.query("SELECT id, code, name, status FROM hrms_shifts WHERE company_id = ? AND deleted_at IS NULL ORDER BY code, id", [companyId]);
  return rows;
}

/** A model rebuilt from the same inputs with changes (a unit moved, a head set) — for "what would it be". */
function rebuild(model, { units: unitPatch = null, heads = null, dropExplicit = null } = {}) {
  const units = [...model.units.values()].map((u) => (unitPatch?.[u.id] ? { ...u, ...unitPatch[u.id] } : u));
  const headRows = heads ?? [...model.units.keys()].flatMap((id) => model.allHeadsOf(id));
  const explicit = [...model.explicitAll].filter((e) => !(dropExplicit && dropExplicit.has(Number(e.id))));
  const m = buildReportingModel({ positions: [...model.positions.values()], units, heads: headRows, explicit });
  m.explicitAll = explicit;
  return m;
}

/** Loop keys of a model (LOOP:<min position id>). */
const loopKeys = (model) => new Set(findInconsistencies(model).filter((f) => f.kind === 'LOOP').map((f) => f.key));

function loopError(model, before) {
  const loops = findInconsistencies(model).filter((f) => f.kind === 'LOOP' && !before.has(f.key));
  if (!loops.length) return null;
  const ring = loops[0].positions.map((id) => posRef(model, id));
  const words = ring.map((r) => r.title).join(' → ');
  return new HrmsError(422, 'LOOP', `That would make a reporting loop: ${words} → ${ring[0].title}.`, {
    problems: [`That would make a reporting loop: ${words} → ${ring[0].title}. Choose someone above instead.`],
    detail: { loop: ring },
  });
}

/** A model, with the explicit rows kept so it can be rebuilt. */
async function modelFor(db, companyId) {
  const model = await loadReportingModel(db, companyId, {});
  model.explicitAll = [...model.explicitOf.values()];
  // explicitOf keeps one row per position; rebuilds need every live primary row.
  const [rows] = await db.query(
    `SELECT rr.id, rr.from_position_id, rr.to_position_id, rr.scope_type, rr.cross_tree_reason
       FROM hrms_position_reporting_relationships rr
       JOIN hrms_reporting_relationship_types t ON t.company_id = rr.company_id AND t.id = rr.relationship_type_id
      WHERE rr.company_id = ? AND rr.deleted_at IS NULL AND t.code = 'PRIMARY_MANAGER'
        AND (rr.effective_from IS NULL OR rr.effective_from <= ?) AND (rr.effective_to IS NULL OR rr.effective_to >= ?)
      ORDER BY rr.is_primary DESC, t.sort_order, rr.id`,
    [companyId, model.asOf, model.asOf],
  );
  model.explicitAll = rows.map((e) => ({ id: e.id, fromPositionId: e.from_position_id, toPositionId: e.to_position_id, scopeType: e.scope_type ?? 'GENERAL', crossTreeReason: e.cross_tree_reason ?? null }));
  return model;
}

/* ── facts about one unit (also each row of the Org units list) ─────────── */

/**
 * { heads, headsPerShift, reportsInto: { mode, positionId, reason, effective, text }, positionCount }
 * `shiftById`: Map(id -> { code, name }).
 */
export function unitFacts(model, unitId, shiftById = new Map()) {
  const u = model.units.get(Number(unitId));
  if (!u) return null;
  const heads = model.allHeadsOf(unitId)
    .filter((h) => model.positions.has(h.positionId))
    .map((h) => {
      const p = model.positions.get(h.positionId);
      return {
        positionId: h.positionId,
        shiftId: h.shiftId ?? null,
        shiftCode: h.shiftId != null ? (shiftById.get(h.shiftId)?.code ?? null) : null,
        shiftName: h.shiftId != null ? (shiftById.get(h.shiftId)?.name ?? null) : null,
        code: p.code ?? null,
        title: p.title,
        occupantName: p.occupantName ?? null,
        live: Boolean(p.live),
      };
    });
  const firstHead = heads.find((h) => h.live)?.positionId ?? null;
  const ri = model.reportsIntoFor(unitId, null, firstHead);
  const def = model.defaultReportsInto(unitId, null, firstHead);
  const effective = ri ? posRef(model, ri.positionId) : null;
  const who = (r) => (r ? `${r.title}${r.occupantName ? ` — ${r.occupantName}` : ' (vacant)'}` : null);
  let text;
  if (u.reportsIntoMode === 'CHOSEN' && effective && ri?.chosen) text = `${who(effective)} (chosen)`;
  else if (effective) {
    const from = def?.fromUnitId != null ? model.units.get(def.fromUnitId) : null;
    text = `${who(effective)} (default: ${from ? `the head of ${from.name}` : 'from the units above'})`;
  } else text = u.parentId == null ? 'Nobody: it is at the top' : 'Not set: no unit above it has a head';
  let positionCount = 0;
  for (const p of model.positions.values()) if (p.live && Number(p.departmentId) === Number(unitId)) positionCount += 1;
  return {
    heads,
    headsPerShift: heads.some((h) => h.shiftId != null),
    reportsInto: {
      mode: u.reportsIntoMode,
      positionId: u.reportsIntoMode === 'CHOSEN' ? (u.reportsIntoPositionId ?? null) : null,
      reason: u.reportsIntoReason ?? null,
      effective,
      text,
    },
    positionCount,
  };
}

/** Facts for every unit at once (the Org units list): one model, one shift read. */
export async function allUnitFacts(db, companyId) {
  const [model, shifts] = await Promise.all([loadReportingModel(db, companyId, {}), shiftsOf(db, companyId)]);
  const shiftById = new Map(shifts.map((s) => [s.id, s]));
  const out = new Map();
  for (const id of model.units.keys()) out.set(id, unitFacts(model, id, shiftById));
  return out;
}

/* ── GET / PUT …/departments/:id/reporting ───────────────────────────────── */

function candidatesFor(model, unitId) {
  const chain = model.ancestry(unitId);
  const below = model.subtree(unitId);
  const livePositions = [...model.positions.values()].filter((p) => p.live);
  const inUnit = (id) => livePositions.filter((p) => Number(p.departmentId) === Number(id));
  const order = (list) => list.sort((a, b) => String(a.code ?? '').localeCompare(String(b.code ?? ''), undefined, { numeric: true }) || a.id - b.id);
  const heads = [...order(inUnit(unitId)), ...chain.slice(1).flatMap((u) => order(inUnit(u.id)))].map((p) => posRef(model, p.id));
  const reportsInto = chain.slice(1).map((u, i) => ({
    unitId: u.id, unitName: u.name, unitType: u.type ?? null, distance: i + 1,
    positions: order(inUnit(u.id)).map((p) => posRef(model, p.id)),
  }));
  const aboveIds = new Set(chain.slice(1).map((u) => u.id));
  const elsewhere = order(livePositions.filter((p) => !below.has(Number(p.departmentId)) && !aboveIds.has(Number(p.departmentId)))).map((p) => posRef(model, p.id));
  return { heads, reportsInto, elsewhere };
}

export async function unitReporting(db, companyId, unitId, { model: given = null } = {}) {
  const [model, shifts] = await Promise.all([given ? Promise.resolve(given) : loadReportingModel(db, companyId, {}), shiftsOf(db, companyId)]);
  const u = model.units.get(Number(unitId));
  if (!u) throw notFound('Org unit');
  const shiftById = new Map(shifts.map((s) => [s.id, s]));
  const facts = unitFacts(model, unitId, shiftById);
  const firstHead = facts.heads.find((h) => h.live)?.positionId ?? null;
  const def = model.defaultReportsInto(unitId, null, firstHead);
  const defaultTarget = def ? posRef(model, def.positionId) : null;
  const fromUnit = def?.fromUnitId != null ? model.units.get(def.fromUnitId) : null;
  return {
    unit: { id: u.id, name: u.name, type: u.type ?? null, parentId: u.parentId ?? null },
    heads: facts.heads,
    perShift: facts.headsPerShift,
    reportsInto: {
      mode: u.reportsIntoMode,
      positionId: facts.reportsInto.positionId,
      reason: u.reportsIntoReason ?? null,
      effective: facts.reportsInto.effective,
      defaultTarget,
      defaultText: defaultTarget
        ? `${defaultTarget.title}${defaultTarget.occupantName ? ` — ${defaultTarget.occupantName}` : ' (vacant)'}, ${fromUnit ? `the head of ${fromUnit.name}` : 'from the units above'}`
        : (u.parentId == null ? 'Nobody: a unit at the top reports into nobody unless you choose' : 'Nobody yet: no unit above it has a head'),
    },
    candidates: candidatesFor(model, unitId),
    shifts: shifts.filter((s) => s.status === 'ACTIVE').map((s) => ({ id: s.id, code: s.code, name: s.name })),
  };
}

/** Validates a body against the model; returns { heads, reportsInto } to write, or throws 422 with every problem. */
function readReportingBody(model, unitId, body, shiftIds) {
  const problems = [];
  const u = model.units.get(Number(unitId));
  const chainIds = new Set(model.ancestry(unitId).map((x) => x.id));
  const below = model.subtree(unitId);
  let heads;
  if (body.heads !== undefined) {
    if (!Array.isArray(body.heads)) problems.push('Heads must be a list.');
    else {
      heads = [];
      const shiftsSeen = new Set();
      for (const h of body.heads) {
        const positionId = Number(h?.positionId);
        const shiftId = h?.shiftId == null || h.shiftId === '' ? null : Number(h.shiftId);
        const p = model.positions.get(positionId);
        if (!Number.isInteger(positionId) || !p) { problems.push('A head must be a position of this company.'); continue; }
        if (!p.live) { problems.push(`${p.title} is closed or not in date, so it cannot head a unit.`); continue; }
        if (p.departmentId == null || !chainIds.has(Number(p.departmentId))) {
          problems.push(`${p.title}${p.code ? ` (${p.code})` : ''} is not in ${u.name} or a unit above it. Choose a position of this unit (or of a unit above, to head several).`);
          continue;
        }
        if (shiftId != null && !shiftIds.has(shiftId)) { problems.push('That shift does not exist in this company.'); continue; }
        const key = shiftId ?? 0;
        if (shiftsSeen.has(key)) { problems.push(shiftId == null ? 'A unit has one head unless it has a head per shift.' : 'Two heads on the same shift: choose one.'); continue; }
        shiftsSeen.add(key);
        heads.push({ positionId, shiftId });
      }
      if (heads.some((h) => h.shiftId == null) && heads.some((h) => h.shiftId != null)) {
        problems.push('Either one head for the unit, or a head per shift — not both.');
      }
    }
  }
  let reportsInto;
  if (body.reportsInto !== undefined && body.reportsInto !== null) {
    const r = body.reportsInto;
    if (r.mode === 'DEFAULT') reportsInto = { mode: 'DEFAULT', positionId: null, reason: null };
    else if (r.mode === 'CHOSEN') {
      const positionId = Number(r.positionId);
      const p = model.positions.get(positionId);
      const reason = clean(r.reason);
      if (!Number.isInteger(positionId) || !p) problems.push('Choose the position this unit reports into.');
      else if (!p.live) problems.push(`${p.title} is closed or not in date.`);
      else if (p.departmentId != null && below.has(Number(p.departmentId))) {
        throw new HrmsError(422, 'LOOP', `${p.title} is in ${u.name} or under it, so ${u.name} cannot report into it.`, {
          problems: [`${p.title} is in ${u.name} or under it, so ${u.name} cannot report into it: that would be a loop. Choose a position above.`],
        });
      } else if (!model.inTreeAbove(unitId, positionId) && !reason) {
        throw new HrmsError(422, 'REASON_NEEDED', `${p.title} is not in the unit above ${u.name} or higher up. Say why ${u.name} reports there.`, {
          problems: [`${p.title} is outside the units above ${u.name}. A Reports into elsewhere needs a reason.`],
        });
      }
      if (p) reportsInto = { mode: 'CHOSEN', positionId, reason };
    } else problems.push('Reports into is the default, or a chosen position.');
  }
  if (problems.length) throw invalid('VALIDATION', problems[0], { problems });
  return { heads, reportsInto };
}

export async function setUnitReporting(db, c, unitId, body = {}) {
  const model = await modelFor(db, c.companyId);
  const u = model.units.get(Number(unitId));
  if (!u) throw notFound('Org unit');
  const shifts = await shiftsOf(db, c.companyId);
  const { heads, reportsInto } = readReportingBody(model, unitId, body, new Set(shifts.map((s) => s.id)));
  const before = loopKeys(model);

  // What it would be — refuse a loop before writing anything.
  const headRows = [...model.units.keys()].flatMap((id) => (Number(id) === Number(unitId) && heads
    ? heads.map((h, i) => ({ id: -1 - i, unitId: Number(unitId), positionId: h.positionId, shiftId: h.shiftId }))
    : model.allHeadsOf(id)));
  const after = rebuild(model, {
    heads: headRows,
    units: reportsInto ? { [unitId]: { reportsIntoMode: reportsInto.mode, reportsIntoPositionId: reportsInto.positionId, reportsIntoReason: reportsInto.reason } } : null,
  });
  const err = loopError(after, before);
  if (err) throw err;

  if (heads) {
    const [live] = await db.query('SELECT id, position_id, shift_id FROM hrms_unit_heads WHERE company_id = ? AND department_id = ? AND deleted_at IS NULL FOR UPDATE', [c.companyId, unitId]);
    const want = new Set(heads.map((h) => `${h.positionId}:${h.shiftId ?? 0}`));
    const have = new Set(live.map((h) => `${h.position_id}:${h.shift_id ?? 0}`));
    const gone = live.filter((h) => !want.has(`${h.position_id}:${h.shift_id ?? 0}`));
    if (gone.length) await db.query('UPDATE hrms_unit_heads SET deleted_at = NOW() WHERE company_id = ? AND id IN (?)', [c.companyId, gone.map((h) => h.id)]);
    for (const h of heads) {
      if (have.has(`${h.positionId}:${h.shiftId ?? 0}`)) continue;
      // eslint-disable-next-line no-await-in-loop -- a unit has a handful of heads at most
      await db.query('INSERT INTO hrms_unit_heads (company_id, department_id, position_id, shift_id, created_by) VALUES (?, ?, ?, ?, ?)', [c.companyId, unitId, h.positionId, h.shiftId, c.userId]);
    }
    if (gone.length || heads.some((h) => !have.has(`${h.positionId}:${h.shiftId ?? 0}`))) {
      await audit(db, c, 'hrms_unit_heads', Number(unitId), 'UPDATE',
        { heads: live.map((h) => ({ positionId: h.position_id, shiftId: h.shift_id })) }, { heads });
    }
  }
  if (reportsInto) {
    const changed = reportsInto.mode !== u.reportsIntoMode || (reportsInto.positionId ?? null) !== (u.reportsIntoPositionId ?? null)
      || (reportsInto.reason ?? null) !== (u.reportsIntoReason ?? null);
    if (changed) {
      await db.query('UPDATE hrms_departments SET reports_into_mode = ?, reports_into_position_id = ?, reports_into_reason = ? WHERE company_id = ? AND id = ?',
        [reportsInto.mode, reportsInto.positionId, reportsInto.reason, c.companyId, unitId]);
      await audit(db, c, 'hrms_departments', Number(unitId), 'UPDATE',
        { reportsInto: { mode: u.reportsIntoMode, positionId: u.reportsIntoPositionId, reason: u.reportsIntoReason } },
        { reportsInto });
    }
  }
  return unitReporting(db, c.companyId, unitId);
}

/* ── moving a unit (§40.4) ───────────────────────────────────────────────── */

/**
 * What a move does to a unit's Reports into, for move-check:
 *   { mode, current: PosRef|null, afterMove: PosRef|null, ask, sentence }
 * DEFAULT re-points by itself (afterMove = the new parent's head, or further up); CHOSEN asks keep or switch.
 */
export async function moveReportsInto(db, companyId, unitId, parentId) {
  const model = await loadReportingModel(db, companyId, {});
  const u = model.units.get(Number(unitId));
  if (!u) return null;
  const firstHead = model.headsOf(unitId)[0]?.positionId ?? null;
  const now = model.reportsIntoFor(unitId, null, firstHead);
  const moved = rebuild({ ...model, explicitAll: [...model.explicitOf.values()] }, {
    units: { [unitId]: { parentId: parentId ?? null, reportsIntoMode: 'DEFAULT', reportsIntoPositionId: null, reportsIntoReason: null } },
  });
  const def = moved.defaultReportsInto(unitId, null, firstHead);
  const current = now ? posRef(model, now.positionId) : null;
  const afterMove = def ? posRef(model, def.positionId) : null;
  const ask = u.reportsIntoMode === 'CHOSEN' && u.reportsIntoPositionId != null;
  const name = (r) => (r ? `${r.title}${r.occupantName ? ` (${r.occupantName})` : ''}` : 'nobody');
  let sentence;
  if (ask) sentence = `It reports into ${name(current)} by choice: keep that, or switch to the new parent's head (${name(afterMove)})?`;
  else if (afterMove) sentence = `Its Reports into follows: ${name(afterMove)}${def?.fromUnitId != null ? `, the head of ${model.units.get(def.fromUnitId)?.name ?? 'the new parent'}` : ''}.`;
  else sentence = 'It will report into nobody until a unit above it has a head.';
  return { mode: u.reportsIntoMode, current, afterMove, ask, sentence };
}

/** Called by updateDepartment after a move: SWITCH -> back to the default. Returns the before/after for the audit. */
export async function applyMoveChoice(db, c, unitId, choice) {
  if (choice !== 'SWITCH') return null;
  const [[u]] = await db.query('SELECT reports_into_mode, reports_into_position_id, reports_into_reason FROM hrms_departments WHERE company_id = ? AND id = ?', [c.companyId, unitId]);
  if (!u || u.reports_into_mode !== 'CHOSEN') return null;
  await db.query("UPDATE hrms_departments SET reports_into_mode = 'DEFAULT', reports_into_position_id = NULL, reports_into_reason = NULL WHERE company_id = ? AND id = ?", [c.companyId, unitId]);
  return { before: { mode: 'CHOSEN', positionId: u.reports_into_position_id, reason: u.reports_into_reason }, after: { mode: 'DEFAULT' } };
}

/** After a write that changed the tree: refuse it if it made a new loop (the caller's transaction rolls back). */
export async function assertNoNewLoop(db, companyId, beforeKeys) {
  const model = await loadReportingModel(db, companyId, {});
  const err = loopError(model, beforeKeys);
  if (err) throw err;
}
export async function currentLoopKeys(db, companyId) {
  return loopKeys(await loadReportingModel(db, companyId, {}));
}

/* ── the consistency check (§40.5) ───────────────────────────────────────── */

const ref = (model, id, shiftById) => posRef(model, id, shiftById ? new Map([...shiftById].map(([k, v]) => [k, v.code])) : null);

function inTreeCandidates(model, positionId, shiftById) {
  const p = model.positions.get(Number(positionId));
  if (!p || p.departmentId == null) return [];
  const units = model.ancestry(p.departmentId).map((u) => u.id);
  const out = [];
  for (const uid of units) {
    for (const q of model.positions.values()) {
      if (!q.live || q.id === p.id || Number(q.departmentId) !== uid) continue;
      out.push(ref(model, q.id, shiftById));
    }
  }
  return out;
}

function headCandidates(model, unitId, shiftById) {
  const units = model.ancestry(unitId).map((u) => u.id);
  const out = [];
  for (const uid of units) for (const q of model.positions.values()) if (q.live && Number(q.departmentId) === uid) out.push(ref(model, q.id, shiftById));
  return out;
}

function aboveCandidates(model, unitId, shiftById) {
  const units = model.ancestry(unitId).slice(1).map((u) => u.id);
  const out = [];
  for (const uid of units) for (const q of model.positions.values()) if (q.live && Number(q.departmentId) === uid) out.push(ref(model, q.id, shiftById));
  return out;
}

const unitShort = (u) => (u ? { id: u.id, name: u.name, type: u.type ?? null } : null);
const fix = (action, label, extra = {}) => ({ action, label, hint: null, needsReason: false, needsPosition: false, candidates: [], target: null, ...extra });

/** Words and fixes for every finding. */
function describe(model, findings, shiftById) {
  const named = (r) => (r ? `${r.title}${r.code ? ` (${r.code})` : ''}` : 'nobody');
  return findings.map((f) => {
    const base = { key: f.key, kind: f.kind, sentence: '', unit: null, position: null, manager: null, loop: null, fixes: [] };
    if (f.kind === 'CROSS_TREE' && f.edgeId != null) {
      const p = ref(model, f.positionId, shiftById);
      const m = ref(model, f.managerId, shiftById);
      const without = rebuild(model, { dropExplicit: new Set([Number(f.edgeId)]) }).step(f.positionId);
      const target = without ? ref(model, without.managerId, shiftById) : null;
      const fixes = [];
      if (target) fixes.push(fix('USE_DEFAULT', `Use the default: ${named(target)}`, { target, edgeId: f.edgeId, hint: 'Ends this line; the position then reports as its org unit says.' }));
      fixes.push(fix('CHOOSE', 'Choose from its unit and the units above', { needsPosition: true, candidates: inTreeCandidates(model, f.positionId, shiftById), edgeId: f.edgeId }));
      fixes.push(fix('MARK_INTENDED', 'It is meant: say why', { needsReason: true, edgeId: f.edgeId }));
      return { ...base, unit: unitShort(model.units.get(Number(model.positions.get(f.positionId)?.departmentId))), position: p, manager: m,
        sentence: `${named(p)} in ${p.unitName ?? 'no org unit'} reports to ${named(m)} in ${m.unitName ?? 'no org unit'}, which is outside its unit and the units above it.`, fixes };
    }
    if (f.kind === 'CROSS_TREE') {
      const u = model.units.get(f.unitId);
      const m = ref(model, f.managerId, shiftById);
      const firstHead = model.headsOf(f.unitId)[0]?.positionId ?? null;
      const def = model.defaultReportsInto(f.unitId, null, firstHead);
      const target = def ? ref(model, def.positionId, shiftById) : null;
      const fixes = [];
      if (target) fixes.push(fix('USE_DEFAULT', `Use the default: ${named(target)}`, { target, unitId: u.id }));
      fixes.push(fix('CHOOSE', 'Choose from the units above', { needsPosition: true, candidates: aboveCandidates(model, f.unitId, shiftById), unitId: u.id }));
      fixes.push(fix('MARK_INTENDED', 'It is meant: say why', { needsReason: true, unitId: u.id }));
      return { ...base, unit: unitShort(u), manager: m, sentence: `${u.name} reports into ${named(m)} in ${m.unitName ?? 'no org unit'}, which is not above it, and no reason is given.`, fixes };
    }
    if (f.kind === 'UNIT_NO_HEAD') {
      const u = model.units.get(f.unitId);
      const fixes = [fix('SET_HEAD', 'Choose its head', { needsPosition: true, candidates: headCandidates(model, f.unitId, shiftById), unitId: u.id })];
      const above = aboveCandidates(model, f.unitId, shiftById);
      if (above.length) fixes.push(fix('CHOOSE', 'Choose what it reports into', { needsPosition: true, candidates: above, unitId: u.id }));
      return { ...base, unit: unitShort(u), sentence: `${u.name}${u.type ? ` (${u.type})` : ''} has no head and nothing to report into, so its people have no manager from the tree.`, fixes };
    }
    if (f.kind === 'NO_MANAGER') {
      const p = ref(model, f.positionId, shiftById);
      const pos = model.positions.get(f.positionId);
      const u = pos?.departmentId != null ? model.units.get(Number(pos.departmentId)) : null;
      const fixes = [];
      const cands = inTreeCandidates(model, f.positionId, shiftById);
      if (cands.length) fixes.push(fix('CHOOSE', 'Choose who it reports to', { needsPosition: true, candidates: cands }));
      if (u && u.parentId == null && !model.headsOf(u.id).length) fixes.push(fix('MAKE_HEAD', `Make it the head of ${u.name} (the top)`, { unitId: u.id, target: p }));
      else if (u && !model.headsOf(u.id).length) fixes.push(fix('SET_HEAD', `Choose the head of ${u.name}`, { needsPosition: true, candidates: headCandidates(model, u.id, shiftById), unitId: u.id }));
      return { ...base, unit: unitShort(u), position: p, sentence: `${named(p)}${u ? ` in ${u.name}` : ''} has no manager: no line of its own, ${u ? 'and its unit gives it nobody' : 'and it is in no org unit'}.`, fixes };
    }
    // LOOP
    const ring = f.positions.map((id) => ref(model, id, shiftById));
    const fixes = [];
    for (const s of f.steps) {
      if (s.source === 'EXPLICIT' && s.edgeId != null) {
        const from = ref(model, s.positionId, shiftById);
        fixes.push(fix('USE_DEFAULT', `End ${from.title}'s own line to ${ref(model, s.managerId, shiftById).title}`, { edgeId: s.edgeId, hint: 'The position then reports as its org unit says.' }));
      } else if (s.source === 'REPORTS_INTO' && s.chosen) {
        const u = model.units.get(Number(s.settingUnitId ?? s.unitId));
        if (u) fixes.push(fix('USE_DEFAULT', `${u.name}: back to the default Reports into`, { unitId: u.id }));
      }
    }
    return { ...base, loop: ring, sentence: `A reporting loop: ${ring.map((r) => r.title).join(' → ')} → ${ring[0].title}.`, fixes };
  });
}

export async function consistency(db, companyId, { model: given = null } = {}) {
  const [model, shifts] = await Promise.all([given ? Promise.resolve(given) : modelFor(db, companyId), shiftsOf(db, companyId)]);
  if (!model.explicitAll) model.explicitAll = [...model.explicitOf.values()];
  const shiftById = new Map(shifts.map((s) => [s.id, s]));
  const raw = findInconsistencies(model);
  const order = { LOOP: 0, CROSS_TREE: 1, NO_MANAGER: 2, UNIT_NO_HEAD: 3 };
  raw.sort((a, b) => order[a.kind] - order[b.kind] || a.key.localeCompare(b.key, undefined, { numeric: true }));
  const findings = describe(model, raw, shiftById);
  const count = (k) => findings.filter((f) => f.kind === k).length;
  return {
    asOf: model.asOf,
    counts: { total: findings.length, crossTree: count('CROSS_TREE'), unitNoHead: count('UNIT_NO_HEAD'), noManager: count('NO_MANAGER'), loops: count('LOOP') },
    findings,
  };
}

/** Which right a fix needs: 'positions' for a position's own line, 'org' for a unit's head / Reports into. */
export function fixNeeds(body = {}) {
  const key = String(body.key ?? '');
  if (key.startsWith('CROSS_TREE:E:') || (key.startsWith('NO_MANAGER:') && body.action === 'CHOOSE') || (key.startsWith('LOOP:') && body.edgeId != null)) return 'positions';
  return 'org';
}

export async function fixConsistency(db, c, body = {}) {
  const key = String(body.key ?? '');
  const action = String(body.action ?? '');
  const model = await modelFor(db, c.companyId);
  const report = await consistency(db, c.companyId, { model });
  const finding = report.findings.find((f) => f.key === key);
  if (!finding) throw conflict('STALE', 'That is already fixed, or has changed. The list has been read again.', { consistency: report });
  const options = finding.fixes.filter((f) => f.action === action
    && (body.edgeId == null || Number(f.edgeId) === Number(body.edgeId))
    && (body.unitId == null || Number(f.unitId) === Number(body.unitId)));
  const chosen = options[0];
  if (!chosen) throw invalid('VALIDATION', 'That is not one of the fixes offered for this.', { problems: ['That is not one of the fixes offered for this.'] });
  const reason = clean(body.reason);
  const positionId = body.positionId == null ? null : Number(body.positionId);
  if (chosen.needsReason && !reason) throw invalid('VALIDATION', 'Say why it is meant.', { problems: ['Say why it is meant.'] });
  if (chosen.needsPosition && !chosen.candidates.some((x) => x.positionId === positionId)) {
    throw invalid('VALIDATION', 'Choose one of the positions offered.', { problems: ['Choose one of the positions offered.'] });
  }
  const before = loopKeys(model);
  const todayIso = today();

  const endLine = async (edgeId) => {
    const [[row]] = await db.query('SELECT * FROM hrms_position_reporting_relationships WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [c.companyId, edgeId]);
    if (!row) throw conflict('STALE', 'That line has already changed.', {});
    if (dateText(row.effective_from) && dateText(row.effective_from) >= todayIso) await removePositionReporting(db, c, edgeId);
    else await endPositionReporting(db, c, edgeId, { effectiveTo: previousDay(todayIso) });
    await audit(db, c, 'hrms_position_reporting_relationships', edgeId, 'UPDATE', { toPositionId: row.to_position_id }, { endedBy: 'CONSISTENCY_FIX', key });
    return row;
  };
  const primaryTypeId = async () => {
    const [[t]] = await db.query("SELECT id FROM hrms_reporting_relationship_types WHERE company_id = ? AND code = 'PRIMARY_MANAGER' AND deleted_at IS NULL ORDER BY id LIMIT 1", [c.companyId]);
    return t?.id ?? null;
  };

  if (finding.kind === 'CROSS_TREE' && chosen.edgeId != null) {
    if (action === 'USE_DEFAULT') await endLine(chosen.edgeId);
    else if (action === 'CHOOSE') {
      await addPositionReporting(db, c, finding.position.positionId, { toPositionId: positionId, relationshipTypeId: await primaryTypeId(), replacesId: chosen.edgeId, effectiveFrom: todayIso, isPrimary: true });
      await audit(db, c, 'hrms_position_reporting_relationships', chosen.edgeId, 'UPDATE', { toPositionId: finding.manager?.positionId }, { toPositionId: positionId, by: 'CONSISTENCY_FIX', key });
    } else if (action === 'MARK_INTENDED') {
      await db.query('UPDATE hrms_position_reporting_relationships SET cross_tree_reason = ? WHERE company_id = ? AND id = ?', [reason, c.companyId, chosen.edgeId]);
      await audit(db, c, 'hrms_position_reporting_relationships', chosen.edgeId, 'UPDATE', { crossTreeReason: null }, { crossTreeReason: reason, key });
    }
  } else if (finding.kind === 'CROSS_TREE') {
    const unitId = chosen.unitId;
    if (action === 'USE_DEFAULT') await setUnitReporting(db, c, unitId, { reportsInto: { mode: 'DEFAULT' } });
    else if (action === 'CHOOSE') await setUnitReporting(db, c, unitId, { reportsInto: { mode: 'CHOSEN', positionId } });
    else if (action === 'MARK_INTENDED') {
      await db.query('UPDATE hrms_departments SET reports_into_reason = ? WHERE company_id = ? AND id = ?', [reason, c.companyId, unitId]);
      await audit(db, c, 'hrms_departments', unitId, 'UPDATE', { reportsIntoReason: null }, { reportsIntoReason: reason, key });
    }
  } else if (finding.kind === 'UNIT_NO_HEAD') {
    if (action === 'SET_HEAD') await setUnitReporting(db, c, chosen.unitId, { heads: [{ positionId, shiftId: null }] });
    else if (action === 'CHOOSE') await setUnitReporting(db, c, chosen.unitId, { reportsInto: { mode: 'CHOSEN', positionId } });
  } else if (finding.kind === 'NO_MANAGER') {
    if (action === 'CHOOSE') {
      await addPositionReporting(db, c, finding.position.positionId, { toPositionId: positionId, relationshipTypeId: await primaryTypeId(), effectiveFrom: todayIso, isPrimary: true });
      await audit(db, c, 'hrms_positions', finding.position.positionId, 'UPDATE', null, { reportsTo: positionId, by: 'CONSISTENCY_FIX', key });
    } else if (action === 'MAKE_HEAD') await setUnitReporting(db, c, chosen.unitId, { heads: [{ positionId: finding.position.positionId, shiftId: null }] });
    else if (action === 'SET_HEAD') await setUnitReporting(db, c, chosen.unitId, { heads: [{ positionId, shiftId: null }] });
  } else if (finding.kind === 'LOOP') {
    if (chosen.edgeId != null) await endLine(chosen.edgeId);
    else if (chosen.unitId != null) await setUnitReporting(db, c, chosen.unitId, { reportsInto: { mode: 'DEFAULT' } });
  }

  // Never trade one problem for a loop.
  const afterModel = await loadReportingModel(db, c.companyId, {});
  before.delete(key);
  const err = loopError(afterModel, before);
  if (err) throw err;
  return { ok: true, fixed: key, consistency: await consistency(db, c.companyId) };
}

export default { unitFacts, allUnitFacts, unitReporting, setUnitReporting, moveReportsInto, applyMoveChoice, consistency, fixConsistency, fixNeeds, assertNoNewLoop, currentLoopKeys };
