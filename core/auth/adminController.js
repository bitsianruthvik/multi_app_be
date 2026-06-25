import bcrypt from "bcryptjs";
import { pool } from "../../db.js";
import { signToken } from "../utils/jwt.js";
import { logger } from "../utils/logger.js";

// DEPRECATED: FE now creates users via /api/query/v1/base_resource (mutate). This handler is kept for backwards compat only.
// Add new user (Admin only)
export const addUser = async (req, res) => {
  try {
    const { name, email, company, password, role, team } = req.body;

    // Require company context
    if (!req.company || !req.company.id) {
      return res.status(400).json({ message: "Company context required" });
    }

    // Ensure team exists (find or create)
    let teamId = null;
    if (team) {
      const [teamRows] = await pool.query(
        "SELECT id FROM teams WHERE name = ? AND company_id = ? LIMIT 1",
        [team, req.company.id]
      );
      if (teamRows.length === 0) {
        const [tRes] = await pool.query(
          "INSERT INTO teams (name, company_id) VALUES (?, ?)",
          [team, req.company.id]
        );
        teamId = tRes.insertId;
      } else {
        teamId = teamRows[0].id;
      }
    }

    // Ensure role exists (find or create)
    let roleId = null;
    if (role) {
      const [roleRows] = await pool.query(
        "SELECT id FROM roles WHERE name = ? AND company_id = ? LIMIT 1",
        [role, req.company.id]
      );
      if (roleRows.length === 0) {
        const [rRes] = await pool.query(
          "INSERT INTO roles (name, company_id) VALUES (?, ?)",
          [role, req.company.id]
        );
        roleId = rRes.insertId;
      } else {
        roleId = roleRows[0].id;
      }
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    await pool.query(
      "INSERT INTO users (name, email, password, role_id, team_id, company_id) VALUES (?, ?, ?, ?, ?, ?)",
      [name, email, hashedPassword, roleId, teamId, req.company.id]
    );

    res.status(201).json({ message: "User added successfully" });
  } catch (err) {
    logger.error({ err }, "Error adding user");
    res.status(500).json({ message: "Error adding user" });
  }
};

// Add feature
export const addFeature = async (req, res) => {
  try {
    const { feature_name, feature_tag, type } = req.body;
    await pool.query(
      "INSERT INTO features (feature_name, feature_tag, type) VALUES (?, ?, ?)",
      [feature_name, feature_tag, type]
    );
    res.status(201).json({ message: "Feature added successfully" });
  } catch (err) {
    logger.error({ err }, "Error adding feature");
    res.status(500).json({ message: "Error adding feature" });
  }
};

// Get list of features
export const getFeatures = async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT id, feature_name, feature_tag, type FROM features"
    );
    res.status(200).json(rows);
  } catch (err) {
    logger.error({ err }, "Error fetching features");
    // Return empty list if table missing or empty to allow UI empty-state
    res.status(200).json([]);
  }
};

// Add feature capability
export const addFeatureCapability = async (req, res) => {
  try {
    const { features_json } = req.body;
    const [result] = await pool.query(
      "INSERT INTO features_capability (features_json) VALUES (?)",
      [JSON.stringify(features_json || [])]
    );
    res
      .status(201)
      .json({ message: "Capability added successfully", id: result.insertId });
  } catch (err) {
    logger.error({ err }, "Error adding capability");
    res.status(500).json({ message: "Error adding capability" });
  }
};

// Get capabilities (feature_capability)
export const getCapabilities = async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT capability_id as id, features_json FROM features_capability"
    );
    // parse features_json for convenience with robust fallback
    const parsed = rows.map((r) => {
      let features = [];
      if (r && typeof r.features_json === "string") {
        try {
          const parsedJson = JSON.parse(r.features_json || "[]");
          features = Array.isArray(parsedJson) ? parsedJson : [];
        } catch (e) {
          features = [];
        }
      }
      return { id: r.id, features };
    });
    res.status(200).json(parsed);
  } catch (err) {
    logger.error({ err }, "Error fetching capabilities");
    // Return empty list if table missing or empty to allow UI empty-state
    res.status(200).json([]);
  }
};

// Get roles list (scoped to company if available)
export const getRoles = async (req, res) => {
  try {
    let rows;
    if (req.company && req.company.id) {
      [rows] = await pool.query(
        "SELECT id, name FROM roles WHERE company_id = ?",
        [req.company.id]
      );
    } else {
      [rows] = await pool.query("SELECT id, name FROM roles");
    }
    res.status(200).json(rows);
  } catch (err) {
    logger.error({ err }, "Error fetching roles");
    // Return empty list if table missing or empty to allow UI empty-state
    res.status(200).json([]);
  }
};

