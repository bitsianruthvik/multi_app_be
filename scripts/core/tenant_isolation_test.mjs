// Tenant-isolation probe against a local backend (read-mostly; the writes it tries must all be refused).
// Run: node scripts/core/tenant_isolation_test.mjs [base, default http://127.0.0.1:4100] — needs that server running on this code.
import dotenv from 'dotenv'; dotenv.config({ quiet: true });
import jwt from 'jsonwebtoken';
import { pool } from '../../db.js';

const BASE = process.argv[2] || 'http://127.0.0.1:4100';
let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => { if (cond) { pass++; console.log('  PASS ', label); } else { fail++; console.log('  FAIL ', label, extra); } };
const call = async (method, path, { token, body } = {}) => {
  const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let j = null; const t = await r.text(); try { j = JSON.parse(t); } catch { j = t; }
  return { s: r.status, j };
};

const [[A]] = await pool.query("SELECT id, slug FROM companies WHERE slug = 'placebo'");
const [[B]] = await pool.query("SELECT id, slug FROM companies WHERE slug = 'karni'");
const [[ua]] = await pool.query("SELECT u.id, u.email, u.name, r.name role FROM users u JOIN roles r ON r.id = u.role_id WHERE u.company_id = ? AND LOWER(r.name) = 'admin' AND u.deleted_at IS NULL ORDER BY u.id LIMIT 1", [A.id]);
const [[ub]] = await pool.query("SELECT u.id, u.email FROM users u WHERE u.company_id = ? AND u.deleted_at IS NULL AND u.email LIKE '%@%' ORDER BY u.id LIMIT 1", [B.id]);
const [[appB]] = await pool.query('SELECT id, slug FROM apps WHERE company_id = ? AND deleted_at IS NULL LIMIT 1', [B.id]);
const [[appA]] = await pool.query("SELECT id, slug FROM apps WHERE company_id = ? AND slug = 'cf_erp' AND deleted_at IS NULL LIMIT 1", [A.id]);
const tokA = jwt.sign({ id: ua.id, name: ua.name, email: ua.email, role: ua.role, company: A.slug, companyId: A.id, company_id: A.id, uiPermissions: [] }, process.env.JWT_SECRET, { expiresIn: 600 });
console.log(`A=${A.slug}(${A.id}) admin user ${ua.id}; B=${B.slug}(${B.id}) user ${ub.id}; B app ${appB.slug}(${appB.id})`);

console.log('\n1. Nothing lists companies without a sign-in');
let r = await call('GET', '/api/public/companies'); ok(r.s === 401, 'GET /api/public/companies unauthenticated → 401', r.s);
r = await call('GET', '/api/public/roles'); ok(r.s === 401, 'GET /api/public/roles unauthenticated → 401', r.s);
r = await call('GET', '/api/public/companies', { token: tokA }); ok(r.s === 200 && Array.isArray(r.j) && r.j.length === 1 && r.j[0].id === A.id, 'signed in: /api/public/companies → own company only', JSON.stringify(r.j).slice(0, 120));
r = await call('GET', '/api/public/teams', { token: tokA }); ok(r.s === 200 && r.j.every((t) => t.company_id === A.id), 'signed in: /api/public/teams → own company only');
const real = await call('GET', `/api/public/companies/${B.slug}`); const fake = await call('GET', '/api/public/companies/no-such-co-91');
ok(real.s === 200 && fake.s === 200 && real.j.name === null && fake.j.name === null, 'sign-in page lookup answers the same for a real and a made-up company');

