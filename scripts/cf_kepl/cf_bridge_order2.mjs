/**
 * cf_bridge_order2.mjs — the KEPL ROB 59.3 m job, as ONE customer order over
 * the generic definitions built by cf_bridge_defs.mjs.
 *
 * The rule the model now runs on: a DEFINITION is a design, an ITEM is a thing
 * you can track and move. So a definition says a girder segment has a top
 * flange, a web, a bottom flange and stiffeners — never how long. The sizes
 * arrive here, with the order:
 *
 *   one order line  ->  Bridge span x 2
 *                   ->  instantiateTemplate mints the whole tree as TEMPORARY
 *                       items, one per position, each free to differ
 *   this script     ->  reconciles each temporary against the BOQ: the lines
 *                       it does not need are removed, the ones it needs twice
 *                       at two sizes are added, and every part temporary gets
 *                       its own THICKNESS / LENGTH / WIDTH.
 *
 * That works because activation only checks required values for ITEMS
 * (masterRecordService.setStatus tests `record_kind === 'item'`), so the
 * definitions sit active with empty dimensions, and because resolutionService
 * resolves a temporary through classification -> its definition -> itself, so
 * PART_FUNCTION set once on `Top flange` is inherited live by all 20 of them.
 *
 * Nothing here is a number this script invented. Every weight is a ROLL-UP the
 * database computes (ASSEMBLY_WEIGHT = SUM(children.WEIGHT)) over leaves whose
 * own weight is PLATE_WEIGHT = L x W x T x DENSITY / 1e9. The span comes to
 * 334,644.13 kg against the BOQ's stated 334,644, and 669.29 MT for two spans
 * against its stated 669.29.
 *
 * Cut plates are deliberately NOT created: the parts are the leaves for now,
 * and the derivation that draws each one from a bought plate is a later step.
 *
 * Re-runnable: everything is find-or-change, so a second run reports nothing
 * created and nothing changed.
 *
 *   cd multi_app_be
 *   node scripts/cf_kepl/cf_bridge_order2.mjs [--dry-run|--verify-only]
 */
import path from 'path';
import { pathToFileURL } from 'url';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
await imp('apps/cf_erp/services/codegenProvider.js');
const bomSvc = await imp('apps/cf_erp/services/bomService.js');
const orderSvc = await imp('apps/cf_erp/services/salesOrderService.js');
const valueSvc = await imp('apps/cf_erp/services/valueService.js');
const resolution = await imp('apps/cf_erp/services/resolutionService.js');
const { loadMaster } = await imp('apps/cf_erp/services/records.js');
const { attachNodeCache, detachNodeCache } = await imp('apps/cf_erp/lib/db.js');
const D = await import(new URL('./cf_bridge_data.mjs', import.meta.url).href);

const DRY = process.argv.includes('--dry-run');
const VERIFY_ONLY = process.argv.includes('--verify-only');
const COMPANY = Number(process.env.CF_BRIDGE_COMPANY ?? 2);
const c = { companyId: COMPANY, userId: Number(process.env.CF_BRIDGE_USER ?? 22) };

const say = (...a) => console.log(...a);
const tally = {
  order: 0, orderLine: 0, linesAdded: 0, linesRemoved: 0, quantities: 0, selections: 0, values: 0,
};

// --- the job ------------------------------------------------------------------
const ORDER = {
  title: 'ROB 59.3 m, 2 spans',
  customerReference: D.BOQ.drgNo,          // P103-VDB-WK-DD-MJB-200+003-401
  receivedOn: '2026-07-08',                // the BOQ's own date
  spans: D.ORDER_SPANS,                    // 2
};
const CUSTOMER_CODE = 'KEPL';
const SPAN_DEF_NAME = 'Bridge span';

/** Names the BOM roles use, so a wrong tree is reported instead of silently patched. */
const ROLE = {
  girder: (n) => `Girder G${n}`,
  segment: (n) => `Segment ${n}`,
  splices: 'Splice joints',
  studs: 'Shear studs',
  endDia: 'End diaphragms',
  interDia: 'Intermediate diaphragms',
};

let conn;
const SPEC = new Map();        // CODE -> { id, data_type }
const OPTION = new Map();      // CODE -> Map(value -> option id)
const PART_DEF = new Map();    // PART_FUNCTION -> { id, name }
const FN_OF_DEF = new Map();   // definition id -> PART_FUNCTION
let SPAN_DEF = null;

