/**
 * fetcher.js — how the compliance watcher reads an official page (spec §36.4). Polite and bounded:
 *
 *   - http / https only; never a private, loopback or link-local address (a platform admin types the
 *     URL — this is not a door into our own network). A test passes { allowLocal: true }.
 *   - robots.txt honoured (User-agent * and ours): a Disallow that covers the path → BLOCKED, not fetched.
 *     A robots.txt that is not text/plain (some sites answer it with their home page) counts as none.
 *   - a timeout per request, a size cap (the body is read in chunks and abandoned past it), at most
 *     MAX_REDIRECTS redirects and only within the source's own site (www. ignored).
 *   - retries on a network error, a 5xx or a 429, with a pause; a 401 / 403 is BLOCKED at once.
 *   - one User-Agent that says who we are.
 *
 * Returns { ok, status, url, body, contentType } or { ok: false, blocked, status, error } — never throws.
 */
import dns from 'dns/promises';
import net from 'net';

export const USER_AGENT = 'CF-HRMS-compliance-watcher/1.0 (+reads public notices of official sites once or twice a day)';
export const LIMITS = { timeoutMs: 20000, maxBytes: 4 * 1024 * 1024, retries: 2, pauseMs: 1500, maxRedirects: 5 };

/** The site of a host: without "www.". Links and redirects must stay on it (or its sub-domains). */
export const siteOf = (host) => String(host || '').toLowerCase().replace(/^www\./, '');
export function sameSite(a, b) {
  const x = siteOf(a); const y = siteOf(b);
  return x === y || x.endsWith(`.${y}`) || y.endsWith(`.${x}`);
}

function privateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const s = ip.toLowerCase();
  return s === '::1' || s === '::' || s.startsWith('fc') || s.startsWith('fd') || s.startsWith('fe80') || s.startsWith('::ffff:127.') || s.startsWith('::ffff:10.') || s.startsWith('::ffff:192.168.');
}

/** Refuses a URL the watcher must not fetch; returns the reason or null. */
export async function refuseUrl(raw, { allowLocal = false } = {}) {
  let u;
  try { u = new URL(raw); } catch { return 'not a web address'; }
  if (!['http:', 'https:'].includes(u.protocol)) return 'only http and https addresses are read';
  if (u.username || u.password) return 'an address with a user name or password is not read';
  if (allowLocal) return null;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return 'a local address is not read';
  try {
    const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
    if (addrs.some((a) => privateAddress(a.address))) return 'the address points into a private network';
  } catch {
    return 'the site’s name does not resolve';
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One GET with a timeout and a size cap; follows nothing. */
async function getOnce(url, { timeoutMs, maxBytes, accept }) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { redirect: 'manual', signal: ctl.signal, headers: { 'User-Agent': USER_AGENT, Accept: accept ?? 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.5' } });
    const location = res.headers.get('location');
    const contentType = res.headers.get('content-type') ?? '';
    const declared = Number(res.headers.get('content-length'));
    if (declared && declared > maxBytes) { ctl.abort(); return { status: res.status, tooBig: true, contentType }; }
    let body = '';
    if (res.body && res.status < 300) {
      const reader = res.body.getReader();
      const chunks = []; let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > maxBytes) { try { await reader.cancel(); } catch { /* gone */ } return { status: res.status, tooBig: true, contentType }; }
        chunks.push(value);
      }
      body = new TextDecoder(/charset=iso-8859-1|latin1/i.test(contentType) ? 'latin1' : 'utf-8').decode(Buffer.concat(chunks.map((c) => Buffer.from(c))));
    } else if (res.body) {
      try { await res.body.cancel(); } catch { /* nothing to read */ }
    }
    return { status: res.status, location, contentType, body };
  } finally {
    clearTimeout(timer);
  }
}

