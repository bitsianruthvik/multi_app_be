#!/usr/bin/env node
/**
 * cf_crm end-to-end API test against a running backend (default
 * http://localhost:4000). It makes its OWN customer with two companies
 * (zz-crm-a, zz-crm-b), runs every rule through HTTP, and removes all of it at
 * the end, pass or fail. Touches no real customer.
 *
 *   cd multi_app_be && node apps/cf_crm/scripts/api_test.mjs [--keep] [--host http://localhost:4000]
 *
 * Note: the platform allows 5 sign-ins a minute per address; this test signs
 * in 4 times.
 */
import bcrypt from 'bcryptjs';
import { pool } from '../../../db.js';
import { applySchema } from './seed_northeast.mjs';

const argv = process.argv.slice(2);
const HOST = (argv.includes('--host') ? argv[argv.indexOf('--host') + 1] : 'http://localhost:4000').replace(/\/$/, '');
const PW = 'Zz-test-' + Math.random().toString(36).slice(2, 10);
let pass = 0, fail = 0;
const ok = (cond, name, extra) => { if (cond) pass++; else { fail++; console.log('  FAIL', name, extra !== undefined ? JSON.stringify(extra).slice(0, 300) : ''); } };

const made = { customer: null, companies: [], users: [] };

async function setup() {
  const c = await pool.getConnection();
  try {
    await applySchema(c);
    const [cu] = await c.query("INSERT INTO cf_crm_customers (slug, name, brand) VALUES ('zz-crm-test', 'ZZ Test', ?)", [JSON.stringify({ appName: 'ZZ Net', colors: { accent: '#112233' } })]);
    made.customer = cu.insertId;
    for (const [slug, biz] of [['zz-crm-a', 'chit'], ['zz-crm-b', 're']]) {
      await c.query('DELETE FROM companies WHERE slug = ? AND NOT EXISTS (SELECT 1 FROM users WHERE company_id = companies.id)', [slug]);
      const [co] = await c.query('INSERT INTO companies (name, slug) VALUES (?, ?)', ['ZZ ' + slug, slug]);
      const [app] = await c.query("INSERT INTO apps (company_id, name, slug) VALUES (?, 'CRM', 'cf_crm')", [co.insertId]);
      const [role] = await c.query("INSERT INTO roles (name, company_id) VALUES ('admin', ?)", [co.insertId]);
      const email = `admin@${slug}.test`;
      const [u] = await c.query('INSERT INTO users (name, email, password, role_id, company_id) VALUES (?,?,?,?,?)', ['Admin ' + slug, email, await bcrypt.hash(PW, 10), role.insertId, co.insertId]);
      await c.query('INSERT INTO app_user_access (user_id, app_id, role_id, company_id) VALUES (?,?,?,?)', [u.insertId, app.insertId, role.insertId, co.insertId]);
      await c.query('INSERT INTO cf_crm_customer_companies (company_id, customer_id, business_id) VALUES (?,?,?)', [co.insertId, made.customer, biz]);
      made.companies.push({ id: co.insertId, slug, appId: app.insertId, email });
      made.users.push(u.insertId);
    }
    await c.query("INSERT INTO cf_crm_settings (customer_id, k, value) VALUES (?, 'config', ?)", [made.customer, JSON.stringify({ businesses: [{ id: 'chit', name: 'Chit' }, { id: 're', name: 'RE' }], owners: ['Owner 1', 'Owner 2', 'Owner 3'] })]);
  } finally { c.release(); }
}

