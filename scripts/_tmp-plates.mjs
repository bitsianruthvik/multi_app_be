import fs from 'fs'; import path from 'path'; import { fileURLToPath } from 'url';
const __dir = path.dirname(fileURLToPath(import.meta.url));
const env = {};
fs.readFileSync(path.join(__dir,'..','..','.env.tidb'),'utf8').split('\n').forEach((l)=>{
  l=l.trim(); if(!l||l.startsWith('#'))return; const [k,...r]=l.split('='); env[k.trim()]=r.join('=').trim();});
Object.assign(process.env,{DB_HOST:env.DB_HOST,DB_PORT:env.DB_PORT??'4000',DB_USER:env.DB_USER,DB_PASSWORD:env.DB_PASSWORD,DB_NAME:env.DB_NAME,DB_SSL:'true'});
const { pool } = await import('../db.js');
const c = await pool.getConnection();
const [p] = await c.query(
 `SELECT ci.id, ci.code, ci.name, ci.unit, ci.procurement_type AS proc, g.name AS grp, sg.name AS subgroup
    FROM fab_item_catalog ci
    LEFT JOIN fab_item_groups g ON g.id=ci.group_id
    LEFT JOIN fab_item_subgroups sg ON sg.id=ci.subgroup_id
   WHERE ci.company_id=30005 AND ci.deleted_at IS NULL AND g.name='Plates' LIMIT 5`);
console.log('PLATE ITEMS:'); console.table(p);
const [f] = await c.query(
 `SELECT fl.field_key, v.value_num, v.value_text, v.unit_code
    FROM fab_field_values v JOIN fab_fields fl ON fl.id=v.field_id
   WHERE v.company_id=30005 AND v.scope='catalog_item' AND v.scope_id=? AND v.deleted_at IS NULL`, [p[0].id]);
console.log(`FIELDS ON "${p[0].name}":`); console.table(f);
const [cols] = await c.query(`SHOW COLUMNS FROM fab_items`);
console.log('fab_items columns:', cols.map(x=>x.Field).join(', '));
c.release(); await pool.end();
