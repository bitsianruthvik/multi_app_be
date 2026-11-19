/**
 * stores-ledger-load.mjs — one month of the stores' own ledger workbook into the stock book of ONE company, through
 * stockService.postMovement (the same road every stock change takes — nothing is written to balances directly).
 *
 *   node stores_import/ledger-read.mjs "<workbook.xlsx>"      (TM root: workbook → stores_import/ledger.json)
 *   node stores_import/ledger-match.mjs                       (→ stores_import/ledger-match.json, every line on an item)
 *   cd multi_app_be
 *   node scripts/cf_kepl/stores-ledger-load.mjs --company 180005 --prod --month 2026-11 [--apply] [--check]
 *
 * What goes in, in date order:
 *   opening   a receipt dated the 1st, at the ledger's opening rate (a line with no rate comes in without a cost)
 *   purchase  a receipt on its day, at the ledger's rate — the ledger names no PO and no supplier, so neither is set
 *   issue     an issue on its day for each party sheet, as "general" use given to a department named "Project: <party>"
 *             (the ledger's parties are customers' projects; a company with those sales orders should use them instead)
 * An issue the book cannot cover (the ledger's own balance goes below zero) is left out and listed.
 *
 * DRY RUN BY DEFAULT: everything in one transaction, rolled back. --apply commits one movement at a time; a movement
 * already there (same reference) is skipped, so it is safe to run again. --check only compares the book to the ledger.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const COMPANY = Number(arg('company'));
const MONTH = arg('month');
const APPLY = process.argv.includes('--apply');
const CHECK = process.argv.includes('--check');
if (!COMPANY || !/^\d{4}-\d{2}$/.test(MONTH ?? '')) { console.error('Usage: --company <id> --month YYYY-MM [--prod] [--apply] [--check]'); process.exit(2); }
const TM = path.join(__dir, '..', '..', '..');
if (process.argv.includes('--prod')) {
  const env = {};
  fs.readFileSync(path.join(TM, '.env.tidb'), 'utf8').split('\n').forEach((l) => {
    l = l.trim(); if (!l || l.startsWith('#')) return;
    const [k, ...r] = l.split('='); env[k.trim()] = r.join('=').trim();
  });
  Object.assign(process.env, { DB_HOST: env.DB_HOST, DB_PORT: env.DB_PORT ?? '4000', DB_USER: env.DB_USER, DB_PASSWORD: env.DB_PASSWORD, DB_NAME: env.DB_NAME, DB_SSL: 'true' });
}
const imp = (p) => import(pathToFileURL(path.join(__dir, '..', '..', p)).href);
const { pool } = await imp('db.js');
await imp('apps/cf_erp/services/codegenProvider.js');
const { postMovement } = await imp('apps/cf_erp/services/stockService.js');
const D = await imp('apps/cf_erp/services/storesDeskService.js');
const { attachNodeCache, detachNodeCache } = await imp('apps/cf_erp/lib/nodeCache.js');

const rows = JSON.parse(fs.readFileSync(path.join(TM, 'stores_import', 'ledger-match.json'), 'utf8'));
const L = JSON.parse(fs.readFileSync(path.join(TM, 'stores_import', 'ledger.json'), 'utf8'));
const day = (d) => `${MONTH}-${String(d).padStart(2, '0')}`;
const TAG = `LEDGER ${MONTH}`;
const PREFIXES = ['CN-', 'SP-MCH-', 'TL-GEN-', 'FS-STR-'];
const r6 = (n) => Math.round(n * 1e6) / 1e6;

try {
  const where = process.env.DB_HOST && !/^(localhost|127\.0\.0\.1)$/.test(process.env.DB_HOST) ? 'PRODUCTION DB' : 'local';
  const [[co]] = await pool.query('SELECT id, slug FROM companies WHERE id = ?', [COMPANY]);
  if (!co) throw new Error(`No company ${COMPANY}.`);
  const [[user]] = await pool.query("SELECT id FROM users WHERE company_id = ? AND deleted_at IS NULL ORDER BY (name LIKE 'Stores%') DESC, id LIMIT 1", [COMPANY]);
  const c = { companyId: COMPANY, userId: user?.id ?? null };
  const [[area]] = await pool.query("SELECT id, code FROM cf_stocking_areas WHERE company_id = ? AND purpose = 'storage' AND status = 'active' AND deleted_at IS NULL ORDER BY id LIMIT 1", [COMPANY]);
  if (!area) throw new Error('No store area.');
  console.log(`${where} — company ${COMPANY} (${co.slug}) — ${CHECK ? 'CHECK' : APPLY ? 'APPLY' : 'DRY RUN (rolled back)'} — ${TAG} — area ${area.code}`);

  // the stores' items by name (the loader's code prefixes only: a part of a structure may carry the same name)
  const [its] = await pool.query(
    `SELECT m.id, m.name, i.uom FROM cf_master_records m JOIN cf_item_details i ON i.master_id = m.id
      WHERE m.company_id = ? AND m.deleted_at IS NULL AND m.record_kind = 'item' AND (${PREFIXES.map(() => 'm.code LIKE ?').join(' OR ')})`, [COMPANY, ...PREFIXES.map((p) => `${p}%`)]);
  const idOf = new Map(its.map((x) => [String(x.name).toUpperCase(), x.id]));
  const bySno = new Map();
  const missing = [];
  for (const r of rows) { const id = idOf.get(String(r.item ?? '').toUpperCase().slice(0, 255)); if (!id) missing.push(r.name); else bySno.set(r.sno, { ...r, itemId: id }); }
  if (missing.length) throw new Error(`${missing.length} ledger lines have no item in this company (run stores-items-load first): ${missing.slice(0, 5).join('; ')}`);

  // what the ledger says, an item (repeated lines of one item add up)
  const want = new Map();
  for (const r of bySno.values()) { const w = want.get(r.itemId) ?? { name: r.item, open: 0, bal: 0 }; w.open += r.openQty || 0; w.bal += r.balQty || 0; want.set(r.itemId, w); }

  if (CHECK) { await compare(pool); process.exit(0); }

  // --- the movements, in date order -----------------------------------------------------------------
  const merge = (lines) => { const m = new Map(); for (const l of lines) { const h = m.get(l.itemId); if (!h) m.set(l.itemId, { ...l }); else { const q = h.quantity + l.quantity; if (h.unitCost != null && l.unitCost != null) h.unitCost = Math.round(((h.quantity * h.unitCost + l.quantity * l.unitCost) / q) * 1e4) / 1e4; h.quantity = r6(q); } } return [...m.values()]; };
  const events = [];
  const opening = merge([...bySno.values()].filter((r) => r.openQty > 0).map((r) => ({ itemId: r.itemId, quantity: r.openQty, ...(r.openRate > 0 ? { unitCost: r.openRate } : {}) })));
  const N = Math.ceil(opening.length / 60);
  for (let k = 0; k < N; k++) events.push({ kind: 'receipt', date: day(1), reference: `${TAG} OPENING ${k + 1}/${N}`, notes: `Opening stock for ${MONTH} from the stores' ledger`, lines: opening.slice(k * 60, (k + 1) * 60) });
  const book = new Map(opening.map((l) => [l.itemId, l.quantity]));
  const short = [];
  for (let d = 1; d <= 31; d++) {
    const pur = merge(L.purchase.filter((p) => p.days[d]).map((p) => ({ itemId: bySno.get(p.sno).itemId, quantity: p.days[d], ...(p.rate > 0 ? { unitCost: p.rate } : {}) })));
    if (pur.length) { events.push({ kind: 'receipt', date: day(d), reference: `${TAG} PURCHASE ${String(d).padStart(2, '0')}`, notes: "Purchase in the stores' ledger (no PO or supplier named)", lines: pur }); for (const l of pur) book.set(l.itemId, r6((book.get(l.itemId) || 0) + l.quantity)); }
    for (const [party, list] of Object.entries(L.partySheets)) {
      if (['DEBITS', 'ABSTRACT'].includes(party)) continue;
      const lines = [];
      for (const l of merge(list.filter((p) => p.days[d]).map((p) => ({ itemId: bySno.get(p.sno).itemId, quantity: p.days[d] })))) {
        const have = book.get(l.itemId) || 0;
        if (have + 1e-9 < l.quantity) { short.push({ date: day(d), party, name: want.get(l.itemId).name, asked: l.quantity, have }); continue; }
        book.set(l.itemId, r6(have - l.quantity)); lines.push(l);
      }
      if (lines.length) events.push({ kind: 'issue', date: day(d), party, reference: `${TAG} ISSUE ${String(d).padStart(2, '0')} ${party}`.slice(0, 100), lines });
    }
  }
  console.log(`${events.length} movements: ${events.filter((e) => e.reference.includes('OPENING')).length} opening (${opening.length} items), ${events.filter((e) => e.reference.includes('PURCHASE')).length} purchase days, ${events.filter((e) => e.kind === 'issue').length} issues (${events.filter((e) => e.kind === 'issue').reduce((a, e) => a + e.lines.length, 0)} lines)`);
  if (short.length) { console.log(`${short.length} issue line(s) left out — the ledger gives out more than it holds:`); for (const s of short) console.log(`   ${s.date} ${s.party}: ${s.name} — ${s.asked} asked, ${s.have} in the book`); }

  const dept = new Map();
  const post = async (db, e) => {
    const [[there]] = await db.query('SELECT id FROM cf_stock_movements WHERE company_id = ? AND reference = ? AND reversal_of_id IS NULL LIMIT 1', [COMPANY, e.reference]);
    if (there) return 'skipped';
    if (e.kind === 'receipt') {
      await postMovement(db, c, { movementType: 'receipt', movementDate: e.date, reference: e.reference, notes: e.notes, toAreaId: area.id, lines: e.lines }, { allowBackdate: true });
    } else {
      const name = `Project: ${e.party}`;
      if (!dept.has(name)) {
        const [[d]] = await db.query('SELECT id FROM cf_departments WHERE company_id = ? AND name = ? AND deleted_at IS NULL', [COMPANY, name]);
        dept.set(name, d?.id ?? (await D.addDepartment(db, c, { name })).id);
      }
      await postMovement(db, c, { movementType: 'issue', movementDate: e.date, usedFor: 'general', reference: e.reference, fromAreaId: area.id, lines: e.lines },
        { allowBackdate: true, given: { type: 'department', departmentId: dept.get(name) } });
    }
    return 'posted';
  };

  let posted = 0; let skipped = 0; let failed = 0;
  const t0 = Date.now();
  const say = (e, what) => console.log(`   ${what.padEnd(7)} ${e.date} ${e.reference} (${e.lines.length} lines)  ${Math.round((Date.now() - t0) / 1000)} s`);
  if (!APPLY) {
    const db = await pool.getConnection();
    try {
      await db.beginTransaction(); attachNodeCache(db);
      for (const e of events) {
        try { await db.query('SAVEPOINT one'); const r = await post(db, e); r === 'posted' ? posted++ : skipped++; say(e, r); }
        catch (err) { await db.query('ROLLBACK TO SAVEPOINT one'); failed++; console.log(`   FAILED ${e.reference}: ${err.message}${err.problems ? ' — ' + err.problems.slice(0, 4).join('; ') : ''}`); }
      }
      await compare(db);
    } finally { try { await db.rollback(); } catch { /* going back anyway */ } detachNodeCache(db); db.release(); }
  } else {
    for (const e of events) {
      const db = await pool.getConnection();
      try {
        await db.beginTransaction(); attachNodeCache(db);
        const r = await post(db, e); await db.commit(); dept.size && 0; r === 'posted' ? posted++ : skipped++; say(e, r);
      } catch (err) { try { await db.rollback(); } catch { /* going back anyway */ } dept.clear(); failed++; console.log(`   FAILED ${e.reference}: ${err.message}${err.problems ? ' — ' + err.problems.slice(0, 4).join('; ') : ''}`); }
      finally { detachNodeCache(db); db.release(); }
    }
    await compare(pool);
  }
  console.log(`\n${posted} ${APPLY ? 'posted' : 'would be posted'}, ${skipped} already there, ${failed} failed, ${Math.round((Date.now() - t0) / 1000)} s`);
  process.exitCode = failed ? 1 : 0;

  /** The book of the store area against the ledger's balance, an item. */
  async function compare(db) {
    const [bal] = await db.query('SELECT item_id, SUM(quantity) AS q FROM cf_stock_balances WHERE company_id = ? AND stocking_area_id = ? GROUP BY item_id', [COMPANY, area.id]);
    const have = new Map(bal.map((b) => [b.item_id, Number(b.q)]));
    let same = 0; const off = [];
    for (const [id, w] of want) { const q = have.get(id) || 0; if (Math.abs(q - w.bal) < 1e-6) same++; else off.push(`${w.name}: book ${q}, ledger ${w.bal}`); }
    const [[v]] = await db.query('SELECT ROUND(SUM(l.value)) AS v FROM cf_stock_ledger l JOIN cf_stock_movements m ON m.id = l.movement_id WHERE l.company_id = ? AND m.reference LIKE ?', [COMPANY, `${TAG} %`]);
    console.log(`\nbook against the ledger: ${same} of ${want.size} items agree, ${off.length} differ; value of these entries ${v?.v ?? 0}`);
    for (const o of off.slice(0, 20)) console.log(`   ${o}`);
  }
} finally { await pool.end(); }
