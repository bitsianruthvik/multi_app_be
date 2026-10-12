/**
 * link_fixture.mjs — the fixture the linked-copies suites share (link_groups_test,
 * link_drawings_test and the additions to order_values / bom_changes / revision / order_sheet).
 *
 * IT OWNS EVERYTHING IT BUILDS — classification, specifications, formulas, a catalog item,
 * templates, a customer, an order and its lines — every name and code carrying the run tag, inside
 * the caller's transaction. It borrows nothing of the tenant's except the SPECIFICATIONS the
 * services themselves read BY CODE (LENGTH, WIDTH, THICKNESS, GRADE, DRAWING_MARK, CUT_FROM): those
 * are looked up by code, never by id, and only RULES of this run's own are hung on them.
 *
 *   line (quantity `quantity`)
 *     Girder              assembly   (template G)
 *       Segment ×1        assembly   (template S)      — own values: COAT (entered)
 *         Flange ×2       plate part                   — LENGTH, WIDTH, THICKNESS, GRADE, DRAWING_MARK,
 *         Web ×1          plate part                     WT (calculated), AREA (a formula a person may
 *         … `parts` more plate parts (P3…)               type over), COAT (inherited from the segment)
 *         Bolt ×8         catalog item
 *
 * → { tag, order, line, lineId, spec: { LEN, WID, THK, GRD, MARK, CUT, WT, AREA, COAT, SUM }, nodes,
 *     templates, tree(), rows() }
 */
import * as CLS from '../../apps/cf_erp/services/classificationService.js';
import * as MR from '../../apps/cf_erp/services/masterRecordService.js';
import * as B from '../../apps/cf_erp/services/bomService.js';
import * as SO from '../../apps/cf_erp/services/salesOrderService.js';
import * as V from '../../apps/cf_erp/services/valueService.js';
import * as PARTIES from '../../apps/cf_erp/modules/parties/service.js';

export const COMPANY = Number(process.env.CF_LINK_COMPANY ?? 2);
export const newTag = (prefix) => `${prefix}${Date.now().toString(36).toUpperCase()}`;

const REAL = ['LENGTH', 'WIDTH', 'THICKNESS', 'GRADE', 'DRAWING_MARK', 'CUT_FROM'];

