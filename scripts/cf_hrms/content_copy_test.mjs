/**
 * content_copy_test.mjs — copying content between roles and seats
 * (services/contentCopyService.js), against the LOCAL database.
 *
 *   cd multi_app_be && node scripts/cf_hrms/content_copy_test.mjs
 *   CF_TEST_COMPANY=60006 node scripts/cf_hrms/content_copy_test.mjs        (60006 = Karni, the default)
 *   node scripts/cf_hrms/content_copy_test.mjs --quiet                       (checks only, no count tables)
 *
 * EVERYTHING HAPPENS INSIDE ONE TRANSACTION THAT IS ROLLED BACK, and the last
 * thing it does is re-count every table it touched and prove each is back where
 * it started. Refuses to run against anything but a local database.
 *
 * It uses the tenant's REAL roles and seats where they exist (the role with the
 * most seats, a seat with people in it) and builds a small fixture of its own,
 * every row carrying this run's tag, for what Karni does not have yet (KRAs,
 * qualifications, skills, a role with a seat that suppresses a line). Nothing is
 * hard-coded: each case finds what it needs and SKIPS with a stated reason when
 * the data cannot exercise it.
 *
 * The seven things it proves are numbered as the brief numbered them:
 *   1 an overlay reaches ONE seat and not its siblings      4 a fork leaves the source role and its seats alone
 *   2 an add-to-role reaches every seat, and the count the  5 a bulk copy to several targets, one report
 *     screen was shown is the count that was changed        6 source and target sharing a role are refused
 *   3 a line the target has is reused, never doubled        7 the generated JD of an overlay seat agrees with the screen
 */
import path from 'path';
import { pathToFileURL } from 'url';
import { createRequire } from 'module';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const require = createRequire(path.join(BE, 'package.json'));
const { pool } = await imp('db.js');
const CC = await imp('apps/cf_hrms/services/contentCopyService.js');
const RC = await imp('apps/cf_hrms/services/roleContentService.js');
const RES = await imp('apps/cf_hrms/services/contentResolver.js');
const DOC = await imp('apps/cf_hrms/services/documentService.js');
const POS = await imp('apps/cf_hrms/services/positionService.js');
const JSZip = require('jszip');

const COMPANY = Number(process.env.CF_TEST_COMPANY ?? 60006);
const QUIET = process.argv.includes('--quiet');
const TAG = `ZZ-CPY-${Date.now().toString(36).toUpperCase()}`;

/* --------------------------------------------------------------------------
 * A tiny harness
 * ----------------------------------------------------------------------- */
let passed = 0;
let failed = 0;
let skipped = 0;
const fails = [];
/**
 * ok(label, cond, detail?) — the LABEL comes first, and it demands a string then
 * a boolean, so a swapped ok(cond, 'label') or a truthy object throws instead of
 * passing unconditionally.
 */
function ok(label, cond, detail = '') {
  if (typeof label !== 'string' || typeof cond !== 'boolean') {
    throw new Error(`ok(label: string, cond: boolean, detail?) — got (${typeof label}, ${typeof cond}) for "${String(label).slice(0, 60)}"`);
  }
  if (cond) { passed += 1; console.log(`  ok    ${label}`); return; }
  failed += 1;
  fails.push(label);
  console.log(`  FAIL  ${label}${detail ? `   -> ${detail}` : ''}`);
}
const skip = (label, why) => { skipped += 1; console.log(`  skip  ${label}   (${why})`); };
const section = (n, title) => console.log(`\n[${n}] ${title}`);

/** Runs fn and returns the error it threw (or null), so a refusal can be asserted on. */
async function refused(fn) {
  try { await fn(); return null; } catch (e) { return e; }
}

/* --------------------------------------------------------------------------
 * Counting
 * ----------------------------------------------------------------------- */
const TABLES = [
  'hrms_roles', 'hrms_positions',
  'hrms_responsibility_definitions', 'hrms_kra_definitions', 'hrms_kpi_definitions',
  'hrms_qualification_definitions', 'hrms_skill_definitions',
  'hrms_role_responsibility_assignments', 'hrms_role_kra_assignments', 'hrms_role_kpi_assignments',
  'hrms_role_qualification_requirements', 'hrms_role_skill_requirements',
  'hrms_position_content_overrides', 'hrms_work_assignments', 'hrms_manpower_requirements',
  'hrms_audit_log',
];

/** [live, total] rows per table for this company. */
async function count(db) {
  const out = {};
  for (const t of TABLES) {
    const [[r]] = await db.query(`SELECT COUNT(*) AS total, COALESCE(SUM(deleted_at IS NULL), 0) AS live FROM ${t} WHERE company_id = ?`, [COMPANY]);
    out[t] = { live: Number(r.live), total: Number(r.total) };
  }
  return out;
}
const diff = (a, b) => Object.fromEntries(TABLES.map((t) => [t, b[t].live - a[t].live]).filter(([, d]) => d !== 0));

function show(label, a, b) {
  if (QUIET) return;
  const d = TABLES.filter((t) => a[t].live !== b[t].live || a[t].total !== b[t].total);
  console.log(`        rows ${label}: ${d.length ? d.map((t) => `${t.replace('hrms_', '')} ${a[t].live} -> ${b[t].live}`).join(' | ') : 'no table changed'}`);
}

/* --------------------------------------------------------------------------
 * Finding what to test with
 * ----------------------------------------------------------------------- */
async function rolesWithSeats(db) {
  const [rows] = await db.query(
    `SELECT r.id, r.title,
            (SELECT COUNT(*) FROM hrms_positions p WHERE p.company_id = r.company_id AND p.role_id = r.id AND p.deleted_at IS NULL) AS seats,
            (SELECT COUNT(*) FROM hrms_role_responsibility_assignments a WHERE a.company_id = r.company_id AND a.role_id = r.id AND a.deleted_at IS NULL) AS resp,
            (SELECT COUNT(*) FROM hrms_role_kpi_assignments a WHERE a.company_id = r.company_id AND a.role_id = r.id AND a.deleted_at IS NULL) AS kpis,
            (SELECT COUNT(*) FROM hrms_position_content_overrides o JOIN hrms_positions p ON p.company_id = o.company_id AND p.id = o.position_id
              WHERE p.company_id = r.company_id AND p.role_id = r.id AND o.deleted_at IS NULL AND p.deleted_at IS NULL) AS overlays
       FROM hrms_roles r WHERE r.company_id = ? AND r.deleted_at IS NULL`,
    [COMPANY],
  );
  return rows.map((r) => ({ id: r.id, title: r.title, seats: Number(r.seats), resp: Number(r.resp), kpis: Number(r.kpis), overlays: Number(r.overlays) }));
}
const seatsOf = async (db, roleId) => (await db.query(
  'SELECT id, position_code FROM hrms_positions WHERE company_id = ? AND role_id = ? AND deleted_at IS NULL ORDER BY id', [COMPANY, roleId],
))[0];

