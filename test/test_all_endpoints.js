/**
 * Comprehensive API Endpoint Test Suite for Shazu Soft CMT
 * Tests all 40+ API endpoints across Auth, Conferences, Tracks, Submissions,
 * Reviewers, Conflict Checks, Reviews, Decisions, Camera-Ready, Sessions,
 * Announcements, Brevo Emails, Dashboard, Reports, and Audit Logs.
 */

const BASE_URL = process.env.TEST_API_URL || 'http://localhost:5000/api';

let adminToken = '';
let chairToken = '';
let reviewerToken = '';
let authorToken = '';

let testConferenceId = null;
let testTrackId = null;
let testSubmissionId = null;
let testFileId = null;
let testSessionId = null;
let testReviewerUserId = null;

let passedTests = 0;
let failedTests = 0;

function logPass(title) {
  passedTests++;
  console.log(`  \x1b[32m✔ PASS:\x1b[0m ${title}`);
}

function logFail(title, error) {
  failedTests++;
  console.error(`  \x1b[31m✖ FAIL:\x1b[0m ${title}`);
  if (error) console.error('    Error detail:', error);
}

async function request(endpoint, options = {}) {
  const url = `${BASE_URL}${endpoint}`;
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };

  const config = {
    method: options.method || 'GET',
    headers,
  };

  if (options.body && !(options.body instanceof FormData)) {
    config.body = JSON.stringify(options.body);
  } else if (options.body) {
    delete headers['Content-Type']; // Let fetch set boundary for FormData
    config.body = options.body;
  }

  const res = await fetch(url, config);
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, data };
}

