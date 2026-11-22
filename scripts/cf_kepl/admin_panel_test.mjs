/**
 * admin_panel_test.mjs — the company admin panel (core/admin/adminPanelService.js, apps/cf_erp/permissions.js).
 *
 *   cd multi_app_be && node scripts/cf_kepl/admin_panel_test.mjs        CF_COMPANY=2 (the default)
 *
 * One transaction, ROLLED BACK at the end: nothing is kept.
 *   1. the catalog: every CF ERP tag has a place; levels read back; standard roles are sets of tags
 *   2. roles: from a standard role, a level changed, a copy, reset, the refusals
 *   3. people: add (email / username), role per app, what they hold, change, take access away and give it back
 *   4. admins and safety: the last admin, yourself, a role in use, another company
 *   5. several at once; the history
 */
import path from 'path';
import { pathToFileURL } from 'url';
import bcrypt from 'bcryptjs';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
const S = await imp('core/admin/adminPanelService.js');
const L = await imp('core/auth/loginRules.js');
const cat = (await imp('apps/cf_erp/permissions.js')).default;

const COMPANY = Number(process.env.CF_COMPANY ?? 2);
let pass = 0; let fail = 0;
const ok = (name, cond, detail = '') => { if (cond) { pass += 1; console.log(`  ok   ${name}`); } else { fail += 1; console.log(`  FAIL ${name} ${detail}`); } };
const refusal = (p) => p.then(() => null, (e) => e);
const said = (e) => JSON.stringify([e?.code, e?.message, e?.problems]);

