/**
 * notifications.js — a login's own in-app notifications (TM/CF_HRMS_HIRING_SPEC.md §42.3): the absence digests
 * today (services/attendance/channels.js writes them), anything person-to-person later. A login reads and marks
 * only ITS OWN rows (user id and company from the token, never from the request).
 */
const json = (v, d = null) => { if (v == null) return d; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return d; } };
const stamp = (v) => (v ? (v instanceof Date ? v.toISOString() : String(v)) : null);

const shape = (r) => ({
  id: r.id, kind: r.kind, title: r.title, body: r.body ?? '', data: json(r.data_json, null), link: r.link ?? null,
  read: Boolean(r.read_at), readAt: stamp(r.read_at), createdAt: stamp(r.created_at),
});

/** GET /notifications?unread=1 */
export async function myNotifications(db, c, { unreadOnly = false, limit = 50 } = {}) {
  const [rows] = await db.query(
    `SELECT * FROM hrms_notifications WHERE company_id = ? AND user_id = ? AND deleted_at IS NULL${unreadOnly ? ' AND read_at IS NULL' : ''}
      ORDER BY created_at DESC, id DESC LIMIT ?`, [c.companyId, c.userId, Math.min(200, Math.max(1, Number(limit) || 50))]);
  const [[n]] = await db.query('SELECT COUNT(*) AS n FROM hrms_notifications WHERE company_id = ? AND user_id = ? AND deleted_at IS NULL AND read_at IS NULL', [c.companyId, c.userId]);
  return { items: rows.map(shape), unread: Number(n.n) };
}

/** POST /notifications/:id/read — one of mine; someone else's reads as not found. */
export async function markRead(db, c, id) {
  const [u] = await db.query('UPDATE hrms_notifications SET read_at = COALESCE(read_at, ?) WHERE company_id = ? AND user_id = ? AND id = ? AND deleted_at IS NULL', [new Date(), c.companyId, c.userId, id]);
  return { updated: u.affectedRows };
}

/** POST /notifications/read-all */
export async function markAllRead(db, c) {
  const [u] = await db.query('UPDATE hrms_notifications SET read_at = ? WHERE company_id = ? AND user_id = ? AND read_at IS NULL AND deleted_at IS NULL', [new Date(), c.companyId, c.userId]);
  return { updated: u.affectedRows };
}

export default { myNotifications, markRead, markAllRead };
