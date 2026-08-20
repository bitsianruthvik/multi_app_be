/**
 * backfill-plate-sizes.mjs — give a plate back the size somebody already wrote
 * down, and leave the rest visibly blank.
 *
 * PROD-03. Raw material received before the stock-in form captured size has
 * `fab_stock_pieces.length_mm` / `width_mm` NULL. In production all 21 pieces of
 * one plate item are unsized, and the consequence is not cosmetic: nesting
 * matches a part to stock on an exact-fit filter over those two columns
 * (`fieldService.fieldMatchSql`, and `<=>` against NULL never matches), so every
 * part reports "no sized stock … to assume a plate size from" and procurement
 * declines by default. Twenty-one real plates in the yard are invisible.
 *
 * WHAT COUNTS AS KNOWING A SIZE. Only two things, and both are somebody having
 * recorded it about THIS piece:
 *
 *   1. THE REGISTRY  `fab_field_values` at scope 'stock_piece' for the
 *      `length_mm` / `width_mm` fields. This is the system of record since the
 *      field redesign; where it holds a value and the column is NULL, the column
 *      is simply a projection that never ran (see fieldProjection.js).
 *
 *   2. THE LEGACY TABLE  `fab_custom_fields` rows at level 'stock_piece' (or its
 *      older spelling 'piece') with field_key 'Length' / 'Width', holding FUSED
 *      STRINGS like "2000 mm". A fused string is a recorded fact wearing a bad
 *      costume: the number is real, the unit is real, only the storage is wrong.
 *      It is parsed, never guessed — a positive finite number and a unit this
 *      database knows (`fab_units`, dimension length), or it is refused.
 *
 * The registry WINS when both know, because it is the system of record — but a
 * disagreement is printed, loudly, per piece. Silently preferring one number
 * over a different number that a human also wrote down is how you lose the fact
 * that the two were ever in conflict.
 *
 * WHAT IS NOT A SOURCE — and this is most of the script's value:
 *
 *   • the sibling pieces off the same receipt          (a lot is not a size)
 *   • the catalog item's default length/width          (a default is not a fact)
 *   • any "standard" plate size                        (2000×6000 is folklore)
 *
 * An invented size is strictly worse than a missing one. A missing size makes
 * nesting say "I cannot match this" — which is true, and a human goes and
 * measures. An invented size makes nesting confidently reserve a plate that is
 * not the shape it thinks, and the error surfaces at the cutting table. So a
 * piece no source knows is LEFT NULL, counted, and listed with enough identity
 * (code, item, area, receipt date) that somebody can walk out and measure it.
 *
 * The registry read is deliberately NOT `resolveFields`. That walks the ladder —
 * piece → catalog item → subgroup → group → category — and would happily return
 * the catalog item's nominal length as this piece's length. That is exactly the
 * inherited default this script must not treat as a measurement, so the values
 * table is read flat, at the piece's own rung only.
 *
 * HOW IT WRITES. Through `setFields(companyId, 'stock_piece', pieceId, values,
 * conn)` — the 5th argument is the CONNECTION — not through UPDATE. Three
 * reasons: the columns are a PROJECTION written by that call, so going around it
 * would leave the value and its column disagreeing the moment anybody edits
 * either; it validates and converts units, so a legacy "6 m" lands in the column
 * as 6000 rather than as 6; and it upserts, so a re-run is a no-op rather than a
 * second row. The value is passed in the unit it was RECORDED in and setFields
 * does the conversion, so nothing rewrites the provenance of a value that was
 * already correct.
 *
 * ONE FALLBACK, reported separately: a company whose `fab_fields` has no
 * `length_mm` / `width_mm` definition has nowhere for setFields to put a value —
 * it would reject with "no such field". There the column is written directly,
 * guarded by `IS NULL`. Minting a field definition on the fly would be authoring
 * schema from a backfill script, which is a different job with different
 * consequences.
 *
 * Only pieces whose column is currently NULL are touched, and each dimension is
 * decided on its own — a piece that knows its width and not its length gets its
 * width. Nothing already sized is ever overwritten.
 *
 * Read-only unless you ask. Safe to re-run: a second pass finds nothing to do.
 *
 * Usage:
 *   node scripts/backfill-plate-sizes.mjs [companyId]           # dry run
 *   node scripts/backfill-plate-sizes.mjs [companyId] --dry     # same, explicit
 *   node scripts/backfill-plate-sizes.mjs [companyId] --apply   # write
 *
 * With no companyId it covers every company that owns stock pieces.
 */

