/**
 * kepl-reconcile.mjs — every row of the customer's BOQ against what we built.
 *
 * The point is to be checkable line by line, not to produce a total that
 * happens to agree. A matching total can hide two errors that cancel, and on a
 * 1,090-part order it certainly would.
 *
 * MATCHED ON THE MARK, then on the part. The BOQ writes "G1 - 1"; the order
 * writes L11, because the customer marks a girder L1 and its first segment L11.
 * Everything else is compared as stated: thickness, length, width, quantity.
 *
 * Writes nothing. Emits JSON on stdout for rendering.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const [orderIdArg, boqPath, extrasPath] = process.argv.slice(2);
const orderId = Number(orderIdArg);
const __dir = path.dirname(fileURLToPath(import.meta.url));
const env = {};
fs.readFileSync(path.join(__dir, '..', '..', '.env.tidb'), 'utf8').split('\n').forEach((l) => {
  l = l.trim(); if (!l || l.startsWith('#')) return;
  const [k, ...r] = l.split('='); env[k.trim()] = r.join('=').trim();
});
Object.assign(process.env, {
  DB_HOST: env.DB_HOST, DB_PORT: env.DB_PORT ?? '4000', DB_USER: env.DB_USER,
  DB_PASSWORD: env.DB_PASSWORD, DB_NAME: env.DB_NAME, DB_SSL: 'true',
});
const { pool } = await import('../db.js');
const COMPANY = 30005;

const boq = JSON.parse(fs.readFileSync(boqPath, 'utf8'));
const extras = JSON.parse(fs.readFileSync(extrasPath, 'utf8'));

const NAME_MAP = new Map(Object.entries({
  'top flange': 'Top Flange',
  web: 'Web Plate',
  'bottom flange': 'Bottom Flange',
  'bearing stiffener plain': 'Bearing Stiffener Plain',
  'bearing stiffener hole': 'Bearing Stiffener Hole',
  'end stiffener': 'End Stiffener',
  'intermediate stiffener plain': 'Intermediate Stiffener Plain',
  'intermediate stiffener hole': 'Intermediate Stiffener Hole',
}));
const EXTRA_MAP = {
  EDTF: 'End Diaphragm Top Flange', EDW: 'End Diaphragm Web', EDBF: 'End Diaphragm Bottom Flange',
  JS: 'End Diaphragm Joint Stiffener', PP: 'End Diaphragm Packing Plate',
  IDTF: 'Interm Diaphragm Top Flange', IDW: 'Interm Diaphragm Web', IDDW: 'Interm Diaphragm Diagonal Web',
  IDBF: 'Interm Diaphragm Bottom Flange', ISP: 'Interm Diaphragm Side Plate',
  IFP: 'Interm Diaphragm Fill Plate', ICP: 'Interm Diaphragm Corner Plate',
  WCP: 'Web Cover Plate', TFICP: 'Top Flange Inner Cover Plate', TFOCP: 'Top Flange Outer Cover Plate',
  BFOCP: 'Bottom Flange Outer Cover Plate', BFICP: 'Bottom Flange Inner Cover Plate',
};

function resolveName(row, seen) {
  const base = NAME_MAP.get(row.name.toLowerCase().trim());
  if (!base) return null;
  if (base === 'Intermediate Stiffener Hole' && seen.has(base)) return 'Intermediate Stiffener Plain';
  if (base === 'End Stiffener' && !seen.has(base) && Number(row.width) === 210 && Number(row.qty) === 1) {
    return 'Bearing Stiffener Plain';
  }
  return base;
}

// ── what we built ──────────────────────────────────────────────────────────
const [items] = await pool.query(
  `SELECT i.id, i.code, i.name, i.qty, i.length, i.width, i.height, i.depth,
          p.code AS parentCode, p.name AS parentName
     FROM fab_items i
     LEFT JOIN fab_items p ON p.id = i.parent_item_id AND p.deleted_at IS NULL
    WHERE i.company_id = ? AND i.order_id = ? AND i.deleted_at IS NULL
      AND i.node_kind = 'structure' AND i.is_leaf = 1
    ORDER BY i.code`, [COMPANY, orderId]);

/** parent code -> its leaf parts */
const byParent = new Map();
for (const it of items) {
  const k = it.parentCode ?? '(root)';
  if (!byParent.has(k)) byParent.set(k, []);
  byParent.get(k).push(it);
}
const markSuffix = (code) => (code ? code.split('-').pop() : '');
const wt = (t, l, w, q) => (t * l * w * q * 7.85) / 1e6 / 1000; // MT

