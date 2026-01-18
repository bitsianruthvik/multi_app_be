#!/usr/bin/env node
// workers/transcription_worker.cjs
// Canonical transcription worker — loads env, sends Authorization header to backend

const http = require("http");
const https = require("https");
const { URL } = require("url");
const path = require("path");
const fs = require("fs");
const mysql = require("mysql2/promise");
const { spawnSync, spawn } = require("child_process");

try {
  require("dotenv").config();
} catch (e) {}
const WORKER_SERVICE_TOKEN = process.env.WORKER_SERVICE_TOKEN;
const ASSEMBLYAI_API_KEY = process.env.ASSEMBLYAI_API_KEY;

// Helper to run Python transcript retrieval script
function runTranscriptRetrieval(recordingId, topK = 5) {
  return new Promise((resolve, reject) => {
    const ROOT_DIR = path.resolve(__dirname, ".."); // repo root fix
    const scriptPath = path.join("workers", "rag", "transcript_retrieval.py");

    const args = [
      scriptPath,
      String(recordingId),
      "--top-k",
      String(topK),
      "--json",
    ];

    const py = spawn("python", args, {
      cwd: ROOT_DIR,
      env: process.env,
      windowsHide: true,
      shell: false,
      detached: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    py.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    py.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    py.on("close", (code) => {
      if (code !== 0) {
        return reject(
          new Error(
            `transcript_retrieval.py exited with code ${code}. stderr:\n${stderr}`
          )
        );
      }
      try {
        const json = JSON.parse(stdout);
        resolve(json);
      } catch (err) {
        reject(
          new Error(
            `Failed to parse transcript_retrieval output as JSON.\nstdout:\n${stdout}\n\nstderr:\n${stderr}\n\nerror: ${err.message}`
          )
        );
      }
    });
  });
}
console.log("[worker] token loaded?", WORKER_SERVICE_TOKEN ? "YES" : "NO");

function getAudioIdFromArgv() {
  const argv = process.argv.slice(2);
  // Preferred form: --audio-id <id>
  const idx = argv.indexOf("--audio-id");
  if (idx !== -1 && argv[idx + 1]) {
    const v = Number(argv[idx + 1]);
    if (!Number.isNaN(v)) return v;
  }
  // Support --audio-id=<id>
  for (const a of argv) {
    if (a && a.startsWith("--audio-id=")) {
      const parts = a.split("=");
      const v = Number(parts[1]);
      if (!Number.isNaN(v)) return v;
    }
  }
  return null;
}

function hasAuthHeader(headers) {
  if (!headers) return false;
  return Object.keys(headers).some((k) => k.toLowerCase() === "authorization");
}

function postJson(endpoint, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    try {
      const u = new URL(endpoint);
      const data = JSON.stringify(body);
      const isHttps = u.protocol === "https:";

      const headersObj = Object.assign({}, extraHeaders || {});
      headersObj["Content-Type"] =
        headersObj["Content-Type"] || "application/json";
      headersObj["Content-Length"] = Buffer.byteLength(data);
      if (WORKER_SERVICE_TOKEN && !hasAuthHeader(headersObj)) {
        headersObj["Authorization"] = `Bearer ${WORKER_SERVICE_TOKEN}`;
      }

      const opts = {
        hostname: u.hostname,
        port: u.port || (isHttps ? 443 : 80),
        path: u.pathname + (u.search || ""),
        method: "POST",
        headers: headersObj,
      };

      const lib = isHttps ? https : http;
      const req = lib.request(opts, (res) => {
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (buf += chunk));
        res.on("end", () => {
          try {
            const parsed = buf ? JSON.parse(buf) : null;
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300)
              resolve(parsed);
            else reject(new Error(`HTTP ${res.statusCode}: ${buf}`));
          } catch (e) {
            reject(e);
          }
        });
      });
      req.on("error", (err) => reject(err));
      req.write(data);
      req.end();
    } catch (e) {
      reject(e);
    }
  });
}

