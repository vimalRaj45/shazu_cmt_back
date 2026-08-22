const bcrypt = require('bcryptjs');
const db = require('../config/db');

async function seed() {
  console.log('--- Starting Demo Data Seeding for Shazu Soft CMT ---');
  try {
    const passwordHash = await bcrypt.hash('password123', 10);

    // 1. Create Core Users (3 Roles: admin, reviewer, author)
    const users = [
      {
        email: 'admin@shazusoft.com',
        password_hash: passwordHash,
        first_name: 'System',
        last_name: 'Admin',
        institution: 'Shazu Soft Technologies',
        department: 'Operations & IT',
        country: 'India',
        role: 'admin',
        expertise_keywords: ['System Architecture', 'Cloud Infrastructure', 'Security'],
      },
      {
        email: 'chair@shazusoft.com',
        password_hash: passwordHash,
        first_name: 'Dr. Rajesh',
        last_name: 'Kumar',
        institution: 'Shazu Soft Research Labs',
        department: 'Computer Science & AI',
        country: 'India',
        role: 'admin',
        expertise_keywords: ['Artificial Intelligence', 'Machine Learning', 'Computer Vision'],
      },
      {
        email: 'reviewer1@shazusoft.com',
        password_hash: passwordHash,
        first_name: 'Prof. Anita',
        last_name: 'Deshmukh',
        institution: 'Indian Institute of Technology',
        department: 'Computer Science & Engineering',
        country: 'India',
        role: 'reviewer',
        expertise_keywords: ['Machine Learning', 'Deep Learning', 'NLP'],
      },
      {
        email: 'reviewer2@shazusoft.com',
        password_hash: passwordHash,
        first_name: 'Dr. Michael',
        last_name: 'Chen',
        institution: 'National University of Singapore',
        department: 'Information Systems',
        country: 'Singapore',
        role: 'reviewer',
        expertise_keywords: ['Cyber Security', 'Cryptography', 'Cloud Systems'],
      },
      {
        email: 'reviewer3@shazusoft.com',
        password_hash: passwordHash,
        first_name: 'Dr. Sarah',
        last_name: 'Jenkins',
        institution: 'MIT CSAIL',
        department: 'Electrical Engineering & Computer Science',
        country: 'United States',
        role: 'reviewer',
        expertise_keywords: ['IoT', 'Edge Computing', 'Distributed Systems'],
      },
      {
        email: 'author@shazusoft.com',
        password_hash: passwordHash,
        first_name: 'Vikram',
        last_name: 'Sharma',
        institution: 'Shazu Soft Innovations',
        department: 'Software Engineering',
        country: 'India',
        role: 'author',
        expertise_keywords: ['Natural Language Processing', 'Fastify', 'React'],
      },
    ];

    const userMap = {};

    for (const u of users) {
      const res = await db.query(
        `INSERT INTO users (email, password_hash, first_name, last_name, institution, department, country, role, expertise_keywords)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (email) DO UPDATE SET 
            first_name = EXCLUDED.first_name,
            last_name = EXCLUDED.last_name,
            role = EXCLUDED.role,
            institution = EXCLUDED.institution,
            expertise_keywords = EXCLUDED.expertise_keywords
         RETURNING id, email, role;`,
        [u.email, u.password_hash, u.first_name, u.last_name, u.institution, u.department, u.country, u.role, u.expertise_keywords]
      );
      userMap[u.email] = res.rows[0].id;
    }
    console.log('✅ Users seeded:', Object.keys(userMap).length);

    // 2. Create Sample Conference
    const confRes = await db.query(
      `INSERT INTO conferences (name, short_name, description, venue, start_date, end_date, submission_deadline, review_deadline, decision_date, camera_ready_deadline, status, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING id;`,
      [
        'Shazu Soft International Conference on Advanced Computing & Intelligent Systems 2026',
        'SS-ACIS 2026',
        'Annual flagship conference hosted by Shazu Soft Technologies showcasing innovations in Artificial Intelligence, Cloud Infrastructure, High-Performance Computing, and Next-Gen Software Engineering.',
        'Shazu Soft Tech Auditorium, Bangalore, India & Virtual Live Stream',
        '2026-11-15',
        '2026-11-17',
        '2026-10-10 23:59:59+00',
        '2026-10-25 23:59:59+00',
        '2026-11-01 23:59:59+00',
        '2026-11-08 23:59:59+00',
        'open',
        userMap['admin@shazusoft.com'],
      ]
    );
    const confId = confRes.rows[0].id;

    // Assign Chair to conference
    await db.query(
      `INSERT INTO conference_chairs (conference_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING;`,
      [confId, userMap['chair@shazusoft.com']]
    );

    // Invite Reviewers to conference
    for (const email of ['reviewer1@shazusoft.com', 'reviewer2@shazusoft.com', 'reviewer3@shazusoft.com']) {
      await db.query(
        `INSERT INTO conference_reviewers (conference_id, reviewer_id, status)
         VALUES ($1, $2, 'accepted')
         ON CONFLICT (conference_id, reviewer_id) DO NOTHING;`,
        [confId, userMap[email]]
      );
    }

    // 3. Create Tracks
    const tracks = [
      { name: 'Artificial Intelligence & Deep Learning', description: 'LLMs, Neural Architectures, Computer Vision & NLP' },
      { name: 'Cloud & Distributed Systems', description: 'Serverless, High-throughput microservices & Edge Computing' },
      { name: 'Cyber Security & Privacy', description: 'Zero Trust, Cryptographic protocols & Threat Intelligence' },
      { name: 'IoT & Smart Architectures', description: 'Sensors, Real-time telemetry & Hardware-software co-design' },
    ];

    const trackMap = {};
    for (const t of tracks) {
      const tRes = await db.query(
        `INSERT INTO tracks (conference_id, name, description, is_active)
         VALUES ($1, $2, $3, true) RETURNING id, name;`,
        [confId, t.name, t.description]
      );
      trackMap[t.name] = tRes.rows[0].id;
    }
    console.log('✅ Tracks created:', tracks.length);

    // 4. Create Sample Submissions
    const sub1 = await db.query(
      `INSERT INTO submissions (conference_id, track_id, submission_number, title, abstract, keywords, corresponding_author_id, status)
       VALUES ($1, $2, 'CMT-2026-00101', $3, $4, $5, $6, 'under_review')
       RETURNING id;`,
      [
        confId,
        trackMap['Artificial Intelligence & Deep Learning'],
        'Optimizing Large Language Model Inference Latency via Adaptive Speculative Decoding',
        'Large Language Models have revolutionized natural language processing, yet real-time serving remains bottlenecked by autoregressive token generation. In this paper, we present an adaptive speculative decoding framework that dynamically adjusts draft model steps based on contextual entropy.',
        ['LLM Inference', 'Speculative Decoding', 'Model Optimization', 'Transformer Latency'],
        userMap['author@shazusoft.com'],
      ]
    );
    const sub1Id = sub1.rows[0].id;

    // Add Authors for Sub 1
    await db.query(
      `INSERT INTO submission_authors (submission_id, name, email, institution, department, country, is_primary, is_corresponding, author_order)
       VALUES ($1, 'Vikram Sharma', 'author@shazusoft.com', 'Shazu Soft Innovations', 'Software Engineering', 'India', true, true, 1),
              ($1, 'Dr. Aravind Swaminathan', 'aravind@iisc.ac.in', 'Indian Institute of Science', 'Computer Science', 'India', false, false, 2);`,
      [sub1Id]
    );

    // Add Sample Manuscript File entry
    await db.query(
      `INSERT INTO submission_files (submission_id, file_type, file_name, file_size, mime_type, s3_key, public_url, version, uploaded_by)
       VALUES ($1, 'manuscript', 'CMT-2026-00101_Manuscript_v1.pdf', 1048576, 'application/pdf', 'submissions/CMT-2026-00101/manuscript_v1.pdf', 'https://pub-fa07772bd8834632b07cbf792baa76ed.r2.dev/sample-manuscript.pdf', 1, $2);`,
      [sub1Id, userMap['author@shazusoft.com']]
    );

    // Assign Reviewers for Sub 1
    await db.query(
      `INSERT INTO reviewer_assignments (submission_id, reviewer_id, assigned_by, invitation_status)
       VALUES ($1, $2, $4, 'accepted'), ($1, $3, $4, 'accepted');`,
      [sub1Id, userMap['reviewer1@shazusoft.com'], userMap['reviewer2@shazusoft.com'], userMap['chair@shazusoft.com']]
    );

    // Add Sample Review for Sub 1 from Reviewer 1
    await db.query(
      `INSERT INTO reviews (submission_id, reviewer_id, technical_quality, originality, relevance, presentation_quality, overall_score, recommendation, comments_for_authors, confidential_chair_notes, is_draft, submitted_at)
       VALUES ($1, $2, 5, 4, 5, 4, 5, 'accept', 'Very well-written paper with solid benchmark results across Llama-3 and Mistral architectures. The entropy threshold mechanism is novel and shows measurable 2.3x speedups.', 'Solid paper, strong accept candidate for oral presentation.', false, CURRENT_TIMESTAMP);`,
      [sub1Id, userMap['reviewer1@shazusoft.com']]
    );

    // Create Sub 2 (Accepted & Camera Ready Pending)
    const sub2 = await db.query(
      `INSERT INTO submissions (conference_id, track_id, submission_number, title, abstract, keywords, corresponding_author_id, status)
       VALUES ($1, $2, 'CMT-2026-00102', $3, $4, $5, $6, 'accepted')
       RETURNING id;`,
      [
        confId,
        trackMap['Cloud & Distributed Systems'],
        'Zero-Overhead Fault Recovery for Distributed Stream Processing in Serverless Edge Clusters',
        'Stateful stream processing at the edge requires fast checkpointing without congesting resource-constrained edge gateways. We propose a differential log-structured state sync mechanism reducing recovery lag by 78%.',
        ['Stream Processing', 'Serverless', 'Edge Computing', 'Fault Tolerance'],
        userMap['author@shazusoft.com'],
      ]
    );
    const sub2Id = sub2.rows[0].id;

    await db.query(
      `INSERT INTO submission_authors (submission_id, name, email, institution, department, country, is_primary, is_corresponding, author_order)
       VALUES ($1, 'Vikram Sharma', 'author@shazusoft.com', 'Shazu Soft Innovations', 'Software Engineering', 'India', true, true, 1);`,
      [sub2Id]
    );

    await db.query(
      `INSERT INTO paper_decisions (submission_id, decision, decision_notes, notified_authors, decided_by)
       VALUES ($1, 'accept', 'Congratulations! Your paper has been accepted for oral presentation at SS-ACIS 2026. Please submit the camera-ready version before the deadline.', true, $2);`,
      [sub2Id, userMap['chair@shazusoft.com']]
    );

    // 5. Create Sample Session
    const sessionRes = await db.query(
      `INSERT INTO conference_sessions (conference_id, track_id, session_name, session_chair_name, venue_room, session_date, start_time, end_time)
       VALUES ($1, $2, 'Session A1: High-Performance AI Architectures', 'Dr. Rajesh Kumar', 'Main Hall A', '2026-11-15', '10:00 AM', '12:00 PM')
       RETURNING id;`,
      [confId, trackMap['Artificial Intelligence & Deep Learning']]
    );
    const sessionId = sessionRes.rows[0].id;

    await db.query(
      `INSERT INTO session_presentations (session_id, submission_id, presentation_order, start_time, end_time, presentation_notes)
       VALUES ($1, $2, 1, '10:00 AM', '10:25 AM', 'Oral Presentation (20 mins + 5 mins Q&A)');`,
      [sessionId, sub2Id]
    );

    // 6. Announcements
    await db.query(
      `INSERT INTO announcements (conference_id, title, content, target_role, created_by)
       VALUES ($1, 'Call for Papers Open for SS-ACIS 2026', 'We invite researchers and engineers to submit high quality manuscripts across AI, Cloud, Cyber Security, and IoT.', 'all', $2),
              ($1, 'Review Phase Underway', 'Reviewers are kindly requested to complete peer evaluations by October 25, 2026.', 'reviewers', $2);`,
      [confId, userMap['chair@shazusoft.com']]
    );

    console.log('✅ Demo conference, submissions, reviews, sessions and announcements seeded successfully!');
    console.log('\nDefault Test Accounts:');
    console.log('  👑 Admin:       admin@shazusoft.com       / password123');
    console.log('  🎓 Chair:       chair@shazusoft.com       / password123');
    console.log('  🔍 Reviewer 1:  reviewer1@shazusoft.com   / password123');
    console.log('  🔍 Reviewer 2:  reviewer2@shazusoft.com   / password123');
    console.log('  📝 Author:      author@shazusoft.com      / password123');
    console.log('  👥 Participant: participant@shazusoft.com / password123\n');
  } catch (err) {
    console.error('❌ Seeding error:', err);
  } finally {
    await db.pool.end();
  }
}

if (require.main === module) {
  seed();
}

module.exports = seed;
