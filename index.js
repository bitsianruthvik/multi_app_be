import express from "express";
import path from "path";
import fs from "fs";
import dotenv from "dotenv";
import cookieParser from "cookie-parser";
import cors from "cors";
import jwt from "jsonwebtoken";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import pinoHttp from "pino-http";
import { logger } from "./core/utils/logger.js";
import authRoutes from "./core/auth/authRoute.js";
import companyAuthRoutes from "./core/auth/companyAuthRoute.js";
import { loginUser, verifyUser } from "./core/auth/authController.js";
import adminRoutes from "./core/auth/adminRoute.js";
import userRoutes from "./core/query/userRoute.js";
import appRoutes from "./core/query/appRoute.js";
import baseResourceRoute from "./core/query/baseResourceRoute.js";
import publicApiRoute from "./core/public/publicApiRoute.js";
import { appContext } from "./core/middleware/appContext.js";
import { protect, requireAdmin } from "./core/middleware/authmiddleware.js";
import { loadApps } from "./apps/_loader.js";
import { pool, getPoolStats } from "./db.js";
import jobsStatusRoute from "./core/jobs/jobsStatusRoute.js";
import schemaRoutes from "./core/routes/schemaRoutes.js";
import appsRoutes from "./core/routes/appsRoutes.js";
import { createProcessGuard } from "./core/utils/processGuard.js";
// CF_HRMS attendance (spec §28): the ZKTeco/eSSL ADMS push and the punch API, outside /api/:company/:app.
import iclockRoutes from "./apps/cf_hrms/routes/iclock.js";
import attendanceIntegrationRoutes from "./apps/cf_hrms/routes/integrations.js";

dotenv.config();

// Fail fast if JWT_SECRET is missing — avoids signing tokens with undefined.
if (!process.env.JWT_SECRET) {
  logger.fatal("FATAL: JWT_SECRET environment variable is not set. Exiting.");
  process.exit(1);
}
const app = express();
// req.ip is the CLIENT's address: Render puts exactly one proxy in front, so trust one hop of
// X-Forwarded-For. Never `true` — that would let any client choose its own address (spoofing every
// per-address rate limit: login, iclock, the punch API). Locally there is no proxy and no header.
app.set("trust proxy", 1);

// One request must not take the server down, and a server that goes down must say why
// (core/utils/processGuard.js): requests in flight, slow requests, event-loop stalls, memory, at most one
// large body at a time, uncaught errors, and a drain on SIGTERM. Mounted FIRST, before the body parsers.
const guard = createProcessGuard({ beforeExit: () => pool.end() });
guard.start();
app.use(guard.track);

// Biometric devices push to /iclock/* at the server ROOT (the ADMS protocol fixes the path) and send
// plain text — so this comes BEFORE the JSON / form parsers; the router reads its own body. A device is
// known only by its registered serial (apps/cf_hrms/routes/iclock.js).
app.use("/iclock", iclockRoutes);
// Punches from other devices and middleware, by a per-company API key: BEFORE the 50 MB JSON parser (the
// router has its own 2 MB one, run after its rate limits and key check) and before appContext, which would
// read "integrations" as a company (apps/cf_hrms/routes/integrations.js).
app.use("/api/integrations", attendanceIntegrationRoutes);

// Increase payload size limit for audio uploads (50MB)
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

// =====================
// CANONICAL CORS CONFIG
// =====================
const ENV_ORIGINS = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);
const ALLOWED_ORIGINS = [
  // The production frontend. This list named `multi-app-fe.vercel.app` for a
  // long time, which is NOT the domain in use — it is an abandoned deployment
  // still serving a build old enough to predate fab_erp, pointed at the retired
  // multi-app-be backend. The live app has only ever worked because the real
  // domain arrives via CORS_ORIGINS on Render, so clearing that one env var
  // would have failed every API call in production with nothing in the code to
  // explain why. Naming it here is the point of a canonical list.
  "https://multiappfe.vercel.app",
  "https://jewelry-shopping-dreams-learned.trycloudflare.com",
  "http://localhost:5173",
  "http://localhost:4000",
  ...ENV_ORIGINS,
];

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true); // server-to-server, curl, postman

      if (
        ALLOWED_ORIGINS.includes(origin) ||
        origin.endsWith(".trycloudflare.com")
      ) {
        return callback(null, true);
      }

      return callback(new Error("CORS blocked: " + origin));
    },
    credentials: true,
  }),
);

app.use(cookieParser());
// Never write a token to the log: Render kept every request's Bearer JWT and cookie in plain text (found 2026-10-18).
app.use(pinoHttp({ logger, redact: { paths: ["req.headers.authorization", "req.headers.cookie", "res.headers[\"set-cookie\"]"], censor: "[redacted]" } }));

// =====================
// Static uploads
// =====================
const uploadsDir = path.join(process.cwd(), "public", "uploads");
app.use("/uploads", express.static(uploadsDir, { maxAge: "1d" }));


