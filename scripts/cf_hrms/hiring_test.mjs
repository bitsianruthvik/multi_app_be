/**
 * hiring_test.mjs — employee codes and hiring on a vacant position (2026-10-10).
 * Contract: TM/CF_HRMS_HIRING_SPEC.md.
 *
 *   1. the letter renderer, on documents built here: a placeholder split across
 *      runs, a multi-line address, an unknown placeholder, a value with none;
 *   2. Karni's two templates: proven again from the source letters (nothing
 *      personal left, the Annexure picture gone, the letterhead intact), and
 *      the rows stored in the database are those files;
 *   3. codes: the default rule for a company with none, Karni's first new code,
 *      skipping codes in use, a code a client sends being ignored, a rolled-back
 *      create giving its number back, a rule with a condition;
 *   4. the whole flow on a vacant Karni position: JD, offer letter, again,
 *      accept, appoint — and every refusal on the way;
 *   5. a hiring that is closed uses no employee code and keeps its reference;
 *   6. a joining date in the future; a failure late in the appointment;
 *   7. another company cannot read a hiring or its files;
 *   8. through the real middleware: an Employee login gets 403 from every
 *      hiring route, and each app's Code formats shows only its own rules.
 *
 *   node scripts/cf_hrms/hiring_test.mjs [--company=karni] [--verbose]
 *
 * NOTHING IS LEFT BEHIND. Sections 3 to 7 each run in a transaction on one
 * connection that is ROLLED BACK; section 8 only reads (its two writes are
 * requests that must be refused, and the last checks prove they were). The end
 * of the run re-reads the tenant: positions / filled / vacant, employees, no
 * hirings, the counter where it was, every hrms_ and cf_code_ row count.
 *
 * No real person is in this file: the candidate is a made-up name with a
 * per-run tag. Section 2 reads the personal values it checks for out of the
 * source letters at run time and never prints one.
 *
 * Local only — it refuses a non-local DB_HOST.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import express from 'express';
import cookieParser from 'cookie-parser';
import JSZip from 'jszip';
import saxes from 'saxes';
import { pool } from '../../db.js';
import { signToken } from '../../core/utils/jwt.js';
import { appContext } from '../../core/middleware/appContext.js';
import hrmsApp from '../../apps/cf_hrms/app.js';
import erpApp from '../../apps/cf_erp/app.js';
import { createCodegenRouter } from '../../apps/cf_erp/modules/codegen/routes.js';
import { createScheme } from '../../apps/cf_erp/modules/codegen/service.js';
import * as POS from '../../apps/cf_hrms/services/positionService.js';
import * as PEOPLE from '../../apps/cf_hrms/services/peopleService.js';
import * as ASG from '../../apps/cf_hrms/services/assignmentService.js';
import * as HIRE from '../../apps/cf_hrms/services/hiringService.js';
import * as CODES from '../../apps/cf_hrms/services/codeService.js';
import * as LETTER from '../../apps/cf_hrms/services/letterRenderer.js';
import { scanParagraphs, replaceRanges, plainText } from '../../apps/cf_hrms/services/docxText.js';
import { unpack } from '../../apps/cf_hrms/services/documentStorage.js';
import { dateParts } from '../../apps/cf_hrms/services/codegenProvider.js';
import { buildOrgChart, getPositionCard } from '../../apps/cf_hrms/services/orgChartService.js';
import { previewDocument } from '../../apps/cf_hrms/services/documentService.js';
import { CLOSE_REASON_GROUPS } from '../../apps/cf_hrms/services/hiringRead.js';
import { departmentStaffing } from '../../apps/cf_hrms/services/jobContentService.js';
import {
  buildAndVerify, verifyTemplate, LETTERS, EXPECTED, TEMPLATES_DIR, KARNI_SETTINGS,
} from '../../apps/cf_hrms/scripts/make-letter-templates.mjs';

const slug = (process.argv.find((a) => a.startsWith('--company=')) || '--company=karni').split('=')[1];
const VERBOSE = process.argv.includes('--verbose');
if (!['localhost', '127.0.0.1', '::1'].includes(String(process.env.DB_HOST ?? 'localhost'))) {
  console.error(`Refusing to run against DB_HOST=${process.env.DB_HOST}. This test is local only.`);
  process.exit(2);
}

let passed = 0;
const failed = [];
const skipped = [];
const ok = (cond, name, detail = '') => {
  if (cond) { passed += 1; if (VERBOSE) console.log(`  ok    ${name}`); } else { failed.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
  return Boolean(cond);
};
const skip = (name, why) => { skipped.push(`${name}: ${why}`); };
const section = (title) => console.log(`\n${title}`);
/** Runs fn and returns what it threw (or null). */
const caught = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
const refused = (e, status, code) => Boolean(e) && e.status === status && e.code === code;
const why = (e) => (e ? `${e.status ?? '?'} ${e.code ?? ''} ${e.message ?? ''}` : 'nothing was thrown');

const [[company]] = await pool.query('SELECT id, name FROM companies WHERE slug = ? AND deleted_at IS NULL', [slug]);
if (!company) { console.error(`No company "${slug}".`); process.exit(2); }
const COMPANY = company.id;
const IS_KARNI = slug === 'karni';
const TAG = `ZZHR${Date.now().toString(36).toUpperCase().slice(-5)}`;
const on = POS.today();
const [[adminUser]] = await pool.query(
  `SELECT u.id, u.email FROM users u JOIN roles r ON r.id = u.role_id
    WHERE u.company_id = ? AND u.deleted_at IS NULL AND LOWER(r.name) = 'admin' ORDER BY u.id LIMIT 1`, [COMPANY]);
