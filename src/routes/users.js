const bcrypt = require('bcryptjs');
const db = require('../config/db');
const { authenticate, requireRoles } = require('../middlewares/auth');
const { logAudit } = require('../services/auditService');

async function userRoutes(fastify, options) {
  // List all users (Admin only)
  fastify.get('/', { preHandler: [authenticate, requireRoles('admin', 'chair')] }, async (request, reply) => {
    try {
      const { role, search } = request.query || {};
      let queryText = 'SELECT id, email, first_name, last_name, institution, department, country, role, expertise_keywords, created_at FROM users WHERE 1=1';
      const params = [];

      if (role) {
        params.push(role);
        queryText += ` AND role = $${params.length}`;
      }

      if (search) {
        params.push(`%${search}%`);
        queryText += ` AND (first_name ILIKE $${params.length} OR last_name ILIKE $${params.length} OR email ILIKE $${params.length} OR institution ILIKE $${params.length})`;
      }

      queryText += ' ORDER BY id ASC';
      const res = await db.query(queryText, params);
      return { users: res.rows };
    } catch (err) {
      return reply.code(500).send({ error: 'Failed to fetch users', details: err.message });
    }
  });

  // Get available reviewers (for Chairs to invite or assign)
  fastify.get('/reviewers', { preHandler: [authenticate, requireRoles('admin', 'chair')] }, async (request, reply) => {
    try {
      const res = await db.query(
        `SELECT id, email, first_name, last_name, institution, department, country, expertise_keywords 
         FROM users 
         WHERE role IN ('reviewer', 'chair', 'admin') 
         ORDER BY first_name ASC`
      );
      return { reviewers: res.rows };
    } catch (err) {
      return reply.code(500).send({ error: 'Failed to fetch reviewers', details: err.message });
    }
  });

  // Admin update user role or info
  fastify.put('/:id', { preHandler: [authenticate, requireRoles('admin')] }, async (request, reply) => {
    const { id } = request.params;
    const { role, firstName, lastName, institution, department, country, expertiseKeywords } = request.body || {};

    try {
      const res = await db.query(
        `UPDATE users SET 
            role = COALESCE($1, role),
            first_name = COALESCE($2, first_name),
            last_name = COALESCE($3, last_name),
            institution = COALESCE($4, institution),
            department = COALESCE($5, department),
            country = COALESCE($6, country),
            expertise_keywords = COALESCE($7, expertise_keywords),
            updated_at = CURRENT_TIMESTAMP
         WHERE id = $8
         RETURNING id, email, first_name, last_name, institution, department, country, role, expertise_keywords;`,
        [role, firstName, lastName, institution, department, country, expertiseKeywords, id]
      );

      if (res.rows.length === 0) {
        return reply.code(404).send({ error: 'User not found' });
      }

      await logAudit({
        userId: request.currentUser.id,
        action: 'ADMIN_UPDATED_USER',
        entityType: 'user',
        entityId: id,
        details: { targetUserId: id, newRole: role },
      });

      return { user: res.rows[0] };
    } catch (err) {
      return reply.code(500).send({ error: 'Failed to update user', details: err.message });
    }
  });

  // Create user directly (Admin)
  fastify.post('/', { preHandler: [authenticate, requireRoles('admin')] }, async (request, reply) => {
    const { email, password, firstName, lastName, institution, department, country, role = 'author', expertiseKeywords = [] } = request.body || {};

    if (!email || !password || !firstName || !lastName) {
      return reply.code(400).send({ error: 'Required fields missing' });
    }

    try {
      const existing = await db.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase().trim()]);
      if (existing.rows.length > 0) {
        return reply.code(409).send({ error: 'User already exists' });
      }

      const passwordHash = await bcrypt.hash(password, 10);
      const res = await db.query(
        `INSERT INTO users (email, password_hash, first_name, last_name, institution, department, country, role, expertise_keywords)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id, email, first_name, last_name, institution, department, country, role, expertise_keywords, created_at;`,
        [email.toLowerCase().trim(), passwordHash, firstName, lastName, institution || '', department || '', country || '', role, expertiseKeywords]
      );

      return { user: res.rows[0] };
    } catch (err) {
      return reply.code(500).send({ error: 'Failed to create user', details: err.message });
    }
  });
}

module.exports = userRoutes;
