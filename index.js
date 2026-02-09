import express from "express";
import path from "path";
import fs from "fs";
import dotenv from "dotenv";
import cookieParser from "cookie-parser";
import cors from "cors";
import jwt from "jsonwebtoken";
import authRoutes from "./routes/authRoute.js";
import { loginUser, verifyUser } from "./controller/authController.js";
import adminRoutes from "./routes/adminRoute.js";
import userRoutes from "./routes/userRoute.js";
import appRoutes from "./routes/appRoute.js";
import baseResourceRoute from "./routes/baseResourceRoute.js";
import publicApiRoute from "./routes/publicApiRoute.js";
import { appContext } from "./middleware/appContext.js";
import { protect } from "./middleware/authmiddleware.js";
import { pool } from "./db.js";

dotenv.config();
const app = express();

// Increase payload size limit for audio uploads (50MB)
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

// =====================
// CANONICAL CORS CONFIG
// =====================
const ALLOWED_ORIGINS = [
  "https://multi-app-fe.vercel.app", 
  "https://jewelry-shopping-dreams-learned.trycloudflare.com",
  "http://localhost:5173",
  "http://localhost:4000",
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

// =====================
// Static uploads
// =====================
const uploadsDir = path.join(process.cwd(), "public", "uploads");
app.use("/uploads", express.static(uploadsDir, { maxAge: "1d" }));

// =====================
// Serve Frontend Build
// =====================
try {
  const frontendDist = path.join(process.cwd(), "..", "frontend", "dist");
  if (fs.existsSync(frontendDist)) {
    console.log("Serving frontend static from:", frontendDist);

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
  console.warn("Frontend static error:", e.message);
}

// =====================
// Debug Endpoints
// =====================
app.get("/debug/data", async (req, res) => {
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

app.get("/debug/jwt", (req, res) => {
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
// API Routes
// =====================
app.use("/api/public", publicApiRoute);
app.use("/api", appContext);

app.use("/api/:company/:appSlug/auth", authRoutes);
app.post("/api/:company/:appSlug/login", appContext, loginUser);
app.get("/api/:company/:appSlug/verify", appContext, verifyUser);
app.use("/api/:company/:appSlug/admin", adminRoutes);
app.use("/api/:company/:appSlug/user", userRoutes);
app.use("/api/:company/:appSlug/app", appRoutes);
app.use("/api/query/v1", protect, baseResourceRoute);

// =====================
// Server
// =====================
const PORT = parseInt(process.env.PORT || "4000", 10);
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Server running on port ${PORT}`);
});

process.on("unhandledRejection", console.error);
process.on("uncaughtException", console.error);
