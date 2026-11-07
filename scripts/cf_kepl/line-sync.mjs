/**
 * line-sync.mjs — bring a live order line in line with its package's NEW bom.json IN PLACE (2026-11-07): the same line,
 * the same standard, every row that survives kept as it is (record, code placeholder, drawings). Re-import is refused
 * (the standard exists under its number) and a made-up customer revision is not allowed, so the line is edited the way
 * the screens edit it:
 *   1  new marks      pasted (bomChangeService paste — a deep copy of the line's own row) from the most similar row of
 *                     the same definition, then given their mark, sizes and values; a new assembly (OWG SWAY3) is a copy
 *                     of its sibling whose children are edited to the new list. The copy's links to the SOURCE's part
 *                     drawing are taken off (drawingService.removeLink): it gets its own drawing in step 5.
 *   2  values         sizes, marks, grades … that differ, through the values screen's write (orderValuesService via
 *                     bomChangeService 'values'); a line's description (role) and remark (notes) through bomService.
 *   3  quantities     bomChangeService 'quantity'.
 *   4  removals       rows bom.json no longer has, bomChangeService 'remove' (bolt rows are step 6's).
 *      then the line's cut pieces once, as every screen save does (cutPlateService.withCutPieces).
 *   5  drawings       the part DXFs that changed between two commits of drawing_bom (git diff -w), copied to --tmp,
 *                     loaded as the next revision of each part's drawing (partDrawingService.uploadDrawings, as
 *                     part-revisions.mjs), batches of 20; a file equal to the row's live one is skipped.
 *   6  bolts          --bolts: bolts-load.mjs loadBolts with replace (bolt rows that differ removed and added again).
 *   7  standard       --save-standard: the line saved as its standard's next version (standardDrawingService).
 *   8  check          the same comparison again (must be empty), and every row's mark a level or piece of the model.
 * What the line should be is what the importer would make of bom.json today (lib/standardImport.planImport with the
 * tenant's catalog), compared by mark path; a row without a mark (a seismic stopper group) by its definition.
 *
 * DRY RUN BY DEFAULT: every step really done in ONE transaction, the check run on the result, then rolled back.
 * --apply: one transaction per paste, per parent's changes, per removal, per drawing batch, per assembly's bolts,
 * so a lost connection loses one step; running again works the comparison out afresh and skips what is done.
 *   node scripts/cf_kepl/line-sync.mjs --company 30005 --line <id> --set <drawing_bom/out/SET> [--dxf-from <commit>]
 *        [--dxf-to <commit>] [--tmp <folder>] [--bolts] [--save-standard "<note>"] [--prod] [--apply] [--verbose]
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';
const __dir = path.dirname(fileURLToPath(import.meta.url));
const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const COMPANY = Number(arg('company')); const LINE = Number(arg('line')); const SET = arg('set') ? path.resolve(arg('set')) : null;
const APPLY = process.argv.includes('--apply'); const VERBOSE = process.argv.includes('--verbose');
const DXF_FROM = arg('dxf-from'); const DXF_TO = arg('dxf-to') ?? 'HEAD';
const TMP = path.resolve(arg('tmp') ?? os.tmpdir());
const BOLTS = process.argv.includes('--bolts'); const SAVE_NOTE = arg('save-standard');
if (!COMPANY || !LINE || !SET) { console.error('Usage: --company <id> --line <id> --set <drawing_bom/out/SET> [--dxf-from <commit> [--dxf-to <commit>]] [--tmp <dir>] [--bolts] [--save-standard "<note>"] [--prod] [--apply]'); process.exit(2); }
if (process.argv.includes('--prod')) {
  const env = {}; fs.readFileSync(path.join(__dir, '..', '..', '..', '.env.tidb'), 'utf8').split('\n').forEach((l) => { l = l.trim(); if (!l || l.startsWith('#')) return; const [k, ...r] = l.split('='); env[k.trim()] = r.join('=').trim(); });
  Object.assign(process.env, { DB_HOST: env.DB_HOST, DB_PORT: env.DB_PORT ?? '4000', DB_USER: env.DB_USER, DB_PASSWORD: env.DB_PASSWORD, DB_NAME: env.DB_NAME, DB_SSL: 'true' });
}
const imp = (p) => import(pathToFileURL(path.join(__dir, '..', '..', p)).href);
const { pool } = await imp('db.js');
await imp('apps/cf_erp/services/codegenProvider.js');
const { explode, updateLine } = await imp('apps/cf_erp/services/bomService.js');
const { applyBomChanges } = await imp('apps/cf_erp/services/bomChangeService.js');
const { withCutPieces } = await imp('apps/cf_erp/services/cutPlateService.js');
const { uploadDrawings, normMark } = await imp('apps/cf_erp/services/partDrawingService.js');
const { removeLink } = await imp('apps/cf_erp/services/drawingService.js');
const { importCatalog, saveLineToStandard } = await imp('apps/cf_erp/services/standardDrawingService.js');
const { planImport, normName } = await imp('apps/cf_erp/lib/standardImport.js');
const { modelDrawsOfStandard } = await imp('apps/cf_erp/lib/modelLevels.js');
const { loadBolts } = await import(pathToFileURL(path.join(__dir, 'bolts-load.mjs')).href);

const BOM = JSON.parse(fs.readFileSync(path.join(SET, 'bom.json'), 'utf8'));
const log = (...a) => console.log(...a);
const vlog = (...a) => { if (VERBOSE) console.log(...a); };
// The values a row is compared on: what the importer writes on a part. Not WEIGHT: on a line the tenant's formula works
// it out from the sizes (the importer's bom.json weight does not survive the first refresh), so it follows the sizes.
const CODES = ['DRAWING_MARK', 'THICKNESS', 'WIDTH', 'DEPTH', 'LENGTH', 'SECTION_AREA', 'GRADE', 'IMPACT_CLASS', 'MATERIAL'];
const NUM_TOL = { SECTION_AREA: 0.5 };
const near = (a, b, tol = 0.001) => Math.abs(Number(a) - Number(b)) <= tol;
const txt = (s) => String(s ?? '').trim();
const fmt = (v) => (v == null ? '∅' : typeof v === 'number' ? String(Math.round(v * 1000) / 1000) : String(v));

const db = await pool.getConnection();
// --profile: every query counted and timed by its shape and by the code that sent it (to find what makes a step slow).
const PROFILE = process.argv.includes('--profile');
const prof = new Map();
if (PROFILE) {
  for (const fn of ['query', 'execute']) {
    const orig = db[fn].bind(db);
    db[fn] = async (sql, ...rest) => {
      const t0 = performance.now();
      try { return await orig(sql, ...rest); } finally {
        const shape = String(typeof sql === 'string' ? sql : sql?.sql).replace(/\s+/g, ' ').trim().slice(0, 70);
        const who = (new Error().stack.split('\n').slice(2).find((l) => !/node:|line-sync\.mjs:7\d/.test(l)) ?? '').replace(/.*[\\/]([^\\/]+:\d+):\d+\)?$/, '$1');
        const k = `${who} | ${shape}`; const p = prof.get(k) ?? { n: 0, ms: 0 }; p.n++; p.ms += performance.now() - t0; prof.set(k, p);
      }
    };
  }
  process.on('exit', () => {
    const rows = [...prof.entries()].sort((a, b) => b[1].ms - a[1].ms);
    const n = rows.reduce((s, [, p]) => s + p.n, 0), ms = rows.reduce((s, [, p]) => s + p.ms, 0);
    console.log(`\nPROFILE: ${n} queries, ${Math.round(ms / 1000)} s waiting on the database`);
    for (const [k, p] of rows.slice(0, 40)) console.log(`${String(p.n).padStart(6)} ${String(Math.round(p.ms / 1000)).padStart(5)} s  ${k}`);
  });
}
const q = async (sql, p = []) => (await db.query(sql, p))[0];
const report = { pastes: [], values: [], roles: [], notes: [], quantities: [], removals: [], definitions: [], unsupported: [], drawings: [], bolts: null, standard: null, check: null };

/* ------------------------------------------------------------------------------------------------------------------
 * Reading the line as it is
 * ---------------------------------------------------------------------------------------------------------------- */
