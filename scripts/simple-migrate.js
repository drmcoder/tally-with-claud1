const { pool } = require('../config/database');

async function createTables() {
  const client = await pool.connect();
  
  try {
    console.log('Creating tables...');

    // Extensions
    await client.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);

    // Users table
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        username VARCHAR(50) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        full_name VARCHAR(100) NOT NULL,
        role VARCHAR(20) NOT NULL CHECK (role IN ('CASHIER', 'DISPATCHER', 'SECURITY', 'ADMIN', 'MANAGER')),
        pin_hash VARCHAR(255),
        active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Bills table
    await client.query(`
      CREATE TABLE IF NOT EXISTS bill (
        bill_no VARCHAR(50) PRIMARY KEY,
        bill_date DATE NOT NULL,
        party_name VARCHAR(200) NOT NULL,
        amount DECIMAL(15,2) NOT NULL,
        last_sync_ts TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Receipts table
    await client.query(`
      CREATE TABLE IF NOT EXISTS receipt (
        receipt_id VARCHAR(50) PRIMARY KEY,
        receipt_date DATE NOT NULL,
        party_name VARCHAR(200) NOT NULL,
        amount DECIMAL(15,2) NOT NULL,
        mode VARCHAR(20) NOT NULL CHECK (mode IN ('CASH', 'CHEQUE', 'DIGITAL')),
        ref_text TEXT,
        bill_reference VARCHAR(50),
        last_sync_ts TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Cashier sessions
    await client.query(`
      CREATE TABLE IF NOT EXISTS cashier_session (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        cashier_id UUID REFERENCES users(id),
        start_ts TIMESTAMP NOT NULL,
        end_ts TIMESTAMP,
        start_float DECIMAL(15,2) NOT NULL,
        counted_cash DECIMAL(15,2),
        expected_cash DECIMAL(15,2),
        variance DECIMAL(15,2),
        opened_by UUID REFERENCES users(id),
        closed_by UUID REFERENCES users(id),
        status VARCHAR(20) DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'CLOSED', 'APPROVED')),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Payment hints
    await client.query(`
      CREATE TABLE IF NOT EXISTS payment_hint (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        bill_no VARCHAR(50) REFERENCES bill(bill_no),
        cash_amt DECIMAL(15,2) DEFAULT 0,
        cheque_amt DECIMAL(15,2) DEFAULT 0,
        cheque_no VARCHAR(50),
        bank VARCHAR(100),
        digital_amt DECIMAL(15,2) DEFAULT 0,
        digital_ref VARCHAR(100),
        remaining_due DECIMAL(15,2) DEFAULT 0,
        cashier_id UUID REFERENCES users(id),
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Releases
    await client.query(`
      CREATE TABLE IF NOT EXISTS release_self (
        release_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        bill_no VARCHAR(50) UNIQUE REFERENCES bill(bill_no),
        gatepass_id VARCHAR(50) NOT NULL,
        approved_by_manager_id UUID REFERENCES users(id),
        dispatcher_id UUID REFERENCES users(id) NOT NULL,
        receiver_name VARCHAR(100) NOT NULL,
        receiver_phone VARCHAR(20),
        signature_path VARCHAR(500),
        photo_path VARCHAR(500),
        released_ts TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS release_transporter (
        release_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        bill_no VARCHAR(50) UNIQUE REFERENCES bill(bill_no),
        gatepass_id VARCHAR(50) NOT NULL,
        approved_by_manager_id UUID REFERENCES users(id),
        dispatcher_id UUID REFERENCES users(id) NOT NULL,
        transporter_name VARCHAR(100) NOT NULL,
        lr_no VARCHAR(50) NOT NULL,
        vehicle_no VARCHAR(20) NOT NULL,
        driver_name VARCHAR(100) NOT NULL,
        driver_phone VARCHAR(20) NOT NULL,
        driver_id_type VARCHAR(20) CHECK (driver_id_type IN ('AADHAR', 'PAN', 'LICENSE')),
        driver_id_last4 VARCHAR(4),
        pkg_count INTEGER NOT NULL,
        gross_weight DECIMAL(10,2),
        net_weight DECIMAL(10,2),
        pickup_ts TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        pod_uploaded BOOLEAN DEFAULT FALSE,
        pod_path VARCHAR(500),
        delivered_ts TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Gate log
    await client.query(`
      CREATE TABLE IF NOT EXISTS gate_log (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        bill_no VARCHAR(50) REFERENCES bill(bill_no),
        gatepass_id VARCHAR(50) NOT NULL,
        vehicle_no VARCHAR(20),
        gate_ts TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        security_id UUID REFERENCES users(id) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Other supporting tables
    await client.query(`
      CREATE TABLE IF NOT EXISTS customer_otp (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        bill_no VARCHAR(50) REFERENCES bill(bill_no),
        phone VARCHAR(20) NOT NULL,
        otp_code VARCHAR(6) NOT NULL,
        expires_at TIMESTAMP NOT NULL,
        verified BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create bill status view
    await client.query(`
      CREATE OR REPLACE VIEW bill_status AS
      SELECT 
        b.bill_no,
        b.bill_date,
        b.party_name,
        b.amount AS bill_amount,
        COALESCE(r.receipt_total, 0) AS receipt_total,
        (b.amount - COALESCE(r.receipt_total, 0)) AS remaining_due,
        CASE 
          WHEN COALESCE(r.receipt_total, 0) = 0 THEN 'DUE'
          WHEN COALESCE(r.receipt_total, 0) >= b.amount THEN 'PAID'
          ELSE 'PART-PAID'
        END AS status
      FROM bill b
      LEFT JOIN (
        SELECT 
          bill_reference as bill_no,
          SUM(amount) as receipt_total
        FROM receipt 
        WHERE bill_reference IS NOT NULL
        GROUP BY bill_reference
      ) r ON b.bill_no = r.bill_no
    `);

    // Create release status view
    await client.query(`
      CREATE OR REPLACE VIEW release_status AS
      SELECT 
        b.bill_no,
        CASE 
          WHEN rs.release_id IS NOT NULL THEN 'RELEASED_SELF'
          WHEN rt.release_id IS NOT NULL AND rt.delivered_ts IS NOT NULL THEN 'DELIVERED'
          WHEN rt.release_id IS NOT NULL THEN 'IN_TRANSIT'
          ELSE 'READY'
        END AS release_status,
        COALESCE(rs.released_ts, rt.pickup_ts) AS release_ts,
        COALESCE(rs.dispatcher_id, rt.dispatcher_id) AS dispatcher_id
      FROM bill b
      LEFT JOIN release_self rs ON b.bill_no = rs.bill_no
      LEFT JOIN release_transporter rt ON b.bill_no = rt.bill_no
    `);

    // Insert default admin user (password: admin123)
    await client.query(`
      INSERT INTO users (username, password_hash, full_name, role, pin_hash) 
      VALUES ('admin', '$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQJqhN8/LewdBPj/pQ8wnb7PO', 'System Administrator', 'ADMIN', '$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQJqhN8/LewdBPj/pQ8wnb7PO')
      ON CONFLICT (username) DO NOTHING
    `);

    console.log('✅ All tables created successfully!');
    console.log('✅ Default admin user created (admin/admin123)');

  } catch (error) {
    console.error('Migration error:', error);
    throw error;
  } finally {
    client.release();
  }
}

if (require.main === module) {
  createTables().then(() => {
    console.log('Database setup complete!');
    process.exit(0);
  }).catch((error) => {
    console.error('Setup failed:', error);
    process.exit(1);
  });
}

module.exports = { createTables };