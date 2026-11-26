#!/usr/bin/env node
/**
 * company-brand.mjs — set a company's colours and logo as CEOFactory (the company's admin can do the same in the admin
 * panel › Branding). Same rules and audit line as the panel (core/brand/companyBrand.js).
 *
 *   node scripts/core/company-brand.mjs --company=placebo                                  show it
 *   node scripts/core/company-brand.mjs --company=placebo --colors=#0B3D91,#F2A900,#00A3E0  3-6 colours, in order:
 *                                                                                           primary, secondary, accent, extras
 *   node scripts/core/company-brand.mjs --company=placebo --logo=C:\path\logo.png           png/jpg/webp/svg, ≤ 300 KB
 *   node scripts/core/company-brand.mjs --company=placebo --clear                           back to the standard look
 *
 * Uses the DB in .env (local). For production run it with the production DB settings, or use the admin panel.
 */
import fs from "node:fs";
import path from "node:path";
import "dotenv/config";
import { pool } from "../../db.js";
import { getBrand, setBrand } from "../../core/brand/companyBrand.js";

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, ...v] = a.replace(/^--/, "").split("="); return [k, v.length ? v.join("=") : true]; }));
if (!args.company) { console.error("usage: --company=<slug> [--colors=#..,#..,#..] [--logo=file] [--clear]"); process.exit(1); }

const [[co]] = await pool.query("SELECT id, name FROM companies WHERE slug = ? AND deleted_at IS NULL", [String(args.company)]);
if (!co) { console.error(`No company "${args.company}".`); await pool.end(); process.exit(1); }

if (args.colors || args.logo || args.clear) {
  const now = await getBrand(pool, co.id);
  const body = { colors: now.colors, logo: now.logo };
  if (args.clear) { body.colors = []; body.logo = ""; }
  if (typeof args.colors === "string") body.colors = args.colors.split(",").map((s) => s.trim());
  if (typeof args.logo === "string") {
    const ext = path.extname(args.logo).toLowerCase();
    const mime = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml" }[ext];
    if (!mime) { console.error("The logo must be .png, .jpg, .webp or .svg"); process.exit(1); }
    body.logo = `data:${mime};base64,${fs.readFileSync(args.logo).toString("base64")}`;
  }
  await setBrand(pool, { companyId: co.id, userId: null, userName: "CEOFactory (script)" }, body);
}
const b = await getBrand(pool, co.id);
console.log(`${co.name}: colours ${b.colors.length ? b.colors.join(" ") : "(standard)"}; logo ${b.logo ? `${Math.round(b.logo.length / 1024)} KB` : "(none)"}`);
await pool.end();
