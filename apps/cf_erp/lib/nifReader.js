/**
 * nifReader.js — CF_ERP. Reads a Hypertherm ProNest JOB FILE (.nif): every nest of the job, the
 * plate each is cut from, and every part on it with its true outline, exactly where ProNest put it
 * (user, 2026-10-13: the shop nests in ProNest and has one .nif per plate thickness).
 *
 * PURE: bytes in, nests out. No database, no tenant, no order. The format is ProNest's own and is
 * not published; it was worked out from six real jobs written by ProNest LT 16.2.1.9298
 * (TM/NECL_48M_NESTING_NIF/NIF_FORMAT_NOTES.md — the container, the part and plate records, the
 * geometry tokens and the placements are described there, with what is certain and what is not).
 * scripts/cf_kepl/nif_reader_test.mjs runs it on those six files, on doctored copies and on a fuzz.
 *
 * ── THREE PROMISES ──────────────────────────────────────────────────────────
 * 1. A VERSION GATE. Every record of the file carries a version number: the vendor changes layouts
 *    between releases. Only the program series and the record versions this was TESTED on are read
 *    (NIF_SUPPORTED, KNOWN_CHUNKS). Anything else is refused in one sentence that names the program
 *    and version found (UNSUPPORTED_VERSION). Nothing that carries geometry is guessed at: an
 *    instruction this does not know, anywhere in a part's or a plate's drawing, refuses the file.
 * 2. A FILE IS CHECKED AGAINST ITSELF, and refused whole when it fails (NEST_CHECK_FAILED, saying
 *    which check and where) — never a partly trusted nest:
 *      part size       the outline decoded for a part is the size — and the area — its own header states;
 *      placement box   that outline, put where the nest places it, is the box the file stores;
 *      inside plate    every piece lies on its plate;
 *      overlap         no two pieces overlap (true polygons, not boxes);
 *      counts          what is nested, counted, is what each part's header says is nested, and no
 *                      more than is required; every count the file declares is what it holds;
 *                      every reference lands on a real part / plate.
 *    The checks are independent of each other, so a layout read wrongly shows up as a failed check,
 *    not as a plausible wrong nest.
 * 3. HOSTILE INPUT IS SAFE. Every read is bounds-checked; the size, the depth of the record tree,
 *    the number of records, strings, nests, pieces and corners are capped; nothing recurses without
 *    a limit. A truncated file, or one that is not a ProNest job, is BAD_FILE in words.
 *
 * ── WHAT COMES BACK ─────────────────────────────────────────────────────────
 * Millimetres (the file is in inches: × 25.4, exactly), plate coordinates: the plate's lower-left
 * corner is (0,0), x along `plate.length`, y along `plate.width` — as the file has them (ProNest
 * stores a 2000 × 12000 plate standing up). A part's outline is `rings { outline, cutouts, holes }`
 * of corner lists, the form lib/nestDxfReader.js gives: matchNest, the layout check and the
 * packer's geometry take them unchanged. Curves are flattened to within 0.005 mm (a cambered web
 * is an arc of 500 m radius over 12 m: five-degree steps would draw it straight).
 * A common-line-cut group is opened into its pieces (`clcGroup` says which belonged together); a
 * mirrored placement — which ProNest stores as a second part record — is its part, `mirrored`.
 * Closed shapes inside a part on the layer of its marking strokes are MARKING (scribed letters),
 * not cut-outs: they are counted (`marking`) and left out of `rings`.
 */
import { DRILL_MAX_DIA_MM } from '../services/partGeometry.js';
import { invalid } from './errors.js';

const IN = 25.4;
const BEGIN = 0xf0f0f0f0;
const END = 0x0f0f0f0f;

/** What this reads, in words and as the gate applies it. */
export const NIF_SUPPORTED = { program: 'ProNest', series: '16.2', label: 'ProNest 2025 LT (16.2)', testedBuild: 'ProNest LT 16.2.1.9298' };
export const NIF_MAX_BYTES = 16 * 1024 * 1024;
const MAX_DEPTH = 48;                   // the six jobs go 16 deep
const MAX_CHUNKS = 400000;              // the biggest of them holds 17,551
const MAX_STRING = 2048;                // characters
const MAX_NESTS = 2000;
const MAX_PIECES = 5000;                // on one nest
const MAX_POINTS = 2000000;             // corners, all outlines together
const MAX_CLC_DEPTH = 8;                // a common-line group inside a group inside …
const MAX_EDGE_TESTS = 3e8;             // the overlap check's own budget
const MAX_COORD_IN = 1e5;               // 2.5 km: anything further is not a coordinate

const TOL_SIZE_MM = 0.05;               // decoded outline against the sizes the file stores
const TOL_PLATE_MM = 0.01;
const SAGITTA_IN = 0.0002;              // 0.005 mm: how far a flattened curve may stray
const ARC_STEP_MAX = Math.PI / 36;      // 5°, the DXF reader's step, where the tolerance allows more

/**
 * Every record (chunk) id with the versions seen in the tested build. A record this does not list —
 * or lists at another version — refuses the file: its layout is not known.
 */
const KNOWN_CHUNKS = {
  1000: [4], 1001: [10], 1002: [4], 1003: [1], 1004: [1], 1005: [1], 1006: [1], 1007: [1], 1008: [13], 1009: [1], 1010: [1], 1011: [1], 1012: [1],
  1015: [1], 1017: [1], 1018: [1], 1019: [1], 1020: [1, 2], 1021: [7], 1023: [1], 1025: [1], 1026: [1], 1028: [1], 1029: [1], 1034: [1], 1035: [3],
  1040: [6], 1041: [1], 1046: [4], 1049: [2], 1051: [1], 1053: [2], 1054: [7], 1055: [2], 1057: [1], 1058: [1], 1059: [1], 1060: [1], 1061: [1],
  1062: [1], 1063: [1], 1065: [1], 1066: [1], 1067: [1], 1068: [1], 1069: [1], 1070: [1], 1071: [1], 1073: [2], 1076: [1], 1077: [2], 1078: [1],
  1079: [1], 1080: [1], 1081: [2], 1082: [1], 1083: [2], 1084: [1], 1092: [1], 1093: [2], 1095: [1, 5], 1098: [1], 1099: [1], 1100: [1], 1101: [1],
  1102: [1], 1104: [1], 1106: [1], 1107: [1], 1108: [1],
};
/** Every instruction (token code) seen in a part's or a plate's drawing. Another one refuses the file. */
const KNOWN_TOKENS = new Set([
  1, 2, 3, 20, 21, 22, 71, 80, 81, 82, 110, 111, 112, 113, 114, 115, 116, 117, 120, 121, 122, 123, 126, 127, 140, 141, 142, 147, 148, 152,
  176, 177, 201, 202, 700, 701, 703, 704, 705, 706, 711, 712, 743, 909, 1004, 1050, 1051, 1052, 1301, 1303, 3001, 3100, 3101, 3102, 3103, 3104,
]);
/** Of those, the ones seen BETWEEN a pierce and its cut-off without being a line or an arc: settings, never a move. */
const INSIDE_CUT_OK = new Set([120, 121, 122, 123, 140, 141, 147, 202, 700, 701, 703, 704, 705, 706, 711, 712, 743, 909, 3001]);

const r4 = (n) => Math.round(n * 1e4) / 1e4;
const r1 = (n) => Math.round(n * 10) / 10;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const list = (xs) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

