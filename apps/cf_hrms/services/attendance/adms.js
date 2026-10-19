/**
 * adms.js — the ZKTeco / eSSL "ADMS" (PUSH SDK, "iclock") protocol, as text. Pure.
 * (TM/CF_HRMS_HIRING_SPEC.md §28.1, way in 1.)
 *
 * The device is the client; it calls the server on plain HTTP at a fixed path:
 *
 *   GET  /iclock/cdata?SN=<serial>&options=all&pushver=…&language=…
 *        the handshake. The answer is the device's options, as text:
 *          GET OPTION FROM: <serial>
 *          ATTLOGStamp=<cursor>   OPERLOGStamp=<cursor>   ATTPHOTOStamp=None
 *          ErrorDelay=60  Delay=30  TransTimes=00:00;14:05  TransInterval=1
 *          TransFlag=TransData AttLog OpLog EnrollUser ChgUser
 *          Realtime=1  Encrypt=None  TimeZone=…  ServerVer=…
 *        (some firmware reads Stamp / OpStamp instead of ATTLOGStamp / OPERLOGStamp: both are sent)
 *   POST /iclock/cdata?SN=<serial>&table=ATTLOG&Stamp=<n>
 *        attendance, one record a line, TAB separated:
 *          PIN \t YYYY-MM-DD HH:MM:SS \t status \t verify \t workcode \t reserved \t reserved
 *        status 0 check-in · 1 check-out · 2 break-out · 3 break-in · 4 overtime-in · 5 overtime-out
 *        verify 0 password · 1 fingerprint · 2 card (some firmware: 4) · 15 face · 25 palm
 *        The answer is "OK: <lines accepted>".
 *   POST /iclock/cdata?SN=<serial>&table=OPERLOG   OPLOG / USER / FP lines: stored, not acted on ("OK: n")
 *   GET  /iclock/getrequest?SN=<serial>            the device asks for commands: "OK" (none — nothing is ever sent)
 *   POST /iclock/devicecmd?SN=<serial>             a command's result: "OK"
 *
 * The codes above are the ones the PUSH SDK documents and ADMS integrations use; check a new
 * device model against them (the simulator, scripts/cf_hrms/sim-iclock.mjs, speaks the same).
 * The time on a line is the DEVICE's wall clock — stored as it is, with the device's timezone.
 */
import { normWall } from './time.js';

export const STATUS_DIRECTION = { 0: 'IN', 1: 'OUT', 2: 'OUT', 3: 'IN', 4: 'IN', 5: 'OUT' };
export const VERIFY_METHOD = { 0: 'PASSWORD', 1: 'FINGER', 2: 'CARD', 3: 'PASSWORD', 4: 'CARD', 15: 'FACE', 25: 'PALM' };

/** A serial number as devices send it: letters, digits and - _ only, 3–64 long. */
export const validSerial = (sn) => /^[A-Za-z0-9_-]{3,64}$/.test(String(sn ?? ''));

/**
 * ATTLOG lines -> punches. Lines that cannot be read come back in `bad` with why.
 * @returns { punches: [{ deviceUserId, at, direction, method, raw }], bad: [{ line, why }] }
 */
export function parseAttlog(text) {
  const punches = [];
  const bad = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) continue;
    // Tabs are the protocol; some firmware pads with spaces — the time itself holds one space.
    let parts = line.split('\t');
    if (parts.length < 2) {
      const m = /^(\S+)\s+(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?)\s*(\d+)?\s*(\d+)?/.exec(line.trim());
      parts = m ? [m[1], m[2], m[3] ?? '', m[4] ?? ''] : parts;
    }
    const pin = String(parts[0] ?? '').trim();
    const at = normWall(String(parts[1] ?? '').trim().replace(/\s+/, ' '));
    if (!pin || pin.length > 40 || !/^[A-Za-z0-9_.-]+$/.test(pin)) { bad.push({ line: line.slice(0, 200), why: 'no user number' }); continue; }
    if (!at) { bad.push({ line: line.slice(0, 200), why: 'no readable time' }); continue; }
    const status = parts[2] === undefined || parts[2] === '' ? null : Number(parts[2]);
    const verify = parts[3] === undefined || parts[3] === '' ? null : Number(parts[3]);
    punches.push({
      deviceUserId: pin, at,
      direction: status === null ? 'UNKNOWN' : (STATUS_DIRECTION[status] ?? 'UNKNOWN'),
      method: verify === null ? 'OTHER' : (VERIFY_METHOD[verify] ?? 'OTHER'),
      raw: line.slice(0, 500),
    });
  }
  return { punches, bad };
}

/** OPERLOG / USER / FP lines, counted by kind (stored, never acted on). */
export function parseOperlog(text) {
  const lines = String(text ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const kinds = {};
  for (const l of lines) { const k = (/^([A-Z]+)/.exec(l)?.[1]) ?? 'OTHER'; kinds[k] = (kinds[k] ?? 0) + 1; }
  return { lines, kinds };
}

/** The handshake's answer. */
export function handshakeText(serial, { attlogStamp = null, operlogStamp = null, delay = 30, realtime = true } = {}) {
  const a = attlogStamp || 'None';
  const o = operlogStamp || 'None';
  return [
    `GET OPTION FROM: ${serial}`,
    `ATTLOGStamp=${a}`,
    `OPERLOGStamp=${o}`,
    'ATTPHOTOStamp=None',
    `Stamp=${a}`,
    `OpStamp=${o}`,
    'PhotoStamp=None',
    'ErrorDelay=60',
    `Delay=${delay}`,
    'TransTimes=00:00;14:05',
    'TransInterval=1',
    'TransFlag=TransData AttLog OpLog EnrollUser ChgUser',
    `Realtime=${realtime ? 1 : 0}`,
    'Encrypt=None',
    'ServerVer=CF_HRMS 1.0',
    '',
  ].join('\n');
}

export default { parseAttlog, parseOperlog, handshakeText, validSerial, STATUS_DIRECTION, VERIFY_METHOD };
