/**
 * codegen_explain_test.mjs — "which rule wins for this record", on the Coding
 * rules screen, must say exactly what the code generator does. Against the
 * local database.
 *
 *   cd multi_app_be && node scripts/cf_kepl/codegen_explain_test.mjs
 *
 * engine.explainSelection runs selectScheme's own three steps (candidates ->
 * evaluate -> rank). This proves it case by case: for every record, the
 * explanation names the rule selectScheme picks and generate() makes the code
 * by — the same tie, the same "no rule" — and, with an unsaved rule open in the
 * editor, the rule that WILL be picked once it is saved (each draft is then
 * really saved, inside a savepoint, and asked again).
 *
 * EVERYTHING HAPPENS INSIDE ONE TRANSACTION THAT IS ROLLED BACK; the run ends
 * with a COUNT(*) census of every cf_ table, naming the ones the fixture
 * touched, proving each is back where it started.
 *
 * IT OWNS ITS FIXTURE: its own family, subfamilies and variants, its own items
 * and specification, its own rules. Every name and code carries this run's tag
 * (cf_classification_nodes is unique on NAME per parent). Every other item and
 * production-piece rule of the company is switched off for the transaction, so
 * nothing of the company's decides a case here.
 *
 * The fixture's item rules — weights as the item provider gives them: a kind
 * is 1, "under" a level is 1 + its depth, the exact variant is 4:
 *
 *   FAM      kind = catalog, under the family     weight 2, priority 0
 *   SUB      under subfamily S                    weight 2, priority 5
 *   VA       classification = variant A           weight 4
 *   VB       under variant B                      weight 3
 *   TIE1/2   classification = variant C, twice    weight 4, priority 0 each — a tie
 *   NEVER    kind = temporary, under the family   never applies to a catalog item
 *   OFF      = variant A and catalog, priority 99 inactive, so never a candidate
 *
 *   item A (variant A)      VA wins on weight
 *   item B (variant B)      VB wins on weight
 *   item C (variant C)      TIE1 and TIE2 tie
 *   item E (variant E)      SUB beats FAM on priority
 *   item D (subfamily S2)   FAM is the only rule
 *   item G (another family) no rule at all
 */
import path from 'path';
import { pathToFileURL } from 'url';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
await imp('apps/cf_erp/services/codegenProvider.js');           // registers the code-generator entities
const { attachNodeCache, detachNodeCache } = await imp('apps/cf_erp/lib/db.js');
const { generate, selectScheme, getProvider, renderSegments, listEntities, BLANK } = await imp('apps/cf_erp/modules/codegen/engine.js');
const codegen = await imp('apps/cf_erp/modules/codegen/service.js');
const { createCodegenRouter } = await imp('apps/cf_erp/modules/codegen/routes.js');
const MR = await imp('apps/cf_erp/services/masterRecordService.js');
const { createNode } = await imp('apps/cf_erp/services/classificationService.js');
const { createRule } = await imp('apps/cf_erp/services/assignmentService.js');
const { setValues } = await imp('apps/cf_erp/services/valueService.js');

const COMPANY = Number(process.env.CF_EXPLAIN_COMPANY ?? 2);

/* --------------------------------------------------------------------------
 * A tiny harness
 * ----------------------------------------------------------------------- */
let passed = 0;
let failed = 0;
const fails = [];
/**
 * ok(label, cond, detail?) — the LABEL comes first, and the condition must be
 * a real boolean. A swapped ok(cond, 'label'), or a truthy object passed as the
 * condition, throws instead of passing unconditionally (that has bitten this
 * codebase twice).
 */
