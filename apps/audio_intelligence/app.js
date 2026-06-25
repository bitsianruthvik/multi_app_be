// audio_intelligence app manifest.
// Wired up by apps/_loader.js at startup.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import audioRoute from "./routes/audioRoute.js";
import documentRoute from "./routes/documentRoute.js";
import managerRoute from "./routes/managerRoute.js";
import * as jobHandlers from "./workers/jobHandlers.js";
import { historyAnalysis } from "./controllers/historyAnalysisController.js";
import { appContext } from "../../core/middleware/appContext.js";
import { protect } from "../../core/middleware/authmiddleware.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const resourceDefs = JSON.parse(
  fs.readFileSync(path.join(__dirname, "resourceDef.json"), "utf-8"),
);

export default {
  slug: "audio_intelligence",

  // Resource definitions merged into the global registry at startup.
  // Owns: audio_recordings, company_documents, team_documents.
  resourceDefs,

  // Mounts this app's HTTP routes onto the Express server.
  // Routes are scoped under /api/query/v1/<app-specific paths>.
  register(server) {
    server.use("/api/query/v1/audio", audioRoute);
    server.use("/api/query/v1/documents", documentRoute);
    server.post("/api/:company/:appSlug/history_analysis", appContext, protect, historyAnalysis);
    server.use("/api/:company/:appSlug/user/manager", managerRoute);
  },

  // Bull job processors — wired by registerAllJobHandlers() in _loader.js.
  jobHandlers,

  // Path to this app's DDL — referenced by migration tooling (Group 4).
  migrations: path.join(__dirname, "models", "init.sql"),
};
