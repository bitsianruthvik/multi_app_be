/**
 * cf_bridge_order.mjs — everything ABOVE the catalog for the KEPL ROB job:
 * the selection that picks a girder-segment design, the girder-line and
 * bridge-span templates, the customer, the sales order, and the twenty
 * resolutions that turn a generic span into THIS span.
 *
 * It assumes the catalog is already there — classification, specifications,
 * formulas, coding rules, every plate part, the five girder-segment designs,
 * the diaphragms, the splice set and the shear stud, each with its Standard
 * BOM. That is the other half of the job and it runs first; this script waits
 * for its marker file and then reads the ids out of it.
 *
 * Structure built (per span):
 *
 *   TPL-BRIDGE-SPAN  (template, BRIDGE_SPAN, SPAN_LENGTH 59300, SKEW_ANGLE 17)
 *     4 x TPL-GIRDER-LINE                      roles "Girder G1".."Girder G4"
 *           5 x SEL-GIRDER-SEGMENT             roles "Segment 1".."Segment 5"
 *           4 x Splice set
 *        1803 x Shear stud
 *     6 x End diaphragm
 *    45 x Intermediate diaphragm
 *
 * Everything goes through the cf_erp services, so the rules are enforced and
 * the value engine rolls the weights up. No raw INSERT into any cf_ table;
 * reads are direct SQL because that is how the verification proves the numbers
 * came out of the database and not out of cf_bridge_data.mjs.
 *
 * Re-runnable. Natural keys: the record CODE for the three definitions, the
 * party code for the customer, and (customer, customer_reference) for the
 * order. A second run creates nothing.
 *
 *   cd multi_app_be && node <this file>
 *   CF_BRIDGE_COMPANY=2 node <this file>
 *   node <this file> --verify-only        # no writes, just the checks
 *   node <this file> --no-marker          # look the catalog up by name instead
 */
import path from 'path';
import fs from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const MARKER = path.join(HERE, '.bridge_catalog_done');

const { pool } = await imp('db.js');
await imp('apps/cf_erp/services/codegenProvider.js');   // side effect: registers the code-generator entities
const recs = await imp('apps/cf_erp/services/masterRecordService.js');
const selections = await imp('apps/cf_erp/services/selectionService.js');
const boms = await imp('apps/cf_erp/services/bomService.js');
const orders = await imp('apps/cf_erp/services/salesOrderService.js');
const values = await imp('apps/cf_erp/services/valueService.js');
const parties = await imp('apps/cf_erp/modules/parties/service.js');

const D = await import(pathToFileURL(path.join(HERE, 'cf_bridge_data.mjs')).href);
const { SEGMENTS, SUBS, STUD, LINE_LAYOUT, SPAN, SEGMENTS_PER_LINE, SPLICES_PER_LINE, ORDER_SPANS } = D;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const COMPANY = Number(process.env.CF_BRIDGE_COMPANY ?? 2);
const WANT_USER = Number(process.env.CF_BRIDGE_USER ?? 22);
const VERIFY_ONLY = process.argv.includes('--verify-only');
const NO_MARKER = process.argv.includes('--no-marker');

/** The BOQ's own identifiers — the natural keys of the order. */
const DRAWING = 'P103-VDB-WK-DD-MJB-200+003-401';
const RECEIVED_ON = '2026-07-08';
const ORDER_TITLE = 'ROB 59.3 m, 2 spans';
const LINE_DESCRIPTION = 'ROB span 59.3 m, 4 girder lines, 17 deg skew';
const CUSTOMER_CODE = 'KEPL';
const CUSTOMER_NAME = 'KEPL — Kalyan Engineering Projects Ltd.';
/** Only used when the tenant has no coding rule for sales orders. */
const FALLBACK_ORDER_CODE = 'SO-KEPL-ROB60';

const SEL_CODE = 'SEL-GIRDER-SEGMENT';
const LINE_CODE = 'TPL-GIRDER-LINE';
const SPAN_CODE = 'TPL-BRIDGE-SPAN';

const tally = { created: {}, reused: {}, updated: {} };
const bump = (bag, k, n = 1) => { bag[k] = (bag[k] ?? 0) + n; };
const made = (k, n = 1) => bump(tally.created, k, n);
const kept = (k, n = 1) => bump(tally.reused, k, n);
const changed = (k, n = 1) => bump(tally.updated, k, n);
const say = (...a) => console.log(...a);
const notes = [];
const failures = [];
const kg = (n) => (n == null ? 'null' : Number(n).toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 }));
const why = (e) => [e.message, ...(e.problems ?? [])].join(' | ');

// ---------------------------------------------------------------------------
// Finding the catalog the other half built
// ---------------------------------------------------------------------------

/** Every leaf of the marker JSON that looks like an id, keyed by its own key and by every path to it. */
function flattenMarker(node, prefix, out) {
  if (node == null) return out;
  if (typeof node === 'number') { out.set(prefix, node); return out; }
  if (typeof node === 'string' && /^\d+$/.test(node)) { out.set(prefix, Number(node)); return out; }
  if (Array.isArray(node)) {
    for (const entry of node) {
      const key = entry?.ref ?? entry?.key ?? entry?.code ?? entry?.name;
      const id = entry?.id ?? entry?.itemId ?? entry?.masterId;
      if (key != null && Number.isFinite(Number(id))) out.set(String(key).toUpperCase(), Number(id));
    }
    return out;
  }
  if (typeof node === 'object') {
    const id = node.id ?? node.itemId ?? node.masterId;
    if (Number.isFinite(Number(id))) {
      // Both the key this object was FILED under ("END-DIA") and the one it
      // carries ("EDIA-001") — the marker may use either as its name for a thing.
      for (const key of [prefix, node.ref, node.key, node.code]) {
        if (key != null && String(key) !== '') out.set(String(key).toUpperCase(), Number(id));
      }
    }
    for (const [k, v] of Object.entries(node)) {
      flattenMarker(v, k, out);
      if (prefix) flattenMarker(v, `${prefix}.${k}`, out);
    }
  }
  return out;
}

