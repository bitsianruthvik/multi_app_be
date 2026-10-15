/**
 * jobHistoryService.js — the dated list of changes to a job (spec §16.3).
 *
 *   GET /roles/:id/job-content/history
 *   GET /positions/:id/job-content/history
 *   GET /employees/:id/job-content/history
 *
 * NOTHING HERE IS A SECOND RECORD. Job content is never overwritten (§16.1):
 * every version of every line is still a row with its window, its opener
 * (created_by) and its closer (ended_by). History is READ from those rows —
 * the same rows the resolver reads for any date — so the list and the job "as
 * on" a day cannot tell two stories. Each item:
 *
 *   { on, layer: 'ROLE'|'POSITION'|'PERSON', kind: 'KRA'|'RESPONSIBILITY'|'KPI'|'POSITION',
 *     what, line, from, to, by, reason, lineKey, coming }
 *
 *   what (a line)      ADDED · REWORDED · TARGET_CHANGED · CHANGED (weight, the KRA it
 *                      is under) · SWITCHED_OFF · RESTORED (back to what the layer above
 *                      says) · REMOVED
 *   what (a position)  CREATED · ROLE_CHANGED · DEPARTMENT_CHANGED · SHIFT_CHANGED ·
 *                      PLACE_CHANGED · TITLE_CHANGED · REPORTS_TO · STOPPED_REPORTING_TO
 *   what (a person)    STARTED_IN · LEFT_POSITION   (the positions they held)
 *
 * `on` is the first day the change applies (null = from the start); `coming` is
 * true for a change dated ahead. Newest first.
 */
import { notFound } from '../lib/errors.js';
import { targetText } from './contentResolver.js';
import { dateText, today, requirePosition } from './positionService.js';
import { dayAfter } from './datedChange.js';

const DEF = {
  KRA: { table: 'hrms_kra_definitions', column: 'kra_definition_id' },
  RESPONSIBILITY: { table: 'hrms_responsibility_definitions', column: 'responsibility_definition_id' },
  KPI: { table: 'hrms_kpi_definitions', column: 'kpi_definition_id' },
};
const ROLE_TABLE = { KRA: 'hrms_role_kra_assignments', RESPONSIBILITY: 'hrms_role_responsibility_assignments', KPI: 'hrms_role_kpi_assignments' };

const readJson = (v) => {
  if (v == null || typeof v === 'object') return v ?? null;
  try { return JSON.parse(v); } catch { return v; }
};
/** A definition's whole sentence (a long one is cut short in `name`, whole in `description`). */
const wording = (name, description) => {
  const n = String(name ?? '').trim();
  const d = String(description ?? '').trim();
  if (d && /(\.\.\.|…)$/.test(n) && d.toLowerCase().startsWith(n.replace(/(\.\.\.|…)$/, '').trim().toLowerCase())) return d;
  return n;
};
const isVoid = (r) => r.from && r.to && r.to < r.from;

/* ══════════════════════════════════════════════════════════════════════════
 * The role layer — one line = the versions sharing a line_key
 * ══════════════════════════════════════════════════════════════════════════ */

async function roleRows(db, companyId, roleIds) {
  if (!roleIds.length) return [];
  const out = [];
  for (const kind of ['KRA', 'RESPONSIBILITY', 'KPI']) {
    const kpi = kind === 'KPI';
    const [rows] = await db.query(
      `SELECT a.id, a.role_id, a.line_key, a.effective_from, a.effective_to, a.created_by, a.ended_by,
              a.change_reason, a.${DEF[kind].column} AS definition_id, d.name, d.description,
              ${kind === 'RESPONSIBILITY' ? 'NULL' : 'a.weight_percent'} AS weight_percent,
              ${kind === 'KRA' ? 'NULL' : 'a.role_kra_assignment_id'} AS group_id,
              ${kpi ? 'a.target_operator, CAST(a.target_value AS CHAR) AS target_value, d.measurement_type, d.unit' : 'NULL AS target_operator, NULL AS target_value, NULL AS measurement_type, NULL AS unit'}
         FROM ${ROLE_TABLE[kind]} a
         JOIN ${DEF[kind].table} d ON d.company_id = a.company_id AND d.id = a.${DEF[kind].column}
        WHERE a.company_id = ? AND a.role_id IN (?) AND (a.deleted_at IS NULL OR a.effective_to IS NOT NULL)`,
      [companyId, roleIds],
    );
    for (const r of rows) {
      out.push({
        ...r,
        kind,
        from: dateText(r.effective_from),
        to: dateText(r.effective_to),
        key: r.line_key ?? `${kind}#${r.id}`,
        text: wording(r.name, r.description),
        target: kpi ? targetText(r.target_operator, readJson(r.target_value), r.measurement_type, r.unit) : null,
      });
    }
  }
  return out.filter((r) => !isVoid(r));
}

