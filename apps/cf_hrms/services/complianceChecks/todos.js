/**
 * todos.js — per-company COMPLIANCE TO-DOS with a proposed fix (TM/CF_HRMS_HIRING_SPEC.md §36.3, C2).
 *
 *   syncTodos(db, companyId, { on?, lawVersionIds?, trigger, userId? })
 *       findBreaches → one open to-do per breach (todo_key = check:rule): created, or brought up to date;
 *       on a full pass (no lawVersionIds) an open to-do no longer found becomes RESOLVED.
 *       Runs after every law publish (onPublish, listenForLaw), on the nightly pass, and on "Check now".
 *   listTodos / readTodo (with proposeFixes' options, before / after) / chooseOption (HR) /
 *   approveTodo (the Owner; never the one who chose — maker-checker; applies the fix as dated changes) /
 *   dismissTodo (a WARN or INFO, with a reason) / remindPass (reminders until done).
 *
 * The statutory top-up: an open HARD minimum-wage to-do past its deadline makes each run pay the
 * shortfall (wire.js topUpsForRun; runService.calculateRun) until the fix is applied.
 */
import { pool, withTransaction } from '../../lib/db.js';
import { HrmsError } from '../../lib/errors.js';
import { audit } from '../peopleService.js';
import { onPublish } from '../law/store.js';
import { findBreaches, REMEDIES_OF } from './breaches.js';
import { proposeFixes, applyOption } from './remedies.js';
import { ensureTopUpComponent } from './wire.js';
import { CHECKS, TODO_OPEN } from './constants.js';
import { today, dateText } from './context.js';

const json = (v, d = null) => { if (v == null) return d; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return d; } };
const stamp = (v) => (v ? (v instanceof Date ? v.toISOString() : String(v)) : null);

/* ── sync ────────────────────────────────────────────────────────────── */

export async function syncTodos(db, companyId, { on = today(), lawVersionIds = null, trigger = 'CHECK_NOW', userId = null } = {}) {
  const breaches = await findBreaches(db, companyId, { on, lawVersionIds });
  if (breaches.some((b) => b.check === 'MIN_WAGE' && b.severity === 'HARD')) await ensureTopUpComponent(db, companyId, userId);
  const [open] = await db.query(`SELECT id, todo_key, status FROM hrms_compliance_todos WHERE company_id = ? AND deleted_at IS NULL AND status IN ('OPEN','CHOSEN')`, [companyId]);
  const byKey = new Map(open.map((t) => [t.todo_key, t]));
  const out = { created: [], updated: [], resolved: [], breaches: breaches.length };
  for (const b of breaches) {
    const affected = JSON.stringify({
      people: b.people.slice(0, 2000), structures: b.structures, policies: b.policies, rule: b.rule, hardIfVerified: b.hardIfVerified, unverifiedNote: b.unverifiedNote, on: b.on, remedies: b.remedies,
    });
    const vals = [b.check, b.severity, b.rule?.id ?? null, b.rule?.version ?? null, `${CHECKS[b.check] ?? b.check}${b.rule?.title ? ` — ${b.rule.title}` : ''}`.slice(0, 300), b.message.slice(0, 2000), b.effectiveFrom, b.deadline, b.people.length, b.structures.length, affected, trigger];
    const t = byKey.get(b.key);
    if (t) {
      await db.query(`UPDATE hrms_compliance_todos SET check_key = ?, severity = ?, rule_id = ?, rule_version = ?, title = ?, message = ?, effective_from = ?, deadline = ?, people_count = ?, structures_count = ?,
          affected_json = ?, last_trigger = ?, last_checked_at = NOW() WHERE id = ?`, [...vals, t.id]);
      out.updated.push(t.id);
      byKey.delete(b.key);
    } else {
      const [ins] = await db.query(`INSERT INTO hrms_compliance_todos (company_id, todo_key, check_key, severity, rule_id, rule_version, title, message, effective_from, deadline, people_count, structures_count,
          affected_json, last_trigger, status, first_seen_at, last_checked_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', NOW(), NOW(), ?)`, [companyId, b.key, ...vals, userId]);
      out.created.push(ins.insertId);
      await audit(db, { companyId, userId }, 'hrms_compliance_todos', ins.insertId, 'CREATE', null, { key: b.key, severity: b.severity, people: b.people.length, trigger }, null);
    }
  }
  if (!lawVersionIds?.length) {
    for (const t of byKey.values()) {
      await db.query("UPDATE hrms_compliance_todos SET status = 'RESOLVED', resolved_at = NOW(), last_checked_at = NOW(), last_trigger = ? WHERE id = ? AND status IN ('OPEN','CHOSEN')", [trigger, t.id]);
      out.resolved.push(t.id);
    }
  }
  return out;
}

