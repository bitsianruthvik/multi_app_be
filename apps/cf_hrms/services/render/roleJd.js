/**
 * render/roleJd.js — the Role JD writers, DOCX and PDF. (Plan §17.3, §17.4.)
 *
 * ── THE ONLY INPUT IS THE SNAPSHOT ────────────────────────────────────────
 * Every function here takes the snapshot object and nothing else. There is no
 * `db` parameter anywhere in this file, which is the cheapest possible way to
 * guarantee plan §2 rule 7's harder half: a historical document renders from its
 * own frozen JSON and CANNOT re-read today's role, because it has nothing to
 * read it with. Re-downloading March's JD gives March's JD.
 *
 * ── THE TWO WRITERS PRINT THE SAME DOCUMENT ───────────────────────────────
 * DOCX and PDF walk the same `sections` array in the same order and print the
 * same sentences. A section's heading and its "nothing recorded yet" wording
 * come out of the snapshot, not out of either writer, so the two cannot drift
 * into being two different documents with one name.
 *
 * ── WHY THE RESPONSIBILITY PROFILE IMPORTS FROM HERE ──────────────────────
 * The content block — KRAs with their responsibilities and KPIs nested,
 * ungrouped items under "Additional", each line tagged with where it came from —
 * is the same block in both documents. `responsibilityProfile.js` imports
 * `contentBlocksDocx` / `writeContentPdf` from this file rather than owning a
 * second copy, so a responsibility reads identically whether it is printed in a
 * JD or in a person's profile. (Phase 7 owns exactly these two render files, so
 * the shared code lives in the one the other can import.)
 *
 * ── EMPTY SECTIONS ARE PRINTED, NOT SKIPPED ───────────────────────────────
 * Plan §17.5. Karni's roles have no purpose, no KRAs, no KPIs and no
 * qualifications. Dropping those headings would say "this job has no
 * requirements"; printing the heading with "Not recorded yet" says what is
 * actually true, which is that nobody has written them down.
 */
import {
  Document, Packer, Paragraph, TextRun, HeadingLevel,
  Table, TableRow, TableCell, WidthType, BorderStyle,
} from 'docx';
import PDFDocument from 'pdfkit';
// The sentence for one row is built ONCE, in the resolver, and frozen into the
// snapshot; these two are imported rather than reimplemented so the screen, the
// DOCX and the PDF cannot describe the same responsibility three ways.
import { itemText } from '../contentResolver.js';

/* ══════════════════════════════════════════════════════════════════════════
 * Shared wording. One place, so both writers and both documents agree.
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * "Weight: changed from 10 to 15 (position, …)" — what an override actually did.
 *
 * NO CHARACTER OUTSIDE CP1252 IN ANY STRING THIS FILE PRINTS. pdfkit's built-in
 * Helvetica is WinAnsi-encoded, so a "→" does not fail — it silently prints the
 * wrong glyph, which is worse. An em dash, a middle dot and a bullet are all in
 * WinAnsi and are used freely; an arrow is not, so these sentences say "changed
 * from … to …" and the layer chain reads "Role, then Position".
 */
export function changeSentences(item) {
  return (item.changes ?? []).map((c) => {
    const from = c.from === null || c.from === undefined || c.from === '' ? 'not set' : String(c.from);
    const to = c.to === null || c.to === undefined || c.to === '' ? 'not set' : String(c.to);
    return `${labelOf(c.field)}: changed from ${from} to ${to} (${String(c.byLayer).toLowerCase()}${c.reason ? `, ${c.reason}` : ''})`;
  });
}

/** "Role, then Position, then Assignment" — WinAnsi-safe; see changeSentences. */
export const layerChain = (layers = []) => layers.map((l) => titleCase(l)).join(', then ');

const FIELD_LABEL = {
  weightPercent: 'Weight',
  isMandatory: 'Mandatory',
  sequence: 'Order',
  notes: 'Notes',
  description: 'Description',
  responsibilityClass: 'Class',
  targetOperator: 'Target operator',
  targetValue: 'Target',
  frequency: 'Frequency',
};
const labelOf = (field) => FIELD_LABEL[field] ?? field;

