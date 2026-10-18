// Read part captions / call-outs from drawing text. House-style rules only — no drawing-specific lists.
//
//   "(BS) BEARING PLAIN STFR PL-240X25X2150 - 36NOS"      plate, mark BS, stated qty 36
//   "(SP1) TOP OUTER SPLICE- 500X16X990 - 8Nos"           plate, token SP1 (group or mark: decided later)
//   "ANG1 - ISA 100X100X10X2930"                           angle ISA 100x100x10, length 2930, mark ANG1
//   "BLB-130X130X10X1798 - 92Nos"                          angle (4 numbers, two equal legs)
//   "WEB PL.- 2150X16X6120"                                plate call-out, no qty
// A plate size is three numbers; the thickness is the smallest (house style writes W x T x L,
// but also T x W x L — "36X167X1660", "16X125X125" — so the order is not trusted).

const NUM = '(\\d+(?:\\.\\d+)?)';
const SEP = '\\s*[X×]\\s*';
const SIZE4 = new RegExp(`${NUM}${SEP}${NUM}${SEP}${NUM}${SEP}${NUM}`, 'i');
const SIZE3 = new RegExp(`${NUM}${SEP}${NUM}${SEP}${NUM}`, 'i');
const QTY = /(?:^|[\s\-–(])(\d+)\s*NOS?\b\.?/i;
const SECTION_WORD = /(^|[^A-Z])(ISA|ISMC|ISMB|ISLB|ISJC|ISMA|ANG(?:LE)?S?|L\s*S|BLB|CHANNEL|BEAM|PIPE|TUBE|SHS|RHS|CHS)(?=[^A-Z]|$)/i;
const MAX_PLATE_T = 100;

export function normCaption(text) {
  return String(text).toUpperCase().replace(/\n/g, ' ').replace(/[‐-―]/g, '-').replace(/\s+/g, ' ').trim();
}

/** Parse one text. Returns null when it is not a part caption. */
export function parseCaption(raw) {
  const text = normCaption(raw);
  let m4 = text.match(SIZE4);
  let kind, size, sizeText;
  if (m4) {
    const [a, b, t, L] = m4.slice(1, 5).map(Number);
    if (a === b || SECTION_WORD.test(text)) {
      kind = 'section';
      size = { profile: `ISA ${a}x${b}x${t}`, legA: a, legB: b, t, lengthMm: L, widthMm: Math.max(a, b), thicknessMm: t };
      sizeText = m4[0];
    } else return null; // four numbers that are not an angle — not a part we can read
  } else {
    const m3 = text.match(SIZE3);
    if (!m3) return null;
    const nums = m3.slice(1, 4).map(Number);
    // a 3-number size next to a section word is a profile without a length ("ISA100X100X10")
    if (SECTION_WORD.test(text.slice(0, m3.index + m3[0].length))) return null;
    const sorted = [...nums].sort((x, y) => x - y);
    const t = sorted[0];
    if (!(t > 0) || t > MAX_PLATE_T) return null;
    kind = 'plate';
    size = { thicknessMm: t, widthMm: sorted[1], lengthMm: sorted[2], asWritten: nums };
    sizeText = m3[0];
  }
  // quantity: "- 36NOS", "-18Nos", "- 92Nos" — only AFTER the size (a number before it is part of a name)
  const after = text.slice(text.indexOf(sizeText) + sizeText.length);
  const q = after.match(QTY);
  const qty = q ? Number(q[1]) : null;
  // leading "(TOKEN)" or "TOKEN -"
  let token = null;
  const p = text.match(/^\(\s*([A-Z0-9'’\-]{1,10})\s*\)/);
  if (p) token = p[1].replace(/’/g, "'");
  else {
    const d = text.match(/^([A-Z]{1,4}\d{0,2}'?)\s*-\s*/);
    if (d && !/^(WEB|PAD|TOP|PL|PLATE)$/.test(d[1])) token = d[1];
  }
  let desc = text.replace(sizeText, ' ').replace(/(?:^|[\s\-–])\d+\s*NOS?\b\.?/i, ' ');
  if (p) desc = desc.replace(p[0], ' ');
  else if (token) desc = desc.replace(new RegExp('^' + token.replace(/[.*+?^${}()|[\]\\']/g, '\\$&') + '\\s*-\\s*'), ' ');
  desc = desc.replace(/\bPL(ATE)?\b\.?/g, ' PL ').replace(/[\/:]+/g, ' ').replace(/\s*[-–.]+\s*$/g, '').replace(/\s+-\s*$/, '').replace(/\s+/g, ' ').trim()
    .replace(/^[-.\s]+|[-.\s]+$/g, '');
  return { text, kind, size, qty, token, desc };
}

/** Same physical size (thickness and the two plan dimensions, order-free; mm tolerance). */
export function sameSize(a, b, tol = 0.6) {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'section') return a.size.profile === b.size.profile && Math.abs(a.size.lengthMm - b.size.lengthMm) <= 1;
  return Math.abs(a.size.thicknessMm - b.size.thicknessMm) <= 0.01
    && Math.abs(a.size.widthMm - b.size.widthMm) <= tol && Math.abs(a.size.lengthMm - b.size.lengthMm) <= tol;
}

export const sizeKey = (c) => c.kind === 'section'
  ? `${c.size.profile}x${c.size.lengthMm}`
  : `${c.size.thicknessMm}x${c.size.widthMm}x${c.size.lengthMm}`;

/** Plate weight (kg) of the bounding rectangle; angle weight from its section area. */
export function unitKg(c) {
  if (c.kind === 'section') {
    const { legA, legB, t, lengthMm } = c.size;
    const area = (legA + legB - t) * t; // mm²
    return area * lengthMm * 7.85e-6;
  }
  return c.size.thicknessMm * c.size.widthMm * c.size.lengthMm * 7.85e-6;
}
