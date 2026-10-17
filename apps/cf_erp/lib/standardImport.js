/**
 * standardImport.js — turns a ready-made standard's bom.json (TM/drawing_bom/out/<SET>/bom.json, format
 * `rdso-standard-drawing-bom/1`, TM/drawing_bom/out/IMPORT_FORMAT.md) into a PLAN: the tree mapped onto the
 * tenant's EXISTING definitions, the values each row holds, the part files, the notes a person must see.
 * Pure: no database. standardDrawingService.importStandard writes the plan; the script prints it.
 *
 * PART NAMES (user, 2026-10-17: reuse the names that exist). Each part and assembly is mapped by its ROLE to an
 * ordered list of definition names; the first one the catalog has wins. Names are compared loosely (case,
 * punctuation, "Inter." / "Diaph." / "center", plurals, "Hole" = "(holed)"), so an older catalog that still says
 * "Bearing Stiffener Plain" matches "Bearing stiffener (plain)". Only when no name fits is a NEW definition planned,
 * and the plan lists it (`newDefinitions`).
 *
 * BOUGHT items (bearings, holding-down bolts, HSFG bolts) are not made, so they are not rows: the plan lists them
 * (`bought`) and the standard's notes carry them.
 */

const r3 = (n) => Math.round(Number(n) * 1000) / 1000;

/** A name as the comparison sees it. */
export function normName(s) {
  let t = ` ${String(s ?? '').toLowerCase()} `;
  t = t.replace(/\binter\.\s*/g, 'intermediate ').replace(/\bdiaph\.\s*/g, 'diaphragm ').replace(/\blong\.\s*/g, 'longitudinal ');
  t = t.replace(/\bg\s*&\s*a\b/g, 'girder arch').replace(/\bed\b/g, 'end diaphragm').replace(/\bid\b/g, 'intermediate diaphragm');
  t = t.replace(/\bcenter\b/g, 'centre').replace(/\bdigonal\b/g, 'diagonal').replace(/\bstiffner/g, 'stiffener');
  t = t.replace(/[()&/.,_-]+/g, ' ');
  t = t.replace(/\bhole\b/g, 'holed');
  const singular = { frames: 'frame', plates: 'plate', stiffeners: 'stiffener', bracings: 'bracing', cleats: 'cleat', supports: 'support', brackets: 'bracket', splices: 'splice', angles: 'angle' };
  return t.split(/\s+/).filter(Boolean).map((w) => singular[w] ?? w).join(' ');
}

/** "TOP FLANGE OUTER COVER PLATE" → "Top flange outer cover plate". */
export function sentence(s) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : t;
}

const BOUGHT_ROLES = new Set(['bolt', 'bearing_elastomeric', 'bearing_guide', 'holding_down_bolt']);

/** The definition names a part may take, best first — by its role (IMPORT_FORMAT.md `items[].role`). */
export function partCandidates(item, place = {}) {
  const holed = Number(item?.holes?.count ?? 0) > 0;
  const stiffener = (word) => (holed ? [`${word} stiffener (holed)`, `${word} stiffener`] : [`${word} stiffener (plain)`, `${word} stiffener`]);
  const desc = String(item?.description ?? '').toUpperCase();
  switch (item?.role) {
    case 'top_flange': return ['Top flange'];
    case 'bottom_flange': return ['Bottom flange'];
    case 'web': return ['Web plate', 'Web'];
    case 'intermediate_stiffener': return stiffener('Intermediate');
    case 'bearing_stiffener':
    case 'diaphragm_bearing_stiffener': return stiffener('Bearing');
    case 'jacking_stiffener': return ['Jacking stiffener'];
    case 'diaphragm_top_flange': return place.endDiaphragm ? ['Diaphragm top flange', 'End diaphragm top flange'] : ['Diaphragm top flange', 'Intermediate diaphragm top flange'];
    case 'diaphragm_bottom_flange': return place.endDiaphragm ? ['Diaphragm bottom flange', 'End diaphragm bottom flange'] : ['Diaphragm bottom flange', 'Intermediate diaphragm bottom flange'];
    // The End diaphragm template's own web is "Intermediate diaphragm web" (the catalog's convention, and the user's list).
    case 'diaphragm_web': return ['Intermediate diaphragm web', 'End diaphragm web', 'Diaphragm web'];
    // One gusset of its frame, without holes, where the diagonals cross: the centre gusset.
    case 'gusset': return place.single && !holed ? ['Centre gusset', 'Gusset plate'] : ['Gusset plate'];
    case 'top_flange_cover_outer': return ['Top flange outer cover plate', 'Cover plate'];
    case 'top_flange_cover_inner': return ['Top flange inner cover plate', 'Cover plate'];
    case 'bottom_flange_cover_outer': return ['Bottom flange outer cover plate', 'Cover plate'];
    case 'bottom_flange_cover_inner': return ['Bottom flange inner cover plate', 'Cover plate'];
    case 'web_cover_plate': return ['Web cover plate', 'Cover plate'];
    case 'restrainer_plate': return ['Restrainer plate'];
    case 'restrainer_stiffener': return ['Restrainer stiffener plate', 'Restrainer stiffener'];
    case 'pad_plate': return ['Pad plate'];
    case 'packing_plate': return ['Packing plate'];
    case 'shear_stud': return ['Shear stud'];
    case 'angle':
      if (/LATERAL\s+BRAC/.test(desc)) return ['Bottom lateral bracing member', 'Bottom bracings lateral', 'Bracing'];
      if (/DIAGONAL|DIGONAL/.test(desc)) return ['X-frame diagonal angle'];
      if (/TOP\s*\/\s*BOTTOM/.test(desc)) return ['X-frame top angle'];
      if (/\bTOP\b/.test(desc)) return ['X-frame top angle'];
      if (/\bBOTTOM\b/.test(desc)) return ['X-frame bottom angle'];
      return ['Bracing'];
    default: return [sentence(item?.description ?? item?.mark ?? 'Part')];
  }
}

