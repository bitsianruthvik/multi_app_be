/**
 * standardSectionDecisionService.js — a person's decision about a standard drawing's section size, written as a NEW
 * VERSION of the standard (2026-10-19). Body of scripts/cf_kepl/rdso-b516-angles.mjs; tested in standard_gaps_test (12).
 *
 * RDSO/B-516 draws its X-frame angles D and HA as "L 100x75 (thickness not shown)". The user decided (2026-10-19) they
 * are ISA 100 x 75 x 8: the drawing gives no thickness, sister RDSO drawings use 8. Two steps, ONE transaction:
 *
 *   ensureSizeBars  the catalog has a bar of the decided size for every stock length and grade / impact class the
 *                   family it is made like has (ISA 100 x 100 x 10: E250/E350 × BO/BR × each length). A missing one is
 *                   made the way the section picker's "Add this size to the catalog" makes it (SectionPicker →
 *                   CreateRecordDialog copyFrom the bar of the nearest size): the like bar's place, unit, tracking,
 *                   sourcing, short name, description, revision and its own typed values, with DEPTH / WIDTH / THICKNESS
 *                   of the new size (lib/sectionPick.newSizeValues: the longer leg where the like bar has its longer
 *                   one); the code from the coding rule (CFRM-STEEL; checked to be the family's code with the size replaced),
 *                   the name typed as the family's with the size replaced (no naming rule applies to these bars — in
 *                   the dialog a person types it).
 *                   Two things the dialog does not do and this does: SECTION_AREA is the new size's t (a + b − t) (the
 *                   catalog's angle formula, standardImport.js) — the dialog would copy the like bar's area, so the new
 *                   bar would weigh as the old size; and HSN / GST are the like bar's (the dialog leaves them empty).
 *                   A bar of the size already there (same length and grade/class) is reused, never changed.
 *   applyDecision   the standard's CURRENT version is copied into the NEXT version (standardGapFixService.copyVersion,
 *                   made_from 'decision'); on the NEW rows whose drawing profile is the undecided one: the bar of the
 *                   decided size (only where the row has none), THICKNESS and SECTION_AREA (only where empty — through
 *                   valueService.setValues, which settles the row's WEIGHT and its parents' rolled-up WEIGHT), the BOM
 *                   line's words ("100 x 75 (thickness not shown)" → "100 x 75 x 8", the open decision note → the
 *                   decision); then filled until the drawing settles nothing more (fillUntilSettled) and made current;
 *                   the version's weight_kg follows the top row's WEIGHT; the standard's notes get the decision once.
 *                   No existing version is written (an order line's version — SO260014: RDSO/B-11753R3 v1 — is only read).
 *   IDEMPOTENT: when the current version's rows hold all of it, nothing is written.
 */
import { copyVersion, fillUntilSettled, DEFAULT_BOM_DIR } from './standardGapFixService.js';
import { parseSectionSize, profileOfName } from '../lib/sectionSize.js';

/** The user's decision of 2026-10-19 for RDSO/B-516. */
export const B516_ANGLES = {
  number: 'RDSO/B-516',
  undecided: /100\s*x\s*75\b.*thickness not shown/i,
  size: 'ISA 100 x 75 x 8',
  family: 'ISA 100 x 100 x 10',
  sectionClass: 'BR',
  defaultGrade: 'E250',
  textFrom: /100 x 75 \(thickness not shown\)/gi,
  textTo: '100 x 75 x 8',
  noteFrom: /NEEDS DECISION N2: Thickness of the X-frame angles D and HA/g,
  why: 'thickness 8 mm assumed by the user 2026-10-19: drawing B-516 gives none; sister RDSO drawings use 8',
};
const decidedNote = (d) => `DECIDED N2: the X-frame angles D and HA are ${d.size} (${d.why})`;

const r3 = (x) => Math.round(Number(x) * 1000) / 1000;
const tailOf = (code) => String(code ?? '').toUpperCase().split('-').pop();   // "E250BR"
/** "ISA-100X100X10X12000-E250BR" → "ISA-100X75X8X12000-E250BR"; names the same way ("100 x 100 x 10" → "100 x 75 x 8"). */
const sizeToken = (dims, sep) => dims.map((x) => String(x)).join(sep);

/** Steel area of an angle, t (a + b − t), mm² (the catalog's and the importer's formula; no root fillet). */
export const angleArea = (a, b, t) => t * (a + b - t);

