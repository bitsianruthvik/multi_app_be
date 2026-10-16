/**
 * structure-kpi-targets.mjs — move a company's EXISTING KPI targets to structured targets.
 * (TM/CF_HRMS_HIRING_SPEC.md §24 step 2.)
 *
 *   node structure-kpi-targets.mjs --company=karni                    DRY RUN — the table, nothing written
 *   node structure-kpi-targets.mjs --company=karni --apply
 *   node structure-kpi-targets.mjs --company=karni --apply --target=prod
 *
 * Run apply-kpi-targets-schema.mjs first (target_json and the new ENUM values).
 *
 * WHAT IT DOES
 *   1. For each library KPI (hrms_kpi_definitions) whose MEASURED IN or WHICH WAY is not set, it reads the
 *      targets of the lines that use it — role lines, and position / person lines that set a target — with
 *      the one parser (services/kpiTarget.js readTargetText, the KPI's name in mind). Lines whose target is
 *      words do not vote. When EVERY line that reads agrees (measured in, unit, which way), the KPI gets
 *      them. When they disagree it is a CONFLICT: it is printed, and nothing is set on that KPI — setting
 *      the majority would change what the other lines mean.
 *   2. For each line (role row, or a position / person override that sets a target) with no structure
 *      yet, the structure is set when its text reads cleanly against its KPI as step 1 leaves it. The
 *      TEXT is never changed, so the JD, the Ask index and Excel read exactly what they read today, and
 *      a plan copies what it copied before (the parser made the same reading at plan time).
 *   Lines that stay words are listed with why.
 *
 * IN PLACE, NOT DATED. The meaning of a target does not change — only how it is stored — so these are
 * corrections of the row in place, not new dated versions (§16): the history is not filled with noise.
 * Each change writes one hrms_audit_log row (UPDATE, before / after, request_id
 * structure-kpi-targets-<YYYY-MM-DD>-<run>).
 *
 * SAFETY. One transaction. The dry run plans exactly what --apply writes (planMove, then applyMove — a
 * test checks they agree) and writes nothing. A second run finds nothing to do. Reads are one query per
 * table; writes are one statement per row (a few dozen) plus one audit insert. Local by default
 * (scripts/dbTarget.mjs); credentials are never printed.
 */
import path from 'path';
import { fileURLToPath } from 'url';
import mysql from 'mysql2/promise';
import { resolveTarget, announce } from './dbTarget.mjs';
import {
  readTargetText, normaliseSpec, measureOf, betterOf, MEASURE_WORDS, BETTER_WORDS, textOfTarget,
} from '../services/kpiTarget.js';

const readJson = (v) => {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return v; }
};
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** Why a target stays words, in a few words. */
function whyWords(text, def, name) {
  const s = String(text ?? '').trim();
  if (!s) return 'no target';
  const alone = readTargetText(s, { name });
  if (alone && def && (measureOf(def) || betterOf(def))) return `does not fit its KPI (${MEASURE_WORDS[measureOf(def)] ?? 'any'} / ${BETTER_WORDS[betterOf(def)] ?? 'any way'})`;
  if (/(^|\s)(?:1[).]|2[).])\s/.test(s) || /\b2[).]\s/.test(s)) return 'more than one target';
  if (/\b(?:by|before|till|until|end of)\b/i.test(s) || /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b\.?\s*'?\d{2}/i.test(s)) return 'a date with other words';
  if (/\d/.test(s)) return 'a number with a condition or other words';
  return 'words, not a number';
}

const sameJson = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const vote = (spec) => (spec ? { measure: spec.measure, unit: spec.measure === 'BOOLEAN' || spec.measure === 'DATE' ? null : spec.unit ?? null, direction: spec.direction ?? null } : null);

/**
 * What would change, read only.
 * @returns { defs: [{ id, name, before, after, set, conflict, lines, read, words }], lines: [{ table, id, defId, layer, text, spec | null, why? }], changes: { defs, lines } }
 */
