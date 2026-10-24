/**
 * notices.js — the platform console's queue (spec §36.4): what the watcher found, a reviewer's work on
 * it, and publishing.
 *
 *   NEW ──open──▶ OPEN ──link to a rule──▶ LINKED ──publish──▶ PUBLISHED
 *     └────────────── dismiss (a reason, always) ─────────────▶ DISMISSED
 *
 * "Draft a new version" asks the law layer (lawAdapter.draftVersion) for a DRAFT and keeps its id on
 * the notice; "Publish" calls the law layer's publishVersion with it. Until the law layer exists the
 * adapter stores no draft: the new value, its date and the words for HR come with "Publish" and the
 * publication row keeps them.
 *
 * However a version is published — here, or on the law layer's own screens — handlePublished() makes
 * ONE publication row per rule version and tells every company (notify.js). It is idempotent: the law
 * layer's onPublish hook and this file may both call it for the same version.
 */
import { pool, withTransaction } from '../../lib/db.js';
import { invalid, notFound, conflict } from '../../lib/errors.js';
import { draftVersion, publishVersion, onPublish, fireStubPublish, lawStatus } from './lawAdapter.js';
import { notifyPublication } from './notify.js';
import { DOMAINS } from './sources.js';

const json = (v, d = null) => { if (v == null) return d; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch { return d; } };
const dateText = (v) => (v == null ? null : (v instanceof Date ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}` : String(v).slice(0, 10)));
const stamp = (v) => (v ? (v instanceof Date ? v.toISOString() : String(v)) : null);
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

export function shapeNotice(r) {
  return {
    id: r.id, sourceId: r.source_id, source: r.source_name ? { id: r.source_id, code: r.source_code, name: r.source_name, domains: json(r.source_domains, []), jurisdictions: json(r.source_jurisdictions, []) } : null,
    changeKind: r.change_kind, title: r.title, url: r.url, itemDate: dateText(r.item_date), foundAt: stamp(r.found_at), status: r.status,
    summary: r.summary ?? null, domain: r.domain ?? null, jurisdiction: r.jurisdiction ?? null, ruleKey: r.rule_key ?? null, ruleVersionId: r.rule_version_id ?? null,
    reviewer: r.reviewer_name ?? null, openedAt: stamp(r.opened_at), linkedAt: stamp(r.linked_at), dismissedReason: r.dismissed_reason ?? null, dismissedAt: stamp(r.dismissed_at),
    publicationId: r.publication_id ?? null,
  };
}
const SELECT = `SELECT n.*, s.code AS source_code, s.name AS source_name, s.domains_json AS source_domains, s.jurisdictions_json AS source_jurisdictions, u.name AS reviewer_name
  FROM hrms_compliance_notices n JOIN hrms_compliance_sources s ON s.id = n.source_id LEFT JOIN users u ON u.id = n.reviewer_user_id`;

export async function listNotices(db, { status = 'WAITING', limit = 300 } = {}) {
  const where = ['n.deleted_at IS NULL'];
  const params = [];
  if (status === 'WAITING') where.push("n.status IN ('NEW', 'OPEN', 'LINKED')");
  else if (status !== 'ALL') { where.push('n.status = ?'); params.push(status); }
  const [rows] = await db.query(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY n.found_at DESC, n.id DESC LIMIT ?`, [...params, limit]);
  const [counts] = await db.query('SELECT status, COUNT(*) AS n FROM hrms_compliance_notices WHERE deleted_at IS NULL GROUP BY status');
  return { notices: rows.map(shapeNotice), counts: Object.fromEntries(counts.map((c) => [c.status, Number(c.n)])) };
}

async function noticeRow(db, id, { forUpdate = false } = {}) {
  const [[r]] = await db.query(`${SELECT} WHERE n.id = ? AND n.deleted_at IS NULL${forUpdate ? ' FOR UPDATE' : ''}`, [id]);
  if (!r) throw notFound('That notice');
  return r;
}

/** Opening a NEW notice makes it OPEN with this reviewer. */
export async function openNotice(db, user, id) {
  const r = await noticeRow(db, id);
  if (r.status === 'NEW') await db.query("UPDATE hrms_compliance_notices SET status = 'OPEN', reviewer_user_id = ?, opened_at = ? WHERE id = ? AND status = 'NEW'", [user.id, new Date(), id]);
  return shapeNotice(await noticeRow(db, id));
}

const closed = (r) => ['PUBLISHED', 'DISMISSED'].includes(r.status);

