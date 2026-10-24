/**
 * migrate.js — moving the per-company statutory settings (hrms_pay_statutory_settings: PF, ESI, PT,
 * LWF) into the law layer (hrms_law_rules, rule_key 'settings', PUBLISHED version 1), and the
 * new law data (lawData.js) in. Used by scripts/migrate-statutory-to-law.mjs, scripts/seed-law-rules.mjs
 * and scripts/cf_hrms/law_test.mjs.
 *
 * THE MOVE
 *   - Rows are grouped by (kind, state, effective_from) across companies. The value is the one the
 *     companies hold (the same everywhere today — the product seed); where they differ, the value
 *     the most companies hold wins and the others are REPORTED (nothing is guessed silently).
 *   - Source, URL, note and verified: from the product seed (services/payroll/seed.js STATUTORY_ROWS)
 *     when the value equals the seed's — the law is product data, and a company's own "checked" tick
 *     is a company note, not law — else from the company row that holds the winning value.
 *   - A rule already in the law layer with the same value: left alone ("same"). With another value:
 *     left alone and reported (a change of law is a new version, published by the product team).
 *   - Company choices: a hrms_law_company_choices row for every company with payroll, if missing.
 *   - The old table is NOT dropped or changed: it stays for the record, and nothing reads it.
 *
 * legacyStatutoryOn(db, companyId, on, state) reads the OLD table exactly as payroll did before, so a
 * test can run the same month both ways and compare.
 */
import { STATUTORY_ROWS } from '../payroll/seed.js';
import { LAW_RULE_ROWS } from './lawData.js';

const json = (v, d = null) => { if (v == null) return d; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return d; } };
const day = (v) => (v instanceof Date ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}` : String(v).slice(0, 10));

/** Key order does not matter: a stable JSON for comparing. */
export function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

export const MIGRATED_BY = 'script: migrate-statutory-to-law';
export const SEEDED_BY = 'script: seed-law-rules';
const TITLES = { PF: 'Provident fund — rates and wage ceiling', ESI: 'ESI — rates, ceiling and contribution periods', PT: 'Professional tax — slabs', LWF: 'Labour welfare fund — contributions' };

/** The old reader, kept only for comparisons. Same as services/payroll/common.js statutoryOn before §37. */
export async function legacyStatutoryOn(db, companyId, on, stateCode) {
  const [rows] = await db.query(
    `SELECT id, kind, state_code, effective_from, settings_json, verification FROM hrms_pay_statutory_settings
      WHERE company_id = ? AND deleted_at IS NULL AND effective_from <= ? ORDER BY effective_from DESC, id DESC`, [companyId, on]);
  const pick = (kind, state) => rows.find((r) => r.kind === kind && r.state_code === state) ?? null;
  const out = {};
  for (const [kind, state] of [['PF', 'IN'], ['ESI', 'IN'], ['PT', stateCode], ['LWF', stateCode]]) {
    const r = pick(kind, state);
    out[kind] = r ? { ...json(r.settings_json, {}), meta: { id: r.id, effectiveFrom: day(r.effective_from), stateCode: r.state_code, verification: r.verification } } : null;
  }
  return out;
}

/** The plan of the move: { insert[], same[], differs[], conflicts[], choices[] }. Reads only. */
export async function statutoryMigrationPlan(conn) {
  const [old] = await conn.query('SELECT id, company_id, kind, state_code, effective_from, settings_json, source, source_url, verification, note FROM hrms_pay_statutory_settings WHERE deleted_at IS NULL ORDER BY company_id, id');
  const seedOf = new Map(STATUTORY_ROWS.map((s) => [`${s.kind}|${s.stateCode}|${s.effectiveFrom}`, s]));
  const groups = new Map();
  for (const r of old) {
    const k = `${r.kind}|${r.state_code}|${day(r.effective_from)}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  // The seed's rows are the product's law even where no company holds them yet (a company set up later).
  for (const [k] of seedOf) if (!groups.has(k)) groups.set(k, []);
  const plan = { insert: [], same: [], differs: [], conflicts: [], choices: [] };
  for (const [k, rows] of groups) {
    const [kind, state, from] = k.split('|');
    const seed = seedOf.get(k) ?? null;
    const byValue = new Map();
    for (const r of rows) {
      const v = stable(json(r.settings_json, {}));
      if (!byValue.has(v)) byValue.set(v, []);
      byValue.get(v).push(r);
    }
    let value; let from_row = null;
    if (byValue.size) {
      const ranked = [...byValue.entries()].sort((a, b) => b[1].length - a[1].length);
      value = json(ranked[0][1][0].settings_json, {});
      from_row = ranked[0][1][0];
      if (ranked.length > 1) plan.conflicts.push({ key: k, kept: `${ranked[0][1].length} compan${ranked[0][1].length === 1 ? 'y' : 'ies'}`, others: ranked.slice(1).map(([, rs]) => rs.map((r) => r.company_id)).flat() });
    } else value = seed.settings;
    const seedSame = seed && stable(seed.settings) === stable(value);
    const row = {
      domain: kind, jurisdiction: state, rule_key: 'settings', effective_from: from, title: TITLES[kind],
      value,
      source_url: seedSame ? seed.sourceUrl : from_row?.source_url ?? null,
      source_note: seedSame ? seed.source : from_row?.source ?? null,
      note: seedSame ? seed.note : from_row?.note ?? null,
      verified: seedSame ? (seed.verification === 'VERIFIED' ? 1 : 0) : (from_row?.verification === 'VERIFIED' ? 1 : 0),
      companies: [...new Set(rows.map((r) => r.company_id))],
    };
    const [[have]] = await conn.query("SELECT id, value_json FROM hrms_law_rules WHERE domain = ? AND jurisdiction = ? AND rule_key = 'settings' AND effective_from = ? AND status = 'PUBLISHED' AND deleted_at IS NULL", [kind, state, from]);
    if (!have) plan.insert.push(row);
    else if (stable(json(have.value_json, {})) === stable(value)) plan.same.push({ key: k, id: have.id });
    else plan.differs.push({ key: k, id: have.id });
  }
  const [companies] = await conn.query(
    `SELECT DISTINCT c.company_id FROM (SELECT company_id FROM hrms_pay_settings WHERE deleted_at IS NULL UNION SELECT company_id FROM hrms_pay_statutory_settings WHERE deleted_at IS NULL) c
      WHERE NOT EXISTS (SELECT 1 FROM hrms_law_company_choices x WHERE x.company_id = c.company_id AND x.deleted_at IS NULL) ORDER BY c.company_id`);
  plan.choices = companies.map((r) => r.company_id);
  return plan;
}

