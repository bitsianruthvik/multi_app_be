/**
 * templateCycles.js — sub-template cycle detection for fab_erp process templates.
 *
 * When a process template step embeds a sub-template (sub_template_id),
 * cycles must be prevented: A → B → A would cause infinite recursion.
 *
 * Uses BFS to traverse the sub-template dependency graph.
 */

import { pool } from '../../../db.js';

const MAX_DEPTH = 10;

/**
 * Returns true if setting sub_template_id = candidateId on a step
 * inside parentTemplateId would create a cycle (including self-reference).
 *
 * @param {number} parentTemplateId
 * @param {number} candidateId
 * @returns {Promise<boolean>}
 */
export async function wouldCreateCycle(parentTemplateId, candidateId) {
  if (!candidateId || !parentTemplateId) return false;
  if (candidateId === parentTemplateId) return true;

  // BFS from candidateId: does the transitive sub-template graph contain parentTemplateId?
  const visited = new Set();
  const queue   = [Number(candidateId)];
  let depth = 0;

  while (queue.length > 0 && depth < MAX_DEPTH) {
    depth++;
    const current = queue.shift();
    if (visited.has(current)) continue;
    visited.add(current);

    if (current === Number(parentTemplateId)) return true;

    // Find all sub-templates embedded by 'current'
    const [rows] = await pool.query(
      `SELECT DISTINCT sub_template_id
         FROM fab_process_template_steps
        WHERE process_template_id = ?
          AND sub_template_id IS NOT NULL
          AND deleted_at IS NULL`,
      [current],
    );

    for (const row of rows) {
      const subId = Number(row.sub_template_id);
      if (subId === Number(parentTemplateId)) return true;   // short-circuit
      if (!visited.has(subId)) queue.push(subId);
    }
  }

  return false;
}
