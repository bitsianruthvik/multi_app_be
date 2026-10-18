// Find the sheets in model space. House style: every sheet has a title block at its bottom right
// with a drawing number ending "/NN" (e.g. "PFPL/NECL-PATNA/48M SPAN/03") and a sheet title just
// above it. The sheet frame is the long horizontal border line under the title block.
// Model space holds several sheets drawn at different scales, so nothing here assumes a size.

const DWG_NO = /^[A-Z]{2,}[A-Z0-9 .\-]*\/.*\/\s*\d{1,2}$/i;   // .../01
const TITLE_HINT = /(DETAIL|ELEVATION|PLAN|LAYOUT|SECTION|SPLICE|DIAPHRAGM|GIRDER|FRAME|ARRESTOR|STOPPER|BRACING)/i;

export function findSheets(flat) {
  const segs = [];
  for (const o of flat) {
    if (o.k === 'L') segs.push([o.x1, o.y1, o.x2, o.y2]);
    else if (o.k === 'P') for (let i = 1; i < o.pts.length + (o.closed ? 1 : 0); i++) { const a = o.pts[i - 1], b = o.pts[i % o.pts.length]; segs.push([a[0], a[1], b[0], b[1]]); }
  }
  const H = segs.filter((s) => Math.abs(s[1] - s[3]) < 1e-3).map((s) => ({ y: s[1], x0: Math.min(s[0], s[2]), x1: Math.max(s[0], s[2]) }));
  const V = segs.filter((s) => Math.abs(s[0] - s[2]) < 1e-3).map((s) => ({ x: s[0], y0: Math.min(s[1], s[3]), y1: Math.max(s[1], s[3]) }));
  const texts = flat.filter((o) => o.k === 'T' && o.src !== 'DIM');
  const anchors = texts.filter((t) => DWG_NO.test(t.text.trim()) && t.h > 0);
  const sheets = [];
  for (const a of anchors) {
    const h = a.h;
    // bottom border: below the anchor, spanning it, title block on its right part; frame width 150..500 x text height
    const cand = H.filter((l) => l.y < a.y && a.y - l.y < 60 * h && l.x0 < a.x && l.x1 > a.x
      && (l.x1 - l.x0) > 150 * h && (l.x1 - l.x0) < 500 * h && (l.x1 - a.x) < 0.4 * (l.x1 - l.x0))
      .sort((p, q) => (a.y - p.y) - (a.y - q.y) || (q.x1 - q.x0) - (p.x1 - p.x0));
    // take the lowest of the candidate lines that share the longest span (the frame, not a title-block row)
    const longest = cand.reduce((m, l) => Math.max(m, l.x1 - l.x0), 0);
    const bottom = cand.filter((l) => l.x1 - l.x0 > 0.97 * longest).sort((p, q) => p.y - q.y)[0];
    if (!bottom) continue;
    const width = bottom.x1 - bottom.x0;
    const side = V.filter((v) => (Math.abs(v.x - bottom.x0) < 3 * h || Math.abs(v.x - bottom.x1) < 3 * h) && Math.abs(v.y0 - bottom.y) < 3 * h && (v.y1 - v.y0) > 0.4 * width && (v.y1 - v.y0) < 1.2 * width);
    const top = side.length ? Math.max(...side.map((v) => v.y1)) : bottom.y + width / 1.414;
    // sheet number "NN" and title: the nearest title-like text just above the drawing number
    const no = a.text.trim();
    const num = Number(no.match(/(\d{1,2})\s*$/)[1]);
    const title = texts.filter((t) => t !== a && t.y > a.y && t.y - a.y < 8 * h && Math.abs(t.x - a.x) < 40 * h && TITLE_HINT.test(t.text) && !DWG_NO.test(t.text) && t.text.length < 160)
      .sort((p, q) => (p.y - a.y) - (q.y - a.y))[0];
    sheets.push({ no, num, x0: bottom.x0, x1: bottom.x1, y0: bottom.y, y1: top, textH: h, title: title ? title.text.replace(/\n/g, ' ') : null, framedBy: side.length ? 'lines' : 'aspect' });
  }
  // the same sheet found twice (duplicated title text) -> keep one
  // (prefer the anchor that has a title above it, then a two-digit sheet number)
  const uniq = [];
  const pref = (s) => (s.title ? 0 : 2) + (/\/\s*\d{2}$/.test(s.no) ? 0 : 1);
  for (const s of [...sheets].sort((p, q) => pref(p) - pref(q) || p.num - q.num || p.x0 - q.x0)) if (!uniq.some((u) => Math.abs(u.x0 - s.x0) < 1 && Math.abs(u.y0 - s.y0) < 1)) uniq.push(s);
  return uniq.sort((p, q) => p.num - q.num || p.x0 - q.x0);
}

export function sheetOf(sheets, x, y) {
  const inside = sheets.filter((s) => x >= s.x0 && x <= s.x1 && y >= s.y0 && y <= s.y1);
  // nested sheets (a small sheet drawn inside a big frame): the smallest wins
  return inside.sort((p, q) => (p.x1 - p.x0) * (p.y1 - p.y0) - (q.x1 - q.x0) * (q.y1 - q.y0))[0] ?? null;
}
