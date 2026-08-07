/**
 * itemCodeService.js — generated identity codes for an order's item tree.
 *
 *   <CUSTOMER>-<ORDER NUMBER>-<ABBR>-<ABBR>-…
 *   BRDG-SO-20260722-0001-GRDRA-TOPFLNG-PLT20
 *
 * The code names the row's position in the job: who it is for, which order, and
 * the chain of assemblies down to the part. It is the long code for drawings and
 * paperwork — `fab_items.mark` stays the short thing painted on the steel.
 *
 * TWO RULES, both from how these get used:
 *
 *  1. **Frozen once issued.** Generation only fills blanks. A code that exists
 *     is already on a drawing, so renaming the item must not move it. Same rule
 *     as piece marks, and for the same reason.
 *
 *  2. **An abbreviation is never repeated down a chain.** "Girder A > Girder A
 *     Web" would otherwise read GRDRA-GRDRAWEB, restating its parent. Any
 *     segment whose abbreviation already appears among its ancestors is
 *     dropped, which is what keeps a six-level code readable.
 *
 * Two different items can still abbreviate identically (two "Top Flange" rows
 * under differently-named parents collide only if those parents were skipped by
 * rule 2). The final code is uniquified with a numeric suffix rather than
 * allowing a clash — a code that names two pieces is worse than an ugly one.
 */

import { pool } from '../../../db.js';

/** Company-form words that carry no identity — dropped when other words exist. */
const STOPWORDS = new Set(['CO', 'LTD', 'LIMITED', 'PVT', 'PRIVATE', 'INC', 'LLP', 'LLC', 'THE', 'AND', 'OF', 'FOR']);

const MAX_SEGMENT = 10;
const MAX_CODE    = 160;

/**
 * Squeeze one word. Short words are kept whole — "Web" must not become "WB",
 * because the reader has to recognise it at a glance. Longer ones keep their
 * first letter and drop interior vowels, which is how fabricators already
 * shorten these by hand.
 */
function shortenWord(w) {
  if (w.length <= 4) return w;
  const rest = w.slice(1).replace(/[AEIOU]/g, '');
  return (w[0] + rest).slice(0, 4);
}

function abbreviateToken(tok) {
  if (/^\d+$/.test(tok)) return tok;              // "20" stays "20" — sizes matter
  const m = /^([A-Z]+)(\d+)$/.exec(tok);          // "E350" -> "E" + "350"
  if (m) return shortenWord(m[1]) + m[2];
  return shortenWord(tok);
}

/** "Top Flange" -> "TOPFLNG", "Plate 20 cut" -> "PLT20CUT". */
export function abbreviate(name, maxLen = MAX_SEGMENT) {
  const all = String(name ?? '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  if (!all.length) return 'X';
  // Stopwords only get dropped when something else survives, so a customer
  // literally called "The Co" still produces a code.
  const kept = all.filter((t) => !STOPWORDS.has(t));
  const tokens = kept.length ? kept : all;
  return tokens.map(abbreviateToken).join('').slice(0, maxLen) || 'X';
}

/** Customer prefix — the first meaningful word only, so it stays scannable. */
export function customerAbbrev(name) {
  const all = String(name ?? '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  const kept = all.filter((t) => !STOPWORDS.has(t));
  const first = (kept.length ? kept : all)[0];
  return first ? abbreviateToken(first).slice(0, 4) : 'CUST';
}

/**
 * Fill in `code` for every row of one order that does not have one yet.
 *
 * @param {number} companyId
 * @param {number} orderId
 * @param {import('mysql2/promise').Connection} [conn] join an open transaction
 * @returns {Promise<{coded:number, skipped:number, alreadyCoded:number}>}
 */
export async function generateOrderItemCodes(companyId, orderId, conn) {
  const exec = conn ?? pool;

  const [[order]] = await exec.query(
    `SELECT o.order_number, o.customer_name, c.name AS customer_master_name
       FROM fab_orders o
       LEFT JOIN fab_customers c ON c.id = o.customer_id AND c.deleted_at IS NULL
      WHERE o.id = ? AND o.company_id = ? AND o.deleted_at IS NULL`,
    [orderId, companyId],
  );
  if (!order) throw new Error('Order not found');

  // fab_customers.code is a serial ('CUST-0001'), which identifies nothing to a
  // reader, so the prefix comes from the customer's NAME. The master record wins
  // over the order's free-text copy when both exist.
  const custPart  = customerAbbrev(order.customer_master_name || order.customer_name);
  const orderPart = String(order.order_number ?? '').toUpperCase().replace(/[^A-Z0-9-]+/g, '') || `ORD${orderId}`;
  const prefix    = `${custPart}-${orderPart}`;

  const [rows] = await exec.query(
    `SELECT id, parent_item_id, name, code FROM fab_items
      WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL
      ORDER BY id`,
    [companyId, orderId],
  );
  if (!rows.length) return { coded: 0, skipped: 0, alreadyCoded: 0 };

  const byId = new Map(rows.map((r) => [r.id, r]));

  // Every code live in the company — a new one must not collide with an order
  // that was coded months ago, and the unique index would reject it anyway.
  const [taken] = await exec.query(
    'SELECT code FROM fab_items WHERE company_id = ? AND code IS NOT NULL AND deleted_at IS NULL',
    [companyId],
  );
  const used = new Set(taken.map((t) => t.code));

  /** Root-first list of abbreviations, with repeats of an ancestor dropped. */
  function chainFor(item) {
    const names = [];
    let cur = item;
    const guard = new Set();
    while (cur && !guard.has(cur.id)) {
      guard.add(cur.id);
      names.unshift(cur.name);
      cur = cur.parent_item_id != null ? byId.get(cur.parent_item_id) : null;
    }
    const out = [];
    const seen = new Set();
    for (const n of names) {
      const a = abbreviate(n);
      if (seen.has(a)) continue; // rule 2 — never restate an ancestor
      seen.add(a);
      out.push(a);
    }
    return out;
  }

  let coded = 0;
  let alreadyCoded = 0;
  let skipped = 0;

  for (const item of rows) {
    if (item.code) { alreadyCoded++; continue; }

    const base = [prefix, ...chainFor(item)].join('-').slice(0, MAX_CODE);
    let candidate = base;
    let n = 1;
    // Suffix until free. Trimmed from the base so the result never overruns the
    // column — truncating after appending would drop the very digits that make
    // it unique.
    while (used.has(candidate)) {
      n++;
      const suffix = `-${n}`;
      candidate = `${base.slice(0, MAX_CODE - suffix.length)}${suffix}`;
      if (n > 9999) break;
    }
    if (used.has(candidate)) { skipped++; continue; }

    await exec.query(
      'UPDATE fab_items SET code = ? WHERE id = ? AND company_id = ? AND code IS NULL',
      [candidate, item.id, companyId],
    );
    used.add(candidate);
    item.code = candidate;
    coded++;
  }

  return { coded, skipped, alreadyCoded };
}
