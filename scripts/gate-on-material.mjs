/**
 * gate-on-material.mjs — make work wait for the thing it is made of.
 *
 * ── THE HOLE ─────────────────────────────────────────────────────────────────
 *
 * `fab_operation_flow_step_inputs` held ZERO rows for this company. Every input
 * a task gets is built from that table, so no task on any order was gated on
 * anything: a part could start before its steel existed, an assembly before its
 * parts were made, and nothing anywhere would object. The gating engine has been
 * there the whole time with nothing declared to gate on.
 *
 * That was survivable while cutting was the first step of every part — the part
 * made its own material. It is not survivable now: cutting is separate work
 * producing blanks, and without a gate the shop would be told a part is ready
 * before its blank had been cut.
 *
 * ── WHAT IS DECLARED ─────────────────────────────────────────────────────────
 *
 *   Cutting Flow            first step  raw_material   the plate
 *   Part Fabrication (both) first step  raw_material   the blank
 *   Assembly flows          first step  child_parts    the parts beneath it
 *
 * `raw_material` resolves at materialisation time to the item's own MATERIAL
 * children — which is exactly what nesting rewrote — so the same declaration
 * gates a blank on plate and a part on its blank, without either naming the
 * other. `child_parts` resolves to the structure children.
 *
 * ── WHY THE FIRST STEP ───────────────────────────────────────────────────────
 *
 * Because that is when the material is consumed: `wipInventoryService` deducts
 * inputs at the FIRST operation's start and throws INSUFFICIENT_STOCK if they
 * are not there. Gating a later step would let work begin on steel that is not
 * in the building.
 *
 * The part flows now open with a crane move, which looks like an odd place for a
 * material gate until you remember what it is moving: the blank, from the
 * cutting bay to the next machine. Nothing can be moved that has not been cut.
 *
 * ── WHAT THIS WILL DO TO A LIVE ORDER ────────────────────────────────────────
 *
 * Block it, correctly. Parts go from `eligible` to `blocked` until their blank
 * is cut, which is the truth and was not being told before. Tasks already
 * materialised do NOT gain inputs — the materialiser skips tasks that exist —
 * so an order has to be re-materialised for this to reach it.
 *
 *   node scripts/gate-on-material.mjs           # dry run
 *   node scripts/gate-on-material.mjs --apply
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const env = {};
fs.readFileSync(path.join(__dir, '..', '..', '.env.tidb'), 'utf8').split('\n').forEach((l) => {
  l = l.trim(); if (!l || l.startsWith('#')) return;
  const [k, ...r] = l.split('='); env[k.trim()] = r.join('=').trim();
});
Object.assign(process.env, {
  DB_HOST: env.DB_HOST, DB_PORT: env.DB_PORT ?? '4000', DB_USER: env.DB_USER,
  DB_PASSWORD: env.DB_PASSWORD, DB_NAME: env.DB_NAME, DB_SSL: 'true',
});
const { pool } = await import('../db.js');

const APPLY = process.argv.includes('--apply');
const COMPANY = 30005;

/** What each flow's first step consumes. Anything unlisted is left alone. */
const WHAT_IT_EATS = [
  { match: /^Cutting Flow$/i, role: 'raw_material', why: 'plate' },
  { match: /^Part Fabrication/i, role: 'raw_material', why: 'its blank' },
  { match: /Assembly/i, role: 'child_parts', why: 'the parts beneath it' },
  { match: /^PEB Built-up/i, role: 'child_parts', why: 'the parts beneath it' },
];

const conn = await pool.getConnection();
try {
  if (APPLY) await conn.beginTransaction();

  const [flows] = await conn.query(
    `SELECT id, name, code FROM fab_operation_flows
      WHERE company_id = ? AND deleted_at IS NULL ORDER BY name`,
    [COMPANY],
  );

  console.log('MATERIAL GATES\n');
  let added = 0;
  let already = 0;

  for (const f of flows) {
    const rule = WHAT_IT_EATS.find((r) => r.match.test(f.name));
    if (!rule) { console.log(`  skip  ${f.name} — nothing declared for it`); continue; }

    const [steps] = await conn.query(
      `SELECT s.id, s.seq_no, o.name AS op FROM fab_operation_flow_steps s
         LEFT JOIN fab_operations o ON o.id = s.operation_id
        WHERE s.flow_id = ? AND s.deleted_at IS NULL ORDER BY s.seq_no LIMIT 1`,
      [f.id],
    );
    const first = steps[0];
    if (!first) { console.log(`  skip  ${f.name} — no steps`); continue; }

    const [[have]] = await conn.query(
      `SELECT COUNT(*) n FROM fab_operation_flow_step_inputs
        WHERE company_id = ? AND flow_step_id = ? AND ref_bom_role = ? AND deleted_at IS NULL`,
      [COMPANY, first.id, rule.role],
    );
    if (Number(have.n) > 0) {
      already += 1;
      console.log(`  have  ${f.name} — "${first.op}" already waits for ${rule.why}`);
      continue;
    }

    console.log(`  ADD   ${f.name} — "${first.op}" will wait for ${rule.why} (${rule.role})`);
    added += 1;
    if (APPLY) {
      await conn.query(
        `INSERT INTO fab_operation_flow_step_inputs
           (company_id, flow_step_id, input_role, ref_bom_role, gate, notes, created_at)
         VALUES (?,?,?,?,1,?,NOW())`,
        [COMPANY, first.id, rule.role, rule.role,
          `Cannot start until ${rule.why} is on hand.`],
      );
    }
  }

  console.log(`\n${added} to add, ${already} already declared`);

  if (APPLY) { await conn.commit(); console.log('\nCommitted.'); }
  else console.log('\nDRY RUN — nothing was written. Re-run with --apply.');
} catch (err) {
  if (APPLY) await conn.rollback();
  throw err;
} finally {
  conn.release();
  await pool.end();
}
