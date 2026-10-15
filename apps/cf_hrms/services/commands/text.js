/**
 * text.js — the small text tools the command reader is built from: words,
 * typo-tolerant comparison, dates. No model here; see reader.js for where the
 * built-in sentence model comes in.
 */

/** Lower case, "&" read as "and", punctuation dropped (a hyphen and a dot inside a code survive). */
export function norm(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[–—]/g, '-')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9.\- ]+/g, ' ')
    .replace(/(^|\s)[-.]+|[-.]+(?=\s|$)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export const words = (s) => norm(s).split(' ').filter(Boolean);

/** Words that say what KIND of thing is meant, not which one. Dropped before matching a name. */
const FILLER = new Set([
  'the', 'a', 'an', 'our', 'my', 'this', 'that', 'new', 'existing', 'current', 'of', 'and',
  'role', 'roles', 'position', 'positions', 'post', 'seat', 'chair', 'vacancy', 'opening',
  'department', 'dept', 'section', 'unit', 'team', 'machine',
  'shift', 'person', 'employee', 'staff', 'mr', 'mrs', 'ms', 'miss', 'shri', 'smt', 'called', 'named',
]);
export const keyWords = (s, keep = new Set()) => words(s).filter((w) => keep.has(w) || !FILLER.has(w));

/** Edit distance where a swap of two neighbouring letters is one typo; early exit above `max`. */
export function distance(a, b, max = 3) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev2 = null;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j += 1) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (prev2 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) cur[j] = Math.min(cur[j], prev2[j - 2] + 1);
      best = Math.min(best, cur[j]);
    }
    if (best > max) return max + 1;
    prev2 = prev;
    prev = cur;
  }
  return prev[b.length];
}

/** How many typos a word of this length may carry and still be the same word. */
export const typoBudget = (len) => (len >= 8 ? 2 : len >= 4 ? 1 : 0);

/** One query word against one record word: 1 same, 0.9 a clear abbreviation, 0.8 a typo, 0 not it. */
export function wordMatch(q, r) {
  if (q === r) return 1;
  if (q.length >= 3 && r.startsWith(q) && q.length >= Math.min(4, r.length - 1)) return 0.9;
  if (r.length >= 3 && q.startsWith(r) && r.length >= 4) return 0.85;
  const budget = typoBudget(Math.min(q.length, r.length));
  if (budget && distance(q, r, budget) <= budget) return 0.8;
  return 0;
}

/**
 * How well `query` names a record whose name is `label`: 0..1.
 * Every query word must find a record word (in any order); record words the
 * query did not name cost a little, so "quality" prefers "Quality" over
 * "Quality & Safety".
 */
export function nameScore(query, label) {
  const qn = norm(query);
  const ln = norm(label);
  if (!qn || !ln) return 0;
  if (qn === ln) return 1;
  const q = keyWords(query);
  const l = keyWords(label);
  if (!q.length || !l.length) return 0;
  const used = new Set();
  let total = 0;
  for (const w of q) {
    let best = 0;
    let at = -1;
    l.forEach((r, i) => {
      if (used.has(i)) return;
      const s = wordMatch(w, r);
      if (s > best) { best = s; at = i; }
    });
    if (at >= 0) used.add(at);
    total += best;
  }
  const coverage = total / q.length;
  if (coverage < 0.75) return coverage * 0.5;
  const unnamed = (l.length - used.size) / l.length;
  return Math.max(0, Math.min(0.99, coverage * (1 - 0.25 * unnamed)));
}

/* ── dates ─────────────────────────────────────────────────────────────── */

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const pad = (n) => String(n).padStart(2, '0');
export const isoOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/**
 * A date the way people write one: 2026-11-01, 1/11/2026 (day first), 1 Nov,
 * 1st November 2026, Nov 1, today, tomorrow, next Monday. -> 'YYYY-MM-DD' or null.
 */
export function readDateWords(text, now = new Date()) {
  const t = String(text ?? '').toLowerCase().trim();
  let m = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(t);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /\b(\d{1,2})[/.](\d{1,2})[/.](\d{2,4})\b/.exec(t);
  if (m) {
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return `${y}-${pad(m[2])}-${pad(m[1])}`;
  }
  if (/\btoday\b/.test(t)) return isoOf(now);
  if (/\btomorrow\b/.test(t)) { const d = new Date(now); d.setDate(d.getDate() + 1); return isoOf(d); }
  const day = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'].findIndex((x) => t.includes(`next ${x}`));
  if (day >= 0) { const d = new Date(now); d.setDate(d.getDate() + (((day - d.getDay() + 7) % 7) || 7)); return isoOf(d); }
  const yearOf = (y, month, dd) => {
    if (y) return Number(y);
    const candidate = new Date(now.getFullYear(), month, dd);
    return candidate < new Date(now.getFullYear(), now.getMonth(), now.getDate()) ? now.getFullYear() + 1 : now.getFullYear();
  };
  m = /\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([a-z]{3,9})\.?(?:,?\s+(\d{4}))?\b/.exec(t);
  if (m && MONTHS.includes(m[2].slice(0, 3))) {
    const month = MONTHS.indexOf(m[2].slice(0, 3));
    return `${yearOf(m[3], month, Number(m[1]))}-${pad(month + 1)}-${pad(m[1])}`;
  }
  m = /\b([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b/.exec(t);
  if (m && MONTHS.includes(m[1].slice(0, 3))) {
    const month = MONTHS.indexOf(m[1].slice(0, 3));
    return `${yearOf(m[3], month, Number(m[2]))}-${pad(month + 1)}-${pad(m[2])}`;
  }
  return null;
}

/** Capitalise the first letter, as a name typed in lower case should read. */
export const tidyName = (s) => {
  const t = String(s ?? '').trim().replace(/\s+/g, ' ').replace(/^[,.;:\-\s]+|[,.;:\s]+$/g, '');
  return t ? t[0].toUpperCase() + t.slice(1) : t;
};
