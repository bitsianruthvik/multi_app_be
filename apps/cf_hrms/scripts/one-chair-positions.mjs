/**
 * One position = one chair for one person.
 *
 *   node one-chair-positions.mjs --company=karni                    DRY RUN
 *   node one-chair-positions.mjs --company=karni --apply
 *   node one-chair-positions.mjs --company=karni --apply --target=prod
 *
 * WHY. The model had three levels: a role, a position that held several seats
 * (a headcount, doubled by a day/night pattern through hrms_manpower_requirements)
 * and the people in those seats. The user's model has two: a role, and positions
 * under it, each for exactly one person and each on one shift. This script
 * turns the old shape into the new one, in place, once.
 *
 * WHAT IT DOES, per position:
 *   - chairs = one per required seat (day and night alternate), or one per
 *     person if more people sit there than the chart sanctioned;
 *   - the existing row becomes chair 1 and keeps its id, so documents, audit
 *     rows and anything else that points at it still does;
 *   - new rows are copies (role, title, department, location, status);
 *   - codes get a suffix only when a position splits: P021 -> P021-1, P021-2;
 *   - the i-th person moves to the i-th chair and takes that chair's shift;
 *   - reporting lines are repeated for every chair, to the manager's chair on
 *     the SAME shift when there is one, else to the manager's first chair;
 *   - position-level content changes and work contexts are copied to each chair;
 *   - the per-shift requirement rows are retired: a chair IS the requirement.
 *
 * Safe to run twice: a position that already has one chair, a shift and no
 * live requirement rows is left alone.
 *
 * THE ONE GUESS. The source chart marks nobody as a night worker, so who is on
 * nights is not known. People fill a position's chairs in order (day, night,
 * day, night) and anyone beyond the sanctioned seats is put on days. The
 * summary says how many people that touched; HR corrects a shift in the app.
 */
import mysql from 'mysql2/promise';
import { resolveTarget, announce } from './dbTarget.mjs';

const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const APPLY = process.argv.includes('--apply');
const up = (c) => String(c ?? '').trim().toUpperCase();
const CH = 200;

