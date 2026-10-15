/**
 * semantic_search_test.mjs — the org chart's "Search job content" (2026-10-15):
 * search by meaning with the built-in model, the kinds filter, exact mode, and
 * positions' own changes.
 *
 *   1. the batch resolver (contentResolver.effectiveLinesForPositions) agrees with
 *      resolveContent for EVERY position of the company;
 *   2. the kinds filter, and bad input refused;
 *   3. exact mode gives the old answer (the pre-2026-10-15 SQL, kept below) on a
 *      few queries;
 *   4. meaning mode finds a line that shares no word with the question, ranks a
 *      phrase hit above a loose one, and drops what is below the floor;
 *   5. a position's own ADD is found and its SUPPRESSed role line is not — for
 *      that position only (rolled back);
 *   6. freshness: a new or reworded definition is embedded inline, up to the
 *      cap; beyond it, keyword only and `pending` says so (rolled back);
 *   7. the model unavailable: keyword mode with a notice, same hits as exact;
 *      the memory guard refuses to load it without headroom (7b);
 *   8. tenant isolation;
 *   9. over HTTP: an Employee login gets 403, an admin of another company 403,
 *      the admin gets the envelope, a bad kind 400.
 *
 *   node scripts/cf_hrms/semantic_search_test.mjs [--company=karni] [--verbose]
 *
 * NOTHING IS LEFT BEHIND: writes happen in transactions that are rolled back,
 * and the end re-counts hrms_search_vectors and the overrides. Needs the index
 * built (apps/cf_hrms/scripts/build-search-index.mjs --company=karni --apply);
 * a missing index only makes the first search slower. Local only.
 */
import express from 'express';
import cookieParser from 'cookie-parser';
import { pool } from '../../db.js';
import { signToken } from '../../core/utils/jwt.js';
import { appContext } from '../../core/middleware/appContext.js';
import hrmsApp from '../../apps/cf_hrms/app.js';
import * as POS from '../../apps/cf_hrms/services/positionService.js';
import { resolveContent, effectiveLinesForPositions } from '../../apps/cf_hrms/services/contentResolver.js';
import {
  searchJobContent, searchOrgChart, readSearchKinds, MEANING_FLOOR, keywordSignal,
} from '../../apps/cf_hrms/services/orgChartService.js';
import {
  loadDefinitions, vectorsFor, invalidateVectors, definitionText, textHash,
} from '../../apps/cf_hrms/services/semantic/searchIndex.js';
import {
  __simulateUnavailable, __clearFailure, unload, MODEL_ID, memoryHeadroom, memoryLimitMb, modelStatus,
} from '../../apps/cf_hrms/services/semantic/embedder.js';

const slug = (process.argv.find((a) => a.startsWith('--company=')) || '--company=karni').split('=')[1];
const VERBOSE = process.argv.includes('--verbose');
if (!['localhost', '127.0.0.1', '::1'].includes(String(process.env.DB_HOST ?? 'localhost'))) {
  console.error(`Refusing to run against DB_HOST=${process.env.DB_HOST}. This test is local only.`);
  process.exit(2);
}

