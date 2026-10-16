/**
 * recode-company.mjs — give a company's EXISTING departments, roles, locations
 * and positions the codes its code rules would issue today.
 * (TM/CF_HRMS_HIRING_SPEC.md §11: one code generator, codes are issued; §16: history.)
 *
 *   node recode-company.mjs --company=karni                    DRY RUN — the full old -> new list
 *   node recode-company.mjs --company=karni --apply
 *   node recode-company.mjs --company=karni --apply --target=prod
 *
 * WHY. Karni's records came from an old chart import and kept its codes:
 * departments and roles read like position codes (P001, P021 …), positions like
 * P021-1. The company's rules now say D001, R001, L01 and {role.code}-{#}. The
 * user decided to renumber all of them (2026-10-16: "B, renumber all of them and
 * push it"). Employee codes and letter references are NOT touched.
 *
 * WHAT IT DOES, in ONE transaction (all or nothing):
 *   1. locations    — by current code
 *   2. departments  — the tree in pre-order (a parent before its children,
 *                     siblings by current code), so a rule that prints
 *                     {parent.code} prints the parent's NEW code
 *   3. roles        — by current code, then title
 *   4. positions    — grouped by role (in the role order above), within a role
 *                     by current code; a position's new code comes from its
 *                     role's NEW code through the company's position rule
 * Every code is issued by services/codeService.js (issueLocationCode,
 * issueDepartmentCode, issueRoleCode, issuePositionCode) with the record's own
 * facts as the draft — the same call a create makes, so the rule's tokens,
 * conditions, counters and "skip a code already taken" apply exactly as they do
 * on a screen. No code is built by hand here.
 *
 * WHICH ROWS. Every LIVE row (deleted_at IS NULL), whatever its status —
 * CLOSED / INACTIVE / DRAFT included — so no old-style code is left in the live
 * data. Deleted rows keep their old codes (and, as always, those codes are never
 * issued again).
 *
 * "NEEDS RENUMBERING". A row is renumbered when its code does not have the
 * shape the company's active rule(s) give. The shape is derived from each
 * active rule's segments (printed at the start of a run):
 *   literal   -> that text exactly
 *   sequence  -> digits, at least the format's width ('000' -> 3 or more)
 *   token     -> the value it would print when this script knows it
 *                (positions: role.code = the role's code after step 3;
 *                 departments: parent.code = the parent's code after step 2),
 *                otherwise "some text"
 *   date      -> digits
 * A position whose role is renumbered is always renumbered. A second run on a
 * renumbered company therefore finds nothing to do.
 *
 * HISTORY. Each renumbered record gets one hrms_audit_log row: action UPDATE,
 * before { code: old }, after { code: new }, request_id recode-<YYYY-MM-DD>,
 * entity_type the record's table. No new columns.
 *
 * SAFETY.
 *   - The dry run runs the SAME transaction and rolls it back: the list it
 *     prints is the list --apply writes, counters included, and nothing is kept.
 *   - Before committing (and in the dry run) every new code is checked against
 *     every other code of its table, live or deleted, case-insensitively; any
 *     clash and the run is rolled back and refused.
 *   - A rule that prints card.code is refused: what "the card" is during a
 *     renumbering is not defined. (Karni's rule does not use it.)
 *
 * TiDB. No subquery in an ON clause; all reads are batched (one query per kind);
 * the writes are per row inside the transaction. The run counts its round trips
 * and prints the time they would take at ~49 ms each (production).
 *
 * Local by default (scripts/dbTarget.mjs). Credentials are never printed.
 */
import mysql from 'mysql2/promise';
import { resolveTarget, announce } from './dbTarget.mjs';
import {
  DEPARTMENT_ENTITY, ROLE_ENTITY, POSITION_ENTITY, LOCATION_ENTITY,
} from '../services/codegenProvider.js';
import {
  issueDepartmentCode, issueRoleCode, issuePositionCode, issueLocationCode, ensureDefaultRule,
} from '../services/codeService.js';
import { asBatch } from '../lib/batch.js';

const args = process.argv.slice(2);
const arg = (n) => {
  const hit = args.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(hit.indexOf('=') + 1) : null;
};
const APPLY = args.includes('--apply');
const MS_PER_TRIP = 49;

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const byCode = (a, b) => String(a ?? '￿').localeCompare(String(b ?? '￿'), 'en', { numeric: true, sensitivity: 'base' });
const pad2 = (n) => String(n).padStart(2, '0');
const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };

const KINDS = {
  location: { entityType: LOCATION_ENTITY, table: 'hrms_locations', column: 'code', label: 'locations' },
  department: { entityType: DEPARTMENT_ENTITY, table: 'hrms_departments', column: 'code', label: 'departments' },
  role: { entityType: ROLE_ENTITY, table: 'hrms_roles', column: 'role_code', label: 'roles' },
  position: { entityType: POSITION_ENTITY, table: 'hrms_positions', column: 'position_code', label: 'positions' },
};

