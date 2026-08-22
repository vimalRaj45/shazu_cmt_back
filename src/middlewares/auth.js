const db = require('../config/db');

/**
 * Fastify preHandler to verify JWT token
 */
async function authenticate(request, reply) {
  try {
    await request.jwtVerify();
    // Fetch user details to ensure active account
    const userRes = await db.query('SELECT id, email, first_name, last_name, role, institution FROM users WHERE id = $1', [request.user.id]);
    if (userRes.rows.length === 0) {
      return reply.code(401).send({ error: 'User account no longer exists' });
    }
    request.currentUser = userRes.rows[0];
  } catch (err) {
    return reply.code(401).send({ error: 'Invalid or expired token', details: err.message });
  }
}

/**
 * Fastify preHandler factory to enforce specific roles (e.g. 'admin', 'chair')
 */
function requireRoles(...allowedRoles) {
  return async function (request, reply) {
    if (!request.currentUser) {
      await authenticate(request, reply);
      if (reply.sent) return;
    }

    const userRole = request.currentUser.role;
    if (userRole === 'admin') {
      // Admin has universal super-access across all areas
      return;
    }

    if (!allowedRoles.includes(userRole)) {
      return reply.code(403).send({ error: `Access denied. Requires one of: ${allowedRoles.join(', ')}` });
    }
  };
}

module.exports = {
  authenticate,
  requireRoles,
};
