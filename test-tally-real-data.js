// Test Real Tally Data Extraction
const axios = require('axios');

async function testRealTallyData() {
  console.log('🔍 Testing Real Tally Data Extraction...\n');
  
  const tallyURL = 'http://localhost:9000';
  
  // More comprehensive queries that should work with most Tally versions
  const testQueries = [
    {
      name: 'All Vouchers (Broad Search)',
      xml: `<ENVELOPE>
        <HEADER>
          <VERSION>1</VERSION>
          <TALLYREQUEST>Export</TALLYREQUEST>
          <TYPE>Data</TYPE>
          <ID>All Vouchers</ID>
        </HEADER>
        <BODY>
          <EXPORTDATA>
            <REQUESTDESC>
              <REPORTNAME>All Vouchers</REPORTNAME>
              <STATICVARIABLES>
                <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
              </STATICVARIABLES>
            </REQUESTDESC>
          </EXPORTDATA>
        </BODY>
      </ENVELOPE>`
    },
    {
      name: 'Voucher Register Export',
      xml: `<ENVELOPE>
        <HEADER>
          <VERSION>1</VERSION>
          <TALLYREQUEST>Export</TALLYREQUEST>
          <TYPE>Data</TYPE>
          <ID>VoucherRegister</ID>
        </HEADER>
        <BODY>
          <EXPORTDATA>
            <REQUESTDESC>
              <REPORTNAME>Voucher Register</REPORTNAME>
              <STATICVARIABLES>
                <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
                <SVFROMDATE>1-Apr-2024</SVFROMDATE>
                <SVTODATE>31-Mar-2025</SVTODATE>
              </STATICVARIABLES>
            </REQUESTDESC>
          </EXPORTDATA>
        </BODY>
      </ENVELOPE>`
    },
    {
      name: 'Day Book Report',
      xml: `<ENVELOPE>
        <HEADER>
          <VERSION>1</VERSION>
          <TALLYREQUEST>Export</TALLYREQUEST>
          <TYPE>Data</TYPE>
          <ID>DayBook</ID>
        </HEADER>
        <BODY>
          <EXPORTDATA>
            <REQUESTDESC>
              <REPORTNAME>Day Book</REPORTNAME>
              <STATICVARIABLES>
                <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
                <SVFROMDATE>1-Jan-2024</SVFROMDATE>
                <SVTODATE>31-Dec-2025</SVTODATE>
              </STATICVARIABLES>
            </REQUESTDESC>
          </EXPORTDATA>
        </BODY>
      </ENVELOPE>`
    },
    {
      name: 'Simple Voucher Query',
      xml: `<ENVELOPE>
        <HEADER>
          <TALLYREQUEST>Export</TALLYREQUEST>
          <TYPE>Collection</TYPE>
          <ID>Simple Vouchers</ID>
        </HEADER>
        <BODY>
          <DESC>
            <TDL>
              <TDLMESSAGE>
                <COLLECTION NAME="Simple Vouchers">
                  <TYPE>Voucher</TYPE>
                  <FETCH>*</FETCH>
                </COLLECTION>
              </TDLMESSAGE>
            </TDL>
          </DESC>
        </BODY>
      </ENVELOPE>`
    }
  ];
  
  for (const query of testQueries) {
    try {
      console.log(`\n📊 Testing: ${query.name}`);
      console.log('='.repeat(50));
      
      const response = await axios.post(tallyURL, query.xml, {
        headers: {
          'Content-Type': 'application/xml',
          'Accept': 'application/xml'
        },
        timeout: 15000
      });
      
      console.log('✅ Query successful!');
      console.log(`📏 Response size: ${response.data.length} characters`);
      
      // Show first part of response
      let preview = response.data.substring(0, 1000);
      console.log('📄 Response preview:');
      console.log(preview + (response.data.length > 1000 ? '\n... [TRUNCATED]' : ''));
      
      // Count different types of data
      const voucherCount = (response.data.match(/<VOUCHER[^>]*>/g) || []).length;
      const tallyMessageCount = (response.data.match(/<TALLYMESSAGE[^>]*>/g) || []).length;
      const dsptotalCount = (response.data.match(/<DSPTOTAL[^>]*>/g) || []).length;
      const dspacctnameCount = (response.data.match(/<DSPACCNAME[^>]*>/g) || []).length;
      
      console.log(`\n📈 Found: ${voucherCount} vouchers, ${tallyMessageCount} tally messages, ${dsptotalCount} totals, ${dspacctnameCount} account names`);
      
      // Look for actual data patterns
      if (response.data.includes('VOUCHER') || response.data.includes('TALLYMESSAGE')) {
        console.log('🎉 Found voucher data structure!');
        
        // Extract some sample field names
        const fieldMatches = response.data.match(/<[A-Z]+[^>]*>[^<]+<\/[A-Z]+>/g) || [];
        const sampleFields = fieldMatches.slice(0, 10).map(match => {
          const tag = match.match(/<([A-Z]+)[^>]*>/);
          const value = match.replace(/<[^>]+>/g, '');
          return `${tag ? tag[1] : 'UNKNOWN'}: ${value.substring(0, 50)}${value.length > 50 ? '...' : ''}`;
        });
        
        if (sampleFields.length > 0) {
          console.log('🔍 Sample fields found:');
          sampleFields.forEach(field => console.log(`  - ${field}`));
        }
      }
      
      // If we found substantial data, return it
      if (response.data.length > 500 && (voucherCount > 0 || tallyMessageCount > 0)) {
        console.log(`\n✅ SUCCESS! Found ${response.data.length} chars of data with ${voucherCount + tallyMessageCount} data items`);
        return {
          success: true,
          query: query.name,
          xml: query.xml,
          data: response.data,
          vouchers: voucherCount,
          messages: tallyMessageCount
        };
      }
      
    } catch (error) {
      console.log(`❌ ${query.name} failed:`, error.message);
    }
  }
  
  return false;
}

// Run the test
testRealTallyData()
  .then(result => {
    if (result) {
      console.log('\n🎉 SUCCESS! Found real Tally data!');
      console.log(`📝 Working query: ${result.query}`);
      console.log(`📊 Data items: ${result.vouchers + result.messages}`);
      console.log('\n🔧 Next step: Update ETL service to use this query structure');
    } else {
      console.log('\n❌ No voucher data found in any query.');
      console.log('\n🎯 SOLUTIONS:');
      console.log('1. Create some sales invoices in Tally Prime');
      console.log('2. Ensure company is loaded and has data');
      console.log('3. Check if Tally Prime has different XML API structure');
      console.log('4. Try Tally Export functionality instead');
    }
    process.exit(result ? 0 : 1);
  })
  .catch(error => {
    console.error('💥 Test failed:', error.message);
    process.exit(1);
  });