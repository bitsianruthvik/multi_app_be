/**
 * itemCodeService.js — identity codes for an order's item tree.
 *
 *   code = <parent's code> - <this row's abbreviation>
 *
 *   BRDG-SO-20260722-0001            (the order's prefix)
 *   BRDG-SO-20260722-0001-GRDA       Girder A          abbr GRDA
 *   BRDG-SO-20260722-0001-GRDA-TF1   Top Flange        abbr TF1
 *
 * The rule is plain concatenation, and that is deliberate. The way these sheets
 * actually get filled is top-down: you write a row's name and abbreviation, read
 * the code it produces, and paste that code into the next sheet as the parent of
 * its children. That only works if the code is something you can predict by
 * eye — so nothing here rewrites, compresses or de-duplicates the chain. What
 * you type is what you get.
 *
 * The abbreviation is yours to choose. `abbreviate()` only fills in when the
 * column is left blank, and the codes it produces are the ones nobody bothered
 * to name — a convenience, not the main path.
 *
 * **Frozen once issued.** Generation only ever fills blanks. By the time a code
 * exists it is on a drawing, so renaming or re-parenting the item must not move
 * it. `code` is therefore absent from `fabErpItem.writeFields`.
 *
 * The one thing that IS enforced is uniqueness: two rows that would land on the
 * same code get a `-2`, `-3` suffix. A code naming two pieces is worse than an
 * ugly one.
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

/** "Top Flange" -> "TOPFLNG". Only used when the Abbr column is left blank. */
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

/** Normalise a hand-typed abbreviation to the same shape the codes use. */
export function normaliseAbbr(raw) {
  const s = String(raw ?? '').toUpperCase().replace(/[^A-Z0-9]+/g, '').slice(0, MAX_SEGMENT);
  return s || null;
}

/**
 * The segment naming a raw material — its catalog code, kept whole.
 *
 * Squeezing it like a part name is actively harmful: 'MSP-E350BO-20' and
 * 'MSP-E350BO-16' both truncate to near-identical stubs, chopping off the
 * thickness, which is the only thing telling the two plates apart. Internal
 * dashes are kept (they read naturally and nothing ever splits a code on them)
 * and the allowance is generous — a 160-character code has the room.
 */
export function materialSegment(catalogCode, fallbackName) {
  const s = String(catalogCode ?? '').toUpperCase().replace(/[^A-Z0-9-]+/g, '').replace(/^-+|-+$/g, '');
  return s.slice(0, 24) || abbreviate(fallbackName);
}

/**
 * The `<CUSTOMER>-<ORDER NUMBER>` head every code in one order shares. This is
 * what a Level 1 row hangs off, and what the sheet shows once instead of on
 * every line.
 */
export async function orderCodePrefix(companyId, orderId, conn) {
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
  // reader, so the prefix comes from the customer's NAME.
  const cust = customerAbbrev(order.customer_master_name || order.customer_name);
  const num  = String(order.order_number ?? '').toUpperCase().replace(/[^A-Z0-9-]+/g, '') || `ORD${orderId}`;
  return `${cust}-${num}`;
}

/** `<parentCode>-<ABBR>`, trimmed to fit the column. */
export function composeCode(parentCode, abbr) {
  return `${parentCode}-${abbr}`.slice(0, MAX_CODE);
}

/**
 * Make `base` unique against `used`, appending -2, -3, … The suffix is trimmed
 * out of the base rather than added on top, so the result never overruns the
 * column — truncating afterwards would drop the very digits that make it unique.
 */
export function uniquifyCode(base, used) {
  let candidate = base.slice(0, MAX_CODE);
  let n = 1;
  while (used.has(candidate) && n <= 9999) {
    n++;
    const suffix = `-${n}`;
    candidate = `${base.slice(0, MAX_CODE - suffix.length)}${suffix}`;
  }
  return candidate;
}

/** Every code already taken in this company — the unique index enforces it too. */
export async function loadUsedCodes(companyId, conn) {
  const exec = conn ?? pool;
  const [taken] = await exec.query(
    'SELECT code FROM fab_items WHERE company_id = ? AND code IS NOT NULL AND deleted_at IS NULL',
    [companyId],
  );
  return new Set(taken.map((t) => t.code));
}

/**
 * Fill in `code` for every row of one order that does not have one — used for
 * rows added by hand in the tree, and as a backstop after an import.
 *
 * Walks parents before children so a child can always read its parent's code.
 *
 * @returns {Promise<{coded:number, skipped:number, alreadyCoded:number}>}
 */
export async function generateOrderItemCodes(companyId, orderId, conn) {
  const exec = conn ?? pool;
  const prefix = await orderCodePrefix(companyId, orderId, conn);

  const [rows] = await exec.query(
    `SELECT id, parent_item_id, name, code FROM fab_items
      WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL
      ORDER BY id`,
    [companyId, orderId],
  );
  if (!rows.length) return { coded: 0, skipped: 0, alreadyCoded: 0 };

  const byId = new Map(rows.map((r) => [r.id, r]));
  const childrenOf = new Map();
  const roots = [];
  for (const r of rows) {
    if (r.parent_item_id != null && byId.has(r.parent_item_id)) {
      if (!childrenOf.has(r.parent_item_id)) childrenOf.set(r.parent_item_id, []);
      childrenOf.get(r.parent_item_id).push(r);
    } else {
      roots.push(r);
    }
  }

  const used = await loadUsedCodes(companyId, conn);
  let coded = 0;
  let alreadyCoded = 0;
  let skipped = 0;

  // Breadth-first from the roots: a child's code needs its parent's, so the
  // parent must be resolved first. `seen` also makes a cycle terminate.
  const seen = new Set();
  const queue = roots.map((r) => ({ row: r, parentCode: prefix }));
  while (queue.length) {
    const { row, parentCode } = queue.shift();
    if (seen.has(row.id)) continue;
    seen.add(row.id);

    let myCode = row.code;
    if (myCode) {
      alreadyCoded++;
    } else {
      const candidate = uniquifyCode(composeCode(parentCode, abbreviate(row.name)), used);
      if (used.has(candidate)) { skipped++; continue; }
      await exec.query(
        'UPDATE fab_items SET code = ? WHERE id = ? AND company_id = ? AND code IS NULL',
        [candidate, row.id, companyId],
      );
      used.add(candidate);
      row.code = candidate;
      myCode = candidate;
      coded++;
    }

    for (const child of childrenOf.get(row.id) ?? []) {
      queue.push({ row: child, parentCode: myCode });
    }
  }

  return { coded, skipped, alreadyCoded };
}
