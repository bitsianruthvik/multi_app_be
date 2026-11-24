/**
 * GET /api/:company/:appSlug/app/query — the app's name and settings, for a signed-in person of that company only
 * (appRoute.js puts protect in front, and protect refuses another company's token).
 *
 * It used to be public and answer the whole `apps` (or `companies`) row — ids, company id, settings — to anyone, which
 * also told a stranger which companies and apps exist (2026-11-24 isolation audit). Nothing in the frontend calls it.
 */
export const getAppQuery = async (req, res) => {
  const company = req.company || null;
  const app = req.appCtx || null;
  if (!company || !app) return res.status(403).json({ message: "You do not have access to this company" });
  return res.json({ appSlug: app.slug, companyName: company.name, settings: app.settings || {} });
};