export async function linkNotice(db, user, id, body = {}) {
  const r = await noticeRow(db, id);
  if (closed(r)) throw conflict('NOTICE_CLOSED', `This notice is ${r.status.toLowerCase()} already.`);
  const domain = String(body.domain ?? '').toUpperCase();
  const jurisdiction = String(body.jurisdiction ?? 'IN').toUpperCase();
  const ruleKey = String(body.ruleKey ?? '').trim();
  const problems = [];
  if (!DOMAINS.includes(domain) || domain === 'ALL') problems.push(`Domain: one of ${DOMAINS.filter((d) => d !== 'ALL').join(', ')}.`);
  if (!/^[A-Z]{2}$/.test(jurisdiction)) problems.push('Jurisdiction: IN or a two-letter state code.');
  if (!ruleKey || ruleKey.length > 64) problems.push('Rule: its key, up to 64 characters.');
  if (problems.length) throw invalid('INVALID', 'The notice cannot be linked yet.', { problems });
  await db.query("UPDATE hrms_compliance_notices SET status = 'LINKED', domain = ?, jurisdiction = ?, rule_key = ?, reviewer_user_id = ?, linked_at = ?, opened_at = COALESCE(opened_at, ?) WHERE id = ?",
    [domain, jurisdiction, ruleKey, user.id, new Date(), new Date(), id]);
  return shapeNotice(await noticeRow(db, id));
}

export async function dismissNotice(db, user, id, body = {}) {
  const reason = String(body.reason ?? '').trim();
  if (reason.length < 3) throw invalid('INVALID', 'Say why it is dismissed.', { problems: ['A reason (an office order, not a rule; already published; …).'] });
  const r = await noticeRow(db, id);
  if (closed(r)) throw conflict('NOTICE_CLOSED', `This notice is ${r.status.toLowerCase()} already.`);
  await db.query("UPDATE hrms_compliance_notices SET status = 'DISMISSED', dismissed_reason = ?, dismissed_at = ?, reviewer_user_id = ? WHERE id = ?", [reason.slice(0, 500), new Date(), user.id, id]);
  return shapeNotice(await noticeRow(db, id));
}

/** The publish form, checked. */
function cleanPublish(body, notice) {
  const problems = [];
  const title = String(body.title ?? notice?.title ?? '').trim();
  const effectiveFrom = body.effectiveFrom;
  const summary = body.summary == null ? null : String(body.summary).trim();
  if (!title || title.length > 300) problems.push('Title: what changed, up to 300 characters.');
  if (!isDate(effectiveFrom)) problems.push('In force from: a date as YYYY-MM-DD.');
  if (summary && summary.length > 4000) problems.push('Words for HR: up to 4,000 characters.');
  if (body.value !== undefined && (typeof body.value !== 'object' || body.value === null)) problems.push('Value: the rule\'s new value as an object.');
  return { problems, title, effectiveFrom, summary, value: body.value ?? null, versionLabel: body.versionLabel ? String(body.versionLabel).slice(0, 40) : null };
}

/** "Draft a new version": the law layer makes the DRAFT; its id is kept on the notice. */
export async function draftForNotice(db, user, id, body = {}) {
  const r = await noticeRow(db, id);
  if (r.status !== 'LINKED') throw conflict('NOT_LINKED', 'Link the notice to a rule first.');
  const status = await lawStatus();
  if (!status.present || status.missing.includes('draftVersion')) {
    return { notice: shapeNotice(r), draft: null, lawLayer: status, message: 'The law layer is not there yet: give the new value, its date and the words for HR with Publish.' };
  }
  // The law layer checks the draft (value, dates, tax year and regime for TAX; fromId copies an existing version).
  const draft = await draftVersion(db, {
    ...body, domain: r.domain, jurisdiction: r.jurisdiction, ruleKey: r.rule_key,
    sourceUrl: body.sourceUrl ?? r.url, sourceNote: body.sourceNote ?? `${r.title} — found by the compliance watcher`,
  }, user);
  if (draft?.id) await db.query('UPDATE hrms_compliance_notices SET rule_version_id = ? WHERE id = ?', [draft.id, id]);
  return { notice: shapeNotice(await noticeRow(db, id)), draft, lawLayer: status };
}

/**
 * One publication per rule version (or per notice, through the adapter), then every company is told.
 * `version` is the law layer's (normalised), or the console's stub: { domain, jurisdiction, ruleKey, … }.
 */
