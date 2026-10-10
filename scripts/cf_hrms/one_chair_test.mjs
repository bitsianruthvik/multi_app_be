/**
 * one_chair_test.mjs — one position is one chair (2026-10-10).
 *
 * The HR model went from three levels (role → position holding several seats →
 * people) to two: a role, and positions under it, each ONE chair for ONE person
 * on ONE shift. This suite holds the backend to that, on the real services:
 *
 *   1. the numbers on the tenant as it stands (Karni: 220 / 71 / 149), from
 *      every place that states them — chart, Home, Positions, Departments;
 *   2. every node's shape, and the CARDS chairs are drawn in (cardId);
 *   3. position create / update: always one seat, always a shift;
 *   4. add-sibling: code, shift, reporting line, no content copied, same card;
 *   5. one person per position: 409 POSITION_FILLED on create, edit and reopen;
 *   6. a position's shift change moves the person in it;
 *   7. the employee's own slice: the day in-charge sees the night crew;
 *   8. close / delete of one chair of a multi-chair card (the team stays with
 *      the card) versus the card's last chair (the team moves up);
 *   9. the retired importers refuse a one-chair tenant.
 *
 *   node scripts/cf_hrms/one_chair_test.mjs [--company=karni] [--verbose]
 *
 * NOTHING IS LEFT BEHIND. Sections 1–2 and 9 only read. Everything else runs
 * in ONE transaction on one connection, on fixtures this file creates (its own
 * roles, department, positions, employees — every name carries a per-run tag),
 * and the transaction is ROLLED BACK. The last check re-reads the tenant and
 * compares row counts with the start. No tenant row is edited, even inside the
 * transaction, except that one unlinked login is pointed at a fixture employee
 * for the slice checks (rolled back with the rest).
 *
 * Local only — it refuses a non-local DB_HOST. The 220 / 71 / 149 figures are
 * local Karni's; on another company they are skipped, with a line saying so.
 */
import { pool } from '../../db.js';
import * as POS from '../../apps/cf_hrms/services/positionService.js';
import * as ASG from '../../apps/cf_hrms/services/assignmentService.js';
import * as RC from '../../apps/cf_hrms/services/roleContentService.js';
import { buildOrgChart, getPositionCard, searchOrgChart } from '../../apps/cf_hrms/services/orgChartService.js';
import { myOrgChart } from '../../apps/cf_hrms/services/selfOrgChartService.js';
import { myPlace } from '../../apps/cf_hrms/services/selfService.js';
import { departmentStaffing } from '../../apps/cf_hrms/services/jobContentService.js';
import { createDepartment } from '../../apps/cf_hrms/services/organisationService.js';
import { computeCards, loadCards } from '../../apps/cf_hrms/services/positionCards.js';
import { SEAT_TOTALS_SQL } from '../../apps/cf_hrms/services/seatCount.js';
import { oneChairState, oneChairRefusal, ONE_CHAIR_OVERRIDE } from '../../apps/cf_hrms/scripts/lib/oneChairGuard.mjs';
import positionsRouter from '../../apps/cf_hrms/routes/positions.js';

const slug = (process.argv.find((a) => a.startsWith('--company=')) || '--company=karni').split('=')[1];
const VERBOSE = process.argv.includes('--verbose');
if (!['localhost', '127.0.0.1', '::1'].includes(String(process.env.DB_HOST ?? 'localhost'))) {
  console.error(`Refusing to run against DB_HOST=${process.env.DB_HOST}. This test is local only.`);
  process.exit(2);
}

