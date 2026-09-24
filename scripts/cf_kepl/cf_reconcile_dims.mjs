/**
 * cf_reconcile_dims.mjs — checks every part in the KEPL order against two
 * independent authorities and repairs what both agree on.
 *
 * WHY THIS EXISTS
 *
 * The production build of this order was interrupted and resumed. A resumed run
 * writes only what is still missing, so any row the first pass had already
 * written keeps its old values and nothing ever looks at it again. That is how
 * ONE part — girder 1's web cover plate — kept THICKNESS 30 when the BOQ, the
 * blank it is cut from, and the other three girders all say 25. It inflated the
 * span by 720.63 kg and the order by 1,441 kg, and no check caught it because
 * every check compared the model to itself.
 *
 * THE TWO AUTHORITIES
 *
 *  1. THE BLANK. A part is cut from a pooled blank that carries the same
 *     THICKNESS/LENGTH/WIDTH. Part and blank disagreeing is a contradiction
 *     inside the order — detectable with no outside information at all.
 *  2. THE BOQ. Every part rectangle must be one the customer's document lists.
 *
 * A value is repaired ONLY where both authorities name the same replacement.
 * Anything else is reported and left alone: a disagreement this script cannot
 * explain is a question for a person, not something to overwrite.
 *
 * Read-only by default. Pass --fix to write.
 */
import path from 'path';
import { pathToFileURL } from 'url';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
await imp('apps/cf_erp/services/codegenProvider.js');
const values = await imp('apps/cf_erp/services/valueService.js');
const { attachNodeCache, detachNodeCache } = await imp('apps/cf_erp/lib/db.js');
const { PARTS, UNIT_KG } = await import(pathToFileURL(path.join(BE, 'scripts/cf_kepl/cf_bridge_data.mjs')).href);

const COMPANY = Number(process.env.CF_BRIDGE_COMPANY ?? 2);
const c = { companyId: COMPANY, userId: 22 };
const FIX = process.argv.includes('--fix');
const SPAN_WEIGHT_KG = 334644.13;
const DIMS = ['THICKNESS', 'LENGTH', 'WIDTH'];

/** Every rectangle the BOQ lists, as a set of "thk x len x wid". */
const boqRects = new Set([...PARTS.values()].map((p) => `${p.thk}x${p.len}x${p.wid}`));

const conn = await pool.getConnection();
const say = (s) => console.log(s);
let repairs = [];
let reports = [];