/* ── reads ───────────────────────────────────────────────────────────── */

function shapeTodo(r, names = new Map()) {
  const a = json(r.affected_json, {}) ?? {};
  const deadline = dateText(r.deadline);
  return {
    id: r.id, key: r.todo_key, check: r.check_key, checkName: CHECKS[r.check_key] ?? r.check_key, severity: r.severity, status: r.status, title: r.title, message: r.message,
    rule: a.rule ?? null, hardIfVerified: Boolean(a.hardIfVerified), unverifiedNote: a.unverifiedNote ?? null,
    effectiveFrom: dateText(r.effective_from), deadline, overdue: Boolean(deadline && deadline < today() && TODO_OPEN.includes(r.status)),
    peopleCount: Number(r.people_count), structuresCount: Number(r.structures_count), remedies: a.remedies ?? REMEDIES_OF[r.check_key] ?? [],
    chosenOption: r.chosen_option ?? null, chosenNote: r.chosen_note ?? null, chosenBy: r.chosen_by ? { id: r.chosen_by, name: names.get(r.chosen_by) ?? null } : null, chosenAt: stamp(r.chosen_at),
    approvedBy: r.approved_by ? { id: r.approved_by, name: names.get(r.approved_by) ?? null } : null, approvedAt: stamp(r.approved_at), appliedAt: stamp(r.applied_at), applied: json(r.applied_json, null),
    letters: Boolean(r.letters), dismissedReason: r.dismissed_reason ?? null, resolvedAt: stamp(r.resolved_at), firstSeenAt: stamp(r.first_seen_at), lastCheckedAt: stamp(r.last_checked_at),
    lastTrigger: r.last_trigger ?? null, reminders: Number(r.reminder_count) || 0, lastRemindedAt: stamp(r.last_reminded_at), topUpFrom: r.topup_from ?? null,
    topUpActive: r.check_key === 'MIN_WAGE' && r.severity === 'HARD' && TODO_OPEN.includes(r.status) && Boolean(deadline && deadline <= today()),
  };
}

async function namesOf(db, rows) {
  const ids = [...new Set(rows.flatMap((r) => [r.chosen_by, r.approved_by]).filter(Boolean))];
  if (!ids.length) return new Map();
  const [u] = await db.query('SELECT id, name FROM users WHERE id IN (?)', [ids]);
  return new Map(u.map((x) => [x.id, x.name]));
}

