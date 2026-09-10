const bcrypt = require('bcryptjs');
const db = require('../config/db');

async function seed() {
  console.log('\n======================================================');
  console.log('👤 INITIALIZING ADMIN ACCOUNT FOR SHAZU SOFT CMT');
  console.log('======================================================\n');

  try {
    const password = 'password123';
    const passwordHash = await bcrypt.hash(password, 10);

    const adminUser = {
      email: 'vimalraj5207@gmail.com',
      password_hash: passwordHash,
      first_name: 'Vimal',
      last_name: 'Raj',
      institution: 'Shazu Soft Technologies',
      department: 'Technology & Administration',
      country: 'India',
      role: 'admin',
      qualification: 'Administrator',
      designation: 'Lead Administrator',
      domain: 'Computer Science & Engineering',
      areas_of_interest: ['System Administration', 'Cloud Infrastructure'],
      expertise_keywords: ['System Administration', 'Platform Management'],
      max_review_limit: 5,
      bio: 'Lead System Administrator for Shazu Soft CMT Platform.',
    };

    const res = await db.query(
      `INSERT INTO users (
         email, password_hash, first_name, last_name, institution, 
         department, country, role, qualification, designation, 
         domain, areas_of_interest, expertise_keywords, max_review_limit, bio
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       ON CONFLICT (email) DO UPDATE SET 
          password_hash = EXCLUDED.password_hash,
          role = 'admin',
          first_name = EXCLUDED.first_name,
          last_name = EXCLUDED.last_name,
          institution = EXCLUDED.institution,
          updated_at = CURRENT_TIMESTAMP
       RETURNING id, email, first_name, last_name, role;`,
      [
        adminUser.email,
        adminUser.password_hash,
        adminUser.first_name,
        adminUser.last_name,
        adminUser.institution,
        adminUser.department,
        adminUser.country,
        adminUser.role,
        adminUser.qualification,
        adminUser.designation,
        adminUser.domain,
        adminUser.areas_of_interest,
        adminUser.expertise_keywords,
        adminUser.max_review_limit,
        adminUser.bio,
      ]
    );

    const user = res.rows[0];
    console.log('✅ Admin account created successfully!');
    console.log(`   ID:       ${user.id}`);
    console.log(`   Email:    ${user.email}`);
    console.log(`   Name:     ${user.first_name} ${user.last_name}`);
    console.log(`   Role:     ${user.role}`);
    console.log(`   Password: ${password}\n`);
    console.log('======================================================\n');
  } catch (err) {
    console.error('❌ Error creating admin user:', err.message);
    process.exit(1);
  } finally {
    await db.pool.end();
  }
}

if (require.main === module) {
  seed();
}

module.exports = seed;
