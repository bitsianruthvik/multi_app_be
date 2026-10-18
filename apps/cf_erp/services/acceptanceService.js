/**
 * acceptanceService.js — CUSTOMER ACCEPTANCE, the sales order's confirm step (init.sql §73, TM/s73.sql; contract
 * TM/CF_ERP_ORDER_FLOW_PLAN.md "2026-10-18 — Step 3A").
 *
 * User, 2026-10-18: after the MR is raised and shared with the customer, the order's TERMS are captured and sent to
 * Management. Only Management's approval confirms the order, releases its MRs to Purchase and LOCKS the terms; changing
 * rates or terms after that is a new approval ("rate change after acceptance").
 *
 * THE TERMS (one version = one cf_order_acceptances row; terms_json):
 *   charges     one row per operation: label, the OPERATION the work passes (cf_operations), BASIS = weight ("as per
 *               drawing" or "actual") or a FORMULA of the BOM's values (SURFACE_AREA * COATS — the formula builder's
 *               language, read on every PART row of the order), a RATE per unit of that basis, and BILLING = pro_rata
 *               (as the work passes the operation, invoiced grouped weekly) or on_completion (of that operation for the
 *               whole order).
 *   material    ₹ per tonne, only when WE supply material (some line we buy).
 *   lumpSums    transport, erection … a fixed amount each.
 *   milestones  payment milestones on things the app tracks (TRIGGERS below): % or a fixed amount, pro-rata where the
 *               trigger allows it, and credit days (payment due N days after the invoice).
 *   stages      the ordered POST-PRODUCTION stages (inspection by RITES, erection at site …); a milestone may be billed
 *               on one (trigger post_stage).
 *   supply      who supplies the material, order and lines, as it stood when saved (it is edited on the step itself).
 * Every grid starts from the company's DEFAULT TEMPLATE of its kind (Setup › Templates, cf_term_templates), else from
 * a short starter.
 *
 * THE ESTIMATE (estimateTerms): per charge, the basis quantity × rate — weight = each line's WEIGHT × quantity (t);
 * a formula = Σ over the order's part rows of the formula × the row's quantity — plus the material row on the lines
 * we buy, plus the lump sums. Against it, the material we buy on the order's MRs at the last price paid: the margin
 * over material. Milestones show what each comes to.
 *
 * Billing itself (invoices from these triggers) is step 3B; it reads the approved terms and cf_order_events.
 */
import { invalid, notFound, assertNoProblems } from '../lib/errors.js';
import { parseFormula, evaluateFormula, FormulaError } from './formulaEngine.js';
import { bomsOfParents, linesOfBomsWithChildBom, childKindOf } from './bomGraph.js';
import { cutPlaces } from '../lib/cutPlaces.js';
import { measuresOf, lastPricesPaid, listPricesOf, perUnitPrice, round2 } from './priceService.js';
import { requestApproval, withdrawApprovals, pendingOf } from './approvalService.js';
import { orderValuesFor } from './orderValueService.js';

export const CHARGE_BILLING = { pro_rata: 'Pro-rata — as the work passes the operation, invoiced weekly', on_completion: 'On completion of the operation for the whole order' };
export const WEIGHT_SOURCES = { drawing: 'As per drawing', actual: 'Actual weight' };
/**
 * SCRAP & OFFCUTS (2026-10-18, user: scrap and offcut costs may be claimed from the customer). A charge whose basis is
 * the steel the order's nesting leaves over: scrap kg × rate, offcut kg × rate, or a % of the material. The kilograms
 * are ESTIMATED from the order's saved (AI / accepted) nesting — each plate's waste split by cause: offcut = the
 * offcuts kept; scrap = rim + sequence gaps + wastage (the kerf is burnt, not scrap). Billed like every other charge
 * (pro-rata through its operation, or on completion); Order costing sets the actual kg beside it.
 */
export const SCRAP_BASES = { scrap: 'Scrap kg × rate', offcut: 'Offcut kg × rate', material_pct: '% of the material' };
export const MILESTONE_KINDS = ['percent', 'amount'];
/** What a payment milestone can wait for — only things the app tracks. */
export const TRIGGERS = {
  order_accepted: { label: 'Order accepted (approved)' },
  design_frozen: { label: 'Design frozen' },
  material_in_place: { label: 'Material in place (all MR material locked or received)', proRata: true },
  customer_material_received: { label: 'Customer material received', proRata: true },
  production_started: { label: 'Production started' },
  operation_completed: { label: 'Operation completed', proRata: true, needs: ['operationId'] },
  dispatched: { label: 'Dispatched', needs: ['mode'] },
  fully_dispatched: { label: 'Fully dispatched' },
  post_stage: { label: 'Post-production stage done', needs: ['stageKey'] },
  days_after: { label: 'N days after', needs: ['days', 'after'] },
  fixed_date: { label: 'Fixed date', needs: ['date'] },
  retention: { label: 'Retention (released N months after a milestone)', needs: ['months', 'milestoneKey'] },
};
export const TRIGGER_KEYS = Object.keys(TRIGGERS);
/** What "N days after" may follow: any trigger that is an event itself. */
const AFTER_KEYS = TRIGGER_KEYS.filter((k) => !['days_after', 'fixed_date', 'retention'].includes(k));
export const DISPATCH_MODES = { each: 'Each dispatch separately (pro-rata per dispatch unit)', all: 'When everything is dispatched' };
export const TEMPLATE_KINDS = ['charges', 'milestones', 'stages'];
const OPEN_FOR_TERMS = ['draft', 'inquiry', 'quoted', 'confirmed'];
const EPS = 1e-6;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const blank = (v) => v == null || String(v).trim() === '';
const round6 = (n) => Math.round((Number(n) + Number.EPSILON) * 1e6) / 1e6;
const round3 = (n) => Math.round((Number(n) + Number.EPSILON) * 1e3) / 1e3;
const parseJson = (v) => { if (v == null) return null; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return null; } };
const text = (v, max) => (blank(v) ? '' : String(v).trim().slice(0, max));
const keyOf = (v, prefix, i) => (blank(v) ? `${prefix}${i + 1}` : String(v).trim().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || `${prefix}${i + 1}`);
const money = (n) => `₹${Number(round2(n)).toLocaleString('en-IN')}`;
const dateText = (d) => (d == null ? null : d instanceof Date ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : String(d).slice(0, 10));

// ── the starter rows, when a company has no template of a kind yet ───────────────────────────────

const STARTER = {
  charges: { charges: [{ key: 'c1', label: 'Fabrication', operationId: null, basis: { type: 'weight', weight: 'drawing' }, rate: null, billing: 'pro_rata' }], material: null, lumpSums: [] },
  milestones: {
    milestones: [
      { key: 'm1', label: 'Advance', kind: 'percent', value: 10, trigger: { type: 'order_accepted' }, proRata: false, creditDays: 0 },
      { key: 'm2', label: 'On dispatch', kind: 'percent', value: 80, trigger: { type: 'dispatched', mode: 'each' }, proRata: true, creditDays: 30 },
      { key: 'm3', label: 'Retention', kind: 'percent', value: 10, trigger: { type: 'retention', months: 12, milestoneKey: 'm2' }, proRata: false, creditDays: 0 },
    ],
  },
  stages: { stages: [{ key: 's1', name: 'Inspection by the customer' }, { key: 's2', name: 'Handover' }] },
};

// ── reading the terms ───────────────────────────────────────────────────────────────────────────

/**
 * What the terms need from the company: its operations, its number specifications (a formula reads them) and which
 * lines we supply. 2 reads.
 */
async function termContext(db, companyId) {
  const [[ops], [specs]] = await Promise.all([
    db.query("SELECT id, code, name FROM cf_operations WHERE company_id = ? AND deleted_at IS NULL ORDER BY name", [companyId]),
    db.query("SELECT code, name, data_type, default_uom FROM cf_specifications WHERE company_id = ? AND deleted_at IS NULL AND status = 'active' AND data_type = 'number' ORDER BY name", [companyId]),
  ]);
  return {
    operations: ops.map((o) => ({ id: o.id, code: o.code, name: o.name })),
    opById: new Map(ops.map((o) => [Number(o.id), o])),
    fields: specs.map((s) => ({ code: s.code, name: s.name, dataType: 'number', unit: s.default_uom ?? null })),
    specByCode: new Map(specs.map((s) => [String(s.code).toUpperCase(), s])),
  };
}

/** A formula basis checked: parses, reads only this record's number values (no children, no item./machine.). */
function checkChargeFormula(expression, specByCode) {
  if (blank(expression)) return { problem: 'Write the formula.' };
  let parsed;
  try { parsed = parseFormula(String(expression)); } catch (e) { return { problem: e instanceof FormulaError ? e.message : 'The formula does not read.' }; }
  if (parsed.usesRollup) return { problem: 'A charge formula is read on each part — leave out SUM / COUNT / children.' };
  if (parsed.usesContext) return { problem: 'A charge formula reads the part\'s own values — write SURFACE_AREA, not item.SURFACE_AREA.' };
  if (parsed.lookupRefs?.length) return { problem: 'A charge formula cannot read a chart.' };
  const unknown = parsed.references.filter((r) => !specByCode.has(r));
  if (unknown.length) return { problem: `${unknown.join(', ')} ${unknown.length === 1 ? 'is not a number specification' : 'are not number specifications'}.` };
  return { parsed };
}

