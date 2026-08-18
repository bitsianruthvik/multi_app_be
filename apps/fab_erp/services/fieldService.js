/**
 * fieldService.js — read and write field values, over one ladder.
 *
 * Replaces `itemFieldService.resolveItemFields` and every hand-rolled write.
 * The old design and why it had to go is in FAB_ERP_FIELDS_REDESIGN.md; the
 * four things that are structurally different here:
 *
 *   TEXT IS NOT DROPPED. The old resolver ended with
 *   `if (def.data_type === 'text') return null;` to protect the numeric formula
 *   engine, which meant heat_no and serial_no could never be read through it at
 *   all. Values are now typed in the row, so a number is a number and text is
 *   text, and the formula engine filters on `formula_usable` instead — a
 *   deliberate choice about what a formula may reference, not a side effect of
 *   how the value was stored.
 *
 *   A VALUE CARRIES ITS UNIT. `unit_code` sits on the row, so 6 can say whether
 *   it is millimetres or metres, and `fab_units.factor_to_base` converts it to
 *   whatever the field is declared in. Before this a formula reading
 *   `length_mm` was trusting the NAME of the field.
 *
 *   PROVENANCE. Every resolved value reports the rung it came from. "Why is
 *   this 40?" was previously unanswerable — you could not tell a category
 *   default from something typed on the part.
 *
 *   WRITES ARE UPSERTS. `uq_ffv_target` makes that possible; the old table had
 *   no unique key, so every writer had to SELECT then branch, and a race
 *   inserted a second row that later reads chose between arbitrarily.
 */

import { pool } from '../../../db.js';
import { chainsFor, mayHoldValue, rungOf, RUNGS } from './fieldLadder.js';
import { projectToColumns, hasProjection } from './fieldProjection.js';

/** Every active definition for a company, by key AND by id. */
export async function fieldRegistry(companyId, conn = null) {
  const exec = conn ?? pool;
  const [rows] = await exec.query(
    `SELECT id, field_key AS fieldKey, label, data_type AS dataType, dimension,
            default_unit AS defaultUnit, allowed_values AS allowedValues,
            applies_at, formula_usable AS formulaUsable,
            default_num AS defaultNum, default_text AS defaultText,
            is_standard AS isStandard, category_id AS categoryId,
            group_id AS groupId, subgroup_id AS subgroupId, sort_order AS sortOrder
       FROM fab_fields
      WHERE company_id = ? AND deleted_at IS NULL AND active = 1
      ORDER BY sort_order, field_key`,
    [companyId],
  );
  const byKey = new Map();
  const byId = new Map();
  for (const r of rows) {
    // `applies_at` is snake in the row and read as such by mayHoldValue.
    r.applies_at = r.applies_at ?? 'catalog_item';
    byKey.set(r.fieldKey, r);
    byId.set(Number(r.id), r);
  }
  return { rows, byKey, byId };
}

/** The unit table, cached per call. Global, not per company — a metre is a metre. */
export async function unitTable(conn = null) {
  const exec = conn ?? pool;
  const [rows] = await exec.query(
    'SELECT code, dimension, base_code AS baseCode, factor_to_base AS factor FROM fab_units',
  );
  return new Map(rows.map((u) => [u.code, u]));
}

/**
 * Convert a number between units, or refuse.
 *
 * Refuses rather than guesses when the two units do not share a base — which is
 * the case for money (no exchange rate is a constant), for compound rates (one
 * factor cannot express mm/min -> m/min), and across the electrical group
 * (kW -> kVA needs the load's power factor). Returning the number unchanged in
 * those cases would be the silent-1000x bug this exists to prevent.
 *
 * @returns {{ value:number, unit:string }|null} null when not convertible
 */
export function convert(value, fromCode, toCode, units) {
  if (value == null) return null;
  if (!fromCode || !toCode || fromCode === toCode) {
    return { value: Number(value), unit: toCode ?? fromCode ?? null };
  }
  const from = units.get(fromCode);
  const to = units.get(toCode);
  if (!from || !to || from.baseCode !== to.baseCode) return null;
  const base = Number(value) * Number(from.factor);
  return { value: base / Number(to.factor), unit: toCode };
}

