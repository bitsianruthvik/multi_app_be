/**
 * devices.js — devices, their ADMS push, and the API keys. (TM/CF_HRMS_HIRING_SPEC.md §28.1.)
 *
 * A device belongs to one company by its SERIAL NUMBER, unique across every company: the ADMS
 * push names nothing but the serial, so that is how a punch finds its tenant. An unknown or
 * disabled serial is refused (and logged by the route) and nothing it sends is stored.
 *
 * API KEYS (`POST /api/integrations/attendance/punches`): one company each, made and revoked by
 * the Owner. The key is shown ONCE; only its SHA-256 is kept, found by its prefix.
 *   hrk_<8 hex prefix>_<43 chars of secret>
 */
import crypto from 'crypto';
import { HrmsError, invalid, notFound, conflict } from '../../lib/errors.js';
import { audit } from '../peopleService.js';
import { parseAttlog, parseOperlog, handshakeText, validSerial } from './adms.js';
import { ingestPunches, newBatchId } from './punches.js';
import { isTimezone, utcNow, wall } from './time.js';

export const PROTOCOLS = ['ADMS', 'API', 'IMPORT'];
/** A device not heard from for this long is shown as offline. */
export const ONLINE_MINUTES = 10;

const shape = (r) => {
  const seen = r.last_seen_at ? new Date(`${wall(r.last_seen_at).replace(' ', 'T')}Z`) : null;
  const online = Boolean(seen) && Date.now() - seen.getTime() < ONLINE_MINUTES * 60000;
  return {
    id: r.id, name: r.name, serialNumber: r.serial_number, make: r.make ?? null, model: r.model ?? null, locationId: r.location_id ?? null,
    locationName: r.location_name ?? null, timezone: r.timezone, protocol: r.protocol, status: r.status,
    lastSeenAt: seen ? seen.toISOString() : null, lastPunchAt: wall(r.last_punch_at), lastIp: r.last_ip ?? null, online,
    state: r.status === 'DISABLED' ? 'Disabled' : (!seen ? 'Never connected' : (online ? 'Online' : 'Offline')),
    mapped: Number(r.mapped ?? 0), unmapped: Number(r.unmapped ?? 0), punchesToday: Number(r.today ?? 0), info: r.device_info ?? null, notes: r.notes ?? null,
  };
};

export async function listDevices(db, c) {
  const [rows] = await db.query(
    `SELECT d.*, l.name AS location_name,
            (SELECT COUNT(*) FROM hrms_attendance_device_users m WHERE m.company_id = d.company_id AND m.deleted_at IS NULL AND (m.device_id = d.id OR m.device_id IS NULL)) AS mapped,
            (SELECT COUNT(DISTINCT p.device_user_id) FROM hrms_attendance_punches p WHERE p.company_id = d.company_id AND p.device_id = d.id AND p.employee_id IS NULL) AS unmapped,
            (SELECT COUNT(*) FROM hrms_attendance_punches p WHERE p.company_id = d.company_id AND p.device_id = d.id AND p.received_at >= UTC_DATE()) AS today
       FROM hrms_attendance_devices d LEFT JOIN hrms_locations l ON l.company_id = d.company_id AND l.id = d.location_id
      WHERE d.company_id = ? AND d.deleted_at IS NULL ORDER BY d.name`, [c.companyId]);
  return { devices: rows.map(shape), onlineMinutes: ONLINE_MINUTES };
}

function readDevice(body, problems, { creating }) {
  const out = {};
  if (creating || body.name !== undefined) { out.name = String(body.name ?? '').trim().slice(0, 120); if (!out.name) problems.push('Give the device a name (where it is: "Gate 1").'); }
  if (creating || body.serialNumber !== undefined) { out.serial = String(body.serialNumber ?? '').trim(); if (!validSerial(out.serial)) problems.push('The serial number is 3 to 64 letters, digits, - or _ (it is on the device: Menu › System info).'); }
  if (body.make !== undefined) out.make = String(body.make ?? '').trim().slice(0, 60) || null;
  if (body.model !== undefined) out.model = String(body.model ?? '').trim().slice(0, 60) || null;
  if (body.notes !== undefined) out.notes = String(body.notes ?? '').trim().slice(0, 500) || null;
  if (body.locationId !== undefined) out.locationId = body.locationId == null || body.locationId === '' ? null : Number(body.locationId);
  if (creating || body.timezone !== undefined) { out.timezone = String(body.timezone ?? 'Asia/Kolkata'); if (!isTimezone(out.timezone)) problems.push('That timezone is not known (Asia/Kolkata).'); }
  if (creating || body.protocol !== undefined) { out.protocol = String(body.protocol ?? 'ADMS').toUpperCase(); if (!PROTOCOLS.includes(out.protocol)) problems.push('The device sends by ADMS push, by the API, or by file.'); }
  if (body.status !== undefined) { out.status = String(body.status).toUpperCase(); if (!['ACTIVE', 'DISABLED'].includes(out.status)) problems.push('A device is active or disabled.'); }
  return out;
}

