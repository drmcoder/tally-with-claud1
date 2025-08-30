const express = require('express');
const { pool } = require('../config/database');
const { authenticateToken, requireRole, verifyManagerPIN } = require('../middleware/auth');
const { validateRelease, validateGatepassId, enforceUniqueRelease } = require('../middleware/businessRules');
const otpService = require('../services/otp');
const multer = require('multer');
const path = require('path');

const router = express.Router();

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(__dirname, '../uploads/dispatch'));
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ 
  storage, 
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|pdf/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    
    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error('Only images (JPEG, PNG) and PDF files are allowed'));
    }
  }
});

// Get release queue (today's bills ready for dispatch)
router.get('/queue', authenticateToken, requireRole('DISPATCHER', 'ADMIN'), async (req, res) => {
  const { date = new Date().toISOString().split('T')[0], status } = req.query;

  try {
    let whereClause = 'WHERE bs.bill_date = $1';
    const params = [date];
    let paramIndex = 2;

    if (status && status !== 'all') {
      if (status === 'ready') {
        whereClause += ' AND rs.release_status = $2';
        params.push('READY');
      } else if (status === 'released') {
        whereClause += ' AND rs.release_status IN ($2, $3, $4)';
        params.push('RELEASED_SELF', 'IN_TRANSIT', 'DELIVERED');
        paramIndex += 2;
      } else if (status === 'flagged') {
        whereClause += ' AND bs.remaining_due > 0';
      }
      paramIndex++;
    }

    const query = `
      SELECT 
        bs.*,
        rs.release_status,
        rs.release_ts,
        ph.cash_amt,
        ph.cheque_amt,
        ph.digital_amt,
        ph.remaining_due as payment_due,
        u.full_name as cashier_name,
        CASE 
          WHEN bs.remaining_due > 0 THEN true
          ELSE false
        END as requires_approval
      FROM bill_status bs
      LEFT JOIN release_status rs ON bs.bill_no = rs.bill_no
      LEFT JOIN payment_hint ph ON bs.bill_no = ph.bill_no
      LEFT JOIN users u ON ph.cashier_id = u.id
      ${whereClause}
      ORDER BY 
        CASE WHEN bs.remaining_due > 0 THEN 0 ELSE 1 END, -- Flagged first
        bs.bill_date DESC, 
        bs.bill_no DESC
    `;

    const result = await pool.query(query, params);

    res.json({
      date,
      queue: result.rows,
      summary: {
        total: result.rows.length,
        ready: result.rows.filter(row => row.release_status === 'READY').length,
        flagged: result.rows.filter(row => row.remaining_due > 0).length,
        released: result.rows.filter(row => ['RELEASED_SELF', 'IN_TRANSIT', 'DELIVERED'].includes(row.release_status)).length
      }
    });

  } catch (error) {
    console.error('Dispatch queue error:', error);
    res.status(500).json({ error: 'Failed to fetch dispatch queue' });
  }
});

// Get bill details for dispatch
router.get('/bill/:bill_no', authenticateToken, requireRole('DISPATCHER', 'ADMIN'), async (req, res) => {
  const { bill_no } = req.params;

  try {
    // Use the existing bill details endpoint logic but add dispatch-specific info
    const billResult = await pool.query(`
      SELECT 
        bs.*,
        rs.release_status,
        rs.release_ts,
        ph.cash_amt,
        ph.cheque_amt,
        ph.digital_amt,
        ph.notes as payment_notes,
        u.full_name as cashier_name,
        cs.status as session_status
      FROM bill_status bs
      LEFT JOIN release_status rs ON bs.bill_no = rs.bill_no
      LEFT JOIN payment_hint ph ON bs.bill_no = ph.bill_no
      LEFT JOIN users u ON ph.cashier_id = u.id
      LEFT JOIN cashier_session cs ON ph.cashier_id = cs.cashier_id AND cs.status = 'ACTIVE'
      WHERE bs.bill_no = $1
    `, [bill_no]);

    if (billResult.rows.length === 0) {
      return res.status(404).json({ error: 'Bill not found' });
    }

    const bill = billResult.rows[0];

    // Check if active cashier session exists
    const hasActiveSession = bill.session_status === 'ACTIVE';

    // Get consignee phone if marked for transport dispatch
    const transportInfo = await pool.query(`
      SELECT notes FROM payment_hint WHERE bill_no = $1 AND notes ILIKE '%transport%'
    `, [bill_no]);

    res.json({
      bill,
      canRelease: hasActiveSession && !['RELEASED_SELF', 'IN_TRANSIT', 'DELIVERED'].includes(bill.release_status),
      requiresApproval: bill.remaining_due > 0,
      hasActiveSession,
      isTransportDispatch: transportInfo.rows.length > 0
    });

  } catch (error) {
    console.error('Bill details error:', error);
    res.status(500).json({ error: 'Failed to fetch bill details' });
  }
});

