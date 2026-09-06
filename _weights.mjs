import fs from 'fs';
const env = {};
fs.readFileSync('C:/Users/Digital Initiatives/Desktop/TM/.env.tidb', 'utf8').split('\n').forEach((l) => {
  l = l.trim(); if (!l || l.startsWith('#')) return;
  const [k, ...r] = l.split('='); env[k.trim()] = r.join('=').trim();
});
Object.assign(process.env, { DB_HOST: env.DB_HOST, DB_PORT: env.DB_PORT ?? '4000',
  DB_USER: env.DB_USER, DB_PASSWORD: env.DB_PASSWORD, DB_NAME: env.DB_NAME, DB_SSL: 'true' });
const { pool } = await import('./db.js');
const { recomputeOrderWeights } = await import('./apps/fab_erp/services/itemWeightService.js');
const C = 30005;
const [[o]] = await pool.query(`SELECT id, order_number FROM fab_orders WHERE company_id=? AND deleted_at IS NULL AND order_type='sales' ORDER BY id DESC LIMIT 1`, [C]);
console.log('recomputing weights for', o.order_number);
console.log(JSON.stringify(await recomputeOrderWeights(C, o.id)));
const [rows] = await pool.query(
  `SELECT depth, COUNT(*) n, ROUND(SUM(total_weight)/1000,2) t FROM fab_items
    WHERE company_id=? AND order_id=? AND deleted_at IS NULL AND node_kind='structure'
    GROUP BY depth ORDER BY depth`, [C, o.id]);
for (const r of rows) console.log(`  d${r.depth}: ${r.n} rows, ${r.t} t`);
await pool.end();