console.log('\n2. Sign-in tells nothing');
const bad = (x) => x.s === 401 && x.j?.message === 'Invalid email or password';
r = await call('POST', `/api/no-such-co-91/auth/login`, { body: { email: ub.email, password: 'whatever-123' } }); ok(bad(r), 'unknown company → generic', JSON.stringify(r));
r = await call('POST', `/api/${A.slug}/auth/login`, { body: { email: ub.email, password: 'whatever-123' } }); ok(bad(r), "another company's email at this company → generic", JSON.stringify(r));
r = await call('POST', `/api/${A.slug}/auth/login`, { body: { email: 'nobody-91@example.com', password: 'whatever-123' } }); ok(bad(r), 'unknown email → generic', JSON.stringify(r));
r = await call('POST', `/api/${A.slug}/auth/login`, { body: { email: ua.email, password: 'wrong-password-1' } }); ok(bad(r), 'wrong password → generic', JSON.stringify(r));
r = await call('POST', `/api/no-such-co-91/cf_erp/login`, { body: { email: ub.email, password: 'whatever-123' } }); ok(bad(r), 'app-level login, unknown company → generic', JSON.stringify(r));
r = await call('POST', `/api/${A.slug}/cf_erp/login`, { body: { email: ub.email, password: 'whatever-123' } }); ok(bad(r), "app-level login, another company's email → generic", JSON.stringify(r));
r = await call('POST', `/api/${A.slug}/auth/register`, { body: { name: 'x', email: 'x91@example.com', password: 'whatever-123' } }); ok(r.s === 403, 'self sign-up is closed', r.s);
const [[made]] = await pool.query("SELECT COUNT(*) n FROM users WHERE email = 'x91@example.com'"); ok(made.n === 0, 'no user was created');

console.log('\n3. Addresses answer the same whether the company exists or not');
const u1 = await call('GET', `/api/${B.slug}/cf_erp/health`); const u2 = await call('GET', '/api/no-such-co-91/cf_erp/health');
ok(u1.s === 401 && u2.s === 401, 'unauthenticated: real and made-up company both 401', `${u1.s}/${u2.s}`);
const s1 = await call('GET', `/api/${B.slug}/${appB.slug}/health`, { token: tokA }); const s2 = await call('GET', `/api/no-such-co-91/${appB.slug}/health`, { token: tokA });
ok(s1.s === 403 && s2.s === 403 && JSON.stringify(s1.j) === JSON.stringify(s2.j), "signed in to A: B's address and a made-up one answer identically", `${s1.s} ${JSON.stringify(s1.j)} / ${s2.s} ${JSON.stringify(s2.j)}`);
const a1 = await call('GET', `/api/${A.slug}/no-such-app/health`, { token: tokA });
ok(a1.s === 403, "a made-up app answers like no access", JSON.stringify(a1));
r = await call('GET', `/api/${B.slug}/${appB.slug}/app/query`); ok(r.s === 401, 'app info endpoint needs sign-in', r.s);
r = await call('GET', '/debug/data', { token: tokA }); ok(r.s === 404 || r.s === 401, '/debug/data is gone', r.s);

console.log('\n4. Generic query API reads');
r = await call('POST', '/api/query/v1/base_resource', { token: tokA, body: { operation: 'query', resource: 'companies' } });
ok(r.j?.success && r.j.data.length === 1 && r.j.data[0].id === A.id, 'companies → own company only', JSON.stringify(r.j).slice(0, 160));
r = await call('POST', '/api/query/v1/base_resource', { token: tokA, body: { operation: 'query', resource: 'apps' } });
ok(r.j?.success && r.j.data.every((x) => (x.companyId ?? x.company_id ?? A.id) === A.id) && !r.j.data.some((x) => x.id === appB.id), 'apps → no other company\'s apps', JSON.stringify(r.j).slice(0, 160));
r = await call('POST', '/api/query/v1/base_resource', { body: { operation: 'query', resource: 'companies' } }); ok(r.s === 401, 'companies unauthenticated → 401', r.s);
r = await call('POST', '/api/query/v1/base_resource', { token: tokA, body: { operation: 'query', resource: 'fab_nodes', pagination: { limit: 5 } } });
ok(r.j?.success !== false, 'fab_nodes read still works (scoped through its plan)', JSON.stringify(r.j).slice(0, 160));

