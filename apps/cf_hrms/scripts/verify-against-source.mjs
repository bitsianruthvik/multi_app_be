/**
 * Does what is in the database actually match Org_Chart_V12.html?
 *
 * WHY THIS IS NOT THE SAME AS THE IMPORT'S OWN REPORT. The importer prints
 * counts it computed while writing, and afterwards we counted rows and got the
 * same numbers. That is the database agreeing with itself, and with the process
 * that filled it. It cannot catch a value that was written wrong, only a row
 * that is missing.
 *
 * The cf_erp session hit exactly that on a different import: an interrupted run
 * was resumed, the resumed pass wrote only what was MISSING, and one part kept a
 * stale thickness — 30 where the source said 25, worth 1,441 kg. Every
 * self-consistency check passed, because they compared the model to itself.
 *
 * So this walks the SOURCE file and asserts, field by field, that the database
 * says the same thing. It is the only check that can fail when the import was
 * subtly wrong rather than incomplete.
 *
 *   node verify-against-source.mjs --company=karni [--target=prod]
 *
 * Read-only. Exits 1 on any mismatch.
 */
import fs from 'fs';
import mysql from 'mysql2/promise';
import { resolveTarget, announce } from './dbTarget.mjs';

const TARGET = resolveTarget();
const SOURCE = 'C:/Users/Digital Initiatives/Downloads/Org_Chart_V12.html';
const args = process.argv.slice(2);
const COMPANY_SLUG = (args.find((a) => a.startsWith('--company=')) || '--company=karni').split('=')[1];

const norm = (s) => String(s ?? '').trim().replace(/\s+/g, ' ');
const normKey = (s) => norm(s).toLowerCase().replace(/[.;,]+$/, '');

const fails = [];
const passes = [];
const check = (name, ok, detail) => (ok ? passes.push(name) : fails.push({ name, detail }));

