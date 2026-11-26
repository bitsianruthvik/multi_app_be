/**
 * companyBrand.js — a company's own colours and logo (table company_brand, core-init.sql "COMPANY BRAND", 2026-11-26).
 *
 * Read only by people signed in to that same company (admin panel GET /brand) — never on a sign-in page, which stays
 * CEOFactory's so nobody learns which companies exist. Written by the company's admin (PUT /brand) or by us
 * (scripts/core/company-brand.mjs).
 *
 *   colors  3-6 "#RRGGBB", in order: primary, secondary, accent, then up to three extras (charts, tags)
 *   logo    a data: URL of a PNG, JPEG, WebP or SVG, at most 300 KB — always shown as <img> (an SVG cannot run script)
 */
export const MIN_COLORS = 3;
export const MAX_COLORS = 6;
export const MAX_LOGO = 300 * 1024;
const HEX = /^#[0-9a-fA-F]{6}$/;
const LOGO = /^data:image\/(png|jpeg|webp|svg\+xml)(;charset=utf-8)?(;base64)?,[A-Za-z0-9+/=%._~!$&'()*,;:@\-]+$/;

export class BrandError extends Error {
  constructor(message) { super(message); this.status = 422; this.code = "INVALID"; }
}

/** Cleans what was sent. colors: [] or null = back to the platform's own colours; logo: "" or null = no logo. */
export function cleanBrand(body) {
  const b = body && typeof body === "object" ? body : {};
  const problems = [];
  let colors = Array.isArray(b.colors) ? b.colors.map((c) => String(c ?? "").trim()).filter(Boolean) : [];
  if (colors.length) {
    if (colors.some((c) => !HEX.test(c))) problems.push("Every colour must look like #1A2B3C.");
    if (colors.length < MIN_COLORS || colors.length > MAX_COLORS) problems.push(`Give ${MIN_COLORS} to ${MAX_COLORS} colours (or none, for the standard look).`);
    colors = colors.map((c) => c.toUpperCase());
  }
  let logo = typeof b.logo === "string" ? b.logo.trim() : "";
  if (logo) {
    if (logo.length > MAX_LOGO) problems.push("The logo must be at most 300 KB.");
    else if (!LOGO.test(logo)) problems.push("The logo must be a PNG, JPEG, WebP or SVG image.");
  }
  if (problems.length) { const e = new BrandError(problems.join(" ")); e.problems = problems; throw e; }
  return { colors: colors.length ? colors : null, logo: logo || null };
}

export async function getBrand(db, companyId) {
  const [[row]] = await db.query("SELECT colors, logo, updated_at FROM company_brand WHERE company_id = ?", [Number(companyId)]);
  const [[co]] = await db.query("SELECT name, slug FROM companies WHERE id = ? AND deleted_at IS NULL", [Number(companyId)]);
  let colors = row?.colors ?? null;
  if (typeof colors === "string") { try { colors = JSON.parse(colors); } catch { colors = null; } }
  return {
    company: co ? { name: co.name, slug: co.slug } : null,
    colors: Array.isArray(colors) ? colors : [],
    logo: row?.logo || "",
    updatedAt: row?.updated_at ?? null,
  };
}

/** Saves (or clears) the brand; one admin_audit line. `db` may be a transaction's connection. */
export async function setBrand(db, { companyId, userId, userName }, body) {
  const { colors, logo } = cleanBrand(body);
  await db.query(
    `INSERT INTO company_brand (company_id, colors, logo, updated_by) VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE colors = VALUES(colors), logo = VALUES(logo), updated_by = VALUES(updated_by)`,
    [Number(companyId), colors ? JSON.stringify(colors) : null, logo, userId ?? null]
  );
  const summary = `branding: ${colors ? colors.join(" ") : "standard colours"}; ${logo ? "logo set" : "no logo"}`;
  await db.query(
    "INSERT INTO admin_audit (company_id, actor_id, actor_name, action, subject_type, subject_id, summary) VALUES (?, ?, ?, 'update', 'brand', NULL, ?)",
    [Number(companyId), userId ?? null, userName ?? null, summary]
  );
  return getBrand(db, companyId);
}
