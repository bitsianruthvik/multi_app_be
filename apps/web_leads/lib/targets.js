/**
 * targets.js — the places a website lead is sent after it is saved. Each target says whether it is
 * set up (`configured`) and sends one lead (`send`). `send` throws on a failure worth retrying, and
 * returns { skipped: reason } when this lead must not go there at all (e.g. no marketing consent).
 * Environment values are read here and never logged.
 */
import crypto from 'crypto';

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** Raised for a failure that will never succeed on a retry (bad request, too old for Meta). */
export class PermanentError extends Error {}

async function postJson(url, body, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (res.ok) return res;
  const text = (await res.text().catch(() => '')).slice(0, 300);
  const err = res.status >= 400 && res.status < 500 && res.status !== 429 ? PermanentError : Error;
  throw new err(`HTTP ${res.status} ${text}`);
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ---- team email (nodemailer over SMTP_URL, like the rest of the backend) ----
let transport = null;
export const email = {
  configured: () => Boolean(process.env.SMTP_URL && process.env.WEB_LEADS_NOTIFY_TO),
  async send(lead) {
    if (!transport) {
      const { default: nodemailer } = await import('nodemailer');
      transport = nodemailer.createTransport(process.env.SMTP_URL);
    }
    const rows = [
      ['Name', lead.name], ['Email', lead.email], ['Phone', lead.phone], ['Organisation', lead.organisation],
      ['Subject', lead.subject], ['Page', lead.page_url], ['Received', lead.received_at.toISOString()],
    ].filter(([, v]) => v);
    await transport.sendMail({
      from: process.env.WEB_LEADS_FROM || process.env.ALERT_FROM || 'Website <no-reply@ceofactory.vc>',
      to: process.env.WEB_LEADS_NOTIFY_TO,
      replyTo: lead.email,
      subject: `Website enquiry: ${lead.subject || lead.name}`.slice(0, 150),
      html: `<table>${rows.map(([k, v]) => `<tr><td><b>${k}</b></td><td>${esc(v)}</td></tr>`).join('')}</table>`
        + `<p>${esc(lead.message).replace(/\n/g, '<br>')}</p>`,
    });
  },
};

// ---- Meta Conversions API ----
// Phone: digits only with the country code; a bare 10-digit number is taken as Indian (+91).
const normPhone = (p) => {
  const d = String(p || '').replace(/\D/g, '').replace(/^0+/, '');
  return d.length === 10 ? `91${d}` : d;
};
export const metaCapi = {
  configured: () => Boolean(process.env.META_PIXEL_ID && process.env.META_CAPI_TOKEN),
  async send(lead) {
    if (!lead.consent_marketing) return { skipped: 'no marketing consent' };
    const ageDays = (Date.now() - lead.received_at.getTime()) / 86_400_000;
    if (ageDays > 6.5) throw new PermanentError('older than Meta accepts (7 days)');
    const ctx = lead.capi_context || {};
    const [first, ...rest] = lead.name.trim().toLowerCase().split(/\s+/);
    const user_data = {
      em: [sha256(lead.email.trim().toLowerCase())],
      ...(lead.phone && normPhone(lead.phone) ? { ph: [sha256(normPhone(lead.phone))] } : {}),
      ...(first ? { fn: [sha256(first)] } : {}),
      ...(rest.length ? { ln: [sha256(rest.join(' '))] } : {}),
      ...(ctx.ip ? { client_ip_address: ctx.ip } : {}),
      ...(ctx.userAgent ? { client_user_agent: ctx.userAgent } : {}),
      ...(ctx.fbp ? { fbp: ctx.fbp } : {}),
      ...(ctx.fbc ? { fbc: ctx.fbc } : {}),
    };
    const version = process.env.META_GRAPH_VERSION || 'v23.0';
    const base = process.env.META_GRAPH_BASE || 'https://graph.facebook.com'; // a test points this at a fake
    const url = `${base}/${version}/${encodeURIComponent(process.env.META_PIXEL_ID)}/events`;
    await postJson(url, {
      data: [{
        event_name: 'Lead',
        event_time: Math.floor(lead.received_at.getTime() / 1000),
        event_id: lead.event_id,
        action_source: 'website',
        ...(lead.page_url ? { event_source_url: lead.page_url } : {}),
        user_data,
      }],
      ...(process.env.META_TEST_EVENT_CODE ? { test_event_code: process.env.META_TEST_EVENT_CODE } : {}),
      access_token: process.env.META_CAPI_TOKEN,
    });
  },
};

// ---- CRM (any CRM that accepts a webhook: HubSpot / Zoho flows, Make, Zapier, our own) ----
// Signed with HMAC-SHA256 of the body in X-Signature when WEB_LEADS_CRM_SECRET is set.
export const crmWebhook = {
  configured: () => Boolean(process.env.WEB_LEADS_CRM_WEBHOOK_URL),
  async send(lead) {
    const body = {
      event_id: lead.event_id, received_at: lead.received_at.toISOString(), site: lead.site, form: lead.form,
      name: lead.name, email: lead.email, phone: lead.phone, organisation: lead.organisation,
      subject: lead.subject, message: lead.message, page_url: lead.page_url, referrer: lead.referrer,
      utm: lead.utm, attribution: lead.attribution, consent_marketing: Boolean(lead.consent_marketing),
    };
    const secret = process.env.WEB_LEADS_CRM_SECRET;
    const headers = secret
      ? { 'x-signature': crypto.createHmac('sha256', secret).update(JSON.stringify(body)).digest('hex') }
      : {};
    await postJson(process.env.WEB_LEADS_CRM_WEBHOOK_URL, body, headers);
  },
};

export const TARGETS = { email, meta_capi: metaCapi, crm_webhook: crmWebhook };
