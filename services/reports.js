const PDFDocument = require('pdfkit');
const createCsvWriter = require('csv-writer').createObjectCsvWriter;
const fs = require('fs');
const path = require('path');
const { pool } = require('../config/database');
const logger = require('./logger');

class ReportsService {
  constructor() {
    this.reportsDir = path.join(__dirname, '../uploads/reports');
    this.ensureReportsDir();
  }

  ensureReportsDir() {
    if (!fs.existsSync(this.reportsDir)) {
      fs.mkdirSync(this.reportsDir, { recursive: true });
    }
  }

  // Generate EOD (End of Day) PDF Report
  async generateEODPDF(businessDate, preparedBy) {
    try {
      const fileName = `EOD_${businessDate.replace(/-/g, '')}.pdf`;
      const filePath = path.join(this.reportsDir, fileName);

      const doc = new PDFDocument({ margin: 50, size: 'A4' });
      doc.pipe(fs.createWriteStream(filePath));

      // Header
      doc.fontSize(16).font('Helvetica-Bold');
      doc.text('END OF DAY REPORT', { align: 'center' });
      doc.moveDown(0.5);
      
      doc.fontSize(12).font('Helvetica');
      doc.text(`Business Date: ${businessDate}`, { align: 'center' });
      doc.text(`Generated: ${new Date().toLocaleString()}`, { align: 'center' });
      doc.text(`Prepared By: ${preparedBy}`, { align: 'center' });
      
      doc.moveDown(1);
      doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
      doc.moveDown(0.5);

      // 1. Bills Summary
      await this.addBillsSummaryToPDF(doc, businessDate);
      
      // 2. Cash Counter Summary
      await this.addCashSummaryToPDF(doc, businessDate);
      
      // 3. Receipts Summary
      await this.addReceiptsSummaryToPDF(doc, businessDate);
      
      // 4. Dispatch Summary
      await this.addDispatchSummaryToPDF(doc, businessDate);
      
      // 5. Cheque Register
      await this.addChequeRegisterToPDF(doc, businessDate);
      
      // 6. Digital Payments
      await this.addDigitalPaymentsToPDF(doc, businessDate);
      
      // 7. Exception Report
      await this.addExceptionsToPDF(doc, businessDate);

      doc.end();
      
      return { fileName, filePath };

    } catch (error) {
      logger.error('EOD PDF generation failed:', error);
      throw error;
    }
  }

  async addBillsSummaryToPDF(doc, businessDate) {
    const summary = await pool.query(`
      SELECT 
        COUNT(*) as total_bills,
        SUM(bill_amount) as total_amount,
        COUNT(CASE WHEN status = 'PAID' THEN 1 END) as paid_bills,
        COUNT(CASE WHEN status = 'PART-PAID' THEN 1 END) as partial_bills,
        COUNT(CASE WHEN status = 'DUE' THEN 1 END) as due_bills,
        SUM(remaining_due) as total_due
      FROM bill_status
      WHERE bill_date = $1
    `, [businessDate]);

    const data = summary.rows[0];
    
    doc.fontSize(14).font('Helvetica-Bold');
    doc.text('1. BILLS SUMMARY', 50, doc.y);
    doc.moveDown(0.5);
    
    doc.fontSize(10).font('Helvetica');
    doc.text(`Total Bills: ${data.total_bills}`, 70);
    doc.text(`Total Amount: ₹${parseFloat(data.total_amount || 0).toFixed(2)}`, 300);
    doc.text(`Paid Bills: ${data.paid_bills}`, 70);
    doc.text(`Partial Bills: ${data.partial_bills}`, 300);
    doc.text(`Due Bills: ${data.due_bills}`, 70);
    doc.text(`Total Outstanding: ₹${parseFloat(data.total_due || 0).toFixed(2)}`, 300);
    
    doc.moveDown(1);
  }