import { pool } from '../db.js';
import { setFields, fieldRegistry, unitTable, convert } from '../apps/fab_erp/services/fieldService.js';

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const APPLY = args.includes('--apply') && !DRY;
const only = Number(args.find((a) => /^\d+$/.test(a))) || null;

const mode = APPLY ? 'APPLY' : 'DRY RUN';
console.log(`backfill-plate-sizes — ${mode}${APPLY ? '' : '  (re-run with --apply to write)'}`);

/** The two dimensions, and the legacy key each was fused into. */
const DIMS = [
  { key: 'length_mm', legacy: 'length', column: 'length_mm' },
  { key: 'width_mm', legacy: 'width', column: 'width_mm' },
];

/**
 * Unit spellings seen in fused strings, mapped onto `fab_units.code`.
 *
 * Deliberately short. An unrecognised unit is REFUSED, not guessed at — "2000 t"
 * is not a length however much the number looks like one.
 */
const UNIT_ALIASES = {
  mm: 'mm', millimetre: 'mm', millimeter: 'mm', mms: 'mm',
  cm: 'cm', centimetre: 'cm', centimeter: 'cm',
  m: 'm', mtr: 'm', mtrs: 'm', metre: 'm', meter: 'm', meters: 'm', metres: 'm',
  in: 'inch', inch: 'inch', inches: 'inch', '"': 'inch',
  ft: 'ft', foot: 'ft', feet: 'ft', "'": 'ft',
};

const units = await unitTable();

const [companies] = await pool.query(
  only
    ? 'SELECT id, name FROM companies WHERE id = ?'
    : `SELECT DISTINCT c.id, c.name FROM companies c
         JOIN fab_stock_pieces p ON p.company_id = c.id
        ORDER BY c.id`,
  only ? [only] : [],
);
if (!companies.length) {
  console.log('No company matched. Nothing to do.');
  await pool.end();
  process.exit(0);
}

const n = (v) => Number(v ?? 0);
const mm = (v) => (v == null ? '—' : `${Number(v)}`);

let grandUnresolved = 0;

