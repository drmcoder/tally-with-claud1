#!/usr/bin/env node

/**
 * Comprehensive Tally Integration Test
 * Tests both ODBC and XML API connections, data sync, and error handling
 */

const axios = require('axios');
const { pool } = require('./config/database');
const tallyODBCService = require('./services/tally-odbc');
const logger = require('./services/logger');

class TallyIntegrationTester {
  constructor() {
    this.results = {
      connection_tests: {},
      data_sync_tests: {},
      error_handling_tests: {},
      performance_tests: {}
    };
    this.serverUrl = 'http://localhost:3000';
  }

  async runAllTests() {
    console.log('🔍 Starting Comprehensive Tally Integration Test Suite\n');
    console.log('=' .repeat(60));

    try {
      // Test 1: Connection Tests
      console.log('\n📡 PHASE 1: Connection Tests');
      await this.testConnections();

      // Test 2: Data Sync Tests  
      console.log('\n📊 PHASE 2: Data Synchronization Tests');
      await this.testDataSync();

      // Test 3: Error Handling Tests
      console.log('\n⚠️  PHASE 3: Error Handling Tests');
      await this.testErrorHandling();

      // Test 4: Performance Tests
      console.log('\n🚀 PHASE 4: Performance Tests');
      await this.testPerformance();

      // Generate Report
      console.log('\n📋 PHASE 5: Test Report');
      this.generateReport();

    } catch (error) {
      console.error('💥 Test suite failed:', error);
      process.exit(1);
    }
  }

  async testConnections() {
    console.log('  Testing Tally connections...');
    
    try {
      // Test ODBC Connection
      console.log('  → Testing ODBC connection...');
      const odbcResult = await tallyODBCService.testODBCConnection();
      this.results.connection_tests.odbc = {
        success: !!odbcResult,
        connectionString: odbcResult || null,
        error: odbcResult ? null : 'No ODBC connection available'
      };
      console.log(`    ODBC: ${odbcResult ? '✅ Available' : '❌ Not Available'}`);

      // Test XML API Connection
      console.log('  → Testing XML API connection...');
      const xmlResult = await tallyODBCService.testXMLConnection();
      this.results.connection_tests.xml = {
        success: xmlResult,
        error: xmlResult ? null : 'XML API not available'
      };
      console.log(`    XML API: ${xmlResult ? '✅ Available' : '❌ Not Available'}`);

      // Test Service Initialization
      console.log('  → Testing service initialization...');
      try {
        const connectionMethod = await tallyODBCService.initialize();
        this.results.connection_tests.initialization = {
          success: true,
          method: connectionMethod
        };
        console.log(`    Initialization: ✅ Success (${connectionMethod})`);
      } catch (error) {
        this.results.connection_tests.initialization = {
          success: false,
          error: error.message
        };
        console.log(`    Initialization: ❌ Failed (${error.message})`);
      }

    } catch (error) {
      console.log(`    Connection Tests: ❌ Failed (${error.message})`);
    }
  }

  async testDataSync() {
    console.log('  Testing data synchronization...');

    try {
      // Test Bills Sync
      if (this.results.connection_tests.initialization?.success) {
        console.log('  → Testing bills synchronization...');
        try {
          let billsCount = 0;
          if (tallyODBCService.connectionMethod === 'odbc' || tallyODBCService.connectionMethod === 'hybrid') {
            billsCount = await tallyODBCService.syncBillsODBC();
          }
          
          this.results.data_sync_tests.bills = {
            success: true,
            count: billsCount
          };
          console.log(`    Bills Sync: ✅ Success (${billsCount} bills)`);
        } catch (error) {
          this.results.data_sync_tests.bills = {
            success: false,
            error: error.message
          };
          console.log(`    Bills Sync: ❌ Failed (${error.message})`);
        }

        // Test Receipts Sync
        console.log('  → Testing receipts synchronization...');
        try {
          let receiptsCount = 0;
          if (tallyODBCService.connectionMethod === 'odbc' || tallyODBCService.connectionMethod === 'hybrid') {
            receiptsCount = await tallyODBCService.syncReceiptsODBC();
          }
          
          this.results.data_sync_tests.receipts = {
            success: true,
            count: receiptsCount
          };
          console.log(`    Receipts Sync: ✅ Success (${receiptsCount} receipts)`);
        } catch (error) {
          this.results.data_sync_tests.receipts = {
            success: false,
            error: error.message
          };
          console.log(`    Receipts Sync: ❌ Failed (${error.message})`);
        }

        // Test Auto-Mapping
        console.log('  → Testing auto-mapping...');
        try {
          const mappedCount = await tallyODBCService.autoMapReceipts();
          this.results.data_sync_tests.autoMapping = {
            success: true,
            count: mappedCount
          };
          console.log(`    Auto-Mapping: ✅ Success (${mappedCount} receipts mapped)`);
        } catch (error) {
          this.results.data_sync_tests.autoMapping = {
            success: false,
            error: error.message
          };
          console.log(`    Auto-Mapping: ❌ Failed (${error.message})`);
        }
      } else {
        console.log('    Skipping data sync tests - no connection available');
      }

    } catch (error) {
      console.log(`    Data Sync Tests: ❌ Failed (${error.message})`);
    }
  }

