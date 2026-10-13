/**
 * make-access-doc.mjs — writes apps/cf_hrms/ACCESS.md: every route and the right
 * it asks for, read from the routers themselves (lib/routeTable.js).
 *
 *   node apps/cf_hrms/scripts/make-access-doc.mjs            writes the file
 *   node apps/cf_hrms/scripts/make-access-doc.mjs --check    exit 1 if the file is out of date
 *
 * Run it after changing a guard. scripts/cf_hrms/access_test.mjs fails while the
 * file and the code disagree. It reads no database.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import router from '../routes/index.js';
import { routeTable, routeTableProblems, renderAccessDoc } from '../lib/routeTable.js';

const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../ACCESS.md');
const rows = routeTable(router);
const problems = routeTableProblems(rows);
const text = renderAccessDoc(rows);
if (problems.length) {
  console.error(problems.map((p) => `  - ${p}`).join('\n'));
  process.exit(1);
}
if (process.argv.includes('--check')) {
  const have = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n') : '';
  if (have !== text) {
    console.error('  ACCESS.md is out of date. Run make-access-doc.mjs.');
    process.exit(1);
  }
  console.log(`  ACCESS.md is up to date (${rows.length} routes).`);
} else {
  fs.writeFileSync(file, text);
  console.log(`  wrote ACCESS.md — ${rows.length} routes.`);
}
process.exit(0);
