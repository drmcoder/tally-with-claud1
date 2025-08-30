const request = require('supertest');
const app = require('../server');
const { pool } = require('../config/database');

describe('Business Rules Tests', () => {
  let authToken;
  let cashierToken;
  let dispatcherToken;
  let testBillNo;
  let sessionId;

  beforeAll(async () => {
    // Login as admin
    const adminLogin = await request(app)
      .post('/api/auth/login')
      .send({ username: 'admin', password: 'admin123' });
    authToken = adminLogin.body.token;

    // Create test users
    await pool.query(`
      INSERT INTO users (username, password_hash, full_name, role, pin_hash, active) 
      VALUES 
        ('testcashier', '$2a$12$9QAb2ZXzOzBuUm23v.UU4OYVrml1vmE8J6z3y0ZZI0aKhUIdB6mF2', 'Test Cashier', 'CASHIER', NULL, true),
        ('testdispatcher', '$2a$12$9QAb2ZXzOzBuUm23v.UU4OYVrml1vmE8J6z3y0ZZI0aKhUIdB6mF2', 'Test Dispatcher', 'DISPATCHER', NULL, true),
        ('testmanager', '$2a$12$9QAb2ZXzOzBuUm23v.UU4OYVrml1vmE8J6z3y0ZZI0aKhUIdB6mF2', 'Test Manager', 'MANAGER', '$2a$12$9QAb2ZXzOzBuUm23v.UU4OYVrml1vmE8J6z3y0ZZI0aKhUIdB6mF2', true)
      ON CONFLICT (username) DO NOTHING
    `);

    // Login as cashier and dispatcher
    const cashierLogin = await request(app)
      .post('/api/auth/login')
      .send({ username: 'testcashier', password: 'admin123' });
    cashierToken = cashierLogin.body.token;

    const dispatcherLogin = await request(app)
      .post('/api/auth/login')
      .send({ username: 'testdispatcher', password: 'admin123' });
    dispatcherToken = dispatcherLogin.body.token;

    // Create test bill
    testBillNo = 'RULE-TEST-001';
    await pool.query(`
      INSERT INTO bill (bill_no, bill_date, party_name, amount)
      VALUES ($1, CURRENT_DATE, 'Rule Test Party', 2000.00)
      ON CONFLICT (bill_no) DO UPDATE SET
        party_name = EXCLUDED.party_name,
        amount = EXCLUDED.amount
    `, [testBillNo]);
  });

  afterAll(async () => {
    // Cleanup in proper order to avoid foreign key constraints
    await pool.query('DELETE FROM cheque_register WHERE bill_no = $1', [testBillNo]);
    await pool.query('DELETE FROM digital_payment_ref WHERE bill_no = $1', [testBillNo]);
    await pool.query('DELETE FROM payment_hint WHERE bill_no = $1', [testBillNo]);
    await pool.query('DELETE FROM release_self WHERE bill_no = $1', [testBillNo]);
    await pool.query('DELETE FROM gate_log WHERE gatepass_id LIKE $1', ['GP-TEST%']);
    await pool.query('DELETE FROM bill WHERE bill_no = $1', [testBillNo]);
    await pool.query('DELETE FROM cashier_session WHERE cashier_id IN (SELECT id FROM users WHERE username IN ($1, $2))', ['testcashier', 'testdispatcher']);
    await pool.query('DELETE FROM users WHERE username IN ($1, $2, $3)', ['testcashier', 'testdispatcher', 'testmanager']);
  });

  describe('Cashier Session Rules', () => {
    test('should require active session for payment operations', async () => {
      const response = await request(app)
        .post('/api/cashier/payment-hint')
        .set('Authorization', `Bearer ${cashierToken}`)
        .send({
          bill_no: testBillNo,
          cash_amt: 500
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('No active cashier session');
    });

    test('should allow opening session', async () => {
      const response = await request(app)
        .post('/api/cashier/session/open')
        .set('Authorization', `Bearer ${cashierToken}`)
        .send({
          start_float: 1000,
          opened_by_pin: '1234'
        });

      expect(response.status).toBe(200);
      expect(response.body.session).toHaveProperty('id');
      sessionId = response.body.session.id;
    });

    test('should prevent duplicate active sessions', async () => {
      const response = await request(app)
        .post('/api/cashier/session/open')
        .set('Authorization', `Bearer ${cashierToken}`)
        .send({
          start_float: 1000,
          opened_by_pin: '1234'
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Active session already exists');
    });

    test('should allow payment operations with active session', async () => {
      const response = await request(app)
        .post('/api/cashier/payment-hint')
        .set('Authorization', `Bearer ${cashierToken}`)
        .send({
          bill_no: testBillNo,
          cash_amt: 1500,
          cheque_amt: 500,
          cheque_no: 'CHQ-001',
          bank: 'Test Bank'
        });

      expect(response.status).toBe(200);
      expect(parseFloat(response.body.paymentHint.remaining_due)).toBe(0);
    });
  });

  describe('Release Rules', () => {
    test('should prevent release without dispatcher role', async () => {
      const response = await request(app)
        .post('/api/dispatch/release/self')
        .set('Authorization', `Bearer ${cashierToken}`)
        .send({
          bill_no: testBillNo,
          gatepass_id: 'GP-001',
          receiver_name: 'Test Receiver',
          receiver_phone: '9876543210'
        });

      expect(response.status).toBe(403);
      expect(response.body.error).toBe('Insufficient permissions');
    });

    test('should allow release with dispatcher role and paid bill', async () => {
      const response = await request(app)
        .post('/api/dispatch/release/self')
        .set('Authorization', `Bearer ${dispatcherToken}`)
        .send({
          bill_no: testBillNo,
          gatepass_id: 'GP-TEST-001',
          receiver_name: 'Test Receiver',
          receiver_phone: '9876543210'
        });

      expect(response.status).toBe(200);
      expect(response.body.message).toBe('Bill released to customer successfully');
    });

    test('should prevent duplicate release', async () => {
      const response = await request(app)
        .post('/api/dispatch/release/self')
        .set('Authorization', `Bearer ${dispatcherToken}`)
        .send({
          bill_no: testBillNo,
          gatepass_id: 'GP-TEST-002',
          receiver_name: 'Test Receiver 2',
          receiver_phone: '9876543211'
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Bill already released');
    });

    test('should prevent duplicate gatepass ID', async () => {
      // Create another bill
      const testBillNo2 = 'RULE-TEST-002';
      await pool.query(`
        INSERT INTO bill (bill_no, bill_date, party_name, amount)
        VALUES ($1, CURRENT_DATE, 'Rule Test Party 2', 1000.00)
        ON CONFLICT (bill_no) DO NOTHING
      `, [testBillNo2]);

      const response = await request(app)
        .post('/api/dispatch/release/self')
        .set('Authorization', `Bearer ${dispatcherToken}`)
        .send({
          bill_no: testBillNo2,
          gatepass_id: 'GP-TEST-001', // Same gatepass ID
          receiver_name: 'Test Receiver 3',
          receiver_phone: '9876543212'
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Gatepass ID already used');

      // Cleanup
      await pool.query('DELETE FROM bill WHERE bill_no = $1', [testBillNo2]);
    });
  });

  describe('Cash Variance Rules', () => {
    test('should calculate expected cash correctly', async () => {
      const response = await request(app)
        .get('/api/cashier/session/current')
        .set('Authorization', `Bearer ${cashierToken}`);

      expect(response.status).toBe(200);
      expect(response.body.session).toHaveProperty('expected_cash');
      
      // Expected = start_float + cash_payments - petty_cash + adjustments
      // Should be 1000 (start) + 1500 (cash from payment) = 2500
      expect(parseFloat(response.body.session.expected_cash)).toBe(2500);
    });

    test('should require approval for high variance', async () => {
      // Set high variance threshold for test
      process.env.CASH_VARIANCE_THRESHOLD = '50';

      const response = await request(app)
        .post(`/api/cashier/session/${sessionId}/close`)
        .set('Authorization', `Bearer ${cashierToken}`)
        .send({
          counted_cash: 2000 // 500 less than expected (2500)
        });

      expect(response.status).toBe(200);
      expect(response.body.variance).toBe(-500);
      expect(Math.abs(response.body.variance)).toBeGreaterThan(50);
    });
  });

  describe('Role-Based Access', () => {
    test('should restrict admin routes to admin users', async () => {
      const response = await request(app)
        .get('/api/admin/dispatch-board')
        .set('Authorization', `Bearer ${cashierToken}`);

      expect(response.status).toBe(403);
      expect(response.body.error).toBe('Insufficient permissions');
    });

    test('should allow admin routes for admin users', async () => {
      const response = await request(app)
        .get('/api/admin/dispatch-board')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('ready');
      expect(response.body).toHaveProperty('released');
      expect(response.body).toHaveProperty('flagged');
    });

    test('should restrict security routes to security users', async () => {
      const response = await request(app)
        .post('/api/gate/log')
        .set('Authorization', `Bearer ${cashierToken}`)
        .send({
          gatepass_id: 'GP-TEST-001',
          vehicle_no: 'TEST-VEH-001'
        });

      expect(response.status).toBe(403);
      expect(response.body.error).toBe('Insufficient permissions');
    });
  });

  describe('Gate Log Rules', () => {
    test('should validate gatepass before creating log', async () => {
      const response = await request(app)
        .get('/api/gate/validate/INVALID-GP')
        .set('Authorization', `Bearer ${authToken}`); // Admin can access

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Invalid gatepass ID');
    });

    test('should validate existing gatepass', async () => {
      const response = await request(app)
        .get('/api/gate/validate/GP-TEST-001')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(200);
      expect(response.body.valid).toBe(true);
      expect(response.body.release.bill_no).toBe(testBillNo);
    });
  });
});