function readMarker() {
  if (NO_MARKER) { notes.push('--no-marker: the catalog was located by name, not from the marker file.'); return new Map(); }
  if (!fs.existsSync(MARKER)) return null;
  let raw;
  try { raw = JSON.parse(fs.readFileSync(MARKER, 'utf8')); } catch (e) {
    notes.push(`${path.basename(MARKER)} is not readable JSON (${e.message}) — the catalog was located by name instead.`);
    return new Map();
  }
  return flattenMarker(raw, '', new Map());
}

/** One catalog item: from the marker if it names it, otherwise by its name, otherwise by short name in its Variant. */
async function findItem(db, c, { ref, name, shortName, nodeCode }, marker) {
  const load = async (where, params) => {
    const [[row]] = await db.query(
      `SELECT m.id, m.code, m.name, m.status, m.short_name, n.code AS node_code, i.item_type
         FROM cf_master_records m
         JOIN cf_item_details i ON i.master_id = m.id AND i.deleted_at IS NULL
         LEFT JOIN cf_classification_nodes n ON n.id = m.classification_id
        WHERE m.company_id = ? AND m.record_kind = 'item' AND m.deleted_at IS NULL AND ${where}`,
      [c.companyId, ...params],
    );
    return row || null;
  };
  let row = null;
  const id = marker?.get(String(ref).toUpperCase());
  if (Number.isFinite(id)) row = await load('m.id = ?', [id]);
  if (!row && name) row = await load('m.name = ?', [name]);
  if (!row && shortName && nodeCode) row = await load('m.short_name = ? AND n.code = ?', [shortName, nodeCode]);
  if (!row && ref) row = await load('m.code = ?', [ref]);
  return row;
}

/** Everything this script needs out of the catalog, or a list of what is missing. */
async function findCatalog(db, c, marker) {
  const missing = [];
  const take = async (spec) => {
    const row = await findItem(db, c, spec, marker);
    if (!row) missing.push(`${spec.ref} — ${spec.name ?? spec.shortName}`);
    else if (row.status !== 'active') missing.push(`${spec.ref} (${row.code ?? row.name}) is ${row.status}, not active`);
    else if (row.item_type !== 'catalog') missing.push(`${spec.ref} (${row.code ?? row.name}) is a ${row.item_type} item`);
    return row;
  };

  const segments = [];
  for (const s of SEGMENTS) segments.push({ ref: s.ref, row: await take({ ref: s.ref, name: s.name, nodeCode: 'GIRDER_SEGMENT' }) });
  const sub = (ref) => SUBS.find((s) => s.ref === ref);
  const out = {
    segments,
    segmentById: new Map(segments.filter((s) => s.row).map((s) => [s.ref, s.row])),
    endDia: await take({ ref: 'END-DIA', name: sub('END-DIA').name, shortName: sub('END-DIA').short, nodeCode: 'DIAPHRAGM' }),
    intDia: await take({ ref: 'INT-DIA', name: sub('INT-DIA').name, shortName: sub('INT-DIA').short, nodeCode: 'DIAPHRAGM' }),
    splice: await take({ ref: 'SPLICE', name: sub('SPLICE').name, shortName: sub('SPLICE').short, nodeCode: 'SPLICE_SET' }),
    stud: await take({ ref: 'STUD', name: STUD.name, shortName: STUD.short, nodeCode: 'SHEAR_STUD' }),
    missing,
  };
  const [nodes] = await db.query(
    "SELECT id, code FROM cf_classification_nodes WHERE company_id = ? AND deleted_at IS NULL AND code IN ('GIRDER_SEGMENT','GIRDER_LINE','BRIDGE_SPAN')",
    [c.companyId],
  );
  out.node = Object.fromEntries(nodes.map((n) => [n.code, n.id]));
  for (const code of ['GIRDER_SEGMENT', 'GIRDER_LINE', 'BRIDGE_SPAN']) {
    if (!out.node[code]) missing.push(`classification variant ${code}`);
  }
  const [specs] = await db.query(
    "SELECT id, code, data_type FROM cf_specifications WHERE company_id = ? AND deleted_at IS NULL AND code IN ('SPAN_LENGTH','SKEW_ANGLE','WEIGHT')",
    [c.companyId],
  );
  out.spec = Object.fromEntries(specs.map((s) => [s.code, s]));
  return out;
}

// ---------------------------------------------------------------------------
// Reuse-by-code helpers
// ---------------------------------------------------------------------------

async function loadDefinition(db, c, code) {
  const [[row]] = await db.query(
    `SELECT m.id, m.code, m.name, m.status, d.definition_type, d.selection_mode, d.candidate_classification_id
       FROM cf_master_records m
       JOIN cf_definition_details d ON d.master_id = m.id AND d.deleted_at IS NULL
      WHERE m.company_id = ? AND m.code = ? AND m.record_kind = 'definition' AND m.deleted_at IS NULL`,
    [c.companyId, code],
  );
  return row || null;
}

async function ensureDefinition(db, c, body) {
  const have = await loadDefinition(db, c, body.code);
  if (have) { kept(`${body.definitionType} definition`); return have; }
  const created = await recs.createDefinition(db, c, body);
  made(`${body.definitionType} definition`);
  return loadDefinition(db, c, body.code);
}

