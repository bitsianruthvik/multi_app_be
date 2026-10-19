/**
 * nest_grade_check_test.mjs — GRADE / IMPACT CLASS IN NESTING (user, 2026-10-18, item 22; init.sql §90,
 * lib/plateGrade.js). Local only.
 *
 *   cd multi_app_be && node scripts/cf_kepl/nest_grade_check_test.mjs
 *
 *   1. the rule itself (pure): exact grade, impact equal or better (A < BR < BO/B0 < C), 'exact', 'higher', a plate that
 *      states no class, the sentence that names pieces and plates
 *   2. AI plate choice, default rule: a BO piece never on a BR plate; BR and BO pieces together go on the plate that holds
 *      both; a piece only a plate without a class can hold — nested there and said; a grade the catalog lacks — refused
 *   3. 'exact': the steel is split by class, each on its own plates (keys …|BR, …|BO)
 *   4. no plate of the class asked: the pieces are refused in words naming the class; the others still nest
 *   5. 'higher': an E250 piece on an E350 plate; refused under the default rule
 *   6. accept: a definite mismatch is refused naming the plate, the cut piece and the class; a plate with no class is
 *      accepted and said (gradeCheck); 'exact' refuses a better plate
 *   7. upload (DXF): a BO piece on a BR plate named in the request → PART_WRONG_IMPACT; BR pieces on a BO plate pass;
 *      a nest of BR and BO pieces finds the BO plate by itself
 *   8. the Compare tab: the uploaded side carries gradeCheck (ok, then a mismatch under 'exact', naming plate and piece)
 *   9. the setting rides on the cut-settings read (one statement), and saves / reads through Setup › Cutting
 *  10. nothing survived the rollback; line 923 untouched
 *
 * ONE TRANSACTION, ROLLED BACK. It owns its fixture (lib/plateRulesFixture.mjs).
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.CF_NEST_BUDGET_SCALE = process.env.CF_NEST_BUDGET_SCALE ?? '0.005';
process.env.CF_NEST_AUTO_COMPARE = 'off';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
if (!/^(localhost|127\.0\.0\.1|::1)$/.test(process.env.DB_HOST ?? 'localhost')) throw new Error('This suite is local only.');
const { attachNodeCache, detachNodeCache } = await imp('apps/cf_erp/lib/db.js');
await imp('apps/cf_erp/services/codegenProvider.js');
const G = await imp('apps/cf_erp/lib/plateGrade.js');
const N = await imp('apps/cf_erp/services/nestingService.js');
const U = await imp('apps/cf_erp/services/nestDxfImportService.js');
const C = await imp('apps/cf_erp/services/nestCompareService.js');
const S = await imp('apps/cf_erp/services/shopRules.js');
const F = await imp('scripts/cf_kepl/lib/plateRulesFixture.mjs');
const D = await imp('scripts/cf_kepl/lib/nestDxfFixtures.mjs');

const COMPANY = Number(process.env.CF_NEST_COMPANY ?? 2);
const KEPL_LINE = 923;

let passed = 0; let failed = 0; const fails = [];
function ok(name, cond, detail = '') {
  if (typeof name !== 'string' || typeof cond !== 'boolean') throw new Error(`ok(label, condition) takes a string and then a boolean (${String(name).slice(0, 60)})`);
  if (cond) { passed += 1; console.log(`  PASS  ${name}`); } else { failed += 1; fails.push(name); console.log(`  FAIL  ${name}${detail ? ` — ${String(detail).slice(0, 900)}` : ''}`); }
}
const section = (s) => console.log(`\n${s}`);
const J = (v) => JSON.stringify(v);
async function refusal(fn) { try { await fn(); return null; } catch (e) { return e; } }
const said = (e, ...bits) => { const text = [e?.message, ...(e?.details?.problems ?? e?.problems ?? e?.detail?.problems ?? [])].join(' '); return bits.every((b) => text.includes(b)); };
const textOf = (e) => [e?.message, ...(e?.details?.problems ?? e?.problems ?? e?.detail?.problems ?? [])].join(' | ');

const [tables] = await pool.query("SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME LIKE 'cf\\_%' ORDER BY TABLE_NAME");
const counts = async () => (await pool.query(tables.map((t) => `SELECT '${t.name}' AS name,COUNT(*) AS n FROM \`${t.name}\``).join(' UNION ALL ')))[0];
const before = await counts();
const [[kepl0]] = await pool.query('SELECT COUNT(*) n FROM cf_production_releases WHERE order_line_id = ? AND deleted_at IS NULL', [KEPL_LINE]);
const [[settings0]] = await pool.query('SELECT nest_grade_rule, nest_custom_plates FROM cf_company_settings WHERE company_id = ?', [COMPANY]);

function counting(db) {
  const tally = { n: 0 };
  const proxy = new Proxy(db, { get: (target, prop) => (prop === 'query' || prop === 'execute' ? (...args) => { tally.n += 1; return target[prop](...args); } : Reflect.get(target, prop)) });
  return { db: proxy, tally };
}

const conn = await pool.getConnection();
const c = { companyId: COMPANY, userId: null, userName: 'grade check test' };

try {
  /* ───────────── 1 ───────────── */
  section('1. The rule (lib/plateGrade.js)');
  {
    const P = (grade, impactClass) => ({ grade, impactClass });
    ok("the DEFAULT ('exact', the user 2026-10-19: \"BO/BR, don't allow for now\"): BO and BR never stand in for each other, either way", G.fits(P('E350', 'BO'), P('E350', 'BR')).ok === false && G.fits(P('E350', 'BR'), P('E350', 'BO')).ok === false && G.fits(P('E350', 'BR'), P('E350', 'BO')).why === 'the plate is BR and the piece needs BO' && G.fits(P('E350', 'BR'), P('E350', 'BR')).ok === true);
    ok("'better': a BO plate holds a BR piece (BO is tested colder) — a better class, said as a substitute", J(G.fits(P('E350', 'BO'), P('E350', 'BR'), 'better')) === J({ ok: true, sure: true, code: null, substitute: 'impact', why: null }));
    const worse = G.fits(P('E350', 'BR'), P('E350', 'BO'), 'better');
    ok("'better': a BR plate never holds a BO piece — a definite mismatch, in words", worse.ok === false && worse.sure === true && worse.code === 'IMPACT' && worse.why === 'the plate is BR and the piece needs BO or better', J(worse));
    ok('B0 (zero) and BO (letter) are the same class; an option label "BO — no impact test" reads as BO', G.fits(P('E350', 'B0'), P('E350', 'BO')).ok && G.fits(P('E350', 'BO — no impact test'), P('E350', 'B0')).ok && G.impactRank('C') > G.impactRank('BO') && G.impactRank('BO') > G.impactRank('BR') && G.impactRank('BR') > G.impactRank('A'));
    ok("'exact': a better class is refused too", G.fits(P('E350', 'BO'), P('E350', 'BR'), 'exact').ok === false && /exactly BR/.test(G.fits(P('E350', 'BO'), P('E350', 'BR'), 'exact').why));
    const unk = G.fits(P('E350', null), P('E350', 'BR'));
    ok('a plate that states no class: allowed, not sure (IMPACT_UNKNOWN)', unk.ok === true && unk.sure === false && unk.code === 'IMPACT_UNKNOWN');
    ok('a piece that asks no class: any plate of its grade', J(G.fits(P('E350', 'BR'), P('E350', null))) === J({ ok: true, sure: true, code: null, substitute: null, why: null }));
    ok("grade: exact by default (E350 plate, E250 piece refused); 'higher' lets E350 stand in for E250, never E250 for E350, never another family",
      G.fits(P('E350', 'BR'), P('E250', 'BR')).code === 'GRADE' && G.fits(P('E350', 'BR'), P('E250', 'BR'), 'higher').ok && G.fits(P('E250', 'BR'), P('E350', 'BR'), 'higher').ok === false && G.fits(P('S355', 'BR'), P('E250', 'BR'), 'higher').ok === false);
    ok('a class not in the order is only ever itself', G.fits(P('E350', 'XX'), P('E350', 'BR')).ok === false && G.fits(P('E350', 'XX'), P('E350', 'XX')).ok === true);
    ok("ruleOf: anything else is the default ('exact'); only 'warn' does not block", G.ruleOf(null) === 'exact' && G.ruleOf('EXACT') === 'exact' && G.ruleOf('nonsense') === 'exact' && G.blocks(null) && !G.blocks('warn') && G.blocks('better') && G.blocks('exact') && G.blocks('higher'));
    ok("'warn' checks as 'better' (the same verdicts) and its gradeCheck says it does not block", J(G.fits({ grade: 'E350', impactClass: 'BR' }, { grade: 'E350', impactClass: 'BO' }, 'warn')) === J(G.fits({ grade: 'E350', impactClass: 'BR' }, { grade: 'E350', impactClass: 'BO' }, 'better')) && G.gradeCheck([], 'warn').blocking === false && G.gradeCheck([], 'better').blocking === true);
    const plates = [{ id: 1, steel: P('E350', 'BR') }, { id: 2, steel: P('E350', 'BO') }, { id: 3, steel: P('E350', null) }];
    ok('platesForAll: BR + BO pieces → only the BO plate; a BO piece with only BR / blank plates → the blank one, not sure',
      J(G.platesForAll(plates, [P('E350', 'BR'), P('E350', 'BO')], 'better').plates.map((p) => p.id)) === '[2]'
      && J(G.platesForAll([plates[0], plates[2]], [P('E350', 'BO')], 'better')) === J({ plates: [plates[2]], sure: false })
      && G.platesForAll(plates, [P('E350', 'BR'), P('E350', 'BO')]).plates.every((p) => p.id === 3));
    const check = G.gradeCheck([
      { lotNo: 'N-001', plateCode: 'PL-BR', plate: P('E350', 'BR'), pieces: [{ cutPlateId: 7, code: 'CP-7', steel: P('E350', 'BO') }, { cutPlateId: 7, code: 'CP-7', steel: P('E350', 'BO') }, { cutPlateId: 8, code: 'CP-8', steel: P('E350', 'BR') }] },
      { lotNo: 'N-002', plateCode: 'PL-X', plate: P('E350', null), pieces: [{ cutPlateId: 8, code: 'CP-8', steel: P('E350', 'BR') }] },
    ]);
    ok('gradeCheck: one entry per plate and cut piece, counted; the sentence names the piece, the plate and both classes',
      check.ok === false && check.mismatches.length === 1 && check.mismatches[0].pieces === 2 && check.unknown.length === 1
      && check.sentence.includes('CP-7 (E350 BO, 2 pieces) on plate N-001, PL-BR (E350 BR)'), J(check));
    ok('gradeCheck: all matching says so', G.gradeCheck([{ lotNo: 'N-1', plateCode: 'P', plate: P('E350', 'BR'), pieces: [{ cutPlateId: 1, code: 'X', steel: P('E350', 'BR') }] }]).sentence === 'Every piece is on a plate of its grade and impact class.');
  }

  await conn.beginTransaction();
  attachNodeCache(conn);
  section('Fixture');
  const fx = await F.buildPlateRulesFixture(conn, { company: COMPANY });
  await F.setPlateRules(conn, COMPANY, { gradeRule: null, customPlates: null });
  console.log(`  ${fx.tag}: line ${fx.lineId}`);
  const plan = (input = {}) => N.planNesting(conn, COMPANY, fx.lineId, input);
  const nestsOf = (p) => p.groups.flatMap((g) => g.nests.map((n) => ({ g, n, plate: fx.sfxOfPlate(n.plateItemId), cuts: [...new Set(n.pieces.map((x) => fx.sfxOfCut(x.cutPlateId)))] })));

  /* ───────────── 1b ───────────── */
  section("1a. The DEFAULT ('exact'): BR and BO each on their own plates, a mismatch refused both ways");
  {
    const p = await plan();
    const keys = p.groups.map((g) => g.key);
    const all = nestsOf(p);
    ok('the 12 mm steel is split by class (…|BR, …|BO): the BR pieces on the BR plate only, the BO pieces on the BO plate only',
      keys.includes(`12|E350|${fx.MS.toUpperCase()}|BR`) && keys.includes(`12|E350|${fx.MS.toUpperCase()}|BO`)
      && all.filter((x) => x.cuts.includes('A')).every((x) => x.plate === 'P12R') && all.filter((x) => x.cuts.includes('B')).every((x) => x.plate === 'P12O') && all.some((x) => x.cuts.includes('A')) && all.some((x) => x.cuts.includes('B')), J([keys, all.map((x) => [x.plate, x.cuts])]));
    for (const [sfx, to] of [['A', 'P12O'], ['B', 'P12R']]) {
      const t = structuredClone(p);
      for (const g of t.groups) for (const n of g.nests) if (n.pieces.some((x) => x.cutPlateId === fx.cut[sfx])) { n.plateItemId = fx.plates[to]; n.plateCode = fx.plateCode[to]; }
      const e = await refusal(() => N.acceptNesting(conn, c, fx.lineId, t, { allowLeftOver: true }));
      ok(`accept: the ${sfx === 'A' ? 'BR' : 'BO'} pieces moved onto the ${sfx === 'A' ? 'BO' : 'BR'} plate — refused, naming plate, piece and both classes`, said(e, fx.plateCode[to], fx.code(sfx), `need E350 ${sfx === 'A' ? 'BR' : 'BO'}`, sfx === 'A' ? 'the plate is BO and the piece needs exactly BR' : 'the plate is BR and the piece needs BO.'), textOf(e));
    }
    const text = D.makeNestDxf({ plate: { length: 6000, width: 2000 }, parts: [0, 1].map((i) => ({ rect: { length: fx.want.A.len, width: fx.want.A.wid }, x: 50 + i * 1300, y: 50, label: fx.code('A') })) });
    const r = await U.uploadNestFiles(conn, c, fx.lineId, { files: [{ filename: `${fx.tag}-X1_12mm_6000x2000.dxf`, file: Buffer.from(text, 'latin1').toString('base64'), plateCode: fx.plateCode.P12O }] });
    const errs = r.files.flatMap((f) => f.errors ?? []);
    ok('upload: BR pieces on the BO plate — PART_WRONG_IMPACT, cannot be saved', errs.some((x) => x.code === 'PART_WRONG_IMPACT' && x.message.includes(fx.code('A')) && x.message.includes(fx.plateCode.P12O)) && r.canSave === false, J(errs.map((x) => x.message)));
  }

  section("1b. 'warn' (a company's choice): the check is said, nothing refused, the AI's plates not narrowed");
  {
    await F.setPlateRules(conn, COMPANY, { gradeRule: 'warn' });
    const p = await plan();
    const g12 = p.groups.find((g) => g.thickness === 12);
    ok('no split by class; both 12 mm plates are candidates; no piece refused for its class', p.groups.filter((g) => g.thickness === 12).length === 1 && g12.key === `12|E350|${fx.MS.toUpperCase()}` && [fx.plates.P12R, fx.plates.P12O].every((id) => g12.candidates.some((x) => x.plateItemId === id)) && !p.problems.some((t) => /impact class/.test(t)), J([p.groups.map((g) => g.key), g12?.candidates]));
    const tampered = structuredClone(p);
    for (const g of tampered.groups) for (const n of g.nests) if (n.thickness === 12) { n.plateItemId = fx.plates.P12R; n.plateCode = fx.plateCode.P12R; }
    // (allowLeftOver: the 20 mm E250 pieces have no plate under any rule but 'higher')
    const out = await N.acceptNesting(conn, c, fx.lineId, tampered, { allowLeftOver: true });
    ok('BO pieces on the BR plate are ACCEPTED; gradeCheck names the mismatch (plate, cut piece, classes) and says it does not block',
      out.lots > 0 && out.gradeCheck.ok === false && out.gradeCheck.rule === 'warn' && (out.gradeCheck.mismatches ?? []).some((m) => m.cutPlateCode === fx.code('B') && m.plateCode === fx.plateCode.P12R && m.need === 'E350 BO') && out.gradeCheck.sentence.includes(fx.code('B')), J(out.gradeCheck));
    await N.clearLots(conn, c, fx.lineId, {});
    const plate62w = { length: 6000, width: 2000 };
    const one = (sfx, x) => ({ rect: { length: fx.want[sfx].len, width: fx.want[sfx].wid }, x, y: 50, label: fx.code(sfx) });
    const text = D.makeNestDxf({ plate: plate62w, parts: [one('B', 50), one('B', 1000)] });
    const r = await U.uploadNestFiles(conn, c, fx.lineId, { files: [{ filename: `${fx.tag}-W1_12mm_6000x2000.dxf`, file: Buffer.from(text, 'latin1').toString('base64'), plateCode: fx.plateCode.P12R }] });
    const f = r.files[0] ?? {};
    ok('upload: BO pieces on the BR plate — no error, a note naming the plate, the cut piece and why', !(f.errors ?? []).some((e) => /IMPACT|GRADE/.test(e.code)) && (f.notes ?? []).some((t) => t.includes('Impact class does not match') && t.includes(fx.plateCode.P12R) && t.includes(fx.code('B')) && t.includes('only warns')), J([f.errors, f.notes]));
  }
  // From here on the blocking rule a company picks in Setup › Cutting.
  await F.setPlateRules(conn, COMPANY, { gradeRule: 'better' });

  /* ───────────── 2 ───────────── */
  section("2. AI plate choice — the rule 'better' (impact equal or better)");
  let planBetter;
  {
    planBetter = await plan();
    const all = nestsOf(planBetter);
    const twelve = all.filter((x) => x.n.thickness === 12);
    ok('the 12 mm BR and BO pieces nest together on the BO plate (the one plate that holds both) — never on the BR plate',
      twelve.length > 0 && twelve.every((x) => x.plate === 'P12O') && twelve.some((x) => x.cuts.includes('B')) && twelve.some((x) => x.cuts.includes('A')), J(twelve.map((x) => [x.plate, x.cuts])));
    ok('the 12 mm steel keeps its key (one class in play per plate: no split)', planBetter.groups.some((g) => g.key === `12|E350|${fx.MS.toUpperCase()}`), J(planBetter.groups.map((g) => g.key)));
    const sixteen = all.filter((x) => x.n.thickness === 16);
    ok('a BR piece only a plate WITHOUT a class can hold: nested on it, and a note says so (check the mill certificate)',
      sixteen.length > 0 && sixteen.every((x) => x.plate === 'P16N') && planBetter.notes.some((t) => t.includes('16 mm E350') && t.includes('E350 BR') && t.includes('state none') && t.includes(fx.plateCode.P16N)), J(planBetter.notes));
    ok('an E250 piece and only E350 plates: refused as before (no catalog plate of that steel)', planBetter.problems.some((t) => t.includes('20 mm') && t.includes('E250')) && all.every((x) => x.n.thickness !== 20), J(planBetter.problems));
  }

  /* ───────────── 3 ───────────── */
  section("3. 'exact': each class on its own plates");
  {
    await F.setPlateRules(conn, COMPANY, { gradeRule: 'exact' });
    const p = await plan();
    const keys = p.groups.map((g) => g.key);
    const all = nestsOf(p);
    ok('the 12 mm steel is split by class: keys …|BR and …|BO', keys.includes(`12|E350|${fx.MS.toUpperCase()}|BR`) && keys.includes(`12|E350|${fx.MS.toUpperCase()}|BO`), J(keys));
    ok('the BR pieces on the BR plate, the BO pieces on the BO plate, nothing else on either',
      all.filter((x) => x.cuts.includes('A')).every((x) => x.plate === 'P12R' && J(x.cuts) === '["A"]') && all.filter((x) => x.cuts.includes('B')).every((x) => x.plate === 'P12O' && J(x.cuts) === '["B"]') && all.some((x) => x.cuts.includes('A')) && all.some((x) => x.cuts.includes('B')), J(all.map((x) => [x.plate, x.cuts])));
    await F.setPlateRules(conn, COMPANY, { gradeRule: 'better' });
  }

  /* ───────────── 4 ───────────── */
  section('4. No plate of the class asked');
  {
    await conn.query("UPDATE cf_master_records SET deleted_at = NOW() WHERE id = ?", [fx.plates.P12O]);
    const p = await plan();
    const all = nestsOf(p);
    const sentence = p.problems.find((t) => t.includes(fx.code('B'))) ?? '';
    ok('the BO pieces are refused in words: no 12 mm plate is E350 BO or better, the 12 mm E350 plates are BR', sentence.includes('cannot be nested') && sentence.includes('E350 BO or better') && sentence.includes('are BR'), J(p.problems));
    ok('…left over with that reason; the BR pieces still nest, on the BR plate', p.groups.some((g) => g.unplaced.some((u) => u.cutPlateId === fx.cut.B && /grade and impact class/.test(u.reason))) && all.filter((x) => x.cuts.includes('A')).every((x) => x.plate === 'P12R') && all.some((x) => x.cuts.includes('A')) && !all.some((x) => x.cuts.includes('B')), J(all.map((x) => [x.plate, x.cuts])));
    await conn.query("UPDATE cf_master_records SET deleted_at = NULL WHERE id = ?", [fx.plates.P12O]);
  }

  /* ───────────── 5 ───────────── */
  section("5. 'higher': a higher grade of the family stands in");
  let planHigher;
  {
    await F.setPlateRules(conn, COMPANY, { gradeRule: 'higher' });
    planHigher = await plan();
    const twenty = nestsOf(planHigher).filter((x) => x.n.thickness === 20);
    ok('the E250 pieces nest on the 20 mm E350 BR plate', twenty.length > 0 && twenty.every((x) => x.plate === 'P20R') && !planHigher.problems.some((t) => t.includes('E250')), J([twenty.map((x) => x.plate), planHigher.problems]));
    await F.setPlateRules(conn, COMPANY, { gradeRule: 'better' });
    const e = await refusal(() => N.acceptNesting(conn, c, fx.lineId, planHigher));
    ok("…and that plan is refused under the default rule (grade is not something a layout may mix)", said(e, 'E250', 'E350', 'Grade is not something a layout may mix'), textOf(e));
  }

  /* ───────────── 6 ───────────── */
  section('6. Accept: a mismatch refused in words, an unknown said');
  {
    // planHigher places every piece (the 20 mm E250 ones on the E350 plate): accepted under 'higher'.
    await F.setPlateRules(conn, COMPANY, { gradeRule: 'higher' });
    const tampered = structuredClone(planHigher);
    for (const g of tampered.groups) for (const n of g.nests) if (n.thickness === 12) { n.plateItemId = fx.plates.P12R; n.plateCode = fx.plateCode.P12R; }
    const t = counting(conn);
    const e = await refusal(() => N.acceptNesting(t.db, c, fx.lineId, tampered));
    ok('the 12 mm plate swapped to the BR plate: refused — naming the plate, the cut piece, its count and both classes',
      said(e, fx.plateCode.P12R, fx.code('B'), 'need E350 BO', 'the plate is BR and the piece needs BO or better', 'BR (room temperature)') && !said(e, `${fx.code('A')} need`), textOf(e));
    const out = await N.acceptNesting(conn, c, fx.lineId, planHigher);
    ok('the AI plan is accepted; gradeCheck says the 16 mm plate states no class (pieces named), the BR pieces sit on a better plate, the E250 pieces on a higher grade',
      out.lots > 0 && out.gradeCheck?.ok === true && out.gradeCheck.unknown.some((u) => u.cutPlateCode === fx.code('C') && u.pieces === 2) && out.gradeCheck.substitutes.some((s) => s.cutPlateCode === fx.code('A') && s.substitute === 'impact') && out.gradeCheck.substitutes.some((s) => s.cutPlateCode === fx.code('D') && s.substitute === 'grade') && /check the mill certificate/.test(out.gradeCheck.sentence), J(out.gradeCheck));
    await F.setPlateRules(conn, COMPANY, { gradeRule: 'exact' });
    const e2 = await refusal(() => N.acceptNesting(conn, c, fx.lineId, planHigher));
    ok("'exact': the same plan is refused — the BR pieces on the BO plate", said(e2, fx.code('A'), 'need E350 BR', 'exactly BR'), textOf(e2));
    await F.setPlateRules(conn, COMPANY, { gradeRule: 'better' });
    await N.clearLots(conn, c, fx.lineId, {});
  }

  /* ───────────── 7 ───────────── */
  section('7. Upload (DXF)');
  const plate62 = { length: 6000, width: 2000 };
  const dxf = (name, parts) => { const text = D.makeNestDxf({ plate: plate62, parts }); return { filename: name, file: Buffer.from(text, 'latin1').toString('base64') }; };
  const rect = (sfx, x, y) => ({ rect: { length: fx.want[sfx].len, width: fx.want[sfx].wid }, x, y, label: fx.code(sfx) });
  const upload = (files, opts = {}) => U.uploadNestFiles(conn, c, fx.lineId, { files, ...opts });
  {
    const bOnBR = { ...dxf(`${fx.tag}-G1_12mm_6000x2000.dxf`, [rect('B', 50, 50), rect('B', 1000, 50), rect('B', 1950, 50), rect('B', 2900, 50)]), plateCode: fx.plateCode.P12R };
    const r = await upload([bOnBR]);
    const errs = r.files.flatMap((f) => f.errors ?? []);
    const imp1 = errs.find((x) => x.code === 'PART_WRONG_IMPACT');
    ok('BO pieces on the BR plate named in the request: PART_WRONG_IMPACT, naming the cut piece, the plate and both classes; it cannot be saved',
      !!imp1 && imp1.message.includes(fx.code('B')) && imp1.message.includes(fx.plateCode.P12R) && imp1.message.includes('needs E350 BO') && imp1.message.includes('is E350 BR') && r.canSave === false, J(errs.map((x) => x.message)));
    const aOnBO = { ...dxf(`${fx.tag}-G2_12mm_6000x2000.dxf`, [rect('A', 50, 50), rect('A', 1300, 50), rect('A', 2550, 50), rect('A', 3800, 50)]), plateCode: fx.plateCode.P12O };
    const r2 = await upload([aOnBO]);
    ok('BR pieces on the BO plate pass (a better class)', !r2.files.flatMap((f) => f.errors ?? []).some((x) => /IMPACT|GRADE/.test(x.code)), J(r2.files.flatMap((f) => f.errors ?? [])));
    const mixed = dxf(`${fx.tag}-G3_12mm_6000x2000.dxf`, [rect('A', 50, 50), rect('A', 1300, 50), rect('B', 2550, 50), rect('B', 3500, 50)]);
    const r3 = await upload([mixed]);
    const f3 = r3.files[0] ?? {};
    ok('a nest of BR and BO pieces of a size two plates come in finds the ONE that holds both (the BO plate) by itself', f3.plate?.code === fx.plateCode.P12O && !(f3.errors ?? []).length, J([f3.plate, f3.errors]));
  }

  /* ───────────── 8 ───────────── */
  section('8. The Compare tab carries the grade check of the uploaded side');
  {
    const saveFiles = [
      { ...dxf(`${fx.tag}-H1_12mm_6000x2000.dxf`, [rect('A', 50, 50), rect('A', 1300, 50), rect('A', 2550, 50), rect('A', 3800, 50), rect('B', 50, 600), rect('B', 1000, 600), rect('B', 1950, 600), rect('B', 2900, 600)]), plateCode: fx.plateCode.P12O },
    ];
    const saved = await upload(saveFiles, { dryRun: false, force: true });
    ok('an upload of the 12 mm pieces on the BO plate saves', saved.applied === true, saved.message);
    const cmp = await C.getCompare(conn, COMPANY, fx.lineId, {});
    ok('GET compare: uploaded.gradeCheck ok, the BR pieces on a better plate', cmp.uploaded?.gradeCheck?.ok === true && cmp.uploaded.gradeCheck.substitutes.some((s) => s.cutPlateCode === fx.code('A')), J(cmp.uploaded?.gradeCheck));
    await F.setPlateRules(conn, COMPANY, { gradeRule: 'exact' });
    const cmp2 = await C.getCompare(conn, COMPANY, fx.lineId, {});
    const mm = cmp2.uploaded?.gradeCheck?.mismatches ?? [];
    ok("'exact': the same saved plate reads as a mismatch, naming the plate and the BR cut piece", cmp2.uploaded?.gradeCheck?.ok === false && mm.some((m) => m.cutPlateCode === fx.code('A') && m.plateCode === fx.plateCode.P12O && m.pieces === 4) && cmp2.uploaded.gradeCheck.sentence.includes(fx.code('A')), J(cmp2.uploaded?.gradeCheck));
    await F.setPlateRules(conn, COMPANY, { gradeRule: 'better' });
  }

  /* ───────────── 9 ───────────── */
  section('9. The setting');
  {
    const t = counting(conn);
    const rows = await N.cutSettingRows(t.db, COMPANY);
    ok('the grade rule and the custom-plate setting ride on the cut-settings read: ONE statement', t.tally.n === 1 && rows.gradeRule === 'better' && rows.customPlates === null, J([t.tally.n, rows.gradeRule, rows.customPlates]));
    const saved = await S.saveShopRules(conn, c, { gradeRule: 'exact' });
    ok('Setup › Cutting saves it and reads it back (with the rules and the order of classes)', saved.gradeRule === 'exact' && saved.plateSchema === true && J(saved.gradeRules) === J(['warn', 'better', 'exact', 'higher']) && /BR/.test(saved.impactOrder), J([saved.gradeRule, saved.gradeRules]));
    ok('…and nesting reads it', (await N.cutSettingRows(conn, COMPANY)).gradeRule === 'exact');
    const bad = await refusal(() => S.saveShopRules(conn, c, { gradeRule: 'sometimes' }));
    ok('a rule that is not one of the three is refused in words', said(bad, 'Grade rule: one of warn, better, exact, higher', 'default (exact)'), textOf(bad));
    const back = await S.saveShopRules(conn, c, { gradeRule: null });
    ok("blank = the default ('exact') again", back.gradeRule === null && (await N.cutSettingRows(conn, COMPANY)).gradeRule === 'exact');
  }
} catch (e) {
  failed += 1; fails.push(`crashed: ${e.message}`);
  console.log(`  CRASH  ${e.stack}`);
} finally {
  try { await conn.rollback(); } catch { /* gone */ }
  detachNodeCache(conn);
  conn.release();
}

section('10. Nothing survived');
{
  const after = await counts();
  const diff = after.filter((a) => Number(a.n) !== Number(before.find((b) => b.name === a.name)?.n));
  ok('every cf_ table counts what it did before (rolled back)', diff.length === 0, J(diff));
  const [[kepl1]] = await pool.query('SELECT COUNT(*) n FROM cf_production_releases WHERE order_line_id = ? AND deleted_at IS NULL', [KEPL_LINE]);
  ok('line 923 is not released by this suite', Number(kepl1.n) === Number(kepl0.n));
  const [[settings1]] = await pool.query('SELECT nest_grade_rule, nest_custom_plates FROM cf_company_settings WHERE company_id = ?', [COMPANY]);
  ok("the company's §90 settings are what they were", J(settings1 ?? null) === J(settings0 ?? null));
}
await pool.end();
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log(`FAILED: ${fails.join(' | ')}`); process.exit(1); }
