/**
 * nest_v2_demo.mjs — data for a manual browser pass of the Nesting v2 screens. Local only.
 *
 *   cd multi_app_be
 *   node scripts/cf_kepl/nest_v2_demo.mjs up     committed fixture (frozen, not released, with part drawings)
 *                                                + DXF files in TM/_nest_demo/{A_full,B_full_other,C_partial,D_extra_plate,E_errors}
 *   node scripts/cf_kepl/nest_v2_demo.mjs down   deletes every row made for the company since `up` (the id-watermark
 *                                                method of nest_v2_http_test.mjs), the folder and the state file
 *
 * CF_NEST_COMPANY=2 (pharma_labs). The state file (TM/_nest_demo_state.json) keeps the AUTO_INCREMENT
 * watermarks, the start time and every cf_ table's count so `down` can run in a later process.
 */
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const mode = process.argv[2];
if (!['up', 'down'].includes(mode)) { console.error('usage: node scripts/cf_kepl/nest_v2_demo.mjs up|down'); process.exit(2); }

const { pool } = await imp('db.js');
if (!/^(localhost|127\.0\.0\.1|::1)$/.test(process.env.DB_HOST ?? 'localhost')) throw new Error('This script is local only.');
const TM = path.resolve(BE, '..');
const DEMO_DIR = path.join(TM, '_nest_demo');
const STATE = path.join(TM, '_nest_demo_state.json');
const COMPANY = Number(process.env.CF_NEST_COMPANY ?? 2);

const [tables] = await pool.query("SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME LIKE 'cf\\_%' ORDER BY TABLE_NAME");
const counts = async () => Object.fromEntries((await pool.query(tables.map((t) => `SELECT '${t.name}' AS name,COUNT(*) AS n FROM \`${t.name}\``).join(' UNION ALL ')))[0].map((r) => [r.name, Number(r.n)]));

async function tableMeta() {
  const [colRows] = await pool.query("SELECT TABLE_NAME t, COLUMN_NAME c, EXTRA e FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME LIKE 'cf\\_%'");
  const meta = new Map(tables.map((t) => [t.name, { name: t.name, auto: null, company: false, created: false }]));
  for (const r of colRows) {
    const m = meta.get(r.t); if (!m) continue;
    if (/auto_increment/i.test(r.e)) m.auto = r.c;
    if (r.c === 'company_id') m.company = true;
    if (r.c === 'created_at') m.created = true;
  }
  return meta;
}

/* ───────────────────────────── up ───────────────────────────── */

