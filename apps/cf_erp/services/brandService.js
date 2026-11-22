/**
 * brandService.js — the company's brand list (init.sql §117; user, 2026-11-22).
 *
 * ONE list per company, not tied to families or sub-families: the same brand is on paints, bolts and spares alike.
 * "Unbranded" is a row of its own (is_unbranded = 1), made on first use, always listed first. A lot (cf_stock_batches)
 * carries its brand; its vendor is the lot's supplier. A brand is picked from the list where stock comes in (GRN), and
 * a new one can be added there by typing it: the same name in another spelling of case, spaces or dots is the SAME
 * brand (no second row), and a name close to one already there is answered with that one ("did you mean").
 *
 *   listBrands(db, companyId, { search?, withUse? })   [{ id, name, unbranded, lots?, items?, onHandLots? }]
 *   addBrand(db, c, { name })                          the brand (existing when the name is the same) → { brand, created, similar }
 *   renameBrand(db, c, id, { name })
 *   mergeBrand(db, c, id, { intoId })                  every lot of the brand moves to the other; this one is retired
 *   brandForLot(db, companyId, brandId)                checks a brand id given with a lot → the row (or throws)
 */
import { invalid, notFound } from '../lib/errors.js';

const blank = (v) => v == null || String(v).trim() === '';
export const UNBRANDED = 'Unbranded';
/** What two spellings of one brand share: letters and digits, upper case ("Asian Paints", "ASIAN-PAINTS", "Asian Paints."). */
export const brandKey = (s) => String(s ?? '').toUpperCase().replace(/&/g, ' AND ').replace(/[^A-Z0-9]+/g, '');
const tidy = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

