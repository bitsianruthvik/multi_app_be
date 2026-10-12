/**
 * drawings-code-names.mjs — the drawings an order ALREADY has, renamed the way the new logic names
 * one: by the code of the rows it belongs to (CF_ERP_LINKED_COPIES_PLAN.md — "file names with
 * brackets as an explicit route").
 *
 * Until 2026-10-12 a drawing was matched by its DRAWING MARK only, so the files of an order built
 * before then are named by mark (TFL1.dxf). A file is now matched first by its NAME as the end of
 * its rows' code, the way the screen prints it — L(1,5)-1-TFL1.dxf — with the thickness and grade
 * it is for when they are known: L(1,5)-1-TFL1_25mm_E350.dxf. This works that name out for every
 * saved drawing of an order from the rows it is on, and (with --apply) stores it.
 *
 *   node scripts/cf_kepl/drawings-code-names.mjs --company 30005 --order SO260002            (dry run: rolled back)
 *   node scripts/cf_kepl/drawings-code-names.mjs --company 30005 --order SO260002 --apply    (commits)
 *
 * THE NAME. The rows a file is on (by its mark, or through its register drawing) are printed as
 * their codes; where they differ only in a number, the numbers go into one bracket — rows
 * …-L(1)-1-TFL1 and …-L(5)-1-TFL1 give L(1,5)-1-TFL1. Of that code the SHORTEST END is taken that
 * reaches exactly those rows and no other row of the line (so the order number and whatever every
 * row shares are left off). Thickness and grade are added (_25mm_E350) only when every row of the
 * file agrees on them. The answer is then READ BACK with the upload's own parser and matcher
 * (lib/drawingName.js) and must find exactly the same rows — a name that would not is never written.
 *
 * WHAT CHANGES, AND WHAT DOES NOT
 *   changes   cf_part_drawings.file_name; and the register drawing's NUMBER when it was made from
 *             the mark (ORDER/MARK, ORDER/Ln/MARK — every revision of that sheet, so its history
 *             stays one drawing).
 *   stays     the file's contents and shape, its revisions, its MARK (kept as the fallback the old
 *             matching reads — the rows' DRAWING_MARK still finds it), every link to a row.
 * So nothing is unlinked: a row sees the same drawing before and after.
 *
 * LEFT ALONE, AND SAID: a file on no row; a file whose rows cannot be named by one code (they
 * differ in more than numbers); a name another file of the line already takes; a file already
 * named by its code (a second run changes nothing). A line RELEASED to production is refused — its
 * drawings no longer change. Round trips: a fixed number per line, ONE UPDATE of the file names and
 * ONE of the numbers for the whole order.
 */
import { pathToFileURL } from 'url';

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The numbers of one atom, printed between brackets the way lib/codeSegments.ts would: listed up to six, else ranges. */
function bracketOf(values) {
  const v = [...new Set(values)].sort((a, b) => a - b);
  if (v.length <= 6) return v.join(',');
  const runs = [];
  for (const x of v) { const last = runs[runs.length - 1]; if (last && x === last[1] + 1) last[1] = x; else runs.push([x, x]); }
  return runs.length === 1 ? `${runs[0][0]}–${runs[0][1]}` : runs.map(([a, b]) => (a === b ? String(a) : `${a}-${b}`)).join(',');
}

/**
 * Several rows' codes as ONE printed code: the same tokens, with the numbers that differ gathered
 * into one bracket. `texts`: each row's code as printed (with its own brackets). null when the rows
 * are not the same code but for numbers.
 */
export function mergedCode(texts, { tokenise, splitPrinted, fileToken = (x) => x }) {
  const rows = texts.map((t) => ({ parts: splitPrinted(t), tokens: tokenise(t) }));
  const first = rows[0];
  if (!first || rows.some((r) => r.tokens.length !== first.tokens.length || r.parts.length !== first.tokens.length)) return null;
  const out = [];
  for (let i = 0; i < first.tokens.length; i++) {
    const atoms = first.tokens[i];
    if (rows.some((r) => r.tokens[i].length !== atoms.length || r.tokens[i].some((a, k) => (a.a != null) !== (atoms[k].a != null) || (a.a != null && a.a !== atoms[k].a)))) return null;
    // Every row prints this token the same way: it is kept exactly as printed (its zeros, its case).
    if (rows.every((r) => r.parts[i] === first.parts[i])) { out.push(fileToken(first.parts[i])); continue; }   // (a bracket is rewritten the file-name way: runs of three or more as a range)
    let text = '';
    for (let k = 0; k < atoms.length; k++) {
      if (atoms[k].a != null) { text += atoms[k].a; continue; }
      const all = rows.flatMap((r) => r.tokens[i][k].n);
      if (all.some(([lo, hi]) => hi - lo > 5000)) return null;
      const values = all.flatMap(([lo, hi]) => Array.from({ length: hi - lo + 1 }, (_, j) => lo + j));
      const set = [...new Set(values)];
      text += set.length === 1 && !rows.some((r) => r.tokens[i][k].many) ? String(set[0]) : fileToken(`(${[...set].sort((a, b) => a - b).join(',')})`);
    }
    out.push(text);
  }
  return out;
}