for (const co of companies) {
  console.log(`\n══ ${co.name} (company ${co.id})`);

  const before = await snapshot(co.id);
  report('BEFORE', before);

  // Which of the two fields this company's registry actually defines. Decides
  // setFields vs the column fallback, and it is a per-company question.
  const registry = await fieldRegistry(co.id);
  const defined = Object.fromEntries(DIMS.map((d) => [d.key, registry.byKey.has(d.key)]));
  const anyDefined = Object.values(defined).some(Boolean);
  console.log(`\n  field registry: ${DIMS.map((d) => `${d.key} ${defined[d.key] ? 'defined' : 'NOT DEFINED'}`).join(' · ')}`);
  if (!anyDefined) {
    console.log('     → no field definitions here, so any fill writes the column directly');
  }

  // ── the candidates: live pieces missing at least one dimension ────────────
  const [pieces] = await pool.query(
    `SELECT p.id, p.code, p.length_mm, p.width_mm, p.status, p.received_date AS receivedDate,
            p.batch_no AS batchNo, p.catalog_item_id AS catalogItemId,
            ci.code AS itemCode, ci.name AS itemName, ci.material_form AS materialForm,
            l.name AS locationName,
            (SELECT r.id FROM fab_resources r
              WHERE r.company_id = p.company_id AND r.stock_piece_id = p.id
                AND r.deleted_at IS NULL LIMIT 1) AS machineId
       FROM fab_stock_pieces p
       LEFT JOIN fab_item_catalog ci ON ci.id = p.catalog_item_id
       LEFT JOIN fab_stock_locations l ON l.id = p.stock_location_id
      WHERE p.company_id = ? AND p.deleted_at IS NULL
        AND (p.length_mm IS NULL OR p.width_mm IS NULL)
      ORDER BY p.id`,
    [co.id],
  );
  console.log(`\n  1. pieces missing a dimension : ${pieces.length}`);
  if (!pieces.length) {
    report('AFTER', await snapshot(co.id));
    continue;
  }

  const ids = pieces.map((p) => p.id);
  const registryValues = await readRegistry(co.id, ids);
  const legacyValues = await readLegacy(co.id, ids);

  // ── decide, per piece per dimension ──────────────────────────────────────
  const plan = [];          // { piece, values:{key:{value,unit,src,mm}}, direct:{col:mm} }
  const disagreements = [];
  const unparsed = [];
  const unresolved = [];
  const counts = { registry: 0, legacy: 0, agreed: 0, disagreed: 0 };

  for (const p of pieces) {
    const values = {};      // for setFields
    const direct = {};      // column-only fallback, already in mm
    const missing = [];     // dimensions no source could answer for

    for (const d of DIMS) {
      if (p[d.column] != null) continue;                 // already sized — never overwritten
      const reg = registryValues.get(`${p.id}:${d.key}`) ?? null;
      const leg = legacyValues.get(`${p.id}:${d.legacy}`) ?? null;

      let parsedLegacy = null;
      if (leg != null) {
        const r = parseFused(leg);
        if (r.ok) parsedLegacy = r;
        else unparsed.push({ piece: p, dim: d.key, raw: leg, why: r.why });
      }

      const regMm = reg ? toMm(reg.value, reg.unit) : null;
      const legMm = parsedLegacy ? toMm(parsedLegacy.value, parsedLegacy.unit) : null;

      if (regMm != null && legMm != null) {
        if (Math.abs(regMm - legMm) > 0.001) {
          counts.disagreed++;
          disagreements.push({ piece: p, dim: d.key, regMm, legMm, raw: leg });
        } else {
          counts.agreed++;
        }
      }

      // The registry wins when both know. Disagreement is reported above, not resolved away.
      const chosen = regMm != null
        ? { value: reg.value, unit: reg.unit, src: 'registry', mm: regMm }
        : (legMm != null
          ? { value: parsedLegacy.value, unit: parsedLegacy.unit, src: `legacy "${leg}"`, mm: legMm }
          : null);

      if (!chosen) { missing.push(d.key); continue; }
      counts[regMm != null ? 'registry' : 'legacy']++;

      if (defined[d.key]) values[d.key] = { value: chosen.value, unit: chosen.unit, _src: chosen.src, _mm: chosen.mm };
      else direct[d.column] = { mm: chosen.mm, _src: chosen.src };
    }

    if (Object.keys(values).length || Object.keys(direct).length) plan.push({ piece: p, values, direct });
    if (missing.length) unresolved.push({ piece: p, missing });
  }

  console.log(`     resolvable   : ${plan.length} piece(s)`
    + `  — ${counts.registry} dimension(s) from the registry, ${counts.legacy} from a fused legacy string`);
  console.log(`     both sources agreed on ${counts.agreed} dimension(s), disagreed on ${counts.disagreed}`);

  for (const row of plan.slice(0, 12)) {
    const parts = [
      ...Object.entries(row.values).map(([k, v]) => `${k}=${mm(v._mm)}mm (${v._src})`),
      ...Object.entries(row.direct).map(([k, v]) => `${k}=${mm(v.mm)}mm (${v._src}, column only)`),
    ];
    console.log(`       ${String(row.piece.code ?? `#${row.piece.id}`).padEnd(12)} ${parts.join(' · ')}`);
  }
  if (plan.length > 12) console.log(`       …+${plan.length - 12} more`);

  // ── disagreements: reported, never resolved silently ─────────────────────
  console.log(`\n  2. DISAGREEMENTS between the two sources : ${disagreements.length}`);
  if (!disagreements.length) console.log('     (none)');
  for (const d of disagreements) {
    console.log(`     ${String(d.piece.code ?? `#${d.piece.id}`).padEnd(12)} ${d.dim}`
      + `  registry ${mm(d.regMm)}mm  vs  legacy ${mm(d.legMm)}mm (raw "${d.raw}")`
      + `  → registry used; CHECK THIS PIECE`);
  }

  // ── strings that are not a size ──────────────────────────────────────────
  console.log(`\n  3. legacy strings that could not be parsed : ${unparsed.length}`);
  if (!unparsed.length) console.log('     (none)');
  for (const u of unparsed.slice(0, 10)) {
    console.log(`     ${String(u.piece.code ?? `#${u.piece.id}`).padEnd(12)} ${u.dim} "${u.raw}" — ${u.why}`);
  }
  if (unparsed.length > 10) console.log(`     …+${unparsed.length - 10} more`);

  // ── write ────────────────────────────────────────────────────────────────
  if (APPLY && plan.length) {
    const conn = await pool.getConnection();
    let wrote = 0;
    let rejected = 0;
    let columnOnly = 0;
    try {
      await conn.beginTransaction();
      for (const row of plan) {
        if (Object.keys(row.values).length) {
          // The recorded unit is passed through; setFields converts to the
          // field's declared unit for the projection. See fieldService.
          const clean = Object.fromEntries(
            Object.entries(row.values).map(([k, v]) => [k, { value: v.value, unit: v.unit }]),
          );
          const res = await setFields(co.id, 'stock_piece', row.piece.id, clean, conn);
          wrote += res.written;
          for (const r of res.rejected ?? []) {
            rejected++;
            console.log(`     ! ${row.piece.code ?? `#${row.piece.id}`} ${r.fieldKey}: ${r.why}`);
          }
        }
        for (const [col, v] of Object.entries(row.direct)) {
          // Guarded by IS NULL: this can only ever fill a blank, never overwrite.
          const [r] = await conn.query(
            `UPDATE fab_stock_pieces SET \`${col}\` = ?
              WHERE id = ? AND company_id = ? AND \`${col}\` IS NULL`,
            [v.mm, row.piece.id, co.id],
          );
          columnOnly += r.affectedRows;
        }
      }
      await conn.commit();
      console.log(`\n     written via setFields : ${wrote} value(s)${rejected ? `  (${rejected} rejected)` : ''}`);
      console.log(`     written as column only: ${columnOnly} (no field definition in this company)`);
    } catch (e) {
      await conn.rollback();
      console.log(`\n     ! write failed, rolled back : ${e.message}`);
    } finally { conn.release(); }
  }

  // ── LEFT NULL, and who has to go and measure them ────────────────────────
  /**
   * A MACHINE IS ALSO A STOCK PIECE (Phase 8), so the raw "unsized pieces"
   * count is inflated by press brakes and cranes, which will never have a plate
   * length and are not what nesting looks at. They are separated rather than
   * excluded — a machine's piece still gets a size if a source recorded one —
   * so that the number a human has to go and measure is the real number.
   */
  const machines = unresolved.filter((u) => u.piece.machineId);
  const material = unresolved.filter((u) => !u.piece.machineId);
  console.log(`\n  4. LEFT NULL — no source knows the dimension : ${unresolved.length} piece(s)`
    + `, ${unresolved.reduce((a, u) => a + u.missing.length, 0)} dimension(s)`);
  console.log(`     of those, ${machines.length} are MACHINE assets (a machine is a stock piece too)`
    + ` — no plate size is expected and nesting never looks at them`);
  console.log(`     genuinely unmeasured material : ${material.length} piece(s)`);
  grandUnresolved += material.length;
  const byItem = new Map();
  for (const u of material) {
    const k = u.piece.itemCode ?? `item #${u.piece.catalogItemId ?? '—'}`;
    if (!byItem.has(k)) byItem.set(k, { name: u.piece.itemName, form: u.piece.materialForm, pieces: [] });
    byItem.get(k).pieces.push({ ...u.piece, _missing: u.missing });
  }
  for (const [code, g] of [...byItem].slice(0, 10)) {
    const [total] = g.pieces.length ? await pool.query(
      `SELECT COUNT(*) AS c FROM fab_stock_pieces
        WHERE company_id = ? AND deleted_at IS NULL AND catalog_item_id <=> ?`,
      [co.id, g.pieces[0].catalogItemId ?? null],
    ) : [[{ c: 0 }]];
    console.log(`     ${String(code).padEnd(22)} ${String(g.pieces.length).padStart(3)} of ${n(total[0].c)} piece(s)`
      + `  [${g.form ?? 'no material form'}]  ${g.name ?? ''}`);
    for (const p of g.pieces.slice(0, 3)) {
      console.log(`         ${String(p.code ?? `#${p.id}`).padEnd(12)}`
        + ` needs ${p._missing.join(' + ')}`
        + ` · ${p.locationName ?? 'no area'}`
        + ` · received ${p.receivedDate ?? 'unknown'}`
        + ` · batch ${p.batchNo ?? '—'}`);
    }
    if (g.pieces.length > 3) console.log(`         …+${g.pieces.length - 3} more of this item`);
  }
  if (byItem.size > 10) console.log(`     …+${byItem.size - 10} more item(s)`);
  if (material.length) {
    console.log('     These need a human with a tape measure. Nothing here can infer them:');
    console.log('     a sibling piece, a catalog default and a "standard" plate size are all');
    console.log('     guesses, and a guessed size makes nesting match a plate that does not exist.');
  }

  report('AFTER', await snapshot(co.id));
}

console.log(APPLY
  ? `\nDone. ${grandUnresolved} piece(s) still unsized and cannot be. Re-run to confirm it is a no-op.`
  : `\nNothing was written. ${grandUnresolved} piece(s) have no source at all. Re-run with --apply for the rest.`);

await pool.end();

// ---------------------------------------------------------------------------

/**
 * Piece-level registry values, read FLAT.
 *
 * Not `resolveFields`: that walks the ladder up to the catalog item and would
 * return an inherited nominal length as though it were this plate's measurement.
 */
async function readRegistry(companyId, pieceIds) {
  const out = new Map();
  if (!pieceIds.length) return out;
  const [rows] = await pool.query(
    `SELECT v.scope_id AS pieceId, f.field_key AS fieldKey, v.value_num AS valueNum,
            v.value_text AS valueText, v.unit_code AS unitCode, f.default_unit AS defaultUnit
       FROM fab_field_values v
       JOIN fab_fields f ON f.id = v.field_id AND f.deleted_at IS NULL
      WHERE v.company_id = ? AND v.scope = 'stock_piece' AND v.deleted_at IS NULL
        AND f.field_key IN ('length_mm', 'width_mm')
        AND v.scope_id IN (${pieceIds.map(() => '?').join(',')})`,
    [companyId, ...pieceIds],
  );
  for (const r of rows) {
    // A number field storing its number in value_text is not a fact this script
    // is willing to read as a measurement — it is a row somebody wrote wrong.
    if (r.valueNum == null) continue;
    out.set(`${r.pieceId}:${r.fieldKey}`, {
      value: Number(r.valueNum),
      unit: r.unitCode ?? r.defaultUnit ?? 'mm',
    });
  }
  return out;
}

/**
 * Legacy fused strings.
 *
 * `level` is matched on both spellings: 'stock_piece' is the current vocabulary
 * and 'piece' is the older one that the field importer maps onto the same rung
 * (see verify-legacy-divergence.mjs check 7). Reading only one of them would
 * miss half the recorded sizes on any database old enough to have both.
 */
async function readLegacy(companyId, pieceIds) {
  const out = new Map();
  if (!pieceIds.length) return out;
  const [rows] = await pool.query(
    `SELECT level_id AS pieceId, LOWER(field_key) AS k, field_value AS v, id
       FROM fab_custom_fields
      WHERE company_id = ? AND deleted_at IS NULL
        AND level IN ('stock_piece', 'piece')
        AND LOWER(field_key) IN ('length', 'width')
        AND level_id IN (${pieceIds.map(() => '?').join(',')})
      ORDER BY id`,
    [companyId, ...pieceIds],
  );
  // Later id wins if the same key was recorded twice — the last thing written.
  for (const r of rows) out.set(`${r.pieceId}:${r.k}`, r.v);
  return out;
}

/**
 * "2000 mm" -> { value: 2000, unit: 'mm' }, or a refusal with a reason.
 *
 * A bare number is read as the field's declared unit (mm) — that is what
 * `length_mm` means and what every fused string in the wild has spelled out
 * anyway. Anything else is refused rather than coerced: a size is worth having
 * only if it is the size.
 */
function parseFused(raw) {
  if (raw == null) return { ok: false, why: 'empty' };
  const s = String(raw).trim();
  if (!s) return { ok: false, why: 'empty' };
  const m = s.match(/^([+-]?\d+(?:[.,]\d+)?)\s*([A-Za-z"']*)\.?$/);
  if (!m) return { ok: false, why: 'not a number followed by an optional unit' };
  const value = Number(m[1].replace(',', '.'));
  if (!Number.isFinite(value)) return { ok: false, why: 'not a finite number' };
  if (value <= 0) return { ok: false, why: `${value} is not a positive length` };
  const token = (m[2] || '').toLowerCase();
  if (!token) return { ok: true, value, unit: 'mm', assumed: true };
  const unit = UNIT_ALIASES[token];
  if (!unit) return { ok: false, why: `"${m[2]}" is not a unit this database knows` };
  if (!units.has(unit)) return { ok: false, why: `unit "${unit}" is not in fab_units` };
  if (units.get(unit).dimension !== 'length') return { ok: false, why: `"${unit}" is not a length` };
  return { ok: true, value, unit };
}

/** Both sources onto one scale, so a disagreement is a real disagreement. */
function toMm(value, unit) {
  if (value == null) return null;
  const c = convert(Number(value), unit ?? 'mm', 'mm', units);
  return c ? c.value : null;
}

async function snapshot(companyId) {
  const [[p]] = await pool.query(
    `SELECT COUNT(*) total,
            SUM(length_mm IS NULL) noLength,
            SUM(width_mm IS NULL) noWidth,
            SUM(length_mm IS NULL AND width_mm IS NULL) neither,
            SUM(length_mm IS NOT NULL AND width_mm IS NOT NULL) fullySized
       FROM fab_stock_pieces WHERE company_id = ? AND deleted_at IS NULL`,
    [companyId],
  );
  return p;
}

function report(label, s) {
  console.log(`\n  ${label}`);
  console.log(`     live pieces ${n(s.total)} · fully sized ${n(s.fullySized)}`
    + ` · missing length ${n(s.noLength)} · missing width ${n(s.noWidth)}`
    + ` · missing both ${n(s.neither)}`);
}
