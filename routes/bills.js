const express = require('express');
const { pool } = require('../config/database');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

// Get bills with filters and pagination
router.get('/', authenticateToken, async (req, res) => {
  const { 
    date, 
    party_name, 
    status, 
    page = 1, 
    limit = 50,
    search 
  } = req.query;

  try {
    let whereClause = 'WHERE 1=1';
    const params = [];
    let paramIndex = 1;

    // Date filter
    if (date) {
      whereClause += ` AND bs.bill_date = $${paramIndex}`;
      params.push(date);
      paramIndex++;
    }

    // Party name filter
    if (party_name) {
      whereClause += ` AND bs.party_name ILIKE $${paramIndex}`;
      params.push(`%${party_name}%`);
      paramIndex++;
    }

    // Status filter
    if (status) {
      whereClause += ` AND bs.status = $${paramIndex}`;
      params.push(status);
      paramIndex++;
    }

    // Search filter (bill_no or party_name)
    if (search) {
      whereClause += ` AND (bs.bill_no ILIKE $${paramIndex} OR bs.party_name ILIKE $${paramIndex})`;
      params.push(`%${search}%`);
      paramIndex++;
    }

    // Pagination
    const offset = (page - 1) * limit;

    const query = `
      SELECT 
        bs.*,
        rs.release_status,
        rs.release_ts,
        CASE 
          WHEN rs.release_status = 'RELEASED_SELF' THEN 'Customer'
          WHEN rs.release_status IN ('IN_TRANSIT', 'DELIVERED') THEN 'Transporter'
          ELSE NULL
        END as release_method
      FROM bill_status bs
      LEFT JOIN release_status rs ON bs.bill_no = rs.bill_no
      ${whereClause}
      ORDER BY bs.bill_date DESC, bs.bill_no DESC
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `;

    params.push(limit, offset);

    const result = await pool.query(query, params);

    // Get total count for pagination
    const countQuery = `
      SELECT COUNT(*) as total
      FROM bill_status bs
      LEFT JOIN release_status rs ON bs.bill_no = rs.bill_no
      ${whereClause}
    `;

    const countResult = await pool.query(countQuery, params.slice(0, -2));
    const total = parseInt(countResult.rows[0].total);

    res.json({
      bills: result.rows,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    });

  } catch (error) {
    console.error('Bills fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch bills' });
  }
});

// Get specific bill details
router.get('/:bill_no', authenticateToken, async (req, res) => {
  const { bill_no } = req.params;

  try {
    // Get bill with status
    const billResult = await pool.query(`
      SELECT 
        bs.*,
        rs.release_status,
        rs.release_ts,
        rs.dispatcher_id
      FROM bill_status bs
      LEFT JOIN release_status rs ON bs.bill_no = rs.bill_no
      WHERE bs.bill_no = $1
    `, [bill_no]);

    if (billResult.rows.length === 0) {
      return res.status(404).json({ error: 'Bill not found' });
    }

    const bill = billResult.rows[0];

    // Get payment hints
    const paymentsResult = await pool.query(`
      SELECT 
        ph.*,
        u.full_name as cashier_name
      FROM payment_hint ph
      LEFT JOIN users u ON ph.cashier_id = u.id
      WHERE ph.bill_no = $1
      ORDER BY ph.created_at DESC
    `, [bill_no]);

    // Get mapped receipts
    const receiptsResult = await pool.query(`
      SELECT * FROM receipt 
      WHERE bill_reference = $1
      ORDER BY receipt_date ASC
    `, [bill_no]);

    // Get release details if released
    let releaseDetails = null;
    if (bill.release_status !== 'READY') {
      const selfRelease = await pool.query(`
        SELECT 
          rs.*,
          u.full_name as dispatcher_name,
          m.full_name as approved_by_name
        FROM release_self rs
        LEFT JOIN users u ON rs.dispatcher_id = u.id
        LEFT JOIN users m ON rs.approved_by_manager_id = m.id
        WHERE rs.bill_no = $1
      `, [bill_no]);

      if (selfRelease.rows.length > 0) {
        releaseDetails = { type: 'self', ...selfRelease.rows[0] };
      } else {
        const transportRelease = await pool.query(`
          SELECT 
            rt.*,
            u.full_name as dispatcher_name,
            m.full_name as approved_by_name
          FROM release_transporter rt
          LEFT JOIN users u ON rt.dispatcher_id = u.id
          LEFT JOIN users m ON rt.approved_by_manager_id = m.id
          WHERE rt.bill_no = $1
        `, [bill_no]);

        if (transportRelease.rows.length > 0) {
          releaseDetails = { type: 'transporter', ...transportRelease.rows[0] };
        }
      }
    }

    // Get gate log
    const gateLogResult = await pool.query(`
      SELECT 
        gl.*,
        u.full_name as security_name
      FROM gate_log gl
      LEFT JOIN users u ON gl.security_id = u.id
      WHERE gl.bill_no = $1
      ORDER BY gl.gate_ts DESC
    `, [bill_no]);

    res.json({
      bill,
      payments: paymentsResult.rows,
      receipts: receiptsResult.rows,
      release: releaseDetails,
      gateLog: gateLogResult.rows
    });

  } catch (error) {
    console.error('Bill details error:', error);
    res.status(500).json({ error: 'Failed to fetch bill details' });
  }
});

// Get dashboard summary
router.get('/dashboard/summary', authenticateToken, async (req, res) => {
  const { date = new Date().toISOString().split('T')[0] } = req.query;

  try {
    // Bills summary
    const billsSummary = await pool.query(`
      SELECT 
        COUNT(*) as total_bills,
        SUM(bill_amount) as total_amount,
        COUNT(CASE WHEN status = 'PAID' THEN 1 END) as paid_bills,
        COUNT(CASE WHEN status = 'PART-PAID' THEN 1 END) as partial_bills,
        COUNT(CASE WHEN status = 'DUE' THEN 1 END) as due_bills,
        SUM(remaining_due) as total_due
      FROM bill_status
      WHERE bill_date = $1
    `, [date]);

    // Release summary
    const releaseSummary = await pool.query(`
      SELECT 
        COUNT(CASE WHEN rs.release_status = 'READY' THEN 1 END) as ready_count,
        COUNT(CASE WHEN rs.release_status = 'RELEASED_SELF' THEN 1 END) as released_self_count,
        COUNT(CASE WHEN rs.release_status = 'IN_TRANSIT' THEN 1 END) as in_transit_count,
        COUNT(CASE WHEN rs.release_status = 'DELIVERED' THEN 1 END) as delivered_count
      FROM bill_status bs
      LEFT JOIN release_status rs ON bs.bill_no = rs.bill_no
      WHERE bs.bill_date = $1
    `, [date]);

    // Active sessions
    const activeSessions = await pool.query(`
      SELECT 
        cs.*,
        u.full_name as cashier_name
      FROM cashier_session cs
      JOIN users u ON cs.cashier_id = u.id
      WHERE cs.status = 'ACTIVE'
    `);

    res.json({
      date,
      bills: billsSummary.rows[0],
      releases: releaseSummary.rows[0],
      activeSessions: activeSessions.rows
    });

  } catch (error) {
    console.error('Dashboard summary error:', error);
    res.status(500).json({ error: 'Failed to fetch dashboard summary' });
  }
});

module.exports = router;