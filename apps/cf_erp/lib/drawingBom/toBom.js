// The extractor's answer (extract.js) as a bom.json (`rdso-standard-drawing-bom/1`, TM/drawing_bom/out/IMPORT_FORMAT.md),
// so the ONE mapping the standard importer uses (lib/standardImport.planImport) puts a new drawing on the catalog's
// own definitions too. Plus, per item, what the engine was unsure of (`flags`), in words a person can act on.
// Pure: no database.

const r3 = (n) => Math.round(Number(n) * 1000) / 1000;

/** The importer's role for a part, from its caption words and the assembly the engine put it in. */
export function roleOf(p) {
  const d = String(p.description ?? '').toUpperCase();
  const asm = String(p.assembly ?? '').toUpperCase();
  if (p.kind === 'section') return 'angle';
  const diaphragm = /DIAPHRAGM|CROSS GIRDER/.test(asm) || /CROSS GIRDER|DIAPHRAGM/.test(d);
  if (/SPLICE/.test(d) || /SPLICE/.test(asm)) {
    if (/PACK/.test(d)) return 'packing_plate';
    if (/WEB/.test(d)) return 'web_cover_plate';
    const top = /\bTOP\b/.test(d); const inner = /\bINNER\b/.test(d);
    if (top) return inner ? 'top_flange_cover_inner' : 'top_flange_cover_outer';
    if (/\bBOTTOM\b|\bBOT\b|\bBTM\b/.test(d)) return inner ? 'bottom_flange_cover_inner' : 'bottom_flange_cover_outer';
    return 'web_cover_plate';
  }
  if (/PACK/.test(d)) return 'packing_plate';
  if (/GUSSET/.test(d)) return 'gusset';
  if (/JACKING/.test(d) && /STIF|STFR/.test(d)) return 'jacking_stiffener';
  if (/\bPAD\b|JACKING\s+PL/.test(d)) return 'pad_plate';
  if (/BEARING/.test(d) && /STIF|STFR/.test(d)) return diaphragm ? 'diaphragm_bearing_stiffener' : 'bearing_stiffener';
  if (/STIF|STFR/.test(d)) return 'intermediate_stiffener';
  if (/\bTOP\b/.test(d) && /FLANGE|FLG/.test(d)) return diaphragm ? 'diaphragm_top_flange' : 'top_flange';
  if (/\b(BOTTOM|BOT|BTM)\b/.test(d) && /FLANGE|FLG/.test(d)) return diaphragm ? 'diaphragm_bottom_flange' : 'bottom_flange';
  if (/\bWEB\b/.test(d)) return diaphragm ? 'diaphragm_web' : 'web';
  return String(p.description ?? 'part').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'part';
}

/** The assembly node a part goes under: { key, kind, name } (IMPORT_FORMAT.md kinds), from the engine's words. */
function nodeOf(asm) {
  const a = String(asm ?? 'unknown');
  if (/^Main girder/i.test(a)) return { key: 'MG', kind: 'girder', name: 'MAIN GIRDER' };
  if (/^Splice joint/i.test(a)) { const g = a.replace(/^Splice joint\s*/i, '').trim(); return { key: `SP:${g}`, kind: 'splice_set', name: `SPLICE SET${g ? ` ${g}` : ''}` }; }
  if (/End diaphragm|Cross girder/i.test(a)) return { key: 'ED', kind: 'assembly', name: 'END DIAPHRAGM' };
  if (/Intermediate diaphragm/i.test(a)) return { key: 'ID', kind: 'assembly', name: 'INTERMEDIATE DIAPHRAGM' };
  if (/Cross frame/i.test(a)) return { key: 'CF', kind: 'assembly', name: 'CROSS FRAME' };
  if (/lateral bracing/i.test(a)) return { key: 'BLB', kind: 'loose', name: 'BOTTOM LATERAL BRACING' };
  if (/Seismic|arrestor|stopper/i.test(a)) return { key: 'SS', kind: 'assembly', name: 'SEISMIC STOPPER' };
  if (/^Group\s+/i.test(a)) { const g = a.replace(/^Group\s+/i, '').trim(); return { key: `G:${g}`, kind: 'assembly', name: `GROUP ${g}` }; }
  return { key: 'LOOSE', kind: 'loose', name: 'LOOSE ITEMS' };
}

const sentence = (s) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase(); return t ? t[0].toUpperCase() + t.slice(1) : t; };

