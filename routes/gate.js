const express = require('express');
const { pool } = require('../config/database');
const { authenticateToken, requireRole } = require('../middleware/auth');

const router = express.Router();

// Create gate log entry
router.post('/log', authenticateToken, requireRole('SECURITY', 'ADMIN'), async (req, res) => {
  const { gatepass_id, vehicle_no, bill_no } = req.body;

  if (!gatepass_id) {
    return res.status(400).json({ error: 'Gatepass ID is required' });
  }

  try {
    // Validate gatepass_id exists in releases
    const releaseCheck = await pool.query(`
      SELECT bill_no FROM release_self WHERE gatepass_id = $1
      UNION ALL
      SELECT bill_no FROM release_transporter WHERE gatepass_id = $1
    `, [gatepass_id]);

    if (releaseCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Invalid gatepass ID - no release found' });
    }

    const releaseBillNo = releaseCheck.rows[0].bill_no;
    const finalBillNo = bill_no || releaseBillNo;

    // Check if gate log already exists for this gatepass
    const existingLog = await pool.query(
      'SELECT id FROM gate_log WHERE gatepass_id = $1',
      [gatepass_id]
    );

    if (existingLog.rows.length > 0) {
      return res.status(400).json({ error: 'Gate log already exists for this gatepass' });
    }

    // Create gate log entry
    const result = await pool.query(`
      INSERT INTO gate_log (bill_no, gatepass_id, vehicle_no, security_id)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `, [finalBillNo, gatepass_id, vehicle_no, req.user.id]);

    // Get enhanced result with bill and security info
    const logDetails = await pool.query(`
      SELECT 
        gl.*,
        b.party_name,
        b.amount,
        u.full_name as security_name,
        CASE 
          WHEN rs.bill_no IS NOT NULL THEN 'Self Pickup'
          WHEN rt.bill_no IS NOT NULL THEN 'Transporter'
          ELSE 'Unknown'
        END as release_type
      FROM gate_log gl
      LEFT JOIN bill b ON gl.bill_no = b.bill_no
      LEFT JOIN users u ON gl.security_id = u.id
      LEFT JOIN release_self rs ON gl.bill_no = rs.bill_no
      LEFT JOIN release_transporter rt ON gl.bill_no = rt.bill_no
      WHERE gl.id = $1
    `, [result.rows[0].id]);

    res.json({
      gateLog: logDetails.rows[0],
      message: 'Gate log entry created successfully'
    });

  } catch (error) {
    console.error('Gate log creation error:', error);
    res.status(500).json({ error: 'Failed to create gate log entry' });
  }
});

// Get gate log entries for today
router.get('/log', authenticateToken, requireRole('SECURITY', 'ADMIN'), async (req, res) => {
  const { date = new Date().toISOString().split('T')[0], limit = 50 } = req.query;

  try {
    const result = await pool.query(`
      SELECT 
        gl.*,
        b.party_name,
        b.amount,
        u.full_name as security_name,
        CASE 
          WHEN rs.bill_no IS NOT NULL THEN 'Self Pickup'
          WHEN rt.bill_no IS NOT NULL THEN 'Transporter'
          ELSE 'Unknown'
        END as release_type,
        COALESCE(rs.receiver_name, rt.transporter_name) as receiver_name
      FROM gate_log gl
      LEFT JOIN bill b ON gl.bill_no = b.bill_no
      LEFT JOIN users u ON gl.security_id = u.id
      LEFT JOIN release_self rs ON gl.bill_no = rs.bill_no
      LEFT JOIN release_transporter rt ON gl.bill_no = rt.bill_no
      WHERE DATE(gl.gate_ts) = $1
      ORDER BY gl.gate_ts DESC
      LIMIT $2
    `, [date, limit]);

    res.json({
      date,
      logs: result.rows,
      total: result.rows.length
    });

  } catch (error) {
    console.error('Gate log fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch gate logs' });
  }
});

