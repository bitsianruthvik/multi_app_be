/**
 * create-employee-logins.mjs — one login per active employee, so every person
 * in the plant can see their own place in the organisation and nothing else.
 *
 *   node create-employee-logins.mjs --company=karni                 # DRY RUN, writes nothing
 *   node create-employee-logins.mjs --company=karni --apply
 *   node create-employee-logins.mjs --company=karni --apply --domain=karnipackaging.com
 *   node create-employee-logins.mjs --company=karni --apply --target=prod
 *
 * Dry run is the default and `--target=prod` must be asked for by name
 * (dbTarget.mjs). A dry run does every check and every collision resolution and
 * prints exactly what it would write, including the final email for all 71
 * people — it just never writes, and never generates a password.
 *
 * ── WHAT ONE LOGIN IS ─────────────────────────────────────────────────────
 * Three rows and one link, all in one transaction per person:
 *
 *   users                  the identity (email + bcrypt hash, role = Employee)
 *   app_user_access        "this user may open cf_hrms"
 *   hrms_employees.user_id the link back to the person
 *
 * `role_capability` is NOT written here. The Employee role and its single
 * capability (`cf_hrms_self_view`) are seeded by models/seed.sql, because a
 * script that mints identities should not also be the thing that decides what
 * they may do. A grant needs BOTH a role_capability row and an app_user_access
 * row — a role_capability alone silently grants nothing, and that is the single
 * most common cause of "the app is there but empty" on this platform. This
 * script refuses to run if seed.sql has not been applied, rather than minting
 * 71 logins that open an empty app.
 *
 * ── THE EMAIL PROBLEM, WHICH IS THE REAL WORK ─────────────────────────────
 * The source org chart has no email, no phone and no employee code for anybody
 * — only a name, a shift and a status. So there is nothing to log in WITH and
 * identities have to be minted.
 *
 * `authController.loginUser` looks up `SELECT * FROM users WHERE email = ?`
 * with NO company filter and only afterwards compares `company_id`. Two tenants
 * holding the same address therefore means one of them cannot log in AT ALL —
 * not a wrong-tenant error, a hard "User not in this company". `users.email`
 * also carries a global UNIQUE index with no company in it. So every address
 * minted here is checked against EVERY row of `users`, including soft-deleted
 * ones, because a soft-deleted row still holds its address in that index.
 *
 * Collisions are resolved so that they are impossible to miss:
 *
 *   - When two or more people share a base name, NOBODY gets the bare address.
 *     Both "Ram Babu"s become ram.babu.<code>@domain. Giving the first one the
 *     plain address and the second a suffix is order-dependent, invisible on a
 *     list, and the exact shape of "two people quietly became one login".
 *   - 71 Indian names share surnames across families, so this is the normal
 *     case here, not an edge case.
 *   - If an address is still taken globally, a numeric suffix is appended and
 *     the clash is printed with the id of the row that holds it.
 *   - The ladder is deterministic: the same data produces the same addresses on
 *     every run, on every machine, because the base name is grouped before any
 *     address is allocated rather than as rows arrive.
 *
 * An employee whose own `hrms_employees.email` is set keeps it, provided it is
 * a valid address and free. If it is taken by somebody else the script says so
 * and mints one instead rather than failing the person.
 *
 * ── PASSWORDS ─────────────────────────────────────────────────────────────
 * A different random password per person, bcrypt cost 10 (what every other
 * password on this platform uses). The plaintext list is written to ONE CSV
 * outside both git repositories, for HR to distribute. Passwords are never
 * printed to stdout in bulk and never go into the Excel org workbook — that
 * file gets emailed.
 *
 * THE CREDENTIALS FILE IS WRITE-ONCE, AND THE REASON IS WORTH READING. Its name
 * carries the TARGET as well as the date (`...-prod-2026-10-08.csv` against
 * `...-local-...`), and an existing file is never overwritten — a counter is
 * added instead. The first version of this script used a date-only name, so a
 * local run and a production run on the same day resolved to the same path and
 * the second silently replaced the first. That nearly destroyed the only copy
 * of 71 live passwords: bcrypt means they cannot be read back out of the
 * database, and re-running does not reissue them (everyone is then
 * "already has a login" and NO file is written at all), so the accounts would
 * have been unreachable until an administrator reset each one by hand. The
 * target is written inside the file too, as a column on every row, because a
 * file gets renamed and forwarded and its name is not evidence.
 *
 * THERE IS NO PASSWORD RESET AND NO FORCE-CHANGE-ON-FIRST-LOGIN ON THIS
 * PLATFORM. A minted password is permanent until an administrator changes it on
 * the Access screen. For 71 shop-floor users that is an operational decision,
 * not a detail — the script says so every time it runs.
 *
 * ── IDEMPOTENT ────────────────────────────────────────────────────────────
 * Running twice creates nothing the second time. An employee already linked to
 * a live user is skipped with its address printed. An employee NOT linked whose
 * address already exists in this company is LINKED to that user rather than
 * duplicated, and its password is left alone — re-running must never silently
 * invalidate a password HR has already handed out.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import mysql from 'mysql2/promise';
import { resolveTarget, announce } from './dbTarget.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BE_ROOT = path.resolve(HERE, '../../..');     // multi_app_be
const TM_ROOT = path.resolve(BE_ROOT, '..');        // TM — outside BOTH git repos

// Resolved from the backend root, not process.cwd(), so the script works from
// any directory. (setup-karni.mjs uses cwd and only runs from multi_app_be.)
const require = createRequire(import.meta.url);
const bcrypt = require(path.join(BE_ROOT, 'node_modules', 'bcryptjs'));

const BCRYPT_COST = 10;                 // core/auth/*.js all use 10
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;   // authController's own test
const MIN_PASSWORD = 8;                 // authController rejects anything shorter
const PASSWORD_LENGTH = 12;
const ROLE_NAME = 'Employee';
const SELF_TAG = 'cf_hrms_self_view';

/* ── arguments ──────────────────────────────────────────────────────────── */

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const has = (name) => argv.includes(`--${name}`);

