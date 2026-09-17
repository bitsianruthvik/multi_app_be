/**
 * dxfService.js — one nested sheet as a DXF the CNC can open.
 *
 * The plan screen draws a sheet; a cutter needs the same picture as a file
 * their machine reads. This writes the plainest DXF there is (R12 / AC1009,
 * ASCII): a LAYER table and, in ENTITIES, closed POLYLINEs for the plate and
 * every piece, plus a TEXT at each piece's centre naming the blank and its
 * index. No blocks, no LWPOLYLINE, no hatches — every nesting/CAM package
 * since the nineties reads exactly this, and nothing here needs more.
 *
 *   PLATE   the sheet outline, one closed polyline
 *   PIECES  one closed polyline per placed rectangle
 *   LABELS  one TEXT per piece: "<blank handle> #<index>"
 *
 * COORDINATES. The plan's pieces have their origin at the plate's TOP-LEFT
 * with y running down (a screen). DXF y runs UP, so each piece is flipped:
 * dxfY = plateWidth - y - w. X runs along the plate's LENGTH in both.
 * Millimetres throughout ($INSUNITS = 4).
 *
 * The pieces are the plan's own — the layout that was accepted when one was
 * kept, else the display re-pack `blankPlan` derives (`piecesDerived`), which
 * the file says in a comment line so nobody cuts a re-pack thinking it was the
 * accepted arrangement. Their l/w already include the cutting gap the packer
 * inflated them by, exactly as the on-screen drawing shows.
 */

import JSZip from 'jszip';
import { blankPlan } from './blankPlanService.js';

const LAYERS = [
  { name: 'PLATE', color: 7 },
  { name: 'PIECES', color: 3 },
  { name: 'LABELS', color: 1 },
];

/** Numbers as DXF likes them: plain decimals, no exponent, no trailing noise. */
const num = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return '0.0';
  const s = n.toFixed(3).replace(/\.?0+$/, '');
  return s.includes('.') ? s : `${s}.0`;
};

/** DXF TEXT has no escaping for the group's own characters — keep labels plain ASCII. */
const safeText = (s) => String(s ?? '').replace(/[^\x20-\x7E]/g, '?').slice(0, 250);

const handleOf = (blank) => blank?.ref ?? String(blank?.code ?? '').replace(/^BLK-\d+-/, '');

/**
 * The DXF text for one sheet — pure; nothing is read here.
 *
 * @param {{nestNo:string, length:number, width:number, thickness:number, plateCode?:string,
 *          items:{key:string, qty:number}[], pieces?:{key:string,x:number,y:number,l:number,w:number,rotated?:boolean}[],
 *          piecesDerived?:boolean}} nest
 * @param {Map<string, {ref?:string, code?:string}>} blankByKey
 * @param {{orderNumber?:string}} [meta]
 */
