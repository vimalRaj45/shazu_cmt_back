const bcrypt = require('bcryptjs');
const db = require('../config/db');
const { authenticate, requireRoles } = require('../middlewares/auth');
const { logAudit } = require('../services/auditService');

async function userRoutes(fastify, options) {
  // List all users (Admin & Chair)
  fastify.get('/', { preHandler: [authenticate, requireRoles('admin', 'chair')] }, async (request, reply) => {
    try {
      const { role, search, status } = request.query || {};
      let queryText = `SELECT id, email, first_name, last_name, institution, department, country, role, 
                              qualification, designation, domain, areas_of_interest, expertise_keywords, 
                              max_review_limit, orcid_id, google_scholar_url, bio, is_active, created_at 
                       FROM users WHERE 1=1`;
      const params = [];

      if (role) {
        params.push(role);
        queryText += ` AND role = $${params.length}`;
      }

      if (status !== undefined && status !== '') {
        params.push(status === 'active' || status === 'true');
        queryText += ` AND is_active = $${params.length}`;
      }

      if (search) {
        params.push(`%${search}%`);
        queryText += ` AND (first_name ILIKE $${params.length} OR last_name ILIKE $${params.length} OR email ILIKE $${params.length} OR institution ILIKE $${params.length} OR domain ILIKE $${params.length})`;
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
        `SELECT id, email, first_name, last_name, institution, department, country, 
                qualification, designation, domain, areas_of_interest, expertise_keywords, 
                max_review_limit, orcid_id, bio, is_active
         FROM users 
         WHERE role IN ('reviewer', 'chair', 'admin') AND is_active = true
         ORDER BY first_name ASC`
      );
      return { reviewers: res.rows };
    } catch (err) {
      return reply.code(500).send({ error: 'Failed to fetch reviewers', details: err.message });
    }
  });

  // Get single user by ID
  fastify.get('/:id', { preHandler: [authenticate] }, async (request, reply) => {
    const { id } = request.params;
    const isOwner = request.currentUser.id === parseInt(id, 10);
    const isPrivileged = request.currentUser.role === 'admin' || request.currentUser.role === 'chair';

    if (!isOwner && !isPrivileged) {
      return reply.code(403).send({ error: 'You are not authorized to view this user profile' });
    }

    try {
      const res = await db.query(
        `SELECT id, email, first_name, last_name, institution, department, country, role, 
                qualification, designation, domain, areas_of_interest, expertise_keywords, 
                max_review_limit, orcid_id, google_scholar_url, bio, is_active, created_at, updated_at
         FROM users WHERE id = $1`,
        [id]
      );

      if (res.rows.length === 0) {
        return reply.code(404).send({ error: 'User not found' });
      }

      return { user: res.rows[0] };
    } catch (err) {
      return reply.code(500).send({ error: 'Failed to fetch user', details: err.message });
    }
  });

  // Admin update user role or info
  fastify.put('/:id', { preHandler: [authenticate, requireRoles('admin')] }, async (request, reply) => {
    const { id } = request.params;
    const {
      email,
      role,
      firstName,
      lastName,
      institution,
      department,
      country,
      qualification,
      designation,
      domain,
      areasOfInterest,
      expertiseKeywords,
      maxReviewLimit,
      orcidId,
      googleScholarUrl,
      bio,
      isActive,
    } = request.body || {};

    try {
      const res = await db.query(
        `UPDATE users SET 
            email = COALESCE($1, email),
            role = COALESCE($2, role),
            first_name = COALESCE($3, first_name),
            last_name = COALESCE($4, last_name),
            institution = COALESCE($5, institution),
            department = COALESCE($6, department),
            country = COALESCE($7, country),
            qualification = COALESCE($8, qualification),
            designation = COALESCE($9, designation),
            domain = COALESCE($10, domain),
            areas_of_interest = COALESCE($11, areas_of_interest),
            expertise_keywords = COALESCE($12, expertise_keywords),
            max_review_limit = COALESCE($13, max_review_limit),
            orcid_id = COALESCE($14, orcid_id),
            google_scholar_url = COALESCE($15, google_scholar_url),
            bio = COALESCE($16, bio),
            is_active = COALESCE($17, is_active),
            updated_at = CURRENT_TIMESTAMP
         WHERE id = $18
         RETURNING id, email, first_name, last_name, institution, department, country, role, qualification, designation, domain, areas_of_interest, expertise_keywords, max_review_limit, orcid_id, google_scholar_url, bio, is_active;`,
        [
          email ? email.toLowerCase().trim() : null,
          role,
          firstName,
          lastName,
          institution,
          department,
          country,
          qualification,
          designation,
          domain,
          areasOfInterest,
          expertiseKeywords,
          maxReviewLimit,
          orcidId,
          googleScholarUrl,
          bio,
          isActive !== undefined ? isActive : null,
          id,
        ]
      );

      if (res.rows.length === 0) {
        return reply.code(404).send({ error: 'User not found' });
      }

      await logAudit({
        userId: request.currentUser.id,
        action: 'ADMIN_UPDATED_USER',
        entityType: 'user',
        entityId: id,
        details: { targetUserId: id, newRole: role, updatedFields: Object.keys(request.body || {}) },
      });

      return { user: res.rows[0] };
    } catch (err) {
      return reply.code(500).send({ error: 'Failed to update user', details: err.message });
    }
  });

  // Admin toggle user active status (Deactivate / Reactivate)
  fastify.patch('/:id/status', { preHandler: [authenticate, requireRoles('admin')] }, async (request, reply) => {
    const { id } = request.params;
    const { isActive } = request.body || {};

    if (isActive === undefined) {
      return reply.code(400).send({ error: 'isActive boolean value is required' });
    }

    // Prevent admin from deactivating themselves
    if (request.currentUser.id === parseInt(id, 10) && !isActive) {
      return reply.code(400).send({ error: 'You cannot deactivate your own administrator account' });
    }

    try {
      const res = await db.query(
        `UPDATE users SET is_active = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING id, email, first_name, last_name, is_active`,
        [isActive, id]
      );

      if (res.rows.length === 0) {
        return reply.code(404).send({ error: 'User not found' });
      }

      await logAudit({
        userId: request.currentUser.id,
        action: isActive ? 'ADMIN_ACTIVATED_USER' : 'ADMIN_DEACTIVATED_USER',
        entityType: 'user',
        entityId: id,
        details: { isActive },
      });

      return { user: res.rows[0], message: `User account ${isActive ? 'activated' : 'deactivated'} successfully` };
    } catch (err) {
      return reply.code(500).send({ error: 'Failed to update user status', details: err.message });
    }
  });

  // Admin reset user password
  fastify.patch('/:id/reset-password', { preHandler: [authenticate, requireRoles('admin')] }, async (request, reply) => {
    const { id } = request.params;
    const { newPassword } = request.body || {};

    if (!newPassword || newPassword.length < 6) {
      return reply.code(400).send({ error: 'Password must be at least 6 characters long' });
    }

    try {
      const passwordHash = await bcrypt.hash(newPassword, 10);
      const res = await db.query(
        `UPDATE users SET password_hash = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING id, email, first_name, last_name`,
        [passwordHash, id]
      );

      if (res.rows.length === 0) {
        return reply.code(404).send({ error: 'User not found' });
      }

      await logAudit({
        userId: request.currentUser.id,
        action: 'ADMIN_RESET_USER_PASSWORD',
        entityType: 'user',
        entityId: id,
        details: { targetEmail: res.rows[0].email },
      });

      return { message: 'Password reset successfully' };
    } catch (err) {
      return reply.code(500).send({ error: 'Failed to reset password', details: err.message });
    }
  });

  // Create user directly (Admin)
  fastify.post('/', { preHandler: [authenticate, requireRoles('admin')] }, async (request, reply) => {
    const {
      email,
      password,
      firstName,
      lastName,
      institution,
      department,
      country,
      role = 'author',
      qualification,
      designation,
      domain,
      expertiseKeywords = [],
      maxReviewLimit = 3,
    } = request.body || {};

    if (!email || !password || !firstName || !lastName) {
      return reply.code(400).send({ error: 'Required fields missing: email, password, firstName, lastName are required.' });
    }

    try {
      const existing = await db.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase().trim()]);
      if (existing.rows.length > 0) {
        return reply.code(409).send({ error: 'A user with this email address already exists' });
      }

      const passwordHash = await bcrypt.hash(password, 10);
      const res = await db.query(
        `INSERT INTO users (email, password_hash, first_name, last_name, institution, department, country, role, qualification, designation, domain, expertise_keywords, max_review_limit)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         RETURNING id, email, first_name, last_name, institution, department, country, role, qualification, designation, domain, expertise_keywords, max_review_limit, is_active, created_at;`,
        [
          email.toLowerCase().trim(),
          passwordHash,
          firstName,
          lastName,
          institution || '',
          department || '',
          country || 'India',
          role,
          qualification || '',
          designation || '',
          domain || '',
          expertiseKeywords,
          maxReviewLimit,
        ]
      );

      const newUser = res.rows[0];

      await logAudit({
        userId: request.currentUser.id,
        action: 'ADMIN_CREATED_USER',
        entityType: 'user',
        entityId: newUser.id,
        details: { email: newUser.email, role: newUser.role },
      });

      return { user: newUser };
    } catch (err) {
      return reply.code(500).send({ error: 'Failed to create user', details: err.message });
    }
  });

  // Delete user (Admin only)
  fastify.delete('/:id', { preHandler: [authenticate, requireRoles('admin')] }, async (request, reply) => {
    const { id } = request.params;
    const idNum = parseInt(id, 10);

    // Prevent admin from deleting themselves
    if (request.currentUser.id === idNum) {
      return reply.code(400).send({ error: 'You cannot delete your own administrator account' });
    }

    const client = await db.getClient();
    try {
      const userRes = await client.query('SELECT id, email, role FROM users WHERE id = $1', [idNum]);
      if (userRes.rows.length === 0) {
        return reply.code(404).send({ error: 'User not found' });
      }

      const targetUser = userRes.rows[0];

      await client.query('BEGIN');

      // Delete user (FK constraints like submissions.corresponding_author_id has ON DELETE CASCADE, conference_chairs has ON DELETE CASCADE)
      await client.query('DELETE FROM users WHERE id = $1', [idNum]);

      await client.query('COMMIT');

      await logAudit({
        userId: request.currentUser.id,
        action: 'ADMIN_DELETED_USER',
        entityType: 'user',
        entityId: idNum,
        details: { deletedEmail: targetUser.email, deletedRole: targetUser.role },
      });

      return { message: 'User deleted successfully', id: idNum };
    } catch (err) {
      await client.query('ROLLBACK');
      return reply.code(500).send({ error: 'Failed to delete user', details: err.message });
    } finally {
      client.release();
    }
  });
}

module.exports = userRoutes;