async function activate(db, c, id, label) {
  const [[m]] = await db.query('SELECT status FROM cf_master_records WHERE company_id = ? AND id = ?', [c.companyId, id]);
  if (m.status === 'active') { kept('definition already active'); return; }
  try {
    await recs.setStatus(db, c, id, 'active');
    changed('definition activated');
  } catch (e) {
    failures.push(`activating ${label}: ${why(e)}`);
    throw e;
  }
}

async function activateBom(db, c, parentId, label) {
  const view = await boms.getBom(db, c.companyId, parentId);
  if (view.bom?.status === 'active') { kept('BOM already active'); return; }
  try {
    await boms.setBomStatus(db, c, parentId, 'active');
    changed('BOM activated');
  } catch (e) {
    failures.push(`activating the BOM of ${label}: ${why(e)}`);
    throw e;
  }
}

/**
 * One line of a Template BOM, keyed by its ROLE — the role is what the line
 * means ("Segment 3"), and it is what the resolution reads later, so it is the
 * only key that survives a re-run in which line numbers shift.
 */
async function ensureBomLine(db, c, parentId, { childId, quantity, role, lineNo }) {
  const view = await boms.getBom(db, c.companyId, parentId);
  const have = view.lines.find((l) => l.role === role);
  if (have) {
    if (have.design.id !== childId) {
      failures.push(`line "${role}" of ${view.parent.code ?? view.parent.name} holds ${have.design.code ?? have.design.name}, not the record this script wants (${childId}).`);
      return have;
    }
    if (Number(have.quantity) !== Number(quantity)) {
      await boms.updateLine(db, c, have.id, { quantity });
      changed('BOM line quantity');
      notes.push(`line "${role}" of ${view.parent.code}: quantity corrected from ${have.quantity} to ${quantity}.`);
    } else kept('BOM line');
    return have;
  }
  await boms.addLine(db, c, parentId, { childId, quantity, role, lineNo });
  made('BOM line');
  const after = await boms.getBom(db, c.companyId, parentId);
  return after.lines.find((l) => l.role === role);
}

// ---------------------------------------------------------------------------
// 1. The selection
// ---------------------------------------------------------------------------

/**
 * How SEL-GIRDER-SEGMENT should find its designs.
 *
 * spec_match is the better shape when a specification genuinely says "this is a
 * girder-segment design" — then a design added next year is found without
 * anyone remembering to add it to a list. So the database is asked what the
 * designs actually carry, and a criterion is used only if some option or text
 * specification is present on ALL of them with ONE shared value.
 *
 * A purely numeric spec is not enough. The only number these assemblies carry
 * is WEIGHT, which is rolled up from their BOMs; a criterion like WEIGHT > 0 is
 * true of every one of them but says nothing, and it would silently drop a new
 * design whose weight has not rolled up yet. That is a worse rule than a list.
 */
async function decideSelection(db, c, catalog) {
  const ids = catalog.segments.map((s) => s.row?.id).filter(Boolean);
  if (!ids.length) return { mode: 'allowed_list', reason: 'no girder-segment designs were found at all.' };
  const [rows] = await db.query(
    `SELECT s.id, s.code, s.data_type,
            COUNT(DISTINCT v.subject_id) AS on_items,
            COUNT(DISTINCT COALESCE(o.value, v.value_text, CAST(v.value_number AS CHAR), CAST(v.value_bool AS CHAR))) AS distinct_values,
            MIN(COALESCE(o.value, v.value_text)) AS one_value
       FROM cf_spec_values v
       JOIN cf_specifications s ON s.id = v.specification_id AND s.deleted_at IS NULL
       LEFT JOIN cf_spec_options o ON o.id = v.option_id
      WHERE v.company_id = ? AND v.subject_type = 'master' AND v.subject_id IN (?) AND v.deleted_at IS NULL
      GROUP BY s.id ORDER BY s.code`,
    [c.companyId, ids],
  );
  say(`  specifications carried by all ${ids.length} girder-segment designs:`);
  for (const r of rows) say(`     ${r.code.padEnd(14)} ${String(r.data_type).padEnd(8)} on ${r.on_items}/${ids.length} designs, ${r.distinct_values} distinct value(s)`);
  const marker = rows.find((r) => ['option', 'text'].includes(r.data_type) && Number(r.on_items) === ids.length && Number(r.distinct_values) === 1 && r.one_value);
  if (marker) {
    return {
      mode: 'spec_match',
      criterion: { specificationId: marker.id, operator: 'eq', value: marker.one_value, sortOrder: 1 },
      reason: `${marker.code} = ${marker.one_value} is on every design and on nothing else in the search area.`,
    };
  }
  const numeric = rows.filter((r) => r.data_type === 'number' && Number(r.on_items) === ids.length).map((r) => r.code);
  return {
    mode: 'allowed_list',
    reason: `no option or text specification marks a girder-segment design.${numeric.length ? ` The only spec(s) every design carries are numeric (${numeric.join(', ')}) — a criterion over a rolled-up number is a tautology that would drop any design whose weight has not rolled up yet.` : ''}`,
  };
}

