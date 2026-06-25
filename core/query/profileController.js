import bcrypt from 'bcryptjs';
import { pool } from '../../db.js';
import { logger } from '../utils/logger.js';

// GET /api/:company/:app/user/me
// Returns fresh user data from DB (not JWT-cached).
export async function getProfile(req, res) {
  try {
    const userId = req.user.id;
    const [rows] = await pool.query(
      `SELECT u.id, u.name, u.email, u.preferences,
              r.name AS role, t.name AS team
       FROM users u
       LEFT JOIN roles r ON u.role_id = r.id
       LEFT JOIN teams t ON u.team_id = t.id
       WHERE u.id = ? AND u.deleted_at IS NULL LIMIT 1`,
      [userId]
    );
    if (!rows.length) return res.status(404).json({ message: 'User not found' });
    const user = rows[0];
    let preferences = {};
    if (user.preferences) {
      try {
        preferences = typeof user.preferences === 'string'
          ? JSON.parse(user.preferences)
          : user.preferences;
      } catch (_) { preferences = {}; }
    }
    return res.json({
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      team: user.team,
      preferences,
    });
  } catch (e) {
    logger.error({ err: e }, 'getProfile error');
    return res.status(500).json({ message: 'Internal server error' });
  }
}

// PUT /api/:company/:app/user/profile
// Updates name and/or email.
export async function updateProfile(req, res) {
  try {
    const userId = req.user.id;
    const { name, email } = req.body || {};
    if (!name?.trim() && !email?.trim()) {
      return res.status(400).json({ message: 'Nothing to update' });
    }
    if (email?.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      return res.status(400).json({ message: 'Invalid email format' });
    }
    // Check email uniqueness if changing email
    if (email?.trim()) {
      const [existing] = await pool.query(
        'SELECT id FROM users WHERE email = ? AND id != ? LIMIT 1',
        [email.trim(), userId]
      );
      if (existing.length) {
        return res.status(409).json({ message: 'Email already in use by another account' });
      }
    }
    const updates = [];
    const params = [];
    if (name?.trim())  { updates.push('name = ?');  params.push(name.trim()); }
    if (email?.trim()) { updates.push('email = ?'); params.push(email.trim()); }
    params.push(userId);
    await pool.query(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, params);
    return res.json({ message: 'Profile updated successfully' });
  } catch (e) {
    logger.error({ err: e }, 'updateProfile error');
    return res.status(500).json({ message: 'Internal server error' });
  }
}

// PUT /api/:company/:app/user/change-password
// Verifies current password then sets a new one.
export async function changePassword(req, res) {
  try {
    const userId = req.user.id;
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ message: 'Current password and new password are required' });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({ message: 'New password must be at least 8 characters' });
    }
    if (currentPassword === newPassword) {
      return res.status(400).json({ message: 'New password must be different from current password' });
    }
    const [rows] = await pool.query(
      'SELECT password FROM users WHERE id = ? AND deleted_at IS NULL LIMIT 1',
      [userId]
    );
    if (!rows.length) return res.status(404).json({ message: 'User not found' });
    const isMatch = await bcrypt.compare(currentPassword, rows[0].password);
    if (!isMatch) {
      return res.status(401).json({ message: 'Current password is incorrect' });
    }
    const hashed = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE users SET password = ? WHERE id = ?', [hashed, userId]);
    return res.json({ message: 'Password changed successfully' });
  } catch (e) {
    logger.error({ err: e }, 'changePassword error');
    return res.status(500).json({ message: 'Internal server error' });
  }
}

// PUT /api/:company/:app/user/preferences
// Deep-merges incoming preferences with existing ones.
export async function updatePreferences(req, res) {
  try {
    const userId = req.user.id;
    const { preferences } = req.body || {};
    if (!preferences || typeof preferences !== 'object' || Array.isArray(preferences)) {
      return res.status(400).json({ message: 'preferences must be a plain object' });
    }
    const [rows] = await pool.query(
      'SELECT preferences FROM users WHERE id = ? AND deleted_at IS NULL LIMIT 1',
      [userId]
    );
    if (!rows.length) return res.status(404).json({ message: 'User not found' });
    let existing = {};
    if (rows[0].preferences) {
      try {
        existing = typeof rows[0].preferences === 'string'
          ? JSON.parse(rows[0].preferences)
          : rows[0].preferences;
      } catch (_) { existing = {}; }
    }
    const merged = { ...existing, ...preferences };
    await pool.query(
      'UPDATE users SET preferences = ? WHERE id = ?',
      [JSON.stringify(merged), userId]
    );
    return res.json({ message: 'Preferences saved', preferences: merged });
  } catch (e) {
    logger.error({ err: e }, 'updatePreferences error');
    return res.status(500).json({ message: 'Internal server error' });
  }
}
