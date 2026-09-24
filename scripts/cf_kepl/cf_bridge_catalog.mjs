/**
 * cf_bridge_catalog.mjs — the KEPL ROB 59.3 m job as cf_erp catalog items:
 * every distinct plate part, every girder segment design, the three
 * sub-assemblies and the shear stud, each with its Standard BOM.
 *
 * Runs after cf_bridge_setup.mjs, which makes the classification, the
 * specifications, the rules and the coding rules this script relies on.
 *
 * Nothing is derived here. The parts, the designs and the quantities come from
 * cf_bridge_data.mjs, which decoded the BOQ; this script only writes them
 * through the cf_erp services and checks that what comes back out weighs what
 * the BOQ says it should.
 *
 * Re-runnable: an item is looked up by its generated code and by its name
 * before it is created, a BOM line is added only when that child is not on the
 * BOM already. A second run must create nothing.
 *
 *   cd multi_app_be && node <this file>
 *   CF_BRIDGE_COMPANY=2 node <this file>
 *   node <this file> --verify-only        # no writes, just the reconciliation
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import * as DATA from './cf_bridge_data.mjs';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const MARKER = path.join(HERE, '.bridge_catalog_done');

const { pool } = await imp('db.js');
// These scripts hand-roll their transactions, so they do not get withTransaction's
// per-transaction memo for classification reads. Attaching it here cuts the same three
// tree rows from 8 reads per item to 2 — worth ~0.3 s an item over a remote link.
const { attachNodeCache, detachNodeCache } = await imp('apps/cf_erp/lib/db.js');
await imp('apps/cf_erp/services/codegenProvider.js');          // registers the 'item' entity
const recs = await imp('apps/cf_erp/services/masterRecordService.js');
const bom = await imp('apps/cf_erp/services/bomService.js');
const resolution = await imp('apps/cf_erp/services/resolutionService.js');

const VERIFY_ONLY = process.argv.includes('--verify-only');
const COMPANY = Number(process.env.CF_BRIDGE_COMPANY ?? 2);

const tally = { created: {}, reused: {} };
const bump = (bag, k, n = 1) => { bag[k] = (bag[k] ?? 0) + n; };
const made = (k, n = 1) => bump(tally.created, k, n);
const kept = (k, n = 1) => bump(tally.reused, k, n);
const say = (...a) => console.log(...a);

const FUNCTION_LABEL = new Map(DATA.PART_FUNCTION_OPTIONS.map((o) => [o.value, o.label]));
/** The code CFFB-PLATEPART must produce for a part — asserted, never trusted. */
const expectedPartCode = (p) => `${p.shortName}-${p.thk}X${p.len}X${p.wid}-${DATA.GRADE}`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function nodeIdsByCode(db, companyId, codes) {
  const [rows] = await db.query(
    'SELECT id, code FROM cf_classification_nodes WHERE company_id = ? AND code IN (?) AND deleted_at IS NULL',
    [companyId, codes],
  );
  const out = Object.fromEntries(rows.map((r) => [r.code, r.id]));
  const missing = codes.filter((c) => !out[c]);
  if (missing.length) throw new Error(`Classification ${missing.join(', ')} missing — run cf_bridge_setup.mjs on company ${companyId} first.`);
  return out;
}

