require('dotenv').config();
const db = require('../config/db');

async function truncateDatabase() {
  console.log('\n======================================================');
  console.log('🧹 SHAZU SOFT CMT — DATABASE TRUNCATE / WIPE');
  console.log('======================================================\n');

  const client = await db.getClient();

  try {
    console.log('1. Truncating all database tables and restarting identity sequences...');

    await client.query(`
      TRUNCATE TABLE 
        audit_logs,
        email_logs,
        announcements,
        conflicts,
        paper_decisions,
        reviews,
        reviewer_assignments,
        conference_reviewers,
        conference_chairs,
        submission_files,
        submission_authors,
        submissions,
        tracks,
        conferences,
        users
      RESTART IDENTITY CASCADE;
    `);

    console.log('✅ All tables successfully truncated and ID sequences reset to 1!');
  } catch (err) {
    console.error('❌ Truncate failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await db.pool.end();
  }
}

if (require.main === module) {
  truncateDatabase();
}

module.exports = truncateDatabase;