const c = { companyId: COMPANY, userId: adminUser?.id ?? null };
const [[other]] = await pool.query('SELECT id, name, slug FROM companies WHERE id <> ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [COMPANY]);
const OTHER = other.id;

const addDays = (iso, n) => { const d = new Date(`${iso}T00:00:00`); d.setDate(d.getDate() + n); return POS.dateText(d); };
const FY = dateParts(on).fy;

/* ── what "as it was found" means ─────────────────────────────────────────── */
const tablesLike = async (pattern) => (await pool.query(
  'SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME LIKE ? ORDER BY TABLE_NAME', [pattern]))[0].map((r) => r.t);
const WATCHED = [...await tablesLike('hrms\\_%'), ...await tablesLike('cf\\_code\\_%')];
const rowCounts = async () => {
  const out = {};
  for (const t of WATCHED) {
    const [[r]] = await pool.query(`SELECT COUNT(*) AS total, SUM(deleted_at IS NULL) AS live FROM ${t} WHERE company_id IN (?, ?)`, [COMPANY, OTHER]);
    out[t] = `${r.total}/${r.live ?? 0}`;
  }
  return out;
};
const counterOf = async (db, entityType) => (await db.query(
  `SELECT q.next_value FROM cf_code_sequences q JOIN cf_code_schemes s ON s.id = q.scheme_id
    WHERE s.company_id = ? AND s.entity_type = ? AND s.deleted_at IS NULL ORDER BY q.updated_at DESC LIMIT 1`, [COMPANY, entityType]))[0][0]?.next_value ?? null;
const baseline = await rowCounts();
const baselineCounter = await counterOf(pool, 'hrms_employee');
const baselineRefCounter = await counterOf(pool, 'hrms_hiring');
const baselineChart = (await buildOrgChart(pool, COMPANY, {})).counts;
const baselineHirings = Number((await pool.query('SELECT COUNT(*) AS n FROM hrms_hirings WHERE company_id = ?', [COMPANY]))[0][0].n);

console.log(`hiring_test — ${company.name} (${COMPANY}), run tag ${TAG}, as of ${on}; the other company is ${other.name} (${OTHER})`);

/** One transaction on one connection, always rolled back. */
async function rolledBack(fn) {
  const db = await pool.getConnection();
  try {
    await db.beginTransaction();
    await fn(db);
  } finally {
    try { await db.rollback(); } catch { /* nothing to undo */ }
    db.release();
  }
}

/** A minimal .docx around the given body XML (and, optionally, a header). */
async function docx(body, header = null) {
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8"?><w:document ${W}><w:body>${body}</w:body></w:document>`);
  if (header) zip.file('word/header1.xml', `<?xml version="1.0" encoding="UTF-8"?><w:hdr ${W}>${header}</w:hdr>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}
const partOf = async (buffer, name = 'word/document.xml') => (await JSZip.loadAsync(buffer)).file(name).async('string');
const wellFormed = (xml) => {
  const parser = new saxes.SaxesParser();
  let error = null;
  parser.on('error', (e) => { error ??= e; });
  try { parser.write(xml).close(); } catch (e) { error ??= e; }
  return !error;
};
const run = (t, bold = false) => `<w:r>${bold ? '<w:rPr><w:b/></w:rPr>' : ''}<w:t xml:space="preserve">${t}</w:t></w:r>`;
const p = (...runs) => `<w:p>${runs.join('')}</w:p>`;

/* ══ 1. the letter renderer ═══════════════════════════════════════════════ */
section('[1] Letter renderer: split runs, multi-line address, unknown placeholders, formats');
{
  ok(LETTER.indianNumber(900000) === '9,00,000' && LETTER.indianNumber(12345678) === '1,23,45,678' && LETTER.indianNumber(999) === '999'
    && LETTER.indianNumber(1000) === '1,000' && LETTER.indianNumber('250000.50') === '2,50,000.50' && LETTER.indianNumber(null) === '',
  'Indian grouping: 9,00,000 · 1,23,45,678 · 999 · 1,000 · decimals kept only when there are any');
  ok(LETTER.letterDate('2026-08-20') === '20th August 2026' && LETTER.letterDate('2026-08-01') === '1st August 2026'
    && LETTER.letterDate('2026-08-02') === '2nd August 2026' && LETTER.letterDate('2026-08-03') === '3rd August 2026'
    && LETTER.letterDate('2026-08-11') === '11th August 2026' && LETTER.letterDate('2026-08-12') === '12th August 2026'
    && LETTER.letterDate('2026-08-13') === '13th August 2026' && LETTER.letterDate('2026-08-21') === '21st August 2026'
    && LETTER.letterDate('2026-08-22') === '22nd August 2026' && LETTER.letterDate('2026-08-23') === '23rd August 2026'
    && LETTER.letterDate('2026-08-31') === '31st August 2026' && LETTER.letterDate('') === '', 'dates print as 20th August 2026, with the right ordinal');
  ok(LETTER.numberWords(3) === 'three' && LETTER.numberWords(15) === 'fifteen' && LETTER.numberWords(30) === 'thirty'
    && LETTER.numberWords(45) === 'forty-five' && LETTER.numberWords(90) === 'ninety' && LETTER.numberWords(120) === 'one hundred and twenty',
  'numbers in words: three, fifteen, thirty, forty-five, one hundred and twenty');
  const v = LETTER.letterValues({ probationMonths: 3, noticeDaysProbation: 15, noticeDaysConfirmed: 30, annualCtc: 900000, letterDate: '2026-08-12' });
  ok(v.probation_months_words === 'three (3)' && v.notice_days_probation_words === 'Fifteen (15)' && v.notice_days_confirmed_words === 'Thirty (30)'
    && v.probation_months === '3' && v.annual_ctc === '9,00,000' && v.letter_date === '12th August 2026',
  'probation prints "three (3)", the notice periods "Fifteen (15)" and "Thirty (30)"', JSON.stringify(v));
  ok(new Set(LETTER.PLACEHOLDERS.map((x) => x.key)).size === 25 && LETTER.PLACEHOLDERS.every((x) => x.label && x.example && !x.key.includes('{')),
    'the placeholder list has the 25 of the spec, each with a label and an example');

  // A placeholder Word split into three runs, with different formatting on each.
  const split = await docx(p(run('Dear '), run('{candi', true), run('date_na'), run('me}', true), run(', welcome.')));
  const a = await LETTER.renderLetter(split, { candidate_name: 'Asha Rao' });
  const aXml = await partOf(a.buffer);
  ok(plainText(aXml) === 'Dear Asha Rao, welcome.' && a.unfilled.length === 0, 'a placeholder split across three runs is found and filled', plainText(aXml));
  ok(wellFormed(aXml) && (aXml.match(/<w:r>/g) ?? []).length === 5 && (aXml.match(/<w:b\/>/g) ?? []).length === 2,
    'the runs and their formatting are still there, and the part is well-formed XML');

  // Two placeholders in one paragraph, one split, text between them kept.
  const two = await docx(p(run('{salutation} {candidate'), run('_name}'), run(' of {company_name}.')));
  const b = await LETTER.renderLetter(two, { salutation: 'Ms.', candidate_name: 'Asha Rao', company_name: 'Acme & Sons <Pvt>' });
  const bXml = await partOf(b.buffer);
  ok(plainText(bXml) === 'Ms. Asha Rao of Acme & Sons <Pvt>.' && wellFormed(bXml) && bXml.includes('Acme &amp; Sons &lt;Pvt&gt;'),
    'two placeholders in one paragraph; & and < in a value are escaped', plainText(bXml));

  // A multi-line address: one placeholder, as many lines as were typed.
  const addr = await docx(p(run('{candidate_address}')) + p(run('next paragraph')));
  const values = LETTER.letterValues({ candidateAddress: ' 12 Lake Road,\r\n\r\nNear the tank,\nHyderabad. ' });
  const d = await LETTER.renderLetter(addr, values);
  const dXml = await partOf(d.buffer);
  ok((dXml.match(/<w:br\/>/g) ?? []).length === 2 && scanParagraphs(dXml).length === 2 && wellFormed(dXml)
    && scanParagraphs(dXml)[0].nodes.map((n) => n.text).join('|') === '12 Lake Road,|Near the tank,|Hyderabad.',
  'a three-line address prints as three lines in its paragraph (blank lines dropped)', scanParagraphs(dXml)[0].nodes.map((n) => n.text).join('|'));

  // An unknown placeholder stays visible and is reported; a known one with no value prints nothing and is reported.
  const unknown = await docx(p(run('Ref {ref_no} for {candiate_name} on {candidate_phone}.')) + p(run('Dear {salutation} {candidate_name},')));
  const e = await LETTER.renderLetter(unknown, { ref_no: 'HR/1', candidate_name: 'Asha Rao' });
  const eText = plainText(await partOf(e.buffer));
  ok(eText === 'Ref HR/1 for {candiate_name} on .\nDear Asha Rao,', 'an unknown placeholder is left visible; one with no value prints nothing (and its space goes with it)', eText);
  ok(JSON.stringify(e.unfilled) === JSON.stringify(['salutation', 'candidate_phone', 'candiate_name']),
    'both are reported in `unfilled`, as keys without braces', JSON.stringify(e.unfilled));
  const insp = await LETTER.inspectTemplate(unknown);
  ok(JSON.stringify(insp.placeholders) === JSON.stringify(['ref_no', 'salutation', 'candidate_name', 'candidate_phone'])
    && JSON.stringify(insp.unknown) === JSON.stringify(['candiate_name']), 'inspecting a template names the placeholders it uses and the ones nobody knows', JSON.stringify(insp));

  // Headers and footers are filled too; a text box inside a paragraph is its own paragraph.
  const boxed = await docx(
    p(run('Outer {company'), `<w:r><w:pict><w:txbxContent>${p(run('Box {ref_no}'))}</w:txbxContent></w:pict></w:r>`, run('_name} end')),
    p(run('Head {company_name}')),
  );
  const f = await LETTER.renderLetter(boxed, { company_name: 'Acme', ref_no: 'R-9' });
  const fXml = await partOf(f.buffer);
  const fParas = scanParagraphs(fXml).map((x) => x.text);
  ok(fParas.includes('Outer Acme end') && fParas.includes('Box R-9') && plainText(await partOf(f.buffer, 'word/header1.xml')) === 'Head Acme' && wellFormed(fXml),
    'a text box keeps its own text; the header is filled', fParas.join(' / '));

  ok(refused(await caught(() => LETTER.renderLetter(Buffer.from('not a zip'), {})), 422, 'BAD_TEMPLATE')
    && refused(await caught(async () => LETTER.inspectTemplate(await new JSZip().file('a.txt', 'x').generateAsync({ type: 'nodebuffer' }))), 422, 'BAD_TEMPLATE'),
  'a file that is not a Word document is refused in words (422 BAD_TEMPLATE)');

  // replaceRanges on its own: two ranges in one paragraph, applied without disturbing each other.
  const raw = `<w:body>${p(run('abc'), run('def'), run('ghi'))}</w:body>`;
  const para = scanParagraphs(raw)[0];
  const outXml = replaceRanges(raw, [{ paragraph: para, start: 1, end: 5, text: 'X' }, { paragraph: para, start: 7, end: 8, text: 'YY' }]);
  ok(plainText(outXml) === 'aXfgYYi', 'two ranges in one paragraph are both replaced', plainText(outXml));

  // The built-in letters: every placeholder a known one, and filled by the same code.
  for (const kind of LETTER.LETTER_KINDS) {
    const t = await LETTER.builtInTemplate(kind);
    const i = await LETTER.inspectTemplate(t);
    const full = Object.fromEntries(LETTER.PLACEHOLDERS.map((x) => [x.key, `v-${x.key}`]));
    const out = await LETTER.renderLetter(t, full);
    const text = plainText(await partOf(out.buffer));
    ok(i.unknown.length === 0 && i.placeholders.length >= 15 && out.unfilled.length === 0 && !/\{[a-z_]+\}/.test(text)
      && (kind === 'OFFER' ? !i.placeholders.includes('employee_code') : i.placeholders.includes('employee_code')),
    `the built-in ${kind.toLowerCase()} letter uses only known placeholders and fills completely${kind === 'APPOINTMENT' ? ', employee code included' : ''}`);
  }
}

/* ══ 2. Karni's templates ═════════════════════════════════════════════════ */
section('[2] Karni’s templates: nothing personal left, the Annexure picture gone, the letterhead intact');
let personal = null;
let sources = null;
{
  const haveSources = Object.values(LETTERS).every((f) => fs.existsSync(path.join(path.dirname(TEMPLATES_DIR), f.source)));
  if (!haveSources) skip('templates from the source letters', 'TM/hr_letter_formats does not hold the two source letters');
  else {
    const built = await buildAndVerify();
    personal = built.personal;
    sources = built.sources;
    for (const kind of Object.keys(LETTERS)) {
      ok(built.problems[kind].length === 0, `${kind}: built from the source letter and proven`, built.problems[kind].join('; '));
      // A check that cannot fail proves nothing: the SOURCE, checked as if it were the template, must be refused.
      const control = await verifyTemplate(kind, sources[kind], personal, sources[kind]);
      ok(control.some((x) => /person’s name/.test(x)) && control.some((x) => /phone/.test(x)) && control.some((x) => /address/.test(x))
        && control.some((x) => /missing, or split/.test(x)) && control.some((x) => /a date of the source/.test(x)),
      `${kind}: the same check REFUSES the filled source letter (${control.length} problems)`);
      const file = path.join(TEMPLATES_DIR, LETTERS[kind].template);
      ok(fs.existsSync(file) && Buffer.compare(fs.readFileSync(file), built.made[kind].buffer) === 0,
        `${kind}: templates/${LETTERS[kind].template} on disk is exactly what the script builds`);
      const xml = await partOf(built.made[kind].buffer);
      const zip = await JSZip.loadAsync(built.made[kind].buffer);
      ok(wellFormed(xml) && EXPECTED[kind].every((k) => new RegExp(`<w:t[^>]*>[^<]*\\{${k}\\}`).test(xml)),
        `${kind}: opens, word/document.xml is well-formed, all ${EXPECTED[kind].length} placeholders are whole`);
      ok(!/<w:drawing|<w:pict|<pic:pic/.test(xml) && !/relationships\/image"/.test(await partOf(built.made[kind].buffer, 'word/_rels/document.xml.rels')),
        `${kind}: the body holds no picture and no image relationship`);
      const headerRels = await partOf(built.made[kind].buffer, 'word/_rels/header1.xml.rels');
      const letterhead = [...headerRels.matchAll(/Target="(media\/[^"]+)"/g)].map((m) => `word/${m[1]}`);
      const media = Object.keys(zip.files).filter((n) => n.startsWith('word/media/'));
      ok(letterhead.length > 0 && letterhead.every((n) => zip.file(n)) && media.every((n) => letterhead.includes(n)),
        `${kind}: the header's ${letterhead.length} letterhead images are in the package, and no other image is`, media.join(', '));
    }
    const picture = built.made.APPOINTMENT.removed;
    const hashes = [];
    for (const n of Object.keys((await JSZip.loadAsync(built.made.APPOINTMENT.buffer)).files)) {
      if (n.startsWith('word/media/')) hashes.push(crypto.createHash('sha256').update(await (await JSZip.loadAsync(built.made.APPOINTMENT.buffer)).file(n).async('nodebuffer')).digest('hex'));
    }
    ok(Boolean(picture) && picture.stillUsed === false && !hashes.includes(picture.sha256) && built.made.OFFER.removed === null,
      'the Annexure picture: its relationship and its file are gone from the appointment template (the offer letter never had one)');
    const annexure = plainText(await partOf(built.made.APPOINTMENT.buffer)).split('\n');
    const at = annexure.findIndex((l) => /^ANNEXURE/.test(l));
    ok(at > 0 && annexure.slice(at, at + 6).includes('Compensation structure attached separately.') && annexure.slice(at).some((l) => /^Note:/.test(l)),
      'the ANNEXURE – A heading, "Compensation structure attached separately." and the notes are there');
  }

  if (IS_KARNI) {
    const [rows] = await pool.query(
      'SELECT kind, file_name, size_bytes, storage, compression, content FROM hrms_letter_templates WHERE company_id = ? AND is_current = 1 AND deleted_at IS NULL ORDER BY kind', [COMPANY]);
    ok(rows.length === 2, 'Karni has one current template of each kind stored', `${rows.length}`);
    for (const row of rows) {
      const stored = await unpack(row, 'template');
      const file = path.join(TEMPLATES_DIR, LETTERS[row.kind].template);
      ok(row.content.length < 3 * 1024 * 1024 && stored.length === row.size_bytes, `${row.kind}: the stored row is ${(row.content.length / 1024).toFixed(0)} kB compressed, far under the row limit`);
      if (fs.existsSync(file)) ok(Buffer.compare(stored, fs.readFileSync(file)) === 0, `${row.kind}: the stored template is the file the script wrote`);
      if (personal) ok((await verifyTemplate(row.kind, stored, personal, sources[row.kind])).length === 0, `${row.kind}: the STORED template passes the same proof`);
    }
    const { settings } = await HIRE.getSettings(pool, COMPANY);
    ok(settings.companyLegalName === KARNI_SETTINGS.company_legal_name && settings.signatoryName === KARNI_SETTINGS.signatory_name
      && settings.signatoryDesignation === KARNI_SETTINGS.signatory_designation && settings.placeOfPosting === KARNI_SETTINGS.place_of_posting
      && settings.jurisdiction === KARNI_SETTINGS.jurisdiction && settings.probationMonths === 3 && settings.noticeDaysProbation === 15
      && settings.noticeDaysConfirmed === 30 && settings.offerValidDays === 7, 'Karni’s hiring settings are the spec’s', JSON.stringify(settings));
    const listed = (await HIRE.listTemplates(pool, COMPANY)).templates;
    ok(listed.length === 2 && listed.every((t) => t.builtIn === false && t.sizeBytes > 0 && t.uploadedAt), 'GET /hiring/templates lists both, neither built-in');
  } else skip('Karni’s stored templates and settings', `this is ${slug}`);

  const otherTemplates = (await HIRE.listTemplates(pool, OTHER)).templates;
  ok(otherTemplates.length === 2 && otherTemplates.every((t) => t.builtIn === true && t.sizeBytes > 0 && t.uploadedAt === null),
    `a company with no template of its own (${other.name}) gets the two built-in letters`);
  const otherSettings = (await HIRE.getSettings(pool, OTHER)).settings;
  ok(otherSettings.companyLegalName === other.name && otherSettings.probationMonths === 3 && otherSettings.offerValidDays === 7,
    'and default settings under its own name', JSON.stringify(otherSettings));
}

/* ══ 3. codes ═════════════════════════════════════════════════════════════ */
section('[3] Codes: default rule, first new code, skipping codes in use, a client’s code ignored');
ok(dateParts('2026-08-20').fy === '26-27' && dateParts('2027-03-31').fy === '26-27' && dateParts('2027-04-01').fy === '27-28' && dateParts('2026-01-05').mm === '01',
  'the financial year runs April to March: 20 Aug 2026 and 31 Mar 2027 are 26-27, 1 Apr 2027 is 27-28');

await rolledBack(async (db) => {
  // A company that has never had a rule.
  const [[had]] = await db.query("SELECT COUNT(*) AS n FROM cf_code_schemes WHERE company_id = ? AND entity_type LIKE 'hrms\\_%' AND deleted_at IS NULL", [OTHER]);
  if (Number(had.n)) { skip('default rules', `${other.name} already has hrms rules`); return; }
  const code = await CODES.issueEmployeeCode(db, OTHER, { joiningDate: on });
  const ref = await CODES.issueHiringRef(db, OTHER, { letterDate: '2026-08-12' });
  const [rules] = await db.query("SELECT entity_type, code, status FROM cf_code_schemes WHERE company_id = ? AND entity_type LIKE 'hrms\\_%' AND deleted_at IS NULL ORDER BY entity_type", [OTHER]);
  ok(rules.length === 2 && rules.every((r) => r.status === 'active'), 'a company with no rule gets a default one for each, on first use', JSON.stringify(rules));
  ok(/^EMP\d{4}$/.test(code), `the default employee code is EMP and four digits (${code})`);
  ok(ref === 'HR/26-27/001', `the default letter reference is HR/<financial year>/001 (${ref})`);
  ok(await CODES.issueHiringRef(db, OTHER, { letterDate: '2026-09-01' }) === 'HR/26-27/002'
    && await CODES.issueHiringRef(db, OTHER, { letterDate: '2027-04-02' }) === 'HR/27-28/001', 'the reference counts up within a financial year and restarts in the next');
  const second = await CODES.issueEmployeeCode(db, OTHER, {});
  ok(Number(second.slice(3)) === Number(code.slice(3)) + 1, `the next employee code follows (${second})`);
  ok(await CODES.ensureDefaultRule(db, OTHER, 'hrms_employee') === null, 'the default rule is made once');
});
ok(Number((await pool.query("SELECT COUNT(*) AS n FROM cf_code_schemes WHERE company_id = ? AND entity_type LIKE 'hrms\\_%'", [OTHER]))[0][0].n) === 0,
  'rolled back: the other company has no rule left behind');

const expectFirst = IS_KARNI ? 'KP0072' : null;
if (IS_KARNI) ok(baselineCounter === 72, 'Karni’s employee counter stands at 72', `${baselineCounter}`);

