// server.js - Complete Backend for Tally Dashboard
const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const cors = require('cors');
const bodyParser = require('body-parser');
const { Pool } = require('pg');
const axios = require('axios');
const xml2js = require('xml2js');
const cron = require('node-cron');
const path = require('path');

// Initialize Express App
const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Database Connection
const db = new Pool({
    user: 'postgres',
    host: 'localhost',
    database: 'tally_dashboard',
    password: 'admin123',  // Your PostgreSQL password
    port: 5432,
});

// Test database connection
db.connect((err, client, release) => {
    if (err) {
        console.error('Database connection error:', err.stack);
    } else {
        console.log('✅ Connected to PostgreSQL database');
        release();
    }
});

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));

// Tally Configuration
const TALLY_URL = 'http://localhost:9000';
const COMPANY_NAME = 'Ome 82 to More';

// Helper Functions
function getCurrentDate() {
    const date = new Date();
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}${month}${day}`;
}

function formatDate(dateStr) {
    // Convert YYYYMMDD to YYYY-MM-DD
    if (dateStr && dateStr.length === 8) {
        return `${dateStr.substr(0,4)}-${dateStr.substr(4,2)}-${dateStr.substr(6,2)}`;
    }
    return dateStr;
}

// Fetch Bills from Tally
async function fetchBillsFromTally() {
    const xmlRequest = `<ENVELOPE>
        <HEADER>
            <TALLYREQUEST>Export Data</TALLYREQUEST>
            <TYPE>Collection</TYPE>
            <ID>Daybook</ID>
        </HEADER>
        <BODY>
            <DESC>
                <STATICVARIABLES>
                    <SVCURRENTCOMPANY>${COMPANY_NAME}</SVCURRENTCOMPANY>
                    <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
                    <SVFROMDATE>${getCurrentDate()}</SVFROMDATE>
                    <SVTODATE>${getCurrentDate()}</SVTODATE>
                </STATICVARIABLES>
            </DESC>
        </BODY>
    </ENVELOPE>`;

    try {
        const response = await axios.post(TALLY_URL, xmlRequest, {
            headers: {
                'Content-Type': 'text/xml; charset=utf-8'
            },
            timeout: 10000
        });

        const parser = new xml2js.Parser({ 
            explicitArray: false,
            ignoreAttrs: true 
        });
        
        const result = await parser.parseStringPromise(response.data);
        
        // Parse and return bills
        if (result && result.ENVELOPE && result.ENVELOPE.BODY) {
            const vouchers = result.ENVELOPE.BODY.TALLYMESSAGE?.VOUCHER;
            
            if (Array.isArray(vouchers)) {
                return vouchers.map(v => ({
                    voucherNumber: v.VOUCHERNUMBER || '',
                    date: formatDate(v.DATE || ''),
                    partyName: v.PARTYLEDGERNAME || '',
                    amount: parseFloat(v.AMOUNT || 0),
                    narration: v.NARRATION || ''
                }));
            } else if (vouchers) {
                return [{
                    voucherNumber: vouchers.VOUCHERNUMBER || '',
                    date: formatDate(vouchers.DATE || ''),
                    partyName: vouchers.PARTYLEDGERNAME || '',
                    amount: parseFloat(vouchers.AMOUNT || 0),
                    narration: vouchers.NARRATION || ''
                }];
            }
        }
        
        return [];
    } catch (error) {
        console.error('Error fetching from Tally:', error.message);
        return [];
    }
}

// Save Bills to Database
async function saveBillsToDatabase(bills) {
    for (const bill of bills) {
        try {
            await db.query(`
                INSERT INTO bills (voucher_number, voucher_date, party_name, amount)
                VALUES ($1, $2, $3, $4)
                ON CONFLICT (voucher_number) 
                DO UPDATE SET 
                    amount = $4,
                    updated_at = CURRENT_TIMESTAMP
            `, [bill.voucherNumber, bill.date, bill.partyName, bill.amount]);
        } catch (error) {
            console.error('Error saving bill:', error.message);
        }
    }
}

// API Routes

// Get all bills
app.get('/api/bills', async (req, res) => {
    try {
        const result = await db.query(`
            SELECT * FROM bills 
            ORDER BY voucher_date DESC, created_at DESC
        `);
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get pending bills
app.get('/api/bills/pending', async (req, res) => {
    try {
        const result = await db.query(`
            SELECT * FROM bills 
            WHERE payment_status = 'pending'
            ORDER BY voucher_date DESC
        `);
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Update payment status
app.post('/api/bills/:voucherNumber/payment', async (req, res) => {
    const { voucherNumber } = req.params;
    const { status, amount, cashierId } = req.body;
    
    try {
        await db.query(`
            UPDATE bills 
            SET payment_status = $1, 
                payment_amount = $2,
                cashier_id = $3,
                updated_at = CURRENT_TIMESTAMP
            WHERE voucher_number = $4
        `, [status, amount, cashierId, voucherNumber]);
        
        // Create receipt in Tally
        if (status === 'paid') {
            await createTallyReceipt(voucherNumber, amount);
        }
        
        // Emit update to all connected clients
        io.emit('payment_updated', { voucherNumber, status, amount });
        
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Update dispatch status
app.post('/api/bills/:voucherNumber/dispatch', async (req, res) => {
    const { voucherNumber } = req.params;
    const { status, gatePassNo } = req.body;
    
    try {
        await db.query(`
            UPDATE bills 
            SET dispatch_status = $1,
                gate_pass_no = $2,
                updated_at = CURRENT_TIMESTAMP
            WHERE voucher_number = $3
        `, [status, gatePassNo, voucherNumber]);
        
        io.emit('dispatch_updated', { voucherNumber, status });
        
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get columnar daybook
app.get('/api/daybook', async (req, res) => {
    const { date } = req.query;
    
    try {
        const query = `
            SELECT 
                party_name,
                SUM(CASE WHEN payment_status = 'pending' THEN amount ELSE 0 END) as debit,
                SUM(CASE WHEN payment_status = 'paid' THEN payment_amount ELSE 0 END) as credit,
                SUM(CASE WHEN payment_status = 'pending' THEN amount ELSE 0 END) - 
                SUM(CASE WHEN payment_status = 'paid' THEN payment_amount ELSE 0 END) as balance
            FROM bills
            WHERE voucher_date = $1
            GROUP BY party_name
            ORDER BY party_name
        `;
        
        const result = await db.query(query, [date || getCurrentDate()]);
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Bag tracking
app.post('/api/bags/track', async (req, res) => {
    const { customerName, ourBags, otherVendorBags } = req.body;
    
    try {
        const totalSacks = Math.floor((ourBags + otherVendorBags) / 5);
        const remaining = (ourBags + otherVendorBags) % 5;
        
        await db.query(`
            INSERT INTO bag_tracking 
            (customer_name, our_bags, other_vendor_bags, total_sacks, tracking_date)
            VALUES ($1, $2, $3, $4, CURRENT_DATE)
        `, [customerName, ourBags, otherVendorBags, totalSacks]);
        
        res.json({
            success: true,
            totalSacks,
            remaining,
            message: `Customer can make ${totalSacks} sacks. ${remaining} bags remaining.`
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Manual sync trigger
app.post('/api/sync', async (req, res) => {
    try {
        const bills = await fetchBillsFromTally();
        await saveBillsToDatabase(bills);
        io.emit('sync_complete', { billCount: bills.length });
        res.json({ success: true, billssynced: bills.length });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Create Receipt in Tally
async function createTallyReceipt(billNo, amount) {
    const xmlRequest = `<ENVELOPE>
        <HEADER>
            <TALLYREQUEST>Import Data</TALLYREQUEST>
        </HEADER>
        <BODY>
            <IMPORTDATA>
                <REQUESTDESC>
                    <REPORTNAME>Vouchers</REPORTNAME>
                </REQUESTDESC>
                <REQUESTDATA>
                    <TALLYMESSAGE xmlns:UDF="TallyUDF">
                        <VOUCHER ACTION="Create">
                            <VOUCHERTYPENAME>Dashboard Receipt</VOUCHERTYPENAME>
                            <DATE>${getCurrentDate()}</DATE>
                            <NARRATION>Dashboard Payment for Bill ${billNo}</NARRATION>
                            <ALLLEDGERENTRIES.LIST>
                                <LEDGERNAME>Cash</LEDGERNAME>
                                <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
                                <AMOUNT>${amount}</AMOUNT>
                            </ALLLEDGERENTRIES.LIST>
                        </VOUCHER>
                    </TALLYMESSAGE>
                </REQUESTDATA>
            </IMPORTDATA>
        </BODY>
    </ENVELOPE>`;
    
    try {
        await axios.post(TALLY_URL, xmlRequest, {
            headers: { 'Content-Type': 'text/xml' }
        });
        console.log(`Receipt created in Tally for ${billNo}`);
    } catch (error) {
        console.error('Error creating Tally receipt:', error.message);
    }
}

// WebSocket Connection
io.on('connection', (socket) => {
    console.log('✅ Client connected:', socket.id);
    
    socket.on('disconnect', () => {
        console.log('❌ Client disconnected:', socket.id);
    });
    
    socket.on('request_sync', async () => {
        const bills = await fetchBillsFromTally();
        await saveBillsToDatabase(bills);
        socket.emit('sync_complete', bills);
    });
});

// Auto-sync every 5 seconds
cron.schedule('*/5 * * * * *', async () => {
    console.log('🔄 Auto-syncing with Tally...');
    const bills = await fetchBillsFromTally();
    
    if (bills.length > 0) {
        await saveBillsToDatabase(bills);
        io.emit('bills_updated', bills);
    }
});

// Start Server
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
    console.log(`
╔════════════════════════════════════════════╗
║   Tally Dashboard Server Started!          ║
║   Running on: http://localhost:${PORT}        ║
║   Company: ${COMPANY_NAME}                 ║
║   Tally URL: ${TALLY_URL}                  ║
╚════════════════════════════════════════════╝
    `);
});