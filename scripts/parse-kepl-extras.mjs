/**
 * parse-kepl-extras.mjs — the BOQ sections that are not girder segments.
 *
 * End Diaphragm (x6/span), Intermediate Diaphragm (x45), Splice Details (x16)
 * and the shear studs. Together they are 71.26 t of the sheet's 334.64 t per
 * span — the exact difference between the order's current weight and the BOQ's.
 *
 * SELF-CHECKING. Every steel row states its own unit weight, and unit weight is
 * volume x 7.85. So each parsed row is multiplied back out and compared with
 * what the sheet says; a column read into the wrong variable shows up as a
 * weight that does not reconcile, rather than as a quietly wrong order.
 *
 * `-table` output splits columns on runs of 2+ spaces, which is what makes the
 * name recoverable here — the `-layout` output interleaves Part List into Part
 * Name and the two cannot be told apart.
 */
import fs from 'fs';

const src = process.argv[2];
const lines = fs.readFileSync(src, 'utf8').split('\n');

/** Which assembly each row belongs to, in sheet order. */
const SECTIONS = [
  { key: 'end_diaphragm', label: 'End Diaphragm', per: 6, codes: ['EDTF', 'EDW', 'EDBF', 'JS', 'PP'] },
  { key: 'interm_diaphragm', label: 'Intermediate Diaphragm', per: 45, codes: ['IDTF', 'IDW', 'IDDW', 'IDBF', 'ISP', 'IFP', 'ICP'] },
  { key: 'splice', label: 'Splice Details', per: 16, codes: ['WCP', 'TFICP', 'TFOCP', 'BFOCP', 'BFICP'] },
];
const CODES = new Map();
for (const s of SECTIONS) for (const c of s.codes) CODES.set(c, s);

const out = [];
for (const raw of lines) {
  if (!raw.trim()) continue;
  const cells = raw.trim().split(/\s{2,}/).map((c) => c.trim()).filter(Boolean);
  if (cells.length < 4) continue;

  // The code is whichever cell is exactly one of the codes we are looking for.
  const codeCell = cells.find((c) => CODES.has(c.replace(/^\d+\s+/, '')));
  if (!codeCell) continue;
  const code = codeCell.replace(/^\d+\s+/, '');
  const section = CODES.get(code);

  const nums = raw.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
  const di = nums.indexOf(7.85);
  if (di < 4) continue;
  const [thickness, a, b, qty] = nums.slice(di - 4, di);
  const statedUnitWt = nums[di + 1];

  /*
   * The sheet's own arithmetic, used as the check: volume x density x qty.
   *
   * mm^3 -> kg is `x 7.85 / 1e6`. The 7.85 in the sheet's Unit WT column is
   * g/cm^3, i.e. 7850 kg/m^3, so dividing by 1e9 for m^3 AND multiplying by
   * 7.85 counts the density in the wrong unit and lands 1000x low.
   */
  const calc = (thickness * a * b * qty * 7.85) / 1e6;
  const ok = statedUnitWt != null && Math.abs(calc - statedUnitWt) / Math.max(statedUnitWt, 1) < 0.02;

  // Name: the longest cell that is neither the code nor a pure number.
  const name = cells
    .filter((c) => c !== codeCell && !/^[\d.\s]+$/.test(c) && !/^(End|Intermediate|Splice|Diaphragm|Details)$/i.test(c))
    .sort((x, y) => y.length - x.length)[0] ?? code;

  out.push({
    section: section.key, sectionLabel: section.label, perSpan: section.per,
    code, name, thickness, dimA: a, dimB: b, qty,
    statedUnitWt, calcUnitWt: Number(calc.toFixed(2)), reconciles: ok,
  });
}

const bad = out.filter((r) => !r.reconciles);
console.log(JSON.stringify({
  rows: out.length,
  reconciled: out.length - bad.length,
  failed: bad.map((b) => `${b.code}: sheet ${b.statedUnitWt} vs computed ${b.calcUnitWt}`),
  parts: out,
}, null, 1));