async function readLine() {
  const [line] = await q(`SELECT l.id, l.order_id, l.line_no, l.item_id, l.quantity, l.locked_at, l.standard_id, o.code, o.status
                            FROM cf_sales_order_lines l JOIN cf_sales_orders o ON o.id = l.order_id WHERE l.company_id = ? AND l.id = ? AND l.deleted_at IS NULL`, [COMPANY, LINE]);
  if (!line) throw new Error(`line ${LINE} not found`);
  const tree = await explode(db, COMPANY, line.item_id, { rootQuantity: Number(line.quantity) });
  const ids = []; (function w(n) { if (n.kind === 'temporary') ids.push(Number(n.id)); n.children.forEach(w); }(tree.root));
  const vals = ids.length ? await q(`SELECT v.subject_id, UPPER(s.code) AS code, v.value_number, v.value_text, v.option_id
                                       FROM cf_spec_values v JOIN cf_specifications s ON s.id = v.specification_id
                                      WHERE v.company_id = ? AND v.subject_type = 'master' AND v.deleted_at IS NULL AND v.subject_id IN (?) AND s.code IN (?)`, [COMPANY, ids, CODES]) : [];
  const V = new Map();
  for (const v of vals) { const id = Number(v.subject_id); if (!V.has(id)) V.set(id, {}); V.get(id)[v.code] = v.option_id != null ? Number(v.option_id) : v.value_number != null ? Number(v.value_number) : v.value_text; }
  const defs = ids.length ? await q('SELECT master_id, source_definition_id FROM cf_item_details WHERE company_id = ? AND master_id IN (?) AND deleted_at IS NULL', [COMPANY, ids]) : [];
  const D = new Map(defs.map((d) => [Number(d.master_id), d.source_definition_id == null ? null : Number(d.source_definition_id)]));
  (function w(n, parent) {
    n.parent = parent; n.vals = V.get(Number(n.id)) ?? {}; n.mark = n.kind === 'temporary' ? (n.vals.DRAWING_MARK ?? null) : null; n.defId = D.get(Number(n.id)) ?? null;
    n.isBolt = !!n.selection && /^bolt set$/i.test(n.selection.name ?? '');
    n.children.forEach((k) => w(k, n));
  }(tree.root, null));
  return { line, root: tree.root };
}

const pathOf = (n) => { const out = []; for (let x = n; x; x = x.parent) out.unshift(x.mark ?? (x.kind === 'temporary' ? `(${x.name})` : x.name)); return out.join('/'); };
const planPath = (r, byKey) => { const out = []; for (let x = r; x; x = x.parentKey ? byKey.get(x.parentKey) : null) out.unshift(x.mark ?? `(${x.def?.name ?? x.role})`); return out.join('/'); };

/* ------------------------------------------------------------------------------------------------------------------
 * What the line should be: the importer's plan of bom.json
 * ---------------------------------------------------------------------------------------------------------------- */
const catalog = await importCatalog(db, COMPANY);
const plan = planImport(BOM, catalog);
const byKey = new Map(plan.rows.map((r) => [r.key, r]));
for (const r of plan.rows) r.kids = [];
for (const r of plan.rows) if (r.parentKey) byKey.get(r.parentKey).kids.push(r);
const planRoot = plan.rows[0];
// A held item (a designer question open, drawing_bom check level "held") carries a remark on its row, so nobody nests or
// cuts it before the answer (lead, 2026-11-07). The importer writes none for it; this does, through bomService.updateLine.
const HELD = 'HELD — designer question open; do not nest or cut until answered';
for (const r of plan.rows) if (r.kind === 'temp' && /^held$/i.test(String(r.item?.status ?? '')) && !String(r.notes ?? '').includes(HELD)) r.notes = [HELD, r.notes].filter(Boolean).join(' · ');
if (plan.problems.length) vlog(`plan problems: ${plan.problems.join(' | ')}`);
const newDefs = plan.rows.filter((r) => r.def?.new);