function roleEvents(rows, kraNames) {
  const events = [];
  const byLine = new Map();
  for (const r of rows) {
    if (!byLine.has(r.key)) byLine.set(r.key, []);
    byLine.get(r.key).push(r);
  }
  for (const versions of byLine.values()) {
    versions.sort((a, b) => (a.from ?? '').localeCompare(b.from ?? '') || a.id - b.id);
    versions.forEach((v, i) => {
      const prev = versions[i - 1] ?? null;
      const base = { layer: 'ROLE', kind: v.kind, line: v.text, lineKey: v.line_key ?? null, reason: v.change_reason ?? null };
      if (!prev) {
        events.push({ ...base, on: v.from, what: 'ADDED', from: null, to: v.target, by: v.created_by });
      } else if (prev.to && dayAfter(prev.to) === v.from) {
        if (Number(prev.definition_id) !== Number(v.definition_id)) {
          events.push({ ...base, on: v.from, what: 'REWORDED', from: prev.text, to: v.text, by: v.created_by });
        } else if (v.kind === 'KPI' && prev.target !== v.target) {
          events.push({ ...base, on: v.from, what: 'TARGET_CHANGED', from: prev.target, to: v.target, by: v.created_by });
        } else if (Number(prev.weight_percent ?? -1) !== Number(v.weight_percent ?? -1)) {
          events.push({ ...base, on: v.from, what: 'CHANGED', from: prev.weight_percent == null ? 'no weight' : `weight ${Number(prev.weight_percent)}%`, to: v.weight_percent == null ? 'no weight' : `weight ${Number(v.weight_percent)}%`, by: v.created_by });
        } else if (Number(prev.group_id ?? 0) !== Number(v.group_id ?? 0)) {
          const name = (id) => (id == null ? 'not under a KRA' : `under ${kraNames.get(Number(id)) ?? 'a KRA'}`);
          events.push({ ...base, on: v.from, what: 'CHANGED', from: name(prev.group_id), to: name(v.group_id), by: v.created_by });
        }
      } else {
        // A gap: it was removed, and later carried again.
        events.push({ ...base, on: v.from, what: 'RESTORED', from: null, to: v.target, by: v.created_by });
      }
      const next = versions[i + 1] ?? null;
      if (v.to && !(next && next.from === dayAfter(v.to))) {
        events.push({ ...base, on: dayAfter(v.to), what: 'REMOVED', from: v.text, to: null, by: v.ended_by, reason: null });
      }
    });
  }
  return events;
}

/* ══════════════════════════════════════════════════════════════════════════
 * A position's or a person's changes — the overlay rows of one owner
 * ══════════════════════════════════════════════════════════════════════════ */

const OVERLAY = {
  POSITION: { table: 'hrms_position_content_overrides', owner: 'position_id' },
  PERSON: { table: 'hrms_work_assignment_content_overrides', owner: 'work_assignment_id' },
};

async function overlayRows(db, companyId, layer, ownerIds) {
  if (!ownerIds.length) return [];
  const { table, owner } = OVERLAY[layer];
  const [rows] = await db.query(
    `SELECT o.id, o.${owner} AS owner_id, o.content_type, o.action, o.override_json, o.reason, o.line_key,
            o.effective_from, o.effective_to, o.created_by, o.ended_by,
            o.kra_definition_id, o.responsibility_definition_id, o.kpi_definition_id,
            COALESCE(k.name, rs.name, kp.name) AS name, COALESCE(k.description, rs.description, kp.description) AS description,
            kp.measurement_type, kp.unit
       FROM ${table} o
       LEFT JOIN hrms_kra_definitions k ON k.company_id = o.company_id AND k.id = o.kra_definition_id
       LEFT JOIN hrms_responsibility_definitions rs ON rs.company_id = o.company_id AND rs.id = o.responsibility_definition_id
       LEFT JOIN hrms_kpi_definitions kp ON kp.company_id = o.company_id AND kp.id = o.kpi_definition_id
      WHERE o.company_id = ? AND o.${owner} IN (?) AND o.deleted_at IS NULL`,
    [companyId, ownerIds],
  );
  return rows.map((r) => {
    const json = readJson(r.override_json) ?? {};
    const defId = r.kra_definition_id ?? r.responsibility_definition_id ?? r.kpi_definition_id;
    return {
      ...r,
      json,
      defId: Number(defId),
      kind: r.content_type,
      from: dateText(r.effective_from),
      to: dateText(r.effective_to),
      key: r.line_key ?? `${r.content_type}:${defId}`,
      text: wording(r.name, r.description),
      target: r.content_type === 'KPI' && (json.targetOperator !== undefined || json.targetValue !== undefined)
        ? targetText(json.targetOperator ?? null, json.targetValue ?? null, r.measurement_type, r.unit)
        : null,
    };
  }).filter((r) => !isVoid(r));
}

