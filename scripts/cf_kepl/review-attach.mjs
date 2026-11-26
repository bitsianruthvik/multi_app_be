/**
 * review-attach.mjs — keep a structure's DRAWING REVIEW with its standard drawing, so the app's drawing viewer shows it
 * (services/reviewService.js; user, 2026-11-26: "we should be able to see the part by part comparison and all of those
 * screens we build in the image viewer").
 *
 * The review is the folder drawing_bom's review build writes (`node src/review/build.mjs out/<SET>` → TM/review/<SET>:
 * index.html, data.js, img/). It is stored as one bundle of cf_standard_drawing_files rows (kind 'review', version_id
 * NULL, `mark` = the bundle key): the page, its data as JSON and every image (base64), one row each. The standard's
 * stored model must be the package's model.json byte for byte (sha1), or the review describes another structure: refused
 * unless --force. The older bundle is retired in the same transaction; rows are written in small statements (an image
 * is at most a few MB).
 *
 * DRY RUN BY DEFAULT (reads the folder, checks the model, writes nothing).
 *   node scripts/cf_kepl/review-attach.mjs --company 30005 --standard 6390005 --dir ../review/OWG_30M5_v2 [--model ../drawing_bom/out/OWG_30M5_v2/model.json] [--apply] [--force]
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath, pathToFileURL } from 'url';
const __dir = path.dirname(fileURLToPath(import.meta.url));
const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const COMPANY = Number(arg('company')); const STANDARD = Number(arg('standard')); const DIR = arg('dir') ? path.resolve(arg('dir')) : null;
const APPLY = process.argv.includes('--apply'); const FORCE = process.argv.includes('--force');
if (!COMPANY || !STANDARD || !DIR) { console.error('Usage: --company <id> --standard <id> --dir <review folder> [--model <model.json>] [--apply] [--force]'); process.exit(2); }
const sha = (s) => crypto.createHash('sha1').update(s, 'utf8').digest('hex');

// ---- the folder
const page = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');
const dataJs = fs.readFileSync(path.join(DIR, 'data.js'), 'utf8');
const m = /^\s*window\.REVIEW\s*=\s*([^]*?);?\s*$/.exec(dataJs); if (!m) throw new Error('data.js: not "window.REVIEW = {…};"');
const data = JSON.parse(m[1]); const dataJson = JSON.stringify(data);
if (!page.includes('REVIEW_EMBED')) throw new Error('index.html is an older review page (no REVIEW_EMBED bridge): rebuild it with drawing_bom src/review/build.mjs');
const imgs = fs.existsSync(path.join(DIR, 'img')) ? fs.readdirSync(path.join(DIR, 'img')).filter((f) => /^[A-Za-z0-9._-]{1,200}$/.test(f) && /\.(jpe?g|png)$/i.test(f)) : [];
const set = data.summary?.set ?? path.basename(DIR);
const modelFile = arg('model') ? path.resolve(arg('model')) : path.resolve(__dir, '..', '..', '..', 'drawing_bom', 'out', set, 'model.json');
const units = data.units ?? []; const cov = data.coverage ?? [];
const summary = {
  designs: units.length, red: units.filter((u) => u.status === 'red').length, amber: units.filter((u) => u.status === 'amber').length, green: units.filter((u) => u.status === 'green').length,
  questions: (data.questions ?? []).length, engineer: (data.questions ?? []).filter((q) => q.decision?.confidence === 'engineer').length,
  checklist: cov.length, attention: cov.filter((c) => ['open', 'missing', 'conflict'].includes(c.status)).length,
};
const bytes = imgs.reduce((s, f) => s + fs.statSync(path.join(DIR, 'img', f)).size, 0);
console.log(`${set}: page ${Math.round(page.length / 1024)} kB, data ${Math.round(dataJson.length / 1024)} kB, ${imgs.length} images ${Math.round(bytes / 1048576)} MB; ${summary.designs} designs (${summary.red} red, ${summary.amber} amber, ${summary.green} green), ${summary.questions} doubts, ${summary.checklist} checklist items`);

const { pool } = await import(pathToFileURL(path.join(__dir, '..', '..', 'db.js')).href);
const db = await pool.getConnection();
try {
  const [[std]] = await db.query('SELECT id, number AS code FROM cf_standard_drawings WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [COMPANY, STANDARD]);
  if (!std) throw new Error(`standard ${STANDARD} not found in company ${COMPANY}`);
  const [[mod]] = await db.query("SELECT file_text FROM cf_standard_drawing_files WHERE company_id = ? AND standard_id = ? AND kind = 'model' AND deleted_at IS NULL ORDER BY id DESC LIMIT 1", [COMPANY, STANDARD]);
  const liveSha = mod ? sha(String(mod.file_text ?? '')) : null;
  const pkgSha = fs.existsSync(modelFile) ? sha(fs.readFileSync(modelFile, 'utf8')) : null;
  const same = liveSha && pkgSha && liveSha === pkgSha;
  console.log(`standard ${std.code}: stored model ${liveSha ? liveSha.slice(0, 10) : 'none'}, package model ${pkgSha ? pkgSha.slice(0, 10) : 'not found'} — ${same ? 'the same' : 'DIFFERENT'}`);
  if (!same && !FORCE) throw new Error('the review was built from another model than the one stored: attach the model first (model3d-attach), or --force');
  const [[had]] = await db.query("SELECT COUNT(*) n FROM cf_standard_drawing_files WHERE company_id = ? AND standard_id = ? AND kind = 'review' AND deleted_at IS NULL", [COMPANY, STANDARD]);
  if (!APPLY) { console.log(`DRY RUN: would retire ${had.n} review rows and write ${imgs.length + 2}. Add --apply.`); process.exit(0); }
  const key = `review:${Date.now()}`;
  const meta = JSON.stringify({ set, built: data.summary?.built ?? null, modelSha: pkgSha, summary });
  const ins = (name, kind, text, warnings = null) => db.query(
    "INSERT INTO cf_standard_drawing_files (company_id, version_id, standard_id, kind, drawing_id, mark, mark_norm, file_name, file_kind, warnings_json, file_text) VALUES (?, NULL, ?, 'review', NULL, ?, NULL, ?, ?, ?, ?)",
    [COMPANY, STANDARD, key, name, kind, warnings, text]);
  // The images and data first, the page last: the page row is what makes a bundle visible (reviewService reads the newest page).
  // Written outside one long transaction (TiDB limits a transaction's size); the old bundle is retired only once the new one is whole.
  // a bundle an earlier run left without its page (it stopped half way) is retired first
  await db.query(`UPDATE cf_standard_drawing_files SET deleted_at = NOW() WHERE company_id = ? AND standard_id = ? AND kind = 'review' AND deleted_at IS NULL
    AND mark NOT IN (SELECT k FROM (SELECT mark AS k FROM cf_standard_drawing_files WHERE company_id = ? AND standard_id = ? AND kind = 'review' AND file_name = 'index.html' AND deleted_at IS NULL) x)`, [COMPANY, STANDARD, COMPANY, STANDARD]);
  let n = 0;
  for (const f of imgs) { await ins(`img/${f}`, /\.png$/i.test(f) ? 'png' : 'jpg', fs.readFileSync(path.join(DIR, 'img', f)).toString('base64')); if (++n % 25 === 0) console.log(`  ${n} of ${imgs.length} images`); }
  await ins('data.json', 'json', dataJson);
  await db.beginTransaction();
  await db.query("UPDATE cf_standard_drawing_files SET deleted_at = NOW() WHERE company_id = ? AND standard_id = ? AND kind = 'review' AND deleted_at IS NULL AND (mark IS NULL OR mark <> ?)", [COMPANY, STANDARD, key]);
  await ins('index.html', 'html', page, meta);
  await db.commit();
  console.log(`saved ${set} on ${std.code} (bundle ${key}): ${imgs.length + 2} rows; ${had.n} older rows retired`);
} catch (e) {
  try { await db.rollback(); } catch { /* none open */ }
  console.error(`FAIL: ${e.message}`); process.exitCode = 1;
} finally { db.release(); await pool.end(); }
