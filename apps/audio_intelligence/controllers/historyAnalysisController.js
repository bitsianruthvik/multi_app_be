import { pool } from "../../../db.js";
import { logger } from "../../../core/utils/logger.js";

/**
 * POST /api/:company/:appSlug/history_analysis
 *
 * Returns lightweight call-history analytics for the requesting user:
 *   - totalCalls      : number of recordings found
 *   - avgScore        : mean of the `score` column (null if column absent / no data)
 *   - recentTrend     : difference between avg score of last 5 vs prior 5 calls
 *                       (positive = improving, negative = declining, null if < 10 calls)
 *   - lastCallAt      : created_at timestamp of the most-recent recording
 *   - focusAreas      : reserved for future coaching tags (always [] in this stub)
 */
export async function historyAnalysis(req, res) {
  try {
    const recordedBy =
      (req.body && req.body.recorded_by) ||
      (req.user && req.user.name) ||
      null;

    const companyId = req.company && req.company.id;

    if (!companyId) {
      return res
        .status(400)
        .json({ success: false, error: "Company context not found." });
    }

    // Fetch up to 50 most-recent recordings for this user + company.
    const [rows] = await pool.query(
      `SELECT created_at, score
         FROM audio_recordings
        WHERE company_id = ?
          ${recordedBy ? "AND recorded_by = ?" : ""}
        ORDER BY created_at DESC
        LIMIT 50`,
      recordedBy ? [companyId, recordedBy] : [companyId]
    );

    const totalCalls = rows.length;
    const lastCallAt = totalCalls > 0 ? rows[0].created_at : null;

    // Compute average score — gracefully handle missing/null values.
    let avgScore = null;
    let recentTrend = null;
    try {
      const scored = rows.filter(
        (r) => r.score !== null && r.score !== undefined
      );
      if (scored.length > 0) {
        const sum = scored.reduce((acc, r) => acc + Number(r.score), 0);
        avgScore = parseFloat((sum / scored.length).toFixed(2));

        // Trend: last-5 avg vs prior-5 avg (requires at least 10 scored rows).
        if (scored.length >= 10) {
          const last5 = scored.slice(0, 5);
          const prior5 = scored.slice(5, 10);
          const avg5 = (arr) =>
            arr.reduce((a, r) => a + Number(r.score), 0) / arr.length;
          recentTrend = parseFloat((avg5(last5) - avg5(prior5)).toFixed(2));
        }
      }
    } catch (computeErr) {
      logger.warn({ err: computeErr }, "[historyAnalysis] score computation failed — returning nulls");
    }

    return res.status(200).json({
      success: true,
      data: {
        totalCalls,
        avgScore,
        recentTrend,
        lastCallAt,
        focusAreas: [],
      },
    });
  } catch (e) {
    logger.error({ err: e }, "[historyAnalysis] unexpected error");
    return res.status(500).json({ success: false, error: e.message });
  }
}
