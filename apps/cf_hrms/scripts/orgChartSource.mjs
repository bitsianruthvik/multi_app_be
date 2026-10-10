/**
 * WHICH FILE are we talking about? Plumbing only — deliberately no interpretation.
 *
 * The importer and the verifier must read the SAME bytes, or the verification is
 * theatre: a verifier still pointed at Org_Chart_V12.html while the importer has
 * moved to V28 would pass every check it could still find and prove nothing.
 * So the path list and the read live here, once, and both scripts import them.
 *
 * What does NOT live here: the ancestor walks, the department resolution, the
 * dedupe keys. Those are the meaning of the file, and the verifier re-derives
 * them independently on purpose — a shared helper that is wrong is wrong in both
 * directions at once and no check can see it.
 *
 * The file is a download, so the search order starts where the user said it is
 * (the TM root) and falls back to the browser's download folder, which is where
 * V12 and V28 have both actually been so far. `--source=<path>` overrides.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const TM_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const HOME = process.env.USERPROFILE || process.env.HOME || '';

export const DEFAULT_FILE_NAME = 'Org_Chart_V28.html';
/** The revision before it, used only to report what changed between the two. */
export const PREVIOUS_FILE_NAME = 'Org_Chart_V12.html';

export function resolveSource(argv = process.argv, fileName = DEFAULT_FILE_NAME, { flag = 'source', optional = false } = {}) {
  const explicit = (argv.find((a) => a.startsWith(`--${flag}=`)) || '').split('=').slice(1).join('=');
  const candidates = explicit
    ? [explicit]
    : [path.join(TM_ROOT, fileName), path.join(HOME, 'Downloads', fileName)];
  const found = candidates.find((p) => p && fs.existsSync(p));
  if (!found) {
    if (optional) return null;
    throw new Error(`Cannot find ${fileName}. Looked in:\n  ${candidates.join('\n  ')}\nPass --${flag}=<path> to point at it.`);
  }
  return found;
}

/** The seed block, the bytes' hash, and the size — the three things a run records. */
export function readSeed(file) {
  const html = fs.readFileSync(file, 'utf8');
  const m = html.match(/<script id="seed" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) throw new Error(`No <script id="seed"> block in ${file}.`);
  return {
    file,
    fileName: path.basename(file),
    seed: JSON.parse(m[1]),
    hash: crypto.createHash('sha256').update(html).digest('hex'),
    size: Buffer.byteLength(html),
  };
}

/**
 * THE ADJUSTMENTS FILE — decisions a person made that the chart cannot express
 * ("IBC 1/2/3 is three machines", "this seat is not shared after all").
 *
 * Optional. Found next to the source by name — `Org_Chart_V28.html` ->
 * `Org_Chart_V28.adjustments.json` — or named with `--adjustments=<path>`;
 * `--no-adjustments` reads the chart alone. Like the source, the importer and
 * the verifier must read the SAME bytes, so the path rule and the read live
 * here. What the entries MEAN does not: each script interprets them itself.
 */
export function resolveAdjustments(sourceFile, argv = process.argv) {
  if (argv.includes('--no-adjustments')) return null;
  const explicit = (argv.find((a) => a.startsWith('--adjustments=')) || '').split('=').slice(1).join('=');
  if (explicit) {
    if (!fs.existsSync(explicit)) throw new Error(`--adjustments=${explicit}: no such file.`);
    return explicit;
  }
  const beside = sourceFile.replace(/\.[^.\\/]+$/, '') + '.adjustments.json';
  return fs.existsSync(beside) ? beside : null;
}

/** The parsed file, its hash and its name — or null when there is none. */
export function readAdjustments(file) {
  if (!file) return null;
  const text = fs.readFileSync(file, 'utf8');
  let json;
  try { json = JSON.parse(text); } catch (e) { throw new Error(`${file} is not valid JSON: ${e.message}`); }
  if (!json || !Array.isArray(json.adjustments)) throw new Error(`${file} has no "adjustments" array.`);
  return {
    file,
    fileName: path.basename(file),
    forSource: json.forSource ?? null,
    entries: json.adjustments,
    hash: crypto.createHash('sha256').update(text).digest('hex'),
  };
}
