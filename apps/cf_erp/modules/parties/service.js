/**
 * service.js — parties: customers, suppliers, subcontractors.
 *
 * The module may not import its host (see index.js), so the host tells it what
 * references a party through registerReferenceCheck: a deletion asks every
 * check and is refused while any of them finds a use.
 */
import { PartyError } from './errors.js';
import { validateGstin, readStateCode, stateName, FOREIGN_STATE } from './gstin.js';

const CODE_RE = /^[A-Za-z0-9][A-Za-z0-9_\-./]*$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ROLES = { customer: 'is_customer', supplier: 'is_supplier', subcontractor: 'is_subcontractor' };
/** How a party is registered for GST (CF_ERP_GST_PLAN §1). */
export const GST_REGISTRATIONS = ['regular', 'composition', 'unregistered', 'sez', 'overseas'];
/** Registrations whose tax number must be a real GSTIN. An overseas party's is its own country's number. */
const NEEDS_GSTIN = new Set(['regular', 'composition', 'sez']);
const PIN_RE = /^[1-9]\d{5}$/;

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
    // GST ("GST identity" in this module's init.sql): tax_number IS the GSTIN.
    gstin: p.tax_number,
    gstRegistration: p.gst_registration ?? 'regular',
    stateCode: p.state_code ?? null,
    stateName: stateName(p.state_code),
    city: p.city ?? null,
    pincode: p.pincode ?? null,
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

function readBody(rawInput, existing = null) {
  // `gstin` is another name for taxNumber (the contract's word for it).
  const input = rawInput.gstin !== undefined && rawInput.taxNumber === undefined ? { ...rawInput, taxNumber: rawInput.gstin } : rawInput;
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
  text('city', 'city', 100);
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
  readGst(input, existing, out, problems);
  if (problems.length) throw new PartyError(422, 'INVALID', 'Some fields need attention.', { problems });
  return out;
}

/**
 * GSTIN, registration, state and PIN code. The GSTIN is checked (pattern, state,
 * mod-36 check character) whenever it, the registration or the state is sent,
 * for a registration that has one; its first two digits then SET the state.
 * Checking only what was sent keeps an old party with an odd tax number editable.
 */
function readGst(input, existing, out, problems) {
  if (input.gstRegistration !== undefined) {
    if (!GST_REGISTRATIONS.includes(input.gstRegistration)) problems.push('GST registration is regular, composition, unregistered, SEZ or overseas.');
    else out.gst_registration = input.gstRegistration;
  }
  if (input.pincode !== undefined) {
    const pin = blank(input.pincode) ? null : String(input.pincode).replace(/\s+/g, '');
    if (pin && !PIN_RE.test(pin)) problems.push('A PIN code is 6 digits.');
    out.pincode = pin;
  }
  let typedState;
  if (input.stateCode !== undefined) {
    typedState = readStateCode(input.stateCode);
    if (typedState === undefined) problems.push(`${input.stateCode} is not a GST state code.`);
    else out.state_code = typedState;
  }
  const touched = input.taxNumber !== undefined || input.gstRegistration !== undefined || input.stateCode !== undefined;
  if (!touched) return;
  const registration = out.gst_registration ?? existing?.gst_registration ?? 'regular';
  const taxNumber = out.tax_number !== undefined ? out.tax_number : existing?.tax_number ?? null;
  if (taxNumber && NEEDS_GSTIN.has(registration)) {
    const v = validateGstin(taxNumber);
    if (!v.valid) { problems.push(`GSTIN: ${v.message}`); return; }
    out.tax_number = v.gstin;
    if (typedState && typedState !== v.stateCode) {
      problems.push(`The GSTIN is registered in ${v.stateName} (${v.stateCode}), not ${stateName(typedState)} — the state comes from the GSTIN.`);
    }
    out.state_code = v.stateCode;
  } else if (registration === 'overseas' && input.stateCode === undefined) {
    out.state_code = FOREIGN_STATE;
  }
}

// --- ship-to addresses (cf_party_addresses) -----------------------------------

function shapeAddress(a) {
  return {
    id: a.id,
    partyId: a.party_id,
    label: a.label,
    address: a.address,
    city: a.city,
    pincode: a.pincode,
    stateCode: a.state_code,
    stateName: stateName(a.state_code),
    gstin: a.gstin,
    isDefaultShip: !!Number(a.is_default_ship),
  };
}

