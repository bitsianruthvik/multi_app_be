/**
 * settings.js — a company's attendance settings (TM/CF_HRMS_HIRING_SPEC.md §28.1, §28.4).
 *
 *   liveFrom          "attendance is live from" — nothing is processed before it, and leave
 *                     keeps its attendance notes (EL's present days, ML's 80 days) until it.
 *   webPunch          { enabled, ipAllowList: string[], geofences: [{ locationId, lat, lng, radiusM }] }
 *   defaultTimezone   for the web punch and a punch with no device
 */
import { invalid } from '../../lib/errors.js';
import { audit } from '../peopleService.js';
import { day, isTimezone } from './time.js';

const json = (v) => { if (v == null) return null; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return null; } };

export const DEFAULT_SETTINGS = Object.freeze({ liveFrom: null, webPunch: { enabled: false, ipAllowList: [], geofences: [] }, defaultTimezone: 'Asia/Kolkata' });

export async function settingsOf(db, companyId) {
  const [[row]] = await db.query('SELECT * FROM hrms_attendance_settings WHERE company_id = ?', [companyId]);
  if (!row) return { ...DEFAULT_SETTINGS, webPunch: { ...DEFAULT_SETTINGS.webPunch } };
  return {
    liveFrom: day(row.live_from),
    webPunch: { enabled: Boolean(row.web_punch_enabled), ipAllowList: json(row.ip_allow_json) ?? [], geofences: json(row.geofences_json) ?? [] },
    defaultTimezone: row.default_timezone || 'Asia/Kolkata',
  };
}

/* ── IP allow-list ───────────────────────────────────────────────────────── */
const ipv4 = (s) => { const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s); if (!m) return null; const p = m.slice(1).map(Number); if (p.some((x) => x > 255)) return null; return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3]; };
/** "203.0.113.0/24" or "198.51.100.7" (IPv4), or an exact IPv6 text. */
export function validIpRule(rule) {
  const [ip, bits] = String(rule).trim().split('/');
  if (ipv4(ip) !== null) return bits === undefined || (/^\d+$/.test(bits) && Number(bits) <= 32);
  return bits === undefined && /^[0-9a-f:]+$/i.test(ip) && ip.includes(':');
}
export function ipAllowed(ip, rules) {
  if (!rules?.length) return true;
  const clean = String(ip ?? '').replace(/^::ffff:/, '');
  const n = ipv4(clean);
  return rules.some((rule) => {
    const [base, bits] = String(rule).trim().split('/');
    if (n === null || ipv4(base) === null) return clean.toLowerCase() === base.toLowerCase();
    const b = bits === undefined ? 32 : Number(bits);
    const mask = b === 0 ? 0 : ((0xffffffff << (32 - b)) >>> 0);
    return ((n & mask) >>> 0) === ((ipv4(base) & mask) >>> 0);
  });
}

/** Metres between two points (haversine). */
export function metresBetween(a, b) {
  const R = 6371000;
  const rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** PUT /attendance/settings */
export async function putSettings(conn, c, body = {}, requestId = null) {
  const before = await settingsOf(conn, c.companyId);
  const problems = [];
  let liveFrom = before.liveFrom;
  if (body.liveFrom !== undefined) {
    if (body.liveFrom === null || body.liveFrom === '') liveFrom = null;
    else if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body.liveFrom))) problems.push('"Live from" is a date (YYYY-MM-DD).');
    else liveFrom = String(body.liveFrom);
  }
  const wp = { ...before.webPunch, ...(body.webPunch ?? {}) };
  wp.enabled = Boolean(wp.enabled);
  wp.ipAllowList = Array.isArray(wp.ipAllowList) ? wp.ipAllowList.map((s) => String(s).trim()).filter(Boolean) : [];
  const badIp = wp.ipAllowList.find((r) => !validIpRule(r));
  if (badIp) problems.push(`"${badIp.slice(0, 60)}" is not an address or a range like 203.0.113.0/24.`);
  wp.geofences = Array.isArray(wp.geofences) ? wp.geofences.map((g) => ({ locationId: g.locationId == null ? null : Number(g.locationId), lat: Number(g.lat), lng: Number(g.lng), radiusM: Number(g.radiusM) })) : [];
  for (const g of wp.geofences) {
    if (!(Math.abs(g.lat) <= 90 && Math.abs(g.lng) <= 180) || !Number.isFinite(g.lat) || !Number.isFinite(g.lng)) problems.push('A geofence needs a latitude (−90 to 90) and a longitude (−180 to 180).');
    if (!(g.radiusM >= 20 && g.radiusM <= 20000)) problems.push('A geofence radius is from 20 to 20,000 metres.');
  }
  const tz = body.defaultTimezone === undefined ? before.defaultTimezone : String(body.defaultTimezone);
  if (!isTimezone(tz)) problems.push('That timezone is not known (for example Asia/Kolkata).');
  if (problems.length) throw invalid('INVALID', problems[0], { problems });
  await conn.query(
    `INSERT INTO hrms_attendance_settings (company_id, live_from, web_punch_enabled, ip_allow_json, geofences_json, default_timezone, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE live_from = VALUES(live_from), web_punch_enabled = VALUES(web_punch_enabled), ip_allow_json = VALUES(ip_allow_json),
       geofences_json = VALUES(geofences_json), default_timezone = VALUES(default_timezone)`,
    [c.companyId, liveFrom, wp.enabled ? 1 : 0, JSON.stringify(wp.ipAllowList), JSON.stringify(wp.geofences), tz, c.userId]);
  const after = await settingsOf(conn, c.companyId);
  await audit(conn, c, 'hrms_attendance_settings', c.companyId, 'UPDATE', before, after, requestId);
  return { settings: after };
}

/** Months that are closed, as a Set of 'YYYY-MM'. */
export async function closedMonths(db, companyId) {
  const [rows] = await db.query("SELECT period_month FROM hrms_attendance_months WHERE company_id = ? AND status = 'CLOSED'", [companyId]);
  return new Set(rows.map((r) => r.period_month));
}

export default { settingsOf, putSettings, ipAllowed, metresBetween, closedMonths, validIpRule };
