// Read-only SQL Server 2008 R2 .mdf reader → SQLite working copy.
//   node mdfread.mjs <file.mdf> <out.sqlite> [--only=a,b,c]
// The .mdf is opened 'r' and never written.
import fs from 'fs';
import { DatabaseSync } from 'node:sqlite';

const [file, outPath] = process.argv.slice(2);
const only = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);
const PAGE = 8192;
const fd = fs.openSync(file, 'r');
const pages = fs.fstatSync(fd).size / PAGE;

/** Puts back the 2 bits torn-page protection swapped out of each sector's last byte. */
function fixTorn(p) {
  if (!(p.readUInt16LE(4) & 0x0100)) return;
  const torn = p.readUInt32LE(60);
  for (let i = 2; i <= 16; i++) {
    const at = i * 512 - 1;
    const bits = (torn >>> (2 * (i - 1))) & 3;
    p[at] = (p[at] & 0xfc) | bits;
  }
}

function* scan() {
  const buf = Buffer.alloc(PAGE * 2048);
  let n = 0;
  while (n < pages) {
    const got = fs.readSync(fd, buf, 0, buf.length, n * PAGE);
    const c = Math.floor(got / PAGE);
    if (!c) break;
    for (let i = 0; i < c; i++) yield [n + i, buf.subarray(i * PAGE, (i + 1) * PAGE)];
    n += c;
  }
}

function varsOf(p, off) {
  const statusA = p[off];
  const fixedEnd = p.readUInt16LE(off + 2);
  let q = off + fixedEnd;
  const colCount = p.readUInt16LE(q); q += 2;
  const bmLen = (colCount + 7) >> 3;
  const bitmap = p.subarray(q, q + bmLen); q += bmLen;
  const vars = [];
  if (statusA & 0x20) {
    const n = p.readUInt16LE(q); q += 2;
    let start = q + n * 2;
    for (let i = 0; i < n; i++) {
      const raw = p.readUInt16LE(q + i * 2);
      const stop = off + (raw & 0x7fff);
      vars.push({ start, stop, complex: !!(raw & 0x8000) });
      start = stop;
    }
  }
  return { fixedEnd, colCount, bitmap, vars };
}

// ─── Pass 1: allocation map and catalog ───
const allocated = new Uint8Array(pages);
const objects = new Map();
const colpars = new Map();
const rowsets = new Map();
const allocs = new Map();
const rscols = new Map();

for (const [no, p] of scan()) {
  const t = p[1];
  if (t === 11) {
    // PFS: one byte per page from offset 100; 0x40 = allocated.
    fixTorn(p);
    for (let i = 0; i < 8088 && no + i < pages; i++) if (p[100 + i] & 0x40) allocated[no + i] = 1;
    continue;
  }
  if (t !== 1) continue;
  const obj = p.readInt32LE(24);
  if (p.readUInt16LE(6) > 1 || ![3, 5, 7, 34, 41].includes(obj) || p[3] !== 0) continue;
  fixTorn(p);
  const slots = p.readUInt16LE(22);
  for (let s = 0; s < slots; s++) {
    const off = p.readUInt16LE(PAGE - 2 - s * 2);
    if (off < 96 || off > PAGE - 8) continue;
    if ((p[off] >> 1) & 7) continue;
    const f = off + 4;
    if (obj === 34) {
      const { vars } = varsOf(p, off);
      if (!vars.length) continue;
      const id = p.readInt32LE(f);
      objects.set(id, {
        id,
        name: p.subarray(vars[0].start, vars[0].stop).toString('utf16le'),
        type: p.subarray(f + 13, f + 15).toString('latin1').trim(),
      });
    } else if (obj === 41) {
      const { vars } = varsOf(p, off);
      if (!vars.length) continue;
      const id = p.readInt32LE(f);
      if (p.readInt16LE(f + 4) !== 0 && p[f + 10] === 0) continue;
      if (!colpars.has(id)) colpars.set(id, new Map());
      colpars.get(id).set(p.readInt32LE(f + 6), {
        name: p.subarray(vars[0].start, vars[0].stop).toString('utf16le'),
        xtype: p[f + 10],
      });
    } else if (obj === 5) {
      rowsets.set(p.readBigInt64LE(f), {
        idmajor: p.readInt32LE(f + 9),
        idminor: p.readInt32LE(f + 13),
        rows: Number(p.readBigInt64LE(f + 27)),
      });
    } else if (obj === 7) {
      // auid, type tinyint, ownerid
      allocs.set(p.readBigInt64LE(f), { type: p[f + 8], owner: p.readBigInt64LE(f + 9) });
    } else if (obj === 3) {
      const rsid = p.readBigInt64LE(f);
      const ti = p.readInt32LE(f + 24);
      if (!rscols.has(rsid)) rscols.set(rsid, []);
      rscols.get(rsid).push({
        rscolid: p.readInt32LE(f + 8),
        hbcolid: p.readInt32LE(f + 12),
        xtype: ti & 0xff,
        prec: (ti >>> 8) & 0xff,
        scale: (ti >>> 16) & 0xff,
        status: p.readInt32LE(f + 36),
        offset: p.readInt16LE(f + 40),
        nullbit: p.readInt32LE(f + 44),
        bitpos: p.readInt16LE(f + 48) & 0xff,
      });
    }
  }
}

