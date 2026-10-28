#!/usr/bin/env node
/**
 * web_leads end-to-end test against the LOCAL database. Runs the real route and delivery code in this
 * process, with a fake Meta + CRM receiver on a local port (nothing leaves the machine), and deletes
 * every lead it made. Usage (from multi_app_be):  node apps/web_leads/scripts/api_test.mjs
 *
 * Applies models/init.sql first (CREATE TABLE IF NOT EXISTS — safe to repeat).
 */
import 'dotenv/config';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import express from 'express';

process.env.WEB_LEADS_SWEEP = 'off';
process.env.WEB_LEADS_KEY = 'test-key-123456';
delete process.env.SMTP_URL; // the email target must be skipped, never sent from a test

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ok  ', msg); } else { fail++; console.log('  FAIL', msg); } };

// ---- fake receiver ----
const got = { meta: [], crm: [] };
let crmStatus = 500;
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.url.includes('/events')) { got.meta.push({ url: req.url, body: JSON.parse(body) }); res.end('{}'); return; }
    got.crm.push({ headers: req.headers, body }); res.statusCode = crmStatus; res.end('x');
  });
});
await new Promise((r) => fake.listen(0, r));
const fakeUrl = `http://127.0.0.1:${fake.address().port}`;
Object.assign(process.env, {
  META_PIXEL_ID: '111', META_CAPI_TOKEN: 'tok', META_GRAPH_BASE: fakeUrl,
  WEB_LEADS_CRM_WEBHOOK_URL: `${fakeUrl}/crm`, WEB_LEADS_CRM_SECRET: 'shh',
});

const { pool } = await import('../../../db.js');
const { default: appMod } = await import('../app.js');
const { sweep } = await import('../lib/deliver.js');

const sql = fs.readFileSync(new URL('../models/init.sql', import.meta.url), 'utf8');
for (const stmt of sql.split(/;\s*\n/).map((s) => s.replace(/^\s*--.*$/gm, '').trim()).filter(Boolean)) {
  const [rows] = await pool.query(stmt);
  if (Array.isArray(rows) && rows[0]?.result) ok(rows[0].result === 'SCHEMA-OK', 'schema applied');
}

