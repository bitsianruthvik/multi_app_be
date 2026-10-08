/**
 * bom_codes_test.mjs — a catalog item's or definition's BOM is coded the way an
 * order codes its rows (placeholderService.recordBomCodes, sharing codeDesigns
 * and rollOutService.layOutPieces with an order line's placeholders). Against
 * the local DB.
 *
 *   cd multi_app_be
 *   node scripts/cf_kepl/bom_codes_test.mjs
 *   node scripts/cf_kepl/bom_codes_test.mjs --save  <file>   # capture order line 923's placeholders
 *   node scripts/cf_kepl/bom_codes_test.mjs --check <file>   # and prove they are byte-identical now
 *
 * User, 2026-10-01: "instead of copying, just reference the same. Even if it is
 * same item twice it is ok, keep the same name. We will be generating separate
 * codes for each of them … the way it is in sales order, we should have the
 * same for a catalog item".
 *
 * EVERYTHING HAPPENS INSIDE ONE TRANSACTION THAT IS ROLLED BACK, and the tables
 * it writes are recounted at the end. It builds its OWN fixture (classification,
 * definitions, catalog items, an order) and its OWN production-piece coding rule
 * — kind-free, but exact Variant + placement, which outweighs every rule the
 * company has — so the expected codes do not depend on tenant rules. The --check
 * part borrows line 923 on purpose: it is the real KEPL structure.
 *
 * ok(label, cond) — the label FIRST, and only (string, boolean).
 */
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
const { attachNodeCache, detachNodeCache } = await imp('apps/cf_erp/lib/db.js');
await imp('apps/cf_erp/services/codegenProvider.js'); // registers the code-generator entities, as app.js does
const P = await imp('apps/cf_erp/services/placeholderService.js');
const B = await imp('apps/cf_erp/services/bomService.js');
const S = await imp('apps/cf_erp/services/salesOrderService.js');

const COMPANY = Number(process.env.CF_BOMCODES_COMPANY ?? 2);
const GOLDEN_LINE = Number(process.env.CF_BOMCODES_LINE ?? 923);
const arg = (flag) => { const i = process.argv.indexOf(flag); return i > 0 ? process.argv[i + 1] : null; };
const SAVE = arg('--save');
const CHECK = arg('--check');

let passed = 0;
let failed = 0;
const fails = [];
function ok(label, cond, detail = '') {
  if (typeof label !== 'string' || typeof cond !== 'boolean') {
    throw new Error(`ok(label, cond) takes a string and then a boolean — got ok(${typeof label}, ${typeof cond})`);
  }
  if (cond) { passed += 1; console.log(`  PASS  ${label}`); }
  else { failed += 1; fails.push(label); console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
}
const same = (got, want) => JSON.stringify(got) === JSON.stringify(want);
const eq = (label, got, want) => ok(label, same(got, want), `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
const section = (s) => console.log(`\n${s}`);
const refusal = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

const COUNTED = [
  'cf_classification_nodes', 'cf_master_records', 'cf_item_details', 'cf_definition_details',
  'cf_boms', 'cf_bom_lines', 'cf_sales_orders', 'cf_sales_order_lines', 'cf_order_pieces',
  'cf_code_schemes', 'cf_code_scheme_segments', 'cf_code_scheme_conditions', 'cf_code_sequences',
];
async function counts(db) {
  const out = {};
  for (const t of COUNTED) { const [[r]] = await db.query(`SELECT COUNT(*) AS n FROM \`${t}\``); out[t] = Number(r.n); }
  return out;
}

/* ---- the golden: order line 923's placeholders, before and after --------- */
if (SAVE || CHECK) {
  section(`Order line ${GOLDEN_LINE}: placeholders byte-identical to the snapshot`);
  const got = await P.linePlaceholders(pool, COMPANY, GOLDEN_LINE);
  if (SAVE) {
    fs.writeFileSync(SAVE, JSON.stringify({ [GOLDEN_LINE]: got }));
    console.log(`  saved ${got.rows.length} rows to ${SAVE}`);
  } else {
    const file = JSON.parse(fs.readFileSync(CHECK, 'utf8'));
    const want = file[GOLDEN_LINE] ?? file;
    ok(`line ${GOLDEN_LINE} has rows to compare (${got.rows.length})`, got.rows.length > 0);
    eq('the same number of rows', got.rows.length, want.rows.length);
    ok('every row, code, range, piece count, position and missing list is byte-identical', JSON.stringify(got) === JSON.stringify(want),
      (() => { const i = got.rows.findIndex((r, k) => JSON.stringify(r) !== JSON.stringify(want.rows[k])); return i < 0 ? 'outside the rows' : `first difference at row ${i}: ${JSON.stringify(want.rows[i])} -> ${JSON.stringify(got.rows[i])}`; })());
  }
}

