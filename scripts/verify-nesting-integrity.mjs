/**
 * verify-nesting-integrity.mjs — what WOULD the new nesting checks refuse?
 *
 * Read-only, and the whole point of it. The plan's rule 4: a new validation runs
 * report-only against production before it is switched on, so data gets fixed
 * before anybody is blocked by it.
 *
 * Run this on every environment before Phase 5 enforcement goes live. A clean
 * report means turning it on blocks nobody. A dirty one is a list of orders to
 * correct — and each line is a real physical impossibility, not a rule being
 * fussy: a part cannot be cut from material of a different thickness, and it
 * cannot come off a plate smaller than itself.
 *
 * Usage:  node scripts/verify-nesting-integrity.mjs [companyId]
 */

import { pool } from '../db.js';
import { checkOrderNesting, blockingIssues } from '../apps/fab_erp/services/nestingIntegrityService.js';

const only = Number(process.argv[2]) || null;

const [orders] = await pool.query(
  `SELECT o.id, o.company_id AS companyId, o.order_number AS orderNumber,
          o.order_type AS orderType, o.status, c.name AS companyName
     FROM fab_orders o
     JOIN companies c ON c.id = o.company_id
    WHERE o.deleted_at IS NULL ${only ? 'AND o.company_id = ?' : ''}
    ORDER BY o.company_id, o.id`,
  only ? [only] : [],
);

if (!orders.length) {
  console.log('No live orders to check.');
} else {
  console.log(`Checking ${orders.length} live order(s)…\n`);
}

let dirty = 0;
let totalBlocking = 0;

for (const o of orders) {
  const res = await checkOrderNesting(o.companyId, o.id);
  const blocking = blockingIssues(res);
  if (!res.issues.length) {
    console.log(`ok    ${o.orderNumber} (${o.orderType}/${o.status}) — ${res.checked} link(s), nothing to fix`);
    continue;
  }
  dirty++;
  totalBlocking += blocking.length;
  console.log(`\n⚠  ${o.orderNumber} (${o.orderType}/${o.status}) — ${o.companyName}`);
  console.log(`   ${res.checked} material link(s) · ${JSON.stringify(res.summary)}`);
  for (const i of res.issues.slice(0, 12)) {
    console.log(`     • [${i.type}] ${i.message}`);
  }
  if (res.issues.length > 12) console.log(`     … and ${res.issues.length - 12} more`);
}

console.log(
  dirty === 0
    ? '\nCLEAN — enforcement can be switched on and will block nobody.'
    : `\nREVIEW — ${dirty} order(s) carry ${totalBlocking} blocking issue(s). ` +
      'Fix these before enforcement goes live, or they will be refused at procurement.',
);

await pool.end();
