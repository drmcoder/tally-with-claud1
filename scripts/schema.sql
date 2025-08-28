-- Tally Dashboard Database Schema
-- PostgreSQL DDL for complete system

-- Create database (run separately)
-- CREATE DATABASE tally_dashboard;

-- Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- Users and roles
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    username VARCHAR(50) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    full_name VARCHAR(100) NOT NULL,
    role VARCHAR(20) NOT NULL CHECK (role IN ('CASHIER', 'DISPATCHER', 'SECURITY', 'ADMIN', 'MANAGER')),
    pin_hash VARCHAR(255), -- For manager PIN approvals
    active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Core tables pulled from Tally via ODBC
CREATE TABLE bill (
    bill_no VARCHAR(50) PRIMARY KEY,
    bill_date DATE NOT NULL,
    party_name VARCHAR(200) NOT NULL,
    amount DECIMAL(15,2) NOT NULL,
    last_sync_ts TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_bill_party_date ON bill(party_name, bill_date);
CREATE INDEX idx_bill_date ON bill(bill_date);

CREATE TABLE receipt (
    receipt_id VARCHAR(50) PRIMARY KEY,
    receipt_date DATE NOT NULL,
    party_name VARCHAR(200) NOT NULL,
    amount DECIMAL(15,2) NOT NULL,
    mode VARCHAR(20) NOT NULL CHECK (mode IN ('CASH', 'CHEQUE', 'DIGITAL')),
    ref_text TEXT,
    bill_reference VARCHAR(50), -- Optional bill reference from Tally narration
    last_sync_ts TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_receipt_party_date ON receipt(party_name, receipt_date);
CREATE INDEX idx_receipt_bill_ref ON receipt(bill_reference);

-- Payment hints (computed from cashier forms)
CREATE TABLE payment_hint (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
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
);

-- Cashier session management
CREATE TABLE cashier_session (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
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
);

CREATE INDEX idx_session_cashier_date ON cashier_session(cashier_id, start_ts);

-- Petty cash tracking
CREATE TABLE petty_cash (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    session_id UUID REFERENCES cashier_session(id),
    amount DECIMAL(15,2) NOT NULL,
    purpose VARCHAR(200) NOT NULL,
    vendor VARCHAR(100),
    photo_path VARCHAR(500),
    approved_by UUID REFERENCES users(id),
    approved_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Till adjustments
CREATE TABLE till_adjustment (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    session_id UUID REFERENCES cashier_session(id),
    type VARCHAR(20) NOT NULL CHECK (type IN ('ADD_TO_TILL', 'REMOVE_FROM_TILL')),
    amount DECIMAL(15,2) NOT NULL,
    reason VARCHAR(200) NOT NULL,
    approved_by UUID REFERENCES users(id),
    approved_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Release to customer
CREATE TABLE release_self (
    release_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
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
);

-- Release via transporter
CREATE TABLE release_transporter (
    release_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
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
);

-- Gate log
CREATE TABLE gate_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    bill_no VARCHAR(50) REFERENCES bill(bill_no),
    gatepass_id VARCHAR(50) NOT NULL,
    vehicle_no VARCHAR(20),
    gate_ts TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    security_id UUID REFERENCES users(id) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_gate_log_date ON gate_log(gate_ts);

-- Cheque register
CREATE TABLE cheque_register (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    bill_no VARCHAR(50) REFERENCES bill(bill_no),
    cheque_no VARCHAR(50) NOT NULL,
    bank VARCHAR(100) NOT NULL,
    amount DECIMAL(15,2) NOT NULL,
    status VARCHAR(20) DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'DEPOSITED', 'CLEARED', 'BOUNCED')),
    deposit_batch_id UUID,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Deposit batches
CREATE TABLE deposit_batch (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    bank_name VARCHAR(100) NOT NULL,
    deposit_date DATE NOT NULL,
    total_cash DECIMAL(15,2) DEFAULT 0,
    total_cheque DECIMAL(15,2) DEFAULT 0,
    prepared_by UUID REFERENCES users(id),
    approved_by UUID REFERENCES users(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Add foreign key for cheque_register
ALTER TABLE cheque_register ADD CONSTRAINT fk_deposit_batch 
    FOREIGN KEY (deposit_batch_id) REFERENCES deposit_batch(id);

-- Digital payment references
CREATE TABLE digital_payment_ref (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    bill_no VARCHAR(50) REFERENCES bill(bill_no),
    method VARCHAR(20) NOT NULL CHECK (method IN ('UPI', 'CARD', 'NEFT', 'RTGS')),
    reference_no VARCHAR(100) NOT NULL,
    amount DECIMAL(15,2) NOT NULL,
    status VARCHAR(20) DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'MATCHED', 'UNMATCHED')),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- EOD sheets
CREATE TABLE eod_sheet (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    business_date DATE NOT NULL UNIQUE,
    prepared_by UUID REFERENCES users(id),
    approved_by UUID REFERENCES users(id),
    approved_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE eod_sheet_line (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    eod_id UUID REFERENCES eod_sheet(id),
    section VARCHAR(50) NOT NULL,
    line_json JSONB NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- OTP tracking for customer releases
CREATE TABLE customer_otp (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    bill_no VARCHAR(50) REFERENCES bill(bill_no),
    phone VARCHAR(20) NOT NULL,
    otp_code VARCHAR(6) NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    verified BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Audit log
CREATE TABLE audit_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    table_name VARCHAR(50) NOT NULL,
    record_id VARCHAR(100) NOT NULL,
    action VARCHAR(10) NOT NULL CHECK (action IN ('INSERT', 'UPDATE', 'DELETE')),
    old_values JSONB,
    new_values JSONB,
    user_id UUID REFERENCES users(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create views for common queries

-- Bill status view (PAID, PART-PAID, DUE)
CREATE VIEW bill_status AS
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
        COALESCE(bill_reference, 'UNMAPPED') as bill_no,
        SUM(amount) as receipt_total
    FROM receipt 
    WHERE bill_reference IS NOT NULL
    GROUP BY bill_reference
) r ON b.bill_no = r.bill_no;

-- Release status view
CREATE VIEW release_status AS
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
LEFT JOIN release_transporter rt ON b.bill_no = rt.bill_no;

-- Indexes for performance
CREATE INDEX idx_payment_hint_bill ON payment_hint(bill_no);
CREATE INDEX idx_receipt_date ON receipt(receipt_date);
CREATE INDEX idx_cheque_status ON cheque_register(status);
CREATE INDEX idx_digital_ref_status ON digital_payment_ref(status);

-- Functions for business logic

-- Function to get active cashier session
CREATE OR REPLACE FUNCTION get_active_session(user_id UUID)
RETURNS UUID AS $$
DECLARE
    session_id UUID;
BEGIN
    SELECT id INTO session_id 
    FROM cashier_session 
    WHERE cashier_id = user_id AND status = 'ACTIVE'
    ORDER BY start_ts DESC
    LIMIT 1;
    
    RETURN session_id;
END;
$$ LANGUAGE plpgsql;

-- Function to calculate expected cash
CREATE OR REPLACE FUNCTION calculate_expected_cash(session_id UUID)
RETURNS DECIMAL AS $$
DECLARE
    expected DECIMAL := 0;
    start_float DECIMAL := 0;
    cash_in DECIMAL := 0;
    petty_out DECIMAL := 0;
    adjustments DECIMAL := 0;
BEGIN
    -- Get start float
    SELECT cs.start_float INTO start_float
    FROM cashier_session cs WHERE cs.id = session_id;
    
    -- Get cash payments
    SELECT COALESCE(SUM(ph.cash_amt), 0) INTO cash_in
    FROM payment_hint ph
    JOIN cashier_session cs ON ph.cashier_id = cs.cashier_id
    WHERE cs.id = session_id 
    AND ph.created_at BETWEEN cs.start_ts AND COALESCE(cs.end_ts, CURRENT_TIMESTAMP);
    
    -- Get petty cash
    SELECT COALESCE(SUM(amount), 0) INTO petty_out
    FROM petty_cash WHERE session_id = session_id;
    
    -- Get till adjustments
    SELECT COALESCE(SUM(CASE 
        WHEN type = 'ADD_TO_TILL' THEN amount 
        ELSE -amount 
    END), 0) INTO adjustments
    FROM till_adjustment WHERE session_id = session_id;
    
    expected := start_float + cash_in - petty_out + adjustments;
    
    RETURN expected;
END;
$$ LANGUAGE plpgsql;

-- Triggers for audit logging
CREATE OR REPLACE FUNCTION audit_trigger()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        INSERT INTO audit_log(table_name, record_id, action, old_values)
        VALUES (TG_TABLE_NAME, OLD.id::text, 'DELETE', to_jsonb(OLD));
        RETURN OLD;
    ELSIF TG_OP = 'UPDATE' THEN
        INSERT INTO audit_log(table_name, record_id, action, old_values, new_values)
        VALUES (TG_TABLE_NAME, NEW.id::text, 'UPDATE', to_jsonb(OLD), to_jsonb(NEW));
        RETURN NEW;
    ELSIF TG_OP = 'INSERT' THEN
        INSERT INTO audit_log(table_name, record_id, action, new_values)
        VALUES (TG_TABLE_NAME, NEW.id::text, 'INSERT', to_jsonb(NEW));
        RETURN NEW;
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Create triggers for key tables
CREATE TRIGGER audit_payment_hint AFTER INSERT OR UPDATE OR DELETE ON payment_hint
    FOR EACH ROW EXECUTE FUNCTION audit_trigger();

CREATE TRIGGER audit_release_self AFTER INSERT OR UPDATE OR DELETE ON release_self
    FOR EACH ROW EXECUTE FUNCTION audit_trigger();

CREATE TRIGGER audit_release_transporter AFTER INSERT OR UPDATE OR DELETE ON release_transporter
    FOR EACH ROW EXECUTE FUNCTION audit_trigger();

-- Insert default admin user (password: admin123)
INSERT INTO users (username, password_hash, full_name, role, pin_hash) VALUES 
('admin', '$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQJqhN8/LewdBPj/pQ8wnb7PO', 'System Administrator', 'ADMIN', '$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQJqhN8/LewdBPj/pQ8wnb7PO');

COMMENT ON DATABASE tally_dashboard IS 'Tally Prime integration dashboard for cashier, dispatch and admin operations';