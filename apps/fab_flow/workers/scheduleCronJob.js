import cron from 'node-cron';
import { pool } from '../../../db.js';
import { buildSchedule, saveSnapshot } from '../services/scheduleService.js';
import { logger } from '../../../core/utils/logger.js';

// Runs at 23:30 every weekday.
// For every plan that still has future tasks, saves a snapshot of the current
// schedule then re-runs the scheduler using the latest task progress percentages
// from fab_task_progress (treating completed tasks as done, partial as reduced hours).

async function runNightlyReschedule() {
  logger.info('fab_flow cron: nightly reschedule starting');
  let conn;
  try {
    conn = await pool.getConnection();

    // Find all active plans (any task with scheduled_end >= today)
    const today = new Date().toISOString().slice(0, 10);
    const [activePlans] = await conn.query(
      `SELECT DISTINCT plan_id, company_id
       FROM fab_schedule_tasks
       WHERE scheduled_end >= ?`,
      [today],
    );

    if (activePlans.length === 0) {
      logger.info('fab_flow cron: no active plans, skipping');
      return;
    }

    for (const { plan_id, company_id } of activePlans) {
      try {
        // Build progress map from fab_task_progress (latest entry per task)
        const [progressRows] = await conn.query(
          `SELECT p1.process_step_id, p1.node_id, p1.completion_pct
           FROM fab_task_progress p1
           INNER JOIN (
             SELECT plan_id, process_step_id, node_id, MAX(log_date) AS max_date
             FROM fab_task_progress
             WHERE plan_id=? AND company_id=?
             GROUP BY plan_id, process_step_id, node_id
           ) p2 ON p2.plan_id=p1.plan_id
               AND p2.process_step_id=p1.process_step_id
               AND p2.node_id<=>p1.node_id
               AND p2.max_date=p1.log_date`,
          [plan_id, company_id],
        );

        const progressMap = new Map();
        for (const r of progressRows) {
          const key = `${r.process_step_id}:${r.node_id ?? 'null'}`;
          progressMap.set(key, Math.max(0, Math.min(1, parseFloat(r.completion_pct) / 100)));
        }

        await saveSnapshot(plan_id, company_id, 'cron');
        await buildSchedule(plan_id, company_id, { fromDate: today, progressMap });
        logger.info({ plan_id, company_id }, 'fab_flow cron: rescheduled plan');
      } catch (planErr) {
        logger.error({ planErr, plan_id, company_id }, 'fab_flow cron: plan reschedule failed');
      }
    }
  } catch (err) {
    logger.error({ err }, 'fab_flow cron: nightly reschedule failed');
  } finally {
    conn?.release();
  }
  logger.info('fab_flow cron: nightly reschedule done');
}

export function startScheduleCron() {
  // 23:30 every weekday (Mon–Fri)
  cron.schedule('30 23 * * 1-5', runNightlyReschedule, { timezone: 'Asia/Kolkata' });
  logger.info('fab_flow cron: scheduled at 23:30 weekdays');
}
