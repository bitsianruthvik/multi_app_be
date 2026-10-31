/**
 * rdso-sheet-files.mjs — give each RDSO series sheet in the drawing register its own FILE, so the span, girder, segment,
 * diaphragm … levels open their sheet in the drawing viewer instead of "kept at its issuer's site". DRY RUN BY DEFAULT
 * (read-only, every statement checked); --commit writes.
 *
 *   cd multi_app_be
 *   node scripts/cf_kepl/rdso-sheet-files.mjs --company 30005 --prod              dry run on production
 *   node scripts/cf_kepl/rdso-sheet-files.mjs --company 30005 --prod --commit     writes
 *
 * WHY (user, 2026-10-31: "the span and other levels should also have the drawings — we have drawings at every level").
 * The sheets were registered as links to the series PDF on RDSO's site (`url` …#page=N, rdso-sheets-attach.mjs), never as
 * files; the series PDFs are 40–60 MB scans, too big to keep whole. Each page is already rendered at ~10,700 px in
 * TM/drawing_bom/out/<SET>/pages/sheet<N>.png; this scales it to 5,000 px, JPEG q70 (~1.5 MB), wraps it in a one-page PDF
 * and stores it in cf_standard_drawing_files (kind 'source', drawing_id = the sheet) — where registerFile and the
 * drawing tree already look. The link stays. Only rows are inserted; nothing is changed or removed. IDEMPOTENT: a sheet
 * that already has a file is skipped. One sheet per transaction.
 */
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath, pathToFileURL } from 'url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const COMPANY = Number(arg('company'));
const COMMIT = process.argv.includes('--commit');
if (!Number.isInteger(COMPANY) || COMPANY <= 0) {
  console.error('Usage: node scripts/cf_kepl/rdso-sheet-files.mjs --company <id> [--prod] [--commit]');
  process.exit(2);
}
if (process.argv.includes('--prod')) {
  const env = {};
  fs.readFileSync(path.join(__dir, '..', '..', '..', '.env.tidb'), 'utf8').split('\n').forEach((l) => {
    l = l.trim(); if (!l || l.startsWith('#')) return;
    const [k, ...r] = l.split('='); env[k.trim()] = r.join('=').trim();
  });
  Object.assign(process.env, { DB_HOST: env.DB_HOST, DB_PORT: env.DB_PORT ?? '4000', DB_USER: env.DB_USER, DB_PASSWORD: env.DB_PASSWORD, DB_NAME: env.DB_NAME, DB_SSL: 'true' });
}
const BE = path.join(__dir, '..', '..');
const OUT = path.join(BE, '..', 'drawing_bom', 'out');
const { createCanvas, loadImage } = createRequire(path.join(BE, '..', 'drawing_bom', 'package.json'))('@napi-rs/canvas');
const { pool, isReadOnlySql } = await import(pathToFileURL(path.join(BE, 'db.js')).href);

const where = process.env.DB_HOST && !/^(localhost|127\.0\.0\.1)$/.test(process.env.DB_HOST) ? 'PRODUCTION' : 'local';
const refuse = (sql) => { throw new Error(`read-only — refused: ${String(sql?.sql ?? sql).slice(0, 80)}`); };
const ro = { query: (sql, ...rest) => (isReadOnlySql(sql) ? pool.query(sql, ...rest) : refuse(sql)) };
const [[co]] = await ro.query('SELECT id, name FROM companies WHERE id = ?', [COMPANY]);
if (!co) { console.error(`No company ${COMPANY}.`); process.exit(1); }
console.log(`${where} — company ${co.id} ${co.name} — ${COMMIT ? 'COMMIT (writes)' : 'DRY RUN (read-only)'}`);

