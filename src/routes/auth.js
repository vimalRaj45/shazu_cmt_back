const bcrypt = require('bcryptjs');
const db = require('../config/db');
const { authenticate } = require('../middlewares/auth');
const { sendWelcomeEmail } = require('../services/emailService');
const { logAudit } = require('../services/auditService');

async function authRoutes(fastify, options) {
  // Register new user
  fastify.post('/register', async (request, reply) => {
    const { email, password, firstName, lastName, institution, department, country, role = 'author', expertiseKeywords = [] } = request.body || {};

    if (!email || !password || !firstName || !lastName) {
      return reply.code(400).send({ error: 'Email, password, first name and last name are required.' });
    }

    try {
      const existing = await db.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase().trim()]);
      if (existing.rows.length > 0) {
        return reply.code(409).send({ error: 'User with this email already exists.' });
      }

      const passwordHash = await bcrypt.hash(password, 10);
      const res = await db.query(
        `INSERT INTO users (email, password_hash, first_name, last_name, institution, department, country, role, expertise_keywords)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id, email, first_name, last_name, institution, department, country, role, expertise_keywords, created_at;`,
        [email.toLowerCase().trim(), passwordHash, firstName.trim(), lastName.trim(), institution || '', department || '', country || '', role, expertiseKeywords]
      );

      const user = res.rows[0];
      const token = fastify.jwt.sign({ id: user.id, email: user.email, role: user.role });

      // Trigger welcome email asynchronously (non-blocking)
      sendWelcomeEmail(user).catch((e) => console.error('Failed welcome email:', e.message));

      await logAudit({
        userId: user.id,
        action: 'USER_REGISTERED',
        entityType: 'user',
        entityId: user.id,
        details: { email: user.email, role: user.role },
      });

      return { user, token };
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ error: 'Failed to register user', details: err.message });
    }
  });

  // Login
  fastify.post('/login', async (request, reply) => {
    const { email, password } = request.body || {};

    if (!email || !password) {
      return reply.code(400).send({ error: 'Email and password are required' });
    }

    try {
      const res = await db.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase().trim()]);
      if (res.rows.length === 0) {
        return reply.code(401).send({ error: 'Invalid email or password' });
      }

      const user = res.rows[0];
      const isValid = await bcrypt.compare(password, user.password_hash);
      if (!isValid) {
        return reply.code(401).send({ error: 'Invalid email or password' });
      }

      const token = fastify.jwt.sign({ id: user.id, email: user.email, role: user.role });

      const safeUser = {
        id: user.id,
        email: user.email,
        first_name: user.first_name,
        last_name: user.last_name,
        institution: user.institution,
        department: user.department,
        country: user.country,
        role: user.role,
        expertise_keywords: user.expertise_keywords,
      };

      await logAudit({
        userId: user.id,
        action: 'USER_LOGIN',
        entityType: 'user',
        entityId: user.id,
        details: { email: user.email },
      });

      return { user: safeUser, token };
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ error: 'Login failed', details: err.message });
    }
  });

  // Get current authenticated user profile
  fastify.get('/me', { preHandler: [authenticate] }, async (request, reply) => {
    try {
      const res = await db.query(
        'SELECT id, email, first_name, last_name, institution, department, country, role, expertise_keywords, bio, created_at FROM users WHERE id = $1',
        [request.currentUser.id]
      );
      if (res.rows.length === 0) {
        return reply.code(404).send({ error: 'User not found' });
      }
      return { user: res.rows[0] };
    } catch (err) {
      return reply.code(500).send({ error: 'Failed to fetch user', details: err.message });
    }
  });

  // Update profile
  fastify.put('/profile', { preHandler: [authenticate] }, async (request, reply) => {
    const { firstName, lastName, institution, department, country, expertiseKeywords, bio } = request.body || {};
    try {
      const res = await db.query(
        `UPDATE users SET 
            first_name = COALESCE($1, first_name),
            last_name = COALESCE($2, last_name),
            institution = COALESCE($3, institution),
            department = COALESCE($4, department),
            country = COALESCE($5, country),
            expertise_keywords = COALESCE($6, expertise_keywords),
            bio = COALESCE($7, bio),
            updated_at = CURRENT_TIMESTAMP
         WHERE id = $8
         RETURNING id, email, first_name, last_name, institution, department, country, role, expertise_keywords, bio;`,
        [firstName, lastName, institution, department, country, expertiseKeywords, bio, request.currentUser.id]
      );
      return { user: res.rows[0] };
    } catch (err) {
      return reply.code(500).send({ error: 'Failed to update profile', details: err.message });
    }
  });
}

module.exports = authRoutes;
