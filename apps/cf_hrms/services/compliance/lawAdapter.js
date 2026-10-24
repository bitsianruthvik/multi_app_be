/**
 * lawAdapter.js — the ONE door from compliance (spec §36.4, §36.5) to the law layer (spec §36.1, C1).
 *
 * The law layer lives in services/law (another agent's): hrms_law_rules, versioned, DRAFT → PUBLISHED.
 * It exports from services/law/index.js:
 *
 *   listRules(db, filter?)                 every rule (any status), for linking a notice to a rule
 *   rulesInForce(companyId, on)            the rules that apply to a company on a date
 *   draftVersion(db, input, user)          a new DRAFT version of a rule
 *   publishVersion(db, versionId, reviewer) publish it (the law layer runs the worked examples)
 *   onPublish(fn)                          fn(version) after every publish
 *   (optional) runSnapshot(db, companyId, runId)   the rule versions a payroll run used
 *
 * Until that module exists — and for anything it does not export — this file answers from what is
 * here today (THE STUB, said in every answer as `via: 'ADAPTER'`):
 *
 *   rules in force   hrms_tax_rules of the tax year (domain TAX, jurisdiction IN; global) and the
 *                    company's own hrms_pay_statutory_settings rows in force (PF / ESI / PT / LWF — per
 *                    company today; the law layer moves them to global rule sets)
 *   drafts           not stored: the console sends the new value with "Publish", and the publication
 *                    row (hrms_compliance_publications) keeps it
 *   publish          writes nothing in any rule table; compliance records the publication and notifies
 *   run snapshot     none: the trace reads the run's stored lines and tax_json
 *
 * Everything else in services/compliance calls these functions and never imports services/law itself,
 * so wiring the law layer in is this file only.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { pool } from '../../lib/db.js';

const LAW_INDEX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'law', 'index.js');
const WANT = ['listRules', 'rulesInForce', 'draftVersion', 'publishVersion', 'onPublish'];

let loaded = null; // { mod, have: Set, missing: [] }
const listeners = new Set();
let hooked = false;

/** The law layer's module, or null while it is not there (or does not load). Read once per process. */
async function law() {
  if (loaded) return loaded;
  let mod = null;
  let error = null;
  if (fs.existsSync(LAW_INDEX)) {
    try { mod = await import('../law/index.js'); } catch (e) { error = e.message; }
  }
  const have = new Set(mod ? WANT.filter((k) => typeof (mod[k] ?? mod.default?.[k]) === 'function') : []);
  const fn = (k) => (mod ? (mod[k] ?? mod.default?.[k]) : null);
  loaded = { mod, fn, have, missing: WANT.filter((k) => !have.has(k)), error, snapshot: typeof fn('runSnapshot') === 'function' };
  return loaded;
}

/** For a test: forget what was loaded (the module itself stays cached by Node). */
export function forgetLaw() { loaded = null; }

/** What is wired: { connected, missing: [...], error } — the console shows it. */
export async function lawStatus() {
  const l = await law();
  return { connected: l.have.size === WANT.length, present: Boolean(l.mod), missing: l.missing, runSnapshot: l.snapshot, error: l.error };
}

/* ── the stub's rule list ─────────────────────────────────────────────── */

