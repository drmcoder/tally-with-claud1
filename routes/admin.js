const express = require('express');
const { pool } = require('../config/database');
const { authenticateToken, requireRole } = require('../middleware/auth');
const reportsService = require('../services/reports');
const etlService = require('../services/tally-xml-etl');
const path = require('path');

const router = express.Router();

// Get dispatch board overview
router.get('/dispatch-board', authenticateToken, requireRole('ADMIN', 'MANAGER'), async (req, res) => {
  const { date = new Date().toISOString().split('T')[0] } = req.query;

  try {
    // Get bills categorized by dispatch status
    const ready = await pool.query(`
      SELECT bs.*, ph.remaining_due as payment_due, u.full_name as cashier_name
      FROM bill_status bs
      LEFT JOIN payment_hint ph ON bs.bill_no = ph.bill_no
      LEFT JOIN users u ON ph.cashier_id = u.id
      LEFT JOIN release_status rs ON bs.bill_no = rs.bill_no
      WHERE bs.bill_date = $1 AND rs.release_status = 'READY'
      ORDER BY bs.bill_no
    `, [date]);

    const released = await pool.query(`
      SELECT 
        bs.*,
        rs.release_status,
        rs.release_ts,
        COALESCE(rself.receiver_name, rtrans.transporter_name) as receiver_name
      FROM bill_status bs
      JOIN release_status rs ON bs.bill_no = rs.bill_no
      LEFT JOIN release_self rself ON bs.bill_no = rself.bill_no
      LEFT JOIN release_transporter rtrans ON bs.bill_no = rtrans.bill_no
      WHERE bs.bill_date = $1 AND rs.release_status IN ('RELEASED_SELF', 'IN_TRANSIT', 'DELIVERED')
      ORDER BY rs.release_ts DESC
    `, [date]);

    const flagged = await pool.query(`
      SELECT bs.*, ph.remaining_due, rs.release_status
      FROM bill_status bs
      LEFT JOIN payment_hint ph ON bs.bill_no = ph.bill_no
      LEFT JOIN release_status rs ON bs.bill_no = rs.bill_no
      WHERE bs.bill_date = $1 AND bs.remaining_due > 0
      ORDER BY bs.remaining_due DESC
    `, [date]);

    res.json({
      date,
      ready: ready.rows,
      released: released.rows,
      flagged: flagged.rows,
      summary: {
        ready_count: ready.rows.length,
        released_count: released.rows.length,
        flagged_count: flagged.rows.length
      }
    });

  } catch (error) {
    console.error('Dispatch board error:', error);
    res.status(500).json({ error: 'Failed to fetch dispatch board data' });
  }
});

