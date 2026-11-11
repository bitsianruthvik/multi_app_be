/**
 * nestExtras.js — CF_ERP. Two more ways to lay a steel out, beside the packers' own seeds (2026-11-11, nest benchmark
 * TM/nest_bench: cutstock "variant B" and pairs). Both are CANDIDATES only: the pool's own ranking (packerPool.pickBest —
 * pieces left off, sizes over the company's limit, the nestCost score) keeps them only when they are better, so neither
 * can make a steel worse.
 *
 *   PAIRS     (nestPairs.js) one more job per steel with irregular parts, dispatched with its seeds: the shape job with
 *             the best pairs / triples of irregular parts packed as composites and put back after. Its clusters are kept
 *             here by the parts' outlines, so the next run of the same pieces (the lot loop, a re-nest) skips the search.
 *   COMBINER  (nestCutStock.js) after the packers: per steel, the length combiner, with the packers' answer to beat;
 *             a phase of its own on the pool, every job under a hard wall clock (packerPool `hardDeadlineAt`). The
 *             custom sizes it buys (lot mode) come back as `newSheets`, made stand-in sheets by the caller.
 *
 * SWITCHES (per company, no migration): `combiner` and `pairs` inside cf_company_settings.nest_custom_plates JSON, read
 * like `premiumPct`; absent = ON. A caller may also say `combiner: false` / `pairs: false`. EFFORT: every level runs
 * both, each with its own caps (CUTSTOCK_EFFORT, PAIR_SEARCH_MS); the lot loop's quick PROBE passes run neither.
 */
import crypto from 'crypto';
import { runAll, pickBest } from '../lib/packerPool.js';
import { CUTSTOCK_EFFORT } from './nestCutStock.js';

/** `combiner` / `pairs` of the §90 custom-plate JSON (text or object): false only when said so. */
export function extrasOf(v) {
  let o = v;
  if (typeof o === 'string') { try { o = JSON.parse(o); } catch { o = null; } }
  const off = (x) => x === false || x === 0 || x === '0' || x === 'false';
  return { combiner: !off(o?.combiner), pairs: !off(o?.pairs) };
}

/** Effort → the pairing search's own cap (ms) and the combiner's effort row. */
export const PAIR_SEARCH_MS = Object.freeze({ quick: 20_000, standard: 60_000, deep: 180_000, long: 300_000 });
const csEffort = (e) => (e === 'long' ? 'deep' : CUTSTOCK_EFFORT[e] ? e : 'standard');

const sha = (o) => crypto.createHash('sha1').update(JSON.stringify(o)).digest('hex');
const r2 = (v) => Math.round(Number(v) * 100) / 100;
const ringKey = (rings) => {
  const o = rings && !Array.isArray(rings) ? rings.outline : Array.isArray(rings) ? (typeof rings[0]?.[0] === 'number' ? rings : rings[0]) : null;
  return o ? o.map(([x, y]) => `${r2(x)},${r2(y)}`).join(';') : null;
};
const piecesKey = (pieces) => (pieces ?? []).map((p) => [String(p.key), Number(p.qty) || 0, r2(p.length), r2(p.width), ringKey(p.rings)]);

/** A small LRU (insertion order). */
function lru(max) {
  const m = new Map();
  return { get: (k) => { if (!m.has(k)) return undefined; const v = m.get(k); m.delete(k); m.set(k, v); return v; }, set: (k, v) => { m.delete(k); m.set(k, v); while (m.size > max) m.delete(m.keys().next().value); }, clear: () => m.clear(), get size() { return m.size; } };
}
const PAIR_CACHE = lru(64);
const CUT_CACHE = lru(64);
export const clearExtrasCache = () => { PAIR_CACHE.clear(); CUT_CACHE.clear(); };

const quarterTurns = (rot) => Array.isArray(rot) && [0, 90, 180, 270].every((r) => rot.includes(r));
const IRREGULAR = 0.97;
const fillOf = (p) => {
  const o = p.rings && !Array.isArray(p.rings) ? p.rings.outline : null;
  if (!o || o.length < 3) return 1;
  let a = 0; let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (let i = 0, j = o.length - 1; i < o.length; j = i++) { a += o[j][0] * o[i][1] - o[i][0] * o[j][1]; }
  for (const [x, y] of o) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return Math.abs(a / 2) / Math.max(1e-9, (x1 - x0) * (y1 - y0));
};

/**
 * The pairs job for one steel, or null. base = the steel's shape-job input (as its round 0 gets it, seed and all).
 * opts: { effort, deadlineAt, planBudgetMs }
 */
export function pairJobFor(key, base, { effort = 'standard', deadlineAt = null, planBudgetMs = 0, minGain = 0.08 } = {}) {
  const S = base?.shape;
  if (!S || base.fillSheets?.length || base.resume || !quarterTurns(S.rotations)) return null;
  if ((S.sheets ?? []).some((s) => s.preferred)) return null;
  const irregular = (S.pieces ?? []).filter((p) => (Number(p.qty) || 0) > 0 && fillOf(p) < IRREGULAR);
  const n = irregular.reduce((a, p) => a + (Number(p.qty) || 0), 0);
  if (irregular.length < 1 || n < 2) return null;
  const ck = sha(['pairs', S.kerf, S.margin, minGain, piecesKey(S.pieces)]);
  const cached = PAIR_CACHE.get(ck);
  const grace = Math.min(30_000, Math.max(2_000, Math.round(planBudgetMs * 0.1)));   // a request's 20 s plan gets 2 s
  return {
    cacheKey: ck,
    input: { ...base, packer: 'pairs', pairs: { clusters: cached ?? null, searchMs: PAIR_SEARCH_MS[effort] ?? PAIR_SEARCH_MS.standard, minGain, triples: true },
      ...(deadlineAt ? { hardDeadlineAt: deadlineAt + grace } : {}) },
  };
}
/** Keep what a pairs job found, by its pieces. */
export function rememberPairs(cacheKey, out) {
  const p = out?.pairs;
  if (!cacheKey || !p || p.cached || !Array.isArray(p.clusters) || p.complete === false) return;
  PAIR_CACHE.set(cacheKey, p.clusters);
}

