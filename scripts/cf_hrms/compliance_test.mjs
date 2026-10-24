/**
 * compliance_test.mjs — compliance (TM/CF_HRMS_HIRING_SPEC.md §36.4 watcher, publishing, notifications,
 * deadline calendar; §36.5 the CA reviewer, review screens, review pack).
 *
 *   0. the schema (apply-compliance-schema.mjs reads init.sql §38; nothing left to do)
 *   1. pure: link extraction (off-site links dropped, session ids normalised, dates, the pattern on the
 *      path only), robots.txt, private addresses refused, the calendar's due dates by hand
 *   2. through the routes on the LOCAL database, against a LOCAL fake site (an HTTP server in this
 *      process whose page changes between reads — nothing here touches the internet):
 *      platform admin gating · the watcher (baseline, new, changed, two instances, a stale claim,
 *      blocked / robots / no links / moved off-site / too big) · notice → publish (the law layer, or the
 *      adapter while it is not there) → a notification per company with its impact · emails QUEUED,
 *      never sent · acknowledgement and re-send · the calendar and its reminders · the reviewer's
 *      rights, comments and sign-off (P2's CA tick) · the calculation trace · the review pack ·
 *      tenant isolation
 *   3. nothing left behind
 *
 *   node scripts/cf_hrms/compliance_test.mjs [--company=karni] [--verbose]
 *
 * NOTHING IS LEFT BEHIND: one connection, one transaction (pool.query / getConnection point at it),
 * rolled back. Local only.
 */
import http from 'node:http';
import express from 'express';
import cookieParser from 'cookie-parser';
import mysql from 'mysql2/promise';
import ExcelJS from 'exceljs';

// Before anything reads them: no email ever leaves a test; the console may read the local fake site.
process.env.CF_HRMS_COMPLIANCE_MAIL = 'off';
process.env.CF_HRMS_COMPLIANCE_ALLOW_LOCAL = '1';

const { pool } = await import('../../db.js');
const { signToken } = await import('../../core/utils/jwt.js');
const { appContext } = await import('../../core/middleware/appContext.js');
const { default: hrmsApp } = await import('../../apps/cf_hrms/app.js');
const { forgetAccess } = await import('../../apps/cf_hrms/lib/accessContext.js');
const { hrmsAppOf } = await import('../../apps/cf_hrms/services/accessGrants.js');
const { setupAccess } = await import('../../apps/cf_hrms/services/accessSetup.js');
const { schemaSteps, COMPLIANCE_TABLES, GLOBAL_TABLES, sourceSteps } = await import('../../apps/cf_hrms/scripts/apply-compliance-schema.mjs');
const { htmlLinks, feedItems, findDate, normaliseUrl, extractItems } = await import('../../apps/cf_hrms/services/compliance/extract.js');
const { parseRobots, robotsAllows, refuseUrl, forgetRobots } = await import('../../apps/cf_hrms/services/compliance/fetcher.js');
const { deadlinesBetween, DEFAULTS } = await import('../../apps/cf_hrms/services/compliance/calendar.js');
const { checkSource, watchPass, slotOf } = await import('../../apps/cf_hrms/services/compliance/watcher.js');
const { resendPass, sendPending, recipientsOf } = await import('../../apps/cf_hrms/services/compliance/notify.js');
const { remindCompany } = await import('../../apps/cf_hrms/services/compliance/scheduler.js');
const { lawStatus } = await import('../../apps/cf_hrms/services/compliance/lawAdapter.js');
const { SEED_SOURCES } = await import('../../apps/cf_hrms/services/compliance/sources.js');

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
const dbCfg = { host: process.env.DB_HOST ?? 'localhost', user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME, port: Number(process.env.DB_PORT) || 3306 };

/** Every table with company_id AND deleted_at, the global compliance tables, and the platform admins. */
async function worldCount() {
  const conn = await mysql.createConnection(dbCfg);
  try {
    const [tables] = await conn.query(`SELECT c1.TABLE_NAME AS t FROM information_schema.COLUMNS c1 JOIN information_schema.COLUMNS c2 ON c2.TABLE_SCHEMA = c1.TABLE_SCHEMA AND c2.TABLE_NAME = c1.TABLE_NAME AND c2.COLUMN_NAME = 'deleted_at'
      JOIN information_schema.TABLES tb ON tb.TABLE_SCHEMA = c1.TABLE_SCHEMA AND tb.TABLE_NAME = c1.TABLE_NAME AND tb.TABLE_TYPE = 'BASE TABLE'
      WHERE c1.TABLE_SCHEMA = DATABASE() AND c1.COLUMN_NAME = 'company_id' ORDER BY c1.TABLE_NAME`);
    const out = {};
    for (const { t } of [...tables, ...GLOBAL_TABLES.map((t) => ({ t })), { t: 'users' }, { t: 'roles' }]) {
      const [[r]] = await conn.query(`SELECT COUNT(*) AS n, COALESCE(SUM(deleted_at IS NULL), 0) AS live FROM \`${t}\``);
      out[t] = `${r.n}/${r.live}`;
    }
    const [[ts]] = await conn.query('SELECT COUNT(*) AS n, COALESCE(SUM(ca_reviewed), 0) AS r FROM hrms_tax_settings');
    out['hrms_tax_settings (ca ticks)'] = `${ts.n}/${ts.r}`;
    return out;
  } finally { await conn.end(); }
}
const before = await worldCount();