// ---- Rule shapes ---------------------------------------------------------------

/** The active rules of each kind with their segments: Map(entityType -> [{ code, segments }]). Two reads. */
async function loadRules(db, companyId) {
  const types = Object.values(KINDS).map((k) => k.entityType);
  const [schemes] = await db.query(
    `SELECT id, code, entity_type FROM cf_code_schemes
      WHERE company_id = ? AND entity_type IN (?) AND target_field = 'code' AND status = 'active' AND deleted_at IS NULL`,
    [companyId, types],
  );
  const [segments] = schemes.length ? await db.query(
    `SELECT scheme_id, segment_type, literal_text, token_key, format, transform, max_length
       FROM cf_code_scheme_segments WHERE company_id = ? AND scheme_id IN (?) AND deleted_at IS NULL
      ORDER BY scheme_id, sort_order, id`,
    [companyId, schemes.map((s) => s.id)],
  ) : [[]];
  const out = new Map(types.map((t) => [t, []]));
  for (const s of schemes) out.get(s.entity_type).push({ code: s.code, segments: segments.filter((g) => g.scheme_id === s.id) });
  return out;
}

/** How a rule reads, for the printout: D{000}, {role.code}-{0}. */
const ruleText = (rule) => rule.segments.map((g) => {
  if (g.segment_type === 'literal') return g.literal_text ?? '';
  if (g.segment_type === 'sequence') return `{${g.format || '#'}}`;
  if (g.segment_type === 'token') return `{${g.token_key}}`;
  if (g.segment_type === 'date') return `{${g.format || 'YYYYMMDD'}}`;
  return '{?}';
}).join('');

/**
 * The rule's shape as a regular expression. `known` gives the value a token
 * prints when this script knows it (role.code for a position, parent.code for
 * a department); any other token is "some text".
 */
function ruleShape(rule, known = {}) {
  let re = '';
  for (const g of rule.segments) {
    if (g.segment_type === 'literal') re += esc(g.literal_text ?? '');
    else if (g.segment_type === 'sequence') re += `\\d{${g.format && /^0+$/.test(g.format) ? g.format.length : 1},}`;
    else if (g.segment_type === 'date') re += '\\d+';
    else if (g.segment_type === 'token') {
      if (Object.prototype.hasOwnProperty.call(known, g.token_key)) {
        let v = String(known[g.token_key] ?? '');
        if (g.transform === 'upper') v = v.toUpperCase(); else if (g.transform === 'lower') v = v.toLowerCase();
        if (g.max_length) v = v.slice(0, g.max_length);
        re += esc(v);
      } else re += '.+?';
    }
  }
  return new RegExp(`^${re}$`, 'i');
}

const hasShape = (rules, code, known) => code != null && rules.some((r) => ruleShape(r, known).test(String(code)));

// ---- Reads (one query per kind) ------------------------------------------------

async function loadAll(db, companyId) {
  const [locations] = await db.query(
    'SELECT id, code, name, address_json, status FROM hrms_locations WHERE company_id = ? AND deleted_at IS NULL', [companyId]);
  const [departments] = await db.query(
    'SELECT id, code, name, department_type, parent_department_id, status FROM hrms_departments WHERE company_id = ? AND deleted_at IS NULL', [companyId]);
  const [links] = await db.query(
    'SELECT department_id, group_id, label_id FROM hrms_department_label_links WHERE company_id = ? AND deleted_at IS NULL', [companyId]);
  const [roles] = await db.query(
    'SELECT id, role_code AS code, title, default_department_id, status FROM hrms_roles WHERE company_id = ? AND deleted_at IS NULL', [companyId]);
  const [positions] = await db.query(
    `SELECT id, position_code AS code, role_id, department_id, location_id, default_shift_id, position_title, status
       FROM hrms_positions WHERE company_id = ? AND deleted_at IS NULL`, [companyId]);
  const labelsOf = new Map();
  for (const l of links) {
    if (!labelsOf.has(l.department_id)) labelsOf.set(l.department_id, {});
    labelsOf.get(l.department_id)[l.group_id] = l.label_id;
  }
  return { locations, departments, labelsOf, roles, positions };
}