// --- small reads --------------------------------------------------------------

async function loadSetup() {
  const [specs] = await conn.query(
    'SELECT id, code, data_type FROM cf_specifications WHERE company_id = ? AND deleted_at IS NULL', [COMPANY]);
  for (const s of specs) SPEC.set(s.code, s);
  for (const code of ['THICKNESS', 'LENGTH', 'WIDTH', 'WEIGHT', 'GRADE', 'IMPACT_CLASS', 'HOLED', 'PART_FUNCTION',
    'SPAN_LENGTH', 'SKEW_ANGLE', 'DRAWING_MARK']) {
    if (!SPEC.has(code)) throw new Error(`specification ${code} is missing — run cf_bridge_setup.mjs first`);
  }
  const [opts] = await conn.query(
    `SELECT s.code, o.id, o.value FROM cf_spec_options o
       JOIN cf_specifications s ON s.id = o.specification_id
      WHERE s.company_id = ? AND o.deleted_at IS NULL`, [COMPANY]);
  for (const o of opts) {
    if (!OPTION.has(o.code)) OPTION.set(o.code, new Map());
    OPTION.get(o.code).set(o.value, o.id);
  }

  // The part definitions, found by the PART_FUNCTION they carry — never by id,
  // and not by name either: the function is what makes one of them the right one.
  const [parts] = await conn.query(
    `SELECT m.id, m.code, m.name, o.value AS fn
       FROM cf_spec_values v
       JOIN cf_specifications s ON s.id = v.specification_id AND s.code = 'PART_FUNCTION'
       JOIN cf_spec_options o   ON o.id = v.option_id
       JOIN cf_master_records m ON m.id = v.subject_id AND m.record_kind = 'definition' AND m.deleted_at IS NULL
      WHERE v.company_id = ? AND v.subject_type = 'master' AND v.deleted_at IS NULL AND m.status = 'active'`,
    [COMPANY]);
  for (const p of parts) {
    if (PART_DEF.has(p.fn)) throw new Error(`two definitions carry PART_FUNCTION ${p.fn} — ${PART_DEF.get(p.fn).code} and ${p.code}`);
    PART_DEF.set(p.fn, p);
    FN_OF_DEF.set(p.id, p.fn);
  }
  for (const fn of new Set([...D.PARTS.values()].map((p) => p.fn))) {
    if (!PART_DEF.has(fn)) throw new Error(`no part definition carries PART_FUNCTION ${fn} — run cf_bridge_defs.mjs first`);
  }

  const [[span]] = await conn.query(
    `SELECT m.id, m.code, m.name, m.status FROM cf_master_records m
       JOIN cf_definition_details d ON d.master_id = m.id AND d.definition_type = 'template'
      WHERE m.company_id = ? AND m.name = ? AND m.deleted_at IS NULL`, [COMPANY, SPAN_DEF_NAME]);
  if (!span) throw new Error(`no template definition named "${SPAN_DEF_NAME}" — run cf_bridge_defs.mjs first`);
  if (span.status !== 'active') throw new Error(`${span.code} is ${span.status} — it must be active to sell`);
  SPAN_DEF = span;
  say(`   ${SPEC.size} specifications · ${PART_DEF.size} part definitions · span ${span.code}`);
}

/** A record's own stored values, by specification code. */
async function ownValues(masterId) {
  const [rows] = await conn.query(
    `SELECT s.code, v.value_number, v.value_text, v.value_bool, v.option_id, v.source
       FROM cf_spec_values v JOIN cf_specifications s ON s.id = v.specification_id
      WHERE v.company_id = ? AND v.subject_type = 'master' AND v.subject_id = ? AND v.deleted_at IS NULL`,
    [COMPANY, masterId]);
  return new Map(rows.map((r) => [r.code, r]));
}

function alreadyIs(row, specCode, want) {
  if (!row) return false;
  switch (SPEC.get(specCode).data_type) {
    case 'number': return row.value_number != null && Math.abs(Number(row.value_number) - Number(want)) < 1e-6;
    case 'boolean': return row.value_bool != null && Number(row.value_bool) === (want ? 1 : 0);
    case 'option': return row.option_id === OPTION.get(specCode)?.get(String(want));
    default: return (row.value_text ?? null) === (want == null ? null : String(want));
  }
}

/**
 * Sets values only when they are not already what they should be. Skipping the
 * call matters: setValues re-materialises the item AND walks the BOM above it,
 * so a second run that wrote nothing would still re-roll every weight.
 */