console.log('\n5. Generic writes cannot reach another company');
const [[before]] = await pool.query('SELECT company_id, role_id FROM users WHERE id = ?', [ua.id]);
r = await call('POST', '/api/query/v1/base_resource', { token: tokA, body: { operation: 'update', resource: 'users', id: ua.id, data: { company_id: B.id } } });
const [[after]] = await pool.query('SELECT company_id FROM users WHERE id = ?', [ua.id]);
ok(after.company_id === before.company_id, 'moving own login into another company does nothing', `${r.s} ${JSON.stringify(r.j)}`);
const [[aua]] = await pool.query('SELECT id, app_id FROM app_user_access WHERE user_id = ? AND company_id = ? AND deleted_at IS NULL LIMIT 1', [ua.id, A.id]);
if (aua) {
  r = await call('POST', '/api/query/v1/base_resource', { token: tokA, body: { operation: 'update', resource: 'app_user_access', id: aua.id, data: { app_id: appB.id } } });
  const [[a2]] = await pool.query('SELECT app_id FROM app_user_access WHERE id = ?', [aua.id]);
  ok(r.s === 404 && a2.app_id === aua.app_id, "granting oneself another company's app is refused", `${r.s} ${JSON.stringify(r.j)}`);
}
r = await call('POST', '/api/query/v1/base_resource', { token: tokA, body: { operation: 'update', resource: 'companies', id: B.id, data: { name: 'hacked' } } });
const [[bn]] = await pool.query('SELECT name FROM companies WHERE id = ?', [B.id]);
ok(r.s === 403 && bn.name !== 'hacked', 'renaming another company is refused', `${r.s}`);
r = await call('POST', '/api/query/v1/base_resource', { token: tokA, body: { operation: 'update', resource: 'features_capability', id: 1, data: { name: 'x' } } });
ok(r.s === 403, 'the platform feature catalogue cannot be written by a company', `${r.s}`);
const [[roleB]] = await pool.query('SELECT id FROM roles WHERE company_id = ? LIMIT 1', [B.id]);
r = await call('POST', '/api/query/v1/base_resource', { token: tokA, body: { operation: 'update', resource: 'users', id: ua.id, data: { role_id: roleB.id } } });
const [[after2]] = await pool.query('SELECT role_id FROM users WHERE id = ?', [ua.id]);
ok(r.s === 404 && after2.role_id === before.role_id, "taking another company's role is refused", `${r.s} ${JSON.stringify(r.j)}`);

console.log('\n6. Normal use still works');
r = await call('GET', `/api/${A.slug}/apps`, { token: tokA }); ok(r.s === 200 && Array.isArray(r.j), 'own app list', r.s);
r = await call('GET', `/api/${A.slug}/cf_erp/health`, { token: tokA }); ok(r.s === 200 || r.s === 403, 'own app health (200, or 403 if this admin has no cf_erp grant)', `${r.s} ${JSON.stringify(r.j)}`);
r = await call('POST', '/api/query/v1/base_resource', { token: tokA, body: { operation: 'query', resource: 'roles' } });
ok(r.j?.success && r.j.data.length > 0, 'own roles read', JSON.stringify(r.j).slice(0, 120));
r = await call('POST', '/api/query/v1/base_resource', { token: tokA, body: { operation: 'query', resource: 'cfErpMachine', pagination: { limit: 3 } } });
ok(r.j?.success && r.j.data.every((m) => (m.companyId ?? A.id) === A.id), 'an app resource read (cf_erp machines), own company', JSON.stringify(r.j).slice(0, 160));

// A real sign-in with the local test password (fix-passwords.js --reset-all sets Test@1234); skipped when it differs.
r = await call('POST', `/api/${A.slug}/auth/login`, { body: { email: ua.email, password: process.env.ISO_TEST_PASSWORD || 'Test@1234' } });
if (r.s === 200) ok(r.j?.user?.companyId === A.id && !!r.j?.token, 'a real sign-in still works, into its own company');
else console.log('  SKIP  real sign-in (the local password is not the test one)', r.s);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
