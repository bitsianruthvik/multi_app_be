// core/jobs/jobsStatusRoute.js
// Admin-only endpoint: GET /api/admin/jobs/status
// Returns queue health and job counts for all known queues.

import { Router } from "express";
import { protect, requireAdmin } from "../middleware/authmiddleware.js";
import { isQueueAvailable, getQueue, KNOWN_QUEUE_NAMES } from "./queue.js";

const router = Router();

router.get("/status", protect, requireAdmin, async (req, res) => {
  const available = isQueueAvailable();

  if (!available) {
    return res.json({ available: false, queues: [] });
  }

  const queuesInfo = [];
  for (const name of KNOWN_QUEUE_NAMES) {
    const queue = getQueue(name);
    if (!queue) {
      queuesInfo.push({ name, error: "queue not initialized" });
      continue;
    }
    try {
      const counts = await queue.getJobCounts();
      queuesInfo.push({
        name,
        waiting: counts.waiting,
        active: counts.active,
        completed: counts.completed,
        failed: counts.failed,
        delayed: counts.delayed,
      });
    } catch (err) {
      queuesInfo.push({ name, error: err && err.message ? err.message : String(err) });
    }
  }

  return res.json({ available, queues: queuesInfo });
});

export default router;