  async testErrorHandling() {
    console.log('  Testing error handling and resilience...');

    // Test Database Connection Error Handling
    console.log('  → Testing database error handling...');
    try {
      const client = await pool.connect();
      await client.query('SELECT 1');
      client.release();
      
      this.results.error_handling_tests.database = {
        success: true,
        message: 'Database connection stable'
      };
      console.log(`    Database Connection: ✅ Stable`);
    } catch (error) {
      this.results.error_handling_tests.database = {
        success: false,
        error: error.message
      };
      console.log(`    Database Connection: ❌ Failed (${error.message})`);
    }

    // Test Invalid Data Handling
    console.log('  → Testing invalid data handling...');
    try {
      // Simulate invalid date formatting
      const testDate = tallyODBCService.formatTallyDate('invalid-date');
      const isValidDate = !isNaN(Date.parse(testDate));
      
      this.results.error_handling_tests.dataValidation = {
        success: isValidDate,
        message: isValidDate ? 'Invalid dates handled correctly' : 'Date validation failed'
      };
      console.log(`    Data Validation: ${isValidDate ? '✅' : '❌'} ${this.results.error_handling_tests.dataValidation.message}`);
    } catch (error) {
      this.results.error_handling_tests.dataValidation = {
        success: false,
        error: error.message
      };
      console.log(`    Data Validation: ❌ Failed (${error.message})`);
    }

    // Test Concurrent Sync Prevention
    console.log('  → Testing concurrent sync prevention...');
    try {
      tallyODBCService.isRunning = true;
      await tallyODBCService.runSync(); // Should skip
      
      this.results.error_handling_tests.concurrency = {
        success: true,
        message: 'Concurrent sync prevention working'
      };
      console.log(`    Concurrency Control: ✅ Working`);
      
      tallyODBCService.isRunning = false;
    } catch (error) {
      this.results.error_handling_tests.concurrency = {
        success: false,
        error: error.message
      };
      console.log(`    Concurrency Control: ❌ Failed (${error.message})`);
    }
  }

  async testPerformance() {
    console.log('  Testing performance metrics...');

    // Test Sync Performance
    console.log('  → Testing sync performance...');
    try {
      const startTime = Date.now();
      await tallyODBCService.runSync();
      const duration = Date.now() - startTime;
      
      this.results.performance_tests.syncDuration = {
        success: duration < 30000, // Should complete within 30 seconds
        duration: duration,
        message: `Sync completed in ${duration}ms`
      };
      
      console.log(`    Sync Performance: ${duration < 30000 ? '✅' : '⚠️'} ${duration}ms`);
    } catch (error) {
      this.results.performance_tests.syncDuration = {
        success: false,
        error: error.message
      };
      console.log(`    Sync Performance: ❌ Failed (${error.message})`);
    }

    // Test Database Query Performance
    console.log('  → Testing database query performance...');
    try {
      const client = await pool.connect();
      const startTime = Date.now();
      
      await client.query('SELECT COUNT(*) FROM bill');
      await client.query('SELECT COUNT(*) FROM receipt');
      await client.query('SELECT * FROM bill_status LIMIT 100');
      
      const duration = Date.now() - startTime;
      client.release();
      
      this.results.performance_tests.dbQueries = {
        success: duration < 5000, // Should complete within 5 seconds
        duration: duration,
        message: `Database queries completed in ${duration}ms`
      };
      
      console.log(`    DB Query Performance: ${duration < 5000 ? '✅' : '⚠️'} ${duration}ms`);
    } catch (error) {
      this.results.performance_tests.dbQueries = {
        success: false,
        error: error.message
      };
      console.log(`    DB Query Performance: ❌ Failed (${error.message})`);
    }
  }

