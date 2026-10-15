/**
 * searchIndex.js — the stored sentence vectors behind "search by meaning", and
 * how they stay fresh.
 *
 * ONE ROW PER DEFINITION, KEYED BY MODEL (hrms_search_vectors, init.sql §16).
 * The text embedded is the definition's wording (`definitionText`): the name, plus
 * the description when it says something the name does not. Karni's importer
 * stores most duties with the description equal to the name, or the name cut
 * short with "..." and the whole sentence in the description — embedding the same
 * sentence twice would only double the work.
 *
 * FRESHNESS IS THE HASH CHECK, NOTHING ELSE. Every search reads the definitions
 * it ranks (it needs their text for the keyword signal anyway) and compares each
 * one's SHA-256 with the stored `text_hash`. A definition that is new, or whose
 * wording changed through ANY path — the role editor, a seat's own line, an
 * import, a hand edit — is "stale" the moment it changes; no write path has to
 * remember to mark anything. A search embeds at most `INLINE_CAP` stale ones
 * itself and stores them; any beyond that are matched by keyword only for that
 * request (and listed in `pending`), so a search never waits minutes behind a
 * bulk import. `build-search-index.mjs` fills the rest in one go.
 *
 * THE PER-PROCESS CACHE. A company's vectors (~1,200 x 1.5 KB for Karni) are read
 * once and kept, keyed by company + model. A write through this module updates
 * the cache in place; vectors written by another process (the build script run
 * against production) are picked up when a search finds something stale and the
 * cache is older than `RELOAD_AFTER_MS`, or after `CACHE_TTL_MS` regardless.
 */
import crypto from 'node:crypto';
import { embed, MODEL_ID, toBlob, fromBlob } from './embedder.js';

/** The four masters a search ranks. QUALIFICATION has no position overlay (contentResolver.js). */
export const DEFINITION_SOURCES = {
  KRA: 'hrms_kra_definitions',
  RESPONSIBILITY: 'hrms_responsibility_definitions',
  KPI: 'hrms_kpi_definitions',
  QUALIFICATION: 'hrms_qualification_definitions',
};
export const ALL_KINDS = Object.keys(DEFINITION_SOURCES);

export const INLINE_CAP = Number(process.env.CF_HRMS_SEARCH_INLINE_CAP) || 32;
const CACHE_TTL_MS = 10 * 60 * 1000;
const RELOAD_AFTER_MS = 15 * 1000;
const INSERT_BATCH = 200;

const same = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();

/** The words a definition says, once. Mirrors jobContentService's "cut short" reading. */
export function definitionText(name, description) {
  const n = String(name ?? '').trim();
  const d = String(description ?? '').trim();
  if (!d || same(n, d)) return n;
  if (/(\.\.\.|…)$/.test(n)) {
    const stem = n.replace(/(\.\.\.|…)$/, '').trim().toLowerCase();
    if (stem && d.toLowerCase().startsWith(stem)) return d;
  }
  if (!n) return d;
  return `${n}. ${d}`;
}

export const textHash = (text) => crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');

const keyOf = (kind, id) => `${kind}:${Number(id)}`;

/**
 * Every live definition of the given kinds: { kind, id, name, description, text, hash }.
 * One query per kind, in parallel.
 */
export async function loadDefinitions(db, companyId, kinds = ALL_KINDS) {
  const lists = await Promise.all(kinds.map(async (kind) => {
    const [rows] = await db.query(
      `SELECT id, name, description FROM ${DEFINITION_SOURCES[kind]}
        WHERE company_id = ? AND deleted_at IS NULL`,
      [companyId],
    );
    return rows.map((r) => {
      const text = definitionText(r.name, r.description);
      return { kind, id: Number(r.id), name: r.name, description: r.description, text, hash: textHash(text) };
    });
  }));
  return lists.flat();
}

/* ── the cache ─────────────────────────────────────────────────────────── */

const cache = new Map();   // `${companyId}|${model}` -> { at, vectors: Map(key -> { hash, vec }) }

async function readVectors(db, companyId) {
  const [rows] = await db.query(
    'SELECT kind, definition_id, text_hash, dims, vector FROM hrms_search_vectors WHERE company_id = ? AND model = ? AND deleted_at IS NULL',
    [companyId, MODEL_ID],
  );
  const vectors = new Map();
  for (const r of rows) vectors.set(keyOf(r.kind, r.definition_id), { hash: r.text_hash, vec: fromBlob(r.vector) });
  const entry = { at: Date.now(), vectors };
  cache.set(`${companyId}|${MODEL_ID}`, entry);
  return entry;
}

