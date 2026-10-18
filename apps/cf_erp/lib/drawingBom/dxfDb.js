// An ASCII DXF read into the shape the extractor reads (LibreDWG's converted database: `entities`,
// `tables.BLOCK_RECORD.entries[{ name, basePoint, entities }]`, `tables.LAYER.entries[{ name, lineType }]`).
// Only what flatten.js uses: LINE, CIRCLE, ARC, LWPOLYLINE, POLYLINE (+VERTEX), TEXT, MTEXT, DIMENSION, INSERT.
// Angles become radians (LibreDWG's unit). Pure: text in, object out. Binary DXF is refused.

const RAD = Math.PI / 180;

function pairsOf(text) {
  const lines = String(text).split(/\r?\n/);
  const out = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = Number(lines[i].trim());
    if (!Number.isFinite(code)) { i -= 1; continue; }
    out.push([code, lines[i + 1].replace(/\s+$/, '')]);
  }
  return out;
}

const n = (v, d = 0) => { const x = Number(v); return Number.isFinite(x) ? x : d; };

/** One entity's group codes -> the LibreDWG-shaped object (or null for a kind flatten does not use). */
function entityOf(type, codes) {
  const g = (c, d) => { const p = codes.find((x) => x[0] === c); return p ? p[1] : d; };
  const all = (c) => codes.filter((x) => x[0] === c).map((x) => x[1]);
  const base = {
    type,
    layer: g(8, '0'),
    lineType: g(6, undefined),
    isVisible: n(g(60, 0)) !== 1,
  };
  const ez = g(230, null);
  if (ez != null) base.extrusionDirection = { x: n(g(210, 0)), y: n(g(220, 0)), z: n(ez, 1) };
  const pt = (cx, cy) => ({ x: n(g(cx, 0)), y: n(g(cy, 0)) });
  switch (type) {
    case 'LINE': return { ...base, startPoint: pt(10, 20), endPoint: pt(11, 21) };
    case 'CIRCLE': return { ...base, center: pt(10, 20), radius: n(g(40, 0)) };
    case 'ARC': return { ...base, center: pt(10, 20), radius: n(g(40, 0)), startAngle: n(g(50, 0)) * RAD, endAngle: n(g(51, 0)) * RAD };
    case 'LWPOLYLINE': {
      const vertices = [];
      for (const [c, v] of codes) {
        if (c === 10) vertices.push({ x: n(v), y: 0, bulge: 0 });
        else if (c === 20 && vertices.length) vertices[vertices.length - 1].y = n(v);
        else if (c === 42 && vertices.length) vertices[vertices.length - 1].bulge = n(v);
      }
      return { ...base, type: 'LWPOLYLINE', flag: n(g(70, 0)), vertices };
    }
    case 'TEXT': {
      const has11 = codes.some((x) => x[0] === 11);
      return {
        ...base, startPoint: pt(10, 20), endPoint: has11 ? pt(11, 21) : { x: 0, y: 0 }, halign: n(g(72, 0)), valign: n(g(73, 0)),
        textHeight: n(g(40, 0)), rotation: n(g(50, 0)) * RAD, text: g(1, ''),
      };
    }
    case 'MTEXT': {
      const text = [...all(3), g(1, '')].join('');
      const has11 = codes.some((x) => x[0] === 11);
      return {
        ...base, insertionPoint: pt(10, 20), textHeight: n(g(40, 0)), rectWidth: n(g(41, 0)), text,
        rotation: n(g(50, 0)) * RAD, ...(has11 ? { direction: pt(11, 21) } : {}),
      };
    }
    case 'DIMENSION': {
      const out = {
        ...base, name: g(2, null), definitionPoint: pt(10, 20), textPoint: pt(11, 21), dimensionType: n(g(70, 0)),
        text: g(1, ''), measurement: codes.some((x) => x[0] === 42) ? n(g(42, 0)) : null,
      };
      if (codes.some((x) => x[0] === 13)) out.subDefinitionPoint1 = pt(13, 23);
      if (codes.some((x) => x[0] === 14)) out.subDefinitionPoint2 = pt(14, 24);
      return out;
    }
    case 'INSERT': return { ...base, name: g(2, ''), insertionPoint: pt(10, 20), xScale: n(g(41, 1), 1), yScale: n(g(42, 1), 1), rotation: n(g(50, 0)) * RAD };
    default: return null;
  }
}