function readTrigger(t, ctx, where, problems, { nested = false } = {}) {
  const type = String(t?.type ?? '');
  const meta = TRIGGERS[type];
  if (!meta || (nested && !AFTER_KEYS.includes(type))) { problems.push(`${where}: choose when it is due.`); return null; }
  const out = { type };
  if (type === 'operation_completed') {
    const op = ctx.opById.get(Number(t.operationId));
    if (!op) problems.push(`${where}: choose the operation.`); else out.operationId = Number(op.id);
  }
  if (type === 'dispatched') {
    if (!DISPATCH_MODES[t.mode]) problems.push(`${where}: say "each dispatch" or "when everything is dispatched".`); else out.mode = t.mode;
  }
  if (type === 'post_stage') {
    if (!ctx.stageKeys.has(String(t.stageKey ?? ''))) problems.push(`${where}: choose a post-production stage of this order.`); else out.stageKey = String(t.stageKey);
  }
  if (type === 'customer_material_received' && !ctx.anyCustomer) problems.push(`${where}: no line's material comes from the customer.`);
  if (type === 'days_after') {
    const d = Number(t.days);
    if (!Number.isInteger(d) || d < 1 || d > 3650) problems.push(`${where}: the number of days is a whole number from 1.`); else out.days = d;
    const after = readTrigger(t.after, ctx, `${where} (after what)`, problems, { nested: true });
    if (after) out.after = after;
  }
  if (type === 'fixed_date') {
    const s = String(t.date ?? '');
    if (!DATE_RE.test(s) || Number.isNaN(new Date(`${s}T00:00:00`).getTime())) problems.push(`${where}: give the date.`); else out.date = s;
  }
  if (type === 'retention') {
    const m = Number(t.months);
    if (!Number.isInteger(m) || m < 1 || m > 120) problems.push(`${where}: the months are a whole number from 1.`); else out.months = m;
    out.milestoneKey = String(t.milestoneKey ?? '');
  }
  return out;
}

/**
 * Checks and normalises a set of terms. ctx = termContext + { stageKeys, anyWeBuy, anyCustomer }. Every problem at
 * once, in short sentences naming the row. Pure (no reads).
 */
export function readTerms(input = {}, ctx, { requireAll = true } = {}) {
  const problems = [];
  const charges = (Array.isArray(input.charges) ? input.charges : []).map((r, i) => {
    const where = `Charge ${i + 1}${blank(r?.label) ? '' : ` (${text(r.label, 60)})`}`;
    const label = text(r?.label, 140);
    if (!label) problems.push(`${where}: give it a name.`);
    const op = ctx.opById.get(Number(r?.operationId));
    if (!op) problems.push(`${where}: choose the operation the work passes.`);
    const b = r?.basis ?? {};
    let basis = null;
    if (b.type === 'weight') {
      if (!WEIGHT_SOURCES[b.weight]) problems.push(`${where}: weight "as per drawing" or "actual".`); else basis = { type: 'weight', weight: b.weight };
    } else if (b.type === 'formula') {
      const f = checkChargeFormula(b.expression, ctx.specByCode);
      if (f.problem) problems.push(`${where}: ${f.problem}`);
      const unit = text(b.unit, 20);
      if (!unit) problems.push(`${where}: say the unit of the formula (m², nos …).`);
      basis = { type: 'formula', expression: String(b.expression ?? '').trim(), unit };
    } else if (b.type === 'scrap') {
      if (!SCRAP_BASES[b.of]) problems.push(`${where}: scrap & offcuts are charged by scrap kg, offcut kg or a % of the material.`);
      else basis = { type: 'scrap', of: b.of };
    } else problems.push(`${where}: the basis is weight, a formula or scrap & offcuts.`);
    const rate = Number(r?.rate);
    if (blank(r?.rate) || !Number.isFinite(rate) || rate < 0) problems.push(`${where}: give the ${b.type === 'scrap' && b.of === 'material_pct' ? '%' : 'rate'}.`);
    else if (b.type === 'scrap' && b.of === 'material_pct' && rate > 100) problems.push(`${where}: a % of the material is at most 100.`);
    if (!CHARGE_BILLING[r?.billing]) problems.push(`${where}: billed pro-rata or on completion.`);
    return { key: keyOf(r?.key, 'c', i), label, operationId: op ? Number(op.id) : null, basis, rate: Number.isFinite(rate) ? round6(rate) : null, billing: r?.billing ?? null };
  });
  let material = null;
  if (input.material && !blank(input.material.rate)) {
    const rate = Number(input.material.rate);
    if (!ctx.anyWeBuy) problems.push('Material: the customer supplies every line — there is no material to charge.');
    else if (!Number.isFinite(rate) || rate < 0) problems.push('Material: the rate per tonne is a number.');
    const weight = WEIGHT_SOURCES[input.material.weight] ? input.material.weight : 'drawing';
    material = { rate: Number.isFinite(rate) ? round6(rate) : null, weight };
  }
  const lumpSums = (Array.isArray(input.lumpSums) ? input.lumpSums : []).filter((r) => !(blank(r?.label) && blank(r?.amount))).map((r, i) => {
    const where = `Lump sum ${i + 1}${blank(r?.label) ? '' : ` (${text(r.label, 60)})`}`;
    const amount = Number(r?.amount);
    if (blank(r?.label)) problems.push(`${where}: give it a name.`);
    if (blank(r?.amount) || !Number.isFinite(amount) || amount <= 0) problems.push(`${where}: give the amount.`);
    return { key: keyOf(r?.key, 'l', i), label: text(r?.label, 140), amount: Number.isFinite(amount) ? round2(amount) : null };
  });
  const stages = (Array.isArray(input.stages) ? input.stages : []).filter((r) => !blank(r?.name)).map((r, i) => ({ key: keyOf(r?.key, 's', i), name: text(r.name, 140) }));
  const seenStage = new Set();
  for (const s of stages) { if (seenStage.has(s.key)) problems.push(`Post-production stages: "${s.name}" has the same key as another — remove one.`); seenStage.add(s.key); }
  const tctx = { ...ctx, stageKeys: seenStage };
  const rawMs = Array.isArray(input.milestones) ? input.milestones : [];
  const milestones = rawMs.map((r, i) => {
    const where = `Milestone ${i + 1}${blank(r?.label) ? '' : ` (${text(r.label, 60)})`}`;
    const label = text(r?.label, 140);
    if (!label) problems.push(`${where}: give it a name.`);
    const kind = MILESTONE_KINDS.includes(r?.kind) ? r.kind : null;
    if (!kind) problems.push(`${where}: a % of the order value or a fixed amount.`);
    const value = Number(r?.value);
    if (blank(r?.value) || !Number.isFinite(value) || value <= 0) problems.push(`${where}: give the ${kind === 'amount' ? 'amount' : '%'}.`);
    else if (kind === 'percent' && value > 100) problems.push(`${where}: a % is at most 100.`);
    const trigger = readTrigger(r?.trigger, tctx, where, problems);
    let proRata = !!r?.proRata;
    if (trigger?.type === 'dispatched') proRata = trigger.mode === 'each';
    else if (proRata && !TRIGGERS[trigger?.type]?.proRata) { problems.push(`${where}: pro-rata is for material, customer material, an operation or each dispatch.`); proRata = false; }
    const credit = blank(r?.creditDays) ? 0 : Number(r.creditDays);
    if (!Number.isInteger(credit) || credit < 0 || credit > 365) problems.push(`${where}: credit days are a whole number from 0 to 365.`);
    return { key: keyOf(r?.key, 'm', i), label, kind, value: Number.isFinite(value) ? round6(value) : null, trigger, proRata, creditDays: Number.isInteger(credit) ? credit : 0 };
  });
  const msKeys = new Map(milestones.map((m) => [m.key, m]));
  if (msKeys.size !== milestones.length) problems.push('Two milestones have the same key — remove one.');
  for (const [i, m] of milestones.entries()) {
    if (m.trigger?.type !== 'retention') continue;
    const target = msKeys.get(m.trigger.milestoneKey);
    if (!target || target.key === m.key) problems.push(`Milestone ${i + 1} (${m.label}): choose the milestone the retention follows.`);
    else if (target.trigger?.type === 'retention') problems.push(`Milestone ${i + 1} (${m.label}): a retention follows a milestone that is not a retention.`);
  }
  if (requireAll) {
    if (!charges.length && !material && !lumpSums.length) problems.push('Add at least one charge, the material rate or a lump sum.');
    if (!milestones.length) problems.push('Add at least one payment milestone.');
    const pct = round6(milestones.filter((m) => m.kind === 'percent').reduce((t, m) => t + (m.value ?? 0), 0));
    const fixed = milestones.some((m) => m.kind === 'amount');
    if (pct > 100 + EPS) problems.push(`The milestones add up to ${pct} % — at most 100 %.`);
    else if (!fixed && Math.abs(pct - 100) > EPS && milestones.length) problems.push(`The milestones add up to ${pct} % — make them 100 %.`);
  }
  return { terms: { charges, material, lumpSums, milestones, stages }, problems };
}

