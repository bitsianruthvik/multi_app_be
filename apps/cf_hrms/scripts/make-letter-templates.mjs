/**
 * make-letter-templates.mjs — turns Karni's two FILLED letters into templates.
 * (TM/CF_HRMS_HIRING_SPEC.md §2.3.)
 *
 *   node make-letter-templates.mjs                                  build + verify the two files
 *   node make-letter-templates.mjs --company=karni                  ... and say what would be stored  (DRY RUN)
 *   node make-letter-templates.mjs --company=karni --apply          ... and store them, and the hiring settings
 *   node make-letter-templates.mjs --company=karni --apply --target=prod
 *
 * IN   TM/hr_letter_formats/Offer_Letter_Final.docx, Appointment_Letter_Final.docx
 * OUT  TM/hr_letter_formats/templates/karni_offer.docx, karni_appointment.docx
 *
 * THE SOURCES ARE REAL LETTERS TO A REAL PERSON. Their name, phone, address
 * and pay, and the name of the person they report to, are in those files — and
 * NOWHERE IN THIS ONE. Nothing personal is written here, in a comment or a
 * constant: every value is found in the document when the script runs, by the
 * wording around it ("To,", "Dear", the row labelled "Designation"), and is
 * replaced by a placeholder. The script never prints one either; it prints
 * counts and placeholder names.
 *
 * WHAT CHANGES, AND WHAT DOES NOT
 *   - every personal value, and every value that differs from one hiring to
 *     the next (reference, dates, designation, department, terms, signatory),
 *     becomes a placeholder services/letterRenderer.js fills;
 *   - the address, two paragraphs in the source, becomes ONE placeholder that
 *     prints on as many lines as were typed;
 *   - the Annexure-A picture — a salary sheet — is removed from the document,
 *     its relationship is removed, and the image file is removed from the
 *     package when nothing else uses it. In its place: "Compensation structure
 *     attached separately." The heading and the notes under it stay;
 *   - everything else is untouched: the wording, the numbering, the styles,
 *     and the letterhead in the header and footer with its images.
 *
 * IT PROVES ITS OWN OUTPUT, EVERY RUN, and exits 1 if anything fails:
 *   - the template opens as a zip and every XML part in it is well-formed;
 *   - every placeholder the letter should carry is there, whole, in one run;
 *   - no personal value of the source is anywhere in the package — not in the
 *     text, not in an attribute, not in the document properties;
 *   - no date and no reference number of the source letter is left in the text;
 *   - the body has no picture, the Annexure image is not in the package (by
 *     name and by content hash), and every letterhead image still is.
 * The values it checks for are read from the SOURCE at that moment.
 *
 * A source the script cannot read the way it expects (a label it relies on is
 * missing, a date it cannot place) stops it with a message. It never guesses.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath, pathToFileURL } from 'url';
import JSZip from 'jszip';
import saxes from 'saxes';
import mysql from 'mysql2/promise';
import { resolveTarget, announce } from './dbTarget.mjs';
import { scanParagraphs, replaceRanges, decodeXml, encodeXml } from '../services/docxText.js';
import { inspectTemplate } from '../services/letterRenderer.js';
import { packForStorage, MAX_DOCUMENT_STORED_BYTES } from '../services/documentStorage.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TM_ROOT = path.resolve(HERE, '../../../..');
export const FORMATS_DIR = path.join(TM_ROOT, 'hr_letter_formats');
export const TEMPLATES_DIR = path.join(FORMATS_DIR, 'templates');

export const LETTERS = {
  OFFER: { source: 'Offer_Letter_Final.docx', template: 'karni_offer.docx' },
  APPOINTMENT: { source: 'Appointment_Letter_Final.docx', template: 'karni_appointment.docx' },
};

/** What each template must carry once made. A letter uses what it needs (spec §2.3). */
export const EXPECTED = {
  OFFER: ['ref_no', 'letter_date', 'salutation', 'candidate_name', 'candidate_phone', 'candidate_address',
    'designation', 'department', 'reporting_to_title', 'place_of_posting', 'joining_date', 'offer_valid_until',
    'annual_ctc', 'probation_months_words', 'company_name', 'signatory_name', 'signatory_designation'],
  APPOINTMENT: ['ref_no', 'letter_date', 'salutation', 'candidate_name', 'candidate_phone', 'candidate_address',
    'designation', 'joining_date', 'place_of_posting', 'probation_months_words', 'notice_days_probation_words',
    'notice_days_confirmed_words', 'reporting_to_name', 'jurisdiction', 'company_name', 'signatory_name',
    'signatory_designation', 'employee_code'],
};

/** The company's own values, given by the spec — not the candidate's. Stored with --apply. */
export const KARNI_SETTINGS = {
  company_legal_name: 'Karni Packaging Private Limited',
  signatory_name: 'Ramakrishna',
  signatory_designation: 'HR- Head',
  place_of_posting: 'Unit-2, Bibi Nagar, Hyderabad',
  jurisdiction: 'Hyderabad, Telangana',
  probation_months: 3,
  notice_days_probation: 15,
  notice_days_confirmed: 30,
  offer_valid_days: 7,
};

