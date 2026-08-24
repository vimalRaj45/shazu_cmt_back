const db = require('../config/db');

/**
 * Sanitizes and strips PII (Emails, ORCID IDs, Phone Numbers, URLs) from text
 */
function sanitizePii(text) {
  if (!text) return '';
  return String(text)
    // Redact emails
    .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[EMAIL_REDACTED]')
    // Redact ORCID iDs
    .replace(/\b\d{4}-\d{4}-\d{4}-[\dX]{4}\b/g, '[ORCID_REDACTED]')
    // Redact URLs containing user IDs / profiles
    .replace(/https?:\/\/[^\s]+/g, '[LINK_REDACTED]')
    // Redact phone numbers
    .replace(/(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g, '[PHONE_REDACTED]');
}

/**
 * Calls Mistral AI API with 100% Anonymized & Sanitized Data (NO PII, NO Names, NO Emails, NO ORCIDs)
 */
async function queryMistralAiMatch(submission, candidates) {
  const apiKey = process.env.MISTRAL_API_KEY;
  if (!apiKey || apiKey.trim() === '') return null;

  // 1. Build an anonymized mapping: candidate_1 -> real reviewer id
  const candidateMap = new Map();
  const anonymizedCandidates = candidates.map((c, index) => {
    const candidateKey = `candidate_${index + 1}`;
    candidateMap.set(candidateKey, c.id);

    // Sanitize areas of interest
    const sanitizedInterests = (c.areas_of_interest || [])
      .map((tag) => sanitizePii(tag).trim())
      .filter((t) => t.length > 0 && !t.includes('REDACTED'));

    return {
      candidateKey,
      academicLevel: c.qualification || 'Academic Peer',
      academicTitle: c.designation || 'Researcher',
      primaryDiscipline: c.domain || 'Computer Science',
      researchTopics: sanitizedInterests,
    };
  });

  // 2. Sanitize manuscript details (Strip any PII from title and abstract)
  const sanitizedTitle = sanitizePii(submission.title || '');
  const sanitizedAbstract = sanitizePii(submission.abstract || '');
  const sanitizedKeywords = Array.isArray(submission.keywords)
    ? submission.keywords.map(sanitizePii).filter((k) => !k.includes('REDACTED'))
    : [sanitizePii(submission.keywords || '')];
  const sanitizedTrack = sanitizePii(submission.track_name || 'General Track');

  const prompt = `You are an expert academic peer-review evaluator.
Analyze this research paper and evaluate the suitability of candidate reviewers based purely on academic qualification, primary discipline, and research topic overlap.

[PRIVACY NOTICE: All names, personal identifiers, and institutions have been strictly anonymized.]

Manuscript Details:
- Title: ${sanitizedTitle}
- Abstract: ${sanitizedAbstract}
- Track: ${sanitizedTrack}
- Keywords: ${sanitizedKeywords.join(', ')}

Anonymous Candidate Profiles:
${anonymizedCandidates.map((ac) => `[${ac.candidateKey}] Degree: ${ac.academicLevel}, Title: ${ac.academicTitle}, Discipline: ${ac.primaryDiscipline}, Research Topics: ${ac.researchTopics.join(', ')}`).join('\n')}

Respond ONLY with a JSON array in this exact schema without markdown formatting:
[
  {
    "candidateKey": "<candidate_1|candidate_2|...>",
    "matchScore": <integer between 45 and 98>,
    "confidence": "<High|Moderate|Fair>",
    "aiRationale": "<1 concise sentence explaining research topic alignment and domain fit>",
    "matchedTopics": ["<topic1>", "<topic2>"]
  }
]`;

  try {
    const response = await fetch('https://api.mistral.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'mistral-small-latest',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
      }),
    });

    if (!response.ok) {
      console.warn('Mistral AI API returned status:', response.status);
      return null;
    }

    const data = await response.json();
    const rawContent = data.choices?.[0]?.message?.content?.trim() || '';
    
    // Clean potential markdown blocks
    const cleaned = rawContent.replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/\s*```$/, '');
    let parsed = JSON.parse(cleaned);

    if (parsed && !Array.isArray(parsed) && Array.isArray(parsed.evaluations || parsed.reviewers || parsed.results)) {
      parsed = parsed.evaluations || parsed.reviewers || parsed.results;
    }

    if (Array.isArray(parsed)) {
      const map = {};
      parsed.forEach((item) => {
        const realId = candidateMap.get(item.candidateKey) || item.reviewerId;
        if (realId) {
          map[realId] = {
            matchScore: item.matchScore,
            confidence: item.confidence,
            aiRationale: item.aiRationale,
            matchedTopics: item.matchedTopics,
          };
        }
      });
      return map;
    }
    return null;
  } catch (err) {
    console.warn('Mistral AI evaluation fallback to heuristic:', err.message);
    return null;
  }
}

/**
 * Normalizes text into a set of lowercased alphanumeric keywords/tokens
 */
function extractTokens(text) {
  if (!text) return new Set();
  if (Array.isArray(text)) {
    const set = new Set();
    text.forEach((item) => {
      extractTokens(item).forEach((t) => set.add(t));
    });
    return set;
  }
  return new Set(
    String(text)
      .toLowerCase()
      .replace(/[^\w\s-]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 2)
  );
}

/**
 * Calculates Jaccard & overlap similarity between two token sets
 */
function calculateTokenOverlap(setA, setB) {
  if (!setA.size || !setB.size) return { score: 0, matches: [] };
  const matches = [];
  setA.forEach((token) => {
    if (setB.has(token)) {
      matches.push(token);
    }
  });

  // Calculate matching ratio
  const unionSize = new Set([...setA, ...setB]).size;
  const score = unionSize > 0 ? matches.length / Math.min(setA.size, setB.size) : 0;
  return { score: Math.min(score, 1), matches };
}

/**
 * Evaluates qualification level weighting
 */
function getQualificationWeight(qualification = '', designation = '') {
  const text = `${qualification} ${designation}`.toLowerCase();
  if (text.includes('ph.d') || text.includes('phd') || text.includes('doctor') || text.includes('professor')) {
    return { level: 'Senior / Ph.D.', weight: 1.0 };
  }
  if (text.includes('master') || text.includes('m.tech') || text.includes('m.s') || text.includes('scientist') || text.includes('fellow')) {
    return { level: 'Postgraduate / Researcher', weight: 0.85 };
  }
  if (text.includes('bachelor') || text.includes('b.tech') || text.includes('b.s') || text.includes('student')) {
    return { level: 'Graduate / Junior', weight: 0.7 };
  }
  return { level: 'Academic Peer', weight: 0.75 };
}

/**
 * Calculates AI Compatibility Match Score & Rationale for a Paper-Reviewer pair
 */
function calculateReviewerMatchScore(submission, reviewer) {
  // 1. Prepare Paper Text Context
  const paperTitleTokens = extractTokens(submission.title || '');
  const paperAbstractTokens = extractTokens(submission.abstract || '');
  const paperKeywords = Array.isArray(submission.keywords) ? submission.keywords : [];
  const paperKeywordTokens = extractTokens(paperKeywords);
  const paperTrack = (submission.track_name || '').toLowerCase().trim();

  const allPaperTokens = new Set([...paperTitleTokens, ...paperAbstractTokens, ...paperKeywordTokens]);

  // 2. Prepare Reviewer Profile Context
  const revInterests = Array.isArray(reviewer.areas_of_interest) ? reviewer.areas_of_interest : [];
  const revExpertise = Array.isArray(reviewer.expertise_keywords) ? reviewer.expertise_keywords : [];
  const allRevTopics = Array.from(new Set([...revInterests, ...revExpertise]));
  const revTopicTokens = extractTokens(allRevTopics);
  const revDomain = (reviewer.domain || reviewer.department || '').toLowerCase().trim();
  const revDomainTokens = extractTokens(revDomain);

  // 3. Match Calculations
  // A. Topic & Keyword Overlap
  const topicOverlap = calculateTokenOverlap(allPaperTokens, revTopicTokens);
  
  // Specific exact keyword matches
  const matchedKeywords = [];
  allRevTopics.forEach((topic) => {
    const tLower = topic.toLowerCase();
    if (
      paperKeywords.some((pk) => pk.toLowerCase().includes(tLower) || tLower.includes(pk.toLowerCase())) ||
      (submission.title && submission.title.toLowerCase().includes(tLower)) ||
      (submission.abstract && submission.abstract.toLowerCase().includes(tLower))
    ) {
      matchedKeywords.push(topic);
    }
  });

  // B. Domain / Track Alignment
  let domainTrackScore = 0;
  if (paperTrack && revDomain) {
    if (paperTrack.includes(revDomain) || revDomain.includes(paperTrack)) {
      domainTrackScore = 1.0;
    } else {
      const overlap = calculateTokenOverlap(extractTokens(paperTrack), revDomainTokens);
      domainTrackScore = overlap.score > 0 ? 0.75 : 0.2;
    }
  } else if (revDomain) {
    domainTrackScore = 0.5;
  }

  // C. Academic Seniority
  const { level: qualLevel, weight: qualWeight } = getQualificationWeight(reviewer.qualification, reviewer.designation);

  // D. Weighted Score (0 to 100)
  const keywordScore = matchedKeywords.length > 0 ? Math.min(0.5 + matchedKeywords.length * 0.2, 1.0) : topicOverlap.score;
  const rawScore = (keywordScore * 0.55) + (domainTrackScore * 0.30) + (qualWeight * 0.15);
  
  // Normalized 0 - 100 percentage
  const matchPercentage = Math.round(Math.min(Math.max(rawScore * 100, 35), 98));

  // Confidence Tier
  let confidence = 'Moderate';
  if (matchPercentage >= 80) confidence = 'High';
  else if (matchPercentage < 60) confidence = 'Fair';

  // Explainable AI Rationale Synthesis
  let rationale = '';
  const matchedListStr = matchedKeywords.length > 0 ? matchedKeywords.slice(0, 3).join(', ') : '';

  if (matchedKeywords.length > 0 && domainTrackScore > 0.6) {
    rationale = `Strong domain alignment (${reviewer.domain || 'Field'}) with matching research expertise in ${matchedListStr}.`;
  } else if (matchedKeywords.length > 0) {
    rationale = `Demonstrated research expertise in ${matchedListStr} with ${reviewer.qualification || reviewer.designation || 'academic experience'}.`;
  } else if (domainTrackScore > 0.6) {
    rationale = `Aligned discipline (${reviewer.domain || reviewer.department || 'Field'}) suitable for evaluating track topics.`;
  } else {
    rationale = `Broad domain coverage as a ${reviewer.designation || reviewer.qualification || 'peer reviewer'}.`;
  }

  return {
    matchScore: matchPercentage,
    confidence,
    rationale,
    matchedTopics: matchedKeywords,
    qualificationLevel: qualLevel,
  };
}

/**
 * Checks for hard conflicts of interest (COI) between a submission and reviewer
 */
function checkConflict(submission, reviewer, manualConflictsMap = {}) {
  const revEmail = (reviewer.email || '').toLowerCase().trim();
  const revId = reviewer.id;
  const revInst = (reviewer.institution || '').toLowerCase().trim();

  // 1. Author / Co-author conflict
  if (submission.corresponding_author_id === revId) {
    return { hasConflict: true, reason: 'Author on paper' };
  }
  if (submission.author_emails && submission.author_emails.has(revEmail)) {
    return { hasConflict: true, reason: 'Co-author on paper' };
  }

  // 2. Institutional conflict
  if (revInst && submission.author_institutions && submission.author_institutions.has(revInst)) {
    return { hasConflict: true, reason: `Institutional affiliation match (${reviewer.institution})` };
  }

  // 3. Manual conflict record
  const conflictKey = `${submission.id}-${revId}`;
  if (manualConflictsMap[conflictKey]) {
    return { hasConflict: true, reason: manualConflictsMap[conflictKey].notes || 'Declared conflict of interest' };
  }

  return { hasConflict: false, reason: null };
}

/**
 * Generates an AI-driven Auto-Assignment Preview Plan for a conference
 */
async function generateAiAutoAssignmentPlan(conferenceId, options = {}) {
  const {
    targetReviewsPerPaper = 2,
    maxReviewsPerReviewer = 3,
    onlyUnassigned = true,
  } = options;

  // 1. Fetch Conference Submissions
  const subsRes = await db.query(
    `SELECT s.id, s.submission_number, s.title, s.abstract, s.keywords, s.status, s.track_id,
            s.corresponding_author_id, u.institution as author_institution, u.email as author_email,
            t.name as track_name
     FROM submissions s
     LEFT JOIN users u ON s.corresponding_author_id = u.id
     LEFT JOIN tracks t ON s.track_id = t.id
     WHERE s.conference_id = $1 AND s.status IN ('submitted', 'under_review')
     ORDER BY s.id ASC`,
    [conferenceId]
  );

  const submissions = subsRes.rows;
  if (submissions.length === 0) {
    return {
      success: true,
      submissionsCount: 0,
      assignedCount: 0,
      plan: [],
      warnings: ['No eligible submitted papers found in this conference.'],
    };
  }

  // 2. Fetch All Co-authors for these submissions to build COI maps
  const subIds = submissions.map((s) => s.id);
  const coAuthorsRes = await db.query(
    `SELECT submission_id, email, institution FROM submission_authors WHERE submission_id = ANY($1::int[])`,
    [subIds]
  );

  const subAuthorsMap = {};
  submissions.forEach((s) => {
    subAuthorsMap[s.id] = {
      emails: new Set([s.author_email?.toLowerCase().trim()].filter(Boolean)),
      institutions: new Set([s.author_institution?.toLowerCase().trim()].filter(Boolean)),
    };
  });

  coAuthorsRes.rows.forEach((ca) => {
    if (subAuthorsMap[ca.submission_id]) {
      if (ca.email) subAuthorsMap[ca.submission_id].emails.add(ca.email.toLowerCase().trim());
      if (ca.institution) subAuthorsMap[ca.submission_id].institutions.add(ca.institution.toLowerCase().trim());
    }
  });

  // Attach COI sets to submissions
  submissions.forEach((s) => {
    s.author_emails = subAuthorsMap[s.id]?.emails || new Set();
    s.author_institutions = subAuthorsMap[s.id]?.institutions || new Set();
  });

  // 3. Fetch Conference Reviewers
  const revRes = await db.query(
    `SELECT u.id, u.email, u.first_name, u.last_name, u.institution, u.department, u.country,
            u.qualification, u.designation, u.domain, u.areas_of_interest, u.expertise_keywords,
            COALESCE(u.max_review_limit, 3) as max_review_limit,
            (SELECT COUNT(*) FROM reviewer_assignments ra 
             JOIN submissions sub ON ra.submission_id = sub.id 
             WHERE ra.reviewer_id = u.id AND sub.conference_id = $1) as current_assigned_count
     FROM conference_reviewers cr
     JOIN users u ON cr.reviewer_id = u.id
     WHERE cr.conference_id = $1 AND cr.status = 'accepted'
     ORDER BY u.id ASC`,
    [conferenceId]
  );

  const reviewers = revRes.rows;
  if (reviewers.length === 0) {
    return {
      success: false,
      submissionsCount: submissions.length,
      assignedCount: 0,
      plan: [],
      warnings: ['No accepted reviewers found in the Conference Program Committee. Please invite reviewers first.'],
    };
  }

  // 4. Fetch Existing Assignments and Manual Conflicts
  const assignmentsRes = await db.query(
    `SELECT ra.submission_id, ra.reviewer_id 
     FROM reviewer_assignments ra
     JOIN submissions s ON ra.submission_id = s.id
     WHERE s.conference_id = $1`,
    [conferenceId]
  );

  const existingAssignments = new Set(assignmentsRes.rows.map((a) => `${a.submission_id}-${a.reviewer_id}`));
  const paperAssignedCount = {};
  assignmentsRes.rows.forEach((a) => {
    paperAssignedCount[a.submission_id] = (paperAssignedCount[a.submission_id] || 0) + 1;
  });

  const conflictsRes = await db.query(
    `SELECT submission_id, reviewer_id, conflict_type, notes FROM conflicts WHERE conference_id = $1`,
    [conferenceId]
  );
  const manualConflictsMap = {};
  conflictsRes.rows.forEach((c) => {
    if (c.submission_id) manualConflictsMap[`${c.submission_id}-${c.reviewer_id}`] = c;
  });

  // Track dynamic simulated review counts per reviewer
  const simulatedLoads = {};
  reviewers.forEach((r) => {
    simulatedLoads[r.id] = parseInt(r.current_assigned_count, 10) || 0;
  });

  const warnings = [];
  const assignmentPlan = [];
  let totalNewAssignments = 0;

  // 5. Optimization & AI Assignment Generation Loop
  for (const sub of submissions) {
    const existingCount = paperAssignedCount[sub.id] || 0;
    if (onlyUnassigned && existingCount >= targetReviewsPerPaper) {
      // Paper already has enough reviewers
      continue;
    }

    const neededReviews = Math.max(targetReviewsPerPaper - existingCount, 0);
    if (neededReviews <= 0) continue;

    // Evaluate all reviewers for this submission
    const candidateScores = [];

    for (const rev of reviewers) {
      // Check if already assigned
      if (existingAssignments.has(`${sub.id}-${rev.id}`)) {
        continue;
      }

      // Check conflict
      const conflict = checkConflict(sub, rev, manualConflictsMap);
      if (conflict.hasConflict) {
        continue;
      }

      // Check capacity limit
      const effectiveMaxLimit = Math.min(rev.max_review_limit || 3, maxReviewsPerReviewer);
      if (simulatedLoads[rev.id] >= effectiveMaxLimit) {
        continue;
      }

      // Calculate heuristic match as baseline
      const match = calculateReviewerMatchScore(sub, rev);

      candidateScores.push({
        reviewer: rev,
        ...match,
        currentLoad: simulatedLoads[rev.id],
        maxLimit: effectiveMaxLimit,
      });
    }

    // Call Mistral AI to evaluate top candidates if available
    if (candidateScores.length > 0 && process.env.MISTRAL_API_KEY) {
      try {
        const topCandidatesForAi = candidateScores.slice(0, 6).map((c) => c.reviewer);
        const mistralResults = await queryMistralAiMatch(sub, topCandidatesForAi);
        if (mistralResults) {
          candidateScores.forEach((c) => {
            const mData = mistralResults[c.reviewer.id];
            if (mData) {
              c.matchScore = parseInt(mData.matchScore, 10) || c.matchScore;
              c.confidence = mData.confidence || c.confidence;
              c.aiRationale = mData.aiRationale || c.aiRationale;
              if (Array.isArray(mData.matchedTopics) && mData.matchedTopics.length > 0) {
                c.matchedTopics = mData.matchedTopics;
              }
            }
          });
        }
      } catch (aiErr) {
        console.warn('Mistral AI evaluation skipped for sub:', sub.id, aiErr.message);
      }
    }

    // Sort candidates: highest match score first, with lower current load as tie-breaker
    candidateScores.sort((a, b) => {
      if (b.matchScore !== a.matchScore) {
        return b.matchScore - a.matchScore;
      }
      return a.currentLoad - b.currentLoad;
    });

    const selectedCandidates = candidateScores.slice(0, neededReviews);

    if (selectedCandidates.length < neededReviews) {
      warnings.push(`Paper #${sub.submission_number} ("${sub.title.slice(0, 40)}...") could only be matched with ${selectedCandidates.length}/${neededReviews} qualified reviewer(s) without conflict/capacity limits.`);
    }

    // Record planned assignments
    const paperPlan = {
      submissionId: sub.id,
      submissionNumber: sub.submission_number,
      title: sub.title,
      trackName: sub.track_name,
      keywords: sub.keywords,
      existingReviewersCount: existingCount,
      targetReviewersCount: targetReviewsPerPaper,
      proposedReviewers: selectedCandidates.map((c) => {
        // Increment dynamic load
        simulatedLoads[c.reviewer.id] += 1;
        totalNewAssignments += 1;
        existingAssignments.add(`${sub.id}-${c.reviewer.id}`);

        return {
          reviewerId: c.reviewer.id,
          reviewerName: `${c.reviewer.first_name} ${c.reviewer.last_name}`,
          email: c.reviewer.email,
          institution: c.reviewer.institution,
          domain: c.reviewer.domain,
          qualification: c.reviewer.qualification,
          designation: c.reviewer.designation,
          matchScore: c.matchScore,
          confidence: c.confidence,
          aiRationale: c.aiRationale,
          matchedTopics: c.matchedTopics,
          updatedSimulatedLoad: simulatedLoads[c.reviewer.id],
        };
      }),
    };

    assignmentPlan.push(paperPlan);
  }

  return {
    success: true,
    conferenceId,
    totalSubmissionsEvaluated: submissions.length,
    totalNewAssignments,
    targetReviewsPerPaper,
    maxReviewsPerReviewer,
    plan: assignmentPlan,
    reviewerPoolSize: reviewers.length,
    warnings,
  };
}

module.exports = {
  calculateReviewerMatchScore,
  checkConflict,
  generateAiAutoAssignmentPlan,
};
