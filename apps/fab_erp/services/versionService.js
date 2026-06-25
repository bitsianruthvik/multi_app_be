// versionService.js — copy-on-write versioning for fab_erp versioned entities.
// EU-B5

import { pool } from '../../../db.js';

// ---------------------------------------------------------------------------
// Entity configuration
// ---------------------------------------------------------------------------

export const ENTITY_CONFIG = {
  formula_sets: {
    headerTable: 'fab_formula_sets',
    lineTable: 'fab_formulas',
    lineFk: 'formula_set_id',
  },
  process_templates: {
    headerTable: 'fab_process_templates',
    lineTable: 'fab_process_template_steps',
    lineFk: 'process_template_id',
  },
  routing_templates: {
    headerTable: 'fab_routing_templates',
    lineTable: 'fab_routing_template_steps',
    lineFk: 'routing_template_id',
  },
  manufacturing_method_templates: {
    headerTable: 'fab_manufacturing_method_templates',
    lineTable: 'fab_manufacturing_method_lines',
    lineFk: 'mfg_method_template_id',
  },
};

// ---------------------------------------------------------------------------
// Data-column lists (explicit; excludes id, created_at, updated_at)
// ---------------------------------------------------------------------------

// fab_formula_sets data columns (copied verbatim to new version)
const FORMULA_SET_DATA_COLS = [
  'company_id',
  'plant_id',
  'name',
  'code',
];

// fab_formulas data columns (excludes id, formula_set_id, created_at, updated_at)
const FORMULA_LINE_DATA_COLS = [
  'company_id',
  'name',
  'result_metric_key',
  'expression_text',
  'expression_ast_json',
];

// fab_process_templates data columns
const PROCESS_TEMPLATE_DATA_COLS = [
  'company_id',
  'plant_id',
  'name',
  'code',
];

// fab_process_template_steps data columns (excludes id, process_template_id, created_at, updated_at)
const PROCESS_TEMPLATE_STEP_DATA_COLS = [
  'company_id',
  'seq_no',
  'name',
  'resource_type_id',
  'formula_id',
];

// fab_routing_templates data columns
const ROUTING_TEMPLATE_DATA_COLS = [
  'company_id',
  'plant_id',
  'name',
  'code',
];

// fab_routing_template_steps data columns (excludes id, routing_template_id, created_at, updated_at)
const ROUTING_TEMPLATE_STEP_DATA_COLS = [
  'company_id',
  'seq_no',
  'name',
  'resource_type_id',
  'formula_id',
];

// fab_manufacturing_method_templates data columns
const MFG_METHOD_TEMPLATE_DATA_COLS = [
  'company_id',
  'plant_id',
  'name',
  'code',
];

// fab_manufacturing_method_lines data columns (excludes id, mfg_method_template_id, created_at, updated_at)
const MFG_METHOD_LINE_DATA_COLS = [
  'company_id',
  'seq_no',
  'routing_template_id',
  'process_template_id',
];

// Map entity name → { headerDataCols, lineDataCols }
const COLUMN_MAP = {
  formula_sets: {
    headerDataCols: FORMULA_SET_DATA_COLS,
    lineDataCols: FORMULA_LINE_DATA_COLS,
  },
  process_templates: {
    headerDataCols: PROCESS_TEMPLATE_DATA_COLS,
    lineDataCols: PROCESS_TEMPLATE_STEP_DATA_COLS,
  },
  routing_templates: {
    headerDataCols: ROUTING_TEMPLATE_DATA_COLS,
    lineDataCols: ROUTING_TEMPLATE_STEP_DATA_COLS,
  },
  manufacturing_method_templates: {
    headerDataCols: MFG_METHOD_TEMPLATE_DATA_COLS,
    lineDataCols: MFG_METHOD_LINE_DATA_COLS,
  },
};

// ---------------------------------------------------------------------------
// createVersion
// ---------------------------------------------------------------------------

/**
 * Copy-on-write: creates a new version of a versioned entity header + its lines.
 *
 * @param {string} entity      - One of the 4 entity keys in ENTITY_CONFIG.
 * @param {number} sourceId    - The header row id to clone.
 * @param {number} companyId   - Tenant scope.
 * @param {object} [connArg]   - Optional existing mysql2 connection (for composability).
 * @returns {{ newId: number, versionNo: number }}
 */
