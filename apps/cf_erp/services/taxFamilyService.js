/**
 * taxFamilyService.js — HSN / GST BY CATALOG FAMILY (2026-10-18). The PO showed "GST ₹0 — no GST rate": not one of the
 * company's catalog items had an HSN code or a GST rate. Setting them item by item is hopeless, so Setup › Company tax
 * details offers it per FAMILY (a classification node and everything under it): all MS plates 7208 / 18 %, sections
 * 7216 / 18 %, studs 7318 / 18 % …
 *
 * Rules: the rate must be on the company's GST rate list (Setup › Company tax details) — nothing is hardcoded; the
 * SUGGESTED defaults below are only shown, the user confirms each family. "Fill the gaps" (default) sets only items that
 * have no HSN / no rate; "overwrite" replaces what is there. Templates (definitions) in the family are set too: a made
 * (temporary) item reads its template's HSN / rate (taxService.itemTaxOf).
 */
import { invalid, assertNoProblems } from '../lib/errors.js';
import { companyTax, readHsn, readGstRate } from './taxService.js';

/** Suggested defaults, matched on the family's path. Shown only; never applied without the user. */
export const SUGGESTED_DEFAULTS = [
  { match: /scrap/i, hsnCode: '7204', gstRate: 18, why: 'Steel scrap (7204)' },
  { match: /stud|bolt|nut\b|nuts|screw|washer|fastener|rivet/i, hsnCode: '7318', gstRate: 18, why: 'Screws, bolts, studs, nuts (7318)' },
  { match: /angle|beam|channel|section|joist|tee\b|isa|ismb|ismc|isjc|isnb|flat bar/i, hsnCode: '7216', gstRate: 18, why: 'Angles, shapes and sections (7216)' },
  { match: /plate|sheet|coil/i, hsnCode: '7208', gstRate: 18, why: 'Flat-rolled steel — MS plates (7208)' },
  { match: /pipe|tube|hollow/i, hsnCode: '7306', gstRate: 18, why: 'Tubes and pipes (7306)' },
];

/** The suggestion for a family path (pure). Made / cut / offcut families are not bought: no suggestion. */
export function suggestFor(path, rates) {
  if (/cut plate|cut section|offcut|plate part|profile part|assembl|girder|structure|fabricated/i.test(path)) return null;
  const s = SUGGESTED_DEFAULTS.find((d) => d.match.test(path));
  if (!s) return null;
  const onList = (rates ?? []).some((r) => Math.abs(Number(r) - s.gstRate) < 1e-9);
  return { hsnCode: s.hsnCode, gstRate: s.gstRate, why: s.why, rateOnList: onList };
}

/** Every node of the company with its path and its subtree. 1 read. */
async function nodeTree(db, companyId) {
  const [nodes] = await db.query("SELECT id, parent_id, name FROM cf_classification_nodes WHERE company_id = ? AND deleted_at IS NULL AND scope IN ('item', 'both')", [companyId]);
  const byId = new Map(nodes.map((n) => [Number(n.id), { id: Number(n.id), parentId: n.parent_id == null ? null : Number(n.parent_id), name: n.name, kids: [] }]));
  for (const n of byId.values()) if (n.parentId && byId.has(n.parentId)) byId.get(n.parentId).kids.push(n.id);
  const pathOf = (id) => { const out = []; let n = byId.get(id); let guard = 0; while (n && guard++ < 20) { out.unshift(n.name); n = n.parentId ? byId.get(n.parentId) : null; } return out.join(' › '); };
  const subtree = (id) => { const out = []; const stack = [id]; while (stack.length) { const x = stack.pop(); out.push(x); stack.push(...(byId.get(x)?.kids ?? [])); } return out; };
  return { byId, pathOf, subtree };
}

/**
 * GET /tax/families — the families that hold catalog items (bought / stocked: not made items), each with how many
 * items lack an HSN code or a GST rate, what they have now, and a suggestion. 3 reads.
 */
export async function familyTaxView(db, companyId) {
  const [{ gstRates }, tree, [rows]] = await Promise.all([
    companyTax(db, companyId),
    nodeTree(db, companyId),
    db.query(
      `SELECT m.classification_id AS node_id, COUNT(*) AS items, SUM(i.hsn_code IS NULL) AS no_hsn, SUM(i.gst_rate IS NULL) AS no_rate,
              GROUP_CONCAT(DISTINCT i.hsn_code ORDER BY i.hsn_code SEPARATOR ',') AS hsn_codes, GROUP_CONCAT(DISTINCT i.gst_rate ORDER BY i.gst_rate SEPARATOR ',') AS rates
         FROM cf_master_records m JOIN cf_item_details i ON i.master_id = m.id AND i.deleted_at IS NULL
        WHERE m.company_id = ? AND m.record_kind = 'item' AND m.deleted_at IS NULL AND i.item_type <> 'temporary' AND m.classification_id IS NOT NULL
        GROUP BY m.classification_id`,
      [companyId]),
  ]);
  const families = rows.filter((r) => tree.byId.has(Number(r.node_id))).map((r) => {
    const path = tree.pathOf(Number(r.node_id));
    return {
      nodeId: Number(r.node_id), path, items: Number(r.items), noHsn: Number(r.no_hsn), noRate: Number(r.no_rate),
      hsnCodes: r.hsn_codes ? String(r.hsn_codes).split(',') : [], rates: r.rates ? String(r.rates).split(',').map(Number) : [],
      suggestion: suggestFor(path, gstRates),
    };
  }).sort((a, b) => (b.noRate + b.noHsn) - (a.noRate + a.noHsn) || a.path.localeCompare(b.path));
  return {
    gstRates, families,
    gaps: { items: families.reduce((t, f) => t + f.items, 0), noHsn: families.reduce((t, f) => t + f.noHsn, 0), noRate: families.reduce((t, f) => t + f.noRate, 0) },
  };
}