// ── the order, as the terms need it ─────────────────────────────────────────────────────────────

/** The order with its lines, their supply and weight. 2 reads. */
async function orderFacts(db, companyId, orderId, { lock = false } = {}) {
  const [[o]] = await db.query(
    `SELECT o.*, p.name AS customer_name, p.code AS customer_code FROM cf_sales_orders o LEFT JOIN cf_parties p ON p.id = o.customer_id
      WHERE o.company_id = ? AND o.id = ? AND o.deleted_at IS NULL${lock ? ' FOR UPDATE' : ''}`,
    [companyId, Number(orderId)],
  );
  if (!o) throw notFound('Sales order');
  const [lines] = await db.query(
    `SELECT l.id, l.line_no, l.line_type, l.item_id, l.quantity, l.committed_date, l.material_supply, l.delivered_qty, m.code AS item_code, m.name AS item_name
       FROM cf_sales_order_lines l LEFT JOIN cf_master_records m ON m.id = l.item_id
      WHERE l.company_id = ? AND l.order_id = ? AND l.deleted_at IS NULL ORDER BY l.line_no, l.id`,
    [companyId, o.id],
  );
  const measures = await measuresOf(db, companyId, lines.map((l) => l.item_id));
  const orderSupply = o.material_supply === 'customer' ? 'customer' : 'we_buy';
  const shaped = lines.map((l) => {
    const w = measures.get(Number(l.item_id))?.weightKg ?? null;
    return {
      id: l.id, lineNo: l.line_no, lineType: l.line_type, itemId: l.item_id, name: l.item_name ?? l.item_code ?? `Line ${l.line_no}`, code: l.item_code ?? null,
      quantity: Number(l.quantity), committedDate: dateText(l.committed_date),
      ownSupply: l.material_supply == null ? null : l.material_supply === 'customer' ? 'customer' : 'we_buy',
      supply: (l.material_supply ?? orderSupply) === 'customer' ? 'customer' : 'we_buy',
      weightKgEach: w, weightT: w == null ? null : round6((w * Number(l.quantity)) / 1000),
      delivered: Number(l.delivered_qty ?? 0),
    };
  });
  return { o, orderSupply, lines: shaped };
}

/**
 * The order's PART rows: a made (temporary) row with no made row under it — cut pieces do not count, they are what a
 * part is cut from — with its total quantity; a line sold as it is counts as its own item. Walked level by level for
 * every line at once (only made rows are walked into): 3 reads + 1 per BOM level, whatever the number of lines.
 */
async function partRows(db, companyId, lines) {
  const roots = lines.filter((l) => l.itemId);
  if (!roots.length) return [];
  const ids = [...new Set(roots.map((l) => Number(l.itemId)))];
  const [[kinds], boms, places] = await Promise.all([
    db.query('SELECT master_id, item_type FROM cf_item_details WHERE company_id = ? AND master_id IN (?) AND deleted_at IS NULL', [companyId, ids]),
    bomsOfParents(db, companyId, ids),
    cutPlaces(db, companyId),
  ]);
  const kindOf = new Map(kinds.map((k) => [Number(k.master_id), k.item_type]));
  const cutClass = new Set([...(places.plate?.blanksIds ?? []), ...(places.section?.blanksIds ?? [])].map(Number));
  const parts = [];
  const made = [];
  let frontier = [];
  for (const l of roots) {
    if (kindOf.get(Number(l.itemId)) !== 'temporary') { parts.push({ lineId: l.id, itemId: Number(l.itemId), qty: l.quantity }); continue; }
    const node = { lineId: l.id, id: Number(l.itemId), total: l.quantity, kids: [] };
    made.push(node);
    const bom = boms.get(Number(l.itemId));
    if (bom) frontier.push({ node, bomId: bom.id });
  }
  for (let depth = 1; frontier.length && depth <= 15; depth++) {
    const byBom = new Map();
    for (const f of frontier) { if (!byBom.has(f.bomId)) byBom.set(f.bomId, []); byBom.get(f.bomId).push(f.node); }
    const rows = await linesOfBomsWithChildBom(db, companyId, [...byBom.keys()]);
    const next = [];
    for (const r of rows) {
      if (childKindOf(r) !== 'temporary') continue;
      for (const parent of byBom.get(r.bom_id) ?? []) {
        const node = { lineId: parent.lineId, id: Number(r.child_id), total: Number((parent.total * Number(r.quantity)).toFixed(6)), kids: [] };
        parent.kids.push(node);
        made.push(node);
        if (r.cb_id) next.push({ node, bomId: r.cb_id });
      }
    }
    frontier = next;
  }
  if (made.length) {
    const [cls] = await db.query('SELECT id, classification_id FROM cf_master_records WHERE company_id = ? AND id IN (?)', [companyId, [...new Set(made.map((n) => n.id))]]);
    const isCut = new Set(cls.filter((r) => cutClass.has(Number(r.classification_id))).map((r) => Number(r.id)));
    for (const n of made) if (!isCut.has(n.id) && !n.kids.some((k) => !isCut.has(k.id))) parts.push({ lineId: n.lineId, itemId: n.id, qty: n.total });
  }
  return parts;
}

/**
 * What a formula basis comes to for the order: Σ over every PART row (partRows) of formula(row's values) × the row's
 * quantity. A value the row does not have is read from the line's values, then the order's (init.sql §65). Rows still
 * missing a value are counted, never guessed. Fixed reads: partRows + 2.
 */
async function formulaQuantities(db, companyId, orderId, lines, formulas) {
  const out = new Map(formulas.map((f) => [f.key, { quantity: 0, rows: 0, missingRows: 0, missing: new Set() }]));
  if (!formulas.length) return out;
  const parts = await partRows(db, companyId, lines);
  const codes = [...new Set(formulas.flatMap((f) => f.parsed.references))];
  if (!codes.length || !parts.length) {
    for (const f of formulas) { const e = out.get(f.key); const v = evaluateFormula(f.parsed, () => null); if (v.value != null) { e.quantity = round6(Number(v.value) * parts.reduce((t, p) => t + p.qty, 0)); e.rows = parts.length; } }
    return out;
  }
  const ids = [...new Set(parts.map((p) => p.itemId))];
  const [[vals], [defs]] = await Promise.all([
    db.query(
      `SELECT v.subject_id AS id, s.code, v.value_number FROM cf_spec_values v JOIN cf_specifications s ON s.id = v.specification_id AND s.deleted_at IS NULL
        WHERE v.company_id = ? AND v.subject_type = 'master' AND v.subject_id IN (?) AND v.deleted_at IS NULL AND v.value_number IS NOT NULL AND s.code IN (?)`,
      [companyId, ids, codes]),
    db.query(
      `SELECT d.order_line_id, s.code, d.value_number FROM cf_order_spec_defaults d JOIN cf_specifications s ON s.id = d.specification_id
        WHERE d.company_id = ? AND d.order_id = ? AND d.deleted_at IS NULL AND d.value_number IS NOT NULL AND s.code IN (?)`,
      [companyId, Number(orderId), codes]),
  ]);
  const own = new Map();
  for (const r of vals) own.set(`${r.id}:${r.code}`, Number(r.value_number));
  const lineVal = new Map();
  const orderVal = new Map();
  for (const r of defs) { if (r.order_line_id == null) orderVal.set(r.code, Number(r.value_number)); else lineVal.set(`${r.order_line_id}:${r.code}`, Number(r.value_number)); }
  for (const f of formulas) {
    const e = out.get(f.key);
    for (const p of parts) {
      const look = (code) => own.get(`${p.itemId}:${code}`) ?? lineVal.get(`${p.lineId}:${code}`) ?? orderVal.get(code) ?? null;
      const v = evaluateFormula(f.parsed, look);
      if (v.value == null || !Number.isFinite(Number(v.value))) { e.missingRows += 1; for (const m of v.missing ?? []) e.missing.add(m); continue; }
      e.rows += 1;
      e.quantity = round6(e.quantity + Number(v.value) * p.qty);
    }
  }
  return out;
}

/**
 * The steel the order's SAVED nesting leaves over, by kind (SCRAP_BASES above). One plate = one cf_plate_lots row of
 * the order's lines; its waste_json splits the waste by cause (mm²): offcut → offcut kg; rim + sequenceGaps + wastage
 * → scrap kg; kerf is burnt. A plate saved before the split was recorded counts its offcuts only (`unsplit`).
 * 1 read. → { plates, plateKg, partsKg, scrapKg, offcutKg, kerfKg, unsplit }
 */
