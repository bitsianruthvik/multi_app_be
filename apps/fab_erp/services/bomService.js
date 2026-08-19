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

/**
 * Create the order's items from a template. COPY ON FORMATION.
 *
 * The instance is a copy, not a live reference. A template edit next month must
 * not silently redefine a span somebody already promised a customer — and the
 * wizard lets you deviate from the template anyway, so a live reference could
 * never have described what was actually being built.
 *
 * INSTANCES ARE NOT CATALOGUED. Each row points AT its catalog item via
 * `catalog_item_id`; it does not become one. Thirty top flanges are thirty
 * fab_items rows and one catalog row.
 *
 * `catalog_item_id` on a made item is constraint C2 coming true. Two things had
 * to be right first, and both now are:
 *
 *   - a child's ROLE comes from `level_kind`, not from "has a catalog id", or
 *     every girder here would be classified as raw material for its span and
 *     gated on as steel waiting to arrive (H1)
 *   - `procurement_type` is written explicitly as 'make', because
 *     procurementService treats a null one as make-by-absence and would
 *     otherwise mirror the catalog row and could flip these to BUY (H2)
 *
 * @returns {Promise<{created:number, rootItemId:number, byLevel:Record<string,number>}>}
 */
export async function instantiate(companyId, spec, existingConn = null) {
  const conn = existingConn ?? await pool.getConnection();
  const owned = !existingConn;
  try {
    if (owned) await conn.beginTransaction();
    const {
      orderId, orderLineId = null, rootItemId,
      params = {}, perInstance = {}, codePrefix = null,
    } = spec;

    const tree = await expand(companyId, rootItemId, params, { perInstance, conn });

    // level_kind per catalog item, so an instance can say what it IS.
    const [kinds] = await conn.query(
      `SELECT id, level_kind AS levelKind, unit FROM fab_item_catalog
        WHERE company_id = ? AND deleted_at IS NULL`,
      [companyId],
    );
    const kindOf = new Map(kinds.map((k) => [Number(k.id), k]));

    const byLevel = {};
    let created = 0;

    /** Depth-first, parents before children, because a child needs its id. */
    const write = async (node, parentItemId, prefix) => {
      const meta = kindOf.get(Number(node.catalogItemId)) ?? {};
      // Never 'material'. A structural level is not the material link.
      const levelKind = meta.levelKind && meta.levelKind !== 'material' ? meta.levelKind : 'part';
      /**
       * The template's code is relative to its ROOT; the order's prefix makes
       * it absolute.
       *
       * Strip the whole root code, not its first segment. The root's own code
       * is `COMPOS-SPAN` — two segments — so slicing one left `SPAN` embedded
       * in every descendant and produced `TST-SPAN-G1-1-TF` where the real
       * order says `…-G1-1-TF`.
       */
      const rel = node.code.slice(tree.root.code.length).replace(/^-/, '');
      const code = prefix ? (rel ? `${prefix}-${rel}` : prefix) : node.code;

      const [r] = await conn.query(
        `INSERT INTO fab_items
           (company_id, order_id, order_line_id, parent_item_id, catalog_item_id,
            name, unit, qty, code, level_kind, procurement_type)
         VALUES (?,?,?,?,?,?,?,1,?,?,'make')`,
        [
          companyId, orderId, orderLineId, parentItemId, node.catalogItemId,
          node.name, meta.unit ?? 'nos', code, levelKind,
        ],
      );
      created++;
      byLevel[levelKind] = (byLevel[levelKind] ?? 0) + 1;

      for (const child of node.children) await write(child, r.insertId, prefix);
      return r.insertId;
    };

    const rootId = await write(tree.root, null, codePrefix);

    // Remember what it was built from, and when the copy was taken. Recomputing
    // this later would give the template's CURRENT shape, which is exactly the
    // thing that must not move under a confirmed order.
    if (orderLineId) {
      await conn.query(
        `UPDATE fab_order_lines
            SET template_item_id = ?, template_params = ?, template_snapshot_at = NOW()
          WHERE id = ? AND company_id = ?`,
        [rootItemId, JSON.stringify({ params, perInstance }), orderLineId, companyId],
      );
    }

    if (owned) await conn.commit();
    return { created, rootItemId: rootId, byLevel };
  } catch (err) {
    if (owned) await conn.rollback();
    throw err;
  } finally {
    if (owned) conn.release();
  }
}
