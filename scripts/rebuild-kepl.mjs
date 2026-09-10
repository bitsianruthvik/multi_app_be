/**
 * rebuild-kepl.mjs — the KEPL ROB60 order, rebuilt the new way.
 *
 * ── WHY ──────────────────────────────────────────────────────────────────────
 *
 * Nesting cannot be tested without an order that has dimensions, and no live
 * order has any. The KEPL order does — 1,062 sized parts — but it was built the
 * old way (1,170 rows, one per piece) and retired, so its rows are soft-deleted.
 * Only its field values survive.
 *
 * So its shape and its sizes are read out of that history and rebuilt through
 * the current path: pick the item, take the BOM, set the quantities, split what
 * needs splitting, fill in the sizes. Real numbers, current workflow.
 *
 * ── WHAT KEPL ACTUALLY WAS ───────────────────────────────────────────────────
 *
 *   2 spans, 4 girders each, 5 segments per girder      = 40 segments
 *   45 intermediate diaphragms and 6 end diaphragms per span
 *   16 splices per span, 7,212 shear studs per span
 *
 * THE SEGMENTS ARE NOT ALL THE SAME LENGTH. 23 are 12,000 long and 15 are
 * 11,650 — the end segments of each girder are shorter. One row cannot say
 * that, so the Segment row is COPIED: three at 12,000 and two at 11,650 per
 * girder, which is 12 and 8 per span and matches the history.
 *
 * That split is the whole argument for copy-with-subtree, and this is the first
 * real thing to use it.
 *
 * ── THE STIFFENERS ───────────────────────────────────────────────────────────
 *
 * Four part names carry two widths in the history — 200 and 210 — which does
 * not follow segment length and looks like drawing revisions rather than
 * design. The commonest is taken and the other noted, rather than inventing a
 * structure to hold a difference nobody has explained.
 *
 *   node scripts/rebuild-kepl.mjs            # dry run
 *   node scripts/rebuild-kepl.mjs --apply
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const env = {};
fs.readFileSync(path.join(__dir, '..', '..', '.env.tidb'), 'utf8').split('\n').forEach((l) => {
  l = l.trim(); if (!l || l.startsWith('#')) return;
  const [k, ...r] = l.split('='); env[k.trim()] = r.join('=').trim();
});
Object.assign(process.env, {
  DB_HOST: env.DB_HOST, DB_PORT: env.DB_PORT ?? '4000', DB_USER: env.DB_USER,
  DB_PASSWORD: env.DB_PASSWORD, DB_NAME: env.DB_NAME, DB_SSL: 'true',
});
const { pool } = await import('../db.js');
const { draftTree, buildFromTree } = await import('../apps/fab_erp/services/bomService.js');

const APPLY = process.argv.includes('--apply');
const COMPANY = 30005;

/** Sizes read out of the retired order, commonest first. */
const SIZES = JSON.parse(fs.readFileSync(path.join(__dir, '_kepl-sizes.json'), 'utf8'));
const sizeOf = (name, wantLength = null) => {
  const options = SIZES[name];
  if (!options?.length) return null;
  if (wantLength != null) {
    const hit = options.find((o) => o.size[2] === wantLength || o.size[1] === wantLength);
    if (hit) return hit.size;
  }
  return options[0].size;
};
/*
 * DRILLED AND PLAIN ARE THE SAME PLATE.
 *
 * A "Hole" stiffener is a plain one that later goes to the drill — same steel,
 * same rectangle, one extra operation. The history disagreed on one pair:
 * Intermediate Stiffener Plain came out 170 wide and Hole 178, which is a
 * typo's shape rather than a design's, and it matters more than it looks:
 * nesting groups by size, so 170 and 178 would be cut as two different blanks
 * off two different plates for what is one part.
 *
 * So a Hole takes its Plain twin's size wherever there is one.
 */
const twinOf = (name) => (/\bHole\b/.test(name) ? name.replace(/\bHole\b/, 'Plain') : null);