async function up() {
  if (fs.existsSync(STATE)) throw new Error(`${STATE} exists: run "down" first.`);
  const { attachNodeCache, detachNodeCache } = await imp('apps/cf_erp/lib/db.js');
  await imp('apps/cf_erp/services/codegenProvider.js');
  const F = await imp('scripts/cf_kepl/lib/nestV2Fixture.mjs');
  const D = await imp('scripts/cf_kepl/lib/nestDxfFixtures.mjs');
  const RD = await imp('apps/cf_erp/lib/nestDxfReader.js');

  const meta = await tableMeta();
  const before = await counts();
  const maxId = {};
  const autos = [...meta.values()].filter((m) => m.auto);
  const [mx] = await pool.query(autos.map((m) => `SELECT '${m.name}' AS name, COALESCE(MAX(\`${m.auto}\`),0) AS mx FROM \`${m.name}\``).join(' UNION ALL '));
  for (const r of mx) maxId[r.name] = Number(r.mx);
  const [[{ startedAt }]] = await pool.query("SELECT DATE_FORMAT(NOW() - INTERVAL 5 SECOND, '%Y-%m-%d %H:%i:%s') AS startedAt");
  const [[slugRow]] = await pool.query('SELECT slug FROM companies WHERE id = ?', [COMPANY]);

  // Written BEFORE the build so a crash half way can still be cleaned up by `down`.
  fs.writeFileSync(STATE, JSON.stringify({ company: COMPANY, startedAt, maxId, before, meta: [...meta.values()], fx: null }, null, 2));

  let fx;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    attachNodeCache(conn);
    fx = await F.buildFixture(conn, { company: COMPANY });   // drawings: true by default
    await conn.commit();
  } catch (e) { try { await conn.rollback(); } catch { /* original error matters */ } throw e; } finally { detachNodeCache(conn); conn.release(); }

  const sets = F.nestings(fx);
  const PS = { length: 3000, width: 1500 };
  const name = (k) => `${fx.tag}-${k}_${F.T}mm_3000x1500.dxf`;

  // C_partial: files from the complete nestings until ~60 % of the pieces are covered (no plate-less file).
  const need = fx.parts;
  const total = Object.values(need).reduce((a, p) => a + p.qty, 0);
  const partial = [];
  let covered = 0;
  for (const f of [...sets.C, ...sets.B]) {
    if (covered >= 0.6 * total) break;
    if (f.style === 'segments') continue;
    partial.push(f);
    covered += f.parts.length;
  }

  const extra = F.nestFile(`${fx.tag}-E1_${F.T}mm_3000x1500.dxf`, PS, F.rows(fx, [['H']], PS));
  const errors = [
    [F.nestFile(name('X1-overlap'), PS, [F.place(fx, 'R', 100, 100), F.place(fx, 'R', 700, 300)]), 'two parts overlapping -> OVERLAP, cannot save'],
    [F.nestFile(name('X2-off-plate'), PS, [F.place(fx, 'R', 100, 100), F.place(fx, 'R', 2400, 600)]), 'a part hanging off the plate edge -> error, cannot save'],
    [F.nestFile(name('X4-unknown-part'), PS, [F.place(fx, 'R', 100, 100), { shape: D.rectShape(333, 222), x: 1500, y: 100, label: 'ZZ-9' }]), 'a part ZZ-9 that is not on the line -> unknown part'],
    [F.nestFile(`${fx.tag}-X7-wrong-thickness_${F.T + 2}mm_3000x1500.dxf`, PS, [F.place(fx, 'R', 100, 100)]), `title says ${F.T + 2} mm, the line is ${F.T} mm -> wrong thickness`],
  ];

  fs.rmSync(DEMO_DIR, { recursive: true, force: true });
  const written = [];
  const put = (dir, f, note) => {
    fs.mkdirSync(path.join(DEMO_DIR, dir), { recursive: true });
    fs.writeFileSync(path.join(DEMO_DIR, dir, f.filename), Buffer.from(f.text, 'latin1'));
    written.push({ dir, f, note });
  };
  const styleNote = (f) => `${f.style}, ${f.parts.length} parts on ${f.plate.length} x ${f.plate.width}`
    + (f.style === 'segments' ? `; NO plate drawn: pick the plate ${fx.plateCode('PS')} (3000 x 1500) when asked` : '');
  for (const f of sets.A) put('A_full', f, `complete nesting 1 (${styleNote(f)})`);
  for (const f of sets.B) put('B_full_other', f, `complete nesting 2, other arrangement (${styleNote(f)})`);
  for (const f of partial) put('C_partial', f, `part of a nesting (${styleNote(f)})`);
  put('D_extra_plate', extra, 'one extra plate with a shim H: over-covers after A or B is saved -> OVER_COVERAGE, needs force');
  for (const [f, note] of errors) put('E_errors', f, note);

  const pct = Math.round((100 * covered) / total);
  const readme = [
    `Nesting v2 demo — order ${fx.tag}-SO (id ${fx.orderId}), line ${fx.lineId}, ${total} pieces, thickness ${F.T} mm, plate ${fx.plateCode('PS')}.`,
    `Open: http://cf.localhost:5180/${slugRow.slug}/cf_erp/orders/${fx.orderId}`,
    '',
    'A_full/         upload both files together -> every piece covered (polyline style; 2 plates).',
    'B_full_other/   a different complete nesting: 5 plates (blocks, loose segments, inches, free angles). Use it for Compare / replace against A.',
    `C_partial/      about ${pct} % of the pieces -> the rest is "left over" and can be nested automatically.`,
    'D_extra_plate/  one more plate after A or B is saved -> over-coverage, saved only with force.',
    'E_errors/       one file each, none can be saved.',
    '',
    'Files:',
    ...written.map((w) => `  ${w.dir}/${w.f.filename}\n      ${w.note}`),
    '',
    'Remove all of this with: node scripts/cf_kepl/nest_v2_demo.mjs down',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(DEMO_DIR, 'README.txt'), readme);

  // Read A, B and C back through the reader.
  for (const dir of ['A_full', 'B_full_other', 'C_partial']) {
    for (const w of written.filter((x) => x.dir === dir)) {
      const text = fs.readFileSync(path.join(DEMO_DIR, dir, w.f.filename), 'latin1');
      const r = RD.readNestDxf(text, { filename: w.f.filename });
      console.error(`  read ${dir}/${w.f.filename}: ${Array.isArray(r?.parts) ? r.parts.length : '?'} parts`);
    }
  }

  const state = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  state.fx = { tag: fx.tag, orderId: fx.orderId, lineId: fx.lineId, slug: slugRow.slug };
  fs.writeFileSync(STATE, JSON.stringify(state, null, 2));

  console.log(JSON.stringify({
    orderId: fx.orderId, orderCode: `${fx.tag}-SO`, lineId: fx.lineId,
    url: `http://cf.localhost:5180/${slugRow.slug}/cf_erp/orders/${fx.orderId}`, stateFile: STATE,
    files: written.map((w) => `${w.dir}/${w.f.filename}`),
  }, null, 2));
}

