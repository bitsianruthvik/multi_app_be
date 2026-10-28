/**
 * deliver.js — sends saved website leads to their destinations, and retries the ones that failed.
 *
 * Each (lead, target) row in web_lead_deliveries is CLAIMED before sending (pending → sending, only if
 * it is still pending), so two servers or an overlapping sweep never send the same lead twice. A
 * failure is retried with growing gaps (BACKOFF); after the last one it stays `failed` with its error,
 * for someone to look at. The sweep runs every few minutes, so nothing depends on Redis being up or
 * on the server staying awake after the request (Render may sleep it).
 */
import { pool } from '../../../db.js';
import { logger } from '../../../core/utils/logger.js';
import { TARGETS, PermanentError } from './targets.js';

const BACKOFF_MIN = [1, 5, 30, 120, 720]; // minutes before attempt 2, 3, 4, 5, 6
const MAX_ATTEMPTS = BACKOFF_MIN.length + 1;
const SENDING_STALE_MIN = 10;             // a `sending` row older than this was cut off mid-send

export async function createDeliveries(leadId) {
  const now = new Date();
  const rows = Object.entries(TARGETS).map(([target, t]) =>
    t.configured()
      ? [leadId, target, 'pending', 0, now, null, now]
      : [leadId, target, 'skipped', 0, null, 'not configured', now]);
  await pool.query(
    `INSERT IGNORE INTO web_lead_deliveries (lead_id, target, status, attempts, next_attempt_at, last_error, updated_at) VALUES ?`,
    [rows]);
  // No Meta set up: nothing will ever use the visitor's IP and browser, so don't keep them.
  if (!TARGETS.meta_capi.configured()) await pool.query(`UPDATE web_leads SET capi_context = NULL WHERE id = ?`, [leadId]);
}

async function loadLead(id) {
  const [[row]] = await pool.query(`SELECT * FROM web_leads WHERE id = ? AND deleted_at IS NULL`, [id]);
  if (!row) return null;
  const json = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
  return { ...row, utm: json(row.utm), attribution: json(row.attribution), capi_context: json(row.capi_context) };
}

async function finish(leadId, target, status, attempts, error, nextAt = null) {
  await pool.query(
    `UPDATE web_lead_deliveries SET status = ?, attempts = ?, last_error = ?, next_attempt_at = ?, updated_at = ?
      WHERE lead_id = ? AND target = ?`,
    [status, attempts, error ? String(error).slice(0, 500) : null, nextAt, new Date(), leadId, target]);
  // The visitor's IP, browser and Meta cookies are only for Meta: drop them once that is settled.
  if (target === 'meta_capi' && status !== 'pending') {
    await pool.query(`UPDATE web_leads SET capi_context = NULL WHERE id = ?`, [leadId]);
  }
}

async function deliverOne(leadId, target) {
  const [claim] = await pool.query(
    `UPDATE web_lead_deliveries SET status = 'sending', updated_at = ? WHERE lead_id = ? AND target = ? AND status = 'pending'`,
    [new Date(), leadId, target]);
  if (claim.affectedRows !== 1) return;
  const [[{ attempts }]] = await pool.query(
    `SELECT attempts FROM web_lead_deliveries WHERE lead_id = ? AND target = ?`, [leadId, target]);
  const tries = attempts + 1;
  const t = TARGETS[target];
  try {
    const lead = await loadLead(leadId);
    if (!lead) return await finish(leadId, target, 'skipped', tries, 'lead deleted');
    if (!t || !t.configured()) return await finish(leadId, target, 'skipped', tries, 'not configured');
    const out = await t.send(lead);
    if (out?.skipped) return await finish(leadId, target, 'skipped', tries, out.skipped);
    await finish(leadId, target, 'sent', tries, null);
    logger.info({ leadId, target }, '[web_leads] delivered');
  } catch (err) {
    const permanent = err instanceof PermanentError || tries >= MAX_ATTEMPTS;
    const nextAt = permanent ? null : new Date(Date.now() + BACKOFF_MIN[tries - 1] * 60_000);
    await finish(leadId, target, permanent ? 'failed' : 'pending', tries, err.message, nextAt);
    // The error text comes from the destination, never from the lead itself.
    logger.warn({ leadId, target, tries, permanent, error: String(err.message).slice(0, 200) }, '[web_leads] delivery failed');
  }
}

/** Send everything a new lead is waiting for. Never throws. */
export async function deliverLead(leadId) {
  for (const target of Object.keys(TARGETS)) {
    try { await deliverOne(leadId, target); } catch (err) {
      logger.error({ leadId, target, error: err.message }, '[web_leads] deliver crashed');
    }
  }
}

/** Retry whatever is due, and rescue rows a restart left in `sending`. */
export async function sweep() {
  const now = new Date();
  await pool.query(
    `UPDATE web_lead_deliveries SET status = 'pending', next_attempt_at = ?
      WHERE status = 'sending' AND updated_at < ?`,
    [now, new Date(now.getTime() - SENDING_STALE_MIN * 60_000)]);
  const [due] = await pool.query(
    `SELECT lead_id, target FROM web_lead_deliveries
      WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT 50`, [now]);
  for (const { lead_id, target } of due) await deliverOne(lead_id, target);
}

let timer = null;
export function startSweeper(everyMs = 5 * 60_000) {
  if (timer || process.env.WEB_LEADS_SWEEP === 'off') return;
  timer = setInterval(() => sweep().catch((err) => logger.error({ error: err.message }, '[web_leads] sweep failed')), everyMs);
  timer.unref?.();
}
