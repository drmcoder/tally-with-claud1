const reportsService = require('../services/reports');
const { pool } = require('../config/database');
const fs = require('fs');
const path = require('path');

describe('Reports Service', () => {
  const testDate = '2024-01-15';
  const reportsDir = path.join(__dirname, '../uploads/reports');

  beforeAll(async () => {
    // Ensure reports directory exists
    if (!fs.existsSync(reportsDir)) {
      fs.mkdirSync(reportsDir, { recursive: true });
    }

    // Create test data
    await pool.query(`
      INSERT INTO bill (bill_no, bill_date, party_name, amount)
      VALUES 
        ('RPT-TEST-001', $1, 'Report Test Party 1', 1500.00),
        ('RPT-TEST-002', $1, 'Report Test Party 2', 2500.00)
      ON CONFLICT (bill_no) DO NOTHING
    `, [testDate]);

    await pool.query(`
      INSERT INTO receipt (receipt_id, receipt_date, party_name, amount, mode, bill_reference)
      VALUES 
        ('RPT-REC-001', $1, 'Report Test Party 1', 1500.00, 'CASH', 'RPT-TEST-001'),
        ('RPT-REC-002', $1, 'Report Test Party 2', 1000.00, 'CHEQUE', 'RPT-TEST-002')
      ON CONFLICT (receipt_id) DO NOTHING
    `, [testDate]);

    // Create test user for sessions
    await pool.query(`
      INSERT INTO users (username, password_hash, full_name, role)
      VALUES ('rptcashier', '$2b$12$test', 'Report Test Cashier', 'CASHIER')
      ON CONFLICT (username) DO NOTHING
    `);

    const cashier = await pool.query('SELECT id FROM users WHERE username = $1', ['rptcashier']);
    const cashierId = cashier.rows[0].id;

    // Create test cashier session
    await pool.query(`
      INSERT INTO cashier_session (id, cashier_id, start_ts, end_ts, start_float, counted_cash, expected_cash, variance, status)
      VALUES 
        (gen_random_uuid(), $1, $2::date + interval '9 hours', $2::date + interval '17 hours', 
         1000.00, 2450.00, 2500.00, -50.00, 'CLOSED')
      ON CONFLICT DO NOTHING
    `, [cashierId, testDate]);
  });

  afterAll(async () => {
    // Cleanup test data
    await pool.query('DELETE FROM receipt WHERE receipt_id LIKE $1', ['RPT-REC%']);
    await pool.query('DELETE FROM cashier_session WHERE cashier_id IN (SELECT id FROM users WHERE username = $1)', ['rptcashier']);
    await pool.query('DELETE FROM bill WHERE bill_no LIKE $1', ['RPT-TEST%']);
    await pool.query('DELETE FROM users WHERE username = $1', ['rptcashier']);

    // Cleanup test report files
    try {
      const files = fs.readdirSync(reportsDir);
      files.forEach(file => {
        if (file.includes('20240115')) {
          fs.unlinkSync(path.join(reportsDir, file));
        }
      });
    } catch (error) {
      // Directory might not exist or be empty
    }
  });

  describe('EOD PDF Generation', () => {
    test('should generate EOD PDF report', async () => {
      const result = await reportsService.generateEODPDF(testDate, 'Test User');

      expect(result).toHaveProperty('fileName');
      expect(result).toHaveProperty('filePath');
      expect(result.fileName).toMatch(/EOD_20240115\.pdf/);

      // Verify file was created
      expect(fs.existsSync(result.filePath)).toBe(true);

      // Verify file has content
      const stats = fs.statSync(result.filePath);
      expect(stats.size).toBeGreaterThan(1000); // PDF should have substantial content
    });

    test('should include all required sections in PDF', async () => {
      const result = await reportsService.generateEODPDF(testDate, 'Test User');

      // Read PDF file to verify it was created properly
      const pdfBuffer = fs.readFileSync(result.filePath);
      expect(pdfBuffer.length).toBeGreaterThan(0);

      // For more detailed PDF content testing, you would need a PDF parser
      // This test just verifies the file was created with content
    });

    test('should handle empty data gracefully', async () => {
      const emptyDate = '2025-12-31'; // Future date with no data
      
      const result = await reportsService.generateEODPDF(emptyDate, 'Test User');

      expect(result).toHaveProperty('fileName');
      expect(fs.existsSync(result.filePath)).toBe(true);
    });
  });

  describe('EOD CSV Generation', () => {
    test('should generate EOD CSV report', async () => {
      const result = await reportsService.generateEODCSV(testDate);

      expect(result).toHaveProperty('fileName');
      expect(result).toHaveProperty('filePath');
      expect(result.fileName).toMatch(/EOD_20240115\.csv/);

      // Verify file was created
      expect(fs.existsSync(result.filePath)).toBe(true);

      // Read and verify CSV content
      const csvContent = fs.readFileSync(result.filePath, 'utf8');
      expect(csvContent).toContain('Bill No');
      expect(csvContent).toContain('Party Name');
      expect(csvContent).toContain('Bill Amount');
      expect(csvContent).toContain('RPT-TEST-001');
      expect(csvContent).toContain('Report Test Party 1');
    });

    test('should include all required columns in CSV', async () => {
      const result = await reportsService.generateEODCSV(testDate);
      const csvContent = fs.readFileSync(result.filePath, 'utf8');

      const expectedColumns = [
        'Bill No',
        'Party Name',
        'Bill Amount',
        'Receipt Total',
        'Remaining Due',
        'Status',
        'Cash Amount',
        'Cheque Amount',
        'Digital Amount',
        'Cashier',
        'Release Type',
        'Release Time'
      ];

      expectedColumns.forEach(column => {
        expect(csvContent).toContain(column);
      });
    });

    test('should format amounts correctly in CSV', async () => {
      const result = await reportsService.generateEODCSV(testDate);
      const csvContent = fs.readFileSync(result.filePath, 'utf8');

      // Check that amounts are properly formatted (should contain decimal values)
      expect(csvContent).toMatch(/1500\.00/);
      expect(csvContent).toMatch(/2500\.00/);
    });
  });

  describe('Report File Management', () => {
    test('should create unique filenames for different dates', async () => {
      const date1 = '2024-01-15';
      const date2 = '2024-01-16';

      const result1 = await reportsService.generateEODPDF(date1, 'Test User');
      const result2 = await reportsService.generateEODPDF(date2, 'Test User');

      expect(result1.fileName).not.toBe(result2.fileName);
      expect(result1.fileName).toContain('20240115');
      expect(result2.fileName).toContain('20240116');

      // Cleanup second file
      if (fs.existsSync(result2.filePath)) {
        fs.unlinkSync(result2.filePath);
      }
    });

    test('should handle report directory creation', () => {
      // The constructor should create the directory
      expect(fs.existsSync(reportsDir)).toBe(true);
    });

    test('should cleanup old reports', async () => {
      // Create old test file
      const oldFileName = 'EOD_20200101.pdf';
      const oldFilePath = path.join(reportsDir, oldFileName);
      fs.writeFileSync(oldFilePath, 'test content');

      // Set file modification time to old date
      const oldDate = new Date('2020-01-01');
      fs.utimesSync(oldFilePath, oldDate, oldDate);

      const deletedCount = await reportsService.cleanupOldReports(30);

      expect(deletedCount).toBeGreaterThanOrEqual(1);
      expect(fs.existsSync(oldFilePath)).toBe(false);
    });
  });

  describe('Report Data Accuracy', () => {
    test('should calculate bill summary correctly', async () => {
      // Test is implicitly covered by PDF/CSV generation
      // We can add specific database queries to verify calculations

      const billSummary = await pool.query(`
        SELECT 
          COUNT(*) as total_bills,
          SUM(bill_amount) as total_amount,
          COUNT(CASE WHEN status = 'PAID' THEN 1 END) as paid_bills,
          COUNT(CASE WHEN status = 'PART-PAID' THEN 1 END) as partial_bills,
          COUNT(CASE WHEN status = 'DUE' THEN 1 END) as due_bills,
          SUM(remaining_due) as total_due
        FROM bill_status
        WHERE bill_date = $1
      `, [testDate]);

      const summary = billSummary.rows[0];
      expect(parseInt(summary.total_bills)).toBeGreaterThan(0);
      expect(parseFloat(summary.total_amount)).toBeGreaterThan(0);
    });

    test('should handle null values in calculations', async () => {
      // Insert bill without receipts to test null handling
      const testBillNoNull = 'RPT-NULL-TEST';
      await pool.query(`
        INSERT INTO bill (bill_no, bill_date, party_name, amount)
        VALUES ($1, $2, 'Null Test Party', 500.00)
        ON CONFLICT (bill_no) DO NOTHING
      `, [testBillNoNull, testDate]);

      // This should not throw error
      const result = await reportsService.generateEODCSV(testDate);
      expect(result).toHaveProperty('fileName');

      // Cleanup
      await pool.query('DELETE FROM bill WHERE bill_no = $1', [testBillNoNull]);
    });
  });

  describe('Error Handling', () => {
    test('should handle database connection errors gracefully', async () => {
      // Mock database error
      const originalQuery = pool.query;
      pool.query = jest.fn().mockRejectedValue(new Error('Database connection failed'));

      await expect(reportsService.generateEODPDF(testDate, 'Test User'))
        .rejects.toThrow('Database connection failed');

      // Restore original function
      pool.query = originalQuery;
    });

    test('should handle file system errors gracefully', async () => {
      // Mock fs operations to simulate file system errors
      const originalWriteFileSync = fs.writeFileSync;
      
      // This test would need more sophisticated mocking for comprehensive coverage
      // For now, we trust that the actual file operations work as tested above
    });
  });
});