async function buildSelection(db, c, catalog) {
  const existing = await loadDefinition(db, c, SEL_CODE);
  if (existing) kept('selection definition');
  const plan = existing
    ? { mode: existing.selection_mode, reason: 'it already exists — the mode it was created with is kept.' }
    : await decideSelection(db, c, catalog);
  say(`  selection mode: ${plan.mode} — ${plan.reason}`);

  const def = existing ?? await ensureDefinition(db, c, {
    definitionType: 'selection',
    classificationId: catalog.node.GIRDER_SEGMENT,
    code: SEL_CODE,
    name: 'Girder segment (choose the design)',
    shortName: 'SELGS',
    selectionMode: plan.mode,
    candidateClassificationId: catalog.node.GIRDER_SEGMENT,
    description: 'Which of the ROB 59.3 m girder-segment designs sits at this position of this girder line.',
    status: 'draft',
  });

  const state = await selections.getSelection(db, c.companyId, def.id);
  if (plan.mode === 'spec_match') {
    if (!state.criteria.length) {
      await selections.addCriterion(db, c, def.id, plan.criterion);
      made('selection criterion');
    } else kept('selection criterion', state.criteria.length);
  } else {
    const held = new Set(state.allowedItems.map((a) => a.itemId));
    for (const [i, s] of catalog.segments.entries()) {
      if (!s.row) continue;
      if (held.has(s.row.id)) { kept('allowed item'); continue; }
      await selections.addAllowedItem(db, c, def.id, { itemId: s.row.id, isDefault: i === 0 });
      made('allowed item');
    }
  }
  await activate(db, c, def.id, SEL_CODE);
  return loadDefinition(db, c, SEL_CODE);
}

// ---------------------------------------------------------------------------
// 2. The templates
// ---------------------------------------------------------------------------

async function buildGirderLine(db, c, catalog, sel) {
  const def = await ensureDefinition(db, c, {
    definitionType: 'template',
    classificationId: catalog.node.GIRDER_LINE,
    code: LINE_CODE,
    name: `Girder line, ${SEGMENTS_PER_LINE} segments (ROB 59.3 m)`,
    shortName: 'GLINE',
    description: `Five segments end to end, so ${SPLICES_PER_LINE} splice joints, plus the ${STUD.perGirderLine} shear studs welded along the top flange.`,
    status: 'draft',
  });
  // One line PER POSITION, never one line of quantity five: each position is
  // resolved on its own, and two positions of one girder line take different
  // designs (G2 is GS-003, GS-004, GS-004, GS-004, GS-003).
  for (let i = 1; i <= SEGMENTS_PER_LINE; i++) {
    await ensureBomLine(db, c, def.id, { childId: sel.id, quantity: 1, role: `Segment ${i}`, lineNo: i * 10 });
  }
  await ensureBomLine(db, c, def.id, { childId: catalog.splice.id, quantity: SPLICES_PER_LINE, role: 'Splice joints', lineNo: 100 });
  await ensureBomLine(db, c, def.id, { childId: catalog.stud.id, quantity: STUD.perGirderLine, role: 'Shear studs', lineNo: 110 });
  await activate(db, c, def.id, LINE_CODE);
  await activateBom(db, c, def.id, LINE_CODE);
  return def;
}

async function buildSpan(db, c, catalog, girderLine) {
  const spanValues = [];
  if (catalog.spec.SPAN_LENGTH) spanValues.push({ specCode: 'SPAN_LENGTH', value: SPAN.spanLengthMm });
  else notes.push('SPAN_LENGTH does not exist as a specification — the span length was not recorded on TPL-BRIDGE-SPAN.');
  if (catalog.spec.SKEW_ANGLE) spanValues.push({ specCode: 'SKEW_ANGLE', value: SPAN.skewDeg });
  else notes.push('SKEW_ANGLE does not exist as a specification — the skew was not recorded on TPL-BRIDGE-SPAN.');

  const existing = await loadDefinition(db, c, SPAN_CODE);
  if (existing) kept('template definition');
  const def = existing ?? await ensureDefinition(db, c, {
    definitionType: 'template',
    classificationId: catalog.node.BRIDGE_SPAN,
    code: SPAN_CODE,
    name: SPAN.name,
    shortName: 'SPAN',
    description: `${SPAN.girderLines} girder lines, ${SPAN.endDiaphragms} end diaphragms and ${SPAN.interDiaphragms} intermediate diaphragms.`,
    status: 'draft',
    values: spanValues,
  });
  await ensureSpanValues(db, c, def.id, spanValues);

  for (const [i, g] of LINE_LAYOUT.entries()) {
    await ensureBomLine(db, c, def.id, { childId: girderLine.id, quantity: 1, role: `Girder ${g.line}`, lineNo: (i + 1) * 10 });
  }
  await ensureBomLine(db, c, def.id, { childId: catalog.endDia.id, quantity: SPAN.endDiaphragms, role: 'End diaphragms', lineNo: 100 });
  await ensureBomLine(db, c, def.id, { childId: catalog.intDia.id, quantity: SPAN.interDiaphragms, role: 'Intermediate diaphragms', lineNo: 110 });
  await activate(db, c, def.id, SPAN_CODE);
  await activateBom(db, c, def.id, SPAN_CODE);
  return def;
}

/** On a re-run: write the two span values only if they are missing or different. */
async function ensureSpanValues(db, c, id, want) {
  if (!want.length) return;
  const [rows] = await db.query(
    `SELECT s.code, v.value_number FROM cf_spec_values v JOIN cf_specifications s ON s.id = v.specification_id
      WHERE v.company_id = ? AND v.subject_type = 'master' AND v.subject_id = ? AND v.deleted_at IS NULL`,
    [c.companyId, id],
  );
  const have = new Map(rows.map((r) => [r.code, r.value_number == null ? null : Number(r.value_number)]));
  const missing = want.filter((v) => !have.has(v.specCode) || Math.abs(have.get(v.specCode) - v.value) > 1e-9);
  if (!missing.length) { kept('span value', want.length); return; }
  await values.setValues(db, c, 'master', id, missing);
  made('span value', missing.length);
}

// ---------------------------------------------------------------------------
// 3. Customer and 4. order
// ---------------------------------------------------------------------------

