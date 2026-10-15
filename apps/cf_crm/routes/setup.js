import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { q, tx, audit, parseJson, CrmError } from '../lib/db.js';
import { crm, handle, publicMember, forgetConfig, customerOfCompany } from '../lib/context.js';
import { roleExists } from '../lib/roles.js';
import { sanitizeBrand } from '../lib/brand.js';

/**
 * Setup: the shared config (owners only), branding (owners only), the team
 * (owners only) and the signed-in login's own account.
 */
const router = Router({ mergeParams: true });

/* ---------------------------------------------------------------- config */
async function renameOwner(c, customerId, from, to) {
  const n = { users: 0, records: 0 };
  n.users += (await c.q('UPDATE cf_crm_members SET owner = ? WHERE customer_id = ? AND owner = ?', [to, customerId, from])).affectedRows;
  const one = async (type, key) => {
    const path = '$.' + key;
    const r = await c.q(
      `UPDATE cf_crm_records SET data = JSON_SET(data, '${path}', ?), updated_at = UTC_TIMESTAMP(6)
         ${type === 'people' && key === 'ownerInCharge' ? ', owner_in_charge = ?' : ''}
       WHERE customer_id = ? AND type = ? AND deleted = 0 AND JSON_UNQUOTE(JSON_EXTRACT(data, '${path}')) = ?`,
      type === 'people' && key === 'ownerInCharge' ? [to, to, customerId, type, from] : [to, customerId, type, from]);
    n.records += r.affectedRows;
  };
  await one('leads', 'owner');
  await one('people', 'ownerInCharge');
  await one('people', 'sourceOwner');
  await one('comments', 'by');
  await one('interactions', 'by');
  await one('campaigns', 'owner');
  const cos = await c.q(
    `SELECT id, data FROM cf_crm_records WHERE customer_id = ? AND type = 'companies' AND deleted = 0
        AND JSON_CONTAINS(JSON_EXTRACT(data, '$.owners'), JSON_QUOTE(?))`, [customerId, from]);
  for (const row of cos) {
    const d = parseJson(row.data, {});
    d.owners = [...new Set((d.owners || []).map((x) => (x === from ? to : x)))];
    await c.q("UPDATE cf_crm_records SET data = ?, updated_at = UTC_TIMESTAMP(6) WHERE customer_id = ? AND type = 'companies' AND id = ?", [JSON.stringify(d), customerId, row.id]);
    n.records += 1;
  }
  return n;
}

// PUT /config { config, changed: [keys], renameOwners: [[from, to]] }
router.put('/config', ...crm({ settings: true }), handle(async (req, res, { customer, me }) => {
  const b = req.body || {};
  const renames = Array.isArray(b.renameOwners)
    ? b.renameOwners.filter((r) => Array.isArray(r) && r[0] && r[1] && r[0] !== r[1]).map((r) => [String(r[0]).slice(0, 120), String(r[1]).slice(0, 120)])
    : [];
  if (!b.config && !renames.length) return res.status(400).json({ error: 'Missing settings.' });
  if (b.config && (typeof b.config !== 'object' || Array.isArray(b.config))) return res.status(400).json({ error: 'Missing settings.' });
  const s = b.config ? JSON.stringify(b.config) : null;
  if (s && s.length > 200000) return res.status(400).json({ error: 'Settings are too large.' });
  const done = await tx(async (c) => {
    if (s) {
      await c.q(
        `INSERT INTO cf_crm_settings (customer_id, k, value) VALUES (?, 'config', ?)
         ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = CURRENT_TIMESTAMP`, [customer.id, s]);
    }
    const out = [];
    for (const [from, to] of renames) {
      const n = await renameOwner(c, customer.id, from, to);
      out.push({ from, to, ...n });
      await audit(me, 'update', 'owners', '', `renamed owner ${from} to ${to}: ${n.records} records, ${n.users} team accounts`, c);
    }
    if (s) await audit(me, 'update', 'settings', '', (Array.isArray(b.changed) ? b.changed : []).join(', '), c);
    return out;
  });
  forgetConfig(customer.id);
  res.json({ ok: true, renamed: done });
}));

/* ----------------------------------------------------------------- brand */
// The customer's colours, logo and app name: every company of the customer
// sees the same. GET is open to any member (the app paints itself with it).
router.get('/brand', ...crm(), handle(async (req, res, { customer }) => {
  res.json({ brand: customer.brand || {}, customer: { slug: customer.slug, name: customer.name } });
}));

