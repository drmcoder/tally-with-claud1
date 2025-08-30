# Tally Dashboard

A comprehensive Node.js application for integrating with Tally Prime, providing cashier operations, dispatch management, and administrative oversight.

## Architecture Overview

- **Data Source**: Tally Prime via TDBC/ODBC (Pending Sales Bills, Receipts, Credit Notes)
- **ETL Service**: Windows service that pulls data every 60 seconds into PostgreSQL
- **Applications**: Cashier App, Dispatch Terminal, Gate Log, Admin Dashboard
- **Database**: PostgreSQL with comprehensive business logic
- **Security**: Role-based access, Manager PIN approvals, session management

## Quick Start

1. **Prerequisites**
   ```bash
   # Install Node.js 18+ and PostgreSQL 14+
   # Set up Tally Prime with ODBC connectivity
   ```

2. **Installation**
   ```bash
   npm install
   cp .env.example .env
   # Edit .env with your database and Tally configuration
   ```

3. **Database Setup**
   ```bash
   # Create PostgreSQL database manually
   createdb tally_dashboard
   
   # Run migrations
   npm run migrate
   ```

4. **Start Application**
   ```bash
   # Development mode
   npm run dev
   
   # Production mode
   npm start
   ```

5. **Default Login**
   - Username: `admin`
   - Password: `admin123`

## API Endpoints

### Authentication
- `POST /api/auth/login` - User login
- `GET /api/auth/me` - Get current user
- `POST /api/auth/change-password` - Change password

### Bills
- `GET /api/bills` - List bills with filters
- `GET /api/bills/:bill_no` - Get bill details
- `GET /api/bills/dashboard/summary` - Dashboard summary

### Cashier Operations
- `POST /api/cashier/payment-hint` - Create payment form
- `POST /api/cashier/session/open` - Open cashier session
- `GET /api/cashier/session/current` - Get current session
- `POST /api/cashier/session/petty-cash` - Add petty cash entry
- `POST /api/cashier/session/till-adjust` - Add till adjustment
- `POST /api/cashier/session/:id/close` - Close session

## Environment Variables

```env
# Database
DB_HOST=localhost
DB_PORT=5432
DB_NAME=tally_dashboard
DB_USER=postgres
DB_PASS=password

# Tally ODBC
TALLY_DSN=TallyPrime
TALLY_HOST=localhost
TALLY_PORT=9000

# Security
JWT_SECRET=your-super-secret-key
BCRYPT_ROUNDS=12

# Application
PORT=3000
NODE_ENV=development
```

## Business Rules

1. **Payment Status**: Bills are automatically marked as PAID/PART-PAID/DUE based on receipt matching
2. **Release Control**: Bills cannot be released without active cashier session
3. **Manager Approval**: Outstanding dues require Manager PIN or customer OTP
4. **Unique Releases**: Each bill can only be released once (database enforced)
5. **Session Management**: Cash variance above threshold requires approval
6. **Receipt Mapping**: Auto-maps receipts to bills using FIFO logic by party and date

## Database Schema

Key tables:
- `bill` - Bills from Tally
- `receipt` - Receipts from Tally
- `payment_hint` - Cashier payment forms
- `cashier_session` - Session management
- `release_self` / `release_transporter` - Dispatch records
- `gate_log` - Security gate entries

Views:
- `bill_status` - Real-time payment status
- `release_status` - Release tracking

## ETL Process

The ETL service runs every 60 seconds:
1. Pulls new bills from Tally (Pending Sales Bills)
2. Pulls receipts with payment mode detection
3. Auto-maps receipts to bills using reference or FIFO logic
4. Updates PostgreSQL with upsert logic

## Testing

```bash
npm test
```

## Deployment

1. Set up PostgreSQL database
2. Configure Tally Prime ODBC connection
3. Set production environment variables
4. Run database migrations
5. Start application with PM2 or similar process manager

## License

Private - Internal Use Only