/**
 * PUT /tax/families/:nodeId { hsnCode?, gstRate?, overwrite?, dryRun? } — sets the family (the node and everything
 * under it): catalog items and templates. Only the gaps unless overwrite. → { items, definitions, dryRun }.
 */
export async function applyFamilyTax(db, c, nodeId, input = {}) {
  const problems = [];
  const { gstRates } = await companyTax(db, c.companyId);
  const hsnGiven = input.hsnCode != null && String(input.hsnCode).trim() !== '';
  const rateGiven = input.gstRate != null && String(input.gstRate).trim() !== '';
  if (!hsnGiven && !rateGiven) problems.push('Give the HSN code, the GST rate or both.');
  const hsn = hsnGiven ? readHsn(input.hsnCode, false, problems) : null;
  const rate = rateGiven ? readGstRate(input.gstRate, gstRates, problems) : null;
  const tree = await nodeTree(db, c.companyId);
  if (!tree.byId.has(Number(nodeId))) problems.push('That catalog family is not there.');
  assertNoProblems(problems, 'The family cannot be set.');
  const nodes = tree.subtree(Number(nodeId));
  const overwrite = !!input.overwrite;
  const sets = []; const args = [];
  if (hsnGiven) { sets.push(overwrite ? 'x.hsn_code = ?' : 'x.hsn_code = COALESCE(x.hsn_code, ?)'); args.push(hsn); }
  if (rateGiven) { sets.push(overwrite ? 'x.gst_rate = ?' : 'x.gst_rate = COALESCE(x.gst_rate, ?)'); args.push(rate); }
  const gap = overwrite ? '1 = 1' : [hsnGiven ? 'x.hsn_code IS NULL' : null, rateGiven ? 'x.gst_rate IS NULL' : null].filter(Boolean).join(' OR ');
  const [[ic], [dc]] = await Promise.all([
    db.query(
      `SELECT COUNT(*) AS n FROM cf_item_details x JOIN cf_master_records m ON m.id = x.master_id AND m.deleted_at IS NULL
        WHERE x.company_id = ? AND x.deleted_at IS NULL AND x.item_type <> 'temporary' AND m.classification_id IN (?) AND (${gap})`, [c.companyId, nodes]),
    db.query(
      `SELECT COUNT(*) AS n FROM cf_definition_details x JOIN cf_master_records m ON m.id = x.master_id AND m.deleted_at IS NULL
        WHERE x.company_id = ? AND x.deleted_at IS NULL AND m.classification_id IN (?) AND (${gap})`, [c.companyId, nodes]),
  ]);
  const counts = { items: Number(ic[0]?.n ?? 0), definitions: Number(dc[0]?.n ?? 0) };
  const path = tree.pathOf(Number(nodeId));
  if (input.dryRun) return { dryRun: true, path, ...counts, overwrite };
  if (!counts.items && !counts.definitions) throw invalid('NOTHING_TO_SET', overwrite ? `Nothing in ${path}.` : `Every item in ${path} already has ${hsnGiven && rateGiven ? 'an HSN code and a GST rate' : hsnGiven ? 'an HSN code' : 'a GST rate'}. Tick "overwrite" to replace them.`);
  await db.query(
    `UPDATE cf_item_details x JOIN cf_master_records m ON m.id = x.master_id AND m.deleted_at IS NULL SET ${sets.join(', ')}
      WHERE x.company_id = ? AND x.deleted_at IS NULL AND x.item_type <> 'temporary' AND m.classification_id IN (?) AND (${gap})`,
    [...args, c.companyId, nodes]);
  await db.query(
    `UPDATE cf_definition_details x JOIN cf_master_records m ON m.id = x.master_id AND m.deleted_at IS NULL SET ${sets.join(', ')}
      WHERE x.company_id = ? AND x.deleted_at IS NULL AND m.classification_id IN (?) AND (${gap})`,
    [...args, c.companyId, nodes]);
  return { dryRun: false, path, ...counts, overwrite, hsnCode: hsn, gstRate: rate };
}
