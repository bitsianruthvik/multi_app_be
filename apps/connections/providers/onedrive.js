import crypto from 'crypto';

/**
 * OneDrive / SharePoint folder, read through Microsoft Graph.
 *
 * Signs in as an app registered in the CUSTOMER's Microsoft Entra tenant (client
 * credentials), so nothing depends on a person's login. Their admin gives that app
 * read access, ideally `Sites.Selected` on this one site.
 *
 * READ-ONLY: the only POST is the token request; graphGet cannot send anything else.
 */
const GRAPH = 'https://graph.microsoft.com/v1.0';
const LOGIN = 'https://login.microsoftonline.com';
const MAX_FILES = 5000;
const ITEM_FIELDS = 'id,name,size,file,folder,lastModifiedDateTime,eTag,webUrl,parentReference';

const fail = (status, message) => Object.assign(new Error(message), { status });
const encodePath = (p) => p.split('/').filter(Boolean).map(encodeURIComponent).join('/');

/**
 * What a pasted address points at. Takes the browser's address bar on the folder
 * (…/_layouts/15/onedrive.aspx?id=/personal/x/Documents/Folder, or a plain
 * /sites/x/Shared Documents/Folder) or a sharing link (…/:f:/g/personal/x/abc).
 */
export function parseLocation(text) {
  let url;
  try { url = new URL(String(text || '').trim()); } catch { throw fail(400, 'The folder address is not a valid link.'); }
  if (url.protocol !== 'https:' || !/^[a-z0-9-]+(\.[a-z0-9-]+)*\.sharepoint\.com$/i.test(url.hostname)) {
    throw fail(400, 'The folder address must be an https link on sharepoint.com.');
  }
  if (/^\/:[a-z]:\//i.test(url.pathname)) {
    return { kind: 'share', shareId: `u!${Buffer.from(url.href).toString('base64url')}` };
  }
  const serverPath = url.searchParams.get('id') || decodeURIComponent(url.pathname);
  const m = /^\/((?:personal|sites|teams)\/[^/]+)(?:\/(.*))?$/i.exec(serverPath);
  if (!m) throw fail(400, 'Open the folder in the browser and paste the address from the address bar.');
  const rest = (m[2] || '').split('/').filter(Boolean);
  const isPage = rest[0]?.toLowerCase() === '_layouts' || rest.at(-1)?.toLowerCase().endsWith('.aspx');
  const parts = isPage ? [] : rest;
  return {
    kind: 'path',
    hostname: url.hostname.toLowerCase(),
    sitePath: `/${m[1]}`,
    library: parts[0] ?? null,
    folderPath: parts.slice(1).join('/'),
  };
}

const tokens = new Map(); // tenant|client|secret hash -> { token, expiresAt }

async function getToken({ config, secrets }) {
  const id = [config.tenantId, config.clientId, crypto.createHash('sha256').update(secrets.clientSecret || '').digest('hex')].join('|');
  const have = tokens.get(id);
  if (have && have.expiresAt > Date.now() + 60000) return have.token;

  const res = await fetch(`${LOGIN}/${encodeURIComponent(config.tenantId)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: config.clientId,
      client_secret: secrets.clientSecret || '',
      scope: 'https://graph.microsoft.com/.default',
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    // Microsoft's description names the problem (AADSTS code) and holds no secret.
    const why = String(body.error_description || body.error || `status ${res.status}`).split('\r\n')[0];
    const short = why.length > 300 ? why.slice(0, why.lastIndexOf('. ', 300) + 1 || 300) : why;
    throw fail(502, `Microsoft refused the sign-in: ${short}`);
  }
  tokens.set(id, { token: body.access_token, expiresAt: Date.now() + (Number(body.expires_in) || 3000) * 1000 });
  return body.access_token;
}

async function graphResponse(conn, url) {
  // A paging link comes from Microsoft's answer; the token only ever goes to Graph.
  if (!url.startsWith(`${GRAPH}/`)) throw fail(502, 'Microsoft Graph returned an unexpected link.');
  const token = await getToken(conn);
  const res = await fetch(url, { method: 'GET', headers: { Authorization: `Bearer ${token}` } });
  if (res.ok) return res;
  const body = await res.json().catch(() => ({}));
  const detail = body?.error?.message ? ` (${String(body.error.message).slice(0, 200)})` : '';
  if (res.status === 401 || res.status === 403) {
    throw fail(502, `The app has no access to this folder. The customer's admin must grant it read access${detail}.`);
  }
  if (res.status === 404) throw fail(502, `Microsoft cannot find this folder${detail}.`);
  if (res.status === 429 || res.status === 503) throw fail(503, 'Microsoft asked us to slow down. Try again in a minute.');
  throw fail(502, `Microsoft Graph answered ${res.status}${detail}.`);
}

const graphGet = async (conn, url) => (await graphResponse(conn, url)).json();

const fullPath = (item) => `${item.parentReference?.path ?? ''}/${item.name}`;