async function runAllTests() {
  console.log('\n======================================================');
  console.log('🚀 SHAZU SOFT CMT — COMPLETE ENDPOINT TEST SUITE');
  console.log(`Target: ${BASE_URL}`);
  console.log('======================================================\n');

  try {
    // 1. Health Check
    console.log('\n--- 1. Health & Server Status ---');
    const health = await request('/health');
    if (health.status === 200 && health.data.status === 'ok') {
      logPass('GET /api/health returns 200 OK');
    } else {
      logFail('GET /api/health', health);
    }

    // 2. Authentication & Profile
    console.log('\n--- 2. Authentication & User Profiles ---');

    // Login Admin
    const adminLogin = await request('/auth/login', {
      method: 'POST',
      body: { email: 'admin@shazusoft.com', password: 'password123' },
    });
    if (adminLogin.status === 200 && adminLogin.data.token) {
      adminToken = adminLogin.data.token;
      logPass('POST /api/auth/login (Admin login)');
    } else {
      logFail('POST /api/auth/login (Admin)', adminLogin);
    }

    // Login Chair
    const chairLogin = await request('/auth/login', {
      method: 'POST',
      body: { email: 'chair@shazusoft.com', password: 'password123' },
    });
    if (chairLogin.status === 200 && chairLogin.data.token) {
      chairToken = chairLogin.data.token;
      logPass('POST /api/auth/login (Chair login)');
    } else {
      logFail('POST /api/auth/login (Chair)', chairLogin);
    }

    // Login Reviewer
    const revLogin = await request('/auth/login', {
      method: 'POST',
      body: { email: 'reviewer1@shazusoft.com', password: 'password123' },
    });
    if (revLogin.status === 200 && revLogin.data.token) {
      reviewerToken = revLogin.data.token;
      testReviewerUserId = revLogin.data.user.id;
      logPass('POST /api/auth/login (Reviewer login)');
    } else {
      logFail('POST /api/auth/login (Reviewer)', revLogin);
    }

    // Login Author
    const authorLogin = await request('/auth/login', {
      method: 'POST',
      body: { email: 'author@shazusoft.com', password: 'password123' },
    });
    if (authorLogin.status === 200 && authorLogin.data.token) {
      authorToken = authorLogin.data.token;
      logPass('POST /api/auth/login (Author login)');
    } else {
      logFail('POST /api/auth/login (Author)', authorLogin);
    }

    // Register a new test user
    const rand = Math.floor(Math.random() * 10000);
    const registerRes = await request('/auth/register', {
      method: 'POST',
      body: {
        email: `tester_${rand}@shazusoft.com`,
        password: 'password123',
        firstName: 'Automated',
        lastName: `Tester${rand}`,
        institution: 'Shazu Soft QA Lab',
        role: 'author',
      },
    });
    if (registerRes.status === 200 && registerRes.data.user) {
      logPass('POST /api/auth/register (New user registration)');
    } else {
      logFail('POST /api/auth/register', registerRes);
    }

    // Get current profile (GET /api/auth/me)
    const meRes = await request('/auth/me', {
      headers: { Authorization: `Bearer ${authorToken}` },
    });
    if (meRes.status === 200 && meRes.data.user) {
      logPass('GET /api/auth/me (Current user info)');
    } else {
      logFail('GET /api/auth/me', meRes);
    }

    // Update profile (PUT /api/auth/profile)
    const updateProfile = await request('/auth/profile', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${authorToken}` },
      body: { department: 'AI & Systems QA' },
    });
    if (updateProfile.status === 200) {
      logPass('PUT /api/auth/profile (Update user profile)');
    } else {
      logFail('PUT /api/auth/profile', updateProfile);
    }

    // 3. User Directory & Administration
    console.log('\n--- 3. User Directory & Administration ---');
    const usersList = await request('/users', {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    if (usersList.status === 200 && Array.isArray(usersList.data.users)) {
      logPass(`GET /api/users (Admin directory: ${usersList.data.users.length} users found)`);
    } else {
      logFail('GET /api/users', usersList);
    }

    const reviewersList = await request('/users/reviewers', {
      headers: { Authorization: `Bearer ${chairToken}` },
    });
    if (reviewersList.status === 200 && Array.isArray(reviewersList.data.reviewers)) {
      logPass(`GET /api/users/reviewers (${reviewersList.data.reviewers.length} PC reviewers available)`);
    } else {
      logFail('GET /api/users/reviewers', reviewersList);
    }

    // 4. Conferences & Tracks
    console.log('\n--- 4. Conferences & Track Management ---');

    // Create Conference
    const confCreate = await request('/conferences', {
      method: 'POST',
      headers: { Authorization: `Bearer ${chairToken}` },
      body: {
        name: `Automated Test Conference ${rand}`,
        shortName: `ATC-${rand}`,
        description: 'Conference created during automated API testing',
        venue: 'Shazu Soft Lab A',
        startDate: '2026-12-01',
        endDate: '2026-12-03',
        submissionDeadline: '2026-11-01',
        reviewDeadline: '2026-11-15',
        decisionDate: '2026-11-20',
        cameraReadyDeadline: '2026-11-25',
        status: 'open',
        tracks: ['Track 1: Algorithms', 'Track 2: Cloud Systems'],
      },
    });

    if (confCreate.status === 200 && confCreate.data.conference) {
      testConferenceId = confCreate.data.conference.id;
      logPass(`POST /api/conferences (Created conference ID: ${testConferenceId})`);
    } else {
      logFail('POST /api/conferences', confCreate);
    }

    // List Conferences
    const confList = await request('/conferences');
    if (confList.status === 200 && confList.data.conferences?.length > 0) {
      logPass(`GET /api/conferences (${confList.data.conferences.length} conferences listed)`);
    } else {
      logFail('GET /api/conferences', confList);
    }

    // Get Conference by ID
    if (testConferenceId) {
      const confGet = await request(`/conferences/${testConferenceId}`);
      if (confGet.status === 200 && confGet.data.conference) {
        logPass(`GET /api/conferences/:id (Fetched details for ID ${testConferenceId})`);
      } else {
        logFail(`GET /api/conferences/:id`, confGet);
      }

      // Update Conference
      const confUpdate = await request(`/conferences/${testConferenceId}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${chairToken}` },
        body: { description: 'Updated conference description for testing' },
      });
      if (confUpdate.status === 200) {
        logPass('PUT /api/conferences/:id (Updated conference details)');
      } else {
        logFail('PUT /api/conferences/:id', confUpdate);
      }

      // Create Track
      const trackCreate = await request('/tracks', {
        method: 'POST',
        headers: { Authorization: `Bearer ${chairToken}` },
        body: {
          conferenceId: testConferenceId,
          name: 'Track 3: Cyber Security',
          description: 'Security & cryptography papers',
        },
      });
      if (trackCreate.status === 200 && trackCreate.data.track) {
        testTrackId = trackCreate.data.track.id;
        logPass(`POST /api/tracks (Created track ID: ${testTrackId})`);
      } else {
        logFail('POST /api/tracks', trackCreate);
      }

      // Get Tracks for Conference
      const tracksGet = await request(`/tracks/conference/${testConferenceId}`);
      if (tracksGet.status === 200 && tracksGet.data.tracks?.length > 0) {
        logPass(`GET /api/tracks/conference/:confId (${tracksGet.data.tracks.length} tracks found)`);
      } else {
        logFail('GET /api/tracks/conference/:confId', tracksGet);
      }
    }

    // 5. Paper Submissions
    console.log('\n--- 5. Paper Submissions & Files ---');
    if (testConferenceId) {
      const subCreate = await request('/submissions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${authorToken}` },
        body: {
          conferenceId: testConferenceId,
          trackId: testTrackId,
          title: 'Automated Test Paper: High Throughput Fastify Architecture',
          abstract: 'Comprehensive benchmark of Fastify HTTP performance under concurrent payload workloads.',
          keywords: ['Fastify', 'High Throughput', 'Performance'],
          authors: [
            { name: 'Vikram Sharma', email: 'author@shazusoft.com', institution: 'Shazu Soft', is_primary: true },
            { name: 'Dr. Co-Author', email: 'coauthor@example.com', institution: 'Research Lab', is_primary: false },
          ],
        },
      });

      if (subCreate.status === 200 && subCreate.data.submission) {
        testSubmissionId = subCreate.data.submission.id;
        logPass(`POST /api/submissions (Created submission: ${subCreate.data.submission.submission_number})`);
      } else {
        logFail('POST /api/submissions', subCreate);
      }

      // Author list my submissions
      const mySubs = await request('/submissions/my', {
        headers: { Authorization: `Bearer ${authorToken}` },
      });
      if (mySubs.status === 200 && Array.isArray(mySubs.data.submissions)) {
        logPass(`GET /api/submissions/my (Author retrieved ${mySubs.data.submissions.length} submissions)`);
      } else {
        logFail('GET /api/submissions/my', mySubs);
      }

      // Chair list conference submissions
      const confSubs = await request(`/submissions/conference/${testConferenceId}`, {
        headers: { Authorization: `Bearer ${chairToken}` },
      });
      if (confSubs.status === 200 && Array.isArray(confSubs.data.submissions)) {
        logPass(`GET /api/submissions/conference/:confId (Chair retrieved ${confSubs.data.submissions.length} submissions)`);
      } else {
        logFail('GET /api/submissions/conference/:confId', confSubs);
      }

      // Single submission inspector
      if (testSubmissionId) {
        const singleSub = await request(`/submissions/${testSubmissionId}`, {
          headers: { Authorization: `Bearer ${authorToken}` },
        });
        if (singleSub.status === 200 && singleSub.data.submission) {
          logPass(`GET /api/submissions/:id (Fetched submission details for ID ${testSubmissionId})`);
        } else {
          logFail('GET /api/submissions/:id', singleSub);
        }
      }
    }

    // 6. Reviewers, Conflict Checks & Assignments
    console.log('\n--- 6. Reviewers, Conflict Detection & Assignments ---');
    if (testConferenceId && testSubmissionId) {
      // Invite reviewer to conference committee
      const inviteRev = await request(`/reviewers/conference/${testConferenceId}/invite`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${chairToken}` },
        body: { reviewerId: testReviewerUserId },
      });
      if (inviteRev.status === 200) {
        logPass('POST /api/reviewers/conference/:confId/invite (Added reviewer to PC)');
      } else {
        logFail('POST /api/reviewers/conference/:confId/invite', inviteRev);
      }

      // Conflict of Interest Analysis
      const conflictCheck = await request(`/reviewers/conflicts/submission/${testSubmissionId}`, {
        headers: { Authorization: `Bearer ${chairToken}` },
      });
      if (conflictCheck.status === 200 && Array.isArray(conflictCheck.data.reviewersWithConflictStatus)) {
        logPass(`GET /api/reviewers/conflicts/submission/:subId (Analyzed ${conflictCheck.data.reviewersWithConflictStatus.length} reviewers for COI)`);
      } else {
        logFail('GET /api/reviewers/conflicts/submission/:subId', conflictCheck);
      }

      // Assign reviewer to submission
      const assignRev = await request('/reviewers/assign', {
        method: 'POST',
        headers: { Authorization: `Bearer ${chairToken}` },
        body: {
          submissionId: testSubmissionId,
          reviewerId: testReviewerUserId,
        },
      });
      if (assignRev.status === 200) {
        logPass('POST /api/reviewers/assign (Assigned reviewer to submission)');
      } else {
        logFail('POST /api/reviewers/assign', assignRev);
      }
    }

    // 7. Peer Reviews & Evaluation Scorecard
    console.log('\n--- 7. Peer Reviews & Evaluations ---');
    if (testSubmissionId) {
      // Reviewer list assignments
      const revAssigns = await request('/reviews/my-assignments', {
        headers: { Authorization: `Bearer ${reviewerToken}` },
      });
      if (revAssigns.status === 200 && Array.isArray(revAssigns.data.assignments)) {
        logPass(`GET /api/reviews/my-assignments (Reviewer found ${revAssigns.data.assignments.length} assigned papers)`);
      } else {
        logFail('GET /api/reviews/my-assignments', revAssigns);
      }

      // Reviewer save draft
      const saveDraft = await request(`/reviews/submission/${testSubmissionId}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${reviewerToken}` },
        body: {
          technicalQuality: 5,
          originality: 4,
          relevance: 5,
          presentationQuality: 4,
          overallScore: 5,
          recommendation: 'accept',
          commentsForAuthors: 'Strong paper with good empirical measurements.',
          confidentialChairNotes: 'Recommend oral presentation.',
          isDraft: true,
        },
      });
      if (saveDraft.status === 200 && saveDraft.data.review?.is_draft === true) {
        logPass('POST /api/reviews/submission/:subId (Saved evaluation draft)');
      } else {
        logFail('POST /api/reviews/submission/:subId (Draft)', saveDraft);
      }

      // Reviewer finalize review
      const finalRev = await request(`/reviews/submission/${testSubmissionId}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${reviewerToken}` },
        body: {
          technicalQuality: 5,
          originality: 4,
          relevance: 5,
          presentationQuality: 4,
          overallScore: 5,
          recommendation: 'accept',
          commentsForAuthors: 'Strong paper with good empirical measurements.',
          confidentialChairNotes: 'Recommend oral presentation.',
          isDraft: false,
        },
      });
      if (finalRev.status === 200 && finalRev.data.review?.is_draft === false) {
        logPass('POST /api/reviews/submission/:subId (Submitted final locked review)');
      } else {
        logFail('POST /api/reviews/submission/:subId (Final)', finalRev);
      }

      // Chair view reviews
      const chairReviews = await request(`/reviews/submission/${testSubmissionId}`, {
        headers: { Authorization: `Bearer ${chairToken}` },
      });
      if (chairReviews.status === 200 && Array.isArray(chairReviews.data.reviews)) {
        logPass(`GET /api/reviews/submission/:subId (Chair retrieved ${chairReviews.data.reviews.length} reviews with scorecards)`);
      } else {
        logFail('GET /api/reviews/submission/:subId (Chair)', chairReviews);
      }
    }

    // 8. Decisions & Camera-Ready Desk
    console.log('\n--- 8. Decisions & Camera-Ready Workflow ---');
    if (testSubmissionId) {
      // Chair records decision
      const decisionRes = await request(`/decisions/submission/${testSubmissionId}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${chairToken}` },
        body: {
          decision: 'accept',
          decisionNotes: 'Paper accepted for oral presentation in Track 1.',
          notifyAuthor: false, // Avoid live email during unit tests
        },
      });
      if (decisionRes.status === 200 && decisionRes.data.decision?.decision === 'accept') {
        logPass('POST /api/decisions/submission/:subId (Recorded ACCEPT decision)');
      } else {
        logFail('POST /api/decisions/submission/:subId', decisionRes);
      }

      // Get decision
      const getDec = await request(`/decisions/submission/${testSubmissionId}`, {
        headers: { Authorization: `Bearer ${authorToken}` },
      });
      if (getDec.status === 200 && getDec.data.decision) {
        logPass('GET /api/decisions/submission/:subId (Author retrieved decision)');
      } else {
        logFail('GET /api/decisions/submission/:subId', getDec);
      }

      // Camera-Ready List
      const cameraList = await request(`/camera-ready/conference/${testConferenceId}`, {
        headers: { Authorization: `Bearer ${chairToken}` },
      });
      if (cameraList.status === 200 && Array.isArray(cameraList.data.submissions)) {
        logPass(`GET /api/camera-ready/conference/:confId (${cameraList.data.submissions.length} accepted papers listed)`);
      } else {
        logFail('GET /api/camera-ready/conference/:confId', cameraList);
      }

      // Chair Approve Camera-Ready
      const approveCamera = await request(`/camera-ready/${testSubmissionId}/status`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${chairToken}` },
        body: { status: 'camera_ready_approved' },
      });
      if (approveCamera.status === 200 && approveCamera.data.submission?.status === 'camera_ready_approved') {
        logPass('POST /api/camera-ready/:subId/status (Camera-ready approved)');
      } else {
        logFail('POST /api/camera-ready/:subId/status', approveCamera);
      }
    }

    // 9. Conference Sessions & Presentation Schedule
    console.log('\n--- 9. Conference Sessions & Presentations ---');
    if (testConferenceId && testSubmissionId) {
      // Create session
      const createSession = await request('/sessions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${chairToken}` },
        body: {
          conferenceId: testConferenceId,
          trackId: testTrackId,
          sessionName: 'Session 1: High-Performance Computing',
          sessionChairName: 'Dr. Rajesh Kumar',
          venueRoom: 'Room 101',
          sessionDate: '2026-12-01',
          startTime: '09:00 AM',
          endTime: '11:00 AM',
        },
      });

      if (createSession.status === 200 && createSession.data.session) {
        testSessionId = createSession.data.session.id;
        logPass(`POST /api/sessions (Created session ID: ${testSessionId})`);
      } else {
        logFail('POST /api/sessions', createSession);
      }

      // Add presentation slot
      if (testSessionId) {
        const addPres = await request(`/sessions/${testSessionId}/presentations`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${chairToken}` },
          body: {
            submissionId: testSubmissionId,
            presentationOrder: 1,
            startTime: '09:00 AM',
            endTime: '09:20 AM',
            presentationNotes: 'Keynote Paper Presentation',
          },
        });
        if (addPres.status === 200) {
          logPass('POST /api/sessions/:sessionId/presentations (Added presentation slot)');
        } else {
          logFail('POST /api/sessions/:sessionId/presentations', addPres);
        }

        // Get public conference program schedule
        const scheduleRes = await request(`/sessions/conference/${testConferenceId}`);
        if (scheduleRes.status === 200 && Array.isArray(scheduleRes.data.sessions)) {
          logPass(`GET /api/sessions/conference/:confId (Fetched public schedule with ${scheduleRes.data.sessions.length} sessions)`);
        } else {
          logFail('GET /api/sessions/conference/:confId', scheduleRes);
        }
      }
    }

    // 10. Announcements & Brevo Emails
    console.log('\n--- 10. Announcements & Brevo Email Logs ---');
    if (testConferenceId) {
      // Create announcement
      const postAnn = await request('/announcements', {
        method: 'POST',
        headers: { Authorization: `Bearer ${chairToken}` },
        body: {
          conferenceId: testConferenceId,
          title: 'Schedule Released for ATC-2026',
          content: 'The complete technical paper presentation schedule is now live.',
          targetRole: 'all',
        },
      });
      if (postAnn.status === 200 && postAnn.data.announcement) {
        logPass('POST /api/announcements (Created conference announcement)');
      } else {
        logFail('POST /api/announcements', postAnn);
      }

      // View announcements
      const getAnn = await request(`/announcements/conference/${testConferenceId}`);
      if (getAnn.status === 200 && Array.isArray(getAnn.data.announcements)) {
        logPass(`GET /api/announcements/conference/:confId (${getAnn.data.announcements.length} announcements retrieved)`);
      } else {
        logFail('GET /api/announcements/conference/:confId', getAnn);
      }

      // Get email delivery logs
      const emailLogs = await request(`/emails/logs/${testConferenceId}`, {
        headers: { Authorization: `Bearer ${chairToken}` },
      });
      if (emailLogs.status === 200 && Array.isArray(emailLogs.data.logs)) {
        logPass(`GET /api/emails/logs/:confId (Retrieved ${emailLogs.data.logs.length} Brevo email history logs)`);
      } else {
        logFail('GET /api/emails/logs/:confId', emailLogs);
      }
    }

    // 11. Dashboard Overview, Reports & Audit Trail
    console.log('\n--- 11. Dashboard Analytics, Reports & Audit Trail ---');

    // Dashboard Overview
    const dashOverview = await request(`/dashboard/overview?conferenceId=${testConferenceId || ''}`, {
      headers: { Authorization: `Bearer ${chairToken}` },
    });
    if (dashOverview.status === 200 && dashOverview.data.stats) {
      logPass('GET /api/dashboard/overview (Aggregated metrics for Chair/Admin/Reviewer/Author)');
    } else {
      logFail('GET /api/dashboard/overview', dashOverview);
    }

    // Reports summary & paper export data
    if (testConferenceId) {
      const reportRes = await request(`/reports/conference/${testConferenceId}/summary`, {
        headers: { Authorization: `Bearer ${chairToken}` },
      });
      if (reportRes.status === 200 && reportRes.data.papersExport) {
        logPass(`GET /api/reports/conference/:confId/summary (Exportable report with ${reportRes.data.papersExport.length} paper rows)`);
      } else {
        logFail('GET /api/reports/conference/:confId/summary', reportRes);
      }
    }

    // Audit logs
    const auditLogs = await request('/audit-logs', {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    if (auditLogs.status === 200 && Array.isArray(auditLogs.data.logs)) {
      logPass(`GET /api/audit-logs (Admin fetched ${auditLogs.data.logs.length} system audit trail entries)`);
    } else {
      logFail('GET /api/audit-logs', auditLogs);
    }

  } catch (err) {
    console.error('Critical test suite error:', err);
    failedTests++;
  }

  // Summary
  console.log('\n======================================================');
  console.log(`🏁 TEST RESULTS: ${passedTests} PASSED, ${failedTests} FAILED`);
  console.log('======================================================\n');

  if (failedTests > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runAllTests();