/** The values a plan row should carry, by code: number, text or option id (rolled-up weights left out). */
function wanted(r) {
  const out = {};
  for (const v of r.values ?? []) {
    if (!CODES.includes(v.code)) continue;
    if (v.optionId !== undefined) { if (v.optionId != null) out[v.code] = Number(v.optionId); continue; }
    out[v.code] = v.number !== undefined ? Number(v.number) : v.text;
  }
  return out;
}
function valueDiffs(n, r) {
  const want = wanted(r); const have = n.vals ?? {}; const out = [];
  for (const [code, w] of Object.entries(want)) {
    const h = have[code];
    const same = typeof w === 'number' ? h != null && near(h, w, NUM_TOL[code] ?? 0.001) : txt(h) === txt(w);
    if (!same) out.push({ specCode: code, from: h ?? null, value: w });
  }
  return out;
}
const keyOfPlan = (r) => (r.kind === 'selection' ? `sel:${r.def?.id}:${normName(r.role)}` : r.mark ? `m:${normMark(r.mark)}` : `d:${r.def?.id ?? r.def?.new}`);
const keyOfNode = (n) => (n.kind === 'temporary' ? (n.mark ? `m:${normMark(n.mark)}` : `d:${n.defId}`) : n.selection ? `sel:${n.selection.id}:${normName(n.role)}` : `c:${n.id}`);
const roleSame = (n, r) => {
  const a = normName(n.role ?? ''); const b = normName(r.role ?? '');
  return a === b || (!a && b === normName(n.name)) || (!b && !a);
};
const notesSame = (n, r) => txt(n.notes) === txt(r.notes);
/** A row's children paired with its plan row's: by mark (by definition for a selection), in order; a plan row with no
 *  mark (a seismic stopper group the importer puts in) takes a leftover row of its definition, whatever mark that has. */
function pairKids(n, r) {
  const pool = new Map();
  for (const k of n.children.filter((x) => !x.isBolt)) { const key = keyOfNode(k); if (!pool.has(key)) pool.set(key, []); pool.get(key).push(k); }
  const pairs = []; const unplaced = [];
  for (const rk of r.kids) { const hit = pool.get(keyOfPlan(rk))?.shift(); if (hit) pairs.push([hit, rk]); else unplaced.push(rk); }
  const left = [...pool.values()].flat();
  for (const rk of [...unplaced]) {
    if (rk.kind !== 'temp' || rk.mark || !rk.def?.id) continue;
    const i = left.findIndex((k) => k.kind === 'temporary' && Number(k.defId) === Number(rk.def.id));
    if (i >= 0) { pairs.push([left.splice(i, 1)[0], rk]); unplaced.splice(unplaced.indexOf(rk), 1); }
  }
  return { pairs, unplaced, left };
}

/* ------------------------------------------------------------------------------------------------------------------
 * The comparison: plan tree against the line's tree, by mark path
 * ---------------------------------------------------------------------------------------------------------------- */
function compare(root) {
  const d = { values: [], roles: [], notes: [], quantities: [], removals: [], pastes: [], definitions: [], selections: [], rootMark: null };
  const walk = (n, r) => {
    // The top row keeps the mark the model's top level has (level-marks-from-model gave it): bom.json's span name may say otherwise.
    const vd = valueDiffs(n, r).filter((w) => !(n === root && w.specCode === 'DRAWING_MARK'));
    if (vd.length) d.values.push({ node: n, plan: r, writes: vd });
    if (n.lineId != null && r.kind === 'temp') {
      if (!roleSame(n, r)) d.roles.push({ node: n, plan: r, from: n.role, to: r.role });
      if (!notesSame(n, r)) d.notes.push({ node: n, plan: r, from: n.notes ?? null, to: r.notes ?? null });
      if (!near(n.quantity, r.quantity)) d.quantities.push({ node: n, plan: r, from: Number(n.quantity), to: r.quantity });
    }
    if (r.def?.id && n.defId && Number(r.def.id) !== Number(n.defId)) d.definitions.push({ node: n, plan: r });
    // Children: pair by key, in order.
    const { pairs, unplaced, left } = pairKids(n, r);
    for (const [hit, rk] of pairs) {
      if (rk.kind === 'selection') { if (!near(hit.quantity, rk.quantity)) d.quantities.push({ node: hit, plan: rk, from: Number(hit.quantity), to: rk.quantity }); continue; }
      walk(hit, rk);
    }
    for (const rk of unplaced) d.pastes.push({ parent: n, plan: rk });
    for (const k of left) d.removals.push({ node: k, parent: n });
  };
  walk(root, planRoot);
  return d;
}

/** Every node of a tree, once per place. */
const nodesOf = (root) => { const out = []; (function w(n) { out.push(n); n.children.forEach(w); }(root)); return out; };
const markWords = (m) => txt(m).toUpperCase().split(/[-_\s]+/).filter(Boolean);
/** The row a new plan row is pasted from: a part from a part, an assembly from an assembly; the same definition first
 *  (a copy keeps its source's definition), then where it sits and how alike it is. */
function sourceFor(root, parent, r) {
  if (!r.def?.id) return null;
  const want = Number(r.def.id);
  const planKidMarks = new Set(r.kids.map((k) => normMark(k.mark ?? '')).filter(Boolean));
  let best = null;
  for (const n of nodesOf(root)) {
    if (n.kind !== 'temporary' || n.lineId == null) continue;
    if (!!r.kids.length !== n.children.some((k) => k.kind === 'temporary')) continue;
    let s = Number(n.defId) === want ? 10 : 0;
    // The same mark elsewhere on the line is the same part moved (Khajaguda's girder stubs from -C into -T): copy it.
    if (n.mark && r.mark && normMark(n.mark) === normMark(r.mark)) s += 8;
    if (n.parent === parent) s += 6;
    else if (n.parent && parent && n.parent.mark && n.parent.mark === parent.mark) s += 5;
    else if (n.parent?.parent && n.parent.parent === parent?.parent) s += 2;
    // Mark likeness: the words of the marks in common (JL4A-WS2 ~ JL4B-WS2; P29 ~ P34 share none, so place decides).
    const a = markWords(n.mark); const b = markWords(r.mark);
    s += a.filter((w) => b.includes(w)).length * 0.5 + (txt(n.mark).slice(0, 3) === txt(r.mark).slice(0, 3) ? 0.5 : 0);
    // What the row is for: its description's words (sizes left out) — "D3 web stub …" picks JL4A-WS2 for JL4B-WS2, not the V4 stub.
    const words = (t) => new Set(normName(t).split(' ').filter((w) => w && !/^\d/.test(w)));
    const A = words(n.role); const B = words(r.role);
    if (A.size && B.size) s += 2 * ([...A].filter((w) => B.has(w)).length / new Set([...A, ...B]).size);
    if (r.kids.length) {
      // An assembly: its children's marks alike (SWAY for SWAY3).
      const km = new Set(n.children.filter((k) => k.mark).map((k) => normMark(k.mark)));
      const shared = [...planKidMarks].filter((m) => km.has(m)).length;
      s += 6 * (shared / Math.max(1, new Set([...planKidMarks, ...km]).size));
    } else {
      const w = wanted(r);
      if (w.THICKNESS != null && near(n.vals.THICKNESS, w.THICKNESS)) s += 1;
      if (w.GRADE != null && Number(n.vals.GRADE) === Number(w.GRADE)) s += 0.5;
    }
    if (!best || s > best.s) best = { n, s };
  }
  return best?.n ?? null;
}