  async addCashSummaryToPDF(doc, businessDate) {
    const summary = await pool.query(`
      SELECT 
        COUNT(DISTINCT cs.id) as total_sessions,
        SUM(cs.start_float) as total_start_float,
        SUM(cs.counted_cash) as total_counted,
        SUM(cs.expected_cash) as total_expected,
        SUM(cs.variance) as total_variance,
        SUM(ph.cash_amt) as total_cash_received,
        SUM(pc.amount) as total_petty_cash,
        SUM(CASE WHEN ta.type = 'ADD_TO_TILL' THEN ta.amount ELSE -ta.amount END) as net_adjustments
      FROM cashier_session cs
      LEFT JOIN payment_hint ph ON cs.cashier_id = ph.cashier_id 
        AND ph.created_at BETWEEN cs.start_ts AND COALESCE(cs.end_ts, CURRENT_TIMESTAMP)
      LEFT JOIN petty_cash pc ON cs.id = pc.session_id
      LEFT JOIN till_adjustment ta ON cs.id = ta.session_id
      WHERE DATE(cs.start_ts) = $1
    `, [businessDate]);

    const data = summary.rows[0];
    
    doc.fontSize(14).font('Helvetica-Bold');
    doc.text('2. CASH COUNTER SUMMARY', 50, doc.y);
    doc.moveDown(0.5);
    
    doc.fontSize(10).font('Helvetica');
    doc.text(`Active Sessions: ${data.total_sessions || 0}`, 70);
    doc.text(`Start Float: ₹${parseFloat(data.total_start_float || 0).toFixed(2)}`, 300);
    doc.text(`Cash Received: ₹${parseFloat(data.total_cash_received || 0).toFixed(2)}`, 70);
    doc.text(`Petty Cash: ₹${parseFloat(data.total_petty_cash || 0).toFixed(2)}`, 300);
    doc.text(`Till Adjustments: ₹${parseFloat(data.net_adjustments || 0).toFixed(2)}`, 70);
    doc.text(`Expected Cash: ₹${parseFloat(data.total_expected || 0).toFixed(2)}`, 300);
    doc.text(`Counted Cash: ₹${parseFloat(data.total_counted || 0).toFixed(2)}`, 70);
    doc.text(`Variance: ₹${parseFloat(data.total_variance || 0).toFixed(2)}`, 300);
    
    doc.moveDown(1);
  }

  async addReceiptsSummaryToPDF(doc, businessDate) {
    const summary = await pool.query(`
      SELECT 
        COUNT(*) as total_receipts,
        SUM(amount) as total_amount,
        COUNT(CASE WHEN mode = 'CASH' THEN 1 END) as cash_count,
        SUM(CASE WHEN mode = 'CASH' THEN amount ELSE 0 END) as cash_amount,
        COUNT(CASE WHEN mode = 'CHEQUE' THEN 1 END) as cheque_count,
        SUM(CASE WHEN mode = 'CHEQUE' THEN amount ELSE 0 END) as cheque_amount,
        COUNT(CASE WHEN mode = 'DIGITAL' THEN 1 END) as digital_count,
        SUM(CASE WHEN mode = 'DIGITAL' THEN amount ELSE 0 END) as digital_amount
      FROM receipt
      WHERE receipt_date = $1
    `, [businessDate]);

    const data = summary.rows[0];
    
    doc.fontSize(14).font('Helvetica-Bold');
    doc.text('3. RECEIPTS SUMMARY', 50, doc.y);
    doc.moveDown(0.5);
    
    doc.fontSize(10).font('Helvetica');
    doc.text(`Total Receipts: ${data.total_receipts}`, 70);
    doc.text(`Total Amount: ₹${parseFloat(data.total_amount || 0).toFixed(2)}`, 300);
    doc.text(`Cash (${data.cash_count}): ₹${parseFloat(data.cash_amount || 0).toFixed(2)}`, 70);
    doc.text(`Cheque (${data.cheque_count}): ₹${parseFloat(data.cheque_amount || 0).toFixed(2)}`, 300);
    doc.text(`Digital (${data.digital_count}): ₹${parseFloat(data.digital_amount || 0).toFixed(2)}`, 70);
    
    doc.moveDown(1);
  }