const titleCase = (s) => (s ? String(s).replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase()) : '');

/**
 * A row's printable line.
 *
 * `item.text` is the resolver's own sentence and is ALWAYS preferred: the screen
 * prints it too (multi_app_fe api/documents.ts says so in as many words), and two
 * renderings of one row eventually disagree — the wrong one being whichever a
 * person printed and signed. `itemText` is composed here only for a snapshot
 * frozen before the field existed, which is the one case a renderer must survive.
 */
export const lineOf = (item) => item.text ?? itemText(item);

export const responsibilityLine = lineOf;
export const kpiLine = lineOf;

/** The KRA heading line: "1. Production efficiency — 30%". The number is positional, so it is the renderer's. */
export function kraHeading(item, index) {
  return `${index + 1}. ${lineOf(item)}`;
}

/** "Not part of this position" rows, as sentences. */
export function suppressedLine(s) {
  const why = s.reason ? ` — ${s.reason}` : '';
  const moved = s.movedChildren
    ? ` The ${s.movedChildren} item${s.movedChildren === 1 ? '' : 's'} filed under it are listed under Additional.`
    : '';
  return `${s.name} (${s.kind === 'KRA' ? 'outcome area' : s.kind.toLowerCase()}, removed by the ${String(s.byLayer).toLowerCase()})${why}.${moved}`;
}

/** A reporting row from reportingResolver, as one line. Never flattened to a name. */
export function reportingLine(rel) {
  const who = rel.manager
    ? `${rel.manager.name}${rel.manager.employeeCode ? ` (${rel.manager.employeeCode})` : ''}`
    : (rel.managerPosition ? `${rel.managerPosition.title ?? rel.managerPosition.code} — seat vacant` : 'Not filled');
  const bits = [rel.relationshipType?.name ?? 'Manager', who];
  const meta = [];
  if (rel.scope && rel.scope.type && rel.scope.type !== 'GENERAL') meta.push(`scope: ${rel.scope.label || titleCase(rel.scope.type)}`);
  if (rel.scope?.notes) meta.push(rel.scope.notes);
  if (rel.manager?.workAssignmentTitle || rel.manager?.roleTitle) meta.push(`as ${rel.manager.workAssignmentTitle || rel.manager.roleTitle}`);
  meta.push(rel.inherited ? 'from the position (formal)' : 'recorded on this assignment (actual)');
  return `${bits.join(': ')} — ${meta.filter(Boolean).join(' · ')}`;
}

/** Heading for the ungrouped bucket: it is the only list when the role has no KRAs. */
export const additionalHeading = (content, kind) => (
  content.counts.kras
    ? `Additional ${kind} (not under a key result area)`
    : (kind === 'responsibilities' ? 'Responsibilities' : 'Key performance indicators')
);

const sectionOf = (sections, key) => sections.find((s) => s.key === key) ?? { key, heading: key, state: 'EMPTY', note: null, count: 0 };

/* ══════════════════════════════════════════════════════════════════════════
 * DOCX
 * ══════════════════════════════════════════════════════════════════════════ */

const GREY = '666666';
const RULE = 'DDDDDD';

const h1 = (text) => new Paragraph({ text, heading: HeadingLevel.HEADING_1, spacing: { before: 240, after: 120 } });
const h2 = (text) => new Paragraph({ text, heading: HeadingLevel.HEADING_2, spacing: { before: 200, after: 80 } });
const h3 = (text) => new Paragraph({ text, heading: HeadingLevel.HEADING_3, spacing: { before: 160, after: 60 } });
const body = (text, opts = {}) => new Paragraph({ children: [new TextRun({ text: String(text ?? ''), ...opts })], spacing: { after: 80 } });
const small = (text) => new Paragraph({ children: [new TextRun({ text: String(text ?? ''), size: 18, color: GREY })], spacing: { after: 80 } });
const italic = (text) => new Paragraph({ children: [new TextRun({ text: String(text ?? ''), italics: true, color: GREY, size: 18 })], spacing: { after: 120 } });
const bullet = (text, level = 0) => new Paragraph({ text: String(text ?? ''), bullet: { level }, spacing: { after: 40 } });
const spacer = () => new Paragraph({ text: '' });

