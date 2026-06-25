// core/jobs/jobRegistry.js
// Iterates loaded app manifests and wires up Bull processors for each app that
// exports a `jobHandlers` object with a `register({ getQueue })` method.

import { logger } from "../utils/logger.js";
import { getQueue, isQueueAvailable } from "./queue.js";

/**
 * Registers job processors for every app that declares `jobHandlers`.
 *
 * @param {object[]} apps - Array of app manifest objects (as exported from each app.js).
 *   Each app may optionally have a `jobHandlers` property that is either:
 *     - An object with a `register({ getQueue })` method, or
 *     - A function/Promise factory that resolves to such an object.
 */
export async function registerAllJobHandlers(apps) {
  if (!isQueueAvailable()) {
    logger.info(
      "[jobs] Queue unavailable — skipping job handler registration for all apps."
    );
    return;
  }

  for (const app of apps) {
    if (!app || !app.jobHandlers) continue;

    let handlers = app.jobHandlers;

    // Support dynamic import factories: if jobHandlers is a function, call it.
    if (typeof handlers === "function") {
      try {
        handlers = await handlers();
      } catch (err) {
        logger.error(
          `[jobs] Failed to resolve jobHandlers for app "${app.slug}":`,
          err
        );
        continue;
      }
    }

    if (!handlers || typeof handlers.register !== "function") {
      logger.warn(
        `[jobs] app "${app.slug}" has jobHandlers but it does not export a register() function — skipping.`
      );
      continue;
    }

    try {
      await handlers.register({ getQueue });
      logger.info(`[jobs] Registered job handlers for app "${app.slug}".`);
    } catch (err) {
      logger.error(
        `[jobs] Error registering job handlers for app "${app.slug}":`,
        err
      );
    }
  }
}