  async addDispatchSummaryToPDF(doc, businessDate) {
    const summary = await pool.query(`
      SELECT 
        COUNT(CASE WHEN rs.release_status = 'READY' THEN 1 END) as ready_count,
        COUNT(CASE WHEN rs.release_status = 'RELEASED_SELF' THEN 1 END) as self_released,
        COUNT(CASE WHEN rs.release_status = 'IN_TRANSIT' THEN 1 END) as in_transit,
        COUNT(CASE WHEN rs.release_status = 'DELIVERED' THEN 1 END) as delivered,
        COUNT(CASE WHEN bs.remaining_due > 0 THEN 1 END) as flagged_releases
      FROM bill_status bs
      LEFT JOIN release_status rs ON bs.bill_no = rs.bill_no
      WHERE bs.bill_date = $1
    `, [businessDate]);

    const data = summary.rows[0];
    
    doc.fontSize(14).font('Helvetica-Bold');
    doc.text('4. DISPATCH SUMMARY', 50, doc.y);
    doc.moveDown(0.5);
    
    doc.fontSize(10).font('Helvetica');
    doc.text(`Ready for Release: ${data.ready_count}`, 70);
    doc.text(`Self Released: ${data.self_released}`, 300);
    doc.text(`In Transit: ${data.in_transit}`, 70);
    doc.text(`Delivered: ${data.delivered}`, 300);
    doc.text(`Flagged (Outstanding Due): ${data.flagged_releases}`, 70);
    
    doc.moveDown(1);
  }

  async addChequeRegisterToPDF(doc, businessDate) {
    const cheques = await pool.query(`
      SELECT 
        cr.cheque_no,
        cr.bank,
        cr.amount,
        cr.status,
        b.party_name
      FROM cheque_register cr
      JOIN bill b ON cr.bill_no = b.bill_no
      WHERE b.bill_date = $1
      ORDER BY cr.created_at
    `, [businessDate]);

    doc.fontSize(14).font('Helvetica-Bold');
    doc.text('5. CHEQUE REGISTER', 50, doc.y);
    doc.moveDown(0.5);
    
    if (cheques.rows.length > 0) {
      doc.fontSize(9).font('Helvetica');
      
      // Table header
      doc.text('Cheque No', 70, doc.y);
      doc.text('Bank', 150, doc.y);
      doc.text('Amount', 250, doc.y);
      doc.text('Party', 320, doc.y);
      doc.text('Status', 450, doc.y);
      doc.moveDown(0.3);
      
      doc.moveTo(70, doc.y).lineTo(500, doc.y).stroke();
      doc.moveDown(0.3);
      
      for (const cheque of cheques.rows) {
        doc.text(cheque.cheque_no, 70, doc.y);
        doc.text(cheque.bank, 150, doc.y);
        doc.text(`₹${parseFloat(cheque.amount).toFixed(2)}`, 250, doc.y);
        doc.text(cheque.party_name.substring(0, 20), 320, doc.y);
        doc.text(cheque.status, 450, doc.y);
        doc.moveDown(0.3);
      }
    } else {
      doc.fontSize(10).font('Helvetica');
      doc.text('No cheques for this date', 70);
    }
    
    doc.moveDown(1);
  }

  async addDigitalPaymentsToPDF(doc, businessDate) {
    const digital = await pool.query(`
      SELECT 
        dpr.method,
        dpr.reference_no,
        dpr.amount,
        dpr.status,
        b.party_name
      FROM digital_payment_ref dpr
      JOIN bill b ON dpr.bill_no = b.bill_no
      WHERE b.bill_date = $1
      ORDER BY dpr.created_at
    `, [businessDate]);

    doc.fontSize(14).font('Helvetica-Bold');
    doc.text('6. DIGITAL PAYMENTS', 50, doc.y);
    doc.moveDown(0.5);
    
    if (digital.rows.length > 0) {
      doc.fontSize(9).font('Helvetica');
      
      for (const payment of digital.rows) {
        doc.text(`${payment.method}: ${payment.reference_no} - ₹${parseFloat(payment.amount).toFixed(2)} (${payment.status})`, 70);
        doc.moveDown(0.3);
      }
    } else {
      doc.fontSize(10).font('Helvetica');
      doc.text('No digital payments for this date', 70);
    }
    
    doc.moveDown(1);
  }