// =====================
// Debug Endpoints
// =====================
app.get("/debug/data", protect, requireAdmin, async (req, res) => {
  try {
    const [companies] = await pool.query(
      "SELECT id, name, slug FROM companies",
    );
    const [roles] = await pool.query("SELECT id, name, company_id FROM roles");
    const [teams] = await pool.query("SELECT id, name, company_id FROM teams");
    const [users] = await pool.query("SELECT id, name, email FROM users");
    res.json({ companies, roles, teams, users });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/debug/jwt", protect, requireAdmin, (req, res) => {
  const token = req.cookies.token;
  if (!token)
    return res.json({ error: "No token found", cookies: req.cookies });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    res.json({ decoded });
  } catch (e) {
    res.json({ error: e.message });
  }
});

// =====================
// Rate Limiting
// =====================
// Logins are limited per ACCOUNT (5 a minute — password guessing) and per address overall (60 a minute). One limit
// of 5 per address stopped the sixth person of an office on one connection from signing in (2026-10-31, before the
// Placebo demo). The account key is the email alone: behind Render's proxies the address a request arrives from
// changes request by request, so an address-and-email key never added up there.
const loginMessage = { message: "Too many login attempts. Please try again in a minute." };
const loginPerAccount = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => String(req.body?.email ?? req.body?.username ?? "").trim().toLowerCase() || ipKeyGenerator(req.ip),
  message: loginMessage,
});
const loginPerAddress = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: loginMessage,
});
const loginLimiter = [loginPerAddress, loginPerAccount];

const publicLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many requests. Please slow down." },
});

// =====================
// Health Check
// =====================
app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({
      status: "ok",
      uptime: process.uptime(),
      db: { status: "connected", pool: getPoolStats() },
      guard: guard.health(),
    });
  } catch (e) {
    res.status(503).json({
      status: "error",
      uptime: process.uptime(),
      db: { status: "disconnected", error: e.message, pool: getPoolStats() },
    });
  }
});

// =====================
// API Routes
// =====================
app.use("/api/public", publicLimiter, publicApiRoute);
// (/api/integrations is mounted at the top, before the body parsers.)
app.use("/api", appContext);

// Company-level auth (no app slug required) — must be before the app-scoped routes
app.use("/api/:company/auth", companyAuthRoutes);

app.use("/api/:company/:appSlug/auth", loginLimiter, authRoutes);
app.use("/api/:companySlug/apps", appsRoutes);
app.post("/api/:company/:appSlug/login", loginLimiter, appContext, loginUser);
app.get("/api/:company/:appSlug/verify", appContext, verifyUser);
app.use("/api/:company/:appSlug/admin", protect, adminRoutes);
app.use("/api/:company/:appSlug/user", protect, userRoutes);
app.use("/api/:company/:appSlug/app", appRoutes);
app.use("/api/query/v1", protect, baseResourceRoute);

// =====================
// Admin: job queue status (platform-level, not app-scoped)
// =====================
app.use("/api/admin/jobs", jobsStatusRoute);

// =====================
// App modules — each subdir under apps/ that exports an app.js manifest
// is discovered and mounted here. Resource defs are merged into the registry
// at this point so subsequent requests can resolve app-owned resources.
// =====================
app.use('/api', schemaRoutes);
await loadApps(app);

// =====================
// Serve Frontend Build
// =====================
try {
  const frontendDist = path.join(process.cwd(), "..", "frontend", "dist");
  if (fs.existsSync(frontendDist)) {
    logger.info({ frontendDist }, "Serving frontend static from");

    app.use(
      express.static(frontendDist, {
        setHeaders: (res, filePath) => {
          const ext = path.extname(filePath).toLowerCase();
          if (ext === ".js" || ext === ".mjs")
            res.type("application/javascript");
        },
        maxAge: "1d",
      }),
    );

    app.get(/^(?!\/api|\/uploads|\/debug).*/, (req, res) => {
      // Ensure API routes are never served as SPA fallback
      if (req.path.startsWith("/api")) {
        return res.status(404).json({ error: "Not found" });
      }
      res.sendFile(path.join(frontendDist, "index.html"));
    });
  }
} catch (e) {
  logger.warn({ err: e }, "Frontend static error");
}

// =====================
// Server
// =====================
const PORT = parseInt(process.env.PORT || "4000", 10);
const server = app.listen(PORT, "0.0.0.0", () => {
  logger.info({ port: PORT }, "Server running");
});
// Keep-alive longer than the proxy's, a 10-minute request ceiling (Node's 5-minute default cut long writes off).
guard.attachServer(server);
// unhandledRejection / uncaughtException / SIGTERM / SIGINT are handled by the guard (logged with the requests in flight).
logger.info({ workerTokenSet: !!process.env.WORKER_SERVICE_TOKEN }, "SERVER WORKER TOKEN check");