// Get exceptions report
router.get('/exceptions', authenticateToken, requireRole('ADMIN', 'MANAGER'), async (req, res) => {
  const { date = new Date().toISOString().split('T')[0] } = req.query;

  try {
    // Unmatched receipts
    const unmatchedReceipts = await pool.query(`
      SELECT * FROM receipt 
      WHERE receipt_date = $1 AND bill_reference IS NULL
      ORDER BY amount DESC
    `, [date]);

    // Due releases (bills released with outstanding balance)
    const dueReleases = await pool.query(`
      SELECT 
        bs.*,
        rs.release_status,
        rs.release_ts,
        COALESCE(rself.receiver_name, rtrans.transporter_name) as receiver_name,
        COALESCE(rself.approved_by_manager_id, rtrans.approved_by_manager_id) as manager_id,
        mgr.full_name as approved_by_name
      FROM bill_status bs
      JOIN release_status rs ON bs.bill_no = rs.bill_no
      LEFT JOIN release_self rself ON bs.bill_no = rself.bill_no
      LEFT JOIN release_transporter rtrans ON bs.bill_no = rtrans.bill_no
      LEFT JOIN users mgr ON COALESCE(rself.approved_by_manager_id, rtrans.approved_by_manager_id) = mgr.id
      WHERE bs.bill_date = $1 AND bs.remaining_due > 0 
        AND rs.release_status IN ('RELEASED_SELF', 'IN_TRANSIT', 'DELIVERED')
      ORDER BY bs.remaining_due DESC
    `, [date]);

    // Missing gate entries
    const missingGateEntries = await pool.query(`
      SELECT 
        r.bill_no,
        r.gatepass_id,
        b.party_name,
        r.release_ts,
        'Missing Gate Entry' as issue
      FROM (
        SELECT bill_no, gatepass_id, released_ts as release_ts FROM release_self
        UNION ALL
        SELECT bill_no, gatepass_id, pickup_ts as release_ts FROM release_transporter
      ) r
      JOIN bill b ON r.bill_no = b.bill_no
      LEFT JOIN gate_log gl ON r.gatepass_id = gl.gatepass_id
      WHERE b.bill_date = $1 AND gl.id IS NULL
      ORDER BY r.release_ts DESC
    `, [date]);

    // High cash variance sessions
    const highVarianceSessions = await pool.query(`
      SELECT 
        cs.*,
        u.full_name as cashier_name,
        ABS(cs.variance) as abs_variance
      FROM cashier_session cs
      JOIN users u ON cs.cashier_id = u.id
      WHERE DATE(cs.start_ts) = $1 
        AND ABS(cs.variance) > $2
        AND cs.status IN ('CLOSED', 'APPROVED')
      ORDER BY ABS(cs.variance) DESC
    `, [date, parseFloat(process.env.CASH_VARIANCE_THRESHOLD || '100')]);

    // Unapproved petty cash and adjustments
    const unapprovedItems = await pool.query(`
      SELECT 
        'petty_cash' as type,
        pc.id,
        pc.amount,
        pc.purpose as description,
        pc.created_at,
        cs.cashier_id,
        u.full_name as cashier_name
      FROM petty_cash pc
      JOIN cashier_session cs ON pc.session_id = cs.id
      JOIN users u ON cs.cashier_id = u.id
      WHERE DATE(pc.created_at) = $1 AND pc.approved_by IS NULL
      
      UNION ALL
      
      SELECT 
        'till_adjustment' as type,
        ta.id,
        ta.amount,
        ta.reason as description,
        ta.created_at,
        cs.cashier_id,
        u.full_name as cashier_name
      FROM till_adjustment ta
      JOIN cashier_session cs ON ta.session_id = cs.id
      JOIN users u ON cs.cashier_id = u.id
      WHERE DATE(ta.created_at) = $1 AND ta.approved_by IS NULL
      
      ORDER BY created_at DESC
    `, [date]);

    res.json({
      date,
      exceptions: {
        unmatchedReceipts: unmatchedReceipts.rows,
        dueReleases: dueReleases.rows,
        missingGateEntries: missingGateEntries.rows,
        highVarianceSessions: highVarianceSessions.rows,
        unapprovedItems: unapprovedItems.rows
      },
      summary: {
        total_exceptions: unmatchedReceipts.rows.length + dueReleases.rows.length + 
                         missingGateEntries.rows.length + highVarianceSessions.rows.length + 
                         unapprovedItems.rows.length,
        unmatched_receipts: unmatchedReceipts.rows.length,
        due_releases: dueReleases.rows.length,
        missing_gates: missingGateEntries.rows.length,
        high_variance: highVarianceSessions.rows.length,
        unapproved_items: unapprovedItems.rows.length
      }
    });

  } catch (error) {
    console.error('Exceptions report error:', error);
    res.status(500).json({ error: 'Failed to fetch exceptions report' });
  }
});