export async function createVersion(entity, sourceId, companyId, connArg) {
  const cfg = ENTITY_CONFIG[entity];
  if (!cfg) {
    const err = new Error(`Unknown versioned entity: "${entity}"`);
    err.statusCode = 400;
    throw err;
  }

  const { headerTable, lineTable, lineFk } = cfg;
  const { headerDataCols, lineDataCols } = COLUMN_MAP[entity];

  // Acquire a connection — use caller's connection if provided (allows nesting),
  // otherwise get one from the pool.
  const ownConnection = !connArg;
  const conn = connArg ?? (await pool.getConnection());

  try {
    // ---- 1. Load source header row ----
    const [headerRows] = await conn.query(
      `SELECT * FROM \`${headerTable}\`
       WHERE id = ? AND company_id = ? AND deleted_at IS NULL
       LIMIT 1`,
      [sourceId, companyId],
    );
    if (!headerRows.length) {
      const err = new Error(`Source header not found (id=${sourceId}, company=${companyId})`);
      err.statusCode = 404;
      throw err;
    }
    const source = headerRows[0];

    // ---- 2. Resolve / bootstrap version_group_id ----
    let versionGroupId = source.version_group_id;
    if (!versionGroupId) {
      // Legacy / first-ever version: self-assign version_group_id = own id.
      versionGroupId = source.id;
      await conn.query(
        `UPDATE \`${headerTable}\` SET version_group_id = ? WHERE id = ?`,
        [versionGroupId, source.id],
      );
    }

    // ---- 3. Determine next version_no ----
    const [maxRows] = await conn.query(
      `SELECT MAX(version_no) AS max_ver
       FROM \`${headerTable}\`
       WHERE version_group_id = ? AND company_id = ? AND deleted_at IS NULL`,
      [versionGroupId, companyId],
    );
    const nextVersionNo = ((maxRows[0]?.max_ver) ?? 0) + 1;

    // ---- 4. Atomic transaction: flip + insert header + copy lines ----
    await conn.beginTransaction();

    try {
      // (a) Mark all existing versions in the group as not current.
      await conn.query(
        `UPDATE \`${headerTable}\`
         SET is_current_version = 0
         WHERE version_group_id = ? AND company_id = ?`,
        [versionGroupId, companyId],
      );

      // (b) Insert new header row, copying all data columns.
      const headerInsertCols = [
        ...headerDataCols,
        'version_group_id',
        'version_no',
        'is_current_version',
        'approval_status',
        // deleted_at intentionally NULL (default) — new version starts active
      ];
      const headerInsertVals = [
        ...headerDataCols.map((c) => source[c]),
        versionGroupId,
        nextVersionNo,
        1,
        'draft',
      ];

      const [insertResult] = await conn.query(
        `INSERT INTO \`${headerTable}\` (${headerInsertCols.map((c) => `\`${c}\``).join(', ')})
         VALUES (${headerInsertCols.map(() => '?').join(', ')})`,
        headerInsertVals,
      );
      const newHeaderId = insertResult.insertId;

      // (c) Copy line rows (deleted_at IS NULL) from source header.
      const [lineRows] = await conn.query(
        `SELECT * FROM \`${lineTable}\`
         WHERE \`${lineFk}\` = ? AND company_id = ? AND deleted_at IS NULL`,
        [sourceId, companyId],
      );

      if (lineRows.length) {
        const lineInsertCols = [lineFk, ...lineDataCols];
        const linePlaceholderRow = `(${lineInsertCols.map(() => '?').join(', ')})`;
        const linePlaceholders = lineRows.map(() => linePlaceholderRow).join(', ');

        const lineValues = [];
        for (const line of lineRows) {
          // FK to new header first, then all data columns
          lineValues.push(newHeaderId, ...lineDataCols.map((c) => line[c]));
        }

        await conn.query(
          `INSERT INTO \`${lineTable}\` (${lineInsertCols.map((c) => `\`${c}\``).join(', ')})
           VALUES ${linePlaceholders}`,
          lineValues,
        );
      }

      await conn.commit();

      return { newId: newHeaderId, versionNo: nextVersionNo };
    } catch (txErr) {
      await conn.rollback();
      throw txErr;
    }
  } finally {
    if (ownConnection) {
      conn.release();
    }
  }
}

// ---------------------------------------------------------------------------
// isVersionConsumable
// ---------------------------------------------------------------------------

/**
 * Returns true only if the header row is approved, not deleted, and is the
 * current version. Used by EU-B3 and other consumers to gate usage of a
 * versioned template/formula-set.
 *
 * @param {string} entity
 * @param {number} headerId
 * @param {number} companyId
 * @returns {Promise<boolean>}
 */
export async function isVersionConsumable(entity, headerId, companyId) {
  const cfg = ENTITY_CONFIG[entity];
  if (!cfg) {
    return false;
  }
  const { headerTable } = cfg;

  const [rows] = await pool.query(
    `SELECT id FROM \`${headerTable}\`
     WHERE id = ?
       AND company_id = ?
       AND approval_status = 'approved'
       AND is_current_version = 1
       AND deleted_at IS NULL
     LIMIT 1`,
    [headerId, companyId],
  );

  return rows.length > 0;
}
