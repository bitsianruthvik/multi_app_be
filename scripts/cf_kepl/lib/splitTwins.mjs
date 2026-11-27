/**
 * splitTwins.mjs — part drawings for rows SPLIT from one source row (line-sync, 2026-11-27).
 *
 * line-sync pastes a split mark (OWG V2-SP → V2-SPI + V2-SPO) as copies of the source row, so the twins are linked
 * copies of each other, and partDrawingService.uploadDrawings puts a file on every copy of the rows it names: the first
 * twin's DXF went on both rows and the second twin's was refused ("already take … from this upload").
 *
 * aimSplitTwins previews the upload (nothing written) and returns, for each file whose copies carry ANOTHER drawing mark,
 * the row to aim it at and those twin marks; aimedFile adds rowId + links 'one' (the file goes on the rows with its own
 * mark only, and they stop being copies); dropTwinLinks then takes off the link those rows still have to a twin's
 * drawing (a register number ending in the twin's mark).
 */
import { uploadDrawings, rowsOfLine, normMark } from '../../../apps/cf_erp/services/partDrawingService.js';
import { removeLink } from '../../../apps/cf_erp/services/drawingService.js';

const markOf = (name) => normMark(String(name).split('_')[0]);

/** files: [{ name, content }] → { rows, aim: Map(name → { rowId, twins: Set(markNorm) }) } */
export async function aimSplitTwins(db, c, line, files, { batch = 5 } = {}) {
  const rows = await rowsOfLine(db, c.companyId, { ...line, line_type: line.line_type ?? 'custom' });
  const byId = new Map(rows.map((r) => [Number(r.id), r]));
  const aim = new Map();
  for (let i = 0; i < files.length; i += batch) {
    const pre = await uploadDrawings(db, c, line.order_id, line.id, { files: files.slice(i, i + batch), dryRun: true });
    for (const x of pre.files ?? []) {
      const m = markOf(x.name);
      const twins = new Set((x.fanOut?.added ?? []).map((id) => byId.get(Number(id))?.markNorm).filter((t) => t && t !== m));
      const own = rows.find((r) => r.markNorm === m);
      if (twins.size && own) aim.set(x.name, { rowId: own.id, twins });
    }
  }
  return { rows, aim };
}

export const aimedFile = (f, aim) => (aim.has(f.name) ? { ...f, rowId: aim.get(f.name).rowId, links: 'one' } : f);

/** After the aimed upload: the links the file's own rows still have to a twin's drawing come off. → count taken off */
export async function dropTwinLinks(db, c, rows, name, aim) {
  const a = aim.get(name);
  if (!a) return 0;
  const ids = rows.filter((r) => r.markNorm === markOf(name)).map((r) => r.id);
  if (!ids.length) return 0;
  const [ks] = await db.query(
    `SELECT k.id, d.number FROM cf_drawing_links k JOIN cf_drawings d ON d.id = k.drawing_id
      WHERE k.company_id = ? AND k.subject_type = 'master_record' AND k.deleted_at IS NULL AND k.subject_id IN (?)`,
    [c.companyId, ids],
  );
  const off = ks.filter((k) => a.twins.has(normMark(String(k.number).split('/').pop())));
  for (const k of off) await removeLink(db, c, k.id);
  return off.length;
}
