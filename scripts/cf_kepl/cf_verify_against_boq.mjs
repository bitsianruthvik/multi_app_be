/**
 * cf_verify_against_boq.mjs — reconciles the whole KEPL order against the
 * customer's BOQ. Read-only, always.
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT cf_reconcile_dims.mjs
 *
 * Every check this project had compared the model to ITSELF: rollups agreed
 * with their children, the top-down total agreed with the bottom-up sum. A
 * model can be perfectly self-consistent and still not describe the bridge the
 * customer asked for — and it was. One part carried THICKNESS 30 against the
 * BOQ's 25 and every check passed.
 *
 * cf_reconcile_dims catches a part that disagrees with the blank it is cut
 * from. That is narrower than it sounds: it only sees the parts that HAVE a
 * blank, it only looks at dimensions, and a wrong QUANTITY is invisible to it.
 * Two errors that cancel would pass both it and the weight rollup.
 *
 * So this walks the span down to its leaves, multiplying quantities the whole
 * way, and compares the resulting bill — every rectangle and how many of it —
 * against the same bill derived from boq.json. It is the only check here that
 * can fail when the database is internally consistent and wrong.
 *
 * A difference is reported, never repaired. Deciding which side is right is a
 * reading of the customer's document, and that is a person's job.
 */
import path from 'path';
import { pathToFileURL } from 'url';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
const { BOQ, UNIT_KG } = await import(pathToFileURL(path.join(BE, 'scripts/cf_kepl/cf_bridge_data.mjs')).href);

const COMPANY = Number(process.env.CF_BRIDGE_COMPANY ?? 2);
const DIMS = ['THICKNESS', 'LENGTH', 'WIDTH'];
const rect = (t, l, w) => `${t}x${l}x${w}`;
const r3 = (n) => Number(Number(n).toFixed(3));

let failures = 0;
const ok = (s) => console.log(`ok   ${s}`);
const bad = (s, detail) => { failures += 1; console.log(`FAIL ${s}`); if (detail) console.log(detail); };

// ---------------------------------------------------------------------------
// The bill the BOQ implies, in leaves.
//   20 girder segments, each once per span; then the sub-assemblies at their
//   stated span quantities; then the studs.
// ---------------------------------------------------------------------------
const want = new Map();                       // rectangle -> qty
const addWant = (k, q) => want.set(k, (want.get(k) ?? 0) + q);
for (const g of BOQ.girders) for (const p of g.parts) addWant(rect(p.thk, p.len, p.wid), p.qty * g.qty);
for (const s of BOQ.subAssemblies) for (const p of s.parts) addWant(rect(p.thk, p.len, p.wid), p.qty * s.qty);
const wantStuds = BOQ.studs.qtyPerLine * BOQ.studs.lines;

