const odbc = require('odbc');
const axios = require('axios');
const { pool } = require('../config/database');
const logger = require('./logger');
const cron = require('node-cron');

class TallyODBCService {
  constructor() {
    this.odbcConnection = null;
    this.xmlApiUrl = `http://${process.env.TALLY_HOST || 'localhost'}:${process.env.TALLY_PORT || 9000}`;
    this.odbcDsn = process.env.TALLY_DSN || 'DSN=TallyPrime;';
    this.syncInterval = process.env.SYNC_INTERVAL_SECONDS || 30; // 30 seconds default
    this.isRunning = false;
    this.lastSyncTime = null;
    this.connectionMethod = null; // 'odbc' or 'xml' or 'hybrid'
    
    // Connection strings to try for ODBC
    this.odbcConnectionStrings = [
      this.odbcDsn,
      'DRIVER={Tally ODBC Driver};SERVER=localhost;PORT=9000;',
      'DRIVER={Tally 9.0 ODBC Driver};SERVER=localhost;PORT=9000;',
      'DSN=TallyPrime;',
      `DRIVER={Tally ODBC Driver};SERVER=${process.env.TALLY_HOST || 'localhost'};PORT=${process.env.TALLY_PORT || 9000};`
    ];
  }

  // Test ODBC connection
  async testODBCConnection() {
    for (const connectionString of this.odbcConnectionStrings) {
      try {
        logger.info(`Testing ODBC connection: ${connectionString}`);
        const connection = await odbc.connect(connectionString);
        
        // Test a simple query
        const testResult = await connection.query("SELECT TOP 1 $Name FROM Ledger");
        
        await connection.close();
        logger.info(`ODBC connection successful with: ${connectionString}`);
        return connectionString;
      } catch (error) {
        logger.warn(`ODBC connection failed for ${connectionString}: ${error.message}`);
      }
    }
    return null;
  }

  // Test XML API connection
  async testXMLConnection() {
    try {
      const response = await axios.get(this.xmlApiUrl, { timeout: 5000 });
      
      // Test with a simple XML request
      const testXML = `<ENVELOPE>
        <HEADER>
          <VERSION>1</VERSION>
          <TALLYREQUEST>Export</TALLYREQUEST>
          <TYPE>Collection</TYPE>
          <ID>Test</ID>
        </HEADER>
        <BODY>
          <DESC>
            <TDL>
              <TDLMESSAGE>
                <COLLECTION NAME="Test">
                  <TYPE>Ledger</TYPE>
                  <FETCH>$Name</FETCH>
                  <MAXRECORDS>1</MAXRECORDS>
                </COLLECTION>
              </TDLMESSAGE>
            </TDL>
          </DESC>
        </BODY>
      </ENVELOPE>`;

      const xmlResponse = await axios.post(this.xmlApiUrl, testXML, {
        headers: { 'Content-Type': 'application/xml' },
        timeout: 10000
      });

      if (xmlResponse.data && xmlResponse.data.includes('<')) {
        logger.info('XML API connection successful');
        return true;
      }
      return false;
    } catch (error) {
      logger.warn(`XML API connection failed: ${error.message}`);
      return false;
    }
  }

  // Initialize connection
  async initialize() {
    logger.info('Initializing Tally connection...');
    
    // Test both connection methods
    const odbcConnectionString = await this.testODBCConnection();
    const xmlConnectionAvailable = await this.testXMLConnection();
    
    if (odbcConnectionString) {
      this.odbcDsn = odbcConnectionString;
      this.connectionMethod = xmlConnectionAvailable ? 'hybrid' : 'odbc';
    } else if (xmlConnectionAvailable) {
      this.connectionMethod = 'xml';
    } else {
      throw new Error('No Tally connection method available. Please check Tally Prime configuration.');
    }
    
    logger.info(`Tally connection initialized using: ${this.connectionMethod}`);
    return this.connectionMethod;
  }

  // Get ODBC connection
  async getODBCConnection() {
    if (this.connectionMethod === 'xml') {
      throw new Error('ODBC not available, using XML API only');
    }
    
    try {
      if (!this.odbcConnection) {
        this.odbcConnection = await odbc.connect(this.odbcDsn);
      }
      return this.odbcConnection;
    } catch (error) {
      logger.error('Failed to get ODBC connection:', error);
      this.odbcConnection = null;
      throw error;
    }
  }