function overlayEvents(rows, layer) {
  const events = [];
  const byLine = new Map();
  for (const r of rows) {
    const g = `${r.owner_id}|${r.key}`;
    if (!byLine.has(g)) byLine.set(g, []);
    byLine.get(g).push(r);
  }
  for (const group of byLine.values()) {
    const starts = [...new Set(group.map((r) => r.from ?? ''))].sort();
    for (const s of starts) {
      const on = s || null;
      const starting = group.filter((r) => (r.from ?? '') === s);
      const before = on ? group.filter((r) => r.to && dayAfter(r.to) === on) : [];
      const add = starting.find((r) => r.action === 'ADD');
      const suppress = starting.find((r) => r.action === 'SUPPRESS');
      const override = starting.find((r) => r.action === 'OVERRIDE');
      const base = { layer, kind: (add ?? suppress ?? override).kind, lineKey: (add ?? suppress ?? override).line_key ?? null };
      const by = (add ?? suppress ?? override).created_by;
      const reason = (add ?? suppress ?? override).reason ?? null;
      const prevAdd = before.find((r) => r.action === 'ADD');
      const prevOverride = before.find((r) => r.action === 'OVERRIDE');
      if (add && (add.json.replacesDefinitionId || suppress)) {
        const was = suppress?.text ?? prevAdd?.text ?? before.find((r) => r.action === 'SUPPRESS')?.text ?? null;
        events.push({ ...base, on, what: 'REWORDED', line: add.text, from: was, to: add.text, by, reason });
      } else if (add && prevAdd) {
        if (prevAdd.defId !== add.defId) events.push({ ...base, on, what: 'REWORDED', line: add.text, from: prevAdd.text, to: add.text, by, reason });
        else if (prevAdd.target !== add.target) events.push({ ...base, on, what: 'TARGET_CHANGED', line: add.text, from: prevAdd.target, to: add.target, by, reason });
      } else if (add) {
        events.push({ ...base, on, what: 'ADDED', line: add.text, from: null, to: add.target, by, reason });
      } else if (override) {
        events.push({ ...base, on, what: 'TARGET_CHANGED', line: override.text, from: prevOverride?.target ?? null, to: override.target, by, reason });
      } else if (suppress) {
        events.push({ ...base, on, what: 'SWITCHED_OFF', line: suppress.text, from: null, to: null, by, reason });
      }
    }
    // Ends with nothing starting the next day: the line went back, or (its own) went.
    const ends = [...new Set(group.filter((r) => r.to).map((r) => dayAfter(r.to)))].sort();
    for (const e of ends) {
      if (group.some((r) => r.from === e)) continue;
      const ending = group.filter((r) => r.to && dayAfter(r.to) === e);
      const own = ending.find((r) => r.action === 'ADD' && !r.json.replacesDefinitionId);
      const any = own ?? ending[0];
      events.push({
        layer, kind: any.kind, lineKey: any.line_key ?? null, on: e,
        what: own ? 'REMOVED' : 'RESTORED',
        line: any.text, from: own ? own.text : null, to: null, by: any.ended_by, reason: null,
      });
    }
  }
  return events;
}

/* ══════════════════════════════════════════════════════════════════════════
 * Position facts and positions held
 * ══════════════════════════════════════════════════════════════════════════ */

const FIELD_WHAT = {
  roleId: ['ROLE_CHANGED', 'hrms_roles', 'title'],
  departmentId: ['DEPARTMENT_CHANGED', 'hrms_departments', 'name'],
  defaultShiftId: ['SHIFT_CHANGED', 'hrms_shifts', 'name'],
  locationId: ['PLACE_CHANGED', 'hrms_locations', 'name'],
  positionTitle: ['TITLE_CHANGED', null, null],
};