const ANNEXURE_LINE = 'Compensation structure attached separately.';

const MONTH = '(?:January|February|March|April|May|June|July|August|September|October|November|December)';
const DATE_SRC = `\\d{1,2}\\s*(?:st|nd|rd|th)?\\s+${MONTH},?\\s+\\d{4}`;
const REF_SRC = '[A-Z]{2,}(?:\\/[A-Za-z0-9-]+)+\\/\\d+';
const SALUTATION_SRC = '(?:Mr|Mrs|Ms|Miss|Dr|Shri|Smt|Sri|Kum)\\.?';
const COUNT_SRC = '[A-Za-z-]+\\s*\\(\\s*\\d+\\s*\\)';

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A phrase as a pattern that survives Word's spacing: any run of spaces between its words. */
const phraseSrc = (s) => s.trim().split(/\s+/).map(esc).join('\\s+');
const norm = (s) => String(s).replace(/\s+/g, ' ').trim();
/**
 * Writes a part back with the date it had and without adding folder entries
 * (JSZip dates those "now"), so the same source always gives the same bytes —
 * which is how a second --apply can tell there is nothing new to store.
 */
const rewrite = (zip, name, content) => zip.file(name, content, { date: zip.files[name].date, createFolders: false });
const stop = (message) => { const e = new Error(message); e.expected = true; return e; };

/* ══════════════════════════════════════════════════════════════════════════
 * Reading the source: what is personal, and where it sits
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * The letter's variable values, found by the wording around them.
 * `personal` is the subset that identifies the candidate or another person —
 * what must not survive into the template.
 */
function readSource(kind, paragraphs) {
  const text = (i) => norm(paragraphs[i]?.text ?? '');
  const find = (re, from = 0) => { for (let i = from; i < paragraphs.length; i += 1) if (re.test(text(i))) return i; return -1; };
  const nextFilled = (i) => { for (let j = i + 1; j < paragraphs.length; j += 1) if (text(j)) return j; return -1; };

  const iTo = find(/^To\s*,/);
  if (iTo < 0) throw stop(`${kind}: no "To," line — this is not the letter this script was written for.`);
  const iDear = find(/^Dear\b/, iTo + 1);
  if (iDear < 0) throw stop(`${kind}: no "Dear" line after the address.`);

  // "To," and the name share a paragraph (a line break between them) or the name is the next one.
  let iName = iTo;
  let addressee = text(iTo).replace(/^To\s*,\s*/, '');
  if (!addressee) { iName = nextFilled(iTo); addressee = text(iName); }
  const sal = new RegExp(`^(${SALUTATION_SRC})\\s+`).exec(addressee);
  const salutation = sal ? sal[1] : '';
  const name = norm(addressee.slice(sal ? sal[0].length : 0));
  if (!name) throw stop(`${kind}: could not read the addressee.`);

  let iPhone = -1;
  const iAddress = [];
  for (let i = iName + 1; i < iDear; i += 1) {
    if (!text(i)) continue;
    if (iPhone < 0 && /^[+\d][\d\s-]{6,}$/.test(text(i))) iPhone = i; else iAddress.push(i);
  }
  if (iPhone < 0) throw stop(`${kind}: no phone number between the name and "Dear".`);
  if (!iAddress.length) throw stop(`${kind}: no address between the name and "Dear".`);

  const iFor = find(/^For\s+\S/, iDear);
  if (iFor < 0) throw stop(`${kind}: no "For <company>" line.`);
  const company = text(iFor).replace(/^For\s+/, '');

  const labelled = (label) => {
    const i = paragraphs.findIndex((p, k) => text(k).toLowerCase() === label.toLowerCase());
    return i < 0 ? -1 : nextFilled(i);
  };
  const reportTo = /report to (.+?) or such other/.exec(paragraphs.map((p, i) => text(i)).find((t) => /report to .+ or such other/.test(t)) ?? '');
  const iCtc = labelled('Annual Cost to Company (CTC)');

  return {
    iTo, iName, iDear, iPhone, iAddress, iFor,
    salutation, name, company,
    phone: text(iPhone),
    addressLines: iAddress.map(text),
    ctc: iCtc >= 0 ? text(iCtc) : null,
    managerName: reportTo ? norm(reportTo[1]) : null,
  };
}

/** The values of a source letter that identify a person. Read at run time; never stored. */
export async function personalValuesOf(kind, sourceBuffer) {
  const zip = await JSZip.loadAsync(sourceBuffer);
  const src = readSource(kind, scanParagraphs(await zip.file('word/document.xml').async('string')));
  return {
    name: src.name, phone: src.phone, addressLines: src.addressLines, ctc: src.ctc, managerName: src.managerName,
  };
}

