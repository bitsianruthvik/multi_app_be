/**
 * spec_option_inline_test.mjs — a new option value added from the item form,
 * through POST /catalog/specifications/:id/options, against the local DB.
 *
 *   cd multi_app_be && node scripts/cf_kepl/spec_option_inline_test.mjs
 *
 * EVERYTHING HAPPENS INSIDE ONE TRANSACTION THAT IS ROLLED BACK. Nothing here
 * is committed, and the last thing it does is re-count every table it wrote and
 * prove the counts are exactly what they were before it started.
 *
 * IT OWNS ITS FIXTURE: its own option specification, its own number
 * specification, its own Family > Subfamily > Variant branches and its own
 * rules — nothing of company 2's GRADE or of its classification nodes. Other
 * suites went red this week by borrowing that data (uq_ccn_sibling is unique
 * on NAME, not code), so every name and code here carries this run's tag.
 *
 * THE PERMISSION CHECK RUNS THE ROUTES' OWN GUARDS. Going through HTTP would
 * commit in the route's own transaction, so the handler's service is called on
 * this connection with the context the handler would build, and the guards
 * registered on each router are run on their own with a catalog-only user.
 */
import path from 'path';
import { pathToFileURL } from 'url';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
const { attachNodeCache, detachNodeCache } = await imp('apps/cf_erp/lib/db.js');
const { ctx } = await imp('apps/cf_erp/lib/http.js');
const { translateDbError } = await imp('apps/cf_erp/lib/errors.js');
const S = await imp('apps/cf_erp/services/specificationService.js');
const { createNode } = await imp('apps/cf_erp/services/classificationService.js');
const { createRule } = await imp('apps/cf_erp/services/assignmentService.js');
const { resolve } = await imp('apps/cf_erp/services/resolutionService.js');
const { protect } = await imp('core/middleware/authmiddleware.js');
const { fail } = await imp('core/middleware/requirePerm.js');
const recordRoutes = (await imp('apps/cf_erp/routes/records.js')).default;
const setupRoutes = (await imp('apps/cf_erp/routes/setup.js')).default;

const COMPANY = Number(process.env.CF_OPTION_COMPANY ?? 2);
const NEW_ROUTE = '/catalog/specifications/:id/options';
const SETUP_ROUTE = '/specifications/:id/options';

/* --------------------------------------------------------------------------
 * A tiny harness
 * ----------------------------------------------------------------------- */
let passed = 0;
let failed = 0;
const fails = [];
/**
 * ok(name, cond, detail?) — the NAME comes first. It demands a string and then
 * a boolean, so a swapped ok(cond, 'name'), or a truthy object passed as the
 * condition, throws instead of passing unconditionally (that has happened
 * twice in this codebase).
 */
function ok(name, cond, detail = '') {
  if (typeof name !== 'string' || typeof cond !== 'boolean') {
    throw new Error(`ok(name, cond) takes a string and then a boolean — got ok(${typeof name}, ${typeof cond})`);
  }
  if (cond) { passed += 1; console.log(`  PASS  ${name}`); }
  else { failed += 1; fails.push(name); console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (name, got, want) => ok(name, Object.is(got, want), `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
const same = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
const section = (s) => console.log(`\n${s}`);
/** The sentence a person would read, printed so its wording can be reviewed. */
const says = (text) => console.log(`        says: ${text}`);
/** The error a call throws, or null when it does not. */
async function refusal(fn) {
  try { await fn(); return null; } catch (e) { return e; }
}

/* --------------------------------------------------------------------------
 * Counting, so "writes nothing" is a fact and not a hope
 * ----------------------------------------------------------------------- */
const COUNTED = [
  'cf_specifications', 'cf_spec_options', 'cf_spec_assignments', 'cf_spec_assignment_options',
  'cf_classification_nodes', 'cf_spec_values', 'cf_spec_value_history', 'cf_master_records',
];
async function counts(db) {
  const out = {};
  for (const t of COUNTED) {
    const [[r]] = await db.query(`SELECT COUNT(*) AS n FROM \`${t}\``);
    out[t] = Number(r.n);
  }
  return out;
}
const diff = (a, b) => COUNTED.filter((t) => a[t] !== b[t]).map((t) => `${t} ${a[t]}->${b[t]}`);

/* --------------------------------------------------------------------------
 * Guards: what a request gets through before the handler
 * ----------------------------------------------------------------------- */
