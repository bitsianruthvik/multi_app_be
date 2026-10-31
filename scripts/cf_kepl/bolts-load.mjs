/**
 * bolts-load.mjs — put a structure's bolts (drawing_bom `bolts.json`, src/bolts.mjs) onto an order line as BOM rows,
 * through the app's own services: the "Bolt set" selection (Fasteners › Bolt set, made once), one catalog item per bolt
 * size, and under each assembly row one selection row per bolt group with its item chosen. DRY RUN BY DEFAULT
 * (everything done, then rolled back). --apply commits the catalog, then each assembly row on its own (safe to run again:
 * a row that has bolt rows is left).
 *   node scripts/cf_kepl/bolts-load.mjs --company 30005 --line <id> --bolts <bolts.json> --match mark|name --prod [--apply]
 * --match mark: the row's level drawing "<SO>/<assembly>" (or its parts' "<SO>/<assembly>-…") names the assembly.
 * --match name: the row's name is the key (T&T: "Splice set", "End diaphragm" …).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
const __dir = path.dirname(fileURLToPath(import.meta.url));
const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const COMPANY = Number(arg('company')); const LINE = Number(arg('line')); const MATCH = arg('match') ?? 'mark';
const APPLY = process.argv.includes('--apply');
if (!COMPANY || !LINE || !arg('bolts')) { console.error('Usage: --company <id> --line <id> --bolts <bolts.json> [--match mark|name] [--prod] [--apply]'); process.exit(2); }
const BOLTS = JSON.parse(fs.readFileSync(path.resolve(arg('bolts')), 'utf8'));
if (process.argv.includes('--prod')) {
  const env = {}; fs.readFileSync(path.join(__dir, '..', '..', '..', '.env.tidb'), 'utf8').split('\n').forEach((l) => { l = l.trim(); if (!l || l.startsWith('#')) return; const [k, ...r] = l.split('='); env[k.trim()] = r.join('=').trim(); });
  Object.assign(process.env, { DB_HOST: env.DB_HOST, DB_PORT: env.DB_PORT ?? '4000', DB_USER: env.DB_USER, DB_PASSWORD: env.DB_PASSWORD, DB_NAME: env.DB_NAME, DB_SSL: 'true' });
}
const imp = (p) => import(pathToFileURL(path.join(__dir, '..', '..', p)).href);
const { pool } = await imp('db.js');
await imp('apps/cf_erp/services/codegenProvider.js');
const { createNode } = await imp('apps/cf_erp/services/classificationService.js');
const { createItem, createDefinition, setStatus } = await imp('apps/cf_erp/services/masterRecordService.js');
const { addLine, resolveLine } = await imp('apps/cf_erp/services/bomService.js');

const db = await pool.getConnection();
const q = async (sql, p = []) => (await db.query(sql, p))[0];
try {
  const [admin] = await q("SELECT id FROM users WHERE company_id = ? AND email LIKE 'admin@%' ORDER BY id LIMIT 1", [COMPANY]);
  const c = { companyId: COMPANY, userId: admin.id };
  await db.beginTransaction();

  // 1. Fasteners › Bolt set, the selection and the catalog items (made once, found after).
  const [fast] = await q("SELECT id FROM cf_classification_nodes WHERE company_id = ? AND code = 'FASTENERS' AND deleted_at IS NULL", [COMPANY]);
  let [node] = await q("SELECT id FROM cf_classification_nodes WHERE company_id = ? AND code = 'BOLT_SET' AND deleted_at IS NULL", [COMPANY]);
  if (!node) { node = await createNode(db, c, { parentId: fast.id, code: 'BOLT_SET', name: 'Bolt set', description: 'A bolt with its nut and two washers, bought as a set (HSFG for the bolted joints).' }); console.log(`made node Fasteners › Bolt set #${node.id}`); }
  if (process.argv.includes('--verbose')) console.log('catalog…');
  const want = [...new Set(Object.values(BOLTS.byAssembly).flat().map((b) => b.name))];
  const itemOf = new Map();
  for (const name of want) {
    let [it] = await q("SELECT m.id FROM cf_master_records m JOIN cf_item_details i ON i.master_id = m.id AND i.item_type = 'catalog' WHERE m.company_id = ? AND m.name = ? AND m.deleted_at IS NULL", [COMPANY, name]);
    if (!it) { const r = await createItem(db, c, { name, classificationId: node.id, uom: 'nos', trackedBy: 'quantity', sourcing: 'stock', status: 'active' }); it = { id: r.id ?? r.record?.id }; console.log(`made item ${name} #${it.id}`); }
    itemOf.set(name, Number(it.id));
  }
  let [sel] = await q("SELECT m.id FROM cf_master_records m JOIN cf_definition_details d ON d.master_id = m.id AND d.definition_type = 'selection' WHERE m.company_id = ? AND m.name = 'Bolt set' AND m.deleted_at IS NULL", [COMPANY]);
  if (!sel) { const r = await createDefinition(db, c, { name: 'Bolt set', definitionType: 'selection', classificationId: node.id, scope: [{ nodeId: node.id }], status: 'active' }); sel = { id: r.id ?? r.record?.id }; console.log(`made selection Bolt set #${sel.id}`); }
  for (const [id] of [[sel.id], ...[...itemOf.values()].map((v) => [v])]) { const [m] = await q('SELECT status FROM cf_master_records WHERE id = ?', [id]); if (m.status === 'draft') await setStatus(db, c, id, 'active'); }

  // The catalog setup is its own transaction; then one per assembly row (a long line would hold locks too long).
  if (APPLY) { await db.commit(); await db.beginTransaction(); }
  // 2. The line's assembly rows and what each is.
  const [line] = await q('SELECT l.item_id, o.code FROM cf_sales_order_lines l JOIN cf_sales_orders o ON o.id = l.order_id WHERE l.company_id = ? AND l.id = ?', [COMPANY, LINE]);
  const rows = [];
  const walk = async (id) => {
    const [b] = await q('SELECT id FROM cf_boms WHERE company_id = ? AND parent_id = ? AND deleted_at IS NULL', [COMPANY, id]); if (!b) return;
    const ls = await q(`SELECT l.child_id, m.name, (SELECT COUNT(*) FROM cf_boms bb WHERE bb.parent_id = l.child_id AND bb.deleted_at IS NULL) AS hasbom
                          FROM cf_bom_lines l JOIN cf_master_records m ON m.id = l.child_id WHERE l.company_id = ? AND l.bom_id = ? AND l.deleted_at IS NULL ORDER BY l.line_no`, [COMPANY, b.id]);
    for (const x of ls) if (x.hasbom) { rows.push({ id: Number(x.child_id), name: x.name }); await walk(x.child_id); }
  };
  rows.push({ id: Number(line.item_id), name: '(line)' });
  await walk(line.item_id);
  const so = `${line.code}/`;
  const markOf = async (r) => {
    if (MATCH === 'name') return BOLTS.byAssembly[r.name] ? r.name : null;
    const own = await q('SELECT d.number FROM cf_drawing_links k JOIN cf_drawings d ON d.id = k.drawing_id WHERE k.company_id = ? AND k.subject_id = ? AND k.deleted_at IS NULL', [COMPANY, r.id]);
    for (const { number } of own) if (number.startsWith(so) && BOLTS.byAssembly[number.slice(so.length)]) return number.slice(so.length);
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

  // 3. One selection row per bolt group, its size chosen. A row that already has bolt rows is left (run once).
  let added = 0; const seen = new Set(); const unmatched = [];
  for (const r of rows) {
    const mark = await markOf(r);
    if (!mark) { if (r.name !== '(line)') unmatched.push(r.name); continue; }
    seen.add(mark);
    const [already] = await q(`SELECT COUNT(*) AS n FROM cf_boms b JOIN cf_bom_lines l ON l.bom_id = b.id AND l.deleted_at IS NULL AND l.selection_definition_id = ? WHERE b.parent_id = ? AND b.deleted_at IS NULL`, [sel.id, r.id]);
    if (already.n) { console.log(`  ${r.name} (${mark}): has bolt rows — left`); continue; }
    if (process.argv.includes('--verbose')) console.log(`  ${r.name} (${mark}) rec ${r.id}: ${BOLTS.byAssembly[mark].length} groups`);
    for (const g of BOLTS.byAssembly[mark]) {
      await addLine(db, c, r.id, { childId: sel.id, quantity: g.qty, role: `${g.where}`.slice(0, 120), notes: g.assumed ? `Assumed: ${g.assumed}. Grip ${g.grip}.` : `Grip ${g.grip}.` });
      const [nl] = await q(`SELECT l.id FROM cf_boms b JOIN cf_bom_lines l ON l.bom_id = b.id AND l.deleted_at IS NULL WHERE b.parent_id = ? AND b.deleted_at IS NULL ORDER BY l.id DESC LIMIT 1`, [r.id]);
      await resolveLine(db, c, nl.id, { itemId: itemOf.get(g.name) });
      added++;
    }
    if (APPLY) { await db.commit(); await db.beginTransaction(); }
  }
  const missing = Object.keys(BOLTS.byAssembly).filter((m) => !seen.has(m));
  console.log(`${added} bolt rows on line ${LINE} (${line.code}) — ${APPLY ? 'APPLY' : 'DRY RUN, rolled back'}`);
  if (missing.length) console.log(`  bolt groups with no row found: ${missing.join(', ')}`);
  const unm = [...new Set(unmatched)]; if (unm.length) console.log(`  assembly rows with no bolts: ${unm.join(', ')}`);
  if (APPLY) await db.commit(); else await db.rollback();
} catch (e) { try { await db.rollback(); } catch { /* none */ } console.error('FAILED (rolled back):', e.message, e.problems ?? ''); process.exitCode = 1; } finally { db.release(); await pool.end(); process.exit(process.exitCode ?? 0); }
