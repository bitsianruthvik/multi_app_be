import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { q, tx, audit, parseJson, CrmError } from '../lib/db.js';
import QRCode from 'qrcode';
import { crm, handle, publicMember, forgetConfig, customerOfCompany, mintToken } from '../lib/context.js';
import { passwordProblem, newSecret, verifyCode, otpauthUri } from '../lib/security.js';
import { roleExists } from '../lib/roles.js';
import { sanitizeBrand } from '../lib/brand.js';
import { upsertRecords } from './data.js';

/**
 * Setup: the shared config (owners only), branding (owners only), the team
 * (owners only) and the signed-in login's own account.
 */
const router = Router({ mergeParams: true });

/* ---------------------------------------------------------------- config */
// The renamed records go through upsertRecords like any save, so each gets a
// new revision and version: an edit someone began before the rename merges
// with it instead of putting the old owner name back.
const RENAME_KEYS = { leads: ['owner'], people: ['ownerInCharge', 'sourceOwner'], comments: ['by'], interactions: ['by'], campaigns: ['owner'] };
async function renameOwner(c, me, from, to) {
  const customerId = me.customerId;
  const n = { users: 0, records: 0 };
  n.users += (await c.q('UPDATE cf_crm_members SET owner = ? WHERE customer_id = ? AND owner = ?', [to, customerId, from])).affectedRows;
  const ops = [];
  for (const [type, keys] of Object.entries(RENAME_KEYS)) {
    const rows = await c.q(
      `SELECT id, data FROM cf_crm_records WHERE customer_id = ? AND type = ? AND deleted = 0
          AND (${keys.map((k) => `JSON_UNQUOTE(JSON_EXTRACT(data, '$.${k}')) = ?`).join(' OR ')})`,
      [customerId, type, ...keys.map(() => from)]);
    for (const row of rows) {
      const d = parseJson(row.data, {});
      keys.forEach((k) => { if (d[k] === from) d[k] = to; });
      ops.push({ t: type, i: row.id, d });
    }
  }
  const cos = await c.q(
    `SELECT id, data FROM cf_crm_records WHERE customer_id = ? AND type = 'companies' AND deleted = 0
        AND JSON_CONTAINS(JSON_EXTRACT(data, '$.owners'), JSON_QUOTE(?))`, [customerId, from]);
  for (const row of cos) {
    const d = parseJson(row.data, {});
    d.owners = [...new Set((d.owners || []).map((x) => (x === from ? to : x)))];
    ops.push({ t: 'companies', i: row.id, d });
  }
  await upsertRecords(c, customerId, me.id, ops);
  n.records += ops.length;
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
      const n = await renameOwner(c, me, from, to);
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
  res.json({
    brand: { appName: b.appName || '', logo: b.logo || '', colors: { accent: b.colors?.accent || '', accent2: b.colors?.accent2 || '', bg: b.colors?.bg || '' } },
    // picks the home-screen manifest (public/cf_crm/m/<customer>.webmanifest)
    customer: c ? c.slug : '',
  });
}));