const dimsFor = (name, wantLength = null) => {
  const twin = twinOf(name);
  const s = (twin && SIZES[twin] ? sizeOf(twin, wantLength) : null) ?? sizeOf(name, wantLength);
  return s ? { thickness_mm: s[0], width_mm: s[1], length_mm: s[2] } : {};
};

/** KEPL's own numbers, per span. */
const PER_SPAN = {
  lines: 4,
  segmentsLong: 3,     // 12,000 — three per girder
  segmentsShort: 2,    // 11,650 — two per girder
  endDiaphragms: 6,
  intermDiaphragms: 45,
  splices: 16,
  shearStuds: 7212,
};
const LONG = 12000;
const SHORT = 11650;

const walk = (n, fn) => { fn(n); (n.children ?? []).forEach((k) => walk(k, fn)); };
const clone = (n) => JSON.parse(JSON.stringify(n));

const conn = await pool.getConnection();
try {
  if (APPLY) await conn.beginTransaction();

  const [[cust]] = await conn.query(
    `SELECT id, name FROM fab_customers WHERE company_id = ? AND name LIKE 'Kalpataru%' AND deleted_at IS NULL LIMIT 1`,
    [COMPANY],
  );
  const [[span]] = await conn.query(
    `SELECT id, name FROM fab_item_catalog WHERE company_id = ? AND code = 'COMPOS-SPAN' AND deleted_at IS NULL`,
    [COMPANY],
  );
  if (!span) throw new Error('No COMPOS-SPAN in the catalogue.');

  // ── the order ─────────────────────────────────────────────────────────────
  const [[{ ymd }]] = await conn.query("SELECT DATE_FORMAT(UTC_DATE(), '%Y%m%d') AS ymd");
  const [[seq]] = await conn.query(
    `SELECT COUNT(*) AS n FROM fab_orders WHERE company_id = ? AND order_type = 'sales'`, [COMPANY]);
  const orderNumber = `SO-${ymd}-${String(Number(seq.n) + 1).padStart(4, '0')}`;

  console.log(`ORDER  ${orderNumber}  for ${cust?.name ?? '(no customer found)'}`);
  console.log(`  2 line(s), each "${span.name}"\n`);

  let orderId = 0;
  if (APPLY) {
    const [ins] = await conn.query(
      `INSERT INTO fab_orders
         (company_id, order_number, order_type, status, customer_id, required_date, notes, created_at)
       VALUES (?,?,'sales','draft',?,DATE_ADD(UTC_DATE(), INTERVAL 90 DAY),?,NOW())`,
      [COMPANY, orderNumber, cust?.id ?? null,
        'KEPL ROB60 rebuilt through the BOM workflow — real sizes from the retired order.'],
    );
    orderId = ins.insertId;
  }

  // ── the two lines, and the tree under each ────────────────────────────────
  for (let n = 1; n <= 2; n += 1) {
    let lineId = 0;
    if (APPLY) {
      const [l] = await conn.query(
        `INSERT INTO fab_order_lines
           (company_id, order_id, line_no, description, qty, catalog_item_id, template_item_id, line_type, created_at)
         VALUES (?,?,?,?,?,?,?,?,NOW())`,
        [COMPANY, orderId, n, span.name, 1, span.id, span.id, 'Composite Girder'],
      );
      lineId = l.insertId;
      // The steel, stated once for everything under the line.
      const [fields] = await conn.query(
        `SELECT id, field_key FROM fab_fields
          WHERE company_id = ? AND deleted_at IS NULL AND field_key IN ('material','grade')`, [COMPANY]);
      for (const f of fields) {
        await conn.query(
          `INSERT INTO fab_field_values (company_id, field_id, scope, scope_id, value_text, created_at)
           VALUES (?,?,'order_line',?,?,NOW())
           ON DUPLICATE KEY UPDATE value_text = VALUES(value_text), deleted_at = NULL`,
          [COMPANY, f.id, lineId, f.field_key === 'material' ? 'MS' : 'E350 BO'],
        );
      }
    }

    // The recipe, then KEPL's answers on top of it.
    const tree = await draftTree(COMPANY, span.id, conn);

    const kid = (name) => tree.children.find((k) => k.name === name);
    kid('Line').qty = PER_SPAN.lines;
    kid('End Diaphragm').qty = PER_SPAN.endDiaphragms;
    kid('Intermediate Diaphragm').qty = PER_SPAN.intermDiaphragms;
    kid('Splice').qty = PER_SPAN.splices;
    kid('Shear Stud 25 dia x 175 (headed)').qty = PER_SPAN.shearStuds;

    /*
     * THE SEGMENT SPLITS IN TWO. Three long and two short per girder — one row
     * cannot hold two lengths, and this is exactly the case copy-with-subtree
     * exists for.
     */
    const line = kid('Line');
    const segment = line.children.find((k) => k.name === 'Segment');
    const long = segment;
    const short = clone(segment);
    long.qty = PER_SPAN.segmentsLong;
    short.qty = PER_SPAN.segmentsShort;
    short.name = 'Segment';
    let key = 0;
    walk(short, (x) => { x.key = `short${++key}`; });
    line.children = [long, short];

    // Sizes: the three that follow the segment take its length, the rest their own.
    const FOLLOWS_SEGMENT = new Set(['Top Flange', 'Web Plate', 'Bottom Flange']);
    for (const [seg, len] of [[long, LONG], [short, SHORT]]) {
      for (const part of seg.children) {
        part.dims = dimsFor(part.name, FOLLOWS_SEGMENT.has(part.name) ? len : null);
      }
    }
    // Everything outside a segment.
    walk(tree, (x) => {
      if ((x.children ?? []).length) return;
      if (x.dims && Object.keys(x.dims).length) return;
      x.dims = dimsFor(x.name);
    });

    const sized = [];
    walk(tree, (x) => { if (!(x.children ?? []).length) sized.push([x.name, x.dims]); });
    if (n === 1) {
      console.log('  THE TREE, per span:');
      console.log(`    Span x1`);
      for (const k of tree.children) {
        console.log(`      ${k.name.padEnd(32)} x${k.qty}`);
        for (const g of k.children ?? []) {
          const l = g.dims?.length_mm ? '' : ` (${g.qty === PER_SPAN.segmentsLong ? LONG : SHORT} long)`;
          console.log(`        ${g.name.padEnd(30)} x${g.qty}${l}`);
        }
      }
      for (const [seg, label] of [[long, '12000'], [short, '11650']]) {
        console.log(`\n  SEGMENT x${seg.qty} (${label} girder):`);
        for (const part of seg.children) {
          const d = part.dims ?? {};
          console.log(`    ${part.name.padEnd(30)} x${part.qty}  ${d.thickness_mm ?? '?'} x ${d.width_mm ?? '?'} x ${d.length_mm ?? '?'}`);
        }
      }
      console.log(`\n  ${sized.filter(([, d]) => d && d.thickness_mm).length} of ${sized.length} leaves sized`);
      const missing = sized.filter(([, d]) => !d || !d.thickness_mm).map(([nm]) => nm);
      if (missing.length) console.log(`  no size found for: ${[...new Set(missing)].join(', ')}`);
    }

    if (APPLY) {
      const res = await buildFromTree(COMPANY, { orderId, orderLineId: lineId, tree }, conn);
      console.log(`  line ${n}: ${res.created} rows, ${res.sized ?? 0} size values`);
    }
  }

  if (APPLY) { await conn.commit(); console.log(`\nCommitted. Order id ${orderId}.`); }
  else console.log('\nDRY RUN — nothing was written. Re-run with --apply.');
} catch (err) {
  if (APPLY) await conn.rollback();
  throw err;
} finally {
  conn.release();
  await pool.end();
}
