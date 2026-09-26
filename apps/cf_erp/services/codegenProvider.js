/**
 * codegenProvider.js — how items, definitions, sales orders and machines take part in the code
 * generator. Lives with cf_erp, not in the module (the module's boundary rule):
 * this file knows what a classification, a specification and a template
 * definition are; the module only knows tokens and conditions.
 *
 * Imported once by app.js for its side effect of registering the entity types.
 */
import { registerEntity, BLANK } from '../modules/codegen/index.js';
import { ancestors, LEAF_DEPTH } from './tree.js';
import { loadMaster, kindOf } from './records.js';
import { resolve, effectiveByCode } from './resolutionService.js';
import { draftMaster, draftValueMap } from './drafts.js';
import { placementOf } from './bomGraph.js';
import { PLACED, shortNameOf, rangeOfPlacement, savedPieceSeq } from './codeRangeService.js';

/**
 * "Use the short name of the catalog item OR TEMPLATE DEFINITION" (user,
 * 2026-09-23) — the item's own short name, else its template definition's,
 * else the first word of its name. The rule lives in codeRangeService, because
 * rows share a running count (the `range` token) exactly when their codes
 * print the same short name — so there must be one copy of it.
 *
 * A short name deliberately set to NONE prints nothing: the code generator is
 * handed BLANK, which is never "missing". That is how a girder segment reads
 * …-G1-1 under the one part rule, {parent.code}-{record.shortName}{range},
 * with no rule of its own (user, 2026-09-26).
 */
const shortOf = (record, def = null) => {
  const s = shortNameOf(record, def);
  return s === '' ? BLANK : s;
};

/** `range` as a code prints it: 24 for a single piece (a number, so a 00 format pads it), "24-26" for several. */
const rangeValue = (r) => (r?.start == null ? null : r.count === 1 ? r.start : r.text);

const COMMON_TOKENS = [
  { key: 'record.shortName', label: 'Short name — its own, else its template’s, else the first word of its name; set to none, it prints nothing', available: true },
  { key: 'classification.code', label: 'Variant code', available: true },
  { key: 'classification.name', label: 'Variant name', available: true },
  { key: 'family.code', label: 'Family code', available: true },
  { key: 'subfamily.code', label: 'Subfamily code', available: true },
  { key: 'record.name', label: 'Name (for code rules)', available: true },
];
// Temporary items only. For the item a sales line sells (no BOM parent),
// parent.* falls back to the order and position to the line's position, so one
// rule — {parent.code}-{spec:ABBREV}{position} — codes a whole structure:
// P100-G01, then P100-G01-WEB01, P100-G01-FL01, P100-G01-FL02 (taxonomy §7).
const ITEM_TOKENS = [
  ...COMMON_TOKENS,
  { key: 'definition.code', label: 'Definition code (temporary items)', available: true },
  { key: 'definition.name', label: 'Definition name (temporary items)', available: true },
  { key: 'order.code', label: 'Sales order number (temporary items)', available: true },
  { key: 'line.no', label: 'Sales order line number (temporary items)', available: true },
  { key: 'parent.code', label: 'BOM parent code — the order number for the item a line sells', available: true },
  { key: 'parent.name', label: 'BOM parent name — the order title for the item a line sells', available: true },
  { key: 'position', label: 'Position among its siblings of the same design (Web 01, Web 02)', available: true },
  // User, 2026-09-26: a row of 23 plain stiffeners and its copy of 3 drilled
  // ones are IS 1-23 and IS 24-26 under their parent (codeRangeService).
  {
    key: 'range',
    label: 'Range of pieces the row covers under its parent — 24-26, or 24 for one. A copied row of the same short name carries on the count',
    available: true,
    note: 'Empty for the item a sales line sells, for a catalog item, and for a row whose quantity is not a whole number',
  },
];
const TOKEN_PATTERNS = [{ pattern: 'spec:<CODE>', label: 'A specification value, e.g. spec:GRADE' }];

const conditionTokens = (kinds) => [
  { key: 'kind', label: 'Kind', operators: ['eq', 'in'], valueKind: 'enum', values: kinds },
  { key: 'classification', label: 'Classification', operators: ['under', 'eq'], valueKind: 'classification' },
];
const ITEM_CONDITIONS = [
  ...conditionTokens(['catalog', 'temporary']),
  { key: 'definition', label: 'Created from definition', operators: ['eq', 'in'], valueKind: 'definition' },
  { key: 'placement', label: 'Where a temporary item sits', operators: ['eq'], valueKind: 'enum', values: ['line', 'component'] },
];
const DEFINITION_CONDITIONS = conditionTokens(['template', 'selection']);

function textOf(v) {
  switch (v.dataType) {
    case 'number': return v.raw;
    case 'option': return v.optionValue ?? v.display;
    case 'boolean': return v.raw ? 'Y' : 'N';
    case 'date': return String(v.raw).replaceAll('-', '');
    default: return v.raw;
  }
}

/**
 * An item's (or definition's) context from data already loaded. Both ways in
 * come through here — buildContext loads the data for one record, and
 * codeRangeService loads it for a whole BOM at once when it renumbers rows
 * (refreshRangeCodes) — so the two cannot choose a rule or print a token
 * differently.
 *
 *   data: { master, def, chain, specs, owner, place, range, asked? }
 *
 * `asked`, when given, collects every token the chosen rule reads — which is
 * how the range service tells a code that prints a range from one that does
 * not, without reading the rule's pattern itself.
 */