const bare = (u) => String(u ?? '').replace(/#.*$/, '').trim();

// The series PDF link → its rendered pages.
const sets = new Map();
for (const d of fs.readdirSync(OUT)) {
  const f = path.join(OUT, d, 'bom.json');
  if (!fs.existsSync(f)) continue;
  const url = bare(JSON.parse(fs.readFileSync(f, 'utf8')).drawing?.sourceUrl);
  if (url) sets.set(url, path.join(OUT, d, 'pages'));
}

// A standard of each series (cf_standard_drawing_files.standard_id is required).
const [stds] = await ro.query(
  `SELECT s.id, s.source_url, d.url FROM cf_standard_drawings s LEFT JOIN cf_drawings d ON d.company_id = s.company_id AND d.id = s.drawing_id
    WHERE s.company_id = ? AND s.deleted_at IS NULL ORDER BY s.id`, [COMPANY]);
const stdOf = new Map();
for (const s of stds) for (const u of [bare(s.source_url), bare(s.url)]) if (u && !stdOf.has(u)) stdOf.set(u, Number(s.id));

const [regs] = await ro.query(
  `SELECT d.id, d.number, d.revision, d.url FROM cf_drawings d
    WHERE d.company_id = ? AND d.deleted_at IS NULL AND d.url LIKE '%rdso%'
      AND NOT EXISTS (SELECT 1 FROM cf_standard_drawing_files f WHERE f.company_id = d.company_id AND f.drawing_id = d.id AND f.file_text IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM cf_part_drawings p WHERE p.company_id = d.company_id AND p.drawing_id = d.id AND p.dxf_text IS NOT NULL)
    ORDER BY d.id`, [COMPANY]);

/** A one-page PDF holding one JPEG, the page sized to the image at 150 dpi. */
function jpegPdf(jpg, w, h) {
  const pw = (w * 72 / 150).toFixed(2), ph = (h * 72 / 150).toFixed(2);
  const content = Buffer.from(`q ${pw} 0 0 ${ph} 0 0 cm /Im0 Do Q`);
  const objs = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`),
    Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpg.length} >>\nstream\n`), jpg, Buffer.from('\nendstream')]),
    Buffer.concat([Buffer.from(`<< /Length ${content.length} >>\nstream\n`), content, Buffer.from('\nendstream')]),
  ];
  const parts = [Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1')];
  const offsets = [];
  let pos = parts[0].length;
  objs.forEach((o, i) => {
    const b = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), o, Buffer.from('\nendobj\n')]);
    offsets.push(pos); parts.push(b); pos += b.length;
  });
  const xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${pos}\n%%EOF\n`;
  parts.push(Buffer.from(xref));
  return Buffer.concat(parts);
}

// TiDB refuses a row entry over 6 MB and the file goes in as base64 (+33%): keep each PDF under 2.5 MB.
const MAX_PDF = 2.5e6;
async function sheetPdf(png) {
  const img = await loadImage(png);
  for (const [width, q] of [[5000, 70], [5000, 55], [4200, 55], [3600, 50]]) {
    const w = Math.min(width, img.width), h = Math.round(img.height * w / img.width);
    const c = createCanvas(w, h);
    const x = c.getContext('2d');
    x.fillStyle = '#fff'; x.fillRect(0, 0, w, h);
    x.drawImage(img, 0, 0, w, h);
    const pdf = jpegPdf(await c.encode('jpeg', q), w, h);
    if (pdf.length <= MAX_PDF || width === 3600) return pdf;
  }
}
if (process.argv.includes('--sample')) {
  // Writes one sheet's PDF to the given path, to look at it before a run.
  const [setDir, page, outFile] = process.argv.slice(process.argv.indexOf('--sample') + 1);
  fs.writeFileSync(outFile, await sheetPdf(path.join(OUT, setDir, 'pages', `sheet${page}.png`)));
  console.log('wrote', outFile); await pool.end(); process.exit(0);
}

let done = 0, skipped = 0, bytes = 0;
for (const r of regs) {
  const url = bare(r.url);
  const page = Number(/#page=(\d+)/.exec(r.url ?? '')?.[1] ?? 1);
  const pages = sets.get(url);
  const png = pages && path.join(pages, `sheet${page}.png`);
  const std = stdOf.get(url);
  if (!png || !fs.existsSync(png) || !std) {
    console.log(`  skip #${r.id} ${r.number} rev ${r.revision}: ${!pages ? 'no rendered pages for its series' : !std ? 'no standard of its series' : `no page ${page}`}`);
    skipped++; continue;
  }
  const pdf = await sheetPdf(png);
  const name = `${r.number}_rev_${r.revision}.pdf`.replace(/[\\/]+/g, '-');
  bytes += pdf.length;
  console.log(`  #${r.id} ${r.number} rev ${r.revision} ← ${path.basename(path.dirname(pages))} page ${page} (${(pdf.length / 1e6).toFixed(2)} MB) as ${name}`);
  if (COMMIT) {
    await pool.query(
      `INSERT INTO cf_standard_drawing_files (company_id, version_id, standard_id, kind, drawing_id, mark, mark_norm, file_name, file_kind, file_text)
       VALUES (?, NULL, ?, 'source', ?, NULL, NULL, ?, 'pdf', ?)`,
      [COMPANY, std, Number(r.id), name, pdf.toString('base64')]);
  }
  done++;
}
console.log(`${done} sheet(s) ${COMMIT ? 'given a file' : 'would get a file'} (${(bytes / 1e6).toFixed(1)} MB), ${skipped} skipped.`);
await pool.end();