async function cleanup() {
  const c = await pool.getConnection();
  try {
    if (made.customer) {
      for (const t of ['records', 'phones', 'settings', 'audit', 'chat_threads', 'chat_messages', 'chat_reads', 'notifications', 'files', 'members']) {
        await c.query(`DELETE FROM cf_crm_${t} WHERE customer_id = ?`, [made.customer]);
      }
      await c.query('DELETE FROM cf_crm_customer_companies WHERE customer_id = ?', [made.customer]);
      await c.query('DELETE FROM cf_crm_customers WHERE id = ?', [made.customer]);
    }
    const ids = made.companies.map((x) => x.id);
    if (ids.length) {
      const inn = ids.map(() => '?').join(',');
      await c.query(`DELETE FROM app_user_access WHERE company_id IN (${inn})`, ids);
      await c.query(`DELETE FROM users WHERE company_id IN (${inn})`, ids);
      await c.query(`DELETE FROM roles WHERE company_id IN (${inn})`, ids);
      await c.query(`DELETE FROM apps WHERE company_id IN (${inn})`, ids);
      await c.query(`DELETE FROM companies WHERE id IN (${inn})`, ids);
    }
  } finally { c.release(); }
}

async function login(company, email, password = PW) {
  const r = await fetch(`${HOST}/api/${company}/cf_crm/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const j = await r.json().catch(() => ({}));
  if (!j.token) throw new Error(`login ${email}: ${r.status} ${JSON.stringify(j)}`);
  return { company, token: j.token };
}

async function call(who, method, path, body, raw) {
  const headers = { authorization: 'Bearer ' + who.token };
  if (body !== undefined && !raw) headers['content-type'] = 'application/json';
  if (raw) headers['content-type'] = 'application/octet-stream';
  const r = await fetch(`${HOST}/api/${who.company}/cf_crm${path}`, { method, headers, body: raw ? body : body !== undefined ? JSON.stringify(body) : undefined });
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer());
  return { status: r.status, data };
}

async function syncAll(who) {
  const map = new Map();
  let cur = null;
  for (;;) {
    const qs = new URLSearchParams({ full: '1' });
    if (cur) { qs.set('u', cur.u); qs.set('t', cur.t); qs.set('i', cur.i); }
    const r = await call(who, 'GET', '/sync?' + qs);
    if (r.status !== 200) throw new Error('sync ' + r.status + ' ' + JSON.stringify(r.data));
    r.data.rows.forEach((x) => { if (x.x) map.delete(x.t + '/' + x.i); else map.set(x.t + '/' + x.i, x.d); });
    cur = r.data.cursor;
    if (!r.data.more) return { map, cursor: cur, first: r.data };
  }
}

async function main() {
  await setup();
  const [A, B] = made.companies;
  const adminA = await login(A.slug, A.email);
  const adminB = await login(B.slug, B.email);

  console.log('who am I, branding');
  let r = await call(adminA, 'GET', '/me');
  ok(r.status === 200 && r.data.user.role === 'admin', 'company admin becomes Owner on first use', r.data);
  ok(r.data.brand && r.data.brand.appName === 'ZZ Net', 'customer branding comes with /me', r.data.brand);

  console.log('one network for both companies');
  r = await call(adminA, 'POST', '/records', { ops: [
    { t: 'people', i: 'p1', d: { id: 'p1', name: 'Ravi', mobiles: ['+91 98480 00001'], ownerInCharge: 'Owner 1' } },
    { t: 'people', i: 'p2', d: { id: 'p2', name: 'Sita', mobiles: ['9848000002'], ownerInCharge: 'Owner 2' } },
    { t: 'companies', i: 'c1', d: { id: 'c1', name: 'Acme Pharma', owners: ['Owner 1'] } },
    { t: 'leads', i: 'l1', d: { id: 'l1', personId: 'p1', business: 'chit', stage: 'new', owner: 'Owner 1' } },
    { t: 'leads', i: 'l2', d: { id: 'l2', personId: 'p2', business: 're', stage: 'enquiry', owner: 'Owner 2' } },
    { t: 'chits', i: 'ch1', d: { id: 'ch1', personId: 'p2', chitValue: 500000 } },
    { t: 'comments', i: 'cm1', d: { id: 'cm1', leadId: 'l2', text: 'first call', byId: 'forged' } },
  ] });
  ok(r.status === 200 && r.data.saved === 7 && r.data.rejected.length === 0, 'owner saves 7 records', r.data);
  let s = await syncAll(adminB);
  ok(s.map.has('people/p1') && s.map.has('leads/l1') && s.map.has('companies/c1'), 'the other company sees the same records');
  ok(s.map.get('comments/cm1') && s.map.get('comments/cm1').byId === String(made.users[0]), 'a comment carries its real author, not the one sent', s.map.get('comments/cm1'));
  ok(s.first.me && s.first.config && s.first.brand, 'first sync page carries me, config and brand');

  console.log('incremental sync');
  const cur0 = s.cursor;
  await call(adminA, 'POST', '/records', { ops: [{ t: 'people', i: 'p1', d: { id: 'p1', name: 'Ravi Kumar', mobiles: ['9848000001'], ownerInCharge: 'Owner 1' } }] });
  r = await call(adminB, 'GET', '/sync?' + new URLSearchParams({ u: cur0.u, t: cur0.t, i: cur0.i }));
  ok(r.status === 200 && r.data.rows.length === 1 && r.data.rows[0].d.name === 'Ravi Kumar', 'only the changed record comes back', r.data.rows);
  r = await call(adminB, 'GET', '/sync?' + new URLSearchParams({ u: 'nonsense', t: '', i: '' }));
  ok(r.status === 400, 'a malformed cursor is refused', r.status);

  console.log('team: a manager in company B');
  r = await call(adminA, 'POST', '/users', { name: 'Manny', email: 'manny@zz-crm-b.test', role: 'manager', owner: 'Owner 2', password: PW, companyId: B.id });
  ok(r.status === 200 && r.data.user && r.data.user.role === 'manager', 'owner adds a manager to the other company', r.data);
  const mannyId = r.data.user && r.data.user.id;
  if (mannyId) made.users.push(Number(mannyId));
  ok(r.data.loginUrl === `/${B.slug}/cf_crm/login`, 'the sign-in link is the company of the new login', r.data.loginUrl);
  r = await call(adminA, 'POST', '/users', { name: 'Again', email: 'manny@zz-crm-b.test', role: 'entry', password: PW, companyId: B.id });
  ok(r.status === 409, 'the same person cannot be added twice', r);
  r = await call(adminA, 'PATCH', '/users', { id: mannyId, businesses: ['re'] });
  ok(r.status === 200 && r.data.user.businesses.join() === 're', 'owner limits the manager to real estate', r.data);
  const manny = await login(B.slug, 'manny@zz-crm-b.test');

  s = await syncAll(manny);
  ok(!s.map.has('people/p1'), 'a manager does not see people of another owner');
  ok(s.map.has('people/p2'), 'a manager sees their own people');
  ok(!s.map.has('leads/l1'), 'a chit lead is hidden from a real-estate-only login');
  ok(!s.map.has('chits/ch1'), 'chits are hidden from a real-estate-only login');
  ok(s.map.has('leads/l2') && s.map.has('comments/cm1'), 'their own business lead and its comments are visible');

  r = await call(manny, 'POST', '/records', { ops: [
    { t: 'people', i: 'p3', d: { id: 'p3', name: 'Mine', ownerInCharge: 'Owner 2' } },
    { t: 'people', i: 'p4', d: { id: 'p4', name: 'Not mine', ownerInCharge: 'Owner 1' } },
    { t: 'leads', i: 'l3', d: { id: 'l3', personId: 'p3', business: 'chit' } },
    { t: 'people', i: 'p5', d: { id: 'p5', name: 'Dup', ownerInCharge: 'Owner 2', mobiles: ['09848000002'] } },
    { t: 'people', i: 'p2', x: 1 },
    { t: 'campaigns', i: 'cp1', d: { id: 'cp1', name: 'Diwali', status: 'Sent' } },
  ] });
  const why = Object.fromEntries((r.data.rejected || []).map((x) => [x.i, x.why]));
  ok(r.status === 200 && r.data.saved === 1, 'only the allowed record is saved', r.data);
  ok(why.p4 === 'scope', 'a manager cannot give a person to another owner', why);
  ok(why.l3 === 'business', 'a real-estate-only login cannot add a chit lead', why);
  ok(why.p5 === 'mobile', 'a mobile number already on someone else is refused', why);
  ok(why.p2 === 'delete', 'a manager cannot delete people', why);
  ok(why.cp1 === 'send', 'a manager cannot mark a campaign as sent', why);

  console.log('private people');
  await call(adminA, 'PATCH', '/users', { id: String(made.users[0]), owner: 'Owner 1' });
  r = await call(adminA, 'POST', '/records', { ops: [{ t: 'people', i: 'p6', d: { id: 'p6', name: 'Secret', ownerInCharge: 'Owner 1', private: true } }, { t: 'interactions', i: 'i6', d: { id: 'i6', personId: 'p6', type: 'Call' } }] });
  ok(r.data.saved === 2, 'owner in charge saves a private person');
  s = await syncAll(adminB);
  ok(!s.map.has('people/p6') && !s.map.has('interactions/i6'), 'a private person and their records are hidden from other owners');
  r = await call(adminB, 'POST', '/records', { ops: [{ t: 'people', i: 'p6', d: { id: 'p6', name: 'Hacked', ownerInCharge: 'Owner 1' } }] });
  ok(r.data.rejected && r.data.rejected[0] && r.data.rejected[0].why === 'private', 'nobody else can change a private person', r.data);

  console.log('read-only');
  r = await call(adminA, 'PATCH', '/users', { id: mannyId, role: 'readonly' });
  r = await call(manny, 'POST', '/records', { ops: [{ t: 'people', i: 'p7', d: { id: 'p7', name: 'x' } }] });
  ok(r.status === 403, 'a read-only login cannot save', r.status);
  r = await call(manny, 'PUT', '/config', { config: { owners: ['x'] } });
  ok(r.status === 403, 'only owners change settings', r.status);
  r = await call(manny, 'GET', '/audit');
  ok(r.status === 403, 'only owners read the audit log', r.status);

  console.log('owners: rename, keep one');
  r = await call(adminA, 'PUT', '/config', { config: { businesses: [{ id: 'chit', name: 'Chit' }, { id: 're', name: 'RE' }], owners: ['Owner One', 'Owner 2', 'Owner 3'] }, renameOwners: [['Owner 1', 'Owner One']], changed: ['owners'] });
  ok(r.status === 200 && r.data.renamed[0].records >= 3, 'renaming an owner renames it on records', r.data);
  s = await syncAll(adminA);
  ok(s.map.get('people/p1').ownerInCharge === 'Owner One' && s.map.get('companies/c1').owners[0] === 'Owner One' && s.map.get('leads/l1').owner === 'Owner One', 'person, company and lead follow the rename');
  ok(s.map.has('people/p6'), 'the private person still belongs to its renamed owner');

  console.log('company and app isolation');
  r = await call({ company: B.slug, token: adminA.token }, 'GET', '/me');
  ok(r.status === 403, "a login cannot use another company's address", r.status);
  r = await call({ company: 'placebo', token: adminA.token }, 'GET', '/sync');
  ok(r.status === 403 || r.status === 404, 'a login cannot reach a company outside its own', r.status);

  console.log('documents');
  const file = Buffer.from('%PDF-1.4 zz test');
  r = await call(adminB, 'POST', '/files?' + new URLSearchParams({ entity: 'people', entityId: 'p2', docType: 'pan', name: 'pan.pdf', mime: 'application/pdf' }), file, true);
  ok(r.status === 200 && r.data.doc && r.data.doc.size === file.length, 'upload a document', r.data);
  const docId = r.data.doc && r.data.doc.id;
  r = await call(adminA, 'GET', '/files?id=' + docId);
  ok(r.status === 200 && Buffer.isBuffer(r.data) && r.data.equals(file), 'download returns the same bytes');
  r = await call(adminA, 'POST', '/files?' + new URLSearchParams({ entity: 'people', entityId: 'nobody', name: 'x' }), file, true);
  ok(r.status === 404, 'no upload to a record that does not exist', r.status);
  r = await call(adminA, 'DELETE', '/files?id=' + docId);
  ok(r.status === 200, 'an owner deletes a document');
  r = await call(adminA, 'GET', '/files?id=' + docId);
  ok(r.status === 404, 'a deleted document is gone');

  console.log('chat and notifications');
  r = await call(adminB, 'POST', '/chat?a=dm', { userId: String(made.users[0]) });
  ok(r.status === 200 && /^dm:/.test(r.data.thread), 'open a direct chat', r.data);
  const dm = r.data.thread;
  r = await call(adminB, 'POST', '/chat?a=send', { thread: dm, text: 'hello' });
  ok(r.status === 200 && r.data.message.text === 'hello', 'send a message');
  r = await call(adminA, 'GET', '/chat?a=threads');
  const t = (r.data.threads || []).find((x) => x.id === dm);
  ok(t && t.unread === 1 && t.last && t.last.text === 'hello', 'the other side has one unread', t);
  ok((r.data.threads || []).some((x) => x.kind === 'business'), 'business channels exist');
  r = await call(manny, 'GET', '/chat?a=messages&thread=' + encodeURIComponent(dm));
  ok(r.status === 404, 'a third person cannot read a direct chat', r.status);
  r = await call(manny, 'GET', '/chat?a=threads');
  ok(!(r.data.threads || []).some((x) => x.id === 'biz:chit'), 'the chit channel is hidden from a real-estate-only login');
  r = await call(adminA, 'GET', '/notify');
  ok(r.status === 200 && r.data.items.some((n) => n.kind === 'chat'), 'a chat message notifies', r.data);
  await call(adminB, 'POST', '/records', { ops: [{ t: 'leads', i: 'l1', d: { id: 'l1', personId: 'p1', business: 'chit', stage: 'new', owner: 'Owner 2', _title: 'Ravi' } }] });
  r = await call(manny, 'GET', '/notify');
  ok(!(r.data.items || []).some((n) => n.kind === 'assign' && /Ravi/.test(n.text)), 'a chit lead does not notify a real-estate-only login');

  console.log('audit');
  r = await call(adminA, 'GET', '/audit?entity=people');
  ok(r.status === 200 && r.data.rows.length > 0, 'owners read the audit log by type', r.data.rows && r.data.rows.length);
  r = await call(adminA, 'GET', '/audit?ids=p1');
  ok(r.status === 200 && r.data.rows.every((x) => x.entity_id === 'p1'), 'audit narrowed to one record');

  console.log('branding');
  r = await call(adminA, 'PUT', '/brand', { brand: { appName: 'New <b>', colors: { accent: '#ABCDEF', bg: 'red' }, logo: 'javascript:alert(1)' } });
  ok(r.status === 200 && r.data.brand.colors.accent === '#ABCDEF' && !r.data.brand.colors.bg && !r.data.brand.logo && !/[<>]/.test(r.data.brand.appName), 'branding keeps only valid colours, logo and text', r.data.brand);
  r = await call(adminB, 'GET', '/brand');
  ok(r.data.brand.colors.accent === '#ABCDEF', 'both companies see the new branding');

  console.log('at least one owner');
  r = await call(adminA, 'PATCH', '/users', { id: String(made.users[0]), role: 'manager' });
  ok(r.status === 200, 'one of two owners steps down', r);
  r = await call(adminB, 'PATCH', '/users', { id: String(made.users[1]), active: false });
  ok(r.status === 400, 'the last active owner cannot be switched off', r);
  r = await call(adminA, 'GET', '/users');
  ok(r.status === 403, 'a former owner loses Setup at once', r.status);
}

main()
  .catch((e) => { fail++; console.error('ERROR', e.message || e); })
  .finally(async () => {
    if (!argv.includes('--keep')) await cleanup().catch((e) => console.error('cleanup failed', e.message));
    await pool.end();
    console.log(`\ncf_crm api: ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  });
