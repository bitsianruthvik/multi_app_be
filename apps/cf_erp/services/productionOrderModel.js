/**
 * productionOrderModel.js — the PRODUCTION ORDERS an order's execution plan asks for, and which production order
 * each piece of a released line belongs to (init.sql §76). PURE: no database. productionOrderService reads and
 * writes; this file only works things out, so the test can drive it directly.
 *
 * A production order is named by its SCOPE KEY, unique within the order:
 *   O                                   every line on the 'order' level, together
 *   L<line>                             one line
 *   L<line>U<u>                         unit u of a line (each span of a line of 3)
 *   L<line>U<u>A<level>:<path>#<n>      the n-th sub-assembly of that BOM level with that BOM path in unit u
 *   L<line>U<u>R                        the rest of unit u and its final assembly
 *   L<line>G<k>                         the k-th BATCH of the line (§97): several units or sub-assemblies in one
 *                                       production order; its members (cf_production_orders.members_json) are the
 *                                       scope keys those pieces would have on their own
 * <path> is the chain of BOM line ids from the unit down to the sub-assembly's row — the same on the BOM tree (when
 * the orders are made) and on the tracker (when its pieces are stamped), so the two always meet.
 *
 * States (user, 2026-10-18): Yet to plan → Planned → In production → Dispatch → Closed. Stored: yet_to_plan,
 * planned (released), closed (dispatched). In production / Dispatch are worked out from its steps (stateOf).
 */

export const PO_STATES = ['yet_to_plan', 'planned', 'in_production', 'dispatch', 'closed'];
export const PO_STATE_LABEL = {
  yet_to_plan: 'Yet to plan', planned: 'Planned', in_production: 'In production', dispatch: 'Dispatch', closed: 'Closed',
};

const isWhole = (q) => Math.abs(q - Math.round(q)) < 1e-9 && q > 0;

/** "G1" from "SO-…-SPAN-01-G1" (its code past the root's), else the row's name. */
function nodeLabel(node, rootCode) {
  const code = node.code ?? null;
  if (code && rootCode && code.startsWith(`${rootCode}-`)) return code.slice(rootCode.length + 1);
  return code ?? node.name;
}

/**
 * The instances of a BOM level in ONE unit of a line's tree, in tree order: [{ path, n, label }]. A row of quantity 3
 * is three instances; an ancestor repeated in the unit is named in front ("Splice set #2 · Cover plate"). n counts
 * the instances sharing a path (ancestor-major — the tracker numbers its pieces the same way).
 */
export function instancesOf(tree, defOf, levelId) {
  const out = [];
  if (!tree?.root) return out;
  const rootCode = tree.root.code ?? null;
  const count = new Map();
  const walk = (node, prefix, path) => {
    const def = defOf(node.id);
    const q = Math.max(1, Math.round(Number(node.quantity) || 1));
    const base = nodeLabel(node, rootCode);
    const p = [...path, node.lineId ?? `i${node.id}`];
    if (def && Number(def.id) === Number(levelId) && node.children.length > 0) {
      const key = p.join('/');
      for (let i = 1; i <= q; i += 1) {
        const n = (count.get(key) ?? 0) + 1;
        count.set(key, n);
        out.push({ path: key, n, label: [...prefix, q > 1 ? `${base} #${i}` : base].join(' · ') });
      }
      return;
    }
    for (let i = 1; i <= q; i += 1) {
      const pre = q > 1 ? [...prefix, `${base} #${i}`] : prefix;
      for (const k of node.children) walk(k, pre, p);
    }
  };
  for (const k of tree.root.children) walk(k, [], []);
  // Rows not coded yet share a name: number them in order (Girder line 1, 2, 3).
  const seen = new Map();
  for (const x of out) seen.set(x.label, (seen.get(x.label) ?? 0) + 1);
  const at = new Map();
  return out.map((x) => {
    if (seen.get(x.label) < 2) return x;
    const k = (at.get(x.label) ?? 0) + 1;
    at.set(x.label, k);
    return { ...x, label: `${x.label} ${k}` };
  });
}

