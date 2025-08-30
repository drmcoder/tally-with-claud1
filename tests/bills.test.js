const request = require('supertest');
const app = require('../server');
const { pool } = require('../config/database');

describe('Bills Routes', () => {
  let authToken;
  let testBillNo;

  beforeAll(async () => {
    // Login to get token
    const loginResponse = await request(app)
      .post('/api/auth/login')
      .send({
        username: 'admin',
        password: 'admin123'
      });
    authToken = loginResponse.body.token;

    // Create test bill
    testBillNo = 'TEST-BILL-001';
    await pool.query(`
      INSERT INTO bill (bill_no, bill_date, party_name, amount)
      VALUES ($1, CURRENT_DATE, 'Test Party', 1000.00)
      ON CONFLICT (bill_no) DO NOTHING
    `, [testBillNo]);
  });

  afterAll(async () => {
    // Cleanup
    await pool.query('DELETE FROM bill WHERE bill_no = $1', [testBillNo]);
  });

  describe('GET /api/bills', () => {
    test('should fetch bills list with authentication', async () => {
      const response = await request(app)
        .get('/api/bills')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('bills');
      expect(response.body).toHaveProperty('pagination');
      expect(Array.isArray(response.body.bills)).toBe(true);
    });

    test('should reject request without authentication', async () => {
      const response = await request(app)
        .get('/api/bills');

      expect(response.status).toBe(401);
    });

    test('should filter bills by date', async () => {
      const today = new Date().toISOString().split('T')[0];
      const response = await request(app)
        .get(`/api/bills?date=${today}`)
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(200);
      expect(response.body.bills.every(bill => bill.bill_date === today)).toBe(true);
    });

    test('should search bills by party name', async () => {
      const response = await request(app)
        .get('/api/bills?search=Test')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(200);
      if (response.body.bills.length > 0) {
        expect(response.body.bills.some(bill => 
          bill.party_name.includes('Test') || bill.bill_no.includes('Test')
        )).toBe(true);
      }
    });

    test('should paginate results', async () => {
      const response = await request(app)
        .get('/api/bills?page=1&limit=5')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(200);
      expect(response.body.pagination.page).toBe(1);
      expect(response.body.pagination.limit).toBe(5);
      expect(response.body.bills.length).toBeLessThanOrEqual(5);
    });
  });

  describe('GET /api/bills/:bill_no', () => {
    test('should fetch specific bill details', async () => {
      const response = await request(app)
        .get(`/api/bills/${testBillNo}`)
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(200);
      expect(response.body.bill.bill_no).toBe(testBillNo);
      expect(response.body).toHaveProperty('payments');
      expect(response.body).toHaveProperty('receipts');
      expect(response.body).toHaveProperty('gateLog');
    });

    test('should return 404 for non-existent bill', async () => {
      const response = await request(app)
        .get('/api/bills/NON-EXISTENT')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Bill not found');
    });
  });

  describe('GET /api/bills/dashboard/summary', () => {
    test('should fetch dashboard summary', async () => {
      const response = await request(app)
        .get('/api/bills/dashboard/summary')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('bills');
      expect(response.body).toHaveProperty('releases');
      expect(response.body).toHaveProperty('activeSessions');
      expect(response.body).toHaveProperty('date');
    });

    test('should fetch summary for specific date', async () => {
      const testDate = '2024-01-01';
      const response = await request(app)
        .get(`/api/bills/dashboard/summary?date=${testDate}`)
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(200);
      expect(response.body.date).toBe(testDate);
    });
  });
});