async function setVals(masterId, entries) {
  const own = await ownValues(masterId);
  const stale = entries.filter((e) => !alreadyIs(own.get(e.specCode), e.specCode, e.value));
  if (!stale.length) return 0;
  await valueSvc.setValues(conn, c, 'master', masterId, entries);
  tally.values += stale.length;
  return stale.length;
}

const bomOf = (parentId) => bomSvc.getBom(conn, COMPANY, parentId);

function roleLine(bom, role, what) {
  const line = bom.lines.find((l) => l.role === role);
  if (!line) {
    throw new Error(`${what}: ${bom.parent.code ?? bom.parent.name} has no BOM line with role "${role}" `
      + `(it has ${bom.lines.map((l) => `"${l.role}"`).join(', ') || 'none'}) — the definitions have changed shape`);
  }
  return line;
}

/** Sets a BOM line's quantity, if it is not that already. */
async function setQty(line, quantity, what) {
  if (Number(line.quantity) === Number(quantity)) return false;
  await bomSvc.updateLine(conn, c, line.id, { quantity });
  tally.quantities += 1;
  say(`   ${what}: quantity ${Number(line.quantity)} -> ${quantity}`);
  return true;
}

// --- matching a design onto a template's BOM ----------------------------------

const holedRank = (p) => (p.holed === true ? 1 : 0);
/**
 * Which design line lands on which template line, when one function has
 * several: plain before drilled, and otherwise the BOQ's own order.
 *
 * The BOQ's order IS the template's order — `Web Cover Plate`, then the top
 * flange covers, then the bottom flange ones, exactly as the Splice set
 * definition lists its five roles — so following it keeps every role saying
 * what the part actually is. Sorting by size instead would have weighed the
 * same and labelled the web cover plate as a flange cover.
 *
 * Plain-before-drilled has to override that, because the BOQ lists the two
 * intermediate stiffeners in whichever order it feels like (plain first in
 * three designs, drilled first in the other two) while the template has one
 * role for each. The sort is stable, so within a holed group the BOQ's order
 * survives. This is also what makes the match repeatable: run it again and
 * every design line lands on the line it landed on the first time.
 */
const byHoled = (a, b) => holedRank(a.part) - holedRank(b.part);

function wantedByFunction(designLines) {
  const out = new Map();
  for (const l of designLines) {
    const part = D.PARTS.get(l.key);
    if (!part) throw new Error(`the data module has no part for key ${l.key}`);
    if (!out.has(part.fn)) out.set(part.fn, []);
    out.get(part.fn).push({ part, quantity: l.quantity });
  }
  for (const arr of out.values()) arr.sort(byHoled);
  return out;
}

function haveByFunction(bom) {
  const out = new Map();
  for (const l of bom.lines) {
    const fn = FN_OF_DEF.get(l.design.id);
    if (!fn) {
      throw new Error(`${bom.parent.code ?? bom.parent.name} holds ${l.design.code} (role "${l.role}"), `
        + 'which is not a part definition — this script only reconciles assemblies made of parts');
    }
    if (!out.has(fn)) out.set(fn, []);
    out.get(fn).push(l);
  }
  return out;                    // getBom returns lines in (line_no, id) order
}

/** A role for a line the template did not have, saying what makes it different. */
function extraRole(base, part) {
  const tag = part.holed === true ? 'drilled' : part.holed === false ? 'plain' : `${part.thk} x ${part.wid}`;
  return `${base} — ${tag}`.slice(0, 100);
}

async function addPartLine(parentId, defId, quantity, role) {
  const before = new Set((await bomOf(parentId)).lines.map((l) => l.id));
  await bomSvc.addLine(conn, c, parentId, { childId: defId, quantity, role });
  const line = (await bomOf(parentId)).lines.find((l) => !before.has(l.id));
  if (!line) throw new Error(`adding ${role} to ${parentId} produced no line`);
  tally.linesAdded += 1;
  return line;
}