async function cached(db, companyId) {
  const entry = cache.get(`${companyId}|${MODEL_ID}`);
  if (entry && Date.now() - entry.at < CACHE_TTL_MS) return entry;
  return readVectors(db, companyId);
}

/** Forget a company's cached vectors (tests; or after an outside rebuild). */
export function invalidateVectors(companyId = null) {
  if (companyId == null) cache.clear();
  else cache.delete(`${companyId}|${MODEL_ID}`);
}

const staleIn = (defs, vectors) => defs.filter((d) => vectors.get(keyOf(d.kind, d.id))?.hash !== d.hash);

/** Bulk upsert, INSERT_BATCH rows a statement — production round trips cost ~50 ms each. */
export async function writeVectors(db, companyId, rows) {
  for (let i = 0; i < rows.length; i += INSERT_BATCH) {
    const chunk = rows.slice(i, i + INSERT_BATCH);
    await db.query(
      `INSERT INTO hrms_search_vectors (company_id, kind, definition_id, text_hash, model, dims, vector)
       VALUES ${chunk.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(', ')}
       ON DUPLICATE KEY UPDATE text_hash = VALUES(text_hash), dims = VALUES(dims), vector = VALUES(vector), deleted_at = NULL`,
      chunk.flatMap((r) => [companyId, r.kind, r.id, r.hash, MODEL_ID, r.vec.length, toBlob(r.vec)]),
    );
  }
}

/**
 * The vectors a search needs, embedding at most `cap` stale definitions inline.
 *   -> { vectors: Map(key -> Float32Array), pending: [{kind, id}], embedded: n }
 * `pending` are definitions with no usable vector this time (beyond the cap):
 * the caller matches them by keyword only. Throws ModelUnavailable only when it
 * has to embed and cannot — the caller then falls back to keyword mode.
 */
export async function vectorsFor(db, companyId, defs, { cap = INLINE_CAP } = {}) {
  let entry = await cached(db, companyId);
  let stale = staleIn(defs, entry.vectors);
  if (stale.length && Date.now() - entry.at > RELOAD_AFTER_MS) {
    // Maybe another process (the build script) has written them since we read.
    entry = await readVectors(db, companyId);
    stale = staleIn(defs, entry.vectors);
  }
  const now = stale.slice(0, Math.max(0, cap));
  const pending = stale.slice(now.length).map((d) => ({ kind: d.kind, id: d.id }));
  if (now.length) {
    const vecs = await embed(now.map((d) => d.text));
    const rows = now.map((d, i) => ({ ...d, vec: vecs[i] }));
    await writeVectors(db, companyId, rows);
    for (const r of rows) entry.vectors.set(keyOf(r.kind, r.id), { hash: r.hash, vec: r.vec });
  }
  const pendingKeys = new Set(pending.map((p) => keyOf(p.kind, p.id)));
  const vectors = new Map();
  for (const d of defs) {
    const k = keyOf(d.kind, d.id);
    if (pendingKeys.has(k)) continue;
    const v = entry.vectors.get(k);
    if (v && v.hash === d.hash) vectors.set(k, v.vec);
  }
  return { vectors, pending, embedded: now.length };
}

/**
 * The whole index for one company — what build-search-index.mjs runs.
 * Dry run unless `apply`. Embeds in batches of `batch` and writes each batch as
 * it goes, so a run that is stopped half-way keeps what it did.
 */
export async function buildIndex(db, companyId, { apply = false, batch = 64, log = () => {} } = {}) {
  const defs = await loadDefinitions(db, companyId, ALL_KINDS);
  const [rows] = await db.query(
    'SELECT kind, definition_id, text_hash FROM hrms_search_vectors WHERE company_id = ? AND model = ? AND deleted_at IS NULL',
    [companyId, MODEL_ID],
  );
  const have = new Map(rows.map((r) => [keyOf(r.kind, r.definition_id), r.text_hash]));
  const stale = defs.filter((d) => have.get(keyOf(d.kind, d.id)) !== d.hash);
  const byKind = {};
  for (const d of defs) {
    byKind[d.kind] ??= { definitions: 0, stale: 0 };
    byKind[d.kind].definitions += 1;
  }
  for (const d of stale) byKind[d.kind].stale += 1;
  const report = { definitions: defs.length, upToDate: defs.length - stale.length, stale: stale.length, written: 0, byKind };
  if (!apply || !stale.length) return report;

  for (let i = 0; i < stale.length; i += batch) {
    const chunk = stale.slice(i, i + batch);
    const vecs = await embed(chunk.map((d) => d.text));
    await writeVectors(db, companyId, chunk.map((d, j) => ({ ...d, vec: vecs[j] })));
    report.written += chunk.length;
    log(`  embedded ${report.written} / ${stale.length}`);
  }
  invalidateVectors(companyId);
  return report;
}