const bad = (message) => invalid('BAD_FILE', message);
const damaged = (what) => bad(`The file is cut short or damaged (${what}) — it is not a whole ProNest job. Save the job again in ProNest and upload that file.`);
const unsupported = (message, extra) => invalid('UNSUPPORTED_VERSION', message, extra);
const exportInstead = 'Export the nests as DXF, or send us a sample job so it can be added.';
/** A failed self-check: which, where, and that nothing of the file is taken. */
const failed = (check, where, what, extra = {}) => invalid(
  'NEST_CHECK_FAILED',
  `The file does not agree with itself, so nothing of it is taken — ${where}: ${what} (check: ${check}). It may be damaged, or written by a ProNest this was not tested with (it reads ${NIF_SUPPORTED.label}). ${exportInstead}`,
  { check, ...extra },
);

/** Is it a ProNest job? By its first bytes, else by its name. */
export function isNif(buffer, filename = '') {
  if (Buffer.isBuffer(buffer) && buffer.length >= 9 && buffer[0] === 0x12 && buffer[1] === 0x04 && buffer.subarray(2, 9).toString('latin1') === 'ProNest') return true;
  return /\.nif$/i.test(String(filename ?? ''));
}

/* ───────────────────────────── the container ───────────────────────────── */

/**
 * chunk := F0 F0 F0 F0 | u32 id | u16 version | own bytes and child chunks, interleaved | 0F 0F 0F 0F
 * No lengths: a chunk ends at its closing marker. One pass, a stack, no recursion.
 */
function parseTree(b) {
  const root = { id: 0, v: 0, start: 0, kids: [], segs: [], depth: 0 };
  const stack = [root];
  let segStart = 0; let i = 0; let chunks = 0;
  const n = b.length;
  while (i < n) {
    // Both markers are four equal bytes: look closer only where one could start.
    const c = b[i];
    if (c === 0xf0 && i + 10 <= n && b.readUInt32LE(i) === BEGIN) {
      const top = stack[stack.length - 1];
      top.segs.push([segStart, i]);
      const node = { id: b.readUInt32LE(i + 4), v: b.readUInt16LE(i + 8), start: i, kids: [], segs: [], depth: stack.length };
      if (stack.length > MAX_DEPTH) throw bad('The file nests its records deeper than a ProNest job does — it is damaged, or not a ProNest job.');
      chunks += 1;
      if (chunks > MAX_CHUNKS) throw invalid('TOO_BIG', `The job holds more than ${MAX_CHUNKS} records — more than this reads. Split it into smaller jobs.`);
      top.kids.push(node); top.segs.push(node); stack.push(node);
      i += 10; segStart = i;
      continue;
    }
    if (c === 0x0f && stack.length > 1 && i + 4 <= n && b.readUInt32LE(i) === END) {
      const top = stack.pop();
      top.segs.push([segStart, i]);
      top.end = i + 4;
      i += 4; segStart = i;
      continue;
    }
    i += 1;
  }
  root.segs.push([segStart, n]); root.end = n;
  return { root, balanced: stack.length === 1, chunks };
}
const kids = (node, id) => node.kids.filter((k) => k.id === id);
const kid = (node, id) => node.kids.find((k) => k.id === id) ?? null;
const own = (node) => node.segs.filter(Array.isArray);            // its own byte ranges, in order
/** The first chunk of an id anywhere under a node (a stack, not recursion). */
function findFirst(node, id) {
  const todo = [node];
  while (todo.length) {
    const x = todo.pop();
    if (x.id === id) return x;
    for (let k = x.kids.length - 1; k >= 0; k--) todo.push(x.kids[k]);
  }
  return null;
}

/** A cursor over one own-byte range: every read is checked against its end. */
class Cur {
  constructor(b, range, what) {
    if (!range) throw damaged(`${what} is missing`);
    this.b = b; this.o = range[0]; this.end = range[1]; this.what = what;
  }
  need(n) { if (!(n >= 0) || this.o + n > this.end) throw damaged(`${this.what} ends early`); }
  i32() { this.need(4); const v = this.b.readInt32LE(this.o); this.o += 4; return v; }
  u32() { this.need(4); const v = this.b.readUInt32LE(this.o); this.o += 4; return v; }
  u16() { this.need(2); const v = this.b.readUInt16LE(this.o); this.o += 2; return v; }
  u8() { this.need(1); const v = this.b[this.o]; this.o += 1; return v; }
  f64() { this.need(8); const v = this.b.readDoubleLE(this.o); this.o += 8; return v; }
  skip(n) { this.need(n); this.o += n; }
  /** UTF-16LE, ended by a NUL, no length in front. */
  str() {
    let s = '';
    while (this.o + 2 <= this.end) {
      const ch = this.b.readUInt16LE(this.o); this.o += 2;
      if (!ch) return s;
      if (s.length >= MAX_STRING) break;
      s += String.fromCharCode(ch);
    }
    throw damaged(`a name in ${this.what} does not end`);
  }
}
const f64At = (b, range, at, what) => { if (!range || range[0] + at + 8 > range[1]) throw damaged(`${what} ends early`); return b.readDoubleLE(range[0] + at); };
const u32At = (b, range, at, what) => { if (!range || range[0] + at + 4 > range[1]) throw damaged(`${what} ends early`); return b.readUInt32LE(range[0] + at); };

/* ───────────────────────────── geometry ───────────────────────────── */

const finite = (v) => Number.isFinite(v) && Math.abs(v) <= MAX_COORD_IN;
const boxOf = (polys) => {
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const p of polys) for (const [x, y] of p) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
  return [x0, y0, x1, y1];
};
const signedArea = (p) => { let a = 0; for (let i = 0, j = p.length - 1; i < p.length; j = i++) a += p[j][0] * p[i][1] - p[i][0] * p[j][1]; return a / 2; };
/** 3 × 3 matrix, row-vector convention: [x y 1]·M. */
const applyM = (m, [x, y]) => [x * m[0] + y * m[3] + m[6], x * m[1] + y * m[4] + m[7]];

/**
 * A drawing's token stream → its paths. A stream is a run of 20-byte records `i32 code | f64 | f64`
 * (code 3001: the 16 bytes are text). Strict: a code this does not know, or anything but a line, an
 * arc or a known setting between a pierce and its cut-off, refuses the file.
 * → { paths: [{ kind, layer, segs: [{ t, x0, y0, x1, y1, cx?, cy?, cw?, lead }] }], layers: Map index → name }
 */
