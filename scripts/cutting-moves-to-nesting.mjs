/**
 * cutting-moves-to-nesting.mjs — cutting becomes the nesting order's work,
 * and stops being the first thing every part does.
 *
 * ── WHY ──────────────────────────────────────────────────────────────────────
 *
 * Both part flows begin by cutting from raw plate:
 *
 *   Part Fabrication — Plain     Marking and Cutting -> crane -> edge prep -> crane -> QC
 *   Part Fabrication — Drilled   Marking and Cutting -> crane -> drill -> ... -> QC
 *
 * That was right while nothing else cut anything. Now nesting raises a cutting
 * order that turns plate into blanks, and a part that starts from a blank has
 * already been cut. Left alone, every part on the order would be costed,
 * scheduled and booked for cutting TWICE — once in the cutting order and again
 * at the head of its own flow. On this order that is 66 part rows, and the
 * double-count would be invisible: both numbers look reasonable on their own.
 *
 * So the step comes off the part flows and lives in one place.
 *
 * ── THE DEPENDENCY IS THE DANGEROUS PART ─────────────────────────────────────
 *
 * `depends_on` holds a SEQ NUMBER, not a step id. The crane move after cutting
 * says `depends_on = '1'`. Delete step 1 and leave that alone and the crane move
 * waits forever on a step that no longer exists — `processPredecessorsDone`
 * looks up seq 1, finds nothing, and answers "not done" for good. The task never
 * clears and nothing says why.
 *
 * So the follower is set to depend on nothing, which makes it the flow's first
 * step. Seq numbers are NOT renumbered: the engine takes the flow's minimum seq
 * rather than assuming 1 (`minSeqByFlowId`), and renumbering would mean
 * rewriting every other `depends_on` for no gain.
 *
 * ── THE CUTTING FLOW NEEDS A MACHINE ─────────────────────────────────────────
 *
 * `Cutting Flow` (C0001) already exists with exactly one step, Marking and
 * Cutting, and no resource type. A step with no resource type cannot be
 * scheduled — the Plan Board has nothing to put it on. The part flows' cutting
 * step names the machine type; that same type is copied onto it, so the cutting
 * order lands on the same machines that were doing this work anyway.
 *
 *   node scripts/cutting-moves-to-nesting.mjs           # dry run
 *   node scripts/cutting-moves-to-nesting.mjs --apply
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
const CUTTING_OP = 'Marking and Cutting';
const CUTTING_FLOW_CODE = 'C0001';

const conn = await pool.getConnection();
try {
  if (APPLY) await conn.beginTransaction();

  const [flows] = await conn.query(
    `SELECT id, name, code FROM fab_operation_flows
      WHERE company_id = ? AND deleted_at IS NULL AND name LIKE 'Part Fabrication%'`,
    [COMPANY],
  );

  let cutResourceType = null;
  const plan = [];

  for (const f of flows) {
    const [steps] = await conn.query(
      `SELECT s.id, s.seq_no, s.depends_on, s.resource_type_id AS rt, s.notes, o.name AS op
         FROM fab_operation_flow_steps s
         LEFT JOIN fab_operations o ON o.id = s.operation_id
        WHERE s.flow_id = ? AND s.deleted_at IS NULL
        ORDER BY s.seq_no`,
      [f.id],
    );
    const first = steps[0];
    if (!first || first.op !== CUTTING_OP) {
      plan.push({ flow: f, skip: `starts with "${first?.op ?? 'nothing'}" — leaving alone` });
      continue;
    }
    cutResourceType = cutResourceType ?? first.rt;

    // Anything naming the doomed step's seq must stop naming it.
    const orphans = steps.filter((s) => s.id !== first.id
      && String(s.depends_on ?? '').split(',').map((x) => x.trim()).includes(String(first.seq_no)));

    plan.push({ flow: f, first, orphans, steps });
  }

  console.log('STRIP CUTTING FROM THE PART FLOWS\n');
  for (const p of plan) {
    console.log(`${p.flow.name}  (${p.flow.code})`);
    if (p.skip) { console.log(`  ${p.skip}\n`); continue; }
    console.log(`  was:  ${p.steps.map((s) => s.op).join(' -> ')}`);
    console.log(`  now:  ${p.steps.filter((s) => s.id !== p.first.id).map((s) => s.op).join(' -> ')}`);
    console.log(`  drop  seq ${p.first.seq_no} ${p.first.op}${p.first.rt ? ` (machine type ${p.first.rt})` : ''}`);
    for (const o of p.orphans) {
      console.log(`  free  seq ${o.seq_no} ${o.op} — depends_on "${o.depends_on}" -> none, it becomes the first step`);
    }
    console.log('');
  }

  if (APPLY) {
    for (const p of plan) {
      if (p.skip) continue;
      await conn.query(
        `UPDATE fab_operation_flow_steps SET deleted_at = NOW() WHERE id = ? AND company_id = ?`,
        [p.first.id, COMPANY],
      );
      for (const o of p.orphans) {
        await conn.query(
          `UPDATE fab_operation_flow_steps SET depends_on = NULL WHERE id = ? AND company_id = ?`,
          [o.id, COMPANY],
        );
      }
    }
  }

  // ── give the cutting flow its machine ───────────────────────────────────────
  const [[cf]] = await conn.query(
    `SELECT id, name FROM fab_operation_flows
      WHERE company_id = ? AND code = ? AND deleted_at IS NULL`,
    [COMPANY, CUTTING_FLOW_CODE],
  );
  console.log('THE CUTTING FLOW\n');
  if (!cf) {
    console.log(`  no flow with code ${CUTTING_FLOW_CODE} — nothing to point the cutting order at`);
  } else {
    const [cfSteps] = await conn.query(
      `SELECT s.id, s.seq_no, s.resource_type_id AS rt, o.name AS op
         FROM fab_operation_flow_steps s
         LEFT JOIN fab_operations o ON o.id = s.operation_id
        WHERE s.flow_id = ? AND s.deleted_at IS NULL ORDER BY s.seq_no`,
      [cf.id],
    );
    console.log(`  ${cf.name}: ${cfSteps.map((s) => s.op).join(' -> ') || '(no steps)'}`);
    for (const s of cfSteps) {
      if (s.rt) { console.log(`  seq ${s.seq_no} already runs on machine type ${s.rt}`); continue; }
      if (!cutResourceType) { console.log(`  seq ${s.seq_no} has no machine and none was found to copy`); continue; }
      const [[rt]] = await conn.query(
        `SELECT name FROM fab_resource_types WHERE id = ? AND company_id = ?`, [cutResourceType, COMPANY]);
      console.log(`  seq ${s.seq_no} ${s.op}: no machine  ->  ${rt?.name ?? cutResourceType} (taken from the part flows)`);
      if (APPLY) {
        await conn.query(
          `UPDATE fab_operation_flow_steps SET resource_type_id = ? WHERE id = ? AND company_id = ?`,
          [cutResourceType, s.id, COMPANY],
        );
      }
    }
  }

  if (APPLY) { await conn.commit(); console.log('\nCommitted.'); }
  else console.log('\nDRY RUN — nothing was written. Re-run with --apply.');
} catch (err) {
  if (APPLY) await conn.rollback();
  throw err;
} finally {
  conn.release();
  await pool.end();
}
