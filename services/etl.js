const odbc = require('odbc');
const { pool } = require('../config/database');
const cron = require('node-cron');
const logger = require('./logger');

class TallyETL {
  constructor() {
    this.connectionString = process.env.TALLY_DSN || 'DSN=TallyPrime';
    this.syncInterval = process.env.ETL_INTERVAL || 60000; // 60 seconds
    this.batchSize = process.env.SYNC_BATCH_SIZE || 1000;
    this.isRunning = false;
  }

  async connect() {
    try {
      this.connection = await odbc.connect(this.connectionString);
      logger.info('Connected to Tally Prime via ODBC');
      return true;
    } catch (error) {
      logger.error('Failed to connect to Tally:', error);
      return false;
    }
  }

  async disconnect() {
    if (this.connection) {
      await this.connection.close();
      logger.info('Disconnected from Tally Prime');
    }
  }

  // Pull bills from Tally (Pending Sales Bill voucher type)
  async syncBills() {
    try {
      const query = `
        SELECT 
          $BILLNUMBER as bill_no,
          $DATE as bill_date,
          $PARTYNAME as party_name,
          $AMOUNT as amount
        FROM VOUCHER 
        WHERE $VOUCHERTYPE = 'Sales' 
          AND $ISBILLWISEOFF = 'No'
          AND $DATE >= (CURRENT_DATE - INTERVAL '30 days')
        ORDER BY $DATE DESC
      `;

      const result = await this.connection.query(query);
      
      if (result.length === 0) {
        logger.info('No new bills to sync');
        return 0;
      }

      // Upsert bills into staging then clean DB
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        
        let syncedCount = 0;
        for (const row of result) {
          await client.query(`
            INSERT INTO bill (bill_no, bill_date, party_name, amount, last_sync_ts)
            VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
            ON CONFLICT (bill_no) 
            DO UPDATE SET 
              bill_date = EXCLUDED.bill_date,
              party_name = EXCLUDED.party_name,
              amount = EXCLUDED.amount,
              last_sync_ts = CURRENT_TIMESTAMP
          `, [row.bill_no, row.bill_date, row.party_name, row.amount]);
          
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

  // Pull receipts from Tally
  async syncReceipts() {
    try {
      const query = `
        SELECT 
          $BILLNUMBER as receipt_id,
          $DATE as receipt_date,
          $PARTYNAME as party_name,
          $AMOUNT as amount,
          CASE 
            WHEN $BANKALLOCATIONS > 0 THEN 'CHEQUE'
            WHEN UPPER($NARRATION) LIKE '%UPI%' OR UPPER($NARRATION) LIKE '%DIGITAL%' THEN 'DIGITAL'
            ELSE 'CASH'
          END as mode,
          $NARRATION as ref_text,
          CASE 
            WHEN $NARRATION LIKE '%BILL:%' THEN 
              TRIM(SUBSTRING($NARRATION FROM POSITION('BILL:' IN $NARRATION) + 5))
            ELSE NULL
          END as bill_reference
        FROM VOUCHER 
        WHERE $VOUCHERTYPE = 'Receipt'
          AND $DATE >= (CURRENT_DATE - INTERVAL '30 days')
        ORDER BY $DATE DESC
      `;

      const result = await this.connection.query(query);
      
      if (result.length === 0) {
        logger.info('No new receipts to sync');
        return 0;
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        
        let syncedCount = 0;
        for (const row of result) {
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
          `, [row.receipt_id, row.receipt_date, row.party_name, row.amount, row.mode, row.ref_text, row.bill_reference]);
          
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

  // Auto-map receipts to bills using FIFO logic
  async autoMapReceipts() {
    try {
      const client = await pool.connect();
      
      // Get unmapped receipts (bill_reference is null)
      const unmappedReceipts = await client.query(`
        SELECT * FROM receipt 
        WHERE bill_reference IS NULL
        ORDER BY party_name, receipt_date
      `);

      if (unmappedReceipts.rows.length === 0) {
        return 0;
      }

      let mappedCount = 0;
      
      for (const receipt of unmappedReceipts.rows) {
        // Find oldest unpaid/partially paid bill for this party
        const candidateBill = await client.query(`
          SELECT bs.bill_no, bs.remaining_due
          FROM bill_status bs
          WHERE bs.party_name = $1 
            AND bs.remaining_due > 0
            AND bs.bill_date <= $2
          ORDER BY bs.bill_date ASC
          LIMIT 1
        `, [receipt.party_name, receipt.receipt_date]);

        if (candidateBill.rows.length > 0 && candidateBill.rows[0].remaining_due >= receipt.amount) {
          // Map receipt to bill
          await client.query(`
            UPDATE receipt 
            SET bill_reference = $1 
            WHERE receipt_id = $2
          `, [candidateBill.rows[0].bill_no, receipt.receipt_id]);
          
          mappedCount++;
          logger.info(`Auto-mapped receipt ${receipt.receipt_id} to bill ${candidateBill.rows[0].bill_no}`);
        }
      }

      client.release();
      return mappedCount;

    } catch (error) {
      logger.error('Error auto-mapping receipts:', error);
      throw error;
    }
  }

  // Run full ETL cycle
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
      await this.disconnect();
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
const etlService = new TallyETL();

module.exports = etlService;

// If running as standalone script
if (require.main === module) {
  console.log('Running manual ETL...');
  etlService.runManual().then(() => {
    console.log('Manual ETL completed');
    process.exit(0);
  }).catch((error) => {
    console.error('Manual ETL failed:', error);
    process.exit(1);
  });
}