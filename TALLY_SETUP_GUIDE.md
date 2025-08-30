# 🔌 Connect Tally Prime to Dashboard - Complete Setup Guide

## 📋 Prerequisites
- Tally Prime installed and running
- Company data loaded in Tally Prime
- Windows with ODBC support

---

## 🔧 Step 1: Enable Tally ODBC Connection

### In Tally Prime:

1. **Open your Company** in Tally Prime
2. Press **F11** (Company Features)
3. Navigate: **Gateway** → **F11: Features** → **Company Features**
4. Set the following options:

```
Company Features → Data Configuration:
- Use ODBC: Yes
- ODBC Server Port: 9000 (or your preferred port)
- Allow ODBC Connection: Yes
- ODBC Password: [Set if required]
```

5. **Save** (Ctrl+A) and **restart Tally Prime**

---

## 🔧 Step 2: Configure ODBC Data Source

### Method A: Using Windows ODBC Data Source Administrator

1. Open **Control Panel** → **Administrative Tools** → **ODBC Data Sources (64-bit)**
2. Go to **System DSN** tab
3. Click **Add**
4. Select **"Tally ODBC Driver"** (if available) or **"SQL Server"**
5. Configure:
   ```
   Data Source Name: TallyPrime
   Server: localhost
   Port: 9000
   Database: (leave blank or use company name)
   ```
6. Test connection and save

### Method B: Direct Connection String (Recommended)
The dashboard will use this connection string:
```
Driver={Tally ODBC Driver};Server=localhost;Port=9000;
```

---

## 🔧 Step 3: Test Tally Connection

### 1. Verify Tally ODBC is Running
- Open Tally Prime with your company
- Go to **Gateway** → **Display** → **Company Info**
- Check that "ODBC Server" shows as "Active"

### 2. Test from Dashboard
- Open your dashboard: http://localhost:3006
- Login as admin
- Use API endpoint to check ETL status:

```bash
curl "http://localhost:3006/api/admin/etl/status" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

---

## 🔧 Step 4: Alternative Connection Methods

### If ODBC doesn't work, try these connection strings in .env:

```env
# Method 1: Direct Tally ODBC
TALLY_DSN=Driver={Tally ODBC Driver};Server=localhost;Port=9000;

# Method 2: System DSN
TALLY_DSN=DSN=TallyPrime

# Method 3: SQL Server Driver (if Tally uses SQL Server backend)
TALLY_DSN=Driver={SQL Server};Server=localhost,9000;

# Method 4: TCP/IP Connection
TALLY_DSN=Driver={Tally ODBC Driver};Server=127.0.0.1;Port=9000;Protocol=TCP;
```

---

## 🔧 Step 5: Troubleshooting

### Common Issues:

1. **"Data source name not found"**
   - Install Tally ODBC Driver
   - Create System DSN as described above
   - Try direct connection string instead

2. **"Connection refused"**
   - Ensure Tally Prime is running
   - Check ODBC is enabled in Tally (F11 → Features)
   - Verify port 9000 is not blocked by firewall

3. **"Driver not found"**
   - Download and install Tally ODBC Driver from Tally website
   - Or use SQL Server ODBC driver if Tally supports it

4. **"Authentication failed"**
   - Set ODBC password in Tally if required
   - Add credentials to connection string

### Testing Commands:

```bash
# Test ETL manually
curl -X POST "http://localhost:3006/api/admin/etl/trigger" \
  -H "Authorization: Bearer YOUR_TOKEN"

# Check connection status
curl "http://localhost:3006/api/admin/etl/status" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

---

## 🎯 Expected Results

After successful setup, you should see:
- ✅ ETL service connecting to Tally every minute
- ✅ Real bills data appearing in dashboard
- ✅ Automatic synchronization of vouchers and receipts
- ✅ Live updates in dashboard without demo data

---

## 📞 Need Help?

If you're still seeing demo data, it means the connection isn't established yet. 

**Check the server logs** for specific error messages:
- Look for ETL connection attempts every minute
- Check for specific ODBC error messages
- Verify Tally Prime is running with ODBC enabled

**Most Common Solution:**
1. Ensure Tally Prime is running
2. Enable ODBC in Tally (F11 → Features → Use ODBC: Yes)
3. Restart both Tally and the Dashboard server