export async function buildLinkFixture(db, c, { tag, parts = 0, quantity = 1, lines = 1 } = {}) {
  const companyId = c.companyId;
  const ins = async (sql, params) => (await db.query(sql, params))[0].insertId;

  // ---- the tenant's own specifications the services read by code ---------------
  const [realRows] = await db.query('SELECT id, UPPER(code) AS code FROM cf_specifications WHERE company_id = ? AND deleted_at IS NULL AND code IN (?)', [companyId, REAL]);
  const real = Object.fromEntries(realRows.map((r) => [r.code, r.id]));
  // A company that has not got one yet (a test tenant) is given it for this transaction: the codes are the services' own.
  const SHAPE = { LENGTH: ['number', 'mm', 2], WIDTH: ['number', 'mm', 2], THICKNESS: ['number', 'mm', 2], GRADE: ['option', null, null, ['E250', 'E350']], DRAWING_MARK: ['text', null, null], CUT_FROM: ['option', null, null, ['PLATE', 'SECTION', 'NONE']] };
  for (const code of REAL) {
    if (real[code]) continue;
    const [type, uom, decimals, options] = SHAPE[code];
    real[code] = await ins("INSERT INTO cf_specifications (company_id, code, name, data_type, default_uom, decimals, status) VALUES (?, ?, ?, ?, ?, ?, 'active')", [companyId, code, code.charAt(0) + code.slice(1).toLowerCase().replace('_', ' '), type, uom, decimals]);
    for (const [i, value] of (options ?? []).entries()) await db.query("INSERT INTO cf_spec_options (company_id, specification_id, value, status, sort_order) VALUES (?, ?, ?, 'active', ?)", [companyId, real[code], value, i]);
  }

  // ---- classification: a family, a level, and the two kinds of row ----------------
  const fam = await CLS.createNode(db, c, { code: `${tag}-F`, name: `${tag} fabricated` });
  const mid = await CLS.createNode(db, c, { parentId: fam.id, code: `${tag}-M`, name: `${tag} kinds` });
  const asmNode = (await CLS.createNode(db, c, { parentId: mid.id, code: `${tag}-A`, name: `${tag} assembly` })).id;
  const plateNode = (await CLS.createNode(db, c, { parentId: mid.id, code: `${tag}-P`, name: `${tag} plate part` })).id;

  // ---- this run's own specifications and formulas ------------------------------------
  const ownSpec = async (key, dataType, uom = null, decimals = null) => {
    const code = `${tag}_${key}`;
    return { id: await ins("INSERT INTO cf_specifications (company_id, code, name, data_type, default_uom, decimals, status) VALUES (?, ?, ?, ?, ?, ?, 'active')", [companyId, code, `${key} (${tag})`, dataType, uom, decimals]), code };
  };
  const WT = await ownSpec('WT', 'number', 'kg', 3);
  const AREA = await ownSpec('AREA', 'number', 'mm2', 1);
  const COAT = await ownSpec('COAT', 'text');
  const SUM = await ownSpec('SUM', 'number', 'kg', 3);
  const HOW = await ownSpec('HOW', 'number', 'min', 1);   // a value a FLOW asks for: how it is made, not what it is
  const formula = (key, expression) => ins("INSERT INTO cf_formulas (company_id, code, name, expression, status) VALUES (?, ?, ?, ?, 'active')", [companyId, `${tag}_${key}`, `${key} (${tag})`, expression]);
  const fWt = await formula('WTCALC', 'LENGTH * WIDTH / 1000');
  const fArea = await formula('AREACALC', 'LENGTH * WIDTH');
  const fSum = await formula('WTSUM', `SUM(children.${WT.code})`);

  const rule = (subjectType, subjectId, specId, valueRule, { formulaId = null, sort = 0, origin = 'manual', required = 0 } = {}) => db.query(
    `INSERT INTO cf_spec_assignments (company_id, specification_id, subject_type, subject_id, capture_at, is_required, is_applicable, value_rule, formula_id, sort_order, origin)
     VALUES (?, ?, ?, ?, 'item', ?, 1, ?, ?, ?, ?)`,
    [companyId, specId, subjectType, subjectId, required, valueRule, formulaId, sort, origin],
  );
  // Every row: a drawing mark and how it is cut. Plate parts: their size, grade, weight and area.
  await rule('classification', fam.id, real.DRAWING_MARK, 'entered', { sort: 1 });
  await rule('classification', fam.id, real.CUT_FROM, 'defaulted', { sort: 2 });
  await rule('classification', plateNode, real.LENGTH, 'entered', { sort: 10 });
  await rule('classification', plateNode, real.WIDTH, 'entered', { sort: 11 });
  await rule('classification', plateNode, real.THICKNESS, 'entered', { sort: 12 });
  await rule('classification', plateNode, real.GRADE, 'entered', { sort: 13 });
  await rule('classification', plateNode, WT.id, 'calculated', { formulaId: fWt, sort: 20 });
  await rule('classification', plateNode, AREA.id, 'defaulted', { formulaId: fArea, sort: 21 });
  await rule('classification', plateNode, COAT.id, 'inherited', { sort: 22 });
  await rule('classification', asmNode, COAT.id, 'entered', { sort: 22 });
  await rule('classification', asmNode, SUM.id, 'rollup', { formulaId: fSum, sort: 23 });
  await V.setValues(db, c, 'classification', plateNode, [{ specCode: 'CUT_FROM', value: 'PLATE' }]);
  await V.setValues(db, c, 'classification', asmNode, [{ specCode: 'CUT_FROM', value: 'NONE' }]);

  // ---- a catalog item, and the templates ---------------------------------------------
  const boltId = await ins(
    "INSERT INTO cf_master_records (company_id, record_kind, code, name, short_name, classification_id, status, created_by) VALUES (?, 'item', ?, ?, ?, ?, 'active', ?)",
    [companyId, `${tag}-BOLT`, `${tag} bolt`, `${tag}B`.slice(0, 30), asmNode, c.userId],
  );
  await db.query("INSERT INTO cf_item_details (master_id, company_id, item_type, tracked_by, uom, sourcing) VALUES (?, ?, 'catalog', 'quantity', 'nos', 'stock')", [boltId, companyId]);

  const tpl = async (key, name, classificationId) => MR.setStatus(db, c, (await MR.createDefinition(db, c, {
    definitionType: 'template', classificationId, code: `${tag}-${key}`, name: `${tag} ${name}`, shortName: `${tag}${key}`.slice(0, 30),
  })).id, 'active');
  const flange = await tpl('TFL', 'Flange', plateNode);
  const web = await tpl('WPL', 'Web', plateNode);
  const extra = [];
  for (let i = 0; i < parts; i++) extra.push(await tpl(`P${i + 3}`, `Plate ${i + 3}`, plateNode));
  const seg = await tpl('GS', 'Segment', asmNode);
  await B.addLine(db, c, seg.id, { childId: flange.id, quantity: 2 });
  await B.addLine(db, c, seg.id, { childId: web.id, quantity: 1 });
  for (const t of extra) await B.addLine(db, c, seg.id, { childId: t.id, quantity: 1 });
  await B.addLine(db, c, seg.id, { childId: boltId, quantity: 8 });
  await B.setBomStatus(db, c, seg.id, 'active');
  const girder = await tpl('CG', 'Girder', asmNode);
  await B.addLine(db, c, girder.id, { childId: seg.id, quantity: 1 });
  await B.setBomStatus(db, c, girder.id, 'active');

  // ---- the order -------------------------------------------------------------------------
  const cust = await PARTIES.createParty(db, c, { code: `${tag}-CU`, name: `${tag} bridge co`, roles: ['customer'] });
  const order = await SO.createOrder(db, c, { orderType: 'customer', customerId: cust.id, code: `${tag}-SO`, committedDate: '2027-12-31' });
  const made = [];
  for (let i = 0; i < lines; i++) {
    const o = await SO.addOrderLine(db, c, order.id, { recordId: girder.id, quantity });
    made.push(o.lines[o.lines.length - 1]);
  }
  const lineId = made[0].id;

  /** The line's structure as the BOM screens draw it (bomService.explode). */
  const tree = async (id = lineId) => {
    const [[l]] = await db.query('SELECT item_id, quantity FROM cf_sales_order_lines WHERE id = ?', [id]);
    return B.explode(db, companyId, l.item_id, { rootQuantity: Number(l.quantity) });
  };
  /**
   * The line's rows by what they are: { girder, segments: [{ node, flange, web, bolt, parts: [] }] } —
   * each a node of explode() ({ id, lineId, name, quantity, children }).
   */
  const rows = async (id = lineId) => {
    const t = await tree(id);
    const named = (node, word) => node.children.filter((k) => k.name === `${tag} ${word}`);
    return {
      girder: t.root,
      segments: named(t.root, 'Segment').map((s) => ({
        node: s, flange: named(s, 'Flange')[0] ?? null, web: named(s, 'Web')[0] ?? null,
        bolt: s.children.find((k) => k.id === boltId) ?? null,
        parts: s.children.filter((k) => /Plate \d+$/.test(k.name)),
      })),
    };
  };
  return {
    tag, order, lines: made, line: made[0], lineId, boltId,
    spec: { LEN: 'LENGTH', WID: 'WIDTH', THK: 'THICKNESS', GRD: 'GRADE', MARK: 'DRAWING_MARK', CUT: 'CUT_FROM', WT: WT.code, AREA: AREA.code, COAT: COAT.code, SUM: SUM.code, HOW: HOW.code },
    specId: { ...real, WT: WT.id, AREA: AREA.id, COAT: COAT.id, SUM: SUM.id, HOW: HOW.id },
    nodes: { fam: fam.id, mid: mid.id, asm: asmNode, plate: plateNode },
    templates: { girder, seg, flange, web, extra },
    rule, tree, rows,
  };
}

