/**
 * letterRenderer.js — an offer or appointment letter from a template.
 * (TM/CF_HRMS_HIRING_SPEC.md §2.3.)
 *
 * A TEMPLATE IS A .docx WITH PLACEHOLDERS IN BRACES — {candidate_name},
 * {annual_ctc} — typed anywhere in the body, a header or a footer. Rendering
 * opens the file (it is a zip), replaces the placeholders in those parts and
 * closes it again. Nothing else in the package is touched: the letterhead, its
 * images, the fonts and the numbering are the company's own and stay as they are.
 *
 * A PLACEHOLDER SPLIT ACROSS WORD RUNS IS STILL FOUND. Word stores
 * "{candidate_name}" as two or three runs more often than as one, so the search
 * is over each paragraph's joined text (services/docxText.js), not over the XML.
 *
 * NOTHING IS BLANKED SILENTLY. `unfilled` names every placeholder the letter
 * did not get a value for:
 *   - one this file does not know ({candiate_name}, a typo) is LEFT VISIBLE in
 *     the letter, braces and all, so nobody posts a letter with a hole in it;
 *   - one it knows but has no value for (no phone on file) prints as nothing.
 * Either way it is in `unfilled`, and the screen says so.
 *
 * NO DATABASE HERE. The caller hands in the template bytes and the facts; this
 * file formats and fills. The values are formatted once, in `letterValues`, so
 * the letter and the stored snapshot of what it printed cannot differ.
 *
 * A company with no template of its own gets the built-in letters at the end
 * of this file: the same fields in plain words, built with the `docx` library
 * and then filled by the very same code path.
 */
import JSZip from 'jszip';
import {
  Document, Packer, Paragraph, TextRun, AlignmentType,
  Table, TableRow, TableCell, WidthType,
} from 'docx';
import { HrmsError } from '../lib/errors.js';
import { scanParagraphs, replaceRanges } from './docxText.js';

export const LETTER_KINDS = ['OFFER', 'APPOINTMENT'];
export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/**
 * Every placeholder a letter may use, with the words the settings screen shows
 * beside it. `key` is the name WITHOUT braces; a template writes {key}.
 */
export const PLACEHOLDERS = [
  { key: 'ref_no', label: 'Letter reference number', example: 'HR/26-27/003' },
  { key: 'letter_date', label: 'Date of the letter', example: '12th August 2026' },
  { key: 'salutation', label: 'Salutation', example: 'Mr.' },
  { key: 'candidate_name', label: 'Candidate’s name', example: 'Asha Rao' },
  { key: 'candidate_phone', label: 'Candidate’s phone', example: '9000000000' },
  { key: 'candidate_address', label: 'Candidate’s address (prints on as many lines as were typed)', example: '12 Lake Road,\nHyderabad.' },
  { key: 'designation', label: 'Designation', example: 'Quality In-charge' },
  { key: 'department', label: 'Department', example: 'Quality' },
  { key: 'reporting_to_title', label: 'Reports to — the manager’s title', example: 'Production Manager' },
  { key: 'reporting_to_name', label: 'Reports to — the manager’s name', example: 'R. Kumar' },
  { key: 'place_of_posting', label: 'Place of posting', example: 'Unit-2, Bibi Nagar, Hyderabad' },
  { key: 'joining_date', label: 'Date of joining', example: '20th August 2026' },
  { key: 'offer_valid_until', label: 'Offer valid until', example: '19th August 2026' },
  { key: 'annual_ctc', label: 'Annual cost to company', example: '9,00,000' },
  { key: 'probation_months', label: 'Probation, in months', example: '3' },
  { key: 'probation_months_words', label: 'Probation, in words and figures', example: 'three (3)' },
  { key: 'notice_days_probation', label: 'Notice during probation, in days', example: '15' },
  { key: 'notice_days_probation_words', label: 'Notice during probation, in words and figures', example: 'Fifteen (15)' },
  { key: 'notice_days_confirmed', label: 'Notice after confirmation, in days', example: '30' },
  { key: 'notice_days_confirmed_words', label: 'Notice after confirmation, in words and figures', example: 'Thirty (30)' },
  { key: 'company_name', label: 'Company’s legal name', example: 'Acme Packaging Private Limited' },
  { key: 'signatory_name', label: 'Signatory’s name', example: 'S. Rao' },
  { key: 'signatory_designation', label: 'Signatory’s designation', example: 'HR Head' },
  { key: 'jurisdiction', label: 'Jurisdiction', example: 'Hyderabad, Telangana' },
  { key: 'employee_code', label: 'Employee code (appointment letter only)', example: 'EMP0042' },
];
const KNOWN = new Set(PLACEHOLDERS.map((p) => p.key));