/** The bars of exactly this size (the section picker's read) with their steel. */
async function barsOfSize(db, companyId, text) {
  const { sectionNearest } = await import('../routes/cutting.js');
  const size = parseSectionSize(text);
  const r = await sectionNearest(db, companyId, { search: text });
  return (r.exact ?? []).filter((b) => !size.profile || profileOfName(b.name) === size.profile);
}

/**
 * Every bar of `family` has a twin of `size` (same stock length and grade / class). → { family: n, reused: [bar],
 * created: [{ id, code, name, like }], planned: [{ code, name, like }] } — `planned` on a dry run (nothing written).
 */
export async function ensureSizeBars(db, c, { family, size, commit = false, log = () => {} }) {
  const { companyId } = c;
  const fam = parseSectionSize(family);
  const want = parseSectionSize(size);
  if (fam?.dims.length !== 3 || want?.dims.length !== 3) throw new Error(`cf_erp: sizes are "ISA a x b x t" (${family} / ${size})`);
  const [a, b, t] = want.dims;
  const famBars = await barsOfSize(db, companyId, family);
  const have = await barsOfSize(db, companyId, size);
  const keyOf = (bar) => `${Number(bar.lengthMm)}|${tailOf(bar.code)}`;
  const haveBy = new Map(have.map((bar) => [keyOf(bar), bar]));
  const out = { family: famBars.length, reused: [], created: [], planned: [] };
  if (!famBars.length) throw new Error(`cf_erp: no catalog bar of ${family} to make ${size} like`);
  const codeFrom = (code) => String(code).replace(sizeToken(fam.dims, 'X'), sizeToken(want.dims, 'X'));
  const nameFrom = (name) => String(name).replace(sizeToken(fam.dims, ' x '), sizeToken(want.dims, ' x '));

  for (const like of famBars.sort((x, y) => String(x.code).localeCompare(String(y.code)))) {
    const there = haveBy.get(keyOf(like));
    if (there) { out.reused.push(there); continue; }
    const expect = { code: codeFrom(like.code), name: nameFrom(like.name) };
    if (!commit) { out.planned.push({ ...expect, like: like.code, lengthMm: Number(like.lengthMm), tail: tailOf(like.code) }); continue; }
    const made = await makeLike(db, c, like.id, { a, b, t, name: expect.name });
    if (made.code !== expect.code) throw new Error(`cf_erp: the coding rule made ${made.code} for ${size} like ${like.code} — expected ${expect.code}; nothing kept`);
    out.created.push({ id: Number(made.id), code: made.code, name: made.name, like: like.code });
    log(`  created #${made.id} ${made.code} — ${made.name} (like ${like.code})`);
  }
  return out;
}

/** One new catalog bar like `likeId` with legs a, b and thickness t — the "Add this size to the catalog" path. */
async function makeLike(db, c, likeId, { a, b, t, name }) {
  const { getRecordSpecs, createItem } = await import('./masterRecordService.js');
  const { companyId } = c;
  const [[m]] = await db.query(
    `SELECT m.classification_id, m.short_name, m.description, m.revision, i.uom, i.tracked_by, i.sourcing, i.hsn_code, i.gst_rate, i.is_service
       FROM cf_master_records m JOIN cf_item_details i ON i.master_id = m.id AND i.deleted_at IS NULL WHERE m.company_id = ? AND m.id = ?`, [companyId, likeId]);
  const res = await getRecordSpecs(db, companyId, likeId);
  // CreateRecordDialog's typeable / copyable: a value the like bar holds in its own right, under a rule a person types.
  const typeable = (s) => s.applicable && s.captureAt === 'item' && ['entered', 'defaulted'].includes(s.rule?.valueRule);
  const values = new Map();
  for (const s of res.specs) if (typeable(s) && s.value && s.value.from === 'here' && s.value.source === 'entered' && s.value.raw != null) values.set(String(s.spec.code).toUpperCase(), { spec: s, value: s.value.raw });
  const byCode = new Map(res.specs.filter(typeable).map((s) => [String(s.spec.code).toUpperCase(), s]));
  const own = (code) => Number(values.get(code)?.value);
  // newSizeValues: DEPTH is the longer leg where the like bar's DEPTH is its longer one.
  const depthLonger = (own('DEPTH') || 0) >= (own('WIDTH') || 0);
  const [long, short] = [a, b].sort((x, y) => y - x);
  const set = { DEPTH: depthLonger ? long : short, WIDTH: depthLonger ? short : long, THICKNESS: t, SECTION_AREA: angleArea(a, b, t) };
  for (const [code, v] of Object.entries(set)) if (byCode.has(code)) values.set(code, { spec: byCode.get(code), value: v });
  return createItem(db, c, {
    itemType: 'catalog', name, classificationId: m.classification_id, uom: m.uom, trackedBy: m.tracked_by, sourcing: m.sourcing,
    shortName: m.short_name, description: m.description, revision: m.revision, status: 'active',
    ...(m.hsn_code != null ? { hsnCode: m.hsn_code } : {}), ...(m.gst_rate != null ? { gstRate: Number(m.gst_rate) } : {}),
    values: [...values.values()].map((x) => ({ specificationId: Number(x.spec.spec.id), value: x.value })),
  });
}

