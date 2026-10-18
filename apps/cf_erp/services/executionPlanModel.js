/**
 * executionPlanModel.js — the EXECUTION PLAN of a sales order, worked out (init.sql §72). PURE: no database.
 * The service (executionPlanService.js) and the process stage (processService 'execution_plan') read the same
 * answers from here, so the screen, the stage mark and the API cannot disagree.
 *
 * User, 2026-10-18: before the design is frozen, say how the order is MADE (the production orders) and how it is
 * SHIPPED (the dispatch units).
 *
 *   PRODUCTION ORDER LEVEL   order     one production order for every line on this level, together
 *                            line      one per line                                  (the default)
 *                            unit      one per unit of the line — each span of a line of 3
 *                            assembly  one per sub-assembly of a BOM LEVEL (e.g. each Girder line), plus one for
 *                                      the rest of each unit (what is not inside one, and the final assembly)
 *   DISPATCH LEVEL           same (as the production orders — the default) · line · unit · assembly — never
 *                            coarser than the production order: a dispatch unit lies inside one production order.
 *
 * A BOM LEVEL is the DEFINITION the rows were made from (cf_item_details.source_definition_id): every row made
 * from "Girder line" is one Girder line. Only a level whose rows have rows under them is offered (a sub-assembly).
 * Counted per UNIT of the line from the topmost rows of that level (a level nested inside itself counts once).
 *
 * Nothing here builds production orders, and nesting does not read it yet (a later step: nesting will run per
 * production order). It is captured, checked and previewed.
 */

export const PRODUCTION_LEVELS = ['order', 'line', 'unit', 'assembly'];
export const DISPATCH_LEVELS = ['same', 'line', 'unit', 'assembly'];
/** No row at all: one production order per line, dispatched the same way. */
export const DEFAULT_PLAN = Object.freeze({
  production: Object.freeze({ level: 'line', levelId: null }),
  dispatch: Object.freeze({ level: 'same', levelId: null }),
});
/** How many labels a preview lists (the count is always the whole). */
export const PREVIEW_LIMIT = 60;

const RANK = { order: 0, line: 1, unit: 2, assembly: 3 };
const EPS = 1e-9;
const n = (count, word, plural = `${word}s`) => `${Number(count).toLocaleString('en-IN')} ${Number(count) === 1 ? word : plural}`;
const isWhole = (q) => Math.abs(q - Math.round(q)) < EPS && q > 0;

/** { level, levelId } read from a stored row's columns. */
export const choiceOf = (level, levelId) => ({ level, levelId: level === 'assembly' ? (levelId == null ? null : Number(levelId)) : null });
export const sameChoice = (a, b) => (a?.level ?? null) === (b?.level ?? null) && (a?.levelId ?? null) === (b?.levelId ?? null);
export const samePlan = (a, b) => sameChoice(a?.production, b?.production) && sameChoice(a?.dispatch, b?.dispatch);

/** A stored row as a plan. */
export const planOfRow = (r) => ({
  production: choiceOf(r.production_level, r.production_level_id),
  dispatch: choiceOf(r.dispatch_level, r.dispatch_level_id),
});

/**
 * A line's plan and where it came from: its own row, else the order's row, else the house default.
 * rows: the order's live plan rows (order_line_id NULL = the order's own).
 */
export function effectivePlan(rows, lineId) {
  const own = rows.find((r) => r.order_line_id != null && Number(r.order_line_id) === Number(lineId));
  if (own) return { plan: planOfRow(own), source: 'line' };
  const order = rows.find((r) => r.order_line_id == null);
  if (order) return { plan: planOfRow(order), source: 'order' };
  return { plan: { production: { ...DEFAULT_PLAN.production }, dispatch: { ...DEFAULT_PLAN.dispatch } }, source: 'default' };
}

/**
 * The BOM levels of one line's tree: every definition whose rows have rows under them, with how many there are in
 * ONE unit of the line. `defOf(itemId)` → { id, name } | null — the definition a row was made from.
 *
 * Also what the plan's checks need: `below` (the levels found inside an instance of a level) and `outside`
 * (whether anything at depth ≥ 1 lies outside every instance of a level — then a unit has "the rest").
 */
