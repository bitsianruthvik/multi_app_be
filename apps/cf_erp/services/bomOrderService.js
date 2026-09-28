/** Reorder/move existing BOM lines without replacing their identity or values.
 * The caller owns the transaction and has checked that every parent is editable
 * from its screen. Complete sibling lists detect stale screens and missing rows.
 */
import { invalid } from '../lib/errors.js';
import { requireMaster } from './records.js';
import { bomTypeOf, createBom } from './bomGraph.js';
import { assertEditable, ALLOWED_CHILDREN } from './bomService.js';

const bad = (message) => { throw invalid('ARRANGEMENT', message); };

export async function arrangeBomLines(db, c, groups, tree) {
  const nodes = new Map(), lines = new Map(), edges = new Map();
  const walk = (node, parent = null) => {
    nodes.set(node.id, node);
    edges.set(node.id, node.children.map((child) => child.id));
    if (node.lineId != null) lines.set(node.lineId, { node, parent });
    node.children.forEach((child) => walk(child, node));
  };
  walk(tree);
  const parentIds = groups.map((g) => g.parentId);
  if (new Set(parentIds).size !== parentIds.length) bad('Give each parent’s row order once.');
  const wanted = groups.flatMap((g) => g.lineIds);
  if (new Set(wanted).size !== wanted.length) bad('A row cannot appear in two positions.');
  const parents = new Map();
  for (const g of groups) {
    if (!nodes.has(g.parentId)) bad('A destination is no longer in this structure. Reload and try again.');
    const parent = await requireMaster(db, c.companyId, g.parentId);
    await assertEditable(db, c.companyId, parent);
    if (!bomTypeOf(parent)) bad(`${parent.name} cannot hold a BOM.`);
    parents.set(g.parentId, parent);
  }
  const [headers] = await db.query('SELECT id,parent_id FROM cf_boms WHERE company_id=? AND parent_id IN (?) AND deleted_at IS NULL FOR UPDATE', [c.companyId, parentIds]);
  const byParent = new Map(headers.map((b) => [b.parent_id, b.id]));
  const [current] = headers.length ? await db.query('SELECT id,bom_id,line_no,position,design_id FROM cf_bom_lines WHERE company_id=? AND bom_id IN (?) AND deleted_at IS NULL ORDER BY bom_id,line_no,id FOR UPDATE', [c.companyId, headers.map((b) => b.id)]) : [[]];
  const currentIds = new Set(current.map((l) => l.id));
  if (current.length !== wanted.length || wanted.some((id) => !currentIds.has(id))) {
    bad('These rows have changed since the screen was opened. Reload before rearranging them.');
  }
  const rowById = new Map(current.map((l) => [l.id, l]));
  const refresh = new Set();
  let moved = 0, reordered = 0;
  for (const g of groups) {
    const target = nodes.get(g.parentId);
    const type = bomTypeOf(parents.get(g.parentId));
    const children = [];
    for (const id of g.lineIds) {
      const e = lines.get(id);
      if (!e) bad('A row is no longer in this structure. Reload and try again.');
      children.push(e.node.id);
      if (e.parent.id === g.parentId) continue;
      if (type === 'custom' ? !['temporary', 'catalog', 'selection'].includes(e.node.kind) : !ALLOWED_CHILDREN[type].includes(e.node.kind)) {
        bad(`${e.node.name} cannot be moved under ${target.name}.`);
      }
      if (e.node.status === 'obsolete') bad(`${e.node.name} is obsolete and cannot move to another BOM.`);
      if (e.node.kind === 'temporary' && parents.get(e.parent.id)?.owner_order_line_id !== parents.get(g.parentId).owner_order_line_id) {
        bad('An order’s own row can only move within that order line.');
      }
      moved++;
      refresh.add(e.parent.id); refresh.add(g.parentId); refresh.add(e.node.id);
    }
    edges.set(g.parentId, children);
    const old = current.filter((l) => l.bom_id === byParent.get(g.parentId)).map((l) => l.id);
    if (JSON.stringify(old) !== JSON.stringify(g.lineIds)) reordered++;
  }
  // Check the complete proposed graph: A under B plus B under A must fail even
  // though each move considered against the old tree would be legal alone.
  const done = new Set(), visiting = new Set();
  const check = (id) => {
    if (visiting.has(id)) bad(`${nodes.get(id)?.name ?? 'A row'} cannot go inside itself or its children.`);
    if (done.has(id)) return;
    visiting.add(id);
    for (const child of edges.get(id) ?? []) check(child);
    visiting.delete(id); done.add(id);
  };
  for (const id of edges.keys()) check(id);
  if (!reordered) return { moved: 0, reordered: 0, refresh: [] };
  for (const g of groups) if (!byParent.has(g.parentId) && g.lineIds.length) {
    const header = await createBom(db, c, { parentId: g.parentId, bomType: bomTypeOf(parents.get(g.parentId)) });
    byParent.set(g.parentId, header.id);
  }
  const [maxima] = headers.length ? await db.query('SELECT bom_id,MAX(position) top FROM cf_bom_lines WHERE company_id=? AND bom_id IN (?) GROUP BY bom_id', [c.companyId, [...byParent.values()]]) : [[]];
  const next = new Map(maxima.map((r) => [r.bom_id, Number(r.top)]));
  const assignments = [];
  for (const g of groups) g.lineIds.forEach((id, i) => {
    const old = rowById.get(id), bomId = byParent.get(g.parentId);
    const changedParent = old.bom_id !== bomId;
    const position = changedParent ? (next.get(bomId) ?? 0) + 1 : old.position;
    if (changedParent) next.set(bomId, position);
    assignments.push({ id, bomId, lineNo: (i + 1) * 10, position, changedParent });
  });
  if (!assignments.length) return { moved, reordered, refresh: [...refresh] };
  // Unique keys are checked row by row. Park live numbers below every existing
  // number before exchanging parents/positions, then assign the final order.
  const floor = Math.min(0, ...current.map((l) => l.line_no)) - assignments.length - 1;
  const posFloor = Math.min(0, ...current.map((l) => l.position)) - assignments.length - 1;
  const write = async (part, parked, offset) => {
    const params = [];
    const field = (key, value) => `${key}=CASE id ${part.map((r, i) => { params.push(r.id, value(r, i)); return 'WHEN ? THEN ?'; }).join(' ')} ELSE ${key} END`;
    const sets = parked
      ? [field('line_no', (_, i) => floor - offset - i), field('position', (r, i) => r.changedParent ? posFloor - offset - i : r.position)]
      : [field('bom_id', (r) => r.bomId), field('line_no', (r) => r.lineNo), field('position', (r) => r.position)];
    await db.query(`UPDATE cf_bom_lines SET ${sets.join(',')} WHERE company_id=? AND id IN (?) AND deleted_at IS NULL`, [...params, c.companyId, part.map((r) => r.id)]);
  };
  for (const parked of [true, false]) for (let i = 0; i < assignments.length; i += 200) await write(assignments.slice(i, i + 200), parked, i);
  return { moved, reordered, refresh: [...refresh] };
}

/** Make space after an anchor for repeated one-click copies. */
export async function spaceAfterLine(db, companyId, bomId, rows, index) {
  const ids = rows.map((l) => l.id);
  const floor = Math.min(0, ...rows.map((l) => Number(l.line_no))) - rows.length - 1;
  for (const parked of [true, false]) for (let offset = 0; offset < rows.length; offset += 200) {
    const part = rows.slice(offset, offset + 200), params = [];
    const cases = part.map((r, i) => { params.push(r.id, parked ? floor - offset - i : (offset + i + 1) * 10); return 'WHEN ? THEN ?'; });
    await db.query(`UPDATE cf_bom_lines SET line_no=CASE id ${cases.join(' ')} ELSE line_no END WHERE company_id=? AND bom_id=? AND id IN (?) AND deleted_at IS NULL`, [...params, companyId, bomId, part.map((r) => r.id)]);
  }
  return (ids.indexOf(rows[index].id) + 1) * 10 + 5;
}
