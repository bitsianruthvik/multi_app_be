/**
 * codegenService.js — generic, company-configurable code generation.
 *
 * One rule per (company_id, entity_type) in fab_codegen_rules, stored as an
 * ordered list of "segments" (segments_json). Adding a new entity type is
 * just registering a default rule below — no new tables, no new code paths.
 * Adding a new segment *kind* (beyond the ones in evaluateSegment) is the
 * only case that needs a code change, and it's isolated to this file.
 *
 * Segment shapes:
 *   { type: 'fixed', value }
 *   { type: 'category_shortform', length }   — first N chars of fab_item_categories.code
 *   { type: 'group_shortform', length }      — first N chars of fab_item_groups.code
 *   { type: 'subgroup_shortform', length }   — first N chars of fab_item_subgroups.code
 *   { type: 'date', format }                 — 'YYYY' | 'YY' | 'MM' | 'DD' | 'YYMM' | 'YYYYMM' | 'YYYYMMDD'
 *   { type: 'sequence', digits, resetPeriod } — resetPeriod: 'never' | 'yearly' | 'monthly'
 *   { type: 'free_text', value }             — fixed manual fragment, reserved for future use
 *   { type: 'attribute', field, … }          — one named value the caller passes (material, size…)
 *   { type: 'order_prefix' }                 — `<customer>-<order number>`
 *
 * Segments for things that sit in a TREE — an order's BOM rows and the tasks
 * hanging off them:
 *   { type: 'parent_code', separator, topLevel } — the parent's code, then `separator`.
 *                                               A top row has no parent; `topLevel`
 *                                               says what stands in: 'order_prefix'
 *                                               (default) or 'none'.
 *   { type: 'bom_code', length }             — the code the BOM gives this row
 *                                               (fab_item_bom.code_segment). A BOM
 *                                               line left blank means "just a number";
 *                                               a row with no BOM line is abbreviated
 *                                               from its name.
 *   { type: 'position', digits, restart }    — where the row sits in the BOM, counted
 *                                               among rows of the SAME item. restart:
 *                                               'parent' — starts at 1 under each parent;
 *                                               'above'  — carries on from the rows above,
 *                                                          across the whole order.
 *   { type: 'step_no', digits }              — a task's step number in its flow
 *   { type: 'operation_code' }               — a task's operation code
 *
 * TWO KINDS OF RULE. Most rules issue a number from a counter (generateCode).
 * Tree and blank codes are DERIVED instead (deriveCodes): the same row in the
 * same place always reads the same, so the code can be shown before it is
 * saved and never burns a number. A derived rule has no running sequence.
 */

import { pool } from '../../../db.js';
import { abbreviate, customerAbbrev } from './itemCodeService.js';

