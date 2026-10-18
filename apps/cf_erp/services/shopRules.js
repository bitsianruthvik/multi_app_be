/**
 * shopRules.js — CF_ERP. The shop's cutting habits, as a company setting per plate thickness
 * (2026-10-18, learned from the shop's 16 ProNest job files: TM/nest_learning/LEARNINGS.md).
 *
 *   SHOP_DEFAULTS, SHOP_KERF_POINTS      what the files say, used for anything not set
 *   shopRulesFor(thickness, saved)       the rules for one thickness: saved rows (nearest thickness that
 *                                        sets a field) over the file defaults — "interpolate / nearest"
 *   withShopSpacing(settings, rules)     cut settings (nestingService.pickCutSettings) with the shop's
 *                                        spacing laid over them, when the company switched it on
 *   shopRimOf(settings)                  the plate-edge clearance both packers are handed
 *   readShopRules(db, companyId)         { on, rows, schema } — tolerant of init.sql §75 not applied yet
 *   saveShopRules(db, c, input)          the setting screen's save: a fixed number of statements
 *
 * WHAT THE SWITCH DOES (cf_company_settings.nest_shop_spacing, OFF until a person turns it on, so no
 * existing plan changes under anybody): the plate-edge margin becomes `edgeMarginMm` (5) instead of one
 * kerf, and the clearance between two sequences of the row layout (= between two shared-line blocks)
 * becomes `groupGapMm` (13) instead of 5–8. Inside a shared-line block parts stay exactly one kerf apart
 * (the common cut); two parts cut separately in a row stand two kerfs apart, which is the part gap or
 * more at every kerf the shop uses (2 × 3 = 6 ≥ 5). The KERF itself stays cf_cut_settings.kerf_mm — the
 * one owner of that number — and `shopKerfMm` only says what the files used, so a difference shows.
 *
 * Leads, pierce, kerf side, cut order and marking are not spacing: they are used by the AI cut plan
 * (services/aiCutPlan.js) on every plate whatever the switch says.
 */

/** The kerf the shop's files used, by thickness (mm). Between points: the nearest (a tie takes the wider). */
export const SHOP_KERF_POINTS = Object.freeze([
  Object.freeze({ t: 10, kerfMm: 3 }), Object.freeze({ t: 12, kerfMm: 3 }), Object.freeze({ t: 16, kerfMm: 3 }),
  Object.freeze({ t: 20, kerfMm: 4 }), Object.freeze({ t: 25, kerfMm: 4 }),
  Object.freeze({ t: 36, kerfMm: 5 }), Object.freeze({ t: 45, kerfMm: 5 }),
]);

/** Everything else, the same at every thickness in the files. */
export const SHOP_DEFAULTS = Object.freeze({
  edgeMarginMm: 5,          // plate edge → part
  partGapMm: 5,             // two parts cut separately
  groupGapMm: 13,           // between shared-line blocks (room for the next block's lead-in)
  leadInMm: 6,              // outline: straight, in line with the first edge, starting at a part corner
  leadOutMm: 2,             // outline: straight, in line with the last edge; no overcut
  holeLeadRadiusMm: 6,      // hole: arc lead-in, 90°
  holeLeadOutMm: 2,
  sharedLeadInMm: 6.35,     // a common-line stroke
  sharedLeadOutMm: 1.27,
  pierceOffsetMm: 6,        // pierce in the scrap this far off the part
  overcutMm: 0,
  freeRotationStepDeg: null, // null = only 0 / 90 / 180 / 270 (all the shop ever used)
});

import { invalid, conflict } from '../lib/errors.js';

/** The columns of cf_nest_shop_rules ↔ the rule names. */
const COLS = Object.freeze({
  kerfMm: 'kerf_mm', edgeMarginMm: 'edge_margin_mm', partGapMm: 'part_gap_mm', groupGapMm: 'group_gap_mm',
  leadInMm: 'lead_in_mm', leadOutMm: 'lead_out_mm', holeLeadRadiusMm: 'hole_lead_radius_mm', holeLeadOutMm: 'hole_lead_out_mm',
  sharedLeadInMm: 'shared_lead_in_mm', sharedLeadOutMm: 'shared_lead_out_mm', pierceOffsetMm: 'pierce_offset_mm',
  freeRotationStepDeg: 'free_rotation_step_deg',
});
export const SHOP_RULE_FIELDS = Object.freeze(Object.keys(COLS));

const num = (v) => (v == null || v === '' ? null : Number(v));
const isMissing = (e) => ['ER_NO_SUCH_TABLE', 'ER_BAD_FIELD_ERROR'].includes(e?.code) || [1146, 1054].includes(e?.errno);