// Approve petty cash or till adjustment
router.post('/approve/:type/:id', authenticateToken, requireRole('ADMIN', 'MANAGER'), async (req, res) => {
  const { type, id } = req.params;

  if (!['petty_cash', 'till_adjustment'].includes(type)) {
    return res.status(400).json({ error: 'Invalid approval type' });
  }

  try {
    const table = type === 'petty_cash' ? 'petty_cash' : 'till_adjustment';
    
    const result = await pool.query(`
      UPDATE ${table} 
      SET approved_by = $1, approved_at = CURRENT_TIMESTAMP
      WHERE id = $2 AND approved_by IS NULL
      RETURNING *
    `, [req.user.id, id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Item not found or already approved' });
    }

    res.json({
      approved: result.rows[0],
      message: `${type.replace('_', ' ')} approved successfully`
    });

  } catch (error) {
    console.error('Approval error:', error);
    res.status(500).json({ error: 'Failed to approve item' });
  }
});

// Get cheque register with deposit batches
router.get('/cheques', authenticateToken, requireRole('ADMIN', 'MANAGER'), async (req, res) => {
  const { status, date } = req.query;

  try {
    let whereClause = 'WHERE 1=1';
    const params = [];
    let paramIndex = 1;

    if (status) {
      whereClause += ` AND cr.status = $${paramIndex}`;
      params.push(status);
      paramIndex++;
    }

    if (date) {
      whereClause += ` AND b.bill_date = $${paramIndex}`;
      params.push(date);
      paramIndex++;
    }

    const cheques = await pool.query(`
      SELECT 
        cr.*,
        b.party_name,
        b.bill_date,
        db.bank_name as deposit_bank,
        db.deposit_date
      FROM cheque_register cr
      JOIN bill b ON cr.bill_no = b.bill_no
      LEFT JOIN deposit_batch db ON cr.deposit_batch_id = db.id
      ${whereClause}
      ORDER BY cr.created_at DESC
    `, params);

    // Get deposit batches summary
    const batches = await pool.query(`
      SELECT 
        db.*,
        COUNT(cr.id) as cheque_count,
        u1.full_name as prepared_by_name,
        u2.full_name as approved_by_name
      FROM deposit_batch db
      LEFT JOIN cheque_register cr ON db.id = cr.deposit_batch_id
      LEFT JOIN users u1 ON db.prepared_by = u1.id
      LEFT JOIN users u2 ON db.approved_by = u2.id
      GROUP BY db.id, u1.full_name, u2.full_name
      ORDER BY db.created_at DESC
      LIMIT 10
    `);

    res.json({
      cheques: cheques.rows,
      batches: batches.rows,
      summary: {
        total: cheques.rows.length,
        pending: cheques.rows.filter(c => c.status === 'PENDING').length,
        deposited: cheques.rows.filter(c => c.status === 'DEPOSITED').length,
        cleared: cheques.rows.filter(c => c.status === 'CLEARED').length,
        bounced: cheques.rows.filter(c => c.status === 'BOUNCED').length
      }
    });

  } catch (error) {
    console.error('Cheques fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch cheques' });
  }
});

// Create deposit batch
router.post('/cheques/deposit-batch', authenticateToken, requireRole('ADMIN', 'MANAGER'), async (req, res) => {
  const { bank_name, deposit_date, total_cash, cheque_ids } = req.body;

  if (!cheque_ids || cheque_ids.length === 0) {
    return res.status(400).json({ error: 'At least one cheque required' });
  }

  try {
    const client = await pool.connect();
    await client.query('BEGIN');

    // Calculate total cheque amount
    const chequeTotal = await client.query(`
      SELECT SUM(amount) as total
      FROM cheque_register 
      WHERE id = ANY($1) AND status = 'PENDING'
    `, [cheque_ids]);

    const totalCheque = parseFloat(chequeTotal.rows[0].total || 0);

    // Create deposit batch
    const batch = await client.query(`
      INSERT INTO deposit_batch (bank_name, deposit_date, total_cash, total_cheque, prepared_by)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `, [bank_name, deposit_date, total_cash || 0, totalCheque, req.user.id]);

    // Update cheques to reference this batch
    await client.query(`
      UPDATE cheque_register 
      SET deposit_batch_id = $1, status = 'DEPOSITED'
      WHERE id = ANY($2) AND status = 'PENDING'
    `, [batch.rows[0].id, cheque_ids]);

    await client.query('COMMIT');
    client.release();

    res.json({
      batch: batch.rows[0],
      chequesUpdated: cheque_ids.length,
      totalAmount: totalCheque,
      message: 'Deposit batch created successfully'
    });

  } catch (error) {
    console.error('Deposit batch creation error:', error);
    res.status(500).json({ error: 'Failed to create deposit batch' });
  }
});