function readPaths(b, range, what) {
  if (!range) return { paths: [], layers: new Map() };
  if ((range[1] - range[0]) % 20) throw damaged(`the drawing of ${what} is not a whole number of records`);
  const paths = []; const layers = new Map();
  let cur = null; let pos = null; let lead = false; let kind = 'other'; let layer = null; let cut = false; let naming = null;
  for (let o = range[0]; o + 20 <= range[1]; o += 20) {
    const code = b.readInt32LE(o);
    if (!KNOWN_TOKENS.has(code)) throw unsupported(`The drawing of ${what} holds an instruction this reader has not seen (code ${code}), so its shape cannot be trusted — nothing of the file is taken. It reads jobs as ${NIF_SUPPORTED.label} writes them. ${exportInstead}`, { token: code });
    if (code === 3001) {                              // eight characters of text: a layer's name, when one is being named
      if (naming != null) { layers.set(naming, (layers.get(naming) ?? '') + b.subarray(o + 4, o + 20).toString('utf16le').split('\u0000')[0]); }
      continue;
    }
    const x = b.readDoubleLE(o + 4); const y = b.readDoubleLE(o + 12);
    naming = null;
    if (cut && code !== 1 && code !== 2 && code !== 3 && code !== 21 && code !== 22 && !INSIDE_CUT_OK.has(code)) {
      throw unsupported(`The drawing of ${what} holds an instruction inside a cut that this reader has not seen there (code ${code}), so its shape cannot be trusted — nothing of the file is taken. It reads jobs as ${NIF_SUPPORTED.label} writes them. ${exportInstead}`, { token: code });
    }
    switch (code) {
      case 201: if (Number.isInteger(y) && y >= 0 && y < 4096) { naming = y; layers.set(y, ''); } break;   // layer table: index y, its name follows
      case 110: kind = 'interior'; layer = null; break;
      case 112: kind = 'exterior'; layer = null; break;
      case 114: kind = 'open'; layer = null; break;      // an open profile: a common-line member, or a scribed stroke
      case 111: case 113: case 115: kind = 'other'; layer = null; break;
      case 202: if (layer == null && kind !== 'other' && Number.isInteger(x)) { layer = x; if (cur && cur.layer == null) cur.layer = x; } break;
      case 120: case 122: lead = true; break;            // a lead-in / lead-out begins
      case 121: case 123: lead = false; break;
      case 20:                                           // rapid to the pierce point: a path starts
        if (!finite(x) || !finite(y)) throw damaged(`a point in the drawing of ${what} is not a number`);
        pos = [x, y]; cur = { kind, layer, segs: [] }; paths.push(cur); cut = true;
        break;
      case 21: case 22: cut = false; cur = null; break;  // cut off
      case 1:
        if (!finite(x) || !finite(y)) throw damaged(`a point in the drawing of ${what} is not a number`);
        if (cur && pos) cur.segs.push({ t: 'L', x0: pos[0], y0: pos[1], x1: x, y1: y, lead });
        pos = [x, y];
        break;
      case 2: case 3: {                                  // an arc is TWO records: its end, then its centre
        const o2 = o + 20;
        if (o2 + 20 > range[1] || b.readInt32LE(o2) !== code) throw damaged(`an arc in the drawing of ${what} has no centre`);
        const cx = b.readDoubleLE(o2 + 4); const cy = b.readDoubleLE(o2 + 12);
        if (!finite(x) || !finite(y) || !finite(cx) || !finite(cy)) throw damaged(`a point in the drawing of ${what} is not a number`);
        if (cur && pos) {
          const ra = Math.hypot(pos[0] - cx, pos[1] - cy); const rb = Math.hypot(x - cx, y - cy);
          if (!(ra > 0) || !(Math.abs(ra - rb) <= 0.002 + 1e-9 * ra)) throw damaged(`an arc in the drawing of ${what} does not end on its own circle`);
          cur.segs.push({ t: 'A', x0: pos[0], y0: pos[1], x1: x, y1: y, cx, cy, cw: code === 2, lead });
        }
        pos = [x, y]; o = o2;
        break;
      }
      default: break;                                    // a setting: kerf side, lead style, a bounding box — none moves the torch
    }
  }
  return { paths: paths.filter((p) => p.segs.length), layers };
}

/** One path as a list of points, in its own units. Leads are left out unless asked for. */
function flatten(path, withLeads, budget) {
  const pts = [];
  for (const s of path.segs) {
    if (s.lead && !withLeads) continue;
    if (!pts.length) pts.push([s.x0, s.y0]);
    if (s.t === 'L') { pts.push([s.x1, s.y1]); continue; }
    const r = Math.hypot(s.x0 - s.cx, s.y0 - s.cy);
    const a0 = Math.atan2(s.y0 - s.cy, s.x0 - s.cx); const a1 = Math.atan2(s.y1 - s.cy, s.x1 - s.cx);
    let d = a1 - a0;
    if (s.cw) { while (d >= -1e-12) d -= 2 * Math.PI; } else { while (d <= 1e-12) d += 2 * Math.PI; }
    if (Math.hypot(s.x1 - s.x0, s.y1 - s.y0) < 1e-9) d = s.cw ? -2 * Math.PI : 2 * Math.PI;       // a full circle
    const byTol = r > SAGITTA_IN ? 2 * Math.acos(Math.max(-1, 1 - SAGITTA_IN / r)) : ARC_STEP_MAX;
    const step = Math.min(byTol > 0 ? byTol : ARC_STEP_MAX, ARC_STEP_MAX);
    const steps = Math.max(2, Math.min(4000, Math.ceil(Math.abs(d) / step) || 2));
    for (let k = 1; k <= steps; k++) { const a = a0 + (d * k) / steps; pts.push([s.cx + r * Math.cos(a), s.cy + r * Math.sin(a)]); }
    pts[pts.length - 1] = [s.x1, s.y1];
  }
  budget.points += pts.length;
  if (budget.points > MAX_POINTS) throw invalid('TOO_BIG', `The job's outlines hold more than ${MAX_POINTS} corners — more than this reads. Split it into smaller jobs.`);
  return pts;
}
/** A closed list of points as an open ring of distinct corners, counter-clockwise. */
function cleanRing(pts) {
  const out = [];
  for (const p of pts) { const q = out[out.length - 1]; if (!q || Math.abs(q[0] - p[0]) > 1e-7 || Math.abs(q[1] - p[1]) > 1e-7) out.push([p[0], p[1]]); }
  while (out.length > 1 && Math.abs(out[0][0] - out[out.length - 1][0]) <= 1e-7 && Math.abs(out[0][1] - out[out.length - 1][1]) <= 1e-7) out.pop();
  if (out.length >= 3 && signedArea(out) < 0) out.reverse();
  return out;
}
/** A ring that is a circle: its diameter in its own units, else null. */
function circleDia(pts) {
  if (pts.length < 12) return null;
  const b = boxOf([pts]); const cx = (b[0] + b[2]) / 2; const cy = (b[1] + b[3]) / 2;
  let lo = Infinity; let hi = 0;
  for (const [x, y] of pts) { const d = Math.hypot(x - cx, y - cy); if (d < lo) lo = d; if (d > hi) hi = d; }
  return hi - lo <= Math.max(0.006, 0.002 * hi) ? hi + lo : null;
}
const closedGapIn = (pts) => (pts.length > 2 ? Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) : Infinity);

function segCross(a, b, c, d) {       // do segments ab and cd properly cross?
  const o = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const E = 1e-6;
  const d1 = o(c, d, a); const d2 = o(c, d, b); const d3 = o(a, b, c); const d4 = o(a, b, d);
  return ((d1 > E && d2 < -E) || (d1 < -E && d2 > E)) && ((d3 > E && d4 < -E) || (d3 < -E && d4 > E));
}
function inside(pt, poly) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]; const [xj, yj] = poly[j];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}
/** A point certainly inside a ring: the middle of its first span on a line between two of its corner heights. */
function interiorPoint(p) {
  const ys = [...new Set(p.map((q) => q[1]))].sort((a, b) => a - b);
  if (ys.length < 2) return p[0];
  const m = Math.floor((ys.length - 1) / 2);
  const y = (ys[m] + ys[m + 1]) / 2;
  const xs = [];
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) { const a = p[i]; const c = p[j]; if ((a[1] > y) !== (c[1] > y)) xs.push(a[0] + ((y - a[1]) * (c[0] - a[0])) / (c[1] - a[1])); }
  xs.sort((a, b) => a - b);
  return xs.length >= 2 ? [(xs[0] + xs[1]) / 2, y] : p[0];
}
/** A point certainly on a piece's steel: inside its outline and outside every cut-out. */
function materialPoint(P) {
  if (!P.cutouts?.length) return interiorPoint(P.outline);
  const rings = [P.outline, ...P.cutouts];
  const ys = [...new Set(rings.flat().map((q) => q[1]))].sort((a, b) => a - b);
  // Try the mid-heights between corner heights, middle first, until a span of steel is found.
  const mids = [];
  for (let k = 0; k + 1 < ys.length; k++) mids.push((ys[k] + ys[k + 1]) / 2);
  mids.sort((a, b) => Math.abs(a - (ys[0] + ys[ys.length - 1]) / 2) - Math.abs(b - (ys[0] + ys[ys.length - 1]) / 2));
  for (const y of mids) {
    const xs = [];
    for (const r of rings) for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const a = r[i]; const c = r[j]; if ((a[1] > y) !== (c[1] > y)) xs.push(a[0] + ((y - a[1]) * (c[0] - a[0])) / (c[1] - a[1])); }
    xs.sort((a, b) => a - b);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const pt = [(xs[i] + xs[i + 1]) / 2, y];
      if (xs[i + 1] - xs[i] > 1e-6 && inside(pt, P.outline) && !P.cutouts.some((h) => inside(pt, h))) return pt;
    }
  }
  return interiorPoint(P.outline);
}
/** Do two pieces overlap? Outline against outline; one lying in a real cut-out of the other does not. */
function piecesOverlap(A, B, budget) {
  const p = A.outline; const q = B.outline;
  budget.edges += p.length * q.length;
  if (budget.edges > MAX_EDGE_TESTS) throw invalid('TOO_BIG', 'The job is too intricate to check for overlapping parts — more than this reads. Split it into smaller jobs.');
  for (let i = 0, a = p.length - 1; i < p.length; a = i++) for (let j = 0, c = q.length - 1; j < q.length; c = j++) if (segCross(p[a], p[i], q[c], q[j])) return true;
  // The test point must be on X's STEEL: the middle of a web with a big opening is the opening, and a
  // part nested in that opening (part in part) would read as an overlap (2026-10-17, NithinSai 12 mm job).
  const within = (X, Y) => { const pt = materialPoint(X); return inside(pt, Y.outline) && !Y.cutouts.some((h) => inside(pt, h)); };
  return within(A, B) || within(B, A);
}