export async function listTodos(db, companyId, { status = 'open' } = {}) {
  const where = status === 'all' ? '' : status === 'done' ? "AND status IN ('APPLIED','RESOLVED','DISMISSED')" : "AND status IN ('OPEN','CHOSEN')";
  const [rows] = await db.query(`SELECT * FROM hrms_compliance_todos WHERE company_id = ? AND deleted_at IS NULL ${where} ORDER BY FIELD(status,'CHOSEN','OPEN','APPLIED','DISMISSED','RESOLVED'), FIELD(severity,'HARD','WARN','INFO'), deadline, id DESC LIMIT 500`, [companyId]);
  const names = await namesOf(db, rows);
  const todos = rows.map((r) => shapeTodo(r, names));
  const [[c]] = await db.query("SELECT SUM(status IN ('OPEN','CHOSEN')) AS open, SUM(status IN ('OPEN','CHOSEN') AND severity = 'HARD') AS hard, SUM(status = 'CHOSEN') AS waiting, SUM(status IN ('OPEN','CHOSEN') AND deadline < CURDATE()) AS overdue FROM hrms_compliance_todos WHERE company_id = ? AND deleted_at IS NULL", [companyId]);
  return { todos, counts: { open: Number(c.open) || 0, hard: Number(c.hard) || 0, waitingApproval: Number(c.waiting) || 0, overdue: Number(c.overdue) || 0 } };
}

async function todoRow(db, companyId, id, { lock = false } = {}) {
  const [[r]] = await db.query(`SELECT * FROM hrms_compliance_todos WHERE company_id = ? AND id = ? AND deleted_at IS NULL${lock ? ' FOR UPDATE' : ''}`, [companyId, id]);
  if (!r) throw new HrmsError(404, 'NOT_FOUND', 'That compliance to-do was not found.');
  return r;
}

/** The breach a to-do stands for (as findBreaches gave it), for proposeFixes. */
export function breachOf(r, companyId) {
  const a = json(r.affected_json, {}) ?? {};
  return {
    key: r.todo_key, companyId, on: a.on ?? today(), check: r.check_key, severity: r.severity, rule: a.rule ?? null,
    people: a.people ?? [], structures: a.structures ?? [], policies: a.policies ?? [], effectiveFrom: dateText(r.effective_from), deadline: dateText(r.deadline),
    remedies: a.remedies ?? REMEDIES_OF[r.check_key] ?? [],
  };
}

export async function readTodo(db, c, id) {
  const r = await todoRow(db, c.companyId, id);
  const names = await namesOf(db, [r]);
  const todo = shapeTodo(r, names);
  const a = json(r.affected_json, {}) ?? {};
  const fixes = TODO_OPEN.includes(r.status) ? await proposeFixes(breachOf(r, c.companyId), db) : { options: [] };
  return {
    todo, people: a.people ?? [], structures: a.structures ?? [], policies: a.policies ?? [], options: fixes.options,
    chosen: json(r.chosen_json, null),
    can: { choose: TODO_OPEN.includes(r.status) && fixes.options.length > 0, approve: r.status === 'CHOSEN' && Boolean(c.owner) && Number(r.chosen_by) !== Number(c.userId), dismiss: TODO_OPEN.includes(r.status) && r.severity !== 'HARD' },
  };
}

/* ── choose, approve, dismiss ────────────────────────────────────────── */

export async function chooseOption(db, c, id, body = {}, requestId = null) {
  const r = await todoRow(db, c.companyId, id, { lock: true });
  if (!TODO_OPEN.includes(r.status)) throw new HrmsError(409, 'WRONG_STATUS', `This to-do is ${r.status.toLowerCase()}: nothing to choose.`);
  const key = String(body.option ?? '').toUpperCase();
  const fixes = await proposeFixes(breachOf(r, c.companyId), db);
  const option = fixes.options.find((o) => o.key === key);
  if (!option) throw new HrmsError(422, 'INVALID', `Choose one of the fixes offered: ${fixes.options.map((o) => o.key).join(', ') || 'none'}.`, { problems: ['Choose a fix.'] });
  if (!option.totals.feasible) throw new HrmsError(409, 'NOT_FEASIBLE', `This fix works for nobody here: ${option.infeasible.slice(0, 3).map((p) => `${p.name} — ${p.note}`).join('; ')}. Choose another.`, { problems: option.infeasible.map((p) => `${p.name}: ${p.note}`) });
  const note = body.note == null ? null : String(body.note).trim().slice(0, 500) || null;
  await db.query("UPDATE hrms_compliance_todos SET status = 'CHOSEN', chosen_option = ?, chosen_json = ?, chosen_note = ?, chosen_by = ?, chosen_at = NOW(), letters = ? WHERE id = ?",
    [key, JSON.stringify(option), note, c.userId, body.letters ? 1 : 0, r.id]);
  await audit(db, c, 'hrms_compliance_todos', r.id, 'UPDATE', { status: r.status, option: r.chosen_option }, { status: 'CHOSEN', option: key, totals: option.totals, note }, requestId);
  return readTodo(db, c, id);
}