const PLACEHOLDER_RE = /\{([A-Za-z][A-Za-z0-9_]*)\}/g;

/* ══════════════════════════════════════════════════════════════════════════
 * How values print
 * ══════════════════════════════════════════════════════════════════════════ */

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function ordinal(n) {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${{ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] ?? 'th'}`;
}

/** 2026-08-20 -> "20th August 2026". Anything that is not a date prints as nothing. */
export function letterDate(value) {
  const s = value instanceof Date
    ? `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
    : String(value ?? '').slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) return '';
  return `${ordinal(Number(m[3]))} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}

/** Indian digit grouping: 900000 -> "9,00,000", 12345678.5 -> "1,23,45,678.50". */
export function indianNumber(value) {
  if (value === null || value === undefined || value === '') return '';
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  const [whole, fraction] = Math.abs(n).toFixed(2).split('.');
  const head = whole.length > 3 ? whole.slice(0, -3) : '';
  const grouped = head ? `${head.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${whole.slice(-3)}` : whole;
  return `${n < 0 ? '-' : ''}${grouped}${fraction === '00' ? '' : `.${fraction}`}`;
}

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

/** 0–999 in words: 3 -> "three", 45 -> "forty-five", 120 -> "one hundred and twenty". Larger prints as figures. */
export function numberWords(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) return '';
  if (n > 999) return String(n);
  if (n < 20) return ONES[n];
  if (n < 100) return `${TENS[Math.floor(n / 10)]}${n % 10 ? `-${ONES[n % 10]}` : ''}`;
  const rest = n % 100;
  return `${ONES[Math.floor(n / 100)]} hundred${rest ? ` and ${numberWords(rest)}` : ''}`;
}

/** "three (3)"; with `capital`, "Fifteen (15)". */
export function wordsAndFigures(value, { capital = false } = {}) {
  if (value === null || value === undefined || value === '') return '';
  const words = numberWords(value);
  if (!words) return '';
  return `${capital ? words[0].toUpperCase() + words.slice(1) : words} (${Number(value)})`;
}

const text = (v) => (v === null || v === undefined ? '' : String(v).trim());

/**
 * The value of every placeholder for one letter, as it prints.
 *
 * `joining_date` is the date the letter states: the proposed date on an offer,
 * the confirmed one on an appointment. Probation prints in lower case and the
 * two notice periods with a capital ("three (3) months", "Fifteen (15) days"),
 * which is how the letters this was built from are worded.
 *
 * @param facts camelCase: refNo, letterDate, salutation, candidateName, candidatePhone,
 *   candidateAddress, designation, department, reportingToTitle, reportingToName,
 *   placeOfPosting, joiningDate, offerValidUntil, annualCtc, probationMonths,
 *   noticeDaysProbation, noticeDaysConfirmed, companyName, signatoryName,
 *   signatoryDesignation, jurisdiction, employeeCode
 */
export function letterValues(facts = {}) {
  const count = (v) => (v === null || v === undefined || v === '' ? '' : String(Number(v)));
  return {
    ref_no: text(facts.refNo),
    letter_date: letterDate(facts.letterDate),
    salutation: text(facts.salutation),
    candidate_name: text(facts.candidateName),
    candidate_phone: text(facts.candidatePhone),
    // As typed: each line its own line, blank lines dropped.
    candidate_address: String(facts.candidateAddress ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join('\n'),
    designation: text(facts.designation),
    department: text(facts.department),
    reporting_to_title: text(facts.reportingToTitle),
    reporting_to_name: text(facts.reportingToName),
    place_of_posting: text(facts.placeOfPosting),
    joining_date: letterDate(facts.joiningDate),
    offer_valid_until: letterDate(facts.offerValidUntil),
    annual_ctc: indianNumber(facts.annualCtc),
    probation_months: count(facts.probationMonths),
    probation_months_words: wordsAndFigures(facts.probationMonths),
    notice_days_probation: count(facts.noticeDaysProbation),
    notice_days_probation_words: wordsAndFigures(facts.noticeDaysProbation, { capital: true }),
    notice_days_confirmed: count(facts.noticeDaysConfirmed),
    notice_days_confirmed_words: wordsAndFigures(facts.noticeDaysConfirmed, { capital: true }),
    company_name: text(facts.companyName),
    signatory_name: text(facts.signatoryName),
    signatory_designation: text(facts.signatoryDesignation),
    jurisdiction: text(facts.jurisdiction),
    employee_code: text(facts.employeeCode),
  };
}

/* ══════════════════════════════════════════════════════════════════════════
 * Opening and filling
 * ══════════════════════════════════════════════════════════════════════════ */

/** The parts of a .docx that carry a letter's words: the body, then headers and footers. */
const TEXT_PART_RE = /^word\/(document|header\d*|footer\d*)\.xml$/;

async function openDocx(buffer) {
  let zip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    throw new HrmsError(422, 'BAD_TEMPLATE', 'That file is not a Word document. Save the letter as .docx and upload it again.');
  }
  if (!zip.file('word/document.xml')) {
    throw new HrmsError(422, 'BAD_TEMPLATE', 'That file is not a Word document. Save the letter as .docx and upload it again.');
  }
  return zip;
}

const textParts = (zip) => Object.keys(zip.files).filter((name) => TEXT_PART_RE.test(name)).sort();

/**
 * Which placeholders a template uses — for the upload answer and the settings
 * screen. `placeholders` are the ones this file knows, in the order of the
 * list above; `unknown` are the rest, as typed.
 */
export async function inspectTemplate(buffer) {
  const zip = await openDocx(buffer);
  const found = new Set();
  for (const name of textParts(zip)) {
    const xml = await zip.file(name).async('string');
    for (const p of scanParagraphs(xml)) for (const m of p.text.matchAll(PLACEHOLDER_RE)) found.add(m[1]);
  }
  return {
    placeholders: PLACEHOLDERS.map((p) => p.key).filter((k) => found.has(k)),
    unknown: [...found].filter((k) => !KNOWN.has(k)).sort(),
  };
}

/**
 * Fills a template.
 *
 * @param templateBuffer the .docx
 * @param values         placeholder key -> printed text (see letterValues)
 * @returns {{ buffer: Buffer, unfilled: string[] }} `unfilled` are keys, without braces
 */
export async function renderLetter(templateBuffer, values = {}) {
  const zip = await openDocx(templateBuffer);
  const unfilled = new Set();

  for (const name of textParts(zip)) {
    const xml = await zip.file(name).async('string');
    const edits = [];
    for (const paragraph of scanParagraphs(xml)) {
      if (!paragraph.text.includes('{')) continue;
      for (const m of paragraph.text.matchAll(PLACEHOLDER_RE)) {
        const key = m[1];
        const value = KNOWN.has(key) ? String(values[key] ?? '') : null;
        if (!value) unfilled.add(key);
        if (value === null) continue;                    // not one of ours: left as typed
        let end = m.index + m[0].length;
        // Nothing to print: take the space after it too, so "Dear {salutation} {name}" does not print two.
        if (!value && paragraph.text[end] === ' ' && (m.index === 0 || paragraph.text[m.index - 1] === ' ')) end += 1;
        edits.push({ paragraph, start: m.index, end, text: value });
      }
    }
    if (edits.length) zip.file(name, replaceRanges(xml, edits), { createFolders: false });
  }

  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  // In the order of the list, then anything unknown.
  const order = PLACEHOLDERS.map((p) => p.key);
  return {
    buffer,
    unfilled: [...unfilled].sort((a, b) => (order.indexOf(a) + 1 || 999) - (order.indexOf(b) + 1 || 999) || a.localeCompare(b)),
  };
}

/* ══════════════════════════════════════════════════════════════════════════
 * The built-in letters — for a company with no template of its own
 * ══════════════════════════════════════════════════════════════════════════
 * Plain on purpose: no letterhead (the company prints on its own), the same
 * fields, short clauses nobody needs a lawyer to accept. A company that wants
 * its own wording uploads its own .docx under Hiring settings.
 */

const FONT = 'Calibri';
const run = (t, opts = {}) => new TextRun({ text: t, font: FONT, size: 22, ...opts });
const para = (t, opts = {}) => new Paragraph({ children: [run(t, opts.run)], spacing: { after: 120 }, ...opts.paragraph });
const gap = () => new Paragraph({ children: [run('')] });
const heading = (t) => new Paragraph({ children: [run(t, { bold: true, size: 26 })], alignment: AlignmentType.CENTER, spacing: { before: 200, after: 200 } });
const sub = (t) => new Paragraph({ children: [run(t, { bold: true })], spacing: { before: 160, after: 80 } });

const refLines = () => [
  para('Ref No: {ref_no}', { paragraph: { spacing: { after: 0 } } }),
  para('Date: {letter_date}'),
];

const addressBlock = () => [
  para('To,', { paragraph: { spacing: { after: 0 } } }),
  para('{salutation} {candidate_name}', { paragraph: { spacing: { after: 0 } } }),
  para('{candidate_phone}', { paragraph: { spacing: { after: 0 } } }),
  para('{candidate_address}'),
  gap(),
  para('Dear {salutation} {candidate_name},'),
];

const particulars = (rows) => new Table({
  width: { size: 100, type: WidthType.PERCENTAGE },
  rows: rows.map(([label, value]) => new TableRow({
    children: [
      new TableCell({ width: { size: 40, type: WidthType.PERCENTAGE }, children: [new Paragraph({ children: [run(label, { bold: true })] })] }),
      new TableCell({ width: { size: 60, type: WidthType.PERCENTAGE }, children: [new Paragraph({ children: [run(value)] })] }),
    ],
  })),
});

const signature = () => [
  gap(),
  para('Yours faithfully,'),
  para('For {company_name}'),
  gap(),
  gap(),
  para('Name: {signatory_name}', { paragraph: { spacing: { after: 0 } } }),
  para('Designation: {signatory_designation}'),
];

const acceptance = (what) => [
  gap(),
  sub('Acceptance'),
  para(`I accept the above ${what} and its terms.`),
  gap(),
  para('Signature:', { paragraph: { spacing: { after: 0 } } }),
  para('Name:', { paragraph: { spacing: { after: 0 } } }),
  para('Date:'),
];

function builtInDocument(kind) {
  const children = kind === 'OFFER'
    ? [
      ...refLines(),
      heading('Offer of Employment'),
      ...addressBlock(),
      para('We are pleased to offer you employment with {company_name} for the position of {designation}.'),
      sub('Position details'),
      particulars([
        ['Designation', '{designation}'],
        ['Department', '{department}'],
        ['Reporting to', '{reporting_to_title}'],
        ['Place of posting', '{place_of_posting}'],
        ['Proposed date of joining', '{joining_date}'],
        ['Annual cost to company (CTC)', '{annual_ctc}'],
      ]),
      sub('Terms of this offer'),
      para('This offer is valid until {offer_valid_until}. Please confirm your acceptance by signing and returning a copy of this letter on or before that date.'),
      para('You will be on probation for {probation_months_words} months from your date of joining.'),
      para('This offer depends on the information and documents you have given us being true and complete.'),
      ...signature(),
      ...acceptance('offer of employment'),
    ]
    : [
      ...refLines(),
      heading('Appointment Letter'),
      ...addressBlock(),
      para('We are pleased to appoint you as {designation} with {company_name}, on the terms in this letter.'),
      sub('Appointment'),
      particulars([
        ['Employee code', '{employee_code}'],
        ['Designation', '{designation}'],
        ['Department', '{department}'],
        ['Reporting to', '{reporting_to_title}'],
        ['Place of posting', '{place_of_posting}'],
        ['Date of joining', '{joining_date}'],
        ['Annual cost to company (CTC)', '{annual_ctc}'],
      ]),
      sub('Probation and notice'),
      para('You will be on probation for {probation_months_words} months from your date of joining.'),
      para('During probation either side may end the employment with {notice_days_probation_words} days’ written notice, or salary in place of it.'),
      para('After confirmation either side may end the employment with {notice_days_confirmed_words} days’ written notice, or salary in place of it.'),
      sub('General'),
      para('You will follow the company’s policies and rules as they stand from time to time, and keep the company’s information confidential during and after your employment.'),
      para('Any dispute about your employment is subject to the courts at {jurisdiction}.'),
      ...signature(),
      ...acceptance('appointment'),
    ];
  return new Document({ sections: [{ children }] });
}

const builtIn = new Map();

/** The built-in template for a kind, as .docx bytes with its placeholders in place. Built once per process. */
export async function builtInTemplate(kind) {
  if (!LETTER_KINDS.includes(kind)) throw new HrmsError(422, 'INVALID', 'A letter is an offer letter or an appointment letter.');
  if (!builtIn.has(kind)) builtIn.set(kind, await Packer.toBuffer(builtInDocument(kind)));
  return builtIn.get(kind);
}

export const builtInFileName = (kind) => (kind === 'OFFER' ? 'Offer letter (built-in).docx' : 'Appointment letter (built-in).docx');

export default {
  LETTER_KINDS, PLACEHOLDERS, DOCX_MIME,
  letterDate, indianNumber, numberWords, wordsAndFigures, letterValues,
  inspectTemplate, renderLetter, builtInTemplate, builtInFileName,
};