let passed = 0;
const failed = [];
const skipped = [];
const ok = (cond, name, detail = '') => {
  if (cond) { passed += 1; if (VERBOSE) console.log(`  ok    ${name}`); } else { failed.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
  return Boolean(cond);
};
const skip = (name, why) => { skipped.push(`${name}: ${why}`); console.log(`  skip  ${name}: ${why}`); };
const section = (title) => console.log(`\n${title}`);
const caught = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

const [[company]] = await pool.query('SELECT id, name FROM companies WHERE slug = ? AND deleted_at IS NULL', [slug]);
if (!company) { console.error(`No company "${slug}".`); process.exit(2); }
const COMPANY = company.id;
const IS_KARNI = slug === 'karni';
const TAG = `zzsem${Date.now().toString(36).slice(-5)}`;
const on = POS.today();
const [[adminUser]] = await pool.query(
  `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id
    WHERE u.company_id = ? AND u.deleted_at IS NULL AND LOWER(r.name) = 'admin' ORDER BY u.id LIMIT 1`, [COMPANY]);
const c = { companyId: COMPANY, userId: adminUser?.id ?? null };
const [[other]] = await pool.query('SELECT id, slug FROM companies WHERE id <> ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [COMPANY]);

const counts = async () => {
  const [[v]] = await pool.query('SELECT COUNT(*) n, MAX(updated_at) m FROM hrms_search_vectors WHERE company_id = ?', [COMPANY]);
  const [[o]] = await pool.query('SELECT COUNT(*) n FROM hrms_position_content_overrides WHERE company_id = ?', [COMPANY]);
  const [[d]] = await pool.query('SELECT COUNT(*) n FROM hrms_responsibility_definitions WHERE company_id = ?', [COMPANY]);
  return `vectors ${v.n} (${v.m}), overrides ${o.n}, responsibility defs ${d.n}`;
};
const before = await counts();

/** Every live position with a role — what the search maps lines onto. */
const [positions] = await pool.query(
  `SELECT p.id, p.role_id FROM hrms_positions p
    WHERE p.company_id = ? AND p.deleted_at IS NULL AND p.status <> 'CLOSED' AND ${POS.LIVE_ON('p')} AND p.role_id IS NOT NULL
    ORDER BY p.id`, [COMPANY, on, on]);
const lineSet = (lines) => lines.map((l) => `${l.kind}:${l.definitionId}:${l.origin}`).sort().join('|');
const resolvedSet = (r) => [
  ...r.kras, ...r.kras.flatMap((k) => [...k.responsibilities, ...k.kpis]), ...r.additional.responsibilities, ...r.additional.kpis,
].map((i) => `${i.kind}:${i.definitionId}:${i.origin}`).sort().join('|');

/** Batch vs resolveContent for the given positions; returns the ids that disagree. */
async function crossCheck(db, list) {
  const batch = await effectiveLinesForPositions(db, COMPANY, list.map((p) => ({ id: p.id, roleId: p.role_id })), { on, kinds: ['KRA', 'RESPONSIBILITY', 'KPI'] });
  const wrong = [];
  for (const p of list) {
    let r;
    try { r = await resolveContent(db, COMPANY, { positionId: p.id, on }); } catch { continue; }
    if (resolvedSet(r) !== lineSet(batch.get(Number(p.id)) ?? [])) wrong.push(p.id);
  }
  return wrong;
}

/* ══ 1 ════════════════════════════════════════════════════════════════════ */
section('[1] The batch resolver agrees with resolveContent');
{
  const wrong = await crossCheck(pool, positions);
  ok(positions.length > 0 && wrong.length === 0, `effective lines match resolveContent for all ${positions.length} positions`, `differ: ${wrong.slice(0, 10).join(', ')}`);
}

/* ══ 2 ════════════════════════════════════════════════════════════════════ */
section('[2] Kinds filter and input');
{
  const kpiOnly = await searchJobContent(pool, COMPANY, { q: 'customer complaints', kinds: 'KPI' });
  const kinds = new Set(kpiOnly.items.flatMap((h) => h.matches.map((m) => m.kind)));
  ok(kpiOnly.items.length > 0 && kinds.size === 1 && kinds.has('KPI'), 'kinds=KPI: every match is a KPI', [...kinds].join(','));
  const noKpi = await searchJobContent(pool, COMPANY, { q: 'customer complaints', kinds: 'KRA,responsibilities' });
  const k2 = new Set(noKpi.items.flatMap((h) => h.matches.map((m) => m.kind)));
  ok(noKpi.items.length > 0 && !k2.has('KPI') && k2.has('KRA') && k2.has('RESPONSIBILITY'), 'kinds=KRA,responsibilities: KRAs and responsibilities, no KPI', [...k2].join(','));
  const all = await searchJobContent(pool, COMPANY, { q: 'customer complaints' });
  ok(JSON.stringify(all.kinds) === JSON.stringify(['KRA', 'RESPONSIBILITY', 'KPI']), 'default kinds are KRA, RESPONSIBILITY, KPI');
  ok(JSON.stringify(readSearchKinds('kpis, KRA')) === JSON.stringify(['KPI', 'KRA']), 'plural and lower-case kind names are read');
  const bad = await caught(() => readSearchKinds('KRA,SALARY'));
  ok(bad?.status === 422, 'an unknown kind is refused (422, as every invalid input here)', `${bad?.status}`);
  const empty = await caught(() => searchJobContent(pool, COMPANY, { q: '   ' }));
  ok(empty?.status === 422, 'an empty question is refused');
  const badMode = await caught(() => searchJobContent(pool, COMPANY, { q: 'x', mode: 'fuzzy' }));
  ok(badMode?.status === 422, 'an unknown mode is refused');
  ok(all.items.every((h, i, a) => i === 0 || a[i - 1].score >= h.score), 'hits are sorted by best score');
  ok(all.items.every((h) => h.score === h.matches[0].score && h.matches.every((m, i, a) => i === 0 || a[i - 1].score >= m.score)),
    'a hit\'s score is its best match\'s, and matches are best first');
  ok(all.items.every((h) => h.matches.every((m) => m.score >= 0 && m.score <= 1 && (m.origin === 'ROLE' || m.origin === 'POSITION'))),
    'every match has a 0-1 score and an origin');
}

/* ══ 3 ════════════════════════════════════════════════════════════════════ */
section('[3] Exact mode gives the old answer');
{
  // The search as it was before 2026-10-15 (orgChartService.searchOrgChart), verbatim in its SQL.
  const OLD_KINDS = [
    { kind: 'RESPONSIBILITY', table: 'hrms_role_responsibility_assignments', def: 'hrms_responsibility_definitions', fk: 'responsibility_definition_id' },
    { kind: 'KRA', table: 'hrms_role_kra_assignments', def: 'hrms_kra_definitions', fk: 'kra_definition_id' },
    { kind: 'KPI', table: 'hrms_role_kpi_assignments', def: 'hrms_kpi_definitions', fk: 'kpi_definition_id' },
    { kind: 'QUALIFICATION', table: 'hrms_role_qualification_requirements', def: 'hrms_qualification_definitions', fk: 'qualification_definition_id' },
  ];
  const likeTerm = (w) => `%${String(w).replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
  const oldSearch = async (q) => {
    const words = q.trim().split(/\s+/).filter(Boolean).slice(0, 8);
    const per = await Promise.all(OLD_KINDS.map(async ({ kind, table, def, fk }) => {
      const wordSql = words.map(() => `CONCAT_WS(' ', d.name, d.description) LIKE ? ESCAPE '\\\\'`).join(' AND ');
      const [rows] = await pool.query(
        `SELECT p.id AS position_id, d.id AS definition_id
           FROM ${table} a
           JOIN ${def} d ON d.company_id = a.company_id AND d.id = a.${fk} AND d.deleted_at IS NULL
           JOIN hrms_positions p ON p.company_id = a.company_id AND p.role_id = a.role_id
                AND p.deleted_at IS NULL AND p.status <> 'CLOSED' AND ${POS.LIVE_ON('p')}
          WHERE a.company_id = ? AND a.deleted_at IS NULL AND ${POS.LIVE_ON('a')} AND ${wordSql}`,
        [on, on, COMPANY, on, on, ...words.map(likeTerm)],
      );
      return rows.map((r) => `${r.position_id}:${kind}:${r.definition_id}`);
    }));
    return new Set(per.flat());
  };
  for (const q of ['safety audit', 'customer complaints', 'wastage', 'machine', 'SAP']) {
    const old = await oldSearch(q);
    const hits = await searchOrgChart(pool, COMPANY, { q, limit: 1000 });
    const now = new Set();
    let countsAgree = true;
    for (const h of hits) {
      const oldForPos = [...old].filter((k) => k.startsWith(`${h.positionId}:`));
      if (oldForPos.length !== h.matchCount) countsAgree = false;
      for (const m of h.matches) now.add(`${h.positionId}:${m.kind}:${m.definitionId}`);
    }
    const oldPositions = new Set([...old].map((k) => k.split(':')[0]));
    const samePositions = oldPositions.size === hits.length && hits.every((h) => oldPositions.has(String(h.positionId)));
    const shownAreOld = [...now].every((k) => old.has(k));
    ok(samePositions && countsAgree && shownAreOld, `"${q}": same ${hits.length} positions, same match counts, same lines`,
      `old ${oldPositions.size} positions / new ${hits.length}; counts ${countsAgree}; lines ${shownAreOld}`);
  }
  const exact = await searchJobContent(pool, COMPANY, { q: 'customer complaints', mode: 'exact' });
  ok(exact.mode === 'exact' && exact.notice === null, 'mode=exact answers as exact, with no notice');
}

/* ══ 4 ════════════════════════════════════════════════════════════════════ */
section('[4] Meaning mode');
if (!IS_KARNI) skip('meaning pairs', 'the verified pairs are Karni lines');
else {
  // Verified on Karni 2026-10-15: no word of the question appears in the line.
  const PAIRS = [
    ['hiring people', 'Recruitment: source candidates through consultants, referrals and job portals.'],
    ['paying suppliers', 'Approve vendor payments as per delegation of authority.'],
  ];
  for (const [q, line] of PAIRS) {
    const [[def]] = await pool.query(
      'SELECT id FROM hrms_responsibility_definitions WHERE company_id = ? AND deleted_at IS NULL AND name = ? LIMIT 1', [COMPANY, line]);
    if (!def) { skip(`"${q}"`, 'the line is not in this database'); continue; }
    ok(!keywordSignal(q, q.split(' '), line).keyword, `"${q}" shares no word with "${line.slice(0, 40)}..."`);
    const r = await searchJobContent(pool, COMPANY, { q, limit: 1000 });
    const found = r.items.some((h) => h.matches.some((m) => m.definitionId === def.id && m.kind === 'RESPONSIBILITY'));
    ok(r.mode === 'meaning' && found, `meaning: "${q}" finds it`);
    const ex = await searchJobContent(pool, COMPANY, { q, mode: 'exact', limit: 1000 });
    ok(!ex.items.some((h) => h.matches.some((m) => m.definitionId === def.id)), `exact: "${q}" does not`);
  }
  // A phrase hit outranks a match by meaning only.
  const r = await searchJobContent(pool, COMPANY, { q: 'customer complaints', kinds: 'RESPONSIBILITY', limit: 1000 });
  const lines = new Map();
  for (const h of r.items) for (const m of h.matches) lines.set(m.definitionId, m);
  const phrase = [...lines.values()].filter((m) => m.text.toLowerCase().includes('customer complaints'));
  const loose = [...lines.values()].filter((m) => !m.text.toLowerCase().includes('customer') && !m.text.toLowerCase().includes('complaint'));
  ok(phrase.length > 0 && loose.length > 0 && Math.min(...phrase.map((m) => m.score)) > Math.max(...loose.map((m) => m.score)),
    'every phrase hit scores above every line that matched by meaning alone',
    `phrase min ${Math.min(...phrase.map((m) => m.score))}, loose max ${Math.max(...loose.map((m) => m.score))}`);
  // The floor: nothing below it unless all the words are there.
  const defs = await loadDefinitions(pool, COMPANY, ['RESPONSIBILITY']);
  const { vectors } = await vectorsFor(pool, COMPANY, defs);
  ok(vectors.size === defs.length, `every responsibility has a vector (${vectors.size}/${defs.length})`);
  const wild = await searchJobContent(pool, COMPANY, { q: 'astronaut moon landing' });
  ok(wild.items.length === 0, 'a question nothing in the company is about matches nothing', `${wild.items.length} hits`);
  ok(MEANING_FLOOR > 0 && MEANING_FLOOR < 1, `floor is ${MEANING_FLOOR}`);
}

/* ══ 5 ════════════════════════════════════════════════════════════════════ */
section('[5] A position\'s own lines (rolled back)');
{
  const exact = await searchJobContent(pool, COMPANY, { q: 'machine', mode: 'exact', kinds: 'RESPONSIBILITY', limit: 1000 });
  // A position whose ROLE carries a matching responsibility, with a sibling of the same role.
  const roleOf = new Map(positions.map((p) => [Number(p.id), Number(p.role_id)]));
  const target = exact.items.find((h) => h.matches.some((m) => m.origin === 'ROLE')
    && positions.some((p) => Number(p.id) !== h.positionId && roleOf.get(Number(p.id)) === roleOf.get(h.positionId)));
  const [[recruit]] = await pool.query(
    "SELECT id, name FROM hrms_responsibility_definitions WHERE company_id = ? AND deleted_at IS NULL AND name LIKE 'Recruitment:%' ORDER BY id LIMIT 1", [COMPANY]);
  if (!target || !recruit) skip('position overlay', 'no suitable position or no recruitment line');
  else {
    const P = target.positionId;
    const sibling = positions.find((p) => Number(p.id) !== P && roleOf.get(Number(p.id)) === roleOf.get(P)).id;
    const suppressed = target.matches.find((m) => m.origin === 'ROLE').definitionId;
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      // Is the recruitment line already on this role? Then pick another position-only line.
      await POS.addPositionOverride(conn, c, P, { contentType: 'RESPONSIBILITY', action: 'SUPPRESS', responsibilityDefinitionId: suppressed, reason: TAG });
      await POS.addPositionOverride(conn, c, P, { contentType: 'RESPONSIBILITY', action: 'ADD', responsibilityDefinitionId: recruit.id, reason: TAG });

      const after = await searchJobContent(conn, COMPANY, { q: 'machine', mode: 'exact', kinds: 'RESPONSIBILITY', limit: 1000 });
      const pHit = after.items.find((h) => h.positionId === P);
      const sHit = after.items.find((h) => h.positionId === Number(sibling));
      ok(!pHit?.matches.some((m) => m.definitionId === suppressed), 'the switched-off role line is no longer found on that position');
      ok(Boolean(sHit?.matches.some((m) => m.definitionId === suppressed && m.origin === 'ROLE')), 'but still on its sibling of the same role');

      const words = recruit.name.replace(/[^A-Za-z ]/g, ' ').split(/\s+/).filter((w) => w.length > 3).slice(0, 3).join(' ');
      const added = await searchJobContent(conn, COMPANY, { q: words, mode: 'exact', kinds: 'RESPONSIBILITY', limit: 1000 });
      const pAdded = added.items.find((h) => h.positionId === P)?.matches.find((m) => m.definitionId === recruit.id);
      ok(pAdded?.origin === 'POSITION' || pAdded?.origin === 'ROLE', 'the added line is found on that position (exact)');
      const roleHasIt = (await effectiveLinesForPositions(pool, COMPANY, [{ id: P, roleId: roleOf.get(P) }], { on, kinds: ['RESPONSIBILITY'] }))
        .get(P).some((l) => l.definitionId === recruit.id);
      if (!roleHasIt) {
        ok(pAdded?.origin === 'POSITION', 'and is marked origin POSITION');
        const sAdded = added.items.find((h) => h.positionId === Number(sibling))?.matches.some((m) => m.definitionId === recruit.id);
        ok(!sAdded, 'and is not on the sibling');
      }
      const meaning = await searchJobContent(conn, COMPANY, { q: 'hiring people', kinds: 'RESPONSIBILITY', limit: 1000 });
      ok(Boolean(meaning.items.find((h) => h.positionId === P)?.matches.some((m) => m.definitionId === recruit.id)), 'by meaning too ("hiring people")');
      const wrong = await crossCheck(conn, positions.filter((p) => Number(p.id) === P || Number(p.id) === Number(sibling)));
      ok(wrong.length === 0, 'the batch resolver still agrees with resolveContent for both positions');
    } finally {
      await conn.rollback();
      conn.release();
      invalidateVectors(COMPANY);
    }
  }
}

/* ══ 6 ════════════════════════════════════════════════════════════════════ */
section('[6] Freshness: inline embedding and its cap (rolled back)');
{
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    invalidateVectors(COMPANY);
    const made = [];
    for (let i = 0; i < 5; i += 1) {
      const text = `Inspect the ${TAG} zebra crossing paint, lot ${i}.`;
      const [res] = await conn.query(
        'INSERT INTO hrms_responsibility_definitions (company_id, name, description, status) VALUES (?, ?, ?, \'ACTIVE\')',
        [COMPANY, text, text]);
      made.push(res.insertId);
    }
    const defs = await loadDefinitions(conn, COMPANY, ['RESPONSIBILITY']);
    const mine = defs.filter((d) => made.includes(d.id));
    const first = await vectorsFor(conn, COMPANY, defs, { cap: 2 });
    ok(first.embedded === 2 && first.pending.length === 3, 'five new lines, cap 2: two embedded inline, three pending', `${first.embedded}/${first.pending.length}`);
    ok(mine.filter((d) => first.vectors.has(`RESPONSIBILITY:${d.id}`)).length === 2, 'the pending ones have no vector this time');
    const second = await vectorsFor(conn, COMPANY, defs, { cap: 2 });
    ok(second.embedded === 2 && second.pending.length === 1, 'the next search does two more', `${second.embedded}/${second.pending.length}`);
    const [[{ n }]] = await conn.query(
      `SELECT COUNT(*) n FROM hrms_search_vectors WHERE company_id = ? AND kind = 'RESPONSIBILITY' AND model = ? AND definition_id IN (${made.map(() => '?').join(',')})`,
      [COMPANY, MODEL_ID, ...made]);
    ok(Number(n) === 4, 'what was embedded was stored', `${n}`);

    // A reworded line is stale by its hash and re-embedded.
    const reword = `Check that the ${TAG} pedestrian lines are repainted.`;
    await conn.query('UPDATE hrms_responsibility_definitions SET name = ?, description = ? WHERE id = ?', [reword, reword, made[0]]);
    const defs2 = await loadDefinitions(conn, COMPANY, ['RESPONSIBILITY']);
    const third = await vectorsFor(conn, COMPANY, defs2, { cap: 1 });
    const [[row]] = await conn.query('SELECT text_hash FROM hrms_search_vectors WHERE company_id = ? AND kind = \'RESPONSIBILITY\' AND definition_id = ? AND model = ?', [COMPANY, made[0], MODEL_ID]);
    ok(third.embedded === 1 && row?.text_hash === textHash(definitionText(reword, reword)), 'a reworded line is re-embedded (its hash changed)');

    // The search itself: more stale lines than its cap -> keyword-only for those, and it says so.
    for (let i = 0; i < 40; i += 1) {
      const text = `Audit the ${TAG} forklift battery charging log, bay ${i}.`;
      await conn.query('INSERT INTO hrms_responsibility_definitions (company_id, name, description, status) VALUES (?, ?, ?, \'ACTIVE\')', [COMPANY, text, text]);
    }
    const started = Date.now();
    const r = await searchJobContent(conn, COMPANY, { q: 'forklift battery', kinds: 'RESPONSIBILITY' });
    const ms = Date.now() - started;
    ok(r.mode === 'meaning' && r.pending > 0 && /exact words only/.test(r.notice ?? ''), `over the cap: ${r.pending} pending, with a notice`, `${r.pending} / ${r.notice}`);
    ok(ms < 20000, `and the search did not wait for all of them (${ms} ms)`);
  } finally {
    await conn.rollback();
    conn.release();
    invalidateVectors(COMPANY);
  }
}

/* ══ 7 ════════════════════════════════════════════════════════════════════ */
section('[7] The model unavailable');
{
  await unload();
  __simulateUnavailable('simulated: no network');
  try {
    const r = await searchJobContent(pool, COMPANY, { q: 'customer complaints' });
    const ex = await searchJobContent(pool, COMPANY, { q: 'customer complaints', mode: 'exact' });
    ok(r.mode === 'keyword' && typeof r.notice === 'string' && r.notice.length > 0, 'meaning falls back to keyword, with a notice', `${r.mode}`);
    ok(JSON.stringify(r.items.map((h) => [h.positionId, h.matchCount])) === JSON.stringify(ex.items.map((h) => [h.positionId, h.matchCount])),
      'and answers exactly what exact mode answers');
  } finally {
    __simulateUnavailable(null);
  }
  const back = await searchJobContent(pool, COMPANY, { q: 'customer complaints' });
  ok(back.mode === 'meaning', 'and it recovers once the model can load');
}

/* ══ 7b ═══════════════════════════════════════════════════════════════════ */
section('[7b] The memory guard');
{
  const savedLimit = process.env.CF_HRMS_MEMORY_LIMIT_MB;
  try {
    await unload();
    __clearFailure();
    // A limit this process is already near: rss + 140 MB is past 80 % of it.
    const rss = Math.round(process.memoryUsage().rss / 1048576);
    process.env.CF_HRMS_MEMORY_LIMIT_MB = String(Math.ceil((rss + 100) / 0.8));
    const room = memoryHeadroom();
    ok(!room.ok && room.source === 'CF_HRMS_MEMORY_LIMIT_MB', `headroom refused: ${room.rssMb} + ${room.needMb} MB > ${room.ceilingMb} MB`);
    const r = await searchJobContent(pool, COMPANY, { q: 'customer complaints' });
    ok(r.mode === 'keyword' && /short of memory/.test(r.notice ?? ''), 'the search answers by exact words and says the server is short of memory', `${r.mode} / ${r.notice}`);
    ok(!modelStatus().loaded, 'and the model was not loaded');
    // Room again — but a refusal is not retried for a minute.
    process.env.CF_HRMS_MEMORY_LIMIT_MB = '100000';
    ok(memoryHeadroom().ok, 'with a large limit there is room');
    const again = await searchJobContent(pool, COMPANY, { q: 'customer complaints' });
    ok(again.mode === 'keyword' && !modelStatus().loaded, 'a refusal is not retried within the minute');
    __clearFailure();
    const later = await searchJobContent(pool, COMPANY, { q: 'customer complaints' });
    ok(later.mode === 'meaning' && modelStatus().loaded, 'after the wait it loads');
    // Loaded already: a tight limit does not take a working model away.
    process.env.CF_HRMS_MEMORY_LIMIT_MB = '1';
    const loaded = await searchJobContent(pool, COMPANY, { q: 'customer complaints' });
    ok(loaded.mode === 'meaning', 'a model already loaded is used as it is');
    delete process.env.CF_HRMS_MEMORY_LIMIT_MB;
    const { mb, source } = memoryLimitMb();
    ok(mb > 0 && ['container', 'assumed'].includes(source), `without the override the limit is ${mb} MB (${source})`);
  } finally {
    if (savedLimit === undefined) delete process.env.CF_HRMS_MEMORY_LIMIT_MB; else process.env.CF_HRMS_MEMORY_LIMIT_MB = savedLimit;
    __clearFailure();
  }
}

/* ══ 8 ════════════════════════════════════════════════════════════════════ */
section('[8] Tenant isolation');
{
  const mine = new Set(positions.map((p) => Number(p.id)));
  const r = await searchJobContent(pool, COMPANY, { q: 'customer complaints', limit: 1000 });
  ok(r.items.every((h) => mine.has(h.positionId)), 'every hit is a position of this company');
  if (other) {
    const [theirs] = await pool.query('SELECT id FROM hrms_positions WHERE company_id = ?', [other.id]);
    const theirIds = new Set(theirs.map((p) => Number(p.id)));
    const o = await searchJobContent(pool, other.id, { q: 'customer complaints', limit: 1000 });
    ok(o.items.every((h) => theirIds.has(h.positionId) && !mine.has(h.positionId)), `another company (${other.slug}) sees only its own positions (${o.items.length} hits)`);
    const defIds = new Set((await loadDefinitions(pool, COMPANY, ['KRA', 'RESPONSIBILITY', 'KPI'])).map((d) => `${d.kind}:${d.id}`));
    ok(o.items.every((h) => h.matches.every((m) => !defIds.has(`${m.kind}:${m.definitionId}`))), 'and none of this company\'s lines');
  } else skip('another company', 'there is none');
}

/* ══ 9 ════════════════════════════════════════════════════════════════════ */
section('[9] Over HTTP');
{
  const server = express();
  server.use(express.json());
  server.use(cookieParser());
  server.use('/api', appContext);
  hrmsApp.register(server);
  const listener = await new Promise((resolve) => { const l = server.listen(0, '127.0.0.1', () => resolve(l)); });
  const base = `http://127.0.0.1:${listener.address().port}/api`;
  const tokenFor = async (where) => {
    const [[u]] = await pool.query(
      `SELECT u.id, u.email, u.company_id, co.slug, r.name AS role FROM users u
         JOIN companies co ON co.id = u.company_id LEFT JOIN roles r ON r.id = u.role_id
        WHERE u.deleted_at IS NULL AND ${where} ORDER BY u.id LIMIT 1`);
    return u ? { ...u, token: signToken({ id: u.id, email: u.email, role: u.role, company: u.slug, companyId: u.company_id, company_id: u.company_id, uiPermissions: [] }) } : null;
  };
  const call = async (who, url) => {
    const res = await fetch(`${base}${url}`, { headers: { Authorization: `Bearer ${who.token}` } });
    let json = null;
    try { json = await res.json(); } catch { /* no body */ }
    return { status: res.status, json };
  };
  try {
    const hasApp = `EXISTS (SELECT 1 FROM app_user_access x JOIN apps a ON a.id = x.app_id WHERE x.user_id = u.id AND x.deleted_at IS NULL AND a.slug = 'cf_hrms')`;
    const admin = await tokenFor(`u.company_id = ${COMPANY} AND LOWER(r.name) = 'admin' AND ${hasApp}`);
    const employee = await tokenFor(`u.company_id = ${COMPANY} AND r.name = 'Employee' AND ${hasApp}`);
    const outsider = await tokenFor(`u.company_id <> ${COMPANY} AND LOWER(r.name) = 'admin' AND ${hasApp}`);
    const url = `/${slug}/cf_hrms/orgchart/search?q=${encodeURIComponent('machine stops')}&kinds=KRA,RESPONSIBILITY&mode=meaning`;
    if (!admin) skip('admin over HTTP', 'no admin login');
    else {
      const a = await call(admin, url);
      ok(a.status === 200 && a.json?.mode === 'meaning' && Array.isArray(a.json?.items) && a.json.items.length > 0,
        'admin: 200 with { mode, items }', `${a.status} ${JSON.stringify(a.json)?.slice(0, 120)}`);
      ok(a.json?.items?.every((h) => h.matches.every((m) => m.kind !== 'KPI')), 'kinds is honoured over HTTP');
      const bad = await call(admin, `/${slug}/cf_hrms/orgchart/search?q=x&kinds=SALARY`);
      ok(bad.status === 422, 'a bad kind is refused (422)', `${bad.status}`);
    }
    if (!employee) skip('Employee over HTTP', 'no Employee login with the app');
    else ok((await call(employee, url)).status === 403, 'an Employee login: 403');
    if (!outsider) skip('another company\'s admin', 'none');
    else ok((await call(outsider, url)).status === 403, `an admin of another company (${outsider.slug}) on this company's URL: 403`);
  } finally {
    await new Promise((resolve) => listener.close(resolve));
  }
}

/* ══ the end ══════════════════════════════════════════════════════════════ */
section('[end] Nothing left behind');
const after = await counts();
ok(after === before, 'vectors, overrides and definitions as found', `${before} -> ${after}`);

await unload();
console.log(`\n${passed} passed, ${failed.length} failed, ${skipped.length} skipped`);
if (failed.length) { console.log('\nFAILED:'); for (const f of failed) console.log(`  - ${f}`); }
await pool.end();
process.exit(failed.length ? 1 : 0);