export function levelsOf(tree, defOf) {
  const out = new Map();
  if (!tree?.root) return { levels: [], below: new Map(), outside: new Map() };
  const unitQty = Number(tree.root.quantity) || 1;
  const below = new Map();
  const nodesTotal = { n: 0 };
  // Walk once: each node with the chain of level ids above it.
  const walk = (node, chain) => {
    if (node.depth >= 1) nodesTotal.n += 1;
    const def = node.depth >= 1 && (node.kind === 'temporary' || node.kind === 'catalog') ? defOf(node.id) : null;
    const isLevel = !!def && node.children.length > 0;
    if (isLevel) {
      const e = out.get(def.id) ?? { id: def.id, name: def.name, depth: node.depth, perUnit: 0, inside: 0 };
      e.depth = Math.min(e.depth, node.depth);
      // Topmost only: a level nested inside itself counts once.
      if (!chain.includes(def.id)) e.perUnit += Number(node.total) / unitQty;
      out.set(def.id, e);
      for (const up of chain) {
        if (!below.has(up)) below.set(up, new Set());
        if (up !== def.id) below.get(up).add(def.id);
      }
    }
    const next = isLevel ? [...chain, def.id] : chain;
    for (const k of node.children) walk(k, next);
  };
  walk(tree.root, []);
  // outside(level): some node at depth >= 1 that is neither an instance of the level nor under one.
  const outside = new Map();
  for (const id of out.keys()) {
    let found = false;
    const look = (node, inside) => {
      if (found) return;
      const def = node.depth >= 1 ? defOf(node.id) : null;
      const isIt = !!def && def.id === id && node.children.length > 0;
      if (node.depth >= 1 && !inside && !isIt) { found = true; return; }
      for (const k of node.children) look(k, inside || isIt);
    };
    for (const k of tree.root.children) look(k, false);
    outside.set(id, found);
  }
  const levels = [...out.values()]
    .map((e) => ({ id: e.id, name: e.name, depth: e.depth, perUnit: Number(e.perUnit.toFixed(6)) }))
    .sort((a, b) => a.depth - b.depth || a.name.localeCompare(b.name) || a.id - b.id);
  return { levels, below, outside, rows: nodesTotal.n, hasRootFlow: !!tree.root.flow };
}

/** "G1" from "SO-…-SPAN-01-G1" (its code past the root's), else the row's name. */
function nodeLabel(node, rootCode) {
  const code = node.code ?? null;
  if (code && rootCode && code.startsWith(`${rootCode}-`)) return code.slice(rootCode.length + 1);
  return code ?? node.name;
}

/**
 * The instances of a level in ONE unit, as labels — at most `limit`. A row with quantity 3 is three instances
 * ("#1 … #3"); an ancestor repeated in the unit is named in front ("Splice set #2 · Cover plate").
 */
export function instanceLabels(tree, defOf, levelId, limit = PREVIEW_LIMIT) {
  const out = [];
  if (!tree?.root) return out;
  const rootCode = tree.root.code ?? null;
  const walk = (node, prefix) => {
    if (out.length >= limit) return;
    const def = defOf(node.id);
    const q = Math.max(1, Math.round(Number(node.quantity) || 1));
    const base = nodeLabel(node, rootCode);
    if (def && def.id === levelId && node.children.length > 0) {
      for (let i = 1; i <= q && out.length < limit; i += 1) out.push([...prefix, q > 1 ? `${base} #${i}` : base].join(' · '));
      return;
    }
    for (let i = 1; i <= q && out.length < limit; i += 1) {
      const p = q > 1 ? [...prefix, `${base} #${i}`] : prefix;
      for (const k of node.children) walk(k, p);
    }
  };
  for (const k of tree.root.children) walk(k, []);
  // Rows not coded yet (codes come with the freeze) share a name: number them in order — Girder line 1, 2, 3.
  const seen = new Map();
  for (const x of out) seen.set(x, (seen.get(x) ?? 0) + 1);
  const at = new Map();
  return out.map((x) => {
    if (seen.get(x) < 2) return x;
    const k = (at.get(x) ?? 0) + 1;
    at.set(x, k);
    return `${x} ${k}`;
  });
}