/* ══════════════════════════════════════════════════════════════════════════
 * Making the template
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * @returns {{ buffer: Buffer, facts: object, removed: { relationshipId, target, sha256 } | null, replaced: Record<string, number> }}
 *   `facts` are non-personal readings (designation spellings, whether dates agree) for the report.
 */
export async function makeTemplate(kind, sourceBuffer) {
  const zip = await JSZip.loadAsync(sourceBuffer);
  let xml = await zip.file('word/document.xml').async('string');
  let paragraphs = scanParagraphs(xml);
  const src = readSource(kind, paragraphs);
  const text = (i) => paragraphs[i]?.text ?? '';
  const flat = (i) => norm(text(i));

  const edits = [];
  const replaced = {};
  const put = (i, start, end, key, literal = null) => {
    edits.push({ paragraph: paragraphs[i], index: i, start, end, text: literal ?? `{${key}}` });
    if (key) replaced[key] = (replaced[key] ?? 0) + 1;
  };
  /** Replaces what `re` captures in paragraph i (group 1, or the whole match). All matches when the pattern is global. */
  const swap = (i, re, key, literal = null) => {
    let n = 0;
    const flags = re.flags.includes('d') ? re.flags : `${re.flags}d`;
    const all = flags.includes('g') ? [...text(i).matchAll(new RegExp(re.source, flags))] : [new RegExp(re.source, flags).exec(text(i))].filter(Boolean);
    for (const m of all) {
      const [start, end] = m.indices[1] ?? m.indices[0];
      put(i, start, end, key, literal);
      n += 1;
    }
    return n;
  };
  const whole = (i, key) => put(i, 0, text(i).length, key);
  const must = (n, what) => { if (!n) throw stop(`${kind}: could not find ${what}.`); };
  const labelValue = (label) => {
    const i = paragraphs.findIndex((p, k) => flat(k).toLowerCase() === label.toLowerCase());
    if (i < 0) return -1;
    for (let j = i + 1; j < paragraphs.length; j += 1) if (flat(j)) return j;
    return -1;
  };

  const facts = { designations: [], dearEndsWithComma: /,\s*$/.test(flat(src.iDear)) };

  // ── the reference line ────────────────────────────────────────────────────
  const iRef = paragraphs.findIndex((p, i) => /^Ref\s*No/i.test(flat(i)));
  must(iRef >= 0 ? 1 : 0, 'the "Ref No" line');
  const refRe = new RegExp(REF_SRC);
  const dateRe = new RegExp(DATE_SRC);
  facts.refNo = refRe.exec(text(iRef))?.[0] ?? null;
  facts.letterDate = norm(dateRe.exec(text(iRef))?.[0] ?? '');
  must(swap(iRef, refRe, 'ref_no'), 'the reference number');
  must(swap(iRef, dateRe, 'letter_date'), 'the letter date');

  // ── the addressee ─────────────────────────────────────────────────────────
  const named = new RegExp(`(?:${SALUTATION_SRC}\\s+)?${phraseSrc(src.name)}`, 'g');
  const person = '{salutation} {candidate_name}';
  let names = 0;
  for (let i = 0; i < paragraphs.length; i += 1) {
    if (i === src.iPhone || src.iAddress.includes(i)) continue;
    names += swap(i, named, null, person);
  }
  replaced.salutation = replaced.candidate_name = names;
  must(names >= 2 ? 1 : 0, 'the candidate’s name in both the address and the greeting');
  whole(src.iPhone, 'candidate_phone');
  whole(src.iAddress[0], 'candidate_address');

  // ── the company ───────────────────────────────────────────────────────────
  const companyRe = new RegExp(phraseSrc(src.company), 'g');
  let companies = 0;
  for (let i = 0; i < paragraphs.length; i += 1) companies += swap(i, companyRe, 'company_name');
  must(companies, 'the company name');

  // ── the signatory: the first "Name:" and "Designation:" after "For <company>" ──
  const after = (re) => { for (let i = src.iFor + 1; i < paragraphs.length; i += 1) if (re.test(text(i))) return i; return -1; };
  const iSigName = after(/^\s*Name:\s*\S/);
  const iSigRole = after(/^\s*Designation:\s*\S/);
  must(iSigName >= 0 && swap(iSigName, /^\s*Name:\s*(.+?)\s*(?=Name:|$)/, 'signatory_name'), 'the signatory’s name');
  must(iSigRole >= 0 && swap(iSigRole, /^\s*Designation:\s*(.+?)\s*(?=Date:|$)/, 'signatory_designation'), 'the signatory’s designation');

  // ── the rows of the particulars table (the offer) ─────────────────────────
  const row = (label, key, { required = true } = {}) => {
    const i = labelValue(label);
    if (i < 0) { if (required) throw stop(`${kind}: no "${label}" row.`); return -1; }
    if (key === 'designation') facts.designations.push(flat(i));
    whole(i, key);
    return i;
  };
  let iJoiningRow = -1;
  if (kind === 'OFFER') {
    row('Designation', 'designation');
    row('Department', 'department');
    row('Reporting To', 'reporting_to_title');
    row('Place of Posting', 'place_of_posting');
    iJoiningRow = row('Proposed Date of joining', 'joining_date');
    facts.joiningDate = flat(iJoiningRow);
    row('Annual Cost to Company (CTC)', 'annual_ctc');
  }

  // ── the sentences ─────────────────────────────────────────────────────────
  const sentence = (re, key, what, { required = true, note = null } = {}) => {
    const i = paragraphs.findIndex((p, k) => new RegExp(re.source, re.flags.replace(/[gd]/g, '')).test(text(k)));
    if (i < 0) { if (required) throw stop(`${kind}: could not find ${what}.`); return -1; }
    if (note) note(new RegExp(re.source).exec(text(i)));
    must(swap(i, re, key), what);
    return i;
  };
  const countRe = (lead) => new RegExp(`${lead}(${COUNT_SRC})`);

  if (kind === 'OFFER') {
    sentence(/for the position of\s+(.+?)\s*\.?\s*$/, 'designation', 'the designation in the opening sentence',
      { note: (m) => facts.designations.push(norm(m[1])) });
    sentence(new RegExp(`valid until\\s+(${DATE_SRC})`), 'offer_valid_until', 'the date the offer is valid until');
  } else {
    sentence(/appoint you as\s+(.+?)\s+governed by/, 'designation', 'the designation in the opening sentence',
      { note: (m) => facts.designations.push(norm(m[1])) });
    // The source letter prints no employee code. The user asked for the line (2026-10-11): it follows the
    // joining date in the same paragraph, so the letterhead and every other sentence stay as they are.
    {
      const joinRe = new RegExp(`effective from\\s+(${DATE_SRC})`);
      const i = paragraphs.findIndex((p, k) => joinRe.test(text(k)));
      must(i >= 0 ? 1 : 0, 'the date of joining');
      facts.joiningDate = norm(joinRe.exec(text(i))[1]);
      must(swap(i, joinRe, 'joining_date', '{joining_date}. Your Employee Code is {employee_code}'), 'the date of joining');
      replaced.employee_code = 1;
    }
    sentence(/facility at\s+(.+?)\s*\.\s*$/, 'place_of_posting', 'the place of posting');
    sentence(countRe('^\\s*During the probation period.*?providing\\s+'), 'notice_days_probation_words', 'the notice period during probation',
      { note: (m) => { facts.noticeProbation = norm(m[1]); } });
    sentence(countRe('^\\s*Upon confirmation.*?providing\\s+'), 'notice_days_confirmed_words', 'the notice period after confirmation',
      { note: (m) => { facts.noticeConfirmed = norm(m[1]); } });
    sentence(/report to\s+(.+?)\s+or such other/, 'reporting_to_name', 'who the person reports to');
    sentence(/courts at\s+(.+?)\s*\.\s*$/, 'jurisdiction', 'the jurisdiction');
  }
  sentence(new RegExp(`period of\\s+(${COUNT_SRC})\\s*months`), 'probation_months_words', 'the probation period',
    { note: (m) => { facts.probation = norm(m[1]); } });

  // A date this script did not place is a date it does not understand.
  const placed = new Set(edits.map((e) => e.index));
  for (let i = 0; i < paragraphs.length; i += 1) {
    if (dateRe.test(text(i)) && !placed.has(i)) throw stop(`${kind}: paragraph ${i + 1} holds a date this script does not know how to place.`);
  }

  // No two replacements may run into each other.
  const editsOf = new Map();
  for (const e of edits) editsOf.set(e.index, [...(editsOf.get(e.index) ?? []), e]);
  for (const list of editsOf.values()) {
    list.sort((a, b) => a.start - b.start);
    for (let k = 1; k < list.length; k += 1) {
      if (list[k].start < list[k - 1].end) throw stop(`${kind}: two replacements overlap in paragraph ${list[k].index + 1}.`);
    }
  }
  xml = replaceRanges(xml, edits);

  // ── whole paragraphs: the rest of the address goes; the Annexure picture goes ──
  paragraphs = scanParagraphs(xml);       // same paragraphs, new offsets
  const cuts = src.iAddress.slice(1).map((i) => ({ start: paragraphs[i].start, end: paragraphs[i].end, xml: '' }));

  let removed = null;
  const pictures = paragraphs.map((p, i) => ({ p, i, xml: xml.slice(p.start, p.end) })).filter((x) => /<w:drawing[\s>]|<w:pict[\s>]/.test(x.xml));
  if (pictures.length) {
    const iAnnexure = paragraphs.findIndex((p) => /^ANNEXURE\b/i.test(norm(p.text)));
    if (pictures.length !== 1 || iAnnexure < 0 || pictures[0].i < iAnnexure) {
      throw stop(`${kind}: the body holds ${pictures.length} picture(s) and they are not one picture under an ANNEXURE heading. Nothing was guessed.`);
    }
    const pic = pictures[0];
    if (/<w:sectPr[\s>]/.test(pic.xml)) throw stop(`${kind}: the paragraph holding the Annexure picture also carries section settings. Nothing was guessed.`);
    const ids = [...pic.xml.matchAll(/r:(?:embed|id|link|pict)="([^"]+)"/g)].map((m) => m[1]);
    if (ids.length !== 1) throw stop(`${kind}: the Annexure picture references ${ids.length} relationships, expected one.`);
    // The words take the look of the sentence that points at the Annexure.
    const model = paragraphs.find((p) => /Annexure-A attached/i.test(p.text)) ?? paragraphs.find((p) => p.nodes.length && norm(p.text).length > 40);
    const rPr = model ? /<w:rPr>[\s\S]*?<\/w:rPr>/.exec(xml.slice(model.start, model.end))?.[0] ?? '' : '';
    cuts.push({
      start: pic.p.start, end: pic.p.end,
      xml: `<w:p><w:r>${rPr}<w:t xml:space="preserve">${encodeXml(ANNEXURE_LINE)}</w:t></w:r></w:p>`,
    });
    removed = { relationshipId: ids[0] };
  }
  for (const c of cuts.sort((a, b) => b.start - a.start)) xml = xml.slice(0, c.start) + c.xml + xml.slice(c.end);
  rewrite(zip, 'word/document.xml', xml);

  // ── the picture's relationship, and its file when nothing else uses it ────
  if (removed) {
    const relsName = 'word/_rels/document.xml.rels';
    const rels = await zip.file(relsName).async('string');
    const relRe = new RegExp(`<Relationship\\b[^>]*\\bId="${esc(removed.relationshipId)}"[^>]*/>`);
    const rel = relRe.exec(rels)?.[0];
    if (!rel || !/relationships\/image"/.test(rel)) throw stop(`${kind}: relationship ${removed.relationshipId} is not an image.`);
    if (new RegExp(`"${esc(removed.relationshipId)}"`).test(xml)) throw stop(`${kind}: the body still refers to ${removed.relationshipId}.`);
    const target = path.posix.normalize(path.posix.join('word', /Target="([^"]+)"/.exec(rel)[1]));
    rewrite(zip, relsName, rels.replace(rel, ''));
    removed.target = target;
    removed.sha256 = crypto.createHash('sha256').update(await zip.file(target).async('nodebuffer')).digest('hex');

    // Who else points at that file? Every relationships part in the package is read.
    let users = 0;
    for (const name of Object.keys(zip.files).filter((n) => /_rels\/[^/]+\.rels$/.test(n))) {
      const base = path.posix.dirname(path.posix.dirname(name));
      const body = await zip.file(name).async('string');
      for (const m of body.matchAll(/<Relationship\b[^>]*>/g)) {
        if (/TargetMode="External"/.test(m[0])) continue;
        const t = /Target="([^"]+)"/.exec(m[0])?.[1];
        if (t && path.posix.normalize(t.startsWith('/') ? t.slice(1) : path.posix.join(base, t)) === target) users += 1;
      }
    }
    removed.stillUsed = users > 0;
    if (!users) zip.remove(target);
  }

  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } });
  return { buffer, facts, removed, replaced, source: src };
}