const conn = await pool.getConnection();
try {
  // -------------------------------------------------------------------------
  // The bill the database holds, expanded from the span.
  // -------------------------------------------------------------------------
  const [specRows] = await conn.query(
    `SELECT m.id, n.code AS cls, s.code AS spec, v.value_number AS val
       FROM cf_master_records m
       JOIN cf_classification_nodes n ON n.id = m.classification_id
       LEFT JOIN cf_spec_values v ON v.subject_id = m.id AND v.subject_type='master' AND v.deleted_at IS NULL
       LEFT JOIN cf_specifications s ON s.id = v.specification_id AND s.code IN (?)
      WHERE m.company_id = ? AND m.deleted_at IS NULL`, [[...DIMS, 'WEIGHT'], COMPANY]);
  const rec = new Map();
  for (const r of specRows) {
    if (!rec.has(r.id)) rec.set(r.id, { id: r.id, cls: r.cls, dims: {} });
    if (r.spec) rec.get(r.id).dims[r.spec] = Number(r.val);
  }

  const [lines] = await conn.query(
    `SELECT b.parent_id AS parent, l.child_id AS child, l.quantity
       FROM cf_bom_lines l JOIN cf_boms b ON b.id = l.bom_id AND b.deleted_at IS NULL
      WHERE l.company_id = ? AND l.deleted_at IS NULL`, [COMPANY]);
  const kids = new Map();
  for (const l of lines) { if (!kids.has(l.parent)) kids.set(l.parent, []); kids.get(l.parent).push(l); }

  const [[span]] = await conn.query(
    `SELECT m.id FROM cf_master_records m
       JOIN cf_classification_nodes n ON n.id = m.classification_id AND n.code = 'BRIDGE_SPAN'
       JOIN cf_item_details i ON i.master_id = m.id AND i.item_type = 'temporary' AND i.deleted_at IS NULL
      WHERE m.company_id = ? AND m.deleted_at IS NULL`, [COMPANY]);
  if (!span) throw new Error('no bridge span in this company');

  /** A part is where we stop: it has a rectangle and is not the blank below it. */
  const isPart = (r) => r.cls !== 'CUT_PLATE' && DIMS.every((d) => Number.isFinite(r.dims[d]));

  const got = new Map();
  let gotStuds = 0;
  const addGot = (k, q) => got.set(k, (got.get(k) ?? 0) + q);
  (function walk(id, mult) {
    const r = rec.get(id);
    if (!r) return;
    if (r.cls === 'SHEAR_STUD') { gotStuds += mult; return; }
    if (isPart(r)) { addGot(rect(r.dims.THICKNESS, r.dims.LENGTH, r.dims.WIDTH), mult); return; }
    for (const l of kids.get(id) ?? []) walk(l.child, mult * Number(l.quantity));
  })(span.id, 1);

  // -------------------------------------------------------------------------
  // 1. The bill, rectangle by rectangle.
  // -------------------------------------------------------------------------
  const all = [...new Set([...want.keys(), ...got.keys()])].sort();
  const diffs = all
    .map((k) => ({ k, want: want.get(k) ?? 0, got: got.get(k) ?? 0 }))
    .filter((d) => d.want !== d.got);
  const pieces = [...got.values()].reduce((a, b) => a + b, 0);
  diffs.length
    ? bad(`the span's bill matches the BOQ (${all.length} distinct rectangles)`,
        diffs.map((d) => `       ${d.k.padEnd(20)} BOQ ${String(d.want).padStart(6)}   order ${String(d.got).padStart(6)}`
          + (d.want === 0 ? '   <- not in the BOQ at all' : d.got === 0 ? '   <- missing from the order' : '')).join('\n'))
    : ok(`the bill matches the BOQ, rectangle for rectangle and count for count (${all.length} rectangles, ${pieces} pieces)`);

  // -------------------------------------------------------------------------
  // 2. The studs.
  // -------------------------------------------------------------------------
  gotStuds === wantStuds
    ? ok(`${gotStuds} shear studs, as the BOQ states (${BOQ.studs.qtyPerLine} x ${BOQ.studs.lines} lines)`)
    : bad(`the BOQ states ${wantStuds} shear studs`, `       order has ${gotStuds}`);

  // -------------------------------------------------------------------------
  // 3. Each of the 20 girder segments against its own stated gross weight.
  //    Matched by DRAWING_MARK, which cf_recode_order proves is on all 20.
  // -------------------------------------------------------------------------
  const [marks] = await conn.query(
    `SELECT m.id, v.value_text AS mark FROM cf_master_records m
       JOIN cf_classification_nodes n ON n.id = m.classification_id AND n.code = 'GIRDER_SEGMENT'
       JOIN cf_spec_values v ON v.subject_id = m.id AND v.subject_type='master' AND v.deleted_at IS NULL
       JOIN cf_specifications s ON s.id = v.specification_id AND s.code = 'DRAWING_MARK'
      WHERE m.company_id = ? AND m.deleted_at IS NULL`, [COMPANY]);
  const byMark = new Map(marks.map((m) => [m.mark, m.id]));
  const segBad = [];
  for (const g of BOQ.girders) {
    const id = byMark.get(g.mark);
    if (!id) { segBad.push(`       ${g.mark}: no segment in the order carries this mark`); continue; }
    const kg = rec.get(id)?.dims.WEIGHT;
    // The BOQ's own grossKg is rounded; compare to what its parts re-compute to,
    // which is the figure a rollup can actually hit.
    const expect = r3(g.parts.reduce((a, p) => a + p.thk * p.len * p.wid * UNIT_KG * p.qty, 0));
    if (!Number.isFinite(kg) || Math.abs(r3(kg) - expect) > 0.02) {
      segBad.push(`       ${g.mark}: order ${r3(kg)} kg, BOQ parts come to ${expect} kg (stated ${g.grossKg})`);
    }
  }
  segBad.length
    ? bad(`all ${BOQ.girders.length} girder segments weigh what their BOQ parts come to`, segBad.join('\n'))
    : ok(`all ${BOQ.girders.length} girder segments weigh what their own BOQ parts come to`);

  // -------------------------------------------------------------------------
  // 4. The span total, against the figure on the customer's document.
  // -------------------------------------------------------------------------
  const spanKg = r3(rec.get(span.id)?.dims.WEIGHT);
  Math.abs(spanKg - BOQ.check.computedPerSpan) <= 0.5
    ? ok(`the span rolls up to ${spanKg} kg — the BOQ computes ${BOQ.check.computedPerSpan}, states ${BOQ.check.statedPerSpan}`)
    : bad(`the span should roll up to about ${BOQ.check.computedPerSpan} kg`, `       it rolls up to ${spanKg}`);

  console.log('');
  console.log(failures
    ? `${failures} CHECK(S) FAILED — the order does not match the customer's document.`
    : 'The order matches the BOQ: every rectangle, every count, every segment, the total.');
  if (failures) process.exitCode = 1;
} catch (e) {
  console.error('FAILED:', e.code ?? '', e.message);
  process.exitCode = 1;
} finally {
  conn.release();
  await pool.end();
}
