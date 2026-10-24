/**
 * sources.js — the official pages the compliance watcher reads (spec §36.4), and the seed.
 *
 * KINDS ARE HONEST. Each seeded page was read on 2026-10-24 with the watcher's own rules (its user
 * agent, robots.txt, no redirect off the site) and its kind says what is really on it:
 *   pdf_index  a page that lists notices as links to PDFs (the e-filing portal's latest news, EPFO and
 *              ESIC circulars, the Telangana labour department's home page)
 *   html_list  a page of links (and, with watch_text, a page whose TEXT is watched — the Telangana
 *              minimum-wage rates are a table, the PT G.O. page lists nothing as links)
 *   rss        a feed (PIB's releases)
 * Some are known not to work for an automated reader today, and stay in the registry so the console
 * shows it rather than hides it: incometaxindia.gov.in is built by script (its lists are not in the page); the Protean TDS
 * page and the e-Gazette search are built by script / form posts, so the watcher finds no links.
 * Each such note is on the source; the error the watcher meets is shown on the console.
 */
import { invalid, notFound } from '../../lib/errors.js';
import { refuseUrl } from './fetcher.js';

export const KINDS = ['html_list', 'rss', 'pdf_index'];
export const DOMAINS = ['TAX', 'PF', 'ESI', 'PT', 'LWF', 'MIN_WAGE', 'BONUS', 'GRATUITY', 'OVERTIME', 'LEAVE_MIN', 'WAGES', 'ALL'];

export const SEED_SOURCES = [
  { code: 'IT_EFILING_NEWS', name: 'Income Tax e-filing portal — latest news (CBDT notifications and circulars)', url: 'https://www.incometax.gov.in/iec/foportal/latest-news', kind: 'pdf_index', frequency_hours: 12, domains: ['TAX'], jurisdictions: ['IN'], link_pattern: 'notification|circular', note: 'The portal links each new CBDT notification and circular as a PDF; only those links are kept.' },
  { code: 'CBDT_CIRCULARS', name: 'CBDT circulars (incometaxindia.gov.in)', url: 'https://www.incometaxindia.gov.in/Pages/communications/circulars.aspx', kind: 'html_list', frequency_hours: 24, domains: ['TAX'], jurisdictions: ['IN'], link_pattern: 'circular', note: 'The site is built by script: a plain read (2026-10-24) gets its menus, not the list of circulars (and curl was refused with 403). Kept to show that; the e-filing portal source carries the circulars.' },
  { code: 'CBDT_NOTIFICATIONS', name: 'CBDT notifications (incometaxindia.gov.in)', url: 'https://www.incometaxindia.gov.in/Pages/communications/notifications.aspx', kind: 'html_list', frequency_hours: 24, domains: ['TAX'], jurisdictions: ['IN'], link_pattern: 'notification', note: 'The site is built by script: a plain read (2026-10-24) gets its menus, not the list of notifications (and curl was refused with 403). Kept to show that; the e-filing portal source carries the notifications.' },
  { code: 'EPFO_CIRCULARS', name: 'EPFO circulars', url: 'https://www.epfo.gov.in/circulars/', kind: 'pdf_index', frequency_hours: 24, domains: ['PF'], jurisdictions: ['IN'], also_sites: 'epfindia.gov.in', note: 'A long page (about 2 MB, every circular as a PDF). epfindia.gov.in redirects here — a different site, so the source uses this address; the PDFs themselves are on epfindia.gov.in (also_sites).' },
  { code: 'ESIC_CIRCULARS', name: 'ESIC circulars', url: 'https://esic.gov.in/circulars', kind: 'pdf_index', frequency_hours: 24, domains: ['ESI'], jurisdictions: ['IN'], note: 'The first page of circulars (newest first). Many are internal office orders; a reviewer dismisses those.' },
  { code: 'TG_MIN_WAGES', name: 'Telangana Labour Department — minimum rates of wages', url: 'https://labour.telangana.gov.in/MinRatesWages.do', kind: 'html_list', frequency_hours: 24, domains: ['MIN_WAGE'], jurisdictions: ['TG'], watch_text: true, link_pattern: 'draft|notification|[.]pdf', note: 'The rates are one file per employment in a folder per revision date (01-04-2026, 01-10-2025 …). Rather than a notice per file, the page TEXT is watched (one CHANGED notice when a revision is listed), plus links to draft / preliminary notifications.' },
  { code: 'TG_LABOUR_HOME', name: 'Telangana Labour Department — notices and downloads', url: 'https://labour.telangana.gov.in/home.do', kind: 'pdf_index', frequency_hours: 24, domains: ['MIN_WAGE', 'LWF', 'LEAVE_MIN', 'WAGES'], jurisdictions: ['TG'], note: 'The home page links the department\'s rules, codes and G.O.s as PDFs.' },
  { code: 'TG_PT_GOS', name: 'Telangana Commercial Taxes — Profession Tax G.O.s and notifications', url: 'https://www.tgct.gov.in/tgportal/AllActs/APPT/Gos_Notifications.aspx', kind: 'html_list', frequency_hours: 24, domains: ['PT'], jurisdictions: ['TG'], watch_text: true, link_pattern: 'APPT|profession|[.]pdf', note: 'The G.O. list is not plain links; the page text is watched, plus the Profession Tax pages it links (Act, Rules, Schedule).' },
  { code: 'EGAZETTE', name: 'e-Gazette of India (landing page)', url: 'https://egazette.gov.in/', kind: 'html_list', frequency_hours: 24, domains: ['ALL'], jurisdictions: ['IN'], note: 'The gazette SEARCH is a form (posted back), which the watcher does not fill; only links on the landing page are seen, and most are form posts.' },
  { code: 'PROTEAN_TDS_NEWS', name: 'Protean (NSDL) e-TDS — what\'s new', url: 'https://tinpan.proteantech.in/services/etds-etcs/etds-whatsnew', kind: 'html_list', frequency_hours: 24, domains: ['TAX'], jurisdictions: ['IN'], note: 'The page is built by script in the browser (2026-10-24): the watcher finds no links and says so. The RPU / FVU versions are checked by hand meanwhile.' },
  { code: 'PIB_RELEASES', name: 'Press Information Bureau — releases (RSS)', url: 'https://www.pib.gov.in/RssMain.aspx?ModId=6&Lang=1&Regid=3', kind: 'rss', frequency_hours: 12, domains: ['ALL'], jurisdictions: ['IN'], link_pattern: 'labour|wage|epfo|esic|provident|employees|income.?tax|cbdt|gratuity|bonus', note: 'Every ministry\'s releases; only titles about labour, wages, PF, ESI and income tax are kept. The feed may answer in Hindi (the site chooses by session).' },
];