export async function nestWasteOf(db, companyId, lineIds) {
  const ids = [...new Set((lineIds ?? []).map(Number).filter(Boolean))];
  const out = { plates: 0, plateKg: 0, partsKg: 0, scrapKg: 0, offcutKg: 0, kerfKg: 0, unsplit: 0 };
  if (!ids.length) return out;
  const [lots] = await db.query(
    `SELECT l.id, l.thickness_mm, l.length_mm, l.width_mm, l.density, l.waste_json,
            (SELECT COALESCE(SUM(o.weight_kg), 0) FROM cf_offcuts o WHERE o.company_id = l.company_id AND o.plate_lot_id = l.id AND o.deleted_at IS NULL) AS offcut_kg
       FROM cf_plate_lots l WHERE l.company_id = ? AND l.order_line_id IN (?) AND l.deleted_at IS NULL AND l.kind = 'plate'`,
    [companyId, ids],
  );
  for (const l of lots) {
    const t = Number(l.thickness_mm); const d = Number(l.density ?? 7850) || 7850;
    const kg = (a) => (Number(a) * t * d) / 1e9;
    const w = parseJson(l.waste_json);
    out.plates += 1;
    out.plateKg += kg(Number(l.length_mm) * Number(l.width_mm));
    if (w && w.offcut != null) {
      out.offcutKg += kg(w.offcut);
      out.scrapKg += kg(Number(w.rim ?? 0) + Number(w.sequenceGaps ?? 0) + Number(w.wastage ?? 0));
      out.kerfKg += kg(w.kerf ?? 0);
      if (w.partsArea != null) out.partsKg += kg(w.partsArea);
    } else { out.offcutKg += Number(l.offcut_kg ?? 0); out.unsplit += 1; }
  }
  for (const k of ['plateKg', 'partsKg', 'scrapKg', 'offcutKg', 'kerfKg']) out[k] = round3(out[k]);
  return out;
}

/**
 * THE ESTIMATED ORDER VALUE of a set of terms, and the margin over material. Fixed reads (formulaQuantities + the MR
 * lines + last prices + list prices + the nesting's waste when a scrap & offcuts charge asks for it).
 */
export async function estimateTerms(db, companyId, facts, terms, ctx) {
  const tonnes = round6(facts.lines.reduce((t, l) => t + (l.weightT ?? 0), 0));
  const ourTonnes = round6(facts.lines.filter((l) => l.supply === 'we_buy').reduce((t, l) => t + (l.weightT ?? 0), 0));
  const unweighed = facts.lines.filter((l) => l.weightT == null).map((l) => l.lineNo);
  const formulas = [];
  for (const ch of terms.charges) {
    if (ch.basis?.type !== 'formula') continue;
    const f = checkChargeFormula(ch.basis.expression, ctx.specByCode);
    if (f.parsed) formulas.push({ key: ch.key, parsed: f.parsed });
  }
  const wantsWaste = terms.charges.some((ch) => ch.basis?.type === 'scrap');
  const [fq, waste] = await Promise.all([
    formulaQuantities(db, companyId, facts.o.id, facts.lines, formulas),
    wantsWaste ? nestWasteOf(db, companyId, facts.lines.map((l) => l.id)) : null,
  ]);
  const material = terms.material?.rate != null ? { quantity: round3(ourTonnes), unit: 't', rate: terms.material.rate, amount: round2(ourTonnes * terms.material.rate) } : null;
  // What the material we buy on the order's MRs costs: the last price paid, else the catalog list price; an item with
  // neither is NOT COSTED and named (never a silent ₹0 — 2026-10-18, "Material we buy ₹0").
  const [mrLines] = await db.query(
    `SELECT rl.item_id, SUM(rl.quantity) AS quantity, MAX(m.code) AS code, MAX(m.name) AS name
       FROM cf_requisition_lines rl JOIN cf_requisitions r ON r.id = rl.requisition_id AND r.deleted_at IS NULL
       LEFT JOIN cf_master_records m ON m.id = rl.item_id
      WHERE rl.company_id = ? AND r.order_id = ? AND rl.deleted_at IS NULL AND COALESCE(r.supply, 'we_buy') <> 'customer' GROUP BY rl.item_id`,
    [companyId, facts.o.id],
  );
  const mrIds = mrLines.map((r) => r.item_id);
  const [prices, lists, mrMeasures] = mrLines.length
    ? await Promise.all([lastPricesPaid(db, companyId, mrIds), listPricesOf(db, companyId, mrIds), measuresOf(db, companyId, mrIds)])
    : [new Map(), new Map(), new Map()];
  const unitCostOf = (r) => {
    const paid = prices.get(Number(r.item_id))?.unitPrice;
    if (paid != null) return { unit: Number(paid), from: 'paid' };
    const l = lists.get(Number(r.item_id));
    const u = l?.listPrice == null ? null : perUnitPrice(l.listPrice, l.priceBasis, mrMeasures.get(Number(r.item_id)));
    return u == null ? null : { unit: Number(u), from: 'list' };
  };
  const costed = mrLines.map((r) => ({ r, c: unitCostOf(r) }));
  const priced = costed.filter((x) => x.c);
  const fromList = priced.filter((x) => x.c.from === 'list').length;
  const notCosted = costed.filter((x) => !x.c).map((x) => ({ itemId: Number(x.r.item_id), code: x.r.code ?? null, name: x.r.name ?? null }));
  const materialCost = mrLines.length ? round2(priced.reduce((t, x) => t + Number(x.r.quantity) * x.c.unit, 0)) : null;
  const charges = terms.charges.map((ch) => {
    let quantity = null; let unit = null; let note = null;
    if (ch.basis?.type === 'weight') {
      quantity = tonnes; unit = 't';
      note = `${WEIGHT_SOURCES[ch.basis.weight] ?? ''}${ch.basis.weight === 'actual' ? ' — estimated from the drawing weight, billed on the weight measured' : ''}${unweighed.length ? ` · line ${unweighed.join(', ')} has no weight yet` : ''}`;
    } else if (ch.basis?.type === 'formula') {
      const e = fq.get(ch.key);
      quantity = e ? round6(e.quantity) : null; unit = ch.basis.unit;
      note = e ? `${e.rows} part row${e.rows === 1 ? '' : 's'}${e.missingRows ? ` · ${e.missingRows} without ${[...e.missing].slice(0, 3).join(', ')}` : ''}` : 'The formula does not read.';
    } else if (ch.basis?.type === 'scrap') {
      if (ch.basis.of === 'material_pct') {
        // A % of the material: of the material row charged, else of what the MR material costs us.
        const base = material?.amount ?? materialCost;
        const amount = base == null || ch.rate == null ? null : round2((base * ch.rate) / 100);
        return { key: ch.key, label: ch.label, operation: ctx.opById.get(ch.operationId)?.name ?? null, basisKind: 'scrap', scrapOf: 'material_pct', quantity: base == null ? null : round2(base), unit: '₹ material', rate: ch.rate, rateUnit: '%', amount,
          note: base == null ? 'No material charged and no MR priced yet — the % has nothing to apply to.' : material ? `${ch.rate} % of the material charged` : `${ch.rate} % of the MR material at cost` };
      }
      const kg = ch.basis.of === 'offcut' ? waste?.offcutKg : waste?.scrapKg;
      quantity = waste?.plates ? kg : null; unit = 'kg';
      note = !waste?.plates ? 'No nesting saved yet — the kilograms come from the order’s nesting.'
        : `From the nesting: ${waste.plates} plate${waste.plates === 1 ? '' : 's'}, scrap ${round3(waste.scrapKg)} kg, offcuts ${round3(waste.offcutKg)} kg${waste.unsplit ? ` · ${waste.unsplit} plate${waste.unsplit === 1 ? '' : 's'} without a scrap split (offcuts only)` : ''}`;
      const amount = quantity == null || ch.rate == null ? null : round2(quantity * ch.rate);
      return { key: ch.key, label: ch.label, operation: ctx.opById.get(ch.operationId)?.name ?? null, basisKind: 'scrap', scrapOf: ch.basis.of, quantity: quantity == null ? null : round3(quantity), unit, rate: ch.rate, rateUnit: '₹/kg', amount, note };
    }
    const amount = quantity == null || ch.rate == null ? null : round2(quantity * ch.rate);
    return { key: ch.key, label: ch.label, operation: ctx.opById.get(ch.operationId)?.name ?? null, quantity: quantity == null ? null : round3(quantity), unit, rate: ch.rate, amount, note };
  });
  const lumpSums = terms.lumpSums.map((l) => ({ key: l.key, label: l.label, amount: l.amount ?? 0 }));
  const value = round2(charges.reduce((t, c) => t + (c.amount ?? 0), 0) + (material?.amount ?? 0) + lumpSums.reduce((t, l) => t + l.amount, 0));
  const milestones = terms.milestones.map((m) => ({
    key: m.key, label: m.label,
    amount: m.kind === 'percent' ? round2((value * (m.value ?? 0)) / 100) : round2(m.value ?? 0),
  }));
  const billed = round2(milestones.reduce((t, m) => t + m.amount, 0));
  return {
    tonnes: round3(tonnes), ourTonnes: round3(ourTonnes), unweighedLines: unweighed,
    charges, material, lumpSums, value,
    materialCost, materialCostNote: !mrLines.length ? 'No MR yet — the material cost is not known.'
      : notCosted.length ? `Not costed: ${notCosted.length} of ${mrLines.length} MR materials have no price paid and no list price — set the plate rate (the item's list price).`
        : fromList ? `The MR materials at the last price paid; ${fromList} at the catalog list price (nothing bought yet).` : 'The MR materials at the last price paid.',
    // Items with no cost at all — the screens show "not costed — set the plate rate" with a link to each item.
    materialNotCosted: notCosted,
    waste,
    marginOverMaterial: materialCost == null ? null : round2(value - materialCost),
    marginPct: materialCost == null || value <= 0 ? null : round2(((value - materialCost) / value) * 100),
    milestones, milestonesTotal: billed,
    milestonesNote: Math.abs(billed - value) < 0.5 ? null : `The milestones bill ${money(billed)} of ${money(value)}.`,
  };
}