/* ---- the fixture ---------------------------------------------------------- */
async function buildFixture(db, c) {
  const tag = `BCD${Date.now().toString(36).toUpperCase()}`;
  const ins = async (sql, params) => (await db.query(sql, params))[0].insertId;
  const node = (parentId, depth, key) => ins(
    "INSERT INTO cf_classification_nodes (company_id, parent_id, depth, scope, code, name, status) VALUES (?, ?, ?, 'both', ?, ?, 'active')",
    [COMPANY, parentId, depth, `${tag}-${key}`, `${tag} ${key} — bom codes test`],
  );
  const fam = await node(null, 0, 'F');
  const sub = await node(fam, 1, 'S');
  const variant = await node(sub, 2, 'V');
  const master = async (kind, key, name, short, { code = `${tag}-${key}`, status = 'active' } = {}) => {
    const id = await ins(
      'INSERT INTO cf_master_records (company_id, record_kind, code, name, short_name, classification_id, status, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [COMPANY, kind === 'catalog' ? 'item' : 'definition', code, name, short, variant, status, c.userId],
    );
    if (kind === 'catalog') await db.query("INSERT INTO cf_item_details (master_id, company_id, item_type, tracked_by, uom, sourcing) VALUES (?, ?, 'catalog', 'quantity', 'nos', 'stock')", [id, COMPANY]);
    else await db.query('INSERT INTO cf_definition_details (master_id, company_id, definition_type, selection_mode) VALUES (?, ?, ?, NULL)', [id, COMPANY, kind]);
    return id;
  };
  const bomOf = (parentId, bomType) => ins("INSERT INTO cf_boms (company_id, parent_id, bom_type, status, created_by) VALUES (?, ?, ?, 'active', ?)", [COMPANY, parentId, bomType, c.userId]);
  const line = (bomId, lineNo, childId, qty, position = 1) => ins(
    'INSERT INTO cf_bom_lines (company_id, bom_id, line_no, child_id, design_id, position, quantity, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [COMPANY, bomId, lineNo, childId, childId, position, qty, c.userId],
  );

  // The fixture's own piece rule: {parent.code}-{item.shortName}{piece.seq}.
  const scheme = await ins(
    "INSERT INTO cf_code_schemes (company_id, code, name, entity_type, target_field, seq_scope, priority, status) VALUES (?, ?, 'Bom codes test', 'production_piece', 'code', 'prefix', 0, 'active')",
    [COMPANY, `${tag}-PC`],
  );
  for (const [k, v] of [['placement', 'component'], ['classification', String(variant)]]) {
    await db.query("INSERT INTO cf_code_scheme_conditions (company_id, scheme_id, token_key, operator, value) VALUES (?, ?, ?, 'eq', ?)", [COMPANY, scheme, k, v]);
  }
  for (const [i, [type, token, literal]] of [['token', 'parent.code'], ['literal', null, '-'], ['token', 'item.shortName'], ['token', 'piece.seq']].entries()) {
    await db.query(
      'INSERT INTO cf_code_scheme_segments (company_id, scheme_id, sort_order, segment_type, literal_text, token_key, format) VALUES (?, ?, ?, ?, ?, ?, NULL)',
      [COMPANY, scheme, i + 1, type, literal ?? null, token ?? null],
    );
  }

  // Definitions: a girder holding the SAME segment twice, a web row of 3, and
  // two stiffeners each made of a plate.
  const PLT = await master('template', 'PLT', 'Stiffener plate', 'PLT');
  const STIFF = await master('template', 'IS', 'Intermediate stiffener', 'IS');
  const WEB = await master('template', 'WEB', 'Web plate', 'WEB');
  const SEG = await master('template', 'SEG', 'Girder segment', 'SEG');
  const GIRDER = await master('template', 'GDR', 'Girder', 'GDR');
  await line(await bomOf(STIFF, 'template'), 10, PLT, 1);
  await line(await bomOf(SEG, 'template'), 10, WEB, 2);
  const gdrBom = await bomOf(GIRDER, 'template');
  await line(gdrBom, 10, SEG, 1, 1);
  await line(gdrBom, 20, SEG, 1, 2);
  await line(gdrBom, 30, WEB, 3);
  await line(gdrBom, 40, STIFF, 2);

  // A catalog kit: the same bolt on two rows (4 then 2), and a washer.
  const BOLT = await master('catalog', 'BOLT', 'Test bolt', 'BLT');
  const WSH = await master('catalog', 'WSH', 'Test washer', 'WSH');
  const KIT = await master('catalog', 'KIT', 'Test bracket kit', 'KIT');
  const kitBom = await bomOf(KIT, 'standard');
  await line(kitBom, 10, BOLT, 4, 1);
  await line(kitBom, 20, BOLT, 2, 2);
  await line(kitBom, 30, WSH, 1);

  // A draft definition with no code yet, built through the Add route's service.
  const DRAFT = await master('template', 'DRAFT', 'Draft frame', 'DF', { code: null, status: 'draft' });

  return { tag, variant, PLT, STIFF, WEB, SEG, GIRDER, BOLT, WSH, KIT, DRAFT };
}