const json = (v, d = null) => { if (v == null) return d; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch { return d; } };
const stamp = (v) => (v ? (v instanceof Date ? v.toISOString() : String(v)) : null);

export function shapeSource(r) {
  return {
    id: r.id, code: r.code, name: r.name, url: r.url, kind: r.kind, frequencyHours: Number(r.frequency_hours),
    domains: json(r.domains_json, []), jurisdictions: json(r.jurisdictions_json, []), linkPattern: r.link_pattern ?? null, watchText: Boolean(r.watch_text), alsoSites: r.also_sites ?? null,
    note: r.note ?? null, active: Boolean(r.active), lastCheckedAt: stamp(r.last_checked_at), lastOkAt: stamp(r.last_ok_at), lastChangeAt: stamp(r.last_change_at),
    lastStatus: r.last_status, lastError: r.last_error ?? null, failCount: Number(r.fail_count), itemCount: Number(r.item_count), nextCheckAt: stamp(r.next_check_at),
  };
}

/** The seed: adds a source whose code is missing; never changes one that is there. */
export async function seedSources(db, { apply = false } = {}) {
  const [have] = await db.query('SELECT code FROM hrms_compliance_sources WHERE deleted_at IS NULL');
  const codes = new Set(have.map((r) => r.code));
  const add = SEED_SOURCES.filter((s) => !codes.has(s.code));
  if (apply) for (const s of add) await insertSource(db, s);
  return { added: add.map((s) => s.code), existing: SEED_SOURCES.length - add.length };
}