/** GET with redirects (same site only) and retries. */
export async function politeGet(url, opts = {}) {
  const o = { ...LIMITS, ...opts };
  const start = new URL(url);
  let current = url;
  let lastError = null;
  for (let attempt = 0; attempt <= o.retries; attempt += 1) {
    if (attempt) await sleep(o.pauseMs * attempt);
    try {
      current = url;
      for (let hop = 0; hop <= o.maxRedirects; hop += 1) {
        const r = await getOnce(current, o);
        if (r.tooBig) return { ok: false, status: r.status, error: `the page is larger than ${Math.round(o.maxBytes / 1024 / 1024)} MB; not read` };
        if (r.status >= 300 && r.status < 400 && r.location) {
          const next = new URL(r.location, current);
          if (!sameSite(next.hostname, start.hostname) && !(o.alsoSites ?? []).some((s) => sameSite(next.hostname, s))) return { ok: false, status: r.status, error: `the page moved to another site (${next.hostname}); not followed — update the source’s address if that is right` };
          const why = await refuseUrl(next.href, o);
          if (why) return { ok: false, status: r.status, error: `redirect refused: ${why}` };
          current = next.href;
          continue;
        }
        if (r.status === 401 || r.status === 403) return { ok: false, blocked: true, status: r.status, error: `the site refused the watcher (HTTP ${r.status}); it may block automated reading` };
        if (r.status === 429 || r.status >= 500) { lastError = { ok: false, status: r.status, error: `the site answered HTTP ${r.status}` }; break; }
        if (r.status >= 400) return { ok: false, status: r.status, error: `the site answered HTTP ${r.status} — the page may have moved` };
        return { ok: true, status: r.status, url: current, body: r.body ?? '', contentType: r.contentType };
      }
      if (!lastError) return { ok: false, error: 'too many redirects' };
    } catch (e) {
      lastError = { ok: false, error: e.name === 'AbortError' ? `no answer within ${Math.round(o.timeoutMs / 1000)} s` : `could not reach the site (${String(e.cause?.code ?? e.message).slice(0, 80)})` };
    }
  }
  return lastError ?? { ok: false, error: 'could not read the page' };
}

/* ── robots.txt ───────────────────────────────────────────────────────── */

const robotsCache = new Map(); // origin -> { at, rules: [prefix] | null }
const ROBOTS_MS = 12 * 60 * 60 * 1000;
export function forgetRobots() { robotsCache.clear(); }

/** The Disallow prefixes for us (User-agent * or ours) in a robots.txt. Allow lines win over a shorter Disallow. */
export function parseRobots(text) {
  const groups = [];
  let cur = null; let lastWasAgent = false;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const k = m[1].toLowerCase(); const v = m[2].trim();
    if (k === 'user-agent') {
      if (!lastWasAgent) { cur = { agents: [], allow: [], disallow: [] }; groups.push(cur); }
      cur.agents.push(v.toLowerCase()); lastWasAgent = true; continue;
    }
    lastWasAgent = false;
    if (!cur) continue;
    if (k === 'disallow' && v) cur.disallow.push(v);
    if (k === 'allow' && v) cur.allow.push(v);
  }
  const ours = groups.filter((g) => g.agents.some((a) => a !== '*' && USER_AGENT.toLowerCase().includes(a)));
  const pick = ours.length ? ours : groups.filter((g) => g.agents.includes('*'));
  return { disallow: pick.flatMap((g) => g.disallow), allow: pick.flatMap((g) => g.allow) };
}
export function robotsAllows(rules, pathAndQuery) {
  if (!rules) return true;
  const match = (p) => { const re = new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$')}`); return re.test(pathAndQuery); };
  const d = rules.disallow.filter(match).sort((a, b) => b.length - a.length)[0];
  if (!d) return true;
  const a = rules.allow.filter(match).sort((x, y) => y.length - x.length)[0];
  return Boolean(a && a.length >= d.length);
}
async function robotsFor(origin, opts) {
  const hit = robotsCache.get(origin);
  if (hit && Date.now() - hit.at < ROBOTS_MS) return hit.rules;
  let rules = null;
  const r = await politeGet(`${origin}/robots.txt`, { ...opts, retries: 0, maxBytes: 256 * 1024, accept: 'text/plain' });
  if (r.ok && /text\/plain/i.test(r.contentType ?? '') && !/<html/i.test(r.body.slice(0, 500))) rules = parseRobots(r.body);
  robotsCache.set(origin, { at: Date.now(), rules });
  return rules;
}

/** Read a source's page the polite way. */
export async function fetchSource(url, opts = {}) {
  const why = await refuseUrl(url, opts);
  if (why) return { ok: false, error: `not read: ${why}` };
  const u = new URL(url);
  if (opts.robots !== false) {
    const rules = await robotsFor(u.origin, opts);
    if (!robotsAllows(rules, `${u.pathname}${u.search}`)) return { ok: false, blocked: true, error: 'the site’s robots.txt asks automated readers not to read this page; not read' };
  }
  return politeGet(url, opts);
}

export default { fetchSource, politeGet, refuseUrl, parseRobots, robotsAllows, sameSite, siteOf, USER_AGENT, LIMITS, forgetRobots };
