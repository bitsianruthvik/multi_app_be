/**
 * codegenOrgProvider.js — how departments, roles, positions and locations take
 * part in the code generator (apps/cf_erp/modules/codegen, reused by import).
 * Contract: TM/CF_HRMS_HIRING_SPEC.md §11.
 *
 *   hrms_department   hrms_departments.code
 *   hrms_role         hrms_roles.role_code
 *   hrms_position     hrms_positions.position_code
 *   hrms_location     hrms_locations.code
 *
 * Employees and letter references are in ./codegenProvider.js, which re-exports
 * this file — importing that one registers all six.
 *
 * A code is issued once, when the record is created (services/codeService.js),
 * so what a rule may print is what is known AT THAT MOMENT: a department's name,
 * label and parent; a role's title; the role, department, shift and location a
 * position is created with. Nothing here reads a value that only exists later.
 *
 * WHAT THE SPEC LISTS AND THIS FILE DOES NOT OFFER, because the record has no
 * such fact: a department's `location.code` (a department has no location —
 * positions do) and a role's category or level (hrms_roles has neither).
 *
 * THE GUIDE. Every token and condition carries its own plain words (`phrase`,
 * `help`, `example`) and the Code formats screen shows them as written.
 */
import { registerEntity, listEntities } from '../../cf_erp/modules/codegen/index.js';

export const DEPARTMENT_ENTITY = 'hrms_department';
export const ROLE_ENTITY = 'hrms_role';
export const POSITION_ENTITY = 'hrms_position';
export const LOCATION_ENTITY = 'hrms_location';

/** "Quality Control" -> QC, "Unit 2" -> U2, "Stores" -> S. Letters and digits only, upper case. */
export function initials(text) {
  return String(text ?? '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase())
    .join('');
}

/** `P021-3` -> `P021`: the code a card's positions share. */
export const cardCodeOf = (code) => (code == null || String(code).trim() === '' ? null : String(code).trim().replace(/-\d+$/, ''));

const listOf = (cond) => (cond.operator === 'in' ? cond.value.split(',').map((s) => s.trim()).filter(Boolean) : [cond.value.trim()]);
const idList = (cond) => listOf(cond).map(Number);
const clean = (v) => { const s = String(v ?? '').trim(); return s === '' ? null : s; };
const notFoundError = (what) => { const err = new Error(`${what} not found.`); err.status = 404; return err; };

async function idsExist(db, companyId, table, ids) {
  if (!ids.length || ids.some((v) => !Number.isInteger(v) || v <= 0)) return false;
  const [rows] = await db.query(`SELECT id FROM ${table} WHERE company_id = ? AND deleted_at IS NULL AND id IN (?)`, [companyId, ids]);
  return rows.length === new Set(ids).size;
}

const tokenCheck = (tokens, what) => async (db, companyId, key) => (
  tokens.some((t) => t.key === key) ? null : `"${key}" is not a value ${what} can insert.`
);

// ---- Departments -------------------------------------------------------------

const DEPARTMENT_TOKENS = [
  {
    key: 'label', label: 'Label', available: true,
    phrase: 'the label', example: 'Section', help: 'The department’s label — Department, Section, Machine, or whatever the company’s list holds. Give it a length limit to print a few letters.',
  },
  {
    key: 'label.initial', label: 'First letter of the label', available: true,
    phrase: 'the first letter of the label', example: 'S', help: 'The first letter of the label, in capitals: D for Department, S for Section, M for Machine.',
  },
  {
    key: 'name.initials', label: 'Initials of the name', available: true,
    phrase: 'the initials of the name', example: 'QC', help: 'The first letter of each word of the name, in capitals: Quality Control is QC. A one-word name gives one letter.',
  },
  {
    key: 'name', label: 'Name', available: true,
    phrase: 'the name', example: 'Quality Control', help: 'The whole name. Long for a code — give it a length limit to print its first letters.',
  },
  {
    key: 'parent.code', label: 'Code of the department above', available: true,
    phrase: 'the code of the department above', example: 'D004', help: 'The code of the department this one is under. Empty for a department at the top.',
  },
];

const DEPARTMENT_CONDITIONS = [
  {
    key: 'label', label: 'Label', operators: ['eq', 'in'], valueKind: 'departmentLabel',
    phrase: 'the label', help: 'Holds for departments with the labels you choose, so machines can be coded one way and sections another. Scores 1 point.',
  },
];

/** draft: { name?, type? (the label's name; `label` is read too), parentId? } */
async function departmentContext(db, companyId, draft = {}) {
  const [rows] = await db.query(
    `SELECT 'L' AS kind, id, name, NULL AS code, sort_order FROM hrms_department_labels WHERE company_id = ? AND deleted_at IS NULL
     UNION ALL
     SELECT 'P', id, name, code, 0 FROM hrms_departments WHERE company_id = ? AND id = ? AND deleted_at IS NULL`,
    [companyId, companyId, Number(draft.parentId) || 0],
  );
  const labels = rows.filter((r) => r.kind === 'L').sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);
  const parent = rows.find((r) => r.kind === 'P') ?? null;
  const given = clean(draft.type ?? draft.label);
  // A department created with no label gets the first of the list (organisationService) — so does its code.
  const label = given ? (labels.find((l) => l.name.toLowerCase() === given.toLowerCase()) ?? { id: null, name: given }) : (labels[0] ?? null);
  const name = clean(draft.name);
  return {
    get(key) {
      switch (key) {
        case 'label': return label?.name ?? null;
        case 'label.initial': return label?.name ? label.name[0].toUpperCase() : null;
        case 'name.initials': return name ? initials(name) : null;
        case 'name': return name;
        case 'parent.code': return parent?.code ?? null;
        default: return null;
      }
    },
    test(cond) {
      if (cond.token_key === 'label') return { ok: label?.id != null && idList(cond).includes(label.id), weight: 1 };
      return { ok: false, weight: 0 };
    },
  };
}