export async function handlePublished(version, { noticeId = null, user = null, via = version?.via ?? 'LAW_LAYER', title = null, summary = null } = {}) {
  const pubId = await withTransaction(async (conn) => {
    if (version.id && via === 'LAW_LAYER') {
      const [[have]] = await conn.query('SELECT id FROM hrms_compliance_publications WHERE rule_version_id = ? AND deleted_at IS NULL FOR UPDATE', [String(version.id)]);
      if (have) return have.id;
    }
    // Who published: the console's login, or the law layer's own words ("platform: <name>") for a publish made on its screens.
    const byName = (user?.name ?? version.reviewedBy ?? 'the law layer').slice(0, 150);
    const [ins] = await conn.query(
      `INSERT INTO hrms_compliance_publications (notice_id, domain, jurisdiction, rule_key, rule_version_id, version_label, title, summary, effective_from, value_json, source_url, via, published_by, published_by_name, published_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [noticeId, version.domain, version.jurisdiction ?? 'IN', version.ruleKey, via === 'LAW_LAYER' && version.id != null ? String(version.id) : null,
        version.versionLabel ?? (version.version ? `v${version.version}` : null),
        (title ?? version.title ?? `${version.domain} ${version.ruleKey}`).slice(0, 300), summary ?? version.summary ?? version.sourceNote ?? null, version.effectiveFrom,
        version.value == null ? null : JSON.stringify(version.value), version.sourceUrl ?? null, via, user?.id ?? null, byName, new Date()]);
    if (noticeId) await conn.query("UPDATE hrms_compliance_notices SET status = 'PUBLISHED', publication_id = ? WHERE id = ?", [ins.insertId, noticeId]);
    return ins.insertId;
  });
  const notified = await withTransaction((conn) => notifyPublication(conn, pubId));
  return { publicationId: pubId, notified };
}

/** What the console is publishing right now, by version id: its notice, login and words (the law layer's hook fires inside publishVersion). */
const publishing = new Map();

let registered = false;
/** The law layer's publishes are announced — its own screens' and the console's. Called once by app.js / a test. */
export async function listenForPublishes() {
  if (registered) return;
  registered = true;
  await onPublish(async (version) => {
    if (version?.via === 'ADAPTER') return; // the console's stub publish announces itself
    const ctx = publishing.get(String(version.id));
    if (ctx) { ctx.result = await handlePublished(version, { ...ctx, via: 'LAW_LAYER' }); return; }
    const [[n]] = await pool.query('SELECT id FROM hrms_compliance_notices WHERE rule_version_id = ? AND deleted_at IS NULL LIMIT 1', [String(version.id ?? '')]);
    await handlePublished(version, { noticeId: n?.id ?? null, via: 'LAW_LAYER' });
  });
}

/** "Publish" on the console. */
export async function publishNotice(db, user, id, body = {}) {
  const r = await noticeRow(db, id);
  if (r.status !== 'LINKED') throw conflict('NOT_LINKED', r.status === 'PUBLISHED' ? 'This notice is published already.' : 'Link the notice to a rule first.');
  const p = cleanPublish(body, r);
  if (p.problems.length) throw invalid('INVALID', 'The change cannot be published yet.', { problems: p.problems });
  const status = await lawStatus();
  const lawCanPublish = status.present && !status.missing.includes('publishVersion');
  let result;
  if (lawCanPublish && r.rule_version_id) {
    const ctx = { noticeId: r.id, user, title: p.title, summary: p.summary };
    publishing.set(String(r.rule_version_id), ctx);
    try {
      const done = await publishVersion(db, r.rule_version_id, user);
      // The hook made the publication; if the law layer fired no hook, make it here (idempotent by version id).
      result = ctx.result ?? await handlePublished({ ...(done.version ?? {}), id: r.rule_version_id, domain: done.version?.domain ?? r.domain, jurisdiction: done.version?.jurisdiction ?? r.jurisdiction, ruleKey: done.version?.ruleKey ?? r.rule_key, effectiveFrom: done.version?.effectiveFrom ?? p.effectiveFrom, sourceUrl: done.version?.sourceUrl ?? r.url }, { ...ctx, via: 'LAW_LAYER' });
    } finally {
      publishing.delete(String(r.rule_version_id));
    }
  } else {
    if (lawCanPublish) throw conflict('NO_DRAFT', 'The law layer is there: draft the new version first (Draft a new version), then publish it.');
    const version = { domain: r.domain, jurisdiction: r.jurisdiction, ruleKey: r.rule_key, effectiveFrom: p.effectiveFrom, value: p.value, sourceUrl: r.url, versionLabel: p.versionLabel, via: 'ADAPTER' };
    result = await handlePublished(version, { noticeId: r.id, user, via: 'ADAPTER', title: p.title, summary: p.summary });
    await fireStubPublish({ ...version, publicationId: result?.publicationId });
  }
  return { notice: shapeNotice(await noticeRow(pool, id)), ...result };
}

export async function listPublications(db, { limit = 200 } = {}) {
  const [rows] = await db.query(
    `SELECT p.*, u.name AS publisher, (SELECT COUNT(*) FROM hrms_compliance_notifications n WHERE n.publication_id = p.id AND n.deleted_at IS NULL AND n.status = 'ACKNOWLEDGED') AS acknowledged
       FROM hrms_compliance_publications p LEFT JOIN users u ON u.id = p.published_by WHERE p.deleted_at IS NULL ORDER BY p.published_at DESC, p.id DESC LIMIT ?`, [limit]);
  return rows.map((r) => ({
    id: r.id, noticeId: r.notice_id, domain: r.domain, jurisdiction: r.jurisdiction, ruleKey: r.rule_key, ruleVersionId: r.rule_version_id, versionLabel: r.version_label,
    title: r.title, summary: r.summary, effectiveFrom: dateText(r.effective_from), value: json(r.value_json, null), sourceUrl: r.source_url, via: r.via,
    publishedBy: r.publisher ?? r.published_by_name, publishedAt: stamp(r.published_at), companiesNotified: Number(r.companies_notified), acknowledged: Number(r.acknowledged),
  }));
}

export default { listNotices, openNotice, linkNotice, dismissNotice, draftForNotice, publishNotice, handlePublished, listenForPublishes, listPublications, shapeNotice };