function ok(label, cond, detail = '') {
  if (typeof label !== 'string' || typeof cond !== 'boolean') {
    throw new TypeError(`ok(label, cond) takes a string and then a boolean — got ok(${typeof label}, ${typeof cond})`);
  }
  if (cond) { passed += 1; console.log(`  PASS  ${label}`); } else { failed += 1; fails.push(label); console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
}
const same = (label, got, want) => ok(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
const section = (s) => console.log(`\n${s}`);
async function refusal(fn) {
  try { await fn(); return null; } catch (e) { return e; }
}

/* --------------------------------------------------------------------------
 * Counting, so "writes nothing" is a fact and not a hope
 * ----------------------------------------------------------------------- */
async function cfTables(db) {
  const [rows] = await db.query("SHOW TABLES LIKE 'cf\\_%'");
  return rows.map((r) => Object.values(r)[0]).sort();
}
async function census(db, tables) {
  const out = {};
  for (const t of tables) {
    const [[r]] = await db.query(`SELECT COUNT(*) AS n FROM \`${t}\``);
    out[t] = Number(r.n);
  }
  return out;
}

/* --------------------------------------------------------------------------
 * Asking all three
 * ----------------------------------------------------------------------- */
const tag = `TCX${Date.now().toString(36).toUpperCase()}`;
const tok = (key, extra = {}) => ({ segmentType: 'token', tokenKey: key, transform: 'none', isRequired: true, ...extra });
const lit = (text) => ({ segmentType: 'literal', literalText: text });
let conn = null;

/** A SCHEME_TIE is one of the answers: { tie: [codes] }. Anything else thrown is a real failure. */
async function outcome(fn) {
  try { return await fn(); } catch (e) {
    if (e?.code === 'SCHEME_TIE') return { tie: e.problems };
    throw e;
  }
}
const subjectBody = (subject) => (subject.entityId != null ? { entityId: subject.entityId } : { draft: subject.draft });
const said = (x) => (x.selection.tied ? { tie: x.selection.tied } : x.selection.winner ? { id: x.selection.winner.id, code: x.selection.winner.code } : null);

async function contextOf(entityType, subject) {
  const provider = getProvider(entityType);
  return subject.entityId != null ? provider.loadContext(conn, COMPANY, subject.entityId) : provider.draftContext(conn, COMPANY, subject.draft);
}

/** What selectScheme picks, what generate() makes the code by, and what the explanation says. */
async function answers(entityType, subject, scheme = null) {
  const ctx = await contextOf(entityType, subject);
  const select = await outcome(async () => {
    const s = await selectScheme(conn, COMPANY, entityType, 'code', ctx);
    return s ? { id: s.id, code: s.code } : null;
  });
  const made = await outcome(async () => {
    const g = await generate(conn, COMPANY, entityType, 'code', subject, { consume: false });
    return g ? { id: g.schemeId, code: g.schemeCode } : null;
  });
  const x = await codegen.explainRecord(conn, COMPANY, { entityType, targetField: 'code', ...subjectBody(subject), ...(scheme ? { scheme } : {}) });
  return { select, made, said: said(x), x };
}

const show = (w) => (w == null ? 'no rule' : w.tie ? `a tie between ${w.tie.join(' and ')}` : w.code);
/** The explanation must say `want`, and selectScheme and generate() must agree with it. */
function agree(label, a, want) {
  same(`${label}: the explanation says ${show(want)}`, a.said, want);
  same(`${label}: selectScheme picks the same`, a.select, a.said);
  same(`${label}: generate() makes the code by the same`, a.made, a.said);
}
const ruleIn = (x, code) => x.selection.rules.find((r) => r.code === code);
const ref = (s) => ({ id: s.id, code: s.code });

/** A saved rule as the editor holds it — what the screen sends as `scheme`. */
const asDraft = (s, patch = {}) => ({
  id: s.id, code: s.code, name: s.name, entityType: s.entityType, targetField: s.targetField, seqScope: s.seqScope,
  priority: s.priority, status: s.status, conditions: s.conditions, segments: s.segments, ...patch,
});

/* --------------------------------------------------------------------------
 * The run
 * ----------------------------------------------------------------------- */
console.log(`codegen_explain_test — company ${COMPANY}, fixture tag ${tag}`);

section('0. The harness refuses a swapped or non-boolean ok()');
ok('ok(cond, label) throws instead of passing', (await refusal(() => ok(true, 'swapped'))) instanceof TypeError);
ok('ok(label, {}) throws — a truthy object is not a pass', (await refusal(() => ok('an object', {}))) instanceof TypeError);
ok('ok(label, 1) throws — nor is a number', (await refusal(() => ok('a number', 1))) instanceof TypeError);

section('1. The route: /codegen/explain is guarded exactly like /codegen/preview');
{
  const router = createCodegenRouter({ viewPerm: 'x_view', managePerm: 'x_manage' });
  const route = (p) => router.stack.find((l) => l.route?.path === p && l.route.methods?.post)?.route ?? null;
  const explainRoute = route('/codegen/explain');
  const previewRoute = route('/codegen/preview');
  ok('POST /codegen/explain is mounted', !!explainRoute);
  ok('with the same guards, in the same order, as the preview (the very same functions)',
    !!explainRoute && !!previewRoute && explainRoute.stack.length === previewRoute.stack.length
      && explainRoute.stack.slice(0, -1).every((l, i) => l.handle === previewRoute.stack[i].handle));
}

section('1b. Every token and condition carries its guide — the screen has no words of its own for them');
{
  const text = (v) => typeof v === 'string' && v.trim().length > 0;
  const bare = [];
  for (const e of listEntities()) {
    for (const t of e.tokens) if (!text(t.phrase) || !text(t.help) || !text(t.example)) bare.push(`${e.entityType} token ${t.key}`);
    for (const p of e.tokenPatterns) if (!text(p.phrase) || !p.phrase.includes('<name>') || !text(p.help) || !text(p.example)) bare.push(`${e.entityType} pattern ${p.pattern}`);
    for (const k of e.conditionTokens) if (!text(k.phrase) || !text(k.help)) bare.push(`${e.entityType} condition ${k.key}`);
  }
  same(`all ${listEntities().length} entities: every token has a phrase, help and an example; every condition a phrase and help`, bare, []);
  const item = listEntities().find((e) => e.entityType === 'item');
  ok('a condition\'s help quotes the points its test really scores: an exact variant 4, under a variant 3',
    /scores 4/.test(item.conditionTokens.find((k) => k.key === 'classification').help) && /a variant 3/.test(item.conditionTokens.find((k) => k.key === 'classification').help));
}

const TABLES = await cfTables(pool);
const before = await census(pool, TABLES);
let inside = null;
conn = await pool.getConnection();
try {
  await conn.beginTransaction();
  attachNodeCache(conn);
  const c = { companyId: COMPANY, userId: null };

  // Every other item and production-piece rule of the company goes quiet for
  // the transaction: only the fixture's rules can decide a case.
  const [rivals] = await conn.query(
    `SELECT id FROM cf_code_schemes WHERE company_id = ? AND entity_type IN ('item', 'production_piece')
        AND status = 'active' AND deleted_at IS NULL`,
    [COMPANY],
  );
  if (rivals.length) await conn.query("UPDATE cf_code_schemes SET status = 'inactive' WHERE company_id = ? AND id IN (?)", [COMPANY, rivals.map((r) => r.id)]);

  /* ---- the fixture ------------------------------------------------------- */
  section('2. The fixture is this run\'s own');
  const node = (code, name, parentId = null) => createNode(conn, c, { ...(parentId ? { parentId } : {}), code: `${tag}-${code}`, name: `${name} ${tag}` });
  const fam = await node('F', 'Explain fixture');
  const sub = await node('S', 'Explain kinds', fam.id);
  const sub2 = await node('S2', 'Explain other kinds', fam.id);
  const vA = await node('VA', 'Variant A', sub.id);
  const vB = await node('VB', 'Variant B', sub.id);
  const vC = await node('VC', 'Variant C', sub.id);
  const vE = await node('VE', 'Variant E', sub.id);
  const vD = await node('VD', 'Variant D', sub2.id);
  const elsewhere = await node('G', 'Explain elsewhere');
  const subG = await node('GS', 'Explain elsewhere kinds', elsewhere.id);
  const vG = await node('GV', 'Variant G', subG.id);

  // A number specification of its own, fixed at 250 on variant A (written as
  // createSpec writes it — one row), so a pattern can print it formatted.
  const lenCode = `${tag}_LEN`;
  const [sr] = await conn.query(
    "INSERT INTO cf_specifications (company_id, code, name, data_type, default_uom, status, created_by) VALUES (?, ?, ?, 'number', 'mm', 'active', ?)",
    [COMPANY, lenCode, `Explain length ${tag}`, c.userId],
  );
  await createRule(conn, c, {
    specificationId: sr.insertId, subjectType: 'classification', subjectId: vA.id,
    captureAt: 'item', valueRule: 'fixed', isRequired: false, isApplicable: true,
  });
  await setValues(conn, c, 'classification', vA.id, [{ specCode: lenCode, value: 250 }]);

  // Items first — no active item rule exists yet, so each keeps the code it is given.
  const item = (code, name, classificationId, extra = {}) => MR.createItem(conn, c, {
    itemType: 'catalog', classificationId, code: `${tag}-${code}`, name: `${name} ${tag}`, uom: 'nos', ...extra,
  });
  const A = await item('A', 'Item A', vA.id, { shortName: 'PA' });
  const B = await item('B', 'Item B', vB.id, { shortName: 'PB' });
  const C = await item('C', 'Item C', vC.id, { shortName: 'PC' });
  const E = await item('E', 'Item E', vE.id, { shortName: 'PE' });
  const D = await item('D', 'Item D', vD.id, { shortName: 'PD' });
  const G = await item('G', 'Item G', vG.id, { shortName: 'PG' });
  const N = await item('N', 'Item none', vD.id, { noShortName: true });   // a short name set to none

  const rule = (code, conditions, extra = {}) => codegen.createScheme(conn, COMPANY, c.userId, {
    code: `${tag}-${code}`, name: `Explain ${code} ${tag}`, entityType: 'item', targetField: 'code', seqScope: 'prefix', priority: 0, status: 'active',
    conditions, segments: [tok('family.code'), lit('-'), tok('record.shortName')], ...extra,
  });
  const kindIs = (k) => ({ tokenKey: 'kind', operator: 'eq', value: k });
  const under = (n) => ({ tokenKey: 'classification', operator: 'under', value: String(n.id) });
  const exactly = (n) => ({ tokenKey: 'classification', operator: 'eq', value: String(n.id) });
  const R = {
    FAM: await rule('FAM', [kindIs('catalog'), under(fam)]),
    SUB: await rule('SUB', [under(sub)], { priority: 5 }),
    VA: await rule('VA', [exactly(vA)]),
    VB: await rule('VB', [under(vB)]),
    TIE1: await rule('TIE1', [exactly(vC)]),
    TIE2: await rule('TIE2', [exactly(vC)]),
    NEVER: await rule('NEVER', [kindIs('temporary'), under(fam)], { priority: 50 }),
    OFF: await rule('OFF', [exactly(vA), kindIs('catalog')], { priority: 99, status: 'inactive' }),
  };
  const [[{ n: foreign }]] = await conn.query(
    `SELECT COUNT(*) AS n FROM cf_code_schemes WHERE company_id = ? AND entity_type IN ('item', 'production_piece')
        AND status = 'active' AND deleted_at IS NULL AND code NOT LIKE ?`,
    [COMPANY, `${tag}-%`],
  );
  same('no active item or piece rule but this run\'s', Number(foreign), 0);
  same('seven items, each with the code it was given', [A, B, C, E, D, G, N].map((m) => m.code), ['A', 'B', 'C', 'E', 'D', 'G', 'N'].map((k) => `${tag}-${k}`));

  /* ---- saved rules ------------------------------------------------------- */
  section('3. Saved rules: the explanation picks what selectScheme and generate() pick');
  const aA = await answers('item', { entityId: A.id });
  agree('item A', aA, ref(R.VA));
  same('item A: decided on weight — 4 against the runner-up SUB\'s 2', [aA.x.selection.decidedBy, aA.x.selection.runnerUp?.code, ruleIn(aA.x, R.VA.code)?.weight, aA.x.selection.runnerUp?.weight],
    ['weight', R.SUB.code, 4, 2]);

  const aB = await answers('item', { entityId: B.id });
  agree('item B', aB, ref(R.VB));
  same('item B: decided on weight — 3 against 2', [aB.x.selection.decidedBy, ruleIn(aB.x, R.VB.code)?.weight, aB.x.selection.runnerUp?.weight], ['weight', 3, 2]);

  const aE = await answers('item', { entityId: E.id });
  agree('item E', aE, ref(R.SUB));
  same('item E: SUB and FAM weigh the same, SUB wins on priority 5 against 0',
    [aE.x.selection.decidedBy, ruleIn(aE.x, R.SUB.code)?.weight, ruleIn(aE.x, R.FAM.code)?.weight, aE.x.selection.runnerUp?.code, aE.x.selection.runnerUp?.priority],
    ['priority', 2, 2, R.FAM.code, 0]);

  const aD = await answers('item', { entityId: D.id });
  agree('item D', aD, ref(R.FAM));
  same('item D: FAM is the only rule that applies', [aD.x.selection.decidedBy, aD.x.selection.runnerUp], ['only', null]);

  const aC = await answers('item', { entityId: C.id });
  agree('item C', aC, { tie: [R.TIE1.code, R.TIE2.code] });
  same('item C: both tied rules say "tied", the rules below them "beaten", and nobody wins',
    [ruleIn(aC.x, R.TIE1.code)?.verdict, ruleIn(aC.x, R.TIE2.code)?.verdict, ruleIn(aC.x, R.SUB.code)?.verdict, ruleIn(aC.x, R.FAM.code)?.verdict, aC.x.selection.winner, aC.x.selection.decidedBy],
    ['tied', 'tied', 'beaten', 'beaten', null, 'tie']);

  const aG = await answers('item', { entityId: G.id });
  agree('item G', aG, null);
  same('item G: no rule applies, so none wins', [aG.x.selection.decidedBy, aG.x.selection.rules.every((r) => r.verdict === 'no')], ['none', true]);

  section('4. Each rule, each condition, as the item provider tests it');
  const never = ruleIn(aA.x, R.NEVER.code);
  same('NEVER does not apply: its kind condition fails, its "under the family" holds', [never?.verdict, never?.applies, never?.weight, never?.conditions.map((k) => k.ok)], ['no', false, null, [false, true]]);
  ok('the inactive rule OFF takes no part — it is not listed at all', !aA.x.selection.rules.some((r) => r.code === R.OFF.code));
  const ctxA = await contextOf('item', { entityId: A.id });
  let drift = 0;
  let weightDrift = 0;
  for (const r of aA.x.selection.rules) {
    for (const k of r.conditions) {
      const t = ctxA.test({ token_key: k.tokenKey, operator: k.operator, value: k.value });
      if (!!t.ok !== k.ok || t.weight !== k.weight) drift += 1;
    }
    const sum = r.conditions.reduce((s, k) => s + k.weight, 0);
    if (r.applies !== r.conditions.every((k) => k.ok) || r.weight !== (r.applies ? sum : null)) weightDrift += 1;
  }
  same(`all ${aA.x.selection.rules.reduce((s, r) => s + r.conditions.length, 0)} conditions shown for item A hold or fail exactly as the provider's own test says, with its weight`, drift, 0);
  same('a rule applies exactly when all its conditions hold, and weighs their sum', weightDrift, 0);
  same('the rules that apply come first, in the order they rank', aA.x.selection.rules.filter((r) => r.applies).map((r) => [r.code, r.place]),
    [[R.VA.code, 1], [R.SUB.code, 2], [R.FAM.code, 3]]);

  /* ---- drafts ------------------------------------------------------------- */
  section('5. An unsaved rule is judged as it will be once saved');
  // a. Editing VB to "under subfamily S", priority 9: it stands in for its
  //    saved self, weighs 2 like SUB and FAM, and wins on priority.
  const vbEdit = asDraft(R.VB, { conditions: [under(sub)], priority: 9 });
  const xB = await codegen.explainRecord(conn, COMPANY, { entityType: 'item', targetField: 'code', entityId: B.id, scheme: vbEdit });
  same('item B, VB edited: the draft wins on priority over SUB', [said(xB), xB.selection.decidedBy, xB.selection.winner?.draft, xB.selection.runnerUp?.code],
    [ref(R.VB), 'priority', true, R.SUB.code]);
  ok('and it is listed once — the draft, not its saved self as well', xB.selection.rules.filter((r) => r.id === R.VB.id).length === 1 && ruleIn(xB, R.VB.code)?.draft === true);
  const xE = await codegen.explainRecord(conn, COMPANY, { entityType: 'item', targetField: 'code', entityId: E.id, scheme: vbEdit });
  same('item E, VB edited: now VB reaches it too, and wins', said(xE), ref(R.VB));
  await conn.query('SAVEPOINT draft_a');
  await codegen.updateScheme(conn, COMPANY, c.userId, R.VB.id, vbEdit);
  agree('item B after saving the edit', await answers('item', { entityId: B.id }), said(xB));
  agree('item E after saving the edit', await answers('item', { entityId: E.id }), said(xE));
  await conn.query('ROLLBACK TO SAVEPOINT draft_a');

  // b. A new rule that ties VA on item A.
  const newTie = { code: `${tag}-NEW`, name: `Explain NEW ${tag}`, entityType: 'item', targetField: 'code', seqScope: 'prefix', priority: 0, status: 'active', conditions: [exactly(vA)], segments: [tok('record.shortName'), lit('-'), { segmentType: 'sequence', format: '00' }] };
  const xTie = await codegen.explainRecord(conn, COMPANY, { entityType: 'item', targetField: 'code', entityId: A.id, scheme: newTie });
  same('item A, a new rule like VA: the explanation calls it a tie', said(xTie), { tie: [R.VA.code, newTie.code] });
  await conn.query('SAVEPOINT draft_b');
  await codegen.createScheme(conn, COMPANY, c.userId, newTie);
  agree('item A after saving the new rule', await answers('item', { entityId: A.id }), said(xTie));
  await conn.query('ROLLBACK TO SAVEPOINT draft_b');

  // c. An inactive draft is tested, but takes no part.
  const sleeper = { ...newTie, code: `${tag}-SLEEP`, name: `Explain SLEEP ${tag}`, priority: 99, status: 'inactive' };
  const xOff = await codegen.explainRecord(conn, COMPANY, { entityType: 'item', targetField: 'code', entityId: A.id, scheme: sleeper });
  same('item A, an inactive draft that would apply: it is "off", and VA still wins',
    [ruleIn(xOff, sleeper.code)?.verdict, ruleIn(xOff, sleeper.code)?.applies, ruleIn(xOff, sleeper.code)?.weight, said(xOff)], ['off', true, 4, ref(R.VA)]);
  await conn.query('SAVEPOINT draft_c');
  await codegen.createScheme(conn, COMPANY, c.userId, sleeper);
  agree('item A after saving it inactive', await answers('item', { entityId: A.id }), said(xOff));
  await conn.query('ROLLBACK TO SAVEPOINT draft_c');

  // d. A draft with an unfinished condition is left out — and so is its saved self.
  const vaHalf = asDraft(R.VA, { conditions: [{ tokenKey: 'classification', operator: 'eq', value: '' }] });
  const xHalf = await codegen.explainRecord(conn, COMPANY, { entityType: 'item', targetField: 'code', entityId: A.id, scheme: vaHalf });
  same('item A, VA with a condition not filled in: "unfinished", saying what is missing',
    [ruleIn(xHalf, R.VA.code)?.verdict, ruleIn(xHalf, R.VA.code)?.problems], ['unfinished', ['Condition 1: needs a value.']]);
  same('and the next rule wins, as if VA were away', said(xHalf), ref(R.SUB));
  await conn.query('SAVEPOINT draft_d');
  await conn.query("UPDATE cf_code_schemes SET status = 'inactive' WHERE id = ?", [R.VA.id]);
  agree('item A with VA really switched off', await answers('item', { entityId: A.id }), said(xHalf));
  await conn.query('ROLLBACK TO SAVEPOINT draft_d');
  agree('item A once more, VA back', await answers('item', { entityId: A.id }), ref(R.VA));

  /* ---- unsaved records ---------------------------------------------------- */
  section('6. Unsaved records (drafts): production pieces');
  const piece = (code, conditions, segments) => codegen.createScheme(conn, COMPANY, c.userId, {
    code: `${tag}-${code}`, name: `Explain ${code} ${tag}`, entityType: 'production_piece', targetField: 'code', seqScope: 'prefix', priority: 0, status: 'active', conditions, segments,
  });
  const placed = (p) => ({ tokenKey: 'placement', operator: 'eq', value: p });
  const P = {
    TOP: await piece('PTOP', [placed('line'), under(fam)], [tok('item.code'), lit('-'), tok('piece.seq')]),
    PART: await piece('PPART', [placed('component')], [tok('parent.code'), lit('-'), tok('item.shortName'), tok('piece.seq')]),
    VA: await piece('PVA', [placed('component'), exactly(vA)], [tok('parent.code'), lit('-'), tok('piece.seq')]),
  };
  const cases = [
    ['a piece of item A inside another', { itemId: A.id, parentCode: 'P1', pieceSeq: 3 }, ref(P.VA)],
    ['a piece of item B inside another', { itemId: B.id, parentCode: 'P1', pieceSeq: 3 }, ref(P.PART)],
    ['the top piece of item A', { itemId: A.id, pieceSeq: 1 }, ref(P.TOP)],
    ['the top piece of item G, another family', { itemId: G.id, pieceSeq: 1 }, null],
  ];
  for (const [label, draft, want] of cases) agree(label, await answers('production_piece', { draft }), want);
  const xPiece = await codegen.explainRecord(conn, COMPANY, { entityType: 'production_piece', targetField: 'code', draft: cases[0][1], scheme: asDraft(P.VA) });
  const gPiece = await generate(conn, COMPANY, 'production_piece', 'code', { draft: cases[0][1] }, { consume: false });
  same('its parts, joined, are the code generate() makes', xPiece.parts.map((p) => p.text).join(''), gPiece?.text);
  same('which reads P1-3', gPiece?.text, 'P1-3');

  /* ---- parts --------------------------------------------------------------- */
  section('7. Each part prints exactly what the preview prints');
  const preview = (subject, scheme) => generate(conn, COMPANY, 'item', 'code', subject, {
    consume: false, inline: { id: scheme.id ?? null, code: scheme.code, seqScope: scheme.seqScope, segments: codegen.normalizeSegments(scheme.segments) },
  });
  const partsOf = async (subject, scheme) => (await codegen.explainRecord(conn, COMPANY, { entityType: 'item', targetField: 'code', ...subjectBody(subject), scheme })).parts;

  // Every kind of part, and a running number whose counter is already at 2.
  const full = asDraft(R.VA, {
    segments: [
      lit('X-'), tok('family.code', { transform: 'lower', maxLength: 6 }), lit('/'), tok(`spec:${lenCode}`, { format: '0.00' }), lit('-'),
      { segmentType: 'date', format: 'YYMM' }, lit('-'), { segmentType: 'sequence', format: '000' },
    ],
  });
  const fullRows = codegen.normalizeSegments(full.segments);
  await renderSegments(conn, COMPANY, { id: R.VA.id, code: R.VA.code, seq_scope: 'prefix' }, fullRows, ctxA, { consume: true });   // hands out 001
  const fullParts = await partsOf({ entityId: A.id }, full);
  const fullPreview = await preview({ entityId: A.id }, full);
  same('the parts, joined, are the preview\'s text', fullParts.map((p) => p.text).join(''), fullPreview?.text);
  const yymm = `${String(new Date().getFullYear()).slice(-2)}${String(new Date().getMonth() + 1).padStart(2, '0')}`;
  same('part by part: lower case cut to 6, 250 with two decimals, the date, and the NEXT number 002',
    fullParts.map((p) => p.text), ['X-', `${tag}-F`.toLowerCase().slice(0, 6), '/', '250.00', '-', yymm, '-', '002']);
  ok('every part has a value', fullParts.every((p) => p.state === 'value'));

  const holey = asDraft(R.VA, { segments: [tok('parent.code'), lit('-'), { segmentType: 'sequence', format: '00' }] });
  const holeyParts = await partsOf({ entityId: A.id }, holey);
  const holeyPreview = await preview({ entityId: A.id }, holey);
  same('a catalog item has no parent: that part is missing, and the running number after it waits', holeyParts.map((p) => p.state), ['missing', 'value', 'waiting']);
  same('while the preview makes no code and names the gap', [holeyPreview?.text, holeyPreview?.missing], [null, ['parent.code']]);

  const noneScheme = asDraft(R.FAM, { segments: [tok('record.shortName'), lit('-'), tok('family.code')] });
  const noneParts = await partsOf({ entityId: N.id }, noneScheme);
  const nonePreview = await preview({ entityId: N.id }, noneScheme);
  same('a short name set to none: that part prints nothing on purpose', noneParts.map((p) => [p.state, p.text]), [['blank', ''], ['value', '-'], ['value', `${tag}-F`]]);
  same('and the preview agrees — no gap, nothing missing', [nonePreview?.text, nonePreview?.missing], [`-${tag}-F`, []]);

  const unfinished = asDraft(R.FAM, { segments: [tok('family.code'), { segmentType: 'token', tokenKey: null }, { segmentType: 'sequence', format: '0' }] });
  same('a part with no value chosen yet is "unfinished", and the number after it waits',
    (await partsOf({ entityId: A.id }, unfinished)).map((p) => p.state), ['value', 'unfinished', 'waiting']);

  /* ---- values -------------------------------------------------------------- */
  section('8. Each token\'s value on the record is what a pattern of that token alone prints');
  const itemTokens = getProvider('item').tokens.map((t) => t.key);
  const keys = [...itemTokens, `spec:${lenCode}`];
  for (const [label, id] of [['item A', A.id], ['item N, short name none', N.id]]) {
    const { values } = await codegen.explainRecord(conn, COMPANY, { entityType: 'item', targetField: 'code', entityId: id, keys });
    const ctx = await contextOf('item', { entityId: id });
    let wrong = 0;
    for (const key of keys) {
      const alone = await preview({ entityId: id }, { code: 'ALONE', seqScope: 'prefix', segments: [tok(key)] });
      const blank = ctx.get(key) === BLANK;
      const want = alone.text === null ? { state: 'missing', text: null } : blank ? { state: 'blank', text: '' } : { state: 'value', text: alone.text };
      if (JSON.stringify(values[key]) !== JSON.stringify(want)) { wrong += 1; console.log(`        ${key}: got ${JSON.stringify(values[key])}, wanted ${JSON.stringify(want)}`); }
    }
    same(`${label}: all ${keys.length} tokens agree`, wrong, 0);
  }
  const { values: vA_ } = await codegen.explainRecord(conn, COMPANY, { entityType: 'item', targetField: 'code', entityId: A.id, keys });
  same('item A reads: short name PA, variant code, spec 250, no parent (a catalog item)',
    [vA_['record.shortName'], vA_['classification.code'], vA_[`spec:${lenCode}`], vA_['parent.code']],
    [{ state: 'value', text: 'PA' }, { state: 'value', text: `${tag}-VA` }, { state: 'value', text: '250' }, { state: 'missing', text: null }]);

  inside = await census(conn, TABLES);
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
const after = await census(pool, TABLES);
if (inside) {
  const touched = TABLES.filter((t) => inside[t] !== before[t]);
  console.log(`        the fixture touched ${touched.length} tables: ${touched.map((t) => `${t} ${before[t]} -> ${inside[t]} -> ${after[t]}`).join(', ')}`);
  ok('it touched the tables it should (nodes, records, items, rules)', ['cf_classification_nodes', 'cf_master_records', 'cf_item_details', 'cf_code_schemes', 'cf_code_scheme_conditions', 'cf_code_scheme_segments'].every((t) => touched.includes(t)));
  ok('and every table it touched is back to the count it started at', touched.every((t) => after[t] === before[t]), touched.filter((t) => after[t] !== before[t]).join(', '));
}
const left = TABLES.filter((t) => before[t] !== after[t]).map((t) => `${t} ${before[t]}->${after[t]}`);
ok(`every cf_ table (${TABLES.length}) is back to the count it started at`, left.length === 0, left.join(', '));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) console.log(`failed: ${fails.join(' · ')}`);
await pool.end();
process.exitCode = failed ? 1 : 0;
