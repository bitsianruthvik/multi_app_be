/**
 * standard-import-all.mjs — every finished standard set under TM/drawing_bom/out at once: a DRY RUN of each (the plan
 * standard-import.mjs prints, one line per set) and ONE summary — rows, parts, weight against bom.json, the NEW
 * definitions each would create, what it cannot map — and the union of all new definitions across the sets.
 * (services/standardDrawingService.importStandard; format TM/drawing_bom/out/IMPORT_FORMAT.md)
 *
 *   cd multi_app_be
 *   node scripts/cf_kepl/standard-import-all.mjs --company 2                 dry run, read-only
 *   node scripts/cf_kepl/standard-import-all.mjs --company 2 --apply         each set in its OWN transaction, in order;
 *                                                                            stops at the first failure
 *        [--sets RDSO_11751R3,RDSO_1623]   only these (default: the finished sets below)
 *        [--scan]                          every folder with a bom.json, not only the finished list
 *        [--out <folder>]                  default ../drawing_bom/out
 *        [--user <id>] [--prod]            as standard-import.mjs (--prod: DB_* from TM/.env.tidb)
 *        [--section-class BR]              as standard-import.mjs: the impact class of the section bars filled on --apply
 *
 * A set whose bom.json fails validation (schema, tree, the tree's quantities, a DXF it names that is missing) is
 * skipped and the reason said. A set already imported (same number) is reported "already there" and never written
 * twice. In --apply the catalog is read again before each set, so a definition one set creates is reused by the next.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const COMPANY = Number(arg('company'));
const APPLY = process.argv.includes('--apply');
const OUT = path.resolve(arg('out') ?? path.join(__dir, '..', '..', '..', 'drawing_bom', 'out'));
/** Finished sets, in the order they are applied (coordinator, 2026-10-17). */
const FINISHED = ['RDSO_11751R3', 'RDSO_11753R3', 'RDSO_11754R3', 'RDSO_1623', 'RDSO_1569R', 'RDSO_11761R1', 'RDSO_11762R1', 'RDSO_11763R1',
  'RDSO_11765', 'RDSO_11766', 'RDSO_11767', 'RDSO_CBS-0055', 'RDSO_1581R', 'RDSO_516'];
if (!Number.isInteger(COMPANY) || COMPANY <= 0) {
  console.error('Usage: node scripts/cf_kepl/standard-import-all.mjs --company <id> [--apply] [--sets A,B] [--scan] [--out <folder>] [--user <id>] [--prod]');
  process.exit(2);
}
if (process.argv.includes('--prod')) {
  const env = {};
  fs.readFileSync(path.join(__dir, '..', '..', '..', '.env.tidb'), 'utf8').split('\n').forEach((l) => {
    l = l.trim(); if (!l || l.startsWith('#')) return;
    const [k, ...r] = l.split('='); env[k.trim()] = r.join('=').trim();
  });
  Object.assign(process.env, { DB_HOST: env.DB_HOST, DB_PORT: env.DB_PORT ?? '4000', DB_USER: env.DB_USER, DB_PASSWORD: env.DB_PASSWORD, DB_NAME: env.DB_NAME, DB_SSL: 'true' });
}

const BE = path.join(__dir, '..', '..');
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
await imp('apps/cf_erp/services/codegenProvider.js');
const STD = await imp('apps/cf_erp/services/standardDrawingService.js');

const found = fs.readdirSync(OUT).filter((d) => fs.existsSync(path.join(OUT, d, 'bom.json')));
const wanted = arg('sets') ? arg('sets').split(',').map((s) => s.trim()).filter(Boolean) : process.argv.includes('--scan') ? found : FINISHED;
const notListed = found.filter((d) => !wanted.includes(d));

