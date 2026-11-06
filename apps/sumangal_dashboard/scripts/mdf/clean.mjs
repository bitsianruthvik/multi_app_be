// Removes page-split leftovers (exact duplicate rows), keeps one row per key where
// a row has two versions, indexes the join columns. Works on the SQLite copy only.
import { DatabaseSync } from 'node:sqlite';
const d = new DatabaseSync(process.argv[2]);
d.exec('PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF;');
const names = d.prepare("select name from sqlite_master where type='table'").all().map((r) => r.name);
const q = (s) => `"${s}"`;
const out = [];
for (const t of names) {
  const cols = d.prepare(`PRAGMA table_info(${q(t)})`).all().map((c) => c.name);
  const before = d.prepare(`select count(*) n from ${q(t)}`).get().n;
  d.exec(`CREATE TABLE ${q(t + '__c')} AS SELECT DISTINCT * FROM ${q(t)}; DROP TABLE ${q(t)}; ALTER TABLE ${q(t + '__c')} RENAME TO ${q(t)};`);
  const after = d.prepare(`select count(*) n from ${q(t)}`).get().n;
  out.push([t, before, after]);
  for (const c of cols) {
    if (/^(batch_item_id|batch_id|die_id|heat_no|order_item_id|order_id|work_order_id|work_order_item_id|melting_prod_id|melting_prod_item_id|inj_prod_id|asmbly_prod_id|coating_prod_id|dwx_prod_id|insp_prod_id|fettling_prod_id|machining_insp_id|dispatch_id|invoice_id|invoice_export_id|customer_id|rejection_id)$/.test(c)) {
      d.exec(`CREATE INDEX IF NOT EXISTS ${q(`ix_${t}_${c}`)} ON ${q(t)}(${q(c)})`);
    }
  }
}
// Two versions of one key: keep the later copy.
for (const [t, k] of [['tbl_batch_detail', 'batch_item_id'], ['tbl_die_master', 'die_id']]) {
  d.exec(`DELETE FROM ${q(t)} WHERE rowid NOT IN (SELECT max(rowid) FROM ${q(t)} GROUP BY ${q(k)})`);
}
console.log('tables', names.length, 'removed', out.reduce((n, x) => n + x[1] - x[2], 0));
d.exec('ANALYZE');