export function buildNestDxf(nest, blankByKey, meta = {}) {
  const L = Number(nest.length) || 0;
  const W = Number(nest.width) || 0;
  const out = [];
  const g = (code, value) => { out.push(String(code), String(value)); };

  // A comment (group 999) is legal everywhere and read by nothing — a header for people.
  g(999, safeText(`Nest ${nest.nestNo} - order ${meta.orderNumber ?? ''} - plate ${nest.plateCode ?? ''} `
    + `${num(nest.thickness)} x ${num(W)} x ${num(L)} mm - origin bottom-left, mm, X along plate length`
    + (nest.piecesDerived ? ' - LAYOUT RE-PACKED FOR DISPLAY, NOT THE ACCEPTED ARRANGEMENT' : '')));

  // ── HEADER ─────────────────────────────────────────────────────────────
  g(0, 'SECTION'); g(2, 'HEADER');
  g(9, '$ACADVER'); g(1, 'AC1009');
  g(9, '$INSUNITS'); g(70, 4);
  g(9, '$EXTMIN'); g(10, num(0)); g(20, num(0)); g(30, num(0));
  g(9, '$EXTMAX'); g(10, num(L)); g(20, num(W)); g(30, num(0));
  g(0, 'ENDSEC');

  // ── TABLES: just the layers ────────────────────────────────────────────
  g(0, 'SECTION'); g(2, 'TABLES');
  g(0, 'TABLE'); g(2, 'LAYER'); g(70, LAYERS.length);
  for (const ly of LAYERS) {
    g(0, 'LAYER'); g(2, ly.name); g(70, 0); g(62, ly.color); g(6, 'CONTINUOUS');
  }
  g(0, 'ENDTAB');
  g(0, 'ENDSEC');

  // ── ENTITIES ───────────────────────────────────────────────────────────
  g(0, 'SECTION'); g(2, 'ENTITIES');

  const rect = (layer, x0, y0, x1, y1) => {
    g(0, 'POLYLINE'); g(8, layer); g(66, 1); g(70, 1);   // 70=1: closed
    for (const [x, y] of [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]) {
      g(0, 'VERTEX'); g(8, layer); g(10, num(x)); g(20, num(y)); g(30, num(0));
    }
    g(0, 'SEQEND'); g(8, layer);
  };

  rect('PLATE', 0, 0, L, W);

  const counter = new Map();
  for (const p of nest.pieces ?? []) {
    const x = Number(p.x) || 0;
    const y = Number(p.y) || 0;
    const l = Number(p.l) || 0;
    const w = Number(p.w) || 0;
    const idx = (counter.get(p.key) ?? 0) + 1;
    counter.set(p.key, idx);
    const dxfY = W - y - w;                       // flip: plan y runs down, DXF y runs up
    rect('PIECES', x, dxfY, x + l, dxfY + w);

    // A label the size of the piece, capped so a 10 m plate does not carry a metre-high letter.
    const h = Math.max(5, Math.min(Math.min(l, w) / 4, 120));
    const label = safeText(`${handleOf(blankByKey.get(p.key))} #${idx}${p.rotated ? ' R' : ''}`);
    const cx = x + l / 2;
    const cy = dxfY + w / 2;
    g(0, 'TEXT'); g(8, 'LABELS');
    g(10, num(cx)); g(20, num(cy)); g(30, num(0));
    g(40, num(h)); g(1, label);
    g(72, 1); g(73, 2);                           // centred, middle
    g(11, num(cx)); g(21, num(cy)); g(31, num(0));
  }

  g(0, 'ENDSEC');
  g(0, 'EOF');
  return `${out.join('\r\n')}\r\n`;
}

const safeName = (s) => String(s ?? '').replace(/[^A-Za-z0-9._-]+/g, '_');

/**
 * The accepted plan's sheets, each with the pieces to draw — the saved plan
 * only, never a fresh pack: a DXF is something a machine cuts from, and a
 * proposal nobody accepted is not that.
 */
async function acceptedSheets(companyId, orderId) {
  const plan = await blankPlan(companyId, orderId, { savedOnly: true });
  if (!plan.accepted || !plan.nests?.length) {
    const e = new Error('This order has no accepted cutting plan yet — accept (or upload) one first.');
    e.status = 404; throw e;
  }
  return { plan, blankByKey: new Map(plan.blanks.map((b) => [b.key, b])) };
}

/**
 * One sheet's DXF.
 * @returns {Promise<string>}
 */
export async function nestDxf(companyId, orderId, nestNo) {
  const { dxf } = await nestDxfFile(companyId, orderId, nestNo);
  return dxf;
}

/** One sheet's DXF with the filename the download should carry. */
export async function nestDxfFile(companyId, orderId, nestNo) {
  const { plan, blankByKey } = await acceptedSheets(companyId, orderId);
  const want = String(nestNo ?? '').trim().toUpperCase();
  const nest = plan.nests.find((n) => String(n.nestNo).toUpperCase() === want);
  if (!nest) {
    const e = new Error(`There is no sheet ${nestNo} on this order's accepted plan.`);
    e.status = 404; throw e;
  }
  return {
    dxf: buildNestDxf(nest, blankByKey, { orderNumber: plan.orderNumber }),
    filename: `Nest_${safeName(nest.nestNo)}_${safeName(plan.orderNumber)}.dxf`,
    orderNumber: plan.orderNumber,
  };
}

/**
 * Every accepted sheet as one zip of DXFs.
 * @returns {Promise<{buffer:Buffer, filename:string, count:number}>}
 */
export async function nestsDxfZip(companyId, orderId) {
  const { plan, blankByKey } = await acceptedSheets(companyId, orderId);
  const zip = new JSZip();
  for (const nest of plan.nests) {
    zip.file(
      `Nest_${safeName(nest.nestNo)}_${safeName(plan.orderNumber)}.dxf`,
      buildNestDxf(nest, blankByKey, { orderNumber: plan.orderNumber }),
    );
  }
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  return { buffer, filename: `Nests_${safeName(plan.orderNumber)}_dxf.zip`, count: plan.nests.length };
}
