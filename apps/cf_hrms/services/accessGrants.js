/**
 * accessGrants.js — reading and writing a role's rights as the PLATFORM stores
 * them. (TM/CF_HRMS_HIRING_SPEC.md §12.2, §12.4.)
 *
 * A right is a `features` row (feature_tag). A role holds it through
 *
 *     role_capability (role, company, app)  ->  features_capability  ->  features
 *
 * and this file is the only place cf_hrms writes those three tables. It is used
 * by the migration (scripts/setup-access.mjs) and by the screen
 * (services/accessService.js), so both write the same rows.
 *
 * THE RULES IT KEEPS, each of them a trap on this platform:
 *   - ONE CAPABILITY PER TAG, named after the tag, holding exactly that one
 *     feature. A capability that held two would grant two.
 *   - A grant is for THIS company and THIS app: `app_id` is always the id of the
 *     company's own cf_hrms app. Never NULL — the platform reads a NULL app_id
 *     as "every app" — and never another company's.
 *   - NO DUPLICATES. `role_capability` has no unique key, so a second insert is
 *     a second row; every insert here is preceded by a read, and a duplicate
 *     found on the way is retired.
 *   - Rows are retired (deleted_at), never erased.
 *
 * Every function takes the caller's connection and belongs in its transaction.
 */
import { ALL_TAGS, OLD_TAGS, isKnownTag, tagName, orderTags } from '../lib/access.js';

export const APP_SLUG = 'cf_hrms';

