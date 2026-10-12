/**
 * link-groups-seed.mjs — linked copies for an order that was built BEFORE copies were linked
 * (init.sql §59, CF_ERP_LINKED_COPIES_PLAN.md §5).
 *
 * Nothing recorded "copied from" until now, so an existing order's copies can only be found by
 * what they ARE: rows of one order line with the same design fingerprint (linkService — the same
 * kind of thing, the same typed values, the same drawings, the same children at the same
 * quantities). This proposes one group per such design and, with --apply, stores it.
 *
 *   node scripts/cf_kepl/link-groups-seed.mjs --company 30005 --order SO260002                (dry run: rolled back)
 *   node scripts/cf_kepl/link-groups-seed.mjs --company 30005 --order SO260002 --line 10      (one line)
 *   node scripts/cf_kepl/link-groups-seed.mjs --company 30005 --order SO260002 --skip g3,g7   (leave those groups out)
 *   node scripts/cf_kepl/link-groups-seed.mjs --company 30005 --order SO260002 --apply        (commits)
 *
 * WHAT IS PROPOSED. Only rows with SUBSTANCE — a typed design value, a drawing, or a child that has
 * one: two rows fresh from a template with nothing typed are trivially "equal" and say nothing
 * (finding F5). Rows a person said to keep apart are never proposed. A design that is already one
 * group is left as it is; equal rows outside it join it.
 *
 * WHAT IT PRINTS, per proposed group (g1, g2, … — the names --skip takes, numbered down the order):
 * how many rows, what they share (their typed values, drawings, children), and each member by where
 * it sits with the code its pieces will get. Then, per line, why the other rows were left alone.
 *
 * SAFE TO RE-RUN. A second run proposes nothing: every design found is one group already.
 * A line released to production is refused (links are fixed at release); a line of a closed or
 * revised order is skipped. Round trips per line: the line's values context (9), its code
 * previews (a handful) and — with something to write — ONE UPDATE. Never one per row.
 */
import { pathToFileURL } from 'url';

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The whole pass on a connection the caller owns (its transaction).
 * → { order, lines: [{ lineId, lineNo, status, groups: [{ name, key, joins, members: [{ id, label, code }], shared }], left, written }], totals }
 */
