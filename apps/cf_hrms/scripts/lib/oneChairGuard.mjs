/**
 * The chart import is retired for a tenant on the one-chair model (2026-10-10).
 *
 * WHY. `import-org-chart.mjs`, `org-apply-workbook.mjs` and
 * `verify-against-source.mjs` were written for the old shape: a position that
 * holds several seats (`sanctioned_headcount`), doubled by a day/night pattern
 * through `hrms_manpower_requirements`. `one-chair-positions.mjs` turned Karni
 * into the new shape — one position, one person, one shift — and the user's
 * decision is that the software is now where positions are created and filled:
 * "We will not be importing anymore." Running an importer over that data would
 * wipe or contradict it (a re-import with --wipe deletes every split chair; the
 * workbook applier writes headcounts and per-shift requirement rows the app no
 * longer reads). They are not rewritten; they refuse.
 *
 * THE DETECTION — one rule, on the data, no marker row to forget:
 *   the company has at least one live position, AND
 *   every live position has `sanctioned_headcount = 1` and a `default_shift_id`, AND
 *   it has no live position-level `hrms_manpower_requirements` rows.
 * That is exactly what `one-chair-positions.mjs` proves before it commits, and
 * exactly what the services keep true afterwards (positionService stores 1 and
 * always sets a shift). The old importer cannot produce it for a chart with any
 * day/night position (those get a NULL shift and two requirement rows), and an
 * empty company is not on any model yet — so a first import into a new tenant
 * is not refused.
 *
 * The override exists because a deliberate rebuild of a test tenant is a real
 * thing; it is long on purpose.
 */
export const ONE_CHAIR_OVERRIDE = '--i-know-this-wipes-the-one-chair-model';

export async function oneChairState(conn, companyId) {
  const [[row]] = await conn.query(
    `SELECT
       (SELECT COUNT(*) FROM hrms_positions
         WHERE company_id = ? AND deleted_at IS NULL) AS positions,
       (SELECT COUNT(*) FROM hrms_positions
         WHERE company_id = ? AND deleted_at IS NULL
           AND (default_shift_id IS NULL OR sanctioned_headcount <> 1)) AS oldShape,
       (SELECT COUNT(*) FROM hrms_manpower_requirements
         WHERE company_id = ? AND deleted_at IS NULL AND position_id IS NOT NULL) AS requirements`,
    [companyId, companyId, companyId],
  );
  const positions = Number(row.positions);
  const oldShape = Number(row.oldShape);
  const requirements = Number(row.requirements);
  return { positions, oldShape, requirements, isOneChair: positions > 0 && oldShape === 0 && requirements === 0 };
}

/**
 * The sentence to print and stop on, or null when the tool may run.
 * @param {string} tool what is being refused, in words: "The org chart import"
 */
export async function oneChairRefusal(conn, companyId, companyName, tool, argv = process.argv) {
  const state = await oneChairState(conn, companyId);
  if (!state.isOneChair) return null;
  if (argv.includes(ONE_CHAIR_OVERRIDE)) {
    console.log(`\n  ${ONE_CHAIR_OVERRIDE} was given: ${companyName} is on the one-chair model (${state.positions} positions) and this run goes ahead anyway.\n`);
    return null;
  }
  return [
    '',
    `  REFUSED. ${companyName} is on the one-chair model: each of its ${state.positions} positions is one chair for one person on one shift.`,
    `  ${tool} is retired (2026-10-10). It was written for positions that hold several seats, and it would wipe or`,
    '  contradict what is there now. Positions are created and filled in the software.',
    `  If you really mean to run it over this company, pass ${ONE_CHAIR_OVERRIDE}.`,
    '',
  ].join('\n');
}
