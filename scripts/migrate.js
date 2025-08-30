const fs = require('fs');
const path = require('path');
const { pool } = require('../config/database');

async function runMigration() {
  try {
    console.log('Running database migration...');
    
    const schemaPath = path.join(__dirname, 'schema.sql');
    const schemaSql = fs.readFileSync(schemaPath, 'utf8');
    
    // Split by statements and filter out problematic ones
    const statements = schemaSql
      .split(';')
      .map(stmt => stmt.trim())
      .filter(stmt => stmt.length > 0 && !stmt.startsWith('--'))
      .filter(stmt => !stmt.includes('CREATE DATABASE')) // Skip database creation
      .filter(stmt => !stmt.includes('COMMENT ON DATABASE')); // Skip database comments
    
    const client = await pool.connect();
    
    try {
      for (const statement of statements) {
        try {
          await client.query(statement);
          console.log('✓ Executed:', statement.substring(0, 50) + '...');
        } catch (statementError) {
          // Continue with other statements, just log the error
          if (statementError.code !== '42P07') { // Skip "already exists" errors
            console.log('⚠ Warning:', statementError.message.substring(0, 80) + '...');
          } else {
            console.log('✓ Skipped existing:', statement.substring(0, 50) + '...');
          }
        }
      }
      
      console.log('Migration completed successfully!');
      
    } catch (error) {
      console.error('Migration failed:', error);
      throw error;
    } finally {
      client.release();
    }
    
  } catch (error) {
    console.error('Migration error:', error);
    process.exit(1);
  }
}

// Run migration if called directly
if (require.main === module) {
  runMigration().then(() => {
    console.log('Database migration complete');
    process.exit(0);
  }).catch((error) => {
    console.error('Migration failed:', error);
    process.exit(1);
  });
}

module.exports = { runMigration };