/** The typed value of a row, as the field's data type. */
function readValue(row, field) {
  switch (field?.dataType) {
    case 'text':
    case 'enum':
      return row.value_text ?? (row.value_num != null ? String(row.value_num) : null);
    case 'date':
      return row.value_date ?? null;
    case 'bool':
      return row.value_num == null ? null : Number(row.value_num) !== 0;
    default:
      return row.value_num != null ? Number(row.value_num)
        : (row.value_text != null && row.value_text !== '' && Number.isFinite(Number(row.value_text))
          ? Number(row.value_text) : null);
  }
}

/**
 * Resolve fields for many targets at once.
 *
 * @param {Array<{scope,scopeId}>} targets
 * @param {object} [opts]
 * @param {boolean} [opts.formulaOnly] only `formula_usable` fields
 * @returns {Promise<Map<string, Record<string, {value, unit, from, fieldId}>>>}
 *   keyed `"scope:id"`
 */
export async function resolveFields(companyId, targets, opts = {}) {
  const exec = opts.conn ?? pool;
  const list = (targets ?? []).filter((t) => t && t.scope && t.scopeId);
  const out = new Map();
  if (!list.length) return out;

  const registry = opts.registry ?? await fieldRegistry(companyId, exec);
  const units = opts.units ?? await unitTable(exec);
  const chains = await chainsFor(companyId, list, exec);

  // Every distinct node any chain passes through, so the values come back in
  // one query rather than one per target.
  const nodes = new Map();
  for (const chain of chains.values()) {
    for (const n of chain) nodes.set(`${n.scope}:${n.scopeId}`, n);
  }
  const byScope = new Map();
  for (const n of nodes.values()) {
    if (!byScope.has(n.scope)) byScope.set(n.scope, []);
    byScope.get(n.scope).push(n.scopeId);
  }

  const valuesAt = new Map(); // "scope:id" -> [row]
  for (const [scope, ids] of byScope) {
    const [rows] = await exec.query(
      `SELECT field_id, scope, scope_id, value_num, value_text, value_date, unit_code
         FROM fab_field_values
        WHERE company_id = ? AND scope = ? AND deleted_at IS NULL
          AND scope_id IN (${ids.map(() => '?').join(',')})`,
      [companyId, scope, ...ids],
    );
    for (const r of rows) {
      const k = `${r.scope}:${r.scope_id}`;
      if (!valuesAt.has(k)) valuesAt.set(k, []);
      valuesAt.get(k).push(r);
    }
  }

  for (const t of list) {
    const key = `${t.scope}:${t.scopeId}`;
    const chain = chains.get(key) ?? [{ scope: t.scope, scopeId: Number(t.scopeId) }];
    const resolved = {};

    // Registry defaults first — the broadest thing there is.
    for (const f of registry.rows) {
      if (opts.formulaOnly && !Number(f.formulaUsable)) continue;
      const d = f.dataType === 'text' || f.dataType === 'enum' ? f.defaultText : f.defaultNum;
      if (d == null) continue;
      resolved[f.fieldKey] = {
        value: f.dataType === 'number' ? Number(d) : d,
        unit: f.defaultUnit ?? null,
        from: { scope: 'default', scopeId: null },
        fieldId: Number(f.id),
      };
    }

    // Then the chain, broadest first — so the narrowest rung wins by being last.
    for (const node of chain) {
      for (const row of valuesAt.get(`${node.scope}:${node.scopeId}`) ?? []) {
        const f = registry.byId.get(Number(row.field_id));
        if (!f) continue;
        if (opts.formulaOnly && !Number(f.formulaUsable)) continue;
        const raw = readValue(row, f);
        if (raw == null) continue;

        let value = raw;
        let unit = row.unit_code ?? f.defaultUnit ?? null;
        if (f.dataType === 'number' && row.unit_code && f.defaultUnit
            && row.unit_code !== f.defaultUnit) {
          const c = convert(raw, row.unit_code, f.defaultUnit, units);
          // Not convertible: keep the value in the unit it was authored in and
          // say so, rather than silently presenting it as the field's unit.
          if (c) { value = c.value; unit = c.unit; }
        }
        resolved[f.fieldKey] = {
          value, unit, from: { scope: node.scope, scopeId: node.scopeId }, fieldId: Number(f.id),
        };
      }
    }
    out.set(key, resolved);
  }
  return out;
}

