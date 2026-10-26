/**
 * suggest-unit-reporting.mjs — the §40 migration: a head and a Reports into per org unit, and the
 * explicit primary lines that become derived (TM/CF_HRMS_HIRING_SPEC.md §40.7).
 *
 *   node suggest-unit-reporting.mjs [--company=karni] [--apply] [--target=prod]
 *
 * DRY RUN by default: prints a table per unit and writes nothing. Without --company, every company
 * that has org units. Works read-only on a database without the §41 schema (a production dry run
 * before apply-unit-reporting-schema.mjs); --apply needs the schema.
 *
 * ── THE RULES ─────────────────────────────────────────────────────────────
 * Only units that have NO head yet are touched (so a second run plans nothing, and a head set on a
 * screen is never replaced).
 *
 * HEAD. Among the unit's own live positions, look at their explicit primary lines (general scope)
 * that point at a position in the unit or a unit above it:
 *   - MOST_REPORT_TO  the position most of them already report to. When the unit's people split by
 *                     shift and each shift reports to a different chair (Day in-charge / Night
 *                     in-charge), a head PER SHIFT. Ties: the chair nearer the top, then the lower code.
 *   - SENIOR_MOST     nobody reports inside the tree: the unit's position nearest the top by its
 *                     existing reporting chain (fewest steps up), then most people reporting to it,
 *                     then the lower code.
 * A unit with no positions of its own gets no head (it reports through the unit above).
 *
 * REPORTS INTO. For a head sitting in the unit: what the head already reports to. Equal to the
 * default (the parent's head, or further up) -> DEFAULT; different but in the parent unit or above ->
 * CHOSEN; outside the tree -> DEFAULT, and the head's own line stays explicit (it shows in the check).
 *
 * LINES THAT BECOME DERIVED. An explicit primary line is removed (soft-deleted, audited) ONLY when the
 * position has exactly that one live primary line (general scope, no label, no notes, no end date, no
 * cross-tree reason) AND the line its unit gives it without that row is the very same chair. Every
 * other line stays explicit.
 *
 * THE GUARANTEE. Every live position is resolved before and after (its manager chair, and the person's
 * chair after walking past vacant ones). If a single one differs the plan is refused — in the dry run
 * it is reported, with --apply the transaction is rolled back. A new reporting loop refuses it too.
 */
import path from 'path';
import { fileURLToPath } from 'url';
import mysql from 'mysql2/promise';
import { resolveTarget, announce } from './dbTarget.mjs';
import { hasUnitReportingSchema } from './apply-unit-reporting-schema.mjs';
import { buildReportingModel, findInconsistencies } from '../lib/unitReporting.js';
import { loadReportingModel } from '../services/reportingResolver.js';

const APPLY = process.argv.includes('--apply');
const companyArg = (process.argv.find((a) => a.startsWith('--company=')) ?? '').split('=')[1] || null;

const byCode = (a, b) => String(a?.code ?? '').localeCompare(String(b?.code ?? ''), undefined, { numeric: true }) || (a?.id ?? 0) - (b?.id ?? 0);

/** Every live position's manager chair and person chair. */
export function resolveAll(model) {
  const out = new Map();
  for (const p of model.positions.values()) {
    if (!p.live) continue;
    const s = model.step(p.id);
    out.set(p.id, { step: s ? s.managerId : null, person: model.manager(p.id).positionId, source: s?.source ?? null });
  }
  return out;
}

export function differences(before, after) {
  const diff = [];
  for (const [id, b] of before) {
    const a = after.get(id);
    if (!a || a.step !== b.step || a.person !== b.person) diff.push({ positionId: id, before: b, after: a ?? null });
  }
  return diff;
}

function inputsOf(model, explicitRows) {
  return {
    positions: [...model.positions.values()],
    units: [...model.units.values()],
    heads: [...model.units.keys()].flatMap((id) => model.allHeadsOf(id)),
    explicit: explicitRows.map((e) => ({ id: e.id, fromPositionId: e.from_position_id, toPositionId: e.to_position_id, scopeType: e.scope_type, crossTreeReason: e.cross_tree_reason ?? null })),
  };
}

