/**
 * charts-transfer.mjs — the existing charts into the new form (user, 2026-10-08: "Transfer all the
 * current tables into this format too").
 *
 * Every table specification of the company: each column is tied to the piece's value it is read by
 * (matched by its label — "Thickness" → THICKNESS, "Hole diameter" → HOLE_DIA — against the number
 * specifications' codes and names), its unit filled from that value when the column had none, and
 * the result's unit checked. Charts that end up with every column tied can be written by their name
 * in a time formula (lib/chartFormula.js). Time rules are not rewritten — they stay LOOKUP(…) and are
 * SHOWN by name. What could not be matched, or has no unit or no values, is listed.
 *
 *   node scripts/cf_kepl/charts-transfer.mjs --company 30005            (dry run: rolled back)
 *   node scripts/cf_kepl/charts-transfer.mjs --company 30005 --apply    (commits)
 * Re-running changes nothing.
 */
const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const COMPANY = Number(arg('company'));
const APPLY = process.argv.includes('--apply');
if (!Number.isInteger(COMPANY)) throw new Error('Usage: --company <id> [--apply]');

/** Words a column label uses for a value whose code says it differently. */
const ALIAS = { HOLE_DIAMETER: 'HOLE_DIA', DIAMETER_OF_HOLE: 'HOLE_DIA', PLATE_THICKNESS: 'THICKNESS', WELD: 'WELD_SIZE' };
const snake = (s) => String(s ?? '').normalize('NFKD').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase();
const parseJson = (v) => { if (v == null) return null; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return null; } };

const { pool } = await import('../../db.js');
const db = await pool.getConnection();
try {
  await db.beginTransaction();
  const [fields] = await db.query("SELECT UPPER(code) AS code, name, default_uom AS unit FROM cf_specifications WHERE company_id = ? AND deleted_at IS NULL AND data_type = 'number'", [COMPANY]);
  const byCode = new Map(fields.map((f) => [f.code, f]));
  const byName = new Map(fields.map((f) => [snake(f.name), f]));
  const find = (label) => { const k = snake(label); return byCode.get(ALIAS[k] ?? k) ?? byName.get(k) ?? null; };
  const [charts] = await db.query(
    `SELECT s.id, s.code, s.name, s.default_uom, s.table_config,
            (SELECT COUNT(*) FROM cf_spec_values v WHERE v.specification_id = s.id AND v.deleted_at IS NULL) AS charts
       FROM cf_specifications s WHERE s.company_id = ? AND s.deleted_at IS NULL AND s.data_type = 'table' ORDER BY s.code`, [COMPANY]);
  let changed = 0;
  const open = [];
  for (const c of charts) {
    const cfg = parseJson(c.table_config) ?? { axes: [], mode: 'step_up' };
    const before = JSON.stringify(cfg);
    const words = [];
    cfg.axes = (cfg.axes ?? []).map((a) => {
      const f = a.field ? byCode.get(String(a.field).toUpperCase()) : find(a.label);
      const out = { ...a };
      if (f) { out.field = f.code; if (!out.unit && f.unit) out.unit = f.unit; }
      else open.push(`${c.code}: column "${a.label}" matches no piece value — tie it on the chart.`);
      if (!out.unit) open.push(`${c.code}: column "${a.label}" has no unit.`);
      words.push(`${out.label} (${out.unit ?? '?'})${out.field ? ` ← item.${out.field}` : ''}`);
      return out;
    });
    if (!cfg.mode) cfg.mode = 'step_up';
    if (!c.default_uom) open.push(`${c.code}: what it gives has no unit.`);
    if (!Number(c.charts)) open.push(`${c.code}: has no values anywhere yet.`);
    const bound = cfg.axes.length > 0 && cfg.axes.every((a) => a.field);
    if (JSON.stringify(cfg) !== before) {
      await db.query('UPDATE cf_specifications SET table_config = ? WHERE company_id = ? AND id = ?', [JSON.stringify(cfg), COMPANY, c.id]);
      changed++;
    }
    console.log(`  ${c.code.padEnd(16)} ${c.name} (${c.default_uom ?? '?'}) by ${words.join(' × ')}${bound ? `  → write it as ${c.code}` : ''}`);
  }
  console.log(`\n${charts.length} charts · ${changed} changed`);
  if (open.length) { console.log('\nStill to do by hand:'); for (const o of open) console.log(`  - ${o}`); }
  if (APPLY) { await db.commit(); console.log('COMMITTED'); } else { await db.rollback(); console.log('DRY RUN — rolled back. Add --apply to keep it.'); }
} catch (err) {
  await db.rollback().catch(() => {});
  console.error('ERROR', err.message);
  process.exitCode = 1;
} finally {
  db.release();
  await pool.end();
}
