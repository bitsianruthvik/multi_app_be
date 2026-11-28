/**
 * exact-items.mjs — every selection row of an order line takes the catalog item of EXACTLY the size the drawing gives
 * (user, 2026-11-28: "You use only what's there even when you know the dimension is different. Every time this happens,
 * you need to create the new item and add it to the selector definition and then select that one in the SO BOM.").
 *
 * For each selection row of the line it works out what the package wants:
 *   Bolt set     the row's assembly (its parent's DRAWING_MARK) and bolt group in bolts.json (by the row's role, the
 *                group's "where"): diameter and class from the group; length from the group where it gives one, else
 *                from the grip (model.json boltSet: plies + 2 washers + nut + 3 threads, up to the catalog's length series).
 *   Shear stud   bom.json's shear_stud item: diameter x height ("stud 25 dia x 100").
 *   any other    not sized by the package — reported, left.
 * and compares it with the chosen item. A mismatch: the catalog item of exactly that size (a candidate of the row's
 * selection), else a new one (exactItemService.ensureExactItem: made in the selection's branch, the code next in its
 * series, its unit weight, put in the selection's list), then chosen on the row (bomService.resolveLine — the screen's
 * choose). Nothing by the nearest size; a size the package does not give is left and said.
 *
 * Also prints the bolt check: per bolt row, hole Ø (the plies' holes in model.json), grip (model.json boltSet), class,
 * length by the grip rule vs the package's vs the chosen one.
 *
 * DRY RUN BY DEFAULT: everything done in ONE transaction, then rolled back. --apply commits it. --plan-only writes nothing
 * at all (no item, no choice, no lock held): it reads and says what it would make (with the code it would take) and choose
 * — for a line another session is busy on (the choose refreshes the line's rolled-up values, which waits on its locks).
 *   node scripts/cf_kepl/exact-items.mjs --company 30005 --line <id> --set <drawing_bom/out/SET> [--plan-only | --apply] [--verbose]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
const __dir = path.dirname(fileURLToPath(import.meta.url));
const imp = (p) => import(pathToFileURL(path.join(__dir, '..', '..', p)).href);
const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };

const { exactBolt, exactStud, boltOfName, studOfName, boltLengthFromGrip } = await imp('apps/cf_erp/lib/fastenerItems.js');

/** The package's bolt groups and stud items, and the model's grips per assembly and bolt mark. */
export function readPackage(dir) {
  const read = (f) => (fs.existsSync(path.join(dir, f)) ? JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) : null);
  const bom = read('bom.json'); const bolts = read('bolts.json'); const model = read('model.json');
  // model.json boltSet rows: [markIdx, levelIdx, copy, x, y, z, nx, ny, nz, grip, d] (drawing_bom/src/model2/bolts.mjs)
  const grips = new Map(); // `${assembly}|M${d}x${len}` → Map(grip → count)
  const s = model?.boltSet;
  if (s?.rows) for (const r of s.rows) {
    const levels = String(s.levels[r[1]]).split('<'); const mk = String(s.marks[r[0]]).split(' ')[0];
    for (const lv of levels) {
      if (!bolts?.byAssembly?.[lv]) continue;
      const k = `${lv}|${mk}`; if (!grips.has(k)) grips.set(k, new Map());
      grips.get(k).set(r[9], (grips.get(k).get(r[9]) ?? 0) + 1); break;
    }
  }
  // Hole diameters of the plates in each bolted assembly: its pieces in the model, their holes in bom.json (items[].holes.dia).
  const itemOf = new Map((bom?.items ?? []).map((i) => [i.mark, i]));
  const holes = new Map();
  for (const e of model?.elements ?? []) for (const lv of e.in ?? []) if (bolts?.byAssembly?.[lv]) {
    if (!holes.has(lv)) holes.set(lv, new Map());
    for (const d of itemOf.get(e.mark)?.holes?.dia ?? []) holes.get(lv).set(Number(d), `${e.mark}`);
    break;
  }
  return { bom, bolts, grips, holes, studs: (bom?.items ?? []).filter((i) => i.role === 'shear_stud') };
}

/**
 * The work for one line, on the caller's connection and transaction. → { rows: [...], made: [...], check: [...] }
 * rows: { lineId, parent, selection, quantity, role, chosen, want, action: 'ok' | 'choose' | 'make' | 'open', to, why }
 */
