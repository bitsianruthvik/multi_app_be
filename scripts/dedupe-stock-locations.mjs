/**
 * dedupe-stock-locations.mjs — two stock areas with the same name, and no way
 * to tell them apart.
 *
 * PROD-05. Production has `Machines - off site` twice (120022, 120023) and
 * `Machines - on site` twice (120016, 120017). Every dropdown that offers a
 * stock area offers both, spelled identically, so choosing one is a coin flip —
 * and a coin flip decides which area the stock is recorded in, which decides
 * what the yard report says and which plate the WIP gate can find.
 *
 * WHAT THIS DOES, AND WHAT IT REFUSES TO DO.
 *
 * A merge is an IDENTITY claim: these two rows are the same physical place, so
 * everything that points at one may point at the other. That claim is only safe
 * when the two rows agree about where they are, so a pair is REFUSED when:
 *
 *   • their `plant_id` differs — two plants each having a "Machines - on site"
 *     is not a duplicate, it is two shops. This is not hypothetical: init.sql
 *     seeds MACH-ON and MACH-OFF *per plant*, so a company with three plants has
 *     three of each BY DESIGN, and merging them would teleport machines between
 *     factories. It is also the most likely explanation of the production pairs.
 *
 *   • their `code` differs — a code is the thing people type and integrations
 *     match on. Two rows with different codes are distinguishable and their
 *     problem is a display problem: the fix is to rename one, or to show the
 *     plant and code beside the name, not to destroy one of them.
 *
 * Anything refused is printed with both rows side by side and the reason, so
 * the refusal is actionable rather than a shrug.
 *
 * A merge that goes ahead:
 *   • keeps the LOWEST id as the survivor — deterministic, and the older row is
 *     the one whose id is already sitting in other people's exports and URLs
 *   • repoints every column that references a stock location
 *   • SOFT-deletes the loser (`deleted_at`), never DELETE. A hard delete would
 *     make every historical ledger row point at a row that no longer exists, and
 *     "location #120023" is a worse answer than a retired name
 *   • writes NO ledger rows and moves NO stock. Nothing physically moved; two
 *     names for one place became one name. Inventing a transfer to record a
 *     rename would put fictional movements in the audit trail
 *
 * FINDING THE REFERENCES IS THE DANGEROUS PART. A missed reference is a row
 * pointing at a soft-deleted location — orphaned, invisible, and silently
 * dropped by every query that joins `deleted_at IS NULL`. So the columns are
 * DISCOVERED from information_schema at run time, not typed from memory:
 * `fab_stock_locations` has no foreign keys pointing at it (this schema uses
 * plain INT + KEY on purpose, see init.sql "every other cross-ref … is a plain
 * INT + KEY index"), so the name is the only signal there is, and every integer
 * column named `*location_id` is treated as a reference. The full list, with row
 * counts and how many of those rows point at a location that exists, is printed
 * every run — a new table with a location column shows up here on its own,
 * without anybody remembering to add it.
 *
 * UNIQUE INDEXES ARE HANDLED, because repointing can collide. `fab_stock_policies`
 * is UNIQUE on (company, item, plant, stock_location) — if both locations have a
 * policy for the same item, repointing the loser's row would hit ER_DUP_ENTRY and
 * abort the merge half done. Those rows are found first and soft-deleted as the
 * redundant copy they are, and the count is reported. Unique indexes are read
 * from information_schema for the same reason the columns are.
 *
 * Read-only unless you ask. Safe to re-run: a second pass finds nothing to do.
 *
 * Usage:
 *   node scripts/dedupe-stock-locations.mjs [companyId]           # report only
 *   node scripts/dedupe-stock-locations.mjs [companyId] --dry     # same, explicit
 *   node scripts/dedupe-stock-locations.mjs [companyId] --apply   # merge
 */

import { pool } from '../db.js';

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const APPLY = args.includes('--apply') && !DRY;
const only = Number(args.find((a) => /^\d+$/.test(a))) || null;

console.log(`dedupe-stock-locations — ${APPLY ? 'APPLY' : 'DRY RUN'}`
  + `${APPLY ? '' : '  (re-run with --apply to merge)'}`);

/**
 * Natural keys nothing enforces.
 *
 * `fab_resource_stock_areas` has no unique index, so repointing cannot fail —
 * it can only leave the machine owning the same area twice, which is the same
 * duplicate-in-a-dropdown problem one level down. Declared here so it is
 * handled by exactly the same code path as a real unique index, and so the fact
 * that it is a convention rather than a constraint is written down.
 */
