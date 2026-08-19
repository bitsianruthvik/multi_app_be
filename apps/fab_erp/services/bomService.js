/**
 * bomService.js — what a catalog item is made of, and how that becomes an order.
 *
 * Step 5 of FAB_ERP_FIELDS_REDESIGN.md. This is the generic replacement for
 * `buildWizardRows`, which is a hardcoded four-level nest with `span`,
 * `girders` and `segmentsPerGirder` written into the source and an `if
 * (!girders)` branch for a PEB.
 *
 * Here the depth is whatever the BOM has. A PEB is not a branch, it is a
 * template with no Girder line. "Girders but no segments" is not a special case,
 * it is a quantity of zero. The four-level assumption disappears rather than
 * being parameterised.
 *
 * PARAMETERS ARE DERIVED, NOT DECLARED. A line whose quantity is `qty_param`
 * contributes a question the wizard asks; the set of questions is the distinct
 * set of parameter names in the tree. A separate parameters table would be a
 * second place to keep the same fact, and it would go stale the first time
 * somebody deleted a line.
 *
 * IT EXPANDS IN MEMORY. `expand` returns a tree of what WOULD be created and
 * writes nothing. That is what lets the wizard show a person the shape before
 * anything exists, and it is why a wrong answer costs a re-run rather than a
 * half-built order.
 */

import { pool } from '../../../db.js';

/** A BOM deep enough to hit this is a cycle or a mistake, not a real structure. */
const MAX_DEPTH = 16;

/** Every line under one parent, child details included. */
export async function bomFor(companyId, parentItemId, conn = null) {
  const exec = conn ?? pool;
  const [rows] = await exec.query(
    `SELECT b.id, b.parent_item_id AS parentItemId, b.child_item_id AS childItemId,
            b.qty_num AS qtyNum, b.qty_param AS qtyParam, b.default_qty AS defaultQty,
            b.per_instance_qty AS perInstanceQty, b.code_segment AS codeSegment,
            b.help_text AS helpText, b.sort_order AS sortOrder,
            c.code AS childCode, c.name AS childName, c.unit AS childUnit,
            c.category_id AS childCategoryId
       FROM fab_item_bom b
       JOIN fab_item_catalog c ON c.id = b.child_item_id AND c.deleted_at IS NULL
      WHERE b.company_id = ? AND b.parent_item_id = ? AND b.deleted_at IS NULL AND b.active = 1
      ORDER BY b.sort_order, c.code`,
    [companyId, parentItemId],
  );
  return rows;
}

/** Every line in the company, indexed by parent — one query for a whole walk. */
async function bomIndex(companyId, conn = null) {
  const exec = conn ?? pool;
  const [rows] = await exec.query(
    `SELECT b.parent_item_id AS parentItemId, b.child_item_id AS childItemId,
            b.qty_num AS qtyNum, b.qty_param AS qtyParam, b.default_qty AS defaultQty,
            b.per_instance_qty AS perInstanceQty, b.code_segment AS codeSegment,
            b.help_text AS helpText, b.sort_order AS sortOrder,
            c.code AS childCode, c.name AS childName, c.unit AS childUnit
       FROM fab_item_bom b
       JOIN fab_item_catalog c ON c.id = b.child_item_id AND c.deleted_at IS NULL
      WHERE b.company_id = ? AND b.deleted_at IS NULL AND b.active = 1
      ORDER BY b.sort_order, c.code`,
    [companyId],
  );
  const byParent = new Map();
  for (const r of rows) {
    if (!byParent.has(r.parentItemId)) byParent.set(r.parentItemId, []);
    byParent.get(r.parentItemId).push(r);
  }
  return byParent;
}

/**
 * The questions this template asks, in the order they are met walking down.
 *
 * Order matters to a person filling the form in: "how many girders" before "how
 * many segments per girder" reads as the structure being described top-down,
 * which is how somebody thinks about a span.
 *
 * @returns {Promise<Array<{param, defaultQty, askedBy, perInstance, helpText}>>}
 */
