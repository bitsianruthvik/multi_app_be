/**
 * channels.js — how an alert reaches a person (TM/CF_HRMS_HIRING_SPEC.md §42.3).
 *
 * FOUR CHANNELS, ONE SHAPE. In-app and email work now; SMS and WhatsApp are STUBS that send nothing until a
 * provider is configured (the delivery is recorded NOT_CONFIGURED, so HR can see what would have gone).
 *
 * ═══ THE PROVIDER INTERFACE (for Gupshup, Twilio, MSG91 … later) ═══════════════════════════════════════
 *
 *   registerProvider('SMS' | 'WHATSAPP', {
 *     name: 'twilio',                                 // shown on the settings screen
 *     configured(): boolean,                          // false = nothing is sent (credentials missing …)
 *     async send({ to, text, companyId, userId }):    // `to`: an E.164 phone number (+9198…)
 *       { status: 'SENT' | 'FAILED', detail?: string } //   never throw for a refusal — return FAILED with why
 *   });
 *
 *   - Read credentials from the environment inside the provider (e.g. TWILIO_ACCOUNT_SID, GUPSHUP_API_KEY),
 *     never from the database, never printed. Register the provider once at start (app.js), in the real server.
 *   - A WhatsApp provider must send an APPROVED TEMPLATE for a business-initiated message (Meta's rule):
 *     map `text` into the template's variables there. Keep `text` under 600 characters (the digest is cut).
 *   - The phone number comes from the recipient's employee record (hrms_employees.phone, the login's own
 *     person); a login with no person or no phone is NO_ADDRESS. Numbers are normalised to +91 when they are
 *     ten digits. Opt-in for WhatsApp is the company's job; the setting is off by default.
 *   - Rate limits and retries belong in the provider; the alert job calls `send` once per digest.
 *
 * A channel: { key, label, configured(), deliver(db, { companyId, runId, recipient, digest }) → { status, detail?,
 * notificationId?, emailId? } }. status: SENT | QUEUED | NOT_CONFIGURED | NO_ADDRESS | FAILED (hrms_alert_deliveries).
 *   recipient: { userId, name, email, phone }
 *   digest:    { dedupeKey, kind, title, text (plain, short), html (email), link (an app path), data }
 */
import { mailConfigured } from '../compliance/mailer.js';

export const CHANNEL_KEYS = ['IN_APP', 'EMAIL', 'SMS', 'WHATSAPP'];
/** The settings' keys (camelCase, as the screen and channels_json say them) → the channel keys. */
export const SETTING_KEY = { inApp: 'IN_APP', email: 'EMAIL', sms: 'SMS', whatsapp: 'WHATSAPP' };

const EMAIL_RE = /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[A-Za-z]{2,}$/;

/** +91 for a ten-digit Indian number; anything that is not a phone number → null. */
export function normalisePhone(raw) {
  const s = String(raw ?? '').replace(/[\s\-()]/g, '');
  if (/^\+\d{10,15}$/.test(s)) return s;
  if (/^0?\d{10}$/.test(s)) return `+91${s.slice(-10)}`;
  if (/^91\d{10}$/.test(s)) return `+${s}`;
  return null;
}

const providers = { SMS: null, WHATSAPP: null };
/** Plug a provider in (see the interface above). `null` takes it out again (a test). */
export function registerProvider(channel, provider) {
  if (!['SMS', 'WHATSAPP'].includes(channel)) throw new Error(`No provider slot for ${channel}.`);
  providers[channel] = provider;
}

const inApp = {
  key: 'IN_APP',
  label: 'In the app (the bell)',
  configured: () => true,
  async deliver(db, { companyId, recipient, digest }) {
    await db.query(
      // created_at is written here as a UTC Date, never left to DEFAULT CURRENT_TIMESTAMP: that one is the DB
      // session's zone (IST on a local MySQL), while the pool reads every date as UTC (db.js timezone 'Z'), so a
      // default-stamped row showed 5½ hours late locally. Same rule as read_at, queued_at, processed_at.
      `INSERT INTO hrms_notifications (company_id, user_id, kind, title, body, data_json, link, dedupe_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE id = id`,
      [companyId, recipient.userId, digest.kind, digest.title.slice(0, 300), digest.text, JSON.stringify(digest.data ?? null), digest.link ?? null, digest.dedupeKey, new Date()]);
    const [[row]] = await db.query('SELECT id FROM hrms_notifications WHERE company_id = ? AND user_id = ? AND dedupe_key = ?', [companyId, recipient.userId, digest.dedupeKey]);
    return { status: 'SENT', notificationId: row?.id ?? null };
  },
};

const email = {
  key: 'EMAIL',
  label: 'Email',
  configured: () => mailConfigured(),
  async deliver(db, { companyId, recipient, digest }) {
    const to = String(recipient.email ?? '').trim();
    if (!EMAIL_RE.test(to)) return { status: 'NO_ADDRESS', detail: 'the login has no email address' };
    // The compliance outbox (services/compliance/notify.js sendPending): rate-limited, re-checks the address
    // at sending, keeps everything QUEUED while SMTP is not set.
    const [ins] = await db.query(
      'INSERT INTO hrms_compliance_emails (company_id, notification_id, to_user_id, to_email, subject, body_html, reason, queued_at) VALUES (?, NULL, ?, ?, ?, ?, \'NEW\', ?)',
      [companyId, recipient.userId, to, digest.title.slice(0, 300), digest.html, new Date()]);
    return { status: 'QUEUED', emailId: ins.insertId, detail: mailConfigured() ? 'in the outbox' : 'in the outbox; email is not set up on this server (SMTP), so it waits' };
  },
};

const phoneChannel = (key, label) => ({
  key,
  label,
  configured: () => Boolean(providers[key]?.configured?.()),
  provider: () => providers[key]?.name ?? null,
  async deliver(db, { companyId, recipient, digest }) {
    const p = providers[key];
    if (!p || !p.configured?.()) return { status: 'NOT_CONFIGURED', detail: `no ${label} provider is set up: nothing was sent` };
    const to = normalisePhone(recipient.phone);
    if (!to) return { status: 'NO_ADDRESS', detail: 'no phone number on the person' };
    try {
      const r = await p.send({ to, text: String(digest.text).slice(0, 600), companyId, userId: recipient.userId });
      return { status: r?.status === 'SENT' ? 'SENT' : 'FAILED', detail: r?.detail ?? null };
    } catch (err) {
      return { status: 'FAILED', detail: String(err.message).slice(0, 300) };
    }
  },
});

export const CHANNELS = {
  IN_APP: inApp,
  EMAIL: email,
  SMS: phoneChannel('SMS', 'SMS'),
  WHATSAPP: phoneChannel('WHATSAPP', 'WhatsApp'),
};

/** For the settings screen: each channel, whether it can send on this server. */
export function channelStatus() {
  return CHANNEL_KEYS.map((k) => {
    const ch = CHANNELS[k];
    const ready = ch.configured();
    let note = null;
    if (k === 'EMAIL' && !ready) note = 'Email is not set up on this server: emails wait in the outbox.';
    if ((k === 'SMS' || k === 'WHATSAPP') && !ready) note = `No ${ch.label} provider yet: nothing is sent. It can be plugged in later (Gupshup, Twilio …).`;
    return { key: k, label: ch.label, ready, provider: ch.provider?.() ?? null, note };
  });
}

export default { CHANNELS, CHANNEL_KEYS, SETTING_KEY, registerProvider, channelStatus, normalisePhone };