/** The definition names an assembly node may take (IMPORT_FORMAT.md `assembly` kinds). */
export function nodeCandidates(node) {
  const name = String(node?.name ?? '').toUpperCase();
  switch (node?.kind) {
    case 'span': return ['Bridge span'];
    case 'girder': return ['Girder line'];
    case 'girder_segment': return ['Girder segment'];
    case 'splice_set': return ['Splice set'];
    case 'assembly':
      if (/END\s+DIAPHRAGM/.test(name)) return ['End diaphragm'];
      if (/X-?\s*FRAME|INTERMEDIATE\s+DIAPHRAGM|CROSS\s+FRAME/.test(name)) return ['Intermediate diaphragm frame', 'Intermediate diaphragm'];
      return [sentence(name.split('/').pop())];
    case 'loose':
      if (/BRAC/.test(name)) return ['Bottom lateral bracing', 'Bracing'];
      return [sentence(name.split('/').pop())];
    default: return [sentence(name.split('/').pop() || 'Assembly')];
  }
}

/** "GA/GIRDER COMPLETE" → "GA"; a node without a mark → null. */
export const nodeMark = (node) => {
  const m = /^([A-Z][A-Z0-9-]{0,11})\s*\//.exec(String(node?.name ?? '').trim());
  return m ? m[1] : null;
};

/**
 * The note a person must see on a row (user: "parts flagged drill on assembly or needs decision must carry that
 * note"): the DRILL ON ASSEMBLY notes, any other drilling caution, and any decision on the part not yet decided.
 */
export function rowNote(item, decisions = []) {
  const out = [];
  const status = String(item?.status ?? 'ok').toLowerCase();
  const notes = (item?.notes ?? []).map(String);
  if (status === 'drill on assembly') {
    const drill = notes.filter((n) => /drill on assembly/i.test(n));
    out.push(...(drill.length ? drill : ['DRILL ON ASSEMBLY — see the drawing.']));
  }
  for (const n of notes) if (/drill/i.test(n) && !out.includes(n)) out.push(n);
  const byId = new Map((decisions ?? []).map((d) => [d.id, d]));
  const open = (item?.decisions ?? []).map((id) => byId.get(id)).filter((d) => d && String(d.status ?? '').toLowerCase() !== 'decided');
  for (const d of open) out.push(`NEEDS DECISION ${d.id}: ${d.what}`);
  if (status === 'needs decision' && !open.length) out.push('NEEDS DECISION — see the drawing.');
  return out.length ? out.join(' · ').slice(0, 2000) : null;
}