/** Explicit depth: steps up a position's explicit lines to the top (loop-safe). */
function explicitDepth(model, id) {
  let d = 0;
  const seen = new Set([id]);
  let cur = id;
  while (d < 200) {
    const ex = model.explicitOf.get(cur);
    if (!ex) return d;
    cur = Number(ex.toPositionId);
    if (seen.has(cur)) return d + 1000;
    seen.add(cur);
    d += 1;
  }
  return d;
}

/**
 * The plan for one company: { units: [row], heads, reportsInto, remove, diff, loops, left, model3 }.
 */
export function planCompany(model0, explicitRows) {
  const inputs = inputsOf(model0, explicitRows);
  const reportsCount = new Map();
  for (const e of model0.explicitOf.values()) reportsCount.set(Number(e.toPositionId), (reportsCount.get(Number(e.toPositionId)) ?? 0) + 1);
  const live = [...model0.positions.values()].filter((p) => p.live);
  const newHeads = [];      // { unitId, positionId, shiftId }
  const unitRows = [];

  for (const u of [...model0.units.values()]) {
    const row = { unit: u, members: 0, heads: [], rule: null, ruleNote: '', reportsInto: null, derived: [], keptExplicit: 0, skipped: null };
    unitRows.push(row);
    const members = live.filter((p) => Number(p.departmentId) === Number(u.id));
    row.members = members.length;
    if (model0.allHeadsOf(u.id).length) { row.skipped = 'has a head already'; row.heads = model0.allHeadsOf(u.id).map((h) => ({ positionId: h.positionId, shiftId: h.shiftId })); continue; }
    if (!members.length) { row.skipped = 'no positions of its own'; continue; }
    const allowed = new Set(model0.ancestry(u.id).map((x) => x.id));
    const counts = new Map();        // target -> n
    const byShift = new Map();       // shift -> Map(target -> n)
    let counted = 0;
    for (const m of members) {
      const ex = model0.explicitOf.get(m.id);
      if (!ex || ex.scopeType !== 'GENERAL') continue;
      const t = model0.positions.get(Number(ex.toPositionId));
      if (!t || !t.live || t.id === m.id || t.departmentId == null || !allowed.has(Number(t.departmentId))) continue;
      counted += 1;
      counts.set(t.id, (counts.get(t.id) ?? 0) + 1);
      const s = m.shiftId ?? 0;
      if (!byShift.has(s)) byShift.set(s, new Map());
      byShift.get(s).set(t.id, (byShift.get(s).get(t.id) ?? 0) + 1);
    }
    const top = (map) => [...map.entries()].sort((a, b) => b[1] - a[1]
      || explicitDepth(model0, a[0]) - explicitDepth(model0, b[0])
      || byCode(model0.positions.get(a[0]), model0.positions.get(b[0])))[0];
    if (counted) {
      const shiftGroups = [...byShift.entries()].filter(([s]) => s !== 0);
      const tops = shiftGroups.map(([s, map]) => [s, top(map)]);
      const distinct = new Set(tops.map(([, t]) => t[0]));
      if (!byShift.has(0) && shiftGroups.length >= 2 && distinct.size === shiftGroups.length) {
        for (const [s, t] of tops) row.heads.push({ positionId: t[0], shiftId: Number(s) });
        row.rule = 'MOST_REPORT_TO';
        row.ruleNote = `per shift: ${tops.map(([, t]) => `${t[1]}`).join(' / ')} of ${counted} report to them`;
      } else {
        const [t, n] = top(counts);
        row.heads.push({ positionId: t, shiftId: null });
        row.rule = 'MOST_REPORT_TO';
        row.ruleNote = `${n} of ${members.length} already report to it`;
      }
    } else {
      const best = [...members].sort((a, b) => explicitDepth(model0, a.id) - explicitDepth(model0, b.id)
        || (reportsCount.get(b.id) ?? 0) - (reportsCount.get(a.id) ?? 0) || byCode(a, b))[0];
      row.heads.push({ positionId: best.id, shiftId: null });
      row.rule = 'SENIOR_MOST';
      row.ruleNote = `nobody reports inside the tree; nearest the top (${explicitDepth(model0, best.id)} up)`;
    }
    for (const h of row.heads) newHeads.push({ unitId: u.id, ...h });
  }

  // model1: with the heads.
  const heads1 = [...inputs.heads, ...newHeads.map((h, i) => ({ id: -1 - i, ...h }))];
  const model1 = buildReportingModel({ ...inputs, heads: heads1 });

  // Reports into, for units that got a head sitting in them.
  const unitPatch = new Map();
  for (const row of unitRows) {
    if (row.skipped || !row.heads.length) continue;
    const u = row.unit;
    const inside = row.heads.filter((h) => Number(model0.positions.get(h.positionId)?.departmentId) === Number(u.id));
    if (!inside.length) { row.reportsInto = { mode: 'DEFAULT', note: 'its head sits in a unit above' }; continue; }
    const targets = inside.map((h) => {
      const ex = model0.explicitOf.get(h.positionId);
      const def = model1.defaultReportsInto(u.id, model0.positions.get(h.positionId)?.shiftId ?? null, h.positionId);
      return { h, t: ex && ex.scopeType === 'GENERAL' ? Number(ex.toPositionId) : null, def: def?.positionId ?? null };
    });
    if (targets.every((x) => x.t == null || x.t === x.def)) { row.reportsInto = { mode: 'DEFAULT', positionId: targets[0].def }; continue; }
    const ts = new Set(targets.map((x) => x.t));
    const t = targets[0].t;
    if (ts.size === 1 && t != null && model1.livePos(t) && model1.inTreeAbove(u.id, t) && !model0.subtree(u.id).has(Number(model0.positions.get(t)?.departmentId))) {
      row.reportsInto = { mode: 'CHOSEN', positionId: t };
      unitPatch.set(u.id, { reportsIntoMode: 'CHOSEN', reportsIntoPositionId: t, reportsIntoReason: null });
    } else {
      row.reportsInto = { mode: 'DEFAULT', positionId: targets[0].def, note: 'the head keeps its own line (outside the tree, or different per shift)' };
    }
  }
  const units2 = inputs.units.map((u) => (unitPatch.has(u.id) ? { ...u, ...unitPatch.get(u.id) } : u));
  const model2 = buildReportingModel({ ...inputs, heads: heads1, units: units2 });

  // Lines that become derived.
  const rowsBy = new Map();
  for (const e of explicitRows) rowsBy.set(e.from_position_id, [...(rowsBy.get(e.from_position_id) ?? []), e]);
  const remove = [];
  for (const p of live) {
    const rows = rowsBy.get(p.id) ?? [];
    if (rows.length !== 1) continue;
    const e = rows[0];
    if (e.scope_type !== 'GENERAL' || e.scope_label || (e.notes && String(e.notes).trim()) || e.effective_to || e.cross_tree_reason) continue;
    const without = buildReportingModel({ ...inputs, heads: heads1, units: units2, explicit: inputs.explicit.filter((x) => x.id !== e.id) });
    const s = without.step(p.id);
    if (s && s.managerId === Number(e.to_position_id)) remove.push(e);
  }
  const removeIds = new Set(remove.map((e) => e.id));
  const model3 = buildReportingModel({ ...inputs, heads: heads1, units: units2, explicit: inputs.explicit.filter((x) => !removeIds.has(x.id)) });

  for (const row of unitRows) {
    const members = live.filter((p) => Number(p.departmentId) === Number(row.unit.id));
    row.derived = remove.filter((e) => members.some((m) => m.id === e.from_position_id)).map((e) => e.from_position_id);
    row.keptExplicit = members.filter((m) => model3.explicitOf.has(m.id)).length;
  }

  const diff = differences(resolveAll(model0), resolveAll(model3));
  const loopsBefore = new Set(findInconsistencies(model0).filter((f) => f.kind === 'LOOP').map((f) => f.key));
  const left = findInconsistencies(model3);
  const newLoops = left.filter((f) => f.kind === 'LOOP' && !loopsBefore.has(f.key));
  return { unitRows, newHeads, unitPatch, remove, diff, newLoops, left, model3 };
}

