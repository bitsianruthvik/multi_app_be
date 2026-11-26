/**
 * adminPanelRoute.js — the company admin panel, mounted at /api/:company/admin-panel (behind `protect`).
 *
 *   GET  /me                          { admin } — may this person open the panel
 *   POST /me/password                 { current, next } — anyone, for themselves (also clears "must change")
 *   GET  /overview                    the company and its apps
 *   GET  /people                      POST { name, login, apps, admin? }            POST /people/bulk { appId, rows }
 *   GET  /people/:id                  PUT  { name?, login?, admin?, apps? }
 *   POST /people/:id/deactivate | /activate | /reset-password
 *   GET  /roles                       POST { name, standard? | copyOf? }
 *   GET  /roles/:id                   PUT  { name?, apps: { appId: { tags } } }     DELETE
 *   POST /roles/:id/reset             { appId }
 *   GET  /history
 *   GET  /brand                       { company, colors, logo } — anyone signed in to the company (the apps paint with it)
 *   PUT  /brand                       { colors: 3-6 #RRGGBB | [], logo: data URL | "" } — admin (core/brand/companyBrand.js)
 *
 * The company is the signed-in person's own (the token) — the :company in the address only has to agree with it.
 */
import { Router } from "express";
import { pool } from "../../db.js";
import { logger } from "../utils/logger.js";
import { clearUserState } from "../auth/loginRules.js";
import * as S from "./adminPanelService.js";
import { getBrand, setBrand, BrandError } from "../brand/companyBrand.js";

const router = Router({ mergeParams: true });

const ctx = (req) => ({ companyId: Number(req.user.companyId ?? req.user.company_id), userId: Number(req.user.id), userName: req.user.name ?? null });
const fail = (res, e) => {
  if (e instanceof BrandError) return res.status(e.status).json({ error: e.code, message: e.message, problems: e.problems ?? undefined });
  if (e instanceof S.AdminError) return res.status(e.status).json({ error: e.code, message: e.message, problems: e.problems ?? undefined });
  if (e?.code === "ER_DUP_ENTRY") return res.status(422).json({ error: "DUPLICATE", message: "That login or name is already in use." });
  logger.error({ err: e }, "admin panel error");
  return res.status(500).json({ error: "SERVER", message: "Something went wrong. Nothing was changed." });
};
const read = (fn) => async (req, res) => { try { res.json(await fn(req)); } catch (e) { fail(res, e); } };
/** A write: one transaction; rolled back whole when anything refuses. */
const write = (fn) => async (req, res) => {
  const db = await pool.getConnection();
  try {
    await db.beginTransaction();
    const out = await fn(db, req);
    await db.commit();
    clearUserState();
    res.json(out);
  } catch (e) { try { await db.rollback(); } catch { /* already gone */ } fail(res, e); } finally { db.release(); }
};

// The address must be the person's own company.
router.use((req, res, next) => {
  const slug = String(req.params.company ?? "").toLowerCase();
  if (!req.user || req.user.is_service) return res.status(403).json({ error: "FORBIDDEN", message: "A person must be signed in." });
  if (slug && String(req.user.company ?? "").toLowerCase() !== slug) return res.status(403).json({ error: "FORBIDDEN", message: "That is not your company." });
  next();
});

router.get("/me", read(async (req) => ({ admin: await S.isCompanyAdmin(pool, req.user) })));
router.post("/me/password", write((db, req) => S.changeOwnPassword(db, ctx(req), req.body ?? {})));
// The company's colours and logo: every signed-in person of the company paints the apps with them (2026-11-26).
router.get("/brand", read((req) => getBrand(pool, ctx(req).companyId)));

// Everything below is the admin's.
router.use(async (req, res, next) => {
  try {
    if (await S.isCompanyAdmin(pool, req.user)) return next();
    return res.status(403).json({ error: "FORBIDDEN", message: "Only an admin of this company can open the admin panel." });
  } catch (e) { return fail(res, e); }
});

router.get("/overview", read((req) => S.overview(pool, ctx(req).companyId)));
router.get("/people", read((req) => S.listPeople(pool, ctx(req).companyId)));
router.post("/people", write((db, req) => S.createPerson(db, ctx(req), req.body ?? {})));
router.post("/people/bulk", write((db, req) => S.createPeople(db, ctx(req), req.body ?? {})));
router.get("/people/:id", read((req) => S.getPerson(pool, ctx(req).companyId, req.params.id)));
router.put("/people/:id", write((db, req) => S.updatePerson(db, ctx(req), req.params.id, req.body ?? {})));
router.post("/people/:id/deactivate", write((db, req) => S.setActive(db, ctx(req), req.params.id, false)));
router.post("/people/:id/activate", write((db, req) => S.setActive(db, ctx(req), req.params.id, true)));
router.post("/people/:id/reset-password", write((db, req) => S.resetPassword(db, ctx(req), req.params.id)));
router.get("/roles", read((req) => S.listRoles(pool, ctx(req).companyId)));
router.post("/roles", write((db, req) => S.createRole(db, ctx(req), req.body ?? {})));
router.get("/roles/:id", read((req) => S.getRole(pool, ctx(req).companyId, req.params.id)));
router.put("/roles/:id", write((db, req) => S.saveRole(db, ctx(req), req.params.id, req.body ?? {})));
router.delete("/roles/:id", write((db, req) => S.deleteRole(db, ctx(req), req.params.id)));
router.post("/roles/:id/reset", write((db, req) => S.resetRole(db, ctx(req), req.params.id, req.body ?? {})));
router.get("/history", read((req) => S.history(pool, ctx(req).companyId, req.query)));
router.put("/brand", write((db, req) => setBrand(db, ctx(req), req.body ?? {})));

export default router;