/** A level's name on a line, or a plain stand-in. */
const levelName = (shape, id) => shape?.levels.find((l) => l.id === id)?.name ?? 'that level';

/**
 * Checks one line's plan against its own tree. Returns sentences (empty = fine).
 * line: { lineNo, quantity, frozen }; shape: levelsOf(tree) (null for a line with no structure); names: level id →
 * name (from any line), so a level this line lacks is still named.
 */
export function checkLinePlan(line, plan, shape, names = new Map()) {
  const problems = [];
  const L = `Line ${line.lineNo}`;
  const P = plan.production;
  const D = plan.dispatch;
  const qty = Number(line.quantity);
  if (!PRODUCTION_LEVELS.includes(P.level)) problems.push(`${L}: "${P.level}" is not a production order level.`);
  if (!DISPATCH_LEVELS.includes(D.level)) problems.push(`${L}: "${D.level}" is not a dispatch level.`);
  if (problems.length) return problems;
  const levels = shape?.levels ?? [];
  const needsWhole = P.level === 'unit' || P.level === 'assembly' || D.level === 'unit' || D.level === 'assembly';
  if (needsWhole && !isWhole(qty)) problems.push(`${L}'s quantity is ${qty}. Per unit and per sub-assembly need a whole number.`);
  if (P.level === 'assembly') {
    if (P.levelId == null) problems.push(`${L}: choose the BOM level for "per sub-assembly".`);
    else if (!levels.some((x) => x.id === P.levelId)) problems.push(`${L} has no ${names.get(P.levelId) ?? 'rows of that BOM level'} — choose another level for it.`);
  }
  if (D.level === 'assembly') {
    if (D.levelId == null) problems.push(`${L}: choose the BOM level for the dispatch units.`);
    else if (!levels.some((x) => x.id === D.levelId)) problems.push(`${L} has no ${names.get(D.levelId) ?? 'rows of that BOM level'} to dispatch by — choose another level for it.`);
  }
  if (problems.length) return problems;
  // Never coarser than the production order.
  if (D.level !== 'same') {
    const coarser = RANK[D.level] < RANK[P.level]
      || (D.level === 'assembly' && P.level === 'assembly' && D.levelId !== P.levelId && !!shape?.below.get(D.levelId)?.has(P.levelId));
    if (coarser) problems.push(`${L}: a dispatch unit cannot be bigger than a production order. Choose "Same as the production order" or a smaller level.`);
  }
  return problems;
}

/** How many production orders one line makes on its own (0 for a line on the 'order' level — the order counts it). */
export function productionCount(line, plan, shape) {
  const P = plan.production;
  const units = Math.max(1, Math.round(Number(line.quantity) || 1));
  if (P.level === 'order') return 0;
  if (P.level === 'line') return 1;
  if (P.level === 'unit') return units;
  const lv = shape?.levels.find((x) => x.id === P.levelId);
  if (!lv) return 0;
  const rest = shape.outside.get(P.levelId) || shape.hasRootFlow ? 1 : 0;
  return units * (Math.round(lv.perUnit) + rest);
}

/** How many dispatch units one line makes (with its production orders, for 'same'). */
export function dispatchCount(line, plan, shape) {
  const D = plan.dispatch;
  const units = Math.max(1, Math.round(Number(line.quantity) || 1));
  if (D.level === 'same') return productionCount(line, plan, shape);
  if (D.level === 'line') return 1;
  if (D.level === 'unit') return units;
  const lv = shape?.levels.find((x) => x.id === D.levelId);
  if (!lv) return 0;
  return units * (Math.round(lv.perUnit) + (shape.outside.get(D.levelId) ? 1 : 0));
}

/**
 * The labels of what one line makes or ships at a level, at most `limit`.
 * ctx: { orderCode, manyLines, line: { lineNo, quantity, itemName }, tree, defOf, shape }
 */