function itemContext({ master, def, chain, specs, owner, place, range, asked = null }) {
  const atDepth = (d) => chain.find((n) => n.depth === d) ?? null;
  const leaf = chain[chain.length - 1] ?? null;
  const kind = kindOf(master);
  const depthOf = new Map(chain.map((n) => [n.id, n.depth]));

  return {
    get(key) {
      asked?.add(key);
      if (key.startsWith('spec:')) {
        const v = specs.get(key.slice(5).toUpperCase());
        return v ? textOf(v) : null;
      }
      switch (key) {
        case 'classification.code': return leaf?.code ?? null;
        case 'classification.name': return leaf?.name ?? null;
        case 'family.code': return atDepth(0)?.code ?? null;
        case 'subfamily.code': return atDepth(1)?.code ?? null;
        case 'record.name': return master.name ?? null;
        case 'record.shortName': return shortOf(master, def);
        case 'definition.code': return def?.code ?? null;
        case 'definition.name': return def?.name ?? null;
        case 'order.code': return owner?.order_code ?? null;
        case 'line.no': return owner?.line_no ?? null;
        case 'parent.code': return place ? place.parent_code : owner?.order_code ?? null;
        case 'parent.name': return place ? place.parent_name : owner?.order_title ?? owner?.order_code ?? null;
        case 'position': return place ? place.position : owner?.position ?? null;
        case 'range': return rangeValue(range);
        default: return null;
      }
    },
    /**
     * Weights make the most specific rule win: a kind is 1; "under" a node is
     * 1 + its depth (Family 1, Subfamily 2, Variant 3); naming the exact Variant
     * or the exact definition beats any "under".
     */
    test(cond) {
      const values = cond.operator === 'in' ? cond.value.split(',').map((s) => s.trim()) : [cond.value.trim()];
      switch (cond.token_key) {
        case 'kind': return { ok: values.includes(kind), weight: 1 };
        case 'classification': {
          const id = Number(values[0]);
          if (cond.operator === 'under') return { ok: depthOf.has(id), weight: 1 + (depthOf.get(id) ?? 0) };
          return { ok: leaf?.id === id, weight: 2 + LEAF_DEPTH };
        }
        case 'definition': return { ok: !!def && values.map(Number).includes(def.id), weight: 2 + LEAF_DEPTH };
        case 'placement': {
          if (kind !== 'temporary' || !owner) return { ok: false, weight: 0 };
          return { ok: values[0] === (place ? 'component' : 'line'), weight: 1 };
        }
        default: return { ok: false, weight: 0 };
      }
    },
  };
}

async function buildContext(db, companyId, master, draftValues = null) {
  const chain = master.classification_id ? await ancestors(db, companyId, master.classification_id) : [];
  const def = master.source_definition_id ? await loadMaster(db, companyId, master.source_definition_id) : null;
  const specs = master.classification_id ? effectiveByCode(await resolve(db, companyId, { master, draftValues })) : new Map();

  // Where a temporary item sits: its owner line and order, its BOM parent, and
  // which pieces its row covers under that parent.
  let owner = null;
  let place = null;
  let range = null;
  if (kindOf(master) === 'temporary' && master.id != null && master.owner_order_line_id) {
    const [[row]] = await db.query(
      `SELECT ol.line_no, ol.position, o.code AS order_code, o.title AS order_title
         FROM cf_sales_order_lines ol JOIN cf_sales_orders o ON o.id = ol.order_id
        WHERE ol.company_id = ? AND ol.id = ?`,
      [companyId, master.owner_order_line_id],
    );
    owner = row ?? null;
    place = await placementOf(db, companyId, master.id);
    if (place) range = await rangeOfPlacement(db, companyId, master.id, place);
  }

  return itemContext({ master, def, chain, specs, owner, place, range });
}

