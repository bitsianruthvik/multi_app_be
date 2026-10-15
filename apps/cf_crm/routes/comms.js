import crypto from 'node:crypto';
import express, { Router } from 'express';
import { q, tx, audit, notify, whoOf, parseJson } from '../lib/db.js';
import { crm, handle } from '../lib/context.js';
import { canBiz } from '../lib/roles.js';
import { upsertRecords } from './data.js';
import { vapidKeys, saveSubscription, dropSubscription, sendPush } from '../lib/push.js';

/** Documents, team chat and notifications. Ports of api/files.js, chat.js, notify.js. */
const router = Router({ mergeParams: true });

/* ----------------------------------------------------------------- files */
// POST /files?entity=&entityId=&docType=&name=&mime=&period=&note=   raw body (up to 4 MB)
// GET  /files?id=     the file, for logins who can see the record
// DELETE /files?id=   owners, or whoever uploaded it
const MAX = 4 * 1024 * 1024;
const ENTITIES = new Set(['companies', 'people']);
const clean = (s, n = 200) => String(s || '').replace(/[\u0000-\u001f]/g, '').slice(0, n);

async function canSeePerson(customerId, personId, me) {
  const r = await q("SELECT data FROM cf_crm_records WHERE customer_id = ? AND type = 'people' AND id = ? AND deleted = 0", [customerId, personId]);
  const p = r[0] && parseJson(r[0].data, null);
  if (!p) return false;
  if (p.private && p.ownerInCharge && p.ownerInCharge !== me.owner) return false;
  if (!me.can.all && (p.ownerInCharge || '') !== me.owner) return false;
  return true;
}

