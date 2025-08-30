const { pool } = require('../config/database');

// Setup before all tests
beforeAll(async () => {
  // Set test environment
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = 'test-secret-key';
  process.env.CASH_VARIANCE_THRESHOLD = '100';
  
  // Ensure database connection
  try {
    await pool.query('SELECT 1');
    console.log('✓ Database connection established for tests');
  } catch (error) {
    console.error('✗ Database connection failed:', error.message);
    console.error('Please ensure PostgreSQL is running and configured correctly');
    process.exit(1);
  }
});

// Cleanup after all tests
afterAll(async () => {
  // Close database connections
  await pool.end();
});

// Global error handler for unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Suppress console.log during tests unless specifically testing logging
if (process.env.NODE_ENV === 'test') {
  const originalConsoleError = console.error;
  const originalConsoleWarn = console.warn;
  
  console.error = (message, ...args) => {
    if (message && message.includes && message.includes('Unexpected error on idle client')) {
      // Suppress expected database connection messages during testing
      return;
    }
    originalConsoleError(message, ...args);
  };
  
  console.warn = (message, ...args) => {
    if (message && message.includes && message.includes('ETL already running')) {
      // Suppress expected ETL warnings during testing
      return;
    }
    originalConsoleWarn(message, ...args);
  };
}