/** Just the values, for callers that do not care where they came from. */
export const flatten = (resolved) =>
  Object.fromEntries(Object.entries(resolved ?? {}).map(([k, v]) => [k, v.value]));

/**
 * Write values at one scope.
 *
 * @param {Record<string, {value, unit?}|string|number|null>} values keyed by field_key
 * @returns {Promise<{written:number, cleared:number, rejected:Array}>}
 */
export async function setFields(companyId, scope, scopeId, values, existingConn = null) {
  const conn = existingConn ?? await pool.getConnection();
  const owned = !existingConn;
  try {
    if (owned) await conn.beginTransaction();
    if (rungOf(scope) < 0) {
      const e = new Error(`Unknown scope "${scope}". Expected one of ${RUNGS.join(', ')}.`);
      e.status = 400;
      throw e;
    }
    const registry = await fieldRegistry(companyId, conn);

    let written = 0;
    let cleared = 0;
    const rejected = [];
    /**
     * What to copy into the legacy columns afterwards (step 4).
     *
     * Collected as we go and written once at the end, on this same connection,
     * so a value and its projection land together. See fieldProjection.js for
     * why the columns still exist at all.
     */
    const toProject = {};

    for (const [fieldKey, input] of Object.entries(values ?? {})) {
      const f = registry.byKey.get(fieldKey);
      if (!f) { rejected.push({ fieldKey, why: 'no such field' }); continue; }

      // The gate, enforced on WRITE. The old design allowed the row and gated it
      // on every read, which meant a stray value sat in the table forever
      // looking authoritative. Here it simply cannot be stored.
      if (!mayHoldValue(f, scope)) {
        rejected.push({
          fieldKey,
          why: `${f.label} is set at ${f.applies_at} or broader, not on a ${scope}`,
        });
        continue;
      }

      const raw = input && typeof input === 'object' && 'value' in input ? input.value : input;
      const unit = input && typeof input === 'object' ? (input.unit ?? f.defaultUnit) : f.defaultUnit;

      if (raw == null || raw === '') {
        const [r] = await conn.query(
          `UPDATE fab_field_values SET deleted_at = NOW()
            WHERE company_id = ? AND field_id = ? AND scope = ? AND scope_id = ? AND deleted_at IS NULL`,
          [companyId, f.id, scope, scopeId],
        );
        cleared += r.affectedRows ? 1 : 0;
        // Clearing a value clears its column too, or the column would keep
        // answering for a value that no longer exists.
        if (hasProjection(scope, fieldKey)) toProject[fieldKey] = null;
        continue;
      }

      let num = null;
      let text = null;
      let date = null;
      switch (f.dataType) {
        case 'text': text = String(raw).slice(0, 500); break;
        case 'enum': {
          const allowed = Array.isArray(f.allowedValues) ? f.allowedValues
            : (typeof f.allowedValues === 'string' ? JSON.parse(f.allowedValues || '[]') : []);
          const match = allowed.find((a) => String(a).toLowerCase() === String(raw).toLowerCase());
          if (allowed.length && !match) {
            rejected.push({ fieldKey, why: `"${raw}" is not one of ${allowed.join(', ')}` });
            continue;
          }
          // Store the CANONICAL spelling, not what was typed, so two rows never
          // differ only by case.
          text = String(match ?? raw).slice(0, 500);
          break;
        }
        case 'date': date = String(raw).slice(0, 10); break;
        case 'bool': num = (raw === true || raw === 1 || String(raw).toLowerCase() === 'true') ? 1 : 0; break;
        default: {
          const n = Number(raw);
          if (!Number.isFinite(n)) { rejected.push({ fieldKey, why: `"${raw}" is not a number` }); continue; }
          num = n;
        }
      }

      // A real upsert, which uq_ffv_target makes possible.
      await conn.query(
        `INSERT INTO fab_field_values
           (company_id, field_id, scope, scope_id, value_num, value_text, value_date, unit_code)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           value_num = VALUES(value_num), value_text = VALUES(value_text),
           value_date = VALUES(value_date), unit_code = VALUES(unit_code),
           deleted_at = NULL`,
        [companyId, f.id, scope, scopeId, num, text, date, unit ?? null],
      );
      written++;

      /**
       * The projected value is the one AFTER unit conversion, not the one that
       * was typed. A length authored as 6 m must land in the column as 6000,
       * because every matcher reading that column assumes the field's declared
       * unit — putting 6 there would be the silent-1000x bug wearing a different
       * hat.
       */
      if (hasProjection(scope, fieldKey)) {
        let projected = num ?? text ?? date;
        if (f.dataType === 'number' && unit && f.defaultUnit && unit !== f.defaultUnit) {
          const c = convert(num, unit, f.defaultUnit, await unitTable(conn));
          if (c) projected = c.value;
        }
        toProject[fieldKey] = projected;
      }
    }

    const projectedCount = await projectToColumns(conn, companyId, scope, scopeId, toProject);

    if (owned) await conn.commit();
    return { written, cleared, rejected, projected: projectedCount };
  } catch (err) {
    if (owned) await conn.rollback();
    throw err;
  } finally {
    if (owned) conn.release();
  }
}