async function positionFacts(db, companyId, position) {
  const events = [{
    layer: 'POSITION', kind: 'POSITION', on: dateText(position.effective_from) ?? dateText(position.created_at),
    what: 'CREATED', line: position.position_code ?? null, from: null, to: null, by: position.created_by ?? null, reason: null, lineKey: null,
  }];
  const [audits] = await db.query(
    `SELECT before_json, after_json, actor_user_id, occurred_at FROM hrms_audit_log
      WHERE company_id = ? AND entity_type = 'hrms_positions' AND entity_id = ? AND action = 'UPDATE'
      ORDER BY occurred_at, id`,
    [companyId, position.id],
  );
  const names = new Map();
  const nameOf = async (table, column, id) => {
    if (id == null) return null;
    const k = `${table}:${id}`;
    if (!names.has(k)) {
      const [[r]] = await db.query(`SELECT ${column} AS n FROM ${table} WHERE company_id = ? AND id = ?`, [companyId, id]);
      names.set(k, r?.n ?? null);
    }
    return names.get(k);
  };
  for (const a of audits) {
    const before = readJson(a.before_json) ?? {};
    const after = readJson(a.after_json) ?? {};
    for (const [field, [what, table, column]] of Object.entries(FIELD_WHAT)) {
      if (!(field in after) || !(field in before)) continue;
      const from = table ? await nameOf(table, column, before[field]) : before[field];
      const to = table ? await nameOf(table, column, after[field]) : after[field];
      events.push({
        layer: 'POSITION', kind: 'POSITION', on: after.on ?? dateText(a.occurred_at), what, line: null,
        from: from ?? null, to: to ?? null, by: a.actor_user_id ?? null, reason: null, lineKey: null,
      });
    }
  }
  const [lines] = await db.query(
    `SELECT rr.effective_from, rr.effective_to, rr.created_by, mp.position_code, COALESCE(mp.position_title, mr.title) AS title
       FROM hrms_position_reporting_relationships rr
       JOIN hrms_positions mp ON mp.company_id = rr.company_id AND mp.id = rr.to_position_id
       LEFT JOIN hrms_roles mr ON mr.company_id = mp.company_id AND mr.id = mp.role_id
      WHERE rr.company_id = ? AND rr.from_position_id = ? AND rr.deleted_at IS NULL`,
    [companyId, position.id],
  );
  for (const r of lines) {
    const who = [r.title, r.position_code ? `(${r.position_code})` : null].filter(Boolean).join(' ');
    events.push({ layer: 'POSITION', kind: 'POSITION', on: dateText(r.effective_from), what: 'REPORTS_TO', line: who, from: null, to: who, by: r.created_by ?? null, reason: null, lineKey: null });
    if (r.effective_to) {
      events.push({ layer: 'POSITION', kind: 'POSITION', on: dayAfter(dateText(r.effective_to)), what: 'STOPPED_REPORTING_TO', line: who, from: who, to: null, by: null, reason: null, lineKey: null });
    }
  }
  return events;
}

/* ══════════════════════════════════════════════════════════════════════════
 * Finishing: names, order, "coming"
 * ══════════════════════════════════════════════════════════════════════════ */

async function finish(db, companyId, events, extra = {}) {
  const ids = [...new Set(events.map((e) => e.by).filter((v) => v != null).map(Number))];
  const names = new Map();
  if (ids.length) {
    const [users] = await db.query('SELECT id, name FROM users WHERE id IN (?)', [ids]);
    for (const u of users) names.set(Number(u.id), u.name);
  }
  const now = today();
  const order = { REMOVED: 0, RESTORED: 0, STOPPED_REPORTING_TO: 0, LEFT_POSITION: 0 };
  const items = events
    .map((e) => ({ ...e, by: e.by == null ? null : names.get(Number(e.by)) ?? null, coming: Boolean(e.on && e.on > now) }))
    .sort((a, b) => (b.on ?? '').localeCompare(a.on ?? '') || ((order[b.what] ?? 1) - (order[a.what] ?? 1)));
  return { ...extra, asOf: now, items, total: items.length };
}

const within = (e, from, to) => (!from || !e.on || e.on >= from) && (!to || !e.on || e.on <= dayAfter(to));

/* ══════════════════════════════════════════════════════════════════════════
 * The three reads
 * ══════════════════════════════════════════════════════════════════════════ */

