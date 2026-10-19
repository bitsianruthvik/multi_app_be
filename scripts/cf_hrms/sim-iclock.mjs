/**
 * sim-iclock.mjs — a pretend ZKTeco / eSSL device that speaks ADMS ("iclock") to a running
 * server, so the protocol can be checked without hardware. (TM/CF_HRMS_HIRING_SPEC.md §28.1.)
 *
 *   node scripts/cf_hrms/sim-iclock.mjs --sn=DEMO-ATT-01 [--url=http://localhost:4000]
 *        [--users=101,102] [--unmapped=9999] [--date=2026-10-19] [--quiet]
 *
 * What it does, like a device after power-on:
 *   1. GET  /iclock/cdata?SN=…&options=all&pushver=2.4.1   the handshake — prints the options
 *   2. POST /iclock/cdata?SN=…&table=ATTLOG&Stamp=…         one IN (09:0x) and one OUT (18:0x) per user,
 *                                                           plus one punch for each --unmapped number
 *   3. POST /iclock/cdata?SN=…&table=OPERLOG                a USER line (stored, never acted on)
 *   4. GET  /iclock/getrequest?SN=…                         "OK" = no commands
 *   5. POST /iclock/devicecmd?SN=…                          "OK"
 * The device must be registered (Attendance › Devices) with that serial; an unknown serial
 * gets 403. Sends nothing anywhere but --url. The test suite imports `talk` and `attlogLines`.
 */
import { fileURLToPath } from 'url';
import path from 'path';

const arg = (name, dflt = null) => { const a = process.argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : dflt; };

/** ATTLOG lines: PIN \t time \t status \t verify \t workcode \t 0 \t 0 */
export function attlogLines(punches) {
  return punches.map((p) => [p.pin, p.at, p.status ?? 0, p.verify ?? 1, 0, 0, 0].join('\t')).join('\n');
}

/** One request to the device path; returns { status, text }. */
export async function talk(base, method, pathAndQuery, body = undefined) {
  const res = await fetch(`${base}${pathAndQuery}`, {
    method, body, headers: body === undefined ? {} : { 'Content-Type': 'text/plain' },
  });
  return { status: res.status, text: await res.text() };
}

/** The whole power-on conversation. */
export async function simulate({ url, sn, users = [], unmapped = [], date, quiet = false }) {
  const say = (...x) => { if (!quiet) console.log(...x); };
  const q = (extra = '') => `?SN=${encodeURIComponent(sn)}${extra}`;
  const out = {};
  out.handshake = await talk(url, 'GET', `/iclock/cdata${q('&options=all&pushver=2.4.1&language=69')}`);
  say(`\n1. handshake -> ${out.handshake.status}\n${out.handshake.text.split('\n').map((l) => `     ${l}`).join('\n')}`);
  if (out.handshake.status !== 200) return out;
  const pad = (n) => String(n).padStart(2, '0');
  const punches = [];
  users.forEach((pin, i) => {
    punches.push({ pin, at: `${date} 09:${pad(i % 50)}:0${i % 10}`, status: 0, verify: i % 2 ? 15 : 1 });
    punches.push({ pin, at: `${date} 18:${pad((i * 3) % 50)}:1${i % 10}`, status: 1, verify: i % 2 ? 15 : 1 });
  });
  unmapped.forEach((pin, i) => punches.push({ pin, at: `${date} 09:3${i % 10}:00`, status: 0, verify: 2 }));
  const lines = attlogLines(punches);
  out.attlog = await talk(url, 'POST', `/iclock/cdata${q(`&table=ATTLOG&Stamp=${Date.now() % 100000}`)}`, lines);
  say(`2. ATTLOG (${punches.length} lines) -> ${out.attlog.status} ${out.attlog.text}`);
  out.operlog = await talk(url, 'POST', `/iclock/cdata${q('&table=OPERLOG&OpStamp=1')}`, `USER PIN=${users[0] ?? 1}\tName=Test\tPri=0\tPasswd=\tCard=\tGrp=1\tTZ=0`);
  say(`3. OPERLOG -> ${out.operlog.status} ${out.operlog.text}`);
  out.poll = await talk(url, 'GET', `/iclock/getrequest${q()}`);
  say(`4. getrequest -> ${out.poll.status} ${out.poll.text}`);
  out.cmd = await talk(url, 'POST', `/iclock/devicecmd${q()}`, 'ID=1&Return=0&CMD=DATA');
  say(`5. devicecmd -> ${out.cmd.status} ${out.cmd.text}\n`);
  return out;
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const sn = arg('sn');
  if (!sn) { console.error('Give the serial: --sn=DEMO-ATT-01'); process.exit(2); }
  const url = arg('url', 'http://localhost:4000').replace(/\/$/, '');
  const date = arg('date', new Date().toISOString().slice(0, 10));
  const users = (arg('users', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const unmapped = (arg('unmapped', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
  simulate({ url, sn, users, unmapped, date, quiet: process.argv.includes('--quiet') })
    .then((o) => process.exit(o.handshake.status === 200 && o.attlog?.status === 200 ? 0 : 1))
    .catch((e) => { console.error(`FAILED: ${e.message}`); process.exit(1); });
}