async function insertSource(db, s) {
  const [r] = await db.query(
    `INSERT INTO hrms_compliance_sources (code, name, url, kind, frequency_hours, domains_json, jurisdictions_json, link_pattern, watch_text, also_sites, note, active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [s.code, s.name, s.url, s.kind, s.frequency_hours ?? 24, JSON.stringify(s.domains ?? []), JSON.stringify(s.jurisdictions ?? ['IN']), s.link_pattern ?? null, s.watch_text ? 1 : 0, s.also_sites ?? null, s.note ?? null, s.active === false ? 0 : 1]);
  return r.insertId;
}

export async function listSources(db) {
  const [rows] = await db.query('SELECT * FROM hrms_compliance_sources WHERE deleted_at IS NULL ORDER BY active DESC, code');
  return rows.map(shapeSource);
}
export async function sourceRow(db, id) {
  const [[r]] = await db.query('SELECT * FROM hrms_compliance_sources WHERE id = ? AND deleted_at IS NULL', [id]);
  if (!r) throw notFound('That source');
  return r;
}

/** Checks a source's fields; returns the row to write. */
async function cleanSource(body, before = {}, { allowLocal = false } = {}) {
  const problems = [];
  const pick = (k, d) => (body[k] === undefined ? d : body[k]);
  const code = String(pick('code', before.code ?? '')).trim().toUpperCase();
  const name = String(pick('name', before.name ?? '')).trim();
  const url = String(pick('url', before.url ?? '')).trim();
  const kind = pick('kind', before.kind);
  const frequency = Number(pick('frequencyHours', before.frequency_hours ?? 24));
  const domains = pick('domains', json(before.domains_json, []));
  const jurisdictions = pick('jurisdictions', json(before.jurisdictions_json, ['IN']));
  const linkPattern = pick('linkPattern', before.link_pattern ?? null);
  const alsoSites = pick('alsoSites', before.also_sites ?? null);
  if (alsoSites && (String(alsoSites).length > 300 || String(alsoSites).split(/[\s,]+/).filter(Boolean).some((h) => !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(h)))) problems.push('Also on: site names like epfindia.gov.in, separated by commas.');
  if (!/^[A-Z0-9_]{2,40}$/.test(code)) problems.push('Code: 2 to 40 capital letters, digits or _.');
  if (!name || name.length > 200) problems.push('Name: up to 200 characters.');
  if (!url || url.length > 500) problems.push('Address: a web address up to 500 characters.');
  else { const why = await refuseUrl(url, { allowLocal }); if (why) problems.push(`Address: ${why}.`); }
  if (!KINDS.includes(kind)) problems.push(`Kind: one of ${KINDS.join(', ')}.`);
  if (!Number.isInteger(frequency) || frequency < 1 || frequency > 24 * 31) problems.push('How often: a whole number of hours, 1 to 744.');
  if (!Array.isArray(domains) || !domains.length || domains.some((d) => !DOMAINS.includes(d))) problems.push(`Feeds: one or more of ${DOMAINS.join(', ')}.`);
  if (!Array.isArray(jurisdictions) || !jurisdictions.length || jurisdictions.some((j) => !/^[A-Z]{2}$/.test(String(j)))) problems.push('Jurisdictions: IN, or two-letter state codes (TG, KA …).');
  if (linkPattern) { try { new RegExp(linkPattern, 'i'); } catch { problems.push('Only links matching: not a valid pattern.'); } }
  if (problems.length) throw invalid('INVALID', 'The source cannot be saved yet.', { problems });
  return {
    code, name, url, kind, frequency_hours: frequency, domains, jurisdictions, link_pattern: linkPattern || null,
    watch_text: pick('watchText', Boolean(before.watch_text)), also_sites: alsoSites ? String(alsoSites).trim() : null, note: pick('note', before.note ?? null), active: pick('active', before.active === undefined ? true : Boolean(before.active)),
  };
}

export async function createSource(db, body = {}, opts = {}) {
  const s = await cleanSource(body, {}, opts);
  const [[dup]] = await db.query('SELECT id FROM hrms_compliance_sources WHERE code = ? AND deleted_at IS NULL', [s.code]);
  if (dup) throw invalid('INVALID', 'The source cannot be saved yet.', { problems: [`Code ${s.code} is taken.`] });
  const id = await insertSource(db, s);
  return shapeSource(await sourceRow(db, id));
}

export async function updateSource(db, id, body = {}, opts = {}) {
  const before = await sourceRow(db, id);
  const s = await cleanSource(body, before, opts);
  await db.query(
    // next_check_at first: MySQL assigns left to right, so it compares with the OLD url and kind (a new address is checked at once).
    `UPDATE hrms_compliance_sources SET next_check_at = IF(? <> url OR ? <> kind, NULL, next_check_at), code = ?, name = ?, url = ?, kind = ?, frequency_hours = ?, domains_json = ?, jurisdictions_json = ?,
            link_pattern = ?, watch_text = ?, also_sites = ?, note = ?, active = ? WHERE id = ?`,
    [s.url, s.kind, s.code, s.name, s.url, s.kind, s.frequency_hours, JSON.stringify(s.domains), JSON.stringify(s.jurisdictions), s.link_pattern, s.watch_text ? 1 : 0, s.also_sites, s.note, s.active ? 1 : 0, id]);
  return shapeSource(await sourceRow(db, id));
}

export default { SEED_SOURCES, KINDS, DOMAINS, seedSources, listSources, sourceRow, createSource, updateSource, shapeSource };