const app = express();
app.use(express.json());
appMod.register(app);
const srv = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
const base = `http://127.0.0.1:${srv.address().port}/api/public/website/leads`;
const post = (body, key = 'test-key-123456') => fetch(base, {
  method: 'POST', headers: { 'content-type': 'application/json', ...(key ? { 'x-website-key': key } : {}) }, body: JSON.stringify(body),
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const made = [];
const eid = () => `t${crypto.randomUUID().replace(/-/g, '')}`.slice(0, 40);

try {
  console.log('key and validation');
  ok((await post({}, null)).status === 401, 'no key → 401');
  ok((await post({}, 'wrong-key-123456')).status === 401, 'wrong key → 401');
  ok((await post({ eventId: eid(), name: 'A', email: 'nope' })).status === 400, 'bad email → 400');
  ok((await post({ eventId: 'x', name: 'A', email: 'a@b.co' })).status === 400, 'bad eventId → 400');

  console.log('lead with marketing consent');
  const e1 = eid();
  const lead1 = {
    eventId: e1, name: 'Test Person', email: 'Test@Example.com', phone: '98765 43210', message: 'Hello',
    pageUrl: 'https://ceofactory.vc/contact', utm: { source: 'google', bogus: 'x' }, consent: { marketing: true },
    attribution: { pageId: 'erp.problems.raw-material-shortages', landingPageId: 'erp', cluster: 'erp_material_shortage_mid_order', product: 'erp', junk: 'x' },
    context: { ip: '203.0.113.9', userAgent: 'UA', fbp: 'fb.1.1.1' },
  };
  const r1 = await post(lead1);
  const j1 = await r1.json();
  made.push(j1.id);
  ok(r1.status === 201 && j1.id, 'saved → 201 with id');
  const r1b = await post(lead1);
  const j1b = await r1b.json();
  ok(r1b.status === 200 && j1b.duplicate && j1b.id === j1.id, 'same eventId → same lead, not a second');
  await wait(800);
  const [d1] = await pool.query(`SELECT target, status, attempts FROM web_lead_deliveries WHERE lead_id = ?`, [j1.id]);
  const st = Object.fromEntries(d1.map((d) => [d.target, d]));
  ok(st.email?.status === 'skipped', 'email skipped (not configured in test)');
  ok(st.meta_capi?.status === 'sent', 'Meta sent');
  ok(got.meta.length === 1, 'Meta received exactly one event');
  const ev = got.meta[0]?.body.data[0];
  ok(ev?.event_id === e1 && ev.event_name === 'Lead', 'Meta event carries the website event id');
  ok(ev?.user_data.em[0] === crypto.createHash('sha256').update('test@example.com').digest('hex'), 'email hashed, lower-cased');
  ok(ev?.user_data.ph[0] === crypto.createHash('sha256').update('919876543210').digest('hex'), '10-digit phone hashed with 91');
  ok(!JSON.stringify(got.meta[0].body).includes('Test Person'), 'no plain name sent to Meta');
  const [[at1]] = await pool.query(`SELECT attribution FROM web_leads WHERE id = ?`, [j1.id]);
  const atj = typeof at1.attribution === 'string' ? JSON.parse(at1.attribution) : at1.attribution;
  ok(atj?.landingPageId === 'erp' && atj.cluster === 'erp_material_shortage_mid_order' && !('junk' in atj), 'attribution kept, unknown keys dropped');
  ok(st.crm_webhook?.status === 'pending' && st.crm_webhook.attempts === 1, 'CRM down → pending for retry');
  const [[row1]] = await pool.query(`SELECT capi_context, utm FROM web_leads WHERE id = ?`, [j1.id]);
  ok(row1.capi_context === null, 'IP / browser dropped after Meta delivery');
  ok(JSON.stringify(row1.utm).includes('google') && !JSON.stringify(row1.utm).includes('bogus'), 'only known utm keys kept');

  console.log('retry');
  crmStatus = 200;
  await pool.query(`UPDATE web_lead_deliveries SET next_attempt_at = ? WHERE lead_id = ? AND target = 'crm_webhook'`, [new Date(0), j1.id]);
  await sweep();
  const [[c1]] = await pool.query(`SELECT status, attempts FROM web_lead_deliveries WHERE lead_id = ? AND target = 'crm_webhook'`, [j1.id]);
  ok(c1.status === 'sent' && c1.attempts === 2, 'sweep retried CRM → sent on attempt 2');
  const last = got.crm.at(-1);
  ok(last.headers['x-signature'] === crypto.createHmac('sha256', 'shh').update(last.body).digest('hex'), 'CRM body signed');
  ok(!last.body.includes('203.0.113.9'), 'CRM does not get the IP');
  ok(JSON.parse(last.body).attribution?.pageId === 'erp.problems.raw-material-shortages', 'CRM gets the attribution');

  console.log('lead without consent');
  const r2 = await post({ eventId: eid(), name: 'No Consent', email: 'nc@example.com', context: { ip: '1.2.3.4' } });
  const j2 = await r2.json();
  made.push(j2.id);
  await wait(800);
  const [[m2]] = await pool.query(`SELECT status, last_error FROM web_lead_deliveries WHERE lead_id = ? AND target = 'meta_capi'`, [j2.id]);
  ok(m2.status === 'skipped' && /consent/.test(m2.last_error), 'Meta skipped without consent');
  ok(got.meta.length === 1, 'nothing more sent to Meta');
  const [[row2]] = await pool.query(`SELECT capi_context FROM web_leads WHERE id = ?`, [j2.id]);
  ok(row2.capi_context === null, 'IP never stored without consent');

  console.log('permanent failure');
  crmStatus = 400;
  const r3 = await post({ eventId: eid(), name: 'Bad', email: 'bad@example.com' });
  const j3 = await r3.json();
  made.push(j3.id);
  await wait(800);
  const [[c3]] = await pool.query(`SELECT status FROM web_lead_deliveries WHERE lead_id = ? AND target = 'crm_webhook'`, [j3.id]);
  ok(c3.status === 'failed', 'CRM 400 → failed, not retried');
} finally {
  const ids = made.filter(Boolean);
  if (ids.length) {
    await pool.query(`DELETE FROM web_lead_deliveries WHERE lead_id IN (?)`, [ids]);
    await pool.query(`DELETE FROM web_leads WHERE id IN (?)`, [ids]);
  }
  srv.close(); fake.close(); await pool.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
