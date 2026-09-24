/**
 * cf_wire_flows.mjs — says how each thing is made.
 *
 * A flow is a FIELD on the record (cf_master_records.default_flow_id), and
 * resolution falls back BOM line -> the item's own -> its source DEFINITION's.
 * So setting it on the 13 part definitions reaches every part temporary an
 * order ever mints from them, and only the exceptions need saying twice.
 *
 * The one exception here is drilling. Plain and drilled stiffeners come from
 * the SAME definition — they differ by the HOLED specification, not by design —
 * so the definition carries the plain flow and each drilled instance overrides
 * it. That is the shape the model wants: a default on the design, an override
 * on the instance.
 *
 *   cd multi_app_be && node scripts/cf_kepl/cf_wire_flows.mjs
 */
import path from 'path';
import { pathToFileURL } from 'url';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
await imp('apps/cf_erp/services/codegenProvider.js');
const recs = await imp('apps/cf_erp/services/masterRecordService.js');
const { attachNodeCache, detachNodeCache } = await imp('apps/cf_erp/lib/db.js');

const COMPANY = Number(process.env.CF_BRIDGE_COMPANY ?? 2);
const c = { companyId: COMPANY, userId: Number(process.env.CF_BRIDGE_USER ?? 22) };
const say = (...a) => console.log(...a);
const tally = { set: 0, already: 0, skipped: [] };

const conn = await pool.getConnection();
try {
  await conn.beginTransaction();
  attachNodeCache(conn);

  const [flows] = await conn.query(
    'SELECT id, code, name FROM cf_operation_flows WHERE company_id = ? AND deleted_at IS NULL', [COMPANY]);
  const flow = new Map(flows.map((f) => [f.code, f]));
  for (const code of ['CUTTING', 'PARTFAB-PLAIN', 'PARTFAB-DRILLED', 'LINESEG-FAB']) {
    if (!flow.has(code)) throw new Error(`flow ${code} is missing — run cf_ops_import.mjs first`);
  }

  const setFlow = async (id, label, f) => {
    const [[m]] = await conn.query('SELECT default_flow_id FROM cf_master_records WHERE id = ?', [id]);
    if (Number(m.default_flow_id) === Number(f.id)) { tally.already += 1; return; }
    try { await recs.updateRecord(conn, c, id, { defaultFlowId: f.id }); tally.set += 1; say(`   ${label.padEnd(42)} -> ${f.code}`); }
    catch (e) { tally.skipped.push(`${label}: ${e.code} ${e.message}`); }
  };

  // --- 1. the part definitions: plain by default ---------------------------
  say('\n-- part definitions --');
  const [parts] = await conn.query(
    `SELECT m.id, m.code, m.name FROM cf_master_records m
       JOIN cf_definition_details d ON d.master_id = m.id AND d.definition_type = 'template' AND d.deleted_at IS NULL
       JOIN cf_classification_nodes n ON n.id = m.classification_id AND n.code = 'PLATE_PART'
      WHERE m.company_id = ? AND m.deleted_at IS NULL ORDER BY m.code`, [COMPANY]);
  for (const p of parts) await setFlow(p.id, `${p.code} ${p.name}`, flow.get('PARTFAB-PLAIN'));

  // --- 2. the girder segment definition ------------------------------------
  say('\n-- assemblies --');
  const [assy] = await conn.query(
    `SELECT m.id, m.code, m.name FROM cf_master_records m
       JOIN cf_definition_details d ON d.master_id = m.id AND d.definition_type = 'template' AND d.deleted_at IS NULL
       JOIN cf_classification_nodes n ON n.id = m.classification_id AND n.code = 'GIRDER_SEGMENT'
      WHERE m.company_id = ? AND m.deleted_at IS NULL`, [COMPANY]);
  for (const a of assy) await setFlow(a.id, `${a.code} ${a.name}`, flow.get('LINESEG-FAB'));

  // --- 3. every cut plate: it is cut ----------------------------------------
  say('\n-- cut plates --');
  const [blanks] = await conn.query(
    `SELECT m.id, m.code, m.name FROM cf_master_records m
       JOIN cf_classification_nodes n ON n.id = m.classification_id AND n.code = 'CUT_PLATE'
      WHERE m.company_id = ? AND m.deleted_at IS NULL ORDER BY m.name`, [COMPANY]);
  for (const b of blanks) await setFlow(b.id, `${b.code ?? b.name}`, flow.get('CUTTING'));

  // --- 4. drilled parts override the plain default -------------------------
  // HOLED is what makes a part drilled, so the override follows the value
  // rather than a name — a part that becomes drilled tomorrow picks it up.
  say('\n-- drilled parts (override) --');
  const [drilled] = await conn.query(
    `SELECT m.id, m.code, m.name FROM cf_master_records m
       JOIN cf_item_details i ON i.master_id = m.id AND i.item_type = 'temporary'
       JOIN cf_classification_nodes n ON n.id = m.classification_id AND n.code = 'PLATE_PART'
       JOIN cf_spec_values v ON v.subject_id = m.id AND v.subject_type = 'master' AND v.deleted_at IS NULL
       JOIN cf_specifications s ON s.id = v.specification_id AND s.code = 'HOLED'
      WHERE m.company_id = ? AND m.deleted_at IS NULL AND v.value_bool = 1`, [COMPANY]);
  for (const d of drilled) await setFlow(d.id, `${d.code ?? d.name}`, flow.get('PARTFAB-DRILLED'));
  say(`   ${drilled.length} drilled part(s)`);

  detachNodeCache(conn);
  await conn.commit();

  // --- what still has no way of being made ---------------------------------
  attachNodeCache(conn);
  const [gaps] = await conn.query(
    `SELECT n.code AS node, COUNT(*) AS n FROM cf_master_records m
       JOIN cf_item_details i ON i.master_id = m.id AND i.item_type = 'temporary'
       JOIN cf_classification_nodes n ON n.id = m.classification_id
       LEFT JOIN cf_master_records sd ON sd.id = i.source_definition_id
      WHERE m.company_id = ? AND m.deleted_at IS NULL
        AND m.default_flow_id IS NULL AND (sd.id IS NULL OR sd.default_flow_id IS NULL)
      GROUP BY n.code ORDER BY n DESC`, [COMPANY]);
  say(`\nset ${tally.set}, already right ${tally.already}, refused ${tally.skipped.length}`);
  for (const s of tally.skipped) say(`   REFUSED ${s}`);
  say('\nstill with no flow, by kind:');
  if (!gaps.length) say('   nothing — every temporary item can be made');
  else for (const g of gaps) say(`   ${String(g.n).padStart(4)}  ${g.node}`);
} catch (e) { await conn.rollback(); console.error('FAILED:', e.code ?? '', e.message, e.problems ?? ''); process.exitCode = 1; }
finally { detachNodeCache(conn); conn.release(); await pool.end(); }