/** Why a set cannot be imported, or null. */
function validate(dir) {
  let bom;
  try { bom = JSON.parse(fs.readFileSync(path.join(dir, 'bom.json'), 'utf8')); } catch (e) { return { why: `bom.json does not read: ${e.message}` }; }
  if (bom.schema !== 'rdso-standard-drawing-bom/1') return { why: `schema is ${bom.schema ?? '(none)'}, not rdso-standard-drawing-bom/1` };
  if (!bom.drawing?.number) return { why: 'no drawing.number' };
  if (!Array.isArray(bom.items) || !bom.items.length) return { why: 'no items[]' };
  if (!bom.assembly?.children?.length) return { why: 'no assembly tree' };
  if (bom.checks?.treeQuantitiesMatchItems !== true) return { why: `the tree's quantities do not match items[] (${JSON.stringify(bom.checks?.treeMismatches ?? []).slice(0, 200)})` };
  const ids = new Set(bom.items.map((i) => i.id));
  const leaves = []; const walk = (n) => { if (n.item != null) leaves.push(n.item); (n.children ?? []).forEach(walk); }; walk(bom.assembly);
  const unknown = leaves.filter((x) => !ids.has(x));
  if (unknown.length) return { why: `the tree names items not in items[]: ${[...new Set(unknown)].join(', ')}` };
  const dxfDir = path.join(dir, 'dxf');
  const missing = bom.items.filter((i) => i.dxf && !fs.existsSync(path.join(dxfDir, i.dxf))).map((i) => i.dxf);
  if (missing.length) return { why: `DXF named but missing: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ` and ${missing.length - 5} more` : ''}` };
  const files = fs.existsSync(dxfDir) ? fs.readdirSync(dxfDir).filter((f) => /\.dxf$/i.test(f)).map((name) => ({ name, text: fs.readFileSync(path.join(dxfDir, name)).toString('latin1') })) : [];
  return { bom, files };
}

const conn = await pool.getConnection();
let code = 0;
const results = [];
try {
  const [[db]] = await conn.query('SELECT DATABASE() AS d');
  const [[co]] = await conn.query('SELECT id, name FROM companies WHERE id = ?', [COMPANY]);
  if (!co) throw new Error(`No company ${COMPANY}.`);
  const userId = arg('user') ? Number(arg('user')) : ((await conn.query('SELECT id FROM users WHERE company_id = ? ORDER BY id LIMIT 1', [COMPANY]))[0][0]?.id ?? null);
  const c = { companyId: COMPANY, userId };
  // DB_HOST, not @@hostname: TiDB Cloud answers "localhost" for that.
  console.log(`${APPLY ? 'APPLY' : 'DRY RUN (read-only)'} — database ${db.d} at ${process.env.DB_HOST ?? '?'}, company ${co.id} ${co.name}, ${wanted.length} sets from ${OUT}\n`);
  // THE SETUP STEP first, in its own transaction (options the standards need, labels put right). A dry run says what it would do.
  if (APPLY) await conn.beginTransaction();
  const setup = await STD.importSetup(conn, c, { apply: APPLY });
  if (APPLY) await conn.commit();
  console.log(`Setup${APPLY ? '' : ' (would do)'}: ${setup.actions.length ? '' : 'nothing to do'}`);
  for (const a of setup.actions) console.log(`  ${a.problem ? 'PROBLEM: ' : ''}${a.what}${a.done ? ' — done' : ''}`);
  console.log('');
  let catalog = APPLY ? null : await STD.importCatalog(conn, COMPANY);
  for (const set of wanted) {
    const dir = path.join(OUT, set);
    const r = { set };
    results.push(r);
    if (!fs.existsSync(path.join(dir, 'bom.json'))) { r.skipped = 'no bom.json'; continue; }
    const v = validate(dir);
    if (v.why) { r.skipped = v.why; continue; }
    try {
      if (APPLY) { catalog = await STD.importCatalog(conn, COMPANY); await conn.beginTransaction(); }
      const out = await STD.importStandard(conn, c, { bom: v.bom, files: v.files, apply: false, catalog });
      const rep = out.report;
      Object.assign(r, {
        number: rep.standard.number, alreadyThere: rep.standard.alreadyThere, rows: rep.totals.rows, parts: rep.totals.parts,
        steelKg: rep.totals.steelKg, bomSteelKg: rep.totals.bomSteelKg == null ? null : Number(rep.totals.bomSteelKg) + Number(rep.totals.bomNonSteelKg ?? 0), newDefinitions: rep.newDefinitions.map((d) => d.name),
        problems: rep.problems, fallbacks: rep.fallbacks.length, files: `${rep.files.filter((f) => f.read).length}/${rep.files.length}`,
        unmapped: rep.rows.filter((x) => x.to === '(left out)').length,
        grades: rep.grades, info: rep.info, definitionValues: rep.definitionValues,
      });
      if (APPLY) {
        if (rep.standard.alreadyThere) { await conn.rollback(); r.applied = 'already there — not written'; continue; }
        const done = await STD.importStandard(conn, c, { bom: v.bom, files: v.files, apply: true, catalog });
        // What the drawing settles but the mapping left empty (lengths, girder type, holes, surface, bars, flows).
        const { fillImportedGaps } = await imp('apps/cf_erp/services/standardGapFixService.js');
        done.report.gapFill = await fillImportedGaps(conn, c, { standardId: done.standardId, bom: v.bom, sectionClass: arg('section-class') ? String(arg('section-class')).toUpperCase() : null });
        await conn.commit();
        r.applied = `standard #${done.report.written.standardId}, version #${done.report.written.versionId}; filled from the drawing: ${done.report.gapFill.values} values, ${done.report.gapFill.sections} section bars, ${done.report.gapFill.flows} flows`;
        r.created = done.report.written.newDefinitions.map((d) => `${d.name} (#${d.id} ${d.code ?? ''})`.trim());
      }
    } catch (err) {
      if (APPLY) { try { await conn.rollback(); } catch { /* none open */ } }
      r.failed = `${err.message}${err.problems ? ` — ${err.problems.join('; ')}` : ''}`;
      if (APPLY) { code = 1; break; }
    }
  }
  printSummary(results);
} catch (err) {
  code = 1;
  console.error(`\nSTOPPED — ${err.message}`);
} finally {
  conn.release();
  await pool.end();
}
process.exit(code);