function readAddress(input, existing = null) {
  const problems = [];
  const out = {};
  const text = (key, col, max) => {
    if (input[key] === undefined) return;
    const v = blank(input[key]) ? null : String(input[key]).trim();
    if (v && v.length > max) problems.push(`${key} is up to ${max} characters.`);
    out[col] = v;
  };
  text('label', 'label', 100);
  text('city', 'city', 100);
  if (input.address !== undefined) out.address = blank(input.address) ? null : String(input.address);
  if (input.pincode !== undefined) {
    const pin = blank(input.pincode) ? null : String(input.pincode).replace(/\s+/g, '');
    if (pin && !PIN_RE.test(pin)) problems.push('A PIN code is 6 digits.');
    out.pincode = pin;
  }
  let typedState;
  if (input.stateCode !== undefined) {
    typedState = readStateCode(input.stateCode);
    if (typedState === undefined) problems.push(`${input.stateCode} is not a GST state code.`);
    else out.state_code = typedState;
  }
  if (input.gstin !== undefined) {
    const g = blank(input.gstin) ? null : String(input.gstin);
    if (g) {
      const v = validateGstin(g);
      if (!v.valid) problems.push(`GSTIN: ${v.message}`);
      else {
        out.gstin = v.gstin;
        if (typedState && typedState !== v.stateCode) problems.push(`The GSTIN is registered in ${v.stateName} (${v.stateCode}), not ${stateName(typedState)}.`);
        out.state_code = v.stateCode;
      }
    } else out.gstin = null;
  }
  if (input.isDefaultShip !== undefined) out.is_default_ship = input.isDefaultShip ? 1 : 0;
  if (!existing && !out.address && !out.city) problems.push('Give the address.');
  if (problems.length) throw new PartyError(422, 'INVALID', 'Some fields need attention.', { problems });
  return out;
}

export async function listAddresses(db, companyId, partyId) {
  await requireParty(db, companyId, partyId);
  const [rows] = await db.query(
    'SELECT * FROM cf_party_addresses WHERE company_id = ? AND party_id = ? AND deleted_at IS NULL ORDER BY is_default_ship DESC, id',
    [companyId, partyId],
  );
  return rows.map(shapeAddress);
}

/** At most one default ship-to per party: setting one clears the rest. */
async function clearDefault(db, companyId, partyId, exceptId) {
  await db.query('UPDATE cf_party_addresses SET is_default_ship = 0 WHERE company_id = ? AND party_id = ? AND id <> ? AND is_default_ship = 1',
    [companyId, partyId, exceptId]);
}

export async function createAddress(db, c, partyId, input = {}) {
  await requireParty(db, c.companyId, partyId);
  const body = readAddress(input);
  const cols = Object.keys(body);
  const [r] = await db.query(
    `INSERT INTO cf_party_addresses (company_id, party_id, ${cols.join(', ')}, created_by) VALUES (?, ?, ${cols.map(() => '?').join(', ')}, ?)`,
    [c.companyId, partyId, ...Object.values(body), c.userId],
  );
  if (body.is_default_ship) await clearDefault(db, c.companyId, partyId, r.insertId);
  return listAddresses(db, c.companyId, partyId);
}

async function requireAddress(db, companyId, partyId, addressId) {
  const [[a]] = await db.query('SELECT * FROM cf_party_addresses WHERE company_id = ? AND party_id = ? AND id = ? AND deleted_at IS NULL', [companyId, partyId, addressId]);
  if (!a) throw new PartyError(404, 'NOT_FOUND', 'Address not found.');
  return a;
}

export async function updateAddress(db, c, partyId, addressId, input = {}) {
  const a = await requireAddress(db, c.companyId, partyId, addressId);
  const body = readAddress(input, a);
  if (Object.keys(body).length) {
    await db.query(`UPDATE cf_party_addresses SET ${Object.keys(body).map((k) => `${k} = ?`).join(', ')} WHERE company_id = ? AND id = ?`,
      [...Object.values(body), c.companyId, a.id]);
  }
  if (body.is_default_ship) await clearDefault(db, c.companyId, partyId, a.id);
  return listAddresses(db, c.companyId, partyId);
}

/** Soft delete: an issued invoice keeps its own copy of the address (snapshot), so nothing breaks. */
export async function deleteAddress(db, c, partyId, addressId) {
  const a = await requireAddress(db, c.companyId, partyId, addressId);
  await db.query('UPDATE cf_party_addresses SET deleted_at = NOW(), is_default_ship = 0 WHERE company_id = ? AND id = ?', [c.companyId, a.id]);
  return listAddresses(db, c.companyId, partyId);
}