/**
 * The level a line is really made at: per unit / per sub-assembly fall back to one per line for a line with no rows
 * under its item, a quantity that is not whole, or a sub-assembly level the line does not have.
 */
function madeLevel(l) {
  const P = l.plan.production;
  const qty = Number(l.quantity);
  const hasRows = (l.tree?.root?.children?.length ?? 0) > 0;
  let level = P.level;
  if ((level === 'unit' || level === 'assembly') && (!hasRows || !isWhole(qty))) level = 'line';
  if (level === 'assembly' && !(l.shape?.levels ?? []).some((x) => Number(x.id) === Number(P.levelId))) level = 'line';
  return level;
}

/**
 * BATCHES (user, 2026-11-01: "they can group different things in a level into a PO … it can break into different
 * sizes for each PO"). The PIECES of a line at its split level, in tree order: each unit (per unit), or each
 * sub-assembly of the level in each unit (per sub-assembly). `key` is the production order the piece would be on its
 * own — its scope key; a batch (plan.groups: [{ name, keys }]) puts several pieces in ONE production order.
 * → [{ key, label, unitNo }] — empty when the line is not split (or falls back to one per line).
 */
export function levelPieces(l, defOf) {
  const level = madeLevel(l);
  if (level !== 'unit' && level !== 'assembly') return [];
  const units = Math.max(1, Math.round(Number(l.quantity) || 1));
  const unitName = l.itemName ?? 'Unit';
  const out = [];
  if (level === 'unit') {
    for (let u = 1; u <= units; u += 1) out.push({ key: `L${l.lineId}U${u}`, label: `${unitName} ${u}`, unitNo: u });
    return out;
  }
  const levelId = Number(l.plan.production.levelId);
  const inst = instancesOf(l.tree, defOf, levelId);
  for (let u = 1; u <= units; u += 1) {
    for (const x of inst) {
      out.push({ key: `L${l.lineId}U${u}A${levelId}:${x.path}#${x.n}`, label: units > 1 ? `${unitName} ${u} · ${x.label}` : x.label, unitNo: u });
    }
  }
  return out;
}

/** "Batch 2: G1, G2 (+3 more)" — a batch's production order, named by its first pieces. */
function groupLabel(name, k, labels) {
  const shown = labels.slice(0, 2).join(', ');
  const more = labels.length - 2;
  return `${name || `Batch ${k}`}: ${shown}${more > 0 ? ` (+${more} more)` : ''}`;
}

/**
 * One line's production orders (not the 'order' level — the order makes that one). manyLines: the order has more
 * than one line that makes something (then labels name the line).
 */