let passed = 0;
const failed = [];
const skipped = [];
const ok = (cond, name, detail = '') => {
  if (cond) { passed += 1; if (VERBOSE) console.log(`  ok    ${name}`); } else { failed.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
  return Boolean(cond);
};
const skip = (name, why) => { skipped.push(`${name}: ${why}`); };
const section = (title) => console.log(`\n${title}`);
/** Runs fn and returns what it threw (or null). */
const caught = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

const [[company]] = await pool.query('SELECT id, name FROM companies WHERE slug = ? AND deleted_at IS NULL', [slug]);
if (!company) { console.error(`No company "${slug}".`); process.exit(2); }
const COMPANY = company.id;
const TAG = `ZZ1C${Date.now().toString(36).toUpperCase().slice(-5)}`;
const on = POS.today();

const TABLES = ['hrms_positions', 'hrms_position_reporting_relationships', 'hrms_work_assignments', 'hrms_employees',
  'hrms_roles', 'hrms_departments', 'hrms_position_content_overrides', 'hrms_responsibility_definitions', 'hrms_audit_log'];
const rowCounts = async (db) => {
  const out = {};
  for (const t of TABLES) {
    const [[r]] = await db.query(`SELECT COUNT(*) AS total, SUM(deleted_at IS NULL) AS live FROM ${t} WHERE company_id = ?`, [COMPANY]);
    out[t] = `${r.total}/${r.live ?? 0}`;
  }
  return out;
};
const linkedUsers = async (db) => (await db.query(
  'SELECT COUNT(*) AS n FROM hrms_employees WHERE company_id = ? AND deleted_at IS NULL AND user_id IS NOT NULL', [COMPANY]))[0][0].n;
const baseline = await rowCounts(pool);
const baselineLinked = await linkedUsers(pool);
console.log(`one_chair_test — ${company.name} (${COMPANY}), run tag ${TAG}, as of ${on}`);

/* ══ 1. the numbers, from every place that states them ════════════════════ */
section('[1] Counts: positions / filled / vacant, the same everywhere');
const chart = await buildOrgChart(pool, COMPANY, {});
const liveOn = (a) => POS.LIVE_ON(a);
const [[home]] = await pool.query(SEAT_TOTALS_SQL(liveOn), [COMPANY, on, on, COMPANY, on, on]);
const list = await POS.listPositions(pool, COMPANY, { status: 'DRAFT,ACTIVE,FROZEN' });
const staffing = await departmentStaffing(pool, COMPANY, {});
const { counts } = chart;

if (slug === 'karni') {
  ok(counts.positions === 220 && counts.filled === 71 && counts.vacant === 149, 'Karni: 220 positions, 71 filled, 149 vacant',
    `${counts.positions} / ${counts.filled} / ${counts.vacant}`);
  ok(counts.byShift.General?.positions === 58 && counts.byShift.Day?.positions === 90 && counts.byShift.Night?.positions === 72,
    'Karni by shift: General 58, Day 90, Night 72', JSON.stringify(counts.byShift));
} else skip('220 / 71 / 149', `those are local Karni's numbers and this is ${slug}`);
ok(counts.sanctioned === counts.positions, 'sanctioned is the number of positions');
ok(counts.filled + counts.vacant === counts.positions, 'filled + vacant = positions');
ok(counts.positions === chart.nodes.length, 'counts.positions is the number of nodes');
ok(counts.cards === new Set(chart.nodes.map((n) => n.cardId)).size && counts.cards > 0 && counts.cards <= counts.positions, 'counts.cards is the number of distinct cardIds');
ok(Object.values(counts.byShift).reduce((t, s) => t + s.positions, 0) === counts.positions
  && Object.values(counts.byShift).reduce((t, s) => t + s.filled, 0) === counts.filled, 'byShift adds up to the totals');
ok(!('DN' in counts.byShiftPattern), 'no DN shift pattern is counted');
ok(Number(home.positions) === counts.positions && Number(home.sanctioned) === counts.positions
  && Number(home.filled) === counts.filled && Number(home.vacant) === counts.vacant, 'Home / nav badges (SEAT_TOTALS_SQL) agree with the chart',
`${home.positions} / ${home.filled} / ${home.vacant}`);
ok(list.totals.sanctioned === counts.positions && list.totals.filled === counts.filled && list.totals.vacant === counts.vacant,
  'the Positions list (non-closed) agrees with the chart', JSON.stringify(list.totals));
ok(staffing.counts.seats === counts.positions && staffing.counts.filled === counts.filled && staffing.counts.vacant === counts.vacant,
  'Departments staffing agrees with the chart', JSON.stringify(staffing.counts));
const staffRows = staffing.departments.flatMap((d) => d.roles.flatMap((r) => r.positions));
ok(staffRows.every((p) => p.seats === 1 && p.filled + p.vacant === 1 && (p.occupant === null) === (p.filled === 0) && 'shift' in p && 'cardId' in p),
  'every staffing row is one seat, filled or vacant, with its shift, card and single occupant');

/* ══ 2. the node shape and the cards ══════════════════════════════════════ */
section('[2] Chart nodes: one chair each, drawn in cards');
const nodeById = new Map(chart.nodes.map((n) => [n.id, n]));
ok(chart.nodes.every((n) => n.sanctionedHeadcount === 1 && n.effectiveSanctioned === 1), 'sanctionedHeadcount and effectiveSanctioned are 1 on every node');
ok(chart.nodes.every((n) => Array.isArray(n.requirements) && n.requirements.length === 0), 'requirements is [] on every node');
ok(chart.nodes.every((n) => n.occupants.length <= 1 && n.vacancies === 1 - n.occupants.length && n.overFilled === false),
  'occupants has 0 or 1 entries, vacancies is the other one, nothing is over-filled',
  chart.nodes.filter((n) => n.occupants.length > 1).map((n) => n.positionCode).join(' '));
ok(chart.nodes.every((n) => n.defaultShift && n.defaultShift.id && n.defaultShift.code && n.defaultShift.name), 'every node has its shift { id, code, name }');
ok(chart.nodes.every((n) => n.shiftPattern === n.defaultShift?.code && n.shiftPattern !== 'DN'), 'shiftPattern is the shift\'s own code, never DN');
ok(chart.nodes.every((n) => Number.isInteger(n.cardId) && nodeById.has(n.cardId)), 'every node has a cardId that is a position in the payload');
ok(list.items.every((p) => p.sanctionedHeadcount === 1 && p.seats === 1 && 'occupant' in p && 'shift' in p
  && (p.occupant === null) === (p.filledCount === 0) && p.shiftCode === (p.shift?.code ?? null)),
'Positions list rows: one seat, `shift`, the single `occupant`, and the old flat fields still there');
const listed = list.items.find((p) => p.occupant);
if (listed) ok(typeof listed.occupant.employeeId === 'number' && listed.occupant.name && 'employeeCode' in listed.occupant, 'occupant is { employeeId, name, employeeCode }');

const primary = new Map();
for (const e of chart.edges) if (e.typeCode === 'PRIMARY_MANAGER' && !primary.has(e.fromPositionId)) primary.set(e.fromPositionId, e.toPositionId);
const cards = new Map();
for (const n of chart.nodes) cards.set(n.cardId, [...(cards.get(n.cardId) ?? []), n]);
const managerCard = (n) => (primary.has(n.id) && nodeById.has(primary.get(n.id)) ? nodeById.get(primary.get(n.id)).cardId : 0);
ok([...cards].every(([cardId, members]) => cardId === Math.min(...members.map((m) => m.id))), 'cardId is the lowest position id in the card');
ok([...cards.values()].every((m) => new Set(m.map((x) => `${x.roleId}|${x.departmentId}`)).size === 1), 'a card is one role in one department');
ok([...cards.values()].every((m) => new Set(m.map(managerCard)).size === 1), 'the managers of a card\'s positions sit in ONE card (or it has none)');
const keyed = new Map();
for (const n of chart.nodes) { const k = `${n.roleId}|${n.departmentId}|${managerCard(n)}`; keyed.set(k, new Set([...(keyed.get(k) ?? []), n.cardId])); }
ok([...keyed.values()].every((s) => s.size === 1), 'same role + department + manager card is never split across two cards');
ok([...cards.values()].every((m) => new Set(m.map((x) => x.displayTitle)).size === 1), 'sibling chairs of a card have the SAME displayTitle');
const titleCards = new Map();
for (const [cardId, m] of cards) titleCards.set(m[0].displayTitle, [...(titleCards.get(m[0].displayTitle) ?? []), cardId]);
ok([...titleCards.values()].every((ids) => ids.length === 1), 'two different cards never share a displayTitle',
  [...titleCards].filter(([, ids]) => ids.length > 1).map(([t]) => t).slice(0, 3).join(' | '));

if (slug === 'karni') {
  const storesHelpers = chart.nodes.filter((n) => n.title === 'Helper 1' && n.departmentName === 'Stores');
  ok(storesHelpers.length === 3 && new Set(storesHelpers.map((n) => n.cardId)).size === 3
    && new Set(storesHelpers.map((n) => primary.get(n.id))).size === 3,
  '"Helper 1" in Stores: three positions under three managers are THREE cards',
  storesHelpers.map((n) => `${n.positionCode}→${nodeById.get(primary.get(n.id))?.positionCode}:${n.cardId}`).join(' '));
  const p124 = chart.nodes.filter((n) => /^P124-\d+$/.test(n.positionCode ?? ''));
  const p124Managers = [...new Set(p124.map((n) => primary.get(n.id)))].map((id) => nodeById.get(id));
  ok(p124.length === 7 && new Set(p124.map((n) => n.cardId)).size === 1, 'P124-1 … P124-7 are ONE card', `${p124.length} positions, cards ${[...new Set(p124.map((n) => n.cardId))].join(',')}`);
  ok(p124Managers.length === 2 && p124Managers.every((m) => /^P024-[12]$/.test(m.positionCode)) && new Set(p124Managers.map((m) => m.cardId)).size === 1,
    '…because their two managers (P024-1, P024-2) are one card', p124Managers.map((m) => `${m.positionCode}:${m.cardId}`).join(' '));
  const one = p124[0];
  const card = await getPositionCard(pool, COMPANY, one.id, {});
  const wide = await getPositionCard(pool, COMPANY, p124Managers[0].id, { scope: 'card' });
  const narrow = await getPositionCard(pool, COMPANY, p124Managers[0].id, {});
  ok(card.cardId === one.cardId && card.shift?.id === one.defaultShift.id && card.shift.code && card.shift.name, 'position card: cardId and shift { id, code, name }');
  ok(card.siblings.length === 6 && card.siblings.every((s) => s.positionId !== one.id && /^P124-/.test(s.positionCode) && s.shift?.code
    && (s.occupant === null || (typeof s.occupant.employeeId === 'number' && s.occupant.name))),
  'position card: siblings are the other six positions of the card, each with its shift and occupant|null');
  ok(card.siblings.filter((s) => s.occupant).length === p124.filter((n) => n.id !== one.id && n.occupants.length).length, 'siblings\' occupants match the chart');
  ok(card.occupants.length <= 1 && card.vacancies === 1 - card.occupants.length && card.sanctionedHeadcount === 1 && card.requirements.length === 0, 'position card: one chair');
  ok(narrow.directReports.every((r) => r.toPositionId === p124Managers[0].id) && narrow.directReportsScope === 'position', 'directReports (default) = lines to THIS position');
  const cardIds = new Set(chart.nodes.filter((n) => n.cardId === p124Managers[0].cardId).map((n) => n.id));
  const expectWide = chart.edges.filter((e) => cardIds.has(e.toPositionId)).length;
  ok(wide.directReports.length === expectWide && wide.directReports.length > narrow.directReports.length && wide.directReportsScope === 'card'
    && wide.directReports.every((r) => cardIds.has(r.toPositionId)), 'directReports with scope=card = lines to ANY position of the card',
  `${wide.directReports.length} (expected ${expectWide}; this position alone ${narrow.directReports.length})`);
} else skip('the Stores "Helper 1" and P124 cases', `they are local Karni's data and this is ${slug}`);

// The rule itself, on a made-up graph: two tops of one role, a loop that no root reaches.
{
  const P = (id, roleId, departmentId) => ({ id, roleId, departmentId });
  const made = computeCards(
    [P(1, 1, 1), P(2, 1, 1), P(3, 2, 1), P(4, 2, 1), P(5, 2, 1), P(6, 2, 2), P(7, 3, 1), P(8, 3, 1), P(9, 9, 9), P(10, 9, 9)],
    new Map([[3, 1], [4, 2], [5, 99], [6, 1], [7, 3], [8, 4], [9, 10], [10, 9]]),
  );
  ok(made.get(1) === 1 && made.get(2) === 1, 'rule: two tops of one role and department are one card');
  ok(made.get(3) === 3 && made.get(4) === 3, 'rule: reports of two chairs of one card are one card');
  ok(made.get(5) === 5, 'rule: a manager that is not drawn counts as no manager (a different card from those with one)');
  ok(made.get(6) === 6, 'rule: another department is another card');
  ok(made.get(7) === 7 && made.get(8) === 7, 'rule: the grouping carries down a level');
  ok(made.get(9) === 9 && made.get(10) === 10, 'rule: a reporting loop does not hang; each position stands alone');
}
const hits = await searchOrgChart(pool, COMPANY, { q: 'a' });
ok(hits.every((h) => Number.isInteger(h.cardId)), 'search hits carry cardId');
ok(positionsRouter.stack.some((l) => l.route?.path === '/positions/:id/add-sibling' && l.route.methods.post), 'POST /positions/:id/add-sibling is mounted');

/* ══ 9 (read-only half). the retired importers ════════════════════════════ */
section('[9] The chart importers refuse a one-chair tenant');
const guardState = await oneChairState(pool, COMPANY);
if (guardState.isOneChair) {
  const refusal = await oneChairRefusal(pool, COMPANY, company.name, 'The org chart import', ['node', 'x']);
  ok(typeof refusal === 'string' && refusal.includes('one-chair model') && refusal.includes('retired (2026-10-10)') && refusal.includes(ONE_CHAIR_OVERRIDE),
    'refused in a plain sentence that names the override');
  const quiet = console.log; console.log = () => {};
  const overridden = await oneChairRefusal(pool, COMPANY, company.name, 'The org chart import', ['node', 'x', ONE_CHAIR_OVERRIDE]);
  console.log = quiet;
  ok(overridden === null, 'the override flag lets it through');
} else skip('importer refusal', `${slug} is not on the one-chair model (${JSON.stringify(guardState)})`);

/* ══ 3–8. writes — one transaction, our own fixtures, rolled back ═════════ */
const conn = await pool.getConnection();
let crashed = null;
try {
  await conn.beginTransaction();
  const db = conn;
  const [[admin]] = await db.query("SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE u.company_id = ? AND LOWER(r.name) = 'admin' ORDER BY u.id LIMIT 1", [COMPANY]);
  const c = { companyId: COMPANY, userId: admin?.id ?? null };
  const [shifts] = await db.query('SELECT id, code, name FROM hrms_shifts WHERE company_id = ? AND deleted_at IS NULL ORDER BY id', [COMPANY]);
  const up = (s) => String(s.code ?? '').toUpperCase();
  const G = shifts.find((s) => up(s).startsWith('G')) ?? shifts[0];
  const D = shifts.find((s) => up(s).startsWith('D'));
  const N = shifts.find((s) => up(s).startsWith('N'));
  const [[primaryType]] = await db.query("SELECT id FROM hrms_reporting_relationship_types WHERE company_id = ? AND code = 'PRIMARY_MANAGER' AND deleted_at IS NULL", [COMPANY]);
  const [[dottedType]] = await db.query("SELECT id FROM hrms_reporting_relationship_types WHERE company_id = ? AND code = 'DOTTED_LINE' AND deleted_at IS NULL", [COMPANY]);
  if (!G || !D || !N || !primaryType) throw new Error('This company needs General, Day and Night shifts and a PRIMARY_MANAGER type for the write sections.');

  const dept = await createDepartment(db, c, { name: `${TAG} Dept`, type: 'Test' });
  const role = async (name) => (await RC.createRole(db, c, { title: `${TAG} ${name}`, status: 'ACTIVE' })).id;
  const [roleTop, roleMgr, roleCrew, roleLeaf] = [await role('Head'), await role('Incharge'), await role('Operator'), await role('Helper')];
  const mkPos = async (code, roleId, title, shiftId, extra = {}) => (await POS.createPosition(db, c, {
    roleId, positionCode: `${TAG}-${code}`, positionTitle: `${TAG} ${title}`, departmentId: dept.id, status: 'ACTIVE', defaultShiftId: shiftId, ...extra,
  })).position;
  const reportTo = (fromId, toId, typeId = primaryType.id) => POS.addPositionReporting(db, c, fromId, { toPositionId: toId, relationshipTypeId: typeId, effectiveFrom: on });
  const row = async (id) => (await db.query('SELECT * FROM hrms_positions WHERE id = ?', [id]))[0][0];
  /** Live lines from a position: [{ to, type }] */
  const linesOf = async (id) => (await db.query(
    `SELECT rr.to_position_id AS \`to\`, t.code AS type FROM hrms_position_reporting_relationships rr
       JOIN hrms_reporting_relationship_types t ON t.id = rr.relationship_type_id
      WHERE rr.company_id = ? AND rr.from_position_id = ? AND rr.deleted_at IS NULL
        AND rr.effective_from <= ? AND (rr.effective_to IS NULL OR rr.effective_to >= ?) ORDER BY rr.id`, [COMPANY, id, on, on]))[0];
  const managerOf = async (id) => (await linesOf(id)).find((l) => l.type === 'PRIMARY_MANAGER')?.to ?? null;

  /* ── 3. create / update ─────────────────────────────────────────────── */
  section('[3] Position create / update: one seat, always a shift');
  const top = await mkPos('TOP', roleTop, 'Head', G.id, { sanctionedHeadcount: 7 });
  ok(top.sanctionedHeadcount === 1 && Number((await row(top.id)).sanctioned_headcount) === 1, 'create ignores sanctionedHeadcount: 7 and stores 1 (no 422)');
  const noShift = (await POS.createPosition(db, c, { roleId: roleTop, positionCode: `${TAG}-NS`, positionTitle: `${TAG} No shift given`, departmentId: dept.id, status: 'DRAFT' })).position;
  ok(noShift.defaultShiftId === G.id && noShift.shift?.code === G.code, 'create without defaultShiftId uses the General shift', `${noShift.shiftCode}`);
  const upd = await POS.updatePosition(db, c, noShift.id, { sanctionedHeadcount: 5, positionTitle: `${TAG} Renamed` });
  ok(upd.position.sanctionedHeadcount === 1 && Number((await row(noShift.id)).sanctioned_headcount) === 1 && upd.position.positionTitle === `${TAG} Renamed`,
    'update ignores sanctionedHeadcount: 5, stores 1, and still saves the other fields');
  const cleared = await caught(() => POS.updatePosition(db, c, noShift.id, { defaultShiftId: null }));
  ok(cleared?.status === 422 && (await row(noShift.id)).default_shift_id === G.id, 'a position\'s shift cannot be cleared', cleared?.message);
  await POS.deletePosition(db, c, noShift.id, {});

  /* ── 4. add-sibling ─────────────────────────────────────────────────── */
  section('[4] add-sibling: one more vacant chair in the same card');
  const mgr1 = await mkPos('MGR', roleMgr, 'Incharge', D.id);
  await reportTo(mgr1.id, top.id);
  const resp = await RC.createMasterItem(db, c, 'responsibilities', { name: `${TAG} Only here`, description: `${TAG} A line for one position only` });
  await POS.addPositionOverride(db, c, mgr1.id, { contentType: 'RESPONSIBILITY', action: 'ADD', responsibilityDefinitionId: resp.id });
  const auditBefore = (await db.query("SELECT COUNT(*) AS n FROM hrms_audit_log WHERE company_id = ? AND entity_type = 'hrms_positions' AND action = 'CREATE'", [COMPANY]))[0][0].n;
  const mgr2 = (await POS.addSiblingPosition(db, c, mgr1.id, { shiftId: N.id })).position;
  const src = await row(mgr1.id);
  const sib = await row(mgr2.id);
  ok(mgr2.positionCode === `${TAG}-MGR-2` && (await row(mgr1.id)).position_code === `${TAG}-MGR`, 'code: source keeps its code, the new one is <code>-2', mgr2.positionCode);
  ok(sib.role_id === src.role_id && sib.position_title === src.position_title && sib.department_id === src.department_id
    && sib.location_id === src.location_id && sib.status === src.status && Number(sib.sanctioned_headcount) === 1,
  'same role, title, department, location and status; one seat');
  ok(mgr2.defaultShiftId === N.id && mgr2.shift?.code === N.code, 'shift = the one asked for');
  ok(mgr2.occupant === null && mgr2.vacancyCount === 1, 'it is vacant');
  ok(mgr2.id && mgr2.positionTitle === mgr1.positionTitle && 'sanctionedHeadcount' in mgr2, 'returns { asOf, position } like create');
  ok(mgr2.overrideCount === 0 && (await row(mgr1.id)) && (await POS.listPositionOverrides(db, COMPANY, mgr1.id)).total === 1, 'no position-level content is copied (the source keeps its own)');
  ok((await managerOf(mgr2.id)) === top.id, 'reporting line: the manager card has no chair on that shift, so it points where the source points');
  const auditRow = (await db.query("SELECT entity_id, actor_user_id, after_json FROM hrms_audit_log WHERE company_id = ? AND entity_type = 'hrms_positions' AND action = 'CREATE' ORDER BY id DESC LIMIT 1", [COMPANY]))[0][0];
  const auditAfter = (await db.query("SELECT COUNT(*) AS n FROM hrms_audit_log WHERE company_id = ? AND entity_type = 'hrms_positions' AND action = 'CREATE'", [COMPANY]))[0][0].n;
  ok(auditAfter === auditBefore + 1 && auditRow.entity_id === mgr2.id, 'it is audited (CREATE on hrms_positions, in the same transaction)');

  // The crew. The FIRST chair is on nights on purpose: later, "same shift first" must beat "lowest id".
  const w1 = await mkPos('W', roleCrew, 'Operator', N.id);
  await reportTo(w1.id, mgr2.id);
  if (dottedType) await reportTo(w1.id, top.id, dottedType.id);
  const w2 = (await POS.addSiblingPosition(db, c, w1.id, { shiftId: D.id })).position;
  const w3 = (await POS.addSiblingPosition(db, c, w2.id, {})).position;
  ok(w2.positionCode === `${TAG}-W-2` && w3.positionCode === `${TAG}-W-3`, 'codes: a sibling of <code>-2 strips the tail and takes the lowest free number (-3)', `${w2.positionCode} ${w3.positionCode}`);
  ok(w3.defaultShiftId === D.id, 'no shiftId = the source\'s shift');
  ok((await managerOf(w2.id)) === mgr1.id, 'same-shift rule: a DAY chair added beside a night one reports to the manager card\'s DAY chair');
  ok((await managerOf(w3.id)) === mgr1.id && (await managerOf(w1.id)) === mgr2.id, 'the source\'s own line is untouched; a second day chair also lands under the day in-charge');
  if (dottedType) {
    ok((await linesOf(w2.id)).length === 2 && (await linesOf(w2.id)).some((l) => l.type === 'DOTTED_LINE' && l.to === top.id), 'every reporting line of the source is repeated, the dotted one too');
  } else skip('dotted line copied', 'this company has no DOTTED_LINE type');
  await POS.deletePosition(db, c, w3.id, {});
  const w3b = (await POS.addSiblingPosition(db, c, w1.id, {})).position;
  ok(w3b.positionCode === `${TAG}-W-3`, 'a deleted position frees its code: the next sibling is -3 again', w3b.positionCode);
  await POS.updatePosition(db, c, w3b.id, { defaultShiftId: D.id });
  const closedSrc = await mkPos('CL', roleLeaf, 'Closed one', G.id, { status: 'CLOSED' });
  const closedErr = await caught(() => POS.addSiblingPosition(db, c, closedSrc.id, {}));
  ok(closedErr?.status === 409 && closedErr.code === 'POSITION_CLOSED', 'a closed position cannot be the source', closedErr?.message);
  await POS.deletePosition(db, c, closedSrc.id, {});
  const badShift = await caught(() => POS.addSiblingPosition(db, c, w1.id, { shiftId: 999999999 }));
  ok(badShift?.status === 422, 'a shift that does not exist is a 422');

  // Two helpers under two different chairs of the crew card.
  const leaf1 = await mkPos('L1', roleLeaf, 'Helper', D.id);
  await reportTo(leaf1.id, w3b.id);
  const leaf2 = await mkPos('L2', roleLeaf, 'Helper', G.id);
  await reportTo(leaf2.id, w2.id);

  const g1 = await buildOrgChart(db, COMPANY, {});
  const n1 = new Map(g1.nodes.map((n) => [n.id, n]));
  ok(n1.get(mgr1.id).cardId === mgr1.id && n1.get(mgr2.id).cardId === mgr1.id, 'chart: the two in-charge chairs are one card');
  ok([w1, w2, w3b].every((p) => n1.get(p.id).cardId === w1.id), 'chart: the three operator chairs are one card, although they report to two different chairs');
  ok(n1.get(leaf1.id).cardId === leaf1.id && n1.get(leaf2.id).cardId === leaf1.id, 'chart: two helpers under two chairs of ONE card are one card');
  ok(n1.get(w1.id).displayTitle === n1.get(w2.id).displayTitle && n1.get(w2.id).displayTitle === n1.get(w3b.id).displayTitle, 'chart: sibling chairs share a displayTitle');
  ok(g1.counts.positions === counts.positions + 8 && g1.counts.vacant === counts.vacant + 8 && g1.counts.filled === counts.filled
    && g1.counts.cards === counts.cards + 4, 'chart counts moved by exactly the fixture: +8 positions, all vacant, +4 cards',
  `${g1.counts.positions} / ${g1.counts.filled} / ${g1.counts.vacant}, cards ${g1.counts.cards}`);
  const sibCard = await getPositionCard(db, COMPANY, w2.id, { scope: 'card' });
  ok(sibCard.cardId === w1.id && sibCard.siblings.map((s) => s.positionId).sort().join() === [w1.id, w3b.id].sort().join()
    && sibCard.directReports.map((r) => r.positionId).sort().join() === [leaf1.id, leaf2.id].sort().join(),
  'position card: siblings are the other two chairs; scope=card lists the helpers of both chairs');
  ok((await getPositionCard(db, COMPANY, w2.id, {})).directReports.map((r) => r.positionId).join() === String(leaf2.id), 'position card: without scope, only this chair\'s own helper');

  /* ── 5. one person per position ─────────────────────────────────────── */
  section('[5] One person per position: POSITION_FILLED');
  const [[freeUser]] = await db.query(
    `SELECT u.id FROM users u LEFT JOIN hrms_employees e ON e.company_id = u.company_id AND e.user_id = u.id AND e.deleted_at IS NULL
      WHERE u.company_id = ? AND e.id IS NULL ORDER BY u.id LIMIT 1`, [COMPANY]);
  const mkEmp = async (n) => (await db.query(
    'INSERT INTO hrms_employees (company_id, employee_code, full_name, date_of_joining, created_by) VALUES (?, ?, ?, ?, ?)',
    [COMPANY, `${TAG}-E${n}`, `${TAG} Person ${n}`, on, c.userId]))[0].insertId;
  const [e1, e2, e3, e4, e5] = [await mkEmp(1), await mkEmp(2), await mkEmp(3), await mkEmp(4), await mkEmp(5)];
  const seat = (employeeId, position, roleId, extra = {}) => ASG.createAssignment(db, c, { employeeId, roleId, positionId: position.id, effectiveFrom: on, ...extra });
  const a1 = (await seat(e1, mgr1, roleMgr)).assignment;
  ok(a1.defaultShiftId === D.id, 'an assignment created on a position takes the position\'s shift', `${a1.shiftCode}`);
  const filled = await caught(() => seat(e2, mgr1, roleMgr));
  ok(filled?.status === 409 && filled.code === 'POSITION_FILLED', 'a second person on a filled position: 409 POSITION_FILLED', `${filled?.status} ${filled?.code}`);
  ok(String(filled?.message ?? '').includes(`${TAG} Person 1`) && /\.$/.test(filled?.message ?? '') && filled?.occupant?.employeeId === e1,
    'the message is a sentence naming the person already there', filled?.message);
  if (VERBOSE) console.log(`        "${filled?.message}"`);
  const stillOne = (await db.query("SELECT COUNT(*) AS n FROM hrms_work_assignments WHERE position_id = ? AND deleted_at IS NULL AND status <> 'ENDED'", [mgr1.id]))[0][0].n;
  ok(stillOne === 1, 'nothing was written by the refused request');
  const a2 = (await seat(e2, mgr2, roleMgr, { defaultShiftId: D.id })).assignment;
  ok(a2.defaultShiftId === D.id, 'an explicit shift on the assignment is kept (the position\'s shift is only the default)');
  await ASG.updateAssignment(db, c, a2.id, { defaultShiftId: N.id });
  const a3 = (await seat(e3, w1, roleCrew)).assignment;
  const a4 = (await seat(e4, w2, roleCrew)).assignment;
  ok(a3.defaultShiftId === N.id && a4.defaultShiftId === D.id, 'night crew and day crew took their positions\' shifts');
  // edit: a PLANNED assignment may change position — but not onto a filled one
  const planned = (await seat(e5, w3b, roleCrew, { status: 'PLANNED' })).assignment;
  const moved = await caught(() => ASG.updateAssignment(db, c, planned.id, { positionId: w2.id }));
  ok(moved?.status === 409 && moved.code === 'POSITION_FILLED' && moved.message.includes(`${TAG} Person 4`), 'edit: moving a planned assignment onto a filled position is refused, by name', moved?.message);
  const renamed = await caught(() => ASG.updateAssignment(db, c, a4.id, { assignmentTitle: `${TAG} Day operator` }));
  ok(renamed === null, 'edit: changing something else on the person already in the position is not refused');
  // reopen: an ended assignment cannot come back onto a chair someone took since
  await ASG.endAssignment(db, c, planned.id, {});
  const a5 = (await seat(e5, leaf1, roleLeaf)).assignment;
  await ASG.endAssignment(db, c, a5.id, {});
  const successor = (await seat(e2, leaf1, roleLeaf, { isPrimary: false })).assignment;
  const reopened = await caught(() => ASG.setAssignmentStatus(db, c, a5.id, 'ACTIVE'));
  ok(reopened?.status === 409 && reopened.code === 'POSITION_FILLED', 'reopen: an ended assignment cannot return to a position filled since', `${reopened?.status} ${reopened?.code}`);
  await ASG.endAssignment(db, c, successor.id, {});
  const back = await caught(() => ASG.setAssignmentStatus(db, c, a5.id, 'ACTIVE'));
  ok(back === null, 'reopen: once the position is free again it works');
  await ASG.endAssignment(db, c, a5.id, {});
  const g2 = await buildOrgChart(db, COMPANY, {});
  const n2 = new Map(g2.nodes.map((n) => [n.id, n]));
  ok(g2.nodes.every((n) => n.occupants.length <= 1 && !n.overFilled), 'chart: still nobody shares a position');
  ok(n2.get(mgr1.id).occupants[0]?.employeeId === e1 && n2.get(mgr1.id).vacancies === 0 && n2.get(w3b.id).vacancies === 1, 'chart: filled and vacant chairs read correctly');

  /* ── 6. shift change ────────────────────────────────────────────────── */
  section('[6] Changing a position\'s shift moves the person in it');
  const shiftOf = async (assignmentId) => (await db.query('SELECT default_shift_id FROM hrms_work_assignments WHERE id = ?', [assignmentId]))[0][0].default_shift_id;
  const movedShift = await POS.updatePosition(db, c, w1.id, { defaultShiftId: G.id });
  ok(movedShift.position.defaultShiftId === G.id && (await shiftOf(a3.id)) === G.id && movedShift.occupantsMovedToShift === 1,
    'the occupant\'s assignment follows the position to the new shift, same transaction');
  ok((await shiftOf(planned.id)) === D.id, 'an ENDED assignment on another position keeps the shift it had');
  ok((await shiftOf(a1.id)) === D.id, 'nobody on another position is touched');
  const g3 = await buildOrgChart(db, COMPANY, {});
  ok(g3.nodes.find((n) => n.id === w1.id).shiftPattern === G.code && g3.nodes.find((n) => n.id === w1.id).occupants[0].shiftCode === G.code, 'chart: position and person both show the new shift');
  await POS.updatePosition(db, c, w1.id, { defaultShiftId: N.id });
  ok((await shiftOf(a3.id)) === N.id, '…and back');
  const sameShift = await POS.updatePosition(db, c, w1.id, { positionTitle: (await row(w1.id)).position_title });
  ok(sameShift.occupantsMovedToShift === 0, 'an update that does not change the shift moves nobody');

  /* ── 7. the employee's own slice ────────────────────────────────────── */
  section('[7] The employee\'s chart: a team reports to the card');
  if (!freeUser) skip('employee slice on the fixture', 'this company has no login that is not already linked to an employee');
  else {
    const loginAs = async (employeeId) => {
      await db.query('UPDATE hrms_employees SET user_id = NULL WHERE company_id = ? AND user_id = ?', [COMPANY, freeUser.id]);
      await db.query('UPDATE hrms_employees SET user_id = ? WHERE id = ?', [freeUser.id, employeeId]);
      return { companyId: COMPANY, userId: freeUser.id };
    };
    // E1 is the DAY in-charge (mgr1). The night operator (w1) reports to the NIGHT in-charge chair (mgr2).
    const s1 = await myOrgChart(db, await loginAs(e1), {});
    const rel = new Map(s1.nodes.map((n) => [n.id, n.relation]));
    ok(s1.linked && rel.get(mgr1.id) === 'SELF', 'the day in-charge finds their own position');
    ok(rel.get(w1.id) === 'REPORT' && rel.get(w2.id) === 'REPORT' && rel.get(w3b.id) === 'REPORT', 'the DAY in-charge sees the NIGHT operator, whose line names the other chair of the card');
    ok(rel.get(leaf1.id) === 'REPORT' && rel.get(leaf2.id) === 'REPORT', '…and everyone below the crew');
    ok(rel.get(mgr2.id) === 'SAME_CARD', 'the other chair of their own card travels too (SAME_CARD), so no line points at a missing position');
    ok(rel.get(top.id) === 'MANAGER', 'the chain up follows their own position\'s manager');
    ok(s1.nodes.every((n) => Number.isInteger(n.cardId)) && s1.nodes.find((n) => n.id === mgr2.id).cardId === mgr1.id, 'every slice node carries cardId');
    const ids = new Set(s1.nodes.map((n) => n.id));
    ok(s1.edges.every((e) => ids.has(e.fromPositionId) && ids.has(e.toPositionId)), 'every edge has both ends in the slice');
    ok(s1.edges.some((e) => e.fromPositionId === w1.id && e.toPositionId === mgr2.id), 'the night operator\'s line to the night chair is in the slice');
    ok(s1.nodes.length === 8 && s1.counts.sameCard === 1 && s1.counts.reports === 5 && s1.counts.managers === 1, 'nothing beyond the fixture branch is in it',
      `${s1.nodes.length} nodes ${JSON.stringify(s1.counts)}`);
    const NODE_KEYS = 'cardId,contexts,defaultShift,departmentCode,departmentId,departmentIsRoot,departmentName,departmentRank,displayTitle,effectiveSanctioned,id,locationName,occupants,positionCode,relation,requirements,roleTitle,sanctionedHeadcount,shiftPattern,title';
    ok(s1.nodes.every((n) => Object.keys(n).sort().join(',') === NODE_KEYS), 'the whitelist is the old one plus cardId', Object.keys(s1.nodes[0]).sort().join(','));
    ok(s1.nodes.every((n) => n.occupants.every((o) => Object.keys(o).sort().join(',') === 'isMe,name,sameAs,shiftCode')), 'occupants still carry no ids');
    const place = await myPlace(db, { companyId: COMPANY, userId: freeUser.id }, {});
    const reportNames = place.reports.map((r) => r.person.name);
    ok(reportNames.includes(`${TAG} Person 3`) && reportNames.includes(`${TAG} Person 4`), 'My place: the day in-charge\'s reports include the night operator', reportNames.join(', '));
    ok(!reportNames.includes(`${TAG} Person 2`), 'My place: the other in-charge is not their report');
    // The night operator: chain up through the night chair; their card's helpers below.
    const s3 = await myOrgChart(db, await loginAs(e3), {});
    const rel3 = new Map(s3.nodes.map((n) => [n.id, n.relation]));
    ok(rel3.get(w1.id) === 'SELF' && rel3.get(mgr2.id) === 'MANAGER' && rel3.get(top.id) === 'MANAGER' && !rel3.has(mgr1.id), 'an operator\'s chain up is their own chair\'s manager only');
    ok(rel3.get(w2.id) === 'SAME_CARD' && rel3.get(leaf1.id) === 'REPORT' && rel3.get(leaf2.id) === 'REPORT', 'an operator sees the helpers of every chair of their card');
    const place3 = await myPlace(db, { companyId: COMPANY, userId: freeUser.id }, {});
    ok(place3.peers.some((p) => p.person.name === `${TAG} Person 4`), 'My place: the day operator is a peer of the night operator (same manager card)', place3.peers.map((p) => p.person.name).join(', '));
  }
  // The same rule on the tenant's own data, read only.
  {
    const real = await buildOrgChart(db, COMPANY, {});
    const byId = new Map(real.nodes.map((n) => [n.id, n]));
    const pm = real.edges.filter((e) => e.typeCode === 'PRIMARY_MANAGER');
    const candidate = pm.map((e) => ({ crew: byId.get(e.fromPositionId), chair: byId.get(e.toPositionId) }))
      .find(({ crew, chair }) => crew && chair && !String(crew.positionCode ?? '').startsWith(TAG)
        && real.nodes.some((m) => m.cardId === chair.cardId && m.id !== chair.id && m.occupants.length && m.defaultShift?.id !== chair.defaultShift?.id));
    if (!candidate) skip('slice on tenant data', 'no filled chair has a sibling chair on another shift with a team');
    else {
      const other = real.nodes.find((m) => m.cardId === candidate.chair.cardId && m.id !== candidate.chair.id && m.occupants.length && m.defaultShift?.id !== candidate.chair.defaultShift?.id);
      const [[emp]] = await db.query('SELECT user_id FROM hrms_employees WHERE id = ?', [other.occupants[0].employeeId]);
      if (!emp?.user_id) skip('slice on tenant data', 'that person has no login');
      else {
        const s = await myOrgChart(db, { companyId: COMPANY, userId: emp.user_id }, {});
        ok(s.nodes.some((n) => n.id === candidate.crew.id && n.relation === 'REPORT'),
          `tenant data: ${other.positionCode} (${other.defaultShift.name}) sees ${candidate.crew.positionCode}, which reports to ${candidate.chair.positionCode} (${candidate.chair.defaultShift.name})`);
      }
    }
  }

  // Hand-over in one request, last in this section so the slices above saw the day operator in place:
  // replacesId ends the old assignment, then the new person is seated from tomorrow.
  const tomorrow = new Date(`${on}T00:00:00`); tomorrow.setDate(tomorrow.getDate() + 1);
  let successorOnW2 = null;
  const handover = await caught(async () => {
    successorOnW2 = (await ASG.createAssignment(db, c, { employeeId: e5, roleId: roleCrew, positionId: w2.id, effectiveFrom: POS.dateText(tomorrow), replacesId: a4.id })).assignment;
  });
  ok(handover === null && successorOnW2?.status === 'ACTIVE', 'hand-over with replacesId passes: the old assignment is ended first, then the successor is seated', handover?.message);
  const early = await caught(() => seat(e4, w2, roleCrew, { effectiveFrom: POS.dateText(tomorrow), isPrimary: false }));
  ok(early?.code === 'POSITION_FILLED' && early.message.includes(`${TAG} Person 5`), 'a position promised to someone from tomorrow is refused for those days too', early?.message);

  /* ── 8. close / delete ──────────────────────────────────────────────── */
  section('[8] Close / delete: one chair of a card vs the card\'s last chair');
  // crew card: w1 (Night, lowest id), w2 (Day), w3b (Day). leaf1 (Day) → w3b. leaf2 (General) → w2.
  const impact1 = await POS.getDeleteImpact(db, COMPANY, w3b.id);
  ok(impact1.movesReportsTo === 'CARD' && impact1.manager?.id === w2.id && impact1.card.otherPositions === 2,
    'impact: a chair with siblings keeps its team in the card — and "same shift first" beats "lowest id" (day helper → the other DAY chair)',
    `${impact1.movesReportsTo} → ${impact1.manager?.positionCode}`);
  ok(impact1.directReports.length === 1 && impact1.directReports[0].movesToPositionId === w2.id && impact1.moveTargets.length === 1 && impact1.moveTargets[0].reports === 1,
    'impact: each direct report says where it would go');
  ok(impact1.outcomes.close.allowed && impact1.outcomes.deleteOnly.allowed && impact1.outcomes.deleteOnly.movesReports === 1, 'impact: close and delete-alone are both allowed');
  const noMode = await caught(() => POS.deletePosition(db, c, w3b.id, {}));
  ok(noMode?.code === 'HAS_TEAM' && noMode.message.includes('in the same card') && noMode.message.includes(w2.positionCode), 'delete without a mode still asks, and says where the team would go', noMode?.message);
  const stale = await caught(() => POS.deletePosition(db, c, w3b.id, { mode: 'THIS_ONLY', expect: 4 }));
  ok(stale?.code === 'IMPACT_CHANGED', 'a stale `expect` is still caught');
  const del1 = await POS.deletePosition(db, c, w3b.id, { mode: 'THIS_ONLY', expect: 1 });
  ok(del1.movedWithinCard === true && del1.movedTo?.id === w2.id && del1.movedReports[0]?.id === leaf1.id && del1.movedReports[0].movedToPositionId === w2.id,
    'delete one chair of three: its helper moves to the remaining chair on its shift, not up');
  ok((await managerOf(leaf1.id)) === w2.id && (await managerOf(leaf2.id)) === w2.id, 'the helper\'s line now names the sibling chair');
  const g4 = await buildOrgChart(db, COMPANY, {});
  const n4 = new Map(g4.nodes.map((n) => [n.id, n]));
  ok(!n4.has(w3b.id) && n4.get(leaf1.id).cardId === leaf1.id && n4.get(leaf2.id).cardId === leaf1.id && g4.counts.roots === chart.counts.roots + 1,
    'chart: the chair is gone, the helpers are still one card, and no new top appeared (only the fixture\'s own)', `roots ${g4.counts.roots}`);

  // close w2 (Day, occupied from tomorrow by the hand-over): helpers on Day and General → only w1 (Night) remains
  const impact2 = await POS.getDeleteImpact(db, COMPANY, w2.id);
  ok(impact2.movesReportsTo === 'CARD' && impact2.manager?.id === w1.id && impact2.outcomes.deleteOnly.code === 'IN_USE',
    'impact: no chair on their shift remains, so they go to the first remaining chair; delete is refused while someone is assigned');
  const refusedDirect = await caught(() => POS.refuseCloseWithTeam(db, COMPANY, w2.id, 'CLOSED'));
  ok(refusedDirect?.code === 'HAS_TEAM' && refusedDirect.message.includes('same card'), 'setting CLOSED directly on a chair with a team is still refused and points at /close');
  const close2 = await POS.closePosition(db, c, w2.id, { expect: 2 });
  ok(close2.position.status === 'CLOSED' && close2.movedWithinCard === true && close2.movedTo?.id === w1.id && close2.movedReports.length === 2
    && close2.movedToPositions.length === 1 && close2.movedToPositions[0].reports === 2, 'close one chair of two: both helpers move to the last remaining chair of the card');
  ok((await managerOf(leaf1.id)) === w1.id && (await managerOf(leaf2.id)) === w1.id, 'their lines name the remaining chair');
  const [oldLines] = await db.query(
    'SELECT COUNT(*) AS n FROM hrms_position_reporting_relationships WHERE company_id = ? AND to_position_id = ? AND deleted_at IS NULL AND (effective_to IS NULL OR effective_to >= ?)',
    [COMPANY, w2.id, on]);
  ok(oldLines[0].n === 0, 'no live line still points at the closed chair');

  // w1 is now the card's LAST chair: the team goes UP, to its own manager (the night in-charge chair).
  const impact3 = await POS.getDeleteImpact(db, COMPANY, w1.id);
  ok(impact3.movesReportsTo === 'UP' && impact3.manager?.id === mgr2.id && impact3.card.otherPositions === 0, 'impact: the last chair of a card sends its team UP to its manager',
    `${impact3.movesReportsTo} → ${impact3.manager?.positionCode}`);
  const lastNoMode = await caught(() => POS.deletePosition(db, c, w1.id, {}));
  ok(lastNoMode?.code === 'IN_USE', 'the last chair is occupied, so delete says IN_USE first', lastNoMode?.code);
  const close3 = await POS.closePosition(db, c, w1.id, { expect: 2 });
  ok(close3.movedWithinCard === false && close3.movedTo?.id === mgr2.id && close3.movedReports.every((r) => r.movedToPositionId === mgr2.id), 'close the last chair: the helpers move up a level');
  ok((await managerOf(leaf1.id)) === mgr2.id && (await managerOf(leaf2.id)) === mgr2.id, 'their lines name the manager\'s chair');

  // The in-charge card: mgr1 (Day, E1) and mgr2 (Night, E2). The helpers now report to mgr2.
  const impact4 = await POS.getDeleteImpact(db, COMPANY, mgr2.id);
  ok(impact4.movesReportsTo === 'CARD' && impact4.manager?.id === mgr1.id, 'impact: the night in-charge chair would hand its reports to the day chair, not to the head');
  await ASG.endAssignment(db, c, a2.id, {});
  // Three direct reports: the two helpers and the CLOSED operator chair, which still has its line (a closed position keeps its history).
  const del2 = await POS.deletePosition(db, c, mgr2.id, { mode: 'THIS_ONLY', expect: 3 });
  ok(del2.movedWithinCard === true && del2.movedTo?.id === mgr1.id && (await managerOf(leaf1.id)) === mgr1.id && (await managerOf(w1.id)) === mgr1.id,
    'delete one in-charge chair of two: its reports (a closed chair among them) go to the other');
  const impact5 = await POS.getDeleteImpact(db, COMPANY, mgr1.id);
  ok(impact5.movesReportsTo === 'UP' && impact5.manager?.id === top.id, 'impact: now the last in-charge chair, so its reports would go up to the head');
  await ASG.endAssignment(db, c, a1.id, {});
  const del3 = await POS.deletePosition(db, c, mgr1.id, { mode: 'THIS_ONLY', expect: 4 });
  ok(del3.movedWithinCard === false && del3.movedTo?.id === top.id && (await managerOf(leaf1.id)) === top.id && (await managerOf(leaf2.id)) === top.id, 'delete the last chair: its reports move up');
  // A top with a team and nowhere to send it is still refused; with-team still deletes the branch.
  const impact6 = await POS.getDeleteImpact(db, COMPANY, top.id);
  ok(impact6.movesReportsTo === 'UP' && impact6.manager === null && impact6.outcomes.close.code === 'ROOT_HAS_TEAM' && impact6.outcomes.deleteOnly.code === 'ROOT_HAS_TEAM',
    'a top with a team and no other chair in its card has nowhere to send them: refused, as before');
  const top2 = (await POS.addSiblingPosition(db, c, top.id, {})).position;
  const impact7 = await POS.getDeleteImpact(db, COMPANY, top.id);
  ok(impact7.movesReportsTo === 'CARD' && impact7.manager?.id === top2.id && impact7.outcomes.close.allowed, '…but give the top a second chair and its team can stay with the card');
  const blocked = await caught(() => POS.deletePosition(db, c, top.id, { mode: 'WITH_TEAM', expect: 5 }));
  ok(blocked?.code === 'TEAM_IN_USE', 'delete with its team is still refused while anyone under it is assigned', blocked?.code);
  await ASG.endAssignment(db, c, a3.id, {});
  await ASG.deleteAssignment(db, c, successorOnW2.id);
  const delTeam = await POS.deletePosition(db, c, top.id, { mode: 'WITH_TEAM', expect: 5 });
  ok(delTeam.deletedCount === 5 && delTeam.movedReports.length === 0, 'delete with its team still deletes the chair and everyone under it');
  await POS.deletePosition(db, c, top2.id, {});

  const g5 = await buildOrgChart(db, COMPANY, {});
  ok(g5.counts.positions === counts.positions && g5.counts.filled === counts.filled && g5.counts.vacant === counts.vacant && g5.counts.cards === counts.cards,
    'with the fixture closed or deleted, the chart is back to the tenant\'s own numbers', `${g5.counts.positions} / ${g5.counts.filled} / ${g5.counts.vacant}`);

  /* ── 9 (write half). what makes a tenant NOT one-chair ──────────────── */
  section('[9] …and what the detection keys on');
  if (guardState.isOneChair) {
    const [ins] = await db.query('INSERT INTO hrms_positions (company_id, position_code, role_id, sanctioned_headcount, default_shift_id, status) VALUES (?, ?, ?, 1, NULL, ?)', [COMPANY, `${TAG}-OLD`, roleLeaf, 'ACTIVE']);
    ok((await oneChairState(db, COMPANY)).isOneChair === false, 'a position with no shift (the old day/night box) means the tenant is not on the one-chair model');
    await db.query('UPDATE hrms_positions SET default_shift_id = ?, sanctioned_headcount = 3 WHERE id = ?', [G.id, ins.insertId]);
    ok((await oneChairState(db, COMPANY)).isOneChair === false, 'so does a headcount other than 1');
    await db.query('UPDATE hrms_positions SET sanctioned_headcount = 1 WHERE id = ?', [ins.insertId]);
    ok((await oneChairState(db, COMPANY)).isOneChair === true, 'one seat and a shift on every position: one-chair');
    const [[emptyCompany]] = await db.query('SELECT c.id FROM companies c LEFT JOIN hrms_positions p ON p.company_id = c.id AND p.deleted_at IS NULL WHERE p.id IS NULL LIMIT 1');
    if (emptyCompany) ok((await oneChairState(db, emptyCompany.id)).isOneChair === false, 'a company with no positions is not refused (a first import into a new tenant)');
  }
} catch (err) {
  crashed = err;
} finally {
  try { await conn.rollback(); } catch { /* the original error matters */ }
  conn.release();
}
if (crashed) { failed.push(`the write sections threw: ${crashed.message}`); console.error(crashed); }

/* ══ nothing left behind ══════════════════════════════════════════════════ */
section('[end] rolled back');
const after = await rowCounts(pool);
ok(JSON.stringify(after) === JSON.stringify(baseline), 'every table is back to its starting row count, live and total',
  TABLES.filter((t) => after[t] !== baseline[t]).map((t) => `${t} ${baseline[t]} -> ${after[t]}`).join(' | '));
ok((await linkedUsers(pool)) === baselineLinked, 'no login was left pointing at a fixture employee');
const [[leftovers]] = await pool.query(
  `SELECT (SELECT COUNT(*) FROM hrms_positions WHERE company_id = ? AND position_code LIKE ?) +
          (SELECT COUNT(*) FROM hrms_employees WHERE company_id = ? AND employee_code LIKE ?) +
          (SELECT COUNT(*) FROM hrms_roles WHERE company_id = ? AND title LIKE ?) AS n`,
  [COMPANY, `${TAG}%`, COMPANY, `${TAG}%`, COMPANY, `${TAG}%`]);
ok(Number(leftovers.n) === 0, 'no row carrying this run\'s tag exists');
const final = await buildOrgChart(pool, COMPANY, {});
ok(final.counts.positions === counts.positions && final.counts.filled === counts.filled && final.counts.vacant === counts.vacant,
  `the tenant reads exactly as it did: ${final.counts.positions} positions / ${final.counts.filled} filled / ${final.counts.vacant} vacant`);

console.log(`\n${passed} passed, ${failed.length} failed, ${skipped.length} skipped`);
for (const s of skipped) console.log(`  skipped — ${s}`);
for (const f of failed) console.log(`  FAIL — ${f}`);
await pool.end();
process.exit(failed.length ? 1 : 0);
