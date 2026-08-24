/**
 * field-values.mjs — write field values without falling over the unique index.
 *
 * `fab_field_values` carries a UNIQUE index `uq_ffv_target` on
 * (company_id, field_id, scope, scope_id) that does NOT include `deleted_at`.
 * There can therefore be exactly ONE row per target for all time, live or
 * soft-deleted.
 *
 * That makes the obvious idempotency pattern — soft-delete the old answer, then
 * insert the new one — a bug that hides until the second run. Four scripts here
 * were written that way and all four appeared to work, because every target they
 * touched had no prior row. The first re-run would have died on a duplicate key,
 * and the first backfill over an already-populated field DID:
 *
 *   Duplicate entry '?' for key 'fab_field_values.uq_ffv_target'
 *
 * So the only correct write is an UPSERT, which also revives a target that was
 * soft-deleted earlier — otherwise a value cleared once could never be set
 * again, which is a far worse failure than the error above because nothing
 * reports it.
 */

const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };

/**
 * Set one field's value on many targets.
 *
 * @param {object} conn                 the caller's transaction
 * @param {object} o
 * @param {number} o.companyId
 * @param {number} o.fieldId
 * @param {string} o.scope              a ladder rung — 'catalog_item', 'order_item', …
 * @param {'num'|'text'|'date'} o.kind  which value column the answer belongs in
 * @param {string|null} [o.unit]
 * @param {Array<{scopeId:number, value:*}>} o.entries
 * @returns {Promise<number>} rows written
 */
export async function upsertFieldValues(conn, { companyId, fieldId, scope, kind, unit = null, entries }) {
  const rows = (entries ?? []).filter((e) => e && e.scopeId != null && e.value != null && e.value !== '');
  if (!rows.length) return 0;

  const col = kind === 'num' ? 'value_num' : kind === 'date' ? 'value_date' : 'value_text';
  let written = 0;
  for (const g of chunk(rows, 900)) {
    await conn.query(
      `INSERT INTO fab_field_values
         (company_id, field_id, scope, scope_id, ${col}, unit_code)
       VALUES ?
       ON DUPLICATE KEY UPDATE
         ${col} = VALUES(${col}),
         unit_code = VALUES(unit_code),
         -- Revive a target cleared earlier. Without this a value that was once
         -- cleared could never be set again, and nothing would say why.
         deleted_at = NULL`,
      [g.map((e) => [companyId, fieldId, scope, e.scopeId, e.value, unit])],
    );
    written += g.length;
  }
  return written;
}

/**
 * Clear one field's value on many targets.
 *
 * Soft-delete is right HERE — the row must stay, because the unique index means
 * a replacement could not be inserted beside it.
 */
export async function clearFieldValues(conn, { companyId, fieldId, scope, scopeIds }) {
  const ids = (scopeIds ?? []).filter(Boolean);
  if (!ids.length) return 0;
  let n = 0;
  for (const g of chunk(ids, 500)) {
    const [r] = await conn.query(
      `UPDATE fab_field_values SET deleted_at = NOW()
        WHERE company_id = ? AND field_id = ? AND scope = ? AND scope_id IN (?)
          AND deleted_at IS NULL`,
      [companyId, fieldId, scope, g],
    );
    n += r.affectedRows ?? 0;
  }
  return n;
}