/** The company's own cf_hrms app row, or null. */
export async function hrmsAppOf(conn, companyId) {
  const [[app]] = await conn.query('SELECT id, name FROM apps WHERE company_id = ? AND slug = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [companyId, APP_SLUG]);
  return app ?? null;
}

const jsonIds = (raw) => {
  if (Array.isArray(raw)) return raw.map(Number);
  try { const parsed = JSON.parse(raw ?? '[]'); return Array.isArray(parsed) ? parsed.map(Number) : []; } catch { return []; }
};

/**
 * The feature row and the single-feature capability of every tag of the model.
 * Global rows, created once. With `apply: false` nothing is written and what is
 * missing is reported.
 *
 * @returns {{ byTag: Map<string, { featureId, capabilityId }>, capabilityTag: Map<number, string>,
 *             created: { features: string[], capabilities: string[] }, repaired: string[] }}
 */
export async function ensureCatalog(conn, { apply = true } = {}) {
  const created = { features: [], capabilities: [] };
  const repaired = [];
  const [features] = await conn.query('SELECT id, feature_tag, deleted_at FROM features WHERE feature_tag IN (?)', [ALL_TAGS]);
  const featureOf = new Map(features.map((f) => [f.feature_tag, f]));
  for (const tag of ALL_TAGS) {
    const f = featureOf.get(tag);
    if (f && f.deleted_at == null) continue;
    created.features.push(tag);
    if (!apply) continue;
    if (f) {
      // The tag is unique whether or not the row is deleted, so a retired one is brought back.
      await conn.query('UPDATE features SET deleted_at = NULL WHERE id = ?', [f.id]);
      featureOf.set(tag, { ...f, deleted_at: null });
    } else {
      // 'frontend': the platform copies only frontend tags into a login token from the company role.
      const [res] = await conn.query("INSERT INTO features (feature_name, feature_tag, type) VALUES (?, ?, 'frontend')", [tagName(tag), tag]);
      featureOf.set(tag, { id: res.insertId, feature_tag: tag, deleted_at: null });
    }
  }

  const [capabilities] = await conn.query(
    'SELECT capability_id, name, features_json FROM features_capability WHERE name IN (?) AND deleted_at IS NULL ORDER BY capability_id', [ALL_TAGS]);
  const capabilityOf = new Map();
  for (const cap of capabilities) if (!capabilityOf.has(cap.name)) capabilityOf.set(cap.name, cap);

  const byTag = new Map();
  const capabilityTag = new Map();
  for (const tag of ALL_TAGS) {
    const featureId = featureOf.get(tag)?.id ?? null;
    let cap = capabilityOf.get(tag) ?? null;
    if (!cap) {
      created.capabilities.push(tag);
      if (apply && featureId != null) {
        const [res] = await conn.query('INSERT INTO features_capability (name, features_json) VALUES (?, ?)', [tag, JSON.stringify([featureId])]);
        cap = { capability_id: res.insertId, name: tag, features_json: [featureId] };
      }
    } else if (featureId != null) {
      // A capability named after one tag must hold that one feature and no other.
      const ids = jsonIds(cap.features_json);
      if (ids.length !== 1 || ids[0] !== featureId) {
        repaired.push(tag);
        if (apply) await conn.query('UPDATE features_capability SET features_json = ? WHERE capability_id = ?', [JSON.stringify([featureId]), cap.capability_id]);
      }
    }
    byTag.set(tag, { featureId, capabilityId: cap?.capability_id ?? null });
    if (cap) capabilityTag.set(cap.capability_id, tag);
  }
  return { byTag, capabilityTag, created, repaired };
}

/**
 * The cf_hrms tags each role holds in this app, AS THE PLATFORM RESOLVES THEM
 * on a request (core/middleware/authmiddleware.js): a grant for this app, or one
 * with no app at all. Old tags and new, in one read.
 *
 * @returns Map<roleId, { tags: Set<string>, wildcard: Set<string> }> — `wildcard` are the
 *          tags that reach the role through a grant with no app (which this file never writes).
 */
export async function tagsOfRoles(conn, { appId, roleIds }) {
  const out = new Map(roleIds.map((id) => [Number(id), { tags: new Set(), wildcard: new Set() }]));
  if (!roleIds.length) return out;
  const [rows] = await conn.query(
    `SELECT DISTINCT rc.role_id, f.feature_tag, (rc.app_id IS NULL) AS wildcard
       FROM role_capability rc
       JOIN features_capability fca ON fca.capability_id = rc.capability_id AND fca.deleted_at IS NULL
       JOIN features f ON JSON_CONTAINS(fca.features_json, CAST(f.id AS JSON)) AND f.deleted_at IS NULL
      WHERE rc.role_id IN (?) AND (rc.app_id = ? OR rc.app_id IS NULL) AND rc.deleted_at IS NULL
        AND f.feature_tag LIKE 'cf\\_hrms\\_%'`,
    [roleIds, appId],
  );
  for (const r of rows) {
    const entry = out.get(Number(r.role_id));
    entry.tags.add(r.feature_tag);
    if (Number(r.wildcard)) entry.wildcard.add(r.feature_tag);
  }
  return out;
}

/** The rights of the new model among a set of tags, in catalogue order. */
export const newTagsOf = (tags) => orderTags([...tags].filter(isKnownTag));
/** The old tags among a set. */
export const oldTagsOf = (tags) => OLD_TAGS.filter((t) => tags.has(t));

/**
 * Make a role hold exactly `tags` (of the new model) in this company's cf_hrms
 * app: missing grants are inserted, others retired, duplicates retired. Grants
 * of the old tags that are not in the new model, and grants for other apps, are
 * not read and not touched.
 *
 * `addOnly` inserts what is missing and retires nothing — the migration uses it
 * for roles that already exist.
 *
 * @returns {{ added: string[], removed: string[], stuck: string[] }} — `stuck`: asked to be removed but
 *          still held through a grant with no app, which belongs to whoever wrote it.
 */
export async function setRoleTags(conn, { companyId, appId, roleId, tags, catalog, addOnly = false }) {
  if (!companyId || !appId || !roleId) throw new Error('[cf_hrms] setRoleTags needs a company, an app and a role.');
  const [[role]] = await conn.query('SELECT id FROM roles WHERE id = ? AND company_id = ? AND deleted_at IS NULL', [roleId, companyId]);
  if (!role) throw new Error(`[cf_hrms] role ${roleId} is not a role of company ${companyId}.`);
  const [[app]] = await conn.query('SELECT id FROM apps WHERE id = ? AND company_id = ? AND slug = ? AND deleted_at IS NULL', [appId, companyId, APP_SLUG]);
  if (!app) throw new Error(`[cf_hrms] app ${appId} is not company ${companyId}'s cf_hrms app.`);

  const want = new Set(tags.filter(isKnownTag));
  const capabilityIds = [...catalog.byTag.values()].map((v) => v.capabilityId).filter((v) => v != null);
  const [rows] = capabilityIds.length ? await conn.query(
    `SELECT id, capability_id FROM role_capability
      WHERE role_id = ? AND app_id = ? AND deleted_at IS NULL AND capability_id IN (?) ORDER BY id FOR UPDATE`,
    [roleId, appId, capabilityIds],
  ) : [[]];

  const have = new Map(); // tag -> first grant row id
  const retire = [];
  const removed = [];
  for (const r of rows) {
    const tag = catalog.capabilityTag.get(r.capability_id);
    if (have.has(tag)) { retire.push(r.id); continue; }       // a duplicate
    have.set(tag, r.id);
    if (!want.has(tag) && !addOnly) { retire.push(r.id); removed.push(tag); }
  }
  if (retire.length) await conn.query('UPDATE role_capability SET deleted_at = NOW() WHERE id IN (?) AND role_id = ? AND app_id = ?', [retire, roleId, appId]);

  const added = ALL_TAGS.filter((t) => want.has(t) && !have.has(t));
  const missing = added.filter((t) => catalog.byTag.get(t)?.capabilityId == null);
  if (missing.length) throw new Error(`[cf_hrms] no capability for ${missing.join(', ')} — run ensureCatalog first.`);
  if (added.length) {
    await conn.query(
      `INSERT INTO role_capability (role_id, team_id, company_id, app_id, capability_id) VALUES ${added.map(() => '(?, NULL, ?, ?, ?)').join(', ')}`,
      added.flatMap((t) => [roleId, companyId, appId, catalog.byTag.get(t).capabilityId]),
    );
  }

  let stuck = [];
  if (removed.length) {
    const still = (await tagsOfRoles(conn, { appId, roleIds: [roleId] })).get(Number(roleId));
    stuck = removed.filter((t) => still.tags.has(t));
  }
  return { added, removed: orderTags(removed), stuck };
}

export default { APP_SLUG, hrmsAppOf, ensureCatalog, tagsOfRoles, newTagsOf, oldTagsOf, setRoleTags };