function httpJsonRequest(endpoint, method, headers, body) {
  return new Promise((resolve, reject) => {
    try {
      const u = new URL(endpoint);
      const isHttps = u.protocol === "https:";
      const lib = isHttps ? https : http;

      const mergedHeaders = Object.assign({}, headers || {});
      if (WORKER_SERVICE_TOKEN && !hasAuthHeader(mergedHeaders)) {
        mergedHeaders["Authorization"] = `Bearer ${WORKER_SERVICE_TOKEN}`;
      }

      const opts = {
        hostname: u.hostname,
        port: u.port || (isHttps ? 443 : 80),
        path: u.pathname + (u.search || ""),
        method: method || "GET",
        headers: mergedHeaders,
      };

      const req = lib.request(opts, (res) => {
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", (d) => (buf += d));
        res.on("end", () => {
          try {
            const parsed = buf ? JSON.parse(buf) : null;
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300)
              resolve(parsed);
            else reject(new Error(`HTTP ${res.statusCode}: ${buf}`));
          } catch (e) {
            reject(e);
          }
        });
      });
      req.on("error", (err) => reject(err));
      if (body)
        req.write(typeof body === "string" ? body : JSON.stringify(body));
      req.end();
    } catch (e) {
      reject(e);
    }
  });
}

function uploadLocalFileToAssemblyAI(filePath, apiKey) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(filePath))
      return reject(new Error("Local file not found"));
    try {
      const endpoint = new URL("https://api.assemblyai.com/v2/upload");
      const opts = {
        hostname: endpoint.hostname,
        port: 443,
        path: endpoint.pathname,
        method: "POST",
        headers: { authorization: apiKey, "Transfer-Encoding": "chunked" },
      };
      const req = https.request(opts, (res) => {
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", (d) => (buf += d));
        res.on("end", () => {
          try {
            const parsed = buf ? JSON.parse(buf) : null;
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300)
              resolve(parsed && parsed.upload_url ? parsed.upload_url : parsed);
            else
              reject(
                new Error(`Upload failed: HTTP ${res.statusCode}: ${buf}`)
              );
          } catch (e) {
            reject(e);
          }
        });
      });
      req.on("error", (err) => reject(err));
      const stream = fs.createReadStream(filePath);
      stream.on("error", (err) => reject(err));
      stream.pipe(req);
    } catch (e) {
      reject(e);
    }
  });
}

