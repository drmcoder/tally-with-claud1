// Diagnose Tally Data Structure
const axios = require('axios');

async function diagnoseTallyData() {
  console.log('🔍 Diagnosing Tally Prime Data Structure...\n');
  
  const tallyURL = 'http://localhost:9000';
  
  // Test different queries to see what's available
  const testQueries = [
    {
      name: 'Company Information',
      xml: `<ENVELOPE>
        <HEADER>
          <VERSION>1</VERSION>
          <TALLYREQUEST>Export</TALLYREQUEST>
          <TYPE>Collection</TYPE>
          <ID>Company Info</ID>
        </HEADER>
        <BODY>
          <DESC>
            <STATICVARIABLES>
              <EXPLODEFLAG>Yes</EXPLODEFLAG>
            </STATICVARIABLES>
            <TDL>
              <TDLMESSAGE>
                <COLLECTION NAME="Company Info">
                  <TYPE>Company</TYPE>
                  <CHILDOF>$$Owner</CHILDOF>
                  <FETCH>$Name, $StartDate, $EndDate</FETCH>
                </COLLECTION>
              </TDLMESSAGE>
            </TDL>
          </DESC>
        </BODY>
      </ENVELOPE>`
    },
    {
      name: 'Voucher Types Available',
      xml: `<ENVELOPE>
        <HEADER>
          <VERSION>1</VERSION>
          <TALLYREQUEST>Export</TALLYREQUEST>
          <TYPE>Collection</TYPE>
          <ID>Voucher Types</ID>
        </HEADER>
        <BODY>
          <DESC>
            <STATICVARIABLES>
              <EXPLODEFLAG>Yes</EXPLODEFLAG>
            </STATICVARIABLES>
            <TDL>
              <TDLMESSAGE>
                <COLLECTION NAME="Voucher Types">
                  <TYPE>VoucherType</TYPE>
                  <FETCH>$Name, $Parent, $NumberingMethod</FETCH>
                </COLLECTION>
              </TDLMESSAGE>
            </TDL>
          </DESC>
        </BODY>
      </ENVELOPE>`
    },
    {
      name: 'All Vouchers (Any Type)',
      xml: `<ENVELOPE>
        <HEADER>
          <VERSION>1</VERSION>
          <TALLYREQUEST>Export</TALLYREQUEST>
          <TYPE>Collection</TYPE>
          <ID>All Vouchers</ID>
        </HEADER>
        <BODY>
          <DESC>
            <STATICVARIABLES>
              <EXPLODEFLAG>Yes</EXPLODEFLAG>
            </STATICVARIABLES>
            <TDL>
              <TDLMESSAGE>
                <COLLECTION NAME="All Vouchers">
                  <TYPE>Voucher</TYPE>
                  <FETCH>$VoucherTypeName, $VoucherNumber, $Date, $PartyLedgerName, $Amount</FETCH>
                  <FILTER>RecentFilter</FILTER>
                </COLLECTION>
                <SYSTEM TYPE="Formulae" NAME="RecentFilter">$Date >= @@CmpBkFrom</SYSTEM>
              </TDLMESSAGE>
            </TDL>
          </DESC>
        </BODY>
      </ENVELOPE>`
    },
    {
      name: 'Ledgers List',
      xml: `<ENVELOPE>
        <HEADER>
          <VERSION>1</VERSION>
          <TALLYREQUEST>Export</TALLYREQUEST>
          <TYPE>Collection</TYPE>
          <ID>Ledgers</ID>
        </HEADER>
        <BODY>
          <DESC>
            <STATICVARIABLES>
              <EXPLODEFLAG>Yes</EXPLODEFLAG>
            </STATICVARIABLES>
            <TDL>
              <TDLMESSAGE>
                <COLLECTION NAME="Ledgers">
                  <TYPE>Ledger</TYPE>
                  <FETCH>$Name, $Parent, $ClosingBalance</FETCH>
                  <FILTER>NonZeroFilter</FILTER>
                </COLLECTION>
                <SYSTEM TYPE="Formulae" NAME="NonZeroFilter">$ClosingBalance &lt;&gt; 0</SYSTEM>
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
      
      // Clean up and display the response
      let cleanData = response.data
        .replace(/<ENVELOPE>.*?<BODY>/gs, '')
        .replace(/<\/BODY>.*?<\/ENVELOPE>/gs, '')
        .replace(/^\s*<.*?>\s*$/gm, '')
        .replace(/\n\s*\n/g, '\n')
        .trim();
      
      if (cleanData.length > 2000) {
        cleanData = cleanData.substring(0, 2000) + '\n... [TRUNCATED]';
      }
      
      console.log('📄 Data Structure:');
      console.log(cleanData);
      
      // Count different types of data
      const voucherCount = (response.data.match(/<VOUCHER>/g) || []).length;
      const ledgerCount = (response.data.match(/<LEDGER>/g) || []).length;
      const companyCount = (response.data.match(/<COMPANY>/g) || []).length;
      const voucherTypeCount = (response.data.match(/<VOUCHERTYPE>/g) || []).length;
      
      console.log(`\n📈 Found: ${voucherCount} vouchers, ${ledgerCount} ledgers, ${companyCount} companies, ${voucherTypeCount} voucher types`);
      
      // Extract voucher types if available
      if (query.name === 'Voucher Types Available') {
        const voucherTypeNames = [];
        const typeMatches = response.data.match(/<NAME[^>]*>(.*?)<\/NAME>/g) || [];
        typeMatches.forEach(match => {
          const name = match.replace(/<\/?NAME[^>]*>/g, '').trim();
          if (name && !voucherTypeNames.includes(name)) {
            voucherTypeNames.push(name);
          }
        });
        console.log('🎯 Available Voucher Types:', voucherTypeNames.join(', '));
      }
      
      // Extract voucher details if available
      if (query.name === 'All Vouchers (Any Type)' && voucherCount > 0) {
        console.log('\n🎯 Sample Voucher Details:');
        const sampleVoucher = response.data.match(/<VOUCHER>(.*?)<\/VOUCHER>/s);
        if (sampleVoucher) {
          const voucherData = sampleVoucher[1];
          console.log(voucherData.substring(0, 500) + (voucherData.length > 500 ? '...' : ''));
        }
      }
      
    } catch (error) {
      console.log(`❌ ${query.name} failed:`, error.message);
    }
  }
  
  console.log('\n🎯 RECOMMENDATIONS:');
  console.log('1. Check the voucher types found above');
  console.log('2. Look for sales-related voucher types');
  console.log('3. Update the ETL service to use the correct voucher type names');
  console.log('4. If no vouchers found, create some test data in Tally first');
}

// Run the diagnosis
diagnoseTallyData()
  .then(() => {
    console.log('\n✅ Tally data diagnosis complete!');
    process.exit(0);
  })
  .catch(error => {
    console.error('💥 Diagnosis failed:', error.message);
    process.exit(1);
  });