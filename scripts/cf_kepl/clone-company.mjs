/**
 * clone-company.mjs — copy one company's CF_ERP MASTER DATA into another company (user, 2026-10-30: "get all the
 * data set up done for sandbox for it to look like the production — items and definitions and all, no orders").
 *
 * What is copied: classification, specifications + options + assignments + values (charts too), catalog items and
 * definitions with their BOMs, temporary items NOT owned by an order line (standard-drawing trees), coding rules +
 * sequences, formulas, machines + shifts, operations, timing rules, flows (not order-owned ones), waits, processes,
 * stocking areas, cut places / settings, stop reasons, company / plan settings, parties + addresses, selection lists,
 * invoice series, drawings, standard drawings with versions and files. Nothing of orders, stock, buying or
 * production. Soft-deleted rows are not copied.
 *
 * How: ids are the source ids + a per-table offset above anything in use (TiDB caches auto ids ahead, so the gap is
 * large); every declared foreign key, the polymorphic subject_id columns, the undeclared refs listed in EXTRA, chart
 * rows on a level axis (classification ids inside value_json) and coding-rule conditions on classification are
 * moved with their target. A row whose required reference was not copied is dropped; a nullable one is cleared
 * (both reported). References to users become NULL. Foreign-key checks are off while inserting.
 *
 *   node scripts/cf_kepl/clone-company.mjs --from 30005 --to 180005            (dry run: counts only)
 *   node scripts/cf_kepl/clone-company.mjs --from 30005 --to 180005 --apply
 * Refuses when the target already holds any of these rows (re-running is not a merge).
 */
const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const FROM = Number(arg('from'));
const TO = Number(arg('to'));
const APPLY = process.argv.includes('--apply');
if (!Number.isInteger(FROM) || !Number.isInteger(TO) || FROM === TO) throw new Error('Usage: --from <companyId> --to <companyId> [--apply]');

const { pool } = await import('../../db.js');
const target = process.env.DB_HOST && !/localhost|127\.0\.0\.1/.test(process.env.DB_HOST) ? 'PRODUCTION' : 'local';
console.log(`${target} (${process.env.DB_HOST ?? 'localhost'}) — clone company ${FROM} → ${TO}${APPLY ? ' — APPLY' : ' — dry run'}`);

const TABLES = [
  'cf_classification_nodes', 'cf_specifications', 'cf_spec_options', 'cf_spec_assignments', 'cf_master_records',
  'cf_item_details', 'cf_definition_details', 'cf_definition_allowed_items', 'cf_spec_values', 'cf_boms', 'cf_bom_lines',
  'cf_code_schemes', 'cf_code_scheme_conditions', 'cf_code_scheme_segments', 'cf_code_sequences', 'cf_formulas',
  'cf_machines', 'cf_machine_shifts', 'cf_operations', 'cf_operation_machine_rules', 'cf_operation_flows',
  'cf_operation_flow_steps', 'cf_flow_step_links', 'cf_step_wait_rules', 'cf_processes', 'cf_process_stages',
  'cf_process_rules', 'cf_stocking_areas', 'cf_cut_places', 'cf_cut_place_stock', 'cf_cut_settings', 'cf_stop_reasons',
  'cf_company_settings', 'cf_plan_settings', 'cf_plan3_settings', 'cf_parties', 'cf_party_addresses',
  'cf_selection_criteria', 'cf_selection_scope', 'cf_invoice_series', 'cf_drawings', 'cf_drawing_links',
  'cf_part_drawings', 'cf_standard_drawings', 'cf_standard_drawing_versions', 'cf_standard_drawing_files',
];
const ORDER = '(order)';   // a reference into order data: never copied
// Polymorphic subject_id: subject_type → table.
const POLY = {
  cf_spec_assignments: { classification: 'cf_classification_nodes', master: 'cf_master_records', machine: 'cf_machines' },
  cf_spec_values: { classification: 'cf_classification_nodes', master: 'cf_master_records', machine: 'cf_machines' },
  cf_operation_machine_rules: { classification: 'cf_classification_nodes', machine: 'cf_machines', master: 'cf_master_records' },
  cf_drawing_links: { master_record: 'cf_master_records', master: 'cf_master_records', classification: 'cf_classification_nodes' },
};
// Undeclared single-column references: table → { column: referenced table }.
const EXTRA = {
  cf_operation_flows: { source_flow_id: 'cf_operation_flows', owner_order_line_id: ORDER },
  cf_part_drawings: { drawing_id: 'cf_drawings' },
  cf_standard_drawings: { drawing_id: 'cf_drawings', current_version_id: 'cf_standard_drawing_versions' },
  cf_standard_drawing_versions: { standard_id: 'cf_standard_drawings', root_item_id: 'cf_master_records', design_id: 'cf_master_records', from_line_id: ORDER },
  cf_standard_drawing_files: { drawing_id: 'cf_drawings', standard_id: 'cf_standard_drawings', version_id: 'cf_standard_drawing_versions' },
};
const CLEAR_OK = new Set(['cf_standard_drawing_versions.from_line_id']);
const INT_MAX = 2147483647;

