/**
 * Fill hrms_search_vectors for one company — the vectors behind the org chart's
 * "search by meaning".
 *
 *   node build-search-index.mjs --company=karni                       DRY RUN, local: counts only
 *   node build-search-index.mjs --company=karni --apply
 *   node build-search-index.mjs --company=karni --apply --target=prod
 *
 * Embeds every KRA / responsibility / KPI / qualification definition whose vector
 * is missing, or was made from different wording, or by a different model —
 * on THIS machine, with the built-in model (services/semantic/embedder.js). The
 * job content never goes anywhere but the target database. Writes in bulk
 * (200 rows a statement), batch by batch, so a run stopped half-way keeps what it
 * did and the next run carries on. Idempotent: a second run finds nothing stale.
 *
 * Needs hrms_search_vectors (apply-search-schema.mjs). The first run on a machine
 * downloads the model (~23 MB) into CF_HRMS_MODEL_CACHE (default multi_app_be/tmp/hf-models).
 */
import mysql from 'mysql2/promise';
import { resolveTarget, announce } from './dbTarget.mjs';
import { buildIndex } from '../services/semantic/searchIndex.js';
import { MODEL_ID, unload } from '../services/semantic/embedder.js';

const APPLY = process.argv.includes('--apply');
const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;

const slug = arg('company');
if (!slug) { console.error('--company=<slug> is required'); process.exit(2); }

const target = resolveTarget();
announce(target);
const db = await mysql.createPool({ ...target.cfg, connectionLimit: 2 });
const started = Date.now();
try {
  const [[company]] = await db.query('SELECT id, slug, name FROM companies WHERE slug = ?', [slug]);
  if (!company) throw new Error(`no company with slug "${slug}" on ${target.name}`);
  console.log(`  company: ${company.name} (#${company.id})   model: ${MODEL_ID}   ${APPLY ? 'APPLY' : 'DRY RUN (add --apply)'}\n`);

  const report = await buildIndex(db, company.id, { apply: APPLY, log: (s) => console.log(s) });
  console.log('');
  for (const [kind, c] of Object.entries(report.byKind)) {
    console.log(`  ${kind.padEnd(16)} ${String(c.definitions).padStart(5)} definitions   ${String(c.stale).padStart(5)} to embed`);
  }
  console.log(`\n  definitions ${report.definitions}, already up to date ${report.upToDate}, to embed ${report.stale}, written ${report.written}`);
  const [[{ n }]] = await db.query(
    'SELECT COUNT(*) n FROM hrms_search_vectors WHERE company_id = ? AND model = ?',
    [company.id, MODEL_ID],
  );
  console.log(`  rows in hrms_search_vectors for this company and model: ${n}`);
  console.log(`  time: ${((Date.now() - started) / 1000).toFixed(1)} s`);
} finally {
  await unload();
  await db.end();
}