// Get gate log by gatepass ID
router.get('/log/:gatepass_id', authenticateToken, requireRole('SECURITY', 'ADMIN'), async (req, res) => {
  const { gatepass_id } = req.params;

  try {
    const result = await pool.query(`
      SELECT 
        gl.*,
        b.party_name,
        b.amount,
        u.full_name as security_name,
        CASE 
          WHEN rs.bill_no IS NOT NULL THEN 'Self Pickup'
          WHEN rt.bill_no IS NOT NULL THEN 'Transporter'
          ELSE 'Unknown'
        END as release_type,
        COALESCE(rs.receiver_name, rt.transporter_name) as receiver_name,
        rs.receiver_phone,
        rt.lr_no,
        rt.driver_name,
        rt.driver_phone
      FROM gate_log gl
      LEFT JOIN bill b ON gl.bill_no = b.bill_no
      LEFT JOIN users u ON gl.security_id = u.id
      LEFT JOIN release_self rs ON gl.bill_no = rs.bill_no
      LEFT JOIN release_transporter rt ON gl.bill_no = rt.bill_no
      WHERE gl.gatepass_id = $1
    `, [gatepass_id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Gate log not found' });
    }

    res.json({
      gateLog: result.rows[0]
    });

  } catch (error) {
    console.error('Gate log details error:', error);
    res.status(500).json({ error: 'Failed to fetch gate log details' });
  }
});

// Validate gatepass before creating log
router.get('/validate/:gatepass_id', authenticateToken, requireRole('SECURITY', 'ADMIN'), async (req, res) => {
  const { gatepass_id } = req.params;

  try {
    // Check if gatepass exists in releases
    const releaseResult = await pool.query(`
      SELECT 
        'self' as type,
        rs.bill_no,
        rs.receiver_name as contact_name,
        rs.receiver_phone as contact_phone,
        b.party_name,
        b.amount,
        rs.released_ts
      FROM release_self rs
      JOIN bill b ON rs.bill_no = b.bill_no
      WHERE rs.gatepass_id = $1
      
      UNION ALL
      
      SELECT 
        'transporter' as type,
        rt.bill_no,
        rt.driver_name as contact_name,
        rt.driver_phone as contact_phone,
        b.party_name,
        b.amount,
        rt.pickup_ts as released_ts
      FROM release_transporter rt
      JOIN bill b ON rt.bill_no = b.bill_no
      WHERE rt.gatepass_id = $1
    `, [gatepass_id]);

    if (releaseResult.rows.length === 0) {
      return res.status(404).json({ error: 'Invalid gatepass ID' });
    }

    const release = releaseResult.rows[0];

    // Check if gate log already exists
    const existingLog = await pool.query(
      'SELECT gate_ts, vehicle_no FROM gate_log WHERE gatepass_id = $1',
      [gatepass_id]
    );

    const alreadyLogged = existingLog.rows.length > 0;

    res.json({
      valid: true,
      gatepass_id,
      release: {
        type: release.type,
        bill_no: release.bill_no,
        party_name: release.party_name,
        amount: release.amount,
        contact_name: release.contact_name,
        contact_phone: release.contact_phone,
        released_ts: release.released_ts
      },
      alreadyLogged,
      existingLog: alreadyLogged ? existingLog.rows[0] : null
    });

  } catch (error) {
    console.error('Gatepass validation error:', error);
    res.status(500).json({ error: 'Failed to validate gatepass' });
  }
});

// Get gate summary for dashboard
router.get('/summary', authenticateToken, requireRole('SECURITY', 'ADMIN'), async (req, res) => {
  const { date = new Date().toISOString().split('T')[0] } = req.query;

  try {
    // Get gate activity summary
    const summary = await pool.query(`
      SELECT 
        COUNT(*) as total_entries,
        COUNT(CASE WHEN rs.bill_no IS NOT NULL THEN 1 END) as self_pickups,
        COUNT(CASE WHEN rt.bill_no IS NOT NULL THEN 1 END) as transporter_pickups,
        COUNT(DISTINCT gl.vehicle_no) as unique_vehicles,
        COUNT(DISTINCT gl.security_id) as active_security
      FROM gate_log gl
      LEFT JOIN release_self rs ON gl.bill_no = rs.bill_no
      LEFT JOIN release_transporter rt ON gl.bill_no = rt.bill_no
      WHERE DATE(gl.gate_ts) = $1
    `, [date]);

    // Get hourly breakdown
    const hourlyBreakdown = await pool.query(`
      SELECT 
        EXTRACT(HOUR FROM gate_ts) as hour,
        COUNT(*) as entries
      FROM gate_log
      WHERE DATE(gate_ts) = $1
      GROUP BY EXTRACT(HOUR FROM gate_ts)
      ORDER BY hour
    `, [date]);

    // Get recent activity
    const recentActivity = await pool.query(`
      SELECT 
        gl.gatepass_id,
        gl.vehicle_no,
        gl.gate_ts,
        b.party_name,
        CASE 
          WHEN rs.bill_no IS NOT NULL THEN 'Self Pickup'
          WHEN rt.bill_no IS NOT NULL THEN 'Transporter'
        END as type
      FROM gate_log gl
      LEFT JOIN bill b ON gl.bill_no = b.bill_no
      LEFT JOIN release_self rs ON gl.bill_no = rs.bill_no
      LEFT JOIN release_transporter rt ON gl.bill_no = rt.bill_no
      WHERE DATE(gl.gate_ts) = $1
      ORDER BY gl.gate_ts DESC
      LIMIT 10
    `, [date]);

    res.json({
      date,
      summary: summary.rows[0],
      hourlyBreakdown: hourlyBreakdown.rows,
      recentActivity: recentActivity.rows
    });

  } catch (error) {
    console.error('Gate summary error:', error);
    res.status(500).json({ error: 'Failed to fetch gate summary' });
  }
});

module.exports = router;