const { pool } = require('../config/database');
const crypto = require('crypto');
const logger = require('./logger');

class OTPService {
  constructor() {
    this.otpLength = 6;
    this.expiryMinutes = 10;
  }

  // Generate random OTP
  generateOTP() {
    return crypto.randomInt(100000, 999999).toString();
  }

  // Create OTP for customer verification
  async createOTP(billNo, phone) {
    try {
      const otp = this.generateOTP();
      const expiresAt = new Date(Date.now() + this.expiryMinutes * 60 * 1000);

      // Invalidate any existing OTPs for this bill
      await pool.query(
        'DELETE FROM customer_otp WHERE bill_no = $1',
        [billNo]
      );

      // Insert new OTP
      const result = await pool.query(`
        INSERT INTO customer_otp (bill_no, phone, otp_code, expires_at)
        VALUES ($1, $2, $3, $4)
        RETURNING id
      `, [billNo, phone, otp, expiresAt]);

      // In production, send SMS here
      logger.info(`OTP generated for bill ${billNo}: ${otp} (expires: ${expiresAt})`);
      
      // For demo, we'll just log it
      console.log(`📱 SMS to ${phone}: Your OTP for bill ${billNo} is ${otp}. Valid for ${this.expiryMinutes} minutes.`);

      return {
        id: result.rows[0].id,
        phone,
        expiresAt,
        message: 'OTP sent successfully'
      };

    } catch (error) {
      logger.error('OTP creation failed:', error);
      throw error;
    }
  }

  // Verify OTP
  async verifyOTP(billNo, otpCode) {
    try {
      const result = await pool.query(`
        SELECT id, phone, expires_at, verified
        FROM customer_otp 
        WHERE bill_no = $1 AND otp_code = $2
      `, [billNo, otpCode]);

      if (result.rows.length === 0) {
        return { valid: false, error: 'Invalid OTP' };
      }

      const otp = result.rows[0];

      if (otp.verified) {
        return { valid: false, error: 'OTP already used' };
      }

      if (new Date() > otp.expires_at) {
        return { valid: false, error: 'OTP expired' };
      }

      // Mark as verified
      await pool.query(
        'UPDATE customer_otp SET verified = true WHERE id = $1',
        [otp.id]
      );

      logger.info(`OTP verified for bill ${billNo}`);

      return { 
        valid: true, 
        phone: otp.phone,
        message: 'OTP verified successfully' 
      };

    } catch (error) {
      logger.error('OTP verification failed:', error);
      throw error;
    }
  }

  // Resend OTP
  async resendOTP(billNo) {
    try {
      // Get existing OTP record
      const existing = await pool.query(
        'SELECT phone FROM customer_otp WHERE bill_no = $1 ORDER BY created_at DESC LIMIT 1',
        [billNo]
      );

      if (existing.rows.length === 0) {
        throw new Error('No OTP request found for this bill');
      }

      return await this.createOTP(billNo, existing.rows[0].phone);

    } catch (error) {
      logger.error('OTP resend failed:', error);
      throw error;
    }
  }

  // Clean expired OTPs (run periodically)
  async cleanupExpiredOTPs() {
    try {
      const result = await pool.query(
        'DELETE FROM customer_otp WHERE expires_at < CURRENT_TIMESTAMP'
      );
      
      if (result.rowCount > 0) {
        logger.info(`Cleaned up ${result.rowCount} expired OTPs`);
      }
    } catch (error) {
      logger.error('OTP cleanup failed:', error);
    }
  }
}

module.exports = new OTPService();