// Generate EOD report
router.post('/eod/prepare', authenticateToken, requireRole('ADMIN', 'MANAGER'), async (req, res) => {
  const { business_date, format = 'pdf' } = req.body;

  if (!business_date) {
    return res.status(400).json({ error: 'Business date required' });
  }

  try {
    // Check if EOD already exists
    const existing = await pool.query(
      'SELECT id FROM eod_sheet WHERE business_date = $1',
      [business_date]
    );

    let eodId;
    if (existing.rows.length > 0) {
      eodId = existing.rows[0].id;
    } else {
      // Create EOD record
      const eod = await pool.query(`
        INSERT INTO eod_sheet (business_date, prepared_by)
        VALUES ($1, $2)
        RETURNING id
      `, [business_date, req.user.id]);
      eodId = eod.rows[0].id;
    }

    // Generate report based on format
    let result;
    if (format === 'pdf') {
      result = await reportsService.generateEODPDF(business_date, req.user.full_name);
    } else if (format === 'csv') {
      result = await reportsService.generateEODCSV(business_date);
    } else {
      return res.status(400).json({ error: 'Invalid format. Use pdf or csv' });
    }

    res.json({
      eodId,
      fileName: result.fileName,
      downloadUrl: `/api/admin/download/${result.fileName}`,
      message: 'EOD report generated successfully'
    });

  } catch (error) {
    console.error('EOD preparation error:', error);
    res.status(500).json({ error: 'Failed to prepare EOD report' });
  }
});

// Download report file
router.get('/download/:filename', authenticateToken, requireRole('ADMIN', 'MANAGER'), (req, res) => {
  const { filename } = req.params;
  const filePath = path.join(__dirname, '../uploads/reports', filename);

  res.download(filePath, (err) => {
    if (err) {
      console.error('File download error:', err);
      res.status(404).json({ error: 'File not found' });
    }
  });
});

// Approve EOD sheet
router.post('/eod/:id/approve', authenticateToken, requireRole('ADMIN', 'MANAGER'), async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query(`
      UPDATE eod_sheet 
      SET approved_by = $1, approved_at = CURRENT_TIMESTAMP
      WHERE id = $2 AND approved_by IS NULL
      RETURNING *
    `, [req.user.id, id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'EOD sheet not found or already approved' });
    }

    res.json({
      eod: result.rows[0],
      message: 'EOD sheet approved successfully'
    });

  } catch (error) {
    console.error('EOD approval error:', error);
    res.status(500).json({ error: 'Failed to approve EOD sheet' });
  }
});

