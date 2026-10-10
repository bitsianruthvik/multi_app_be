/**
 * docxText.js — reading and replacing TEXT inside WordprocessingML, without a
 * parser and without disturbing anything that is not text.
 *
 * WHY THIS EXISTS. Word does not keep a sentence in one piece. "{candidate_name}"
 * typed into a letter is routinely stored as three runs — "{candidate", "_name",
 * "}" — because of a spelling check, a formatting change or an edit made in the
 * middle. Searching the XML for the placeholder therefore misses it. So the
 * unit here is the PARAGRAPH: its text is the text of all its <w:t> elements
 * joined, a range of that text is found, and the replacement is written back
 * into the <w:t> where the range starts while the rest of the range is removed
 * from the elements it ran through. Runs, their formatting, tabs, drawings and
 * everything else in the paragraph stay byte for byte as they were.
 *
 * Used by services/letterRenderer.js (filling a template) and by
 * scripts/make-letter-templates.mjs (turning a filled letter into one).
 *
 * A line break in a replacement ('\n') becomes <w:br/> inside the same run,
 * which is how a multi-line address prints as lines.
 *
 * Text boxes nest paragraphs inside a paragraph. The scan keeps a stack, so a
 * <w:t> belongs to the innermost paragraph around it and a text box's text is
 * never joined to the sentence it is anchored in.
 */

const TOKEN_RE = /<w:p(?=[\s>/])[^>]*>|<\/w:p>|<w:t(?=[\s>/])[^>]*?(?:\/>|>([\s\S]*?)<\/w:t>)/g;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeXml(s) {
  return String(s).replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (whole, name) => {
    if (name[0] !== '#') return ENTITIES[name];
    const code = name[1] === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
  });
}

export const encodeXml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Every paragraph of a part, in document order of their OPENING tags.
 *
 * @returns {Array<{ start: number, end: number, nodes: Array<{ start: number, end: number, text: string }>, text: string }>}
 *   `start`/`end` are offsets into `xml` (of the whole <w:p>…</w:p>, and of each
 *   <w:t> element); `text` is decoded. Text outside any paragraph is ignored —
 *   WordprocessingML has none.
 */
export function scanParagraphs(xml) {
  const done = [];
  const stack = [];
  TOKEN_RE.lastIndex = 0;
  for (let m = TOKEN_RE.exec(xml); m; m = TOKEN_RE.exec(xml)) {
    const tag = m[0];
    if (tag.startsWith('</w:p>')) {
      const p = stack.pop();
      if (p) { p.end = m.index + tag.length; done.push(p); }
    } else if (tag.startsWith('<w:p')) {
      const p = { start: m.index, end: m.index + tag.length, nodes: [], text: '' };
      if (tag.endsWith('/>')) done.push(p); else stack.push(p);
    } else if (stack.length) {
      stack[stack.length - 1].nodes.push({ start: m.index, end: m.index + tag.length, text: decodeXml(m[1] ?? '') });
    }
  }
  for (const p of done) p.text = p.nodes.map((n) => n.text).join('');
  return done.sort((a, b) => a.start - b.start);
}

const serialise = (text) => String(text).split('\n')
  .map((line) => `<w:t xml:space="preserve">${encodeXml(line)}</w:t>`)
  .join('<w:br/>');

/**
 * Replaces ranges of paragraphs' text.
 *
 * @param xml   the part
 * @param edits [{ paragraph, start, end, text }] — `paragraph` from scanParagraphs(xml);
 *              `start`/`end` are offsets into paragraph.text. Ranges of one
 *              paragraph must not overlap.
 * @returns the new XML. Offsets from the scan are stale afterwards — scan again.
 */
export function replaceRanges(xml, edits) {
  const byParagraph = new Map();
  for (const e of edits) {
    if (!byParagraph.has(e.paragraph)) byParagraph.set(e.paragraph, []);
    byParagraph.get(e.paragraph).push(e);
  }

  // Each changed <w:t>, as a splice of the XML.
  const splices = [];
  for (const [p, list] of byParagraph) {
    if (!p.nodes.length) continue;
    const texts = p.nodes.map((n) => n.text);
    // Offsets are those of the text AS SCANNED and are never recomputed: ranges
    // are applied last first, so what an earlier range reads is still in place.
    const lengthOf = texts.map((t) => t.length);
    const startOf = [];
    let at = 0;
    for (const n of lengthOf) { startOf.push(at); at += n; }
    const changed = new Set();

    for (const e of [...list].sort((a, b) => b.start - a.start)) {
      // The <w:t> the range starts in. A range starting exactly where one
      // element ends and the next begins belongs to the NEXT one — that is the
      // run that carries the replaced words' formatting.
      let first = texts.length - 1;
      for (let i = 0; i < texts.length; i += 1) {
        if (e.start < startOf[i] + lengthOf[i]) { first = i; break; }
      }
      for (let i = texts.length - 1; i >= first; i -= 1) {
        const from = Math.max(e.start, startOf[i]) - startOf[i];
        const to = Math.min(e.end, startOf[i] + lengthOf[i]) - startOf[i];
        if (i !== first && to <= from) continue;
        const keepTo = Math.max(from, to);
        texts[i] = texts[i].slice(0, Math.max(0, from)) + (i === first ? e.text : '') + texts[i].slice(Math.max(0, keepTo));
        changed.add(i);
      }
    }
    for (const i of changed) splices.push({ start: p.nodes[i].start, end: p.nodes[i].end, xml: serialise(texts[i]) });
  }

  let out = xml;
  for (const s of splices.sort((a, b) => b.start - a.start)) out = out.slice(0, s.start) + s.xml + out.slice(s.end);
  return out;
}

/** The text of a part as a reader sees it: one line per paragraph. For checks and for tests. */
export function plainText(xml) {
  return scanParagraphs(xml).map((p) => p.text).join('\n');
}

export default { scanParagraphs, replaceRanges, plainText, decodeXml, encodeXml };