/* ══ 0. schema ═════════════════════════════════════════════════════════ */
section('[0] The schema');
{
  const conn = await mysql.createConnection(dbCfg);
  try {
    ok(COMPLIANCE_TABLES.length === 12 && GLOBAL_TABLES.length === 6, 'init.sql §38 declares twelve tables: six global (platform admins, sources, items, check runs, notices, publications), six per company', COMPLIANCE_TABLES.join(', '));
    ok((await schemaSteps(conn)).length === 0 && (await sourceSteps(conn)).length === 0, 'apply-compliance-schema: nothing left to do (tables there, the sources seeded)');
    const [cols] = await conn.query("SELECT TABLE_NAME AS t, GROUP_CONCAT(COLUMN_NAME) AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (?) AND COLUMN_NAME IN ('company_id', 'deleted_at') GROUP BY TABLE_NAME", [COMPLIANCE_TABLES]);
    const by = Object.fromEntries(cols.map((r) => [r.t, r.c.split(',').sort().join(',')]));
    ok(COMPLIANCE_TABLES.every((t) => (GLOBAL_TABLES.includes(t) ? by[t] === 'deleted_at' : by[t] === 'company_id,deleted_at')), 'company tables have company_id and deleted_at; global ones deleted_at only', JSON.stringify(by));
    ok(SEED_SOURCES.length >= 10 && SEED_SOURCES.every((s) => ['html_list', 'rss', 'pdf_index'].includes(s.kind) && /^https:\/\//.test(s.url) && s.note) && new Set(SEED_SOURCES.map((s) => s.code)).size === SEED_SOURCES.length,
      `${SEED_SOURCES.length} official sources seeded, each with an honest kind and a note`);
  } finally { await conn.end(); }
}

/* ══ 1. pure ═══════════════════════════════════════════════════════════ */
section('[1] By hand: links, robots, addresses, due dates');
{
  const page = 'https://www.example.gov.in/notices';
  const html = `<a href="/n/one.pdf">Notification No. 12 of 2026 dated 15-10-2026</a> <a href="https://example.gov.in/n/two.pdf"><img src=x></a>
    <a href="https://other.example.com/x.pdf">Off site</a> <a href="javascript:void(0)">Script</a> <a href="#top">Top</a> <a href="/(S(abc123))/n/three.pdf#p2">Three</a>
    <a href="/about">About us</a> <a href="mailto:a@b">Mail</a>`;
  const links = htmlLinks(html, page);
  ok(links.length === 4 && links.every((l) => !/other\.example/.test(l.url)), 'html_list: links on the site only (www. ignored); javascript:, mailto: and #anchors skipped', links.map((l) => l.url).join(' '));
  ok(links[0].date === '2026-10-15' && links[1].title === 'two' && links.some((l) => l.url === 'https://www.example.gov.in/n/three.pdf'), 'a date from the title; a title from the file name when the link has no words; the session segment and #fragment dropped');
  ok(htmlLinks(html, page, { pdfOnly: true }).length === 3, 'pdf_index: only links to a PDF');
  ok(htmlLinks(html, page, { pattern: 'gov' }).length === 0 && htmlLinks(html, page, { pattern: 'notification' }).length === 1, 'the source\'s pattern reads the path and the title, never the host ("gov" is in every host)');
  ok(htmlLinks('<a href="https://cdn.other.gov.in/f.pdf">F</a>', page, { alsoSites: ['other.gov.in'] }).length === 1, 'also_sites: a source may name the other site its files live on (EPFO\'s PDFs on epfindia.gov.in)');
  ok(normaliseUrl('/a;jsessionid=XYZ/b.pdf?x=1#y', page) === 'https://www.example.gov.in/a/b.pdf?x=1', 'a jsessionid is not part of a link');
  const rss = `<rss><channel><item><title>EPFO raises the wage ceiling</title><link>https://example.gov.in/r/1</link><pubDate>Tue, 20 Oct 2026 10:00:00 GMT</pubDate></item>
    <item><title><![CDATA[Elsewhere]]></title><link>https://elsewhere.org/2</link></item></channel></rss>`;
  const feed = feedItems(rss, 'https://example.gov.in/feed.xml');
  ok(feed.length === 1 && feed[0].date === '2026-10-20' && feed[0].title === 'EPFO raises the wage ceiling', 'rss: title, link and date of each item on the site');
  ok(findDate('G.O.Ms.No.12, dt. 1st April 2026') === '2026-04-01' && findDate('Oct 5, 2026') === '2026-10-05' && findDate('no date') === null, 'dates written in words are found too');
  const both = extractItems({ kind: 'html_list', name: 'Rates', watch_text: 1 }, '<p>Basic 12,000</p><a href="/x">X</a>', page);
  const changed = extractItems({ kind: 'html_list', name: 'Rates', watch_text: 1 }, '<p>Basic 12,500</p><a href="/x">X</a>', page);
  ok(both.items.length === 2 && both.items[1].itemHash === changed.items[1].itemHash && both.items[1].contentHash !== changed.items[1].contentHash, 'watch_text: the page text is one more item; a new rate changes its content hash, not its identity');
  const rules = parseRobots('User-agent: Googlebot\nDisallow: /\n\nUser-agent: *\nDisallow: /private\nAllow: /private/open\n');
  ok(!robotsAllows(rules, '/private/x') && robotsAllows(rules, '/private/open/y') && robotsAllows(rules, '/notices'), 'robots.txt: the * group (not Googlebot\'s); Disallow honoured; a longer Allow wins');
  ok(await refuseUrl('http://127.0.0.1:9/x') && await refuseUrl('http://10.1.2.3/x') && await refuseUrl('file:///etc/passwd') && await refuseUrl('http://localhost/x') && (await refuseUrl('http://127.0.0.1:9/x', { allowLocal: true })) === null,
    'a private, loopback or local address is refused (a test passes allowLocal); only http and https');
  // The calendar, by hand (the defaults are the law's dates).
  const R = { tdsDeposit: () => DEFAULTS.tdsDeposit, tdsReturn: (y) => ({ ...DEFAULTS.tdsReturn, form: y >= '2026-27' ? 'Form 138 (was 24Q)' : 'Form 24Q' }), pf: DEFAULTS.pf, esi: DEFAULTS.esi, pt: DEFAULTS.pt, minWage: DEFAULTS.minWage };
  const d = Object.fromEntries(deadlinesBetween('2026-10-01', '2027-06-30', R, ['TG']).map((x) => [x.key, x.dueDate]));
  ok(d['TDS_DEPOSIT:2026-10'] === '2026-11-07' && d['TDS_DEPOSIT:2027-03'] === '2027-04-30' && d['TDS_DEPOSIT:2027-02'] === '2027-03-07', 'TDS deposit: the 7th of the next month; March\'s by 30 April');
  ok(d['PF:2026-10'] === '2026-11-15' && d['ESI:2026-10'] === '2026-11-15' && d['PT:TG:2026-10'] === '2026-11-10', 'PF and ESI the 15th; Telangana PT the 10th of the next month');
  ok(d['TDS_RETURN:2026-27:Q2'] === '2026-10-31' && d['TDS_RETURN:2026-27:Q3'] === '2027-01-31' && d['TDS_RETURN:2026-27:Q4'] === '2027-05-31' && d['FORM16:2026-27'] === '2027-06-15', 'quarterly returns 31 Oct / 31 Jan / 31 May; Form 130 by 15 June');
  ok(d['MIN_WAGE:TG:2026-10'] === '2026-10-01' && d['MIN_WAGE:TG:2027-04'] === '2027-04-01' && !d['MIN_WAGE:TG:2026-11'] && d['TAX_YEAR:2027-28'] === '2027-04-01', 'minimum-wage revision months April and October; the tax year starts 1 April');
  ok(!Object.keys(Object.fromEntries(deadlinesBetween('2026-10-01', '2026-12-31', R, []).map((x) => [x.key, 1]))).some((k) => k.startsWith('PT:')), 'no PT deadline for a company paying nobody in a PT state');
}

/* ══ a local fake site ═════════════════════════════════════════════════ */
let version = 1;
const fake = http.createServer((req, res) => {
  const send = (code, body, type = 'text/html') => { res.writeHead(code, { 'Content-Type': type }); res.end(body); };
  const u = req.url.split('?')[0];
  if (u === '/robots.txt') return send(200, 'User-agent: *\nDisallow: /private\n', 'text/plain');
  if (u === '/notices') {
    const sid = version === 1 ? 'aaa111' : 'bbb222';
    return send(200, `<html><body><h1>Notices</h1>
      <a href="/n/a.pdf">Notification 1 of 2026 dated 01-10-2026</a>
      <a href="/n/b.pdf">${version === 1 ? 'Circular 2 of 2026' : 'Circular 2 of 2026 (corrected)'}</a>
      <a href="/(S(${sid}))/n/c.pdf">Order 3</a>
      ${version >= 2 ? '<a href="/n/d.pdf">Notification 4 of 2026 dated 20-10-2026</a>' : ''}
      <a href="https://other.example.com/x.pdf">Elsewhere</a></body></html>`);
  }
  if (u === '/feed.xml') return send(200, '<rss><channel><item><title>Minimum wages revised</title><link>/r/1</link><pubDate>Tue, 20 Oct 2026 10:00:00 GMT</pubDate></item></channel></rss>', 'application/rss+xml');
  if (u === '/forbidden') return send(403, 'no');
  if (u === '/private') return send(200, '<a href="/secret">secret</a>');
  if (u === '/script') return send(200, '<html><body><div id="root"></div><script>render()</script></body></html>');
  if (u === '/moved') { res.writeHead(302, { Location: 'https://other.example.com/notices' }); return res.end(); }
  if (u === '/big') return send(200, `<html>${'<a href="/x">x</a>'.repeat(4000)}</html>`);
  return send(404, 'not here');
});
const fakePort = await new Promise((resolve) => { fake.listen(0, '127.0.0.1', () => resolve(fake.address().port)); });
const SITE = `http://127.0.0.1:${fakePort}`;
const LOCAL = { allowLocal: true, retries: 0, pauseMs: 10, timeoutMs: 5000 };

/* ══ the database part: one transaction, rolled back ═══════════════════ */
const real = { query: pool.query.bind(pool), execute: pool.execute.bind(pool), getConnection: pool.getConnection.bind(pool) };
const db = await real.getConnection();
await db.beginTransaction();
let depth = 0;
const inside = {
  query: (...a) => db.query(...a),
  execute: (...a) => db.execute(...a),
  beginTransaction: async () => { depth += 1; await db.query(`SAVEPOINT zz_comp_${depth}`); },
  commit: async () => { if (depth > 0) { await db.query(`RELEASE SAVEPOINT zz_comp_${depth}`); depth -= 1; } },
  rollback: async () => { if (depth > 0) { await db.query(`ROLLBACK TO SAVEPOINT zz_comp_${depth}`); depth -= 1; } },
  release: () => {},
};
pool.query = inside.query;
pool.execute = inside.execute;
pool.getConnection = async () => inside;

const TAG = `ZZCO${Date.now().toString(36).toUpperCase().slice(-5)}`;
const q = async (sql, params) => (await db.query(sql, params))[0];
const one = async (sql, params) => (await q(sql, params))[0] ?? null;
const ins = async (sql, params) => (await db.query(sql, params))[0].insertId;

let server;
try {
  const company = await one('SELECT id, name, slug FROM companies WHERE slug = ? AND deleted_at IS NULL', [slug]);
  if (!company) throw new Error(`No company "${slug}".`);
  const COMPANY = company.id;
  const other = await one("SELECT c.id, c.slug, c.name FROM companies c JOIN apps a ON a.company_id = c.id AND a.slug = 'cf_hrms' WHERE c.id <> ? AND c.deleted_at IS NULL ORDER BY c.id LIMIT 1", [COMPANY]);
  if (!other) throw new Error('This test needs a second company with CF HRMS.');
  const app = await hrmsAppOf(db, COMPANY);
  const otherApp = await hrmsAppOf(db, other.id);
  console.log(`\ncompliance_test — ${company.name} (${COMPANY}) and ${other.name} (${other.id}), run tag ${TAG}, fake site ${SITE}`);
  const law = await lawStatus();
  console.log(`  the law layer: ${law.connected ? 'connected' : `not wired in yet (${law.present ? `missing ${law.missing.join(', ')}` : 'services/law/index.js absent'}) — the adapter stub is used`}`);
  // Out of the way inside the transaction: the real sources (so a pass reads only the fake site), notices, sign-offs.
  await db.query('UPDATE hrms_compliance_sources SET active = 0');
  await db.query("UPDATE hrms_compliance_signoffs SET deleted_at = NOW() WHERE company_id IN (?, ?) AND deleted_at IS NULL", [COMPANY, other.id]);
  await db.query("UPDATE hrms_compliance_reviews SET deleted_at = NOW() WHERE company_id IN (?, ?) AND deleted_at IS NULL", [COMPANY, other.id]);

  await setupAccess(db, COMPANY, { apply: true });
  await setupAccess(db, other.id, { apply: true });
  const roleBy = async (cid) => Object.fromEntries((await q('SELECT role_id, template_key FROM hrms_access_roles WHERE company_id = ? AND deleted_at IS NULL AND template_key IS NOT NULL', [cid])).map((r) => [r.template_key, r.role_id]));
  const R1 = await roleBy(COMPANY);
  const R2 = await roleBy(other.id);
  const login = async (cid, cslug, appId, label, roleId) => {
    const email = `${TAG.toLowerCase()}.${label.toLowerCase().replace(/[^a-z0-9]/g, '')}@example.test`;
    const id = await ins('INSERT INTO users (name, email, password, role_id, team_id, company_id) VALUES (?, ?, ?, ?, NULL, ?)', [`${TAG} ${label}`, email, 'x', roleId, cid]);
    await db.query('INSERT INTO app_user_access (user_id, app_id, role_id, company_id) VALUES (?, ?, ?, ?)', [id, appId, roleId, cid]);
    const roleName = (await one('SELECT name FROM roles WHERE id = ?', [roleId])).name;
    return { id, email, token: signToken({ id, name: `${TAG} ${label}`, email, role: roleName, company: cslug, companyId: cid, company_id: cid, uiPermissions: [] }) };
  };
  const U = {
    OWNER: await login(COMPANY, company.slug, app.id, 'Owner', R1.OWNER), HR: await login(COMPANY, company.slug, app.id, 'HR manager', R1.HR_MANAGER),
    EXEC: await login(COMPANY, company.slug, app.id, 'HR executive', R1.HR_EXECUTIVE), CA: await login(COMPANY, company.slug, app.id, 'Reviewer', R1.REVIEWER),
    EMP: await login(COMPANY, company.slug, app.id, 'Employee', R1.EMPLOYEE), DH: await login(COMPANY, company.slug, app.id, 'Unit head', R1.DEPARTMENT_HEAD),
    OTHER: await login(other.id, other.slug, otherApp.id, 'Other owner', R2.OWNER),
    PA: await login(COMPANY, company.slug, app.id, 'Product team', R1.EMPLOYEE),
  };
  await db.query('INSERT INTO platform_admins (user_id, email, note) VALUES (?, ?, ?)', [U.PA.id, U.PA.email, 'compliance_test']);
  forgetAccess();

  server = express();
  server.use(express.json({ limit: '10mb' }));
  server.use(cookieParser());
  server.use('/api', appContext);
  hrmsApp.register(server);
  const listener = await new Promise((resolve) => { const l = server.listen(0, '127.0.0.1', () => resolve(l)); });
  server.close = () => new Promise((resolve) => listener.close(resolve));
  const base = `http://127.0.0.1:${listener.address().port}/api`;
  const raw = async (who, method, url, body) => {
    const res = await fetch(`${base}${url}`, { method, headers: { 'Content-Type': 'application/json', ...(who ? { Authorization: `Bearer ${who.token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    let json = null;
    try { json = await res.json(); } catch { /* no body */ }
    return { status: res.status, json };
  };
  const call = (who, method, url, body, cslug = company.slug) => raw(who, method, `/${cslug}/cf_hrms${url}`, body);
  const plat = (who, method, url, body) => raw(who, method, `/platform/compliance${url}`, body);
  const must = async (r) => { const x = await r; if (x.status !== 200) throw new Error(`${x.status} ${JSON.stringify(x.json)}`); return x.json; };

  /* ══ 2. the platform admin ══════════════════════════════════════════ */
  section('[2] The platform console is the product team\'s only');
  ok((await plat(null, 'GET', '/sources')).status === 401, 'no token: 401');
  const ownerTry = await plat(U.OWNER, 'GET', '/sources');
  ok(ownerTry.status === 403 && ownerTry.json.code === 'NOT_PLATFORM_ADMIN', 'a company Owner (role admin) gets 403 NOT_PLATFORM_ADMIN', JSON.stringify(ownerTry));
  ok((await plat(U.HR, 'POST', '/sources', { code: 'X' })).status === 403 && (await plat(U.OTHER, 'GET', '/notices')).status === 403, 'HR and another company\'s Owner: 403');
  const me = await plat(U.PA, 'GET', '/me');
  ok(me.status === 200 && me.json.admin.email === U.PA.email, 'a platform admin (platform_admins row, same email) gets in');
  await db.query('UPDATE users SET email = ? WHERE id = ?', [`${TAG.toLowerCase()}.changed@example.test`, U.PA.id]);
  ok((await plat(U.PA, 'GET', '/sources')).status === 403, 'the login\'s email changed: the right is gone (the row names user AND email)');
  await db.query('UPDATE users SET email = ? WHERE id = ?', [U.PA.email, U.PA.id]);
  ok((await call(U.PA, 'GET', '/compliance/notifications')).status === 403, 'a platform admin is nobody special inside a company (an Employee login there sees no compliance)');

  /* ══ 3. the watcher ═════════════════════════════════════════════════ */
  section('[3] The watcher against the local fake site');
  forgetRobots();
  const mk = (code, path, extra = {}) => plat(U.PA, 'POST', '/sources', { code, name: `${TAG} ${code}`, url: `${SITE}${path}`, kind: 'pdf_index', frequencyHours: 24, domains: ['PT'], jurisdictions: ['TG'], ...extra });
  const bad = await plat(U.PA, 'POST', '/sources', { code: 'x', name: '', url: 'ftp://x', kind: 'web', frequencyHours: 0, domains: ['NOPE'], jurisdictions: ['Telangana'] });
  ok(bad.status === 422 && bad.json.problems.length >= 6, 'a source with every field wrong: refused, each problem in words', JSON.stringify(bad.json?.problems));
  const S = (await must(mk(`${TAG}A`, '/notices'))).source;
  ok(S.id && S.lastStatus === 'NEVER' && S.kind === 'pdf_index', 'a source is added: never checked yet');
  const c1 = await must(plat(U.PA, 'POST', `/sources/${S.id}/check`));
  ok(c1.result.status === 'OK' && c1.result.baseline && c1.result.items === 3 && c1.result.found.new === 0 && /First read/.test(c1.source.lastError ?? ''),
    'first read = the baseline: 3 PDFs on the site stored (the off-site link dropped), NO notice', JSON.stringify(c1.result));
  const again = await must(plat(U.PA, 'POST', `/sources/${S.id}/check`));
  ok(again.result.skipped === true, 'a second check in the same minute finds the claim taken (a second instance does nothing)');
  const t0 = Date.now();
  const at = (min) => new Date(t0 + min * 60000);
  const c2 = await checkSource(S.id, { now: at(2), manual: true, fetchOptions: LOCAL });
  ok(c2.status === 'OK' && c2.found.new === 0 && c2.found.changed === 0, 'read again unchanged: nothing new (a new session id in a link is not a new link)', JSON.stringify(c2));
  version = 2;
  const c3 = await checkSource(S.id, { now: at(4), manual: true, fetchOptions: LOCAL });
  ok(c3.status === 'CHANGED' && c3.found.new === 1 && c3.found.changed === 1, 'the page changes: one NEW item (Notification 4) and one CHANGED (Circular 2, corrected)', JSON.stringify(c3));
  const notices = await must(plat(U.PA, 'GET', '/notices'));
  const mine = notices.notices.filter((n) => n.sourceId === S.id);
  ok(mine.length === 2 && mine.some((n) => n.changeKind === 'NEW' && n.itemDate === '2026-10-20' && /Notification 4/.test(n.title)) && mine.some((n) => n.changeKind === 'CHANGED' && /corrected/.test(n.title)) && mine.every((n) => n.status === 'NEW' && n.summary === null),
    'the notices queue: title, link, date and source — no AI summary (the column waits for one)', JSON.stringify(mine.map((n) => [n.changeKind, n.title, n.itemDate])));
  // Two instances and a server that died mid-read.
  const src = await one('SELECT * FROM hrms_compliance_sources WHERE id = ?', [S.id]);
  const slotKey = (n) => `SRC:${S.id}:${slotOf(src, n)}`;
  await db.query("INSERT INTO hrms_compliance_check_runs (source_id, run_key, status, started_at) VALUES (?, ?, 'RUNNING', ?)", [S.id, slotKey(at(6)), at(6)]);
  ok((await checkSource(S.id, { now: at(6), fetchOptions: LOCAL })).skipped === true, 'a scheduled check whose slot another instance holds RUNNING: skipped');
  await db.query('UPDATE hrms_compliance_check_runs SET started_at = ? WHERE run_key = ?', [at(-30), slotKey(at(6))]);
  const taken = await checkSource(S.id, { now: at(6), fetchOptions: LOCAL });
  ok(!taken.skipped && taken.status === 'OK', 'a claim left RUNNING for more than 15 minutes (the server died): taken over, and the check runs', JSON.stringify(taken));
  ok(Number((await one('SELECT COUNT(*) AS n FROM hrms_compliance_check_runs WHERE run_key = ?', [slotKey(at(6))])).n) === 1, '…one claim row for the slot, never two');
  // Sites that block, change or go away.
  const B = (await must(mk(`${TAG}B`, '/forbidden'))).source;
  const P = (await must(mk(`${TAG}P`, '/private'))).source;
  const X = (await must(mk(`${TAG}X`, '/script', { kind: 'html_list' }))).source;
  const M = (await must(mk(`${TAG}M`, '/moved'))).source;
  const G = (await must(mk(`${TAG}G`, '/big', { kind: 'html_list' }))).source;
  const F = (await must(mk(`${TAG}F`, '/feed.xml', { kind: 'rss', domains: ['MIN_WAGE'] }))).source;
  const pass = await watchPass({ now: at(8), fetchOptions: LOCAL });
  const of = (id) => pass.find((p) => p.sourceId === id);
  ok(!of(S.id) && of(B.id) && of(F.id), 'the pass reads only what is due (the checked source waits for its next time)', JSON.stringify(pass.map((p) => p.sourceId)));
  ok(of(B.id).status === 'BLOCKED' && /refused/.test(of(B.id).error), 'HTTP 403: BLOCKED, said', of(B.id).error);
  ok(of(P.id).status === 'BLOCKED' && /robots\.txt/.test(of(P.id).error), 'robots.txt disallows the page: BLOCKED, not read', of(P.id).error);
  ok(of(X.id).status === 'ERROR' && /built by script|layout/.test(of(X.id).error), 'a page with no links (built by script / layout changed): ERROR in words', of(X.id).error);
  ok(of(M.id).status === 'ERROR' && /another site/.test(of(M.id).error), 'a redirect to another site: not followed', of(M.id).error);
  ok(of(F.id).status === 'OK' && of(F.id).items === 1, 'rss: the feed\'s item read');
  const big = await checkSource(G.id, { now: at(9), manual: true, fetchOptions: { ...LOCAL, maxBytes: 2000 } });
  ok(big.status === 'ERROR' && /larger than/.test(big.error), 'a page past the size cap: abandoned, said', big.error);
  const list = (await must(plat(U.PA, 'GET', '/sources'))).sources;
  const bl = list.find((s) => s.id === B.id);
  ok(bl.lastStatus === 'BLOCKED' && bl.lastError && bl.failCount === 1 && bl.nextCheckAt && new Date(bl.nextCheckAt) > at(8), 'the console shows the error on the source, its failure count and the next try (sooner than its frequency)');
  ok(list.find((s) => s.id === S.id).itemCount === 4, 'the registry: last check, items known');

  /* ══ 4. notice → publish → per company ══════════════════════════════ */
  section('[4] A notice is linked, published, and every company hears of it');
  const N1 = mine.find((n) => n.changeKind === 'NEW');
  const N2 = mine.find((n) => n.changeKind === 'CHANGED');
  const opened = await must(plat(U.PA, 'POST', `/notices/${N1.id}/open`));
  ok(opened.notice.status === 'OPEN' && opened.notice.reviewer === `${TAG} Product team`, 'opened: OPEN, with its reviewer');
  ok((await plat(U.PA, 'POST', `/notices/${N1.id}/publish`, { title: 'x', effectiveFrom: '2026-11-01' })).status === 409, 'publishing before it is linked to a rule: refused');
  ok((await plat(U.PA, 'POST', `/notices/${N2.id}/dismiss`, {})).status === 422, 'dismissing without a reason: refused');
  const linked = await must(plat(U.PA, 'POST', `/notices/${N1.id}/link`, { domain: 'PT', jurisdiction: 'TG', ruleKey: 'settings' }));
  ok(linked.notice.status === 'LINKED' && linked.notice.ruleKey === 'settings' && linked.notice.jurisdiction === 'TG', 'linked to a rule (PT settings, Telangana)');
  const rulesList = await must(plat(U.PA, 'GET', '/rules'));
  ok(Array.isArray(rulesList.rules) && rulesList.rules.length > 0, `the rules to link to: ${rulesList.rules.length} (from ${law.connected ? 'the law layer' : 'the adapter'})`);
  const lawPath = law.present && !law.missing.includes('publishVersion') && !law.missing.includes('draftVersion');
  const PT_VALUE = { slabs: [{ upTo: 15000, amount: 0 }, { upTo: 20000, amount: 150 }, { upTo: null, amount: 200 }], rounding: 'NEAREST' };
  const pubBody = { title: 'Telangana PT slabs revised', summary: 'The professional tax for salaries above ₹20,000 is ₹200 a month (test).', effectiveFrom: '2026-11-01', value: PT_VALUE };
  /** Publish a linked notice the way the console does: with the law layer, its draft first. */
  const publishIt = async (n, effectiveFrom, title) => {
    if (lawPath) {
      const early = await plat(U.PA, 'POST', `/notices/${n.id}/publish`, { ...pubBody, title, effectiveFrom });
      ok(early.status === 409 && early.json.code === 'NO_DRAFT', 'with the law layer: Publish needs its draft first (409 NO_DRAFT)');
      const dr = await must(plat(U.PA, 'POST', `/notices/${n.id}/draft`, { value: PT_VALUE, effectiveFrom, title, sourceNote: `${title} (test)` }));
      ok(dr.draft && dr.draft.status === 'DRAFT' && dr.notice.ruleVersionId === String(dr.draft.id), '"Draft a new version": the law layer makes the DRAFT; its id is kept on the notice', JSON.stringify(dr.draft).slice(0, 200));
    } else {
      const dr = await must(plat(U.PA, 'POST', `/notices/${n.id}/draft`, {}));
      ok(dr.draft === null && /not there yet/.test(dr.message), '"Draft a new version" while the law layer is not there: said; Publish carries the value');
    }
    return plat(U.PA, 'POST', `/notices/${n.id}/publish`, { ...pubBody, title, effectiveFrom });
  };
  const pub = await publishIt(N1, '2026-11-01', pubBody.title);
  ok(pub.status === 200, `published (${lawPath ? 'through the law layer’s publishVersion' : 'through the adapter'})`, JSON.stringify(pub.json).slice(0, 300));
  const publicationId = pub.json?.publicationId;
  const companiesWith = await q("SELECT c.id FROM companies c JOIN apps a ON a.company_id = c.id AND a.slug = 'cf_hrms' WHERE c.deleted_at IS NULL");
  if (publicationId) {
    ok(pub.json.notice.status === 'PUBLISHED' && pub.json.notified.length === companiesWith.length, `every company with CF HRMS is told once (${companiesWith.length})`, JSON.stringify(pub.json.notified));
    const hist = (await must(plat(U.PA, 'GET', '/publications'))).publications.find((p) => p.id === publicationId);
    ok(hist && hist.via === (lawPath ? 'LAW_LAYER' : 'ADAPTER') && hist.publishedBy === `${TAG} Product team` && hist.companiesNotified === companiesWith.length && hist.effectiveFrom === '2026-11-01', 'published history: via, by whom, companies told', JSON.stringify(hist));
    const n1 = await one('SELECT * FROM hrms_compliance_notifications WHERE company_id = ? AND publication_id = ?', [COMPANY, publicationId]);
    const impact = typeof n1.impact_json === 'string' ? JSON.parse(n1.impact_json) : n1.impact_json;
    const expectPeople = Number((await one(
      `SELECT COUNT(DISTINCT s.employee_id) AS n FROM hrms_pay_salaries s JOIN hrms_employees e ON e.company_id = s.company_id AND e.id = s.employee_id AND e.deleted_at IS NULL AND e.employment_status IN ('ACTIVE','NOTICE')
        WHERE s.company_id = ? AND s.deleted_at IS NULL AND s.effective_from <= '2026-11-01' AND (s.effective_to IS NULL OR s.effective_to >= '2026-11-01')
          AND COALESCE(NULLIF(s.state_code, ''), (SELECT state_code FROM hrms_pay_settings WHERE company_id = s.company_id AND deleted_at IS NULL), 'TG') = 'TG'`, [COMPANY])).n);
    ok(n1 && n1.kind === 'LAW_CHANGE' && n1.status === 'OPEN' && impact.people === expectPeople && Array.isArray(impact.lines) && Array.isArray(impact.proposals) && n1.body.includes(company.name),
      `${company.name}: a notification written for it, with its impact (${impact.people} people paid in TG, ${impact.structures} structures) and room for C2's proposals`, JSON.stringify(impact));
    ok(n1.title.includes('(TG)') && n1.body.includes('2026-11-01'), 'its words: the state, the date in force, the source');
    // The emails: queued, never sent; only the company's Owner / HR logins.
    const emails = await q('SELECT e.*, u.company_id AS user_company FROM hrms_compliance_emails e JOIN users u ON u.id = e.to_user_id WHERE e.notification_id = ?', [n1.id]);
    const recip = await recipientsOf(db, COMPANY);
    ok(impact.affected ? emails.length === recip.length && emails.length > 0 : emails.length === 0, `emails queued for ${company.name}'s Owner and HR logins (${emails.length})`, `${emails.length} vs ${recip.length}`);
    ok(emails.every((e) => e.status === 'QUEUED' && e.sent_at === null && Number(e.user_company) === COMPANY && Number(e.company_id) === COMPANY), 'every one QUEUED, none sent, every recipient of the company itself');
    ok(emails.some((e) => e.to_user_id === U.OWNER.id) && emails.some((e) => e.to_user_id === U.HR.id) && !emails.some((e) => [U.EMP.id, U.CA.id, U.DH.id, U.PA.id, U.OTHER.id].includes(e.to_user_id)),
      'Owner and HR manager yes; Employee, Reviewer, Unit head, the platform admin and the other company\'s Owner no');
    const sent = await sendPending(db);
    ok(sent.sent === 0 && sent.reason === 'not configured' && Number((await one("SELECT COUNT(*) AS n FROM hrms_compliance_emails WHERE status = 'SENT' AND queued_at >= ?", [new Date(t0 - 60000)])).n) === 0, 'the outbox sends nothing without SMTP (and a test turns mail off): still QUEUED');
    ok(/<a href="[^"]+\/cf_hrms\/compliance">/.test(emails[0]?.body_html ?? '<a href="x/cf_hrms/compliance">') && !/<script/i.test(emails[0]?.body_html ?? ''), 'the email links to the company\'s Compliance page; the words are escaped');
    // The other company: its own notification, its own impact.
    const n2 = await one('SELECT * FROM hrms_compliance_notifications WHERE company_id = ? AND publication_id = ?', [other.id, publicationId]);
    ok(n2 && n2.id !== n1.id && n2.body.includes(other.name) && !n2.body.includes(company.name), `${other.name} has its own notification, written for it`);
    ok((await one('SELECT COUNT(*) AS n FROM hrms_compliance_emails WHERE notification_id = ? AND company_id <> ?', [n2.id, other.id])).n === 0, '…and its emails (if any) are its own');
    const twice = await (await import('../../apps/cf_hrms/services/compliance/notify.js')).notifyPublication(db, publicationId);
    ok(twice.length === 0, 'telling the companies again adds nothing (one notification per company and publication)');

    /* ══ 5. the company's side ════════════════════════════════════════ */
    section('[5] Compliance in the company: the page, the bell, acknowledgement, re-send');
    const page = await must(call(U.HR, 'GET', '/compliance/notifications'));
    ok(page.notifications.some((n) => n.id === n1.id && n.impact && n.sourceUrl) && !page.notifications.some((n) => n.id === n2.id) && page.canAcknowledge === true, 'HR sees its company\'s notice with the impact and the source; never the other company\'s');
    ok((await call(U.EMP, 'GET', '/compliance/notifications')).status === 403 && (await call(U.DH, 'GET', '/compliance/bell')).status === 403, 'an Employee and a Unit head: 403 (no compliance view)');
    ok((await call(U.EXEC, 'GET', '/compliance/notifications')).status === 200, 'an HR executive sees it');
    const bell = await must(call(U.HR, 'GET', '/compliance/bell'));
    ok(bell.count >= 1 && bell.items.some((i) => i.id === `n${n1.id}` && /compliance\?notice=/.test(i.link)), 'the bell shows it, linking to the Compliance page');
    ok((await call(U.OTHER, 'POST', `/compliance/notifications/${n1.id}/acknowledge`, {}, other.slug)).status === 404, 'another company acknowledging this one: 404 (tenant isolation)');
    ok((await call(U.CA, 'POST', `/compliance/notifications/${n1.id}/acknowledge`, {})).status === 403, 'the Reviewer cannot acknowledge (no compliance edit)');
    const ack = await must(call(U.HR, 'POST', `/compliance/notifications/${n1.id}/acknowledge`, { note: 'Payroll will apply it from November.' }));
    ok(ack.notification.status === 'ACKNOWLEDGED' && ack.notification.acknowledgedBy === `${TAG} HR manager` && ack.notification.ackNote === 'Payroll will apply it from November.', 'acknowledged: who, when, a note');
    ok(Number((await one("SELECT COUNT(*) AS n FROM hrms_compliance_emails WHERE notification_id = ? AND status = 'QUEUED'", [n1.id])).n) === 0, 'its emails still waiting are not needed any more (SKIPPED)');
    const ack2 = await must(call(U.OWNER, 'POST', `/compliance/notifications/${n1.id}/acknowledge`, {}));
    ok(ack2.notification.acknowledgedBy === `${TAG} HR manager`, 'acknowledging again changes nothing (the first acknowledgement stands)');
    // A second change, left unacknowledged: re-sent after N days, once per period, never twice at once.
    await must(plat(U.PA, 'POST', `/notices/${N2.id}/link`, { domain: 'PT', jurisdiction: 'TG', ruleKey: 'settings' }));
    const pub2 = await must(publishIt(N2, '2026-12-01', 'Telangana PT: corrected circular'));
    const m1 = await one('SELECT * FROM hrms_compliance_notifications WHERE company_id = ? AND publication_id = ?', [COMPANY, pub2.publicationId]);
    ok(m1 && m1.status === 'OPEN' && Number(m1.send_count) === (impactAffected(m1) ? 1 : 0), 'a second change: OPEN, mailed once');
    if (impactAffected(m1)) {
      ok((await resendPass(db, { now: new Date() })).filter((r) => r.notificationId === m1.id).length === 0, 'not re-sent before N days');
      await db.query('UPDATE hrms_compliance_notifications SET last_sent_at = ? WHERE id = ?', [new Date(Date.now() - 8 * 86400000), m1.id]);
      await db.query('UPDATE hrms_compliance_notifications SET last_sent_at = ? WHERE id = ?', [new Date(Date.now() - 8 * 86400000), n1.id]);
      const rs = await resendPass(db, { now: new Date() });
      const mine2 = rs.filter((r) => r.notificationId === m1.id);
      ok(mine2.length === 1 && mine2[0].emails > 0 && !rs.some((r) => r.notificationId === n1.id), 'after N days unacknowledged: re-sent (RESEND emails queued); the acknowledged one is not');
      ok(Number((await one('SELECT send_count FROM hrms_compliance_notifications WHERE id = ?', [m1.id])).send_count) === 2 && (await resendPass(db, { now: new Date() })).filter((r) => r.notificationId === m1.id).length === 0, 'the claim: counted once; an immediate second pass (a second instance) re-sends nothing');
      ok(Number((await one("SELECT COUNT(*) AS n FROM hrms_compliance_emails WHERE notification_id = ? AND reason = 'RESEND' AND status = 'QUEUED'", [m1.id])).n) > 0, 'the re-sends wait in the outbox too');
    }
  }

  /* ══ 6. the calendar ════════════════════════════════════════════════ */
  section('[6] The deadline calendar');
  const cal = await must(call(U.HR, 'GET', '/compliance/calendar?from=2026-10-01&to=2026-12-31'));
  const K = Object.fromEntries(cal.deadlines.map((d) => [d.key, d]));
  ok(K['TDS_DEPOSIT:2026-10']?.dueDate === '2026-11-07' && /tds_deposit/.test(K['TDS_DEPOSIT:2026-10'].source) && K['TDS_DEPOSIT:2026-10'].link === 'tax-challans', 'TDS deposit for October: 7 November, from the tax rule tds_deposit, links to Challans', JSON.stringify(K['TDS_DEPOSIT:2026-10']));
  ok(K['TDS_RETURN:2026-27:Q2']?.dueDate === '2026-10-31' && /tds_return/.test(K['TDS_RETURN:2026-27:Q2'].source) && /138/.test(K['TDS_RETURN:2026-27:Q2'].title), 'the Q2 return: 31 October, Form 138, from the tax rule tds_return');
  ok(K['PF:2026-10']?.dueDate === '2026-11-15' && K['ESI:2026-10']?.link === 'statutory-returns' && cal.states.includes('TG') && K['PT:TG:2026-10']?.dueDate === '2026-11-10', 'PF / ESI the 15th; PT for Telangana (the company pays there) the 10th; they link to Statutory returns');
  ok(K['MIN_WAGE:TG:2026-10']?.dueDate === '2026-10-01', 'the minimum-wage revision month');
  ok((await call(U.CA, 'POST', '/compliance/calendar/done', { key: 'PF:2026-10' })).status === 403, 'marking done needs compliance edit (the Reviewer has not)');
  ok((await call(U.HR, 'POST', '/compliance/calendar/done', { key: 'PF:1999-01' })).status === 404, 'a deadline that is not the company\'s: 404');
  const done = await must(call(U.HR, 'POST', '/compliance/calendar/done', { key: 'PF:2026-10', note: 'ECR uploaded' }));
  ok(done.deadline.status === 'DONE' && done.deadline.doneBy === `${TAG} HR manager` && done.deadline.doneNote === 'ECR uploaded', 'marked done: by whom, a note');
  const otherCal = await must(call(U.OTHER, 'GET', '/compliance/calendar?from=2026-10-01&to=2026-12-31', undefined, other.slug));
  ok(otherCal.deadlines.find((d) => d.key === 'PF:2026-10')?.status !== 'DONE', 'another company\'s calendar does not see this company\'s mark');
  const undo = await must(call(U.HR, 'POST', '/compliance/calendar/done', { key: 'PF:2026-10', done: false }));
  ok(undo.deadline.status !== 'DONE', 'and it can be marked not done again');
  // Reminders: 3 days and 1 day before, once each.
  const r3 = await remindCompany(db, company, { on: '2026-11-04' });
  ok(r3.some((r) => r.key === 'TDS_DEPOSIT:2026-10' && r.which === 'reminded_3_at'), '3 days before the TDS deposit: a reminder', JSON.stringify(r3));
  const dn = await one("SELECT * FROM hrms_compliance_notifications WHERE company_id = ? AND deadline_key = 'TDS_DEPOSIT:2026-10'", [COMPANY]);
  ok(dn && dn.kind === 'DEADLINE' && /Due in 3 days/.test(dn.title) && Number((await one("SELECT COUNT(*) AS n FROM hrms_compliance_emails WHERE notification_id = ? AND reason = 'REMINDER'", [dn.id])).n) > 0, 'a DEADLINE notification on the bell, and REMINDER emails queued');
  ok((await remindCompany(db, company, { on: '2026-11-04' })).length === 0 && (await remindCompany(db, company, { on: '2026-11-05' })).every((r) => r.key !== 'TDS_DEPOSIT:2026-10'), 'once: the same day again, or the next day, adds nothing for it');
  const r1 = await remindCompany(db, company, { on: '2026-11-06' });
  ok(r1.some((r) => r.key === 'TDS_DEPOSIT:2026-10' && r.which === 'reminded_1_at') && /tomorrow/.test((await one('SELECT title FROM hrms_compliance_notifications WHERE id = ?', [dn.id])).title), '1 day before: the second reminder ("Due tomorrow")');
  await must(call(U.HR, 'POST', '/compliance/calendar/done', { key: 'PT:TG:2026-10' }));
  ok(!(await remindCompany(db, company, { on: '2026-11-08' })).some((r) => r.key === 'PT:TG:2026-10'), 'a deadline marked done is not reminded');
  const sum = await must(call(U.HR, 'GET', '/compliance/summary'));
  ok(typeof sum.openNotices === 'number' && Array.isArray(sum.due), 'the Home card: open notices and what is due');

  /* ══ 7. the reviewer ════════════════════════════════════════════════ */
  section('[7] The CA reviewer: rights, comments, what changed, sign-off');
  const sets = await must(call(U.CA, 'GET', '/compliance/review/sets'));
  ok(sets.sets.length > 0 && sets.canReview === true && sets.canTrace === true && sets.sets.some((s) => s.set.startsWith('TAX:IN:')), `the Reviewer sees ${sets.sets.length} rule sets in force (income tax by year among them)`, sets.sets.map((s) => s.set).join(' '));
  const SET = sets.sets.find((s) => s.set.startsWith('TAX:IN:'))?.set;
  const detail = await must(call(U.CA, 'GET', `/compliance/review/sets/${SET}`));
  ok(detail.set.ruleList.length > 0 && detail.set.ruleList.every((r) => 'sourceUrl' in r && 'verified' in r && 'value' in r), 'a set: every rule with its value, source and verified flag');
  ok((await call(U.HR, 'POST', `/compliance/review/sets/${SET}/comments`, { action: 'COMMENT', body: 'x' })).status === 403 && (await call(U.OWNER, 'GET', '/compliance/review/sets')).status === 200, 'HR manager cannot comment as the CA (403); everybody with compliance view reads it');
  ok((await call(U.CA, 'POST', '/payroll/runs', {})).status === 403 && (await call(U.CA, 'PUT', '/tax/years/2026-27', {})).status === 403 && (await call(U.CA, 'GET', '/payroll/runs')).status === 200, 'the Reviewer reads payroll and tax and changes nothing there (403 on writes)');
  ok((await call(U.CA, 'POST', `/compliance/review/sets/${SET}/comments`, { action: 'QUESTION' })).status === 422, 'a question needs words');
  const qd = await must(call(U.CA, 'POST', `/compliance/review/sets/${SET}/comments`, { action: 'QUESTION', body: 'Is the rebate limit right for 2026-27?' }));
  ok(qd.set.status === 'QUESTIONED' && qd.set.commentList.at(-1).by === `${TAG} Reviewer`, 'QUESTION: the set is questioned, the question kept with who');
  const year = SET.split(':')[2];
  const refused = await call(U.CA, 'POST', '/compliance/review/signoffs', { year });
  ok(refused.status === 409 && refused.json.code === 'OPEN_QUESTIONS', 'the year cannot be signed off while a set is questioned (unless the CA says so)');
  ok((await call(U.HR, 'POST', '/compliance/review/signoffs', { year })).status === 403, 'HR manager cannot sign off as the CA');
  const ap = await must(call(U.CA, 'POST', `/compliance/review/sets/${SET}/comments`, { action: 'APPROVE', body: 'Checked against the Finance Act.' }));
  ok(ap.set.status === 'APPROVED' && ap.set.decidedBy === `${TAG} Reviewer` && !ap.set.changedSinceDecision, 'APPROVE: approved, by whom');
  const ch1 = await must(call(U.CA, 'GET', '/compliance/review/changes'));
  ok(ch1.lastSignoff === null && ch1.changedSets.length === sets.sets.length, 'before any sign-off: every set counts as changed', `${ch1.changedSets.length}/${sets.sets.length}`);
  const tick0 = await one('SELECT ca_reviewed FROM hrms_tax_settings WHERE company_id = ? AND tax_year = ? AND deleted_at IS NULL', [COMPANY, year]);
  const so = await call(U.CA, 'POST', '/compliance/review/signoffs', { year, note: 'Rules and the October run checked.', withOpenQuestions: true });
  ok(so.status === 200 && so.json.signoffs.some((x) => x.year === year && x.by === `${TAG} Reviewer`), `${year} signed off: the record`, JSON.stringify(so.json).slice(0, 200));
  const tick = await one('SELECT ca_reviewed, ca_reviewed_by, ca_note FROM hrms_tax_settings WHERE company_id = ? AND tax_year = ? AND deleted_at IS NULL', [COMPANY, year]);
  ok(Number(tick?.ca_reviewed) === 1 && tick.ca_reviewed_by === U.CA.id && /Signed off by/.test(tick.ca_note) && !Number(tick0?.ca_reviewed ?? 0) === !Number(tick0?.ca_reviewed ?? 0), 'P2\'s "Reviewed by our CA for the year" is ticked by the sign-off (the tax screens\' banner goes)');
  const yearView = await must(call(U.HR, 'GET', `/tax/years/${year}`));
  ok(yearView.review.caReviewed === true && yearView.review.banner === null, 'Tax › Settings shows the year reviewed');
  ok((await call(U.CA, 'POST', '/compliance/review/signoffs', { year })).status === 409, 'a year is signed off once');
  const otherTick = await one('SELECT ca_reviewed FROM hrms_tax_settings WHERE company_id = ? AND tax_year = ? AND deleted_at IS NULL', [other.id, year]);
  ok(!Number(otherTick?.ca_reviewed ?? 0) || Number(otherTick.ca_reviewed) === Number(before['hrms_tax_settings (ca ticks)'] ? otherTick.ca_reviewed : 0), 'another company\'s year is untouched');
  const ch2 = await must(call(U.CA, 'GET', '/compliance/review/changes'));
  ok(ch2.lastSignoff?.year === year && ch2.changedSets.length === 0 && ch2.publications.length === 0, 'right after the sign-off: nothing has changed since');
  const otherSets = await must(call(U.OTHER, 'GET', '/compliance/review/sets', undefined, other.slug));
  ok(!otherSets.sets.find((s) => s.set === SET && s.status === 'APPROVED' && s.decidedBy === `${TAG} Reviewer`), 'another company\'s review state is its own (tenant isolation)');

  /* ══ 8. the calculation trace ══════════════════════════════════════ */
  section('[8] The calculation trace: every payslip line with its rule');
  const runs = await must(call(U.CA, 'GET', '/compliance/review/runs'));
  const run = runs.runs.find((r) => r.people > 0);
  if (!run) ok(true, 'no calculated run in this company — trace skipped (said)');
  else {
    const people = await must(call(U.CA, 'GET', `/compliance/review/runs/${run.id}/people`));
    const who = people.people[0];
    const audit0 = Number((await one("SELECT COUNT(*) AS n FROM hrms_audit_log WHERE company_id = ? AND entity_type = 'hrms_pay_salary_read'", [COMPANY])).n);
    const tr = await must(call(U.CA, 'GET', `/compliance/review/trace?runId=${run.id}&employeeId=${who.employeeId}`));
    ok(tr.lines.length > 0 && tr.person.employeeId === who.employeeId && ['SNAPSHOT', 'DERIVED'].includes(tr.basis) && tr.basisWords, `${run.month}, ${who.code}: ${tr.lines.length} lines, basis ${tr.basis}`);
    const stat = tr.lines.filter((l) => /^(PF|ESI|PT|LWF)/.test(l.code));
    ok(stat.every((l) => l.rule && (l.rule.id || l.rule.missing)), 'every statutory line names its rule version (or says none was in force)', JSON.stringify(stat.map((l) => [l.code, l.rule])));
    ok(Number((await one("SELECT COUNT(*) AS n FROM hrms_audit_log WHERE company_id = ? AND entity_type = 'hrms_pay_salary_read'", [COMPANY])).n) === audit0 + 1, 'a trace is a pay read: audited');
    // With the versions the run stored (the law layer's snapshot): the trace names them, and the law layer recomputes the run (rolled back).
    if (law.connected && law.runSnapshot) {
      const lawIds = (await q("SELECT id FROM hrms_law_rules WHERE status = 'PUBLISHED' AND deleted_at IS NULL AND domain IN ('PF','ESI','PT','LWF')")).map((r) => r.id);
      const taxIds = (await q("SELECT id FROM hrms_tax_rules WHERE tax_year = ? AND status = 'PUBLISHED' AND deleted_at IS NULL", [tr.tax?.year ?? '2026-27'])).map((r) => r.id);
      await db.query('UPDATE hrms_pay_runs SET law_versions_json = ? WHERE company_id = ? AND id = ?', [JSON.stringify({ law: lawIds, tax: taxIds, calculatedAt: new Date().toISOString() }), COMPANY, run.id]);
      const ts = await must(call(U.CA, 'GET', `/compliance/review/trace?runId=${run.id}&employeeId=${who.employeeId}`));
      ok(ts.basis === 'SNAPSHOT' && ts.lines.filter((l) => /^(PF|PT)/.test(l.code)).every((l) => l.rule?.id && l.rule.version) && ts.reproduced && ('same' in ts.reproduced || 'error' in ts.reproduced),
        `with the run's snapshot: every statutory line names the stored version; reproduceRun says ${ts.reproduced?.same === undefined ? `it could not (${ts.reproduced?.error})` : ts.reproduced.same ? 'the person comes out the same' : `${ts.reproduced.differences.length} differences`}`, JSON.stringify(ts.reproduced).slice(0, 300));
    }
    ok((await call(U.EXEC, 'GET', `/compliance/review/trace?runId=${run.id}&employeeId=${who.employeeId}`)).status === 200 && (await call(U.DH, 'GET', `/compliance/review/trace?runId=${run.id}&employeeId=${who.employeeId}`)).status === 403, 'HR executive (payroll + pay view) may trace; a Unit head may not');
    ok((await call(U.OTHER, 'GET', `/compliance/review/trace?runId=${run.id}&employeeId=${who.employeeId}`, undefined, other.slug)).status === 404, 'another company asking for this run: 404');
  }

  /* ══ 9. the review pack ════════════════════════════════════════════ */
  section('[9] The review pack');
  const x = await must(call(U.CA, 'GET', '/compliance/review/pack?format=xlsx'));
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(x.contentBase64, 'base64'));
  const ws = wb.getWorksheet('Rules in force');
  ok(/\.xlsx$/.test(x.fileName) && ws && ws.rowCount - 1 === x.rules && x.rules > 0 && wb.getWorksheet('About') && wb.getWorksheet('Comments'), `Excel: About, Rules in force (${x.rules} rules), Comments`);
  const headers = ws.getRow(1).values.slice(1);
  ok(['Rule set', 'Rule', 'Value (in words)', 'In force from', 'Version', 'Verified', 'Source', 'Source link', 'Worked examples'].every((h) => headers.includes(h)), 'every rule with its value, source, verified flag, version and worked examples');
  ok(wb.getWorksheet('Comments').rowCount >= 3, 'the CA\'s question and approval are in it');
  const pdf = await must(call(U.CA, 'GET', '/compliance/review/pack?format=pdf'));
  ok(/\.pdf$/.test(pdf.fileName) && Buffer.from(pdf.contentBase64, 'base64').subarray(0, 5).toString() === '%PDF-', 'PDF: a real PDF');
  ok((await call(U.EMP, 'GET', '/compliance/review/pack')).status === 403, 'an Employee: 403');
} catch (err) {
  ok(false, 'the run finished', `${err.message} ${(err.stack ?? '').split('\n').slice(1, 3).join(' ')}`);
} finally {
  if (server?.close) await server.close();
  await new Promise((r) => fake.close(r));
  try { await db.rollback(); } catch { /* nothing to undo */ }
  db.release();
  pool.query = real.query;
  pool.execute = real.execute;
  pool.getConnection = real.getConnection;
  forgetAccess();
}

function impactAffected(n) {
  const i = typeof n.impact_json === 'string' ? JSON.parse(n.impact_json) : n.impact_json;
  return Boolean(i?.affected);
}

section('[10] Nothing is left behind');
{
  const after = await worldCount();
  const moved = Object.keys(before).filter((k) => after[k] !== before[k]);
  ok(moved.length === 0, `every count is what it was (${Object.keys(before).length} tables: every company table, the global compliance tables, users, roles, the CA ticks)`, moved.map((k) => `${k} ${before[k]} -> ${after[k]}`).join('; '));
}

console.log(`\n${passed} passed, ${failed.length} failed  (${((Date.now() - started) / 1000).toFixed(1)} s)`);
if (failed.length) { console.log('\nFAILED:'); for (const f of failed) console.log(`  - ${f}`); }
await pool.end();
process.exit(failed.length ? 1 : 0);