const NATURAL_KEYS = {
  fab_resource_stock_areas: ['company_id', 'resource_id', 'stock_location_id', 'role'],
};

const n = (v) => Number(v ?? 0);
const norm = (s) => String(s ?? '').trim().toLowerCase();

// ── 1. every column that references a stock location ───────────────────────
const [candidates] = await pool.query(
  `SELECT TABLE_NAME AS t, COLUMN_NAME AS c, DATA_TYPE AS dt
     FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME LIKE '%location%'
    ORDER BY TABLE_NAME, COLUMN_NAME`,
);
const INT_TYPES = new Set(['int', 'bigint', 'mediumint', 'smallint', 'tinyint']);
const refs = [];
const ignored = [];
for (const r of candidates) {
  const isId = /(^|_)location_id$/.test(r.c);
  if (isId && INT_TYPES.has(r.dt)) refs.push({ table: r.t, column: r.c });
  else ignored.push({ ...r, why: isId ? `${r.dt}, not an integer id` : 'not a *_location_id column' });
}

const tableMeta = new Map();
for (const { table } of refs) {
  if (tableMeta.has(table)) continue;
  const [cols] = await pool.query(
    `SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`, [table],
  );
  const names = new Set(cols.map((x) => x.c));
  const [idx] = await pool.query(
    `SELECT INDEX_NAME AS name, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS cols
       FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND NON_UNIQUE = 0
      GROUP BY INDEX_NAME`, [table],
  );
  tableMeta.set(table, {
    columns: names,
    hasCompany: names.has('company_id'),
    hasDeletedAt: names.has('deleted_at'),
    uniques: idx.map((i) => ({ name: i.name, cols: i.cols.split(',') })),
  });
}

console.log(`\n── reference columns discovered (${refs.length}) ─────────────────────────`);
for (const r of refs) {
  const meta = tableMeta.get(r.table);
  const [[stat]] = await pool.query(
    `SELECT COUNT(*) AS rows_, SUM(t.\`${r.column}\` IS NOT NULL) AS set_,
            SUM(EXISTS (SELECT 1 FROM fab_stock_locations l WHERE l.id = t.\`${r.column}\`)) AS hit_
       FROM \`${r.table}\` t`,
  );
  const keys = [...meta.uniques.filter((u) => u.cols.includes(r.column)).map((u) => u.name),
    ...(NATURAL_KEYS[r.table]?.includes(r.column) ? ['(natural key)'] : [])];
  console.log(`   ${`${r.table}.${r.column}`.padEnd(44)} ${String(n(stat.set_)).padStart(6)} set`
    + ` / ${String(n(stat.rows_)).padStart(6)} rows`
    + ` · ${n(stat.hit_)} point at a location that exists`
    + `${keys.length ? `  · unique on ${keys.join(', ')}` : ''}`
    + `${meta.hasDeletedAt ? '' : '  · NO deleted_at'}`);
}
if (ignored.length) {
  console.log(`\n   not treated as references:`);
  for (const i of ignored) console.log(`   ${`${i.t}.${i.c}`.padEnd(44)} ${i.why}`);
}
console.log('   (fab_stock_locations has no inbound FOREIGN KEYs — this schema uses plain INT +');
console.log('    KEY by design, so the column NAME is the only signal. A table added later shows');
console.log('    up in this list by itself.)');

// ── 2. duplicate names ─────────────────────────────────────────────────────
const [locations] = await pool.query(
  `SELECT l.id, l.company_id AS companyId, l.plant_id AS plantId, l.name, l.code,
          l.capacity_value AS capacityValue, l.capacity_uom AS capacityUom,
          c.name AS companyName, p.name AS plantName
     FROM fab_stock_locations l
     LEFT JOIN companies c ON c.id = l.company_id
     LEFT JOIN fab_plants p ON p.id = l.plant_id
    WHERE l.deleted_at IS NULL ${only ? 'AND l.company_id = ?' : ''}
    ORDER BY l.company_id, l.name, l.id`,
  only ? [only] : [],
);

const groups = new Map();
for (const l of locations) {
  const k = `${l.companyId}:${norm(l.name)}`;
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(l);
}
const dupes = [...groups.values()].filter((g) => g.length > 1);

console.log(`\n── duplicate names ──────────────────────────────────────────────────`);
console.log(`   ${locations.length} live location(s) · ${dupes.length} name(s) used more than once`);

let merged = 0;
let refused = 0;
const mergedLosers = [];