/** The "nothing written yet" paragraph, printed under a heading that stays. */
const emptyNote = (s) => italic(s.note ?? 'Not recorded yet.');

/** A borderless-looking two-column fact table. */
function factTable(rows) {
  const cell = (children, width) => new TableCell({
    children,
    width: { size: width, type: WidthType.PERCENTAGE },
    margins: { top: 40, bottom: 40, left: 80, right: 80 },
  });
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      top: { style: BorderStyle.SINGLE, size: 1, color: RULE },
      bottom: { style: BorderStyle.SINGLE, size: 1, color: RULE },
      left: { style: BorderStyle.SINGLE, size: 1, color: RULE },
      right: { style: BorderStyle.SINGLE, size: 1, color: RULE },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 1, color: RULE },
      insideVertical: { style: BorderStyle.SINGLE, size: 1, color: RULE },
    },
    rows: rows.filter(Boolean).map(([label, value]) => new TableRow({
      children: [
        cell([new Paragraph({ children: [new TextRun({ text: String(label), bold: true, size: 20 })] })], 30),
        cell([new Paragraph({ children: [new TextRun({ text: value == null || value === '' ? 'Not recorded' : String(value), size: 20 })] })], 70),
      ],
    })),
  });
}

/**
 * The content block: KRAs with their children nested, then the ungrouped
 * buckets. Shared with the responsibility profile.
 *
 * @param content  a resolveContent result out of the snapshot
 * @param sections the snapshot's section descriptors (headings and empty notes)
 * @param level    'h1' for a standalone JD, 'h2' when nested under an assignment
 */
export function contentBlocksDocx(content, sections, level = 'h1') {
  const H = level === 'h1' ? h1 : h2;
  const SUB = level === 'h1' ? h2 : h3;
  const out = [];

  const kraSection = sectionOf(sections, 'kras');
  out.push(H(kraSection.heading));
  if (kraSection.subtitle) out.push(small(kraSection.subtitle));
  if (!content.kras.length) {
    out.push(emptyNote(kraSection));
  } else {
    content.kras.forEach((kra, i) => {
      out.push(SUB(kraHeading(kra, i)));
      if (kra.description && kra.description !== kra.name) out.push(body(kra.description));
      for (const line of changeSentences(kra)) out.push(small(line));
      if (kra.responsibilities.length) {
        out.push(body('Responsibilities', { bold: true, size: 20 }));
        for (const r of kra.responsibilities) out.push(bullet(responsibilityLine(r)));
      }
      if (kra.kpis.length) {
        out.push(body('Measured by', { bold: true, size: 20 }));
        for (const k of kra.kpis) out.push(bullet(kpiLine(k)));
      }
      if (!kra.responsibilities.length && !kra.kpis.length) {
        out.push(italic('No responsibilities or KPIs have been filed under this outcome area yet.'));
      }
    });
  }

  // The ungrouped bucket. NEVER dropped — at Karni it is the whole JD.
  const respSection = sectionOf(sections, 'responsibilities');
  out.push(H(additionalHeading(content, 'responsibilities')));
  if (!content.additional.responsibilities.length) {
    if (!content.counts.responsibilities) out.push(emptyNote(respSection));
    else out.push(italic('Every responsibility is filed under an outcome area above.'));
  } else {
    for (const r of content.additional.responsibilities) {
      out.push(bullet(responsibilityLine(r)));
      if (r.orphanNote) out.push(small(`    ${r.orphanNote}`));
    }
  }

  const kpiSection = sectionOf(sections, 'kpis');
  out.push(H(additionalHeading(content, 'kpis')));
  if (!content.additional.kpis.length) {
    if (!content.counts.kpis) out.push(emptyNote(kpiSection));
    else out.push(italic('Every KPI is filed under an outcome area above.'));
  } else {
    for (const k of content.additional.kpis) {
      out.push(bullet(kpiLine(k)));
      if (k.orphanNote) out.push(small(`    ${k.orphanNote}`));
    }
  }

  return out;
}

