import { pool } from '../../../db.js';
import { describeProviders, getProvider } from '../providers/index.js';
import { seal, unseal } from '../lib/secrets.js';

/**
 * Connections of one company. Every read and write here takes companyId, and no
 * answer ever carries a secret: `secretsSet` only says which ones are stored.
 * Other apps use listFiles / openFile.
 */
const fail = (status, message) => Object.assign(new Error(message), { status });
const json = (v) => (typeof v === 'string' ? JSON.parse(v) : v ?? null);
const NAME_MAX = 120;

export { describeProviders };

function needProvider(key) {
  const provider = getProvider(key);
  if (!provider) throw fail(400, `Unknown kind of connection: ${key}`);
  return provider;
}

function toPublic(row) {
  const provider = getProvider(row.provider);
  let secretsSet = [];
  try {
    const held = unseal(row.secret_enc);
    secretsSet = Object.keys(held).filter((k) => held[k]);
  } catch { /* unreadable: nothing counts as set, so the form asks for it again */ }
  return {
    id: row.id,
    provider: row.provider,
    providerLabel: provider?.label ?? row.provider,
    name: row.name,
    config: json(row.config) ?? {},
    secretsSet,
    folderName: json(row.resolved)?.name ?? null,
    folderWebUrl: json(row.resolved)?.webUrl ?? null,
    status: row.status,
    lastError: row.last_error,
    lastCheckedAt: row.last_checked_at,
    createdAt: row.created_at,
  };
}

async function loadRow(companyId, id) {
  const [[row]] = await pool.query(
    'SELECT * FROM conn_connections WHERE id = ? AND company_id = ? AND deleted_at IS NULL', [id, companyId]);
  if (!row) throw fail(404, 'No such connection.');
  return row;
}

/** Splits what the form sent into stored config and secrets, by the provider's own fields. */
function splitValues(provider, values, heldSecrets = {}) {
  const secretFields = provider.fields.filter((f) => f.secret);
  const secrets = { ...heldSecrets };
  for (const f of secretFields) {
    if (values[f.key]) secrets[f.key] = String(values[f.key]); // blank keeps what is stored
    if (f.required && !secrets[f.key]) throw fail(400, `${f.label} is required.`);
  }
  const plain = {};
  for (const f of provider.fields.filter((x) => !x.secret)) {
    const v = String(values[f.key] ?? '').trim();
    if (f.required && !v) throw fail(400, `${f.label} is required.`);
    plain[f.key] = v;
  }
  return { config: provider.validate(plain), secrets };
}

const cleanName = (name) => {
  const n = String(name || '').trim();
  if (!n) throw fail(400, 'Give the connection a name.');
  return n.slice(0, NAME_MAX);
};

export async function list(companyId) {
  const [rows] = await pool.query(
    'SELECT * FROM conn_connections WHERE company_id = ? AND deleted_at IS NULL ORDER BY name', [companyId]);
  return rows.map(toPublic);
}

export async function create(companyId, { provider: key, name, values = {} }, userId) {
  const provider = needProvider(key);
  const { config, secrets } = splitValues(provider, values);
  const [r] = await pool.query(
    'INSERT INTO conn_connections (company_id, provider, name, config, secret_enc, created_by) VALUES (?, ?, ?, ?, ?, ?)',
    [companyId, key, cleanName(name), JSON.stringify(config), seal(secrets), userId ?? null]);
  return toPublic(await loadRow(companyId, r.insertId));
}

/** Any change sends it back to "untested", and the old folder ids are forgotten. */
export async function update(companyId, id, { name, values = {} }) {
  const row = await loadRow(companyId, id);
  const provider = needProvider(row.provider);
  const { config, secrets } = splitValues(provider, values, unseal(row.secret_enc));
  await pool.query(
    `UPDATE conn_connections SET name = ?, config = ?, secret_enc = ?, resolved = NULL,
            status = 'untested', last_error = NULL, last_checked_at = NULL WHERE id = ? AND company_id = ?`,
    [cleanName(name), JSON.stringify(config), seal(secrets), id, companyId]);
  return toPublic(await loadRow(companyId, id));
}

export async function remove(companyId, id) {
  await loadRow(companyId, id);
  await pool.query(
    'UPDATE conn_connections SET deleted_at = NOW(), secret_enc = NULL WHERE id = ? AND company_id = ?', [id, companyId]);
}

const context = (row) => ({ config: json(row.config) ?? {}, secrets: unseal(row.secret_enc), resolved: json(row.resolved) });

/** Tries the link now and stores the outcome. A failure is an answer, not an error. */
export async function test(companyId, id) {
  const row = await loadRow(companyId, id);
  const provider = needProvider(row.provider);
  let summary = null;
  try {
    const out = await provider.test(context(row));
    summary = out.summary;
    await pool.query(
      `UPDATE conn_connections SET status = 'ok', last_error = NULL, resolved = ?, last_checked_at = NOW() WHERE id = ?`,
      [JSON.stringify(out.resolved), id]);
  } catch (err) {
    await pool.query(
      `UPDATE conn_connections SET status = 'error', last_error = ?, last_checked_at = NOW() WHERE id = ?`,
      [String(err.message).slice(0, 500), id]);
  }
  return { connection: toPublic(await loadRow(companyId, id)), summary };
}

export async function listFiles(companyId, id, folderId) {
  const row = await loadRow(companyId, id);
  return needProvider(row.provider).listFiles(context(row), folderId);
}

export async function openFile(companyId, id, fileId) {
  const row = await loadRow(companyId, id);
  return needProvider(row.provider).openFile(context(row), fileId);
}