const strandedOf = (o) => (o?.unplaced ?? []).reduce((a, u) => a + (Number(u.qty) || 0), 0);

/**
 * THE COMBINER PHASE. steels: [{ key, base (the shape-job input), sheets (the plan's sheet list: stand-ins are pushed into
 * it), custom (nestCutStock custom params or null), seed }]; outBy: Map key → the packers' chosen answer (replaced
 * in place when the combiner wins). opts: { effort, workers, stop, budgetMs, standIn(steel, sheet) → a plan sheet, say }
 * → [{ key, ran, taken, why, engineScore, score, plates, enginePlates, ms, cached }]
 */
export async function cutStockPhase(steels, outBy, { effort = 'standard', workers = null, stop = null, budgetMs = null, perMs = null, standIn, say = () => {} } = {}) {
  const E = csEffort(effort);
  const per = Math.min(CUTSTOCK_EFFORT[E].totalMs, perMs ?? Infinity);   // the plan may give each steel less (nestingService: half its budget)
  // Each job has its own clock (its effort's totalMs, killed 20 s past it) and the biggest steels go first: a shared
  // deadline split in shares left the last, largest steel nothing (Thane 32 mm). `budgetMs` (tests) sets one deadline.
  const t0 = Date.now();
  const deadlineAt = budgetMs != null ? t0 + budgetMs : null;
  const report = [];
  const jobs = []; const meta = [];
  for (const st of steels) {
    const raw = outBy.get(st.key);
    const S = st.base?.shape;
    const why = !S ? 'not a shape job' : st.base.fillSheets?.length ? 'saved plates to fill' : st.base.resume ? 'picked up again'
      : (S.sheets ?? []).some((s) => s.preferred) ? 'customer plates' : raw?.packer !== 'shape' ? 'no packer answer' : strandedOf(raw) > 0 ? 'pieces left off'
        : (raw.nests ?? []).length < 2 ? 'one plate' : null;
    if (why) { report.push({ key: st.key, ran: false, why }); continue; }
    const removed = st.custom?.removed ?? [];
    const ck = sha(['cs', E, st.seed, S.kerf, S.margin, S.gap ?? null, S.rotations, S.costRules ?? null, piecesKey(S.pieces),
      (S.sheets ?? []).map((s) => [s.key, s.length, s.width, r2(s.areaCost), r2(s.penalty ?? 0), s.available, !!s.preferred]),
      st.custom ? { ...st.custom, removed: undefined } : null]);
    const engine = { off: strandedOf(raw), sizeOver: Number(raw.sizeOver) || 0, score: Number(raw.score ?? raw.areaBought) };
    const hit = CUT_CACHE.get(ck);
    if (hit && !(hit.newSheets ?? []).some((s) => removed.includes(`${s.length}x${s.width}`))) {
      meta.push({ st, raw, engine, ck, cached: hit });
      continue;
    }
    meta.push({ st, raw, engine, ck, job: jobs.length });
    jobs.push({ key: st.key, seed: st.seed, round: 0, input: {
      ...st.base, packer: 'cutstock', budgetMs: undefined, deadlineAt: undefined,
      cutstock: { effort: E, totalMs: per, custom: st.custom ?? null, engine },
      ...(deadlineAt != null ? { hardDeadlineAt: deadlineAt + 20_000 } : { hardMs: per + 20_000 }),
    } });
  }
  if (jobs.length) say(`Length combiner: ${jobs.length} steel${jobs.length === 1 ? '' : 's'}, up to ${Math.round(per / 1000)} s each`);
  const runs = jobs.length ? await runAll(jobs, { workers, deadlineAt, stop }) : [];
  for (const m of meta) {
    const r = m.cached ? { ok: true, out: m.cached } : runs[m.job];
    const out = r?.ok ? r.out : null;
    const rep = { key: m.st.key, ran: true, cached: !!m.cached, engineScore: Math.round(m.engine.score), enginePlates: (m.raw.nests ?? []).length };
    if (!m.cached && out) CUT_CACHE.set(m.ck, out);
    if (!out || out.none) { report.push({ ...rep, taken: false, why: out?.none ?? r?.error ?? (r?.skipped ? `skipped (${r.skipped})` : 'no answer'), ms: out?.cutstock?.ms ?? null, variants: out?.cutstock?.variants ?? null }); continue; }
    const won = pickBest([{ ok: true, out: m.raw, seed: 0 }, { ok: true, out, seed: 1 }]);
    const taken = won?.out === out;
    if (taken) {
      for (const s of out.newSheets ?? []) if (!m.st.sheets.some((x) => String(x.key) === String(s.key))) m.st.sheets.push(standIn(m.st, s));
      outBy.set(m.st.key, out);
    }
    report.push({ ...rep, taken, why: taken ? null : 'the packers\' layout is as good or better', score: Math.round(Number(out.score)), plates: (out.nests ?? []).length, sizeOver: out.sizeOver ?? 0, ms: out.cutstock?.ms ?? null, variant: out.cutstock?.variant ?? null, variants: out.cutstock?.variants ?? null });
  }
  return report;
}