const describe = (writes) => writes.map((w) => `${w.specCode} ${fmt(w.from)} → ${fmt(w.value)}`).join(', ');
const isDrawingCode = (num, mark) => normMark(String(num ?? '').split('/').pop()) === normMark(mark);

/* ------------------------------------------------------------------------------------------------------------------
 * Doing it
 * ---------------------------------------------------------------------------------------------------------------- */
let c;
/** One step, one SHORT transaction: committed with --apply, rolled back in a dry run (nothing stays open between steps:
 *  a long open transaction on TiDB holds its locks and blocks every other writer — 2026-11-07). */
const stepTimes = [];
const step = async (fn) => {
  const t0 = Date.now();
  await db.beginTransaction();
  try { const out = await fn(); if (APPLY) await db.commit(); else await db.rollback(); return out; } catch (e) { try { await db.rollback(); } catch { /* none */ } throw e; } finally {
    const s = Math.round((Date.now() - t0) / 1000); stepTimes.push(s); if (s > 45) log(`    (that transaction was open ${s} s)`);
  }
};
const change = (changes) => applyBomChanges(db, c, { scope: { orderLineId: LINE }, changes });
const writeValues = (writes) => (writes.length ? change([{ op: 'values', links: 'one', writes }]) : null);

/** A pasted subtree's rows brought to their plan rows: a child of the copy whose mark the plan does not have is the
 *  plan's unmatched child of the same definition, renamed (a copy is new: there is nothing on it to keep). PLANS only: applyFits
 *  writes the plans of a whole round together (2026-11-07: one change call per kind instead of three per paste; each call re-reads
 *  the whole line, about 2.7 s on prod). */
function planFit(top, r) {
  const writes = []; const quantities = []; const removes = []; const roles = []; const notes = []; const nested = []; const renamed = [];
  const walk = (n, pr, isTop) => {
    for (const w of valueDiffs(n, pr)) writes.push({ recordId: Number(n.id), specCode: w.specCode, value: w.value, from: w.from, path: pathOf(n) });
    if (!isTop && n.lineId != null && pr.kind === 'temp' && !near(n.quantity, pr.quantity)) quantities.push({ op: 'quantity', lineId: n.lineId, quantity: pr.quantity, links: 'one', from: Number(n.quantity), path: pathOf(n) });
    if (n.lineId != null && pr.kind === 'temp' && !roleSame(n, pr)) roles.push({ lineId: n.lineId, role: pr.role, from: n.role });
    if (n.lineId != null && pr.kind === 'temp' && !notesSame(n, pr)) notes.push({ lineId: n.lineId, notes: pr.notes ?? null });
    const { pairs, unplaced, left } = pairKids(n, pr);
    for (const [hit, rk] of pairs) if (rk.kind === 'temp') walk(hit, rk, false);
    for (const rk of unplaced) {
      let i = left.findIndex((k) => k.kind === 'temporary' && rk.def?.id && Number(k.defId) === Number(rk.def.id));
      if (i < 0) i = left.findIndex((k) => k.kind === 'temporary' && markWords(k.mark)[0] && markWords(k.mark)[0] === markWords(rk.mark)[0]);
      if (i >= 0) { const k = left.splice(i, 1)[0]; renamed.push(`${pathOf(k)} → ${rk.mark}`); walk(k, rk, false); } else nested.push({ parent: n, plan: rk });
    }
    for (const k of left) removes.push({ op: 'remove', lineId: k.lineId, path: pathOf(k) });
  };
  walk(top, r, true);
  const subtree = nodesOf(top).filter((n) => n.kind === 'temporary');
  return { writes, quantities, removes, roles, notes, nested, renamed, unlinked: 0, fromMark: new Map(subtree.map((n) => [Number(n.id), n.mark])) };
}

/** Writes every plan of a round: one values call, one quantities call, one removals call; then the copies' links to their SOURCE
 *  row's part drawing come off each row whose mark changed (step 5 gives it its own). */
async function applyFits(plans) {
  const writes = plans.flatMap((p) => p.writes); const quantities = plans.flatMap((p) => p.quantities); const removes = plans.flatMap((p) => p.removes);
  if (writes.length) await writeValues(writes.map(({ recordId, specCode, value }) => ({ recordId, specCode, value })));
  for (const x of plans.flatMap((p) => p.roles)) await updateLine(db, c, x.lineId, { role: x.role });
  for (const x of plans.flatMap((p) => p.notes)) await updateLine(db, c, x.lineId, { notes: x.notes });
  if (quantities.length) await change(quantities.map(({ op, lineId, quantity, links }) => ({ op, lineId, quantity, links })));
  if (removes.length) await change(removes.map(({ op, lineId }) => ({ op, lineId })));
  const fromMark = new Map(plans.flatMap((p) => [...p.fromMark]));
  if (!fromMark.size) return;
  const links = await q(`SELECT k.id, k.subject_id, d.number FROM cf_drawing_links k JOIN cf_drawings d ON d.id = k.drawing_id
                          WHERE k.company_id = ? AND k.subject_type = 'master_record' AND k.deleted_at IS NULL AND k.subject_id IN (?)`, [COMPANY, [...fromMark.keys()]]);
  if (!links.length) return;
  const ids = [...new Set(links.map((k) => Number(k.subject_id)))];
  const marksNow = new Map((await q(`SELECT v.subject_id, v.value_text FROM cf_spec_values v JOIN cf_specifications s ON s.id = v.specification_id AND s.code = 'DRAWING_MARK'
                                      WHERE v.company_id = ? AND v.subject_type = 'master' AND v.deleted_at IS NULL AND v.subject_id IN (?)`, [COMPANY, ids])).map((v) => [Number(v.subject_id), v.value_text]));
  for (const k of links) {
    const was = fromMark.get(Number(k.subject_id)); const now = marksNow.get(Number(k.subject_id));
    if (was && now && normMark(was) !== normMark(now) && isDrawingCode(k.number, was)) {
      await removeLink(db, c, k.id);
      const p = plans.find((x) => x.fromMark.has(Number(k.subject_id))); if (p) p.unlinked++;
    }
  }
}

