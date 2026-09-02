/**
 * parse-kepl-boq.mjs — turn the KEPL BOQ PDF into rows.
 *
 * Run `pdftotext -table` on it first; `-layout` interleaves the Part List and
 * Part Name columns into each other and is unusable.
 *
 * TWO THINGS MAKE THIS PARSEABLE:
 *
 *  1. DENSITY IS THE ANCHOR. Every steel row carries 7.85 in the Unit WT
 *     column, and the four numbers immediately before it are always
 *     thickness, length, width, qty — in that order, on both of the two
 *     different column layouts the two pages use. Counting columns from the
 *     left does not survive the page break; counting back from 7.85 does.
 *
 *  2. A SEGMENT STARTS AT ITS TOP FLANGE. The shipping mark ("G1 - 1") is a
 *     merged cell printed on whichever row happens to sit in the middle of the
 *     block, so it cannot delimit anything. Every segment block does begin with
 *     a Top Flange row, and that can.
 *
 * Writes JSON to stdout; nothing here touches the database.
 */
import fs from 'fs';

const src = process.argv[2];
if (!src) { console.error('usage: node scripts/parse-kepl-boq.mjs <table.txt>'); process.exit(1); }
const lines = fs.readFileSync(src, 'utf8').split('\n');

const MARK = /\b(G\d)\s*-\s*(\d)\b/;
const NUM = /-?\d+(?:\.\d+)?/g;

/** Part codes as the sheet writes them: TF1, W2, BF3, BS1, ES1, IS2, IDTF… */
const CODE = /\b([A-Z]{1,5}\d{0,2})\b/;

/**
 * The eight parts a girder segment is made of, as this sheet names them.
 *
 * Used to decide where a segment block ENDS. Everything else on the sheet —
 * diaphragms, splice cover plates, studs — belongs to the order but not to a
 * segment, and is reported separately rather than being forced into one.
 */
const GIRDER_PARTS = new Set([
  'top flange', 'web', 'bottom flange',
  'bearing stiffener plain', 'bearing stiffener hole', 'end stiffener',
  'intermediate stiffener plain', 'intermediate stiffener hole',
]);

const rows = [];
const loose = [];
let pending = null;   // the block being collected
const blocks = [];

for (const raw of lines) {
  const line = raw.replace(/\s+$/, '');
  if (!line.trim()) continue;
  if (/Page \d+ of \d+|Sl\. No\.|Placebo Fabtech|Bill of Quantity|Client:-|Drg No|Total Weight|Span 59\.3M/.test(line)) continue;

  const nums = line.match(NUM)?.map(Number) ?? [];
  const di = nums.indexOf(7.85);
  if (di < 4) continue;                      // not a steel detail row

  const [thickness, length, width, qty] = nums.slice(di - 4, di);
  if (![thickness, length, width, qty].every((n) => Number.isFinite(n) && n > 0)) continue;

  // Name is the longest run of words; code is the short token before it.
  const words = line.trim().split(/\s{2,}|\s(?=[A-Z])/).map((s) => s.trim()).filter(Boolean);
  const nameMatch = line.match(/([A-Z][A-Za-z.\s]{3,40}?)\s{2,}/);
  const name = (nameMatch?.[1] ?? '').trim();
  const codeMatch = line.match(/^\s*(?:\d+\s+)?([A-Z]{1,5}\d{0,2})\s{2,}/) || line.match(/\s([A-Z]{2,5}\d{0,2})\s{2,}[A-Z]/);
  const code = (codeMatch?.[1] ?? '').trim();

  const m = line.match(MARK);
  const row = {
    code, name, thickness, length, width, qty,
    mark: m ? `${m[1]}-${m[2]}` : null,
    raw: line.trim().slice(0, 110),
  };

  /*
   * A Top Flange opens a new segment block; a mark anywhere inside it labels it.
   *
   * Closing the block needs the part-name whitelist below, not just the next
   * Top Flange. The diaphragm and splice sections that follow the last segment
   * have no Top Flange of their own to open a block with — "Inter. Diaph. Top
   * Flange" is a different name — so without this they all pile into G4-5,
   * which then reports 25 parts.
   */
  const isGirderPart = GIRDER_PARTS.has(name.toLowerCase());
  if (/^top flange$/i.test(name)) { if (pending) blocks.push(pending); pending = { mark: null, parts: [] }; }
  if (pending && isGirderPart) {
    if (row.mark) pending.mark = row.mark;
    pending.parts.push(row);
  } else {
    if (pending) { blocks.push(pending); pending = null; }
    loose.push(row);
  }
  rows.push(row);
}
if (pending) blocks.push(pending);

const segments = blocks.filter((b) => b.mark);

console.log(JSON.stringify({
  segmentBlocks: segments.length,
  segments: segments.map((s) => ({
    mark: s.mark,
    parts: s.parts.map(({ code, name, thickness, length, width, qty }) =>
      ({ code, name, thickness, length, width, qty })),
  })),
  nonSegmentRows: loose.map(({ code, name, thickness, length, width, qty, raw }) =>
    ({ code, name, thickness, length, width, qty, raw })),
}, null, 1));