async function insertPublished(conn, r, by) {
  // Version 1 on a clean table; the next number when an earlier row of the same rule and date was removed.
  const [[m]] = await conn.query('SELECT COALESCE(MAX(version), 0) AS v FROM hrms_law_rules WHERE domain = ? AND jurisdiction = ? AND rule_key = ? AND effective_from = ?', [r.domain, r.jurisdiction, r.rule_key, r.effective_from]);
  await conn.query(
    `INSERT INTO hrms_law_rules (domain, jurisdiction, rule_key, title, value_json, effective_from, effective_to, version, status, source_url, source_note, note, verified, reviewed_by, published_at, review_by, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PUBLISHED', ?, ?, ?, ?, ?, NOW(), ?, ?)`,
    [r.domain, r.jurisdiction, r.rule_key, r.title ?? null, JSON.stringify(r.value), r.effective_from, r.effective_to ?? null, Number(m.v) + 1, r.source_url ?? null, r.source_note ?? null, r.note ?? null, r.verified ? 1 : 0, by, r.review_by ?? null, by]);
}

/** Applies a plan inside the caller's transaction. */
export async function applyStatutoryMigration(conn, plan) {
  for (const r of plan.insert) await insertPublished(conn, r, MIGRATED_BY);
  for (const companyId of plan.choices) {
    await conn.query("INSERT INTO hrms_law_company_choices (company_id, pf_wage_basis, note) VALUES (?, 'CEILING', 'Created by the move to the law layer (2026-10-24).')", [companyId]);
  }
}

/**
 * The new law data: { insert[], same, differs[] } by domain + jurisdiction + rule_key + effective_from.
 * A published rule with another value or source is NOT changed — it is reported; the product team
 * publishes a new version (draftVersion + publishVersion) for a change.
 */
export async function lawSeedPlan(conn, rows = LAW_RULE_ROWS) {
  const plan = { insert: [], same: 0, differs: [] };
  for (const r of rows) {
    const [[have]] = await conn.query("SELECT id, value_json, source_note, source_url, verified FROM hrms_law_rules WHERE domain = ? AND jurisdiction = ? AND rule_key = ? AND effective_from = ? AND status = 'PUBLISHED' AND deleted_at IS NULL",
      [r.domain, r.jurisdiction, r.rule_key, r.effective_from]);
    if (!have) { plan.insert.push(r); continue; }
    const changes = [];
    if (stable(json(have.value_json, {})) !== stable(r.value)) changes.push('value');
    if ((have.source_note ?? null) !== (r.source_note ?? null)) changes.push('source_note');
    if ((have.source_url ?? null) !== (r.source_url ?? null)) changes.push('source_url');
    if (Number(have.verified) !== Number(r.verified)) changes.push(`verified ${have.verified} → ${r.verified}`);
    if (changes.length) plan.differs.push({ ...r, id: have.id, changes }); else plan.same += 1;
  }
  return plan;
}

export async function applyLawSeed(conn, plan) {
  for (const r of plan.insert) await insertPublished(conn, r, SEEDED_BY);
}

export default { legacyStatutoryOn, statutoryMigrationPlan, applyStatutoryMigration, lawSeedPlan, applyLawSeed, stable };