const OPTS = {
  companySlug: flag('company', 'karni'),
  // karni.com is what the existing test@karni.com login already uses, so the
  // minted addresses sit in the same namespace rather than inventing a second.
  domain: (flag('domain', 'karni.com') || '').trim().toLowerCase(),
  apply: has('apply'),
  out: flag('out', null),
  // Default: active staff only. Someone on notice still works and still needs
  // to see their place; someone who has left does not.
  statuses: (flag('statuses', 'ACTIVE,NOTICE') || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean),
};

const TARGET = resolveTarget();

/* ── names → an address ─────────────────────────────────────────────────── */

/**
 * Honorifics the source chart carries ("Mr. Samir Sahu"). They are not names
 * and must not become part of an address.
 *
 * `Md` is NOT in this list, and that is the one judgement here worth recording:
 * it looks like a title but it is the usual short form of Mohammad, a given
 * name. Karni has a "Md Naushad"; treating `md` as an honorific turned him into
 * `naushad@` while the two men written out in full stayed `mohammed.farath@`
 * and `mohammad.adiluddin@` — the same name producing two different shapes of
 * address depending on how a clerk typed it. He is `md.naushad@`.
 */
const HONORIFICS = new Set([
  'mr', 'mrs', 'ms', 'miss', 'dr', 'shri', 'sri', 'smt', 'kum', 'prof', 'er', 'ca',
]);

/**
 * The name reduced to address-safe ASCII tokens.
 *
 * Diacritics are folded rather than dropped (NFD + strip combining marks), so
 * a name written with them produces the letter and not a hole. Anything that is
 * still not a-z after that is removed — an address with a dot in the wrong
 * place is a login nobody can type over a phone.
 */
function nameTokens(fullName) {
  return String(fullName ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean)
    .filter((t) => !HONORIFICS.has(t));
}

/** `firstname.lastname`, or the single name when that is all there is. */
function baseLocalPart(fullName) {
  const t = nameTokens(fullName);
  if (t.length === 0) return null;
  if (t.length === 1) return t[0];
  return `${t[0]}.${t[t.length - 1]}`;
}

/** The employee code, reduced to something that can sit in an address. */
const codePart = (code) => String(code ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '') || null;