// Get system statistics
router.get('/statistics', authenticateToken, requireRole('ADMIN'), async (req, res) => {
  const { days = 7 } = req.query;

  try {
    const stats = await pool.query(`
      WITH daily_stats AS (
        SELECT 
          b.bill_date,
          COUNT(b.bill_no) as bills_count,
          SUM(b.amount) as bills_amount,
          COUNT(r.receipt_id) as receipts_count,
          SUM(r.amount) as receipts_amount
        FROM bill b
        LEFT JOIN receipt r ON r.receipt_date = b.bill_date
        WHERE b.bill_date >= CURRENT_DATE - INTERVAL '${days} days'
        GROUP BY b.bill_date
        ORDER BY b.bill_date DESC
      )
      SELECT * FROM daily_stats
    `);

    // Get user activity
    const userActivity = await pool.query(`
      SELECT 
        u.full_name,
        u.role,
        COUNT(DISTINCT cs.id) as sessions_count,
        COUNT(ph.id) as payments_count,
        COUNT(DISTINCT relf.bill_no) + COUNT(DISTINCT relt.bill_no) as releases_count
      FROM users u
      LEFT JOIN cashier_session cs ON u.id = cs.cashier_id 
        AND cs.start_ts >= CURRENT_DATE - INTERVAL '${days} days'
      LEFT JOIN payment_hint ph ON u.id = ph.cashier_id 
        AND ph.created_at >= CURRENT_DATE - INTERVAL '${days} days'
      LEFT JOIN release_self relf ON u.id = relf.dispatcher_id 
        AND relf.released_ts >= CURRENT_DATE - INTERVAL '${days} days'
      LEFT JOIN release_transporter relt ON u.id = relt.dispatcher_id 
        AND relt.pickup_ts >= CURRENT_DATE - INTERVAL '${days} days'
      WHERE u.active = true
      GROUP BY u.id, u.full_name, u.role
      ORDER BY u.role, u.full_name
    `);

    res.json({
      period: `Last ${days} days`,
      dailyStats: stats.rows,
      userActivity: userActivity.rows,
      summary: {
        totalBills: stats.rows.reduce((sum, day) => sum + parseInt(day.bills_count || 0), 0),
        totalAmount: stats.rows.reduce((sum, day) => sum + parseFloat(day.bills_amount || 0), 0),
        totalReceipts: stats.rows.reduce((sum, day) => sum + parseInt(day.receipts_count || 0), 0),
        totalReceiptAmount: stats.rows.reduce((sum, day) => sum + parseFloat(day.receipts_amount || 0), 0)
      }
    });

  } catch (error) {
    console.error('Statistics error:', error);
    res.status(500).json({ error: 'Failed to fetch statistics' });
  }
});

// Manual ETL trigger for Tally data sync
router.post('/etl/trigger', authenticateToken, requireRole('ADMIN', 'MANAGER'), async (req, res) => {
  try {
    await etlService.runManual();
    
    res.json({
      message: 'ETL process triggered successfully',
      status: 'completed',
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Manual ETL trigger error:', error);
    res.status(500).json({ 
      error: 'ETL process failed',
      message: error.message
    });
  }
});

// Get ETL status and last sync information
router.get('/etl/status', authenticateToken, requireRole('ADMIN', 'MANAGER'), async (req, res) => {
  try {
    // Get last sync timestamps from database
    const lastBillSync = await pool.query(`
      SELECT MAX(last_sync_ts) as last_sync FROM bill WHERE last_sync_ts IS NOT NULL
    `);
    
    const lastReceiptSync = await pool.query(`
      SELECT MAX(last_sync_ts) as last_sync FROM receipt WHERE last_sync_ts IS NOT NULL
    `);

    // Get sync stats
    const syncStats = await pool.query(`
      SELECT 
        (SELECT COUNT(*) FROM bill WHERE last_sync_ts >= CURRENT_DATE) as bills_synced_today,
        (SELECT COUNT(*) FROM receipt WHERE last_sync_ts >= CURRENT_DATE) as receipts_synced_today,
        (SELECT COUNT(*) FROM bill) as total_bills,
        (SELECT COUNT(*) FROM receipt) as total_receipts
    `);

    res.json({
      etl_running: etlService.isRunning || false,
      last_bill_sync: lastBillSync.rows[0]?.last_sync,
      last_receipt_sync: lastReceiptSync.rows[0]?.last_sync,
      sync_stats: syncStats.rows[0],
      tally_connection: etlService.connection ? 'connected' : 'disconnected',
      next_scheduled_run: 'Every minute (automatic)',
      status: 'operational'
    });

  } catch (error) {
    console.error('ETL status error:', error);
    res.status(500).json({ error: 'Failed to get ETL status' });
  }
});

module.exports = router;