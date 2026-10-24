/**
 * law_test.mjs — the law layer (TM/CF_HRMS_HIRING_SPEC.md §36.1, C1).
 *
 *   0. the schema: apply-law-schema has nothing left to do; every table has deleted_at, every company
 *      table company_id; hrms_tax_rules carries version / status, every live row PUBLISHED
 *   1. versions are never edited after publishing (in code and in the store); drafts, publish,
 *      supersede, worked examples, onPublish; tax rules published the same way
 *   2. effective dating (PF ceiling 15,000 → 25,000 on 17-Sep-2026; Factories Act → OSH Code hours)
 *   3. the move: the migration plans nothing more (idempotent), every old row has its law rule with the
 *      same value, date and verified flag; a fresh move (the law rows taken away inside the
 *      transaction) adds 9 and then nothing; the same demo month (Karni, October 2026) calculated from
 *      the old table and from the law layer gives identical lines, person by person
 *   4. state per person: a location's state in hrms_location_law moves a person's PT
 *   5. minimum wage lookup (Telangana G.O.Ms.No.6) and the role's skill / employment / default structure
 *   6. the run snapshot: a calculation stores the versions it used; after a new PT version is published,
 *      reproduceRun gives the stored lines while a new calculation does not
 *   7. rights: a company reads the law and writes only its choices and notes; nothing in the API writes
 *      law; only the product side (platform admin / script) can draft or publish
 *   8. nothing is left behind
 *
 *   node scripts/cf_hrms/law_test.mjs [--company=karni] [--verbose]
 *
 * NOTHING IS LEFT BEHIND: one connection, one transaction (pool.query / getConnection point at it; a
 * route's own transaction is a savepoint), rolled back at the end. Local only.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import cookieParser from 'cookie-parser';
import mysql from 'mysql2/promise';
import { pool } from '../../db.js';
import { signToken } from '../../core/utils/jwt.js';
import { appContext } from '../../core/middleware/appContext.js';
import hrmsApp from '../../apps/cf_hrms/app.js';
import { forgetAccess } from '../../apps/cf_hrms/lib/accessContext.js';
import { hrmsAppOf, ensureCatalog, setRoleTags } from '../../apps/cf_hrms/services/accessGrants.js';
import { setupAccess } from '../../apps/cf_hrms/services/accessSetup.js';
import { areaTag } from '../../apps/cf_hrms/lib/access.js';
import { routeTable } from '../../apps/cf_hrms/lib/routeTable.js';
import hrmsRouter from '../../apps/cf_hrms/routes/index.js';
import * as LAW from '../../apps/cf_hrms/services/law/index.js';
import * as CO from '../../apps/cf_hrms/services/law/company.js';
import { statutoryMigrationPlan, applyStatutoryMigration, lawSeedPlan, legacyStatutoryOn, stable } from '../../apps/cf_hrms/services/law/migrate.js';
import { withLawContext } from '../../apps/cf_hrms/services/law/pin.js';
import { STATUTORY_ROWS } from '../../apps/cf_hrms/services/payroll/seed.js';
import { statutoryOn } from '../../apps/cf_hrms/services/payroll/common.js';
import { calculateRun } from '../../apps/cf_hrms/services/payroll/runService.js';
import { loadTaxRules } from '../../apps/cf_hrms/services/tax/rules.js';
import { schemaSteps, LAW_TABLES, GLOBAL_LAW_TABLES } from '../../apps/cf_hrms/scripts/apply-law-schema.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LAW_DIR = path.join(HERE, '..', '..', 'apps', 'cf_hrms', 'services', 'law');
const slug = (process.argv.find((a) => a.startsWith('--company=')) || '--company=karni').split('=')[1];
const VERBOSE = process.argv.includes('--verbose');
if (!['localhost', '127.0.0.1', '::1'].includes(String(process.env.DB_HOST ?? 'localhost'))) {
  console.error(`Refusing to run against DB_HOST=${process.env.DB_HOST}. This test is local only.`);
  process.exit(2);
}

let passed = 0;
const failed = [];
const ok = (cond, name, detail = '') => {
  if (cond) { passed += 1; if (VERBOSE) console.log(`  ok    ${name}`); } else { failed.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
  return Boolean(cond);
};
const section = (title) => console.log(`\n${title}`);
const started = Date.now();
const caught = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

const TABLES = [...LAW_TABLES, 'hrms_tax_rules', 'hrms_pay_runs', 'hrms_pay_run_people', 'hrms_pay_run_lines', 'hrms_pay_statutory_settings', 'hrms_audit_log', 'hrms_location_law', 'hrms_work_assignments', 'hrms_locations', 'users', 'roles', 'app_user_access'];
const dbCfg = { host: process.env.DB_HOST ?? 'localhost', user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME, port: Number(process.env.DB_PORT) || 3306 };
async function worldCount() {
  const conn = await mysql.createConnection(dbCfg);
  try {
    const out = {};
    for (const t of [...new Set(TABLES)]) {
      const stampCol = ['users', 'roles', 'app_user_access', 'hrms_audit_log'].includes(t) ? '0' : 'COALESCE(MAX(updated_at), 0)';
      const [[r]] = await conn.query(`SELECT COUNT(*) AS n, COALESCE(SUM(deleted_at IS NULL), 0) AS live, ${stampCol} AS u FROM ${t}`);
      out[t] = `${r.n}/${r.live}/${r.u}`;
    }
    const [[s]] = await conn.query("SELECT COUNT(*) AS n, SUM(status = 'PUBLISHED') AS p FROM hrms_law_rules");
    out.lawStatuses = `${s.n}/${s.p}`;
    return out;
  } finally { await conn.end(); }
}
const before = await worldCount();

/* ══ 0. the schema ══════════════════════════════════════════════════════ */
section('[0] The schema');
{
  const conn = await mysql.createConnection(dbCfg);
  try {
    ok(LAW_TABLES.length === 6, 'init.sql §37 declares six tables', LAW_TABLES.join(','));
    ok((await schemaSteps(conn)).length === 0, 'apply-law-schema: nothing left to do on this database (idempotent)');
    const [cols] = await conn.query(`SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (${LAW_TABLES.map(() => '?').join(',')}) AND COLUMN_NAME IN ('company_id', 'deleted_at')`, LAW_TABLES);
    const has = (t, c) => cols.some((x) => x.TABLE_NAME === t && x.COLUMN_NAME === c);
    ok(LAW_TABLES.every((t) => has(t, 'deleted_at')) && LAW_TABLES.filter((t) => !GLOBAL_LAW_TABLES.includes(t)).every((t) => has(t, 'company_id')) && !has('hrms_law_rules', 'company_id'),
      'every table has deleted_at; every company table company_id; hrms_law_rules is global');
    const [[t]] = await conn.query("SELECT COUNT(*) AS n, SUM(status = 'PUBLISHED') AS p, SUM(version >= 1) AS v FROM hrms_tax_rules WHERE deleted_at IS NULL AND status <> 'DRAFT'");
    ok(Number(t.n) > 100 && Number(t.v) === Number(t.n), 'hrms_tax_rules: every live row has a version (existing rows became version 1)', JSON.stringify(t));
    const [[runCol]] = await conn.query("SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_pay_runs' AND COLUMN_NAME = 'law_versions_json'");
    ok(Number(runCol.n) === 1, 'hrms_pay_runs.law_versions_json is there');
  } finally { await conn.end(); }
}