let firstCode = null;
await rolledBack(async (db) => {
  const made = await PEOPLE.createEmployee(db, c, { employeeCode: 'HACKED-1', fullName: `${TAG} First`, dateOfJoining: on });
  firstCode = made.employee.employeeCode;
  if (IS_KARNI) ok(firstCode === 'KP0072', 'Karni’s first new employee code is KP0072', firstCode);
  ok(firstCode !== 'HACKED-1' && /\d/.test(firstCode), 'a code sent by the client on create is ignored', firstCode);
  const [[hacked]] = await db.query("SELECT COUNT(*) AS n FROM hrms_employees WHERE company_id = ? AND employee_code LIKE 'HACKED%'", [COMPANY]);
  ok(Number(hacked.n) === 0, 'no employee carries the client’s code');

  const changed = await PEOPLE.updateEmployee(db, c, made.employee.id, { employeeCode: 'HACKED-2', fullName: `${TAG} Renamed` });
  ok(changed.employee.employeeCode === firstCode && changed.employee.fullName === `${TAG} Renamed`, 'a code sent on update is ignored; the rest of the update is applied', changed.employee.employeeCode);

  // Codes already in use — one of them typed in lower case — are skipped.
  const n = Number(firstCode.replace(/\D/g, ''));
  const prefix = firstCode.replace(/\d+$/, '');
  const width = firstCode.length - prefix.length;
  const at = (k) => `${prefix}${String(n + k).padStart(width, '0')}`;
  for (const taken of [at(1), at(2).toLowerCase()]) {
    await db.query('INSERT INTO hrms_employees (company_id, employee_code, full_name, date_of_joining, created_by) VALUES (?, ?, ?, ?, ?)', [COMPANY, taken, `${TAG} Holder`, on, c.userId]);
  }
  // …and one that belonged to a record since deleted.
  await db.query('INSERT INTO hrms_employees (company_id, employee_code, full_name, date_of_joining, created_by, deleted_at) VALUES (?, ?, ?, ?, ?, NOW())', [COMPANY, at(3), `${TAG} Gone`, on, c.userId]);
  const next = await PEOPLE.createEmployee(db, c, { fullName: `${TAG} Fourth`, dateOfJoining: on });
  ok(next.employee.employeeCode === at(4), `three codes in use (one lower case, one of a deleted record) are skipped: ${at(4)}`, next.employee.employeeCode);

  const events = (await db.query('SELECT event_type FROM hrms_employment_events WHERE company_id = ? AND employee_id = ?', [COMPANY, next.employee.id]))[0];
  ok(events.some((e) => e.event_type === 'JOIN'), 'a created employee still gets a JOIN event');

  // A create that is refused asks nothing of the generator.
  const before = await counterOf(db, 'hrms_employee');
  const bad = await caught(() => PEOPLE.createEmployee(db, c, { fullName: '', dateOfJoining: on }));
  ok(refused(bad, 422, 'INVALID') && await counterOf(db, 'hrms_employee') === before, 'a create refused for a missing name takes no number', why(bad));

  // The retired workbook applier's two options still work, and only from server code.
  const kept = await PEOPLE.createEmployee(db, c, { fullName: `${TAG} Imported`, dateOfJoining: on }, null, { importedCode: `${TAG}X1` });
  ok(kept.employee.employeeCode === `${TAG}X1` && await counterOf(db, 'hrms_employee') === before, 'server-side `importedCode` is honoured and takes no number');
  ok(refused(await caught(() => PEOPLE.createEmployee(db, c, { fullName: `${TAG} Dup`, dateOfJoining: on }, null, { importedCode: firstCode })), 409, 'DUPLICATE_CODE'),
    'an imported code already in use is refused');

  // A rule with a condition: the department decides, and its code prints.
  const [[dept]] = await db.query(
    `SELECT d.id, d.code, d.parent_department_id FROM hrms_departments d
      WHERE d.company_id = ? AND d.deleted_at IS NULL AND d.parent_department_id IS NOT NULL AND d.code IS NOT NULL ORDER BY d.id LIMIT 1`, [COMPANY]);
  if (!dept) skip('a rule with a department condition', 'no department with a parent');
  else {
    await createScheme(db, COMPANY, c.userId, {
      code: `${TAG}_UNDER`, name: `${TAG} under`, entityType: 'hrms_employee', targetField: 'code', seqScope: 'prefix', priority: 0, status: 'active',
      conditions: [{ tokenKey: 'department', operator: 'under', value: String(dept.parent_department_id) }],
      segments: [{ segmentType: 'literal', literalText: `${TAG}-` }, { segmentType: 'token', tokenKey: 'department.code' },
        { segmentType: 'literal', literalText: '-' }, { segmentType: 'token', tokenKey: 'joining.fy' }, { segmentType: 'literal', literalText: '-' }, { segmentType: 'sequence', format: '00' }],
    });
    const inDept = await PEOPLE.createEmployee(db, c, { fullName: `${TAG} In dept`, dateOfJoining: '2026-08-20' }, null, { codeContext: { departmentId: dept.id } });
    ok(inDept.employee.employeeCode === `${TAG}-${dept.code}-26-27-01`, 'a rule "department is under X" wins over the plain rule and prints the department and the financial year', inDept.employee.employeeCode);
    const elsewhere = await PEOPLE.createEmployee(db, c, { fullName: `${TAG} No dept`, dateOfJoining: on });
    ok(!elsewhere.employee.employeeCode.startsWith(TAG), 'an employee created without a department still gets the plain rule', elsewhere.employee.employeeCode);
    const bad2 = await caught(() => createScheme(db, COMPANY, c.userId, {
      code: `${TAG}_BAD`, name: 'bad', entityType: 'hrms_employee', conditions: [{ tokenKey: 'department', operator: 'eq', value: '999999999' }],
      segments: [{ segmentType: 'token', tokenKey: 'shoe.size' }, { segmentType: 'sequence', format: '00' }],
    }));
    ok(refused(bad2, 422, 'INVALID_SCHEME') && bad2.problems.length === 2, 'a rule naming a department that does not exist, or a value employees do not have, is refused', JSON.stringify(bad2?.problems));
  }
});

// The create above was rolled back: its number is free again, for everyone.
ok(await counterOf(pool, 'hrms_employee') === baselineCounter, 'a rolled-back create gives its number back: the counter is where it was', `${await counterOf(pool, 'hrms_employee')}`);
await rolledBack(async (db) => {
  const again = await PEOPLE.createEmployee(db, c, { fullName: `${TAG} Again`, dateOfJoining: on });
  ok(again.employee.employeeCode === firstCode, `and the same code is issued to the next create (${firstCode})`, again.employee.employeeCode);
});

/* ══ 4. the whole flow ════════════════════════════════════════════════════ */
section('[4] The flow on a vacant position: JD -> offer letter -> again -> accept -> appoint');

/** A vacant, open position with a shift — one whose manager position is filled when there is one. */
const [vacantRows] = await pool.query(
  `SELECT p.id, p.position_code, p.role_id, p.department_id, p.location_id, p.default_shift_id,
          (SELECT COUNT(*) FROM hrms_position_reporting_relationships rr
             JOIN hrms_work_assignments ma ON ma.company_id = rr.company_id AND ma.position_id = rr.to_position_id
                  AND ma.deleted_at IS NULL AND ma.status <> 'ENDED' AND (ma.effective_to IS NULL OR ma.effective_to >= ?)
            WHERE rr.company_id = p.company_id AND rr.from_position_id = p.id AND rr.deleted_at IS NULL) AS managed
     FROM hrms_positions p
    WHERE p.company_id = ? AND p.deleted_at IS NULL AND p.status IN ('ACTIVE', 'DRAFT') AND p.default_shift_id IS NOT NULL
      AND (p.effective_to IS NULL OR p.effective_to >= ?)
      AND NOT EXISTS (SELECT 1 FROM hrms_work_assignments wa
                       WHERE wa.company_id = p.company_id AND wa.position_id = p.id AND wa.deleted_at IS NULL AND wa.status <> 'ENDED'
                         AND (wa.effective_to IS NULL OR wa.effective_to >= ?))
    ORDER BY managed DESC, p.id LIMIT 3`,
  [on, COMPANY, on, on],
);
const [[someone]] = await pool.query(
  "SELECT id, full_name FROM hrms_employees WHERE company_id = ? AND deleted_at IS NULL AND employment_status = 'ACTIVE' ORDER BY id LIMIT 1", [COMPANY]);

const CANDIDATE = {
  candidateSalutation: 'Ms.', candidateName: `Test Candidate ${TAG}`, candidatePhone: '9000000000', candidateEmail: `${TAG.toLowerCase()}@example.test`,
  candidateAddress: 'Flat 1, Example Towers,\nSample Street,\nHyderabad 500001.', candidateGender: 'Female', candidateDateOfBirth: '1995-04-03',
  proposedJoiningDate: addDays(on, 10), annualCtc: 345678,
};

