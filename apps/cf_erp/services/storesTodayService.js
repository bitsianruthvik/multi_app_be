/**
 * storesTodayService.js — Stores › Today (init.sql §112, user 2026-11-19).
 *
 * The page the storekeeper lands on: a short list of what needs doing, each line opening one of the desk's screens.
 * Everything here is a READ of what the other screens already keep, except two small writes: the morning check of
 * after-hours entries, and the store's settings (the closed period, hours, limits).
 *
 *   today              purchase orders to follow up (due within 3 days, or late), entries made outside the store's
 *                      hours since the last morning check, the count (today's, this week's, waiting, sent back),
 *                      things out too long, items below their minimum with nothing on order, and level suggestions.
 *   levelSuggestions   a minimum and maximum worked out from what the store actually gave out — GATED: an item is
 *                      suggested only when it has 8 weeks of history and was used in at least 4 of them. Until then
 *                      it says how far the data is. Nothing is applied without a person pressing Apply.
 *
 * The method (the references are in the HANDOFF entry of 2026-11-19):
 *   usage      weekly, the last 26 weeks at most: what was given out of the store's areas, less what came back.
 *              Material sent to a vendor is not usage.
 *   class      Syntetos–Boylan: ADI = weeks / weeks with use; CV² of the size of a week's use.
 *              ADI ≤ 1.32 → steady (smooth or erratic); above → occasional (intermittent or lumpy).
 *   minimum    what is needed to last the lead time plus one review week (the list is looked at weekly), at 95 %:
 *              steady     average × weeks + 1.65 × deviation × √weeks
 *              occasional the 95th percentile of the usage of that many weeks, drawn again and again from the
 *                         item's own weeks (a bootstrap — no bell curve is assumed, which these items do not follow)
 *   maximum    minimum + four weeks of average usage (at least the item's minimum order quantity).
 *   shown      only when it differs from what is set by more than a quarter, or nothing is set.
 */
import { invalid, notFound } from '../lib/errors.js';
import { deskSettings, ledger, outWith, countList, GIVEN_JOINS, givenOf } from './storesDeskService.js';
import { setProcurement } from './procurementMethodService.js';
import { getSettings, clearSettingsCache, zOf } from './settingsService.js';
import { plantZone, wallOf } from './floorService.js';

