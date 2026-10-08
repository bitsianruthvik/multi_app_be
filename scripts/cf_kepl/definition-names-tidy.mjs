/**
 * definition-names-tidy.mjs — one style for definition names (user, 2026-10-08: "all sorts of caps,
 * no-caps, all caps … and short forms like Inter. — they will look bad to use").
 *
 * The style is the one the original definitions use ("Top flange", "End diaphragm"): sentence case,
 * a SINGULAR noun, words written out (Inter. → Intermediate, Diaph. → diaphragm, Long. →
 * longitudinal, ED / ID → end / intermediate diaphragm, G&A → girder–arch), acronyms kept in
 * capitals (ISMB), and a variant in brackets ("Bearing stiffener (holed)"). Codes and short names
 * are not touched — only the name people read.
 *
 *   node scripts/cf_kepl/definition-names-tidy.mjs --company 30005            (dry run: rolled back)
 *   node scripts/cf_kepl/definition-names-tidy.mjs --company 30005 --apply    (commits)
 *   node scripts/cf_kepl/definition-names-tidy.mjs --preview "<name>"         (just shows the rule)
 * Re-running changes nothing. Items already made on orders keep their names; new ones take the new.
 */
const ACRONYMS = new Set(['ISMB', 'ISA', 'ISMC', 'BO', 'BR', 'CNC']);
/** Written out first, before the case is set. */
const WORDS = [
  [/\bInter\.\s*/gi, 'Intermediate '], [/\bDiaph\.\s*/gi, 'diaphragm '], [/\bLong\.\s*/gi, 'longitudinal '],
  [/\bG\s*&\s*A\b/g, 'girder–arch'], [/\bED\b/g, 'end diaphragm'], [/\bID\b/g, 'intermediate diaphragm'],
  [/\s*&\s*/g, ' and '], [/\s+-\s+/g, ' '],
];
/** Plural words that should be singular in a definition's name. */
const SINGULAR = new Map(Object.entries({
  cleats: 'cleat', supports: 'support', stiffeners: 'stiffener', stoppers: 'stopper', brackets: 'bracket',
  frames: 'frame', plates: 'plate', bracings: 'bracing', splices: 'splice',
}));
/** Where the rule cannot know what is meant. By code. */
const EXACT = {
  BBL: 'Bottom lateral bracing member',
  MBM: 'ISMB 600 beam',
  BSH: 'Bearing stiffener (holed)', BSP: 'Bearing stiffener (plain)',
  ESH: 'End stiffener (holed)', ESP: 'End stiffener (plain)',
  ISH: 'Intermediate stiffener (holed)', ISP: 'Intermediate stiffener (plain)',
  TSL: 'Top stiffener (left)', TSR: 'Top stiffener (right)',
  HTL: 'Hanger support top stiffener (left)', HTR: 'Hanger support top stiffener (right)',
  CGS: 'Centre gusset',
};

export function tidyName(name, code = null) {
  if (code && EXACT[code]) return EXACT[code];
  let s = String(name).replace(/_/g, ' ').trim();
  for (const [re, to] of WORDS) s = s.replace(re, to);
  const words = s.split(/\s+/).filter(Boolean).map((w, i) => {
    const bare = w.replace(/[()]/g, '');
    if (ACRONYMS.has(bare.toUpperCase()) && /^[A-Z]+$/.test(bare)) return w.toUpperCase();
    let lw = w.toLowerCase();
    const key = lw.replace(/[()]/g, '');
    if (SINGULAR.has(key)) lw = lw.replace(key, SINGULAR.get(key));
    if (/^x-frame$/.test(lw)) lw = 'x-frame';
    return i === 0 ? lw.charAt(0).toUpperCase() + lw.slice(1) : lw;
  });
  return words.join(' ').replace(/\s+\)/g, ')').replace(/\(\s+/g, '(');
}

const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
if (arg('preview')) { console.log(tidyName(arg('preview'))); process.exit(0); }
const COMPANY = Number(arg('company'));
const APPLY = process.argv.includes('--apply');
if (!Number.isInteger(COMPANY)) throw new Error('Usage: --company <id> [--apply]  |  --preview "<name>"');

const { pool } = await import('../../db.js');
const db = await pool.getConnection();
try {
  await db.beginTransaction();
  const [defs] = await db.query("SELECT id, code, name FROM cf_master_records WHERE company_id = ? AND record_kind = 'definition' AND deleted_at IS NULL ORDER BY code", [COMPANY]);
  let changed = 0;
  const seen = new Map();
  for (const d of defs) {
    const next = tidyName(d.name, d.code);
    const k = next.toLowerCase();
    if (seen.has(k)) console.log(`  ! ${d.code} and ${seen.get(k)} would both be "${next}"`);
    seen.set(k, d.code);
    if (next === d.name) continue;
    await db.query('UPDATE cf_master_records SET name = ? WHERE company_id = ? AND id = ?', [next, COMPANY, d.id]);
    changed++;
    console.log(`  ${d.code.padEnd(10)} ${d.name}  →  ${next}`);
  }
  console.log(`${changed} of ${defs.length} definition names changed`);
  if (APPLY) { await db.commit(); console.log('COMMITTED'); } else { await db.rollback(); console.log('DRY RUN — rolled back. Add --apply to keep it.'); }
} catch (err) {
  await db.rollback();
  console.error('ERROR', err.message);
  process.exitCode = 1;
} finally {
  db.release();
  await pool.end();
}