const db = await pool.getConnection();
try {
  await db.beginTransaction();
  const [[me]] = await db.query('SELECT u.id, u.name FROM users u WHERE u.company_id = ? AND u.deleted_at IS NULL ORDER BY u.id LIMIT 1', [COMPANY]);
  const c = { companyId: COMPANY, userId: me.id, userName: me.name };
  await db.query('UPDATE users SET is_company_admin = 1 WHERE id = ?', [me.id]);
  const [[app]] = await db.query("SELECT id, slug, name FROM apps WHERE company_id = ? AND slug = 'cf_erp' AND deleted_at IS NULL", [COMPANY]);
  if (!app) throw new Error('This company needs the cf_erp app.');
  const stamp = Date.now();

  console.log('1. the catalog');
  const [feat] = await db.query("SELECT feature_tag FROM features WHERE deleted_at IS NULL AND feature_tag LIKE 'cf\\_erp\\_%'");
  const placed = new Set([...cat.departments.flatMap((d) => d.levels.flatMap((l) => l.tags)), ...cat.approvals.map((a) => a.tag), ...cat.switches.flatMap((s) => s.tags)]);
  const homeless = feat.map((f) => f.feature_tag).filter((x) => !placed.has(x));
  ok('every cf_erp tag in the database has a place in the catalog', homeless.length === 0, homeless.join(' '));
  const unknown = [...placed].filter((x) => !feat.some((f) => f.feature_tag === x));
  ok('and the catalog names no tag that does not exist', unknown.length === 0, unknown.join(' '));
  const stores = cat.departments.find((d) => d.key === 'stores');
  ok('levels read back: none, view, manage, custom',
    S.levelOf(stores, new Set()) === 'none' && S.levelOf(stores, new Set(['cf_erp_inventory_view'])) === 'view'
    && S.levelOf(stores, new Set(['cf_erp_inventory_view', 'cf_erp_inventory_manage', 'cf_erp_stores'])) === 'manage' && S.levelOf(stores, new Set(['cf_erp_stores'])) === 'custom');
  const stdStores = cat.standardRoles.find((s) => s.key === 'stores');
  ok('the standard Stores role is seven permissions (2026-11-23: catalog manage — the catalog sits in Stores)', S.standardTags(cat, stdStores).length === 7 && S.standardTags(cat, stdStores).includes('cf_erp_catalog_manage'), S.standardTags(cat, stdStores).join(' '));
  ok('the standard MD role is every permission', S.standardTags(cat, cat.standardRoles.find((s) => s.key === 'md')).length === placed.size);
  ok('every standard role names real departments, levels, approvals and switches', cat.standardRoles.every((s) =>
    Object.entries(s.levels).every(([d, l]) => cat.departments.find((x) => x.key === d)?.levels.some((x) => x.key === l))
    && s.approvals.every((a) => cat.approvals.some((x) => x.tag === a)) && s.switches.every((k) => cat.switches.some((x) => x.key === k))));

  console.log('2. roles');
  let role = await S.createRole(db, c, { name: `T Stores ${stamp}`, standard: { appId: app.id, key: 'stores' } });
  let ra = role.apps.find((a) => a.appId === app.id);
  ok('a role from the standard Stores role: stores manage, sales view, one approval', ra.departments.find((d) => d.key === 'stores').level === 'manage'
    && ra.departments.find((d) => d.key === 'sales').level === 'view' && ra.approvals.filter((a) => a.on).length === 1 && ra.standard?.differs === false, JSON.stringify(ra.tags));
  const [[rows1]] = await db.query('SELECT COUNT(*) AS n FROM role_capability WHERE role_id = ? AND app_id = ? AND deleted_at IS NULL', [role.id, app.id]);
  ok('one grant row a permission', rows1.n === 7);
  role = await S.saveRole(db, c, role.id, { apps: { [app.id]: { tags: [...ra.tags, 'cf_erp_maintenance'] } } });
  ra = role.apps.find((a) => a.appId === app.id);
  ok('maintenance added: the level reads Manage, and it now differs from the standard', ra.departments.find((d) => d.key === 'maintenance').level === 'manage' && ra.standard.differs === true);
  const copy = await S.createRole(db, c, { name: `T Stores copy ${stamp}`, copyOf: role.id });
  ok('a copy holds the same eight', copy.apps.find((a) => a.appId === app.id).tags.length === 8);
  role = await S.resetRole(db, c, role.id, { appId: app.id });
  ok('reset to standard: seven again, no difference', role.apps.find((a) => a.appId === app.id).tags.length === 7 && role.apps.find((a) => a.appId === app.id).standard.differs === false);
  ok('a second role of the same name is refused', (await refusal(S.createRole(db, c, { name: `t stores ${stamp}` })))?.code === 'INVALID');
  ok('a role cannot be called admin', /every check/.test((await refusal(S.createRole(db, c, { name: 'Admin' })))?.message ?? ''));
  ok('a tag that is not the app\'s is refused', (await refusal(S.saveRole(db, c, role.id, { apps: { [app.id]: { tags: ['nonsense_tag'] } } })))?.code === 'INVALID');
  const empty = await S.createRole(db, c, { name: `T Empty ${stamp}` });
  ok('a blank role has nothing', empty.apps.find((a) => a.appId === app.id).tags.length === 0);
  const list = await S.listRoles(db, COMPANY);
  ok('the list knows which are standard and which changed', list.roles.find((r) => r.id === role.id)?.standard?.differs === false && list.roles.find((r) => r.id === copy.id)?.standard?.differs === true
    && list.apps.find((a) => a.slug === 'cf_erp')?.standards.length === cat.standardRoles.length);

  console.log('3. people');
  const made = await S.createPerson(db, c, { name: 'Test Keeper', login: `keeper${stamp}`, apps: { [app.id]: role.id } });
  ok('added with a username: a temporary password, must change it', /^[A-Z][a-z]{4}-\d{4}$/.test(made.tempPassword) && made.person.mustChangePassword && made.person.username === `keeper${stamp}` && made.person.email === null);
  const [[u1]] = await db.query('SELECT password, email, role_id FROM users WHERE id = ?', [made.person.id]);
  ok('the password is stored hashed and is the one shown', await bcrypt.compare(made.tempPassword, u1.password) && /\.login$/.test(u1.email));
  ok('their role in the app, and the base role set because it was empty', made.person.apps[0]?.roleId === role.id && Number(u1.role_id) === role.id);
  ok('what they hold is the role\'s seven', made.person.apps[0].tags.length === 7 && made.person.apps[0].tags.includes('cf_erp_stores'));
  const p2 = await S.createPerson(db, c, { name: 'Test Mail', login: `mail${stamp}@example.com`, apps: {} });
  ok('added with an email and no app yet', p2.person.email === `mail${stamp}@example.com` && p2.person.apps.length === 0);
  ok('the same login twice is refused', (await refusal(S.createPerson(db, c, { name: 'X', login: `keeper${stamp}` })))?.code === 'INVALID'
    && (await refusal(S.createPerson(db, c, { name: 'X', login: `mail${stamp}@example.com` })))?.code === 'INVALID');
  ok('a login that is neither is refused in words', /username is 3 to 40/.test(said(await refusal(S.createPerson(db, c, { name: 'X', login: 'a b' })))));
  let kp = await S.updatePerson(db, c, made.person.id, { apps: { [app.id]: copy.id }, name: 'Test Keeper II' });
  ok('role changed and renamed', kp.apps[0].roleId === copy.id && kp.name === 'Test Keeper II' && kp.apps[0].tags.length === 8);
  kp = await S.updatePerson(db, c, made.person.id, { apps: { [app.id]: null } });
  ok('access taken away', kp.apps.length === 0);
  kp = await S.updatePerson(db, c, made.person.id, { apps: { [app.id]: role.id } });
  const [[xr]] = await db.query('SELECT COUNT(*) AS n FROM app_user_access WHERE user_id = ? AND app_id = ?', [made.person.id, app.id]);
  ok('and given back — the same row, not a second one', kp.apps[0]?.roleId === role.id && xr.n === 1);
  const reset = await S.resetPassword(db, c, made.person.id);
  const [[u2]] = await db.query('SELECT password, must_change_password FROM users WHERE id = ?', [made.person.id]);
  ok('a reset makes a new temporary password', reset.tempPassword !== made.tempPassword && await bcrypt.compare(reset.tempPassword, u2.password) && u2.must_change_password === 1);
  const cSelf = { companyId: COMPANY, userId: made.person.id, userName: 'Test Keeper II' };
  ok('a wrong current password is refused', (await refusal(S.changeOwnPassword(db, cSelf, { current: 'nope-nope', next: 'Longer-pass-1' })))?.code === 'WRONG_PASSWORD');
  ok('too short is refused', (await refusal(S.changeOwnPassword(db, cSelf, { current: reset.tempPassword, next: 'short' })))?.code === 'INVALID');
  await S.changeOwnPassword(db, cSelf, { current: reset.tempPassword, next: 'Longer-pass-1' });
  const [[u3]] = await db.query('SELECT must_change_password FROM users WHERE id = ?', [made.person.id]);
  ok('changing it clears "must change"', u3.must_change_password === 0);
  const off = await S.setActive(db, c, made.person.id, false);
  ok('deactivated: not active, still listed', off.active === false && (await S.listPeople(db, COMPANY)).people.some((p) => p.id === made.person.id && !p.active));
  ok('a deactivated person is refused at sign-in', !!L.loginRefusal({ deactivated_at: new Date() }) && L.loginRefusal({}) === null);
  ok('a login is an email or a username', L.validLogin('a@b.co') && L.validLogin('keeper1') && !L.validLogin('a b') && !L.validLogin('x'));
  ok('made active again', (await S.setActive(db, c, made.person.id, true)).active === true);

  console.log('4. admins and safety');
  ok('the signed-in admin passes', await S.isCompanyAdmin(db, { id: me.id, companyId: COMPANY, role: 'whatever' }));
  ok('someone without the tick does not', !(await S.isCompanyAdmin(db, { id: made.person.id, companyId: COMPANY, role: 'Stores' })));
  ok('the same id under another company does not', !(await S.isCompanyAdmin(db, { id: me.id, companyId: COMPANY + 999999, role: 'x' })));
  ok('you cannot take your own tick', /yourself/.test(said(await refusal(S.updatePerson(db, c, me.id, { admin: false })))));
  ok('you cannot deactivate yourself', (await refusal(S.setActive(db, c, me.id, false)))?.code === 'SELF');
  await S.updatePerson(db, c, made.person.id, { admin: true });
  ok('a second admin, by the tick', await S.isCompanyAdmin(db, { id: made.person.id, companyId: COMPANY, role: 'Stores' }));
  ok('a role people hold cannot be removed', (await refusal(S.deleteRole(db, c, role.id)))?.code === 'IN_USE');
  ok('a role nobody holds can', (await S.deleteRole(db, c, empty.id)).removed === true);
  const [[other]] = await db.query('SELECT id FROM roles WHERE company_id <> ? AND deleted_at IS NULL LIMIT 1', [COMPANY]);
  if (other) {
    ok('another company\'s role cannot be read', (await refusal(S.getRole(db, COMPANY, other.id)))?.code === 'NOT_FOUND');
    ok('nor given to a person here', (await refusal(S.updatePerson(db, c, made.person.id, { apps: { [app.id]: other.id } })))?.code === 'INVALID');
  }
  const [[foreign]] = await db.query('SELECT id FROM users WHERE company_id <> ? LIMIT 1', [COMPANY]);
  if (foreign) ok('another company\'s person cannot be opened', (await refusal(S.getPerson(db, COMPANY, foreign.id)))?.code === 'NOT_FOUND');

  console.log('5. several at once, and the history');
  const bulkBad = await refusal(S.createPeople(db, c, { appId: app.id, rows: [{ name: 'A One', login: `a1${stamp}`, role: role.name }, { name: 'B Two', login: `b2${stamp}`, role: 'No Such Role' }] }));
  const [[n0]] = await db.query('SELECT COUNT(*) AS n FROM users WHERE username IN (?, ?)', [`a1${stamp}`, `b2${stamp}`]);
  ok('one bad row: nobody is added, and the row is named', /Row 2/.test(said(bulkBad)) && n0.n === 0, said(bulkBad));
  const bulk = await S.createPeople(db, c, { appId: app.id, rows: [{ name: 'A One', login: `a1${stamp}`, role: role.name.toLowerCase() }, { name: 'B Two', login: `b2${stamp}@example.com`, role: copy.name }] });
  ok('two good rows: two people, each with a password and a role', bulk.added.length === 2 && bulk.added.every((x) => x.tempPassword && x.role));
  const h = await S.history(db, COMPANY, { limit: 50 });
  ok('every change left a line, with who', h.length >= 12 && h.every((x) => x.summary && x.by === me.name) && h.some((x) => x.action === 'role_changed' && /cf_erp_maintenance/.test(x.summary)));
  const ov = await S.overview(db, COMPANY);
  ok('the apps of the company, with people and roles', ov.apps.some((a) => a.slug === 'cf_erp' && a.people >= 3 && a.hasCatalog));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
} catch (e) {
  console.log('THREW:', e.message, e.problems ?? '', '\n', e.stack?.split('\n').slice(1, 5).join('\n'));
  process.exitCode = 1;
} finally {
  try { await db.rollback(); } catch { /* going back anyway */ }
  db.release(); await pool.end();
}