/** The Owner approves HR's choice; the fix is applied as dated changes. HR cannot approve their own. */
export async function approveTodo(db, c, id, body = {}, requestId = null) {
  const r = await todoRow(db, c.companyId, id, { lock: true });
  if (r.status !== 'CHOSEN') throw new HrmsError(409, 'WRONG_STATUS', r.status === 'OPEN' ? 'HR has not chosen a fix yet.' : `This to-do is ${r.status.toLowerCase()}.`);
  if (!c.owner) throw new HrmsError(403, 'OWNER_ONLY', 'Only the Owner approves a compliance fix.');
  if (Number(r.chosen_by) === Number(c.userId)) throw new HrmsError(409, 'OWN_CHOICE', 'You chose this fix, so someone else must approve it (maker-checker).');
  const fixes = await proposeFixes(breachOf(r, c.companyId), db);
  const option = fixes.options.find((o) => o.key === r.chosen_option);
  if (!option || !option.totals.feasible) throw new HrmsError(409, 'NOT_FEASIBLE', 'The chosen fix no longer works for anybody (the data changed since). HR must choose again.');
  const applied = await applyOption(db, c, option, { todoId: r.id, requestId });
  await db.query("UPDATE hrms_compliance_todos SET status = 'APPLIED', approved_by = ?, approved_at = NOW(), applied_at = NOW(), applied_json = ?, last_trigger = 'APPLY' WHERE id = ?",
    [c.userId, JSON.stringify({ ...applied, note: body.note ? String(body.note).slice(0, 500) : null, totals: option.totals }), r.id]);
  await audit(db, c, 'hrms_compliance_todos', r.id, 'APPROVE', { status: 'CHOSEN' }, { status: 'APPLIED', option: r.chosen_option, salaries: applied.salaries.length, structures: applied.structures.length, components: applied.components.length }, requestId);
  return readTodo(db, c, id);
}

export async function dismissTodo(db, c, id, body = {}, requestId = null) {
  const r = await todoRow(db, c.companyId, id, { lock: true });
  if (!TODO_OPEN.includes(r.status)) throw new HrmsError(409, 'WRONG_STATUS', `This to-do is ${r.status.toLowerCase()}.`);
  if (r.severity === 'HARD') throw new HrmsError(409, 'HARD_BREACH', 'A breach of the law cannot be dismissed: fix it.');
  const reason = String(body.reason ?? '').trim();
  if (reason.length < 5) throw new HrmsError(422, 'INVALID', 'Say why this is not a problem (kept with the to-do).', { problems: ['A reason of at least 5 characters.'] });
  await db.query("UPDATE hrms_compliance_todos SET status = 'DISMISSED', dismissed_reason = ?, approved_by = ?, approved_at = NOW() WHERE id = ?", [reason.slice(0, 500), c.userId, r.id]);
  await audit(db, c, 'hrms_compliance_todos', r.id, 'UPDATE', { status: r.status }, { status: 'DISMISSED', reason }, requestId);
  return readTodo(db, c, id);
}

/* ── reminders, nightly, after a publish ─────────────────────────────── */

