/**
 * Two corrections the order rebuild exposed.
 *
 * 1. PART_FUNCTION was `entered`, so it was NOT inherited from the definition.
 *    resolutionService reads a value from above only for `defaulted` and
 *    `fixed`; `entered` reads the item's own row and nothing else. So every
 *    part temporary resolved with PART_FUNCTION missing and could never be
 *    activated. `defaulted` is the right rule: the definition says what the
 *    part IS, each instance inherits it, and an instance can still override.
 *    Not `fixed`, which would have to carry one value for every part on the
 *    classification node — the whole point is that each definition differs.
 *
 * 2. CFFB-PLATEPART had no `kind` condition, so it also caught TEMPORARY
 *    parts. It renders {shortName}-{T}X{L}X{W}-{GRADE} with no sequence, so
 *    the second identical top flange on an order collided on uq_cmr_code with
 *    a raw ER_DUP_ENTRY — a MySQL error, not a refusal anyone could read.
 *    A size-based code belongs to a catalog type; an order's instance gets its
 *    order-scoped code from CFTMP-PART, which has a sequence.
 */
import path from 'path';
import { pathToFileURL } from 'url';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
await imp('apps/cf_erp/services/codegenProvider.js');
const rules = await imp('apps/cf_erp/services/assignmentService.js');
const codegen = await imp('apps/cf_erp/modules/codegen/service.js');
const { attachNodeCache, detachNodeCache } = await imp('apps/cf_erp/lib/db.js');

const COMPANY = Number(process.env.CF_BRIDGE_COMPANY ?? 2);
const c = { companyId: COMPANY, userId: Number(process.env.CF_BRIDGE_USER ?? 22) };
const say = (...a) => console.log(...a);

const conn = await pool.getConnection();
try {
  await conn.beginTransaction();
  attachNodeCache(conn);

  // --- 1. PART_FUNCTION: entered -> defaulted -------------------------------
  const [[rule]] = await conn.query(
    `SELECT a.id, a.value_rule FROM cf_spec_assignments a
       JOIN cf_specifications s ON s.id = a.specification_id
       JOIN cf_classification_nodes n ON n.id = a.subject_id AND a.subject_type = 'classification'
      WHERE a.company_id = ? AND s.code = 'PART_FUNCTION' AND n.code = 'FAB_PARTS' AND a.deleted_at IS NULL`,
    [COMPANY]);
  if (!rule) say('  PART_FUNCTION rule on FAB_PARTS not found — nothing to change');
  else if (rule.value_rule === 'defaulted') say('  PART_FUNCTION already defaulted');
  else { await rules.updateRule(conn, c, rule.id, { valueRule: 'defaulted' }); say(`  PART_FUNCTION  ${rule.value_rule} -> defaulted`); }

  // --- 2. CFFB-PLATEPART: only catalog items --------------------------------
  const [[sch]] = await conn.query(
    "SELECT id FROM cf_code_schemes WHERE company_id = ? AND code = 'CFFB-PLATEPART' AND deleted_at IS NULL", [COMPANY]);
  if (!sch) say('  CFFB-PLATEPART not found');
  else {
    const full = await codegen.getScheme(conn, COMPANY, sch.id);
    const has = (full.conditions ?? []).some((x) => x.tokenKey === 'kind');
    if (has) say('  CFFB-PLATEPART already tests kind');
    else {
      await codegen.updateScheme(conn, COMPANY, c.userId, sch.id, {
        ...full,
        conditions: [...(full.conditions ?? []).map((x) => ({ tokenKey: x.tokenKey, operator: x.operator, value: x.value })),
          { tokenKey: 'kind', operator: 'eq', value: 'catalog' }],
        segments: (full.segments ?? []).map((s) => ({
          segmentType: s.segmentType, literalText: s.literalText, tokenKey: s.tokenKey,
          format: s.format, transform: s.transform, maxLength: s.maxLength, isRequired: s.isRequired,
        })),
      });
      say('  CFFB-PLATEPART  + condition kind = catalog');
    }
  }
  detachNodeCache(conn);
  await conn.commit();

  // --- what the parts resolve to now ---------------------------------------
  attachNodeCache(conn);
  const [[part]] = await conn.query(
    `SELECT m.id, m.code, m.name FROM cf_master_records m
       JOIN cf_item_details i ON i.master_id = m.id AND i.item_type = 'temporary'
       JOIN cf_classification_nodes n ON n.id = m.classification_id AND n.code = 'PLATE_PART'
      WHERE m.company_id = ? AND m.deleted_at IS NULL LIMIT 1`, [COMPANY]);
  if (part) {
    const resolution = await imp('apps/cf_erp/services/resolutionService.js');
    const recs = await imp('apps/cf_erp/services/masterRecordService.js');
    const m = await (await imp('apps/cf_erp/services/records.js')).loadMaster(conn, COMPANY, part.id);
    const r = await resolution.resolve(conn, COMPANY, { master: m });
    const pf = r.specs.find((s) => s.spec.code === 'PART_FUNCTION');
    say(`\n  a part temporary (${part.name}):`);
    say(`     PART_FUNCTION = ${pf?.value?.display ?? pf?.value?.raw ?? '(none)'}  [${pf?.status}, from ${pf?.value?.from ?? '-'}]`);
    say(`     still missing required: ${r.missingRequired.map((s) => s.code).join(', ') || 'nothing'}`);
    const g = await (await imp('apps/cf_erp/modules/codegen/index.js')).generate(conn, COMPANY, 'item', 'code', { entityId: part.id });
    say(`     its code would be: ${g?.text ?? '(no rule matches)'}  [rule ${g?.schemeCode ?? '-'}]`);
  }
} catch (e) { await conn.rollback(); console.error('FAILED:', e.code ?? '', e.message, e.problems ?? ''); process.exitCode = 1; }
finally { detachNodeCache(conn); conn.release(); await pool.end(); }