/* ══════════════════════════════════════════════════════════════════════════
 * Proving it
 * ══════════════════════════════════════════════════════════════════════════ */

function wellFormed(xml) {
  const parser = new saxes.SaxesParser({ xmlns: false });
  let error = null;
  parser.on('error', (e) => { error ??= e; });
  try { parser.write(xml).close(); } catch (e) { error ??= e; }
  return error ? String(error.message).split('\n')[0] : null;
}

/** Every string that, if found in the template, means a person's details survived. Regexes; none is printed. */
function personalPatterns(personal) {
  const out = [];
  const word = (w) => new RegExp(`(?<![A-Za-z])${esc(w)}(?![A-Za-z])`, 'i');
  const phrase = (s) => new RegExp(phraseSrc(s), 'i');
  for (const n of [personal.name, personal.managerName].filter(Boolean)) {
    out.push({ what: 'a person’s name', re: phrase(n) });
    for (const w of n.split(/\s+/).filter((x) => x.replace(/\W/g, '').length >= 3)) out.push({ what: 'part of a person’s name', re: word(w) });
  }
  if (personal.phone) {
    out.push({ what: 'the phone number', re: phrase(personal.phone) });
    const digits = personal.phone.replace(/\D/g, '');
    if (digits.length >= 7) out.push({ what: 'the phone number', re: new RegExp(digits.split('').join('[\\s-]?')) });
  }
  for (const line of personal.addressLines ?? []) {
    out.push({ what: 'an address line', re: phrase(line) });
    for (const part of line.split(',').map((s) => s.replace(/[.\s]+$/, '').trim()).filter((s) => s.length >= 4)) {
      out.push({ what: 'part of the address', re: phrase(part) });
    }
  }
  if (personal.ctc) {
    out.push({ what: 'the pay', re: phrase(personal.ctc) });
    const digits = personal.ctc.replace(/\D/g, '');
    if (digits.length >= 4) out.push({ what: 'the pay', re: new RegExp(`(?<!\\d)${digits}(?!\\d)`), textOnly: true });
  }
  return out;
}

