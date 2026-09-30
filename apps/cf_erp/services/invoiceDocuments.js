/**
 * invoiceDocuments.js — what an invoice becomes on paper and for the portals
 * (CF_ERP_GST_PLAN §4). Everything here is built from getInvoice's shape, so a
 * document can never disagree with the screen: an issued invoice from its frozen
 * columns, a draft (print only, marked DRAFT) worked out live.
 *
 *   printHtml     A4 HTML, no external assets, every Rule 46 field, copy label.
 *   einvoiceJson  NIC e-invoice schema INV-01 v1.1 (field names exactly as the IRP's).
 *   ewaybillJson  the e-way bill portal's bulk-upload JSON (version 1.0.0621).
 * The user uploads the files by hand; a direct GSP connection comes later.
 */
import { CfError } from '../lib/errors.js';
import { round2 } from './priceService.js';
import { TRANSPORT_MODES } from './invoiceService.js';
import { FOREIGN_STATE } from './taxService.js';

export const COPY_LABELS = {
  original: 'Original for Recipient',
  duplicate: 'Duplicate for Transporter',
  triplicate: 'Triplicate for Supplier',
};

/** UQC (unique quantity code) for a unit — what the portals accept. */
const UQC = {
  nos: 'NOS', no: 'NOS', number: 'NOS', numbers: 'NOS', pcs: 'PCS', pc: 'PCS', piece: 'PCS', pieces: 'PCS', set: 'SET', sets: 'SET',
  kg: 'KGS', kgs: 'KGS', g: 'GMS', gm: 'GMS', gms: 'GMS', t: 'MTS', tonne: 'MTS', tonnes: 'MTS', ton: 'MTS', mt: 'MTS',
  m: 'MTR', mtr: 'MTR', metre: 'MTR', meter: 'MTR', mm: 'MTR', km: 'KME', sqm: 'SQM', m2: 'SQM', l: 'LTR', ltr: 'LTR', litre: 'LTR',
  box: 'BOX', bag: 'BAG', roll: 'ROL', pair: 'PRS', lot: 'OTH',
};
export const uqcOf = (uom) => UQC[String(uom ?? '').trim().toLowerCase()] ?? 'OTH';

/** 'YYYY-MM-DD' (or a Date) → 'dd/mm/yyyy', the portals' date format. */
export function ddmmyyyy(d) {
  if (!d) return null;
  const s = d instanceof Date
    ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    : String(d).slice(0, 10);
  const [y, m, day] = s.split('-');
  return `${day}/${m}/${y}`;
}