/**
 * What a part temporary has to carry.
 *
 * THICKNESS / LENGTH / WIDTH are the order's — that is the whole point of the
 * model. GRADE and IMPACT_CLASS are required on every fabricated part and the
 * BOQ never states them (see the data module's ASSUMPTIONS).
 *
 * PART_FUNCTION is set here too, although its definition already carries it,
 * because a value ABOVE an item is only effective when the rule is `defaulted`
 * or `fixed`: for an `entered` rule — which is what PART_FUNCTION is on
 * FAB_PARTS — resolutionService reads the item's OWN row and nothing else
 * (`case 'entered': if (own) ...`). So without this the part resolves with
 * PART_FUNCTION missing and could never be activated. Making that assignment
 * `defaulted` would let the definition's value flow down and this line could
 * go; that is a setup change, not an order's to make.
 */
function partEntries(part) {
  const e = [
    { specCode: 'THICKNESS', value: part.thk },
    { specCode: 'LENGTH', value: part.len },
    { specCode: 'WIDTH', value: part.wid },
    { specCode: 'PART_FUNCTION', value: part.fn },
    { specCode: 'GRADE', value: D.GRADE },
    { specCode: 'IMPACT_CLASS', value: D.IMPACT_CLASS },
  ];
  if (part.holed !== null) e.push({ specCode: 'HOLED', value: part.holed });
  return e;
}

/**
 * Makes one assembly's Custom BOM say what the BOQ says. The template gives a
 * line per KIND; a design may need none of that kind, or two of it at two
 * sizes. Lines are matched within a function group by shape, so the match is
 * stable across runs.
 */
async function reconcile(parentId, label, designLines) {
  const want = wantedByFunction(designLines);
  const have = haveByFunction(await bomOf(parentId));
  const notes = [];

  for (const fn of new Set([...want.keys(), ...have.keys()])) {
    const w = want.get(fn) ?? [];
    const h = have.get(fn) ?? [];
    const base = h[0]?.role ?? PART_DEF.get(fn).name;

    for (let i = w.length; i < h.length; i += 1) {
      await bomSvc.removeLine(conn, c, h[i].id);
      tally.linesRemoved += 1;
      notes.push(`-${h[i].role ?? fn}`);
    }
    for (let i = 0; i < w.length; i += 1) {
      let line = h[i];
      if (!line) {
        line = await addPartLine(parentId, PART_DEF.get(fn).id, w[i].quantity, extraRole(base, w[i].part));
        notes.push(`+${line.role}`);
      } else {
        if (await setQty(line, w[i].quantity, `${label} · ${line.role}`)) notes.push(`q:${line.role}`);
      }
      await setVals(line.child.id, partEntries(w[i].part));
    }
  }
  return notes;
}

// --- building -----------------------------------------------------------------

async function customer() {
  const [[p]] = await conn.query(
    'SELECT id, code, name, status, is_customer FROM cf_parties WHERE company_id = ? AND code = ? AND deleted_at IS NULL',
    [COMPANY, CUSTOMER_CODE]);
  if (!p) throw new Error(`no party ${CUSTOMER_CODE} — run cf_bridge_order.mjs's customer step, or add it in Parties`);
  // Its notes record that the full name is unconfirmed. Not this script's to change.
  say(`   customer ${p.code} — ${p.name}`);
  return p;
}

async function order(customerId) {
  const [[have]] = await conn.query(
    'SELECT id, code, status FROM cf_sales_orders WHERE company_id = ? AND customer_reference = ? AND deleted_at IS NULL',
    [COMPANY, ORDER.customerReference]);
  if (have) { say(`   order ${have.code} [${have.status}] — reused`); return have.id; }
  const o = await orderSvc.createOrder(conn, c, {
    orderType: 'customer',
    customerId,
    title: ORDER.title,
    customerReference: ORDER.customerReference,
    receivedOn: ORDER.receivedOn,
    notes: `${D.BOQ.title}. ${D.BOQ.arrangement}. Built from the customer's BOQ; see scripts/cf_kepl/boq.json.`,
  });
  tally.order += 1;
  say(`   order ${o.code} — created`);
  return o.id;
}

async function orderLine(orderId) {
  const o = await orderSvc.getOrder(conn, COMPANY, orderId);
  let line = o.lines.find((l) => l.design.id === SPAN_DEF.id);
  if (line) {
    if (Number(line.quantity) !== ORDER.spans) {
      await orderSvc.updateOrderLine(conn, c, line.id, { quantity: ORDER.spans });
      tally.quantities += 1;
      say(`   line ${line.lineNo}: quantity -> ${ORDER.spans}`);
    }
    say(`   line ${line.lineNo}: ${line.item.code ?? line.item.name} x ${ORDER.spans} — reused`);
    return line;
  }
  say(`   instantiating ${SPAN_DEF.code} x ${ORDER.spans} — this mints the whole tree`);
  const after = await orderSvc.addOrderLine(conn, c, orderId, {
    recordId: SPAN_DEF.id,
    quantity: ORDER.spans,
    description: `${ORDER.title} — ${D.SPAN.name}`,
  });
  tally.orderLine += 1;
  line = after.lines.find((l) => l.design.id === SPAN_DEF.id);
  say(`   line ${line.lineNo}: ${line.item.code ?? line.item.name} x ${ORDER.spans} — created`);
  return line;
}

