// A DWG read into the extractor's database shape with LibreDWG (the WASM build @mlightcad/libredwg-web), when the
// server has it: the backend's own node_modules first, else TM/drawing_bom's copy (a local machine). Without it a
// DWG is refused in words ("save it as DXF") — DXF needs nothing (dxfDb.js).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export class DwgReaderMissing extends Error {}

let lib = null;
async function loadLib() {
  if (lib) return lib;
  const tries = [];
  try { const m = await import('@mlightcad/libredwg-web'); tries.push({ m, wasm: null }); } catch { /* not installed with the backend */ }
  const local = path.resolve(here, '..', '..', '..', '..', '..', 'drawing_bom', 'node_modules', '@mlightcad', 'libredwg-web');
  if (!tries.length && fs.existsSync(path.join(local, 'package.json'))) {
    const pkg = JSON.parse(fs.readFileSync(path.join(local, 'package.json'), 'utf8'));
    const entry = pkg.module ?? pkg.main ?? 'dist/libredwg-web.js';
    const m = await import(pathToFileURL(path.join(local, entry)).href);
    tries.push({ m, wasm: path.join(local, 'wasm') + path.sep });
  }
  if (!tries.length) throw new DwgReaderMissing('This server cannot read DWG files yet. Save the drawing as DXF (File › Save As › DXF) and upload that.');
  const { m, wasm } = tries[0];
  const created = await m.LibreDwg.create(wasm ?? undefined);
  lib = { L: created, Dwg_File_Type: m.Dwg_File_Type };
  return lib;
}

/** DWG bytes → the database flatten.js reads. */
export async function readDwgDb(buf) {
  const { L, Dwg_File_Type } = await loadLib();
  const dwg = L.dwg_read_data(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), Dwg_File_Type.DWG);
  if (!dwg) throw new Error('This DWG could not be read. Save it as DXF and upload that.');
  const db = L.convert(dwg);
  try { L.dwg_free?.(dwg); } catch { /* best effort */ }
  return JSON.parse(JSON.stringify(db, (k, v) => (typeof v === 'bigint' ? Number(v) : v)));
}