if (vacantRows.length < 2 || !someone) {
  skip('the flow', 'this company has no two vacant positions with a shift, or no active employee');
} else {
  const target = vacantRows[0];

  await rolledBack(async (db) => {
    const chartBefore = (await buildOrgChart(db, COMPANY, {})).counts;
    const openBefore = chartBefore.hiring;
    ok(openBefore === baselineChart.hiring, 'counts.hiring is what it was before anything is started', `${openBefore}`);

    // ── start ──
    const started = (await HIRE.startHiring(db, c, target.id)).hiring;
    ok(started.stage === 'JD' && started.positionId === target.id && started.refNo === null && started.candidateName === null && started.employee === null
      && started.statusLine === 'Job description to confirm', 'a hiring starts at JD, with no candidate, no reference and no employee', JSON.stringify(started.statusLine));
    const pos = (await POS.getPosition(db, COMPANY, target.id)).position;
    ok(started.terms.designation === pos.displayTitle && started.terms.departmentName === pos.departmentName && started.departmentName === pos.departmentName
      && started.shift?.id === target.default_shift_id && started.positionCode === pos.positionCode && started.roleId === target.role_id,
    'its defaults come from the position: designation, department, shift', JSON.stringify(started.terms));
    if (IS_KARNI) {
      ok(started.terms.placeOfPosting === KARNI_SETTINGS.place_of_posting && started.terms.signatoryName === KARNI_SETTINGS.signatory_name
        && started.terms.signatoryDesignation === KARNI_SETTINGS.signatory_designation && started.terms.probationMonths === 3
        && started.terms.noticeDaysProbation === 15 && started.terms.noticeDaysConfirmed === 30, 'and from the company’s hiring settings: posting, signatory, probation, notice');
    }
    ok(started.terms.offerDate === on && started.terms.offerValidUntil === addDays(on, 7), 'the offer is dated today and valid for the settings’ 7 days', `${started.terms.offerDate} -> ${started.terms.offerValidUntil}`);
    if (Number(target.managed)) ok(Boolean(started.terms.reportingToTitle) && Boolean(started.terms.reportingToName), 'reporting-to is the manager position’s title and the person in it');
    ok(JSON.stringify(started.can) === JSON.stringify({ edit: false, confirmJd: true, generateOffer: false, acceptOffer: false, appoint: false, close: true }),
      'at JD the server will take: confirm the JD, or close', JSON.stringify(started.can));
    ok(started.missing.offerLetter.length === 3 && started.missing.appoint.length === 3 && started.letters.length === 0 && started.jd === null,
      '`missing` says in words what the offer letter and the appointment still need', JSON.stringify(started.missing));
    const H = started.id;

    // ── one open hiring per position ──
    const twice = await caught(() => HIRE.startHiring(db, c, target.id));
    ok(refused(twice, 409, 'HIRING_OPEN') && twice.existing?.id === H && twice.detail?.hiringId === H, 'a second hiring on the position: 409 HIRING_OPEN, naming the open one', why(twice));
    const dbTwice = await caught(() => db.query('INSERT INTO hrms_hirings (company_id, position_id, stage) VALUES (?, ?, ?)', [COMPANY, target.id, 'OFFER']));
    ok(dbTwice?.errno === 1062, 'and the database itself refuses a second open hiring (uq_hhir_open)', dbTwice?.code ?? 'accepted');

    // ── what the other reads gain (§2.5) ──
    const expected = { id: H, stage: 'JD', candidateName: null, statusLine: 'Job description to confirm' };
    const same = (x) => JSON.stringify(x) === JSON.stringify(expected);
    const chart = await buildOrgChart(db, COMPANY, {});
    const node = chart.nodes.find((n) => n.id === target.id);
    ok(same(node.hiring) && chart.counts.hiring === openBefore + 1 && chart.nodes.filter((n) => n.hiring).length === openBefore + 1, 'the chart node carries the open hiring, and counts.hiring went up by one', JSON.stringify(node.hiring));
    ok(node.vacancies === 1 && chart.counts.vacant === chartBefore.vacant && chart.counts.filled === chartBefore.filled, 'a position with an open hiring is still vacant in every count');
    const card = await getPositionCard(db, COMPANY, target.id, {});
    ok(same(card.hiring), 'the position card carries it', JSON.stringify(card.hiring));
    const listed = await POS.listPositions(db, COMPANY, { status: 'DRAFT,ACTIVE,FROZEN' });
    ok(same(listed.items.find((x) => x.id === target.id).hiring) && listed.items.filter((x) => x.hiring).length === openBefore + 1, 'the Positions list row carries it, and no row gained one that should not have');
    ok(same((await POS.getPosition(db, COMPANY, target.id)).position.hiring), 'GET /positions/:id carries it');
    const staffing = await departmentStaffing(db, COMPANY, {});
    const staffRow = staffing.departments.flatMap((d) => d.roles).flatMap((r) => r.positions).find((x) => x.positionId === target.id);
    ok(same(staffRow.hiring), 'the Departments staffing row carries it', JSON.stringify(staffRow?.hiring));
    ok(card.siblings.every((s) => 'hiring' in s), 'each other position of the card says whether it has one');

    // ── a position with an open hiring cannot be closed or deleted ──
    ok(node.joining === null && card.joining === null && chart.counts.joining === baselineChart.joining, 'nobody is due to join it: `joining` is null and counts.joining has not moved');
    const SENTENCE = 'A hiring is open for this position. Close the hiring first.';
    const impactOpen = await POS.getDeleteImpact(db, COMPANY, target.id);
    ok(['close', 'deleteOnly', 'deleteWithTeam'].every((k) => impactOpen.outcomes[k].allowed === false && impactOpen.outcomes[k].code === 'HIRING_OPEN' && impactOpen.outcomes[k].reason === SENTENCE)
      && impactOpen.hiring?.id === H && impactOpen.joining === null, 'delete-impact reports the open hiring as the blocker of all three outcomes, before anyone clicks', JSON.stringify(impactOpen.outcomes.close));
    const isHiringOpen = (e) => refused(e, 409, 'HIRING_OPEN') && e.message === SENTENCE && e.existing?.id === H && e.detail?.hiringId === H;
    const closeOpen = await caught(() => POS.closePosition(db, c, target.id, {}));
    ok(isHiringOpen(closeOpen), 'POST /positions/:id/close: 409 HIRING_OPEN, in the plain sentence, naming the hiring', why(closeOpen));
    for (const mode of [undefined, 'THIS_ONLY', 'WITH_TEAM']) {
      const del = await caught(() => POS.deletePosition(db, c, target.id, { mode }));
      ok(isHiringOpen(del), `DELETE /positions/:id${mode ? `?mode=${mode}` : ''}: 409 HIRING_OPEN`, why(del));
    }
    ok(isHiringOpen(await caught(() => POS.refuseCloseWithTeam(db, COMPANY, target.id, 'CLOSED'))), 'setting status CLOSED directly (PUT, /status) is refused the same way');
    ok((await POS.getPosition(db, COMPANY, target.id)).position.status !== 'CLOSED', 'and the position is still there, still open');

    // ── moving an existing employee here is refused ──
    const moved = await caught(() => ASG.createAssignment(db, c, { employeeId: someone.id, roleId: target.role_id, positionId: target.id, effectiveFrom: on }));
    ok(refused(moved, 409, 'HIRING_OPEN') && moved.existing?.id === H, 'POST /assignments on the position: 409 HIRING_OPEN', why(moved));

    // ── JD ──
    ok(refused(await caught(() => HIRE.updateHiring(db, c, H, { candidateName: 'Too early' })), 409, 'WRONG_STAGE'), 'the candidate cannot be entered before the JD is confirmed (409)');
    ok(refused(await caught(() => HIRE.generateOfferLetter(db, c, H)), 409, 'WRONG_STAGE') && refused(await caught(() => HIRE.acceptOffer(db, c, H, {})), 409, 'WRONG_STAGE')
      , 'no offer letter and no acceptance before the JD is confirmed');

    // ── §3.3: what will go into the JD, and its file, before anything is frozen ──
    /** A snapshot without the moment it was built — the only thing two builds a second apart differ in. */
    // Keys sorted: MySQL stores a JSON object with its keys in its own order.
    const sorted = (v) => (Array.isArray(v) ? v.map(sorted) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().filter((k) => k !== 'generatedAt').map((k) => [k, sorted(v[k])])) : v);
    const timeless = (x) => JSON.stringify(sorted(JSON.parse(JSON.stringify(x))));   // through JSON first: a Date becomes the string it is stored as
    const docsBefore = Number((await db.query('SELECT COUNT(*) AS n FROM hrms_generated_documents WHERE company_id = ?', [COMPANY]))[0][0].n);
    const live = await HIRE.jdPreview(db, c, H);
    const fromDocuments = await previewDocument(db, c, { type: 'ROLE_JD', positionId: target.id });
    ok(JSON.stringify(Object.keys(live.preview)) === JSON.stringify(Object.keys(fromDocuments)) && timeless(live.preview) === timeless(fromDocuments)
      && live.preview.persisted === false && live.preview.documentType === 'ROLE_JD' && live.preview.snapshot.positionContext.position.id === target.id,
    'GET /hirings/:id/jd/preview at JD is exactly GET /documents/preview for the position’s ROLE_JD');
    ok(live.readiness.ready === true && Array.isArray(live.readiness.missing) && live.readiness.missing.every((m) => typeof m === 'string' && !/[_{}]/.test(m))
      && live.readiness.missing.length === live.preview.snapshot.summary.emptySections.filter((k) => !['suppressed', 'exceptions'].includes(k)).length,
    'readiness says it can be confirmed, and names the empty sections in plain words', JSON.stringify(live.readiness));
    const liveDocx = await HIRE.readJdFile(db, c, H);
    const livePdf = await HIRE.readJdFile(db, c, H, 'pdf');
    ok(/\.docx$/.test(liveDocx.fileName) && liveDocx.mimeType === LETTER.DOCX_MIME && Boolean((await JSZip.loadAsync(Buffer.from(liveDocx.contentBase64, 'base64'))).file('word/document.xml'))
      && /\.pdf$/.test(livePdf.fileName) && livePdf.mimeType === 'application/pdf' && Buffer.from(livePdf.contentBase64, 'base64').subarray(0, 5).toString() === '%PDF-',
    'the JD downloads as .docx and as .pdf BEFORE it is confirmed');
    ok(Number((await db.query('SELECT COUNT(*) AS n FROM hrms_generated_documents WHERE company_id = ?', [COMPANY]))[0][0].n) === docsBefore
      && (await HIRE.getHiring(db, COMPANY, H)).hiring.jd === null, 'and neither the preview nor the downloads stored anything');
    ok(refused(await caught(() => HIRE.readJdFile(db, c, H, 'xlsx')), 422, 'INVALID'), 'a format that is not docx or pdf is refused');
    const jd = (await HIRE.confirmJd(db, c, H)).hiring;
    ok(jd.stage === 'OFFER' && jd.jd?.documentId > 0 && Boolean(jd.jd.generatedAt) && jd.statusLine === 'Candidate details to enter', 'confirm-jd freezes a JD and moves to OFFER', jd.statusLine);
    const [[jdRow]] = await db.query('SELECT document_type, position_id, role_id, JSON_EXTRACT(snapshot_json, "$.positionContext.position.id") AS pid FROM hrms_generated_documents WHERE company_id = ? AND id = ?', [COMPANY, jd.jd.documentId]);
    ok(jdRow.document_type === 'ROLE_JD' && jdRow.position_id === target.id && Number(jdRow.pid) === target.id, 'the frozen JD is the POSITION-level job description, made by the documents service');
    const jdFile = await HIRE.readJdFile(db, c, H);
    const jdZip = await JSZip.loadAsync(Buffer.from(jdFile.contentBase64, 'base64'));
    ok(/\.docx$/.test(jdFile.fileName) && jdFile.mimeType === LETTER.DOCX_MIME && Boolean(jdZip.file('word/document.xml')), 'GET /hirings/:id/jd/file returns it as { fileName, mimeType, contentBase64 }');
    const frozen = await HIRE.jdPreview(db, c, H);
    const [[stored]] = await db.query('SELECT snapshot_json FROM hrms_generated_documents WHERE company_id = ? AND id = ?', [COMPANY, jd.jd.documentId]);
    const storedSnapshot = typeof stored.snapshot_json === 'string' ? JSON.parse(stored.snapshot_json) : stored.snapshot_json;
    ok(frozen.preview.persisted === true && frozen.preview.documentId === jd.jd.documentId && frozen.preview.documentType === 'ROLE_JD'
      && JSON.stringify(frozen.preview.snapshot) === JSON.stringify(storedSnapshot) && timeless(frozen.preview.snapshot) === timeless(live.preview.snapshot) && frozen.readiness.ready === true,
    'after confirmation the preview is the FROZEN copy: the stored snapshot, which is what was previewed');
    // The role is rewritten after the freeze: the hiring still shows what was confirmed.
    const purposeThen = frozen.preview.snapshot.role.rolePurpose;
    await db.query('UPDATE hrms_roles SET role_purpose = ? WHERE company_id = ? AND id = ?', [`${TAG} rewritten later`, COMPANY, target.role_id]);
    const afterRewrite = await HIRE.jdPreview(db, c, H);
    ok(afterRewrite.preview.snapshot.role.rolePurpose === purposeThen
      && (await previewDocument(db, c, { type: 'ROLE_JD', positionId: target.id })).snapshot.role.rolePurpose === `${TAG} rewritten later`,
    'rewriting the role afterwards changes the documents preview and NOT the hiring’s frozen JD');
    await db.query('UPDATE hrms_roles SET role_purpose = ? WHERE company_id = ? AND id = ?', [purposeThen, COMPANY, target.role_id]);
    const frozenPdf = await HIRE.readJdFile(db, c, H, 'pdf');
    ok(Buffer.from(frozenPdf.contentBase64, 'base64').subarray(0, 5).toString() === '%PDF-' && frozenPdf.mimeType === 'application/pdf', 'the frozen JD downloads as .pdf too');
    ok(refused(await caught(() => HIRE.confirmJd(db, c, H)), 409, 'WRONG_STAGE'), 'confirming twice is refused');

    // ── OFFER: details ──
    const early = await caught(() => HIRE.generateOfferLetter(db, c, H));
    ok(refused(early, 422, 'NOT_READY') && early.problems.length === 3, 'an offer letter without name, joining date and CTC: 422 with each thing still needed', JSON.stringify(early?.problems));
    const bad = await caught(() => HIRE.updateHiring(db, c, H, {
      candidateName: 'x'.repeat(201), candidateEmail: 'not-an-email', proposedJoiningDate: '2026-13-45', annualCtc: -5, probationMonths: 99, offerValidUntil: '2020-01-01',
    }));
    ok(refused(bad, 422, 'INVALID') && bad.problems.length === 6, 'six bad fields in one save: 422 INVALID with six problems', JSON.stringify(bad?.problems));
    const [[untouched]] = await db.query('SELECT candidate_name, annual_ctc FROM hrms_hirings WHERE id = ?', [H]);
    ok(untouched.candidate_name === null && untouched.annual_ctc === null, 'and nothing of that save was written');

    const edited = (await HIRE.updateHiring(db, c, H, CANDIDATE)).hiring;
    ok(edited.candidate.name === CANDIDATE.candidateName && edited.candidate.address === CANDIDATE.candidateAddress && edited.candidate.dateOfBirth === '1995-04-03'
      && edited.terms.annualCtc === 345678 && edited.terms.proposedJoiningDate === CANDIDATE.proposedJoiningDate && edited.candidateName === CANDIDATE.candidateName,
    'PUT /hirings/:id saves the candidate and the terms (flat camelCase)', JSON.stringify(edited.candidate));
    ok(edited.missing.offerLetter.length === 0 && edited.can.generateOffer && !edited.can.acceptOffer && edited.statusLine === `Offer letter to generate for ${CANDIDATE.candidateName}`,
      'nothing is missing for the offer letter now; accepting is not offered before a letter exists', edited.statusLine);
    const nested = (await HIRE.updateHiring(db, c, H, { candidate: { gender: 'F' }, terms: { reportingToTitle: 'Plant Head' } })).hiring;
    ok(nested.candidate.gender === 'F' && nested.terms.reportingToTitle === 'Plant Head' && nested.candidate.name === CANDIDATE.candidateName,
      'the same save accepts the nested shape it returns (candidate.*, terms.*), changing only what was sent');
    ok(refused(await caught(() => HIRE.acceptOffer(db, c, H, {})), 422, 'NO_OFFER_LETTER'), 'accepting before a letter exists is refused');

    // ── OFFER: the letter ──
    const refBefore = await counterOf(db, 'hrms_hiring');
    const offer1 = await HIRE.generateOfferLetter(db, c, H);
    const expectedRef = IS_KARNI ? `KPPL/HR/${FY}/${String(baselineRefCounter ?? 1).padStart(3, '0')}` : null;
    ok(Boolean(offer1.hiring.refNo) && (!expectedRef || offer1.hiring.refNo === expectedRef), `the first offer letter issues the reference (${offer1.hiring.refNo})`, `expected ${expectedRef}`);
    ok(offer1.letter.kind === 'OFFER' && offer1.letter.version === 1 && offer1.letter.isCurrent && offer1.letter.sizeBytes > 5000 && /\.docx$/.test(offer1.letter.fileName)
      && Boolean(offer1.letter.generatedAt) && 'generatedByName' in offer1.letter, 'it returns { hiring, letter, unfilled } with the letter’s meta', JSON.stringify(offer1.letter));
    ok(Array.isArray(offer1.unfilled) && offer1.unfilled.length === 0, 'unfilled is empty: every placeholder of the template got a value', JSON.stringify(offer1.unfilled));
    const file1 = await HIRE.readLetterFile(db, COMPANY, H, offer1.letter.id);
    const offerXml = await partOf(Buffer.from(file1.contentBase64, 'base64'));
    const offerText = plainText(offerXml);
    ok(file1.fileName === offer1.letter.fileName && file1.mimeType === LETTER.DOCX_MIME && wellFormed(offerXml) && !/\{[A-Za-z_]+\}/.test(offerText),
      'the stored letter opens, is well-formed, and has no placeholder left in it');
    ok((!IS_KARNI || offerText.includes(`To,Ms. ${CANDIDATE.candidateName}`)) && offerText.includes(`Dear Ms. ${CANDIDATE.candidateName}`) && offerText.includes('9000000000')
      && offerText.includes('3,45,678') && offerText.includes(LETTER.letterDate(CANDIDATE.proposedJoiningDate)) && offerText.includes(offer1.hiring.refNo)
      && offerText.includes(`valid until ${LETTER.letterDate(addDays(on, 7))}`) && offerText.includes('three (3) months') && offerText.includes('Plant Head'),
    'it prints the candidate, the phone, the CTC in Indian grouping, the dates in words, the reference and the terms');
    ok((offerXml.match(/Example Towers,<\/w:t><w:br\/><w:t[^>]*>Sample Street,<\/w:t><w:br\/>/) ?? []).length === 1, 'the address prints on its three lines');
    if (IS_KARNI) ok(offerText.includes('Karni Packaging Private Limited') && offerText.includes('Name:Ramakrishna') && /<w:hdr|headerReference/.test(offerXml + await partOf(Buffer.from(file1.contentBase64, 'base64'), 'word/header1.xml')),
      'on Karni’s own letter: its legal name, its signatory, its letterhead');
    const [[snap]] = await db.query('SELECT snapshot_json FROM hrms_hiring_letters WHERE id = ?', [offer1.letter.id]);
    const snapshot = typeof snap.snapshot_json === 'string' ? JSON.parse(snap.snapshot_json) : snap.snapshot_json;
    ok(snapshot.values.candidate_name === CANDIDATE.candidateName && snapshot.values.annual_ctc === '3,45,678' && snapshot.template.builtIn === !IS_KARNI,
      'the row keeps a snapshot of the values printed and which template made it');
    ok(offer1.hiring.statusLine === `Offer sent to ${CANDIDATE.candidateName}` && offer1.hiring.can.acceptOffer && offer1.hiring.can.generateOffer,
      'the status line reads "Offer sent to …"; accepting and generating again are both offered', offer1.hiring.statusLine);

    await HIRE.updateHiring(db, c, H, { annualCtc: '4,00,000' });
    const offer2 = await HIRE.generateOfferLetter(db, c, H);
    ok(offer2.letter.version === 2 && offer2.letter.isCurrent && offer2.hiring.refNo === offer1.hiring.refNo && offer2.letter.fileName.endsWith('_v2.docx'),
      'generating again makes version 2 under the SAME reference', `${offer2.letter.version} ${offer2.hiring.refNo}`);
    ok(offer2.hiring.letters.length === 2 && offer2.hiring.letters[0].id === offer2.letter.id && offer2.hiring.letters[1].isCurrent === false,
      'the hiring lists both versions, newest first, only the latest current');
    ok(await counterOf(db, 'hrms_hiring') === (refBefore ?? 1) + 1, 'one reference number was taken, not two');
    ok(plainText(await partOf(Buffer.from((await HIRE.readLetterFile(db, COMPANY, H, offer2.letter.id)).contentBase64, 'base64'))).includes('4,00,000')
      && plainText(await partOf(Buffer.from((await HIRE.readLetterFile(db, COMPANY, H, offer1.letter.id)).contentBase64, 'base64'))).includes('3,45,678'),
    'version 2 prints the new CTC (typed as 4,00,000); version 1 still prints what it printed');

    // ── appoint without an accepted offer ──
    const tooSoon = await caught(() => HIRE.appoint(db, c, H, { joiningDate: on }));
    ok(refused(tooSoon, 409, 'OFFER_NOT_ACCEPTED') && tooSoon.problems.length === 1, 'appointing before the offer is accepted: 409 OFFER_NOT_ACCEPTED', why(tooSoon));

    // ── accept ──
    ok(refused(await caught(() => HIRE.acceptOffer(db, c, H, { acceptedOn: addDays(on, 3) })), 422, 'INVALID'), 'an acceptance dated in the future is refused');
    const accepted = (await HIRE.acceptOffer(db, c, H, {})).hiring;
    ok(accepted.stage === 'APPOINTMENT' && accepted.offerAccepted === true && accepted.offerAcceptedOn === on && accepted.can.appoint && accepted.can.edit
      && !accepted.can.generateOffer && !accepted.can.acceptOffer && accepted.missing.appoint.length === 0, 'accept-offer moves to APPOINTMENT; appointing is now offered', JSON.stringify(accepted.can));
    ok(refused(await caught(() => HIRE.generateOfferLetter(db, c, H)), 409, 'WRONG_STAGE'), 'the offer letter can no longer be generated again once accepted');
    ok(same({ ...(await POS.getPosition(db, COMPANY, target.id)).position.hiring, stage: 'JD', candidateName: null, statusLine: 'Job description to confirm' })
      && (await POS.getPosition(db, COMPANY, target.id)).position.hiring.candidateName === CANDIDATE.candidateName
      && (await POS.getPosition(db, COMPANY, target.id)).position.hiring.stage === 'APPOINTMENT', 'the position’s hiring now names the candidate and the stage');

    // ── appoint ──
    ok(refused(await caught(() => HIRE.appoint(db, c, H, {})), 422, 'INVALID') && refused(await caught(() => HIRE.appoint(db, c, H, { joiningDate: 'tomorrow' })), 422, 'INVALID'),
      'appointing needs a joining date that is a date');
    const employeesBefore = Number((await db.query('SELECT COUNT(*) AS n FROM hrms_employees WHERE company_id = ? AND deleted_at IS NULL', [COMPANY]))[0][0].n);
    const done = await HIRE.appoint(db, c, H, { joiningDate: on });
    ok(done.hiring.stage === 'DONE' && done.hiring.joiningDate === on && done.hiring.appointmentDate === on && done.hiring.employee?.id === done.employee.id
      && done.assignmentId > 0 && done.letter.kind === 'APPOINTMENT' && Array.isArray(done.unfilled),
    'appoint returns { hiring, employee, assignmentId, letter, unfilled } and the hiring is DONE');
    ok(done.employee.fullName === CANDIDATE.candidateName && (!expectFirst || done.employee.employeeCode === expectFirst) && /\d/.test(done.employee.employeeCode),
      `the employee exists with an ISSUED code (${done.employee.employeeCode})`, `expected ${expectFirst}`);
    const emp = (await PEOPLE.getEmployee(db, COMPANY, done.employee.id)).employee;
    ok(emp.salutation === 'Ms.' && emp.phone === '9000000000' && emp.email === CANDIDATE.candidateEmail && emp.gender === 'F' && emp.dateOfBirth === '1995-04-03'
      && emp.dateOfJoining === on && emp.employmentStatus === 'ACTIVE' && emp.employmentType === 'EMPLOYEE' && emp.addressJson?.line1 === 'Flat 1, Example Towers,',
    'salutation, phone, email, gender, date of birth and address are carried over; joined on the joining date; ACTIVE', JSON.stringify({ ...emp, addressJson: undefined }));
    ok(Number((await db.query('SELECT COUNT(*) AS n FROM hrms_employees WHERE company_id = ? AND deleted_at IS NULL', [COMPANY]))[0][0].n) === employeesBefore + 1, 'exactly one employee was created');
    const [[asg]] = await db.query('SELECT * FROM hrms_work_assignments WHERE company_id = ? AND id = ?', [COMPANY, done.assignmentId]);
    ok(asg.employee_id === done.employee.id && asg.position_id === target.id && asg.role_id === target.role_id && asg.department_id === target.department_id
      && asg.location_id === target.location_id && asg.default_shift_id === target.default_shift_id && asg.is_primary === 1 && asg.status === 'ACTIVE'
      && POS.dateText(asg.effective_from) === on && asg.effective_to === null,
    'they sit in the position: its role, department, location and SHIFT; primary; ACTIVE from the joining date');
    const [events] = await db.query('SELECT event_type, event_date, work_assignment_id FROM hrms_employment_events WHERE company_id = ? AND employee_id = ? ORDER BY id', [COMPANY, done.employee.id]);
    ok(events.length === 2 && events[0].event_type === 'JOIN' && events[1].event_type === 'ASSIGNMENT_CHANGE' && events[1].work_assignment_id === done.assignmentId,
      'their file has a JOIN event and the appointment to the position', JSON.stringify(events.map((e) => e.event_type)));
    const [audits] = await db.query(
      `SELECT entity_type, action FROM hrms_audit_log WHERE company_id = ? AND (
         (entity_type = 'hrms_hirings' AND entity_id = ?) OR (entity_type = 'hrms_employees' AND entity_id = ?)
         OR (entity_type = 'hrms_work_assignments' AND entity_id = ?) OR (entity_type = 'hrms_hiring_letters' AND entity_id IN (?))) ORDER BY id`,
      [COMPANY, H, done.employee.id, done.assignmentId, done.hiring.letters.map((l) => l.id)]);
    const auditKinds = audits.map((a) => `${a.entity_type.replace('hrms_', '')}:${a.action}`);
    ok(auditKinds.filter((k) => k === 'hirings:UPDATE').length >= 6 && auditKinds.includes('hirings:CREATE') && auditKinds.filter((k) => k === 'hiring_letters:GENERATE').length === 3
      && auditKinds.includes('employees:CREATE') && auditKinds.includes('work_assignments:CREATE'), 'every step is in the audit log', auditKinds.join(' '));
    const [[auditText]] = await db.query("SELECT GROUP_CONCAT(COALESCE(after_json, '') SEPARATOR ' ') AS t FROM hrms_audit_log WHERE company_id = ? AND entity_type = 'hrms_hirings' AND entity_id = ?", [COMPANY, H]);
    ok(!auditText.t.includes('9000000000') && !auditText.t.includes('Example Towers') && !auditText.t.includes('400000'), 'the hiring’s audit rows name the fields that changed, never a phone, an address or a salary');

    // ── the appointment letter ──
    ok(done.unfilled.length === 0, 'the appointment letter: unfilled is empty', JSON.stringify(done.unfilled));
    const apFile = await HIRE.readLetterFile(db, COMPANY, H, done.letter.id);
    const apXml = await partOf(Buffer.from(apFile.contentBase64, 'base64'));
    const apText = plainText(apXml);
    ok(wellFormed(apXml) && !/\{[A-Za-z_]+\}/.test(apText) && apText.includes(`Dear Ms. ${CANDIDATE.candidateName}`) && apText.includes(done.hiring.refNo)
      && apText.includes(LETTER.letterDate(on)) && (!IS_KARNI || apText.includes(`effective from ${LETTER.letterDate(on)}`))
      && apText.includes('Fifteen (15) days') && apText.includes('Thirty (30) days'),
    'it opens, has no placeholder left, and prints the same reference, the joining date and the notice periods');
    if (IS_KARNI) ok(apText.includes('Compensation structure attached separately.') && !/<w:drawing/.test(apXml) && apText.includes('courts at Hyderabad, Telangana.'),
      'Karni’s: the Annexure says the compensation is attached separately, and there is no picture in it');
    else ok(apText.includes(done.employee.employeeCode), 'the built-in appointment letter prints the employee code');
    const [[apSnap]] = await db.query('SELECT snapshot_json FROM hrms_hiring_letters WHERE id = ?', [done.letter.id]);
    const apValues = (typeof apSnap.snapshot_json === 'string' ? JSON.parse(apSnap.snapshot_json) : apSnap.snapshot_json).values;
    ok(apValues.employee_code === done.employee.employeeCode && apValues.joining_date === LETTER.letterDate(on), 'the letter was rendered WITH the employee code (it is in the values it was given)');
    ok(done.hiring.letters.length === 3 && done.hiring.letters.filter((l) => l.isCurrent).length === 2, 'three letters are stored: two offers and the appointment');

    // ── afterwards ──
    const after = (await POS.getPosition(db, COMPANY, target.id)).position;
    ok(after.filledCount === 1 && after.vacancyCount === 0 && after.occupant?.employeeId === done.employee.id && after.hiring === null,
      'the position is filled by the new employee, and carries no open hiring');
    const chartAfter = (await buildOrgChart(db, COMPANY, {})).counts;
    ok(chartAfter.filled === chartBefore.filled + 1 && chartAfter.vacant === chartBefore.vacant - 1 && chartAfter.hiring === openBefore, 'the chart: one more filled, one fewer vacant, and this hiring no longer open');
    ok(done.hiring.statusLine === `${CANDIDATE.candidateName} appointed as ${done.employee.employeeCode}` && Object.values(done.hiring.can).every((x) => x === false),
      'the hiring reads "… appointed as <code>" and accepts nothing further', done.hiring.statusLine);
    const lists = { open: await HIRE.listHirings(db, COMPANY, { status: 'open' }), done: await HIRE.listHirings(db, COMPANY, { status: 'done' }),
      all: await HIRE.listHirings(db, COMPANY, {}), byPos: await HIRE.listHirings(db, COMPANY, { positionId: target.id }) };
    const mine = (list) => list.hirings.find((x) => x.id === H);
    ok(!mine(lists.open) && Boolean(mine(lists.done)) && Boolean(mine(lists.all)) && lists.all.hirings.length === baselineHirings + 1 && lists.byPos.hirings[0].id === H
      && lists.byPos.hirings.every((x) => x.positionId === target.id) && lists.all.hirings[0].id === H
      && mine(lists.done).employee.employeeCode === done.employee.employeeCode && !('candidate' in mine(lists.done)),
    'GET /hirings: it is under done, not open; a list row is the summary, without the candidate’s details');
    ok(refused(await caught(() => HIRE.listHirings(db, COMPANY, { status: 'nonsense' })), 422, 'INVALID'), 'an unknown ?status= is refused');

    // ── every refusal after DONE ──
    ok(refused(await caught(() => HIRE.updateHiring(db, c, H, { candidateName: 'Someone Else' })), 409, 'WRONG_STAGE'), 'edit after DONE: 409');
    ok(refused(await caught(() => HIRE.closeHiring(db, c, H, { reason: 'CANCELLED' })), 409, 'WRONG_STAGE'), 'close after DONE: 409');
    ok(refused(await caught(() => HIRE.appoint(db, c, H, { joiningDate: on })), 409, 'WRONG_STAGE'), 'appoint again: 409');
    ok(refused(await caught(() => HIRE.acceptOffer(db, c, H, {})), 409, 'WRONG_STAGE') && refused(await caught(() => HIRE.generateOfferLetter(db, c, H)), 409, 'WRONG_STAGE'),
      'accept again, offer letter again: 409');
    const filled = await caught(() => HIRE.startHiring(db, c, target.id));
    ok(refused(filled, 409, 'POSITION_FILLED') && filled.detail?.occupant?.employeeId === done.employee.id, 'a new hiring on the now-filled position: 409 POSITION_FILLED, naming who is in it', why(filled));

    // ── 7. another company ──
    section('[7] Another company cannot read a hiring, a letter or a JD');
    ok(refused(await caught(() => HIRE.getHiring(db, OTHER, H)), 404, 'NOT_FOUND'), 'GET /hirings/:id from another company: 404');
    ok(refused(await caught(() => HIRE.readLetterFile(db, OTHER, H, done.letter.id)), 404, 'NOT_FOUND')
      && refused(await caught(() => HIRE.readLetterFile(db, OTHER, H, offer1.letter.id)), 404, 'NOT_FOUND'), 'a letter file from another company: 404');
    ok(refused(await caught(() => HIRE.readJdFile(db, { ...c, companyId: OTHER }, H)), 404, 'NOT_FOUND') && refused(await caught(() => HIRE.jdPreview(db, { ...c, companyId: OTHER }, H)), 404, 'NOT_FOUND')
      && refused(await caught(() => HIRE.listCloseReasons(db, OTHER, H)), 404, 'NOT_FOUND'), 'the JD file, the JD preview and the close reasons of this hiring from another company: 404');
    ok((await HIRE.listHirings(db, OTHER, {})).hirings.every((x) => x.id !== H), 'it is not in the other company’s list');
    for (const [name, fn] of [['edit', () => HIRE.updateHiring(db, { ...c, companyId: OTHER }, H, { designation: 'x' })],
      ['close', () => HIRE.closeHiring(db, { ...c, companyId: OTHER }, H, { reason: 'CANCELLED' })],
      ['appoint', () => HIRE.appoint(db, { ...c, companyId: OTHER }, H, { joiningDate: on })]]) {
      ok(refused(await caught(fn), 404, 'NOT_FOUND'), `${name} from another company: 404`);
    }
    ok(refused(await caught(() => HIRE.startHiring(db, { ...c, companyId: OTHER }, target.id)), 404, 'NOT_FOUND'), 'starting a hiring on another company’s position: 404');
    const [[otherLetter]] = await db.query('SELECT id FROM hrms_hiring_letters WHERE company_id = ? AND hiring_id = ? LIMIT 1', [COMPANY, H]);
    ok(refused(await caught(() => HIRE.readLetterFile(db, COMPANY, H + 1, otherLetter.id)), 404, 'NOT_FOUND'), 'a letter is only served under its own hiring');
  });

  /* ══ 5. a closed hiring ═════════════════════════════════════════════════ */
  section('[5] A hiring that is closed: no employee code, the reference kept, the position free again');
  await rolledBack(async (db) => {
    const employeesBefore = Number((await db.query('SELECT COUNT(*) AS n FROM hrms_employees WHERE company_id = ?', [COMPANY]))[0][0].n);
    const counterBefore = await counterOf(db, 'hrms_employee');
    const H = (await HIRE.startHiring(db, c, target.id)).hiring.id;
    ok(refused(await caught(() => HIRE.closeHiring(db, c, H, { reason: 'BORED' })), 422, 'INVALID'), 'a reason nobody has heard of is refused');
    await HIRE.confirmJd(db, c, H);
    await HIRE.updateHiring(db, c, H, CANDIDATE);
    const ref = (await HIRE.generateOfferLetter(db, c, H)).hiring.refNo;
    const closed = (await HIRE.closeHiring(db, c, H, { reason: 'declined', note: 'Took another offer.' })).hiring;
    ok(closed.stage === 'CLOSED' && closed.closeReason === 'OFFER_DECLINED' && closed.closeReasonLabel === 'Candidate declined the offer' && closed.closeNote === 'Took another offer.'
      && closed.refNo === ref && closed.employee === null
      && closed.statusLine === `${CANDIDATE.candidateName} declined the offer` && Object.values(closed.can).every((x) => x === false),
    'closed with the OLD code "declined": stored and read as OFFER_DECLINED, with its label; the reference stays, there is no employee', closed.statusLine);
    const inList = (await HIRE.listHirings(db, COMPANY, { status: 'closed' })).hirings.find((x) => x.id === H);
    ok(inList.closeReason === 'OFFER_DECLINED' && inList.closeReasonLabel === 'Candidate declined the offer', 'the Closed list row carries the reason and its label');
    // A row closed by the first release holds the old code itself.
    await db.query("UPDATE hrms_hirings SET close_reason = 'LAPSED' WHERE id = ?", [H]);
    const old = (await HIRE.getHiring(db, COMPANY, H)).hiring;
    ok(old.closeReason === 'NO_RESPONSE' && old.closeReasonLabel === 'Candidate did not reply; the offer lapsed' && old.statusLine === `${CANDIDATE.candidateName} did not reply; the offer lapsed`,
      'a hiring stored with an old code (LAPSED) READS as the new one', old.statusLine);
    await db.query("UPDATE hrms_hirings SET close_reason = 'CANCELLED' WHERE id = ?", [H]);
    ok((await HIRE.getHiring(db, COMPANY, H)).hiring.closeReason === 'OTHER', 'CANCELLED reads as OTHER');
    await db.query("UPDATE hrms_hirings SET close_reason = 'OFFER_DECLINED' WHERE id = ?", [H]);
    ok(await counterOf(db, 'hrms_employee') === counterBefore
      && Number((await db.query('SELECT COUNT(*) AS n FROM hrms_employees WHERE company_id = ?', [COMPANY]))[0][0].n) === employeesBefore, 'no employee code was used and no employee row exists');
    ok(refused(await caught(() => HIRE.closeHiring(db, c, H, { reason: 'CANCELLED' })), 409, 'WRONG_STAGE') && refused(await caught(() => HIRE.appoint(db, c, H, { joiningDate: on })), 409, 'WRONG_STAGE')
      && refused(await caught(() => HIRE.updateHiring(db, c, H, { designation: 'x' })), 409, 'WRONG_STAGE'), 'close again, appoint, edit: all 409');
    ok((await POS.getPosition(db, COMPANY, target.id)).position.hiring === null, 'the position carries no hiring any more');
    const moved = await ASG.createAssignment(db, c, { employeeId: someone.id, roleId: target.role_id, positionId: target.id, effectiveFrom: on, isPrimary: false });
    ok(moved.assignment.positionId === target.id, 'and an existing employee can be moved there again');
    await ASG.endAssignment(db, c, moved.assignment.id, { effectiveTo: on });
    await db.query('UPDATE hrms_work_assignments SET deleted_at = NOW() WHERE id = ?', [moved.assignment.id]);
    const next = (await HIRE.startHiring(db, c, target.id)).hiring;
    await HIRE.confirmJd(db, c, next.id);
    await HIRE.updateHiring(db, c, next.id, CANDIDATE);
    const nextRef = (await HIRE.generateOfferLetter(db, c, next.id)).hiring.refNo;
    ok(next.id !== H && nextRef !== ref && Number(nextRef.split('/').pop()) === Number(ref.split('/').pop()) + 1, `a new hiring can start on it, and takes the NEXT reference (${ref} then ${nextRef})`);
    for (const stage of ['JD', 'OFFER']) {
      const other2 = (await HIRE.startHiring(db, c, vacantRows[1].id)).hiring;
      if (stage === 'OFFER') await HIRE.confirmJd(db, c, other2.id);
      const cancelled = (await HIRE.closeHiring(db, c, other2.id, { reason: stage === 'JD' ? 'CANCELLED' : 'ON_HOLD' })).hiring;
      ok(cancelled.stage === 'CLOSED' && cancelled.refNo === null && cancelled.closeReason === (stage === 'JD' ? 'OTHER' : 'ON_HOLD')
        && cancelled.statusLine === (stage === 'JD' ? 'Hiring closed' : 'Hiring is on hold for now'),
      `a hiring can be closed from ${stage}${stage === 'JD' ? ' — with the old code CANCELLED and no note, as the first release sent it' : ''}`, cancelled.statusLine);
    }

    // ── §3.4: which reason applies when ──
    const everything = HIRE.listCloseReasons ? (await HIRE.listCloseReasons(db, COMPANY)).groups : [];
    const allCodes = everything.flatMap((g) => g.reasons.map((r) => r.code));
    ok(everything.length === 2 && everything[0].label === 'The candidate' && everything[1].label === 'The company' && allCodes.length === 14
      && allCodes.join(' ') === 'OFFER_DECLINED NO_RESPONSE DID_NOT_JOIN PAY_NOT_AGREED STAYED_WITH_EMPLOYER CANDIDATE_WITHDREW CHECKS_FAILED ANOTHER_CANDIDATE FILLED_INTERNALLY ON_HOLD NOT_NEEDED OFFER_WITHDRAWN STARTED_BY_MISTAKE OTHER',
    'GET /hiring/close-reasons: two groups, the fourteen codes, in the spec’s order');
    const one = (code) => everything.flatMap((g) => g.reasons).find((r) => r.code === code);
    ok(everything.flatMap((g) => g.reasons).every((r) => JSON.stringify(Object.keys(r)) === JSON.stringify(['code', 'label', 'hint', 'noteRequired', 'next']) && r.label && r.hint)
      && one('FILLED_INTERNALLY').next === 'MOVE_EMPLOYEE' && one('NOT_NEEDED').next === 'REMOVE_POSITION' && one('OFFER_DECLINED').next === 'REHIRE'
      && ['ON_HOLD', 'STARTED_BY_MISTAKE', 'OTHER'].every((k) => one(k).next === null)
      && allCodes.filter((k) => one(k).noteRequired).join(' ') === 'OFFER_WITHDRAWN OTHER',
    'each is { code, label, hint, noteRequired, next }; a note is required for OFFER_WITHDRAWN and OTHER only');
    ok(CLOSE_REASON_GROUPS.flatMap((g) => g.reasons).every((r) => r.code.length <= 20), 'every code fits the column');

    const ANY = ['FILLED_INTERNALLY', 'ON_HOLD', 'NOT_NEEDED', 'STARTED_BY_MISTAKE', 'OTHER'];
    const walk = (await HIRE.startHiring(db, c, vacantRows[1].id)).hiring.id;
    /** At the hiring's present state: the list offers exactly `expected`, and a close with each of the 14 is taken or refused to match. */
    const checkStage = async (label, expected) => {
      const offeredNow = (await HIRE.listCloseReasons(db, COMPANY, walk)).groups.flatMap((g) => g.reasons.map((r) => r.code));
      const wrong = [];
      for (const code of allCodes) {
        await db.query('SAVEPOINT try_close');
        const e = await caught(() => HIRE.closeHiring(db, c, walk, { reason: code, note: 'because' }));
        await db.query('ROLLBACK TO SAVEPOINT try_close');
        const taken = e === null;
        if (taken !== expected.includes(code) || (!taken && !refused(e, 422, 'INVALID'))) wrong.push(`${code}:${taken ? 'taken' : e.code}`);
      }
      ok(offeredNow.join(' ') === allCodes.filter((k) => expected.includes(k)).join(' ') && wrong.length === 0,
        `${label}: ${expected.length} reasons are offered, and exactly those are accepted (the other ${14 - expected.length}: 422 INVALID)`, `offered ${offeredNow.join(' ')}; wrong ${wrong.join(' ')}`);
    };
    await checkStage('at JD', ANY);
    await HIRE.confirmJd(db, c, walk);
    await checkStage('at OFFER with no candidate named', [...ANY, 'PAY_NOT_AGREED', 'STAYED_WITH_EMPLOYER']);
    await HIRE.updateHiring(db, c, walk, CANDIDATE);
    await checkStage('candidate named, no offer letter yet', [...ANY, 'PAY_NOT_AGREED', 'STAYED_WITH_EMPLOYER', 'CANDIDATE_WITHDREW', 'CHECKS_FAILED', 'ANOTHER_CANDIDATE']);
    await HIRE.generateOfferLetter(db, c, walk);
    const OFFERED = [...ANY, 'PAY_NOT_AGREED', 'STAYED_WITH_EMPLOYER', 'CHECKS_FAILED', 'ANOTHER_CANDIDATE', 'OFFER_DECLINED', 'NO_RESPONSE', 'OFFER_WITHDRAWN'];
    await checkStage('offer letter sent', OFFERED);
    for (const code of ['OFFER_WITHDRAWN', 'OTHER']) {
      await db.query('SAVEPOINT try_close');
      const noNote = await caught(() => HIRE.closeHiring(db, c, walk, { reason: code, note: '  ' }));
      await db.query('ROLLBACK TO SAVEPOINT try_close');
      ok(refused(noNote, 422, 'INVALID') && noNote.problems.length === 1 && /note/.test(noNote.problems[0]), `${code} without a note: 422 INVALID, asking for the note`, why(noNote));
    }
    await HIRE.acceptOffer(db, c, walk, {});
    await checkStage('offer accepted', [...OFFERED, 'DID_NOT_JOIN']);
    const didNot = (await HIRE.closeHiring(db, c, walk, { reason: 'DID_NOT_JOIN' })).hiring;
    ok(didNot.closeReason === 'DID_NOT_JOIN' && didNot.closeReasonLabel === 'Candidate accepted but did not join' && didNot.statusLine === `${CANDIDATE.candidateName} accepted but did not join`,
      'closed after acceptance as DID_NOT_JOIN, with a status line that reads as a sentence', didNot.statusLine);
    ok(refused(await caught(() => HIRE.listCloseReasons(db, COMPANY, 999999999)), 404, 'NOT_FOUND') && refused(await caught(() => HIRE.listCloseReasons(db, COMPANY, 'abc')), 422, 'INVALID'),
      'close reasons for a hiring that does not exist: 404; for an id that is not a number: 422');
  });

  /* ══ 6. a future joining date; a failure late in the appointment ════════ */
  section('[6] A joining date in the future; a failure late in the appointment');
  const toAppointment = async (db, positionId) => {
    const H = (await HIRE.startHiring(db, c, positionId)).hiring.id;
    await HIRE.confirmJd(db, c, H);
    await HIRE.updateHiring(db, c, H, CANDIDATE);
    await HIRE.generateOfferLetter(db, c, H);
    await HIRE.acceptOffer(db, c, H, {});
    return H;
  };
  await rolledBack(async (db) => {
    const future = addDays(on, 12);
    const chartBefore = (await buildOrgChart(db, COMPANY, {})).counts;
    const H = await toAppointment(db, target.id);
    const done = await HIRE.appoint(db, c, H, { joiningDate: future, appointmentDate: on });
    const [[asg]] = await db.query('SELECT status, effective_from FROM hrms_work_assignments WHERE id = ?', [done.assignmentId]);
    ok(asg.status === 'ACTIVE' && POS.dateText(asg.effective_from) === future, 'the assignment is ACTIVE from the joining date — dates, not the status, decide when it is live');
    const today = (await POS.getPosition(db, COMPANY, target.id)).position;
    const then = (await POS.getPosition(db, COMPANY, target.id, { on: future })).position;
    ok(today.vacancyCount === 1 && today.occupant === null && today.hiring === null, 'until the joining date the position reads VACANT, with no open hiring');
    ok(then.filledCount === 1 && then.occupant?.employeeId === done.employee.id, 'and FILLED as of the joining date');
    const chartNow = (await buildOrgChart(db, COMPANY, {})).counts;
    const chartThen = (await buildOrgChart(db, COMPANY, { on: future })).counts;
    ok(chartNow.vacant === chartBefore.vacant && chartNow.filled === chartBefore.filled && chartThen.filled === chartBefore.filled + 1, 'the chart agrees: unchanged today, one more filled on the day');
    ok(done.hiring.statusLine === `${CANDIDATE.candidateName} joins on ${Number(future.slice(8))} ${LETTER.letterDate(future).split(' ').slice(1).join(' ')}`, 'the hiring reads "… joins on <date>"', done.hiring.statusLine);
    const again = await caught(() => HIRE.startHiring(db, c, target.id));
    ok(refused(again, 409, 'POSITION_FILLED') && /joins it on/.test(again.message) && again.detail?.occupant?.from === future, 'a second hiring before the joining date: 409 POSITION_FILLED, saying who joins and when', why(again));
    const taken = await caught(() => ASG.createAssignment(db, c, { employeeId: someone.id, roleId: target.role_id, positionId: target.id, effectiveFrom: on, isPrimary: false }));
    ok(refused(taken, 409, 'POSITION_FILLED'), 'and nobody else can be moved there in the meantime: 409 POSITION_FILLED', why(taken));

    // ── the joining marker (same reads that carry `hiring`) ──
    const mark = { employeeId: done.employee.id, employeeCode: done.employee.employeeCode, name: CANDIDATE.candidateName, date: future };
    const isMark = (x) => JSON.stringify(x) === JSON.stringify(mark);
    ok(isMark(today.joining) && then.joining === null, 'GET /positions/:id: joining = { employeeId, employeeCode, name, date } until the day, null from it', JSON.stringify(today.joining));
    const chartMarked = await buildOrgChart(db, COMPANY, {});
    const nodeMarked = chartMarked.nodes.find((n) => n.id === target.id);
    ok(isMark(nodeMarked.joining) && nodeMarked.vacancies === 1 && nodeMarked.occupants.length === 0 && nodeMarked.hiring === null
      && chartMarked.counts.joining === baselineChart.joining + 1 && chartMarked.nodes.filter((n) => n.joining).length === baselineChart.joining + 1,
    'the chart node carries it, is still vacant, and counts.joining went up by one', JSON.stringify(nodeMarked.joining));
    ok(chartThen.joining === baselineChart.joining && (await buildOrgChart(db, COMPANY, { on: future })).nodes.find((n) => n.id === target.id).joining === null,
      'as of the joining date the marker is gone from the chart: they are the occupant');
    const cardMarked = await getPositionCard(db, COMPANY, target.id, {});
    ok(isMark(cardMarked.joining) && cardMarked.occupants.length === 0 && cardMarked.siblings.every((x) => 'joining' in x), 'the position card carries it, and each sibling has the field');
    if (cardMarked.siblings.length) {
      const fromSibling = (await getPositionCard(db, COMPANY, cardMarked.siblings[0].positionId, {})).siblings.find((x) => x.positionId === target.id);
      ok(isMark(fromSibling.joining) && fromSibling.occupant === null, 'seen from another position of the card, the sibling row carries it');
    }
    const listMarked = await POS.listPositions(db, COMPANY, { status: 'DRAFT,ACTIVE,FROZEN' });
    ok(isMark(listMarked.items.find((x) => x.id === target.id).joining) && listMarked.items.filter((x) => x.joining).length === baselineChart.joining + 1
      && listMarked.totals.vacant === chartBefore.vacant, 'the Positions list row carries it; the totals have not moved');
    const staffMarked = (await departmentStaffing(db, COMPANY, {})).departments.flatMap((d) => d.roles).flatMap((r) => r.positions).find((x) => x.positionId === target.id);
    ok(isMark(staffMarked.joining) && staffMarked.vacant === 1, 'the Departments staffing row carries it');

    // ── and such a position cannot be closed or deleted ──
    const impactDue = await POS.getDeleteImpact(db, COMPANY, target.id);
    ok(['close', 'deleteOnly', 'deleteWithTeam'].every((k) => impactDue.outcomes[k].code === 'POSITION_FILLED' && impactDue.outcomes[k].reason.includes(CANDIDATE.candidateName))
      && isMark(impactDue.joining) && impactDue.hiring === null, 'delete-impact reports the person due to join as the blocker of all three outcomes', impactDue.outcomes.close.reason);
    const isDue = (e) => refused(e, 409, 'POSITION_FILLED') && e.message.includes(CANDIDATE.candidateName) && /joins this position on \d+ \w+ \d{4}/.test(e.message) && isMark(e.detail?.joining);
    const closeDue = await caught(() => POS.closePosition(db, c, target.id, {}));
    ok(isDue(closeDue), 'closing it: 409 POSITION_FILLED, naming the joiner and the date', why(closeDue));
    ok(isDue(await caught(() => POS.deletePosition(db, c, target.id, {}))) && isDue(await caught(() => POS.deletePosition(db, c, target.id, { mode: 'WITH_TEAM' })))
      && isDue(await caught(() => POS.refuseCloseWithTeam(db, COMPANY, target.id, 'CLOSED'))), 'deleting it, alone or with its team, and setting CLOSED directly: the same');
    ok(plainText(await partOf(Buffer.from((await HIRE.readLetterFile(db, COMPANY, H, done.letter.id)).contentBase64, 'base64'))).includes(LETTER.letterDate(future)), 'the appointment letter states the future joining date');
  });

  await rolledBack(async (db) => {
    // Somebody takes the position while the hiring waits (a write that went around the service).
    const H = await toAppointment(db, target.id);
    const [squat] = await db.query(
      'INSERT INTO hrms_work_assignments (company_id, employee_id, role_id, position_id, status, effective_from, is_primary, created_by) VALUES (?, ?, ?, ?, ?, ?, 0, ?)',
      [COMPANY, someone.id, target.role_id, target.id, 'ACTIVE', on, c.userId]);
    const counterBefore = await counterOf(db, 'hrms_employee');
    const lost = await caught(() => HIRE.appoint(db, c, H, { joiningDate: on }));
    ok(refused(lost, 409, 'POSITION_FILLED') && lost.detail?.occupant?.employeeId === someone.id, 'appointing after somebody took the position: 409 POSITION_FILLED', why(lost));
    ok(await counterOf(db, 'hrms_employee') === counterBefore && (await HIRE.getHiring(db, COMPANY, H)).hiring.stage === 'APPOINTMENT', 'no code was taken and the hiring is still waiting');
    await db.query('DELETE FROM hrms_work_assignments WHERE id = ?', [squat.insertId]);

    // A failure AFTER the employee and the assignment were written: the letter cannot be made.
    // The route runs appoint in one transaction and rolls back on any throw; a savepoint stands in for it here.
    await db.query('UPDATE hrms_letter_templates SET is_current = 0 WHERE company_id = ? AND kind = ?', [COMPANY, 'APPOINTMENT']);
    await db.query(
      "INSERT INTO hrms_letter_templates (company_id, kind, file_name, size_bytes, storage, compression, content, is_current) VALUES (?, 'APPOINTMENT', 'broken.docx', 9, 'db', NULL, ?, 1)",
      [COMPANY, Buffer.from('not a zip')]);
    const employeesBefore = Number((await db.query('SELECT COUNT(*) AS n FROM hrms_employees WHERE company_id = ?', [COMPANY]))[0][0].n);
    await db.query('SAVEPOINT before_appoint');
    const broke = await caught(() => HIRE.appoint(db, c, H, { joiningDate: on }));
    const midway = Number((await db.query('SELECT COUNT(*) AS n FROM hrms_employees WHERE company_id = ?', [COMPANY]))[0][0].n);
    await db.query('ROLLBACK TO SAVEPOINT before_appoint');
    ok(refused(broke, 422, 'BAD_TEMPLATE') && midway === employeesBefore + 1, 'the appointment fails at its LAST step, after the employee was written', why(broke));
    const [[left]] = await db.query('SELECT stage, employee_id, assignment_id, joining_date FROM hrms_hirings WHERE id = ?', [H]);
    ok(left.stage === 'APPOINTMENT' && left.employee_id === null && left.assignment_id === null && left.joining_date === null
      && Number((await db.query('SELECT COUNT(*) AS n FROM hrms_employees WHERE company_id = ?', [COMPANY]))[0][0].n) === employeesBefore
      && Number((await db.query("SELECT COUNT(*) AS n FROM hrms_hiring_letters WHERE hiring_id = ? AND kind = 'APPOINTMENT'", [H]))[0][0].n) === 0
      && await counterOf(db, 'hrms_employee') === counterBefore && (await POS.getPosition(db, COMPANY, target.id)).position.vacancyCount === 1,
    'undone together: no employee, no assignment, no letter, the hiring still at APPOINTMENT — and the employee code was not consumed');
  });

  await rolledBack(async (db) => {
    // The JD refusal, on a role with nothing written.
    const role = await db.query("INSERT INTO hrms_roles (company_id, role_code, title, status, created_by) VALUES (?, ?, ?, 'ACTIVE', ?)", [COMPANY, `${TAG}R`, `${TAG} Empty role`, c.userId]);
    const made = await POS.createPosition(db, c, { roleId: role[0].insertId, positionCode: `${TAG}-1`, status: 'ACTIVE' });
    const H = (await HIRE.startHiring(db, c, made.position.id)).hiring;
    ok(H.terms.designation === `${TAG} Empty role` && H.terms.reportingToTitle === null, 'a position with no title and no manager defaults to the role’s title and no reporting line');

    const [[primaryType]] = await db.query("SELECT id FROM hrms_reporting_relationship_types WHERE company_id = ? AND code = 'PRIMARY_MANAGER' AND deleted_at IS NULL", [COMPANY]);
    const boss = await POS.createPosition(db, c, { roleId: role[0].insertId, positionCode: `${TAG}-0`, status: 'ACTIVE' });
    await POS.addPositionReporting(db, c, made.position.id, { toPositionId: boss.position.id, relationshipTypeId: primaryType.id, isPrimary: true, effectiveFrom: on });
    const bossImpact = await POS.getDeleteImpact(db, COMPANY, boss.position.id);
    const withTeam = await caught(() => POS.deletePosition(db, c, boss.position.id, { mode: 'WITH_TEAM', expect: 2 }));
    ok(bossImpact.outcomes.deleteWithTeam.code === 'HIRING_OPEN' && bossImpact.outcomes.close.code !== 'HIRING_OPEN' && bossImpact.outcomes.deleteOnly.code !== 'HIRING_OPEN' && bossImpact.hiring === null
      && refused(withTeam, 409, 'HIRING_OPEN') && withTeam.detail?.hiringId === H.id && JSON.stringify(withTeam.detail.hiringIds) === JSON.stringify([H.id]) && withTeam.problems.length === 1,
    'a hiring open on a position UNDER it stops "delete with its team" (it is not a blocker of closing or deleting the manager alone)', why(withTeam));
    const notReady = await caught(() => HIRE.confirmJd(db, c, H.id));
    ok(refused(notReady, 422, 'JD_NOT_READY') && notReady.problems.length === 2, 'a role with no purpose AND no KRA: 422 JD_NOT_READY, saying both', why(notReady));
    await db.query('UPDATE hrms_roles SET role_purpose = ? WHERE id = ?', ['To exist for this test.', role[0].insertId]);
    ok((await HIRE.confirmJd(db, c, H.id)).hiring.stage === 'OFFER', 'with a purpose alone it proceeds');
    const made2 = await POS.createPosition(db, c, { roleId: role[0].insertId, positionCode: `${TAG}-2`, status: 'ACTIVE' });
    await db.query("UPDATE hrms_positions SET status = 'CLOSED' WHERE id = ?", [made2.position.id]);
    ok(refused(await caught(() => HIRE.startHiring(db, c, made2.position.id)), 409, 'POSITION_CLOSED'), 'a hiring on a closed position: 409 POSITION_CLOSED');
    ok(refused(await caught(() => HIRE.startHiring(db, c, 999999999)), 404, 'NOT_FOUND'), 'a hiring on a position that does not exist: 404');

    // Settings and templates, written and read back.
    const saved = (await HIRE.updateSettings(db, c, { offerValidDays: 10, jurisdiction: 'Testville' })).settings;
    ok(saved.offerValidDays === 10 && saved.jurisdiction === 'Testville' && (!IS_KARNI || saved.signatoryName === KARNI_SETTINGS.signatory_name), 'PUT /hiring/settings changes only what was sent');
    ok(refused(await caught(() => HIRE.updateSettings(db, c, { probationMonths: -1, offerValidDays: 0 })), 422, 'INVALID'), 'bad settings are refused with every problem');
    const fresh = (await HIRE.startHiring(db, c, vacantRows[1].id)).hiring;
    ok(fresh.terms.offerValidUntil === addDays(on, 10), 'a new hiring uses the new validity');
    const mine = await docx(p(run('Offer for {candidate_name}, ref {ref_no}, pay {anual_ctc}.')));
    const put = await HIRE.putTemplate(db, c, 'offer', { fileName: 'mine.docx', contentBase64: mine.toString('base64') });
    ok(put.template.kind === 'OFFER' && put.template.builtIn === false && put.template.fileName === 'mine.docx'
      && JSON.stringify(put.placeholders) === JSON.stringify(['ref_no', 'candidate_name']) && JSON.stringify(put.unknown) === JSON.stringify(['anual_ctc']),
    'PUT /hiring/templates/:kind stores it and names the placeholders, the unknown one included', JSON.stringify(put));
    const got = await HIRE.readTemplateFile(db, COMPANY, 'OFFER');
    ok(Buffer.compare(Buffer.from(got.contentBase64, 'base64'), mine) === 0 && got.fileName === 'mine.docx', 'GET /hiring/templates/:kind/file returns the bytes that were uploaded');
    await HIRE.confirmJd(db, c, fresh.id);
    await HIRE.updateHiring(db, c, fresh.id, CANDIDATE);
    const withMine = await HIRE.generateOfferLetter(db, c, fresh.id);
    ok(JSON.stringify(withMine.unfilled) === JSON.stringify(['anual_ctc']), 'a letter from it reports the unknown placeholder in `unfilled`', JSON.stringify(withMine.unfilled));
    ok(refused(await caught(() => HIRE.putTemplate(db, c, 'OFFER', { fileName: 'x.docx', contentBase64: Buffer.from('nope').toString('base64') })), 422, 'BAD_TEMPLATE')
      && refused(await caught(() => HIRE.putTemplate(db, c, 'OFFER', { fileName: 'x.pdf', contentBase64: mine.toString('base64') })), 422, 'INVALID')
      && refused(await caught(() => HIRE.putTemplate(db, c, 'MEMO', { fileName: 'x.docx', contentBase64: mine.toString('base64') })), 422, 'INVALID'),
    'a file that is not a .docx, or a kind that is not a letter, is refused');
    ok(HIRE.listPlaceholders().placeholders.length === 25, 'GET /hiring/placeholders lists the 25');
  });
}

