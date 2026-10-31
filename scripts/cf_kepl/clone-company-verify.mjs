/**
 * clone-company-verify.mjs — after clone-company.mjs: every declared foreign key of a company's cf_ rows must find
 * its row, and polymorphic subject_ids must point at the company's own rows. Read only.
 *   node scripts/cf_kepl/clone-company-verify.mjs --company 180005
 */
const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const CO = Number(arg('company'));
const { pool } = await import('../../db.js');
const [fks] = await pool.query(
  `SELECT TABLE_NAME t, CONSTRAINT_NAME k, GROUP_CONCAT(COLUMN_NAME ORDER BY ORDINAL_POSITION) c, REFERENCED_TABLE_NAME rt,
          GROUP_CONCAT(REFERENCED_COLUMN_NAME ORDER BY ORDINAL_POSITION) rc
     FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME LIKE 'cf\_%' AND REFERENCED_TABLE_NAME IS NOT NULL
    GROUP BY TABLE_NAME, CONSTRAINT_NAME, REFERENCED_TABLE_NAME`);
let bad = 0; let checked = 0;
for (const f of fks) {
  const c = f.c.split(','); const rc = f.rc.split(',');
  const [[{ n: has }]] = await pool.query(`SELECT COUNT(*) n FROM \`${f.t}\` WHERE company_id = ?`, [CO]).catch(() => [[{ n: 0 }]]);
  if (!has) continue;
  const on = c.map((x, i) => `r.\`${rc[i]}\` = x.\`${x}\``).join(' AND ');
  const nn = c.map((x) => `x.\`${x}\` IS NOT NULL`).join(' AND ');
  const [[{ n }]] = await pool.query(`SELECT COUNT(*) n FROM \`${f.t}\` x WHERE x.company_id = ? AND ${nn} AND NOT EXISTS (SELECT 1 FROM \`${f.rt}\` r WHERE ${on})`, [CO]);
  checked++;
  if (n) { bad++; console.log(`ORPHAN ${f.t}.${f.c} → ${f.rt}: ${n}`); }
}
const poly = [['cf_spec_values', { classification: 'cf_classification_nodes', master: 'cf_master_records', machine: 'cf_machines' }],
  ['cf_spec_assignments', { classification: 'cf_classification_nodes', master: 'cf_master_records', machine: 'cf_machines' }],
  ['cf_operation_machine_rules', { classification: 'cf_classification_nodes', machine: 'cf_machines', master: 'cf_master_records' }],
  ['cf_drawing_links', { master_record: 'cf_master_records' }]];
for (const [t, m] of poly) for (const [type, rt] of Object.entries(m)) {
  const [[{ n }]] = await pool.query(`SELECT COUNT(*) n FROM \`${t}\` x WHERE x.company_id = ? AND x.subject_type = ? AND NOT EXISTS (SELECT 1 FROM \`${rt}\` r WHERE r.id = x.subject_id AND r.company_id = x.company_id)`, [CO, type]);
  checked++;
  if (n) { bad++; console.log(`ORPHAN ${t}.subject_id (${type}) → ${rt}: ${n}`); }
}
const [[{ n: cond }]] = await pool.query(`SELECT COUNT(*) n FROM cf_code_scheme_conditions x WHERE x.company_id = ? AND x.deleted_at IS NULL AND x.token_key = 'classification' AND NOT EXISTS (SELECT 1 FROM cf_classification_nodes r WHERE r.company_id = x.company_id AND r.id = x.value)`, [CO]);
checked++; if (cond) { bad++; console.log(`ORPHAN coding-rule classification conditions: ${cond}`); }
console.log(`${checked} checks, ${bad} with orphans — ${bad ? 'CLONE-BROKEN' : 'CLONE-OK'}`);
await pool.end();