// ── templates ───────────────────────────────────────────────────────────────────────────────────

const shapeTemplate = (t) => ({ id: t.id, kind: t.kind, name: t.name, isDefault: !!Number(t.is_default), rows: parseJson(t.rows_json) ?? {}, notes: t.notes ?? null, updatedAt: t.updated_at });

/** What the term grids pick from: operations, number values for a formula, the triggers and their options. */
export function termLists(ctx) {
  return {
    operations: ctx.operations, formulaFields: ctx.fields,
    triggers: TRIGGER_KEYS.map((key) => ({ key, label: TRIGGERS[key].label, proRata: !!TRIGGERS[key].proRata, needs: TRIGGERS[key].needs ?? [] })),
    afterTriggers: AFTER_KEYS, dispatchModes: DISPATCH_MODES, billing: CHARGE_BILLING, weightSources: WEIGHT_SOURCES, scrapBases: SCRAP_BASES,
  };
}

export async function listTemplates(db, companyId, q = {}) {
  const kind = TEMPLATE_KINDS.includes(q.kind) ? q.kind : null;
  const [rows] = await db.query(`SELECT * FROM cf_term_templates WHERE company_id = ? AND deleted_at IS NULL${kind ? ' AND kind = ?' : ''} ORDER BY kind, is_default DESC, name`,
    kind ? [companyId, kind] : [companyId]);
  return { rows: rows.map(shapeTemplate), kinds: TEMPLATE_KINDS, starter: STARTER, ...(q.lists ? { lists: termLists(await termContext(db, companyId)) } : {}) };
}

/** A template's rows are checked as the terms are (only the part of the terms its kind holds). */
async function readTemplate(db, companyId, kind, input) {
  const ctx = await termContext(db, companyId);
  const rows = input.rows ?? {};
  const pick = kind === 'charges' ? { charges: rows.charges ?? [], material: rows.material ?? null, lumpSums: rows.lumpSums ?? [] }
    : kind === 'milestones' ? { milestones: rows.milestones ?? [], stages: rows.stages ?? [] } : { stages: rows.stages ?? [] };
  // A milestone template may name stages by key ("post_stage") that its stages template brings; it is checked loosely.
  const loose = { ...ctx, anyWeBuy: true, anyCustomer: true };
  const { terms, problems } = readTerms(pick, loose, { requireAll: false });
  const real = kind === 'milestones'
    ? problems.filter((p) => !/choose a post-production stage/.test(p))
    : problems;
  if (kind === 'charges' && !terms.charges.length && !terms.material && !terms.lumpSums.length) real.push('Add at least one row.');
  if (kind === 'milestones' && !terms.milestones.length) real.push('Add at least one milestone.');
  if (kind === 'stages' && !terms.stages.length) real.push('Add at least one stage.');
  // A template may leave a charge's operation or rate empty: filled per order. Those two are not refused here.
  const allowed = real.filter((p) => !/choose the operation the work passes|give the rate/.test(p));
  assertNoProblems(allowed, 'The template cannot be saved.');
  if (kind === 'charges') return { charges: (rows.charges ?? []).map((r, i) => ({ ...terms.charges[i], operationId: terms.charges[i].operationId ?? null, rate: blank(r?.rate) ? null : terms.charges[i].rate })), material: terms.material, lumpSums: terms.lumpSums };
  if (kind === 'milestones') return { milestones: (rows.milestones ?? []).map((r, i) => ({ ...terms.milestones[i], trigger: terms.milestones[i].trigger ?? r?.trigger ?? null, ...(r?.trigger?.type === 'post_stage' ? { trigger: { type: 'post_stage', stageKey: String(r.trigger.stageKey ?? '') } } : {}) })) };
  return { stages: terms.stages };
}