export async function exactItems(db, c, { line: LINE, set: SET, verbose = false, planOnly = false, log = console.log } = {}) {
  const { findCandidates } = await imp('apps/cf_erp/services/selectionService.js');
  const { ensureExactItem, chooseItem, planExactItem } = await imp('apps/cf_erp/services/exactItemService.js');
  const COMPANY = c.companyId;
  const q = async (sql, p = []) => (await db.query(sql, p))[0];
  const pkg = readPackage(SET);

  const [line] = await q('SELECT l.item_id, o.code FROM cf_sales_order_lines l JOIN cf_sales_orders o ON o.id = l.order_id AND o.company_id = l.company_id WHERE l.company_id = ? AND l.id = ?', [COMPANY, LINE]);
  if (!line) throw new Error(`line ${LINE} is not an order line of company ${COMPANY}`);
  // Every selection row under the line, with its parent's name and DRAWING_MARK.
  const sel = [];
  const walk = async (ids) => {
    if (!ids.length) return;
    const ls = await q(`SELECT b.parent_id, l.id, l.child_id, l.quantity, l.role, l.notes, l.selection_definition_id, m.name, m.code, sd.name AS selname,
                               (SELECT COUNT(*) FROM cf_boms bb WHERE bb.company_id = l.company_id AND bb.parent_id = l.child_id AND bb.deleted_at IS NULL) AS hasbom
                          FROM cf_boms b JOIN cf_bom_lines l ON l.bom_id = b.id AND l.company_id = b.company_id AND l.deleted_at IS NULL
                          JOIN cf_master_records m ON m.id = l.child_id AND m.company_id = l.company_id
                          LEFT JOIN cf_master_records sd ON sd.id = l.selection_definition_id AND sd.company_id = l.company_id
                         WHERE b.company_id = ? AND b.parent_id IN (?) AND b.deleted_at IS NULL ORDER BY b.parent_id, l.line_no`, [COMPANY, ids]);
    sel.push(...ls.filter((x) => x.selection_definition_id));
    await walk(ls.filter((x) => !x.selection_definition_id && x.hasbom).map((x) => Number(x.child_id)));
  };
  await walk([Number(line.item_id)]);
  const parentIds = [...new Set(sel.map((s) => Number(s.parent_id)))];
  const parents = new Map((parentIds.length ? await q(`SELECT m.id, m.name, (SELECT v.value_text FROM cf_spec_values v JOIN cf_specifications s ON s.id = v.specification_id AND s.code = 'DRAWING_MARK'
                                                         WHERE v.company_id = m.company_id AND v.subject_type = 'master' AND v.subject_id = m.id AND v.deleted_at IS NULL LIMIT 1) AS mark
                                                         FROM cf_master_records m WHERE m.company_id = ? AND m.id IN (?)`, [COMPANY, parentIds]) : []).map((p) => [Number(p.id), p]));

  // Each selection's candidates, once.
  const candOf = new Map();
  const candidates = async (defId) => {
    if (!candOf.has(defId)) candOf.set(defId, (await findCandidates(db, COMPANY, defId, { limit: 1000 })).candidates);
    return candOf.get(defId);
  };

  const out = []; const check = [];
  for (const r of sel) {
    const parent = parents.get(Number(r.parent_id));
    const base = { lineId: Number(r.id), parent: `${parent?.name ?? r.parent_id}${parent?.mark ? ` (${parent.mark})` : ''}`, selection: r.selname, quantity: Number(r.quantity), role: r.role, chosen: { id: Number(r.child_id), code: r.code, name: r.name } };
    let want = null; let ex = null;
    const cands = await candidates(Number(r.selection_definition_id));
    if (/^bolt set$/i.test(r.selname ?? '')) {
      const asm = pkg.bolts?.byAssembly?.[parent?.mark] ? parent.mark : pkg.bolts?.byAssembly?.[parent?.name] ? parent.name : null;
      const groups = asm ? pkg.bolts.byAssembly[asm] : [];
      const g = groups.find((x) => `${x.where}`.slice(0, 100) === String(r.role ?? '')) ?? groups.find((x) => Number(x.qty) === Number(r.quantity)) ?? (groups.length === 1 ? groups[0] : null);
      if (!g) { out.push({ ...base, action: 'open', why: `no bolt group in bolts.json for ${base.parent}` }); continue; }
      const now = boltOfName(r.name);
      const gr = pkg.grips.get(`${asm}|M${g.dia}x${g.length}`) ?? new Map();
      const grip = gr.size ? Math.max(...gr.keys()) : null;
      const lengths = cands.map((x) => boltOfName(x.name)).filter((b) => b?.dia === g.dia).map((b) => b.length);
      const byGrip = grip != null ? boltLengthFromGrip(g.dia, grip, lengths) : null;
      want = { dia: Number(g.dia), length: Number(g.length) || byGrip, grade: g.grade ?? null };
      ex = exactBolt(want, cands, { hsfg: g.hsfg !== false && !/^Bolt set/i.test(r.name ?? '') });
      const holeD = [...(pkg.holes.get(asm)?.keys() ?? [])].sort((a, b) => a - b);
      check.push({ line: LINE, asm, row: r.id, qty: Number(r.quantity), group: g.where, holeD, grips: [...gr.keys()].sort((a, b) => a - b), dia: g.dia, grade: g.grade ?? null,
        pkgLength: g.length ?? null, gripLength: byGrip, chosen: now ? `M${now.dia} x ${now.length}, ${now.grade}` : r.name, wantName: ex.match?.name ?? ex.make?.name ?? null });
    } else if (/stud/i.test(r.selname ?? '')) {
      const it = pkg.studs.length === 1 ? pkg.studs[0] : pkg.studs.find((s) => String(r.role ?? '').toLowerCase().includes(String(s.description ?? '').toLowerCase().replace(/^shear stud\s*/, '')));
      want = it ? (studOfName(it.profile) ?? studOfName(it.material) ?? studOfName(it.description)) : null;
      ex = want ? exactStud(want, cands) : { open: 'no shear stud in bom.json for this row' };
    } else {
      out.push({ ...base, action: 'open', why: 'the package does not size this selection — left' });
      continue;
    }
    if (ex.open) { out.push({ ...base, want, action: 'open', why: ex.open }); continue; }
    if (ex.match && Number(ex.match.id) === Number(r.child_id)) { out.push({ ...base, want, action: 'ok', to: base.chosen }); continue; }
    out.push({ ...base, want, action: ex.match ? 'choose' : 'make', to: ex.match ?? null, make: ex.make ?? null, selectionId: Number(r.selection_definition_id) });
  }

  // Make what is missing (once per name), then choose on each row.
  const made = new Map();
  for (const x of out.filter((o) => o.action === 'make')) {
    if (!made.has(x.make.name)) {
      const got = planOnly ? await planExactItem(db, c, x.selectionId, x.make) : await ensureExactItem(db, c, x.selectionId, x.make);
      made.set(x.make.name, { ...got, weightKg: x.make.weightKg, selection: x.selection });
      if (verbose) log(`  ${got.created ? 'made' : 'found'} #${got.id} ${got.code} ${got.name}`);
      candOf.delete(x.selectionId);
    }
    x.to = made.get(x.make.name);
  }
  if (planOnly) return { code: line.code, rows: out, made: [...made.values()], check, wrong: [], planOnly: true };
  for (const x of out.filter((o) => o.action === 'choose' || o.action === 'make')) {
    if (verbose) log(`  choosing row ${x.lineId}…`);
    await chooseItem(db, c, x.lineId, x.to.id);
    if (verbose) log(`  row ${x.lineId}: ${x.chosen.name} → ${x.to.name}`);
  }
  // The rows read back: each now holds the item it should.
  const ids = out.filter((o) => o.to).map((o) => o.lineId);
  const now = new Map((ids.length ? await q('SELECT id, child_id FROM cf_bom_lines WHERE company_id = ? AND id IN (?)', [COMPANY, ids]) : []).map((x) => [Number(x.id), Number(x.child_id)]));
  const wrong = out.filter((o) => o.to && now.get(o.lineId) !== Number(o.to.id));
  return { code: line.code, rows: out, made: [...made.values()], check, wrong };
}

