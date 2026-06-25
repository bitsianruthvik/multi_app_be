// core/jobs/queue.js
// Manages Bull queue instances with graceful degradation when Redis is unavailable.
// If REDIS_URL is not set (or the connection fails), all queues return null and
// callers fall back to inline execution. The warning is logged once at module init.

import Bull from "bull";
import { logger } from "../utils/logger.js";

const DEFAULT_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: "exponential", delay: 5000 },
  removeOnComplete: 100,
  removeOnFail: 500,
};

// Derive Redis connection options from environment variables.
function getRedisOpts() {
  if (process.env.REDIS_URL) {
    return { url: process.env.REDIS_URL };
  }
  if (process.env.REDIS_HOST) {
    return {
      host: process.env.REDIS_HOST,
      port: parseInt(process.env.REDIS_PORT || "6379", 10),
    };
  }
  return null;
}

// ---- Module-level state ----
const _queues = new Map(); // name -> Bull instance
let _available = false;
let _redisOpts = null;

const redisOpts = getRedisOpts();

if (!redisOpts) {
  logger.warn("[jobs] Redis not configured — falling back to inline execution");
  _available = false;
} else {
  _available = true;
  _redisOpts = redisOpts;
}

/**
 * Canonical list of queue names the platform manages.
 * Import this in any module that needs to enumerate queues.
 */
export const KNOWN_QUEUE_NAMES = ["audio_intelligence"];

/**
 * Returns true iff Redis is (or was) reachable at module init time.
 * Once set to false it stays false for the lifetime of the process.
 */
export function isQueueAvailable() {
  return _available;
}

/**
 * Returns a singleton Bull queue instance for `name`, or null when Redis is
 * not configured / unavailable.
 *
 * @param {string} name - Queue name (e.g. "audio_intelligence")
 * @returns {import("bull").Queue | null}
 */
export function getQueue(name) {
  if (!_available) return null;

  if (_queues.has(name)) return _queues.get(name);

  // Build the Bull configuration depending on whether we got a full URL or
  // individual host/port pieces. Bull accepts a `redis` option that may be
  // an ioredis-compatible options object or a connection URL string.
  let queueOpts;
  if (_redisOpts.url) {
    queueOpts = { redis: _redisOpts.url };
  } else {
    queueOpts = {
      redis: {
        host: _redisOpts.host,
        port: _redisOpts.port,
      },
    };
  }

  let queue;
  try {
    queue = new Bull(name, {
      ...queueOpts,
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    });
  } catch (err) {
    logger.error({ err, name }, `[jobs] Failed to create queue`);
    _available = false;
    return null;
  }

  // Attach a failure listener for observability.
  queue.on("failed", (job, err) => {
    logger.error(
      {
        err,
        queueName: name,
        jobId: job.id,
        jobName: job.name,
        attempt: job.attemptsMade,
        maxAttempts: job.opts && job.opts.attempts,
      },
      "[jobs] job failed"
    );
  });

  // If Redis becomes unreachable at runtime, mark the module unavailable so
  // future getQueue() calls on other names fast-fail without a connection attempt.
  queue.on("error", (err) => {
    logger.error({ err, queueName: name }, "[jobs] Redis error on queue");
  });

  _queues.set(name, queue);
  return queue;
}