function lev(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 9;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

const shape = (r) => ({
  id: Number(r.id), name: r.name, unbranded: Number(r.is_unbranded) === 1,
  ...(r.lots !== undefined ? { lots: Number(r.lots), items: Number(r.items), lotsInStock: Number(r.lots_in_stock) } : {}),
});

/** The Unbranded row, made the first time it is needed. */
export async function ensureUnbranded(db, companyId, userId = null) {
  const [[u]] = await db.query('SELECT * FROM cf_brands WHERE company_id = ? AND is_unbranded = 1 AND deleted_at IS NULL LIMIT 1', [companyId]);
  if (u) return u;
  await db.query('INSERT INTO cf_brands (company_id, name, is_unbranded, created_by) VALUES (?, ?, 1, ?)', [companyId, UNBRANDED, userId]);
  const [[n]] = await db.query('SELECT * FROM cf_brands WHERE company_id = ? AND is_unbranded = 1 AND deleted_at IS NULL LIMIT 1', [companyId]);
  return n;
}

export async function listBrands(db, companyId, q = {}) {
  await ensureUnbranded(db, companyId);
  const where = ['b.company_id = ?', 'b.deleted_at IS NULL'];
  const params = [companyId];
  if (!blank(q.search)) { where.push('b.name LIKE ?'); params.push(`%${String(q.search).trim().replace(/[%_\\]/g, (m) => `\\${m}`)}%`); }
  const withUse = String(q.withUse) === '1' || q.withUse === true;
  const [rows] = await db.query(
    `SELECT b.id, b.name, b.is_unbranded${withUse ? `,
            (SELECT COUNT(*) FROM cf_stock_batches s WHERE s.company_id = b.company_id AND s.brand_id = b.id AND s.deleted_at IS NULL) AS lots,
            (SELECT COUNT(DISTINCT s.item_id) FROM cf_stock_batches s WHERE s.company_id = b.company_id AND s.brand_id = b.id AND s.deleted_at IS NULL) AS items,
            (SELECT COUNT(DISTINCT k.batch_id) FROM cf_stock_balances k JOIN cf_stock_batches s ON s.id = k.batch_id
              WHERE k.company_id = b.company_id AND s.brand_id = b.id AND k.quantity > 0) AS lots_in_stock` : ''}
       FROM cf_brands b WHERE ${where.join(' AND ')} ORDER BY b.is_unbranded DESC, b.name`, params);
  return rows.map(shape);
}

/** The brand by this name: the existing one when the name is the same brand, else a new row. */
export async function addBrand(db, c, input = {}) {
  const name = tidy(input.name);
  if (!name) throw invalid('INVALID', 'Type the brand name.');
  if (name.length > 100) throw invalid('INVALID', 'A brand name is at most 100 letters.');
  const k = brandKey(name);
  if (!k) throw invalid('INVALID', 'A brand name needs letters or digits.');
  await ensureUnbranded(db, c.companyId, c.userId);
  const [all] = await db.query('SELECT id, name, is_unbranded FROM cf_brands WHERE company_id = ? AND deleted_at IS NULL', [c.companyId]);
  const same = all.find((b) => brandKey(b.name) === k || (Number(b.is_unbranded) === 1 && /^(UN|NON|NO)BRAND(ED)?$|^LOCAL$|^GENERIC$/.test(k)));
  if (same) return { brand: shape(same), created: false, similar: [] };
  // close spellings are offered back; the person decides (input.confirm: add it anyway)
  const similar = all.filter((b) => Number(b.is_unbranded) !== 1 && k.length >= 4 && (lev(brandKey(b.name), k) <= (k.length >= 8 ? 2 : 1)
    || brandKey(b.name).startsWith(k) || k.startsWith(brandKey(b.name)))).map(shape);
  if (similar.length && input.confirm !== true) {
    throw invalid('SIMILAR', `There is already ${similar.map((b) => `"${b.name}"`).join(', ')} — pick it, or add "${name}" as a different brand.`, { similar });
  }
  const [r] = await db.query('INSERT INTO cf_brands (company_id, name, created_by) VALUES (?, ?, ?)', [c.companyId, name, c.userId ?? null]);
  return { brand: { id: r.insertId, name, unbranded: false }, created: true, similar };
}

async function requireBrand(db, companyId, id) {
  const [[b]] = await db.query('SELECT * FROM cf_brands WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, Number(id)]);
  if (!b) throw notFound('Brand');
  return b;
}

export async function renameBrand(db, c, id, input = {}) {
  const b = await requireBrand(db, c.companyId, id);
  if (Number(b.is_unbranded) === 1) throw invalid('FIXED', '"Unbranded" is not renamed.');
  const name = tidy(input.name);
  if (!name || !brandKey(name)) throw invalid('INVALID', 'Type the brand name.');
  const [all] = await db.query('SELECT id, name FROM cf_brands WHERE company_id = ? AND deleted_at IS NULL AND id <> ?', [c.companyId, b.id]);
  const clash = all.find((x) => brandKey(x.name) === brandKey(name));
  if (clash) throw invalid('SAME', `"${clash.name}" is already on the list — merge into it instead.`);
  await db.query('UPDATE cf_brands SET name = ? WHERE company_id = ? AND id = ?', [name, c.companyId, b.id]);
  return shape({ ...b, name });
}

/** A duplicate brand: every lot of it moves to `intoId`, and it leaves the list (kept, pointing at the one it joined). */
export async function mergeBrand(db, c, id, input = {}) {
  const from = await requireBrand(db, c.companyId, id);
  const into = await requireBrand(db, c.companyId, input.intoId);
  if (from.id === into.id) throw invalid('INVALID', 'Pick another brand to merge into.');
  if (Number(from.is_unbranded) === 1) throw invalid('FIXED', '"Unbranded" is not merged away.');
  const [r] = await db.query('UPDATE cf_stock_batches SET brand_id = ? WHERE company_id = ? AND brand_id = ?', [into.id, c.companyId, from.id]);
  await db.query('UPDATE cf_brands SET merged_into_id = ?, deleted_at = NOW() WHERE company_id = ? AND id = ?', [into.id, c.companyId, from.id]);
  return { into: shape(into), lotsMoved: r.affectedRows };
}

/** A brand id sent with a lot: the company's live brand, else a clear refusal. */
export async function brandForLot(db, companyId, brandId) {
  if (blank(brandId)) return null;
  const [[b]] = await db.query('SELECT id, name, is_unbranded FROM cf_brands WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, Number(brandId)]);
  if (!b) throw invalid('INVALID', 'That brand is not on the brand list.');
  return b;
}