export async function parametersFor(companyId, rootItemId, conn = null) {
  const byParent = await bomIndex(companyId, conn);
  const found = new Map();
  const seen = new Set();

  const walk = (itemId, depth) => {
    if (depth > MAX_DEPTH || seen.has(itemId)) return;
    seen.add(itemId);
    for (const line of byParent.get(itemId) ?? []) {
      if (line.qtyParam && !found.has(line.qtyParam)) {
        found.set(line.qtyParam, {
          param: line.qtyParam,
          defaultQty: line.defaultQty == null ? null : Number(line.defaultQty),
          askedBy: line.childName,
          perInstance: !!Number(line.perInstanceQty),
          helpText: line.helpText,
        });
      }
      walk(line.childItemId, depth + 1);
    }
  };
  walk(Number(rootItemId), 0);
  return [...found.values()];
}

/**
 * Does this BOM reference itself, directly or through anything below it?
 *
 * Checked on SAVE rather than only guarded at expansion. A depth cap turns a
 * cycle into a truncated tree, which looks like a structure somebody
 * mis-entered rather than a rule they broke — so it gets shipped and discovered
 * much later.
 *
 * @returns {Promise<string[]>} the path forming the cycle, empty when clean
 */
export async function findCycle(companyId, parentItemId, childItemId, conn = null) {
  const byParent = await bomIndex(companyId, conn);
  const target = Number(parentItemId);
  const path = [];

  const walk = (itemId, depth) => {
    if (depth > MAX_DEPTH) return false;
    if (Number(itemId) === target) return true;
    for (const line of byParent.get(Number(itemId)) ?? []) {
      path.push(line.childName ?? line.childItemId);
      if (walk(line.childItemId, depth + 1)) return true;
      path.pop();
    }
    return false;
  };

  // Adding parent -> child is a cycle when the child can already reach the
  // parent. Asked before the row exists, so it prevents rather than reports.
  return walk(Number(childItemId), 0) ? path : [];
}

/**
 * Expand a template into the tree it would produce. WRITES NOTHING.
 *
 * @param {Record<string, number>} params  parameter name -> quantity
 * @param {object} [opts]
 * @param {Record<string, number[]>} [opts.perInstance]  param -> per-instance
 *        counts, e.g. `{ segmentsPerGirder: [4,5,5,5,5,4] }` for the case the
 *        old wizard called `segmentCounts`. Short or absent falls back to the
 *        single figure, so the simple case stays one number.
 * @returns {Promise<{root, nodes:number, byLevel:Record<string,number>}>}
 */
export async function expand(companyId, rootItemId, params = {}, opts = {}) {
  const exec = opts.conn ?? pool;
  const byParent = await bomIndex(companyId, exec);

  const [[root]] = await exec.query(
    `SELECT id, code, name, unit FROM fab_item_catalog
      WHERE id = ? AND company_id = ? AND deleted_at IS NULL LIMIT 1`,
    [rootItemId, companyId],
  );
  if (!root) { const e = new Error('That template item does not exist.'); e.status = 404; throw e; }

  const byLevel = {};
  let nodes = 0;

  /**
   * `ordinal` is this node's 1-based position among its siblings, which is what
   * `perInstance` indexes and what the code segment numbers. G1's segments and
   * G2's segments differ by nothing else.
   */
  const build = (itemId, name, code, depth, ancestry) => {
    nodes++;
    byLevel[name] = (byLevel[name] ?? 0) + 1;
    const node = { catalogItemId: itemId, name, code, children: [] };
    if (depth >= MAX_DEPTH) return node;

    for (const line of byParent.get(Number(itemId)) ?? []) {
      let qty = line.qtyNum != null ? Number(line.qtyNum) : Number(params[line.qtyParam] ?? line.defaultQty ?? 0);

      // Per-instance override: this parent's ordinal picks its own count.
      if (Number(line.perInstanceQty) && line.qtyParam) {
        const per = opts.perInstance?.[line.qtyParam];
        const mine = Array.isArray(per) ? per[ancestry.ordinal - 1] : undefined;
        if (mine != null && Number.isFinite(Number(mine))) qty = Number(mine);
      }

      if (!Number.isFinite(qty) || qty <= 0) continue; // a zero collapses the level

      for (let i = 1; i <= qty; i++) {
        /**
         * How this level reads in the composed code.
         *
         *   'G' with qty 6   ->  G1 G2 G3 ...      numbered, because there are several
         *   'TF' with qty 1  ->  TF                bare, because there is only one
         *   null             ->  1 2 3 ...         which is how segments already read
         *
         * The qty-1 case is not cosmetic: a real BOQ says `...-1-TF`, not
         * `...-1-TF1`. Appending an index to a thing there is only one of reads
         * as though a second is expected, and it would not match any code
         * already in the system.
         */
        const seg = line.codeSegment != null
          ? (qty === 1 ? line.codeSegment : `${line.codeSegment}${i}`)
          : String(i);
        node.children.push(
          build(line.childItemId, line.childName, `${code}-${seg}`, depth + 1, { ordinal: i }),
        );
      }
    }
    return node;
  };

  const tree = build(Number(root.id), root.name, root.code, 0, { ordinal: 1 });
  return { root: tree, nodes, byLevel };
}