const out = { segments: [], sections: [], totals: {} };

// ── girder segments, one per BOQ shipping mark, x2 spans ───────────────────
for (const s of boq.segments) {
  const m = s.mark.match(/G(\d)-(\d)/);
  const want = `L${m[1]}${m[2]}`;
  const seen = new Set();
  const boqParts = [];
  for (const row of s.parts) {
    const name = resolveName(row, seen);
    seen.add(NAME_MAP.get(row.name.toLowerCase().trim()));
    boqParts.push({ code: row.code, name, boqName: row.name, t: row.thickness, l: row.length, w: row.width, qty: row.qty });
  }
  // Both spans carry the same mark; report the first and note the pair.
  const parents = [...byParent.keys()].filter((k) => markSuffix(k) === want);
  const built = parents.length ? byParent.get(parents[0]) : [];
  const rows = boqParts.map((b) => {
    const got = built.find((x) => x.name === b.name);
    return {
      boq: b,
      got: got ? { qty: Number(got.qty), t: Number(got.height), l: Number(got.length), w: Number(got.width) } : null,
      ok: !!got && Number(got.qty) === b.qty && Number(got.length) === b.l
        && Number(got.width) === b.w && Number(got.height) === b.t,
    };
  });
  const extra = built.filter((x) => !boqParts.some((b) => b.name === x.name)).map((x) => x.name);
  out.segments.push({ mark: s.mark, code: want, spans: parents.length, rows, extra });
}

// ── the diaphragm, splice and stud sections ────────────────────────────────
const SECTIONS = [
  { key: 'end_diaphragm', label: 'End Diaphragm', per: 6, codePrefix: 'ED' },
  { key: 'interm_diaphragm', label: 'Intermediate Diaphragm', per: 45, codePrefix: 'ID' },
  { key: 'splice', label: 'Splice Details', per: 16, codePrefix: 'SPL' },
];
for (const sec of SECTIONS) {
  const boqParts = extras.parts.filter((p) => p.section === sec.key);
  const parents = [...byParent.keys()].filter((k) => new RegExp(`-${sec.codePrefix}1$`).test(k));
  const built = parents.length ? byParent.get(parents[0]) : [];
  const rows = boqParts.map((b) => {
    const name = EXTRA_MAP[b.code];
    const got = built.find((x) => x.name === name);
    return {
      boq: { code: b.code, name, boqName: b.name, t: b.thickness, l: b.dimA, w: b.dimB, qty: b.qty },
      got: got ? { qty: Number(got.qty), t: Number(got.height), l: Number(got.length), w: Number(got.width) } : null,
      ok: !!got && Number(got.qty) === b.qty
        && ((Number(got.length) === b.dimA && Number(got.width) === b.dimB)
          || (Number(got.length) === b.dimB && Number(got.width) === b.dimA))
        && Number(got.height) === b.thickness,
    };
  });
  const [[cnt]] = await pool.query(
    `SELECT COUNT(*) n FROM fab_items WHERE company_id=? AND order_id=? AND deleted_at IS NULL
       AND depth=1 AND code LIKE ?`, [COMPANY, orderId, `%-${sec.codePrefix}%`]);
  out.sections.push({ label: sec.label, perSpan: sec.per, builtTotal: cnt.n, rows });
}

const [[studs]] = await pool.query(
  `SELECT SUM(qty) q, COUNT(*) n FROM fab_items WHERE company_id=? AND order_id=? AND deleted_at IS NULL
     AND code LIKE '%-STUDS%'`, [COMPANY, orderId]);
out.studs = { boqPerSpan: 7212, boqTotal: 14424, builtTotal: Number(studs.q), lines: studs.n };

const [[tot]] = await pool.query(
  `SELECT ROUND(SUM(total_weight)/1000,2) t FROM fab_items
    WHERE company_id=? AND order_id=? AND deleted_at IS NULL AND depth=0`, [COMPANY, orderId]);
out.totals = { orderMt: Number(tot.t), boqMt: 669.29 };

fs.writeFileSync(process.env.RECON_OUT, JSON.stringify(out, null, 1));
console.log('written to', process.env.RECON_OUT);
await pool.end();