// Request customer OTP for due release
router.post('/otp/request', authenticateToken, requireRole('DISPATCHER', 'ADMIN'), async (req, res) => {
  const { bill_no, phone } = req.body;

  if (!phone || !/^\d{10}$/.test(phone)) {
    return res.status(400).json({ error: 'Valid 10-digit phone number required' });
  }

  try {
    const result = await otpService.createOTP(bill_no, phone);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: 'Failed to send OTP' });
  }
});

// Verify customer OTP
router.post('/otp/verify', authenticateToken, requireRole('DISPATCHER', 'ADMIN'), async (req, res) => {
  const { bill_no, otp_code } = req.body;

  try {
    const result = await otpService.verifyOTP(bill_no, otp_code);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: 'Failed to verify OTP' });
  }
});

// Release to customer (self pickup)
router.post('/release/self', 
  authenticateToken, 
  requireRole('DISPATCHER', 'ADMIN'),
  validateRelease,
  validateGatepassId,
  enforceUniqueRelease,
  upload.fields([
    { name: 'signature', maxCount: 1 },
    { name: 'photo', maxCount: 1 }
  ]),
  async (req, res) => {
    const {
      bill_no,
      gatepass_id,
      receiver_name,
      receiver_phone,
      manager_pin,
      otp_verified
    } = req.body;

    try {
      let approvedBy = null;

      // Check manager PIN if required and provided
      if (req.billData.remaining_due > 0) {
        if (manager_pin) {
          // Verify manager PIN
          const managers = await pool.query(
            'SELECT id FROM users WHERE role = $1 AND active = true',
            ['MANAGER']
          );

          const bcrypt = require('bcryptjs');
          for (const manager of managers.rows) {
            const managerDetail = await pool.query(
              'SELECT pin_hash FROM users WHERE id = $1',
              [manager.id]
            );

            if (managerDetail.rows[0].pin_hash && 
                await bcrypt.compare(manager_pin, managerDetail.rows[0].pin_hash)) {
              approvedBy = manager.id;
              break;
            }
          }

          if (!approvedBy) {
            await req.dbClient.query('ROLLBACK');
            req.dbClient.release();
            return res.status(400).json({ error: 'Invalid manager PIN' });
          }
        } else if (!otp_verified) {
          await req.dbClient.query('ROLLBACK');
          req.dbClient.release();
          return res.status(400).json({ 
            error: 'Outstanding due requires manager PIN or verified OTP' 
          });
        }
      }

      // Prepare file paths
      const signaturePath = req.files?.signature?.[0]?.path;
      const photoPath = req.files?.photo?.[0]?.path;

      // Insert release record
      const result = await req.dbClient.query(`
        INSERT INTO release_self (
          bill_no, gatepass_id, approved_by_manager_id, dispatcher_id,
          receiver_name, receiver_phone, signature_path, photo_path
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING *
      `, [
        bill_no, gatepass_id, approvedBy, req.user.id,
        receiver_name, receiver_phone, signaturePath, photoPath
      ]);

      await req.dbClient.query('COMMIT');
      req.dbClient.release();

      res.json({
        release: result.rows[0],
        message: 'Bill released to customer successfully'
      });

    } catch (error) {
      if (req.dbClient) {
        await req.dbClient.query('ROLLBACK');
        req.dbClient.release();
      }
      console.error('Self release error:', error);
      res.status(500).json({ error: 'Failed to release bill' });
    }
  }
);