async function ensureCustomer(db, c) {
  const [[row]] = await db.query('SELECT * FROM cf_parties WHERE company_id = ? AND code = ? AND deleted_at IS NULL', [c.companyId, CUSTOMER_CODE]);
  if (row) { kept('customer'); return row; }
  const p = await parties.createParty(db, c, {
    code: CUSTOMER_CODE,
    name: CUSTOMER_NAME,
    roles: ['customer'],
    notes: `Customer of the ROB 59.3 m job, drawing ${DRAWING}. The BOQ names the client only as "KEPL"; the expanded name here is a placeholder.`,
    status: 'active',
  });
  made('customer');
  return { id: p.id, code: p.code, name: p.name };
}

async function ensureOrder(db, c, customer, spanDef) {
  const [[row]] = await db.query(
    'SELECT id, code, status FROM cf_sales_orders WHERE company_id = ? AND customer_id = ? AND customer_reference = ? AND deleted_at IS NULL',
    [c.companyId, customer.id, DRAWING],
  );
  let orderId = row?.id ?? null;
  if (orderId) kept('sales order');
  else {
    const body = {
      orderType: 'customer',
      customerId: customer.id,
      title: ORDER_TITLE,
      customerReference: DRAWING,
      receivedOn: RECEIVED_ON,
      notes: `Two identical spans priced in one BOQ, ${DRAWING}, dated ${RECEIVED_ON}.`,
    };
    const [[scheme]] = await db.query(
      "SELECT id FROM cf_code_schemes WHERE company_id = ? AND entity_type = 'sales_order' AND target_field = 'code' AND deleted_at IS NULL LIMIT 1",
      [c.companyId],
    );
    if (!scheme) {
      body.code = FALLBACK_ORDER_CODE;
      notes.push(`No coding rule exists for sales orders, so the order number was typed in: ${FALLBACK_ORDER_CODE}.`);
    }
    const created = await orders.createOrder(db, c, body);
    orderId = created.id;
    made('sales order');
  }

  let order = await orders.getOrder(db, c.companyId, orderId);
  let line = order.lines.find((l) => l.design.id === spanDef.id);
  if (line) kept('order line');
  else {
    order = await orders.addOrderLine(db, c, orderId, {
      recordId: spanDef.id,
      quantity: ORDER_SPANS,
      description: LINE_DESCRIPTION,
      lineNo: 10,
    });
    made('order line');
    made('temporary items', (await countTemporary(db, c, orderId)));
    line = order.lines.find((l) => l.design.id === spanDef.id);
  }
  return { order, line };
}

async function countTemporary(db, c, orderId) {
  const [[r]] = await db.query(
    `SELECT COUNT(*) n FROM cf_item_details i
       JOIN cf_sales_order_lines l ON l.id = i.owner_order_line_id
      WHERE i.company_id = ? AND l.order_id = ? AND i.item_type = 'temporary' AND i.deleted_at IS NULL`,
    [c.companyId, orderId],
  );
  return Number(r.n);
}

// ---------------------------------------------------------------------------
// 5. Resolving the twenty positions
// ---------------------------------------------------------------------------

const GIRDER_ROLE = /^Girder\s+(G\d+)$/i;
const SEGMENT_ROLE = /^Segment\s+(\d+)$/i;

/** Every segment slot in the order's structure, found by ROLE and not by order. */
function slotsOf(root) {
  const slots = [];
  const lines = [];
  for (const child of root.children) {
    const m = GIRDER_ROLE.exec(child.role ?? '');
    if (!m) continue;
    lines.push({ line: m[1].toUpperCase(), node: child });
    for (const seg of child.children) {
      const s = SEGMENT_ROLE.exec(seg.role ?? '');
      if (!s) continue;
      slots.push({ line: m[1].toUpperCase(), position: Number(s[1]), node: seg });
    }
  }
  return { slots, lines };
}

async function resolveSegments(db, c, line, catalog) {
  const want = new Map();
  for (const g of LINE_LAYOUT) for (const s of g.segments) want.set(`${g.line}#${s.position}`, s);

  const tree = await boms.explode(db, c.companyId, line.item.id, { rootQuantity: 1 });
  const { slots, lines } = slotsOf(tree.root);
  say(`  the order's structure has ${lines.length} girder lines and ${slots.length} segment slots (expected ${LINE_LAYOUT.length} and ${LINE_LAYOUT.length * SEGMENTS_PER_LINE}).`);
  if (lines.length !== LINE_LAYOUT.length || slots.length !== LINE_LAYOUT.length * SEGMENTS_PER_LINE) {
    failures.push(`the exploded structure has ${lines.length} girder lines x ${slots.length} segment slots, not ${LINE_LAYOUT.length} x ${LINE_LAYOUT.length * SEGMENTS_PER_LINE}.`);
  }

  const done = [];
  for (const slot of slots.sort((a, b) => a.line.localeCompare(b.line) || a.position - b.position)) {
    const key = `${slot.line}#${slot.position}`;
    const wanted = want.get(key);
    if (!wanted) { failures.push(`slot ${key} is in the structure but not in LINE_LAYOUT.`); continue; }
    const target = catalog.segmentById.get(wanted.design);
    if (!target) { failures.push(`slot ${key} wants ${wanted.design}, which is not in the catalog.`); continue; }
    if (slot.node.id === target.id) { kept('segment resolution'); done.push({ key, mark: wanted.mark, design: wanted.design, item: target, already: true }); continue; }
    try {
      await boms.resolveLine(db, c, slot.node.lineId, { itemId: target.id });
      made('segment resolution');
      done.push({ key, mark: wanted.mark, design: wanted.design, item: target, already: false });
    } catch (e) {
      failures.push(`resolving ${key} (${wanted.mark}) to ${wanted.design}: ${why(e)}`);
    }
  }
  return done;
}