async function main() {
  let audioId = getAudioIdFromArgv();
  console.log("[worker] audioId from argv =>", audioId);
  if (!audioId) {
    console.error("audio-id required");
    process.exit(1);
  }

  const host =
    process.env.VITE_API_HOST ||
    process.env.BACKEND_URL ||
    "http://localhost:4000";
  const trimmedHost = String(host).replace(/\/+$/g, "");
  // Analysis service (FastAPI) runs separately; allow overriding where to enqueue analysis jobs
  const ANALYSIS_SERVICE_URL =
    process.env.ANALYSIS_SERVICE_URL ||
    process.env.ANALYSIS_HOST ||
    "http://localhost:5000";
  const trimmedAnalysisHost = String(ANALYSIS_SERVICE_URL).replace(/\/+$/g, "");
  const endpoint = `${trimmedHost}/api/query/v1/base_resource`;
  const assemblyKey = ASSEMBLYAI_API_KEY;

  try {
    console.log("[FLOW-CHECKPOINT-1] Querying DB for recording id:", audioId);
    const queryPayload = {
      operation: "query",
      resource: "audio_recordings",
      filters: { id: Number(audioId) },
      fields: ["id", "processed_url", "audio_url", "medicine"],
    };
    const qres = await postJson(endpoint, queryPayload);
    let row = null;
    if (qres && qres.data && Array.isArray(qres.data) && qres.data.length > 0) {
      row = qres.data[0];
      console.log("[FLOW-CHECKPOINT-2] Found recording in DB:", {
        id: row.id,
        processed_url: row.processed_url,
        medicine: row.medicine,
        audio_url: row.audio_url,
      });
    } else {
      console.warn(
        "[FLOW-CHECKPOINT-2-FAIL] record not found via query-builder for id",
        audioId,
        "- attempting fallback search by processed_url"
      );
      // Fallback: search by processed_url substring (some flows use filenames
      // like processed_<timestamp>_<fileid>.mp3 instead of DB id). This helps
      // when an external file id (like 1764060183345) isn't the DB primary key.
      try {
        const fallbackPayload = {
          operation: "query",
          resource: "audio_recordings",
          filters: { "processed_url.like": `%${audioId}%` },
          fields: ["id", "processed_url", "audio_url", "medicine"],
        };
        const fres = await postJson(endpoint, fallbackPayload).catch(
          () => null
        );
        if (
          fres &&
          fres.data &&
          Array.isArray(fres.data) &&
          fres.data.length > 0
        ) {
          row = fres.data[0];
          console.log(
            "Fallback matched record id",
            row.id,
            "for file id",
            audioId
          );
          // map to actual DB id
          if (row && row.id) audioId = row.id;
        }
      } catch (e) {
        // ignore and fall through to not-found handling
      }
    }
    if (!row) {
      console.warn(
        "[FLOW-CHECKPOINT-2-FAIL-FINAL] record not found after fallback search",
        audioId
      );
      process.exit(0);
    }
    const processedUrl = row.processed_url || null;
    if (!processedUrl) {
      console.warn(
        "[FLOW-CHECKPOINT-2-FAIL] processed_url missing in record",
        audioId
      );
      process.exit(0);
    }

    console.log("[FLOW-CHECKPOINT-3] Got processed_url from DB:", processedUrl);

    let audioUrl = null;
    // If the processed_url looks like a public HTTP(S) URL, prefer it.
    // However AssemblyAI cannot reach `localhost` or private IPs — treat
    // those as local files and upload them to AssemblyAI instead.
    let isHttp = false;
    try {
      isHttp = /^https?:\/\//i.test(processedUrl);
    } catch (e) {
      isHttp = false;
    }

    if (isHttp) {
      // detect localhost or private hosts which AssemblyAI can't fetch
      let isLocalHost = false;
      try {
        const u = new URL(processedUrl);
        const host = (u.hostname || "").toLowerCase();
        if (
          host === "localhost" ||
          host === "127.0.0.1" ||
          host.startsWith("192.") ||
          host.startsWith("10.") ||
          host.startsWith("169.254.")
        ) {
          isLocalHost = true;
        }
      } catch (e) {
        isLocalHost = false;
      }

      if (!isLocalHost) {
        audioUrl = processedUrl;
      } else {
        // Map the uploads path to a local file and upload to AssemblyAI
        let rel = processedUrl;
        try {
          const u = new URL(processedUrl, "http://localhost");
          const idx = u.pathname.indexOf("/uploads/");
          if (idx !== -1) rel = u.pathname.slice(idx + "/uploads/".length);
          else rel = path.basename(u.pathname);
        } catch (e) {
          const idx = String(processedUrl).indexOf("/uploads/");
          if (idx !== -1)
            rel = String(processedUrl).slice(idx + "/uploads/".length);
          else rel = path.basename(String(processedUrl));
        }
        const localPath = path.join(
          process.cwd(),
          "public",
          "uploads",
          decodeURIComponent(rel.replace(/^\/+/, ""))
        );
        if (!fs.existsSync(localPath)) {
          console.warn(`local processed file missing: ${localPath}`);
          process.exit(0);
        }
        if (!assemblyKey) {
          console.warn("ASSEMBLYAI_API_KEY not set in worker");
          process.exit(0);
        }
        const uploadUrl = await uploadLocalFileToAssemblyAI(
          localPath,
          assemblyKey
        ).catch(() => null);
        if (!uploadUrl) {
          console.warn("assemblyai upload failed for", localPath);
          process.exit(0);
        }
        audioUrl = uploadUrl;
      }
    } else {
      let rel = processedUrl;
      try {
        const u = new URL(processedUrl, "http://localhost");
        const idx = u.pathname.indexOf("/uploads/");
        if (idx !== -1) rel = u.pathname.slice(idx + "/uploads/".length);
        else rel = path.basename(u.pathname);
      } catch (e) {
        const idx = String(processedUrl).indexOf("/uploads/");
        if (idx !== -1)
          rel = String(processedUrl).slice(idx + "/uploads/".length);
        else rel = path.basename(String(processedUrl));
      }
      const localPath = path.join(
        process.cwd(),
        "public",
        "uploads",
        decodeURIComponent(rel.replace(/^\/+/, ""))
      );
      if (!fs.existsSync(localPath)) {
        console.warn(`local processed file missing: ${localPath}`);
        process.exit(0);
      }
      if (!assemblyKey) {
        console.warn("ASSEMBLYAI_API_KEY not set in worker");
        process.exit(0);
      }
      const uploadUrl = await uploadLocalFileToAssemblyAI(
        localPath,
        assemblyKey
      ).catch(() => null);
      if (!uploadUrl) {
        console.warn("assemblyai upload failed for", localPath);
        process.exit(0);
      }
      audioUrl = uploadUrl;
    }

    if (!assemblyKey) {
      console.warn("ASSEMBLYAI_API_KEY not set");
      process.exit(0);
    }

    console.log(
      "[FLOW-CHECKPOINT-4] Sending to AssemblyAI with audio_url:",
      audioUrl
    );
    const transcriptReq = { audio_url: audioUrl };
    const transcriptCreate = await httpJsonRequest(
      "https://api.assemblyai.com/v2/transcript",
      "POST",
      { authorization: assemblyKey, "Content-Type": "application/json" },
      JSON.stringify(transcriptReq)
    );
    console.log(
      "[FLOW-CHECKPOINT-5] AssemblyAI job created with ID:",
      transcriptCreate && transcriptCreate.id ? transcriptCreate.id : "NONE"
    );
    console.log(
      "[worker] transcriptCreate details:",
      transcriptCreate && typeof transcriptCreate === "object"
        ? Object.keys(transcriptCreate).length
          ? transcriptCreate
          : transcriptCreate
        : transcriptCreate
    );
    const tid =
      transcriptCreate && transcriptCreate.id ? transcriptCreate.id : null;
    if (!tid) {
      console.warn(
        "failed to create transcription job for audioId",
        audioId,
        transcriptCreate
      );
      process.exit(0);
    }

    const pollUrl = `https://api.assemblyai.com/v2/transcript/${tid}`;
    const start = Date.now();
    const timeout = Number(
      process.env.ASSEMBLYAI_POLL_TIMEOUT || 10 * 60 * 1000
    );
    let final = null;
    while (Date.now() - start < timeout) {
      await new Promise((r) =>
        setTimeout(r, Number(process.env.ASSEMBLYAI_POLL_INTERVAL || 3000))
      );
      try {
        const p = await httpJsonRequest(pollUrl, "GET", {
          authorization: assemblyKey,
        });
        console.log("[worker] poll response status:", p && p.status);
        if (!p) continue;
        const status = p.status;
        if (status === "completed") {
          final = p;
          break;
        }
        if (status === "error") {
          final = p;
          break;
        }
      } catch (e) {}
    }

    if (!final) {
      console.warn("transcription timeout or failed", audioId);
      process.exit(0);
    }

    if (final.status === "completed") {
      const text = final.text || null;
      console.log(
        "[FLOW-CHECKPOINT-6] Transcription completed from AssemblyAI:",
        text ? text.substring(0, 100) + "..." : "NULL"
      );
      // Production-first: attempt to persist directly to the DB using mysql2.
      // This avoids transient HTTP/auth issues between worker and server and
      // is the most reliable persistence path for background workers.
      try {
        console.log(
          "[FLOW-CHECKPOINT-7] Persisting transcription to database for id=%s",
          audioId
        );
        const pool = await mysql.createPool({
          host: process.env.DB_HOST || "localhost",
          user: process.env.DB_USER || "root",
          password: process.env.DB_PASSWORD || "",
          database: process.env.DB_NAME || "sqldb",
          waitForConnections: true,
          connectionLimit: Number(process.env.WORKER_DB_CONN_LIMIT || 5),
        });
        try {
          const [res] = await pool.query(
            "UPDATE audio_recordings SET transcription = ? WHERE id = ?",
            [text, audioId]
          );
          console.log(
            "[FLOW-CHECKPOINT-8] Database update completed, affected rows:",
            res && res.affectedRows ? res.affectedRows : "0"
          );
          try {
            await pool.end();
          } catch (e) {}
          // If affectedRows > 0 we are done
          if (res && res.affectedRows && Number(res.affectedRows) > 0) {
            console.log(
              `[FLOW-CHECKPOINT-9-SUCCESS] transcription persisted via direct DB update for id ${audioId}`
            );
            try {
              const analyzeEndpoint = `${trimmedAnalysisHost}/api/analyze_by_id_async`;
              try {
                // Wait a moment for DB commit to propagate before enqueuing analysis
                await new Promise((res) => setTimeout(res, 500));
                // Extract medicine from row; use a default if not provided
                const medicine = row?.medicine || "generic";
                const ar = await postJson(analyzeEndpoint, {
                  id: audioId,
                  medicine,
                });
                console.log("[worker] enqueued analysis job response:", ar);
              } catch (e) {
                console.warn("Failed to call analyze_by_id_async:", e);
              }
            } catch (e) {
              console.warn("Failed to request analysis enqueue:", e);
            }

            // NOTE: RAG retrieval is DISABLED for now
            // The transcription will be sent directly to LLM without pinecone chunks
            // To re-enable transcript_retrieval.py, uncomment the block below:

            // DISABLED: After transcription is persisted, run the transcript retrieval
            // pipeline to produce embeddings and top-K guardrail matches.
            // Save the JSON result into `audio_recordings.analysis` when possible.
            // try {
            //   const topK = Number(process.env.TRANSCRIPT_RETRIEVAL_TOPK || 5);
            //   console.log(
            //     `[worker] running transcript_retrieval.py for id=${audioId} topK=${topK}`
            //   );
            //   try {
            //     const retrieval = await runTranscriptRetrieval(audioId, topK);
            //     try {
            //       const analysisJson = JSON.stringify(retrieval);
            //       const [uRes] = await pool.query(
            //         "UPDATE audio_recordings SET analysis = ? WHERE id = ?",
            //         [analysisJson, audioId]
            //       );
            //       console.log(
            //         "[worker] saved transcript_retrieval analysis rows:",
            //         uRes && uRes.affectedRows ? uRes.affectedRows : uRes
            //       );
            //     } catch (saveErr) {
            //       console.warn(
            //         "[worker] failed to persist transcript_retrieval result:",
            //         saveErr && (saveErr.message || saveErr)
            //       );
            //     }
            //   } catch (retrErr) {
            //     console.warn(
            //       "[worker] transcript_retrieval.py failed:",
            //       retrErr && (retrErr.message || retrErr)
            //     );
            //   }
            // } catch (e) {
            //   console.warn("[worker] error running transcript retrieval:", e);
            // }

            console.log(
              "[worker] RAG retrieval disabled - transcription will be sent directly to LLM"
            );

            try {
              await pool.end();
            } catch (e) {}
            process.exit(0);
          }
        } catch (dbe) {
          console.error(
            "[worker] direct DB update failed:",
            dbe && (dbe.message || dbe)
          );
        }
      } catch (dbeOuter) {
        console.error(
          "[worker] failed to create DB pool for direct update:",
          dbeOuter && (dbeOuter.message || dbeOuter)
        );
      }

      // Fallback: try the server base_resource HTTP update path (keeps app-level hooks)
      try {
        const upPayload = {
          operation: "update",
          resource: "audio_recordings",
          id: audioId,
          data: { transcription: text },
        };
        const upRes = await postJson(endpoint, upPayload).catch(() => null);
        console.log("[worker] base_resource update response:", upRes);
        if (upRes && upRes.success) {
          const analyzeEndpoint = `${trimmedAnalysisHost}/api/analyze_by_id_async`;
          try {
            // Wait a moment for DB commit to propagate before enqueuing analysis
            await new Promise((res) => setTimeout(res, 500));
            const medicine = row?.medicine || "generic";
            const ar = await postJson(analyzeEndpoint, {
              id: audioId,
              medicine,
            });
            console.log("[worker] enqueued analysis job response:", ar);
          } catch (e) {
            console.warn("Failed to call analyze_by_id_async:", e);
          }
        }
      } catch (uerr) {
        console.error(
          "[worker] base_resource update error:",
          uerr && (uerr.message || uerr)
        );
      }

      // If neither method wrote the row, try the dev force_update endpoint and the old fallbacks
      try {
        // Try server debug endpoint which updates via the server's pool (dev-only)
        const trimmed = String(host).replace(/\/+$/g, "");
        const forceEndpoint = `${trimmed}/api/query/v1/debug/force_update`;
        const forceBody = { id: audioId, transcription: text };
        const fres = await postJson(forceEndpoint, forceBody).catch(() => null);
        console.log("[worker] force_update response:", fres);
        const fresAffected = fres && fres.data && fres.data.affectedRows;
        if (fresAffected && Number(fresAffected) > 0) {
          console.log("[worker] force_update succeeded");
          const analyzeEndpoint = `${trimmedAnalysisHost}/api/analyze_by_id_async`;
          try {
            const medicine = row?.medicine || "generic";
            const ar = await postJson(analyzeEndpoint, {
              id: audioId,
              medicine,
            });
            console.log("[worker] enqueued analysis job response:", ar);
          } catch (e) {
            console.warn("Failed to call analyze_by_id_async:", e);
          }
          process.exit(0);
        }
      } catch (e) {
        console.error(
          "[worker] force_update call failed:",
          e && (e.message || e)
        );
      }

      // Keep older fallback attempts (direct script spawn and mysql client) as last resort
      try {
        const scriptPath = path.join(
          process.cwd(),
          "scripts",
          "direct_update_pool.mjs"
        );
        const sp = spawnSync(
          "node",
          [scriptPath, String(audioId), String(text)],
          {
            env: process.env,
            stdio: "inherit",
            encoding: "utf8",
          }
        );
        if (sp.error) {
          console.error(
            "[worker] spawn direct-update script failed:",
            sp.error
          );
        } else {
          console.log("[worker] spawn direct-update exitCode:", sp.status);
        }
      } catch (dbe) {
        console.error(
          "[worker] direct DB update via script failed:",
          dbe && (dbe.message || dbe)
        );
      }
      try {
        console.log(
          "[worker] final direct DB update attempt host=%s user=%s",
          process.env.DB_HOST || "localhost",
          process.env.DB_USER || "root"
        );
        const pool = await mysql.createPool({
          host: process.env.DB_HOST || "localhost",
          user: process.env.DB_USER || "root",
          password: process.env.DB_PASSWORD || "",
          database: process.env.DB_NAME || "sqldb",
          waitForConnections: true,
          connectionLimit: 5,
        });
        const [res] = await pool.query(
          "UPDATE audio_recordings SET transcription = ? WHERE id = ?",
          [text, audioId]
        );
        console.log(
          "[worker] final direct DB update result:",
          res && res.affectedRows ? res.affectedRows : res
        );
        try {
          if (res && res.affectedRows && Number(res.affectedRows) > 0) {
            try {
              const analyzeEndpoint = `${trimmedAnalysisHost}/api/analyze_by_id_async`;
              try {
                const medicine = row?.medicine || "generic";
                const ar = await postJson(analyzeEndpoint, {
                  id: audioId,
                  medicine,
                });
                console.log("[worker] enqueued analysis job response:", ar);
              } catch (e) {
                console.warn("Failed to call analyze_by_id_async:", e);
              }
            } catch (e) {
              console.warn("Failed to request analysis enqueue:", e);
            }
          }
        } catch (e) {}
        try {
          await pool.end();
        } catch (e) {}
      } catch (dbe) {
        console.error(
          "[worker] final direct DB update failed:",
          dbe && (dbe.message || dbe)
        );
      }

      process.exit(0);
    } else {
      console.warn("transcription job ended with error:", final, audioId);
      // do not attempt to write transcription on error; exit
      process.exit(0);
    }
  } catch (e) {
    console.error("Unhandled worker error:", e);
    process.exit(0);
  }
}

main();