/** Sentence-cased role text for a BOM line: "Top flange", "GA girder complete". */
const roleText = (s) => sentence(String(s ?? '').replace(/\//g, ' ')).slice(0, 100);

/**
 * THE PLAN. `catalog`:
 *   defs        [{ id, code, name, short_name, definition_type, status, classification_id, default_flow_id, bom_id }]
 *   specs       Map(CODE -> { id, data_type, default_uom })
 *   gradeOption Map(UPPER value or label -> option id)
 *   studs       [{ id, code, name }] — the Shear stud selection's catalog candidates
 * Returns { standard, rows, files, bought, newDefinitions, mappings, problems, totals }.
 *   rows   [{ key, parentKey, kind: 'temp' | 'selection', depth, lineNo, position, role, quantity, notes, mark,
 *             def: { id, name, code } | { new: name }, classHint, values: [{ code, ... }], item, node, weightKg }]
 */
export function planImport(bom, catalog) {
  const problems = [];
  if (bom?.schema !== 'rdso-standard-drawing-bom/1') problems.push(`bom.json says schema ${bom?.schema ?? '(none)'} — this importer reads rdso-standard-drawing-bom/1.`);
  const dw = bom?.drawing ?? {};
  const items = new Map((bom?.items ?? []).map((it) => [it.id, it]));
  const density = Number(bom?.material?.densityKgM3) || 7850;
  const defsByNorm = new Map();
  for (const d of catalog.defs ?? []) {
    if (d.status !== 'active') continue;
    const k = normName(d.name);
    if (!defsByNorm.has(k)) defsByNorm.set(k, []);
    defsByNorm.get(k).push(d);
  }
  const pick = (names, type) => {
    for (const n of names) {
      const hit = (defsByNorm.get(normName(n)) ?? []).find((d) => d.definition_type === type);
      if (hit) return { def: hit, asked: n };
    }
    return null;
  };
  const newDefs = new Map();   // name -> { name, classHint, roles }
  const mappings = [];
  const rows = [];
  const bought = [];
  const files = new Map();     // mark -> { mark, file, item }
  let seq = 0;

  const spec = (code) => catalog.specs?.get(code) ?? null;
  const num =(code, v) => (v == null || !Number.isFinite(Number(v)) || !spec(code) ? null : { code, number: r3(v), uom: spec(code).default_uom ?? null });
  const txt = (code, v) => (v == null || v === '' || !spec(code) ? null : { code, text: String(v).slice(0, 255) });
  const grade = (g) => {
    if (!g || !spec('GRADE')) return null;
    const id = catalog.gradeOption?.get(String(g).toUpperCase());
    if (id == null) { problems.push(`Grade ${g} is not an option of GRADE here — the rows are left without a grade.`); return null; }
    return { code: 'GRADE', optionId: id, display: g };
  };

  /** The values a part row holds; its weight each (kg, gross, as bom.json works it out). */
  function partValues(it, mark) {
    const v = [txt('DRAWING_MARK', mark), grade(it.grade)];
    let kg = null;
    if (it.category === 'plate') {
      v.push(num('THICKNESS', it.thicknessMm), num('WIDTH', it.widthMm), num('LENGTH', it.lengthMm));
      if ([it.thicknessMm, it.widthMm, it.lengthMm].every((x) => Number(x) > 0)) kg = (it.lengthMm * it.widthMm * it.thicknessMm * density) / 1e9;
    } else if (it.category === 'section') {
      // An equal angle: legs a, thickness t. Its gross section is t (2a - t) (IMPORT_FORMAT.md, no root fillet).
      const a = Number(it.widthMm); const t = Number(it.thicknessMm);
      const area = a > 0 && t > 0 ? t * (2 * a - t) : null;
      v.push(num('THICKNESS', t), num('WIDTH', a), num('DEPTH', a), num('LENGTH', it.lengthMm), num('SECTION_AREA', area));
      if (area && Number(it.lengthMm) > 0) kg = (area * it.lengthMm * density) / 1e9;
    }
    if (kg != null && spec('WEIGHT')) v.push({ code: 'WEIGHT', number: r3(kg), uom: spec('WEIGHT').default_uom ?? 'kg', source: 'calculated' });
    return { values: v.filter(Boolean), kg };
  }

  function mapDef(names, type, what, classHint) {
    const hit = pick(names, type);
    if (hit) { mappings.push({ what, asked: names, to: { id: hit.def.id, code: hit.def.code, name: hit.def.name }, fallback: hit.asked !== names[0] }); return { id: hit.def.id, code: hit.def.code, name: hit.def.name, classification_id: hit.def.classification_id, default_flow_id: hit.def.default_flow_id, bom_id: hit.def.bom_id ?? null }; }
    const name = names[0];
    if (type === 'selection') { problems.push(`${what}: no selection definition named ${names.join(' / ')} — left out.`); return null; }
    if (!newDefs.has(name)) newDefs.set(name, { name, classHint, used: [] });
    if (!newDefs.get(name).used.includes(what)) newDefs.get(name).used.push(what);
    mappings.push({ what, asked: names, to: { new: name }, fallback: false });
    return { new: name, name, classHint };
  }

  function walk(node, parentKey, depth, place) {
    const children = node.children ?? [];
    const leaves = children.filter((c) => c.item != null);
    // A node of bought items only is not made: list it, write nothing.
    if (node.item == null && leaves.length && leaves.length === children.length && leaves.every((l) => BOUGHT_ROLES.has(items.get(l.item)?.role))) {
      for (const l of leaves) { const it = items.get(l.item); bought.push({ mark: it?.mark ?? l.item, description: it?.description ?? l.item, quantity: Number(l.qtyPerParent) * (place.mult ?? 1), profile: it?.profile ?? null }); }
      return;
    }
    const key = `n${++seq}`;
    // A span or a girder line carries no drawing mark of its own; a segment or an assembly does ("GA/…").
    const mark = node.kind === 'span' || node.kind === 'girder' ? null : nodeMark(node);
    const what = `${node.kind} ${node.name}`;
    const def = mapDef(nodeCandidates(node), 'template', what, node.kind === 'span' || node.kind === 'girder' ? 'structure' : 'assembly');
    const v = [txt('DRAWING_MARK', mark)].filter(Boolean);
    if (node.kind === 'span') {
      const layout = (bom.assembly?.children ?? []).flatMap((c) => c.layoutMm ?? []);
      const span = layout.length ? Math.max(...layout.map((s) => Number(s.toMm) || 0)) : null;
      const sl = num('SPAN_LENGTH', span); if (sl) v.push(sl);
    }
    const row = {
      key, parentKey, kind: 'temp', depth, lineNo: place.lineNo ?? null, position: null,
      role: depth === 0 ? null : roleText(node.name), quantity: Number(node.qtyPerParent ?? 1), notes: null, mark,
      def, values: v, node: { id: node.id, kind: node.kind, name: node.name }, item: null, weightKg: null, children: [],
    };
    rows.push(row);
    const endDiaphragm = /END\s+DIAPHRAGM/i.test(String(node.name ?? ''));
    let lineNo = 0;
    for (const c of children) {
      lineNo += 10;
      if (c.item == null) { walk(c, key, depth + 1, { lineNo, mult: (place.mult ?? 1) * Number(c.qtyPerParent ?? 1) }); continue; }
      const it = items.get(c.item);
      if (!it) { problems.push(`${node.name}: item ${c.item} is not in items[] — left out.`); continue; }
      const q = Number(c.qtyPerParent ?? 1);
      if (BOUGHT_ROLES.has(it.role) || (it.category === 'bought' && it.role !== 'shear_stud')) {
        bought.push({ mark: it.mark ?? it.id, description: it.description, quantity: q * (place.mult ?? 1), profile: it.profile ?? null });
        continue;
      }
      const what2 = `${it.mark} ${it.description}`;
      if (it.role === 'shear_stud') {
        const sel = mapDef(partCandidates(it), 'selection', what2, null);
        if (!sel) continue;
        // The catalog stud of this size if there is one; else the selection stays to be chosen, and says so.
        const want = /(\d+)\s*dia\s*x\s*(\d+)/i.exec(String(it.profile ?? it.material ?? ''));
        const match = want ? (catalog.studs ?? []).find((s) => new RegExp(`\\b${want[1]}\\b`).test(s.name) && new RegExp(`\\b${want[2]}\\b`).test(s.name)) : null;
        rows.push({
          key: `n${++seq}`, parentKey: key, kind: 'selection', depth: depth + 1, lineNo, position: null,
          role: roleText(it.description), quantity: q, mark: it.mark,
          notes: match ? null : `Choose the stud: ${it.profile ?? it.material} — no catalog stud of this size yet.`,
          def: sel, chosen: match ? { id: match.id, code: match.code, name: match.name } : null, values: [], item: it, weightKg: null, children: [],
        });
        mappings[mappings.length - 1].chosen = match ? match.name : null;
        continue;
      }
      // An angle written TOP/BOTTOM is two rows of the frame, one each — the catalog names them apart.
      const split = it.role === 'angle' && /TOP\s*\/\s*BOTTOM/i.test(it.description ?? '') && q % 2 === 0;
      const parts = split
        ? [{ names: ['X-frame top angle'], quantity: q / 2, role: 'Top angle' }, { names: ['X-frame bottom angle'], quantity: q / 2, role: 'Bottom angle' }]
        : [{ names: partCandidates(it, { endDiaphragm, single: q === 1 }), quantity: q, role: roleText(it.description) }];
      for (const [i, p] of parts.entries()) {
        const d = mapDef(p.names, 'template', split ? `${what2} (${p.role.toLowerCase()})` : what2, it.category === 'section' ? 'profile' : 'plate');
        const { values: pv, kg } = partValues(it, it.mark);
        rows.push({
          key: `n${++seq}`, parentKey: key, kind: 'temp', depth: depth + 1, lineNo: lineNo + i, position: null,
          role: p.role, quantity: p.quantity, mark: it.mark, notes: rowNote(it, bom.decisions),
          def: d, values: pv, item: it, weightKg: kg == null ? null : r3(kg), children: [],
        });
      }
      if (it.dxf && !files.has(it.mark)) files.set(it.mark, { mark: it.mark, file: it.dxf, item: it });
    }
  }
  if (bom?.assembly) walk(bom.assembly, null, 0, { lineNo: null, mult: 1 });
  else problems.push('bom.json has no assembly tree.');

  // Children, positions (per parent and definition, 1, 2 …), and the roll-up of weights per unit.
  const byKey = new Map(rows.map((r) => [r.key, r]));
  for (const r of rows) if (r.parentKey) byKey.get(r.parentKey).children.push(r);
  for (const r of rows) {
    const seen = new Map();
    for (const k of r.children) {
      const dk = k.def?.id ?? k.def?.new ?? k.key;
      seen.set(dk, (seen.get(dk) ?? 0) + 1);
      k.position = seen.get(dk);
    }
  }
  const studKg = new Map((bom.items ?? []).filter((i) => i.role === 'shear_stud').map((i) => [i.mark, Number(i.unitWeightKg) || 0]));
  const roll = (r) => {
    if (r.kind === 'selection') return { steel: 0, studs: (studKg.get(r.mark) ?? 0) * r.quantity };
    if (!r.children.length) return { steel: r.weightKg ?? 0, studs: 0 };
    let steel = 0; let studs = 0;
    for (const k of r.children) { const w = roll(k); steel += w.steel * k.quantity; studs += w.studs * (k.kind === 'selection' ? 1 : k.quantity); }
    r.weightKg = r3(steel);
    if (spec('WEIGHT')) r.values.push({ code: 'WEIGHT', number: r3(steel), uom: spec('WEIGHT').default_uom ?? 'kg', source: 'rollup' });
    return { steel, studs };
  };
  const root = rows[0] ?? null;
  const w = root ? roll(root) : { steel: 0, studs: 0 };

  const tempRows = rows.filter((r) => r.kind === 'temp');
  const number = `${dw.number ?? bom?.set ?? 'STANDARD'}${dw.revision ?? ''}`;
  return {
    standard: {
      number,
      registerNumber: dw.number ?? number,
      revision: dw.revision ?? null,
      name: `${dw.number ?? number}${dw.revision ?? ''} — ${dw.spanM ? `${dw.spanM} m span` : ''}${dw.loading ? `, ${dw.loading}` : ''}`.replace(/ — $/, ''),
      description: dw.title ?? null,
      sourceUrl: dw.sourceUrl ?? null,
      internal: /internal/i.test(String(dw.ownership ?? '')),
      ownership: dw.ownership ?? null,
      sheets: dw.sheets ?? [],
    },
    rows,
    files: [...files.values()],
    bought,
    newDefinitions: [...newDefs.values()],
    mappings,
    problems,
    totals: {
      rows: tempRows.length,
      parts: tempRows.filter((r) => !r.children.length).length,
      steelKg: r3(w.steel),
      studKg: r3(w.studs),
      bomSteelKg: bom?.totals?.steelKg ?? null,
      bomSteelKgInclStuds: bom?.totals?.steelKgInclStuds ?? null,
    },
  };
}