/* ══ 8. through the real middleware ═══════════════════════════════════════ */
section('[8] Permissions and the two Code formats screens, over HTTP');
{
  const server = express();
  server.use(express.json({ limit: '50mb' }));
  server.use(cookieParser());
  server.use('/api', appContext);
  hrmsApp.register(server);
  erpApp.register(server);
  // cf_erp's view of the generator (everything that is not hrms_*), mounted where a Karni admin can reach it.
  server.use('/api/:companySlug/cf_hrms/as-erp', createCodegenRouter({ viewPerm: 'cf_hrms_org_view', managePerm: 'cf_hrms_org_manage', entityTypes: (t) => !t.startsWith('hrms_') }));
  const listener = await new Promise((resolve) => { const l = server.listen(0, '127.0.0.1', () => resolve(l)); });
  const base = `http://127.0.0.1:${listener.address().port}/api`;

  const tokenFor = async (where) => {
    const [[u]] = await pool.query(
      `SELECT u.id, u.email, u.company_id, co.slug, r.name AS role FROM users u
         JOIN companies co ON co.id = u.company_id LEFT JOIN roles r ON r.id = u.role_id
        WHERE u.deleted_at IS NULL AND ${where} ORDER BY u.id LIMIT 1`);
    return u ? { ...u, token: signToken({ id: u.id, email: u.email, role: u.role, company: u.slug, companyId: u.company_id, company_id: u.company_id, uiPermissions: [] }) } : null;
  };
  const call = async (who, method, url, body) => {
    const res = await fetch(`${base}${url}`, {
      method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${who.token}` }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); } catch { /* no body */ }
    return { status: res.status, json };
  };

  try {
    const hasApp = (appSlug) => `EXISTS (SELECT 1 FROM app_user_access x JOIN apps a ON a.id = x.app_id WHERE x.user_id = u.id AND x.deleted_at IS NULL AND a.slug = '${appSlug}')`;
    const admin = await tokenFor(`u.company_id = ${COMPANY} AND LOWER(r.name) = 'admin' AND ${hasApp('cf_hrms')}`);
    const employee = await tokenFor(`u.company_id = ${COMPANY} AND r.name = 'Employee' AND ${hasApp('cf_hrms')}`);
    const outsider = await tokenFor(`u.company_id <> ${COMPANY} AND LOWER(r.name) = 'admin' AND ${hasApp('cf_hrms')}`);
    const erpAdmin = await tokenFor(`LOWER(r.name) = 'admin' AND ${hasApp('cf_erp')}`);
    const api = `/${slug}/cf_hrms`;

    const HIRING_ROUTES = [
      ['GET', '/hirings'], ['GET', '/hirings?status=open&positionId=1'], ['GET', '/hirings/1'], ['POST', '/positions/1/hiring', {}],
      ['GET', '/hirings/1/jd/preview'], ['GET', '/hirings/1/jd/file?format=pdf'], ['GET', '/hiring/close-reasons'], ['GET', '/hiring/close-reasons?hiringId=1'],
      ['POST', '/hirings/1/confirm-jd', {}], ['PUT', '/hirings/1', { candidateName: 'x' }], ['POST', '/hirings/1/offer-letter', {}],
      ['POST', '/hirings/1/accept-offer', {}], ['POST', '/hirings/1/appoint', { joiningDate: on }], ['POST', '/hirings/1/close', { reason: 'CANCELLED' }],
      ['GET', '/hirings/1/letters/1/file'], ['GET', '/hirings/1/jd/file'], ['GET', '/hiring/settings'], ['PUT', '/hiring/settings', { offerValidDays: 9 }],
      ['GET', '/hiring/templates'], ['PUT', '/hiring/templates/OFFER', { fileName: 'x.docx', contentBase64: 'eA==' }], ['GET', '/hiring/templates/OFFER/file'],
      ['GET', '/hiring/placeholders'],
    ];
    const CODE_ROUTES = [
      ['GET', '/codegen/entities'], ['GET', '/codegen/schemes'], ['GET', '/codegen/schemes/1'], ['POST', '/codegen/schemes', {}], ['PUT', '/codegen/schemes/1', {}],
      ['DELETE', '/codegen/schemes/1'], ['POST', '/codegen/preview', { entityType: 'hrms_employee' }], ['POST', '/codegen/explain', { entityType: 'hrms_employee' }],
    ];

    if (!employee) skip('an Employee login', 'this company has no Employee-role login with access to the app');
    else {
      const got = [];
      for (const [method, url, body] of [...HIRING_ROUTES, ...CODE_ROUTES]) got.push([method, url, (await call(employee, method, `${api}${url}`, body)).status]);
      const wrong = got.filter(([, , status]) => status !== 403);
      ok(wrong.length === 0, `an Employee login gets 403 from all ${HIRING_ROUTES.length} hiring routes and all ${CODE_ROUTES.length} code-format routes`, wrong.map((x) => x.join(' ')).join('; '));
      ok((await call(employee, 'GET', `${api}/user/me/place`)).status !== 403, 'while their own page is still theirs to open');
    }

    if (!admin) skip('an admin login', 'this company has no admin login with access to the app');
    else {
      const hirings = await call(admin, 'GET', `${api}/hirings?status=open`);
      ok(hirings.status === 200 && Array.isArray(hirings.json.hirings), 'an admin: GET /hirings answers { hirings }');
      ok((await call(admin, 'GET', `${api}/hirings/999999999`)).status === 404 && (await call(admin, 'GET', `${api}/hirings/abc`)).status === 422, 'GET /hirings/:id — 404 for one that does not exist, 422 for an id that is not a number');
      const settings = await call(admin, 'GET', `${api}/hiring/settings`);
      const templates = await call(admin, 'GET', `${api}/hiring/templates`);
      const file = await call(admin, 'GET', `${api}/hiring/templates/offer/file`);
      const holders = await call(admin, 'GET', `${api}/hiring/placeholders`);
      ok(settings.status === 200 && 'companyLegalName' in settings.json.settings && templates.status === 200 && templates.json.templates.length === 2
        && file.status === 200 && Boolean(await JSZip.loadAsync(Buffer.from(file.json.contentBase64, 'base64'))) && holders.json.placeholders.length === 25
        && JSON.stringify(Object.keys(holders.json.placeholders[0])) === JSON.stringify(['key', 'label', 'example']),
      'settings, templates, a template file and the placeholders all answer in the spec’s shapes');
      const missing = await call(admin, 'POST', `${api}/positions/999999999/hiring`, {});
      ok(missing.status === 404 && missing.json.code === 'NOT_FOUND' && typeof missing.json.message === 'string', 'an error is { code, message }', JSON.stringify(missing.json));

      // Code formats, cf_hrms side: its two entity types and nothing else.
      const entities = await call(admin, 'GET', `${api}/codegen/entities`);
      ok(entities.status === 200 && JSON.stringify(entities.json.map((e) => e.entityType).sort()) === JSON.stringify(['hrms_employee', 'hrms_hiring']),
        'cf_hrms Code formats offers exactly hrms_employee and hrms_hiring', JSON.stringify(entities.json.map?.((e) => e.entityType)));
      const emp = entities.json.find((e) => e.entityType === 'hrms_employee');
      const ref = entities.json.find((e) => e.entityType === 'hrms_hiring');
      ok(emp.label === 'Employee codes' && JSON.stringify(emp.tokens.map((t) => t.key)) === JSON.stringify(['department.code', 'department.name', 'location.code', 'location.name', 'role.code',
        'shift.code', 'joining.yy', 'joining.yyyy', 'joining.mm', 'joining.fy', 'employment.type'])
        && JSON.stringify(emp.conditionTokens.map((t) => `${t.key}:${t.operators.join('/')}`)) === JSON.stringify(['department:under/eq/in', 'location:eq/in', 'employment.type:eq/in'])
        && emp.tokens.every((t) => t.label && t.phrase && t.help && t.example), 'hrms_employee: the 11 tokens and 3 condition tokens of the spec, each with label, phrase, help, example');
      ok(ref.label === 'Letter reference numbers' && JSON.stringify(ref.tokens.map((t) => t.key)) === JSON.stringify(['fy', 'yy', 'yyyy', 'mm', 'department.code', 'location.code'])
        && ref.conditionTokens.length === 0 && ref.tokens.every((t) => t.label && t.phrase && t.help && t.example), 'hrms_hiring: its 6 tokens and no conditions');
      const schemes = await call(admin, 'GET', `${api}/codegen/schemes`);
      ok(schemes.status === 200 && schemes.json.every((s) => s.entityType.startsWith('hrms_')) && (!IS_KARNI || schemes.json.length === 2), 'GET /codegen/schemes lists its own rules only', `${schemes.json.length}`);
      ok((await call(admin, 'GET', `${api}/codegen/schemes?entityType=item`)).status === 422
        && (await call(admin, 'POST', `${api}/codegen/preview`, { entityType: 'item', draft: {} })).status === 422
        && (await call(admin, 'POST', `${api}/codegen/explain`, { entityType: 'sales_order' })).status === 422
        && (await call(admin, 'POST', `${api}/codegen/schemes`, { entityType: 'item', code: `${TAG}X`, name: 'x', segments: [{ segmentType: 'sequence' }] })).status === 422,
      'a cf_erp type is unknown here: listing, previewing, explaining or writing one is 422');
      const preview = await call(admin, 'POST', `${api}/codegen/preview`, { entityType: 'hrms_employee', draft: {} });
      ok(preview.status === 200 && (!IS_KARNI || preview.json.text === 'KP0072') && await counterOf(pool, 'hrms_employee') === baselineCounter,
        `the preview shows the shape of the next code and takes no number (${preview.json.text})`);
      const explain = await call(admin, 'POST', `${api}/codegen/explain`, { entityType: 'hrms_hiring', draft: { letterDate: '2026-08-12' }, keys: ['fy', 'mm'] });
      ok(explain.status === 200 && explain.json.values.fy.text === '26-27' && explain.json.values.mm.text === '08', 'explain reads a letter date: fy 26-27, mm 08');

      // …and cf_erp's side: the same tables, none of the hrms rules.
      const [[rule]] = await pool.query("SELECT id FROM cf_code_schemes WHERE company_id = ? AND entity_type = 'hrms_employee' AND deleted_at IS NULL LIMIT 1", [COMPANY]);
      const asErp = `${api}/as-erp`;
      const erpEntities = await call(admin, 'GET', `${asErp}/codegen/entities`);
      ok(erpEntities.status === 200 && erpEntities.json.length > 0 && erpEntities.json.every((e) => !e.entityType.startsWith('hrms_')) && erpEntities.json.some((e) => e.entityType === 'item'),
        'through cf_erp’s filter: its own entity types, and neither hrms type');
      ok((await call(admin, 'GET', `${asErp}/codegen/schemes`)).json.every((s) => !s.entityType.startsWith('hrms_'))
        && (await call(admin, 'GET', `${asErp}/codegen/schemes?entityType=hrms_employee`)).status === 422, 'its rule list has no hrms rule; asking for one by type is 422');
      if (rule) {
        const read = await call(admin, 'GET', `${asErp}/codegen/schemes/${rule.id}`);
        ok(read.status === 404, 'an hrms rule read by id through cf_erp’s filter: 404', `${read.status}`);
        if (read.status === 404) {
          const body = (await call(admin, 'GET', `${api}/codegen/schemes/${rule.id}`)).json;
          const put = await call(admin, 'PUT', `${asErp}/codegen/schemes/${rule.id}`, { ...body, name: 'hijacked' });
          const del = await call(admin, 'DELETE', `${asErp}/codegen/schemes/${rule.id}`);
          const still = (await call(admin, 'GET', `${api}/codegen/schemes/${rule.id}`)).json;
          ok(put.status === 422 && del.status === 404 && still.name === body.name && still.id === rule.id, 'and it can be neither changed nor deleted from there', `${put.status} ${del.status} ${still.name}`);
        }
      } else skip('an hrms rule through cf_erp’s filter', 'this company has no hrms rule');
    }

    if (erpAdmin) {
      const erp = `/${erpAdmin.slug}/cf_erp`;
      const e = await call(erpAdmin, 'GET', `${erp}/codegen/entities`);
      ok(e.status === 200 && e.json.some((x) => x.entityType === 'item') && e.json.every((x) => !x.entityType.startsWith('hrms_')),
        `cf_erp’s REAL mount (${erpAdmin.slug}): its rules screen lists item, sales_order … and no hrms type`, JSON.stringify(e.json.map?.((x) => x.entityType)));
      ok((await call(erpAdmin, 'POST', `${erp}/codegen/preview`, { entityType: 'hrms_employee', draft: {} })).status === 422
        && (await call(erpAdmin, 'GET', `${erp}/codegen/schemes?entityType=item`)).status === 200, 'there an hrms type is unknown (422) and its own types work as before');
    } else skip('cf_erp’s real mount', 'no admin login has access to cf_erp');

    if (outsider) {
      const cross = await call(outsider, 'GET', `${api}/hirings`);
      ok(cross.status === 403, `an admin of another company (${outsider.slug}) on this company’s URL: 403`, `${cross.status}`);
      ok((await call(outsider, 'GET', `${api}/hirings/1/letters/1/file`)).status === 403 && (await call(outsider, 'GET', `${api}/hiring/templates/OFFER/file`)).status === 403,
        'including a letter file and this company’s templates');
    } else skip('another company’s admin', 'no other company has an admin with access to cf_hrms');
    ok((await fetch(`${base}${api}/hirings`)).status === 401, 'no token at all: 401');
  } finally {
    await new Promise((resolve) => listener.close(resolve));
  }
}

/* ══ end: as it was found ═════════════════════════════════════════════════ */
section('[end] The tenant is as it was found');
{
  const after = await rowCounts();
  const moved = WATCHED.filter((t) => after[t] !== baseline[t]).map((t) => `${t} ${baseline[t]} -> ${after[t]}`);
  ok(moved.length === 0, `all ${WATCHED.length} hrms_ and cf_code_ tables hold the rows they started with, live and total`, moved.join('; '));
  const chart = (await buildOrgChart(pool, COMPANY, {})).counts;
  ok(chart.positions === baselineChart.positions && chart.filled === baselineChart.filled && chart.vacant === baselineChart.vacant && chart.hiring === baselineChart.hiring,
    `positions / filled / vacant unchanged (${chart.positions} / ${chart.filled} / ${chart.vacant}), open hirings unchanged (${chart.hiring})`);
  if (IS_KARNI) {
    ok(chart.positions === 220 && chart.filled === 71 && chart.vacant === 149, 'Karni: 220 positions, 71 filled, 149 vacant');
    const [[n]] = await pool.query('SELECT (SELECT COUNT(*) FROM hrms_employees WHERE company_id = ? AND deleted_at IS NULL) AS employees, (SELECT COUNT(*) FROM hrms_hirings WHERE company_id = ?) AS hirings', [COMPANY, COMPANY]);
    ok(Number(n.employees) === 71 && Number(n.hirings) === baselineHirings, `Karni: 71 employees, and no hiring left by this run (${baselineHirings} were there when it began)`, JSON.stringify(n));
    if (baselineHirings) console.log(`        note: ${baselineHirings} hiring row(s) existed in this company BEFORE the run began — not made by this file.`);
    await rolledBack(async (db) => {
      const next = await CODES.issueEmployeeCode(db, COMPANY, {});
      const ref = await CODES.issueHiringRef(db, COMPANY, { letterDate: on });
      ok(next === 'KP0072' && ref === `KPPL/HR/${FY}/${String(baselineRefCounter ?? 1).padStart(3, '0')}`, `the next real employee code is still KP0072, the next reference ${ref}`, `${next} ${ref}`);
    });
  }
  ok(await counterOf(pool, 'hrms_employee') === baselineCounter && await counterOf(pool, 'hrms_hiring') === baselineRefCounter, 'both counters are where they were');
}

console.log(`\n${passed} passed, ${failed.length} failed, ${skipped.length} skipped`);
if (skipped.length) for (const s of skipped) console.log(`  skipped — ${s}`);
if (failed.length) { console.log('\nFAILED:'); for (const f of failed) console.log(`  - ${f}`); }
await pool.end();
process.exit(failed.length ? 1 : 0);