/** The six role-layer requirement sections, in JD order. */
function requirementBlocksDocx(content, sections, level = 'h1') {
  const H = level === 'h1' ? h1 : h2;
  const out = [];
  const list = [
    ['skills', content.skills],
    ['qualifications', content.qualifications],
    ['experience', content.experience],
    ['authorities', content.authorities],
    ['relationships', content.relationships],
    ['conditions', content.conditions],
  ];
  for (const [key, rows] of list) {
    const s = sectionOf(sections, key);
    out.push(H(s.heading));
    if (s.subtitle) out.push(small(s.subtitle));
    if (!rows.length) { out.push(emptyNote(s)); continue; }
    for (const r of rows) out.push(bullet(lineOf(r)));
  }
  return out;
}

/** "Not part of this position", plus any exception that changed nothing. */
export function exceptionBlocksDocx(content, sections, level = 'h1') {
  const H = level === 'h1' ? h1 : h2;
  const out = [];
  const s = sectionOf(sections, 'suppressed');
  if (content.suppressed.length) {
    out.push(H(s.heading));
    if (s.subtitle) out.push(small(s.subtitle));
    for (const row of content.suppressed) out.push(bullet(suppressedLine(row)));
  }
  if (content.overlay?.ignored?.length) {
    out.push(H('Exceptions that changed nothing'));
    out.push(small('Recorded here because an exception that quietly does nothing is worth seeing.'));
    for (const i of content.overlay.ignored) {
      out.push(bullet(`${titleCase(i.action)} ${titleCase(i.contentType)}${i.name ? ` "${i.name}"` : ''} on the ${String(i.layer).toLowerCase()}: ${i.why}`));
    }
  }
  return out;
}

function positionContextDocx(pc) {
  const out = [h1('Position context')];
  out.push(small('This section describes the seat, not the role. The role above is the same wherever it is filled.'));
  out.push(factTable([
    ['Position code', pc.position.positionCode],
    ['Position title', pc.position.displayTitle ?? pc.position.positionTitle],
    ['Department', pc.position.departmentName],
    ['Location', pc.position.locationName],
    ['Default shift', pc.position.shiftCode ? `${pc.position.shiftCode}${pc.position.shiftName ? ` — ${pc.position.shiftName}` : ''}` : null],
    ['Sanctioned seats', `${pc.position.seats} (${pc.position.filledCount} filled, ${pc.position.vacancyCount} vacant)`],
    ['Status', titleCase(pc.position.status)],
  ]));

  out.push(h2('Machines, lines and areas'));
  if (!pc.workContexts.length) out.push(italic('No machine, line, area or project is linked to this position yet.'));
  else for (const c of pc.workContexts) {
    out.push(bullet(`${c.workContextName ?? c.name}${c.contextType ? ` (${titleCase(c.contextType)})` : ''}${c.isPrimary ? ' — primary' : ''}`));
  }

  out.push(h2('Formal reporting'));
  out.push(small('The organisation\'s design, position to position. Who a person actually answers to is on their work assignment.'));
  if (!pc.formalReporting.relationships.length) out.push(italic('No formal reporting line is recorded for this position yet.'));
  else for (const rel of pc.formalReporting.relationships) out.push(bullet(reportingLine(rel)));

  if (pc.overrides?.length) {
    out.push(h2('This position\'s content exceptions'));
    for (const o of pc.overrides) {
      out.push(bullet(
        `${titleCase(o.action)} ${titleCase(o.contentType)} "${o.definitionName ?? o[`${o.contentType.toLowerCase()}DefinitionId`] ?? ''}"`
        + `${o.reason ? ` — ${o.reason}` : ''}`
        + `${o.effectiveFrom ? ` (from ${o.effectiveFrom})` : ''}${o.effectiveTo ? ` (until ${o.effectiveTo})` : ''}`,
      ));
    }
  }
  return out;
}

