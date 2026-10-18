/**
 * grnMoney.js — the money of a GRN, worked out (init.sql §80). PURE: no database, no clock. The front end has the same
 * arithmetic in `src/apps/cf_erp/lib/grnMoney.ts` (live total while typing); `grn_money_test.mjs` and
 * `cf_erp_grn_money_test.mjs` prove the two agree.
 *
 * PER LINE
 *   gross    = round2(quantity × unit price)
 *   discount = a percentage of gross, or an amount (the user picks which; never both)
 *   taxable  = gross − discount
 *   tax      = taxService.taxOn(taxable, rate, supply): CGST = SGST = round2(taxable × rate / 200) when the supplier is in
 *              the company's state; IGST = round2(taxable × rate / 100) otherwise; none for an unregistered / composition
 *              supplier (supply.zeroRated).
 * PER GRN
 *   freight and "other charges" are each an amount, taxable or not. A taxable one carries GST at the rate given (same
 *   split). Both are shared over the lines by TAXABLE VALUE (largest remainder, to the paisa, so the shares add up
 *   exactly; equal shares when every taxable value is 0).
 *   landed value of a line = taxable + its share of the charges (before their tax). The GST input credit is NOT in it.
 *   landed unit cost = round4(landed value / quantity) — what the stock ledger carries as the receipt's unit cost.
 *   total of the bill = Σ taxable + charges + all the tax (reverse charge: the tax is ours to pay, so it is left out).
 */
import { round2, round4 } from './priceService.js';
import { taxOn } from './taxService.js';

const num = (v) => (v === null || v === undefined || String(v).trim() === '' ? null : Number(v));

/** Cents-exact shares of `total` in proportion to `weights` (largest remainder). Zero weights → equal shares. */
export function shareOut(total, weights) {
  const cents = Math.round(Number(total) * 100);
  const n = weights.length;
  if (!n) return [];
  const sum = weights.reduce((t, w) => t + Math.max(0, Number(w) || 0), 0);
  const w = sum > 0 ? weights.map((x) => Math.max(0, Number(x) || 0) / sum) : weights.map(() => 1 / n);
  const raw = w.map((x) => x * cents);
  const floors = raw.map((x) => Math.floor(x + 1e-9));
  let left = cents - floors.reduce((t, x) => t + x, 0);
  const order = raw.map((x, i) => ({ i, frac: x - Math.floor(x + 1e-9) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; left > 0 && k < order.length; k += 1, left -= 1) floors[order[k].i] += 1;
  return floors.map((x) => x / 100);
}

/** Discount in rupees from what was typed: { mode: 'pct' | 'amt' | null, value }. */
export function discountOf(gross, mode, value) {
  const v = num(value);
  if (!mode || v == null || v <= 0) return 0;
  return mode === 'pct' ? round2((gross * v) / 100) : round2(v);
}

/**
 * lines: [{ quantity, unitPrice, mrp?, discountMode?, discountValue?, gstRate }]
 * charges: { freight: { amount, taxable, gstRate }, other: { amount, taxable, gstRate } }
 * supply: taxService.supplyOf(...) result (isIgst / zeroRated).
 * reverseCharge: the tax is not on the supplier's bill.
 * Returns { lines, charges, totals }.
 */
export function computeGrnMoney({ lines, charges = {}, supply, reverseCharge = false }) {
  const rows = lines.map((l) => {
    const qty = Number(l.quantity);
    const gross = round2(qty * Number(l.unitPrice ?? 0));
    const discountAmount = Math.min(discountOf(gross, l.discountMode, l.discountValue), gross);
    const taxable = round2(gross - discountAmount);
    const rate = l.gstRate == null ? null : Number(l.gstRate);
    const t = rate == null || !supply ? { cgst: 0, sgst: 0, igst: 0, taxTotal: 0 } : taxOn(taxable, rate, supply);
    return {
      ...l, quantity: qty, gross, discountAmount, taxable,
      cgst: t.cgst ?? 0, sgst: t.sgst ?? 0, igst: t.igst ?? 0, tax: t.taxTotal ?? 0,
    };
  });

  const charge = (c) => {
    const amount = round2(Math.max(0, Number(c?.amount ?? 0) || 0));
    const taxable = !!c?.taxable;
    const rate = c?.gstRate == null || c?.gstRate === '' ? null : Number(c.gstRate);
    const t = amount > 0 && taxable && rate != null && supply ? taxOn(amount, rate, supply) : { cgst: 0, sgst: 0, igst: 0, taxTotal: 0 };
    return { amount, taxable, gstRate: rate, cgst: t.cgst ?? 0, sgst: t.sgst ?? 0, igst: t.igst ?? 0, tax: t.taxTotal ?? 0 };
  };
  const freight = charge(charges.freight);
  const other = charge(charges.other);
  const chargesTotal = round2(freight.amount + other.amount);

  const shares = shareOut(chargesTotal, rows.map((r) => r.taxable));
  const out = rows.map((r, i) => {
    const freightAlloc = shares[i] ?? 0;
    const landedValue = round2(r.taxable + freightAlloc);
    return {
      ...r, freightAlloc, landedValue,
      landedUnitCost: r.quantity > 0 ? round4(landedValue / r.quantity) : null,
      lineTotal: round2(r.taxable + r.tax),
    };
  });

  const sum = (k) => round2(out.reduce((t, r) => t + r[k], 0));
  const cgst = round2(sum('cgst') + freight.cgst + other.cgst);
  const sgst = round2(sum('sgst') + freight.sgst + other.sgst);
  const igst = round2(sum('igst') + freight.igst + other.igst);
  const tax = round2(cgst + sgst + igst);
  const taxableTotal = sum('taxable');
  const totals = {
    gross: sum('gross'), discount: sum('discountAmount'), taxable: taxableTotal, charges: chargesTotal,
    cgst, sgst, igst, tax,
    landed: round2(taxableTotal + chargesTotal),
    total: round2(taxableTotal + chargesTotal + (reverseCharge ? 0 : tax)),
  };
  return { lines: out, charges: { freight, other }, totals };
}
