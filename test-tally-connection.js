// Test Tally ODBC Connection
const odbc = require('odbc');
require('dotenv').config();

async function testTallyConnection() {
  console.log('🔌 Testing Tally Prime ODBC Connection...\n');
  
  // Try multiple connection strings for Tally Prime ODBC
  const connectionStrings = [
    'DRIVER={Tally 9.0 ODBC Driver};SERVER=localhost;PORT=9000;',
    'DRIVER={Tally ODBC Driver};SERVER=localhost;PORT=9000;',
    'DSN=TallyPrime;',
    'DRIVER={SQL Server};SERVER=localhost,9000;',
    'Provider=SQLOLEDB;Server=localhost,9000;',
    // HTTP-based connection attempts
    'http://localhost:9000',
    'localhost:9000'
  ];

  for (let i = 0; i < connectionStrings.length; i++) {
    const connectionString = connectionStrings[i];
    console.log(`\n🔍 Attempt ${i + 1}: ${connectionString}`);
    
    try {
      const connection = await odbc.connect(connectionString);
      console.log('✅ Connection successful!');
      
      // Try to query some basic info
      try {
        console.log('📊 Testing data query...');
        
        // Try different table names that Tally might use
        const testQueries = [
          'SELECT TOP 5 $NAME FROM LEDGER',
          'SELECT TOP 5 $BILLNUMBER FROM VOUCHER',
          'SHOW TABLES',
          'SELECT 1 as test'
        ];
        
        for (const query of testQueries) {
          try {
            console.log(`   Trying: ${query}`);
            const result = await connection.query(query);
            console.log(`   ✅ Query successful! Rows: ${result.length}`);
            if (result.length > 0) {
              console.log(`   📋 Sample data:`, result[0]);
            }
            break; // If we get here, we have a working query
          } catch (queryError) {
            console.log(`   ❌ Query failed: ${queryError.message.substring(0, 100)}`);
          }
        }
      } catch (queryError) {
        console.log('⚠️  Connected but cannot query data:', queryError.message);
      }
      
      await connection.close();
      console.log('✅ This connection string works! Update your .env file:');
      console.log(`TALLY_DSN=${connectionString}`);
      return true;
      
    } catch (error) {
      console.log('❌ Connection failed:', error.message);
    }
  }
  
  console.log('\n❌ All connection attempts failed.');
  console.log('\n🔧 Troubleshooting Steps:');
  console.log('1. Ensure Tally Prime is running');
  console.log('2. Enable ODBC in Tally: F11 → Features → Use ODBC: Yes');
  console.log('3. Check ODBC port (default: 9000)');
  console.log('4. Install Tally ODBC Driver if not available');
  console.log('5. Try creating a System DSN named "TallyPrime"');
  
  return false;
}

// Run the test
testTallyConnection()
  .then(success => {
    if (success) {
      console.log('\n🎉 Ready to sync live Tally data!');
    } else {
      console.log('\n🔧 Please follow the troubleshooting steps above.');
    }
    process.exit(success ? 0 : 1);
  })
  .catch(error => {
    console.error('💥 Test failed:', error);
    process.exit(1);
  });