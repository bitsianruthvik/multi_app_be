/**
 * selection_scope_test.mjs — what a selection PICKS FROM (init.sql §42) and how
 * an order's selection rows get chosen:
 *
 *   cd multi_app_be && node scripts/cf_kepl/selection_scope_test.mjs
 *   CF_SEL_COMPANY=2 (the default: the local KEPL copy)
 *
 * Everything runs inside ONE transaction that is rolled back (own fixtures:
 * nodes, items, a spec, selections, a template and an order); the last thing it
 * does is re-count every cf_ table. No DDL runs inside it.
 *
 *   1. union: two branches (a variant, a subfamily) + a single item
 *   2. spec filters narrow the union (same spec OR, different specs AND)
 *   3. the default star: first item, moved, taken off; a default that fails the
 *      filters is not first and not the default
 *   4. activation needs at least one entry; the old columns are kept in step
 *   5. migration: the §42 INSERTs (only those — no DDL) on old-style
 *      allowed_list / spec_match / both selections give the SAME candidates the
 *      old rule gave; a second run adds nothing; the fallback (no entries yet)
 *      reads the same; old allowed-list calls still work
 *   6. auto-fill on an order line: the default, the only candidate; never two
 *      candidates; a person's choice / clearing is final; old untouched rows are
 *      filled on the next read and the next save
 *   7. a cut plate's raw plate is never auto-filled and never counted; the
 *      counts (BOM tree, order lines, getBom) match the structure blocker
 */
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
const { attachNodeCache } = await imp('apps/cf_erp/lib/db.js');
await imp('apps/cf_erp/services/codegenProvider.js');
const SEL = await imp('apps/cf_erp/services/selectionService.js');
const MR = await imp('apps/cf_erp/services/masterRecordService.js');
const B = await imp('apps/cf_erp/services/bomService.js');
const S = await imp('apps/cf_erp/services/salesOrderService.js');
const PROC = await imp('apps/cf_erp/services/processService.js');
const CP = await imp('apps/cf_erp/services/cutPlateService.js');
const { insertLine } = await imp('apps/cf_erp/services/bomGraph.js');

if (!/^(localhost|127\.0\.0\.1|::1)$/.test(process.env.DB_HOST ?? 'localhost')) throw new Error('This suite is local only.');
const COMPANY = Number(process.env.CF_SEL_COMPANY ?? 2);

let passed = 0;
let failed = 0;
function ok(label, condition, detail = '') {
  if (typeof label !== 'string' || typeof condition !== 'boolean') throw new Error('ok(label, condition) takes a string and then a boolean');
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${!condition && detail ? ` — ${detail}` : ''}`);
  if (condition) passed++; else failed++;
}
const eq = (label, got, want) => ok(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
const section = (s) => console.log(`\n${s}`);
const refusal = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

const [tables] = await pool.query("SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME LIKE 'cf\\_%' ORDER BY TABLE_NAME");
const counts = async () => (await pool.query(tables.map((t) => `SELECT '${t.name}' AS name,COUNT(*) AS n FROM \`${t.name}\``).join(' UNION ALL ')))[0];
const before = await counts();

// The §42 migration statements — the INSERTs only (DDL would commit the transaction).
const initSql = fs.readFileSync(path.join(BE, 'apps/cf_erp/models/init.sql'), 'utf8');
const block = initSql.slice(initSql.indexOf('-- 42. WHAT A SELECTION'));
const MIGRATION = block.replace(/^\s*--.*$/gm, '').split(';').map((x) => x.trim()).filter((x) => /^INSERT INTO cf_selection_scope/.test(x));

