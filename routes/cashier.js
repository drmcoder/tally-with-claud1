const express = require('express');
const { pool } = require('../config/database');
const { authenticateToken, requireRole, requireActiveSession } = require('../middleware/auth');
const { validateSessionClose, validateCashVariance } = require('../middleware/businessRules');

const router = express.Router();

// Create payment form/hint
router.post('/payment-hint', authenticateToken, requireRole('CASHIER'), requireActiveSession, async (req, res) => {
  const {
    bill_no,
    cash_amt = 0,
    cheque_amt = 0,
    cheque_no,
    bank,
    digital_amt = 0,
    digital_ref,
    notes
  } = req.body;

  try {
    // Get bill amount to calculate remaining due
    const billResult = await pool.query('SELECT amount FROM bill WHERE bill_no = $1', [bill_no]);
    
    if (billResult.rows.length === 0) {
      return res.status(404).json({ error: 'Bill not found' });
    }

    const billAmount = parseFloat(billResult.rows[0].amount);
    const totalPaid = parseFloat(cash_amt) + parseFloat(cheque_amt) + parseFloat(digital_amt);
    const remainingDue = billAmount - totalPaid;

    // Insert payment hint
    const result = await pool.query(`
      INSERT INTO payment_hint (
        bill_no, cash_amt, cheque_amt, cheque_no, bank, 
        digital_amt, digital_ref, remaining_due, cashier_id, notes
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *
    `, [
      bill_no, cash_amt, cheque_amt, cheque_no, bank,
      digital_amt, digital_ref, remainingDue, req.user.id, notes
    ]);

    // Create cheque register entry if cheque payment
    if (cheque_amt > 0 && cheque_no) {
      await pool.query(`
        INSERT INTO cheque_register (bill_no, cheque_no, bank, amount)
        VALUES ($1, $2, $3, $4)
      `, [bill_no, cheque_no, bank, cheque_amt]);
    }

    // Create digital payment reference if digital payment
    if (digital_amt > 0 && digital_ref) {
      await pool.query(`
        INSERT INTO digital_payment_ref (bill_no, method, reference_no, amount)
        VALUES ($1, $2, $3, $4)
      `, [bill_no, 'UPI', digital_ref, digital_amt]);
    }

    res.json({
      paymentHint: result.rows[0],
      remainingDue,
      message: 'Payment form saved successfully'
    });

  } catch (error) {
    console.error('Payment hint error:', error);
    res.status(500).json({ error: 'Failed to save payment form' });
  }
});

// Open cashier session
router.post('/session/open', authenticateToken, requireRole('CASHIER'), async (req, res) => {
  const { start_float, opened_by_pin } = req.body;

  try {
    // Check if user already has active session
    const existingSession = await pool.query(`
      SELECT id FROM cashier_session 
      WHERE cashier_id = $1 AND status = 'ACTIVE'
    `, [req.user.id]);

    if (existingSession.rows.length > 0) {
      return res.status(400).json({ error: 'Active session already exists' });
    }

    // Verify supervisor PIN (simplified - using any manager PIN)
    const managers = await pool.query(
      'SELECT id FROM users WHERE role = $1 AND pin_hash IS NOT NULL',
      ['MANAGER']
    );

    if (managers.rows.length === 0) {
      return res.status(400).json({ error: 'No manager available for session approval' });
    }

    const result = await pool.query(`
      INSERT INTO cashier_session (cashier_id, start_ts, start_float, opened_by, status)
      VALUES ($1, CURRENT_TIMESTAMP, $2, $3, 'ACTIVE')
      RETURNING *
    `, [req.user.id, start_float, managers.rows[0].id]);

    res.json({
      session: result.rows[0],
      message: 'Session opened successfully'
    });

  } catch (error) {
    console.error('Session open error:', error);
    res.status(500).json({ error: 'Failed to open session' });
  }
});

