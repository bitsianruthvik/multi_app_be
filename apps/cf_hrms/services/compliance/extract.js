/**
 * extract.js — the items on a source's page (spec §36.4). Pure: text in, items out.
 *
 *   html_list   every <a href> with its text, on the source's own site
 *   pdf_index   the same, only links to a .pdf
 *   rss         <item> (RSS 2.0) or <entry> (Atom): title, link, date
 *   watchText   (any kind, when the source says so) one more item: the page's visible text, so a page
 *               that shows a table of rates and no links still says when it changed
 *
 * An item is { url, title, date, itemHash, contentHash }:
 *   itemHash     sha256 of the normalised URL — the same notice stays the same item
 *   contentHash  sha256 of title + date — a new title or date on the same link is a CHANGED item
 * Normalising drops the #fragment, ASP.NET session segments "/(S(…))/" and ;jsessionid, so a link is
 * not "new" on every visit.
 *
 * No AI here: title, link, date and the source. An AI summary of a notice could be added later in the
 * watcher, written to hrms_compliance_notices.summary — nothing else would change.
 */
import crypto from 'crypto';
import { sameSite } from './fetcher.js';

export const MAX_ITEMS = 500;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };
export function decode(s) {
  return String(s ?? '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
}
const clean = (s) => decode(String(s ?? '').replace(/<[^>]*>/g, ' ')).replace(/[​﻿]/g, '').replace(/\s+/g, ' ').trim();

export function normaliseUrl(raw, base) {
  let u;
  try { u = new URL(decode(raw).trim(), base); } catch { return null; }
  if (!['http:', 'https:'].includes(u.protocol)) return null;
  u.hash = '';
  u.pathname = u.pathname.replace(/\/\(S\([^)]*\)\)/gi, '').replace(/;jsessionid=[^/]*/gi, '');
  if ((u.protocol === 'https:' && u.port === '443') || (u.protocol === 'http:' && u.port === '80')) u.port = '';
  return u.href;
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const iso = (y, m, d) => {
  const Y = Number(y); const M = Number(m); const D = Number(d);
  if (!(Y >= 1990 && Y <= 2100 && M >= 1 && M <= 12 && D >= 1 && D <= 31)) return null;
  return `${Y}-${String(M).padStart(2, '0')}-${String(D).padStart(2, '0')}`;
};
/** A date in a title or a URL: 15-10-2026, 15.10.2026, 15/10/2026, 2026-10-15, 15 Oct 2026, Oct 15, 2026. */
export function findDate(text) {
  const s = String(text ?? '');
  let m = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(s); if (m) return iso(m[1], m[2], m[3]);
  m = /\b(\d{1,2})[./-](\d{1,2})[./-](\d{4})\b/.exec(s); if (m) return iso(m[3], m[2], m[1]);
  m = /\b(\d{1,2})(?:st|nd|rd|th)?[\s-]+([A-Za-z]{3})[a-z]*\.?,?[\s-]+(\d{4})\b/.exec(s); if (m && MONTHS[m[2].toLowerCase()]) return iso(m[3], MONTHS[m[2].toLowerCase()], m[1]);
  m = /\b([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})\b/.exec(s); if (m && MONTHS[m[1].toLowerCase()]) return iso(m[3], MONTHS[m[1].toLowerCase()], m[2]);
  return null;
}

/** A link's title when its text says nothing ("Download", "View", an icon): the file name, readable. */
function titleOf(text, url) {
  const t = clean(text);
  if (t && t.length > 3 && !/^(download|view|click here|here|more|read more|pdf|open|new)$/i.test(t)) return t.slice(0, 480);
  try {
    const last = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() ?? '');
    return (last.replace(/\.[a-z0-9]{2,4}$/i, '').replace(/[_+]+/g, ' ').replace(/\s+/g, ' ').trim() || url).slice(0, 480);
  } catch { return url.slice(0, 480); }
}

/** A link's path and query, for the source's pattern (never the host). */
const pathOf = (url) => { try { const u = new URL(url); return decodeURIComponent(u.pathname + u.search); } catch { return url; } };

const item = (url, title, date) => ({ url, title, date, itemHash: sha(url), contentHash: sha(`${title}|${date ?? ''}`) });