/** The title block every document opens with. */
function headerBlocksDocx(snapshot) {
  return [
    new Paragraph({
      children: [new TextRun({ text: snapshot.company?.name ?? '', bold: true, size: 20, color: GREY })],
      spacing: { after: 40 },
    }),
    new Paragraph({
      children: [new TextRun({ text: snapshot.title, bold: true, size: 32 })],
      spacing: { after: 40 },
    }),
    new Paragraph({
      children: [new TextRun({ text: snapshot.subtitle ?? '', size: 20, color: GREY })],
      spacing: { after: 120 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: RULE, space: 4 } },
    }),
    small([
      `As at ${snapshot.asOfText ?? snapshot.asOf}`,
      snapshot.generatedBy?.name ? `generated by ${snapshot.generatedBy.name}` : null,
      `template ${snapshot.templateVersion}`,
    ].filter(Boolean).join(' · ')),
    italic(snapshot.honestyNote),
  ];
}

function footerBlocksDocx(snapshot) {
  return [
    spacer(),
    small(`This document is a snapshot of the record as it stood on ${snapshot.asOfText ?? snapshot.asOf}. `
      + 'It was generated from the stored snapshot and does not change when the role is later edited.'),
  ];
}

export async function renderRoleJdDocx(snapshot) {
  const { content, sections, role } = snapshot;
  const children = [
    ...headerBlocksDocx(snapshot),
    factTable([
      ['Role code', role.roleCode],
      ['Role title', role.title],
      ['Status', titleCase(role.status)],
      ['Default department', role.defaultDepartmentName ?? role.departmentName ?? null],
      ['Content resolved through', layerChain(content.layers)],
    ]),
  ];

  const purpose = sectionOf(sections, 'purpose');
  children.push(h1(purpose.heading));
  children.push(role.rolePurpose ? body(role.rolePurpose) : emptyNote(purpose));

  const summary = sectionOf(sections, 'summary');
  children.push(h1(summary.heading));
  children.push(role.roleSummary ? body(role.roleSummary) : emptyNote(summary));

  children.push(...contentBlocksDocx(content, sections, 'h1'));
  children.push(...requirementBlocksDocx(content, sections, 'h1'));
  children.push(...exceptionBlocksDocx(content, sections, 'h1'));
  if (snapshot.positionContext) children.push(...positionContextDocx(snapshot.positionContext));
  children.push(...footerBlocksDocx(snapshot));

  const doc = new Document({
    creator: snapshot.company?.name ?? 'CF HRMS',
    title: snapshot.title,
    description: snapshot.subtitle ?? '',
    sections: [{ properties: {}, children }],
  });
  return Packer.toBuffer(doc);
}

/* ══════════════════════════════════════════════════════════════════════════
 * PDF
 * ══════════════════════════════════════════════════════════════════════════
 * pdfkit draws; it does not lay out. So the helpers below are the layout: a
 * heading that keeps itself off the bottom of a page, a bullet that wraps under
 * its own indent, and a fact row that does not split a label from its value.
 */

const PDF = {
  margin: 50,
  ink: '#111111',
  grey: '#666666',
  rule: '#dddddd',
};