async function serialFree(conn, serial, exceptId = null) {
  const [[r]] = await conn.query('SELECT id FROM hrms_attendance_devices WHERE serial_active = ? AND (? IS NULL OR id <> ?)', [serial.toUpperCase(), exceptId, exceptId]);
  // Another company's device is not named: only that the serial is taken.
  if (r) throw conflict('SERIAL_TAKEN', 'A device with this serial number is registered already. Check the number on the device, or remove the old entry first.');
}

export async function createDevice(conn, c, body = {}, requestId = null) {
  const problems = [];
  const d = readDevice(body, problems, { creating: true });
  if (problems.length) throw invalid('INVALID', problems[0], { problems });
  await serialFree(conn, d.serial);
  if (d.locationId) { const [[l]] = await conn.query('SELECT id FROM hrms_locations WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [c.companyId, d.locationId]); if (!l) throw notFound('That location'); }
  const [ins] = await conn.query(
    'INSERT INTO hrms_attendance_devices (company_id, name, serial_number, make, model, location_id, timezone, protocol, notes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [c.companyId, d.name, d.serial, d.make ?? null, d.model ?? null, d.locationId ?? null, d.timezone, d.protocol, d.notes ?? null, c.userId]);
  await audit(conn, c, 'hrms_attendance_devices', ins.insertId, 'CREATE', null, d, requestId);
  return { device: (await listDevices(conn, c)).devices.find((x) => x.id === ins.insertId) };
}

export async function updateDevice(conn, c, id, body = {}, requestId = null) {
  const [[row]] = await conn.query('SELECT * FROM hrms_attendance_devices WHERE company_id = ? AND id = ? AND deleted_at IS NULL FOR UPDATE', [c.companyId, id]);
  if (!row) throw notFound('That device');
  const problems = [];
  const d = readDevice(body, problems, { creating: false });
  if (problems.length) throw invalid('INVALID', problems[0], { problems });
  if (d.serial && d.serial.toUpperCase() !== String(row.serial_number).toUpperCase()) await serialFree(conn, d.serial, id);
  const cols = { name: d.name, serial_number: d.serial, make: d.make, model: d.model, location_id: d.locationId, timezone: d.timezone, protocol: d.protocol, status: d.status, notes: d.notes };
  const set = Object.entries(cols).filter(([, v]) => v !== undefined);
  if (set.length) await conn.query(`UPDATE hrms_attendance_devices SET ${set.map(([k]) => `${k} = ?`).join(', ')} WHERE company_id = ? AND id = ?`, [...set.map(([, v]) => v), c.companyId, id]);
  await audit(conn, c, 'hrms_attendance_devices', id, 'UPDATE', { name: row.name, serial: row.serial_number, status: row.status }, d, requestId);
  return { device: (await listDevices(conn, c)).devices.find((x) => x.id === id) };
}

/** Removing a device keeps every punch it sent; its serial is free again. */
export async function removeDevice(conn, c, id, requestId = null) {
  const [[row]] = await conn.query('SELECT id, name, serial_number FROM hrms_attendance_devices WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [c.companyId, id]);
  if (!row) throw notFound('That device');
  await conn.query('UPDATE hrms_attendance_devices SET deleted_at = NOW() WHERE company_id = ? AND id = ?', [c.companyId, id]);
  await conn.query('UPDATE hrms_attendance_device_users SET deleted_at = NOW() WHERE company_id = ? AND device_id = ? AND deleted_at IS NULL', [c.companyId, id]);
  await audit(conn, c, 'hrms_attendance_devices', id, 'DELETE', { name: row.name, serial: row.serial_number }, null, requestId);
  return { ok: true };
}

/* ══ the ADMS push ═════════════════════════════════════════════════════════ */

/** The registered, active device of a serial (any company), or null. */
export async function deviceBySerial(db, serial) {
  if (!validSerial(serial)) return null;
  const [[d]] = await db.query("SELECT * FROM hrms_attendance_devices WHERE serial_active = ? AND status = 'ACTIVE'", [String(serial).toUpperCase()]);
  return d ?? null;
}

async function touch(db, d, ip, extra = {}) {
  const sets = ['last_seen_at = ?', 'last_ip = ?'];
  const params = [utcNow(), ip ? String(ip).slice(0, 64) : null];
  if (extra.attlogStamp) { sets.push('attlog_stamp = ?'); params.push(String(extra.attlogStamp).slice(0, 40)); }
  if (extra.operlogStamp) { sets.push('operlog_stamp = ?'); params.push(String(extra.operlogStamp).slice(0, 40)); }
  if (extra.info) { sets.push('device_info = ?'); params.push(String(extra.info).slice(0, 500)); }
  await db.query(`UPDATE hrms_attendance_devices SET ${sets.join(', ')} WHERE company_id = ? AND id = ?`, [...params, d.company_id, d.id]);
}

/** GET /iclock/cdata — the handshake. */
export async function admsHandshake(db, d, { ip, query }) {
  await touch(db, d, ip, { info: query.INFO ?? null });
  return handshakeText(d.serial_number, { attlogStamp: d.attlog_stamp, operlogStamp: d.operlog_stamp });
}

/** POST /iclock/cdata?table=… — store what the device sent. Returns the answer text. */
export async function admsUpload(conn, d, { ip, query, body }) {
  const c = { companyId: d.company_id, userId: null };
  const tableName = String(query.table ?? '').toUpperCase();
  const stamp = query.Stamp ?? query.stamp ?? null;
  if (tableName === 'ATTLOG') {
    const { punches, bad } = parseAttlog(body);
    const report = await ingestPunches(conn, c, punches, { deviceId: d.id, timezone: d.timezone, source: 'ADMS', batchId: newBatchId('ADMS') });
    await touch(conn, d, ip, { attlogStamp: stamp });
    return { text: `OK: ${punches.length}`, report: { ...report, unreadable: bad.length } };
  }
  if (tableName === 'OPERLOG' || tableName === 'USERINFO' || tableName === 'OPLOG') {
    const { lines, kinds } = parseOperlog(body);
    // Stored as an audit row, not acted on: nothing from a device can do more than add punches.
    await conn.query(
      `INSERT INTO hrms_audit_log (company_id, actor_user_id, entity_type, entity_id, action, before_json, after_json, request_id, created_by)
       VALUES (?, NULL, 'hrms_attendance_devices', ?, 'IMPORT', NULL, ?, NULL, NULL)`,
      [d.company_id, d.id, JSON.stringify({ table: tableName, kinds, lines: lines.slice(0, 50).map((l) => l.slice(0, 200)) })]);
    await touch(conn, d, ip, { operlogStamp: stamp });
    return { text: `OK: ${lines.length}`, report: { kinds } };
  }
  await touch(conn, d, ip);
  return { text: 'OK', report: { ignored: tableName || 'unknown' } };
}

/** GET /iclock/getrequest — nothing is ever sent to a device. */
export async function admsPoll(db, d, { ip }) {
  await touch(db, d, ip);
  return 'OK';
}

/* ══ API keys ══════════════════════════════════════════════════════════════ */

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

export async function listKeys(db, c) {
  const [rows] = await db.query(
    `SELECT k.id, k.name, k.key_prefix, k.status, k.last_used_at, k.use_count, k.created_at, k.revoked_at, u.name AS created_by_name
       FROM hrms_attendance_api_keys k LEFT JOIN users u ON u.id = k.created_by
      WHERE k.company_id = ? AND k.deleted_at IS NULL ORDER BY k.id DESC`, [c.companyId]);
  return {
    keys: rows.map((k) => ({
      id: k.id, name: k.name, prefix: `hrk_${k.key_prefix}_…`, status: k.status, lastUsedAt: k.last_used_at ? new Date(k.last_used_at).toISOString() : null,
      useCount: Number(k.use_count), createdAt: k.created_at ? new Date(k.created_at).toISOString() : null, createdBy: k.created_by_name ?? null,
      revokedAt: k.revoked_at ? new Date(k.revoked_at).toISOString() : null,
    })),
  };
}

/** POST /attendance/api-keys { name } (the Owner) -> { key: { id, name, prefix }, secret } — the secret is shown this once. */
export async function createKey(conn, c, body = {}, requestId = null) {
  const name = String(body.name ?? '').trim().slice(0, 120);
  if (!name) throw invalid('INVALID', 'Name the key after what will use it ("Matrix COSEC server").');
  const prefix = crypto.randomBytes(4).toString('hex');
  const secret = `hrk_${prefix}_${crypto.randomBytes(32).toString('base64url')}`;
  const [ins] = await conn.query('INSERT INTO hrms_attendance_api_keys (company_id, name, key_prefix, key_hash, created_by) VALUES (?, ?, ?, ?, ?)',
    [c.companyId, name, prefix, sha(secret), c.userId]);
  await audit(conn, c, 'hrms_attendance_api_keys', ins.insertId, 'CREATE', null, { name, prefix }, requestId);
  return { key: { id: ins.insertId, name, prefix: `hrk_${prefix}_…`, status: 'ACTIVE' }, secret, note: 'Copy it now: it is not shown again. Only a fingerprint of it is kept.' };
}

export async function revokeKey(conn, c, id, requestId = null) {
  const [[k]] = await conn.query('SELECT id, name, status FROM hrms_attendance_api_keys WHERE company_id = ? AND id = ? AND deleted_at IS NULL FOR UPDATE', [c.companyId, id]);
  if (!k) throw notFound('That key');
  if (k.status === 'REVOKED') return { ok: true };
  await conn.query("UPDATE hrms_attendance_api_keys SET status = 'REVOKED', revoked_at = NOW(), revoked_by = ? WHERE company_id = ? AND id = ?", [c.userId, c.companyId, id]);
  await audit(conn, c, 'hrms_attendance_api_keys', id, 'UPDATE', { status: 'ACTIVE' }, { status: 'REVOKED' }, requestId);
  return { ok: true };
}

/** The company of an API key, or null. Constant-time on the hash. */
export async function companyOfKey(db, key) {
  const m = /^hrk_([0-9a-f]{8})_[A-Za-z0-9_-]{20,}$/.exec(String(key ?? '').trim());
  if (!m) return null;
  const [[k]] = await db.query("SELECT id, company_id, key_hash, status FROM hrms_attendance_api_keys WHERE key_prefix = ? AND deleted_at IS NULL", [m[1]]);
  if (!k || k.status !== 'ACTIVE') return null;
  const a = Buffer.from(sha(key.trim()), 'hex');
  const b = Buffer.from(k.key_hash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  await db.query('UPDATE hrms_attendance_api_keys SET last_used_at = NOW(), use_count = use_count + 1 WHERE id = ?', [k.id]);
  return { companyId: k.company_id, keyId: k.id };
}

/**
 * POST /api/integrations/attendance/punches { punches: [{ employeeCode | deviceUserId, deviceSerial?, time, direction?, method? }] }
 * A punch names the person by employee code, or by the user number of a device of THIS company.
 */
export async function apiPunches(conn, key, body = {}, ip = null) {
  const list = Array.isArray(body?.punches) ? body.punches : null;
  if (!list) throw invalid('INVALID', 'Send { "punches": [ { "employeeCode": "…", "time": "YYYY-MM-DD HH:MM:SS", "direction": "IN" } ] }.');
  const c = { companyId: key.companyId, userId: null };
  const serials = [...new Set(list.map((p) => p?.deviceSerial).filter(Boolean).map((s) => String(s).toUpperCase()))];
  const devices = new Map();
  if (serials.length) {
    const [rows] = await conn.query('SELECT id, serial_number, timezone FROM hrms_attendance_devices WHERE company_id = ? AND deleted_at IS NULL AND serial_active IN (?)', [c.companyId, serials]);
    for (const r of rows) devices.set(String(r.serial_number).toUpperCase(), r);
  }
  const groups = new Map();
  const rejected = [];
  list.forEach((p, index) => {
    const serial = p?.deviceSerial ? String(p.deviceSerial).toUpperCase() : null;
    const dev = serial ? devices.get(serial) : null;
    if (serial && !dev) { rejected.push({ index, why: `No device ${String(p.deviceSerial).slice(0, 64)} is registered for this company.` }); return; }
    const uid = dev ? p.deviceUserId : (p.employeeCode ?? p.deviceUserId);
    const g = groups.get(dev?.id ?? 0) ?? { dev, items: [] };
    g.items.push({ deviceUserId: uid, at: p.time ?? p.at, direction: p.direction, method: p.method ?? 'API', raw: JSON.stringify(p).slice(0, 500), ip, index });
    groups.set(dev?.id ?? 0, g);
  });
  const total = { received: list.length, inserted: 0, duplicates: 0, unmapped: 0, rejected };
  for (const g of groups.values()) {
    const r = await ingestPunches(conn, c, g.items, { deviceId: g.dev?.id ?? null, timezone: g.dev?.timezone ?? 'Asia/Kolkata', source: 'API' });
    total.inserted += r.inserted; total.duplicates += r.duplicates; total.unmapped += r.unmapped;
    for (const x of r.rejected) rejected.push({ index: g.items[x.index].index, why: x.why });
  }
  return total;
}

export default { listDevices, createDevice, updateDevice, removeDevice, deviceBySerial, admsHandshake, admsUpload, admsPoll, listKeys, createKey, revokeKey, companyOfKey, apiPunches };
export { HrmsError };