async function stepPastes() {
  const tried = new Set();
  for (let round = 0; round < 4; round++) {
    const { root } = await readLine();
    const d = compare(root);
    // Only pastes whose parent is a row already (a nested one comes in the next round, once its parent is there).
    const todo = d.pastes.filter((p) => !tried.has(`${pathOf(p.parent)}/${p.plan.key}`));
    if (!todo.length) return;
    // The round's pastes, all planned from this one read of the line.
    const go = [];
    for (const p of todo) {
      const r = p.plan;
      tried.add(`${pathOf(p.parent)}/${r.key}`);
      const where = `${pathOf(p.parent)}/${r.mark ?? `(${r.def?.name})`}`;
      if (r.kind === 'selection') { report.unsupported.push(`${where}: a ${r.def?.name} row (studs) to add — no row of it to copy on this line`); continue; }
      if (r.def?.new) { report.unsupported.push(`${where}: its definition "${r.def.name}" is new to the catalog — not made here`); continue; }
      const parent = nodesOf(root).find((n) => Number(n.id) === Number(p.parent.id));
      const src = sourceFor(root, parent, r);
      if (!src) { report.unsupported.push(`${where}: no row of definition ${r.def?.name} on the line to copy`); continue; }
      go.push({ r, where, parent, src });
    }
    if (!go.length) continue;
    // One change call pastes them all; one more transaction fits them all (2026-11-07 batching). With --apply the two are separate
    // transactions: lost between them, a copy keeps its source's mark, and the next run removes it as a row too many and pastes again.
    const doPastes = async () => (await change(go.map((x) => ({ op: 'paste', sourceLineId: x.src.lineId, parentId: Number(x.parent.id), quantity: x.r.quantity })))).results;
    const pasted = APPLY ? await step(doPastes) : null;
    await step(async () => {
      const outs = pasted ?? await doPastes();
      const { root: after } = await readLine();
      const all = nodesOf(after);
      // change() never passes dryRun: the pastes really happen inside this transaction (rolled back in a dry run), so line ids come back.
      const plans = [];
      for (const [i, x] of go.entries()) {
        const out = outs?.[i]; if (!out) { report.unsupported.push(`${x.where}: the paste did not go through`); continue; }
        const top = all.find((n) => n.lineId === out.lineId);
        if (!top) { report.unsupported.push(`${x.where}: pasted, but its new row was not found to fit`); continue; }
        plans.push({ x, out, plan: planFit(top, x.r) });
      }
      await applyFits(plans.map((p) => p.plan));
      for (const { x, out, plan: fit } of plans) {
        const defNote = Number(x.src.defId) === Number(x.r.def.id) ? null : `keeps its source's definition #${x.src.defId}; bom.json maps it to ${x.r.def.name} #${x.r.def.id}`;
        const { fromMark, ...rest } = fit;
        report.pastes.push({ where: x.where, quantity: x.r.quantity, from: pathOf(x.src), created: out.created, defNote, ...rest });
        log(`  ${APPLY ? 'pasted' : 'paste (rehearsed, rolled back)'} ${x.where} ×${x.r.quantity} ← copy of ${pathOf(x.src)} (${out.created} rows)${fit.writes.length ? `; ${fit.writes.length} values` : ''}${fit.renamed.length ? `; renamed ${fit.renamed.join(', ')}` : ''}${fit.removes.length ? `; removed ${fit.removes.map((y) => y.path).join(', ')}` : ''}${fit.unlinked ? `; ${fit.unlinked} source drawing link(s) taken off` : ''}`);
      }
    });
  }
}

async function stepChanges() {
  const { root } = await readLine();
  const d = compare(root);
  if (d.definitions.length) for (const x of d.definitions) report.definitions.push(`${pathOf(x.node)}: row is definition #${x.node.defId}, bom.json maps it to ${x.plan.def?.name} #${x.plan.def?.id} — a definition cannot change in place`);
  // Group by parent: the parent's own values, and its children's lines and values.
  const groups = new Map();
  const g = (n) => { const k = Number((n.parent ?? n).id); if (!groups.has(k)) groups.set(k, { at: pathOf(n.parent ?? n), values: [], roles: [], notes: [], quantities: [] }); return groups.get(k); };
  for (const x of d.values) g(x.node).values.push(...x.writes.map((w) => ({ recordId: Number(x.node.id), specCode: w.specCode, value: w.value, from: w.from, path: pathOf(x.node) })));
  for (const x of d.roles) g(x.node).roles.push({ lineId: x.node.lineId, role: x.to, from: x.from, path: pathOf(x.node) });
  for (const x of d.notes) g(x.node).notes.push({ lineId: x.node.lineId, notes: x.to, from: x.from, path: pathOf(x.node) });
  for (const x of d.quantities) g(x.node).quantities.push({ lineId: x.node.lineId, quantity: x.to, from: x.from, path: pathOf(x.node) });
  // All groups in one transaction: one values call, one quantities call (2026-11-07 batching: each call re-reads the whole line).
  const G = [...groups.values()];
  const values = G.flatMap((x) => x.values); const roles = G.flatMap((x) => x.roles); const notes = G.flatMap((x) => x.notes); const quantities = G.flatMap((x) => x.quantities);
  if (values.length || roles.length || notes.length || quantities.length) await step(async () => {
    if (values.length) await writeValues(values.map(({ recordId, specCode, value }) => ({ recordId, specCode, value })));
    for (const x of roles) await updateLine(db, c, x.lineId, { role: x.role });
    for (const x of notes) await updateLine(db, c, x.lineId, { notes: x.notes });
    if (quantities.length) await change(quantities.map((x) => ({ op: 'quantity', lineId: x.lineId, quantity: x.quantity, links: 'one' })));
    report.values.push(...values); report.roles.push(...roles); report.notes.push(...notes); report.quantities.push(...quantities);
  });
  // Removals in one call (a removed row takes its subtree, so a row under another removed row is left to it).
  const gone = d.removals.filter((x) => x.node.lineId != null);
  const under = new Set(gone.flatMap((x) => nodesOf(x.node).filter((k) => k !== x.node).map((k) => k.lineId)));
  const tops = gone.filter((x) => !under.has(x.node.lineId));
  if (tops.length) await step(() => change(tops.map((x) => ({ op: 'remove', lineId: x.node.lineId }))));
  for (const x of tops) report.removals.push({ path: pathOf(x.node), quantity: Number(x.node.quantity), rows: nodesOf(x.node).filter((k) => k.kind === 'temporary').length });
  if (d.rootMark) report.unsupported.push(`root mark ${d.rootMark.from} → ${d.rootMark.to} (not changed)`);
}

