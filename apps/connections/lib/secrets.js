import crypto from 'crypto';

/**
 * Connection secrets at rest: AES-256-GCM under CONNECTIONS_KEY, 32 bytes as
 * 64 hex characters. Changing the key makes every stored secret unreadable, so
 * each connection's secret would have to be typed again.
 *
 *   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 */
function key() {
  const hex = process.env.CONNECTIONS_KEY || '';
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    const err = new Error('CONNECTIONS_KEY is not set on the server (64 hex characters).');
    err.status = 503;
    throw err;
  }
  return Buffer.from(hex, 'hex');
}

export function seal(values) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(values), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), body.toString('base64')].join(':');
}

export function unseal(text) {
  if (!text) return {};
  const [version, iv, tag, body] = String(text).split(':');
  if (version !== 'v1') throw new Error('Unknown secret format.');
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(body, 'base64')), decipher.final()]).toString('utf8'));
  } catch (err) {
    if (err.status) throw err;
    const e = new Error('The stored secret cannot be read. Type it again on this connection.');
    e.status = 409;
    throw e;
  }
}
