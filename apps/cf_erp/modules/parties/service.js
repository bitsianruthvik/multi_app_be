/**
 * service.js — parties: customers, suppliers, subcontractors.
 *
 * The module may not import its host (see index.js), so the host tells it what
 * references a party through registerReferenceCheck: a deletion asks every
 * check and is refused while any of them finds a use.
 */
import { PartyError } from './errors.js';

const CODE_RE = /^[A-Za-z0-9][A-Za-z0-9_\-./]*$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ROLES = { customer: 'is_customer', supplier: 'is_supplier', subcontractor: 'is_subcontractor' };

const referenceChecks = [];

/** fn(db, companyId, partyId) -> [ 'text naming each use' ] */
export function registerReferenceCheck(fn) {
  referenceChecks.push(fn);
}

const blank = (v) => v == null || String(v).trim() === '';

function shape(p) {
  return {
    id: p.id,
    code: p.code,
    name: p.name,
    roles: Object.entries(ROLES).filter(([, col]) => Number(p[col])).map(([role]) => role),
    taxNumber: p.tax_number,
    contactName: p.contact_name,
    email: p.email,
    phone: p.phone,
    address: p.address,
    notes: p.notes,
    status: p.status,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
  };
}

function readBody(input, existing = null) {
  const problems = [];
  const out = {};
  const text = (key, col, max, required = false) => {
    if (input[key] === undefined) {
      if (!existing && required) problems.push(`${key === 'code' ? 'Code' : 'Name'} is required.`);
      return;
    }
    const v = blank(input[key]) ? null : String(input[key]).trim();
    if (required && !v) problems.push(`${key === 'code' ? 'Code' : 'Name'} is required.`);
    if (v && v.length > max) problems.push(`${key} is up to ${max} characters.`);
    out[col] = v;
  };
  text('code', 'code', 50, true);
  text('name', 'name', 255, true);
  text('taxNumber', 'tax_number', 50);
  text('contactName', 'contact_name', 255);
  text('email', 'email', 255);
  text('phone', 'phone', 50);
  if (input.address !== undefined) out.address = blank(input.address) ? null : String(input.address);
  if (input.notes !== undefined) out.notes = blank(input.notes) ? null : String(input.notes);
  if (out.code && !CODE_RE.test(out.code)) problems.push('Code: letters, digits and - _ . /, no spaces.');
  if (out.email && !EMAIL_RE.test(out.email)) problems.push('That email address does not look right.');
  if (input.roles !== undefined) {
    const roles = Array.isArray(input.roles) ? input.roles : [];
    const bad = roles.filter((r) => !ROLES[r]);
    if (bad.length) problems.push(`Unknown role ${bad.join(', ')} — customer, supplier or subcontractor.`);
    for (const [role, col] of Object.entries(ROLES)) out[col] = roles.includes(role) ? 1 : 0;
    if (!roles.length) problems.push('Give the party at least one role.');
  } else if (!existing) {
    problems.push('Give the party at least one role.');
  }
  if (input.status !== undefined) {
    if (!['active', 'inactive'].includes(input.status)) problems.push('Status is active or inactive.');
    out.status = input.status;
  }
  if (problems.length) throw new PartyError(422, 'INVALID', 'Some fields need attention.', { problems });
  return out;
}

export async function listParties(db, companyId, q = {}) {
  const where = ['company_id = ?', 'deleted_at IS NULL'];
  const params = [companyId];
  if (!blank(q.role)) {
    const col = ROLES[q.role];
    if (!col) throw new PartyError(422, 'INVALID', 'Role is customer, supplier or subcontractor.');
    where.push(`${col} = 1`);
  }
  if (!blank(q.status)) { where.push('status = ?'); params.push(q.status); }
  if (!blank(q.search)) {
    const like = `%${String(q.search).trim().replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    where.push('(code LIKE ? OR name LIKE ? OR contact_name LIKE ?)');
    params.push(like, like, like);
  }
  const limit = Math.min(Math.max(Number(q.limit) || 200, 1), 500);
  const [rows] = await db.query(`SELECT * FROM cf_parties WHERE ${where.join(' AND ')} ORDER BY name, id LIMIT ?`, [...params, limit]);
  return rows.map(shape);
}

async function requireParty(db, companyId, id) {
  const [[p]] = await db.query('SELECT * FROM cf_parties WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, id]);
  if (!p) throw new PartyError(404, 'NOT_FOUND', 'Party not found.');
  return p;
}

export async function getParty(db, companyId, id) {
  return shape(await requireParty(db, companyId, id));
}

export async function createParty(db, c, input = {}) {
  const body = readBody(input);
  const cols = Object.keys(body);
  const [r] = await db.query(
    `INSERT INTO cf_parties (company_id, ${cols.join(', ')}, created_by) VALUES (?, ${cols.map(() => '?').join(', ')}, ?)`,
    [c.companyId, ...Object.values(body), c.userId],
  );
  return getParty(db, c.companyId, r.insertId);
}

export async function updateParty(db, c, id, input = {}) {
  const existing = await requireParty(db, c.companyId, id);
  const body = readBody(input, existing);
  if (Object.keys(body).length) {
    await db.query(`UPDATE cf_parties SET ${Object.keys(body).map((k) => `${k} = ?`).join(', ')} WHERE company_id = ? AND id = ?`,
      [...Object.values(body), c.companyId, id]);
  }
  return getParty(db, c.companyId, id);
}

export async function deleteParty(db, c, id) {
  const p = await requireParty(db, c.companyId, id);
  const uses = [];
  for (const check of referenceChecks) uses.push(...(await check(db, c.companyId, id)));
  if (uses.length) {
    throw new PartyError(409, 'IN_USE', `${p.name} cannot be deleted: ${uses.join('; ')}. Mark it inactive instead.`, { problems: uses });
  }
  await db.query('UPDATE cf_parties SET deleted_at = NOW() WHERE company_id = ? AND id = ?', [c.companyId, id]);
  return { ok: true };
}
