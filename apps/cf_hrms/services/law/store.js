/**
 * store.js — the law versions themselves: hrms_law_rules (and hrms_tax_rules, published the same
 * way). (TM/CF_HRMS_HIRING_SPEC.md §36.1; models/init.sql §37.)
 *
 * RULES OF THE STORE
 *   - A version is DRAFT → PUBLISHED → SUPERSEDED. Only a DRAFT is ever changed (updateDraft) or
 *     thrown away (discardDraft, a soft delete). A PUBLISHED row is never edited: the one write it
 *     ever gets is its status becoming SUPERSEDED when a newer version of the SAME rule and date
 *     (domain, jurisdiction, rule_key, effective_from — for tax: tax_year, regime, rule_key) is
 *     published. There is no other UPDATE of hrms_law_rules in the code.
 *   - Several effective dates of one rule are all PUBLISHED: each is in force from its date until the
 *     next one (or its own effective_to).
 *   - Only the product side writes: every write takes an `actor` that is { kind: 'PLATFORM', userId,
 *     name } (a live platform_admins row) or { kind: 'SCRIPT', name } (the seed and migration
 *     scripts). A company login ({ companyId, … }) is refused with 403 LAW_IS_PRODUCT.
 *   - Before publishing, the value is checked for its domain (validate.js) and its worked examples
 *     (value.examples) are run; a failing one refuses the publish.
 */
import { HrmsError } from '../../lib/errors.js';
import { noteLaw, noteTax, currentLaw } from './pin.js';
import { valueProblems, runExamples } from './validate.js';

export const STATUSES = ['DRAFT', 'PUBLISHED', 'SUPERSEDED'];
export const DOMAINS = ['PF', 'ESI', 'PT', 'LWF', 'MIN_WAGE', 'BONUS', 'GRATUITY', 'OVERTIME', 'WAGES', 'LEAVE_MIN', 'TAX'];
export const DOMAIN_WORDS = {
  PF: 'Provident fund', ESI: 'ESI', PT: 'Professional tax', LWF: 'Labour welfare fund', MIN_WAGE: 'Minimum wages', BONUS: 'Bonus',
  GRATUITY: 'Gratuity', OVERTIME: 'Overtime and hours', WAGES: 'Wages (Labour Codes)', LEAVE_MIN: 'Leave and holidays (minimums)', TAX: 'Income tax',
};