async function resolveStuds(line) {
  if (line.resolved) return false;
  const { candidates } = await bomSvc.lineCandidates(conn, COMPANY, line.id);
  const pick = candidates.find((x) => x.isDefault) ?? (candidates.length === 1 ? candidates[0] : null);
  if (!pick) throw new Error(`${line.selection.code} has ${candidates.length} candidates and no default — cannot choose the stud`);
  await bomSvc.resolveLine(conn, c, line.id, { itemId: pick.id });
  tally.selections += 1;
  say(`   studs -> ${pick.code ?? pick.name}`);
  return true;
}

async function build(line) {
  const spanId = line.item.id;
  await setVals(spanId, [
    { specCode: 'SPAN_LENGTH', value: D.SPAN.spanLengthMm },
    { specCode: 'SKEW_ANGLE', value: D.SPAN.skewDeg },
  ]);

  const designByRef = new Map(D.SEGMENTS.map((s) => [s.ref, s]));
  const subByRef = new Map(D.SUBS.map((s) => [s.ref, s]));
  const span = await bomOf(spanId);

  say('\n-- girder lines --');
  for (const layout of D.LINE_LAYOUT) {
    const g = Number(layout.line.slice(1));
    const glLine = roleLine(span, ROLE.girder(g), 'span');
    await setQty(glLine, 1, `span · ${ROLE.girder(g)}`);
    const gl = await bomOf(glLine.child.id);

    for (const seg of layout.segments) {
      const segLine = roleLine(gl, ROLE.segment(seg.position), layout.line);
      await setQty(segLine, 1, `${layout.line} · ${ROLE.segment(seg.position)}`);
      const design = designByRef.get(seg.design);
      const notes = await reconcile(segLine.child.id, seg.mark, design.lines);
      await setVals(segLine.child.id, [{ specCode: 'DRAWING_MARK', value: seg.mark }]);
      say(`   ${seg.mark.padEnd(6)} ${design.ref}  ${String(design.lines.length).padStart(2)} part lines`
        + `${notes.length ? `  [${notes.join(' ')}]` : ''}`);
    }

    const splLine = roleLine(gl, ROLE.splices, layout.line);
    await setQty(splLine, D.SPLICES_PER_LINE, `${layout.line} · ${ROLE.splices}`);
    await reconcile(splLine.child.id, `${layout.line} splices`, subByRef.get('SPLICE').lines);

    const studLine = roleLine(gl, ROLE.studs, layout.line);
    await resolveStuds(studLine);
    await setQty(studLine, D.STUD.perGirderLine, `${layout.line} · ${ROLE.studs}`);
    say(`   ${layout.line.padEnd(6)} + ${D.SPLICES_PER_LINE} splice sets, ${D.STUD.perGirderLine} studs`);
  }

  say('\n-- diaphragms --');
  for (const [role, ref] of [[ROLE.endDia, 'END-DIA'], [ROLE.interDia, 'INT-DIA']]) {
    const sub = subByRef.get(ref);
    const dLine = roleLine(span, role, 'span');
    await setQty(dLine, sub.perSpan, `span · ${role}`);
    await reconcile(dLine.child.id, sub.name, sub.lines);
    say(`   ${role.padEnd(24)} x ${sub.perSpan}, ${sub.lines.length} part lines`);
  }
}

// --- verifying ----------------------------------------------------------------

const near = (a, b, tol) => a != null && Math.abs(Number(a) - Number(b)) <= tol;
const fmt = (n) => (n == null ? '(none)' : Number(n).toFixed(2));

async function weightOf(id) {
  const [[r]] = await conn.query(
    `SELECT v.value_number, v.source FROM cf_spec_values v
      WHERE v.company_id = ? AND v.subject_type = 'master' AND v.subject_id = ?
        AND v.specification_id = ? AND v.deleted_at IS NULL`, [COMPANY, id, SPEC.get('WEIGHT').id]);
  return r ? { kg: Number(r.value_number), source: r.source } : { kg: null, source: null };
}

