/**
 * stage-applicability-test.mjs — does a line type really skip a stage?
 *
 * Usage: node scripts/kepl/stage-applicability-test.mjs <companyId>
 *
 * Builds two throwaway orders — one Composite Girder, one PEB — configures the
 * PEB line type to skip nesting, and checks the four things that would actually
 * hurt if they were wrong:
 *
 *   - an unconfigured tenant behaves exactly as it did before
 *   - the skipped stage reads "not relevant", is NOT hidden, and stops gating
 *   - the OTHER line type is untouched
 *   - a mixed order does not switch the gate off for everybody
 */

import { pool } from '../../db.js';
import { STAGE_KEYS } from '../../apps/fab_erp/services/orderReadinessService.js';
import {
  loadStageRules, applicabilityFor, setStageRules, orderStageApplicability,
} from '../../apps/fab_erp/services/stageApplicabilityService.js';

const companyId = Number(process.argv[2]);
if (!companyId) { console.error('Usage: node scripts/kepl/stage-applicability-test.mjs <companyId>'); process.exit(1); }

const stamp = Date.now().toString().slice(-6);
const log = (m) => console.log(m);
let fail = 0;
const check = (label, ok, detail = '') => {
  log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) fail++;
};
const made = [];

async function order(lineTypes) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[plant]] = await conn.query(
      'SELECT id FROM fab_plants WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [companyId],
    );
    const [o] = await conn.query(
      `INSERT INTO fab_orders (company_id, order_number, order_type, status, plant_id, notes,
         created_at, updated_at)
       VALUES (?,?, 'sales', 'draft', ?, 'throwaway: stage applicability test', NOW(), NOW())`,
      [companyId, `SO-STAGE${made.length}-${stamp}`, plant?.id ?? null],
    );
    let n = 0;
    for (const t of lineTypes) {
      n++;
      await conn.query(
        `INSERT INTO fab_order_lines (company_id, order_id, line_no, code, description, qty, unit,
           status, line_type, created_at, updated_at)
         VALUES (?,?,?,?,?,1,'nos','open',?,NOW(),NOW())`,
        [companyId, o.insertId, n, `L${n}`, `${t} line`, t],
      );
    }
    await conn.commit();
    made.push(o.insertId);
    return o.insertId;
  } finally { conn.release(); }
}

const nameOf = (m, key) => m.get(key)?.applicability;

try {
  // ── 1. an unconfigured tenant is unchanged ────────────────────────────────
  const before = await loadStageRules(companyId);
  const cgOrder = await order(['Composite Girder']);
  const pebOrder = await order(['PEB']);
  const mixed = await order(['Composite Girder', 'PEB']);

  let cg = await orderStageApplicability(companyId, cgOrder, STAGE_KEYS);
  check('with no rules, every stage is required',
    STAGE_KEYS.every((k) => nameOf(cg, k) === 'required'),
    `${before.length} pre-existing rule(s)`);

  // ── 2. configure PEB to skip nesting ──────────────────────────────────────
  await setStageRules(companyId, 'PEB', [
    { stageKey: 'nesting', applicability: 'not_applicable', notes: 'PEB members are rolled sections, not cut from plate' },
    { stageKey: 'params', applicability: 'optional' },
    { stageKey: 'boq', applicability: 'required' },
  ]);
  const rules = await loadStageRules(companyId);
  check('only the DIFFERENCES from default are stored', rules.length === before.length + 2,
    `${rules.length - before.length} row(s) for 3 entries — 'required' stores nothing`);

  const peb = applicabilityFor(rules, STAGE_KEYS, 'PEB');
  check('PEB skips nesting', nameOf(peb, 'nesting') === 'not_applicable');
  check('PEB has params optional', nameOf(peb, 'params') === 'optional');
  check('PEB keeps every other stage required',
    STAGE_KEYS.filter((k) => !['nesting', 'params'].includes(k)).every((k) => nameOf(peb, k) === 'required'));
  check('the reason is carried, not just the flag',
    /rolled sections/.test(peb.get('nesting').notes ?? ''), peb.get('nesting').notes ?? '');

  // ── 3. the other type is untouched ────────────────────────────────────────
  const cgRules = applicabilityFor(rules, STAGE_KEYS, 'Composite Girder');
  check('Composite Girder is completely unaffected',
    STAGE_KEYS.every((k) => nameOf(cgRules, k) === 'required'));

  // ── 4. the order-level answers ────────────────────────────────────────────
  const pebOrd = await orderStageApplicability(companyId, pebOrder, STAGE_KEYS);
  check('a PEB-only order reports nesting not relevant',
    nameOf(pebOrd, 'nesting') === 'not_applicable');

  const mixedOrd = await orderStageApplicability(companyId, mixed, STAGE_KEYS);
  check('a MIXED order still requires nesting — one line needs it',
    nameOf(mixedOrd, 'nesting') === 'required',
    `mixed flag ${mixedOrd.get('nesting').mixed}`);
  check('and it says the order is mixed rather than pretending it is uniform',
    mixedOrd.get('nesting').mixed === true);

  // ── 5. does readiness actually stop gating? ───────────────────────────────
  const { orderReadiness } = await import('../../apps/fab_erp/services/orderReadinessService.js');
  const r = await orderReadiness(companyId, pebOrder);
  const nest = r.stages.find((s) => s.key === 'nesting');
  check('readiness reports the stage, it does not hide it',
    !!nest && r.stages.length === STAGE_KEYS.length, `${r.stages.length} stages`);
  check("its state reads 'not_applicable'", nest?.state === 'not_applicable', nest?.state);
  check('the detail says why', /Not relevant/.test(nest?.detail ?? ''), nest?.detail ?? '');
  check('nextStage skips over it', r.nextStage !== 'nesting', String(r.nextStage));

  // ── 6. cleanup of the rules themselves ────────────────────────────────────
  await setStageRules(companyId, 'PEB', []);
  const after = await loadStageRules(companyId);
  check('clearing a line type removes its rules', after.length === before.length,
    `${after.length} vs ${before.length}`);
} catch (err) {
  fail++;
  console.error(`\nERROR: ${err.message}\n${err.stack?.split('\n').slice(1, 4).join('\n')}`);
} finally {
  for (const o of made) {
    await pool.query('UPDATE fab_order_lines SET deleted_at = NOW() WHERE company_id = ? AND order_id = ?', [companyId, o]);
    await pool.query('UPDATE fab_orders SET deleted_at = NOW() WHERE id = ? AND company_id = ?', [o, companyId]);
  }
  log(fail ? `\n${fail} CHECK(S) FAILED\n` : '\nall stage-applicability checks passed\n');
  await pool.end();
  process.exitCode = fail ? 1 : 0;
}