/* ───────────────────────────── records ───────────────────────────── */

/** The header a part (1015) and a plate (1011) share. */
function readItemHeader(b, node, what) {
  const c = new Cur(b, own(node)[0], what);
  const h = { serial: c.i32(), id: c.i32(), qty: c.i32(), qty2: c.i32(), type: c.i32(), source: c.str(), areaIn2: c.f64() };
  c.i32(); c.u8();
  h.dimA = c.f64(); h.dimB = c.f64(); h.material = c.str(); h.thickness = c.f64();
  if (!(h.dimA > 0 && h.dimA < MAX_COORD_IN && h.dimB > 0 && h.dimB < MAX_COORD_IN)) throw damaged(`the size of ${what} is not a size`);
  if (!(h.thickness > 0 && h.thickness < 40)) throw damaged(`the thickness of ${what} is not a thickness`);
  if (!(h.qty >= 0 && h.qty <= 1e7)) throw damaged(`the quantity of ${what} is not a quantity`);
  return { h, c };
}
const baseName = (p) => String(p ?? '').replace(/\\/g, '/').split('/').pop();

/**
 * What a shop's part name says, when it says it: "16MM-WEB PL1-2150X6130- 4" → thickness 16, size
 * 2150 × 6130, quantity 4. Loose labels: none of it need be true of the drawing (the reader says
 * where it is not, as a note), and none of it is needed to read the file.
 */
export function nifNameFacts(name, jobThicknessMm = null) {
  const s = String(name ?? '');
  const out = { size: null, quantity: null, thickness: null };
  const t = /^\s*(\d+(?:\.\d+)?)\s*MM\b/i.exec(s) ?? /\b(\d+(?:\.\d+)?)\s*(?:MM\s*)?THK\b/i.exec(s);
  if (t) out.thickness = Number(t[1]);
  // The LAST run of numbers joined by X: 2150X6130, or 16X2150X6130 with the thickness in it.
  const runs = [...s.matchAll(/\d+(?:\.\d+)?(?:\s*[Xx×*]\s*\d+(?:\.\d+)?)+/g)];
  if (runs.length) {
    const run = runs[runs.length - 1];
    let nums = run[0].split(/\s*[Xx×*]\s*/).map(Number);
    if (nums.length === 3) {
      const thick = out.thickness ?? jobThicknessMm;
      const i = thick != null && nums.includes(thick) ? nums.indexOf(thick) : nums.indexOf(Math.min(...nums));
      nums = nums.filter((_, k) => k !== i);
    }
    if (nums.length === 2 && nums.every((v) => v > 0)) {
      out.size = nums;
      const q = /^\s*-\s*(\d+)\s*$/.exec(s.slice(run.index + run[0].length));
      if (q) out.quantity = Number(q[1]);
    }
  }
  return out;
}

/* ───────────────────────────── readNif ───────────────────────────── */

/**
 * @param {Buffer} buffer  the .nif file
 * @param {{ filename?: string }} opts
 * @returns {{
 *   program, version, application, jobName, units: 'in',
 *   nests: Array<{ nestNo, quantity,
 *     plate: { length, width, outline, rectangular, material, thickness, name },
 *     parts: Array<{ id, partId, name, sourceFile, requiredQty, rings: { outline, cutouts, holes }, bbox: { x, y, length, width },
 *                    x, y, rotationDeg, mirrored, area, drawn: [a, b], marking, unsure, clcGroup }>,
 *     pieces, clcGroups, utilisation, utilisationStored, usedExtent, minEdgeMargin, outputFile, problems }>,
 *   partsList: Array<{ partId, name, sourceFile, required, nested, notNested, thickness, material, drawn: [l, w], nameSize, nameQuantity, nameThickness, mirroredCopies }>,
 *   counts: { nests, plates, parts, placements, pieces, clcGroups, mirrored, checks },
 *   notes: string[], problems: Array<{ code, nestNo, message }>,
 * }}
 *   `plate.length` runs along x and `plate.width` along y, as the file has them. A part's `rings`,
 *   `bbox`, `x`, `y` are in plate mm, as placed; `rotationDeg` / `mirrored` are ProNest's own turn of
 *   the part's drawing, and `drawn` the size of that drawing as it lies in its own file (a web at
 *   90.3° is still 6130 × 2275). `utilisation` is worked out (net steel ÷ plate); `utilisationStored` is the
 *   figure ProNest cached, null where it left it empty.
 * @throws an Error with .code 'BAD_FILE' | 'TOO_BIG' | 'UNSUPPORTED_VERSION' | 'NEST_CHECK_FAILED' | 'EMPTY_NEST'
 */
