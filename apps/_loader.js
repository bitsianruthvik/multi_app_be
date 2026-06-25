// App module loader.
//
// Each subdirectory under apps/ that has an app.js is treated as an app module.
// Apps export a manifest:
//   { slug, register(server, registry), resourceDefs, jobHandlers? , migrations? }
//
// loadApps() is called once from index.js at startup. It:
//   1. Discovers each app/<slug>/app.js
//   2. Merges resourceDefs into the global resource registry (throws on slug collision)
//   3. Calls app.register(server) to mount routes
//   4. Calls registerAllJobHandlers() to wire Bull processors for each app.

import fs from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { logger } from "../core/utils/logger.js";
import { registerResources } from "../core/query/resourceRegistry.js";
import { registerAllJobHandlers } from "../core/jobs/jobRegistry.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function loadApps(server) {
  const entries = fs.readdirSync(__dirname, { withFileTypes: true });
  const loaded = [];
  const loadedAppManifests = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith("_")) continue; // skip _loader/etc.

    const manifestPath = path.join(__dirname, entry.name, "app.js");
    if (!fs.existsSync(manifestPath)) continue;

    const mod = await import(pathToFileURL(manifestPath).href);
    const app = mod.default || mod.app || mod;
    if (!app || !app.slug) {
      logger.warn(
        `[apps/_loader] skipping ${entry.name}: app.js does not export a manifest with { slug }`,
      );
      continue;
    }

    if (app.resourceDefs) {
      registerResources(app.slug, app.resourceDefs);
    }

    if (typeof app.register === "function") {
      app.register(server);
    }

    loaded.push(app.slug);
    loadedAppManifests.push(app);
  }

  logger.info(`[apps/_loader] loaded apps: ${loaded.join(", ") || "(none)"}`);

  // Wire Bull processors for apps that declare jobHandlers.
  await registerAllJobHandlers(loadedAppManifests);

  return loaded;
}