const db = await pool.getConnection();
try {
  const [[co]] = await db.query('SELECT id, slug FROM companies WHERE id = ?', [TO]);
  if (!co) throw new Error(`No company ${TO}`);

  // ── Schema: columns, generated columns, primary keys, foreign keys ──
  const [cols] = await db.query(
    `SELECT TABLE_NAME t, COLUMN_NAME c, IS_NULLABLE n, EXTRA x, ORDINAL_POSITION p FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (?) ORDER BY TABLE_NAME, ORDINAL_POSITION`, [TABLES]);
  const [keys] = await db.query(
    `SELECT TABLE_NAME t, CONSTRAINT_NAME k, COLUMN_NAME c, REFERENCED_TABLE_NAME rt, REFERENCED_COLUMN_NAME rc, ORDINAL_POSITION p
       FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (?)
        AND (CONSTRAINT_NAME = 'PRIMARY' OR REFERENCED_TABLE_NAME IS NOT NULL) ORDER BY TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION`, [TABLES]);
  const schema = new Map(TABLES.map((t) => [t, { cols: [], gen: new Set(), nullable: new Set(), pk: [], refs: new Map() }]));
  for (const r of cols) {
    const s = schema.get(r.t);
    if (/GENERATED/i.test(r.x)) s.gen.add(r.c); else s.cols.push(r.c);
    if (r.n === 'YES') s.nullable.add(r.c);
  }
  for (const t of TABLES) if (!schema.get(t).cols.length) throw new Error(`Table ${t} is missing here`);
  for (const k of keys) {
    const s = schema.get(k.t);
    if (k.k === 'PRIMARY') { s.pk.push(k.c); continue; }
    if (k.c === 'company_id') continue;
    // A column → the table it points at (company FKs are composite (company_id, x) → (company_id, id)).
    if (k.rt === 'companies') continue;
    if (!s.refs.has(k.c) || TABLES.includes(k.rt)) s.refs.set(k.c, k.rt);
  }
  for (const [t, m] of Object.entries(EXTRA)) for (const [c, rt] of Object.entries(m)) schema.get(t).refs.set(c, rt);
  const outside = new Map();
  for (const [t, s] of schema) for (const [c, rt] of s.refs) if (!TABLES.includes(rt) && rt !== 'users') outside.set(`${t}.${c}`, rt);

  // ── Source rows ──
  const sel = (t) => {
    const s = schema.get(t);
    const live = s.cols.includes('deleted_at') ? ' AND deleted_at IS NULL' : '';
    let extra = '';
    if (t === 'cf_master_records') extra = ' AND id NOT IN (SELECT master_id FROM cf_item_details WHERE company_id = ? AND owner_order_line_id IS NOT NULL)';
    return [`SELECT ${s.cols.map((c) => `\`${c}\``).join(', ')} FROM \`${t}\` WHERE company_id = ?${live}${extra}`, extra ? [FROM, FROM] : [FROM]];
  };
  const rows = new Map();
  for (const t of TABLES) {
    const [r] = await db.query(...sel(t));
    rows.set(t, r);
    const [[{ n }]] = await db.query(`SELECT COUNT(*) n FROM \`${t}\` WHERE company_id = ?`, [TO]);
    if (n > 0) throw new Error(`Company ${TO} already has ${n} rows in ${t} — this script does not merge.`);
  }

  // ── Id offsets (tables with their own auto id) ──
  const own = TABLES.filter((t) => { const s = schema.get(t); return s.pk.length === 1 && s.pk[0] === 'id'; });
  const off = new Map();
  for (const t of own) {
    const [[{ m }]] = await db.query(`SELECT COALESCE(MAX(id), 0) m FROM \`${t}\``);
    const o = Math.ceil((Number(m) + 5_000_000) / 1_000_000) * 1_000_000;
    const top = Math.max(0, ...rows.get(t).map((r) => r.id)) + o;
    if (top > INT_MAX) throw new Error(`${t}: new ids would pass the INT limit`);
    off.set(t, o);
  }

  // ── Which rows survive: a required reference to a row that is not copied drops the row (repeat until stable) ──
  const kept = new Map(TABLES.map((t) => [t, new Set()]));
  const keyOf = (t, r) => { const s = schema.get(t); return s.pk.length === 1 && s.pk[0] !== 'company_id' ? Number(r[s.pk[0]]) : 0; };
  for (const t of TABLES) for (const r of rows.get(t)) kept.get(t).add(keyOf(t, r));
  const refTarget = (t, r, c, rt) => {
    if (c === 'subject_id' && POLY[t]) return POLY[t][r.subject_type] ?? ORDER;
    return rt;
  };
  const refsOf = (t) => {
    const s = schema.get(t);
    const list = [...s.refs.entries()];
    if (POLY[t] && !s.refs.has('subject_id')) list.push(['subject_id', null]);
    return list;
  };
  const dropped = {}; const cleared = {};
  const note = (bag, k) => { bag[k] = (bag[k] ?? 0) + 1; };
  let changed = true;
  const survivors = new Map(TABLES.map((t) => [t, rows.get(t)]));
  while (changed) {
    changed = false;
    for (const t of TABLES) {
      const s = schema.get(t);
      const next = [];
      for (const r of survivors.get(t)) {
        let ok = true;
        for (const [c, rt0] of refsOf(t)) {
          const v = r[c];
          if (v == null) continue;
          const rt = refTarget(t, r, c, rt0);
          if (rt === 'users') continue;
          const present = TABLES.includes(rt) && kept.get(rt).has(Number(v));
          // Order data is never copied: a row tied to it goes too (an order's own flow, a part drawing of a line),
          // except a standard drawing version's "made from line", which is only history.
          const orderTied = !TABLES.includes(rt) && !CLEAR_OK.has(`${t}.${c}`);
          if (!present && (!s.nullable.has(c) || orderTied)) { ok = false; note(dropped, `${t}.${c} → ${rt}`); break; }
        }
        if (ok) next.push(r); else { kept.get(t).delete(keyOf(t, r)); changed = true; }
      }
      survivors.set(t, next);
    }
  }

  // ── Rewrite ──
  // A table keyed by another's id (cf_item_details.master_id) moves with that table.
  const offOf = (rt) => {
    if (off.has(rt)) return off.get(rt);
    const s = schema.get(rt);
    if (s?.pk.length === 1 && s.refs.has(s.pk[0])) return offOf(s.refs.get(s.pk[0]));
    throw new Error(`No id offset for ${rt}`);
  };
  const mapId = (rt, v) => Number(v) + offOf(rt);
  const levelAxes = new Map();   // source spec id → indexes of level axes
  for (const s of rows.get('cf_specifications')) {
    let cfg = s.table_config;
    if (typeof cfg === 'string') { try { cfg = JSON.parse(cfg); } catch { cfg = null; } }
    const idx = (cfg?.axes ?? []).map((a, i) => (a.kind === 'level' ? i : -1)).filter((i) => i >= 0);
    if (idx.length) levelAxes.set(Number(s.id), idx);
  }
  const out = new Map();
  for (const t of TABLES) {
    const s = schema.get(t);
    out.set(t, survivors.get(t).map((r0) => {
      const r = { ...r0, company_id: TO };
      if (s.pk.length === 1 && s.pk[0] === 'id') r.id = mapId(t, r0.id);
      for (const [c, rt0] of refsOf(t)) {
        const v = r0[c];
        if (v == null) continue;
        const rt = refTarget(t, r0, c, rt0);
        if (rt === 'users') { r[c] = null; continue; }
        if (TABLES.includes(rt) && kept.get(rt).has(Number(v))) r[c] = mapId(rt, v);
        else { r[c] = null; note(cleared, `${t}.${c} → ${rt}`); }
      }
      if (t === 'cf_code_scheme_conditions' && r0.token_key === 'classification' && /^\d+$/.test(String(r0.value ?? ''))) {
        r.value = kept.get('cf_classification_nodes').has(Number(r0.value)) ? String(mapId('cf_classification_nodes', r0.value)) : r0.value;
      }
      if (t === 'cf_spec_values' && r0.value_json != null && levelAxes.has(Number(r0.specification_id))) {
        let j = r0.value_json;
        if (typeof j === 'string') j = JSON.parse(j);
        const idx = levelAxes.get(Number(r0.specification_id));
        const list = Array.isArray(j) ? j : j?.rows;
        if (Array.isArray(list)) for (const row of list) for (const i of idx) {
          if (row[i] != null && kept.get('cf_classification_nodes').has(Number(row[i]))) row[i] = mapId('cf_classification_nodes', row[i]);
        }
        r.value_json = j;
      }
      for (const c of s.cols) if (r[c] !== null && typeof r[c] === 'object' && !(r[c] instanceof Date) && !Buffer.isBuffer(r[c])) r[c] = JSON.stringify(r[c]);
      return r;
    }));
  }

  // ── Report ──
  console.log('\nRows to copy:');
  let total = 0;
  for (const t of TABLES) { const n = out.get(t).length; total += n; console.log(`  ${t.padEnd(32)} ${String(n).padStart(6)}  (source ${rows.get(t).length})`); }
  console.log(`  ${'TOTAL'.padEnd(32)} ${String(total).padStart(6)}`);
  if (Object.keys(dropped).length) { console.log('\nDropped (required reference not copied):'); for (const [k, n] of Object.entries(dropped)) console.log(`  ${k}: ${n}`); }
  if (Object.keys(cleared).length) { console.log('\nCleared (nullable reference not copied):'); for (const [k, n] of Object.entries(cleared)) console.log(`  ${k}: ${n}`); }
  const odd = TABLES.filter((t) => { const p = schema.get(t).pk; return !(p.length === 1 && (p[0] === 'id' || p[0] === 'company_id' || schema.get(t).refs.has(p[0]))); });
  if (odd.length) console.log(`\nTables with another kind of key (copied as is, key columns mapped as references): ${odd.map((t) => `${t}(${schema.get(t).pk})`).join(', ')}`);
  if (outside.size) { console.log('\nReferences outside the copy (cleared or dropped when set):'); for (const [k, rt] of outside) console.log(`  ${k} → ${rt}`); }

  if (!APPLY) { console.log('\nDry run — nothing written. Add --apply.'); process.exit(0); }

  // ── Write ──
  await db.query('SET FOREIGN_KEY_CHECKS = 0');
  const t0 = Date.now();
  for (const t of TABLES) {
    const list = out.get(t);
    if (!list.length) continue;
    const c = schema.get(t).cols;
    const head = `INSERT INTO \`${t}\` (${c.map((x) => `\`${x}\``).join(', ')}) VALUES `;
    // Batches by size: standard drawing files carry megabytes of text.
    let batch = []; let bytes = 0;
    const flush = async () => { if (!batch.length) return; await db.query(head + batch.map(() => `(${c.map(() => '?').join(', ')})`).join(', '), batch.flat()); batch = []; bytes = 0; };
    for (const r of list) {
      const vals = c.map((x) => r[x] ?? null);
      batch.push(vals);
      bytes += vals.reduce((a, v) => a + (typeof v === 'string' ? v.length : 8), 0);
      if (batch.length >= 500 || bytes > 4_000_000) await flush();
    }
    await flush();
    console.log(`  wrote ${t} (${list.length})`);
  }
  await db.query('SET FOREIGN_KEY_CHECKS = 1');
  console.log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(1)} s.`);
} finally {
  db.release();
  await pool.end();
}