const json = (v, d = null) => { if (v == null) return d; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return d; } };
export const dateText = (v) => (v == null ? null : (v instanceof Date
  ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`
  : String(v).slice(0, 10)));
const stamp = (v) => (v ? (v instanceof Date ? v.toISOString() : String(v)) : null);
const refuse = (status, code, message, extra) => new HrmsError(status, code, message, extra);

/* ── shapes ────────────────────────────────────────────────────────────── */

export const shapeLaw = (r) => ({
  id: r.id, kind: 'LAW', domain: r.domain, jurisdiction: r.jurisdiction, ruleKey: r.rule_key, title: r.title ?? null,
  value: json(r.value_json, {}), effectiveFrom: dateText(r.effective_from), effectiveTo: dateText(r.effective_to),
  version: Number(r.version), status: r.status, sourceUrl: r.source_url ?? null, sourceNote: r.source_note ?? null, note: r.note ?? null,
  verified: Number(r.verified) === 1, reviewedBy: r.reviewed_by ?? null, publishedAt: stamp(r.published_at), reviewBy: dateText(r.review_by),
  supersedesId: r.supersedes_id ?? null, createdBy: r.created_by ?? null, createdAt: stamp(r.created_at),
});

/** A tax year's first day: '2026-27' → '2026-04-01'. */
const yearStart = (y) => `${String(y).slice(0, 4)}-04-01`;
const yearEnd = (y) => `${Number(String(y).slice(0, 4)) + 1}-03-31`;
export const shapeTax = (r) => ({
  id: `tax:${r.id}`, taxId: r.id, kind: 'TAX', domain: 'TAX', jurisdiction: 'IN', ruleKey: r.rule_key, title: null,
  taxYear: r.tax_year, regime: r.regime, value: json(r.value_json, {}), effectiveFrom: yearStart(r.tax_year), effectiveTo: yearEnd(r.tax_year),
  version: Number(r.version ?? 1), status: r.status ?? 'PUBLISHED', sourceUrl: r.source_url ?? null, sourceNote: r.source_note ?? null, note: null,
  verified: Number(r.verified) === 1, reviewedBy: r.reviewed_by ?? null, publishedAt: stamp(r.published_at), reviewBy: dateText(r.review_by),
  supersedesId: r.supersedes_id ? `tax:${r.supersedes_id}` : null, createdAt: stamp(r.created_at),
});

/** 'tax:12' → { tax: 12 }; 12 / '12' → { law: 12 }. */
export function parseRef(ref) {
  if (ref && typeof ref === 'object') {
    if (ref.ruleId != null) return parseRef(ref.ruleId);
    if (ref.versionId != null) return parseRef(ref.versionId);
    if (ref.id != null) return parseRef(ref.id);
    return null;
  }
  const s = String(ref ?? '');
  const m = /^tax:(\d+)$/.exec(s);
  if (m) return { tax: Number(m[1]) };
  return /^\d+$/.test(s) ? { law: Number(s) } : null;
}

/* ── who may write ─────────────────────────────────────────────────────── */

/**
 * The product side only. PLATFORM: a live platform_admins row for that user (when the table is
 * there — the console's own login checks the email too). SCRIPT: the seed / migration scripts.
 */
export async function assertProduct(db, actor) {
  const kind = String(actor?.kind ?? '').toUpperCase();
  if (actor?.companyId != null || !['PLATFORM', 'SCRIPT'].includes(kind)) {
    throw refuse(403, 'LAW_IS_PRODUCT', 'The law is kept by the product team, for every company at once. A company reads it and makes its own choices within it.');
  }
  if (kind === 'PLATFORM') {
    const [[t]] = await db.query("SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'platform_admins'");
    if (Number(t.n)) {
      const [[a]] = await db.query('SELECT id FROM platform_admins WHERE user_id = ? AND deleted_at IS NULL', [Number(actor.userId) || 0]);
      if (!a) throw refuse(403, 'LAW_IS_PRODUCT', 'Only a platform admin of the product team may change the law.');
    }
  }
  return `${kind === 'PLATFORM' ? 'platform' : 'script'}: ${String(actor.name ?? actor.email ?? actor.userId ?? 'unnamed').slice(0, 100)}`;
}

/* ── reads ─────────────────────────────────────────────────────────────── */

/**
 * Every version, any status (the platform console, the version history).
 * filter: { domain?, jurisdiction?, ruleKey?, status?, includeTax? (default true), taxYear? }
 */
export async function listRules(db, filter = {}) {
  const where = ['deleted_at IS NULL'];
  const params = [];
  const f = filter ?? {};
  const domain = f.domain ? String(f.domain).toUpperCase() : null;
  if (domain && domain !== 'TAX') { where.push('domain = ?'); params.push(domain); }
  if (f.jurisdiction) { where.push('jurisdiction = ?'); params.push(String(f.jurisdiction).toUpperCase()); }
  if (f.ruleKey) { where.push('rule_key = ?'); params.push(String(f.ruleKey)); }
  if (f.status) { where.push('status = ?'); params.push(String(f.status).toUpperCase()); }
  const out = [];
  if (domain !== 'TAX') {
    const [rows] = await db.query(`SELECT * FROM hrms_law_rules WHERE ${where.join(' AND ')} ORDER BY domain, jurisdiction, rule_key, effective_from DESC, version DESC`, params);
    out.push(...rows.map(shapeLaw));
  }
  if ((domain === 'TAX' || (!domain && f.includeTax !== false)) && (!f.jurisdiction || String(f.jurisdiction).toUpperCase() === 'IN')) {
    const tw = ['deleted_at IS NULL'];
    const tp = [];
    if (f.ruleKey) { tw.push('rule_key = ?'); tp.push(String(f.ruleKey)); }
    if (f.status) { tw.push('status = ?'); tp.push(String(f.status).toUpperCase()); }
    if (f.taxYear) { tw.push('tax_year = ?'); tp.push(String(f.taxYear)); }
    const [rows] = await db.query(`SELECT * FROM hrms_tax_rules WHERE ${tw.join(' AND ')} ORDER BY tax_year DESC, rule_key, regime, version DESC`, tp);
    out.push(...rows.map(shapeTax));
  }
  return out;
}

export async function getVersion(db, ref) {
  const p = parseRef(ref);
  if (!p) return null;
  if (p.tax) { const [[r]] = await db.query('SELECT * FROM hrms_tax_rules WHERE id = ?', [p.tax]); return r ? shapeTax(r) : null; }
  const [[r]] = await db.query('SELECT * FROM hrms_law_rules WHERE id = ?', [p.law]);
  return r ? shapeLaw(r) : null;
}

/**
 * The law in force on a day: for each (domain, jurisdiction, rule_key) the PUBLISHED version with
 * the latest effective_from on or before `on` (and no effective_to before it).
 * In a reproduction (pin.js), exactly the pinned versions instead. Notes what it returned.
 * @param q { domains?: [], jurisdictions?: [], on }
 */
export async function lawInForce(db, { domains = null, jurisdictions = null, on }) {
  const ctx = currentLaw();
  const where = ['deleted_at IS NULL', 'effective_from <= ?'];
  const params = [on];
  if (ctx?.pins) {
    const ids = [...ctx.pins.law];
    if (!ids.length) return [];
    where.push(`id IN (${ids.map(() => '?').join(',')})`); params.push(...ids);
  } else {
    where.push("status = 'PUBLISHED'", '(effective_to IS NULL OR effective_to >= ?)'); params.push(on);
  }
  if (domains?.length) { where.push(`domain IN (${domains.map(() => '?').join(',')})`); params.push(...domains); }
  if (jurisdictions?.length) { where.push(`jurisdiction IN (${jurisdictions.map(() => '?').join(',')})`); params.push(...jurisdictions); }
  const [rows] = await db.query(`SELECT * FROM hrms_law_rules WHERE ${where.join(' AND ')} ORDER BY effective_from DESC, version DESC, id DESC`, params);
  const seen = new Map();
  for (const r of rows) {
    const k = `${r.domain}|${r.jurisdiction}|${r.rule_key}`;
    if (!seen.has(k)) seen.set(k, shapeLaw(r));
  }
  const out = [...seen.values()];
  noteLaw(out.map((r) => r.id));
  return out;
}

/** The tax rows of a year and regime (the PUBLISHED ones, or the pinned ones). Notes what it returned. */
export async function taxRowsFor(db, year, regime) {
  const ctx = currentLaw();
  let rows;
  const pinned = ctx?.pins ? [...ctx.pins.tax] : null;
  if (pinned?.length) {
    [rows] = await db.query(
      `SELECT id, tax_year, regime, rule_key, value_json, source_note, source_url, verified FROM hrms_tax_rules
        WHERE tax_year = ? AND regime = ? AND id IN (${pinned.map(() => '?').join(',')})`, [year, String(regime).toUpperCase(), ...pinned]);
  }
  if (!rows?.length) {
    [rows] = await db.query(
      `SELECT id, tax_year, regime, rule_key, value_json, source_note, source_url, verified FROM hrms_tax_rules
        WHERE tax_year = ? AND regime = ? AND deleted_at IS NULL AND status = 'PUBLISHED'`, [year, String(regime).toUpperCase()]);
  }
  noteTax(rows.map((r) => r.id));
  return rows;
}

/* ── writes (product side only) ────────────────────────────────────────── */

const listeners = new Set();
/** fn(version) after every publish. Returns the unsubscribe function. */
export function onPublish(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
async function firePublished(version) {
  for (const fn of listeners) {
    try { await fn(version); } catch (e) { console.error(`[law] an onPublish listener failed: ${e.message}`); }
  }
}

const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
const text = (v, max) => (v == null || String(v).trim() === '' ? null : String(v).trim().slice(0, max));

function readDraft(input, base = null) {
  const problems = [];
  const v = { ...(base ?? {}), ...(input ?? {}) };
  const domain = String(v.domain ?? '').toUpperCase();
  if (!DOMAINS.includes(domain)) problems.push(`Domain: one of ${DOMAINS.join(', ')}.`);
  const ruleKey = text(v.ruleKey ?? v.rule_key, 64);
  if (!ruleKey) problems.push('Rule key: say which rule (e.g. settings, ALL_EMPLOYMENTS, rates).');
  const value = v.value ?? json(v.value_json ?? v.valueJson, null);
  if (value == null || typeof value !== 'object') problems.push('Value: an object (or a list).');
  const out = {
    domain, ruleKey, value, title: text(v.title, 200), sourceUrl: text(v.sourceUrl ?? v.source_url, 500), sourceNote: text(v.sourceNote ?? v.source_note, 2000),
    note: text(v.note, 1000), verified: v.verified === true || v.verified === 1 || v.verified === '1', reviewBy: text(v.reviewBy ?? v.review_by, 10),
  };
  if (!out.sourceNote && !out.sourceUrl) problems.push('Source: say where the value comes from (the act, the notification, the page).');
  if (out.reviewBy && !isDate(out.reviewBy)) problems.push('Review by: a date as YYYY-MM-DD.');
  if (domain === 'TAX') {
    out.taxYear = text(v.taxYear ?? v.tax_year, 7);
    out.regime = String(v.regime ?? '').toUpperCase();
    if (!/^\d{4}-\d{2}$/.test(out.taxYear ?? '')) problems.push('Tax year: like 2026-27.');
    if (!['OLD', 'NEW'].includes(out.regime)) problems.push('Regime: OLD or NEW.');
  } else {
    out.jurisdiction = String(v.jurisdiction ?? 'IN').toUpperCase();
    if (!/^[A-Z]{2}$/.test(out.jurisdiction)) problems.push('Jurisdiction: IN, or a two-letter state code (TG …).');
    out.effectiveFrom = dateText(v.effectiveFrom ?? v.effective_from);
    out.effectiveTo = dateText(v.effectiveTo ?? v.effective_to);
    if (!isDate(out.effectiveFrom ?? '')) problems.push('Effective from: a date as YYYY-MM-DD.');
    if (out.effectiveTo && (!isDate(out.effectiveTo) || out.effectiveTo < out.effectiveFrom)) problems.push('Effective to: a date on or after "effective from".');
  }
  return { out, problems };
}

const bad = (problems) => new HrmsError(422, 'INVALID', 'This law version cannot be saved yet.', { problems });

/**
 * A new DRAFT. input: a whole version, or { fromId, ...changes } to start from an existing version
 * (the usual way to change a rule: copy, change, publish).
 */
export async function draftVersion(db, input, actor) {
  const who = await assertProduct(db, actor);
  let base = null;
  if (input?.fromId != null) {
    const from = await getVersion(db, input.fromId);
    if (!from) throw new HrmsError(404, 'NOT_FOUND', 'That law version was not found.');
    base = { ...from, value: from.value };
    delete base.id;
  }
  const { fromId: _f, ...rest } = input ?? {};
  const { out, problems } = readDraft(rest, base);
  if (problems.length) throw bad(problems);
  if (out.domain === 'TAX') {
    const [[m]] = await db.query('SELECT COALESCE(MAX(version), 0) AS v FROM hrms_tax_rules WHERE tax_year = ? AND regime = ? AND rule_key = ?', [out.taxYear, out.regime, out.ruleKey]);
    const [ins] = await db.query(
      `INSERT INTO hrms_tax_rules (tax_year, regime, rule_key, value_json, version, status, source_note, source_url, verified, review_by)
       VALUES (?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?)`,
      [out.taxYear, out.regime, out.ruleKey, JSON.stringify(out.value), Number(m.v) + 1, out.sourceNote ?? out.sourceUrl, out.sourceUrl, out.verified ? 1 : 0, out.reviewBy]);
    return getVersion(db, `tax:${ins.insertId}`);
  }
  const [[m]] = await db.query('SELECT COALESCE(MAX(version), 0) AS v FROM hrms_law_rules WHERE domain = ? AND jurisdiction = ? AND rule_key = ? AND effective_from = ?',
    [out.domain, out.jurisdiction, out.ruleKey, out.effectiveFrom]);
  const [ins] = await db.query(
    `INSERT INTO hrms_law_rules (domain, jurisdiction, rule_key, title, value_json, effective_from, effective_to, version, status, source_url, source_note, note, verified, review_by, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?, ?, ?)`,
    [out.domain, out.jurisdiction, out.ruleKey, out.title, JSON.stringify(out.value), out.effectiveFrom, out.effectiveTo, Number(m.v) + 1,
      out.sourceUrl, out.sourceNote, out.note, out.verified ? 1 : 0, out.reviewBy, who]);
  return getVersion(db, ins.insertId);
}

/** Changes a DRAFT (only a draft). */
export async function updateDraft(db, ref, changes, actor) {
  await assertProduct(db, actor);
  const cur = await getVersion(db, ref);
  if (!cur) throw new HrmsError(404, 'NOT_FOUND', 'That law version was not found.');
  if (cur.status !== 'DRAFT') throw refuse(409, 'PUBLISHED_IS_FINAL', `Version ${cur.version} is ${cur.status.toLowerCase()}: a published version is never changed. Start a new version from it.`);
  const keys = ['domain', 'jurisdiction', 'ruleKey', 'effectiveFrom', 'taxYear', 'regime'];
  for (const k of keys) if (changes?.[k] !== undefined && String(changes[k]) !== String(cur[k] ?? '')) throw bad([`${k} of a draft does not change: start a new draft for another rule or date.`]);
  const { out, problems } = readDraft(changes, cur);
  if (problems.length) throw bad(problems);
  if (cur.kind === 'TAX') {
    await db.query("UPDATE hrms_tax_rules SET value_json = ?, source_note = ?, source_url = ?, verified = ?, review_by = ? WHERE id = ? AND status = 'DRAFT'",
      [JSON.stringify(out.value), out.sourceNote ?? out.sourceUrl, out.sourceUrl, out.verified ? 1 : 0, out.reviewBy, cur.taxId]);
  } else {
    await db.query("UPDATE hrms_law_rules SET title = ?, value_json = ?, effective_to = ?, source_url = ?, source_note = ?, note = ?, verified = ?, review_by = ? WHERE id = ? AND status = 'DRAFT'",
      [out.title, JSON.stringify(out.value), out.effectiveTo, out.sourceUrl, out.sourceNote, out.note, out.verified ? 1 : 0, out.reviewBy, cur.id]);
  }
  return getVersion(db, ref);
}

/** Throws a DRAFT away (soft delete). A published version cannot be. */
export async function discardDraft(db, ref, actor) {
  await assertProduct(db, actor);
  const cur = await getVersion(db, ref);
  if (!cur) throw new HrmsError(404, 'NOT_FOUND', 'That law version was not found.');
  if (cur.status !== 'DRAFT') throw refuse(409, 'PUBLISHED_IS_FINAL', 'Only a draft can be thrown away; a published version stays, for the months that used it.');
  const t = cur.kind === 'TAX' ? 'hrms_tax_rules' : 'hrms_law_rules';
  await db.query(`UPDATE ${t} SET deleted_at = NOW() WHERE id = ? AND status = 'DRAFT'`, [cur.kind === 'TAX' ? cur.taxId : cur.id]);
  return { ok: true };
}

/**
 * Publishes a DRAFT: checks its value and runs its worked examples, supersedes the PUBLISHED version
 * of the same rule and date (if any), stamps who and when, fires onPublish.
 * ref: a version id ('tax:<id>' for a tax rule), { ruleId }, or { draft: <a whole version> } (drafted
 * and published in one go).
 */
export async function publishVersion(db, ref, reviewer) {
  const who = await assertProduct(db, reviewer);
  let cur;
  if (ref && typeof ref === 'object' && ref.draft) cur = await draftVersion(db, ref.draft, reviewer);
  else cur = await getVersion(db, ref);
  if (!cur) throw new HrmsError(404, 'NOT_FOUND', 'That law version was not found.');
  if (cur.status !== 'DRAFT') throw refuse(409, 'PUBLISHED_IS_FINAL', `Version ${cur.version} is already ${cur.status.toLowerCase()}.`);
  const problems = valueProblems(cur.domain, cur.ruleKey, cur.value);
  const failed = runExamples(cur.domain, cur.ruleKey, cur.value);
  if (problems.length || failed.length) throw new HrmsError(422, 'INVALID', 'This version cannot be published: its value or its worked examples fail.', { problems: [...problems, ...failed] });
  if (cur.kind === 'TAX') {
    const [[r]] = await db.query('SELECT tax_year, regime, rule_key FROM hrms_tax_rules WHERE id = ?', [cur.taxId]);
    const [[old]] = await db.query("SELECT id FROM hrms_tax_rules WHERE tax_year = ? AND regime = ? AND rule_key = ? AND status = 'PUBLISHED' AND deleted_at IS NULL", [r.tax_year, r.regime, r.rule_key]);
    if (old) await db.query("UPDATE hrms_tax_rules SET status = 'SUPERSEDED' WHERE id = ? AND status = 'PUBLISHED'", [old.id]);
    await db.query("UPDATE hrms_tax_rules SET status = 'PUBLISHED', published_at = NOW(), reviewed_by = ?, supersedes_id = ? WHERE id = ? AND status = 'DRAFT'", [who, old?.id ?? null, cur.taxId]);
  } else {
    const [[old]] = await db.query(
      "SELECT id FROM hrms_law_rules WHERE domain = ? AND jurisdiction = ? AND rule_key = ? AND effective_from = ? AND status = 'PUBLISHED' AND deleted_at IS NULL",
      [cur.domain, cur.jurisdiction, cur.ruleKey, cur.effectiveFrom]);
    if (old) await db.query("UPDATE hrms_law_rules SET status = 'SUPERSEDED' WHERE id = ? AND status = 'PUBLISHED'", [old.id]);
    await db.query("UPDATE hrms_law_rules SET status = 'PUBLISHED', published_at = NOW(), reviewed_by = ?, supersedes_id = ? WHERE id = ? AND status = 'DRAFT'", [who, old?.id ?? null, cur.id]);
  }
  const published = await getVersion(db, cur.kind === 'TAX' ? `tax:${cur.taxId}` : cur.id);
  await firePublished(published);
  return published;
}

export default { listRules, getVersion, lawInForce, taxRowsFor, draftVersion, updateDraft, discardDraft, publishVersion, onPublish, assertProduct, shapeLaw, shapeTax, parseRef, DOMAINS, DOMAIN_WORDS };