// POST /network-sign-in { email, password } — no sign-in needed.
// A customer's staff sign in at whichever of its companies' addresses they
// have: when the platform says "User not in this company" (the password was
// right, the company was not), the sign-in page asks here which company of
// the SAME customer the login belongs to, and signs in there. Answers only
// with the right password, only within the customer, only for a login with
// this app; anything else is the same "not right" as a wrong password.
// At most 10 tries a minute per address and email.
const nsTries = new Map();
router.post('/network-sign-in', handle(async (req, res) => {
  const b = req.body || {};
  const email = String(b.email || '').trim().toLowerCase();
  const key = (req.ip || '') + '|' + email;
  const now = Date.now();
  const t = nsTries.get(key);
  if (t && now - t.at < 60000 && t.n >= 10) return res.status(429).json({ error: 'Too many tries. Wait a minute.' });
  nsTries.set(key, t && now - t.at < 60000 ? { at: t.at, n: t.n + 1 } : { at: now, n: 1 });
  if (nsTries.size > 5000) nsTries.clear();
  const no = () => res.status(401).json({ error: 'Email or password is not right.' });
  if (!req.company || !req.appCtx || !email || !b.password) return no();
  const here = await customerOfCompany(Number(req.company.id));
  const u = (await q('SELECT id, password, company_id FROM users WHERE email = ? AND deleted_at IS NULL LIMIT 1', [email]))[0];
  if (!here || !u || !(await bcrypt.compare(String(b.password), u.password || ''))) return no();
  const theirs = await customerOfCompany(Number(u.company_id));
  if (!theirs || theirs.id !== here.id) return no();
  const co = (await q(
    `SELECT co.slug, co.name FROM companies co
       JOIN apps a ON a.company_id = co.id AND a.slug = 'cf_crm' AND a.deleted_at IS NULL
       JOIN app_user_access aua ON aua.app_id = a.id AND aua.user_id = ? AND aua.deleted_at IS NULL
      WHERE co.id = ? AND co.deleted_at IS NULL LIMIT 1`, [u.id, u.company_id]))[0];
  if (!co) return no();
  res.json({ company: co.slug, name: co.name });
}));

router.put('/brand', ...crm({ settings: true }), handle(async (req, res, { customer, me }) => {
  const brand = sanitizeBrand(req.body && req.body.brand);
  await q('UPDATE cf_crm_customers SET brand = ? WHERE id = ?', [JSON.stringify(brand), customer.id]);
  await audit(me, 'update', 'branding', '', 'colours / logo / name');
  res.json({ ok: true, brand });
}));

/* ------------------------------------------------------------------ team */

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
    totpEnabled: !!r.totp_enabled, mustChangePassword: !!r.must_change_password,
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
      const problem = passwordProblem(b.password, { email, name });
      if (problem) throw new CrmError(400, 'Temporary password: ' + problem);
      const roleId = await staffRole(c, company.id);
      const hash = await bcrypt.hash(String(b.password), 10);
      const ins = await c.q('INSERT INTO users (name, email, password, role_id, company_id) VALUES (?,?,?,?,?)', [name, email, hash, roleId, company.id]);
      userId = ins.insertId;
      await c.q('INSERT INTO app_user_access (user_id, app_id, role_id, company_id) VALUES (?,?,?,?)', [userId, company.app_id, roleId, company.id]);
    }
    await c.q(
      `INSERT INTO cf_crm_members (customer_id, user_id, role, owner, businesses, perms, active, must_change_password) VALUES (?,?,?,?,?, '{}', 1, ?)`,
      [customer.id, userId, b.role, owner, JSON.stringify(biz), ex ? 0 : 1]);
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
    const problem = passwordProblem(b.password, { email: next.email, name: next.name });
    if (problem) return res.status(400).json({ error: 'Temporary password: ' + problem });
    hash = await bcrypt.hash(String(b.password), 10);
  }
  await tx(async (c) => {
    await c.q('UPDATE cf_crm_members SET role = ?, owner = ?, active = ?, businesses = ?, perms = ? WHERE customer_id = ? AND user_id = ?',
      [next.role, next.owner, next.active ? 1 : 0, JSON.stringify(next.businesses), JSON.stringify(next.perms), customer.id, id]);
    // a reset password is temporary and ends their sign-ins; so does switching them off
    if (hash) await c.q('UPDATE cf_crm_members SET must_change_password = 1 WHERE customer_id = ? AND user_id = ?', [customer.id, id]);
    if (hash || (cur.active && !next.active)) await c.q('UPDATE cf_crm_members SET sessions_valid_after = ? WHERE customer_id = ? AND user_id = ?', [new Date(), customer.id, id]);
    if (b.resetTotp) await c.q('UPDATE cf_crm_members SET totp_enabled = 0, totp_secret = NULL, totp_pending = NULL, totp_last_step = NULL, totp_failed = 0, totp_locked_until = NULL WHERE customer_id = ? AND user_id = ?', [customer.id, id]);
    if (next.name !== cur.user_name || next.email !== cur.email || hash) {
      await c.q(`UPDATE users SET name = ?, email = ?${hash ? ', password = ?' : ''} WHERE id = ?`, hash ? [next.name, next.email, hash, id] : [next.name, next.email, id]);
    }
    const before = { role: cur.role, owner: cur.owner, active: !!cur.active, name: cur.user_name, email: cur.email };
    const changes = Object.keys(before).filter((k) => b[k] !== undefined && next[k] !== before[k]).map((k) => `${k}: ${next[k]}`);
    if (b.password) changes.push('password reset, their sessions ended');
    if (b.resetTotp) changes.push('two-step sign-in reset');
    if (b.businesses !== undefined) changes.push('business access: ' + (next.businesses.join(', ') || 'all'));
    if (b.perms !== undefined) changes.push('permissions: ' + JSON.stringify(next.perms));
    await audit(me, 'update user', 'team', String(id), `${cur.email} ${changes.join(', ')}`, c);
  });
  const user = (await listMembers(customer.id)).find((u) => u.id === String(id));
  res.json({ user });
}));