// Paging — the same contract as the host's lib/listing.js (the module may not
// import its host, so the few lines it needs are repeated here).
const truthy = (v) => v === '1' || v === 1 || v === true || v === 'true';
const PAGE_MAX = 500;
const EXPORT_MAX = 50_000;
const PARTY_SORT = { code: 'code', name: 'name', roles: 'is_customer', contact: 'contact_name', tax: 'tax_number', status: 'status' };

/**
 * The parties. Old callers (no `paged`) get the bare array they always got.
 * `paged=1` → { rows, total, counts, limit, offset, hasMore }: search, role and
 * status filter in SQL, and `counts` answers the role chips (every filter but
 * the role) and the active / inactive / no-contact figures (every filter) in
 * the same round trip as the total. `all=1` = every match (an export).
 * `ids=1,2` reads named parties (a picker showing what is already chosen).
 */
export async function listParties(db, companyId, q = {}) {
  const base = ['company_id = ?', 'deleted_at IS NULL'];
  const params = [companyId];
  let roleCol = null;
  if (!blank(q.role) && q.role !== 'all') {
    roleCol = ROLES[q.role];
    if (!roleCol) throw new PartyError(422, 'INVALID', 'Role is customer, supplier or subcontractor.');
  }
  if (!blank(q.status)) { base.push('status = ?'); params.push(q.status); }
  if (!blank(q.search)) {
    const like = `%${String(q.search).trim().replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    base.push('(code LIKE ? OR name LIKE ? OR contact_name LIKE ? OR email LIKE ? OR phone LIKE ?)');
    params.push(like, like, like, like, like);
  }
  if (!blank(q.ids)) {
    const ids = String(q.ids).split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0);
    if (ids.length) { base.push('id IN (?)'); params.push(ids); } else base.push('1 = 0');
  }
  const inRole = roleCol ? `${roleCol} = 1` : '1 = 1';
  const where = `${base.join(' AND ')} AND ${inRole}`;
  const sortCol = Object.prototype.hasOwnProperty.call(PARTY_SORT, q.sort) ? PARTY_SORT[q.sort] : null;
  const order = sortCol ? `${sortCol} IS NULL, ${sortCol} ${String(q.dir).toLowerCase() === 'desc' ? 'DESC' : 'ASC'}, id` : 'name, id';
  if (!truthy(q.paged) && !truthy(q.all)) {
    const limit = Math.min(Math.max(Number(q.limit) || 200, 1), PAGE_MAX);
    const [rows] = await db.query(`SELECT * FROM cf_parties WHERE ${where} ORDER BY ${order} LIMIT ?`, [...params, limit]);
    return rows.map(shape);
  }
  const all = truthy(q.all);
  const limit = all ? EXPORT_MAX : Math.min(Math.max(Number(q.limit) || 100, 1), PAGE_MAX);
  const offset = all ? 0 : Math.max(Math.floor(Number(q.offset) || 0), 0);
  const [[rows], [[c]]] = await Promise.all([
    db.query(`SELECT * FROM cf_parties WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`, [...params, limit, offset]),
    db.query(
      `SELECT COUNT(*) AS all_n, SUM(is_customer = 1) AS customer, SUM(is_supplier = 1) AS supplier, SUM(is_subcontractor = 1) AS subcontractor,
              SUM(${inRole}) AS total,
              SUM(${inRole} AND status = 'active') AS active,
              SUM(${inRole} AND status <> 'active') AS inactive,
              SUM(${inRole} AND (email IS NULL OR email = '') AND (phone IS NULL OR phone = '')) AS no_contact
         FROM cf_parties WHERE ${base.join(' AND ')}`,
      params,
    ),
  ]);
  const n = (v) => Number(v) || 0;
  const total = n(c.total);
  return {
    rows: rows.map(shape),
    total,
    limit: all ? rows.length : limit,
    offset,
    hasMore: !all && offset + rows.length < total,
    ...(all && total > rows.length ? { truncated: true } : {}),
    counts: {
      roles: { customer: n(c.customer), supplier: n(c.supplier), subcontractor: n(c.subcontractor), all: n(c.all_n) },
      active: n(c.active), inactive: n(c.inactive), noContact: n(c.no_contact),
    },
  };
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