function routeOf(router, method, routePath) {
  return router.stack.find((l) => l.route?.path === routePath && l.route.methods[method])?.route ?? null;
}
/** Everything registered before the handler except the token check (the user is given here). */
const guardsOf = (route) => route.stack.slice(0, -1).map((l) => l.handle).filter((fn) => fn !== protect);
/** Runs a route's guards for `user`: { reached } when every one of them let it through, else the status it was stopped with. */
async function throughGuards(route, user) {
  const req = { user, params: { id: '1' }, body: {}, headers: {}, cookies: {} };
  for (const fn of guardsOf(route)) {
    let passedOn = false;
    let status = null;
    const res = { status(code) { status = code; return this; }, json() { return this; } };
    await fn(req, res, () => { passedOn = true; });
    if (!passedOn) return { reached: false, status };
  }
  return { reached: true, status: null };
}
/** What fail() — the route's error responder — would send for an error. */
function responseFor(err) {
  const out = { status: null, body: null };
  const res = { status(code) { out.status = code; return this; }, json(body) { out.body = body; return this; } };
  fail(res, translateDbError(err));
  return out;
}

const user = (tags) => ({ id: null, role: 'user', companyId: COMPANY, uiPermissions: tags });
const CATALOG_ONLY = user(['cf_erp_catalog_view', 'cf_erp_catalog_manage']);
const VIEW_ONLY = user(['cf_erp_catalog_view']);
const SETUP_USER = user(['cf_erp_catalog_view', 'cf_erp_setup_manage']);

/* --------------------------------------------------------------------------
 * The fixture — all of it this run's own
 * ----------------------------------------------------------------------- */
const tag = `TSO${Date.now().toString(36).toUpperCase()}`;

async function liveOptions(db, companyId, specId) {
  const [rows] = await db.query(
    'SELECT id, value, status, sort_order FROM cf_spec_options WHERE company_id = ? AND specification_id = ? AND deleted_at IS NULL ORDER BY sort_order, id',
    [companyId, specId],
  );
  return rows;
}
async function narrowedIds(db, assignmentId) {
  const [rows] = await db.query(
    'SELECT option_id FROM cf_spec_assignment_options WHERE company_id = ? AND assignment_id = ? AND deleted_at IS NULL ORDER BY option_id',
    [COMPANY, assignmentId],
  );
  return rows.map((r) => r.option_id);
}
/** The values resolution offers an item filed at `nodeId` for `specId` — the list the item form shows. */
async function offeredAt(db, nodeId, specId) {
  const r = await resolve(db, COMPANY, { nodeId });
  const entry = r.specs.find((s) => s.spec.id === specId && s.captureAt === 'item');
  return (entry?.options ?? []).map((o) => o.value);
}

async function buildFixture(db, c, cOther) {
  const grade = await S.createSpec(db, c, {
    code: `${tag}_GRADE`, name: `Test grade ${tag}`, dataType: 'option', options: [{ value: 'E250' }, { value: 'E350' }],
  });
  const thickness = await S.createSpec(db, c, { code: `${tag}_THK`, name: `Test thickness ${tag}`, dataType: 'number', defaultUom: 'mm' });
  const optionId = (v) => grade.options.find((o) => o.value === v).id;

  const family = await createNode(db, c, { code: `${tag}-F`, name: `Inline option fixture ${tag}` });
  const plates = await createNode(db, c, { parentId: family.id, code: `${tag}-PL`, name: `Plates ${tag}` });
  const plate10 = await createNode(db, c, { parentId: plates.id, code: `${tag}-P10`, name: `Plate 10 ${tag}` });
  const plate12 = await createNode(db, c, { parentId: plates.id, code: `${tag}-P12`, name: `Plate 12 ${tag}` });
  const sections = await createNode(db, c, { parentId: family.id, code: `${tag}-SE`, name: `Sections ${tag}` });
  const angle = await createNode(db, c, { parentId: sections.id, code: `${tag}-ANG`, name: `Angle ${tag}` });

  // "Plates allow E250 / E350 only" — narrowed on the Subfamily, so Plate 10
  // gets it only by walking up the tree.
  const platesRule = await createRule(db, c, {
    specificationId: grade.id, subjectType: 'classification', subjectId: plates.id,
    captureAt: 'item', valueRule: 'entered', isRequired: false, isApplicable: true, optionIds: [optionId('E250'), optionId('E350')],
  });
  // Plate 12 has its own rule with no narrowing: the most specific rule wins, whole.
  await createRule(db, c, {
    specificationId: grade.id, subjectType: 'classification', subjectId: plate12.id,
    captureAt: 'item', valueRule: 'entered', isRequired: false, isApplicable: true, optionIds: [],
  });
  // Sections take every grade.
  await createRule(db, c, {
    specificationId: grade.id, subjectType: 'classification', subjectId: sections.id,
    captureAt: 'item', valueRule: 'entered', isRequired: false, isApplicable: true,
  });

  // Another company: a spec with the very same code, and a node of its own.
  const twin = await S.createSpec(db, cOther, { code: `${tag}_GRADE`, name: `Test grade ${tag}`, dataType: 'option', options: [{ value: 'E250' }] });
  const otherNode = await createNode(db, cOther, { code: `${tag}-OX`, name: `Other company fixture ${tag}` });

  return { grade, thickness, optionId, family, plates, plate10, plate12, sections, angle, platesRule, twin, otherNode };
}

