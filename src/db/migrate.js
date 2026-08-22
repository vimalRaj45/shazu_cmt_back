const fs = require('fs');
const path = require('path');
const db = require('../config/db');

async function migrate() {
  console.log('--- Starting Database Migration for Shazu Soft CMT ---');
  try {
    const schemaSql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8');
    await db.query(schemaSql);

    // Update existing user roles if chair or participant exist
    await db.query(`
      UPDATE users SET role = 'admin' WHERE role = 'chair';
      UPDATE users SET role = 'author' WHERE role = 'participant';
    `);

    // Safely add rebuttal_notes column to submissions table if not exists
    try {
      await db.query(`ALTER TABLE submissions ADD COLUMN IF NOT EXISTS rebuttal_notes TEXT;`);
    } catch (colErr) {
      console.log('Column notice:', colErr.message);
    }

    // Safely add 9-question review columns to reviews table
    try {
      await db.query(`
        ALTER TABLE reviews ADD COLUMN IF NOT EXISTS q_relevance VARCHAR(100);
        ALTER TABLE reviews ADD COLUMN IF NOT EXISTS q_structure VARCHAR(100);
        ALTER TABLE reviews ADD COLUMN IF NOT EXISTS q_language VARCHAR(100);
        ALTER TABLE reviews ADD COLUMN IF NOT EXISTS q_figures_tables VARCHAR(100);
        ALTER TABLE reviews ADD COLUMN IF NOT EXISTS q_discussion_conclusions VARCHAR(100);
        ALTER TABLE reviews ADD COLUMN IF NOT EXISTS q_references_cited VARCHAR(100);
        ALTER TABLE reviews ADD COLUMN IF NOT EXISTS q_comments_authors TEXT;
        ALTER TABLE reviews ADD COLUMN IF NOT EXISTS q_special_comments_editor TEXT;
        ALTER TABLE reviews ADD COLUMN IF NOT EXISTS q_reviewer_decision VARCHAR(100);
      `);
    } catch (reviewColErr) {
      console.log('Review columns notice:', reviewColErr.message);
    }

    // Safely update check constraint for 3 roles: admin, reviewer, author
    try {
      await db.query(`
        ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
        ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin', 'reviewer', 'author'));
      `);
    } catch (constraintErr) {
      console.log('Constraint notice:', constraintErr.message);
    }

    console.log('✅ Database tables, 3-role constraints, and indices successfully created/verified!');
  } catch (err) {
    console.error('❌ Migration failed:', err);
    process.exit(1);
  } finally {
    await db.pool.end();
  }
}

if (require.main === module) {
  migrate();
}

module.exports = migrate;