export function pdfKit(doc) {
  const width = () => doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const room = (need) => {
    if (doc.y + need > doc.page.height - doc.page.margins.bottom) doc.addPage();
  };
  const api = {
    doc,
    width,
    room,
    text(text, { size = 10, font = 'Helvetica', color = PDF.ink, indent = 0, after = 4, align = 'left' } = {}) {
      if (text === null || text === undefined || text === '') return api;
      room(size * 2);
      doc.font(font).fontSize(size).fillColor(color)
        .text(String(text), doc.page.margins.left + indent, doc.y, { width: width() - indent, align });
      doc.y += after;
      return api;
    },
    heading(text, level = 1) {
      const size = level === 1 ? 13 : level === 2 ? 11 : 10;
      room(60);
      doc.moveDown(level === 1 ? 0.6 : 0.4);
      doc.font('Helvetica-Bold').fontSize(size).fillColor(PDF.ink)
        .text(String(text), doc.page.margins.left, doc.y, { width: width() });
      if (level === 1) {
        doc.moveTo(doc.page.margins.left, doc.y + 2)
          .lineTo(doc.page.width - doc.page.margins.right, doc.y + 2)
          .lineWidth(0.5).strokeColor(PDF.rule).stroke();
        doc.y += 6;
      } else {
        doc.y += 3;
      }
      return api;
    },
    bullet(text, { indent = 10, size = 10, color = PDF.ink } = {}) {
      room(size * 2);
      doc.font('Helvetica').fontSize(size).fillColor(color)
        .text(`•  ${String(text)}`, doc.page.margins.left + indent, doc.y, {
          width: width() - indent - 4,
          indent: 0,
          align: 'left',
        });
      doc.y += 2;
      return api;
    },
    note(text) {
      return api.text(text, { size: 9, font: 'Helvetica-Oblique', color: PDF.grey, after: 6 });
    },
    smallText(text, indent = 0) {
      return api.text(text, { size: 8.5, color: PDF.grey, indent, after: 3 });
    },
    facts(rows) {
      const labelWidth = 130;
      for (const row of rows.filter(Boolean)) {
        const [label, value] = row;
        const text = value == null || value === '' ? 'Not recorded' : String(value);
        const h = Math.max(
          doc.font('Helvetica-Bold').fontSize(9.5).heightOfString(String(label), { width: labelWidth - 8 }),
          doc.font('Helvetica').fontSize(9.5).heightOfString(text, { width: width() - labelWidth }),
        );
        room(h + 10);
        const top = doc.y;
        doc.font('Helvetica-Bold').fontSize(9.5).fillColor(PDF.grey)
          .text(String(label), doc.page.margins.left, top, { width: labelWidth - 8 });
        doc.font('Helvetica').fontSize(9.5).fillColor(PDF.ink)
          .text(text, doc.page.margins.left + labelWidth, top, { width: width() - labelWidth });
        doc.y = top + h + 5;
        doc.moveTo(doc.page.margins.left, doc.y - 2)
          .lineTo(doc.page.width - doc.page.margins.right, doc.y - 2)
          .lineWidth(0.4).strokeColor(PDF.rule).stroke();
      }
      doc.y += 4;
      return api;
    },
  };
  return api;
}

/** Collects a pdfkit stream into one Buffer. */
export function pdfBuffer(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

export function newPdf(snapshot) {
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: PDF.margin, bottom: PDF.margin, left: PDF.margin, right: PDF.margin },
    info: {
      Title: snapshot.title,
      Author: snapshot.company?.name ?? 'CF HRMS',
      Subject: snapshot.subtitle ?? '',
      Creator: `CF HRMS ${snapshot.templateVersion}`,
    },
  });
  return doc;
}

export function writeHeaderPdf(kit, snapshot) {
  kit.text(snapshot.company?.name ?? '', { size: 9, font: 'Helvetica-Bold', color: PDF.grey, after: 2 });
  kit.text(snapshot.title, { size: 17, font: 'Helvetica-Bold', after: 2 });
  kit.text(snapshot.subtitle ?? '', { size: 9.5, color: PDF.grey, after: 6 });
  kit.doc.moveTo(kit.doc.page.margins.left, kit.doc.y)
    .lineTo(kit.doc.page.width - kit.doc.page.margins.right, kit.doc.y)
    .lineWidth(1).strokeColor(PDF.rule).stroke();
  kit.doc.y += 8;
  kit.smallText([
    `As at ${snapshot.asOfText ?? snapshot.asOf}`,
    snapshot.generatedBy?.name ? `generated by ${snapshot.generatedBy.name}` : null,
    `template ${snapshot.templateVersion}`,
  ].filter(Boolean).join(' · '));
  kit.note(snapshot.honestyNote);
}

