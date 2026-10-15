/**
 * plan.js — check a plan, picture it, apply it (spec §14.1 part 3).
 *
 * CHECK, in two passes:
 *   1. every step's own `validate`: fields present, records real, the right the
 *      action needs, the login's department scope — plain sentences, nothing
 *      read twice (the company's records are loaded once, records.js);
 *   2. when pass 1 is clean, a TRIAL RUN: the whole plan through the real
 *      services inside a transaction (or a savepoint) that is rolled back. What
 *      a service would refuse — a title already taken, a position with an open
 *      hiring, a move dated before the current one started — is found here and
 *      put on the step that caused it, in the service's own words. Code numbers
 *      taken in the trial are given back by the rollback.
 *   The preview (what will exist afterwards) is built in pass 1 from the steps,
 *   so a plan with gaps still has a picture with gaps in it.
 *
 * APPLY re-checks (pass 1), refuses (422) a plan with any problem, then runs
 * every step in ONE transaction, in order; a step that refers to an earlier one
 * gets the id that step made. Any failure rolls back everything. The audit rows
 * the services wrote are stamped with one request id, and one more row records
 * the command itself (entity `hrms_command`): what was typed, the steps, what was
 * made — "one audit group per command".
 */
import crypto from 'node:crypto';
import { pool, withTransaction } from '../../lib/db.js';
import { HrmsError, invalid, translateDbError } from '../../lib/errors.js';
import { ACTION_BY_KEY } from './actions/index.js';
import { loadRecords } from './records.js';

export const emptyPreview = () => ({ departments: [], roles: [], positions: [], lines: [], moves: [], shifts: [] });

/** Steps as they arrive from a screen: ids made sure of, nothing else trusted. */
export function readSteps(steps) {
  if (!Array.isArray(steps) || !steps.length) throw invalid('INVALID', 'There is nothing to do — the plan has no steps.');
  if (steps.length > 20) throw invalid('INVALID', 'A plan is up to 20 steps. Split it into two.');
  const seen = new Set();
  return steps.map((s, i) => {
    let id = String(s?.id ?? `s${i + 1}`).slice(0, 20);
    if (seen.has(id)) id = `s${i + 1}_${i}`;
    seen.add(id);
    const fields = s?.fields && typeof s.fields === 'object' && !Array.isArray(s.fields) ? s.fields : {};
    return { id, action: s?.action ?? null, fields, sourceText: s?.sourceText ?? null, confidence: s?.confidence ?? null };
  });
}

const messagesOf = (err) => {
  const e = translateDbError(err);
  if (!(e instanceof HrmsError) && !(e?.status && e.status < 500)) return ['Something went wrong doing this step.'];
  const list = Array.isArray(e.problems) && e.problems.length ? e.problems.map(String) : [];
  return [...new Set([e.message, ...list].filter(Boolean))];
};

function validateAll(steps, recs, actor) {
  const ctx = { recs, actor, made: new Map(), preview: emptyPreview() };
  const out = steps.map((step) => {
    const action = ACTION_BY_KEY.get(step.action);
    if (!action) return { ...step, problems: ['Choose what this step should do.'] };
    const { problems, made } = action.validate(step, ctx);
    if (made) ctx.made.set(step.id, made);
    return { ...step, problems };
  });
  return { steps: out, preview: ctx.preview, clean: out.every((s) => !s.problems.length) };
}

/** Every step through its service, in order, on `conn`. Throws with `stepId` on the first failure. */
async function runSteps(conn, steps, recs, actor) {
  const made = new Map();
  const ctx = {
    recs,
    actor,
    made,
    c: { companyId: actor.companyId, userId: actor.userId },
    refId(step, name) {
      const f = step.fields?.[name];
      if (f?.ref?.kind === 'step') return made.get(f.ref.id)?.id ?? null;
      const v = f?.ref?.id ?? f?.value;
      return v == null || v === '' ? null : Number(v);
    },
  };
  const results = [];
  for (const step of steps) {
    try {
      const r = await ACTION_BY_KEY.get(step.action).apply(step, conn, ctx);
      made.set(step.id, r);
      results.push({ stepId: step.id, action: step.action, ...r });
    } catch (err) {
      err.stepId = step.id;
      throw err;
    }
  }
  return results;
}