/** Convenience for one target. */
export async function resolveOne(companyId, scope, scopeId, opts = {}) {
  const m = await resolveFields(companyId, [{ scope, scopeId }], opts);
  return m.get(`${scope}:${scopeId}`) ?? {};
}

/**
 * SQL to match rows on FIELD VALUES, the way a column filter used to.
 *
 * Step 4's second half. Two queries genuinely FILTER on a projected column —
 * consumption (`wipInventoryService`) and availability — and they are the two
 * that decide which physical plate gets cut. Everything else merely SELECTs the
 * column for display, and a derived projection answers that correctly.
 *
 * Moving these two is what makes the capability universal: matching on a value
 * stops being a privilege of the thirteen keys that happen to have a column, and
 * becomes something any field can do. That is the asymmetry worth removing —
 * not the storage.
 *
 * NULL-SAFE, EXACTLY AS BEFORE. A LEFT JOIN yields NULL where a piece has no
 * value, and `<=>` against NULL behaves precisely as it did against an empty
 * column: an unmeasured plate does not match a sized requirement. That is the
 * point rather than an accident — an unmeasured plate is not evidence of the
 * right plate, and the exact-fit rule depends on it.
 *
 * @param {string} alias   the table alias the caller uses, e.g. 'p' or bare ''
 * @param {Record<string, number|null>} criteria fieldKey -> required value
 * @returns {Promise<{join:string, where:string, params:Array}>} splice into the query
 */
export async function fieldMatchSql(companyId, scope, alias, criteria, conn = null) {
  const exec = conn ?? pool;
  const entries = Object.entries(criteria ?? {});
  if (!entries.length) return { join: '', where: '', params: [] };

  const registry = await fieldRegistry(companyId, exec);
  const joins = [];
  const wheres = [];
  const joinParams = [];
  const whereParams = [];
  const idPrefix = alias ? `${alias}.id` : 'id';

  entries.forEach(([fieldKey, wanted], i) => {
    const f = registry.byKey.get(fieldKey);
    // A criterion naming a field that does not exist must match NOTHING, not
    // everything. Silently dropping it would widen the search to every piece —
    // the opposite of what an exact-fit filter is for.
    if (!f) { wheres.push('1 = 0'); return; }
    const v = `fv${i}`;
    joins.push(
      `LEFT JOIN fab_field_values ${v}`
      + ` ON ${v}.company_id = ? AND ${v}.field_id = ? AND ${v}.scope = ?`
      + ` AND ${v}.scope_id = ${idPrefix} AND ${v}.deleted_at IS NULL`,
    );
    joinParams.push(companyId, f.id, scope);
    wheres.push(`${v}.value_num <=> ?`);
    whereParams.push(wanted ?? null);
  });

  /**
   * joinParams and whereParams are returned SEPARATELY, not merged.
   *
   * mysql2 binds positionally, and the JOIN clause appears before the caller's
   * own WHERE conditions — so the caller has to interleave:
   *
   *     [...joinParams, ...itsOwnWhereParams, ...whereParams]
   *
   * Handing back one array would invite `[...base, ...params]`, which binds the
   * company id into a value comparison and silently returns the wrong pieces.
   * Two names make the ordering something you have to think about once.
   */
  return {
    join: joins.join('\n'),
    where: wheres.length ? ` AND ${wheres.join(' AND ')}` : '',
    joinParams,
    whereParams,
  };
}