/** What the engine was not sure of, as short reasons (the BOM row carries them as "Check (by AI): …"). */
export function flagsOf(p) {
  const out = [];
  if (p.qty == null) out.push('quantity not on the drawing — set to 1');
  const keep = (r) => !/^checks passed|^girder plate: quantity counted, not stated$|^rolled section:|double circles/.test(r);
  if (p.confidence !== 'high') for (const r of p.reasons ?? []) if (keep(r) && !/no quantity stated/.test(r) && !/^no detail view/.test(r) && !/^assembly:/.test(r)) out.push(r);
  if (p.assembly === 'unknown') out.push('which assembly it belongs to is not clear — put under Loose items');
  if (p.geometryConfidence === 'low') out.push('its shape or holes need a look');
  return [...new Set(out)];
}

/**
 * → { bom, flags: Map(item id → [reason]), stats: { parts, flagged, girders, title } }.
 * `sourceName` is the uploaded file's name (the span's name when the drawing has no title).
 */
export function toBom(result, { sourceName = 'drawing' } = {}) {
  const parts = result.parts ?? [];
  const items = [];
  const flags = new Map();
  const nodes = new Map();
  const usedMarks = new Set(parts.map((p) => p.mark).filter(Boolean));
  let n = 0;
  for (const p of parts) {
    n += 1;
    const id = `I${n}`;
    let mark = p.mark ?? null;
    if (!mark) { let k = n; while (usedMarks.has(`P${k}`)) k += 1; mark = `P${k}`; usedMarks.add(mark); }
    const okFile = !!(p.file && p.reader?.ok && p.reader?.sizeOk);
    const unitKg = Number(p.unitKg) > 0 ? Number(p.unitKg) : null;
    items.push({
      id, mark, description: sentence(p.description || p.caption || 'Part'), role: roleOf(p), category: p.kind === 'section' ? 'section' : 'plate',
      material: p.kind === 'section' ? 'steel angle (equal)' : 'steel plate', grade: p.grade ?? null,
      thicknessMm: p.thicknessMm ?? null, widthMm: p.widthMm ?? null, lengthMm: p.lengthMm ?? null,
      profile: p.kind === 'section' ? (p.profile ?? null) : null,
      qtyPerSpan: p.qty ?? 1, holes: { count: p.holes ?? 0, dia: (p.holeGroups ?? []).map((g) => g[1]) },
      unitWeightKg: unitKg, totalWeightKg: unitKg == null ? null : r3(unitKg * (p.qty ?? 1)),
      dxf: okFile ? p.file : null, notes: [], status: 'ok', decisions: [], verification: p.geometryConfidence ?? null,
      source: p.caption ?? null, derivedHow: p.qtyHow ?? null,
    });
    const f = flagsOf(p);
    if (f.length) flags.set(id, f);
    const node = nodeOf(p.assembly);
    if (!nodes.has(node.key)) nodes.set(node.key, { ...node, leaves: [] });
    nodes.get(node.key).leaves.push({ item: id, qty: p.qty ?? 1 });
  }
  // The main girder holds one girder's parts × the number of girders when every count divides by it.
  const girders = Number(result.girders) > 1 ? Number(result.girders) : null;
  const order = ['MG', 'ED', 'ID', 'CF', 'BLB', 'SS'];
  const keys = [...nodes.keys()].sort((a, b) => {
    const ia = order.indexOf(a.split(':')[0]); const ib = order.indexOf(b.split(':')[0]);
    return (a === 'LOOSE') - (b === 'LOOSE') || (ia < 0 ? 50 : ia) - (ib < 0 ? 50 : ib) || a.localeCompare(b);
  });
  const children = keys.map((k) => {
    const nd = nodes.get(k);
    const per = nd.kind === 'girder' && girders && nd.leaves.every((l) => l.qty % girders === 0) ? girders : 1;
    return { id: nd.key, kind: nd.kind, name: nd.name, qtyPerParent: per, children: nd.leaves.map((l, i) => ({ item: l.item, sno: i + 1, qtyPerParent: l.qty / per })) };
  });
  const sheet = (result.sheets ?? [])[0] ?? null;
  const title = (sheet?.title ?? '').trim() || String(sourceName).replace(/\.(dxf|dwg)$/i, '');
  const number = String(sheet?.no && result.framed ? sheet.no.replace(/\/\s*\d{1,2}\s*$/, '') : String(sourceName).replace(/\.(dxf|dwg)$/i, '')).slice(0, 140);
  const bom = {
    schema: 'rdso-standard-drawing-bom/1',
    set: String(sourceName).slice(0, 120),
    drawing: { number, revision: null, title, sheets: (result.sheets ?? []).map((s) => ({ sheet: s.num, number: s.no, title: s.title })), sourceUrl: null, ownership: null },
    material: { grade: result.grade ?? null, densityKgM3: 7850 },
    items,
    assembly: { id: 'SPAN', kind: 'span', name: title.toUpperCase().slice(0, 200), qtyPerParent: 1, children },
    decisions: [],
    totals: {},
  };
  return { bom, flags, stats: { parts: items.length, flagged: flags.size, girders, title, number } };
}