// Register admin (create team, role, user)
export const registerAdmin = async (req, res) => {
  try {
    const { name, email, password } = req.body;

    // Company context is required (provided by appContext middleware)
    if (!req.company || !req.company.id) {
      return res
        .status(400)
        .json({ message: "Company context required in URL" });
    }

    // Check if email already exists
    const [existingUsers] = await pool.query(
      "SELECT id FROM users WHERE email = ?",
      [email]
    );
    if (existingUsers.length > 0) {
      return res.status(400).json({ message: "Email already in use" });
    }

    // 1) Ensure default team exists for company
    const defaultTeamName = "Default";
    let teamId;
    const [teamRows] = await pool.query(
      "SELECT id FROM teams WHERE name = ? AND company_id = ? LIMIT 1",
      [defaultTeamName, req.company.id]
    );
    if (teamRows.length === 0) {
      const [tRes] = await pool.query(
        "INSERT INTO teams (name, company_id) VALUES (?, ?)",
        [defaultTeamName, req.company.id]
      );
      teamId = tRes.insertId;
    } else {
      teamId = teamRows[0].id;
    }

    // 2) Ensure Admin role exists for company
    const adminRoleName = "Admin";
    let roleId;
    const [roleRows] = await pool.query(
      "SELECT id FROM roles WHERE name = ? AND company_id = ? LIMIT 1",
      [adminRoleName, req.company.id]
    );
    if (roleRows.length === 0) {
      const [rRes] = await pool.query(
        "INSERT INTO roles (name, company_id) VALUES (?, ?)",
        [adminRoleName, req.company.id]
      );
      roleId = rRes.insertId;
    } else {
      roleId = roleRows[0].id;
    }

    // 3) Create user with FK ids
    const hashedPassword = await bcrypt.hash(password, 10);
    const [userRes] = await pool.query(
      "INSERT INTO users (name, email, password, role_id, team_id, company_id) VALUES (?, ?, ?, ?, ?, ?)",
      [name, email, hashedPassword, roleId, teamId, req.company.id]
    );

    const tokenPayload = {
      id: userRes.insertId,
      name,
      email,
      role: adminRoleName,
      companyId: req.company.id,
      company: req.company.slug,
    };

    const token = signToken(tokenPayload);

    // Send token as session cookie (cleared when browser closes)
    res.cookie("token", token, {
      httpOnly: true,
      sameSite: process.env.NODE_ENV === "production" ? "strict" : "lax",
      secure: process.env.NODE_ENV === "production",
    });

    res.status(200).json({
      message: "register successful",
      user: tokenPayload,
      token,
      company: {
        slug: req.company.slug,
        id: req.company.id,
        name: req.company.name,
      },
      app: req.appCtx
        ? { id: req.appCtx.id, slug: req.appCtx.slug, name: req.appCtx.name }
        : null,
      dashboardRoute: `/${req.company.slug}/${
        req.appCtx ? req.appCtx.slug : ""
      }/admin/dashboard`.replace("//", "/"),
    });
  } catch (err) {
    logger.error({ err }, "Error registering admin");
    res
      .status(500)
      .json({ message: "Error registering admin", error: err.message });
  }
};

// Map role-team-company to capability using FK ids.
// Accepts role/team as names and resolves them to ids (same pattern as addUser).
export const addRoleCapability = async (req, res) => {
  try {
    const { role, team, capability_id } = req.body;

    // Require company context from middleware
    if (!req.company || !req.company.id) {
      return res.status(400).json({ message: "Company context required" });
    }
    const companyId = req.company.id;

    // Resolve role name to id (find or create)
    let roleId = null;
    if (role) {
      const [roleRows] = await pool.query(
        "SELECT id FROM roles WHERE name = ? AND company_id = ? LIMIT 1",
        [role, companyId]
      );
      if (roleRows.length === 0) {
        const [rRes] = await pool.query(
          "INSERT INTO roles (name, company_id) VALUES (?, ?)",
          [role, companyId]
        );
        roleId = rRes.insertId;
      } else {
        roleId = roleRows[0].id;
      }
    }

    // Resolve team name to id (find or create)
    let teamId = null;
    if (team) {
      const [teamRows] = await pool.query(
        "SELECT id FROM teams WHERE name = ? AND company_id = ? LIMIT 1",
        [team, companyId]
      );
      if (teamRows.length === 0) {
        const [tRes] = await pool.query(
          "INSERT INTO teams (name, company_id) VALUES (?, ?)",
          [team, companyId]
        );
        teamId = tRes.insertId;
      } else {
        teamId = teamRows[0].id;
      }
    }

    await pool.query(
      "INSERT INTO role_capability (role_id, team_id, company_id, capability_id) VALUES (?, ?, ?, ?)",
      [roleId, teamId, companyId, capability_id]
    );
    res
      .status(201)
      .json({ message: "Role-capability mapping added successfully" });
  } catch (err) {
    logger.error({ err }, "Error mapping role-capability");
    res.status(500).json({ message: "Error mapping role-capability" });
  }
};

export const updateRoleCapability = async (req, res) => {
  try {
    const { id, role, team, capability_id } = req.body;

    if (!req.company || !req.company.id) {
      return res.status(400).json({ message: "Company context required" });
    }
    const companyId = req.company.id;

    if (!id) {
      return res.status(400).json({ message: "id is required for update" });
    }

    // Resolve role name to id if provided
    let roleId = null;
    if (role) {
      const [roleRows] = await pool.query(
        "SELECT id FROM roles WHERE name = ? AND company_id = ? LIMIT 1",
        [role, companyId]
      );
      if (roleRows.length === 0) {
        const [rRes] = await pool.query(
          "INSERT INTO roles (name, company_id) VALUES (?, ?)",
          [role, companyId]
        );
        roleId = rRes.insertId;
      } else {
        roleId = roleRows[0].id;
      }
    }

    // Resolve team name to id if provided
    let teamId = null;
    if (team) {
      const [teamRows] = await pool.query(
        "SELECT id FROM teams WHERE name = ? AND company_id = ? LIMIT 1",
        [team, companyId]
      );
      if (teamRows.length === 0) {
        const [tRes] = await pool.query(
          "INSERT INTO teams (name, company_id) VALUES (?, ?)",
          [team, companyId]
        );
        teamId = tRes.insertId;
      } else {
        teamId = teamRows[0].id;
      }
    }

    await pool.query(
      "UPDATE role_capability SET role_id = ?, team_id = ?, company_id = ?, capability_id = ? WHERE id = ? AND company_id = ?",
      [roleId, teamId, companyId, capability_id, id, companyId]
    );
    res
      .status(200)
      .json({ message: "Role-capability mapping updated successfully" });
  } catch (err) {
    logger.error({ err }, "Error updating role-capability");
    res.status(500).json({ message: "Error updating role-capability" });
  }
};
