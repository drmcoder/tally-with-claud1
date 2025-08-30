const express = require('express');
const router = express.Router();
const tallyODBCService = require('../services/tally-odbc');
const logger = require('../services/logger');
const { pool } = require('../config/database');

// Initialize Tally connection and get status
router.get('/status', async (req, res) => {
  try {
    const status = tallyODBCService.getSyncStatus();
    
    // Get last sync statistics from database
    const client = await pool.connect();
    const lastSyncStats = await client.query(`
      SELECT 
        (SELECT COUNT(*) FROM bill WHERE last_sync_ts > CURRENT_TIMESTAMP - INTERVAL '1 hour') as bills_synced_hour,
        (SELECT COUNT(*) FROM receipt WHERE last_sync_ts > CURRENT_TIMESTAMP - INTERVAL '1 hour') as receipts_synced_hour,
        (SELECT COUNT(*) FROM bill) as total_bills,
        (SELECT COUNT(*) FROM receipt) as total_receipts,
        (SELECT COUNT(*) FROM receipt WHERE bill_reference IS NOT NULL) as mapped_receipts
    `);
    client.release();
    
    const stats = lastSyncStats.rows[0];
    
    res.json({
      ...status,
      statistics: {
        bills_synced_last_hour: parseInt(stats.bills_synced_hour),
        receipts_synced_last_hour: parseInt(stats.receipts_synced_hour),
        total_bills: parseInt(stats.total_bills),
        total_receipts: parseInt(stats.total_receipts),
        mapped_receipts: parseInt(stats.mapped_receipts),
        unmapped_receipts: parseInt(stats.total_receipts) - parseInt(stats.mapped_receipts)
      }
    });
  } catch (error) {
    logger.error('Error getting sync status:', error);
    res.status(500).json({ error: 'Failed to get sync status' });
  }
});

// Initialize Tally connection
router.post('/initialize', async (req, res) => {
  try {
    const connectionMethod = await tallyODBCService.initialize();
    res.json({ 
      success: true, 
      connectionMethod,
      message: `Tally connection initialized using ${connectionMethod}` 
    });
  } catch (error) {
    logger.error('Error initializing Tally connection:', error);
    res.status(500).json({ 
      error: 'Failed to initialize Tally connection',
      message: error.message 
    });
  }
});

// Start real-time sync
router.post('/start', async (req, res) => {
  try {
    // Initialize if not already done
    if (!tallyODBCService.connectionMethod) {
      await tallyODBCService.initialize();
    }
    
    tallyODBCService.startRealTimeSync();
    res.json({ 
      success: true, 
      message: 'Real-time sync started',
      syncInterval: tallyODBCService.syncInterval 
    });
  } catch (error) {
    logger.error('Error starting real-time sync:', error);
    res.status(500).json({ 
      error: 'Failed to start sync',
      message: error.message 
    });
  }
});

// Stop sync
router.post('/stop', (req, res) => {
  try {
    tallyODBCService.stopSync();
    res.json({ success: true, message: 'Sync stopped' });
  } catch (error) {
    logger.error('Error stopping sync:', error);
    res.status(500).json({ error: 'Failed to stop sync' });
  }
});

// Trigger manual sync
router.post('/trigger', async (req, res) => {
  try {
    // Initialize if not already done
    if (!tallyODBCService.connectionMethod) {
      await tallyODBCService.initialize();
    }
    
    // Run sync asynchronously
    tallyODBCService.triggerManualSync().catch(error => {
      logger.error('Manual sync error:', error);
    });
    
    res.json({ 
      success: true, 
      message: 'Manual sync triggered' 
    });
  } catch (error) {
    logger.error('Error triggering manual sync:', error);
    res.status(500).json({ 
      error: 'Failed to trigger sync',
      message: error.message 
    });
  }
});