// Release via transporter
router.post('/release/transporter',
  authenticateToken,
  requireRole('DISPATCHER', 'ADMIN'),
  validateRelease,
  validateGatepassId,
  enforceUniqueRelease,
  async (req, res) => {
    const {
      bill_no,
      gatepass_id,
      transporter_name,
      lr_no,
      vehicle_no,
      driver_name,
      driver_phone,
      driver_id_type,
      driver_id_last4,
      pkg_count,
      gross_weight,
      net_weight,
      manager_pin,
      otp_verified
    } = req.body;

    try {
      let approvedBy = null;

      // Check manager PIN if required and provided
      if (req.billData.remaining_due > 0) {
        if (manager_pin) {
          const managers = await pool.query(
            'SELECT id FROM users WHERE role = $1 AND active = true',
            ['MANAGER']
          );

          const bcrypt = require('bcryptjs');
          for (const manager of managers.rows) {
            const managerDetail = await pool.query(
              'SELECT pin_hash FROM users WHERE id = $1',
              [manager.id]
            );

            if (managerDetail.rows[0].pin_hash && 
                await bcrypt.compare(manager_pin, managerDetail.rows[0].pin_hash)) {
              approvedBy = manager.id;
              break;
            }
          }

          if (!approvedBy) {
            await req.dbClient.query('ROLLBACK');
            req.dbClient.release();
            return res.status(400).json({ error: 'Invalid manager PIN' });
          }
        } else if (!otp_verified) {
          await req.dbClient.query('ROLLBACK');
          req.dbClient.release();
          return res.status(400).json({ 
            error: 'Outstanding due requires manager PIN or verified OTP' 
          });
        }
      }

      // Insert release record
      const result = await req.dbClient.query(`
        INSERT INTO release_transporter (
          bill_no, gatepass_id, approved_by_manager_id, dispatcher_id,
          transporter_name, lr_no, vehicle_no, driver_name, driver_phone,
          driver_id_type, driver_id_last4, pkg_count, gross_weight, net_weight
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        RETURNING *
      `, [
        bill_no, gatepass_id, approvedBy, req.user.id,
        transporter_name, lr_no, vehicle_no, driver_name, driver_phone,
        driver_id_type, driver_id_last4, pkg_count, gross_weight, net_weight
      ]);

      await req.dbClient.query('COMMIT');
      req.dbClient.release();

      res.json({
        release: result.rows[0],
        message: 'Bill released to transporter successfully'
      });

    } catch (error) {
      if (req.dbClient) {
        await req.dbClient.query('ROLLBACK');
        req.dbClient.release();
      }
      console.error('Transporter release error:', error);
      res.status(500).json({ error: 'Failed to release bill to transporter' });
    }
  }
);

// Upload POD (Proof of Delivery)
router.post('/transport/:bill_no/pod', 
  authenticateToken,
  requireRole('DISPATCHER', 'ADMIN'),
  upload.single('pod'),
  async (req, res) => {
    const { bill_no } = req.params;

    try {
      const podPath = req.file?.path;
      if (!podPath) {
        return res.status(400).json({ error: 'POD file required' });
      }

      const result = await pool.query(`
        UPDATE release_transporter 
        SET pod_uploaded = true, pod_path = $1, delivered_ts = CURRENT_TIMESTAMP
        WHERE bill_no = $2
        RETURNING *
      `, [podPath, bill_no]);

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Transport release not found' });
      }

      res.json({
        transport: result.rows[0],
        message: 'POD uploaded and delivery marked complete'
      });

    } catch (error) {
      console.error('POD upload error:', error);
      res.status(500).json({ error: 'Failed to upload POD' });
    }
  }
);

// Get transport status
router.get('/transport/status', authenticateToken, requireRole('DISPATCHER', 'ADMIN'), async (req, res) => {
  const { date = new Date().toISOString().split('T')[0] } = req.query;

  try {
    const result = await pool.query(`
      SELECT 
        rt.*,
        b.party_name,
        u.full_name as dispatcher_name,
        CASE 
          WHEN rt.delivered_ts IS NOT NULL THEN 'DELIVERED'
          WHEN rt.pod_uploaded THEN 'POD_UPLOADED'
          ELSE 'IN_TRANSIT'
        END as status
      FROM release_transporter rt
      JOIN bill b ON rt.bill_no = b.bill_no
      LEFT JOIN users u ON rt.dispatcher_id = u.id
      WHERE b.bill_date = $1
      ORDER BY rt.pickup_ts DESC
    `, [date]);

    res.json({
      date,
      transports: result.rows,
      summary: {
        total: result.rows.length,
        in_transit: result.rows.filter(row => row.status === 'IN_TRANSIT').length,
        delivered: result.rows.filter(row => row.status === 'DELIVERED').length,
        pod_uploaded: result.rows.filter(row => row.status === 'POD_UPLOADED').length
      }
    });

  } catch (error) {
    console.error('Transport status error:', error);
    res.status(500).json({ error: 'Failed to fetch transport status' });
  }
});

module.exports = router;