for (const g of dupes) {
  const survivor = g.reduce((a, b) => (a.id <= b.id ? a : b));
  console.log(`\n  "${survivor.name}" — ${g.length} rows in ${survivor.companyName} (company ${survivor.companyId})`);
  for (const l of g) {
    console.log(`     #${String(l.id).padEnd(7)} code ${String(l.code).padEnd(14)}`
      + ` plant ${l.plantId} ${l.plantName ? `(${l.plantName})` : ''}`
      + `${l.id === survivor.id ? '   ← SURVIVOR (lowest id)' : ''}`);
  }

  for (const loser of g.filter((l) => l.id !== survivor.id)) {
    // ── the two questions that decide whether this is a duplicate at all ──
    const why = [];
    if (n(loser.plantId) !== n(survivor.plantId)) {
      why.push(`different plant (#${survivor.plantId} ${survivor.plantName ?? ''} vs`
        + ` #${loser.plantId} ${loser.plantName ?? ''}) — two shops, not one area`);
    }
    if (norm(loser.code) !== norm(survivor.code)) {
      why.push(`different code ('${survivor.code}' vs '${loser.code}') — they are`
        + ' distinguishable; rename one instead of merging');
    }
    if (why.length) {
      refused++;
      console.log(`     REFUSED  #${loser.id} → #${survivor.id}`);
      for (const w of why) console.log(`              ${w}`);
      continue;
    }

    // Settings are not identity: they do not block a merge, but the survivor's
    // win and somebody should know which numbers survived.
    if (n(loser.capacityValue) !== n(survivor.capacityValue)) {
      console.log('     note     capacity differs — survivor'
        + ` ${survivor.capacityValue ?? '—'} ${survivor.capacityUom ?? ''}`
        + ` vs loser ${loser.capacityValue ?? '—'} ${loser.capacityUom ?? ''};`
        + " the survivor's is kept");
    }

    // ── what points at the loser ─────────────────────────────────────────
    const work = [];
    for (const r of refs) {
      const meta = tableMeta.get(r.table);
      const [[cnt]] = await pool.query(
        `SELECT COUNT(*) AS c FROM \`${r.table}\` WHERE \`${r.column}\` = ?`
        + (meta.hasCompany ? ' AND company_id = ?' : ''),
        meta.hasCompany ? [loser.id, loser.companyId] : [loser.id],
      );
      if (n(cnt.c)) work.push({ ...r, meta, count: n(cnt.c) });
    }

    // ── rows that cannot be repointed because the survivor already has one ─
    const collisions = [];
    for (const w of work) {
      for (const key of keysFor(w.table, w.column, w.meta)) {
        const others = key.cols.filter((c) => c !== w.column && w.meta.columns.has(c));
        const on = others.map((c) => `s.\`${c}\` <=> x.\`${c}\` AND x.\`${c}\` IS NOT NULL`).join(' AND ');
        const [rows] = await pool.query(
          `SELECT x.id FROM \`${w.table}\` x
             JOIN \`${w.table}\` s ON s.\`${w.column}\` = ? ${others.length ? `AND ${on}` : ''}
            WHERE x.\`${w.column}\` = ?`
          + (w.meta.hasDeletedAt ? ' AND x.deleted_at IS NULL AND s.deleted_at IS NULL' : ''),
          [survivor.id, loser.id],
        );
        if (rows.length) {
          collisions.push({ ...w, key: key.name, ids: rows.map((r) => r.id) });
        }
      }
    }
    const unfixable = collisions.filter((c) => !c.meta.hasDeletedAt);

    console.log(`     MERGE    #${loser.id} → #${survivor.id}`
      + `${work.length ? '' : '   (nothing references it)'}`);
    for (const w of work) {
      console.log(`              ${`${w.table}.${w.column}`.padEnd(42)} ${w.count} row(s) to repoint`);
    }
    for (const c of collisions) {
      console.log(`              ! ${c.table}: ${c.ids.length} row(s) already exist on the survivor`
        + ` under ${c.key}`
        + (c.meta.hasDeletedAt ? ` — the loser's copy will be soft-deleted (#${c.ids.join(', #')})`
          : ' — and this table has NO deleted_at, so the merge CANNOT be completed'));
    }
    if (unfixable.length) {
      refused++;
      console.log(`     REFUSED  #${loser.id} → #${survivor.id}: a colliding row cannot be retired safely`);
      continue;
    }

    if (!APPLY) { merged++; mergedLosers.push(loser.id); continue; }

    // ── do it, all or nothing ────────────────────────────────────────────
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      for (const c of collisions) {
        await conn.query(
          `UPDATE \`${c.table}\` SET deleted_at = UTC_TIMESTAMP()
            WHERE id IN (${c.ids.map(() => '?').join(',')}) AND deleted_at IS NULL`,
          c.ids,
        );
      }
      let repointed = 0;
      for (const w of work) {
        const [r] = await conn.query(
          `UPDATE \`${w.table}\` SET \`${w.column}\` = ? WHERE \`${w.column}\` = ?`
          + (w.meta.hasCompany ? ' AND company_id = ?' : '')
          + (w.meta.hasDeletedAt ? ' AND deleted_at IS NULL' : ''),
          w.meta.hasCompany ? [survivor.id, loser.id, loser.companyId] : [survivor.id, loser.id],
        );
        repointed += r.affectedRows;
        // Soft-deleted rows keep pointing at the loser on purpose: a retired row
        // is history, and history should say where it actually was. The loser
        // row survives (soft-deleted) so those joins still resolve.
      }
      await conn.query(
        'UPDATE fab_stock_locations SET deleted_at = UTC_TIMESTAMP() WHERE id = ? AND deleted_at IS NULL',
        [loser.id],
      );
      await conn.commit();
      merged++;
      mergedLosers.push(loser.id);
      console.log(`              repointed ${repointed} live row(s); #${loser.id} soft-deleted`);
    } catch (e) {
      await conn.rollback();
      console.log(`              ! merge failed, rolled back: ${e.message}`);
    } finally { conn.release(); }
  }
}