/** A readable 12-character password with no ambiguous characters. */
function makePassword() {
  // No 0/O/o, 1/l/I, 5/S, 2/Z — HR reads these out over a phone and types them
  // onto a shared tablet. Length makes up for the smaller alphabet.
  const alphabet = 'abcdefghijkmnpqrtuvwxyzACDEFGHJKLMNPQRTUVWXY34679';
  let out = '';
  for (let i = 0; i < PASSWORD_LENGTH; i += 1) out += alphabet[crypto.randomInt(alphabet.length)];
  if (out.length < MIN_PASSWORD) throw new Error('password too short for the login rule');
  return out;
}

/* ── CSV ────────────────────────────────────────────────────────────────── */

const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * A path that does not exist yet, by adding `-2`, `-3`, … before the extension.
 *
 * THIS FUNCTION EXISTS BECAUSE OF A NEAR-MISS, and the reasoning matters more
 * than the code. The filename used to be date-only, so a local run and a
 * production run on the same day resolved to the SAME path and the second
 * silently overwrote the first. The harmless direction happened (prod over
 * local). The other direction destroys live credentials: the passwords are
 * bcrypt-hashed in the database and cannot be read back, so overwriting the
 * file would leave 71 production accounts unreachable until an administrator
 * reset each one by hand — on a platform with no reset flow.
 *
 * It adds a counter rather than refusing, deliberately. By the time this runs
 * the `users` rows are already committed, so a refusal would strand freshly
 * minted passwords with nowhere to write them — destroying exactly what it was
 * trying to protect. A credentials file is write-once: never replaced, always
 * written somewhere, and the caller is told exactly where.
 */
function freePath(preferred) {
  if (!fs.existsSync(preferred)) return { file: preferred, collided: false };
  const dir = path.dirname(preferred);
  const ext = path.extname(preferred);
  const stem = path.basename(preferred, ext);
  for (let n = 2; n <= 999; n += 1) {
    const candidate = path.join(dir, `${stem}-${n}${ext}`);
    if (!fs.existsSync(candidate)) return { file: candidate, collided: true };
  }
  // 999 files with this stem is not a situation to resolve by guessing.
  throw new Error(`Cannot find a free name for ${preferred} — too many existing files.`);
}

/* ── main ───────────────────────────────────────────────────────────────── */