/** The links of an HTML page (on the page's own site). */
export function htmlLinks(html, pageUrl, { pdfOnly = false, pattern = null, alsoSites = [], counted = null } = {}) {
  const host = new URL(pageUrl).hostname;
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  const out = new Map();
  const want = pattern ? new RegExp(pattern, 'i') : null;
  const onSite = (h) => sameSite(h, host) || alsoSites.some((s) => sameSite(h, s));
  for (const m of String(html).matchAll(re)) {
    const href = /\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(m[1]);
    const raw = href ? (href[2] ?? href[3] ?? href[4] ?? '') : '';
    if (!raw || /^\s*(javascript:|mailto:|tel:|#)/i.test(raw)) continue;
    const url = normaliseUrl(raw, pageUrl);
    if (!url || url === normaliseUrl(pageUrl, pageUrl)) continue;
    if (!onSite(new URL(url).hostname)) continue; // never off the source's site (or the sites it names)
    if (pdfOnly && !/\.pdf$/i.test(new URL(url).pathname)) continue;
    const title = titleOf(m[2], url);
    if (counted) counted.add(url);
    if (want && !want.test(pathOf(url)) && !want.test(title)) continue; // the path, not the host: "gov" is in every host
    if (out.has(url)) continue;
    out.set(url, item(url, title, findDate(`${title} ${decodeURIComponent(url)}`)));
    if (out.size >= MAX_ITEMS) break;
  }
  return [...out.values()];
}

/** RSS 2.0 items or Atom entries. */
export function feedItems(xml, feedUrl, { pattern = null, alsoSites = [], counted = null } = {}) {
  const host = new URL(feedUrl).hostname;
  const onSite = (h) => sameSite(h, host) || alsoSites.some((s) => sameSite(h, s));
  const want = pattern ? new RegExp(pattern, 'i') : null;
  const out = new Map();
  const blocks = [...String(xml).matchAll(/<item\b[\s\S]*?<\/item>/gi)].map((m) => m[0]);
  const atom = blocks.length ? [] : [...String(xml).matchAll(/<entry\b[\s\S]*?<\/entry>/gi)].map((m) => m[0]);
  const tag = (b, t) => { const m = new RegExp(`<${t}\\b[^>]*>([\\s\\S]*?)<\\/${t}>`, 'i').exec(b); return m ? clean(m[1]) : ''; };
  for (const b of [...blocks, ...atom]) {
    const link = blocks.length ? tag(b, 'link') || tag(b, 'guid') : (/<link\b[^>]*href\s*=\s*"([^"]+)"/i.exec(b)?.[1] ?? '');
    const url = normaliseUrl(link, feedUrl);
    if (!url || !onSite(new URL(url).hostname)) continue;
    const title = (tag(b, 'title') || url).slice(0, 480);
    if (counted) counted.add(url);
    if (want && !want.test(pathOf(url)) && !want.test(title)) continue; // the path, not the host: "gov" is in every host
    const when = tag(b, 'pubDate') || tag(b, 'updated') || tag(b, 'published') || tag(b, 'dc:date');
    const parsed = when && !Number.isNaN(Date.parse(when)) ? new Date(Date.parse(when)).toISOString().slice(0, 10) : findDate(when || title);
    if (!out.has(url)) out.set(url, item(url, title, parsed));
    if (out.size >= MAX_ITEMS) break;
  }
  return [...out.values()];
}

/** The visible text of a page (scripts, styles and tags out). */
export function visibleText(html) {
  return clean(String(html).replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' '));
}

/** The other sites a source's links may point to (also_sites: "a.gov.in, b.gov.in"). */
export const alsoSitesOf = (source) => String(source.also_sites ?? source.alsoSites ?? '').split(/[\s,]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);

/**
 * Every item of a source's page: { items, total } — total = the links of the right kind BEFORE the
 * source's pattern (a page whose links all fail the pattern has nothing new today, which is not an error).
 */
export function extractItems(source, body, pageUrl) {
  const pattern = source.link_pattern || source.linkPattern || null;
  const alsoSites = alsoSitesOf(source);
  const counted = new Set();
  let items;
  if (source.kind === 'rss') items = feedItems(body, pageUrl, { pattern, alsoSites, counted });
  else items = htmlLinks(body, pageUrl, { pdfOnly: source.kind === 'pdf_index', pattern, alsoSites, counted });
  if (source.watch_text || source.watchText) {
    const text = visibleText(body);
    if (text) {
      items.push({ url: `${pageUrl}#page-text`, title: `The page itself: ${String(source.name).slice(0, 200)}`, date: null, itemHash: sha(`${pageUrl}#page-text`), contentHash: sha(text) });
      counted.add('#page-text');
    }
  }
  return { items, total: counted.size };
}

export default { extractItems, htmlLinks, feedItems, visibleText, findDate, normaliseUrl, decode, alsoSitesOf, MAX_ITEMS };