function labelsAt(ctx, choice, { rest, limit }) {
  const { orderCode, manyLines, line } = ctx;
  const head = manyLines ? `${orderCode} · Line ${line.lineNo}` : orderCode;
  const units = Math.max(1, Math.round(Number(line.quantity) || 1));
  const unitName = line.itemName ?? 'Unit';
  const unitLabel = (i) => `${head} · ${unitName} ${i} of ${units}`;
  const out = [];
  if (choice.level === 'line') return [`${head} · ${unitName} ×${Number(line.quantity)}`];
  if (choice.level === 'unit') {
    for (let i = 1; i <= units && out.length < limit; i += 1) out.push(unitLabel(i));
    return out;
  }
  const inst = instanceLabels(ctx.tree, ctx.defOf, choice.levelId, limit);
  for (let i = 1; i <= units && out.length < limit; i += 1) {
    for (const x of inst) { if (out.length >= limit) break; out.push(`${unitLabel(i)} · ${x}`); }
    if (rest && out.length < limit) out.push(`${unitLabel(i)} · ${rest}`);
  }
  return out;
}

/**
 * The whole order's preview.
 * lines: [{ lineId, lineNo, quantity, itemName, plan, shape, tree }] — every live line, in order.
 * Returns { production: { count, items[], more, sentence }, dispatch: { … }, perLine: Map(lineId → { production, dispatch }) }.
 */
export function previewOrder(orderCode, lines, defOf, { limit = PREVIEW_LIMIT } = {}) {
  const manyLines = lines.length > 1;
  const together = lines.filter((l) => l.plan.production.level === 'order');
  const perLine = new Map();
  const prod = [];
  const disp = [];
  let prodCount = 0;
  let dispCount = 0;
  if (together.length) {
    prodCount += 1;
    const label = lines.length === together.length
      ? `${orderCode} · whole order`
      : `${orderCode} · ${together.length === 1 ? 'line' : 'lines'} ${together.map((l) => l.lineNo).join(', ')} together`;
    prod.push(label);
  }
  for (const l of lines) {
    const ctx = { orderCode, manyLines, line: l, tree: l.tree, defOf, shape: l.shape };
    const pc = productionCount(l, l.plan, l.shape);
    const dc = l.plan.dispatch.level === 'same' && l.plan.production.level === 'order' ? 0 : dispatchCount(l, l.plan, l.shape);
    perLine.set(l.lineId, { production: pc, dispatch: l.plan.production.level === 'order' && l.plan.dispatch.level === 'same' ? null : dc });
    prodCount += pc;
    if (pc && prod.length < limit) {
      const P = l.plan.production;
      const rest = P.level === 'assembly' && (l.shape?.outside.get(P.levelId) || l.shape?.hasRootFlow) ? 'the rest and final assembly' : null;
      prod.push(...labelsAt(ctx, P, { rest, limit: limit - prod.length }));
    }
    if (l.plan.dispatch.level !== 'same') {
      dispCount += dc;
      if (disp.length < limit) {
        const D = l.plan.dispatch;
        const rest = D.level === 'assembly' && l.shape?.outside.get(D.levelId) ? 'loose items' : null;
        disp.push(...labelsAt(ctx, D, { rest, limit: limit - disp.length }));
      }
    }
  }
  // 'same' everywhere it is asked: the production orders themselves (and the together-order once).
  const sameLines = lines.filter((l) => l.plan.dispatch.level === 'same');
  if (sameLines.length) {
    if (together.some((l) => l.plan.dispatch.level === 'same')) { dispCount += 1; disp.unshift(prod[0]); }
    for (const l of sameLines) {
      if (l.plan.production.level === 'order') continue;
      const ctx = { orderCode, manyLines, line: l, tree: l.tree, defOf, shape: l.shape };
      const P = l.plan.production;
      dispCount += productionCount(l, l.plan, l.shape);
      if (disp.length < limit) {
        const rest = P.level === 'assembly' && (l.shape?.outside.get(P.levelId) || l.shape?.hasRootFlow) ? 'the rest and final assembly' : null;
        disp.push(...labelsAt(ctx, P, { rest, limit: limit - disp.length }));
      }
    }
  }
  const shown = (list, count) => ({ count, items: list.slice(0, limit), more: Math.max(0, count - Math.min(list.length, limit)) });
  const production = shown(prod, prodCount);
  const dispatch = shown(disp, dispCount);
  production.sentence = sentence(`This order will make ${n(prodCount, 'production order')}`, production);
  dispatch.sentence = sentence(`It will ship in ${n(dispCount, 'dispatch unit')}`, dispatch);
  return { production, dispatch, perLine };
}