/** The files' kerf for a thickness: the nearest point; a tie (18 mm: 16 or 20) takes the wider kerf. */
export function shopKerfFor(thicknessMm) {
  const t = Number(thicknessMm);
  if (!(t > 0)) return SHOP_KERF_POINTS[0].kerfMm;
  let best = null;
  for (const p of SHOP_KERF_POINTS) {
    const d = Math.abs(p.t - t);
    if (!best || d < best.d - 1e-9 || (Math.abs(d - best.d) <= 1e-9 && p.kerfMm > best.kerfMm)) best = { d, kerfMm: p.kerfMm };
  }
  return best.kerfMm;
}

/**
 * The shop rules for one thickness. `saved` = rows { thickness_mm, …columns } (readShopRules().rows):
 * for every field, the row of the NEAREST thickness that sets it wins (tie → the thicker) — as long as it
 * is no further than the nearest thickness the files were seen at (10, 12, 16, 20, 25, 36, 45); else, and
 * for a field no row sets, the file default. `source[field]` says which ('saved 16 mm' | 'files').
 */
export function shopRulesFor(thicknessMm, saved = []) {
  const t = Number(thicknessMm);
  const out = { thicknessMm: Number.isFinite(t) ? t : null, ...SHOP_DEFAULTS, kerfMm: shopKerfFor(t), source: {} };
  // The files are a source too, at the thicknesses they were seen at: a saved row only wins where it is
  // at least as near as the nearest of those (a 16 mm row does not decide 40 mm plate).
  const fileD = Number.isFinite(t) ? Math.min(...SHOP_KERF_POINTS.map((p) => Math.abs(p.t - t))) : Infinity;
  for (const f of SHOP_RULE_FIELDS) {
    let best = null;
    for (const r of saved ?? []) {
      const v = num(r[COLS[f]] ?? r[f]);
      const rt = num(r.thickness_mm ?? r.thicknessMm);
      if (v == null || rt == null || !Number.isFinite(v)) continue;
      const d = Number.isFinite(t) ? Math.abs(rt - t) : 0;
      if (!best || d < best.d - 1e-9 || (Math.abs(d - best.d) <= 1e-9 && rt > best.rt)) best = { d, rt, v };
    }
    if (best && best.d <= fileD + 1e-9) { out[f] = best.v; out.source[f] = `saved ${best.rt} mm`; } else out.source[f] = 'files';
  }
  out.shopKerfMm = out.kerfMm;
  return out;
}

/**
 * Cut settings with the shop's spacing over them — only when `shop.on`. The kerf is NOT replaced
 * (cf_cut_settings owns it); `shopKerfMm` and `kerfDiffers` say when the files used another one.
 */
export function withShopSpacing(settings, shop, thicknessMm) {
  if (!shop?.on) return settings;
  const r = shopRulesFor(thicknessMm, shop.rows);
  const k = Number(settings.kerfMm) || 0;
  const group = Math.max(Number(r.groupGapMm) || 0, k);
  return {
    ...settings,
    seqGapMinMm: group,
    seqGapMaxMm: Math.max(Number(settings.seqGapMaxMm) || 0, group),
    edgeMarginMm: Math.max(Number(r.edgeMarginMm) || 0, k),
    partGapMm: Number(r.partGapMm) || 0,
    groupGapMm: group,
    shopKerfMm: r.kerfMm,
    kerfDiffers: Math.abs(r.kerfMm - k) > 1e-6,
    freeRotationStepDeg: r.freeRotationStepDeg ?? null,
    shopSpacing: true,
    basis: `${settings.basis}; shop spacing (AI): edge ${r.edgeMarginMm} mm, blocks ${group} mm apart`,
  };
}

/**
 * The plate-edge clearance each packer is handed: nestShapes.rimOf(kerf) as always, or — with shop
 * spacing — the edge margin. nestingPacker charges one kerf at the rim itself (`rectMargin` is what it
 * adds on top); shapePacker takes the whole clearance (`shapeMargin`).
 */
export function shopRimOf(settings, rimOf) {
  const base = rimOf(settings.kerfMm);
  if (!settings?.shopSpacing) return base;
  const k = base.kerf;
  const edge = Math.max(Number(settings.edgeMarginMm) || 0, k);
  return { ...base, rectMargin: Math.max(0, edge - k), shapeMargin: edge, clearance: edge };
}

/** The rotations the true-shape packer may use: quarter turns, or every `step` degrees when the setting asks. */
export function rotationsOf(settings) {
  const step = Number(settings?.freeRotationStepDeg);
  return step > 0 && step < 90 ? { stepDeg: step } : [0, 90, 180, 270];
}

/**
 * The company's switch and saved rows. Two statements at most; one when the schema is not there yet.
 * Never throws for a missing table or column (init.sql §75 not applied): { on: false, rows: [], schema: false }.
 */