  // Send XML request to Tally
  async sendXMLRequest(xmlRequest) {
    if (this.connectionMethod === 'odbc') {
      throw new Error('XML API not available, using ODBC only');
    }
    
    try {
      const response = await axios.post(this.xmlApiUrl, xmlRequest, {
        headers: {
          'Content-Type': 'application/xml',
          'Accept': 'application/xml'
        },
        timeout: 30000
      });
      return response.data;
    } catch (error) {
      logger.error('Tally XML request failed:', error);
      throw error;
    }
  }

  // Sync bills/vouchers from Tally using ODBC
  async syncBillsODBC() {
    try {
      const connection = await this.getODBCConnection();
      
      // Query sales vouchers using ODBC
      const query = `
        SELECT TOP 1000 
          $VoucherNumber as bill_no,
          $Date as bill_date, 
          $PartyLedgerName as party_name,
          $Amount as amount,
          $VoucherTypeName as voucher_type
        FROM Voucher 
        WHERE $VoucherTypeName = 'Sales'
        ORDER BY $Date DESC
      `;
      
      const results = await connection.query(query);
      
      if (results.length === 0) {
        logger.info('No new bills found via ODBC');
        return 0;
      }
      
      // Insert/update bills in PostgreSQL
      const client = await pool.connect();
      let syncedCount = 0;
      
      try {
        await client.query('BEGIN');
        
        for (const bill of results) {
          await client.query(`
            INSERT INTO bill (bill_no, bill_date, party_name, amount, last_sync_ts)
            VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
            ON CONFLICT (bill_no) 
            DO UPDATE SET 
              bill_date = EXCLUDED.bill_date,
              party_name = EXCLUDED.party_name,
              amount = EXCLUDED.amount,
              last_sync_ts = CURRENT_TIMESTAMP
          `, [
            bill.bill_no,
            this.formatTallyDate(bill.bill_date),
            bill.party_name,
            parseFloat(bill.amount) || 0
          ]);
          syncedCount++;
        }
        
        await client.query('COMMIT');
        logger.info(`Synced ${syncedCount} bills via ODBC`);
        return syncedCount;
        
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
      
    } catch (error) {
      logger.error('ODBC bills sync failed:', error);
      throw error;
    }
  }

  // Sync receipts from Tally using ODBC
  async syncReceiptsODBC() {
    try {
      const connection = await this.getODBCConnection();
      
      const query = `
        SELECT TOP 1000
          $VoucherNumber as receipt_id,
          $Date as receipt_date,
          $PartyLedgerName as party_name,
          $Amount as amount,
          $Reference as reference,
          $Narration as narration,
          $VoucherTypeName as voucher_type
        FROM Voucher 
        WHERE $VoucherTypeName = 'Receipt'
        ORDER BY $Date DESC
      `;
      
      const results = await connection.query(query);
      
      if (results.length === 0) {
        logger.info('No new receipts found via ODBC');
        return 0;
      }
      
      const client = await pool.connect();
      let syncedCount = 0;
      
      try {
        await client.query('BEGIN');
        
        for (const receipt of results) {
          // Determine payment mode from narration/reference
          let mode = 'CASH';
          let billReference = null;
          
          const narration = receipt.narration || '';
          if (narration.toLowerCase().includes('cheque') || narration.toLowerCase().includes('chq')) {
            mode = 'CHEQUE';
          } else if (narration.toLowerCase().includes('upi') || narration.toLowerCase().includes('digital')) {
            mode = 'DIGITAL';
          }
          
          // Extract bill reference
          const billMatch = narration.match(/bill[:\s]*([A-Z0-9-]+)/i);
          if (billMatch) {
            billReference = billMatch[1];
          }
          
          await client.query(`
            INSERT INTO receipt (receipt_id, receipt_date, party_name, amount, mode, ref_text, bill_reference, last_sync_ts)
            VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP)
            ON CONFLICT (receipt_id) 
            DO UPDATE SET 
              receipt_date = EXCLUDED.receipt_date,
              party_name = EXCLUDED.party_name,
              amount = EXCLUDED.amount,
              mode = EXCLUDED.mode,
              ref_text = EXCLUDED.ref_text,
              bill_reference = EXCLUDED.bill_reference,
              last_sync_ts = CURRENT_TIMESTAMP
          `, [
            receipt.receipt_id,
            this.formatTallyDate(receipt.receipt_date),
            receipt.party_name,
            parseFloat(receipt.amount) || 0,
            mode,
            narration,
            billReference
          ]);
          syncedCount++;
        }
        
        await client.query('COMMIT');
        logger.info(`Synced ${syncedCount} receipts via ODBC`);
        return syncedCount;
        
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
      
    } catch (error) {
      logger.error('ODBC receipts sync failed:', error);
      throw error;
    }
  }

  // Sync party ledgers from Tally
  async syncLedgers() {
    try {
      let results = [];
      
      if (this.connectionMethod === 'odbc' || this.connectionMethod === 'hybrid') {
        // Use ODBC method
        const connection = await this.getODBCConnection();
        results = await connection.query(`
          SELECT TOP 1000
            $Name as ledger_name,
            $Parent as parent_group,
            $OpeningBalance as opening_balance,
            $ClosingBalance as closing_balance
          FROM Ledger 
          WHERE $Parent LIKE '%Sundry Debtors%' OR $Parent LIKE '%Sundry Creditors%'
          ORDER BY $Name
        `);
      } else {
        // Use XML API method
        const xmlRequest = `<ENVELOPE>
          <HEADER>
            <VERSION>1</VERSION>
            <TALLYREQUEST>Export</TALLYREQUEST>
            <TYPE>Collection</TYPE>
            <ID>Ledger List</ID>
          </HEADER>
          <BODY>
            <DESC>
              <STATICVARIABLES>
                <EXPLODEFLAG>Yes</EXPLODEFLAG>
              </STATICVARIABLES>
              <TDL>
                <TDLMESSAGE>
                  <COLLECTION NAME="Ledger List">
                    <TYPE>Ledger</TYPE>
                    <FETCH>$Name, $Parent, $OpeningBalance, $ClosingBalance</FETCH>
                    <FILTER>PartyFilter</FILTER>
                  </COLLECTION>
                  <SYSTEM TYPE="Formulae" NAME="PartyFilter">
                    $$StringContains:$Parent:"Sundry Debtors" OR $$StringContains:$Parent:"Sundry Creditors"
                  </SYSTEM>
                </TDLMESSAGE>
              </TDL>
            </DESC>
          </BODY>
        </ENVELOPE>`;
        
        const xmlResponse = await this.sendXMLRequest(xmlRequest);
        results = this.parseLedgersFromXML(xmlResponse);
      }
      
      if (results.length === 0) {
        logger.info('No ledgers found');
        return 0;
      }
      
      // Store ledgers in a temporary table or use for party validation
      logger.info(`Found ${results.length} party ledgers`);
      return results.length;
      
    } catch (error) {
      logger.error('Ledger sync failed:', error);
      return 0;
    }
  }

  // Parse ledgers from XML response
  parseLedgersFromXML(xmlData) {
    const ledgers = [];
    const ledgerRegex = /<LEDGER>(.*?)<\/LEDGER>/gs;
    const matches = xmlData.match(ledgerRegex) || [];
    
    for (const match of matches) {
      try {
        const name = this.extractXMLValue(match, 'NAME');
        const parent = this.extractXMLValue(match, 'PARENT');
        const openingBalance = this.extractXMLValue(match, 'OPENINGBALANCE');
        const closingBalance = this.extractXMLValue(match, 'CLOSINGBALANCE');
        
        if (name && parent) {
          ledgers.push({
            ledger_name: name,
            parent_group: parent,
            opening_balance: parseFloat(openingBalance) || 0,
            closing_balance: parseFloat(closingBalance) || 0
          });
        }
      } catch (error) {
        logger.warn('Failed to parse ledger:', error);
      }
    }
    
    return ledgers;
  }

  // Extract XML value helper
  extractXMLValue(xml, tagName) {
    const regex = new RegExp(`<${tagName}[^>]*>(.*?)<\/${tagName}>`, 'i');
    const match = xml.match(regex);
    return match ? match[1].trim() : '';
  }

  // Format Tally date
  formatTallyDate(tallyDate) {
    if (!tallyDate) return new Date().toISOString().split('T')[0];
    
    // Handle different Tally date formats
    if (tallyDate.length === 8) {
      // YYYYMMDD
      return `${tallyDate.substring(0, 4)}-${tallyDate.substring(4, 6)}-${tallyDate.substring(6, 8)}`;
    } else if (tallyDate.includes('-')) {
      // DD-MM-YYYY or similar
      const parts = tallyDate.split('-');
      if (parts.length === 3) {
        const day = parts[0].padStart(2, '0');
        const month = parts[1].padStart(2, '0');
        const year = parts[2];
        return `${year}-${month}-${day}`;
      }
    }
    
    return new Date().toISOString().split('T')[0];
  }

  // Auto-map receipts to bills
  async autoMapReceipts() {
    try {
      const client = await pool.connect();
      
      const unmappedReceipts = await client.query(`
        SELECT * FROM receipt 
        WHERE bill_reference IS NULL OR bill_reference = ''
        ORDER BY receipt_date, receipt_id
      `);

      let mappedCount = 0;
      
      for (const receipt of unmappedReceipts.rows) {
        // Find matching bills for this party
        const matchingBills = await client.query(`
          SELECT bs.bill_no, bs.remaining_due, bs.bill_date
          FROM bill_status bs
          WHERE bs.party_name = $1 
            AND bs.remaining_due > 0 
            AND bs.remaining_due >= $2
          ORDER BY bs.bill_date
          LIMIT 1
        `, [receipt.party_name, receipt.amount]);

        if (matchingBills.rows.length > 0) {
          const bill = matchingBills.rows[0];
          
          await client.query(`
            UPDATE receipt 
            SET bill_reference = $1 
            WHERE receipt_id = $2
          `, [bill.bill_no, receipt.receipt_id]);
          
          mappedCount++;
          logger.info(`Auto-mapped receipt ${receipt.receipt_id} to bill ${bill.bill_no}`);
        }
      }
      
      client.release();
      return mappedCount;
      
    } catch (error) {
      logger.error('Auto-mapping failed:', error);
      return 0;
    }
  }

  // Main sync process
  async runSync() {
    if (this.isRunning) {
      logger.warn('Sync already running, skipping this cycle');
      return;
    }

    this.isRunning = true;
    const startTime = Date.now();
    
    try {
      logger.info(`Starting Tally sync (method: ${this.connectionMethod})`);
      
      let billsCount = 0;
      let receiptsCount = 0;
      let ledgersCount = 0;
      
      // Sync based on available connection method
      if (this.connectionMethod === 'odbc' || this.connectionMethod === 'hybrid') {
        billsCount = await this.syncBillsODBC();
        receiptsCount = await this.syncReceiptsODBC();
        ledgersCount = await this.syncLedgers();
      } else {
        // Fallback to existing XML ETL service
        const xmlETL = require('./tally-xml-etl');
        billsCount = await xmlETL.syncBills();
        receiptsCount = await xmlETL.syncReceipts();
      }
      
      // Auto-map receipts to bills
      const mappedCount = await this.autoMapReceipts();
      
      const duration = Date.now() - startTime;
      this.lastSyncTime = new Date();
      
      logger.info(`Sync completed in ${duration}ms: ${billsCount} bills, ${receiptsCount} receipts, ${ledgersCount} ledgers, ${mappedCount} auto-mapped`);

    } catch (error) {
      logger.error('Sync failed:', error);
    } finally {
      this.isRunning = false;
    }
  }

  // Start real-time sync scheduler
  startRealTimeSync() {
    // Run sync every configured seconds
    const cronPattern = `*/${this.syncInterval} * * * * *`;
    
    cron.schedule(cronPattern, () => {
      this.runSync();
    });
    
    // Also run an initial sync
    setTimeout(() => this.runSync(), 2000);
    
    logger.info(`Real-time sync started (every ${this.syncInterval} seconds)`);
  }

  // Stop sync
  stopSync() {
    // Close ODBC connection if open
    if (this.odbcConnection) {
      this.odbcConnection.close();
      this.odbcConnection = null;
    }
    
    logger.info('Tally sync stopped');
  }

  // Get sync status
  getSyncStatus() {
    return {
      connectionMethod: this.connectionMethod,
      isRunning: this.isRunning,
      lastSyncTime: this.lastSyncTime,
      syncInterval: this.syncInterval,
      odbcDsn: this.odbcDsn,
      xmlApiUrl: this.xmlApiUrl
    };
  }

  // Manual sync trigger
  async triggerManualSync() {
    logger.info('Manual sync triggered');
    await this.runSync();
  }
}

// Singleton instance
const tallyODBCService = new TallyODBCService();

module.exports = tallyODBCService;