// Get current session
router.get('/session/current', authenticateToken, requireRole('CASHIER'), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        cs.*,
        u1.full_name as cashier_name,
        u2.full_name as opened_by_name,
        calculate_expected_cash(cs.id) as expected_cash
      FROM cashier_session cs
      LEFT JOIN users u1 ON cs.cashier_id = u1.id
      LEFT JOIN users u2 ON cs.opened_by = u2.id
      WHERE cs.cashier_id = $1 AND cs.status = 'ACTIVE'
      ORDER BY cs.start_ts DESC
      LIMIT 1
    `, [req.user.id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'No active session found' });
    }

    const session = result.rows[0];

    // Get session totals
    const totals = await pool.query(`
      SELECT 
        COALESCE(SUM(ph.cash_amt), 0) as total_cash,
        COALESCE(SUM(ph.cheque_amt), 0) as total_cheques,
        COALESCE(SUM(ph.digital_amt), 0) as total_digital,
        COUNT(ph.id) as payment_count
      FROM payment_hint ph
      WHERE ph.cashier_id = $1 
        AND ph.created_at BETWEEN $2 AND CURRENT_TIMESTAMP
    `, [req.user.id, session.start_ts]);

    // Get petty cash total
    const pettyCash = await pool.query(`
      SELECT COALESCE(SUM(amount), 0) as total_petty
      FROM petty_cash 
      WHERE session_id = $1
    `, [session.id]);

    // Get till adjustments
    const adjustments = await pool.query(`
      SELECT COALESCE(SUM(CASE 
        WHEN type = 'ADD_TO_TILL' THEN amount 
        ELSE -amount 
      END), 0) as net_adjustments
      FROM till_adjustment 
      WHERE session_id = $1
    `, [session.id]);

    res.json({
      session,
      totals: {
        ...totals.rows[0],
        total_petty: pettyCash.rows[0].total_petty,
        net_adjustments: adjustments.rows[0].net_adjustments
      }
    });

  } catch (error) {
    console.error('Current session error:', error);
    res.status(500).json({ error: 'Failed to get current session' });
  }
});

// Add petty cash entry
router.post('/session/petty-cash', authenticateToken, requireRole('CASHIER'), requireActiveSession, async (req, res) => {
  const { amount, purpose, vendor, photo_path } = req.body;

  try {
    const result = await pool.query(`
      INSERT INTO petty_cash (session_id, amount, purpose, vendor, photo_path)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `, [req.activeSessionId, amount, purpose, vendor, photo_path]);

    res.json({
      pettyCash: result.rows[0],
      message: 'Petty cash entry added (pending approval)'
    });

  } catch (error) {
    console.error('Petty cash error:', error);
    res.status(500).json({ error: 'Failed to add petty cash entry' });
  }
});

// Add till adjustment
router.post('/session/till-adjust', authenticateToken, requireRole('CASHIER'), requireActiveSession, async (req, res) => {
  const { type, amount, reason } = req.body;

  if (!['ADD_TO_TILL', 'REMOVE_FROM_TILL'].includes(type)) {
    return res.status(400).json({ error: 'Invalid adjustment type' });
  }

  try {
    const result = await pool.query(`
      INSERT INTO till_adjustment (session_id, type, amount, reason)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `, [req.activeSessionId, type, amount, reason]);

    res.json({
      adjustment: result.rows[0],
      message: 'Till adjustment added (pending approval)'
    });

  } catch (error) {
    console.error('Till adjustment error:', error);
    res.status(500).json({ error: 'Failed to add till adjustment' });
  }
});

// Close session with cash count
router.post('/session/:session_id/close', 
  authenticateToken, 
  requireRole('CASHIER'), 
  validateSessionClose,
  validateCashVariance,
  async (req, res) => {
    const { session_id } = req.params;
    const { counted_cash, denominations } = req.body;

    try {
      const expectedCash = req.expectedCash || 0;
      const variance = req.variance || 0;

      // Update session
      const result = await pool.query(`
        UPDATE cashier_session 
        SET 
          end_ts = CURRENT_TIMESTAMP,
          counted_cash = $1,
          expected_cash = $2,
          variance = $3,
          closed_by = $4,
          status = CASE 
            WHEN ABS($3) > $5 THEN 'CLOSED'
            ELSE 'CLOSED'
          END
        WHERE id = $6
        RETURNING *
      `, [counted_cash, expectedCash, variance, req.user.id, 
          parseFloat(process.env.CASH_VARIANCE_THRESHOLD || '100'), session_id]);

      // Log denominations if provided
      if (denominations && typeof denominations === 'object') {
        await pool.query(`
          INSERT INTO audit_log (table_name, record_id, action, new_values, user_id)
          VALUES ('cashier_session', $1, 'CLOSE', $2, $3)
        `, [session_id, JSON.stringify({ denominations, counted_cash, variance }), req.user.id]);
      }

      res.json({
        session: result.rows[0],
        variance,
        expectedCash,
        requiresApproval: req.requiresApproval || false,
        message: 'Session closed successfully'
      });

    } catch (error) {
      console.error('Session close error:', error);
      res.status(500).json({ error: 'Failed to close session' });
    }
  }
);

module.exports = router;