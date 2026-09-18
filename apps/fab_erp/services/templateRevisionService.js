/**
 * templateRevisionService.js — numbered, released revisions of a template.
 *
 * ── THE MODEL (product owner, 2026-09-18) ───────────────────────────────────
 *
 * A template's BOM (`fab_item_bom`, everything under it) is its WORKING COPY:
 * edited freely in the designer, seen by nobody else. "Release" freezes the
 * whole tree as the next numbered revision (`fab_template_revisions`). New
 * orders are built from the LATEST RELEASED revision and the order line
 * records it (`fab_order_lines.template_revision`), so:
 *
 *   · a half-finished edit never reaches an order,
 *   · every order says which version of the design it was built to,
 *   · editing a template never moves an order already built (that was already
 *     true — orders copy the tree — and is now visible as "Rev 3, latest 5").
 *
 * A template with no release cannot be built from. The first release of a
 * template that existed before revisions is the baseline Rev 1
 * (`scripts/template-revisions-baseline.mjs`).
 *
 * ── WHAT A REVISION HOLDS ────────────────────────────────────────────────────
 *
 * `draftTree(..., {resolvePicks:false})`: every line with its quantity or
 * question, code segment, flow, explode/code-join, pick filter and the sizes
 * the recipe states — the recipe exactly as released. Picks are resolved when
 * an order is drafted from it (the catalog's items move on; the filter does not).
 */
import { pool } from '../../../db.js';
import { draftTree, resolvePicks } from './bomService.js';

const clone = (x) => JSON.parse(JSON.stringify(x));

/**
 * The comparable shape of a tree. `key` is a per-read local id, not content,
 * and keys are SORTED: a JSON column hands objects back in its own key order,
 * so a revision read from the database and the same tree freshly drafted
 * stringify differently unless the order is made canonical.
 */
function fingerprint(tree) {
  const canon = (v) => {
    if (Array.isArray(v)) return v.map(canon);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.keys(v).filter((k) => k !== 'key').sort().map((k) => [k, canon(v[k])]));
    }
    return v;
  };
  return JSON.stringify(canon(tree));
}

async function latestRow(exec, companyId, templateItemId) {
  const [[row]] = await exec.query(
    `SELECT id, rev_no, tree_json, note, released_by, released_at FROM fab_template_revisions
      WHERE company_id = ? AND template_item_id = ? AND deleted_at IS NULL
      ORDER BY rev_no DESC LIMIT 1`,
    [companyId, templateItemId],
  );
  if (!row) return null;
  const tree = typeof row.tree_json === 'string' ? JSON.parse(row.tree_json) : row.tree_json;
  return { ...row, tree };
}

async function hasBom(exec, companyId, itemId) {
  const [[r]] = await exec.query(
    'SELECT COUNT(*) AS n FROM fab_item_bom WHERE company_id = ? AND parent_item_id = ? AND deleted_at IS NULL',
    [companyId, itemId],
  );
  return Number(r.n) > 0;
}

/**
 * Where a template stands: its latest revision, and whether the working copy
 * has moved on from it (i.e. there is something to release).
 */
export async function revisionStatus(companyId, templateItemId, conn = null) {
  const exec = conn ?? pool;
  const latest = await latestRow(exec, companyId, templateItemId);
  const working = await hasBom(exec, companyId, templateItemId)
    ? await draftTree(companyId, templateItemId, exec, { resolvePicks: false })
    : null;
  const unreleasedChanges = working != null && (!latest || fingerprint(working) !== fingerprint(latest.tree));
  return {
    templateItemId: Number(templateItemId),
    latestRev: latest ? Number(latest.rev_no) : null,
    releasedAt: latest?.released_at ?? null,
    note: latest?.note ?? null,
    hasBom: working != null,
    unreleasedChanges,
  };
}