// Ensures fab_codegen_rules exists — runs once per process on first use.
// Handles the case where the deployed DB never ran init.sql migrations.
let _tableReady = false;
async function ensureTable() {
  if (_tableReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fab_codegen_rules (
      id             INT AUTO_INCREMENT PRIMARY KEY,
      company_id     INT           NOT NULL,
      entity_type    VARCHAR(50)   NOT NULL,
      segments_json  JSON          NOT NULL,
      next_seq       INT           NOT NULL DEFAULT 1,
      seq_period_key VARCHAR(20)   NULL,
      created_at     TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
      updated_at     TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_fab_codegen_rules (company_id, entity_type)
    )
  `);
  _tableReady = true;
}

const DEFAULT_SEGMENTS = {
  item: [
    { type: 'category_shortform', length: 3 },
    { type: 'fixed', value: '-' },
    { type: 'sequence', digits: 4, resetPeriod: 'never' },
  ],
  resource: [
    { type: 'fixed', value: 'RES-' },
    { type: 'sequence', digits: 4, resetPeriod: 'never' },
  ],
  plant: [
    { type: 'fixed', value: 'PLT-' },
    { type: 'sequence', digits: 3, resetPeriod: 'never' },
  ],
  stock_location: [
    { type: 'fixed', value: 'LOC-' },
    { type: 'sequence', digits: 4, resetPeriod: 'never' },
  ],
  // Every physical piece of steel — received, opened as WIP, or produced. Six
  // digits because this is the highest-volume thing in the system by far: one
  // row per piece per receipt, and one more each time a piece is made.
  stock_piece: [
    { type: 'fixed', value: 'SP-' },
    { type: 'sequence', digits: 6, resetPeriod: 'never' },
  ],
  /**
   * A PART ON AN ORDER — named by what it is, not by where it sits.
   *
   *   KLPT-SO-20260906-0005-MS-E350BO-12X200X400
   *
   * No sequence and no tree position, and both omissions are the point. Two
   * identical stiffeners under two different diaphragms produce the SAME code,
   * which is what lets them be one thing to nest, to buy and to stock. A running
   * number would make them different again, and a tree position asserts a
   * difference that stops existing the moment they come off the plate and go on
   * the same pile.
   *
   * It also keeps the property the whole BOQ workflow rests on: the code is
   * predictable by eye. Read the material and the size off a drawing and you can
   * write the code without looking it up.
   *
   * Dimensions read thickness x width x length because that is the order a
   * fabricator says them in, and each is padded so codes of the same shape sort
   * together.
   */
  order_part: [
    { type: 'order_prefix' },
    { type: 'fixed', value: '-' },
    { type: 'attribute', field: 'material', length: 4, fallback: 'NA' },
    { type: 'fixed', value: '-' },
    { type: 'attribute', field: 'grade', length: 8, fallback: 'NA' },
    { type: 'fixed', value: '-' },
    { type: 'attribute', field: 'thickness', pad: 2 },
    { type: 'fixed', value: 'X' },
    { type: 'attribute', field: 'width', pad: 4 },
    { type: 'fixed', value: 'X' },
    { type: 'attribute', field: 'length', pad: 5 },
  ],
  bom: [
    { type: 'fixed', value: 'BOM-' },
    { type: 'sequence', digits: 4, resetPeriod: 'never' },
  ],
  route: [
    { type: 'fixed', value: 'RT-' },
    { type: 'sequence', digits: 4, resetPeriod: 'never' },
  ],
  operation: [
    { type: 'fixed', value: 'OP-' },
    { type: 'sequence', digits: 4, resetPeriod: 'never' },
  ],
  sales_order: [
    { type: 'fixed', value: 'SO-' },
    { type: 'date', format: 'YYYYMMDD' },
    { type: 'fixed', value: '-' },
    { type: 'sequence', digits: 4, resetPeriod: 'monthly' },
  ],
  /** Production orders — fabrication and cutting alike. One counter for both. */
  manufacturing_order: [
    { type: 'fixed', value: 'MO-' },
    { type: 'date', format: 'YYYYMMDD' },
    { type: 'fixed', value: '-' },
    { type: 'sequence', digits: 4, resetPeriod: 'monthly' },
  ],
  purchase_order: [
    { type: 'fixed', value: 'PO-' },
    { type: 'date', format: 'YYYYMMDD' },
    { type: 'fixed', value: '-' },
    { type: 'sequence', digits: 4, resetPeriod: 'monthly' },
  ],
  /**
   * A ROW OF AN ORDER'S BOM — its parent's code, the code its BOM line gives it,
   * and where it sits.
   *
   *   KALP-SO-20260910-0066-SPAN1-L1-2      the second Segment row under Line 1
   */
  order_item: [
    { type: 'parent_code', separator: '-', topLevel: 'order_prefix' },
    { type: 'bom_code' },
    { type: 'position', digits: 1, restart: 'parent' },
  ],
  /**
   * A BLANK — one size of rectangle cut for one order. Named by what it is, so
   * the same rectangle on the same order is always the same code.
   *
   *   BLK-202609100066-MS-E350BO-28X2995X12000
   */
  blank: [
    { type: 'fixed', value: 'BLK-' },
    { type: 'attribute', field: 'orderRef' },
    { type: 'fixed', value: '-' },
    { type: 'attribute', field: 'material', fallback: 'X' },
    { type: 'fixed', value: '-' },
    { type: 'attribute', field: 'grade', fallback: 'X' },
    { type: 'fixed', value: '-' },
    { type: 'attribute', field: 'thickness' },
    { type: 'fixed', value: 'X' },
    { type: 'attribute', field: 'width' },
    { type: 'fixed', value: 'X' },
    { type: 'attribute', field: 'length' },
  ],
  /**
   * A TASK — the row it works on, which step of the flow, and the operation.
   *
   *   KALP-SO-20260910-0066-SPAN1-L1-2/05-SAW
   *
   * The step number is there because a flow can use one operation more than
   * once (a crane move between every station), and the code has to tell those
   * apart.
   */
  task: [
    { type: 'parent_code', separator: '/', topLevel: 'none' },
    { type: 'step_no', digits: 2 },
    { type: 'fixed', value: '-' },
    { type: 'operation_code' },
  ],
  planned_order: [
    { type: 'fixed', value: 'PLN-' },
    { type: 'date', format: 'YYYYMMDD' },
    { type: 'fixed', value: '-' },
    { type: 'sequence', digits: 4, resetPeriod: 'monthly' },
  ],
  subcontract_order: [
    { type: 'fixed', value: 'SCO-' },
    { type: 'date', format: 'YYYYMMDD' },
    { type: 'fixed', value: '-' },
    { type: 'sequence', digits: 4, resetPeriod: 'monthly' },
  ],
  transfer_order: [
    { type: 'fixed', value: 'TO-' },
    { type: 'date', format: 'YYYYMMDD' },
    { type: 'fixed', value: '-' },
    { type: 'sequence', digits: 4, resetPeriod: 'monthly' },
  ],
  customer: [
    { type: 'fixed', value: 'CUST-' },
    { type: 'sequence', digits: 4, resetPeriod: 'never' },
  ],
  // Suppliers had a live rule in production (next_seq had reached 5) but no
  // default here, no entry in the settings UI and no autogen hook — so the codes
  // were coming from somewhere ad hoc while the Suppliers form still demanded
  // one by hand. Four digits to match customers; a mill list is the same order
  // of magnitude as a client list.
  supplier: [
    { type: 'fixed', value: 'SUP-' },
    { type: 'sequence', digits: 4, resetPeriod: 'never' },
  ],
};

export function defaultSegmentsFor(entityType) {
  return DEFAULT_SEGMENTS[entityType] ?? [
    { type: 'fixed', value: '' },
    { type: 'sequence', digits: 4, resetPeriod: 'never' },
  ];
}

function pad2(n) { return String(n).padStart(2, '0'); }

function formatDate(format, now) {
  const yyyy = String(now.getFullYear());
  const yy = yyyy.slice(-2);
  const mm = pad2(now.getMonth() + 1);
  const dd = pad2(now.getDate());
  switch (format) {
    case 'YYYY':     return yyyy;
    case 'YY':       return yy;
    case 'MM':       return mm;
    case 'DD':       return dd;
    case 'YYMM':     return `${yy}${mm}`;
    case 'YYYYMM':   return `${yyyy}${mm}`;
    case 'YYYYMMDD': return `${yyyy}${mm}${dd}`;
    default:         return yyyy;
  }
}

function periodKeyFor(resetPeriod, now) {
  if (resetPeriod === 'yearly') return formatDate('YYYY', now);
  if (resetPeriod === 'monthly') return formatDate('YYYYMM', now);
  return null; // 'never' — sequence never resets
}

async function categoryShortform(companyId, categoryId, length) {
  if (!categoryId) return '';
  const [[row]] = await pool.query(
    `SELECT shortform, name FROM fab_item_categories WHERE id = ? AND company_id = ? AND deleted_at IS NULL LIMIT 1`,
    [categoryId, companyId],
  );
  if (!row) return '';
  const source = row.shortform || (row.name || '').replace(/[^A-Za-z0-9]+/g, '');
  return source.toUpperCase().slice(0, length);
}

async function groupShortform(companyId, groupId, length) {
  if (!groupId) return '';
  const [[row]] = await pool.query(
    `SELECT shortform, name FROM fab_item_groups WHERE id = ? AND company_id = ? AND deleted_at IS NULL LIMIT 1`,
    [groupId, companyId],
  );
  if (!row) return '';
  const source = row.shortform || (row.name || '').replace(/[^A-Za-z0-9]+/g, '');
  return source.toUpperCase().slice(0, length);
}

async function subgroupShortform(companyId, subgroupId, length) {
  if (!subgroupId) return '';
  const [[row]] = await pool.query(
    `SELECT shortform, name FROM fab_item_subgroups WHERE id = ? AND company_id = ? AND deleted_at IS NULL LIMIT 1`,
    [subgroupId, companyId],
  );
  if (!row) return '';
  const source = row.shortform || (row.name || '').replace(/[^A-Za-z0-9]+/g, '');
  return source.toUpperCase().slice(0, length);
}

/** Evaluates segments into a code string. seqValue is the number to render for the sequence segment. */
async function evaluateSegments(segments, { companyId, context, seqValue, now }) {
  const parts = [];
  for (const seg of segments) {
    switch (seg.type) {
      case 'fixed':
        parts.push(seg.value ?? '');
        break;
      case 'free_text':
        parts.push(seg.value ?? '');
        break;
      case 'date':
        parts.push(formatDate(seg.format, now));
        break;
      case 'category_shortform':
        parts.push(await categoryShortform(companyId, context.categoryId, seg.length ?? 3));
        break;
      case 'group_shortform':
        parts.push(await groupShortform(companyId, context.groupId, seg.length ?? 3));
        break;
      case 'subgroup_shortform':
        parts.push(await subgroupShortform(companyId, context.subgroupId, seg.length ?? 3));
        break;
      case 'sequence':
        parts.push(String(seqValue).padStart(seg.digits ?? 4, '0'));
        break;

      /**
       * A PART IS NAMED BY WHAT IT IS, NOT BY WHERE IT SITS.
       *
       * An assembly earns a positional code because that specific object goes in
       * that specific place: ED3 is at one end of the bridge and ED4 at the
       * other, and if ED3 fails inspection it is ED3 that failed. A part has no
       * such claim. A 12 mm E350 plate 200 x 400 is the same object wherever it
       * came from in the tree, and once it is cut it goes on a pile with the
       * others and nobody can tell them apart again.
       *
       * Coding it by its tree position asserted a difference that does not
       * exist, and that assertion had a price: two identical stiffeners under
       * two different diaphragms were two separate things to nest, to buy and to
       * stock, so the same steel was planned three times over.
       *
       * `attribute` reads one named value out of the context the caller passes —
       * material, grade, thickness, width, length. `length` truncates it and
       * `pad` zero-fills a number, so `12` can read as `012` and sort properly.
       */
      case 'attribute': {
        const raw = context.attributes?.[seg.field];
        if (raw == null || raw === '') { parts.push(seg.fallback ?? ''); break; }
        let text = String(raw).trim();
        // Numbers lose their decimal tail: 12.000000 is 12 on a drawing.
        if (/^-?\d+(\.\d+)?$/.test(text)) text = String(Number(text));
        if (seg.strip !== false) text = text.replace(/[^A-Za-z0-9.]+/g, '');
        if (seg.upper !== false) text = text.toUpperCase();
        if (seg.pad) text = text.padStart(seg.pad, '0');
        if (seg.length) text = text.slice(0, seg.length);
        parts.push(text);
        break;
      }

      /**
       * The order's own prefix — `<customer abbr>-<order number>`.
       *
       * Resolved by the caller rather than looked up here, because
       * `itemCodeService.orderCodePrefix` already owns that rule and a second
       * implementation would be a second answer to the same question.
       */
      case 'order_prefix':
        parts.push(context.orderPrefix ?? '');
        break;

      case 'parent_code': {
        const parent = context.parentCode
          || ((seg.topLevel ?? 'order_prefix') === 'order_prefix' ? context.orderPrefix : '')
          || '';
        if (parent) parts.push(parent + (seg.separator ?? '-'));
        break;
      }

      case 'bom_code': {
        const text = String(context.bomCode ?? '').toUpperCase();
        parts.push(seg.length ? text.slice(0, seg.length) : text);
        break;
      }

      case 'position': {
        const n = (seg.restart === 'above' ? context.position?.above : context.position?.parent) ?? 1;
        parts.push(String(n).padStart(seg.digits ?? 1, '0'));
        break;
      }

      case 'step_no':
        parts.push(String(context.stepNo ?? '').padStart(seg.digits ?? 2, '0'));
        break;

      case 'operation_code':
        parts.push(String(context.operationCode ?? '').toUpperCase());
        break;

      default:
        break;
    }
  }
  return parts.join('');
}

function findSequenceSegment(segments) {
  return segments.find((s) => s.type === 'sequence') ?? null;
}

async function getRuleRow(companyId, entityType) {
  const [[row]] = await pool.query(
    `SELECT * FROM fab_codegen_rules WHERE company_id = ? AND entity_type = ? LIMIT 1`,
    [companyId, entityType],
  );
  return row ?? null;
}

/** Fetches the company's rule for an entity type, or the built-in default if none configured. */
export async function getRule(companyId, entityType) {
  await ensureTable();
  const row = await getRuleRow(companyId, entityType);
  if (row) {
    return {
      segments: typeof row.segments_json === 'string' ? JSON.parse(row.segments_json) : row.segments_json,
      nextSeq: row.next_seq,
      seqPeriodKey: row.seq_period_key,
      isDefault: false,
    };
  }
  return { segments: defaultSegmentsFor(entityType), nextSeq: 1, seqPeriodKey: null, isDefault: true };
}

/** Saves (upserts) the segment list for a company × entity type. Leaves the running sequence untouched. */
export async function saveRule(companyId, entityType, segments) {
  await ensureTable();
  await pool.query(
    `INSERT INTO fab_codegen_rules (company_id, entity_type, segments_json, next_seq)
     VALUES (?, ?, ?, 1)
     ON DUPLICATE KEY UPDATE segments_json = VALUES(segments_json), updated_at = UTC_TIMESTAMP()`,
    [companyId, entityType, JSON.stringify(segments)],
  );
}

/** Builds a sample code without touching the persisted sequence. */
export async function previewCode(companyId, entityType, segments, context = {}) {
  await ensureTable();
  const seqSeg = findSequenceSegment(segments);
  const now = new Date();
  let seqValue = 1;
  if (seqSeg) {
    const row = await getRuleRow(companyId, entityType);
    const periodKey = periodKeyFor(seqSeg.resetPeriod, now);
    seqValue = row && row.seq_period_key === periodKey ? row.next_seq : 1;
  }
  // A code read off the thing itself needs a thing to read. The settings page
  // previews with no context at all, so it is shown a sample one.
  const ctx = Object.keys(context ?? {}).some((k) => context[k] != null)
    ? context
    : (SAMPLE_CONTEXT[entityType] ?? context);
  return evaluateSegments(segments, { companyId, context: ctx, seqValue, now });
}

/**
 * Generates and consumes the next code for a company × entity type.
 * Resets the running sequence when the resetPeriod's period key has rolled over.
 *
 * Pass `existingConn` to issue the code inside a caller's open transaction. Do
 * that whenever the code is about to be written to a row: a number consumed on
 * its own connection commits immediately, so if the insert that was going to
 * use it then fails, the number is burnt and the sequence has a permanent hole.
 * Sharing the caller's transaction makes issue-and-insert atomic — and avoids
 * taking a second pool connection while the caller holds one, which under load
 * is a self-inflicted deadlock (the pool has no queue limit).
 */
export async function generateCode(companyId, entityType, context = {}, existingConn = null) {
  await ensureTable();
  const conn = existingConn ?? (await pool.getConnection());
  const ownTransaction = !existingConn;
  try {
    if (ownTransaction) await conn.beginTransaction();

    // Make the row exist BEFORE locking it. A SELECT ... FOR UPDATE that matches
    // nothing takes a gap lock, and gap locks are mutually compatible — so two
    // first-callers for the same (company, entityType) both sail past, both
    // INSERT, and their insert-intention locks collide: one gets ER_DUP_ENTRY,
    // or more often ER_LOCK_DEADLOCK, and the caller sees a 500 the first time
    // anyone ever generates a code of that type. Upserting first means the
    // lock below always has a real row to take.
    await conn.query(
      `INSERT INTO fab_codegen_rules (company_id, entity_type, segments_json, next_seq)
       VALUES (?, ?, ?, 1)
       ON DUPLICATE KEY UPDATE id = id`,
      [companyId, entityType, JSON.stringify(defaultSegmentsFor(entityType))],
    );

    const [[row]] = await conn.query(
      `SELECT * FROM fab_codegen_rules WHERE company_id = ? AND entity_type = ? LIMIT 1 FOR UPDATE`,
      [companyId, entityType],
    );

    const segments = typeof row.segments_json === 'string'
      ? JSON.parse(row.segments_json)
      : row.segments_json;

    const now = new Date();
    const seqSeg = findSequenceSegment(segments);
    let seqValue = row.next_seq;
    let nextSeqToStore = row.next_seq + 1;
    let periodKeyToStore = row.seq_period_key;

    if (seqSeg) {
      const periodKey = periodKeyFor(seqSeg.resetPeriod, now);
      if (periodKey !== row.seq_period_key) {
        seqValue = 1;
        nextSeqToStore = 2;
        periodKeyToStore = periodKey;
      }
    }

    const code = await evaluateSegments(segments, { companyId, context, seqValue, now });

    await conn.query(
      `UPDATE fab_codegen_rules SET next_seq = ?, seq_period_key = ? WHERE id = ?`,
      [nextSeqToStore, periodKeyToStore, row.id],
    );

    if (ownTransaction) await conn.commit();
    return code;
  } catch (err) {
    // Only unwind what we started. Rolling back a caller's transaction here
    // would silently discard work this function knows nothing about; let the
    // error propagate and leave that decision to whoever opened it.
    if (ownTransaction) await conn.rollback();
    throw err;
  } finally {
    if (ownTransaction) conn.release();
  }
}

/* ══════════════════════════════════════════════════════════════════════════
 * DERIVED CODES — read off where a thing is and what it is, never counted.
 * ══════════════════════════════════════════════════════════════════════════ */

/** The segments a rule uses, as saved or as shipped. */
async function segmentsFor(companyId, entityType) {
  await ensureTable();
  const row = await getRuleRow(companyId, entityType);
  if (!row) return defaultSegmentsFor(entityType);
  return typeof row.segments_json === 'string' ? JSON.parse(row.segments_json) : row.segments_json;
}

/**
 * Codes for many things of one kind at once, without touching any counter.
 *
 * For rules whose code is a fact about the thing — a blank's size, a BOM row's
 * place in the tree, a task's step. Such a rule has no running sequence; if one
 * is added anyway it renders as 1, which the settings page makes plain by
 * offering no sequence for these kinds.
 *
 * @param {object[]} contexts one per code wanted
 * @returns {Promise<string[]>} in the same order
 */
export async function deriveCodes(companyId, entityType, contexts) {
  const segments = await segmentsFor(companyId, entityType);
  const now = new Date();
  const out = [];
  for (const context of contexts) {
    out.push(await evaluateSegments(segments, { companyId, context, seqValue: 1, now }));
  }
  return out;
}

/**
 * The `<CUSTOMER>-<ORDER NUMBER>` head every code in one order shares.
 *
 * From the customer's NAME, not its code: fab_customers.code is a serial
 * ('CUST-0001'), which identifies nothing to a reader.
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
  const cust = customerAbbrev(order.customer_master_name || order.customer_name);
  const num = String(order.order_number ?? '').toUpperCase().replace(/[^A-Z0-9-]+/g, '') || `ORD${orderId}`;
  return `${cust}-${num}`;
}

/**
 * A row added on the order with no BOM line behind it names itself.
 *
 * Several words read as the shop writes them — initials: "Intermediate
 * Stiffener" is IS, "End Stiffener" ES. A trailing "(drilled)" becomes the
 * /D the BOM uses for the same thing. One word keeps the ordinary abbreviation.
 */
function shortName(name) {
  const m = /^(.*?)\s*\(([^)]+)\)\s*$/.exec(String(name ?? ''));
  const base = (m ? m[1] : String(name ?? '')).trim();
  const words = base.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const head = words.length > 1 ? words.map((w) => w[0]).join('').toUpperCase() : abbreviate(base);
  return m ? `${head}/${m[2].trim()[0].toUpperCase()}` : head;
}

/**
 * The code of every BOM row on an order, from the 'order_item' rule.
 *
 * Read in BOM order — `sort_order`, which is what dragging rows sets — so the
 * order on screen is the order the numbers run in. Blank rows are not part of
 * the tree and keep the codes their own rule gives them.
 *
 * POSITION IS COUNTED AMONG ROWS OF THE SAME ITEM. Under a span holding a line,
 * two end diaphragms and a splice, the end diaphragms are ED1 and ED2 — not
 * ED2 and ED3 because a line happened to come first.
 *
 * @returns {Promise<Map<number, string>>} item id -> code
 */
export async function orderRowCodes(companyId, orderId, conn) {
  const exec = conn ?? pool;
  const [rows] = await exec.query(
    `SELECT i.id, i.parent_item_id AS parentId, i.catalog_item_id AS catalogId, i.name,
            ol.code AS lineCode
       FROM fab_items i
       LEFT JOIN fab_order_lines ol ON ol.id = i.order_line_id AND ol.deleted_at IS NULL
      WHERE i.company_id = ? AND i.order_id = ? AND i.deleted_at IS NULL
        AND i.node_kind = 'structure'
        -- Bought rows are not made here and get no production code: a shear
        -- stud is known by its catalog code, not by where it sits.
        AND COALESCE(i.procurement_type, 'make') = 'make'
        AND NOT EXISTS (SELECT 1 FROM fab_item_catalog bc
                         WHERE bc.id = i.catalog_item_id AND bc.material_form = 'blank')
      ORDER BY i.sort_order IS NULL, i.sort_order, i.id`,
    [companyId, orderId],
  );
  if (!rows.length) return new Map();

  const catalogIds = [...new Set(rows.map((r) => r.catalogId).filter((x) => x != null))];
  const bomCode = new Map();
  if (catalogIds.length) {
    const [lines] = await exec.query(
      `SELECT parent_item_id AS p, child_item_id AS c, code_segment AS seg
         FROM fab_item_bom
        WHERE company_id = ? AND deleted_at IS NULL AND child_item_id IN (?)`,
      [companyId, catalogIds],
    );
    for (const l of lines) bomCode.set(`${l.p}:${l.c}`, l.seg ?? '');
  }

  const byId = new Map(rows.map((r) => [Number(r.id), r]));
  const kids = new Map();
  for (const r of rows) {
    const k = r.parentId != null && byId.has(Number(r.parentId)) ? Number(r.parentId) : 'root';
    if (!kids.has(k)) kids.set(k, []);
    kids.get(k).push(r);
  }

  const prefix = await orderCodePrefix(companyId, orderId, exec);
  /*
   * WHAT COUNTS AS "THE SAME" FOR NUMBERING. A row from a BOM line counts with
   * the other rows of its item — three girder rows renamed G1, G2–G3 and G4 are
   * still L1, L2, L3. A row added on the order has no BOM line and names
   * itself, so it counts with rows of the same NAME: plain and drilled
   * stiffeners are IS1 and IS/D1, and two End Stiffener rows of different
   * sizes on one segment are ES1 and ES2 rather than both ES1.
   */
  const sameItem = (r, fromBom) => (fromBom
    ? `c${r.catalogId}`
    : `n|${String(r.name).toLowerCase()}`);
  const aboveCount = new Map();
  const contexts = [];
  const ids = [];

  // Parents before children, so every row can read its parent's code.
  const walk = (parentKey, parentRow, parentCode) => {
    const siblings = kids.get(parentKey) ?? [];
    const underParent = new Map();
    for (const r of siblings) {
      // What the BOM calls this row. A BOM line left blank means "just a
      // number"; no BOM line at all (a top row, or a row added by hand) falls
      // back to the order line's code, then to an abbreviation of the name.
      const line = parentRow?.catalogId != null && r.catalogId != null
        ? bomCode.get(`${parentRow.catalogId}:${r.catalogId}`)
        : undefined;
      const key = sameItem(r, line !== undefined);
      underParent.set(key, (underParent.get(key) ?? 0) + 1);
      aboveCount.set(key, (aboveCount.get(key) ?? 0) + 1);
      const bom = line !== undefined ? line : (r.lineCode || shortName(r.name));

      const context = {
        orderPrefix: prefix,
        parentCode,
        bomCode: bom,
        position: { parent: underParent.get(key), above: aboveCount.get(key) },
      };
      contexts.push(context);
      ids.push(Number(r.id));
      r._context = context;
    }
    return siblings;
  };

  // Codes depend on the parent's code, so each level is rendered before the
  // next is walked.
  const segments = await segmentsFor(companyId, 'order_item');
  const now = new Date();
  const codes = new Map();
  let level = walk('root', null, '');
  while (level.length) {
    const next = [];
    for (const r of level) {
      const code = await evaluateSegments(segments, { companyId, context: r._context, seqValue: 1, now });
      codes.set(Number(r.id), code);
      next.push(...walk(Number(r.id), r, code));
    }
    level = next;
  }
  return codes;
}

/**
 * The code of each task, from the 'task' rule.
 *
 * @param {{rowCode:string, stepNo:number, operationCode:string}[]} tasks
 */
export async function taskCodes(companyId, tasks) {
  return deriveCodes(companyId, 'task', tasks.map((t) => ({
    parentCode: t.rowCode, stepNo: t.stepNo, operationCode: t.operationCode,
  })));
}

/** What a preview shows for kinds whose code comes from the thing itself. */
export const SAMPLE_CONTEXT = {
  order_item: {
    orderPrefix: 'KALP-SO-20260910-0066', parentCode: 'KALP-SO-20260910-0066-SPAN1-L1',
    bomCode: 'SG', position: { parent: 2, above: 6 },
  },
  blank: {
    attributes: { orderRef: '202609100066', material: 'MS', grade: 'E350BO', thickness: 28, width: 2995, length: 12000 },
  },
  task: { parentCode: 'KALP-SO-20260910-0066-SPAN1-L1-2', stepNo: 5, operationCode: 'SAW' },
};