/**
 * Entities of a section from its pairs (from index i up to ENDSEC / ENDBLK). POLYLINE + VERTEX … SEQEND become one
 * LWPOLYLINE. Returns { entities, next }.
 */
function readEntities(pairs, i, stopAt) {
  const entities = [];
  let poly = null;
  while (i < pairs.length) {
    const [c, v] = pairs[i];
    if (c === 0 && stopAt.includes(v)) break;
    if (c !== 0) { i += 1; continue; }
    const type = v;
    const codes = [];
    i += 1;
    while (i < pairs.length && pairs[i][0] !== 0) { codes.push(pairs[i]); i += 1; }
    if (type === 'POLYLINE') {
      const g = (cc, d) => { const p = codes.find((x) => x[0] === cc); return p ? p[1] : d; };
      poly = { type: 'LWPOLYLINE', layer: g(8, '0'), lineType: g(6, undefined), isVisible: n(g(60, 0)) !== 1, flag: n(g(70, 0)) & 1, vertices: [] };
      continue;
    }
    if (type === 'VERTEX' && poly) {
      const g = (cc, d) => { const p = codes.find((x) => x[0] === cc); return p ? p[1] : d; };
      poly.vertices.push({ x: n(g(10, 0)), y: n(g(20, 0)), bulge: n(g(42, 0)) });
      continue;
    }
    if (type === 'SEQEND') { if (poly) entities.push(poly); poly = null; continue; }
    const e = entityOf(type, codes);
    if (e) entities.push(e);
  }
  return { entities, next: i };
}

/** The DXF text -> { entities, tables: { BLOCK_RECORD, LAYER } }. Throws on a binary or unreadable file. */
export function readDxfDb(text) {
  const s = String(text ?? '');
  if (s.startsWith('AutoCAD Binary DXF')) throw new Error('This is a binary DXF. Save it as an ASCII DXF and upload that.');
  const pairs = pairsOf(s);
  if (!pairs.some((p) => p[0] === 0 && p[1] === 'SECTION')) throw new Error('This file does not read as a DXF drawing.');
  const layers = [];
  const blocks = [];
  let entities = [];
  let i = 0;
  while (i < pairs.length) {
    const [c, v] = pairs[i];
    if (c === 0 && v === 'SECTION' && pairs[i + 1]?.[0] === 2) {
      const name = pairs[i + 1][1];
      i += 2;
      if (name === 'ENTITIES') { const r = readEntities(pairs, i, ['ENDSEC']); entities = r.entities; i = r.next; continue; }
      if (name === 'BLOCKS') {
        while (i < pairs.length && !(pairs[i][0] === 0 && pairs[i][1] === 'ENDSEC')) {
          if (pairs[i][0] === 0 && pairs[i][1] === 'BLOCK') {
            const codes = []; i += 1;
            while (i < pairs.length && pairs[i][0] !== 0) { codes.push(pairs[i]); i += 1; }
            const g = (cc, d) => { const p = codes.find((x) => x[0] === cc); return p ? p[1] : d; };
            const r = readEntities(pairs, i, ['ENDBLK', 'ENDSEC']);
            blocks.push({ name: g(2, ''), basePoint: { x: n(g(10, 0)), y: n(g(20, 0)) }, entities: r.entities });
            i = r.next;
          } else i += 1;
        }
        continue;
      }
      if (name === 'TABLES') {
        while (i < pairs.length && !(pairs[i][0] === 0 && pairs[i][1] === 'ENDSEC')) {
          if (pairs[i][0] === 0 && pairs[i][1] === 'LAYER') {
            const codes = []; i += 1;
            while (i < pairs.length && pairs[i][0] !== 0) { codes.push(pairs[i]); i += 1; }
            const g = (cc, d) => { const p = codes.find((x) => x[0] === cc); return p ? p[1] : d; };
            layers.push({ name: g(2, ''), lineType: g(6, 'CONTINUOUS') });
          } else i += 1;
        }
        continue;
      }
    }
    i += 1;
  }
  return { entities, tables: { BLOCK_RECORD: { entries: blocks }, LAYER: { entries: layers } } };
}