export async function planMove(conn, companyId) {
  const [defs] = await conn.query('SELECT id, code, name, measurement_type, unit, direction FROM hrms_kpi_definitions WHERE company_id = ? AND deleted_at IS NULL ORDER BY name, id', [companyId]);
  const [roleRows] = await conn.query(
    `SELECT a.id, a.role_id, a.kpi_definition_id, a.target_operator, a.target_value, a.target_json, r.title AS role_title
       FROM hrms_role_kpi_assignments a JOIN hrms_roles r ON r.company_id = a.company_id AND r.id = a.role_id
      WHERE a.company_id = ? AND a.deleted_at IS NULL ORDER BY a.id`, [companyId]);
  const overlay = [];
  for (const [table, layer] of [['hrms_position_content_overrides', 'POSITION'], ['hrms_work_assignment_content_overrides', 'PERSON']]) {
    const [rows] = await conn.query(
      `SELECT id, kpi_definition_id, action, override_json FROM ${table}
        WHERE company_id = ? AND content_type = 'KPI' AND action IN ('ADD', 'OVERRIDE') AND deleted_at IS NULL
          AND (effective_to IS NULL OR effective_to >= ?) AND NOT (effective_from IS NOT NULL AND effective_to IS NOT NULL AND effective_to < effective_from)
        ORDER BY id`, [companyId, today()]);
    for (const r of rows) {
      const json = readJson(r.override_json) ?? {};
      if (!('targetOperator' in json) && !('targetValue' in json)) continue;
      overlay.push({ table, layer, id: r.id, defId: r.kpi_definition_id, json, text: textOfTarget(json.targetOperator, json.targetValue), stored: json.targetSpec ?? null });
    }
  }
  const lines = [
    ...roleRows.map((r) => ({
      table: 'hrms_role_kpi_assignments', layer: 'ROLE', id: r.id, defId: r.kpi_definition_id, where: r.role_title,
      text: textOfTarget(r.target_operator, readJson(r.target_value)), stored: readJson(r.target_json), operator: r.target_operator,
    })),
    ...overlay,
  ].filter((l) => l.text != null || l.stored);

  // 1. the library KPIs.
  const outDefs = [];
  const afterDef = new Map();
  for (const d of defs) {
    const mine = lines.filter((l) => Number(l.defId) === Number(d.id) && l.text);
    const asIs = { measurementType: d.measurement_type, unit: d.unit, direction: d.direction };
    const needMeasure = !measureOf(asIs);
    const needDirection = !betterOf(asIs);
    const votes = mine.map((l) => vote(readTargetText(l.text, { def: asIs, name: d.name }))).filter(Boolean);
    const one = (key) => [...new Set(votes.map((v) => JSON.stringify(key(v))))];
    const measures = one((v) => [v.measure, v.unit]);
    const directions = one((v) => v.direction);
    let after = asIs;
    let conflict = null;
    if (votes.length && (needMeasure || needDirection)) {
      if (needMeasure && measures.length > 1) conflict = `measured in: ${measures.map((m) => JSON.parse(m).filter(Boolean).join(' ')).join(' vs ')}`;
      else if (needDirection && directions.length > 1 && !['BOOLEAN', 'DATE'].includes(votes[0].measure)) conflict = `which way: ${directions.map((x) => JSON.parse(x)).join(' vs ')}`;
      if (!conflict) {
        const [measure, unit] = JSON.parse(measures[0]);
        const direction = JSON.parse(directions[0]);
        after = {
          measurementType: needMeasure ? measure : asIs.measurementType,
          unit: needMeasure ? (measure === 'NUMBER' && unit === 'count' ? null : unit) : asIs.unit,
          direction: needDirection && !['BOOLEAN', 'DATE'].includes(measure) ? direction : asIs.direction,
        };
      }
    }
    afterDef.set(Number(d.id), { ...after, name: d.name });
    const set = !sameJson([asIs.measurementType, asIs.unit, asIs.direction], [after.measurementType, after.unit, after.direction]);
    outDefs.push({ id: d.id, code: d.code, name: d.name, before: asIs, after, set, conflict, lines: mine.length, read: votes.length, words: mine.length - votes.length });
  }

  // 2. the lines.
  const outLines = [];
  for (const l of lines) {
    if (l.stored) continue; // already structured: nothing to do (a second run finds nothing)
    const def = afterDef.get(Number(l.defId)) ?? null;
    const spec = normaliseSpec(readTargetText(l.text, { def, name: def?.name ?? '' }));
    outLines.push({
      table: l.table, layer: l.layer, id: l.id, defId: l.defId, kpi: def?.name ?? `#${l.defId}`, where: l.where ?? null, text: l.text, json: l.json ?? null,
      spec, why: spec ? null : whyWords(l.text, def, def?.name ?? ''),
    });
  }
  return {
    defs: outDefs,
    lines: outLines,
    changes: { defs: outDefs.filter((d) => d.set).length, lines: outLines.filter((l) => l.spec).length },
  };
}

/** Writes a plan: in place, one audit row per change. Returns the counts written. */
export async function applyMove(conn, companyId, plan, requestId, { userId = null } = {}) {
  const audits = [];
  for (const d of plan.defs.filter((x) => x.set)) {
    await conn.query('UPDATE hrms_kpi_definitions SET measurement_type = ?, unit = ?, direction = ? WHERE company_id = ? AND id = ?',
      [d.after.measurementType, d.after.unit ?? null, d.after.direction ?? null, companyId, d.id]);
    audits.push([companyId, userId, 'hrms_kpi_definitions', d.id, 'UPDATE', JSON.stringify(d.before), JSON.stringify(d.after), requestId, userId]);
  }
  for (const l of plan.lines.filter((x) => x.spec)) {
    if (l.table === 'hrms_role_kpi_assignments') {
      await conn.query('UPDATE hrms_role_kpi_assignments SET target_json = ? WHERE company_id = ? AND id = ? AND target_json IS NULL', [JSON.stringify(l.spec), companyId, l.id]);
    } else {
      await conn.query(`UPDATE ${l.table} SET override_json = ? WHERE company_id = ? AND id = ?`, [JSON.stringify({ ...l.json, targetSpec: l.spec }), companyId, l.id]);
    }
    audits.push([companyId, userId, l.table, l.id, 'UPDATE', JSON.stringify({ targetText: l.text, targetSpec: null }), JSON.stringify({ targetText: l.text, targetSpec: l.spec }), requestId, userId]);
  }
  if (audits.length) {
    await conn.query(
      `INSERT INTO hrms_audit_log (company_id, actor_user_id, entity_type, entity_id, action, before_json, after_json, request_id, created_by) VALUES ?`,
      [audits],
    );
  }
  return { defs: plan.defs.filter((x) => x.set).length, lines: plan.lines.filter((x) => x.spec).length, audits: audits.length };
}