function sentence(lead, { items, more }) {
  if (!items.length) return `${lead}.`;
  const first = items.slice(0, 3).join(', ');
  const rest = more + Math.max(0, items.length - 3);
  return `${lead}: ${first}${rest > 0 ? ` and ${n(rest, 'more', 'more')}` : ''}.`;
}

/** A plan in a few words — the stage detail and the line's cell. */
export function planWords(plan, shape) {
  const P = plan.production;
  const D = plan.dispatch;
  const prod = P.level === 'order' ? 'one production order for the whole order'
    : P.level === 'line' ? 'one production order for the line'
      : P.level === 'unit' ? 'one production order per unit'
        : `one production order per ${levelName(shape, P.levelId)}`;
  const disp = D.level === 'same' ? 'dispatched the same way'
    : D.level === 'line' ? 'dispatched per line'
      : D.level === 'unit' ? 'dispatched per unit'
        : `dispatched per ${levelName(shape, D.levelId)}`;
  return `${prod.charAt(0).toUpperCase()}${prod.slice(1)}, ${disp}`;
}

/**
 * Ready-made plans for the screen (user: "templates where useful"): the usual one, per unit when a line has more
 * than one, and per each of the two topmost BOM levels the lines share.
 */
export function templatesFor(lines) {
  const out = [
    { key: 'per_line', label: 'One per line (usual)', plan: { production: { level: 'line', levelId: null }, dispatch: { level: 'same', levelId: null } } },
    { key: 'whole_order', label: 'Whole order at once', plan: { production: { level: 'order', levelId: null }, dispatch: { level: 'same', levelId: null } } },
  ];
  if (lines.some((l) => Number(l.quantity) > 1)) {
    out.push({ key: 'per_unit', label: 'One per unit', plan: { production: { level: 'unit', levelId: null }, dispatch: { level: 'same', levelId: null } } });
  }
  // The two most useful levels: on every line, several to a unit, nearest the top (Girder line, then Girder segment).
  const perUnit = (id) => Math.max(0, ...lines.flatMap((l) => (l.shape?.levels ?? []).filter((x) => x.id === id).map((x) => x.perUnit)));
  const shared = sharedLevels(lines).filter((lv) => lv.onEveryLine)
    .sort((a, b) => Number(perUnit(b.id) > 1) - Number(perUnit(a.id) > 1) || a.depth - b.depth || perUnit(b.id) - perUnit(a.id));
  for (const lv of shared.slice(0, 2)) {
    out.push({ key: `per_${lv.id}`, label: `One per ${lv.name}`, plan: { production: { level: 'assembly', levelId: lv.id }, dispatch: { level: 'same', levelId: null } } });
  }
  return out;
}

/** BOM levels found on the lines, with the lines that have each — the order-wide picker. */
export function sharedLevels(lines) {
  const by = new Map();
  for (const l of lines) {
    for (const lv of l.shape?.levels ?? []) {
      const e = by.get(lv.id) ?? { id: lv.id, name: lv.name, depth: lv.depth, lineNos: [] };
      e.depth = Math.min(e.depth, lv.depth);
      e.lineNos.push(l.lineNo);
      by.set(lv.id, e);
    }
  }
  const withStructure = lines.filter((l) => (l.shape?.levels ?? []).length > 0).length;
  return [...by.values()]
    .map((e) => ({ ...e, onEveryLine: e.lineNos.length === withStructure }))
    .sort((a, b) => Number(b.onEveryLine) - Number(a.onEveryLine) || a.depth - b.depth || a.name.localeCompare(b.name));
}
