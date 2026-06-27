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
 *   { type: 'date', format }                 — 'YYYY' | 'YY' | 'MM' | 'DD' | 'YYMM' | 'YYYYMM' | 'YYYYMMDD'
 *   { type: 'sequence', digits, resetPeriod } — resetPeriod: 'never' | 'yearly' | 'monthly'
 *   { type: 'free_text', value }             — fixed manual fragment, reserved for future use
 */

import { pool } from '../../../db.js';

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
  bom: [
    { type: 'fixed', value: 'BOM-' },
    { type: 'sequence', digits: 4, resetPeriod: 'never' },
  ],
  route: [
    { type: 'fixed', value: 'RT-' },
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
  if (!categoryId) return ''.padEnd(0);
  const [[row]] = await pool.query(
    `SELECT code FROM fab_item_categories WHERE id = ? AND company_id = ? AND deleted_at IS NULL LIMIT 1`,
    [categoryId, companyId],
  );
  return (row?.code ?? '').toUpperCase().slice(0, length);
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
  await pool.query(
    `INSERT INTO fab_codegen_rules (company_id, entity_type, segments_json, next_seq)
     VALUES (?, ?, ?, 1)
     ON DUPLICATE KEY UPDATE segments_json = VALUES(segments_json), updated_at = NOW()`,
    [companyId, entityType, JSON.stringify(segments)],
  );
}

/** Builds a sample code without touching the persisted sequence. */
export async function previewCode(companyId, entityType, segments, context = {}) {
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
 */
export async function generateCode(companyId, entityType, context = {}) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    let [[row]] = await conn.query(
      `SELECT * FROM fab_codegen_rules WHERE company_id = ? AND entity_type = ? LIMIT 1 FOR UPDATE`,
      [companyId, entityType],
    );

    let segments;
    if (row) {
      segments = typeof row.segments_json === 'string' ? JSON.parse(row.segments_json) : row.segments_json;
    } else {
      segments = defaultSegmentsFor(entityType);
      await conn.query(
        `INSERT INTO fab_codegen_rules (company_id, entity_type, segments_json, next_seq) VALUES (?, ?, ?, 1)`,
        [companyId, entityType, JSON.stringify(segments)],
      );
      [[row]] = await conn.query(
        `SELECT * FROM fab_codegen_rules WHERE company_id = ? AND entity_type = ? LIMIT 1 FOR UPDATE`,
        [companyId, entityType],
      );
    }

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

    await conn.commit();
    return code;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}