const pad = (s, n) => String(s ?? '').slice(0, n).padEnd(n);
const ruleWords = (d) => [MEASURE_WORDS[measureOf(d)] ?? '—', d?.unit && measureOf(d) !== 'PERCENTAGE' && measureOf(d) !== 'CURRENCY' ? `(${d.unit})` : ''].filter(Boolean).join(' ');

/** The dry-run table, as text. */
export function report(plan) {
  const out = [];
  out.push(`  ${pad('KPI', 52)} ${pad('Measured in', 18)} ${pad('Which way', 17)} ${pad('Lines', 6)} ${pad('Read', 5)} Change`);
  for (const d of plan.defs.filter((x) => x.lines > 0)) {
    const change = d.conflict ? `CONFLICT — ${d.conflict}; nothing set` : d.set ? 'set' : (measureOf(d.before) && betterOf(d.before) ? 'already set' : 'nothing read');
    out.push(`  ${pad(d.name, 52)} ${pad(ruleWords(d.after), 18)} ${pad(BETTER_WORDS[betterOf(d.after)] ?? (['BOOLEAN', 'DATE'].includes(measureOf(d.after)) ? '(none needed)' : '—'), 17)} ${pad(d.lines, 6)} ${pad(d.read, 5)} ${change}`);
  }
  const words = plan.lines.filter((l) => !l.spec);
  out.push('');
  out.push(`  LINES — ${plan.lines.length} without a structure; ${plan.lines.filter((l) => l.spec).length} get one; ${words.length} stay words:`);
  for (const l of words) out.push(`    ${pad(l.layer, 8)} ${pad(l.kpi, 40)} ${pad(`"${String(l.text).replace(/\s+/g, ' ')}"`, 70)} — ${l.why}`);
  const conflicts = plan.defs.filter((d) => d.conflict);
  out.push('');
  out.push(`  CONFLICTS — ${conflicts.length}${conflicts.length ? ':' : ''}`);
  for (const d of conflicts) out.push(`    ${d.name}: ${d.conflict}`);
  out.push('');
  out.push(`  COUNTS  KPIs set ${plan.changes.defs} · lines structured ${plan.changes.lines} · lines left as words ${words.length} · conflicts ${conflicts.length}`);
  return out.join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  const APPLY = args.includes('--apply');
  const slug = (args.find((a) => a.startsWith('--company=')) ?? '--company=karni').split('=')[1];
  const target = resolveTarget();
  announce(target);
  const conn = await mysql.createConnection({ ...target.cfg, dateStrings: true });
  try {
    const [[company]] = await conn.query('SELECT id, name FROM companies WHERE slug = ? AND deleted_at IS NULL', [slug]);
    if (!company) throw new Error(`No company "${slug}".`);
    console.log(`  company: ${company.name} (${slug})${APPLY ? '' : '   DRY RUN — nothing is written without --apply'}\n`);
    const requestId = `structure-kpi-targets-${today()}-${Date.now().toString(36)}`;
    await conn.beginTransaction();
    try {
      const plan = await planMove(conn, company.id);
      console.log(report(plan));
      if (APPLY && (plan.changes.defs || plan.changes.lines)) {
        const done = await applyMove(conn, company.id, plan, requestId);
        const again = await planMove(conn, company.id);
        if (again.changes.defs || again.changes.lines) throw new Error(`after applying, a second run would still change ${again.changes.defs} KPIs and ${again.changes.lines} lines`);
        await conn.commit();
        console.log(`\n  APPLIED — ${done.defs} KPIs, ${done.lines} lines, ${done.audits} audit rows (request_id ${requestId}). A second run plans nothing.\n`);
      } else {
        await conn.rollback();
        console.log(APPLY ? '\n  nothing to do.\n' : '\n  DRY RUN — nothing written. Run again with --apply.\n');
      }
    } catch (err) {
      await conn.rollback().catch(() => {});
      throw err;
    }
  } finally {
    await conn.end();
  }
}

// Run only when called as a script; a test imports planMove / applyMove.
if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) main().then(() => process.exit(0)).catch((e) => { console.error(`\n  FAILED: ${e.message}\n`); process.exit(1); });
