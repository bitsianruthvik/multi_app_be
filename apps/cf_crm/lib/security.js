import crypto from 'node:crypto';

/* ---------------------------------------------------------- passwords */
// Passwords set from this app (own change, an owner's reset, a new team
// member). The platform's own sign-in only asks for 8 characters; these
// accounts hold a whole customer network, so the bar here is higher.
const COMMON = new Set([
  'password', 'password1', 'password12', 'password123', 'passw0rd', 'qwerty', 'qwerty123', 'qwertyuiop', 'abc123', 'abcd1234',
  'letmein', 'welcome', 'welcome1', 'welcome123', 'admin', 'admin123', 'admin@123', 'administrator', 'iloveyou', 'monkey',
  'test@1234', 'test1234', 'india123', 'india@123', 'changeme', 'default', 'master', 'sunshine', 'princess', 'football',
  '1q2w3e4r', '1qaz2wsx', 'zaq12wsx', 'asdfghjkl', 'northeast', 'northeast123', 'northeast@123',
]);
export const PW_MIN = 10;

/** null when acceptable, otherwise the sentence to show. */
export function passwordProblem(pw, { email = '', name = '' } = {}) {
  const p = String(pw || '');
  if (p.length < PW_MIN) return `Use at least ${PW_MIN} characters.`;
  if (p.length > 200) return 'That password is too long.';
  if (/^\d+$/.test(p)) return 'Use letters as well as numbers.';
  if (new Set(p.toLowerCase()).size < 4) return 'Use more different characters.';
  const low = p.toLowerCase();
  if (COMMON.has(low) || COMMON.has(low.replace(/[^a-z0-9@]/g, ''))) return 'That password is too common. Choose another.';
  const local = String(email).toLowerCase().split('@')[0];
  if (local.length >= 4 && low.includes(local)) return 'Do not use your email address in your password.';
  const first = String(name).toLowerCase().split(/\s+/)[0] || '';
  if (first.length >= 4 && low.includes(first)) return 'Do not use your name in your password.';
  return null;
}

/* ------------------------------------------------- two-step sign-in */
// TOTP, RFC 6238: SHA-1, 6 digits, 30-second steps — what Google
// Authenticator, Microsoft Authenticator and the rest expect.
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function newSecret() {
  const bytes = crypto.randomBytes(20);
  let bits = '', out = '';
  for (const b of bytes) bits += b.toString(2).padStart(8, '0');
  for (let i = 0; i + 5 <= bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5), 2)];
  return out;
}

function fromB32(s) {
  const clean = String(s || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = '';
  for (const ch of clean) bits += B32.indexOf(ch).toString(2).padStart(5, '0');
  const out = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
}

export function codeAt(secret, step) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', fromB32(secret)).update(msg).digest();
  const o = h[h.length - 1] & 0xf;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1e6).padStart(6, '0');
}

/**
 * The step a code matches (now, or one step either side for clock drift),
 * or null. A step at or before `lastStep` is refused so a code works once.
 */
export function verifyCode(secret, code, lastStep = null, now = Date.now()) {
  const c = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c) || !secret) return null;
  const step = Math.floor(now / 30000);
  for (const s of [step, step - 1, step + 1]) {
    if (lastStep != null && s <= Number(lastStep)) continue;
    const a = Buffer.from(codeAt(secret, s)), b = Buffer.from(c);
    if (crypto.timingSafeEqual(a, b)) return s;
  }
  return null;
}

export const otpauthUri = (secret, account, issuer) =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