async function verify() {
  const fail = [];
  const [[o]] = await conn.query(
    `SELECT o.id, o.code, o.status, o.title, p.code AS customer FROM cf_sales_orders o
       LEFT JOIN cf_parties p ON p.id = o.customer_id
      WHERE o.company_id = ? AND o.customer_reference = ? AND o.deleted_at IS NULL`,
    [COMPANY, ORDER.customerReference]);
  if (!o) { say('\n   NO ORDER — nothing to verify'); return ['the order is not there']; }
  const [lines] = await conn.query(
    'SELECT id, line_no, item_id, quantity FROM cf_sales_order_lines WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL',
    [COMPANY, o.id]);
  say(`\n-- order ${o.code} [${o.status}] · ${o.customer} · "${o.title}" · ${lines.length} line(s) --`);
  if (lines.length !== 1) fail.push(`the order has ${lines.length} lines, not 1`);
  const line = lines[0];
  const spanId = line.item_id;

  // --- walk the structure back out of the database, by role -------------------
  const count = { girderLines: 0, segments: 0, spliceSets: 0, endDia: 0, interDia: 0, studs: 0 };
  const segments = [];
  const span = await bomOf(spanId);
  for (const layout of D.LINE_LAYOUT) {
    const g = Number(layout.line.slice(1));
    const glLine = span.lines.find((l) => l.role === ROLE.girder(g));
    if (!glLine) { fail.push(`the span has no "${ROLE.girder(g)}"`); continue; }
    const q1 = Number(glLine.quantity);
    count.girderLines += q1;
    const gl = await bomOf(glLine.child.id);
    for (const seg of layout.segments) {
      const sl = gl.lines.find((l) => l.role === ROLE.segment(seg.position));
      if (!sl) { fail.push(`${layout.line} has no "${ROLE.segment(seg.position)}"`); continue; }
      count.segments += q1 * Number(sl.quantity);
      segments.push({ mark: seg.mark, design: seg.design, id: sl.child.id, code: sl.child.code });
    }
    const sp = gl.lines.find((l) => l.role === ROLE.splices);
    const st = gl.lines.find((l) => l.role === ROLE.studs);
    if (sp) count.spliceSets += q1 * Number(sp.quantity); else fail.push(`${layout.line} has no "${ROLE.splices}"`);
    if (st) {
      count.studs += q1 * Number(st.quantity);
      if (!st.resolved) fail.push(`${layout.line}: the shear stud selection is still unchosen`);
    } else fail.push(`${layout.line} has no "${ROLE.studs}"`);
  }
  const ed = span.lines.find((l) => l.role === ROLE.endDia);
  const id = span.lines.find((l) => l.role === ROLE.interDia);
  count.endDia = ed ? Number(ed.quantity) : 0;
  count.interDia = id ? Number(id.quantity) : 0;

  // --- segment weights against the BOQ ---------------------------------------
  say('\n-- the 20 segments, against their design --');
  const designByRef = new Map(D.SEGMENTS.map((s) => [s.ref, s]));
  for (const s of segments) {
    const want = designByRef.get(s.design).grossKg;
    const { kg } = await weightOf(s.id);
    const ok = near(kg, want, 0.05);
    if (!ok) fail.push(`${s.mark} weighs ${fmt(kg)} kg, the BOQ says ${want}`);
    say(`   ${s.mark.padEnd(6)} ${s.design}  ${String(s.code ?? '').padEnd(10)} ${fmt(kg).padStart(11)} kg `
      + `vs ${want.toFixed(2).padStart(10)}  ${ok ? 'ok' : 'WRONG'}`);
  }

  // --- every temporary on the order -------------------------------------------
  const [temps] = await conn.query(
    `SELECT m.id, m.code, m.name, m.status, n.code AS node
       FROM cf_item_details i
       JOIN cf_master_records m ON m.id = i.master_id AND m.deleted_at IS NULL
       JOIN cf_classification_nodes n ON n.id = m.classification_id
      WHERE i.company_id = ? AND i.owner_order_line_id = ? AND i.item_type = 'temporary' AND i.deleted_at IS NULL`,
    [COMPANY, line.id]);
  let partsChecked = 0;
  let notActivatable = 0;
  for (const t of temps) {
    const own = await ownValues(t.id);
    if (t.node === 'PLATE_PART') {
      partsChecked += 1;
      for (const code of ['THICKNESS', 'LENGTH', 'WIDTH']) {
        if (own.get(code)?.value_number == null) fail.push(`${t.code ?? t.name} (${t.id}) has no ${code}`);
      }
      const w = own.get('WEIGHT');
      if (w?.value_number == null) fail.push(`${t.code ?? t.name} (${t.id}) has no WEIGHT`);
      else if (w.source !== 'calculated') fail.push(`${t.code ?? t.name}: WEIGHT is "${w.source}", not calculated`);
    }
    const r = await resolution.resolve(conn, COMPANY, { master: await loadMaster(conn, COMPANY, t.id) });
    if (r.missingRequired.length) {
      notActivatable += 1;
      fail.push(`${t.code ?? t.name} (${t.node}) still needs ${r.missingRequired.map((s) => s.code).join(', ')}`);
    }
  }

  // --- the money number --------------------------------------------------------
  const perSpan = (await weightOf(spanId)).kg;
  const total = perSpan == null ? null : perSpan * Number(line.quantity);
  const WANT_SPAN = 334644.13;
  const WANT_MT = 669.29;
  if (!near(perSpan, WANT_SPAN, 0.05)) fail.push(`the span weighs ${fmt(perSpan)} kg, expected ${WANT_SPAN}`);
  if (!near(total / 1000, WANT_MT, 0.01)) fail.push(`the order weighs ${fmt(total / 1000)} MT, expected ${WANT_MT}`);

  const WANT_COUNT = {
    girderLines: 4, segments: 20, spliceSets: 16, endDia: 6, interDia: 45, studs: D.STUD.perGirderLine * 4,
  };
  say('\n-- counts, per span --');
  for (const [k, want] of Object.entries(WANT_COUNT)) {
    const got = count[k];
    if (got !== want) fail.push(`${k}: ${got}, expected ${want}`);
    say(`   ${k.padEnd(12)} ${String(got).padStart(5)}  ${got === want ? 'ok' : `WRONG, expected ${want}`}`);
  }

  say('\n-- weight --');
  say(`   ${temps.length} temporary items · ${partsChecked} plate parts · ${notActivatable} short of a required value`);
  say(`   span            ${fmt(perSpan).padStart(12)} kg   (BOQ ${WANT_SPAN})`);
  say(`   order x${Number(line.quantity)}        ${fmt(total).padStart(12)} kg   = ${(total / 1000).toFixed(4)} MT  (BOQ ${WANT_MT} MT)`);
  const girders = segments.length ? (await Promise.all(segments.map((s) => weightOf(s.id)))).reduce((t, w) => t + (w.kg ?? 0), 0) : 0;
  say(`   of which girder segments ${girders.toFixed(2)} kg (BOQ ${D.BOQ.check.girderKg})`);
  return fail;
}