/** The rows of a version the decision is about, with what each holds. */
async function decisionRows(db, companyId, rootId, bom, d) {
  const { explode } = await import('./bomService.js');
  const { itemsByRowMark } = await import('../lib/standardGaps.js');
  const byMark = itemsByRowMark(bom);
  const tree = await explode(db, companyId, Number(rootId), { withCut: true });
  const all = []; const walk = (n, p) => { all.push({ n, path: p }); for (const k of n.children ?? []) walk(k, `${p} › ${k.role ?? k.name}`); };
  walk(tree.root, tree.root.name);
  const ids = all.filter((x) => x.n.kind === 'temporary').map((x) => Number(x.n.id));
  const [vals] = await db.query(
    `SELECT v.subject_id, UPPER(s.code) AS code, v.value_number, v.value_text, o.value AS opt, v.source FROM cf_spec_values v
       JOIN cf_specifications s ON s.id = v.specification_id LEFT JOIN cf_spec_options o ON o.id = v.option_id
      WHERE v.company_id = ? AND v.subject_type = 'master' AND v.subject_id IN (?) AND v.deleted_at IS NULL
        AND s.code IN ('DRAWING_MARK','THICKNESS','SECTION_AREA','LENGTH','GRADE','IMPACT_CLASS','WEIGHT')`, [companyId, ids]);
  const valOf = new Map();
  for (const v of vals) {
    if (!valOf.has(Number(v.subject_id))) valOf.set(Number(v.subject_id), {});
    valOf.get(Number(v.subject_id))[v.code] = { value: v.value_number != null ? Number(v.value_number) : v.opt ?? v.value_text, source: v.source };
  }
  const [own] = await db.query('SELECT id, cut_stock_id FROM cf_master_records WHERE company_id = ? AND id IN (?)', [companyId, ids]);
  const cutOf = new Map(own.map((m) => [Number(m.id), m.cut_stock_id == null ? null : Number(m.cut_stock_id)]));
  const lineIds = all.map((x) => x.n.lineId).filter(Boolean);
  const [lines] = lineIds.length ? await db.query('SELECT id, role, notes FROM cf_bom_lines WHERE company_id = ? AND id IN (?)', [companyId, lineIds]) : [[]];
  const lineOf = new Map(lines.map((l) => [Number(l.id), l]));
  const rows = [];
  for (const { n, path } of all) {
    if (n.kind !== 'temporary' || n.cutFrom !== 'SECTION') continue;
    const v = valOf.get(Number(n.id)) ?? {};
    const it = byMark.get(String(v.DRAWING_MARK?.value ?? '').toUpperCase());
    if (!it || !d.undecided.test(String(it.profile ?? ''))) continue;
    const line = lineOf.get(Number(n.lineId)) ?? null;
    rows.push({ id: Number(n.id), path, mark: v.DRAWING_MARK?.value ?? null, lengthMm: Number(v.LENGTH?.value ?? it.lengthMm) || null, grade: v.GRADE?.value ?? null, impact: v.IMPACT_CLASS?.value ?? null,
      cut: cutOf.get(Number(n.id)) ?? null, thickness: v.THICKNESS?.value ?? null, area: v.SECTION_AREA?.value ?? null, weight: v.WEIGHT?.value ?? null, lineId: line ? Number(line.id) : null, role: line?.role ?? null, notes: line?.notes ?? null });
  }
  const weights = all.filter((x) => (x.n.children ?? []).length).map((x) => ({ id: Number(x.n.id), path: x.path, weight: valOf.get(Number(x.n.id))?.WEIGHT ?? null }));
  return { rows, weights, rootWeight: valOf.get(Number(tree.root.id))?.WEIGHT?.value ?? null };
}