/* --------------------------------------------------------------- account */
// "Now" for sessions_valid_after, to the millisecond, from THIS server's clock —
// the same clock that stamps the replacement token (crmIssued), so the token
// made right after is never older than the cut-off.
const cutoffNow = () => new Date();
// the fresh token keeps a passed two-step sign-in
const freshToken = (req, me) => mintToken(req, me.totpEnabled && me.twoStepPassed ? { crm2fa: me.id } : {});

// Answers before the two gates: the app asks for the code / a new password.
router.get('/me', ...crm({ pending: true }), handle(async (req, res, { customer, me }) => {
  res.json({
    user: publicMember(me), brand: customer.brand || {}, customer: { slug: customer.slug, name: customer.name },
    needCode: !me.twoStepPassed, mustChangePassword: me.mustChangePassword,
  });
}));

// POST /password { current, next } — the login's own platform password.
// Ends every other sign-in; this one gets a fresh token.
router.post('/password', ...crm({ pending: true }), handle(async (req, res, { customer, me }) => {
  if (!me.twoStepPassed) return res.status(403).json({ error: 'Enter the code from your authenticator app.', code: 'TWO_STEP' });
  const b = req.body || {};
  const row = (await q('SELECT password FROM users WHERE id = ?', [me.id]))[0];
  if (!row || !(await bcrypt.compare(String(b.current || ''), row.password || ''))) return res.status(400).json({ error: 'Your current password is not right.' });
  const problem = passwordProblem(b.next, { email: me.email, name: me.name });
  if (problem) return res.status(400).json({ error: problem });
  if (await bcrypt.compare(String(b.next), row.password || '')) return res.status(400).json({ error: 'Choose a password different from the current one.' });
  await tx(async (c) => {
    await c.q('UPDATE users SET password = ? WHERE id = ?', [await bcrypt.hash(String(b.next), 10), me.id]);
    await c.q('UPDATE cf_crm_members SET must_change_password = 0, sessions_valid_after = ? WHERE customer_id = ? AND user_id = ?', [cutoffNow(), customer.id, me.id]);
    await audit(me, 'change password', 'team', String(me.id), 'other sessions ended', c);
  });
  res.json({ ok: true, token: freshToken(req, me) });
}));

// POST /sessions/end — sign out every other device and browser
router.post('/sessions/end', ...crm(), handle(async (req, res, { customer, me }) => {
  await q('UPDATE cf_crm_members SET sessions_valid_after = ? WHERE customer_id = ? AND user_id = ?', [cutoffNow(), customer.id, me.id]);
  await audit(me, 'sign out everywhere', 'team', String(me.id), '');
  res.json({ ok: true, token: freshToken(req, me) });
}));