if (!dupes.length) console.log('   nothing to merge.');

// ── 3. nothing may point at a location that is gone ────────────────────────
console.log(`\n── orphan check ─────────────────────────────────────────────────────`);
let orphansAtMerged = 0;
let orphansAtAnyDeleted = 0;
for (const r of refs) {
  const [[o]] = await pool.query(
    `SELECT
        SUM(EXISTS (SELECT 1 FROM fab_stock_locations l
                     WHERE l.id = t.\`${r.column}\` AND l.deleted_at IS NOT NULL)) AS anyDeleted,
        SUM(EXISTS (SELECT 1 FROM fab_stock_locations l
                     WHERE l.id = t.\`${r.column}\` AND l.deleted_at IS NOT NULL)
            AND ${mergedLosers.length ? `t.\`${r.column}\` IN (${mergedLosers.map(() => '?').join(',')})` : '1 = 0'}) AS atMerged,
        SUM(t.\`${r.column}\` IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM fab_stock_locations l WHERE l.id = t.\`${r.column}\`)) AS dangling
       FROM \`${r.table}\` t`
    + (tableMeta.get(r.table).hasDeletedAt ? ' WHERE t.deleted_at IS NULL' : ''),
    mergedLosers,
  );
  orphansAtMerged += n(o.atMerged);
  orphansAtAnyDeleted += n(o.anyDeleted);
  if (n(o.atMerged) || n(o.anyDeleted) || n(o.dangling)) {
    console.log(`   ${`${r.table}.${r.column}`.padEnd(44)}`
      + ` ${n(o.atMerged)} at a location merged by this run`
      + ` · ${n(o.anyDeleted)} at any soft-deleted location`
      + ` · ${n(o.dangling)} at an id that does not exist`);
  }
}
console.log(`   live rows pointing at a location THIS RUN retired: ${orphansAtMerged}`
  + `${orphansAtMerged === 0 ? '  ✓' : '   ← BUG: a reference was missed'}`);
console.log(`   live rows pointing at any soft-deleted location   : ${orphansAtAnyDeleted}`
  + '  (pre-existing, not caused here)');

console.log(`\n${merged} merge(s) ${APPLY ? 'done' : 'available'} · ${refused} refused.`);
if (refused) {
  console.log('A REFUSED pair is still a real usability problem — it is just not a data problem.');
  console.log('Two areas that differ by plant or code are two areas, and the fix is to make the');
  console.log('picker say which: show the plant and the code beside the name, or rename one of');
  console.log('them. Merging them would move stock between places that are genuinely different.');
}
console.log(APPLY
  ? 'Re-run to confirm it is a no-op.'
  : 'Nothing was written. Re-run with --apply to merge the pairs marked MERGE.');

await pool.end();

// ---------------------------------------------------------------------------

/** Real unique indexes plus the declared natural key, both as one shape. */
function keysFor(table, column, meta) {
  const out = meta.uniques
    .filter((u) => u.cols.includes(column))
    .map((u) => ({ name: u.name, cols: u.cols }));
  const nat = NATURAL_KEYS[table];
  if (nat?.includes(column) && !out.some((k) => k.cols.join() === nat.join())) {
    out.push({ name: `${table} natural key`, cols: nat });
  }
  return out;
}