/* ══ the database part: one transaction, rolled back ═══════════════════ */
const real = { query: pool.query.bind(pool), execute: pool.execute.bind(pool), getConnection: pool.getConnection.bind(pool) };
const db = await real.getConnection();
await db.beginTransaction();
let depth = 0;
const inside = {
  query: (...a) => db.query(...a),
  execute: (...a) => db.execute(...a),
  beginTransaction: async () => { depth += 1; await db.query(`SAVEPOINT zz_law_${depth}`); },
  commit: async () => { if (depth > 0) { await db.query(`RELEASE SAVEPOINT zz_law_${depth}`); depth -= 1; } },
  rollback: async () => { if (depth > 0) { await db.query(`ROLLBACK TO SAVEPOINT zz_law_${depth}`); depth -= 1; } },
  release: () => {},
};
pool.query = inside.query;
pool.execute = inside.execute;
pool.getConnection = async () => inside;

const TAG = `ZZLW${Date.now().toString(36).toUpperCase().slice(-5)}`;
const q = async (sql, params) => (await db.query(sql, params))[0];
const one = async (sql, params) => (await q(sql, params))[0] ?? null;
const ins = async (sql, params) => (await db.query(sql, params))[0].insertId;
const SCRIPT = { kind: 'SCRIPT', name: 'law_test' };