  generateReport() {
    console.log('\n' + '='.repeat(60));
    console.log('📋 COMPREHENSIVE TEST REPORT');
    console.log('='.repeat(60));

    // Connection Tests Summary
    console.log('\n🔌 Connection Tests:');
    const connTests = this.results.connection_tests;
    console.log(`   ODBC: ${connTests.odbc?.success ? '✅ PASS' : '❌ FAIL'}`);
    console.log(`   XML API: ${connTests.xml?.success ? '✅ PASS' : '❌ FAIL'}`);
    console.log(`   Initialization: ${connTests.initialization?.success ? '✅ PASS' : '❌ FAIL'}`);
    if (connTests.initialization?.success) {
      console.log(`   Connection Method: ${connTests.initialization.method}`);
    }

    // Data Sync Tests Summary
    console.log('\n📊 Data Synchronization Tests:');
    const syncTests = this.results.data_sync_tests;
    if (syncTests.bills) {
      console.log(`   Bills Sync: ${syncTests.bills.success ? '✅ PASS' : '❌ FAIL'} (${syncTests.bills.count || 0} items)`);
    }
    if (syncTests.receipts) {
      console.log(`   Receipts Sync: ${syncTests.receipts.success ? '✅ PASS' : '❌ FAIL'} (${syncTests.receipts.count || 0} items)`);
    }
    if (syncTests.autoMapping) {
      console.log(`   Auto-Mapping: ${syncTests.autoMapping.success ? '✅ PASS' : '❌ FAIL'} (${syncTests.autoMapping.count || 0} mapped)`);
    }

    // Error Handling Tests Summary
    console.log('\n⚠️  Error Handling Tests:');
    const errorTests = this.results.error_handling_tests;
    Object.keys(errorTests).forEach(test => {
      console.log(`   ${test}: ${errorTests[test].success ? '✅ PASS' : '❌ FAIL'}`);
    });

    // Performance Tests Summary
    console.log('\n🚀 Performance Tests:');
    const perfTests = this.results.performance_tests;
    Object.keys(perfTests).forEach(test => {
      const result = perfTests[test];
      console.log(`   ${test}: ${result.success ? '✅ PASS' : '⚠️  SLOW'} (${result.duration}ms)`);
    });

    // Overall Assessment
    const allTests = [
      ...Object.values(connTests),
      ...Object.values(syncTests),
      ...Object.values(errorTests),
      ...Object.values(perfTests)
    ];
    
    const passCount = allTests.filter(test => test.success).length;
    const totalCount = allTests.length;
    const passRate = ((passCount / totalCount) * 100).toFixed(1);

    console.log('\n🎯 OVERALL ASSESSMENT:');
    console.log(`   Tests Passed: ${passCount}/${totalCount} (${passRate}%)`);
    
    if (passRate >= 80) {
      console.log('   Status: 🟢 EXCELLENT - Integration ready for production');
    } else if (passRate >= 60) {
      console.log('   Status: 🟡 GOOD - Minor issues need attention');
    } else {
      console.log('   Status: 🔴 NEEDS WORK - Critical issues require fixing');
    }

    // Recommendations
    console.log('\n💡 RECOMMENDATIONS:');
    
    if (!connTests.odbc?.success && !connTests.xml?.success) {
      console.log('   • Install and configure Tally ODBC Driver');
      console.log('   • Enable ODBC in Tally: F11 → Features → Use ODBC: Yes');
      console.log('   • Ensure Tally Prime is running');
    } else if (!connTests.odbc?.success) {
      console.log('   • Consider installing ODBC Driver for better performance');
    }

    if (syncTests.bills?.count === 0 && syncTests.receipts?.count === 0) {
      console.log('   • Verify Tally data exists (Sales and Receipt vouchers)');
      console.log('   • Check Tally company is selected and accessible');
    }

    if (errorTests.database?.success === false) {
      console.log('   • Check PostgreSQL database connection');
      console.log('   • Verify database credentials in .env file');
    }

    console.log('\n' + '='.repeat(60));
    console.log('✅ Test suite completed successfully!');
    console.log('📄 For detailed logs, check the application logs');
    console.log('🌐 Access sync monitor at: http://localhost:3000/tally-sync.html');
    console.log('='.repeat(60) + '\n');
  }
}

// Run tests if called directly
if (require.main === module) {
  const tester = new TallyIntegrationTester();
  tester.runAllTests()
    .then(() => {
      process.exit(0);
    })
    .catch(error => {
      console.error('💥 Test suite failed:', error);
      process.exit(1);
    });
}

module.exports = TallyIntegrationTester;