function provider({ label, recordKind, tokens, conditions }) {
  return {
    label,
    tokens,
    tokenPatterns: TOKEN_PATTERNS,
    conditionTokens: conditions,

    async validateToken(db, companyId, key) {
      const m = /^spec:([A-Za-z][A-Za-z0-9_]*)$/.exec(key);
      if (m) {
        const [[spec]] = await db.query('SELECT status FROM cf_specifications WHERE company_id = ? AND code = ? AND deleted_at IS NULL', [companyId, m[1].toUpperCase()]);
        if (!spec) return `No specification ${m[1].toUpperCase()}.`;
        return spec.status === 'active' ? null : `Specification ${m[1].toUpperCase()} is inactive.`;
      }
      const token = tokens.find((t) => t.key === key);
      if (!token) return `"${key}" is not a value ${label.toLowerCase()} can insert.`;
      return token.available ? null : `${token.label}: ${token.note}`;
    },

    async validateCondition(db, companyId, cond) {
      const values = cond.operator === 'in' ? cond.value.split(',').map((s) => s.trim()).filter(Boolean) : [cond.value.trim()];
      const enumToken = conditions.find((t) => t.key === cond.token_key && t.valueKind === 'enum');
      if (enumToken) {
        const bad = values.filter((v) => !enumToken.values.includes(v));
        return bad.length ? `${enumToken.label} is one of ${enumToken.values.join(', ')}.` : null;
      }
      if (values.some((v) => !/^\d+$/.test(v))) return 'Choose from the list.';
      if (cond.token_key === 'classification') {
        const [[n]] = await db.query('SELECT id FROM cf_classification_nodes WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, Number(values[0])]);
        return n ? null : 'That classification node does not exist.';
      }
      if (cond.token_key === 'definition') {
        const [rows] = await db.query(
          `SELECT d.master_id FROM cf_definition_details d JOIN cf_master_records m ON m.id = d.master_id AND m.deleted_at IS NULL
            WHERE d.company_id = ? AND d.definition_type = 'template' AND d.master_id IN (?) AND d.deleted_at IS NULL`,
          [companyId, values.map(Number)],
        );
        return rows.length === values.length ? null : 'Every value must be a template definition.';
      }
      return null;
    },

    async loadContext(db, companyId, entityId) {
      const master = await loadMaster(db, companyId, entityId);
      if (!master || master.record_kind !== recordKind) {
        const err = new Error(`${label.slice(0, -1)} not found.`);
        err.status = 404;
        throw err;
      }
      return buildContext(db, companyId, master);
    },

    async draftContext(db, companyId, draft) {
      // An item codeRangeService has already loaded, with the one BOM line it
      // sits on: it renumbers a whole BOM from one load. Only code holding the
      // PLACED symbol can pass one — never a request body.
      if (recordKind === 'item' && draft?.[PLACED]) return itemContext(draft[PLACED]);
      const master = await draftMaster(db, companyId, { ...draft, recordKind });
      return buildContext(db, companyId, master, await draftValueMap(db, companyId, draft.values));
    },
  };
}

registerEntity('item', provider({ label: 'Items', recordKind: 'item', tokens: ITEM_TOKENS, conditions: ITEM_CONDITIONS }));
registerEntity('definition', provider({ label: 'Definitions', recordKind: 'definition', tokens: COMMON_TOKENS, conditions: DEFINITION_CONDITIONS }));

// ---- Sales orders ------------------------------------------------------------
// An order's number is given once, when it is created (inquiry or stock order),
// and never changes — temporary item codes are built from it. Dates and running
// numbers come from the generator's own segments.
const ORDER_TYPE_LABEL = { customer: 'C', stock: 'S' };

async function orderContext(db, companyId, { orderType, customerId }) {
  let customer = null;
  if (customerId) {
    const [[p]] = await db.query('SELECT code, name FROM cf_parties WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, Number(customerId)]);
    customer = p ?? null;
  }
  return {
    get(key) {
      switch (key) {
        case 'customer.code': return customer?.code ?? null;
        case 'order.type': return ORDER_TYPE_LABEL[orderType] ?? null;
        default: return null;
      }
    },
    test(cond) {
      if (cond.token_key !== 'type') return { ok: false, weight: 0 };
      const values = cond.operator === 'in' ? cond.value.split(',').map((s) => s.trim()) : [cond.value.trim()];
      return { ok: values.includes(orderType), weight: 1 };
    },
  };
}

const ORDER_TOKENS = [
  { key: 'customer.code', label: 'Customer code (customer orders)', available: true },
  { key: 'order.type', label: 'Order type letter — C customer, S stock', available: true },
];
const ORDER_CONDITIONS = [
  { key: 'type', label: 'Order type', operators: ['eq', 'in'], valueKind: 'enum', values: ['customer', 'stock'] },
];

registerEntity('sales_order', {
  label: 'Sales orders',
  tokens: ORDER_TOKENS,
  tokenPatterns: [],
  conditionTokens: ORDER_CONDITIONS,
  async validateToken(db, companyId, key) {
    return ORDER_TOKENS.some((t) => t.key === key) ? null : `"${key}" is not a value sales orders can insert.`;
  },
  async validateCondition(db, companyId, cond) {
    const values = cond.operator === 'in' ? cond.value.split(',').map((s) => s.trim()).filter(Boolean) : [cond.value.trim()];
    const bad = values.filter((v) => !['customer', 'stock'].includes(v));
    return bad.length ? 'Order type is customer or stock.' : null;
  },
  async loadContext(db, companyId, entityId) {
    const [[o]] = await db.query('SELECT order_type, customer_id FROM cf_sales_orders WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, entityId]);
    if (!o) { const err = new Error('Sales order not found.'); err.status = 404; throw err; }
    return orderContext(db, companyId, { orderType: o.order_type, customerId: o.customer_id });
  },
  async draftContext(db, companyId, draft) {
    return orderContext(db, companyId, { orderType: draft.orderType === 'stock' ? 'stock' : 'customer', customerId: draft.customerId ?? null });
  },
});

// ---- Machines ------------------------------------------------------------------
// A machine's number usually comes from its machine type: {classification.code}-{#00}
// makes PLS-01, PLS-02 for plasma cutters. Specification values of the machine
// (spec:MAX_THICKNESS) can go in as well.
const MACHINE_TOKENS = [
  { key: 'classification.code', label: 'Machine type code', available: true },
  { key: 'classification.name', label: 'Machine type name', available: true },
  { key: 'family.code', label: 'Family code', available: true },
  { key: 'subfamily.code', label: 'Subfamily code', available: true },
];
const MACHINE_CONDITIONS = [
  { key: 'classification', label: 'Machine type', operators: ['under', 'eq'], valueKind: 'classification' },
];

async function machineContext(db, companyId, machine, draftValues = null) {
  const chain = machine.classification_id ? await ancestors(db, companyId, machine.classification_id) : [];
  const atDepth = (d) => chain.find((n) => n.depth === d) ?? null;
  const leaf = chain[chain.length - 1] ?? null;
  const depthOf = new Map(chain.map((n) => [n.id, n.depth]));
  const specs = machine.classification_id ? effectiveByCode(await resolve(db, companyId, { machine, draftValues })) : new Map();
  return {
    get(key) {
      if (key.startsWith('spec:')) {
        const v = specs.get(key.slice(5).toUpperCase());
        return v ? textOf(v) : null;
      }
      switch (key) {
        case 'classification.code': return leaf?.code ?? null;
        case 'classification.name': return leaf?.name ?? null;
        case 'family.code': return atDepth(0)?.code ?? null;
        case 'subfamily.code': return atDepth(1)?.code ?? null;
        default: return null;
      }
    },
    test(cond) {
      if (cond.token_key !== 'classification') return { ok: false, weight: 0 };
      const id = Number(cond.value.trim());
      if (cond.operator === 'under') return { ok: depthOf.has(id), weight: 1 + (depthOf.get(id) ?? 0) };
      return { ok: leaf?.id === id, weight: 2 + LEAF_DEPTH };
    },
  };
}

registerEntity('machine', {
  label: 'Machines',
  tokens: MACHINE_TOKENS,
  tokenPatterns: TOKEN_PATTERNS,
  conditionTokens: MACHINE_CONDITIONS,
  async validateToken(db, companyId, key) {
    const m = /^spec:([A-Za-z][A-Za-z0-9_]*)$/.exec(key);
    if (m) {
      const [[spec]] = await db.query('SELECT status FROM cf_specifications WHERE company_id = ? AND code = ? AND deleted_at IS NULL', [companyId, m[1].toUpperCase()]);
      if (!spec) return `No specification ${m[1].toUpperCase()}.`;
      return spec.status === 'active' ? null : `Specification ${m[1].toUpperCase()} is inactive.`;
    }
    return MACHINE_TOKENS.some((t) => t.key === key) ? null : `"${key}" is not a value machines can insert.`;
  },
  async validateCondition(db, companyId, cond) {
    if (cond.token_key !== 'classification') return 'Machines are told apart by their machine type.';
    if (!/^\d+$/.test(cond.value.trim())) return 'Choose from the list.';
    const [[n]] = await db.query('SELECT scope FROM cf_classification_nodes WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, Number(cond.value.trim())]);
    if (!n) return 'That classification node does not exist.';
    return n.scope === 'machine' ? null : 'Choose a level of a machine family.';
  },
  async loadContext(db, companyId, entityId) {
    const [[mc]] = await db.query('SELECT * FROM cf_machines WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, entityId]);
    if (!mc) { const err = new Error('Machine not found.'); err.status = 404; throw err; }
    return machineContext(db, companyId, mc);
  },
  async draftContext(db, companyId, draft) {
    const machine = {
      id: null, code: draft.code ?? null, name: draft.name ?? null,
      classification_id: draft.classificationId != null ? Number(draft.classificationId) : null,
    };
    return machineContext(db, companyId, machine, await draftValueMap(db, companyId, draft.values));
  },
});

// ---- Batches -------------------------------------------------------------------
// A batch code usually carries its item and a running number per item —
// {item.code}-{#000} gives PL-E350-12-01-001 — or the heat it came from
// ({spec:HEAT_NO}). spec:X reads the batch's own value first, then the item's.
const BATCH_TOKENS = [
  { key: 'item.code', label: 'Item code', available: true },
  { key: 'classification.code', label: 'Item Variant code', available: true },
  { key: 'family.code', label: 'Item Family code', available: true },
  { key: 'subfamily.code', label: 'Item Subfamily code', available: true },
  { key: 'supplier.code', label: 'Supplier code', available: true },
];
const BATCH_CONDITIONS = [
  { key: 'classification', label: 'Item classification', operators: ['under', 'eq'], valueKind: 'classification' },
];

async function batchContext(db, companyId, { itemId, supplierId = null, batchValues = new Map() }) {
  const item = itemId ? await loadMaster(db, companyId, Number(itemId)) : null;
  const chain = item?.classification_id ? await ancestors(db, companyId, item.classification_id) : [];
  const atDepth = (d) => chain.find((n) => n.depth === d) ?? null;
  const leaf = chain[chain.length - 1] ?? null;
  const depthOf = new Map(chain.map((n) => [n.id, n.depth]));
  const itemSpecs = item ? effectiveByCode(await resolve(db, companyId, { master: item })) : new Map();
  let supplier = null;
  if (supplierId) {
    const [[p]] = await db.query('SELECT code FROM cf_parties WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, Number(supplierId)]);
    supplier = p ?? null;
  }
  return {
    get(key) {
      if (key.startsWith('spec:')) {
        const code = key.slice(5).toUpperCase();
        const v = batchValues.get(code) ?? itemSpecs.get(code);
        return v ? textOf(v) : null;
      }
      switch (key) {
        case 'item.code': return item?.code ?? null;
        case 'classification.code': return leaf?.code ?? null;
        case 'family.code': return atDepth(0)?.code ?? null;
        case 'subfamily.code': return atDepth(1)?.code ?? null;
        case 'supplier.code': return supplier?.code ?? null;
        default: return null;
      }
    },
    test(cond) {
      if (cond.token_key !== 'classification') return { ok: false, weight: 0 };
      const id = Number(cond.value.trim());
      if (cond.operator === 'under') return { ok: depthOf.has(id), weight: 1 + (depthOf.get(id) ?? 0) };
      return { ok: leaf?.id === id, weight: 2 + LEAF_DEPTH };
    },
  };
}

/** Batch values as the code generator reads them: code -> { raw, dataType, optionValue }. */
async function batchValueMap(db, companyId, rows) {
  const out = new Map();
  for (const r of rows) {
    const [[s]] = await db.query('SELECT code, data_type FROM cf_specifications WHERE id = ?', [r.specification_id]);
    if (!s) continue;
    let optionValue = null;
    if (r.option_id) {
      const [[o]] = await db.query('SELECT value FROM cf_spec_options WHERE id = ?', [r.option_id]);
      optionValue = o?.value ?? null;
    }
    const raw = s.data_type === 'number' ? (r.value_number == null ? null : Number(r.value_number))
      : s.data_type === 'boolean' ? (r.value_bool == null ? null : !!r.value_bool)
        : s.data_type === 'date' ? (r.value_date ? String(r.value_date instanceof Date ? r.value_date.toISOString().slice(0, 10) : r.value_date).slice(0, 10) : null)
          : s.data_type === 'option' ? r.option_id : r.value_text;
    if (raw != null) out.set(s.code.toUpperCase(), { raw, dataType: s.data_type, optionValue, display: String(raw) });
  }
  return out;
}

registerEntity('stock_batch', {
  label: 'Batches',
  tokens: BATCH_TOKENS,
  tokenPatterns: TOKEN_PATTERNS,
  conditionTokens: BATCH_CONDITIONS,
  async validateToken(db, companyId, key) {
    const m = /^spec:([A-Za-z][A-Za-z0-9_]*)$/.exec(key);
    if (m) {
      const [[spec]] = await db.query('SELECT status FROM cf_specifications WHERE company_id = ? AND code = ? AND deleted_at IS NULL', [companyId, m[1].toUpperCase()]);
      if (!spec) return `No specification ${m[1].toUpperCase()}.`;
      return spec.status === 'active' ? null : `Specification ${m[1].toUpperCase()} is inactive.`;
    }
    return BATCH_TOKENS.some((t) => t.key === key) ? null : `"${key}" is not a value batches can insert.`;
  },
  async validateCondition(db, companyId, cond) {
    if (cond.token_key !== 'classification') return 'Batches are told apart by their item’s classification.';
    const [[n]] = await db.query('SELECT scope FROM cf_classification_nodes WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, Number(cond.value.trim()) || 0]);
    if (!n) return 'That classification node does not exist.';
    return n.scope === 'machine' ? 'Choose a level of an item family.' : null;
  },
  async loadContext(db, companyId, entityId) {
    const [[b]] = await db.query('SELECT * FROM cf_stock_batches WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, entityId]);
    if (!b) { const err = new Error('Batch not found.'); err.status = 404; throw err; }
    const [rows] = await db.query("SELECT * FROM cf_spec_values WHERE company_id = ? AND subject_type = 'batch' AND subject_id = ? AND deleted_at IS NULL", [companyId, b.id]);
    return batchContext(db, companyId, { itemId: b.item_id, supplierId: b.supplier_id, batchValues: await batchValueMap(db, companyId, rows) });
  },
  async draftContext(db, companyId, draft) {
    const typed = await draftValueMap(db, companyId, draft.values);
    const rows = [...typed.entries()].map(([specId, v]) => ({ ...v, specification_id: specId }));
    return batchContext(db, companyId, { itemId: draft.itemId, supplierId: draft.supplierId, batchValues: await batchValueMap(db, companyId, rows) });
  },
});

// ---- Stock movements -------------------------------------------------------------
// Document numbers: a rule per movement type ("GRN-{date}-{#0000}" for receipts)
// or one for all using {type.code}. Without a rule a movement is numbered
// GRN-000123 from its id.
const TYPE_CODE = { receipt: 'GRN', issue: 'ISS', transfer: 'TRF', adjustment: 'ADJ', scrap: 'SCR' };
const MOVEMENT_TOKENS = [
  { key: 'type.code', label: 'Type letters — GRN, ISS, TRF, ADJ, SCR', available: true },
  { key: 'area.code', label: 'Stocking area code (the first line’s)', available: true },
];
const MOVEMENT_CONDITIONS = [
  { key: 'type', label: 'Movement type', operators: ['eq', 'in'], valueKind: 'enum', values: Object.keys(TYPE_CODE) },
];

async function movementContext(db, companyId, { movementType, areaId }) {
  let area = null;
  if (areaId) {
    const [[a]] = await db.query('SELECT code FROM cf_stocking_areas WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, Number(areaId)]);
    area = a ?? null;
  }
  return {
    get(key) {
      if (key === 'type.code') return TYPE_CODE[movementType] ?? null;
      if (key === 'area.code') return area?.code ?? null;
      return null;
    },
    test(cond) {
      if (cond.token_key !== 'type') return { ok: false, weight: 0 };
      const values = cond.operator === 'in' ? cond.value.split(',').map((s) => s.trim()) : [cond.value.trim()];
      return { ok: values.includes(movementType), weight: 1 };
    },
  };
}

registerEntity('stock_movement', {
  label: 'Stock movements',
  tokens: MOVEMENT_TOKENS,
  tokenPatterns: [],
  conditionTokens: MOVEMENT_CONDITIONS,
  async validateToken(db, companyId, key) {
    return MOVEMENT_TOKENS.some((t) => t.key === key) ? null : `"${key}" is not a value stock movements can insert.`;
  },
  async validateCondition(db, companyId, cond) {
    const values = cond.operator === 'in' ? cond.value.split(',').map((s) => s.trim()).filter(Boolean) : [cond.value.trim()];
    return values.every((v) => TYPE_CODE[v]) ? null : `Movement type is one of ${Object.keys(TYPE_CODE).join(', ')}.`;
  },
  async loadContext(db, companyId, entityId) {
    const [[m]] = await db.query('SELECT movement_type FROM cf_stock_movements WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, entityId]);
    if (!m) { const err = new Error('Movement not found.'); err.status = 404; throw err; }
    const [[l]] = await db.query('SELECT stocking_area_id FROM cf_stock_ledger WHERE company_id = ? AND movement_id = ? ORDER BY line_no, id LIMIT 1', [companyId, entityId]);
    return movementContext(db, companyId, { movementType: m.movement_type, areaId: l?.stocking_area_id ?? null });
  },
  async draftContext(db, companyId, draft) {
    return movementContext(db, companyId, { movementType: draft.movementType, areaId: draft.areaId ?? null });
  },
});

// ---- Purchase orders -----------------------------------------------------------
// A buying number, usually {supplier.code}-{YY}{MM}-{000} or plain PO-{0000}.
// A suggested order has no supplier yet, so a rule that leans on one leaves a
// gap — which is why `suggested` is offered as a condition.
const PURCHASE_TOKENS = [
  { key: 'supplier.code', label: 'Supplier code', available: true },
  { key: 'supplier.name', label: 'Supplier name', available: true },
];
const PURCHASE_CONDITIONS = [
  { key: 'suggested', label: 'Raised by the buy list', operators: ['eq'], valueKind: 'enum', values: ['yes', 'no'] },
];

async function purchaseContext(db, companyId, { supplierId, suggested }) {
  let supplier = null;
  if (supplierId) {
    const [[s]] = await db.query('SELECT code, name FROM cf_parties WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, Number(supplierId)]);
    supplier = s ?? null;
  }
  return {
    get(key) {
      if (key === 'supplier.code') return supplier?.code ?? null;
      if (key === 'supplier.name') return supplier?.name ?? null;
      return null;
    },
    test(cond) {
      if (cond.token_key !== 'suggested') return { ok: false, weight: 0 };
      return { ok: (cond.value.trim() === 'yes') === !!suggested, weight: 1 };
    },
  };
}

registerEntity('purchase_order', {
  label: 'Purchase orders',
  tokens: PURCHASE_TOKENS,
  tokenPatterns: [],
  conditionTokens: PURCHASE_CONDITIONS,
  async validateToken(db, companyId, key) {
    return PURCHASE_TOKENS.some((t) => t.key === key) ? null : `"${key}" is not a value purchase orders can insert.`;
  },
  async validateCondition(db, companyId, cond) {
    return ['yes', 'no'].includes(cond.value.trim()) ? null : 'Raised by the buy list is yes or no.';
  },
  async loadContext(db, companyId, entityId) {
    const [[p]] = await db.query('SELECT supplier_id, suggested FROM cf_purchase_orders WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, entityId]);
    if (!p) { const err = new Error('Purchase order not found.'); err.status = 404; throw err; }
    return purchaseContext(db, companyId, { supplierId: p.supplier_id, suggested: !!p.suggested });
  },
  async draftContext(db, companyId, draft) {
    return purchaseContext(db, companyId, { supplierId: draft.supplierId ?? null, suggested: !!draft.suggested });
  },
});

// ---- Production pieces and stock lots -------------------------------------------
// "Stock and WIP should all get a code to identify at every level, driven through
// the code generator… for now use the short name of the catalog item or template
// definition" (user, 2026-09-23). Every tracker node is a WIP thing and takes a
// code; every lot production puts on the shelf takes one too.
//
// The short name falls back so codes work before anybody fills the field in: the
// item's own, else the template definition it came from, else the first word of
// its name. A code nobody can read is still better than no code at all.

const PIECE_TOKENS = [
  { key: 'item.shortName', label: 'Item short name — its own, else its definition’s, else its first word; set to none, it prints nothing', available: true },
  { key: 'item.code', label: 'Item code', available: true },
  { key: 'definition.shortName', label: 'Template definition short name', available: true },
  { key: 'order.code', label: 'Sales order number', available: true },
  { key: 'line.no', label: 'Sales order line number', available: true },
  { key: 'parent.code', label: 'The piece this one is part of', available: true },
  { key: 'piece.no', label: 'Piece number among its own kind (blank for a grouped node)', available: true },
  // User, 2026-09-26: under each parent piece a row's pieces take that row's
  // range, so the three pieces of a drilled copy after 23 plain ones are 24, 25, 26.
  { key: 'piece.seq', label: 'Piece number under its parent piece — carries on across copied rows of the same short name (24, 25, 26); a grouped card shows its range (1-4)', available: true },
];
// Where a piece sits and what its item is, so rules can tell apart the top of a
// released tree (what the order line sells: {item.code}-{piece.seq}) from a piece
// inside another ({parent.code}-{item.shortName}{piece.seq}), and a kind whose
// item code prints no short name (a girder segment: {parent.code}-{piece.seq}).
// Same words and weights as the item conditions: placement 1; classification
// "under" 1 + depth; the exact Variant beats any "under".
const PIECE_CONDITIONS = [
  { key: 'kind', label: 'Kind', operators: ['eq', 'in'], valueKind: 'enum', values: ['catalog', 'temporary'] },
  { key: 'placement', label: 'Where the piece sits — line (what the order line sells) or component (inside another piece)', operators: ['eq'], valueKind: 'enum', values: ['line', 'component'] },
  { key: 'classification', label: 'Classification of its item', operators: ['under', 'eq'], valueKind: 'classification' },
];

/**
 * draft: { itemId, orderId, lineNo, parentCode, pieceNo, pieceSeq, memo? }.
 * A piece with no parentCode is the top of its tree. `memo`, a Map, is how a
 * release codes thousands of pieces without reading the same item, template,
 * order and classification chain once per piece: one release, one memo. (A
 * request body cannot carry a Map, so only code passes one.)
 */
async function pieceContext(db, companyId, draft) {
  const memo = draft.memo instanceof Map ? draft.memo : null;
  const once = (key, load) => {
    if (!memo) return load();
    if (!memo.has(key)) memo.set(key, load());
    return memo.get(key);
  };
  const item = draft.itemId ? await once(`master:${draft.itemId}`, () => loadMaster(db, companyId, Number(draft.itemId))) : null;
  const def = item?.source_definition_id ? await once(`master:${item.source_definition_id}`, () => loadMaster(db, companyId, item.source_definition_id)) : null;
  const order = draft.orderId ? await once(`order:${draft.orderId}`, async () => {
    const [[o]] = await db.query('SELECT code FROM cf_sales_orders WHERE company_id = ? AND id = ?', [companyId, Number(draft.orderId)]);
    return o ?? null;
  }) : null;
  const chain = item?.classification_id ? await once(`chain:${item.classification_id}`, () => ancestors(db, companyId, item.classification_id)) : [];
  const leaf = chain[chain.length - 1] ?? null;
  const depthOf = new Map(chain.map((n) => [n.id, n.depth]));
  const kind = item ? kindOf(item) : null;
  const placement = draft.parentCode != null && draft.parentCode !== '' ? 'component' : 'line';
  return {
    get(key) {
      switch (key) {
        case 'item.shortName': return shortOf(item, def);
        case 'item.code': return item?.code ?? null;
        case 'definition.shortName': return shortOf(def);
        case 'order.code': return order?.code ?? null;
        case 'line.no': return draft.lineNo ?? null;
        case 'parent.code': return draft.parentCode ?? null;
        case 'piece.no': return draft.pieceNo ?? null;
        case 'piece.seq': return draft.pieceSeq ?? null;
        default: return null;
      }
    },
    test(cond) {
      const values = cond.operator === 'in' ? cond.value.split(',').map((s) => s.trim()) : [cond.value.trim()];
      switch (cond.token_key) {
        case 'kind': return { ok: values.includes(kind), weight: 1 };
        case 'placement': return { ok: values[0] === placement, weight: 1 };
        case 'classification': {
          const id = Number(values[0]);
          if (cond.operator === 'under') return { ok: depthOf.has(id), weight: 1 + (depthOf.get(id) ?? 0) };
          return { ok: leaf?.id === id, weight: 2 + LEAF_DEPTH };
        }
        default: return { ok: false, weight: 0 };
      }
    },
  };
}

registerEntity('production_piece', {
  label: 'Production pieces (WIP)',
  tokens: PIECE_TOKENS,
  tokenPatterns: [],
  conditionTokens: PIECE_CONDITIONS,
  async validateToken(db, companyId, key) {
    return PIECE_TOKENS.some((t) => t.key === key) ? null : `"${key}" is not a value production pieces can insert.`;
  },
  async validateCondition(db, companyId, cond) {
    const values = cond.operator === 'in' ? cond.value.split(',').map((s) => s.trim()).filter(Boolean) : [cond.value.trim()];
    if (cond.token_key === 'kind') return values.every((v) => ['catalog', 'temporary'].includes(v)) ? null : 'Kind is catalog or temporary.';
    if (cond.token_key === 'placement') return values.every((v) => ['line', 'component'].includes(v)) ? null : 'A piece sits on the line (what the order line sells) or inside another piece: line or component.';
    if (cond.token_key === 'classification') {
      if (values.some((v) => !/^\d+$/.test(v))) return 'Choose from the list.';
      const [[n]] = await db.query('SELECT scope FROM cf_classification_nodes WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, Number(values[0])]);
      if (!n) return 'That classification node does not exist.';
      return n.scope === 'machine' ? 'Choose a level of an item family.' : null;
    }
    return 'Production pieces are told apart by kind, placement and classification.';
  },
  async loadContext(db, companyId, entityId) {
    const [[p]] = await db.query(
      `SELECT pi.item_id, pi.piece_no, pi.release_id, pi.parent_id, pi.bom_line_id, pi.quantity, pi.sort_order,
              r.order_id, l.line_no, parent.code AS parent_code
         FROM cf_production_items pi
         JOIN cf_production_releases r ON r.id = pi.release_id
         JOIN cf_sales_order_lines l ON l.id = r.order_line_id
         LEFT JOIN cf_production_items parent ON parent.id = pi.parent_id
        WHERE pi.company_id = ? AND pi.id = ? AND pi.deleted_at IS NULL`,
      [companyId, entityId],
    );
    if (!p) { const err = new Error('Production piece not found.'); err.status = 404; throw err; }
    return pieceContext(db, companyId, {
      itemId: p.item_id, orderId: p.order_id, lineNo: p.line_no, parentCode: p.parent_code, pieceNo: p.piece_no,
      pieceSeq: await savedPieceSeq(db, companyId, p),
    });
  },
  async draftContext(db, companyId, draft) {
    return pieceContext(db, companyId, draft ?? {});
  },
});

// A lot of stock: what production put on the shelf, or what a delivery brought in.
const LOT_TOKENS = [
  { key: 'item.shortName', label: 'Item short name — its own, else its definition’s, else its first word; set to none, it prints nothing', available: true },
  { key: 'item.code', label: 'Item code', available: true },
  { key: 'order.code', label: 'The order it was made on', available: true },
  { key: 'piece.code', label: 'The production piece it came from', available: true },
];
const LOT_CONDITIONS = [
  { key: 'source', label: 'Where the lot came from', operators: ['eq'], valueKind: 'enum', values: ['production', 'purchase'] },
];

async function lotContext(db, companyId, draft) {
  const item = draft.itemId ? await loadMaster(db, companyId, Number(draft.itemId)) : null;
  const def = item?.source_definition_id ? await loadMaster(db, companyId, item.source_definition_id) : null;
  const source = draft.source === 'purchase' ? 'purchase' : 'production';
  return {
    get(key) {
      switch (key) {
        case 'item.shortName': return shortOf(item, def);
        case 'item.code': return item?.code ?? null;
        case 'order.code': return draft.orderCode ?? null;
        case 'piece.code': return draft.pieceCode ?? null;
        default: return null;
      }
    },
    test(cond) {
      if (cond.token_key !== 'source') return { ok: false, weight: 0 };
      return { ok: cond.value.trim() === source, weight: 1 };
    },
  };
}

registerEntity('stock_lot', {
  label: 'Stock lots from production',
  tokens: LOT_TOKENS,
  tokenPatterns: [],
  conditionTokens: LOT_CONDITIONS,
  async validateToken(db, companyId, key) {
    return LOT_TOKENS.some((t) => t.key === key) ? null : `"${key}" is not a value stock lots can insert.`;
  },
  async validateCondition(db, companyId, cond) {
    return ['production', 'purchase'].includes(cond.value.trim()) ? null : 'The source is production or purchase.';
  },
  async loadContext(db, companyId, entityId) {
    const [[b]] = await db.query(
      `SELECT b.item_id, pi.code AS piece_code, o.code AS order_code
         FROM cf_stock_batches b
         LEFT JOIN cf_production_items pi ON pi.id = b.production_item_id
         LEFT JOIN cf_production_releases r ON r.id = pi.release_id
         LEFT JOIN cf_sales_orders o ON o.id = r.order_id
        WHERE b.company_id = ? AND b.id = ? AND b.deleted_at IS NULL`,
      [companyId, entityId],
    );
    if (!b) { const err = new Error('Stock lot not found.'); err.status = 404; throw err; }
    return lotContext(db, companyId, { itemId: b.item_id, pieceCode: b.piece_code, orderCode: b.order_code, source: b.piece_code ? 'production' : 'purchase' });
  },
  async draftContext(db, companyId, draft) {
    return lotContext(db, companyId, draft ?? {});
  },
});


// ---- Drawings ------------------------------------------------------------------
// A drawing is not a master record (cf_master_records.record_kind is
// ENUM('item','definition') and ~77 places read the else branch as "definition"),
// but it takes part in the generator exactly like machines, sales orders and
// stock lots do — none of which is a master record either.
//
// The number a person reads on the sheet is the ISSUER's (`drawing.number`,
// which for the KEPL job is P103-VDB-WK-DD-MJB-200+003-401). The code the
// generator makes is OURS. `root.code` is the code of the drawing's first
// revision, so a rule can tie the revisions of one drawing together —
// {root.code}/{drawing.revision} gives SHP-0001/A, SHP-0001/B — while
// {source.code}-{#0000} gives each row an independent number.
const DRAWING_SOURCES = ['customer', 'shop'];
const DRAWING_SOURCE_LABEL = { customer: 'CUS', shop: 'SHP' };

const DRAWING_TOKENS = [
  { key: 'drawing.number', label: "The issuer's drawing number, as written", available: true },
  { key: 'drawing.revision', label: 'Revision of this sheet', available: true },
  { key: 'drawing.title', label: 'Drawing title', available: true },
  { key: 'source.code', label: 'Whose numbering — CUS customer, SHP shop', available: true },
  { key: 'root.code', label: 'Code of this drawing\'s first revision (empty on that first one)', available: true },
];
const DRAWING_CONDITIONS = [
  { key: 'source', label: 'Where the drawing comes from', operators: ['eq', 'in'], valueKind: 'enum', values: ['customer', 'shop'] },
];

async function drawingContext(db, companyId, { number, revision, title, source, rootId, selfId }) {
  let rootCode = null;
  if (rootId && rootId !== selfId) {
    const [[r]] = await db.query('SELECT code FROM cf_drawings WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, Number(rootId)]);
    rootCode = r?.code ?? null;
  }
  const from = DRAWING_SOURCES.includes(source) ? source : 'shop';
  return {
    get(key) {
      switch (key) {
        case 'drawing.number': return number ?? null;
        case 'drawing.revision': return revision ?? null;
        case 'drawing.title': return title ?? null;
        case 'source.code': return DRAWING_SOURCE_LABEL[from] ?? null;
        case 'root.code': return rootCode;
        default: return null;
      }
    },
    test(cond) {
      if (cond.token_key !== 'source') return { ok: false, weight: 0 };
      const values = cond.operator === 'in' ? cond.value.split(',').map((s) => s.trim()) : [cond.value.trim()];
      return { ok: values.includes(from), weight: 1 };
    },
  };
}

registerEntity('drawing', {
  label: 'Drawings',
  tokens: DRAWING_TOKENS,
  tokenPatterns: [],
  conditionTokens: DRAWING_CONDITIONS,
  async validateToken(db, companyId, key) {
    return DRAWING_TOKENS.some((t) => t.key === key) ? null : `"${key}" is not a value drawings can insert.`;
  },
  async validateCondition(db, companyId, cond) {
    if (cond.token_key !== 'source') return 'Drawings are told apart by where they come from.';
    const values = cond.operator === 'in' ? cond.value.split(',').map((s) => s.trim()).filter(Boolean) : [cond.value.trim()];
    const bad = values.filter((v) => !DRAWING_SOURCES.includes(v));
    return bad.length ? 'A drawing comes from the customer or from the shop.' : null;
  },
  async loadContext(db, companyId, entityId) {
    const [[d]] = await db.query(
      'SELECT id, number, revision, title, source, root_id FROM cf_drawings WHERE company_id = ? AND id = ? AND deleted_at IS NULL',
      [companyId, entityId],
    );
    if (!d) { const err = new Error('Drawing not found.'); err.status = 404; throw err; }
    return drawingContext(db, companyId, { number: d.number, revision: d.revision, title: d.title, source: d.source, rootId: d.root_id, selfId: d.id });
  },
  async draftContext(db, companyId, draft) {
    return drawingContext(db, companyId, {
      number: draft.number ?? null, revision: draft.revision ?? 'A', title: draft.title ?? null,
      source: draft.source ?? 'shop', rootId: draft.rootId ?? null, selfId: null,
    });
  },
});
