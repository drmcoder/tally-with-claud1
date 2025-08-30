const axios = require('axios');
const { pool } = require('../config/database');
const cron = require('node-cron');
const logger = require('./logger');

class TallyXMLETL {
  constructor() {
    this.tallyURL = `http://${process.env.TALLY_HOST || 'localhost'}:${process.env.TALLY_PORT || 9000}`;
    this.syncInterval = process.env.ETL_INTERVAL || 60000; // 60 seconds
    this.batchSize = process.env.SYNC_BATCH_SIZE || 1000;
    this.isRunning = false;
  }

  async connect() {
    try {
      const response = await axios.get(this.tallyURL, { timeout: 5000 });
      if (response.data.includes('TallyPrime Server is Running')) {
        logger.info('Connected to Tally Prime via XML API');
        return true;
      }
      return false;
    } catch (error) {
      logger.error('Failed to connect to Tally:', error);
      return false;
    }
  }

  async sendTallyRequest(xmlRequest) {
    try {
      const response = await axios.post(this.tallyURL, xmlRequest, {
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

  // Get sales vouchers (bills) from Tally
  async syncBills() {
    try {
      const xmlRequest = `<ENVELOPE>
        <HEADER>
          <VERSION>1</VERSION>
          <TALLYREQUEST>Export</TALLYREQUEST>
          <TYPE>Collection</TYPE>
          <ID>Sales Vouchers</ID>
        </HEADER>
        <BODY>
          <DESC>
            <STATICVARIABLES>
              <EXPLODEFLAG>Yes</EXPLODEFLAG>
            </STATICVARIABLES>
            <TDL>
              <TDLMESSAGE>
                <COLLECTION NAME="Sales Vouchers">
                  <TYPE>Voucher</TYPE>
                  <FETCH>$VoucherNumber, $Date, $PartyLedgerName, $Amount, $VoucherTypeName</FETCH>
                  <FILTER>SalesFilter</FILTER>
                </COLLECTION>
                <SYSTEM TYPE="Formulae" NAME="SalesFilter">$VoucherTypeName = "Sales"</SYSTEM>
              </TDLMESSAGE>
            </TDL>
          </DESC>
        </BODY>
      </ENVELOPE>`;

      const xmlResponse = await this.sendTallyRequest(xmlRequest);
      const bills = this.parseVouchersFromXML(xmlResponse);
      
      if (bills.length === 0) {
        logger.info('No new bills to sync from Tally');
        return 0;
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        
        let syncedCount = 0;
        for (const bill of bills) {
          await client.query(`
            INSERT INTO bill (bill_no, bill_date, party_name, amount, last_sync_ts)
            VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
            ON CONFLICT (bill_no) 
            DO UPDATE SET 
              bill_date = EXCLUDED.bill_date,
              party_name = EXCLUDED.party_name,
              amount = EXCLUDED.amount,
              last_sync_ts = CURRENT_TIMESTAMP
          `, [bill.bill_no, bill.bill_date, bill.party_name, bill.amount]);
          
          syncedCount++;
        }

        await client.query('COMMIT');
        logger.info(`Synced ${syncedCount} bills from Tally`);
        return syncedCount;

      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }

    } catch (error) {
      logger.error('Error syncing bills:', error);
      throw error;
    }
  }

  // Get receipt vouchers (payments) from Tally
  async syncReceipts() {
    try {
      const xmlRequest = `<ENVELOPE>
        <HEADER>
          <VERSION>1</VERSION>
          <TALLYREQUEST>Export</TALLYREQUEST>
          <TYPE>Collection</TYPE>
          <ID>Receipt Vouchers</ID>
        </HEADER>
        <BODY>
          <DESC>
            <STATICVARIABLES>
              <EXPLODEFLAG>Yes</EXPLODEFLAG>
            </STATICVARIABLES>
            <TDL>
              <TDLMESSAGE>
                <COLLECTION NAME="Receipt Vouchers">
                  <TYPE>Voucher</TYPE>
                  <FETCH>$VoucherNumber, $Date, $PartyLedgerName, $Amount, $Reference, $Narration</FETCH>
                  <FILTER>ReceiptFilter</FILTER>
                </COLLECTION>
                <SYSTEM TYPE="Formulae" NAME="ReceiptFilter">$VoucherTypeName = "Receipt"</SYSTEM>
              </TDLMESSAGE>
            </TDL>
          </DESC>
        </BODY>
      </ENVELOPE>`;

      const xmlResponse = await this.sendTallyRequest(xmlRequest);
      const receipts = this.parseReceiptsFromXML(xmlResponse);
      
      if (receipts.length === 0) {
        logger.info('No new receipts to sync from Tally');
        return 0;
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        
        let syncedCount = 0;
        for (const receipt of receipts) {
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
          `, [receipt.receipt_id, receipt.receipt_date, receipt.party_name, receipt.amount, receipt.mode, receipt.ref_text, receipt.bill_reference]);
          
          syncedCount++;
        }

        await client.query('COMMIT');
        logger.info(`Synced ${syncedCount} receipts from Tally`);
        return syncedCount;

      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }

    } catch (error) {
      logger.error('Error syncing receipts:', error);
      throw error;
    }
  }

  // Parse XML response to extract bill/voucher data
  parseVouchersFromXML(xmlData) {
    const bills = [];
    
    // Simple XML parsing - in production, you'd want to use a proper XML parser
    const voucherRegex = /<VOUCHER>(.*?)<\/VOUCHER>/gs;
    const matches = xmlData.match(voucherRegex) || [];
    
    for (const match of matches) {
      try {
        const voucherNumber = this.extractXMLValue(match, 'VOUCHERNUMBER');
        const date = this.extractXMLValue(match, 'DATE');
        const partyName = this.extractXMLValue(match, 'PARTYLEDGERNAME');
        const amount = this.extractXMLValue(match, 'AMOUNT');
        
        if (voucherNumber && date && partyName && amount) {
          bills.push({
            bill_no: voucherNumber,
            bill_date: this.formatTallyDate(date),
            party_name: partyName,
            amount: parseFloat(amount.replace(/[^\d.-]/g, '')) || 0
          });
        }
      } catch (error) {
        logger.warn('Failed to parse voucher:', error);
      }
    }
    
    return bills;
  }

  // Parse XML response to extract receipt data
  parseReceiptsFromXML(xmlData) {
    const receipts = [];
    
    const receiptRegex = /<VOUCHER>(.*?)<\/VOUCHER>/gs;
    const matches = xmlData.match(receiptRegex) || [];
    
    for (const match of matches) {
      try {
        const voucherNumber = this.extractXMLValue(match, 'VOUCHERNUMBER');
        const date = this.extractXMLValue(match, 'DATE');
        const partyName = this.extractXMLValue(match, 'PARTYLEDGERNAME');
        const amount = this.extractXMLValue(match, 'AMOUNT');
        const reference = this.extractXMLValue(match, 'REFERENCE');
        const narration = this.extractXMLValue(match, 'NARRATION');
        
        if (voucherNumber && date && partyName && amount) {
          // Determine payment mode based on narration/reference
          let mode = 'CASH';
          let billReference = null;
          
          if (narration) {
            if (narration.toLowerCase().includes('cheque') || narration.toLowerCase().includes('chq')) {
              mode = 'CHEQUE';
            } else if (narration.toLowerCase().includes('upi') || narration.toLowerCase().includes('digital') || narration.toLowerCase().includes('neft')) {
              mode = 'DIGITAL';
            }
            
            // Extract bill reference from narration
            const billMatch = narration.match(/bill[:\s]*([A-Z0-9-]+)/i);
            if (billMatch) {
              billReference = billMatch[1];
            }
          }
          
          receipts.push({
            receipt_id: voucherNumber,
            receipt_date: this.formatTallyDate(date),
            party_name: partyName,
            amount: parseFloat(amount.replace(/[^\d.-]/g, '')) || 0,
            mode: mode,
            ref_text: narration || reference || '',
            bill_reference: billReference
          });
        }
      } catch (error) {
        logger.warn('Failed to parse receipt:', error);
      }
    }
    
    return receipts;
  }

  // Extract value from XML tag
  extractXMLValue(xml, tagName) {
    const regex = new RegExp(`<${tagName}[^>]*>(.*?)<\/${tagName}>`, 'i');
    const match = xml.match(regex);
    return match ? match[1].trim() : '';
  }

  // Format Tally date to PostgreSQL format
  formatTallyDate(tallyDate) {
    // Tally date format might be YYYYMMDD or DD-MM-YYYY
    if (tallyDate.length === 8) {
      // YYYYMMDD format
      return `${tallyDate.substring(0, 4)}-${tallyDate.substring(4, 6)}-${tallyDate.substring(6, 8)}`;
    } else if (tallyDate.includes('-')) {
      // DD-MM-YYYY format
      const parts = tallyDate.split('-');
      if (parts.length === 3) {
        return `${parts[2]}-${parts[1]}-${parts[0]}`;
      }
    }
    
    // Default to current date if parsing fails
    return new Date().toISOString().split('T')[0];
  }

  // Auto-map receipts to bills using FIFO logic
  async autoMapReceipts() {
    try {
      const client = await pool.connect();
      
      // Get unmapped receipts (bill_reference is null)
      const unmappedReceipts = await client.query(`
        SELECT * FROM receipt 
        WHERE bill_reference IS NULL
        ORDER BY receipt_date, receipt_id
      `);

      let mappedCount = 0;
      
      for (const receipt of unmappedReceipts.rows) {
        // Find matching bill by party name and amount criteria
        const matchingBills = await client.query(`
          SELECT bs.bill_no, bs.remaining_due 
          FROM bill_status bs
          WHERE bs.party_name = $1 
            AND bs.remaining_due > 0 
            AND bs.remaining_due >= $2
          ORDER BY bs.bill_date
          LIMIT 1
        `, [receipt.party_name, receipt.amount]);

        if (matchingBills.rows.length > 0) {
          const bill = matchingBills.rows[0];
          
          // Update receipt with bill reference
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
      logger.error('Auto-mapping error:', error);
      return 0;
    }
  }

  // Main ETL process
  async runETL() {
    if (this.isRunning) {
      logger.warn('ETL already running, skipping this cycle');
      return;
    }

    this.isRunning = true;
    const startTime = Date.now();
    
    try {
      logger.info('Starting ETL cycle');
      
      const connected = await this.connect();
      if (!connected) {
        logger.error('Could not connect to Tally, skipping ETL cycle');
        return;
      }

      const billsCount = await this.syncBills();
      const receiptsCount = await this.syncReceipts();
      const mappedCount = await this.autoMapReceipts();
      
      const duration = Date.now() - startTime;
      logger.info(`ETL cycle completed in ${duration}ms: ${billsCount} bills, ${receiptsCount} receipts, ${mappedCount} auto-mapped`);

    } catch (error) {
      logger.error('ETL cycle failed:', error);
    } finally {
      this.isRunning = false;
    }
  }

  // Start scheduled ETL
  startScheduled() {
    // Run every minute
    cron.schedule('* * * * *', () => {
      this.runETL();
    });
    
    logger.info(`ETL scheduler started (${this.syncInterval}ms interval)`);
  }

  // Manual ETL trigger
  async runManual() {
    await this.runETL();
  }
}

// Singleton instance
const tallyXMLETL = new TallyXMLETL();

module.exports = tallyXMLETL;