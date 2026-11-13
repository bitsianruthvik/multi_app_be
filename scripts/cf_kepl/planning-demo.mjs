/**
 * planning-demo.mjs — THE PLANNING DEMO in the sandbox company (user, 2026-11-13: "Take 6 of the live orders in the
 * production, make copies … push them till the production orders and plan for Nov and show me that plan in UI … simulate
 * the first week … second week … third week"). The six orders are built first by standard-import.mjs + girder-order.mjs
 * (--company 180005); this script takes them on, one stage at a time, each stage safe to run again:
 *
 *   node scripts/cf_kepl/planning-demo.mjs --company 180005 --stage status   [--prod]
 *   node scripts/cf_kepl/planning-demo.mjs --company 180005 --stage values --order <code> --girder Composite --span 36000 [--prod] [--apply]
 *        the required values still empty on its lines, filled as a fabricator would ("fill the rest of the values
 *        meaningfully"): impact class BO, 2 coats (1 metallising + 3 paint), 6 mm MIG / 8 mm SAW fillets, segment length =
 *        span ÷ segments of its girder line, surface area from the weight (12 m² a tonne), drilled thickness 40 mm;
 *        the cut pieces follow.
 *   node scripts/cf_kepl/planning-demo.mjs --company 180005 --stage plan --order <code> [--prod] [--apply]
 *        values checked → execution plan saved (production orders made) → lines locked → customer accepted and approved
 *        (confirmed) → production orders sent to planning. Committed date from --due YYYY-MM-DD.
 *
 *   node scripts/cf_kepl/planning-demo.mjs --company 180005 --stage buy --order <code> --supplier SAIL-HYD --expected YYYY-MM-DD [--receive] [--prod] [--apply]
 *        the order's material: MR raised → Stores saves it (nothing from stock) → its PR → the vendor, quotes (₹62 a kg,
 *        else ₹4,500 a unit) → PO, approved by the MD, due on --expected; --receive books it all in (a plain receipt).
 *
 * Every stage is one transaction per order; without --apply it is rolled back. Sandbox only: refuses company 30005.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const COMPANY = Number(arg('company')); const STAGE = arg('stage'); const APPLY = process.argv.includes('--apply');
if (!COMPANY || !STAGE) { console.error('Usage: --company <id> --stage status|plan … [--prod] [--apply]'); process.exit(2); }
if (COMPANY === 30005) { console.error('Not on the real Placebo company — this is a sandbox demo.'); process.exit(2); }
if (process.argv.includes('--prod')) {
  const env = {};
  fs.readFileSync(path.join(__dir, '..', '..', '..', '.env.tidb'), 'utf8').split('\n').forEach((l) => {
    l = l.trim(); if (!l || l.startsWith('#')) return;
    const [k, ...r] = l.split('='); env[k.trim()] = r.join('=').trim();
  });
  Object.assign(process.env, { DB_HOST: env.DB_HOST, DB_PORT: env.DB_PORT ?? '4000', DB_USER: env.DB_USER, DB_PASSWORD: env.DB_PASSWORD, DB_NAME: env.DB_NAME, DB_SSL: 'true' });
}
const BE = path.join(__dir, '..', '..');
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
await imp('apps/cf_erp/services/codegenProvider.js');
const t0 = Date.now();
const say = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

const db = await pool.getConnection();
let code = 0;
try {
  const [[user]] = await db.query("SELECT id, email FROM users WHERE company_id = ? AND deleted_at IS NULL ORDER BY (email LIKE 'md@%') DESC, id LIMIT 1", [COMPANY]);
  const c = { companyId: COMPANY, userId: user.id };
  const admin = { can: () => true, isAdmin: true };

  if (STAGE === 'status') {
    const [rows] = await db.query(
      `SELECT o.id, o.code, LEFT(o.title, 44) AS title, o.status, o.committed_date,
              (SELECT COUNT(*) FROM cf_sales_order_lines l WHERE l.order_id = o.id AND l.deleted_at IS NULL) AS lines_n,
              (SELECT COUNT(*) FROM cf_sales_order_lines l WHERE l.order_id = o.id AND l.deleted_at IS NULL AND l.locked_at IS NOT NULL) AS locked_n,
              (SELECT GROUP_CONCAT(CONCAT(p.code, ':', p.status) SEPARATOR ' ') FROM cf_production_orders p WHERE p.order_id = o.id AND p.deleted_at IS NULL) AS pos
         FROM cf_sales_orders o WHERE o.company_id = ? AND o.deleted_at IS NULL ORDER BY o.id`, [COMPANY]);
    for (const r of rows) console.log(`${r.code}  #${r.id}  ${r.status.padEnd(9)} due ${r.committed_date ?? '—'}  lines ${r.locked_n}/${r.lines_n} locked  ${r.pos ?? '(no production orders)'}  ${r.title}`);
  }

  if (STAGE === 'values') {
    const [[o]] = await db.query('SELECT * FROM cf_sales_orders WHERE company_id = ? AND code = ? AND deleted_at IS NULL', [COMPANY, arg('order')]);
    if (!o) throw new Error(`No order ${arg('order')}`);
    const span = Number(arg('span') ?? 36000); const girder = arg('girder') ?? 'Composite';
    const { readLineValues, writeLineValues } = await imp('apps/cf_erp/services/orderValuesService.js');
    const { withCutPieces } = await imp('apps/cf_erp/services/cutPlateService.js');
    const [lines] = await db.query('SELECT id, line_no FROM cf_sales_order_lines WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL ORDER BY line_no', [COMPANY, o.id]);
    await db.beginTransaction();
    for (const l of lines) {
      // --leaf-sections: rows the lock calls "made on the order, but nothing is under it" (a cleat, a bearing assembly
      // the drawing set left unanswered) are said to be cut from a section, so they get a bar and a cut piece.
      if (process.argv.includes('--leaf-sections')) {
        const { lockPlan } = await imp('apps/cf_erp/services/lockService.js');
        const plan = await lockPlan(db, COMPANY, l.id);
        const names = new Set((plan.problems ?? []).map((p) => String(p).match(/^(.+?) under .+ is made on the order, but nothing is under it/)?.[1]).filter(Boolean));
        if (names.size) {
          const v0 = await readLineValues(db, COMPANY, l.id);
          const writes0 = [];
          for (const g of v0.groups) {
            const col = g.columns.find((x) => x.code === 'CUT_FROM');
            if (!col) continue;
            const opt = (v0.optionLists?.[col.options] ?? []).find((x) => /section/i.test(String(x.label ?? x.value ?? x)));
            if (!opt) continue;
            for (const r of g.rows) if (names.has(r.name)) writes0.push({ recordId: r.id, specCode: 'CUT_FROM', value: opt.value ?? opt.label ?? opt });
          }
          say(`line ${l.line_no}: ${writes0.length} leaf rows (${[...names].join(', ')}) said to be cut from a section`);
          if (writes0.length) { const out0 = await writeLineValues(db, c, l.id, { writes: writes0 }); if (out0.applied) await withCutPieces(db, c, l.id, out0); }
        }
        // Every row said to be cut from a section (now or on an earlier run) and still without a bar: the bar and a length.
        const v1 = await readLineValues(db, COMPANY, l.id);
        const leafIds = v1.groups.flatMap((g) => g.rows).filter((r) => /cleat|bearing assembly/i.test(r.name)).map((r) => r.id);
        if (leafIds.length) {
          const [[bar0]] = await db.query('SELECT id FROM cf_master_records WHERE company_id = ? AND code = ? AND deleted_at IS NULL', [COMPANY, arg('bar') ?? 'ISA-100X100X10X12000-E350BO']);
          const [u0] = await db.query('UPDATE cf_master_records SET cut_stock_id = ? WHERE company_id = ? AND id IN (?) AND cut_stock_id IS NULL', [bar0.id, COMPANY, leafIds]);
          let lens = 0;
          for (const g of v1.groups) if (g.columns.some((x) => x.code === 'LENGTH')) {
            const w = g.rows.filter((r) => leafIds.includes(r.id) && !r.cells?.LENGTH?.input && !r.cells?.LENGTH?.display).map((r) => ({ recordId: r.id, specCode: 'LENGTH', value: 300 }));
            if (w.length) { try { const o1 = await writeLineValues(db, c, l.id, { writes: w }); if (o1.applied) lens += w.length; } catch (e) { say('length not written:', e.message, JSON.stringify(e.problems ?? '').slice(0, 300)); } }
          }
          say(`line ${l.line_no}: ${u0.affectedRows} leaf rows given the bar, ${lens} given a length of 300 mm`);
        }
      }
      for (let pass = 1; pass <= 3; pass += 1) {
        const v = await readLineValues(db, COMPANY, l.id);
        const rowsAll = v.groups.flatMap((g) => g.rows);
        const kids = new Map();
        for (const r of rowsAll) { const p = r.parent?.id ?? r.parent ?? null; if (!kids.has(p)) kids.set(p, []); kids.get(p).push(r); }
        const weightOf = (r) => { const m = String(r.cells?.WEIGHT?.display ?? r.cells?.WEIGHT?.input ?? '').match(/[d.]+/); return m ? Number(m[0]) : null; };
        const writes = []; const unknown = new Map();
        for (const g of v.groups) for (const r of g.rows) for (const [code, cell] of Object.entries(r.cells ?? {})) {
          if (!cell.missing) continue;
          const col = g.columns.find((x) => x.code === code);
          const opts = col?.options ? (v.optionLists?.[col.options] ?? []) : [];
          const optOf = (re) => { const f = opts.find((x) => re.test(String(x.label ?? x.value ?? x))); return f ? (f.value ?? f.label ?? f) : null; };
          let value = null;
          const sibs = (kids.get(r.parent?.id ?? r.parent ?? null) ?? []).filter((x) => x.name === r.name).length || 1;
          const w = weightOf(r);
          if (code === 'IMPACT_CLASS') value = optOf(/^BO/);
          else if (code === 'GIRDER_TYPE') value = optOf(new RegExp(`^${girder}`, 'i'));
          else if (code === 'SPAN_LENGTH') value = span;
          else if (code === 'COATS') value = 2;
          else if (code === 'METALLISE_COATS') value = 1;
          else if (code === 'PAINT_COATS') value = 3;
          else if (code === 'MIG_WELD_SIZE') value = 6;
          else if (code === 'SAW_WELD_SIZE') value = 8;
          else if (code === 'MIG_WELD_LENGTH') value = 20;
          else if (code === 'SAW_WELD_LENGTH') value = 40;
          else if (code === 'HOLE_DRILL_THICKNESS') value = 40;
          else if (code === 'LENGTH') value = Math.round(span / Math.max(1, sibs) / 10) * 10;
          else if (code === 'SURFACE_AREA') value = w ? Math.round(w * 0.012 * 1000) / 1000 : 25;
          else if (col?.dataType === 'boolean') value = false;
          else if (col?.dataType === 'option' && opts.length) value = opts[0].value ?? opts[0].label ?? opts[0];
          else if (col?.dataType === 'number') { unknown.set(code, (unknown.get(code) ?? 0) + 1); value = /COUNT|QTY|HOLES/.test(code) ? 0 : /THICK/.test(code) ? 12 : /WIDTH/.test(code) ? 300 : /LENGTH|HEIGHT|DEPTH/.test(code) ? 1000 : 1; }
          else if (col?.dataType === 'text') { unknown.set(code, (unknown.get(code) ?? 0) + 1); value = 'As per drawing'; }
          if (value != null) writes.push({ recordId: r.id, specCode: code, value });
        }
        say(`line ${l.line_no} pass ${pass}: ${v.counts.missingOwn} open, ${writes.length} to write${unknown.size ? ` (by a plain default: ${[...unknown].map(([k, n]) => `${k}×${n}`).join(', ')})` : ''}`);
        if (!writes.length) break;
        const out = await writeLineValues(db, c, l.id, { writes });
        if (out.applied) await withCutPieces(db, c, l.id, out);
      }
      const end = await readLineValues(db, COMPANY, l.id);
      say(`line ${l.line_no}: ${end.counts.missingOwn} required values still open`);
      // Parts cut from a section with no bar chosen: the stock angle bar (a planning demo — the size is not the drawing's).
      const [[bar]] = await db.query('SELECT id, code FROM cf_master_records WHERE company_id = ? AND code = ? AND deleted_at IS NULL', [COMPANY, arg('bar') ?? 'ISA-100X100X10X12000-E350BO']);
      const sectionRows = end.groups.flatMap((g) => g.rows).filter((r) => /section/i.test(String(r.cells?.CUT_FROM?.display ?? r.cells?.CUT_FROM?.defaultDisplay ?? r.cells?.CUT_FROM?.input ?? '')));
      if (bar && sectionRows.length) {
        const [u] = await db.query('UPDATE cf_master_records SET cut_stock_id = ? WHERE company_id = ? AND id IN (?) AND cut_stock_id IS NULL', [bar.id, COMPANY, sectionRows.map((r) => r.id)]);
        say(`line ${l.line_no}: ${u.affectedRows} of ${sectionRows.length} section parts given ${bar.code}`);
        const { refreshCutPieces } = await imp('apps/cf_erp/services/cutPlateService.js');
        const made = await refreshCutPieces(db, c, l.id, {});
        say(`line ${l.line_no}: cut pieces ${JSON.stringify(made).slice(0, 200)}`);
      }
    }
    if (APPLY) { await db.commit(); say('COMMITTED'); } else { await db.rollback(); say('rolled back (dry run)'); }
  }

  // --stage marks --defs "GS-001,ARB,…": those part definitions SHIP AS ONE UNIT (SHIP_UNIT = yes, set once on the
  // definition) — the shipping units the month plan counts (a girder segment, a chord piece, an arch box).
  if (STAGE === 'marks') {
    const { setValues } = await imp('apps/cf_erp/services/valueService.js');
    await db.beginTransaction();
    for (const code of String(arg('defs') ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
      const [[d]] = await db.query("SELECT id, name FROM cf_master_records WHERE company_id = ? AND code = ? AND record_kind = 'definition' AND deleted_at IS NULL", [COMPANY, code]);
      if (!d) { say(`no definition ${code}`); continue; }
      const out = await setValues(db, c, 'master', d.id, [{ specCode: 'SHIP_UNIT', value: true }]);
      say(`${code} ${d.name}: ships as one unit (${out.changes?.length ?? 0} change)`);
    }
    if (APPLY) { await db.commit(); say('COMMITTED'); } else { await db.rollback(); say('rolled back (dry run)'); }
  }

  // --stage split --order <code> --rows "Main truss,Floor system": the planner plans those rows' PARTS separately
  // (plannerService.putLineSplit) — a truss ships as chords, verticals and diagonals, not as one truss.
  if (STAGE === 'split') {
    const { putLineSplit } = await imp('apps/cf_erp/services/plannerService.js');
    const names = String(arg('rows') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const [rows] = await db.query(
      `SELECT l.id AS line_id, bl.id AS bom_line_id, m.name FROM cf_sales_orders o JOIN cf_sales_order_lines l ON l.order_id = o.id AND l.deleted_at IS NULL
         JOIN cf_boms b ON b.company_id = l.company_id AND b.parent_id = l.item_id AND b.deleted_at IS NULL
         JOIN cf_bom_lines bl ON bl.bom_id = b.id AND bl.deleted_at IS NULL JOIN cf_master_records m ON m.id = bl.child_id
        WHERE o.company_id = ? AND o.code = ? AND o.deleted_at IS NULL AND m.name IN (?)`, [COMPANY, arg('order'), names]);
    await db.beginTransaction();
    for (const r of rows) { await putLineSplit(db, c, r.line_id, { bomLineId: r.bom_line_id, split: true }); say(`${r.name}: its parts are planned separately`); }
    if (APPLY) { await db.commit(); say('COMMITTED'); } else { await db.rollback(); say('rolled back (dry run)'); }
  }

  if (STAGE === 'buy') {
    const [[o]] = await db.query('SELECT * FROM cf_sales_orders WHERE company_id = ? AND code = ? AND deleted_at IS NULL', [COMPANY, arg('order')]);
    if (!o) throw new Error(`No order ${arg('order')}`);
    const [[sup]] = await db.query('SELECT id, name FROM cf_parties WHERE company_id = ? AND code = ? AND is_supplier = 1 AND deleted_at IS NULL', [COMPANY, arg('supplier') ?? 'SAIL-HYD']);
    if (!sup) throw new Error('No such supplier');
    const [[area]] = await db.query("SELECT id, code FROM cf_stocking_areas WHERE company_id = ? AND purpose = 'storage' AND status = 'active' AND deleted_at IS NULL ORDER BY id LIMIT 1", [COMPANY]);
    const { today } = await (await imp('apps/cf_erp/services/monthPlanService.js')).plantToday(db, COMPANY);
    const expected = arg('expected') ?? today;
    const days = Math.max(0, Math.round((Date.parse(expected) - Date.parse(today)) / 86400000));
    await db.beginTransaction();
    const RQ = await imp('apps/cf_erp/services/requisitionService.js');
    const PR = await imp('apps/cf_erp/services/purchaseRequestService.js');
    const PU = await imp('apps/cf_erp/services/purchaseService.js');
    const { decide } = await imp('apps/cf_erp/services/approvalService.js');
    const [have] = await db.query('SELECT id FROM cf_requisitions WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL', [COMPANY, o.id]);
    if (!have.length) { await RQ.raiseRequisitions(db, c, o.id, {}); say('material request raised'); }
    const [mrs] = await db.query('SELECT id, code FROM cf_requisitions WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL ORDER BY id', [COMPANY, o.id]);
    for (const mr of mrs) {
      let screen = await PR.mrScreen(db, COMPANY, mr.id);
      if (!screen.purchaseRequest) screen = await PR.saveMr(db, c, mr.id, { lines: screen.lines.map((l) => ({ lineId: l.id, takeFromStock: 0 })) });
      const prId = screen.purchaseRequest?.id;
      if (!prId) { say(`${mr.code}: nothing to buy`); continue; }
      let pr = await PR.getPr(db, COMPANY, prId);
      const open = pr.lines.filter((l) => Number(l.needed) - Number(l.poRaised ?? 0) > 1e-6);
      say(`${mr.code} → ${pr.code}: ${pr.lines.length} lines, ${open.length} still to order`);
      if (open.length) {
        if (!pr.vendors.length) pr = await PR.addVendor(db, c, prId, { supplierId: sup.id });
        const v = pr.vendors[0];
        await PR.setQuotes(db, c, v.id, { quotes: open.map((l) => ({ lineId: l.id, rate: /kg/i.test(String(l.item?.uom ?? l.uom ?? '')) ? 62 : 4500, deliveryDays: days })) });
        const made = await PR.raisePo(db, c, v.id, { lines: open.map((l) => ({ lineId: l.id, quantity: Number(l.needed) - Number(l.poRaised ?? 0) })) });
        const po = made.purchaseOrder;
        const [[ap]] = await db.query("SELECT id FROM cf_approvals WHERE company_id = ? AND approval_type = 'purchase_order' AND subject_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1", [COMPANY, po.id]);
        if (ap) await decide(db, c, ap.id, { decision: 'approve', note: 'Planning demo' }, admin); else await PU.approvePurchaseOrder(db, c, po.id, {});
        await db.query('UPDATE cf_purchase_order_lines SET expected_date = ? WHERE company_id = ? AND purchase_order_id = ? AND deleted_at IS NULL', [expected, COMPANY, po.id]);
        await db.query('UPDATE cf_purchase_orders SET expected_date = ? WHERE company_id = ? AND id = ?', [expected, COMPANY, po.id]).catch(() => {});
        say(`${po.code} placed with ${sup.name}, due ${expected}`);
      }
      if (process.argv.includes('--receive')) {
        const [pls] = await db.query(
          `SELECT l.id, l.quantity - l.qty_received AS pending FROM cf_purchase_order_lines l JOIN cf_purchase_orders po ON po.id = l.purchase_order_id
            WHERE l.company_id = ? AND l.deleted_at IS NULL AND po.deleted_at IS NULL AND po.status IN ('ordered', 'partially_received')
              AND l.id IN (SELECT purchase_line_id FROM cf_purchase_line_orders WHERE company_id = ? AND order_id = ?)`, [COMPANY, COMPANY, o.id]);
        let n = 0;
        for (const pl of pls) if (Number(pl.pending) > 1e-6) { await PU.receiveLine(db, c, pl.id, { quantity: Number(pl.pending), stockingAreaId: area.id }); n += 1; }
        say(`${n} purchase line(s) received into ${area.code}`);
      }
    }
    if (APPLY) { await db.commit(); say('COMMITTED'); } else { await db.rollback(); say('rolled back (dry run)'); }
  }

  // --stage release --order <code>: its production orders in Planning → released (the lines must be nested, the material in).
  if (STAGE === 'release') {
    const [[o]] = await db.query('SELECT id, code FROM cf_sales_orders WHERE company_id = ? AND code = ? AND deleted_at IS NULL', [COMPANY, arg('order')]);
    const [pos] = await db.query("SELECT id, code FROM cf_production_orders WHERE company_id = ? AND order_id = ? AND status = 'planning' AND deleted_at IS NULL", [COMPANY, o.id]);
    const [[area]] = await db.query("SELECT id FROM cf_stocking_areas WHERE company_id = ? AND purpose IN ('storage', 'dispatch') AND status = 'active' AND deleted_at IS NULL ORDER BY (purpose = 'dispatch') DESC, id LIMIT 1", [COMPANY]);
    const { releaseProductionOrders } = await imp('apps/cf_erp/services/productionOrderService.js');
    await db.beginTransaction();
    const out = await releaseProductionOrders(db, c, { ids: pos.map((p) => p.id), finishedAreaId: area.id, notes: 'Planning demo' });
    say(`released: ${(out.released ?? []).join(', ')}`);
    const [[n]] = await db.query('SELECT COUNT(*) AS n FROM cf_production_steps s JOIN cf_production_items pi ON pi.id = s.production_item_id JOIN cf_production_releases r ON r.id = pi.release_id WHERE r.company_id = ? AND r.order_id = ?', [COMPANY, o.id]);
    say(`${o.code}: ${n.n} production steps`);
    if (APPLY) { await db.commit(); say('COMMITTED'); } else { await db.rollback(); say('rolled back (dry run)'); }
  }

  // --known "SO260023:2026-11-10": the date an order's material was promised for, as it was known on the day planned as of.
  const knownOf = async () => {
    const out = {};
    for (const pair of String(arg('known') ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
      const [code, date] = pair.split(':');
      const [[o]] = await db.query('SELECT id FROM cf_sales_orders WHERE company_id = ? AND code = ? AND deleted_at IS NULL', [COMPANY, code]);
      if (o) out[o.id] = date;
    }
    return Object.keys(out).length ? out : null;
  };

  // --stage freeze --month 2026-11 --from 2026-11-01 [--known …]: the month plan AS OF that day, saved, sent to the MD and
  // approved — frozen, stamped that morning.
  if (STAGE === 'freeze') {
    const M = await imp('apps/cf_erp/services/monthPlanService.js');
    const { decide } = await imp('apps/cf_erp/services/approvalService.js');
    const month = arg('month'); const from = arg('from') ?? `${month}-01`;
    await db.beginTransaction();
    const run = await M.planMonth(db, COMPANY, { month, from, materialAsKnown: await knownOf(), toleranceDays: Number(arg('tolerance') ?? 5) });
    const inputs = { machineIds: run.machineIds, ranks: run.ranks, toleranceDays: run.toleranceDays, from };
    const [ins] = await db.query(
      "INSERT INTO cf_mplans (company_id, month, version, status, tolerance_days, inputs_json, result_json, tonnes, bound_tonnes, run_at, note, created_by) VALUES (?, ?, 1, 'draft', ?, ?, ?, ?, ?, ?, ?, ?)",
      [COMPANY, `${month}-01`, run.toleranceDays, JSON.stringify(inputs), JSON.stringify(run.result), run.result.tonnes, run.result.boundTonnes, `${from} 09:15:00`, 'Planning demo: the plan as it stood on the 1st.', c.userId]);
    const m = await M.sendMonth(db, c, ins.insertId, { note: 'November plan — six orders, the fabrication machines that are switched on.' });
    await decide(db, c, m.plan.approvalId, { decision: 'approve', note: 'Approved. Watch the JNPA material date.' }, admin);
    await db.query('UPDATE cf_mplans SET sent_at = ?, frozen_at = ? WHERE id = ?', [`${from} 09:40:00`, `${from} 11:05:00`, ins.insertId]);
    say(`month plan ${month} frozen: ${run.result.tonnes} t (priority ${run.result.priorityTonnes}, bound ${run.result.boundTonnes}), weeks ${run.result.weeks.map((w) => `${w.no}:${w.tonnes}`).join(' ')}`);
    if (APPLY) { await db.commit(); say('COMMITTED'); } else { await db.rollback(); say('rolled back (dry run)'); }
  }

  // --stage week --day 2026-11-09 [--from 2026-11-09] [--publish] [--known …]: the plan of that day's week, as of --from.
  if (STAGE === 'week') {
    const F = await imp('apps/cf_erp/services/planFollowService.js');
    const day = arg('day'); const from = arg('from');
    await db.beginTransaction();
    const w = await F.runWeek(db, c, { weekStart: day, note: arg('note') ?? null }, from ? { from, wall: `${from} 09:30:00`, materialAsKnown: await knownOf(), publish: process.argv.includes('--publish') } : null);
    if (!from && process.argv.includes('--publish')) await F.publishWeek(db, c, w.plan.id);
    say(`week ${w.week.no} (${w.week.start}–${w.week.end}): ${w.plan.tonnesWeek} t this week, month forecast ${w.plan.tonnesMonth} t, frozen ${w.frozen?.tonnes}`);
    if (APPLY) { await db.commit(); say('COMMITTED'); } else { await db.rollback(); say('rolled back (dry run)'); }
  }

  // --stage progress --week-of <day> --from D1 --to D2 --share 0.8 [--stop "CODE|2026-11-04 08:00:00|2026-11-05 18:00:00"]:
  // what "happened" on the floor between two days, following that week's plan: of the units planned to finish by D2, a share
  // is finished (every step of their pieces done, run sessions on machines of the plan's types on the planned days); the
  // rest get the work planned up to D2. A machine stop is written as the floor would record it.
  if (STAGE === 'progress') {
    const D1 = arg('from'); const D2 = arg('to'); const share = Number(arg('share') ?? 0.8);
    const F = await imp('apps/cf_erp/services/planFollowService.js');
    const { getPlanner } = await imp('apps/cf_erp/services/plannerService.js');
    const { insertRows } = await imp('apps/cf_erp/lib/db.js');
    const wk = F.weekOfDay(arg('week-of') ?? D1);
    const [[wrow]] = await db.query('SELECT * FROM cf_wplans WHERE company_id = ? AND week_start = ? AND deleted_at IS NULL', [COMPANY, wk.start]);
    if (!wrow) throw new Error(`No week plan for ${wk.start}`);
    const doc = typeof wrow.result_json === 'string' ? JSON.parse(wrow.result_json) : wrow.result_json;
    const inputs = typeof wrow.inputs_json === 'string' ? JSON.parse(wrow.inputs_json) : wrow.inputs_json;
    const snap = await getPlanner(db, COMPANY, { from: `${wk.month}-01` });
    const piecesOf = new Map(snap.units.map((u) => [u.key, u.pieceIds ?? (u.pieceId ? [u.pieceId] : [])]));
    // Released steps, by piece; the pieces' tree; operation → machine type; the plan's machines by type.
    const [steps] = await db.query(
      `SELECT s.id, s.operation_id, s.quantity, s.eff_minutes, s.state, pi.order_piece_id FROM cf_production_steps s
         JOIN cf_production_items pi ON pi.id = s.production_item_id AND pi.deleted_at IS NULL JOIN cf_production_releases r ON r.id = pi.release_id
        WHERE s.company_id = ? AND s.deleted_at IS NULL AND r.deleted_at IS NULL`, [COMPANY]);
    const stepsOfPiece = new Map();
    for (const s of steps) { if (!stepsOfPiece.has(s.order_piece_id)) stepsOfPiece.set(s.order_piece_id, []); stepsOfPiece.get(s.order_piece_id).push(s); }
    const [pieces] = await db.query('SELECT id, parent_id FROM cf_order_pieces WHERE company_id = ? AND order_line_id IN (SELECT DISTINCT r.order_line_id FROM cf_production_releases r WHERE r.company_id = ? AND r.deleted_at IS NULL)', [COMPANY, COMPANY]);
    const kidsOf = new Map();
    for (const p of pieces) { if (!kidsOf.has(p.parent_id)) kidsOf.set(p.parent_id, []); kidsOf.get(p.parent_id).push(p.id); }
    const subtree = (ids) => { const out = []; const todo = [...ids]; while (todo.length) { const x = todo.pop(); out.push(x); for (const k of kidsOf.get(x) ?? []) todo.push(k); } return out; };
    const [rules] = await db.query("SELECT operation_id, subject_id FROM cf_operation_machine_rules WHERE company_id = ? AND deleted_at IS NULL AND eligible = 1 AND subject_type = 'classification'", [COMPANY]);
    const fnOfOp = new Map(rules.map((r) => [Number(r.operation_id), String(r.subject_id)]));
    const [machines] = await db.query("SELECT id, classification_id FROM cf_machines WHERE company_id = ? AND id IN (?) AND status = 'active' AND deleted_at IS NULL", [COMPANY, inputs.machineIds]);
    const byType = new Map();
    for (const m of machines) { const k = String(m.classification_id); if (!byType.has(k)) byType.set(k, []); byType.get(k).push(m.id); }
    const rr = new Map(); const clock = new Map();     // round robin per type; minutes used per machine-day
    const pick = (fn) => { const list = byType.get(fn) ?? []; if (!list.length) return null; const i = (rr.get(fn) ?? 0) % list.length; rr.set(fn, i + 1); return list[i]; };
    const stamp = (day, minutes) => new Date(Date.parse(`${day}T08:00:00Z`) + minutes * 60000).toISOString().slice(0, 19).replace('T', ' ');
    const sessions = []; const updates = new Map();     // `${machine}|${start}|${end}` → step ids
    let finished = 0; let partial = 0; let touched = 0; let n = 0;
    const hasWork = (u) => subtree(piecesOf.get(u.key) ?? []).some((p) => stepsOfPiece.has(p));
    const units = doc.units.filter(hasWork).sort((a, b) => String(a.finish ?? '9').localeCompare(String(b.finish ?? '9')) || a.key.localeCompare(b.key));
    for (const u of units) {
      const planned = u.steps.filter((s) => Object.keys(s.byDay).some((d) => d >= D1 && d <= D2));
      if (!planned.length) continue;
      const dueInRange = !!u.finish && u.finish <= D2;
      n += 1;
      const complete = dueInRange && ((n * 7919) % 100) / 100 < share;       // a fixed, repeatable choice
      const dayOfFn = new Map(planned.map((s) => [s.fn, Object.keys(s.byDay).filter((d) => d >= D1 && d <= D2).sort().pop()]));
      const fnsDone = new Set(complete ? u.steps.map((s) => s.fn) : planned.filter((s) => s.to <= D2 && (dueInRange ? ((n * 31) % 100) / 100 < 0.6 : true)).map((s) => s.fn));
      if (!fnsDone.size) continue;
      let any = false;
      for (const pid of subtree(piecesOf.get(u.key) ?? [])) for (const s of stepsOfPiece.get(pid) ?? []) {
        if (s.state === 'done') continue;
        const fn = fnOfOp.get(Number(s.operation_id));
        if (!complete && !(fn && fnsDone.has(fn))) continue;
        const machine = fn ? pick(fn) : null;
        const day = (fn && dayOfFn.get(fn)) || (u.finish && u.finish >= D1 && u.finish <= D2 ? u.finish : D2);
        const minutes = Math.max(1, Math.round(Number(s.eff_minutes ?? 0)));
        const ck = `${machine}|${day}`; const used = clock.get(ck) ?? 0; clock.set(ck, used + minutes);
        const start = stamp(day, Math.min(used, 600)); const end = stamp(day, Math.min(used, 600) + minutes);
        if (machine) sessions.push([COMPANY, machine, s.id, null, start, end, 'done', 'day_entry', s.quantity, 0, c.userId]);
        const key = `${machine ?? ''}|${start}|${end}`;
        if (!updates.has(key)) updates.set(key, []);
        updates.get(key).push(s.id); s.state = 'done'; any = true; touched += 1;
      }
      if (any) { if (complete) finished += 1; else partial += 1; }
    }
    await db.beginTransaction();
    for (let i = 0; i < sessions.length; i += 400) await insertRows(db, 'cf_work_sessions', ['company_id', 'machine_id', 'step_id', 'operator_id', 'started_at', 'ended_at', 'end_kind', 'source', 'qty_good', 'qty_scrap', 'entered_by'], sessions.slice(i, i + 400));
    for (const [key, ids] of updates) {
      const [machine, start, end] = key.split('|');
      for (let i = 0; i < ids.length; i += 500) await db.query("UPDATE cf_production_steps SET state = 'done', qty_good = quantity, machine_id = COALESCE(?, machine_id), started_at = ?, finished_at = ? WHERE company_id = ? AND id IN (?)", [machine ? Number(machine) : null, start, end, COMPANY, ids.slice(i, i + 500)]);
    }
    if (arg('stop')) {
      const [code, a, b] = arg('stop').split('|');
      const [[m]] = await db.query('SELECT id FROM cf_machines WHERE company_id = ? AND code = ? AND deleted_at IS NULL', [COMPANY, code]);
      const [[reason]] = await db.query("SELECT id FROM cf_stop_reasons WHERE company_id = ? AND deleted_at IS NULL ORDER BY (code IN ('BREAKDOWN', 'BRKDN')) DESC, id LIMIT 1", [COMPANY]);
      if (m && reason) { await db.query('INSERT INTO cf_machine_stops (company_id, machine_id, started_at, ended_at, reason_id) VALUES (?, ?, ?, ?, ?)', [COMPANY, m.id, a, b, reason.id]); say(`stop written on ${code}: ${a} → ${b}`); } else say('no such machine or stop reason — stop not written');
    }
    const hrs = Math.round(sessions.reduce((t, s) => t + (Date.parse(`${s[5].replace(' ', 'T')}Z`) - Date.parse(`${s[4].replace(' ', 'T')}Z`)) / 3600000, 0));
    say(`${D1}–${D2}: ${finished} units finished, ${partial} part done; ${touched} steps done, ${sessions.length} run sessions (${hrs} h)`);
    if (APPLY) { await db.commit(); say('COMMITTED'); } else { await db.rollback(); say('rolled back (dry run)'); }
  }

  // --stage close-week --day <day in the week> --notes "…" [--at "YYYY-MM-DD hh:mm:ss"]
  if (STAGE === 'close-week') {
    const F = await imp('apps/cf_erp/services/planFollowService.js');
    const wk = F.weekOfDay(arg('day'));
    const [[wrow]] = await db.query('SELECT id FROM cf_wplans WHERE company_id = ? AND week_start = ? AND deleted_at IS NULL', [COMPANY, wk.start]);
    await db.beginTransaction();
    const w = await F.closeWeek(db, c, wrow.id, { notes: arg('notes') ?? null });
    if (arg('at')) await db.query('UPDATE cf_wplans SET closed_at = ? WHERE id = ?', [arg('at'), wrow.id]);
    say(`week ${wk.no} closed: planned ${w.actual.plannedTonnes} t, done ${w.actual.doneTonnes} t; right ${w.actual.right.length}, wrong ${w.actual.wrong.length}`);
    for (const x of w.actual.wrong.slice(0, 6)) say('  wrong:', x.kind, x.unit, x.cause);
    if (APPLY) { await db.commit(); say('COMMITTED'); } else { await db.rollback(); say('rolled back (dry run)'); }
  }

  // --stage po-date --order <code> --expected YYYY-MM-DD: the supplier moved the date of that order's purchase orders.
  if (STAGE === 'po-date') {
    const [[o]] = await db.query('SELECT id FROM cf_sales_orders WHERE company_id = ? AND code = ? AND deleted_at IS NULL', [COMPANY, arg('order')]);
    await db.beginTransaction();
    const [r] = await db.query(
      `UPDATE cf_purchase_order_lines SET expected_date = ? WHERE company_id = ? AND deleted_at IS NULL
          AND id IN (SELECT purchase_line_id FROM cf_purchase_line_orders WHERE company_id = ? AND order_id = ?)`, [arg('expected'), COMPANY, COMPANY, o.id]);
    say(`${r.affectedRows} purchase line(s) now due ${arg('expected')}`);
    if (APPLY) { await db.commit(); say('COMMITTED'); } else { await db.rollback(); say('rolled back (dry run)'); }
  }

  // --stage fault --machine <code> --note "…": a machine of the plan goes down now (a real fault, as the floor raises it).
  if (STAGE === 'fault') {
    const { raiseFault } = await imp('apps/cf_erp/services/maintenanceService.js');
    const [[m]] = await db.query('SELECT id FROM cf_machines WHERE company_id = ? AND code = ? AND deleted_at IS NULL', [COMPANY, arg('machine')]);
    await db.beginTransaction();
    const out = await raiseFault(db, c, { machineId: m.id, note: arg('note') ?? 'Planning demo fault' });
    say(`fault raised: ${JSON.stringify(out).slice(0, 200)}`);
    if (APPLY) { await db.commit(); say('COMMITTED'); } else { await db.rollback(); say('rolled back (dry run)'); }
  }

  // --stage consumables --rows "SAWWELD:<item code>:0.9,ARCWELD:<item code>:1.2": what an operation uses per run hour.
  if (STAGE === 'consumables') {
    await db.beginTransaction();
    for (const row of String(arg('rows') ?? '').split(',').filter(Boolean)) {
      const [op, item, qty] = row.split(':');
      const [[o]] = await db.query('SELECT id FROM cf_operations WHERE company_id = ? AND code = ? AND deleted_at IS NULL', [COMPANY, op]);
      const [[i]] = await db.query('SELECT id FROM cf_master_records WHERE company_id = ? AND code = ? AND deleted_at IS NULL', [COMPANY, item]);
      if (!o || !i) { say(`skipped ${row}`); continue; }
      await db.query('UPDATE cf_operation_consumables SET deleted_at = NOW() WHERE company_id = ? AND operation_id = ? AND item_id = ? AND deleted_at IS NULL', [COMPANY, o.id, i.id]);
      await db.query("INSERT INTO cf_operation_consumables (company_id, operation_id, item_id, per, quantity, created_by) VALUES (?, ?, ?, 'hour', ?, ?)", [COMPANY, o.id, i.id, Number(qty), c.userId]);
      say(`${op} uses ${qty} of ${item} per run hour`);
    }
    if (APPLY) { await db.commit(); say('COMMITTED'); } else { await db.rollback(); say('rolled back (dry run)'); }
  }

  // --stage roster [--date YYYY-MM-DD]: tomorrow's roster, suggested and published.
  if (STAGE === 'roster') {
    const F = await imp('apps/cf_erp/services/planFollowService.js');
    await db.beginTransaction();
    const d = await F.getDay(db, COMPANY, { date: arg('date') ?? undefined });
    const out = await F.saveDay(db, c, { date: d.day, tasks: d.tasks, machines: d.machines, publish: true, note: 'Planning demo' });
    say(`roster ${out.day}: ${out.tasks.length} tasks on ${new Set(out.tasks.map((t) => t.machineId)).size} machines — published`);
    if (APPLY) { await db.commit(); say('COMMITTED'); } else { await db.rollback(); say('rolled back (dry run)'); }
  }

  if (STAGE === 'plan') {
    const [[o]] = await db.query('SELECT * FROM cf_sales_orders WHERE company_id = ? AND code = ? AND deleted_at IS NULL', [COMPANY, arg('order')]);
    if (!o) throw new Error(`No order ${arg('order')}`);
    await db.beginTransaction();
    const [lines] = await db.query('SELECT id, line_no, locked_at FROM cf_sales_order_lines WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL ORDER BY line_no', [COMPANY, o.id]);
    const due = arg('due');
    if (due) await db.query('UPDATE cf_sales_orders SET committed_date = ? WHERE id = ?', [due, o.id]);
    // 1. values
    const { readLineValues } = await imp('apps/cf_erp/services/orderValuesService.js');
    for (const l of lines) {
      const v = await readLineValues(db, COMPANY, l.id);
      say(`line ${l.line_no}: values missing own ${v.counts?.missingOwn ?? '?'} of ${v.counts?.rows ?? '?'} rows`);
    }
    // 2. execution plan → production orders
    const { saveExecutionPlan } = await imp('apps/cf_erp/services/executionPlanService.js');
    const { syncProductionOrders, sendToPlanning } = await imp('apps/cf_erp/services/productionOrderService.js');
    const [[havePlan]] = await db.query('SELECT COUNT(*) AS n FROM cf_order_execution_plans WHERE company_id = ? AND order_id = ?', [COMPANY, o.id]).catch(() => [[{ n: 0 }]]);
    if (!Number(havePlan.n)) { await saveExecutionPlan(db, c, o.id, {}); say('execution plan saved'); }
    await syncProductionOrders(db, c, o.id);
    // 3. lock
    const { lockLine, lockPlan } = await imp('apps/cf_erp/services/lockService.js');
    for (const l of lines) {
      if (l.locked_at) { say(`line ${l.line_no} already locked`); continue; }
      const plan = await lockPlan(db, COMPANY, l.id);
      if (plan.problems?.length) { say(`line ${l.line_no} lock problems:`, plan.problems.slice(0, 8)); throw new Error('Lock refused — fix the problems above.'); }
      await lockLine(db, c, l.id);
      say(`line ${l.line_no} locked`);
    }
    // 4. customer accepted → the MD approves → confirmed
    const [[now]] = await db.query('SELECT status FROM cf_sales_orders WHERE id = ?', [o.id]);
    if (now.status !== 'confirmed') {
      const { saveAcceptance } = await imp('apps/cf_erp/services/acceptanceService.js');
      const { decide } = await imp('apps/cf_erp/services/approvalService.js');
      await saveAcceptance(db, c, o.id, { accepted: { on: arg('accepted') ?? '2026-10-28', poRef: `PO/${o.code}/DEMO`, note: 'Planning demo' } });
      const [[ap]] = await db.query("SELECT id FROM cf_approvals WHERE company_id = ? AND approval_type = 'order_acceptance' AND order_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1", [COMPANY, o.id]);
      if (!ap) throw new Error('No acceptance approval was raised.');
      await decide(db, c, ap.id, { decision: 'approve', note: 'Planning demo' }, admin);
      say('customer accepted and approved');
    }
    // 5. production orders → planning
    const [pos] = await db.query("SELECT id, code, status FROM cf_production_orders WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL", [COMPANY, o.id]);
    const toSend = pos.filter((p) => p.status === 'yet_to_plan').map((p) => p.id);
    if (toSend.length) { await sendToPlanning(db, c, { ids: toSend }); say(`${toSend.length} production order(s) sent to planning`); }
    const [after] = await db.query("SELECT code, status FROM cf_production_orders WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL", [COMPANY, o.id]);
    say(`${o.code}: ${after.map((p) => `${p.code}:${p.status}`).join(' ')}`);
    if (APPLY) { await db.commit(); say('COMMITTED'); } else { await db.rollback(); say('rolled back (dry run)'); }
  }
} catch (e) {
  code = 1;
  try { await db.rollback(); } catch { /* nothing open */ }
  console.error('FAILED (rolled back):', e.message, e.problems ? JSON.stringify(e.problems).slice(0, 1200) : '');
} finally {
  db.release();
  await pool.end();
}
process.exit(code);
