/**
 * backfill-blank-density.mjs — give every existing BLANK catalogue item the
 * density its parts weigh by, then re-weigh the orders that lost their weight.
 *
 * WHAT WENT WRONG. `blankService.materialiseBlanks` minted one catalogue row
 * per blank shape with thickness / width / length / material / grade on it —
 * and no density. Once an order is nested, each part's material link points at
 * its blank, and `itemWeightService.recomputeOrderWeights` weighs a linked part
 * from the LINKED catalogue row's `density_kg_m3` and nothing else (the
 * spec-based fallback is only for parts with no link yet). So the moment an
 * order was nested through this path every part on it went to "weight
 * unknown", and the order total with it. The KEPL ROB60 order read NULL where
 * it had read 669 t the day before.
 *
 * `materialiseBlanks` now writes the density. This fills in the rows it wrote
 * before it did — the same resolution (`weightFactorsForParts`, keyed on the
 * blank's own material / grade / thickness), written through `setFields` so the
 * value and its projected column land together — and then re-runs the weight
 * roll-up on every order with a part linked to a blank.
 *
 * Only LIVE blanks are touched. A retired one is revived through
 * `materialiseBlanks`, which writes density itself now.
 *
 * Usage:
 *   node scripts/backfill-blank-density.mjs            # local, dry run
 *   node scripts/backfill-blank-density.mjs --apply    # local, write
 *   node scripts/backfill-blank-density.mjs --prod [--apply]   # TiDB via ../.env.tidb
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const APPLY = process.argv.includes('--apply');
const PROD = process.argv.includes('--prod');

if (PROD) {
  const env = {};
  fs.readFileSync(path.join(__dir, '..', '..', '.env.tidb'), 'utf8').split('\n').forEach((l) => {
    l = l.trim(); if (!l || l.startsWith('#')) return;
    const [k, ...r] = l.split('='); env[k.trim()] = r.join('=').trim();
  });
  Object.assign(process.env, {
    DB_HOST: env.DB_HOST, DB_PORT: env.DB_PORT ?? '4000', DB_USER: env.DB_USER,
    DB_PASSWORD: env.DB_PASSWORD, DB_NAME: env.DB_NAME, DB_SSL: 'true',
  });
}
const { pool } = await import('../db.js');
const { resolveFields, setFields } = await import('../apps/fab_erp/services/fieldService.js');
const { weightFactorsForParts } = await import('../apps/fab_erp/services/materialMatchService.js');
const { recomputeOrderWeights } = await import('../apps/fab_erp/services/itemWeightService.js');
const { DEFAULT_DENSITY } = await import('../apps/fab_erp/services/fieldDeriveService.js');

const say = (s = '') => console.log(s);
const would = (s) => console.log(`${APPLY ? '  ' : '  would '}${s}`);
say(`${PROD ? 'PROD (TiDB)' : 'LOCAL'} — ${APPLY ? 'APPLYING' : 'dry run'}`);

const [blanks] = await pool.query(
  `SELECT id, company_id AS companyId, code, thickness_mm AS thickness, density_kg_m3 AS density
     FROM fab_item_catalog
    WHERE material_form = 'blank' AND deleted_at IS NULL AND density_kg_m3 IS NULL
    ORDER BY company_id, id`);
say(`${blanks.length} live blank(s) without a density`);

const byCompany = new Map();
for (const b of blanks) {
  if (!byCompany.has(b.companyId)) byCompany.set(b.companyId, []);
  byCompany.get(b.companyId).push(b);
}

let filled = 0;
for (const [companyId, rows] of byCompany) {
  const resolved = await resolveFields(
    companyId, rows.map((r) => ({ scope: 'catalog_item', scopeId: r.id })));
  const specs = new Map();
  for (const r of rows) {
    const f = resolved.get(`catalog_item:${r.id}`) ?? {};
    const t = Number(f.thickness_mm?.value ?? r.thickness);
    specs.set(r.id, {
      material: f.material?.value ?? null,
      grade: f.grade?.value ?? null,
      thickness: Number.isFinite(t) ? t : null,
    });
  }
  // The blank's own row has no density yet, so it cannot vote for itself here.
  const factors = await weightFactorsForParts(companyId, rows.map((r) => r.id), { specs });
  for (const r of rows) {
    const spec = specs.get(r.id);
    const picked = factors.get(r.id)?.density;
    const density = Number.isFinite(Number(picked)) && Number(picked) > 0 ? Number(picked) : DEFAULT_DENSITY;
    const how = picked != null ? 'from catalogue' : `DEFAULT ${DEFAULT_DENSITY}`;
    would(`company ${companyId}  ${r.code}  ${spec.material ?? '?'} ${spec.grade ?? '?'} ${spec.thickness ?? '?'}mm  -> density ${density} (${how})`);
    if (APPLY) {
      const out = await setFields(companyId, 'catalog_item', r.id, { density_kg_m3: density });
      if (out.rejected?.length) throw new Error(`setFields refused ${r.code}: ${JSON.stringify(out.rejected)}`);
      filled += 1;
    }
  }
}

// Every order with a part cut from a blank — those are the ones that lost weight.
const [orders] = await pool.query(
  `SELECT DISTINCT o.company_id AS companyId, o.id, o.order_number AS orderNumber,
          (SELECT SUM(r.total_weight) FROM fab_items r
            WHERE r.order_id = o.id AND r.parent_item_id IS NULL AND r.deleted_at IS NULL) AS totalBefore
     FROM fab_items m
     JOIN fab_item_catalog bc ON bc.id = m.catalog_item_id AND bc.material_form = 'blank'
     JOIN fab_orders o ON o.id = m.order_id
    WHERE m.node_kind = 'material' AND m.deleted_at IS NULL
    ORDER BY o.id`);
say(`${orders.length} order(s) with parts cut from blanks`);
for (const o of orders) {
  if (APPLY) {
    const w = await recomputeOrderWeights(o.companyId, o.id);
    say(`  ${o.orderNumber} (${o.id}): ${o.totalBefore == null ? 'NULL' : Number(o.totalBefore).toFixed(2)} kg -> ${w.totalWeight == null ? 'NULL' : w.totalWeight.toFixed(2)} kg, ${w.updated} rows updated, ${w.unweighedLeaves} leaves still unweighed`);
  } else {
    would(`re-weigh ${o.orderNumber} (${o.id}) — currently ${o.totalBefore == null ? 'NULL' : Number(o.totalBefore).toFixed(2)} kg`);
  }
}
say(APPLY ? `done — ${filled} blank(s) given a density` : 'dry run — nothing written');
await pool.end();
