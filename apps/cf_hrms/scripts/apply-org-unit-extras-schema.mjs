/**
 * apply-org-unit-extras-schema.mjs — colour per kind and the stored order of org units
 * (TM/CF_HRMS_HIRING_SPEC.md §34 parts 1 and "Order"; models/init.sql §35).
 *
 *   node apply-org-unit-extras-schema.mjs                       DRY RUN on local — says what it would do
 *   node apply-org-unit-extras-schema.mjs --apply
 *   node apply-org-unit-extras-schema.mjs --apply --target=prod
 *
 *   1. hrms_department_labels.colour  VARCHAR(20) NULL — a palette key; NULL = the kind's default
 *   2. hrms_departments.sort_order    INT NOT NULL DEFAULT 0 — the order among siblings
 *   3. sort_order filled from the CODE order, per company and per group of siblings, for every
 *      group not ordered yet (lib/unitOrder.js initialSortOrders). The units keep the order they
 *      already had on the chart (code), and no longer order by name on the Org units list.
 *
 * DDL commits by itself: each step is guarded and a second run plans nothing. Step 3 only
 * touches groups of siblings that have a unit at 0, so a second run writes nothing and an order
 * set by drag and drop is never overwritten. No colour is written: a NULL colour shows the
 * kind's default (Department blue, Section teal, Machine amber, the others in palette order).
 * Run this BEFORE deploying the backend that reads the two columns.
 */
import path from 'path';
import { fileURLToPath } from 'url';
import mysql from 'mysql2/promise';
import { resolveTarget, announce } from './dbTarget.mjs';
import { initialSortOrders } from '../lib/unitOrder.js';

const APPLY = process.argv.includes('--apply');

const one = async (conn, sql, params) => (await conn.query(sql, params))[0][0] ?? null;
const table = async (conn, t) => Boolean(await one(conn, 'SELECT 1 AS x FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [t]));
const column = async (conn, t, c) => Boolean(await one(conn, 'SELECT 1 AS x FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?', [t, c]));

/** [table, column, definition, after] — the same as init.sql §35. */
export const COLUMNS = [
  ['hrms_department_labels', 'colour', 'VARCHAR(20) NULL', 'sort_order'],
  ['hrms_departments', 'sort_order', 'INT NOT NULL DEFAULT 0', 'parent_department_id'],
];

/** What is still missing: [{ what, sql }]. Reads only. */
export async function schemaSteps(conn) {
  for (const t of ['hrms_department_labels', 'hrms_departments']) {
    if (!await table(conn, t)) throw new Error(`${t} is not there — run models/init.sql first.`);
  }
  const steps = [];
  for (const [t, c, def, after] of COLUMNS) {
    if (!await column(conn, t, c)) steps.push({ what: `add ${t}.${c}`, sql: `ALTER TABLE ${t} ADD COLUMN ${c} ${def} AFTER ${after}` });
  }
  return steps;
}

/** Per company: [{ companyId, slug, writes: [{ id, sortOrder }] }]. Reads only (needs the column). */
export async function orderPlan(conn) {
  const [rows] = await conn.query(
    `SELECT d.id, d.company_id, d.code, d.parent_department_id, d.sort_order, c.slug
       FROM hrms_departments d JOIN companies c ON c.id = d.company_id
      WHERE d.deleted_at IS NULL
      ORDER BY d.company_id, d.id`);
  const byCompany = new Map();
  for (const r of rows) {
    if (!byCompany.has(r.company_id)) byCompany.set(r.company_id, { companyId: r.company_id, slug: r.slug, rows: [] });
    byCompany.get(r.company_id).rows.push(r);
  }
  return [...byCompany.values()]
    .map((g) => ({ companyId: g.companyId, slug: g.slug, units: g.rows.length, writes: initialSortOrders(g.rows) }))
    .filter((g) => g.writes.length);
}

async function main() {
  const target = resolveTarget();
  announce(target);
  const conn = await mysql.createConnection({ ...target.cfg, dateStrings: true });
  try {
    if (!APPLY) console.log('  DRY RUN — nothing is written without --apply\n');
    const steps = await schemaSteps(conn);
    if (!steps.length) console.log('  schema: already there — nothing to do');
    for (const s of steps) {
      if (APPLY) { await conn.query(s.sql); console.log(`  schema: ${s.what} — done`); } else console.log(`  schema: would ${s.what}`);
    }
    const haveOrder = await column(conn, 'hrms_departments', 'sort_order');
    if (!haveOrder) {
      console.log('  order: sort_order is not there yet — after --apply each company\'s units are ordered by code');
    } else {
      const plan = await orderPlan(conn);
      if (!plan.length) console.log('  order: every group of org units is ordered — nothing to do');
      for (const g of plan) {
        if (APPLY) {
          await conn.beginTransaction();
          try {
            for (const w of g.writes) {
              // eslint-disable-next-line no-await-in-loop -- one small company at a time, in one transaction
              await conn.query('UPDATE hrms_departments SET sort_order = ? WHERE company_id = ? AND id = ? AND sort_order = 0', [w.sortOrder, g.companyId, w.id]);
            }
            await conn.commit();
          } catch (e) { await conn.rollback(); throw e; }
          console.log(`  order: ${g.slug} — ${g.writes.length} of ${g.units} org units ordered by code — done`);
        } else console.log(`  order: ${g.slug} — would order ${g.writes.length} of ${g.units} org units by code`);
      }
    }
    if (APPLY) {
      const again = await schemaSteps(conn);
      const againOrder = await orderPlan(conn);
      if (again.length || againOrder.length) throw new Error(`after applying, still to do: ${[...again.map((s) => s.what), ...againOrder.map((g) => `order ${g.slug}`)].join('; ')}`);
      console.log('  checked: a second run plans nothing');
    }
    console.log(APPLY ? '\n  done.\n' : '\n  nothing written. Run again with --apply.\n');
  } finally {
    await conn.end();
  }
}

// Run only when called as a script; a test imports schemaSteps / orderPlan.
if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) main().then(() => process.exit(0)).catch((e) => { console.error(`\n  FAILED: ${e.message}\n`); process.exit(1); });
