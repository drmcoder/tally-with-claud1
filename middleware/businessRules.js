const { pool } = require('../config/database');

// Check if bill can be released (payment and session rules)
const validateRelease = async (req, res, next) => {
  const { bill_no } = req.params || req.body;

  try {
    // Check if bill exists and get status
    const billStatus = await pool.query(`
      SELECT bs.*, b.amount 
      FROM bill_status bs
      JOIN bill b ON bs.bill_no = b.bill_no
      WHERE bs.bill_no = $1
    `, [bill_no]);

    if (billStatus.rows.length === 0) {
      return res.status(404).json({ error: 'Bill not found' });
    }

    const bill = billStatus.rows[0];

    // Check if already released
    const existingRelease = await pool.query(`
      SELECT 'self' as type FROM release_self WHERE bill_no = $1
      UNION ALL
      SELECT 'transporter' as type FROM release_transporter WHERE bill_no = $1
    `, [bill_no]);

    if (existingRelease.rows.length > 0) {
      return res.status(400).json({ 
        error: 'Bill already released',
        releaseType: existingRelease.rows[0].type
      });
    }

    // Check if there's remaining due and no manager approval
    if (bill.remaining_due > 0 && !req.body.manager_pin && !req.body.otp_verified) {
      return res.status(400).json({ 
        error: 'Outstanding due requires manager PIN or customer OTP',
        remainingDue: bill.remaining_due
      });
    }

    req.billData = bill;
    next();

  } catch (error) {
    res.status(500).json({ error: 'Release validation failed' });
  }
};

// Prevent session close if there are paid but unreleased bills
const validateSessionClose = async (req, res, next) => {
  const { session_id } = req.params;

  try {
    // Get session details
    const session = await pool.query(
      'SELECT * FROM cashier_session WHERE id = $1',
      [session_id]
    );

    if (session.rows.length === 0) {
      return res.status(404).json({ error: 'Session not found' });
    }

    if (session.rows[0].status !== 'ACTIVE') {
      return res.status(400).json({ error: 'Session already closed' });
    }

    // Check for paid bills from this session that are not released
    const unreleasedPaid = await pool.query(`
      SELECT ph.bill_no, bs.status
      FROM payment_hint ph
      JOIN bill_status bs ON ph.bill_no = bs.bill_no
      LEFT JOIN release_self rs ON ph.bill_no = rs.bill_no
      LEFT JOIN release_transporter rt ON ph.bill_no = rt.bill_no
      WHERE ph.cashier_id = $1
        AND ph.created_at BETWEEN $2 AND CURRENT_TIMESTAMP
        AND bs.status = 'PAID'
        AND rs.bill_no IS NULL 
        AND rt.bill_no IS NULL
    `, [session.rows[0].cashier_id, session.rows[0].start_ts]);

    if (unreleasedPaid.rows.length > 0) {
      return res.status(400).json({ 
        error: 'Cannot close session with unreleased paid bills',
        unreleasedBills: unreleasedPaid.rows.map(row => row.bill_no),
        warning: true
      });
    }

    req.sessionData = session.rows[0];
    next();

  } catch (error) {
    res.status(500).json({ error: 'Session close validation failed' });
  }
};

// Validate cash variance threshold
const validateCashVariance = async (req, res, next) => {
  const { counted_cash } = req.body;
  const { session_id } = req.params;

  try {
    // Calculate expected cash
    const result = await pool.query(
      'SELECT calculate_expected_cash($1) as expected_cash',
      [session_id]
    );

    const expectedCash = parseFloat(result.rows[0].expected_cash) || 0;
    const variance = parseFloat(counted_cash) - expectedCash;
    const varianceThreshold = parseFloat(process.env.CASH_VARIANCE_THRESHOLD || '100');

    if (Math.abs(variance) > varianceThreshold) {
      req.requiresApproval = true;
      req.variance = variance;
      req.expectedCash = expectedCash;
    }

    next();

  } catch (error) {
    res.status(500).json({ error: 'Variance validation failed' });
  }
};

// Check for duplicate gatepass ID
const validateGatepassId = async (req, res, next) => {
  const { gatepass_id } = req.body;

  try {
    const existing = await pool.query(`
      SELECT bill_no FROM release_self WHERE gatepass_id = $1
      UNION ALL
      SELECT bill_no FROM release_transporter WHERE gatepass_id = $1
    `, [gatepass_id]);

    if (existing.rows.length > 0) {
      return res.status(400).json({ 
        error: 'Gatepass ID already used',
        existingBill: existing.rows[0].bill_no
      });
    }

    next();

  } catch (error) {
    res.status(500).json({ error: 'Gatepass validation failed' });
  }
};

// Ensure unique release per bill (database constraint backup)
const enforceUniqueRelease = async (req, res, next) => {
  const { bill_no } = req.params || req.body;

  try {
    const client = await pool.connect();
    
    // Lock the bill row to prevent race conditions
    await client.query('BEGIN');
    await client.query(
      'SELECT bill_no FROM bill WHERE bill_no = $1 FOR UPDATE',
      [bill_no]
    );

    // Double-check no release exists
    const existing = await client.query(`
      SELECT bill_no FROM release_self WHERE bill_no = $1
      UNION ALL
      SELECT bill_no FROM release_transporter WHERE bill_no = $1
    `, [bill_no]);

    if (existing.rows.length > 0) {
      await client.query('ROLLBACK');
      client.release();
      return res.status(400).json({ error: 'Bill already has a release record' });
    }

    // Keep transaction open for the route handler
    req.dbClient = client;
    next();

  } catch (error) {
    if (req.dbClient) {
      await req.dbClient.query('ROLLBACK');
      req.dbClient.release();
    }
    res.status(500).json({ error: 'Release lock failed' });
  }
};

module.exports = {
  validateRelease,
  validateSessionClose,
  validateCashVariance,
  validateGatepassId,
  enforceUniqueRelease,
};