const json = (v, d = null) => { if (v == null) return d; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch { return d; } };
const dateText = (v) => (v == null ? null : (v instanceof Date ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}` : String(v).slice(0, 10)));
export const taxYearOf = (day) => { const y = Number(day.slice(0, 4)); const m = Number(day.slice(5, 7)); const s = m >= 4 ? y : y - 1; return `${s}-${String((s + 1) % 100).padStart(2, '0')}`; };

/** The stub: rules in force for a company on a date, in the law layer's shape. */
async function stubRulesInForce(db, companyId, on) {
  const year = taxYearOf(on);
  const out = [];
  const [tax] = await db.query('SELECT id, regime, rule_key, value_json, source_note, source_url, verified, updated_at FROM hrms_tax_rules WHERE tax_year = ? AND deleted_at IS NULL ORDER BY rule_key, regime', [year]);
  for (const r of tax) {
    out.push({
      id: `tax:${r.id}`, domain: 'TAX', jurisdiction: 'IN', ruleKey: r.regime === 'OLD' ? `${r.rule_key} (old regime)` : r.rule_key, taxYear: year, regime: r.regime,
      value: json(r.value_json, {}), effectiveFrom: `${year.slice(0, 4)}-04-01`, effectiveTo: null, version: 1, status: 'PUBLISHED',
      sourceUrl: r.source_url ?? null, sourceNote: r.source_note ?? null, verified: Boolean(r.verified), via: 'ADAPTER',
    });
  }
  if (companyId) {
    const [stat] = await db.query(
      `SELECT s.id, s.kind, s.state_code, s.effective_from, s.settings_json, s.source, s.source_url, s.verification
         FROM hrms_pay_statutory_settings s
        WHERE s.company_id = ? AND s.deleted_at IS NULL AND s.effective_from <= ?
          AND s.effective_from = (SELECT MAX(x.effective_from) FROM hrms_pay_statutory_settings x WHERE x.company_id = s.company_id AND x.kind = s.kind AND x.state_code = s.state_code AND x.deleted_at IS NULL AND x.effective_from <= ?)
        ORDER BY s.kind, s.state_code`, [companyId, on, on]);
    for (const r of stat) {
      out.push({
        id: `stat:${r.id}`, domain: r.kind, jurisdiction: r.state_code || 'IN', ruleKey: r.kind.toLowerCase(), value: json(r.settings_json, {}),
        effectiveFrom: dateText(r.effective_from), effectiveTo: null, version: 1, status: 'PUBLISHED',
        sourceUrl: r.source_url ?? null, sourceNote: r.source ?? null, verified: r.verification === 'VERIFIED', via: 'ADAPTER',
      });
    }
  }
  return out;
}

/** The law layer's shape, whatever it calls its fields. */
function normalise(r) {
  const v = r.value ?? json(r.value_json ?? r.valueJson, {});
  return {
    id: r.id, domain: r.domain, jurisdiction: r.jurisdiction ?? 'IN', ruleKey: r.ruleKey ?? r.rule_key, value: v,
    effectiveFrom: dateText(r.effectiveFrom ?? r.effective_from), effectiveTo: dateText(r.effectiveTo ?? r.effective_to),
    version: r.version ?? 1, status: r.status ?? 'PUBLISHED', sourceUrl: r.sourceUrl ?? r.source_url ?? null, sourceNote: r.sourceNote ?? r.source_note ?? null,
    verified: Boolean(r.verified), reviewBy: dateText(r.reviewBy ?? r.review_by), examples: r.examples ?? r.workedExamples ?? v?.examples ?? null,
    taxYear: r.taxYear ?? r.tax_year ?? null, regime: r.regime ?? null, title: r.title ?? null, reviewedBy: r.reviewedBy ?? r.reviewed_by ?? null, via: 'LAW_LAYER',
  };
}

/** Every rule that applies to a company on a date (the law layer's, or the stub's). */
export async function rulesInForce(companyId, on, db = pool) {
  const l = await law();
  if (l.have.has('rulesInForce')) {
    const rows = await l.fn('rulesInForce')(companyId, on);
    return (Array.isArray(rows) ? rows : rows?.rules ?? []).map(normalise);
  }
  return stubRulesInForce(db, companyId, on);
}

/** Every rule known, for linking a notice: [{ domain, jurisdiction, ruleKey, versions }]. */
export async function listRules(db = pool, filter = {}) {
  const l = await law();
  let rows;
  if (l.have.has('listRules')) rows = (await l.fn('listRules')(db, filter) ?? []).map(normalise);
  else {
    rows = await stubRulesInForce(db, null, new Date().toISOString().slice(0, 10));
    const [kinds] = await db.query('SELECT DISTINCT kind, state_code FROM hrms_pay_statutory_settings WHERE deleted_at IS NULL');
    for (const k of kinds) rows.push({ domain: k.kind, jurisdiction: k.state_code || 'IN', ruleKey: k.kind.toLowerCase(), via: 'ADAPTER' });
  }
  const seen = new Map();
  for (const r of rows) {
    const key = `${r.domain}|${r.jurisdiction}|${r.ruleKey}`;
    if (!seen.has(key)) seen.set(key, { domain: r.domain, jurisdiction: r.jurisdiction, ruleKey: r.ruleKey, versions: 0, via: r.via });
    seen.get(key).versions += 1;
  }
  return [...seen.values()].sort((a, b) => `${a.domain}${a.jurisdiction}${a.ruleKey}`.localeCompare(`${b.domain}${b.jurisdiction}${b.ruleKey}`));
}

/** The law layer's writer: a platform admin of the product team ({ kind: 'PLATFORM', userId, name }). */
export const actorOf = (user) => ({ kind: 'PLATFORM', userId: user?.id ?? null, name: user?.name ?? user?.email ?? null });

/** A DRAFT version through the law layer; with the stub, nothing is stored (null). */
export async function draftVersion(db, input, user) {
  const l = await law();
  if (!l.have.has('draftVersion')) return null;
  const v = await l.fn('draftVersion')(db, input, actorOf(user));
  return v ? normalise(v) : null;
}

/**
 * Publish. Through the law layer when it is there (its onPublish fires too — handled idempotently by
 * the caller); the stub publishes nothing anywhere and returns { via: 'ADAPTER' }.
 */
export async function publishVersion(db, versionId, reviewer) {
  const l = await law();
  if (l.have.has('publishVersion') && versionId) {
    const v = await l.fn('publishVersion')(db, versionId, actorOf(reviewer));
    return { via: 'LAW_LAYER', version: v ? normalise(v) : null };
  }
  return { via: 'ADAPTER', version: null };
}

/**
 * fn(version) after every publish — the law layer's own publishes (its screens) and ours. Registers
 * with the law layer's onPublish once it is there; with the stub, publishFromConsole calls it.
 */
export async function onPublish(fn) {
  listeners.add(fn);
  const l = await law();
  if (!hooked && l.have.has('onPublish')) {
    hooked = true;
    l.fn('onPublish')(async (version) => { for (const f of listeners) await f(normalise(version)); });
  }
  return () => listeners.delete(fn);
}
/** The stub's publish fires the listeners itself. */
export async function fireStubPublish(version) {
  for (const f of listeners) await f(version);
}

/** The rule versions a run used: the law layer's snapshot, or null (the trace then reads the run's own lines). */
export async function runSnapshot(db, companyId, runId) {
  const l = await law();
  if (!l.snapshot) return null;
  const s = await l.fn('runSnapshot')(db, companyId, runId);
  if (!s) return null;
  if (Array.isArray(s.rules)) return { ...s, rules: s.rules.map(normalise) };
  // The law layer keeps ids ({ law: [ids], tax: [ids] }): read each version back.
  const get = l.fn('getVersion');
  if (typeof get !== 'function') return null;
  const ids = [...(s.law ?? []).map(String), ...(s.tax ?? []).map((t) => (String(t).startsWith('tax:') ? String(t) : `tax:${t}`))];
  const rules = [];
  for (const id of ids) { const v = await get(db, id); if (v) rules.push(normalise(v)); }
  return { ...s, rules };
}

/**
 * Recompute a run with exactly the versions it stored and compare every line (the law layer's
 * reproduceRun: in a savepoint on `db`, rolled back — nothing is written). null without the law layer.
 */
export async function reproduceRun(db, c, runId) {
  const l = await law();
  const fn = l.fn ? l.fn('reproduceRun') : null;
  if (typeof fn !== 'function') return null;
  return fn(db, c, runId);
}

/** A rule set's fingerprint: the versions and values of its rules. A new version changes it. */
export function fingerprint(rules) {
  const s = rules.map((r) => `${r.ruleKey}|${r.id}|${r.version}|${r.effectiveFrom}|${JSON.stringify(r.value)}`).sort().join('\n');
  return crypto.createHash('sha256').update(s).digest('hex');
}

export default { lawStatus, rulesInForce, listRules, draftVersion, publishVersion, onPublish, fireStubPublish, runSnapshot, reproduceRun, fingerprint, forgetLaw, taxYearOf };
