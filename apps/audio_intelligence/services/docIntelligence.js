import { spawn } from "child_process";
import { logger } from "../../../core/utils/logger.js";
import path from "path";

// Helper: run document-intelligence pipeline (visible spawn for debugging)
export function runDocIntelligence(resource, id, filePath) {
  const py =
    process.env.PYTHON_PATH ||
    (process.platform === "win32" ? "python.exe" : "python3");

  const script = path.join(
    process.cwd(),
    "workers",
    "rag",
    "doc_intelligence.py"
  );

  logger.info("[doc-intel] spawning:", py, script, resource, id, filePath);

  const child = spawn(py, [script, resource, String(id), filePath], {
    env: { ...process.env },
  });

  if (child.stdout) {
    child.stdout.on("data", (d) =>
      logger.info("[doc-intel stdout]", d.toString())
    );
  }
  if (child.stderr) {
    child.stderr.on("data", (d) =>
      logger.error("[doc-intel stderr]", d.toString())
    );
  }
  child.on("close", (code) => logger.info("[doc-intel exit]", code));
}