// ─── Layouts: base rowset (heap or clustered) of each user table ───
const SKIP = new Set([34, 35, 99, 98, 241]); // image, text, ntext, variant, xml
const sqlType = (x) => ({ 48: 'INTEGER', 52: 'INTEGER', 56: 'INTEGER', 127: 'INTEGER', 104: 'INTEGER', 59: 'REAL', 62: 'REAL', 60: 'REAL', 122: 'REAL', 106: 'REAL', 108: 'REAL' }[x] || 'TEXT');
const tables = new Map();
const mismatches = [];
for (const [rsid, rs] of rowsets) {
  if (rs.idminor > 1) continue;
  const o = objects.get(rs.idmajor);
  if (!o || o.type !== 'U') continue;
  if (only.length && !only.includes(o.name)) continue;
  const cols = [];
  for (const rc of rscols.get(rsid) || []) {
    if (rc.status & 2) continue; // dropped
    const cp = colpars.get(o.id)?.get(rc.rscolid);
    if (!cp) continue; // uniqueifier
    if (cp.xtype !== rc.xtype) mismatches.push(`${o.name}.${cp.name} ${cp.xtype}/${rc.xtype}`);
    cols.push({ ...rc, name: cp.name });
  }
  tables.set(rsid, { rsid, name: o.name, rows: rs.rows, cols, read: 0 });
}
console.log(`catalog: ${objects.size} objects, ${tables.size} tables to read, type mismatches ${mismatches.length}`, mismatches.slice(0, 5));

// ─── Value decoding ───
function dt(days, ms) {
  return new Date(Date.UTC(1900, 0, 1 + days) + ms).toISOString().slice(0, 19).replace('T', ' ');
}
const LEN = { 48: 1, 52: 2, 56: 4, 127: 8, 59: 4, 62: 8, 60: 8, 122: 4, 61: 8, 58: 4 };
function fixedVal(c, p, at) {
  switch (c.xtype) {
    case 48: return p[at];
    case 52: return p.readInt16LE(at);
    case 56: return p.readInt32LE(at);
    case 127: return Number(p.readBigInt64LE(at));
    case 59: return p.readFloatLE(at);
    case 62: return p.readDoubleLE(at);
    case 60: return Number(p.readBigInt64LE(at).valueOf ? (BigInt.asIntN(64, (p.readBigInt64LE(at) >> 32n) | (p.readBigUInt64LE(at) << 32n))) : 0n) / 10000;
    case 122: return p.readInt32LE(at) / 10000;
    case 61: { const days = p.readInt32LE(at + 4); const ticks = p.readInt32LE(at); return (days < -30000 || days > 90000) ? null : dt(days, Math.round(ticks * (10 / 3))); }
    case 58: return dt(p.readUInt16LE(at + 2), p.readUInt16LE(at) * 60000);
    case 104: return (p[at] >> c.bitpos) & 1;
    case 40: { const d = p[at] | (p[at + 1] << 8) | (p[at + 2] << 16); return new Date(Date.UTC(1, 0, 1 + d)).toISOString().slice(0, 10); }
    case 106: case 108: {
      const n = c.prec <= 9 ? 5 : c.prec <= 19 ? 9 : c.prec <= 28 ? 13 : 17;
      let v = 0n;
      for (let i = n - 1; i >= 1; i--) v = (v << 8n) | BigInt(p[at + i]);
      const r = Number(v) / 10 ** c.scale;
      return p[at] === 1 ? r : -r;
    }
    case 175: { let n = fixedLen(c); return p.subarray(at, at + n).toString('latin1').trimEnd(); }
    case 239: { let n = fixedLen(c); return p.subarray(at, at + n).toString('utf16le').trimEnd(); }
    default: return null;
  }
}
const fixedLen = (c) => c.width;
function varVal(c, slice) {
  if (c.xtype === 167) return slice.toString('latin1');
  if (c.xtype === 231) return slice.toString('utf16le');
  return null;
}