/** Rows grouped for printing: same parent name, selection, old → new. */
function grouped(rows) {
  const m = new Map();
  for (const r of rows) {
    const k = `${r.selection} | ${r.parent.replace(/\s*\(.*\)$/, '')} | ${r.chosen.code} ${r.chosen.name} → ${r.to ? `${r.to.code ?? '(new)'} ${r.to.name}` : '—'}`;
    const v = m.get(k) ?? { rows: 0, qty: 0 }; v.rows++; v.qty += r.quantity; m.set(k, v);
  }
  return [...m];
}

// ---- the command line -----------------------------------------------------------------------------------------------
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const COMPANY = Number(arg('company')); const LINE = Number(arg('line')); const SET = arg('set') ? path.resolve(arg('set')) : null;
  const APPLY = process.argv.includes('--apply'); const VERBOSE = process.argv.includes('--verbose');
  const PLAN = process.argv.includes('--plan-only');
  if (PLAN && APPLY) { console.error('--plan-only and --apply: choose one'); process.exit(2); }
  if (!COMPANY || !LINE || !SET) { console.error('Usage: --company <id> --line <id> --set <drawing_bom/out/SET> [--plan-only | --apply] [--verbose]'); process.exit(2); }
  const { pool } = await imp('db.js');
  await imp('apps/cf_erp/services/codegenProvider.js');
  const db = await pool.getConnection();
  try {
    const [[admin]] = await db.query("SELECT id FROM users WHERE company_id = ? AND email LIKE 'admin@%' ORDER BY id LIMIT 1", [COMPANY]);
    const c = { companyId: COMPANY, userId: admin?.id ?? null };
    await db.beginTransaction();
    const r = await exactItems(db, c, { line: LINE, set: SET, verbose: VERBOSE, planOnly: PLAN });
    console.log(`Line ${LINE} (${r.code}), package ${path.basename(SET)} — ${r.rows.length} selection rows`);
    console.log(`\nItems to create: ${r.made.filter((m) => m.created).length ? '' : 'none'}`);
    for (const m of r.made) console.log(`  ${m.created ? '+' : '='} ${m.code} ${m.name} — ${m.weightKg} kg, selection "${m.selection}"${m.addedToSelection ? ' (added to its list)' : m.inBranch ? ' (in its branch)' : ''}${m.created ? '' : ' (already in the catalog)'}`);
    const change = r.rows.filter((x) => x.action === 'choose' || x.action === 'make');
    console.log(`\nRows to re-choose: ${change.length ? '' : 'none'}`);
    for (const [k, v] of grouped(change)) console.log(`  ${String(v.rows).padStart(3)} rows, qty ${String(v.qty).padStart(5)}  ${k}`);
    const ok = r.rows.filter((x) => x.action === 'ok');
    if (ok.length) { console.log(`\nRows already exact: ${ok.length}`); for (const [k, v] of grouped(ok)) console.log(`  ${String(v.rows).padStart(3)} rows, qty ${String(v.qty).padStart(5)}  ${k.replace(/ → .*$/, '')}`); }
    const open = r.rows.filter((x) => x.action === 'open');
    if (open.length) { console.log(`\nLeft (not sized by the package):`); for (const x of open) console.log(`  row ${x.lineId} ${x.selection} under ${x.parent}: ${x.chosen.name} — ${x.why}`); }
    console.log('\nBolt check (hole Ø and grip from model.json, class and length from bolts.json; grip rule = plies + 2×4 washers + nut + 3 threads, up to the catalog series):');
    const seen = new Map();
    for (const b of r.check) { const k = `${b.asm}|${b.group}`; const v = seen.get(k) ?? { ...b, rows: 0, qtyAll: 0 }; v.rows++; v.qtyAll += b.qty; seen.set(k, v); }
    for (const b of seen.values()) {
      console.log(`  ${b.asm.padEnd(7)} ${String(b.rows).padStart(2)} rows ×${String(b.qty).padStart(4)}  hole Ø${b.holeD.join('/')}  grip ${b.grips.join('/')}  M${b.dia} cl ${b.grade ?? '?'}  package L ${b.pkgLength ?? '—'}  by grip L ${b.gripLength ?? '—'}  chosen ${b.chosen}${b.pkgLength && b.gripLength && b.pkgLength !== b.gripLength ? '   PACKAGE LENGTH ≠ GRIP RULE' : ''}`);
    }
    if (r.wrong.length) { console.log(`\nNOT CHOSEN as planned: ${r.wrong.map((w) => w.lineId).join(', ')}`); process.exitCode = 1; }
    console.log(`\n${change.length} rows ${PLAN ? 'to re-choose' : 're-chosen'}, ${r.made.filter((m) => m.created).length} items ${PLAN ? 'to create' : 'created'} — ${APPLY ? 'APPLIED' : PLAN ? 'PLAN ONLY, nothing written' : 'DRY RUN, rolled back'}`);
    if (APPLY && !r.wrong.length) await db.commit(); else await db.rollback();
  } catch (e) { try { await db.rollback(); } catch { /* none */ } console.error('FAILED (rolled back):', e.message, e.problems ?? e.details ?? '', e.sql ? `
  in: ${String(e.sql).slice(0, 300)}` : ''); process.exitCode = 1; } finally { db.release(); await pool.end(); process.exit(process.exitCode ?? 0); }
}