/** Find an item already here: by its generated code first, then by its name. */
async function findItem(db, c, { code, name }) {
  const [rows] = await db.query(
    `SELECT m.id, m.code, m.name, m.status FROM cf_master_records m
       JOIN cf_item_details i ON i.master_id = m.id AND i.deleted_at IS NULL
      WHERE m.company_id = ? AND m.record_kind = 'item' AND m.deleted_at IS NULL
        AND (m.code = ? OR m.name = ?)`,
    [c.companyId, code ?? '\u0000', name],
  );
  if (rows.length > 1) throw new Error(`${rows.length} items already answer to code ${code} / name "${name}" — ${rows.map((r) => `#${r.id} ${r.code}`).join(', ')}`);
  return rows[0] ?? null;
}

/**
 * Creates an item and activates it, or returns the one already here.
 * `expectCode` is asserted when given: a code that came out differently means
 * the coding rule is not the one this script was written against.
 */
async function ensureItem(db, c, what, spec) {
  const found = await findItem(db, c, { code: spec.expectCode, name: spec.name });
  if (found) {
    kept(what);
    if (found.status === 'draft') { await recs.setStatus(db, c, found.id, 'active'); made(`${what} activated`); }
    if (spec.expectCode && found.code !== spec.expectCode) {
      throw new Error(`${found.name}: code is ${found.code}, expected ${spec.expectCode}.`);
    }
    return { id: found.id, code: found.code, created: false };
  }
  const item = await recs.createItem(db, c, {
    classificationId: spec.classificationId,
    name: spec.name,
    shortName: spec.shortName,
    description: spec.description ?? null,
    uom: spec.uom,
    trackedBy: spec.trackedBy,
    sourcing: spec.sourcing,
    status: 'draft',
    values: spec.values ?? [],
  });
  made(what);
  await recs.setStatus(db, c, item.id, 'active');
  const [[m]] = await db.query('SELECT code FROM cf_master_records WHERE id = ?', [item.id]);
  if (spec.expectCode && m.code !== spec.expectCode) {
    throw new Error(`${spec.name}: generated code is ${m.code}, expected ${spec.expectCode}.`);
  }
  return { id: item.id, code: m.code, created: true };
}

/** The item's stored WEIGHT, as the resolver reports it. */
async function weightOf(db, companyId, id) {
  const [[m]] = await db.query('SELECT * FROM cf_master_records WHERE company_id = ? AND id = ?', [companyId, id]);
  const r = await resolution.resolve(db, companyId, { master: m });
  const w = r.specs.find((s) => s.spec.code === 'WEIGHT');
  return w?.value ? Number(w.value.raw) : null;
}

function assertClose(label, got, want, tol) {
  if (got === null || !Number.isFinite(got) || Math.abs(got - want) > tol) {
    throw new Error(`${label}: weight is ${got}, expected ${want} (+/- ${tol}).`);
  }
}

/** Adds the lines a BOM is missing, then activates it. Quantity is per ONE parent. */
async function ensureBom(db, c, parentId, lines, label) {
  const current = await bom.getBom(db, c.companyId, parentId);
  const have = new Map(current.lines.map((l) => [l.child.id, l]));
  for (const l of lines) {
    const existing = have.get(l.childId);
    if (existing) {
      kept('bom line');
      if (Math.abs(Number(existing.quantity) - l.quantity) > 1e-9) {
        throw new Error(`${label}: line for #${l.childId} is quantity ${existing.quantity}, expected ${l.quantity}.`);
      }
      continue;
    }
    await bom.addLine(db, c, parentId, { childId: l.childId, quantity: l.quantity, role: l.role, lineNo: l.lineNo, notes: l.notes ?? null });
    made('bom line');
  }
  const after = await bom.getBom(db, c.companyId, parentId);
  if (after.bom.status !== 'active') { await bom.setBomStatus(db, c, parentId, 'active'); made('bom activated'); }
  else kept('bom activated');
}

// ---------------------------------------------------------------------------
// The catalog
// ---------------------------------------------------------------------------

async function build(db, c, node) {
  const built = { parts: {}, segments: {}, subs: {}, stud: null };

  // --- 1. Plate parts ------------------------------------------------------
  // Every distinct part the job needs: its function, whether it is drilled and
  // its size. Its drawing mark is deliberately NOT set — the mark is positional.
  const seenCodes = new Map();
  for (const [key, p] of DATA.PARTS) {
    const code = expectedPartCode(p);
    if (seenCodes.has(code)) throw new Error(`Two parts want the code ${code}: ${seenCodes.get(code)} and ${key}.`);
    seenCodes.set(code, key);

    const values = [
      { specCode: 'THICKNESS', value: p.thk },
      { specCode: 'LENGTH', value: p.len },
      { specCode: 'WIDTH', value: p.wid },
      { specCode: 'GRADE', value: DATA.GRADE },
      { specCode: 'IMPACT_CLASS', value: DATA.IMPACT_CLASS },
      { specCode: 'PART_FUNCTION', value: p.fn },
    ];
    // Only where the BOQ distinguishes: a part with no drilled/plain variant
    // leaves HOLED empty rather than claiming it is not drilled.
    if (p.holed !== null) values.push({ specCode: 'HOLED', value: p.holed });

    const item = await ensureItem(db, c, 'plate part', {
      classificationId: node.PLATE_PART,
      name: p.name,
      shortName: p.shortName,
      uom: 'nos',
      trackedBy: 'batch',
      sourcing: 'make',                       // a fabricated part is cut here, not bought
      values,
      expectCode: code,
    });
    const w = await weightOf(db, c.companyId, item.id);
    assertClose(`${item.code} (${p.name})`, w, p.unitKg, 0.01);
    built.parts[key] = { id: item.id, code: item.code, shortName: p.shortName, fn: p.fn, unitKg: p.unitKg, weight: w };
  }

  const partId = (key) => {
    const hit = built.parts[key];
    if (!hit) throw new Error(`No part built for BOM key ${key}.`);
    return hit.id;
  };
  const roleOf = (key) => FUNCTION_LABEL.get(DATA.PARTS.get(key).fn) ?? null;

  // --- 2. Girder segment designs -------------------------------------------
  for (const s of DATA.SEGMENTS) {
    const item = await ensureItem(db, c, 'girder segment', {
      classificationId: node.GIRDER_SEGMENT,
      name: s.name,
      shortName: 'GS',
      description: s.description,
      uom: 'nos', trackedBy: 'batch', sourcing: 'make',
    });
    await ensureBom(db, c, item.id, s.lines.map((l, i) => ({
      childId: partId(l.key), quantity: l.quantity, role: roleOf(l.key), lineNo: i + 1,
    })), s.name);
    const w = await weightOf(db, c.companyId, item.id);
    assertClose(`${item.code} (${s.ref} ${s.name})`, w, s.grossKg, 0.05);
    built.segments[s.ref] = { id: item.id, code: item.code, name: s.name, marks: s.marks, grossKg: s.grossKg, weight: w };
  }

  // --- 3. Sub-assemblies ---------------------------------------------------
  const SUB_NODE = { EDIA: 'DIAPHRAGM', IDIA: 'DIAPHRAGM', SPLC: 'SPLICE_SET' };
  for (const s of DATA.SUBS) {
    const item = await ensureItem(db, c, 'sub-assembly', {
      classificationId: node[SUB_NODE[s.short]],
      name: s.name,
      shortName: s.short,
      description: `${s.perSpan} per span. ${s.unitKg.toFixed(2)} kg each, per the BOQ.`,
      uom: 'nos', trackedBy: 'batch', sourcing: 'make',
    });
    await ensureBom(db, c, item.id, s.lines.map((l, i) => ({
      childId: partId(l.key), quantity: l.quantity, role: roleOf(l.key), lineNo: i + 1,
    })), s.name);
    const w = await weightOf(db, c.companyId, item.id);
    assertClose(`${item.code} (${s.ref} ${s.name})`, w, s.unitKg, 0.05);
    built.subs[s.ref] = { id: item.id, code: item.code, name: s.name, perSpan: s.perSpan, unitKg: s.unitKg, weight: w };
  }

  // --- 4. The shear stud ---------------------------------------------------
  // Bought finished, counted not batched, and weighed from its catalogue: there
  // is nothing to calculate and no BOM under it.
  const stud = await ensureItem(db, c, 'shear stud', {
    classificationId: node.SHEAR_STUD,
    name: DATA.STUD.name,
    shortName: DATA.STUD.short,
    description: `${DATA.STUD.perGirderLine} welded along each girder line.`,
    uom: 'nos', trackedBy: 'quantity', sourcing: 'stock',
    values: [{ specCode: 'WEIGHT', value: DATA.STUD.unitKg }],
  });
  const studWeight = await weightOf(db, c.companyId, stud.id);
  assertClose(`${stud.code} (${DATA.STUD.name})`, studWeight, DATA.STUD.unitKg, 0.001);
  built.stud = { id: stud.id, code: stud.code, name: DATA.STUD.name, unitKg: DATA.STUD.unitKg, weight: studWeight };

  return built;
}

// ---------------------------------------------------------------------------
// Verification — every number below is read back out of the database
// ---------------------------------------------------------------------------

/** What the BOQ says one span weighs. */
const STATED_PER_SPAN = DATA.BOQ.check.statedPerSpan;

async function verify(db, c, node) {
  say('\n================ VERIFY ================');

  const [rows] = await db.query(
    `SELECT m.id, m.code, m.name, m.status, n.code AS variant, i.uom, i.tracked_by, i.sourcing,
            (SELECT v.value_number FROM cf_spec_values v JOIN cf_specifications s ON s.id = v.specification_id
              WHERE v.company_id = m.company_id AND v.subject_type = 'master' AND v.subject_id = m.id
                AND s.code = 'WEIGHT' AND v.deleted_at IS NULL) AS weight,
            (SELECT b.status FROM cf_boms b WHERE b.company_id = m.company_id AND b.parent_id = m.id AND b.deleted_at IS NULL) AS bom_status,
            (SELECT COUNT(*) FROM cf_boms b JOIN cf_bom_lines l ON l.bom_id = b.id AND l.deleted_at IS NULL
              WHERE b.company_id = m.company_id AND b.parent_id = m.id AND b.deleted_at IS NULL) AS bom_lines
       FROM cf_master_records m
       JOIN cf_item_details i ON i.master_id = m.id AND i.deleted_at IS NULL
       JOIN cf_classification_nodes n ON n.id = m.classification_id
      WHERE m.company_id = ? AND m.record_kind = 'item' AND m.deleted_at IS NULL
        AND n.code IN ('PLATE_PART','GIRDER_SEGMENT','DIAPHRAGM','SPLICE_SET','SHEAR_STUD')
      ORDER BY FIELD(n.code,'PLATE_PART','GIRDER_SEGMENT','DIAPHRAGM','SPLICE_SET','SHEAR_STUD'), m.code`,
    [c.companyId],
  );

  // Expected weights, by the code each record should carry.
  const expected = new Map();
  for (const [, p] of DATA.PARTS) expected.set(p.name, p.unitKg);
  for (const s of DATA.SEGMENTS) expected.set(s.name, s.grossKg);
  for (const s of DATA.SUBS) expected.set(s.name, s.unitKg);
  expected.set(DATA.STUD.name, DATA.STUD.unitKg);

  say(`  ${'CODE'.padEnd(24)} ${'VARIANT'.padEnd(15)} ${'STORED kg'.padStart(12)} ${'EXPECTED kg'.padStart(12)}  ${'DIFF'.padStart(8)}  BOM        NAME`);
  let worst = 0;
  for (const r of rows) {
    const want = expected.get(r.name);
    const got = r.weight === null ? null : Number(r.weight);
    const diff = want != null && got != null ? got - want : null;
    if (diff !== null) worst = Math.max(worst, Math.abs(diff));
    say(`  ${String(r.code).padEnd(24)} ${r.variant.padEnd(15)} ${(got ?? 'NULL').toString().padStart(12)} ${(want ?? '-').toString().padStart(12)}  ${(diff === null ? '-' : diff.toFixed(4)).padStart(8)}  ${(r.bom_status ? `${r.bom_status}/${r.bom_lines}` : '-').padEnd(10)} ${r.name}`);
  }
  say(`  ${rows.length} items; largest weight difference ${worst.toFixed(4)} kg; ${rows.filter((r) => r.status !== 'active').length} not active.`);

  // --- the span, added up from the database ---------------------------------
  const bycode = new Map(rows.map((r) => [r.name, r]));
  const kgOf = (name) => {
    const r = bycode.get(name);
    if (!r || r.weight === null) throw new Error(`No stored weight for "${name}".`);
    return Number(r.weight);
  };
  const counts = new Map();
  for (const line of DATA.LINE_LAYOUT) for (const s of line.segments) counts.set(s.design, (counts.get(s.design) ?? 0) + 1);

  say('\n  one span, from the stored weights:');
  let total = 0;
  for (const s of DATA.SEGMENTS) {
    const n = counts.get(s.ref) ?? 0;
    const kg = kgOf(s.name) * n;
    total += kg;
    say(`    ${s.ref}  x${String(n).padStart(2)}  ${kgOf(s.name).toFixed(3).padStart(11)} kg  = ${kg.toFixed(2).padStart(11)} kg   (${s.marks.join(', ')})`);
  }
  for (const s of DATA.SUBS) {
    const kg = kgOf(s.name) * s.perSpan;
    total += kg;
    say(`    ${s.ref.padEnd(7)} x${String(s.perSpan).padStart(2)}  ${kgOf(s.name).toFixed(3).padStart(11)} kg  = ${kg.toFixed(2).padStart(11)} kg`);
  }
  const studCount = DATA.STUD.perGirderLine * DATA.SPAN.girderLines;
  const studKg = kgOf(DATA.STUD.name) * studCount;
  total += studKg;
  say(`    STUD    x${studCount}  ${kgOf(DATA.STUD.name).toFixed(3).padStart(11)} kg  = ${studKg.toFixed(2).padStart(11)} kg`);
  say(`    ${''.padEnd(36)}  TOTAL  ${total.toFixed(2).padStart(11)} kg`);
  say(`    the BOQ says                    ${STATED_PER_SPAN.toFixed(2).padStart(11)} kg per span  (difference ${(total - STATED_PER_SPAN).toFixed(2)} kg)`);
  const spans = DATA.ORDER_SPANS;
  say(`    ${spans} spans = ${(total * spans / 1000).toFixed(2)} MT; the BOQ says ${DATA.BOQ.check.statedTotalMt} MT`);
  if (Math.abs(total - STATED_PER_SPAN) > 1) throw new Error(`Span total is ${total.toFixed(2)} kg; the BOQ says ${STATED_PER_SPAN}.`);

  const [dupes] = await db.query(
    `SELECT code, COUNT(*) n FROM cf_master_records WHERE company_id = ? AND record_kind = 'item' AND code IS NOT NULL AND deleted_at IS NULL
      GROUP BY code HAVING n > 1`, [c.companyId],
  );
  say(`\n  duplicate item codes in the whole company: ${dupes.length}${dupes.length ? ` (${dupes.map((d) => d.code).join(', ')})` : ''}`);
  const [[counted]] = await db.query(
    `SELECT COUNT(*) AS n FROM cf_master_records m JOIN cf_classification_nodes n ON n.id = m.classification_id
      WHERE m.company_id = ? AND m.record_kind = 'item' AND m.deleted_at IS NULL
        AND n.code IN ('PLATE_PART','GIRDER_SEGMENT','DIAPHRAGM','SPLICE_SET','SHEAR_STUD')`, [c.companyId],
  );
  const wanted = DATA.PARTS.size + DATA.SEGMENTS.length + DATA.SUBS.length + 1;
  say(`  items in the bridge tree: ${counted.n} (expected ${wanted})`);
  if (Number(counted.n) !== wanted) throw new Error(`Expected ${wanted} items in the bridge tree, found ${counted.n}.`);
  return total;
}

// ---------------------------------------------------------------------------

const conn = await pool.getConnection();
try {
  const [[company]] = await conn.query('SELECT id, name FROM companies WHERE id = ?', [COMPANY]);
  if (!company) throw new Error(`No company ${COMPANY}.`);
  const [[user]] = await conn.query('SELECT id FROM users WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [COMPANY]);
  const c = { companyId: COMPANY, userId: user?.id ?? null };
  say(`cf_erp bridge catalog -> company ${COMPANY} (${company.name}), acting as user ${c.userId}`);
  say(`source: cf_bridge_data.mjs — ${DATA.PARTS.size} parts, ${DATA.SEGMENTS.length} segment designs, ${DATA.SUBS.length} sub-assemblies, 1 stud`);

  const node = await nodeIdsByCode(conn, COMPANY, [
    'PLATE_PART', 'PROFILE_PART', 'GIRDER_SEGMENT', 'DIAPHRAGM', 'SPLICE_SET', 'GIRDER_LINE', 'BRIDGE_SPAN', 'SHEAR_STUD',
  ]);

  let built = null;
  if (!VERIFY_ONLY) {
    say('\n== build ==');
    await conn.beginTransaction();
    attachNodeCache(conn);
    try { built = await build(conn, c, node); detachNodeCache(conn); await conn.commit(); } catch (e) { detachNodeCache(conn); await conn.rollback(); throw e; }
    say('  created:', JSON.stringify(tally.created));
    say('  reused :', JSON.stringify(tally.reused));
  }

  const total = await verify(conn, c, node);

  if (built) {
    // Written last and only once everything above has passed: another script
    // waits on this file to know the catalog is really there.
    fs.writeFileSync(MARKER, `${JSON.stringify({
      companyId: COMPANY,
      writtenAt: new Date().toISOString(),
      spanKg: Number(total.toFixed(2)),
      nodes: node,
      parts: built.parts,
      segments: built.segments,
      subs: built.subs,
      stud: built.stud,
      layout: DATA.LINE_LAYOUT,
    }, null, 2)}\n`);
    say(`\n  marker written: ${MARKER}`);
  }
  say('\ndone.');
} finally {
  conn.release();
  await pool.end();
}
