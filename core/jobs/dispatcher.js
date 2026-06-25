// core/jobs/dispatcher.js
// Single API for controllers to dispatch background jobs.
// When Redis is available the job is added to the Bull queue; when unavailable
// (or when the queue cannot be obtained) the provided inlineFallback is invoked.

import { logger } from "../utils/logger.js";
import { getQueue, isQueueAvailable } from "./queue.js";

/**
 * Enqueue a named job, or execute inlineFallback when the queue is unavailable.
 *
 * @param {string}   queueName       - Name of the Bull queue.
 * @param {string}   jobName         - Named job within the queue.
 * @param {object}   payload         - Data passed to the Bull processor / fallback.
 * @param {object}   [opts]          - Extra Bull job options (merged with queue defaults).
 * @param {Function} [inlineFallback] - Called synchronously when queue is unavailable.
 *                                      Receives no arguments; uses payload via closure.
 * @returns {Promise<{ queued: boolean, jobId?: string|number, inline?: boolean }>}
 */
export async function enqueue(
  queueName,
  jobName,
  payload,
  opts,
  inlineFallback
) {
  if (isQueueAvailable()) {
    const queue = getQueue(queueName);
    if (queue) {
      try {
        const job = await queue.add(jobName, payload, opts || {});
        return { queued: true, jobId: job.id };
      } catch (err) {
        logger.error(
          `[jobs] enqueue failed for queue="${queueName}" job="${jobName}":`,
          err && err.message
        );
        // Fall through to inline fallback on enqueue error.
      }
    }
  }

  // Queue unavailable or enqueue threw — run inline.
  if (typeof inlineFallback === "function") {
    try {
      await inlineFallback();
    } catch (fbErr) {
      logger.error(
        `[jobs] inlineFallback threw for queue="${queueName}" job="${jobName}":`,
        fbErr && fbErr.message
      );
    }
  }
  return { queued: false, inline: true };
}