export async function createTemplate(db, c, input = {}) {
  const kind = String(input.kind ?? '');
  if (!TEMPLATE_KINDS.includes(kind)) throw invalid('INVALID', 'A template is for charges, milestones or stages.');
  const name = text(input.name, 140);
  if (!name) throw invalid('INVALID', 'Give the template a name.');
  const rows = await readTemplate(db, c.companyId, kind, input);
  if (input.isDefault) await db.query('UPDATE cf_term_templates SET is_default = 0 WHERE company_id = ? AND kind = ? AND is_default = 1 AND deleted_at IS NULL', [c.companyId, kind]);
  const [ins] = await db.query('INSERT INTO cf_term_templates (company_id, kind, name, is_default, rows_json, notes, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [c.companyId, kind, name, input.isDefault ? 1 : 0, JSON.stringify(rows), blank(input.notes) ? null : text(input.notes, 500), c.userId ?? null, c.userId ?? null]);
  return getTemplate(db, c.companyId, ins.insertId);
}

export async function getTemplate(db, companyId, id) {
  const [[t]] = await db.query('SELECT * FROM cf_term_templates WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, Number(id)]);
  if (!t) throw notFound('Template');
  return shapeTemplate(t);
}

export async function updateTemplate(db, c, id, input = {}) {
  const t = await getTemplate(db, c.companyId, id);
  const sets = {};
  if (input.name !== undefined) { const name = text(input.name, 140); if (!name) throw invalid('INVALID', 'Give the template a name.'); sets.name = name; }
  if (input.rows !== undefined) sets.rows_json = JSON.stringify(await readTemplate(db, c.companyId, t.kind, input));
  if (input.notes !== undefined) sets.notes = blank(input.notes) ? null : text(input.notes, 500);
  if (input.isDefault !== undefined) {
    if (input.isDefault) await db.query('UPDATE cf_term_templates SET is_default = 0 WHERE company_id = ? AND kind = ? AND is_default = 1 AND id <> ? AND deleted_at IS NULL', [c.companyId, t.kind, t.id]);
    sets.is_default = input.isDefault ? 1 : 0;
  }
  sets.updated_by = c.userId ?? null;
  await db.query(`UPDATE cf_term_templates SET ${Object.keys(sets).map((k) => `${k} = ?`).join(', ')} WHERE company_id = ? AND id = ?`, [...Object.values(sets), c.companyId, t.id]);
  return getTemplate(db, c.companyId, t.id);
}

export async function deleteTemplate(db, c, id) {
  const t = await getTemplate(db, c.companyId, id);
  await db.query('UPDATE cf_term_templates SET deleted_at = NOW(), is_default = 0 WHERE company_id = ? AND id = ?', [c.companyId, t.id]);
  return { ok: true };
}

/** The rows a new acceptance starts from: each kind's default template, else the starter. 1 read. */
async function prefill(db, companyId) {
  const [rows] = await db.query('SELECT kind, rows_json FROM cf_term_templates WHERE company_id = ? AND is_default = 1 AND deleted_at IS NULL', [companyId]);
  const of = (k) => parseJson(rows.find((r) => r.kind === k)?.rows_json) ?? STARTER[k];
  const ch = of('charges'); const ms = of('milestones'); const st = of('stages');
  return { charges: ch.charges ?? [], material: ch.material ?? null, lumpSums: ch.lumpSums ?? [], milestones: ms.milestones ?? [], stages: st.stages ?? [] };
}

// ── the acceptance of an order ──────────────────────────────────────────────────────────────────

const shapeVersion = (v) => (v ? {
  id: v.id, version: Number(v.version), kind: v.kind, status: v.status,
  terms: parseJson(v.terms_json) ?? null, estimate: parseJson(v.estimate_json) ?? null, note: v.note ?? null,
  savedBy: v.saved_by ? { id: v.saved_by, name: v.saver_name ?? null } : null, savedAt: v.saved_at,
  decidedBy: v.decided_by ? { id: v.decided_by, name: v.decider_name ?? null } : null, decidedAt: v.decided_at ?? null, decisionNote: v.decision_note ?? null,
  approvalId: v.approval_id ?? null,
} : null);

async function versionsOf(db, companyId, orderId) {
  const [rows] = await db.query(
    `SELECT a.*, su.name AS saver_name, du.name AS decider_name FROM cf_order_acceptances a
       LEFT JOIN users su ON su.id = a.saved_by LEFT JOIN users du ON du.id = a.decided_by
      WHERE a.company_id = ? AND a.order_id = ? AND a.deleted_at IS NULL ORDER BY a.version DESC`,
    [companyId, Number(orderId)],
  );
  return rows.map(shapeVersion);
}

/** The approved version in force, the pending one, and the latest sent back. Pure over versionsOf. */
function standing(versions) {
  const approved = versions.find((v) => v.status === 'approved') ?? null;
  const pending = versions.find((v) => v.status === 'pending') ?? null;
  const sentBack = versions.find((v) => ['rejected', 'withdrawn'].includes(v.status) && (!approved || v.version > approved.version)) ?? null;
  return { approved, pending, sentBack };
}

/** The order's post-production stages as a checklist. 1 read. */
export async function postStagesOf(db, companyId, orderIds) {
  const ids = [...new Set((orderIds ?? []).map(Number))];
  const out = new Map(ids.map((i) => [i, []]));
  if (!ids.length) return out;
  const [rows] = await db.query(
    `SELECT s.*, u.name AS done_by_name FROM cf_order_post_stages s LEFT JOIN users u ON u.id = s.done_by
      WHERE s.company_id = ? AND s.order_id IN (?) AND s.deleted_at IS NULL ORDER BY s.order_id, s.sequence, s.id`,
    [companyId, ids],
  );
  for (const r of rows) {
    out.get(Number(r.order_id))?.push({
      id: r.id, key: r.stage_key, name: r.name, sequence: r.sequence,
      done: !!r.done_on, doneOn: dateText(r.done_on), doneNote: r.done_note ?? null,
      doneBy: r.done_by ? { id: r.done_by, name: r.done_by_name ?? null } : null, doneAt: r.done_at ?? null,
    });
  }
  return out;
}

/** What confirming the order needs (salesOrderService.setOrderStatus checks the same): said before the save. */
function confirmProblems(facts) {
  const problems = [];
  if (!facts.lines.length) problems.push('The order has no lines.');
  if (!facts.o.customer_id) problems.push('The order has no customer.');
  const undated = facts.lines.filter((l) => !l.committedDate).map((l) => l.lineNo);
  if (!facts.o.committed_date && undated.length) problems.push(`Give the order a committed date, or date line${undated.length > 1 ? 's' : ''} ${undated.join(', ')}.`);
  return problems;
}

export const MR_FIRST = 'Raise the MR in the Material request step and share it with the customer first.';
/**
 * Is the order's MR raised (shared)? Cheap (a dry run, every keystroke): any MR at all. Full (the save): every line that
 * can raise one has it — orderRequisitions' own answer (the engine read).
 */
async function mrProblems(db, companyId, o, { full }) {
  const mrs = await mrsOf(db, companyId, o.id);
  if (!mrs.length) return [MR_FIRST];
  if (!full) return [];
  const { orderRequisitions } = await import('./requisitionService.js');
  const missing = (await orderRequisitions(db, companyId, o.id)).linesWithout.filter((w) => w.canRaise).map((w) => w.line.lineNo);
  return missing.length ? [`${MR_FIRST} Line${missing.length > 1 ? 's' : ''} ${missing.join(', ')} ${missing.length > 1 ? 'have' : 'has'} no MR yet.`] : [];
}

/** The order's MRs, in short — what the step says about sharing them with the customer. 1 read. */
async function mrsOf(db, companyId, orderId) {
  const [rows] = await db.query(
    `SELECT r.id, r.code, r.supply, r.held_for_acceptance, l.line_no FROM cf_requisitions r JOIN cf_sales_order_lines l ON l.id = r.order_line_id
      WHERE r.company_id = ? AND r.order_id = ? AND r.deleted_at IS NULL ORDER BY l.line_no, r.id`,
    [companyId, Number(orderId)],
  );
  return rows.map((r) => ({ id: r.id, code: r.code, lineNo: r.line_no, supply: r.supply === 'customer' ? 'customer' : 'we_buy', held: !!Number(r.held_for_acceptance) }));
}

/**
 * GET /orders/:id/acceptance — the step: the terms to show (the pending version, else one sent back, else the approved
 * one, else the default templates), their estimate, the standing (none / pending / approved / rejected), whether it can
 * be edited and why not, the lists the grids pick from, the MRs to share, and — once approved — the post-production
 * checklist. Fixed reads.
 */
export async function getAcceptance(db, companyId, orderId) {
  const facts = await orderFacts(db, companyId, orderId);
  const [ctx, versions, mrs, stagesBy, templates, values] = await Promise.all([
    termContext(db, companyId), versionsOf(db, companyId, orderId), mrsOf(db, companyId, orderId), postStagesOf(db, companyId, [orderId]),
    listTemplates(db, companyId), orderValuesFor(db, companyId, [Number(facts.o.id)]),
  ]);
  const { approved, pending, sentBack } = standing(versions);
  const shown = pending ?? sentBack ?? approved;
  const terms = shown?.terms ?? await prefill(db, companyId);
  const anyWeBuy = facts.lines.some((l) => l.supply === 'we_buy');
  const anyCustomer = facts.lines.some((l) => l.supply === 'customer');
  const full = { ...ctx, anyWeBuy, anyCustomer, stageKeys: new Set((terms.stages ?? []).map((s) => s.key)) };
  const { terms: read } = readTerms(terms, full, { requireAll: false });
  const estimate = await estimateTerms(db, companyId, facts, read, full);
  const o = facts.o;
  const stopped = ['lost', 'cancelled', 'revised', 'closed'].includes(o.status);
  const editable = o.order_type === 'customer' && OPEN_FOR_TERMS.includes(o.status);
  const state = pending ? 'pending' : approved ? 'approved' : sentBack ? sentBack.status : 'none';
  return {
    order: {
      id: o.id, code: o.code, status: o.status, orderType: o.order_type, title: o.title ?? null,
      customer: o.customer_id ? { id: o.customer_id, code: o.customer_code ?? null, name: o.customer_name ?? null } : null,
      committedDate: dateText(o.committed_date), materialSupply: facts.orderSupply, confirmedAt: o.confirmed_at ?? null,
      lines: facts.lines,
    },
    state,
    // The approved terms are in force and LOCKED; a change is a rate change, approved again.
    locked: !!approved,
    editable,
    editReason: o.order_type !== 'customer' ? 'A stock order has no customer to accept it.' : stopped ? `${o.code} is ${o.status} — its terms do not change.` : null,
    saveMeans: !editable ? null : pending ? 'Saving replaces the terms waiting for approval.' : approved ? 'Saving sends a rate change to Management. The approved terms stay in force until it is approved.' : 'Saving sends the terms to Management. The order is confirmed when they are approved.',
    supplyEditable: editable && !approved && !mrs.some((m) => !m.held),
    terms: read,
    fromTemplates: !shown,
    estimate,
    // ONE order value (orderValueService): what the order header shows, and the estimate from the line rates beside it.
    orderValue: values.get(Number(o.id)) ?? null,
    approved, pending, sentBack,
    versions: versions.map(({ terms: _t, estimate: _e, ...v }) => v),
    confirmProblems: approved ? [] : confirmProblems(facts),
    mrs,
    mrNote: !mrs.length ? 'No MR yet. Raise it in the Material request step and share it with the customer first.'
      : mrs.some((m) => m.held) ? 'The MR is shared with the customer and held: Purchase starts once the acceptance is approved.' : 'The MR is with Purchase.',
    postStages: stagesBy.get(Number(o.id)) ?? [],
    lists: termLists(ctx),
    templates: templates.rows,
  };
}

/** JSON with its keys sorted — a JSON column hands objects back in its own key order, so plain JSON.stringify would differ. */
const stable = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : x));

/** Two sets of terms compared: the rows that changed, in words (a rate change shows them to Management). Pure. */
export function termChanges(before, after) {
  if (!before) return [];
  const out = [];
  const byKey = (rows) => new Map((rows ?? []).map((r) => [r.key, r]));
  const b = byKey(before.charges); const a = byKey(after.charges);
  for (const [k, r] of a) {
    const was = b.get(k);
    if (!was) out.push(`New charge: ${r.label} at ${r.rate}.`);
    else {
      if (Number(was.rate) !== Number(r.rate)) out.push(`${r.label}: rate ${was.rate} → ${r.rate}.`);
      if (stable(was.basis) !== stable(r.basis)) out.push(`${r.label}: basis changed.`);
      if (was.billing !== r.billing) out.push(`${r.label}: billed ${r.billing === 'pro_rata' ? 'pro-rata' : 'on completion'} now.`);
    }
  }
  for (const [k, r] of b) if (!a.has(k)) out.push(`Charge removed: ${r.label}.`);
  if (stable(before.material ?? null) !== stable(after.material ?? null)) out.push(`Material rate: ${before.material?.rate ?? 'none'} → ${after.material?.rate ?? 'none'} per t.`);
  if (stable(before.lumpSums ?? []) !== stable(after.lumpSums ?? [])) out.push('Lump sums changed.');
  if (stable(before.milestones ?? []) !== stable(after.milestones ?? [])) out.push('Payment milestones changed.');
  if (stable(before.stages ?? []) !== stable(after.stages ?? [])) out.push('Post-production stages changed.');
  return out;
}