/* ── printing ─────────────────────────────────────────────────────────────── */

const pad = (s, n) => { const t = String(s ?? ''); return t.length > n ? `${t.slice(0, n - 1)}…` : t.padEnd(n); };

function printPlan(model0, plan, shiftCode) {
  const name = (id) => { const p = model0.positions.get(Number(id)); return p ? `${p.code ?? ''} ${p.title}`.trim() : `#${id}`; };
  const who = (id) => { const p = model0.positions.get(Number(id)); return p?.occupantName ? ` (${p.occupantName})` : (p ? ' (vacant)' : ''); };
  const depthOf = (u) => model0.ancestry(u.id).length - 1;
  const ordered = [...plan.unitRows].sort((a, b) => {
    const pa = model0.ancestry(a.unit.id).reverse().map((x) => String(x.code)).join('/');
    const pb = model0.ancestry(b.unit.id).reverse().map((x) => String(x.code)).join('/');
    return pa.localeCompare(pb, undefined, { numeric: true });
  });
  console.log(`  ${pad('Org unit (kind)', 44)} ${pad('Pos', 4)} ${pad('Suggested head', 46)} ${pad('Rule', 40)} ${pad('Reports into', 46)} Derived / kept`);
  console.log(`  ${'-'.repeat(44)} ${'-'.repeat(4)} ${'-'.repeat(46)} ${'-'.repeat(40)} ${'-'.repeat(46)} ${'-'.repeat(14)}`);
  for (const r of ordered) {
    const label = `${'  '.repeat(depthOf(r.unit))}${r.unit.name}${r.unit.type ? ` (${r.unit.type})` : ''}`;
    const head = r.skipped === 'has a head already'
      ? `kept: ${r.heads.map((h) => name(h.positionId)).join(', ')}`
      : r.heads.map((h) => `${h.shiftId != null ? `${shiftCode.get(h.shiftId) ?? h.shiftId}: ` : ''}${name(h.positionId)}${who(h.positionId)}`).join('; ') || '—';
    const rule = r.skipped ?? `${r.rule}: ${r.ruleNote}`;
    const ri = r.reportsInto
      ? (r.reportsInto.mode === 'CHOSEN' ? `CHOSEN ${name(r.reportsInto.positionId)}` : `DEFAULT${r.reportsInto.positionId ? ` → ${name(r.reportsInto.positionId)}` : ''}${r.reportsInto.note ? ` (${r.reportsInto.note})` : ''}`)
      : '—';
    console.log(`  ${pad(label, 44)} ${pad(r.members, 4)} ${pad(head, 46)} ${pad(rule, 40)} ${pad(ri, 46)} ${r.derived.length} / ${r.keptExplicit}`);
  }
  console.log('');
  console.log(`  heads to set: ${plan.newHeads.length} (in ${new Set(plan.newHeads.map((h) => h.unitId)).size} units) · Reports into CHOSEN: ${plan.unitPatch.size} · explicit lines that become derived: ${plan.remove.length}`);
  if (plan.remove.length) {
    console.log('  lines that become derived (position → manager, identical before and after):');
    for (const e of plan.remove) console.log(`    #${e.id}  ${name(e.from_position_id)} → ${name(e.to_position_id)}`);
  }
  const counts = {};
  for (const f of plan.left) counts[f.kind] = (counts[f.kind] ?? 0) + 1;
  console.log(`  left in the check: ${plan.left.length} ${JSON.stringify(counts)}`);
  for (const f of plan.left) {
    if (f.kind === 'CROSS_TREE' && f.edgeId != null) console.log(`    CROSS_TREE  ${name(f.positionId)} → ${name(f.managerId)} (line #${f.edgeId})`);
    else if (f.kind === 'CROSS_TREE') console.log(`    CROSS_TREE  unit ${model0.units.get(f.unitId)?.name} reports into ${name(f.managerId)}`);
    else if (f.kind === 'UNIT_NO_HEAD') console.log(`    UNIT_NO_HEAD ${model0.units.get(f.unitId)?.name}`);
    else if (f.kind === 'NO_MANAGER') console.log(`    NO_MANAGER  ${name(f.positionId)}`);
    else console.log(`    LOOP        ${f.positions.map(name).join(' → ')}`);
  }
  console.log(plan.diff.length
    ? `  RESOLVED MANAGERS: ${plan.diff.length} WOULD CHANGE — the plan is refused:\n${plan.diff.slice(0, 20).map((d) => `    ${name(d.positionId)}: ${name(d.before.step)} → ${d.after ? name(d.after.step) : '—'}`).join('\n')}`
    : `  resolved managers: every one of ${[...model0.positions.values()].filter((p) => p.live).length} live positions identical before and after (manager chair and person chair)`);
  if (plan.newLoops.length) console.log(`  NEW LOOPS: ${plan.newLoops.length} — the plan is refused`);
}