// The sign-in page's look, before anyone is signed in: name, logo and the
// main colours only — nothing else about the customer.
router.get('/public-brand', handle(async (req, res) => {
  if (!req.company || !req.appCtx) return res.status(404).json({ error: 'Not found.' });
  const c = await customerOfCompany(Number(req.company.id));
  const b = (c && c.brand) || {};
  res.setHeader('cache-control', 'public, max-age=300');
  res.json({ brand: { appName: b.appName || '', logo: b.logo || '', colors: { accent: b.colors?.accent || '', accent2: b.colors?.accent2 || '', bg: b.colors?.bg || '' } } });
}));

router.put('/brand',...crm({ settings: true }), handle(async (req, res, { customer, me }) => {
  const brand = sanitizeBrand(req.body && req.body.brand);
  await q('UPDATE cf_crm_customers SET brand = ? WHERE id = ?', [JSON.stringify(brand), customer.id]);
  await audit(me, 'update', 'branding', '', 'colours / logo / name');
  res.json({ ok: true, brand });
}));

/* ------------------------------------------------------------------ team */
const PW_MIN = 8;

async function customerCompanies(customerId) {
  return q(
    `SELECT co.id, co.name, co.slug, cc.business_id, a.id AS app_id
       FROM cf_crm_customer_companies cc
       JOIN companies co ON co.id = cc.company_id AND co.deleted_at IS NULL
       LEFT JOIN apps a ON a.company_id = co.id AND a.slug = 'cf_crm' AND a.deleted_at IS NULL
      WHERE cc.customer_id = ? ORDER BY co.id`, [customerId]);
}

async function listMembers(customerId) {
  const rows = await q(
    `SELECT m.*, u.email, u.name AS user_name, u.company_id
       FROM cf_crm_members m JOIN users u ON u.id = m.user_id AND u.deleted_at IS NULL
      WHERE m.customer_id = ? ORDER BY m.created_at, m.user_id`, [customerId]);
  return rows.map((r) => publicMember({
    id: Number(r.user_id), email: r.email, name: r.user_name, role: r.role, owner: r.owner, active: !!r.active,
    businesses: parseJson(r.businesses, []), perms: parseJson(r.perms, {}), lastSeen: r.last_seen, createdAt: r.created_at, companyId: Number(r.company_id),
  }));
}

/** The platform role a team member added here gets in their company: `staff`, made if missing. */
async function staffRole(c, companyId) {
  const r = await c.q("SELECT id FROM roles WHERE company_id = ? AND name = 'staff' AND deleted_at IS NULL LIMIT 1", [companyId]);
  if (r[0]) return r[0].id;
  const ins = await c.q("INSERT INTO roles (name, company_id) VALUES ('staff', ?)", [companyId]);
  return ins.insertId;
}

router.get('/users', ...crm({ settings: true }), handle(async (req, res, { customer }) => {
  const [users, companies] = await Promise.all([listMembers(customer.id), customerCompanies(customer.id)]);
  res.json({ users, companies: companies.map((c) => ({ id: c.id, name: c.name, slug: c.slug, business: c.business_id })) });
}));

