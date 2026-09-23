/**
 * drafts.js — stand-ins for a record that has not been saved yet, so the
 * create form can show which specifications apply and what code the record
 * would get before anything is written.
 */
import { loadMaster } from './records.js';
import { coerce, loadSpecs } from './valueService.js';

/** A master-record-shaped object for a draft. A temporary item takes its definition's classification. */
export async function draftMaster(db, companyId, draft = {}) {
  const recordKind = draft.recordKind === 'definition' ? 'definition' : 'item';
  const itemType = recordKind === 'item' ? (draft.itemType === 'temporary' ? 'temporary' : 'catalog') : null;
  let classificationId = draft.classificationId != null ? Number(draft.classificationId) : null;
  let sourceDefinitionId = null;
  if (itemType === 'temporary' && draft.sourceDefinitionId != null) {
    const def = await loadMaster(db, companyId, Number(draft.sourceDefinitionId));
    if (def && def.record_kind === 'definition') {
      sourceDefinitionId = def.id;
      classificationId = def.classification_id;
    }
  }
  return {
    id: null,
    record_kind: recordKind,
    code: draft.code ?? null,
    name: draft.name ?? null,
    classification_id: classificationId,
    item_type: itemType,
    tracked_by: draft.trackedBy ?? (itemType === 'temporary' ? 'individual' : 'quantity'),
    source_definition_id: sourceDefinitionId,
    owner_order_line_id: draft.ownerOrderLineId ?? null,
    definition_type: recordKind === 'definition' ? (draft.definitionType === 'selection' ? 'selection' : 'template') : null,
  };
}

/** Draft values as value-row-shaped objects keyed by spec id. Invalid entries are skipped — this is a preview. */
export async function draftValueMap(db, companyId, entries = []) {
  const map = new Map();
  if (!Array.isArray(entries) || !entries.length) return map;
  const { byId, byCode } = await loadSpecs(db, companyId, entries);
  for (const e of entries) {
    const spec = e.specificationId != null ? byId.get(Number(e.specificationId)) : byCode.get(String(e.specCode ?? '').toUpperCase());
    if (!spec) continue;
    const out = await coerce(db, companyId, spec, e.value);
    if (out.typed) map.set(spec.id, { ...out.typed, source: 'entered' });
  }
  return map;
}
