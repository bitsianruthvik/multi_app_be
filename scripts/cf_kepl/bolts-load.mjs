/**
 * bolts-load.mjs — put a structure's bolts (drawing_bom `bolts.json`, src/bolts.mjs) onto an order line as BOM rows,
 * through the app's own services: the "Bolt set" selection (Fasteners › Bolt set, made once), one catalog item per bolt
 * size, and under each assembly row one selection row per bolt group with its item chosen. DRY RUN BY DEFAULT
 * (everything done, then rolled back). --apply commits the catalog, then each assembly row on its own (safe to run again:
 * a row that has bolt rows is left).
 *   node scripts/cf_kepl/bolts-load.mjs --company 30005 --line <id> --bolts <bolts.json> --match mark|name --prod [--apply] [--replace]
 * --match mark: the row's level drawing "<SO>/<assembly>" (or its parts' "<SO>/<assembly>-…") names the assembly.
 * --match name: the row's name is the key (T&T: "Splice set", "End diaphragm" …).
 * --replace (2026-11-07, line-sync): a row whose bolt rows differ from bolts.json (size, count or where) has them removed
 *   through bomChangeService (the edit screen's Remove) and the new ones added, one assembly row per transaction; a row
 *   whose bolt rows already match is left, so a second run changes nothing. A row whose assembly bolts.json no longer
 *   lists loses its bolt rows.
 * loadBolts() is the same work for another script (line-sync.mjs) on its own connection and transaction; with planOnly it
 * writes nothing at all (no catalog item, no row) and only says what it would do — a dry run that holds no transaction.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
const __dir = path.dirname(fileURLToPath(import.meta.url));
const imp = (p) => import(pathToFileURL(path.join(__dir, '..', '..', p)).href);

/**
 * opts: { line (order line id), bolts (parsed bolts.json), match 'mark' | 'name', apply, replace, verbose, log }
 * With apply, commits after the catalog and after each assembly row (the caller's transaction must be open, and is left
 * open). → { added, removed, replaced: [{ row, mark, from, to }], left, missing, unmatched }
 */