export function lineProductionOrders(orderCode, manyLines, l, defOf) {
  const out = [];
  const P = l.plan.production;
  const D = l.plan.dispatch;
  const head = manyLines ? `${orderCode} · Line ${l.lineNo}` : orderCode;
  const qty = Number(l.quantity);
  const units = Math.max(1, Math.round(qty || 1));
  const unitName = l.itemName ?? 'Unit';
  const base = { lineId: Number(l.lineId), lineIds: [Number(l.lineId)], dispatchLevel: D.level, dispatchLevelId: D.levelId ?? null, members: null };
  const level = madeLevel(l);
  if (level === 'line') {
    out.push({ ...base, scopeKey: `L${l.lineId}`, level: 'line', levelId: null, unitNo: null, label: `${head} · ${unitName} ×${qty}` });
    return out;
  }
  const unitLabel = (u) => `${head} · ${unitName} ${u} of ${units}`;
  if (level === 'unit') {
    for (let u = 1; u <= units; u += 1) out.push({ ...base, scopeKey: `L${l.lineId}U${u}`, level: 'unit', levelId: null, unitNo: u, label: unitLabel(u) });
  } else {
    const inst = instancesOf(l.tree, defOf, P.levelId);
    const rest = !!(l.shape?.outside?.get(P.levelId) || l.shape?.hasRootFlow);
    for (let u = 1; u <= units; u += 1) {
      for (const x of inst) {
        out.push({ ...base, scopeKey: `L${l.lineId}U${u}A${P.levelId}:${x.path}#${x.n}`, level: 'assembly', levelId: Number(P.levelId), unitNo: u, label: `${unitLabel(u)} · ${x.label}` });
      }
      if (rest || !inst.length) out.push({ ...base, scopeKey: `L${l.lineId}U${u}R`, level: 'assembly', levelId: Number(P.levelId), unitNo: u, label: `${unitLabel(u)} · the rest and final assembly` });
    }
  }
  // Batches: each becomes ONE production order, where its first piece stood; a piece in no batch stays on its own.
  const groups = (l.plan.groups ?? []).filter((g) => (g?.keys ?? []).length);
  if (!groups.length) return out;
  const groupOf = new Map();
  groups.forEach((g, i) => { for (const k of g.keys) if (!groupOf.has(k)) groupOf.set(k, i); });
  const pieceLabel = new Map(levelPieces(l, defOf).map((p) => [p.key, p.label]));
  const members = groups.map(() => []);
  for (const x of out) { const gi = groupOf.get(x.scopeKey); if (gi != null) members[gi].push(x); }
  const done = new Set();
  const merged = [];
  for (const x of out) {
    const gi = groupOf.get(x.scopeKey);
    if (gi == null) { merged.push(x); continue; }
    if (done.has(gi)) continue;
    done.add(gi);
    const m = members[gi];
    const unitNos = new Set(m.map((y) => y.unitNo));
    merged.push({
      ...base, scopeKey: `L${l.lineId}G${gi + 1}`, level: x.level, levelId: x.levelId, unitNo: unitNos.size === 1 ? m[0].unitNo : null,
      label: `${head} · ${groupLabel(groups[gi].name, gi + 1, m.map((y) => pieceLabel.get(y.scopeKey) ?? y.scopeKey))}`,
      members: m.map((y) => y.scopeKey),
    });
  }
  return merged;
}

/**
 * Every production order the plan asks for, in order.
 * lines: [{ lineId, lineNo, quantity, itemName, plan, shape, tree }] — the lines that MAKE something, in order.
 * → [{ scopeKey, level, levelId, lineId, unitNo, lineIds, label, dispatchLevel, dispatchLevelId, members }]
 *   members: a batch's pieces (their own scope keys), else null.
 * A line whose item has no rows under it is made whole: per unit / per sub-assembly fall back to one per line.
 */
export function plannedProductionOrders(orderCode, lines, defOf) {
  const out = [];
  const manyLines = lines.length > 1;
  const together = lines.filter((l) => l.plan.production.level === 'order');
  if (together.length) {
    const d = together[0].plan.dispatch;
    out.push({
      scopeKey: 'O', level: 'order', levelId: null, lineId: null, unitNo: null, lineIds: together.map((l) => Number(l.lineId)),
      label: lines.length === together.length ? `${orderCode} · whole order` : `${orderCode} · ${together.length === 1 ? 'line' : 'lines'} ${together.map((l) => l.lineNo).join(', ')} together`,
      dispatchLevel: d.level, dispatchLevelId: d.levelId ?? null, members: null,
    });
  }
  for (const l of lines) {
    if (l.plan.production.level === 'order') continue;
    out.push(...lineProductionOrders(orderCode, manyLines, l, defOf));
  }
  return out;
}

/** A production order's batch members (a stored row's members_json, or a planned one's members) as a list. */
function membersOf(o) {
  const v = o.members ?? o.members_json ?? null;
  if (v == null) return [];
  if (Array.isArray(v)) return v;
  try { const a = JSON.parse(v); return Array.isArray(a) ? a : []; } catch { return []; }
}

