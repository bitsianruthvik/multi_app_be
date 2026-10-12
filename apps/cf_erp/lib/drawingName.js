/**
 * drawingName.js — what a drawing's FILE NAME says about which rows it is for
 * (CF_ERP_LINKED_COPIES_PLAN.md: "file names with brackets as an explicit route").
 *
 * A row of an order has no code until its line is frozen; the screen shows the code its pieces
 * WILL get, with the numbers each # stands for in brackets (placeholderService.segmentsOf, printed
 * by the frontend's lib/codeSegments.ts):
 *
 *     SO260002-CG(1,2,3)-L4        up to six numbers, listed
 *     IDP(1–16)                    more than six, as a range (an en dash; a hyphen reads the same)
 *
 * A drawing named by that text — or by its end: `L(1,5)-1-TFL1.dxf`, `L(2-4)-1-TFL1.dxf` — belongs
 * to every row whose code ENDS with it. That is all this file does: it reads the name
 * (parseDrawingName) and matches it against codes (matchCodePattern). Pure; no database.
 *
 * THE GRAMMAR
 *     name    := token (sep token)*          sep := spaces, '_' or '-' (several count as one)
 *     token   := (letters | digits | NUMS)+
 *     NUMS    := '(' item (',' item)* ')'
 *     item    := INT | INT ('-' | '–') INT   — a range, both ends included
 * Letters compare without case. DIGITS ARE NUMBERS: `TFL1` is the letters TFL and the number 1, so
 * `L(1,5)` reaches a row printed `L(1,2,3,4,5)` (they share a number), a frozen piece `L5`, and a
 * row printed `L05`. A token must match a whole token of the code — `FL1` never matches `TFL1` —
 * and the name must match the END of the code at a token boundary.
 *
 * HINTS. `TFL1_25mm_E350.dxf` also says a thickness and a grade: tokens set off by '_' or a space
 * that read as one (nestDxfReader.nameTokenHints) are taken out of the name before it is matched,
 * and handed back as `hints`. The first token is never a hint — a name is a mark or a code first.
 *
 * THE MARK, AS BEFORE. A name is still tried as a DRAWING MARK after its code: `markFull` is the
 * whole name the way partDrawingService.normMark writes one, `markStripped` the same without the
 * hint tokens (`TFL1_25mm_E350` finds the rows marked TFL1).
 */
import { nameTokenHints } from './nestDxfReader.js';

/** partDrawingService.normMark — kept here too so this file needs nothing from a service. */
const normMark = (s) => String(s ?? '').replace(/\.(dxf|pdf)$/i, '').trim().replace(/[\s_-]+/g, '-').toUpperCase();

const MAX_LISTED = 6;   // lib/codeSegments.ts
/** One # as the frontend prints it between its brackets. */
export function numbersText(seg) {
  if (seg.values && seg.values.length <= MAX_LISTED) return seg.values.join(',');
  return seg.from === seg.to ? String(seg.from) : `${seg.from}–${seg.to}`;
}
/** A code with the numbers each # stands for — lib/codeSegments.ts codeWithNumbers, to the character. */
export function codeWithNumbers(code, segments) {
  if (!segments?.length) return code ?? '';
  return segments.map((s) => (s.text != null ? s.text : `(${numbersText(s)})`)).join('');
}