const hits = (re, text) => { re.lastIndex = 0; const y = re.test(String(text ?? '')); re.lastIndex = 0; return y; };
const needs = (r, d, t, area) => ({
  cut: r.cut == null, thickness: r.thickness == null, area: r.area == null,
  role: hits(d.textFrom, r.role),
  notes: hits(d.noteFrom, r.notes),
  differs: (r.thickness != null && Number(r.thickness) !== t) || (r.area != null && Math.abs(Number(r.area) - area) > 0.01),
});
const anyNeed = (x) => x.cut || x.thickness || x.area || x.role || x.notes;

/**
 * The decision on the standard's current version. `read`: the reads before anything is written (read-only on a dry
 * run); `conn`: a caller's transaction (the test) — else one transaction from `pool`. → { written, catalog, rows,
 * versionId?, versionNo?, weights?, rootWeight?, planned? }
 */
export async function applyDecision({ pool = null, read, conn: given = null, companyId, userId = null, decision: d = B516_ANGLES, commit = false, bomDir = DEFAULT_BOM_DIR, bom: givenBom = null, log = () => {} }) {
  const fs = await import('fs');
  const path = await import('path');
  const { setFolderOf, gapReaders } = await import('../lib/standardGaps.js');
  const want = parseSectionSize(d.size);
  const [a, b, t] = want.dims;
  const area = angleArea(a, b, t);
  const [[std]] = await read.query(
    `SELECT s.id, s.number, s.notes, s.current_version_id, v.version_no, v.root_item_id FROM cf_standard_drawings s
       JOIN cf_standard_drawing_versions v ON v.id = s.current_version_id AND v.deleted_at IS NULL
      WHERE s.company_id = ? AND s.number = ? AND s.deleted_at IS NULL`, [companyId, d.number]);
  if (!std) throw new Error(`cf_erp: no standard ${d.number} with a current version`);
  const set = givenBom ? null : setFolderOf(std.number, bomDir);
  const bom = givenBom ?? (set ? JSON.parse(fs.readFileSync(path.join(bomDir, set, 'bom.json'), 'utf8')) : null);
  if (!bom) throw new Error(`cf_erp: no drawing data for ${d.number} in ${bomDir}`);
  const [lineRows] = await read.query('SELECT o.code FROM cf_sales_order_lines l JOIN cf_sales_orders o ON o.id = l.order_id WHERE l.company_id = ? AND l.standard_version_id = ? AND l.deleted_at IS NULL', [companyId, std.current_version_id]);
  log(`${std.number} — current v${std.version_no} (#${std.current_version_id})${lineRows.length ? ` — used by ${lineRows.map((l) => l.code).join(', ')} (only read)` : ''}`);
  log(`Decision: ${d.size} — ${d.why}`);

  const cur = await decisionRows(read, companyId, std.root_item_id, bom, d);
  log(`\nRows drawn as "${d.undecided.source}" on v${std.version_no}: ${cur.rows.length}`);
  const out = { written: false, rows: cur.rows.length, catalog: null };
  if (!cur.rows.length) { log('  none — nothing to decide'); return out; }

  // 1 the catalog
  const conn = commit ? (given ?? await pool.getConnection()) : null;
  const db = conn ?? read;
  const c = { companyId, userId };
  try {
    if (conn && !given) await conn.beginTransaction();
    if (conn && given) await conn.query('SAVEPOINT std_decision');
    log(`\nCatalog: ${d.size} like ${d.family}`);
    const cat = await ensureSizeBars(db, c, { family: d.family, size: d.size, commit, log });
    out.catalog = { family: cat.family, reused: cat.reused.length, created: cat.created.length, planned: cat.planned.length };
    log(`  ${d.family}: ${cat.family} bars; ${d.size}: ${cat.reused.length} there (reused)${commit ? `, ${cat.created.length} created` : `, ${cat.planned.length} to create`}`);
    for (const p of cat.planned) log(`  would create ${p.code} — ${p.name.replace(/\s+/g, ' ')} (like ${p.like})`);

    // 2 the bar each row takes — the fix's own pick (lib/standardGaps cutStockOf: size, profile, grade, the longest
    // stock length that holds the part; the class the order's, here the decision's).
    const { cutStockOf } = await gapReaders(db, companyId);
    const plannedPick = (grade, lengthMm) => cat.planned.filter((p) => p.tail === `${grade}${d.sectionClass}` && (!lengthMm || p.lengthMm >= lengthMm)).sort((x, y) => y.lengthMm - x.lengthMm)[0] ?? null;
    let todo = 0;
    const plan = [];
    for (const r of cur.rows) {
      const grade = String(r.grade ?? d.defaultGrade).toUpperCase().replace(/\s+/g, '');
      const pick = await cutStockOf(d.size, grade, r.lengthMm, r.impact);
      const bar = pick?.stockId ? pick : pick?.byClass?.[d.sectionClass] ?? null;
      const barText = bar ? `${bar.code} (#${bar.stockId})` : plannedPick(grade, r.lengthMm)?.code ? `${plannedPick(grade, r.lengthMm).code} (to be created)` : null;
      if (!barText) throw new Error(`cf_erp: no ${d.size} ${grade}${d.sectionClass} bar for ${r.path}`);
      const n = needs(r, d, t, area);
      if (anyNeed(n)) todo += 1;
      plan.push({ r, bar, n });
      log(`  ${r.path} (mark ${r.mark}, L ${r.lengthMm}, ${grade})`
        + `${n.cut ? `\n    section  →  ${barText}` : `\n    section  already #${r.cut}${bar && r.cut !== bar.stockId ? ` (NOT the decided bar ${barText} — left as it is)` : ''}`}`
        + `${n.thickness ? `\n    THICKNESS = ${t}` : ''}${n.area ? `\n    SECTION_AREA = ${area} mm² (t (a + b − t))` : ''}`
        + `${n.role ? `\n    BOM line role: "${r.role}" → "${r.role.replace(d.textFrom, d.textTo)}"` : ''}${n.notes ? '\n    BOM line note: the open decision N2 → the decision' : ''}`
        + `${n.differs ? `\n    NOTE: holds THICKNESS ${r.thickness} / SECTION_AREA ${r.area} — a person's values, left as they are` : ''}`);
    }
    const stdNote = !String(std.notes ?? '').includes(d.why);
    log(`  weights on v${std.version_no} now: top ${cur.rootWeight ?? '— (none)'}; ${cur.weights.map((w) => `${w.path.split(' › ').pop()} ${w.weight ? `${r3(w.weight.value)} (${w.weight.source})` : '—'}`).join('; ')}`);
    if (!todo && !(cat.created.length + cat.planned.length) && !stdNote) {
      log(`\nOK — v${std.version_no} already holds the decision: nothing written`);
      if (conn) { if (given) await conn.query('RELEASE SAVEPOINT std_decision'); else await conn.rollback(); }
      return out;
    }
    if (!commit) {
      log(`\n→ would write${cat.planned.length ? ` ${cat.planned.length} catalog bar(s) and` : ''}${todo ? ` v${Number(std.version_no) + 1}: a copy of v${std.version_no} with the decision on ${todo} row(s), filled until settled; made current` : ''}${stdNote ? '; the decision on the standard\'s notes' : ''}`);
      out.planned = { bars: cat.planned.length, rows: todo, stdNote };
      return out;
    }
    if (todo) {
      const note = `Decision N2 (rdso-b516-angles ${new Date().toISOString().slice(0, 10)}) on v${std.version_no}: X-frame angles D, HA = ${d.size} ${d.defaultGrade}${d.sectionClass}; ${d.why}`;
      const v = await copyVersion(conn, c, Number(std.id), Number(std.current_version_id), { note, madeFrom: 'decision' });
      const toNew = (id) => { const x = Number(v.idMap.get(Number(id))); if (!x) throw new Error(`row #${id} has no copy`); return x; };
      const { setValues } = await import('./valueService.js');
      const [newLines] = await conn.query(
        `SELECT l.id, l.child_id FROM cf_bom_lines l JOIN cf_boms bo ON bo.id = l.bom_id WHERE l.company_id = ? AND l.deleted_at IS NULL AND l.child_id IN (?)`,
        [companyId, plan.map((p) => toNew(p.r.id))]);
      const lineOfNew = new Map(newLines.map((l) => [Number(l.child_id), Number(l.id)]));
      let bars = 0; let valuesSet = 0; let lines = 0;
      for (const { r, bar, n } of plan) {
        const id = toNew(r.id);
        let pickId = bar?.stockId ?? null;
        if (n.cut && !pickId) {
          const created = cat.created.find((x) => x.code === plannedPick(String(r.grade ?? d.defaultGrade).toUpperCase(), r.lengthMm)?.code);
          pickId = created?.id ?? null;
        }
        if (n.cut) {
          if (!pickId) throw new Error(`no bar for ${r.path}`);
          bars += (await conn.query('UPDATE cf_master_records SET cut_stock_id = ? WHERE company_id = ? AND id = ? AND cut_stock_id IS NULL', [pickId, companyId, id]))[0].affectedRows;
        }
        const entries = [...(n.thickness ? [{ specCode: 'THICKNESS', value: t }] : []), ...(n.area ? [{ specCode: 'SECTION_AREA', value: area }] : [])];
        if (entries.length) { await setValues(conn, c, 'master', id, entries); valuesSet += entries.length; }
        if (n.role || n.notes) {
          const lid = lineOfNew.get(id);
          if (!lid) throw new Error(`no BOM line for the copy of ${r.path}`);
          lines += (await conn.query('UPDATE cf_bom_lines SET role = ?, notes = ? WHERE company_id = ? AND id = ?',
            [n.role ? String(r.role).replace(d.textFrom, d.textTo) : r.role, n.notes ? String(r.notes).replace(d.noteFrom, decidedNote(d)) : r.notes, companyId, lid]))[0].affectedRows;
        }
      }
      const filled = await fillUntilSettled(conn, c, { id: v.versionId, standard_id: Number(std.id), version_no: v.versionNo, root_item_id: v.rootId, number: std.number }, { sectionClass: d.sectionClass, bomDir, bom: givenBom });
      const after = await decisionRows(conn, companyId, v.rootId, bom, d);
      const short = after.rows.filter((r) => anyNeed(needs(r, d, t, area)));
      if (short.length) throw new Error(`the new version still lacks the decision on ${short.length} row(s)`);
      if (after.rootWeight != null) await conn.query('UPDATE cf_standard_drawing_versions SET weight_kg = ? WHERE company_id = ? AND id = ?', [r3(after.rootWeight), companyId, v.versionId]);
      await conn.query('UPDATE cf_standard_drawing_versions SET note = ? WHERE company_id = ? AND id = ?',
        [`${note}; ${bars} bars, ${valuesSet} values, ${lines} BOM lines; filled: ${filled.values} values, ${filled.sections} sections, ${filled.flows} flows`.slice(0, 500), companyId, v.versionId]);
      log(`\nWRITTEN: v${v.versionNo} (#${v.versionId}), now current — ${bars} section bars, ${valuesSet} values, ${lines} BOM lines; filled ${filled.values} values, ${filled.sections} sections, ${filled.flows} flows${filled.problems.length ? `\n  refused:\n    ${filled.problems.join('\n    ')}` : ''}`);
      log(`  angles: ${after.rows.map((r) => `${r.path.split(' › ').slice(-2).join(' › ')} WEIGHT ${r.weight != null ? r3(r.weight) : '—'}`).join('; ')}`);
      log(`  assemblies: top ${after.rootWeight != null ? r3(after.rootWeight) : '—'} kg; ${after.weights.map((w) => `${w.path.split(' › ').pop()} ${w.weight ? `${r3(w.weight.value)} (${w.weight.source})` : '—'}`).join('; ')}`);
      Object.assign(out, { written: true, versionId: v.versionId, versionNo: v.versionNo, rootId: v.rootId, bars, values: valuesSet, lines, filled, weights: after.weights, rootWeight: after.rootWeight, angles: after.rows });
    }
    if (stdNote) {
      await conn.query('UPDATE cf_standard_drawings SET notes = ? WHERE company_id = ? AND id = ?',
        [`${std.notes ? `${std.notes}\n` : ''}Decision 2026-10-19 (N2): the X-frame angles D and HA are ${d.size} — ${d.why}.`, companyId, std.id]);
      out.written = true;
      log('  the standard\'s notes: the decision added');
    }
    out.catalog.created = cat.created.length;
    if (cat.created.length) out.written = true;
    if (given) await conn.query('RELEASE SAVEPOINT std_decision'); else await conn.commit();
    return out;
  } catch (err) {
    if (conn) { try { if (given) await conn.query('ROLLBACK TO SAVEPOINT std_decision'); else await conn.rollback(); } catch { /* the error below is the one */ } }
    throw err;
  } finally {
    if (conn && !given) conn.release();
  }
}