export async function readShopRules(db, companyId) {
  let on = false;
  try {
    const [[s]] = await db.query('SELECT nest_shop_spacing FROM cf_company_settings WHERE company_id = ?', [companyId]);
    on = !!Number(s?.nest_shop_spacing ?? 0);
  } catch (e) {
    if (!isMissing(e)) throw e;
    return { on: false, rows: [], schema: false };
  }
  try {
    const [rows] = await db.query(
      `SELECT id, thickness_mm, ${Object.values(COLS).join(', ')}, notes
         FROM cf_nest_shop_rules WHERE company_id = ? AND deleted_at IS NULL ORDER BY thickness_mm`,
      [companyId],
    );
    return { on, rows, schema: true };
  } catch (e) {
    if (!isMissing(e)) throw e;
    return { on: false, rows: [], schema: false };
  }
}

/** Only the per-thickness rows (the caller knows the switch is on): ONE statement. */
export async function shopRuleRows(db, companyId) {
  const [rows] = await db.query(
    `SELECT id, thickness_mm, ${Object.values(COLS).join(', ')}, notes
       FROM cf_nest_shop_rules WHERE company_id = ? AND deleted_at IS NULL ORDER BY thickness_mm`,
    [companyId],
  );
  return rows;
}

/** The screen's view: the switch, the saved rows, and the rules worked out at the shop's thicknesses. */
export async function getShopRules(db, companyId) {
  const s = await readShopRules(db, companyId);
  const thick = [...new Set([...SHOP_KERF_POINTS.map((p) => p.t), ...s.rows.map((r) => Number(r.thickness_mm))])].sort((a, b) => a - b);
  return {
    on: s.on,
    schema: s.schema,
    defaults: { ...SHOP_DEFAULTS, kerf: SHOP_KERF_POINTS },
    rows: s.rows.map((r) => ({ id: r.id, thicknessMm: Number(r.thickness_mm), ...Object.fromEntries(SHOP_RULE_FIELDS.map((f) => [f, num(r[COLS[f]])])), notes: r.notes ?? null })),
    resolved: thick.map((t) => shopRulesFor(t, s.rows)),
  };
}

const bad = (msg) => invalid('INVALID_SHOP_RULES', msg);

/**
 * Save the whole setting: `{ on?: boolean, rows?: [{ thicknessMm, kerfMm?, edgeMarginMm?, … }] }`.
 * `rows` replaces the saved rows (a thickness left out is soft-deleted; a blank field = the file
 * default). THREE statements whatever the number of rows: the switch, the upsert, the soft delete.
 */
export async function saveShopRules(db, c, input = {}) {
  const companyId = c.companyId;
  const s = await readShopRules(db, companyId);
  if (!s.schema) throw conflict('SCHEMA_MISSING', 'The shop rules need init.sql §75 (TM/s75.sql) applied to this database first.');
  if (input.on != null) {
    await db.query(
      `INSERT INTO cf_company_settings (company_id, nest_shop_spacing, updated_by) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE nest_shop_spacing = VALUES(nest_shop_spacing), updated_by = VALUES(updated_by)`,
      [companyId, input.on ? 1 : 0, c.userId ?? null],
    );
  }
  if (Array.isArray(input.rows)) {
    const seen = new Set();
    const vals = [];
    for (const [i, r] of input.rows.entries()) {
      const t = num(r?.thicknessMm);
      if (!(t > 0 && t <= 300)) throw bad(`Row ${i + 1}: a thickness between 0 and 300 mm is needed.`);
      const key = Math.round(t * 1000);
      if (seen.has(key)) throw bad(`Row ${i + 1}: ${t} mm is listed twice.`);
      seen.add(key);
      const row = [companyId, t];
      for (const f of SHOP_RULE_FIELDS) {
        const v = num(r[f]);
        if (v != null && !(Number.isFinite(v) && v >= 0 && v <= (f === 'freeRotationStepDeg' ? 90 : 500))) throw bad(`Row ${i + 1}: ${f} must be a number of mm (0–500)${f === 'freeRotationStepDeg' ? ' — or degrees 0–90' : ''}, or blank.`);
        row.push(f === 'freeRotationStepDeg' && v === 0 ? null : v);
      }
      row.push(r.notes == null ? null : String(r.notes).slice(0, 500), c.userId ?? null);
      vals.push(row);
    }
    const cols = Object.values(COLS);
    if (vals.length) {
      await db.query(
        `INSERT INTO cf_nest_shop_rules (company_id, thickness_mm, ${cols.join(', ')}, notes, created_by) VALUES ?
         ON DUPLICATE KEY UPDATE ${[...cols, 'notes'].map((col) => `${col} = VALUES(${col})`).join(', ')}, deleted_at = NULL`,
        [vals],
      );
    }
    const keep = [...seen].map((k) => k / 1000);
    await db.query(
      `UPDATE cf_nest_shop_rules SET deleted_at = NOW()
        WHERE company_id = ? AND deleted_at IS NULL ${keep.length ? 'AND thickness_mm NOT IN (?)' : ''}`,
      keep.length ? [companyId, keep] : [companyId],
    );
  }
  return getShopRules(db, companyId);
}