/**
 * Which production order each piece of ONE released line belongs to. PURE.
 * items: the release's live items [{ id, parent_id, depth, sort_order, bom_line_id, item_id, piece_no, quantity }]
 * orders: the live production orders covering the line [{ id, scope_key, level, level_id }]
 * defOf(itemId) → { id } | null — the definition the piece's row was made from.
 * → Map(item id → production order id). Empty when no production order covers the line.
 */
export function assignPieces(lineId, items, orders, defOf) {
  const out = new Map();
  if (!orders.length || !items.length) return out;
  const byKey = new Map(orders.map((o) => [o.scope_key, o]));
  const whole = byKey.get('O') ?? byKey.get(`L${lineId}`) ?? null;
  if (whole) { for (const it of items) out.set(it.id, whole.id); return out; }
  const sorted = [...items].sort((a, b) => Number(a.sort_order) - Number(b.sort_order));
  const kids = new Map();
  for (const it of sorted) {
    const k = it.parent_id ?? 0;
    if (!kids.has(k)) kids.set(k, []);
    kids.get(k).push(it);
  }
  const byId = [...orders].sort((a, b) => a.id - b.id);
  const firstOf = byId[0];
  // A batch's production order holds its pieces by their own scope keys: the piece's key is worked out as always,
  // then looked up among the members.
  const memberOf = new Map();
  for (const o of orders) for (const k of membersOf(o)) if (!memberOf.has(k)) memberOf.set(k, o);
  const find = (key) => byKey.get(key) ?? memberOf.get(key) ?? null;
  const roots = kids.get(0) ?? [];
  roots.forEach((root, i) => {
    const u = root.piece_no == null && Number(root.quantity) > 1 ? 1 : i + 1;
    const unitPo = find(`L${lineId}U${u}`);
    if (unitPo) {
      const all = (x) => { out.set(x.id, unitPo.id); for (const k of kids.get(x.id) ?? []) all(k); };
      all(root);
      return;
    }
    // Per sub-assembly: the topmost piece of the level opens an instance; everything else is the unit's rest.
    const inUnit = (k) => String(k).startsWith(`L${lineId}U${u}A`);
    const rest = byKey.get(`L${lineId}U${u}R`)
      ?? byId.find((o) => inUnit(o.scope_key) || membersOf(o).some(inUnit))
      ?? firstOf;
    const count = new Map();
    const walk = (x, path, inside) => {
      const p = x.depth === 0 ? [] : [...path, x.bom_line_id ?? `i${x.item_id}`];
      let mine = inside;
      if (!inside && x.depth > 0) {
        const def = defOf(x.item_id);
        const lvl = orders.find((o) => o.level === 'assembly' && def && Number(o.level_id) === Number(def.id));
        if (lvl && (kids.get(x.id)?.length ?? 0) > 0) {
          const key = p.join('/');
          const n = (count.get(key) ?? 0) + 1;
          const many = x.piece_no == null ? Math.max(1, Math.round(Number(x.quantity) || 1)) : 1;
          count.set(key, n + many - 1);
          mine = find(`L${lineId}U${u}A${lvl.level_id}:${key}#${n}`)?.id ?? rest.id;
        }
      }
      out.set(x.id, mine ?? rest.id);
      for (const k of kids.get(x.id) ?? []) walk(k, p, mine);
    };
    walk(root, [], null);
  });
  return out;
}

/**
 * A production order's state from its stored status and its steps.
 * agg: { steps, done, started } (null = no steps)
 */
export function stateOf(status, agg) {
  if (status === 'closed') return 'closed';
  if (status === 'yet_to_plan') return 'yet_to_plan';
  const steps = Number(agg?.steps ?? 0);
  const done = Number(agg?.done ?? 0);
  if (steps === 0 || done >= steps) return 'dispatch';
  if (Number(agg?.started ?? 0) > 0) return 'in_production';
  return 'planned';
}
