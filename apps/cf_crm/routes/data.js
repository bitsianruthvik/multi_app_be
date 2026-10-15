import { Router } from 'express';
import { q, tx, audit, notify, whoOf, parseJson } from '../lib/db.js';
import { crm, handle, publicMember } from '../lib/context.js';
import { canBiz } from '../lib/roles.js';

/**
 * THE NETWORK'S DATA: the browser keeps a full local copy and this router is
 * how it reads changes (GET /sync) and sends its own (POST /records).
 * A port of the original api/sync.js and api/records.js; the rules are the
 * same, written for MySQL / TiDB.
 */
const router = Router({ mergeParams: true });

const PAGE = 2500;
export const TYPES = new Set(['people', 'companies', 'chits', 're', 'leads', 'interactions', 'campaigns', 'lists', 'groups', 'blacklist', 'comments']);
const CHILD = new Set(['chits', 're', 'leads', 'interactions', 'comments']);
const ADMIN_DELETE = new Set(['people', 'companies', 'groups', 'blacklist']);
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_OPS = 1500;
// the sync cursor is the DATETIME(6) as text, so no microseconds are lost
const CURSOR = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?$/;
const TS = "DATE_FORMAT(%s, '%Y-%m-%d %H:%i:%s.%f')";

export const normPhone = (x) => {
  let d = String(x || '').replace(/\D/g, '');
  if (d.length > 10 && d.startsWith('91')) d = d.slice(2);
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return d;
};

/** The columns copied out of `data` so the visibility rules can be SQL. */
export function sideColumns(type, d) {
  if (!d) return { person_id: null, lead_id: null, owner_in_charge: null, is_private: 0, business: null };
  return {
    person_id: type !== 'people' && d.personId ? String(d.personId).slice(0, 64) : null,
    lead_id: type === 'comments' && d.leadId ? String(d.leadId).slice(0, 64) : null,
    owner_in_charge: type === 'people' ? String(d.ownerInCharge || '').slice(0, 120) : null,
    is_private: type === 'people' && d.private ? 1 : 0,
    business: type === 'leads' ? String(d.business || d.line || '').slice(0, 40) || null : null,
  };
}

/* ------------------------------------------------------------------ sync */
// GET /sync?u=<cursor>&t=<type>&i=<id>&overlap=1&full=1
// Records changed after the cursor, in pages, filtered to what this login may
// see: a private person only to the owner in charge, a manager only their own
// people; leads / chits / property of other businesses are hidden. Hidden
// records come back as deletions so they disappear on the next sync.
router.get('/sync', ...crm(), handle(async (req, res, { customer, me, cfg }) => {
  const p = req.query;
  const full = p.full === '1';
  const scoped = !me.can.all;
  const biz = me.businesses || [];
  const args = [customer.id, me.owner, scoped ? 1 : 0, me.owner, customer.id];

  const bizIn = biz.map(() => '?').join(',');
  const leadBizClause = biz.length ? `COALESCE(business, '') NOT IN (${bizIn})` : 'FALSE';
  if (biz.length) args.push(...biz);

  let where = '';
  const whereArgs = [];
  if (p.u) {
    if (!CURSOR.test(String(p.u))) return res.status(400).json({ error: 'Bad sync cursor.' });
    if (p.overlap === '1') {
      // re-read the last few seconds so a write committed late is never missed
      where = 'AND r.updated_at > (CAST(? AS DATETIME(6)) - INTERVAL 15 SECOND)';
      whereArgs.push(p.u);
    } else {
      const t = String(p.t || ''), i = String(p.i || '');
      where = 'AND (r.updated_at > ? OR (r.updated_at = ? AND (r.type > ? OR (r.type = ? AND r.id > ?))))';
      whereArgs.push(p.u, p.u, t, t, i);
    }
  }
  const hideTypes = [];
  if (biz.length && !biz.includes('chit')) hideTypes.push('chits');
  if (biz.length && !biz.includes('re')) hideTypes.push('re');

  const sql = `
    WITH hidden AS (
      SELECT id FROM cf_crm_records
       WHERE customer_id = ? AND type = 'people' AND deleted = 0 AND (
         (is_private = 1 AND COALESCE(owner_in_charge, '') NOT IN ('', ?))
         OR (? = 1 AND COALESCE(owner_in_charge, '') <> ?))
    ),
    hidden_leads AS (
      SELECT id FROM cf_crm_records
       WHERE customer_id = ? AND type = 'leads' AND deleted = 0 AND ${leadBizClause}
    )
    SELECT x.* FROM (
      SELECT r.type, r.id, ${TS.replace('%s', 'r.updated_at')} AS u, r.deleted, r.data,
        ((r.type = 'people' AND r.id IN (SELECT id FROM hidden))
         OR (r.person_id IS NOT NULL AND r.person_id IN (SELECT id FROM hidden))
         OR (r.type = 'leads' AND r.id IN (SELECT id FROM hidden_leads))
         OR (r.type = 'comments' AND r.lead_id IN (SELECT id FROM hidden_leads))
         ${hideTypes.length ? `OR r.type IN (${hideTypes.map(() => '?').join(',')})` : ''}) AS hid
        FROM cf_crm_records r
       WHERE r.customer_id = ? ${where}
    ) x
    ${full ? 'WHERE x.deleted = 0 AND x.hid = 0' : ''}
    ORDER BY x.u, x.type, x.id
    LIMIT ${PAGE}`;
  const rows = await q(sql, [...args, ...hideTypes, customer.id, ...whereArgs]);

  const out = {
    rows: rows.map((x) => (x.deleted || x.hid ? { t: x.type, i: x.id, x: 1 } : { t: x.type, i: x.id, d: parseJson(x.data, {}) })),
    more: rows.length === PAGE,
  };
  const last = rows[rows.length - 1];
  if (last) out.cursor = { u: last.u, t: last.type, i: last.id };
  else if (p.u) out.cursor = { u: String(p.u), t: String(p.t || ''), i: String(p.i || '') };
  if (!p.u || p.overlap === '1') {
    out.config = Object.keys(cfg).length ? cfg : null;
    out.me = publicMember(me);
    out.brand = customer.brand || {};
    out.customer = { slug: customer.slug, name: customer.name };
    out.serverTime = new Date().toISOString();
  }
  // a fresh load with nothing yet: start the cursor a minute ago so polling works
  if (!out.cursor) {
    const [now] = await q(`SELECT ${TS.replace('%s', 'UTC_TIMESTAMP(6) - INTERVAL 60 SECOND')} AS u`);
    out.cursor = { u: now.u, t: '', i: '' };
  }
  res.json(out);
}));