/** Flatten an expanded tree into rows, parents before children. */
export function flatten(node, parentPath = null, out = []) {
  out.push({ catalogItemId: node.catalogItemId, name: node.name, code: node.code, parentPath });
  for (const c of node.children) flatten(c, node.code, out);
  return out;
}

/**
 * Add or update one BOM line, refusing a cycle and refusing an ambiguous qty.
 */
export async function setBomLine(companyId, line, existingConn = null) {
  const conn = existingConn ?? await pool.getConnection();
  const owned = !existingConn;
  try {
    if (owned) await conn.beginTransaction();
    const { id, parentItemId, childItemId } = line;
    const hasNum = line.qtyNum != null && line.qtyNum !== '';
    const hasParam = !!(line.qtyParam && String(line.qtyParam).trim());

    // Exactly one. Both would mean two answers to "how many"; neither would
    // silently expand to zero and collapse the level with no explanation.
    if (hasNum === hasParam) {
      const e = new Error('A BOM line needs either a fixed quantity or a parameter name, not both and not neither.');
      e.status = 400;
      throw e;
    }
    if (Number(parentItemId) === Number(childItemId)) {
      const e = new Error('An item cannot contain itself.');
      e.status = 400;
      throw e;
    }
    const cycle = await findCycle(companyId, parentItemId, childItemId, conn);
    if (cycle.length) {
      const e = new Error(`That would make a loop: ${cycle.join(' -> ')} already leads back here.`);
      e.status = 400;
      throw e;
    }

    const cols = [
      companyId, parentItemId, childItemId,
      hasNum ? Number(line.qtyNum) : null,
      hasParam ? String(line.qtyParam).trim() : null,
      line.defaultQty == null || line.defaultQty === '' ? null : Number(line.defaultQty),
      line.perInstanceQty ? 1 : 0,
      line.codeSegment ?? null,
      line.helpText ?? null,
      line.sortOrder ?? 0,
    ];

    if (id) {
      await conn.query(
        `UPDATE fab_item_bom
            SET parent_item_id=?, child_item_id=?, qty_num=?, qty_param=?, default_qty=?,
                per_instance_qty=?, code_segment=?, help_text=?, sort_order=?
          WHERE id=? AND company_id=?`,
        [...cols.slice(1), id, companyId],
      );
    } else {
      await conn.query(
        `INSERT INTO fab_item_bom
           (company_id, parent_item_id, child_item_id, qty_num, qty_param, default_qty,
            per_instance_qty, code_segment, help_text, sort_order)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        cols,
      );
    }
    if (owned) await conn.commit();
    return { ok: true };
  } catch (err) {
    if (owned) await conn.rollback();
    throw err;
  } finally {
    if (owned) conn.release();
  }
}

export async function removeBomLine(companyId, id) {
  const [r] = await pool.query(
    'UPDATE fab_item_bom SET deleted_at = NOW() WHERE id = ? AND company_id = ? AND deleted_at IS NULL',
    [id, companyId],
  );
  if (!r.affectedRows) { const e = new Error('That BOM line does not exist.'); e.status = 404; throw e; }
  return { id: Number(id) };
}