/* ───────────────────────────── down ───────────────────────────── */

async function down() {
  if (!fs.existsSync(STATE)) throw new Error(`No state file (${STATE}): nothing to clean up.`);
  const st = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  const { maxId, startedAt, before } = st;
  const COMP = st.company;
  const R = await imp('apps/cf_erp/services/nestRunService.js');
  await R.settleRuns().catch(() => {});

  const removed = {};
  const conn = await pool.getConnection();
  try {
    await conn.query('SET FOREIGN_KEY_CHECKS = 0');
    const guard = (m) => (m.created ? ' AND (created_at IS NULL OR created_at >= ?)' : '');
    const args = (m, base) => (m.created ? [...base, startedAt] : base);
    for (const m of st.meta) {
      if (!m.company) continue;
      let n = 0;
      if (m.auto) {
        if (m.created) {
          const [[f]] = await conn.query(`SELECT COUNT(*) n FROM \`${m.name}\` WHERE company_id = ? AND \`${m.auto}\` > ? AND created_at < ?`, [COMP, maxId[m.name], startedAt]);
          if (Number(f.n)) console.log(`  NOTE  ${m.name}: ${f.n} row(s) above the snapshot id were created before the run started — left alone (another process)`);
        }
        const [r] = await conn.query(`DELETE FROM \`${m.name}\` WHERE company_id = ? AND \`${m.auto}\` > ?${guard(m)}`, args(m, [COMP, maxId[m.name]]));
        n = r.affectedRows;
      } else if (m.name === 'cf_item_details') {
        const [r] = await conn.query(`DELETE FROM cf_item_details WHERE company_id = ? AND master_id > ?${guard(m)}`, args(m, [COMP, maxId.cf_master_records]));
        n = r.affectedRows;
      } else if (m.created) {
        const [r] = await conn.query(`DELETE FROM \`${m.name}\` WHERE company_id = ? AND created_at >= ?`, [COMP, startedAt]);
        n = r.affectedRows;
      }
      if (n) removed[m.name] = n;
    }
  } finally {
    try { await conn.query('SET FOREIGN_KEY_CHECKS = 1'); } catch { /* released next */ }
    conn.release();
  }

  const after = await counts();
  const drift = Object.keys(before).filter((t) => after[t] !== before[t]).map((t) => `${t} ${before[t]}->${after[t]}`);
  fs.rmSync(DEMO_DIR, { recursive: true, force: true });
  fs.rmSync(STATE, { force: true });
  console.log(JSON.stringify({
    removedPerTable: removed,
    totalRemoved: Object.values(removed).reduce((a, b) => a + b, 0),
    countsBack: drift.length === 0,
    drift,
    folderRemoved: !fs.existsSync(DEMO_DIR),
    stateFileRemoved: !fs.existsSync(STATE),
  }, null, 2));
}

try {
  if (mode === 'up') await up(); else await down();
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  await pool.end();
}
