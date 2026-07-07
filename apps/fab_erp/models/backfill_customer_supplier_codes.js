/**
 * backfill_customer_supplier_codes.js
 *
 * ONE-TIME manual backfill script for EU-9.
 *
 * codegenService.js now auto-generates `code` for new fab_customers /
 * fab_suppliers rows on insert (CUST-#### / SUPP-#### via DEFAULT_SEGMENTS,
 * see services/codegenService.js). This script renumbers ALL EXISTING rows
 * into that same scheme, replacing whatever code they currently hold
 * (including old manually-entered codes) — this is an intentional
 * replacement, not a grandfather/no-op pass.
 *
 * Only active rows (deleted_at IS NULL) are renumbered. Soft-deleted rows
 * are left untouched: they're historical/audit records, renumbering them
 * would not be seen by anyone and would just burn sequence numbers or
 * confuse audit trails if ever restored.
 *
 * Processing is done one company at a time, sequentially, and within each
 * company one row at a time, sequentially (ascending id order) — this
 * keeps console output easy to follow. generateCode() already serializes
 * sequence allocation per (company_id, entity_type) via row locking, so
 * this is not required for correctness, only for readability of the run.
 *
 * This script is NOT auto-run (matches the existing fab_erp convention
 * where init.sql / seed.sql are also applied by hand). Run it manually,
 * once, from the multi_app_be directory:
 *
 *   cd multi_app_be
 *   node apps/fab_erp/models/backfill_customer_supplier_codes.js
 */

import { pool } from '../../../db.js';
import { generateCode } from '../services/codegenService.js';

async function getCompanyIds() {
  const [rows] = await pool.query(`
    SELECT DISTINCT company_id FROM (
      SELECT company_id FROM fab_customers
      UNION
      SELECT company_id FROM fab_suppliers
    ) AS combined
    ORDER BY company_id ASC
  `);
  return rows.map((r) => r.company_id);
}

async function backfillTable(companyId, table, entityType) {
  const [rows] = await pool.query(
    `SELECT id FROM ${table} WHERE company_id = ? AND deleted_at IS NULL ORDER BY id ASC`,
    [companyId],
  );

  for (const row of rows) {
    const code = await generateCode(companyId, entityType, {});
    await pool.query(`UPDATE ${table} SET code = ? WHERE id = ?`, [code, row.id]);
    console.log(`Company ${companyId}: ${entityType} id=${row.id} -> ${code}`);
  }

  return rows.length;
}

async function main() {
  const companyIds = await getCompanyIds();
  console.log(`Found ${companyIds.length} company(ies) with customer/supplier rows to renumber.`);

  let totalCustomers = 0;
  let totalSuppliers = 0;

  for (const companyId of companyIds) {
    console.log(`\n--- Company ${companyId} ---`);
    totalCustomers += await backfillTable(companyId, 'fab_customers', 'customer');
    totalSuppliers += await backfillTable(companyId, 'fab_suppliers', 'supplier');
  }

  console.log(`\nDone. Renumbered ${totalCustomers} customer(s) and ${totalSuppliers} supplier(s) across ${companyIds.length} company(ies).`);
}

main()
  .catch((err) => {
    console.error('Backfill failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
    process.exit(process.exitCode ?? 0);
  });