export async function loadBolts(db, c, { line: LINE, bolts: BOLTS, match: MATCH = 'mark', apply: APPLY = false, replace: REPLACE = false, planOnly: PLAN = false, verbose = false, log = console.log } = {}) {
  const { createNode } = await imp('apps/cf_erp/services/classificationService.js');
  const { createItem, createDefinition, setStatus } = await imp('apps/cf_erp/services/masterRecordService.js');
  const { addLine, resolveLine } = await imp('apps/cf_erp/services/bomService.js');
  const { applyBomChanges } = await imp('apps/cf_erp/services/bomChangeService.js');
  const { assertEditable } = await imp('apps/cf_erp/services/bomService.js');
  const { requireMaster } = await imp('apps/cf_erp/services/records.js');
  const { bomOfParent, nextLineNo, nextPosition } = await imp('apps/cf_erp/services/bomGraph.js');
  const { refreshValues } = await imp('apps/cf_erp/services/valueService.js');
  const COMPANY = c.companyId;
  const q = async (sql, p = []) => (await db.query(sql, p))[0];

  // 1. Fasteners › Bolt set, the selection and the catalog items (made once, found after).
  const [fast] = await q("SELECT id FROM cf_classification_nodes WHERE company_id = ? AND code = 'FASTENERS' AND deleted_at IS NULL", [COMPANY]);
  let [node] = await q("SELECT id FROM cf_classification_nodes WHERE company_id = ? AND code = 'BOLT_SET' AND deleted_at IS NULL", [COMPANY]);
  if (!node && PLAN) { node = { id: null }; log('would make node Fasteners › Bolt set'); }
  if (!node) { node = await createNode(db, c, { parentId: fast.id, code: 'BOLT_SET', name: 'Bolt set', description: 'A bolt with its nut and two washers, bought as a set (HSFG for the bolted joints).' }); log(`made node Fasteners › Bolt set #${node.id}`); }
  if (verbose) log('catalog…');
  const want = [...new Set(Object.values(BOLTS.byAssembly).flat().map((b) => b.name))];
  const itemOf = new Map();
  for (const name of want) {
    let [it] = await q("SELECT m.id FROM cf_master_records m JOIN cf_item_details i ON i.master_id = m.id AND i.item_type = 'catalog' WHERE m.company_id = ? AND m.name = ? AND m.deleted_at IS NULL", [COMPANY, name]);
    if (!it && PLAN) { it = { id: `new:${name}` }; log(`would make item ${name}`); }
    if (!it) { const r = await createItem(db, c, { name, classificationId: node.id, uom: 'nos', trackedBy: 'quantity', sourcing: 'stock', status: 'active' }); it = { id: r.id ?? r.record?.id }; log(`made item ${name} #${it.id}`); }
    itemOf.set(name, Number(it.id));
  }
  let [sel] = await q("SELECT m.id FROM cf_master_records m JOIN cf_definition_details d ON d.master_id = m.id AND d.definition_type = 'selection' WHERE m.company_id = ? AND m.name = 'Bolt set' AND m.deleted_at IS NULL", [COMPANY]);
  if (!sel && PLAN) throw new Error('no Bolt set selection yet: run bolts-load.mjs once without planOnly');
  if (!sel) { const r = await createDefinition(db, c, { name: 'Bolt set', definitionType: 'selection', classificationId: node.id, scope: [{ nodeId: node.id }], status: 'active' }); sel = { id: r.id ?? r.record?.id }; log(`made selection Bolt set #${sel.id}`); }
  if (!PLAN) for (const [id] of [[sel.id], ...[...itemOf.values()].map((v) => [v])]) { const [m] = await q('SELECT status FROM cf_master_records WHERE id = ?', [id]); if (m.status === 'draft') await setStatus(db, c, id, 'active'); }

  // The catalog setup is its own transaction; then one per assembly row (a long line would hold locks too long).
  if (APPLY) { await db.commit(); await db.beginTransaction(); }
  // 2. The line's assembly rows and what each is.
  const [line] = await q('SELECT l.item_id, o.code FROM cf_sales_order_lines l JOIN cf_sales_orders o ON o.id = l.order_id WHERE l.company_id = ? AND l.id = ?', [COMPANY, LINE]);
  const rows = [];
  const walk = async (id) => {
    const [b] = await q('SELECT id FROM cf_boms WHERE company_id = ? AND parent_id = ? AND deleted_at IS NULL', [COMPANY, id]); if (!b) return;
    const ls = await q(`SELECT l.child_id, m.name, (SELECT COUNT(*) FROM cf_boms bb WHERE bb.parent_id = l.child_id AND bb.deleted_at IS NULL) AS hasbom
                          FROM cf_bom_lines l JOIN cf_master_records m ON m.id = l.child_id WHERE l.company_id = ? AND l.bom_id = ? AND l.deleted_at IS NULL ORDER BY l.line_no`, [COMPANY, b.id]);
    for (const x of ls) if (x.hasbom) { rows.push({ id: Number(x.child_id), name: x.name, parent: Number(id) }); await walk(x.child_id); }
  };
  rows.push({ id: Number(line.item_id), name: '(line)' });
  await walk(line.item_id);
  const so = `${line.code}/`;
  const ownMarkOf = async (r) => (await q(`SELECT v.value_text AS mark FROM cf_spec_values v JOIN cf_specifications s ON s.id = v.specification_id AND s.code = 'DRAWING_MARK'
                                             WHERE v.company_id = ? AND v.subject_id = ? AND v.subject_type = 'master' AND v.deleted_at IS NULL`, [COMPANY, r.id]))[0]?.mark ?? null;
  const markOf = async (r) => {
    if (MATCH === 'name') return BOLTS.byAssembly[r.name] ? r.name : null;
    // The row's own DRAWING_MARK: with one JSON and no stored level files, this is what names the assembly.
    const selfMark = await q(`SELECT v.value_text AS mark FROM cf_spec_values v JOIN cf_specifications s ON s.id = v.specification_id AND s.code = 'DRAWING_MARK'
                               WHERE v.company_id = ? AND v.subject_id = ? AND v.subject_type = 'master' AND v.deleted_at IS NULL`, [COMPANY, r.id]);
    for (const { mark } of selfMark) if (BOLTS.byAssembly[mark]) return mark;
    const own = await q('SELECT d.number FROM cf_drawing_links k JOIN cf_drawings d ON d.id = k.drawing_id WHERE k.company_id = ? AND k.subject_id = ? AND k.deleted_at IS NULL', [COMPANY, r.id]);
    // The register numbers a line's level drawing '<SO>/L2/G1-S', and '-2' when that number was used before.
    for (const { number } of own) { const m = number.slice(so.length).replace(/^L\d+\//, '').replace(/-\d+$/, ''); if (number.startsWith(so) && BOLTS.byAssembly[m]) return m; }
    // A row with no level drawing of its own: its parts' marks start with the assembly's.
    const kids = await q(`SELECT DISTINCT d.number FROM cf_boms b JOIN cf_bom_lines l ON l.bom_id = b.id AND l.deleted_at IS NULL
                            JOIN cf_drawing_links k ON k.subject_id = l.child_id AND k.deleted_at IS NULL JOIN cf_drawings d ON d.id = k.drawing_id
                           WHERE b.company_id = ? AND b.parent_id = ? AND b.deleted_at IS NULL`, [COMPANY, r.id]);
    const pre = [...new Set(kids.map((k) => k.number).filter((n) => n.startsWith(so)).map((n) => n.slice(so.length).split('-')[0]))];
    if (pre.length === 1 && BOLTS.byAssembly[pre[0]]) return pre[0];
    // …or its parts' DRAWING_MARK values (a splice set whose parts have files but no register link).
    const vals = await q(`SELECT DISTINCT v.value_text AS mark FROM cf_boms b JOIN cf_bom_lines l ON l.bom_id = b.id AND l.deleted_at IS NULL
                            JOIN cf_spec_values v ON v.subject_id = l.child_id AND v.subject_type = 'master' AND v.deleted_at IS NULL
                            JOIN cf_specifications s ON s.id = v.specification_id AND s.code = 'DRAWING_MARK'
                           WHERE b.company_id = ? AND b.parent_id = ? AND b.deleted_at IS NULL`, [COMPANY, r.id]);
    const pre2 = [...new Set(vals.map((v) => String(v.mark ?? '').split('-')[0]).filter(Boolean))];
    return pre2.length === 1 && BOLTS.byAssembly[pre2[0]] ? pre2[0] : null;
  };
  const boltRowsOf = (rowId) => q(`SELECT l.id, l.child_id, l.quantity, l.role, m.name FROM cf_boms b JOIN cf_bom_lines l ON l.bom_id = b.id AND l.deleted_at IS NULL AND l.selection_definition_id = ?
                                     JOIN cf_master_records m ON m.id = l.child_id WHERE b.parent_id = ? AND b.deleted_at IS NULL ORDER BY l.line_no, l.id`, [sel.id, rowId]);
  const sig = (xs) => xs.map((x) => `${x.item}|${Number(x.qty)}|${String(x.role ?? '').trim().toLowerCase()}`).sort().join('\n');
  const removeRows = async (have) => {
    if (!have.length) return 0;
    if (PLAN) return have.length;
    await applyBomChanges(db, c, { scope: { orderLineId: LINE }, changes: have.map((h) => ({ op: 'remove', lineId: Number(h.id) })) });
    return have.length;
  };

  // 3. One selection row per bolt group, its size chosen. A row that already has bolt rows is left (run once) —
  //    or, with --replace, has them replaced when they differ.
  // A row inside a row of the SAME mark (Thane's seismic stopper carries its end cross girder's mark EBCG) is one assembly
  // for the bolts: they go on the one of the two that has bolt rows already, else on the outer one — never on both.
  // BULK READS (2026-11-10): one query per kind for ALL rows instead of 5–7 per row — Thane's 660 rows were several
  // thousand round trips to prod (50+ minutes). markOfBulk follows markOf's order exactly.
  const ids = rows.map((r) => r.id);
  const group = (list, key) => { const m = new Map(); for (const x of list) { const k = Number(x[key]); if (!m.has(k)) m.set(k, []); m.get(k).push(x); } return m; };
  const selfMarks = group(ids.length ? await q(`SELECT v.subject_id, v.value_text AS mark FROM cf_spec_values v JOIN cf_specifications s ON s.id = v.specification_id AND s.code = 'DRAWING_MARK'
                                   WHERE v.company_id = ? AND v.subject_id IN (?) AND v.subject_type = 'master' AND v.deleted_at IS NULL ORDER BY v.id`, [COMPANY, ids]) : [], 'subject_id');
  const ownNums = group(ids.length ? await q('SELECT k.subject_id, d.number FROM cf_drawing_links k JOIN cf_drawings d ON d.id = k.drawing_id WHERE k.company_id = ? AND k.subject_id IN (?) AND k.deleted_at IS NULL ORDER BY k.id', [COMPANY, ids]) : [], 'subject_id');
  const kidNums = group(ids.length ? await q(`SELECT DISTINCT b.parent_id, d.number FROM cf_boms b JOIN cf_bom_lines l ON l.bom_id = b.id AND l.deleted_at IS NULL
                                 JOIN cf_drawing_links k ON k.subject_id = l.child_id AND k.deleted_at IS NULL JOIN cf_drawings d ON d.id = k.drawing_id
                                WHERE b.company_id = ? AND b.parent_id IN (?) AND b.deleted_at IS NULL`, [COMPANY, ids]) : [], 'parent_id');
  const kidMarks = group(ids.length ? await q(`SELECT DISTINCT b.parent_id, v.value_text AS mark FROM cf_boms b JOIN cf_bom_lines l ON l.bom_id = b.id AND l.deleted_at IS NULL
                                 JOIN cf_spec_values v ON v.subject_id = l.child_id AND v.subject_type = 'master' AND v.deleted_at IS NULL
                                 JOIN cf_specifications s ON s.id = v.specification_id AND s.code = 'DRAWING_MARK'
                                WHERE b.company_id = ? AND b.parent_id IN (?) AND b.deleted_at IS NULL`, [COMPANY, ids]) : [], 'parent_id');
  const boltRowsAll = group(ids.length && sel.id ? await q(`SELECT b.parent_id, l.id, l.child_id, l.quantity, l.role, m.name FROM cf_boms b JOIN cf_bom_lines l ON l.bom_id = b.id AND l.deleted_at IS NULL AND l.selection_definition_id = ?
                                     JOIN cf_master_records m ON m.id = l.child_id WHERE b.parent_id IN (?) AND b.deleted_at IS NULL ORDER BY l.line_no, l.id`, [sel.id, ids]) : [], 'parent_id');
  const markOfBulk = (r) => {
    if (MATCH === 'name') return BOLTS.byAssembly[r.name] ? r.name : null;
    for (const { mark } of selfMarks.get(r.id) ?? []) if (BOLTS.byAssembly[mark]) return mark;
    for (const { number } of ownNums.get(r.id) ?? []) { const m = number.slice(so.length).replace(/^L\d+\//, '').replace(/-\d+$/, ''); if (number.startsWith(so) && BOLTS.byAssembly[m]) return m; }
    const pre = [...new Set((kidNums.get(r.id) ?? []).map((k) => k.number).filter((n) => n.startsWith(so)).map((n) => n.slice(so.length).split('-')[0]))];
    if (pre.length === 1 && BOLTS.byAssembly[pre[0]]) return pre[0];
    const pre2 = [...new Set((kidMarks.get(r.id) ?? []).map((v) => String(v.mark ?? '').split('-')[0]).filter(Boolean))];
    return pre2.length === 1 && BOLTS.byAssembly[pre2[0]] ? pre2[0] : null;
  };
  const ownMarkBulk = (r) => (selfMarks.get(r.id) ?? [])[0]?.mark ?? null;
  const markById = new Map(); for (const r of rows) markById.set(r.id, markOfBulk(r));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const hasBolts = new Map(); for (const r of rows) hasBolts.set(r.id, (boltRowsAll.get(r.id) ?? []).length > 0);
  const twinOf = (r) => { for (let up = byId.get(r.parent); up; up = byId.get(up.parent)) if (markById.get(up.id) && markById.get(up.id) === markById.get(r.id)) return up; return null; };
  const skip = new Set();
  for (const r of rows) {
    const outer = twinOf(r); if (!outer) continue;
    if (hasBolts.get(r.id) && !hasBolts.get(outer.id)) skip.add(outer.id); else skip.add(r.id);
    log(`  ${r.name} sits in ${outer.name}, both ${markById.get(r.id)}: bolts on the ${skip.has(r.id) ? 'outer' : 'inner'} row only`);
  }
  const touched = [];
  let added = 0; let removed = 0; const seen = new Set(); const unmatched = []; const replaced = []; const left = [];
  for (const r of rows) {
    if (skip.has(r.id)) { seen.add(markById.get(r.id)); continue; }
    const mark = markById.get(r.id);
    if (!mark) {
      if (r.name !== '(line)') unmatched.push(r.name);
      // --replace: an assembly bolts.json no longer lists keeps no bolt rows.
      if (REPLACE) {
        const have = boltRowsAll.get(r.id) ?? [];
        if (have.length) {
          const own = ownMarkBulk(r);
          removed += await removeRows(have);
          replaced.push({ row: r.name, mark: own, from: have.map((h) => ({ name: h.name, qty: Number(h.quantity), role: h.role })), to: [] });
          log(`  ${r.name} (${own ?? 'no mark'}): ${have.length} bolt rows removed — bolts.json has no bolts for it`);
          if (APPLY) { await db.commit(); await db.beginTransaction(); }
        }
      }
      continue;
    }
    seen.add(mark);
    const groups = BOLTS.byAssembly[mark];
    const have = boltRowsAll.get(r.id) ?? [];
    if (have.length && !REPLACE) { log(`  ${r.name} (${mark}): has bolt rows — left`); left.push(mark); continue; }
    if (have.length) {
      const now = have.map((h) => ({ item: Number(h.child_id), qty: Number(h.quantity), role: h.role }));
      const next = groups.map((g) => ({ item: itemOf.get(g.name), qty: g.qty, role: `${g.where}`.slice(0, 100) }));
      if (sig(now) === sig(next)) { if (verbose) log(`  ${r.name} (${mark}): bolt rows match bolts.json — left`); left.push(mark); continue; }
      removed += await removeRows(have);
      replaced.push({ row: r.name, mark, from: have.map((h) => ({ name: h.name, qty: Number(h.quantity), role: h.role })), to: groups.map((g) => ({ name: g.name, qty: g.qty, role: `${g.where}`.slice(0, 100) })) });
    }
    if (verbose) log(`  ${r.name} (${mark}) rec ${r.id}: ${groups.length} groups`);
    if (PLAN) { if (!have.length) replaced.push({ row: r.name, mark, from: [], to: groups.map((g) => ({ name: g.name, qty: g.qty, role: `${g.where}`.slice(0, 100) })) }); added += groups.length; continue; }
    // BULK WRITE (2026-11-10): the row's checks once, then ONE insert of all its bolt rows with the item already chosen
    // (as resolveLine leaves it: child = the item, auto_chosen 0), and ONE value refresh for every touched row at the end.
    // addLine + resolveLine per group refreshed the values up the whole tree twice per bolt group (~40 round trips each).
    const bom = await bomOfParent(db, COMPANY, r.id);
    if (!bom) {
      for (const g of groups) {
        await addLine(db, c, r.id, { childId: sel.id, quantity: g.qty, role: `${g.where}`.slice(0, 100), notes: g.assumed ? `Assumed: ${g.assumed}. Grip ${g.grip}.` : `Grip ${g.grip}.` });
        const [nl] = await q(`SELECT l.id FROM cf_boms b JOIN cf_bom_lines l ON l.bom_id = b.id AND l.deleted_at IS NULL WHERE b.parent_id = ? AND b.deleted_at IS NULL ORDER BY l.id DESC LIMIT 1`, [r.id]);
        await resolveLine(db, c, nl.id, { itemId: itemOf.get(g.name) });
        added++;
      }
    } else {
      await assertEditable(db, COMPANY, await requireMaster(db, COMPANY, r.id));
      await q('SELECT id FROM cf_boms WHERE id = ? FOR UPDATE', [bom.id]);
      let lineNo = (await nextLineNo(db, COMPANY, bom.id)) - 10;
      let pos = (await nextPosition(db, COMPANY, bom.id, sel.id)) - 1;
      const vals = groups.map((g) => [COMPANY, bom.id, (lineNo += 10), itemOf.get(g.name), sel.id, ++pos, `${g.where}`.slice(0, 100), g.qty, sel.id, null, null,
        g.assumed ? `Assumed: ${g.assumed}. Grip ${g.grip}.` : `Grip ${g.grip}.`, c.userId, 0]);
      if (vals.length) await q(`INSERT INTO cf_bom_lines (company_id, bom_id, line_no, child_id, design_id, position, role, quantity, selection_definition_id, source_line_id, operation_flow_id, notes, created_by, auto_chosen) VALUES ?`, [vals]);
      added += vals.length;
    }
    touched.push(r.id);
    if (APPLY) { await db.commit(); await db.beginTransaction(); }
  }
  // One value refresh for every row that took bolt rows (removals refreshed themselves through applyBomChanges).
  if (touched.length && !PLAN) { await refreshValues(db, c, [...new Set(touched)]); if (APPLY) { await db.commit(); await db.beginTransaction(); } }
  const missing = Object.keys(BOLTS.byAssembly).filter((m) => !seen.has(m));
  return { added, removed, replaced, left, missing, unmatched: [...new Set(unmatched)], code: line.code };
}

// ---- the command line -----------------------------------------------------------------------------------------------
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
  const COMPANY = Number(arg('company')); const LINE = Number(arg('line')); const MATCH = arg('match') ?? 'mark';
  const APPLY = process.argv.includes('--apply'); const REPLACE = process.argv.includes('--replace');
  if (!COMPANY || !LINE || !arg('bolts')) { console.error('Usage: --company <id> --line <id> --bolts <bolts.json> [--match mark|name] [--replace] [--prod] [--apply]'); process.exit(2); }
  const BOLTS = JSON.parse(fs.readFileSync(path.resolve(arg('bolts')), 'utf8'));
  if (process.argv.includes('--prod')) {
    const env = {}; fs.readFileSync(path.join(__dir, '..', '..', '..', '.env.tidb'), 'utf8').split('\n').forEach((l) => { l = l.trim(); if (!l || l.startsWith('#')) return; const [k, ...r] = l.split('='); env[k.trim()] = r.join('=').trim(); });
    Object.assign(process.env, { DB_HOST: env.DB_HOST, DB_PORT: env.DB_PORT ?? '4000', DB_USER: env.DB_USER, DB_PASSWORD: env.DB_PASSWORD, DB_NAME: env.DB_NAME, DB_SSL: 'true' });
  }
  const { pool } = await imp('db.js');
  await imp('apps/cf_erp/services/codegenProvider.js');
  const db = await pool.getConnection();
  try {
    const [[admin]] = await db.query("SELECT id FROM users WHERE company_id = ? AND email LIKE 'admin@%' ORDER BY id LIMIT 1", [COMPANY]);
    const c = { companyId: COMPANY, userId: admin.id };
    await db.beginTransaction();
    const r = await loadBolts(db, c, { line: LINE, bolts: BOLTS, match: MATCH, apply: APPLY, replace: REPLACE, verbose: process.argv.includes('--verbose') });
    for (const x of r.replaced) console.log(`  ${x.row} (${x.mark ?? 'no mark'}): replaced ${x.from.map((b) => `${b.qty}× ${b.name}`).join(', ')} → ${x.to.map((b) => `${b.qty}× ${b.name}`).join(', ') || 'none'}`);
    console.log(`${r.added} bolt rows added${REPLACE ? `, ${r.removed} removed` : ''} on line ${LINE} (${r.code}) — ${APPLY ? 'APPLY' : 'DRY RUN, rolled back'}`);
    if (r.missing.length) console.log(`  bolt groups with no row found: ${r.missing.join(', ')}`);
    if (r.unmatched.length) console.log(`  assembly rows with no bolts: ${r.unmatched.join(', ')}`);
    if (APPLY) await db.commit(); else await db.rollback();
  } catch (e) { try { await db.rollback(); } catch { /* none */ } console.error('FAILED (rolled back):', e.message, e.problems ?? ''); process.exitCode = 1; } finally { db.release(); await pool.end(); process.exit(process.exitCode ?? 0); }
}