router.get('/files', ...crm(), handle(async (req, res, { customer, me }) => {
  const id = String(req.query.id || '');
  const r = await q("SELECT data FROM cf_crm_records WHERE customer_id = ? AND type = 'docs' AND id = ? AND deleted = 0", [customer.id, id]);
  const d = r[0] && parseJson(r[0].data, null);
  if (!d) return res.status(404).json({ error: 'Document not found.' });
  if (d.entity === 'people' && !(await canSeePerson(customer.id, d.entityId, me))) return res.status(404).json({ error: 'Document not found.' });
  const f = (await q('SELECT data, mime FROM cf_crm_files WHERE customer_id = ? AND id = ?', [customer.id, id]))[0];
  if (!f) return res.status(404).json({ error: 'The file is missing.' });
  res.status(200);
  res.setHeader('content-type', f.mime || 'application/octet-stream');
  res.setHeader('content-length', f.data.length);
  res.setHeader('cache-control', 'private, no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('content-security-policy', "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox");
  const inline = /^(application\/pdf|image\/(png|jpe?g|webp|gif))$/.test(f.mime);
  res.setHeader('content-disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(d.name || 'document')}`);
  res.end(f.data);
}));

router.post('/files', ...crm(), express.raw({ type: () => true, limit: MAX + 1024 }), handle(async (req, res, { customer, me }) => {
  const p = req.query;
  if (!me.can.write) return res.status(403).json({ error: 'Your account is read-only.' });
  if (!ENTITIES.has(p.entity) || !/^[A-Za-z0-9_-]{1,64}$/.test(p.entityId || '')) return res.status(400).json({ error: 'Unknown record.' });
  const ex = await q('SELECT 1 FROM cf_crm_records WHERE customer_id = ? AND type = ? AND id = ? AND deleted = 0', [customer.id, p.entity, p.entityId]);
  if (!ex[0]) return res.status(404).json({ error: 'Save the record first, then upload.' });
  if (p.entity === 'people' && !(await canSeePerson(customer.id, p.entityId, me))) return res.status(403).json({ error: 'You cannot add documents to this person.' });
  const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (!buf.length) return res.status(400).json({ error: 'The file is empty.' });
  if (buf.length > MAX) return res.status(413).json({ error: 'That file is over 4 MB.' });
  const mime = (clean(p.mime, 100) || 'application/octet-stream').split(';')[0];
  const id = crypto.randomBytes(9).toString('base64url');
  const doc = {
    id, entity: p.entity, entityId: p.entityId, personId: p.entity === 'people' ? p.entityId : '',
    docType: clean(p.docType, 60) || 'other', name: clean(p.name, 180) || 'document', mime, size: buf.length,
    period: clean(p.period, 60), note: clean(p.note, 300), by: whoOf(me), byId: String(me.id), at: new Date().toISOString(),
  };
  await tx(async (c) => {
    await c.q('INSERT INTO cf_crm_files (customer_id, id, data, mime, size, created_by) VALUES (?,?,?,?,?,?)', [customer.id, id, buf, mime, buf.length, me.id]);
    await upsertRecords(c, customer.id, me.id, [{ t: 'docs', i: id, d: doc }]);
    await audit(me, 'upload', p.entity, p.entityId, `${doc.docType}: ${doc.name}`, c);
  });
  res.json({ doc });
}));

router.delete('/files', ...crm(), handle(async (req, res, { customer, me }) => {
  const id = String(req.query.id || '');
  const r = await q("SELECT data FROM cf_crm_records WHERE customer_id = ? AND type = 'docs' AND id = ? AND deleted = 0", [customer.id, id]);
  const d = r[0] && parseJson(r[0].data, null);
  if (!d) return res.status(404).json({ error: 'Document not found.' });
  if (!me.can.delete && String(d.byId) !== String(me.id)) return res.status(403).json({ error: 'Only owners or the person who uploaded it can delete a document.' });
  await tx(async (c) => {
    await upsertRecords(c, customer.id, me.id, [{ t: 'docs', i: id, x: 1 }]);
    await c.q('DELETE FROM cf_crm_files WHERE customer_id = ? AND id = ?', [customer.id, id]);
    await audit(me, 'delete document', d.entity, d.entityId, `${d.docType}: ${d.name}`, c);
  });
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------ chat */
// GET  ?a=threads | ?a=messages&thread=&after=
// POST ?a=send {thread,text} | ?a=delete {id} | ?a=dm {userId} | ?a=group {name,members} | ?a=groupEdit {thread,name,members}
const DEFAULT_BIZ = [{ id: 'chit', name: 'Chit Fund' }, { id: 're', name: 'Real Estate' }];
const memberIds = (t) => parseJson(t.members, []).map(Number);
const toStr = (ids) => ids.map(String);

async function ensureBizThreads(customerId, cfg) {
  const list = Array.isArray(cfg.businesses) && cfg.businesses.length ? cfg.businesses : DEFAULT_BIZ;
  for (const b of list) {
    if (!b || !b.id) continue;
    await q(
      `INSERT INTO cf_crm_chat_threads (customer_id, id, kind, name, business, members) VALUES (?, ?, 'business', ?, ?, '[]')
       ON DUPLICATE KEY UPDATE name = VALUES(name)`, [customerId, ('biz:' + b.id).slice(0, 64), String(b.name || b.id).slice(0, 120), String(b.id).slice(0, 40)]);
  }
  return list;
}

const canSee = (t, me) => !!t && (t.kind === 'business' ? canBiz(me, t.business) : memberIds(t).includes(me.id));

async function activeMembers(customerId, ids) {
  if (!ids.length) return [];
  const rows = await q(`SELECT user_id FROM cf_crm_members WHERE customer_id = ? AND active = 1 AND user_id IN (${ids.map(() => '?').join(',')})`, [customerId, ...ids]);
  return rows.map((r) => Number(r.user_id));
}

const getThread = async (customerId, id) => (await q('SELECT * FROM cf_crm_chat_threads WHERE customer_id = ? AND id = ?', [customerId, String(id || '')]))[0];
const msgOut = (m) => ({ id: Number(m.id), userId: m.user_id == null ? null : String(m.user_id), who: m.who, text: m.deleted_at ? '' : m.text, at: m.at, deleted: !!m.deleted_at });
const markRead = (customerId, threadId, userId, last) => q(
  `INSERT INTO cf_crm_chat_reads (customer_id, thread_id, user_id, last_id) VALUES (?,?,?,?)
   ON DUPLICATE KEY UPDATE last_id = GREATEST(last_id, VALUES(last_id))`, [customerId, threadId, userId, last]);

router.get('/chat', ...crm(), handle(async (req, res, { customer, me, cfg }) => {
  const a = req.query.a;
  if (a === 'threads') {
    const bizList = await ensureBizThreads(customer.id, cfg);
    const live = new Set(bizList.map((b) => 'biz:' + b.id));
    const rows = await q(
      `SELECT t.*, COALESCE(rd.last_id, 0) AS read_id,
         (SELECT COUNT(*) FROM cf_crm_chat_messages m WHERE m.customer_id = t.customer_id AND m.thread_id = t.id
            AND m.id > COALESCE(rd.last_id, 0) AND (m.user_id IS NULL OR m.user_id <> ?) AND m.deleted_at IS NULL) AS unread,
         (SELECT MAX(m.id) FROM cf_crm_chat_messages m WHERE m.customer_id = t.customer_id AND m.thread_id = t.id) AS last_id
       FROM cf_crm_chat_threads t
       LEFT JOIN cf_crm_chat_reads rd ON rd.customer_id = t.customer_id AND rd.thread_id = t.id AND rd.user_id = ?
      WHERE t.customer_id = ?
      ORDER BY t.updated_at DESC`, [me.id, me.id, customer.id]);
    const threads = rows.filter((t) => (t.kind === 'business' ? live.has(t.id) && canBiz(me, t.business) : memberIds(t).includes(me.id)));
    const lastIds = threads.map((t) => t.last_id).filter(Boolean);
    const lasts = lastIds.length ? await q(`SELECT id, who, text, at, deleted_at FROM cf_crm_chat_messages WHERE id IN (${lastIds.map(() => '?').join(',')})`, lastIds) : [];
    const lastOf = new Map(lasts.map((m) => [Number(m.id), { id: Number(m.id), who: m.who, text: m.deleted_at ? '' : m.text, at: m.at, deleted_at: m.deleted_at }]));
    const users = await q(
      `SELECT m.user_id, m.owner, u.name, u.email FROM cf_crm_members m JOIN users u ON u.id = m.user_id
        WHERE m.customer_id = ? AND m.active = 1 ORDER BY u.name`, [customer.id]);
    return res.json({
      threads: threads.map((t) => ({ id: t.id, kind: t.kind, name: t.name, business: t.business, members: toStr(memberIds(t)), createdBy: t.created_by == null ? null : String(t.created_by), unread: Number(t.unread) || 0, last: t.last_id ? lastOf.get(Number(t.last_id)) || null : null })),
      users: users.map((u) => ({ id: String(u.user_id), name: u.name || u.email, owner: u.owner })),
    });
  }
  if (a === 'messages') {
    const t = await getThread(customer.id, req.query.thread);
    if (!canSee(t, me)) return res.status(404).json({ error: 'Chat not found.' });
    const after = Number(req.query.after) || 0;
    const rows = after
      ? await q('SELECT id, user_id, who, text, at, deleted_at FROM cf_crm_chat_messages WHERE customer_id = ? AND thread_id = ? AND id > ? ORDER BY id LIMIT 300', [customer.id, t.id, after])
      : (await q('SELECT id, user_id, who, text, at, deleted_at FROM cf_crm_chat_messages WHERE customer_id = ? AND thread_id = ? ORDER BY id DESC LIMIT 200', [customer.id, t.id])).reverse();
    // deletions made since the last poll
    const del = after
      ? (await q('SELECT id FROM cf_crm_chat_messages WHERE customer_id = ? AND thread_id = ? AND id <= ? AND deleted_at > UTC_TIMESTAMP(3) - INTERVAL 2 MINUTE', [customer.id, t.id, after])).map((x) => Number(x.id))
      : [];
    const last = rows.length ? Number(rows[rows.length - 1].id) : after;
    if (last) await markRead(customer.id, t.id, me.id, last);
    return res.json({ messages: rows.map(msgOut), deleted: del });
  }
  res.status(404).json({ error: 'Unknown action' });
}));

router.post('/chat', ...crm(), handle(async (req, res, { customer, me }) => {
  const a = req.query.a;
  const b = req.body || {};
  if (a === 'send') {
    const text = String(b.text || '').trim().slice(0, 4000);
    if (!text) return res.status(400).json({ error: 'Type a message.' });
    const t = await getThread(customer.id, b.thread);
    if (!canSee(t, me)) return res.status(404).json({ error: 'Chat not found.' });
    const ins = await q('INSERT INTO cf_crm_chat_messages (customer_id, thread_id, user_id, who, text, at) VALUES (?,?,?,?,?, UTC_TIMESTAMP(3))', [customer.id, t.id, me.id, whoOf(me), text]);
    const m = (await q('SELECT id, user_id, who, text, at, deleted_at FROM cf_crm_chat_messages WHERE id = ?', [ins.insertId]))[0];
    await q('UPDATE cf_crm_chat_threads SET updated_at = UTC_TIMESTAMP(3) WHERE customer_id = ? AND id = ?', [customer.id, t.id]);
    await markRead(customer.id, t.id, me.id, ins.insertId);
    if (t.kind !== 'business') {
      await notify(null, me, { userIds: memberIds(t), except: me.id, kind: 'chat', text: `${whoOf(me)}${t.kind === 'group' ? ' in ' + t.name : ''}: ${text.slice(0, 120)}`, link: 'chat:' + t.id });
    }
    return res.json({ message: msgOut(m) });
  }
  if (a === 'delete') {
    const m = (await q('SELECT * FROM cf_crm_chat_messages WHERE customer_id = ? AND id = ?', [customer.id, Number(b.id) || 0]))[0];
    if (!m) return res.status(404).json({ error: 'Message not found.' });
    const t = await getThread(customer.id, m.thread_id);
    if (!canSee(t, me)) return res.status(404).json({ error: 'Message not found.' });
    if (Number(m.user_id) !== me.id && !me.can.settings) return res.status(403).json({ error: 'You can only delete your own messages.' });
    await q("UPDATE cf_crm_chat_messages SET deleted_at = UTC_TIMESTAMP(3), deleted_by = ?, text = '' WHERE id = ?", [me.id, m.id]);
    return res.json({ ok: true });
  }
  if (a === 'dm') {
    const [other] = await activeMembers(customer.id, [Number(b.userId) || 0]);
    if (!other || other === me.id) return res.status(400).json({ error: 'Pick someone else to chat with.' });
    const pair = [me.id, other].sort((x, y) => x - y);
    const id = 'dm:' + crypto.createHash('sha1').update(pair.join(':')).digest('hex').slice(0, 20);
    await q("INSERT IGNORE INTO cf_crm_chat_threads (customer_id, id, kind, name, members, created_by) VALUES (?, ?, 'direct', '', ?, ?)", [customer.id, id, JSON.stringify(pair), me.id]);
    return res.json({ thread: id });
  }
  if (a === 'group' || a === 'groupEdit') {
    const name = String(b.name || '').trim().slice(0, 80);
    if (!name) return res.status(400).json({ error: 'Name the group.' });
    const valid = await activeMembers(customer.id, (Array.isArray(b.members) ? b.members : []).map(Number).filter(Boolean).slice(0, 200));
    const members = [...new Set([me.id, ...valid])];
    if (a === 'group') {
      const id = 'g:' + crypto.randomBytes(8).toString('base64url');
      await q("INSERT INTO cf_crm_chat_threads (customer_id, id, kind, name, members, created_by, updated_at) VALUES (?, ?, 'group', ?, ?, ?, UTC_TIMESTAMP(3))", [customer.id, id, name, JSON.stringify(members), me.id]);
      await notify(null, me, { userIds: members, except: me.id, kind: 'chat', text: `${whoOf(me)} added you to the chat group ${name}`, link: 'chat:' + id });
      return res.json({ thread: id });
    }
    const t = await getThread(customer.id, b.thread);
    if (!t || t.kind !== 'group') return res.status(404).json({ error: 'Group not found.' });
    if (Number(t.created_by) !== me.id && !me.can.settings) return res.status(403).json({ error: 'Only the person who created the group, or an owner, can change it.' });
    const keep = members.includes(Number(t.created_by)) || !t.created_by ? members : [...members, Number(t.created_by)];
    await q('UPDATE cf_crm_chat_threads SET name = ?, members = ? WHERE customer_id = ? AND id = ?', [name, JSON.stringify(keep), customer.id, t.id]);
    return res.json({ thread: t.id });
  }
  res.status(404).json({ error: 'Unknown action' });
}));

/* --------------------------------------------------------- notifications */
// GET [?before=id]: newest 60, whether there are more, the unread count
// POST {all:true} | {ids:[...]} mark read; {clear:true} delete mine
const NPAGE = 60;
router.get('/notify', ...crm(), handle(async (req, res, { customer, me }) => {
  const before = Number(req.query.before) || null;
  const rows = await q(
    `SELECT id, kind, text, link, at, read_at FROM cf_crm_notifications
      WHERE customer_id = ? AND user_id = ? ${before ? 'AND id < ?' : ''} ORDER BY id DESC LIMIT ${NPAGE + 1}`,
    before ? [customer.id, me.id, before] : [customer.id, me.id]);
  const [n] = await q('SELECT COUNT(*) AS n FROM cf_crm_notifications WHERE customer_id = ? AND user_id = ? AND read_at IS NULL', [customer.id, me.id]);
  res.json({
    items: rows.slice(0, NPAGE).map((x) => ({ id: Number(x.id), kind: x.kind, text: x.text, link: x.link, at: x.at, read: !!x.read_at })),
    more: rows.length > NPAGE,
    unread: Number(n.n) || 0,
  });
}));

router.post('/notify', ...crm(), handle(async (req, res, { customer, me }) => {
  const b = req.body || {};
  if (b.clear) await q('DELETE FROM cf_crm_notifications WHERE customer_id = ? AND user_id = ?', [customer.id, me.id]);
  else if (b.all) await q('UPDATE cf_crm_notifications SET read_at = UTC_TIMESTAMP(3) WHERE customer_id = ? AND user_id = ? AND read_at IS NULL', [customer.id, me.id]);
  else if (Array.isArray(b.ids) && b.ids.length) {
    const ids = b.ids.map(Number).filter(Boolean).slice(0, 500);
    if (ids.length) await q(`UPDATE cf_crm_notifications SET read_at = UTC_TIMESTAMP(3) WHERE customer_id = ? AND user_id = ? AND id IN (${ids.map(() => '?').join(',')})`, [customer.id, me.id, ...ids]);
  }
  res.json({ ok: true });
}));

/* ------------------------------------------------------- push alerts */
// GET /push/key — the server's public key, for the browser to subscribe with
router.get('/push/key', ...crm(), handle(async (req, res) => {
  res.json({ key: (await vapidKeys()).publicKey });
}));
// POST /push/subscribe { subscription } — this device gets this login's alerts
router.post('/push/subscribe', ...crm(), handle(async (req, res, { customer, me }) => {
  const ok = await saveSubscription(customer.id, me.id, req.body && req.body.subscription);
  if (!ok) return res.status(400).json({ error: 'That is not a valid alert subscription.' });
  res.json({ ok: true });
}));
// POST /push/unsubscribe { endpoint } — on sign-out
router.post('/push/unsubscribe', ...crm({ pending: true }), handle(async (req, res, { customer, me }) => {
  if (req.body && req.body.endpoint) await dropSubscription(customer.id, me.id, req.body.endpoint);
  res.json({ ok: true });
}));
// POST /push/test — "send me a test alert"
router.post('/push/test', ...crm(), handle(async (req, res, { customer, me }) => {
  const sent = await sendPush(customer.id, [me.id], { text: 'Alerts are working on this device.', link: 'home', tag: 'test' });
  res.json({ sent });
}));

export default router;