/* --------------------------------------------------------------- records */
function label(t, d) {
  if (!d) return '';
  if (t === 'people' || t === 'companies' || t === 'campaigns' || t === 'lists' || t === 'groups') return d.name || '';
  if (t === 'chits') return `chit ${d.group || ''} ${d.ticketNo || ''}`.trim();
  if (t === 're') return `${d.project || ''} ${d.unit || ''}`.trim();
  if (t === 'leads') return `${d.business || d.line || ''} lead, ${d.stage || ''}`;
  if (t === 'interactions') return d.type || '';
  if (t === 'comments') return String(d.text || '').slice(0, 80);
  if (t === 'blacklist') return `${d.kind}: ${d.value}`;
  return '';
}

/** Insert or replace a batch of records (and keep cf_crm_phones in step). */
export async function upsertRecords(c, customerId, userId, ops) {
  if (!ops.length) return;
  for (let k = 0; k < ops.length; k += 300) {
    const part = ops.slice(k, k + 300);
    const vals = [];
    part.forEach((o) => {
      const s = sideColumns(o.t, o.x ? null : o.d);
      vals.push(customerId, o.t, o.i, o.x ? null : JSON.stringify(o.d), o.x ? 1 : 0, s.person_id, s.lead_id, s.owner_in_charge, s.is_private, s.business, userId);
    });
    await c.q(
      `INSERT INTO cf_crm_records (customer_id, type, id, data, deleted, person_id, lead_id, owner_in_charge, is_private, business, updated_at, updated_by)
       VALUES ${part.map(() => '(?,?,?,?,?,?,?,?,?,?,UTC_TIMESTAMP(6),?)').join(',')}
       ON DUPLICATE KEY UPDATE data = VALUES(data), deleted = VALUES(deleted), person_id = VALUES(person_id), lead_id = VALUES(lead_id),
         owner_in_charge = VALUES(owner_in_charge), is_private = VALUES(is_private), business = VALUES(business),
         updated_at = VALUES(updated_at), updated_by = VALUES(updated_by)`, vals);
  }
  const people = ops.filter((o) => o.t === 'people');
  if (people.length) {
    const ids = people.map((o) => o.i);
    await c.q(`DELETE FROM cf_crm_phones WHERE customer_id = ? AND person_id IN (${ids.map(() => '?').join(',')})`, [customerId, ...ids]);
    const rows = [];
    people.forEach((o) => {
      if (o.x || !Array.isArray(o.d.mobiles)) return;
      [...new Set(o.d.mobiles.map(normPhone).filter((m) => m && m.length <= 20))].forEach((m) => rows.push([customerId, o.i, m]));
    });
    for (let k = 0; k < rows.length; k += 500) {
      const part = rows.slice(k, k + 500);
      await c.q(`INSERT IGNORE INTO cf_crm_phones (customer_id, person_id, phone) VALUES ${part.map(() => '(?,?,?)').join(',')}`, part.flat());
    }
  }
}