/** The content block in PDF. Twin of `contentBlocksDocx`, same order, same words. */
export function writeContentPdf(kit, content, sections, level = 1) {
  const H = level;
  const SUB = level + 1;

  const kraSection = sectionOf(sections, 'kras');
  kit.heading(kraSection.heading, H);
  if (kraSection.subtitle) kit.smallText(kraSection.subtitle);
  if (!content.kras.length) {
    kit.note(kraSection.note ?? 'Not recorded yet.');
  } else {
    content.kras.forEach((kra, i) => {
      kit.heading(kraHeading(kra, i), SUB);
      if (kra.description && kra.description !== kra.name) kit.text(kra.description);
      for (const line of changeSentences(kra)) kit.smallText(line);
      if (kra.responsibilities.length) {
        kit.text('Responsibilities', { size: 9.5, font: 'Helvetica-Bold', after: 2 });
        for (const r of kra.responsibilities) kit.bullet(responsibilityLine(r));
      }
      if (kra.kpis.length) {
        kit.text('Measured by', { size: 9.5, font: 'Helvetica-Bold', after: 2 });
        for (const k of kra.kpis) kit.bullet(kpiLine(k));
      }
      if (!kra.responsibilities.length && !kra.kpis.length) {
        kit.note('No responsibilities or KPIs have been filed under this outcome area yet.');
      }
    });
  }

  const respSection = sectionOf(sections, 'responsibilities');
  kit.heading(additionalHeading(content, 'responsibilities'), H);
  if (!content.additional.responsibilities.length) {
    if (!content.counts.responsibilities) kit.note(respSection.note ?? 'Not recorded yet.');
    else kit.note('Every responsibility is filed under an outcome area above.');
  } else {
    for (const r of content.additional.responsibilities) {
      kit.bullet(responsibilityLine(r));
      if (r.orphanNote) kit.smallText(r.orphanNote, 24);
    }
  }

  const kpiSection = sectionOf(sections, 'kpis');
  kit.heading(additionalHeading(content, 'kpis'), H);
  if (!content.additional.kpis.length) {
    if (!content.counts.kpis) kit.note(kpiSection.note ?? 'Not recorded yet.');
    else kit.note('Every KPI is filed under an outcome area above.');
  } else {
    for (const k of content.additional.kpis) {
      kit.bullet(kpiLine(k));
      if (k.orphanNote) kit.smallText(k.orphanNote, 24);
    }
  }
}

function writeRequirementsPdf(kit, content, sections, level = 1) {
  const list = [
    ['skills', content.skills],
    ['qualifications', content.qualifications],
    ['experience', content.experience],
    ['authorities', content.authorities],
    ['relationships', content.relationships],
    ['conditions', content.conditions],
  ];
  for (const [key, rows] of list) {
    const s = sectionOf(sections, key);
    kit.heading(s.heading, level);
    if (s.subtitle) kit.smallText(s.subtitle);
    if (!rows.length) { kit.note(s.note ?? 'Not recorded yet.'); continue; }
    for (const r of rows) kit.bullet(lineOf(r));
  }
}

export function writeExceptionsPdf(kit, content, sections, level = 1) {
  const s = sectionOf(sections, 'suppressed');
  if (content.suppressed.length) {
    kit.heading(s.heading, level);
    if (s.subtitle) kit.smallText(s.subtitle);
    for (const row of content.suppressed) kit.bullet(suppressedLine(row));
  }
  if (content.overlay?.ignored?.length) {
    kit.heading('Exceptions that changed nothing', level);
    kit.smallText('Recorded here because an exception that quietly does nothing is worth seeing.');
    for (const i of content.overlay.ignored) {
      kit.bullet(`${titleCase(i.action)} ${titleCase(i.contentType)}${i.name ? ` "${i.name}"` : ''} on the ${String(i.layer).toLowerCase()}: ${i.why}`);
    }
  }
}