async function main() {
  announce(TARGET);
  console.log(`  company:  ${OPTS.companySlug}`);
  console.log(`  domain:   @${OPTS.domain}`);
  console.log(`  statuses: ${OPTS.statuses.join(', ')}`);
  console.log(`  mode:     ${OPTS.apply ? 'APPLY — rows will be written' : 'DRY RUN — nothing is written'}\n`);

  if (!OPTS.domain || !EMAIL_RE.test(`probe@${OPTS.domain}`)) {
    throw new Error(`--domain=${OPTS.domain} does not make a valid address (needs a dot, no spaces or @).`);
  }

  const conn = await mysql.createConnection(TARGET.cfg);
  const one = async (sql, p = []) => (await conn.execute(sql, p))[0][0] ?? null;
  const all = async (sql, p = []) => (await conn.execute(sql, p))[0];

  try {
    /* ── 1. the tenant, the app, and the role the seed should have made ── */

    const company = await one(
      'SELECT id, name FROM companies WHERE slug = ? AND deleted_at IS NULL', [OPTS.companySlug],
    );
    if (!company) throw new Error(`No company with slug '${OPTS.companySlug}'.`);

    const app = await one(
      'SELECT id FROM apps WHERE company_id = ? AND slug = ? AND deleted_at IS NULL',
      [company.id, 'cf_hrms'],
    );
    if (!app) throw new Error(`Company ${OPTS.companySlug} has no cf_hrms app row. Run setup, then models/seed.sql.`);

    const role = await one(
      'SELECT id, name FROM roles WHERE company_id = ? AND LOWER(name) = ? AND deleted_at IS NULL',
      [company.id, ROLE_NAME.toLowerCase()],
    );
    if (!role) {
      throw new Error(
        `Company ${OPTS.companySlug} has no '${ROLE_NAME}' role. models/seed.sql creates it `
        + '(section 3a) — apply the seed first. This script mints identities; it does not invent access.',
      );
    }

    /* ── 2. prove the grant before minting anything ─────────────────────
     * A role_capability row without an app_user_access row grants nothing, and
     * so does the reverse. This script writes the second; the seed writes the
     * first. If the first is missing, 71 people get a login that opens an app
     * with no screens in it — so check now, loudly, rather than discovering it
     * from a confused employee.
     */
    const grant = await one(
      `SELECT rc.id
         FROM role_capability rc
         JOIN features_capability fc ON fc.capability_id = rc.capability_id AND fc.deleted_at IS NULL
        WHERE rc.role_id = ? AND rc.deleted_at IS NULL AND fc.name = ?
          AND (rc.app_id = ? OR rc.app_id IS NULL)`,
      [role.id, SELF_TAG, app.id],
    );
    if (!grant) {
      throw new Error(
        `The '${role.name}' role does not hold ${SELF_TAG}. Apply models/seed.sql `
        + '(sections 1, 2 and 3a) and run this again.',
      );
    }
    console.log(`  tenant:   ${company.name} (id ${company.id}), app ${app.id}, role '${role.name}' (id ${role.id})`);
    console.log(`  grant:    ${SELF_TAG} is on the role — good\n`);

    /* ── 3. the people ──────────────────────────────────────────────────── */

    const employees = await all(
      `SELECT e.id, e.employee_code, e.full_name, e.email, e.employment_status, e.user_id,
              u.id AS linked_user_id, u.email AS linked_email, u.deleted_at AS linked_deleted
         FROM hrms_employees e
         LEFT JOIN users u ON u.id = e.user_id
        WHERE e.company_id = ? AND e.deleted_at IS NULL
          AND e.employment_status IN (${OPTS.statuses.map(() => '?').join(',')})
        ORDER BY e.employee_code, e.id`,
      [company.id, ...OPTS.statuses],
    );
    console.log(`  employees in scope: ${employees.length}\n`);
    if (!employees.length) {
      console.log('Nothing to do.');
      return;
    }

    /* ── 4. every address already in use, anywhere on the platform ──────
     * ONE query, not one per person (plan §16: a per-row round trip is free on
     * localhost and ruinous over the production link). Soft-deleted rows are
     * included because `users.email` is UNIQUE on the bare column and a deleted
     * row still occupies its address.
     */
    const existingUsers = await all('SELECT id, email, company_id, deleted_at FROM users');
    const byEmail = new Map(existingUsers.map((u) => [String(u.email).trim().toLowerCase(), u]));
    console.log(`  addresses already on the platform: ${byEmail.size}\n`);

    /**
     * Which logins are already spoken for by somebody.
     *
     * This is what makes the script survive a re-import, and it was learned the
     * hard way: the org-chart importer wipes and rebuilds `hrms_employees`, so
     * every `user_id` link disappears while the 71 `users` rows stay. On the
     * next run the addresses then look like collisions held by strangers, and
     * the ladder quietly mints a second login per person — `uvaish.raza@` plus
     * `uvaish.raza.kp0055@` — which is precisely the "two people quietly become
     * one login" failure wearing the opposite face.
     *
     * So an address held by a live user in THIS company that no live employee
     * is linked to is not a collision — it is this person's own login waiting
     * to be reconnected, and the plan says LINK.
     */
    const claimedByEmployee = new Map();
    for (const row of await all(
      'SELECT id, employee_code, user_id FROM hrms_employees WHERE company_id = ? AND deleted_at IS NULL AND user_id IS NOT NULL',
      [company.id],
    )) claimedByEmployee.set(row.user_id, row);

    /** True when `holder` is a login this employee may take over rather than avoid. */
    const reusableFor = (holder, e) => {
      if (!holder || holder.deleted_at || holder.company_id !== company.id) return false;
      const claim = claimedByEmployee.get(holder.id);
      return !claim || claim.id === e.id;
    };

    /* ── 5. allocate an address for everyone, before writing anything ─── */

    // Group by base name FIRST. That is what makes the result deterministic and
    // what lets a shared name be suffixed for everybody rather than for
    // whoever happened to be second.
    const groups = new Map();
    for (const e of employees) {
      const base = baseLocalPart(e.full_name);
      const key = base ?? `__unnamed__${e.id}`;
      const list = groups.get(key) ?? [];
      list.push(e);
      groups.set(key, list);
    }

    const sharedNames = [...groups.entries()].filter(([, list]) => list.length > 1);

    const allocated = new Map();   // employee id -> { email, how, note }
    // Addresses that are off limits. An address this very employee may reuse is
    // NOT off limits — `free()` decides that per employee, not globally.
    const taken = new Set(byEmail.keys());
    const claimedInThisRun = new Set();
    const notes = [];

    /** Is this address available TO THIS EMPLOYEE? */
    const free = (address, e) => {
      if (claimedInThisRun.has(address)) return false;
      if (!taken.has(address)) return true;
      return reusableFor(byEmail.get(address), e);
    };

    for (const [base, list] of groups) {
      const shared = list.length > 1;
      for (const e of list) {
        // 5a. the employee's own address wins, if it is usable and free.
        const own = String(e.email ?? '').trim().toLowerCase();
        if (own) {
          if (!EMAIL_RE.test(own)) {
            notes.push(`${e.employee_code} ${e.full_name}: own address '${own}' is not a valid address — minting one instead.`);
          } else if (free(own, e)) {
            allocated.set(e.id, { email: own, how: 'own', base });
            claimedInThisRun.add(own);
            continue;
          } else {
            const holder = byEmail.get(own);
            notes.push(
              `${e.employee_code} ${e.full_name}: own address '${own}' already belongs to `
              + (holder
                ? `users.id=${holder.id}${holder.company_id === company.id ? ' in this company' : ' in ANOTHER company'}`
                : 'another employee in this run')
              + ' — minting one instead. Two tenants sharing an address means one of them cannot log in at all.',
            );
          }
        }

        // 5b. mint. A shared base name is suffixed for EVERY member of the
        //     group, so nobody silently gets the plain address.
        if (!base) {
          notes.push(`employee id ${e.id} has no usable name — skipped. Fix the name on the employee record.`);
          continue;
        }
        const code = codePart(e.employee_code);
        const ladder = shared
          ? [code ? `${base}.${code}` : null, base].filter(Boolean)
          : [base, code ? `${base}.${code}` : null].filter(Boolean);

        let chosen = null;
        let how = shared ? 'minted+code' : 'minted';
        for (const local of ladder) {
          const candidate = `${local}@${OPTS.domain}`;
          if (free(candidate, e)) { chosen = candidate; break; }
        }
        if (!chosen) {
          // Still taken globally. Append a number and say which row holds the
          // address we wanted, so the clash is investigable rather than a guess.
          const wanted = `${ladder[0]}@${OPTS.domain}`;
          const holder = byEmail.get(wanted);
          for (let n = 2; n <= 99 && !chosen; n += 1) {
            const candidate = `${ladder[0]}.${n}@${OPTS.domain}`;
            if (free(candidate, e)) chosen = candidate;
          }
          how = 'minted+number';
          notes.push(
            `${e.employee_code} ${e.full_name}: wanted ${wanted}, already held by `
            + `${holder ? `users.id=${holder.id} (company ${holder.company_id})` : 'another employee in this run'}`
            + ` — using ${chosen}.`,
          );
        }
        if (!chosen) {
          notes.push(`${e.employee_code} ${e.full_name}: could not find a free address after 99 attempts — skipped.`);
          continue;
        }
        allocated.set(e.id, { email: chosen, how, base });
        claimedInThisRun.add(chosen);
      }
    }

    /* ── 6. decide, per person, what would happen ───────────────────────── */

    const plan = [];
    for (const e of employees) {
      const alloc = allocated.get(e.id);
      if (!alloc) { plan.push({ e, action: 'SKIP', reason: 'no usable address' }); continue; }

      // Already linked to a live user: leave it entirely alone.
      if (e.linked_user_id && !e.linked_deleted) {
        plan.push({ e, alloc, action: 'HAS_LOGIN', email: e.linked_email });
        continue;
      }
      // Not linked, but the address already exists: link, never duplicate, and
      // never touch the password. Re-running must not invalidate a password HR
      // has already handed out — and after a re-import of the org chart this is
      // the normal path for all 71, because the importer rebuilds
      // `hrms_employees` and every `user_id` link goes with it.
      const holder = byEmail.get(alloc.email);
      if (reusableFor(holder, e)) {
        plan.push({ e, alloc, action: 'LINK', email: alloc.email, userId: holder.id });
        continue;
      }
      plan.push({ e, alloc, action: 'CREATE', email: alloc.email });
    }

    /* ── 7. report ──────────────────────────────────────────────────────── */

    const counts = plan.reduce((t, p) => ({ ...t, [p.action]: (t[p.action] ?? 0) + 1 }), {});
    const pad = (s, n) => String(s ?? '').padEnd(n).slice(0, n);

    console.log('  code        name                           action      address');
    console.log('  ' + '─'.repeat(96));
    for (const p of plan) {
      console.log(`  ${pad(p.e.employee_code, 11)} ${pad(p.e.full_name, 30)} ${pad(p.action, 11)} ${p.email ?? p.reason ?? ''}`);
    }
    console.log('  ' + '─'.repeat(96));
    console.log(`\n  create ${counts.CREATE ?? 0} · link ${counts.LINK ?? 0} · already has a login ${counts.HAS_LOGIN ?? 0} · skip ${counts.SKIP ?? 0}`);

    if (sharedNames.length) {
      console.log(`\n  SHARED NAMES — ${sharedNames.length} name${sharedNames.length === 1 ? '' : 's'} held by more than one person.`);
      console.log('  Every member of a shared name carries its employee code in the address, so no two');
      console.log('  people can collapse into one login:');
      for (const [base, list] of sharedNames) {
        console.log(`    ${base}  →  ${list.map((e) => `${e.full_name} (${e.employee_code})`).join('  |  ')}`);
      }
    }

    if (notes.length) {
      console.log(`\n  THINGS WORTH READING (${notes.length}):`);
      for (const n of notes) console.log(`    - ${n}`);
    }

    const toCreate = plan.filter((p) => p.action === 'CREATE');

    if (!OPTS.apply) {
      console.log('\n  DRY RUN — nothing was written and no password was generated.');
      console.log('  Re-run with --apply to write. Add --target=prod to write to production.');
      printResetWarning(toCreate.length);
      return;
    }

    /* ── 8. write ───────────────────────────────────────────────────────── */

    const credentials = [];
    let created = 0;
    let linked = 0;

    for (const p of plan) {
      if (p.action === 'CREATE') {
        const password = makePassword();
        const hash = await bcrypt.hash(password, BCRYPT_COST);
        await conn.beginTransaction();
        try {
          const [r] = await conn.execute(
            // team_id is left NULL deliberately: it is the established pattern
            // on this platform, and authController joins role_capability with
            // the null-safe `rc.team_id <=> ?`, so a user with no team matches
            // a grant that names no team. Inventing a team here would silently
            // stop the grant matching.
            'INSERT INTO users (name, email, password, role_id, team_id, company_id) VALUES (?, ?, ?, ?, NULL, ?)',
            [p.e.full_name, p.email, hash, role.id, company.id],
          );
          const userId = r.insertId;
          await conn.execute(
            `INSERT INTO app_user_access (user_id, app_id, role_id, company_id)
             VALUES (?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE role_id = VALUES(role_id), company_id = VALUES(company_id), deleted_at = NULL`,
            [userId, app.id, role.id, company.id],
          );
          await conn.execute(
            'UPDATE hrms_employees SET user_id = ? WHERE company_id = ? AND id = ?',
            [userId, company.id, p.e.id],
          );
          await conn.commit();
          credentials.push({ ...p, userId, password });
          created += 1;
        } catch (err) {
          await conn.rollback().catch(() => {});
          console.error(`  FAILED ${p.e.employee_code} ${p.e.full_name} (${p.email}): ${err.message}`);
        }
      } else if (p.action === 'LINK') {
        await conn.beginTransaction();
        try {
          await conn.execute(
            `INSERT INTO app_user_access (user_id, app_id, role_id, company_id)
             VALUES (?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE deleted_at = NULL`,
            [p.userId, app.id, role.id, company.id],
          );
          await conn.execute(
            'UPDATE hrms_employees SET user_id = ? WHERE company_id = ? AND id = ?',
            [p.userId, company.id, p.e.id],
          );
          await conn.commit();
          linked += 1;
        } catch (err) {
          await conn.rollback().catch(() => {});
          console.error(`  FAILED to link ${p.e.employee_code} ${p.e.full_name}: ${err.message}`);
        }
      } else if (p.action === 'HAS_LOGIN') {
        // Make sure the existing login can still OPEN the app. A login whose
        // app_user_access row went missing looks like a permission bug.
        await conn.execute(
          `INSERT INTO app_user_access (user_id, app_id, role_id, company_id)
           VALUES (?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE deleted_at = NULL`,
          [p.e.linked_user_id, app.id, role.id, company.id],
        ).catch((err) => console.error(`  app access for users.id=${p.e.linked_user_id}: ${err.message}`));
      }
    }

    console.log(`\n  written: ${created} created, ${linked} linked to an existing login.`);

    /* ── 9. the credential file ─────────────────────────────────────────── */

    if (credentials.length) {
      const stamp = new Date().toISOString().slice(0, 10);
      // THE TARGET IS IN THE FILENAME. A date alone is not a unique name: a
      // local run and a production run on the same day collide, and the loser
      // is 71 live passwords that cannot be recovered from the database.
      const where = TARGET.isProd ? 'prod' : 'local';
      const { file, collided } = freePath(
        OPTS.out
          ? path.resolve(OPTS.out)
          : path.join(TM_ROOT, `${OPTS.companySlug}-employee-logins-${where}-${stamp}.csv`),
      );

      // And the target is in the FILE as well as the name, because a file gets
      // renamed, copied and forwarded. Somebody handing out the local list
      // against production hands out 71 passwords that do not work and learns
      // nothing about why. `TARGET.name` is the same string `announce()` already
      // prints on every run, so this discloses nothing new.
      const lines = [
        ['employee_code', 'full_name', 'email', 'password', 'login_url', 'target', 'database'].join(','),
        ...credentials.map((c) => [
          c.e.employee_code, c.e.full_name, c.email, c.password,
          `/${OPTS.companySlug}/cf_hrms/login`,
          TARGET.isProd ? 'PRODUCTION' : 'LOCAL',
          TARGET.name,
        ].map(csvCell).join(',')),
      ];
      fs.writeFileSync(file, `${lines.join('\r\n')}\r\n`, { encoding: 'utf8' });

      console.log(`\n  CREDENTIALS: ${credentials.length} password${credentials.length === 1 ? '' : 's'} for `
        + `${TARGET.isProd ? 'PRODUCTION' : 'LOCAL'} written to`);
      console.log(`    ${file}`);
      if (collided) {
        console.log('  (A file with the preferred name already existed. It was NOT touched — a');
        console.log('   credentials file is written once and never replaced.)');
      }
      console.log('  That path is OUTSIDE both git repositories (TM/ is not a repo). The passwords are');
      console.log('  deliberately not printed here and must not go into the org-chart Excel workbook —');
      console.log('  that file gets emailed. Hand the CSV to HR, then delete it.');
      console.log('  THESE PASSWORDS EXIST NOWHERE ELSE. They are bcrypt-hashed in the database and');
      console.log('  cannot be read back, and re-running this script will NOT reissue them — it will');
      console.log('  report "already has a login" and write no file at all.');
    }

    printResetWarning(created);
  } finally {
    await conn.end();
  }
}

/**
 * The gap the user has to decide about. Printed on every run, dry or not,
 * because it does not get less true with repetition.
 */
function printResetWarning(count) {
  if (!count) return;
  console.log('\n  ── A DECISION THIS PLATFORM CANNOT MAKE FOR YOU ──────────────────────────');
  console.log('  There is no password-reset flow and no force-change-on-first-login in this');
  console.log('  product. A minted password is PERMANENT until an administrator changes it on');
  console.log(`  Setup › People with logins. For ${count} shop-floor users that means:`);
  console.log('    - nobody can recover their own account;');
  console.log('    - every password HR distributes stays valid for as long as the account does;');
  console.log('    - the CSV above is the only copy, and it is plaintext.');
  console.log('  Worth deciding before these are handed out.\n');
}

main().catch((e) => { console.error(`\n${e.message}\n`); process.exit(1); });
