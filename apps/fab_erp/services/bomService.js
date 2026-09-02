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
            b.default_flow_id AS defaultFlowId, f.name AS defaultFlowName,
            c.code AS childCode, c.name AS childName, c.unit AS childUnit,
            c.category_id AS childCategoryId
       FROM fab_item_bom b
       JOIN fab_item_catalog c ON c.id = b.child_item_id AND c.deleted_at IS NULL
       LEFT JOIN fab_operation_flows f ON f.id = b.default_flow_id AND f.deleted_at IS NULL
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
            b.default_flow_id AS defaultFlowId,
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
 * @returns {Promise<{root, nodes:number, byName:Record<string,number>}>}
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

  const byName = {};
  let nodes = 0;

  /**
   * `ordinal` is this node's 1-based position among its siblings, which is what
   * `perInstance` indexes and what the code segment numbers. G1's segments and
   * G2's segments differ by nothing else.
   */
  /**
   * Add whatever `itemId` contains to `target`.
   *
   * Separate from node creation so a COLLAPSED level can call it with the same
   * target — see below.
   */
  const addChildren = (target, itemId, code, depth, ancestry) => {
    if (depth >= MAX_DEPTH) return;

    for (const line of byParent.get(Number(itemId)) ?? []) {
      let qty = line.qtyNum != null ? Number(line.qtyNum) : Number(params[line.qtyParam] ?? line.defaultQty ?? 0);

      // Per-instance override: this parent's ordinal picks its own count.
      if (Number(line.perInstanceQty) && line.qtyParam) {
        const per = opts.perInstance?.[line.qtyParam];
        const mine = Array.isArray(per) ? per[ancestry.ordinal - 1] : undefined;
        if (mine != null && Number.isFinite(Number(mine))) qty = Number(mine);
      }

      /**
       * A QUANTITY OF ZERO COLLAPSES THE LEVEL AND HOISTS WHAT IT CONTAINED.
       *
       * Not "skips it". A PEB has no girders, but it still has parts — they
       * hang off the span instead of off a segment. Three girders cut in one
       * piece have no segments, but each girder still has its seven parts.
       *
       * This is the BOQ format's own rule, stated in boqSheetService's header:
       * "Blank intermediate levels collapse: a PEB with no girders or segments
       * is just Span + Part". The old wizard implemented it as two branches —
       * `if (!girders)` and "girders but no segments, the girder is the
       * assembly" — and I wrongly took those for special cases that would
       * disappear. They are not special cases; they are this rule, written out
       * twice for the only two depths a four-level loop could reach.
       *
       * Recursing with the SAME `target` and the SAME `code` is what hoists:
       * the skipped level contributes no node and no code segment, so a PEB's
       * part is SPANA-TF exactly as it was before.
       *
       * Caught by scripts/compare-wizard.mjs, which is the entire reason that
       * script exists — the normal cases matched and these two did not.
       */
      if (!Number.isFinite(qty) || qty <= 0) {
        addChildren(target, line.childItemId, code, depth + 1, ancestry);
        continue;
      }

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
         *
         * THE INDEX GOES BEFORE THE SLASH, NOT AFTER IT.
         *
         * A '/' suffix is what routes an item to a different flow: '/D' means
         * drilled. The flow now comes from the BOM line, but the suffix is
         * EXACTLY. Appending the index blindly turned 'BS/D' at qty 2 into
         * 'BS/D1', whose suffix reads '/D1', which no rule names — so the
         * drilled part was silently given the PLAIN flow and never drilled.
         * Numbering the part rather than the variant ('BS1/D', 'BS2/D') keeps
         * the suffix intact and still tells the two apart.
         *
         * This never bit the old data only because every drilled line there
         * happened to be qty 1.
         */
        const numbered = (segment) => {
          const slash = segment.indexOf('/');
          return slash === -1
            ? `${segment}${i}`
            : `${segment.slice(0, slash)}${i}${segment.slice(slash)}`;
        };
        const seg = line.codeSegment != null
          ? (qty === 1 ? line.codeSegment : numbered(line.codeSegment))
          : String(i);
        const childCode = `${code}-${seg}`;

        nodes++;
        byName[line.childName] = (byName[line.childName] ?? 0) + 1;
        /**
         * THE FLOW COMES FROM THE LINE, not from the child type.
         *
         * The line is the item IN CONTEXT of its parent, which is the whole
         * reason this replaced `fab_flow_rules`: a Top Flange inside a Girder
         * Segment can be made differently from a Top Flange inside a PEB
         * member, and a rule keyed on the type alone could never say so.
         */
        const child = {
          catalogItemId: line.childItemId,
          name: line.childName,
          code: childCode,
          defaultFlowId: line.defaultFlowId ?? null,
          children: [],
        };
        target.children.push(child);
        addChildren(child, line.childItemId, childCode, depth + 1, { ordinal: i });
      }
    }
  };

  nodes++;
  byName[root.name] = (byName[root.name] ?? 0) + 1;
  // The root hangs off no BOM line, so it has no default flow. In practice it
  // is the line's top assembly and carries no work of its own anyway.
  const tree = {
    catalogItemId: Number(root.id), name: root.name, code: root.code,
    defaultFlowId: null, children: [],
  };
  addChildren(tree, Number(root.id), root.code, 0, { ordinal: 1 });
  return { root: tree, nodes, byName };
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
      // Null is a real answer, not "unset": a grouping level carries no flow.
      line.defaultFlowId == null || line.defaultFlowId === '' ? null : Number(line.defaultFlowId),
    ];

    if (id) {
      await conn.query(
        `UPDATE fab_item_bom
            SET parent_item_id=?, child_item_id=?, qty_num=?, qty_param=?, default_qty=?,
                per_instance_qty=?, code_segment=?, help_text=?, sort_order=?, default_flow_id=?
          WHERE id=? AND company_id=?`,
        [...cols.slice(1), id, companyId],
      );
    } else {
      await conn.query(
        `INSERT INTO fab_item_bom
           (company_id, parent_item_id, child_item_id, qty_num, qty_param, default_qty,
            per_instance_qty, code_segment, help_text, sort_order, default_flow_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
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
 *   - a child's ROLE comes from `node_kind`, not from "has a catalog id", or
 *     every girder here would be classified as raw material for its span and
 *     gated on as steel waiting to arrive (H1)
 *   - `procurement_type` is written explicitly as 'make', because
 *     procurementService treats a null one as make-by-absence and would
 *     otherwise mirror the catalog row and could flip these to BUY (H2)
 *
 * @returns {Promise<{created:number, rootItemId:number, byDepth:Record<number,number>}>}
 */
export async function instantiate(companyId, spec, existingConn = null) {
  const conn = existingConn ?? await pool.getConnection();
  const owned = !existingConn;
  try {
    if (owned) await conn.beginTransaction();
    const {
      orderId, orderLineId = null, rootItemId,
      params = {}, perInstance = {}, codePrefix = null, replace = false,
    } = spec;

    /**
     * BUILDING TWICE MUST NOT BUILD TWICE.
     *
     * This appends. Nothing stopped a second run, so pressing the structure
     * wizard again gave a line two spans, two sets of girders and two of
     * everything below — silently, because every code is prefixed by the line
     * and the duplicates look like ordinary rows. It never came up while the
     * only caller was a dialog nothing mounted; it is the first thing that
     * happens once the button is real.
     *
     * So: refuse when the line already has a structure, and say how much, unless
     * the caller has explicitly asked to replace it.
     *
     * Scoped to the LINE, not the order. An order with three lines is three
     * structures, and rebuilding one must not take the others with it.
     */
    const lineScope = orderLineId == null
      ? { sql: 'AND order_line_id IS NULL', args: [] }
      : { sql: 'AND order_line_id = ?', args: [orderLineId] };

    const [[already]] = await conn.query(
      `SELECT COUNT(*) AS n FROM fab_items
        WHERE company_id = ? AND order_id = ? ${lineScope.sql} AND deleted_at IS NULL`,
      [companyId, orderId, ...lineScope.args],
    );

    if (already.n > 0) {
      if (!replace) {
        const e = new Error(
          `This line already has ${already.n} item(s). Building again would add a second copy `
          + 'of everything — replace the existing structure, or pick a different line.',
        );
        e.status = 409;
        e.code = 'ALREADY_BUILT';
        e.existing = already.n;
        throw e;
      }

      /**
       * Replacing throws away the item tree, so it may not throw away history.
       * The same rule the BOQ import already applies, at line granularity.
       */
      const [[worked]] = await conn.query(
        `SELECT COUNT(*) AS n FROM fab_project_tasks t
           JOIN fab_items i ON i.id = t.item_id AND i.company_id = t.company_id
          WHERE t.company_id = ? AND t.order_id = ? ${lineScope.sql.replace('order_line_id', 'i.order_line_id')}
            AND i.deleted_at IS NULL AND t.deleted_at IS NULL
            AND (t.started_at IS NOT NULL OR t.status IN ('in_progress','paused','done'))`,
        [companyId, orderId, ...lineScope.args],
      );
      if (worked.n > 0) {
        const e = new Error(
          `Replace refused: ${worked.n} task(s) on this line have already been started or finished. `
          + 'Rebuilding the structure would throw that shop-floor history away.',
        );
        e.status = 409;
        e.code = 'WORK_STARTED';
        throw e;
      }

      const [ids] = await conn.query(
        `SELECT id FROM fab_items
          WHERE company_id = ? AND order_id = ? ${lineScope.sql} AND deleted_at IS NULL`,
        [companyId, orderId, ...lineScope.args],
      );
      const itemIds = ids.map((r) => r.id);
      if (itemIds.length) {
        await conn.query(
          `UPDATE fab_task_inputs SET deleted_at = NOW()
            WHERE company_id = ? AND task_id IN (
              SELECT id FROM (SELECT id FROM fab_project_tasks
                WHERE company_id = ? AND item_id IN (?) AND deleted_at IS NULL) x
            ) AND deleted_at IS NULL`,
          [companyId, companyId, itemIds],
        );
        await conn.query(
          `UPDATE fab_project_tasks SET deleted_at = NOW()
            WHERE company_id = ? AND item_id IN (?) AND deleted_at IS NULL`,
          [companyId, itemIds],
        );
        await conn.query(
          `UPDATE fab_items SET deleted_at = NOW()
            WHERE company_id = ? AND id IN (?) AND deleted_at IS NULL`,
          [companyId, itemIds],
        );
      }
    }

    const tree = await expand(companyId, rootItemId, params, { perInstance, conn });

    const [kinds] = await conn.query(
      `SELECT id, unit FROM fab_item_catalog
        WHERE company_id = ? AND deleted_at IS NULL`,
      [companyId],
    );
    const kindOf = new Map(kinds.map((k) => [Number(k.id), k]));

    const byDepth = {};
    let created = 0;

    /** Depth-first, parents before children, because a child needs its id. */
    const write = async (node, parentItemId, prefix, depth) => {
      const meta = kindOf.get(Number(node.catalogItemId)) ?? {};
      /**
       * EVERYTHING A TEMPLATE BUILDS IS STRUCTURE.
       *
       * A material link is a different thing entirely — it is created by
       * `itemMaterialService` as a child of a part once nesting decides which
       * plate that part is cut from, and it is what gates the task on steel
       * arriving. A template that produced material rows would have every
       * girder waiting on a delivery that is never coming.
       */
      const isLeaf = node.children.length === 0 ? 1 : 0;
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
        // The FLOW comes from the BOM LINE this node was expanded from — see
        // `expand`. Nothing here parses a code, and nothing consults a rules
        // table; `fab_flow_rules` is gone.
        `INSERT INTO fab_items
           (company_id, order_id, order_line_id, parent_item_id, catalog_item_id,
            name, unit, qty, code, node_kind, depth, is_leaf, procurement_type, flow_id)
         VALUES (?,?,?,?,?,?,?,1,?,'structure',?,?,'make',?)`,
        [
          companyId, orderId, orderLineId, parentItemId, node.catalogItemId,
          node.name, meta.unit ?? 'nos', code, depth, isLeaf, node.defaultFlowId ?? null,
        ],
      );
      created++;
      byDepth[depth] = (byDepth[depth] ?? 0) + 1;

      for (const child of node.children) await write(child, r.insertId, prefix, depth + 1);
      return r.insertId;
    };

    const rootId = await write(tree.root, null, codePrefix, 0);

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
    return { created, rootItemId: rootId, byDepth };
  } catch (err) {
    if (owned) await conn.rollback();
    throw err;
  } finally {
    if (owned) conn.release();
  }
}