async function kraNamesOf(db, companyId, roleIds) {
  if (!roleIds.length) return new Map();
  const [rows] = await db.query(
    `SELECT a.id, d.name FROM hrms_role_kra_assignments a JOIN hrms_kra_definitions d ON d.company_id = a.company_id AND d.id = a.kra_definition_id
      WHERE a.company_id = ? AND a.role_id IN (?)`,
    [companyId, roleIds],
  );
  return new Map(rows.map((r) => [Number(r.id), r.name]));
}

export async function roleJobHistory(db, companyId, roleId) {
  const [[role]] = await db.query('SELECT id, title FROM hrms_roles WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, roleId]);
  if (!role) throw notFound('Role');
  const events = roleEvents(await roleRows(db, companyId, [role.id]), await kraNamesOf(db, companyId, [role.id]));
  return finish(db, companyId, events, { subject: 'ROLE', roleId: role.id, roleTitle: role.title });
}

export async function positionJobHistory(db, companyId, positionId) {
  const position = await requirePosition(db, companyId, positionId);
  const events = [
    ...roleEvents(await roleRows(db, companyId, [position.role_id]), await kraNamesOf(db, companyId, [position.role_id])),
    ...overlayEvents(await overlayRows(db, companyId, 'POSITION', [position.id]), 'POSITION'),
    ...(await positionFacts(db, companyId, position)),
  ];
  return finish(db, companyId, events, { subject: 'SEAT', positionId: position.id, positionCode: position.position_code ?? null });
}

export async function employeeJobHistory(db, companyId, employeeId) {
  const [[e]] = await db.query('SELECT id, full_name FROM hrms_employees WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, employeeId]);
  if (!e) throw notFound('Employee');
  const [held] = await db.query(
    `SELECT wa.id, wa.position_id, wa.role_id, wa.effective_from, wa.effective_to, wa.created_by,
            p.position_code, COALESCE(p.position_title, r.title) AS title, p.role_id AS position_role_id
       FROM hrms_work_assignments wa
       JOIN hrms_positions p ON p.company_id = wa.company_id AND p.id = wa.position_id
       LEFT JOIN hrms_roles r ON r.company_id = p.company_id AND r.id = p.role_id
      WHERE wa.company_id = ? AND wa.employee_id = ? AND wa.deleted_at IS NULL AND wa.position_id IS NOT NULL
      ORDER BY wa.effective_from`,
    [companyId, employeeId],
  );
  const events = [];
  // Their own changes, on every assignment they have held.
  events.push(...overlayEvents(await overlayRows(db, companyId, 'PERSON', held.map((h) => h.id)), 'PERSON'));
  // The positions they held, and — while they held each — what the role and the position changed.
  const roleIds = [...new Set(held.map((h) => h.position_role_id ?? h.role_id))];
  const roleAll = await roleRows(db, companyId, roleIds);
  const kraNames = await kraNamesOf(db, companyId, roleIds);
  const posAll = await overlayRows(db, companyId, 'POSITION', [...new Set(held.map((h) => h.position_id))]);
  for (const h of held) {
    const from = dateText(h.effective_from);
    const to = dateText(h.effective_to);
    const who = [h.title, h.position_code ? `(${h.position_code})` : null].filter(Boolean).join(' ');
    events.push({ layer: 'POSITION', kind: 'POSITION', on: from, what: 'STARTED_IN', line: who, from: null, to: who, by: h.created_by ?? null, reason: null, lineKey: null });
    if (to) events.push({ layer: 'POSITION', kind: 'POSITION', on: dayAfter(to), what: 'LEFT_POSITION', line: who, from: who, to: null, by: null, reason: null, lineKey: null });
    const roleId = h.position_role_id ?? h.role_id;
    for (const ev of roleEvents(roleAll.filter((r) => Number(r.role_id) === Number(roleId)), kraNames)) {
      if (ev.on && within(ev, dayAfter(from ?? '1000-01-01'), to)) events.push(ev);
    }
    for (const ev of overlayEvents(posAll.filter((r) => Number(r.owner_id) === Number(h.position_id)), 'POSITION')) {
      if (ev.on && within(ev, dayAfter(from ?? '1000-01-01'), to)) events.push(ev);
    }
  }
  return finish(db, companyId, events, { subject: 'PERSON', employeeId: e.id, employeeName: e.full_name });
}

export default { roleJobHistory, positionJobHistory, employeeJobHistory };
