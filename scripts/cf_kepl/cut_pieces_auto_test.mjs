/**
 * cut_pieces_auto_test.mjs — cut pieces made AUTOMATICALLY from a line's values
 * (cutPlateService.refreshCutPieces), and the bulk derive and read behind it.
 *
 *   cd multi_app_be && node scripts/cf_kepl/cut_pieces_auto_test.mjs
 *
 * The user, 2026-09-26: "Once the values screen is completed, then cut pieces
 * should get created" — and again whenever the values or the structure change,
 * until the line is locked. refreshCutPieces is called after every value save,
 * so it must do nothing while a value is missing, nothing when nothing changed,
 * nothing on a locked line, and stay a fixed number of round trips whatever the
 * size of the line (production is ~49 ms a round trip away).
 *
 * ONE TRANSACTION, ROLLED BACK. Every cf_ table is counted before and after and
 * must come back to the count it started at. "Writes nothing" inside the run is
 * checked by the statements sent, not by counts: a soft delete is an UPDATE and
 * changes no count.
 *
 * WHAT IT OWNS: its own Family › Subfamily › Variant for the girders it sells;
 * its own Variant for the plate parts, hung under FAB_PARTS, carrying its own
 * rules (the four sizes REQUIRED, one more required value of its own, the steel
 * a blank will ask a part for, everything else the company requires higher up
 * switched off at its own level); its own raw plates, plate selection, coding
 * rule for blanks, templates, customer, order and stocking area. Every code and
 * name carries this run's tag.
 *
 * WHAT IT BORROWS, AND WHY: cutPlateService is hard-wired to three
 * classification CODES — FAB_PARTS (where parts are), CUT_PLATE (where blanks
 * are filed), PLATE (what the plate selection searches) — and uq_ccn_code allows
 * one node per code, so a suite cannot have its own. It reuses the company's
 * (creating them under its own scaffolding only where the company has none) and
 * ANSWERS their rules at run time instead of assuming them: raw plates are given
 * whatever PLATE requires today, and the parts are given whatever CUT_PLATE
 * requires beyond the four sizes, so a blank can inherit it. The company's
 * other plate selections are retired for the length of the transaction, and the
 * blanks are coded by a rule of this run that outranks the company's.
 *
 * ok(label, cond) — the LABEL FIRST. A swapped call has passed unconditionally
 * twice in this codebase, so ok() refuses anything but (string, boolean), and
 * section 0 proves it does.
 */
import path from 'path';
import { pathToFileURL } from 'url';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
await imp('apps/cf_erp/services/codegenProvider.js');           // registers the code-generator entities, as app.js does
const { attachNodeCache, detachNodeCache, invalidateNodeCache } = await imp('apps/cf_erp/lib/db.js');
const CUT = await imp('apps/cf_erp/services/cutPlateService.js');
const OV = await imp('apps/cf_erp/services/orderValuesService.js');
const codegen = await imp('apps/cf_erp/modules/codegen/service.js');
const CLS = await imp('apps/cf_erp/services/classificationService.js');
const { createRule } = await imp('apps/cf_erp/services/assignmentService.js');
const MR = await imp('apps/cf_erp/services/masterRecordService.js');
const B = await imp('apps/cf_erp/services/bomService.js');
const SEL = await imp('apps/cf_erp/services/selectionService.js');
const V = await imp('apps/cf_erp/services/valueService.js');
const RES = await imp('apps/cf_erp/services/resolutionService.js');
const { loadMaster } = await imp('apps/cf_erp/services/records.js');
const OPS = await imp('apps/cf_erp/services/operationService.js');
const FLOWS = await imp('apps/cf_erp/services/flowService.js');
const SO = await imp('apps/cf_erp/services/salesOrderService.js');
const PARTIES = await imp('apps/cf_erp/modules/parties/service.js');
const AREAS = await imp('apps/cf_erp/services/stockingAreaService.js');

const COMPANY = Number(process.env.CF_CUT_COMPANY ?? 2);

/* --------------------------------------------------------------------------
 * A tiny harness
 * ----------------------------------------------------------------------- */
