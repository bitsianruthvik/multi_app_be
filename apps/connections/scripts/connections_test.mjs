/**
 * The connections app against the local DB, with Microsoft stubbed: no call leaves
 * this machine. Uses company `karni` and removes the rows it makes.
 *
 *   node apps/connections/scripts/connections_test.mjs
 */
import 'dotenv/config';
import { pool } from '../../../db.js';

process.env.CONNECTIONS_KEY = 'ab'.repeat(32);
const { seal, unseal } = await import('../lib/secrets.js');
const { parseLocation } = await import('../providers/onedrive.js');
const service = await import('../services/connectionService.js');

let passed = 0;
let failed = 0;
const check = (label, ok, extra = '') => {
  if (ok) passed += 1; else failed += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : ` ${extra}`}`);
};
const refuses = async (label, fn, status) => {
  try { await fn(); check(label, false, '(did not refuse)'); } catch (e) { check(label, e.status === status, `(${e.status} ${e.message})`); }
};

// ─── Addresses ───
const fromBrowser = parseLocation('https://sumangalforging-my.sharepoint.com/personal/sales_sumangalcasting_com/_layouts/15/onedrive.aspx?e=5%3AxiTJzS&at=9&id=%2Fpersonal%2Fsales_sumangalcasting_com%2FDocuments%2FERP%20Data%2F2026_BACKUP');
check('browser address: site', fromBrowser.sitePath === '/personal/sales_sumangalcasting_com');
check('browser address: library', fromBrowser.library === 'Documents');
check('browser address: folder', fromBrowser.folderPath === 'ERP Data/2026_BACKUP', fromBrowser.folderPath);
const plain = parseLocation('https://acme.sharepoint.com/sites/Finance/Shared%20Documents/Exports');
check('site path: library', plain.library === 'Shared Documents' && plain.folderPath === 'Exports');
const rootPage = parseLocation('https://acme-my.sharepoint.com/personal/a_b_com/_layouts/15/onedrive.aspx');
check('OneDrive home page: its root', rootPage.library === null && rootPage.folderPath === '');
check('sharing link', parseLocation('https://acme-my.sharepoint.com/:f:/g/personal/a_b_com/AbC?e=1').kind === 'share');
await refuses('another host refused', async () => parseLocation('https://evil.example.com/personal/a/Documents'), 400);
await refuses('a lookalike host refused', async () => parseLocation('https://sharepoint.com.evil.example/personal/a'), 400);
await refuses('http refused', async () => parseLocation('http://acme.sharepoint.com/sites/x'), 400);

// ─── Secrets ───
const sealed = seal({ clientSecret: 'hush-123' });
check('sealed text does not hold the secret', !sealed.includes('hush-123'));
check('secret round trip', unseal(sealed).clientSecret === 'hush-123');
const [ver, iv, tag, body] = sealed.split(':');
const flipped = Buffer.from(body, 'base64');
flipped[0] ^= 1;
await refuses('tampered secret refused', async () => unseal([ver, iv, tag, flipped.toString('base64')].join(':')), 409);

// ─── Microsoft, stubbed ───
const ROOT = '/drives/D1/root:/ERP';
const calls = [];
let tokenOk = true;
let denyGraph = false;
const answer = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  calls.push({ method: init.method || 'GET', url: u });
  if (u.startsWith('https://login.microsoftonline.com/')) {
    return tokenOk ? answer(200, { access_token: 'tok', expires_in: 3600 })
      : answer(401, { error: 'invalid_client', error_description: 'AADSTS7000215: Invalid client secret provided.' });
  }
  if (denyGraph) return answer(403, { error: { message: 'Access denied' } });
  const path = decodeURIComponent(u.replace('https://graph.microsoft.com/v1.0', '').split('?')[0]);
  if (path === '/sites/acme-my.sharepoint.com:/personal/a_b_com') return answer(200, { id: 'S1' });
  if (path === '/sites/S1/drives') return answer(200, { value: [{ id: 'D1', name: 'OneDrive', webUrl: 'https://acme-my.sharepoint.com/personal/a_b_com/Documents' }] });
  if (path === '/drives/D1/root:/ERP') return answer(200, { id: 'F1', name: 'ERP', folder: { childCount: 2 }, webUrl: 'https://x/ERP', parentReference: { path: '/drives/D1/root:' } });
  if (path === '/drives/D1/items/F1/children') {
    return u.includes('page2')
      ? answer(200, { value: [{ id: 'F2', name: 'Old', folder: {} }] })
      : answer(200, {
        value: [{ id: 'A1', name: 'sales.csv', size: 12, file: {}, lastModifiedDateTime: '2026-11-01T00:00:00Z', eTag: 'e1' }],
        '@odata.nextLink': 'https://graph.microsoft.com/v1.0/drives/D1/items/F1/children?page2',
      });
  }
  if (path === '/drives/D1/items/F2/children') return answer(200, { value: [] });
  if (path === '/drives/D1/items/A1') return answer(200, { id: 'A1', name: 'sales.csv', size: 12, file: {}, parentReference: { path: ROOT } });
  if (path === '/drives/D1/items/A1/content') return new Response('a,b\n1,2\n');
  if (path === '/drives/D1/items/F2') return answer(200, { id: 'F2', name: 'Old', folder: {}, parentReference: { path: ROOT } });
  if (path === '/drives/D1/items/OUT') return answer(200, { id: 'OUT', name: 'payroll.xlsx', file: {}, parentReference: { path: '/drives/D1/root:/HR' } });
  if (path === '/drives/D1/items/SIB') return answer(200, { id: 'SIB', name: 'x.csv', file: {}, parentReference: { path: '/drives/D1/root:/ERP2' } });
  return answer(404, { error: { message: `no stub for ${path}` } });
};

// ─── The service ───
const [[karni]] = await pool.query("SELECT id FROM companies WHERE slug = 'karni'");
const [[other]] = await pool.query("SELECT id FROM companies WHERE slug = 'placebo'");
const values = {
  folderUrl: 'https://acme-my.sharepoint.com/personal/a_b_com/_layouts/15/onedrive.aspx?id=%2Fpersonal%2Fa_b_com%2FDocuments%2FERP',
  tenantId: 'acme.onmicrosoft.com',
  clientId: '11111111-2222-3333-4444-555555555555',
  clientSecret: 'hush-123',
};
const made = [];
try {
  await refuses('unknown provider refused', () => service.create(karni.id, { provider: 'ftp', name: 'x', values }), 400);
  await refuses('missing secret refused', () => service.create(karni.id, { provider: 'onedrive', name: 'x', values: { ...values, clientSecret: '' } }), 400);
  await refuses('missing name refused', () => service.create(karni.id, { provider: 'onedrive', name: ' ', values }), 400);

  const c = await service.create(karni.id, { provider: 'onedrive', name: 'Connection test', values }, 1);
  made.push(c.id);
  check('new connection is untested', c.status === 'untested');
  check('no answer holds the secret', !JSON.stringify(c).includes('hush-123'));
  check('says the secret is stored', c.secretsSet.includes('clientSecret'));
  const [[stored]] = await pool.query('SELECT config, secret_enc FROM conn_connections WHERE id = ?', [c.id]);
  check('secret not stored in the clear', !JSON.stringify(stored).includes('hush-123'));
  await refuses('files before a test refused', () => service.listFiles(karni.id, c.id), 409);

  await refuses('another company cannot read it', () => service.listFiles(other.id, c.id), 404);
  await refuses('another company cannot test it', () => service.test(other.id, c.id), 404);
  await refuses('another company cannot delete it', () => service.remove(other.id, c.id), 404);

  const good = await service.test(karni.id, c.id);
  check('test passes', good.connection.status === 'ok', good.connection.lastError);
  check('test finds the folder', good.connection.folderName === 'ERP' && /2 items/.test(good.summary));

  const files = await service.listFiles(karni.id, c.id);
  check('lists every page', files.length === 2 && files[0].name === 'sales.csv' && files[1].kind === 'folder');
  check('a subfolder inside can be listed', Array.isArray(await service.listFiles(karni.id, c.id, 'F2')));
  await refuses('a file outside the folder refused', () => service.openFile(karni.id, c.id, 'OUT'), 403);
  await refuses('a folder whose name starts the same refused', () => service.openFile(karni.id, c.id, 'SIB'), 403);
  await refuses('a bad id refused', () => service.listFiles(karni.id, c.id, '../../me'), 400);
  await refuses('a folder is not opened as a file', () => service.openFile(karni.id, c.id, 'F2'), 400);
  const opened = await service.openFile(karni.id, c.id, 'A1');
  check('reads a file', (await new Response(opened.stream).text()) === 'a,b\n1,2\n' && opened.name === 'sales.csv');

  const writes = calls.filter((x) => x.method !== 'GET' && !x.url.startsWith('https://login.microsoftonline.com/'));
  check('only GET ever reaches Microsoft Graph', writes.length === 0, JSON.stringify(writes));
  const tokenCalls = calls.filter((x) => x.url.startsWith('https://login.microsoftonline.com/'));
  check('the sign-in is reused', tokenCalls.length === 1, String(tokenCalls.length));

  denyGraph = true;
  const denied = await service.test(karni.id, c.id);
  check('no access is reported, not thrown', denied.connection.status === 'error' && /admin must grant/.test(denied.connection.lastError));
  denyGraph = false;

  const blank = await service.update(karni.id, c.id, { name: 'Renamed', values: { ...values, clientSecret: '' } });
  check('a change needs a new test', blank.status === 'untested' && blank.name === 'Renamed' && !blank.folderName);
  check('a blank secret keeps the stored one', blank.secretsSet.includes('clientSecret'));
  await refuses('files after a change refused until tested', () => service.listFiles(karni.id, c.id), 409);

  tokenOk = false;
  const wrong = await service.update(karni.id, c.id, { name: 'Renamed', values: { ...values, clientSecret: 'wrong-secret' } });
  const bad = await service.test(karni.id, wrong.id);
  check('a wrong secret says Microsoft refused', bad.connection.status === 'error' && /AADSTS7000215/.test(bad.connection.lastError), bad.connection.lastError);
  check('the error does not echo the secret', !bad.connection.lastError.includes('wrong-secret'));

  await service.remove(karni.id, c.id);
  check('a deleted connection is gone', !(await service.list(karni.id)).some((x) => x.id === c.id));
  const [[gone]] = await pool.query('SELECT secret_enc FROM conn_connections WHERE id = ?', [c.id]);
  check('deleting wipes its secret', gone.secret_enc === null);
} finally {
  if (made.length) await pool.query('DELETE FROM conn_connections WHERE id IN (?)', [made]);
  await pool.end();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