// --- run ----------------------------------------------------------------------

try {
  conn = await pool.getConnection();
  await conn.beginTransaction();
  attachNodeCache(conn);
  say(`cf_erp KEPL bridge order -> company ${COMPANY}${DRY ? '  (dry run, rolled back)' : ''}${VERIFY_ONLY ? '  (verify only)' : ''}`);

  say('\n-- setup --');
  await loadSetup();

  if (!VERIFY_ONLY) {
    const p = await customer();
    const orderId = await order(p.id);
    const line = await orderLine(orderId);
    await build(line);
  }

  const problems = await verify();

  if (DRY || VERIFY_ONLY) {
    await conn.rollback();
    say(`\n  ${VERIFY_ONLY ? 'verify only' : 'dry run'} — rolled back, nothing kept.`);
  } else {
    detachNodeCache(conn);
    await conn.commit();
    attachNodeCache(conn);
  }

  say(`\n  created/changed: ${JSON.stringify(tally)}`);
  if (problems.length) {
    say(`\n  ${problems.length} PROBLEM(S):`);
    for (const p of problems) say(`   - ${p}`);
    process.exitCode = 1;
  } else {
    say('\ndone — the order reconciles to the BOQ.');
  }
} catch (e) {
  if (conn) await conn.rollback();
  console.error('\nFAILED:', e.code ?? '', e.message, e.problems ?? '');
  process.exitCode = 1;
} finally {
  if (conn) { detachNodeCache(conn); conn.release(); }
  await pool.end();
}