// POST /users { name, email, role, owner, password, companyId }
// Makes a platform login in one of the customer's companies with access to
// this app, or gives an existing login of those companies access.
router.post('/users', ...crm({ settings: true }), handle(async (req, res, { customer, me, cfg }) => {
  const b = req.body || {};
  const email = String(b.email || '').trim().toLowerCase();
  const name = String(b.name || '').trim().slice(0, 120);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (!name) return res.status(400).json({ error: 'Enter their name.' });
  if (!roleExists(b.role, cfg.roles)) return res.status(400).json({ error: 'Pick a role.' });
  const companies = await customerCompanies(customer.id);
  const company = companies.find((c) => c.id === Number(b.companyId)) || companies.find((c) => c.id === me.companyId);
  if (!company || !company.app_id) return res.status(400).json({ error: 'That company does not have this app.' });
  const owner = String(b.owner || '').slice(0, 120);
  const biz = company.business_id && b.role !== 'admin' ? [company.business_id] : [];

  const out = await tx(async (c) => {
    const ex = (await c.q('SELECT id, company_id, deleted_at FROM users WHERE email = ? LIMIT 1', [email]))[0];
    let userId;
    if (ex) {
      if (ex.deleted_at || !companies.some((co) => co.id === Number(ex.company_id))) throw new CrmError(409, 'Someone with that email already has an account elsewhere.');
      const already = await c.q('SELECT 1 FROM cf_crm_members WHERE customer_id = ? AND user_id = ?', [customer.id, ex.id]);
      if (already.length) throw new CrmError(409, 'That person is already on the team.');
      userId = ex.id;
      const appId = companies.find((co) => co.id === Number(ex.company_id))?.app_id;
      if (!appId) throw new CrmError(400, 'Their company does not have this app.');
      const hasAccess = await c.q('SELECT id FROM app_user_access WHERE user_id = ? AND app_id = ? AND deleted_at IS NULL', [userId, appId]);
      if (!hasAccess.length) {
        const roleId = await staffRole(c, Number(ex.company_id));
        await c.q(
          `INSERT INTO app_user_access (user_id, app_id, role_id, company_id) VALUES (?,?,?,?)
           ON DUPLICATE KEY UPDATE role_id = VALUES(role_id), deleted_at = NULL`, [userId, appId, roleId, Number(ex.company_id)]);
      }
    } else {
      if (!b.password || String(b.password).length < PW_MIN) throw new CrmError(400, `Set a temporary password of at least ${PW_MIN} characters.`);
      const roleId = await staffRole(c, company.id);
      const hash = await bcrypt.hash(String(b.password), 10);
      const ins = await c.q('INSERT INTO users (name, email, password, role_id, company_id) VALUES (?,?,?,?,?)', [name, email, hash, roleId, company.id]);
      userId = ins.insertId;
      await c.q('INSERT INTO app_user_access (user_id, app_id, role_id, company_id) VALUES (?,?,?,?)', [userId, company.app_id, roleId, company.id]);
    }
    await c.q(
      `INSERT INTO cf_crm_members (customer_id, user_id, role, owner, businesses, perms, active) VALUES (?,?,?,?,?, '{}', 1)`,
      [customer.id, userId, b.role, owner, JSON.stringify(biz)]);
    await audit(me, 'add user', 'team', String(userId), `${email} as ${b.role} (${company.name})`, c);
    return { userId, existing: !!ex };
  });
  const users = await listMembers(customer.id);
  const user = users.find((u) => u.id === String(out.userId));
  res.json({ user, existing: out.existing, loginUrl: `/${company.slug}/cf_crm/login` });
}));

// PATCH /users { id, role?, owner?, name?, email?, active?, businesses?, perms?, password? }
router.patch('/users', ...crm({ settings: true }), handle(async (req, res, { customer, me, cfg }) => {
  const b = req.body || {};
  const id = Number(b.id);
  const cur = (await q(
    `SELECT m.*, u.email, u.name AS user_name FROM cf_crm_members m JOIN users u ON u.id = m.user_id
      WHERE m.customer_id = ? AND m.user_id = ?`, [customer.id, id]))[0];
  if (!cur) return res.status(404).json({ error: 'Team member not found.' });
  const next = { role: cur.role, owner: cur.owner, active: !!cur.active, businesses: parseJson(cur.businesses, []), perms: parseJson(cur.perms, {}), name: cur.user_name, email: cur.email };
  if (b.role !== undefined) { if (!roleExists(b.role, cfg.roles)) return res.status(400).json({ error: 'Unknown role.' }); next.role = b.role; }
  if (b.owner !== undefined) next.owner = String(b.owner).slice(0, 120);
  if (b.name !== undefined) { next.name = String(b.name).trim().slice(0, 120); if (!next.name) return res.status(400).json({ error: 'Enter a name.' }); }
  if (b.email !== undefined) {
    const em = String(b.email).trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) return res.status(400).json({ error: 'Enter a valid email address.' });
    if (em !== cur.email && (await q('SELECT 1 FROM users WHERE email = ? AND id <> ?', [em, id])).length) return res.status(400).json({ error: 'Another account already uses this email.' });
    next.email = em;
  }
  if (b.active !== undefined) next.active = !!b.active;
  if (b.businesses !== undefined) next.businesses = Array.isArray(b.businesses) ? b.businesses.map(String).slice(0, 50) : [];
  if (b.perms !== undefined) { const pm = {}; ['export', 'campaigns', 'send'].forEach((k) => { if (b.perms && typeof b.perms[k] === 'boolean') pm[k] = b.perms[k]; }); next.perms = pm; }
  if (cur.role === 'admin' && cur.active && (next.role !== 'admin' || !next.active)) {
    const n = (await q("SELECT COUNT(*) AS n FROM cf_crm_members WHERE customer_id = ? AND role = 'admin' AND active = 1 AND user_id <> ?", [customer.id, id]))[0].n;
    if (!Number(n)) return res.status(400).json({ error: 'Keep at least one active owner account.' });
  }
  let hash = null;
  if (b.password) {
    if (String(b.password).length < PW_MIN) return res.status(400).json({ error: `Use at least ${PW_MIN} characters.` });
    hash = await bcrypt.hash(String(b.password), 10);
  }
  await tx(async (c) => {
    await c.q('UPDATE cf_crm_members SET role = ?, owner = ?, active = ?, businesses = ?, perms = ? WHERE customer_id = ? AND user_id = ?',
      [next.role, next.owner, next.active ? 1 : 0, JSON.stringify(next.businesses), JSON.stringify(next.perms), customer.id, id]);
    if (next.name !== cur.user_name || next.email !== cur.email || hash) {
      await c.q(`UPDATE users SET name = ?, email = ?${hash ? ', password = ?' : ''} WHERE id = ?`, hash ? [next.name, next.email, hash, id] : [next.name, next.email, id]);
    }
    const before = { role: cur.role, owner: cur.owner, active: !!cur.active, name: cur.user_name, email: cur.email };
    const changes = Object.keys(before).filter((k) => b[k] !== undefined && next[k] !== before[k]).map((k) => `${k}: ${next[k]}`);
    if (b.password) changes.push('password reset');
    if (b.businesses !== undefined) changes.push('business access: ' + (next.businesses.join(', ') || 'all'));
    if (b.perms !== undefined) changes.push('permissions: ' + JSON.stringify(next.perms));
    await audit(me, 'update user', 'team', String(id), `${cur.email} ${changes.join(', ')}`, c);
  });
  const user = (await listMembers(customer.id)).find((u) => u.id === String(id));
  res.json({ user });
}));

