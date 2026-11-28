/**
 * POST /api/public/website/leads — the website's server code hands over one form submission.
 *
 * Only the website may call it: the request must carry X-Website-Key equal to WEB_LEADS_KEY (set on
 * both the backend and the website (TM/ceofactory_site, on the AWS server); never sent to a browser). The lead is saved,
 * the response goes back at once, and sending to the destinations happens after (lib/deliver.js).
 * Posting the same event_id twice returns the first lead (the website may retry).
 *
 * Logs carry the lead id only — never the visitor's name, email, phone or message.
 */
import crypto from 'crypto';
import { Router } from 'express';
import { pool } from '../../../db.js';
import { logger } from '../../../core/utils/logger.js';
import { createDeliveries, deliverLead } from '../lib/deliver.js';

const router = Router();

function keyOk(given) {
  const want = process.env.WEB_LEADS_KEY;
  if (!want || typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const str = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EVENT_ID = /^[A-Za-z0-9_-]{8,64}$/;

/** The fields we keep, cleaned; or { error } naming the first bad one. */
export function readLead(body) {
  const b = body && typeof body === 'object' ? body : {};
  const lead = {
    event_id: str(b.eventId, 64),
    site: str(b.site, 60) || 'ceofactory.vc',
    form: str(b.form, 40) || 'contact',
    name: str(b.name, 200),
    email: str(b.email, 254)?.toLowerCase() ?? null,
    phone: str(b.phone, 40),
    organisation: str(b.organisation, 200),
    subject: str(b.subject, 200),
    message: str(b.message, 5000),
    page_url: str(b.pageUrl, 500),
    referrer: str(b.referrer, 500),
    consent_marketing: b.consent?.marketing === true ? 1 : 0,
  };
  if (!lead.event_id || !EVENT_ID.test(lead.event_id)) return { error: 'eventId' };
  if (!lead.name) return { error: 'name' };
  if (!lead.email || !EMAIL.test(lead.email)) return { error: 'email' };
  const utm = {};
  for (const k of ['source', 'medium', 'campaign', 'term', 'content']) {
    const v = str(b.utm?.[k], 200);
    if (v) utm[k] = v;
  }
  lead.utm = Object.keys(utm).length ? JSON.stringify(utm) : null;
  // Where on the website it came from (page IDs, topic cluster, landing URL already cut to campaign parameters).
  const at = {};
  const a = b.attribution || {};
  for (const [k, max] of [['product', 10], ['pageId', 120], ['landingUrl', 500], ['landingPageId', 120], ['cluster', 80]]) {
    const v = str(a[k], max);
    if (v) at[k] = v;
  }
  lead.attribution = Object.keys(at).length ? JSON.stringify(at) : null;
  const c = b.context || {};
  const ctx = { ip: str(c.ip, 64), userAgent: str(c.userAgent, 500), fbp: str(c.fbp, 200), fbc: str(c.fbc, 300) };
  // Without marketing consent nothing goes to Meta, so there is no reason to keep these.
  lead.capi_context = lead.consent_marketing && Object.values(ctx).some(Boolean) ? JSON.stringify(ctx) : null;
  return { lead };
}

router.post('/leads', async (req, res) => {
  if (!keyOk(req.get('x-website-key'))) {
    logger.warn('[web_leads] refused: bad or missing website key');
    return res.status(401).json({ ok: false, error: 'unauthorised' });
  }
  const { lead, error } = readLead(req.body);
  if (error) return res.status(400).json({ ok: false, error: `invalid ${error}` });

  try {
    const cols = Object.keys(lead);
    const [r] = await pool.query(
      `INSERT IGNORE INTO web_leads (${cols.join(', ')}, received_at) VALUES (?)`,
      [[...cols.map((k) => lead[k]), new Date()]]);
    let id = r.insertId;
    const duplicate = r.affectedRows === 0;
    if (duplicate) {
      const [[row]] = await pool.query(`SELECT id FROM web_leads WHERE event_id = ?`, [lead.event_id]);
      id = row.id;
    } else {
      await createDeliveries(id);
    }
    res.status(duplicate ? 200 : 201).json({ ok: true, id, duplicate });
    logger.info({ leadId: id, duplicate }, '[web_leads] received');
    if (!duplicate) setImmediate(() => deliverLead(id));
  } catch (err) {
    logger.error({ error: err.message }, '[web_leads] save failed');
    if (!res.headersSent) res.status(500).json({ ok: false, error: 'save failed' });
  }
});

export default router;