const conn = await pool.getConnection();
let exitCode = 0;
try {
  await conn.beginTransaction();
  attachNodeCache(conn);
  const [[user]] = await conn.query('SELECT id FROM users WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [COMPANY]);
  const c = { companyId: COMPANY, userId: user?.id ?? null };
  const tag = `SS${Date.now().toString(36).toUpperCase()}`.slice(0, 10);
  const ins = async (sql, params) => (await conn.query(sql, params))[0].insertId;
  const node = (parentId, depth, key) => ins(
    "INSERT INTO cf_classification_nodes (company_id, parent_id, depth, scope, code, name, status, created_in) VALUES (?, ?, ?, 'both', ?, ?, 'active', 'items')",
    [COMPANY, parentId, depth, `${tag}${key}`, `${tag} ${key}`]);
  const item = async (key, classificationId, { status = 'active' } = {}) => {
    const id = await ins('INSERT INTO cf_master_records (company_id, record_kind, code, name, classification_id, status, created_by) VALUES (?, \'item\', ?, ?, ?, ?, ?)',
      [COMPANY, `${tag}-${key}`, `${tag} ${key}`, classificationId, status, c.userId]);
    await conn.query("INSERT INTO cf_item_details (master_id, company_id, item_type, tracked_by, uom, sourcing) VALUES (?, ?, 'catalog', 'quantity', 'nos', 'stock')", [id, COMPANY]);
    return id;
  };
  const SPEC = await ins("INSERT INTO cf_specifications (company_id, code, name, data_type, status) VALUES (?, ?, ?, 'number', 'active')", [COMPANY, `${tag}SZ`, `${tag} size`]);
  const SPEC2 = await ins("INSERT INTO cf_specifications (company_id, code, name, data_type, status) VALUES (?, ?, ?, 'number', 'active')", [COMPANY, `${tag}GR`, `${tag} grade`]);
  const val = (itemId, spec, n) => conn.query("INSERT INTO cf_spec_values (company_id, specification_id, subject_type, subject_id, value_number, source) VALUES (?, ?, 'master', ?, ?, 'entered')", [COMPANY, spec, itemId, n]);
  const defNode = await node(null, 0, 'DF');
  const defSub = await node(defNode, 1, 'DS');
  const defVar = await node(defSub, 2, 'DV');

  // Tree: F > S1 > V1 (a1, a2) ; F > S2 > V2 (b1) ; G > GS > GV (c1, c2 obsolete)
  const F = await node(null, 0, 'F'); const S1 = await node(F, 1, 'S1'); const V1 = await node(S1, 2, 'V1');
  const S2 = await node(F, 1, 'S2'); const V2 = await node(S2, 2, 'V2');
  const G = await node(null, 0, 'G'); const GS = await node(G, 1, 'GS'); const GV = await node(GS, 2, 'GV');
  const a1 = await item('A1', V1); const a2 = await item('A2', V1); const b1 = await item('B1', V2);
  const c1 = await item('C1', GV); const c2 = await item('C2', GV, { status: 'obsolete' });
  await val(a1, SPEC, 20); await val(a2, SPEC, 30); await val(b1, SPEC, 10); await val(c1, SPEC, 20); await val(c2, SPEC, 20);
  await val(a1, SPEC2, 1); await val(c1, SPEC2, 2);
  let seq = 0;
  const selection = (extra = {}) => MR.createDefinition(conn, c, { definitionType: 'selection', classificationId: defVar, code: `${tag}-SEL${++seq}`, name: `${tag} selection ${seq}`, ...extra });
  const ids = (r) => r.candidates.map((x) => x.id).sort((x, y) => x - y);
  const sorted = (xs) => [...xs].sort((x, y) => x - y);
  const crit = (defId, value, spec = SPEC, operator = 'eq') => SEL.addCriterion(conn, c, defId, { specificationId: spec, operator, value });

  /* ---- 1 --------------------------------------------------------------- */
  section('1. Candidates are the UNION of the entries');
  const s1 = await selection({ scope: [{ nodeId: V1 }, { nodeId: GS }, { itemId: b1 }] });
  let got = await SEL.findCandidates(conn, COMPANY, s1.id);
  eq('variant V1 (a1, a2) ∪ subfamily GS (c1; c2 is obsolete) ∪ item b1', ids(got), sorted([a1, a2, c1, b1]));
  eq('total says 4', got.total, 4);
  ok('nothing truncated', got.truncated === false);
  const sel1 = await SEL.getSelection(conn, COMPANY, s1.id);
  eq('three entries, in the order given', sel1.entries.map((e) => [e.kind, e.nodeId ?? e.itemId]), [['node', V1], ['node', GS], ['item', b1]]);
  ok('a branch entry says its level and path', sel1.entries[1].level === 'Subfamily' && sel1.entries[1].path === `${tag} G › ${tag} GS`, JSON.stringify(sel1.entries[1]));
  got = await SEL.findCandidates(conn, COMPANY, s1.id, { limit: 2 });
  ok('a limit shows 2 of 4 and says so', got.candidates.length === 2 && got.total === 4 && got.truncated === true);
  got = await SEL.findCandidates(conn, COMPANY, s1.id, { search: `${tag}-C1` });
  eq('search narrows to c1', ids(got), [c1]);
  got = await SEL.findCandidates(conn, COMPANY, s1.id, { itemId: a2, limit: 1 });
  eq('one item checked on its own', ids(got), [a2]);
  const dup = await refusal(() => SEL.addEntry(conn, c, s1.id, { nodeId: V1 }));
  ok('the same branch twice is refused in words', dup?.code === 'DUPLICATE_ENTRY', dup?.message);
  const both = await refusal(() => SEL.addEntry(conn, c, s1.id, { nodeId: V1, itemId: a1 }));
  ok('an entry is a branch OR an item', both?.code === 'ENTRY_KIND');
  const tmp = await refusal(() => SEL.addEntry(conn, c, s1.id, { itemId: c2 }));
  ok('an obsolete item cannot be added', tmp?.code === 'OBSOLETE');

  /* ---- 2 --------------------------------------------------------------- */
  section('2. Spec filters narrow the union');
  await crit(s1.id, 20);
  eq('SZ = 20 keeps a1 and c1', ids(await SEL.findCandidates(conn, COMPANY, s1.id)), sorted([a1, c1]));
  await crit(s1.id, 10);
  eq('SZ = 20 or SZ = 10 (same spec: OR) keeps a1, c1, b1', ids(await SEL.findCandidates(conn, COMPANY, s1.id)), sorted([a1, c1, b1]));
  await crit(s1.id, 2, SPEC2);
  eq('… and GR = 2 (different spec: AND) keeps c1', ids(await SEL.findCandidates(conn, COMPANY, s1.id)), [c1]);
  got = await SEL.findCandidates(conn, COMPANY, s1.id);
  ok('the matched values say why', got.candidates[0].matchedValues.some((v) => v.specCode === `${tag}GR` && Number(v.value) === 2));

  /* ---- 3 --------------------------------------------------------------- */
  section('3. The default star');
  const s3 = await selection({ scope: [{ nodeId: V1 }] });
  let s3sel = await SEL.addEntry(conn, c, s3.id, { itemId: b1 });
  ok('the first item added becomes the default', s3sel.entries.find((e) => e.itemId === b1)?.isDefault === true);
  got = await SEL.findCandidates(conn, COMPANY, s3.id);
  ok('the default comes first and says so', got.candidates[0].id === b1 && got.candidates[0].isDefault === true);
  eq('automaticPick takes the default', (await SEL.automaticPick(conn, COMPANY, s3.id))?.id, b1);
  s3sel = await SEL.addEntry(conn, c, s3.id, { itemId: c1 });
  ok('a second item does not take the star', s3sel.entries.find((e) => e.itemId === c1)?.isDefault === false);
  const c1Entry = s3sel.entries.find((e) => e.itemId === c1);
  s3sel = await SEL.setDefaultEntry(conn, c, c1Entry.id);
  eq('the star moves (one default)', s3sel.entries.filter((e) => e.isDefault).map((e) => e.itemId), [c1]);
  const nodeStar = await refusal(() => SEL.setDefaultEntry(conn, c, s3sel.entries[0].id));
  ok('a branch cannot be the default', nodeStar?.code === 'NODE_NOT_DEFAULT');
  await crit(s3.id, 30);   // only a2 has SZ 30: the default c1 is no longer a candidate
  got = await SEL.findCandidates(conn, COMPANY, s3.id);
  ok('a default that fails the filters is neither first nor "default"', ids(got).join() === String(a2) && got.candidates.every((x) => !x.isDefault));
  eq('…and automaticPick then takes the only candidate', (await SEL.automaticPick(conn, COMPANY, s3.id))?.id, a2);
  s3sel = await SEL.setDefaultEntry(conn, c, c1Entry.id, { isDefault: false });
  ok('the star can be taken off', s3sel.entries.every((e) => !e.isDefault));
  const removed = await SEL.removeEntry(conn, c, c1Entry.id);
  ok('an entry is removed', !removed.entries.some((e) => e.itemId === c1));

  /* ---- 4 --------------------------------------------------------------- */
  section('4. Activation, and the old columns kept in step');
  const s4 = await selection();
  const noEntry = await refusal(() => MR.setStatus(conn, c, s4.id, 'active'));
  ok('a selection with nothing to pick from cannot be activated', noEntry?.code === 'INCOMPLETE' && noEntry.problems.some((p) => /picks from nothing/.test(p)), JSON.stringify(noEntry?.problems));
  await SEL.addEntry(conn, c, s4.id, { nodeId: GS });
  ok('one branch is enough (spec filters are optional)', (await MR.setStatus(conn, c, s4.id, 'active')).status === 'active');
  const [[d1]] = await conn.query('SELECT selection_mode, candidate_classification_id FROM cf_definition_details WHERE master_id = ?', [s1.id]);
  eq('old columns: first node + derived mode', [d1.selection_mode, d1.candidate_classification_id], ['both', V1]);
  const [legacy1] = await conn.query('SELECT item_id, is_default FROM cf_definition_allowed_items WHERE definition_id = ? AND deleted_at IS NULL', [s1.id]);
  eq('old allowed list = the item entries', legacy1.map((r) => r.item_id), [b1]);
  const rec = await MR.getRecord(conn, COMPANY, s1.id);
  eq('the record counts branches and items', [rec.counts.branches, rec.counts.allowedItems], [2, 1]);
  const inUse = await refusal(() => MR.deleteRecord(conn, c, b1));
  ok('an item a selection picks from cannot be deleted, in words', /pick/.test(inUse?.message ?? ''), inUse?.message);
  const machineNode = await ins("INSERT INTO cf_classification_nodes (company_id, parent_id, depth, scope, code, name, status) VALUES (?, NULL, 0, 'machine', ?, ?, 'active')", [COMPANY, `${tag}MF`, `${tag} machines`]);
  ok('a machine family is refused', (await refusal(() => SEL.addEntry(conn, c, s4.id, { nodeId: machineNode })))?.code === 'MACHINE_BRANCH');

  /* ---- 5 --------------------------------------------------------------- */
  section('5. Migration: old rule = new rule');
  // Old-style selections written straight into the old columns (as before §42).
  const oldSel = async (mode, node, items, crits = []) => {
    const id = await ins('INSERT INTO cf_master_records (company_id, record_kind, code, name, classification_id, status, created_by) VALUES (?, \'definition\', ?, ?, ?, \'active\', ?)',
      [COMPANY, `${tag}-OLD${++seq}`, `${tag} old ${seq}`, defVar, c.userId]);
    await conn.query("INSERT INTO cf_definition_details (master_id, company_id, definition_type, selection_mode, candidate_classification_id) VALUES (?, ?, 'selection', ?, ?)", [id, COMPANY, mode, node]);
    for (const [i, [it, def]] of items.entries()) await conn.query('INSERT INTO cf_definition_allowed_items (company_id, definition_id, item_id, is_default, sort_order) VALUES (?, ?, ?, ?, ?)', [COMPANY, id, it, def ? 1 : 0, i + 1]);
    for (const v of crits) await crit(id, v);
    return id;
  };
  // The OLD rule, written out here once more (selectionService before §42).
  const oldRule = async (id) => {
    const [[d]] = await conn.query('SELECT selection_mode AS mode, candidate_classification_id AS node FROM cf_definition_details WHERE master_id = ?', [id]);
    const [cr] = await conn.query('SELECT value_number FROM cf_selection_criteria WHERE definition_id = ? AND deleted_at IS NULL', [id]);
    const where = ["m.company_id = ?", "m.status = 'active'", "i.item_type = 'catalog'", 'm.deleted_at IS NULL'];
    const params = [COMPANY];
    if (d.node && d.mode !== 'allowed_list') { where.push('m.classification_id IN (?)'); params.push(await SEL.subtreesOf(conn, COMPANY, [d.node])); }
    if (d.mode !== 'spec_match') { where.push('m.id IN (SELECT item_id FROM cf_definition_allowed_items WHERE definition_id = ? AND deleted_at IS NULL)'); params.push(id); }
    if (d.mode !== 'allowed_list') {
      if (!cr.length) return [];
      where.push(`EXISTS (SELECT 1 FROM cf_spec_values v WHERE v.subject_type = 'master' AND v.subject_id = m.id AND v.specification_id = ? AND v.deleted_at IS NULL AND v.value_number IN (?))`);
      params.push(SPEC, cr.map((r) => Number(r.value_number)));
    }
    const [rows] = await conn.query(`SELECT m.id FROM cf_master_records m JOIN cf_item_details i ON i.master_id = m.id WHERE ${where.join(' AND ')} ORDER BY m.id`, params);
    return rows.map((r) => r.id);
  };
  const cases = {
    'allowed_list (its node was ignored)': await oldSel('allowed_list', GS, [[a1, true], [b1, false]]),
    'allowed_list, no node': await oldSel('allowed_list', null, [[c1, false]]),
    'spec_match + node + filter': await oldSel('spec_match', F, [], [20]),
    'spec_match, no node (whole catalog) + filter': await oldSel('spec_match', null, [], [20]),
    'both + node, items inside it (and one outside)': await oldSel('both', F, [[a1, true], [a2, false], [c1, false]], [20, 30]),
    'both, no node + filter': await oldSel('both', null, [[a1, false], [c1, false], [b1, false]], [20]),
  };
  const oldSets = {};
  for (const [k, id] of Object.entries(cases)) oldSets[k] = await oldRule(id);
  // Before migrating, a selection with no entry reads its old columns the same way.
  for (const [k, id] of Object.entries(cases)) eq(`fallback (no entries yet) = old rule: ${k}`, ids(await SEL.findCandidates(conn, COMPANY, id, { limit: 1000 })), oldSets[k]);
  ok(`the migration has ${MIGRATION.length} INSERT statements and nothing else`, MIGRATION.length === 3);
  const [[{ n: scopeBefore }]] = await conn.query('SELECT COUNT(*) AS n FROM cf_selection_scope WHERE company_id = ?', [COMPANY]);
  for (const sql of MIGRATION) await conn.query(sql);
  const [[{ n: scopeMid }]] = await conn.query('SELECT COUNT(*) AS n FROM cf_selection_scope WHERE company_id = ?', [COMPANY]);
  for (const sql of MIGRATION) await conn.query(sql);
  const [[{ n: scopeAfter }]] = await conn.query('SELECT COUNT(*) AS n FROM cf_selection_scope WHERE company_id = ?', [COMPANY]);
  ok(`the migration wrote entries (${Number(scopeMid) - Number(scopeBefore)})`, Number(scopeMid) > Number(scopeBefore));
  eq('a second run adds nothing (idempotent)', Number(scopeAfter), Number(scopeMid));
  for (const [k, id] of Object.entries(cases)) eq(`migrated = old rule: ${k}`, ids(await SEL.findCandidates(conn, COMPANY, id, { limit: 1000 })), oldSets[k]);
  const entriesOf = async (id) => (await conn.query('SELECT node_id, item_id, is_default FROM cf_selection_scope WHERE definition_id = ? ORDER BY sort_order, id', [id]))[0];
  eq('allowed_list → item entries only, the star kept', (await entriesOf(cases['allowed_list (its node was ignored)'])).map((e) => [e.node_id, e.item_id, e.is_default]), [[null, a1, 1], [null, b1, 0]]);
  eq('spec_match + node → the node entry', (await entriesOf(cases['spec_match + node + filter'])).map((e) => e.node_id), [F]);
  eq('both + node → only the items inside the node (narrowest faithful)', (await entriesOf(cases['both + node, items inside it (and one outside)'])).map((e) => e.item_id), [a1, a2]);
  ok('spec_match, no node → one entry per top-level item branch', (await entriesOf(cases['spec_match, no node (whole catalog) + filter'])).every((e) => e.node_id != null && e.item_id == null));
  // An emptied selection stays empty on a re-run.
  const emptied = cases['allowed_list, no node'];
  for (const e of (await SEL.getSelection(conn, COMPANY, emptied)).entries) await SEL.removeEntry(conn, c, e.id);
  for (const sql of MIGRATION) await conn.query(sql);
  eq('a selection emptied on purpose is not refilled by a re-run', (await entriesOf(emptied)).length, 0);
  eq('…nor by the fallback', (await SEL.findCandidates(conn, COMPANY, emptied)).total, 0);
  // Old callers: allowed-list ids and calls still work.
  const oldApi = await oldSel('allowed_list', GS, [[a1, false], [b1, false]]);
  const viaOld = await SEL.getSelection(conn, COMPANY, oldApi, { c });
  ok('reading with a transaction adopts the old list as entries', (await entriesOf(oldApi)).length === 2);
  const [[legacyB1]] = await conn.query('SELECT id FROM cf_definition_allowed_items WHERE definition_id = ? AND item_id = ? AND deleted_at IS NULL', [oldApi, b1]);
  eq('allowedItems carry the old row ids', viaOld.allowedItems.find((a) => a.itemId === b1)?.id, legacyB1.id);
  const starred = await SEL.setDefaultAllowed(conn, c, legacyB1.id);
  ok('setDefaultAllowed (old id) stars the entry', starred.entries.find((e) => e.itemId === b1)?.isDefault === true);
  const [[candAfter]] = await conn.query('SELECT candidate_classification_id AS n FROM cf_definition_details WHERE master_id = ?', [oldApi]);
  eq('an items-only selection keeps its old "search area" column (cut plates find their selection by it)', candAfter.n, GS);
  const added = await SEL.addAllowedItem(conn, c, oldApi, { itemId: c1 });
  ok('addAllowedItem adds an item entry, unstarred unless asked', added.entries.find((e) => e.itemId === c1)?.isDefault === false);

  /* ---- 6 --------------------------------------------------------------- */
  section('6. Auto-fill on an order line');
  const selDefault = await selection({ scope: [{ nodeId: V1 }, { itemId: b1 }] });       // b1 starred (first item), 3 candidates
  const selOne = await selection({ scope: [{ itemId: c1, isDefault: false }] });           // exactly one candidate, no star
  const selTwo = await selection({ scope: [{ nodeId: V1 }] });                             // two candidates, no star
  for (const s of [selDefault, selOne, selTwo]) await MR.setStatus(conn, c, s.id, 'active');
  const tpl = await ins('INSERT INTO cf_master_records (company_id, record_kind, code, name, short_name, classification_id, status, created_by) VALUES (?, \'definition\', ?, ?, \'ASM\', ?, \'active\', ?)',
    [COMPANY, `${tag}-TPL`, `${tag} assembly`, defVar, c.userId]);
  await conn.query("INSERT INTO cf_definition_details (master_id, company_id, definition_type) VALUES (?, ?, 'template')", [tpl, COMPANY]);
  const tplBom = await ins("INSERT INTO cf_boms (company_id, parent_id, bom_type, status, created_by) VALUES (?, ?, 'template', 'active', ?)", [COMPANY, tpl, c.userId]);
  for (const [i, s] of [selDefault, selOne, selTwo].entries()) {
    await conn.query('INSERT INTO cf_bom_lines (company_id, bom_id, line_no, child_id, design_id, position, quantity, created_by) VALUES (?, ?, ?, ?, ?, 1, 2, ?)', [COMPANY, tplBom, (i + 1) * 10, s.id, s.id, c.userId]);
  }
  const orderId = await ins("INSERT INTO cf_sales_orders (company_id, code, order_type, title, status, created_by) VALUES (?, ?, 'customer', 'Selection scope fixture', 'inquiry', ?)", [COMPANY, `${tag}-SO`, c.userId]);
  await S.addOrderLine(conn, c, orderId, { recordId: tpl, quantity: 1 });
  const [[ol]] = await conn.query('SELECT id, item_id FROM cf_sales_order_lines WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL', [COMPANY, orderId]);
  const rowsOf = async () => (await conn.query(
    `SELECT l.id, l.selection_definition_id AS sel, l.child_id, l.auto_chosen FROM cf_bom_lines l JOIN cf_boms b ON b.id = l.bom_id
      WHERE b.parent_id = ? AND l.deleted_at IS NULL AND l.selection_definition_id IS NOT NULL ORDER BY l.line_no`, [ol.item_id]))[0];
  let rows = await rowsOf();
  const rowOf = (sel) => rows.find((r) => r.sel === sel.id);
  ok('the default (b1) is chosen and marked automatic', rowOf(selDefault).child_id === b1 && rowOf(selDefault).auto_chosen === 1, JSON.stringify(rowOf(selDefault)));
  ok('the only candidate (c1) is chosen and marked automatic', rowOf(selOne).child_id === c1 && rowOf(selOne).auto_chosen === 1);
  ok('two candidates and no default: left to a person', rowOf(selTwo).child_id === selTwo.id && rowOf(selTwo).auto_chosen == null);
  let tree = await B.explode(conn, COMPANY, ol.item_id);
  const nodeOf = (t, sel) => t.root.children.find((n) => n.selection?.id === sel.id);
  ok('the tree marks the automatic rows (default · change)', nodeOf(tree, selDefault).autoChosen === true && nodeOf(tree, selOne).autoChosen === true && nodeOf(tree, selTwo).autoChosen === false);
  eq('one row to choose', tree.stats.unresolved, 1);
  // A person chooses: final.
  await B.resolveLine(conn, c, rowOf(selTwo).id, { itemId: a2 });
  await B.resolveLine(conn, c, rowOf(selDefault).id, { itemId: a1 });
  rows = await rowsOf();
  ok('a person\'s choice clears the automatic mark', rowOf(selTwo).auto_chosen === 0 && rowOf(selDefault).child_id === a1 && rowOf(selDefault).auto_chosen === 0);
  // A person clears one: never refilled.
  await B.resolveLine(conn, c, rowOf(selOne).id, { itemId: null });
  await S.lineStructure(conn, COMPANY, ol.id, { c });
  rows = await rowsOf();
  ok('a choice a person cleared is not refilled on the next read', rowOf(selOne).child_id === selOne.id && rowOf(selOne).auto_chosen === 0);
  // An old row nobody touched (auto_chosen NULL, still the definition): filled on the next read…
  const rootBom = (await conn.query('SELECT id FROM cf_boms WHERE parent_id = ? AND deleted_at IS NULL', [ol.item_id]))[0][0].id;
  const oldRow = await insertLine(conn, c, { bomId: rootBom, lineNo: 900, childId: selDefault.id, designId: selDefault.id, position: 9, quantity: 1, selectionDefinitionId: selDefault.id });
  const read = await S.lineStructure(conn, COMPANY, ol.id, { c });
  const [[oldNow]] = await conn.query('SELECT child_id, auto_chosen FROM cf_bom_lines WHERE id = ?', [oldRow]);
  ok('an untouched old row is filled on the next structure read', oldNow.child_id === b1 && oldNow.auto_chosen === 1, JSON.stringify(oldNow));
  ok('…and the read already shows it chosen', read.root.children.find((n) => n.lineId === oldRow)?.autoChosen === true);
  // …and on the next save (withCutPieces runs after every structure / value save).
  const oldRow2 = await insertLine(conn, c, { bomId: rootBom, lineNo: 910, childId: selOne.id, designId: selOne.id, position: 10, quantity: 1, selectionDefinitionId: selOne.id });
  await CP.withCutPieces(conn, c, ol.id, {});
  const [[old2]] = await conn.query('SELECT child_id, auto_chosen FROM cf_bom_lines WHERE id = ?', [oldRow2]);
  ok('…and on the next save', old2.child_id === c1 && old2.auto_chosen === 1);
  // addLine on a custom BOM picks too.
  await B.addLine(conn, c, ol.item_id, { childId: selOne.id, quantity: 1 });
  rows = await rowsOf();
  ok('a selection added by hand starts with its automatic pick', rows.some((r) => r.sel === selOne.id && r.child_id === c1 && r.auto_chosen === 1 && r.id !== oldRow2));
  // A locked line is never touched.
  const oldRow3 = await insertLine(conn, c, { bomId: rootBom, lineNo: 977, childId: selOne.id, designId: selOne.id, position: 31, quantity: 1, selectionDefinitionId: selOne.id });
  await conn.query('UPDATE cf_sales_order_lines SET locked_at = NOW() WHERE id = ?', [ol.id]);
  const lockedFill = await SEL.autofillLineSelections(conn, c, ol.id);
  eq('a frozen line is never auto-filled', lockedFill.filled, 0);
  await conn.query('UPDATE cf_sales_order_lines SET locked_at = NULL WHERE id = ?', [ol.id]);
  await conn.query('UPDATE cf_bom_lines SET auto_chosen = 0 WHERE id = ?', [oldRow3]);   // left unresolved by "a person" for section 7

  /* ---- 7 --------------------------------------------------------------- */
  section('7. A cut plate\'s raw plate: never auto-filled, never counted');
  const [[cutNode]] = await conn.query("SELECT id FROM cf_classification_nodes WHERE company_id = ? AND code = 'CUT_PLATE' AND deleted_at IS NULL", [COMPANY]);
  ok('this company has a CUT_PLATE node', !!cutNode);
  const cutItem = await ins('INSERT INTO cf_master_records (company_id, record_kind, code, name, classification_id, status, created_by) VALUES (?, \'item\', ?, ?, ?, \'draft\', ?)',
    [COMPANY, `${tag}-CUT`, `${tag} cut plate`, cutNode.id, c.userId]);
  await conn.query("INSERT INTO cf_item_details (master_id, company_id, item_type, tracked_by, uom, sourcing, owner_order_line_id) VALUES (?, ?, 'temporary', 'individual', 'nos', 'make', ?)", [cutItem, COMPANY, ol.id]);
  await insertLine(conn, c, { bomId: rootBom, lineNo: 988, childId: cutItem, designId: cutItem, position: 1, quantity: 1 });
  const cutBom = await ins("INSERT INTO cf_boms (company_id, parent_id, bom_type, status, created_by) VALUES (?, ?, 'custom', 'draft', ?)", [COMPANY, cutItem, c.userId]);
  const plateRow = await insertLine(conn, c, { bomId: cutBom, lineNo: 10, childId: selOne.id, designId: selOne.id, position: 1, quantity: 1, selectionDefinitionId: selOne.id });
  const fill = await SEL.autofillLineSelections(conn, c, ol.id);
  const [[plateNow]] = await conn.query('SELECT child_id, auto_chosen FROM cf_bom_lines WHERE id = ?', [plateRow]);
  ok('a selection under a cut plate is NOT filled, even with one candidate', plateNow.child_id === selOne.id && plateNow.auto_chosen == null && fill.filled === 0, JSON.stringify({ plateNow, fill }));
  ok('…not on a read either', (await S.lineStructure(conn, COMPANY, ol.id, { c }), (await conn.query('SELECT child_id FROM cf_bom_lines WHERE id = ?', [plateRow]))[0][0].child_id === selOne.id));
  await B.addLine(conn, c, cutItem, { childId: selOne.id, quantity: 1 });
  const [[{ n: unchosenUnderCut }]] = await conn.query("SELECT COUNT(*) AS n FROM cf_bom_lines WHERE bom_id = ? AND child_id = ? AND auto_chosen IS NULL AND deleted_at IS NULL", [cutBom, selOne.id]);
  eq("a selection added by hand under a cut plate starts unchosen (both plate rows still the selection)", Number(unchosenUnderCut), 2);
  tree = await B.explode(conn, COMPANY, ol.item_id);
  const cutNodeInTree = tree.root.children.find((n) => n.id === cutItem);
  ok('the tree marks the plate row underCutPlate', cutNodeInTree?.children.every((k) => k.underCutPlate === true));
  const personRows = tree.root.children.filter((n) => n.selection && !n.resolved).length;
  eq('the tree counts only the rows a person chooses', tree.stats.unresolved, personRows);
  eq('…which is 2 here (the cleared one and the one left)', tree.stats.unresolved, 2);
  const order = await S.getOrder(conn, COMPANY, orderId);
  eq('the order lines count the same', order.lines.find((l) => l.id === ol.id)?.structure?.unresolvedSelections, tree.stats.unresolved);
  eq('getBom of the cut plate counts nothing to choose', (await B.getBom(conn, COMPANY, cutItem)).unresolvedSelections, 0);
  eq('getBom of the line item counts its own rows', (await B.getBom(conn, COMPANY, ol.item_id)).unresolvedSelections, 2);
  const [[proc]] = await conn.query("SELECT id FROM cf_processes WHERE company_id = ? AND status = 'active' AND deleted_at IS NULL ORDER BY id LIMIT 1", [COMPANY]);
  if (proc) {
    await conn.query('UPDATE cf_sales_orders SET process_id = ? WHERE id = ?', [proc.id, orderId]);
    const op = await PROC.orderProcess(conn, COMPANY, orderId);
    const stage = (key) => op.lines.find((l) => l.lineId === ol.id)?.stages.find((s) => s.stageKey === key);
    const chooseBlocker = (key) => (stage(key)?.blockers ?? []).find((b) => /item chosen/.test(b.message))?.count ?? 0;
    eq('the structure blocker counts the same', chooseBlocker('structure'), tree.stats.unresolved);
    eq('the freeze blocker counts the same', chooseBlocker('lock'), tree.stats.unresolved);
  } else ok('a process to read the blocker with', false, 'no active process in this company');
} catch (e) {
  failed++;
  exitCode = 1;
  console.log(`  FAIL  CRASH ${e.code ?? ''} ${e.message}`);
  console.log(e.stack);
} finally {
  await conn.rollback();
  conn.release();
}
const after = await counts();
const changed = after.filter((r, i) => Number(r.n) !== Number(before[i]?.n));
ok('every cf_ table is back to its count', changed.length === 0, JSON.stringify(changed));
console.log(`\n${passed} passed, ${failed} failed`);
await pool.end();
process.exit(failed ? 1 : exitCode);