export async function seedLinks(db, { companyId, orderCode, lineNo = null, skip = [], log = console.log }) {
  const { loadContext, labelOfRecord } = await import('../../apps/cf_erp/services/orderValuesService.js');
  const { linksOf, newGroupKey, isOwnRow, designValueOf } = await import('../../apps/cf_erp/services/linkService.js');
  const { codeRowsOfLine } = await import('../../apps/cf_erp/services/partDrawingService.js');
  const skipped = new Set(skip.map((s) => String(s).trim().toLowerCase()).filter(Boolean));

  // The order by its number: the latest revision that is still live (an earlier one is 'revised' and frozen).
  const [orders] = await db.query(
    'SELECT id, code, status, revision FROM cf_sales_orders WHERE company_id = ? AND code = ? AND deleted_at IS NULL ORDER BY revision DESC, id DESC',
    [companyId, orderCode],
  );
  if (!orders.length) throw new Error(`No order ${orderCode} in company ${companyId}.`);
  const order = orders.find((o) => o.status !== 'revised') ?? orders[0];
  const [lines] = await db.query(
    `SELECT l.id, l.line_no, l.line_type, l.item_id, l.quantity, l.locked_at,
            EXISTS (SELECT 1 FROM cf_production_releases r WHERE r.company_id = l.company_id AND r.order_line_id = l.id AND r.deleted_at IS NULL) AS released
       FROM cf_sales_order_lines l
      WHERE l.company_id = ? AND l.order_id = ? AND l.deleted_at IS NULL${lineNo != null ? ' AND l.line_no = ?' : ''}
      ORDER BY l.line_no, l.id`,
    lineNo != null ? [companyId, order.id, lineNo] : [companyId, order.id],
  );
  log(`${order.code}${Number(order.revision) > 1 ? ` rev ${order.revision}` : ''} (${order.status}) — ${plural(lines.length, 'line')}${lineNo != null ? ` (line ${lineNo} only)` : ''}`);
  const out = { order: { id: order.id, code: order.code, status: order.status }, lines: [], totals: { groups: 0, rows: 0, written: 0, skipped: 0 } };
  const closed = ['closed', 'lost', 'cancelled', 'revised'].includes(order.status);
  let n = 0;
  for (const line of lines) {
    const rep = { lineId: line.id, lineNo: line.line_no, status: 'ok', groups: [], left: {}, written: 0 };
    out.lines.push(rep);
    if (line.line_type !== 'custom' || !line.item_id) { rep.status = 'no structure'; log(`  line ${line.line_no}: not a custom line with a structure — nothing to link.`); continue; }
    if (closed) { rep.status = 'closed'; log(`  line ${line.line_no}: the order is ${order.status} — left as it is.`); continue; }
    if (Number(line.released)) { rep.status = 'released'; log(`  line ${line.line_no}: REFUSED — it is released to production; which rows are copies is fixed at release.`); continue; }

    const ctx = await loadContext(db, companyId, line.id);
    const resolved = new Map();
    const links = linksOf(ctx, ctx.designExtras, { resolved });
    const coded = await codeRowsOfLine(db, companyId, line, [...links.fp.keys()]);
    const codeOf = new Map(coded.rows.map((r) => [r.id, r.texts.length === 1 ? r.texts[0] : r.texts.length ? `${r.texts[0]} … (${r.texts.length} pieces)` : null]));
    const position = new Map([[ctx.line.itemId, 0], ...ctx.lines.map((l, i) => [l.childId, i + 1])]);
    const byPlace = (a, b) => (position.get(a) ?? 0) - (position.get(b) ?? 0) || a - b;
    const flowRules = new Set();
    for (const list of ctx.rulesBySubject.values()) for (const r of list) if (r.origin === 'flow') flowRules.add(r.id);
    /** What the members of a design share, in words: its typed values, its drawings, what is below it. */
    const sharedOf = (id) => {
      const bits = [];
      for (const s of resolved.get(id)?.specs ?? []) {
        const d = designValueOf(s, flowRules);
        if (d.design && d.value !== null) bits.push(`${s.spec.code} ${s.value?.display ?? d.value}`);
      }
      const own = links.prints.own.get(id);
      if (own?.roots.length) bits.push(plural(own.roots.length, 'drawing'));
      if (own?.kids.length) bits.push(`${plural(own.kids.length, 'line')} below`);
      return bits.join(' · ') || 'nothing of its own (it is what is below it)';
    };

    // One proposal per design that is not one group yet, in the order the tree draws its first row.
    const proposals = links.suggestions.map((ids) => [...ids].sort(byPlace)).sort((a, b) => byPlace(a[0], b[0]));
    const moves = new Map();
    for (const ids of proposals) {
      n += 1;
      const name = `g${n}`;
      // Rows of this design that are linked already keep their group; the rest join it (the biggest one, when there are several).
      const have = new Map();
      for (const id of ids) { const g = links.groupOf.get(id); if (g) have.set(g, (have.get(g) ?? 0) + 1); }
      const joins = [...have].sort((a, b) => b[1] - a[1])[0]?.[0]?.split(':')[0] ?? null;
      const key = joins ?? newGroupKey();
      const group = { name, key, joins: !!joins, members: ids.map((id) => ({ id, label: labelOfRecord(ctx.records.get(id), ctx), code: codeOf.get(id) ?? null })), shared: sharedOf(ids[0]), skipped: skipped.has(name) };
      rep.groups.push(group);
      log(`  ${name}  line ${line.line_no} · ${plural(ids.length, 'row')} of one design${joins ? ' (joining a group that exists)' : ''}${group.skipped ? '  — SKIPPED (--skip)' : ''}`);
      log(`        shares: ${group.shared}`);
      for (const m of group.members) log(`        ${m.label}${m.code ? `   [${m.code}]` : ''}`);
      if (group.skipped) { out.totals.skipped += 1; continue; }
      out.totals.groups += 1; out.totals.rows += ids.length;
      for (const id of ids) if ((ctx.records.get(id).link_group ?? null) !== key) moves.set(id, key);
    }

    // Why the other rows were left alone.
    const proposed = new Set(proposals.flat());
    const left = { linked: 0, apart: 0, noSubstance: 0, unique: 0 };
    for (const id of links.fp.keys()) {
      if (proposed.has(id)) continue;
      const rec = ctx.records.get(id);
      if (!isOwnRow(ctx, rec)) continue;
      if (links.groupOf.has(id)) left.linked += 1;
      else if (Number(rec.link_apart)) left.apart += 1;
      else if (!links.prints.substance.has(id)) left.noSubstance += 1;
      else left.unique += 1;
    }
    rep.left = left;
    const why = [
      left.linked ? `${plural(left.linked, 'row is', 'rows are')} linked already` : null,
      left.unique ? `${plural(left.unique, 'row has', 'rows have')} no equal on this line (a design used once)` : null,
      left.noSubstance ? `${plural(left.noSubstance, 'row has', 'rows have')} nothing typed, no drawing and nothing below with either — equal by being empty is not a design` : null,
      left.apart ? `${plural(left.apart, 'row was', 'rows were')} kept apart by a person` : null,
    ].filter(Boolean);
    log(`  line ${line.line_no}: ${rep.groups.length ? `${plural(rep.groups.length, 'group')} proposed` : 'nothing to propose'}${line.locked_at ? ' (the design is frozen — links still change until release)' : ''}${why.length ? `; left alone: ${why.join('; ')}` : ''}.`);

    if (moves.size) {
      // ONE UPDATE for the line.
      const params = [];
      const whens = [...moves].map(([id, key]) => { params.push(id, key); return 'WHEN ? THEN ?'; }).join(' ');
      params.push(companyId, [...moves.keys()]);
      const [res] = await db.query(`UPDATE cf_item_details SET link_group = CASE master_id ${whens} END WHERE company_id = ? AND master_id IN (?) AND deleted_at IS NULL`, params);
      rep.written = res.affectedRows ?? moves.size;
      out.totals.written += rep.written;
    }
  }
  log(`${plural(out.totals.groups, 'group')} over ${plural(out.totals.rows, 'row')}${out.totals.skipped ? ` (${out.totals.skipped} skipped)` : ''} · ${plural(out.totals.written, 'row')} written`);
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
  const COMPANY = Number(arg('company'));
  const ORDER = arg('order');
  const APPLY = process.argv.includes('--apply');
  if (!Number.isInteger(COMPANY) || !ORDER) throw new Error('Usage: --company <id> --order <code> [--line n] [--skip g1,g2] [--apply]');
  const { pool } = await import('../../db.js');
  await import('../../apps/cf_erp/services/codegenProvider.js');   // the code previews use the app's coding rules
  const db = await pool.getConnection();
  try {
    await db.beginTransaction();
    await seedLinks(db, { companyId: COMPANY, orderCode: ORDER, lineNo: arg('line') != null ? Number(arg('line')) : null, skip: (arg('skip') ?? '').split(',') });
    if (APPLY) { await db.commit(); console.log('COMMITTED'); } else { await db.rollback(); console.log('DRY RUN — rolled back. Add --apply to keep it.'); }
  } catch (err) {
    await db.rollback().catch(() => {});
    console.error('ERROR', err.message);
    process.exitCode = 1;
  } finally {
    db.release();
    await pool.end();
  }
}
