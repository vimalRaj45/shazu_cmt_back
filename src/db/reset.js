require('dotenv').config();
const bcrypt = require('bcryptjs');
const db = require('../config/db');

async function resetDatabase() {
  console.log('\n======================================================');
  console.log('🔄 SHAZU SOFT CMT — COMPLETE DATABASE RESET & RE-SEED');
  console.log('======================================================\n');

  const client = await db.getClient();

  try {
    // 1. Truncate all tables
    console.log('1. Wiping existing tables and resetting sequences...');
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
    console.log('✅ Tables wiped and identity sequences reset to 1.');

    // 2. Seed Base Users (3 Roles: admin, reviewer, author)
    console.log('\n2. Seeding default 3-role demo users...');
    const passwordHash = await bcrypt.hash('password123', 10);

    const users = [
      {
        email: 'admin@shazusoft.com',
        first_name: 'System',
        last_name: 'Admin',
        institution: 'Shazu Soft Technologies',
        department: 'Operations & IT',
        country: 'India',
        role: 'admin',
        expertise: ['System Architecture', 'Cloud Infrastructure', 'Security'],
      },
      {
        email: 'reviewer1@shazusoft.com',
        first_name: 'Prof. Anita',
        last_name: 'Deshmukh',
        institution: 'Indian Institute of Technology',
        department: 'Computer Science & Engineering',
        country: 'India',
        role: 'reviewer',
        expertise: ['Machine Learning', 'Deep Learning', 'NLP'],
      },
      {
        email: 'reviewer2@shazusoft.com',
        first_name: 'Dr. Michael',
        last_name: 'Chen',
        institution: 'National University of Singapore',
        department: 'Information Systems',
        country: 'Singapore',
        role: 'reviewer',
        expertise: ['Cyber Security', 'Cryptography', 'Cloud Systems'],
      },
      {
        email: 'author@shazusoft.com',
        first_name: 'Vikram',
        last_name: 'Sharma',
        institution: 'Shazu Soft Innovations',
        department: 'Software Engineering',
        country: 'India',
        role: 'author',
        expertise: ['Natural Language Processing', 'Distributed Systems'],
      },
    ];

    const userMap = {};
    for (const u of users) {
      const uRes = await client.query(
        `INSERT INTO users (email, password_hash, first_name, last_name, institution, department, country, role, expertise_keywords)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id, email, role;`,
        [u.email, passwordHash, u.first_name, u.last_name, u.institution, u.department, u.country, u.role, u.expertise]
      );
      userMap[u.email] = uRes.rows[0].id;
    }
    console.log(`✅ Seeded ${Object.keys(userMap).length} base users (admin, reviewer, author)`);

    // 3. Seed Flagship Conference
    console.log('\n3. Seeding default conference...');
    const confRes = await client.query(
      `INSERT INTO conferences (
        name, short_name, description, venue, start_date, end_date,
        submission_deadline, review_deadline, decision_date, camera_ready_deadline,
        status, created_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING id, short_name;`,
      [
        'Shazu Soft International Conference on Advanced Computing & Intelligent Systems 2026',
        'SS-ACIS 2026',
        'Annual flagship conference hosted by Shazu Soft Technologies showcasing innovations in Artificial Intelligence, Cloud Infrastructure, and Software Engineering.',
        'Shazu Soft Tech Auditorium, Bangalore, India & Virtual Live Stream',
        '2026-11-15',
        '2026-11-17',
        '2026-09-30',
        '2026-10-20',
        '2026-10-31',
        '2026-11-08',
        'open',
        userMap['admin@shazusoft.com'],
      ]
    );
    const confId = confRes.rows[0].id;
    console.log(`✅ Seeded flagship conference: ${confRes.rows[0].short_name} (ID: ${confId})`);

    // 4. Seed Conference Tracks
    console.log('\n4. Seeding conference tracks...');
    const tracks = [
      { name: 'Track 1: Artificial Intelligence & Machine Learning', desc: 'Deep learning architectures, LLMs, NLP, and intelligent agents' },
      { name: 'Track 2: Cloud Computing & Distributed Systems', desc: 'Serverless architectures, microservices, edge computing, high availability' },
      { name: 'Track 3: Cyber Security & Privacy', desc: 'Zero-trust architecture, cryptography, identity management, vulnerability analysis' },
      { name: 'Track 4: Next-Gen Software Engineering', desc: 'DevOps, CI/CD automation, clean code, scalable backend architecture' },
    ];

    for (const t of tracks) {
      await client.query(
        `INSERT INTO tracks (conference_id, name, description) VALUES ($1, $2, $3);`,
        [confId, t.name, t.desc]
      );
    }
    console.log(`✅ Seeded ${tracks.length} conference tracks.`);

    // 5. Enroll Reviewers into Conference
    console.log('\n5. Enrolling committee reviewers...');
    await client.query(
      `INSERT INTO conference_reviewers (conference_id, reviewer_id, status)
       VALUES 
        ($1, $2, 'accepted'),
        ($1, $3, 'accepted');`,
      [confId, userMap['reviewer1@shazusoft.com'], userMap['reviewer2@shazusoft.com']]
    );
    console.log('✅ Reviewers enrolled into conference.');

    // 6. Seed Welcome Announcement
    await client.query(
      `INSERT INTO announcements (conference_id, title, content, target_role, created_by)
       VALUES ($1, $2, $3, $4, $5);`,
      [
        confId,
        'Welcome to SS-ACIS 2026 Call for Papers',
        'Shazu Soft Technologies invites authors to submit manuscripts covering AI, Cloud Computing, and Software Engineering. Submissions are open until September 30, 2026.',
        'all',
        userMap['admin@shazusoft.com'],
      ]
    );
    console.log('✅ Welcome announcement published.');

    console.log('\n======================================================');
    console.log('🎉 DATABASE RESET COMPLETE — READY TO USE!');
    console.log('Admin Account:    admin@shazusoft.com    / password123');
    console.log('Reviewer Account: reviewer1@shazusoft.com / password123');
    console.log('Author Account:   author@shazusoft.com   / password123');
    console.log('======================================================\n');
  } catch (err) {
    console.error('❌ Reset failed:', err);
    process.exit(1);
  } finally {
    client.release();
    await db.pool.end();
  }
}

if (require.main === module) {
  resetDatabase();
}

module.exports = resetDatabase;
