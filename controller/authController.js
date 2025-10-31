import bcrypt from "bcryptjs";
import { pool } from "../db.js";
import { signToken, verifyToken } from "../utils/jwt.js";
import { use } from "react";

// LOGIN controller
export const loginUser = async (req, res) => {
  console.log("========== LOGIN ATTEMPT STARTED ==========");
  try {
    const { email, password } = req.body || {};
    console.log("Login attempt for email:", email);
    // Validate required fields early to prevent DB/query errors
    if (!email || !password) {
      console.log("Missing credentials on login attempt", { email, password });
      return res
        .status(400)
        .json({ message: "Email and password are required" });
    }
    // Determine current company/app from middleware (req.company) or params
    const companySlug =
      req.company?.slug || req.params?.company || req.companySlug || null;
    const appSlug = req.app?.slug || req.params?.appSlug || req.appSlug || null;

    // First verify the company exists and get the company details
    console.log("Verifying company slug:", companySlug);
    const [companys] = await pool.query(
      "SELECT  slug, name FROM companies WHERE slug = ?",
      [companySlug]
    );
    const [companysID] = await pool.query(
      "SELECT  id FROM companies WHERE slug = ?",
      [companySlug]
    );
    console.log("Company ID lookup result:", companysID);

    if (!companySlug || companys.length === 0) {
      console.log("[auth controller] Company not found:", companySlug);
      return res.status(404).json({ message: "Company not found" });
    }

    // Get the exact company slug from the database
    const correctCompanySlug = companys[0].slug;
    const companyName = companys[0].name; // Get company name for role_capability lookup

    console.log("Request details:", {
      body: req.body,
      params: req.params,
      company: req.company,
      companySlug,
      correctCompanySlug,
      appSlug,
    });

    // Fetch the user row without joining other tables to avoid schema
    // mismatch errors (some deployments store company as slug, others
    // use company_id). We'll inspect the user row and compare against
    // the company we looked up above.
    const [rows] = await pool.query(`SELECT * FROM users WHERE email = ?`, [
      email,
    ]);

    console.log("Found user data:", rows[0]);

    if (rows.length === 0)
      return res.status(404).json({ message: "User not found" });

    const user = rows[0];

    // Fetch the role name and team name from their respective tables
    const [roleRows] = await pool.query(
      "SELECT name FROM roles WHERE id = ? LIMIT 1",
      [user.role_id]
    );
    const [teamRows] = await pool.query(
      "SELECT name FROM teams WHERE id = ? LIMIT 1",
      [user.team_id]
    );

    const roleName = roleRows.length > 0 ? roleRows[0].name : null;
    const teamName = teamRows.length > 0 ? teamRows[0].name : null;

    console.log("User role and team:", { roleName, teamName });
    console.log("Verifying password for user:", user);
    const isMatch = await bcrypt.compare(password, user.password);

    if (!isMatch)
      return res.status(401).json({ message: "Invalid credentials" });

    // Determine user's company value: prefer slug stored on users table
    const userCompanyId = user.company_id || null;
    const userCompanySlug = await pool
      .query("SELECT slug FROM companies WHERE id = ? LIMIT 1", [
        user.company_id,
      ])
      .then(([rows]) => (rows.length > 0 ? rows[0].slug : null));
    //.then(([rows]) => (rows.length > 0 ? rows[0].slug : null)); is used to fetch slug from company id

    console.log("Login attempt - user company values:", {
      userCompanySlug,
      userCompanyId,
      requestedCompanySlug: companySlug,
    });

    // If user has company slug, compare slugs. Else if user has company_id, compare ids.
    if (userCompanySlug) {
      if (userCompanySlug !== correctCompanySlug) {
        console.log("Company validation failed (slug mismatch)", {
          userCompanySlug,
          requestedCompany: companySlug,
          correctCompanySlug,
        });
        return res.status(403).json({
          message: "User does not belong to this company",
          debug: { userCompanySlug, requestedCompany: companySlug },
        });
      }
    } else if (userCompanyId) {
      if (userCompanyId !== companysID[0].id) {
        console.log("Company validation failed (id mismatch)", {
          userCompanyId,
          requestedCompany: companySlug,
          expectedCompanyId: companysID[0].id,
        });
        return res.status(403).json({
          message: "User does not belong to this company",
          debug: { userCompanyId, requestedCompany: companySlug },
        });
      }
    } else {
      console.log("User has no company info on record", { user });
      return res
        .status(403)
        .json({ message: "User does not have a company assigned" });
    }

    // Fetch role-based capability and features (permissions)
    let uiPermissions = [];
    // roleName and teamName are already fetched above
    try {
      console.log("Querying role_capability with:", {
        roleName,
        teamName,
        companyName,
      });

      // Step 1: Get capability_id from role_capability
      const [capability_id] = await pool.query(
        `SELECT capability_id FROM role_capability WHERE role = ? AND team = ? AND company = ?`,
        [roleName, teamName, companyName]
      );
      console.log("Capability ID fetched:", capability_id);
      // capability_id format is [{ capability_id: 1 },{capability_id:3}] or []
      const all_capability_ids = [];
      for (const capObj of capability_id) {
        if (capObj && capObj.capability_id) {
          all_capability_ids.push(capObj.capability_id);
        }
      }
      console.log("All capability IDs collected:", all_capability_ids);

      if (all_capability_ids.length > 0) {
        const allfeatureIds = [];
        // Step 2: For each capability_id, get feature IDs from features_capability
        for (const capIdObj of all_capability_ids) {
          const [featureId] = await pool.query(
            `SELECT features_json FROM features_capability WHERE capability_id = ?`,
            [capIdObj]
          );
          console.log("Feature IDs rows fetched:", featureId[0].features_json[0]);
          allfeatureIds.push(featureId[0].features_json[0]);

          
        }

        console.log("All feature IDs collected:", allfeatureIds);

        if (allfeatureIds.length > 0) {
          // Step 3: Get feature details from features table
          const placeholders = allfeatureIds.map(() => "?").join(",");
          const [user_features] = await pool.query(
            `SELECT id, feature_name, feature_tag, type FROM features WHERE id IN (${placeholders}) AND type = ?`,
            [...allfeatureIds, "frontend"]
          );
          console.log("User features fetched:", user_features);

          // Step 5: Map to uiPermissions format
          uiPermissions = user_features.map((f) => ({
            id: f.id,
            feature_name: f.feature_name,
            feature_tag: f.feature_tag,
            type: f.type,
          }));

          console.log("Final uiPermissions:", uiPermissions);
        }
      } else {
        console.log("⚠️ No capability found for this role/team/company");
      }
    } catch (e) {
      // If capability tables are not present or query fails, continue without permissions
      console.error("❌ Capability lookup FAILED:", e.message);
      console.error("Full error:", e);
    }

    // Create JWT payload with user info and permissions
    const tokenPayload = {
      id: user.id,
      name: user.name,
      email: user.email,
      role: roleName, // Use the fetched role name
      team: teamName, // Use the fetched team name
      company: companySlug || user.company,
      companyId: companysID && companysID[0] ? companysID[0].id : undefined,
      company_id: companysID && companysID[0] ? companysID[0].id : undefined, // Add this for consistency
      uiPermissions,
    };

    console.log(
      "JWT Payload being created:",
      JSON.stringify(tokenPayload, null, 2)
    );

    let token;
    try {
      token = signToken(tokenPayload);
    } catch (e) {
      console.error(
        "Failed to sign JWT token:",
        e && e.message ? e.message : e
      );
      return res.status(500).json({
        message: "Server error: failed to create authentication token",
      });
    }

    // Send token as cookie
    res.cookie("token", token, {
      httpOnly: true,
      sameSite: process.env.NODE_ENV === "production" ? "strict" : "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 7 * 24 * 3600 * 1000,
    });

    // Determine the dashboard route based on user role (already fetched above)
    console.log("Determining dashboard route for role:", roleName);

    let dashboardRoute = `/${companySlug}/${appSlug}/${roleName}/dashboard`;

    res.status(200).json({
      message: "Login successful",
      user: tokenPayload,
      token,
      dashboardRoute,
      company: {
        slug: correctCompanySlug,
        name: companys[0].name,
      },
      app: req.app,
    });
  } catch (err) {
    console.error("Login error:", err);
    // Include error.message during development to help debugging
    res
      .status(500)
      .json({ message: "Server error during login", error: err.message });
  }
};

// Verify token from cookie and return user payload (if valid)
export const verifyUser = async (req, res) => {
  try {
    let token = req.cookies?.token;
    if (!token && req.headers && req.headers.authorization) {
      const auth = req.headers.authorization;
      if (typeof auth === "string" && auth.startsWith("Bearer ")) {
        token = auth.substring("Bearer ".length);
      }
    }
    if (!token) return res.status(401).json({ message: "Not authenticated" });
    const decoded = verifyToken(token);
    if (!decoded)
      return res.status(403).json({ message: "Invalid or expired token" });
    return res.status(200).json({ user: decoded });
  } catch (err) {
    console.error("Verify user error:", err);
    return res.status(500).json({ message: "Server error" });
  }
};