const departmentProvider = {
  label: 'Departments',
  tokens: DEPARTMENT_TOKENS,
  tokenPatterns: [],
  conditionTokens: DEPARTMENT_CONDITIONS,
  validateToken: tokenCheck(DEPARTMENT_TOKENS, 'a department code'),
  async validateCondition(db, companyId, cond) {
    if (cond.token_key !== 'label') return null;
    return (await idsExist(db, companyId, 'hrms_department_labels', idList(cond))) ? null : 'Choose from the company’s labels.';
  },
  async loadContext(db, companyId, entityId) {
    const [[d]] = await db.query(
      'SELECT name, department_type, parent_department_id FROM hrms_departments WHERE company_id = ? AND id = ? AND deleted_at IS NULL',
      [companyId, entityId],
    );
    if (!d) throw notFoundError('Department');
    return departmentContext(db, companyId, { name: d.name, type: d.department_type, parentId: d.parent_department_id });
  },
  async draftContext(db, companyId, draft) {
    return departmentContext(db, companyId, draft ?? {});
  },
};

// ---- Roles -------------------------------------------------------------------

const ROLE_TOKENS = [
  {
    key: 'title.initials', label: 'Initials of the title', available: true,
    phrase: 'the initials of the title', example: 'SI', help: 'The first letter of each word of the role’s title, in capitals: Shift In-charge is SI.',
  },
  {
    key: 'title', label: 'Title', available: true,
    phrase: 'the title', example: 'Shift In-charge', help: 'The whole title. Long for a code — give it a length limit to print its first letters.',
  },
  {
    key: 'department.code', label: 'Department code', available: true,
    phrase: 'the department code', example: 'D004', help: 'The code of the role’s usual department. Empty when the role has none.',
  },
];

