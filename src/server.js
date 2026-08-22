require('dotenv').config();
const fastify = require('fastify')({
  logger: true,
});

// Plugins
fastify.register(require('@fastify/cors'), {
  origin: true, // Allow frontend dev & prod origins
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  credentials: true,
});

fastify.register(require('@fastify/jwt'), {
  secret: process.env.JWT_SECRET || 'shazusoft_cmt_super_secret_fallback_key',
});

fastify.register(require('@fastify/multipart'), {
  limits: {
    fileSize: 50 * 1024 * 1024, // 50 MB max paper/slides size
  },
});

// Health check
fastify.get('/api/health', async (request, reply) => {
  return {
    status: 'ok',
    system: 'Shazu Soft Conference Management Tool (CMT)',
    timestamp: new Date().toISOString(),
  };
});

// Register API Route Modules
fastify.register(require('./routes/auth'), { prefix: '/api/auth' });
fastify.register(require('./routes/users'), { prefix: '/api/users' });
fastify.register(require('./routes/conferences'), { prefix: '/api/conferences' });
fastify.register(require('./routes/tracks'), { prefix: '/api/tracks' });
fastify.register(require('./routes/submissions'), { prefix: '/api/submissions' });
fastify.register(require('./routes/reviewers'), { prefix: '/api/reviewers' });
fastify.register(require('./routes/reviews'), { prefix: '/api/reviews' });
fastify.register(require('./routes/decisions'), { prefix: '/api/decisions' });
fastify.register(require('./routes/cameraReady'), { prefix: '/api/camera-ready' });
fastify.register(require('./routes/announcements'), { prefix: '/api/announcements' });
fastify.register(require('./routes/emails'), { prefix: '/api/emails' });
fastify.register(require('./routes/dashboard'), { prefix: '/api/dashboard' });
fastify.register(require('./routes/reports'), { prefix: '/api/reports' });
fastify.register(require('./routes/auditLogs'), { prefix: '/api/audit-logs' });

const PORT = parseInt(process.env.PORT, 10) || 5000;

const start = async () => {
  try {
    await fastify.listen({ port: PORT, host: '0.0.0.0' });
    console.log(`🚀 Shazu Soft CMT Fastify Server running on http://localhost:${PORT}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
