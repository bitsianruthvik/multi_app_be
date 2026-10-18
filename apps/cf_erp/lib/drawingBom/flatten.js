// Stage 2: flatten model space. Every INSERT is exploded (recursively) into world coordinates.
// Output primitives:
//   geometry  { k:'L'|'A'|'C'|'P', layer, path, g, ... }   (path = chain of block names)
//   text      { k:'T', src:'TEXT'|'MTEXT'|'MLEADER'|'DIM', text, x, y, h, rot, layer, path, g, leader?:[[x,y]...] }
//   insert    { k:'I', name, x, y, M, layer, path, g }
// Dimension blocks are NOT exploded into geometry (their lines would pollute part outlines); a
// dimension becomes one text record with its measured value and definition points.
const mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
const ap = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const det = (m) => m[0] * m[3] - m[1] * m[2];

export const cleanText = (s) => String(s ?? '')
  .replace(/\\P/g, '\n').replace(/\\~/g, ' ')
  .replace(/\\[A-Za-z][^;\\\n]*;/g, '').replace(/\\[LlOoKk]/g, '')
  .replace(/[{}]/g, '').replace(/\\\\/g, '\\')
  .replace(/%%[cC]/g, 'Ø').replace(/%%[dD]/g, '°').replace(/%%[pP]/g, '±')
  .split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');

export function flatten(db) {
  const byName = new Map((db.tables?.BLOCK_RECORD?.entries ?? []).map((b) => [b.name, b]));
  const out = [];
  let G = 0;
  function walk(ents, m, pathS, inheritLayer, depth) {
    for (const e of ents) {
      if (e.isVisible === false) continue;
      const layer = (e.layer === '0' && inheritLayer != null) ? inheritLayer : e.layer;
      const neg = e.extrusionDirection && e.extrusionDirection.z < 0;
      const M = neg ? mul(m, [-1, 0, 0, 1, 0, 0]) : m;
      const k = Math.sqrt(Math.abs(det(M))) || 1;
      const mirror = det(M) < 0;
      const base = { layer, path: pathS, g: G, lt: e.lineType };
      const arc = (cx, cy, r, a0, a1, full) => {
        const c = ap(M, cx, cy);
        if (full) { out.push({ ...base, k: 'C', x: c[0], y: c[1], r: r * k }); return; }
        const A = ap(M, cx + r * Math.cos(a0), cy + r * Math.sin(a0));
        const B = ap(M, cx + r * Math.cos(a1), cy + r * Math.sin(a1));
        const ang = (p) => Math.atan2(p[1] - c[1], p[0] - c[0]);
        // counter-clockwise from a0 to a1 after the transform
        out.push({ ...base, k: 'A', x: c[0], y: c[1], r: r * k, a0: mirror ? ang(B) : ang(A), a1: mirror ? ang(A) : ang(B) });
      };
      switch (e.type) {
        case 'LINE': { const a = ap(M, e.startPoint.x, e.startPoint.y), b = ap(M, e.endPoint.x, e.endPoint.y); out.push({ ...base, k: 'L', x1: a[0], y1: a[1], x2: b[0], y2: b[1] }); break; }
        case 'CIRCLE': arc(e.center.x, e.center.y, e.radius, 0, 0, true); break;
        case 'ARC': arc(e.center.x, e.center.y, e.radius, e.startAngle, e.endAngle, false); break;
        case 'LWPOLYLINE': {
          const pts = (e.vertices ?? []).map((v) => { const p = ap(M, v.x, v.y); return [p[0], p[1], (v.bulge || 0) * (mirror ? -1 : 1)]; });
          if (pts.length >= 2) out.push({ ...base, k: 'P', pts, closed: !!(e.flag & 1) || !!(e.flag & 512) });
          break;
        }
        case 'TEXT': {
          const al = (e.halign || e.valign) && e.endPoint && (e.endPoint.x || e.endPoint.y);
          const p0 = al ? e.endPoint : e.startPoint; const p = ap(M, p0.x, p0.y);
          const t = cleanText(e.text); if (!t) break;
          out.push({ ...base, k: 'T', src: 'TEXT', x: p[0], y: p[1], h: (e.textHeight || 0) * k, rot: (e.rotation || 0) + Math.atan2(M[1], M[0]), text: t });
          break;
        }
        case 'MTEXT': {
          const p = ap(M, e.insertionPoint.x, e.insertionPoint.y);
          const t = cleanText(e.text); if (!t) break;
          const r = e.direction ? Math.atan2(e.direction.y, e.direction.x) : (e.rotation || 0);
          out.push({ ...base, k: 'T', src: 'MTEXT', x: p[0], y: p[1], h: (e.textHeight || 0) * k, rot: r + Math.atan2(M[1], M[0]), text: t, w: (e.rectWidth || e.width || 0) * k });
          break;
        }
        case 'MULTILEADER': {
          const t = cleanText(e.textContent);
          const leader = [];
          for (const sec of e.leaderSections ?? []) {
            for (const ll of sec.leaderLines ?? []) for (const v of ll.vertices ?? []) leader.push(ap(M, v.x, v.y));
            if (sec.lastLeaderLinePoint) leader.push(ap(M, sec.lastLeaderLinePoint.x, sec.lastLeaderLinePoint.y));
          }
          const a = e.textAnchor ?? e.contentBasePosition;
          if (t && a) { const p = ap(M, a.x, a.y); out.push({ ...base, k: 'T', src: 'MLEADER', x: p[0], y: p[1], h: (e.textHeight || 0) * k, rot: 0, text: t, leader }); }
          break;
        }
        case 'DIMENSION': {
          const tp = e.textPoint || e.definitionPoint; if (!tp) break;
          const p = ap(m, tp.x, tp.y);
          const meas = e.measurement;
          const ovr = cleanText(e.text);
          const mv = meas != null ? String(Math.round(meas * 10) / 10) : '';
          const t = ovr ? ovr.replace(/<>/g, mv) : mv;
          const dp = {};
          for (const key of ['definitionPoint', 'subDefinitionPoint1', 'subDefinitionPoint2']) if (e[key]) dp[key] = ap(m, e[key].x, e[key].y);
          out.push({ ...base, k: 'T', src: 'DIM', x: p[0], y: p[1], h: 0, rot: 0, text: t, meas, dimType: e.dimensionType & 7, dp, scale: Math.sqrt(Math.abs(det(m))) || 1 });
          break;
        }
        case 'INSERT': {
          const b = byName.get(e.name); if (!b || depth >= 12) break;
          const c = Math.cos(e.rotation || 0), s = Math.sin(e.rotation || 0);
          const xs = e.xScale ?? 1, ys = e.yScale ?? 1;
          let loc = [c * xs, s * xs, -s * ys, c * ys, e.insertionPoint.x, e.insertionPoint.y];
          const bp = b.basePoint || { x: 0, y: 0 };
          loc = mul(loc, [1, 0, 0, 1, -bp.x, -bp.y]);
          const MM = mul(M, loc);
          const p = ap(M, e.insertionPoint.x, e.insertionPoint.y);
          out.push({ ...base, k: 'I', name: e.name, x: p[0], y: p[1], M: MM });
          walk(b.entities || [], MM, pathS ? pathS + '>' + e.name : e.name, layer, depth + 1);
          break;
        }
        default: break;
      }
      if (depth === 0) G++;
    }
  }
  walk(db.entities ?? [], [1, 0, 0, 1, 0, 0], '', null, 0);
  return out;
}
