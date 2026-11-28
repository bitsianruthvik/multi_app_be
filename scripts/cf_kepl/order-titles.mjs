/**
 * order-titles.mjs — set sales order titles (the "Project" an order shows on the Orders list) so that an order with more
 * than one line names every line, not only the first (user, 2026-11-22). DRY RUN BY DEFAULT; --apply writes, one order a
 * statement; the before-values are written to --before <file.json> first.
 *
 *   cd multi_app_be
 *   node scripts/cf_kepl/order-titles.mjs --company 30005 --prod --title "SO260024=ROB 36 mtr composite girders (P7-P8, P6-P7)" \
 *        [--title "CODE=new title" ...] [--before <file.json>] [--apply]
 * Prints every order with more than one live line beside its lines' descriptions, so none is missed.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { useProdDb } from '../lib/prodDb.mjs';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const COMPANY = Number(arg('company'));
const APPLY = process.argv.includes('--apply');
const titles = new Map(process.argv.flatMap((a, i) => (a === '--title' ? [process.argv[i + 1]] : [])).map((t) => { const k = t.indexOf('='); return [t.slice(0, k).trim(), t.slice(k + 1).trim()]; }));
if (!Number.isInteger(COMPANY) || COMPANY <= 0) { console.error('Usage: --company <id> [--prod] --title "CODE=title" ... [--before file.json] [--apply]'); process.exit(2); }
if (process.argv.includes('--prod')) {
  await useProdDb();
}
const { pool } = await import(pathToFileURL(path.join(__dir, '..', '..', 'db.js')).href);
try {
  const where = process.env.DB_HOST && !/^(localhost|127\.0\.0\.1)$/.test(process.env.DB_HOST) ? 'PRODUCTION' : 'local';
  console.log(`${where} — company ${COMPANY} — ${APPLY ? 'APPLY' : 'DRY RUN'}`);
  const [orders] = await pool.query('SELECT id, code, title FROM cf_sales_orders WHERE company_id = ? AND deleted_at IS NULL ORDER BY code', [COMPANY]);
  const [lines] = await pool.query('SELECT order_id, line_no, description FROM cf_sales_order_lines WHERE company_id = ? AND deleted_at IS NULL ORDER BY order_id, line_no', [COMPANY]);
  const byOrder = new Map(); for (const l of lines) { if (!byOrder.has(l.order_id)) byOrder.set(l.order_id, []); byOrder.get(l.order_id).push(l); }
  for (const o of orders) {
    const ls = byOrder.get(o.id) ?? []; if (ls.length < 2 && !titles.has(o.code)) continue;
    console.log(`\n${o.code} (${ls.length} lines) "${o.title}"${titles.has(o.code) ? `\n  → "${titles.get(o.code)}"` : ls.length > 1 ? '\n  (no new title given)' : ''}`);
    for (const l of ls) console.log(`    line ${l.line_no}: ${l.description}`);
  }
  const unknown = [...titles.keys()].filter((c) => !orders.some((o) => o.code === c)); if (unknown.length) throw new Error(`No order ${unknown.join(', ')}`);
  const change = orders.filter((o) => titles.has(o.code) && titles.get(o.code) !== o.title);
  if (APPLY && change.length) {
    if (arg('before')) { fs.writeFileSync(arg('before'), JSON.stringify(change.map((o) => ({ id: o.id, code: o.code, title: o.title })), null, 1)); console.log(`\nbefore-values: ${arg('before')}`); }
    for (const o of change) { await pool.query('UPDATE cf_sales_orders SET title = ? WHERE company_id = ? AND id = ?', [titles.get(o.code), COMPANY, o.id]); console.log(`  ${o.code}: title set`); }
  }
  console.log(`\n${change.length} title(s) to change${APPLY ? ': done' : ' (dry run: nothing written)'}`);
} finally { await pool.end(); }