function writePositionContextPdf(kit, pc) {
  kit.heading('Position context', 1);
  kit.smallText('This section describes the seat, not the role. The role above is the same wherever it is filled.');
  kit.facts([
    ['Position code', pc.position.positionCode],
    ['Position title', pc.position.displayTitle ?? pc.position.positionTitle],
    ['Department', pc.position.departmentName],
    ['Location', pc.position.locationName],
    ['Default shift', pc.position.shiftCode ? `${pc.position.shiftCode}${pc.position.shiftName ? ` — ${pc.position.shiftName}` : ''}` : null],
    ['Sanctioned seats', `${pc.position.seats} (${pc.position.filledCount} filled, ${pc.position.vacancyCount} vacant)`],
    ['Status', titleCase(pc.position.status)],
  ]);

  kit.heading('Machines, lines and areas', 2);
  if (!pc.workContexts.length) kit.note('No machine, line, area or project is linked to this position yet.');
  else for (const c of pc.workContexts) {
    kit.bullet(`${c.workContextName ?? c.name}${c.contextType ? ` (${titleCase(c.contextType)})` : ''}${c.isPrimary ? ' — primary' : ''}`);
  }

  kit.heading('Formal reporting', 2);
  kit.smallText('The organisation\'s design, position to position. Who a person actually answers to is on their work assignment.');
  if (!pc.formalReporting.relationships.length) kit.note('No formal reporting line is recorded for this position yet.');
  else for (const rel of pc.formalReporting.relationships) kit.bullet(reportingLine(rel));

  if (pc.overrides?.length) {
    kit.heading('This position\'s content exceptions', 2);
    for (const o of pc.overrides) {
      kit.bullet(
        `${titleCase(o.action)} ${titleCase(o.contentType)} "${o.definitionName ?? ''}"`
        + `${o.reason ? ` — ${o.reason}` : ''}`
        + `${o.effectiveFrom ? ` (from ${o.effectiveFrom})` : ''}${o.effectiveTo ? ` (until ${o.effectiveTo})` : ''}`,
      );
    }
  }
}

export function writeFooterPdf(kit, snapshot) {
  kit.doc.moveDown(0.8);
  kit.smallText(`This document is a snapshot of the record as it stood on ${snapshot.asOfText ?? snapshot.asOf}. `
    + 'It was generated from the stored snapshot and does not change when the role is later edited.');
}

export async function renderRoleJdPdf(snapshot) {
  const { content, sections, role } = snapshot;
  const doc = newPdf(snapshot);
  const kit = pdfKit(doc);

  writeHeaderPdf(kit, snapshot);
  kit.facts([
    ['Role code', role.roleCode],
    ['Role title', role.title],
    ['Status', titleCase(role.status)],
    ['Default department', role.defaultDepartmentName ?? role.departmentName ?? null],
    ['Content resolved through', layerChain(content.layers)],
  ]);

  const purpose = sectionOf(sections, 'purpose');
  kit.heading(purpose.heading, 1);
  if (role.rolePurpose) kit.text(role.rolePurpose); else kit.note(purpose.note ?? 'Not recorded yet.');

  const summary = sectionOf(sections, 'summary');
  kit.heading(summary.heading, 1);
  if (role.roleSummary) kit.text(role.roleSummary); else kit.note(summary.note ?? 'Not recorded yet.');

  writeContentPdf(kit, content, sections, 1);
  writeRequirementsPdf(kit, content, sections, 1);
  writeExceptionsPdf(kit, content, sections, 1);
  if (snapshot.positionContext) writePositionContextPdf(kit, snapshot.positionContext);
  writeFooterPdf(kit, snapshot);

  return pdfBuffer(doc);
}

export { sectionOf, titleCase, factTable, h1, h2, h3, body, small, italic, bullet, spacer, emptyNote, PDF };
export default { renderRoleJdDocx, renderRoleJdPdf };
