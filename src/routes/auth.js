const bcrypt = require('bcryptjs');
const db = require('../config/db');
const { authenticate } = require('../middlewares/auth');
const { sendWelcomeEmail } = require('../services/emailService');
const { logAudit } = require('../services/auditService');
const { fetchOrcidProfile, cleanOrcid, isValidOrcid, getOrcidOAuthUrl, exchangeOrcidOAuthCode } = require('../services/orcidService');
const { verifyTurnstileToken } = require('../services/turnstileService');

async function authRoutes(fastify, options) {
  // Get ORCID OAuth URL
  fastify.get('/orcid/url', async (request, reply) => {
    try {
      const { redirectUri } = request.query || {};
      console.log('[Auth Route] Generating ORCID OAuth URL for redirectUri:', redirectUri);
      const authData = getOrcidOAuthUrl(redirectUri);
      return authData;
    } catch (err) {
      console.error('[Auth Route] Error in /orcid/url:', err);
      return reply.code(500).send({ error: 'Failed to generate ORCID OAuth URL: ' + err.message });
    }
  });

  // ORCID OAuth Callback (Exchange Code & Sign-in/Sign-up)
  fastify.post('/orcid/callback', async (request, reply) => {
    const { code, redirectUri } = request.body || {};
    console.log('[Auth Route] /orcid/callback received request:', {
      hasCode: Boolean(code),
      codePrefix: code ? String(code).slice(0, 8) : null,
      redirectUri,
    });

    if (!code) {
      return reply.code(400).send({ error: 'Authorization code is required' });
    }

    try {
      // 1. Exchange code with ORCID
      const orcidData = await exchangeOrcidOAuthCode(code, redirectUri);
      console.log('[Auth Route] ORCID code exchanged successfully:', orcidData);
      const cleanedOrcid = cleanOrcid(orcidData.orcid);

      if (!cleanedOrcid) {
        return reply.code(400).send({ error: 'Failed to retrieve verified ORCID iD' });
      }

      // 2. Check if user already exists with this ORCID iD
      const existingUserRes = await db.query('SELECT * FROM users WHERE orcid_id = $1', [cleanedOrcid]);

      let user;
      let isNewUser = false;

      if (existingUserRes.rows.length > 0) {
        // Existing user found -> Log in
        user = existingUserRes.rows[0];
      } else {
        // New user -> Fetch rich public profile from ORCID
        isNewUser = true;
        let profile = {};
        try {
          profile = await fetchOrcidProfile(cleanedOrcid);
        } catch (fetchErr) {
          console.warn('Could not fetch public ORCID record:', fetchErr.message);
        }

        const firstName = profile.firstName || orcidData.name?.split(' ')[0] || 'Scholar';
        const lastName = profile.lastName || orcidData.name?.split(' ').slice(1).join(' ') || 'Researcher';
        const dummyEmail = `orcid.${cleanedOrcid.replace(/-/g, '')}@orcid.user`;
        const defaultPasswordHash = await bcrypt.hash(`orcid_oauth_${cleanedOrcid}`, 10);

        const insertRes = await db.query(
          `INSERT INTO users (
              email, password_hash, first_name, last_name, institution, department, country, 
              role, qualification, designation, domain, areas_of_interest, expertise_keywords, 
              max_review_limit, orcid_id, bio
           )
           VALUES ($1, $2, $3, $4, $5, $6, 'India', 'author', $7, $8, $9, $10, $11, 3, $12, $13)
           RETURNING id, email, first_name, last_name, institution, department, country, role, qualification, designation, domain, areas_of_interest, expertise_keywords, max_review_limit, orcid_id, bio;`,
          [
            dummyEmail,
            defaultPasswordHash,
            firstName,
            lastName,
            profile.institution || '',
            profile.department || '',
            profile.qualification || 'Ph.D. / Doctorate',
            profile.designation || 'Researcher',
            profile.domain || 'Computer Science & Engineering',
            profile.areasOfInterest || ['Peer Review', 'Research'],
            profile.areasOfInterest || ['Peer Review', 'Research'],
            cleanedOrcid,
            profile.bio || `ORCID Verified Scholar Profile (${cleanedOrcid})`,
          ]
        );
        user = insertRes.rows[0];
      }

      // Generate JWT Token
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
        qualification: user.qualification,
        designation: user.designation,
        domain: user.domain,
        areas_of_interest: user.areas_of_interest || [],
        expertise_keywords: user.expertise_keywords || [],
        max_review_limit: user.max_review_limit || 3,
        orcid_id: user.orcid_id,
        google_scholar_url: user.google_scholar_url,
        bio: user.bio,
      };

      await logAudit({
        userId: user.id,
        action: isNewUser ? 'USER_REGISTERED_VIA_ORCID' : 'USER_LOGIN_VIA_ORCID',
        entityType: 'user',
        entityId: user.id,
        details: { orcidId: cleanedOrcid, isNewUser },
      });

      return { user: safeUser, token, isNewUser };
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ error: 'ORCID authentication failed', details: err.message });
    }
  });

  // ORCID Public Profile Lookup (Auto-fill)
  fastify.post('/orcid/lookup', async (request, reply) => {
    const { orcidId } = request.body || {};
    if (!orcidId) {
      return reply.code(400).send({ error: 'ORCID iD is required (e.g. 0000-0002-1825-0097)' });
    }

    try {
      const profile = await fetchOrcidProfile(orcidId);
      return { success: true, profile };
    } catch (err) {
      return reply.code(400).send({ error: err.message || 'Failed to lookup ORCID profile' });
    }
  });

  // Register new user (Standard or ORCID verified)
  fastify.post('/register', async (request, reply) => {
    const {
      email,
      password,
      firstName,
      lastName,
      institution,
      department,
      country,
      role = 'author',
      qualification = '',
      designation = '',
      domain = '',
      areasOfInterest = [],
      expertiseKeywords = [],
      maxReviewLimit = 3,
      orcidId = '',
      googleScholarUrl = '',
      bio = '',
      turnstileToken,
      'cf-turnstile-response': cfTurnstileResponse,
      referralSource = '',
      partnerJournal = '',
      partnerConference = '',
    } = request.body || {};

    if (!email || !password || !firstName || !lastName) {
      return reply.code(400).send({ error: 'Email, password, first name and last name are required.' });
    }

    const tToken = turnstileToken || cfTurnstileResponse || '';
    const turnstileCheck = await verifyTurnstileToken(tToken, 'signup', request);
    if (!turnstileCheck.success && !turnstileCheck.bypassed) {
      return reply.code(403).send({ error: turnstileCheck.error || 'Bot verification failed.' });
    }

    const cleanedOrcid = cleanOrcid(orcidId);

    try {
      const existing = await db.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase().trim()]);
      if (existing.rows.length > 0) {
        return reply.code(409).send({
          error: 'An account with this email address already exists. Please sign in to access your portal.',
          accountExists: true,
        });
      }

      if (cleanedOrcid) {
        const existingOrcid = await db.query('SELECT id FROM users WHERE orcid_id = $1', [cleanedOrcid]);
        if (existingOrcid.rows.length > 0) {
          return reply.code(409).send({
            error: 'An account with this ORCID iD is already registered. Please sign in.',
            accountExists: true,
          });
        }
      }

      const passwordHash = await bcrypt.hash(password, 10);
      const combinedKeywords = Array.from(new Set([...(Array.isArray(areasOfInterest) ? areasOfInterest : []), ...(Array.isArray(expertiseKeywords) ? expertiseKeywords : [])]));

      const res = await db.query(
        `INSERT INTO users (
            email, password_hash, first_name, last_name, institution, department, country, 
            role, qualification, designation, domain, areas_of_interest, expertise_keywords, 
            max_review_limit, orcid_id, google_scholar_url, bio
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
         RETURNING id, email, first_name, last_name, institution, department, country, role, qualification, designation, domain, areas_of_interest, expertise_keywords, max_review_limit, orcid_id, google_scholar_url, bio, created_at;`,
        [
          email.toLowerCase().trim(),
          passwordHash,
          firstName.trim(),
          lastName.trim(),
          institution || '',
          department || '',
          country || '',
          role,
          qualification || '',
          designation || '',
          domain || '',
          Array.isArray(areasOfInterest) ? areasOfInterest : [],
          combinedKeywords,
          parseInt(maxReviewLimit, 10) || 3,
          cleanedOrcid || null,
          googleScholarUrl || '',
          bio || '',
        ]
      );

      const user = res.rows[0];
      const token = fastify.jwt.sign({ id: user.id, email: user.email, role: user.role });

      // Trigger welcome email asynchronously (non-blocking)
      sendWelcomeEmail(user).catch((e) => console.error('Failed welcome email:', e.message));

      await logAudit({
        userId: user.id,
        action: referralSource || partnerJournal || partnerConference ? 'USER_REGISTERED_VIA_EXTERNAL_PARTNER' : 'USER_REGISTERED',
        entityType: 'user',
        entityId: user.id,
        details: {
          email: user.email,
          role: user.role,
          qualification: user.qualification,
          domain: user.domain,
          orcidId: user.orcid_id,
          referralSource: referralSource || partnerJournal || partnerConference || null,
        },
      });

      return { user, token };
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ error: 'Failed to register user', details: err.message });
    }
  });

  // Login (Email or ORCID iD + Password)
  fastify.post('/login', async (request, reply) => {
    const { email, identifier, password, turnstileToken, 'cf-turnstile-response': cfTurnstileResponse } = request.body || {};
    const loginIdentifier = (email || identifier || '').trim();

    if (!loginIdentifier || !password) {
      return reply.code(400).send({ error: 'Email/ORCID iD and password are required' });
    }

    const tToken = turnstileToken || cfTurnstileResponse || '';
    const turnstileCheck = await verifyTurnstileToken(tToken, 'login', request);
    if (!turnstileCheck.success && !turnstileCheck.bypassed) {
      return reply.code(403).send({ error: turnstileCheck.error || 'Bot verification failed.' });
    }

    try {
      const cleaned = cleanOrcid(loginIdentifier);
      const res = await db.query(
        'SELECT * FROM users WHERE email = $1 OR orcid_id = $2',
        [loginIdentifier.toLowerCase(), cleaned]
      );
      if (res.rows.length === 0) {
        return reply.code(401).send({ error: 'Invalid credentials. Please check your email/ORCID and password.' });
      }

      const user = res.rows[0];
      const isValid = await bcrypt.compare(password, user.password_hash);
      if (!isValid) {
        return reply.code(401).send({ error: 'Invalid credentials. Please check your email/ORCID and password.' });
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
        qualification: user.qualification,
        designation: user.designation,
        domain: user.domain,
        areas_of_interest: user.areas_of_interest || [],
        expertise_keywords: user.expertise_keywords || [],
        max_review_limit: user.max_review_limit || 3,
        orcid_id: user.orcid_id,
        google_scholar_url: user.google_scholar_url,
        bio: user.bio,
      };

      await logAudit({
        userId: user.id,
        action: 'USER_LOGIN',
        entityType: 'user',
        entityId: user.id,
        details: { email: user.email, loginVia: user.email === loginIdentifier.toLowerCase() ? 'email' : 'orcid' },
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
        `SELECT id, email, first_name, last_name, institution, department, country, role, 
                qualification, designation, domain, areas_of_interest, expertise_keywords, 
                max_review_limit, orcid_id, google_scholar_url, bio, created_at 
         FROM users WHERE id = $1`,
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
    const {
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
    } = request.body || {};

    try {
      const res = await db.query(
        `UPDATE users SET 
            first_name = COALESCE($1, first_name),
            last_name = COALESCE($2, last_name),
            institution = COALESCE($3, institution),
            department = COALESCE($4, department),
            country = COALESCE($5, country),
            qualification = COALESCE($6, qualification),
            designation = COALESCE($7, designation),
            domain = COALESCE($8, domain),
            areas_of_interest = COALESCE($9, areas_of_interest),
            expertise_keywords = COALESCE($10, expertise_keywords),
            max_review_limit = COALESCE($11, max_review_limit),
            orcid_id = COALESCE($12, orcid_id),
            google_scholar_url = COALESCE($13, google_scholar_url),
            bio = COALESCE($14, bio),
            updated_at = CURRENT_TIMESTAMP
         WHERE id = $15
         RETURNING id, email, first_name, last_name, institution, department, country, role, qualification, designation, domain, areas_of_interest, expertise_keywords, max_review_limit, orcid_id, google_scholar_url, bio;`,
        [
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
          request.currentUser.id,
        ]
      );
      return { user: res.rows[0] };
    } catch (err) {
      return reply.code(500).send({ error: 'Failed to update profile', details: err.message });
    }
  });
}

module.exports = authRoutes;