// ─── Output ───
if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
const db = new DatabaseSync(outPath);
db.exec('PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF;');
const q = (s) => `"${s.replace(/"/g, '""')}"`;
const auToTable = new Map();
for (const [auid, a] of allocs) {
  if (a.type !== 1) continue; // in-row data
  const t = tables.get(a.owner);
  if (t) auToTable.set(auid, t);
}
for (const t of tables.values()) {
  t.cols = t.cols.filter((c) => !SKIP.has(c.xtype));
  // Width of fixed columns: gap to the next fixed column, or the table's own fixed end.
  const fixed = t.cols.filter((c) => c.offset > 0).sort((a, b) => a.offset - b.offset);
  for (let i = 0; i < fixed.length; i++) {
    const c = fixed[i];
    c.width = LEN[c.xtype] ?? null;
    if (c.width == null && (c.xtype === 175 || c.xtype === 239)) c.width = (fixed[i + 1]?.offset ?? 0) - c.offset;
    if (c.width != null && c.width < 0) c.width = 0;
  }
  t.lastFixed = fixed.at(-1);
  db.exec(`CREATE TABLE ${q(t.name)} (${t.cols.map((c) => `${q(c.name)} ${sqlType(c.xtype)}`).join(', ')})`);
  t.ins = db.prepare(`INSERT INTO ${q(t.name)} VALUES (${t.cols.map(() => '?').join(',')})`);
}

// ─── Pass 2: rows ───
db.exec('BEGIN');
let total = 0; let skippedUnalloc = 0; let bad = 0;
for (const [no, p] of scan()) {
  if (p[1] !== 1 || p[3] !== 0) continue;
  const auid = (BigInt(p.readUInt16LE(6)) << 48n) | (BigInt(p.readUInt32LE(24)) << 16n);
  const t = auToTable.get(auid);
  if (!t) continue;
  if (!allocated[no]) { skippedUnalloc += 1; continue; }
  fixTorn(p);
  const slots = p.readUInt16LE(22);
  for (let s = 0; s < slots; s++) {
    const off = p.readUInt16LE(PAGE - 2 - s * 2);
    if (off < 96 || off > PAGE - 8) continue;
    const rt = (p[off] >> 1) & 7;
    if (rt !== 0 && rt !== 1) continue;
    try {
      const { fixedEnd, colCount, bitmap, vars } = varsOf(p, off);
      const row = [];
      for (const c of t.cols) {
        const nb = c.nullbit - 1;
        const isNull = nb >= 0 && (nb >= colCount || (bitmap[nb >> 3] >> (nb & 7)) & 1);
        if (isNull) { row.push(null); continue; }
        if (c.offset > 0) {
          if (c.offset >= fixedEnd) { row.push(null); continue; }
          if ((c.xtype === 175 || c.xtype === 239) && (c.width == null || c.width <= 0)) c.width = fixedEnd - c.offset;
          row.push(fixedVal(c, p, off + c.offset));
        } else {
          const v = vars[-c.offset - 1];
          if (!v || v.complex || v.stop < v.start) { row.push(null); continue; }
          row.push(varVal(c, p.subarray(v.start, v.stop)));
        }
      }
      t.ins.run(...row);
      t.read += 1; total += 1;
    } catch (e) {
      bad += 1;
      if (bad <= 5) console.log('bad row', t.name, e.message);
    }
  }
}
db.exec('COMMIT');
db.close();
const list = [...tables.values()].sort((a, b) => b.rows - a.rows);
console.log(`rows ${total}, bad ${bad}, data pages not allocated ${skippedUnalloc}`);
console.log('table | catalog rows | rows read | diff');
let off = 0;
for (const t of list) {
  const d = t.read - t.rows;
  if (d !== 0) off += 1;
  if (d !== 0 || list.length < 25) console.log(`${t.name} | ${t.rows} | ${t.read} | ${d}`);
}
console.log(`tables with a different count: ${off} of ${list.length}`);