/** Row codes by where they sit: "Name/Name" paths (with the nth sibling of a name) -> code. */
async function codesByPath(db, recordId, codes) {
  const tree = await B.explode(db, COMPANY, recordId, {});
  const byKey = new Map(codes.rows.map((r) => [r.key, r]));
  const out = {};
  const walk = (n, prefix) => {
    const seen = new Map();
    for (const k of n.children) {
      const nth = (seen.get(k.name) ?? 0) + 1;
      seen.set(k.name, nth);
      const p = `${prefix}${k.name}${nth > 1 ? `#${nth}` : ''}`;
      out[p] = byKey.get(k.key)?.code ?? null;
      walk(k, `${p}/`);
    }
  };
  walk(tree.root, '');
  return { out, tree, byKey };
}

/* ---- the run --------------------------------------------------------------- */
const [[user]] = await pool.query('SELECT id FROM users WHERE company_id = ? ORDER BY id LIMIT 1', [COMPANY]);
const c = { companyId: COMPANY, userId: user?.id ?? null };
const before = await counts(pool);
const conn = await pool.getConnection();
await conn.beginTransaction();
attachNodeCache(conn);
try {
  section('1. A definition with the same child twice: two rows, two codes');
  const f = await buildFixture(conn, c);
  const gdr = await P.recordBomCodes(conn, COMPANY, f.GIRDER);
  // A definition is known by its short name (user, 2026-10-08), not its code ${f.tag}-GDR.
  const G = 'GDR';
  eq('the top is the definition’s short name, not its code', gdr.rootCode, G);
  const { out: g, byKey } = await codesByPath(conn, f.GIRDER, gdr);
  eq('the first segment row', g['Girder segment'], `${G}-SEG1`);
  eq('the same segment again — its own code, counted on', g['Girder segment#2'], `${G}-SEG2`);
  ok('the two uses of one record get different codes', g['Girder segment'] !== g['Girder segment#2']);
  eq('a sub-BOM shared by both is coded once under each (first)', g['Girder segment/Web plate'], `${G}-SEG1-WEB1-2`);
  eq('… and under the second', g['Girder segment#2/Web plate'], `${G}-SEG2-WEB1-2`);
  eq('a leaf row of 3 is a range, as an order prints a group', g['Web plate'], `${G}-WEB1-3`);
  eq('a row of 2 with parts of its own is made piece by piece: # for its number', g['Intermediate stiffener'], `${G}-IS#`);
  eq('… and its children carry the #', g['Intermediate stiffener/Stiffener plate'], `${G}-IS#-PLT1`);
  const isRow = [...byKey.values()].find((r) => r.code === `${G}-IS#`);
  eq('the # runs over 1–2 under the girder', isRow?.seqRange, [1, 2]);
  eq('… and the row stands for 2 pieces', isRow?.pieces, 2);
  eq('nothing is missing, nothing is a problem', [gdr.missing.length, gdr.problems.length], [0, 0]);

  section('2. A catalog item: physical numbering across rows of one short name');
  const kit = await P.recordBomCodes(conn, COMPANY, f.KIT);
  const K = `${f.tag}-KIT`;
  const { out: k } = await codesByPath(conn, f.KIT, kit);
  eq('bolts ×4 are 1–4', k['Test bolt'], `${K}-BLT1-4`);
  eq('the same bolt again ×2 carries on: 5–6', k['Test bolt#2'], `${K}-BLT5-6`);
  eq('a row of its own short name starts at 1', k['Test washer'], `${K}-WSH1`);

  section('3. Repeats are allowed freely — no name asked for');
  await B.addLine(conn, c, f.DRAFT, { childId: f.SEG, quantity: 1 });
  const rep = await refusal(() => B.addLine(conn, c, f.DRAFT, { childId: f.SEG, quantity: 1 }));
  ok('the same child again with no name is added (no USE_NAME_REQUIRED)', rep === null, rep ? `${rep.code}: ${rep.message}` : '');
  const [roles] = await conn.query(
    'SELECT l.role FROM cf_bom_lines l JOIN cf_boms b ON b.id = l.bom_id WHERE b.parent_id = ? AND l.deleted_at IS NULL ORDER BY l.line_no', [f.DRAFT],
  );
  eq('both lines keep the child’s own name (no role)', roles.map((r) => r.role), [null, null]);
  const dr = await P.recordBomCodes(conn, COMPANY, f.DRAFT);
  eq('a draft with no code yet is topped by its short name', dr.rootCode, 'DF');
  const { out: d } = await codesByPath(conn, f.DRAFT, dr);
  eq('… and its two rows are told apart by code', [d['Girder segment'], d['Girder segment#2']], ['DF-SEG1', 'DF-SEG2']);

  section('4. Nothing is minted: the codes are a preview');
  const [[seqs]] = await conn.query('SELECT COUNT(*) AS n FROM cf_code_sequences WHERE company_id = ?', [COMPANY]);
  await P.recordBomCodes(conn, COMPANY, f.GIRDER);
  const [[seqs2]] = await conn.query('SELECT COUNT(*) AS n FROM cf_code_sequences WHERE company_id = ?', [COMPANY]);
  eq('no running number moved', Number(seqs2.n), Number(seqs.n));
  const [[codeNow]] = await conn.query('SELECT code FROM cf_master_records WHERE id = ?', [f.DRAFT]);
  eq('the draft still has no code of its own', codeNow.code, null);

  section('5. Orders and catalog BOMs print the same codes for the same tree');
  const orderId = (await conn.query("INSERT INTO cf_sales_orders (company_id, code, order_type, title, status, created_by) VALUES (?, ?, 'customer', 'Bom codes fixture', 'inquiry', ?)", [COMPANY, `${f.tag}-SO`, c.userId]))[0].insertId;
  await S.addOrderLine(conn, c, orderId, { recordId: f.GIRDER, quantity: 1 });
  const [[ol]] = await conn.query('SELECT id, item_id FROM cf_sales_order_lines WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL', [COMPANY, orderId]);
  const ph = await P.linePlaceholders(conn, COMPANY, ol.id);
  const top = ph.rows.find((r) => r.bomLineId == null)?.code;
  ok(`the order line has a top code (${top})`, typeof top === 'string' && top.length > 0);
  const phByKey = new Map(ph.rows.map((r) => [r.bomLineId != null ? `l${r.bomLineId}` : `i${r.itemId}`, r]));
  const orderTree = await B.explode(conn, COMPANY, ol.item_id, {});
  const orderSuffix = {};
  const walk = (n, prefix) => {
    const seen = new Map();
    for (const kid of n.children) {
      const nth = (seen.get(kid.name) ?? 0) + 1;
      seen.set(kid.name, nth);
      const p = `${prefix}${kid.name}${nth > 1 ? `#${nth}` : ''}`;
      const code = phByKey.get(`l${kid.lineId}`)?.code ?? null;
      orderSuffix[p] = code?.startsWith(top) ? code.slice(top.length) : code;
      walk(kid, `${p}/`);
    }
  };
  walk(orderTree.root, '');
  const catalogSuffix = Object.fromEntries(Object.entries(g).map(([p, code]) => [p, code?.startsWith(G) ? code.slice(G.length) : code]));
  eq('every row: the same code after the top', orderSuffix, catalogSuffix);
  await conn.rollback();
  console.log('\nrolled back.');
} catch (err) {
  try { await conn.rollback(); } catch { /* the original error matters */ }
  failed += 1;
  fails.push('the run itself');
  console.error('\nTHREW:', err.code ?? '', err.message);
  console.error(err.stack?.split('\n').slice(1, 8).join('\n'));
} finally {
  detachNodeCache(conn);
  conn.release();
}

section('6. Nothing survived the rollback');
const after = await counts(pool);
const left = COUNTED.filter((t) => before[t] !== after[t]).map((t) => `${t} ${before[t]}->${after[t]}`);
ok('every table it wrote is back to the count it started at', left.length === 0, left.join(', '));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) console.log(`failed: ${fails.join(' · ')}`);
await pool.end();
process.exitCode = failed ? 1 : 0;
