/**
 * time.js — wall-clock time for attendance. Pure.
 *
 * WHY WALL-CLOCK. A shift is "09:00 to 18:00" where the plant is, and a device reports
 * "2026-10-05 09:12:03" in its own local time. Everything in attendance is therefore a
 * WALL-CLOCK string 'YYYY-MM-DD HH:MM:SS' in the punch's timezone (Asia/Kolkata unless a
 * device says otherwise), stored as DATETIME and compared as text or as minutes. The pool
 * reads a DATETIME as a Date pinned to UTC (db.js `timezone: 'Z'`), so `wall(date)` turns it
 * back into the same text the row holds, on any host.
 */

const pad = (n) => String(n).padStart(2, '0');

/** A DATETIME as read (Date pinned to UTC, or text) -> 'YYYY-MM-DD HH:MM:SS'. */
export function wall(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return v.toISOString().slice(0, 19).replace('T', ' ');
  const s = String(v).replace('T', ' ');
  return s.length >= 19 ? s.slice(0, 19) : (s.length === 16 ? `${s}:00` : s);
}

/** A DATE as read -> 'YYYY-MM-DD'. */
export function day(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
  return String(v).slice(0, 10);
}

const DT_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/;
/** Is this 'YYYY-MM-DD HH:MM[:SS]' a real date and time? */
export function isWall(s) {
  const m = DT_RE.exec(String(s ?? '').trim());
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0)));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3] && +m[4] < 24 && +m[5] < 60 && +(m[6] ?? 0) < 60;
}
/** 'YYYY-MM-DD HH:MM[:SS]' -> 'YYYY-MM-DD HH:MM:SS', or null. */
export function normWall(s) {
  const t = String(s ?? '').trim().replace('T', ' ');
  if (!isWall(t)) return null;
  return t.length === 16 ? `${t}:00` : t.slice(0, 19);
}

/** Minutes since 1970 of a wall-clock string (as if it were UTC: only differences matter). */
export const toMin = (w) => Math.round(Date.parse(`${w.replace(' ', 'T')}Z`) / 60000);
/** The wall-clock string of minutes since 1970. */
export const fromMin = (m) => new Date(m * 60000).toISOString().slice(0, 19).replace('T', ' ');
/** 'YYYY-MM-DD' + 'HH:MM' (+ days) -> wall-clock. */
export const at = (date, hhmm, plusDays = 0) => fromMin(toMin(`${date} ${hhmm.slice(0, 5)}:00`) + plusDays * 1440);
/** 'HH:MM' of a wall-clock string. */
export const hm = (w) => (w ? w.slice(11, 16) : null);

/** The wall clock now in a timezone. `now` for tests. */
export function nowIn(tz = 'Asia/Kolkata', now = new Date()) {
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(now).map((p) => [p.type, p.value]));
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour === '24' ? '00' : parts.hour}:${parts.minute}:${parts.second}`;
  } catch {
    return now.toISOString().slice(0, 19).replace('T', ' ');
  }
}
export const todayIn = (tz = 'Asia/Kolkata', now = new Date()) => nowIn(tz, now).slice(0, 10);
/** The server's LOCAL date (Render runs with TZ=Asia/Kolkata), as every write's "today" is (positionService.today, lib/http.js dateParam). Never the UTC date. */
export const serverToday = (now = new Date()) => day(now);
/** UTC now as DATETIME text, for received_at / last_seen_at. */
export const utcNow = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

export const isTimezone = (tz) => { try { new Intl.DateTimeFormat('en-GB', { timeZone: String(tz) }); return true; } catch { return false; } };

/* ── months ───────────────────────────────────────────────────────────── */
export const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
export const monthOf = (date) => date.slice(0, 7);
export const monthStart = (month) => `${month}-01`;
export function monthEnd(month) {
  const [y, m] = month.split('-').map(Number);
  return `${month}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}`;
}
export const daysInMonth = (month) => Number(monthEnd(month).slice(8, 10));
export function addMonths(month, n) {
  const [y, m] = month.split('-').map(Number);
  const i = y * 12 + (m - 1) + n;
  return `${Math.floor(i / 12)}-${pad((i % 12) + 1)}`;
}
/** Every month that [from, to] touches. */
export function monthsBetween(from, to) {
  const out = [];
  for (let m = monthOf(from); m <= monthOf(to); m = addMonths(m, 1)) out.push(m);
  return out;
}
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const monthWords = (month) => `${MONTHS[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;

/** 75 -> "1 h 15 min", 45 -> "45 min", 120 -> "2 h". */
export function minutesWords(n) {
  const v = Math.max(0, Math.round(Number(n) || 0));
  const h = Math.floor(v / 60);
  const m = v % 60;
  if (!h) return `${m} min`;
  return m ? `${h} h ${m} min` : `${h} h`;
}
/** 4.5 -> "4.5 hours", 1 -> "1 hour". */
export const hoursWords = (h) => `${Math.round(Number(h) * 100) / 100} hour${Number(h) === 1 ? '' : 's'}`;

export default { serverToday, wall, day, isWall, normWall, toMin, fromMin, at, hm, nowIn, todayIn, utcNow, isTimezone, monthOf, monthStart, monthEnd, daysInMonth, addMonths, monthsBetween, monthWords, minutesWords, hoursWords, MONTH_RE };
