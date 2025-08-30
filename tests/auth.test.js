const request = require('supertest');
const app = require('../server');
const { pool } = require('../config/database');

describe('Authentication Routes', () => {
  let authToken;
  
  beforeAll(async () => {
    // Ensure test user exists
    await pool.query(`
      INSERT INTO users (username, password_hash, full_name, role, pin_hash, active) 
      VALUES ('testuser', '$2a$12$9QAb2ZXzOzBuUm23v.UU4OYVrml1vmE8J6z3y0ZZI0aKhUIdB6mF2', 'Test User', 'CASHIER', '$2a$12$9QAb2ZXzOzBuUm23v.UU4OYVrml1vmE8J6z3y0ZZI0aKhUIdB6mF2', true)
      ON CONFLICT (username) DO NOTHING
    `);
  });

  afterAll(async () => {
    await pool.query('DELETE FROM users WHERE username = $1', ['testuser']);
    await pool.end();
  });

  describe('POST /api/auth/login', () => {
    test('should login with valid credentials', async () => {
      const response = await request(app)
        .post('/api/auth/login')
        .send({
          username: 'admin',
          password: 'admin123'
        });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('token');
      expect(response.body).toHaveProperty('user');
      expect(response.body.user.username).toBe('admin');
      
      authToken = response.body.token;
    });

    test('should reject invalid credentials', async () => {
      const response = await request(app)
        .post('/api/auth/login')
        .send({
          username: 'admin',
          password: 'wrongpassword'
        });

      expect(response.status).toBe(401);
      expect(response.body.error).toBe('Invalid credentials');
    });

    test('should reject missing credentials', async () => {
      const response = await request(app)
        .post('/api/auth/login')
        .send({});

      expect(response.status).toBe(401);
    });
  });

  describe('GET /api/auth/me', () => {
    test('should return user info with valid token', async () => {
      const response = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(200);
      expect(response.body.user.username).toBe('admin');
    });

    test('should reject request without token', async () => {
      const response = await request(app)
        .get('/api/auth/me');

      expect(response.status).toBe(401);
    });

    test('should reject request with invalid token', async () => {
      const response = await request(app)
        .get('/api/auth/me')
        .set('Authorization', 'Bearer invalidtoken');

      expect(response.status).toBe(403);
    });
  });

  describe('POST /api/auth/change-password', () => {
    test('should change password with valid current password', async () => {
      // First login as test user
      const loginResponse = await request(app)
        .post('/api/auth/login')
        .send({
          username: 'testuser',
          password: 'admin123'
        });

      const testToken = loginResponse.body.token;

      const response = await request(app)
        .post('/api/auth/change-password')
        .set('Authorization', `Bearer ${testToken}`)
        .send({
          currentPassword: 'admin123',
          newPassword: 'newpassword123'
        });

      expect(response.status).toBe(200);
      expect(response.body.message).toBe('Password changed successfully');
    });

    test('should reject with wrong current password', async () => {
      const response = await request(app)
        .post('/api/auth/change-password')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          currentPassword: 'wrongpassword',
          newPassword: 'newpassword123'
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Current password incorrect');
    });
  });
});