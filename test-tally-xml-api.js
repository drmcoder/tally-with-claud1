// Test Tally Prime XML API Connection
const axios = require('axios');

async function testTallyXMLAPI() {
  console.log('🔌 Testing Tally Prime XML API Connection...\n');
  
  const tallyURL = 'http://localhost:9000';
  
  // Test basic connection
  try {
    console.log('📡 Testing basic connection to Tally...');
    const response = await axios.get(tallyURL, { timeout: 5000 });
    console.log('✅ Basic connection successful!');
    console.log('📄 Response:', response.data);
  } catch (error) {
    console.log('❌ Basic connection failed:', error.message);
    return false;
  }
  
  // Test XML requests for company list
  const xmlRequests = [
    {
      name: 'Get Company List',
      xml: `<ENVELOPE>
        <HEADER>
          <VERSION>1</VERSION>
          <TALLYREQUEST>Export</TALLYREQUEST>
          <TYPE>Collection</TYPE>
          <ID>List of Companies</ID>
        </HEADER>
        <BODY>
          <DESC>
            <STATICVARIABLES>
              <EXPLODEFLAG>Yes</EXPLODEFLAG>
            </STATICVARIABLES>
            <TDL>
              <TDLMESSAGE>
                <COLLECTION NAME="List of Companies">
                  <TYPE>Company</TYPE>
                  <CHILDOF>$$Owner</CHILDOF>
                  <FETCH>$Name</FETCH>
                </COLLECTION>
              </TDLMESSAGE>
            </TDL>
          </DESC>
        </BODY>
      </ENVELOPE>`
    },
    {
      name: 'Get Ledger List',
      xml: `<ENVELOPE>
        <HEADER>
          <VERSION>1</VERSION>
          <TALLYREQUEST>Export</TALLYREQUEST>
          <TYPE>Collection</TYPE>
          <ID>Ledger List</ID>
        </HEADER>
        <BODY>
          <DESC>
            <STATICVARIABLES>
              <EXPLODEFLAG>Yes</EXPLODEFLAG>
            </STATICVARIABLES>
            <TDL>
              <TDLMESSAGE>
                <COLLECTION NAME="Ledger List">
                  <TYPE>Ledger</TYPE>
                  <FETCH>$Name, $Parent</FETCH>
                </COLLECTION>
              </TDLMESSAGE>
            </TDL>
          </DESC>
        </BODY>
      </ENVELOPE>`
    },
    {
      name: 'Get Vouchers (Bills)',
      xml: `<ENVELOPE>
        <HEADER>
          <VERSION>1</VERSION>
          <TALLYREQUEST>Export</TALLYREQUEST>
          <TYPE>Collection</TYPE>
          <ID>Sales Vouchers</ID>
        </HEADER>
        <BODY>
          <DESC>
            <STATICVARIABLES>
              <EXPLODEFLAG>Yes</EXPLODEFLAG>
            </STATICVARIABLES>
            <TDL>
              <TDLMESSAGE>
                <COLLECTION NAME="Sales Vouchers">
                  <TYPE>Voucher</TYPE>
                  <FETCH>$VoucherNumber, $Date, $PartyLedgerName, $Amount</FETCH>
                  <FILTER>VoucherFilter</FILTER>
                </COLLECTION>
                <SYSTEM TYPE="Formulae" NAME="VoucherFilter">$VoucherTypeName = "Sales"</SYSTEM>
              </TDLMESSAGE>
            </TDL>
          </DESC>
        </BODY>
      </ENVELOPE>`
    }
  ];
  
  for (const request of xmlRequests) {
    try {
      console.log(`\n📊 Testing: ${request.name}`);
      
      const response = await axios.post(tallyURL, request.xml, {
        headers: {
          'Content-Type': 'application/xml',
          'Accept': 'application/xml'
        },
        timeout: 10000
      });
      
      console.log('✅ XML Request successful!');
      console.log('📄 Response preview:', response.data.substring(0, 500) + '...');
      
      // Try to extract useful information
      if (response.data.includes('<VOUCHER>') || response.data.includes('<LEDGER>') || response.data.includes('<COMPANY>')) {
        console.log('🎉 Found Tally data structure!');
        
        // Count items
        const voucherCount = (response.data.match(/<VOUCHER>/g) || []).length;
        const ledgerCount = (response.data.match(/<LEDGER>/g) || []).length;
        const companyCount = (response.data.match(/<COMPANY>/g) || []).length;
        
        console.log(`📈 Data found: ${voucherCount} vouchers, ${ledgerCount} ledgers, ${companyCount} companies`);
        
        return {
          success: true,
          method: 'XML API',
          url: tallyURL,
          dataTypes: { vouchers: voucherCount, ledgers: ledgerCount, companies: companyCount }
        };
      }
      
    } catch (error) {
      console.log(`❌ ${request.name} failed:`, error.message);
    }
  }
  
  return false;
}

// Run the test
testTallyXMLAPI()
  .then(result => {
    if (result) {
      console.log('\n🎉 Tally XML API is working!');
      console.log('📝 Connection method:', result.method);
      console.log('🔗 URL:', result.url);
      console.log('📊 Available data:', result.dataTypes);
      console.log('\n✅ Ready to implement XML-based Tally integration!');
    } else {
      console.log('\n❌ XML API connection failed.');
      console.log('🔧 Please check if Tally Prime is running and ODBC/API is enabled.');
    }
    process.exit(result ? 0 : 1);
  })
  .catch(error => {
    console.error('💥 Test failed:', error.message);
    process.exit(1);
  });