/** A trial on a connection: a savepoint inside the caller's transaction, else a transaction of its own. */
async function trial(steps, recs, actor, { conn = null } = {}) {
  const own = !conn;
  const c = conn ?? await pool.getConnection();
  try {
    if (own) await c.beginTransaction();
    else await c.query('SAVEPOINT cmd_trial');
    try {
      await runSteps(c, steps, recs, actor);
      return null;
    } catch (err) {
      return { stepId: err.stepId ?? null, messages: messagesOf(err) };
    } finally {
      if (own) await c.rollback();
      else await c.query('ROLLBACK TO SAVEPOINT cmd_trial');
    }
  } finally {
    if (own) c.release();
  }
}

/**
 * POST /commands/check. `actor` = { companyId, userId, can(tag), scope }.
 * `conn` (tests): run the trial inside that connection's transaction.
 */
export async function checkPlan(db, actor, rawSteps, { conn = null, recs = null, tryRun = true } = {}) {
  const steps = readSteps(rawSteps);
  const records = recs ?? await loadRecords(conn ?? db, actor.companyId, { scope: actor.scope });
  const checked = validateAll(steps, records, actor);
  if (checked.clean && tryRun) {
    const failed = await trial(steps, records, actor, { conn });
    if (failed) {
      const s = checked.steps.find((x) => x.id === failed.stepId) ?? checked.steps[checked.steps.length - 1];
      s.problems.push(...failed.messages);
      checked.clean = false;
    }
  }
  return { steps: checked.steps, preview: checked.preview, clean: checked.clean };
}

/**
 * POST /commands/apply. `conn` (tests): apply on that connection and do NOT
 * commit — the caller's transaction decides.
 */
export async function applyPlan(db, actor, rawSteps, { conn = null, text = null } = {}) {
  const steps = readSteps(rawSteps);
  const records = await loadRecords(conn ?? db, actor.companyId, { scope: actor.scope });
  const checked = validateAll(steps, records, actor);
  if (!checked.clean) {
    throw invalid('PLAN_NOT_CLEAR', 'Some steps still need attention, so nothing was done.', {
      problems: checked.steps.flatMap((s, i) => s.problems.map((p) => `Step ${i + 1}: ${p}`)),
      detail: { steps: checked.steps.map((s) => ({ id: s.id, problems: s.problems })) },
    });
  }
  const requestId = `cmd-${crypto.randomUUID()}`;
  const run = async (c) => {
    const [[{ last }]] = await c.query('SELECT COALESCE(MAX(id), 0) AS last FROM hrms_audit_log WHERE company_id = ?', [actor.companyId]);
    let created;
    try {
      created = await runSteps(c, steps, records, actor);
    } catch (err) {
      const at = steps.findIndex((s) => s.id === err.stepId);
      const messages = messagesOf(err);
      throw invalid('STEP_FAILED', `Step ${at + 1} could not be done, so nothing was done: ${messages[0]}`, {
        problems: messages,
        detail: { stepId: err.stepId ?? null, step: at + 1 },
      });
    }
    await c.query(
      `UPDATE hrms_audit_log SET request_id = ?
        WHERE company_id = ? AND id > ? AND request_id IS NULL AND actor_user_id <=> ?`,
      [requestId, actor.companyId, last, actor.userId ?? null],
    );
    await c.query(
      `INSERT INTO hrms_audit_log (company_id, actor_user_id, entity_type, entity_id, action, before_json, after_json, request_id, created_by)
       VALUES (?, ?, 'hrms_command', 0, 'CREATE', NULL, ?, ?, ?)`,
      [actor.companyId, actor.userId ?? null, JSON.stringify({
        text: text ? String(text).slice(0, 2000) : null,
        steps: steps.map((s) => ({ id: s.id, action: s.action, sourceText: s.sourceText ?? null })),
        created: created.map(({ stepId, action, kind, id, code, name }) => ({ stepId, action, kind, id, code, name })),
      }), requestId, actor.userId ?? null],
    );
    return created;
  };
  const created = conn ? await run(conn) : await withTransaction(run);
  return { ok: true, requestId, created };
}

/** The actor of a request: who, which company, which rights, which scope. */
export async function actorOf(req, { can, scopeOf, ctx }) {
  const { companyId, userId } = ctx(req);
  return { companyId, userId, can: (tag) => can(req, tag), scope: await scopeOf(req) };
}