const r2 = (n) => round2(n ?? 0);
const r3 = (n) => Math.round(Number(n ?? 0) * 1000) / 1000;
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const money = (n) => (n == null ? '—' : Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const qty = (n) => (n == null ? '—' : Number(n).toLocaleString('en-IN', { maximumFractionDigits: 3 }));

/** An address text as two portal lines of ≤ 100 characters (split at the first line break or comma past the middle). */
function addrLines(text, city) {
  const flat = String(text ?? '').replace(/\s*\n\s*/g, ', ').trim();
  if (!flat) return [city ?? '', ''];
  if (flat.length <= 100) return [flat, ''];
  const cut = flat.lastIndexOf(',', 100);
  const at = cut > 20 ? cut : 100;
  return [flat.slice(0, at).trim(), flat.slice(at + (cut > 20 ? 1 : 0)).trim().slice(0, 100)];
}
const loc = (city, fallback) => { const s = String(city ?? fallback ?? '').trim(); return s.length >= 3 ? s.slice(0, 50) : (s + '---').slice(0, 3); };
const pin = (p) => (p == null || p === '' ? null : Number(p));

function refuse(problems) {
  return new CfError(400, 'CANNOT_MAKE_FILE', problems[0], { problems });
}

// --- e-invoice (NIC INV-01 v1.1) ---------------------------------------------------

/** GET /invoices/:id/einvoice.json — only an issued invoice to a registered buyer (B2B / SEZ / export). */
export function einvoiceJson(inv) {
  const problems = [];
  if (inv.status !== 'issued') problems.push(inv.status === 'draft' ? 'Issue the invoice first — the e-invoice file is made from an issued invoice.' : 'The invoice is cancelled.');
  if (inv.supplyType === 'B2C' || !inv.supplyType) problems.push('The buyer is not registered for GST — an invoice to an unregistered buyer has no e-invoice.');
  if (inv.status === 'issued' && inv.supplyType && !inv.supplyType.startsWith('EXP') && !inv.buyer?.gstin) problems.push('The buyer has no GSTIN.');
  if (problems.length) throw refuse(problems);
  const s = inv.supplier;
  const b = inv.buyer;
  const exp = inv.supplyType.startsWith('EXP');
  const [sa1, sa2] = [s.address1, s.address2];
  const [ba1, ba2] = addrLines(b.address, b.city);
  const out = {
    Version: '1.1',
    TranDtls: { TaxSch: 'GST', SupTyp: inv.supplyType, RegRev: inv.reverseCharge ? 'Y' : 'N', EcmGstin: null, IgstOnIntra: 'N' },
    DocDtls: { Typ: 'INV', No: inv.invoiceNo, Dt: ddmmyyyy(inv.invoiceDate) },
    SellerDtls: {
      Gstin: s.gstin, LglNm: s.legalName, TrdNm: s.tradeName || s.legalName,
      Addr1: String(sa1 ?? '').slice(0, 100), ...(sa2 ? { Addr2: String(sa2).slice(0, 100) } : {}),
      Loc: loc(s.city), Pin: pin(s.pincode), Stcd: s.stateCode,
    },
    BuyerDtls: {
      Gstin: exp ? 'URP' : b.gstin, LglNm: b.name, TrdNm: b.name, Pos: inv.placeOfSupply?.code ?? (exp ? FOREIGN_STATE : b.stateCode),
      Addr1: ba1 || b.name, ...(ba2 ? { Addr2: ba2 } : {}),
      Loc: loc(b.city, ba1), Pin: exp ? 999999 : pin(b.pincode), Stcd: exp ? FOREIGN_STATE : b.stateCode,
    },
  };
  const st = inv.shipTo;
  if (st && !st.sameAsBuyer) {
    const [a1, a2] = addrLines(st.address, st.city);
    out.ShipDtls = {
      ...(st.gstin ? { Gstin: st.gstin } : {}), LglNm: st.name || b.name, TrdNm: st.name || b.name,
      Addr1: a1 || b.name, ...(a2 ? { Addr2: a2 } : {}), Loc: loc(st.city, a1), Pin: pin(st.pincode), Stcd: st.stateCode,
    };
  }
  out.ItemList = inv.lines.map((l, i) => {
    const ass = r2(l.taxable);
    const tax = r2((l.igst ?? 0) + (l.cgst ?? 0) + (l.sgst ?? 0));
    const q = r3(l.billedQty ?? l.quantity);
    return {
      SlNo: String(i + 1),
      PrdDesc: String(l.description ?? '').slice(0, 300),
      IsServc: l.isService ? 'Y' : 'N',
      HsnCd: l.hsnCode,
      Qty: q,
      Unit: uqcOf(l.billedUom ?? l.uom),
      UnitPrice: r3(l.rate),
      TotAmt: ass,
      Discount: 0,
      AssAmt: ass,
      GstRt: Number(l.gstRate ?? 0),
      IgstAmt: r2(l.igst), CgstAmt: r2(l.cgst), SgstAmt: r2(l.sgst),
      CesRt: 0, CesAmt: 0, CesNonAdvlAmt: 0, StateCesRt: 0, StateCesAmt: 0, StateCesNonAdvlAmt: 0, OthChrg: 0,
      TotItemVal: r2(ass + tax),
    };
  });
  const t = inv.totals;
  out.ValDtls = {
    AssVal: r2(t.taxable), CgstVal: r2(t.cgst), SgstVal: r2(t.sgst), IgstVal: r2(t.igst),
    CesVal: 0, StCesVal: 0, Discount: 0, OthChrg: 0, RndOffAmt: r2(t.roundOff), TotInvVal: r2(t.grandTotal),
  };
  const tr = inv.transport;
  if (tr && (tr.vehicleNo || tr.transporterGstin) && tr.distanceKm != null) {
    out.EwbDtls = {
      ...(tr.transporterGstin ? { TransId: tr.transporterGstin } : {}),
      ...(tr.transporter ? { TransName: tr.transporter } : {}),
      Distance: tr.distanceKm,
      ...(tr.lrNo ? { TransDocNo: tr.lrNo } : {}),
      ...(tr.lrDate ? { TransDocDt: ddmmyyyy(tr.lrDate) } : {}),
      ...(tr.vehicleNo ? { VehNo: tr.vehicleNo, VehType: 'R' } : {}),
      ...(tr.mode ? { TransMode: String(TRANSPORT_MODES[tr.mode]) } : {}),
    };
  }
  return out;
}

// --- e-way bill (bulk upload) ------------------------------------------------------

/** GET /invoices/:id/ewaybill.json — needs the transport details (mode, distance, vehicle or transporter). */
export function ewaybillJson(inv) {
  const problems = [];
  if (inv.status !== 'issued') problems.push(inv.status === 'draft' ? 'Issue the invoice first — the e-way bill file is made from an issued invoice.' : 'The invoice is cancelled.');
  const tr = inv.transport ?? {};
  if (!tr.mode) problems.push('Transport mode is not set — enter the transport details.');
  if (tr.distanceKm == null) problems.push('Distance (km) is not set — enter the transport details.');
  if (tr.mode === 'road' && !tr.vehicleNo && !tr.transporterGstin) problems.push('Give the vehicle number, or the transporter\'s GSTIN / id.');
  if (tr.mode && tr.mode !== 'road' && (!tr.lrNo || !tr.lrDate)) problems.push('By rail, air or ship the e-way bill needs the transport document number and date.');
  if (problems.length) throw refuse(problems);
  const s = inv.supplier;
  const b = inv.buyer;
  const st = inv.shipTo && !inv.shipTo.sameAsBuyer ? inv.shipTo : null;
  const exp = String(inv.supplyType ?? '').startsWith('EXP');
  const [fa1, fa2] = [s.address1 ?? '', s.address2 ?? ''];
  const [ta1, ta2] = addrLines(st?.address ?? b.address, st?.city ?? b.city);
  const t = inv.totals;
  const byHsn = new Map();
  for (const l of inv.lines) byHsn.set(l.hsnCode, (byHsn.get(l.hsnCode) ?? 0) + Number(l.taxable ?? 0));
  const mainHsn = [...byHsn.entries()].sort((a, b2) => b2[1] - a[1])[0]?.[0] ?? null;
  const bill = {
    userGstin: s.gstin,
    supplyType: 'O',
    subSupplyType: exp ? 3 : 1,
    subSupplyDesc: '',
    docType: 'INV',
    docNo: inv.invoiceNo,
    docDate: ddmmyyyy(inv.invoiceDate),
    fromGstin: s.gstin,
    fromTrdName: s.tradeName || s.legalName,
    fromAddr1: String(fa1).slice(0, 120),
    fromAddr2: String(fa2).slice(0, 120),
    fromPlace: String(s.city ?? '').slice(0, 50),
    fromPincode: pin(s.pincode),
    actFromStateCode: Number(s.stateCode),
    fromStateCode: Number(s.stateCode),
    toGstin: exp || !b.gstin ? 'URP' : b.gstin,
    toTrdName: b.name,
    toAddr1: ta1,
    toAddr2: ta2,
    toPlace: String(st?.city ?? b.city ?? '').slice(0, 50),
    toPincode: exp ? 999999 : pin(st?.pincode ?? b.pincode),
    actToStateCode: exp ? 99 : Number(st?.stateCode ?? b.stateCode),
    toStateCode: exp ? 99 : Number(inv.placeOfSupply?.code ?? b.stateCode),
    transactionType: st ? 2 : 1,        // 1 regular, 2 bill-to / ship-to
    totalValue: r2(t.taxable),
    cgstValue: r2(t.cgst),
    sgstValue: r2(t.sgst),
    igstValue: r2(t.igst),
    cessValue: 0,
    cessNonAdvolValue: 0,
    otherValue: r2(t.roundOff),
    totInvValue: r2(t.grandTotal),
    transMode: TRANSPORT_MODES[tr.mode],
    transDistance: String(tr.distanceKm),
    transporterName: tr.transporter ?? '',
    transporterId: tr.transporterGstin ?? '',
    transDocNo: tr.lrNo ?? '',
    transDocDate: tr.lrDate ? ddmmyyyy(tr.lrDate) : '',
    vehicleNo: tr.vehicleNo ?? '',
    vehicleType: 'R',
    mainHsnCode: mainHsn ? Number(mainHsn) : null,
    itemList: inv.lines.map((l, i) => ({
      itemNo: i + 1,
      productName: String(l.description ?? '').slice(0, 100),
      productDesc: String(l.description ?? '').slice(0, 100),
      hsnCode: Number(l.hsnCode),
      quantity: r3(l.billedQty ?? l.quantity),
      qtyUnit: uqcOf(l.billedUom ?? l.uom),
      taxableAmount: r2(l.taxable),
      sgstRate: inv.isIgst ? 0 : Number(l.gstRate ?? 0) / 2,
      cgstRate: inv.isIgst ? 0 : Number(l.gstRate ?? 0) / 2,
      igstRate: inv.isIgst ? Number(l.gstRate ?? 0) : 0,
      cessRate: 0,
      cessNonAdvol: 0,
    })),
  };
  return { version: '1.0.0621', billLists: [bill] };
}

// --- print -------------------------------------------------------------------------

/** GET /invoices/:id/print?copy= — the invoice as an A4 page. */
export function printHtml(inv, copy = 'original') {
  const label = COPY_LABELS[copy] ?? COPY_LABELS.original;
  const s = inv.supplier ?? {};
  const b = inv.buyer ?? {};
  const st = inv.shipTo;
  const t = inv.totals;
  const igst = !!inv.isIgst;
  const draft = inv.status === 'draft';
  const cancelled = inv.status === 'cancelled';
  const addr = (...parts) => parts.filter((p) => p != null && String(p).trim() !== '').map(esc).join(', ');
  const stateLine = (code, name) => (code ? `${esc(name ?? '')} (${esc(code)})` : '—');
  const title = draft ? 'DRAFT — not a tax invoice' : 'TAX INVOICE';
  const cols = igst ? '<th>IGST %</th><th>IGST ₹</th>' : '<th>CGST %</th><th>CGST ₹</th><th>SGST %</th><th>SGST ₹</th>';
  const rows = inv.lines.map((l, i) => {
    const tax = igst
      ? `<td class="n">${esc(l.gstRate ?? '—')}</td><td class="n">${money(l.igst)}</td>`
      : `<td class="n">${l.gstRate == null ? '—' : esc(l.gstRate / 2)}</td><td class="n">${money(l.cgst)}</td><td class="n">${l.gstRate == null ? '—' : esc(l.gstRate / 2)}</td><td class="n">${money(l.sgst)}</td>`;
    const billed = l.rateBasis && l.rateBasis !== 'unit' ? `<div class="sub">${qty(l.billedQty)} ${esc(l.billedUom)} billed</div>` : '';
    return `<tr><td class="n">${i + 1}</td><td>${esc(l.description)}<div class="sub">${esc(l.movementCode ?? '')} · line ${esc(l.lineNo)}</div></td>
      <td>${esc(l.hsnCode ?? '—')}</td><td class="n">${qty(l.quantity)} ${esc(l.uom ?? '')}${billed}</td>
      <td class="n">${money(l.rate)}<div class="sub">per ${esc(l.rateBasis === 'unit' || !l.rateBasis ? (l.uom ?? 'unit') : l.billedUom)}</div></td>
      <td class="n">${money(l.taxable)}</td>${tax}<td class="n">${money(l.total)}</td></tr>`;
  }).join('\n');
  const span = igst ? 6 : 6;
  const tr = inv.transport;
  const transport = tr ? [
    tr.mode ? `Mode: ${esc(tr.mode)}` : null, tr.vehicleNo ? `Vehicle: ${esc(tr.vehicleNo)}` : null,
    tr.transporter ? `Transporter: ${esc(tr.transporter)}${tr.transporterGstin ? ` (${esc(tr.transporterGstin)})` : ''}` : null,
    tr.distanceKm != null ? `Distance: ${esc(tr.distanceKm)} km` : null, tr.lrNo ? `LR/RR: ${esc(tr.lrNo)}${tr.lrDate ? ` dt ${esc(ddmmyyyy(tr.lrDate))}` : ''}` : null,
  ].filter(Boolean).join(' · ') : '';
  const ewbs = (inv.ewayBills ?? []).map((e) => `${esc(e.ewayNo)}${e.vehicleNo ? ` (${esc(e.vehicleNo)})` : ''}`).join(', ');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(draft ? 'Draft invoice' : `Invoice ${inv.invoiceNo}`)}</title>
<style>
  @page { size: A4; margin: 12mm; }
  * { box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; font-size: 10.5px; color: #111; background: #fff; margin: 0; }
  .page { max-width: 186mm; margin: 0 auto; padding: 4mm 0; position: relative; }
  h1 { font-size: 17px; margin: 0; letter-spacing: .04em; }
  .copy { text-align: right; font-size: 10px; font-weight: bold; }
  .banner { border: 2px solid #b00; color: #b00; font-weight: bold; text-align: center; padding: 3px; margin: 4px 0; font-size: 12px; }
  table { width: 100%; border-collapse: collapse; }
  .box td { border: 1px solid #555; vertical-align: top; padding: 4px 6px; width: 50%; }
  .k { color: #555; font-size: 9px; text-transform: uppercase; letter-spacing: .03em; }
  .lines th, .lines td { border: 1px solid #555; padding: 3px 4px; }
  .lines th { background: #eee; font-size: 9.5px; }
  .n { text-align: right; white-space: nowrap; }
  .sub { color: #555; font-size: 8.5px; }
  .tot td { padding: 2px 4px; }
  .tot .grand td { font-weight: bold; font-size: 12px; border-top: 1px solid #111; }
  .words { border: 1px solid #555; padding: 4px 6px; margin-top: 4px; }
  .foot td { vertical-align: bottom; padding: 4px 6px; }
  .sign { text-align: right; height: 22mm; }
  .mono { font-family: "Courier New", monospace; font-size: 8px; word-break: break-all; }
  @media print { .page { padding: 0; } }
</style></head>
<body><div class="page">
<table><tr><td><h1>${esc(title)}</h1></td><td class="copy">${esc(label)}</td></tr></table>
${cancelled ? `<div class="banner">CANCELLED${inv.cancelledReason ? ` — ${esc(inv.cancelledReason)}` : ''}</div>` : ''}
${draft ? '<div class="banner">DRAFT — not numbered, not a tax invoice. Issue it to number and freeze it.</div>' : ''}
<table class="box"><tr>
  <td><div class="k">Supplier</div><b>${esc(s.legalName ?? '—')}</b>${s.tradeName && s.tradeName !== s.legalName ? `<br>${esc(s.tradeName)}` : ''}<br>
    ${addr(s.address1, s.address2, s.city, s.pincode)}<br>
    GSTIN: <b>${esc(s.gstin ?? '—')}</b><br>State: ${stateLine(s.stateCode, s.stateName)}</td>
  <td><div class="k">Invoice</div>Invoice no: <b>${esc(inv.invoiceNo ?? '(not yet numbered)')}</b><br>
    Invoice date: <b>${esc(inv.invoiceDate ? ddmmyyyy(inv.invoiceDate) : '—')}</b><br>
    Order: ${esc(inv.order?.code ?? '')}<br>
    Place of supply: <b>${inv.placeOfSupply ? stateLine(inv.placeOfSupply.code, inv.placeOfSupply.name) : '—'}</b><br>
    Whether tax is payable on reverse charge: <b>${inv.reverseCharge ? 'Yes' : 'No'}</b></td>
</tr><tr>
  <td><div class="k">Bill to (recipient)</div><b>${esc(b.name ?? '—')}</b><br>${addr(b.address, b.city, b.pincode)}<br>
    GSTIN: <b>${esc(b.gstin ?? (b.registration === 'unregistered' ? 'Unregistered' : '—'))}</b><br>State: ${stateLine(b.stateCode, b.stateName)}</td>
  <td><div class="k">Ship to</div>${st && !st.sameAsBuyer
    ? `<b>${esc(st.name ?? b.name ?? '')}</b><br>${addr(st.address, st.city, st.pincode)}<br>${st.gstin ? `GSTIN: ${esc(st.gstin)}<br>` : ''}State: ${stateLine(st.stateCode, st.stateName)}`
    : 'Same as bill to'}</td>
</tr></table>
<table class="lines" style="margin-top:6px">
<thead><tr><th>#</th><th>Description of goods / services</th><th>HSN/SAC</th><th>Qty</th><th>Rate ₹</th><th>Taxable ₹</th>${cols}<th>Total ₹</th></tr></thead>
<tbody>${rows}</tbody>
</table>
<table class="tot" style="margin-top:4px"><tbody>
<tr><td colspan="${span}"></td><td class="n">Taxable value</td><td class="n">₹ ${money(t.taxable)}</td></tr>
${igst ? `<tr><td colspan="${span}"></td><td class="n">IGST</td><td class="n">₹ ${money(t.igst)}</td></tr>`
    : `<tr><td colspan="${span}"></td><td class="n">CGST</td><td class="n">₹ ${money(t.cgst)}</td></tr><tr><td colspan="${span}"></td><td class="n">SGST</td><td class="n">₹ ${money(t.sgst)}</td></tr>`}
<tr><td colspan="${span}"></td><td class="n">Round off</td><td class="n">₹ ${money(t.roundOff)}</td></tr>
<tr class="grand"><td colspan="${span}"></td><td class="n">Grand total</td><td class="n">₹ ${money(t.grandTotal)}</td></tr>
</tbody></table>
<div class="words"><span class="k">Amount in words</span><br><b>${esc(t.inWords)}</b></div>
${inv.taxNote ? `<div class="words"><b>${esc(inv.taxNote)}</b>${inv.lutNumber ? ` — LUT ${esc(inv.lutNumber)}` : ''}</div>` : ''}
${transport ? `<div class="words"><span class="k">Transport</span><br>${transport}${ewbs ? `<br>E-way bill: ${ewbs}` : ''}</div>` : (ewbs ? `<div class="words">E-way bill: ${ewbs}</div>` : '')}
${inv.irn ? `<div class="words"><span class="k">e-Invoice</span><br>IRN: <span class="mono">${esc(inv.irn)}</span><br>Ack no: ${esc(inv.ackNo ?? '')} · Ack date: ${esc(inv.ackDate ? String(inv.ackDate instanceof Date ? inv.ackDate.toISOString() : inv.ackDate).slice(0, 16).replace('T', ' ') : '')}${inv.signedQr ? `<br>Signed QR: <span class="mono">${esc(inv.signedQr)}</span>` : ''}</div>` : ''}
${inv.notes ? `<div class="words"><span class="k">Notes</span><br>${esc(inv.notes)}</div>` : ''}
<table class="foot" style="margin-top:8px"><tr>
  <td style="width:55%" class="sub">Certified that the particulars given above are true and correct.</td>
  <td class="sign">for <b>${esc(s.legalName ?? '')}</b><br><br><br><br>Authorised Signatory</td>
</tr></table>
</div></body></html>`;
}
