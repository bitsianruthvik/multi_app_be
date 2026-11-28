/**
 * exactItemService.js — a selection row takes the catalog item of EXACTLY the size the drawing gives (user, 2026-11-28:
 * "You use only what's there even when you know the dimension is different. Every time this happens, you need to create
 * the new item and add it to the selector definition and then select that one in the SO BOM.").
 *
 * ensureExactItem: the catalog item of this exact name, or a new one made the way the catalog screen makes one
 * (masterRecordService.createItem — in the selection's own branch, the code next in its siblings' series, active, its
 * unit WEIGHT), then put in the selection's list (selectionService.addEntry, never as the default) unless the selection
 * already finds it through a branch. chooseItem: the row's choice, through bomService.resolveLine (the screen's
 * "choose" on a selection row). Everything by the caller's company.
 */
import { createItem } from './masterRecordService.js';
import { addEntry, entriesOf, findCandidates } from './selectionService.js';
import { resolveLine } from './bomService.js';
import { setValues } from './valueService.js';
import { invalid } from '../lib/errors.js';

const q = async (db, sql, p = []) => (await db.query(sql, p))[0];

/** The series a new item's code continues: the prefix its siblings share ("HSFG-", "STUD-") and the next number. */
export async function nextCodeLike(db, companyId, classificationId, { nameLike = null, prefix = null } = {}) {
  const sibs = await q(db,
    `SELECT m.code, m.name, m.short_name FROM cf_master_records m JOIN cf_item_details i ON i.master_id = m.id AND i.item_type = 'catalog' AND i.deleted_at IS NULL
      WHERE m.company_id = ? AND m.classification_id = ? AND m.deleted_at IS NULL AND m.code IS NOT NULL`, [companyId, classificationId]);
  const like = nameLike ? sibs.filter((s) => nameLike.test(String(s.name))) : sibs;
  const counts = new Map();
  for (const s of like) { const m = /^([A-Z][A-Z0-9_]*-)(\d+)$/i.exec(String(s.code)); if (m) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1); }
  const pre = prefix ?? [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  if (!pre) return { code: null, shortName: null };
  // The next number over EVERY code of that prefix in the company (a code is unique per company).
  const all = await q(db, 'SELECT code FROM cf_master_records WHERE company_id = ? AND code LIKE ?', [companyId, `${pre}%`]);
  let max = 0; let width = 3;
  for (const { code } of all) { const m = new RegExp(`^${pre.replace(/[-]/g, '\\-')}(\\d+)$`, 'i').exec(String(code)); if (m) { max = Math.max(max, Number(m[1])); width = Math.max(width, m[1].length); } }
  // The short name most of the series carry (Shear studs: "STUD"), else none.
  const shorts = new Map(); for (const s of like) if (s.short_name) shorts.set(s.short_name, (shorts.get(s.short_name) ?? 0) + 1);
  const shortName = [...shorts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  return { code: `${pre}${String(max + 1).padStart(width, '0')}`, shortName };
}

/** The branch a selection's new item is filed in: the class its current candidates of this kind sit in, else its first branch. */
async function branchFor(db, companyId, selectionId, nameLike) {
  const { candidates } = await findCandidates(db, companyId, selectionId, { limit: 1000 });
  const ids = candidates.filter((x) => !nameLike || nameLike.test(String(x.name))).map((x) => x.id);
  if (ids.length) {
    const rows = await q(db, 'SELECT classification_id, COUNT(*) n FROM cf_master_records WHERE company_id = ? AND id IN (?) GROUP BY classification_id ORDER BY n DESC', [companyId, ids]);
    if (rows[0]?.classification_id) return Number(rows[0].classification_id);
  }
  const node = (await entriesOf(db, companyId, selectionId)).find((e) => e.node_id != null)?.node_id;
  if (node) return Number(node);
  throw invalid('NO_BRANCH', `Selection ${selectionId} has no branch or candidate to file a new item in.`);
}

/** A unit WEIGHT on an item: through the values screen's write; where the item's setup does not hold WEIGHT, as bolt-weights.mjs writes it. */
async function setWeight(db, c, itemId, kg) {
  if (kg == null) return null;
  try { await setValues(db, c, 'master', itemId, [{ specCode: 'WEIGHT', value: kg, number: kg, uom: 'kg' }]); return 'values'; } catch (e) {
    const [spec] = await q(db, "SELECT id FROM cf_specifications WHERE company_id = ? AND code = 'WEIGHT' AND deleted_at IS NULL", [c.companyId]);
    if (!spec) return null;
    await q(db, "INSERT INTO cf_spec_values (company_id, specification_id, subject_type, subject_id, value_number, uom, source) VALUES (?, ?, 'master', ?, ?, 'kg', 'entered')", [c.companyId, spec.id, itemId, kg]);
    return `direct (${e.message.slice(0, 80)})`;
  }
}

/**
 * want: { kind: 'bolt' | 'stud', name, weightKg }. → { id, code, name, created, addedToSelection, weight }.
 * Found by exact name among the company's active catalog items; made when there is none.
 */
export async function ensureExactItem(db, c, selectionId, want) {
  const { companyId } = c;
  const nameLike = want.kind === 'bolt' ? (/^HSFG bolt set/i.test(want.name) ? /^HSFG bolt set/i : /^Bolt set/i) : want.kind === 'stud' ? /^Shear stud/i : null;
  let [it] = await q(db,
    `SELECT m.id, m.code, m.name FROM cf_master_records m JOIN cf_item_details i ON i.master_id = m.id AND i.item_type = 'catalog' AND i.deleted_at IS NULL
      WHERE m.company_id = ? AND m.name = ? AND m.deleted_at IS NULL AND m.status = 'active' ORDER BY m.id LIMIT 1`, [companyId, want.name]);
  let created = false; let weight = null;
  if (!it) {
    const classificationId = await branchFor(db, companyId, selectionId, nameLike);
    const { code, shortName } = await nextCodeLike(db, companyId, classificationId, { nameLike });
    const r = await createItem(db, c, { name: want.name, code, shortName, classificationId, uom: 'nos', trackedBy: 'quantity', sourcing: 'stock', status: 'active' });
    it = { id: Number(r.id ?? r.record?.id), code: r.code ?? r.record?.code ?? code, name: want.name };
    weight = await setWeight(db, c, it.id, want.weightKg);
    created = true;
  }
  // In the selection's list: a selection that lists items gets this one listed (never the default); one that picks
  // from a branch already finds it there.
  const entries = await entriesOf(db, companyId, selectionId);
  const listed = entries.some((e) => Number(e.item_id) === Number(it.id));
  const listsItems = entries.some((e) => e.item_id != null);
  const found = (await findCandidates(db, companyId, selectionId, { itemId: it.id, limit: 1 })).candidates.some((x) => x.id === Number(it.id));
  let addedToSelection = false;
  if (!listed && (listsItems || !found)) { await addEntry(db, c, selectionId, { itemId: it.id, isDefault: false }); addedToSelection = true; }
  return { id: Number(it.id), code: it.code, name: it.name, created, addedToSelection, inBranch: found && !addedToSelection, weight };
}

/** What ensureExactItem would do, read only: { id | null, code, name, created, addedToSelection, inBranch }. */
export async function planExactItem(db, c, selectionId, want) {
  const { companyId } = c;
  const nameLike = want.kind === 'bolt' ? (/^HSFG bolt set/i.test(want.name) ? /^HSFG bolt set/i : /^Bolt set/i) : want.kind === 'stud' ? /^Shear stud/i : null;
  const [it] = await q(db,
    `SELECT m.id, m.code, m.name FROM cf_master_records m JOIN cf_item_details i ON i.master_id = m.id AND i.item_type = 'catalog' AND i.deleted_at IS NULL
      WHERE m.company_id = ? AND m.name = ? AND m.deleted_at IS NULL AND m.status = 'active' ORDER BY m.id LIMIT 1`, [companyId, want.name]);
  const entries = await entriesOf(db, companyId, selectionId);
  const listsItems = entries.some((e) => e.item_id != null);
  if (it) {
    const listed = entries.some((e) => Number(e.item_id) === Number(it.id));
    const found = (await findCandidates(db, companyId, selectionId, { itemId: it.id, limit: 1 })).candidates.some((x) => x.id === Number(it.id));
    return { id: Number(it.id), code: it.code, name: it.name, created: false, addedToSelection: !listed && (listsItems || !found), inBranch: found && !listed && !listsItems };
  }
  const classificationId = await branchFor(db, companyId, selectionId, nameLike);
  const { code } = await nextCodeLike(db, companyId, classificationId, { nameLike });
  const branchOf = (await entriesOf(db, companyId, selectionId)).filter((e) => e.node_id != null).map((e) => Number(e.node_id));
  return { id: null, code, name: want.name, created: true, classificationId, addedToSelection: listsItems || !branchOf.includes(classificationId), inBranch: !listsItems && branchOf.includes(classificationId) };
}

/** The row's choice, as the screen makes it (bomService.resolveLine: a candidate only, auto_chosen 0, values refreshed). */
export async function chooseItem(db, c, bomLineId, itemId) {
  await resolveLine(db, c, bomLineId, { itemId });
}
