import { pool } from '../../../db.js';

export { pool };

/** One query on the shared pool. Returns rows. */
export async function q(sql, params = []) {
  const [rows] = await pool.query(sql, params);
  return rows;
}

/** fn(conn) inside one transaction; conn.q(sql, params) returns rows. */
export async function tx(fn) {
  const conn = await pool.getConnection();
  conn.q = async (sql, params = []) => (await conn.query(sql, params))[0];
  try {
    await conn.beginTransaction();
    const out = await fn(conn);
    await conn.commit();
    return out;
  } catch (err) {
    try { await conn.rollback(); } catch { /* the original error is the one that matters */ }
    throw err;
  } finally {
    conn.release();
  }
}

const run = (conn) => (conn && conn.q ? conn.q : q);

/** Display name of a login on records, comments and the audit log. */
export const whoOf = (me) => (me ? (me.owner || me.name || me.email || '') : '');

export async function audit(me, action, entity, entityId, detail, conn) {
  await run(conn)(
    'INSERT INTO cf_crm_audit (customer_id, at, user_id, who, action, entity, entity_id, detail) VALUES (?,UTC_TIMESTAMP(3),?,?,?,?,?,?)',
    [me.customerId, me.id || null, whoOf(me).slice(0, 200), String(action || '').slice(0, 40), String(entity || '').slice(0, 200), String(entityId || '').slice(0, 64), String(detail || '').slice(0, 300)],
  );
}

/**
 * Notify every active member who acts as one of these owner names (or these
 * user ids), except the actor; with `business`, only members who may work on it.
 */
export async function notify(conn, me, { owners = [], userIds = [], except, kind, text, link, business = null }) {
  owners = [...new Set(owners.filter(Boolean).map(String))];
  const ids = [...new Set(userIds.map(Number).filter(Boolean))];
  if (!owners.length && !ids.length) return;
  const where = [];
  const args = [me.customerId];
  if (owners.length) { where.push(`owner IN (${owners.map(() => '?').join(',')})`); args.push(...owners); }
  if (ids.length) { where.push(`user_id IN (${ids.map(() => '?').join(',')})`); args.push(...ids); }
  const rows = await run(conn)(
    `SELECT user_id, businesses FROM cf_crm_members WHERE customer_id = ? AND active = 1 AND (${where.join(' OR ')})`, args,
  );
  const to = rows.filter((r) => {
    if (except && Number(r.user_id) === Number(except)) return false;
    const biz = parseJson(r.businesses, []);
    return !business || !biz.length || biz.includes(business);
  });
  if (!to.length) return;
  const t = String(text || '').slice(0, 300);
  await run(conn)(
    `INSERT INTO cf_crm_notifications (customer_id, user_id, kind, text, link, at) VALUES ${to.map(() => '(?,?,?,?,?,UTC_TIMESTAMP(3))').join(',')}`,
    to.flatMap((r) => [me.customerId, r.user_id, kind || null, t, String(link || '').slice(0, 200)]),
  );
}

/** mysql2 hands JSON columns back parsed on MySQL and as strings on some TiDB paths. */
export function parseJson(v, fallback) {
  if (v == null) return fallback;
  if (typeof v === 'string') { try { return JSON.parse(v); } catch { return fallback; } }
  return v;
}

/** An error the routes turn into { error } with this status. */
export class CrmError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
