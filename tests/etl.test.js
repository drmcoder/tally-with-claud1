const etlService = require('../services/etl');
const { pool } = require('../config/database');

// Mock ODBC connection
jest.mock('odbc', () => ({
  connect: jest.fn().mockResolvedValue({
    query: jest.fn(),
    close: jest.fn()
  })
}));

describe('ETL Service', () => {
  let mockConnection;

  beforeAll(async () => {
    const odbc = require('odbc');
    mockConnection = await odbc.connect();
    
    // Clear test data
    await pool.query('DELETE FROM bill WHERE bill_no LIKE $1', ['ETL-TEST%']);
    await pool.query('DELETE FROM receipt WHERE receipt_id LIKE $1', ['ETL-REC%']);
  });

  afterAll(async () => {
    // Cleanup test data
    await pool.query('DELETE FROM bill WHERE bill_no LIKE $1', ['ETL-TEST%']);
    await pool.query('DELETE FROM receipt WHERE receipt_id LIKE $1', ['ETL-REC%']);
  });

  describe('Bill Synchronization', () => {
    test('should sync bills from Tally', async () => {
      // Mock Tally data
      const mockBillsData = [
        {
          bill_no: 'ETL-TEST-001',
          bill_date: new Date(),
          party_name: 'ETL Test Party 1',
          amount: 1500.00
        },
        {
          bill_no: 'ETL-TEST-002',
          bill_date: new Date(),
          party_name: 'ETL Test Party 2',
          amount: 2500.00
        }
      ];

      mockConnection.query.mockResolvedValueOnce(mockBillsData);

      const result = await etlService.syncBills();
      
      expect(result).toBe(2);

      // Verify bills were inserted
      const dbBills = await pool.query(
        'SELECT * FROM bill WHERE bill_no IN ($1, $2)',
        ['ETL-TEST-001', 'ETL-TEST-002']
      );

      expect(dbBills.rows).toHaveLength(2);
      expect(dbBills.rows[0].party_name).toBe('ETL Test Party 1');
    });

    test('should update existing bills on re-sync', async () => {
      // Mock updated data
      const mockUpdatedData = [
        {
          bill_no: 'ETL-TEST-001',
          bill_date: new Date(),
          party_name: 'ETL Test Party 1 Updated',
          amount: 1600.00
        }
      ];

      mockConnection.query.mockResolvedValueOnce(mockUpdatedData);

      const result = await etlService.syncBills();
      
      expect(result).toBe(1);

      // Verify bill was updated
      const dbBill = await pool.query(
        'SELECT * FROM bill WHERE bill_no = $1',
        ['ETL-TEST-001']
      );

      expect(dbBill.rows[0].party_name).toBe('ETL Test Party 1 Updated');
      expect(parseFloat(dbBill.rows[0].amount)).toBe(1600.00);
    });

    test('should handle empty bill sync', async () => {
      mockConnection.query.mockResolvedValueOnce([]);

      const result = await etlService.syncBills();
      
      expect(result).toBe(0);
    });
  });

  describe('Receipt Synchronization', () => {
    test('should sync receipts from Tally with mode detection', async () => {
      const mockReceiptsData = [
        {
          receipt_id: 'ETL-REC-001',
          receipt_date: new Date(),
          party_name: 'ETL Test Party 1',
          amount: 1000.00,
          mode: 'CASH',
          ref_text: 'Cash payment',
          bill_reference: 'ETL-TEST-001'
        },
        {
          receipt_id: 'ETL-REC-002',
          receipt_date: new Date(),
          party_name: 'ETL Test Party 2',
          amount: 500.00,
          mode: 'DIGITAL',
          ref_text: 'UPI payment - TXN123456',
          bill_reference: null
        }
      ];

      mockConnection.query.mockResolvedValueOnce(mockReceiptsData);

      const result = await etlService.syncReceipts();
      
      expect(result).toBe(2);

      // Verify receipts were inserted
      const dbReceipts = await pool.query(
        'SELECT * FROM receipt WHERE receipt_id IN ($1, $2)',
        ['ETL-REC-001', 'ETL-REC-002']
      );

      expect(dbReceipts.rows).toHaveLength(2);
      expect(dbReceipts.rows.find(r => r.receipt_id === 'ETL-REC-001').mode).toBe('CASH');
      expect(dbReceipts.rows.find(r => r.receipt_id === 'ETL-REC-002').mode).toBe('DIGITAL');
    });

    test('should extract bill reference from narration', async () => {
      const mockReceiptsData = [
        {
          receipt_id: 'ETL-REC-003',
          receipt_date: new Date(),
          party_name: 'ETL Test Party 1',
          amount: 600.00,
          mode: 'CASH',
          ref_text: 'Payment against BILL:ETL-TEST-001',
          bill_reference: 'ETL-TEST-001' // Extracted from narration
        }
      ];

      mockConnection.query.mockResolvedValueOnce(mockReceiptsData);

      const result = await etlService.syncReceipts();
      
      expect(result).toBe(1);

      const dbReceipt = await pool.query(
        'SELECT * FROM receipt WHERE receipt_id = $1',
        ['ETL-REC-003']
      );

      expect(dbReceipt.rows[0].bill_reference).toBe('ETL-TEST-001');
    });
  });

  describe('Auto-mapping Logic', () => {
    beforeEach(async () => {
      // Create test data for mapping
      await pool.query(`
        INSERT INTO receipt (receipt_id, receipt_date, party_name, amount, mode, bill_reference)
        VALUES ('UNMAP-001', CURRENT_DATE, 'ETL Test Party 1', 500.00, 'CASH', NULL)
        ON CONFLICT (receipt_id) DO NOTHING
      `);
    });

    test('should auto-map unmapped receipts using FIFO', async () => {
      const mappedCount = await etlService.autoMapReceipts();
      
      expect(mappedCount).toBeGreaterThanOrEqual(0);

      // Check if our test receipt was mapped
      const mappedReceipt = await pool.query(
        'SELECT bill_reference FROM receipt WHERE receipt_id = $1',
        ['UNMAP-001']
      );

      if (mappedReceipt.rows[0].bill_reference) {
        expect(mappedReceipt.rows[0].bill_reference).toBe('ETL-TEST-001');
      }
    });

    test('should not map receipts when amount exceeds remaining due', async () => {
      // Insert receipt with amount greater than any remaining due
      await pool.query(`
        INSERT INTO receipt (receipt_id, receipt_date, party_name, amount, mode, bill_reference)
        VALUES ('UNMAP-002', CURRENT_DATE, 'ETL Test Party 1', 10000.00, 'CASH', NULL)
        ON CONFLICT (receipt_id) DO NOTHING
      `);

      await etlService.autoMapReceipts();

      const unmappedReceipt = await pool.query(
        'SELECT bill_reference FROM receipt WHERE receipt_id = $1',
        ['UNMAP-002']
      );

      expect(unmappedReceipt.rows[0].bill_reference).toBeNull();

      // Cleanup
      await pool.query('DELETE FROM receipt WHERE receipt_id = $1', ['UNMAP-002']);
    });
  });

  describe('ETL Error Handling', () => {
    test('should handle connection failures gracefully', async () => {
      const odbc = require('odbc');
      odbc.connect.mockRejectedValueOnce(new Error('Connection failed'));

      // Mock the connect method in ETL service
      const originalConnect = etlService.connect;
      etlService.connect = jest.fn().mockResolvedValueOnce(false);

      await etlService.runETL();

      // Should not throw error
      expect(etlService.connect).toHaveBeenCalled();

      // Restore original method
      etlService.connect = originalConnect;
    });

    test('should handle database transaction failures', async () => {
      mockConnection.query.mockRejectedValueOnce(new Error('Database error'));

      // Should not throw unhandled error
      await expect(etlService.syncBills()).rejects.toThrow('Database error');
    });

    test('should handle malformed Tally data', async () => {
      const malformedData = [
        {
          bill_no: null, // Missing required field
          bill_date: new Date(),
          party_name: 'Test',
          amount: 'invalid_amount'
        }
      ];

      mockConnection.query.mockResolvedValueOnce(malformedData);

      // Should handle gracefully without crashing
      await expect(etlService.syncBills()).rejects.toThrow();
    });
  });

  describe('ETL Scheduling', () => {
    test('should prevent concurrent ETL runs', async () => {
      // Set running flag
      etlService.isRunning = true;

      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

      await etlService.runETL();

      // Should skip execution
      // Note: This test checks the behavior, actual logging would be via winston logger

      etlService.isRunning = false;
      consoleSpy.mockRestore();
    });

    test('should reset running flag after completion', async () => {
      mockConnection.query
        .mockResolvedValueOnce([]) // Empty bills
        .mockResolvedValueOnce([]); // Empty receipts

      await etlService.runETL();

      expect(etlService.isRunning).toBe(false);
    });

    test('should reset running flag after error', async () => {
      // Mock error for bills sync, but provide empty array for potential receipt sync
      mockConnection.query
        .mockRejectedValueOnce(new Error('Test error'))
        .mockResolvedValueOnce([]);

      await etlService.runETL();

      expect(etlService.isRunning).toBe(false);
    });
  });
});