async function main() {
  announce(TARGET);

  const html = fs.readFileSync(SOURCE, 'utf8');
  const seed = JSON.parse(html.match(/<script id="seed" type="application\/json">([\s\S]*?)<\/script>/)[1]);
  const nodes = seed.positions;
  const byId = new Map(nodes.map((p) => [p.id, p]));
  const real = nodes.filter((p) => p.kind !== 'machine');
  const machines = nodes.filter((p) => p.kind === 'machine');

  const managerOf = (p) => { let c = byId.get(p.reportsTo), g = 0; while (c && c.kind === 'machine' && g++ < 50) c = byId.get(c.reportsTo); return c || null; };
  const contextsOf = (p) => { const out = []; let c = byId.get(p.reportsTo), g = 0; while (c && c.kind !== 'role' && g++ < 50) { if (c.kind === 'machine') out.push(c); c = byId.get(c.reportsTo); } return out; };

  const conn = await mysql.createConnection(TARGET.cfg);
  const q = async (sql, p = []) => (await conn.execute(sql, p))[0];
  const [[company]] = await conn.query('SELECT id, name FROM companies WHERE slug = ? AND deleted_at IS NULL', [COMPANY_SLUG]);
  if (!company) throw new Error(`No company "${COMPANY_SLUG}"`);
  const c = company.id;

  // ---- positions, keyed by the source node id we stored as position_code ----
  const posRows = await q('SELECT id, position_code, position_title, sanctioned_headcount FROM hrms_positions WHERE company_id=? AND deleted_at IS NULL', [c]);
  const posByCode = new Map(posRows.map((r) => [r.position_code, r]));

  check('every source position exists', posByCode.size === real.length,
    `source ${real.length}, db ${posByCode.size}`);

  const missing = real.filter((p) => !posByCode.has(p.id)).map((p) => p.id);
  check('no source node is absent', missing.length === 0, missing.slice(0, 8).join(', '));

  const titleMismatch = real.filter((p) => posByCode.has(p.id) && norm(posByCode.get(p.id).position_title) !== norm(p.title));
  check('every title matches the source', titleMismatch.length === 0,
    titleMismatch.slice(0, 5).map((p) => `${p.id}: source "${norm(p.title)}" vs db "${norm(posByCode.get(p.id).position_title)}"`).join(' | '));

  const headMismatch = real.filter((p) => posByCode.has(p.id) && Number(posByCode.get(p.id).sanctioned_headcount) !== Math.max(0, Number(p.req) || 0));
  check('every sanctioned headcount matches `req`', headMismatch.length === 0,
    headMismatch.slice(0, 5).map((p) => `${p.id}: source ${p.req} vs db ${posByCode.get(p.id).sanctioned_headcount}`).join(' | '));

  // ---- work contexts -------------------------------------------------------
  const ctxRows = await q('SELECT id, code, name FROM hrms_work_contexts WHERE company_id=? AND deleted_at IS NULL', [c]);
  const ctxByCode = new Map(ctxRows.map((r) => [r.code, r]));
  check('every machine became a work context', ctxByCode.size === machines.length, `source ${machines.length}, db ${ctxByCode.size}`);
  const ctxNameBad = machines.filter((m) => ctxByCode.has(m.id) && norm(ctxByCode.get(m.id).name) !== norm(m.title));
  check('every context name matches', ctxNameBad.length === 0, ctxNameBad.map((m) => m.id).join(', '));

  // A machine must NOT also be a position.
  const machineAsPosition = machines.filter((m) => posByCode.has(m.id));
  check('no machine became a position', machineAsPosition.length === 0, machineAsPosition.map((m) => m.id).join(', '));

  // ---- formal reporting: every edge, re-derived from the source ------------
  const edgeRows = await q(
    `SELECT f.position_code AS src, t.position_code AS dst, ty.code AS type
       FROM hrms_position_reporting_relationships r
       JOIN hrms_positions f ON f.company_id=r.company_id AND f.id=r.from_position_id
       JOIN hrms_positions t ON t.company_id=r.company_id AND t.id=r.to_position_id
       JOIN hrms_reporting_relationship_types ty ON ty.company_id=r.company_id AND ty.id=r.relationship_type_id
      WHERE r.company_id=? AND r.deleted_at IS NULL`, [c]);
  const edgeSet = new Set(edgeRows.map((e) => `${e.src}>${e.dst}:${e.type}`));

  const expectedPrimary = real.map((p) => { const m = managerOf(p); return m ? `${p.id}>${m.id}:PRIMARY_MANAGER` : null; }).filter(Boolean);
  const primaryMissing = expectedPrimary.filter((e) => !edgeSet.has(e));
  check('every primary reporting edge matches the source', primaryMissing.length === 0, primaryMissing.slice(0, 6).join(' | '));

  const expectedDotted = real.filter((p) => p.dotted && byId.has(p.dotted)).map((p) => `${p.id}>${p.dotted}:DOTTED_LINE`);
  const dottedMissing = expectedDotted.filter((e) => !edgeSet.has(e));
  check('every dotted line matches the source', dottedMissing.length === 0, dottedMissing.join(' | '));

  check('no reporting edge that the source does not have', edgeRows.length === expectedPrimary.length + expectedDotted.length,
    `db ${edgeRows.length}, source implies ${expectedPrimary.length + expectedDotted.length}`);

  // ---- position -> context links ------------------------------------------
  const linkRows = await q(
    `SELECT p.position_code AS pos, w.code AS ctx
       FROM hrms_position_work_contexts l
       JOIN hrms_positions p ON p.company_id=l.company_id AND p.id=l.position_id
       JOIN hrms_work_contexts w ON w.company_id=l.company_id AND w.id=l.work_context_id
      WHERE l.company_id=? AND l.deleted_at IS NULL`, [c]);
  const linkSet = new Set(linkRows.map((l) => `${l.pos}>${l.ctx}`));
  const expectedLinks = real.flatMap((p) => contextsOf(p).map((m) => `${p.id}>${m.id}`));
  const linkMissing = expectedLinks.filter((l) => !linkSet.has(l));
  check('every machine context link matches the source', linkMissing.length === 0, linkMissing.slice(0, 6).join(' | '));
  check('no context link the source does not imply', linkRows.length === expectedLinks.length,
    `db ${linkRows.length}, source implies ${expectedLinks.length}`);

  // ---- people: only the NAMED ones, and their seat ------------------------
  const namedSource = real.flatMap((p) => (p.people || []).filter((x) => norm(x.name)).map((x) => ({ node: p, person: x })));
  const empRows = await q('SELECT id, full_name FROM hrms_employees WHERE company_id=? AND deleted_at IS NULL', [c]);
  check('exactly the named people exist', empRows.length === namedSource.length, `source ${namedSource.length} named, db ${empRows.length}`);

  const dbNames = new Set(empRows.map((e) => normKey(e.full_name)));
  const nameMissing = namedSource.filter((r) => !dbNames.has(normKey(r.person.name))).map((r) => r.person.name);
  check('every named person is present', nameMissing.length === 0, nameMissing.join(', '));
  check('nobody blank-named was imported', empRows.every((e) => norm(e.full_name)), 'a blank-named employee exists');

  const asgRows = await q(
    `SELECT e.full_name, p.position_code
       FROM hrms_work_assignments a
       JOIN hrms_employees e ON e.company_id=a.company_id AND e.id=a.employee_id
       LEFT JOIN hrms_positions p ON p.company_id=a.company_id AND p.id=a.position_id
      WHERE a.company_id=? AND a.deleted_at IS NULL`, [c]);
  const seatSet = new Set(asgRows.map((a) => `${normKey(a.full_name)}@${a.position_code}`));
  const seatMissing = namedSource.filter((r) => !seatSet.has(`${normKey(r.person.name)}@${r.node.id}`))
    .map((r) => `${norm(r.person.name)} should sit in ${r.node.id}`);
  check('every person sits in the seat the source put them in', seatMissing.length === 0, seatMissing.join(' | '));

  // ---- responsibilities: the text itself, not just the count --------------
  const respRows = await q(
    `SELECT r.role_code, d.description
       FROM hrms_role_responsibility_assignments ra
       JOIN hrms_roles r ON r.company_id=ra.company_id AND r.id=ra.role_id
       JOIN hrms_responsibility_definitions d ON d.company_id=ra.company_id AND d.id=ra.responsibility_definition_id
      WHERE ra.company_id=? AND ra.deleted_at IS NULL`, [c]);
  const respByRole = new Map();
  for (const r of respRows) {
    if (!respByRole.has(r.role_code)) respByRole.set(r.role_code, new Set());
    respByRole.get(r.role_code).add(normKey(r.description));
  }
  // A role's code is the first node that carried its title, and repeated titles
  // merged — so check every source kra text is findable under SOME role.
  const allResp = new Set(respRows.map((r) => normKey(r.description)));
  const sourceKras = [...new Set(real.flatMap((p) => (p.kras || []).map(normKey)).filter(Boolean))];
  const kraMissing = sourceKras.filter((k) => !allResp.has(k));
  check('every responsibility text from the source is present', kraMissing.length === 0,
    `${kraMissing.length} missing, e.g. "${(kraMissing[0] || '').slice(0, 60)}"`);

  // ---- open points --------------------------------------------------------
  const opRows = await q('SELECT description FROM hrms_open_points WHERE company_id=? AND deleted_at IS NULL', [c]);
  const opSet = new Set(opRows.map((o) => normKey(o.description)));
  const sourceOps = [...(seed.meta?.openPoints || []), ...real.flatMap((p) => p.open || [])].map(normKey).filter(Boolean);
  const opMissing = [...new Set(sourceOps)].filter((o) => !opSet.has(o));
  check('every open point from the source is present', opMissing.length === 0,
    `${opMissing.length} missing, e.g. "${(opMissing[0] || '').slice(0, 60)}"`);

  // ---- duplicates: the shape a resumed run would leave --------------------
  const [[dupPos]] = await conn.query(
    'SELECT COUNT(*) n FROM (SELECT position_code FROM hrms_positions WHERE company_id=? AND deleted_at IS NULL GROUP BY position_code HAVING COUNT(*)>1) x', [c]);
  check('no duplicated position (a re-run would show here)', Number(dupPos.n) === 0, `${dupPos.n} codes appear twice`);
  const [[dupEmp]] = await conn.query(
    'SELECT COUNT(*) n FROM (SELECT full_name FROM hrms_employees WHERE company_id=? AND deleted_at IS NULL GROUP BY full_name HAVING COUNT(*)>1) x', [c]);
  check('no duplicated employee', Number(dupEmp.n) === 0, `${dupEmp.n} names appear twice`);

  await conn.end();

  console.log(`  ${passes.length} checks passed`);
  passes.forEach((p) => console.log(`    ok   ${p}`));
  if (fails.length) {
    console.log(`\n  ${fails.length} FAILED`);
    fails.forEach((f) => console.log(`    FAIL ${f.name}\n         ${f.detail}`));
    process.exit(1);
  }
  console.log('\n  The database matches the source file, field by field.');
}

main().catch((e) => { console.error(e); process.exit(1); });