// POST /records { ops: [{ t, i, d } | { t, i, x: 1 }], note, quiet }
// Saves a batch, checks the login's role for each record, writes the audit
// log and the notifications. Records that are not allowed come back in
// `rejected` and the app undoes them on screen.
router.post('/records', ...crm(), handle(async (req, res, { customer, me }) => {
  const role = me.can;
  if (!role.write) return res.status(403).json({ error: 'Your account is read-only.' });
  const b = req.body || {};
  const ops = Array.isArray(b.ops) ? b.ops : [];
  if (!ops.length) return res.json({ saved: 0, rejected: [] });
  if (ops.length > MAX_OPS) return res.status(413).json({ error: 'Too many changes in one request.' });
  const seen = new Set();
  for (const o of ops) {
    if (!o || !TYPES.has(o.t) || !ID.test(String(o.i || ''))) return res.status(400).json({ error: 'Invalid record.' });
    if (!o.x && (!o.d || typeof o.d !== 'object' || Array.isArray(o.d))) return res.status(400).json({ error: 'Invalid record.' });
    if (!o.x && JSON.stringify(o.d).length > 900000) return res.status(413).json({ error: 'A record is too large.' });
    const k = o.t + '/' + o.i;
    if (seen.has(k)) return res.status(400).json({ error: 'The same record is in the batch twice.' });
    seen.add(k);
  }
  const myId = String(me.id);

  const result = await tx(async (c) => {
    const cur = await c.q(
      `SELECT type, id, data, deleted FROM cf_crm_records WHERE customer_id = ? AND (type, id) IN (${ops.map(() => '(?,?)').join(',')}) FOR UPDATE`,
      [customer.id, ...ops.flatMap((o) => [o.t, o.i])]);
    const existing = new Map(cur.map((r) => [r.type + '/' + r.id, { ...r, data: parseJson(r.data, null) }]));
    const exOf = (o) => existing.get(o.t + '/' + o.i);

    // managers may only touch people assigned to them (and those people's records)
    let personOwner = new Map();
    if (!role.all) {
      const pids = [...new Set(ops.filter((o) => CHILD.has(o.t)).map((o) => (o.d && o.d.personId) || exOf(o)?.data?.personId).filter(Boolean))];
      if (pids.length) {
        const pr = await c.q(
          `SELECT id, owner_in_charge FROM cf_crm_records WHERE customer_id = ? AND type = 'people' AND id IN (${pids.map(() => '?').join(',')})`,
          [customer.id, ...pids]);
        personOwner = new Map(pr.map((r) => [r.id, r.owner_in_charge || '']));
      }
    }

    // every rule but the mobile one, record by record
    const whyOf = new Map();
    for (const o of ops) {
      const ex = exOf(o);
      const exData = ex && !ex.deleted ? ex.data : null;
      let why = '';
      if (o.t === 'campaigns' && !role.campaigns) why = 'campaigns';
      else if (o.x && ADMIN_DELETE.has(o.t) && !role.delete) why = 'delete';
      else if (o.t === 'comments' && exData && String(exData.byId || '') !== myId && !role.settings) why = 'comment';
      else if (o.t === 'campaigns' && o.d && o.d.status === 'Sent' && !(exData && exData.status === 'Sent') && !role.send) why = 'send';
      else if (!role.all && o.t === 'people') {
        if (exData && (exData.ownerInCharge || '') !== me.owner) why = 'scope';
        if (o.d && (o.d.ownerInCharge || '') !== me.owner) why = 'scope';
      } else if (!role.all && CHILD.has(o.t)) {
        const pid = (o.d && o.d.personId) || (exData && exData.personId);
        if (pid && personOwner.has(pid) && personOwner.get(pid) !== me.owner) why = 'scope';
      }
      // business access: leads, chits and property belong to one of my businesses
      if (!why && o.t === 'leads') {
        const bz = (o.d && (o.d.business || o.d.line)) || (exData && (exData.business || exData.line));
        const was = exData && (exData.business || exData.line);
        if (!canBiz(me, bz) || (was && !canBiz(me, was))) why = 'business';
      }
      if (!why && (o.t === 'chits' || o.t === 're') && !canBiz(me, o.t === 'chits' ? 'chit' : 're')) why = 'business';
      // a private person can only be changed by the owner in charge
      if (!why && o.t === 'people' && exData && exData.private && exData.ownerInCharge && exData.ownerInCharge !== me.owner) why = 'private';
      whyOf.set(o, why);
    }

    // a mobile number belongs to one person: numbers newly added to someone
    // must not be on anyone else (owners may override). A person deleted in
    // the same batch frees their numbers, but only if that delete is allowed.
    if (!role.settings) {
      const deleting = new Set(ops.filter((o) => o.x && o.t === 'people' && !whyOf.get(o)).map((o) => o.i));
      for (const o of ops) {
        if (o.x || o.t !== 'people' || whyOf.get(o) || !Array.isArray(o.d.mobiles)) continue;
        const ex = exOf(o);
        const had = new Set(((ex && !ex.deleted && ex.data && ex.data.mobiles) || []).map(normPhone));
        const added = [...new Set(o.d.mobiles.map(normPhone).filter((m) => m && !had.has(m)))];
        if (!added.length) continue;
        const r = await c.q(
          `SELECT person_id FROM cf_crm_phones WHERE customer_id = ? AND person_id <> ? AND phone IN (${added.map(() => '?').join(',')}) LIMIT 5`,
          [customer.id, o.i, ...added]);
        if (r.some((row) => !deleting.has(row.person_id))) whyOf.set(o, 'mobile');
      }
    }

    const rejected = [];
    const ok = [];
    for (const o of ops) {
      const why = whyOf.get(o);
      if (why) rejected.push({ t: o.t, i: o.i, why });
      else ok.push(o);
    }

    // comments always carry the real author
    ok.forEach((o) => {
      if (o.t === 'comments' && o.d) {
        const ex = exOf(o);
        o.d.byId = ex && !ex.deleted && ex.data ? ex.data.byId : myId;
      }
    });
    if (ok.length) {
      await upsertRecords(c, customer.id, me.id, ok);
      const note = String(b.note || '').slice(0, 200);
      if (ok.length <= 15 && !b.quiet) {
        for (const o of ok) {
          const ex = exOf(o);
          const action = o.x ? 'delete' : (!ex || ex.deleted) ? 'create' : 'update';
          await audit(me, action, o.t, o.i, note || label(o.t, o.x ? ex && ex.data : o.d), c);
        }
      } else if (!b.quiet || note) {
        const counts = {};
        ok.forEach((o) => { const k = (o.x ? 'deleted ' : 'saved ') + o.t; counts[k] = (counts[k] || 0) + 1; });
        await audit(me, 'bulk', [...new Set(ok.map((o) => o.t))].join(', '), '',
          `${note ? note + ': ' : ''}${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')}`, c);
      }
    }

    // notifications: assignments and activity on someone else's records
    const who = whoOf(me);
    for (const o of ok) {
      if (o.x || !o.d) continue;
      const ex = exOf(o);
      const old = ex && !ex.deleted ? ex.data : null;
      if (o.t === 'leads') {
        if (o.d.owner && (!old || old.owner !== o.d.owner)) {
          await notify(c, me, { owners: [o.d.owner], except: me.id, kind: 'assign', text: `${who} assigned you a lead${o.d._title ? ': ' + o.d._title : ''}`, link: 'lead:' + o.i, business: o.d.business || o.d.line || null });
        }
      } else if (o.t === 'companies') {
        const added = (Array.isArray(o.d.owners) ? o.d.owners : []).filter((x) => !(old && (old.owners || []).includes(x)));
        if (added.length) await notify(c, me, { owners: added, except: me.id, kind: 'assign', text: `${who} made you an owner of ${o.d.name || 'a company'}`, link: 'company:' + o.i });
      } else if (o.t === 'people') {
        if (o.d.ownerInCharge && (!old || old.ownerInCharge !== o.d.ownerInCharge)) {
          await notify(c, me, { owners: [o.d.ownerInCharge], except: me.id, kind: 'assign', text: `${who} put you in charge of ${o.d.name || 'a person'}`, link: 'person:' + o.i });
        }
      } else if (o.t === 'comments' && !old && o.d.leadId) {
        const lr = await c.q("SELECT data FROM cf_crm_records WHERE customer_id = ? AND type = 'leads' AND id = ? AND deleted = 0", [customer.id, String(o.d.leadId)]);
        const lead = lr[0] && parseJson(lr[0].data, null);
        if (lead && lead.owner) {
          await notify(c, me, {
            owners: [lead.owner], except: me.id, kind: o.d.kind === 'stage' ? 'stage' : 'comment',
            text: o.d.kind === 'stage' ? `${who} moved ${lead._title || 'your lead'} to ${o.d.text}` : `${who} commented on ${lead._title || 'your lead'}: ${String(o.d.text || '').slice(0, 120)}`,
            link: 'lead:' + o.d.leadId, business: lead.business || lead.line || null,
          });
        }
      }
    }
    return { saved: ok.length, rejected };
  });
  res.json(result);
}));

export default router;