/** Departments in pre-order: parents first, siblings by current code. A parent that is not live counts as none. */
function departmentOrder(departments) {
  const ids = new Set(departments.map((d) => d.id));
  const kids = new Map();
  for (const d of departments) {
    const p = d.parent_department_id != null && ids.has(d.parent_department_id) ? d.parent_department_id : null;
    if (!kids.has(p)) kids.set(p, []);
    kids.get(p).push(d);
  }
  for (const list of kids.values()) list.sort((a, b) => byCode(a.code, b.code) || a.id - b.id);
  const out = [];
  const seen = new Set();
  const walk = (parent) => {
    for (const d of kids.get(parent) ?? []) {
      if (seen.has(d.id)) continue;
      seen.add(d.id);
      out.push(d);
      walk(d.id);
    }
  };
  walk(null);
  if (out.length !== departments.length) {
    const lost = departments.filter((d) => !seen.has(d.id)).map((d) => `${d.code ?? d.id} ${d.name}`);
    throw new Error(`The department tree has a loop; not reached from the top: ${lost.join(', ')}`);
  }
  return out;
}

// ---- The run ---------------------------------------------------------------------

async function main() {
  const slug = arg('company');
  if (!slug) throw new Error('--company=<slug> is required');
  const target = resolveTarget();
  announce(target);
  console.log(`  ${APPLY ? 'APPLY' : 'DRY RUN (the same transaction, rolled back)'} — company "${slug}"\n`);

  const conn = await mysql.createConnection({ ...target.cfg, multipleStatements: false, dateStrings: true });
  // Count every round trip, so the time on production can be told from a local run.
  let trips = 0;
  const realQuery = conn.query.bind(conn);
  conn.query = (...a) => { trips += 1; return realQuery(...a); };
  const started = Date.now();

  try {
    const [[company]] = await conn.query('SELECT id, name FROM companies WHERE slug = ? AND deleted_at IS NULL', [slug]);
    if (!company) throw new Error(`No company with slug "${slug}"`);
    const companyId = company.id;
    console.log(`  company: ${company.name} (id ${companyId})\n`);

    const requestId = `recode-${today()}`;
    const plan = { location: [], department: [], role: [], position: [] };
    let committed = false;

    await conn.beginTransaction();
    try {
      await asBatch(conn, async () => {
        // A kind with no rule gets the default one, exactly as its first create would.
        for (const k of Object.values(KINDS)) await ensureDefaultRule(conn, companyId, k.entityType, null);
        const rules = await loadRules(conn, companyId);
        console.log('  RULES (active) and the shape a code must have to be left alone:');
        for (const [key, k] of Object.entries(KINDS)) {
          const list = rules.get(k.entityType);
          if (!list.length) throw new Error(`No active ${key} rule — nothing to renumber with.`);
          const known = key === 'position' ? { 'role.code': '<role code>' } : key === 'department' ? { 'parent.code': '<parent code>' } : {};
          for (const r of list) {
            console.log(`    ${k.label.padEnd(12)} ${r.code.padEnd(18)} ${ruleText(r).padEnd(22)} /${ruleShape(r, known).source}/`);
          }
        }
        const usesCard = rules.get(POSITION_ENTITY).some((r) => r.segments.some((g) => g.token_key === 'card.code'));
        if (usesCard) throw new Error('The position rule prints {card.code}; this script does not renumber by card. Change the rule or extend the script.');
        console.log('');

        const data = await loadAll(conn, companyId);
        const issued = new Map(); // `${kind}:${id}` -> new code (or the code kept)

        const renumber = async (kind, row, issueFn, draft, what = null) => {
          const k = KINDS[kind];
          const code = await issueFn(conn, companyId, { ...draft, userId: null });
          await conn.query(`UPDATE ${k.table} SET ${k.column} = ?, updated_at = NOW() WHERE company_id = ? AND id = ?`, [code, companyId, row.id]);
          plan[kind].push({ id: row.id, old: row.code, code, status: row.status, what: what ?? draft.title ?? draft.name ?? '' });
          return code;
        };

        // 1. Locations
        for (const l of [...data.locations].sort((a, b) => byCode(a.code, b.code) || a.id - b.id)) {
          const code = hasShape(rules.get(LOCATION_ENTITY), l.code)
            ? l.code
            : await renumber('location', l, issueLocationCode, { name: l.name, address: l.address_json });
          issued.set(`location:${l.id}`, code);
        }

        // 2. Departments, parents first
        const deptCode = new Map();
        for (const d of departmentOrder(data.departments)) {
          const parentCode = d.parent_department_id != null ? deptCode.get(d.parent_department_id) ?? null : null;
          const code = hasShape(rules.get(DEPARTMENT_ENTITY), d.code, { 'parent.code': parentCode })
            ? d.code
            : await renumber('department', d, issueDepartmentCode, {
              name: d.name, type: d.department_type, parentId: d.parent_department_id, labels: data.labelsOf.get(d.id) ?? {},
            });
          deptCode.set(d.id, code);
        }

        // 3. Roles, by current code then title
        const roleOrder = [...data.roles].sort((a, b) => byCode(a.code, b.code) || String(a.title).localeCompare(String(b.title)) || a.id - b.id);
        const roleCode = new Map();
        const roleMoved = new Set();
        for (const r of roleOrder) {
          let code = r.code;
          if (!hasShape(rules.get(ROLE_ENTITY), r.code)) {
            code = await renumber('role', r, issueRoleCode, { title: r.title, defaultDepartmentId: r.default_department_id });
            roleMoved.add(r.id);
          }
          roleCode.set(r.id, code);
        }

        // 4. Positions, grouped by role in role order; within a role by current code
        const rank = new Map(roleOrder.map((r, i) => [r.id, i]));
        const roleTitle = new Map(roleOrder.map((r) => [r.id, r.title]));
        const positions = [...data.positions].sort((a, b) => ((rank.get(a.role_id) ?? 1e9) - (rank.get(b.role_id) ?? 1e9))
          || byCode(a.code, b.code) || a.id - b.id);
        for (const p of positions) {
          const rc = roleCode.get(p.role_id) ?? null;
          const keep = !roleMoved.has(p.role_id) && hasShape(rules.get(POSITION_ENTITY), p.code, { 'role.code': rc });
          if (keep) continue;
          await renumber('position', p, issuePositionCode, {
            roleId: p.role_id, departmentId: p.department_id, locationId: p.location_id, shiftId: p.default_shift_id,
          }, p.position_title || roleTitle.get(p.role_id) || '');
        }

        // Every new code against every other code of its table, live or deleted. The generator already
        // skips a taken code; this is the second pair of eyes before anything is kept.
        const clashes = [];
        for (const [kind, k] of Object.entries(KINDS)) {
          if (!plan[kind].length) continue;
          const [rows] = await conn.query(`SELECT id, ${k.column} AS code FROM ${k.table} WHERE company_id = ? AND ${k.column} IS NOT NULL`, [companyId]);
          const holders = new Map();
          for (const r of rows) {
            const key = String(r.code).toLowerCase();
            if (!holders.has(key)) holders.set(key, []);
            holders.get(key).push(r.id);
          }
          for (const p of plan[kind]) {
            const h = holders.get(String(p.code).toLowerCase()) ?? [];
            if (h.length !== 1 || h[0] !== p.id) clashes.push(`${kind} ${p.old} -> ${p.code} (also held by id ${h.filter((x) => x !== p.id).join(', ')})`);
          }
        }
        if (clashes.length) throw new Error(`Refused — codes would collide:\n    ${clashes.join('\n    ')}`);

        // The audit rows, one per renumbered record, in one statement per kind.
        for (const [kind, k] of Object.entries(KINDS)) {
          if (!plan[kind].length) continue;
          const values = plan[kind].map((p) => [companyId, null, k.table, p.id, 'UPDATE',
            JSON.stringify({ code: p.old }), JSON.stringify({ code: p.code }), requestId, null]);
          await conn.query(
            `INSERT INTO hrms_audit_log (company_id, actor_user_id, entity_type, entity_id, action, before_json, after_json, request_id, created_by)
             VALUES ?`, [values]);
        }
      });

      const total = Object.values(plan).reduce((n, l) => n + l.length, 0);
      if (APPLY && total) { await conn.commit(); committed = true; } else await conn.rollback();
    } catch (err) {
      await conn.rollback().catch(() => {});
      throw err;
    }

    // ---- Report ----
    const total = Object.values(plan).reduce((n, l) => n + l.length, 0);
    for (const [kind, k] of Object.entries(KINDS)) {
      const list = plan[kind];
      console.log(`  ${k.label.toUpperCase()} — ${list.length} to renumber`);
      for (const p of list) {
        console.log(`    ${String(p.old ?? '(none)').padEnd(24)} -> ${String(p.code).padEnd(12)} ${p.status && p.status !== 'ACTIVE' ? `[${p.status}] ` : ''}${p.what ?? ''}`);
      }
      console.log('');
    }
    console.log(`  COUNTS  locations ${plan.location.length} · departments ${plan.department.length} · roles ${plan.role.length} · positions ${plan.position.length} · total ${total}`);
    console.log(`  round trips ${trips} in ${((Date.now() - started) / 1000).toFixed(1)} s here; at ~${MS_PER_TRIP} ms each (production) ≈ ${Math.ceil((trips * MS_PER_TRIP) / 1000)} s`);
    if (!total) console.log('\n  nothing to renumber.');
    else if (committed) console.log(`\n  APPLIED — ${total} codes renumbered, ${total} audit rows (request_id ${requestId}).`);
    else console.log('\n  DRY RUN — rolled back, nothing kept. Re-run with --apply to write it.');
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error(`\n  FAILED: ${err.message}`);
  process.exit(1);
});