try {
  await conn.beginTransaction();
  attachNodeCache(conn);

  // Every part that is cut from a blank, with both sets of dimensions side by side.
  const [rows] = await conn.query(
    `SELECT part.id   AS part_id,   part.code AS part_code,   part.name AS part_name,
            blank.id  AS blank_id,  blank.name AS blank_name,
            ps.code   AS spec,      pv.value_number AS part_val, bv.value_number AS blank_val
       FROM cf_master_records part
       JOIN cf_boms b            ON b.parent_id = part.id AND b.deleted_at IS NULL
       JOIN cf_bom_lines l       ON l.bom_id = b.id AND l.deleted_at IS NULL
       JOIN cf_master_records blank ON blank.id = l.child_id AND blank.deleted_at IS NULL
       JOIN cf_classification_nodes bn ON bn.id = blank.classification_id AND bn.code = 'CUT_PLATE'
       JOIN cf_specifications ps ON ps.company_id = part.company_id AND ps.code IN (?) AND ps.deleted_at IS NULL
       LEFT JOIN cf_spec_values pv ON pv.subject_id = part.id  AND pv.subject_type='master'
              AND pv.specification_id = ps.id AND pv.deleted_at IS NULL
       LEFT JOIN cf_spec_values bv ON bv.subject_id = blank.id AND bv.subject_type='master'
              AND bv.specification_id = ps.id AND bv.deleted_at IS NULL
      WHERE part.company_id = ? AND part.deleted_at IS NULL
      ORDER BY part.code, ps.code`, [DIMS, COMPANY]);

  // Group by part so a rectangle can be judged whole, not one dimension at a time.
  const parts = new Map();
  for (const r of rows) {
    if (!parts.has(r.part_id)) parts.set(r.part_id, { ...r, dims: {} });
    parts.get(r.part_id).dims[r.spec] = { part: Number(r.part_val), blank: Number(r.blank_val) };
  }
  say(`${parts.size} parts are cut from a blank; checking each against its blank and the BOQ.`);

  for (const p of parts.values()) {
    const off = DIMS.filter((d) => p.dims[d] && p.dims[d].part !== p.dims[d].blank);
    if (!off.length) continue;

    const rect = (pick) => DIMS.map((d) => p.dims[d]?.[pick]).join('x');
    const partRect = rect('part');
    const blankRect = rect('blank');
    const partInBoq = boqRects.has(partRect);
    const blankInBoq = boqRects.has(blankRect);

    const line = `${p.part_code ?? p.part_id}  "${p.part_name}"  part=${partRect}  blank=${blankRect}`
      + `  [BOQ: part ${partInBoq ? 'YES' : 'no'}, blank ${blankInBoq ? 'YES' : 'no'}]`;

    if (blankInBoq && !partInBoq) {
      repairs.push({ ...p, off, partRect, blankRect, line });
    } else {
      // Either both are in the BOQ, or neither is. Not safe to guess.
      reports.push(line);
    }
  }

  say('');
  if (repairs.length) {
    say(`-- ${repairs.length} part(s) contradict their blank, with the BLANK corroborated by the BOQ --`);
    for (const r of repairs) say(`   ${r.line}`);
  } else say('-- no part contradicts its blank --');

  if (reports.length) {
    say('');
    say(`-- ${reports.length} disagreement(s) this script will NOT touch (a person must decide) --`);
    for (const l of reports) say(`   ${l}`);
  }

  if (FIX && repairs.length) {
    say('');
    for (const r of repairs) {
      const writes = r.off.map((d) => ({ specCode: d, value: r.dims[d].blank }));
      await values.setValues(conn, c, 'master', r.part_id, writes);
      say(`   set ${r.off.map((d) => `${d}=${r.dims[d].blank}`).join(', ')} on ${r.part_code ?? r.part_id}`);
    }
  }

  // The span is the proof: it must come back to the BOQ's own figure.
  const [[w]] = await conn.query(
    `SELECT ROUND(v.value_number, 2) AS kg FROM cf_spec_values v
       JOIN cf_specifications s ON s.id = v.specification_id AND s.code = 'WEIGHT'
       JOIN cf_master_records m ON m.id = v.subject_id AND m.deleted_at IS NULL
       JOIN cf_classification_nodes n ON n.id = m.classification_id AND n.code = 'BRIDGE_SPAN'
      WHERE v.company_id = ? AND v.subject_type = 'master' AND v.deleted_at IS NULL`, [COMPANY]);
  const kg = w ? Number(w.kg) : null;
  say('');
  say(`span rolls up to ${kg} kg   (the BOQ says ${SPAN_WEIGHT_KG})`);

  if (!FIX) { await conn.rollback(); say('\nread-only — nothing written. Re-run with --fix to repair.'); }
  else if (kg !== SPAN_WEIGHT_KG) { await conn.rollback(); say('\nROLLED BACK — the span does not match the BOQ after the repair.'); process.exitCode = 1; }
  else { detachNodeCache(conn); await conn.commit(); say('\nCOMMITTED — span matches the BOQ.'); }
} catch (e) {
  await conn.rollback();
  console.error('FAILED:', e.code ?? '', e.message, (e.problems ?? []).slice(0, 4));
  process.exitCode = 1;
} finally {
  detachNodeCache(conn);
  conn.release();
  await pool.end();
}