async function main() {
  const slug = arg('company');
  if (!slug) throw new Error('--company=<slug> is required');
  const target = resolveTarget();
  announce(target);
  const conn = await mysql.createConnection({ ...target.cfg, dateStrings: true });
  try {
    const [[company]] = await conn.query('SELECT id, name FROM companies WHERE slug = ? AND deleted_at IS NULL', [slug]);
    if (!company) throw new Error(`No company with slug '${slug}'`);
    const cid = company.id;

    const [shifts] = await conn.query('SELECT id, code, name FROM hrms_shifts WHERE company_id = ? AND deleted_at IS NULL ORDER BY id', [cid]);
    const day = shifts.find((s) => up(s.code).startsWith('D'));
    const night = shifts.find((s) => up(s.code).startsWith('N'));
    const general = shifts.find((s) => up(s.code).startsWith('G')) ?? shifts.find((s) => s !== day && s !== night);
    if (!day || !night || !general) throw new Error('This company needs a General, a Day and a Night shift before positions can be split.');

    const [positions] = await conn.query(
      `SELECT id, position_code, role_id, position_title, department_id, location_id, sanctioned_headcount,
              default_shift_id, status, effective_from, effective_to, created_by
         FROM hrms_positions WHERE company_id = ? AND deleted_at IS NULL ORDER BY id`, [cid]);
    const [reqs] = await conn.query(
      `SELECT id, position_id, shift_id, required_count FROM hrms_manpower_requirements
        WHERE company_id = ? AND deleted_at IS NULL AND position_id IS NOT NULL ORDER BY id`, [cid]);
    const [people] = await conn.query(
      `SELECT id, position_id, default_shift_id FROM hrms_work_assignments
        WHERE company_id = ? AND deleted_at IS NULL AND status <> 'ENDED' AND position_id IS NOT NULL ORDER BY id`, [cid]);
    const [edges] = await conn.query(
      'SELECT * FROM hrms_position_reporting_relationships WHERE company_id = ? AND deleted_at IS NULL ORDER BY id', [cid]);
    const [overrides] = await conn.query(
      'SELECT * FROM hrms_position_content_overrides WHERE company_id = ? AND deleted_at IS NULL ORDER BY id', [cid]);
    const [contexts] = await conn.query(
      'SELECT * FROM hrms_position_work_contexts WHERE company_id = ? AND deleted_at IS NULL ORDER BY id', [cid]);

    const by = (rows, key) => rows.reduce((m, r) => m.set(r[key], [...(m.get(r[key]) ?? []), r]), new Map());
    const reqsOf = by(reqs, 'position_id');
    const peopleOf = by(people, 'position_id');

    const taken = new Set(positions.map((p) => String(p.position_code ?? '').toLowerCase()));
    /** position id -> [{ id|null, code, shiftId, assignment|null }]; chair 1 is the row itself. */
    const chairsOf = new Map();
    const stats = { split: 0, untouched: 0, newRows: 0, peopleMoved: 0, shiftGuessed: 0, beyondSanctioned: 0 };

    for (const p of positions) {
      const rq = reqsOf.get(p.id) ?? [];
      const sitting = peopleOf.get(p.id) ?? [];
      const count = (shift) => rq.filter((r) => r.shift_id === shift.id).reduce((n, r) => n + Math.ceil(Number(r.required_count)), 0);
      const dayN = count(day);
      const nightN = count(night);
      const dayNight = dayN > 0 && nightN > 0;
      const own = p.default_shift_id ?? general.id;

      const seatShifts = [];
      if (dayNight) {
        for (let i = 0; i < Math.max(dayN, nightN); i++) {
          if (i < dayN) seatShifts.push(day.id);
          if (i < nightN) seatShifts.push(night.id);
        }
      } else {
        for (let i = 0; i < Math.max(1, Math.ceil(Number(p.sanctioned_headcount || 1))); i++) seatShifts.push(own);
      }
      const sanctioned = seatShifts.length;
      while (seatShifts.length < sitting.length) seatShifts.push(dayNight ? day.id : own);
      if (sitting.length > sanctioned) stats.beyondSanctioned += sitting.length - sanctioned;

      const done = seatShifts.length === 1 && rq.length === 0 && p.default_shift_id != null
        && (!sitting[0] || sitting[0].default_shift_id === p.default_shift_id);
      if (done) {
        stats.untouched++;
        chairsOf.set(p.id, [{ id: p.id, code: p.position_code, shiftId: p.default_shift_id, assignment: sitting[0] ?? null, source: p }]);
        continue;
      }

      const many = seatShifts.length > 1;
      if (many) stats.split++;
      const chairs = seatShifts.map((shiftId, i) => {
        let code = p.position_code;
        if (many && code) {
          code = `${p.position_code}-${i + 1}`;
          if (taken.has(code.toLowerCase())) throw new Error(`Code ${code} is already in use, so ${p.position_code} cannot be split.`);
          taken.add(code.toLowerCase());
        }
        const a = sitting[i] ?? null;
        if (a && dayNight) stats.shiftGuessed++;
        return { id: i === 0 ? p.id : null, code, shiftId, assignment: a, source: p };
      });
      stats.newRows += chairs.length - 1;
      chairsOf.set(p.id, chairs);
    }

    const all = [...chairsOf.values()].flat();
    const filled = all.filter((c) => c.assignment).length;
    console.log(`\n  ${company.name} (${cid})`);
    console.log(`  positions today      ${positions.length}   (${stats.untouched} already one chair)`);
    console.log(`  split into chairs    ${stats.split} positions -> ${stats.newRows} new rows`);
    console.log(`  positions afterwards ${all.length}   filled ${filled}   vacant ${all.length - filled}`);
    for (const s of [general, day, night]) console.log(`    ${String(s.name).padEnd(8)} ${all.filter((c) => c.shiftId === s.id).length}`);
    console.log(`  people whose shift is a guess (day/night positions): ${stats.shiftGuessed}`);
    console.log(`  people beyond the sanctioned seats (kept, on days):   ${stats.beyondSanctioned}`);
    console.log(`  reporting lines today ${edges.length}`);

    if (!APPLY) { console.log('\n  DRY RUN. Nothing written. Add --apply to write.\n'); return; }

    await conn.beginTransaction();
    try {
      // 1. New chairs in bulk, then read their ids back by code.
      const fresh = all.filter((c) => c.id == null);
      for (let i = 0; i < fresh.length; i += CH) {
        await conn.query(
          `INSERT INTO hrms_positions (company_id, position_code, role_id, position_title, department_id, location_id,
                                       sanctioned_headcount, default_shift_id, status, effective_from, effective_to, created_by) VALUES ?`,
          [fresh.slice(i, i + CH).map((c) => [cid, c.code, c.source.role_id, c.source.position_title, c.source.department_id,
            c.source.location_id, 1, c.shiftId, c.source.status, c.source.effective_from, c.source.effective_to, c.source.created_by])]);
      }
      if (fresh.length) {
        const [back] = await conn.query('SELECT id, position_code FROM hrms_positions WHERE company_id = ? AND deleted_at IS NULL', [cid]);
        const idOf = new Map(back.map((r) => [String(r.position_code).toLowerCase(), r.id]));
        for (const c of fresh) {
          c.id = idOf.get(String(c.code).toLowerCase());
          if (!c.id) throw new Error(`Chair ${c.code} was not written.`);
        }
      }

      // 2. Chair 1: one seat, its shift, its new code.
      for (const chairs of chairsOf.values()) {
        const c = chairs[0];
        const p = c.source;
        if (Number(p.sanctioned_headcount) === 1 && p.default_shift_id === c.shiftId && p.position_code === c.code) continue;
        await conn.query('UPDATE hrms_positions SET sanctioned_headcount = 1, default_shift_id = ?, position_code = ? WHERE company_id = ? AND id = ?',
          [c.shiftId, c.code, cid, c.id]);
      }

      // 3. People into their chairs.
      for (const c of all) {
        if (!c.assignment) continue;
        if (c.assignment.position_id === c.id && c.assignment.default_shift_id === c.shiftId) continue;
        await conn.query('UPDATE hrms_work_assignments SET position_id = ?, default_shift_id = ? WHERE company_id = ? AND id = ?',
          [c.id, c.shiftId, cid, c.assignment.id]);
        stats.peopleMoved++;
      }

      // 4. Reporting lines: every chair gets the line, to the manager's chair on its own shift.
      const managerChair = (toId, shiftId) => {
        const chairs = chairsOf.get(toId) ?? [];
        return (chairs.find((c) => c.shiftId === shiftId) ?? chairs[0])?.id ?? toId;
      };
      const edgeCols = ['company_id', 'from_position_id', 'to_position_id', 'relationship_type_id', 'is_primary', 'scope_type',
        'scope_label', 'scope_work_context_id', 'effective_from', 'effective_to', 'notes', 'created_by'];
      const newEdges = [];
      let edgesMoved = 0;
      for (const e of edges) {
        const chairs = chairsOf.get(e.from_position_id) ?? [];
        for (const [i, c] of chairs.entries()) {
          const to = managerChair(e.to_position_id, c.shiftId);
          if (i === 0) {
            if (to !== e.to_position_id) {
              await conn.query('UPDATE hrms_position_reporting_relationships SET to_position_id = ? WHERE company_id = ? AND id = ?', [to, cid, e.id]);
              edgesMoved++;
            }
          } else {
            newEdges.push(edgeCols.map((k) => (k === 'from_position_id' ? c.id : k === 'to_position_id' ? to : e[k])));
          }
        }
      }
      for (let i = 0; i < newEdges.length; i += CH) {
        await conn.query(`INSERT INTO hrms_position_reporting_relationships (${edgeCols.join(', ')}) VALUES ?`, [newEdges.slice(i, i + CH)]);
      }

      // 5. Position-level content changes and work contexts follow every chair.
      const SKIP = new Set(['id', 'deleted_at', 'created_at', 'updated_at']);
      const copyTo = async (table, rows) => {
        if (!rows.length) return 0;
        const [colRows] = await conn.query(`SHOW COLUMNS FROM ${table}`);
        const cols = colRows.filter((c) => !SKIP.has(c.Field) && !/GENERATED/i.test(c.Extra)).map((c) => c.Field);
        const out = [];
        for (const r of rows) {
          for (const c of (chairsOf.get(r.position_id) ?? []).slice(1)) {
            out.push(cols.map((k) => {
              if (k === 'position_id') return c.id;
              const v = r[k];
              return v != null && typeof v === 'object' ? JSON.stringify(v) : v;
            }));
          }
        }
        for (let i = 0; i < out.length; i += CH) await conn.query(`INSERT INTO ${table} (${cols.join(', ')}) VALUES ?`, [out.slice(i, i + CH)]);
        return out.length;
      };
      const ovCopied = await copyTo('hrms_position_content_overrides', overrides);
      const ctxCopied = await copyTo('hrms_position_work_contexts', contexts);

      // 6. A chair is the requirement now.
      const [gone] = await conn.query(
        'UPDATE hrms_manpower_requirements SET deleted_at = NOW() WHERE company_id = ? AND deleted_at IS NULL AND position_id IS NOT NULL', [cid]);

      // Proof before commit: nobody shares a chair, every chair has a shift.
      const [[shared]] = await conn.query(
        `SELECT COUNT(*) n FROM (SELECT position_id FROM hrms_work_assignments WHERE company_id = ? AND deleted_at IS NULL
                                  AND status <> 'ENDED' AND position_id IS NOT NULL GROUP BY position_id HAVING COUNT(*) > 1) x`, [cid]);
      const [[noShift]] = await conn.query(
        'SELECT COUNT(*) n FROM hrms_positions WHERE company_id = ? AND deleted_at IS NULL AND (default_shift_id IS NULL OR sanctioned_headcount <> 1)', [cid]);
      const [[total]] = await conn.query('SELECT COUNT(*) n FROM hrms_positions WHERE company_id = ? AND deleted_at IS NULL', [cid]);
      if (Number(shared.n) || Number(noShift.n) || Number(total.n) !== all.length) {
        throw new Error(`Check failed: shared chairs ${shared.n}, chairs without a shift ${noShift.n}, positions ${total.n} (expected ${all.length}). Rolled back.`);
      }
      await conn.commit();
      console.log(`\n  WRITTEN. ${fresh.length} positions added, ${stats.peopleMoved} people moved, ${edgesMoved} reporting lines re-pointed, `
        + `${newEdges.length} added, ${ovCopied} content changes and ${ctxCopied} work contexts copied, ${gone.affectedRows} requirement rows retired.\n`);
    } catch (err) {
      await conn.rollback();
      throw err;
    }
  } finally {
    await conn.end();
  }
}

main().catch((err) => { console.error(`\n  FAILED: ${err.message}\n`); process.exit(1); });
