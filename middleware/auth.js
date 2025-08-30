const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { pool } = require('../config/database');

// JWT authentication middleware
const authenticateToken = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    // Get fresh user data
    const result = await pool.query(
      'SELECT id, username, full_name, role, active FROM users WHERE id = $1',
      [decoded.userId]
    );

    if (result.rows.length === 0 || !result.rows[0].active) {
      return res.status(403).json({ error: 'User not found or inactive' });
    }

    req.user = result.rows[0];
    next();
  } catch (error) {
    return res.status(403).json({ error: 'Invalid or expired token' });
  }
};

// Role-based authorization middleware
const requireRole = (...roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    next();
  };
};

// Active session requirement for cashier operations
const requireActiveSession = async (req, res, next) => {
  try {
    const result = await pool.query(`
      SELECT id FROM cashier_session 
      WHERE cashier_id = $1 AND status = 'ACTIVE'
      ORDER BY start_ts DESC LIMIT 1
    `, [req.user.id]);

    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'No active cashier session' });
    }

    req.activeSessionId = result.rows[0].id;
    next();
  } catch (error) {
    res.status(500).json({ error: 'Session check failed' });
  }
};

// Manager PIN verification middleware
const verifyManagerPIN = async (req, res, next) => {
  const { manager_pin } = req.body;

  if (!manager_pin) {
    return res.status(400).json({ error: 'Manager PIN required' });
  }

  try {
    const result = await pool.query(
      'SELECT id, pin_hash FROM users WHERE role = $1 AND active = true',
      ['MANAGER']
    );

    let pinValid = false;
    let managerId = null;

    for (const manager of result.rows) {
      if (manager.pin_hash && await bcrypt.compare(manager_pin, manager.pin_hash)) {
        pinValid = true;
        managerId = manager.id;
        break;
      }
    }

    if (!pinValid) {
      return res.status(400).json({ error: 'Invalid manager PIN' });
    }

    req.managerId = managerId;
    next();
  } catch (error) {
    res.status(500).json({ error: 'PIN verification failed' });
  }
};

module.exports = {
  authenticateToken,
  requireRole,
  requireActiveSession,
  verifyManagerPIN,
};