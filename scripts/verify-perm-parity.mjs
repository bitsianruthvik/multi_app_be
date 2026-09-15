#!/usr/bin/env node
/**
 * verify-perm-parity.mjs — PLAN.md EU-3 "What must NOT change".
 *
 * For each of the six route files EU-3 touched, extracts every
 * `(method, path, permission tag)` triple from the file as it stood at HEAD
 * (before this EU) and as it stands now in the working tree, then asserts
 * every route's tag is IDENTICAL between the two. A route gaining or losing
 * `protect`/`requirePerm` entirely is also flagged — the six files are meant
 * to end up with the SAME gate per route, just backed by the shared
 * `requirePerm` (which adds an admin bypass everywhere, including on
 * `orderItems.js`'s routes, where it did not exist before — that is the one
 * deliberate behaviour change, and it is not something a permission-TAG diff
 * can see, so it is not what this script checks).
 *
 * Usage: node scripts/verify-perm-parity.mjs   (run from multi_app_be/)
 */
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';

const FILES = [
  'apps/fab_erp/routes/templates.js',
  'apps/fab_erp/routes/orderItems.js',
  'apps/fab_erp/routes/items.js',
  'apps/fab_erp/routes/fields.js',
  'apps/fab_erp/routes/codegen.js',
  'apps/fab_erp/routes/resources.js',
];

const METHOD_RE = /router\.(get|post|put|patch|delete)\(\s*(['"])((?:(?!\2).)*)\2/g;
const PERM_RE = /requirePerm\(\s*(['"])((?:(?!\1).)*)\1\s*\)/;

/**
 * `canManage` in resources.js is `requirePerm('fab_erp_resources_manage')`
 * assigned to a variable and reused positionally rather than written inline
 * at each route — resolve that one indirection so the parser sees the same
 * tag a literal `requirePerm(...)` call would give it.
 */
function resolveAliases(text) {
  const aliases = new Map();
  const aliasRe = /const\s+(\w+)\s*=\s*requirePerm\(\s*(['"])((?:(?!\2).)*)\2\s*\)/g;
  let m;
  while ((m = aliasRe.exec(text))) aliases.set(m[1], m[3]);
  return aliases;
}

/** @returns {Array<{method:string, path:string, tag:string|null}>} */
function extractRoutes(text) {
  const aliases = resolveAliases(text);
  const routes = [];
  const calls = [...text.matchAll(METHOD_RE)];
  for (let i = 0; i < calls.length; i += 1) {
    const call = calls[i];
    const method = call[1].toUpperCase();
    const path = call[3];
    // The slice of source between this route call and the next one (or a
    // generous window) is where its own middleware list lives.
    const start = call.index;
    const end = i + 1 < calls.length ? calls[i + 1].index : Math.min(text.length, start + 2000);
    const slice = text.slice(start, end);
    const permMatch = slice.match(PERM_RE);
    let tag = permMatch ? permMatch[2] : null;
    if (!tag) {
      // An alias used positionally, e.g. `router.get(path, protect, canManage, ...)`.
      for (const [name, aliasTag] of aliases) {
        const re = new RegExp(`,\\s*${name}\\s*[,)]`);
        if (re.test(slice.split(/async\s*\(/)[0] ?? slice)) { tag = aliasTag; break; }
      }
    }
    routes.push({ method, path, tag });
  }
  return routes;
}

function loadBefore(file) {
  try {
    return execFileSync('git', ['show', `HEAD:${file}`], { encoding: 'utf8' });
  } catch (err) {
    throw new Error(`Could not read HEAD:${file} — ${err.message}`);
  }
}

function key(r) { return `${r.method} ${r.path}`; }

let failures = 0;
let checked = 0;
const knownChanges = [];

for (const file of FILES) {
  const before = extractRoutes(loadBefore(file));
  const after = extractRoutes(readFileSync(file, 'utf8'));
  const beforeByKey = new Map(before.map((r) => [key(r), r]));
  const afterByKey = new Map(after.map((r) => [key(r), r]));

  for (const [k, b] of beforeByKey) {
    checked += 1;
    const a = afterByKey.get(k);
    if (!a) { console.error(`MISSING AFTER: ${file} ${k} (was present at HEAD, gone now)`); failures += 1; continue; }
    if (a.tag !== b.tag) {
      console.error(`TAG CHANGED: ${file} ${k}: "${b.tag}" -> "${a.tag}"`);
      failures += 1;
    }
  }
  for (const [k] of afterByKey) {
    if (!beforeByKey.has(k)) knownChanges.push(`${file} ${k} (new route)`);
  }
}

console.log(`Checked ${checked} routes across ${FILES.length} files.`);
if (knownChanges.length) {
  console.log('New routes not present at HEAD (expected: none for EU-3):');
  knownChanges.forEach((c) => console.log(`  ${c}`));
}
if (failures) {
  console.error(`${failures} permission-tag mismatch(es). FAIL.`);
  process.exit(1);
}
console.log('PASS: every route\'s permission tag is unchanged.');
