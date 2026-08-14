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
 */

import { pool } from '../../../db.js';

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
  manufacturing_order: [
    { type: 'fixed', value: 'MO-' },
    { type: 'date', format: 'YYYYMMDD' },
    { type: 'fixed', value: '-' },
    { type: 'sequence', digits: 4, resetPeriod: 'monthly' },
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
  return evaluateSegments(segments, { companyId, context, seqValue, now });
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
