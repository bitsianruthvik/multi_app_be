/**
 * span-definitions.mjs — every structure's top row on the span definition of its own kind (user, 2026-11-07: the bow
 * strings SO260021 / SO260025 had been given "Composite girder span" because the catalog had no bow string span; "create
 * all the relevant spans like bowstring or other types of girders").
 *
 * 1. The span definitions the importer now asks for (lib/standardImport.js spanCandidates) and the catalog lacks are made
 *    exactly as an import makes them (standardDrawingService.createNewDefinitions: filed beside the nearest, short-named,
 *    the sibling's rules — and, a span beside a span, its flow, HSN, values and wait rules). One commit per definition.
 * 2. For every drawing set in drawing_bom/out/<SET>/bom.json whose standard is in the catalog: the root row the importer
 *    would now give it. Where the standard's version roots and its live order lines' roots are on another definition,
 *    they move (source definition, the row's name when it was the definition's, class, flow when it was the definition's).
 *    One commit per standard, with its lines, so a line never differs from its standard between two commits.
 *    Lines of a locked order (closed, lost, cancelled, revised) or a locked line are left alone and said.
 *
 * DRY RUN by default: everything is done in a transaction and rolled back, and what would change is printed.
 *   node scripts/cf_kepl/span-definitions.mjs --company 30005 [--prod] [--apply] [--user <id>] [--only BSG_49M4,SHIVAKYA_72M]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
const __dir = path.dirname(fileURLToPath(import.meta.url));
const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const COMPANY = Number(arg('company')); if (!COMPANY) { console.error('Usage: --company <id> [--prod] [--apply]'); process.exit(2); }
const APPLY = process.argv.includes('--apply');
const ONLY = arg('only') ? new Set(String(arg('only')).split(',').map((s) => s.trim())) : null;
if (process.argv.includes('--prod')) {
  const env = {}; fs.readFileSync(path.join(__dir, '..', '..', '..', '.env.tidb'), 'utf8').split('\n').forEach((l) => { l = l.trim(); if (!l || l.startsWith('#')) return; const [k, ...r] = l.split('='); env[k.trim()] = r.join('=').trim(); });
  Object.assign(process.env, { DB_HOST: env.DB_HOST, DB_PORT: env.DB_PORT ?? '4000', DB_USER: env.DB_USER, DB_PASSWORD: env.DB_PASSWORD, DB_NAME: env.DB_NAME, DB_SSL: 'true' });
}
const imp = (p) => import(pathToFileURL(path.join(__dir, '..', '..', p)).href);
const { pool } = await imp('db.js');
await imp('apps/cf_erp/services/codegenProvider.js');   // the code generator's entities (a new definition's code)
const STD = await imp('apps/cf_erp/services/standardDrawingService.js');
const { planImport, normName, SPAN_KINDS } = await imp('apps/cf_erp/lib/standardImport.js');
const { LOCKED_ORDER_STATUSES } = await imp('apps/cf_erp/services/records.js');
const OUT = path.join(__dir, '..', '..', '..', 'drawing_bom', 'out');

const sets = fs.readdirSync(OUT).filter((d) => fs.existsSync(path.join(OUT, d, 'bom.json')) && (!ONLY || ONLY.has(d)))
  .map((d) => ({ set: d, bom: JSON.parse(fs.readFileSync(path.join(OUT, d, 'bom.json'), 'utf8')) }));
const conn = await pool.getConnection();
const say = (s) => console.log(s);
let code = 0;
try {
  const userId = arg('user') ? Number(arg('user')) : ((await conn.query('SELECT id FROM users WHERE company_id = ? ORDER BY id LIMIT 1', [COMPANY]))[0][0]?.id ?? null);
  const c = { companyId: COMPANY, userId };
  say(`${APPLY ? 'APPLY' : 'DRY RUN (rolled back)'} — company ${COMPANY}, ${sets.length} drawing sets`);
  // --apply: one transaction per step, committed. A dry run: ONE transaction for everything (step 2 needs step 1's
  // definitions), rolled back at the end.
  if (!APPLY) await conn.beginTransaction();
  const doStep = async (label, fn) => {
    if (!APPLY) { try { return await fn(); } catch (e) { throw new Error(`${label}: ${e.message}`); } }
    await conn.beginTransaction();
    try { const r = await fn(); await conn.commit(); return r; } catch (e) { await conn.rollback(); throw new Error(`${label}: ${e.message}`); }
  };

  // ---- 1. the span definitions the sets ask for -------------------------------------------------------------------
  let catalog = await STD.importCatalog(conn, COMPANY);
  const spanNames = new Set(SPAN_KINDS.map((k) => k.name));
  const wanted = new Map();   // name -> { nd, sets }
  for (const s of sets) {
    const p = planImport(s.bom, catalog);
    for (const nd of p.newDefinitions) if (spanNames.has(nd.name)) { if (!wanted.has(nd.name)) wanted.set(nd.name, { nd, sets: [] }); wanted.get(nd.name).sets.push(s.set); }
  }
  const dryMade = new Map();
  for (const [name, w] of wanted) {
    say(`\nNEW DEFINITION "${name}" (asked by ${w.sets.join(', ')}); nearest: ${w.nd.nearest ? `${w.nd.nearest.name} (${w.nd.nearest.code}, ${w.nd.nearest.why}, telling ${w.nd.nearest.telling})` : 'none'}`);
    const made = await doStep(name, async () => {
      const m = await STD.createNewDefinitions(conn, c, catalog, [w.nd]);
      const d = m.get(name);
      const [[cls]] = await conn.query('SELECT name FROM cf_classification_nodes WHERE id = ?', [d.classification_id]);
      const [rules] = await conn.query(`SELECT s.code, a.is_required FROM cf_spec_assignments a JOIN cf_specifications s ON s.id = a.specification_id
        WHERE a.company_id = ? AND a.subject_type = 'master' AND a.subject_id = ? AND a.deleted_at IS NULL`, [COMPANY, d.id]);
      const [[m2]] = await conn.query('SELECT m.short_name, m.default_flow_id, dd.hsn_code, dd.gst_rate FROM cf_master_records m JOIN cf_definition_details dd ON dd.master_id = m.id WHERE m.id = ?', [d.id]);
      say(`  ${APPLY ? 'made' : 'would make'}: id ${d.id}${APPLY ? '' : ' (rolled back)'}, code ${d.code}, short ${m2.short_name}, class ${cls?.name} (${d.classification_id}), flow ${m2.default_flow_id ?? '-'}, HSN ${m2.hsn_code ?? '-'} ${m2.gst_rate ?? ''}`);
      say(`  rules from ${d.rulesFrom ?? '-'}: ${rules.map((r) => `${r.code}${r.is_required ? ' (required)' : ''}`).join(', ') || 'none'}; setup ${JSON.stringify(d.setup)}`);
      return d;
    });
    dryMade.set(name, made);
  }
  if (dryMade.size) catalog = await STD.importCatalog(conn, COMPANY);

  // ---- 2. each standard's root rows, and its live lines' ----------------------------------------------------------
  const defById = new Map(catalog.defs.map((d) => [Number(d.id), d]));
  const sig = (id) => STD.designSignature(conn, COMPANY, id);
  let moved = 0; let same = 0; let left = 0;
  for (const s of sets) {
    const p = planImport(s.bom, catalog);
    const sid = catalog.standards.get(String(p.standard.number).toLowerCase());
    if (!sid) continue;
    const want = p.rows[0]?.def;
    if (!want?.id) { say(`\n${s.set} (standard ${sid}): the importer asks for "${want?.new ?? want?.name}", not in the catalog — left.`); left++; continue; }
    const [vers] = await conn.query('SELECT id, version_no, root_item_id FROM cf_standard_drawing_versions WHERE company_id = ? AND standard_id = ? AND deleted_at IS NULL ORDER BY version_no', [COMPANY, sid]);
    const [lines] = await conn.query(`SELECT l.id, l.item_id, l.locked_at, l.standard_version_id, l.standard_kept_sig, o.code, o.status FROM cf_sales_order_lines l JOIN cf_sales_orders o ON o.id = l.order_id AND o.deleted_at IS NULL
      WHERE l.company_id = ? AND l.standard_id = ? AND l.deleted_at IS NULL`, [COMPANY, sid]);
    const roots = [...vers.map((v) => ({ id: Number(v.root_item_id), what: `version ${v.version_no}` })),
      ...lines.map((l) => ({ id: Number(l.item_id), what: `${l.code} line ${l.id}`, line: l }))].filter((r) => r.id);
    const [items] = roots.length ? await conn.query(`SELECT m.id, m.name, m.classification_id, m.default_flow_id, i.source_definition_id FROM cf_master_records m JOIN cf_item_details i ON i.master_id = m.id WHERE m.id IN (?)`, [roots.map((r) => r.id)]) : [[]];
    const itemOf = new Map(items.map((i) => [Number(i.id), i]));
    const toMove = []; const skipped = [];
    for (const r of roots) {
      const it = itemOf.get(r.id);
      if (!it || Number(it.source_definition_id) === Number(want.id)) continue;
      if (r.line && (r.line.locked_at || LOCKED_ORDER_STATUSES.has(r.line.status))) { skipped.push(`${r.what} (${r.line.locked_at ? 'line locked' : `order ${r.line.status}`})`); continue; }
      toMove.push({ ...r, it });
    }
    if (!toMove.length && !skipped.length) { same++; continue; }
    const target = defById.get(Number(want.id)) ?? want;
    say(`\n${s.set} — standard ${sid} ${p.standard.number}: the root is a "${target.name}" (${target.code})`);
    for (const x of skipped) say(`  LEFT ${x}`);
    if (!toMove.length) { left++; continue; }
    await doStep(s.set, async () => {
      const before = new Map();
      for (const l of lines) before.set(l.id, { line: await sig(l.item_id), ver: await sig(vers.find((v) => Number(v.id) === Number(l.standard_version_id))?.root_item_id) });
      for (const r of toMove) {
        const old = defById.get(Number(r.it.source_definition_id));
        const [[oldDef]] = await conn.query('SELECT name, classification_id, default_flow_id FROM cf_master_records WHERE id = ?', [r.it.source_definition_id]);
        const [[newDef]] = await conn.query('SELECT name, classification_id, default_flow_id FROM cf_master_records WHERE id = ?', [want.id]);
        const name = normName(r.it.name) === normName(oldDef?.name) ? newDef.name : r.it.name;
        const flow = r.it.default_flow_id == null || Number(r.it.default_flow_id) === Number(oldDef?.default_flow_id) ? (newDef.default_flow_id ?? r.it.default_flow_id) : r.it.default_flow_id;
        await conn.query('UPDATE cf_item_details SET source_definition_id = ? WHERE company_id = ? AND master_id = ?', [want.id, COMPANY, r.id]);
        await conn.query('UPDATE cf_master_records SET name = ?, classification_id = ?, default_flow_id = ? WHERE company_id = ? AND id = ?', [name, newDef.classification_id, flow, COMPANY, r.id]);
        // What the row must hold under each definition (its own rules and its class's), and what it holds.
        const need = async (defId, clsId) => (await conn.query(`SELECT DISTINCT s.code FROM cf_spec_assignments a JOIN cf_specifications s ON s.id = a.specification_id
          WHERE a.company_id = ? AND a.deleted_at IS NULL AND a.is_required = 1 AND ((a.subject_type = 'master' AND a.subject_id = ?) OR (a.subject_type = 'classification' AND a.subject_id = ?))`, [COMPANY, defId, clsId]))[0].map((x) => x.code);
        const [held] = await conn.query(`SELECT s.code FROM cf_spec_values v JOIN cf_specifications s ON s.id = v.specification_id WHERE v.company_id = ? AND v.subject_type = 'master' AND v.subject_id = ? AND v.deleted_at IS NULL
          AND (v.value_number IS NOT NULL OR v.value_text IS NOT NULL OR v.option_id IS NOT NULL OR v.value_bool IS NOT NULL OR v.value_date IS NOT NULL)`, [COMPANY, r.id]);
        const has = new Set(held.map((h) => h.code));
        const missBefore = (await need(r.it.source_definition_id, r.it.classification_id)).filter((k) => !has.has(k));
        const missAfter = (await need(want.id, newDef.classification_id)).filter((k) => !has.has(k));
        const newlyMissing = missAfter.filter((k) => !missBefore.includes(k));
        say(`  ${APPLY ? 'MOVED' : 'would move'} ${r.what} row ${r.id}: ${old?.name ?? oldDef?.name} (${r.it.source_definition_id}) → ${newDef.name} (${want.id}); name "${r.it.name}" → "${name}", class ${r.it.classification_id} → ${newDef.classification_id}, flow ${r.it.default_flow_id ?? '-'} → ${flow ?? '-'}; required values missing before [${missBefore.join(', ')}], after [${missAfter.join(', ')}]${newlyMissing.length ? ` NEWLY MISSING ${newlyMissing.join(', ')}` : ''}`);
        if (newlyMissing.length) throw new Error(`${r.what}: the new definition asks for values the row lacks (${newlyMissing.join(', ')}) — nothing moved.`);
      }
      for (const l of lines) {
        const b = before.get(l.id);
        const after = { line: await sig(l.item_id), ver: await sig(vers.find((v) => Number(v.id) === Number(l.standard_version_id))?.root_item_id) };
        // A line someone kept as edited stays kept.
        if (l.standard_kept_sig && l.standard_kept_sig === b.line) await conn.query('UPDATE cf_sales_order_lines SET standard_kept_sig = ? WHERE company_id = ? AND id = ?', [after.line, COMPANY, l.id]);
        const st = (x) => (x.line === x.ver ? 'same as its standard' : 'differs from its standard');
        say(`  ${l.code} line ${l.id}: before ${st(b)}, after ${st(after)}`);
        if ((b.line === b.ver) !== (after.line === after.ver)) throw new Error(`line ${l.id} would change from "${st(b)}" to "${st(after)}" — nothing moved.`);
      }
    });
    moved += toMove.length;
  }
  say(`\n${APPLY ? 'moved' : 'would move'} ${moved} root rows; ${same} standards already right; ${left} left.`);
  if (!APPLY) { await conn.rollback(); say('dry run: rolled back, nothing written.'); }
} catch (e) {
  console.error(`FAILED: ${e.message}`); code = 1;
  if (!APPLY) await conn.rollback().catch(() => {});
} finally {
  conn.release(); await pool.end();
}
process.exit(code);