/**
 * The whole pass on a connection the caller owns (its transaction).
 * → { order, lines: [{ lineId, lineNo, status, files: [{ id, old, name, status, why, rows, number? }] }], totals }
 *   status  'rename' | 'same' (already named by its code) | 'kept' (left alone — `why`)
 */
export async function codeNames(db, { companyId, orderCode, log = console.log }) {
  const { rowsOfLine, codeRowsOfLine, normMark } = await import('../../apps/cf_erp/services/partDrawingService.js');
  const { parseDrawingName, matchCodePattern, tokenise, splitPrinted, fileToken } = await import('../../apps/cf_erp/lib/drawingName.js');

  const [orders] = await db.query(
    'SELECT id, code, status, revision FROM cf_sales_orders WHERE company_id = ? AND code = ? AND deleted_at IS NULL ORDER BY revision DESC, id DESC',
    [companyId, orderCode],
  );
  if (!orders.length) throw new Error(`No order ${orderCode} in company ${companyId}.`);
  const order = orders.find((o) => o.status !== 'revised') ?? orders[0];
  const [lines] = await db.query(
    `SELECT l.id, l.order_id, l.line_no, l.line_type, l.item_id, l.quantity, l.locked_at, o.code AS order_code,
            EXISTS (SELECT 1 FROM cf_production_releases r WHERE r.company_id = l.company_id AND r.order_line_id = l.id AND r.deleted_at IS NULL) AS released,
            (SELECT COUNT(*) FROM cf_part_drawings d WHERE d.company_id = l.company_id AND d.order_line_id = l.id AND d.deleted_at IS NULL) AS files
       FROM cf_sales_order_lines l JOIN cf_sales_orders o ON o.id = l.order_id
      WHERE l.company_id = ? AND l.order_id = ? AND l.deleted_at IS NULL
      ORDER BY l.line_no, l.id`,
    [companyId, order.id],
  );
  const out = { order: { id: order.id, code: order.code }, lines: [], totals: { files: 0, renamed: 0, same: 0, kept: 0, numbers: 0, refused: 0 } };
  const fileMoves = [];     // [fileId, new file name]
  const numberMoves = [];   // [root drawing id, new number]
  log(`${order.code}${Number(order.revision) > 1 ? ` rev ${order.revision}` : ''} — drawings named by the code of their rows`);
  for (const line of lines) {
    if (!Number(line.files)) continue;
    const rep = { lineId: line.id, lineNo: line.line_no, status: 'ok', files: [] };
    out.lines.push(rep);
    if (Number(line.released)) {
      rep.status = 'released'; out.totals.refused += Number(line.files);
      log(`  line ${line.line_no}: REFUSED — it is released to production; its ${plural(Number(line.files), 'drawing')} no longer change.`);
      continue;
    }
    const rows = await rowsOfLine(db, companyId, line);
    const [files] = await db.query(
      `SELECT d.id, d.drawing_id, d.mark, d.mark_norm, d.file_name, d.file_kind,
              g.number, g.source, COALESCE(g.root_id, g.id) AS root_id
         FROM cf_part_drawings d LEFT JOIN cf_drawings g ON g.id = d.drawing_id
        WHERE d.company_id = ? AND d.order_line_id = ? AND d.deleted_at IS NULL ORDER BY d.mark_norm, d.id`,
      [companyId, line.id],
    );
    const coded = await codeRowsOfLine(db, companyId, line, rows.map((p) => p.id));
    const codeRows = coded.rows;
    const textsOf = new Map(codeRows.map((r) => [r.id, r.texts]));
    // The grade each row holds, in words (rowsOfLine reads the sizes; a grade is a pick-list).
    const [grades] = rows.length ? await db.query(
      `SELECT v.subject_id, COALESCE(o.value, v.value_text) AS grade
         FROM cf_spec_values v JOIN cf_specifications s ON s.id = v.specification_id AND s.code = 'GRADE'
         LEFT JOIN cf_spec_options o ON o.id = v.option_id
        WHERE v.company_id = ? AND v.subject_type = 'master' AND v.deleted_at IS NULL AND v.subject_id IN (?)`,
      [companyId, rows.map((p) => p.id)],
    ) : [[]];
    const gradeOf = new Map(grades.map((g) => [Number(g.subject_id), g.grade]));
    const labelOf = (p) => (textsOf.get(p.id)?.length === 1 ? textsOf.get(p.id)[0] : p.mark ? `${p.name} (${p.mark})` : p.name);
    const takenNames = new Set(files.map((f) => String(f.file_name).toLowerCase()));
    log(`  line ${line.line_no}: ${plural(files.length, 'drawing')}${coded.frozen ? ' (the design is frozen: named by the real piece codes)' : ''}`);

    for (const f of files) {
      out.totals.files += 1;
      const mine = rows.filter((p) => (p.markNorm && p.markNorm === f.mark_norm) || (f.drawing_id != null && p.drawingIds.includes(Number(f.drawing_id))));
      const entry = { id: Number(f.id), old: f.file_name, name: f.file_name, status: 'kept', why: null, rows: mine.map((p) => ({ id: p.id, label: labelOf(p) })) };
      rep.files.push(entry);
      const keep = (why) => { entry.why = why; out.totals.kept += 1; log(`    ${f.file_name}  — kept: ${why}`); };
      if (!mine.length) { keep('it is on no row of this line.'); continue; }
      const texts = mine.flatMap((p) => textsOf.get(p.id) ?? []);
      if (texts.length < mine.length || mine.some((p) => !(textsOf.get(p.id) ?? []).length)) { keep(`${mine.length === 1 ? 'its row has' : 'some of its rows have'} no code to name it by (a row that makes no piece).`); continue; }
      const merged = mergedCode(texts, { tokenise, splitPrinted, fileToken });
      if (!merged) { keep(`its ${plural(mine.length, 'row')} cannot be named by one code — they differ in more than numbers (${mine.slice(0, 3).map(labelOf).join(' / ')}${mine.length > 3 ? ' …' : ''}).`); continue; }
      const want = new Set(mine.map((p) => p.id));
      const reaches = (name) => {
        const p = parseDrawingName(name);
        if (!p.pattern) return null;
        const hit = matchCodePattern(p.pattern, codeRows);
        return hit.length === want.size && hit.every((h) => want.has(h.id)) ? p : null;
      };
      // The shortest end of the code that reaches exactly these rows.
      let base = null;
      // (An end that starts with a bare number — the "2" of TFL1-2 — is not a name: it must start with letters.)
      for (let k = 1; k <= merged.length && !base; k++) { const cand = merged.slice(merged.length - k).join('-'); if (/^[A-Za-z]/.test(cand) && reaches(`${cand}.${f.file_kind ?? 'dxf'}`)) base = cand; }
      if (!base) { keep(`no code reaches exactly its ${plural(mine.length, 'row')} — other rows of the line print the same code (${merged.join('-')}).`); continue; }
      // Thickness and grade, when every row of the file agrees — and only if the name still reads back.
      const thick = new Set(mine.map((p) => p.thicknessMm ?? null));
      const grade = new Set(mine.map((p) => gradeOf.get(p.id) ?? null));
      const t = thick.size === 1 && [...thick][0] != null ? Number([...thick][0]) : null;
      const g = grade.size === 1 && [...grade][0] ? String([...grade][0]).replace(/[\s_]+/g, '') : null;
      const ext = (f.file_kind ?? 'dxf').toLowerCase();
      const withHints = `${base}${t != null ? `_${t}mm` : ''}${g ? `_${g}` : ''}.${ext}`;
      const back = reaches(withHints);
      const good = back && (t == null || back.hints.thicknessMm === t) && (!g || back.hints.grade === g.toUpperCase());
      const name = good ? withHints : `${base}.${ext}`;
      if (name === f.file_name) { entry.status = 'same'; out.totals.same += 1; log(`    ${f.file_name}  — already named by its code`); continue; }
      if (takenNames.has(name.toLowerCase())) { keep(`another drawing of this line is already called ${name}.`); continue; }
      takenNames.add(name.toLowerCase());
      entry.name = name; entry.status = 'rename';
      out.totals.renamed += 1;
      fileMoves.push([Number(f.id), name.slice(0, 255)]);
      // The register number, when it was made from the mark: ORDER/MARK, ORDER/Ln/MARK (-n).
      const stem = name.replace(/\.(dxf|pdf)$/i, '').replace(/_.*$/, '');
      if (f.number && f.source === 'shop') {
        // (partDrawingService.freeNumber's shapes; "-n" is only its tie-breaker when the mark alone does not say it.)
        const head = [`${order.code}/L${line.line_no}/`, `${order.code}/`].find((h) => String(f.number).toLowerCase().startsWith(h.toLowerCase()));
        const rest = head ? String(f.number).slice(head.length) : null;
        const fromMark = rest != null && (normMark(rest) === f.mark_norm || normMark(rest.replace(/-\d+$/, '')) === f.mark_norm);
        if (fromMark && normMark(rest) !== normMark(stem)) {
          entry.number = { from: f.number, to: `${head}${stem}`.slice(0, 150) };
          numberMoves.push({ root: Number(f.root_id), ...entry.number });
        }
      }
      log(`    ${f.file_name}  →  ${name}${entry.number ? `     (register ${entry.number.from} → ${entry.number.to})` : ''}`);
      log(`        ${plural(mine.length, 'row')}: ${mine.slice(0, 6).map(labelOf).join(', ')}${mine.length > 6 ? ` … +${mine.length - 6}` : ''}`);
    }
  }

  // ---- the writes: ONE UPDATE of the names, ONE of the numbers (after one read of the numbers in use) ----
  if (fileMoves.length) {
    const params = [];
    const whens = fileMoves.map(([id, name]) => { params.push(id, name); return 'WHEN ? THEN ?'; }).join(' ');
    params.push(companyId, fileMoves.map(([id]) => id));
    await db.query(`UPDATE cf_part_drawings SET file_name = CASE id ${whens} END WHERE company_id = ? AND id IN (?) AND deleted_at IS NULL`, params);
  }
  if (numberMoves.length) {
    // A number another shop drawing already has is not taken; two files of this run wanting one number: the first has it.
    const [used] = await db.query("SELECT LOWER(number) AS n, COALESCE(root_id, id) AS root FROM cf_drawings WHERE company_id = ? AND source = 'shop' AND deleted_at IS NULL AND LOWER(number) IN (?)", [companyId, numberMoves.map((m) => m.to.toLowerCase())]);
    const taken = new Map(used.map((u) => [u.n, Number(u.root)]));
    const ok = [];
    for (const m of numberMoves) {
      const k = m.to.toLowerCase();
      if (taken.has(k) && taken.get(k) !== m.root) { log(`    register ${m.from}: kept — ${m.to} is another drawing's number.`); continue; }
      taken.set(k, m.root);
      ok.push(m);
    }
    if (ok.length) {
      const params = [];
      const whens = ok.map((m) => { params.push(m.root, m.to); return 'WHEN ? THEN ?'; }).join(' ');
      params.push(companyId, ok.map((m) => m.root), ok.map((m) => m.root));
      await db.query(`UPDATE cf_drawings SET number = CASE COALESCE(root_id, id) ${whens} END WHERE company_id = ? AND (root_id IN (?) OR id IN (?)) AND deleted_at IS NULL`, params);
      out.totals.numbers = ok.length;
    }
  }
  const t = out.totals;
  log(`${plural(t.files, 'drawing')} · ${t.renamed} renamed · ${t.same} already named by code · ${t.kept} kept as they are · ${plural(t.numbers, 'register number')} changed${t.refused ? ` · ${t.refused} on released lines refused` : ''}`);
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
  const COMPANY = Number(arg('company'));
  const ORDER = arg('order');
  const APPLY = process.argv.includes('--apply');
  if (!Number.isInteger(COMPANY) || !ORDER) throw new Error('Usage: --company <id> --order <code> [--apply]');
  const { pool } = await import('../../db.js');
  await import('../../apps/cf_erp/services/codegenProvider.js');   // the code previews use the app's coding rules
  const db = await pool.getConnection();
  try {
    await db.beginTransaction();
    const out = await codeNames(db, { companyId: COMPANY, orderCode: ORDER });
    if (APPLY) { await db.commit(); console.log('COMMITTED'); } else { await db.rollback(); console.log('DRY RUN — rolled back. Add --apply to keep it.'); }
    if (out.totals.refused) process.exitCode = 2;
  } catch (err) {
    await db.rollback().catch(() => {});
    console.error('ERROR', err.message);
    process.exitCode = 1;
  } finally {
    db.release();
    await pool.end();
  }
}
