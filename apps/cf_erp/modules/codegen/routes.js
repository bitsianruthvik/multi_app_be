/**
 * routes.js — the coding-rules API. The host app mounts it and supplies the
 * permission tags, so this module never learns the host's tag names.
 *
 *   GET    /codegen/entities        what can be coded, which tokens and tests it offers
 *   GET    /codegen/schemes         rules (+ conditions, pattern, counters)
 *   GET    /codegen/schemes/:id
 *   POST   /codegen/schemes         create a rule, whole
 *   PUT    /codegen/schemes/:id     replace a rule, whole
 *   DELETE /codegen/schemes/:id
 *   POST   /codegen/preview         what a record (saved or draft) would get — never consumes a number
 *   POST   /codegen/explain         the rules screen's guide for one record: which rule wins and why,
 *                                   what each part of a pattern prints, what each token holds
 */
import { Router } from 'express';
import { protect } from '../../../../core/middleware/authmiddleware.js';
import { requirePerm, fail } from '../../../../core/middleware/requirePerm.js';
import { pool } from '../../../../db.js';
import { CodegenError } from './errors.js';
import { listEntities, generate } from './engine.js';
import { listSchemes, getScheme, createScheme, updateScheme, deleteScheme, checkScheme, explainRecord } from './service.js';

async function inTransaction(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const out = await fn(conn);
    await conn.commit();
    return out;
  } catch (err) {
    try { await conn.rollback(); } catch { /* keep the original error */ }
    throw err;
  } finally {
    conn.release();
  }
}

function who(req) {
  const companyId = Number(req.user?.companyId ?? req.user?.company_id);
  if (!companyId) throw new CodegenError(401, 'NO_COMPANY', 'This session has no company.');
  return { companyId, userId: Number(req.user?.id) || null };
}

const handle = (fn) => async (req, res) => {
  try {
    res.json(await fn(req));
  } catch (err) {
    // Duplicate rule code is the one constraint a person can hit here.
    if (err?.errno === 1062) return fail(res, new CodegenError(409, 'DUPLICATE', 'A coding rule with that code already exists.'));
    fail(res, err);
  }
};

function id(req) {
  const n = Number(req.params.id);
  if (!Number.isInteger(n) || n <= 0) throw new CodegenError(422, 'INVALID', 'Rule id must be a positive whole number.');
  return n;
}

export function createCodegenRouter({ viewPerm, managePerm }) {
  const router = Router();
  const view = [protect, requirePerm(viewPerm)];
  const manage = [protect, requirePerm(managePerm)];

  router.get('/codegen/entities', view, handle(async () => listEntities()));

  router.get('/codegen/schemes', view, handle(async (req) => {
    const { companyId } = who(req);
    return listSchemes(pool, companyId, { entityType: req.query.entityType || undefined });
  }));

  router.get('/codegen/schemes/:id', view, handle(async (req) => getScheme(pool, who(req).companyId, id(req))));

  router.post('/codegen/schemes', manage, handle(async (req) => {
    const { companyId, userId } = who(req);
    return inTransaction((db) => createScheme(db, companyId, userId, req.body ?? {}));
  }));

  router.put('/codegen/schemes/:id', manage, handle(async (req) => {
    const { companyId, userId } = who(req);
    return inTransaction((db) => updateScheme(db, companyId, userId, id(req), req.body ?? {}));
  }));

  router.delete('/codegen/schemes/:id', manage, handle(async (req) => {
    const { companyId } = who(req);
    return inTransaction((db) => deleteScheme(db, companyId, id(req)));
  }));

  /**
   * body: { entityType, targetField, entityId? | draft?, scheme? }
   * With `scheme` (an unsaved rule from the editor) the rule is validated and
   * rendered directly; without it the rule that would really be chosen is used.
   * Runs in a transaction that is always rolled back — a preview writes nothing.
   */
  router.post('/codegen/preview', view, handle(async (req) => {
    const { companyId } = who(req);
    const b = req.body ?? {};
    const subject = b.entityId != null ? { entityId: Number(b.entityId) } : { draft: b.draft ?? {} };
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      let inline = null;
      if (b.scheme) {
        const { input, segments } = await checkScheme(conn, companyId, { ...b.scheme, entityType: b.entityType });
        inline = { id: b.scheme.id ?? null, code: input.code, seqScope: input.seqScope, segments };
      }
      const out = await generate(conn, companyId, b.entityType, b.targetField ?? 'code', subject, { consume: false, inline });
      return out ?? { schemeId: null, schemeCode: null, text: null, number: null, missing: [], noRule: true };
    } finally {
      try { await conn.rollback(); } catch { /* nothing was written */ }
      conn.release();
    }
  }));

  /**
   * body: { entityType, targetField, entityId? | draft?, scheme?, keys? }
   * For one sample record: every active rule for the entity and field with each
   * condition held or not, which one wins and why (decided by the same code as
   * generate()), the unsaved `scheme` taking part in place of its saved self;
   * what each part of that scheme's pattern prints; what each token in `keys`
   * holds. Guarded like /preview, and like it always rolled back.
   */
  router.post('/codegen/explain', view, handle(async (req) => {
    const { companyId } = who(req);
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      return await explainRecord(conn, companyId, req.body ?? {});
    } finally {
      try { await conn.rollback(); } catch { /* nothing was written */ }
      conn.release();
    }
  }));

  return router;
}