/* ------------------------------------------------- two-step sign-in */
const TWO_STEP_TRIES = 5;
async function memberRow(customerId, userId) {
  return (await q('SELECT * FROM cf_crm_members WHERE customer_id = ? AND user_id = ?', [customerId, userId]))[0];
}
/** Check a code against `secret`; counts failures and locks for 15 minutes after 5. */
async function checkCode(customerId, me, secret, code) {
  const row = await memberRow(customerId, me.id);
  if (row.totp_locked_until && new Date(row.totp_locked_until) > new Date()) throw new CrmError(429, 'Too many wrong codes. Try again in 15 minutes.');
  const step = verifyCode(secret, code, row.totp_last_step);
  if (step == null) {
    const failed = Number(row.totp_failed || 0) + 1;
    await q(`UPDATE cf_crm_members SET totp_failed = ?, totp_locked_until = ${failed >= TWO_STEP_TRIES ? 'UTC_TIMESTAMP() + INTERVAL 15 MINUTE' : 'NULL'} WHERE customer_id = ? AND user_id = ?`,
      [failed >= TWO_STEP_TRIES ? 0 : failed, customerId, me.id]);
    if (failed >= TWO_STEP_TRIES) await audit(me, 'two-step locked', 'team', String(me.id), `${TWO_STEP_TRIES} wrong codes`);
    throw new CrmError(400, 'That code did not match. Use the newest 6-digit code from your authenticator app.');
  }
  await q('UPDATE cf_crm_members SET totp_last_step = ?, totp_failed = 0, totp_locked_until = NULL WHERE customer_id = ? AND user_id = ?', [step, customerId, me.id]);
  return step;
}

// POST /two-step/verify { code } — the second step of signing in
router.post('/two-step/verify', ...crm({ pending: true }), handle(async (req, res, { customer, me }) => {
  if (!me.totpEnabled) return res.json({ ok: true, token: null });
  const row = await memberRow(customer.id, me.id);
  await checkCode(customer.id, me, row.totp_secret, req.body && req.body.code);
  await audit(me, 'sign in', 'team', String(me.id), 'two-step code accepted');
  res.json({ ok: true, token: mintToken(req, { crm2fa: me.id }) });
}));

// POST /two-step/start — a new secret to scan (not active until /enable)
router.post('/two-step/start', ...crm(), handle(async (req, res, { customer, me }) => {
  if (me.totpEnabled) return res.status(400).json({ error: 'Two-step sign-in is already on.' });
  const secret = newSecret();
  await q('UPDATE cf_crm_members SET totp_pending = ? WHERE customer_id = ? AND user_id = ?', [secret, customer.id, me.id]);
  const issuer = (customer.brand && customer.brand.appName) || customer.name || 'CRM';
  const uri = otpauthUri(secret, me.email, issuer);
  res.json({ secret: secret.replace(/(.{4})/g, '$1 ').trim(), uri, qr: await QRCode.toDataURL(uri, { margin: 1, width: 220 }) });
}));

// POST /two-step/enable { code } — turn it on; this sign-in counts as passed
router.post('/two-step/enable', ...crm(), handle(async (req, res, { customer, me }) => {
  const row = await memberRow(customer.id, me.id);
  if (!row.totp_pending) return res.status(400).json({ error: 'Start again: scan the new code first.' });
  const step = verifyCode(row.totp_pending, req.body && req.body.code, null);
  if (step == null) return res.status(400).json({ error: 'That code did not match. Try the newest code.' });
  await q('UPDATE cf_crm_members SET totp_secret = totp_pending, totp_pending = NULL, totp_enabled = 1, totp_last_step = ?, totp_failed = 0 WHERE customer_id = ? AND user_id = ?', [step, customer.id, me.id]);
  await audit(me, 'enable two-step sign-in', 'team', String(me.id), '');
  res.json({ ok: true, token: mintToken(req, { crm2fa: me.id }) });
}));

// POST /two-step/disable { code } — needs a current code
router.post('/two-step/disable', ...crm(), handle(async (req, res, { customer, me }) => {
  if (!me.totpEnabled) return res.json({ ok: true });
  const row = await memberRow(customer.id, me.id);
  await checkCode(customer.id, me, row.totp_secret, req.body && req.body.code);
  await q('UPDATE cf_crm_members SET totp_enabled = 0, totp_secret = NULL, totp_pending = NULL, totp_last_step = NULL WHERE customer_id = ? AND user_id = ?', [customer.id, me.id]);
  await audit(me, 'disable two-step sign-in', 'team', String(me.id), '');
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