/**
 * PUT /orders/:id/acceptance { charges, material, lumpSums, milestones, stages, note?, dryRun? } — SAVE = send to
 * Management. dryRun: the terms checked and the estimate worked out, nothing written (the step's live preview).
 * First time: an 'acceptance' version, pending (the order's confirm prerequisites are checked now, so the approval
 * cannot fail on them). While one is pending: the same version is replaced. After approval: a 'rate_change' version,
 * pending — the approved one stays in force. Refused, every problem at once.
 */
export async function saveAcceptance(db, c, orderId, input = {}) {
  const facts = await orderFacts(db, c.companyId, orderId, { lock: !input.dryRun });
  const o = facts.o;
  if (o.order_type !== 'customer') throw invalid('NOT_CUSTOMER', 'A stock order has no customer to accept it.');
  if (!OPEN_FOR_TERMS.includes(o.status)) throw invalid('NOT_OPEN', `${o.code} is ${o.status} — its terms do not change.`);
  const ctx = await termContext(db, c.companyId);
  const full = { ...ctx, anyWeBuy: facts.lines.some((l) => l.supply === 'we_buy'), anyCustomer: facts.lines.some((l) => l.supply === 'customer') };
  const { terms, problems } = readTerms(input, full);
  const versions = await versionsOf(db, c.companyId, o.id);
  const { approved, pending } = standing(versions);
  if (!approved) problems.push(...confirmProblems(facts));
  // Decided 2026-10-18: the MR is raised and SHARED with the customer before the acceptance is sent (the first one).
  if (!approved) problems.push(...await mrProblems(db, c.companyId, facts.o, { full: !input.dryRun }));
  const estimate = await estimateTerms(db, c.companyId, facts, terms, full);
  const changes = approved ? termChanges(approved.terms, terms) : [];
  if (approved && !changes.length && !input.dryRun) problems.push('Nothing changed from the approved terms.');
  if (input.dryRun) return { dryRun: true, terms, estimate, problems, changes };
  assertNoProblems(problems, approved ? 'The rate change cannot be sent yet.' : 'The acceptance cannot be sent yet.');
  terms.supply = { order: facts.orderSupply, lines: facts.lines.map((l) => ({ lineId: l.id, lineNo: l.lineNo, supply: l.supply })) };
  const kind = approved ? 'rate_change' : 'acceptance';
  const note = blank(input.note) ? null : text(input.note, 500);
  let id;
  if (pending) {
    await db.query('UPDATE cf_order_acceptances SET terms_json = ?, estimate_json = ?, note = ?, saved_by = ?, saved_at = NOW() WHERE company_id = ? AND id = ?',
      [JSON.stringify(terms), JSON.stringify(estimate), note, c.userId ?? null, c.companyId, pending.id]);
    id = pending.id;
  } else {
    const next = (versions[0]?.version ?? 0) + 1;
    const [ins] = await db.query(
      "INSERT INTO cf_order_acceptances (company_id, order_id, version, kind, status, terms_json, estimate_json, note, saved_by) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)",
      [c.companyId, o.id, next, kind, JSON.stringify(terms), JSON.stringify(estimate), note, c.userId ?? null],
    );
    id = ins.insertId;
  }
  const approvalId = await requestApproval(db, c, {
    type: pending?.kind === 'rate_change' || kind === 'rate_change' ? 'rate_change' : 'order_acceptance',
    subjectId: id, subjectCode: o.code, orderId: o.id,
    title: kind === 'rate_change' ? `Rate change on ${o.code}${facts.o.customer_name ? ` (${facts.o.customer_name})` : ''}` : `Customer acceptance of ${o.code}${facts.o.customer_name ? ` (${facts.o.customer_name})` : ''}`,
    summary: kind === 'rate_change' ? changes.slice(0, 4).join(' ') : `Estimated value ${money(estimate.value)}; ${terms.charges.length} charge${terms.charges.length === 1 ? '' : 's'}, ${terms.milestones.length} milestone${terms.milestones.length === 1 ? '' : 's'}.`,
    amount: estimate.value, note,
  });
  await db.query('UPDATE cf_order_acceptances SET approval_id = ? WHERE company_id = ? AND id = ?', [approvalId, c.companyId, id]);
  return getAcceptance(db, c.companyId, o.id);
}

/** POST /orders/:id/acceptance/withdraw — the pending terms are taken back (to change them before Management decides). */
export async function withdrawAcceptance(db, c, orderId) {
  const versions = await versionsOf(db, c.companyId, orderId);
  const { pending } = standing(versions);
  if (!pending) throw invalid('NOT_PENDING', 'Nothing is waiting for approval.');
  await db.query("UPDATE cf_order_acceptances SET status = 'withdrawn', decided_by = ?, decided_at = NOW() WHERE company_id = ? AND id = ? AND status = 'pending'", [c.userId ?? null, c.companyId, pending.id]);
  await withdrawApprovals(db, c, { subjectType: 'order_acceptance', subjectId: pending.id, note: 'Taken back to change it.' });
  return getAcceptance(db, c.companyId, orderId);
}

/** The order's post-production checklist follows its approved stages: new ones added, renamed / reordered ones follow,
 *  removed ones go unless done (what happened stays). Set-based: 1 read + ≤ 3 writes. */
async function syncPostStages(db, c, orderId, stages) {
  const [have] = await db.query('SELECT id, stage_key, done_on FROM cf_order_post_stages WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL', [c.companyId, Number(orderId)]);
  const byKey = new Map(have.map((r) => [r.stage_key, r]));
  const want = new Set(stages.map((s) => s.key));
  const fresh = stages.map((s, i) => ({ ...s, sequence: i + 1 })).filter((s) => !byKey.has(s.key));
  const keep = stages.map((s, i) => ({ ...s, sequence: i + 1 })).filter((s) => byKey.has(s.key));
  if (fresh.length) {
    await db.query(`INSERT INTO cf_order_post_stages (company_id, order_id, stage_key, name, sequence) VALUES ${fresh.map(() => '(?, ?, ?, ?, ?)').join(', ')}`,
      fresh.flatMap((s) => [c.companyId, Number(orderId), s.key, s.name, s.sequence]));
  }
  if (keep.length) {
    await db.query(
      `UPDATE cf_order_post_stages SET name = CASE id ${keep.map(() => 'WHEN ? THEN ?').join(' ')} END, sequence = CASE id ${keep.map(() => 'WHEN ? THEN ?').join(' ')} END
        WHERE company_id = ? AND id IN (?)`,
      [...keep.flatMap((s) => [byKey.get(s.key).id, s.name]), ...keep.flatMap((s) => [byKey.get(s.key).id, s.sequence]), c.companyId, keep.map((s) => byKey.get(s.key).id)],
    );
  }
  const gone = have.filter((r) => !want.has(r.stage_key) && !r.done_on).map((r) => r.id);
  if (gone.length) await db.query('UPDATE cf_order_post_stages SET deleted_at = NOW() WHERE company_id = ? AND id IN (?)', [c.companyId, gone]);
}

/** An event billing (step 3B) reads. */
export async function recordOrderEvent(db, c, { orderId, type, refType = null, refId = null, label = null, date = null, quantity = null, uom = null, note = null }) {
  await db.query(
    'INSERT INTO cf_order_events (company_id, order_id, event_type, ref_type, ref_id, label, event_date, quantity, uom, note, recorded_by) VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, CURDATE()), ?, ?, ?, ?)',
    [c.companyId, Number(orderId), type, refType, refId, label == null ? null : String(label).slice(0, 255), date, quantity, uom, note == null ? null : String(note).slice(0, 500), c.userId ?? null],
  );
}

/** The order's events, newest first (the acceptance step and 3B read them). 1 read. */
export async function orderEvents(db, companyId, orderId) {
  const [rows] = await db.query(
    `SELECT e.*, u.name AS recorded_by_name FROM cf_order_events e LEFT JOIN users u ON u.id = e.recorded_by
      WHERE e.company_id = ? AND e.order_id = ? AND e.deleted_at IS NULL ORDER BY e.event_date DESC, e.id DESC LIMIT 200`,
    [companyId, Number(orderId)],
  );
  return rows.map((e) => ({ id: e.id, type: e.event_type, ref: e.ref_type ? { type: e.ref_type, id: e.ref_id } : null, label: e.label, date: dateText(e.event_date), quantity: e.quantity == null ? null : Number(e.quantity), uom: e.uom, note: e.note, recordedBy: e.recorded_by ? { id: e.recorded_by, name: e.recorded_by_name ?? null } : null, recordedAt: e.recorded_at }));
}