/** Refuses an item outside the connected folder: an id from the screen is not trusted. */
async function itemInside(conn, id) {
  const { driveId, itemId, path } = conn.resolved || {};
  if (!driveId) throw fail(409, 'Test this connection first.');
  if (id === itemId) return { id: itemId, name: conn.resolved.name };
  if (!/^[A-Za-z0-9!_-]+$/.test(id)) throw fail(400, 'Bad item id.');
  const item = await graphGet(conn, `${GRAPH}/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(id)}?$select=${ITEM_FIELDS}`);
  if (!fullPath(item).startsWith(`${path}/`)) throw fail(403, 'That item is outside the connected folder.');
  return item;
}

async function findDrive(conn, loc) {
  const site = await graphGet(conn, `${GRAPH}/sites/${loc.hostname}:${loc.sitePath}?$select=id,webUrl`);
  const siteUrl = `${GRAPH}/sites/${encodeURIComponent(site.id)}`;
  if (!loc.library) return (await graphGet(conn, `${siteUrl}/drive?$select=id`)).id;
  const { value: drives = [] } = await graphGet(conn, `${siteUrl}/drives?$select=id,name,webUrl`);
  const wanted = loc.library.toLowerCase();
  const lastSegment = (u) => decodeURIComponent(String(u || '').split('/').pop()).toLowerCase();
  const drive = drives.find((d) => lastSegment(d.webUrl) === wanted) || drives.find((d) => d.name?.toLowerCase() === wanted);
  if (!drive) throw fail(502, `No document library "${loc.library}" on this site.`);
  return drive.id;
}

export default {
  key: 'onedrive',
  label: 'OneDrive / SharePoint',
  description: 'Read files from a OneDrive or SharePoint folder.',
  setupHelp: 'Needs an app registered in the customer\'s Microsoft Entra tenant, with read access to this folder. A person\'s own Microsoft login is not used.',
  fields: [
    { key: 'folderUrl', label: 'Folder address', required: true, placeholder: 'https://company-my.sharepoint.com/…', help: 'Open the folder in the browser and paste the address, or paste a sharing link.' },
    { key: 'tenantId', label: 'Tenant ID', required: true, help: 'From the customer\'s Microsoft Entra admin centre.' },
    { key: 'clientId', label: 'Client ID', required: true, help: 'The Application (client) ID of the registered app.' },
    { key: 'clientSecret', label: 'Client secret', required: true, secret: true, help: 'Stored encrypted and never shown again.' },
  ],

  validate(config) {
    parseLocation(config.folderUrl);
    const tenantId = String(config.tenantId || '').trim();
    const clientId = String(config.clientId || '').trim();
    if (!/^[A-Za-z0-9.-]{3,100}$/.test(tenantId)) throw fail(400, 'The tenant ID does not look right.');
    if (!/^[0-9a-fA-F-]{36}$/.test(clientId)) throw fail(400, 'The client ID does not look right.');
    return { folderUrl: String(config.folderUrl).trim(), tenantId, clientId };
  },

  async test(conn) {
    const loc = parseLocation(conn.config.folderUrl);
    let driveId;
    let folder;
    if (loc.kind === 'share') {
      folder = await graphGet(conn, `${GRAPH}/shares/${loc.shareId}/driveItem?$select=${ITEM_FIELDS}`);
      driveId = folder.parentReference?.driveId;
    } else {
      driveId = await findDrive(conn, loc);
      const where = loc.folderPath ? `root:/${encodePath(loc.folderPath)}` : 'root';
      folder = await graphGet(conn, `${GRAPH}/drives/${encodeURIComponent(driveId)}/${where}?$select=${ITEM_FIELDS}`);
    }
    if (!folder.folder) throw fail(400, 'That address is a file, not a folder.');
    const resolved = {
      driveId,
      itemId: folder.id,
      name: folder.name,
      webUrl: folder.webUrl,
      path: fullPath(folder),
    };
    const count = folder.folder.childCount;
    return { resolved, summary: `Connected to "${folder.name}"${count != null ? `: ${count} item${count === 1 ? '' : 's'}` : ''}.` };
  },

  async listFiles(conn, folderId) {
    const parent = await itemInside(conn, folderId || conn.resolved?.itemId || '');
    const files = [];
    let next = `${GRAPH}/drives/${encodeURIComponent(conn.resolved.driveId)}/items/${encodeURIComponent(parent.id)}/children?$select=${ITEM_FIELDS}&$top=200`;
    while (next && files.length < MAX_FILES) {
      const page = await graphGet(conn, next);
      for (const f of page.value || []) {
        files.push({
          id: f.id,
          name: f.name,
          kind: f.folder ? 'folder' : 'file',
          size: f.size ?? null,
          modifiedAt: f.lastModifiedDateTime ?? null,
          etag: f.eTag ?? null,
          webUrl: f.webUrl ?? null,
        });
      }
      next = page['@odata.nextLink'] || null;
    }
    return files;
  },

  async openFile(conn, fileId) {
    const item = await itemInside(conn, fileId);
    if (item.folder || !item.file) throw fail(400, 'That item is not a file.');
    const res = await graphResponse(conn, `${GRAPH}/drives/${encodeURIComponent(conn.resolved.driveId)}/items/${encodeURIComponent(item.id)}/content`);
    return { name: item.name, size: item.size ?? null, stream: res.body };
  },
};