let passed = 0;
let failed = 0;
const fails = [];
/** ok(label, cond, detail?) — a string, then a boolean. Anything else throws rather than passing. */
function ok(label, cond, detail = '') {
  if (typeof label !== 'string' || typeof cond !== 'boolean') {
    throw new Error(`ok(label, cond) was called as ok(${typeof label}, ${typeof cond}) — the label comes first and the condition must be a boolean.`);
  }
  if (cond) { passed += 1; console.log(`  PASS  ${label}`); }
  else { failed += 1; fails.push(label); console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (label, got, want) => ok(label, Object.is(got, want) || JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
const near = (label, got, want) => ok(label, got != null && Math.abs(Number(got) - want) < 1e-6, `got ${got}, wanted ${want}`);
const section = (s) => console.log(`\n${s}`);
const says = (text) => console.log(`        says: ${text}`);
const refusal = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

/* --------------------------------------------------------------------------
 * Counting: rows for the whole run, statements for "writes nothing"
 * ----------------------------------------------------------------------- */
async function cfTables(db) {
  const [rows] = await db.query("SHOW TABLES LIKE 'cf\\_%'");
  return rows.map((r) => Object.values(r)[0]).sort();
}
async function census(db, tables) {
  const out = {};
  for (const t of tables) {
    const [[r]] = await db.query(`SELECT COUNT(*) AS n FROM \`${t}\``);
    out[t] = Number(r.n);
  }
  return out;
}
const moved = (a, b) => Object.keys(a).filter((t) => a[t] !== b[t]).map((t) => `${t} ${a[t]}->${b[t]}`);

/**
 * Runs fn through a connection that counts what it sends: every round trip,
 * and every statement that writes. A Proxy, so the transaction's node cache
 * still rides on the connection.
 */
async function measured(conn, fn) {
  const tally = { trips: 0, writes: 0, sql: [] };
  const db = new Proxy(conn, {
    get: (target, prop) => (prop === 'query'
      ? (...args) => {
        tally.trips += 1;
        const s = String(args[0]).trim();
        if (/^(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(s)) tally.writes += 1;
        tally.sql.push(s.replace(/\s+/g, ' ').slice(0, 90));
        return target.query(...args);
      }
      : Reflect.get(target, prop)),
  });
  const out = await fn(db);
  return { out, ...tally };
}

/* --------------------------------------------------------------------------
 * The fixture
 * ----------------------------------------------------------------------- */
const tag = `CPA${Date.now().toString(36).toUpperCase()}`;
const tok = (key, extra = {}) => ({ segmentType: 'token', tokenKey: key, transform: 'none', isRequired: true, ...extra });
const lit = (text) => ({ segmentType: 'literal', literalText: text });

/**
 * CUT FROM (init.sql §48, CF_ERP_CUT_FROM_PLAN.md): parts are found by how they
 * are cut — their CUT_FROM — and cut plates / raw plates by the places of Setup
 * › Cutting, never by a classification code any more. This run's parts are cut
 * from plate (a defaulted CUT_FROM rule on its family, PLATE on its parts
 * node), and its own nodes are the plate places — for the transaction only.
 */
async function cutFromSetup(db, c, { family, partNode, cutNode = null, plateNode = null }) {
  let [[spec]] = await db.query("SELECT id FROM cf_specifications WHERE company_id = ? AND code = 'CUT_FROM' AND deleted_at IS NULL", [c.companyId]);
  if (!spec) {
    const [r] = await db.query("INSERT INTO cf_specifications (company_id, code, name, data_type, status) VALUES (?, 'CUT_FROM', 'Cut from', 'option', 'active')", [c.companyId]);
    spec = { id: r.insertId };
    for (const [i, v] of ['PLATE', 'SECTION', 'NONE'].entries()) {
      await db.query("INSERT INTO cf_spec_options (company_id, specification_id, value, label, sort_order, status) VALUES (?, ?, ?, ?, ?, 'active')", [c.companyId, spec.id, v, v, i + 1]);
    }
  }
  await db.query(
    `INSERT INTO cf_spec_assignments (company_id, specification_id, subject_type, subject_id, capture_at, is_required, is_applicable, value_rule, sort_order)
     VALUES (?, ?, 'classification', ?, 'item', 0, 1, 'defaulted', 0)`,
    [c.companyId, spec.id, family],
  );
  await V.setValues(db, c, 'classification', partNode, [{ specCode: 'CUT_FROM', value: 'PLATE' }]);
  if (cutNode != null) {
    await db.query("INSERT INTO cf_cut_places (company_id, kind, blanks_node_id) VALUES (?, 'plate', ?) ON DUPLICATE KEY UPDATE blanks_node_id = VALUES(blanks_node_id)", [c.companyId, cutNode]);
  }
  if (plateNode != null) {
    const [[place]] = await db.query("SELECT id FROM cf_cut_places WHERE company_id = ? AND kind = 'plate'", [c.companyId]);
    await db.query('DELETE FROM cf_cut_place_stock WHERE company_id = ? AND place_id = ?', [c.companyId, place.id]);
    await db.query('INSERT INTO cf_cut_place_stock (company_id, place_id, node_id) VALUES (?, ?, ?)', [c.companyId, place.id, plateNode]);
  }
}

async function buildFixture(db, c) {
  const row = async (id) => {
    const [[n]] = await db.query('SELECT id, parent_id, depth, code, name FROM cf_classification_nodes WHERE company_id = ? AND id = ?', [COMPANY, id]);
    return n;
  };
  /** A node found by code, or created — always the plain row, so both paths look alike. */
  const node = async (input) => {
    const [[found]] = await db.query('SELECT id, parent_id, depth, code, name FROM cf_classification_nodes WHERE company_id = ? AND code = ? AND deleted_at IS NULL', [COMPANY, input.code]);
    return found ?? row((await CLS.createNode(db, c, input)).id);
  };

  // The three codes the service reads: reused where the company has them,
  // made under this run's own scaffolding where it does not.
  const steel = await node({ code: `${tag}-STEEL`, name: `${tag} steel` });
  const platesSub = await node({ parentId: steel.id, code: `${tag}-PLATES`, name: `${tag} plates` });
  const fab = await node({ code: `${tag}-FAB`, name: `${tag} fabricated` });
  const PLATE = await node({ parentId: platesSub.id, code: 'PLATE', name: 'Plate' });
  const CUTPL = await node({ parentId: platesSub.id, code: 'CUT_PLATE', name: 'Cut plate' });
  const FABPARTS = await node({ parentId: fab.id, code: 'FAB_PARTS', name: 'Parts' });
  // What this run owns outright.
  const partsV = await node({ parentId: FABPARTS.id, code: `${tag}-PV`, name: `${tag} plate parts` });
  const fam = await node({ code: `${tag}-F`, name: `${tag} girders`, scope: 'definition' });
  const sub = await node({ parentId: fam.id, code: `${tag}-S`, name: `${tag} girder kinds`, scope: 'definition' });
  const girderV = await node({ parentId: sub.id, code: `${tag}-GV`, name: `${tag} plate girder`, scope: 'definition' });

  /** The four specifications are the service's; one more is this run's own. */
  const spec = async (code, name, dataType, uom = null) => {
    const [[found]] = await db.query('SELECT id, code, data_type FROM cf_specifications WHERE company_id = ? AND code = ? AND deleted_at IS NULL', [COMPANY, code]);
    if (found) return found;
    const [r] = await db.query(
      "INSERT INTO cf_specifications (company_id, code, name, data_type, default_uom, status, created_by) VALUES (?, ?, ?, ?, ?, 'active', ?)",
      [COMPANY, code, name, dataType, uom, c.userId],
    );
    return { id: r.insertId, code, data_type: dataType };
  };
  const TH = await spec('THICKNESS', 'Thickness', 'number', 'mm');
  const LN = await spec('LENGTH', 'Length', 'number', 'mm');
  const WD = await spec('WIDTH', 'Width', 'number', 'mm');
  const GR = await spec('GRADE', 'Grade', 'option');
  for (const v of ['E250', 'E350']) {
    const [[o]] = await db.query('SELECT id FROM cf_spec_options WHERE company_id = ? AND specification_id = ? AND value = ? AND deleted_at IS NULL', [COMPANY, GR.id, v]);
    if (!o) await db.query("INSERT INTO cf_spec_options (company_id, specification_id, value, label, status, sort_order) VALUES (?, ?, ?, ?, 'active', 0)", [COMPANY, GR.id, v, v]);
  }
  const MARK = await spec(`${tag}_MARK`, `${tag} mark`, 'text');

  /**
   * What a blank's OWN chain will ask for beyond the four sizes (IMPACT_CLASS
   * in company 2). The parts are given it, as a real plate part states its
   * steel, so the blank's inheritance is exercised. Option values are picked
   * from the BLANK's allowed list, the narrower of the two.
   */
  const blankView = await RES.resolve(db, COMPANY, { nodeId: CUTPL.id });
  const FOUR = ['THICKNESS', 'LENGTH', 'WIDTH', 'GRADE'];
  const steelExtras = blankView.specs
    .filter((s) => s.applicable && s.rule.isRequired && s.rule.valueRule === 'entered' && !FOUR.includes(s.spec.code))
    .map((s) => ({
      id: s.spec.id,
      code: s.spec.code,
      value: s.spec.dataType === 'option' ? s.options?.[0]?.value
        : s.spec.dataType === 'number' ? 1
          : s.spec.dataType === 'boolean' ? false
            : s.spec.dataType === 'date' ? '2026-01-01' : 'CPA',
    }))
    .filter((s) => s.value !== undefined);
  const nestManual = blankView.specs.find((s) => s.spec.code === 'NEST_MANUAL' && s.applicable && s.captureAt === 'item' && ['entered', 'defaulted'].includes(s.rule.valueRule)) ?? null;

  // The parts Variant's rules are this run's: the four sizes and the mark
  // REQUIRED, the steel entered, and every other rule reaching it from above
  // switched off at its own level (the narrowest rule wins).
  const chainIds = [];
  for (let cur = partsV.id; cur;) { const n = await row(cur); if (!n) break; chainIds.push(n.id); cur = n.parent_id; }
  const [reaching] = await db.query(
    `SELECT DISTINCT a.specification_id, a.capture_at FROM cf_spec_assignments a
      WHERE a.company_id = ? AND a.subject_type = 'classification' AND a.subject_id IN (?) AND a.is_applicable = 1 AND a.deleted_at IS NULL`,
    [COMPANY, chainIds],
  );
  const mine = [
    ...[TH, LN, WD, GR, MARK].map((s) => ({ id: s.id, required: true })),
    ...steelExtras.map((s) => ({ id: s.id, required: false })),
  ];
  for (const s of mine) {
    await createRule(db, c, { subjectType: 'classification', subjectId: partsV.id, specificationId: s.id, captureAt: 'item', valueRule: 'entered', isApplicable: true, isRequired: s.required });
  }
  const mineKeys = new Set(mine.map((s) => `${s.id}:item`));
  // Cut from (§48) is not switched off: cutFromSetup below answers it on this Variant.
  const [[cfSpec]] = await db.query("SELECT id FROM cf_specifications WHERE company_id = ? AND code = 'CUT_FROM' AND deleted_at IS NULL", [COMPANY]);
  if (cfSpec) mineKeys.add(`${cfSpec.id}:item`);
  for (const r of reaching) {
    if (mineKeys.has(`${r.specification_id}:${r.capture_at}`)) continue;
    await createRule(db, c, { subjectType: 'classification', subjectId: partsV.id, specificationId: r.specification_id, captureAt: r.capture_at, isApplicable: false });
  }
  // Cut from (§48): this run's parts are cut from plate.
  await cutFromSetup(db, c, { family: partsV.id, partNode: partsV.id });

  // Raw plates, filed at the borrowed PLATE, answering whatever it requires today.
  const fillRequired = async (masterId) => {
    const m = await loadMaster(db, COMPANY, masterId);
    const r = await RES.resolve(db, COMPANY, { master: m });
    const writes = [];
    for (const s of r.specs) {
      if (s.status !== 'missing') continue;
      const dt = s.spec.dataType;
      const value = dt === 'option' ? s.options?.[0]?.value : dt === 'number' ? 1 : dt === 'boolean' ? false : dt === 'date' ? '2026-01-01' : 'CPA';
      if (value !== undefined) writes.push({ specCode: s.spec.code, value });
    }
    if (writes.length) await V.setValues(db, c, 'master', masterId, writes);
  };
  const mkPlate = async (code, name, t, l, w) => {
    const it = await MR.createItem(db, c, { classificationId: PLATE.id, code, name, trackedBy: 'quantity', uom: 'nos' });
    await V.setValues(db, c, 'master', it.id, [
      { specCode: 'THICKNESS', value: t }, { specCode: 'LENGTH', value: l }, { specCode: 'WIDTH', value: w }, { specCode: 'GRADE', value: 'E350' },
    ]);
    await fillRequired(it.id);
    return MR.setStatus(db, c, it.id, 'active');
  };
  const PL1 = await mkPlate(`${tag}-PL1`, `${tag} plate 6000 x 2000`, 10, 6000, 2000);
  const PL2 = await mkPlate(`${tag}-PL2`, `${tag} plate 8000 x 2500`, 12, 8000, 2500);

  // The service insists exactly ONE active selection searches PLATE: this
  // run's is the only one for the length of the transaction. PL1 is its
  // default, so a new blank's plate line holds a real plate at the area fraction.
  const [rivals] = await db.query(
    `SELECT m.id FROM cf_definition_details d JOIN cf_master_records m ON m.id = d.master_id AND m.deleted_at IS NULL
      WHERE d.company_id = ? AND d.deleted_at IS NULL AND d.definition_type = 'selection' AND d.candidate_classification_id = ? AND m.status = 'active'`,
    [COMPANY, PLATE.id],
  );
  if (rivals.length) await db.query("UPDATE cf_master_records SET status = 'obsolete' WHERE company_id = ? AND id IN (?)", [COMPANY, rivals.map((r) => r.id)]);
  let sel = await MR.createDefinition(db, c, {
    definitionType: 'selection', classificationId: PLATE.id, code: `${tag}-SEL`, name: `${tag} SEL plate`,
    selectionMode: 'allowed_list', candidateClassificationId: PLATE.id,
  });
  await SEL.addAllowedItem(db, c, sel.id, { itemId: PL1.id });
  await SEL.addAllowedItem(db, c, sel.id, { itemId: PL2.id });
  sel = await MR.setStatus(db, c, sel.id, 'active');
  const [[allowed]] = await db.query('SELECT id FROM cf_definition_allowed_items WHERE company_id = ? AND definition_id = ? AND item_id = ? AND deleted_at IS NULL', [COMPANY, sel.id, PL1.id]);
  await SEL.setDefaultAllowed(db, c, allowed.id);

  // Blanks are coded by this run's rule: the exact CUT_PLATE variant outweighs
  // any "under" rule the company has, and the priority breaks a tie with any
  // rule naming the same variant.
  const blankRule = await codegen.createScheme(db, COMPANY, c.userId, {
    code: `${tag}-BLANK`, name: `${tag} blank`, entityType: 'item', targetField: 'code', seqScope: 'prefix', priority: 100, status: 'active',
    conditions: [{ tokenKey: 'kind', operator: 'eq', value: 'temporary' }, { tokenKey: 'classification', operator: 'eq', value: String(CUTPL.id) }],
    segments: [lit(`${tag}-`), tok('line.no'), lit('-'), tok('spec:THICKNESS'), lit('X'), tok('spec:WIDTH'), lit('X'), tok('spec:LENGTH'), lit('-'), tok('spec:GRADE')],
  });

  const tpl = async (code, name, shortName, classificationId) => {
    const d = await MR.createDefinition(db, c, { definitionType: 'template', classificationId, code: `${tag}-${code}`, name: `${tag} ${name}`, shortName });
    return MR.setStatus(db, c, d.id, 'active');
  };
  const TPA = await tpl('TPA', 'web plate', `${tag}W`, partsV.id);
  const TPB = await tpl('TPB', 'cover plate', `${tag}C`, partsV.id);
  const TPC = await tpl('TPC', 'end plate', `${tag}E`, partsV.id);
  const TSUB = await tpl('TSUB', 'bracket', `${tag}K`, girderV.id);
  const girder = async (code, lines) => {
    const g = await tpl(code, `girder ${code}`, `${tag}${code}`, girderV.id);
    for (const l of lines) await B.addLine(db, c, g.id, l);
    await B.setBomStatus(db, c, g.id, 'active');
    return g;
  };
  // Line A: 3 parts. Line B: the same kinds of part, 12 of them.
  const TG = await girder('G', [{ childId: TPA.id, quantity: 2 }, { childId: TPB.id, quantity: 1 }, { childId: TPC.id, quantity: 4 }]);
  const TGB = await girder('GB', [TPA, TPA, TPA, TPA, TPB, TPB, TPB, TPB, TPC, TPC, TPC, TPC].map((t) => ({ childId: t.id, quantity: 1 })));
  // A line with a structure but no plate part in it.
  const TGE = await girder('GE', [{ childId: TSUB.id, quantity: 1 }]);

  const cust = await PARTIES.createParty(db, c, { code: `${tag}-CU`, name: `${tag} bridge co`, roles: ['customer'] });
  const area = await AREAS.createArea(db, c, { code: `${tag}-YARD`, name: `${tag} yard`, purpose: 'storage' });
  const order = await SO.createOrder(db, c, { orderType: 'customer', customerId: cust.id, code: `${tag}-SO`, committedDate: '2026-12-31' });
  const add = async (recordId) => {
    const o = await SO.addOrderLine(db, c, order.id, { recordId, quantity: 1 });
    return o.lines[o.lines.length - 1];
  };
  const lineA = await add(TG.id);
  const lineB = await add(TGB.id);
  const lineE = await add(TGE.id);
  const lineS = await add(PL1.id);   // a catalog item: no structure at all

  const partsOf = async (lineId) => {
    const [rows] = await db.query(
      `SELECT m.id, i.source_definition_id AS def FROM cf_item_details i JOIN cf_master_records m ON m.id = i.master_id AND m.deleted_at IS NULL
        WHERE i.company_id = ? AND i.owner_order_line_id = ? AND i.deleted_at IS NULL AND m.classification_id = ? ORDER BY m.id`,
      [COMPANY, lineId, partsV.id],
    );
    return rows;
  };
  return {
    PLATE, CUTPL, FABPARTS, partsV, girderV, TH, LN, WD, GR, MARK, steelExtras, nestManual,
    PL1, PL2, sel, blankRule, TPA, TPB, TPC, TG, TGB, TGE, cust, area, order, lineA, lineB, lineE, lineS, partsOf,
  };
}

/* --------------------------------------------------------------------------
 * Helpers over the fixture
 * ----------------------------------------------------------------------- */
async function blanksOf(db, f, lineId) {
  const [rows] = await db.query(
    `SELECT m.id, m.code, m.name, m.status FROM cf_master_records m JOIN cf_item_details i ON i.master_id = m.id AND i.deleted_at IS NULL
      WHERE m.company_id = ? AND m.deleted_at IS NULL AND i.owner_order_line_id = ? AND m.classification_id = ? ORDER BY m.id`,
    [COMPANY, lineId, f.CUTPL.id],
  );
  return rows;
}
async function blankOfPart(db, f, partId) {
  const [rows] = await db.query(
    `SELECT l.child_id FROM cf_boms b JOIN cf_bom_lines l ON l.bom_id = b.id AND l.deleted_at IS NULL
      JOIN cf_master_records m ON m.id = l.child_id AND m.classification_id = ? AND m.deleted_at IS NULL
     WHERE b.company_id = ? AND b.parent_id = ? AND b.deleted_at IS NULL`,
    [f.CUTPL.id, COMPANY, partId],
  );
  return rows.map((r) => r.child_id);
}
async function plateLine(db, blankId) {
  const [[l]] = await db.query(
    `SELECT l.id, l.child_id, l.quantity FROM cf_boms b JOIN cf_bom_lines l ON l.bom_id = b.id AND l.deleted_at IS NULL
      WHERE b.company_id = ? AND b.parent_id = ? AND b.deleted_at IS NULL ORDER BY l.id LIMIT 1`,
    [COMPANY, blankId],
  );
  return l ? { ...l, quantity: Number(l.quantity) } : null;
}
async function held(db, masterId, codes) {
  if (!codes.length) return new Map();
  const [rows] = await db.query(
    `SELECT s.code, v.value_number, v.value_text, v.value_bool, o.value AS option_value
       FROM cf_spec_values v JOIN cf_specifications s ON s.id = v.specification_id LEFT JOIN cf_spec_options o ON o.id = v.option_id
      WHERE v.company_id = ? AND v.subject_type = 'master' AND v.subject_id = ? AND v.deleted_at IS NULL AND s.code IN (?)`,
    [COMPANY, masterId, codes],
  );
  return new Map(rows.map((r) => [r.code, r.option_value ?? r.value_text ?? (r.value_number != null ? String(Number(r.value_number)) : r.value_bool != null ? String(r.value_bool) : null)]));
}
const size = (id, t, l, w, grade = 'E350') => [
  { recordId: id, specCode: 'THICKNESS', value: t }, { recordId: id, specCode: 'LENGTH', value: l },
  { recordId: id, specCode: 'WIDTH', value: w }, { recordId: id, specCode: 'GRADE', value: grade },
];

/* --------------------------------------------------------------------------
 * The run
 * ----------------------------------------------------------------------- */
console.log(`cut_pieces_auto_test — company ${COMPANY}, fixture tag ${tag}`);

section('0. The harness refuses a swapped ok()');
const swapped = await refusal(() => ok(true, 'swapped'));
ok('ok(cond, label) throws instead of passing', swapped instanceof Error);
const truthy = await refusal(() => ok('a truthy object is not a pass', {}));
ok('ok(label, {}) throws instead of passing', truthy instanceof Error);

const TABLES = await cfTables(pool);
const before = await census(pool, TABLES);
const conn = await pool.getConnection();
try {
  await conn.beginTransaction();
  attachNodeCache(conn);
  const c = { companyId: COMPANY, userId: 22 };
  const f = await buildFixture(conn, c);
  const partsA = await f.partsOf(f.lineA.id);
  const partsB = await f.partsOf(f.lineB.id);
  const byDef = (rows, def) => rows.filter((r) => r.def === def).map((r) => r.id);
  const [A] = byDef(partsA, f.TPA.id);
  const [Bp] = byDef(partsA, f.TPB.id);
  const [C] = byDef(partsA, f.TPC.id);
  const markAll = (ids) => ids.map((id) => ({ recordId: id, specCode: f.MARK.code, value: 'M' }));
  const steelAll = (ids) => ids.flatMap((id) => f.steelExtras.map((s) => ({ recordId: id, specCode: s.code, value: s.value })));
  const refresh = (lineId) => measured(conn, (db) => CUT.refreshCutPieces(db, c, lineId));

  section('1. The fixture');
  ok('line A built a girder and its three plate parts; line B twelve', partsA.length === 3 && partsB.length === 12 && !!A && !!Bp && !!C,
    `${partsA.length} and ${partsB.length} parts`);
  ok('the parts sit in this run\'s own Variant under FAB_PARTS', f.partsV.parent_id === f.FABPARTS.id);
  says(f.steelExtras.length
    ? `a blank filed at ${f.CUTPL.code} also requires ${f.steelExtras.map((s) => s.code).join(', ')} — the parts are given it, so blanks can inherit it`
    : `a blank filed at ${f.CUTPL.code} requires nothing beyond the four sizes — the inheritance checks skip`);

  /* ---- nothing while a value is missing --------------------------------- */
  section('2. While a required value is missing, nothing is made');
  const noSize = await refresh(f.lineA.id);
  eq('with no sizes yet, the refresh says values_missing', noSize.out.reason, 'values_missing');
  ok('and makes nothing', noSize.out.made === false && (await blanksOf(conn, f, f.lineA.id)).length === 0);
  eq('not one write statement', noSize.writes, 0);
  ok('it says how many are missing', Number(noSize.out.summary.missing) >= 12, JSON.stringify(noSize.out.summary));
  says(noSize.out.message);
  const readNoSize = await CUT.getCutPlates(conn, COMPANY, f.lineA.id);
  ok('the Cut pieces screen is told the same: values incomplete, nothing made, "up to date" unknown',
    readNoSize.values?.complete === false && readNoSize.values.missing === noSize.out.summary.missing && readNoSize.cutPlates.length === 0 && readNoSize.upToDate === null,
    JSON.stringify({ values: readNoSize.values, upToDate: readNoSize.upToDate }));

  // Sizes filled, but the run's own required mark left empty on one part: the
  // plan WOULD make blanks now, and still nothing is made.
  await OV.writeLineValues(conn, c, f.lineA.id, { writes: [...size(A, 10, 3000, 500), ...size(Bp, 10, 3000, 500), ...size(C, 12, 2000, 400), ...markAll([A, Bp]), ...steelAll([A, Bp, C])] });
  const noMark = await refresh(f.lineA.id);
  ok('with every size in but one other required value empty, it still says values_missing', noMark.out.reason === 'values_missing' && noMark.out.summary.missing === 1,
    JSON.stringify(noMark.out));
  eq('and writes nothing', noMark.writes, 0);
  const readNoMark = await CUT.getCutPlates(conn, COMPANY, f.lineA.id);
  ok('the screen says one value is missing, and that the cut pieces are behind the parts', readNoMark.values?.missing === 1 && readNoMark.upToDate === false,
    JSON.stringify({ values: readNoMark.values, upToDate: readNoMark.upToDate }));

  /* ---- made when complete ------------------------------------------------ */
  section('3. As soon as the values are complete, the cut pieces are made');
  await OV.writeLineValues(conn, c, f.lineA.id, { writes: markAll([C]) });
  invalidateNodeCache(conn);
  // The house's cut-plate flow (init.sql §33 — user, 2026-09-30: cutting
  // belongs to the cut plate). Set here, so a new cut plate is born with it.
  const cutOp = await OPS.createOperation(conn, c, { code: `${tag}-CUT`, name: `Cut ${tag}` });
  const mkFlow = async (code) => {
    const fl = await FLOWS.createFlow(conn, c, { code: `${tag}-${code}`, name: `${code} ${tag}` });
    await FLOWS.addStep(conn, c, fl.id, { operationId: cutOp.id });
    await FLOWS.setFlowStatus(conn, c, fl.id, 'active');
    return fl;
  };
  const cncFlow = await mkFlow('CNC');
  const setHouse = await FLOWS.setCutPlateFlow(conn, c, { flowId: cncFlow.id });
  eq('the house says which flow cut plates are made by', setHouse.flow?.id, cncFlow.id);
  eq('and reads it back', (await FLOWS.getCutPlateFlow(conn, COMPANY)).flow?.code, `${tag}-CNC`);
  const first = await refresh(f.lineA.id);
  ok('the refresh made them', first.out.made === true && first.out.reason === 'made', JSON.stringify(first.out));
  says(first.out.message);
  let blanks = await blanksOf(conn, f, f.lineA.id);
  const [xA] = await blankOfPart(conn, f, A);
  const [xB] = await blankOfPart(conn, f, Bp);
  const [xC] = await blankOfPart(conn, f, C);
  ok('three parts, two rectangles: the two of one size share a blank, the odd one has its own',
    blanks.length === 2 && xA === xB && xC && xC !== xA && first.out.summary.created === 2, JSON.stringify({ blanks: blanks.map((b) => b.id), xA, xB, xC }));
  const bA = blanks.find((b) => b.id === xA);
  const [[{ line_no: lineNoA }]] = await conn.query('SELECT line_no FROM cf_sales_order_lines WHERE id = ?', [f.lineA.id]);
  eq('a blank is coded by the rule where blanks are filed (this run\'s), from its line and its size', bA?.code, `${tag}-${lineNoA}-10X500X3000-E350`);
  const [[{ n: nameRules }]] = await conn.query("SELECT COUNT(*) AS n FROM cf_code_schemes WHERE company_id = ? AND entity_type = 'item' AND target_field = 'name' AND status = 'active' AND deleted_at IS NULL", [COMPANY]);
  if (Number(nameRules) === 0) eq('and, with no naming rule, named from its size', bA?.name, 'Cut plate 10 × 500 × 3000 E350');
  else ok('and named by the company\'s naming rule', !!bA?.name, bA?.name);
  // NO DEFAULT PLATE (CF_ERP_ORDER_FLOW_PLAN, 2026-09-30): the selection has a
  // default (PL1), and still a new blank's plate line holds the SELECTION —
  // "chosen at nesting" — at the placeholder quantity 1.
  const plA = await plateLine(conn, xA);
  const plC = await plateLine(conn, xC);
  ok('a new blank\'s plate line holds the plate SELECTION, not the selection\'s default plate', plA?.child_id === f.sel.id && plC?.child_id === f.sel.id, JSON.stringify({ plA, plC, sel: f.sel.id }));
  near('at the placeholder quantity 1 — nothing is bought from it', plA?.quantity, 1);
  const cpView = await CUT.getCutPlates(conn, COMPANY, f.lineA.id);
  ok('the Cut pieces screen says the plate is chosen at nesting', cpView.cutPlates.every((x) => x.plate === null && x.plateState === 'at_nesting' && x.nest === null && /chosen at nesting/.test(x.note ?? '')),
    JSON.stringify(cpView.cutPlates.map((x) => ({ plate: x.plate, state: x.plateState, note: x.note }))));
  if (f.steelExtras.length) {
    const fromPart = await held(conn, A, f.steelExtras.map((s) => s.code));
    const onBlank = await held(conn, xA, f.steelExtras.map((s) => s.code));
    ok(`the blank inherits ${f.steelExtras.map((s) => s.code).join(', ')} from the part it is cut from`,
      f.steelExtras.every((s) => onBlank.get(s.code) != null && onBlank.get(s.code) === fromPart.get(s.code)), JSON.stringify([...onBlank]));
  }
  const flowsOf = async (ids) => new Map((await conn.query('SELECT id, default_flow_id FROM cf_master_records WHERE id IN (?)', [ids]))[0].map((r) => [r.id, r.default_flow_id]));
  const bornWith = await flowsOf(blanks.map((b) => b.id));
  ok('every new cut plate is made by the house cut-plate flow — no flow was asked for', blanks.every((b) => bornWith.get(b.id) === cncFlow.id), JSON.stringify([...bornWith]));
  ok(`the first derive stays inside its budget: ${first.trips} round trips (the values check and the values settle included)`, first.trips <= 60, `${first.trips}`);
  const readMade = await CUT.getCutPlates(conn, COMPANY, f.lineA.id);
  ok('the screen now says: up to date, values complete, and when they were made',
    readMade.upToDate === true && readMade.values?.complete === true && typeof readMade.lastMadeAt === 'string' && Math.abs(Date.now() - Date.parse(readMade.lastMadeAt)) < 5 * 60 * 1000,
    JSON.stringify({ upToDate: readMade.upToDate, values: readMade.values, lastMadeAt: readMade.lastMadeAt }));

  /* ---- again, unchanged --------------------------------------------------- */
  section('4. Called again with nothing changed, it writes nothing');
  const rowsBefore = await census(conn, TABLES);
  const again = await refresh(f.lineA.id);
  eq('it says up_to_date', again.out.reason, 'up_to_date');
  eq('not one write statement', again.writes, 0);
  eq('not one row more or less', moved(rowsBefore, await census(conn, TABLES)), []);
  ok(`and it is cheap: ${again.trips} round trips`, again.trips <= 10, `${again.trips}: ${again.sql.join(' | ')}`);
  const explicit = await measured(conn, (db) => CUT.deriveCutPlates(db, c, f.lineA.id, {}));
  ok('the explicit derive ("Make them now") agrees: nothing to change, nothing written', explicit.out.changed === false && explicit.writes === 0 && explicit.out.unchanged === 2,
    JSON.stringify({ changed: explicit.out.changed, writes: explicit.writes }));

  /* ---- a size changes ------------------------------------------------------ */
  section('5. A size changes, and the cut pieces follow');
  // A person gives one cut plate a flow of its own, and the house changes its
  // default: the new cut plate takes the new default, the other keeps its own.
  const ownFlow = await mkFlow('OWN');
  const laserFlow = await mkFlow('LASER');
  await MR.updateRecord(conn, c, xA, { defaultFlowId: ownFlow.id });
  await FLOWS.setCutPlateFlow(conn, c, { flowId: laserFlow.id });
  await OV.writeLineValues(conn, c, f.lineA.id, { writes: [{ recordId: Bp, specCode: 'WIDTH', value: 600 }] });
  const behind = await CUT.getCutPlates(conn, COMPANY, f.lineA.id);
  eq('before the refresh, the screen says the cut pieces are behind the parts', behind.upToDate, false);
  const wider = await refresh(f.lineA.id);
  const [xB2] = await blankOfPart(conn, f, Bp);
  ok('the refresh moves the wider part onto a blank of its own; the other part keeps the first blank',
    wider.out.made === true && wider.out.summary.created === 1 && xB2 && xB2 !== xA && (await blankOfPart(conn, f, A))[0] === xA,
    JSON.stringify({ out: wider.out.summary, xB2 }));
  ok('and the part points at exactly one blank', (await blankOfPart(conn, f, Bp)).length === 1);
  const afterWider = await flowsOf([xA, xB2, xC]);
  eq('the new cut plate takes the NEW house default flow', afterWider.get(xB2), laserFlow.id);
  eq('the cut plate given its own flow keeps it — never overwritten', afterWider.get(xA), ownFlow.id);
  eq('and the untouched one keeps the flow it was born with', afterWider.get(xC), cncFlow.id);
  const flowRefused = await (async () => { try { await FLOWS.setCutPlateFlow(conn, c, { flowId: 999999999 }); return null; } catch (e) { return e; } })();
  ok('a flow that does not exist is refused in words', !!flowRefused && /does not exist/.test((flowRefused.problems ?? []).join(' ') + flowRefused.message), flowRefused?.message);
  await OV.writeLineValues(conn, c, f.lineA.id, { writes: [{ recordId: Bp, specCode: 'WIDTH', value: 500 }] });
  const back = await refresh(f.lineA.id);
  const [gone] = await conn.query('SELECT deleted_at FROM cf_master_records WHERE id = ?', [xB2]);
  ok('put back, it rejoins the first blank, and the one nothing is cut from any more is deleted',
    back.out.made === true && back.out.summary.removed === 1 && gone[0].deleted_at !== null && (await blankOfPart(conn, f, Bp))[0] === xA,
    JSON.stringify(back.out.summary));

  /* ---- one button: every cut plate with no flow -------------------------------- */
  section('5b. "Give all cut plates the cutting flow": sets only the ones with none');
  const [xCnow] = await blankOfPart(conn, f, C);
  await conn.query('UPDATE cf_master_records SET default_flow_id = NULL WHERE company_id = ? AND id = ?', [COMPANY, xCnow]);
  const gaps = await CUT.cutPlateFlowGaps(conn, COMPANY, f.lineA.id);
  ok('the release check can tell: one cut plate has no flow, and the house flow is the laser one',
    gaps.total === 2 && gaps.missing === 1 && gaps.flow?.id === laserFlow.id, JSON.stringify(gaps));
  const given = await CUT.setCutPlateFlows(conn, c, f.lineA.id, {});
  ok('it sets the house flow on the one that had none and counts it', given.count === 1 && given.total === 2 && given.flowId === laserFlow.id, JSON.stringify(given));
  const afterGive = await flowsOf([xA, xCnow]);
  eq('the cut plate with no flow took the house flow', afterGive.get(xCnow), laserFlow.id);
  eq('the one with its own flow kept it', afterGive.get(xA), ownFlow.id);
  eq('a second press changes nothing: count 0', (await CUT.setCutPlateFlows(conn, c, f.lineA.id, {})).count, 0);
  eq('and nothing is left without a flow', (await CUT.cutPlateFlowGaps(conn, COMPANY, f.lineA.id)).missing, 0);
  // A flow named in the request wins over the house's.
  await conn.query('UPDATE cf_master_records SET default_flow_id = NULL WHERE company_id = ? AND id = ?', [COMPANY, xCnow]);
  eq('a flow named in the request is used instead of the house flow', (await CUT.setCutPlateFlows(conn, c, f.lineA.id, { flowId: cncFlow.id })).flowId, cncFlow.id);
  eq('and lands on the cut plate', (await flowsOf([xCnow])).get(xCnow), cncFlow.id);
  // No house flow and none named: refused in words, nothing written.
  await FLOWS.setCutPlateFlow(conn, c, { flowId: null });
  await conn.query('UPDATE cf_master_records SET default_flow_id = NULL WHERE company_id = ? AND id = ?', [COMPANY, xCnow]);
  const noHouse = await refusal(() => CUT.setCutPlateFlows(conn, c, f.lineA.id, {}));
  ok('with no cut-plate flow set it says to set one first', noHouse?.code === 'NO_CUT_PLATE_FLOW' && /Set one/.test(noHouse.message), `${noHouse?.code}: ${noHouse?.message}`);
  eq('and wrote nothing', (await flowsOf([xCnow])).get(xCnow), null);
  ok('the check then reports no house flow', (await CUT.cutPlateFlowGaps(conn, COMPANY, f.lineA.id)).flow === null);
  // A locked line still takes a flow (records.flowStillOpen); a released one does not.
  await conn.query('UPDATE cf_sales_order_lines SET locked_at = NOW() WHERE company_id = ? AND id = ?', [COMPANY, f.lineA.id]);
  const onLocked = await CUT.setCutPlateFlows(conn, c, f.lineA.id, { flowId: laserFlow.id });
  eq('on a LOCKED line the flow is still set', onLocked.count, 1);
  await conn.query(
    `INSERT INTO cf_production_releases (company_id, order_line_id, status, created_by) VALUES (?, ?, 'released', NULL)`,
    [COMPANY, f.lineA.id],
  ).catch(() => null);
  const [[rel]] = await conn.query('SELECT id FROM cf_production_releases WHERE company_id = ? AND order_line_id = ? AND deleted_at IS NULL', [COMPANY, f.lineA.id]);
  if (rel) {
    const onReleased = await refusal(() => CUT.setCutPlateFlows(conn, c, f.lineA.id, { flowId: cncFlow.id }));
    ok('on a RELEASED line it is refused', onReleased?.code === 'RELEASED', `${onReleased?.code}: ${onReleased?.message}`);
    await conn.query('DELETE FROM cf_production_releases WHERE id = ?', [rel.id]);
  } else says('(could not fake a release row here — the released refusal is covered by lockOf, shared with derive)');
  await conn.query('UPDATE cf_sales_order_lines SET locked_at = NULL WHERE company_id = ? AND id = ?', [COMPANY, f.lineA.id]);
  await FLOWS.setCutPlateFlow(conn, c, { flowId: laserFlow.id });
  await conn.query('UPDATE cf_master_records SET default_flow_id = ? WHERE company_id = ? AND id = ?', [cncFlow.id, COMPANY, xCnow]);

  /* ---- guards ------------------------------------------------------------------ */
  section('6. A nested cut piece keeps its plate and quantity');
  const [lot] = await conn.query(
    `INSERT INTO cf_plate_lots (company_id, order_line_id, plate_item_id, lot_no, source, thickness_mm, length_mm, width_mm, created_by)
     VALUES (?, ?, ?, 'N-001', 'catalog', 10, 6000, 2000, ?)`,
    [COMPANY, f.lineA.id, f.PL1.id, c.userId],
  );
  await conn.query(
    `INSERT INTO cf_nest_placements (company_id, plate_lot_id, cut_plate_id, x_mm, y_mm, length_mm, width_mm, created_by)
     VALUES (?, ?, ?, 0, 0, 3000, 500, ?)`,
    [COMPANY, lot.insertId, xA, c.userId],
  );
  const nestedLine = await plateLine(conn, xA);
  await conn.query('UPDATE cf_bom_lines SET quantity = 0.9, child_id = ? WHERE id = ?', [f.PL2.id, nestedLine.id]);
  const readNested = await CUT.getCutPlates(conn, COMPANY, f.lineA.id);
  const shownNested = readNested.cutPlates.find((x) => x.id === xA);
  ok('the screen shows the nested quantity as the nesting\'s answer, and does not call the line behind',
    shownNested?.plateQuantityBasis === 'nesting' && Number(shownNested.plateQuantity) === 0.9 && readNested.upToDate === true,
    JSON.stringify({ basis: shownNested?.plateQuantityBasis, q: shownNested?.plateQuantity, upToDate: readNested.upToDate }));
  eq('a refresh leaves it alone: up_to_date', (await refresh(f.lineA.id)).out.reason, 'up_to_date');

  // NEST_MANUAL, where the company's blanks take it, is a person's answer on
  // the blank: it survives a derive that re-settles the blank's values.
  if (f.nestManual) await V.setValues(conn, c, 'master', xA, [{ specCode: 'NEST_MANUAL', value: true }]);
  // C changes length: it moves to a new blank and its old one is left with nothing.
  // The old one has stock history, so it is a real thing now and stays.
  const [mv] = await conn.query("INSERT INTO cf_stock_movements (company_id, code, movement_type, movement_date, created_by) VALUES (?, ?, 'adjustment', '2026-09-27', ?)", [COMPANY, `${tag}-ADJ`, c.userId]);
  await conn.query('INSERT INTO cf_stock_ledger (company_id, movement_id, line_no, stocking_area_id, item_id, quantity, created_by) VALUES (?, ?, 1, ?, ?, 1, ?)', [COMPANY, mv.insertId, f.area.id, xC, c.userId]);
  await OV.writeLineValues(conn, c, f.lineA.id, { writes: [{ recordId: C, specCode: 'LENGTH', value: 2100 }] });
  const moveC = await refresh(f.lineA.id);
  const [xC2] = await blankOfPart(conn, f, C);
  const [[oldC]] = await conn.query('SELECT deleted_at FROM cf_master_records WHERE id = ?', [xC]);
  ok('the part moves to a new blank', moveC.out.made === true && moveC.out.summary.created === 1 && xC2 && xC2 !== xC, JSON.stringify(moveC.out.summary));
  ok('the blank it left has stock history, so it is not deleted', oldC.deleted_at === null && moveC.out.summary.removed === 0);
  const afterNested = await plateLine(conn, xA);
  ok('and the nested blank\'s plate line is exactly as the nesting left it: the plate it chose, 0.9',
    afterNested?.child_id === f.PL2.id && afterNested.quantity === 0.9, JSON.stringify(afterNested));
  if (f.nestManual) {
    eq('NEST_MANUAL set on a blank by a person is still there after the derive', (await held(conn, xA, ['NEST_MANUAL'])).get('NEST_MANUAL'), '1');
  } else {
    says('this company\'s blanks take no NEST_MANUAL — that check skips');
  }
  eq('a refresh straight after is up_to_date — the kept blank is nobody\'s now, and is not tried again', (await refresh(f.lineA.id)).out.reason, 'up_to_date');

  section('7. A value missing on a CUT PIECE does not stop the cut pieces following the parts');
  if (f.steelExtras.length) {
    const extra = f.steelExtras[0];
    await conn.query("UPDATE cf_spec_values SET deleted_at = NOW() WHERE company_id = ? AND subject_type = 'master' AND subject_id = ? AND specification_id = ? AND deleted_at IS NULL", [COMPANY, xA, extra.id]);
    const view = await OV.readLineValues(conn, COMPANY, f.lineA.id);
    const readGap = await CUT.getCutPlates(conn, COMPANY, f.lineA.id);
    ok(`the Values engine counts the blank's empty ${extra.code}, the Cut pieces gate does not`,
      view.counts.missingOwn >= 1 && readGap.values?.missing === 0, JSON.stringify({ missingOwn: view.counts.missingOwn, gate: readGap.values }));
    // Not back to 2000: the blank kept for its stock history still holds that
    // rectangle's code, and a new blank of the same size would clash with it.
    await OV.writeLineValues(conn, c, f.lineA.id, { writes: [{ recordId: C, specCode: 'LENGTH', value: 2050 }] });
    const through = await refresh(f.lineA.id);
    ok('a part changing size still re-derives', through.out.made === true, JSON.stringify(through.out));
  } else {
    says('no value a blank inherits from its part here — that check skips');
    await OV.writeLineValues(conn, c, f.lineA.id, { writes: [{ recordId: C, specCode: 'LENGTH', value: 2050 }] });
    await refresh(f.lineA.id);
  }

  section('8. A refusal never breaks the save it follows, and anything begun is rolled back');
  // Two rules equally fit to code a blank: the code generator refuses the tie.
  // By then the derive has written its blanks — the savepoint takes them back.
  const tie = await codegen.createScheme(conn, COMPANY, c.userId, {
    code: `${tag}-TIE`, name: `${tag} tie`, entityType: 'item', targetField: 'code', seqScope: 'prefix', priority: 100, status: 'active',
    conditions: [{ tokenKey: 'kind', operator: 'eq', value: 'temporary' }, { tokenKey: 'classification', operator: 'eq', value: String(f.CUTPL.id) }],
    segments: [lit(`${tag}-TIE-`), tok('spec:THICKNESS')],
  });
  await OV.writeLineValues(conn, c, f.lineA.id, { writes: [{ recordId: Bp, specCode: 'WIDTH', value: 700 }] });
  const rowsTie = await census(conn, TABLES);
  const tied = await refresh(f.lineA.id);
  ok('the refresh does not throw: it says it could not derive, and why', tied.out.made === false && tied.out.reason === 'cannot_derive' && /apply equally/.test(tied.out.message),
    JSON.stringify(tied.out));
  ok('it had begun writing — and every row is back where it was', tied.writes > 0 && moved(rowsTie, await census(conn, TABLES)).length === 0,
    `${tied.writes} write statements; ${moved(rowsTie, await census(conn, TABLES)).join(', ')}`);
  ok('the part is still on its old blank', (await blankOfPart(conn, f, Bp))[0] === xA);
  await conn.query("UPDATE cf_code_schemes SET status = 'inactive' WHERE company_id = ? AND id = ?", [COMPANY, tie.id]);
  const untied = await refresh(f.lineA.id);
  ok('with the tie gone, the next refresh makes it', untied.out.made === true && (await blankOfPart(conn, f, Bp))[0] !== xA, JSON.stringify(untied.out.summary));

  // Nothing chooses the raw plate: a setup gap, said in words — never thrown.
  await conn.query("UPDATE cf_master_records SET status = 'obsolete' WHERE company_id = ? AND id = ?", [COMPANY, f.sel.id]);
  await OV.writeLineValues(conn, c, f.lineA.id, { writes: [{ recordId: Bp, specCode: 'WIDTH', value: 500 }] });
  const noSel = await refresh(f.lineA.id);
  ok('with no plate selection, the refresh says cannot_derive and writes nothing', noSel.out.reason === 'cannot_derive' && noSel.writes === 0 && /selection/i.test(noSel.out.message),
    JSON.stringify(noSel.out));
  await conn.query("UPDATE cf_master_records SET status = 'active' WHERE company_id = ? AND id = ?", [COMPANY, f.sel.id]);
  eq('restored, it catches up', (await refresh(f.lineA.id)).out.made, true);

  section('9. The explicit derive does not wait for the values; the automatic one does');
  await OV.writeLineValues(conn, c, f.lineA.id, { writes: [{ recordId: A, specCode: f.MARK.code, value: null }, { recordId: C, specCode: 'WIDTH', value: 450 }] });
  const waits = await refresh(f.lineA.id);
  ok('the refresh waits for the missing mark', waits.out.reason === 'values_missing' && waits.writes === 0, JSON.stringify(waits.out));
  const now = await CUT.deriveCutPlates(conn, c, f.lineA.id, {});
  ok('"Make them now" derives anyway — the sizes are all there', now.changed === true && now.created === 1, JSON.stringify({ changed: now.changed, created: now.created }));
  await OV.writeLineValues(conn, c, f.lineA.id, { writes: [{ recordId: A, specCode: f.MARK.code, value: 'M' }] });
  eq('with the mark back and nothing else changed, the refresh is up_to_date', (await refresh(f.lineA.id)).out.reason, 'up_to_date');

  section('10. A locked line: nothing, whatever changes');
  await conn.query('UPDATE cf_sales_order_lines SET locked_at = NOW() WHERE company_id = ? AND id = ?', [COMPANY, f.lineA.id]);
  const lockedRows = await census(conn, TABLES);
  // A size typed straight into the store — the line's own save refuses a locked line, or soon will.
  await conn.query(
    `UPDATE cf_spec_values v JOIN cf_specifications s ON s.id = v.specification_id SET v.value_number = 480
      WHERE v.company_id = ? AND v.subject_type = 'master' AND v.subject_id = ? AND s.code = 'WIDTH' AND v.deleted_at IS NULL`,
    [COMPANY, C],
  );
  const locked = await refresh(f.lineA.id);
  ok('the refresh says locked and does nothing', locked.out.made === false && locked.out.reason === 'locked' && locked.writes === 0, JSON.stringify(locked.out));
  eq('not one row more or less', moved(lockedRows, await census(conn, TABLES)), []);
  const lockedDerive = await refusal(() => CUT.deriveCutPlates(conn, c, f.lineA.id, {}));
  ok('"Make them now" is refused on a locked line, in words', lockedDerive?.code === 'LOCKED' && /locked/.test(lockedDerive.message), `${lockedDerive?.code}: ${lockedDerive?.message}`);
  const lockedRead = await CUT.getCutPlates(conn, COMPANY, f.lineA.id);
  ok('the screen is told why the cut pieces are frozen, and is not given a values count or an up-to-date answer',
    lockedRead.lock?.reason === 'locked' && lockedRead.values === null && lockedRead.upToDate === null && lockedRead.cutPlates.length > 0,
    JSON.stringify({ lock: lockedRead.lock, values: lockedRead.values, upToDate: lockedRead.upToDate }));
  await conn.query('UPDATE cf_sales_order_lines SET locked_at = NULL WHERE company_id = ? AND id = ?', [COMPANY, f.lineA.id]);
  await conn.query(
    `UPDATE cf_spec_values v JOIN cf_specifications s ON s.id = v.specification_id SET v.value_number = 450
      WHERE v.company_id = ? AND v.subject_type = 'master' AND v.subject_id = ? AND s.code = 'WIDTH' AND v.deleted_at IS NULL`,
    [COMPANY, C],
  );
  eq('unlocked and put back as it was, there is nothing to catch up on', (await refresh(f.lineA.id)).out.reason, 'up_to_date');

  section('11. Lines with nothing to cut');
  eq('a line with a structure but no plate part: no_plate_parts', (await refresh(f.lineE.id)).out.reason, 'no_plate_parts');
  eq('a line selling a catalog item: no_structure', (await refresh(f.lineS.id)).out.reason, 'no_structure');

  section('12. Round trips do not grow with the number of parts');
  // Line B: twelve parts in five rectangles, against line A's three in two.
  const idsB = partsB.map((r) => r.id);
  await OV.writeLineValues(conn, c, f.lineB.id, {
    writes: [
      ...idsB.slice(0, 3).flatMap((id) => size(id, 10, 3000, 500)),
      ...idsB.slice(3, 6).flatMap((id) => size(id, 12, 2000, 400)),
      ...idsB.slice(6, 8).flatMap((id) => size(id, 16, 1500, 300)),
      ...idsB.slice(8, 10).flatMap((id) => size(id, 20, 1000, 250)),
      ...idsB.slice(10).flatMap((id) => size(id, 25, 900, 200)),
      ...markAll(idsB), ...steelAll(idsB),
    ],
  });
  invalidateNodeCache(conn);
  const firstB = await refresh(f.lineB.id);
  ok('line B\'s first derive made five blanks for twelve parts', firstB.out.made === true && firstB.out.summary.created === 5 && (await blanksOf(conn, f, f.lineB.id)).length === 5,
    JSON.stringify(firstB.out.summary));
  eq(`its first derive took the same number of round trips as line A's (${first.trips})`, firstB.trips, first.trips);
  const againB = await refresh(f.lineB.id);
  const againA = await refresh(f.lineA.id);
  // Line A has a plate chosen by hand by now (one more read, of that plate); line
  // B's plates are all still "chosen at nesting". Twelve parts must not cost more.
  ok(`nothing to change: no more round trips for twelve parts than for three (${againA.trips})`, againB.out.reason === 'up_to_date' && againB.trips <= againA.trips,
    `A ${againA.trips}, B ${againB.trips}`);
  const readA = await measured(conn, (db) => CUT.getCutPlates(db, COMPANY, f.lineA.id));
  const readB = await measured(conn, (db) => CUT.getCutPlates(db, COMPANY, f.lineB.id));
  ok(`the Cut pieces screen: no more round trips for twelve parts than for three (${readA.trips})`, readB.trips <= readA.trips && readA.trips <= 20, `A ${readA.trips}, B ${readB.trips}`);
  says(`round trips — first derive ${first.trips}, nothing to change ${againA.trips}, the read ${readA.trips}, the explicit derive with nothing to change ${explicit.trips}`);
} catch (e) {
  failed += 1;
  fails.push(`CRASH ${e.code ?? ''} ${e.message}`);
  console.log('CRASH', e.code ?? '', e.message, e.problems ?? '', e.stack?.split('\n').slice(0, 6).join(' / '));
} finally {
  await conn.rollback();
  detachNodeCache(conn);
  conn.release();
}

const after = await census(pool, TABLES);
const left = moved(before, after);
console.log(`\n${passed} passed, ${failed} failed (rolled back)`);
console.log(`nothing left behind: ${left.length ? 'NO' : 'yes'} — ${TABLES.length} cf_ tables counted${left.length ? `; ${left.join(', ')}` : ''}`);
if (fails.length) console.log(`failed: ${fails.join(' | ')}`);
await pool.end();
process.exit(failed || left.length ? 1 : 0);
