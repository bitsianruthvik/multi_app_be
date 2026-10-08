/**
 * charts-to-rows.mjs — every chart into the ROWS form (user, 2026-10-08: "multiple variables and a
 * single value"; chartService.js, formulaEngine.lookupRows).
 *
 * A chart's table_config becomes version 2 — each column a specification of the piece (its kind
 * and unit kept) — and every stored value of it, on a machine type, on a machine (its own, or the
 * copy a machine holds of its type's), is turned from { x, v } / { x, y, v } into rows
 * [[x, result]] / [[x, y, result]]. A two-column grid's blank cell stays a row with a blank result
 * ("the machine cannot"). A two-column chart read on a straight line is listed: the rows form
 * reads a straight line on its last column only. Times read exactly the same before and after; the script
 * checks that on every machine that has a chart: old answer = new answer at every row's inputs.
 *
 *   node scripts/cf_kepl/charts-to-rows.mjs --company 30005            (dry run: rolled back)
 *   node scripts/cf_kepl/charts-to-rows.mjs --company 30005 --apply    (commits)
 * Re-running changes nothing.
 */
const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const COMPANY = Number(arg('company'));
const APPLY = process.argv.includes('--apply');
if (!Number.isInteger(COMPANY)) throw new Error('Usage: --company <id> [--apply]');

const { pool } = await import('../../db.js');
const { rowsOfValue } = await import('../../apps/cf_erp/services/chartService.js');
const { lookupRows, parseFormula, evaluateFormula } = await import('../../apps/cf_erp/services/formulaEngine.js');
const parseJson = (v) => { if (v == null) return null; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return null; } };

/** The first version's own reading, for the check: LOOKUP(t, x[, y]) on { x, v } / { x, y, v }. */
function oldAnswer(cfg, value, inputs) {
  const p = parseFormula(inputs.length === 1 ? 'LOOKUP(machine.T, item.A)' : 'LOOKUP(machine.T, item.A, item.B)');
  const ctx = { item: (c) => (c === 'A' ? inputs[0] : inputs[1]), machine: () => null, itemTable: () => null, machineTable: () => ({ mode: cfg.mode ?? 'step_up', axes: cfg.axes ?? [], ...value }) };
  return evaluateFormula(p, () => null, null, ctx).value;
}

const db = await pool.getConnection();
try {
  await db.beginTransaction();
  const [fields] = await db.query("SELECT UPPER(code) AS code, data_type FROM cf_specifications WHERE company_id = ? AND deleted_at IS NULL", [COMPANY]);
  const typeOf = new Map(fields.map((f) => [f.code, f.data_type]));
  const [charts] = await db.query("SELECT id, code, name, default_uom, table_config FROM cf_specifications WHERE company_id = ? AND deleted_at IS NULL AND data_type = 'table' ORDER BY code", [COMPANY]);
  let specs = 0; let values = 0; let checked = 0; const wrong = [];
  for (const c of charts) {
    const cfg = parseJson(c.table_config) ?? {};
    const [vals] = await db.query('SELECT id, subject_type, subject_id, value_json FROM cf_spec_values WHERE company_id = ? AND specification_id = ? AND deleted_at IS NULL', [COMPANY, c.id]);
    const next = {
      version: 2, mode: cfg.mode ?? 'step_up',
      axes: (cfg.axes ?? []).map((a) => (a.kind ? a : { kind: 'spec', field: a.field ?? null, label: a.label, unit: a.unit ?? null, dataType: a.field ? (typeOf.get(String(a.field).toUpperCase()) ?? 'number') : 'number' })),
    };
    let moved = 0;
    if (next.mode === 'linear' && next.axes.length > 1) console.log(`  ! ${c.code} reads two columns on a straight line — the rows form steps up the first and reads a line on the last`);
    for (const v of vals) {
      const old = parseJson(v.value_json);
      if (!old || Array.isArray(old.rows)) continue;
      const rows = rowsOfValue(old);
      // The check: the rows answer exactly what the old chart answered, at every row's inputs.
      for (const r of rows) {
        const ins = r.slice(0, -1);
        const before = oldAnswer(cfg, old, ins);
        const after = lookupRows({ ...next, rows }, ins).value ?? null;
        checked++;
        if (!(before == null && after == null) && Math.abs(Number(before) - Number(after)) > 1e-6) wrong.push(`${c.code} ${v.subject_type} ${v.subject_id} at ${ins.join(' × ')}: ${before} → ${after}`);
      }
      await db.query('UPDATE cf_spec_values SET value_json = ? WHERE id = ?', [JSON.stringify({ rows }), v.id]);
      moved++; values++;
    }
    if ((cfg.version ?? 1) < 2) { await db.query('UPDATE cf_specifications SET table_config = ? WHERE id = ?', [JSON.stringify(next), c.id]); specs++; }
    console.log(`  ${c.code.padEnd(16)} ${c.name} (${c.default_uom ?? '?'}) by ${next.axes.map((a) => `${a.label}${a.unit ? ` (${a.unit})` : ''}`).join(' × ')} · ${moved} stored chart${moved === 1 ? '' : 's'} turned into rows`);
  }
  console.log(`\n${charts.length} charts · ${specs} set to rows · ${values} stored values turned into rows · ${checked} rows checked, ${wrong.length} answered differently`);
  for (const w of wrong.slice(0, 20)) console.log(`  ! ${w}`);
  if (wrong.length) throw new Error('Some rows would answer differently — nothing changed.');
  if (APPLY) { await db.commit(); console.log('COMMITTED'); } else { await db.rollback(); console.log('DRY RUN — rolled back. Add --apply to keep it.'); }
} catch (err) {
  await db.rollback().catch(() => {});
  console.error('ERROR', err.message);
  process.exitCode = 1;
} finally {
  db.release();
  await pool.end();
}