/** A fingerprint of what a seat shows: every resolved line, by kind and key. Two seats that agree have the same one. */
async function signature(db, positionId, on) {
  const r = await RES.resolveContent(db, COMPANY, { positionId, on });
  const keys = [];
  const take = (kind, items) => items.forEach((i) => keys.push(`${kind}:${i.definitionId ?? i.sourceRowId}:${i.origin}`));
  take('kra', r.kras);
  for (const k of r.kras) { take('resp', k.responsibilities); take('kpi', k.kpis); }
  take('resp', r.additional.responsibilities); take('kpi', r.additional.kpis);
  for (const kind of ['skills', 'qualifications', 'experience', 'authorities', 'relationships', 'conditions']) take(kind, r[kind]);
  return { keys: keys.sort(), counts: r.counts, resolved: r };
}

/* ========================================================================== */
const ASSERT_LOCAL = async () => {
  const host = String(process.env.DB_HOST ?? 'localhost');
  if (!/^(localhost|127\.0\.0\.1|::1)$/.test(host)) throw new Error(`Refusing to run: DB_HOST is "${host}", not local.`);
};
await ASSERT_LOCAL();

const conn = await pool.getConnection();
let exitCode = 0;
try {
  await conn.beginTransaction();
  const db = conn;
  const [[admin]] = await db.query("SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE u.company_id = ? AND LOWER(r.name) = 'admin' ORDER BY u.id LIMIT 1", [COMPANY]);
  const c = { companyId: COMPANY, userId: admin?.id ?? null };
  const on = POS.today();
  const baseline = await count(db);
  console.log(`content_copy_test — company ${COMPANY}, run tag ${TAG}, as of ${on}`);

  /* ------------------------------------------------------------------------
   * Fixture. A source role with a KRA, grouped duties, a KPI with a sentence
   * target, a qualification and a skill — everything Karni has none of — and a
   * target role with four seats. Both are ours; no real role is edited.
   * --------------------------------------------------------------------- */
  const mk = async (kind, input) => RC.createMasterItem(db, c, kind, input);
  const kraA = await mk('kras', { name: `${TAG} Output`, description: 'How much is made.' });
  const kraB = await mk('kras', { name: `${TAG} Safety`, description: 'Nobody gets hurt.' });
  const respA1 = await mk('responsibilities', { name: `${TAG} Run the line.`, description: `${TAG} Run the line.` });
  const respA2 = await mk('responsibilities', { name: `${TAG} Log the shift`, description: `${TAG} Log the shift output every hour` });
  const respB1 = await mk('responsibilities', { name: `${TAG} Wear PPE`, description: `${TAG} Wear PPE at all times`, responsibilityClass: 'OWNER' });
  const respLoose = await mk('responsibilities', { name: `${TAG} Tidy the bay`, description: `${TAG} Tidy the bay at shift end` });
  const kpiText = await mk('kpis', { name: `${TAG} Plan achievement`, measurementType: 'TEXT' });
  const kpiNum = await mk('kpis', { name: `${TAG} Downtime`, measurementType: 'NUMBER', unit: 'min', defaultFrequency: 'WEEKLY' });
  const qual = await mk('qualifications', { name: `${TAG} ITI Fitter`, qualificationType: 'EDUCATION' });
  const skill = await mk('skills', { name: `${TAG} Reading a drawing`, skillType: 'TECHNICAL' });
  const dead = await mk('responsibilities', { name: `${TAG} Retired duty`, description: `${TAG} A duty nobody may copy now` });

  const srcRole = await RC.createRole(db, c, { title: `${TAG} Source role`, rolePurpose: 'Fixture.', status: 'ACTIVE' });
  const add = (roleId, kind, body) => RC.addContent(db, c, roleId, kind, body);
  const sKraA = await add(srcRole.id, 'kras', { kraDefinitionId: kraA.id, weightPercent: 60 });
  await add(srcRole.id, 'kras', { kraDefinitionId: kraB.id, weightPercent: 40 });
  await add(srcRole.id, 'responsibilities', { responsibilityDefinitionId: respA1.id, roleKraAssignmentId: sKraA.id });
  await add(srcRole.id, 'responsibilities', { responsibilityDefinitionId: respA2.id, roleKraAssignmentId: sKraA.id, responsibilityClassOverride: 'REVIEWER' });
  await add(srcRole.id, 'responsibilities', { responsibilityDefinitionId: respB1.id, isMandatory: false });
  await add(srcRole.id, 'responsibilities', { responsibilityDefinitionId: respLoose.id });
  await add(srcRole.id, 'responsibilities', { responsibilityDefinitionId: dead.id });
  await add(srcRole.id, 'kpis', { kpiDefinitionId: kpiText.id, targetOperator: 'EQ', targetValue: '95% of plan', roleKraAssignmentId: sKraA.id });
  await add(srcRole.id, 'kpis', { kpiDefinitionId: kpiNum.id, targetOperator: 'LTE', targetValue: 30, weightPercent: 10, frequencyOverride: 'DAILY' });
  await add(srcRole.id, 'qualifications', { qualificationDefinitionId: qual.id, requirementLevel: 'PREFERRED' });
  await add(srcRole.id, 'skills', { skillDefinitionId: skill.id, proficiencyLevel: 'Advanced' });
  await add(srcRole.id, 'experience', { minYears: 3, experienceArea: `${TAG} packaging` });
  await add(srcRole.id, 'conditions', { conditionType: 'PPE', description: `${TAG} Ear defenders on the floor` });
  await db.query('UPDATE hrms_responsibility_definitions SET status = ? WHERE company_id = ? AND id = ?', ['INACTIVE', COMPANY, dead.id]);

  const tgtRole = await RC.createRole(db, c, { title: `${TAG} Target role`, rolePurpose: 'Fixture.', status: 'ACTIVE' });
  const seatIds = [];
  for (let i = 1; i <= 4; i += 1) {
    const p = await POS.createPosition(db, c, { roleId: tgtRole.id, positionCode: `${TAG}-S${i}`, positionTitle: 'Fixture seat', status: 'ACTIVE' });
    seatIds.push(p.position.id);
  }
  const [S1, S2, S3, S4] = seatIds;
  const srcKey = (kind, def) => `${kind}:${def.id}`;

  /* ======================================================================
   * 1. A seat overlay reaches ONE seat
   * ==================================================================== */
  section(1, 'SEAT mode: an overlay on one seat, not its siblings');
  {
    const before = await count(db);
    const sigS1 = await signature(db, S1, on);
    const sigS2 = await signature(db, S2, on);
    const sigRole = await RES.resolveContent(db, COMPANY, { roleId: tgtRole.id, on });
    ok('before: no seat of the target role carries any responsibility', sigS1.counts.responsibilities === 0 && sigS2.counts.responsibilities === 0 && sigRole.counts.responsibilities === 0);

    const body = { source: { type: 'role', id: srcRole.id }, targets: [{ type: 'position', id: S1 }], mode: 'SEAT', kinds: ['kras', 'responsibilities', 'kpis'] };
    const prev = await CC.previewCopy(db, c, body);
    ok('preview writes nothing: no table changed', JSON.stringify(diff(before, await count(db))) === '{}');
    ok('preview says this reaches 1 seat and changes no role', prev.totals.seats === 1 && prev.dryRun === true && prev.mode === 'SEAT');
    ok('preview: 2 KRAs, 4 responsibilities (the 5th is inactive and blocked), 2 KPIs',
      prev.totals.byKind.kras.created === 2 && prev.totals.byKind.responsibilities.created === 4
      && prev.totals.byKind.responsibilities.blocked === 1 && prev.totals.byKind.kpis.created === 2,
      JSON.stringify(prev.totals.byKind));
    const blockedNames = prev.targets[0].exceptions.filter((e) => e.outcome === 'BLOCKED');
    ok('the inactive definition is blocked with a reason, not copied', blockedNames.length === 1 && /inactive/i.test(blockedNames[0].why), JSON.stringify(blockedNames));

    const rep = await CC.executeCopy(db, c, { ...body });
    const after = await count(db);
    show('SEAT copy of 2 KRAs + duties + 2 KPIs', before, after);
    const created = rep.totals.created;
    ok('report: written, not a dry run', rep.dryRun === false && created > 0);
    ok('exactly that many overlay rows were added, and nothing else but audit changed',
      diff(before, after).hrms_position_content_overrides === created && Object.keys(diff(before, after)).every((t) => ['hrms_position_content_overrides', 'hrms_audit_log'].includes(t)),
      JSON.stringify(diff(before, after)));
    ok('report says no definition was created — the masters did not grow',
      rep.totals.definitionsCreated === 0 && after.hrms_responsibility_definitions.total === before.hrms_responsibility_definitions.total
      && after.hrms_kra_definitions.total === before.hrms_kra_definitions.total && after.hrms_kpi_definitions.total === before.hrms_kpi_definitions.total);

    const s1 = await signature(db, S1, on);
    const s2 = await signature(db, S2, on);
    const role = await RES.resolveContent(db, COMPANY, { roleId: tgtRole.id, on });
    ok('THE POINT: the resolver returns the copied lines for the chosen seat', s1.counts.responsibilities === rep.totals.byKind.responsibilities.created && s1.counts.kras === 2 && s1.counts.kpis === 2, JSON.stringify(s1.counts));
    ok('...tagged as specific to that position', s1.resolved.additional.responsibilities.concat(s1.resolved.kras.flatMap((k) => k.responsibilities)).every((r) => r.origin === 'POSITION'));
    ok('...and NOT for a sibling seat sharing the role', s2.counts.responsibilities === 0 && s2.counts.kras === 0 && s2.counts.kpis === 0, JSON.stringify(s2.counts));
    ok('...and not for the role itself', role.counts.responsibilities === 0 && role.counts.kras === 0);
    const kra = s1.resolved.kras.find((k) => k.definitionId === kraA.id);
    ok('grouping survives: the duties filed under the Output KRA are still under it on the seat', !!kra && kra.responsibilities.length === 2 && kra.kpis.length === 1, JSON.stringify(kra?.responsibilities?.map((r) => r.name)));
    const textKpi = s1.resolved.kras.flatMap((k) => k.kpis).find((k) => k.definitionId === kpiText.id);
    ok('a sentence KPI target is carried over, not lost', textKpi?.targetText === '95% of plan', textKpi?.targetText);
    const numKpi = s1.resolved.additional.kpis.find((k) => k.definitionId === kpiNum.id);
    ok('a numeric target, weight and frequency override travel too', numKpi?.targetOperator === 'LTE' && Number(numKpi?.targetValue) === 30 && Number(numKpi?.weightPercent) === 10 && numKpi?.frequency === 'DAILY', JSON.stringify(numKpi && { op: numKpi.targetOperator, v: numKpi.targetValue, w: numKpi.weightPercent, f: numKpi.frequency }));
    const optional = s1.resolved.additional.responsibilities.find((r) => r.definitionId === respB1.id);
    ok('"not mandatory" is carried; a class that is only the master\'s own is not turned into an override', optional?.isMandatory === false && optional?.responsibilityClass === 'OWNER' && !optional.overridden, JSON.stringify(optional && { m: optional.isMandatory, cls: optional.responsibilityClass, o: optional.overridden }));
    const reviewer = s1.resolved.kras.flatMap((k) => k.responsibilities).find((r) => r.definitionId === respA2.id);
    ok('a class override on the source line (REVIEWER) is carried', reviewer?.responsibilityClass === 'REVIEWER', reviewer?.responsibilityClass);
    const [[audit1]] = await db.query("SELECT COUNT(*) n FROM hrms_audit_log WHERE company_id = ? AND entity_type = 'hrms_positions' AND entity_id = ? AND action = 'UPDATE' AND JSON_EXTRACT(after_json, '$.mode') = 'SEAT'", [COMPANY, S1]);
    ok('one audit row names the source and the mode', Number(audit1.n) === 1);
    const [[ovr]] = await db.query('SELECT reason FROM hrms_position_content_overrides WHERE company_id = ? AND position_id = ? AND deleted_at IS NULL LIMIT 1', [COMPANY, S1]);
    ok('each overlay carries its reason: where it was copied from', /^Copied from .*Source role.* on \d{4}-\d{2}-\d{2}$/.test(ovr?.reason ?? ''), ovr?.reason);

    // run it again: nothing doubles
    const again = await CC.executeCopy(db, c, { ...body });
    ok('3. the same copy twice adds nothing — every line is reused', again.totals.created === 0 && again.totals.reused === created, JSON.stringify(again.totals));
    ok('...and the reason says it is already on the seat', again.targets[0].exceptions.filter((e) => e.outcome === 'REUSED').every((e) => e.code === 'ON_SEAT'));
    ok('...and the overlay row count did not move', (await count(db)).hrms_position_content_overrides.live === after.hrms_position_content_overrides.live);

    // qualification onto a seat is refused out loud
    const badBefore = await count(db);
    const err = await refused(() => CC.executeCopy(db, c, { ...body, kinds: ['qualifications', 'responsibilities'] }));
    ok('a qualification cannot go on a single seat: refused with a sentence', err?.code === 'KIND_NOT_ON_SEAT' && /qualification/i.test(err.message) && /role/i.test(err.message), err?.message);
    ok('...and nothing was written', JSON.stringify(diff(badBefore, await count(db))) === '{}');
  }

  /* ======================================================================
   * 2. Add to the role: every seat, and the number shown is the number changed
   * ==================================================================== */
  section(2, 'ROLE mode: every seat gets it, and the count shown beforehand is the count changed');
  {
    const before = await count(db);
    const body = { source: { type: 'role', id: srcRole.id }, targets: [{ type: 'role', id: tgtRole.id }], mode: 'ROLE', kinds: ['kras', 'responsibilities', 'kpis', 'qualifications', 'skills'] };
    const seatsBefore = await seatsOf(db, tgtRole.id);
    const prev = await CC.previewCopy(db, c, body);
    ok('preview states the blast radius as a number: all 4 seats of the role', prev.totals.seats === 4 && prev.confirmSeats === 4 && prev.needsSeatConfirmation === true, JSON.stringify(prev.totals));
    ok('...which is the real number of seats holding the role', prev.totals.seats === seatsBefore.length);
    ok('preview names the cost in a notice', prev.notices.some((n) => /4 seats/.test(n.text) && n.tone === 'warning'), JSON.stringify(prev.notices));

    let err = await refused(() => CC.executeCopy(db, c, body));
    ok('without confirming the seat count the write is refused', err?.code === 'CONFIRM_SEATS' && /4 seats/.test(err.message), err?.message);
    err = await refused(() => CC.executeCopy(db, c, { ...body, confirm: { seats: 3 } }));
    ok('with a stale number it is refused, naming both', err?.code === 'STALE_COUNT' && /3 seats/.test(err.message) && /4 seats/.test(err.message), err?.message);
    ok('...and neither refusal wrote anything', JSON.stringify(diff(before, await count(db))) === '{}');

    const rep = await CC.executeCopy(db, c, { ...body, confirm: { seats: prev.confirmSeats } });
    const after = await count(db);
    show('ROLE copy to a 4-seat role', before, after);
    ok('role rows added: 2 KRAs, the duties, 2 KPIs, 1 qualification, 1 skill',
      rep.totals.byKind.kras.created === 2 && rep.totals.byKind.qualifications.created === 1 && rep.totals.byKind.skills.created === 1 && rep.totals.byKind.kpis.created === 2, JSON.stringify(rep.totals.byKind));
    ok('no overlay was written — it went on the role', diff(before, after).hrms_position_content_overrides === undefined);

    let reached = 0;
    const want = rep.totals.byKind.responsibilities.created;
    for (const s of seatsBefore) {
      const sig = await signature(db, s.id, on);
      if (sig.counts.responsibilities === want && sig.counts.qualifications === 1 && sig.counts.skills === 1 && sig.counts.kras === 2) reached += 1;
    }
    ok(`every one of the ${seatsBefore.length} seats now shows them — the count shown (${prev.totals.seats}) equals the seats actually changed (${reached})`, reached === prev.totals.seats, `reached ${reached}`);
    const role = await RES.resolveContent(db, COMPANY, { roleId: tgtRole.id, on });
    const k = role.kras.find((x) => x.definitionId === kraA.id);
    ok('KRA grouping was rebuilt on the target role', k.responsibilities.length === 2 && k.kpis.length === 1);
    const q = role.qualifications[0];
    ok('a qualification keeps PREFERRED; a skill keeps its proficiency', q.requirementLevel === 'PREFERRED' && role.skills[0].proficiencyLevel === 'Advanced');
    const [seqs] = await db.query('SELECT sequence FROM hrms_role_responsibility_assignments WHERE company_id = ? AND role_id = ? AND deleted_at IS NULL ORDER BY sequence', [COMPANY, tgtRole.id]);
    ok('new rows are numbered 1..n in the source order', seqs.map((r) => Number(r.sequence)).join(',') === Array.from({ length: seqs.length }, (_, i) => i + 1).join(','));

    // 3. reuse
    const again = await CC.executeCopy(db, c, { ...body, confirm: { seats: 4 } });
    ok('3. repeating it reuses every line and creates none', again.totals.created === 0 && again.totals.reused === rep.totals.created, JSON.stringify(again.totals));
    ok('...reason: the role already carries it', again.targets[0].exceptions.filter((e) => e.outcome === 'REUSED').every((e) => e.code === 'ON_ROLE'));
    ok('...and no row count moved', (await count(db)).hrms_role_responsibility_assignments.live === after.hrms_role_responsibility_assignments.live);

    // a seat copy of something its role already says
    const seatBody = { source: { type: 'role', id: srcRole.id }, targets: [{ type: 'position', id: S3 }], mode: 'SEAT', kinds: ['responsibilities'] };
    const onRole = await CC.previewCopy(db, c, seatBody);
    ok('3. SEAT: a duty the seat\'s own role already carries is reused, not overlaid again',
      onRole.totals.created === 0 && onRole.totals.reused === rep.totals.byKind.responsibilities.created && onRole.targets[0].exceptions.some((e) => e.code === 'ON_ROLE'), JSON.stringify(onRole.totals));
  }

  /* ======================================================================
   * 3. Same words, different definition
   * ==================================================================== */
  section(3, 'Reuse by wording: a twin definition is not doubled, and no definition is created');
  {
    const roleX = await RC.createRole(db, c, { title: `${TAG} Twin role`, status: 'ACTIVE' });
    // The target already says "Run the line" — through a DIFFERENT definition, with a full stop and a capital the source does not have.
    const twin = await mk('responsibilities', { name: `${TAG} twin`, description: `  ${TAG.toLowerCase()}  RUN the   line  ;` });
    await add(roleX.id, 'responsibilities', { responsibilityDefinitionId: twin.id });
    const before = await count(db);
    const rep = await CC.executeCopy(db, c, {
      source: { type: 'role', id: srcRole.id }, targets: [{ type: 'role', id: roleX.id }], mode: 'ROLE',
      kinds: ['responsibilities'], lines: [srcKey('responsibilities', respA1), srcKey('responsibilities', respA2)], confirm: { seats: 0 },
    });
    const after = await count(db);
    show('copy where one line is already there under another definition', before, after);
    ok('"run the line" is recognised as already there, once normalised', rep.totals.reused === 1 && rep.targets[0].exceptions[0].code === 'SAME_WORDING', JSON.stringify(rep.targets[0].exceptions));
    ok('the other line is added — 1 created, 1 reused', rep.totals.created === 1);
    ok('no responsibility definition was created: the master row count is unchanged', after.hrms_responsibility_definitions.total === before.hrms_responsibility_definitions.total);
    ok('the role gained exactly one assignment', diff(before, after).hrms_role_responsibility_assignments === 1);
    // two source lines that say the same thing become one
    const dup = await mk('responsibilities', { name: `${TAG} dup`, description: `${TAG} Log the shift output every hour.` });
    await add(srcRole.id, 'responsibilities', { responsibilityDefinitionId: dup.id });
    const roleY = await RC.createRole(db, c, { title: `${TAG} Dup role`, status: 'ACTIVE' });
    const rep2 = await CC.executeCopy(db, c, {
      source: { type: 'role', id: srcRole.id }, targets: [{ type: 'role', id: roleY.id }], mode: 'ROLE',
      kinds: ['responsibilities'], lines: [srcKey('responsibilities', respA2), srcKey('responsibilities', dup)], confirm: { seats: 0 },
    });
    ok('two selected lines with the same words are added once', rep2.totals.created === 1 && rep2.totals.reused === 1 && rep2.targets[0].exceptions[0].code === 'REPEATED', JSON.stringify(rep2.totals));
    await db.query('UPDATE hrms_role_responsibility_assignments SET deleted_at = NOW() WHERE company_id = ? AND role_id = ? AND responsibility_definition_id = ?', [COMPANY, srcRole.id, dup.id]);
  }

  /* ======================================================================
   * 4 and 5. Fork, and bulk
   * ==================================================================== */
  section(4, 'FORK: a seat gets a role of its own; the old role and its other seats are untouched');
  {
    // a real seat with people in it, on a role with other seats
    const [cand] = await db.query(
      `SELECT p.id AS position_id, p.role_id, r.title AS role_title, COUNT(DISTINCT wa.id) AS people
         FROM hrms_positions p
         JOIN hrms_roles r ON r.company_id = p.company_id AND r.id = p.role_id
         JOIN hrms_work_assignments wa ON wa.company_id = p.company_id AND wa.position_id = p.id AND wa.role_id = p.role_id
              AND wa.deleted_at IS NULL AND wa.status IN ('PLANNED','ACTIVE','SUSPENDED')
        WHERE p.company_id = ? AND p.deleted_at IS NULL AND p.role_id <> ?
          AND (SELECT COUNT(*) FROM hrms_positions q WHERE q.company_id = p.company_id AND q.role_id = p.role_id AND q.deleted_at IS NULL) > 1
        GROUP BY p.id, p.role_id, r.title ORDER BY people DESC, p.id LIMIT 1`,
      [COMPANY, srcRole.id],
    );
    const pick = cand[0];
    if (!pick) skip('fork of a seat with people', 'no seat with people on a shared role in this tenant');
    else {
      const otherSeats = (await seatsOf(db, pick.role_id)).filter((s) => s.id !== pick.position_id);
      const sigBefore = {};
      for (const s of otherSeats) sigBefore[s.id] = (await signature(db, s.id, on)).keys.join('|');
      const forkedBefore = await signature(db, pick.position_id, on);
      const oldRole = await RES.resolveContent(db, COMPANY, { roleId: pick.role_id, on });
      const srcSigBefore = JSON.stringify((await RES.resolveContent(db, COMPANY, { roleId: srcRole.id, on })).counts);
      const [mpBefore] = await db.query('SELECT COUNT(*) n FROM hrms_manpower_requirements WHERE company_id = ? AND position_id = ? AND role_id = ? AND deleted_at IS NULL', [COMPANY, pick.position_id, pick.role_id]);
      const before = await count(db);
      const body = {
        source: { type: 'role', id: srcRole.id }, targets: [{ type: 'position', id: pick.position_id }], mode: 'FORK',
        kinds: ['kras', 'responsibilities', 'qualifications'],
      };
      const prev = await CC.previewCopy(db, c, body);
      ok(`preview: 1 seat, 1 new role, ${prev.totals.assignmentsMoved} work assignment(s) will move with the seat`, prev.totals.seats === 1 && prev.totals.newRoles === 1 && prev.totals.assignmentsMoved === Number(pick.people), JSON.stringify(prev.totals));
      const rep = await CC.executeCopy(db, c, body);
      const after = await count(db);
      show(`FORK of ${pick.role_title}`, before, after);
      const f = rep.targets[0].fork;
      const [[seat]] = await db.query('SELECT role_id FROM hrms_positions WHERE company_id = ? AND id = ?', [COMPANY, pick.position_id]);
      ok('the seat now points at the new role', seat.role_id === f.newRoleId && f.newRoleId !== pick.role_id);
      ok('the new role is titled from the old one and the seat code', f.newRoleTitle.startsWith(pick.role_title), f.newRoleTitle);
      ok('exactly one role was created', diff(before, after).hrms_roles === 1);

      const oldAfter = await RES.resolveContent(db, COMPANY, { roleId: pick.role_id, on });
      ok('the OLD role is untouched: same content counts', JSON.stringify(oldAfter.counts) === JSON.stringify(oldRole.counts), `${JSON.stringify(oldRole.counts)} vs ${JSON.stringify(oldAfter.counts)}`);
      let same = 0;
      for (const s of otherSeats) if ((await signature(db, s.id, on)).keys.join('|') === sigBefore[s.id]) same += 1;
      ok(`its other ${otherSeats.length} seats still resolve exactly what they did before`, same === otherSeats.length, `${same}/${otherSeats.length}`);
      ok('the SOURCE role is untouched too', JSON.stringify((await RES.resolveContent(db, COMPANY, { roleId: srcRole.id, on })).counts) === srcSigBefore);

      const forkedAfter = await signature(db, pick.position_id, on);
      ok('the forked seat has everything it had, plus the copied lines',
        forkedAfter.counts.responsibilities === forkedBefore.counts.responsibilities + rep.totals.byKind.responsibilities.created
        && forkedAfter.counts.kras === forkedBefore.counts.kras + 2 && forkedAfter.counts.qualifications === forkedBefore.counts.qualifications + 1
        && forkedAfter.counts.kpis === forkedBefore.counts.kpis, `${JSON.stringify(forkedBefore.counts)} -> ${JSON.stringify(forkedAfter.counts)}`);
      const everyLive = (await RC.getRoleContent(db, COMPANY, pick.role_id, { scope: 'all' })).counts;
      const clonedOk = Object.entries(f.cloned).every(([kind, n]) => n === everyLive[kind]);
      ok('every live row of the old role was cloned (all nine kinds)', clonedOk, JSON.stringify(f.cloned));

      const [still] = await db.query(
        `SELECT COUNT(*) n FROM hrms_work_assignments WHERE company_id = ? AND deleted_at IS NULL AND position_id = ? AND role_id = ? AND status IN ('PLANNED','ACTIVE','SUSPENDED')`,
        [COMPANY, pick.position_id, pick.role_id]);
      const [moved] = await db.query(
        `SELECT COUNT(*) n FROM hrms_work_assignments WHERE company_id = ? AND deleted_at IS NULL AND position_id = ? AND role_id = ? AND status IN ('PLANNED','ACTIVE','SUSPENDED')`,
        [COMPANY, pick.position_id, f.newRoleId]);
      ok(`the ${f.assignmentsMoved} people's work assignments moved with the seat — none left on the old role`, Number(still[0].n) === 0 && Number(moved[0].n) === f.assignmentsMoved && f.assignmentsMoved === Number(pick.people));
      const [mpAfter] = await db.query('SELECT COUNT(*) n FROM hrms_manpower_requirements WHERE company_id = ? AND position_id = ? AND role_id = ? AND deleted_at IS NULL', [COMPANY, pick.position_id, f.newRoleId]);
      ok('manpower rows for the seat moved with it', Number(mpAfter[0].n) === Number(mpBefore[0].n));
      const [differ] = await db.query(
        `SELECT COUNT(*) n FROM hrms_work_assignments wa JOIN hrms_positions p ON p.company_id = wa.company_id AND p.id = wa.position_id
          WHERE wa.company_id = ? AND wa.deleted_at IS NULL AND wa.status <> 'ENDED' AND wa.position_id = ? AND wa.role_id <> p.role_id`, [COMPANY, pick.position_id]);
      ok('no assignment in the seat disagrees with the seat about its role (no accidental "role exception")', Number(differ[0].n) === 0);

      // a second fork of the same seat with nothing new is refused
      const again = await refused(() => CC.executeCopy(db, c, { ...body, targets: [{ type: 'position', id: pick.position_id }] }));
      ok('forking again with nothing new to add is refused rather than making an empty copy', again?.code === 'NOTHING_TO_FORK' || again?.code === 'SAME_ROLE', again?.message);
    }
  }

  section(5, 'BULK: one copy, several targets, one transaction, one report');
  {
    // SEAT mode to three seats of a role that does not already say it
    const bulkRole = await RC.createRole(db, c, { title: `${TAG} Bulk role`, status: 'ACTIVE' });
    const bulkSeats = [];
    for (let i = 1; i <= 4; i += 1) {
      bulkSeats.push((await POS.createPosition(db, c, { roleId: bulkRole.id, positionCode: `${TAG}-B${i}`, positionTitle: 'Bulk seat', status: 'ACTIVE' })).position.id);
    }
    const [B1, B2, B3, B4] = bulkSeats;
    const before = await count(db);
    const body = {
      source: { type: 'role', id: srcRole.id }, targets: [B1, B2, B3].map((id) => ({ type: 'position', id })), mode: 'SEAT',
      kinds: ['kras', 'responsibilities'], lines: [srcKey('responsibilities', respA1), srcKey('responsibilities', respLoose), srcKey('kras', kraA)],
    };
    const prev = await CC.previewCopy(db, c, body);
    ok('preview: 3 seats, 3 lines each, nothing written', prev.totals.seats === 3 && prev.totals.created === 9 && JSON.stringify(diff(before, await count(db))) === '{}', JSON.stringify(prev.totals));
    const rep = await CC.executeCopy(db, c, body);
    const after = await count(db);
    show('bulk SEAT copy to 3 of 4 seats', before, after);
    ok('the report says plainly how many seats were touched: 3', rep.totals.seats === 3 && rep.totals.targets === 3);
    ok('each seat is accounted for line by line: 1 KRA + 2 duties created', rep.targets.every((t) => t.kinds.kras.created === 1 && t.kinds.responsibilities.created === 2), JSON.stringify(rep.targets.map((t) => t.kinds)));
    ok('overlay rows written = lines created across all seats (9)', diff(before, after).hrms_position_content_overrides === 9 && rep.totals.created === 9, `${diff(before, after).hrms_position_content_overrides} vs ${rep.totals.created}`);
    const sigs = await Promise.all([B1, B2, B3, B4].map((id) => signature(db, id, on)));
    ok('every ticked seat resolves the lines, the duty filed under the KRA that came with it', sigs.slice(0, 3).every((s) => s.counts.kras === 1 && s.counts.responsibilities === 2 && s.resolved.kras[0].responsibilities.length === 1));
    ok('the seat that was not ticked has none of it', sigs[3].counts.kras === 0 && sigs[3].counts.responsibilities === 0);
    ok('...nor does the role', (await RES.resolveContent(db, COMPANY, { roleId: bulkRole.id, on })).counts.responsibilities === 0);

    // ROLE mode to several roles at once
    const rolesList = (await rolesWithSeats(db)).filter((r) => ![srcRole.id, tgtRole.id, bulkRole.id].includes(r.id) && r.seats > 0 && r.resp === 0 && !r.title.startsWith('ZZ-CPY')).sort((a, b) => b.seats - a.seats).slice(0, 3);
    if (rolesList.length < 2) skip('bulk ROLE copy to several real roles', 'fewer than two roles with seats and no responsibilities');
    else {
      const b2 = await count(db);
      const targets = rolesList.map((r) => ({ type: 'role', id: r.id }));
      const body2 = { source: { type: 'role', id: srcRole.id }, targets, mode: 'ROLE', kinds: ['responsibilities', 'qualifications'] };
      const prev2 = await CC.previewCopy(db, c, body2);
      const expectedSeats = rolesList.reduce((n, r) => n + r.seats, 0);
      ok(`preview: ${rolesList.length} roles reach ${expectedSeats} seats in total (${rolesList.map((r) => `${r.title} ${r.seats}`).join(' + ')})`, prev2.totals.seats === expectedSeats && prev2.totals.targets === rolesList.length, JSON.stringify(prev2.totals));
      const rep2 = await CC.executeCopy(db, c, { ...body2, confirm: { seats: prev2.confirmSeats } });
      const a2 = await count(db);
      show(`bulk ROLE copy to ${rolesList.map((r) => r.title).join(', ')}`, b2, a2);
      ok('one report, one total: seats touched equals the sum', rep2.totals.seats === expectedSeats);
      ok('rows written = lines created across the roles', (diff(b2, a2).hrms_role_responsibility_assignments ?? 0) + (diff(b2, a2).hrms_role_qualification_requirements ?? 0) === rep2.totals.created);
      let seatsShowing = 0;
      for (const r of rolesList) for (const s of await seatsOf(db, r.id)) {
        const sig = await signature(db, s.id, on);
        if (sig.counts.qualifications === 1 && sig.counts.responsibilities >= rep2.totals.byKind.responsibilities.created / rolesList.length) seatsShowing += 1;
      }
      ok(`${expectedSeats} seats really show the new lines (the preview said ${prev2.totals.seats})`, seatsShowing === expectedSeats, `${seatsShowing}`);
    }

    // atomic: a bad target in the middle writes NOTHING for the good ones
    const b3 = await count(db);
    const err = await refused(() => CC.executeCopy(db, c, { source: { type: 'role', id: srcRole.id }, targets: [{ type: 'position', id: B4 }, { type: 'position', id: 999999999 }], mode: 'SEAT', kinds: ['responsibilities'] }));
    ok('one unknown target refuses the whole request', err?.status === 422, err?.message);
    ok('...and writes nothing for the good ones', JSON.stringify(diff(b3, await count(db))) === '{}');
  }

  /* ======================================================================
   * 6. Same role
   * ==================================================================== */
  section(6, 'Source and target already share a role: refused, out loud, nothing written');
  {
    const before = await count(db);
    const cases = [
      ['role onto itself', { source: { type: 'role', id: tgtRole.id }, targets: [{ type: 'role', id: tgtRole.id }], mode: 'ROLE', kinds: ['responsibilities'], confirm: { seats: 4 } }],
      ['role onto a seat that holds it', { source: { type: 'role', id: tgtRole.id }, targets: [{ type: 'position', id: S1 }], mode: 'SEAT', kinds: ['responsibilities'] }],
      ['seat onto a sibling seat of the same role', { source: { type: 'position', id: S1 }, targets: [{ type: 'position', id: S2 }], mode: 'SEAT', kinds: ['responsibilities'] }],
      ['seat onto its own role', { source: { type: 'position', id: S1 }, targets: [{ type: 'role', id: tgtRole.id }], mode: 'ROLE', kinds: ['responsibilities'], confirm: { seats: 4 } }],
      ['role to a seat of it, as a fork', { source: { type: 'role', id: tgtRole.id }, targets: [{ type: 'position', id: S2 }], mode: 'FORK', kinds: ['responsibilities'] }],
    ];
    for (const [label, body] of cases) {
      const e = await refused(() => CC.previewCopy(db, c, body));
      const w = await refused(() => CC.executeCopy(db, c, body));
      ok(`${label}: refused (preview and write) with the role named`, e?.code === 'SAME_ROLE' && w?.code === 'SAME_ROLE' && e.message.includes(tgtRole.title) && /Nothing was written/.test(e.message), e?.message);
    }
    ok('and not one row moved', JSON.stringify(diff(before, await count(db))) === '{}');
    const bulk = await refused(() => CC.previewCopy(db, c, { source: { type: 'role', id: srcRole.id }, targets: [{ type: 'position', id: S1 }, { type: 'role', id: srcRole.id }], mode: 'ROLE', kinds: ['responsibilities'] }));
    ok('in a bulk request, one target sharing the source\'s role refuses the lot', bulk?.code === 'SAME_ROLE', bulk?.message);
  }

  /* ======================================================================
   * 7. The generated JD agrees with the screen
   * ==================================================================== */
  section(7, 'A seat whose content came through an overlay renders the same in its generated JD');
  {
    // A role of its own, with one duty at role level; seat A gets one more through an overlay, seat B does not.
    const jdRole = await RC.createRole(db, c, { title: `${TAG} JD role`, rolePurpose: 'Fixture.', status: 'ACTIVE' });
    const roleLine = await mk('responsibilities', { name: `${TAG} Role line`, description: `${TAG} Keep the dispatch register` });
    await add(jdRole.id, 'responsibilities', { responsibilityDefinitionId: roleLine.id });
    const seatA = (await POS.createPosition(db, c, { roleId: jdRole.id, positionCode: `${TAG}-JD-A`, positionTitle: 'JD seat A', status: 'ACTIVE' })).position.id;
    const seatB = (await POS.createPosition(db, c, { roleId: jdRole.id, positionCode: `${TAG}-JD-B`, positionTitle: 'JD seat B', status: 'ACTIVE' })).position.id;
    const roleSrc2 = await RC.createRole(db, c, { title: `${TAG} JD source`, rolePurpose: 'x', status: 'ACTIVE' });
    const jdDef = await mk('responsibilities', { name: `${TAG} JD line`, description: `${TAG} Sign off the dispatch note` });
    await add(roleSrc2.id, 'responsibilities', { responsibilityDefinitionId: jdDef.id });
    await CC.executeCopy(db, c, { source: { type: 'role', id: roleSrc2.id }, targets: [{ type: 'position', id: seatA }], mode: 'SEAT', kinds: ['responsibilities'] });

    const screen = await RES.resolveContent(db, COMPANY, { positionId: seatA, on });
    const snapA = await DOC.buildSnapshot(db, c, { type: 'ROLE_JD', positionId: seatA, on });
    const snapB = await DOC.buildSnapshot(db, c, { type: 'ROLE_JD', positionId: seatB, on });
    const lineA = snapA.content.additional.responsibilities.find((r) => r.definitionId === jdDef.id);
    ok('the JD snapshot carries the copied line for the overlay seat', !!lineA, JSON.stringify(snapA.content.counts));
    ok('...marked as specific to that position, with exactly the sentence the screen has',
      lineA?.origin === 'POSITION' && /specific to this position/.test(lineA?.text ?? '')
      && lineA.text === screen.additional.responsibilities.find((r) => r.definitionId === jdDef.id).text, lineA?.text);
    ok('the JD and the screen agree on every count', JSON.stringify(snapA.content.counts) === JSON.stringify(screen.counts), `${JSON.stringify(snapA.content.counts)} vs ${JSON.stringify(screen.counts)}`);
    ok('the role-level line is on both seats; the overlay line is on seat A only',
      snapA.content.counts.responsibilities === 2 && snapB.content.counts.responsibilities === 1
      && !snapB.content.additional.responsibilities.some((r) => r.definitionId === jdDef.id));
    ok('the JD summary counts them the same way', snapA.summary.responsibilities === 2 && snapB.summary.responsibilities === 1);
    const docText = async (snap) => {
      const zip = await JSZip.loadAsync(await DOC.renderFromSnapshot(snap, 'docx'));
      return (await zip.file('word/document.xml').async('string')).replace(/<[^>]+>/g, ' ');
    };
    const textA = await docText(snapA);
    const textB = await docText(snapB);
    // The JD prints a line's NAME (the master's short label), not its description.
    ok('the DOCX the HR person prints contains the line for the overlay seat, and says where it came from', textA.includes(`${TAG} JD line`) && /specific to this position/.test(textA));
    ok('...and the sibling seat\'s DOCX has the role\'s line but not that one', !textB.includes(`${TAG} JD line`) && textB.includes(`${TAG} Role line`));
    const pdf = await DOC.renderFromSnapshot(snapA, 'pdf');
    ok('the PDF renders from the same snapshot', Buffer.isBuffer(pdf) && pdf.slice(0, 4).toString() === '%PDF' && pdf.length > 1000);

    // The Responsibility Profile of a person in that seat uses the same overlay.
    const [[asg]] = await db.query(`SELECT wa.id, wa.role_id, wa.position_id FROM hrms_work_assignments wa WHERE wa.company_id = ? AND wa.deleted_at IS NULL AND wa.status = 'ACTIVE' LIMIT 1`, [COMPANY]);
    if (asg) {
      await db.query('UPDATE hrms_work_assignments SET role_id = ?, position_id = ? WHERE company_id = ? AND id = ?', [jdRole.id, seatA, COMPANY, asg.id]);
      const prof = await RES.resolveContent(db, COMPANY, { workAssignmentId: asg.id, on });
      ok('a person assigned to that seat sees the line in their responsibility profile too',
        prof.additional.responsibilities.some((r) => r.definitionId === jdDef.id && r.origin === 'POSITION') && prof.counts.responsibilities === 2);
      await db.query('UPDATE hrms_work_assignments SET role_id = ?, position_id = ? WHERE company_id = ? AND id = ?', [asg.role_id, asg.position_id, COMPANY, asg.id]);
    } else skip('responsibility profile of an assigned person', 'no active assignment in this tenant');
    globalThis.__jd = { jdRole, seatA, seatB, jdDef, roleLine };
  }

  /* ======================================================================
   * Everything else the service promises
   * ==================================================================== */
  section('+', 'Seat exceptions, copying FROM a seat, free-standing kinds, KRA grouping, request validation, permissions');
  {
    const { seatA, jdDef, roleLine } = globalThis.__jd;
    // a seat that deliberately suppresses a duty keeps suppressing it
    const roleSup = await RC.createRole(db, c, { title: `${TAG} Suppress role`, status: 'ACTIVE' });
    const sup = (await POS.createPosition(db, c, { roleId: roleSup.id, positionCode: `${TAG}-SUP`, positionTitle: 'Suppressing seat', status: 'ACTIVE' })).position.id;
    await POS.addPositionOverride(db, c, sup, { contentType: 'RESPONSIBILITY', action: 'SUPPRESS', responsibilityDefinitionId: respLoose.id, reason: 'This seat never tidies.' });
    const before = await count(db);
    const rep = await CC.executeCopy(db, c, { source: { type: 'role', id: srcRole.id }, targets: [{ type: 'position', id: sup }], mode: 'SEAT', kinds: ['responsibilities'], lines: [srcKey('responsibilities', respLoose), srcKey('responsibilities', respA1)] });
    ok('a duty the seat suppresses is BLOCKED, with the reason, not quietly re-added', rep.targets[0].exceptions.some((e) => e.outcome === 'BLOCKED' && e.code === 'SUPPRESSED' && e.key === srcKey('responsibilities', respLoose)), JSON.stringify(rep.targets[0].exceptions));
    ok('...and the other line was still added', rep.totals.created === 1 && diff(before, await count(db)).hrms_position_content_overrides === 1);

    // copying FROM a seat copies what it effectively says: its role's lines AND its own exceptions
    const fromSeat = await CC.describeCopySource(db, COMPANY, { type: 'position', id: seatA });
    const origins = Object.fromEntries(fromSeat.lines.map((l) => [l.key, l.origin]));
    ok('a seat as a source lists its role\'s line (ROLE) and its own exception (POSITION)', origins[`responsibilities:${roleLine.id}`] === 'ROLE' && origins[`responsibilities:${jdDef.id}`] === 'POSITION', JSON.stringify(origins));
    const roleDest = await RC.createRole(db, c, { title: `${TAG} From-seat dest`, status: 'ACTIVE' });
    const rep2 = await CC.executeCopy(db, c, { source: { type: 'position', id: seatA }, targets: [{ type: 'role', id: roleDest.id }], mode: 'ROLE', kinds: ['responsibilities'], confirm: { seats: 0 } });
    const destSig = await RES.resolveContent(db, COMPANY, { roleId: roleDest.id, on });
    ok('copying FROM a seat to a role takes both, as ordinary role lines', rep2.totals.created === 2 && destSig.counts.responsibilities === 2
      && destSig.additional.responsibilities.every((r) => r.origin === 'ROLE'), JSON.stringify(destSig.counts));

    // free-standing kinds (no master): copied, and not doubled
    const roleFree = await RC.createRole(db, c, { title: `${TAG} Free-standing dest`, status: 'ACTIVE' });
    const freeBody = { source: { type: 'role', id: srcRole.id }, targets: [{ type: 'role', id: roleFree.id }], mode: 'ROLE', kinds: ['experience', 'conditions'], confirm: { seats: 0 } };
    const f1 = await CC.executeCopy(db, c, freeBody);
    const f2 = await CC.executeCopy(db, c, freeBody);
    const freeSig = await RES.resolveContent(db, COMPANY, { roleId: roleFree.id, on });
    ok('experience and working conditions have no master, so they are copied as rows — and a second copy adds nothing', f1.totals.created === 2 && f2.totals.created === 0 && f2.totals.reused === 2 && freeSig.counts.experience === 1 && freeSig.counts.conditions === 1, JSON.stringify([f1.totals.created, f2.totals.created, freeSig.counts]));

    // KRA grouping: a duty whose KRA is not copied lands under Additional, and the report says so
    const roleNoKra = await RC.createRole(db, c, { title: `${TAG} No KRA dest`, status: 'ACTIVE' });
    const prev = await CC.previewCopy(db, c, { source: { type: 'role', id: srcRole.id }, targets: [{ type: 'role', id: roleNoKra.id }], mode: 'ROLE', kinds: ['responsibilities'], lines: [srcKey('responsibilities', respA1), srcKey('responsibilities', respLoose)] });
    ok('a duty filed under a KRA that is not being copied is reported as landing under "Additional"', prev.totals.ungrouped === 1 && prev.notices.some((n) => /Additional/.test(n.text)), JSON.stringify(prev.totals));

    // validation
    const e1 = await refused(() => CC.previewCopy(db, c, { source: { type: 'role', id: srcRole.id }, targets: [{ type: 'role', id: roleNoKra.id }], mode: 'ROLE', kinds: ['hobbies'] }));
    ok('an unknown kind is refused with the kind named', e1?.status === 422 && e1.problems?.some((p) => /hobbies/.test(p)), JSON.stringify(e1?.problems));
    const e2 = await refused(() => CC.previewCopy(db, c, { source: { type: 'role', id: srcRole.id }, targets: [{ type: 'role', id: roleNoKra.id }], mode: 'SEAT', kinds: ['responsibilities'] }));
    ok('a role cannot be the target of a seat-only copy', e2?.code === 'TARGET_NEEDS_SEAT', e2?.message);
    const e3 = await refused(() => CC.previewCopy(db, c, { source: { type: 'role', id: srcRole.id }, targets: [{ type: 'role', id: roleNoKra.id }], mode: 'ROLE', kinds: ['responsibilities'], lines: ['responsibilities:1'] }));
    ok('a line key the source does not have is refused', e3?.status === 422, e3?.message);
    const e4 = await refused(() => CC.previewCopy(db, c, { source: { type: 'role', id: srcRole.id }, targets: [], mode: 'ROLE', kinds: [] }));
    ok('no targets and no kinds: both said at once', e4?.problems?.length >= 2, JSON.stringify(e4?.problems));
    const e5 = await refused(() => CC.previewCopy(db, c, { source: { type: 'role', id: srcRole.id }, targets: [{ type: 'position', id: S1 }], mode: 'TELEPORT', kinds: ['kras'] }));
    ok('an unknown mode is refused', e5?.status === 422 && e5.problems?.some((p) => /SEAT, ROLE, FORK/.test(p)), JSON.stringify(e5?.problems));

    // reach by mode — the three numbers the screen shows before anyone chooses
    const rb = (await CC.previewCopy(db, c, { source: { type: 'role', id: srcRole.id }, targets: [{ type: 'position', id: S1 }], mode: 'SEAT', kinds: ['kras'] })).reachByMode;
    ok('the preview states what each way of copying would reach: seat 1; role 4; fork 1 + a new role', rb.SEAT.seats === 1 && rb.ROLE.seats === 4 && rb.FORK.seats === 1 && rb.FORK.newRoles === 1, JSON.stringify(rb));

    // permissions, as the route asks for them
    const PERM = { orgManage: 'cf_hrms_org_manage', rolesManage: 'cf_hrms_roles_manage' };
    ok('SEAT asks for org_manage only', JSON.stringify(CC.permissionsForCopyMode('seat', PERM)) === JSON.stringify([PERM.orgManage]));
    ok('ROLE asks for roles_manage only', JSON.stringify(CC.permissionsForCopyMode('ROLE', PERM)) === JSON.stringify([PERM.rolesManage]));
    ok('FORK asks for both', CC.permissionsForCopyMode('FORK', PERM).length === 2);
    ok('no mode names cf_hrms_self_view', !JSON.stringify(['SEAT', 'ROLE', 'FORK'].map((m) => CC.permissionsForCopyMode(m, PERM))).includes('self_view'));
  }

  /* ------------------------------------------------------------------------
   * Roll everything back and prove it
   * --------------------------------------------------------------------- */
  const beforeRollback = await count(db);
  await conn.rollback();
  const finalCounts = await count(pool);
  const restored = TABLES.every((t) => finalCounts[t].live === baseline[t].live && finalCounts[t].total === baseline[t].total);
  console.log('\n[end] rolled back');
  if (!QUIET) console.log(`        rows at the end of the run, before rollback: ${TABLES.filter((t) => beforeRollback[t].total !== baseline[t].total).map((t) => `${t.replace('hrms_', '')} +${beforeRollback[t].total - baseline[t].total}`).join(' | ')}`);
  ok('every table is back to its starting row count, live and total', restored,
    TABLES.filter((t) => finalCounts[t].total !== baseline[t].total).map((t) => `${t} ${baseline[t].total}->${finalCounts[t].total}`).join(', '));
} catch (e) {
  failed += 1;
  fails.push(`unexpected error: ${e.message}`);
  console.error('\nUNEXPECTED ERROR', e);
  try { await conn.rollback(); } catch { /* the original error matters */ }
  exitCode = 1;
} finally {
  conn.release();
}

console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
if (failed) { console.log('failed:\n  - ' + fails.join('\n  - ')); exitCode = 1; }
await pool.end();
process.exit(exitCode);
