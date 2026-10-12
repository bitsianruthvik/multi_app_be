/**
 * drawing_name_test.mjs — what a drawing's file name says (apps/cf_erp/lib/drawingName.js, and the
 * two hint readers exported from lib/nestDxfReader.js). Pure: no database.
 *
 *   cd multi_app_be && node scripts/cf_kepl/drawing_name_test.mjs
 *
 * The bracket grammar must read back EXACTLY what the frontend prints for a row's code
 * (multi_app_fe/src/apps/cf_erp/lib/codeSegments.ts — codeWithNumbers, numbersText, ownCodePart):
 * the printing rules are restated here as the screen has them, so a change on either side fails.
 */
import { parseDrawingName, matchCodePattern, tokenise, codeWithNumbers, numbersText, fileNameFor, splitPrinted, fileToken, fileNumbers } from '../../apps/cf_erp/lib/drawingName.js';
import { nameTokenHints, dxfTextHints } from '../../apps/cf_erp/lib/nestDxfReader.js';
import { segmentsOf } from '../../apps/cf_erp/services/placeholderService.js';
import { mergedCode } from './drawings-code-names.mjs';

let passed = 0; let failed = 0; const fails = [];
const ok = (name, cond, detail = '') => {
  if (typeof name !== 'string' || typeof cond !== 'boolean') throw new Error('ok(label, cond)');
  if (cond) { passed += 1; console.log(`  PASS  ${name}`); } else { failed += 1; fails.push(name); console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};
const section = (s) => console.log(`\n${s}`);
const J = JSON.stringify;

/* The screen's own printing rules (lib/codeSegments.ts), restated: the twin this file is held to. */
const MAX_LISTED = 6;
const feNumbers = (seg) => (seg.values && seg.values.length <= MAX_LISTED ? seg.values.join(',') : seg.from === seg.to ? String(seg.from) : `${seg.from}–${seg.to}`);
const fePrint = (code, segments) => (!segments?.length ? code : segments.map((s) => ('text' in s ? s.text : `(${feNumbers(s)})`)).join(''));
const stripLead = (s) => s.replace(/^[^A-Za-z0-9#(]+/, '');
/** ownCodePart, for segments whose parent's are a prefix (the only case the screen draws a chip for). */
const feOwnPart = (segments, parentSegments) => {
  let i = 0; let lead = '';
  for (; i < parentSegments.length; i++) {
    const p = parentSegments[i]; const c = segments[i];
    if ('text' in p && 'text' in c && i === parentSegments.length - 1 && c.text.startsWith(p.text) && c.text !== p.text) lead = c.text.slice(p.text.length);
  }
  const rest = [...(lead ? [{ text: lead }] : []), ...segments.slice(i)];
  if (rest[0] && 'text' in rest[0]) rest[0] = { text: stripLead(rest[0].text) };
  return fePrint('', rest.filter((s) => !('text' in s) || s.text));
};

const hole = (...values) => ({ from: Math.min(...values), to: Math.max(...values), ...(values.length <= 6 ? { values } : {}) });
const range = (from, to) => ({ from, to });
const reach = (name, rows) => { const p = parseDrawingName(name); return matchCodePattern(p.pattern, rows).map((h) => h.id); };

section('1. What the screen prints is what this side prints');
const cg = [{ text: 'SO260002-CG' }, hole(1, 2, 3), { text: '-L4' }];
ok('listed up to six: SO260002-CG(1,2,3)-L4', codeWithNumbers('SO260002-CG#-L4', cg) === 'SO260002-CG(1,2,3)-L4' && fePrint('SO260002-CG#-L4', cg) === 'SO260002-CG(1,2,3)-L4');
const idp = [{ text: 'IDP' }, range(1, 16)];
ok('more than six: a range with an EN DASH — IDP(1–16)', codeWithNumbers('IDP#', idp) === 'IDP(1–16)' && fePrint('IDP#', idp) === 'IDP(1–16)');
ok('one number is printed alone', numbersText(range(4, 4)) === '4' && feNumbers(range(4, 4)) === '4');
const samples = [
  ['SO1-CG#-L#-1-TFL1', [{ text: 'SO1-CG' }, hole(1, 2), { text: '-L' }, hole(1, 2, 3, 4, 5), { text: '-1-TFL1' }]],
  ['SO1-SPAN-01-#-G1-1-IS1-21', [{ text: 'SO1-SPAN-01-' }, hole(1, 2), { text: '-G1-1-IS1-21' }]],
  ['X-STF#', [{ text: 'X-STF' }, range(22, 45)]],
  ['PLAIN-CODE-7', null],
];
ok('codeWithNumbers is the screen\'s, character for character, on every shape', samples.every(([code, segs]) => codeWithNumbers(code, segs) === fePrint(code, segs)), J(samples.map(([code, segs]) => [codeWithNumbers(code, segs), fePrint(code, segs)])));
ok('placeholderService.segmentsOf cuts a code at its #s as the screen expects', J(segmentsOf('SO1-CG#-L4', null, null, [hole(1, 2, 3)])) === J([{ text: 'SO1-CG' }, hole(1, 2, 3), { text: '-L4' }]));

section('2. Every printed code reads back to its own row');
const rowsA = samples.map(([code, segs], i) => ({ id: i + 1, texts: [codeWithNumbers(code, segs)] }));
ok('the whole printed code, as a file name, finds its row and only it', samples.every((_, i) => J(reach(`${rowsA[i].texts[0]}.dxf`, rowsA)) === J([i + 1])), J(samples.map((_, i) => reach(`${rowsA[i].texts[0]}.dxf`, rowsA))));
ok('…and it is not partial: the name names every piece of the row', samples.every((_, i) => matchCodePattern(parseDrawingName(`${rowsA[i].texts[0]}.dxf`).pattern, rowsA).every((h) => !h.partial)));
const parent = [{ text: 'SO1-CG' }, hole(1, 2)];
const child = [{ text: 'SO1-CG' }, hole(1, 2), { text: '-L' }, hole(1, 2, 3, 4, 5)];
const leaf = [{ text: 'SO1-CG' }, hole(1, 2), { text: '-L' }, hole(1, 2, 3, 4, 5), { text: '-1-TFL1' }];
ok('the own-part chips the screen draws: L(1,2,3,4,5) and 1-TFL1', feOwnPart(child, parent) === 'L(1,2,3,4,5)' && feOwnPart(leaf, child) === '1-TFL1', `${feOwnPart(child, parent)} / ${feOwnPart(leaf, child)}`);
const structure = [
  { id: 10, texts: [fePrint('', parent)] }, { id: 20, texts: [fePrint('', child)] }, { id: 30, texts: [fePrint('', leaf)] },
  { id: 31, texts: ['SO1-CG(1,2)-L(1,2,3,4,5)-1-BFL1'] }, { id: 32, texts: ['SO1-CG(1,2)-L(1,2,3,4,5)-2-TFL1'] },
];
ok('a name built from the chips — L(1,2,3,4,5)-1-TFL1 — finds the leaf and nothing beside it', J(reach(`${feOwnPart(child, parent)}-${feOwnPart(leaf, child)}.dxf`, structure)) === J([30]));
ok('a chip alone names its row: L(1,2,3,4,5).dxf is the line row', J(reach(`${feOwnPart(child, parent)}.dxf`, structure)) === J([20]));

section('3. The grammar');
const p = parseDrawingName('L(1,5)-1-TFL1.dxf');
ok('L(1,5)-1-TFL1: three tokens, letters and numbers apart', p.kind === 'code' && p.base === 'L(1,5)-1-TFL1' && J(p.pattern) === J([[{ a: 'L' }, { n: [[1, 1], [5, 5]], many: true }], [{ n: [[1, 1]] }], [{ a: 'TFL' }, { n: [[1, 1]] }]]) && p.problems.length === 0, J(p.pattern));
ok('a range with a hyphen and with an en dash are the same', J(parseDrawingName('L(2-4).dxf').pattern) === J(parseDrawingName('L(2–4).dxf').pattern) && J(parseDrawingName('L(2-4).dxf').pattern[0][1].n) === J([[2, 4]]));
ok('items mix: (1,3-5,9)', J(parseDrawingName('G(1, 3-5 ,9).pdf').pattern[0][1].n) === J([[1, 1], [3, 5], [9, 9]]));
ok('separators — spaces, underscores, hyphens, several — count as one', J(tokenise('l(1,5) _ 1--tfl1')) === J(tokenise('L(1,5)-1-TFL1')));
ok('letters compare without case; a number is a number (01 = 1)', J(reach('l(1,5)-01-tfl001.DXF', structure)) === J([30]));
ok('a name without brackets is plain; one with is a code', parseDrawingName('TFL1.dxf').kind === 'plain' && parseDrawingName('TFL(1).dxf').kind === 'code' && parseDrawingName('.dxf').kind === 'empty');
const bad = [['L(1,5-1-TFL1.dxf', /never closed/], ['L(a).dxf', /not a number or a range/], ['L(5-2).dxf', /runs backwards/], ['L(1,,2).dxf', /empty number/], ['L1)-X.dxf', /never opened/]];
ok('brackets that do not read are said in words, and give no pattern', bad.every(([n, re]) => { const q = parseDrawingName(n); return q.pattern === null && re.test(q.problems.join(' ')); }), J(bad.map(([n]) => parseDrawingName(n).problems)));

section('4. Matching: the END of the code, at a token boundary, numbers by what they share');
const line = [
  { id: 1, texts: ['SO1-CG(1,2)-L(1,2,3,4,5)-1-TFL1'] },
  { id: 2, texts: ['SO1-CG(1,2)-L(1,2,3,4,5)-1-BFL1'] },
  { id: 3, texts: ['SO1-CG(1,2)-L(6–12)-1-TFL1'] },
  { id: 4, texts: ['SO1-CG(1,2)-L(1,2,3,4,5)-1-STFL1'] },
];
ok('L(1,5)-1-TFL1 reaches the row whose numbers it shares', J(reach('L(1,5)-1-TFL1.dxf', line)) === J([1]));
ok('L(5-7)-1-TFL1 reaches both rows it overlaps', J(reach('L(5-7)-1-TFL1.dxf', line)) === J([1, 3]));
ok('L(13)-1-TFL1 reaches none', reach('L(13)-1-TFL1.dxf', line).length === 0);
ok('TFL1 alone is the end of two rows\' codes; FL1 of none (a token matches whole)', J(reach('TFL1.dxf', line)) === J([1, 3]) && reach('FL1.dxf', line).length === 0);
ok('a suffix must start at a token boundary: 1-TFL1 yes, (5)-1-TFL1 no', J(reach('1-TFL1.dxf', line)) === J([1, 3]) && reach('(5)-1-TFL1.dxf', line).length === 0);
ok('a name longer than the code reaches nothing', reach('ZZ-SO1-CG(1,2)-L(1,2,3,4,5)-1-TFL1.dxf', line).length === 0);
const part = matchCodePattern(parseDrawingName('L(1,5)-1-TFL1.dxf').pattern, line)[0];
const whole = matchCodePattern(parseDrawingName('L(1-5)-1-TFL1.dxf').pattern, line)[0];
ok('naming only some numbers of a # is PARTIAL (the drawing still goes on the whole row — D5)', part.partial === true && whole.partial === false);
const frozenRows = [{ id: 7, texts: ['SO1-CG1-L1-1-TFL1', 'SO1-CG1-L5-1-TFL1', 'SO1-CG2-L1-1-TFL1'] }, { id: 8, texts: ['SO1-CG1-L2-1-TFL1'] }];
const fz = matchCodePattern(parseDrawingName('L(1,5)-1-TFL1.dxf').pattern, frozenRows);
ok('after the freeze the name is matched against REAL piece codes: 3 of the row\'s pieces, none of the other row\'s', fz.length === 1 && fz[0].id === 7 && fz[0].matched === 3 && fz[0].of === 3 && fz[0].partial === false, J(fz));
const fz2 = matchCodePattern(parseDrawingName('CG1-L(1,5)-1-TFL1.dxf').pattern, frozenRows);
ok('…and a name that names only some of its pieces is partial', fz2[0].matched === 2 && fz2[0].partial === true);

section('5. Thickness and grade in the name, and the mark as a fallback');
const h = parseDrawingName('L(1,5)-1-TFL1_25mm_E350.dxf');
ok('L(1,5)-1-TFL1_25mm_E350: the hints come out, the code stays', h.base === 'L(1,5)-1-TFL1' && h.hints.thicknessMm === 25 && h.hints.grade === 'E350' && J(h.pattern) === J(p.pattern), J(h));
ok('…the mark is tried whole, then without the hints', h.markFull === 'L(1,5)-1-TFL1-25MM-E350' && h.markStripped === 'L(1,5)-1-TFL1');
const m = parseDrawingName('TFL1_25mm_E350.dxf');
ok('TFL1_25mm_E350.dxf: mark TFL1, 25 mm, E350', m.kind === 'plain' && m.markStripped === 'TFL1' && m.markFull === 'TFL1-25MM-E350' && m.hints.thicknessMm === 25 && m.hints.grade === 'E350');
ok('the comma of a bracket is not a separator (finding F7)', J(nameTokenHints('L(1,5)-1-TFL1,t12').rest) === J(['L(1,5)-1-TFL1']) && nameTokenHints('L(1,5)-1-TFL1,t12').thicknessMm === 12);
ok('thickness as 25mm / 25thk / t25 / thk25 / 12.5mm', ['X_25mm', 'X_25thk', 'X_t25', 'X_thk25'].every((n) => nameTokenHints(n).thicknessMm === 25) && nameTokenHints('X_12.5mm').thicknessMm === 12.5);
ok('the FIRST token is never a hint: a part marked E350 keeps its mark', parseDrawingName('E350.dxf').markFull === 'E350' && parseDrawingName('E350.dxf').hints.grade === null && parseDrawingName('E350_E250.dxf').hints.grade === 'E250');
ok('a name with no hints has no stripped mark', parseDrawingName('Fst p1.dxf').markStripped === null && parseDrawingName('Fst p1.dxf').markFull === 'FST-P1' && parseDrawingName('Fst p1.dxf').base === 'Fst p1');
ok('fileNameFor builds the name back from a printed code, hints and all', fileNameFor('SO1-CG(1,2)-L(1,5)-1-TFL1', { skipTokens: 2, thicknessMm: 25, grade: 'E350' }) === 'L(1,5)-1-TFL1_25mm_E350.dxf' && J(splitPrinted('SO1-CG(1,2)-L(1–16)/1.TFL1')) === J(['SO1', 'CG(1,2)', 'L(1–16)', '1', 'TFL1']));
const made = fileNameFor(line[0].texts[0], { skipTokens: 2, thicknessMm: 12.5, grade: 'E250 BR' });
const madeBack = parseDrawingName(made);
ok(`…and what it builds reads back: ${made}`, J(matchCodePattern(madeBack.pattern, line).map((x) => x.id)) === J([1]) && madeBack.hints.thicknessMm === 12.5 && madeBack.hints.grade === 'E250BR');

section('6. What a drawing\'s own words say (dxfTextHints)');
const dxf = (...texts) => ['0', 'SECTION', '2', 'ENTITIES', ...texts.flatMap((t) => ['0', 'TEXT', '8', 'TITLE', '10', '0', '20', '0', '40', '5', '1', t]), '0', 'ENDSEC', '0', 'EOF'].join('\n');
ok('THK 25 and a grade in the title', J(dxfTextHints(dxf('TOP FLANGE TFL1', 'THK 25', 'MATERIAL E350 BR'))) === J({ thicknessMm: 25, grade: 'E350 BR', texts: 3 }));
ok('"PL 16" and "12 THK" read; a full size 12000 x 500 x 25 gives its smallest', dxfTextHints(dxf('PL 16')).thicknessMm === 16 && dxfTextHints(dxf('12 THK')).thicknessMm === 12 && dxfTextHints(dxf('12000 x 500 x 25')).thicknessMm === 25);
ok('a bare dimension is NOT a thickness (a part drawing is full of them)', dxfTextHints(dxf('150 mm', '2500', 'R 40')).thicknessMm === null);
ok('a file with no words, or that is no DXF, says nothing and does not throw', J(dxfTextHints(dxf())) === J({ thicknessMm: null, grade: null, texts: 0 }) && dxfTextHints('hello').thicknessMm === null && dxfTextHints(null).grade === null);

section('7. The rename helper\'s merge: several rows, one name');
const mc = (...texts) => mergedCode(texts, { tokenise, splitPrinted, fileToken });
ok('rows that differ in one number gather it into a bracket', J(mc('SO1-CG1-L1-1-TFL1', 'SO1-CG1-L5-1-TFL1')) === J(['SO1', 'CG1', 'L(1,5)', '1', 'TFL1']));
ok('brackets merge with brackets and with plain numbers', J(mc('SO1-CG(1,2)-L(1,2)-1-TFL1', 'SO1-CG(1,2)-L5-1-TFL1')) === J(['SO1', 'CG(1,2)', 'L(1,2,5)', '1', 'TFL1']));
ok('more than six numbers print as a range, or as ranges', J(mc(...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => `A-L${n}-X`))) === J(['A', 'L(1–8)', 'X']) && J(mc(...[1, 2, 3, 4, 7, 9, 10, 11].map((n) => `A-L${n}-X`))) === J(['A', 'L(1–4,7,9–11)', 'X']) && J(mc('A-L(1,2,3)-X', 'A-L5-X')) === J(['A', 'L(1–3,5)', 'X']));
ok('a token every row prints alike is kept exactly as printed (its zeros)', J(mc('SO1-SPAN-01-G1', 'SO1-SPAN-01-G2')) === J(['SO1', 'SPAN', '01', 'G(1,2)']));
ok('rows that differ in more than numbers cannot share a name', mc('SO1-L1-TFL1', 'SO1-L1-BFL1') === null && mc('SO1-L1-TFL1', 'SO1-L1-1-TFL1') === null);
ok('what the merge prints reads back to every row it was made from', (() => { const t = ['SO1-CG1-L1-1-TFL1', 'SO1-CG1-L5-1-TFL1']; const name = `${mc(...t).slice(2).join('-')}.dxf`; return J(reach(name, t.map((x, i) => ({ id: i, texts: [x] })))) === J([0, 1]) && name === 'L(1,5)-1-TFL1.dxf'; })());

section('8. File names: a run of three or more numbers is a range (user, 2026-10-12)');
ok('L(1,2,3,4,5)-1-TFL1 → L(1–5)-1-TFL1', fileNameFor('L(1,2,3,4,5)-1-TFL1') === 'L(1–5)-1-TFL1.dxf' && J(mc('SO1-L(1,2,3,4,5)-1-TFL1').slice(1)) === J(['L(1–5)', '1', 'TFL1']));
ok('IS1-(8,9,10,12) → IS1-(8–10,12)', fileNameFor('IS1-(8,9,10,12)') === 'IS1-(8–10,12).dxf');
ok('EDP(1,2,4,5,6,8) → EDP(1,2,4–6,8)', fileNameFor('EDP(1,2,4,5,6,8)') === 'EDP(1,2,4–6,8).dxf' && fileNumbers([1, 2, 4, 5, 6, 8]) === '1,2,4–6,8');
ok('two in a row stay listed: L(1,2), L(2,4)', fileToken('L(1,2)') === 'L(1,2)' && fileToken('L(2,4)') === 'L(2,4)' && fileToken('L(1–16)') === 'L(1–16)' && fileToken('TFL1') === 'TFL1');
const nameRows = [
  { id: 1, texts: ['SO1-L(1,2,3,4,5)-1-TFL1'] }, { id: 2, texts: ['SO1-IS1-(8,9,10,12)'] }, { id: 3, texts: ['SO1-EDP(1,2,4,5,6,8)'] },
  { id: 4, texts: ['SO1-EDP(3,7)'] }, { id: 5, texts: ['SO1-IS1-(11)'] }, { id: 6, texts: ['SO1-L(6,7)-1-TFL1'] },
];
ok('each of those names reads back to its own row, whole — not partial', [['L(1–5)-1-TFL1.dxf', 1], ['IS1-(8–10,12).dxf', 2], ['EDP(1,2,4–6,8).dxf', 3]].every(([n, id]) => { const hit = matchCodePattern(parseDrawingName(n).pattern, nameRows); return hit.length === 1 && hit[0].id === id && hit[0].partial === false; }));
ok('the mixed list (1,2,4–6,8) parses to its numbers', J(parseDrawingName('EDP(1,2,4–6,8).dxf').pattern[0][1].n) === J([[1, 1], [2, 2], [4, 6], [8, 8]]));
ok('the hyphen form reads the same rows as the en dash: (4-6) / (4–6), (1,2,4-6,8), (8-10,12), (1-5)', J(reach('EDP(4-6).dxf', nameRows)) === J(reach('EDP(4–6).dxf', nameRows)) && J(reach('EDP(4-6).dxf', nameRows)) === J([3]) && J(reach('EDP(1,2,4-6,8).dxf', nameRows)) === J([3]) && J(reach('IS1-(8-10,12).dxf', nameRows)) === J([2]) && J(reach('L(1-5)-1-TFL1.dxf', nameRows)) === J([1]));

console.log(`\n${passed} passed, ${failed} failed`);
if (fails.length) console.log(`failed: ${fails.join(' | ')}`);
process.exitCode = failed ? 1 : 0;
