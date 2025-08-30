const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
require('dotenv').config();

const logger = require('./services/logger');
const etlService = require('./services/tally-xml-etl');
const tallyODBCService = require('./services/tally-odbc');

const app = express();
const PORT = process.env.PORT || 3000;

// Security middleware with CSP configuration
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net", "https://cdnjs.cloudflare.com"],
      fontSrc: ["'self'", "https://cdnjs.cloudflare.com"],
      imgSrc: ["'self'", "data:", "https:"],
    },
  },
}));
app.use(cors({
  origin: process.env.CORS_ORIGIN || ['http://localhost:3000', 'http://localhost:3001'],
  credentials: true
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP'
});
app.use(limiter);

// Body parsing middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Static files
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(express.static(path.join(__dirname, 'public')));

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/bills', require('./routes/bills'));
app.use('/api/cashier', require('./routes/cashier'));
app.use('/api/dispatch', require('./routes/dispatch'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/gate', require('./routes/gate'));
app.use('/api/tally-sync', require('./routes/tally-sync'));

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    version: '1.0.0'
  });
});

// API documentation
app.get('/api', (req, res) => {
  res.json({
    name: 'Tally Dashboard API',
    version: '1.0.0',
    description: 'Tally Prime integration dashboard API',
    endpoints: {
      auth: '/api/auth',
      bills: '/api/bills', 
      cashier: '/api/cashier',
      dispatch: '/api/dispatch',
      admin: '/api/admin',
      gate: '/api/gate',
      tallySync: '/api/tally-sync'
    }
  });
});

// Serve frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Error handling middleware
app.use((err, req, res, next) => {
  logger.error('Unhandled error:', err);
  res.status(500).json({ 
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// Start server only if not in test mode and not required by another module
if (process.env.NODE_ENV !== 'test' && require.main === module) {
  app.listen(PORT, async () => {
    logger.info(`Tally Dashboard server running on port ${PORT}`);
    
    // Initialize and start Tally ODBC service
    try {
      await tallyODBCService.initialize();
      tallyODBCService.startRealTimeSync();
      logger.info('Tally ODBC service initialized and started');
    } catch (error) {
      logger.warn('Failed to initialize ODBC service, falling back to XML ETL:', error.message);
      // Start ETL service as fallback
      etlService.startScheduled();
      logger.info('XML ETL service started as fallback');
    }
  });
}

// Graceful shutdown
process.on('SIGINT', async () => {
  logger.info('Shutting down gracefully...');
  tallyODBCService.stopSync();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.info('Shutting down gracefully...');
  tallyODBCService.stopSync();
  process.exit(0);
});

module.exports = app;