// ---------------------------------------------------------------------------
// 6. Verification — every number below is read back out of the database
// ---------------------------------------------------------------------------

/** Every node of a tree, flat. */
function flatten(node, out = []) {
  out.push(node);
  for (const k of node.children) flatten(k, out);
  return out;
}

/** The stored WEIGHT of every record in a list, straight from cf_spec_values. */
async function storedWeights(db, c, ids) {
  if (!ids.length) return new Map();
  const [rows] = await db.query(
    `SELECT v.subject_id, v.value_number, v.source FROM cf_spec_values v
       JOIN cf_specifications s ON s.id = v.specification_id AND s.deleted_at IS NULL
      WHERE v.company_id = ? AND s.code = 'WEIGHT' AND v.subject_type = 'master'
        AND v.subject_id IN (?) AND v.deleted_at IS NULL`,
    [c.companyId, ids],
  );
  return new Map(rows.map((r) => [r.subject_id, { kg: r.value_number == null ? null : Number(r.value_number), source: r.source }]));
}

async function verify(db, c, ctx) {
  say('\n================ VERIFY ================');
  const { line, catalog } = ctx;
  if (!line?.item?.id) { say('  no order line to verify.'); return; }

  // The structure of ONE span. The order line sells two; multiplying at the end
  // keeps the per-span figure comparable with the BOQ's own per-span total.
  const tree = await boms.explode(db, c.companyId, line.item.id, { rootQuantity: 1 });
  const nodes = flatten(tree.root);
  const weights = await storedWeights(db, c, [...new Set(nodes.map((n) => n.id))]);

  // --- A. weight ------------------------------------------------------------
  const leaves = nodes.filter((n) => !n.children.length);
  let bottomUp = 0;
  const unweighed = [];
  for (const n of leaves) {
    const w = weights.get(n.id);
    if (!w || w.kg == null) { unweighed.push(n); continue; }
    bottomUp += w.kg * n.total;
  }
  const rolled = weights.get(tree.root.id);
  const STATED_SPAN = 334644;
  const STATED_TOTAL_MT = 669.29;

  say('\n-- A. weight ------------------------------------------------------------');
  say(`  rolled up onto the span item (${tree.root.code ?? tree.root.name})`);
  say(`      = ${kg(rolled?.kg)} kg    [value source: ${rolled?.source ?? 'no stored weight'}]`);
  say(`  summed from the ${leaves.length} leaves of the exploded tree`);
  say(`      = ${kg(bottomUp)} kg`);
  say(`  the BOQ's own stated figure`);
  say(`      = ${kg(STATED_SPAN)} kg`);
  if (rolled?.kg != null) {
    const d = rolled.kg - STATED_SPAN;
    say(`  difference, rolled up vs the BOQ = ${d >= 0 ? '+' : ''}${kg(d)} kg  (${((d / STATED_SPAN) * 100).toFixed(6)} %)`);
    say(`  difference, rolled up vs leaves  = ${kg(rolled.kg - bottomUp)} kg`);
  }
  const orderKg = (rolled?.kg ?? bottomUp) * Number(line.quantity);
  say(`  the line sells ${line.quantity} spans, so the order weighs ${kg(orderKg)} kg = ${(orderKg / 1000).toFixed(3)} MT   (BOQ: ${STATED_TOTAL_MT} MT)`);
  if (unweighed.length) {
    say(`  ${unweighed.length} leaf record(s) carry NO stored weight and are missing from the sum:`);
    for (const n of unweighed.slice(0, 12)) say(`     ${n.code ?? n.name}  x${n.total}  (${n.role ?? 'no role'})`);
    failures.push(`${unweighed.length} leaf record(s) have no stored WEIGHT.`);
  }

  // --- B. the twenty resolutions -------------------------------------------
  say('\n-- B. the segment slots -------------------------------------------------');
  const { slots, lines } = slotsOf(tree.root);
  const want = new Map();
  for (const g of LINE_LAYOUT) for (const s of g.segments) want.set(`${g.line}#${s.position}`, s);
  let right = 0;
  say(`  girder lines found: ${lines.length}   segment slots found: ${slots.length}`);
  say(`  ${'slot'.padEnd(8)} ${'BOQ mark'.padEnd(9)} ${'design'.padEnd(8)} ${'resolved to'.padEnd(30)} ok`);
  for (const s of slots.sort((a, b) => a.line.localeCompare(b.line) || a.position - b.position)) {
    const key = `${s.line}#${s.position}`;
    const wanted = want.get(key);
    const target = wanted ? catalog.segmentById.get(wanted.design) : null;
    const ok = !!target && s.node.id === target.id && s.node.resolved;
    if (ok) right++;
    else failures.push(`slot ${key} holds ${s.node.code ?? s.node.name}, expected ${wanted?.design} (${target?.code ?? 'not in catalog'}).`);
    say(`  ${key.padEnd(8)} ${(wanted?.mark ?? '?').padEnd(9)} ${(wanted?.design ?? '?').padEnd(8)} ${String(s.node.code ?? s.node.name).slice(0, 30).padEnd(30)} ${ok ? 'yes' : 'NO'}`);
  }
  say(`  ${right} of ${LINE_LAYOUT.length * SEGMENTS_PER_LINE} positions hold the design LINE_LAYOUT names.`);

  // --- C. counts ------------------------------------------------------------
  say('\n-- C. counts, per span --------------------------------------------------');
  const totalOf = (id) => nodes.filter((n) => n.id === id).reduce((a, n) => a + n.total, 0);
  const expect = [
    ['splice sets', catalog.splice?.id, LINE_LAYOUT.length * SPLICES_PER_LINE],
    ['end diaphragms', catalog.endDia?.id, SPAN.endDiaphragms],
    ['intermediate diaphragms', catalog.intDia?.id, SPAN.interDiaphragms],
    ['shear studs', catalog.stud?.id, LINE_LAYOUT.length * STUD.perGirderLine],
  ];
  for (const [label, id, wanted] of expect) {
    const got = id ? totalOf(id) : null;
    const ok = got === wanted;
    say(`  ${label.padEnd(26)} ${String(got).padStart(6)}   expected ${String(wanted).padStart(6)}   ${ok ? 'ok' : 'MISMATCH'}`);
    if (!ok) failures.push(`${label}: the structure has ${got}, the BOQ says ${wanted}.`);
  }
  const segTotals = catalog.segments.filter((s) => s.row).map((s) => `${s.ref}=${totalOf(s.row.id)}`);
  say(`  girder segments by design  ${segTotals.join('  ')}`);

  // --- D. nothing left unresolved ------------------------------------------
  say('\n-- D. unresolved selections ---------------------------------------------');
  const [[left]] = await db.query(
    `SELECT COUNT(*) n FROM cf_bom_lines l
       JOIN cf_boms b ON b.id = l.bom_id AND b.deleted_at IS NULL
       JOIN cf_master_records p ON p.id = b.parent_id AND p.deleted_at IS NULL
       JOIN cf_item_details pi ON pi.master_id = p.id AND pi.deleted_at IS NULL
       JOIN cf_master_records ch ON ch.id = l.child_id
      WHERE l.company_id = ? AND l.deleted_at IS NULL AND l.selection_definition_id IS NOT NULL
        AND ch.record_kind = 'definition' AND pi.owner_order_line_id = ?`,
    [c.companyId, line.id],
  );
  say(`  lines under order line ${line.lineNo} still holding a selection instead of an item: ${left.n}`);
  say(`  explode() agrees: unresolved ${tree.stats.unresolved}, temporary items ${tree.stats.temporary}, nodes ${tree.stats.nodes}, depth ${tree.stats.maxDepth}`);
  if (Number(left.n)) failures.push(`${left.n} selection line(s) are still unresolved.`);

  // --- E. the shape of what was built --------------------------------------
  say('\n-- E. what is in the database -------------------------------------------');
  const [[counts]] = await db.query(
    `SELECT
       (SELECT COUNT(*) FROM cf_master_records WHERE company_id = ? AND record_kind = 'definition' AND deleted_at IS NULL) AS definitions,
       (SELECT COUNT(*) FROM cf_master_records m JOIN cf_item_details i ON i.master_id = m.id AND i.deleted_at IS NULL
         WHERE m.company_id = ? AND i.item_type = 'temporary' AND m.deleted_at IS NULL) AS temporary_items,
       (SELECT COUNT(*) FROM cf_boms WHERE company_id = ? AND deleted_at IS NULL) AS boms,
       (SELECT COUNT(*) FROM cf_bom_lines WHERE company_id = ? AND deleted_at IS NULL) AS bom_lines,
       (SELECT COUNT(*) FROM cf_parties WHERE company_id = ? AND deleted_at IS NULL) AS parties,
       (SELECT COUNT(*) FROM cf_sales_orders WHERE company_id = ? AND deleted_at IS NULL) AS orders,
       (SELECT COUNT(*) FROM cf_sales_order_lines WHERE company_id = ? AND deleted_at IS NULL) AS order_lines`,
    Array(7).fill(c.companyId),
  );
  say(`  ${JSON.stringify(counts)}`);
  for (const code of [SEL_CODE, LINE_CODE, SPAN_CODE]) {
    const d = await loadDefinition(db, c, code);
    if (!d) { say(`  ${code.padEnd(20)} MISSING`); failures.push(`${code} does not exist.`); continue; }
    const view = await boms.getBom(db, c.companyId, d.id);
    const bom = view.bom ? `${view.bom.bomType}/${view.bom.status}, ${view.lines.length} lines` : '(no BOM)';
    say(`  ${code.padEnd(20)} id ${String(d.id).padEnd(6)} ${String(d.definition_type).padEnd(9)} ${String(d.status).padEnd(7)} ${bom}`);
    if (d.definition_type === 'selection') {
      const found = await selections.findCandidates(db, c.companyId, d.id, { limit: 50 });
      say(`  ${''.padEnd(20)} mode ${found.mode}, ${found.candidates.length} candidate(s): ${found.candidates.map((x) => x.code ?? x.name).join(', ')}`);
      if (found.candidates.length !== catalog.segments.length) {
        failures.push(`${SEL_CODE} finds ${found.candidates.length} candidates, but the catalog has ${catalog.segments.length} girder-segment designs.`);
      }
    }
  }
  const [[ord]] = await db.query(
    `SELECT o.code, o.status, o.title, o.customer_reference, o.received_on, p.code AS cust, p.name AS cust_name
       FROM cf_sales_orders o LEFT JOIN cf_parties p ON p.id = o.customer_id
      WHERE o.company_id = ? AND o.id = ?`,
    [c.companyId, ctx.order.id],
  );
  say(`  order ${ord.code} [${ord.status}]  customer ${ord.cust} (${ord.cust_name})`);
  say(`        ref ${ord.customer_reference}  received ${String(ord.received_on).slice(0, 10)}  "${ord.title}"`);
  say(`  line ${line.lineNo}: ${line.lineType}, quantity ${line.quantity}, item ${line.item.code ?? line.item.name} [${line.item.kind}/${line.item.status}]`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function inTx(conn, fn) {
  await conn.beginTransaction();
  try { const out = await fn(); await conn.commit(); return out; } catch (e) { await conn.rollback(); throw e; }
}

const conn = await pool.getConnection();
try {
  const [[company]] = await conn.query('SELECT id, name FROM companies WHERE id = ?', [COMPANY]);
  if (!company) throw new Error(`No company ${COMPANY}.`);
  const [[picked]] = await conn.query('SELECT id FROM users WHERE id = ? AND deleted_at IS NULL', [WANT_USER]);
  let userId = picked?.id ?? null;
  if (!userId) {
    const [[fallback]] = await conn.query('SELECT id FROM users WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [COMPANY]);
    userId = fallback?.id ?? null;
    notes.push(`User ${WANT_USER} does not exist; acted as user ${userId} instead.`);
  }
  const c = { companyId: COMPANY, userId };
  say(`cf_erp KEPL ROB order -> company ${COMPANY} (${company.name}), acting as user ${c.userId}`);
  say(`data: ${SEGMENTS.length} girder-segment designs, ${LINE_LAYOUT.length} girder lines x ${SEGMENTS_PER_LINE} positions, ${ORDER_SPANS} spans on the order`);

  const marker = readMarker();
  if (marker === null) {
    say(`\nThe catalog marker ${path.basename(MARKER)} is not there.`);
    say('The catalog half of this job has not finished. Nothing was written. Re-run once it appears,');
    say('or pass --no-marker to look the catalog up by name instead.');
    process.exitCode = 2;
  } else {
    if (marker.size) say(`marker: ${marker.size} id(s) read from ${path.basename(MARKER)}`);
    const catalog = await findCatalog(conn, c, marker);
    if (catalog.missing.length) {
      say('\nThe catalog is incomplete — nothing was written. Missing:');
      for (const m of catalog.missing) say(`   ${m}`);
      process.exitCode = 2;
    } else {
      say('\ncatalog found:');
      for (const s of catalog.segments) say(`   ${s.ref} -> ${s.row.code ?? s.row.name}  (id ${s.row.id})`);
      for (const [label, row] of [['END-DIA', catalog.endDia], ['INT-DIA', catalog.intDia], ['SPLICE', catalog.splice], ['STUD', catalog.stud]]) {
        say(`   ${label.padEnd(6)} -> ${row.code ?? row.name}  (id ${row.id})`);
      }

      let sel; let girderLine; let spanDef; let customer; let order; let line;
      if (!VERIFY_ONLY) {
        say('\n== 1. selection ==');
        sel = await inTx(conn, () => buildSelection(conn, c, catalog));
        say('\n== 2. templates ==');
        girderLine = await inTx(conn, () => buildGirderLine(conn, c, catalog, sel));
        spanDef = await inTx(conn, () => buildSpan(conn, c, catalog, girderLine));
        say('\n== 3. customer ==');
        customer = await inTx(conn, () => ensureCustomer(conn, c));
        say('\n== 4. sales order ==');
        ({ order, line } = await inTx(conn, () => ensureOrder(conn, c, customer, spanDef)));
        say('\n== 5. resolving the segment positions ==');
        const done = await inTx(conn, () => resolveSegments(conn, c, line, catalog));
        say(`  ${done.filter((d) => !d.already).length} resolved now, ${done.filter((d) => d.already).length} already correct.`);
      } else {
        sel = await loadDefinition(conn, c, SEL_CODE);
        girderLine = await loadDefinition(conn, c, LINE_CODE);
        spanDef = await loadDefinition(conn, c, SPAN_CODE);
        if (!spanDef) throw new Error(`--verify-only: ${SPAN_CODE} does not exist yet — run the script without --verify-only first.`);
        const [[p]] = await conn.query('SELECT * FROM cf_parties WHERE company_id = ? AND code = ? AND deleted_at IS NULL', [c.companyId, CUSTOMER_CODE]);
        customer = p;
        const [[o]] = await conn.query(
          'SELECT id FROM cf_sales_orders WHERE company_id = ? AND customer_id = ? AND customer_reference = ? AND deleted_at IS NULL',
          [c.companyId, customer?.id ?? 0, DRAWING],
        );
        if (!o) throw new Error('--verify-only: there is no such order yet.');
        order = await orders.getOrder(conn, c.companyId, o.id);
        line = order.lines.find((l) => l.design.id === spanDef?.id);
      }

      // The order line is re-read so the verification works off the database,
      // not off whatever the build steps happened to return.
      order = await orders.getOrder(conn, c.companyId, order.id);
      line = order.lines.find((l) => l.design.id === spanDef.id);
      await verify(conn, c, { catalog, order, line });

      say('\n-- tally ----------------------------------------------------------------');
      say(`  created: ${JSON.stringify(tally.created)}`);
      say(`  reused : ${JSON.stringify(tally.reused)}`);
      say(`  updated: ${JSON.stringify(tally.updated)}`);
      if (!VERIFY_ONLY && !Object.keys(tally.created).length) say('  (a clean re-run: nothing new was created)');
    }
  }

  if (notes.length) {
    say('\n-- notes ----------------------------------------------------------------');
    for (const n of notes) say(`  ${n}`);
  }
  if (D.ASSUMPTIONS?.length) {
    say('\n-- assumptions carried in from the data module --------------------------');
    for (const a of D.ASSUMPTIONS) say(`  ${a}`);
  }
  if (failures.length) {
    say('\n-- PROBLEMS -------------------------------------------------------------');
    for (const f of failures) say(`  ${f}`);
    process.exitCode = 1;
  } else say('\nall checks passed.');
} finally {
  conn.release();
  await pool.end();
}
