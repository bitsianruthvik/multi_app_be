import crypto from 'node:crypto';
import webpush from 'web-push';
import { q, parseJson } from './db.js';

/**
 * Web Push: alerts that reach a phone or computer while the app is closed
 * (Android and desktop browsers; on an iPhone, once the app is added to the
 * home screen). The service worker that shows them is public/crm-sw.js.
 *
 * The server's key pair (VAPID) is made on first use and kept in
 * cf_crm_settings (customer 0, 'vapid'), like the original app kept its
 * session secret in its database, so nothing has to be set on the host.
 * A subscription the push service says is gone (404 / 410) is deleted.
 */
let vapid = null;
export async function vapidKeys() {
  if (vapid) return vapid;
  const rows = await q("SELECT value FROM cf_crm_settings WHERE customer_id = 0 AND k = 'vapid'");
  let v = rows[0] && parseJson(rows[0].value, null);
  if (!v || !v.publicKey) {
    const fresh = webpush.generateVAPIDKeys();
    await q("INSERT IGNORE INTO cf_crm_settings (customer_id, k, value) VALUES (0, 'vapid', ?)", [JSON.stringify(fresh)]);
    // another server may have made one at the same moment: use whichever was kept
    v = parseJson((await q("SELECT value FROM cf_crm_settings WHERE customer_id = 0 AND k = 'vapid'"))[0].value, fresh);
  }
  vapid = v;
  return v;
}

export const subId = (endpoint) => crypto.createHash('sha1').update(String(endpoint)).digest('hex');

export async function saveSubscription(customerId, userId, sub) {
  const endpoint = String(sub && sub.endpoint || '');
  const keys = (sub && sub.keys) || {};
  if (!/^https:\/\//.test(endpoint) || endpoint.length > 2000 || !keys.p256dh || !keys.auth) return false;
  await q(
    `INSERT INTO cf_crm_push_subs (id, customer_id, user_id, endpoint, p256dh, auth) VALUES (?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE customer_id = VALUES(customer_id), user_id = VALUES(user_id), p256dh = VALUES(p256dh), auth = VALUES(auth)`,
    [subId(endpoint), customerId, userId, endpoint, String(keys.p256dh).slice(0, 200), String(keys.auth).slice(0, 100)]);
  return true;
}

export async function dropSubscription(customerId, userId, endpoint) {
  await q('DELETE FROM cf_crm_push_subs WHERE id = ? AND customer_id = ? AND user_id = ?', [subId(endpoint), customerId, userId]);
}

const brandCache = new Map();
async function customerLook(customerId) {
  const hit = brandCache.get(customerId);
  if (hit && Date.now() - hit.at < 300000) return hit.v;
  const r = (await q('SELECT slug, name, brand FROM cf_crm_customers WHERE id = ?', [customerId]))[0];
  const b = r ? parseJson(r.brand, {}) : {};
  const v = { title: b.appName || (r && r.name) || 'CRM', slug: r ? r.slug : '' };
  brandCache.set(customerId, { at: Date.now(), v });
  return v;
}

/**
 * Send one alert to every device of these logins. Never throws: an alert
 * that cannot be delivered must not undo the save that caused it.
 * `link` is the app's own link (lead:ID, chat:ID, followups …).
 */
export async function sendPush(customerId, userIds, { text, link = '', tag = '' }) {
  try {
    const ids = [...new Set((userIds || []).map(Number).filter(Boolean))];
    if (!ids.length) return 0;
    const subs = await q(
      `SELECT s.id, s.endpoint, s.p256dh, s.auth, co.slug AS company
         FROM cf_crm_push_subs s JOIN users u ON u.id = s.user_id JOIN companies co ON co.id = u.company_id
        WHERE s.customer_id = ? AND s.user_id IN (${ids.map(() => '?').join(',')})`, [customerId, ...ids]);
    if (!subs.length) return 0;
    const keys = await vapidKeys();
    const look = await customerLook(customerId);
    let sent = 0;
    await Promise.all(subs.map(async (s) => {
      const payload = JSON.stringify({
        title: look.title,
        body: String(text || '').slice(0, 240),
        url: `/${s.company}/cf_crm${link ? '?open=' + encodeURIComponent(link) : ''}`,
        tag: tag || link || undefined,
        icon: look.slug ? `/cf_crm/m/${look.slug}-192.png` : '/cf_crm/icon-192.png',
      });
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, {
          vapidDetails: { subject: 'mailto:alerts@cf-crm.invalid', publicKey: keys.publicKey, privateKey: keys.privateKey },
          TTL: 60 * 60 * 12,
        });
        sent += 1;
        q('UPDATE cf_crm_push_subs SET last_ok = UTC_TIMESTAMP() WHERE id = ?', [s.id]).catch(() => {});
      } catch (err) {
        if (err && (err.statusCode === 404 || err.statusCode === 410)) await q('DELETE FROM cf_crm_push_subs WHERE id = ?', [s.id]).catch(() => {});
        else console.warn('[cf_crm] push failed', err && (err.statusCode || err.message));
      }
    }));
    return sent;
  } catch (err) {
    console.warn('[cf_crm] push', err && err.message);
    return 0;
  }
}