/** draft: { title?, defaultDepartmentId? (`departmentId` is read too) } */
async function roleContext(db, companyId, draft = {}) {
  const departmentId = Number(draft.defaultDepartmentId ?? draft.departmentId) || 0;
  let department = null;
  if (departmentId) {
    [[department = null]] = await db.query('SELECT code FROM hrms_departments WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, departmentId]);
  }
  const title = clean(draft.title);
  return {
    get(key) {
      switch (key) {
        case 'title.initials': return title ? initials(title) : null;
        case 'title': return title;
        case 'department.code': return department?.code ?? null;
        default: return null;
      }
    },
    test() { return { ok: false, weight: 0 }; },
  };
}

const roleProvider = {
  label: 'Roles',
  tokens: ROLE_TOKENS,
  tokenPatterns: [],
  conditionTokens: [],
  validateToken: tokenCheck(ROLE_TOKENS, 'a role code'),
  async validateCondition() { return 'Role codes take no conditions.'; },
  async loadContext(db, companyId, entityId) {
    const [[r]] = await db.query('SELECT title, default_department_id FROM hrms_roles WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, entityId]);
    if (!r) throw notFoundError('Role');
    return roleContext(db, companyId, { title: r.title, defaultDepartmentId: r.default_department_id });
  },
  async draftContext(db, companyId, draft) {
    return roleContext(db, companyId, draft ?? {});
  },
};

// ---- Positions ---------------------------------------------------------------
// A position is one chair. Chairs of the same role, in the same department,
// under the same manager are drawn as one CARD (services/positionCards.js), and
// `card.code` is what lets a company number them P021-1, P021-2: it is the code
// of the card's first position without its trailing -<number>. It has a value
// only when the new position is added next to an existing one ("another
// position like this one"); a position created on its own starts a new card.

const POSITION_TOKENS = [
  {
    key: 'role.code', label: 'Role code', available: true,
    phrase: 'the role code', example: 'R014', help: 'The code of the position’s role.',
  },
  {
    key: 'department.code', label: 'Department code', available: true,
    phrase: 'the department code', example: 'D004', help: 'The code of the position’s department. Empty when the position has none.',
  },
  {
    key: 'shift.code', label: 'Shift code', available: true,
    phrase: 'the shift code', example: 'D', help: 'The code of the shift the position works — G, D or N.',
  },
  {
    key: 'location.code', label: 'Location code', available: true,
    phrase: 'the location code', example: 'L01', help: 'The code of the position’s location. Empty when the position has none.',
  },
  {
    key: 'card.code', label: 'Code of the card', available: true,
    phrase: 'the code of the card', example: 'P021',
    help: 'For a position added next to an existing one: the code of the first position of that card, without its trailing -number (P021-3 gives P021). Empty for a position created on its own — untick “required” on this part, or keep it to a rule of its own.',
  },
];

const POSITION_CONDITIONS = [
  {
    key: 'department', label: 'Department', operators: ['under', 'eq', 'in'], valueKind: 'department',
    phrase: 'the department',
    help: '“Is under” holds for the department you choose and every department below it, and scores more the deeper that department is: a top department 1, one below it 2. “Is” names exact departments and scores more than any “is under”.',
  },
  {
    key: 'role', label: 'Role', operators: ['eq', 'in'], valueKind: 'role',
    phrase: 'the role', help: 'Holds for positions of the roles you choose. Scores 1 point.',
  },
];

/** The code of the card `positionId` is in today: its first position's code, without a trailing -<number>. */
export async function cardCodeFor(db, companyId, positionId) {
  if (!positionId) return null;
  // Imported here, not at the top: positionCards -> positionService -> codeService -> this file.
  const { loadCards } = await import('./positionCards.js');
  const cards = await loadCards(db, companyId);
  const cardId = cards.cardOf.get(Number(positionId));
  if (cardId == null) {
    // Not drawn today (a draft, a closed chair): it is its own card.
    const [[own]] = await db.query('SELECT position_code FROM hrms_positions WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, positionId]);
    return cardCodeOf(own?.position_code);
  }
  return cardCodeOf(cards.positions.get(cardId)?.code);
}

/** draft: { roleId?, departmentId?, locationId?, shiftId? (`defaultShiftId` too), cardCode?, likePositionId? } */
async function positionContext(db, companyId, draft = {}) {
  const [rows] = await db.query(
    `SELECT 'D' AS kind, id, code, parent_department_id AS parent_id
       FROM hrms_departments WHERE company_id = ? AND deleted_at IS NULL
     UNION ALL
     SELECT 'L', id, code, NULL FROM hrms_locations WHERE company_id = ? AND id = ? AND deleted_at IS NULL
     UNION ALL
     SELECT 'R', id, role_code, NULL FROM hrms_roles WHERE company_id = ? AND id = ? AND deleted_at IS NULL
     UNION ALL
     SELECT 'S', id, code, NULL FROM hrms_shifts WHERE company_id = ? AND id = ? AND deleted_at IS NULL`,
    [companyId, companyId, Number(draft.locationId) || 0, companyId, Number(draft.roleId) || 0, companyId, Number(draft.shiftId ?? draft.defaultShiftId) || 0],
  );
  const departments = new Map(rows.filter((r) => r.kind === 'D').map((r) => [r.id, r]));
  const one = (kind) => rows.find((r) => r.kind === kind) ?? null;
  // The department and everything above it, nearest first. The bound guards a loop in bad data.
  const chain = [];
  for (let d = departments.get(Number(draft.departmentId)) ?? null, i = 0; d && i < 64; i += 1) {
    chain.push(d);
    d = d.parent_id == null ? null : departments.get(d.parent_id) ?? null;
  }
  const depthOf = new Map(chain.map((d, i) => [d.id, chain.length - 1 - i]));
  const department = chain[0] ?? null;
  const role = one('R');
  const cardCode = clean(draft.cardCode) ?? (draft.likePositionId ? await cardCodeFor(db, companyId, Number(draft.likePositionId)) : null);

  return {
    get(key) {
      switch (key) {
        case 'role.code': return role?.code ?? null;
        case 'department.code': return department?.code ?? null;
        case 'shift.code': return one('S')?.code ?? null;
        case 'location.code': return one('L')?.code ?? null;
        case 'card.code': return cardCode;
        default: return null;
      }
    },
    test(cond) {
      switch (cond.token_key) {
        case 'department': {
          if (cond.operator === 'under') {
            const id = Number(listOf(cond)[0]);
            return { ok: depthOf.has(id), weight: 1 + (depthOf.get(id) ?? 0) };
          }
          return { ok: !!department && idList(cond).includes(department.id), weight: 2 + (department ? depthOf.get(department.id) : 0) };
        }
        case 'role': return { ok: !!role && idList(cond).includes(role.id), weight: 1 };
        default: return { ok: false, weight: 0 };
      }
    },
  };
}

const positionProvider = {
  label: 'Positions',
  tokens: POSITION_TOKENS,
  tokenPatterns: [],
  conditionTokens: POSITION_CONDITIONS,
  validateToken: tokenCheck(POSITION_TOKENS, 'a position code'),
  async validateCondition(db, companyId, cond) {
    if (cond.token_key === 'department') return (await idsExist(db, companyId, 'hrms_departments', idList(cond))) ? null : 'That department does not exist.';
    if (cond.token_key === 'role') return (await idsExist(db, companyId, 'hrms_roles', idList(cond))) ? null : 'That role does not exist.';
    return null;
  },
  async loadContext(db, companyId, entityId) {
    const [[p]] = await db.query(
      'SELECT id, role_id, department_id, location_id, default_shift_id FROM hrms_positions WHERE company_id = ? AND id = ? AND deleted_at IS NULL',
      [companyId, entityId],
    );
    if (!p) throw notFoundError('Position');
    return positionContext(db, companyId, {
      roleId: p.role_id, departmentId: p.department_id, locationId: p.location_id, shiftId: p.default_shift_id, likePositionId: p.id,
    });
  },
  async draftContext(db, companyId, draft) {
    return positionContext(db, companyId, draft ?? {});
  },
};

// ---- Locations ---------------------------------------------------------------

const LOCATION_TOKENS = [
  {
    key: 'name.initials', label: 'Initials of the name', available: true,
    phrase: 'the initials of the name', example: 'U2', help: 'The first letter or digit of each word of the name, in capitals: Unit 2 is U2.',
  },
  {
    key: 'name', label: 'Name', available: true,
    phrase: 'the name', example: 'Unit 2', help: 'The whole name. Give it a length limit to print its first letters.',
  },
  {
    key: 'city.initials', label: 'Initials of the city', available: true,
    phrase: 'the initials of the city', example: 'J', help: 'The first letter of each word of the city in the address: Navi Mumbai is NM. Empty when the address has no city.',
  },
];

/** draft: { name?, address?: { city? } | json text, city? } */
function locationContext(draft = {}) {
  let address = draft.address ?? null;
  if (typeof address === 'string') { try { address = JSON.parse(address); } catch { address = null; } }
  const city = clean(draft.city ?? address?.city);
  const name = clean(draft.name);
  return {
    get(key) {
      switch (key) {
        case 'name.initials': return name ? initials(name) : null;
        case 'name': return name;
        case 'city.initials': return city ? initials(city) : null;
        default: return null;
      }
    },
    test() { return { ok: false, weight: 0 }; },
  };
}

const locationProvider = {
  label: 'Locations',
  tokens: LOCATION_TOKENS,
  tokenPatterns: [],
  conditionTokens: [],
  validateToken: tokenCheck(LOCATION_TOKENS, 'a location code'),
  async validateCondition() { return 'Location codes take no conditions.'; },
  async loadContext(db, companyId, entityId) {
    const [[l]] = await db.query('SELECT name, address_json FROM hrms_locations WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, entityId]);
    if (!l) throw notFoundError('Location');
    return locationContext({ name: l.name, address: l.address_json });
  },
  async draftContext(db, companyId, draft) {
    return locationContext(draft ?? {});
  },
};

// The module's registry throws on a second registration; this file can be
// reached under two spellings of its path on Windows, so it looks first.
const registered = new Set(listEntities().map((e) => e.entityType));
for (const [entityType, provider] of [
  [DEPARTMENT_ENTITY, departmentProvider],
  [ROLE_ENTITY, roleProvider],
  [POSITION_ENTITY, positionProvider],
  [LOCATION_ENTITY, locationProvider],
]) if (!registered.has(entityType)) registerEntity(entityType, provider);
