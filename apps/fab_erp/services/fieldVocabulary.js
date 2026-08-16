/**
 * fieldVocabulary.js — the words a field definition may use.
 *
 * Data types, units and the rules for validating a value against a definition.
 *
 * WHY THIS IS CODE AND NOT A TABLE. These are vocabulary, not tenant data:
 * "mm" means the same thing for every company, and a company inventing its own
 * meaning for it would be a bug rather than a feature. The alternative designs
 * were both worse —
 *
 *   a `company_id = -1` marker: blocked outright, because 66 fab_erp tables
 *   carry a real foreign key from company_id to companies(id), so such a row is
 *   rejected unless a fake company exists. It would also put an exception into
 *   the tenant-isolation invariant, which has already been breached once here.
 *
 *   a per-company seeded table: 6 copies of an identical list that can drift,
 *   for something no company should be editing.
 *
 * This follows the pattern `fab_resource_downtime_reasons` already uses —
 * built-in defaults in code, with a per-company table consulted first if a
 * company genuinely needs to extend the list. That table does not exist yet and
 * is deliberately not being created until somebody needs it.
 */

/**
 * What kind of value a field holds.
 *
 * `number` and `text` are what the registry had. `date` is added because the
 * asset fields moving here in Phase 8 (purchase date, warranty until,
 * commissioned date) are dates, and storing them as text is how you end up
 * with "01/02/2026" meaning two different days to two people.
 *
 * There is deliberately NO `picker` type: a picker is any type that has
 * `allowed_values` set. Making it a separate type would allow the contradiction
 * of a picker with no values, and a number-picker (sizes 6/8/10) would be
 * unexpressible.
 */
export const DATA_TYPES = [
  { value: 'number', label: 'Number' },
  { value: 'text',   label: 'Text' },
  { value: 'date',   label: 'Date' },
  { value: 'bool',   label: 'Yes / No' },
];

/**
 * Units, grouped so a picker can show them sensibly.
 *
 * DECLARED, NOT CONVERTED. The engine does no unit conversion and this does not
 * add any: a unit is documentation on the definition and a label in the UI.
 * That limitation is real — define a length in metres against a formula that
 * assumes millimetres and the answer is plausible and wrong by 1000× — and it
 * is recorded as a known complexity rather than silently implied to be handled.
 * A conversion layer, if it ever lands, belongs here.
 */
export const UNITS = [
  { group: 'Length',    values: ['mm', 'cm', 'm', 'inch', 'ft'] },
  { group: 'Area',      values: ['mm2', 'cm2', 'm2', 'sqft'] },
  { group: 'Volume',    values: ['mm3', 'cm3', 'm3', 'litre'] },
  { group: 'Mass',      values: ['g', 'kg', 'tonne', 'lb'] },
  { group: 'Time',      values: ['sec', 'min', 'hrs', 'days', 'years'] },
  { group: 'Count',     values: ['nos', 'pcs', 'sets', 'pairs'] },
  { group: 'Ratio',     values: ['%', 'ratio'] },
  { group: 'Rate',      values: ['mm/min', 'm/min', 'kg/min', 'kg/m3', 'nos/min', 'INR/kg'] },
  { group: 'Money',     values: ['INR', 'USD', 'EUR'] },
  { group: 'Electrical', values: ['kW', 'kVA', 'A', 'V'] },
];

/** Flat list, for validation. */
export const ALL_UNITS = UNITS.flatMap((g) => g.values);

export const isKnownDataType = (t) => DATA_TYPES.some((d) => d.value === t);
export const isKnownUnit = (u) => u == null || u === '' || ALL_UNITS.includes(u);

/**
 * Parse `allowed_values` off a definition row.
 *
 * Tolerates a JSON array, a JSON string holding one, or a comma-separated
 * string — because the column is JSON but the query API and hand-written SQL
 * have historically each sent their own shape, and a picker that silently loses
 * its options renders as a free-text box that accepts anything. Anything
 * unusable becomes null, which means "not a picker" rather than "a picker with
 * no options".
 */