const blank = (v) => v == null || String(v).trim() === '';
const pad = (n) => String(n).padStart(2, '0');
const dateText = (d) => (d == null ? null : d instanceof Date ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` : String(d).slice(0, 10));
const todayText = () => dateText(new Date());
const addDays = (text, n) => { const d = new Date(`${text}T00:00:00`); d.setDate(d.getDate() + n); return dateText(d); };
const daysBetween = (a, b) => Math.round((new Date(`${b}T00:00:00`) - new Date(`${a}T00:00:00`)) / 86400000);
const round6 = (n) => Number(Number(n).toFixed(6));
const STORE_PURPOSES = ['storage', 'quarantine'];
const minutesOf = (hhmm, def) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? '')); return m ? Number(m[1]) * 60 + Number(m[2]) : def; };

// --- settings -------------------------------------------------------------------

/**
 * PUT /stores-desk/settings { closedThrough? (YYYY-MM-DD | null), backdateDays?, openTime?, closeTime?, toolsOutDays?,
 * countAutoLimit? } — Management's. Closing a period refuses every movement dated on or before it (stockService).
 */
export async function setDeskSettings(db, c, input = {}) {
  const sets = {};
  if (input.closedThrough !== undefined) {
    if (blank(input.closedThrough)) sets.stock_closed_through = null;
    else {
      const s = String(input.closedThrough).trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw invalid('INVALID', 'The closing date needs YYYY-MM-DD.');
      if (s > todayText()) throw invalid('INVALID', 'A period cannot be closed beyond today.');
      sets.stock_closed_through = s;
    }
  }
  const whole = (key, col, label, min, max) => {
    if (input[key] === undefined) return;
    const n = Number(input[key]);
    if (!Number.isInteger(n) || n < min || n > max) throw invalid('INVALID', `${label} is a whole number from ${min} to ${max}.`);
    sets[col] = n;
  };
  whole('backdateDays', 'stock_backdate_days', 'Days an entry may be dated back', 0, 60);
  whole('toolsOutDays', 'tools_out_days', 'Days before a thing is out too long', 1, 730);
  for (const [key, col] of [['openTime', 'store_open_time'], ['closeTime', 'store_close_time']]) {
    if (input[key] === undefined) continue;
    if (minutesOf(input[key], null) == null || minutesOf(input[key], 0) >= 1440) throw invalid('INVALID', 'A time needs HH:MM.');
    sets[col] = String(input[key]).trim().padStart(5, '0');
  }
  if (input.countAutoLimit !== undefined) {
    const n = Number(input.countAutoLimit);
    if (!Number.isFinite(n) || n < 0) throw invalid('INVALID', 'The audit limit is an amount in rupees, zero or more.');
    sets.count_auto_limit = n;
  }
  const cols = Object.keys(sets);
  if (cols.length) {
    await db.query('INSERT IGNORE INTO cf_company_settings (company_id) VALUES (?)', [c.companyId]);
    await db.query(`UPDATE cf_company_settings SET ${cols.map((k) => `${k} = ?`).join(', ')}, updated_by = ? WHERE company_id = ?`, [...Object.values(sets), c.userId ?? null, c.companyId]);
  }
  clearSettingsCache(c.companyId);
  return deskSettings(db, c.companyId);
}

// --- after hours ----------------------------------------------------------------

/** Movements entered outside the store's hours since the last morning check (the last 7 days at most). */
async function afterHours(db, companyId, settings) {
  const open = minutesOf(settings.openTime, 480);
  const close = minutesOf(settings.closeTime, 1080);
  const [[[last]], [rows]] = await Promise.all([
    db.query('SELECT UNIX_TIMESTAMP(MAX(checked_at)) AS ts, MAX(id) AS id FROM cf_store_night_checks WHERE company_id = ?', [companyId]),
    db.query(
      `SELECT mm.id, mm.code, mm.movement_type, mm.given_type, mm.used_for, UNIX_TIMESTAMP(mm.created_at) AS ts, u.name AS by_name,
              so.code AS order_code, dp.name AS department_name, gp.name AS given_party_name, sp.name AS supplier_name, pe.name AS person_name,
              COALESCE(lc.n, 0) AS lines_n, fmr.name AS first_item
         FROM cf_stock_movements mm ${GIVEN_JOINS}
         LEFT JOIN users u ON u.id = mm.created_by
         -- the week's ledger lines counted once, not two lookups a movement (2026-11-24: the per-movement subqueries
         -- had no company_id, so MySQL scanned the whole ledger for each: 0.55 s -> 0.01 s; TiDB 0.48 s -> 0.1 s)
         LEFT JOIN (SELECT l.movement_id, SUM(l.deleted_at IS NULL) AS n, MIN(l.id) AS first_id
                      FROM cf_stock_ledger l JOIN cf_stock_movements m2 ON m2.id = l.movement_id AND m2.company_id = l.company_id
                     WHERE l.company_id = ? AND m2.created_at >= NOW() - INTERVAL 7 DAY
                     GROUP BY l.movement_id) lc ON lc.movement_id = mm.id
         LEFT JOIN cf_stock_ledger fl ON fl.id = lc.first_id
         LEFT JOIN cf_master_records fmr ON fmr.id = fl.item_id
        WHERE mm.company_id = ? AND mm.created_at >= NOW() - INTERVAL 7 DAY
        ORDER BY mm.id DESC LIMIT 500`, [companyId, companyId]),
  ]);
  const since = Number(last?.ts) || 0;
  // A movement's created_at is an instant; "after hours" is the plant's wall clock (cf_floor_settings.timezone).
  const tz = await plantZone(db, companyId);
  const entries = [];
  for (const r of rows) {
    const ts = Number(r.ts);
    if (!ts || ts <= since) continue;
    const wall = wallOf(ts * 1000, tz);
    const minute = Number(wall.slice(11, 13)) * 60 + Number(wall.slice(14, 16));
    const inHours = open <= close ? (minute >= open && minute < close) : (minute >= open || minute < close);
    if (inHours) continue;
    entries.push({
      id: r.id, code: r.code, type: r.movement_type, at: wall.slice(0, 16),
      by: r.by_name ?? null, given: givenOf(r), person: r.person_name ?? null,
      item: r.first_item ?? null, lines: Number(r.lines_n) || 0,
    });
  }
  return { entries, lastCheckedAt: since ? new Date(since * 1000).toISOString() : null, hours: { open: settings.openTime, close: settings.closeTime } };
}

/** POST /stores-desk/night-check { note? } — "I have looked at the after-hours entries". They leave Today. */
export async function nightCheck(db, c, input = {}) {
  const settings = await deskSettings(db, c.companyId);
  const { entries } = await afterHours(db, c.companyId, settings);
  const note = blank(input.note) ? null : String(input.note).trim().slice(0, 500);
  await db.query('INSERT INTO cf_store_night_checks (company_id, entries_n, note, checked_by) VALUES (?, ?, ?, ?)', [c.companyId, entries.length, note, c.userId ?? null]);
  return { checked: entries.length };
}

// --- level suggestions ----------------------------------------------------------

/** The defaults (settingsService carries the same numbers); a company's own come from gateOf. */
export const LEVEL_GATE = { weeks: 8, usedWeeks: 4, window: 26, service: 0.95, z: 1.65, reviewDays: 7, defaultLeadDays: 14, maxWeeks: 4, differs: 0.25 };
/** The gate and method numbers of a company (settings group "Stock levels suggested from use"). */
export function gateOf(S) {
  const service = Number(S.level_service_pct) / 100;
  return {
    weeks: Number(S.level_min_weeks), usedWeeks: Number(S.level_min_used_weeks), window: Number(S.level_window_weeks), service,
    z: service === 0.95 ? 1.65 : Number(zOf(service).toFixed(3)), reviewDays: Number(S.level_review_days), defaultLeadDays: Number(S.level_default_lead_days),
    maxWeeks: Number(S.level_max_weeks), differs: Number(S.level_differs_pct) / 100,
  };
}

/** A small seeded generator, so an item's suggestion is the same every time it is read. */
function seeded(seed) {
  let a = (Number(seed) * 2654435761) >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const niceUp = (v) => (v >= 1 ? Math.ceil(v - 1e-9) : Math.ceil(v * 100 - 1e-9) / 100);

/**
 * The suggestion for one series of weekly usage (newest first or not — order does not matter).
 * → null when the gate is not met, else { cls, weeklyAvg, min, max }.
 */
export function suggestLevels(weeks, { leadDays, minOrderQty = null, seed = 1 } = {}, gate = LEVEL_GATE) {
  const n = weeks.length;
  const used = weeks.filter((q) => q > 0);
  if (n < gate.weeks || used.length < gate.usedWeeks) return null;
  const mean = weeks.reduce((t, q) => t + q, 0) / n;
  const sd = Math.sqrt(weeks.reduce((t, q) => t + (q - mean) ** 2, 0) / (n - 1));
  const adi = n / used.length;
  const sizeMean = used.reduce((t, q) => t + q, 0) / used.length;
  const cv2 = used.length > 1 ? (used.reduce((t, q) => t + (q - sizeMean) ** 2, 0) / (used.length - 1)) / (sizeMean ** 2) : 0;
  const span = (leadDays + gate.reviewDays) / 7;   // weeks the minimum has to last
  let min;
  if (adi <= 1.32) {
    min = mean * span + gate.z * sd * Math.sqrt(span);
  } else {
    const draws = 2000;
    const k = Math.max(1, Math.ceil(span));
    const rnd = seeded(seed);
    const totals = new Array(draws);
    for (let i = 0; i < draws; i++) { let t = 0; for (let j = 0; j < k; j++) t += weeks[Math.floor(rnd() * n)]; totals[i] = t; }
    totals.sort((a, b) => a - b);
    min = totals[Math.min(draws - 1, Math.floor(gate.service * draws))];
    if (min <= 0) min = sizeMean;   // an item used at all keeps at least one usual take
  }
  const cls = adi <= 1.32 ? (cv2 <= 0.49 ? 'smooth' : 'erratic') : (cv2 <= 0.49 ? 'intermittent' : 'lumpy');
  const minQ = niceUp(min);
  const add = Math.max(mean * gate.maxWeeks, Number(minOrderQty) || 0);
  let maxQ = niceUp(min + add);
  if (maxQ <= minQ) maxQ = minQ >= 1 ? minQ + 1 : niceUp(minQ * 2);
  return { cls, weeklyAvg: round6(mean), min: minQ, max: maxQ, adi: Number(adi.toFixed(2)), cv2: Number(cv2.toFixed(2)) };
}

const CLASS_WORDS = { smooth: 'used steadily', erratic: 'used most weeks, in uneven amounts', intermittent: 'used now and then', lumpy: 'used now and then, in uneven amounts' };

/**
 * GET /stores-desk/level-suggestions — { gate, summary, rows }.
 * 3 reads whatever the catalog's size: the store's areas, the weekly usage of every item that moved, their settings.
 */
export async function levelSuggestions(db, companyId, q = {}) {
  const gate = gateOf(await getSettings(db, companyId));
  const pct = Math.round(gate.service * 1000) / 10;
  const t = todayText();
  const from = addDays(t, -gate.window * 7);
  const [areas] = await db.query("SELECT id FROM cf_stocking_areas WHERE company_id = ? AND deleted_at IS NULL AND purpose IN (?)", [companyId, STORE_PURPOSES]);
  const areaIds = areas.length ? areas.map((a) => a.id) : [0];
  const [[usage], [firsts]] = await Promise.all([
    db.query(
      `SELECT l.item_id, FLOOR(DATEDIFF(?, mm.movement_date) / 7) AS wk, SUM(-l.quantity) AS q
         FROM cf_stock_ledger l JOIN cf_stock_movements mm ON mm.id = l.movement_id
        WHERE l.company_id = ? AND l.deleted_at IS NULL AND l.stocking_area_id IN (?) AND mm.movement_date > ? AND mm.movement_date <= ?
          AND mm.reversed_by_id IS NULL AND mm.reversal_of_id IS NULL
          AND ((mm.movement_type = 'issue' AND COALESCE(mm.used_for, '') NOT IN ('vendor', 'asset'))
            OR (mm.movement_type = 'receipt' AND mm.given_type = 'return_in' AND mm.given_party_id IS NULL))
        GROUP BY l.item_id, wk`, [t, companyId, areaIds, from, t]),
    db.query(
      `SELECT l.item_id, MIN(mm.movement_date) AS first_on FROM cf_stock_ledger l JOIN cf_stock_movements mm ON mm.id = l.movement_id
        WHERE l.company_id = ? AND l.deleted_at IS NULL AND l.stocking_area_id IN (?) GROUP BY l.item_id`, [companyId, areaIds]),
  ]);
  const byItem = new Map();
  for (const r of usage) {
    const wk = Number(r.wk);
    if (wk < 0 || wk >= gate.window) continue;
    if (!byItem.has(Number(r.item_id))) byItem.set(Number(r.item_id), new Map());
    byItem.get(Number(r.item_id)).set(wk, Number(r.q));
  }
  const firstOf = new Map(firsts.map((r) => [Number(r.item_id), dateText(r.first_on)]));
  const ids = [...firstOf.keys()];
  const [items] = ids.length ? await db.query(
    `SELECT m.id, m.code, m.name, i.uom, i.stores_kind, ps.method, ps.min_qty, ps.max_qty, ps.lead_time_days, ps.min_order_qty
       FROM cf_master_records m JOIN cf_item_details i ON i.master_id = m.id AND i.deleted_at IS NULL AND i.item_type = 'catalog'
       LEFT JOIN cf_procurement_settings ps ON ps.company_id = m.company_id AND ps.master_id = m.id
      WHERE m.company_id = ? AND m.deleted_at IS NULL AND m.record_kind = 'item' AND m.id IN (?)`, [companyId, ids]) : [[]];

  const rows = [];
  let withUse = 0; let waiting = 0; let longest = 0; let nearest = null;
  for (const it of items) {
    // An item bought another way on purpose (made here, the customer's, only against a requirement) is left alone.
    if (it.method && it.method !== 'buy_min_max') continue;
    const history = Math.min(gate.window, Math.floor(daysBetween(firstOf.get(Number(it.id)), t) / 7));
    longest = Math.max(longest, history);
    const map = byItem.get(Number(it.id)) ?? new Map();
    const weeks = [];
    for (let w = 0; w < history; w++) weeks.push(Math.max(0, map.get(w) ?? 0));
    const usedWeeks = weeks.filter((x) => x > 0).length;
    const curMin = it.min_qty == null ? null : Number(it.min_qty);
    const curMax = it.max_qty == null ? null : Number(it.max_qty);
    if (usedWeeks > 0 || map.size > 0) withUse += 1;
    const leadDays = it.lead_time_days == null ? gate.defaultLeadDays : Number(it.lead_time_days);
    const s = suggestLevels(weeks, { leadDays, minOrderQty: it.min_order_qty, seed: it.id }, gate);
    const base = { item: { id: it.id, code: it.code, name: it.name, uom: it.uom }, weeks: history, usedWeeks, current: { min: curMin, max: curMax } };
    if (!s) {
      // No use in the whole window, and a minimum is being held for it: worth a look.
      if (history >= gate.window && usedWeeks === 0 && curMin != null && curMin > 0) {
        rows.push({ ...base, kind: 'unused', suggested: { min: 0, max: 0 }, weeklyAvg: 0, leadDays, leadAssumed: it.lead_time_days == null,
          why: `Not given out once in ${gate.window} weeks, and a minimum of ${curMin} ${it.uom} is being kept.` });
      } else if (usedWeeks > 0 || map.size > 0) {
        waiting += 1;
        const left = Math.max(gate.weeks - history, 0);
        if (nearest == null || left < nearest) nearest = left;
      }
      continue;
    }
    const differs = curMin == null || Math.abs(s.min - curMin) > gate.differs * Math.max(curMin, 1e-9);
    if (!differs) continue;
    const kind = curMin == null ? 'new' : s.min > curMin ? 'raise' : 'lower';
    rows.push({
      ...base, kind, suggested: { min: s.min, max: s.max }, weeklyAvg: s.weeklyAvg, leadDays, leadAssumed: it.lead_time_days == null, pattern: s.cls,
      why: `${CLASS_WORDS[s.cls][0].toUpperCase()}${CLASS_WORDS[s.cls].slice(1)}: about ${round6(Number(s.weeklyAvg.toFixed(2)))} ${it.uom} a week over ${history} weeks (used in ${usedWeeks}). `
        + `The minimum covers ${leadDays} days to get it${it.lead_time_days == null ? ' (assumed — set the item\'s lead time)' : ''} plus ${gate.reviewDays} days, ${pct} times in 100.`,
    });
  }
  const rank = { raise: 0, new: 1, lower: 2, unused: 3 };
  rows.sort((a, b) => (rank[a.kind] - rank[b.kind]) || (b.weeklyAvg - a.weeklyAvg) || (a.item.id - b.item.id));
  const limit = Math.min(Math.max(Number(q.limit) || 200, 1), 500);
  return {
    gate: { weeks: gate.weeks, usedWeeks: gate.usedWeeks, window: gate.window },
    summary: { suggestions: rows.length, itemsWithUse: withUse, waiting, longestHistoryWeeks: longest, weeksToFirst: rows.length ? 0 : nearest },
    rows: rows.slice(0, limit),
  };
}

/**
 * POST /stores-desk/level-suggestions/:itemId/apply { min, max } — sets the item to "buy to a minimum and maximum" at
 * these levels (what the person saw, not re-read), keeping its lead time, order quantities and vendors.
 */
export async function applyLevel(db, c, itemId, input = {}) {
  const id = Number(itemId);
  const [[m]] = await db.query("SELECT id FROM cf_master_records WHERE company_id = ? AND id = ? AND deleted_at IS NULL AND record_kind = 'item'", [c.companyId, id]);
  if (!m) throw notFound('Item');
  const [[ps]] = await db.query('SELECT * FROM cf_procurement_settings WHERE company_id = ? AND master_id = ?', [c.companyId, id]);
  if (ps?.method && ps.method !== 'buy_min_max') throw invalid('OTHER_METHOD', 'This item is bought another way; change that on the item first.');
  const min = Number(input.min); const max = Number(input.max);
  if (!Number.isFinite(min) || min < 0 || !Number.isFinite(max)) throw invalid('INVALID', 'The minimum and maximum are numbers, zero or more.');
  if (min === 0 && max === 0) {
    // "Keep none": the row stays (lead time, vendors) with the smallest levels the method allows — nothing is reordered at zero.
    await db.query('UPDATE cf_procurement_settings SET min_qty = 0, max_qty = 0, updated_by = ? WHERE company_id = ? AND master_id = ?', [c.userId ?? null, c.companyId, id]);
    return { itemId: id, min: 0, max: 0 };
  }
  await setProcurement(db, c, id, {
    method: 'buy_min_max', minQty: min, maxQty: max,
    leadTimeDays: ps?.lead_time_days ?? undefined, orderMultiple: ps?.order_multiple ?? undefined, minOrderQty: ps?.min_order_qty ?? undefined,
    preferredVendorIds: ps?.preferred_vendor_ids ? String(ps.preferred_vendor_ids).split(',').map(Number) : [],
  });
  return { itemId: id, min, max };
}

// --- today ----------------------------------------------------------------------

/** GET /stores-desk/today — every line of the page in one answer. */
export async function today(db, companyId) {
  const settings = await deskSettings(db, companyId);
  const S = await getSettings(db, companyId);
  const t = todayText();
  const soon = addDays(t, Number(S.po_follow_days));
  const monday = addDays(t, -((new Date(`${t}T00:00:00`).getDay() - Number(S.week_start) + 7) % 7));
  const [[poLines], night, [[cnt]], daily, out, low, levels] = await Promise.all([
    db.query(
      `SELECT p.id, p.code, sp.name AS supplier_name, m.name AS item_name, pl.uom, COALESCE(pl.expected_date, p.expected_date) AS expected,
              GREATEST(pl.quantity - COALESCE(pl.qty_received, 0) - COALESCE(pl.qty_closed, 0), 0) AS open_q
         FROM cf_purchase_order_lines pl
         JOIN cf_purchase_orders p ON p.id = pl.purchase_order_id AND p.deleted_at IS NULL
         JOIN cf_master_records m ON m.id = pl.item_id
         LEFT JOIN cf_parties sp ON sp.id = p.supplier_id
        WHERE pl.company_id = ? AND pl.deleted_at IS NULL AND p.status IN ('ordered', 'partially_received')
          AND COALESCE(pl.expected_date, p.expected_date) <= ?
       HAVING open_q > 0 ORDER BY expected, p.id LIMIT 400`, [companyId, soon]),
    afterHours(db, companyId, settings),
    db.query(
      `SELECT SUM(count_date = ?) AS today_n, SUM(kind = 'weekly' AND count_date >= ?) AS week_n,
              SUM(status = 'pending') AS pending_n, SUM(status = 'rejected' AND count_date >= ?) AS rejected_n, MAX(count_date) AS last_on
         FROM cf_stock_counts WHERE company_id = ? AND deleted_at IS NULL`, [t, monday, addDays(t, -7), companyId]),
    countList(db, companyId, { kind: 'monthly' }).catch(() => null),
    outWith(db, companyId, { overdue: 1 }),
    ledger(db, companyId, { show: 'low', paged: 1, limit: 200 }),
    levelSuggestions(db, companyId, { limit: 50 }),
  ]);

  // Purchase orders: one row an order, its earliest open date.
  const pos = new Map();
  for (const r of poLines) {
    const exp = dateText(r.expected);
    if (!pos.has(r.id)) pos.set(r.id, { id: r.id, code: r.code, supplier: r.supplier_name ?? null, expected: exp, lines: 0, items: [] });
    const p = pos.get(r.id);
    p.lines += 1;
    if (p.items.length < 3) p.items.push(`${r.item_name} (${round6(r.open_q)} ${r.uom})`);
  }
  const poRows = [...pos.values()].map((p) => ({ ...p, daysLate: Math.max(0, daysBetween(p.expected, t)), dueIn: Math.max(0, daysBetween(t, p.expected)) }));
  const lowRows = low.rows.filter((r) => r.onOrder <= 0);
  // 2026-11-22: the audit is monthly and of everything — what is left of this month's.
  const month = daily?.month ?? { from: null, total: 0, audited: 0, done: true };
  const toCount = Math.max(0, month.total - month.audited);
  const countedToday = Number(cnt?.today_n) > 0;
  return {
    date: t,
    settings,
    purchaseOrders: { late: poRows.filter((p) => p.daysLate > 0).length, dueSoon: poRows.filter((p) => p.daysLate === 0).length, followDays: Number(S.po_follow_days), rows: poRows.slice(0, 30) },
    afterHours: night,
    count: {
      toCount, countedToday, dailyDue: false, month,
      weeklyDone: true, pending: Number(cnt?.pending_n) || 0, rejected: Number(cnt?.rejected_n) || 0, lastCount: dateText(cnt?.last_on),
    },
    outTooLong: { count: out.counts.overdue, longDays: out.longDays, rows: out.rows.slice(0, 8) },
    belowMinimum: { count: lowRows.length, lowAll: low.total, rows: lowRows.slice(0, 8).map((r) => ({ item: r.item, balance: r.now, min: r.min })) },
    levels,
  };
}