// Test Tally connections
router.get('/test-connections', async (req, res) => {
  try {
    const results = {
      odbc: { available: false, error: null },
      xml: { available: false, error: null }
    };
    
    // Test ODBC
    try {
      const odbcConnectionString = await tallyODBCService.testODBCConnection();
      results.odbc.available = !!odbcConnectionString;
      results.odbc.connectionString = odbcConnectionString;
    } catch (error) {
      results.odbc.error = error.message;
    }
    
    // Test XML API
    try {
      results.xml.available = await tallyODBCService.testXMLConnection();
    } catch (error) {
      results.xml.error = error.message;
    }
    
    res.json(results);
  } catch (error) {
    logger.error('Error testing connections:', error);
    res.status(500).json({ error: 'Failed to test connections' });
  }
});

// Get sync history/logs
router.get('/logs', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const client = await pool.connect();
    
    // Get recent sync activity from bills and receipts
    const recentActivity = await client.query(`
      SELECT 
        'bill' as type,
        bill_no as id,
        party_name,
        amount,
        last_sync_ts as sync_time
      FROM bill 
      WHERE last_sync_ts IS NOT NULL
      
      UNION ALL
      
      SELECT 
        'receipt' as type,
        receipt_id as id,
        party_name,
        amount,
        last_sync_ts as sync_time
      FROM receipt 
      WHERE last_sync_ts IS NOT NULL
      
      ORDER BY sync_time DESC
      LIMIT $1
    `, [limit]);
    
    client.release();
    
    res.json({
      recentActivity: recentActivity.rows,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Error getting sync logs:', error);
    res.status(500).json({ error: 'Failed to get sync logs' });
  }
});

// Get unmatched receipts for manual mapping
router.get('/unmatched-receipts', async (req, res) => {
  try {
    const client = await pool.connect();
    
    const unmatchedReceipts = await client.query(`
      SELECT 
        r.*,
        COALESCE(
          (SELECT COUNT(*) 
           FROM bill_status bs 
           WHERE bs.party_name = r.party_name 
             AND bs.remaining_due > 0
          ), 0
        ) as potential_matches
      FROM receipt r
      WHERE r.bill_reference IS NULL OR r.bill_reference = ''
      ORDER BY r.receipt_date DESC, r.party_name
    `);
    
    client.release();
    
    res.json(unmatchedReceipts.rows);
  } catch (error) {
    logger.error('Error getting unmatched receipts:', error);
    res.status(500).json({ error: 'Failed to get unmatched receipts' });
  }
});

// Manual receipt mapping
router.post('/map-receipt', async (req, res) => {
  try {
    const { receiptId, billNo } = req.body;
    
    if (!receiptId || !billNo) {
      return res.status(400).json({ error: 'Receipt ID and Bill No are required' });
    }
    
    const client = await pool.connect();
    
    // Verify bill exists
    const billCheck = await client.query('SELECT bill_no FROM bill WHERE bill_no = $1', [billNo]);
    if (billCheck.rows.length === 0) {
      client.release();
      return res.status(404).json({ error: 'Bill not found' });
    }
    
    // Update receipt
    const result = await client.query(`
      UPDATE receipt 
      SET bill_reference = $1 
      WHERE receipt_id = $2
      RETURNING *
    `, [billNo, receiptId]);
    
    client.release();
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Receipt not found' });
    }
    
    logger.info(`Manual mapping: Receipt ${receiptId} mapped to Bill ${billNo}`);
    res.json({ 
      success: true, 
      message: 'Receipt mapped successfully',
      receipt: result.rows[0]
    });
  } catch (error) {
    logger.error('Error mapping receipt:', error);
    res.status(500).json({ error: 'Failed to map receipt' });
  }
});

// Auto-map receipts
router.post('/auto-map', async (req, res) => {
  try {
    const mappedCount = await tallyODBCService.autoMapReceipts();
    res.json({ 
      success: true, 
      message: `${mappedCount} receipts auto-mapped`,
      mappedCount 
    });
  } catch (error) {
    logger.error('Error auto-mapping receipts:', error);
    res.status(500).json({ error: 'Failed to auto-map receipts' });
  }
});

module.exports = router;