/** The usual harness of these suites: ok(label, cond) — label first, a boolean second. */
export function harness() {
  const state = { passed: 0, failed: 0, fails: [] };
  const ok = (name, cond, detail = '') => {
    if (typeof name !== 'string' || typeof cond !== 'boolean') throw new Error(`ok(label, cond) was called as ok(${typeof name}, ${typeof cond}) — the label comes first and the condition must be a boolean.`);
    if (cond) { state.passed += 1; console.log(`  PASS  ${name}`); } else { state.failed += 1; state.fails.push(name); console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
  };
  const section = (s) => console.log(`\n${s}`);
  const refusal = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
  return { state, ok, section, refusal };
}

/** Every cf_ table's row count — so "nothing survived the rollback" is a fact. */
export async function tableCounts(pool) {
  const [tables] = await pool.query("SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME LIKE 'cf\\_%' ORDER BY TABLE_NAME");
  const [rows] = await pool.query(tables.map((t) => `SELECT '${t.name}' AS name, COUNT(*) AS n FROM \`${t.name}\``).join(' UNION ALL '));
  return rows;
}

/** Counts the round trips of fn on this connection: { out, n, sql }. */
export async function counted(db, fn) {
  const log = [];
  const q = db.query.bind(db);
  db.query = (...a) => { log.push(String(typeof a[0] === 'string' ? a[0] : a[0]?.sql ?? '').replace(/\s+/g, ' ').trim()); return q(...a); };
  try { return { out: await fn(), n: log.length, sql: log }; } finally { db.query = q; }
}