/** Open to-dos due within 14 days or past due, not reminded today: counted and stamped. Returns them. */
export async function remindPass(db, companyId) {
  const [rows] = await db.query(
    `SELECT id, title, deadline, severity FROM hrms_compliance_todos WHERE company_id = ? AND deleted_at IS NULL AND status IN ('OPEN','CHOSEN')
        AND (deadline IS NULL OR deadline <= DATE_ADD(CURDATE(), INTERVAL 14 DAY)) AND (last_reminded_at IS NULL OR DATE(last_reminded_at) < CURDATE())`, [companyId]);
  if (rows.length) await db.query('UPDATE hrms_compliance_todos SET reminder_count = reminder_count + 1, last_reminded_at = NOW() WHERE id IN (?)', [rows.map((r) => r.id)]);
  return rows.map((r) => ({ id: r.id, title: r.title, deadline: dateText(r.deadline), severity: r.severity, link: `payroll-compliance/${r.id}` }));
}

/** Companies with payroll (a live salary). */
export async function payrollCompanies(db = pool) {
  const [rows] = await db.query('SELECT DISTINCT company_id FROM hrms_pay_salaries WHERE deleted_at IS NULL');
  return rows.map((r) => r.company_id);
}

const pending = new Set();
/** Resolves when every sync started by a publish has finished (tests). */
export const settled = async () => { while (pending.size) await Promise.allSettled([...pending]); };

async function afterPublish(version) {
  const id = Number(version?.id);
  if (!Number.isInteger(id) || version?.kind === 'TAX') return;
  // The publish is written in the publisher's transaction: wait until it is visible (committed).
  for (let i = 0; i < 60; i += 1) {
    const [[r]] = await pool.query("SELECT status FROM hrms_law_rules WHERE id = ? AND deleted_at IS NULL", [id]);
    if (r?.status === 'PUBLISHED' || r?.status === 'SUPERSEDED') break;
    if (i === 59) return;
    await new Promise((res) => { setTimeout(res, 1000); });
  }
  for (const companyId of await payrollCompanies(pool)) {
    try { await withTransaction((db) => syncTodos(db, companyId, { lawVersionIds: [id], trigger: 'PUBLISH' })); } catch (e) { console.error(`[cf_hrms] compliance to-dos after publishing law ${id} failed for company ${companyId}: ${e.message}`); }
  }
}

let unsubscribe = null;
/** Subscribes to the law layer's publishes (once). */
export function listenForLaw() {
  if (unsubscribe) return unsubscribe;
  unsubscribe = onPublish((version) => {
    const p = afterPublish(version).catch((e) => console.error(`[cf_hrms] compliance to-dos after a publish: ${e.message}`)).finally(() => pending.delete(p));
    pending.add(p);
  });
  return unsubscribe;
}

let timer = null;
const lastNightly = new Map();
/** One pass: every payroll company once a day (after 02:00 local server time): sync + reminders. */
export async function nightlyPass({ now = new Date(), force = false } = {}) {
  const day = now.toISOString().slice(0, 10);
  const done = [];
  if (!force && now.getHours() < 2) return done;
  for (const companyId of await payrollCompanies(pool)) {
    if (!force && lastNightly.get(companyId) === day) continue;
    try {
      const r = await withTransaction(async (db) => ({ sync: await syncTodos(db, companyId, { trigger: 'NIGHTLY' }), reminders: await remindPass(db, companyId) }));
      lastNightly.set(companyId, day);
      done.push({ companyId, ...r });
    } catch (e) { console.error(`[cf_hrms] compliance nightly pass failed for company ${companyId}: ${e.message}`); }
  }
  return done;
}
/** Started by app.js in the real server only (off with CF_HRMS_COMPLIANCE_CHECKS=off). */
export function startChecks() {
  if (timer || process.env.CF_HRMS_COMPLIANCE_CHECKS === 'off') return;
  timer = setInterval(() => { nightlyPass().catch(() => {}); }, 60 * 60 * 1000);
  timer.unref?.();
}

export default { syncTodos, listTodos, readTodo, chooseOption, approveTodo, dismissTodo, remindPass, listenForLaw, nightlyPass, startChecks, settled, breachOf };