export function readNif(buffer, { filename } = {}) {
  const b = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? []);
  const called = filename ? `"${String(filename).split(/[\\/]/).pop()}"` : 'The file';
  if (b.length > NIF_MAX_BYTES) throw invalid('TOO_BIG', `${called} is ${(b.length / 1048576).toFixed(1)} MB — more than a ProNest job this reads (${NIF_MAX_BYTES / 1048576} MB).`);
  if (b.length < 16 || b[0] !== 0x12 || b[1] !== 0x04 || b.subarray(2, 9).toString('latin1') !== 'ProNest') {
    throw bad(`${called} is not a ProNest job file (.nif) — it does not start the way one does. Upload the job as ProNest saved it, or the nests exported as DXF.`);
  }

  // ---- who wrote it ---------------------------------------------------------
  let e = 2;
  while (e < b.length && e < 2 + 80 && b[e] >= 0x20 && b[e] < 0x7f) e += 1;
  const application = b.subarray(2, e).toString('latin1');
  const app = /^(ProNest(?: [A-Za-z][A-Za-z0-9]*)*) (\d+(?:\.\d+){1,3})$/.exec(application);
  if (!app || b[e] !== 0) throw damaged('its first line does not say which ProNest wrote it');
  const program = app[1]; const version = app[2];
  const series = version.split('.').slice(0, 2).join('.');
  if (series !== NIF_SUPPORTED.series) {
    throw unsupported(`${called} was written by ${program} ${series} (${version}) — this reads ${NIF_SUPPORTED.label}. ${exportInstead}`, { program, version, supported: NIF_SUPPORTED.label });
  }

  // ---- the record tree, and the gate on every record -------------------------
  const { root, balanced } = parseTree(b);
  if (!balanced) throw damaged('a record is opened and never closed');
  const first = root.kids[0];
  if (!first || first.id !== 1000) throw damaged('it holds no job');
  // A job ends with four bytes that say where its last record starts: a file cut short by even one byte does not.
  {
    const tail = root.segs[root.segs.length - 1];
    if (tail[1] - tail[0] !== 4 || b.readUInt32LE(tail[0]) !== root.kids[root.kids.length - 1].start) throw damaged('it does not end the way a ProNest job ends');
  }
  {
    const todo = [...root.kids];
    while (todo.length) {
      const x = todo.pop();
      if (!KNOWN_CHUNKS[x.id]?.includes(x.v)) {
        throw unsupported(
          `${called} was written by ${program} ${version} and holds a record this reader has not seen (${KNOWN_CHUNKS[x.id] ? `record ${x.id} at version ${x.v}; it knows version ${KNOWN_CHUNKS[x.id].join(' and ')}` : `record ${x.id}`}) — it reads jobs as ${NIF_SUPPORTED.label} writes them (${NIF_SUPPORTED.testedBuild}). The file may also be damaged. ${exportInstead}`,
          { program, version, supported: NIF_SUPPORTED.label, chunk: x.id, chunkVersion: x.v },
        );
      }
      for (const k of x.kids) todo.push(k);
    }
  }
  // The job's name: a tagged line of the prologue (15 04 name NUL), before the first record.
  let jobName = null;
  {
    const pro = b.subarray(0, Math.min(first.start, 1024)).toString('latin1');
    const m = /\x15\x04([^\x00-\x1f]{1,200})\x00/.exec(pro);
    if (m) jobName = m[1].trim() || null;
  }

  const job = kid(first, 1001);
  if (!job) throw damaged('it holds no job');
  const budget = { points: 0, edges: 0 };
  const notes = [];
  let checks = 0;

  // ---- parts: 1002 = [i32 count], then per part a 1015 record followed by its drawing ----
  const P = kid(job, 1002);
  if (!P) throw damaged('it holds no part list');
  const partNodes = kids(P, 1015);
  {
    const declared = new Cur(b, own(P)[0], 'the part list').i32();
    checks += 1;
    if (declared !== partNodes.length) throw failed('counts', 'the part list', `it says it holds ${declared} parts and holds ${partNodes.length}`);
  }
  const parts = []; const partByRef = new Map();
  for (const node of partNodes) {
    const index = parts.length;
    const { h, c } = readItemHeader(b, node, `part ${index + 1}`);
    const p = {
      index, id: h.id, ref: node.start + 8, sourceFile: h.source, required: h.qty, headerNested: h.qty2, type: h.type,
      material: h.material, thicknessMm: h.thickness * IN, headerDims: [h.dimA * IN, h.dimB * IN], headerAreaIn2: h.areaIn2,
    };
    p.importKind = c.str();
    c.skip(8 + 2 + 4); c.f64(); c.f64(); c.skip(28);
    p.name = c.str();
    const members = c.i32(); c.i32(); c.u16();
    if (!(members >= 0 && members <= 100000)) throw damaged(`part ${index + 1} lists a number of members that is not a number`);
    p.memberRefs = [];
    for (let k = 0; k < members; k++) p.memberRefs.push(c.u32());
    p.isClc = h.source === 'User Defined CLC';                 // a common-line-cut group saved as a part
    p.isCopy = !p.isClc && p.memberRefs.length > 0;            // a derived copy of a real part (ProNest's mirrored placement)
    p.what = `part "${p.name}"`;
    if (!p.isClc && h.type !== 6 && !(p.isCopy && h.type === -1)) {
      throw unsupported(`${called} was written by ${program} ${version} and holds a kind of part this reader has not seen (${p.what}, type ${h.type}) — it reads parts imported from a drawing. ${exportInstead}`, { program, version, supported: NIF_SUPPORTED.label });
    }
    const idx = P.segs.indexOf(node);
    p.stream = Array.isArray(P.segs[idx + 1]) ? P.segs[idx + 1] : null;
    parts.push(p); partByRef.set(p.ref, p);
  }

  /*
   * A real part's drawing. Its ONE outer profile, closed, is the outline. A closed profile inside it
   * is a cut-out — unless it is drawn on the layer of the part's open strokes (the scribed marking
   * text: ProNest reads the closed letters O, B, P … as inner profiles): that is MARKING, counted
   * and left out. One whose layer the file does not give is `unsure`: kept apart, for the caller's
   * marking rule. Open strokes are never part of the shape.
   */
  for (const p of parts) {
    if (p.isClc) continue;                                     // its members are the pieces; its own drawing is never used
    const { paths, layers } = readPaths(b, p.stream, p.what);
    const all = paths.map((q) => flatten(q, true, budget)).filter((q) => q.length > 1);
    if (!all.length) throw failed('part size', p.what, 'it has no drawing');
    const bbLeads = boxOf(all);
    const sizeLeads = [(bbLeads[2] - bbLeads[0]) * IN, (bbLeads[3] - bbLeads[1]) * IN];
    checks += 1;
    const dev = Math.max(Math.abs(sizeLeads[0] - p.headerDims[0]), Math.abs(sizeLeads[1] - p.headerDims[1]));
    if (!(dev <= TOL_SIZE_MM)) throw failed('part size', p.what, `its drawing is ${r4(sizeLeads[0])} × ${r4(sizeLeads[1])} mm and its own header says ${r4(p.headerDims[0])} × ${r4(p.headerDims[1])} mm`, { part: p.name });
    const closed = (q) => { const f = flatten(q, false, budget); return closedGapIn(f) * IN <= TOL_PLATE_MM ? f : null; };
    const ext = paths.filter((q) => q.kind === 'exterior' && q.segs.some((s) => !s.lead));
    if (ext.length !== 1) throw failed('part size', p.what, ext.length ? `it has ${ext.length} outer outlines, and a part has one` : 'it has no outer outline', { part: p.name });
    const outline = closed(ext[0]);
    if (!outline) throw failed('part size', p.what, 'its outer outline is not closed', { part: p.name });
    if (paths.some((q) => q.kind === 'other' && q.segs.some((s) => !s.lead))) throw failed('part size', p.what, 'it holds a cut that belongs to no profile', { part: p.name });
    const strokeLayers = new Set(paths.filter((q) => q.kind === 'open' && q.layer != null).map((q) => q.layer));
    p.outline = outline; p.cutouts = []; p.unsure = []; p.marking = 0; p.markingLayer = null;
    p.strokes = paths.filter((q) => q.kind === 'open').length;
    for (const q of paths.filter((x) => x.kind === 'interior' && x.segs.some((s) => !s.lead))) {
      const ring = closed(q);
      if (!ring) throw failed('part size', p.what, 'an inner profile of it is not closed', { part: p.name });
      if (q.layer != null && ext[0].layer != null && q.layer !== ext[0].layer && strokeLayers.has(q.layer)) { p.marking += 1; p.markingLayer = layers.get(q.layer) || null; }
      else if (q.layer != null && q.layer === ext[0].layer) p.cutouts.push(ring);
      else { p.unsure.push(ring); p.unsureLayer = q.layer != null ? layers.get(q.layer) || null : null; }
    }
    p.all = all;                                               // every path with its leads: what ProNest's own boxes are drawn round
    const bb = boxOf([outline]);
    p.drawn = [(bb[2] - bb[0]) * IN, (bb[3] - bb[1]) * IN];
    const gross = Math.abs(signedArea(outline));
    p.areaIn2 = gross - p.cutouts.reduce((a, r) => a + Math.abs(signedArea(r)), 0);
    // …and its area is the area its header states (the outline's; marking is not steel taken out). A
    // corner moved along an edge leaves the box as it was — the area does not.
    checks += 1;
    const areaTol = Math.max(0.005, 2e-5 * gross);
    if (!(Math.abs(gross - p.headerAreaIn2) <= areaTol || Math.abs(p.areaIn2 - p.headerAreaIn2) <= areaTol)) {
      throw failed('part size', p.what, `its outline encloses ${Math.round(gross * IN * IN)} mm² and its own header says ${Math.round(p.headerAreaIn2 * IN * IN)} mm²`, { part: p.name });
    }
  }

  // ---- plates: 1003/1006 = [i32 count], then per plate a 1011 record followed by its outline ----
  const PL = kid(kid(job, 1003) ?? job, 1006);
  if (!PL) throw damaged('it holds no plate list');
  const plates = []; const plateByRef = new Map();
  for (const node of kids(PL, 1011)) {
    const index = plates.length;
    const what = `plate ${index + 1}`;
    const { h } = readItemHeader(b, node, what);
    const pl = { index, ref: node.start + 8, name: h.source || null, quantity: h.qty, type: h.type, size: [h.dimA * IN, h.dimB * IN], material: h.material, thicknessMm: h.thickness * IN };
    const idx = PL.segs.indexOf(node);
    const { paths } = readPaths(b, Array.isArray(PL.segs[idx + 1]) ? PL.segs[idx + 1] : null, what);
    const polys = paths.map((q) => flatten(q, false, budget)).filter((q) => q.length > 2);
    if (polys.length < 1 || !(closedGapIn(polys[0]) * IN <= TOL_PLATE_MM)) throw failed('part size', what, 'its outline is missing or not closed');
    const bb = boxOf(polys);
    checks += 1;
    const dev = Math.max(Math.abs((bb[2] - bb[0]) * IN - pl.size[0]), Math.abs((bb[3] - bb[1]) * IN - pl.size[1]), Math.abs(bb[0]) * IN, Math.abs(bb[1]) * IN);
    if (!(dev <= TOL_SIZE_MM)) throw failed('part size', what, `its outline is ${r4((bb[2] - bb[0]) * IN)} × ${r4((bb[3] - bb[1]) * IN)} mm and its own header says ${r4(pl.size[0])} × ${r4(pl.size[1])} mm`);
    const ring = cleanRing(polys[0]);
    pl.outline = ring;
    pl.rectangular = polys.length === 1 && paths[0].segs.every((s) => s.t === 'L') && Math.abs(Math.abs(signedArea(ring)) - (bb[2] - bb[0]) * (bb[3] - bb[1])) * IN * IN <= 1;
    plates.push(pl); plateByRef.set(pl.ref, pl);
  }

  // ---- nests: 1004/1007 = [i32 count], each a 1008 ----
  const NL = kid(kid(job, 1004) ?? job, 1007);
  if (!NL) throw damaged('it holds no nest list');
  const nestNodes = kids(NL, 1008);
  {
    const declared = new Cur(b, own(NL)[0], 'the nest list').i32();
    checks += 1;
    if (declared !== nestNodes.length) throw failed('counts', 'the nest list', `it says it holds ${declared} nests and holds ${nestNodes.length}`);
  }
  if (!nestNodes.length) throw invalid('EMPTY_NEST', `${called} is a ProNest job with no nest in it — there is nothing nested to take.`);
  if (nestNodes.length > MAX_NESTS) throw invalid('TOO_BIG', `The job holds ${nestNodes.length} nests — more than this reads (${MAX_NESTS}). Split it into smaller jobs.`);

  const nests = [];
  for (const N of nestNodes) {
    const nestNo = nests.length + 1;
    const where = `nest ${nestNo}`;
    const quantity = u32At(b, own(N)[0], 2, where);
    if (!(quantity >= 1 && quantity <= 100000)) throw failed('counts', where, `it is to be cut ${quantity} times, which is not a quantity`, { nestNo });

    // The plate instance (1009): its box, its matrix, and a reference to the plate.
    const pi = kid(N, 1009);
    if (!pi) throw damaged(`${where} has no plate`);
    const pbox = kid(pi, 1019); const pmat = kid(pi, 1018);
    if (!pbox || !pmat) throw damaged(`the plate of ${where} has no box`);
    const plate = plateByRef.get(u32At(b, own(pi)[2], 12, `the plate of ${where}`));
    checks += 1;
    if (!plate) throw failed('counts', where, 'its plate is not one of the job\'s plates', { nestNo });
    const PW = plate.size[0]; const PH = plate.size[1];
    {
      const bb = [0, 8, 16, 24].map((k) => f64At(b, own(pbox)[0], k, `the plate of ${where}`) * IN);
      const m = []; for (let k = 0; k < 9; k++) m.push(f64At(b, own(pmat)[0], 8 * k, `the plate of ${where}`));
      const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1].every((v, k) => Math.abs(m[k] - v) <= 1e-9);
      checks += 1;
      if (!identity || !(Math.abs(bb[0]) <= TOL_PLATE_MM && Math.abs(bb[1]) <= TOL_PLATE_MM && Math.abs(bb[2] - PW) <= TOL_SIZE_MM && Math.abs(bb[3] - PH) <= TOL_SIZE_MM)) {
        throw failed('inside plate', where, `its plate is not lying at the corner the pieces are measured from (${r4(PW)} × ${r4(PH)} mm expected)`, { nestNo });
      }
    }
    checks += 1;
    if (quantity !== plate.quantity) throw failed('counts', where, `it is to be cut ${quantity} times and its plate is counted ${plate.quantity} times`, { nestNo });

    // What ProNest cached for the nest (optional: it leaves the block empty on some nests).
    let outputFile = null; let utilisationStored = null;
    try {
      const after = N.segs[N.segs.indexOf(kid(N, 1006)) + 1];
      if (Array.isArray(after)) {
        const c = new Cur(b, after, where);
        c.skip(6); outputFile = c.str() || null; c.i32();
        const d = [c.f64(), c.f64()]; c.i32();
        for (let k = 0; k < 4; k++) d.push(c.f64());
        if (d.every(Number.isFinite) && d[2] > 0 && d[3] >= 0) utilisationStored = d[2] / (d[2] + d[3]);
      }
    } catch { outputFile = null; utilisationStored = null; }

    // The pieces: 1055/1054/1053/1005 → 1010 (a named holder) → 1012 (one placed instance);
    // an instance holding 1066/1005 is a common-line-cut group, and its members are the pieces.
    const top = findFirst(N, 1053);
    const group0 = top ? kid(top, 1005) : null;
    if (!group0) throw damaged(`${where} has no list of pieces`);
    const pieces = [];
    let clcGroups = 0;
    const todo = [{ group: group0, depth: 0, clc: null }];
    while (todo.length) {
      const { group, depth, clc } = todo.shift();
      for (const holder of kids(group, 1010)) {
        const hc = new Cur(b, own(holder)[1], `a piece of ${where}`);
        hc.u16(); hc.f64(); hc.f64(); hc.f64(); hc.i32();
        const holderName = hc.str();
        for (const inst of kids(holder, 1012)) {
          const at = `${where}, the piece at byte ${inst.start}`;
          const ibox = kid(inst, 1019); const imat = kid(inst, 1018);
          const tail = own(inst)[2];
          if (!ibox || !imat || !tail) throw damaged(`${at} has no box`);
          const part = partByRef.get(u32At(b, tail, 12, at));
          checks += 1;
          if (!part) throw failed('counts', at, `it refers to a part the job does not hold (in "${holderName}")`, { nestNo });
          const sub = kid(inst, 1066);
          const inner = sub ? kid(sub, 1005) : null;
          if (inner) {
            if (depth + 1 > MAX_CLC_DEPTH) throw damaged(`${where} nests its common-line groups deeper than ProNest does`);
            if (!part.isClc) throw failed('counts', at, `a common-line-cut group refers to ${part.what}, which is not one`, { nestNo });
            clcGroups += 1;
            todo.push({ group: inner, depth: depth + 1, clc: `clc${nestNo}-${clcGroups}` });
            continue;
          }
          if (part.isClc) throw failed('counts', at, `a piece refers to a common-line-cut group ("${part.name}") that it does not hold`, { nestNo });
          // The layout this was tested on: 8 own bytes, the box, 2 bytes, the matrix, then 47 bytes — the stored angle at 2, the part at 12.
          if (tail[1] - tail[0] !== 47) throw unsupported(`${called} was written by ${program} ${version} and stores a placed piece in a layout this reader has not seen (${where}) — it reads jobs as ${NIF_SUPPORTED.label} writes them. ${exportInstead}`, { program, version, supported: NIF_SUPPORTED.label });
          if (pieces.length >= MAX_PIECES) throw invalid('TOO_BIG', `Nest ${nestNo} holds more than ${MAX_PIECES} pieces — more than this reads.`);
          const stored = [0, 8, 16, 24].map((k) => f64At(b, own(ibox)[0], k, at) * IN);
          const m = []; for (let k = 0; k < 9; k++) m.push(f64At(b, own(imat)[0], 8 * k, at));
          const det = m[0] * m[4] - m[1] * m[3];
          const here = `${where}, "${part.name}" at (${r1(stored[0])}, ${r1(stored[1])})`;
          checks += 1;
          if (!m.every(Number.isFinite) || !(Math.abs(Math.abs(det) - 1) <= 1e-6) || !(Math.abs(m[0] * m[3] + m[1] * m[4]) <= 1e-6) || m[2] !== 0 || m[5] !== 0 || m[8] !== 1) {
            throw failed('placement box', here, 'it is placed by something other than a turn, a flip and a move', { nestNo, part: part.name });
          }
          checks += 1;
          if (holderName && baseName(part.sourceFile) !== holderName) throw failed('counts', here, `it is filed under "${holderName}" and its part came from "${baseName(part.sourceFile)}"`, { nestNo, part: part.name });
          // The outline (with its leads, as ProNest draws its boxes), put where the nest places it, is the box the file stores.
          const bb = boxOf(part.all.map((q) => q.map((pt) => applyM(m, pt)))).map((v) => v * IN);
          checks += 1;
          const dev = Math.max(...bb.map((v, k) => Math.abs(v - stored[k])));
          if (!(dev <= TOL_SIZE_MM)) throw failed('placement box', here, `its outline, put where the nest places it, is not the box the file stores for it (${Number.isFinite(dev) ? `${r4(dev)} mm off` : 'not a number'})`, { nestNo, part: part.name });
          checks += 1;
          if (!(stored[0] >= -TOL_PLATE_MM && stored[1] >= -TOL_PLATE_MM && stored[2] <= PW + TOL_PLATE_MM && stored[3] <= PH + TOL_PLATE_MM)) {
            throw failed('inside plate', here, `it lies outside its plate, which is ${r4(PW)} × ${r4(PH)} mm`, { nestNo, part: part.name });
          }
          const to = (ring) => cleanRing(ring.map((pt) => applyM(m, pt).map((v) => v * IN)));
          const outline = to(part.outline);
          if (outline.length < 3) throw failed('part size', here, 'its outline has no area', { nestNo, part: part.name });
          const ob = boxOf([outline]);
          pieces.push({
            part, stored, outline, cutouts: part.cutouts.map(to), unsure: part.unsure.map(to), box: ob,
            rotationDeg: ((Math.atan2(m[1], m[0]) * 180) / Math.PI + 360) % 360, mirrored: det < 0, clcGroup: clc,
          });
        }
      }
    }
    if (!pieces.length) notes.push(`Nest ${nestNo} holds no piece.`);

    // No two pieces overlap: boxes first, then the outlines themselves.
    checks += 1;
    for (let i = 0; i < pieces.length; i++) {
      const A = pieces[i];
      for (let j = i + 1; j < pieces.length; j++) {
        const B = pieces[j];
        if (A.box[2] <= B.box[0] + 0.01 || B.box[2] <= A.box[0] + 0.01 || A.box[3] <= B.box[1] + 0.01 || B.box[3] <= A.box[1] + 0.01) continue;
        if (piecesOverlap(A, B, budget)) throw failed('overlap', where, `"${A.part.name}" at (${r1(A.box[0])}, ${r1(A.box[1])}) and "${B.part.name}" at (${r1(B.box[0])}, ${r1(B.box[1])}) overlap`, { nestNo });
      }
    }

    const steel = pieces.reduce((a, q) => a + q.part.areaIn2 * IN * IN, 0);
    const used = pieces.length ? [Math.min(...pieces.map((q) => q.box[0])), Math.min(...pieces.map((q) => q.box[1])), Math.max(...pieces.map((q) => q.box[2])), Math.max(...pieces.map((q) => q.box[3]))] : null;
    nests.push({ nestNo, quantity, plate, pieces, clcGroups, outputFile, utilisationStored, steel, used });
  }

  // ---- what is nested, counted, is what the part headers say ----------------------
  for (const p of parts) p.nested = 0;
  for (const n of nests) for (const q of n.pieces) q.part.nested += n.quantity;
  // A mirrored placement is a SECOND part record with the same drawing: it counts for the first.
  const firstBySource = new Map(); const real = [];
  for (const p of parts) {
    if (p.isClc) continue;
    const of = (p.isCopy && partByRef.get(p.memberRefs[0])) || firstBySource.get(p.sourceFile) || null;
    if (of && of !== p && !of.isClc) { p.copyOf = of; of.nested += p.nested; of.copies = (of.copies ?? 0) + (p.nested > 0 ? 1 : 0); of.copyPieces = (of.copyPieces ?? 0) + p.nested; }
    else { firstBySource.set(p.sourceFile, p); real.push(p); }
  }
  for (const p of real) {
    checks += 1;
    if (!(p.nested <= p.required)) throw failed('counts', p.what, `${p.nested} are nested and only ${p.required} are required`, { part: p.name });
    if (p.nested !== p.headerNested) throw failed('counts', p.what, `${p.nested} are nested, counted, and its own header says ${p.headerNested}`, { part: p.name });
  }

  // ---- out ---------------------------------------------------------------------
  const ring = (r) => r.map(([x, y]) => [r4(x), r4(y)]);
  const problems = [];
  const outNests = nests.map((n) => {
    const PW = n.plate.size[0]; const PH = n.plate.size[1];
    const nestProblems = [];
    if (!n.plate.rectangular) nestProblems.push({ code: 'PLATE_NOT_RECTANGLE', nestNo: n.nestNo, message: `nest ${n.nestNo} is cut from a plate that is not a rectangle (a remnant, perhaps) — only whole rectangular plates are read.` });
    problems.push(...nestProblems);
    return {
      nestNo: n.nestNo, quantity: n.quantity,
      plate: { length: r4(PW), width: r4(PH), outline: ring(n.plate.outline.map(([x, y]) => [x * IN, y * IN])), rectangular: n.plate.rectangular, material: n.plate.material || null, thickness: r4(n.plate.thicknessMm), name: n.plate.name },
      parts: n.pieces.map((q, i) => {
        const holes = []; const cutouts = [];
        for (const c of q.cutouts) { const d = circleDia(c); (d != null && d <= DRILL_MAX_DIA_MM + 1e-6 ? holes : cutouts).push(ring(c)); }
        return {
          id: `P${i + 1}`, partId: q.part.id, name: q.part.name, sourceFile: q.part.sourceFile, requiredQty: (q.part.copyOf ?? q.part).required,
          rings: { outline: ring(q.outline), cutouts, holes },
          ...(q.unsure.length ? { unsure: q.unsure.map(ring), unsureLayer: q.part.unsureLayer ?? null } : {}),
          bbox: { x: r4(q.box[0]), y: r4(q.box[1]), length: r4(q.box[2] - q.box[0]), width: r4(q.box[3] - q.box[1]) },
          x: r4(q.box[0]), y: r4(q.box[1]), rotationDeg: r4(q.rotationDeg) % 360, mirrored: q.mirrored,
          area: r4(q.part.areaIn2 * IN * IN), drawn: [r4(q.part.drawn[0]), r4(q.part.drawn[1])], marking: q.part.marking, clcGroup: q.clcGroup,
        };
      }),
      pieces: n.pieces.length, clcGroups: n.clcGroups,
      utilisation: PW * PH > 0 ? n.steel / (PW * PH) : null, utilisationStored: n.utilisationStored,
      usedExtent: n.used ? n.used.map(r4) : null,
      minEdgeMargin: n.used ? r4(Math.min(n.used[0], n.used[1], PW - n.used[2], PH - n.used[3])) : null,
      outputFile: n.outputFile, problems: nestProblems,
    };
  });
  const jobThickness = nests[0]?.plate.thicknessMm ?? null;
  const partsList = real.map((p) => {
    const said = nifNameFacts(p.name, jobThickness != null ? r4(jobThickness) : null);
    return {
      partId: p.id, name: p.name, sourceFile: p.sourceFile, required: p.required, nested: p.nested, notNested: p.required - p.nested,
      thickness: r4(p.thicknessMm), material: p.material || null, drawn: [r4(p.drawn[0]), r4(p.drawn[1])],
      nameSize: said.size, nameQuantity: said.quantity, nameThickness: said.thickness, mirroredCopies: p.copyPieces ?? 0, marking: p.marking,
    };
  });

  // Notes: what a person would want to know, none of it wrong with the file.
  const clcTotal = nests.reduce((a, n) => a + n.clcGroups, 0);
  const placements = nests.reduce((a, n) => a + n.pieces.length, 0);
  const mirrored = nests.reduce((a, n) => a + n.pieces.filter((q) => q.mirrored).length, 0);
  if (clcTotal) notes.push(`${plural(clcTotal, 'common-line-cut group was', 'common-line-cut groups were')} opened into ${clcTotal === 1 ? 'its' : 'their'} pieces: each piece is read on its own, where the group has it.`);
  if (mirrored) notes.push(`${plural(mirrored, 'piece is', 'pieces are')} nested mirrored (ProNest keeps a mirrored copy as a part of its own; it is counted with its part).`);
  const marked = real.filter((p) => p.marking > 0);
  if (marked.length) notes.push(`${plural(marked.reduce((a, p) => a + p.marking, 0), 'closed shape', 'closed shapes')} inside ${plural(marked.length, 'part', 'parts')} ${marked.length === 1 ? 'is' : 'are'} drawn on the layer of the marking strokes${marked[0].markingLayer ? ` (${marked[0].markingLayer})` : ''} — scribed letters, read as marking and not as cut-outs.`);
  const few = (xs, f) => `${xs.slice(0, 4).map(f).join('; ')}${xs.length > 4 ? `; and ${xs.length - 4} more` : ''}`;
  const off = partsList.filter((p) => p.nameSize && !((Math.abs(Math.max(...p.drawn) - Math.max(...p.nameSize)) <= 1) && (Math.abs(Math.min(...p.drawn) - Math.min(...p.nameSize)) <= 1)));
  if (off.length) notes.push(`${plural(off.length, 'part is', 'parts are')} drawn another size than the name says: ${few(off, (p) => `"${p.name}" is drawn ${r1(Math.max(...p.drawn))} × ${r1(Math.min(...p.drawn))}`)}. The outline is what is nested; the name is the shop's label.`);
  const thin = partsList.filter((p) => p.nameThickness != null && Math.abs(p.nameThickness - p.thickness) > 0.01);
  if (thin.length) notes.push(`${plural(thin.length, 'part is', 'parts are')} named another thickness than the plate ${thin.length === 1 ? 'it is' : 'they are'} nested on: ${few(thin, (p) => `"${p.name}" on ${r4(p.thickness)} mm`)}.`);
  const short = partsList.filter((p) => p.notNested > 0);
  if (short.length) notes.push(`${plural(short.length, 'part is', 'parts are')} not nested in full: ${few(short, (p) => `"${p.name}" ${p.nested} of ${p.required}`)}.`);

  return {
    program, version, application, jobName, units: 'in',
    nests: outNests, partsList,
    counts: {
      nests: nests.length, plates: nests.reduce((a, n) => a + n.quantity, 0), parts: real.length, placements,
      pieces: nests.reduce((a, n) => a + n.pieces.length * n.quantity, 0), clcGroups: clcTotal, mirrored, checks,
    },
    notes, problems,
  };
}