let server;
try {
  const company = await one('SELECT id, name, slug FROM companies WHERE slug = ? AND deleted_at IS NULL', [slug]);
  if (!company) throw new Error(`No company "${slug}".`);
  const COMPANY = company.id;
  const C = { companyId: COMPANY, userId: null };
  console.log(`\nlaw_test — ${company.name} (${COMPANY}), tag ${TAG}`);

  /* ══ 1. versions ═══════════════════════════════════════════════════════ */
  section('[1] Versions: never edited after publishing');
  {
    // In the code: the only UPDATEs of hrms_law_rules are a draft's own (… status = 'DRAFT') and a publish's status change.
    const files = [...fs.readdirSync(LAW_DIR).map((f) => path.join(LAW_DIR, f)), ...['seed-law-rules.mjs', 'migrate-statutory-to-law.mjs', 'apply-law-schema.mjs'].map((f) => path.join(HERE, '..', '..', 'apps', 'cf_hrms', 'scripts', f))];
    const updates = files.flatMap((f) => [...fs.readFileSync(f, 'utf8').matchAll(/UPDATE hrms_law_rules SET [^\n]*/g)].map((m) => `${path.basename(f)}: ${m[0]}`));
    const bad = updates.filter((u) => !/status = 'SUPERSEDED' WHERE id = \? AND status = 'PUBLISHED'/.test(u) && !/status = 'PUBLISHED', published_at = NOW\(\)[^]*AND status = 'DRAFT'/.test(u) && !/WHERE id = \? AND status = 'DRAFT'/.test(u));
    ok(updates.length >= 4 && bad.length === 0, `every UPDATE of hrms_law_rules in the code touches a draft, or only the status of a published row (${updates.length})`, bad.join(' | '));
    const routes = routeTable(hrmsRouter).filter((r) => r.method !== 'GET' && /^\/law\/rules|^\/law\/tax/.test(r.path));
    ok(routes.length === 0, 'no company route writes a law or tax rule', routes.map((r) => `${r.method} ${r.path}`).join(','));

    const heard = [];
    const off = LAW.onPublish((v) => { heard.push(v); });
    const draft = await LAW.draftVersion(db, { domain: 'PT', jurisdiction: 'MH', ruleKey: 'settings', effectiveFrom: '2025-04-01', value: { slabs: [{ upTo: null, amount: 175 }], basis: 'GROSS', examples: [{ gross: 30000, amount: 175 }] }, sourceNote: `${TAG} test rule`, title: 'Test PT' }, SCRIPT);
    ok(draft.status === 'DRAFT' && draft.version === 1, 'a draft is version 1, DRAFT');
    const changed = await LAW.updateDraft(db, draft.id, { note: 'edited while a draft' }, SCRIPT);
    ok(changed.note === 'edited while a draft', 'a draft can be changed');
    const pub = await LAW.publishVersion(db, draft.id, SCRIPT);
    ok(pub.status === 'PUBLISHED' && pub.publishedAt && pub.reviewedBy === 'script: law_test' && heard.length === 1 && heard[0].id === pub.id, 'published: stamped with who and when; onPublish heard it');
    const e1 = await caught(() => LAW.updateDraft(db, pub.id, { note: 'x' }, SCRIPT));
    const e2 = await caught(() => LAW.publishVersion(db, pub.id, SCRIPT));
    const e3 = await caught(() => LAW.discardDraft(db, pub.id, SCRIPT));
    ok([e1, e2, e3].every((e) => e?.code === 'PUBLISHED_IS_FINAL'), 'a published version cannot be changed, published again or thrown away (409 PUBLISHED_IS_FINAL)', [e1, e2, e3].map((e) => e?.code).join(','));
    const v2 = await LAW.publishVersion(db, { draft: { fromId: pub.id, value: { slabs: [{ upTo: null, amount: 180 }], basis: 'GROSS' }, sourceNote: `${TAG} test rule v2` } }, SCRIPT);
    const old = await LAW.getVersion(db, pub.id);
    ok(v2.version === 2 && v2.status === 'PUBLISHED' && v2.supersedesId === pub.id && old.status === 'SUPERSEDED' && stable(old.value) === stable(pub.value), 'a change is a new version: v2 published, v1 SUPERSEDED with its value untouched');
    const failing = await caught(() => LAW.publishVersion(db, { draft: { domain: 'PT', jurisdiction: 'MH', ruleKey: 'settings', effectiveFrom: '2026-04-01', value: { slabs: [{ upTo: null, amount: 200 }], examples: [{ gross: 10000, amount: 150 }] }, sourceNote: 'wrong example' } }, SCRIPT));
    ok(failing?.status === 422 && /Example 1/.test(JSON.stringify(failing.extra ?? failing.problems ?? failing.message)), 'a worked example that does not come out refuses the publish', failing?.message);
    const badShape = await caught(() => LAW.publishVersion(db, { draft: { domain: 'PF', jurisdiction: 'IN', ruleKey: 'settings', effectiveFrom: '2030-04-01', value: { employeeRate: 12 }, sourceNote: 'incomplete' } }, SCRIPT));
    ok(badShape?.status === 422, 'a PF value missing its rates refuses the publish');
    off();
    await LAW.publishVersion(db, { draft: { domain: 'PT', jurisdiction: 'MH', ruleKey: 'settings', effectiveFrom: '2026-05-01', value: { slabs: [{ upTo: null, amount: 190 }] }, sourceNote: 'after unsubscribe' } }, SCRIPT);
    ok(heard.length === 2, 'onPublish: an unsubscribed listener hears nothing more', String(heard.length));

    // Tax rules: the same fields, published the same way.
    const tds = await one("SELECT id, value_json FROM hrms_tax_rules WHERE tax_year = '2026-27' AND regime = 'NEW' AND rule_key = 'tds_rounding' AND status = 'PUBLISHED' AND deleted_at IS NULL");
    const before27 = (await loadTaxRules(db, '2026-27', 'NEW')).get('tds_rounding');
    const tv = await LAW.publishVersion(db, { draft: { fromId: `tax:${tds.id}`, value: { ...before27, testTag: TAG }, sourceNote: `${TAG} tax test` } }, SCRIPT);
    const oldTax = await LAW.getVersion(db, `tax:${tds.id}`);
    const after27 = (await loadTaxRules(db, '2026-27', 'NEW')).get('tds_rounding');
    ok(tv.kind === 'TAX' && tv.version === 2 && oldTax.status === 'SUPERSEDED' && after27.testTag === TAG, 'a tax rule: new version published, the old one SUPERSEDED, the engine reads the new one');
    const pinned = await withLawContext({ law: [], tax: [tds.id] }, () => loadTaxRules(db, '2026-27', 'NEW'));
    ok(stable(pinned.get('tds_rounding')) === stable(before27), 'pinned to the old version, the engine reads exactly that one');
  }

  /* ══ 2. effective dating ═══════════════════════════════════════════════ */
  section('[2] Effective dating');
  {
    const at = async (on) => (await LAW.statutoryFromLaw(db, on, 'TG'));
    const a = await at('2026-09-16');
    const b = await at('2026-09-17');
    const c0 = await at('2025-03-31');
    ok(a.PF.wageCeiling === 15000 && b.PF.wageCeiling === 25000 && a.PF.meta.effectiveFrom === '2026-04-01' && b.PF.meta.effectiveFrom === '2026-09-17', 'PF ceiling: 15,000 on 16-Sep-2026, 25,000 from 17-Sep-2026');
    ok(c0.PF === null && c0.PT === null, 'before the first rule (31-Mar-2025): nothing in force — never a guessed number');
    const ot = async (on) => (await LAW.lawInForce(db, { domains: ['OVERTIME'], jurisdictions: ['IN'], on })).find((r) => r.ruleKey === 'rate')?.value;
    ok((await ot('2025-10-01')).dailyHours === 9 && (await ot('2025-11-21')).dailyHours === 8 && (await ot('2025-12-01')).multiplier === 2, 'overtime: Factories Act 9 hours a day until 20-Nov-2025 (effective_to), OSH Code 8 hours from 21-Nov-2025');
    const lv = async (on) => (await LAW.lawInForce(db, { domains: ['LEAVE_MIN'], jurisdictions: ['IN'], on })).find((r) => r.ruleKey === 'annual_leave_factory')?.value.eligibilityDaysWorked;
    ok(await lv('2025-06-01') === 240 && await lv('2026-01-01') === 180, 'annual leave: 240 days under the Factories Act, 180 under the OSH Code');
  }

  /* ══ 3. the move ═══════════════════════════════════════════════════════ */
  section('[3] The move from hrms_pay_statutory_settings');
  {
    const plan = await statutoryMigrationPlan(db);
    ok(plan.insert.length === 0 && plan.differs.length === 0 && plan.conflicts.length === 0 && plan.choices.length === 0, 'the migration plans nothing more (it ran; idempotent)', JSON.stringify({ i: plan.insert.length, d: plan.differs.length, c: plan.conflicts.length, ch: plan.choices.length }));
    const old = await q('SELECT company_id, kind, state_code, effective_from, settings_json FROM hrms_pay_statutory_settings WHERE deleted_at IS NULL');
    let same = 0;
    const off = [];
    for (const r of old) {
      const from = String(r.effective_from instanceof Date ? `${r.effective_from.getFullYear()}-${String(r.effective_from.getMonth() + 1).padStart(2, '0')}-${String(r.effective_from.getDate()).padStart(2, '0')}` : r.effective_from).slice(0, 10);
      const law = await one("SELECT value_json, verified FROM hrms_law_rules WHERE domain = ? AND jurisdiction = ? AND rule_key = 'settings' AND effective_from = ? AND status = 'PUBLISHED' AND deleted_at IS NULL AND (source_note IS NULL OR source_note NOT LIKE 'ZZLW%')", [r.kind, r.state_code, from]);
      const seed = STATUTORY_ROWS.find((s) => s.kind === r.kind && s.stateCode === r.state_code && s.effectiveFrom === from);
      const v = typeof r.settings_json === 'string' ? JSON.parse(r.settings_json) : r.settings_json;
      const lv = law && (typeof law.value_json === 'string' ? JSON.parse(law.value_json) : law.value_json);
      if (law && stable(lv) === stable(v) && Number(law.verified) === (seed?.verification === 'VERIFIED' ? 1 : 0)) same += 1; else off.push(`${r.company_id} ${r.kind} ${from}`);
    }
    ok(old.length >= 9 && off.length === 0, `every old row (${old.length}) has its law rule: same value, same date, the product's verified flag`, off.join('; '));
    ok((await one("SELECT verified FROM hrms_law_rules WHERE domain = 'LWF' AND jurisdiction = 'TG' AND effective_from = '2025-04-01' AND status = 'PUBLISHED'")).verified === 0, 'LWF stays NOT verified (secondary sources only), as it was');
    // A fresh move, inside the transaction: the law's PF/ESI/PT/LWF rows taken away, moved again, then nothing.
    await db.query('SAVEPOINT zz_fresh');
    await db.query("UPDATE hrms_law_rules SET deleted_at = NOW() WHERE rule_key = 'settings' AND domain IN ('PF','ESI','PT','LWF') AND deleted_at IS NULL");
    const fresh = await statutoryMigrationPlan(db);
    await applyStatutoryMigration(db, fresh);
    const again = await statutoryMigrationPlan(db);
    ok(fresh.insert.length === 9 && again.insert.length === 0 && again.same.length === 9, 'a fresh move adds the nine rules, and a second run adds nothing', `${fresh.insert.length} → ${again.insert.length}`);
    await db.query('ROLLBACK TO SAVEPOINT zz_fresh');
    ok((await lawSeedPlan(db)).insert.length === 0 && (await lawSeedPlan(db)).differs.length === 0, 'seed-law-rules: the table equals the seed (run --apply once)');

    // The readers agree, every month from April 2025 to March 2027, for Telangana.
    const diffs = [];
    for (let y = 2025, m = 4; y < 2027 || m <= 3;) {
      const on = `${y}-${String(m).padStart(2, '0')}-01`;
      const a = await legacyStatutoryOn(db, COMPANY, on, 'TG');
      const b = await LAW.statutoryFromLaw(db, on, 'TG');
      for (const k of ['PF', 'ESI', 'PT', 'LWF']) {
        const strip = (x) => (x ? stable({ ...x, meta: { effectiveFrom: x.meta.effectiveFrom, stateCode: x.meta.stateCode } }) : null);
        if (strip(a[k]) !== strip(b[k])) diffs.push(`${on} ${k}`);
      }
      m += 1; if (m === 13) { m = 1; y += 1; }
    }
    ok(diffs.length === 0, 'old and new readers give the same PF / ESI / PT / LWF on the first of every month, Apr 2025 – Mar 2027', diffs.slice(0, 5).join(', '));

    // The same demo month calculated both ways.
    const run = await one("SELECT id, period_month, status FROM hrms_pay_runs WHERE company_id = ? AND deleted_at IS NULL AND status IN ('DRAFT','CALCULATED') ORDER BY period_month DESC LIMIT 1", [COMPANY]);
    if (!run) ok(false, 'a demo run to calculate (demo-payroll.mjs makes October 2026)');
    else {
      const linesOf = async () => (await q(
        `SELECT p.employee_id, k.code, l.amount, l.for_month FROM hrms_pay_run_lines l JOIN hrms_pay_run_people p ON p.id = l.run_person_id LEFT JOIN hrms_pay_components k ON k.id = l.component_id
          WHERE l.company_id = ? AND l.run_id = ? AND l.deleted_at IS NULL AND p.deleted_at IS NULL ORDER BY p.employee_id, k.code, l.for_month, l.amount`, [COMPANY, run.id]))
        .map((r) => `${r.employee_id}|${r.code}|${r.for_month ?? ''}|${Number(r.amount).toFixed(2)}`);
      await withLawContext(null, () => calculateRun(db, C, run.id, null), { legacy: true });
      const fromOld = await linesOf();
      await calculateRun(db, C, run.id, null);
      const fromLaw = await linesOf();
      const people = new Set(fromLaw.map((l) => l.split('|')[0])).size;
      const diff = fromOld.filter((l, i) => l !== fromLaw[i]);
      ok(fromOld.length > 100 && fromOld.length === fromLaw.length && diff.length === 0, `${run.period_month} (run ${run.id}): ${people} people, ${fromLaw.length} lines — identical from the old table and from the law layer`, diff.slice(0, 3).join(' / '));
      const snap = await LAW.runSnapshot(db, COMPANY, run.id);
      const pf = snap ? await LAW.getVersion(db, snap.law.find(Boolean)) : null;
      ok(snap && snap.law.length >= 4 && snap.tax.length > 10 && pf, 'the calculation stored the law and tax versions it used', JSON.stringify({ law: snap?.law.length, tax: snap?.tax.length }));
    }
  }

  /* ══ 4. state per person ═══════════════════════════════════════════════ */
  section('[4] The state follows the person');
  let movedPerson = null;
  {
    const run = await one("SELECT id, period_month FROM hrms_pay_runs WHERE company_id = ? AND deleted_at IS NULL AND status IN ('DRAFT','CALCULATED') ORDER BY period_month DESC LIMIT 1", [COMPANY]);
    const ptOf = async (e) => Number((await one(
      `SELECT l.amount FROM hrms_pay_run_lines l JOIN hrms_pay_components k ON k.id = l.component_id JOIN hrms_pay_run_people p ON p.id = l.run_person_id
        WHERE l.company_id = ? AND l.run_id = ? AND l.deleted_at IS NULL AND p.deleted_at IS NULL AND p.employee_id = ? AND k.statutory_key = 'PT'`, [COMPANY, run.id, e]))?.amount ?? 0);
    const pick = await one(
      `SELECT p.employee_id, wa.id AS wa FROM hrms_pay_run_people p JOIN hrms_work_assignments wa ON wa.company_id = p.company_id AND wa.employee_id = p.employee_id AND wa.is_primary = 1 AND wa.deleted_at IS NULL AND wa.status <> 'ENDED'
        WHERE p.company_id = ? AND p.run_id = ? AND p.deleted_at IS NULL AND p.included = 1 AND p.gross > 25000 ORDER BY p.employee_id LIMIT 1`, [COMPANY, run.id]);
    movedPerson = pick?.employee_id;
    const ptBefore = await ptOf(pick.employee_id);
    const placeBefore = (await LAW.lawPlacesOf(db, COMPANY, [pick.employee_id], '2026-10-31')).get(pick.employee_id);
    ok(placeBefore.state === 'TG' && ptBefore === 200, 'before: the person is in Telangana (the company state) and pays PT 200', JSON.stringify({ s: placeBefore.state, pt: ptBefore }));
    const loc = await ins("INSERT INTO hrms_locations (company_id, code, name, location_type, status) VALUES (?, ?, ?, 'OFFICE', 'ACTIVE')", [COMPANY, `${TAG}MH`, `${TAG} Mumbai office`]);
    await CO.putLocationLaw(db, C, loc, { stateCode: 'MH', zone: 'I' });
    await db.query('UPDATE hrms_work_assignments SET location_id = ? WHERE id = ?', [loc, pick.wa]);
    const place = (await LAW.lawPlacesOf(db, COMPANY, [pick.employee_id], '2026-10-31')).get(pick.employee_id);
    ok(place.state === 'MH' && place.stateFrom === 'LOCATION' && place.zone === 'I', 'after: the main position’s location says Maharashtra (from hrms_location_law), zone I');
    await calculateRun(db, C, run.id, null);
    ok(await ptOf(pick.employee_id) === 190, 'and the run takes Maharashtra’s professional tax for that person (the test rule, 190 from May 2026)', String(await ptOf(pick.employee_id)));
    const others = await one(`SELECT COUNT(*) AS n FROM hrms_pay_run_lines l JOIN hrms_pay_components k ON k.id = l.component_id WHERE l.company_id = ? AND l.run_id = ? AND l.deleted_at IS NULL AND k.statutory_key = 'PT' AND l.amount = 200`, [COMPANY, run.id]);
    ok(Number(others.n) > 10, 'everybody else still pays Telangana’s 200', String(others.n));
    const bad = await caught(() => CO.putLocationLaw(db, C, loc, { stateCode: 'XX' }));
    ok(bad?.status === 422, 'a state that is not a state of India is refused');
  }

  /* ══ 5. minimum wages, the role ═══════════════════════════════════════ */
  section('[5] Minimum wages and the role');
  {
    const mw = (o) => LAW.minimumWageOn(db, { state: 'TG', on: '2026-07-01', ...o });
    const a = await mw({ zone: 'I', skill: 'UNSKILLED' });
    const b = await mw({ zone: 'III', skill: 'HIGHLY_SKILLED', employment: 'PRINTING_PRESSES' });
    const cEarly = await mw({ zone: 'I', skill: 'UNSKILLED', on: '2026-05-31' });
    ok(a.found && a.wage.basic === 16000 && a.wage.vdaPending && a.rule.ruleKey === 'ALL_EMPLOYMENTS' && a.rule.verified === false, 'Telangana zone I, unskilled: ₹16,000 basic (VDA not notified yet), from G.O.Ms.No.6 — marked not verified');
    ok(b.found && b.wage.total === 18000 && Math.abs(b.wage.daily - 692.31) < 0.01, 'zone III, highly skilled, printing presses: ₹18,000 (₹692.31 a day at ÷26)');
    ok(!cEarly.found && /No minimum-wage notification/.test(cEarly.reason), 'before 1 June 2026: none in the law layer, said so (not guessed)');
    ok(!(await mw({ zone: null, skill: 'SKILLED' })).found && !(await mw({ zone: 'I', skill: null })).found, 'no zone, or no skill: not found, with the reason');
    const roleId = (await one('SELECT wa.role_id FROM hrms_work_assignments wa WHERE wa.company_id = ? AND wa.employee_id = ? AND wa.is_primary = 1 AND wa.deleted_at IS NULL', [COMPANY, movedPerson])).role_id;
    const st = await one("SELECT id FROM hrms_pay_structures WHERE company_id = ? AND code = 'STAFF_STD' AND deleted_at IS NULL", [COMPANY]);
    const r1 = await CO.putRoleLaw(db, C, roleId, { skillCategory: 'SKILLED', scheduledEmployment: 'PRINTING_PRESSES', defaultStructureId: st.id, ctcMin: 300000, ctcMax: 600000 }, null, { withPay: true });
    ok(r1.skillCategory === 'SKILLED' && r1.scheduledEmployment === 'PRINTING_PRESSES' && r1.defaultStructure?.structureId === st.id && r1.defaultStructure.ctcMin === 300000, 'the role: skill, scheduled employment and default structure with its CTC band');
    const noPay = await CO.getRoleLaw(db, COMPANY, roleId, { withPay: false });
    ok(noPay.defaultStructure && noPay.defaultStructure.ctcMin === undefined, 'without pay access the CTC band is not shown');
    const e = await caught(() => CO.putRoleLaw(db, C, roleId, { ctcMin: 1 }, null, { withPay: false }));
    ok(e?.status === 403, 'and cannot be set (403)');
    const e2 = await caught(() => CO.putRoleLaw(db, C, roleId, { scheduledEmployment: 'NOT_A_SCHEDULE' }, null, { withPay: true }));
    ok(e2?.status === 422, 'a scheduled employment no notification names is refused');
    const def = await CO.defaultStructureFor(db, COMPANY, movedPerson, '2026-10-31');
    ok(def?.structureId === st.id && def.roleId === roleId, 'a new salary for a person in that role preselects the role’s structure');
    await CO.putLocationLaw(db, C, (await one('SELECT COALESCE(wa.location_id, p.location_id) AS l FROM hrms_work_assignments wa LEFT JOIN hrms_positions p ON p.id = wa.position_id WHERE wa.company_id = ? AND wa.employee_id = ? AND wa.is_primary = 1 AND wa.deleted_at IS NULL', [COMPANY, movedPerson])).l, { stateCode: 'TG', zone: 'II' });
    const pl = await CO.personLaw(db, COMPANY, movedPerson, '2026-10-31');
    ok(pl.state === 'TG' && pl.zone === 'II' && pl.skill === 'SKILLED' && pl.minimumWage.found && pl.minimumWage.wage.basic === 17500, 'the person: Telangana, zone II, skilled → minimum wage ₹17,500', JSON.stringify({ s: pl.state, z: pl.zone, mw: pl.minimumWage.wage?.basic }));
  }

  /* ══ 6. the run snapshot ═════════════════════════════════════════════ */
  section('[6] The run snapshot reproduces');
  {
    const run = await one("SELECT id FROM hrms_pay_runs WHERE company_id = ? AND deleted_at IS NULL AND status IN ('DRAFT','CALCULATED') ORDER BY period_month DESC LIMIT 1", [COMPANY]);
    await calculateRun(db, C, run.id, null);
    const snap = await LAW.runSnapshot(db, COMPANY, run.id);
    const ptTg = await one("SELECT id, value_json FROM hrms_law_rules WHERE domain = 'PT' AND jurisdiction = 'TG' AND rule_key = 'settings' AND effective_from = '2026-04-01' AND status = 'PUBLISHED'");
    ok(snap.law.includes(ptTg.id), 'the snapshot holds the Telangana PT version used');
    const same0 = await LAW.reproduceRun(db, C, run.id);
    ok(same0.same && same0.lines > 100, 'reproduced right away: the same lines', same0.differences.slice(0, 2).join(' / '));
    // The law changes: a corrected PT version for the same date (200 → 210 at the top).
    const v = typeof ptTg.value_json === 'string' ? JSON.parse(ptTg.value_json) : ptTg.value_json;
    await LAW.publishVersion(db, { draft: { fromId: ptTg.id, value: { ...v, slabs: v.slabs.map((s) => (s.upTo == null ? { ...s, amount: 210 } : s)) }, sourceNote: `${TAG} corrected PT` } }, SCRIPT);
    const rep = await LAW.reproduceRun(db, C, run.id);
    ok(rep.same, 'after a new PT version is published, the run reproduced with its own versions gives exactly the stored lines', rep.differences.slice(0, 2).join(' / '));
    await calculateRun(db, C, run.id, null);
    const top = await one(`SELECT COUNT(*) AS n FROM hrms_pay_run_lines l JOIN hrms_pay_components k ON k.id = l.component_id WHERE l.company_id = ? AND l.run_id = ? AND l.deleted_at IS NULL AND k.statutory_key = 'PT' AND l.amount = 210`, [COMPANY, run.id]);
    ok(Number(top.n) > 10, 'while a new calculation takes the new version (PT 210)', String(top.n));
    const snap2 = await LAW.runSnapshot(db, COMPANY, run.id);
    ok(!snap2.law.includes(ptTg.id), 'and stores the new version id');
  }

  /* ══ 7. rights ══════════════════════════════════════════════════════ */
  section('[7] Rights: companies read, only the product side writes law');
  {
    const e1 = await caught(() => LAW.draftVersion(db, { domain: 'PT', jurisdiction: 'TG', ruleKey: 'settings', effectiveFrom: '2027-04-01', value: { slabs: [{ upTo: null, amount: 1 }] }, sourceNote: 'x' }, { companyId: COMPANY, userId: 1 }));
    const e2 = await caught(() => LAW.publishVersion(db, 1, { companyId: COMPANY }));
    const e3 = await caught(() => LAW.draftVersion(db, { domain: 'PT', jurisdiction: 'TG', ruleKey: 'settings', effectiveFrom: '2027-04-01', value: { slabs: [] }, sourceNote: 'x' }, { kind: 'PLATFORM', userId: 999999999, name: 'nobody' }));
    ok([e1, e2, e3].every((e) => e?.status === 403 && e.code === 'LAW_IS_PRODUCT'), 'a company login, or a user who is not a platform admin, cannot draft or publish law (403 LAW_IS_PRODUCT)', [e1, e2, e3].map((e) => e?.code).join(','));

    const app = await hrmsAppOf(db, COMPANY);
    await setupAccess(db, COMPANY, { apply: true });
    const roleByKey = Object.fromEntries((await q('SELECT role_id, template_key FROM hrms_access_roles WHERE company_id = ? AND deleted_at IS NULL AND template_key IS NOT NULL', [COMPANY])).map((r) => [r.template_key, r.role_id]));
    const catalog = await ensureCatalog(db, { apply: true });
    const clerkRole = await ins('INSERT INTO roles (name, company_id) VALUES (?, ?)', [`${TAG} Payroll clerk`, COMPANY]);
    await db.query("INSERT INTO hrms_access_roles (company_id, role_id, label, scope) VALUES (?, ?, ?, 'COMPANY')", [COMPANY, clerkRole, `${TAG} Payroll clerk`]);
    await setRoleTags(db, { companyId: COMPANY, appId: app.id, roleId: clerkRole, tags: [areaTag('payroll', 'view'), areaTag('payroll', 'edit')], catalog });
    const login = async (label, roleId) => {
      const email = `${TAG.toLowerCase()}.${label.toLowerCase().replace(/[^a-z0-9]/g, '')}@example.test`;
      const id = await ins('INSERT INTO users (name, email, password, role_id, team_id, company_id) VALUES (?, ?, ?, ?, NULL, ?)', [`${TAG} ${label}`, email, 'x', roleId, COMPANY]);
      await db.query('INSERT INTO app_user_access (user_id, app_id, role_id, company_id) VALUES (?, ?, ?, ?)', [id, app.id, roleId, COMPANY]);
      const roleName = (await one('SELECT name FROM roles WHERE id = ?', [roleId])).name;
      return { id, token: signToken({ id, name: `${TAG} ${label}`, email, role: roleName, company: company.slug, companyId: COMPANY, company_id: COMPANY, uiPermissions: [] }) };
    };
    const HR = await login('HR manager', roleByKey.HR_MANAGER);
    const EMP = await login('Employee', roleByKey.EMPLOYEE);
    const CLERK = await login('Clerk', clerkRole);
    forgetAccess();
    server = express();
    server.use(express.json());
    server.use(cookieParser());
    server.use('/api', appContext);
    hrmsApp.register(server);
    const listener = await new Promise((resolve) => { const l = server.listen(0, '127.0.0.1', () => resolve(l)); });
    server.close = () => new Promise((resolve) => listener.close(resolve));
    const base = `http://127.0.0.1:${listener.address().port}/api/${company.slug}/cf_hrms`;
    const call = async (who, method, url, body) => {
      const res = await fetch(`${base}${url}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${who.token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
      let j = null; try { j = await res.json(); } catch { /* none */ }
      return { status: res.status, json: j };
    };
    const rif = await call(HR, 'GET', '/law/rules-in-force?on=2026-10-01');
    const pt = rif.json?.domains?.find((d) => d.domain === 'PT')?.rules?.find((r) => r.jurisdiction === 'TG');
    ok(rif.status === 200 && rif.json.domains.some((d) => d.domain === 'MIN_WAGE') && pt?.sourceUrl && pt.history.length >= 2 && rif.json.unverified > 0, 'HR reads the rules in force: value, source, effective date, version history, unverified count');
    ok((await call(EMP, 'GET', '/law/rules-in-force')).status === 403, 'an employee does not');
    const tax = await call(CLERK, 'GET', '/law/tax-rules?year=2026-27');
    ok(tax.status === 200 && tax.json.rules.length > 50 && tax.json.rules.every((r) => r.status === 'PUBLISHED'), 'the tax rules of a year, published versions');
    const stat = await call(HR, 'GET', '/payroll/statutory');
    const pfRow = stat.json.settings.find((s) => s.kind === 'PF' && s.effectiveFrom === '2025-04-01');
    ok(stat.status === 200 && stat.json.readOnly && pfRow && stat.json.choices, 'Statutory settings: the law read-only, with the company’s choices');
    const post = await call(HR, 'POST', '/payroll/statutory', { kind: 'PT', stateCode: 'TG', effectiveFrom: '2027-04-01', settings: { slabs: [{ upTo: null, amount: 1 }] }, source: 'x' });
    const put = await call(HR, 'PUT', `/payroll/statutory/${pfRow.id}`, { settings: { ...pfRow.settings, wageCeiling: 1 } });
    const del = await call(HR, 'DELETE', `/payroll/statutory/${pfRow.id}`);
    ok(post.status === 409 && post.json.code === 'LAW_IS_PRODUCT' && put.status === 422 && /add a new row/.test(put.json.problems?.[0] ?? '') && del.status === 409, 'the company cannot add, change or remove law through the old screen');
    const note = await call(HR, 'PUT', `/payroll/statutory/${pfRow.id}`, { verification: 'VERIFIED', note: `${TAG} checked by our CA` });
    const after = await LAW.getVersion(db, pfRow.id);
    const noteRow = await one('SELECT verification, note FROM hrms_law_company_notes WHERE company_id = ? AND rule_id = ? AND deleted_at IS NULL', [COMPANY, pfRow.id]);
    ok(note.status === 200 && noteRow?.verification === 'VERIFIED' && after.status === 'PUBLISHED' && after.version === pfRow.version && stable(after.value) === stable(pfRow.settings), 'its own note and “checked” mark are recorded against the version; the law row is unchanged');
    const ch1 = await call(CLERK, 'PUT', '/law/choices', { bonusRate: 25 });
    const ch2 = await call(CLERK, 'PUT', '/law/choices', { bonusRate: 10, ptRegistrationNo: `${TAG}PT`, pfWageBasis: 'CEILING' });
    ok(ch1.status === 422 && /8.33% and 20%/.test(JSON.stringify(ch1.json)) && ch2.status === 200 && ch2.json.choices.bonusRate === 10, 'choices stay editable, checked against the law (a 25% bonus is refused: 8.33%–20%)');
    ok((await call(EMP, 'PUT', '/law/choices', { bonusRate: 10 })).status === 403, 'an employee cannot change the choices');
    const sd = await call(HR, 'GET', `/law/people/${movedPerson}/salary-default`);
    ok(sd.status === 200 && sd.json.structure?.structureId && sd.json.minimumWage?.found, 'salary default for a person: the role’s structure and the minimum wage that applies');
    ok((await call(CLERK, 'GET', `/law/people/${movedPerson}/salary-default`)).status === 403, 'without pay access: refused');
    const run = await one("SELECT id FROM hrms_pay_runs WHERE company_id = ? AND deleted_at IS NULL AND status IN ('DRAFT','CALCULATED') ORDER BY period_month DESC LIMIT 1", [COMPANY]);
    const repro = await call(HR, 'POST', `/payroll/runs/${run.id}/reproduce`);
    ok(repro.status === 200 && repro.json.same === true, 'POST …/reproduce over HTTP: the same lines, nothing written', JSON.stringify(repro.json?.differences?.slice(0, 2) ?? repro.json));
    const lv = await call(HR, 'GET', `/payroll/runs/${run.id}/law-versions`);
    ok(lv.status === 200 && lv.json.snapshot?.law?.length >= 4, 'GET …/law-versions: the snapshot');
  }
} catch (e) {
  ok(false, 'the test ran to the end', e.stack);
} finally {
  if (server?.close) await server.close();
  try { await db.rollback(); } catch { /* nothing to undo */ }
  db.release();
  pool.query = real.query;
  pool.execute = real.execute;
  pool.getConnection = real.getConnection;
  forgetAccess();
}

section('[8] Nothing is left behind');
{
  const after = await worldCount();
  const moved = Object.keys(before).filter((k) => after[k] !== before[k]);
  ok(moved.length === 0, `every count is what it was (${Object.keys(before).length} tables)`, moved.map((k) => `${k} ${before[k]} -> ${after[k]}`).join('; '));
}

console.log(`\n${passed} passed, ${failed.length} failed  (${((Date.now() - started) / 1000).toFixed(1)} s)`);
if (failed.length) { console.log('\nFAILED:'); for (const f of failed) console.log(`  - ${f}`); }
await pool.end();
process.exit(failed.length ? 1 : 0);