/* ── apply ────────────────────────────────────────────────────────────────── */

async function explicitRowsOf(conn, companyId, on, withReason) {
  const [rows] = await conn.query(
    `SELECT rr.id, rr.from_position_id, rr.to_position_id, rr.scope_type, rr.scope_label, rr.notes, rr.effective_from, rr.effective_to,
            rr.relationship_type_id, rr.is_primary, ${withReason ? 'rr.cross_tree_reason' : 'NULL AS cross_tree_reason'}
       FROM hrms_position_reporting_relationships rr
       JOIN hrms_reporting_relationship_types t ON t.company_id = rr.company_id AND t.id = rr.relationship_type_id
      WHERE rr.company_id = ? AND rr.deleted_at IS NULL AND t.code = 'PRIMARY_MANAGER'
        AND (rr.effective_from IS NULL OR rr.effective_from <= ?) AND (rr.effective_to IS NULL OR rr.effective_to >= ?)
      ORDER BY rr.is_primary DESC, t.sort_order, rr.id`,
    [companyId, on, on],
  );
  return rows;
}

export async function runCompany(conn, company, { apply = false, schema = true, quiet = false } = {}) {
  const model0 = await loadReportingModel(conn, company.id, { unitReporting: schema });
  const explicitRows = await explicitRowsOf(conn, company.id, model0.asOf, schema);
  const [shifts] = await conn.query('SELECT id, code FROM hrms_shifts WHERE company_id = ? AND deleted_at IS NULL', [company.id]);
  const shiftCode = new Map(shifts.map((s) => [s.id, s.code]));
  const plan = planCompany(model0, explicitRows);
  if (!quiet) {
    console.log(`\n  ═══ ${company.slug} (${company.id}) — ${model0.units.size} org units, ${[...model0.positions.values()].filter((p) => p.live).length} live positions, ${explicitRows.length} explicit primary lines, as of ${model0.asOf}\n`);
    printPlan(model0, plan, shiftCode);
  }
  const refused = plan.diff.length > 0 || plan.newLoops.length > 0;
  if (!apply) return { plan, refused, applied: false };
  if (refused) throw new Error(`${company.slug}: refused — resolved managers would change or a loop would appear.`);
  const nothing = !plan.newHeads.length && !plan.unitPatch.size && !plan.remove.length;
  if (nothing) { if (!quiet) console.log('\n  nothing to apply.'); return { plan, refused, applied: false }; }

  await conn.beginTransaction();
  try {
    for (const h of plan.newHeads) {
      // eslint-disable-next-line no-await-in-loop -- one small company, one transaction
      await conn.query('INSERT INTO hrms_unit_heads (company_id, department_id, position_id, shift_id) VALUES (?, ?, ?, ?)', [company.id, h.unitId, h.positionId, h.shiftId]);
    }
    const byUnit = new Map();
    for (const h of plan.newHeads) byUnit.set(h.unitId, [...(byUnit.get(h.unitId) ?? []), { positionId: h.positionId, shiftId: h.shiftId }]);
    for (const [unitId, heads] of byUnit) {
      // eslint-disable-next-line no-await-in-loop
      await conn.query("INSERT INTO hrms_audit_log (company_id, actor_user_id, entity_type, entity_id, action, before_json, after_json) VALUES (?, NULL, 'hrms_unit_heads', ?, 'UPDATE', ?, ?)",
        [company.id, unitId, JSON.stringify({ heads: [] }), JSON.stringify({ heads, by: 'suggest-unit-reporting (spec §40.7)' })]);
    }
    for (const [unitId, p] of plan.unitPatch) {
      // eslint-disable-next-line no-await-in-loop
      await conn.query("UPDATE hrms_departments SET reports_into_mode = 'CHOSEN', reports_into_position_id = ?, reports_into_reason = NULL WHERE company_id = ? AND id = ? AND reports_into_mode = 'DEFAULT'", [p.reportsIntoPositionId, company.id, unitId]);
      // eslint-disable-next-line no-await-in-loop
      await conn.query("INSERT INTO hrms_audit_log (company_id, actor_user_id, entity_type, entity_id, action, before_json, after_json) VALUES (?, NULL, 'hrms_departments', ?, 'UPDATE', ?, ?)",
        [company.id, unitId, JSON.stringify({ reportsInto: { mode: 'DEFAULT' } }), JSON.stringify({ reportsInto: { mode: 'CHOSEN', positionId: p.reportsIntoPositionId }, by: 'suggest-unit-reporting (spec §40.7)' })]);
    }
    for (const e of plan.remove) {
      // eslint-disable-next-line no-await-in-loop
      await conn.query('UPDATE hrms_position_reporting_relationships SET deleted_at = NOW() WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [company.id, e.id]);
      // eslint-disable-next-line no-await-in-loop
      await conn.query("INSERT INTO hrms_audit_log (company_id, actor_user_id, entity_type, entity_id, action, before_json, after_json) VALUES (?, NULL, 'hrms_position_reporting_relationships', ?, 'DELETE', ?, ?)",
        [company.id, e.id, JSON.stringify({ ...e, effective_from: e.effective_from ? String(e.effective_from).slice(0, 10) : null }), JSON.stringify({ derived: true, by: 'suggest-unit-reporting (spec §40.7): the line its org unit gives it is the same chair' })]);
    }
    // THE GUARANTEE, on what was written: resolve every position again inside the transaction.
    const after = await loadReportingModel(conn, company.id, {});
    const diff = differences(resolveAll(model0), resolveAll(after));
    if (diff.length) throw new Error(`${company.slug}: after writing, ${diff.length} resolved managers differ — rolled back.`);
    await conn.commit();
    if (!quiet) console.log(`\n  applied: ${plan.newHeads.length} heads, ${plan.unitPatch.size} Reports into, ${plan.remove.length} lines now derived — every resolved manager checked identical.`);
    return { plan, refused, applied: true };
  } catch (e) {
    await conn.rollback();
    throw e;
  }
}

async function main() {
  const target = resolveTarget();
  announce(target);
  const conn = await mysql.createConnection({ ...target.cfg, dateStrings: true });
  try {
    const schema = await hasUnitReportingSchema(conn);
    if (!schema) console.log('  the §41 schema is not on this database: read as if every unit had no head (DEFAULT). --apply needs it.\n');
    if (APPLY && !schema) throw new Error('run apply-unit-reporting-schema.mjs --apply first.');
    if (!APPLY) console.log('  DRY RUN — nothing is written without --apply');
    const [companies] = await conn.query(
      `SELECT c.id, c.slug FROM companies c WHERE c.deleted_at IS NULL ${companyArg ? 'AND c.slug = ?' : ''}
         AND EXISTS (SELECT 1 FROM hrms_departments d WHERE d.company_id = c.id AND d.deleted_at IS NULL) ORDER BY c.id`,
      companyArg ? [companyArg] : [],
    );
    if (!companies.length) throw new Error(companyArg ? `no company "${companyArg}" with org units` : 'no company has org units');
    let refused = 0;
    for (const c of companies) {
      // eslint-disable-next-line no-await-in-loop -- one company at a time
      const r = await runCompany(conn, c, { apply: APPLY, schema });
      if (r.refused) refused += 1;
    }
    if (APPLY) {
      for (const c of companies) {
        // eslint-disable-next-line no-await-in-loop
        const again = await runCompany(conn, c, { apply: false, schema, quiet: true });
        const left = again.plan.newHeads.length + again.plan.unitPatch.size + again.plan.remove.length;
        if (left) throw new Error(`${c.slug}: a second run would still do ${left} things — not idempotent`);
      }
      console.log('  checked: a second run plans nothing');
    }
    console.log(APPLY ? '\n  done.\n' : `\n  nothing written.${refused ? ` ${refused} compan${refused === 1 ? 'y is' : 'ies are'} REFUSED (see above).` : ' Run again with --apply.'}\n`);
  } finally {
    await conn.end();
  }
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) main().then(() => process.exit(0)).catch((e) => { console.error(`\n  FAILED: ${e.message}\n`); process.exit(1); });
