import { pool } from '../../../db.js';
import { createReadStream, createWriteStream, existsSync, mkdirSync } from 'fs';
import { unlink } from 'fs/promises';
import path from 'path';

const DIAGRAM_DIR = path.join(process.cwd(), 'uploads', 'node_diagrams');

function ensureDir() {
  if (!existsSync(DIAGRAM_DIR)) mkdirSync(DIAGRAM_DIR, { recursive: true });
}

export async function getNodeDetail(nodeId, companyId) {
  const [[node]] = await pool.query(
    `SELECT fn.*
       FROM fab_nodes fn
       JOIN fab_project_plans fpp ON fpp.id = fn.project_plan_id
      WHERE fn.id = ? AND fpp.company_id = ? AND fn.deleted_at IS NULL`,
    [nodeId, companyId],
  );
  if (!node) throw new Error('Node not found');
  return node;
}

export async function uploadNodeDiagram(nodeId, companyId, file) {
  ensureDir();
  const node = await getNodeDetail(nodeId, companyId);

  if (node.diagram_file_name) {
    const oldPath = path.join(DIAGRAM_DIR, node.diagram_file_name);
    if (existsSync(oldPath)) await unlink(oldPath).catch(() => {});
  }

  const ext      = file.originalname.endsWith('.pdf') ? '.pdf' : path.extname(file.originalname) || '.pdf';
  const fileName = `node_${nodeId}_${Date.now()}${ext}`;
  const destPath = path.join(DIAGRAM_DIR, fileName);

  await new Promise((resolve, reject) => {
    createReadStream(file.path).pipe(createWriteStream(destPath))
      .on('finish', resolve).on('error', reject);
  });
  await unlink(file.path).catch(() => {});

  await pool.query(
    'UPDATE fab_nodes SET diagram_file_name = ?, diagram_mime_type = ? WHERE id = ?',
    [fileName, file.mimetype ?? 'application/pdf', nodeId],
  );
  return { fileName };
}

export async function getNodeDiagramPath(nodeId, companyId) {
  ensureDir();
  const node = await getNodeDetail(nodeId, companyId);
  if (!node.diagram_file_name) throw new Error('No diagram uploaded for this node');
  const filePath = path.join(DIAGRAM_DIR, node.diagram_file_name);
  if (!existsSync(filePath)) throw new Error('Diagram file not found on disk');
  return { filePath, fileName: node.diagram_file_name, mimeType: node.diagram_mime_type ?? 'application/pdf' };
}