async function requireVersion(db, companyId, id, { lock = false } = {}) {
  const [[v]] = await db.query(`SELECT * FROM cf_order_acceptances WHERE company_id = ? AND id = ? AND deleted_at IS NULL${lock ? ' FOR UPDATE' : ''}`, [companyId, Number(id)]);
  if (!v) throw notFound('Acceptance');
  return v;
}

/**
 * APPROVED (approvalService.decide → here, one transaction): the version is approved and the one before it superseded;
 * the first approval CONFIRMS the order (setOrderStatus viaAcceptance — which releases its held MRs to Purchase);
 * the post-production checklist follows the stages; an event is recorded (order_accepted / terms_changed).
 */
async function approveVersion(db, c, row, note) {
  const v = await requireVersion(db, c.companyId, row.subject_id, { lock: true });
  if (v.status !== 'pending') throw invalid('NOT_PENDING', 'These terms are not waiting for approval any more.');
  const terms = parseJson(v.terms_json) ?? {};
  await db.query("UPDATE cf_order_acceptances SET status = 'superseded' WHERE company_id = ? AND order_id = ? AND status = 'approved' AND id <> ?", [c.companyId, v.order_id, v.id]);
  await db.query("UPDATE cf_order_acceptances SET status = 'approved', decided_by = ?, decided_at = NOW(), decision_note = ? WHERE company_id = ? AND id = ?",
    [c.userId ?? null, note, c.companyId, v.id]);
  const [[o]] = await db.query('SELECT id, code, status FROM cf_sales_orders WHERE company_id = ? AND id = ?', [c.companyId, v.order_id]);
  let released = null;
  if (!['confirmed', 'closed'].includes(o.status)) {
    const { setOrderStatus } = await import('./salesOrderService.js');
    await setOrderStatus(db, c, o.id, 'confirmed', { viaAcceptance: true });
    released = true;
  }
  await syncPostStages(db, c, o.id, terms.stages ?? []);
  await recordOrderEvent(db, c, {
    orderId: o.id, type: v.kind === 'rate_change' ? 'terms_changed' : 'order_accepted', refType: 'acceptance', refId: v.id,
    label: v.kind === 'rate_change' ? `Rate change v${v.version} approved` : `${o.code} accepted`, note,
  });
  return { orderId: o.id, confirmed: true, mrReleased: !!released };
}

/** Context for the inbox: the terms, their estimate and — for a rate change — what changed against the approved ones. */
async function acceptanceContexts(db, companyId, rows) {
  const out = new Map();
  if (!rows.length) return out;
  const ids = rows.map((r) => Number(r.subject.id));
  const [vs] = await db.query(
    `SELECT a.*, o.code AS order_code, o.committed_date, o.status AS order_status, p.name AS customer_name
       FROM cf_order_acceptances a JOIN cf_sales_orders o ON o.id = a.order_id LEFT JOIN cf_parties p ON p.id = o.customer_id
      WHERE a.company_id = ? AND a.id IN (?)`, [companyId, ids]);
  const orderIds = [...new Set(vs.map((v) => Number(v.order_id)))];
  const [prev] = orderIds.length ? await db.query("SELECT order_id, terms_json, estimate_json, version FROM cf_order_acceptances WHERE company_id = ? AND order_id IN (?) AND status = 'approved' AND deleted_at IS NULL", [companyId, orderIds]) : [[]];
  const [ops] = await db.query('SELECT id, name FROM cf_operations WHERE company_id = ? AND deleted_at IS NULL', [companyId]);
  const opName = new Map(ops.map((o) => [Number(o.id), o.name]));
  for (const r of rows) {
    const v = vs.find((x) => Number(x.id) === Number(r.subject.id));
    if (!v) continue;
    const terms = parseJson(v.terms_json) ?? {};
    const before = prev.find((p) => Number(p.order_id) === Number(v.order_id));
    out.set(r.id, {
      kind: 'order_acceptance', version: Number(v.version), versionKind: v.kind,
      order: { id: v.order_id, code: v.order_code, customer: v.customer_name ?? null, committedDate: dateText(v.committed_date), status: v.order_status },
      terms: { ...terms, charges: (terms.charges ?? []).map((ch) => ({ ...ch, operation: opName.get(Number(ch.operationId)) ?? null })) },
      estimate: parseJson(v.estimate_json),
      approvedBefore: before ? { version: Number(before.version), estimate: parseJson(before.estimate_json) } : null,
      changes: before ? termChanges(parseJson(before.terms_json), terms) : [],
      note: v.note ?? null,
    });
  }
  return out;
}

/** approvalService handler for 'order_acceptance' and 'rate_change'. */
export const acceptanceApprovalHandler = {
  onApprove: approveVersion,
  onReject: async (db, c, row, note) => {
    await db.query("UPDATE cf_order_acceptances SET status = 'rejected', decided_by = ?, decided_at = NOW(), decision_note = ? WHERE company_id = ? AND id = ? AND status = 'pending'",
      [c.userId ?? null, note, c.companyId, row.subject_id]);
    return { rejected: true };
  },
  onWithdraw: (db, c, row) => db.query("UPDATE cf_order_acceptances SET status = 'withdrawn', decided_by = ?, decided_at = NOW() WHERE company_id = ? AND id = ? AND status = 'pending'",
    [c.userId ?? null, c.companyId, row.subject_id]),
  context: acceptanceContexts,
};

/** The acceptance's approval waiting for an order, if any (the order page links into the inbox). */
export async function pendingAcceptanceApproval(db, companyId, orderId) {
  const versions = await versionsOf(db, companyId, orderId);
  const { pending } = standing(versions);
  return pending ? pendingOf(db, companyId, 'order_acceptance', pending.id, ['order_acceptance', 'rate_change']) : null;
}

/** For processService: each order's acceptance standing. 1 read. */
export async function acceptanceStates(db, companyId, orderIds) {
  const ids = [...new Set((orderIds ?? []).map(Number))];
  const out = new Map(ids.map((i) => [i, { approved: null, pending: null, sentBack: null }]));
  if (!ids.length) return out;
  const [rows] = await db.query(
    `SELECT a.id, a.order_id, a.version, a.kind, a.status, a.decided_at, a.saved_at, a.decision_note, du.name AS decider_name
       FROM cf_order_acceptances a LEFT JOIN users du ON du.id = a.decided_by
      WHERE a.company_id = ? AND a.order_id IN (?) AND a.deleted_at IS NULL ORDER BY a.version DESC`,
    [companyId, ids],
  );
  for (const id of ids) {
    const mine = rows.filter((r) => Number(r.order_id) === id).map((r) => ({ id: r.id, version: Number(r.version), kind: r.kind, status: r.status, decidedAt: r.decided_at, savedAt: r.saved_at, decisionNote: r.decision_note, decidedBy: r.decider_name ?? null }));
    out.set(id, standing(mine));
  }
  return out;
}

/** A revision of the order carries its acceptance (every version, as it stands) and its checklist. Set-based. */
export async function copyAcceptance(db, c, fromOrderId, toOrderId) {
  await db.query(
    `INSERT INTO cf_order_acceptances (company_id, order_id, version, kind, status, terms_json, estimate_json, note, saved_by, saved_at, decided_by, decided_at, decision_note)
     SELECT company_id, ?, version, kind, IF(status = 'pending', 'withdrawn', status), terms_json, estimate_json, note, saved_by, saved_at, decided_by, decided_at, decision_note
       FROM cf_order_acceptances WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL`,
    [Number(toOrderId), c.companyId, Number(fromOrderId)],
  );
  await db.query(
    `INSERT INTO cf_order_post_stages (company_id, order_id, stage_key, name, sequence, done_on, done_note, done_by, done_at)
     SELECT company_id, ?, stage_key, name, sequence, done_on, done_note, done_by, done_at
       FROM cf_order_post_stages WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL`,
    [Number(toOrderId), c.companyId, Number(fromOrderId)],
  );
}

/** A discarded revision / deleted order takes its acceptance rows with it (soft). */
export async function retireAcceptance(db, c, orderId) {
  await db.query('UPDATE cf_order_acceptances SET deleted_at = NOW() WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL', [c.companyId, Number(orderId)]);
  await db.query('UPDATE cf_order_post_stages SET deleted_at = NOW() WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL', [c.companyId, Number(orderId)]);
  await db.query("UPDATE cf_approvals SET status = 'withdrawn', decided_at = NOW() WHERE company_id = ? AND order_id = ? AND status = 'pending' AND subject_type = 'order_acceptance'", [c.companyId, Number(orderId)]);
}