/* --------------------------------------------------------------- account */
router.get('/me', ...crm(), handle(async (req, res, { customer, me }) => {
  res.json({ user: publicMember(me), brand: customer.brand || {}, customer: { slug: customer.slug, name: customer.name } });
}));

// POST /password { current, next } — the login's own platform password
router.post('/password', ...crm(), handle(async (req, res, { me }) => {
  const b = req.body || {};
  const row = (await q('SELECT password FROM users WHERE id = ?', [me.id]))[0];
  if (!row || !(await bcrypt.compare(String(b.current || ''), row.password || ''))) return res.status(400).json({ error: 'Your current password is not right.' });
  if (typeof b.next !== 'string' || b.next.length < PW_MIN) return res.status(400).json({ error: `Use a new password of at least ${PW_MIN} characters.` });
  await q('UPDATE users SET password = ? WHERE id = ?', [await bcrypt.hash(b.next, 10), me.id]);
  await audit(me, 'change password', 'team', String(me.id), '');
  res.json({ ok: true });
}));

/* ----------------------------------------------------------------- audit */
// GET: owners; ?ids=a,b ?entity=leads,comments ?who= ?q= ?before=id (newest first, 200 a page)
// POST: note an export (anyone allowed to export) or another action.
const AUDIT_PAGE = 200;
const list = (v, max) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, max);
router.get('/audit', ...crm({ settings: true }), handle(async (req, res, { customer }) => {
  const p = req.query;
  const ids = list(p.ids, 400), ents = list(p.entity, 30);
  const where = ['customer_id = ?'];
  const args = [customer.id];
  if (p.before) { where.push('id < ?'); args.push(Number(p.before) || 0); }
  if (ids.length) { where.push(`entity_id IN (${ids.map(() => '?').join(',')})`); args.push(...ids); }
  if (ents.length) {
    // entity is one type, or a comma list for bulk rows
    where.push(`(${ents.map(() => "FIND_IN_SET(?, REPLACE(entity, ', ', ',')) > 0").join(' OR ')})`);
    args.push(...ents);
  }
  if (p.who) { where.push('who = ?'); args.push(String(p.who)); }
  if (p.q) {
    const t = '%' + String(p.q).replace(/[%_\\]/g, (m) => '\\' + m) + '%';
    where.push('(detail LIKE ? OR action LIKE ? OR entity LIKE ? OR who LIKE ?)');
    args.push(t, t, t, t);
  }
  const rows = await q(`SELECT id, at, user_id, who, action, entity, entity_id, detail FROM cf_crm_audit WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ${AUDIT_PAGE + 1}`, args);
  res.json({ rows: rows.slice(0, AUDIT_PAGE).map((r) => ({ ...r, id: Number(r.id), user_id: r.user_id == null ? null : String(r.user_id) })), more: rows.length > AUDIT_PAGE });
}));

router.post('/audit', ...crm(), handle(async (req, res, { me }) => {
  const b = req.body || {};
  if (b.action === 'export' && !me.can.export) return res.status(403).json({ error: 'Only owners can export.' });
  await audit(me, String(b.action || 'note').slice(0, 40), String(b.entity || '').slice(0, 40), '', b.detail);
  res.json({ ok: true });
}));

export default router;