export function parseAllowedValues(raw) {
  if (raw == null || raw === '') return null;
  let v = raw;
  if (typeof v === 'string') {
    const s = v.trim();
    try {
      v = JSON.parse(s);
    } catch {
      v = s.includes(',') ? s.split(',') : [s];
    }
  }
  if (!Array.isArray(v)) return null;
  const out = v.map((x) => String(x).trim()).filter(Boolean);
  return out.length ? out : null;
}

/**
 * Is `value` acceptable for this definition?
 *
 * Returns `{ ok, reason }` rather than a boolean so a caller can say WHY a
 * value was refused — "must be one of expense, capitalise" is actionable and
 * "invalid" is not.
 *
 * A blank is always acceptable here. Whether a field is REQUIRED is a different
 * question, answered per flow by `requiredFieldsForFlow`, and conflating the
 * two would make every optional field mandatory the moment it gained a picker.
 */
export function validateFieldValue(def, value) {
  if (value == null || String(value).trim() === '') return { ok: true };
  const raw = String(value).trim();

  const allowed = parseAllowedValues(def?.allowed_values ?? def?.allowedValues);
  if (allowed) {
    // Case-insensitive match, but the STORED value is the canonical casing from
    // the list — otherwise "Expense" and "expense" both pass and the split that
    // reads this field still sees two values.
    const hit = allowed.find((a) => a.toLowerCase() === raw.toLowerCase());
    if (!hit) return { ok: false, reason: `must be one of: ${allowed.join(', ')}` };
    return { ok: true, canonical: hit };
  }

  const type = def?.data_type ?? def?.dataType ?? 'number';
  if (type === 'number') {
    const n = Number(raw);
    if (!Number.isFinite(n)) return { ok: false, reason: 'must be a number' };
    return { ok: true, canonical: String(n) };
  }
  if (type === 'date') {
    // ISO only. Accepting local formats means "01/02/2026" is stored, and
    // nothing downstream can tell January from February.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return { ok: false, reason: 'must be a date as YYYY-MM-DD' };
    const d = new Date(`${raw}T00:00:00`);
    if (Number.isNaN(d.getTime())) return { ok: false, reason: 'is not a real date' };
    return { ok: true, canonical: raw };
  }
  if (type === 'bool') {
    const t = ['yes', 'true', '1', 'y'];
    const f = ['no', 'false', '0', 'n'];
    if (t.includes(raw.toLowerCase())) return { ok: true, canonical: 'yes' };
    if (f.includes(raw.toLowerCase())) return { ok: true, canonical: 'no' };
    return { ok: false, reason: 'must be yes or no' };
  }
  return { ok: true, canonical: raw };
}

/**
 * Where a field is authored.
 *
 * Replaces the `piece_varying` boolean, which could express "may differ per
 * piece" but not "meaningless on the item" — and `length_mm` on the catalog row
 * "MS Plate 20mm" is meaningless, because that item covers every length ever
 * bought.
 */
export const FIELD_LEVELS = [
  { value: 'item',  label: 'On the item',  hint: 'Same for every piece — thickness, grade, model' },
  { value: 'piece', label: 'On each piece', hint: 'Differs per piece — length, heat number, serial' },
  { value: 'both',  label: 'Item, overridable', hint: 'Set on the item, changed per piece when it differs' },
];

export const isKnownLevel = (l) => FIELD_LEVELS.some((f) => f.value === l);

/** True when this definition should be asked for on a stock piece. */
export const authoredOnPiece = (def) => {
  const lvl = def?.level ?? (Number(def?.piece_varying ?? def?.pieceVarying) === 1 ? 'both' : 'item');
  return lvl === 'piece' || lvl === 'both';
};

/** True when this definition should be asked for on the catalog item. */
export const authoredOnItem = (def) => {
  const lvl = def?.level ?? (Number(def?.piece_varying ?? def?.pieceVarying) === 1 ? 'both' : 'item');
  return lvl === 'item' || lvl === 'both';
};