function printSummary(rs) {
  const pad = (s, n) => String(s ?? '').padEnd(n);
  const kg = (n) => (n == null ? '—' : Math.round(Number(n)).toLocaleString('en-US'));
  console.log(`${pad('Set', 15)} ${pad('Number', 22)} ${pad('Rows', 5)} ${pad('Parts', 6)} ${pad('Steel kg', 9)} ${pad('bom.json*', 9)} ${pad('Δ kg', 6)} ${pad('Files', 6)} New definitions / notes`);
  for (const r of rs) {
    if (r.skipped) { console.log(`${pad(r.set, 15)} SKIPPED — ${r.skipped}`); continue; }
    if (r.failed && r.rows == null) { console.log(`${pad(r.set, 15)} FAILED — ${r.failed}`); continue; }
    const d = r.bomSteelKg == null ? '—' : (Number(r.steelKg) - Number(r.bomSteelKg)).toFixed(1);
    const notes = [r.newDefinitions.length ? `NEW: ${r.newDefinitions.join(', ')}` : 'no new',
      r.unmapped ? `${r.unmapped} unmapped` : null, r.fallbacks ? `${r.fallbacks} second-choice names` : null,
      r.alreadyThere ? `already there (#${r.alreadyThere})` : null, r.applied ?? null, r.failed ? `FAILED: ${r.failed}` : null].filter(Boolean).join(' · ');
    console.log(`${pad(r.set, 15)} ${pad(r.number, 22)} ${pad(r.rows, 5)} ${pad(r.parts, 6)} ${pad(kg(r.steelKg), 9)} ${pad(kg(r.bomSteelKg), 9)} ${pad(d, 6)} ${pad(r.files, 6)} ${notes}`);
    const g = r.grades;
    if (g) {
      const parts = [g.asWritten && `${g.asWritten} as written`, g.eNamed && `${g.eNamed} E-grade named`, g.legacyE250 && `${g.legacyE250} old IS grade → E250`,
        g.impactBR && `${g.impactBR} impact BR`, g.impactA && `${g.impactA} impact A`, g.legacyNoClass && `${g.legacyNoClass} IS 2062 no class letter (E250, no impact class)`,
        g.bronze && `${g.bronze} phosphor bronze → MATERIAL PB`, g.missed && `${g.missed} NOT MAPPED`].filter(Boolean);
      console.log(`${' '.repeat(16)}grades: ${parts.join(' · ') || 'none'}`);
    }
    for (const x of r.definitionValues ?? []) console.log(`${' '.repeat(16)}definition value: ${x}`);
    for (const x of r.info ?? []) console.log(`${' '.repeat(16)}note: ${x}`);
    for (const p of r.problems ?? []) console.log(`${' '.repeat(16)}- ${p}`);
  }
  const union = new Map();
  for (const r of rs) for (const n of r.newDefinitions ?? []) { if (!union.has(n)) union.set(n, []); union.get(n).push(r.set); }
  console.log(`\nNEW definitions across all sets (${union.size}):`);
  for (const [n, sets] of union) console.log(`  + ${n} — ${sets.join(', ')}`);
  if (!union.size) console.log('  none');
  if (notListed.length) console.log(`\nOther folders with a bom.json, not in this run: ${notListed.join(', ')} (--scan includes them)`);
  console.log(APPLY ? '' : '\nNothing written. --apply writes each set in its own transaction.');
}