const isSep = (ch) => /[\s_\-–—/\\.,;:#]/.test(ch);

/**
 * A code or a name cut into tokens of atoms: { a: 'TFL' } letters, { n: [[lo, hi], …] } numbers
 * (`many`: it came from brackets). Problems (an unclosed bracket, a bad item) go into `problems`.
 */
export function tokenise(text, problems = []) {
  const s = String(text ?? '');
  const tokens = [];
  let cur = [];
  const close = () => { if (cur.length) tokens.push(cur); cur = []; };
  for (let i = 0; i < s.length;) {
    const ch = s[i];
    if (ch === '(') {
      const j = s.indexOf(')', i);
      if (j < 0) { problems.push('A bracket is opened and never closed.'); break; }
      const ranges = [];
      for (const raw of s.slice(i + 1, j).split(',')) {
        const item = raw.trim();
        const m = /^(\d+)(?:\s*[-–]\s*(\d+))?$/.exec(item);
        if (!m) { problems.push(item === '' ? 'A bracket holds an empty number — write (1,5) or (2-4).' : `"${item}" between brackets is not a number or a range — write (1,5) or (2-4).`); continue; }
        const lo = Number(m[1]); const hi = m[2] != null ? Number(m[2]) : lo;
        if (hi < lo) { problems.push(`The range ${item} runs backwards — write ${hi}-${lo}.`); continue; }
        ranges.push([lo, hi]);
      }
      if (ranges.length) cur.push({ n: ranges, many: true });
      i = j + 1;
      continue;
    }
    if (ch === ')') { problems.push('A bracket is closed that was never opened.'); i += 1; continue; }
    if (/\d/.test(ch)) {
      let j = i; while (j < s.length && /\d/.test(s[j])) j += 1;
      const v = Number(s.slice(i, j));
      cur.push({ n: [[v, v]] });
      i = j;
      continue;
    }
    if (isSep(ch)) { close(); i += 1; continue; }
    let j = i; while (j < s.length && !/[\d()]/.test(s[j]) && !isSep(s[j])) j += 1;
    cur.push({ a: s.slice(i, j).toUpperCase() });
    i = j;
  }
  close();
  return tokens;
}

const overlap = (x, y) => x.some(([a, b]) => y.some(([c, d]) => a <= d && c <= b));
const covers = (x, y) => y.every(([c, d]) => { for (let v = c; v <= d && v - c < 5000; v++) if (!x.some(([a, b]) => a <= v && v <= b)) return false; return true; });

/** One token of the name against one token of a code: null, or { partial } (the name names only some of the numbers a # runs over). */
function tokenMatch(p, r) {
  if (p.length !== r.length) return null;
  let partial = false;
  for (let i = 0; i < p.length; i++) {
    const x = p[i]; const y = r[i];
    if ((x.a != null) !== (y.a != null)) return null;
    if (x.a != null) { if (x.a !== y.a) return null; continue; }
    if (!overlap(x.n, y.n)) return null;
    if (y.many && !covers(x.n, y.n)) partial = true;
  }
  return { partial };
}

/** A name's tokens against the END of a code's tokens. */
function suffixMatch(pattern, tokens) {
  if (!pattern.length || pattern.length > tokens.length) return null;
  let partial = false;
  const at = tokens.length - pattern.length;
  for (let i = 0; i < pattern.length; i++) {
    const m = tokenMatch(pattern[i], tokens[at + i]);
    if (!m) return null;
    if (m.partial) partial = true;
  }
  return { partial };
}

/**
 * Reads a file name.
 * → { kind: 'code' | 'plain' | 'empty',   'code' = it has brackets: it can only be a code
 *     base,            the name without its ending and its hint tokens
 *     pattern,         its tokens (tokenise), or null when the brackets do not read
 *     markFull,        the whole name as a drawing mark (normMark)
 *     markStripped,    the same without the hint tokens (null when there were none)
 *     hints: { thicknessMm, grade },
 *     problems: [] }
 */
export function parseDrawingName(name) {
  const file = String(name ?? '').split(/[\\/]/).pop().trim();
  const whole = file.replace(/\.(dxf|pdf)$/i, '').trim();
  const h = nameTokenHints(whole);
  const base = h.rest.length ? h.restText : whole;
  const problems = [];
  const pattern = tokenise(base, problems);
  const brackets = /[()]/.test(base);
  return {
    kind: !whole ? 'empty' : brackets ? 'code' : 'plain',
    base,
    pattern: problems.length || !pattern.length ? null : pattern,
    markFull: normMark(whole),
    markStripped: h.hintTokens.length && h.rest.length ? normMark(base) : null,
    hints: { thicknessMm: h.thicknessMm, grade: h.grade },
    problems,
  };
}

/**
 * Which rows a name's pattern reaches.
 *   pattern   parseDrawingName(...).pattern
 *   rows      [{ id, texts: [code as printed] }] — before the line is frozen ONE text per row, the
 *             code with its brackets (codeWithNumbers); after, the real code of each of its pieces.
 * → [{ id, partial, matched, of }] for the rows reached: `matched` of its `of` texts match;
 *   `partial` — the name names only some of the row's pieces (some numbers of a #, or some of its
 *   piece codes). The drawing still goes on the whole row (decision D5); the caller says so.
 */
export function matchCodePattern(pattern, rows) {
  const out = [];
  if (!pattern?.length) return out;
  for (const row of rows) {
    let matched = 0; let partial = false;
    for (const text of row.texts ?? []) {
      const m = suffixMatch(pattern, row.tokens?.get?.(text) ?? tokenise(text));
      if (!m) continue;
      matched += 1;
      if (m.partial) partial = true;
    }
    if (!matched) continue;
    const of = (row.texts ?? []).length;
    out.push({ id: row.id, partial: partial || matched < of, matched, of });
  }
  return out;
}

/**
 * A file name for a row, the way the new logic reads one back: the END of its printed code from
 * `fromToken` on (0 = the whole code), tokens joined with '-', then the hints (`_25mm_E350`).
 * `text` is the code as printed (codeWithNumbers). Reading the answer with parseDrawingName and
 * matching it against the same code always finds the row.
 */
/**
 * The numbers of one bracket as a FILE NAME writes them (user, 2026-10-12): a run of THREE or more
 * consecutive numbers is a range with an en dash, as the code preview prints one — (1,2,3,4,5) →
 * 1–5, (8,9,10,12) → 8–10,12, (1,2,4,5,6,8) → 1,2,4–6,8; two in a row stay listed (1,2). File names
 * only: the grid's code preview is printed by the frontend and is not changed by this.
 */
export function fileNumbers(values) {
  const v = [...new Set(values.map(Number))].sort((a, b) => a - b);
  const runs = [];
  for (const x of v) { const last = runs[runs.length - 1]; if (last && x === last[last.length - 1] + 1) last.push(x); else runs.push([x]); }
  return runs.map((r) => (r.length >= 3 ? `${r[0]}–${r[r.length - 1]}` : r.join(','))).join(',');
}
/** One printed token with every bracket rewritten the file-name way. */
export function fileToken(part) {
  return String(part).replace(/\(([^)]*)\)/g, (whole, inner) => {
    const values = [];
    for (const raw of inner.split(',')) {
      const m = /^\s*(\d+)(?:\s*[-–]\s*(\d+))?\s*$/.exec(raw);
      if (!m) return whole;
      const lo = Number(m[1]); const hi = m[2] != null ? Number(m[2]) : lo;
      if (hi < lo || hi - lo > 5000) return whole;
      for (let x = lo; x <= hi; x++) values.push(x);
    }
    return values.length ? `(${fileNumbers(values)})` : whole;
  });
}
export function fileNameFor(text, { skipTokens = 0, thicknessMm = null, grade = null, ext = 'dxf' } = {}) {
  const parts = splitPrinted(text).slice(skipTokens).map(fileToken);
  let name = parts.join('-');
  if (thicknessMm != null && Number.isFinite(Number(thicknessMm))) name += `_${Number(thicknessMm)}mm`;
  if (grade) name += `_${String(grade).replace(/[\s_]+/g, '')}`;
  return `${name}.${ext}`;
}

/** A printed code cut at its separators, brackets kept whole: 'SO1-CG(1,2)-L4' → ['SO1', 'CG(1,2)', 'L4']. */
export function splitPrinted(text) {
  const s = String(text ?? '');
  const out = [];
  let cur = ''; let depth = 0;
  for (const ch of s) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if (!depth && ch !== ')' && isSep(ch)) { if (cur) out.push(cur); cur = ''; } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}