/* ───────────────────────────── as the nesting upload reads a nest ───────────────────────────── */

/**
 * One nest of a job in the form lib/nestDxfReader.readNestDxf returns — so the upload matches,
 * places, checks and stores it by the same code as a customer's DXF plate. What is different is
 * said on the part: `outlineOnly` (a ProNest part is matched by its OUTLINE — the shop drills holes
 * later, so the nesting has none), `labelFrom: 'name'` (its label is the shop's free-text part
 * name), `nameSize` / `nameThickness` (what that name says), `clcGroup`.
 */
export function nestOfNif(doc, nest) {
  const t = nest.plate.thickness;
  return {
    units: 'in', unitsStated: true,
    plate: { length: nest.plate.length, width: nest.plate.width, outline: nest.plate.outline, origin: [0, 0], found: 'outline' },
    plates: 1,
    parts: nest.parts.map((p) => {
      const said = nifNameFacts(p.name, t);
      const rings = p.unsure?.length ? { outline: p.rings.outline, cutouts: [...p.rings.cutouts, ...p.unsure], holes: p.rings.holes } : p.rings;
      return {
        id: p.id, rings, bbox: p.bbox, area: p.area,
        ...(p.unsure?.length ? { ringsNoMarks: p.rings, areaNoMarks: p.area, unsureMarks: p.unsure.length, unsureStyle: p.unsureLayer ? `layer ${p.unsureLayer}` : 'a layer the job does not name' } : {}),
        labels: [p.name], labelFrom: 'name', layer: null, within: null, commonCut: 0, outsidePlate: false, outsideMm: 0,
        outlineOnly: true, nameSize: said.size, nameThickness: said.thickness, drawnSize: p.drawn ?? null, clcGroup: p.clcGroup ?? null, sourcePartId: p.partId, partName: p.name,
      };
    }),
    texts: [],
    hints: { thicknessMm: t, grade: null, nestNo: null, plateSize: null, from: { thicknessMm: 'job', grade: null, plateSize: null } },
    offcuts: [], skeleton: null, outside: [], splitStyles: [], markingStyles: [], closedGaps: 0,
    problems: nest.problems.map(({ code, message }) => ({ code, message })), cautions: [], warnings: [],
  };
}

export const _test = { parseTree, KNOWN_CHUNKS, KNOWN_TOKENS };