  async addExceptionsToPDF(doc, businessDate) {
    // Get various exceptions
    const unmatched = await pool.query(`
      SELECT COUNT(*) as count FROM receipt 
      WHERE receipt_date = $1 AND bill_reference IS NULL
    `, [businessDate]);

    const dueReleases = await pool.query(`
      SELECT COUNT(*) as count 
      FROM bill_status bs
      JOIN (
        SELECT bill_no FROM release_self 
        UNION ALL 
        SELECT bill_no FROM release_transporter
      ) r ON bs.bill_no = r.bill_no
      WHERE bs.bill_date = $1 AND bs.remaining_due > 0
    `, [businessDate]);

    doc.fontSize(14).font('Helvetica-Bold');
    doc.text('7. EXCEPTIONS REPORT', 50, doc.y);
    doc.moveDown(0.5);
    
    doc.fontSize(10).font('Helvetica');
    doc.text(`Unmatched Receipts: ${unmatched.rows[0].count}`, 70);
    doc.text(`Due Releases (Outstanding): ${dueReleases.rows[0].count}`, 70);
    
    doc.moveDown(2);
    
    // Signatures section
    doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
    doc.moveDown(0.5);
    
    doc.text('Prepared By: ________________________', 70);
    doc.text('Date: ________________', 350);
    doc.moveDown(1);
    doc.text('Approved By: ________________________', 70);
    doc.text('Date: ________________', 350);
  }

  // Generate EOD CSV Export
  async generateEODCSV(businessDate) {
    try {
      const fileName = `EOD_${businessDate.replace(/-/g, '')}.csv`;
      const filePath = path.join(this.reportsDir, fileName);

      // Get comprehensive data
      const data = await pool.query(`
        SELECT 
          bs.bill_no,
          bs.bill_date,
          bs.party_name,
          bs.bill_amount,
          bs.receipt_total,
          bs.remaining_due,
          bs.status as bill_status,
          ph.cash_amt,
          ph.cheque_amt,
          ph.digital_amt,
          u.full_name as cashier_name,
          CASE 
            WHEN rs.bill_no IS NOT NULL THEN 'Self Pickup'
            WHEN rt.bill_no IS NOT NULL THEN 'Transporter'
            ELSE 'Not Released'
          END as release_type,
          COALESCE(rs.released_ts, rt.pickup_ts) as release_time
        FROM bill_status bs
        LEFT JOIN payment_hint ph ON bs.bill_no = ph.bill_no
        LEFT JOIN users u ON ph.cashier_id = u.id
        LEFT JOIN release_self rs ON bs.bill_no = rs.bill_no
        LEFT JOIN release_transporter rt ON bs.bill_no = rt.bill_no
        WHERE bs.bill_date = $1
        ORDER BY bs.bill_no
      `, [businessDate]);

      const csvWriter = createCsvWriter({
        path: filePath,
        header: [
          { id: 'bill_no', title: 'Bill No' },
          { id: 'party_name', title: 'Party Name' },
          { id: 'bill_amount', title: 'Bill Amount' },
          { id: 'receipt_total', title: 'Receipt Total' },
          { id: 'remaining_due', title: 'Remaining Due' },
          { id: 'bill_status', title: 'Status' },
          { id: 'cash_amt', title: 'Cash Amount' },
          { id: 'cheque_amt', title: 'Cheque Amount' },
          { id: 'digital_amt', title: 'Digital Amount' },
          { id: 'cashier_name', title: 'Cashier' },
          { id: 'release_type', title: 'Release Type' },
          { id: 'release_time', title: 'Release Time' }
        ]
      });

      await csvWriter.writeRecords(data.rows);
      
      return { fileName, filePath };

    } catch (error) {
      logger.error('EOD CSV generation failed:', error);
      throw error;
    }
  }

  // Clean old reports
  async cleanupOldReports(daysOld = 30) {
    try {
      const files = fs.readdirSync(this.reportsDir);
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - daysOld);

      let deletedCount = 0;
      
      for (const file of files) {
        const filePath = path.join(this.reportsDir, file);
        const stats = fs.statSync(filePath);
        
        if (stats.mtime < cutoffDate) {
          fs.unlinkSync(filePath);
          deletedCount++;
        }
      }
      
      logger.info(`Cleaned up ${deletedCount} old report files`);
      return deletedCount;
      
    } catch (error) {
      logger.error('Report cleanup failed:', error);
      throw error;
    }
  }
}

module.exports = new ReportsService();