/** Every revision, newest first, with how many order lines were built from each. */
export async function listRevisions(companyId, templateItemId) {
  const [rows] = await pool.query(
    `SELECT r.rev_no AS rev, r.note, r.released_at AS releasedAt,
            u.name AS releasedBy,
            (SELECT COUNT(*) FROM fab_order_lines ol
              WHERE ol.company_id = r.company_id AND ol.template_item_id = r.template_item_id
                AND ol.template_revision = r.rev_no AND ol.deleted_at IS NULL) AS orderLines
       FROM fab_template_revisions r
       LEFT JOIN users u ON u.id = r.released_by
      WHERE r.company_id = ? AND r.template_item_id = ? AND r.deleted_at IS NULL
      ORDER BY r.rev_no DESC`,
    [companyId, templateItemId],
  );
  const [[before]] = await pool.query(
    `SELECT COUNT(*) AS n FROM fab_order_lines
      WHERE company_id = ? AND template_item_id = ? AND template_revision IS NULL
        AND template_snapshot_at IS NOT NULL AND deleted_at IS NULL`,
    [companyId, templateItemId],
  );
  return { revisions: rows.map((r) => ({ ...r, rev: Number(r.rev), orderLines: Number(r.orderLines) })), builtBeforeRevisions: Number(before.n) };
}

/**
 * Release the working copy as the next revision.
 *
 * Refuses when there is nothing to release (the working copy is the latest
 * revision already) — a Rev 5 identical to Rev 4 would make "which revision
 * was this built to" a question with two answers.
 */
export async function releaseRevision(companyId, templateItemId, { note = null, userId = null, conn: outer = null } = {}) {
  // A caller may hand in its own transaction (a test, a script); otherwise this owns one.
  const conn = outer ?? await pool.getConnection();
  const owned = !outer;
  try {
    if (owned) await conn.beginTransaction();
    const [[item]] = await conn.query(
      'SELECT id, name FROM fab_item_catalog WHERE id = ? AND company_id = ? AND deleted_at IS NULL FOR UPDATE',
      [templateItemId, companyId],
    );
    if (!item) { const e = new Error('That template does not exist.'); e.status = 404; throw e; }
    if (!(await hasBom(conn, companyId, templateItemId))) {
      const e = new Error(`${item.name} contains nothing yet — there is no recipe to release.`);
      e.status = 400; e.code = 'NOTHING_TO_RELEASE'; throw e;
    }
    const tree = await draftTree(companyId, templateItemId, conn, { resolvePicks: false });
    const latest = await latestRow(conn, companyId, templateItemId);
    if (latest && fingerprint(latest.tree) === fingerprint(tree)) {
      const e = new Error(`Nothing has changed since Rev ${latest.rev_no}.`);
      e.status = 409; e.code = 'NO_CHANGES'; throw e;
    }
    const revNo = (latest ? Number(latest.rev_no) : 0) + 1;
    await conn.query(
      `INSERT INTO fab_template_revisions (company_id, template_item_id, rev_no, tree_json, note, released_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [companyId, templateItemId, revNo, JSON.stringify(tree), note ? String(note).trim().slice(0, 500) || null : null, userId],
    );
    if (owned) await conn.commit();
    return { rev: revNo };
  } catch (err) {
    if (owned) await conn.rollback();
    if (err.code === 'ER_DUP_ENTRY' || err.errno === 1062) {
      const e = new Error('Somebody released this template at the same moment — reload and try again.');
      e.status = 409; e.code = 'RELEASE_RACE'; throw e;
    }
    throw err;
  } finally {
    if (owned) conn.release();
  }
}

/**
 * The tree a NEW ORDER starts from: the latest released revision, with its
 * picks resolved against today's catalog. `tree.revision` carries the number
 * to the build, which records it on the order line.
 */
export async function draftForOrder(companyId, templateItemId, conn = null) {
  const exec = conn ?? pool;
  const latest = await latestRow(exec, companyId, templateItemId);
  if (!latest) {
    const [[item]] = await exec.query('SELECT name FROM fab_item_catalog WHERE id = ? AND company_id = ?', [templateItemId, companyId]);
    const e = new Error(`${item?.name ?? 'This template'} has no released revision yet. Release Rev 1 from its Bill of Materials first.`);
    e.status = 409; e.code = 'NOT_RELEASED'; throw e;
  }
  const tree = clone(latest.tree);
  await resolvePicks(exec, companyId, tree);
  tree.revision = Number(latest.rev_no);
  return tree;
}
