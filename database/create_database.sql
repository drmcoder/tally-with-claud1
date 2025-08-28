-- Create Database
CREATE DATABASE tally_dashboard;

-- Connect to database
\c tally_dashboard;

-- Create tables
CREATE TABLE bills (
    id SERIAL PRIMARY KEY,
    voucher_number VARCHAR(50) UNIQUE NOT NULL,
    voucher_date DATE NOT NULL,
    party_name VARCHAR(200),
    party_gstin VARCHAR(20),
    amount DECIMAL(15,2),
    payment_status VARCHAR(20) DEFAULT 'pending',
    payment_amount DECIMAL(15,2) DEFAULT 0,
    dispatch_status VARCHAR(20) DEFAULT 'pending',
    gate_pass_no VARCHAR(50),
    created_by VARCHAR(100),
    cashier_id VARCHAR(100),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE receipts (
    id SERIAL PRIMARY KEY,
    receipt_number VARCHAR(50) UNIQUE,
    bill_reference VARCHAR(50),
    party_name VARCHAR(200),
    amount DECIMAL(15,2),
    receipt_date DATE,
    payment_mode VARCHAR(50),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE dispatch_tracking (
    id SERIAL PRIMARY KEY,
    bill_id INTEGER REFERENCES bills(id),
    status VARCHAR(50),
    ready_time TIMESTAMP,
    dispatch_time TIMESTAMP,
    customer_taken_time TIMESTAMP,
    notes TEXT
);

CREATE TABLE bag_tracking (
    id SERIAL PRIMARY KEY,
    customer_name VARCHAR(200),
    our_bags INTEGER DEFAULT 0,
    other_vendor_bags INTEGER DEFAULT 0,
    total_sacks INTEGER DEFAULT 0,
    tracking_date DATE,
    notes TEXT
);

CREATE TABLE columnar_daybook (
    id SERIAL PRIMARY KEY,
    date DATE,
    party_name VARCHAR(200),
    voucher_type VARCHAR(50),
    voucher_number VARCHAR(50),
    debit_amount DECIMAL(15,2) DEFAULT 0,
    credit_amount DECIMAL(15,2) DEFAULT 0,
    balance DECIMAL(15,2) DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for performance
CREATE INDEX idx_bills_date ON bills(voucher_date);
CREATE INDEX idx_bills_party ON bills(party_name);
CREATE INDEX idx_bills_status ON bills(payment_status);

-- Grant permissions
GRANT ALL PRIVILEGES ON DATABASE tally_dashboard TO postgres;