/**
 * Everything the header of this file promises about a template.
 *
 * @param personal        from personalValuesOf(source) — both letters' values may be merged
 * @param sourceBuffer    the filled letter it was made from
 * @returns {string[]}    what is wrong; empty means proven. Never contains a personal value.
 */
export async function verifyTemplate(kind, templateBuffer, personal, sourceBuffer) {
  const problems = [];
  let zip;
  try { zip = await JSZip.loadAsync(templateBuffer); } catch { return ['the template does not open as a zip']; }
  const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir);
  if (!zip.file('word/document.xml')) return ['the template has no word/document.xml'];
  if (!zip.file('[Content_Types].xml')) problems.push('the package has no [Content_Types].xml');

  // 1. well-formed, every XML part
  const xmlParts = names.filter((n) => /\.(xml|rels)$/i.test(n));
  const content = new Map();
  for (const n of xmlParts) {
    const body = await zip.file(n).async('string');
    content.set(n, body);
    const bad = wellFormed(body);
    if (bad) problems.push(`${n} is not well-formed XML (${bad})`);
  }
  const doc = content.get('word/document.xml');

  // 2. every placeholder it should carry, whole in one <w:t>, and nothing it should not
  const runs = [...doc.matchAll(/<w:t(?=[\s>])[^>]*>([\s\S]*?)<\/w:t>/g)].map((m) => decodeXml(m[1]));
  for (const key of EXPECTED[kind]) {
    if (!runs.some((r) => r.includes(`{${key}}`))) problems.push(`{${key}} is missing, or split across runs`);
  }
  const { placeholders, unknown } = await inspectTemplate(templateBuffer);
  const extra = placeholders.filter((k) => !EXPECTED[kind].includes(k));
  if (extra.length) problems.push(`unexpected placeholders: ${extra.join(', ')}`);
  if (unknown.length) problems.push(`unknown placeholders: ${unknown.join(', ')}`);

  // 3. nothing personal, anywhere: the text a reader sees, and the raw XML (attributes, properties)
  const patterns = personalPatterns(personal);
  for (const [n, body] of content) {
    const seen = norm(decodeXml(body.replace(/<[^>]+>/g, ' ')));
    const joined = decodeXml(body.replace(/<[^>]+>/g, ''));     // a word Word split across runs
    for (const { what, re, textOnly } of patterns) {
      if (re.test(seen) || re.test(joined) || (!textOnly && re.test(body))) problems.push(`${what} is still in ${n}`);
    }
  }

  // 4. no date and no reference number left in the body text
  const bodyText = scanParagraphs(doc).map((p) => norm(p.text)).join('\n');
  if (new RegExp(DATE_SRC).test(bodyText)) problems.push('a date of the source letter is still in the text');
  if (new RegExp(REF_SRC).test(bodyText)) problems.push('a reference number of the source letter is still in the text');

  // 5. the body holds no picture and no image relationship; the letterhead still has all of its own
  if (/<w:drawing[\s>]|<w:pict[\s>]|<pic:pic[\s>]|<v:imagedata[\s>]/.test(doc)) problems.push('the body still holds a picture');
  const docRels = content.get('word/_rels/document.xml.rels') ?? '';
  if (/relationships\/image"/.test(docRels)) problems.push('the body still has an image relationship');
  for (const m of doc.matchAll(/r:(?:embed|id|link)="([^"]+)"/g)) {
    if (!new RegExp(`Id="${esc(m[1])}"`).test(docRels)) problems.push(`the body refers to ${m[1]}, which has no relationship`);
  }

  const source = await JSZip.loadAsync(sourceBuffer);
  const sourceRels = await source.file('word/_rels/document.xml.rels').async('string');
  const sha = async (z, n) => crypto.createHash('sha256').update(await z.file(n).async('nodebuffer')).digest('hex');
  const templateHashes = new Set();
  for (const n of names.filter((x) => x.startsWith('word/media/'))) templateHashes.add(await sha(zip, n));
  // every image the source BODY used must be gone, by name and by content
  for (const m of sourceRels.matchAll(/<Relationship\b[^>]*relationships\/image"[^>]*>/g)) {
    const target = path.posix.normalize(path.posix.join('word', /Target="([^"]+)"/.exec(m[0])[1]));
    if (zip.file(target)) problems.push(`the Annexure image file is still in the package (${path.posix.basename(target)})`);
    if (templateHashes.has(await sha(source, target))) problems.push('the Annexure image is still in the package under another name');
  }
  // every image the header and footer use must still be there, unchanged
  for (const relsName of Object.keys(source.files).filter((n) => /word\/_rels\/(header|footer)\d*\.xml\.rels$/.test(n))) {
    const now = content.get(relsName);
    const then = await source.file(relsName).async('string');
    if (now !== then) problems.push(`${relsName} changed`);
    for (const m of then.matchAll(/<Relationship\b[^>]*relationships\/image"[^>]*>/g)) {
      const target = path.posix.normalize(path.posix.join('word', /Target="([^"]+)"/.exec(m[0])[1]));
      if (!zip.file(target)) problems.push(`a letterhead image is missing (${path.posix.basename(target)})`);
      else if ((await sha(zip, target)) !== (await sha(source, target))) problems.push(`a letterhead image changed (${path.posix.basename(target)})`);
    }
  }
  for (const part of Object.keys(source.files).filter((n) => /^word\/(header|footer)\d*\.xml$/.test(n))) {
    if (content.get(part) !== await source.file(part).async('string')) problems.push(`${part} changed`);
  }
  // nothing in the package is orphaned media
  const allRels = [...content].filter(([n]) => n.endsWith('.rels')).map(([, b]) => b).join('\n');
  for (const n of names.filter((x) => x.startsWith('word/media/'))) {
    if (!allRels.includes(`media/${path.posix.basename(n)}"`)) problems.push(`${path.posix.basename(n)} is in the package and nothing uses it`);
  }
  return problems;
}

/* ══════════════════════════════════════════════════════════════════════════
 * What the two letters disagree about (for the person running this)
 * ══════════════════════════════════════════════════════════════════════════ */

function inconsistencies(made) {
  const out = [];
  const o = made.OFFER.facts;
  const a = made.APPOINTMENT.facts;
  const spellings = [...new Set([...o.designations, ...a.designations])];
  if (spellings.length > 1) out.push(`The designation is written ${spellings.length} ways: ${spellings.map((s) => `"${s}"`).join(', ')}. The templates print {designation} everywhere.`);
  if (o.dearEndsWithComma !== a.dearEndsWithComma) out.push('The greeting ends with a comma in the offer letter and without one in the appointment letter. Left as each letter has it.');
  if (o.refNo && a.refNo) out.push(o.refNo === a.refNo ? 'Both letters carry the same reference number, as the hiring flow does.' : 'The two letters carry different reference numbers; the hiring flow gives both the same one.');
  if (o.letterDate && a.letterDate && o.letterDate === a.letterDate) out.push('Both letters carry the same date. The flow dates the offer letter and the appointment letter separately.');
  if (o.joiningDate && a.joiningDate && o.joiningDate !== a.joiningDate) out.push('The joining date differs between the two letters.');
  out.push('The offer letter names who the person reports to by TITLE ({reporting_to_title}); the appointment letter names a PERSON ({reporting_to_name}).');
  out.push('The offer letter states the department and the annual CTC; the appointment letter states neither (pay is in the Annexure).');
  if (a.probation && a.noticeProbation && /^[a-z]/.test(a.probation) && /^[A-Z]/.test(a.noticeProbation)) {
    out.push(`Probation is in lower case ("${a.probation}") and the notice periods start with a capital ("${a.noticeProbation}", "${a.noticeConfirmed}"). The templates keep that.`);
  }
  out.push('Neither source letter prints an employee code. The appointment template adds "Your Employee Code is {employee_code}." after the joining date (asked for by the user, 2026-10-11).');
  return out;
}

/* ══════════════════════════════════════════════════════════════════════════
 * Storing
 * ══════════════════════════════════════════════════════════════════════════ */

async function store(conn, company, kind, fileName, buffer, apply) {
  const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
  const packed = await packForStorage(buffer, MAX_DOCUMENT_STORED_BYTES, 'letter template');
  const [[current]] = await conn.query(
    `SELECT id, content, compression FROM hrms_letter_templates
      WHERE company_id = ? AND kind = ? AND is_current = 1 AND deleted_at IS NULL`,
    [company.id, kind],
  );
  if (current?.content && sha(current.content) === sha(packed.content)) return 'already stored, unchanged';
  if (!apply) return current ? 'would replace the current template' : 'would be stored';
  if (current) await conn.query('UPDATE hrms_letter_templates SET is_current = 0 WHERE company_id = ? AND id = ?', [company.id, current.id]);
  await conn.query(
    `INSERT INTO hrms_letter_templates (company_id, kind, file_name, size_bytes, storage, compression, content, is_current)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
    [company.id, kind, fileName, packed.sizeBytes, packed.storage, packed.compression, packed.content],
  );
  return current ? 'stored, replacing the previous template' : 'stored';
}

async function storeSettings(conn, company, apply) {
  const [[row]] = await conn.query('SELECT * FROM hrms_hiring_settings WHERE company_id = ?', [company.id]);
  const keys = Object.keys(KARNI_SETTINGS);
  if (row && keys.every((k) => String(row[k] ?? '') === String(KARNI_SETTINGS[k]))) return 'already set, unchanged';
  if (!apply) return row ? 'would be updated' : 'would be created';
  if (row) {
    await conn.query(`UPDATE hrms_hiring_settings SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE company_id = ?`,
      [...keys.map((k) => KARNI_SETTINGS[k]), company.id]);
    return 'updated';
  }
  await conn.query(`INSERT INTO hrms_hiring_settings (company_id, ${keys.join(', ')}) VALUES (?, ${keys.map(() => '?').join(', ')})`,
    [company.id, ...keys.map((k) => KARNI_SETTINGS[k])]);
  return 'created';
}

/* ══════════════════════════════════════════════════════════════════════════ */

/** Builds both templates from the sources on disk and proves them. Throws with what failed. */
export async function buildAndVerify() {
  const made = {};
  const personal = { name: null, managerName: null, phone: null, addressLines: [], ctc: null };
  const sources = {};
  for (const [kind, f] of Object.entries(LETTERS)) {
    const file = path.join(FORMATS_DIR, f.source);
    if (!fs.existsSync(file)) throw stop(`The source letter is not there: ${file}`);
    sources[kind] = fs.readFileSync(file);
    made[kind] = await makeTemplate(kind, sources[kind]);
    // One person, two letters: a value either letter holds must be in neither template.
    const p = await personalValuesOf(kind, sources[kind]);
    personal.name ??= p.name;
    personal.managerName ??= p.managerName;
    personal.phone ??= p.phone;
    personal.ctc ??= p.ctc;
    personal.addressLines.push(...p.addressLines);
  }
  const problems = {};
  for (const kind of Object.keys(LETTERS)) problems[kind] = await verifyTemplate(kind, made[kind].buffer, personal, sources[kind]);
  return { made, problems, sources, personal };
}

async function main() {
  const args = process.argv.slice(2);
  const slug = (args.find((a) => a.startsWith('--company=')) ?? '').split('=')[1] || null;
  const apply = args.includes('--apply');
  if (apply && !slug) throw stop('--apply needs --company=<slug>.');

  const { made, problems } = await buildAndVerify();

  let failed = false;
  for (const [kind, f] of Object.entries(LETTERS)) {
    const m = made[kind];
    console.log(`\n${kind}  ${f.source} -> templates/${f.template}`);
    console.log(`  placeholders written: ${Object.entries(m.replaced).map(([k, n]) => (n > 1 ? `${k} x${n}` : k)).join(', ')}`);
    console.log(`  address: ${m.source.addressLines.length} paragraph(s) became one placeholder`);
    console.log(m.removed
      ? `  Annexure picture removed (relationship ${m.removed.relationshipId}, ${path.posix.basename(m.removed.target)}${m.removed.stillUsed ? ' — file kept, something else uses it' : ' — file removed from the package'})`
      : '  no picture in the body');
    if (problems[kind].length) {
      failed = true;
      console.log(`  NOT PROVEN — ${problems[kind].length} problem(s):`);
      for (const p of problems[kind]) console.log(`    - ${p}`);
    } else {
      console.log(`  proven: opens, well-formed, ${EXPECTED[kind].length} placeholders whole, nothing personal left, letterhead intact`);
    }
  }
  if (failed) throw stop('Nothing was written: a template that is not proven is not a template.');

  fs.mkdirSync(TEMPLATES_DIR, { recursive: true });
  for (const [kind, f] of Object.entries(LETTERS)) fs.writeFileSync(path.join(TEMPLATES_DIR, f.template), made[kind].buffer);
  console.log(`\nwritten: ${TEMPLATES_DIR}`);

  console.log('\nWhat the two source letters disagree about:');
  for (const line of inconsistencies(made)) console.log(`  - ${line}`);

  if (!slug) return;
  const target = resolveTarget();
  announce(target);
  const conn = await mysql.createConnection(target.cfg);
  try {
    const [[company]] = await conn.query('SELECT id, name FROM companies WHERE slug = ? AND deleted_at IS NULL', [slug]);
    if (!company) throw stop(`No company "${slug}".`);
    console.log(`  company: ${company.name} (${company.id})${apply ? '' : '   DRY RUN — nothing is written without --apply'}`);
    await conn.beginTransaction();
    for (const [kind, f] of Object.entries(LETTERS)) {
      console.log(`  ${kind.toLowerCase()} template: ${await store(conn, company, kind, f.template, made[kind].buffer, apply)}`);
    }
    console.log(`  hiring settings: ${await storeSettings(conn, company, apply)}`);
    await conn.commit();
  } catch (e) {
    try { await conn.rollback(); } catch { /* the first error is the one that matters */ }
    throw e;
  } finally {
    await conn.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(`\n  ${e.expected ? 'STOPPED' : 'FAILED'}: ${e.message}\n`);
    process.exit(1);
  });
}
