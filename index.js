import express from "express";
import path from "path";
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
import { pool } from "./db.js";

dotenv.config();
const app = express();

// Increase payload size limit for audio uploads (50MB)
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

// Enable CORS. We reflect the incoming origin (origin: true) so the
// Access-Control-Allow-Origin header contains the request origin. This
// is convenient for local development across different ports and works
// with credentials (cookies) as we set credentials: true.
app.use(
  cors({
    origin: true,
    credentials: true,
  })
);

app.use(cookieParser());

// Serve uploaded files (mp3s) from /uploads
const uploadsDir = path.join(process.cwd(), "public", "uploads");
app.use(
  "/uploads",
  express.static(uploadsDir, {
    maxAge: "1d",
  })
);

// Debug endpoint (before appContext middleware) - no auth required
app.get("/debug/data", async (req, res) => {
  try {
    const [companies] = await pool.query(
      "SELECT id, name, slug FROM companies"
    );
    const [roles] = await pool.query("SELECT id, name, company_id FROM roles");
    const [teams] = await pool.query("SELECT id, name, company_id FROM teams");
    const [users] = await pool.query(
      "SELECT id, name, email, role_id, team_id, company_id FROM users"
    );

    res.json({
      companies,
      roles,
      teams,
      users,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Debug endpoint to check JWT token
app.get("/debug/jwt", (req, res) => {
  const token = req.cookies.token;
  if (!token) {
    return res.json({
      error: "No token found in cookies",
      cookies: req.cookies,
    });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    res.json({ decoded, token: token.substring(0, 50) + "..." });
  } catch (error) {
    res.json({ error: error.message });
  }
});

// Attach app/company context (reads first segment after /api)
// Mount public API routes (no auth / no tenant slugs required)
app.use("/api/public", publicApiRoute);

// Attach app/company context (reads first segment after /api)
app.use(appContext);

// Routes
// Mount routes under company + app slugs so frontend can call /api/:company/:appSlug/... for multi-tenant behavior
app.use("/api/:company/:appSlug/auth", authRoutes);
// Also expose the shorter login endpoints under /api/:company/:appSlug/login
// so frontend can POST to /api/:company/:app/login as requested.
app.post("/api/:company/:appSlug/login", appContext, loginUser);
app.get("/api/:company/:appSlug/verify", appContext, verifyUser);
app.use("/api/:company/:appSlug/admin", adminRoutes);
// app.use("/api/:company/:appSlug/public", );
app.use("/api/:company/:appSlug/user", userRoutes);
app.use("/api/:company/:appSlug/app", appRoutes);
// Expose a canonical base resource endpoint - all data queries go through here
app.use("/api/query/v1", baseResourceRoute);

app.listen(process.env.PORT, () => {
  console.log(`✅ Server running on port ${process.env.PORT}`);
});