async function stepCutPieces() {
  if (!APPLY) { log('  cut pieces: worked out again after the changes (withCutPieces) — not rehearsed'); return null; }
  const out = await step(() => withCutPieces(db, c, LINE, {}));
  log(`  cut pieces: ${out?.cutPieces?.message ?? JSON.stringify(out?.cutPieces ?? null)}${out?.nestingVoided ? ' — nesting voided' : ''}`);
  return out?.cutPieces ?? null;
}

async function stepDrawings(line) {
  if (!DXF_FROM) return;
  const repo = path.resolve(SET, '..', '..');
  const rel = path.relative(repo, path.join(SET, 'dxf')).split(path.sep).join('/');
  // --dxf-to worktree: the files as they are on disk now (committed or not), new files included.
  const worktree = DXF_TO === 'worktree';
  const lines = (out) => out.split('\n').map((s) => s.trim()).filter(Boolean);
  const names = worktree
    ? [...new Set([...lines(execFileSync('git', ['-C', repo, 'diff', '-w', '--name-only', '--diff-filter=AMR', DXF_FROM, '--', rel], { encoding: 'utf8' })),
      ...lines(execFileSync('git', ['-C', repo, 'ls-files', '--others', '--exclude-standard', '--', rel], { encoding: 'utf8' }))])].filter((n) => /\.dxf$/i.test(n))
    : lines(execFileSync('git', ['-C', repo, 'diff', '-w', '--name-only', '--diff-filter=AMR', DXF_FROM, DXF_TO, '--', rel], { encoding: 'utf8' }));
  const dir = path.join(TMP, `line-sync-${LINE}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, f));
  // The line's live file per mark: an equal file is not loaded again (a second run changes nothing).
  const live = new Map((await q('SELECT mark_norm, dxf_text FROM cf_part_drawings WHERE company_id = ? AND order_line_id = ? AND deleted_at IS NULL', [COMPANY, LINE])).map((d) => [d.mark_norm, d.dxf_text]));
  const norm = (s) => String(s ?? '').replace(/\r/g, '').split('\n').map((l) => l.trimEnd()).join('\n').trim();
  const files = [];
  for (const n of names) {
    const base = path.posix.basename(n);
    const buf = worktree ? fs.readFileSync(path.join(repo, n)) : execFileSync('git', ['-C', repo, 'show', `${DXF_TO}:${n}`], { maxBuffer: 64 * 1024 * 1024 });
    const mark = normMark(base.split('_')[0]);
    if (norm(live.get(mark)) === norm(buf.toString('latin1'))) { report.drawings.push({ name: base, status: 'same as the live file — skipped' }); continue; }
    fs.writeFileSync(path.join(dir, base), buf);
    files.push(base);
  }
  log(`  drawings: ${names.length} changed in git, ${files.length} to load (copied to ${dir})`);
  if (!APPLY) {
    // A dry run does not upload (a proven path): it says what each file would do.
    for (const f of files) { const m = normMark(f.split('_')[0]); report.drawings.push({ name: f, status: live.has(m) ? 'would be the next revision of its drawing' : 'would be a new drawing' }); }
    return;
  }
  for (let i = 0; i < files.length; i += 5) await step(async () => {
    const batch = files.slice(i, i + 5).map((f) => ({ name: f, content: fs.readFileSync(path.join(dir, f)).toString('base64') }));
    const up = await uploadDrawings(db, c, line.order_id, LINE, { files: batch, dryRun: false });
    for (const x of up.files ?? []) {
      const reg = x.register ? `${x.register.action} ${x.register.number} rev ${x.register.fromRevision ? `${x.register.fromRevision} → ` : ''}${x.register.revision}` : '';
      report.drawings.push({ name: x.name, status: x.status, reg, rows: (x.rows ?? []).length, problems: x.problems ?? [], warnings: x.warnings ?? [] });
    }
  });
}

async function stepCheck(line) {
  const { root } = await readLine();
  const d = compare(root);
  const left = [
    ...d.values.map((x) => `values ${pathOf(x.node)}: ${describe(x.writes)}`),
    ...d.roles.map((x) => `role ${pathOf(x.node)}`), ...d.notes.map((x) => `notes ${pathOf(x.node)}`),
    ...d.quantities.map((x) => `quantity ${pathOf(x.node)} ${x.from} → ${x.to}`),
    ...d.removals.map((x) => `remove ${pathOf(x.node)}`), ...d.pastes.map((x) => `add ${pathOf(x.parent)}/${x.plan.mark ?? x.plan.def?.name}`),
  ];
  const draws = await modelDrawsOfStandard(db, COMPANY, line.standard_id);
  // Pieces the model leaves unplaced (drawing_bom model2/finish.mjs, 2026-11-07: placed by rule with no source → taken out,
  // listed in model.unplaced { mark: count }) are bought all the same: "not yet positioned", never a mismatch. Read from
  // the standard's model on the line's database and from the package's model.json, whichever has them.
  const unplaced = new Set();
  const addUnplaced = (m) => { for (const k of Object.keys(m?.unplaced ?? {})) unplaced.add(k.toUpperCase()); };
  const [mf] = await q("SELECT file_text FROM cf_standard_drawing_files WHERE company_id = ? AND standard_id = ? AND kind = 'model' AND deleted_at IS NULL ORDER BY id DESC LIMIT 1", [COMPANY, line.standard_id]);
  try { addUnplaced(JSON.parse(mf?.file_text ?? 'null')); } catch { /* not a model */ }
  try { addUnplaced(JSON.parse(fs.readFileSync(path.join(SET, 'model.json'), 'utf8'))); } catch { /* none */ }
  if (!APPLY) {
    // A dry run changed nothing: the check is on the rows the line WILL have (the plan), against the model.
    const leafs = (r) => (r.kids.some((k) => k.kind === 'temp') ? r.kids.filter((k) => k.kind === 'temp').flatMap(leafs) : [r]);
    const ok = (r) => draws.has(String(r.mark).toUpperCase()) || unplaced.has(String(r.mark).toUpperCase())
      || (r.kids.some((k) => k.kind === 'temp') && leafs(r).every((k) => unplaced.has(String(k.mark).toUpperCase())));
    const rows = plan.rows.filter((r) => r.kind === 'temp' && r.mark && r !== planRoot);
    report.unplacedRows = [...new Set(rows.filter((r) => !draws.has(String(r.mark).toUpperCase()) && ok(r)).map((r) => r.mark))];
    report.check = { left: [], dry: true, noModel: [...new Set(rows.filter((r) => !ok(r)).map((r) => planPath(r, byKey)))], noMark: [], modelMarks: draws.size };
    return;
  }
  const marked = nodesOf(root).filter((n) => n.kind === 'temporary' && n.mark && !draws.has(String(n.mark).toUpperCase()));
  // A level all of whose pieces are unplaced has no element left in the model to name it: fine too.
  const allUnplaced = (n) => { const ps = nodesOf(n).filter((k) => k !== n && k.kind === 'temporary' && k.mark && !k.children.some((x) => x.kind === 'temporary')); return ps.length > 0 && ps.every((k) => unplaced.has(String(k.mark).toUpperCase())); };
  const fine = (n) => unplaced.has(String(n.mark).toUpperCase()) || (n.children.some((k) => k.kind === 'temporary') && allUnplaced(n));
  const noModel = marked.filter((n) => !fine(n)).map(pathOf);
  report.unplacedRows = [...new Set(marked.filter(fine).map((n) => n.mark))];
  const noMark = nodesOf(root).filter((n) => n.kind === 'temporary' && !n.mark).map(pathOf);
  report.check = { left, noModel: [...new Set(noModel)], noMark: [...new Set(noMark)], modelMarks: draws.size };
}

try {
  const [[admin]] = await db.query("SELECT id FROM users WHERE company_id = ? AND email LIKE 'admin@%' ORDER BY id LIMIT 1", [COMPANY]);
  c = { companyId: COMPANY, userId: admin.id };
  const { line, root } = await readLine();
  log(`${line.code} line ${LINE} (×${Number(line.quantity)}, standard ${line.standard_id}, ${line.status}${line.locked_at ? ', LOCKED' : ''}) ← ${path.basename(SET)} — ${APPLY ? 'APPLY' : 'DRY RUN (each step in its own short transaction, rolled back)'}`);
  if (line.locked_at) throw new Error('the line is locked — its structure is frozen');
  if (newDefs.length) log(`  plan: ${newDefs.length} rows map to definitions not in the catalog: ${[...new Set(newDefs.map((r) => r.def.name))].join(', ')}`);
  const before = compare(root);
  log(`  before: ${before.values.length} rows with values to change, ${before.roles.length} descriptions, ${before.notes.length} remarks, ${before.quantities.length} quantities, ${before.pastes.length} rows to add, ${before.removals.length} to remove`);

  if (process.argv.includes('--compare')) {
    // Only the comparison, nothing done.
    for (const x of before.values) log(`  ~ ${pathOf(x.node)}: ${describe(x.writes)}`);
    for (const x of before.roles) log(`  role ${pathOf(x.node)}: "${x.from ?? ''}" → "${x.to ?? ''}"`);
    for (const x of before.notes) log(`  notes ${pathOf(x.node)}: "${x.from ?? ''}" → "${x.to ?? ''}"`);
    for (const x of before.quantities) log(`  qty ${pathOf(x.node)}: ${x.from} → ${x.to}`);
    for (const x of before.pastes) log(`  + ${pathOf(x.parent)}/${x.plan.mark ?? `(${x.plan.def?.name})`} ×${x.plan.quantity} (${x.plan.def?.name ?? '?'})`);
    for (const x of before.removals) log(`  - ${pathOf(x.node)} ×${Number(x.node.quantity)}`);
    for (const x of before.definitions) log(`  def ${pathOf(x.node)}: #${x.node.defId} → ${x.plan.def?.name} #${x.plan.def?.id}`);
    throw Object.assign(new Error('compare only'), { quiet: true });
  }
  log('1. new rows'); await stepPastes();
  log('2-4. values, quantities, removals'); await stepChanges();
  report.cutPieces = await stepCutPieces();
  log('5. drawings'); await stepDrawings(line);
  if (BOLTS) {
    log('6. bolts');
    const bolts = JSON.parse(fs.readFileSync(path.join(SET, 'bolts.json'), 'utf8'));
    // loadBolts commits after its catalog and after each assembly row; a dry run only works out what it would do.
    if (APPLY) { await db.beginTransaction(); try { report.bolts = await loadBolts(db, c, { line: LINE, bolts, match: 'mark', apply: true, replace: true, verbose: VERBOSE, log }); await db.commit(); } catch (e) { try { await db.rollback(); } catch { /* none */ } throw e; } }
    else report.bolts = await loadBolts(db, c, { line: LINE, bolts, match: 'mark', planOnly: true, replace: true, verbose: VERBOSE, log });
  }
  if (SAVE_NOTE) {
    log('7. standard');
    if (APPLY) report.standard = (await step(() => saveLineToStandard(db, c, LINE, { note: SAVE_NOTE }))).saved;
    else {
      const [[v]] = await db.query('SELECT MAX(version_no) AS n FROM cf_standard_drawing_versions WHERE company_id = ? AND standard_id = ? AND deleted_at IS NULL', [COMPANY, line.standard_id]);
      report.standardWould = Number(v?.n ?? 0) + 1;
    }
  }
  log('8. check'); await stepCheck(line);

  /* ---------------- the report ---------------- */
  log('\n=== PLAN ===');
  log(`Pasted (${report.pastes.length}):`);
  for (const p of report.pastes) {
    log(`  + ${p.where} ×${p.quantity} ← copy of ${p.from} (${p.created} rows)${p.defNote ? ` — ${p.defNote}` : ''}`);
    for (const w of p.writes) log(`      ${w.path}: ${w.specCode} ${fmt(w.from)} → ${fmt(w.value)}`);
    for (const x of p.renamed) log(`      renamed ${x}`);
    for (const x of p.quantities) log(`      quantity ${x.path} ${x.from} → ${x.quantity}`);
    for (const x of p.removes) log(`      removed in the copy: ${x.path}`);
    if (p.unlinked) log(`      ${p.unlinked} link(s) to the source's part drawing taken off`);
  }
  const byRow = new Map();
  for (const w of report.values) { if (!byRow.has(w.path)) byRow.set(w.path, []); byRow.get(w.path).push(w); }
  log(`Values changed (${byRow.size} rows):`);
  for (const [p, ws] of byRow) log(`  ~ ${p}: ${describe(ws)}`);
  log(`Descriptions (${report.roles.length}):`); for (const x of report.roles) log(`  ~ ${x.path}: "${x.from ?? ''}" → "${x.role ?? ''}"`);
  log(`Remarks (${report.notes.length}):`); for (const x of report.notes) log(`  ~ ${x.path}: "${x.from ?? ''}" → "${x.notes ?? ''}"`);
  log(`Quantities (${report.quantities.length}):`); for (const x of report.quantities) log(`  ~ ${x.path}: ${x.from} → ${x.quantity}`);
  log(`Removed (${report.removals.length}):`); for (const x of report.removals) log(`  - ${x.path} ×${x.quantity} (${x.rows} rows)`);
  const ds = {}; for (const x of report.drawings) ds[x.status] = (ds[x.status] ?? 0) + 1;
  log(`Drawings: ${JSON.stringify(ds)}`);
  for (const x of report.drawings) log(`  ${x.name}: ${x.status}${x.reg ? ` — ${x.reg}` : ''}${x.rows != null ? ` (${x.rows} rows)` : ''}${x.problems?.length ? ` PROBLEMS ${x.problems.join(' ')}` : ''}${x.warnings?.length ? ` warnings: ${x.warnings.join(' ')}` : ''}`);
  if (report.bolts) {
    log(`Bolts: ${report.bolts.removed} rows removed, ${report.bolts.added} added; ${report.bolts.left.length} assemblies unchanged`);
    for (const x of report.bolts.replaced) {
      const sum = (xs) => { const m = new Map(); for (const b of xs) m.set(b.name.replace(/^HSFG bolt set /, '').replace(/,.*$/, ''), (m.get(b.name.replace(/^HSFG bolt set /, '').replace(/,.*$/, '')) ?? 0) + b.qty); return [...m].map(([k, v]) => `${v}× ${k}`).join(', ') || 'none'; };
      log(`  ${x.mark ?? x.row}: ${sum(x.from)} → ${sum(x.to)}`);
    }
    if (report.bolts.missing.length) log(`  bolt groups with no row: ${report.bolts.missing.join(', ')}`);
  }
  if (report.standardWould) log(`Standard: would be saved as version ${report.standardWould}`);
  if (report.standard) log(`Standard: saved as version ${report.standard.versionNo} (#${report.standard.versionId}, ${report.standard.rows} rows, ${report.standard.parts} parts, ${report.standard.weightKg} kg)`);
  if (report.definitions.length) {
    log(`Definition differences, there before this change (not changed: a row's definition cannot change in place) — ${report.definitions.length} rows:`);
    const grp = new Map(); for (const x of report.definitions) { const [p, why] = x.split(': row is '); const k = why.replace(' — a definition cannot change in place', ''); if (!grp.has(k)) grp.set(k, []); grp.get(k).push(p.split('/').pop()); }
    for (const [k, ps] of grp) log(`  ! ${k}: ${[...new Set(ps)].join(', ')}`);
  }
  if (report.unsupported.length) { log(`Not done:`); for (const x of report.unsupported) log(`  ! ${x}`); }
  if (report.check.dry) log(`Check (dry run, on the rows the line will have):`);
  else log(`Check after: ${report.check.left.length} differences left${report.check.left.length ? `: ${report.check.left.slice(0, 40).join(" | ")}` : ""}`);
  log(`  rows whose mark is not a level or piece of the model (${report.check.modelMarks} marks): ${report.check.noModel.length ? report.check.noModel.join(', ') : 'none'}`);
  if (report.unplacedRows?.length) log(`  rows whose piece the model leaves unplaced (not yet positioned, fine): ${report.unplacedRows.join(', ')}`);
  if (report.check.noMark.length) log(`  rows without a mark: ${report.check.noMark.join(', ')}`);
  if (stepTimes.length) log(`Transactions: ${stepTimes.length}, the longest open ${Math.max(...stepTimes)} s`);
  if (!APPLY) log('\nDRY RUN — every step rolled back.');
} catch (e) {
  try { await db.rollback(); } catch { /* none */ }
  if (e.quiet) { db.release(); await pool.end(); process.exit(0); }
  console.error('FAILED (the open step rolled back):', e.message, e.problems ? JSON.stringify(e.problems).slice(0, 2000) : '');
  if (VERBOSE) console.error(e.stack);
  process.exitCode = 1;
} finally { db.release(); await pool.end(); process.exit(process.exitCode ?? 0); }