/* --------------------------------------------------------------------------
 * The run
 * ----------------------------------------------------------------------- */
console.log(`spec_option_inline_test — company ${COMPANY}, fixture tag ${tag}`);

section('0. The harness refuses a swapped ok()');
const swapped = await refusal(() => ok(true, 'swapped'));
ok('ok(cond, name) throws instead of passing', swapped instanceof Error);

const [[otherRow]] = await pool.query('SELECT id FROM companies WHERE id <> ? ORDER BY id LIMIT 1', [COMPANY]);
if (!otherRow) throw new Error('This database has only one company — the scoping section needs a second.');
const OTHER = otherRow.id;

const before = await counts(pool);
const conn = await pool.getConnection();
try {
  await conn.beginTransaction();
  attachNodeCache(conn);

  // The context each handler builds from the token: the company always comes from it.
  const cCat = ctx({ user: CATALOG_ONLY });
  const cSetup = ctx({ user: SETUP_USER });
  const cOther = { companyId: OTHER, userId: null };
  const f = await buildFixture(conn, cSetup, cOther);

  /* ---- 1. the door and its guard ---------------------------------------- */
  section('1. A catalog-only user gets through the new door; Setup\'s door still refuses them');
  const route = routeOf(recordRoutes, 'post', NEW_ROUTE);
  const setupRoute = routeOf(setupRoutes, 'post', SETUP_ROUTE);
  ok('POST /catalog/specifications/:id/options is registered on the records router', !!route);
  ok('Setup\'s POST /specifications/:id/options is still there', !!setupRoute);
  if (route && setupRoute) {
    ok('the new route checks the token first', route.stack[0]?.handle === protect);
    ok('and has a permission guard after it (so getting through is not vacuous)', guardsOf(route).length >= 1);
    const cat = await throughGuards(route, CATALOG_ONLY);
    ok('a catalog-only user reaches the new route\'s handler', cat.reached);
    const view = await throughGuards(route, VIEW_ONLY);
    ok('a view-only user is stopped by it', !view.reached);
    eq('with a 403', view.status, 403);
    const setupCat = await throughGuards(setupRoute, CATALOG_ONLY);
    ok('Setup\'s route still stops the catalog-only user', !setupCat.reached);
    eq('with a 403', setupCat.status, 403);
    const setupSetup = await throughGuards(setupRoute, SETUP_USER);
    ok('and still lets a setup user through', setupSetup.reached);
  }
  eq('the handler\'s context takes the company from the token', cCat.companyId, COMPANY);

  /* ---- 2. adds a value --------------------------------------------------- */
  section('2. It adds a value — and only adds');
  const added = await S.addCatalogOption(conn, cCat, f.grade.id, {
    value: '  E450 ', label: 'E450 (Fe 450)', sortOrder: 1, status: 'inactive',
  });
  ok('it hands back the new option', !!added.option && Number.isInteger(added.option.id));
  eq('the value is trimmed', added.option?.value, 'E450');
  eq('with its label', added.option?.label, 'E450 (Fe 450)');
  eq('it is active — a status in the body is not applied', added.option?.status, 'active');
  eq('it goes to the end of the list — a sort order in the body is not applied', added.option?.sortOrder, 3);
  eq('nothing narrowed it, since no classification was given', added.narrowedOut, false);
  eq('it names the specification', added.specification?.code, f.grade.code);
  ok('and says what it did', /E450/.test(added.message ?? ''), added.message);
  const liveAfterAdd = await liveOptions(conn, COMPANY, f.grade.id);
  same('the list is now E250, E350, E450', liveAfterAdd.map((o) => o.value), ['E250', 'E350', 'E450']);

  /* ---- 3. company-scoped ------------------------------------------------- */
  section('3. The value belongs to this company only');
  same('the other company\'s spec with the same code does not have it', (await liveOptions(conn, OTHER, f.twin.id)).map((o) => o.value), ['E250']);
  const otherLib = await S.listSpecs(conn, OTHER);
  ok('the other company\'s library does not show it anywhere', !otherLib.some((s) => (s.options ?? []).some((o) => o.id === added.option.id)));
  const peek = await refusal(() => S.getSpec(conn, OTHER, f.grade.id));
  eq('this company\'s spec is not found from the other company', peek?.status, 404);
  const foreign = await refusal(() => S.addCatalogOption(conn, cOther, f.grade.id, { value: 'E999' }));
  eq('and the other company cannot add to it', foreign?.status, 404);
  const twinAdd = await S.addCatalogOption(conn, cOther, f.twin.id, { value: 'E450' });
  ok('the other company can add its own E450 — the list is per company, so it is no duplicate', twinAdd.option?.value === 'E450' && twinAdd.option.id !== added.option.id);

  /* ---- 4. case-insensitive duplicate ------------------------------------- */
  section('4. A case-insensitive duplicate hands back the one already there');
  const dup = await refusal(() => S.addCatalogOption(conn, cCat, f.grade.id, { value: 'e450' }));
  eq('it is a 409', dup?.status, 409);
  eq('coded DUPLICATE_OPTION', dup?.code, 'DUPLICATE_OPTION');
  ok('its sentence names the existing value', /E450/.test(dup?.message ?? ''), dup?.message);
  says(dup?.message);
  eq('it hands back the existing option', dup?.existing?.id, added.option.id);
  eq('as it is stored', dup?.existing?.value, 'E450');
  const sent = responseFor(dup);
  eq('the route\'s responder sends it as a 409', sent.status, 409);
  eq('with the code', sent.body?.code, 'DUPLICATE_OPTION');
  eq('and the existing option in the body', sent.body?.existing?.id, added.option.id);
  const [[{ n: e450s }]] = await conn.query(
    'SELECT COUNT(*) AS n FROM cf_spec_options WHERE company_id = ? AND specification_id = ? AND value_active = \'e450\'',
    [COMPANY, f.grade.id],
  );
  eq('and there is still exactly one E450', Number(e450s), 1);
  const padded = await refusal(() => S.addCatalogOption(conn, cCat, f.grade.id, { value: ' e350 ' }));
  eq('padding and case together still find the seeded E350', padded?.existing?.id, f.optionId('E350'));

  /* ---- 5. a non-option spec ---------------------------------------------- */
  section('5. A specification that is not an option list is refused by name');
  const notOption = await refusal(() => S.addCatalogOption(conn, cCat, f.thickness.id, { value: '10' }));
  eq('it is a 422', notOption?.status, 422);
  eq('coded NOT_OPTION', notOption?.code, 'NOT_OPTION');
  ok('naming the specification', (notOption?.message ?? '').includes(f.thickness.code), notOption?.message);
  says(notOption?.message);
  eq('and nothing was written to it', (await liveOptions(conn, COMPANY, f.thickness.id)).length, 0);

  /* ---- 6. the narrowed case ---------------------------------------------- */
  section('6. Narrowed at the classification: added for the company, the narrowing left alone, and said so');
  const narrowBefore = await narrowedIds(conn, f.platesRule.id);
  same('the fixture\'s Plates rule allows E250 and E350', narrowBefore, [f.optionId('E250'), f.optionId('E350')].sort((a, b) => a - b));
  const narrowed = await S.addCatalogOption(conn, cCat, f.grade.id, { value: 'E550', classificationId: f.plate10.id });
  eq('narrowedOut is true', narrowed.narrowedOut, true);
  same('it says which values items there may take', narrowed.allowedHere, ['E250', 'E350']);
  ok('its sentence says it is now a company value', /is now a .* value for the whole company/.test(narrowed.message ?? ''), narrowed.message);
  ok('that items under that classification only allow E250 and E350', (narrowed.message ?? '').includes(`items under ${f.plate10.name} only allow E250 and E350`), narrowed.message);
  ok('and that Setup must allow it there first, at the rule that narrows it', /Setup must allow it/.test(narrowed.message ?? '') && (narrowed.message ?? '').includes(f.plates.name), narrowed.message);
  says(narrowed.message);
  const e550 = (await liveOptions(conn, COMPANY, f.grade.id)).find((o) => o.value === 'E550');
  ok('E550 is on the company list', !!e550);
  eq('and active', e550?.status, 'active');
  same('the narrowing was not widened', await narrowedIds(conn, f.platesRule.id), narrowBefore);
  const [[{ n: e550Narrowed }]] = await conn.query(
    'SELECT COUNT(*) AS n FROM cf_spec_assignment_options WHERE company_id = ? AND option_id = ? AND deleted_at IS NULL',
    [COMPANY, e550?.id ?? 0],
  );
  eq('E550 is in no narrowed list at all', Number(e550Narrowed), 0);
  same('an item on Plate 10 is still offered only E250 and E350', await offeredAt(conn, f.plate10.id, f.grade.id), ['E250', 'E350']);
  ok('an item on Angle is offered E550', (await offeredAt(conn, f.angle.id, f.grade.id)).includes('E550'));

  const open = await S.addCatalogOption(conn, cCat, f.grade.id, { value: 'E650', classificationId: f.angle.id });
  eq('under a rule that does not narrow, narrowedOut is false', open.narrowedOut, false);
  eq('and no list of allowed values comes back', open.allowedHere, undefined);
  const own = await S.addCatalogOption(conn, cCat, f.grade.id, { value: 'E750', classificationId: f.plate12.id });
  eq('Plate 12\'s own un-narrowed rule beats the narrowed one above it — resolution\'s walk, not a copy', own.narrowedOut, false);
  const dupNarrowed = await refusal(() => S.addCatalogOption(conn, cCat, f.grade.id, { value: 'e550', classificationId: f.plate10.id }));
  eq('a duplicate that is narrowed out there is still a 409 naming it', dupNarrowed?.existing?.id, e550?.id ?? -1);
  ok('and says items there only allow E250 and E350', (dupNarrowed?.message ?? '').includes('only allow E250 and E350'), dupNarrowed?.message);

  /* ---- 7. a retired duplicate -------------------------------------------- */
  section('7. A retired value is named, not quietly brought back');
  await S.updateOption(conn, cSetup, open.option.id, { status: 'inactive' });
  const retired = await refusal(() => S.addCatalogOption(conn, cCat, f.grade.id, { value: 'E650' }));
  eq('it is a 409', retired?.status, 409);
  ok('that says it is retired', /retired/.test(retired?.message ?? ''), retired?.message);
  says(retired?.message);
  eq('the existing option comes back as retired', retired?.existing?.status, 'inactive');
  eq('and it stays retired — this door never changes a status', (await liveOptions(conn, COMPANY, f.grade.id)).find((o) => o.value === 'E650')?.status, 'inactive');

  /* ---- 8. bad input is refused before anything is written ---------------- */
  section('8. Bad input is refused before anything is written');
  const optionsBefore = (await liveOptions(conn, COMPANY, f.grade.id)).length;
  const foreignNode = await refusal(() => S.addCatalogOption(conn, cCat, f.grade.id, { value: 'E850', classificationId: f.otherNode.id }));
  eq('another company\'s classification is not found', foreignNode?.status, 404);
  const badNode = await refusal(() => S.addCatalogOption(conn, cCat, f.grade.id, { value: 'E850', classificationId: 'abc' }));
  eq('a classificationId that is not a number is a 422', badNode?.status, 422);
  const empty = await refusal(() => S.addCatalogOption(conn, cCat, f.grade.id, { value: '   ' }));
  eq('an empty value is a 422 (addOption\'s own check)', empty?.status, 422);
  const long = await refusal(() => S.addCatalogOption(conn, cCat, f.grade.id, { value: 'X'.repeat(101) }));
  eq('a value over 100 characters is a 422', long?.status, 422);
  const longLabel = await refusal(() => S.addCatalogOption(conn, cCat, f.grade.id, { value: 'E950', label: 'L'.repeat(256) }));
  eq('a label over 255 characters is a 422', longLabel?.status, 422);
  eq('and none of them wrote a value', (await liveOptions(conn, COMPANY, f.grade.id)).length, optionsBefore);

  await conn.rollback();
  console.log('\nrolled back.');
} catch (err) {
  try { await conn.rollback(); } catch { /* the original error is the one that matters */ }
  failed += 1;
  fails.push('the run itself');
  console.error('\nTHREW:', err.code ?? '', err.message);
  if (err.problems) console.error('problems:', err.problems);
  console.error(err.stack?.split('\n').slice(1, 8).join('\n'));
} finally {
  detachNodeCache(conn);
  conn.release();
}

section('9. Nothing survived the rollback');
const after = await counts(pool);
const left = diff(before, after);
ok('every table it wrote is back to the count it started at', left.length === 0, left.join(', '));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) console.log(`failed: ${fails.join(' · ')}`);
await pool.end();
process.exitCode = failed ? 1 : 0;
